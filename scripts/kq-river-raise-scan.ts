/**
 * ============================================================================
 * 参考扫描（**非生产口径**）：K♠Q♠ 河牌节点上**每一个**合法加注尺寸的响应与 EV
 * ============================================================================
 *
 * ## 为什么需要它（以及它为什么不算产品输出）
 *
 * 生产引擎只对**一个**尺寸算 EV（目标尺寸 = `pot + 2×call` 的最近候选），
 * 其余金额一律如实列入「未评估动作」。因此「最佳加注尺寸」在产品口径下
 * **只有一个数**。本脚本用**同一个响应模型 + 同一套资金口径**把每个尺寸都算一遍，
 * 目的是回答「换个尺寸会不会更好」——但它是**审计口径**，不是产品会给出的建议。
 *
 * ⚠️ 三条限制（不得忽略）：
 * 1. 逐尺寸的权益都是**重新抽样**（同一固定种子），与产品只算一个尺寸的口径相同但独立；
 * 2. 再加注分支仍是**下界**（`−我方投入`）；
 * 3. 响应系数**未经校准**（U1 残余 ①）⇒ 本表只用于比较尺寸之间的**相对**关系。
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
import { computePot } from '../src/domain/poker/gameState.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { quickProfileToLimperArchetype } from '../src/app/manualInput/limpIsolation.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { ALL_CARDS, parseCardStrict } from '../src/domain/poker/cards.ts';
import type { Card } from '../src/domain/types.ts';
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

const input: ManualHandInput = {
  tableSize: 6, heroPosition: 'BTN', heroCards: ['Ks', 'Qs'],
  board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
  effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  actionHistory: [
    A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
    A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
    A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
    A('BB', 'BET', 10, 'RIVER'),
  ],
  environment: 'MID_LOW_STAKES',
  villain: {
    playerId: '老周', quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 100,
    observedStats: {
      handsObserved: 1200, vpip: 0.49, pfr: 0.09, threeBet: 0.03, wtsd: 0.42,
      foldToFlopCBet: 0.23, foldToTurnCBet: 0.19, foldToRiverBet: 0.16,
      flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: 0.02,
    },
  },
} as unknown as ManualHandInput;

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v: unknown, d = 1): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const pad = (s: string, w: number): string => {
  const len = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, w - len));
};

/* ---------- 1. 生产决策（拿目标尺寸与产品 EV 作对照） ---------- */
const decided = analyzeManualHand(input, OPTIONS);
if (!decided.ok) { line(`分析失败：${decided.stage} ${JSON.stringify(decided.issues)}`); process.exit(1); }
const dgAll = (decided.decision as unknown as Record<string, any>)['diagnostics'] as Record<string, any>;
const pf = (dgAll['postflop'] ?? {}) as Record<string, any>;
const prodFacts = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
const cands = (dgAll['candidates'] ?? []) as Record<string, any>[];
const sizes = cands.filter((c) => c['action'] === 'RAISE' || c['action'] === 'ALL_IN')
  .map((c) => c['sizeChips'] as number).filter((x) => x > 0).sort((a, b) => a - b);

/* ---------- 2. 取「他下注范围」的逐组合权重（与生产同源） ---------- */
const parsed = parseManualInput(input);
if (!parsed.ok) { line(`解析失败：${JSON.stringify(parsed.issues)}`); process.exit(1); }
const gate = buildAnalyzableState(parsed.value);
if (!gate.ok) { line(`重建失败：${JSON.stringify(gate.issues)}`); process.exit(1); }
const state = gate.state;
const board: Card[] = input.board.map(parseCardStrict);
const hero = state.players.find((p) => p.id === state.userPlayerId)!;
const villain = state.players.find((p) => p.id !== state.userPlayerId && !p.folded)!;
const currentPot = computePot(state);
const heroStreetCommitted = hero.committedByStreet[state.street];
const villainStreetCommitted = villain.committedByStreet[state.street];

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
if (betFacts === null) { line('拿不到下注范围 ⇒ 无法扫描'); process.exit(1); }

line('='.repeat(120));
line(' 参考扫描（非生产口径）：每个合法加注尺寸的响应与 RAISE EV ｜ Hero K♠Q♠ vs 老周（跟注站）');
line('='.repeat(120));
line(`  底池 ${n(currentPot, 0)}｜Hero 本街已投 ${n(heroStreetCommitted, 0)}｜对手本街已投 ${n(villainStreetCommitted, 0)}｜对手剩余 ${n(villain.remainingStack, 0)}`);
line(`  下注范围组合数 ${betFacts.entries.length}｜对手倾向 callScale=${n((tendencies as any).callScale, 3)} foldScale=${n((tendencies as any).foldScale, 3)} raiseScale=${n((tendencies as any).raiseScale, 3)}`);
line('');
line('  ' + pad('加注至', 9) + pad('我方新增', 10) + pad('他补', 8) + pad('终池', 9) + pad('他要的权益', 12) +
  pad('P(弃)', 9) + pad('P(跟)', 9) + pad('P(再加注)', 11) + pad('EqVsRaiseCall', 14) + pad('RAISE EV', 11) + '备注');
line('  ' + '-'.repeat(114));

let best: { to: number; ev: number } | null = null;
for (const raiseTo of sizes) {
  const heroAdd = raiseTo - heroStreetCommitted;
  const villainAdd = Math.min(raiseTo - villainStreetCommitted, villain.remainingStack);
  const villainStreetTotalAfter = villainStreetCommitted + villainAdd;
  const heroContestedAdd = Math.max(0, Math.min(heroAdd, villainStreetTotalAfter - heroStreetCommitted));
  const finalPot = currentPot + heroContestedAdd + villainAdd;
  const res = buildRaiseResponse({
    betRangeEntries: betFacts.entries, board, currentPot, heroAdd, villainAdd, heroContestedAdd, finalPot,
    street: 'RIVER', tendencies, heroIsAllIn: raiseTo >= (dgAll['actionShape'] as any)['allInToAmount'] - 1e-9,
  });
  if (res === null) { line('  ' + pad(String(raiseTo), 9) + '（模型返回 null）'); continue; }
  const eqOut = computeEquity(hero.holeCards!, board,
    [{ label: 'kq-call', combos: res.callContinueEntries.map((e) => [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const) }],
    { mode: EquityComputeMode.FAST, seed: SEED + 1601, iterations: 20000, opponentWeights: [res.callContinueEntries.map((e) => e.probability)] });
  const eq = eqOut.ok ? eqOut.result.equity : null;
  const ev = eq === null ? null : raiseEVOf({
    foldLikelihood: res.foldLikelihood, callLikelihood: res.callLikelihood, reRaiseLikelihood: res.reRaiseLikelihood,
    currentPot, heroContestedAdd, finalPot, equityVsRaiseCall: eq,
  });
  const isProd = prodFacts !== null && Math.abs(raiseTo - (prodFacts['sizeChips'] as number)) < 1e-9;
  if (ev !== null && (best === null || ev > best.ev)) best = { to: raiseTo, ev };
  line('  ' + pad(String(raiseTo), 9) + pad(n(heroAdd, 0), 10) + pad(n(villainAdd, 0), 8) + pad(n(finalPot, 0), 9) +
    pad(n(res.model.priceRequiredEquity, 4), 12) +
    pad(pct(res.foldLikelihood), 9) + pad(pct(res.callLikelihood), 9) + pad(pct(res.reRaiseLikelihood), 11) +
    pad(eq === null ? '—' : n(eq, 4), 14) + pad(ev === null ? '—' : n(ev, 2), 11) +
    (isProd ? '← 生产引擎评估的尺寸' : '（生产未评估）'));
}

const m = (dgAll['math'] as Record<string, any>);
line('');
line('  ' + '-'.repeat(114));
line(`  FOLD EV = 0.00｜CALL EV = ${n(m['callEV'], 2)}（EqVsBetRange ${n(m['heroEquityVsBetRange'], 4)} × winnable ${n(m['winnable'], 0)} − ${n(m['callCost'], 0)}）`);
const bestEv = best as { to: number; ev: number } | null;
line(`  扫描出的最高 RAISE EV：${bestEv === null ? '—' : `加注至 ${bestEv.to} ⇒ ${n(bestEv.ev, 2)} 筹码`}` +
  `｜生产口径的加注 EV：${prodFacts === null ? '—' : `${n(prodFacts['raiseEV'], 2)}（加注至 ${n(prodFacts['sizeChips'], 0)}）`}`);
if (bestEv !== null) {
  const gap = bestEv.ev - (m['callEV'] as number);
  line(`  最高 RAISE EV 与 CALL EV 的差距 = ${n(gap, 2)} 筹码 ⇒ ` +
    (gap > 0 ? '**正**（扫描口径下加注优于跟注）' : '**负**（跟注仍更好）') +
    `｜跨动作容差带 = ±${n(0.05 * (m['winnable'] as number), 2)}`);
}
line('');
line('  ⚠️ 本表是**审计口径**：逐尺寸重新抽样权益（同一种子）+ 再加注分支取下界 + 响应系数未校准。');
line('     产品在生产路径上**只**对它选中的那个尺寸给出 EV，其余金额如实列为「未评估动作」。');
line('='.repeat(120));
