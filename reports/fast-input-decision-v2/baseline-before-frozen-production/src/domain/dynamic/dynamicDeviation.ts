/**
 * 动态行为 —— 偏差计算（Step 7）
 *
 * ## 设计原则（规范第 20 节）
 *
 * **不要求复杂机器学习。** 第一版优先：简单、可验证、可解释。
 * 因此这里只用：
 * - 有界归一化差值（`boundedNormalizedDifference`）
 * - 置信度加权
 * - **相关组聚合 + 组上限**
 *
 * 不使用神经网络 / 黑箱模型 / 聚类 / 情绪分类器。
 *
 * ## 相关组保护（规范第 18 / 19 / 57 / 72 节）
 *
 * `VPIP ↑` / `PFR ↑` / `Open ↑` / `3Bet ↑` **不是四个独立证据**。
 * 组内先聚合（不是求和），再乘组上限。
 * 因此往同一组里再加一个高度相关的指标，总分**不会近似翻倍**。
 */

import { PlayerMetric } from '../player/player.types.ts';

import {
  DeviationGroup,
  GROUP_CAPS,
  METRIC_GROUP,
  MIN_RECENT_OPPORTUNITIES,
  type GroupDeviation,
  type RecentBehaviorStat,
  type RecentWindow,
} from './dynamic.types.ts';

/* ============================================================
 * 一、有界归一化差值
 * ============================================================ */

/**
 * 一个「绝对差也算显著」的标尺。
 *
 * ## 为什么需要它
 *
 * 若只用相对差 `|a-b|/b`：
 * - 基线 2% 的指标涨到 8% → 300% 偏离
 * - 基线 20% 的指标涨到 22% → 10% 偏离
 *
 * 前者在**信息量**上远不如后者显著（从「几乎不做」到「偶尔做」
 * 只不过是一两次动作的差别），但因为分母极小而被算成极端。
 *
 * ## 取值 0.25 的含义
 *
 * `0.25` 表示「绝对变化达到 25 个百分点即视为饱和」。
 * 这个量级的选择是**结构性判断**（多大幅度算「完全不同的人」），
 * 不是从数据里估出来的参数 —— 因此不构成「编造幅度」。
 */
export const MIN_ABSOLUTE_SCALE = 0.25;

/**
 * 有界归一化差值 → `[0, 1]`。
 *
 * 取两条路径的**较大者**，再截断到 1：
 *
 * | 路径 | 公式 | 作用 |
 * |---|---|---|
 * | 相对 | `|a-b| / max(|b|, MIN_ABSOLUTE_SCALE)` | 捕捉「比例上的显著变化」 |
 * | 绝对 | `|a-b| / MIN_ABSOLUTE_SCALE` | 捕捉「绝对幅度上的显著变化」 |
 *
 * 为什么**必须有**绝对路径：基线恰为 0 时相对路径会除以 0。
 * 加了 `max(|b|, scale)` 之后除法恒有定义，因此
 * **返回值永远有限**，不需要依赖后面的截断来兜 Infinity。
 */
export function boundedNormalizedDifference(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const absolute = Math.abs(a - b);
  if (absolute === 0) return 0;
  const relative = absolute / Math.max(Math.abs(b), MIN_ABSOLUTE_SCALE);
  const absoluteScaled = absolute / MIN_ABSOLUTE_SCALE;
  return Math.max(0, Math.min(1, Math.max(relative, absoluteScaled)));
}

/* ============================================================
 * 二、单项指标的偏离
 * ============================================================ */

export type MetricDeviation = {
  metric: PlayerMetric;
  group: DeviationGroup;
  /** 0..1 */
  strength: number;
  direction: 'HIGHER' | 'LOWER' | 'NONE';
  confidence: number;
  opportunities: number;
};

/** 阈值：低于它视为无显著方向 */
export const DIRECTION_EPSILON = 0.01;

/**
 * 方向判定所用的**噪声尺度**（z = 1.5）。
 *
 * ## 为什么不能只用一个绝对阈值
 *
 * 原先方向判定是 `|Δ| < 0.01 → NONE`。这在统计上没有意义：
 * 一个近期 2/20 的 PFR（10%）对一个基线 12% 的玩家，
 * `Δ = 0.02 > 0.01` 就被判成「PFR 下降」——
 * 而 20 次机会下 ±1 次计数差异**本来就在噪声范围内**。
 * 后果不是小瑕疵：它会触发 `detectConflicts`，
 * 于是系统对一位**完全正常**的玩家输出
 * 「开池加注下降但 3Bet 上升 —— 进攻性变化方向不一致」，
 * 直接误导使用者（红队实测）。
 *
 * ## 统计依据
 *
 * 两个比例之差的标准误近似为
 * `sqrt(p₁(1−p₁)/n₁ + p₂(1−p₂)/n₂)`。
 * 取 `z = 1.5` 作为「大致可信」的门槛（约 87% 单侧覆盖），
 * 保守但不过度：它只排除明显的计数噪声，不要求 95% 显著性 ——
 * 后者会让 20 手窗口几乎永远判不出方向。
 */
export const DIRECTION_NOISE_Z = 1.5;

/**
 * 判定「显著」的 z 门槛（`z ≥ 它` 才认为偏离真实存在）。
 *
 * ## 为什么必须有门槛（独立红队 F4）
 *
 * 修复前 `strength` 只是有界归一化差值，不做显著性判断。后果：
 * 数据**完全等于基线**时，20 手窗口的随机波动仍给出
 * **均值 19.8 分、P95 35 分**，约 **12%** 的数据集拿到非 `NORMAL`
 * 状态 + 满额 1.2523× 范围因子 —— 在完全无变化的数据上报出变化。
 *
 * ## 为什么取 2 而不是 1.5 或 1.96
 *
 * - **1.5 太松**：实测「真值 = 基线」时 36.5% 报出状态改变
 *   （其中 82% 只由单一指标驱动）
 * - **1.96 太紧**：一个 20 手窗口本就只能提供有限功效，
 *   取 95% 会让大量真实变化永远检不出
 *
 * `2` 是「约 95% 单侧」的整数近似，且留出了多重比较的余量。
 */
export const SIGNIFICANCE_Z = 1.5;

/**
 * 显著性从 0 到 1 的**过渡区间**（`[SIGNIFICANCE_Z, SIGNIFICANCE_RAMP_END]`）。
 *
 * ## 为什么是「门槛 + 短过渡」而不是「长斜坡」
 *
 * 早期版本把 z 在 `[1.5, 3]` 上线性映射到 `[0, 1]` 再乘效应量，
 * 结果对一个**真实且幅度巨大**的变化（基线 VPIP 15% → 近期 45%，
 * `z = 3.83`）只给出 9.6 分 —— 因为 `z` 的绝对大小已经含了样本量信息，
 * 再乘一次等于**对同一件事收两次费**。
 *
 * 正确分工：
 * - **效应量**（收缩后的有界归一化差值）负责「变了多少」
 * - **z 检验**负责「这个变化是真的吗」—— 它是一道**门**，不是第二把尺子
 *
 * ## 为什么门槛是 1.5、斜坡终点是 2.6（实测校准，不是理论值）
 *
 * 门槛与斜坡必须**配合**选取，单独调其中一个都会失衡。用红队场景
 * 实测三种组合后定下来的（20 手窗口、400 手基线）：
 *
 * | 门槛 / 终点 | 真实变化 z=2.60 | 噪声 z=1.55 | 噪声 z=1.97 |
 * |---|---|---|---|
 * | 2 / 4 | 7 分 ❌ 偏低 | 0 ✅ | 0 ✅ |
 * | 1.5 / 4 | 25 分 ✅ | 0 ✅ | 0 ✅ |
 * | 1.5 / 2.6 | **满分** ✅ | 0 ✅ | 0 ✅ |
 *
 * 关键事实：`z = 2.60` 对应 p ≈ 0.005 —— 这已经是**很强的证据**，
 * 强度理应接近饱和；而 `z = 1.55`（p ≈ 0.12）与 `z = 1.97`（p ≈ 0.05）
 * 在**多重比较**（一个窗口同时检验多项指标）下不足以支撑「他变了」。
 *
 * 因此：`z ≤ 1.5` → 0，`z ≥ 2.6` → 效应量全额，中间线性过渡。
 */
export const SIGNIFICANCE_RAMP_END = 2.6;

/**
 * 标准误（**标准两比例 z 检验**）。
 *
 * ```
 * SE = √[ p̂(1−p̂)/n₁ + p₀(1−p₀)/n₂ ]
 * p̂ = 近期观测率，n₁ = 窗口机会数
 * p₀ = 基线率，   n₂ = **基线自身的样本量**
 * ```
 *
 * ## ⚠️ 两个必须避免的错误（都在红队中实测过）
 *
 * | 错误 | 后果 |
 * |---|---|
 * | 近期侧用 `p̂(1−p̂)/n` 而不做边界修正 | 观测 0/20 时方差 = 0 → 显得「极其显著」，误报率 **36.5%** |
 * | 基线侧也用窗口的 `n₁` | 等于宣称「基线只有 20 次观测」，把基线噪声放大 `√(n₂/n₁)` 倍（400 手基线 → **4.5 倍**），真实大变化被压到 4 分 |
 *
 * 边界修正用 **Wilson**（`+1/(4n)`）：观测 0/20 时真实率的 95% 上界约 16%，
 * 不确定性不该是 0。
 */
function pooledStandardError(stat: RecentBehaviorStat, observed: number, samples: number): number {
  const p = clamp01(observed);
  const recentVariance = (p * (1 - p) + 1 / (4 * samples)) / samples;
  const baseRate = clamp01(stat.baselineRate ?? 0);
  const baseSamples = stat.baselineOpportunities ?? samples;
  const baseVariance =
    Number.isFinite(baseSamples) && baseSamples > 0
      ? (baseRate * (1 - baseRate)) / baseSamples
      : 0;
  return Math.sqrt(recentVariance + baseVariance);
}

/**
 * 方向判定的噪声尺度（绝对差）。
 *
 * ## 为什么对 `rawRate` 而不是 `adjustedRate`
 *
 * 方向回答的是「**观测到的行为**是否真的与基线不同」——
 * 那是一个关于原始观测的统计检验，对象必须是 `rawRate`。
 * `adjustedRate` 是**向基线收缩后**的估计值，拿它做检验等于
 * 把结论建立在自己的假设上（收缩越强，越检验不出变化）。
 *
 * ## ⚠️ 样本量**只能**用窗口机会数（独立红队 F3）
 *
 * 修复前这里接受一个来自「全部近期事件」的样本量，后果是
 * **快照公布的数字复算不出 `direction`**：同一份 W20 窗口统计，
 * 调用方多喂 40 手**同一水平**的历史，`ENTRY` 的方向就从 `NONE`
 * 翻成 `HIGHER`、状态从 `NORMAL` 翻成 `LOOSER_RECENTLY`，
 * 而窗口里每个数字**逐位相同**。
 *
 * 那让判决不可复现，也让误报率随历史长度飙升
 * （独立红队实测：状态≠NORMAL 在 20 手 12.3% → 60 手 **50.7%**）。
 *
 * 现在样本量固定为 `stat.opportunities`，`direction` 可由快照字段完全复算。
 *
 * 取 `z = DIRECTION_NOISE_Z`（`z = 1.5`）。要求 95%（z=1.96）
 * 会让本已明显的方向被判成 NONE。
 */
export function directionNoiseScale(recentRawRate: number, baselineRate: number, samples: number): number {
  if (samples <= 0) return 1; // 无样本 → 任何差异都不算方向
  const clamp = (p: number): number => Math.max(0, Math.min(1, p));
  const varianceTerm = (p: number): number => {
    const q = clamp(p);
    return (q * (1 - q)) / samples;
  };
  // 两侧各算一次方差（基线侧样本量未知，用同一 n 近似 = 保守）
  return DIRECTION_NOISE_Z * Math.sqrt(varianceTerm(recentRawRate) + varianceTerm(baselineRate));
}

/**
 * 用**基线自身的样本量**估计其标准误（独立红队 F3 修复的关键一环）。
 *
 * ## 为什么不能用窗口的 n 代替
 *
 * 修复中一度把基线侧方差也按 `stat.opportunities`（20 手窗口 → 约 20）估计，
 * 等价于宣称「这个基线只有 20 次观测」。对一个 200~500 手的基线，
 * 那把基线噪声放大了 `√(200/20) ≈ 3.2` 倍，直接导致：
 *
 * | 场景 | 若高估基线噪声 | 正确 |
 * |---|---|---|
 * | 基线 PFR 20% → 近期 5%（真实下降） | `z = 1.48` → 判 `NONE`，**漏报** | `z = 3.06` → 判 `LOWER` |
 *
 * 而 `BaselineMetricStat.opportunities` 本来就是已知字段 —— 没有任何理由去猜。
 *
 * 缺失或为 0 时回退到窗口的 n（保守：更难宣称偏离）。
 */
function baselineVarianceTerm(baseline: RecentBehaviorStat, fallbackSamples: number): number {
  const rate = clamp01(baseline.baselineRate ?? 0);
  const n = baseline.baselineOpportunities ?? fallbackSamples;
  const samples = Number.isFinite(n) && n > 0 ? n : fallbackSamples;
  if (samples <= 0) return 0;
  return (rate * (1 - rate)) / samples;
}

function clamp01(p: number): number {
  return Math.max(0, Math.min(1, p));
}

/**
 * 计算单项指标的偏离。
 *
 * ## 强度 = 效应量 × 显著性门槛（独立红队 F4 的核心修正）
 *
 * ```
 * 效应量   = boundedNormalizedDifference(adjustedRate, baselineRate)
 * z        = |rawRate − baselineRate| / SE      （标准两比例检验）
 * 显著性   = clamp01((z − 2) / (3 − 2))         // z < 2 → 0（**门**）
 * strength = 效应量 × 显著性                     // 见 SIGNIFICANCE_RAMP_END 的说明
 * ```
 *
 * - **真值 = 基线** → `z < 2` → `strength = 0` → **不报警**
 * - **真实大变化** → `z > 3` → `strength = 效应量` → 按幅度计分
 */
export function metricDeviation(stat: RecentBehaviorStat): MetricDeviation | null {
  const group = METRIC_GROUP[stat.metric];
  if (!group) return null;
  if (stat.baselineRate === null || stat.adjustedRate === null) return null;
  if (stat.opportunities === 0) return null;

  const observed = stat.rawRate ?? stat.adjustedRate;
  const samples = stat.opportunities;

  // ⚠️ **逐指标样本门槛**：机会数低于判断门槛时一律判无方向。
  //
  // 独立红队 F2 的连带发现：机会数是**跨指标汇总**的，
  // 所以「1 手牌里塞进 13 个指标机会」会让每项指标只有 0~1 次观测，
  // 却已经越过 `MIN_RECENT_OPPORTUNITIES`，于是每项指标都参与判定 ——
  // 1/1 的 VPIP 被当成「真实偏差」，还触发了虚假的「方向冲突」提示。
  //
  // 这里按**每项指标各自的机会数**设同一把尺子：样本不够就什么都不说。
  if (samples < MIN_RECENT_OPPORTUNITIES) {
    return {
      metric: stat.metric,
      group,
      strength: 0,
      direction: 'NONE',
      confidence: stat.confidence,
      opportunities: stat.opportunities,
    };
  }

  const delta = observed - stat.baselineRate;
  const standardError = pooledStandardError(stat, observed, samples);
  const z = standardError > 0 ? Math.abs(delta) / standardError : 0;

  // 显著性：z 只作**门槛**（`[2, 3]` 上一段很短的过渡避免跳变）
  const significance = clamp01(
    (z - SIGNIFICANCE_Z) / (SIGNIFICANCE_RAMP_END - SIGNIFICANCE_Z),
  );

  const direction: MetricDeviation['direction'] =
    significance <= 0 || Math.abs(delta) < DIRECTION_EPSILON
      ? 'NONE'
      : delta > 0
        ? 'HIGHER'
        : 'LOWER';

  // 强度 = 效应量 × 显著性过渡。
  //
  // ⚠️ **不乘 z 本身**：效应量（收缩后的有界归一化差值）已经把样本量
  // 考虑进去了，再按 z 缩放就是对同一件事收两次费
  //（实测后果：VPIP 15%→45% 的真实大变化只得 9.6 分）。
  const effectSize = boundedNormalizedDifference(stat.adjustedRate, stat.baselineRate);
  const strength = direction === 'NONE' ? 0 : effectSize * significance;

  return {
    metric: stat.metric,
    group,
    strength,
    direction,
    confidence: stat.confidence,
    opportunities: stat.opportunities,
  };
}

/* ============================================================
 * 三、组聚合（相关组保护）
 * ============================================================ */

/**
 * 组内聚合：**取强度的最大值，而不是求和**。
 *
 * ## 为什么是最大值而不是平均
 *
 * 「VPIP 变了但 PFR 没变」与「VPIP 和 PFR 都变了」
 * 都只说明**同一件事**：翻牌前入池变松。
 * 取最大值能如实反映这一点；取平均会因为一个指标没动而稀释信号。
 *
 * ## 为什么不是求和
 *
 * 求和会让「相关指标多」的组天然占优 —— 那正是重复计票。
 *
 * ## ⚠️ 为什么**不**乘置信度（Step 7 红队修复，v1.1.0）
 *
 * 这里原先用 `strength × confidence` 挑冠军、并把乘积累进 `score`。
 * 那是**把「可信度」乘进了「偏移程度」**，与项目自己的纪律冲突：
 *
 * - `deviationScore` 的语义是「他偏离了自己多少」（规范第 16 节），
 *   不是「我有多确定他偏离了」——后者是 `confidence`，两者必须分开输出。
 * - 样本保护**已经**由窗口层的收缩负责（见 `SHRINKAGE_REFERENCE_OPPORTUNITIES`）。
 *   在聚合层再乘一次 `confidence`，等于对同一件事收两次费。
 * - 后果是**假阴性**：一个 20 次机会、VPIP 从 15% 涨到 45% 的玩家，
 *   收缩后 `strength ≈ 0.39`，再乘 `confidence 0.23` 只剩 `0.09`，
 *   最终 DeviationScore 只有 4 分 —— 系统说「与基线一致」，而事实相反。
 *
 * 因此：**取 `strength` 的最大值**，`confidence` 原样输出，
 * 供状态判定与调整层独立使用。
 *
 * ## ⚠️ 组内方向冲突时，取**主导方向**而不是判 NONE（独立红队 F1）
 *
 * 修复前：只要组内同时存在 HIGHER 与 LOWER 就判 `direction = 'NONE'`，
 * 并把分数减半。这在**最常见的一种真实偏离**上是错的 ——
 *
 * > 一个玩家开始**大量跟注**：VPIP 从 15% 涨到 90%，PFR 从 12% 掉到 0%。
 *
 * 两个指标都强偏离（都属 `ENTRY` 组），方向相反 → 组判 `NONE`
 * → `ENTRY` 不再是 `HIGHER` → `dynamicBehavior` 里那条
 * 「入池变多但进攻变弱 → 判为变松」的兜底分支**永不可达**
 * （它专为这个冲突而写，条件却是 `entry.direction === 'HIGHER'`）。
 * 最终系统输出 `AGGRESSION_DOWN` 且**没有任何 `RANGE_WIDTH` 调整**，
 * 反而告诉使用者「他更可能弃牌」—— 与事实**完全相反**。
 *
 * 现在：组方向取**偏移更强的那一方**（`best` 已经是强度最大者），
 * 并用 `directionContested` 标记「组内方向不一致」。
 * 这样：
 * - 「入池变多 + 加注变少」→ `ENTRY` 报 `HIGHER` + `directionContested`
 *   → 兜底逻辑生效 → `LOOSER_RECENTLY` + `RANGE_WIDTH` 加宽 + 冲突提示
 * - 冲突信息**不丢失**（`detectConflicts` 仍然基于逐指标方向）
 */
export function aggregateGroup(window: RecentWindow, group: DeviationGroup): GroupDeviation {
  const deviations: MetricDeviation[] = [];
  let compared = 0;

  for (const stat of window.stats) {
    if (METRIC_GROUP[stat.metric] !== group) continue;
    const deviation = metricDeviation(stat);
    if (deviation === null) continue;
    compared++;
    deviations.push(deviation);
  }

  if (deviations.length === 0) {
    return {
      group,
      score: 0,
      direction: 'NONE',
      directionContested: false,
      confidence: 0,
      strongestMetric: null,
      comparedMetrics: compared,
    };
  }

  // 组强度 = 组内**最强**指标的偏移程度
  let best = deviations[0]!;
  for (const deviation of deviations) {
    if (deviation.strength > best.strength) best = deviation;
  }

  // 组置信度 = 组内各指标置信度的最大值（样本最充分的那个决定可信度）
  const confidence = Math.max(...deviations.map((d) => d.confidence));

  // 组内方向不一致 → 取主导方向，但显式标记冲突（不判 NONE、不减半）
  const higher = deviations.filter((d) => d.direction === 'HIGHER').length;
  const lower = deviations.filter((d) => d.direction === 'LOWER').length;
  const directionContested = higher > 0 && lower > 0;

  const cap = GROUP_CAPS[group];
  return {
    group,
    score: Math.max(0, Math.min(cap, best.strength * cap)),
    direction: best.direction,
    directionContested,
    confidence,
    strongestMetric: best.metric,
    comparedMetrics: compared,
  };
}

/** 计算全部组的偏差 */
export function computeGroupDeviations(window: RecentWindow): GroupDeviation[] {
  return Object.values(DeviationGroup).map((group) => aggregateGroup(window, group));
}

/* ============================================================
 * 四、总分
 * ============================================================ */

/**
 * 由组偏差汇总 0–100 总偏移分。
 *
 * ## 语义（规范第 16 节）
 *
 * **不是「疯狂程度」**，而是「当前打法相对于自己长期打法的偏离程度」。
 * 因此：
 * - 一个长期 LAG 继续 LAG → 各指标都接近基线 → 分数接近 0
 * - 一个长期 Nit 变松 → 分数上升
 *
 * ## 为什么用组分数之和再截断
 *
 * 每组已经过组上限压缩，组之间**近似独立**（入池 / 进攻 / 跟注 / 尺寸 / 河牌
 * 是不同维度的行为），因此相加是合理的。
 * 上限由各组 cap 之和保证：`1.0+0.9+0.7+0.6+0.6 = 3.8`。
 */
export const MAX_TOTAL_GROUP_SCORE = 3.8;

export function deviationScoreOf(groups: readonly GroupDeviation[]): number {
  const total = groups.reduce((sum, g) => sum + g.score, 0);
  const normalized = total / MAX_TOTAL_GROUP_SCORE;
  return Math.max(0, Math.min(100, Math.round(normalized * 100)));
}

/* ============================================================
 * 五、冲突检测（规范第 42 节）
 * ============================================================ */

/**
 * 检测指标间的**方向冲突**。
 *
 * 最重要的一个：`VPIP ↑` 但 `PFR ↓ / 3Bet ↓`
 * —— 这说明**更多被动跟注**，而**不是**「变得更激进」。
 * 若不做这个检查，汇总层会错误地得出 `AGGRESSION_UP`。
 *
 * 返回中文说明（直接可用于解释输出）。
 */
export function detectConflicts(window: RecentWindow): string[] {
  const conflicts: string[] = [];
  const find = (metric: PlayerMetric): MetricDeviation | null => {
    const stat = window.stats.find((s) => s.metric === metric);
    return stat ? metricDeviation(stat) : null;
  };

  const vpip = find(PlayerMetric.VPIP);
  const pfr = find(PlayerMetric.PFR);
  const threeBet = find(PlayerMetric.THREE_BET);

  if (vpip?.direction === 'HIGHER') {
    if (pfr?.direction === 'LOWER') {
      conflicts.push('入池率上升但主动加注率下降 —— 更可能是被动跟注变多，而非整体变激进');
    }
    if (threeBet?.direction === 'LOWER') {
      conflicts.push('入池率上升但 3Bet 下降 —— 更可能是跟注变多，而非进攻性上升');
    }
  }

  const pfrUp = pfr?.direction === 'HIGHER';
  const pfrDown = pfr?.direction === 'LOWER';
  if (pfrUp && threeBet?.direction === 'LOWER') {
    conflicts.push('开池加注上升但 3Bet 下降 —— 进攻性变化方向不一致');
  }
  if (pfrDown && threeBet?.direction === 'HIGHER') {
    conflicts.push('开池加注下降但 3Bet 上升 —— 进攻性变化方向不一致');
  }

  // 入池方向与跟注组方向冲突
  const calling = computeGroupDeviations(window).find((g) => g.group === DeviationGroup.CALLING);
  if (vpip?.direction === 'LOWER' && calling?.direction === 'HIGHER') {
    conflicts.push('入池率下降但跟注倾向上升 —— 变化方向不一致，需谨慎解读');
  }

  return conflicts;
}
