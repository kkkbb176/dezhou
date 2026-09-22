/**
 * 多人边池 × 决策层（2026-09 修复）—— 端到端回归
 *
 * ## 这一组防的是什么
 *
 * 「所需权益 = 跟注额 ÷ 可争夺总量」只在英雄**只有一层**（主池）时才是真实的
 * 盈亏平衡门槛。英雄有资格争 ≥ 2 层时（主池 + 边池），两笔钱要赢的人不同：
 *
 * | 层 | 赢的条件 |
 * |---|---|
 * | 主池 | 赢**所有**还在桌上的人 |
 * | 边池 | 只赢**同在这一层**的人 |
 *
 * 于是「输掉主池、赢下边池」是可能的 —— 单一门槛算出的 EV 只是**下界**。
 * 修复前会据此输出「跟注在数学上是负期望」并**直接弃牌**（且不允许策略层翻转），
 * 而实测反例里那手牌的真实 EV 是 **+1764**（`POT-13` 用逐张枚举锁住）。
 *
 * ## 修复后的三条行为（本文件逐条锁住）
 *
 * | 局面 | 行为 |
 * |---|---|
 * | 多层 + 门槛口径下界**非负** | 照常给建议（跟注不亏是可证明的），并声明门槛不适用 |
 * | 多层 + 下界**为负** | **不给方向**（`LAYERED_POT_EQUITY_UNAVAILABLE`）—— 判不了就不判 |
 * | 单层（无活边池） | 与修复前完全一致：门槛就是真门槛，硬判照常生效 |
 *
 * ⚠️ 本文件走**真实管线**（`analyzeManualHand`），不是手搓 context ——
 * 目的是让「口径标记有没有真的传到决策层」这件事被锁住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { GTO_MATRIX_AXIS } from '../src/domain/gto/gtopenHandMatrix.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { Position, Street } from '../src/domain/types.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;

/**
 * 多人边池局面（翻牌前各 10BB、转牌大筹码再全下 20BB）：
 *
 * ```text
 * UTG 10BB 全下（短码）／BTN 30BB 全下／我 BB 30BB，需再跟 20BB
 * 可争夺 = 主池（三层） + 边池（只有我与 BTN）⇒ 我有**两层**资格
 * ```
 *
 * ⚠️ `ALL_IN` 的 `amountBB` 是「加注到的**本街**总额」，因此转牌那条是 20 而不是 30。
 */
function multiwayTurn(heroCards: readonly [string, string]): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards,
    board: ['Kh', '9s', '4d', '2c'],
    street: Street.TURN,
    effectiveStackBB: 30,
    seatStacksBB: { UTG: 10, HJ: 100, CO: 100, BTN: 30, SB: 100, BB: 30 },
    actionHistory: [
      { position: Position.UTG, type: 'ALL_IN', amountBB: 10 },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'FOLD' },
      { position: Position.BTN, type: 'CALL', amountBB: 10 },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'CALL', amountBB: 9 },
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      { position: Position.BTN, type: 'CHECK', street: Street.FLOP },
      { position: Position.BB, type: 'CHECK', street: Street.TURN },
      { position: Position.BTN, type: 'ALL_IN', amountBB: 20, street: Street.TURN },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  };
}

/** 单层对照：只有短码全下，我只需面对主池（没有边池可言） */
function headsUpVsShortAllIn(heroCards: readonly [string, string]): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards,
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 30,
    seatStacksBB: { UTG: 10, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 30 },
    actionHistory: [
      { position: Position.UTG, type: 'ALL_IN', amountBB: 10 },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'FOLD' },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  };
}

/**
 * 🔴 **暂时性层**局面（红队 F-06）：BB 拿 AA，UTG 开池 3BB、CO 跟注。
 *
 * ```text
 * 决策时刻：#0 额 350（UTG+CO+BB）／#1 额 400（UTG+CO）   ← 看起来两层
 * 我跟注后：#0 额 950（UTG+CO+BB）                        ← 其实只有一层
 * ```
 *
 * 层界不是结构性的：UTG/CO 都还有筹码，他们的钱本来就在我跟注的覆盖范围内。
 * 因此 `singleThresholdApplies === true`，单一门槛**适用**。
 */
function bigBlindFacingOpenWithCaller(cards: readonly [string, string]): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards: cards,
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'RAISE', amountBB: 3 },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'CALL', amountBB: 3 },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  };
}

/**
 * 🔴 **结构性多层，但某一层的对手没有范围**：我 SB 30BB，UTG 全下 10BB、
 * BTN 全下 30BB，而 **BB 还没说话**（未实现 ⇒ 无范围）。
 *
 * ```text
 * 我跟注后的层：#0 额 400（UTG+BTN+我+BB）／#1 额 2700（UTG+BTN+我）／#2 额 4000（BTN+我）
 * ```
 *
 * 层 #0 里有 BB ⇒ 那一层的胜率算不出来 ⇒ `exact = false` ⇒ 不得判方向。
 */
function structuralButRangeMissing(cards: readonly [string, string]): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: Position.SB,
    heroCards: cards,
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 30,
    seatStacksBB: { UTG: 10, BTN: 30, SB: 30, BB: 100 },
    actionHistory: [
      { position: Position.UTG, type: 'ALL_IN', amountBB: 10 },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'FOLD' },
      { position: Position.BTN, type: 'ALL_IN', amountBB: 30 },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  };
}

/**
 * 结构性多层（两家全下、我需跟 1900）：UTG 全下 10BB、BTN 全下 20BB、我 BB 30BB。
 *
 * 用于锁定「分层 EV 落在 ±5% 带内」的行为（`POT-D10`）。
 */
function threeWayTwoAllIns(cards: readonly [string, string]): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards: cards,
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 30,
    seatStacksBB: { UTG: 10, BTN: 20, BB: 30 },
    actionHistory: [
      { position: Position.UTG, type: 'ALL_IN', amountBB: 10 },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'FOLD' },
      { position: Position.BTN, type: 'ALL_IN', amountBB: 20 },
      { position: Position.SB, type: 'FOLD' },
    ],
    environment: 'LOW_STAKES_ONLINE',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as ManualHandInput;
}

function analyze(input: ManualHandInput) {  const result = analyzeManualHand(input, OPTIONS);
  assert.equal(result.ok, true, `分析必须成功：${result.ok ? '' : JSON.stringify(result.issues)}`);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

const codesOf = (reasons: readonly { code: string }[]) => reasons.map((r) => r.code);

test('POT-D1：多人边池 ⇒ 口径标记必须传到决策层（不得再宣称「单一门槛」）', () => {
  const r = analyze(multiwayTurn(['Ah', 'Ad']));
  const math = r.decision.diagnostics.math;
  assert.equal(
    math.requiredEquityApplies,
    false,
    '我既争主池又争边池 ⇒ 单一权益门槛不适用（标记必须为 false）',
  );
  assert.ok(
    math.requiredEquity > 0.28 && math.requiredEquity < 0.29,
    `门槛仍应给出数值（供显示与指纹），实际 ${(math.requiredEquity * 100).toFixed(2)}%`,
  );
  const rows = (r.viewModel as { debug?: { math?: readonly { label: string; value: string }[] } }).debug?.math ?? [];
  const row = rows.find((x) => x.label === '所需权益口径');
  assert.ok(row !== undefined, '界面必须有「所需权益口径」这一行');
  assert.ok(row.value.includes('不适用'), `口径行必须写明不适用，实际：${row.value}`);
});

test('POT-D2：多人边池 + 下界非负 ⇒ 给建议，但不得说「负期望」', () => {
  // A♥A♦ 对两家的范围权益很高（75% 量级）⇒ 门槛口径的 EV 下界已经为正
  const r = analyze(multiwayTurn(['Ah', 'Ad']));
  assert.ok(r.decision.action !== null, '下界非负时必须给出动作（跟注不亏是可证明的）');
  const codes = codesOf(r.decision.reasons);
  assert.ok(
    !codes.includes('MATH_FOLD_DOMINANT'),
    `多层局面不得输出「负期望」硬判，实际理由：${codes.join(', ')}`,
  );
});

test('POT-D3：结构性多层 + 逐层算得出来 ⇒ 按逐层 EV 判方向（**可以**判弃牌）', () => {
  /*
   * 7♣6♣ 在 K-9-4-2 面上对两家的整池权益极低 ⇒ 逐层算出来的 EV 也明显为负。
   *
   * 修复前（第一阶段）：这里只能「不给方向」，因为单一门槛算出的 EV 只是**下界**，
   * 真实 EV 可能因为「赢边池」而变正（POT-13 就是实例）。
   *
   * 本轮（第二阶段）：逐层胜率**真的算出来了** ⇒ 可以给出方向，包括弃牌这一侧。
   * 关键是它必须与「下界为负」区分开：判弃牌的依据是**逐层 EV**，不是下界。
   */
  const r = analyze(multiwayTurn(['7c', '6c']));
  const math = r.decision.diagnostics.math;
  assert.equal(math.layeredEV?.exact, true, '对手范围齐备的结构性多层局面必须算出精确分层 EV');
  assert.ok(
    math.layeredEV!.value < 0,
    `该手牌的分层 EV 应为负，实际 ${math.layeredEV!.value.toFixed(2)}`,
  );
  const codes = codesOf(r.decision.reasons);
  assert.ok(
    codes.includes('MATH_FOLD_DOMINANT'),
    `逐层 EV 明显为负 ⇒ 必须给出弃牌硬判，实际：${codes.join(', ')}`,
  );
  assert.ok(
    !codes.includes('LAYERED_POT_EQUITY_UNAVAILABLE'),
    `逐层已经算出来了，不得再声称「判不了方向」，实际：${codes.join(', ')}`,
  );
  assert.equal(r.decision.action, 'FOLD');
});

test('POT-D5：结构性多层 + **某层对手没有范围** ⇒ 仍然不给方向（闸门没被拆掉）', () => {
  /*
   * 6-max，我 SB 30BB：UTG 短码全下 10BB、BTN 全下 30BB，**BB 还没说话**。
   *
   * ```text
   * 我跟注后的层：#0 额 400（UTG+BTN+我+BB）／#1 额 2700（UTG+BTN+我）／#2 额 4000（BTN+我）
   * ```
   *
   * 层 #0 里有 BB —— 他还没行动，因此**没有范围**。那一层的胜率算不出来 ⇒
   * `exact = false` ⇒ `value` 只是保守下界 ⇒ **不得**用它判方向。
   *
   * 这一条是 POT-D3 的**反向保护**：第二阶段能算的才算，算不准的仍然不判。
   */
  const r = analyze(structuralButRangeMissing(['7c', '2d']));
  const math = r.decision.diagnostics.math;
  assert.equal(math.requiredEquityApplies, false, '结构性多层 ⇒ 单一门槛不适用');
  assert.equal(math.layeredEV?.exact, false, '层内有无范围的对手 ⇒ 只能是下界口径');
  assert.ok(
    math.layeredEV!.value < 0 && math.layeredEV!.upperBound > math.layeredEV!.value,
    '下界为负而上界更高 ⇒ 区间跨越 0，正是「判不了」的情形',
  );
  const codes = codesOf(r.decision.reasons);
  assert.ok(
    codes.includes('LAYERED_POT_EQUITY_UNAVAILABLE'),
    `必须给出「逐层也算不出来」的理由，实际：${codes.join(', ')}`,
  );
  assert.equal(r.decision.action, null, '判不了方向时 action 必须为 null');
  assert.equal(r.decision.actionable, false);
});

test('POT-D6：🔴 分层 EV 必须**不小于**门槛口径的下界（口径写反的回归锁）', () => {
  /*
   * ## 这一条锁的是一个 CRITICAL 缺陷（2026-09 修正轮）
   *
   * 分层权益原先用**决策时刻**的底池分层（`computeLayeredPot(state)`），
   * 而 `winnable` 用**跟注之后**的预览（`previewCommit`）——
   * 顺序反了，于是分层 EV 退化成
   *
   * ```text
   * E × contested(决策时刻) − 跟注额
   * ```
   *
   * 它比项目自己的下界 `E × winnable − 跟注额` 还小 `E × (winnable − contested)`，
   * 却被当成 `exact = true` 的「真值」用于**不可翻转的硬判**。
   *
   * ## 为什么这条不等式是本质的
   *
   * 每一层的胜率都**不低于**「赢下所有人」的胜率（要赢的人更少），
   * 而 `Σ 层额 === winnable`。因此正确的分层 EV 必然 ≥ 门槛下界。
   * **违反它，就说明分层用错了状态。**
   */
  for (const cards of [
    ['Ah', 'Ad'],
    ['7c', '6c'],
  ] as const) {
    const r = analyze(multiwayTurn([...cards] as [string, string]));
    const m = r.decision.diagnostics.math;
    assert.equal(m.layeredEV?.exact, true, `${cards.join('')}：必须算出精确分层 EV`);

    const lowerBound = m.heroEquity! * m.winnable - m.callCost;
    const tolerance = 0.02 * m.winnable; // 蒙特卡洛噪声（各层种子不同）
    assert.ok(
      m.layeredEV!.value >= lowerBound - tolerance,
      `${cards.join('')}：分层 EV ${m.layeredEV!.value.toFixed(2)} 小于门槛下界 ` +
        `${lowerBound.toFixed(2)}（容差 ${tolerance.toFixed(2)}）—— 说明分层用的不是跟注后的状态`,
    );
    assert.ok(m.winnable > 0, 'winnable 必须是正数（它是 EV 的基数）');
  }
});

test('POT-D7：🔴 暂时性层不得改变单层局面的判定（红队 F-06 回归锁）', () => {
  /*
   * BB 拿 A♥A♦，UTG 开池 3BB、CO 跟注 —— 我 BB 跟注后**只剩一层**
   *（UTG 与 CO 的钱都在我跟注的覆盖范围内，层界不是结构性的）。
   *
   * 但**决策时刻**（我还没跟注）看起来是两层：
   *
   * ```text
   * 决策时刻：#0 额 350（UTG+CO+BB）／#1 额 400（UTG+CO）
   * 我跟注后：#0 额 950（UTG+CO+BB）          ← 一层
   * ```
   *
   * 修复前「层数 > 1」就去做分层，于是这个局面的 `callEV` 由 479.16 变成 333.31，
   * 动作由 RAISE 变成 CALL —— **一个根本不存在的边池改写了一手 AA 的建议**。
   */
  const r = analyze(bigBlindFacingOpenWithCaller(['Ah', 'Ad']));
  const m = r.decision.diagnostics.math;

  assert.equal(m.requiredEquityApplies, true, '跟注后只剩一层 ⇒ 单一门槛**适用**');
  assert.equal(m.layeredEV, undefined, '门槛适用时**不得**做分层计算（那时它是恒等的）');
  assert.ok(
    Math.abs(m.callEV! - (m.heroEquity! * m.winnable - m.callCost)) < 1e-6,
    `口径必须回到「权益 × 可争夺量 − 跟注额」，实际 ${m.callEV}`,
  );
  assert.equal(
    r.decision.action,
    'RAISE',
    'AA 面对开池 + 跟注应当加注取值（红队 F-01），不得被暂时性层改成跟注',
  );
});

test('POT-D8：暂时性层局面不得出现「单层门槛」与「逐层」并存的自我矛盾', () => {
  const r = analyze(bigBlindFacingOpenWithCaller(['Ah', 'Ad']));
  const codes = codesOf(r.decision.reasons);
  assert.ok(
    !codes.includes('LAYERED_POT_EQUITY_UNAVAILABLE') && !codes.includes('SIDE_POT_LAYERED_EQUITY'),
    `门槛适用的局面不得挂「多人边池」类理由，实际：${codes.join(', ')}`,
  );
  const call = r.decision.diagnostics.candidates.find((c) => c.action === 'CALL');
  const note = call?.feasibleNoteZh ?? '';
  assert.ok(!note.includes('逐层'), `门槛适用的局面不得声称「按逐层胜率算」，实际：${note}`);
});

/** 169 个牌型全 0 权重（用来逼出 `RANGE_COLLAPSE`：对手有投入但范围不可用） */
const ZERO_HAND_WEIGHTS = Object.freeze(
  Object.fromEntries(
    GTO_MATRIX_AXIS.flatMap((a, i) =>
      GTO_MATRIX_AXIS.map((b, j) => [i === j ? `${a}${b}` : i < j ? `${a}${b}s` : `${b}${a}o`, 0]),
    ),
  ),
);

test('POT-D9：🔴 对手范围**缺失**不得被当成「无人能争 ⇒ 胜率 1」', () => {
  /*
   * ## 这一条锁的是审查发现的一个 latent 缺陷（2026-09 修正轮 · A1）
   *
   * `computeLayeredEquity` 里原先的顺序是：
   *
   * ```text
   * 先「把没有范围的对手过滤掉」→ 再看剩几个 → 剩 0 个 ⇒ 胜率按 1
   * ```
   *
   * 于是**「这一层的对手全都没有范围」（数据缺失）**与
   * **「这一层确实只有我一人有资格」（事实清楚）**得到同一个结论。
   * 一个不知道的胜率被写成了 1，`exact` 还报 `true`。
   *
   * 复现：把两家全下对手的范围权重全给 0（`RANGE_COLLAPSE`）——
   * 他们从 `opponentRanges` 消失，但**仍然在层里有资格**。
   *
   * | | 旧实现 | 正确 |
   * |---|---|---|
   * | `heroEquity` | `null`（算不出来） | `null` |
   * | `layeredEV` | `{exact:true, value: 可争夺量 − 跟注额}` | **`undefined`** |
   *
   * ⚠️ 同一个响应里出现「权益算不出来」+「分层精确值 = 必胜」本身就是
   * 自相矛盾；而且经审查确认，修复后的判据（`EV / winnable` 对 ±5% 带）
   * 会让这种假精确值**更容易**跨过阈值 ⇒ 必须堵住。
   */
  const parsed = parseManualInput(multiwayTurn(['Ah', 'Ad']));
  assert.equal(parsed.ok, true, '解析必须成功');
  if (!parsed.ok) return;
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, `门槛必须放行：${gate.ok ? '' : JSON.stringify(gate.issues)}`);
  if (!gate.ok) return;

  const override = {
    weights: ZERO_HAND_WEIGHTS,
    labelZh: '测试：空范围（RANGE_COLLAPSE）',
    engineCommit: null,
    usedActions: [],
    reportedGap: null,
    iterationsCompleted: null,
    /*
     * 本用例只关心「范围塌缩后权益算不出来」，不关心准入结论本身
     * —— 但要**如实标注**这是测试构造的覆盖，不是真求解器产物。
     */
    targetGap: null,
    admitVerdictZh: '（测试构造的范围覆盖，非真实求解器产物）',
  } as const;

  const built = buildDecisionContext({
    rules: RULES,
    asOf: OPTIONS.asOf,
    state: gate.state,
    environment: 'LOW_STAKES_ONLINE',
    solverRanges: { seat_UTG: override, seat_BTN: override },
  });

  const math = built.context.math;
  assert.equal(math.heroEquity, null, '两家范围都塌缩 ⇒ 权益必须算不出来（不得瞎猜）');
  assert.equal(
    math.layeredEV,
    undefined,
    '对手范围缺失时必须判「算不准」—— 绝不能按「无人能争 ⇒ 胜率 1」给出 exact=true 的分层 EV',
  );
});

test('POT-D10：分层 EV 落在**模型容差带**内 ⇒ 仍按真实 EV 排名弃牌，但只标 MARGINAL（不得声称「数学无差异」）', () => {
  /*
   * ⚠️ **本用例在 RIVER CONSISTENCY V2.1 中语义升级（P0-2）**。
   *
   * 旧语义（V2 之前）：分层 EV 与单层共用 5% 带 —— 带内**跟注**，
   * 理由写「没有明显优势，属于边缘局面」。
   *
   * 新语义（V2.1）：那个 5% 是**工程容差**（既不是统计误差，也不是
   * solver error bound，本局面还是精确枚举），**不允许**自动翻转动作 ——
   * `0 > −106` 是确定的，因此动作必须跟随真实 EV 排名（弃牌）。
   * 但结论强度仍然是边缘：只标 `MARGINAL`，且**不得**声称数学上无差异。
   *
   * 局面：UTG 全下 10BB、BTN 全下 20BB、我 BB 30BB 需跟 1900。
   * 实测分层 EV ≈ −106（占可争夺量 −2.1%）⇒ 容差带内。
   */
  const r = analyze(threeWayTwoAllIns(['Ah', 'Kd']));
  const m = r.decision.diagnostics.math;
  assert.equal(m.layeredEV?.exact, true, '必须算出精确分层 EV');
  const ratio = m.layeredEV!.value / m.winnable;
  assert.ok(
    Math.abs(ratio) < 0.05,
    `这个局面必须是「容差带内」才有意义，实际 EV=${m.layeredEV!.value.toFixed(2)} 占 ${(ratio * 100).toFixed(1)}%`,
  );
  assert.ok(m.layeredEV!.value < 0, '这个局面确实是略负的（正因如此才需要「边缘」而不是「成立」）');

  // ① 动作跟随**真实 EV 排名**（FOLD EV ≡ 0 > CALL EV < 0）
  assert.equal(r.decision.action, 'FOLD', '容差带不改变 EV 排名 ⇒ 跟注 EV 为负时必须弃牌');
  // ② 但结论强度仍是边缘（不能标成「明确决策」）
  assert.equal(r.decision.classification, 'MARGINAL', '容差带内的结论必须标成边缘局面');
  // ③ 理由必须如实写清「弃牌 EV 更高」与「容差是工程容差」
  const foldReason = r.decision.reasons.find((x) => x.code === 'MATH_FOLD_DOMINANT');
  assert.notEqual(foldReason, undefined, '必须给出「真实 EV 排名」理由');
  assert.ok(
    foldReason!.textZh.includes('弃牌 EV 更高'),
    `理由必须写出真实 EV 排名，实际：${foldReason!.textZh}`,
  );
  assert.ok(
    foldReason!.textZh.includes('模型容差带') && foldReason!.textZh.includes('工程容差'),
    `理由必须把 5% 说明成工程容差，实际：${foldReason!.textZh}`,
  );
  assert.ok(
    !foldReason!.textZh.includes('数学上没有明显优劣') && !/数学上\*\*没有\*\*明显更优/.test(foldReason!.textZh),
    `不得再把工程容差说成「数学上没有明显优劣」，实际：${foldReason!.textZh}`,
  );
  // ④ 决策依据必须是真实 EV（不是覆盖）
  assert.equal(
    (r.decision.diagnostics.postflop ?? null) === null
      ? 'CHIP_EV'
      : String((r.decision.diagnostics.postflop as unknown as Record<string, unknown>)['decisionBasisKind']),
    'CHIP_EV',
    '本次动作必须由真实 EV 排名选出（未开启不确定性覆盖）',
  );
});

test('POT-D4：单层局面不受影响 —— 门槛就是真门槛，硬判照常生效', () => {
  /*
   * 只有短码全下、我只需面对主池 ⇒ 我只有一层，`权益 < 门槛` ⇔ 负期望。
   * 这一条是**反向保护**：修复不能把闸门整体关掉。
   */
  const r = analyze(headsUpVsShortAllIn(['7c', '6c']));
  const math = r.decision.diagnostics.math;
  assert.equal(math.requiredEquityApplies, true, '单层局面口径必须适用');
  const codes = codesOf(r.decision.reasons);
  assert.ok(
    codes.includes('MATH_FOLD_DOMINANT'),
    `单层局面下「权益低于门槛 ⇒ 负期望」必须照常生效，实际：${codes.join(', ')}`,
  );
  assert.equal(r.decision.action, 'FOLD');
});
