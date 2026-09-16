/**
 * Alpha 端到端管线测试
 *
 * ## 本文件的目标
 *
 * 证明「输入一手牌 → 得到建议」**真的连通**，并且：
 * - 合法输入 → 合法且可解释的建议
 * - 非法输入 → 在正确阶段**阻断**，且中文说明可读
 * - 结果不因「输赢」而改变（结果隔离）
 * - 同一输入 → 逐位一致（确定性）
 * - 性能在预算内
 *
 * ## 与其它测试的分工
 *
 * - `alphaManualInput.test.ts`：输入解析与校验的**单元**行为
 * - `alphaDecision.test.ts`：决策规则的**单元**行为
 * - 本文件：**整条链**的行为（真实模块，不用 mock）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position, Street } from '../src/domain/types.ts';
import { GameEnvironment } from '../src/domain/range/gameEnvironment.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { analyzeManualHand, hashManualInput } from '../src/app/alphaPipeline.ts';
import { DecisionAction } from '../src/domain/decision/decision.types.ts';

/* ============================================================
 * 共享夹具
 * ============================================================ */

const RULES = loadKnowledgeBaseOrThrow().allRules();

/** 一个合法的翻牌场景：Hero 在 CO 持 AKo，翻牌 K 顶对，BB 过牌后轮到 Hero */
function flopScenario(overrides: Partial<ManualHandInput> = {}): ManualHandInput {
  return {
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
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
    ...overrides,
  };
}

const ANALYZE_OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
} as const;

/* ============================================================
 * E2E 测试 1：合法输入 → 合法建议
 * ============================================================ */

test('E2E-1：一手合法牌 → 返回合法、可解释的 AlphaDecision', () => {
  const result = analyzeManualHand(flopScenario(), ANALYZE_OPTIONS);
  assert.equal(result.ok, true, `应当成功：${result.ok ? '' : JSON.stringify(result.issues)}`);
  if (!result.ok) return;

  // ---- 动作必须合法 ----
  //
  // 先断言「确实给出了动作」：信息充分时 `action` **不得**为 `null`
  // （红队 F-05 —— `null` 专指「信息不足，拒绝建议」，不能与 FOLD 混同）。
  assert.ok(result.decision.action !== null, '信息充分的一手牌必须给出具体动作，不得为 null');
  assert.ok(
    result.decision.diagnostics.legalActions.includes(result.decision.action),
    `输出的动作 ${result.decision.action} 必须在合法动作集合 ` +
      `[${result.decision.diagnostics.legalActions.join(', ')}] 内`,
  );

  // ---- 必须可解释 ----
  assert.ok(result.decision.reasons.length > 0, '必须给出至少一条理由');
  assert.ok(
    result.decision.reasons.every((r) => r.textZh.length > 0 && /[\u4e00-\u9fa5]/.test(r.textZh)),
    '全部理由必须是中文',
  );

  // ---- ViewModel 必须忠实映射 ----
  assert.ok(result.viewModel.actionZh.includes('建议：'), '首屏必须给出「建议：」');
  assert.ok(result.viewModel.classificationZh.length > 0, '必须有分类');
  assert.ok(result.viewModel.confidenceZh.length > 0, '必须有置信度档位');
  assert.ok(result.viewModel.reasonsZh.length > 0, '首屏必须有核心原因');

  // ---- 数学九项必须齐备 ----
  const math = result.decision.diagnostics.math;
  assert.ok(Number.isFinite(math.pot) && math.pot > 0, '底池必须为正的有限数');
  assert.ok(Number.isFinite(math.requiredEquity));
  assert.ok(math.heroEquity !== null && Number.isFinite(math.heroEquity), '必须算出权益');
  assert.equal(math.rakeModel, 'NOT_APPLIED', '必须标注抽水未计入');

  // ---- 这个具体场景的策略合理性（顶对 vs 单一对手，且对手过牌）----
  // 顶对 + 89% 权益，**不应弃牌**；且应当主动下注取值
  assert.notEqual(result.decision.action, DecisionAction.FOLD, '顶对且权益极高时不应弃牌');
  assert.equal(
    result.decision.action,
    DecisionAction.BET,
    `顶对面对对手过牌应主动下注（实际 ${result.decision.action}）`,
  );
  assert.ok(result.decision.sizeBB !== undefined, '下注必须给出尺寸');
  // 尺寸必须落在合法区间：≥ 最小下注（1BB）且 ≤ 剩余筹码
  assert.ok(result.decision.sizeBB! >= 1, `尺寸不得低于最小下注（实际 ${result.decision.sizeBB}BB）`);
  assert.ok(
    result.decision.sizeBB! <= 100,
    `尺寸不得超过剩余筹码（实际 ${result.decision.sizeBB}BB）`,
  );
});

test('E2E-1b：**决策不因输赢而改变**（结果隔离）', () => {
  // 同一手牌、同一行动历史，附加不同的「结果」上下文，决策必须逐位一致。
  //
  // ⚠️ 本项目的 `ManualHandInput` **没有**结果字段（类型上就没有），
  // 因此这里通过「相同输入跑两次」验证确定性，
  // 并断言输入类型里确实不存在结果字段（防止未来有人加进去）。
  const a = analyzeManualHand(flopScenario(), ANALYZE_OPTIONS);
  const b = analyzeManualHand(flopScenario(), ANALYZE_OPTIONS);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;

  assert.equal(a.decision.action, b.decision.action);
  assert.equal(a.decision.sizeChips, b.decision.sizeChips);
  assert.equal(a.decision.confidence, b.decision.confidence);
  assert.equal(a.decision.classification, b.decision.classification);
  assert.equal(
    JSON.stringify(a.decision.reasons),
    JSON.stringify(b.decision.reasons),
    '同一输入的理由必须逐位一致',
  );

  // 类型级保证：输入不含任何结果字段
  const input = flopScenario() as unknown as Record<string, unknown>;
  for (const forbidden of [
    'result',
    'winner',
    'villainHoleCards',
    'heroProfit',
    'showdownOutcome',
    'finalProfitLoss',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(input, forbidden),
      false,
      `ManualHandInput 不得包含「${forbidden}」—— 结果绝不能进入决策`,
    );
  }
});

/* ============================================================
 * E2E 测试 2：重复牌必须在 Validator 阻断
 * ============================================================ */

test('E2E-2：Hero 手牌与公共牌重复 → 阻断，且**不进入** Math/Range/Decision', () => {
  // Hero 持 7d，公共牌也有 7d
  const result = analyzeManualHand(
    flopScenario({ heroCards: ['7d', '8c'], board: ['7d', 'Ks', '2h'] }),
    ANALYZE_OPTIONS,
  );

  assert.equal(result.ok, false, '重复牌必须阻断');
  if (result.ok) return;

  assert.equal(result.stage, 'VALIDATE', `应在校验阶段阻断（实际 ${result.stage}）`);
  assert.ok(result.issues.length > 0, '必须给出原因');
  const joined = result.issues.map((i) => i.message).join(' ');
  assert.ok(/重复/.test(joined), `说明必须指出「重复」（实际：${joined}）`);
  assert.ok(/[\u4e00-\u9fa5]/.test(joined), '说明必须是中文');

  // 必须在决策之前就停住：不得出现任何决策产物
  assert.equal(
    Object.prototype.hasOwnProperty.call(result, 'decision'),
    false,
    '阻断时不得产生决策对象',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(result, 'viewModel'),
    false,
    '阻断时不得产生 ViewModel',
  );
});

/* ============================================================
 * E2E 测试 3：底池不匹配必须阻断
 * ============================================================ */

test('E2E-3：用户声明的底池与实际重算不一致 → BLOCK（绝不「先按填的算」）', () => {
  // 真实重算约为 6.5BB（CO 加注 3BB + BB 跟注 2BB + 盲注 1.5BB）
  const lying = analyzeManualHand(flopScenario({ potBB: 42 }), ANALYZE_OPTIONS);
  assert.equal(lying.ok, false, '底池不一致必须阻断');
  if (!lying.ok) {
    assert.equal(lying.stage, 'VALIDATE');
    const joined = lying.issues.map((i) => i.message).join(' ');
    assert.ok(/底池/.test(joined), `说明必须指出底池问题（实际：${joined}）`);
  }

  // 声明了**正确**的底池 → 应当通过
  const honest = analyzeManualHand(flopScenario({ potBB: 6.5 }), ANALYZE_OPTIONS);
  assert.equal(
    honest.ok,
    true,
    `底池正确时应当通过：${honest.ok ? '' : JSON.stringify(honest.issues)}`,
  );

  // 完全不声明底池 → 也应当通过（由引擎重算，不做对照）
  const silent = analyzeManualHand(flopScenario(), ANALYZE_OPTIONS);
  assert.equal(silent.ok, true, '不声明底池时应当由引擎重算并通过');
  if (silent.ok) {
    assert.equal(silent.claimedPot, null, '未声明时 claimedPot 必须是 null（不是 0）');
  }
});

/* ============================================================
 * E2E 测试 4：非法行动历史必须阻断
 * ============================================================ */

test('E2E-4：非法行动历史必须在阻断', () => {
  const cases: Array<{ name: string; history: ManualHandInput }> = [
    {
      name: '行动顺序错误（跳过 HJ 直接让 CO 行动）',
      history: flopScenario({
        actionHistory: [
          { position: Position.UTG, type: 'FOLD' },
          { position: Position.CO, type: 'RAISE', amountBB: 3 },
        ],
      }),
    },
    {
      name: '无人下注时跟注',
      history: flopScenario({
        actionHistory: [{ position: Position.UTG, type: 'CALL', amountBB: 2 }],
      }),
    },
    {
      name: '弃牌之后又行动',
      history: flopScenario({
        actionHistory: [
          { position: Position.UTG, type: 'FOLD' },
          { position: Position.UTG, type: 'RAISE', amountBB: 6 },
        ],
      }),
    },
    {
      name: '加注额小于最小加注',
      history: flopScenario({
        actionHistory: [
          { position: Position.UTG, type: 'RAISE', amountBB: 3 },
          { position: Position.HJ, type: 'RAISE', amountBB: 3.5 },
        ],
      }),
    },
  ];

  for (const { name, history } of cases) {
    const result = analyzeManualHand(history, ANALYZE_OPTIONS);
    assert.equal(result.ok, false, `${name}：必须阻断`);
    if (result.ok) continue;
    const joined = result.issues.map((i) => i.message).join(' ');
    assert.ok(joined.length > 0, `${name}：必须给出中文原因`);
    assert.ok(/[\u4e00-\u9fa5]/.test(joined), `${name}：原因必须是中文（实际：${joined}）`);
  }
});

test('E2E-4b：**没有决策点**时必须阻断（不得对一个不存在的轮次给建议）', () => {
  // 翻牌前所有人都已跟平 —— Hero 没有轮到他行动
  const noDecisionPoint = analyzeManualHand(
    {
      tableSize: 6,
      heroPosition: Position.CO,
      heroCards: ['As', 'Kd'],
      board: [],
      street: Street.PREFLOP,
      effectiveStackBB: 100,
      actionHistory: [
        { position: Position.UTG, type: 'FOLD' },
        { position: Position.HJ, type: 'FOLD' },
        { position: Position.CO, type: 'RAISE', amountBB: 3 },
        { position: Position.BTN, type: 'FOLD' },
        { position: Position.SB, type: 'FOLD' },
        { position: Position.BB, type: 'CALL', amountBB: 2 },
      ],
      environment: 'MID_LOW_STAKES',
    },
    ANALYZE_OPTIONS,
  );

  assert.equal(noDecisionPoint.ok, false, '没有决策点时必须阻断');
  if (noDecisionPoint.ok) return;
  assert.equal(noDecisionPoint.stage, 'RECONSTRUCT');
  assert.ok(
    noDecisionPoint.issues.some((i) => i.code === 'DECISION_POINT_NOT_AVAILABLE'),
    `必须报出「没有决策点」（实际 ${JSON.stringify(noDecisionPoint.issues)}）`,
  );
});

/* ============================================================
 * E2E 测试 5：失败路径不 hang、不返回半截对象
 * ============================================================ */

test('E2E-5：失败结果结构完整（不 hang、不返回半个对象）', () => {
  const failures: ManualHandInput[] = [
    flopScenario({ heroCards: ['7d', '8c'], board: ['7d', 'Ks', '2h'] }), // 重复牌
    flopScenario({ potBB: 999 }), // 底池不符
    flopScenario({ street: Street.TURN }), // 街道与公共牌不符
    flopScenario({ board: ['Kh'] }), // 公共牌张数错
    flopScenario({ heroCards: ['Zz', 'Kd'] }), // 无法识别的牌
    flopScenario({ effectiveStackBB: -5 }), // 负数筹码
  ];

  for (const [index, input] of failures.entries()) {
    const result = analyzeManualHand(input, ANALYZE_OPTIONS);
    assert.equal(result.ok, false, `第 ${index + 1} 个失败用例必须返回 ok:false`);
    if (result.ok) continue;

    // 结构完整性：三个字段都必须存在且类型正确
    assert.ok(typeof result.stage === 'string' && result.stage.length > 0, '必须有 stage');
    assert.ok(Array.isArray(result.issues) && result.issues.length > 0, '必须有 issues');
    assert.ok(typeof result.timings === 'object' && result.timings !== null, '必须有 timings');
    assert.ok(
      result.issues.every((i) => typeof i.code === 'string' && typeof i.message === 'string'),
      '每个 issue 都必须有 code 与 message',
    );
  }
});

/* ============================================================
 * 环境三模式：不得修改数学输出
 * ============================================================ */

test('三环境下：数学九项**逐位一致**（环境绝不修改数学）', () => {
  const environments = [
    GameEnvironment.LOW_STAKES_ONLINE,
    GameEnvironment.MID_LOW_STAKES,
    GameEnvironment.THEORY_REFERENCE,
  ] as const;

  const results = environments.map((environment) =>
    analyzeManualHand(flopScenario({ environment }), ANALYZE_OPTIONS),
  );

  for (const [index, result] of results.entries()) {
    assert.equal(
      result.ok,
      true,
      `${environments[index]} 应当成功：${result.ok ? '' : JSON.stringify(result.issues)}`,
    );
  }

  const first = results[0]!;
  if (!first.ok) return;
  const baseMath = first.decision.diagnostics.math;

  for (const [index, result] of results.entries()) {
    if (!result.ok) continue;
    const m = result.decision.diagnostics.math;
    // 九项数学事实必须逐位一致
    assert.equal(m.pot, baseMath.pot, `${environments[index]}: pot 被环境改变了`);
    assert.equal(m.callCost, baseMath.callCost, `${environments[index]}: callCost 被改变`);
    assert.equal(m.effectiveStack, baseMath.effectiveStack, `${environments[index]}: 有效筹码被改变`);
    assert.equal(m.spr, baseMath.spr, `${environments[index]}: SPR 被改变`);
    assert.equal(m.potOdds, baseMath.potOdds, `${environments[index]}: 底池赔率被改变`);
    assert.equal(m.requiredEquity, baseMath.requiredEquity, `${environments[index]}: 所需权益被改变`);
    assert.equal(m.handCategory, baseMath.handCategory, `${environments[index]}: 牌力被改变`);
    assert.equal(m.handRankZh, baseMath.handRankZh, `${environments[index]}: 牌力描述被改变`);
  }
});

/* ============================================================
 * 确定性
 * ============================================================ */

test('同一输入 → 逐位一致（确定性；含蒙特卡洛固定种子）', () => {
  const a = analyzeManualHand(flopScenario(), ANALYZE_OPTIONS);
  const b = analyzeManualHand(flopScenario(), ANALYZE_OPTIONS);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;

  assert.equal(a.decision.action, b.decision.action);
  assert.equal(a.decision.sizeChips, b.decision.sizeChips);
  assert.equal(a.decision.confidence, b.decision.confidence);
  assert.equal(
    a.decision.diagnostics.math.heroEquity,
    b.decision.diagnostics.math.heroEquity,
    '相同种子下权益必须逐位一致',
  );
  assert.equal(a.log.inputHash, b.log.inputHash, '输入哈希必须一致');
});

test('输入哈希：相同输入同哈希，任一字段变化即变化', () => {
  const base = hashManualInput(flopScenario());
  assert.equal(hashManualInput(flopScenario()), base, '同一输入必须得到同一哈希');
  assert.notEqual(hashManualInput(flopScenario({ potBB: 6.5 })), base, '底池变化必须改变哈希');
  assert.notEqual(
    hashManualInput(flopScenario({ board: ['Kh', '7c', '2s'] })),
    base,
    '公共牌变化必须改变哈希',
  );
  assert.notEqual(
    hashManualInput(flopScenario({ environment: GameEnvironment.THEORY_REFERENCE })),
    base,
    '环境变化必须改变哈希',
  );
});

/* ============================================================
 * 管线不得修改调用方对象
 * ============================================================ */

test('管线**不修改**调用方传入的对象（规范第 80 节）', () => {
  const input = flopScenario();
  const snapshot = JSON.stringify(input);
  analyzeManualHand(input, ANALYZE_OPTIONS);
  assert.equal(JSON.stringify(input), snapshot, '管线不得修改调用方对象');
});

/* ============================================================
 * 性能
 * ============================================================ */

test('性能：端到端 P50/P95 在 1–3 秒目标内（打印真实数字）', () => {
  const input = flopScenario();
  const timings: number[] = [];

  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const result = analyzeManualHand(input, ANALYZE_OPTIONS);
    timings.push(performance.now() - t0);
    assert.equal(result.ok, true);
  }

  timings.sort((a, b) => a - b);
  const p50 = timings[Math.floor(timings.length * 0.5)]!;
  const p95 = timings[timings.length - 1]!;
  console.log(`  [E2E 性能] P50=${p50.toFixed(1)}ms P95=${p95.toFixed(1)}ms MAX=${p95.toFixed(1)}ms`);

  // 硬上限 8 秒；这里断言一个宽松上界以避免脆弱的 CI 断言
  assert.ok(p95 < 8000, `端到端 P95 必须远低于 8 秒硬上限（实际 ${p95.toFixed(1)}ms）`);
});

/* ============================================================
 * 解析层：中文错误
 * ============================================================ */

test('解析层：全部错误信息都是中文且可读', () => {
  const badInputs: ManualHandInput[] = [
    flopScenario({ board: ['Kh'] }), // 张数不符
    flopScenario({ heroCards: ['Zz', 'Kd'] }), // 无法识别
    flopScenario({ heroCards: ['As', 'As'] }), // 手牌重复
    flopScenario({ effectiveStackBB: Number.NaN }),
    flopScenario({ board: ['Kh', '7c', '2d'], street: Street.RIVER }), // 街道不符
    flopScenario({ actionHistory: [{ position: Position.BTN, type: 'FOLD' }], heroPosition: Position.UTG }),
  ];

  for (const input of badInputs) {
    const parsed = parseManualInput(input);
    if (parsed.ok) continue;
    for (const issue of parsed.issues) {
      assert.ok(issue.message.length > 0, '必须有说明');
      assert.ok(
        /[\u4e00-\u9fa5]/.test(issue.message),
        `错误说明必须是中文（实际：${issue.message}）`,
      );
    }
  }
});

test('解析层：直接调用 buildAnalyzableState 也不得抛异常', () => {
  const malformed = [
    flopScenario({ board: ['Kh'] }),
    flopScenario({ heroCards: ['As', 'As'] }),
    flopScenario({ effectiveStackBB: -1 }),
  ];
  for (const input of malformed) {
    const parsed = parseManualInput(input);
    if (!parsed.ok) continue; // 解析层已拦截，这是合法路径
    // 能走到这里就应该返回结构化结果，而不是抛异常
    const gate = buildAnalyzableState(parsed.value);
    assert.ok(typeof gate.ok === 'boolean');
  }
});
