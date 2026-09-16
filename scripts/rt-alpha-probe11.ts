/**
 * rt-alpha-probe11 —— 攻击 2I（raiseClosedFor 与 deriveLegalActions 的不一致）
 *                     这是「非法动作输出」的最强候选：引擎拒绝、推导层却列出
 */

import { Position, TableSize } from '../src/domain/types.ts';
import { createGame, playerById, minRaiseTo, requiredCallAmount } from '../src/domain/poker/gameState.ts';
import { applyAction, actorOnTurn, canRaise } from '../src/domain/poker/engine.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { decideAlpha } from '../src/app/decision/decisionEngine.ts';
import { GameEnvironment } from '../src/domain/range/gameEnvironment.ts';
import { RULES, hr } from './rt-alpha-lib.ts';

function sixMax(stacks: Partial<Record<Position, number>> = {}) {
  const positions = [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB, Position.BB];
  return createGame({
    config: { tableSize: TableSize.SIX_MAX, smallBlind: 50, bigBlind: 100, ante: 0, dealerPosition: Position.BTN },
    players: positions.map((p) => ({
      id: `seat_${p}`,
      name: p,
      position: p,
      startingStack: stacks[p] ?? 10000,
    })),
    userPlayerId: `seat_${Position.BB}`,
    createdAt: '2026-09-13T00:00:00.000Z',
  });
}

function runClosedRaiseMismatch(): void {
  hr('攻击 2I：短全下关闭加注权后 —— 引擎拒绝加注，deriveLegalActions 是否仍然列出 RAISE？');

  for (const coStack of [350, 400, 450]) {
    let s = sixMax({ [Position.CO]: coStack });
    s = applyAction(s, { playerId: `seat_${Position.UTG}`, type: 'RAISE' as never, amount: 300 }).state;
    s = applyAction(s, { playerId: `seat_${Position.HJ}`, type: 'FOLD' as never }).state;
    const shortAllIn = applyAction(s, { playerId: `seat_${Position.CO}`, type: 'ALL_IN' as never });
    if (!shortAllIn.ok) {
      console.log(`  CO=${coStack}：短全下被拒`);
      continue;
    }
    s = shortAllIn.state;
    s = applyAction(s, { playerId: `seat_${Position.BTN}`, type: 'FOLD' as never }).state;
    s = applyAction(s, { playerId: `seat_${Position.SB}`, type: 'FOLD' as never }).state;
    s = applyAction(s, { playerId: `seat_${Position.BB}`, type: 'FOLD' as never }).state;

    const actor = actorOnTurn(s);
    const utg = playerById(s, `seat_${Position.UTG}`)!;
    console.log(`\n  CO 全下到 ${coStack}（最小加注到=${minRaiseTo(s)}）→ 现在轮到 ${String(actor)?.replace('seat_', '')}`);
    console.log(`     raiseClosedFor = ${JSON.stringify(s.raiseClosedFor.map((x) => x.replace('seat_', '')))}`);
    console.log(`     engine.canRaise(UTG) = ${canRaise(s, utg.id)}`);
    console.log(`     UTG 需要跟注 = ${requiredCallAmount(s, utg.id)}  当前注额 = ${s.currentBet}`);

    const legal = deriveLegalActions(s, utg);
    console.log(`     **deriveLegalActions.actions = [${legal.actions.join(',')}]**`);
    console.log(
      `     canRaise=${legal.canRaise} canCheck=${legal.canCheck} callCost=${legal.callCost} ` +
        `minRaiseToAmount=${legal.minRaiseToAmount} allInToAmount=${legal.allInToAmount}`,
    );

    for (const action of legal.actions) {
      let cmd: Parameters<typeof applyAction>[1];
      if (action === 'CALL') cmd = { playerId: utg.id, type: 'CALL' as never, amount: legal.callCost };
      else if (action === 'RAISE') cmd = { playerId: utg.id, type: 'RAISE' as never, amount: legal.minRaiseToAmount };
      else if (action === 'BET') cmd = { playerId: utg.id, type: 'BET' as never, amount: legal.minBet };
      else if (action === 'ALL_IN') cmd = { playerId: utg.id, type: 'ALL_IN' as never };
      else cmd = { playerId: utg.id, type: action as never, amount: 0 };

      const res = applyAction(s, cmd);
      const mismatch = res.ok !== legal.actions.includes(action);
      console.log(
        `       ${action.padEnd(6)} → 引擎${res.ok ? '接受 ✔' : `拒绝 ✘（${res.issues.map((i) => String(i.code)).join(',')}）`}` +
          (mismatch ? '   ← **不一致**' : ''),
      );
    }
  }
}

function runFullChainClosedRaise(): void {
  hr('攻击 2I-2：加注权已关闭的决策点 → 决策引擎会不会输出 RAISE？');

  // UTG 开池 3BB；HJ 弃牌；CO 全下 X BB（X<6 时为短全下，关闭 UTG 的加注权）
  // 然后 BTN/SB/BB 弃牌 → 轮到 UTG（Hero）
  for (const coStackBB of [4, 4.5, 5, 5.5, 6, 7]) {
    const scenario = {
      tableSize: 6 as const,
      heroPosition: Position.UTG,
      heroCards: ['As', 'Kd'] as [string, string],
      board: [] as string[],
      street: 'PREFLOP' as never,
      effectiveStackBB: 100,
      actionHistory: [
        { position: Position.UTG, type: 'RAISE' as const, amountBB: 3 },
        { position: Position.HJ, type: 'FOLD' as const },
        { position: Position.CO, type: 'ALL_IN' as const, amountBB: coStackBB },
        { position: Position.BTN, type: 'FOLD' as const },
        { position: Position.SB, type: 'FOLD' as const },
        { position: Position.BB, type: 'FOLD' as const },
      ],
      environment: 'MID_LOW_STAKES',
      villain: { stackBB: coStackBB },
    };

    const parsed = parseManualInput(scenario as never);
    if (!parsed.ok) {
      console.log(`  CO=${coStackBB}BB：PARSE 阻断 ${parsed.issues.map((i) => i.message).join(' | ')}`);
      continue;
    }
    const gate = buildAnalyzableState(parsed.value);
    if (!gate.ok) {
      console.log(`  CO=${coStackBB}BB：${gate.stage} 阻断 ${gate.issues.map((i) => i.message).join(' | ')}`);
      continue;
    }
    const built = buildDecisionContext({
      state: gate.state,
      rules: RULES,
      environment: GameEnvironment.MID_LOW_STAKES,
      asOf: 1_757_000_000_000,
    });
    const d = decideAlpha(built.context, built.legal);
    const utg = playerById(gate.state, `seat_${Position.UTG}`)!;

    console.log(
      `\n  CO 全下 ${coStackBB}BB：raiseClosedFor=${JSON.stringify(gate.state.raiseClosedFor.map((x) => x.replace('seat_', '')))} ` +
        `canRaise(UTG)=${canRaise(gate.state, utg.id)} 当前注额=${gate.state.currentBet}`,
    );
    console.log(
      `     合法=[${built.legal.actions.join(',')}]  canRaise字段=${built.legal.canRaise} ` +
        `minRaiseToAmount=${built.legal.minRaiseToAmount} allInToAmount=${built.legal.allInToAmount}`,
    );
    console.log(
      `     建议=${d.action}@${String(d.sizeChips)} 分类=${d.classification} 可执行=${d.actionable} ` +
        `权益=${d.diagnostics.math.heroEquity?.toFixed(4)} 所需=${d.diagnostics.math.requiredEquity.toFixed(4)}`,
    );

    // 验证建议的动作引擎是否真的接受
    const sizeFor = (a: string): number | undefined =>
      a === 'CALL' ? built.legal.callCost : a === 'RAISE' || a === 'BET' ? d.sizeChips : undefined;
    const res = applyAction(gate.state, {
      playerId: utg.id,
      type: d.action as never,
      ...(sizeFor(d.action) !== undefined ? { amount: sizeFor(d.action) } : {}),
    });
    console.log(`     **建议动作交给引擎 → ${res.ok ? '接受 ✔' : `拒绝 ✘ ${res.issues.map((i) => String(i.code)).join(',')}**`}`);
  }
}

/* ============================================================
 * main
 * ============================================================ */

console.log(`知识库规则数=${RULES.length}`);

runClosedRaiseMismatch();
runFullChainClosedRaise();
