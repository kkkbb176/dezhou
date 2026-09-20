/**
 * RIVER RAISE DECISION —— 三、四、五部分（只读）
 *
 * 三：Villain 面对 Hero 加注的响应模型是否存在？
 * 四：A–D 四种前提能否被区分？
 * 五：三个条件权益的口径
 *
 * ⚠️ 「审计重建」部分的 RAISE EV **不是产品输出**：产品在该节点没有
 * Raise-Continue Range 模型。重建一律使用**产品自己的** `classifyResponse`
 * 与权益引擎，只把「价格」换成面对加注的真实赔率，并在输出里明确标注。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { classifyResponse, responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { archetypeDimensionsOf } from '../src/domain/player/archetypeDimensions.ts';
import { boardWetnessOf } from '../src/domain/postflop/rangeCompression.ts';
import { boardRelativeTierOf } from '../src/domain/poker/boardRelativeStrength.ts';
import { compareHands, evaluateCards } from '../src/domain/poker/handEval.ts';
import { computeEquity, EquityComputeMode } from '../src/domain/poker/equity.ts';
import { computePot } from '../src/domain/poker/gameState.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { quickProfileToLimperArchetype } from '../src/app/manualInput/limpIsolation.ts';
import { buildRangeSnapshot, buildPlayerSnapshot, boardAtStreetOf } from './__shadow-contextBuilder.ts';
import { ALL_CARDS, type Card } from '../src/domain/types.ts';
import { akInput } from './rrda-lib.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_014;
const line = (s = ''): void => console.log(s);
const num = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const pad = (s: string, n: number): string => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};

const input = akInput(20, 'CALLING_STATION');
const parsed = parseManualInput(input);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues[0]));
const gate = buildAnalyzableState(parsed.value);
if (!gate.ok) throw new Error(JSON.stringify(gate.issues[0]));
const state = gate.state;
const board = ALL_CARDS.filter((c) => ['Kd', '9c', '4h', '6s', '2d'].includes(`${'23456789TJQKA'[c.rank - 2]}${c.suit}`));
const hero = state.players.find((p) => p.id === state.userPlayerId)!;
const heroHole = hero.holeCards!;
const heroEval = evaluateCards([...heroHole, ...board]);
const villain = state.players.find((p) => p.id === 'seat_BB')!;
const pot = computePot(state);
const callCost = state.currentBet;
const myRemaining = hero.remainingStack;
const raiseTo = myRemaining;            // 引擎选中的 174 = 全下
const raiseIncrement = raiseTo - hero.committedByStreet[state.street];
const priceVsRaise = raiseIncrement / (pot + 2 * raiseIncrement);   // 他面对加注需要的权益
const winnableCall = pot + callCost;
const finalPotIfCalled = pot + 2 * raiseIncrement;

/* 取该节点的下注范围（与引擎同一条链） */
const pb = buildPlayerSnapshot('seat_BB' as never, undefined as never, 'CALLING_STATION' as never, 'UNKNOWN' as never, (s: never) => boardAtStreetOf(state, s));
let betIndex = -1;
for (let i = state.actions.length - 1; i >= 0; i -= 1) {
  const a = state.actions[i]!;
  if (a.street === state.street && (a.type === 'BET' || a.type === 'RAISE' || a.type === 'RERAISE' || a.type === 'ALL_IN')) { betIndex = i; break; }
}
const build = buildRangeSnapshot(state, villain as never, [...heroHole, ...board] as never, undefined,
  pb.tendency as never, { archetype: quickProfileToLimperArchetype('CALLING_STATION'), confidence: pb.confidence } as never,
  (behaviorProfileOf({ playerId: 'seat_BB', archetype: 'CALLING_STATION' as never }) ?? null) as never, betIndex);
const arrival = (build.rangeBeforeAction ?? build.range)!;

/* 下注范围：到达范围 × 公共强度带权重（产品算法） */
const { buildBettingRangeFacts } = await import('../src/app/manualInput/bettingRange.ts');
const tendenciesBase = responseTendenciesOf(pb.tendency === null ? null : (pb.tendency.dimension.dimensions as never), pb.confidence, null);
const betFacts = buildBettingRangeFacts({
  arrivalEntries: arrival.entries.map((e: any) => ({ cardIndices: e.combo.cardIndices, probability: e.probability })),
  board, heroHole, potChips: pot - callCost, betChips: callCost, street: 'RIVER', tendencies: tendenciesBase,
})!;
const betRange = betFacts.entries;

line('='.repeat(112));
line(' 三、Villain 面对 Hero 加注的响应：模型存在性核查');
line('='.repeat(112));
line(`  加注语义：Hero RAISE 到 ${raiseTo}（= 全下，增量 ${raiseIncrement}）`);
line(`  他面对加注的价格：${raiseIncrement} / (${pot} + 2×${raiseIncrement}) = ${num(priceVsRaise, 4)}（他需要 ${(priceVsRaise * 100).toFixed(1)}% 权益）`);
line(`  跟注价格（对照）：${callCost} / (${pot} + ${callCost}) = ${num(callCost / winnableCall, 4)}`);
line('');
{
  const built = buildDecisionContext({
    state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
    quickProfile: 'CALLING_STATION' as never, equitySeed: SEED,
  });
  const facts = (built.context as unknown as Record<string, any>)['postflopFacts'] as Record<string, any>;
  const bd = facts['betDecision'] as Record<string, any> | null;
  line('  【引擎里**存在**的响应模型】`postflopFacts.betDecision`（形状：**Hero 下注 → 他的响应**）');
  if (bd === null) {
    line('    ⇒ 本节点为 null');
  } else {
    line(`    pot=${num(bd['pot'], 2)}｜checkEV=${num(bd['checkEV'], 2)}｜sizes=${(bd['sizes'] as any[]).length}`);
    for (const s of (bd['sizes'] as any[]).slice(0, 4)) {
      const buckets = s['buckets'] as any[];
      line(`    · 尺寸 ${num(s['betAmount'], 2)}（${num(s['ratioToPot'], 3)} 池）：` +
        buckets.map((b) => `${b['bucket']} ${(b['mass'] * 100).toFixed(1)}%`).join(' / ') +
        `｜对跟注范围权益 ${num(s['heroEquityVsCallRange'])}｜对加注范围权益 ${num(s['heroEquityVsRaiseRange'])}`);
    }
    line('    ⚠️ 它的语义是「**Hero 下注一个尺寸 → 他弃/跟/加**」，与本节点的');
    line('       「**他已经下注 → Hero 加注 → 他弃/跟/再加**」是**不同的条件概率**：');
    line('       跟注价格不同（' + num(callCost / winnableCall, 4) + ' vs ' + num(priceVsRaise, 4) + '）、底池不同、且 Hero 已全下时他不能再加注。');
  }
  line('');
  line('  【引擎里**缺失**的模型】');
  line(`    · heroEquityVsRaiseCallRange          = NOT_IMPLEMENTED（无此字段）`);
  line(`    · Raise-Continue Range（他继续面对加注的范围） = NOT_IMPLEMENTED`);
  line(`    · RAISE EV                            = NOT_IMPLEMENTED（evidence: estimateType=HEURISTIC, ev=null）`);
  line(`    · checkTree.raiseResponse             = ${String((facts['betDecision'] as any)?.['checkTree']?.['raiseResponse'] ?? 'NOT_IMPLEMENTED')}（产品自述）`);
  line(`    · 顾问层在面对下注时直接跳过下注树：advice.betDecision = null（facingBet ⇒ 不建 Hero 下注树）`);
}
line('');

/* ============================================================
 * 审计重建：用**产品自己的** classResponse + 正确的加注价格
 * ============================================================ */
type Premise = { tag: string; noteZh: string; dims: { tightness: number; aggression: number; bluffTendency: number; passivity: number } };
const premises: Premise[] = [
  {
    tag: 'A 只用更强的价值牌跟注',
    noteZh: '极紧倾向（callScale<1、foldScale>1）⇒ 继续的那部分偏向压制 Hero 的牌',
    dims: archetypeDimensionsOf('VERY_TIGHT', 0.35) as never,
  },
  {
    tag: 'B 大量较弱顶对也跟注',
    noteZh: '跟注站倾向（callScale>1）⇒ 继续范围含大量 Hero 能击败的牌',
    dims: archetypeDimensionsOf('CALLING_STATION', 0.35) as never,
  },
  {
    tag: 'C 经常弃牌但被跟时权益很低',
    noteZh: '高弃牌倾向 + 只在极强时继续 ⇒ 弃牌收益高、被跟时权益低',
    dims: { tightness: 0.8, aggression: 0.3, bluffTendency: 0.2, passivity: 0.3 },
  },
  {
    tag: 'D 中性（用于对照）',
    noteZh: '中性倾向',
    dims: { tightness: 0.5, aggression: 0.5, bluffTendency: 0.5, passivity: 0.5 },
  },
];

function reconstruct(dims: Premise['dims']) {
  const tendencies = responseTendenciesOf(dims as never, 1, null);
  let foldMass = 0, callMass = 0, raiseMass = 0, total = 0;
  const callEntries: { cardIndices: readonly [number, number]; probability: number }[] = [];
  for (const e of betRange) {
    const hole = [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const;
    const cmp = compareHands(evaluateCards([...hole, ...board]), heroEval);
    const versusHero = cmp > 0 ? 'STRONGER' : cmp < 0 ? 'WEAKER' : 'EQUAL';
    const tier = boardRelativeTierOf([hole[0], hole[1]], board) ?? 5;
    const r = classifyResponse({
      hole: [hole[0], hole[1]],
      versusHero,
      tier,
      street: 'RIVER' as never,
      cardsToCome: 0,
      ratioToPot: raiseIncrement / pot,
      priceRequiredEquity: priceVsRaise,
      spr: null,
      opponentCount: 1,
      wetness: boardWetnessOf(board),
      tendencies,
      /* Hero 加注到全下 ⇒ 他不能再加注（产品语义：加注权重迁移到跟注） */
      heroIsAllIn: true,
      villainDraw: 'NO_DRAW',
    });
    const w = e.probability;
    total += w;
    foldMass += w * r.weights.fold;
    callMass += w * r.weights.call;
    raiseMass += w * r.weights.raise;
    if (r.weights.call > 0) callEntries.push({ cardIndices: e.cardIndices, probability: w * r.weights.call });
  }
  const pFold = foldMass / total, pCall = callMass / total, pRaise = raiseMass / total;
  const callMassTotal = callEntries.reduce((a, x) => a + x.probability, 0);
  let eqVsCall: number | null = null;
  if (callMassTotal > 0) {
    const normalized = callEntries.map((x) => ({ ...x, probability: x.probability / callMassTotal }));
    const out = computeEquity(heroHole, board,
      [{ label: 'raise-call', combos: normalized.map((x) => [ALL_CARDS[x.cardIndices[0]]!, ALL_CARDS[x.cardIndices[1]]!] as const) }],
      { mode: EquityComputeMode.FAST, seed: SEED + 977, iterations: 20000, opponentWeights: [normalized.map((x) => x.probability)] });
    eqVsCall = out.ok ? out.result.equity : null;
  }
  /* 他从不跟注 ⇒ 纯弃牌收益（无摊牌） */
  const raiseEV = pCall === 0 || eqVsCall === null
    ? pFold * pot
    : pFold * pot + pCall * (eqVsCall * finalPotIfCalled - raiseIncrement) + pRaise * 0;
  return { pFold, pCall, pRaise, eqVsCall, raiseEV, tendencies };
}

line('='.repeat(112));
line(' 四、A–D 前提下的 **审计重建** RAISE EV（明确标注：**不是产品输出**）');
line('='.repeat(112));
line('  固定：Villain Bet Range（引擎 V2 口径，逐组合权重不变）、Hero 手牌、牌面、底池、加注额。');
line('  只改「他面对加注的响应倾向」——这正是产品**没有建模**的那一维。');
line('');
line(pad('前提', 30) + pad('P(弃)', 10) + pad('P(跟)', 10) + pad('P(再加)', 10) + pad('EqVsRaiseCall', 16) + pad('重建 RAISE EV', 16) + pad('对比 CALL EV', 14) + '重建结论');
const callEVBase = (await import('../src/app/alphaPipeline.ts')).analyzeManualHand(input, {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: SEED, budget: { softMs: 120_000, hardMs: 240_000 },
});
const callEV = callEVBase.ok ? (callEVBase.decision.diagnostics.math.callEV ?? Number.NaN) : Number.NaN;
for (const p of premises) {
  const r = reconstruct(p.dims);
  line(pad(p.tag, 30) + pad(num(r.pFold, 3), 10) + pad(num(r.pCall, 3), 10) + pad(num(r.pRaise, 3), 10) +
    pad(num(r.eqVsCall, 4), 16) + pad(num(r.raiseEV, 2), 16) + pad(num(callEV, 2), 14) +
    (r.raiseEV > callEV ? '加注更优' : '跟注更优'));
}
line('');
line('  ⇒ 重建的 RAISE EV 在 A–D 之间**变号**（C 为纯弃牌收益、A/B/D 为负），而 CALL EV 只有一个值（产品未建模响应）。');
line('');

/* ---------- shouldRaise 的复刻：是哪一个条件放行了加注 ---------- */
line('='.repeat(112));
line(' 四·二、`shouldRaise` 复刻（该函数未导出；逻辑逐行照抄，`decisionEngine.ts:788-820`）');
line('='.repeat(112));
{
  const RAISE_EDGE_STRONG = 0.15, RAISE_EDGE_ANY = 0.3, MAX_RATIO = 2.5, MIN_CAT = 3;
  const required = callCost / winnableCall;
  const evaluate = (equity: number, label: string) => {
    const edge = equity - required;
    const tier = 'MEDIUM';          // handCategory = 2（一对）⇒ handStrengthTier = MEDIUM
    const handCategory = 2;
    const commitmentException = true;  // stackOffAllowed && roleStrength(0.62) ≥ 0.55
    const c1 = edge >= RAISE_EDGE_ANY && tier === 'MONSTER';
    const c2 = edge >= RAISE_EDGE_STRONG && (tier === 'MONSTER' || tier === 'STRONG');
    const c3 = commitmentException && edge >= RAISE_EDGE_STRONG * 0.6;
    const qualifies = c1 || c2 || c3;
    const largeGuard = raiseTo / pot > MAX_RATIO ? handCategory >= MIN_CAT : true;
    line(`  ${pad(label, 34)}edge=${num(edge, 4)}｜①MONSTER+≥0.30=${c1}｜②强档+≥0.15=${c2}｜③承诺例外+≥0.09=${c3}` +
      `｜qualifies=${qualifies}｜量级保护(174/93=${num(raiseTo / pot, 3)}>2.5)=${!largeGuard ? '拦截' : '未触发'}`);
    return { qualifies, largeGuard };
  };
  const post = evaluate(0.659153, '用 math.heroEquity（产品实际）');
  const bet = evaluate(0.448857, '若改用 heroEquityVsBetRange');
  line('');
  line(`  ⇒ 两条强度条款（① ②）**都不成立**（tier = MEDIUM，一对牌永远进不了 MONSTER/STRONG）；`);
  line(`    放行加注的**唯一**通道是 ③ 低 SPR 承诺例外：${post.qualifies && bet.qualifies ? '两种权益下都成立' : '仅在部分权益下成立'}`);
  line(`    ⇒ 即使把门槛换成下注范围权益，动作**仍然是 RAISE**（这条通道与权益数值无关：0.148 ≥ 0.09）。`);
  line(`    ⇒ 量级保护同样不触发（1.871 ≤ 2.5）—— 而它自己的注释写着「一对不行」。`);
}
line('');

line('='.repeat(112));
line(' 四·补：**引擎自己的最终动作**是否随同样的前提变化？');
line('='.repeat(112));
line(pad('画像（引擎输入）', 22) + pad('EqVsBetRange', 16) + pad('CALL EV', 12) + pad('EqVsArrival', 14) + pad('最终动作', 12) + pad('sizeChips', 12) + '决策来源');
for (const profile of ['VERY_TIGHT', 'NORMAL', 'CALLING_STATION', 'MANIAC']) {
  const r = analyzeManualHand(akInput(20, profile), {
    rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: SEED, budget: { softMs: 120_000, hardMs: 240_000 },
  });
  if (!r.ok) { line(`${profile}: FAIL ${r.stage}`); continue; }
  const d = r.decision as unknown as Record<string, any>;
  const diag = d['diagnostics'] as Record<string, any>;
  line(pad(profile, 22) + pad(num(diag['math']['heroEquityVsBetRange'], 6), 16) + pad(num(diag['math']['callEV'], 2), 12) +
    pad(num(diag['postflop']?.['betRangeArrival']?.['heroEquityVsArrivalRange'], 6), 14) +
    pad(String(d['action']), 12) + pad(num(d['sizeChips'], 2), 12) + String(diag['decisionSource']?.['kind']));
}
line('');
line('  ⇒ 画像换了四次（从极紧到疯子），**动作与尺寸完全不变**；');
line('    因为面对下注时的加注路径不读任何响应信息（没有 Raise-Continue Range / 弃牌率）。');
line('');

line('='.repeat(112));
line(' 五、三个条件权益的口径');
line('='.repeat(112));
{
  const built = buildDecisionContext({
    state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
    quickProfile: 'CALLING_STATION' as never, equitySeed: SEED,
  });
  const m = (built.context as unknown as Record<string, any>)['math'] as Record<string, any>;
  const facts = (built.context as unknown as Record<string, any>)['postflopFacts'] as Record<string, any>;
  const rows = [
    {
      field: 'math.heroEquity',
      value: m['heroEquity'],
      event: 'P(手牌 | 本手全部已发生动作，含他在河牌下注 40)',
      source: '范围更新链的贝叶斯后验（buildRangeSnapshot 全链）',
      used: '相对牌力角色 / 加注门槛 (equity − requiredEquity = +35.8pp) / 强度档 tier',
    },
    {
      field: 'postflop.betRangeArrival.heroEquityVsArrivalRange',
      value: facts['betRangeArrival']?.['heroEquityVsArrivalRange'],
      event: 'P(手牌 | 本手全部已发生动作，**不含**他在河牌下注 40)',
      source: '同一条链在「当前下注」之前的捕获快照',
      used: '仅报告 / 与下注范围对比（证明「更偏价值」）',
    },
    {
      field: 'math.heroEquityVsBetRange',
      value: m['heroEquityVsBetRange'],
      event: 'P(手牌 | 他选择下注 40)（专用下注模型）',
      source: '到达范围 × P(BET | 公共强度带, 尺寸, 牌面, 画像)',
      used: 'CALL EV（= 0.448857 × 133 − 40 = +19.70）',
    },
    {
      field: 'heroEquityVsRaiseCallRange',
      value: null,
      event: 'P(手牌 | 他下注 40 **且**他跟注 Hero 的全下)',
      source: '**NOT_IMPLEMENTED**',
      used: 'RAISE EV 必需 —— 缺失，因此加注只能走启发式',
    },
  ];
  line(pad('字段', 46) + pad('值', 12) + '对应条件事件');
  for (const r of rows) line(pad(r.field, 46) + pad(r.value === null ? 'NOT_IMPL' : num(r.value, 6), 12) + r.event);
  line('');
  line('  范围来源与用途：');
  for (const r of rows) line(`    · ${pad(r.field, 46)} 来源=${r.source}｜用途=${r.used}`);
  line('');
  line(`  ⚠️ 两个字段都声称表达「他下注后我领先多少」，但**范围输入与计算方法不同**：`);
  line(`     heroEquity = 链条后验（含本街全部动作的似然） = ${num(m['heroEquity'], 6)}`);
  line(`     heroEquityVsBetRange = 到达范围 × 专用下注权重 = ${num(m['heroEquityVsBetRange'], 6)}`);
  line(`     差 ${((m['heroEquity'] as number) - (m['heroEquityVsBetRange'] as number)).toFixed(6)}（${(((m['heroEquity'] as number) - (m['heroEquityVsBetRange'] as number)) * 100).toFixed(2)} 个百分点）`);
  line(`     ⇒ **加注门槛读前者、CALL EV 读后者**：同一节点上两个动作被两把尺子量。`);
}
