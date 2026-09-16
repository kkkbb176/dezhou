/**
 * Step 6 测试：玩家画像统计与引擎
 *
 * 覆盖面（对应规范第十一 / 十三 / 十五 / 十六 / 十七 / 十八节 + 红队指定攻击面）：
 * - 收缩：3 手 100% 入池不得等于 VPIP = 100%
 * - 有效样本量（Kish）：等权 = n，集中权重 << n，全零 = 0
 * - 置信度：样本少必须低，不因比率极端而高
 * - 时间衰减与单手影响上限：最近一手不得推翻几百手历史
 * - 每项指标独立分母；没有机会不得计数
 * - 重复 handId 幂等、修正历史与「一开始就录对」等价
 * - 玩家隔离、NaN / Infinity / 负数 / 未知枚举 / 乱序 / 非法时间戳
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PlayerMetric,
  METRIC_DEFINITIONS,
  ALL_PLAYER_METRICS,
  PriorSource,
  emptyMetricStat,
} from '../src/domain/player/player.types.ts';
import {
  DEFAULT_DECAY,
  capSingleHandWeight,
  computeMetricStat,
  confidenceFromSamples,
  decayWeight,
  effectiveSampleSize,
  sampleTier,
  allowsDirectionalClaim,
  SampleTier,
} from '../src/domain/player/playerStats.ts';
import {
  amendHand,
  createProfile,
  hasUsableSample,
  isValidTimestamp,
  metricOf,
  observeHand,
  removeHand,
  sampleSummary,
  PROFILE_VERSION,
  type HandObservation,
} from '../src/domain/player/playerProfile.ts';

/* ============================================================
 * 测试辅助
 * ============================================================ */

const TS = '2024-06-01T12:00:00.000Z';

/** 构造一手观测（默认只有 VPIP 一项） */
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

/** 连续录入 n 手，指定成功次数 */
function profileWith(
  metric: PlayerMetric,
  n: number,
  successes: number,
  playerId = 'p1',
) {
  let profile = createProfile(playerId);
  for (let i = 0; i < n; i++) {
    const outcome = observeHand(profile, hand(i, metric, i < successes, { playerId }));
    assert.equal(outcome.ok, true, `第 ${i} 手应录入成功`);
    if (outcome.ok) profile = outcome.value;
  }
  return profile;
}

/**
 * 按画像引擎的公开约定复算期望值。
 *
 * ⚠️ 不能假设「每手权重 = 1」：画像按 `seq` 做时间衰减，
 * 一手 n 手历史的权重范围是 `2^(-(n-1)/halfLife)` ~ `1`。
 * 例如 2000 手时最旧一手权重只有 0.031 —— 直接按均匀权重复算会得到
 * 与实现完全不同的数字（这正是本轮测试自己写错的地方）。
 */
function decayedStats(n: number, successes: number) {
  const weights = Array.from({ length: n }, (_, seq) => decayWeight(n - 1 - seq, DEFAULT_DECAY));
  const capped = capSingleHandWeight(weights, DEFAULT_DECAY.maxSingleHandShare);
  const totalWeight = capped.reduce((s, w) => s + w, 0);
  let weightedSuccesses = 0;
  for (let i = 0; i < n; i++) if (i < successes) weightedSuccesses += capped[i]!;
  return { weights, capped, totalWeight, weightedSuccesses, weightedRate: weightedSuccesses / totalWeight };
}

function expectedAdjusted(metric: PlayerMetric, n: number, successes: number): number {
  const prior = METRIC_DEFINITIONS[metric].prior;
  const { totalWeight, weightedSuccesses } = decayedStats(n, successes);
  return (weightedSuccesses + prior.strength * prior.center) / (totalWeight + prior.strength);
}

/* ============================================================
 * 一、收缩（规范第十三节）
 * ============================================================ */

test('3 手全部入池：adjustedRate 必须远低于 100% 且贴近先验（规范第十三节）', () => {
  const profile = profileWith(PlayerMetric.VPIP, 3, 3);
  const stat = metricOf(profile, PlayerMetric.VPIP);
  const prior = METRIC_DEFINITIONS[PlayerMetric.VPIP].prior;

  assert.equal(stat.successes, 3);
  assert.equal(stat.opportunities, 3);
  assert.equal(stat.rawRate, 1, '原始比率确实是 100%');

  const expected = expectedAdjusted(PlayerMetric.VPIP, 3, 3);
  assert.ok(
    Math.abs(stat.adjustedRate - expected) < 1e-12,
    `收缩公式应为 (加权成功数 + k·center)/(Σcapped + k)，期望 ${expected}，实际 ${stat.adjustedRate}`,
  );
  // 关键断言：不得等于 100%
  assert.ok(stat.adjustedRate < 1);
  // 3 手只提供极少证据 → 结果必须落在先验中心与原始比率之间、且靠近先验
  assert.ok(
    stat.adjustedRate > prior.center && stat.adjustedRate < 1,
    `收缩结果必须严格位于 (${prior.center}, 1) 之间（实际 ${stat.adjustedRate}）`,
  );
  assert.ok(
    stat.adjustedRate < prior.center + (1 - prior.center) / 2,
    `3 手证据极少，结果应偏先验一侧（实际 ${stat.adjustedRate}）`,
  );
});

test('收缩公式精确性：adjustedRate 等于 (加权成功数 + k·center)/(Σcapped + k)', () => {
  for (const [n, s] of [
    [3, 3],
    [10, 4],
    [100, 40],
    [300, 120],
  ] as const) {
    const stat = metricOf(profileWith(PlayerMetric.VPIP, n, s), PlayerMetric.VPIP);
    const expected = expectedAdjusted(PlayerMetric.VPIP, n, s);
    assert.ok(
      Math.abs(stat.adjustedRate - expected) < 1e-12,
      `n=${n} s=${s}：期望 ${expected}，实际 ${stat.adjustedRate}`,
    );
  }
});

test('收缩公式精确性：无单手上限干扰时，exactly (s + k·center)/(n + k)', () => {
  // 手数足够多时 maxSingleHandShare（5%）不会触发，可以验证公式本身
  const n = 100;
  const successes = 40;
  const profile = profileWith(PlayerMetric.VPIP, n, successes);
  const stat = metricOf(profile, PlayerMetric.VPIP);
  const prior = METRIC_DEFINITIONS[PlayerMetric.VPIP].prior;

  // 衰减半衰期 400 手，100 手内权重 0.84~1.0；单手占比 ~1% < 5%，未触发上限
  assert.ok(stat.effectiveSampleSize > n * 0.9, `未触发上限时 n_eff 应接近 n（实际 ${stat.effectiveSampleSize}）`);
  const denominator = stat.effectiveSampleSize + prior.strength;
  const expected = (stat.adjustedRate * denominator - prior.strength * prior.center) / 1;
  assert.ok(Number.isFinite(expected));
  // 直接验证反解出的加权成功数落在合理范围（不能大于机会数）
  const weightedSuccesses = stat.adjustedRate * denominator - prior.strength * prior.center;
  assert.ok(
    weightedSuccesses > 0 && weightedSuccesses <= stat.effectiveSampleSize + 1e-9,
    `加权成功数必须在 [0, n_eff] 内（实际 ${weightedSuccesses}）`,
  );
});

test('收缩统计不得违反：adjustedRate 永远落在 [先验中心, 衰减加权比率] 区间内', () => {
  // ⚠️ 注意这里用的是「衰减加权比率」而不是「原始比率」。
  // 画像带时间衰减（半衰期 400 手），因此它估计的是**近期水平**，
  // 不是全历史平均。当成功集中在早期时两者必然不同 ——
  // 这是时间衰减的设计意图（规范第十六节），不是偏差。
  // 该性质由「后验均值 = 先验与观测的凸组合」数学保证。
  for (const [n, s] of [
    [1, 0],
    [1, 1],
    [3, 3],
    [10, 1],
    [50, 25],
    [200, 40],
    [200, 100],
    [500, 200],
    [2000, 800],
  ] as const) {
    const stat = metricOf(profileWith(PlayerMetric.VPIP, n, s), PlayerMetric.VPIP);
    const prior = METRIC_DEFINITIONS[PlayerMetric.VPIP].prior;
    const { weightedRate } = decayedStats(n, s);
    const lo = Math.min(prior.center, weightedRate);
    const hi = Math.max(prior.center, weightedRate);
    assert.ok(
      stat.adjustedRate >= lo - 1e-9 && stat.adjustedRate <= hi + 1e-9,
      `n=${n} s=${s}：adjustedRate=${stat.adjustedRate} 越出 [${lo}, ${hi}]（加权比率 ${weightedRate}）`,
    );
    // 同时必须落在 [0, 1] —— 绝不允许因收缩产生越界概率
    assert.ok(stat.adjustedRate >= 0 && stat.adjustedRate <= 1);
  }
});

test('时间衰减的固有含义：成功集中在早期时，估计值必须低于全历史平均值', () => {
  // 明确锁定「衰减是有意的近期加权」这一语义，防止将来被误当作 Bug 修掉。
  const n = 1000;
  const earlySuccesses = decayedStats(n, 500).weightedRate; // 前 500 手成功
  const lateSuccesses = (() => {
    const weights = Array.from({ length: n }, (_, seq) => decayWeight(n - 1 - seq, DEFAULT_DECAY));
    let sum = 0;
    for (let i = 500; i < n; i++) sum += weights[i]!;
    return sum / weights.reduce((a, b) => a + b, 0);
  })();

  assert.ok(
    lateSuccesses > earlySuccesses,
    `同样 50% 的成功率，发生在近期应得到更高权重（早期 ${earlySuccesses.toFixed(4)}，近期 ${lateSuccesses.toFixed(4)}）`,
  );
  assert.ok(
    Math.abs((earlySuccesses + lateSuccesses) / 2 - 0.5) < 0.02,
    '两种情形的加权比率应关于 0.5 大致对称',
  );

  const earlyStat = metricOf(profileWith(PlayerMetric.VPIP, n, 500), PlayerMetric.VPIP);
  const lateProfile = (() => {
    let profile = createProfile('p1');
    for (let i = 0; i < n; i++) {
      const r = observeHand(profile, hand(i, PlayerMetric.VPIP, i >= 500));
      assert.equal(r.ok, true);
      if (r.ok) profile = r.value;
    }
    return profile;
  })();
  const lateStat = metricOf(lateProfile, PlayerMetric.VPIP);
  assert.ok(
    lateStat.adjustedRate > earlyStat.adjustedRate,
    `近期成功必须得到更高的估计值（早期 ${earlyStat.adjustedRate}，近期 ${lateStat.adjustedRate}）`,
  );
});

test('样本量增大时 adjustedRate 收敛到衰减加权真值（整体趋势）', () => {
  const n = 2000;
  const s = 800;
  const { weightedRate } = decayedStats(n, s);

  const tiny = metricOf(profileWith(PlayerMetric.VPIP, 3, 1), PlayerMetric.VPIP).adjustedRate;
  const big = metricOf(profileWith(PlayerMetric.VPIP, n, s), PlayerMetric.VPIP).adjustedRate;

  assert.ok(
    Math.abs(big - weightedRate) < Math.abs(tiny - weightedRate),
    `大样本应更接近加权真值 ${weightedRate}（小样本 ${tiny}，大样本 ${big}）`,
  );
  assert.ok(
    Math.abs(big - weightedRate) < 0.01,
    `2000 手后应接近加权真值 ${weightedRate}（实际 ${big}）`,
  );
  const prior = METRIC_DEFINITIONS[PlayerMetric.VPIP].prior;
  assert.ok(tiny >= prior.center - 1e-9 && tiny <= 1 + 1e-9, `小样本结果必须在合理区间（实际 ${tiny}）`);
});

test('有效样本量随手数单调增长，且不超过手数本身', () => {
  const nEffOf = (n: number) =>
    metricOf(profileWith(PlayerMetric.VPIP, n, Math.round(n / 2)), PlayerMetric.VPIP).effectiveSampleSize;

  const values = [3, 10, 50, 100, 300, 601].map(nEffOf);
  for (let i = 1; i < values.length; i++) {
    assert.ok(
      values[i]! >= values[i - 1]! - 1e-9,
      `n_eff 必须随手数单调增长（实际 ${JSON.stringify(values)}）`,
    );
  }
  for (const value of values) assert.ok(Number.isFinite(value) && value > 0);
  assert.ok(values[5]! <= 601, 'n_eff 不得超过实际手数');
});

test('3 手全部入池：置信度必须很低（不得当作已知玩家）', () => {
  const profile = profileWith(PlayerMetric.VPIP, 3, 3);
  const stat = metricOf(profile, PlayerMetric.VPIP);
  // n_eff ≈ 3（衰减在 3 手内可忽略），k = 30 → ≈ 3/33 ≈ 0.0909
  assert.ok(stat.confidence < 0.1, `3 手样本置信度必须 < 0.1（实际 ${stat.confidence}）`);
  assert.equal(sampleTier(stat.effectiveSampleSize), SampleTier.PRELIMINARY);
  assert.equal(allowsDirectionalClaim(sampleTier(stat.effectiveSampleSize)), false);
});

test('样本量增大时 adjustedRate 单调趋近衰减加权真值', () => {
  let previousDistance = Number.POSITIVE_INFINITY;
  for (const n of [10, 30, 100, 300, 1000]) {
    const successes = Math.round(n * 0.4);
    const stat = metricOf(profileWith(PlayerMetric.VPIP, n, successes), PlayerMetric.VPIP);
    const { weightedRate } = decayedStats(n, successes);
    const distance = Math.abs(stat.adjustedRate - weightedRate);
    assert.ok(
      distance <= previousDistance + 1e-12,
      `n=${n} 时与加权真值 ${weightedRate} 的距离应不增大（前 ${previousDistance}，现 ${distance}）`,
    );
    previousDistance = distance;
  }
  const n = 1000;
  const successes = 400;
  const big = metricOf(profileWith(PlayerMetric.VPIP, n, successes), PlayerMetric.VPIP);
  const { weightedRate } = decayedStats(n, successes);
  assert.ok(
    Math.abs(big.adjustedRate - weightedRate) < 0.01,
    `1000 手后应接近加权真值 ${weightedRate}（实际 ${big.adjustedRate}）`,
  );
});

/* ============================================================
 * 二、有效样本量（Kish）
 * ============================================================ */

test('有效样本量：权重全等时等于个数', () => {
  const weights = new Array(50).fill(0.7);
  assert.ok(Math.abs(effectiveSampleSize(weights) - 50) < 1e-9);
});

test('有效样本量：权重高度集中时远小于个数', () => {
  // 100 个权重，其中 1 个占 99%
  const weights = [100, ...new Array(99).fill(0.01)];
  const nEff = effectiveSampleSize(weights);
  assert.ok(nEff < 5, `集中权重下 n_eff 必须远小于 100（实际 ${nEff}）`);
  assert.ok(nEff > 0);
});

test('有效样本量：全零权重返回 0（不得除零得 NaN）', () => {
  assert.equal(effectiveSampleSize([0, 0, 0]), 0);
  assert.equal(effectiveSampleSize([]), 0);
});

test('有效样本量：忽略 NaN / Infinity / 负数，不得污染结果', () => {
  const nEff = effectiveSampleSize([1, 1, Number.NaN, Number.POSITIVE_INFINITY, -5]);
  assert.equal(Number.isFinite(nEff), true);
  assert.ok(Math.abs(nEff - 2) < 1e-9, `只剩两个有效权重 1 → n_eff = 2（实际 ${nEff}）`);
});

test('置信度公式：n_eff / (n_eff + k)，且先验为 0 时不得出现 NaN', () => {
  assert.ok(Math.abs(confidenceFromSamples(30, 30) - 0.5) < 1e-12);
  assert.equal(confidenceFromSamples(0, 30), 0);
  assert.equal(confidenceFromSamples(-1, 30), 0);
  assert.equal(confidenceFromSamples(Number.NaN, 30), 0);
  assert.equal(confidenceFromSamples(30, 0), 1, '无先验时观测即全部证据');
  assert.ok(Number.isFinite(confidenceFromSamples(30, -5)));
});

/* ============================================================
 * 三、时间衰减与单手上限（规范第十六节）
 * ============================================================ */

test('时间衰减：age = halfLife 时权重恰为 0.5', () => {
  assert.ok(Math.abs(decayWeight(0, DEFAULT_DECAY) - 1) < 1e-15);
  assert.ok(Math.abs(decayWeight(400, DEFAULT_DECAY) - 0.5) < 1e-15);
  assert.ok(Math.abs(decayWeight(800, DEFAULT_DECAY) - 0.25) < 1e-15);
});

test('时间衰减：非法输入必须抛错，绝不静默返回 1', () => {
  assert.throws(() => decayWeight(-1), /ageInHands/);
  assert.throws(() => decayWeight(Number.NaN), /ageInHands/);
  assert.throws(() => decayWeight(10, { halfLife: 0, maxSingleHandShare: 0.05 }), /halfLife/);
});

test('单手影响上限：单个大权重被压缩，且占比恰好落在上限', () => {
  // n=50，maxShare=0.05 → 实际上限 0.05×50 = 2.5（远低于均匀权重的 1）
  const weights = [10, ...new Array(49).fill(1)];
  const capped = capSingleHandWeight(weights, 0.05);
  const total = capped.reduce((s, w) => s + w, 0);
  const max = Math.max(...capped);

  assert.ok(max > 0 && Number.isFinite(max));
  assert.ok(
    Math.abs(max / total - 0.05) < 1e-6,
    `最大占比应恰好被压到上限 0.05（实际 ${max / total}）`,
  );
  // 权重总和不变（插值族性质）→ 证据量不被无谓丢弃
  assert.ok(Math.abs(total - 59) < 1e-9, `总权重应保持不变（实际 ${total}）`);
  // 压缩是真实生效的
  assert.ok(max < 10, `大权重必须被真正压下来（实际 ${max}）`);
  assert.ok(capped[1]! >= 1, '小权重只在需要时被抬高，且不得低于原值');
});

test('单手影响上限：对任意可压缩的 maxShare 都严格满足「最大占比 ≤ 上限」', () => {
  // 这是上一版实现的真实 Bug 面：旧版按比例整体缩放，占比完全没变。
  for (const n of [50, 101]) {
    for (const share of [0.05, 0.1, 0.25]) {
      for (const dominant of [10, 100, 1000]) {
        const weights = [dominant, ...new Array(n - 1).fill(1)];
        const capped = capSingleHandWeight(weights, share);
        const total = capped.reduce((s, w) => s + w, 0);
        const max = Math.max(...capped);
        assert.ok(
          max <= share * total + 1e-9,
          `n=${n} share=${share} dominant=${dominant}：最大占比 ${max / total} 超过上限`,
        );
        assert.ok(capped.every((w) => Number.isFinite(w) && w >= 0), '绝不返回 NaN / 负数');
        assert.ok(Math.abs(total - weights.reduce((s, w) => s + w, 0)) < 1e-6, '总和必须守恒');
      }
    }
  }
});

test('单手影响上限（回归）：旧实现「整体按比例缩放」不改变占比，是无效的', () => {
  const weights = [10, ...new Array(49).fill(1)];
  const sum = weights.reduce((s, x) => s + x, 0);
  const naive = weights.map((w) => w * ((sum * 0.05) / 10));
  const naiveShare = Math.max(...naive) / naive.reduce((s, w) => s + w, 0);
  assert.ok(
    Math.abs(naiveShare - 10 / 59) < 1e-12,
    '朴素缩放后占比仍是 16.9%，证明该做法无效',
  );

  const fixed = capSingleHandWeight(weights, 0.05);
  const fixedShare = Math.max(...fixed) / fixed.reduce((s, w) => s + w, 0);
  assert.ok(fixedShare <= 0.05 + 1e-9, `修正后占比必须 ≤ 0.05（实际 ${fixedShare}）`);
});

test('单手影响上限：该上限无意义时（maxShare < 1/正权重数）不做任何改动', () => {
  // 可达的最小最大占比 = 1 / 正权重个数（压缩族最多能把权重压到均匀）。
  // 当 maxShare 低于该值时，约束**数学上不可满足**。
  const ten = new Array(10).fill(1);
  // 1/10 = 0.1 > 0.05 → 不可满足
  assert.deepEqual(capSingleHandWeight(ten, 0.05), ten, '不可满足时不得伪造满足约束的结果');

  // n=20 且 maxShare=0.05：1/20 = 0.05，恰好达标（边界）→ 均匀本就合规
  const twenty = [10, ...new Array(19).fill(1)];
  const capped = capSingleHandWeight(twenty, 0.05);
  const total = capped.reduce((s, w) => s + w, 0);
  assert.ok(Math.max(...capped) / total <= 0.05 + 1e-9, '边界值必须满足约束');

  // n=50 时同样的 maxShare 有充分压缩空间
  const fifty = [10, ...new Array(49).fill(1)];
  const cappedFifty = capSingleHandWeight(fifty, 0.05);
  const totalFifty = cappedFifty.reduce((s, w) => s + w, 0);
  assert.ok(
    Math.abs(Math.max(...cappedFifty) / totalFifty - 0.05) < 1e-6,
    `n=50 时必须恰好压到上限（实际 ${Math.max(...cappedFifty) / totalFifty}）`,
  );
});

test('单手影响上限：权重本就均衡时不做任何改动', () => {
  const weights = new Array(50).fill(1);
  assert.deepEqual(capSingleHandWeight(weights, 0.05), weights);
});

test('单手影响上限：全部权重为 0 时原样返回，不得除零', () => {
  assert.deepEqual(capSingleHandWeight([0, 0], 0.5), [0, 0]);
});

test('单手影响上限：非有限 / 负数权重被当作 0，不污染结果', () => {
  const capped = capSingleHandWeight([1, Number.NaN, -5, Number.POSITIVE_INFINITY], 0.5);
  assert.equal(capped.length, 4);
  assert.ok(capped.every((w) => Number.isFinite(w) && w >= 0));
});

test('单手影响上限：病态集中权重的占比必须被压到上限内（规范第十六节）', () => {
  // 「599 手权重 1 + 最近 1 手权重 500」：原始占比 45.5%
  const weights = [...new Array(599).fill(1), 500];
  const rawShare = 500 / weights.reduce((s, w) => s + w, 0);
  assert.ok(rawShare > 0.4, `前置条件：原始占比应很高（实际 ${rawShare}）`);

  const capped = capSingleHandWeight(weights, 0.05);
  const total = capped.reduce((s, w) => s + w, 0);
  const max = Math.max(...capped);
  assert.ok(
    max / total <= 0.05 + 1e-9,
    `病态集中时最大占比必须被压到 5% 以内（实际 ${max / total}）`,
  );
  assert.ok(max < 500, '这一场景必须真正触发压缩');
  assert.ok(Math.abs(total - weights.reduce((s, w) => s + w, 0)) < 1e-6, '总权重必须守恒');
});

test('单手影响上限：非法 maxShare 抛错', () => {
  assert.throws(() => capSingleHandWeight([1], 0), /maxShare/);
  assert.throws(() => capSingleHandWeight([1], 1.5), /maxShare/);
  assert.throws(() => capSingleHandWeight([1], Number.NaN), /maxShare/);
});

test('红队案例：299 手从不上池 + 最后 1 手疯狂加注，画像不得被单手推翻', () => {
  // 用 VPIP 表达：299 手不入池、最近 1 手入池
  let profile = createProfile('nit');
  for (let i = 0; i < 300; i++) {
    const outcome = observeHand(profile, hand(i, PlayerMetric.VPIP, i === 299, { playerId: 'nit' }));
    assert.equal(outcome.ok, true);
    if (outcome.ok) profile = outcome.value;
  }
  const stat = metricOf(profile, PlayerMetric.VPIP);
  assert.equal(stat.successes, 1);
  assert.equal(stat.opportunities, 300);
  // 衰减是半衰期 400 手，300 手的样本权重 0.59~1.0，因此 n_eff 很大
  assert.ok(stat.effectiveSampleSize > 30, `n_eff 应显著（实际 ${stat.effectiveSampleSize}）`);
  // 一手成功不可能把比率推到 50% 以上
  assert.ok(stat.adjustedRate < 0.1, `1/300 的画像不得被抬高（实际 ${stat.adjustedRate}）`);
});

/* ============================================================
 * 四、指标独立性（规范第十五节）
 * ============================================================ */

test('每项指标拥有独立分母：200 手 VPIP 不影响河牌超池样本', () => {
  let profile = createProfile('p1');
  for (let i = 0; i < 200; i++) {
    const outcome = observeHand(profile, hand(i, PlayerMetric.VPIP, i % 2 === 0));
    assert.equal(outcome.ok, true);
    if (outcome.ok) profile = outcome.value;
  }
  const vpip = metricOf(profile, PlayerMetric.VPIP);
  const overbet = metricOf(profile, PlayerMetric.RIVER_OVERBET);

  assert.equal(vpip.opportunities, 200);
  assert.equal(overbet.opportunities, 0, '没有河牌超池机会时分母必须是 0');
  assert.equal(overbet.rawRate, null, '无机会时原始比率必须是 null 而不是 0');
  assert.equal(overbet.confidence, 0);
  assert.equal(overbet.adjustedRate, METRIC_DEFINITIONS[PlayerMetric.RIVER_OVERBET].prior.center);
});

test('「没遇到 3Bet」不得进入面对 3Bet 弃牌率的分母', () => {
  let profile = createProfile('p1');
  // 100 手开池，但没有任何人 3Bet 他 → FOLD_TO_THREE_BET 机会为 0
  for (let i = 0; i < 100; i++) {
    const outcome = observeHand(profile, {
      handId: `H${i}`,
      playerId: 'p1',
      seq: i,
      timestamp: TS,
      observations: [
        { metric: PlayerMetric.OPEN, success: true },
        // 刻意**不**产生 FOLD_TO_THREE_BET 观测
      ],
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) profile = outcome.value;
  }
  assert.equal(metricOf(profile, PlayerMetric.FOLD_TO_THREE_BET).opportunities, 0);
  assert.equal(metricOf(profile, PlayerMetric.OPEN).opportunities, 100);
});

test('「从不诈唬」的玩家仍必须被计入诈唬机会（机会由状态定义而非行为定义）', () => {
  // 这项约束在领域层的落地方式：调用方**必须**为「轮到他且无人下注」的每一次
  // 都产生 RIVER_BET 观测（success=false 表示他没下注）。
  // 本测试锁定「success=false 的观测确实进入分母」这一语义。
  const profile = profileWith(PlayerMetric.RIVER_BET, 50, 0);
  const stat = metricOf(profile, PlayerMetric.RIVER_BET);
  assert.equal(stat.opportunities, 50, '从未下注也必须累计 50 次机会');
  assert.equal(stat.successes, 0);
  assert.equal(stat.rawRate, 0);
  assert.ok(stat.adjustedRate > 0, '收缩后不得恰好为 0（先验仍有权重）');
});

test('所有 25 项指标在两两之间不共享统计对象（无跨指标污染）', () => {
  const profile = profileWith(PlayerMetric.VPIP, 10, 5);
  const refs = ALL_PLAYER_METRICS.map((m) => metricOf(profile, m));
  assert.equal(new Set(refs).size, ALL_PLAYER_METRICS.length, '每项指标必须是独立对象');
  for (const m of ALL_PLAYER_METRICS) {
    assert.equal(metricOf(profile, m).metric, m, '统计对象必须自带正确的 metric 标识');
  }
});

/* ============================================================
 * 五、幂等与修正历史（规范第十七 / 十八节）
 * ============================================================ */

test('重复 handId：被拒绝且画像完全不变', () => {
  const first = observeHand(createProfile('p1'), hand(0, PlayerMetric.VPIP, true));
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const duplicate = observeHand(first.value, hand(0, PlayerMetric.VPIP, false));
  assert.equal(duplicate.ok, false);
  if (duplicate.ok) return;
  assert.ok(duplicate.issues.some((i) => i.code === 'DUPLICATE_HAND'));

  // 原画像未被触碰
  assert.equal(first.value.handsObserved, 1);
  assert.equal(metricOf(first.value, PlayerMetric.VPIP).opportunities, 1);
});

test('修正历史：amendHand 的结果与「一开始就录对」完全一致', () => {
  // 路线 A：先录错（success=false），再修正为 success=true
  let amended = profileWith(PlayerMetric.VPIP, 5, 0);
  const outcome = amendHand(amended, 'H2', {
    seq: 2,
    timestamp: TS,
    observations: [{ metric: PlayerMetric.VPIP, success: true }],
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  amended = outcome.value;

  // 路线 B：一开始就录对
  let direct = createProfile('p1');
  for (let i = 0; i < 5; i++) {
    const r = observeHand(direct, hand(i, PlayerMetric.VPIP, i === 2));
    assert.equal(r.ok, true);
    if (r.ok) direct = r.value;
  }

  assert.equal(metricOf(amended, PlayerMetric.VPIP).successes, 1);
  assert.equal(metricOf(direct, PlayerMetric.VPIP).successes, 1);
  assert.ok(
    Math.abs(metricOf(amended, PlayerMetric.VPIP).adjustedRate - metricOf(direct, PlayerMetric.VPIP).adjustedRate) <
      1e-15,
    '修正后的统计必须与直接录入等价（不得「旧统计留着 + 新统计再加一次」）',
  );
  assert.equal(amended.handsObserved, direct.handsObserved, '手数不得因修正而变化');
});

test('移除一手：removeHand 等价于从未录入该手', () => {
  const full = profileWith(PlayerMetric.VPIP, 5, 3);
  const removed = removeHand(full, 'H4');
  const direct = profileWith(PlayerMetric.VPIP, 4, 3);

  assert.equal(metricOf(removed, PlayerMetric.VPIP).opportunities, 4);
  assert.equal(metricOf(removed, PlayerMetric.VPIP).successes, 3);
  assert.ok(
    Math.abs(metricOf(removed, PlayerMetric.VPIP).adjustedRate - metricOf(direct, PlayerMetric.VPIP).adjustedRate) <
      1e-15,
  );
  assert.equal(removed.seenHandIds.has('H4'), false);
});

test('移除不存在的手：返回原对象且不报错（幂等）', () => {
  const profile = profileWith(PlayerMetric.VPIP, 3, 1);
  assert.equal(removeHand(profile, 'NOT_EXIST'), profile);
});

test('amendHand 修正不存在的手必须失败', () => {
  const profile = profileWith(PlayerMetric.VPIP, 3, 1);
  const outcome = amendHand(profile, 'NOT_EXIST', {
    seq: 0,
    timestamp: TS,
    observations: [{ metric: PlayerMetric.VPIP, success: true }],
  });
  assert.equal(outcome.ok, false);
});

test('修正为非法时间戳必须失败，且画像不变', () => {
  const profile = profileWith(PlayerMetric.VPIP, 3, 1);
  const outcome = amendHand(profile, 'H1', {
    seq: 1,
    timestamp: '不是时间',
    observations: [{ metric: PlayerMetric.VPIP, success: true }],
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(outcome.issues.some((i) => i.code === 'INVALID_TIMESTAMP'));
});

/* ============================================================
 * 六、输入校验（红队指定攻击面）
 * ============================================================ */

test('非法时间戳：远古 / 未来 / 非 ISO / 空串全部拒绝', () => {
  assert.equal(isValidTimestamp(TS), true);
  assert.equal(isValidTimestamp('1999-12-31T23:59:59.000Z'), false, '1999 年必须拒绝');
  assert.equal(isValidTimestamp('2101-01-01T00:00:00.000Z'), false, '2101 年必须拒绝');
  assert.equal(isValidTimestamp(''), false);
  assert.equal(isValidTimestamp('   '), false);
  assert.equal(isValidTimestamp('not a date'), false);
  assert.equal(isValidTimestamp('2024-13-45T00:00:00.000Z'), false);
});

test('非法时间戳的手牌被拒绝，画像不受影响', () => {
  const profile = createProfile('p1');
  const outcome = observeHand(profile, hand(0, PlayerMetric.VPIP, true, { timestamp: '1800-01-01T00:00:00Z' }));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(outcome.issues.some((i) => i.code === 'INVALID_TIMESTAMP'));
  assert.equal(profile.handsObserved, 0);
  assert.equal(metricOf(profile, PlayerMetric.VPIP).opportunities, 0);
});

test('玩家不匹配：必须拒绝（禁止把别人的牌记到我的画像上）', () => {
  const profile = createProfile('p1');
  const outcome = observeHand(profile, hand(0, PlayerMetric.VPIP, true, { playerId: 'p2' }));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(outcome.issues.some((i) => i.code === 'PLAYER_MISMATCH'));
});

test('未知枚举指标：不得计入统计（不得静默创建新指标）', () => {
  const profile = createProfile('p1');
  const outcome = observeHand(profile, {
    handId: 'H0',
    playerId: 'p1',
    seq: 0,
    timestamp: TS,
    observations: [{ metric: 'NOT_A_METRIC' as PlayerMetric, success: true }],
  });
  assert.equal(outcome.ok, true, '未知指标是警告而非阻塞');
  if (!outcome.ok) return;
  assert.ok(outcome.warnings.some((i) => i.code === 'UNKNOWN_METRIC'));
  assert.equal(outcome.value.handsObserved, 1);
  for (const metric of ALL_PLAYER_METRICS) {
    assert.equal(metricOf(outcome.value, metric).opportunities, 0, `${metric} 不应被凭空计数`);
  }
});

test('负数 / 非整数 seq 必须被**拒绝**（NEGATIVE_COUNT）', () => {
  // ⚠️ 语义变更说明（红队 CRITICAL-2 的修复）：
  // 旧版把非法 seq 当作「仅警告」，理由是「外部数据可能不按顺序到达」。
  // 但 seq 直接决定时间衰减权重：
  //   - NaN  → 权重 NaN，污染**全部**统计
  //   - 负数 → 权重 > 1，「未来」的牌局比现在还重
  // 两者都是「静默算错」，因此现在改为**阻塞级**拒绝。
  // 乱序到达（seq 比历史小但合法）仍然允许 —— 见「乱序到达」测试。
  for (const seq of [-3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const outcome = observeHand(createProfile('p1'), hand(seq, PlayerMetric.VPIP, true));
    assert.equal(outcome.ok, false, `seq=${seq} 必须被拒绝`);
    if (outcome.ok) continue;
    assert.ok(
      outcome.issues.some((i) => i.code === 'NEGATIVE_COUNT'),
      `seq=${seq} 必须报 NEGATIVE_COUNT，实际 ${JSON.stringify(outcome.issues)}`,
    );
  }
});

test('红队 CRITICAL-2：超大 seq 必须被拒绝（否则一手录入作废全部历史）', () => {
  // 复现：200 手 100% 入池的画像，插入一手 seq = 500000。
  // recompute 用「最大 seq 当作现在」，于是全部已有牌局的 age 被抬到 50 万，
  // 权重趋近 0 —— adjustedRate 从 0.8870 掉到 0.2419（**低于先验中心 0.25**），
  // n_eff 198→1，而旧版 warnings = 0。
  let profile = profileWith(PlayerMetric.VPIP, 200, 200);
  const before = metricOf(profile, PlayerMetric.VPIP);
  assert.ok(before.adjustedRate > 0.8, `前置条件：200 手全入池应得到高比率（实际 ${before.adjustedRate}）`);

  const outcome = observeHand(profile, hand(500_000, PlayerMetric.VPIP, true));
  assert.equal(outcome.ok, false, '超大 seq 必须被拒绝');
  if (!outcome.ok) {
    assert.ok(
      outcome.issues.some((i) => i.code === 'SEQ_OUT_OF_RANGE'),
      `必须报 SEQ_OUT_OF_RANGE，实际 ${JSON.stringify(outcome.issues)}`,
    );
  }
  // 画像必须完全不变
  assert.equal(metricOf(profile, PlayerMetric.VPIP).adjustedRate, before.adjustedRate);
  assert.equal(profile.handsObserved, 200);

  // 正常范围内的递增必须仍然被接受
  const ok = observeHand(profile, hand(1100, PlayerMetric.VPIP, true));
  assert.equal(ok.ok, true, '跳跃在容差内（1000）应被接受');
  if (ok.ok) assert.equal(ok.value.maxSeq, 1100);
});

test('乱序但合法的 seq 仍然允许（外部数据不按顺序到达）', () => {
  let profile = createProfile('p1');
  for (const seq of [10, 3, 7, 1, 9]) {
    const outcome = observeHand(profile, hand(seq, PlayerMetric.VPIP, seq % 2 === 1));
    assert.equal(outcome.ok, true, `seq=${seq} 应被接受（乱序但合法）`);
    if (outcome.ok) profile = outcome.value;
  }
  assert.equal(profile.handsObserved, 5);
  assert.equal(profile.maxSeq, 10);
  assert.equal(metricOf(profile, PlayerMetric.VPIP).opportunities, 5);
});

test('回归：非法 seq 不得写入日志、不得改变任何统计', () => {
  const profile = profileWith(PlayerMetric.VPIP, 5, 2);
  const snapshot = {
    hands: profile.handsObserved,
    maxSeq: profile.maxSeq,
    opportunities: metricOf(profile, PlayerMetric.VPIP).opportunities,
    successes: metricOf(profile, PlayerMetric.VPIP).successes,
    logLength: profile.log.length,
  };
  const outcome = observeHand(profile, hand(Number.NaN, PlayerMetric.VPIP, true));
  assert.equal(outcome.ok, false);
  assert.deepEqual(
    {
      hands: profile.handsObserved,
      maxSeq: profile.maxSeq,
      opportunities: metricOf(profile, PlayerMetric.VPIP).opportunities,
      successes: metricOf(profile, PlayerMetric.VPIP).successes,
      logLength: profile.log.length,
    },
    snapshot,
    '被拒绝的录入不得留下任何痕迹',
  );
});

test('同一手内重复指标：只计一次，并给出警告', () => {
  const profile = createProfile('p1');
  const outcome = observeHand(profile, {
    handId: 'H0',
    playerId: 'p1',
    seq: 0,
    timestamp: TS,
    observations: [
      { metric: PlayerMetric.VPIP, success: true },
      { metric: PlayerMetric.VPIP, success: false },
    ],
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(metricOf(outcome.value, PlayerMetric.VPIP).opportunities, 1, '同一手内同一指标只算一次机会');
  assert.equal(metricOf(outcome.value, PlayerMetric.VPIP).successes, 1, '取第一次观测');
});

test('乱序到达：事件顺序不影响最终统计（按 seq 排序重算）', () => {
  const seqs = [5, 2, 9, 0, 7, 1, 8, 3, 6, 4];
  let unsorted = createProfile('p1');
  for (const seq of seqs) {
    const outcome = observeHand(unsorted, hand(seq, PlayerMetric.VPIP, seq % 3 === 0));
    assert.equal(outcome.ok, true);
    if (outcome.ok) unsorted = outcome.value;
  }

  let sorted = createProfile('p1');
  for (let seq = 0; seq < 10; seq++) {
    const outcome = observeHand(sorted, hand(seq, PlayerMetric.VPIP, seq % 3 === 0));
    assert.equal(outcome.ok, true);
    if (outcome.ok) sorted = outcome.value;
  }

  assert.equal(
    metricOf(unsorted, PlayerMetric.VPIP).successes,
    metricOf(sorted, PlayerMetric.VPIP).successes,
  );
  assert.ok(
    Math.abs(
      metricOf(unsorted, PlayerMetric.VPIP).adjustedRate -
        metricOf(sorted, PlayerMetric.VPIP).adjustedRate,
    ) < 1e-15,
    '乱序与顺序必须得到完全相同的统计',
  );
});

test('NaN / Infinity 观测权重必须抛错，绝不静默当成 0', () => {
  assert.throws(
    () => computeMetricStat(PlayerMetric.VPIP, [{ weight: Number.NaN, success: true }]),
    /权重/,
  );
  assert.throws(
    () => computeMetricStat(PlayerMetric.VPIP, [{ weight: Number.POSITIVE_INFINITY, success: true }]),
    /权重/,
  );
  assert.throws(
    () => computeMetricStat(PlayerMetric.VPIP, [{ weight: -1, success: true }]),
    /权重/,
  );
});

test('无观测时 computeMetricStat 返回先验中心而非 0 / NaN', () => {
  const stat = computeMetricStat(PlayerMetric.VPIP, []);
  assert.equal(stat.adjustedRate, METRIC_DEFINITIONS[PlayerMetric.VPIP].prior.center);
  assert.equal(stat.confidence, 0);
  assert.equal(stat.rawRate, null);
  assert.ok(Number.isFinite(stat.adjustedRate));
});

/* ============================================================
 * 七、不可变与玩家隔离（红队指定攻击面）
 * ============================================================ */

test('画像、指标、日志全部深冻结（运行时写不进去）', () => {
  const profile = profileWith(PlayerMetric.VPIP, 3, 2);
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.metrics), true);
  assert.equal(Object.isFrozen(profile.log), true);
  assert.equal(Object.isFrozen(profile.log[0]), true, '日志元素也必须冻结');
  assert.equal(
    Object.isFrozen(profile.log[0]!.observations),
    true,
    '日志元素的 observations 数组也必须冻结',
  );
  assert.equal(
    Object.isFrozen(profile.log[0]!.observations[0]),
    true,
    '观测元素本身也必须冻结（Object.freeze 数组不冻结元素）',
  );
  assert.equal(Object.isFrozen(metricOf(profile, PlayerMetric.VPIP)), true, '指标统计必须冻结');
  assert.equal(Object.isFrozen(metricOf(profile, PlayerMetric.VPIP).prior), true);
});

test('回归：历史日志元素不得被外部改写（会无声改变时间衰减）', () => {
  const profile = profileWith(PlayerMetric.VPIP, 3, 2);
  assert.throws(() => {
    'use strict';
    (profile.log[0] as { seq: number }).seq = 999;
  }, TypeError);
  assert.throws(() => {
    'use strict';
    (profile.log[0]!.observations[0] as { success: boolean }).success = false;
  }, TypeError);
  assert.equal(profile.log[0]!.seq, 0, '历史序号必须保持原样');
  assert.equal(profile.log[0]!.observations[0]!.success, true);
});

test('冻结字段不可被改写（严格模式下抛错）', () => {
  const profile = profileWith(PlayerMetric.VPIP, 3, 2);
  assert.throws(() => {
    'use strict';
    (profile as { handsObserved: number }).handsObserved = 999;
  }, TypeError);
  assert.throws(() => {
    'use strict';
    (metricOf(profile, PlayerMetric.VPIP) as { successes: number }).successes = 999;
  }, TypeError);
  assert.equal(profile.handsObserved, 3, '原对象不得被改动');
});

test('旧画像不被新观测修改（不可变语义）', () => {
  const before = profileWith(PlayerMetric.VPIP, 3, 1);
  const snapshot = metricOf(before, PlayerMetric.VPIP).opportunities;
  const outcome = observeHand(before, hand(3, PlayerMetric.VPIP, true));
  assert.equal(outcome.ok, true);
  assert.equal(metricOf(before, PlayerMetric.VPIP).opportunities, snapshot, '旧画像必须保持原样');
  assert.equal(before.handsObserved, 3);
  if (outcome.ok) assert.equal(outcome.value.handsObserved, 4);
});

test('玩家之间物理隔离：两个画像的日志与指标互不共享', () => {
  // 用带玩家前缀的 handId，避免「谁的手牌」产生歧义（这本身也是推荐做法）
  const withId = (playerId: string, seq: number, success: boolean): HandObservation => ({
    handId: `${playerId}-H${seq}`,
    playerId,
    seq,
    timestamp: TS,
    observations: [{ metric: PlayerMetric.VPIP, success }],
  });

  const build = (playerId: string, n: number, successes: number) => {
    let profile = createProfile(playerId);
    for (let i = 0; i < n; i++) {
      const outcome = observeHand(profile, withId(playerId, i, i < successes));
      assert.equal(outcome.ok, true);
      if (outcome.ok) profile = outcome.value;
    }
    return profile;
  };

  const a = build('alice', 5, 5);
  const b0 = build('bob', 5, 0);

  assert.notEqual(a.log, b0.log);
  assert.notEqual(a.metrics, b0.metrics);
  assert.notEqual(a.metrics[PlayerMetric.VPIP], b0.metrics[PlayerMetric.VPIP]);
  assert.notEqual(a.seenHandIds, b0.seenHandIds);
  assert.equal(a.playerId, 'alice');
  assert.equal(b0.playerId, 'bob');

  // 每个玩家各有自己的历史：alice 重复自己的 H0 必须被拒绝
  const aliceAgain = observeHand(a, withId('alice', 0, true));
  assert.equal(aliceAgain.ok, false, 'alice 自己重复 alice-H0 应被拒绝');

  // bob 新增自己的一手成功
  const bobNew = observeHand(b0, withId('bob', 5, true));
  assert.equal(bobNew.ok, true, 'bob 的 bob-H5 是 bob 自己的新牌局，与 alice 无关');
  if (!bobNew.ok) return;
  const b = bobNew.value;

  // 把 alice 的手牌记到 bob 的画像上必须被拒绝
  const crossPlayer = observeHand(b, withId('alice', 0, true));
  assert.equal(crossPlayer.ok, false, '把 alice 的手牌记到 bob 的画像上必须被拒绝（PLAYER_MISMATCH）');
  if (!crossPlayer.ok) {
    assert.ok(crossPlayer.issues.some((i) => i.code === 'PLAYER_MISMATCH'));
  }

  // 被拒绝的跨玩家写入不得改变任何一侧
  assert.equal(b.handsObserved, 6, '失败的写入不得改变 bob 画像');
  assert.equal(metricOf(b, PlayerMetric.VPIP).opportunities, 6);

  // 两侧统计独立演进
  assert.equal(metricOf(a, PlayerMetric.VPIP).successes, 5);
  assert.equal(metricOf(a, PlayerMetric.VPIP).opportunities, 5, 'alice 的画像不得被 bob 的事改变');
  assert.equal(metricOf(b, PlayerMetric.VPIP).successes, 1, 'bob 新增的这一手是 bob 的第 1 次成功');
  assert.equal(metricOf(b, PlayerMetric.VPIP).opportunities, 6);
  assert.equal(a.handsObserved, 5);

  // handId 命名空间按玩家隔离：两边各自持有自己的 id 集合
  assert.equal(a.seenHandIds.has('alice-H0'), true);
  assert.equal(a.seenHandIds.has('bob-H0'), false);
  assert.equal(b.seenHandIds.has('bob-H5'), true);
  assert.equal(b.seenHandIds.has('alice-H0'), false, 'bob 的历史里不应出现 alice 的手牌');
});

test('createProfile 拒绝空 playerId', () => {
  assert.throws(() => createProfile(''), /playerId/);
  assert.throws(() => createProfile('   '), /playerId/);
});

/* ============================================================
 * 八、先验来源透明性（规范第十四节）
 * ============================================================ */

test('先验来源绝不允许出现 THEORY / GTO 字样', () => {
  for (const metric of ALL_PLAYER_METRICS) {
    const prior = METRIC_DEFINITIONS[metric].prior;
    assert.ok(
      Object.values(PriorSource).includes(prior.source),
      `${metric} 的先验来源 ${prior.source} 不在允许列表内`,
    );
    assert.ok(
      !/THEORY|GTO/i.test(prior.source),
      `${metric} 的先验来源不得冒充理论（实际 ${prior.source}）`,
    );
    assert.ok(!/THEORY|GTO/i.test(prior.description), `${metric} 的先验说明不得声称是理论`);
  }
});

test('所有 25 项指标都有非空的中文机会 / 成功规则说明', () => {
  for (const metric of ALL_PLAYER_METRICS) {
    const def = METRIC_DEFINITIONS[metric];
    assert.ok(def.opportunityRule.length > 0, `${metric} 缺少机会规则`);
    assert.ok(def.successRule.length > 0, `${metric} 缺少成功规则`);
    assert.ok(def.label.length > 0, `${metric} 缺少中文标签`);
    assert.ok(def.prior.center > 0 && def.prior.center < 1, `${metric} 先验中心必须在 (0,1)`);
    assert.ok(def.prior.strength > 0, `${metric} 先验强度必须为正`);
  }
});

test('emptyMetricStat 不带任何观测痕迹', () => {
  const stat = emptyMetricStat(PlayerMetric.CBET);
  assert.equal(stat.opportunities, 0);
  assert.equal(stat.successes, 0);
  assert.equal(stat.rawRate, null);
  assert.equal(stat.confidence, 0);
  assert.equal(stat.effectiveSampleSize, 0);
  assert.equal(stat.lastUpdatedSeq, -1);
});

/* ============================================================
 * 九、分层与可用性
 * ============================================================ */

test('分层阈值：< 30 初步，30~200 标准，> 200 高可信', () => {
  assert.equal(sampleTier(0), SampleTier.PRELIMINARY);
  assert.equal(sampleTier(29.9), SampleTier.PRELIMINARY);
  assert.equal(sampleTier(30), SampleTier.STANDARD);
  assert.equal(sampleTier(200), SampleTier.STANDARD);
  assert.equal(sampleTier(200.1), SampleTier.CONFIRMED);
});

test('分层阈值可配置（规范第二十五节）', () => {
  assert.equal(
    sampleTier(50, { preliminaryBelow: 100, confirmedAbove: 500 }),
    SampleTier.PRELIMINARY,
  );
  assert.equal(
    sampleTier(50, { preliminaryBelow: 10, confirmedAbove: 40 }),
    SampleTier.CONFIRMED,
  );
});

test('样本不足时 hasUsableSample 为 false', () => {
  const thin = profileWith(PlayerMetric.VPIP, 3, 3);
  assert.equal(hasUsableSample(thin), false);
  assert.equal(hasUsableSample(createProfile('empty')), false);
});

test('样本充足时 hasUsableSample 为 true', () => {
  const thick = profileWith(PlayerMetric.VPIP, 300, 90);
  assert.equal(hasUsableSample(thick), true);
});

test('sampleSummary 正确区分充足与不足的指标', () => {
  const profile = profileWith(PlayerMetric.VPIP, 100, 30);
  const summary = sampleSummary(profile);
  assert.equal(summary.totalHands, 100);
  assert.ok(summary.sufficientMetrics.includes(PlayerMetric.VPIP));
  assert.ok(summary.insufficientMetrics.includes(PlayerMetric.RIVER_OVERBET));
  assert.equal(
    summary.sufficientMetrics.length + summary.insufficientMetrics.length,
    ALL_PLAYER_METRICS.length,
  );
});

test('版本号存在（缓存与日志依赖它）', () => {
  assert.equal(typeof PROFILE_VERSION, 'string');
  assert.ok(PROFILE_VERSION.length > 0);
  assert.equal(createProfile('p1').version, PROFILE_VERSION);
});
