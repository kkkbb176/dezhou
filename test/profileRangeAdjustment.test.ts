/**
 * 🔴 **画像 → Range → 权益 / EV 主链**（P0 架构修复 · 验收台）
 *
 * ## 这一组锁什么
 *
 * 使用者点名的架构缺陷：
 *
 * > 人物画像目前没有进入 Villain action-conditioned range 和 Hero equity /
 * > CHIP_EV 主链，只在决策末端充当 preference modifier。
 *
 * 因此这里锁的**不是**「画像让分数动了一点」，而是：
 *
 * | 用例 | 要防止的错误 |
 * |---|---|
 * | T1 | 画像只改末端偏好分，范围 / 权益一字不动 |
 * | T2 | A/B/C 方向不单调（收紧与放松**同时**抬高权益） |
 * | T3 | 画像不能把权益推过门槛（于是永远只能弃牌） |
 * | T4 | 关闭画像时结果与基线**不一致**（说明存在隐藏状态） |
 * | T5 | 同一份证据被计两遍（画像进范围 + 末端偏移同时生效） |
 * | T6 | 画像**凭空造牌**（改变了可达组合集，而不是只改概率） |
 * | T7 | 反向画像（不诈唬型）反而增加诈唬质量 |
 * | T8 | 近期倾向（`AGGRESSION_UP`）逐位无效（修复前实测如此） |
 * | T9 | 工程护栏静默截断（夹了却不说） |
 * | T10 | 手选画像在「无实测数据」时**静默失效**（维度全 0.5 ⇒ 因子恒 1） |
 * | T11 | 先验形状层只作用于一个组合（本轮实测到的真实缺陷） |
 * | T12 | 归一化被破坏（Σp ≠ 1 / 出现负数 / 非有限数） |
 *
 * ## 两个真实节点
 *
 * - **节点 A**（测试局 3）：BTN A♥Q♣，河牌 Q♠8♦3♣6♠K♠，CO 下注 82% 池
 *   —— 权益（17.5%）离所需（31%）差 13.5 个百分点，
 *   任何**有界**画像都不可能翻转它。这里锁**单调性**（不要求翻转）。
 * - **节点 B**（门槛邻近）：BB A♥9♥，河牌 K♣9♠5♦2♥7♣，BTN 半池下注
 *   —— 权益 ≈ 所需（19.20% vs 19.35%），画像**合法地**决定方向。
 *   `BLUFF_HEAVY` / `MANIAC` ⇒ CALL（Call EV > 0），`VERY_TIGHT` ⇒ FOLD。
 *
 * ⚠️ 全部断言都是**相对**的（同局面比不同画像），不锁具体数值 ——
 * 以后调参只要方向还对，测试仍然有效。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import type { ProfileRangeEvidence } from '../src/domain/decision/decision.types.ts';
import {
  ARCHETYPE_DIMENSIONS,
  archetypeDimensionsOf,
  neutralDimensions,
  resolveTendencyDimensions,
  TendencyEvidenceTier,
  ARCHETYPE_CONFIDENCE,
} from '../src/domain/player/archetypeDimensions.ts';
import { createTendencyProvider, OBSERVATION_TILTS } from '../src/domain/player/tendencyProvider.ts';
import { computeAdjustment, type PlayerDimensions } from '../src/domain/player/playerClassifier.ts';
import { SampleTier } from '../src/domain/player/playerStats.ts';
import { comboById } from '../src/domain/range/combo.ts';
import { RangeAction, RangeSource } from '../src/domain/range/range.types.ts';
import { Street, type Card } from '../src/domain/types.ts';
import { advisePostflop } from '../src/app/decision/postflopAdvisor.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const F = (position: string) => ({ position, type: 'FOLD' as const });

/** 节点 B 的公共牌（尺寸通道测试复用同一张牌面） */
const BOARD_CARDS: readonly Card[] = [
  { rank: 11, suit: 's' },
  { rank: 7, suit: 's' },
  { rank: 3, suit: 'd' },
  { rank: 0, suit: 'h' },
  { rank: 5, suit: 'c' },
] as readonly Card[];

/* ============================================================
 * 局面构造
 * ============================================================ */

/** 节点 A：测试局 3（CO 82% 池河牌下注） */
function nodeA(profile: string, hint = 'UNKNOWN'): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['Ah', 'Qc'],
    board: ['Qs', '8d', '3c', '6s', 'Ks'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' },
      { position: 'HJ', type: 'FOLD' },
      { position: 'CO', type: 'RAISE', amountBB: 2.5 },
      { position: 'BTN', type: 'CALL', amountBB: 2.5 },
      { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'FOLD' },
      { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
      { position: 'BTN', type: 'CALL', amountBB: 2, street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 7, street: 'TURN' },
      { position: 'BTN', type: 'CALL', amountBB: 7, street: 'TURN' },
      { position: 'CO', type: 'BET', amountBB: 20, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: hint, stackBB: 100 },
  } as unknown as ManualHandInput;
}

/**
 * 节点 B：**门槛邻近**的抓诈唬节点（BTN 偷盲线 +半池河牌下注）。
 *
 * Hero BB A♥9♥（一对 9）；BTN 开池 3BB → 翻牌半池 → 转牌过牌 → 河牌半池。
 * 实测：权益 ≈ 所需（19.20% vs 19.35%），画像成为**决定性**因素。
 */
function nodeB(profile: string, hint = 'UNKNOWN'): ManualHandInput {
  const flopBet = 1.5;
  /**
   * 河牌下注：实测底池 9.5BB ⇒ 下注 3BB 时所需权益 ≈ 19.35%，
   * 与基线权益（≈ 19.20%）**恰好相邻**（这是本轮扫描出来的门槛邻近节点）。
   */
  const riverBet = 3;
  return {
    tableSize: 9,
    heroPosition: 'BB',
    heroCards: ['Ah', '9h'],
    board: ['Kc', '9s', '5d', '2h', '7c'],
    street: 'RIVER',
    effectiveStackBB: 100,
    seatStacksBB: { UTG: 100, CO: 100, BTN: 100, BB: 100 },
    actionHistory: [
      F('UTG'),
      F('UTG1'),
      F('UTG2'),
      F('LJ'),
      F('HJ'),
      F('CO'),
      { position: 'BTN', type: 'RAISE', amountBB: 3 },
      F('SB'),
      { position: 'BB', type: 'CALL', amountBB: 2 },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'BTN', type: 'BET', amountBB: flopBet, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: flopBet, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'BTN', type: 'CHECK', street: 'TURN' },
      { position: 'BB', type: 'CHECK', street: 'RIVER' },
      { position: 'BTN', type: 'BET', amountBB: riverBet, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: hint, stackBB: 100 },
  } as unknown as ManualHandInput;
}

type Run = {
  action: string | null;
  equity: number | null;
  required: number;
  callEV: number | null;
  margin: string | null;
  evidence: ProfileRangeEvidence | null;
  bluffMassShare: number;
  valueMassShare: number;
};

function run(input: ManualHandInput): Run {
  const result = analyzeManualHand(input, OPTIONS);
  assert.equal(result.ok, true, `必须能分析：${result.ok ? '' : JSON.stringify(result.issues)}`);
  if (!result.ok) throw new Error('unreachable');

  const built = buildContext(input);
  const math = result.decision.diagnostics.math;
  const facts = built.built.context.postflopFacts?.opponentRangeFacts ?? null;

  return {
    action: result.decision.action,
    equity: math.heroEquity,
    required: math.requiredEquity,
    callEV: math.callEV,
    margin: result.decision.diagnostics.decisionMargin?.kind ?? null,
    evidence: result.decision.diagnostics.profileRange ?? null,
    bluffMassShare: facts?.actionMasses?.bluffMassShare ?? 0,
    valueMassShare: facts?.actionMasses?.valueMassShare ?? 0,
  };
}

/** 解析 → 门槛 → 决策上下文（两处测试共用同一份口径） */
function buildContext(input: ManualHandInput) {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, `门槛必须放行：${gate.ok ? '' : JSON.stringify(gate.issues)}`);
  if (!gate.ok) throw new Error('unreachable');

  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    quickProfile: input.villain?.quickProfile,
    ...(input.villain?.dynamicHint === undefined ? {} : { dynamicHint: input.villain.dynamicHint }),
  });
  const hero = gate.state.players.find((p) => p.holeCards !== null)!;
  const legal = deriveLegalActions(gate.state, hero);
  return { built, gate, legal };
}

/* ============================================================
 * T1：A / B / C 单调性（节点 A）
 * ============================================================ */

test('T1：画像必须进入范围主链，且 A(紧) < B(普通) < C(诈唬多) 在**权益与 Call EV** 上单调', () => {
  const cases = {
    veryTight: run(nodeA('VERY_TIGHT')),
    underBluffer: run(nodeA('UNDERBLUFFER')),
    normal: run(nodeA('NORMAL')),
    bluffHeavy: run(nodeA('BLUFF_HEAVY')),
    maniac: run(nodeA('MANIAC')),
  };

  // 画像确实改变了范围（而不是只在末端挪了偏好分）
  for (const [name, r] of Object.entries(cases)) {
    assert.ok(r.evidence !== null, `${name}：必须有画像证据对象`);
    if (name === 'normal') continue; // 中性原型单独在 T3 里锁「不改变任何东西」
    assert.equal(r.evidence!.provider.applied, true, `${name}：画像必须真的改变范围形状`);
  }

  const { veryTight, underBluffer, normal, bluffHeavy, maniac } = cases;
  const maxA = Math.max(veryTight.equity!, underBluffer.equity!);
  const minC = Math.min(bluffHeavy.equity!, maniac.equity!);

  assert.ok(
    maxA < normal.equity!,
    `A 类画像（收紧）必须让抓诈唬权益**下降**：A 最大 ${(maxA * 100).toFixed(3)}% vs B ${(normal.equity! * 100).toFixed(3)}%`,
  );
  assert.ok(
    normal.equity! < minC,
    `C 类画像（诈唬多）必须让抓诈唬权益**上升**：B ${(normal.equity! * 100).toFixed(3)}% vs C 最小 ${(minC * 100).toFixed(3)}%`,
  );

  // Call EV 同向（同一条链：范围 → 权益 → EV）
  assert.ok(
    Math.max(veryTight.callEV!, underBluffer.callEV!) < normal.callEV!,
    `A 类的 Call EV 必须更低：${Math.max(veryTight.callEV!, underBluffer.callEV!).toFixed(3)} vs ${normal.callEV!.toFixed(3)}`,
  );
  assert.ok(
    normal.callEV! < Math.min(bluffHeavy.callEV!, maniac.callEV!),
    `C 类的 Call EV 必须更高：${normal.callEV!.toFixed(3)} vs ${Math.min(bluffHeavy.callEV!, maniac.callEV!).toFixed(3)}`,
  );

  // 诈唬质量单调（这是「他下注范围里的空气」的直接度量）
  const maxABluff = Math.max(veryTight.bluffMassShare, underBluffer.bluffMassShare);
  const minCBluff = Math.min(bluffHeavy.bluffMassShare, maniac.bluffMassShare);
  assert.ok(
    maxABluff <= normal.bluffMassShare && normal.bluffMassShare <= minCBluff,
    `诈唬质量必须单调：A ${(maxABluff * 100).toFixed(3)}% ≤ B ${(normal.bluffMassShare * 100).toFixed(3)}% ` +
      `≤ C ${(minCBluff * 100).toFixed(3)}%`,
  );

  // 组合集不变：画像只改概率
  for (const [name, r] of Object.entries(cases)) {
    assert.equal(
      r.evidence!.combosBefore,
      r.evidence!.combosAfter,
      `${name}：画像不得增删可达组合（${r.evidence!.combosBefore} → ${r.evidence!.combosAfter}）`,
    );
  }

  // 决策边际与模型置信度是两个独立的量
  assert.equal(normal.margin, 'CLEAR_FOLD', '节点 A 的弃牌是明显弃牌（EV 远低于容差带）');
});

/* ============================================================
 * T2：门槛邻近节点 —— 画像合法地翻转动作
 * ============================================================ */

test('T2：门槛邻近节点上，画像必须能把权益推过所需权益（于是 Call EV > 0 且动作变 CALL）', () => {
  const normal = run(nodeB('NORMAL'));
  const veryTight = run(nodeB('VERY_TIGHT'));
  const bluffHeavy = run(nodeB('BLUFF_HEAVY'));
  const maniac = run(nodeB('MANIAC'));

  // 基线：权益略低于所需 ⇒ 弃牌，Call EV < 0
  assert.ok(
    normal.equity! < normal.required,
    `基线（无画像调整）必须略低于门槛：${(normal.equity! * 100).toFixed(2)}% vs ${(normal.required * 100).toFixed(2)}%`,
  );
  assert.equal(normal.action, 'FOLD');
  assert.ok(normal.callEV! < 0, `基线 Call EV 必须为负：${normal.callEV!.toFixed(3)}`);

  // C 类画像：权益被推过门槛 ⇒ Call EV > 0 ⇒ 动作自然变 CALL（不是被覆盖出来的）
  for (const [name, r] of [['BLUFF_HEAVY', bluffHeavy], ['MANIAC', maniac]] as const) {
    assert.ok(
      r.equity! > r.required,
      `${name}：权益必须被推过门槛：${(r.equity! * 100).toFixed(2)}% vs ${(r.required * 100).toFixed(2)}%`,
    );
    assert.ok(r.callEV! > 0, `${name}：Call EV 必须为正：${r.callEV!.toFixed(3)}`);
    assert.equal(r.action, 'CALL', `${name}：动作必须是 CALL（由 EV 排名自然产生）`);
    /*
     * ⚠️ 这里是**边缘跟注**（Call EV 为正但落在工程容差带内）⇒ 边际记 `MARGINAL`。
     * 这不是矛盾：**动作**由 EV 排名决定，**边际**描述离翻面有多远 ——
     * 两者是分开的两个量（见 T13）。
     */
    assert.equal(r.margin, 'MARGINAL', `${name}：这是边缘跟注，边际应记 MARGINAL`);
  }

  // A 类画像：反方向（更该弃牌）
  assert.ok(veryTight.equity! < normal.equity!, 'VERY_TIGHT 必须比基线更低');
  assert.equal(veryTight.action, 'FOLD');

  // 单调性也在这个节点上成立
  assert.ok(
    veryTight.equity! < normal.equity! && normal.equity! < Math.min(bluffHeavy.equity!, maniac.equity!),
    'A < B < C 的权益单调性必须在门槛邻近节点上同样成立',
  );
});

/* ============================================================
 * T3：关闭画像 ⇒ 与基线逐位一致（无隐藏状态）
 * ============================================================ */

test('T3：没有画像（UNKNOWN）时，画像链路必须**完全不参与**（与 NORMAL 逐位一致）', () => {
  const unknown = run(nodeA('UNKNOWN'));
  const normal = run(nodeA('NORMAL'));
  const noVillain = run({
    ...nodeA('UNKNOWN'),
    villain: undefined,
  } as unknown as ManualHandInput);

  assert.equal(unknown.equity, normal.equity, 'UNKNOWN 与 NORMAL 的权益必须逐位相同');
  assert.equal(unknown.callEV, normal.callEV, 'UNKNOWN 与 NORMAL 的 Call EV 必须逐位相同');
  assert.equal(noVillain.equity, normal.equity, '完全没有 villain 字段时也必须逐位相同');

  // UNKNOWN ⇒ 没有证据对象（信息缺失 ≠ 中性调整）
  assert.equal(unknown.evidence, null, 'UNKNOWN 画像不应产生画像证据对象');

  // NORMAL ⇒ 有证据对象，但 applied 必须为 false 且权益前后相同
  assert.ok(normal.evidence !== null);
  assert.equal(normal.evidence!.provider.applied, false, 'NORMAL 原型是中性 ⇒ 不得改变范围');
  assert.equal(normal.evidence!.equityBefore, normal.evidence!.equityAfter, '中性画像的前后权益必须相同');
  assert.equal(normal.evidence!.provider.profileMultiplier.effective, 0, '中性画像的有效因子数必须为 0');
});

/* ============================================================
 * T4：不重复计票（画像进范围 ⇒ 末端抓诈唬偏移归零）
 * ============================================================ */

test('T4：画像进入范围后，末端抓诈唬偏移必须归零并**标注去重**（同一份证据不得计两遍）', () => {
  const { built, legal } = buildContext(nodeB('BLUFF_HEAVY'));
  const advice = advisePostflop(built.context, {
    facingBet: legal.callCost > 0,
    requiredEquity: built.context.math.requiredEquity,
    potAfterCall: built.context.math.pot + legal.callCost,
  });
  assert.ok(advice !== null, '翻后建议器必须给出输出');

  const evidence = built.context.profileRangeEvidence ?? null;
  assert.ok(evidence !== null && evidence.provider.applied, '画像必须已进入范围');

  assert.equal(
    advice!.exploit.bluffCatchDelta,
    0,
    '画像已进入范围 ⇒ 抓诈唬偏移必须记 0（否则同一份证据计两遍）',
  );
  assert.equal(advice!.exploit.deDuplicated, true, '去重必须标注出来');
  assert.ok(
    advice!.reasonsZh.some((t) => t.includes('去重')),
    '理由里必须写明「去重」及其原因（绝不静默）',
  );

  // 信号并没有消失：它在**权益**里（这是本修复的全部意义）
  assert.ok(
    evidence!.equityAfter! > evidence!.equityBefore!,
    '去重之后，画像信号必须体现在权益上（范围 → 权益 → Call EV）',
  );

  // 对照：完全没有画像时，剥削层不得声称去重
  const plain = buildContext(nodeA('UNKNOWN'));
  const plainAdvice = advisePostflop(plain.built.context, {
    facingBet: plain.legal.callCost > 0,
    requiredEquity: plain.built.context.math.requiredEquity,
    potAfterCall: plain.built.context.math.pot + plain.legal.callCost,
  });
  assert.equal(plainAdvice?.exploit.deDuplicated, false, '没有画像时不得声称去重');
});

/* ============================================================
 * T13：决策边际 ≠ 模型置信度（两个必须分开的量）
 * ============================================================ */

test('T13：`decisionMargin`（离翻面多远）与模型置信度（首选比次选好多少）必须分开', () => {
  const deep = analyzeManualHand(nodeA('NORMAL'), OPTIONS);
  const edge = analyzeManualHand(nodeB('BLUFF_HEAVY'), OPTIONS);
  assert.equal(deep.ok, true);
  assert.equal(edge.ok, true);
  if (!deep.ok || !edge.ok) return;

  const deepMargin = deep.decision.diagnostics.decisionMargin;
  const edgeMargin = edge.decision.diagnostics.decisionMargin;

  // 深水区（测试局 3）：真实 EV 远低于容差带 ⇒ CLEAR_FOLD，而**偏好分**给出的
  // 模型置信度是 HIGH（首选明显强于次选）—— 两个量同时成立，毫不矛盾。
  assert.equal(deepMargin?.kind, 'CLEAR_FOLD');
  assert.ok(
    Math.abs(deepMargin!.evChips!) > deepMargin!.bandChips,
    `深水区的 EV 必须落在容差带之外：|${deepMargin!.evChips!.toFixed(2)}| vs ${deepMargin!.bandChips.toFixed(2)}`,
  );
  assert.equal(deep.decision.diagnostics.postflop?.confidence, 'HIGH');
  assert.ok(
    deepMargin!.noteZh.includes('工程容差'),
    '说明里必须标明容差带是工程容差（不是统计误差）',
  );

  // 边缘节点：EV 落在容差带内 ⇒ MARGINAL，但动作仍可以是 CALL
  assert.equal(edgeMargin?.kind, 'MARGINAL');
  assert.ok(Math.abs(edgeMargin!.evChips!) <= edgeMargin!.bandChips);
  assert.equal(edge.decision.action, 'CALL');

  // 两者都进诊断（供界面与 JSONL 追溯），且字段不同名
  assert.notEqual(deepMargin!.kind, edgeMargin!.kind, '两个节点的边际必须可区分');
});

/* ============================================================
 * T5：诈唬倾向必须单调（**同一类别模型内部**）；画像不得改变可达组合集
 * ============================================================ */

/*
 * 🔴 **契约变更（PLAYER PROFILE QUANTIFICATION V1 · 已记录，非放宽）**
 *
 * 修复前本测试以 `NORMAL` 作为「无画像调整」的基线去和 `UNDERBLUFFER` /
 * `BLUFF_HEAVY` 比较。那在**旧模型**下成立，因为旧模型里所有标签都走同一条
 * 档位似然，`NORMAL` 恰好中性。
 *
 * 现在**刻意不是**这样了：`NORMAL` / `UNKNOWN` / `TIGHT` / `VERY_LOOSE` /
 * `AGGRESSIVE` 被 `NEUTRAL_ARCHETYPES` 显式声明为「不改变行为先验」，
 * 并且在 `contextBuilder` 里**不进入类别模型**（闸门
 * `archetypePriorAvailable`）。实测证据：闸门之前 `NORMAL` 的 Hero 权益
 * 33.17% vs 无画像的 17.50% —— 那会让每一个河牌节点被静默重标定，并推翻
 * 与画像无关的决策容差带契约（R4 / ROLE-4 / BAND-1/2/3）。
 *
 * 因此拿 `NORMAL`（旧档位模型）与 `UNDERBLUFFER`（新类别模型）比较是
 * **跨模型比较**——两把尺子，断言在数学上不可能成立。
 *
 * 正确的**单模型**比较是在**有先验的四个原型之间**按诈唬倾向单调，
 * 这恰好就是本测试标题的本意（「反向画像不得增加诈唬质量；正向画像不得
 * 凭空造出价值组合」）。四个原型全部走类别模型，量纲一致。
 */
test('T5：诈唬倾向在有先验的原型之间必须单调（UNDERBLUFFER < LOOSE < BLUFF_HEAVY ≤ MANIAC）', () => {
  const under = run(nodeA('UNDERBLUFFER'));
  const loose = run(nodeA('LOOSE'));
  const heavy = run(nodeA('BLUFF_HEAVY'));
  const maniac = run(nodeA('MANIAC'));
  const neutral = run(nodeA('NORMAL'));

  const pct = (x: number) => `${(x * 100).toFixed(3)}%`;

  // ---- 单模型内：诈唬倾向 ↑ ⇒ 诈唬质量 ↑ ----
  assert.ok(
    under.bluffMassShare < loose.bluffMassShare,
    `少诈唬 < 松：${pct(under.bluffMassShare)} vs ${pct(loose.bluffMassShare)}`,
  );
  assert.ok(
    loose.bluffMassShare < heavy.bluffMassShare,
    `松 < 过度诈唬：${pct(loose.bluffMassShare)} vs ${pct(heavy.bluffMassShare)}`,
  );
  assert.ok(
    heavy.bluffMassShare <= maniac.bluffMassShare,
    `过度诈唬 ≤ 疯子：${pct(heavy.bluffMassShare)} vs ${pct(maniac.bluffMassShare)}`,
  );

  // ---- 同模型内：诈唬倾向 ↑ ⇒ Hero 抓诈唬权益 ↑（他诈唬得越多，顶对越值钱）----
  assert.ok(
    under.equity! < heavy.equity!,
    `少诈唬的权益必须低于过度诈唬：${(under.equity! * 100).toFixed(2)}% vs ${(heavy.equity! * 100).toFixed(2)}%`,
  );

  // ---- 「不得凭空造牌」：可达组合数一字不变（画像只改概率，不改集合）----
  //
  // 这一条**跨模型也成立**，因此仍然拿中性的 NORMAL 作对照。
  assert.equal(heavy.evidence!.combosBefore, neutral.evidence!.combosBefore, '画像不得改变可达组合集');
  assert.equal(heavy.evidence!.combosAfter, neutral.evidence!.combosAfter, '画像不得改变可达组合集');
});

/* ============================================================
 * T6：近期倾向必须真的生效（修复前 `AGGRESSION_UP` 逐位无效）
 * ============================================================ */

test('T6：`AGGRESSION_UP` 必须真的改变范围与权益（且反向提示必须反向）', () => {
  const base = run(nodeA('BLUFF_HEAVY'));
  const hotter = run(nodeA('BLUFF_HEAVY', 'AGGRESSION_UP'));
  const calmer = run(nodeA('BLUFF_HEAVY', 'TIGHTER_RECENTLY'));

  assert.ok(
    hotter.equity! > base.equity!,
    `「近期更凶」必须抬高抓诈唬权益：${(hotter.equity! * 100).toFixed(4)}% vs ${(base.equity! * 100).toFixed(4)}%`,
  );
  assert.ok(
    calmer.equity! < base.equity!,
    `「近期更紧」必须压低抓诈唬权益：${(calmer.equity! * 100).toFixed(4)}% vs ${(base.equity! * 100).toFixed(4)}%`,
  );
  assert.ok(
    hotter.bluffMassShare > base.bluffMassShare,
    '「近期更凶」必须提高诈唬质量',
  );

  const obs = hotter.evidence!.provider.observationMultiplier;
  assert.ok(obs.calls > 0, '观测层必须被调用');
  assert.ok(obs.effective > 0, '观测层必须真的改变似然（修复前是 0）');
  assert.ok(obs.max > 1, `进攻上升必须让弱牌似然变大：${obs.max}`);
  assert.equal(hotter.evidence!.provider.observationApplied, true, '观测层必须标记为已作用');

  // 反向提示的因子必须 < 1
  assert.ok(
    calmer.evidence!.provider.observationMultiplier.min < 1,
    '「近期更紧」必须让弱牌似然变小',
  );
});

/* ============================================================
 * T7：原型表与维度解析的单元不变量
 * ============================================================ */

test('T7：手选画像必须有**维度**（修复前维度全 0.5 ⇒ 因子恒 1 ⇒ 画像静默失效）', () => {
  // NORMAL 是中性原型（全部 0.5）⇒ 因子必须**恰好**为 1
  const neutral = archetypeDimensionsOf('NORMAL', ARCHETYPE_CONFIDENCE)!;
  assert.equal(neutral.tightness, 0.5);
  assert.equal(neutral.aggression, 0.5);
  assert.equal(neutral.bluffTendency, 0.5);
  assert.equal(neutral.passivity, 0.5);

  // UNKNOWN 没有原型证据（是 null，不是「中立原型」）
  assert.equal(archetypeDimensionsOf('UNKNOWN', ARCHETYPE_CONFIDENCE), null);
  assert.equal(ARCHETYPE_DIMENSIONS.UNKNOWN, null);

  // 序关系（表的内容就是这些序关系）
  const tightness = (p: Parameters<typeof archetypeDimensionsOf>[0]): number =>
    archetypeDimensionsOf(p, ARCHETYPE_CONFIDENCE)!.tightness;
  const bluff = (p: Parameters<typeof archetypeDimensionsOf>[0]): number =>
    archetypeDimensionsOf(p, ARCHETYPE_CONFIDENCE)!.bluffTendency;
  assert.ok(tightness('VERY_TIGHT') > tightness('TIGHT'));
  assert.ok(tightness('TIGHT') > tightness('NORMAL'));
  assert.ok(tightness('NORMAL') > tightness('LOOSE'));
  assert.ok(tightness('LOOSE') > tightness('VERY_LOOSE'));
  assert.ok(tightness('VERY_LOOSE') > tightness('MANIAC'));
  assert.ok(bluff('MANIAC') > bluff('BLUFF_HEAVY'));
  assert.ok(bluff('BLUFF_HEAVY') > bluff('NORMAL'));
  assert.ok(bluff('NORMAL') > bluff('UNDERBLUFFER'));

  // 手选画像**没有样本**：不得伪装成实测
  assert.equal(neutral.sampleSize, 0);
  assert.equal(neutral.tier, SampleTier.PRELIMINARY);
});

test('T8：维度解析必须遵守证据优先级（实测 > 断言），且不做两次乘性调整', () => {
  const measured: PlayerDimensions = {
    tightness: 0.9,
    aggression: 0.3,
    bluffTendency: 0.2,
    passivity: 0.6,
    confidence: 0.8,
    sampleSize: 500,
    tier: SampleTier.CONFIRMED,
  };

  // 实测可信度 ≥ 原型上限 ⇒ 只用实测（原型退出）
  const strong = resolveTendencyDimensions({
    measured,
    measuredConfidence: 0.8,
    quickProfile: 'MANIAC',
  });
  assert.equal(strong.tier, TendencyEvidenceTier.MEASURED);
  assert.equal(strong.dimensions.bluffTendency, measured.bluffTendency);
  assert.equal(strong.weights.archetype, 0);

  // 实测很弱 ⇒ 与原型加权合并（权重和为 1，即**只合并一次**）
  const weak = resolveTendencyDimensions({
    measured: { ...measured, confidence: 0.1 },
    measuredConfidence: 0.1,
    quickProfile: 'MANIAC',
  });
  assert.equal(weak.tier, TendencyEvidenceTier.MEASURED_ARCHETYPE_BLEND);
  assert.ok(Math.abs(weak.weights.measured + weak.weights.archetype - 1) < 1e-12, '权重必须和为 1');
  const maniacBluff = ARCHETYPE_DIMENSIONS.MANIAC!.bluffTendency;
  assert.ok(
    weak.dimensions.bluffTendency > measured.bluffTendency &&
      weak.dimensions.bluffTendency < maniacBluff,
    '合并结果必须落在两个估计之间（不是两次相乘）',
  );

  // 什么都没有 ⇒ PRIOR 中立
  const none = resolveTendencyDimensions({
    measured: neutralDimensions(),
    measuredConfidence: 0,
    quickProfile: 'UNKNOWN',
  });
  assert.equal(none.tier, TendencyEvidenceTier.PRIOR);
  assert.equal(none.dimensions.bluffTendency, 0.5);
});

/* ============================================================
 * T9：provider 单元 —— 单调方向、钳位可见、先验层只作用于第一次更新
 * ============================================================ */

/** provider 的调用上下文（字段与 `updateRange` 传入的一致） */
function providerContext(actionIndex: number) {
  return {
    street: Street.RIVER,
    action: RangeAction.BET,
    actor: 'villain',
    actionIndex,
    activePlayerCount: 2,
  };
}

/** 一个真实的似然输入（组合 id 走范围引擎的组合表，不在这里自造一副牌） */
function likelihoodOf(comboId: string) {
  const combo = comboById(comboId);
  assert.ok(combo !== undefined, `${comboId} 必须是合法组合`);
  return {
    comboId,
    action: RangeAction.BET,
    likelihood: 0.5,
    source: RangeSource.HEURISTIC,
    confidence: 0.5,
  };
}

/**
 * 样例组合：弱（7c2d = 72o）、强（AdAc = AA）、中等（KcQd）。
 *
 * ⚠️ canonicalId 的顺序由范围引擎的 `orderCards` 决定（`AdAc` 而不是 `AcAd`），
 * 这里**直接用引擎的组合表**校验，绝不自己拼 id —— 拼错会让 provider
 * 走「未知 comboId」分支（因子 1），测试就会假装通过。
 */
const SAMPLE_IDS = ['7c2d', 'AdAc', 'KcQd', '8h7h', '3s3d'] as const;

test('T9：工程护栏必须**夹了就说**（CLAMP_APPLIED / clampCount 可见）', () => {
  // 极端维度 + 满可信度 ⇒ 必然触发钳位
  const extreme: PlayerDimensions = {
    tightness: 0,
    aggression: 1,
    bluffTendency: 1,
    passivity: 0,
    confidence: 1,
    sampleSize: 999,
    tier: SampleTier.CONFIRMED,
  };
  const provider = createTendencyProvider({
    adjustment: computeAdjustment(extreme, { hasEnoughSample: true }),
    observation: 'TILT_SIGNAL',
  });
  const context = providerContext(1);
  for (const id of SAMPLE_IDS) {
    provider.adjustActionLikelihood!(likelihoodOf(id), context);
  }
  const evidence = provider.evidence();
  assert.ok(evidence.profileMultiplier.max >= evidence.profileMultiplier.min);
  assert.ok(evidence.finalMultiplier.max > 1, '极端进攻画像必须抬高弱牌似然');
  if (evidence.clampApplied) {
    assert.ok(evidence.clampCount > 0, '夹了必须计数');
    assert.ok(
      evidence.noteZh.some((t) => t.includes('CLAMP_APPLIED')),
      '夹了必须在说明里写明（绝不静默）',
    );
  }
  const minFactor = 0.2;
  const maxFactor = 5;
  assert.ok(
    evidence.finalMultiplier.max <= maxFactor + 1e-12 && evidence.finalMultiplier.min >= minFactor - 1e-12,
    `最终因子必须落在护栏 [${minFactor}, ${maxFactor}] 内：${evidence.finalMultiplier.min}–${evidence.finalMultiplier.max}`,
  );
});

test('T10：先验形状层必须作用于**整个第一次更新**，而不是一个组合（本轮实测缺陷）', () => {
  const dims = archetypeDimensionsOf('MANIAC', ARCHETYPE_CONFIDENCE)!;
  const provider = createTendencyProvider({
    adjustment: computeAdjustment(dims, { hasEnoughSample: true }),
    observation: null,
  });
  const context = providerContext(1);
  for (const id of SAMPLE_IDS) {
    provider.adjustActionLikelihood!(likelihoodOf(id), context);
    provider.adjustComboWeight!(comboById(id)!, context);
  }
  const evidence = provider.evidence();
  assert.equal(
    evidence.comboWeightMultiplier.calls,
    SAMPLE_IDS.length,
    `第一次更新的**每个**组合都必须被先验层处理（实际 ${evidence.comboWeightMultiplier.calls}/${SAMPLE_IDS.length}）`,
  );
  assert.ok(
    evidence.comboWeightMultiplier.effective > 1,
    `先验层必须真的改变多个组合（实测缺陷是一个）：${evidence.comboWeightMultiplier.effective}`,
  );

  // 第二次更新调用（不同 actionIndex）⇒ 先验层必须退出（防重复计票）
  const second = providerContext(2);
  for (const id of SAMPLE_IDS) {
    provider.adjustComboWeight!(comboById(id)!, second);
  }
  assert.equal(
    provider.evidence().comboWeightMultiplier.calls,
    SAMPLE_IDS.length,
    '第二次更新不得再施加先验形状层',
  );
});

/* ============================================================
 * T11：归一化 / 有限性（不允许出现 NaN、负数、Σp ≠ 1）
 * ============================================================ */

test('T11：画像调整后范围必须仍然归一化、有限、无负权重', () => {
  const { built } = buildContext(nodeA('MANIAC'));
  for (const snapshot of built.context.opponentRanges) {
    const sum = snapshot.metrics.probabilitySum;
    assert.ok(Math.abs(sum - 1) < 1e-9, `Σp 必须为 1，实际 ${sum}`);
    assert.ok(Number.isFinite(snapshot.metrics.entropyBits), '熵必须是有限数');
  }
  const evidence = built.context.profileRangeEvidence ?? null;
  assert.ok(evidence !== null, '画像证据必须存在');
  assert.ok(
    Number.isFinite(evidence!.provider.finalMultiplier.min) &&
      Number.isFinite(evidence!.provider.finalMultiplier.max),
    '乘数必须是有限数',
  );
  assert.ok(evidence!.provider.finalMultiplier.min > 0, '乘数必须为正');
});

/* ============================================================
 * T12：观察层表本身的不变量
 * ============================================================ */

test('T12：近期倾向表必须方向自洽（AGGRESSION_UP/TILT 抬高弱牌开火，TIGHTER 压低）', () => {
  assert.ok(OBSERVATION_TILTS.AGGRESSION_UP!.weakAggression > 1);
  assert.ok(OBSERVATION_TILTS.TILT_SIGNAL!.weakAggression > OBSERVATION_TILTS.AGGRESSION_UP!.weakAggression);
  assert.ok(OBSERVATION_TILTS.LOOSER_RECENTLY!.weakAggression > 1);
  assert.ok(OBSERVATION_TILTS.TIGHTER_RECENTLY!.weakAggression < 1);
  assert.equal(OBSERVATION_TILTS.UNKNOWN, null);
  assert.equal(OBSERVATION_TILTS.NORMAL, null);
});

/* ============================================================
 * T14：「大注诈唬 / 小注诈唬」—— 尺寸通道必须有界、单调、只作用于弱牌端
 * ============================================================ */

test('T14：尺寸通道（大注弱牌倾斜）必须有界、对小注无效、且只动弱牌端', () => {
  const board = ['Kc', '9s', '5d', '2h', '7c'] as unknown as readonly Card[];
  void board;

  const dims = archetypeDimensionsOf('BLUFF_HEAVY', ARCHETYPE_CONFIDENCE)!;
  const adjustment = computeAdjustment(dims, { hasEnoughSample: true });

  /** 同一组合在给定注码下的最终似然因子 */
  const factorAt = (comboId: string, betSize: number, potSize: number): number => {
    const provider = createTendencyProvider({
      adjustment,
      observation: null,
      boardOfStreet: () => BOARD_CARDS,
    });
    return provider.adjustActionLikelihood!(
      { ...likelihoodOf(comboId) },
      { ...providerContext(1), potSize, betSize },
    );
  };

  const small = factorAt('AcQd', 200, 1000); // 0.2 池：空气（无对）
  const half = factorAt('AcQd', 500, 1000); // 半池
  const pot = factorAt('AcQd', 1000, 1000); // 满池
  const over = factorAt('AcQd', 1500, 1000); // 1.5 倍池

  // 小注 / 半池不放大（基线）；满池及以上放大（且有界）
  assert.equal(small, half, '半池及以下不应触发尺寸通道');
  assert.ok(pot > half, `满池必须比半池更强：${pot} vs ${half}`);
  assert.equal(pot, over, '满池与超池同为最大档（sizeWeight 已饱和到 1）');
  assert.ok(
    pot / half <= 1.25 + 1e-9,
    `尺寸通道必须**有界**（≤ +25%）：实测 +${((pot / half - 1) * 100).toFixed(2)}%`,
  );

  // 只作用于弱牌端：一对（强档）在两个尺寸下必须逐位相同
  const pairSmall = factorAt('3s3d', 200, 1000);
  const pairPot = factorAt('3s3d', 1000, 1000);
  assert.equal(pairSmall, pairPot, '强牌端不得受尺寸通道影响（否则会反转单调性）');

  // 反向画像（不诈唬型）：尺寸通道必须反向（大注上更压低弱牌）
  const honestDims = archetypeDimensionsOf('UNDERBLUFFER', ARCHETYPE_CONFIDENCE)!;
  const honestProvider = createTendencyProvider({
    adjustment: computeAdjustment(honestDims, { hasEnoughSample: true }),
    observation: null,
    boardOfStreet: () => BOARD_CARDS,
  });
  const honestSmall = honestProvider.adjustActionLikelihood!(
    { ...likelihoodOf('AcQd') },
    { ...providerContext(1), potSize: 1000, betSize: 200 },
  );
  const honestPot = honestProvider.adjustActionLikelihood!(
    { ...likelihoodOf('AcQd') },
    { ...providerContext(1), potSize: 1000, betSize: 1000 },
  );
  assert.ok(
    honestPot < honestSmall,
    `不诈唬型在大注上必须更压低弱牌：${honestPot} vs ${honestSmall}`,
  );
});
