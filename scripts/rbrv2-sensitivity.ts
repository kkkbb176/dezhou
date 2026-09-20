/**
 * RIVER BET RANGE V2 —— 敏感性分析（未校准假设的影响幅度）
 *
 * 做法：用同一条产品范围更新链取出**真正的到达范围**，然后用产品的
 * `publicStrengthBandOf` + `betProbabilityByBand` 重算下注范围，
 * 只把**某一个强度带的系数**乘上 k，看权益与动作如何变化。
 *
 * ⚠️ 这只用于**量化不确定性**，不改变产品行为，也不用于调参达标。
 */
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import {
  PUBLIC_STRENGTH_BAND_ORDER,
  PUBLIC_STRENGTH_BAND_ZH,
  betProbabilityByBand,
  buildBettingRangeFacts,
  publicStrengthBandOf,
  type PublicStrengthBand,
} from '../src/app/manualInput/bettingRange.ts';
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { quickProfileToLimperArchetype } from '../src/app/manualInput/limpIsolation.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { ALL_CARDS, type Card } from '../src/domain/types.ts';
import { computeEquity, EquityComputeMode } from '../src/domain/poker/equity.ts';
import { computePot } from '../src/domain/poker/gameState.ts';
import { buildRangeSnapshot, buildPlayerSnapshot, boardAtStreetOf } from './__shadow-contextBuilder.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_014;
const BOARD = ['Kd', '9c', '4h', '6s', '2d'] as const;
const HERO = ['As', 'Ks'] as const;
const RANK_CHARS: Record<number, string> = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const CHAR_RANKS: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const cardZh = (c: Card): string => `${RANK_CHARS[c.rank]}${c.suit}`;
const parseCard = (s: string): Card => ALL_CARDS.find((c) => c.rank === CHAR_RANKS[s.slice(0, -1)]! && c.suit === s.slice(-1))!;
const HERO_CARDS = HERO.map(parseCard);
const BOARD_CARDS = BOARD.map(parseCard);

const line = (s = ''): void => console.log(s);
const p4 = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : '—');
const p2 = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—');
const pad = (s: string, n: number): string => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};

const H = (p: string, t: string, a?: number, s?: string) => ({ position: p, type: t, ...(a === undefined ? {} : { amountBB: a }), ...(s === undefined ? {} : { street: s }) });
const FULL = [
  H('UTG', 'FOLD'), H('HJ', 'FOLD'), H('CO', 'FOLD'), H('BTN', 'RAISE', 3), H('SB', 'FOLD'), H('BB', 'CALL', 2),
  H('BB', 'CHECK', undefined, 'FLOP'), H('BTN', 'BET', 2.5, 'FLOP'), H('BB', 'CALL', 2.5, 'FLOP'),
  H('BB', 'CHECK', undefined, 'TURN'), H('BTN', 'BET', 7.5, 'TURN'), H('BB', 'CALL', 7.5, 'TURN'),
  H('BB', 'BET', 20, 'RIVER'),
];
const PROFILE = 'CALLING_STATION';

function inputFor(): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: [...HERO], board: [...BOARD], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: FULL.map((x) => ({ ...x })), environment: 'MID_LOW_STAKES',
    villain: { quickProfile: PROFILE, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

/* 取到达范围（链上排除当前 BET）与引擎口径的下注范围 */
const parsed = parseManualInput(inputFor());
if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues[0]));
const gate = buildAnalyzableState(parsed.value);
if (!gate.ok) throw new Error(JSON.stringify(gate.issues[0]));
const state = gate.state;
const opponent = state.players.find((p) => p.id === 'seat_BB')!;
const pb = buildPlayerSnapshot('seat_BB' as never, undefined as never, PROFILE as never, 'UNKNOWN' as never, (s: never) => boardAtStreetOf(state, s));
/** 当前下注 = state.actions 里本街最后一个进攻动作的下标 */
let betIndex = -1;
for (let i = state.actions.length - 1; i >= 0; i -= 1) {
  const a = state.actions[i]!;
  if (a.street === state.street && (a.type === 'BET' || a.type === 'RAISE' || a.type === 'RERAISE' || a.type === 'ALL_IN')) { betIndex = i; break; }
}
const build = buildRangeSnapshot(state, opponent as never, [...HERO_CARDS, ...BOARD_CARDS] as never, undefined,
  pb.tendency as never, { archetype: quickProfileToLimperArchetype(PROFILE), confidence: pb.confidence } as never,
  (behaviorProfileOf({ playerId: 'seat_BB', archetype: PROFILE as never }) ?? null) as never, betIndex);
const arrival = (build.rangeBeforeAction ?? build.range)!;
const arrivalEntries = arrival.entries.map((e: any) => ({ cardIndices: e.combo.cardIndices as readonly [number, number], probability: e.probability as number }));
const posteriorEntries = build.range!.entries.map((e: any) => ({ cardIndices: e.combo.cardIndices as readonly [number, number], probability: e.probability as number }));

const tendencies = responseTendenciesOf(pb.tendency === null ? null : (pb.tendency.dimension.dimensions as never), pb.confidence, null);
const potBefore = computePot(state) - state.currentBet;
const call = state.currentBet;
const winnable = computePot(state) + call;
const required = call / winnable;

function equity(entries: readonly { cardIndices: readonly [number, number]; probability: number }[]): number {
  const out = computeEquity([HERO_CARDS[0]!, HERO_CARDS[1]!], BOARD_CARDS,
    [{ label: 'R', combos: entries.map((e) => [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const) }],
    { mode: EquityComputeMode.FAST, seed: SEED + 1301, iterations: 6000, opponentWeights: [entries.map((e) => e.probability)] });
  return out.ok ? out.result.equity : Number.NaN;
}

const baseFacts = buildBettingRangeFacts({
  arrivalEntries, board: BOARD_CARDS, heroHole: HERO_CARDS, potChips: potBefore, betChips: call, street: 'RIVER', tendencies,
})!;
const engineEq = equity(baseFacts.entries);
const ctx = buildDecisionContext({
  state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
  quickProfile: PROFILE as never, equitySeed: SEED,
}).context as unknown as Record<string, any>;

line('='.repeat(110));
line(' 敏感性分析：未校准的「强度带系数」对 EqVsBetRange / CALL EV / 动作 的影响');
line('='.repeat(110));
line(`  链条复现校验：本地复算 ${p4(engineEq)} vs 引擎 ${p4(ctx['math']['heroEquityVsBetRange'])} ⇒ ` +
  `${Math.abs(engineEq - (ctx['math']['heroEquityVsBetRange'] as number)) < 1e-12 ? '逐位一致' : '不一致'}`);
line(`  到达范围权益 ${p4(ctx['math']['heroEquityVsArrivalRange'] ?? ctx['postflopFacts']?.['betRangeArrival']?.['heroEquityVsArrivalRange'])}｜所需权益 ${p4(required)}｜底池 ${computePot(state)}｜跟注 ${call}｜可争夺 ${winnable}`);
line('');

/** 用修改后的「带 → 率」重建下注范围（与产品算法同形：乘权重 → 归一化） */
function withRateScale(scale: Partial<Record<PublicStrengthBand, number>>): { entries: { cardIndices: readonly [number, number]; probability: number }[]; share: number } {
  const rates = baseFacts.bandRates as unknown as Record<PublicStrengthBand, number>;
  const raw: { cardIndices: readonly [number, number]; probability: number }[] = [];
  let arrivalMass = 0;
  for (const e of arrivalEntries) {
    if (!(e.probability > 0)) continue;
    const hole = [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const;
    if (hole.some((c) => HERO_CARDS.some((h) => h.rank === c.rank && h.suit === c.suit) || BOARD_CARDS.some((b) => b.rank === c.rank && b.suit === c.suit))) continue;
    const band = publicStrengthBandOf([hole[0], hole[1]], BOARD_CARDS);
    if (band === null) continue;
    arrivalMass += e.probability;
    const w = rates[band] * (scale[band] ?? 1);
    if (!(w > 0)) continue;
    raw.push({ cardIndices: e.cardIndices, probability: e.probability * w });
  }
  const mass = raw.reduce((a, x) => a + x.probability, 0);
  return { entries: raw.map((x) => ({ cardIndices: x.cardIndices, probability: x.probability / mass })), share: mass / arrivalMass };
}

line(pad('情形', 46) + pad('下注占比', 12) + pad('EQ(下注范围)', 16) + pad('CALL EV', 14) + pad('动作', 8) + '说明');
const scenarios: Array<{ tag: string; scale: Partial<Record<PublicStrengthBand, number>> }> = [
  { tag: '基准（引擎现状）', scale: {} },
  { tag: '顶对系数 ×0（回到修复前的整类清零）', scale: { TOP_PAIR_GOOD: 0, TOP_PAIR_WEAK: 0 } },
  { tag: '顶对系数 ×0.25', scale: { TOP_PAIR_GOOD: 0.25, TOP_PAIR_WEAK: 0.25 } },
  { tag: '顶对系数 ×0.5', scale: { TOP_PAIR_GOOD: 0.5, TOP_PAIR_WEAK: 0.5 } },
  { tag: '顶对系数 ×2', scale: { TOP_PAIR_GOOD: 2, TOP_PAIR_WEAK: 2 } },
  { tag: '中对/底对系数 ×0（摊牌区只留顶对）', scale: { MIDDLE_PAIR: 0, WEAK_PAIR: 0 } },
  { tag: '中对/底对系数 ×3', scale: { MIDDLE_PAIR: 3, WEAK_PAIR: 3 } },
  { tag: '诈唬（空气）×0', scale: { AIR: 0 } },
  { tag: '诈唬（空气）×2', scale: { AIR: 2 } },
  { tag: '强成手系数 ×2', scale: { STRONG_MADE: 2, NUT: 2 } },
];
for (const s of scenarios) {
  const r = withRateScale(s.scale);
  const eq = equity(r.entries);
  const callEV = eq * winnable - call;
  line(pad(s.tag, 46) + pad(`${(r.share * 100).toFixed(2)}%`, 12) + pad(p4(eq), 16) + pad(p4(callEV), 14) +
    pad(callEV > 0 ? 'CALL' : 'FOLD', 8) +
    (eq > required ? '（高于门槛）' : '（低于门槛）'));
}
line('');
line('⚠️ 上表的每一行都只是**同一个未校准先验**的不同取值；它们说明：');
line('   ① 结论对「顶对是否下注」这一条假设高度敏感（这正是本轮修掉的那个假设）；');
line('   ② 模型没有用任何真实统计校准过这些系数 ⇒ 必须随结果一起报告，不能当成已验证频率。');
line('');
line('对照：把同一份到达范围 × **修复前的类别模型**（classP：SHOWDOWN=0、THIN=0.0197、STRONG=0.2442、AIR=0.0639）');
{
  const raw: { cardIndices: readonly [number, number]; probability: number }[] = [];
  const legacyP: Record<string, number> = { NUT_VALUE: 0.2442, STRONG_VALUE: 0.2442, THIN_VALUE: 0.0197, SHOWDOWN_VALUE: 0, MISSED_FLUSH_DRAW: 0.0639, MISSED_STRAIGHT_DRAW: 0.0639, MISSED_COMBO_DRAW: 0.0639, PURE_AIR: 0.0639 };
  const { riverComboClassOf } = await import('../src/domain/postflop/riverProfileClassify.ts');
  for (const e of arrivalEntries) {
    if (!(e.probability > 0)) continue;
    const hole = [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const;
    const cls = riverComboClassOf({ hole: [hole[0], hole[1]], board: BOARD_CARDS, heroHole: HERO_CARDS });
    if (cls === null) continue;
    const w = legacyP[cls.category] ?? 0;
    if (!(w > 0)) continue;
    raw.push({ cardIndices: e.cardIndices, probability: e.probability * w });
  }
  const mass = raw.reduce((a, x) => a + x.probability, 0);
  const entries = raw.map((x) => ({ cardIndices: x.cardIndices, probability: x.probability / mass }));
  const eq = equity(entries);
  line(`  修复前等价情形（到达范围 × 旧类别模型）= ${p4(eq)}；CALL EV = ${p4(eq * winnable - call)}（= 旧版在**去重复计费后**仍会给出的数）`);
  void posteriorEntries;
}
