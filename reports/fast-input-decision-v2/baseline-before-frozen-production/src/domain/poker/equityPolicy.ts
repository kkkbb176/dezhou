/**
 * 权益计算策略（选型 + 提前停止判定）
 *
 * 本文件是**纯决策逻辑**：不依赖任何牌局状态、不跑模拟、不做枚举。
 * 因此它可以被独立测试，也保证「选型规则」不会和「计算方法」纠缠在一起。
 *
 * 三重收益递减检查（规范第 12~14 节）：
 * 1. **决策门槛（最强）**：95% 置信区间完全落在门槛同一侧 → 结论不可能被推翻，立即停止。
 * 2. **收益递减（确定性，不需要概率论）**：把样本翻倍后标准误最多缩小到 1/√2，
 *    因此权益估计最多还能移动 `1.96 × SE × (1 − 1/√2) ≈ 0.574 × 1.96 × SE`。
 *    若这个最大可能移动量小于阈值，继续算下去不可能改变任何结论。
 * 3. **时间预算**：只剩不到下一轮的成本 → 立即停止。
 *
 * 这正是规范第 12 条要求的「不追求无意义精度」的可执行形式：
 * 权益 44.2% ±0.7% 对门槛 27%，整个 CI 都在门槛之上，没有任何理由去算 44.186322%。
 */

import {
  EquityComputeMode,
  EquityPolicyReason,
  EquityStopReason,
  combinationsCount,
  resolveMaxExactMatchups,
  resolveMaxIterations,
  type CapacityReport,
  type EquityMethod,
  type EquityOptions,
  type EquityStopReason as StopReason,
} from './equity.types.ts';
import { DeadlineMode, DecisionDeadline, type Clock } from '../../app/decisionDeadline.ts';

/* ============================================================
 * 选型
 * ============================================================ */

export type CapacityInput = {
  /** 每位对手「扣除已知牌后」的有效组合数 */
  combosPerOpponent: readonly number[];
  /** 已知牌张数（我的底牌 + 公共牌） */
  knownCardCount: number;
  /** 公共牌张数（0 / 3 / 4 / 5） */
  boardCount: number;
};

/**
 * 计算容量并选出算法。
 *
 * 越界原因：**调用方必须在进入这里之前完成输入校验**（底牌 2 张、公共牌 0/3/4/5 张等）。
 */
export function buildCapacity(
  input: CapacityInput,
  options: EquityOptions = {},
): CapacityReport {
  const { combosPerOpponent, knownCardCount, boardCount } = input;
  const remainingDeckSize = 52 - knownCardCount;
  const cardsToCome = 5 - boardCount;

  let bound = 1;
  for (const count of combosPerOpponent) bound *= count;
  bound *= combinationsCount(remainingDeckSize, cardsToCome);

  const maxExact = resolveMaxExactMatchups(options);
  const mode: EquityComputeMode = options.mode ?? EquityComputeMode.FAST;
  const maxIterations = options.maxIterations ?? resolveMaxIterations(mode);

  let method: EquityMethod;
  let methodReason: EquityPolicyReason;

  if (options.forceMethod) {
    method = options.forceMethod;
    methodReason = EquityPolicyReason.FORCED_BY_CALLER;
  } else if (mode === EquityComputeMode.VERIFY) {
    method = 'EXACT';
    methodReason = EquityPolicyReason.VERIFY_MODE;
  } else if (bound <= maxExact) {
    method = 'EXACT';
    methodReason = EquityPolicyReason.EXACT_WITHIN_BUDGET;
  } else {
    method = 'MONTE_CARLO';
    methodReason = EquityPolicyReason.TOO_MANY_MATCHUPS;
  }

  return {
    combosPerOpponent: [...combosPerOpponent],
    remainingDeckSize,
    cardsToCome,
    exactMatchupsBound: bound,
    maxIterations,
    method,
    methodReason,
  };
}

/**
 * 精确枚举是否**确定安全**：即使按最坏估计也不会超时。
 *
 * 保守估计：每次对局评估约 1.1 微秒（实测约 0.75 微秒，留约 50% 余量）。
 * 如果上界 × 单次成本超过剩余预算，就不该走精确枚举。
 */
export const NANOSECONDS_PER_MATCHUP = 1_100;

export function exactEnumerationFitsDeadline(
  matchupsBound: number,
  deadline: DecisionDeadline | undefined,
): boolean {
  if (!deadline) return true;
  const estimatedCostMs = (matchupsBound * NANOSECONDS_PER_MATCHUP) / 1_000_000;
  return deadline.remainingMs() >= estimatedCostMs;
}

/**
 * 选型时的最后一道闸门：
 * 即使容量判断说「可以精确枚举」，只要**时间不够**就降级为蒙特卡洛，
 * 并记录降级原因（规范第 59 条：不允许静默 Fallback）。
 */
export function applyDeadlineToMethod(
  capacity: CapacityReport,
  deadline: DecisionDeadline | undefined,
): CapacityReport {
  if (capacity.method !== 'EXACT' || !deadline) return capacity;
  if (exactEnumerationFitsDeadline(capacity.exactMatchupsBound, deadline)) return capacity;
  return { ...capacity, method: 'MONTE_CARLO', methodReason: EquityPolicyReason.DOWNGRADED_BY_DEADLINE };
}

/* ============================================================
 * 提前停止判定
 * ============================================================ */

export type StopEvaluation = {
  shouldStop: boolean;
  reason: StopReason | null;
  /** 供日志与界面展示：为什么停（中文可渲染参数） */
  params: Readonly<Record<string, string | number>>;
};

const CONTINUE: StopEvaluation = { shouldStop: false, reason: null, params: {} };

function zScore(confidence: number): number {
  // 仅支持常用置信度；其余按正态近似
  if (Math.abs(confidence - 0.99) < 1e-9) return 2.5758293035489004;
  if (Math.abs(confidence - 0.95) < 1e-9) return 1.959963984540054;
  if (Math.abs(confidence - 0.9) < 1e-9) return 1.6448536269514722;
  return 1.959963984540054;
}

export const DEFAULT_CONFIDENCE = 0.95;

/** 95% 置信区间半宽 = z × √(p(1−p)/n) */
export function confidenceHalfWidth(equity: number, total: number, confidence = DEFAULT_CONFIDENCE): number {
  if (total <= 0) return Number.POSITIVE_INFINITY;
  const variance = Math.max(0, equity * (1 - equity));
  return zScore(confidence) * Math.sqrt(variance / total);
}

export type StopCheckInput = {
  equity: number;
  /** 已完成的模拟次数 */
  total: number;
  /** 下一阶段的样本上限 */
  nextIterations: number;
  /** 决策门槛；未提供时跳过门槛检查 */
  decisionThreshold?: number;
  /** 收益递减阈值（百分点） */
  diminishingReturnsThreshold: number;
  deadline?: DecisionDeadline;
  /** 预计下一阶段的耗时（毫秒）；用于时间预算检查 */
  estimatedNextRoundMs?: number;
  confidence?: number;
};

/**
 * 判定蒙特卡洛是否应该提前停止。
 *
 * 检查顺序刻意从「最强、最便宜」到「最弱、最贵」：
 * 门槛检查 → 时间检查 → 收益递减检查。
 */
export function evaluateMonteCarloStop(input: StopCheckInput): StopEvaluation {
  const confidence = input.confidence ?? DEFAULT_CONFIDENCE;

  // ---- 1) 决策门槛：CI 完全落在同一侧 ----
  if (input.decisionThreshold !== undefined && Number.isFinite(input.decisionThreshold)) {
    const half = confidenceHalfWidth(input.equity, input.total, confidence);
    if (Number.isFinite(half) && input.total > 0) {
      const lower = input.equity - half;
      const upper = input.equity + half;
      const threshold = input.decisionThreshold;
      if (lower > threshold) {
        return {
          shouldStop: true,
          reason: EquityStopReason.CI_CLEARS_THRESHOLD,
          params: {
            lower: round4(lower),
            upper: round4(upper),
            threshold: round4(threshold),
            side: 'ABOVE',
          },
        };
      }
      if (upper < threshold) {
        return {
          shouldStop: true,
          reason: EquityStopReason.CI_CLEARS_THRESHOLD,
          params: {
            lower: round4(lower),
            upper: round4(upper),
            threshold: round4(threshold),
            side: 'BELOW',
          },
        };
      }
    }
  }

  // ---- 2) 时间预算 ----
  if (input.deadline) {
    const cost = input.estimatedNextRoundMs ?? 1;
    if (!input.deadline.canStartRound(cost)) {
      return {
        shouldStop: true,
        reason: EquityStopReason.DEADLINE_REACHED,
        params: {
          elapsedMs: Math.round(input.deadline.elapsedMs()),
          remainingMs: Math.round(input.deadline.remainingMs()),
        },
      };
    }
  }

  // ---- 3) 收益递减（确定性上界） ----
  if (input.total > 0 && input.nextIterations > input.total) {
    const half = confidenceHalfWidth(input.equity, input.total, confidence);
    if (Number.isFinite(half)) {
      // 样本从 n 增加到 n'，标准误乘以 √(n/n')；因此半宽最多缩小同样的比例。
      const shrink = Math.sqrt(input.total / input.nextIterations);
      const maxMovement = half * (1 - shrink);
      if (maxMovement * 100 < input.diminishingReturnsThreshold) {
        return {
          shouldStop: true,
          reason: EquityStopReason.DIMINISHING_RETURNS,
          params: {
            maxMovementPct: round4(maxMovement * 100),
            thresholdPct: input.diminishingReturnsThreshold,
          },
        };
      }
    }
  }

  return CONTINUE;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/* ============================================================
 * 默认时间预算
 * ============================================================ */

/**
 * 按计算模式给出默认时间预算。
 *
 * 依赖方向说明：equityPolicy → app/decisionDeadline 是单向的
 * （decisionDeadline 只依赖标准库与自身类型），因此不存在循环依赖。
 */
export function defaultDeadlineForMode(mode: EquityComputeMode, clock?: Clock): DecisionDeadline {
  switch (mode) {
    case EquityComputeMode.PRECISION:
      return new DecisionDeadline({ mode: DeadlineMode.PRECISION, ...(clock ? { clock } : {}) });
    case EquityComputeMode.VERIFY:
      return new DecisionDeadline({ mode: DeadlineMode.VERIFY, ...(clock ? { clock } : {}) });
    default:
      return new DecisionDeadline({ mode: DeadlineMode.INTERACTIVE, ...(clock ? { clock } : {}) });
  }
}
