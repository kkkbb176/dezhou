/**
 * rt-alpha-probe10 —— 攻击 2H（全下额不足最小加注：合法打法被拒 / 引擎漏掉 RAISE）
 */

import { Position, Street, TableSize } from '../src/domain/types.ts';
import { createGame, playerById, minRaiseTo } from '../src/domain/poker/gameState.ts';
import { applyAction, actorOnTurn } from '../src/domain/poker/engine.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { decideAlpha } from '../src/app/decision/decisionEngine.ts';
import { GameEnvironment } from '../src/domain/range/gameEnvironment.ts';
import { RULES, hr } from './rt-alpha-lib.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

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

function runEngineUnderRaise(): void {
  hr('攻击 2H-1：引擎层 —— 筹码恰好不足最小加注时，全下是否被拒？');

  // 6 人桌。UTG 开池到 300。
  // 让 HJ 的筹码处于不同档位，看「全下」是否合法。
  for (const hjStack of [400, 450, 500, 550, 600, 700, 1000]) {
    let s = sixMax({ [Position.HJ]: hjStack });
    s = applyAction(s, { playerId: `seat_${Position.UTG}`, type: 'RAISE' as never, amount: 300 }).state;

    const hj = playerById(s, `seat_${Position.HJ}`)!;
    const already = hj.committedByStreet.PREFLOP; // 0
    const remaining = hj.remainingStack;
    const allInTo = already + remaining;
    const minTo = minRaiseTo(s);

    // 引擎：直接提交全下（ALL_IN 命令）
    const asAllIn = applyAction(s, { playerId: `seat_${Position.HJ}`, type: 'ALL_IN' as never });
    // 引擎：提交等额的 RAISE
    const asRaise = applyAction(s, { playerId: `seat_${Position.HJ}`, type: 'RAISE' as never, amount: allInTo });

    // 推导层：合法动作里有没有 RAISE
    const legal = deriveLegalActions(s, hj);

    console.log(
      `  HJ 筹码=${String(hjStack).padStart(5)}  全下到=${String(allInTo).padStart(5)}  ` +
      `最小加注到=${String(minTo).padStart(5)}  不足最小加注=${allInTo < minTo ? '是' : '否'}\n` +
      `     引擎 ALL_IN：${asAllIn.ok ? '接受 ✔' : `拒绝 ✘ ${asAllIn.issues.map((i) => String(i.code)).join(',')}`}   ` +
      `引擎 RAISE：${asRaise.ok ? '接受' : `拒绝 ${asRaise.issues.map((i) => String(i.code)).join(',')}`}\n` +
      `     deriveLegalActions.actions = [${legal.actions.join(',')}]   canRaise=${legal.canRaise} ` +
      `minRaiseToAmount=${legal.minRaiseToAmount} allInToAmount=${legal.allInToAmount}`,
    );
  }
}

function runDeriveVsEngineMismatch(): void {
  hr('攻击 2H-2：deriveLegalActions vs applyAction —— 边界等价性穷举');

  // 构造一批状态：不同筹码 / 不同注额，逐条对比
  const mismatches: string[] = [];
  let checked = 0;

  for (const utgStack of [300, 400, 500, 700, 1000, 1200, 2000, 10000]) {
    for (const openTo of [200, 250, 300, 400, 700]) {
      let s = sixMax({ [Position.UTG]: utgStack });
      const open = applyAction(s, { playerId: `seat_${Position.UTG}`, type: 'RAISE' as never, amount: openTo });
      if (!open.ok) continue;
      s = open.state;
      // 现在轮到 HJ
      const hj = playerById(s, `seat_${Position.HJ}`)!;
      const legal = deriveLegalActions(s, hj);
      checked += 1;

      const attempts: { label: string; cmd: Parameters<typeof applyAction>[1] }[] = [
        { label: 'FOLD', cmd: { playerId: hj.id, type: 'FOLD' as never } },
        { label: 'CHECK', cmd: { playerId: hj.id, type: 'CHECK' as never } },
        { label: 'CALL', cmd: { playerId: hj.id, type: 'CALL' as never, amount: legal.callCost } },
        { label: 'BET', cmd: { playerId: hj.id, type: 'BET' as never, amount: legal.minBet } },
        { label: 'RAISE@minTo', cmd: { playerId: hj.id, type: 'RAISE' as never, amount: legal.minRaiseToAmount } },
        { label: 'RAISE@allInTo', cmd: { playerId: hj.id, type: 'RAISE' as never, amount: legal.allInToAmount } },
        { label: 'ALL_IN', cmd: { playerId: hj.id, type: 'ALL_IN' as never } },
      ];

      for (const a of attempts) {
        const accepted = applyAction(s, a.cmd).ok;
        const derived = legal.actions.includes(a.label.split('@')[0] as never);
        if (accepted !== derived) {
          mismatches.push(
            `UTG筹码=${utgStack} 开池到=${openTo} | ${a.label}: ` +
              `applyAction=${accepted ? '接受' : '拒绝'} deriveLegalActions=${derived ? '列出' : '未列出'}`,
          );
        }
      }
    }
  }

  console.log(`  检查过的状态数 = ${checked}（每个 7 种动作尝试）`);
  console.log(`  不一致数 = ${mismatches.length}`);
  for (const m of mismatches.slice(0, 30)) console.log(`   · ${m}`);
}

function runPipelineUnderRaise(): void {
  hr('攻击 2H-3：端到端 —— 用户录入合法的短筹码全下加注时会发生什么');

  // UTG 开池 3BB；HJ 只有 5BB，全下到 5BB（< 最小加注 6BB）
  const scenario: ManualHandInput = {
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards: ['As', 'Kd'],
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'RAISE', amountBB: 3 },
      { position: Position.HJ, type: 'ALL_IN', amountBB: 5 },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { stackBB: 5 },
  };
  const r = analyzeManually(scenario);
  console.log(`  录入「UTG 开池 3BB → HJ 全下 5BB（< 最小加注 6BB）」`);
  console.log(`     → ${r}`);

  // 对照：HJ 全下到 6BB（正好最小加注）
  const ok: ManualHandInput = {
    ...scenario,
    actionHistory: [
      { position: Position.UTG, type: 'RAISE', amountBB: 3 },
      { position: Position.HJ, type: 'ALL_IN', amountBB: 6 },
    ],
    villain: { stackBB: 6 },
  };
  console.log(`  录入「UTG 开池 3BB → HJ 全下 6BB（= 最小加注）」`);
  console.log(`     → ${analyzeManually(ok)}`);
}

function analyzeManually(scenario: ManualHandInput): string {
  const parsed = parseManualInput(scenario);
  if (!parsed.ok) return `PARSE 阻断：${parsed.issues.map((i) => i.message).join(' | ')}`;
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) return `${gate.stage} 阻断：${gate.issues.map((i) => i.message).join(' | ')}`;
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: GameEnvironment.MID_LOW_STAKES,
    asOf: 1_757_000_000_000,
  });
  const d = decideAlpha(built.context, built.legal);
  return (
    `可分析：动作=${d.action} 可执行=${d.actionable} 底池=${d.diagnostics.math.pot} ` +
    `需投入=${d.diagnostics.math.callCost} 合法=[${built.legal.actions.join(',')}]`
  );
}

/* ============================================================
 * 2H-4：Hero 自己筹码不足以最小加注时能否全下
 * ============================================================ */

function runHeroShortAllIn(): void {
  hr('攻击 2H-4：Hero 筹码不足以最小加注时，能否全下？（deriveLegalActions 漏 RAISE）');

  for (const heroStack of [4, 5, 5.5, 6, 7, 8]) {
    const scenario: ManualHandInput = {
      tableSize: 6,
      heroPosition: Position.BB,
      heroCards: ['As', 'Kd'],
      board: [],
      street: Street.PREFLOP,
      effectiveStackBB: heroStack,
      actionHistory: [
        { position: Position.UTG, type: 'FOLD' },
        { position: Position.HJ, type: 'FOLD' },
        { position: Position.CO, type: 'FOLD' },
        { position: Position.BTN, type: 'RAISE', amountBB: 3 },
        { position: Position.SB, type: 'FOLD' },
      ],
      environment: 'MID_LOW_STAKES',
    };
    const parsed = parseManualInput(scenario);
    if (!parsed.ok) {
      console.log(`  Hero ${heroStack}BB：PARSE 阻断`);
      continue;
    }
    const gate = buildAnalyzableState(parsed.value);
    if (!gate.ok) {
      console.log(`  Hero ${heroStack}BB：${gate.stage} 阻断 ${gate.issues.map((i) => i.code).join(',')}`);
      continue;
    }
    const built = buildDecisionContext({
      state: gate.state,
      rules: RULES,
      environment: GameEnvironment.MID_LOW_STAKES,
      asOf: 1_757_000_000_000,
    });
    const legal = built.legal;
    const d = decideAlpha(built.context, legal);
    // 尝试真的全下
    const allIn = applyAction(gate.state, { playerId: `seat_${Position.BB}`, type: 'ALL_IN' as never });
    console.log(
      `  Hero ${String(heroStack).padEnd(4)}BB：callCost=${legal.callCost} 剩余=${legal.myRemainingStack} ` +
        `allInTo=${legal.allInToAmount} minRaiseTo=${legal.minRaiseToAmount}\n` +
        `     合法=[${legal.actions.join(',')}] 建议=${d.action}@${String(d.sizeChips)}\n` +
        `     applyAction(ALL_IN) = ${allIn.ok ? '接受' : `拒绝 ${allIn.issues.map((i) => String(i.code)).join(',')}`}`,
    );
  }
}

/* ============================================================
 * 2H-5：短全下关闭加注权（TDA）路径是否可达
 * ============================================================ */

function runShortAllInClosesRaising(): void {
  hr('攻击 2H-5：短全下关闭加注权（TDA）路径是否可达');

  // UTG 开池 300。CO 只有 400 筹码 → 全下到 400（增量 100 < 最小加注 200）。
  // 但 400 < minRaiseTo=600 → 引擎应拒绝。逐档测试。
  for (const coStack of [350, 400, 450, 500, 550, 600]) {
    let s = sixMax({ [Position.CO]: coStack });
    s = applyAction(s, { playerId: `seat_${Position.UTG}`, type: 'RAISE' as never, amount: 300 }).state;
    s = applyAction(s, { playerId: `seat_${Position.HJ}`, type: 'FOLD' as never }).state;
    const co = playerById(s, `seat_${Position.CO}`)!;
    const res = applyAction(s, { playerId: co.id, type: 'ALL_IN' as never });
    const legal = deriveLegalActions(s, co);
    console.log(
      `  CO 筹码=${String(coStack).padStart(4)} 全下到=${coStack} minRaiseTo=${minRaiseTo(s)} → ` +
        `引擎=${res.ok ? `接受 新注额=${res.state.currentBet} raiseClosedFor=${JSON.stringify(res.state.raiseClosedFor.map((x) => x.replace('seat_', '')))}` : `拒绝 ${res.issues.map((i) => String(i.code)).join(',')}`}\n` +
        `     deriveLegalActions=[${legal.actions.join(',')}]`,
    );
  }
}

/* ============================================================
 * main
 * ============================================================ */

console.log(`知识库规则数=${RULES.length}`);
void actorOnTurn;
void Street;

runEngineUnderRaise();
runDeriveVsEngineMismatch();
runPipelineUnderRaise();
runHeroShortAllIn();
runShortAllInClosesRaising();
