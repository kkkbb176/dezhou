/**
 * rt-alpha-probe2 —— 攻击 2（非法动作穷举）+ 攻击 3（输入静默纠正）
 *
 * 方法：对每个场景，取出决策引擎输出的动作 + 尺寸，
 * 构造对应的真实 ActionCommand 交给 `applyAction`；
 * **引擎必须接受**。任何被拒绝的输出 = 「界面给了一个打不出来的建议」。
 *
 * 同时检查：
 * - 输出动作是否越出 legal.actions
 * - RAISE 是否**永远不可达**（面对下注时只会 CALL/FOLD）
 * - 尺寸是否 < 最小下注 / > 剩余筹码 / < 最小加注
 * - CALL 在无人下注时是否出现
 * - 全下跟注时动作被标成 CALL 而非 ALL_IN（界面/日志口径）
 */

import { Position, Street } from '../src/domain/types.ts';
import { applyAction, actorOnTurn, minBetAmount } from '../src/domain/poker/engine.ts';
import { requiredCallAmount, computePot, minRaiseTo } from '../src/domain/poker/gameState.ts';
import { buildSizeGrid } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { decideAlpha } from '../src/app/decision/decisionEngine.ts';
import { GameEnvironment } from '../src/domain/range/gameEnvironment.ts';
import { RULES, analyze, hr, show, type Scenario } from './rt-alpha-lib.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

/* ============================================================
 * 场景库（刻意自己构造，不复用作者夹具）
 * ============================================================ */

type Named = { name: string; scenario: Scenario };

const BASE_HISTORY_PREFLOP = [
  { position: Position.UTG, type: 'FOLD' as const },
  { position: Position.HJ, type: 'FOLD' as const },
];

/** Hero 在 CO，BB 3bet → Hero 面对 3bet */
function heroVs3Bet(heroCards: readonly [string, string], stackBB = 100): Scenario {
  return {
    tableSize: 6,
    heroPosition: Position.CO,
    heroCards,
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: stackBB,
    actionHistory: [
      { position: Position.UTG, type: 'FOLD' },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'RAISE', amountBB: 3 },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'RAISE', amountBB: 10 },
    ],
    environment: 'MID_LOW_STAKES',
  };
}

/** Hero 在 BB，BTN 开池 → Hero 面对开池（可弃/跟/加） */
function bbVsOpen(heroCards: readonly [string, string], stackBB = 100, openBB = 3): Scenario {
  return {
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards,
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: stackBB,
    actionHistory: [
      { position: Position.UTG, type: 'FOLD' },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'FOLD' },
      { position: Position.BTN, type: 'RAISE', amountBB: openBB },
      { position: Position.SB, type: 'FOLD' },
    ],
    environment: 'MID_LOW_STAKES',
  };
}

/** 翻牌：Hero CO 开池，BB 跟注，BB 在翻牌领先下注 betBB → Hero 面对下注 */
function flopFacingBet(
  heroCards: readonly [string, string],
  board: readonly string[],
  betBB: number,
  stackBB = 100,
): Scenario {
  return {
    tableSize: 6,
    heroPosition: Position.CO,
    heroCards,
    board,
    street: Street.FLOP,
    effectiveStackBB: stackBB,
    actionHistory: [
      ...BASE_HISTORY_PREFLOP,
      { position: Position.CO, type: 'RAISE', amountBB: 3 },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'CALL', amountBB: 2 },
      { position: Position.BB, type: 'BET', amountBB: betBB, street: Street.FLOP },
    ],
    environment: 'MID_LOW_STAKES',
  };
}

/** 河牌：Hero CO 开池，BB 跟注；三条街过牌；BB 河牌大注 → Hero 面对下注 */
function riverFacingBet(
  heroCards: readonly [string, string],
  board: readonly string[],
  betBB: number,
  stackBB = 100,
): Scenario {
  return {
    tableSize: 6,
    heroPosition: Position.CO,
    heroCards,
    board,
    street: Street.RIVER,
    effectiveStackBB: stackBB,
    actionHistory: [
      ...BASE_HISTORY_PREFLOP,
      { position: Position.CO, type: 'RAISE', amountBB: 3 },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'CALL', amountBB: 2 },
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      { position: Position.CO, type: 'CHECK', street: Street.FLOP },
      { position: Position.BB, type: 'CHECK', street: Street.TURN },
      { position: Position.CO, type: 'CHECK', street: Street.TURN },
      { position: Position.BB, type: 'BET', amountBB: betBB, street: Street.RIVER },
    ],
    environment: 'MID_LOW_STAKES',
  };
}

/** 翻牌：Hero 在 CO，BB 过牌 → Hero 可过牌/下注 */
function flopCheckedToHero(heroCards: readonly [string, string], board: readonly string[], stackBB = 100): Scenario {
  return {
    tableSize: 6,
    heroPosition: Position.CO,
    heroCards,
    board,
    street: Street.FLOP,
    effectiveStackBB: stackBB,
    actionHistory: [
      ...BASE_HISTORY_PREFLOP,
      { position: Position.CO, type: 'RAISE', amountBB: 3 },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'CALL', amountBB: 2 },
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
    ],
    environment: 'MID_LOW_STAKES',
  };
}

/** 翻牌前所有人都溜入到 BB（大盲选择权） */
function bbOptionPreflop(heroCards: readonly [string, string], stackBB = 100): Scenario {
  return {
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards,
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: stackBB,
    actionHistory: [
      { position: Position.UTG, type: 'CALL', amountBB: 1 },
      { position: Position.HJ, type: 'CALL', amountBB: 1 },
      { position: Position.CO, type: 'CALL', amountBB: 1 },
      { position: Position.BTN, type: 'CALL', amountBB: 1 },
      { position: Position.SB, type: 'CALL', amountBB: 0.5 },
    ],
    environment: 'MID_LOW_STAKES',
  };
}

/** 6 人桌，UTG 短筹码全下 5BB，其余弃牌 → Hero 在 CO 面对全下 */
function heroVsShortAllIn(heroCards: readonly [string, string], allInBB: number, stackBB = 100): Scenario {
  return {
    tableSize: 6,
    heroPosition: Position.CO,
    heroCards,
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: stackBB,
    actionHistory: [
      { position: Position.UTG, type: 'ALL_IN', amountBB: allInBB },
      { position: Position.HJ, type: 'FOLD' },
    ],
    environment: 'MID_LOW_STAKES',
  };
}

/* ============================================================
 * 穷举执行器
 * ============================================================ */

type ExecOutcome =
  | { kind: 'OK'; note: string }
  | { kind: 'EXEC_REJECTED'; note: string }
  | { kind: 'ILLEGAL_ACTION'; note: string }
  | { kind: 'ANALYSIS_FAILED'; note: string };

function executeDecision(scenario: Scenario): ExecOutcome {
  const parsed = parseManualInput(scenario);
  if (!parsed.ok) return { kind: 'ANALYSIS_FAILED', note: `PARSE ${JSON.stringify(parsed.issues)}` };
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) return { kind: 'ANALYSIS_FAILED', note: `${gate.stage} ${JSON.stringify(gate.issues)}` };

  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: GameEnvironment.MID_LOW_STAKES,
    asOf: 1_757_000_000_000,
    ...(parsed.value.villain.quickProfile !== undefined ? { quickProfile: parsed.value.villain.quickProfile } : {}),
    ...(parsed.value.villain.dynamicHint !== undefined ? { dynamicHint: parsed.value.villain.dynamicHint } : {}),
  });

  const decision = decideAlpha(built.context, built.legal);
  const legal = built.legal;

  if (!legal.actions.includes(decision.action)) {
    return {
      kind: 'ILLEGAL_ACTION',
      note: `输出 ${decision.action} 不在 [${legal.actions.join(',')}]`,
    };
  }

  // ---- 构造真实命令并交给引擎 ----
  const heroId = built.context.heroCards.length > 0 ? `seat_${scenario.heroPosition}` : 'seat_CO';
  const actor = actorOnTurn(gate.state);
  if (actor !== heroId) {
    return { kind: 'ANALYSIS_FAILED', note: `actorOnTurn=${String(actor)} 期望 ${heroId}` };
  }

  let amount: number | undefined;
  if (decision.action === 'CALL') amount = legal.callCost;
  else if (decision.action === 'BET' || decision.action === 'RAISE') amount = decision.sizeChips;
  else if (decision.action === 'ALL_IN') amount = undefined;

  const res = applyAction(gate.state, {
    playerId: heroId,
    type: decision.action as never,
    ...(amount !== undefined ? { amount } : {}),
  });

  if (!res.ok) {
    return {
      kind: 'EXEC_REJECTED',
      note:
        `输出动作 ${decision.action}` +
        `${amount !== undefined ? ` amount=${amount}` : ''} 被引擎拒绝：` +
        res.issues.map((i) => `${i.code}${JSON.stringify(i.params)}`).join('；'),
    };
  }

  return { kind: 'OK', note: `${decision.action}${amount !== undefined ? `@${amount}` : ''}` };
}

/* ============================================================
 * 场景矩阵
 * ============================================================ */

function allScenarios(): Named[] {
  const out: Named[] = [];
  const boards = [
    ['Kh', '7c', '2d'],
    ['9s', '8s', '2h'],
    ['Ah', 'Ad', '7c'],
    ['2c', '3d', '4h'],
    ['Qs', 'Js', 'Ts'],
  ];
  const heroHands: readonly [string, string][] = [
    ['As', 'Kd'],
    ['Ah', 'Ac'],
    ['7h', '7d'],
    ['Js', 'Td'],
    ['5c', '4c'],
    ['2h', '3s'],
  ];

  for (const b of boards) {
    for (const h of heroHands) {
      out.push({ name: `flop达成下注 ${h.join('')}@${b.join('')} 1BB`, scenario: flopFacingBet(h, b, 1) });
      out.push({ name: `flop达成下注 ${h.join('')}@${b.join('')} 6BB`, scenario: flopFacingBet(h, b, 6) });
      out.push({ name: `flop达成下注 ${h.join('')}@${b.join('')} 30BB`, scenario: flopFacingBet(h, b, 30) });
      out.push({ name: `flop过牌到Hero ${h.join('')}@${b.join('')}`, scenario: flopCheckedToHero(h, b) });
    }
  }

  const rivers = [
    ['Kh', '7c', '2d', '3s', '9h'],
    ['Ah', 'Kd', 'Qc', '2s', '3h'],
  ];
  for (const b of rivers) {
    for (const h of heroHands) {
      for (const bet of [2, 10, 40]) {
        out.push({ name: `river达成下注 ${h.join('')}@${b.join('')} ${bet}BB`, scenario: riverFacingBet(h, b, bet) });
      }
    }
  }

  // 翻牌前
  for (const h of [['As', 'Ad'], ['As', 'Kd'], ['7h', '2c'], ['9s', '9d']] as const) {
    out.push({ name: `heroVs3Bet ${h.join('')} 100BB`, scenario: heroVs3Bet(h) });
    out.push({ name: `bbVsOpen ${h.join('')} 100BB`, scenario: bbVsOpen(h) });
    out.push({ name: `bbVsOpen ${h.join('')} 20BB`, scenario: bbVsOpen(h, 20) });
    out.push({ name: `bbVsOpen ${h.join('')} 5BB`, scenario: bbVsOpen(h, 5) });
    out.push({ name: `bbOption ${h.join('')}`, scenario: bbOptionPreflop(h) });
    out.push({ name: `bbOption ${h.join('')} 8BB`, scenario: bbOptionPreflop(h, 8) });
    out.push({ name: `vsShortAllIn ${h.join('')} 5BB`, scenario: heroVsShortAllIn(h, 5) });
    out.push({ name: `vsShortAllIn ${h.join('')} 40BB`, scenario: heroVsShortAllIn(h, 40) });
    out.push({ name: `vsShortAllIn ${h.join('')} 1.5BB`, scenario: heroVsShortAllIn(h, 1.5) });
  }

  // 短筹码翻牌前
  for (const h of [['As', 'Ad'], ['As', 'Kd'], ['9s', '9d']] as const) {
    for (const s of [3, 5, 8, 12]) {
      out.push({ name: `heroVs3Bet ${h.join('')} ${s}BB`, scenario: heroVs3Bet(h, s) });
      out.push({ name: `flop达成下注 ${h.join('')} ${s}BB`, scenario: flopFacingBet(h, ['Kh', '7c', '2d'], 2, s) });
    }
  }

  return out;
}

function runExhaustive(): void {
  hr('攻击 2A：穷举场景 → 输出动作能否被真实引擎执行');
  const scenarios = allScenarios();
  const counts: Record<string, number> = {};
  const problems: { name: string; outcome: ExecOutcome }[] = [];
  const actionTally: Record<string, number> = {};

  for (const { name, scenario } of scenarios) {
    const outcome = executeDecision(scenario);
    counts[outcome.kind] = (counts[outcome.kind] ?? 0) + 1;
    if (outcome.kind === 'OK') {
      const act = outcome.note.split('@')[0]!;
      actionTally[act] = (actionTally[act] ?? 0) + 1;
    } else {
      problems.push({ name, outcome });
    }
  }

  show('  场景总数', scenarios.length);
  show('  结果分布', counts);
  show('  动作分布（仅成功执行的）', actionTally);
  if (problems.length > 0) {
    console.log(`  --- 问题场景（${problems.length}）---`);
    for (const p of problems.slice(0, 40)) {
      console.log(`   [${p.outcome.kind}] ${p.name}\n      ${p.outcome.note}`);
    }
  } else {
    console.log('  ✔ 无「输出动作无法执行」的场景');
  }
}

function runRaiseReachability(): void {
  hr('攻击 2B：面对下注时 RAISE 是否可达？');

  let facingBetCount = 0;
  let raiseSuggested = 0;
  let raiseLegalButNotChosen = 0;
  const examples: string[] = [];

  for (const { name, scenario } of allScenarios()) {
    const parsed = parseManualInput(scenario);
    if (!parsed.ok) continue;
    const gate = buildAnalyzableState(parsed.value);
    if (!gate.ok) continue;
    const built = buildDecisionContext({
      state: gate.state,
      rules: RULES,
      environment: GameEnvironment.MID_LOW_STAKES,
      asOf: 1_757_000_000_000,
    });
    if (built.legal.callCost <= 0) continue;
    facingBetCount += 1;
    const d = decideAlpha(built.context, built.legal);
    if (d.action === 'RAISE' || d.action === 'ALL_IN') raiseSuggested += 1;
    else if (built.legal.actions.includes('RAISE')) {
      raiseLegalButNotChosen += 1;
      if (examples.length < 8) {
        examples.push(
          `${name}: 合法集合[${built.legal.actions.join(',')}] 但建议 ${d.action} ` +
            `（权益 ${d.diagnostics.math.heroEquity?.toFixed(3)} vs 所需 ${d.diagnostics.math.requiredEquity.toFixed(3)}）`,
        );
      }
    }
  }

  show('  面对下注的场景数', facingBetCount);
  show('  建议 RAISE/ALL_IN 的次数', raiseSuggested);
  show('  RAISE 合法但未被建议的次数', raiseLegalButNotChosen);
  for (const e of examples) console.log(`   · ${e}`);

  hr('攻击 2B-2：翻牌前 AA 面对 3bet 的具体输出');
  const r = analyze(heroVs3Bet(['As', 'Ad']));
  if (r.ok) {
    console.log(`  动作=${r.decision.action} 尺寸=${String(r.decision.sizeChips)} 分类=${r.decision.classification}`);
    console.log(`  合法集合=${JSON.stringify(r.decision.diagnostics.legalActions)}`);
    console.log(`  权益=${String(r.decision.diagnostics.math.heroEquity)} 所需=${r.decision.diagnostics.math.requiredEquity}`);
    console.log(`  候选=${JSON.stringify(r.decision.diagnostics.candidates.map((c) => ({ a: c.action, s: c.sizeChips, ev: c.ev, f: c.mathFeasible })))}`);
    console.log(`  理由=${JSON.stringify(r.decision.reasons.map((x) => x.textZh))}`);
  } else {
    console.log(`  失败 ${r.stage}: ${JSON.stringify(r.issues)}`);
  }
}

function runSizeLegality(): void {
  hr('攻击 2C：尺寸网格合法性（< 最小下注 / > 剩余筹码 / < 最小加注）');

  const violations: string[] = [];
  let checked = 0;

  for (const { name, scenario } of allScenarios()) {
    const parsed = parseManualInput(scenario);
    if (!parsed.ok) continue;
    const gate = buildAnalyzableState(parsed.value);
    if (!gate.ok) continue;
    const built = buildDecisionContext({
      state: gate.state,
      rules: RULES,
      environment: GameEnvironment.MID_LOW_STAKES,
      asOf: 1_757_000_000_000,
    });
    const legal = built.legal;
    for (const c of decideAlpha(built.context, legal).diagnostics.candidates) {
      if (c.action !== 'BET' && c.action !== 'RAISE') continue;
      checked += 1;
      const to = c.sizeChips ?? -1;
      if (to <= 0) violations.push(`${name}: ${c.action} size=${to} 非正`);
      if (to > legal.myRemainingStack + (c.action === 'RAISE' ? legal.allInToAmount : 0)) {
        violations.push(`${name}: ${c.action} size=${to} 超出可投入上限`);
      }
      if (c.action === 'BET' && to < legal.minBet) {
        // 全下小注是合法的例外
        const isAllInBet = to === legal.myRemainingStack;
        if (!isAllInBet) violations.push(`${name}: BET size=${to} < 最小下注 ${legal.minBet}`);
      }
      if (c.action === 'RAISE' && to < legal.minRaiseToAmount) {
        const isAllInRaise = to === legal.allInToAmount;
        if (!isAllInRaise) violations.push(`${name}: RAISE to=${to} < 最小加注到 ${legal.minRaiseToAmount}`);
      }
    }
  }

  show('  检查过的 BET/RAISE 候选数', checked);
  show('  违规数', violations.length);
  for (const v of violations.slice(0, 20)) console.log(`   · ${v}`);
}

function runCallVsAllInLabel(): void {
  hr('攻击 2D：跟注即全下时，输出动作标成 CALL 还是 ALL_IN？');

  // Hero 短筹码（10BB），BTN 开池 3BB，Hero 在 BB 跟注需要 2BB 不是全下。
  // 换成：Hero 3BB，BTN 开池 3BB，Hero 需要投入 3BB = 全部剩余 → 跟注即全下。
  for (const stack of [2.5, 3, 4, 6]) {
    const scenario: ManualHandInput = {
      tableSize: 6,
      heroPosition: Position.BB,
      heroCards: ['9s', '9d'],
      board: [],
      street: Street.PREFLOP,
      effectiveStackBB: stack,
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
      show(`  stack=${stack}BB`, `PARSE FAIL ${JSON.stringify(parsed.issues)}`);
      continue;
    }
    const gate = buildAnalyzableState(parsed.value);
    if (!gate.ok) {
      show(`  stack=${stack}BB`, `${gate.stage} FAIL ${JSON.stringify(gate.issues)}`);
      continue;
    }
    const built = buildDecisionContext({
      state: gate.state,
      rules: RULES,
      environment: GameEnvironment.MID_LOW_STAKES,
      asOf: 1_757_000_000_000,
    });
    const d = decideAlpha(built.context, built.legal);
    const callCost = built.legal.callCost;
    const stackLeft = built.legal.myRemainingStack;
    console.log(
      `  stack=${String(stack).padEnd(4)}BB  callCost=${callCost}  myRemainingStack=${stackLeft}  ` +
        `跟注即全下=${callCost >= stackLeft}  动作=${d.action} size=${String(d.sizeChips)} ` +
        `合法=[${built.legal.actions.join(',')}]`,
    );
  }
}

/* ============================================================
 * 攻击 3：输入静默纠正
 * ============================================================ */

function runInputCorrection(): void {
  hr('攻击 3：错误输入是否被静默「自动修正」后仍然给出建议？');

  const base = bbVsOpen(['As', 'Ad']);

  const cases: { name: string; scenario: ManualHandInput; expectBlock: boolean }[] = [
    {
      name: 'Hero 手牌与公共牌重复（翻牌 7d vs 手牌 7d）',
      scenario: { ...flopCheckedToHero(['7d', '8c'], ['7d', 'Ks', '2h']) },
      expectBlock: true,
    },
    {
      name: '公共牌内部重复（Ks 两次）',
      scenario: { ...flopCheckedToHero(['As', 'Ad'], ['Ks', 'Ks', '2h']) },
      expectBlock: true,
    },
    {
      name: '街道与公共牌张数不符（说翻牌却给 0 张）',
      scenario: { ...flopCheckedToHero(['As', 'Ad'], []), street: Street.FLOP },
      expectBlock: true,
    },
    {
      name: '底池声明与实际不符',
      scenario: { ...flopCheckedToHero(['As', 'Ad'], ['Kh', '7c', '2d']), potBB: 99 },
      expectBlock: true,
    },
    {
      name: '行动顺序错误（跳过 HJ 直接 CO 加注）',
      scenario: {
        ...base,
        actionHistory: [
          { position: Position.UTG, type: 'FOLD' },
          { position: Position.CO, type: 'RAISE', amountBB: 3 },
        ],
      },
      expectBlock: true,
    },
    {
      name: '加注额低于最小加注（3BB 开池后加到 3.5BB）',
      scenario: {
        ...base,
        actionHistory: [
          { position: Position.UTG, type: 'FOLD' },
          { position: Position.HJ, type: 'FOLD' },
          { position: Position.CO, type: 'FOLD' },
          { position: Position.BTN, type: 'RAISE', amountBB: 3 },
          { position: Position.SB, type: 'RAISE', amountBB: 3.5 },
        ],
      },
      expectBlock: true,
    },
    {
      name: '加注超过筹码（100BB 筹码加到 500BB）',
      scenario: {
        ...base,
        actionHistory: [
          { position: Position.UTG, type: 'FOLD' },
          { position: Position.HJ, type: 'FOLD' },
          { position: Position.CO, type: 'FOLD' },
          { position: Position.BTN, type: 'RAISE', amountBB: 500 },
          { position: Position.SB, type: 'FOLD' },
        ],
      },
      expectBlock: true,
    },
    {
      name: '无人下注却「跟注」',
      scenario: {
        ...base,
        actionHistory: [{ position: Position.UTG, type: 'CALL', amountBB: 2 }],
      },
      expectBlock: true,
    },
    {
      name: '过牌时却带非零金额',
      scenario: {
        ...base,
        actionHistory: [
          { position: Position.UTG, type: 'FOLD' },
          { position: Position.HJ, type: 'FOLD' },
          { position: Position.CO, type: 'CHECK', amountBB: 5 },
        ],
      },
      expectBlock: true,
    },
    {
      name: 'CALL 金额与所需不符（应 2BB 却写 5BB）',
      scenario: {
        ...base,
        actionHistory: [
          { position: Position.UTG, type: 'FOLD' },
          { position: Position.HJ, type: 'FOLD' },
          { position: Position.CO, type: 'FOLD' },
          { position: Position.BTN, type: 'RAISE', amountBB: 3 },
          { position: Position.SB, type: 'FOLD' },
          { position: Position.BB, type: 'CALL', amountBB: 5 },
        ],
      },
      expectBlock: true,
    },
    {
      name: '盲注被写进行动历史（POST_BB 的人先加注）',
      scenario: {
        ...base,
        actionHistory: [
          { position: Position.SB, type: 'CALL', amountBB: 0.5 },
          { position: Position.BB, type: 'CHECK' },
        ],
      },
      expectBlock: true,
    },
    {
      name: '同一位置重复行动两次（BTN 加注后又加注）',
      scenario: {
        ...base,
        actionHistory: [
          { position: Position.UTG, type: 'FOLD' },
          { position: Position.HJ, type: 'FOLD' },
          { position: Position.CO, type: 'FOLD' },
          { position: Position.BTN, type: 'RAISE', amountBB: 3 },
          { position: Position.BTN, type: 'RAISE', amountBB: 8 },
        ],
      },
      expectBlock: true,
    },
    {
      name: 'Hero 自己已弃牌却又要求建议',
      scenario: {
        ...base,
        actionHistory: [
          { position: Position.UTG, type: 'FOLD' },
          { position: Position.HJ, type: 'FOLD' },
          { position: Position.CO, type: 'FOLD' },
          { position: Position.BTN, type: 'RAISE', amountBB: 3 },
          { position: Position.SB, type: 'FOLD' },
          { position: Position.BB, type: 'FOLD' },
        ],
      },
      expectBlock: true,
    },
  ];

  for (const c of cases) {
    const r = analyze(c.scenario);
    const blocked = !r.ok;
    const verdict = blocked ? `阻断(${r.stage})` : `**给出建议 ${r.decision.action}${r.decision.sizeChips !== undefined ? `@${r.decision.sizeChips}` : ''}**`;
    const marker = blocked === c.expectBlock ? '✔' : '✘';
    console.log(`  ${marker} ${c.name}\n      → ${verdict}`);
    if (blocked && r.issues.length > 0) {
      console.log(`      原因: ${r.issues.map((i) => `${i.code}: ${i.message}`).join(' | ').slice(0, 260)}`);
    }
  }
}

function runSilentCorrectionPotFraction(): void {
  hr('攻击 3B：小数/极端数值是否被静默取整成另一个牌局？');

  // bigBlindBB 与 effectiveStackBB 的小数会被 Math.round 取整
  const variants: { label: string; effectiveStackBB: number; bigBlindBB?: number }[] = [
    { label: '有效筹码 100BB', effectiveStackBB: 100 },
    { label: '有效筹码 100.4BB', effectiveStackBB: 100.4 },
    { label: '有效筹码 100.6BB', effectiveStackBB: 100.6 },
    { label: '有效筹码 0.4BB', effectiveStackBB: 0.4 },
    { label: '有效筹码 0.9BB', effectiveStackBB: 0.9 },
    { label: '有效筹码 1e-9BB', effectiveStackBB: 1e-9 },
    { label: '有效筹码 1e15BB', effectiveStackBB: 1e15 },
  ];

  for (const v of variants) {
    const scenario: ManualHandInput = {
      tableSize: 6,
      heroPosition: Position.BB,
      heroCards: ['As', 'Ad'],
      board: [],
      street: Street.PREFLOP,
      effectiveStackBB: v.effectiveStackBB,
      ...(v.bigBlindBB !== undefined ? { bigBlindBB: v.bigBlindBB } : {}),
      actionHistory: [
        { position: Position.UTG, type: 'FOLD' },
        { position: Position.HJ, type: 'FOLD' },
        { position: Position.CO, type: 'FOLD' },
        { position: Position.BTN, type: 'RAISE', amountBB: 3 },
        { position: Position.SB, type: 'FOLD' },
      ],
      environment: 'MID_LOW_STAKES',
    };
    const r = analyze(scenario);
    if (!r.ok) {
      console.log(`  ${v.label.padEnd(18)} → 阻断(${r.stage}) ${r.issues.map((i) => i.code).join(',')}`);
      continue;
    }
    const m = r.decision.diagnostics.math;
    console.log(
      `  ${v.label.padEnd(18)} → pot=${m.pot} myStack=${m.myRemainingStack} callCost=${m.callCost} ` +
        `动作=${r.decision.action} size=${String(r.decision.sizeChips)}`,
    );
  }
}

function runBigBlindBBEffect(): void {
  hr('攻击 3C：bigBlindBB 是否真的改变牌局（还是只改显示）？');

  for (const bigBlindBB of [1, 2, 0.5, 0.1]) {
    const scenario: ManualHandInput = {
      tableSize: 6,
      heroPosition: Position.BB,
      heroCards: ['As', 'Ad'],
      board: [],
      street: Street.PREFLOP,
      effectiveStackBB: 100,
      bigBlindBB,
      actionHistory: [
        { position: Position.UTG, type: 'FOLD' },
        { position: Position.HJ, type: 'FOLD' },
        { position: Position.CO, type: 'FOLD' },
        { position: Position.BTN, type: 'RAISE', amountBB: 3 },
        { position: Position.SB, type: 'FOLD' },
      ],
      environment: 'MID_LOW_STAKES',
    };
    const r = analyze(scenario);
    if (!r.ok) {
      console.log(`  bigBlindBB=${bigBlindBB} → 阻断(${r.stage}) ${r.issues.map((i) => i.message).join(' ')}`);
      continue;
    }
    const m = r.decision.diagnostics.math;
    console.log(
      `  bigBlindBB=${String(bigBlindBB).padEnd(4)} → pot=${m.pot} bigBlind(快照)=${m.bigBlind} ` +
        `callCost=${m.callCost} 动作=${r.decision.action} sizeBB=${String(r.decision.sizeBB)} ` +
        `ViewModel尺寸=${String(r.viewModel.sizeZh)}`,
    );
  }
}

/* ============================================================
 * main
 * ============================================================ */

console.log(`知识库规则数=${RULES.length}`);
console.log(`computePot/minRaiseTo/minBetAmount/requiredCallAmount 可用性检查: ` +
  `${typeof computePot}${typeof minRaiseTo}${typeof minBetAmount}${typeof requiredCallAmount}`);
void buildSizeGrid;

runExhaustive();
runRaiseReachability();
runSizeLegality();
runCallVsAllInLabel();
runInputCorrection();
runSilentCorrectionPotFraction();
runBigBlindBBEffect();
