/**
 * 范围引擎 —— 类型与来源元数据
 *
 * 规范第一/二节的核心约束：**必须严格区分四件事**
 *   1. 范围引擎的数学机制是否正确
 *   2. 范围数据本身是否可靠
 *   3. 范围数据来自哪里
 *   4. 范围数据的可信度是多少
 *
 * 本文件用类型系统把这四件事分开：机制在 range.ts / rangeUpdate.ts，
 * 来源在 RangeProvenance，可信度在 confidence，数据本身在 RangeEntry。
 */

import type { ActionType } from '../types.ts';
import type { DecisionDeadline } from '../../app/decisionDeadline.ts';
import type { DecisionContext } from '../../app/decisionPipeline.ts';

/**
 * 浮点比较统一容差（规范第九节：不允许每个模块各自定义 epsilon）。
 *
 * 刻意放在范围引擎的共享类型文件里，使归一化、校验、blocker 三处使用**同一个**数值。
 */
export const EPSILON = 1e-9;
import type { ExactCombo } from './combo.ts';

/* ============================================================
 * 数据来源（规范第十三 / 十五 / 五十六节）
 * ============================================================ */

/**
 * 范围的来源类型。
 *
 * **FALLBACK 不允许静默出现** —— 它以独立枚举值存在，就是为了让「这是兜底数据」
 * 在任何日志、UI、决策链里都无所遁形。
 */
export const RangeSource = {
  /** 理论来源：有可信 solver 输出或权威公开数据集支撑 */
  THEORY_SOURCE: 'THEORY_SOURCE',
  /** 已验证数据：从真实牌局历史统计得到，且样本量充分 */
  VERIFIED_DATA: 'VERIFIED_DATA',
  /** 用户自定义 */
  USER_DEFINED: 'USER_DEFINED',
  /** 经验数据：有一定依据但未达「已验证」标准 */
  EMPIRICAL: 'EMPIRICAL',
  /**
   * 启发式：依据公认的扑克原理（位置越靠后范围越宽、筹码越浅越紧等）构造。
   * **绝不允许在 UI 上显示为「GTO 范围」。**
   */
  HEURISTIC: 'HEURISTIC',
  /** 兜底：不是「可信来源」，任何使用它的决策都必须降置信度 */
  FALLBACK: 'FALLBACK',
  /** 仅用于测试的合成数据，**禁止进入生产建议** */
  TEST_ONLY: 'TEST_ONLY',
} as const;
export type RangeSource = (typeof RangeSource)[keyof typeof RangeSource];

/**
 * 来源元数据。任何范围都必须能回答「这个数据从哪里来的」（规范第十五节）。
 */
export type RangeProvenance = {
  /** 稳定标识，例如 "heuristic.rfi.6max.v1" */
  sourceId: string;
  sourceType: RangeSource;
  /** 数据版本；数据内容变化必须升版本（缓存 key 依赖它） */
  version: string;
  /** 中文说明：这份数据基于什么 */
  description: string;
  /** 是否经过验证（solver 复核 / 独立数据集交叉验证 / 大样本统计） */
  verified: boolean;
  /** 对该数据可信度的主观评估，0..1 */
  confidence: number;
  createdAt?: string;
};

/** 已知来源登记表：所有 provenance 必须在此登记，避免来源字符串散落各处 */
export type ProvenanceRegistry = ReadonlyMap<string, RangeProvenance>;

/* ============================================================
 * 范围条目与范围
 * ============================================================ */

/**
 * 范围中的一个组合。
 *
 * **rawWeight 与 probability 必须严格区分**（规范第七 / 八节）：
 * - `rawWeight`：尚未归一化的相对权重（例如 AA=1.0、KK=1.0、QQ=0.5）
 * - `probability`：归一化后的概率，Σ ≈ 1
 *
 * 禁止在代码里有时把 weight 当频率、有时当概率 —— 这是高危隐性 Bug。
 * 类型上两者都是 number，无法用类型系统阻止误用，因此：
 * 1. 命名刻意不同（rawWeight / probability）
 * 2. `rangeValidator` 会分别校验两者
 * 3. 归一化函数只写 probability 字段，绝不覆盖 rawWeight
 */
export type RangeEntry = {
  combo: ExactCombo;
  /** 尚未归一化的相对权重；必须 finite 且 ≥ 0 */
  rawWeight: number;
  /** 归一化后的概率；Σ probability ≈ 1 */
  probability: number;
  /** 该条目的来源 */
  source: RangeSource;
  /** 该条目的可信度，0..1 */
  confidence: number;
  tags?: readonly string[];
};

/** 范围状态：EMPTY 表示尚未建立，NORMALIZED 表示已归一化，COLLAPSED 表示全部权重归零 */
export const RangeState = {
  /** 已归一化，可参与计算 */
  NORMALIZED: 'NORMALIZED',
  /** 权重尚未归一化（中间态） */
  UNNORMALIZED: 'UNNORMALIZED',
  /** 范围坍塌：所有 rawWeight = 0 或有效组合为 0 */
  COLLAPSED: 'COLLAPSED',
} as const;
export type RangeState = (typeof RangeState)[keyof typeof RangeState];

export type RangeMetrics = {
  /** 有效组合数（rawWeight > 0） */
  supportSize: number;
  /** 参与度量的组合总数（含权重为 0 的） */
  totalEntries: number;
  /** 有效组合数：1 / Σ(p²)，衡量概率分布的集中程度 */
  effectiveComboCount: number;
  /** 香农熵（以 2 为底），单位 bit */
  entropyBits: number;
  /** 归一化后的熵（0..1；1 表示完全均匀） */
  normalizedEntropy: number;
  /** Σp 的实际值（用于校验归一化） */
  probabilitySum: number;
  /** 平均可信度（按概率加权） */
  weightedConfidence: number;
  /** 最低条目可信度 */
  minConfidence: number;
  /** 主导组合的概率（最高者） */
  topProbability: number;
};

/**
 * 组合 → 条目下标的**只读**索引视图。
 *
 * 为什么不是 `ReadonlyMap`（那只是编译期约束）：红队审计发现
 * `range.indexById.set(...)` / `.clear()` 在运行时**真的能改**，
 * 而 `Object.freeze` 对 Map 的内部槽位无效。
 * 因此这里只暴露 `get` / `has`，运行时不存在可用的写入口。
 */
export type ReadOnlyIndex = {
  get(key: string): number | undefined;
  has(key: string): boolean;
};

/**
 * 一个范围。**不可变**（规范第四十一节）：所有更新返回新对象。
 *
 * 不可变是硬要求：复盘时必须能拿到「当时那一步的范围」，
 * 若被后续动作原地修改，历史范围就永久污染了。
 *
 * 冻结必须覆盖**全部层级**（红队审计 CRITICAL-1 的教训）：
 * range 本体 / entries 数组 / 每个 entry / 每个 entry 引用的 combo 与牌 /
 * provenance / metrics / tags / indexById 的写入口。
 */
export type Range = {
  /** 稳定 id，便于日志引用（每次更新产生新 id，previousRangeId 指向旧 id） */
  rangeId: string;
  /** 上一次的范围 id（首次建立为 null） */
  previousRangeId: string | null;
  state: RangeState;
  entries: readonly RangeEntry[];
  provenance: RangeProvenance;
  metrics: RangeMetrics;
  /** 组合 → 条目下标，便于 O(1) 查找（只读视图） */
  indexById: ReadOnlyIndex;
};

/* ============================================================
 * 动作似然（规范第二十三 / 二十四 / 二十五节）
 * ============================================================ */

/** 范围引擎认识的动作（与领域层 ActionType 对齐，但不含盲注/前注） */
export const RangeAction = {
  CHECK: 'CHECK',
  BET: 'BET',
  CALL: 'CALL',
  RAISE: 'RAISE',
  FOLD: 'FOLD',
  ALL_IN: 'ALL_IN',
} as const;
export type RangeAction = (typeof RangeAction)[keyof typeof RangeAction];

export const RANGE_ACTIONS: readonly RangeAction[] = [
  RangeAction.CHECK,
  RangeAction.BET,
  RangeAction.CALL,
  RangeAction.RAISE,
  RangeAction.FOLD,
  RangeAction.ALL_IN,
];

/** 领域层 ActionType → 范围动作（不认识的返回 null） */
export function toRangeAction(action: ActionType): RangeAction | null {
  switch (action) {
    case 'CHECK':
      return RangeAction.CHECK;
    case 'BET':
      return RangeAction.BET;
    case 'CALL':
      return RangeAction.CALL;
    case 'RAISE':
    case 'RERAISE':
      return RangeAction.RAISE;
    case 'FOLD':
      return RangeAction.FOLD;
    case 'ALL_IN':
      return RangeAction.ALL_IN;
    default:
      return null;
  }
}

/**
 * 「某个组合执行某个动作的相对频率」。
 *
 * likelihood 是**条件概率** P(动作 | 手牌)，因此必须落在 0..1。
 *
 * ⚠️ 不要把尺寸与强度写死绑定（规范第二十二节）：
 * 「大尺寸 = 强范围」只在**理论基线**里成立；
 * 真人可能 Tilt、极化、诈唬、赌博式下注。
 * 本阶段只负责把「尺寸」作为条件变量接进来，修正交给后续 Player Model。
 */
export type ActionLikelihood = {
  comboId: string;
  action: RangeAction;
  /** P(动作 | 手牌)，必须 0 ≤ likelihood ≤ 1 */
  likelihood: number;
  source: RangeSource;
  confidence: number;
};

/**
 * 一个决策节点的动作模型。
 *
 * `PARTIAL_ACTION_MODEL`（规范第二十五节）：若同一 combo 的
 * Σ P(动作) ≠ 1，说明动作模型不完整，**必须显式标注**，不能假装完整。
 */
export type ActionModel = {
  /** 该节点的全部 likelihood */
  likelihoods: readonly ActionLikelihood[];
  /** 是否为完整动作模型（每个 combo 的动作频率之和 ≈ 1） */
  complete: boolean;
  /** 不完整时的说明 */
  completenessNote?: string;
  provenance: RangeProvenance;
};

/* ============================================================
 * 更新
 * ============================================================ */

/** 更新上下文（规范第三十一节要求可审计） */
export type RangeUpdateContext = {
  street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER';
  action: RangeAction;
  /** 行动者标识（位置名或玩家 id） */
  actor: string;
  /** 当前街的行动序号（同一街第几次动作） */
  actionIndex: number;
  /** 当前场上活跃玩家数；多人池必须走独立逻辑，不得套用单挑模型 */
  activePlayerCount: number;
  /** 已投入的底池（用于日志） */
  potSize?: number;
  /** 下注尺寸（用于日志与后续尺寸建模） */
  betSize?: number;
};

/** 单次范围更新的审计记录（规范第三十一 / 三十二节） */
export type RangeUpdateLog = {
  previousRangeId: string;
  newRangeId: string;
  street: RangeUpdateContext['street'];
  action: RangeAction;
  actor: string;
  context: RangeUpdateContext;
  beforeMetrics: RangeMetrics;
  afterMetrics: RangeMetrics;
  source: RangeSource;
  confidence: number;
  runtimeMs: number;
  /** 组合变更摘要（不保存 1326 条完整 diff，避免日志膨胀） */
  summary: RangeDiffSummary;
  /** 是否发生了提前中止 */
  aborted: boolean;
  abortReason: string | null;
};

export type RangeDiffEntry = {
  comboId: string;
  rankClass: string;
  beforeProbability: number;
  afterProbability: number;
  delta: number;
};

/** 变更摘要（规范第三十二节） */
export type RangeDiffSummary = {
  topIncreases: RangeDiffEntry[];
  topDecreases: RangeDiffEntry[];
  /** 因与本街死牌冲突而被移除的组合数 */
  removedByBlockers: number;
  /**
   * 因似然为 0（含未声明似然）而被移除的组合数。
   *
   * 与 `removedByBlockers` **必须分成两个计数** ——
   * 红队审计发现旧版把「似然为 0」也算进 `removedByBlockers`，
   * 于是在没有任何死牌变化时也会报出 `removedByBlockers = 15`，
   * 让复盘者误以为是牌面 blocker 造成的收缩。
   */
  removedByZeroLikelihood: number;
  /** 两者之和 = supportSizeBefore − supportSizeAfter */
  removedTotal: number;
  supportSizeBefore: number;
  supportSizeAfter: number;
  entropyBefore: number;
  entropyAfter: number;
};

/* ============================================================
 * 外部调整接口（规范第二十六节）
 * ============================================================ */

/**
 * 外部范围调整接口。
 *
 * 本 Phase **只建立接口，不实现**（规范第二十六 / 六十一节）：
 * Player Profile / Dynamic Human Model / Exploit Engine 未来都通过它
 * 影响 combo 权重或动作似然，但**禁止**把玩家行为系统直接塞进 Range Engine。
 */
export type RangeAdjustmentProvider = {
  /** 提供者标识 */
  providerId: string;
  /** 调整 combo 的相对权重（返回乘法因子，1 表示不调整） */
  adjustComboWeight?: (combo: ExactCombo, context: RangeUpdateContext) => number;
  /** 调整动作似然（返回乘法因子，1 表示不调整） */
  adjustActionLikelihood?: (
    likelihood: ActionLikelihood,
    context: RangeUpdateContext,
  ) => number;
};

/* ============================================================
 * 错误码
 * ============================================================ */

export const RangeErrorCode = {
  /** 范围坍塌：所有权重为 0 或有效组合为 0 */
  RANGE_COLLAPSE: 'RANGE_COLLAPSE',
  /** 时间预算耗尽（范围计算无完整结果，不得返回部分范围） */
  RANGE_DEADLINE_EXCEEDED: 'RANGE_DEADLINE_EXCEEDED',
  /** 归一化失败（总和为 0 或非有限） */
  RANGE_NORMALIZE_FAILED: 'RANGE_NORMALIZE_FAILED',
  /** 校验失败 */
  RANGE_VALIDATION_FAILED: 'RANGE_VALIDATION_FAILED',
  /** 动作模型不完整 */
  RANGE_PARTIAL_ACTION_MODEL: 'RANGE_PARTIAL_ACTION_MODEL',
  /** 未知组合 */
  RANGE_UNKNOWN_COMBO: 'RANGE_UNKNOWN_COMBO',
  /** 动作似然越界 */
  RANGE_INVALID_LIKELIHOOD: 'RANGE_INVALID_LIKELIHOOD',
} as const;
export type RangeErrorCode = (typeof RangeErrorCode)[keyof typeof RangeErrorCode];

/* ============================================================
 * 引擎对外接口（可中止）
 * ============================================================ */

/** 范围引擎接受的时间预算载体（规范第三十三节：从第一天就接受 DecisionContext） */
export type RangeClock = {
  /** 剩余毫秒 */
  remainingMs(): number;
  /** 是否已请求中止 */
  isAborted(): boolean;
  /** 是否已超硬上限 */
  isExpired(): boolean;
  /** 在给定成本下是否还值得继续 */
  canAfford(costMs: number): boolean;
  /** 供超时错误携带的诊断信息 */
  snapshot(): { elapsedMs: number; remainingMs: number };
};

/** 从 DecisionContext 取出范围引擎需要的那部分能力 */
export function toRangeClock(ctx: DecisionContext): RangeClock {
  return {
    remainingMs: () => ctx.remainingMs(),
    isAborted: () => ctx.isAborted(),
    isExpired: () => ctx.isExpired(),
    canAfford: (costMs) => ctx.canAfford(costMs),
    snapshot: () => ({
      elapsedMs: Math.round(ctx.deadline.elapsedMs()),
      remainingMs: Math.round(ctx.remainingMs()),
    }),
  };
}

/** 从 DecisionDeadline 构造（无完整 ctx 时的轻量用法） */
export function deadlineClock(deadline: DecisionDeadline): RangeClock {
  return {
    remainingMs: () => deadline.remainingMs(),
    isAborted: () => deadline.isSettled() === false ? false : false,
    isExpired: () => deadline.hardExpired(),
    canAfford: (costMs) => deadline.canStartRound(costMs),
    snapshot: () => ({
      elapsedMs: Math.round(deadline.elapsedMs()),
      remainingMs: Math.round(deadline.remainingMs()),
    }),
  };
}

export type RangeFailure = {
  ok: false;
  code: RangeErrorCode;
  params: Readonly<Record<string, string | number>>;
};

export type RangeOutcome<T> = { ok: true; value: T } | RangeFailure;

export function rangeFailure(
  code: RangeErrorCode,
  params: Record<string, string | number> = {},
): RangeFailure {
  return { ok: false, code, params };
}

/** 无时间约束的时钟（离线、验证、单元测试用） */
export const UNBOUNDED_CLOCK: RangeClock = {
  remainingMs: () => Number.POSITIVE_INFINITY,
  isAborted: () => false,
  isExpired: () => false,
  canAfford: () => true,
  snapshot: () => ({ elapsedMs: 0, remainingMs: Number.POSITIVE_INFINITY }),
};
