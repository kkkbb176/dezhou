/**
 * 范围校验器（规范第三十九 / 四十节）
 *
 * 设计原则与牌局检查器一致：**收集式校验**，一次返回全部问题，
 * 而不是遇到第一个就停 —— 便于一次性定位所有坏数据。
 *
 * 硬约束：**归一化不能掩盖错误**。
 * 发现负权重、NaN、Infinity 必须报错，禁止静默 Math.max(0, w) 之后继续。
 */

import { EPSILON, type Range, type RangeEntry } from './range.types.ts';
import { RangeSource } from './range.types.ts';
import { ALL_COMBOS, COMBO_BY_ID } from './combo.ts';
import { validateRawWeights, validateUnitInterval } from './rangeNormalize.ts';
import { confidenceCapFor, validateProvenance } from './rangeProvenance.ts';
import type { DeadCardSet } from './rangeBlockers.ts';
import { isBlocked } from './rangeBlockers.ts';

export const RangeViolationCode = {
  DUPLICATE_CANONICAL_ID: 'DUPLICATE_CANONICAL_ID',
  UNKNOWN_COMBO: 'UNKNOWN_COMBO',
  INVALID_COMBO: 'INVALID_COMBO',
  DEAD_CARD_COLLISION: 'DEAD_CARD_COLLISION',
  NOT_FINITE: 'NOT_FINITE',
  NEGATIVE_WEIGHT: 'NEGATIVE_WEIGHT',
  PROBABILITY_OUT_OF_RANGE: 'PROBABILITY_OUT_OF_RANGE',
  CONFIDENCE_OUT_OF_RANGE: 'CONFIDENCE_OUT_OF_RANGE',
  CONFIDENCE_EXCEEDS_SOURCE_CAP: 'CONFIDENCE_EXCEEDS_SOURCE_CAP',
  EMPTY_RANGE: 'EMPTY_RANGE',
  NORMALIZATION_ERROR: 'NORMALIZATION_ERROR',
  INVALID_PROVENANCE: 'INVALID_PROVENANCE',
  COLLAPSED_RANGE: 'COLLAPSED_RANGE',
} as const;
export type RangeViolationCode = (typeof RangeViolationCode)[keyof typeof RangeViolationCode];

export type RangeViolation = {
  code: RangeViolationCode;
  /** 可渲染的中文参数 */
  params: Readonly<Record<string, string | number>>;
};

export type RangeValidationResult = {
  valid: boolean;
  violations: RangeViolation[];
  violationCodes: RangeViolationCode[];
};

export type ValidateRangeOptions = {
  /** 死牌集合；提供时会检查「范围内不得含死牌组合」 */
  deadCards?: DeadCardSet;
  /** 允许未经归一化（中间态）。默认 false。 */
  allowUnnormalized?: boolean;
  /** 允许空范围。默认 false。 */
  allowEmpty?: boolean;
  /** 概率总和的容差 */
  epsilon?: number;
};

/**
 * 完整校验一个范围。
 */
export function validateRange(
  range: Range,
  options: ValidateRangeOptions = {},
): RangeValidationResult {
  const violations: RangeViolation[] = [];
  const epsilon = options.epsilon ?? EPSILON;

  // ---- 来源元数据 ----
  for (const issue of validateProvenance(range.provenance)) {
    violations.push({
      code: RangeViolationCode.INVALID_PROVENANCE,
      params: { field: issue.field, problem: issue.problem },
    });
  }

  // ---- 空范围 ----
  if (range.entries.length === 0) {
    if (!options.allowEmpty) {
      violations.push({ code: RangeViolationCode.EMPTY_RANGE, params: { rangeId: range.rangeId } });
    }
    return finish(violations);
  }

  // ---- 逐条校验 ----
  const seenIds = new Set<string>();
  const weightItems: Array<{ comboId: string; rawWeight: number }> = [];
  let probabilitySum = 0;
  let supportSize = 0;

  for (const entry of range.entries) {
    const comboId = entry.combo.canonicalId;

    // 重复 canonicalId
    if (seenIds.has(comboId)) {
      violations.push({ code: RangeViolationCode.DUPLICATE_CANONICAL_ID, params: { comboId } });
    }
    seenIds.add(comboId);

    // 组合是否存在于 1326 宇宙，且是否为 canonical 形式
    const canonical = COMBO_BY_ID.get(comboId);
    if (!canonical) {
      violations.push({ code: RangeViolationCode.UNKNOWN_COMBO, params: { comboId } });
    } else if (canonical.canonicalId !== comboId) {
      violations.push({
        code: RangeViolationCode.INVALID_COMBO,
        params: { comboId, expected: canonical.canonicalId },
      });
    }

    // 死牌冲突
    if (options.deadCards && isBlocked(entry.combo, options.deadCards)) {
      violations.push({
        code: RangeViolationCode.DEAD_CARD_COLLISION,
        params: { comboId, rankClass: entry.combo.rankClass },
      });
    }

    // 权重与概率
    weightItems.push({ comboId, rawWeight: entry.rawWeight });
    const probabilityProblem = validateUnitInterval(entry.probability, 'probability');
    if (probabilityProblem) {
      violations.push({
        code: RangeViolationCode.PROBABILITY_OUT_OF_RANGE,
        params: { comboId, problem: probabilityProblem },
      });
    } else {
      probabilitySum += entry.probability;
      if (entry.probability > 0) supportSize++;
    }

    // 可信度
    const confidenceProblem = validateUnitInterval(entry.confidence, 'confidence');
    if (confidenceProblem) {
      violations.push({
        code: RangeViolationCode.CONFIDENCE_OUT_OF_RANGE,
        params: { comboId, problem: confidenceProblem },
      });
    } else {
      const cap = confidenceCapFor(entry.source);
      if (entry.confidence > cap + epsilon) {
        violations.push({
          code: RangeViolationCode.CONFIDENCE_EXCEEDS_SOURCE_CAP,
          params: { comboId, source: entry.source, cap, confidence: entry.confidence },
        });
      }
    }
  }

  // ---- 权重问题（NaN / Infinity / 负值）----
  for (const issue of validateRawWeights(weightItems)) {
    violations.push({
      code: issue.problem.includes('负')
        ? RangeViolationCode.NEGATIVE_WEIGHT
        : RangeViolationCode.NOT_FINITE,
      params: { comboId: issue.comboId, problem: issue.problem, value: issue.value },
    });
  }

  // ---- 归一化 ----
  if (!options.allowUnnormalized && Math.abs(probabilitySum - 1) > epsilon) {
    violations.push({
      code: RangeViolationCode.NORMALIZATION_ERROR,
      params: { probabilitySum, deviation: probabilitySum - 1 },
    });
  }

  // ---- 坍塌 ----
  if (supportSize === 0) {
    violations.push({
      code: RangeViolationCode.COLLAPSED_RANGE,
      params: { totalEntries: range.entries.length },
    });
  }

  // ---- 度量自洽（防止 metrics 与 entries 不一致）----
  if (Math.abs(range.metrics.probabilitySum - probabilitySum) > epsilon) {
    violations.push({
      code: RangeViolationCode.NORMALIZATION_ERROR,
      params: {
        note: 'metrics.probabilitySum 与 entries 实际之和不一致',
        metricsSum: range.metrics.probabilitySum,
        actualSum: probabilitySum,
      },
    });
  }
  if (range.metrics.supportSize !== supportSize) {
    violations.push({
      code: RangeViolationCode.COLLAPSED_RANGE,
      params: {
        note: 'metrics.supportSize 与 entries 实际有效数不一致',
        metricsSupport: range.metrics.supportSize,
        actualSupport: supportSize,
      },
    });
  }

  return finish(violations);
}

function finish(violations: RangeViolation[]): RangeValidationResult {
  return {
    valid: violations.length === 0,
    violations,
    violationCodes: violations.map((v) => v.code),
  };
}

/* ============================================================
 * 便捷断言
 * ============================================================ */

export function assertValidRange(range: Range, options: ValidateRangeOptions = {}): void {
  const result = validateRange(range, options);
  if (!result.valid) {
    throw new Error(
      `assertValidRange: 范围「${range.rangeId}」校验失败：` +
        result.violations.map((v) => `${v.code}(${JSON.stringify(v.params)})`).join('；'),
    );
  }
}

/** 校验单个条目（供增量更新后的抽查） */
export function validateEntry(entry: RangeEntry): RangeViolation[] {
  const violations: RangeViolation[] = [];
  const probabilityProblem = validateUnitInterval(entry.probability, 'probability');
  if (probabilityProblem) {
    violations.push({
      code: RangeViolationCode.PROBABILITY_OUT_OF_RANGE,
      params: { comboId: entry.combo.canonicalId, problem: probabilityProblem },
    });
  }
  if (!Number.isFinite(entry.rawWeight) || entry.rawWeight < 0) {
    violations.push({
      code: RangeViolationCode.NEGATIVE_WEIGHT,
      params: { comboId: entry.combo.canonicalId, rawWeight: entry.rawWeight },
    });
  }
  return violations;
}

/** 全部组合宇宙的合法性自检（供测试与启动时断言） */
export function assertComboUniverseIntegrity(): void {
  if (ALL_COMBOS.length !== 1326) {
    throw new Error(`组合宇宙数量错误：期望 1326，实际 ${ALL_COMBOS.length}`);
  }
  const ids = new Set(ALL_COMBOS.map((c) => c.canonicalId));
  if (ids.size !== ALL_COMBOS.length) {
    throw new Error(`组合宇宙存在重复 canonicalId：${ALL_COMBOS.length - ids.size} 个`);
  }
}

export { RangeSource };
