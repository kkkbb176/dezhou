/**
 * ============================================================================
 * 第二阶段 · 任务二：**未匹配（退回）筹码**的处理是否一致
 * ============================================================================
 * 节点：P0-7（Hero BTN 100BB A♠K♠ / BB 30BB / 河牌 BB 下注 10BB=20）
 *   对手跟平最多补 14 ⇒ 无论我名义加到多少（≥120），实际可争夺额都相同：
 *     villainAdd = 14｜heroContestedAdd = 34｜finalPot = 121｜退回 = 名义新增 − 34
 *   ⇒ 响应概率、条件权益、RAISE EV 必须**完全相同**（名义金额只影响退回多少）。
 *
 * 只读。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildRaiseResponse, raiseEVOf } from '../src/app/manualInput/raiseResponse.ts';
import { buildBettingRangeFacts } from '../src/app/manualInput/bettingRange.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { computeEquity, EquityComputeMode } from '../src/domain/poker/equity.ts';
import { committedThisStreet, computePot } from '../src/domain/poker/gameState.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { quickProfileToLimperArchetype } from '../src/app/manualInput/limpIsolation.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { ALL_CARDS, parseCardStrict } from '../src/domain/poker/cards.ts';
import { buildRangeSnapshot, buildPlayerSnapshot, boardAtStreetOf } from './__shadow-contextBuilder.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_014;
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: SEED, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A = (position: string, type: string, amountBB?: number, street?: string) => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/** P0-7：Hero BTN 100BB / BB 30BB / 河牌 BB 下注 10BB */
const NODE: ManualHandInput = {
  tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'],
  board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
  effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 30 },
  actionHistory: [
    A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
    A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
    A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
    A('BB', 'BET', 10, 'RIVER'),
  ],
  environment: 'MID_LOW_STAKES',
  villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 30 },
} as unknown as ManualHandInput;

const gate = buildAnalyzableState(parseManualInput(NODE).value!);
if (!gate.ok) { console.log(`重建失败 ${JSON.stringify(gate.issues)}`); process.exit(1); }
const state = gate.state;
const board = ['Kd', '9c', '4h', '6s', '2d'].map(parseCardStrict);
const hero = state.players.find((p) => p.id === state.userPlayerId)!;
const villain = state.players.find((p) => p.id !== state.userPlayerId && !p.folded)!;
const currentPot = computePot(state);
const heroStreetCommitted = committedThisStreet(state, hero.id);
const villainStreetCommitted = committedThisStreet(state, villain.id);

const pb = buildPlayerSnapshot(villain.id as never, undefined as never, 'CALLING_STATION' as never, 'UNKNOWN' as never,
  (s: never) => boardAtStreetOf(state, s));
let betIndex = -1;
for (let i = state.actions.length - 1; i >= 0; i -= 1) {
  const a = state.actions[i]!;
  if (a.street === state.street && (a.type === 'BET' || a.type === 'RAISE' || a.type === 'RERAISE' || a.type === 'ALL_IN')) { betIndex = i; break; }
}
const built = buildRangeSnapshot(state, villain as never, [...hero.holeCards!, ...board] as never, undefined,
  pb.tendency as never, { archetype: quickProfileToLimperArchetype('CALLING_STATION'), confidence: pb.confidence } as never,
  (behaviorProfileOf({ playerId: villain.id, archetype: 'CALLING_STATION' as never }) ?? null) as never, betIndex);
const arrival = (built.rangeBeforeAction ?? built.range)!;
const tendencies = responseTendenciesOf(
  pb.tendency === null ? null : (pb.tendency.dimension.dimensions as never), pb.confidence, null);
const betFacts = buildBettingRangeFacts({
  arrivalEntries: arrival.entries.map((e: any) => ({ cardIndices: e.combo.cardIndices, probability: e.probability })),
  board, heroHole: hero.holeCards!, potChips: currentPot - state.currentBet, betChips: state.currentBet,
  street: 'RIVER', tendencies,
});
if (betFacts === null) { console.log('拿不到下注范围'); process.exit(1); }

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const pad = (s: string, w: number): string => {
  const len = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, w - len));
};

line('='.repeat(126));
line(' 任务二：名义加注额不同、**实际可争夺额相同** ⇒ 概率/条件权益/EV 必须完全一致');
line('='.repeat(126));
line(`  底池 ${n(currentPot, 0)}｜Hero 本街已投 ${n(heroStreetCommitted, 0)}｜对手本街已投 ${n(villainStreetCommitted, 0)}｜对手剩余 ${n(villain.remainingStack, 0)}`);
line(`  下注范围组合数 ${betFacts.entries.length}`);
line('');
line('  ' + pad('名义加注至', 12) + pad('我方新增', 10) + pad('他补', 7) + pad('留在池中', 10) + pad('退回', 7) +
  pad('终池', 7) + pad('P(弃)', 10) + pad('P(跟)', 10) + pad('P(再加)', 10) + pad('EqVsRaiseCall', 14) + 'RAISE EV');
line('  ' + '-'.repeat(122));

const rows: { to: number; f: number; c: number; rr: number; eq: number; ev: number; contested: number; finalPot: number }[] = [];
for (const raiseTo of [120, 130, 150, 173, 174]) {
  const heroAdd = raiseTo - heroStreetCommitted;
  const villainAddRaw = Math.max(0, raiseTo - villainStreetCommitted);
  const villainAdd = Math.min(villainAddRaw, villain.remainingStack);
  const villainStreetTotalAfter = villainStreetCommitted + villainAdd;
  const heroContestedAdd = Math.max(0, Math.min(heroAdd, villainStreetTotalAfter - heroStreetCommitted));
  const finalPot = currentPot + heroContestedAdd + villainAdd;
  const res = buildRaiseResponse({
    betRangeEntries: betFacts.entries, board, currentPot, heroAdd, villainAdd, heroContestedAdd, finalPot,
    street: 'RIVER', tendencies,
    heroIsAllIn: raiseTo >= 174 - 1e-9,
    villainIsAllInByCall: villain.remainingStack <= villainAdd + 1e-9,
  });
  if (res === null) { line('  ' + pad(String(raiseTo), 12) + '（模型返回 null）'); continue; }
  const eqOut = computeEquity(hero.holeCards!, board,
    [{ label: 'call-bucket', combos: res.callContinueEntries.map((e) => [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const) }],
    { mode: EquityComputeMode.FAST, seed: SEED + 1601, iterations: 6000, opponentWeights: [res.callContinueEntries.map((e) => e.probability)] });
  const eq = eqOut.ok ? eqOut.result.equity : null;
  const ev = eq === null ? null : raiseEVOf({
    foldLikelihood: res.foldLikelihood, callLikelihood: res.callLikelihood, reRaiseLikelihood: res.reRaiseLikelihood,
    currentPot, heroContestedAdd, finalPot, equityVsRaiseCall: eq,
  });
  rows.push({ to: raiseTo, f: res.foldLikelihood, c: res.callLikelihood, rr: res.reRaiseLikelihood, eq: eq ?? NaN, ev: ev ?? NaN, contested: heroContestedAdd, finalPot });
  line('  ' + pad(String(raiseTo), 12) + pad(n(heroAdd, 0), 10) + pad(n(villainAdd, 0), 7) + pad(n(heroContestedAdd, 0), 10) +
    pad(n(heroAdd - heroContestedAdd, 0), 7) + pad(n(finalPot, 0), 7) +
    pad(n(res.foldLikelihood, 6), 10) + pad(n(res.callLikelihood, 6), 10) + pad(n(res.reRaiseLikelihood, 6), 10) +
    pad(n(eq, 6), 14) + n(ev, 6));
}

line('');
const base = rows[0]!;
let allSame = true;
for (const r of rows.slice(1)) {
  const same = Math.abs(r.f - base.f) < 1e-12 && Math.abs(r.c - base.c) < 1e-12 && Math.abs(r.rr - base.rr) < 1e-12 &&
    Math.abs(r.eq - base.eq) < 1e-12 && Math.abs(r.ev - base.ev) < 1e-12 &&
    r.contested === base.contested && r.finalPot === base.finalPot;
  if (!same) allSame = false;
}
line(allSame
  ? '  ⇒ ✔ 全部名义金额给出**完全相同**的概率、条件权益与 EV（退回筹码没有被计入成本或收益）'
  : '  ⇒ 🔴 存在差异（见上表）—— 退回筹码可能被计入了成本或收益');
line('');
line('  【资金守恒核对】');
for (const r of rows) {
  line(`     名义 ${pad(String(r.to), 4)}：终池 ${r.finalPot} = 底池 ${currentPot} + 留在池中 ${r.contested} + 他补 ${r.finalPot - currentPot - r.contested}` +
    `｜退回 ${r.to - r.contested}（不进池、不计成本）`);
}
line('');
line('  【弃牌分支】他弃牌 ⇒ 我赢下当前底池（含他这一注），退回 0：EV_fold = +' + n(currentPot, 0));
line('  【跟注分支】EV_call = EqVsRaiseCall × 终池 − **留在池中的**投入（不是名义新增）');
line('='.repeat(126));
