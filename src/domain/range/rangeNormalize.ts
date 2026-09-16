/**
 * 归一化与度量（规范第九 / 二十九 / 三十节）
 *
 * 两条硬约束：
 * 1. **归一化不能掩盖错误**（规范第四十节）：发现负权重、NaN、Infinity 必须**报错**，
 *    禁止 `Math.max(0, weight)` 之后继续 —— 那会让系统「静默修好」真实的输入错误。
 * 2. **rawWeight 与 probability 分离**（规范第七 / 八节）：
 *    归一化只写 probability 字段，**绝不覆盖 rawWeight**。
 */

import { EPSILON } from './range.types.ts';
import { rangeFailure, RangeErrorCode, type RangeOutcome } from './range.types.ts';
import type { ExactCombo } from './combo.ts';
import { stableNormalize } from './rangeLogSpace.ts';

/* ============================================================
 * 权重校验
 * ============================================================ */

export type WeightIssue = {
  comboId: string;
  problem: string;
  value: number;
};

/**
 * 校验一批原始权重。
 *
 * 刻意返回**全部**问题而不是遇到第一个就停 —— 便于一次定位所有坏数据。
 */
export function validateRawWeights(
  items: ReadonlyArray<{ comboId: string; rawWeight: number }>,
): WeightIssue[] {
  const issues: WeightIssue[] = [];
  for (const item of items) {
    const w = item.rawWeight;
    if (!Number.isFinite(w)) {
      issues.push({
        comboId: item.comboId,
        problem: Number.isNaN(w) ? 'rawWeight 是 NaN' : 'rawWeight 不是有限数',
        value: w,
      });
      continue;
    }
    if (w < 0) {
      issues.push({ comboId: item.comboId, problem: 'rawWeight 为负', value: w });
    }
  }
  return issues;
}

/* ============================================================
 * 归一化
 * ============================================================ */

export type NormalizeResult = {
  /** 与输入等长、同序的概率数组 */
  probabilities: number[];
  /** Σ rawWeight */
  weightSum: number;
  /** 实际写出的 Σ probability（应为 1） */
  probabilitySum: number;
};

/**
 * 把 rawWeight 归一化成 probability。
 *
 * **已改为委托给 `stableNormalize`（max-shift）**，修复 Step 5A.1 发现的 P1 缺陷：
 * 旧版用**绝对阈值** `EPSILON = 1e-9` 判断坍塌，于是
 * 「所有似然都是 1e-12」这种完全合法的输入被判成 `RANGE_COLLAPSE`
 * （Σ ≈ 2e-14 < 1e-9），同时破坏尺度不变性 ——
 * 把所有权重整体乘 1e-6（语义不变）会让结果从「正常」变成「坍塌」。
 *
 * 现在只按**相对形状**判定：只要存在正权重就有合法分布，
 * 哪怕它的绝对值小到 1e-300。
 *
 * 失败情形（都会显式报错，绝不静默修复）：
 * - 存在负权重 / NaN / Infinity → `RANGE_VALIDATION_FAILED`
 * - 最大权重 ≤ 0（全部为 0）→ `RANGE_COLLAPSE`
 * - 空输入 → `RANGE_COLLAPSE`
 */
export function normalizeWeights(
  items: ReadonlyArray<{ comboId: string; rawWeight: number }>,
): RangeOutcome<NormalizeResult> {
  const stable = stableNormalize(items);
  if (!stable.ok) return stable;
  return {
    ok: true,
    value: {
      probabilities: stable.value.probabilities,
      weightSum: stable.value.rawWeightSum,
      probabilitySum: stable.value.probabilitySum,
    },
  };
}

/* ============================================================
 * 度量（规范第二十八 / 二十九 / 三十节）
 * ============================================================ */

export type ProbabilityMetrics = {
  /** 有效组合数（probability > 0） */
  supportSize: number;
  /** 参与度量的条目总数 */
  totalEntries: number;
  /** 有效组合数：1 / Σ(p²) */
  effectiveComboCount: number;
  /** 香农熵（bit） */
  entropyBits: number;
  /** 归一化熵（0..1） */
  normalizedEntropy: number;
  /** Σp */
  probabilitySum: number;
  /** 最大概率 */
  topProbability: number;
};

/**
 * 计算概率分布的集中程度。
 *
 * 为什么不能只看「组合数量」（规范第二十九节）：
 * 100 个组合可能权重高度集中（实际只有 2~3 个组合有实质概率），
 * 也可能完全平均。熵与有效组合数才能区分这两种情况。
 *
 * ⚠️ **本函数是纯数学函数，不做输入校验**：
 * 遇到 NaN / 负数概率时**跳过**它们（不计入 sum / support / entropy），
 * 因此它**不足以**证明一个范围合法。
 * 范围级别的严格校验由 `rangeValidator.validateRange` 负责 ——
 * 那条路径会把这些值显式报成 `NOT_FINITE` / `NEGATIVE_WEIGHT` /
 * `PROBABILITY_OUT_OF_RANGE`。
 * 两层职责刻意分开：本函数追求「永不产生 NaN」，校验器追求「永不放过坏数据」。
 */
export function probabilityMetrics(probabilities: readonly number[]): ProbabilityMetrics {
  const total = probabilities.length;
  if (total === 0) {
    return {
      supportSize: 0,
      totalEntries: 0,
      effectiveComboCount: 0,
      entropyBits: 0,
      normalizedEntropy: 0,
      probabilitySum: 0,
      topProbability: 0,
    };
  }

  let sum = 0;
  let sumSquares = 0;
  let entropy = 0;
  let support = 0;
  let top = 0;

  for (const p of probabilities) {
    if (!Number.isFinite(p) || p < 0) continue;
    if (p > 0) {
      support++;
      entropy -= p * Math.log2(p);
    }
    sum += p;
    sumSquares += p * p;
    if (p > top) top = p;
  }

  return {
    supportSize: support,
    totalEntries: total,
    effectiveComboCount: sumSquares > 0 ? 1 / sumSquares : 0,
    entropyBits: entropy,
    // 最大熵 = log2(supportSize)；supportSize ≤ 1 时约定为 1（分布退化为单点）
    normalizedEntropy: support > 1 ? entropy / Math.log2(support) : support === 1 ? 1 : 0,
    probabilitySum: sum,
    topProbability: top,
  };
}

/** 概率总和是否已归一化（统一 epsilon） */
export function isNormalized(probabilitySum: number, epsilon = EPSILON): boolean {
  return Math.abs(probabilitySum - 1) <= epsilon;
}

/* ============================================================
 * 概率/权重区间校验
 * ============================================================ */

export function validateProbability(value: number, label: string): string | null {
  if (!Number.isFinite(value)) return `${label} 不是有限数（${value}）`;
  if (value < 0) return `${label} 为负（${value}）`;
  if (value > 1 + EPSILON) return `${label} 超过 1（${value}）`;
  return null;
}

export function validateUnitInterval(value: number, label: string): string | null {
  if (!Number.isFinite(value)) return `${label} 不是有限数（${value}）`;
  if (value < 0) return `${label} 为负（${value}）`;
  if (value > 1) return `${label} 超过 1（${value}）`;
  return null;
}

/** 供范围条目使用的便捷包装 */
export type { ExactCombo };
