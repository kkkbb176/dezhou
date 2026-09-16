/**
 * 玩家长期画像 —— 类型、指标定义、先验来源（Step 6）
 *
 * ## 第一性原理
 *
 * Player Profile 回答的是：**这个人长期通常怎么打？**
 * 它**不**回答「他这手是什么牌」，也**不**回答「我该怎么打」。
 *
 * ## 四条硬约束
 *
 * 1. **底层只保存连续数据，标签只是摘要**（规范第十 / 十九节）。
 *    每项指标保存 `successes / opportunities / rawRate / adjustedRate /
 *    effectiveSampleSize / confidence` —— 而不是一个 `VPIP = 32%`。
 *
 * 2. **机会数必须独立**（规范第十二 / 十五节）。
 *    500 手 ≠ 河牌超池样本 500。每项指标各自维护 `opportunities`。
 *    「没遇到 3Bet」不能进入 Fold-to-3Bet 的分母。
 *
 * 3. **机会由牌局状态定义，绝不由玩家的动作定义**。
 *    否则「从不诈唬的人」会因为「他从没诈唬过」而永远不被计入诈唬机会 ——
 *    分母被他的行为偷走了。机会必须只看：位置、是否轮到他、底池大小、筹码。
 *
 * 4. **先验来源必须透明**（规范第十四节）。
 *    没有真实人口统计数据库时只能叫 `HEURISTIC_PRIOR` / `TEST_PRIOR` /
 *    `UNKNOWN_PRIOR`，**绝不允许**叫 `THEORY_PRIOR` 或 `GTO_PRIOR`。
 */

/* ============================================================
 * 先验来源
 * ============================================================ */

/**
 * 先验（population baseline）的来源类型。
 *
 * 刻意**没有** `THEORY_PRIOR` / `GTO_PRIOR` 这两个取值 ——
 * 当前项目没有任何可靠的人口统计数据，声称「理论先验」就是编造。
 */
export const PriorSource = {
  /** 启发式：依据公认的扑克原理构造（例如常客玩家的 VPIP 大致区间） */
  HEURISTIC_PRIOR: 'HEURISTIC_PRIOR',
  /** 仅用于测试的合成先验 */
  TEST_PRIOR: 'TEST_PRIOR',
  /** 没有先验：全部回缩到中立值 0.5 */
  UNKNOWN_PRIOR: 'UNKNOWN_PRIOR',
  /** 从真实牌局历史统计得到（需要大样本，当前**没有**） */
  EMPIRICAL_PRIOR: 'EMPIRICAL_PRIOR',
} as const;
export type PriorSource = (typeof PriorSource)[keyof typeof PriorSource];

export type MetricPrior = {
  /** 先验中心（回缩目标），0..1 */
  center: number;
  /**
   * 先验强度（等效样本量）。
   * 越大表示越「不信任观测数据」。公式：adjusted = (successes + k·center) / (n + k)
   */
  strength: number;
  source: PriorSource;
  /** 中文说明：这个先验基于什么 */
  description: string;
};

/* ============================================================
 * 指标定义
 * ============================================================ */

export const PlayerMetric = {
  /* ---- 翻牌前 ---- */
  VPIP: 'VPIP',
  PFR: 'PFR',
  LIMP: 'LIMP',
  OPEN: 'OPEN',
  CALL_OPEN: 'CALL_OPEN',
  THREE_BET: 'THREE_BET',
  FOUR_BET: 'FOUR_BET',
  FOLD_TO_THREE_BET: 'FOLD_TO_THREE_BET',
  CALL_THREE_BET: 'CALL_THREE_BET',
  /* ---- 翻牌 ---- */
  CBET: 'CBET',
  FOLD_TO_CBET: 'FOLD_TO_CBET',
  CALL_CBET: 'CALL_CBET',
  RAISE_CBET: 'RAISE_CBET',
  CHECK_RAISE_FLOP: 'CHECK_RAISE_FLOP',
  /* ---- 转牌 ---- */
  TURN_BARREL: 'TURN_BARREL',
  TURN_FOLD: 'TURN_FOLD',
  TURN_RAISE: 'TURN_RAISE',
  TURN_CHECK_RAISE: 'TURN_CHECK_RAISE',
  /* ---- 河牌 ---- */
  RIVER_BET: 'RIVER_BET',
  RIVER_BARREL: 'RIVER_BARREL',
  RIVER_OVERBET: 'RIVER_OVERBET',
  RIVER_CALL: 'RIVER_CALL',
  RIVER_RAISE: 'RIVER_RAISE',
  RIVER_FOLD: 'RIVER_FOLD',
  RIVER_SHOWDOWN: 'RIVER_SHOWDOWN',
} as const;
export type PlayerMetric = (typeof PlayerMetric)[keyof typeof PlayerMetric];

export const ALL_PLAYER_METRICS: readonly PlayerMetric[] = Object.values(PlayerMetric);

/**
 * 指标元数据。
 *
 * `opportunityRule` 用中文写清「什么算一次机会」——
 * 这不是文档装饰，而是**可审计的契约**：测试会针对每条规则构造反例。
 */
export type MetricDefinition = {
  metric: PlayerMetric;
  /** 中文显示名 */
  label: string;
  street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER';
  /** 什么算一次机会（由**牌局状态**定义，与玩家行为无关） */
  opportunityRule: string;
  /** 什么算一次成功 */
  successRule: string;
  prior: MetricPrior;
};

/* ============================================================
 * 先验表（全部为启发式或测试，**没有任何一条标为理论**）
 * ============================================================ */

const HEURISTIC = (center: number, strength: number, description: string): MetricPrior => ({
  center,
  strength,
  source: PriorSource.HEURISTIC_PRIOR,
  description,
});

/**
 * 启发式先验表。
 *
 * 数值依据是**公开的扑克常识区间**（例如常客玩家翻牌前入池率大致 20%~30%），
 * 不是任何 solver 输出。因此强度刻意压低（k = 20~40），
 * 让真实观测在有 100+ 次机会后能主导结果。
 */
export const METRIC_DEFINITIONS: Readonly<Record<PlayerMetric, MetricDefinition>> = {
  [PlayerMetric.VPIP]: {
    metric: PlayerMetric.VPIP,
    label: '翻牌前入池率',
    street: 'PREFLOP',
    opportunityRule: '轮到我行动且无人加注到我面前（含盲注位首次行动）',
    successRule: '我主动投入筹码（跟注 / 加注 / 全下），不含仅补盲',
    prior: HEURISTIC(0.25, 30, '常客玩家翻牌前入池率的常见区间中心约 25%'),
  },
  [PlayerMetric.PFR]: {
    metric: PlayerMetric.PFR,
    label: '翻牌前主动加注率',
    street: 'PREFLOP',
    opportunityRule: '轮到我行动（翻牌前任意时点，每人每手最多计一次）',
    successRule: '我做出加注或再加注（不含跟注、不含盲注）',
    prior: HEURISTIC(0.18, 30, '常客玩家翻牌前主动加注率常见区间中心约 18%'),
  },
  [PlayerMetric.LIMP]: {
    metric: PlayerMetric.LIMP,
    label: '翻牌前溜入率',
    street: 'PREFLOP',
    opportunityRule: '我尚未投入筹码，且当前无人加注（只有盲注）',
    successRule: '我跟注进入（溜入）而不是加注或弃牌',
    prior: HEURISTIC(0.1, 25, '溜入在常客中不常见，中心约 10%'),
  },
  [PlayerMetric.OPEN]: {
    metric: PlayerMetric.OPEN,
    label: '翻牌前开池率',
    street: 'PREFLOP',
    opportunityRule: '我尚未投入筹码，且前面所有人弃牌（我是第一个行动的）',
    successRule: '我做出加注（开池）',
    prior: HEURISTIC(0.3, 30, '开池率随位置变化很大，中心取约 30%'),
  },
  [PlayerMetric.CALL_OPEN]: {
    metric: PlayerMetric.CALL_OPEN,
    label: '面对开池跟注率',
    street: 'PREFLOP',
    opportunityRule: '我尚未投入筹码，且前面有人开池加注',
    successRule: '我跟注（不含再加注、不含弃牌）',
    prior: HEURISTIC(0.15, 25, '面对开池时的跟注率中心约 15%'),
  },
  [PlayerMetric.THREE_BET]: {
    metric: PlayerMetric.THREE_BET,
    label: '翻牌前 3Bet 率',
    street: 'PREFLOP',
    opportunityRule: '我尚未投入筹码，且前面恰好有一次加注（开池）',
    successRule: '我做出再加注（3Bet）',
    prior: HEURISTIC(0.07, 25, '常客 3Bet 率常见区间中心约 7%'),
  },
  [PlayerMetric.FOUR_BET]: {
    metric: PlayerMetric.FOUR_BET,
    label: '翻牌前 4Bet 率',
    street: 'PREFLOP',
    opportunityRule: '我尚未投入筹码，且前面已经出现 3Bet',
    successRule: '我做出再加注（4Bet）',
    prior: HEURISTIC(0.03, 20, '4Bet 很罕见，中心约 3%'),
  },
  [PlayerMetric.FOLD_TO_THREE_BET]: {
    metric: PlayerMetric.FOLD_TO_THREE_BET,
    label: '面对 3Bet 弃牌率',
    street: 'PREFLOP',
    opportunityRule: '**我做过开池加注**，且之后有人对我 3Bet（没遇到 3Bet 不算机会）',
    successRule: '我弃牌',
    prior: HEURISTIC(0.55, 25, '面对 3Bet 的弃牌率中心约 55%'),
  },
  [PlayerMetric.CALL_THREE_BET]: {
    metric: PlayerMetric.CALL_THREE_BET,
    label: '面对 3Bet 跟注率',
    street: 'PREFLOP',
    opportunityRule: '我做过开池加注，且之后有人对我 3Bet',
    successRule: '我跟注（不含 4Bet）',
    prior: HEURISTIC(0.35, 25, '面对 3Bet 的跟注率中心约 35%'),
  },
  [PlayerMetric.CBET]: {
    metric: PlayerMetric.CBET,
    label: '翻牌持续下注率',
    street: 'FLOP',
    opportunityRule: '**我在翻牌前是最后一位加注者**，且翻牌后轮到我行动',
    successRule: '我下注',
    prior: HEURISTIC(0.6, 30, '持续下注率中心约 60%'),
  },
  [PlayerMetric.FOLD_TO_CBET]: {
    metric: PlayerMetric.FOLD_TO_CBET,
    label: '面对持续下注弃牌率',
    street: 'FLOP',
    opportunityRule: '翻牌后**对手在我之前下注**（面对持续下注）',
    successRule: '我弃牌',
    prior: HEURISTIC(0.45, 25, '面对持续下注的弃牌率中心约 45%'),
  },
  [PlayerMetric.CALL_CBET]: {
    metric: PlayerMetric.CALL_CBET,
    label: '面对持续下注跟注率',
    street: 'FLOP',
    opportunityRule: '翻牌后对手在我之前下注',
    successRule: '我跟注',
    prior: HEURISTIC(0.4, 25, '面对持续下注的跟注率中心约 40%'),
  },
  [PlayerMetric.RAISE_CBET]: {
    metric: PlayerMetric.RAISE_CBET,
    label: '面对持续下注加注率',
    street: 'FLOP',
    opportunityRule: '翻牌后对手在我之前下注',
    successRule: '我加注或全下',
    prior: HEURISTIC(0.15, 25, '面对持续下注的加注率中心约 15%'),
  },
  [PlayerMetric.CHECK_RAISE_FLOP]: {
    metric: PlayerMetric.CHECK_RAISE_FLOP,
    label: '翻牌过牌加注率',
    street: 'FLOP',
    opportunityRule: '翻牌后**我先过牌**，且之后有人下注，再轮到我行动',
    successRule: '我加注',
    prior: HEURISTIC(0.1, 20, '过牌加注率中心约 10%'),
  },
  [PlayerMetric.TURN_BARREL]: {
    metric: PlayerMetric.TURN_BARREL,
    label: '转牌连续开火率',
    street: 'TURN',
    opportunityRule: '**我在翻牌下过注**，且转牌后轮到我行动',
    successRule: '我再次下注',
    prior: HEURISTIC(0.55, 25, '转牌连续开火率中心约 55%'),
  },
  [PlayerMetric.TURN_FOLD]: {
    metric: PlayerMetric.TURN_FOLD,
    label: '转牌弃牌率',
    street: 'TURN',
    opportunityRule: '转牌后对手在我之前下注',
    successRule: '我弃牌',
    prior: HEURISTIC(0.45, 25, '转牌面对下注的弃牌率中心约 45%'),
  },
  [PlayerMetric.TURN_RAISE]: {
    metric: PlayerMetric.TURN_RAISE,
    label: '转牌加注率',
    street: 'TURN',
    opportunityRule: '转牌后对手在我之前下注',
    successRule: '我加注或全下',
    prior: HEURISTIC(0.12, 20, '转牌加注率中心约 12%'),
  },
  [PlayerMetric.TURN_CHECK_RAISE]: {
    metric: PlayerMetric.TURN_CHECK_RAISE,
    label: '转牌过牌加注率',
    street: 'TURN',
    opportunityRule: '转牌后我先过牌，且之后有人下注，再轮到我行动',
    successRule: '我加注',
    prior: HEURISTIC(0.08, 20, '转牌过牌加注率中心约 8%'),
  },
  [PlayerMetric.RIVER_BET]: {
    metric: PlayerMetric.RIVER_BET,
    label: '河牌下注率',
    street: 'RIVER',
    opportunityRule: '河牌后轮到我行动，且当前无人下注',
    successRule: '我下注',
    prior: HEURISTIC(0.35, 25, '河牌在无人下注时的下注率中心约 35%'),
  },
  [PlayerMetric.RIVER_BARREL]: {
    metric: PlayerMetric.RIVER_BARREL,
    label: '河牌连续开火率',
    street: 'RIVER',
    opportunityRule: '**我在转牌下过注**，且河牌后轮到我行动且无人下注',
    successRule: '我再次下注',
    prior: HEURISTIC(0.5, 25, '河牌连续开火率中心约 50%'),
  },
  [PlayerMetric.RIVER_OVERBET]: {
    metric: PlayerMetric.RIVER_OVERBET,
    label: '河牌超池下注率',
    street: 'RIVER',
    opportunityRule: '河牌后轮到我行动且无人下注（与我是否超池无关）',
    successRule: '我下注且金额 > 底池',
    prior: HEURISTIC(0.08, 20, '超池下注很罕见，中心约 8%'),
  },
  [PlayerMetric.RIVER_CALL]: {
    metric: PlayerMetric.RIVER_CALL,
    label: '河牌跟注率',
    street: 'RIVER',
    opportunityRule: '河牌后对手在我之前下注',
    successRule: '我跟注',
    prior: HEURISTIC(0.4, 25, '河牌面对下注的跟注率中心约 40%'),
  },
  [PlayerMetric.RIVER_RAISE]: {
    metric: PlayerMetric.RIVER_RAISE,
    label: '河牌加注率',
    street: 'RIVER',
    opportunityRule: '河牌后对手在我之前下注',
    successRule: '我加注或全下',
    prior: HEURISTIC(0.1, 20, '河牌加注率中心约 10%'),
  },
  [PlayerMetric.RIVER_FOLD]: {
    metric: PlayerMetric.RIVER_FOLD,
    label: '河牌弃牌率',
    street: 'RIVER',
    opportunityRule: '河牌后对手在我之前下注',
    successRule: '我弃牌',
    prior: HEURISTIC(0.5, 25, '河牌面对下注的弃牌率中心约 50%'),
  },
  [PlayerMetric.RIVER_SHOWDOWN]: {
    metric: PlayerMetric.RIVER_SHOWDOWN,
    label: '摊牌率',
    street: 'RIVER',
    opportunityRule: '牌局走到了摊牌（至少两位玩家未弃牌）',
    successRule: '我进入摊牌',
    prior: HEURISTIC(0.5, 20, '进入摊牌的比例中心约 50%'),
  },
};

/* ============================================================
 * 指标统计
 * ============================================================ */

/**
 * 单项指标的统计。
 *
 * **必须同时保存分子与分母**（规范第十一节）——
 * 只存 `VPIP = 32%` 会让下游无法判断这个数字有多少证据支撑。
 */
export type MetricStat = {
  metric: PlayerMetric;
  /** 成功次数（分子） */
  successes: number;
  /** 机会次数（分母） */
  opportunities: number;
  /** 原始比率 = successes / opportunities；无机会时为 null */
  rawRate: number | null;
  /** 收缩后的比率（向先验收缩） */
  adjustedRate: number;
  /** 有效样本量（考虑时间衰减之后） */
  effectiveSampleSize: number;
  /** 可信度 0..1（由有效样本量与先验强度共同决定） */
  confidence: number;
  /** 使用的先验 */
  prior: MetricPrior;
  /** 统计涉及的最近一手序号（用于排序与增量窗口） */
  lastUpdatedSeq: number;
};

/** 空统计（尚未观察到任何机会） */
export function emptyMetricStat(metric: PlayerMetric): MetricStat {
  const definition = METRIC_DEFINITIONS[metric];
  return {
    metric,
    successes: 0,
    opportunities: 0,
    rawRate: null,
    adjustedRate: definition.prior.center,
    effectiveSampleSize: 0,
    confidence: 0,
    prior: definition.prior,
    lastUpdatedSeq: -1,
  };
}
