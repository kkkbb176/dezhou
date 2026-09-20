/* eslint-disable */
/*
 * ⚠️⚠️ **历史脚本警告（RIVER BET RANGE V2 起）** ⚠️⚠️
 *
 * 本脚本写于 **RIVER BET RANGE V1** 时期，用于审计当时的缺陷。
 * 产品已升级到 V2（公共强度带模型 + 单一计费路径），因此：
 *   · 它调用的权重来自**冻结的 V1 快照**（./_legacyBetProbabilityByClass.ts）；
 *   · 它对 `buildBettingRangeFacts` 的调用走的是**当前的 V2 实现**；
 *   · 输出是**两个模型的混合**，**不代表当前产品行为**。
 *
 * 当前行为请以 `scripts/rbrv2-acceptance.ts` / `scripts/rbrv2-sensitivity.ts`
 * 与 `test/riverBetRangeV2*.test.ts` 为准。
 */
console.log('⚠️ 历史脚本（RIVER BET RANGE V1 时期）：输出混用了冻结的 V1 权重快照与当前 V2 实现，不代表当前产品行为。');
console.log('   当前行为请跑 scripts/rbrv2-acceptance.ts。\n');
/**
 * ============================================================================
 * CORE DECISION AUDIT —— 河牌下注范围确认实验（只读）
 * ============================================================================
 *
 * 复现：Hero BTN A♠K♠ ／ Board K♦9♣4♥6♠2♦ ／ BB 河牌领打 40（底池 93）
 * 异常：EqVsBetRange = 0.54%，CALL EV ≈ −39.28
 *
 * 本脚本**不修改任何产品代码**：
 * - 通过 `__shadow-contextBuilder.ts`（由 `__make-shadow.ts` 从产品源码机械生成、
 *   只重写相对导入路径并追加一条 export）调用**真实**的范围构建链路；
 * - 所有权益都由产品自带的权益引擎算出。
 *
 * 用法：node --experimental-strip-types scripts/audit-river-betrange.ts > out.txt
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { reconstructGameState } from '../src/app/manualInput/reconstruct.ts';
import { buildBettingRangeFacts } from '../src/app/manualInput/bettingRange.ts';
import { legacyBetProbabilityByClass as betProbabilityByClass } from './_legacyBetProbabilityByClass.ts';
import { quickProfileToLimperArchetype } from '../src/app/manualInput/limpIsolation.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { ALL_CARDS, type Card } from '../src/domain/types.ts';
import { computeEquity, EquityComputeMode } from '../src/domain/poker/equity.ts';
import { compareHands, evaluateCards } from '../src/domain/poker/handEval.ts';
import { describeHand } from '../src/domain/poker/handDescription.ts';
import { handDescriptionText } from '../src/i18n/index.ts';
import { boardRelativeTierOf } from '../src/domain/poker/boardRelativeStrength.ts';
import { riverComboClassOf } from '../src/domain/postflop/riverProfileClassify.ts';
import { computePot } from '../src/domain/poker/gameState.ts';
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { lastAggressorOfStreet, actionContextOf } from '../src/domain/postflop/actionContext.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { resolvePlayerProfile } from '../src/domain/player/observedStats.ts';
import {
  buildRangeSnapshot,
  buildPlayerSnapshot,
  nodeActionContextOf,
  boardAtStreetOf,
} from './__shadow-contextBuilder.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const ASOF = 1_757_000_000_000;
const EQUITY_SEED = 20_261_014;
const BOARD = ['Kd', '9c', '4h', '6s', '2d'] as const;
const HERO = ['As', 'Ks'] as const;

const H = (p: string, t: string, a?: number, s?: string) => ({
  position: p, type: t, ...(a === undefined ? {} : { amountBB: a }), ...(s === undefined ? {} : { street: s }),
});

const PREFLOP = [H('UTG', 'FOLD'), H('HJ', 'FOLD'), H('CO', 'FOLD'), H('BTN', 'RAISE', 3), H('SB', 'FOLD'), H('BB', 'CALL', 2)];
const FLOP_ACT = [H('BB', 'CHECK', undefined, 'FLOP'), H('BTN', 'BET', 2.5, 'FLOP'), H('BB', 'CALL', 2.5, 'FLOP')];
const TURN_ACT = [H('BB', 'CHECK', undefined, 'TURN'), H('BTN', 'BET', 7.5, 'TURN'), H('BB', 'CALL', 7.5, 'TURN')];
const RIVER_ACT = [H('BB', 'BET', 20, 'RIVER')];
const FULL = [...PREFLOP, ...FLOP_ACT, ...TURN_ACT, ...RIVER_ACT];

/* ---------------- 小工具 ---------------- */
const line = (s = ''): void => console.log(s);
const p4 = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : '—');
const pct = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const pad = (s: string, n: number): string => {
  // 中文按 2 宽度近似对齐
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};

type Entry = { cardIndices: readonly [number, number]; probability: number };
const RANK_CHARS: Record<number, string> = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const CHAR_RANKS: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const holeOf = (e: Entry): [Card, Card] => [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!];
const cardZh = (c: Card): string => `${RANK_CHARS[c.rank] ?? '?'}${c.suit}`;
const comboZh = (e: Entry): string => { const [a, b] = holeOf(e); return `${cardZh(a)}${cardZh(b)}`; };
const parseCard = (s: string): Card => {
  const rank = CHAR_RANKS[s.slice(0, -1)]!;
  const suit = s.slice(-1);
  const found = ALL_CARDS.find((c) => c.rank === rank && c.suit === suit);
  if (found === undefined) throw new Error(`bad card ${s}`);
  return found;
};

const HERO_CARDS: Card[] = HERO.map(parseCard);
const BOARD_CARDS: Card[] = BOARD.map(parseCard);
const DEAD = [...HERO_CARDS, ...BOARD_CARDS];
const heroEval = evaluateCards([...HERO_CARDS, ...BOARD_CARDS]);

/** 这手牌相对 Hero 的结果（河牌无后续发牌）：1 胜 / 0.5 平 / 0 负 */
function heroEquityVs(hole: readonly Card[]): number {
  try {
    const cmp = compareHands(evaluateCards([...hole, ...BOARD_CARDS]), heroEval);
    return cmp > 0 ? 0 : cmp < 0 ? 1 : 0.5;
  } catch { return Number.NaN; }
}

function shapeZh(hole: readonly Card[]): string {
  try {
    return handDescriptionText(describeHand([hole[0]!, hole[1]!], BOARD_CARDS));
  } catch { return 'ERR'; }
}
function tierOf(hole: readonly Card[]): number { return boardRelativeTierOf(hole, BOARD_CARDS) ?? -1; }
function classOf(hole: readonly Card[]): { category: string; strengthBucket: number } | null {
  return riverComboClassOf({ hole: [hole[0]!, hole[1]!], board: BOARD_CARDS, heroHole: HERO_CARDS });
}

/** 与引擎同一口径的权益（`computeHeroEquity`：≤2 家 → 20000 次，FAST，给定种子） */
function equityVsEntries(entries: readonly Entry[], iterations = 20000, seed = EQUITY_SEED) {
  const out = computeEquity(
    [HERO_CARDS[0]!, HERO_CARDS[1]!],
    BOARD_CARDS,
    [{ label: 'R', combos: entries.map((e) => holeOf(e)) }],
    { mode: EquityComputeMode.FAST, seed, iterations, opponentWeights: [entries.map((e) => e.probability)] },
  );
  if (!out.ok) return { value: null as number | null, method: 'NOT_AVAILABLE', iterations: 0 };
  return { value: out.result.equity, method: out.result.method, iterations: out.result.iterations };
}

/* ---------------- 建局 ---------------- */
function mkInput(actions: readonly Record<string, unknown>[], profile: string, stats: Record<string, number> | null) {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: [...HERO],
    board: [...BOARD], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: actions.map((x) => ({ ...x })), environment: 'MID_LOW_STAKES',
    villain: {
      quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100,
      ...(stats === null ? {} : { observedStats: stats }),
    },
  } as unknown as ManualHandInput;
}

/** PREVIEW 模式重建：**不要求轮到 Hero**，能推多远推多远（用于取逐层范围） */
function stateFor(actions: readonly Record<string, unknown>[], profile: string, stats: Record<string, number> | null) {
  const parsed = parseManualInput(mkInput(actions, profile, stats));
  if (!parsed.ok) throw new Error(`PARSE: ${JSON.stringify(parsed.issues[0])}`);
  const rc = reconstructGameState(parsed.value, { mode: 'PREVIEW' as never });
  if (!rc.ok) throw new Error(`RECONSTRUCT: ${JSON.stringify(rc.issues[0])}`);
  return rc.state;
}

/**
 * 取某一层的**真实范围**（产品代码算的，不是复刻的）。
 * deadCards 恒为「Hero 底牌 + 完整 5 张公共牌」—— 与引擎在全量状态下建范围时一致。
 */
function rangeAtLayer(actions: readonly Record<string, unknown>[], profile: string, stats: Record<string, number> | null) {
  const state = stateFor(actions, profile, stats);
  const opponent = state.players.find((p) => p.id === 'seat_BB')!;
  const hero = state.players.find((p) => p.id === state.userPlayerId)!;
  const built = buildPlayerSnapshot('seat_BB' as never, undefined as never, profile as never, 'UNKNOWN' as never, (street: never) => boardAtStreetOf(state, street));
  const build = buildRangeSnapshot(
    state, opponent as never, DEAD as never, undefined,
    built.tendency as never,
    { archetype: quickProfileToLimperArchetype(profile), confidence: built.confidence } as never,
    (behaviorProfileOf({ playerId: 'seat_BB', archetype: profile as never }) ?? null) as never,
  );
  return { state, hero, opponent, playerBuilt: built, build };
}

/** 逐类质量 + 强弱分布 */
function classifyEntries(entries: readonly Entry[]) {
  const byClass: Record<string, number> = {};
  let stronger = 0, weaker = 0, equal = 0, total = 0, unclassified = 0;
  let reachable = 0, positive = 0;
  for (const e of entries) {
    const p = e.probability;
    if (p > 0) positive += 1;
    if (!(p > 0)) continue;
    const hole = holeOf(e);
    if (hole.some((c) => DEAD.some((d) => d.rank === c.rank && d.suit === c.suit))) continue;
    reachable += 1; total += p;
    const cls = classOf(hole);
    if (cls === null) { unclassified += p; continue; }
    byClass[cls.category] = (byClass[cls.category] ?? 0) + p;
    const he = heroEquityVs(hole);
    if (he === 1) weaker += p; else if (he === 0) stronger += p; else if (he === 0.5) equal += p;
  }
  return { byClass, stronger, weaker, equal, total, unclassified, reachable, positive };
}

/* ============================================================================
 * 第一部分：逐层范围
 * ============================================================================ */
line('='.repeat(118));
line(' 第一部分  真实范围来源（逐层，全部由产品代码算出）');
line('='.repeat(118));
line('');
line(`Hero ${HERO.join('')}｜Board ${BOARD.join(' ')}｜Hero 成手：${shapeZh(HERO_CARDS)}｜tier=${tierOf(HERO_CARDS)}`);
line(`全牌 1326 组合 → 扣除与 Hero 底牌／公共牌重叠者后 990 组合（被阻断 ${1326 - 990} 个）`);
line('');

const LAYERS = [
  { name: '① 翻前范围（BB 跟注 BTN 开池后）', actions: PREFLOP },
  { name: '② 翻牌跟注后范围（BB call 2.5BB on K94）', actions: [...PREFLOP, ...FLOP_ACT] },
  { name: '③ 转牌跟注后范围（BB call 7.5BB on K946）', actions: [...PREFLOP, ...FLOP_ACT, ...TURN_ACT] },
  { name: '④ 河牌 BET 似然施加后（＝引擎的 math.heroEquity 口径）', actions: FULL },
];

const layerData: Array<{ name: string; entries: Entry[]; info: ReturnType<typeof classifyEntries>; eq: ReturnType<typeof equityVsEntries>; state: any; built: any }> = [];
line(pad('层', 52) + pad('组合数(正权)', 14) + pad('总权重', 12) + pad('相对Hero权益', 14) + '价值类质量 / 摊牌 / 诈唬');
for (const L of LAYERS) {
  const { state, playerBuilt, build } = rangeAtLayer(L.actions, 'CALLING_STATION', null);
  const range = build.range;
  if (range === null) { line(`${L.name}  ⇒ 范围构建失败`); continue; }
  const entries: Entry[] = range.entries.map((e: any) => ({ cardIndices: e.combo.cardIndices, probability: e.probability }));
  const info = classifyEntries(entries);
  const eq = equityVsEntries(entries);
  const c = info.byClass;
  const valueMass = (c['NUT_VALUE'] ?? 0) + (c['STRONG_VALUE'] ?? 0) + (c['THIN_VALUE'] ?? 0);
  const showdown = c['SHOWDOWN_VALUE'] ?? 0;
  const bluff = (c['MISSED_FLUSH_DRAW'] ?? 0) + (c['MISSED_STRAIGHT_DRAW'] ?? 0) + (c['MISSED_COMBO_DRAW'] ?? 0) + (c['PURE_AIR'] ?? 0);
  line(pad(L.name, 52) + pad(`${range.metrics.supportSize}/${info.positive}`, 14) + pad(p4(range.metrics.probabilitySum), 12) +
    pad(pct(eq.value), 14) + `${pct(valueMass)} / ${pct(showdown)} / ${pct(bluff)}`);
  layerData.push({ name: L.name, entries, info, eq, state, built: playerBuilt, build });
  line(pad('', 52) + `更新轨迹：${(build.snapshot.updateTrace as any[]).map((t) => `${t.street}/${t.action}`).join(' → ')}`);
}
line('');
line('⚠️ 关键：「④」这一层**不是**河牌下注前的到达范围 —— 更新轨迹的最后一条是 `RIVER/BET`，');
line('   即引擎在「他已经在河牌下注」之后，把这次下注的似然**又乘了一遍**才得到 math.heroEquity 的输入。');
line('');

line('逐层强弱分布（相对 Hero，逐组合精确比较）：');
line(pad('层', 52) + pad('Hero 领先(弱)', 16) + pad('平局', 12) + pad('Hero 落后(强)', 16));
for (const d of layerData) {
  const t = d.info.total || 1;
  line(pad(d.name, 52) + pad(`${pct(d.info.weaker / t)}`, 16) + pad(`${pct(d.info.equal / t)}`, 12) + pad(`${pct(d.info.stronger / t)}`, 16));
}
line('');

/* ============================================================================
 * 第二部分：下注范围逐组合
 * ============================================================================ */
line('='.repeat(118));
line(' 第二部分  下注范围逐组合检查');
line('='.repeat(118));
line('');

const ARRIVAL_LAYER = layerData[layerData.length - 1]!;       // 引擎口径（含 RIVER/BET 似然）
const BEFORE_BET_LAYER = layerData[layerData.length - 2]!;    // 真正「下注前」的到达范围
const ARRIVAL = ARRIVAL_LAYER.entries;

const { state: fullState, playerBuilt, build: fullBuild } = rangeAtLayer(FULL, 'CALLING_STATION', null);
const tendencies = responseTendenciesOf(
  playerBuilt.tendency === null ? null : (playerBuilt.tendency.dimension.dimensions as never),
  playerBuilt.confidence,
  null,
);
const potBeforeBet = computePot(fullState) - fullState.currentBet;
const classP = betProbabilityByClass(tendencies, fullState.currentBet / potBeforeBet);

line(`Villain 响应倾向（responseTendenciesOf 实测）：confidence=${p4(playerBuilt.confidence)}`);
line(`effectiveDimensions = ${JSON.stringify(tendencies.effectiveDimensions)}`);
line('');
line('P(BET | 手牌类别)（betProbabilityByClass(modeledRatio=' + p4(fullState.currentBet / potBeforeBet) + ')）：');
line('  ' + Object.entries(classP).map(([k, v]) => `${k}=${p4(v)}`).join('  '));
line('');

const betFacts = buildBettingRangeFacts({
  arrivalEntries: ARRIVAL,
  board: BOARD_CARDS,
  heroHole: HERO_CARDS,
  potChips: potBeforeBet,
  betChips: fullState.currentBet,
  street: 'RIVER',
  tendencies,
});
if (betFacts === null) { line('buildBettingRangeFacts 返回 null'); process.exit(1); }

line(`betChips=${fullState.currentBet}  potBeforeBet=${potBeforeBet}  actualRatio=${p4(betFacts.sizing.actualRatio)}  modeledRatio=${p4(betFacts.sizing.modeledRatio)}  sizeApproximation=${betFacts.sizing.sizeApproximation}`);
line(`到达范围总质量=${p4(betFacts.arrivalMass)}  下注范围总质量(归一化前)=${p4(betFacts.betMass)}  他会下注的比例=${pct(betFacts.betShareOfArrival)}`);
line(`下注范围组合数：到达 ${ARRIVAL.filter((e) => e.probability > 0).length} → 下注 ${betFacts.entries.length}`);
line('');
line('下注范围类别质量（BET RANGE classMasses）：');
for (const [k, v] of Object.entries(betFacts.classMasses)) line(`  ${pad(k, 22)} ${typeof v === 'number' ? p4(v) : String(v)}`);
line('');

const eqBet = equityVsEntries(betFacts.entries, 6000, EQUITY_SEED + 1301);   // 与 rangeEquityOfMany 同口径
line(`引擎口径复核：EqVsBetRange = ${p4(eqBet.value)}（method=${eqBet.method}, iters=${eqBet.iterations}）`);
line(`引擎报告值      ：0.0054（math.heroEquityVsBetRange）`);
line(`CALL EV = ${p4(eqBet.value)} × (pot ${computePot(fullState)} + call ${fullState.currentBet}) − ${fullState.currentBet} = ${p4((eqBet.value ?? 0) * (computePot(fullState) + fullState.currentBet) - fullState.currentBet)}`);
line(`引擎报告       ：${p4(-39.277351558238124)}`);
line('');

/* ---------- 逐组合表 ---------- */
const arrivalMap = new Map<string, number>();
for (const e of ARRIVAL) arrivalMap.set(comboZh(e), e.probability);

type Row = { combo: string; shape: string; tier: number; cls: string; arrival: number; p: number; bet: number; norm: number; heroEq: number };
const rows: Row[] = betFacts.entries.map((e) => {
  const hole = holeOf(e);
  const cls = classOf(hole);
  const key = comboZh(e);
  const arrival = arrivalMap.get(key) ?? 0;
  const p = cls === null ? Number.NaN : (classP as unknown as Record<string, number>)[cls.category]!;
  return {
    combo: key, shape: shapeZh(hole), tier: tierOf(hole), cls: cls?.category ?? 'UNCLASSIFIED',
    arrival, p, bet: e.probability * betFacts.betMass, norm: e.probability, heroEq: heroEquityVs(hole),
  };
}).sort((a, b) => b.norm - a.norm);

line('下注范围逐组合（按归一化权重降序）：');
line(pad('Hand', 12) + pad('Hand Strength', 22) + pad('tier', 6) + pad('类别', 22) + pad('Arrival W', 12) + pad('P(BET)', 10) + pad('Bet W', 12) + pad('Norm W', 10) + 'HeroEq');
for (const r of rows) {
  line(pad(r.combo, 12) + pad(r.shape, 22) + pad(String(r.tier), 6) + pad(r.cls, 22) + pad(r.arrival.toExponential(3), 12) +
    pad(p4(r.p), 10) + pad(r.bet.toExponential(3), 12) + pad(p4(r.norm), 10) + p4(r.heroEq));
}
line('');

/* ---------- 分类汇总（用户要求的桶） ---------- */
const buckets: Record<string, { combos: number; arrival: number; bet: number; norm: number; heroEqWeighted: number }> = {};
const bucketOf = (hole: readonly Card[], norm: number, arrival: number, bet: number, he: number): string => {
  const [a, b] = hole;
  const hi = Math.max(a.rank, b.rank), lo = Math.min(a.rank, b.rank);
  const shape = shapeZh(hole);
  if (a.rank === b.rank) {
    if (hi === 14) return 'AA（比 AK 强）';
    if (hi === 13) return 'KK（三条，比 AK 强）';
    if (hi === 9) return '99（暗三条，比 AK 强）';
    if (hi === 4) return '44（暗三条，比 AK 强）';
    if (hi === 6) return '66（暗三条，比 AK 强）';
    if (hi === 2) return '22（暗三条，比 AK 强）';
    if (he === 0) return '其他比 Hero 强的对子';
    return '中等对子 / 小对子（比 AK 弱，摊牌牌）';
  }
  if (hi === 14 && lo === 13) return 'AK（平局）';
  if (hi === 13) {
    if (he === 0) return '两对（K9/K6/K4/K2，比 AK 强）';
    return `弱 Kx（K${lo === 10 ? 'T' : lo === 11 ? 'J' : lo === 12 ? 'Q' : lo}，比 AK 弱）`;
  }
  if (he === 0) return '其他比 AK 强的成手（两对）';
  if (shape.includes('对') || shape.includes('Pair')) return '中等对子 / 小对子（比 AK 弱，摊牌牌）';
  if (shape.includes('高牌') || shape.includes('High')) return '错失听牌 / 纯空气';
  return '其他（比 AK 弱）';
};
for (const r of rows) {
  const hole = ALL_CARDS.filter((c) => r.combo.includes(cardZh(c)));
  const k = bucketOf([hole[0]!, hole[1]!], r.norm, r.arrival, r.bet, r.heroEq);
  const b = (buckets[k] ??= { combos: 0, arrival: 0, bet: 0, norm: 0, heroEqWeighted: 0 });
  b.combos += 1; b.arrival += r.arrival; b.bet += r.bet; b.norm += r.norm; b.heroEqWeighted += r.norm * r.heroEq;
}
line('下注范围分类汇总（桶）：');
line(pad('桶', 34) + pad('组合数', 8) + pad('到达质量', 14) + pad('下注质量', 14) + pad('归一化后', 12) + pad('桶内 Hero 权益', 16) + '对总权益贡献');
for (const [k, b] of Object.entries(buckets).sort((x, y) => y[1].norm - x[1].norm)) {
  line(pad(k, 34) + pad(String(b.combos), 8) + pad(b.arrival.toExponential(3), 14) + pad(b.bet.toExponential(3), 14) +
    pad(p4(b.norm), 12) + pad(pct(b.heroEqWeighted / (b.norm || 1)), 16) + pct(b.heroEqWeighted));
}
line('');

/* ---------- 到达范围分类汇总（对照） ---------- */
line('到达范围（引擎口径 ④）分类汇总 —— 对照「哪些牌被过滤掉了」：');
{
  const acc: Record<string, { c: number; mass: number; p: number }> = {};
  for (const e of ARRIVAL) {
    if (!(e.probability > 0)) continue;
    const hole = holeOf(e);
    const cls = classOf(hole);
    if (cls === null) continue;
    const k = cls.category;
    const a = (acc[k] ??= { c: 0, mass: 0, p: classP[k as never] as unknown as number });
    a.c += 1; a.mass += e.probability;
  }
  line(pad('类别', 24) + pad('组合数', 8) + pad('到达质量', 14) + pad('P(BET|类)', 12) + pad('贡献质量', 14) + pad('占下注范围', 12));
  for (const [k, a] of Object.entries(acc)) {
    line(pad(k, 24) + pad(String(a.c), 8) + pad(p4(a.mass), 14) + pad(p4(a.p), 12) + pad((a.mass * a.p).toExponential(3), 14) +
      pad(pct((a.mass * a.p) / betFacts.betMass), 12));
  }
  line(pad('合计', 24) + pad('', 8) + pad(p4(betFacts.arrivalMass), 14) + pad('', 12) + pad(betFacts.betMass.toExponential(3), 14) + pad(pct(betFacts.betShareOfArrival), 12));
}
line('');

/* ============================================================================
 * 第三部分：行动上下文
 * ============================================================================ */
line('='.repeat(118));
line(' 第三部分  行动上下文（确认这是「他主动下注」节点）');
line('='.repeat(118));
line('');
{
  const hero = fullState.players.find((p) => p.id === fullState.userPlayerId)!;
  const villain = fullState.players.find((p) => p.id === 'seat_BB')!;
  const ac = nodeActionContextOf(fullState, hero as never, villain as never);
  const bettor = lastAggressorOfStreet(fullState.actions, fullState.street);
  line(`本街（${fullState.street}）最后进攻者 position = ${String(bettor)}｜首要对手 position = ${villain.position}｜是否同一人 = ${bettor === villain.position}`);
  line(`actionContext = ${String(ac)}（FACING_CBET/FACING_DONK = 他面对我的下注；GENERIC_BET = 他领打）`);
  line(`state.currentBet = ${fullState.currentBet}（chip）｜potBeforeBet = ${potBeforeBet}｜betRatioToPot = ${p4(fullState.currentBet / potBeforeBet)}`);
  line(`resolvePlayerProfile.actionContext（同一条判定）= ${String(ac)}`);
  line(`betRangeSizing = ${JSON.stringify(betFacts.sizing)}`);
  line(`hero 上一街是否进攻者：TURN 最后进攻者 = ${String(lastAggressorOfStreet(fullState.actions, 'TURN' as never))}（BTN ⇒ 翻牌/转牌都是 Hero 在 cbet）`);
  line('');
  line(`buildBettingRangeFacts 的触发条件（contextBuilder 第 3559-3597 行）：`);
  line(`  bettorPosition(${String(bettor)}) === primaryPosition(${villain.position}) ⇒ 走「他正在下注」分支（不是 Hero 下注，也不是响应模型）`);
  line(`  arrivalEntries 取自 primaryBuild.range（= 本手 hero equity 用的同一份范围）`);
  line('');
  const v3 = resolvePlayerProfile({
    baseArchetype: 'CALLING_STATION' as never, observedStats: null,
    actionContext: ac as never, street: 'RIVER' as never,
  });
  line(`resolvedV3.resolvedDimensions = ${JSON.stringify(v3.resolved.resolvedDimensions)}`);
  line(`resolvedV3.street[RIVER] = ${JSON.stringify(v3.resolved.street['RIVER'])}`);
  line(`deniedStreetTraits = ${JSON.stringify(v3.resolved.deniedTraits ?? v3.resolved.deniedStreetTraits ?? null)}`);
}
line('');

/* ============================================================================
 * 第四部分：合成范围反证
 * ============================================================================ */
line('='.repeat(118));
line(' 第四部分  合成范围反证（Arrival 不变，只改下注权重）');
line('='.repeat(118));
line('');
{
  const pot = computePot(fullState);
  const call = fullState.currentBet;
  const winnable = pot + call;
  const requiredEquity = call / winnable;
  const eqArrival = equityVsEntries(ARRIVAL);

  const beatsHero: Entry[] = ARRIVAL.filter((e) => { const h = holeOf(e); return e.probability > 0 && heroEquityVs(h) === 0; });
  const losesToHero: Entry[] = ARRIVAL.filter((e) => { const h = holeOf(e); return e.probability > 0 && heroEquityVs(h) === 1; });
  const chops: Entry[] = ARRIVAL.filter((e) => { const h = holeOf(e); return e.probability > 0 && heroEquityVs(h) === 0.5; });

  const mkRange = (weights: Map<string, number>): Entry[] => {
    const raw: Entry[] = [];
    for (const e of ARRIVAL) {
      if (!(e.probability > 0)) continue;
      const w = weights.get(comboZh(e)) ?? 0;
      if (!(w > 0)) continue;
      raw.push({ cardIndices: e.cardIndices, probability: e.probability * w });
    }
    const mass = raw.reduce((a, x) => a + x.probability, 0);
    return raw.map((x) => ({ cardIndices: x.cardIndices, probability: x.probability / mass }));
  };

  // A：以击败 Hero 的价值牌为主（强价值 0.80 / 诈唬 0.20），Hero 能赢的弱价值牌权重 0
  const wA = new Map<string, number>();
  for (const e of beatsHero) wA.set(comboZh(e), 0.80);
  for (const e of losesToHero) wA.set(comboZh(e), 0);
  for (const e of chops) wA.set(comboZh(e), 0.40);
  // 诈唬：Air 类 20%
  for (const e of ARRIVAL) { const h = holeOf(e); const c = classOf(h); if (c !== null && ['MISSED_FLUSH_DRAW', 'MISSED_STRAIGHT_DRAW', 'MISSED_COMBO_DRAW', 'PURE_AIR'].includes(c.category)) wA.set(comboZh(e), 0.20); }

  // B：包含更多 Hero 能击败的弱价值牌 + 更多诈唬（强价值 0.50 / 弱价值 0.50 / 诈唬 0.50）
  const wB = new Map<string, number>();
  for (const e of beatsHero) wB.set(comboZh(e), 0.50);
  for (const e of losesToHero) wB.set(comboZh(e), 0.50);
  for (const e of chops) wB.set(comboZh(e), 0.50);
  for (const e of ARRIVAL) { const h = holeOf(e); const c = classOf(h); if (c !== null && ['MISSED_FLUSH_DRAW', 'MISSED_STRAIGHT_DRAW', 'MISSED_COMBO_DRAW', 'PURE_AIR'].includes(c.category)) wB.set(comboZh(e), 0.50); }

  const rangeA = mkRange(wA);
  const rangeB = mkRange(wB);
  const eqA = equityVsEntries(rangeA);
  const eqB = equityVsEntries(rangeB);

  const report = (tag: string, entries: Entry[], eq: number | null) => {
    const callEV = (eq ?? 0) * winnable - call;
    const foldEV = 0;
    const finalAction = callEV > foldEV ? 'CALL' : 'FOLD';   // 由 EV 决定，不硬编码
    line(`${tag}：组合数=${entries.length}｜EqVsBetRange=${p4(eq)}｜RequiredEquity=${p4(requiredEquity)}｜CALL EV=${p4(callEV)}｜FOLD EV=${foldEV}｜FinalAction=${finalAction}`);
    return finalAction;
  };
  line(`Arrival Range（固定，引擎口径）：EqVsArrivalRange = ${p4(eqArrival.value)}（两组完全相同）`);
  line(`pot=${pot}  call=${call}  requiredEquity=${p4(requiredEquity)}  winnable=${winnable}`);
  line(`可达组合：比 Hero 强 ${beatsHero.length} 个｜比 Hero 弱 ${losesToHero.length} 个｜平局 ${chops.length} 个`);
  line('');
  const fa = report('A（价值为主：强价值 0.80 / 诈唬 0.20 / 弱价值 0）', rangeA, eqA.value);
  const fb = report('B（弱价值 + 诈唬更多：价值 0.50 / 弱价值 0.50 / 诈唬 0.50）', rangeB, eqB.value);
  line('');
  line('权重合法性：每组权重 ∈ [0,1]，BetW = ArrivalW × w，归一化后 Σp = ' +
    p4(rangeA.reduce((a, x) => a + x.probability, 0)) + ' / ' + p4(rangeB.reduce((a, x) => a + x.probability, 0)));
  line(`最终动作由 EV 决定：A ⇒ ${fa}，B ⇒ ${fb}（未硬编码）`);
  line('');
  line('同样的构造，用在**真正下注前**的到达范围（③ 层）上：');
  {
    const mkRange2 = (weights: Map<string, number>, src: readonly Entry[]): Entry[] => {
      const raw: Entry[] = [];
      for (const e of src) { const w = weights.get(comboZh(e)) ?? 0; if (e.probability > 0 && w > 0) raw.push({ cardIndices: e.cardIndices, probability: e.probability * w }); }
      const mass = raw.reduce((a, x) => a + x.probability, 0);
      return mass > 0 ? raw.map((x) => ({ cardIndices: x.cardIndices, probability: x.probability / mass })) : [];
    };
    const src = BEFORE_BET_LAYER.entries;
    const beats2 = src.filter((e) => e.probability > 0 && heroEquityVs(holeOf(e)) === 0);
    const loses2 = src.filter((e) => e.probability > 0 && heroEquityVs(holeOf(e)) === 1);
    const wA2 = new Map<string, number>(), wB2 = new Map<string, number>();
    for (const e of beats2) { wA2.set(comboZh(e), 0.8); wB2.set(comboZh(e), 0.5); }
    for (const e of loses2) { wA2.set(comboZh(e), 0); wB2.set(comboZh(e), 0.5); }
    const eqA2 = equityVsEntries(mkRange2(wA2, src));
    const eqB2 = equityVsEntries(mkRange2(wB2, src));
    line(`  EqVsArrivalRange(③) = ${p4(BEFORE_BET_LAYER.eq.value)}｜A ⇒ ${p4(eqA2.value)}｜B ⇒ ${p4(eqB2.value)}`);
  }
}
line('');

/* ============================================================================
 * 第五部分：人物画像对照
 * ============================================================================ */
line('='.repeat(118));
line(' 第五部分  人物画像对照（NORMAL / CALLING_STATION / MANIAC / NIT，只改画像）');
line('='.repeat(118));
line('');
const PROFILE_SET = ['NORMAL', 'CALLING_STATION', 'MANIAC', 'VERY_TIGHT'];
for (const profile of PROFILE_SET) {
  const { state, playerBuilt: b, build: rb, hero } = rangeAtLayer(FULL, profile, null);
  const tend = responseTendenciesOf(b.tendency === null ? null : (b.tendency.dimension.dimensions as never), b.confidence, null);
  const cP = betProbabilityByClass(tend, state.currentBet / (computePot(state) - state.currentBet));
  const range = rb.range;
  const entries: Entry[] = range === null ? [] : range.entries.map((e: any) => ({ cardIndices: e.combo.cardIndices, probability: e.probability }));
  const facts = buildBettingRangeFacts({
    arrivalEntries: entries, board: BOARD_CARDS, heroHole: HERO_CARDS,
    potChips: computePot(state) - state.currentBet, betChips: state.currentBet, street: 'RIVER', tendencies: tend,
  });
  const eqBet = facts === null ? { value: null } : equityVsEntries(facts.entries, 6000, EQUITY_SEED + 1301);
  const eqArr = equityVsEntries(entries);
  const callEV = facts === null || eqBet.value === null ? null : eqBet.value * (computePot(state) + state.currentBet) - state.currentBet;
  const v3 = resolvePlayerProfile({
    baseArchetype: profile as never, observedStats: null,
    actionContext: nodeActionContextOf(state, hero as never, state.players.find((p) => p.id === 'seat_BB') as never) as never,
    street: 'RIVER' as never,
  });
  const ana = analyzeManualHand(mkInput(FULL, profile, null), {
    rules: RULES, asOf: ASOF, writeLog: false, equitySeed: EQUITY_SEED, budget: { softMs: 120_000, hardMs: 240_000 },
  });
  const decision = ana.ok ? (ana.decision as unknown as Record<string, any>) : null;

  line(`--- ${profile} ---`);
  line(`  resolvedDimensions = ${JSON.stringify(v3.resolved.resolvedDimensions)}`);
  line(`  P(BET|类) = STRONG ${p4(cP.STRONG_VALUE)}｜THIN ${p4(cP.THIN_VALUE)}｜SHOWDOWN ${p4(cP.SHOWDOWN_VALUE)}｜AIR ${p4(cP.PURE_AIR)}`);
  if (facts !== null) {
    line(`  Bet Range：支持 ${facts.entries.length}/${entries.filter((e) => e.probability > 0).length} 组合｜价值质量 ${pct(facts.classMasses.valueMass)}｜诈唬质量 ${pct(facts.classMasses.bluffMass)}｜摊牌质量 ${pct(facts.classMasses.showdownMass)}｜下注占比 ${pct(facts.betShareOfArrival)}`);
  }
  line(`  EqVsArrival=${p4(eqArr.value)}  EqVsBetRange=${p4(eqBet.value)}  CALL EV=${p4(callEV)}  引擎 action=${decision === null ? 'ANALYZE_FAIL' : String(decision['action'])}+${decision?.['sizeChips'] ?? ''}`);
  line('');
}

/* ============================================================================
 * 第六部分：诊断汇总
 * ============================================================================ */
line('='.repeat(118));
line(' 第六部分  诊断汇总（证据行）');
line('='.repeat(118));
line('');
line(`1) 引擎所称 Arrival Range（math.heroEquity 的输入）**已经包含 RIVER/BET 似然**：更新轨迹最后一条 = RIVER/BET。`);
line(`   → 真正「河牌下注前」的到达范围是第 ③ 层（权益 ${p4(BEFORE_BET_LAYER.eq.value)}），而引擎用的是第 ④ 层（权益 ${p4(ARRIVAL_LAYER.eq.value)}）。`);
line(`2) 下注范围 = 第 ④ 层 × P(BET|类别)：到达 ${ARRIVAL.filter((e) => e.probability > 0).length} 组合 → 下注 ${betFacts.entries.length} 组合。`);
line(`3) 被 P(BET|类别) 判成 0 的类别：` +
  Object.entries(classP).filter(([, v]) => !(v > 0)).map(([k]) => k).join(', ') + '（若为空则无整类清零）');
line(`4) EqVsBetRange = ${p4(eqBet.value)}；CALL EV = ${p4((eqBet.value ?? 0) * (computePot(fullState) + fullState.currentBet) - fullState.currentBet)}。`);
line('');
