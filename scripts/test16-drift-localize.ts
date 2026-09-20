/**
 * TEST 16 · 复算漂移定位（只读、一次性诊断；不修改产品代码）
 *
 * 目的：找出影子复算与生产输出的差到底来自**哪一个输入**。
 * 做法：把生产 `bettingRangeFacts` / `betRangeArrival` 的量与
 * 多种范围链输入组合逐一对比，逐位一致的那一组就是生产的真实输入。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildBettingRangeFacts } from '../src/app/manualInput/bettingRange.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { computePot, realizedOpponentIds, allBoardCards } from '../src/domain/poker/gameState.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { resolvePlayerProfile } from '../src/domain/player/observedStats.ts';
import { quickProfileToLimperArchetype, LimperArchetype } from '../src/app/manualInput/limpIsolation.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { buildRangeSnapshot, buildPlayerSnapshot, boardAtStreetOf, nodeActionContextOf, rangeEquityOfMany } from './__shadow-contextBuilder.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const EQUITY_SEED = 20_260_913;
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: EQUITY_SEED, budget: { softMs: 120_000, hardMs: 240_000 } } as const;

const A = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});
const STATS = {
  handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
  foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
} as const;

function mkInput(pid?: string): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: {
      ...(pid === undefined ? {} : { playerId: pid }),
      quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: STATS,
    },
  } as unknown as ManualHandInput;
}

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 9): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));

/* ============================================================
 * A. 只改「对手名字」看生产输出是否变化
 * ============================================================ */
line('== A. 只改「对手名字（playerId）」对生产输出的影响 ==');
for (const [tag, pid] of [
  ['不给名字（playerId 缺省）', undefined],
  ['给名字「阿豪」', '阿豪'],
  ['给名字 = 座位 id「seat_BB」', 'seat_BB'],
] as const) {
  const res = analyzeManualHand(mkInput(pid), OPTIONS);
  if (!res.ok) { line(`  ${tag}：分析失败 ${res.stage}`); continue; }
  const dg = (res.decision as unknown as Record<string, any>)['diagnostics'] as Record<string, any>;
  const pf = (dg['postflop'] ?? {}) as Record<string, any>;
  const br = (pf['bettingRangeFacts'] ?? null) as Record<string, any> | null;
  const rr = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
  line(`  ${tag}：动作 = ${String((res.decision as any).action)}｜betMass = ${n(br?.['betMass'])}｜EqVsArrival = ${n((pf['betRangeArrival'] ?? {})['heroEquityVsArrivalRange'])}` +
    `｜EqVsBetRange = ${n((dg['math'] ?? {})['heroEquityVsBetRange'])}`);
  line(`     P(弃/跟/再加) = ${rr === null ? '—' : `${n(rr['foldLikelihood'], 6)}/${n(rr['callLikelihood'], 6)}/${n(rr['reRaiseLikelihood'], 6)}`}｜RAISE EV = ${n(rr?.['raiseEV'], 6)}`);
  line(`     warnings = ${JSON.stringify(res.warnings)}`);
}

const named = analyzeManualHand(mkInput('阿豪'), OPTIONS);
if (!named.ok) { line('分析失败'); process.exit(1); }
const DGn = (named.decision as unknown as Record<string, any>)['diagnostics'] as Record<string, any>;
const PFn = (DGn['postflop'] ?? {}) as Record<string, any>;
const PROD = (PFn['bettingRangeFacts'] ?? null) as Record<string, any> | null;
const PROD_ARRIVAL_EQ = (PFn['betRangeArrival'] ?? {})['heroEquityVsArrivalRange'] as number;
line('');
line(`== 目标（生产 · 带名字「阿豪」）：betMass = ${n(PROD?.['betMass'])}｜EqVsArrival = ${n(PROD_ARRIVAL_EQ)} ==`);

/* ============================================================
 * B. 组合扫描
 * ============================================================ */
const parsed = parseManualInput(mkInput('阿豪'));
const gate = buildAnalyzableState((parsed as any).value);
const state = (gate as any).state;
const hero = state.players.find((p: any) => p.id === state.userPlayerId)!;
const opps = state.players.filter((p: any) => p.id !== hero.id && !p.folded);
const realized = realizedOpponentIds(state);
const villain = opps.filter((p: any) => realized.has(p.id))[0] ?? opps[0];
const board = allBoardCards(state);
const currentPot = computePot(state);
line(`  座位 id：Hero = ${String(hero.id)}｜对手 = ${String(villain.id)}（state.userPlayerId = ${String(state.userPlayerId)}）`);
line(`  生产的 identity 判据是 \`opponent.id === villainId\`，而 villainId = input.villainPlayerId ?? 座位 id`);
line(`  ⇒ 若传了名字，villainId = 「阿豪」≠ 座位 id ⇒ 画像三件套在**范围链**上按「陌生人」处理`);

const resolvedV3 = resolvePlayerProfile({
  baseArchetype: 'MANIAC' as never, observedStats: STATS as never, opportunities: null,
  actionContext: nodeActionContextOf(state, hero, villain) as never, street: 'RIVER',
});
const v3StreetInput = { street: 'RIVER' as const, factors: resolvedV3.resolved.street.RIVER };
let betIndex: number | undefined;
for (let i = state.actions.length - 1; i >= 0; i -= 1) {
  const a = state.actions[i]!;
  if (a.street === state.street && (a.type === 'BET' || a.type === 'RAISE' || a.type === 'RERAISE' || a.type === 'ALL_IN')) { betIndex = i; break; }
}

line('');
line('== B. 范围链输入组合扫描 ==');
line('  ' + '变体（名字 / identity 成立? / limpProfile）'.padEnd(60) + 'betMass'.padStart(14) + 'EqVsArrival'.padStart(17) + '判定');
for (const pid of [villain.id, '阿豪'] as const) {
  for (const limpMode of ['byName', 'population'] as const) {
    const identityMatches = pid === villain.id;
    const tag = `pid=${pid} identity=${identityMatches} limp=${limpMode}`;
    const pb = buildPlayerSnapshot(pid as never, undefined as never, 'MANIAC' as never, 'UNKNOWN' as never,
      (s: never) => boardAtStreetOf(state, s));
    const t = responseTendenciesOf(pb.tendency?.dimension.dimensions as never, pb.confidence, v3StreetInput as never);
    const limp = limpMode === 'byName'
      ? { archetype: quickProfileToLimperArchetype('MANIAC'), confidence: pb.confidence }
      : { archetype: LimperArchetype.POPULATION, confidence: 0 };
    const rb = buildRangeSnapshot(state, villain as never, [...hero.holeCards, ...board] as never, undefined,
      (identityMatches ? pb.tendency : null) as never,
      limp as never,
      (identityMatches ? behaviorProfileOf({ playerId: pid, archetype: 'MANIAC' as never }) : null) as never,
      betIndex);
    const arrival = (rb.rangeBeforeAction ?? rb.range)!;
    const f = buildBettingRangeFacts({
      arrivalEntries: arrival.entries.map((e: any) => ({ cardIndices: e.combo.cardIndices, probability: e.probability })),
      board: board as never, heroHole: hero.holeCards,
      potChips: currentPot - state.currentBet, betChips: state.currentBet, street: 'RIVER', tendencies: t as never,
    });
    const eqArr = rangeEquityOfMany(
      hero.holeCards, board,
      [arrival.entries.map((e: any) => ({ cardIndices: e.combo.cardIndices, probability: e.probability }))],
      EQUITY_SEED + 1301,
    ).value;
    const okMass = Math.abs((f?.betMass ?? NaN) - (PROD?.['betMass'] ?? NaN)) < 1e-12;
    const okEq = Math.abs((eqArr ?? NaN) - PROD_ARRIVAL_EQ) < 1e-15;
    line('  ' + tag.padEnd(60) + n(f?.betMass, 12).padStart(14) + n(eqArr, 15).padStart(17) +
      `  ${okMass ? '✔质量' : '✖'}${okEq ? '✔权益' : '✖'}${okMass && okEq ? '  ← **与生产完全一致**' : ''}`);
  }
}
