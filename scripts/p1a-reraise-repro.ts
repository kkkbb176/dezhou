/**
 * ============================================================================
 * P1-2a 最小确定性复现（**修复前**独立复现，不依赖审计报告的结论）
 * ============================================================================
 *
 * 节点 = 仓库既有夹具 `test/raiseEvCashflowP0.test.ts` 的 P0-7：
 *   Hero BTN 100BB A♠K♠｜BB **30BB**｜6-max
 *   UTG/HJ/CO 弃｜BTN 加注 3BB｜SB 弃｜BB 跟注            → 底池 13
 *   翻牌 BB 过、BTN 2.5BB、BB 跟                        → 底池 23
 *   转牌 BB 过、BTN 7.5BB、BB 跟                        → 底池 53
 *   河牌 BB 下注 10BB（= 20 筹码）
 *
 * 要证明的三件事（**引擎级**，不靠推断）：
 *   ① 模型给出的 P(再加注) > 0；
 *   ② 但他为了跟我的加注**必须投光全部剩余筹码**（跟注即全下）；
 *   ③ 他全下跟注之后**下注轮结束**，引擎**拒绝**他再加注 ⇒ 该分支不可能存在。
 *
 * 只读：不修改任何产品代码。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { applyAction, canRaise, minBetAmount } from '../src/domain/poker/engine.ts';
import { committedThisStreet, computePot, minRaiseTo, requiredCallAmount } from '../src/domain/poker/gameState.ts';
import { computeLayeredPot } from '../src/domain/poker/pots.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_261_014, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A = (position: string, type: string, amountBB?: number, street?: string) => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/** P0-7 夹具：BB 只有 30BB */
function p07Node(bbStackBB = 30): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'],
    board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: bbStackBB },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: bbStackBB },
  } as unknown as ManualHandInput;
}

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v: unknown, d = 3): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');

line('='.repeat(112));
line(' P1-2a 复现：对手「跟注即全下」时，模型是否仍然生成再加注分支？');
line('='.repeat(112));

/* ---------- ① 生产输出 ---------- */
const decided = analyzeManualHand(p07Node(), OPTIONS);
if (!decided.ok) { line(`分析失败：${decided.stage} ${JSON.stringify(decided.issues)}`); process.exit(1); }
const D = decided.decision as unknown as Record<string, any>;
const DG = D['diagnostics'] as Record<string, any>;
const F = ((DG['postflop'] ?? {})['raiseResponse'] ?? null) as Record<string, any> | null;
line(`  最终动作 = ${String(D['action'])}${D['sizeChips'] == null ? '' : ` @ ${String(D['sizeChips'])}`}`);
if (F === null) { line('  本节点没有加注响应事实 ⇒ 复现前提不成立'); process.exit(1); }
line(`  模型事实：加注至 ${n(F['sizeChips'], 0)}｜heroAdd ${n(F['heroAdd'], 0)}｜villainAdd ${n(F['villainAdd'], 0)}` +
  `｜heroContestedAdd ${n(F['heroContestedAdd'], 0)}｜finalPot ${n(F['finalPot'], 0)}｜uncalledReturn ${n(F['uncalledReturn'], 0)}`);
line(`  模型概率：P(弃) ${pct(F['foldLikelihood'])}｜P(跟) ${pct(F['callLikelihood'])}｜**P(再加注) ${pct(F['reRaiseLikelihood'])}**`);
line(`  RAISE EV = ${n(F['raiseEV'], 4)}｜eqVsRaiseCall = ${n(F['heroEquityVsRaiseCallRange'], 4)}`);

/* ---------- ② 引擎状态：他到底还剩多少？ ---------- */
const parsed = parseManualInput(p07Node());
if (!parsed.ok) { line(`解析失败`); process.exit(1); }
const gate = buildAnalyzableState(parsed.value);
if (!gate.ok) { line(`重建失败：${JSON.stringify(gate.issues)}`); process.exit(1); }
let state = gate.state;
const hero = state.players.find((p) => p.id === state.userPlayerId)!;
const villain = state.players.find((p) => p.id !== state.userPlayerId && !p.folded)!;

line('');
line('  【决策点状态】');
line(`    底池 ${n(computePot(state), 0)}｜Hero 本街已投 ${n(committedThisStreet(state, hero.id), 0)}｜对手本街已投 ${n(committedThisStreet(state, villain.id), 0)}`);
line(`    Hero 剩余 ${n(hero.remainingStack, 0)}｜对手剩余 ${n(villain.remainingStack, 0)}｜最小加注到 ${n(minRaiseTo(state), 0)}｜对手需跟 ${n(requiredCallAmount(state, villain.id), 0)}`);

const raiseTo = F['sizeChips'] as number;
const callAfterRaise = Math.min(raiseTo - committedThisStreet(state, villain.id), villain.remainingStack);
line(`    ⇒ Hero 加注至 ${n(raiseTo, 0)}：对手要跟 ${n(raiseTo - committedThisStreet(state, villain.id), 0)}，` +
  `但只剩 ${n(villain.remainingStack, 0)} ⇒ 实际只能补 **${n(callAfterRaise, 0)}**（= 全部剩余 ⇒ 跟注即全下）`);

/* ---------- ③ 引擎级：Hero 加注 → 对手全下跟注 → 他还能加注吗？ ---------- */
line('');
line('  【引擎级重放】');
const r1 = applyAction(state, { playerId: hero.id, type: 'RAISE', amount: raiseTo } as never);
line(`    Hero RAISE ${n(raiseTo, 0)} ⇒ ${r1.ok ? '接受' : `拒绝 ${JSON.stringify(r1.issues?.[0]?.code)}`}`);
if (!r1.ok) { line('    无法重放；复现终止'); process.exit(1); }
state = r1.state;
const villainNow = state.players.find((p) => p.id === villain.id)!;
line(`    轮到他行动：actorOnTurn = ${String((state as unknown as Record<string, unknown>)['__actor'] ?? '')}` +
  `（引擎内部 pendingQueue 已重开行动）｜他需要补 ${n(requiredCallAmount(state, villain.id), 0)}｜剩余 ${n(villainNow.remainingStack, 0)}`);
const r2 = applyAction(state, { playerId: villain.id, type: 'CALL', amount: callAfterRaise } as never);
line(`    他 CALL ${n(callAfterRaise, 0)} ⇒ ${r2.ok ? '接受' : `拒绝 ${JSON.stringify(r2.issues?.[0]?.code)}`}`);
if (!r2.ok) { line('    无法重放；复现终止'); process.exit(1); }
state = r2.state;
const villainAfter = state.players.find((p) => p.id === villain.id)!;
line(`    他：allIn = ${String(villainAfter.allIn)}｜剩余筹码 = ${n(villainAfter.remainingStack, 0)}`);
const pot = computeLayeredPot(state);
line(`    底池核对：computePot = ${n(computePot(state), 0)}｜可争夺 contested = ${n(pot.contested, 0)}` +
  `｜退回 ${JSON.stringify(pot.returned)}`);
line(`    模型口径：finalPot = ${n(F['finalPot'], 0)}（应等于 contested）｜uncalledReturn = ${n(F['uncalledReturn'], 0)}（应等于退回给 Hero 的部分）`);

const r3 = applyAction(state, { playerId: villain.id, type: 'RAISE', amount: raiseTo * 2 } as never);
line(`    他再 RAISE ⇒ ${r3.ok ? '🔴 竟然被接受' : `**被引擎拒绝**：${String(r3.issues?.[0]?.code)}`}`);
line(`    canRaise(他) = ${String(canRaise(state, villain.id))}（加注权仍在，但牌局已结束：他无法再行动）`);
line(`    minBetAmount(他) = ${n(minBetAmount(state, villainAfter), 0)}`);

/* ---------- ④ 结论 ---------- */
line('');
line('='.repeat(112));
const impossible = F['reRaiseLikelihood'] > 1e-12 && villainAfter.allIn;
line(impossible
  ? `  🔴 **复现成功（缺陷确凿）**：他跟注即全下（allIn = true、剩余 0），引擎拒绝他的任何再加注，` +
    `而模型给出 P(再加注) = ${pct(F['reRaiseLikelihood'])}。`
  : '  ✔ 未复现：模型没有给出不可能的再加注分支。');
line(`  影响量级（质量守恒恒等式）：失真 = finalPot × P(再加注) × eq(再加注桶) ≤ ` +
  `${n((F['finalPot'] as number) * (F['reRaiseLikelihood'] as number) * (F['heroEquityVsRaiseCallRange'] as number), 1)} 筹码（上界）`);
line('='.repeat(112));
