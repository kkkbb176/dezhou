/**
 * 数值稳定性：Log-Sum-Exp 与稳定归一化（Step 5A.1）
 *
 * ## 为什么需要这个模块
 *
 * 范围引擎的更新是**连乘**：
 *   posterior ∝ prior × actionLikelihood × playerAdjustment × dynamicAdjustment
 *
 * 直接连乘有两个致命问题：
 * 1. **下溢**：合法的极小似然（例如 1e-12、1e-300）会让乘积变成精确的 0，
 *    组合被静默剔除。
 * 2. **溢出**：连续放大可能变成 Infinity。
 *
 * 规范第七节要求：多次连续乘法必须优先在**对数域**做（加法），
 * 归一化使用 **Log-Sum-Exp**，不得直接连乘到溢出/下溢。
 *
 * ## 本项目实际踩到的坑（P1）
 *
 * 旧版 `normalizeWeights` 用**绝对阈值** `EPSILON = 1e-9` 判断「总和是否为 0」：
 * ```
 * if (weightSum <= EPSILON) return RANGE_COLLAPSE
 * ```
 * 于是「所有似然都是 1e-12」这种**完全合法**的输入被判成范围坍塌 ——
 * 因为 Σ(1/46 × 1e-12) ≈ 2e-14 < 1e-9。
 * 这个错误同时破坏了**尺度不变性**：
 * 把所有权重整体乘以 1e-6（语义完全不变）会让结果从「正常」变成「坍塌」。
 *
 * 正确做法是 **max-shift**：先把所有权重除以最大值，再判断有效值个数。
 * 这样「尺度」被彻底消除，只剩「相对形状」——这正是概率分布的定义。
 *
 * ## 三个层次的分工
 *
 * | 函数 | 输入 | 用途 |
 * |---|---|---|
 * | `stableNormalize` | 线性域权重 | 一次性的权重→概率（内部做 max-shift） |
 * | `normalizeLogWeights` | 对数域权重 | 连乘链的归一化（Log-Sum-Exp） |
 * | `effectiveLogWeight` | 单值 | 判断「这个权重是否还有实质概率」 |
 */

import { EPSILON } from './range.types.ts';
import { rangeFailure, RangeErrorCode, type RangeOutcome } from './range.types.ts';

/** 对数域中的「零」（log(0) = −∞） */
export const LOG_ZERO = Number.NEGATIVE_INFINITY;

/** 对数域中的「无效」（NaN 用 −∞ 表达更安全，但我们要显式区分） */
export function isLogWeightValid(logWeight: number): boolean {
  return !Number.isNaN(logWeight) && logWeight !== Number.POSITIVE_INFINITY;
}

/* ============================================================
 * Log-Sum-Exp
 * ============================================================ */

/**
 * Log-Sum-Exp：log(Σ exp(xᵢ))，用 max-shift 保证数值稳定。
 *
 * 全部为 −∞ 时返回 −∞（表示「没有任何有效项」），而不是 NaN。
 */
export function logSumExp(values: readonly number[]): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (Number.isNaN(value)) return Number.NaN;
    if (value > max) max = value;
  }
  if (max === Number.NEGATIVE_INFINITY) return LOG_ZERO;

  // 只要有一个 +∞，结果就是 +∞
  if (max === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;

  let sum = 0;
  for (const value of values) {
    sum += Math.exp(value - max);
  }
  // sum ∈ [1, n]，因此 log 永远有定义
  return max + Math.log(sum);
}

/* ============================================================
 * 稳定归一化（线性域权重）
 * ============================================================ */

export type StableNormalizeResult = {
  probabilities: number[];
  /** 有效项数（max-shift 后 > 0 的项） */
  supportSize: number;
  /** 原始权重总和（可能下溢为 0，仅作诊断用） */
  rawWeightSum: number;
  /** 归一化后总和（应≈1） */
  probabilitySum: number;
  /** 使用的 max-shift 参考值（诊断用） */
  shift: number;
};

/**
 * 把线性域权重稳定地归一化为概率。
 *
 * 关键点：**先把所有权重除以最大值**，再做求和与判定。
 * 这样「整体尺度」被消除，只剩相对形状：
 * `[1, 1, 0.5]` 与 `[1e-300, 1e-300, 5e-301]` 得到**完全相同**的概率。
 *
 * 失败情形（显式报错，绝不静默修复）：
 * - 空输入 → `RANGE_COLLAPSE`
 * - 存在负权重 / NaN / Infinity → `RANGE_VALIDATION_FAILED`
 * - 最大值 ≤ 0（全部为 0）→ `RANGE_COLLAPSE`
 *
 * 注意：**不再用绝对阈值判断坍塌**。只要存在正权重，就一定有合法分布 ——
 * 哪怕它的绝对值小到 1e-300。
 */
export function stableNormalize(
  items: ReadonlyArray<{ comboId: string; rawWeight: number }>,
): RangeOutcome<StableNormalizeResult> {
  if (items.length === 0) {
    return rangeFailure(RangeErrorCode.RANGE_COLLAPSE, { reason: '组合数为 0' });
  }

  // ---- 1. 校验：负值 / NaN / Infinity 一律拒绝 ----
  let max = Number.NEGATIVE_INFINITY;
  let rawWeightSum = 0;
  for (const item of items) {
    const w = item.rawWeight;
    if (!Number.isFinite(w)) {
      return rangeFailure(RangeErrorCode.RANGE_VALIDATION_FAILED, {
        comboId: item.comboId,
        problem: Number.isNaN(w) ? 'rawWeight 是 NaN' : `rawWeight 不是有限数（${w}）`,
        value: w,
      });
    }
    if (w < 0) {
      return rangeFailure(RangeErrorCode.RANGE_VALIDATION_FAILED, {
        comboId: item.comboId,
        problem: 'rawWeight 为负',
        value: w,
      });
    }
    rawWeightSum += w;
    if (w > max) max = w;
  }

  // ---- 2. 全零 → 真正的坍塌（相对意义上无任何有效项） ----
  if (!(max > 0)) {
    return rangeFailure(RangeErrorCode.RANGE_COLLAPSE, {
      weightSum: rawWeightSum,
      maxWeight: max,
      itemCount: items.length,
      reason: '所有组合的权重都为 0',
    });
  }

  // ---- 3. max-shift 后求和与归一化 ----
  const shift = max;
  const scaledSum = new Array<number>(items.length);
  let total = 0;
  let supportSize = 0;
  for (let i = 0; i < items.length; i++) {
    const scaled = items[i]!.rawWeight / shift;
    scaledSum[i] = scaled;
    total += scaled;
    if (scaled > 0) supportSize++;
  }

  // total ∈ [1, n]，绝不可能是 0 —— 除非 n = 0（已在前面拦截）
  if (!(total > 0) || !Number.isFinite(total)) {
    return rangeFailure(RangeErrorCode.RANGE_NORMALIZE_FAILED, {
      reason: 'max-shift 后总和异常',
      total: String(total),
      shift: String(shift),
    });
  }

  const probabilities = new Array<number>(items.length);
  let probabilitySum = 0;
  for (let i = 0; i < items.length; i++) {
    const p = scaledSum[i]! / total;
    probabilities[i] = p;
    probabilitySum += p;
  }

  return {
    ok: true,
    value: { probabilities, supportSize, rawWeightSum, probabilitySum, shift },
  };
}

/* ============================================================
 * 对数域归一化（连乘链）
 * ============================================================ */

export type LogNormalizeResult = {
  probabilities: number[];
  supportSize: number;
  /** logSumExp(logWeights) */
  logTotal: number;
  probabilitySum: number;
};

/**
 * 对数域权重 → 概率（Log-Sum-Exp）。
 *
 * 输入是 log(w)，因此「连乘」变成了「相加」：
 *   logPosterior = logPrior + logLikelihood + logAdjustment
 *
 * 全部为 −∞ 时 → `RANGE_COLLAPSE`（对应用户语义上的「全部权重为 0」）。
 *
 * @param logWeights 对数权重数组；`-Infinity` 表示该项为 0
 */
export function normalizeLogWeights(
  items: ReadonlyArray<{ comboId: string; logWeight: number }>,
): RangeOutcome<LogNormalizeResult> {
  if (items.length === 0) {
    return rangeFailure(RangeErrorCode.RANGE_COLLAPSE, { reason: '组合数为 0' });
  }

  const logs = new Array<number>(items.length);
  for (let i = 0; i < items.length; i++) {
    const value = items[i]!.logWeight;
    if (Number.isNaN(value)) {
      return rangeFailure(RangeErrorCode.RANGE_VALIDATION_FAILED, {
        comboId: items[i]!.comboId,
        problem: 'logWeight 是 NaN',
        value: 'NaN',
      });
    }
    if (value === Number.POSITIVE_INFINITY) {
      return rangeFailure(RangeErrorCode.RANGE_VALIDATION_FAILED, {
        comboId: items[i]!.comboId,
        problem: 'logWeight 是 +Infinity（权重大于 1）',
        value: 'Infinity',
      });
    }
    logs[i] = value;
  }

  const logTotal = logSumExp(logs);
  if (logTotal === LOG_ZERO) {
    return rangeFailure(RangeErrorCode.RANGE_COLLAPSE, {
      reason: '所有组合的对数权重都是 -Infinity（语义上权重全为 0）',
      itemCount: items.length,
    });
  }
  if (!Number.isFinite(logTotal)) {
    return rangeFailure(RangeErrorCode.RANGE_NORMALIZE_FAILED, {
      reason: 'logSumExp 结果不是有限数',
      logTotal: String(logTotal),
    });
  }

  const probabilities = new Array<number>(items.length);
  let probabilitySum = 0;
  let supportSize = 0;
  for (let i = 0; i < items.length; i++) {
    // 稳定的 softmax：exp(log w − logSumExp) ∈ [0, 1]
    const p = Math.exp(logs[i]! - logTotal);
    probabilities[i] = p;
    probabilitySum += p;
    if (p > 0) supportSize++;
  }

  return { ok: true, value: { probabilities, supportSize, logTotal, probabilitySum } };
}

/* ============================================================
 * 对数域工具
 * ============================================================ */

/**
 * 把线性权重转成对数权重。
 *
 * 约定：0 或**任何非正数** → `-Infinity`（对数域的 0）。
 * 这样后续的加法链不会因为 log(0) = −Infinity 而产生 NaN。
 */
export function toLogWeight(weight: number): number {
  if (!(weight > 0) || !Number.isFinite(weight)) {
    return weight === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : LOG_ZERO;
  }
  return Math.log(weight);
}

/** 对数域权重 → 线性域（可能下溢为 0，这是预期的） */
export function fromLogWeight(logWeight: number): number {
  if (logWeight === LOG_ZERO) return 0;
  return Math.exp(logWeight);
}

/**
 * 对数域的「连乘」：把一组对数权重相加。
 *
 * 这是本模块存在的核心理由 ——
 * `log(a) + log(b)` 永不溢出/下溢，而 `a × b` 会。
 */
export function multiplyLogWeights(...logWeights: readonly number[]): number {
  let sum = 0;
  for (const value of logWeights) {
    if (value === LOG_ZERO) return LOG_ZERO; // 0 × 任何东西 = 0
  }
  for (const value of logWeights) {
    if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
    sum += value;
  }
  return sum;
}

/**
 * 判断一个概率是否「在数值上已经消失」。
 *
 * 用途：报告支持集收缩时区分「真实的 0」与「浮点下溢的 0」。
 * 阈值刻意取 `Number.MIN_VALUE` 量级而不是 EPSILON ——
 * 只有真正低于双精度可表示范围才算「数值消失」。
 */
export function isNumericallyZero(probability: number): boolean {
  return probability === 0;
}

/** 双精度下溢边界（约 5e-324）；低于此值的真实概率无法表示 */
export const DENORMAL_MIN = Number.MIN_VALUE;

/** 概率分布是否仍然归一化（统一用 range.types 的 EPSILON） */
export function isStableNormalized(probabilitySum: number): boolean {
  return Math.abs(probabilitySum - 1) <= EPSILON;
}
