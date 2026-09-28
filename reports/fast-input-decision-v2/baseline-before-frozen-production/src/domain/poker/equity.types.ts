/**
 * 权益引擎 —— 共享类型与小型工具
 *
 * 本文件只放「被多个权益文件共同需要的东西」：
 * 类型、常量、组合冲突检查、快速路径判定。
 * **不含任何计算逻辑** —— 计算在 equityExact.ts / equityMonteCarlo.ts，
 * 调度在 equityPolicy.ts，公开 API 在 equity.ts。
 *
 * 依赖方向（严格单向，禁止反向）：
 *   equity.types ← equityPolicy ← equityExact / equityMonteCarlo ← equity
 */

import type { Card } from '../types.ts';
import type { IssueCode, IssueSeverity } from '../domainCodes.ts';
import type { DecisionDeadline } from '../../app/decisionDeadline.ts';
import { cardIndex } from './cards.ts';

/* ============================================================
 * 范围
 * ============================================================ */

/** 对手范围：具体手牌组合的集合（组合的生成由范围层负责，本层只负责算） */
export type OpponentRange = {
  /** 用于展示的范围名称 */
  label: string;
  /** 全部组合；每个组合恰好 2 张牌 */
  combos: ReadonlyArray<readonly [Card, Card]>;
};

/* ============================================================
 * 结果
 * ============================================================ */

export type EquityMethod = 'EXACT' | 'MONTE_CARLO';

export type EquityIssue = {
  code: IssueCode;
  severity: IssueSeverity;
  params: Readonly<Record<string, string | number>>;
};

export type EquityResult = {
  /** 我的权益，0..1 */
  equity: number;
  /** 获胜次数（精确枚举为真实次数，蒙特卡洛为抽样次数） */
  wins: number;
  /** 平分次数 */
  ties: number;
  /** 失败次数 */
  losses: number;
  /** 统计总次数（= 胜 + 平 + 负） */
  total: number;
  method: EquityMethod;
  /** 精确枚举：实际对局组合数；蒙特卡洛：实际完成的模拟次数 */
  iterations: number;
  matchups: number;
  /** 蒙特卡洛种子（精确枚举为 null），复盘时用于复现 */
  seed: number | null;
  /** 蒙特卡洛 95% 置信区间半宽（精确枚举为 0） */
  confidenceInterval95: number;
  /** 对手数量（多人底池必须显式携带，禁止套用单挑逻辑） */
  opponentCount: number;
  /** 每位对手的有效组合数 */
  combosPerOpponent: number[];
  /** 实际耗时（毫秒） */
  elapsedMs: number;
  /** 是否因为收益递减 / 时间预算而提前停止 */
  stoppedEarly: boolean;
  /** 提前停止的中文可渲染原因码 */
  stopReason: EquityStopReason | null;
  /** 停止原因的渲染参数（例如 CI 上界、门槛、剩余毫秒） */
  stopParams: Readonly<Record<string, string | number>>;
  /** 被放弃的抽样次数（对手组合互相冲突）—— 诚实记录，不参与统计 */
  abortedRuns: number;
  /** 本次实际采用的算法选型原因 */
  methodReason: EquityPolicyReason;
  /** 若因时间预算从精确枚举降级为蒙特卡洛，此处记录原算法（否则为 null） */
  downgradedFrom: EquityMethod | null;
  issues: EquityIssue[];
};
export const EquityStopReason = {
  /** 95% 置信区间完全落在决策门槛同一侧，继续算没有意义 */
  CI_CLEARS_THRESHOLD: 'CI_CLEARS_THRESHOLD',
  /** 达到本阶段样本上限且时间预算不足 */
  DEADLINE_REACHED: 'DEADLINE_REACHED',
  /** 时间预算尚可，但把样本翻倍也无法改变结论 */
  DIMINISHING_RETURNS: 'DIMINISHING_RETURNS',
  /** 达到调用方指定的最大样本量 */
  MAX_ITERATIONS: 'MAX_ITERATIONS',
} as const;
export type EquityStopReason = (typeof EquityStopReason)[keyof typeof EquityStopReason];

export type EquitySuccess = { ok: true; result: EquityResult };
export type EquityFailure = {
  ok: false;
  code: IssueCode;
  params: Readonly<Record<string, string | number>>;
};
export type EquityOutcome = EquitySuccess | EquityFailure;

/* ============================================================
 * 选项
 * ============================================================ */

export type EquityOptions = {
  /** 蒙特卡洛起始样本量 */
  iterations?: number;
  /** 蒙特卡洛样本上限（自适应升级不会超过它） */
  maxIterations?: number;
  /**
   * 是否启用自适应采样（逐级翻倍 + 提前停止）。
   *
   * **默认 false** —— 这是刻意的设计决定：
   * 调用方显式写下 `iterations: 500` 时，必须**恰好**得到 500 次抽样，
   * 而不是被悄悄升级到 100 万次（那属于规范第 59 条禁止的「静默 Fallback」）。
   * 交互式决策路径由上层显式打开 `adaptive: true`。
   */
  adaptive?: boolean;
  /** 随机种子（可复现） */
  seed?: number;
  /** 精确枚举的对局数上限；超过则走蒙特卡洛 */
  maxExactMatchups?: number;
  /** 强制指定计算方式（测试与黄金用例使用） */
  forceMethod?: EquityMethod;
  /** 低于该样本量时给出「精度不足」警告 */
  minRecommendedIterations?: number;
  /**
   * 决策门槛（最低所需权益）。
   * 提供后启用「置信区间提前停止」：CI 完全落在门槛同一侧即可停止。
   */
  decisionThreshold?: number;
  /** 确定性收益递减阈值：把样本翻倍最多能改变 P 个百分点，低于它就停止 */
  diminishingReturnsThreshold?: number;
  /** 统一时间预算；未提供时用 mode 生成默认值 */
  deadline?: DecisionDeadline;
  /** 计算模式：快速（交互式）/ 高精度 / 验证 */
  mode?: EquityComputeMode;
  /**
   * 每位对手每个组合的**抽样权重**（可选）。
   *
   * ## 为什么需要它
   *
   * 蒙特卡洛原本是**均匀**抽样，于是 Range 引擎做出来的贝叶斯后验
   * 在最后一步被丢掉：「对手加注过 → 范围偏强」对权益毫无影响。
   * 那让 Range → Equity 这条链形同虚设。
   *
   * 长度必须与 `opponents[i].combos` 一致；省略时**完全等价于**均匀抽样
   * （既有调用方零改动、结果逐位一致）。
   */
  opponentWeights?: ReadonlyArray<ReadonlyArray<number>>;
};

export const EquityComputeMode = {
  /** 交互式默认：受 DecisionDeadline 约束 */
  FAST: 'FAST',
  /** 离线高精度：允许更大的样本上限，仍受 deadline 约束（若提供）*/
  PRECISION: 'PRECISION',
  /** 验证：强制精确枚举，用于黄金测试与数学验证 */
  VERIFY: 'VERIFY',
} as const;
export type EquityComputeMode = (typeof EquityComputeMode)[keyof typeof EquityComputeMode];

export const DEFAULT_ITERATIONS = 100_000;
export const DEFAULT_MIN_RECOMMENDED_ITERATIONS = 20_000;

/**
 * 精确枚举的对局数预算。
 *
 * 校准依据（实测，非估计）：
 * - 高速引擎约 **0.75 微秒/局**（AA vs KK 翻牌前 10,273,824 局 ≈ 7.7 秒）
 * - 取 500,000 局 ≈ **0.4 秒**，远在 800ms 的软预算之内
 *
 * 因此「组合规模 ≤ 50 万局」时直接用精确枚举（零统计误差），
 * 比同等的蒙特卡洛更省时间、也更准确。
 */
const DEFAULT_MAX_EXACT_MATCHUPS = 500_000;
const DEFAULT_MAX_ITERATIONS_FAST = 1_000_000;
const DEFAULT_MAX_ITERATIONS_PRECISION = 4_000_000;
const DEFAULT_DIMINISHING_RETURNS_PCT = 0.1;

export function resolveMaxIterations(mode: EquityComputeMode): number {
  return mode === EquityComputeMode.PRECISION
    ? DEFAULT_MAX_ITERATIONS_PRECISION
    : DEFAULT_MAX_ITERATIONS_FAST;
}

export function resolveMaxExactMatchups(options: EquityOptions): number {
  return options.maxExactMatchups ?? DEFAULT_MAX_EXACT_MATCHUPS;
}

export function resolveDiminishingReturns(options: EquityOptions): number {
  return options.diminishingReturnsThreshold ?? DEFAULT_DIMINISHING_RETURNS_PCT;
}

/* ============================================================
 * 组合工具
 * ============================================================ */

/**
 * 把每张牌换算成 0..51 整数索引。
 *
 * 热路径必须避免拼接字符串 key —— 这是实测出来的最大瓶颈之一。
 */
export function toIndexPair(combo: readonly [Card, Card]): [number, number] {
  return [cardIndex(combo[0]), cardIndex(combo[1])];
}

/** 两个组合是否共用牌 */
export function pairsConflict(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] === b[0] || a[0] === b[1] || a[1] === b[0] || a[1] === b[1];
}

/** 组合是否与已知牌冲突 */
export function pairConflictsWith(
  pair: readonly [number, number],
  known: ReadonlySet<number>,
): boolean {
  return known.has(pair[0]) || known.has(pair[1]);
}

/* ============================================================
 * 快速路径：先算组合规模，判断能否直接给出结论
 * ============================================================ */

/**
 * 组合容量的结论。
 * - `exact`：对局数上界（未考虑对手之间的互相冲突，属保守上界）
 * - `mc`：蒙特卡洛样本上限
 */
export type CapacityReport = {
  /** 每位对手「扣除已知牌后」的有效组合数 */
  combosPerOpponent: number[];
  /** 剩余牌堆张数 = 52 − |已知牌| */
  remainingDeckSize: number;
  /** 还要发几张公共牌 */
  cardsToCome: number;
  /** 精确枚举的对局数上界 */
  exactMatchupsBound: number;
  /** 蒙特卡洛样本上限 */
  maxIterations: number;
  /** 当前选择的组合方式 */
  method: EquityMethod;
  /** 选型原因（中文可渲染码） */
  methodReason: EquityPolicyReason;
};

export const EquityPolicyReason = {
  /** 对局数上界在预算内 → 精确枚举 */
  EXACT_WITHIN_BUDGET: 'EXACT_WITHIN_BUDGET',
  /** 组合规模超出预算 → 蒙特卡洛 */
  TOO_MANY_MATCHUPS: 'TOO_MANY_MATCHUPS',
  /** 调用方强制指定 */
  FORCED_BY_CALLER: 'FORCED_BY_CALLER',
  /** 验证模式强制精确枚举 */
  VERIFY_MODE: 'VERIFY_MODE',
  /**
   * 原本可以精确枚举，但**剩余时间不够** → 降级为蒙特卡洛。
   * 这是规范第 59 条要求必须记录在案的降级：结果对象里会带 `downgradedFrom`。
   */
  DOWNGRADED_BY_DEADLINE: 'DOWNGRADED_BY_DEADLINE',
} as const;
export type EquityPolicyReason = (typeof EquityPolicyReason)[keyof typeof EquityPolicyReason];

export function combinationsCount(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i++) result = (result * (n - i)) / (i + 1);
  return Math.round(result);
}
