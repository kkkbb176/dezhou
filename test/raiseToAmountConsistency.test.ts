/**
 * ============================================================================
 * TEST 18 · RAISE-TO AMOUNT CONSISTENCY P1（加注金额口径一致性）
 * ============================================================================
 *
 * ## 这一轮修的是什么
 *
 * `finalMathSanityCheck` 把 `decision.sizeChips` 与 `legal.myRemainingStack`
 * 直接比大小 —— 但**两者的口径不同**：
 *
 * ```text
 * sizeChips（RAISE / ALL_IN / BET）= 尺寸网格的 toAmount = 本街**累计**金额（raise-to）
 * myRemainingStack                = 我还能再投入多少 = **增量**口径
 * 恒等式（legalActions.ts）：allInToAmount = 本街已投入 + myRemainingStack
 * ```
 *
 * TEST 18（转牌面对加注：本街已投入 20、剩余 166、合法全下累计 186）因此被误报成
 * 「⚠️ 建议尺寸 186 超过剩余筹码 166 —— 已被最终数学检查拦截（不应发生，请报告）」，
 * 而 186 恰是**引擎自己的 allInToAmount** ⇒ 完全合法。
 *
 * ## 本文件的断言纪律
 *
 * - 数值断言来自**生产入口**（`analyzeManualHand`）；口径断言来自
 *   `buildDecisionContext(...).legal`（= `finalMathSanityCheck` 实际收到的对象）；
 * - 动作金额语义**逐条核对过实现**（见下面 `SEMANTICS` 注释），不假定所有动作同口径；
 * - 墨菲清单 A–J 覆盖「本街已投入 0 / 已投入 20 / 非法超额 / CALL / BET / 非全下 RAISE /
 *   短筹码退回 / 对手跟注即全下 / 占位下界不得被当成真实分支 / 真非法仍被拦」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand, finalMathSanityCheck } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parseManualInput, type ManualHandInput, type ManualVillain } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(),
  asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A_ = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

const villain: ManualVillain = {
  seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪',
  quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
  observedStats: {
    handsObserved: 800,
    vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
    foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
    flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
  },
};

/**
 * TEST 18 原始牌局：BTN A♣J♣，J♦8♣4♣6♠ 转牌，BB 过牌后对我的 20 **加注到 80**。
 * 本街我已投入 20 ｜ 剩余 166 ｜ 合法全下累计 186 ｜ 跟注 60 ｜ 底池 129。
 */
function test18Input(): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'],
    street: 'TURN', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
      A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
      A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
      A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'RAISE', 40, 'TURN'),
    ],
    environment: 'MID_LOW_STAKES',
    villain,
  } as unknown as ManualHandInput;
}

/** 同一牌局但**我没有转牌下注**（BB 直接领打）：本街已投入 = 0（墨菲 B 用） */
function turnFacingBetNoCommitmentInput(): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'],
    street: 'TURN', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
      A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
      A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
      A_('BB', 'BET', 10, 'TURN'),
    ],
    environment: 'MID_LOW_STAKES',
    villain,
  } as unknown as ManualHandInput;
}

/** 同一牌局但**转牌 BB 过牌、轮到我行动**：本街已投入 0，且 `BET` 是合法动作（墨菲 E 用） */
function turnUnopenedInput(): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'],
    street: 'TURN', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
      A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
      A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
      A_('BB', 'CHECK', undefined, 'TURN'),
    ],
    environment: 'MID_LOW_STAKES',
    villain,
  } as unknown as ManualHandInput;
}

type Run = {
  readonly decision: Record<string, any>;
  readonly math: Record<string, any>;
  readonly postflop: Record<string, any>;
  readonly raiseResponse: Record<string, any> | null;
  readonly legal: Record<string, any>;
  readonly warnings: readonly string[];
  readonly rows: readonly { label: string; value: string }[];
};

function runOf(input: ManualHandInput): Run {
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true, `分析必须成功：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) throw new Error('unreachable');
  const decision = r.decision as unknown as Record<string, any>;
  const dg = decision['diagnostics'] as Record<string, any>;
  /* `legal` 必须取 contextBuilder 的**原始**对象 —— 那正是 finalMathSanityCheck 收到的那个 */
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true);
  if (!gate.ok) throw new Error('unreachable');
  const built = buildDecisionContext({
    state: gate.state, rules: OPTIONS.rules, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
    quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN',
    villainSeatId: 'seat_BB', villainPersistentPlayerId: 'player_001',
    observedStats: villain.observedStats,
    equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
  } as never);
  const vm = r.viewModel as unknown as Record<string, any>;
  return {
    decision,
    math: dg['math'] as Record<string, any>,
    postflop: (dg['postflop'] ?? {}) as Record<string, any>,
    raiseResponse: (((dg['postflop'] ?? {}) as Record<string, any>)['raiseResponse'] ?? null) as Record<string, any> | null,
    legal: built.legal as unknown as Record<string, any>,
    warnings: r.warnings as readonly string[],
    rows: ((vm['debug']?.['math'] ?? []) as readonly { label: string; value: string }[]),
  };
}

const rowOf = (run: Run, label: string): { label: string; value: string } | undefined =>
  run.rows.find((x) => x.label === label);

/**
 * **动作金额语义表（§四，逐条核对实现后的结论）**
 *
 * | 动作 | `sizeChips` 来源 | 口径 | 合法上限 |
 * |---|---|---|---|
 * | `FOLD` / `CHECK` | 无 | — | — |
 * | `CALL` | `legal.callCost` | **本次新增投入** | `legal.myRemainingStack` |
 * | `BET` | 尺寸网格 `toAmount` | **本街累计**（首次下注 ⇒ 与增量恒等） | `legal.allInToAmount` |
 * | `RAISE`（含加注到全下） | 尺寸网格 `toAmount` | **本街累计（raise-to）** | `legal.allInToAmount` |
 * | `ALL_IN` | `legal.allInToAmount` | **本街累计** | `legal.allInToAmount` |
 */
const RAISE_FAMILY: readonly string[] = ['RAISE', 'ALL_IN'];

/** 用生产决策对象 + 生产 legal 跑一次最终检查（与管线里的调用完全一致） */
function sanityProblemsOf(run: Run, overrides: { action?: string; sizeChips?: number } = {}): readonly string[] {
  const fake = {
    ...run.decision,
    ...(overrides.action === undefined ? {} : { action: overrides.action }),
    ...(overrides.sizeChips === undefined ? {} : { sizeChips: overrides.sizeChips }),
  };
  return finalMathSanityCheck(fake as never, run.legal as never);
}

/**
 * 是否产生了「尺寸超限」类问题（管线会把它并进用户可见 warnings）。
 * ⚠️ 匹配用「拦截」而不是「已拦截」：生产文案是「已被最终数学检查**拦截**」。
 */
const hasSizeProblem = (problems: readonly string[]): boolean =>
  problems.some((p) => p.includes('拦截') || p.includes('超过剩余筹码') || p.includes('超过本次动作的合法上限'));

/* ============================================================
 * A —— TEST 18：合法全下不得被误报
 * ============================================================ */

test('A（TEST 18）：本街已投入 20、剩余 166、加注至 186 = 合法全下，且不得有虚假尺寸告警', () => {
  const run = runOf(test18Input());

  /* 输入事实（来自状态机，不是猜的） */
  assert.equal(run.math['myCommittedThisStreet'], 20, '我在本街已投入必须是 20');
  assert.equal(run.legal['myRemainingStack'], 166, '我剩余筹码必须是 166');
  assert.equal(run.legal['allInToAmount'], 186, '合法全下的**本街累计**金额必须是 186');
  assert.equal(run.legal['callCost'], 60, '跟注需补必须是 60');
  /* 恒等式：累计 = 本街已投入 + 剩余 */
  assert.equal(
    run.legal['allInToAmount'],
    run.math['myCommittedThisStreet'] + run.legal['myRemainingStack'],
    'allInToAmount 必须等于「本街已投入 + 剩余筹码」',
  );

  /* 推荐动作 */
  assert.equal(String(run.decision['action']), 'RAISE', '推荐动作必须是 RAISE');
  assert.equal(run.decision['sizeChips'], 186, '推荐尺寸必须是 186（本街累计）');
  assert.equal(run.decision['diagnostics']['actionShape']['kind'], 'RAISE_TO_ALL_IN', '动作形态必须是 RAISE_TO_ALL_IN');
  assert.equal(run.decision['actionable'], true, '该动作必须 actionable');
  /* 实际新增投入 = 累计 − 本街已投入 */
  assert.equal(
    run.decision['sizeChips'] - run.math['myCommittedThisStreet'],
    run.legal['myRemainingStack'],
    '本次再投入必须恰好等于剩余筹码（166）',
  );

  /* 🔴 核心断言：最终检查不得产生「超过剩余筹码 / 已拦截」类虚假告警 */
  const problems = sanityProblemsOf(run);
  assert.deepEqual(
    problems.filter((p) => p.includes('超过剩余筹码') || p.includes('已拦截')),
    [],
    `合法全下不得被误报，实际：${JSON.stringify(problems)}`,
  );
  /* 管线 warnings 里也不得出现（用户可见面） */
  assert.equal(
    run.warnings.some((w) => w.includes('超过剩余筹码') || w.includes('已拦截')),
    false,
    `管线 warnings 不得含虚假尺寸告警，实际：${JSON.stringify(run.warnings)}`,
  );
});

/* ============================================================
 * B —— 本街已投入 0：首次全下 / 首次加注到全下
 * ============================================================ */

test('B（本街已投入 0）：尺寸上限按累计口径校验，本街已投入为 0 时两口径恒等', () => {
  const run = runOf(turnFacingBetNoCommitmentInput());
  assert.equal(run.math['myCommittedThisStreet'], 0, '该节点我在本街已投入必须是 0');
  const legal = run.legal;
  assert.equal(
    legal['allInToAmount'],
    legal['myRemainingStack'],
    '本街已投入为 0 时，全下累计额必须等于剩余筹码',
  );
  /* ① 全下额本身合法 */
  assert.deepEqual(sanityProblemsOf(run, { action: 'RAISE', sizeChips: legal['allInToAmount'] as number }), []);
  /* ② 超过全下额 1 筹码 ⇒ 必须被拦（墨菲 J 的前置） */
  assert.equal(
    hasSizeProblem(sanityProblemsOf(run, { action: 'RAISE', sizeChips: (legal['allInToAmount'] as number) + 1 })),
    true,
    '超过全下上限 1 筹码必须被拦下',
  );
  /* ③ 该节点真实推荐动作也必须有正确的金额语义（无论是否全下） */
  const size = run.decision['sizeChips'] as number | undefined;
  if (size !== undefined && RAISE_FAMILY.includes(String(run.decision['action']))) {
    assert.ok(size <= (legal['allInToAmount'] as number), `推荐尺寸必须 ≤ 全下累计额（实际 ${size}）`);
  }
});

/* ============================================================
 * C / J —— 真正非法的金额仍必须被拦
 * ============================================================ */

test('C（非法超额）：本街已投入 20、加注至 187 > 合法全下 186 ⇒ 必须被拦下', () => {
  const run = runOf(test18Input());
  const problems = sanityProblemsOf(run, { action: 'RAISE', sizeChips: 187 });
  assert.equal(
    hasSizeProblem(problems),
    true,
    `187 > 186 必须被拦下，实际检查结果：${JSON.stringify(problems)}`,
  );
  /* 文案必须点明是「上限」而不是含糊的「超过剩余筹码」 */
  assert.ok(
    problems.some((p) => p.includes('186')),
    `告警必须给出正确的上限 186，实际：${JSON.stringify(problems)}`,
  );
});

test('J（非法金额仍被拦）：NaN / 负数 / 远超上限三种非法尺寸都必须报警', () => {
  const run = runOf(test18Input());
  for (const [tag, size] of [
    ['NaN', Number.NaN],
    ['负数', -1],
    ['远超上限', 1_000],
  ] as const) {
    assert.equal(
      hasSizeProblem(sanityProblemsOf(run, { action: 'RAISE', sizeChips: size })),
      true,
      `${tag}（${String(size)}）必须被拦下，实际检查结果：${JSON.stringify(sanityProblemsOf(run, { action: 'RAISE', sizeChips: size }))}`,
    );
  }
  /* 反证：合法值不得报警（防止「把检查关掉」也能过） */
  assert.equal(
    hasSizeProblem(sanityProblemsOf(run, { action: 'RAISE', sizeChips: 186 })),
    false,
    '合法的 186 不得报警 —— 检查必须仍然生效，只是口径正确',
  );
});

/* ============================================================
 * D —— CALL 走增量口径（不得误用 raise-to）
 * ============================================================ */

test('D（CALL）：60 是**本次新增投入**，按增量口径校验；超过剩余筹码的 CALL 必须被拦', () => {
  const run = runOf(test18Input());
  assert.equal(
    run.decision['diagnostics']['candidates'].find((c: Record<string, any>) => c['action'] === 'CALL')['sizeChips'],
    run.legal['callCost'],
    'CALL 候选的 sizeChips 必须等于 callCost（增量口径）',
  );
  assert.deepEqual(
    sanityProblemsOf(run, { action: 'CALL', sizeChips: run.legal['callCost'] as number }),
    [],
    '合法的 CALL（60）不得报警',
  );
  assert.equal(
    hasSizeProblem(sanityProblemsOf(run, { action: 'CALL', sizeChips: (run.legal['myRemainingStack'] as number) + 1 })),
    true,
    'CALL 超过剩余筹码必须被拦（增量口径）',
  );
});

/* ============================================================
 * E / F —— BET 与「已投入后的非全下 RAISE」
 * ============================================================ */

test('E（BET）：首次下注的金额语义与本街累计恒等，超限仍被拦', () => {
  /* ⚠️ 必须用 `BET` 合法（无人下注、本街已投入 0）的节点 —— TEST 18 节点上面临下注，BET 不合法 */
  const run = runOf(turnUnopenedInput());
  const legal = run.legal;
  assert.ok(
    (legal['actions'] as readonly string[]).includes('BET'),
    `本节点必须允许 BET，实际：${JSON.stringify(legal['actions'])}`,
  );
  assert.equal(run.math['myCommittedThisStreet'], 0, '首次下注前我在本街已投入必须是 0');
  assert.equal(
    legal['allInToAmount'],
    legal['myRemainingStack'],
    '本街已投入 0 ⇒ 全下累计额与剩余筹码恒等（两口径在此重合）',
  );
  const bet = Math.min(20, legal['myRemainingStack'] as number);
  assert.deepEqual(
    sanityProblemsOf(run, { action: 'BET', sizeChips: bet }),
    [],
    `首次下注 ${bet} 不得报警`,
  );
  assert.equal(
    hasSizeProblem(sanityProblemsOf(run, { action: 'BET', sizeChips: (legal['allInToAmount'] as number) + 5 })),
    true,
    'BET 超过全下累计额必须被拦',
  );
});

test('F（非全下 RAISE）：本街已投入 20 时，加注至 180 合法（旧判据会误报），187 非法', () => {
  const run = runOf(test18Input());
  const committed = run.math['myCommittedThisStreet'] as number;
  /* 180 是生产候选清单里的合法尺寸（raise-to），且 180 > 剩余 166 ⇒ 旧判据必然误报 */
  assert.ok(
    run.decision['diagnostics']['candidates'].some((c: Record<string, any>) => c['action'] === 'RAISE' && c['sizeChips'] === 180),
    '生产候选里必须有 RAISE 180（用于本反例）',
  );
  assert.equal(180 > (run.legal['myRemainingStack'] as number), true, '前提：180 > 剩余 166（旧判据会误报）');
  assert.equal(180 <= (run.legal['allInToAmount'] as number), true, '前提：180 ≤ 全下累计 186（实际合法）');
  assert.deepEqual(
    sanityProblemsOf(run, { action: 'RAISE', sizeChips: 180 }),
    [],
    '非全下加注 180 不得报警',
  );
  /* 新增投入核算 */
  assert.equal(180 - committed, 160, '加注至 180 的本次再投入必须是 160');
  /* 仍要拦住超额 */
  assert.equal(hasSizeProblem(sanityProblemsOf(run, { action: 'RAISE', sizeChips: 187 })), true, '187 仍须被拦');
});

/* ============================================================
 * G —— 短筹码 / 未匹配退回：资金守恒不受影响
 * ============================================================ */

test('G（资金守恒）：heroAdd = 留在池中的投入 + 退回；终池 = 当前底池 + 双方新增', () => {
  const run = runOf(test18Input());
  const rr = run.raiseResponse!;
  assert.equal(rr['villainIsAllInByCall'], true, '前提：他跟平即全下（短筹码）');
  assert.equal(
    rr['heroAdd'],
    rr['heroContestedAdd'] + rr['uncalledReturn'],
    'heroAdd 必须等于「留在池中 + 退回」',
  );
  assert.equal(
    rr['finalPot'],
    rr['currentPot'] + rr['heroContestedAdd'] + rr['villainAdd'],
    '终池必须等于「当前底池 + 我留在池中 + 他跟注新增」',
  );
  assert.equal(rr['villainAdd'], rr['villainAddRaw'], '他的跟注未超过其剩余筹码 ⇒ 无需封顶');
});

/* ============================================================
 * H —— 对手跟注即全下 ⇒ 不存在再加注分支（且占位下界不得被当成真实分支）
 * ============================================================ */

test('H（无再加注分支）：rr = 0、桶为 0、无权益、无 4-bet；占位值必须标成「未实现」', () => {
  const run = runOf(test18Input());
  const rr = run.raiseResponse!;
  assert.equal(rr['reRaiseLikelihood'], 0, '他跟平即全下 ⇒ 再加注概率必须为 0');
  assert.equal(rr['reRaiseCombos'], 0, '再加注桶必须为空');
  assert.equal(rr['heroEquityVsReraiseRange'], null, '不存在再加注范围 ⇒ 权益必须为 null（不是 0）');
  assert.equal(rr['reraiseCallBranchEV'], null, '不存在跟注分支 ⇒ 分支 EV 必须为 null（不是 0）');
  assert.equal(rr['heroFourBetSupported'], null, '不存在再加注 ⇒ 4-bet 支持必须为 null（不适用）');
  assert.equal(
    rr['reraiseBranchKind'],
    'LOWER_BOUND_NOT_IMPLEMENTED',
    '占位值必须被显式标注为「未实现」，而不是某种真实分支类型',
  );
  /* 占位下界不得被读成「已评估的分支 EV」：它必须等于 −heroContestedAdd */
  assert.equal(
    rr['reraiseBranchEV'],
    -rr['heroContestedAdd'],
    'rr = 0 时的占位值必须正好是「放弃本次投入」的保守口径',
  );
  /* 界面不得展示任何「再加注分支」字样（用户可见面不得把占位当真实分支） */
  const vmText = JSON.stringify(run.rows);
  assert.equal(
    /再加注分支 EV|被再加注分支/.test(vmText),
    false,
    '界面的数学明细里不得出现「再加注分支 EV」这类表述',
  );
});

/* ============================================================
 * §六 —— 用户可见的金额表达
 * ============================================================ */

test('§六（界面）：必须区分「加注至 186」与「本次再投入 166」，且不得把 186 说成要再拿出 186', () => {
  const run = runOf(test18Input());
  const r = analyzeManualHand(test18Input(), OPTIONS);
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error('unreachable');
  const vm = r.viewModel as unknown as Record<string, any>;

  /* 建议行：必须是「全下（加注至 186 筹码）」这种口径明确的表达 */
  assert.ok(
    /全下/.test(String(vm['actionZh'])),
    `建议行动必须标出「全下」，实际：${String(vm['actionZh'])}`,
  );
  assert.ok(
    /加注至 186/.test(`${String(vm['actionZh'])} ${String(vm['sizeZh'])}`),
    `必须写明「加注至 186」，实际：${String(vm['actionZh'])} / ${String(vm['sizeZh'])}`,
  );
  /* 三行金额口径 */
  const committedRow = rowOf(run, '本街已投入');
  assert.ok(committedRow !== undefined, '界面必须有「本街已投入」行');
  assert.ok(/20/.test(committedRow!.value), `本街已投入必须显示 20，实际：${committedRow!.value}`);
  const addRow = rowOf(run, '本次再投入');
  assert.ok(addRow !== undefined, '界面必须有「本次再投入」行');
  assert.ok(/166/.test(addRow!.value), `本次再投入必须显示 166，实际：${addRow!.value}`);
  const totalRow = rowOf(run, '加注后的本街总额');
  assert.ok(totalRow !== undefined, '界面必须有「加注后的本街总额」行');
  assert.ok(/186/.test(totalRow!.value), `加注后的本街总额必须显示 186，实际：${totalRow!.value}`);
  /* 不得把 186 描述成「需要再次拿出」 */
  assert.equal(
    /需要\s*186|再拿出\s*186|还需\s*186/.test(JSON.stringify(vm)),
    false,
    '不得把 186 描述成「需要再拿出 186」',
  );
});

test('§六（非全下动作保留各自表达）：CALL 60 / 首次 BET 20 的口径不被改动', () => {
  /* CALL：跟注行必须仍写「跟注需要 60」 */
  const raiseSide = runOf(test18Input());
  const callRow = rowOf(raiseSide, '跟注需要');
  assert.ok(callRow !== undefined && /60/.test(callRow.value), `跟注需要必须显示 60，实际：${String(callRow?.value)}`);
  /* 该节点是加注节点 ⇒ 必须出现的是「加注后的本街总额」而不是「下注后的本街总额」 */
  assert.ok(rowOf(raiseSide, '加注后的本街总额') !== undefined, '加注节点必须用「加注后的本街总额」');
  assert.equal(rowOf(raiseSide, '下注后的本街总额'), undefined, '加注节点不得出现下注口径的行');
});

/* ============================================================
 * §八 —— 数值回归（只修告警与界面 ⇒ 数值必须逐位不变）
 * ============================================================ */

test('§八（数值回归）：TEST 18 的 EV / 资金 / 动作必须逐位不变', () => {
  const run = runOf(test18Input());
  assert.equal(run.math['callEV'], 75.18122987205047, 'CALL EV 必须逐位不变');
  const rr = run.raiseResponse!;
  assert.equal(rr['raiseEV'], 93.97844769482654, 'RAISE 186 EV 必须逐位不变');
  assert.equal(String(run.decision['action']), 'RAISE', '最终动作必须仍是 RAISE');
  assert.equal(run.decision['sizeChips'], 186, '最终尺寸必须仍是 186');
  assert.equal(rr['heroAdd'], 166, 'Hero 实际新增投入必须是 166');
  assert.equal(rr['villainAdd'], 106, 'Villain 跟注新增投入必须是 106');
  assert.equal(rr['finalPot'], 401, 'Final Pot 必须是 401');
  /* FOLD EV ≡ 0（零点口径） */
  assert.equal(
    run.decision['diagnostics']['candidates'].find((c: Record<string, any>) => c['action'] === 'FOLD')['ev'],
    0,
    'FOLD EV 必须 ≡ 0',
  );
});
