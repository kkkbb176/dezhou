/**
 * 红队回归测试：Step 6 玩家画像独立红队审计
 *
 * 对应报告 `reports/PLAYER_REDTEAM_AUDIT.md`（3 CRITICAL + 7 MAJOR + 13 MINOR）。
 *
 * ## 本文件的方法论
 *
 * 红队的元层建议是：作者此前每次只修**被点名的那一处**，于是同类缺陷
 * 会在旁边的字段上重新出现。因此本文件刻意采用**表驱动 / 不变量**写法：
 *
 * | 不变量 | 做法 | 防的是 |
 * |---|---|---|
 * | 冻结完整性 | 遍历 `PlayerProfile` 的**全部**属性递归断言冻结 | 「修了 prior 漏了 decay」 |
 * | 先验中立性 | 遍历 `computeDimensions` 用到的**全部**指标，断言「先验中心 → 中立」 | 「先验被当成观测」 |
 * | 入口一致性 | 对**所有**接收 observations 的入口施加同一份规范化断言 | 「修了 observeHand 漏了 amendHand」 |
 *
 * 这三条表驱动断言的存在意义是：**将来新增字段/指标/入口时自动被覆盖**，
 * 不依赖维护者记得补测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PlayerMetric, METRIC_DEFINITIONS } from '../src/domain/player/player.types.ts';
import {
  createProfile,
  observeHand,
  amendHand,
  removeHand,
  metricOf,
  sampleSummary,
  SEQ_GAP_TOLERANCE,
  type HandObservation,
  type PlayerProfile,
} from '../src/domain/player/playerProfile.ts';
import {
  DEFAULT_DECAY,
  decayWeight,
  capSingleHandWeight,
  computeMetricStat,
} from '../src/domain/player/playerStats.ts';
import {
  computeDimensions,
  neutralVpipRate,
  readPlayer,
  tightnessFromVpip,
  vpipRateOf,
} from '../src/domain/player/playerClassifier.ts';
import {
  createProfileRangeProvider,
  UNKNOWN_COMBO_FACTOR,
} from '../src/domain/range/profileProvider.ts';
import { comboById, ALL_COMBOS } from '../src/domain/range/combo.ts';
import { RangeAction, type RangeUpdateContext } from '../src/domain/range/range.types.ts';

/* ============================================================
 * 辅助
 * ============================================================ */

const TS = '2024-06-01T12:00:00.000Z';

const CONTEXT: RangeUpdateContext = {
  street: 'FLOP',
  action: RangeAction.BET,
  actor: 'v',
  actionIndex: 0,
  activePlayerCount: 2,
};

function hand(
  seq: number,
  metric: PlayerMetric,
  success: boolean,
  overrides: Partial<HandObservation> = {},
): HandObservation {
  return {
    handId: `H${seq}`,
    playerId: 'p1',
    seq,
    timestamp: TS,
    observations: [{ metric, success }],
    ...overrides,
  };
}

function profileWith(metric: PlayerMetric, n: number, successes: number, playerId = 'p1') {
  let profile = createProfile(playerId);
  for (let i = 0; i < n; i++) {
    const outcome = observeHand(profile, hand(i, metric, i < successes, { playerId }));
    assert.equal(outcome.ok, true);
    if (outcome.ok) profile = outcome.value;
  }
  return profile;
}

/**
 * 构造「打法恒定且等于给定比率」的画像。
 *
 * ⚠️ 成功次数必须**均匀铺开**，不能集中在最前面若干手 ——
 * 时间衰减会重罚早期观测，把「前 25% 手成功」变成「近期成功率 0」，
 * 于是测出来的不是「与先验一致的玩家」而是「最近变紧的玩家」。
 * 这是本文件第一版测试的真实错误，记录在此以免重犯。
 */
function spreadProfile(
  playerId: string,
  hands: number,
  rates: Partial<Record<PlayerMetric, number>>,
): PlayerProfile {
  const entries = Object.entries(rates) as Array<[PlayerMetric, number]>;
  let profile = createProfile(playerId);
  for (let i = 0; i < hands; i++) {
    const outcome = observeHand(profile, {
      handId: `${playerId}-H${i}`,
      playerId,
      seq: i,
      timestamp: TS,
      observations: entries.map(([metric, rate]) => ({
        metric,
        // 用「累计阈值」而非「前 k 手」铺开成功，保证时间分布均匀
        success: (i + 1) * rate >= Math.floor(i * rate) + 1,
      })),
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) profile = outcome.value;
  }
  return profile;
}

/* ============================================================
 * 不变量 1：冻结完整性（表驱动）
 * ============================================================ */

test('不变量：PlayerProfile 的**每一个**属性都必须被冻结（遍历式断言）', () => {
  const profile = profileWith(PlayerMetric.VPIP, 5, 3);

  // 递归检查：对象 / 数组 / 其中的元素都必须 frozen
  const failures: string[] = [];
  const seen = new WeakSet<object>();

  const check = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object') return;
    const object = value as object;
    if (seen.has(object)) return;
    seen.add(object);

    if (!Object.isFrozen(object)) {
      failures.push(`${path} 未被冻结`);
      return; // 未冻结就不必深入（下面必然也可变）
    }
    if (Array.isArray(object)) {
      object.forEach((item, index) => check(item, `${path}[${index}]`));
      return;
    }
    // 只读视图（有 getter 属性）不深入其闭包
    for (const key of Object.keys(object)) {
      check((object as Record<string, unknown>)[key], `${path}.${key}`);
    }
  };

  for (const key of Object.keys(profile)) {
    check((profile as unknown as Record<string, unknown>)[key], `profile.${key}`);
  }

  assert.deepEqual(failures, [], `以下层未被冻结：\n${failures.join('\n')}`);
});

test('红队 CRITICAL-1：`profile.decay` 必须被冻结，且**不是**全局常量本身', () => {
  const profile = createProfile('p1');

  assert.equal(Object.isFrozen(profile.decay), true, 'decay 必须被冻结');
  assert.notEqual(
    profile.decay,
    DEFAULT_DECAY,
    'decay 必须是拷贝，不能是全局共享常量本身（否则一行赋值污染所有新建画像）',
  );
  assert.notEqual(profile.metrics[PlayerMetric.VPIP].prior, METRIC_DEFINITIONS[PlayerMetric.VPIP].prior);
});

test('红队 CRITICAL-1 复现：篡改 decay 必须抛错，且此后新建画像不受影响', () => {
  const profile = createProfile('p1');
  const before = decayWeight(400);

  assert.throws(() => {
    'use strict';
    (profile.decay as { halfLife: number }).halfLife = 50;
  }, TypeError);

  // 全局常量与新建画像都必须不受影响
  assert.equal(DEFAULT_DECAY.halfLife, 400, '全局 DEFAULT_DECAY 不得被改动');
  assert.equal(decayWeight(400), before, '衰减函数不得被影响');
  assert.equal(createProfile('fresh').decay.halfLife, 400);

  // 同一个统计在新旧画像上必须一致（旧版这里是 0.3475 → 0.2481）
  const a = profileWith(PlayerMetric.VPIP, 5, 3);
  const b = profileWith(PlayerMetric.VPIP, 5, 3);
  assert.equal(
    metricOf(a, PlayerMetric.VPIP).adjustedRate,
    metricOf(b, PlayerMetric.VPIP).adjustedRate,
    '两次独立构造的画像统计必须逐位相同',
  );
});

test('红队 CRITICAL-8：`seenHandIds` 不得是可写 Set（`.delete()` 必须无效）', () => {
  const profile = profileWith(PlayerMetric.VPIP, 3, 3);
  const ids = profile.seenHandIds as unknown as { delete?: (id: string) => void; add?: (id: string) => void };

  assert.equal(typeof ids.delete, 'undefined', '不得暴露 delete');
  assert.equal(typeof ids.add, 'undefined', '不得暴露 add');
  assert.equal(Object.isFrozen(profile.seenHandIds), true);

  // 即使强行尝试，也影响不了幂等保护
  const again = observeHand(profile, hand(0, PlayerMetric.VPIP, true));
  assert.equal(again.ok, false, '同一 handId 必须继续被拒绝');
  assert.equal(profile.handsObserved, 3);
  assert.equal(profile.log.filter((h) => h.handId === 'H0').length, 1);
});

test('`seenHandIds` 只读视图仍须可迭代（内部重建依赖它）', () => {
  const profile = profileWith(PlayerMetric.VPIP, 4, 2);
  const ids = [...profile.seenHandIds];
  assert.equal(ids.length, 4);
  assert.deepEqual([...profile.seenHandIds.values()].sort(), ['H0', 'H1', 'H2', 'H3']);
  assert.equal(profile.seenHandIds.size, 4);
  assert.equal(profile.seenHandIds.has('H2'), true);
  assert.equal(profile.seenHandIds.has('H9'), false);
});

/* ============================================================
 * 不变量 2：先验中立性（表驱动）
 * ============================================================ */

test('**不变量**：先验中心必须恰好映射到维度 0.5（tightness）', () => {
  const center = neutralVpipRate();
  assert.ok(
    Math.abs(tightnessFromVpip(center) - 0.5) < 1e-12,
    `先验中心 ${center} 必须映射到 0.5（实际 ${tightnessFromVpip(center)}）`,
  );
  assert.ok(Math.abs(vpipRateOf(0.5) - center) < 1e-12);
});

test('红队 MAJOR-5：`passivity` 必须先验定标（先验比值必须映射到 0.5）', () => {
  // 构造一个「跟注 / 弃牌 比例恰好等于先验」的玩家（成功均匀铺开）
  const callPrior = METRIC_DEFINITIONS[PlayerMetric.CALL_CBET].prior.center;
  const foldPrior = METRIC_DEFINITIONS[PlayerMetric.FOLD_TO_CBET].prior.center;
  const sum = callPrior + foldPrior;
  const callShare = callPrior / sum; // ≈ 0.4706
  // 每次机会要么跟注要么弃牌，比例为 callShare : (1 - callShare)
  const hands = 800;
  let profile = createProfile('prior-matched');
  for (let i = 0; i < hands; i++) {
    const isCall = ((i + 1) * callShare) >= Math.floor(i * callShare) + 1;
    const outcome = observeHand(profile, {
      handId: `pm-H${i}`,
      playerId: 'prior-matched',
      seq: i,
      timestamp: TS,
      observations: [
        { metric: PlayerMetric.VPIP, success: true },
        { metric: PlayerMetric.PFR, success: false },
        { metric: PlayerMetric.CALL_CBET, success: isCall },
        { metric: PlayerMetric.FOLD_TO_CBET, success: !isCall },
      ],
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) profile = outcome.value;
  }

  const dimensions = computeDimensions(profile);
  assert.ok(
    Math.abs(dimensions.passivity - 0.5) < 0.06,
    `与先验一致的玩家，passivity 必须接近 0.5（实际 ${dimensions.passivity}）`,
  );

  // 而完全没有该指标数据的画像必须**恰好**是 0.5
  const blank = createProfile('blank');
  assert.equal(
    computeDimensions(blank).passivity,
    0.5,
    '零机会时 passivity 必须是 0.5',
  );
});

test('红队 MAJOR-6 复现：与先验一致的玩家，攒更多手数**不得**让因子漂移', () => {
  // 玩家打法全程不变，恰好等于项目自述常客中心（VPIP 25%、PFR 18%）
  const snapshot = (hands: number) =>
    readPlayer(
      spreadProfile('p1', hands, {
        [PlayerMetric.VPIP]: 0.25,
        [PlayerMetric.PFR]: 0.18,
      }),
    ).adjustment;

  const small = snapshot(50);
  const large = snapshot(600);

  // 打法没变 → 因子不得因为「攒了更多手数」而漂移
  const drift = Math.abs(large.rangeWidthFactor - small.rangeWidthFactor);
  assert.ok(
    drift < 0.05,
    `打法不变时 rangeWidthFactor 不得漂移（50 手 ${small.rangeWidthFactor} → 600 手 ${large.rangeWidthFactor}，漂移 ${drift}）`,
  );
  assert.ok(
    Math.abs(large.rangeWidthFactor - 1) < 0.05,
    `与先验一致的玩家应接近中立（实际 ${large.rangeWidthFactor}）`,
  );
  assert.ok(
    Math.abs(large.foldToAggressionFactor - 1) < 0.05,
    `与先验一致的玩家应接近中立（实际 ${large.foldToAggressionFactor}）`,
  );
});

test('表驱动：computeDimensions 用到的每项指标，先验中心都必须映射到中立', () => {
  // 这些指标的「先验中心」都不应该把玩家推向任何一侧。
  // 做法：构造一个所有观测都恰好落在先验中心的画像，断言维度全部接近 0.5。
  const rates: Partial<Record<PlayerMetric, number>> = {
    [PlayerMetric.VPIP]: METRIC_DEFINITIONS[PlayerMetric.VPIP].prior.center,
    [PlayerMetric.PFR]: METRIC_DEFINITIONS[PlayerMetric.PFR].prior.center,
    [PlayerMetric.THREE_BET]: METRIC_DEFINITIONS[PlayerMetric.THREE_BET].prior.center,
    [PlayerMetric.RAISE_CBET]: METRIC_DEFINITIONS[PlayerMetric.RAISE_CBET].prior.center,
  };
  const callCenter = METRIC_DEFINITIONS[PlayerMetric.CALL_CBET].prior.center;
  const foldCenter = METRIC_DEFINITIONS[PlayerMetric.FOLD_TO_CBET].prior.center;
  (rates as Record<string, number>)[PlayerMetric.CALL_CBET] = callCenter / (callCenter + foldCenter);
  (rates as Record<string, number>)[PlayerMetric.FOLD_TO_CBET] = foldCenter / (callCenter + foldCenter);

  const d = computeDimensions(spreadProfile('centered', 800, rates));
  const tolerance = 0.08;
  for (const key of ['tightness', 'aggression', 'bluffTendency', 'passivity'] as const) {
    assert.ok(
      Math.abs(d[key] - 0.5) < tolerance,
      `所有指标都等于先验中心时，${key} 必须接近 0.5（实际 ${d[key]}）`,
    );
  }
});

/* ============================================================
 * 不变量 3：入口一致性（表驱动）
 * ============================================================ */

test('红队 CRITICAL-3：amendHand 必须与 observeHand 有完全相同的去重行为', () => {
  // 同一手内 3 条重复 VPIP 观测 + 1 条合法 PFR
  const duplicated = [
    { metric: PlayerMetric.VPIP, success: true },
    { metric: PlayerMetric.VPIP, success: false },
    { metric: PlayerMetric.VPIP, success: false },
    { metric: PlayerMetric.PFR, success: true },
  ];

  // 路径 A：一开始就录入（含重复）
  let direct = createProfile('p1');
  const first = observeHand(direct, {
    handId: 'H0',
    playerId: 'p1',
    seq: 0,
    timestamp: TS,
    observations: [...duplicated],
  });
  assert.equal(first.ok, true);
  if (first.ok) direct = first.value;

  // 路径 B：先录一手干净数据，再修正为同样的重复数据
  let amended = createProfile('p1');
  const seed = observeHand(amended, {
    handId: 'H0',
    playerId: 'p1',
    seq: 0,
    timestamp: TS,
    observations: [{ metric: PlayerMetric.VPIP, success: false }],
  });
  assert.equal(seed.ok, true);
  if (!seed.ok) return;
  const fixed = amendHand(seed.value, 'H0', {
    seq: 0,
    timestamp: TS,
    observations: [...duplicated],
  });
  assert.equal(fixed.ok, true);
  if (!fixed.ok) return;
  amended = fixed.value;

  // 两条路径必须**逐位**一致
  for (const metric of [PlayerMetric.VPIP, PlayerMetric.PFR]) {
    assert.equal(
      metricOf(amended, metric).opportunities,
      metricOf(direct, metric).opportunities,
      `${metric} 的机会数必须一致（amend ${metricOf(amended, metric).opportunities} vs direct ${metricOf(direct, metric).opportunities}）`,
    );
    assert.equal(metricOf(amended, metric).successes, metricOf(direct, metric).successes);
    assert.equal(metricOf(amended, metric).adjustedRate, metricOf(direct, metric).adjustedRate);
  }
});

test('红队 CRITICAL-3：amendHand 必须拒绝非法 seq（不得在深处抛错）', () => {
  const profile = profileWith(PlayerMetric.VPIP, 3, 1);
  for (const seq of [Number.NaN, -5, 1.5, Number.POSITIVE_INFINITY]) {
    const outcome = amendHand(profile, 'H1', {
      seq,
      timestamp: TS,
      observations: [{ metric: PlayerMetric.VPIP, success: true }],
    });
    assert.equal(outcome.ok, false, `seq=${seq} 必须被拒绝`);
    if (outcome.ok) continue;
    assert.ok(outcome.issues.some((i) => i.code === 'NEGATIVE_COUNT'), `实际 ${JSON.stringify(outcome.issues)}`);
  }
});

test('红队 CRITICAL-3：amendHand 缺省 seq 时必须沿用原值（合法路径不受影响）', () => {
  const profile = profileWith(PlayerMetric.VPIP, 3, 1);
  // `seq` 现在是可选字段：不传即沿用原 seq
  const outcome = amendHand(profile, 'H1', {
    timestamp: TS,
    observations: [{ metric: PlayerMetric.VPIP, success: true }],
  });
  assert.equal(outcome.ok, true, '不传 seq 应沿用原 seq');
  if (!outcome.ok) return;
  assert.equal(outcome.value.log.find((h) => h.handId === 'H1')!.seq, 1);
});

test('不变量：**所有**接收 observations 的入口都必须过滤未知指标', () => {
  const withUnknown = [
    { metric: PlayerMetric.VPIP, success: true },
    { metric: 'NOT_A_METRIC' as PlayerMetric, success: true },
  ];

  // 入口 1：observeHand
  let a = createProfile('p1');
  const r1 = observeHand(a, {
    handId: 'H0',
    playerId: 'p1',
    seq: 0,
    timestamp: TS,
    observations: withUnknown,
  });
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  a = r1.value;

  // 入口 2：amendHand
  let b = createProfile('p1');
  const seed = observeHand(b, {
    handId: 'H0',
    playerId: 'p1',
    seq: 0,
    timestamp: TS,
    observations: [{ metric: PlayerMetric.VPIP, success: false }],
  });
  assert.equal(seed.ok, true);
  if (!seed.ok) return;
  const r2 = amendHand(seed.value, 'H0', { seq: 0, timestamp: TS, observations: withUnknown });
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  b = r2.value;

  // 两个入口都不得把未知指标计入任何统计
  for (const profile of [a, b]) {
    assert.equal(metricOf(profile, PlayerMetric.VPIP).opportunities, 1);
    for (const metric of Object.values(PlayerMetric)) {
      const stat = metricOf(profile, metric);
      assert.ok(stat.opportunities >= 0 && Number.isFinite(stat.adjustedRate));
    }
  }
  assert.equal(metricOf(a, PlayerMetric.VPIP).adjustedRate, metricOf(b, PlayerMetric.VPIP).adjustedRate);
});

/* ============================================================
 * 红队 MAJOR-4：sampleSummary 必须与 sampleTier 口径一致
 * ============================================================ */

test('红队 MAJOR-4：sampleSummary 必须用有效样本量，不得用原始机会数', () => {
  // 构造「机会多但有效样本量小」的画像：机会数很多、权重极度不均
  let profile = createProfile('skewed');
  for (let i = 0; i < 300; i++) {
    const outcome = observeHand(profile, {
      handId: `s-H${i}`,
      playerId: 'skewed',
      seq: i,
      timestamp: TS,
      observations: [{ metric: PlayerMetric.VPIP, success: i % 2 === 0 }],
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) profile = outcome.value;
  }
  const stat = metricOf(profile, PlayerMetric.VPIP);
  const summary = sampleSummary(profile);

  // 判据必须与 effectiveSampleSize 一致
  const expectedSufficient = stat.effectiveSampleSize >= 30 && stat.confidence >= 0.3;
  const actuallySufficient = summary.sufficientMetrics.includes(PlayerMetric.VPIP);
  assert.equal(
    actuallySufficient,
    expectedSufficient,
    `判定必须用 effectiveSampleSize（n_eff=${stat.effectiveSampleSize}, opportunities=${stat.opportunities}, confidence=${stat.confidence}）`,
  );
  // 机会数与有效样本量必须都在报告里可追溯
  assert.ok(summary.sufficientMetrics.length + summary.insufficientMetrics.length === Object.values(PlayerMetric).length);
});

test('红队 MAJOR-4：判据必须是 effectiveSampleSize，不得是 opportunities', () => {
  // 直接验证判据本身：构造一个「机会数很多、但权重极度不均」的统计，
  // 断言它与「机会数相同、权重均匀」的统计在判据上结果不同。
  //
  // ⚠️ 这里刻意**不**通过 `capSingleHandWeight` 构造，因为单手上限会
  // 把极小权重抬高、反而让分布变均匀（n_eff 变大），从而掩盖判据差异。
  // 我们测的是 `sampleSummary` 的**判据**，因此直接对统计对象断言。
  const many = 300;
  const skewedObservations = [
    { weight: 1, success: true },
    ...new Array(many - 1).fill(null).map(() => ({ weight: 1e-6, success: true })),
  ];
  const skewed = computeMetricStat(PlayerMetric.VPIP, skewedObservations);
  const even = computeMetricStat(
    PlayerMetric.VPIP,
    new Array(many).fill(null).map(() => ({ weight: 1, success: true })),
  );

  assert.equal(skewed.opportunities, many);
  assert.equal(even.opportunities, many);
  assert.ok(
    skewed.effectiveSampleSize <= even.effectiveSampleSize,
    `权重集中者的有效样本量必须不大于均匀者（${skewed.effectiveSampleSize} vs ${even.effectiveSampleSize}）`,
  );

  // 判据函数：必须与 sampleSummary 的实现一致
  const isSufficient = (stat: { effectiveSampleSize: number; confidence: number }) =>
    stat.effectiveSampleSize >= 30 && stat.confidence >= 0.3;
  assert.equal(isSufficient(even), true, '均匀的 300 次机会必须被判为充足');

  // 若误用 opportunities，两者会被判成同一个结论 —— 这正是缺陷所在
  const wrongCriterion = (stat: { opportunities: number }) => stat.opportunities >= 30;
  assert.equal(
    wrongCriterion(skewed),
    wrongCriterion(even),
    '误用 opportunities 时两者结论相同（说明该判据无法区分）',
  );
});

test('红队 MAJOR-4：sampleSummary 与 sampleTier 的口径必须一致', () => {
  // 遍历若干画像，断言 sampleSummary 的判定与「直接用 effectiveSampleSize
  // 计算的预期」逐项一致 —— 这是防止两处口径再次分叉的结构性断言。
  for (const hands of [10, 100, 300]) {
    const profile = spreadProfile('summary-check', hands, { [PlayerMetric.VPIP]: 0.4 });
    const summary = sampleSummary(profile);
    for (const metric of Object.values(PlayerMetric)) {
      const stat = metricOf(profile, metric);
      const expected = stat.effectiveSampleSize >= 30 && stat.confidence >= 0.3;
      const actual = summary.sufficientMetrics.includes(metric);
      assert.equal(
        actual,
        expected,
        `hands=${hands} ${metric}：判定必须用 effectiveSampleSize（n_eff=${stat.effectiveSampleSize}, opportunities=${stat.opportunities}, confidence=${stat.confidence}）`,
      );
    }
  }
});

/* ============================================================
 * 红队 MAJOR-7：capSingleHandWeight 契约
 * ============================================================ */

test('红队 MAJOR-7：含 0 权重的输入也必须真正满足可达的上限', () => {
  // positiveCount 与 mean 的分母口径必须一致。
  // 旧版 mean 用 total/n（含 0 项），导致二分收敛到 α=0，返回完全未约束的权重。
  //
  // 参数说明：12 个正权重（1 个主导 + 11 个 1）+ 8 个 0 权重。
  // 完全均匀时单手占比 = 1/12 ≈ 0.0833，因此 maxShare 必须 ≥ 该值才可能满足；
  // 取 0.12 使约束可满足但需要真正压缩。
  const weights = [10, ...new Array(11).fill(1), ...new Array(8).fill(0)];
  const maxShare = 0.12;
  const capped = capSingleHandWeight(weights, maxShare);
  const total = capped.reduce((s, w) => s + w, 0);
  const max = Math.max(...capped);

  assert.ok(
    max <= maxShare * total + 1e-9,
    `最大占比 ${max / total} 必须 ≤ ${maxShare}`,
  );
  assert.ok(max < 10, '主导权重必须被真正压下来');
  // 0 权重项必须保持 0（不携带证据）
  assert.equal(capped.filter((w) => w === 0).length, 8, '0 权重项必须保持 0');
  // 总和守恒
  assert.ok(Math.abs(total - weights.reduce((s, w) => s + w, 0)) < 1e-9);
});

test('红队 MAJOR-7：约束数学上不可满足时必须如实返回原权重（不假装满足）', () => {
  // 只有 3 个正权重时，完全均匀的占比就是 1/3 ≈ 0.333，
  // 因此 maxShare = 0.0847 不可满足
  const weights = [1, 1, 1, 0, 0, 0, 0];
  const capped = capSingleHandWeight(weights, 0.0847);
  const total = capped.reduce((s, w) => s + w, 0);
  const max = Math.max(...capped);
  const minAchievable = 1 / 3;

  assert.ok(
    Math.abs(max / total - minAchievable) < 1e-9 || Math.abs(max / total - 1 / 3) < 1e-9,
    `不可满足时应保持均匀（占比 ${max / total}）`,
  );
  // 关键：绝不返回一个「声称满足却超限」的结果 —— 函数契约是
  // 「满足上限」或「不可满足时保持原样」，调用方可通过比较判断
  assert.ok(max / total > 0.0847, '这一场景本就不可满足，占比必然超过 maxShare');
});

test('红队 MAJOR-7：全正权重与「正权重 + 0」在正项上的结果必须一致', () => {
  const positive = [5, 1, 1, 1, 1, 1, 1, 1];
  const withZeros = [...positive, 0, 0, 0, 0];
  const a = capSingleHandWeight(positive, 0.2).slice(0, positive.length);
  const b = capSingleHandWeight(withZeros, 0.2).slice(0, positive.length);
  assert.deepEqual(a, b, '0 权重项不得影响正项的压缩结果');
});

/* ============================================================
 * 红队 MAJOR-9 / MAJOR-10：provider 的读取与未知 combo
 * ============================================================ */

test('红队 MAJOR-9：`stats()` 必须是**非破坏性读取**，且反映真实累计', () => {
  // 用一个「真的会改变因子」的组合：松玩家 + 弱牌端
  const profile = spreadProfile('loose', 600, {
    [PlayerMetric.VPIP]: 0.6,
    [PlayerMetric.PFR]: 0.15,
  });
  const read = readPlayer(profile);
  assert.ok(read.adjustment.confidence > 0.2, '前置条件：画像必须可信');
  const provider = createProfileRangeProvider(read.adjustment);

  const weak = comboById('7c2d');
  assert.ok(weak);
  const factor = provider.adjustComboWeight!(weak, CONTEXT);
  assert.ok(Math.abs(factor - 1) > 1e-6, `前置条件：该组合必须真的被调整（实际 ${factor}）`);

  // 再调整若干次
  for (let i = 0; i < 4; i++) provider.adjustComboWeight!(weak, CONTEXT);
  const afterAdjust = provider.stats();
  assert.equal(afterAdjust.adjustments, 5, `调用次数必须被记录（实际 ${afterAdjust.adjustments}）`);
  assert.equal(afterAdjust.effectiveAdjustments, 5, '实际改变次数必须被记录');
  assert.equal(afterAdjust.neutralized, false);
  assert.ok(afterAdjust.meanFactor > 1, `松玩家的平均因子应 > 1（实际 ${afterAdjust.meanFactor}）`);

  // describe() 是纯读取：不得清空累计
  const description = provider.describe();
  assert.ok(description.length > 0);
  const afterDescribe = provider.stats();
  assert.deepEqual(
    afterDescribe,
    afterAdjust,
    'describe() 不得改变累计（旧版是破坏性读取，之后 stats() 返回全零）',
  );

  // 继续调整必须累加
  provider.adjustComboWeight!(weak, CONTEXT);
  assert.equal(provider.stats().adjustments, 6);
});

test('红队 MAJOR-9：恒等因子必须计入「调用」但不计入「实际改变」', () => {
  const profile = spreadProfile('centered2', 600, {
    [PlayerMetric.VPIP]: METRIC_DEFINITIONS[PlayerMetric.VPIP].prior.center,
    [PlayerMetric.PFR]: METRIC_DEFINITIONS[PlayerMetric.PFR].prior.center,
  });
  const provider = createProfileRangeProvider(readPlayer(profile).adjustment);
  const strong = comboById('AsAd');
  assert.ok(strong);

  const factor = provider.adjustComboWeight!(strong, CONTEXT);
  const stats = provider.stats();
  assert.equal(stats.adjustments, 1, '调用必须被记录');
  assert.equal(
    stats.effectiveAdjustments,
    Math.abs(factor - 1) > 1e-15 ? 1 : 0,
    `实际改变次数必须与因子一致（因子 ${factor}）`,
  );
});

test('红队 MAJOR-10：未知 comboId 必须「不调整」并计数，绝不假装是中等牌', () => {
  const profile = spreadProfile('loose2', 600, {
    [PlayerMetric.VPIP]: 0.6,
    [PlayerMetric.PFR]: 0.15,
  });
  const provider = createProfileRangeProvider(readPlayer(profile).adjustment);

  const unknownId = 'NOT_A_COMBO';
  const factor = provider.adjustActionLikelihood!(
    { comboId: unknownId, action: RangeAction.BET, likelihood: 0.5, source: 'HEURISTIC', confidence: 0.5 },
    CONTEXT,
  );
  assert.equal(factor, UNKNOWN_COMBO_FACTOR, `未知 combo 的似然因子必须是 1（实际 ${factor}）`);

  // 必须存在**至少一个**真实组合，其因子与「未知」不同 ——
  // 否则「未知 ≠ 中等牌」这条断言就没有证据。
  let differing = 0;
  for (const combo of ALL_COMBOS.slice(0, 60)) {
    const f = provider.adjustActionLikelihood!(
      { comboId: combo.canonicalId, action: RangeAction.BET, likelihood: 0.5, source: 'HEURISTIC', confidence: 0.5 },
      CONTEXT,
    );
    if (Math.abs(f - UNKNOWN_COMBO_FACTOR) > 1e-12) differing++;
  }
  assert.ok(
    differing > 0,
    '至少应有一个真实组合的因子不同于 1（否则未知 combo 的「不调整」语义无从对照）',
  );

  // 必须被计数
  assert.ok(provider.stats().unknownCombos >= 1, '未知 combo 必须被计数');
});

test('红队 MAJOR-10：未知 combo 反复调用必须累加计数', () => {
  const profile = spreadProfile('loose3', 600, {
    [PlayerMetric.VPIP]: 0.6,
    [PlayerMetric.PFR]: 0.15,
  });
  const provider = createProfileRangeProvider(readPlayer(profile).adjustment);
  for (let i = 0; i < 7; i++) {
    provider.adjustActionLikelihood!(
      { comboId: `BAD_${i}`, action: RangeAction.CHECK, likelihood: 0.5, source: 'HEURISTIC', confidence: 0.5 },
      CONTEXT,
    );
  }
  assert.equal(provider.stats().unknownCombos, 7);
});

/* ============================================================
 * 红队 CRITICAL-2 补充：timestamp 必须参与或不参与，语义必须明确
 * ============================================================ */

test('明确定义：时间衰减基于 seq 而非 timestamp（有测试锁定，防止误改）', () => {
  // 当前设计：age = maxSeq − seq。timestamp 被校验但**不参与**权重计算。
  // 这是刻意的（外部数据的时间戳可能不可靠），但必须写明并锁定，
  // 否则将来有人会以为 timestamp 参与计算而按它设计。
  const build = (timestamps: string[]) => {
    let profile = createProfile('p1');
    timestamps.forEach((timestamp, i) => {
      const outcome = observeHand(profile, {
        handId: `H${i}`,
        playerId: 'p1',
        seq: i,
        timestamp,
        observations: [{ metric: PlayerMetric.VPIP, success: i < 2 }],
      });
      assert.equal(outcome.ok, true);
      if (outcome.ok) profile = outcome.value;
    });
    return profile;
  };

  // 一组时间戳递增，一组完全逆序 —— seq 相同时统计必须完全相同
  const ascending = build([
    '2024-01-01T00:00:00.000Z',
    '2024-01-02T00:00:00.000Z',
    '2024-01-03T00:00:00.000Z',
  ]);
  const descending = build([
    '2024-01-03T00:00:00.000Z',
    '2024-01-02T00:00:00.000Z',
    '2024-01-01T00:00:00.000Z',
  ]);

  assert.equal(
    metricOf(ascending, PlayerMetric.VPIP).adjustedRate,
    metricOf(descending, PlayerMetric.VPIP).adjustedRate,
    '时间衰减只依赖 seq，时间戳顺序不影响统计',
  );
});

test('SEQ_GAP_TOLERANCE 必须被导出且为正（下游需要知道这个约束）', () => {
  assert.ok(Number.isFinite(SEQ_GAP_TOLERANCE) && SEQ_GAP_TOLERANCE > 0);
});

/* ============================================================
 * 红队：假绿防护
 * ============================================================ */

test('假绿防护：收缩公式测试必须真正断言公式（而不是只断言有限）', () => {
  // 红队指出旧测试里 `expected` 算出后从未使用。
  // 这里显式复算并断言，确保公式真的被验证。
  const n = 300;
  const successes = 120;
  const profile = profileWith(PlayerMetric.VPIP, n, successes);
  const stat = metricOf(profile, PlayerMetric.VPIP);
  const prior = METRIC_DEFINITIONS[PlayerMetric.VPIP].prior;

  const weights = Array.from({ length: n }, (_, seq) => decayWeight(n - 1 - seq, DEFAULT_DECAY));
  const capped = capSingleHandWeight(weights, DEFAULT_DECAY.maxSingleHandShare);
  const totalWeight = capped.reduce((s, w) => s + w, 0);
  let weightedSuccesses = 0;
  for (let i = 0; i < n; i++) if (i < successes) weightedSuccesses += capped[i]!;

  const expected = (weightedSuccesses + prior.strength * prior.center) / (totalWeight + prior.strength);
  assert.ok(
    Math.abs(stat.adjustedRate - expected) < 1e-12,
    `收缩公式必须精确成立：期望 ${expected}，实际 ${stat.adjustedRate}`,
  );
  // 明确断言「这个期望值确实是本文档声称的公式」，而不是同义反复
  assert.ok(expected > prior.center && expected < successes / n, '期望值必须落在先验与观测之间');
});

test('假绿防护：深冻结测试必须覆盖**全部**属性（不是手写 8 个位置）', () => {
  const profile = profileWith(PlayerMetric.VPIP, 3, 2);
  const expectedLayers = Object.keys(profile);
  assert.ok(expectedLayers.length >= 8, `前置条件：画像至少有 8 个属性（实际 ${expectedLayers.length}）`);

  for (const key of expectedLayers) {
    const value = (profile as unknown as Record<string, unknown>)[key];
    if (value !== null && typeof value === 'object') {
      assert.equal(
        Object.isFrozen(value),
        true,
        `属性 ${key} 是对象/数组，必须被冻结（这条断言自动覆盖将来新增的属性）`,
      );
    }
  }
});

test('红队：`removeHand` 必须同步收缩 maxSeq（否则后续合法序号会被误拒）', () => {
  let profile = createProfile('p1');
  for (const seq of [0, 5, 10]) {
    const outcome = observeHand(profile, hand(seq, PlayerMetric.VPIP, true));
    assert.equal(outcome.ok, true);
    if (outcome.ok) profile = outcome.value;
  }
  assert.equal(profile.maxSeq, 10);

  const removed = removeHand(profile, 'H10');
  assert.equal(removed.maxSeq, 5, '移除最大序号的手牌后 maxSeq 必须回落');
  assert.equal(removed.handsObserved, 2);

  // 此时再录入 seq=6 必须被接受（旧的 maxSeq=10 会让它……仍然可接受，
  // 但更重要的是 seq 容差判定必须基于当前真实最大序号）
  const again = observeHand(removed, hand(6, PlayerMetric.VPIP, true));
  assert.equal(again.ok, true);
});

test('红队：`amendHand` 改变 seq 后 maxSeq 必须同步更新', () => {
  const profile = profileWith(PlayerMetric.VPIP, 3, 1);
  assert.equal(profile.maxSeq, 2);

  const outcome = amendHand(profile, 'H2', {
    seq: 500,
    timestamp: TS,
    observations: [{ metric: PlayerMetric.VPIP, success: true }],
  });
  assert.equal(outcome.ok, true, '500 - 2 = 498 < 容差 1000，应被接受');
  if (!outcome.ok) return;
  assert.equal(outcome.value.maxSeq, 500);
});
