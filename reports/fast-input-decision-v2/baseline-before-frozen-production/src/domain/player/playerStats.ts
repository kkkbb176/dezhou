/**
 * 玩家统计计算：收缩、置信度、时间衰减（Step 6，规范第十一 / 十三 / 十五 / 十六节）
 *
 * ## 三项核心机制
 *
 * 1. **Shrinkage（收缩）** —— 规范第十三节
 *    观察 3 手全部入池，**不能**得出 VPIP = 100%。
 *    用 Beta-Binomial 后验均值向先验收缩：
 *      adjusted = (successes + k·center) / (n + k)
 *    其中 k 是先验强度（等效样本量）。
 *
 * 2. **有效样本量** —— 规范第十一节
 *    时间衰减之后，样本的**信息量**小于原始计数。
 *    用 Kish 有效样本量公式：n_eff = (Σw)² / Σw²
 *    它同时惩罚「样本少」与「权重不均」，是不确定性的诚实度量。
 *
 * 3. **置信度** —— 规范第十一节
 *    置信度**不是**成功率，而是「这个估计有多可信」。
 *    由有效样本量与先验强度的比值决定：n_eff 越大、先验越弱，越可信。
 *    **样本不足时必须低**，绝不因为比率极端就报高可信。
 */

import {
  METRIC_DEFINITIONS,
  emptyMetricStat,
  type MetricPrior,
  type MetricStat,
  type PlayerMetric,
} from './player.types.ts';

/* ============================================================
 * 时间衰减（规范第十六节）
 * ============================================================ */

export type DecayOptions = {
  /** 半衰期（手数）：距今 halfLife 手的观测权重为 0.5 */
  halfLife: number;
  /**
   * 单手最大影响上限（规范第十六节）。
   *
   * 含义：任何**单次**观测对统计的权重不得超过总权重的一定比例。
   * 这保证「最近一手不得推翻几百手历史」。
   */
  maxSingleHandShare: number;
};

export const DEFAULT_DECAY: DecayOptions = {
  halfLife: 400,
  maxSingleHandShare: 0.05,
};

/**
 * 计算某次观测的时间衰减权重。
 *
 * @param ageInHands 距当前的手数（0 = 当前这手）
 */
export function decayWeight(ageInHands: number, options: DecayOptions = DEFAULT_DECAY): number {
  if (!Number.isFinite(ageInHands) || ageInHands < 0) {
    throw new Error(`decayWeight: ageInHands 必须是非负有限数（收到 ${ageInHands}）`);
  }
  if (!(options.halfLife > 0)) {
    throw new Error(`decayWeight: halfLife 必须为正（收到 ${options.halfLife}）`);
  }
  // 2^(-age/halfLife)
  return Math.pow(2, -ageInHands / options.halfLife);
}

/**
 * 把单手影响限制在总权重的给定比例之内（规范第十六节的落地）。
 *
 * ## 语义（精确定义）
 *
 * `maxShare` 是**单手权重的上限倍数**：`实际上限 = maxShare × Σ(均匀权重)`
 * = `maxShare × n`（n = 参与计算的手数）。返回的新权重满足
 *   `max(新权重) ≤ maxShare · n · mean(w) = maxShare · Σw`
 *
 * ### 为什么是「相对均匀权重」而不是「占总权重的比例」
 *
 * 这是本函数迭代三次才定下来的关键点，两个方向的错误都实测过：
 *
 * 1. **若 `maxShare` 直接表示占总权重的比例**（规范字面语义）：
 *    n 手均匀分布时单手占比恒为 `1/n`，这是任何分配下的理论下界。
 *    因此当 `maxShare < 1/n`（即 n > 20 时 5% 的上限）该约束
 *    **数学上不可满足**。实测：半衰期 400 手时 n=601 手的最新一手
 *    占比仅 0.27%，远低于 5% —— 上限对一个健康分布施加了无意义约束。
 *
 * 2. **若用 `maxShare / n` 当实际上限**：n 手均匀分布的单手占比恰为
 *    `1/n > maxShare / n`，于是**连完全均匀的权重都会超限**，
 *    函数对任何输入都触发压缩（或任何输入都不触发），彻底失效。
 *
 * 取「相对均匀权重」后，两个性质同时成立：
 * - 均匀权重**永不触发**（无谓的信息损失为零）
 * - 病态集中（例如 599 手权重 1 + 单手权重 500，占比 45%）**必然触发**
 *
 * ## 为什么不能用「按比例整体缩放」
 *
 * 朴素实现是 `scale = cap / maxWeight` 然后全体乘 scale。
 * 但缩放让分子分母同时乘 scale，**占比完全不变** ——
 * 权重 [10,1,1,1] 缩放后占比仍是 76.9%，约束根本没被执行。
 *
 * ## 为什么也不能用「截断到 λ」或「只压缩最大值」
 *
 * 这两种做法都**只做保序压缩**，而保序压缩无法把最大占比降到
 * 「w_max / (其余权重之和 + w_max)」以下 —— 权重 [10,1,1,1] 无论怎么
 * 保序压缩，最大占比都不会低于 10/13 ≈ 76.9%。
 * 实测：λ 越小占比反而越高，二分收敛到错误的一侧。
 *
 * ## 实际做法：向均匀分布线性插值（可证明单调）
 *
 * 令 `m = mean(w)`、`M = max(w)`，取
 *   `w(α) = (1 − α)·m + α·w`，α ∈ [0, 1]
 * - α = 1 → 原始权重，`M ≥ maxShare·Σw`（前置条件保证）
 * - α = 0 → 完全均匀，`m = Σw/n ≤ maxShare·Σw`（因为 maxShare·n ≥ 1）
 * 且 `w_max(α) = (1−α)m + αM` 是 α 的线性函数、`Σw(α) ≡ Σw` 恒定，
 * 故 `shareAt(α)` 连续且单调 → 二分求得的 α 是**唯一**解。
 */
export function capSingleHandWeight(
  weights: readonly number[],
  maxShare: number,
): number[] {
  if (weights.length === 0) return [];
  if (!Number.isFinite(maxShare) || maxShare <= 0 || maxShare > 1) {
    throw new Error(`capSingleHandWeight: maxShare 必须在 (0, 1]（收到 ${maxShare}）`);
  }
  // 非有限 / 负数权重不参与计算（与 effectiveSampleSize 同一口径）
  const sanitized = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const total = sanitized.reduce((s, w) => s + w, 0);
  if (!(total > 0)) return sanitized;
  if (maxShare >= 1) return sanitized;

  const positiveCount = sanitized.reduce((count, w) => count + (w > 0 ? 1 : 0), 0);
  if (positiveCount <= 1) return sanitized;

  const maxWeight = Math.max(...sanitized);
  if (maxWeight <= total * maxShare) return sanitized;

  /**
   * **可达的最小最大占比 = `1 / positiveCount`。**
   *
   * 推导：压缩族把正权重向它们的均值插值，而均值 = `total / positiveCount`。
   * 在 α = 0 处所有正权重都等于该均值，此时最大占比恰为
   * `mean / total = 1 / positiveCount`；α → 1 时单调升回原始占比。
   * 因此 `1 / positiveCount` 就是本族能达到的最小值，也是判据。
   *
   * ⚠️ 这里**不能**用 `maxWeight / total`（红队 MAJOR-7 修复过程中犯过的错）：
   * 那是**压缩前**最大值的质量占比，与本族能达到的最小值无关。
   * 用错判据会让函数在 `maxShare` 明明可满足时提前返回未压缩的权重
   * （实测：[10, 1×11] 在 maxShare=0.12 时被判为不可满足，
   * 而它实际可压到 1/12 ≈ 0.083）。
   */
  const minAchievableShare = 1 / positiveCount;
  if (maxShare < minAchievableShare) {
    // 数学上不可满足（连完全均匀都超限）→ 不做改动，
    // 并**不假装**返回一个满足约束的结果
    return sanitized;
  }

  // ⚠️ 均值必须按**同一个口径**求：分母用 positiveCount，不是 n。
  //
  // 红队 MAJOR-7：旧版用 `total / n`（n 含 0 权重项）。
  // 传进 [1, 1, 1, 0, 0, ...] 这类含 0 的权重时，
  // `mean` 被 0 项拉低 → 插值族在 α=1 处的最大占比**已经**满足约束，
  // 于是二分收敛到 α = 0，返回**完全未约束**的原始权重。
  //
  // 注意：`computeMetricStat` 只传正权重，因此生产路径不可达；
  // 但这是导出 API，其注释承诺「与 effectiveSampleSize 同一口径」，
  // 不兑现承诺就是缺陷。
  const mean = total / positiveCount;

  /**
   * α 处（0 = 均匀、1 = 原始）的**正权重项**最大占比。
   *
   * 只考虑正权重项：0 权重项不携带任何证据，不应参与「单手影响力」的度量，
   * 也不应把 `mean` 拉低（红队 MAJOR-7）。
   * α = 0 时全部正权重都等于 `mean`，因此最大占比恰为 `1 / positiveCount`。
   */
  const shareAt = (alpha: number): number => {
    let max = 0;
    for (const w of sanitized) {
      if (!(w > 0)) continue;
      const value = (1 - alpha) * mean + alpha * w;
      if (value > max) max = value;
    }
    return max / total;
  };

  let low = 0;
  let high = 1;
  for (let i = 0; i < 120; i++) {
    const mid = (low + high) / 2;
    if (shareAt(mid) <= maxShare) low = mid;
    else high = mid;
  }

  const alpha = low;
  // 正权重项向均匀插值；0 权重项保持 0（它们本就不携带证据）
  return sanitized.map((w) => (w > 0 ? (1 - alpha) * mean + alpha * w : 0));
}

/* ============================================================
 * 有效样本量（Kish）
 * ============================================================ */

/**
 * Kish 有效样本量：n_eff = (Σw)² / Σw²。
 *
 * 性质（都有测试）：
 * - 权重全部相等 → n_eff = n
 * - 权重高度集中 → n_eff 远小于 n
 * - 全部权重为 0 → n_eff = 0
 */
export function effectiveSampleSize(weights: readonly number[]): number {
  let sum = 0;
  let sumSquares = 0;
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) continue;
    sum += w;
    sumSquares += w * w;
  }
  if (!(sumSquares > 0)) return 0;
  return (sum * sum) / sumSquares;
}

/* ============================================================
 * 置信度
 * ============================================================ */

/**
 * 由有效样本量与先验强度求可信度。
 *
 * 公式：confidence = n_eff / (n_eff + k)
 * 语义：观测证据在「观测 + 先验」总证据中的占比。
 *
 * 关键性质：**n_eff 很小的时候置信度一定低** —— 无论比率多么极端。
 * 这正是规范第十三节要防的「3 手 100% 入池就当 100% 玩家处理」。
 */
export function confidenceFromSamples(effectiveN: number, priorStrength: number): number {
  if (!(effectiveN > 0)) return 0;
  const denominator = effectiveN + Math.max(0, priorStrength);
  if (!(denominator > 0)) return 0;
  return Math.min(1, effectiveN / denominator);
}

/* ============================================================
 * 收缩统计
 * ============================================================ */

/**
 * 从「带权观测」计算一项指标的完整统计。
 *
 * @param observations 每次机会的观测：weight = 时间衰减权重，success = 是否成功
 */
export function computeMetricStat(
  metric: PlayerMetric,
  observations: ReadonlyArray<{ weight: number; success: boolean }>,
  options: {
    decay?: DecayOptions;
    prior?: MetricPrior;
    /** 用于排序与窗口的序号（通常是手牌序号） */
    lastUpdatedSeq?: number;
  } = {},
): MetricStat {
  const definition = METRIC_DEFINITIONS[metric];
  const prior = options.prior ?? definition.prior;
  const decay = options.decay ?? DEFAULT_DECAY;

  // ---- 校验观测 ----
  let rawOpportunities = 0;
  let rawSuccesses = 0;
  const rawWeights: number[] = [];

  for (const observation of observations) {
    if (!Number.isFinite(observation.weight) || observation.weight < 0) {
      throw new Error(
        `computeMetricStat(${metric}): 观测权重必须是非负有限数（收到 ${observation.weight}）`,
      );
    }
    rawOpportunities++;
    if (observation.success) rawSuccesses++;
    if (observation.weight > 0) rawWeights.push(observation.weight);
  }

  if (rawOpportunities === 0) {
    return {
      ...emptyMetricStat(metric),
      prior,
      lastUpdatedSeq: options.lastUpdatedSeq ?? -1,
    };
  }

  // ---- 单手影响上限（规范第十六节）----
  const capped = capSingleHandWeight(rawWeights, decay.maxSingleHandShare);

  // ---- 带权成功数 ----
  // 注意：success 与 weight 一一对应，但 capSingleHandWeight 只处理了正权重，
  // 因此这里按「正权重观测」重新配对，避免下标错位。
  const positiveObservations = observations.filter((o) => o.weight > 0);
  let weightedSuccesses = 0;
  for (let i = 0; i < positiveObservations.length; i++) {
    if (positiveObservations[i]!.success) weightedSuccesses += capped[i] ?? 0;
  }

  const effectiveN = effectiveSampleSize(capped);
  const rawRate = rawOpportunities > 0 ? rawSuccesses / rawOpportunities : null;

  // ---- 收缩：Beta-Binomial 后验均值 ----
  //
  // ⚠️ 分母必须用 **capped 权重之和**，不能用 effectiveSampleSize。
  //
  // 这是本轮发现的真实不一致：Kish 有效样本量 n_eff = (Σw)²/Σw² 在权重
  // 不均时会**远小于** Σw（衰减后同样如此）。若用 n_eff 当分母、
  // 却用 capped 权重算分子，得到的 adjustedRate 会落在
  // 「先验中心 ~ 原始比率」区间**之外** —— 相当于凭空向下拉偏。
  // 实测：200 手 40 次成功时 adjustedRate = 0.161，
  // 而先验中心 0.25、原始比率 0.2，两者都不支持 0.161。
  //
  // 用 Σ(capped) 当分母后，adjustedRate 恒为
  //   (1−λ)·先验中心 + λ·(加权成功率)，λ = Σcapped/(Σcapped + k)
  // 即「先验与观测的凸组合」，数学上保证不会越界。
  const cappedWeightSum = capped.reduce((s, w) => s + w, 0);
  const k = Math.max(0, prior.strength);
  const adjustedRate =
    cappedWeightSum + k > 0
      ? (weightedSuccesses + k * prior.center) / (cappedWeightSum + k)
      : prior.center;

  return {
    metric,
    successes: rawSuccesses,
    opportunities: rawOpportunities,
    rawRate,
    adjustedRate,
    effectiveSampleSize: effectiveN,
    confidence: confidenceFromSamples(effectiveN, k),
    prior,
    lastUpdatedSeq: options.lastUpdatedSeq ?? -1,
  };
}

/* ============================================================
 * 可信度分层（规范第二十五节 / 三层置信度）
 * ============================================================ */

export const SampleTier = {
  /** < 30 手：只能给「初步倾向」 */
  PRELIMINARY: 'PRELIMINARY',
  /** 30~200 手：中等可信 */
  STANDARD: 'STANDARD',
  /** > 200 手：高可信 */
  CONFIRMED: 'CONFIRMED',
} as const;
export type SampleTier = (typeof SampleTier)[keyof typeof SampleTier];

export type TierThresholds = {
  preliminaryBelow: number;
  confirmedAbove: number;
};

export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  preliminaryBelow: 30,
  confirmedAbove: 200,
};

/**
 * 按**有效样本量**分层。
 *
 * 规范第二十五节要求阈值可配置，因此这里接受可选阈值。
 * 注意用的是 effectiveSampleSize 而不是原始 opportunities ——
 * 时间衰减之后，300 手旧数据的信息量可能远小于 300。
 */
export function sampleTier(
  effectiveN: number,
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS,
): SampleTier {
  if (effectiveN < thresholds.preliminaryBelow) return SampleTier.PRELIMINARY;
  if (effectiveN <= thresholds.confirmedAbove) return SampleTier.STANDARD;
  return SampleTier.CONFIRMED;
}

/**
 * 分层 → 是否允许输出方向性结论（规范第二十五 / 三十三节）。
 *
 * PRELIMINARY 只能输出「初步倾向」，不得作为稳定画像使用。
 */
export function allowsDirectionalClaim(tier: SampleTier): boolean {
  return tier !== SampleTier.PRELIMINARY;
}
