/**
 * 测试牌局 09 —— 河牌面对 120% 池 overbet。
 *
 * 用 villain 面对下注时的响应分桶（FOLD / CALL / RAISE）还原「他会继续的牌」，
 * 再按**绝对牌型**分类，回答「bet range 里 Kx / AA-QQ / 两对+ / Jx / 听牌错失 / 空气」。
 *
 * 说明：引擎自身的分类口径是**相对 Hero**的（profileClassMasses），
 * 与「绝对牌型」是两把不同的尺子。本脚本两把都输出，并标明来源。
 */
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { ALL_CARDS } from '../src/domain/poker/cards.ts';
import { evaluateCards, compareHands } from '../src/domain/poker/handEval.ts';
import { parseCardStrict } from '../src/domain/poker/cards.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTS = {
  rules: RULES,
  asOf: 1757000000000,
  writeLog: false,
  equitySeed: 20260913,
  budget: { softMs: 120000, hardMs: 240000 },
};

type Row = { position: string; type: string; amountBB?: number; street?: string };
const A = (position: string, type: string, amountBB?: number, street?: string): Row => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

// 盲注 1/2：加注到 6 = 3BB；翻牌 8 = 4BB；转牌 21 = 10.5BB；河牌 85 = 42.5BB
const HIST: Row[] = [
  A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
  A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
  A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 4, 'FLOP'), A('BB', 'CALL', 4, 'FLOP'),
  A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 10.5, 'TURN'), A('BB', 'CALL', 10.5, 'TURN'),
  A('BB', 'CHECK', undefined, 'RIVER'), A('BTN', 'BET', 42.5, 'RIVER'),
];

const V3 = {
  handsObserved: 620, vpip: 0.58, pfr: 0.39, threeBet: 0.16, wtsd: 0.34,
  foldToFlopCBet: 0.25, foldToTurnCBet: 0.28, foldToRiverBet: 0.24,
  flopCheckRaise: 0.12, turnCheckRaise: 0.10, riverCheckRaise: 0.07,
};

const SCENARIOS: readonly (readonly [string, string, typeof V3 | null])[] = [
  ['A', 'MANIAC', V3],
  ['B', 'MANIAC', null],
  ['C', 'NORMAL', null],
  ['D', 'VERY_TIGHT', null],
];

const BOARD_IDS = ['Jd', '8c', '4c', '6s', 'Kh'];

function makeInput(qp: string, stats: typeof V3 | null) {
  return {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: ['As', 'Js'],
    board: BOARD_IDS,
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: HIST,
    environment: 'MID_LOW_STAKES',
    villain: {
      quickProfile: qp, dynamicHint: 'UNKNOWN', stackBB: 100,
      ...(stats ? { observedStats: stats } : {}),
    },
  } as never;
}

/* ---- 绝对牌型分类（本脚本自建，非引擎口径） ---- */
const BOARD = BOARD_IDS.map((id) => parseCardStrict(id));
const boardRanks = BOARD.map((c) => c.rank);
const boardHas = (r: number) => boardRanks.includes(r);
const boardSuitCount = (s: string) => BOARD.filter((c) => c.suit === s).length;

function absoluteCategory(a: number, b: number): string {
  const h1 = ALL_CARDS[a]!, h2 = ALL_CARDS[b]!;
  const hole = [h1, h2];
  const ranks = [h1.rank, h2.rank].sort((x, y) => y - x);
  const paired = ranks[0] === ranks[1];
  const suited = h1.suit === h2.suit;

  // 成手类别（含公共牌）
  let category: number;
  try {
    category = evaluateCards([...hole, ...BOARD]).category;
  } catch {
    return '未知';
  }
  /*
   * ⚠️ `HandCategory` 是 **1=高牌 … 9=同花顺**（`src/domain/types.ts`）。
   * 第一版按 0 起算、且把「一对」误当成 1，于是 `category >= 2` 把所有
   * 一对及以上的成手都判成了「两对+」（实测 FOLD 桶 79% 是「两对+」，
   * 一眼就不合理）。
   */
  if (category >= 3) return '两对+';
  if (category === 2) {
    if (paired && boardHas(ranks[0])) return '三条+';
    if (paired) {
      if (ranks[0] > 11) return 'AA/QQ 超对';
      if (ranks[0] === 11) return 'Jx 中对';
      return '中对/底对(8/6/4)';
    }
    if (ranks.includes(13)) {
      return ranks[1] >= 12 ? 'Kx 顶对(好踢 A/Q)' : 'Kx 顶对(弱踢)';
    }
    if (ranks.includes(11)) return 'Jx 中对';
    return '中对/底对(8/6/4)';
  }
  // 高牌：看错失听牌
  if (suited && boardSuitCount(h1.suit) >= 3) return 'Missed clubs';
  if (ranks.some((r) => [5, 7, 9, 10].includes(r))) return 'Missed straight draws';
  return '纯空气';
}

function run(tag: string, qp: string, stats: typeof V3 | null) {
  const input = makeInput(qp, stats);
  const parsed = parseManualInput(input);
  if (!parsed.ok) throw new Error(tag + ' PARSE: ' + JSON.stringify(parsed.issues[0]));
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error(tag + ' GATE: ' + JSON.stringify(gate.issues[0]));
  const cb = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
    asOf: OPTS.asOf, quickProfile: qp, ...(stats ? { observedStats: stats } : {}),
  });
  const res = analyzeManualHand(input, OPTS);
  if (!res.ok) throw new Error(tag + ' ANALYZE 失败');
  return { cb, res, ctx: cb.context };
}

const OUT: Record<string, ReturnType<typeof run>> = {};
for (const [tag, qp, stats] of SCENARIOS) OUT[tag] = run(tag, qp, stats);

console.log('==================== 指标表 ====================');
const header = ['指标', 'MANIAC V3', 'MANIAC V2', 'NORMAL', 'NIT'];
console.log(header.map((h, i) => (i === 0 ? h.padEnd(26) : h.padStart(14))).join(''));

const cell = (vals: string[]) => vals.map((v, i) => (i === 0 ? v.padEnd(26) : v.padStart(14))).join('');
const tags = ['A', 'B', 'C', 'D'] as const;

const row = (label: string, f: (t: typeof tags[number]) => string) =>
  console.log(cell([label, ...tags.map((t) => f(t))]));

row('Final Action', (t) => OUT[t]!.res.decision.action);
row('Required Equity', (t) => ((OUT[t]!.ctx.math.requiredEquity ?? 0) * 100).toFixed(2) + '%');
{
  const pv = (t: typeof tags[number]) => OUT[t]!.ctx.profileV3;
  row('Hero Equity vs Bet Range', (t) => {
    /*
     * ⚠️ 口径：面对下注时引擎**不**单独输出「对下注范围的权益」——
     * 它给的是对**到达范围**的权益（`math.heroEquity`），再在 CALL EV 里
     * 用同样的口径。真正「对下注范围」的信息由 profileClassMasses 的
     * valueMass / bluffMass 结构表达（下方单独列出）。
     */
    return ((OUT[t]!.ctx.math.heroEquity ?? 0) * 100).toFixed(3) + '%';
  });
  row('CALL EV', (t) => (OUT[t]!.ctx.math.callEV === null ? 'null' : OUT[t]!.ctx.math.callEV!.toFixed(3)));
  row('FOLD EV', () => '0.000');
  row('Villain Value Weight', (t) => {
    const pcm = OUT[t]!.ctx.postflopFacts?.opponentRangeFacts?.profileClassMasses;
    return pcm ? pcm.valueMass.toFixed(4) : '—';
  });
  row('Villain Bluff Weight', (t) => {
    const pcm = OUT[t]!.ctx.postflopFacts?.opponentRangeFacts?.profileClassMasses;
    return pcm ? pcm.bluffMass.toFixed(4) : '—';
  });
  row('Bet Range Support', (t) => {
    const rf = OUT[t]!.ctx.postflopFacts?.opponentRangeFacts;
    return rf ? String(rf.supportSize) : '—';
  });
  row('Confidence', (t) => {
    const p = pv(t);
    return p ? `${p.confidenceTierZh}(${p.observedStatCount}/10)` : '—';
  });
}

console.log('');
console.log('==================== 引擎口径：范围构成（相对 Hero） ====================');
console.log(cell(['类别', ...tags]));
const pcmOf = (t: typeof tags[number]) =>
  OUT[t]!.ctx.postflopFacts?.opponentRangeFacts?.profileClassMasses ?? null;
for (const [label, key] of [
  ['nutValue', 'nutValueMass'], ['strongValue(打败AJ)', 'strongValueMass'],
  ['thinValue', 'thinValueMass'], ['showdown', 'showdownMass'],
  ['missedFlush', 'missedFlushMass'], ['missedStraight', 'missedStraightMass'],
  ['missedCombo', 'missedComboMass'], ['pureAir', 'pureAirMass'],
  ['valueMass(合计)', 'valueMass'], ['bluffMass(合计)', 'bluffMass'],
] as const) {
  row(label, (t) => {
    const p = pcmOf(t);
    return p ? (p[key as keyof typeof p] as number).toFixed(4) : '—';
  });
}
row('tierHistogram', (t) => {
  const rf = OUT[t]!.ctx.postflopFacts?.opponentRangeFacts;
  return rf ? rf.tierHistogram.map((x) => x.toFixed(3)).join('/') : '—';
});
row('meanTier', (t) => {
  const rf = OUT[t]!.ctx.postflopFacts?.opponentRangeFacts;
  return rf ? rf.meanTier.toFixed(3) : '—';
});

console.log('');
console.log('==================== 绝对牌型分类（本脚本自建，非引擎口径） ====================');
console.log('（对「他会 CALL / RAISE 这个下注」的 continue 范围逐组合分类，按桶质量加权）');
console.log('⚠️ 口径：引擎的尺寸网格是 33%/67%/100% 池，被 Hero 剩余筹码封顶后');
console.log('   最大只有 ' + (OUT.A!.ctx.postflopFacts?.betDecision?.sizes.slice(-1)[0]?.betAmount.toFixed(0) ?? '?') +
  ' 筹码（真实下注是 85）⇒ 本表是**最接近那一档**的代理，不是 85 本身。');
console.log(cell(['类别', ...tags]));

function absoluteBreakdown(t: typeof tags[number], which: 'CONTINUE' | 'FOLD') {
  const bd = OUT[t]!.ctx.postflopFacts?.betDecision;
  // 用与河牌 85 最接近的尺寸作为代理（引擎网格 33%/67%/100% 池）
  if (!bd || bd.sizes.length === 0) return null;
  const target = 85;
  const size = bd.sizes.reduce((best, s) =>
    Math.abs(s.betAmount - target) < Math.abs(best.betAmount - target) ? s : best);
  const buckets = size.buckets.filter((b) =>
    which === 'CONTINUE' ? b.bucket === 'CALL' || b.bucket === 'RAISE' : b.bucket === 'FOLD');
  const acc: Record<string, number> = {};
  let total = 0;
  for (const b of buckets) {
    for (const e of b.entries) {
      const w = b.mass * e.probability;
      const cat = absoluteCategory(e.cardIndices[0]!, e.cardIndices[1]!);
      acc[cat] = (acc[cat] ?? 0) + w;
      total += w;
    }
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(acc)) out[k] = total > 0 ? v / total : 0;
  return { dist: out, size: size.betAmount, total };
}

for (const cat of ['两对+', '三条+', 'Kx 顶对(好踢 A/Q)', 'Kx 顶对(弱踢)', 'AA/QQ 超对',
  'Jx 中对', '中对/底对(8/6/4)', 'Missed clubs', 'Missed straight draws', '纯空气']) {
  row(cat, (t) => {
    const d = absoluteBreakdown(t, 'CONTINUE');
    return d ? ((d.dist[cat] ?? 0) * 100).toFixed(2) + '%' : '—';
  });
}

console.log('');
console.log('（参考：FOLD 桶的绝对牌型分布 —— 他弃掉的都是什么）');
for (const cat of ['两对+', 'Kx 顶对(好踢 A/Q)', 'Kx 顶对(弱踢)', 'Jx 中对',
  '中对/底底(8/6/4)', '中对/底对(8/6/4)', 'Missed clubs', 'Missed straight draws', '纯空气']) {
  row(cat, (t) => {
    const d = absoluteBreakdown(t, 'FOLD');
    return d ? ((d.dist[cat] ?? 0) * 100).toFixed(2) + '%' : '—';
  });
}

console.log('');
console.log('==================== CHECK 分支（补充：Hero 若过牌） ====================');
console.log(cell(['指标', ...tags]));
row('Villain betLikelihood', (t) => {
  const ct = OUT[t]!.ctx.postflopFacts?.betDecision?.checkTree;
  return ct ? ct.betLikelihood.toFixed(4) : '—';
});
row('Villain checkBackLikelihood', (t) => {
  const ct = OUT[t]!.ctx.postflopFacts?.betDecision?.checkTree;
  return ct ? ct.checkBackLikelihood.toFixed(4) : '—';
});
row('checkTree.kind', (t) => String(OUT[t]!.ctx.postflopFacts?.betDecision?.checkTree.kind ?? '—'));

console.log('');
console.log('==================== 街因子与响应倾向 ====================');
console.log(cell(['指标', ...tags]));
row('河牌 foldScale', (t) => OUT[t]!.ctx.profileV3!.street.RIVER.foldScale.toFixed(4));
row('河牌 callScale', (t) => OUT[t]!.ctx.profileV3!.street.RIVER.callScale.toFixed(4));
row('河牌 betScale', (t) => String(OUT[t]!.ctx.profileV3!.street.RIVER.betScale ?? '—'));
row('actionContext', (t) => String(OUT[t]!.ctx.profileV3!.actionContext));
row('deniedStreetTraits', (t) => '[' + OUT[t]!.ctx.profileV3!.deniedStreetTraits.join(',') + ']');
row('响应 foldScale', (t) => {
  const x = OUT[t]!.ctx.postflopFacts?.betDecision?.tendencies;
  return x ? x.foldScale.toFixed(4) : '—';
});
row('响应 riverBetScale', (t) => {
  const x = OUT[t]!.ctx.postflopFacts?.betDecision?.tendencies;
  return x ? x.riverBetScale.toFixed(4) : '—';
});
