/**
 * rt-alpha-probe5 —— 攻击 2G（满筹码全下应对）+ 攻击 9（性能）+ 攻击 10（UI 一致性）
 *                   + 攻击 12（rebuildPendingQueue 回归 / 加权抽样向后兼容）
 */

import { Position, Street } from '../src/domain/types.ts';
import { createGame, cloneState, playerById, computePot } from '../src/domain/poker/gameState.ts';
import { applyAction, actorOnTurn, advanceStreet } from '../src/domain/poker/engine.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { GameEnvironment } from '../src/domain/range/gameEnvironment.ts';
import { toDecisionViewModel } from '../src/viewmodels/decisionViewModel.ts';
import { DECISION_ACTION_ZH } from '../src/domain/decision/decision.types.ts';
import { computeEquity } from '../src/domain/poker/equity.ts';
import { parseCardCode } from '../src/app/manualInput/manualInput.ts';
import { RULES, analyze, fingerprint, hr, OPTS, type Scenario } from './rt-alpha-lib.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

/* ============================================================
 * 攻击 2G：满筹码单挑全下
 * ============================================================ */

function headsUpShove(heroCards: readonly [string, string], shoveBB: number, heroStackBB = 100): ManualHandInput {
  // 6 人桌：UTG 全下，HJ/CO/BTN/SB 弃牌 → Hero 在 BB 面对全下（1 名活跃对手）
  return {
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards,
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: heroStackBB,
    actionHistory: [
      { position: Position.UTG, type: 'ALL_IN', amountBB: shoveBB },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'FOLD' },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { stackBB: shoveBB },
  };
}

function runHeadsUpShove(): void {
  hr('攻击 2G：单挑满筹码全下 —— AA / KK / AKo 会不会被建议弃牌？');

  const cases: { name: string; scenario: ManualHandInput }[] = [
    { name: 'AA 面对 UTG 100BB 全下', scenario: headsUpShove(['As', 'Ad'], 100) },
    { name: 'KK 面对 UTG 100BB 全下', scenario: headsUpShove(['Kh', 'Kd'], 100) },
    { name: 'QQ 面对 UTG 100BB 全下', scenario: headsUpShove(['Qh', 'Qd'], 100) },
    { name: 'AKo 面对 UTG 100BB 全下', scenario: headsUpShove(['As', 'Kd'], 100) },
    { name: 'AA 面对 UTG 30BB 全下', scenario: headsUpShove(['As', 'Ad'], 30) },
    { name: 'AKo 面对 UTG 30BB 全下', scenario: headsUpShove(['As', 'Kd'], 30) },
    { name: '72o 面对 UTG 100BB 全下', scenario: headsUpShove(['7h', '2c'], 100) },
  ];

  for (const { name, scenario } of cases) {
    const r = analyze(scenario);
    if (!r.ok) {
      console.log(`  ${name} → 阻断(${r.stage}) ${r.issues.map((i) => i.message).join(' | ')}`);
      continue;
    }
    const m = r.decision.diagnostics.math;
    console.log(
      `  ${name}\n     底池=${m.pot} 需投入=${m.callCost} 所需权益=${(m.requiredEquity * 100).toFixed(2)}% ` +
        `估计权益=${m.heroEquity === null ? 'null' : (m.heroEquity * 100).toFixed(2)}% ` +
        `跟注EV=${m.callEV === null ? 'null' : m.callEV.toFixed(2)}\n` +
        `     动作=${r.decision.action} 可执行=${r.decision.actionable} 分类=${r.decision.classification} ` +
        `置信度=${r.decision.confidence.toFixed(4)} 档位=${r.decision.band}\n` +
        `     ViewModel 首屏=${JSON.stringify(r.viewModel.actionZh)}\n` +
        `     范围=${r.decision.diagnostics.range?.sourceKind} 组合数=${r.decision.diagnostics.range?.supportSize}`,
    );
  }
}

/* ============================================================
 * 攻击 4E：INSUFFICIENT_INFORMATION 时的 decision.action 是什么？
 * ============================================================ */

function runBlockedActionField(): void {
  hr('攻击 4E：信息不足时 decision.action 的取值（是否会被读成「建议弃牌」）');

  const scenario = headsUpShove(['As', 'Ad'], 100);
  const threeWay: ManualHandInput = {
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards: ['As', 'Kd'],
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'RAISE', amountBB: 3 },
      { position: Position.HJ, type: 'CALL', amountBB: 3 },
      { position: Position.CO, type: 'FOLD' },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
    ],
    environment: 'MID_LOW_STAKES',
  };

  for (const [label, s] of [
    ['三人池（3 名活跃对手）', threeWay],
  ] as const) {
    const r = analyze(s);
    if (!r.ok) continue;
    console.log(`  ${label}`);
    console.log(`     decision.action = ${r.decision.action}（中文「${DECISION_ACTION_ZH[r.decision.action]}」）`);
    console.log(`     decision.actionable = ${r.decision.actionable}`);
    console.log(`     decision.sizeChips = ${String(r.decision.sizeChips)}`);
    console.log(`     decision.confidence = ${r.decision.confidence}  分类 = ${r.decision.classification}`);
    console.log(`     ViewModel.actionZh = ${JSON.stringify(r.viewModel.actionZh)}`);
    console.log(`     ViewModel.debug.baseDecisionZh = ${JSON.stringify(r.viewModel.debug.baseDecisionZh)}`);
    console.log(`     (decision 是管线暴露给 Web /api/analyze 的字段之一)`);
  }
}

/* ============================================================
 * 攻击 9：性能
 * ============================================================ */

function perfScenarios(): { name: string; scenario: Scenario }[] {
  return [
    {
      name: '翻牌前',
      scenario: {
        tableSize: 6,
        heroPosition: Position.BB,
        heroCards: ['As', 'Kd'],
        board: [],
        street: Street.PREFLOP,
        effectiveStackBB: 100,
        actionHistory: [
          { position: Position.UTG, type: 'FOLD' },
          { position: Position.HJ, type: 'FOLD' },
          { position: Position.CO, type: 'FOLD' },
          { position: Position.BTN, type: 'RAISE', amountBB: 3 },
          { position: Position.SB, type: 'FOLD' },
        ],
        environment: 'MID_LOW_STAKES',
      },
    },
    {
      name: '翻牌',
      scenario: {
        tableSize: 6,
        heroPosition: Position.CO,
        heroCards: ['As', 'Kd'],
        board: ['Kh', '7c', '2d'],
        street: Street.FLOP,
        effectiveStackBB: 100,
        actionHistory: [
          { position: Position.UTG, type: 'FOLD' },
          { position: Position.HJ, type: 'FOLD' },
          { position: Position.CO, type: 'RAISE', amountBB: 3 },
          { position: Position.BTN, type: 'FOLD' },
          { position: Position.SB, type: 'FOLD' },
          { position: Position.BB, type: 'CALL', amountBB: 2 },
          { position: Position.BB, type: 'CHECK', street: Street.FLOP },
        ],
        environment: 'MID_LOW_STAKES',
      },
    },
    {
      name: '转牌',
      scenario: {
        tableSize: 6,
        heroPosition: Position.CO,
        heroCards: ['As', 'Kd'],
        board: ['Kh', '7c', '2d', '3s'],
        street: Street.TURN,
        effectiveStackBB: 100,
        actionHistory: [
          { position: Position.UTG, type: 'FOLD' },
          { position: Position.HJ, type: 'FOLD' },
          { position: Position.CO, type: 'RAISE', amountBB: 3 },
          { position: Position.BTN, type: 'FOLD' },
          { position: Position.SB, type: 'FOLD' },
          { position: Position.BB, type: 'CALL', amountBB: 2 },
          { position: Position.BB, type: 'CHECK', street: Street.FLOP },
          { position: Position.CO, type: 'CHECK', street: Street.FLOP },
          { position: Position.BB, type: 'CHECK', street: Street.TURN },
        ],
        environment: 'MID_LOW_STAKES',
      },
    },
    {
      name: '河牌',
      scenario: {
        tableSize: 6,
        heroPosition: Position.CO,
        heroCards: ['As', 'Kd'],
        board: ['Kh', '7c', '2d', '3s', '9h'],
        street: Street.RIVER,
        effectiveStackBB: 100,
        actionHistory: [
          { position: Position.UTG, type: 'FOLD' },
          { position: Position.HJ, type: 'FOLD' },
          { position: Position.CO, type: 'RAISE', amountBB: 3 },
          { position: Position.BTN, type: 'FOLD' },
          { position: Position.SB, type: 'FOLD' },
          { position: Position.BB, type: 'CALL', amountBB: 2 },
          { position: Position.BB, type: 'CHECK', street: Street.FLOP },
          { position: Position.CO, type: 'CHECK', street: Street.FLOP },
          { position: Position.BB, type: 'CHECK', street: Street.TURN },
          { position: Position.CO, type: 'CHECK', street: Street.TURN },
          { position: Position.BB, type: 'BET', amountBB: 10, street: Street.RIVER },
        ],
        environment: 'MID_LOW_STAKES',
      },
    },
  ];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function runPerformance(): void {
  hr('攻击 9：端到端性能 P50/P95/MAX（按街道）');

  for (const { name, scenario } of perfScenarios()) {
    // 预热
    const warm = analyze(scenario);
    if (!warm.ok) {
      console.log(`  ${name}: 预热失败 ${warm.stage}`);
      continue;
    }
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      const r = analyze(scenario);
      const dt = performance.now() - t0;
      if (!r.ok) {
        console.log(`  ${name}: 第 ${i} 次失败`);
        break;
      }
      samples.push(dt);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    console.log(
      `  ${name}: n=${samples.length} P50=${percentile(sorted, 50).toFixed(1)}ms ` +
        `P95=${percentile(sorted, 95).toFixed(1)}ms MAX=${sorted[sorted.length - 1]!.toFixed(1)}ms ` +
        `MIN=${sorted[0]!.toFixed(1)}ms`,
    );
    console.log(`     阶段耗时（最后一次）= ${JSON.stringify(warm.timings)}`);
  }

  hr('攻击 9B：病态输入（超大筹码 / 超深 SPR / 长行动历史）是否卡死或超线性');

  const deepStack = (stackBB: number, street: Street = Street.FLOP): Scenario => ({
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards: ['As', 'Ad'],
    board: street === Street.FLOP ? ['Kh', '7c', '2d'] : [],
    street,
    effectiveStackBB: stackBB,
    actionHistory:
      street === Street.FLOP
        ? [
            { position: Position.UTG, type: 'FOLD' },
            { position: Position.HJ, type: 'FOLD' },
            { position: Position.CO, type: 'RAISE', amountBB: 3 },
            { position: Position.BTN, type: 'FOLD' },
            { position: Position.SB, type: 'FOLD' },
            { position: Position.BB, type: 'CALL', amountBB: 2 },
            { position: Position.BB, type: 'CHECK', street: Street.FLOP },
          ]
        : [
            { position: Position.UTG, type: 'FOLD' },
            { position: Position.HJ, type: 'FOLD' },
            { position: Position.CO, type: 'FOLD' },
            { position: Position.BTN, type: 'RAISE', amountBB: 3 },
            { position: Position.SB, type: 'FOLD' },
          ],
    environment: 'MID_LOW_STAKES',
    // 盲注固定 100 筹码 = 1BB，因此 100BB 筹码下 ≥100BB 的开池都合法
    // 为了让超大筹码也能建局，把大盲设成与筹码无关（仍为 1BB 口径）
  });

  for (const stack of [100, 1000, 100000, 1000000, 1e9, 1e12]) {
    const t0 = performance.now();
    const r = analyze(deepStack(stack));
    const dt = performance.now() - t0;
    console.log(
      `  翻牌 effectiveStackBB=${String(stack).padEnd(14)} ${dt.toFixed(1).padStart(8)}ms → ` +
        (r.ok
          ? `动作=${r.decision.action} 底池=${r.decision.diagnostics.math.pot} ` +
            `SPR=${String(r.decision.diagnostics.math.spr)} ` +
            `权益来源=${r.decision.diagnostics.math.equitySource?.method} ` +
            `权益=${r.decision.diagnostics.math.heroEquity?.toFixed(4)} 阶段=${JSON.stringify(r.timings)}`
          : `阻断(${r.stage}) ${r.issues.map((i) => i.code).join(',')}`),
    );
  }

  hr('攻击 9B-2：翻牌前超大筹码（开池额随之放大）');
  for (const stack of [100, 1000, 100000]) {
    // 开池按 BB 单位的比例放大：用 stackBB 的 3% 开池以免超出筹码
    const open = Math.max(3, Math.min(stack / 4, 3));
    const s = deepStack(stack, Street.PREFLOP);
    (s.actionHistory as unknown as { amountBB?: number }[])[3]!.amountBB = open;
    const t0 = performance.now();
    const r = analyze(s);
    const dt = performance.now() - t0;
    console.log(
      `  翻牌前 effectiveStackBB=${String(stack).padEnd(14)} 开池=${open}BB ${dt.toFixed(1).padStart(8)}ms → ` +
        (r.ok
          ? `动作=${r.decision.action} 权益来源=${r.decision.diagnostics.math.equitySource?.method} ` +
            `权益=${r.decision.diagnostics.math.heroEquity?.toFixed(4)} 阶段=${JSON.stringify(r.timings)}`
          : `阻断(${r.stage}) ${r.issues.map((i) => i.code).join(',')}`),
    );
  }

  hr('攻击 9C：9 人桌 —— 2 名活跃对手（可分析）与 3 名（应拒绝）');
  const nineBuild = (extraCaller: boolean): Scenario => {
    const history: Scenario['actionHistory'] = [
      { position: Position.UTG, type: 'FOLD' },
      { position: Position.UTG1, type: 'FOLD' },
      { position: Position.UTG2, type: 'FOLD' },
      { position: Position.LJ, type: 'FOLD' },
      { position: Position.HJ, type: 'RAISE', amountBB: 3 },
      { position: Position.CO, type: extraCaller ? 'CALL' : 'FOLD', amountBB: extraCaller ? 3 : undefined },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'CALL', amountBB: 2 },
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
    ];
    return {
      tableSize: 9,
      heroPosition: Position.BB,
      heroCards: ['As', 'Ad'],
      board: ['Kh', '7c', '2d'],
      street: Street.FLOP,
      effectiveStackBB: 200,
      actionHistory: history.filter((a) => a.type !== 'CALL' || a.amountBB !== undefined),
      environment: 'MID_LOW_STAKES',
    };
  };
  for (const extra of [false, true]) {
    const r = analyze(nineBuild(extra));
    const label = extra ? '9 人桌 3 名活跃对手' : '9 人桌 2 名活跃对手';
    if (!r.ok) {
      console.log(`  ${label}：阻断(${r.stage}) ${r.issues.map((i) => i.code).join(',')}`);
      continue;
    }
    console.log(
      `  ${label}：${r.timings['total']}ms 动作=${r.decision.action} 可执行=${r.decision.actionable} ` +
        `分类=${r.decision.classification} 置信度=${r.decision.confidence.toFixed(4)} ` +
        `范围针对=${r.decision.diagnostics.range?.opponentPositionZh} 组合=${r.decision.diagnostics.range?.supportSize}`,
    );
  }
}

/* ============================================================
 * 攻击 10：UI 与引擎一致性
 * ============================================================ */

function runUiConsistency(): void {
  hr('攻击 10：ViewModel 是否忠实映射引擎输出（含信息不足分支）');

  const scenarios: { name: string; scenario: Scenario }[] = [
    ...perfScenarios(),
  ];

  for (const { name, scenario } of scenarios) {
    const r = analyze(scenario);
    if (!r.ok) {
      console.log(`  ${name}: 阻断`);
      continue;
    }
    const d = r.decision;
    const vm = r.viewModel;

    // 独立重算一次 ViewModel，比较是否与管线返回的一致
    const recomputed = toDecisionViewModel(d, r.warnings, r.timings);
    const same = fingerprint(recomputed) === fingerprint(vm);
    if (!same) {
      const a = JSON.parse(fingerprint(recomputed)) as Record<string, unknown>;
      const b = JSON.parse(fingerprint(vm)) as Record<string, unknown>;
      const diffKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
      const diffs: string[] = [];
      for (const k of diffKeys) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(k);
      }
      console.log(`     [幂等差异字段] ${diffs.join(', ')}`);
      for (const k of diffs) {
        console.log(`       ${k}:`);
        console.log(`         重算 = ${JSON.stringify(a[k]).slice(0, 400)}`);
        console.log(`         管线 = ${JSON.stringify(b[k]).slice(0, 400)}`);
      }
    }

    const engineActionZh = DECISION_ACTION_ZH[d.action];
    const vmSaysAction =
      d.actionable && vm.actionZh.includes(engineActionZh) ? '一致' : d.actionable ? '**不一致**' : '（不可执行分支）';

    // 尺寸：引擎 sizeChips 是否出现在 ViewModel
    const sizeOk =
      d.sizeChips === undefined
        ? vm.sizeZh === undefined
          ? '一致（都无尺寸）'
          : '**不一致**（ViewModel 有尺寸但引擎没有）'
        : vm.sizeZh !== undefined && vm.sizeZh.includes(String(d.sizeChips))
          ? '一致'
          : '**不一致**';

    console.log(
      `  ${name}: 幂等=${same ? '✔' : '✘'} 动作=${vmSaysAction} 尺寸=${sizeOk}\n` +
        `     引擎 action=${d.action} size=${String(d.sizeChips)} conf=${d.confidence} band=${d.band} cls=${d.classification}\n` +
        `     VM  actionZh=${JSON.stringify(vm.actionZh)} sizeZh=${JSON.stringify(vm.sizeZh)} ` +
        `confidenceZh=${JSON.stringify(vm.confidenceZh)} classificationZh=${JSON.stringify(vm.classificationZh)}`,
    );
  }

  hr('攻击 10B：ViewModel.debug.math 与引擎 math 的逐项对照');

  const r = analyze(perfScenarios()[1]!.scenario);
  if (r.ok) {
    const m = r.decision.diagnostics.math;
    const rows = r.viewModel.debug.math;
    console.log(`  引擎：pot=${m.pot} callCost=${m.callCost} stack=${m.myRemainingStack} eff=${m.effectiveStack} ` +
      `spr=${String(m.spr)} potOdds=${m.potOdds} reqEq=${m.requiredEquity} eq=${String(m.heroEquity)} ev=${String(m.callEV)}`);
    for (const row of rows) console.log(`    ${row.label} = ${row.value}`);
  }

  hr('攻击 10C：spr 显示与 pouter 一致性（底池为 0 时）');
  void computePot;
}

/* ============================================================
 * 攻击 12：rebuildPendingQueue 回归
 * ============================================================ */

function buildSixMax(stacks: Partial<Record<Position, number>> = {}) {
  const positions = [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB, Position.BB];
  return createGame({
    config: {
      tableSize: 6 as never,
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      dealerPosition: Position.BTN,
    },
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

function queueOf(state: ReturnType<typeof buildSixMax>): string {
  return `[${state.pendingQueue.map((id) => id.replace('seat_', '')).join(',')}]`;
}

function runQueueRegression(): void {
  hr('攻击 12A：rebuildPendingQueue —— 弃牌者定位是否在其它场景引入错误顺序');

  // 场景 1：UTG 弃牌 → 应轮到 HJ
  {
    const s = buildSixMax();
    const r = applyAction(s, { playerId: `seat_${Position.UTG}`, type: 'FOLD' as never });
    console.log(`  场景1 UTG 弃牌：ok=${r.ok} 队列=${queueOf(r.state)} 应轮到=HJ 实际=${String(actorOnTurn(r.state))?.replace('seat_', '')}`);
  }

  // 场景 2：UTG 弃牌 → HJ 弃牌 → 应轮到 CO
  {
    let s = buildSixMax();
    s = applyAction(s, { playerId: `seat_${Position.UTG}`, type: 'FOLD' as never }).state;
    s = applyAction(s, { playerId: `seat_${Position.HJ}`, type: 'FOLD' as never }).state;
    console.log(`  场景2 UTG/HJ 弃牌：队列=${queueOf(s)} 应轮到=CO 实际=${String(actorOnTurn(s))?.replace('seat_', '')}`);
  }

  // 场景 3：BTN 加注后 SB/BB 行动
  {
    let s = buildSixMax();
    for (const p of [Position.UTG, Position.HJ, Position.CO]) {
      s = applyAction(s, { playerId: `seat_${p}`, type: 'FOLD' as never }).state;
    }
    s = applyAction(s, { playerId: `seat_${Position.BTN}`, type: 'RAISE' as never, amount: 300 }).state;
    console.log(`  场景3 BTN 加注到 3BB：队列=${queueOf(s)} 应轮到=SB 实际=${String(actorOnTurn(s))?.replace('seat_', '')}`);
    s = applyAction(s, { playerId: `seat_${Position.SB}`, type: 'FOLD' as never }).state;
    console.log(`        SB 弃牌后：队列=${queueOf(s)} 应轮到=BB 实际=${String(actorOnTurn(s))?.replace('seat_', '')}`);
    const bb = playerById(s, `seat_${Position.BB}`)!;
    console.log(`        BB 需要跟注=${300 - bb.committedByStreet.PREFLOP}`);
  }

  // 场景 4：加注者自己弃牌（不可能 —— 但模拟「最后一个加注者弃牌」的路径）
  //   用 3bet 场景：UTG 开池 → BTN 3bet → UTG 弃牌 → 应轮到 SB/BB
  {
    let s = buildSixMax();
    s = applyAction(s, { playerId: `seat_${Position.UTG}`, type: 'RAISE' as never, amount: 300 }).state;
    for (const p of [Position.HJ, Position.CO]) {
      s = applyAction(s, { playerId: `seat_${p}`, type: 'FOLD' as never }).state;
    }
    s = applyAction(s, { playerId: `seat_${Position.BTN}`, type: 'RAISE' as never, amount: 900 }).state;
    console.log(`  场景4 UTG 开池/BTN 3bet：队列=${queueOf(s)} 应轮到=SB`);
    s = applyAction(s, { playerId: `seat_${Position.SB}`, type: 'FOLD' as never }).state;
    s = applyAction(s, { playerId: `seat_${Position.BB}`, type: 'FOLD' as never }).state;
    console.log(`        SB/BB 弃牌后：队列=${queueOf(s)} 应轮到=UTG 实际=${String(actorOnTurn(s))?.replace('seat_', '')}`);
    const utg = playerById(s, `seat_${Position.UTG}`)!;
    console.log(`        UTG 需要跟注=${900 - utg.committedByStreet.PREFLOP}（当前注额=${s.currentBet}）`);
    s = applyAction(s, { playerId: `seat_${Position.UTG}`, type: 'FOLD' as never }).state;
    console.log(`        UTG 弃牌后：phase=${s.phase} 队列=${queueOf(s)} winners=${JSON.stringify(s.winners)}`);
  }

  // 场景 5：短全下不重开加注权 —— 已跟平者不得再加注
  {
    let s = buildSixMax({ [Position.BTN]: 1200 }); // BTN 只有 12BB
    s = applyAction(s, { playerId: `seat_${Position.UTG}`, type: 'RAISE' as never, amount: 300 }).state;
    for (const p of [Position.HJ, Position.CO]) {
      s = applyAction(s, { playerId: `seat_${p}`, type: 'FOLD' as never }).state;
    }
    s = applyAction(s, { playerId: `seat_${Position.BTN}`, type: 'RAISE' as never, amount: 1200 }).state;
    console.log(`  场景5 BTN 短全下到 1200（加注增量 900）：队列=${queueOf(s)} raiseClosedFor=${JSON.stringify(s.raiseClosedFor.map((x) => x.replace('seat_', '')))}`);
    s = applyAction(s, { playerId: `seat_${Position.SB}`, type: 'FOLD' as never }).state;
    s = applyAction(s, { playerId: `seat_${Position.BB}`, type: 'FOLD' as never }).state;
    console.log(`        SB/BB 弃牌后：队列=${queueOf(s)} 应轮到=UTG`);
    const r = applyAction(s, { playerId: `seat_${Position.UTG}`, type: 'RAISE' as never, amount: 3000 });
    console.log(`        UTG 尝试再加注到 3000：ok=${r.ok} ${r.ok ? '' : r.issues.map((i) => String(i.code)).join(',')}`);
  }

  // 场景 6：大盲选择权 —— 全员溜入到 BB
  {
    let s = buildSixMax();
    for (const p of [Position.UTG, Position.HJ, Position.CO, Position.BTN]) {
      s = applyAction(s, { playerId: `seat_${p}`, type: 'CALL' as never, amount: 100 }).state;
    }
    s = applyAction(s, { playerId: `seat_${Position.SB}`, type: 'CALL' as never, amount: 50 }).state;
    console.log(`  场景6 全员溜入到 BB：队列=${queueOf(s)} 应轮到=BB 实际=${String(actorOnTurn(s))?.replace('seat_', '')}`);
    const r = applyAction(s, { playerId: `seat_${Position.BB}`, type: 'CHECK' as never });
    console.log(`        BB 过牌：ok=${r.ok} bettingRoundComplete=${r.state.bettingRoundComplete} 队列=${queueOf(r.state)}`);
  }

  // 场景 7：翻牌后所有位置弃牌到 BB 之前 —— 检查弃牌者定位
  {
    let s = buildSixMax();
    for (const p of [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB, Position.BB]) {
      s = applyAction(s, { playerId: `seat_${p}`, type: 'FOLD' as never }).state;
      if (s.phase === 'COMPLETE') break;
    }
    console.log(`  场景7 全员弃牌：phase=${s.phase} winners=${JSON.stringify(s.winners)}`);
  }

  // 场景 8：翻牌圈推进后行动顺序（postflopOrder 从 SB 开始）
  {
    let s = buildSixMax();
    for (const p of [Position.UTG, Position.HJ, Position.CO, Position.BTN]) {
      s = applyAction(s, { playerId: `seat_${p}`, type: 'CALL' as never, amount: 100 }).state;
    }
    s = applyAction(s, { playerId: `seat_${Position.SB}`, type: 'CALL' as never, amount: 50 }).state;
    s = applyAction(s, { playerId: `seat_${Position.BB}`, type: 'CHECK' as never }).state;
    const adv = advanceStreet(s, {
      cards: [
        { rank: 13, suit: 'h' },
        { rank: 7, suit: 'c' },
        { rank: 2, suit: 'd' },
      ] as never,
    });
    if (adv.ok) {
      console.log(`  场景8 推进到翻牌：队列=${queueOf(adv.state)} 应轮到=SB 实际=${String(actorOnTurn(adv.state))?.replace('seat_', '')}`);
      // SB 弃牌后应轮到 BB
      const r = applyAction(adv.state, { playerId: `seat_${Position.SB}`, type: 'FOLD' as never });
      console.log(`        SB 弃牌后：队列=${queueOf(r.state)} 应轮到=BB 实际=${String(actorOnTurn(r.state))?.replace('seat_', '')}`);
      const r2 = applyAction(r.state, { playerId: `seat_${Position.BB}`, type: 'CHECK' as never });
      console.log(`        BB 过牌后：队列=${queueOf(r2.state)} 应轮到=UTG 实际=${String(actorOnTurn(r2.state))?.replace('seat_', '')}`);
    } else {
      console.log(`  场景8 推进失败：${adv.issues.map((i) => String(i.code)).join(',')}`);
    }
  }
}

/* ============================================================
 * 攻击 12B：加权抽样向后兼容（逐位一致）
 * ============================================================ */

function runWeightBackCompat(): void {
  hr('攻击 12B：无权重 vs 权重全为 1 —— 是否逐位一致（向后兼容）');

  const hero = [parseCardCode('As')!, parseCardCode('Kd')!];
  const board = [parseCardCode('Kh')!, parseCardCode('7c')!, parseCardCode('2d')!];
  const combos = [
    [parseCardCode('Ah')!, parseCardCode('Ac')!],
    [parseCardCode('Qh')!, parseCardCode('Qc')!],
    [parseCardCode('Jh')!, parseCardCode('Jc')!],
    [parseCardCode('Th')!, parseCardCode('9c')!],
    [parseCardCode('8h')!, parseCardCode('7h')!],
    [parseCardCode('6h')!, parseCardCode('5c')!],
    [parseCardCode('4h')!, parseCardCode('3c')!],
    [parseCardCode('2h')!, parseCardCode('2c')!],
  ] as const;

  for (const seed of [1, 42, 20260913, 999999]) {
    const none = computeEquity(hero, board, [{ label: 'x', combos }], { seed, iterations: 20000 });
    const ones = computeEquity(hero, board, [{ label: 'x', combos }], {
      seed,
      iterations: 20000,
      opponentWeights: [combos.map(() => 1)],
    });
    const eqNone = none.ok ? none.result.equity : Number.NaN;
    const eqOnes = ones.ok ? ones.result.equity : Number.NaN;
    console.log(
      `  seed=${String(seed).padEnd(9)} 无权重=${eqNone.toFixed(10)} 全1权重=${eqOnes.toFixed(10)} ` +
        `逐位相等=${eqNone === eqOnes ? '✔' : '**✘**'}`,
    );
  }

  hr('攻击 12C：死牌过滤后权重是否同步（不错位）');

  // 让「强牌」的一部分组合与 Hero/公共牌冲突 → 看过滤后权重是否仍然对应
  const hero2 = [parseCardCode('Ah')!, parseCardCode('Kd')!];
  const board2 = [parseCardCode('Kh')!, parseCardCode('7c')!, parseCardCode('2d')!];
  const combos2 = [
    [parseCardCode('Ah')!, parseCardCode('Ac')!], // 与 Hero 的 Ah 冲突 → 应被过滤
    [parseCardCode('As')!, parseCardCode('Ac')!], // 保留
    [parseCardCode('Qh')!, parseCardCode('Qc')!], // 保留
    [parseCardCode('3h')!, parseCardCode('4c')!], // 保留
  ] as const;
  // 权重：给「会被过滤掉」的第一个组合极高权重，其余 1
  const w = [1000, 1, 1, 1];
  const r = computeEquity(hero2, board2, [{ label: 'x', combos: combos2 }], {
    seed: 42,
    iterations: 20000,
    opponentWeights: [w],
  });
  console.log(`  含被过滤组合的加权结果：${r.ok ? `权益=${r.result.equity.toFixed(6)} 组合数=${JSON.stringify(r.result.combosPerOpponent)}` : `FAIL ${r.code}`}`);
  // 对照：手动去掉第一个组合 + 去掉对应权重
  const r2 = computeEquity(hero2, board2, [{ label: 'x', combos: combos2.slice(1) }], {
    seed: 42,
    iterations: 20000,
    opponentWeights: [w.slice(1)],
  });
  console.log(`  手动对齐过滤后：${r2.ok ? `权益=${r2.result.equity.toFixed(6)} 组合数=${JSON.stringify(r2.result.combosPerOpponent)}` : `FAIL ${r2.code}`}`);
  console.log(`  两者是否逐位相同：${r.ok && r2.ok && r.result.equity === r2.result.equity ? '✔（权重同步正确）' : '**✘**'}`);
}

/* ============================================================
 * main
 * ============================================================ */

console.log(`知识库规则数=${RULES.length} asOf=${OPTS.asOf}`);
void cloneState;
void GameEnvironment;
void parseManualInput;
void buildAnalyzableState;
void buildDecisionContext;

runHeadsUpShove();
runBlockedActionField();
runPerformance();
runUiConsistency();
runQueueRegression();
runWeightBackCompat();
