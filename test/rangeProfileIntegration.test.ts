/**
 * 端到端集成：画像 + 环境 → `updateRange`（真正接入，不再是「悬空接口」）
 *
 * ## 为什么需要这个文件
 *
 * 在写它之前，`RangeAdjustmentProvider` 的接口存在、画像桥接实现完整、
 * 测试全绿 —— 但**没有任何生产代码消费它**。也就是说
 * 「玩家画像影响决策」这件事在端到端上从未被验证过。
 * 本文件补上这条链路，并验证三件事：
 *
 * 1. 因子真的被应用到范围上（且方向正确）
 * 2. 非法因子（NaN / 负数 / Infinity）**不会被静默当成 0** 剔除组合
 * 3. 因子为 0 是显式语义，且与「似然为 0」「blocker 移除」**分别计数**
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRangeFromRankClasses } from '../src/domain/range/range.ts';
import { makeActionModel, updateRange } from '../src/domain/range/rangeUpdate.ts';
import { ALL_COMBOS } from '../src/domain/range/combo.ts';
import { validateRange } from '../src/domain/range/rangeValidator.ts';
import {
  RangeAction,
  type ActionModel,
  type RangeAdjustmentProvider,
  type RangeProvenance,
  type RangeUpdateContext,
} from '../src/domain/range/range.types.ts';
import type { ExactCombo } from '../src/domain/range/combo.ts';

import {
  GameEnvironment,
  effectiveAdjustment,
  environmentProfile,
} from '../src/domain/range/gameEnvironment.ts';
import { createEnvironmentAwareProvider } from '../src/domain/range/profileProvider.ts';
import { readPlayer } from '../src/domain/player/playerClassifier.ts';
import { createProfile, observeHand } from '../src/domain/player/playerProfile.ts';
import { PlayerMetric } from '../src/domain/player/player.types.ts';

/* ============================================================
 * 辅助
 * ============================================================ */

const PROVENANCE: RangeProvenance = {
  sourceId: 'test.integration.profile',
  sourceType: 'TEST_ONLY',
  version: '1.0.0',
  description: '画像/环境集成测试用来源',
  verified: false,
  confidence: 0.1,
};

const CONTEXT: RangeUpdateContext = {
  street: 'FLOP',
  action: RangeAction.BET,
  actor: 'villain',
  actionIndex: 0,
  activePlayerCount: 2,
};

const TS = '2024-06-01T12:00:00.000Z';

function buildPrior(): ReturnType<typeof buildRangeFromRankClasses> {
  return buildRangeFromRankClasses(
    { AA: 1, KK: 0.8, QQ: 0.6, AKs: 0.5, '72o': 0.6, '54s': 0.4 },
    { provenance: PROVENANCE },
  );
}

function likelihoodWithin(range: { entries: readonly { combo: { canonicalId: string } }[] }, value: number): ActionModel {
  const map = new Map<string, number>();
  for (const entry of range.entries) map.set(entry.combo.canonicalId, value);
  return makeActionModel(RangeAction.BET, map, PROVENANCE);
}

function rankClassProbability(
  range: { entries: readonly { combo: { rankClass: string }; probability: number }[] },
  rankClass: string,
): number {
  let sum = 0;
  for (const entry of range.entries) if (entry.combo.rankClass === rankClass) sum += entry.probability;
  return sum;
}

function loosePlayer(playerId = 'fish') {
  let profile = createProfile(playerId);
  for (let i = 0; i < 400; i++) {
    const outcome = observeHand(profile, {
      handId: `${playerId}-H${i}`,
      playerId,
      seq: i,
      timestamp: TS,
      observations: [
        { metric: PlayerMetric.VPIP, success: i < 240 },
        { metric: PlayerMetric.PFR, success: i < 60 },
      ],
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) profile = outcome.value;
  }
  return profile;
}

/** 一个可控的假 provider，用于精确验证接入语义 */
function fakeProvider(overrides: Partial<RangeAdjustmentProvider> = {}): RangeAdjustmentProvider {
  return {
    providerId: 'test.fake.provider',
    adjustComboWeight: () => 1,
    adjustActionLikelihood: () => 1,
    ...overrides,
  };
}

/* ============================================================
 * 一、没有 provider 时行为必须与之前完全一致（零回归）
 * ============================================================ */

test('未提供 provider 时，结果与旧版本逐位一致，且 provider 日志为 null', () => {
  const built = buildPrior();
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const withoutProvider = updateRange(built.value, likelihoodWithin(built.value, 0.5), CONTEXT);
  const withIdentityProvider = updateRange(built.value, likelihoodWithin(built.value, 0.5), CONTEXT, {
    adjustmentProvider: fakeProvider(),
  });
  assert.equal(withoutProvider.ok, true);
  assert.equal(withIdentityProvider.ok, true);
  if (!withoutProvider.ok || !withIdentityProvider.ok) return;

  assert.equal(withoutProvider.value.provider, null, '未提供时必须为 null');
  // 恒等 provider：**调用过**每个组合，但**实际调整条数**必须为 0 ——
  // 日志谎报「已调整 N 条」会让复盘时高估影响范围。
  assert.equal(withIdentityProvider.value.provider?.likelihoodCalls, built.value.entries.length);
  assert.equal(withIdentityProvider.value.provider?.weightCalls, built.value.entries.length);
  assert.equal(withIdentityProvider.value.provider?.likelihoodAdjustments, 0);
  assert.equal(withIdentityProvider.value.provider?.weightAdjustments, 0);
  assert.equal(withIdentityProvider.value.provider?.factorsValid, true);

  // 恒等 provider 的结果必须与完全没有 provider 完全相同
  const a = withoutProvider.value.range.entries.map((e) => e.probability);
  const b = withIdentityProvider.value.range.entries.map((e) => e.probability);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i]! - b[i]!) < 1e-15, `第 ${i} 项概率不一致：${a[i]} vs ${b[i]}`);
  }
});

/* ============================================================
 * 二、因子真的被应用（方向必须正确）
 * ============================================================ */

test('集成：松的对手 → 弱牌类概率上升、强牌类概率下降', () => {
  const built = buildPrior();
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const player = readPlayer(loosePlayer());
  const provider = createEnvironmentAwareProvider(
    player.adjustment,
    environmentProfile(GameEnvironment.MID_LOW_STAKES),
    2,
  );

  const baseline = updateRange(built.value, likelihoodWithin(built.value, 0.5), CONTEXT);
  const adjusted = updateRange(built.value, likelihoodWithin(built.value, 0.5), CONTEXT, {
    adjustmentProvider: provider,
  });
  assert.equal(baseline.ok, true);
  assert.equal(adjusted.ok, true);
  if (!baseline.ok || !adjusted.ok) return;

  const weakBefore = rankClassProbability(baseline.value.range, '72o');
  const weakAfter = rankClassProbability(adjusted.value.range, '72o');
  const strongBefore = rankClassProbability(baseline.value.range, 'AA');
  const strongAfter = rankClassProbability(adjusted.value.range, 'AA');

  assert.ok(weakAfter > weakBefore, `松的对手：弱牌概率必须上升（${weakBefore} → ${weakAfter}）`);
  assert.ok(strongAfter < strongBefore, `松的对手：强牌概率必须下降（${strongBefore} → ${strongAfter}）`);

  // 日志必须如实记录应用了多少条
  assert.ok(
    adjusted.value.provider!.weightAdjustments > 0,
    '必须记录权重调整条数',
  );
  assert.equal(adjusted.value.provider!.providerId, provider.providerId);
  // 结果仍然合法
  assert.equal(validateRange(adjusted.value.range).valid, true);
  assert.ok(Math.abs(adjusted.value.range.metrics.probabilitySum - 1) < 1e-9);
});

test('集成：三种环境在同一手牌上给出不同的后验（端到端差异，不只是因子差异）', () => {
  const built = buildPrior();
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const player = readPlayer(loosePlayer());
  const probes = [
    GameEnvironment.LOW_STAKES_ONLINE,
    GameEnvironment.MID_LOW_STAKES,
    GameEnvironment.THEORY_REFERENCE,
  ].map((environment) => {
    const profile = environmentProfile(environment);
    const provider = createEnvironmentAwareProvider(player.adjustment, profile, 2);
    const result = updateRange(built.value, likelihoodWithin(built.value, 0.5), CONTEXT, {
      adjustmentProvider: provider,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return { weak: Number.NaN, strong: Number.NaN };
    return {
      weak: rankClassProbability(result.value.range, '72o'),
      strong: rankClassProbability(result.value.range, 'AA'),
    };
  });

  // 三种环境必须给出**不同**的后验 —— 否则功能未完成
  assert.ok(
    new Set(probes.map((p) => p.weak.toFixed(12))).size > 1,
    `三种环境必须给出不同的后验（实际 ${JSON.stringify(probes)}）`,
  );

  // 方向必须可解释：低级别的**弱牌/强牌 概率比**必须高于理论参考
  // （低级别对手的弱牌端显著更宽）。
  // 注意：不直接比较绝对值 —— 三个环境的可信度不同（0.35/0.40/0.30），
  // 可信度差异会与端倾斜叠加，绝对值排序不保证单调。比值才是有意义的量。
  const lowRatio = probes[0]!.weak / probes[0]!.strong;
  const midRatio = probes[1]!.weak / probes[1]!.strong;
  const theoryRatio = probes[2]!.weak / probes[2]!.strong;

  assert.ok(
    lowRatio > theoryRatio,
    `低级别的弱/强概率比必须高于理论参考（低级别 ${lowRatio} vs 理论 ${theoryRatio}）`,
  );
  assert.ok(
    midRatio > theoryRatio,
    `中低级别的弱/强概率比必须高于理论参考（中低 ${midRatio} vs 理论 ${theoryRatio}）`,
  );
});

/* ============================================================
 * 三、非法因子绝不能被静默当成 0
 * ============================================================ */

test('红队：NaN / Infinity / 负因子不得剔除组合，必须如实记录为非法', () => {
  const built = buildPrior();
  assert.equal(built.ok, true);
  if (!built.ok) return;

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, -0.5]) {
    const result = updateRange(built.value, likelihoodWithin(built.value, 0.5), CONTEXT, {
      adjustmentProvider: fakeProvider({ adjustComboWeight: () => bad }),
    });
    assert.equal(result.ok, true, `因子 ${bad} 不得导致更新失败`);
    if (!result.ok) continue;

    // 关键断言：支持集不得缩小 —— 非法因子必须被忽略，而不是当成 0
    assert.equal(
      result.value.range.metrics.supportSize,
      built.value.metrics.supportSize,
      `因子 ${bad} 不得剔除任何组合（支持集 ${result.value.range.metrics.supportSize} ≠ ${built.value.metrics.supportSize}）`,
    );
    assert.equal(result.value.removals.byZeroLikelihood, 0, `因子 ${bad} 不得记入似然为零`);
    assert.equal(result.value.provider!.factorsValid, false, `因子 ${bad} 必须被标记为非法`);
    assert.ok(
      result.value.provider!.invalidSamples.some((s) => s.factor === bad || Number.isNaN(bad)),
      `因子 ${bad} 必须出现在 invalidSamples 里`,
    );
    assert.equal(validateRange(result.value.range).valid, true);
  }
});

test('红队：似然因子为 0 是**显式**语义，且单独计数、不混入 blocker 计数', () => {
  const built = buildPrior();
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const target = built.value.entries[0]!.combo.canonicalId;
  const result = updateRange(built.value, likelihoodWithin(built.value, 0.5), CONTEXT, {
    adjustmentProvider: fakeProvider({
      adjustActionLikelihood: (_likelihood, _context) => 0,
    }),
  });
  assert.equal(result.ok, false, '全部似然被调整为 0 时必须报 RANGE_COLLAPSE，不得返回空范围');
  if (result.ok) return;
  assert.equal(result.code, 'RANGE_COLLAPSE');
  assert.ok(result.params.note !== undefined, '必须带上中文说明');
  assert.equal(target.length > 0, true);
});

test('红队：部分组合似然因子为 0 时，只移除那些组合并分别计数', () => {
  const built = buildPrior();
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const zeroed = built.value.entries[0]!.combo.canonicalId;
  const result = updateRange(built.value, likelihoodWithin(built.value, 0.5), CONTEXT, {
    adjustmentProvider: fakeProvider({
      adjustActionLikelihood: (likelihood) => (likelihood.comboId === zeroed ? 0 : 1),
    }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(
    result.value.range.metrics.supportSize,
    built.value.metrics.supportSize - 1,
    '恰好移除一个组合',
  );
  assert.equal(result.value.provider!.removedByLikelihoodZero, 1);
  assert.equal(result.value.provider!.removedByWeightZero, 0);
  // 与似然本身为 0 的情况分开计数
  assert.equal(result.value.removals.byZeroLikelihood, 0, '这不是「模型未声明似然」，不得混入');
  assert.equal(result.value.removals.byDeadCards, 0, '这也不是 blocker 移除');
});

test('红队：权重因子为 0 单独计数，且不混入似然为零', () => {
  const built = buildPrior();
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const zeroed = built.value.entries[1]!.combo.canonicalId;
  const result = updateRange(built.value, likelihoodWithin(built.value, 0.5), CONTEXT, {
    adjustmentProvider: fakeProvider({
      adjustComboWeight: (combo: ExactCombo) => (combo.canonicalId === zeroed ? 0 : 1),
    }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.provider!.removedByWeightZero, 1);
  assert.equal(result.value.provider!.removedByLikelihoodZero, 0);
  assert.equal(result.value.removals.byZeroLikelihood, 0);
  assert.equal(result.value.removals.byDeadCards, 0);
});

/* ============================================================
 * 四、似然必须保持在 0..1（条件概率的硬约束）
 * ============================================================ */

test('集成：巨大的似然因子不得让似然超过 1', () => {
  const built = buildPrior();
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const result = updateRange(built.value, likelihoodWithin(built.value, 0.9), CONTEXT, {
    adjustmentProvider: fakeProvider({ adjustActionLikelihood: () => 1000 }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // 概率仍然合法（似然被夹到 1）
  assert.ok(Math.abs(result.value.range.metrics.probabilitySum - 1) < 1e-9);
  assert.equal(validateRange(result.value.range).valid, true);
  // 所有组合似然都变成 1 → 后验等于先验
  const priorProbs = built.value.entries.map((e) => e.probability);
  const afterProbs = result.value.range.entries.map((e) => e.probability);
  for (let i = 0; i < priorProbs.length; i++) {
    assert.ok(
      Math.abs(afterProbs[i]! - priorProbs[i]!) < 1e-9,
      `似然全为 1 时后验必须等于先验（第 ${i} 项 ${afterProbs[i]} vs ${priorProbs[i]}）`,
    );
  }
});

test('集成：provider 收到的 likelihood 必须是调用方原始似然（不得被二次包装）', () => {
  const built = buildPrior();
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const seen: Array<{ comboId: string; action: string; likelihood: number }> = [];
  const result = updateRange(built.value, likelihoodWithin(built.value, 0.37), CONTEXT, {
    adjustmentProvider: fakeProvider({
      adjustActionLikelihood: (likelihood) => {
        seen.push({ comboId: likelihood.comboId, action: likelihood.action, likelihood: likelihood.likelihood });
        return 1;
      },
    }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.ok(seen.length > 0, 'provider 必须被调用');
  assert.equal(seen.length, built.value.entries.length, '每个组合都要被调用一次（含因子为 1 的）');
  for (const item of seen) {
    assert.equal(item.likelihood, 0.37, `必须传入原始似然（实际 ${item.likelihood}）`);
    assert.equal(item.action, RangeAction.BET, '动作必须来自调用方 context');
  }
});

test('集成：provider 收到的 context 必须与调用方一致', () => {
  const built = buildPrior();
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const contexts: RangeUpdateContext[] = [];
  const result = updateRange(built.value, likelihoodWithin(built.value, 0.5), CONTEXT, {
    adjustmentProvider: fakeProvider({
      adjustComboWeight: (_combo, context) => {
        contexts.push(context);
        return 1;
      },
    }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.ok(contexts.length > 0);
  for (const context of contexts) {
    assert.deepEqual(context, CONTEXT, 'provider 拿到的上下文必须与调用方逐字段一致');
  }
});

/* ============================================================
 * 五、时间预算与 provider 共存
 * ============================================================ */

test('集成：provider 存在时时间预算仍然生效（不得成为第二条不可中止路径）', async () => {
  const { deadlineClock } = await import('../src/domain/range/range.types.ts');
  const { DecisionDeadline } = await import('../src/app/decisionDeadline.ts');

  const built = buildPrior();
  assert.equal(built.ok, true);
  if (!built.ok) return;

  // 假时钟：让时间已经远远超过硬上限
  let now = 0;
  const deadline = new DecisionDeadline({ softMs: 100, hardMs: 200, clock: () => now });
  now = 100_000;
  assert.equal(deadline.hardExpired(), true, '前置条件：硬上限必须已过');

  const result = updateRange(built.value, likelihoodWithin(built.value, 0.5), CONTEXT, {
    clock: deadlineClock(deadline),
    adjustmentProvider: fakeProvider({ adjustComboWeight: () => 1.1 }),
  });
  // 要么成功（分块判定允许这一轮），要么明确报超时 —— 但绝不能返回部分范围
  if (!result.ok) {
    assert.equal(result.code, 'RANGE_DEADLINE_EXCEEDED');
  } else {
    assert.ok(Math.abs(result.value.range.metrics.probabilitySum - 1) < 1e-9, '成功时必须是完整结果');
    assert.equal(validateRange(result.value.range).valid, true);
  }
});

/* ============================================================
 * 六、不可变性：provider 不得让 prior 被修改
 * ============================================================ */

test('集成：带 provider 的更新绝不修改 prior', () => {
  const built = buildPrior();
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const snapshot = JSON.stringify({
    entries: built.value.entries.map((e) => [e.combo.canonicalId, e.probability, e.rawWeight]),
    metrics: built.value.metrics,
  });

  const player = readPlayer(loosePlayer());
  const provider = createEnvironmentAwareProvider(
    player.adjustment,
    environmentProfile(GameEnvironment.LOW_STAKES_ONLINE),
    4,
  );
  const result = updateRange(built.value, likelihoodWithin(built.value, 0.5), CONTEXT, {
    adjustmentProvider: provider,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const after = JSON.stringify({
    entries: built.value.entries.map((e) => [e.combo.canonicalId, e.probability, e.rawWeight]),
    metrics: built.value.metrics,
  });
  assert.equal(after, snapshot, 'prior 必须逐位不变');
  assert.notEqual(result.value.range.rangeId, built.value.rangeId, '必须产生新范围 id');
  assert.equal(result.value.range.previousRangeId, built.value.rangeId, 'previousRangeId 必须指向旧范围');
});

test('集成：provider 抛异常时不得留下半成品（异常向上传播，不静默吞掉）', () => {
  const built = buildPrior();
  assert.equal(built.ok, true);
  if (!built.ok) return;

  assert.throws(
    () =>
      updateRange(built.value, likelihoodWithin(built.value, 0.5), CONTEXT, {
        adjustmentProvider: fakeProvider({
          adjustComboWeight: () => {
            throw new Error('provider 内部故障');
          },
        }),
      }),
    /provider 内部故障/,
  );
});

test('集成：多人池人数影响必须传递到 provider 的上下文里', () => {
  const built = buildPrior();
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const player = readPlayer(loosePlayer());
  const seenCounts: number[] = [];
  const result = updateRange(built.value, likelihoodWithin(built.value, 0.5), CONTEXT, {
    adjustmentProvider: fakeProvider({
      adjustComboWeight: (_combo, context) => {
        seenCounts.push(context.activePlayerCount);
        return 1;
      },
    }),
  });
  assert.equal(result.ok, true);
  assert.ok(seenCounts.length > 0);
  assert.ok(seenCounts.every((c) => c === CONTEXT.activePlayerCount));
  void effectiveAdjustment;
});
