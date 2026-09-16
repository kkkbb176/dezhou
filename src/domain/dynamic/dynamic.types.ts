/**
 * 动态真人行为模型 —— 类型与输入隔离（Step 7）
 *
 * ## 本阶段唯一要回答的问题
 *
 * > **某个玩家最近的真实打法，是否相对于他自己的长期基线发生了可信的行为偏移？**
>
 * 并把该偏移转化为 **Range / Action Likelihood 的方向性调整证据**。
 *
 * ## 四条硬约束（全部体现在类型设计里）
 *
 * ### 1. 输入必须物理隔离（规范第 5 / 6 / 66 节）
 *
 * `DynamicBehaviorInput` **刻意不含**下列任何字段：
 *
 * | 禁止进入的字段 | 为什么 |
 * |---|---|
 * | `adjustedRange` / `inferredVillainRange` | 会形成「因为范围变宽所以更确认 Tilt」的**自证循环** |
 * | `finalAction` / `recommendation` | Dynamic 不得读取决策输出作为自己的证据 |
 * | `decisionConfidence` | 同上 |
 * | `exploitOutput` | 下游结果不得反向污染上游 |
 * | `previousDynamicState` / `previousTiltProbability` | **禁止自我反馈** |
 * | `showdownRange` | 摊牌泄漏：不得因为最终看到 AA 就把之前的 3Bet 反向判成价值证据 |
 * | `finalProfitLoss` | 输赢不得直接进入评分 |
 *
 * 隔离**不是靠约定**：本文件不导入任何范围 / 决策 / 复盘模块，
 * 并有源码扫描测试断言这一点（规范第 66 节要求「最好通过类型层隔离」）。
 *
 * ### 2. Tilt 永远是概率，不是布尔
 *
 * 类型里**没有** `isTilted: boolean` 这种字段。
 * 只有 `TiltSignal { probability, confidence }`。
 *
 * ### 3. 状态只有 9 种
 *
 * 不允许扩展心理状态。`WIN_TILT` 这种状态**刻意不存在** ——
 * 「赢大池后变松」只能表现为 `LOOSER_RECENTLY` 或 `AGGRESSION_UP`（规范第 30 节）。
 *
 * ### 4. 相关指标不得重复计票
 *
 * 指标被分到 5 个**相关组**（`ENTRY` / `AGGRESSION` / `CALLING` / `SIZING` / `RIVER`），
 * 每组有**独立的贡献上限**（规范第 18 / 19 / 57 节）。
 */

import type { PlayerMetric } from '../player/player.types.ts';

/* ============================================================
 * 一、观察到的真实事件（唯一的近期证据来源）
 * ============================================================ */

/** 只允许真实发生的扑克动作 */
export const ObservedAction = {
  FOLD: 'FOLD',
  CHECK: 'CHECK',
  CALL: 'CALL',
  BET: 'BET',
  RAISE: 'RAISE',
  /** 翻牌前再加注（3Bet） */
  THREE_BET: 'THREE_BET',
  /** 翻牌前 4Bet */
  FOUR_BET: 'FOUR_BET',
  /** 全下 */
  JAM: 'JAM',
} as const;
export type ObservedAction = (typeof ObservedAction)[keyof typeof ObservedAction];

/**
 * 一次真实的行动机会观测。
 *
 * 语义与 Step 6 的 `OpportunityObservation` **完全一致**：
 * `success = true` 表示这次机会上他做了该指标对应的动作。
 *
 * ## 为什么用「逐机会」而不是「窗口内事件计数」
 *
 * 因为「机会必须由牌局状态定义，绝不由玩家动作定义」。
 * 若用事件计数，一个**从不 3Bet** 的玩家永远不会出现在 3Bet 的分母里，
 * 于是他的变紧完全无法被察觉。
 * 逐机会记录让分母来自**牌局状态**，而不是来自行为本身。
 */
export type ObservedOpportunity = {
  metric: PlayerMetric;
  success: boolean;
};

/**
 * 一手牌中某个玩家产生的一条观察记录。
 *
 * 这是 Dynamic 唯一的近期证据来源。
 */
export type ObservedPokerEvent = {
  /** 稳定唯一 id（幂等保护依赖它） */
  eventId: string;
  handId: string;
  playerId: string;
  /** 该手牌内的序号（与 Step 6 的 `seq` 同源，用于窗口与顺序） */
  seq: number;
  /** 时间戳（ISO 8601） */
  timestamp: string;

  /**
   * 本手牌对该玩家产生的全部机会观测。
   *
   * 一手牌对同一指标最多出现一次（与 Step 6 一致）。
   */
  opportunities: readonly ObservedOpportunity[];

  /* ---- 仅供「尺寸行为」组使用的可观测数字 ---- */
  /** 下注/加注相对底池的比例（例如 0.75 = 3/4 池）。缺省表示本手未下注 */
  betSizePotRatio?: number;
  /** 是否为超池下注（> 1 倍底池） */
  isOverbet?: boolean;
  /** 是否为全下 */
  isAllIn?: boolean;
};

/* ============================================================
 * 二、上下文事件（**不得直接加分**）
 * ============================================================ */

/**
 * 上下文事件类型。
 *
 * ⚠️ **这些事件绝不直接改变 Deviation Score**（规范第 3 / 27 / 28 节）。
 * 它们只回答一件事：
 *
 * > 该事件发生**之后**，玩家的真实打法有没有改变？
 *
 * 因此它们只在 `ContextEvent.relatedEventIds` 的范围内
 * 参与「事件后偏移」的计算，而不是作为一个独立的加分项。
 */
export const ContextEventKind = {
  WON_BIG_POT: 'WON_BIG_POT',
  LOST_BIG_POT: 'LOST_BIG_POT',
  COOLER: 'COOLER',
  BAD_BEAT: 'BAD_BEAT',
  BLUFF_CAUGHT: 'BLUFF_CAUGHT',
  SHOWDOWN: 'SHOWDOWN',
} as const;
export type ContextEventKind = (typeof ContextEventKind)[keyof typeof ContextEventKind];

/**
 * 上下文事件。
 *
 * **只允许携带**「发生了什么」与「发生在哪个事件之后」。
 * 刻意**不含**金额、盈亏、牌力 —— 那些会把结果偏差引进来。
 */
export type ContextEvent = {
  /** 稳定唯一 id */
  contextEventId: string;
  handId: string;
  playerId: string;
  seq: number;
  timestamp: string;
  kind: ContextEventKind;
  /**
   * 该事件之后需要观察的事件 id 范围（由调用方按 seq 顺序给出）。
   *
   * 缺省表示「观察全部 seq 更大的事件」。
   */
  observedAfterEventIds?: readonly string[];
};

/* ============================================================
 * 三、基线（来自 Step 6，Dynamic 不重建）
 * ============================================================ */

/**
 * 基线的单项指标。
 *
 * `adjustedRate` 与 `confidence` 直接来自 Step 6 的 `MetricStat` ——
 * Dynamic **绝不允许自己重新建立人口基线**（规范第 10 / 75 节）。
 */
export type BaselineMetricStat = {
  metric: PlayerMetric;
  successes: number;
  opportunities: number;
  /** 收缩后的比率（向先验收缩）；无机会时为 null */
  adjustedRate: number | null;
  effectiveSampleSize: number;
  confidence: number;
};

/**
 * 玩家长期基线快照（Step 6 的只读投影）。
 *
 * 刻意只包含 Step 6 已经算好的数字，**不含**任何范围 / 决策字段。
 */
export type PlayerProfileSnapshot = {
  playerId: string;
  /** 基线覆盖的手数（用于判断基线本身是否足够） */
  handsObserved: number;
  /** 基线版本（缓存 key 依赖它，规范第 47 节） */
  version: string;
  /** 每项指标的基线（缺失表示该项无数据） */
  metrics: Readonly<Partial<Record<PlayerMetric, BaselineMetricStat>>>;
};

/* ============================================================
 * 四、输入（唯一入口，物理隔离）
 * ============================================================ */

/**
 * Dynamic Behavior 的**唯一输入**。
 *
 * ⚠️ 刻意**不含** `DecisionContext` / `Range` / `Decision` / `Result`。
 * 把整个 `DecisionContext` 传进来会为未来的意外读取留下后门（规范第 6 节）。
 */
export type DynamicBehaviorInput = {
  playerId: string;
  /** 长期基线（来自 Step 6） */
  baseline: PlayerProfileSnapshot;
  /** 近期真实事件（乱序可接受，按 timestamp + seq 排序） */
  recentEvents: readonly ObservedPokerEvent[];
  /** 上下文事件（可选；**不得直接加分**） */
  contextEvents?: readonly ContextEvent[];
  /** 计算基准时刻（Unix 毫秒）。`timestamp > asOf` 的事件**不得进入计算** */
  asOf: number;
  /**
   * 人工观察 Hint（可选，规范第 80–82 节）。
   *
   * 它是 `USER_OBSERVED` 来源的证据，**不能**直接变成 Action，
   * 且在有大量真实数据与之冲突时**不得无条件覆盖**，confidence 上限也受限。
   */
  userHints?: readonly UserObservedHint[];
};

/* ============================================================
 * 五、人工观察 Hint（USER_OBSERVED）
 * ============================================================ */

/** 用户可手动选择的观察项（规范第 80 节） */
export const UserHintKind = {
  NORMAL: 'NORMAL',
  LOOSER_RECENTLY: 'LOOSER_RECENTLY',
  TIGHTER_RECENTLY: 'TIGHTER_RECENTLY',
  AGGRESSIVE_RECENTLY: 'AGGRESSIVE_RECENTLY',
  SUSPECT_TILT: 'SUSPECT_TILT',
  SUSPECT_CHASE_LOSS: 'SUSPECT_CHASE_LOSS',
  UNKNOWN: 'UNKNOWN',
} as const;
export type UserHintKind = (typeof UserHintKind)[keyof typeof UserHintKind];

export type UserObservedHint = {
  kind: UserHintKind;
  /** 观察发生的时刻（用于判断是否早于 asOf） */
  timestamp: string;
  /** 可选：用户自发填写的说明（**不参与计算**，仅供显示） */
  note?: string;
};

/* ============================================================
 * 六、Dynamic 指标分组（相关组保护）
 * ============================================================ */

/**
 * 相关组。
 *
 * ## 为什么必须分组（规范第 18 / 19 / 57 节）
 *
 * `VPIP ↑` / `PFR ↑` / `Open ↑` / `3Bet ↑` **不是四个独立证据** ——
 * 它们高度相关，同时异常只说明「翻牌前变松」这一件事。
 * 若简单相加，一次行为变化会被计算四次，Deviation 虚高四倍。
 *
 * 因此每组有**独立的贡献上限**（`GROUP_CAPS`），组内先聚合再计分。
 */
export const DeviationGroup = {
  /** 翻牌前入池：VPIP / PFR / LIMP / OPEN */
  ENTRY: 'ENTRY',
  /** 主动进攻：THREE_BET / FOUR_BET */
  AGGRESSION: 'AGGRESSION',
  /** 被动跟注：CALL_OPEN / CALL_THREE_BET / CALL_CBET / RIVER_CALL */
  CALLING: 'CALLING',
  /** 下注尺寸：大注 / 超池 / 全下 */
  SIZING: 'SIZING',
  /** 河牌行为：RIVER_BET / RIVER_RAISE / RIVER_FOLD */
  RIVER: 'RIVER',
} as const;
export type DeviationGroup = (typeof DeviationGroup)[keyof typeof DeviationGroup];

/**
 * 指标 → 相关组（唯一登记处；未登记的指标不参与 Dynamic）。
 *
 * ## ⚠️ 未登记 = 完全不可见（独立红队 F5）
 *
 * 修复前只登记了 13 个指标，而 `PlayerMetric` 有 29 个。
 * 后果有两个，都必须知道：
 *
 * 1. **`SIZING` 组一个指标都没有** → `SIZE_ANOMALY` 状态
 *    **永远不可能出现**（死代码），且 `betSizePotRatio` / `isOverbet` / `isAllIn`
 *    在 `src/` 下从未被读取 —— 快照里带上它们与不带上**逐位一致**。
 * 2. `CBET` / `TURN_BARREL` / `RIVER_BARREL` / `RIVER_OVERBET` 等
 *    **全部翻后行为不可见**：即使每个机会都命中，偏差仍是 0 分。
 *    而它们的机会数却照样计入样本总量与充分性门槛。
 *
 * 现在补齐 4 个有明确基线语义的指标。
 *
 * ## 仍然**未登记**的指标（诚实记录，不是遗漏）
 *
 * `FOLD_TO_THREE_BET` / `CHECK_RAISE_FLOP` / `TURN_FOLD` / `TURN_RAISE` /
 * `TURN_CHECK_RAISE` / `RIVER_SHOWDOWN` 等：
 * 它们描述的是**对对手动作的反应**或**被动结果**，
 * 需要与「面对该动作的机会」配对才有意义（`FOLD_TO_THREE_BET` 的机会
 * 不是「这一手他有没有弃牌」，而是「这一手他有没有面对 3Bet」）。
 * 当前 `ObservedPokerEvent.opportunities` 由手动输入产生，
 * 尚不能可靠区分这类「面对型」机会，因此**先不登记** ——
 * 登记了会给使用者一个看起来算了、其实语义错误的数字。
 */
export const METRIC_GROUP: Readonly<Partial<Record<PlayerMetric, DeviationGroup>>> = Object.freeze({
  VPIP: DeviationGroup.ENTRY,
  PFR: DeviationGroup.ENTRY,
  LIMP: DeviationGroup.ENTRY,
  OPEN: DeviationGroup.ENTRY,

  THREE_BET: DeviationGroup.AGGRESSION,
  FOUR_BET: DeviationGroup.AGGRESSION,
  /** 翻牌圈持续下注：主动进攻的一部分（此前未登记 → 翻后完全不可见） */
  CBET: DeviationGroup.AGGRESSION,
  /** 转牌继续下注：主动进攻的一部分 */
  TURN_BARREL: DeviationGroup.AGGRESSION,

  CALL_OPEN: DeviationGroup.CALLING,
  CALL_THREE_BET: DeviationGroup.CALLING,
  CALL_CBET: DeviationGroup.CALLING,
  RIVER_CALL: DeviationGroup.CALLING,

  /** 超池下注：这是**尺寸**行为，不是河牌倾向 → 归 SIZING（该组此前为空） */
  RIVER_OVERBET: DeviationGroup.SIZING,

  RIVER_BET: DeviationGroup.RIVER,
  RIVER_BARREL: DeviationGroup.RIVER,
  RIVER_RAISE: DeviationGroup.RIVER,
  RIVER_FOLD: DeviationGroup.RIVER,
});

/**
 * 每组的**最大贡献**（0..1 的归一化上限）。
 *
 * 这不是「权重调参」，而是**防止重复计票的硬上限**：
 * 一组无论内部有多少指标同时异常，对总分的贡献都不超过它。
 *
 * 取值的依据是「这组信息对『他是否偏离自己』的判断价值」，
 * 属于**结构性判断**而非统计估计 —— 因此不含任何可供校准的幅度参数。
 */
export const GROUP_CAPS: Readonly<Record<DeviationGroup, number>> = Object.freeze({
  ENTRY: 1.0,
  AGGRESSION: 0.9,
  CALLING: 0.7,
  SIZING: 0.6,
  RIVER: 0.6,
});

/* ============================================================
 * 七、窗口
 * ============================================================ */

export const WindowSize = {
  W10: 10,
  W20: 20,
  W50: 50,
} as const;
export type WindowSize = (typeof WindowSize)[keyof typeof WindowSize];

export const ALL_WINDOW_SIZES: readonly WindowSize[] = [10, 20, 50];

/**
 * 窗口内的单项指标统计。
 *
 * ⚠️ **手数不是统计分母**（规范第 11 / 12 节）。
 * `opportunities` 才是 —— 一个玩家最近 20 手可能只有 3 次 3Bet 机会。
 */
export type RecentBehaviorStat = {
  metric: PlayerMetric;
  successes: number;
  opportunities: number;
  rawRate: number | null;
  adjustedRate: number | null;
  baselineRate: number | null;
  /**
   * **基线自身的样本量**（来自 `BaselineMetricStat.opportunities`）。
   *
   * 独立红队 F3：方向检验需要基线侧的标准误。若用窗口的 n 代替它，
   * 等于宣称「这个基线只有 20 次观测」，会把基线噪声放大
   * `√(基线机会数 / 窗口机会数)` 倍（200 手基线 → 3.2 倍），
   * 使明显的真实变化被判成「无方向」。
   */
  baselineOpportunities: number | null;
  /** `adjustedRate - baselineRate`；任一侧缺失时为 null */
  deviation: number | null;
  /** 有效样本量（考虑窗口内权重） */
  effectiveSample: number;
  confidence: number;
};

export type RecentWindow = {
  size: WindowSize;
  /** 窗口覆盖的手数（**不是分母**） */
  hands: number;
  /** 参与统计的事件 id（可追溯） */
  eventIds: readonly string[];
  stats: readonly RecentBehaviorStat[];
};

/* ============================================================
 * 八、偏差与状态
 * ============================================================ */

/** 组级偏差（可解释性的中间层） */
export type GroupDeviation = {
  group: DeviationGroup;
  /** 归一化后的组偏差强度 0..GROUP_CAPS[group] */
  score: number;
  /**
   * **主导方向**：组内偏移最强的那一项的方向。
   *
   * ⚠️ 组内方向不一致时这里仍是主导方向（不是 `NONE`）——
   * 见 `directionContested` 与独立红队 F1。
   */
  direction: 'HIGHER' | 'LOWER' | 'NONE';
  /**
   * 组内是否同时存在 HIGHER 与 LOWER。
   *
   * 为 `true` 时 `direction` 只是**主导**方向，使用者必须结合
   * `detectConflicts` 的说明一起读 —— 典型场景：
   * 「入池率上升但主动加注率下降」= 被动跟注变多。
   */
  directionContested: boolean;
  confidence: number;
  /** 该组最强的证据指标（用于解释） */
  strongestMetric: PlayerMetric | null;
  /** 该组参与比较的指标数（含无数据者） */
  comparedMetrics: number;
};

/** Dynamic 状态（**只有 9 种**，禁止扩展） */
export const DynamicState = {
  NORMAL: 'NORMAL',
  LOOSER_RECENTLY: 'LOOSER_RECENTLY',
  TIGHTER_RECENTLY: 'TIGHTER_RECENTLY',
  AGGRESSION_UP: 'AGGRESSION_UP',
  AGGRESSION_DOWN: 'AGGRESSION_DOWN',
  SIZE_ANOMALY: 'SIZE_ANOMALY',
  CHASE_LOSS_SIGNAL: 'CHASE_LOSS_SIGNAL',
  TILT_SIGNAL: 'TILT_SIGNAL',
  UNKNOWN: 'UNKNOWN',
} as const;
export type DynamicState = (typeof DynamicState)[keyof typeof DynamicState];

export const ALL_DYNAMIC_STATES: readonly DynamicState[] = Object.values(DynamicState);

export type DynamicSignal = {
  state: Exclude<DynamicState, 'NORMAL' | 'UNKNOWN'>;
  /** 该信号的**概率**（0..1）。Tilt 永远是概率，不是布尔 */
  probability: number;
  /** 该概率的置信度（由样本量与窗口一致性决定） */
  confidence: number;
  /** 触发该信号的主要指标 */
  drivers: readonly PlayerMetric[];
};

/** Tilt 迹象（**刻意没有 isTilted**） */
export type TiltSignal = {
  probability: number;
  confidence: number;
  /** 触发依据（中文，最多 3 条） */
  evidence: readonly string[];
};

/* ============================================================
 * 九、调整（只允许 6 个维度，且当前只给方向）
 * ============================================================ */

export const DynamicAdjustmentTarget = {
  RANGE_WIDTH: 'RANGE_WIDTH',
  BLUFF_LIKELIHOOD: 'BLUFF_LIKELIHOOD',
  VALUE_LIKELIHOOD: 'VALUE_LIKELIHOOD',
  AGGRESSION_LIKELIHOOD: 'AGGRESSION_LIKELIHOOD',
  CALL_LIKELIHOOD: 'CALL_LIKELIHOOD',
  FOLD_LIKELIHOOD: 'FOLD_LIKELIHOOD',
} as const;
export type DynamicAdjustmentTarget =
  (typeof DynamicAdjustmentTarget)[keyof typeof DynamicAdjustmentTarget];

export const AdjustmentDirection = {
  INCREASE: 'INCREASE',
  DECREASE: 'DECREASE',
} as const;
export type AdjustmentDirection = (typeof AdjustmentDirection)[keyof typeof AdjustmentDirection];

/**
 * 一条方向性调整。
 *
 * ⚠️ **没有 `multiplier` 字段**（规范第 37 节）。
 * 幅度不是 Dynamic 能负责的东西 —— 除非有可验证来源。
 * 需要数值的调用方必须走 `DynamicAdjustmentAdapter`（见 `dynamicAdapter.ts`），
 * 那里会显式标注 `UNVERIFIED_MAGNITUDE`。
 */
export type DynamicRangeAdjustment = {
  target: DynamicAdjustmentTarget;
  direction: AdjustmentDirection;
  confidence: number;
  /** 中文：为什么这样调（最多 3 条） */
  reasons: readonly string[];
  /** 证据来源的事件 id（可追溯） */
  evidenceEventIds: readonly string[];
};

/* ============================================================
 * 十、快照（深不可变）
 * ============================================================ */

export type DynamicBehaviorSnapshot = {
  playerId: string;
  asOf: number;
  /** 0..100；**偏离程度**，不是「疯狂程度」 */
  deviationScore: number;
  /** 0..1；**不是 deviationScore**（规范第 40 节） */
  confidence: number;
  dominantState: DynamicState;
  /**
   * `dominantState` 的**来源**（独立红队 F7）。
   *
   * - `OBSERVED_BEHAVIOR`：由真实事件的偏差推出（默认，可信）
   * - `USER_HINT`：由人工观察 Hint 覆盖而来 —— 此时
   *   **没有真实行为支撑**，`deviationScore` 可能仍是接近 0 的正常值
   *
   * 修复前快照里**没有**任何字段能区分这两种情况：
   * 一键点选产生的 `TILT_SIGNAL` 与真实数据推出的 `TILT_SIGNAL` 长得一模一样。
   */
  stateProvenance: 'OBSERVED_BEHAVIOR' | 'USER_HINT';
  /** 次要信号（不是互斥人格，规范第 25 节） */
  signals: readonly DynamicSignal[];
  groupScores: readonly GroupDeviation[];
  windows: readonly RecentWindow[];
  tilt: TiltSignal;
  adjustments: readonly DynamicRangeAdjustment[];
  /** 参与计算的事件 id（可追溯 + 幂等验证） */
  evidenceEventIds: readonly string[];
  /** 被忽略的事件 id 及原因（重复 / 未来 / 非法） */
  ignoredEvents: readonly { eventId: string; reason: string }[];
  /** 冲突信号（例如 VPIP↑ 但 PFR↓） */
  conflicts: readonly string[];
  /** 中文解释，最多 3 条 */
  explanation: readonly string[];
  /** 模型版本（缓存 key 依赖它） */
  version: string;
};

/* ============================================================
 * 十一、失败与结果类型
 * ============================================================ */

export const DynamicErrorCode = {
  /** 基线缺失 → Fail Closed（规范第 62 节） */
  MISSING_BASELINE: 'MISSING_BASELINE',
  /** 玩家 id 不匹配 */
  PLAYER_MISMATCH: 'PLAYER_MISMATCH',
  /** 非法数值（NaN / Infinity / 负机会数 / successes > opportunities / 越界 confidence） */
  INVALID_NUMERIC: 'INVALID_NUMERIC',
  /** 时间戳不可解析且无法排序 */
  UNORDERABLE_EVENTS: 'UNORDERABLE_EVENTS',
  /** 事件缺少必需字段 */
  MALFORMED_EVENT: 'MALFORMED_EVENT',
  /**
   * `asOf` 不是有限数（独立红队 F9）。
   *
   * 原先 `asOf = NaN` / `Infinity` 会让 `timestamp > asOf` **永远为假**，
   * 于是**未来事件全部进入计算**（20 条未来事件的用例被算成 W20 机会 100、
   * 状态 `NORMAL`、34 分），并且 `asOf` 被原样写进快照（JSON 序列化成 `null`）。
   * 那等于让一个非法的时间基准静默地改变全部判定。
   */
  INVALID_AS_OF: 'INVALID_AS_OF',
} as const;
export type DynamicErrorCode = (typeof DynamicErrorCode)[keyof typeof DynamicErrorCode];

export type DynamicFailure = {
  ok: false;
  code: DynamicErrorCode;
  params: Readonly<Record<string, string | number>>;
};

export type DynamicOutcome<T> = { ok: true; value: T } | DynamicFailure;

export function dynamicFailure(
  code: DynamicErrorCode,
  params: Record<string, string | number> = {},
): DynamicFailure {
  return { ok: false, code, params };
}

/* ============================================================
 * 十二、常量
 * ============================================================ */

/**
 * Dynamic 模型版本。
 *
 * 任何影响输出的改动**必须**升版本 ——
 * 它进入缓存 key 与产物清单，是「昨天 CALL 今天 FOLD」追溯链的一环。
 */
export const DYNAMIC_MODEL_VERSION = '1.2.0';

/**
 * 样本充分性门槛。
 *
 * `MIN_RECENT_OPPORTUNITIES` 是**总机会数**门槛：
 * 低于它一律输出 `UNKNOWN`，**绝不默认 `NORMAL`**（规范第 22 / 23 / 61 节）。
 */
export const MIN_RECENT_OPPORTUNITIES = 8;
/** 基线必须至少有这么多次机会，否则该项不参与比较 */
export const MIN_BASELINE_OPPORTUNITIES = 20;

/**
 * 「近期机会已足够充分」的刻度（Step 7 红队修复，v1.1.0）。
 *
 * 窗口统计的 `confidence` 由近期机会数在该区间上线性映射得到。
 * 下界用 `MIN_RECENT_OPPORTUNITIES`（判断门槛，低于它一律 UNKNOWN），
 * 上界用本常量。两者都是**结构性刻度**（多少次观测才算够），
 * 不是从数据里估出来的参数。
 */
export const SUFFICIENT_RECENT_OPPORTUNITIES = 60;

/**
 * 单手影响上限（规范第 33 节）。
 *
 * 一手动作**不能让** DeviationScore 从 10 跳到 90。
 * 实现方式：窗口级偏差先按 `effectiveSample` 收缩，
 * 而单手对 `effectiveSample` 的贡献被 `maxSingleHandShare` 限制（复用 Step 6 的机制）。
 */
export const MAX_SINGLE_EVENT_SHARE = 0.05;

/** 时间衰减半衰期（手数）。允许近期权重略高，但**有界**（规范第 32 节） */
export const RECENT_HALF_LIFE_HANDS = 30;

/**
 * 近期机会数的**收缩参考点**（Step 7 红队修复，v1.1.0）。
 *
 * ## 它定义什么
 *
 * 窗口统计把近期观测率向个人基线收缩：
 *
 * ```
 * adjustedRate = (Σ 近期权重·命中 + k·基线率) / (Σ 近期权重 + k)
 * k = (REF − c) / c × 基线置信度        （c = 该指标近期机会数，c < REF）
 * ```
 *
 * 于是「基线 : 近期」的权重比恰好是 `(REF − c) : c`：
 * - `c → 0`     → 基线几乎独占权重 → 偏差趋 0（**样本保护**）
 * - `c = REF/2` → 基线与近期证据等权
 * - `c ≥ REF`   → `k = 0` → 完全不收缩（近期证据已足够）
 *
 * ## 取值 60 = `SUFFICIENT_RECENT_OPPORTUNITIES`（20 手窗口仍偏保守）
 *
 * 与「充分」刻度取同一个数，是因为它回答的正是同一个问题：
 * 多少次观测才足以独立于历史说话。于是等权点落在 30 次机会上 ——
 * 一个 20 手窗口（多数指标约 20 次机会）里，
 * 基线仍占约 `(60−20) : 20 = 2 : 1` 的权重。
 *
 * ⚠️ **不要把它调小。** 红队实测：取 40（等权点 20 次机会）时，
 * 20 手窗口的纯随机噪声会被放大成「PFR 下降但 3Bet 上升」的
 * **虚假方向冲突**，进而触发误导性的冲突提示。收缩的意义正在于
 * 让 20 手窗口的 ±1 次计数差异不至于被当成真实变化。
 *
 * ## ⚠️ 它**不能**被基线的样本量替代（红队实测的假阴性来源）
 *
 * 若取 `k = 基线的 effectiveSampleSize`（可能上千手），则 20 手窗口的
 * 20 次机会会被完全压平 —— 一个 VPIP 从 15% 涨到 45% 的玩家算出的
 * `adjustedRate` 仍≈15%，DeviationScore 停在 0~1 分，系统回答
 * 「与基线一致」而事实相反。退一步取 `k = min(基线 ESS, 40)` 也不够：
 * 同一个场景只算出 21 分。
 *
 * 根因是概念混淆：「基线有多长」与「近期证据有多强」是两件无关的事。
 * 基线长只说明我们对他的**历史**了解得多，不说明**变化**不存在。
 * 收缩强度只应由**近期观测数**决定。
 *
 * `MAX_BASELINE_SHRINKAGE` 保留为同一刻度的显式上界表达。
 *
 * 与 `MIN_ABSOLUTE_SCALE` 一样，这是**结构性判断**（多少次观测
 * 才足以与个人历史对话），不是从数据里估出来的参数。
 */
/**
 * 温和收缩比例（独立红队第二轮，v1.2.0）。
 *
 * 窗口统计的收缩强度：`k = MILD_SHRINKAGE_RATIO × c × 基线质量`
 * （`c` = 该指标近期机会数）。`1/3` 意味着基线约占 25% 的权重。
 *
 * ## ⚠️ 为什么不能靠加大收缩来压制误报
 *
 * 红队实测（真值 = 基线，200 个确定性种子，20 手窗口）：
 *
 * | 收缩强度 | 误报率 | 真实变化（VPIP 15%→45%） |
 * |---|---|---|
 * | `k = c/3` | — | 检出 ✅ |
 * | `k = 2c` | 7% | **被压到 12 分** ❌ |
 *
 * 「压制噪声」与「压制真实变化」是**同一条曲线** ——
 * 想让误报降到 0，只需把收缩加到无穷大，代价是永远发现不了任何变化。
 *
 * 正确分工：
 * - **收缩**温和抑制极端值（本常量）
 * - **显著性检验**区分噪声与真实变化（`metricDeviation` 的 z 检验）
 *
 * 误报率从 36.5% 降到 7.0% 是后者的功劳。
 */
export const MILD_SHRINKAGE_RATIO = 1 / 3;

/** @deprecated 已被 `MILD_SHRINKAGE_RATIO` 取代，保留供报告引用 */
export const SHRINKAGE_REFERENCE_OPPORTUNITIES = SUFFICIENT_RECENT_OPPORTUNITIES;

/**
 * 基线先验强度的上界 —— 与 `SHRINKAGE_REFERENCE_OPPORTUNITIES` 是同一刻度。
 *
 * ⚠️ **当前生产路径不直接使用它**（`dynamicStats.computeWindowStats` 用的是
 * 尺度混合比 `(REF − c) / c`，`c → 0` 时该比自然趋于无穷）。
 * 保留它只为两件事：
 * 1. 给「基线最多值多少次观测」一个可命名的显式上界，供报告与测试引用；
 * 2. 让后续若引入显式截断时有唯一出处，而不是各处硬编码数字。
 */
export const MAX_BASELINE_SHRINKAGE = SHRINKAGE_REFERENCE_OPPORTUNITIES;


/** 人工 Hint 的 confidence 上限（规范第 82 节） */
export const USER_HINT_CONFIDENCE_CAP = 0.45;

/** 人工 Hint 在无真实数据时的最高状态概率（规范第 82 节） */
export const USER_HINT_PROBABILITY_CAP = 0.6;
