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
 * 只读探针 3：HUD 实测统计是否进入「他的下注范围」+ 四个画像的公式级归因
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
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { resolvePlayerProfile, type PlayerObservedStats } from '../src/domain/player/observedStats.ts';
import { computePot } from '../src/domain/poker/gameState.ts';
import { buildRangeSnapshot, buildPlayerSnapshot, nodeActionContextOf, boardAtStreetOf } from './__shadow-contextBuilder.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const BOARD = ['Kd', '9c', '4h', '6s', '2d'] as const;
const HERO = ['As', 'Ks'] as const;
const SEED = 20_261_014;
const RANK_CHARS: Record<number, string> = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const CHAR_RANKS: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const cardZh = (c: Card): string => `${RANK_CHARS[c.rank]}${c.suit}`;
const parseCard = (s: string): Card => ALL_CARDS.find((c) => c.rank === CHAR_RANKS[s.slice(0, -1)]! && c.suit === s.slice(-1))!;
const HERO_CARDS = HERO.map(parseCard);
const BOARD_CARDS = BOARD.map(parseCard);

const line = (s = ''): void => console.log(s);
const p4 = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : '—');
const pct = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—');
const pad = (s: string, n: number): string => { const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0); return s + ' '.repeat(Math.max(0, n - w)); };

const H = (p: string, t: string, a?: number, s?: string) => ({ position: p, type: t, ...(a === undefined ? {} : { amountBB: a }), ...(s === undefined ? {} : { street: s }) });
const FULL = [
  H('UTG', 'FOLD'), H('HJ', 'FOLD'), H('CO', 'FOLD'), H('BTN', 'RAISE', 3), H('SB', 'FOLD'), H('BB', 'CALL', 2),
  H('BB', 'CHECK', undefined, 'FLOP'), H('BTN', 'BET', 2.5, 'FLOP'), H('BB', 'CALL', 2.5, 'FLOP'),
  H('BB', 'CHECK', undefined, 'TURN'), H('BTN', 'BET', 7.5, 'TURN'), H('BB', 'CALL', 7.5, 'TURN'),
  H('BB', 'BET', 20, 'RIVER'),
];

const MANIAC_STATS: PlayerObservedStats = {
  handsObserved: 1500, vpip: 0.60, pfr: 0.45, threeBet: 0.18, wtsd: 0.35,
  foldToFlopCBet: 0.22, foldToTurnCBet: 0.20, foldToRiverBet: 0.18,
  flopCheckRaise: 0.18, turnCheckRaise: 0.15, riverCheckRaise: 0.12,
};
const NIT_STATS: PlayerObservedStats = {
  handsObserved: 1500, vpip: 0.15, pfr: 0.12, threeBet: 0.04, wtsd: 0.22,
  foldToFlopCBet: 0.72, foldToTurnCBet: 0.70, foldToRiverBet: 0.75,
  flopCheckRaise: 0.03, turnCheckRaise: 0.02, riverCheckRaise: 0.02,
};

function mk(profile: string, stats: PlayerObservedStats | null) {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: [...HERO], board: [...BOARD], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: FULL.map((x) => ({ ...x })), environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100, ...(stats === null ? {} : { observedStats: stats }) },
  } as unknown as ManualHandInput;
}

function run(profile: string, stats: PlayerObservedStats | null) {
  const input = mk(profile, stats);
  const parsed = parseManualInput(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues[0]));
  const rc = reconstructGameState(parsed.value, { mode: 'PREVIEW' as never });
  if (!rc.ok) throw new Error(JSON.stringify(rc.issues[0]));
  const state = rc.state;
  const opponent = state.players.find((p) => p.id === 'seat_BB')!;
  const hero = state.players.find((p) => p.id === state.userPlayerId)!;

  const built = buildDecisionContext({
    state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
    quickProfile: profile as never,
    ...(stats === null ? {} : { observedStats: stats as never }),
    equitySeed: SEED,
  }).context as unknown as Record<string, any>;

  const pb = buildPlayerSnapshot('seat_BB' as never, undefined as never, profile as never, 'UNKNOWN' as never, (s: never) => boardAtStreetOf(state, s));
  const build = buildRangeSnapshot(state, opponent as never, [...HERO_CARDS, ...BOARD_CARDS] as never, undefined,
    pb.tendency as never, { archetype: quickProfileToLimperArchetype(profile), confidence: pb.confidence } as never,
    (behaviorProfileOf({ playerId: 'seat_BB', archetype: profile as never }) ?? null) as never);
  const entries = build.range === null ? [] : build.range.entries.map((e: any) => ({ cardIndices: e.combo.cardIndices, probability: e.probability }));
  const dims = pb.tendency === null ? null : (pb.tendency.dimension.dimensions as Record<string, number>);
  const ac = nodeActionContextOf(state, hero as never, opponent as never);
  const v3 = resolvePlayerProfile({
    baseArchetype: profile as never, observedStats: stats, actionContext: ac as never, street: 'RIVER' as never,
  });
  const v3Street = { street: 'RIVER' as const, factors: v3.resolved.street['RIVER'] as never };
  const tend = responseTendenciesOf(dims as never, pb.confidence, v3Street as never);
  const classP = betProbabilityByClass(tend, state.currentBet / (computePot(state) - state.currentBet)) as unknown as Record<string, number>;
  const facts = buildBettingRangeFacts({
    arrivalEntries: entries, board: BOARD_CARDS, heroHole: HERO_CARDS,
    potChips: computePot(state) - state.currentBet, betChips: state.currentBet, street: 'RIVER', tendencies: tend,
  });
  const ana = analyzeManualHand(input, { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: SEED, budget: { softMs: 120_000, hardMs: 240_000 } });
  const decision = ana.ok ? (ana.decision as unknown as Record<string, any>) : null;
  const math = decision === null ? null : ((decision['diagnostics'] as any)['math'] as Record<string, any>);
  const postflop = decision === null ? null : ((decision['diagnostics'] as any)['postflop'] as Record<string, any>);

  // 公式级归因：showdown = 0.1 + 0.15a + 0.15b − 0.2p（未夹取）
  const c = (v: number | undefined): number => (Number.isFinite(v) ? Math.max(-1, Math.min(1, ((v as number) - 0.5) * 2)) : 0);
  const a = c(dims?.['aggression']), b = c(dims?.['bluffTendency']), p = c(dims?.['passivity']);
  return { pb, dims, ac, v3, tend, classP, facts, math, postflop, action: decision === null ? 'ANALYZE_FAIL' : String(decision['action']), sizeChips: decision?.['sizeChips'] ?? null, raw: { a, b, p, strong: 0.45 + 0.3 * a + 0.25 * b, thin: 0.25 + 0.3 * a + 0.3 * b, showdown: 0.1 + 0.15 * a + 0.15 * b - 0.2 * p, bluffRate: (dims?.['bluffTendency'] ?? 0.5) * Math.max(0, 0.45 + 0.3 * a + 0.25 * b) }, updateTrace: build.snapshot?.updateTrace ?? [] };
}

line('='.repeat(120));
line(' 第三部分补充 / 第五部分补充：画像 × HUD 实测统计');
line('='.repeat(120));
line('');

const cases: Array<[string, string, PlayerObservedStats | null]> = [
  ['NORMAL', '无统计', null],
  ['CALLING_STATION', '无统计', null],
  ['MANIAC', '无统计', null],
  ['VERY_TIGHT', '无统计（=NIT 语义）', null],
  ['CALLING_STATION', '+MANIAC 型统计（vpip60/pfr45/wtsd35/foldToRiverBet18%）', MANIAC_STATS],
  ['CALLING_STATION', '+NIT 型统计（vpip15/pfr12/wtsd22/foldToRiverBet75%）', NIT_STATS],
  ['NORMAL', '+MANIAC 型统计', MANIAC_STATS],
  ['NORMAL', '+NIT 型统计', NIT_STATS],
];

for (const [profile, statsTag, stats] of cases) {
  const r = run(profile, stats);
  line(`--- ${profile} ／ ${statsTag} ---`);
  line(`  维度（tendency.dimension.dimensions，进 P(BET|类别) 的就是这一组）= ${JSON.stringify(r.dims)}`);
  line(`  resolvedV3.resolvedDimensions = ${JSON.stringify(r.v3.resolved.resolvedDimensions)}`);
  line(`  actionContext = ${String(r.ac)}｜V3 street[RIVER].betScale = ${p4((r.v3.resolved.street['RIVER'] as any)?.betScale)}｜deniedStreetTraits = ${JSON.stringify((r.v3.resolved as any).deniedTraits ?? (r.v3.resolved as any).deniedStreetTraits ?? null)}`);
  line(`  未夹取公式值：strong=${p4(r.raw.strong)} thin=${p4(r.raw.thin)} **showdown=${p4(r.raw.showdown)}**（<0 ⇒ 夹到 0）bluffRate=${p4(r.raw.bluffRate)}`);
  line(`  P(BET|类) = STRONG ${p4(r.classP.STRONG_VALUE)}｜THIN ${p4(r.classP.THIN_VALUE)}｜**SHOWDOWN ${p4(r.classP.SHOWDOWN_VALUE)}**｜AIR ${p4(r.classP.PURE_AIR)}`);
  if (r.facts !== null) {
    line(`  Bet Range：support=${r.facts.entries.length} 组合｜价值 ${pct(r.facts.classMasses.valueMass)}｜诈唬 ${pct(r.facts.classMasses.bluffMass)}｜摊牌 ${pct(r.facts.classMasses.showdownMass)}｜下注占比 ${pct(r.facts.betShareOfArrival)}`);
  }
  if (r.math !== null) {
    line(`  math: heroEquity=${(r.math['heroEquity'] as number).toFixed(9)} heroEquityVsBetRange=${(r.math['heroEquityVsBetRange'] as number).toFixed(9)} pot=${r.math['pot']} callCost=${r.math['callCost']} requiredEquity=${p4(r.math['requiredEquity'])} callEV=${(r.math['callEV'] as number).toFixed(6)}`);
  }
  line(`  引擎 action = ${r.action}${r.sizeChips === null ? '' : `（${r.sizeChips}）`}`);
  line(`  RIVER/BET 更新轨迹注记 = ${String((r.updateTrace.find((t: any) => t.street === 'RIVER') as any)?.noteZh ?? '（无 RIVER 更新）')}`);
  line('');
}
