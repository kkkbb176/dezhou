/**
 * Alpha 决策引擎 —— 类型与常量
 *
 * ## 这个模块在端到端链中解决什么
 *
 * 定义「决策」这件事的
*完整词汇行
*：动作、分类、理由、诊断、上下文。
 *
 * ## 分层纪律（第一原则的可执行版本（
 *
 * ```
 * 合法状态 > 数学真值 > Range > Player Profile > Environment > Dynamic > Decision
 * ```
 *
 * 这不是一张加权表，而是**单向依赖**：上层永远不能修改下层事实。
 * 因此本文件的类型设计遵守三条：
 *
 * 1. `MathSnapshot` 的九项（底池 / 筹码 / 有效筹码 / 牌力 / SPR / 底池赔率 /
 *    所需权益 / 权益 / EV）**只由确定性的 Poker Core 计算**，
 *    策略层拿到的是一份**只读**数字。
 * 2. 候选动作**只能**来自 `legalActions`。类型上 `DecisionAction` 与
 *    `legalActions` 的元素同源，因此「输出非法动作」在决策层是**可检测**的。
 * 3. 置信度**不等于权益**：`confidence` 的构成里没有任何一项是胜率。
 */

import type { Card, Street } from '../../domain/types.ts';
import type { GameEnvironmentId } from '../../domain/knowledge/knowledge.types.ts';
import type { ProfileAdjustment } from '../../domain/player/playerClassifier.ts';
import type { PlayerLabel } from '../../domain/player/playerClassifier.ts';
import type { RangeMetrics, RangeSource } from '../../domain/range/range.types.ts';
import type { TendencyEvidence } from '../../domain/player/tendencyProvider.ts';
import type { BetDecisionFacts } from '../../domain/postflop/betResponse.ts';
import type { EnvironmentAdvice, PriorityVerdict } from '../../domain/environment/environmentAccess.ts';
import type { OpponentRangeFacts } from '../postflop/types.ts';
import type { QuickProfile } from '../../app/manualInput/manualInput.ts';
import type { PreflopIsoFacts } from '../../app/manualInput/limpIsolation.ts';
import type { MultiwayBetFacts } from '../../domain/postflop/betResponse.ts';
import type { RaiseResponseModelFacts } from '../../app/manualInput/raiseResponse.ts';

/* ============================================================
 * 动作
 * ============================================================ */

export const DecisionAction = {
  FOLD: 'FOLD',
  CHECK: 'CHECK',
  CALL: 'CALL',
  BET: 'BET',
  RAISE: 'RAISE',
  ALL_IN: 'ALL_IN',
} as const;
export type DecisionAction = (typeof DecisionAction)[keyof typeof DecisionAction];

export const ALL_DECISION_ACTIONS: readonly DecisionAction[] = Object.values(DecisionAction);

/**
 * 动作 → **i18n 词条键**。
 *
 * ⚠️ 刻意存**键**而不是中文：本文件属于领域层，而项目纪律是
 * 「领域层只返回码值，中文集中在 `zh-CN.ts`」（`domainCodes.ts` 首条注释）。
 * 界面与 ViewModel 用 `t(DECISION_ACTION_KEY[a])` 取中文。
 *
 * 它同时是**动态取词的类型安全桥**：`t()` 要求 `MessageKey`，
 * 而本映射的值被 `as const` 固定为字面量联合，因此 `t()` 调用能在编译期校验。
 */
export const DECISION_ACTION_KEY = {
  FOLD: 'action.FOLD',
  CHECK: 'action.CHECK',
  CALL: 'action.CALL',
  BET: 'action.BET',
  RAISE: 'action.RAISE',
  ALL_IN: 'action.ALL_IN',
} as const;

/**
 * 动作中文的**只读显示表**（供日志、诊断与 CLI 使用；这些场景不切换语言包）。
 *
 * 界面**必须**用 `t(DECISION_ACTION_KEY[...])` 以便支持未来语言包。
 * 本表的值必须与 `zh-CN.ts` 的 `action.*` 词条**逐字一致** ——
 * `test/alphaDecision.test.ts` 会断言这一点，防止两处漂移。
 */
export const DECISION_ACTION_ZH: Readonly<Record<DecisionAction, string>> = Object.freeze({
  FOLD: '弃牌',
  CHECK: '过牌',
  CALL: '跟注',
  BET: '下注',
  RAISE: '加注',
  ALL_IN: '全下',
});

/* ============================================================
 * 分类
 * ============================================================ */

/**
 * 决策分类。
 *
 * - `CLEAR`：数学上明确（EV 分离度大）→ 可以放心执行
 * - `MARGINAL`：接近临界（EV 差小 / 关键输入不确定）→ 执行但**降低金额敏感度**
 * - `INSUFFICIENT_INFORMATION`：**拒绝编答案** —— 关键输入缺失或塌缩
 *
 * ⚠️ 刻意**没有** `CONFIDENT_*` 这类含「自信程度」的分类：
 * 自信程度是 `confidence` 的职责，两者混在一起会让
 * 「信息不足但数学清晰」这种情形无处表达。
 */
export const DecisionClassification = {
  CLEAR: 'CLEAR',
  MARGINAL: 'MARGINAL',
  INSUFFICIENT_INFORMATION: 'INSUFFICIENT_INFORMATION',
} as const;
export type DecisionClassification =
  (typeof DecisionClassification)[keyof typeof DecisionClassification];

export const DECISION_CLASSIFICATION_ZH: Readonly<Record<DecisionClassification, string>> =
  Object.freeze({
    CLEAR: '明确决策',
    MARGINAL: '边缘决策',
    INSUFFICIENT_INFORMATION: '信息不足',
  });

/* ============================================================
 * 置信度
 * ============================================================ */

/**
 * 置信度分档（五档）。
 *
 * 🟡 **只有分档，没有「精确到小数点后两位的置信度」对外显示。**
 * 理由：`confidence` 是由多个**启发式**分量取最小值得到的，
 * 把它显示成 `0.73` 会伪造精度。内部保留数值用于比较与日志，
 * 界面只显示档位。
 */
export const ConfidenceBand = {
  HIGH: 'HIGH',
  MEDIUM_HIGH: 'MEDIUM_HIGH',
  MEDIUM: 'MEDIUM',
  MEDIUM_LOW: 'MEDIUM_LOW',
  LOW: 'LOW',
} as const;
export type ConfidenceBand = (typeof ConfidenceBand)[keyof typeof ConfidenceBand];

export const CONFIDENCE_BAND_ZH: Readonly<Record<ConfidenceBand, string>> = Object.freeze({
  HIGH: '高',
  MEDIUM_HIGH: '中高',
  MEDIUM: '中',
  MEDIUM_LOW: '中低',
  LOW: '低',
});

/** 数值 → 档位（阈值是**沟通刻度**，不是统计估计） */
export function confidenceBandOf(confidence: number): ConfidenceBand {
  const c = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
  if (c >= 0.8) return ConfidenceBand.HIGH;
  if (c >= 0.62) return ConfidenceBand.MEDIUM_HIGH;
  if (c >= 0.45) return ConfidenceBand.MEDIUM;
  if (c >= 0.28) return ConfidenceBand.MEDIUM_LOW;
  return ConfidenceBand.LOW;
}

/* ============================================================
 * 数学快照（**九项事实**，只由 Poker Core 计算）
 * ============================================================ */

/**
 * 数学事实快照。
 *
 * ## 这九项**永远**不得被策略层修改
 *
 * `pot` / `callCost` / `myRemainingStack` / `effectiveStack` / `spr` /
 * `potOdds` / `requiredEquity` / `heroEquity` / `callEV`
 *
 * 策略层拿到的是**已经算好的数字**。`Object.freeze` 由构建器保证，
 * 且有测试断言策略模块不导入任何赔率 / 权益计算函数。
 *
 * ## `heroEquity` 的科学状态（必须如实标注）
 *
 * `heroEquity` 不是「九项确定性事实」之一 —— 它是**依赖对手范围**的估计。
 * 因此它单独带 `equitySource`，明确区分「精确枚举」与「蒙特卡洛」，
 * 并把样本量与置信区间一起带出来。
 */
/**
 * 翻后事实包（见 `DecisionContext.postflopFacts`）。
 *
 * ⚠️ `opponentRangeFacts` 为 `null` 表示**算不出来**（范围缺失或牌面不足）——
 * 消费方必须按「未知」处理，**不得**当成 0。
 */
export type PostflopFacts = {
  /** 上一街的公共牌（翻牌时为空数组；用于跨街比较） */
  previousBoard: readonly Card[];
  /**
   * 🔴 **复合牌力结构**（TEST HAND MULTIWAY TURN FIX · 问题 2）：
   * 成手类别 + 听牌种类 + 四桶补牌审计（RAW / CLEAN / DISCOUNTED / DIRTY）。
   * 修复前只有单一角色标签（例如「听牌 强度 0.30」），连「已经成对」都看不出来。
   */
  handStructure?: {
    madeHandClass: string;
    openEnded: boolean;
    gutshot: boolean;
    flushDraw: boolean;
    structureLabel: string;
    rawOuts: number;
    cleanOuts: number;
    discountedOuts: number;
    dirtyOuts: number;
    doubleCounted: readonly string[];
    nonNutFlushDraw: boolean;
    notesZh: readonly string[];
  };
  /** 对手范围在当前牌面上的统计（`null` = 算不出来）—— **到达范围**口径 */
  opponentRangeFacts: OpponentRangeFacts | null;
  /**
   * 🔴 **TEST 09 P0-1：BET RANGE —— 他的**下注**范围**。
   *
   * 与 `opponentRangeFacts`（**到达**范围）**并列但不同义**（§十九）：
   *
   * | 字段 | 回答的问题 |
   * |---|---|
   * | `opponentRangeFacts` | 他走到这个节点**拥有**什么 |
   * | `bettingRangeFacts` | 他在这里实际**选择下注**的是哪些牌 |
   *
   * 两者都保留：前者是「我领先他的整体范围吗」，后者是
   * 「跟这一注划不划算」。`null` = 当前不是「他在下注」的节点。
   */
  bettingRangeFacts?: BettingRangeFactsSnapshot | null;
  /** 尺寸口径（`actualRatio` / `modeledRatio` / `SIZE_APPROXIMATION`） */
  betRangeSizing?: {
    readonly actualBetChips: number;
    readonly potChips: number;
    readonly actualRatio: number;
    readonly modeledRatio: number;
    readonly sizeApproximation: boolean;
  } | null;
  /** 与 `opponentRangeFacts` 同名的量，但取自**下注范围** */
  heroEquityVsBetRange?: number | null;
  /**
   * 🔴 **U1：面对加注的响应 + 加注 EV**（`reports/UNCERTAINTY_REGISTER.md`）。
   *
   * 不 `bettingRangeFacts` 并列但回答
*另一个
*条件概率，
   * 「他下注了，他会跟我的加注吗」。`null` = 不可得（不是 0）。
   */
  raiseResponse?: {
    readonly sizeChips: number;
    readonly sizeBB: number;
    readonly raiseIncrement: number;
    /** 🔴 U1 P0：资金口径契约（规 `RaiseResponseModelFacts.cashflowContract`（
*/
    readonly cashflowContract: string;
    readonly currentPot: number;
    readonly heroStreetCommitted: number;
    readonly villainStreetCommitted: number;
    readonly heroAdd: number;
    readonly villainAdd: number;
    /** 对手**本来需要
*补的筹码（未封顶）；`villainAdd < villainAddRaw` ⇒ 他跟平即全下 */
    readonly villainAddRaw: number;
    /** 🔴 P1-2a：他跟平即投入 ⇒ 不会再有再加注分支（不 `heroIsAllIn` 是两个独立判据） */
    readonly villainIsAllInByCall: boolean;
    /* 🔴 P1-2b：被再加注分支（Hero 的 FOLD / CALL 两选一，零点 = 首次加注前） */
    readonly reraiseBranchEV: number;
    readonly reraiseBranchKind: 'FOLD' | 'CALL' | 'LOWER_BOUND_NOT_IMPLEMENTED';
    readonly reraiseFoldBranchEV: number;
    readonly reraiseCallBranchEV: number | null;
    readonly heroEquityVsReraiseRange: number | null;
    readonly reraiseBranchUnsupportedZh: string | null;
    readonly reRaiseTo?: number;
    readonly reRaiseMinLegalTo?: number;
    readonly villainReRaiseIsAllIn?: boolean;
    readonly heroAdditionalCallVsReRaise?: number;
    readonly finalPotAfterCallVsReRaise?: number;
    readonly reRaiseCombos?: number;
    readonly heroFourBetSupported?: boolean | null;
    readonly heroContestedAdd: number;
    readonly finalPot: number;
    readonly uncalledReturn: number;
    readonly foldLikelihood: number;
    readonly callLikelihood: number;
    readonly reRaiseLikelihood: number;
    readonly heroEquityVsRaiseCallRange: number | null;
    readonly equityMethod: string;
    readonly equityIterations: number;
    readonly raiseEV: number | null;
    readonly evKind: string;
    readonly reachableCombos: number;
    readonly callCombos: number;
    readonly assumptionsZh: readonly string[];
    readonly model: RaiseResponseModelFacts;
    readonly noteZh: string;
  } | null;
  /**
   * 🔴 **RIVER BET RANGE V2：真正的「河牌下注前到达范围」
*。
   *
   * ## 为什么必须单制
   *
   * `opponentRangeFacts` 取自 `primaryBuild.range` —— 那份范围**已经包含
   * 当前这一次下注的似然**（`applyLikelihoodUpdates` 对本街最后一个进攻动作
   * 同样施加似然）。因此它**不是**到达范围，把它当到达范围去乘件
   * `P(BET|手牌)` 就是**同一条动作计两次费
*。
   *
   * 本字段承转
*同一条范围更新链在「当前下注之前」的状态
*：
   *
   * | 重 | 回答 |
   * |---|---|
   * | `betRangeArrival.heroEquityVsArrivalRange` | 他
*到达**时我领先多少 |
   * | `heroEquityVsBetRange` | 他
*选择下注**时我领先多少（CALL EV 用它） |
   *
   * 可证伪性：**只改当前下注的尺寸，本字段必须逐位不变**（它不知道尺寸）。
   * `null` = 不是「他在下注」的节点。
   */
  betRangeArrival?: {
    readonly heroEquityVsArrivalRange: number | null;
    readonly supportCount: number;
    readonly arrivalMass: number | null;
    /** 到达范围的公共强度带质量（与下注范围同一把尺子） */
    readonly bandMasses: Readonly<Record<string, number>> | null;
    /** 被排除出到达范围的那一条动作（中文说明；`null` = 未定位） */
    readonly excludedActionZh: string | null;
    readonly noteZh: string;
  } | null;
  /**
   * 🔴 **下注决策事实化
*（BET DECISION ENGINE PHASE 1）。
   *
   * 含：每个下注尺寸的 fold / call / raise 概率 + 三个条件范围
   * （组合集不变、权重重新归一化）+ 对跟注/加注范围的权益 +
   * Hero 自身听牌潜力 + 权益实现因子。
   *
   * ⚠️ 必须由 `contextBuilder` 计算：决策层拿不到 `Range` 对象
   *（与 `opponentRangeFacts` 同一条架构纪律）。`null` = 算不出来（翻前 / 无范围）。
   */
  betDecision: BetDecisionFacts | null;
};

/** `bettingRangeFacts` 的可序列化快照（与 `bettingRange.ts` 同形，此处避免循环依赖） */
export type BettingRangeFactsSnapshot = {
  readonly classMasses: Readonly<Record<string, number>>;
  /**
   * 🔴 **公共强度带质量
*（RIVER BET RANGE V2）——
   * 不 `classMasses`（相对 Hero）
*仅供解释**）不同，这一组是**公共信息**口径）
   * 它才是权重实际依据的那把尺子，因此到达 vs 下注的对比必须用它。
   */
  readonly bandMasses?: {
    readonly arrival: Readonly<Record<string, number>>;
  readonly bet: Readonly<Record<string, number>>;
  };
  /** 每个公共强度带的 `P(BET | band)`（审计用）
*/
  readonly bandRates?: Readonly<Record<string, number>>;
  /** 权重模型的身份与不确定性（结构性先验，未校准） */
  readonly model?: Readonly<Record<string, unknown>>;
  readonly arrivalMass: number;
  readonly betMass: number;
  readonly betShareOfArrival: number;
  readonly entryCount: number;
  /** 等效组合数（软权重下 `entryCount` 恒等于到达支持集，宽度看这一个） */
  readonly effectiveComboCount?: number | null;
  /** 承载 90% 下注质量所需的最少组合数 */
  readonly posteriorMassCombos90?: number | null;
  readonly noteZh: string;
};

/**
 * 🔴 **翻后决策快照**（2026-09 翻后升级 · P3）。
 *
 * 使用者第二十三节要求「内部保留完整数据，前端只显示
 * **推荐动作 / 推荐尺度 / 主要原因 / 风险 / 置信度**」。
 * 本类型就是那个「内部完整数据」：全部字段都是**可序列化的纯数据**，
 * 且 **`evRanking` 明确是启发式比较分，不是 solver EV**（见 `evScore.ts`）。
 *
 * ⚠️ `confidence` 的语义是 **「首选动作比第二选择好多少」**，与「牌有多强」无关。
 * 它与 `AlphaDecision.confidence`（由输入完整度/范围可信度等**最小值**决定）
 * 是两件事，因此**分开存放、分开显示**。
 */
export type PostflopDecisionSnapshot = {
  /**
   * 🔴 **成交牌型**（`MadeHandClass`）—— 「我手里是什么」，与 `handRole` 是**两个问题**。
   *
   * RIVER CONSISTENCY V2.1 · P0-1：修复前一手**中对**被归类为 `AIR`
   *（因为「抓诈唬权益不够」），而 AIR 的定义是「什么都赢不了」。
   * 现在两者分字段存放，并有不变量：河牌上 `madeHand !== HIGH_CARD ⇒ role !== AIR`
   *（除非可达范围里确实没有任何更差的组合）。
   */
  madeHand: string;
  madeHandZh: string;
  /** 相对牌力角色（10 类） */
  handRole: string;
  handRoleZh: string;
  /**
   * 🔴 **上一街的角色**（历史参考；没有上一街时为 null）。
   *
   * 使用者的原话（RIVER CONSISTENCY V2 §3）：可以保存「Hero 在转牌曾经是听牌」，
   * 但**当前街角色**必须重新根据最终五张公共牌与两张手牌确定。
   * 两者是不同的问题 ⇒ 分两个字段。河牌的 `handRole` 永远不会是 DRAW/SEMI_BLUFF。
   */
  previousHandRole: string | null;
  previousHandRoleZh: string | null;
  /** 角色强度刻度（0..1，仅用于比较） */
  roleStrength: number;
  /** 跨街角色迁移原因（中文；首次判定时为 null） */
  roleChangeReasonZh: string | null;
  /** 牌面变化（数值，非布尔 —— 见 `BoardDelta`） */
  boardDelta: Readonly<Record<string, number | boolean | null>> | null;
  /** 对手范围压缩状态 */
  rangeCompression: Readonly<Record<string, number>>;
  /** 价值守门器结论 */
  valueAssessment: Readonly<Record<string, string | number | boolean>>;
  /**
   * 🔴 **未来补牌保护分**（河牌恒为 0）。
   *
   * 定义严格限定为「通过下注迫使对手放弃**仍有未来改善权益**的牌」；
   * 它与价值 / 诈唬 / 弃牌率是**四件不同的事**（使用者 §12），因此单独成字段，
   * 不用一个 `protectionEV` 把四件事一起清零。
   */
  futureCardProtectionScore: number;
  /** 摊牌价值 / 诈唬潜力（0..1；**启发式比较分**，不是概率） */
  showdownValue: number;
  protectionValue: number;
  bluffPotential: number;
  /** 画像偏移说明（未发生偏移时为 null） */
  exploitAdjustmentZh: string | null;
  /** 动作偏好顺序（启发式比较分，**不是** solver EV） */
  /**
   * 动作偏好顺序（启发式比较分，**不是** EV）。
   *
   * 🔴 TEST HAND MULTIWAY TURN FIX · 问题 4：每项都带 `kind`：
   * - `EV_SUPPORTED`：这个动作有可计算的 EV（弃牌 ≡ 0、跟注/过牌由权益推出），
   *   分数之间**可以**互相比较；
   * - `STRATEGIC_CANDIDATE_ONLY`：这个动作**没有** EV（NOT_AVAILABLE），
   *   分数只是启发式偏好分，**不得**被读成概率或 EV，也不得与上面那组排序。
   * 修复前两者混在一个数组里，界面直接显示 0.623 / 0.377 / 0.365 ⇒ 语义冲突。
   */
  evRanking: readonly { action: string; score: number; kind: string; noteZh: string }[];
  /** 本次判定用的是哪一套指标（使用者 §8） */
  metricKind: string;
  /**
   * 🔴 **真实 EV 排名**（RIVER CONSISTENCY V2.1 · P0-2）。
   *
   * 「谁更高」是确定的（节点增量口径，弃牌 EV ≡ 0），与「差距是否落在
   * 工程容差带内」是两件事。界面必须显示这个排名，不允许用
   * 「数学上没有明显优劣」把负 EV 说成无差异。
   */
  trueEvRanking: readonly { action: string; evChips: number | null; noteZh: string }[];
  /** 模型容差带（筹码）—— **工程容差**，不是统计误差 */
  uncertaintyBandChips: number;
  /** 容差带来源公式（必须能说清，例如 `MODEL_UNCERTAINTY_RATIO × winnable`） */
  uncertaintyBandFormulaZh: string;
  /** 是否显式开启了「不确定性覆盖」（默认关闭） */
  allowUncertaintyOverride: boolean;
  /**
   * 🔴 **本次动作的决策依据**（使用者 §8/§15）：
   * `CHIP_EV` / `PREFERENCE_SCORE` / `MATH_INDIFFERENCE` /
   * `MODEL_UNCERTAINTY_OVERRIDE` / `SAFETY_RULE` / `NO_ACTION`。
   *
   * 界面据此说明「偏好顺序是不是本次的依据」—— 否则会出现
   * 「偏好顺序 FOLD 0.51 > CALL 0.49」配「建议：跟注」这种看起来矛盾、
   * 实际是两种指标的输出。
   */
  decisionBasisKind: string;
  decisionBasisNoteZh: string;
  /**
   * 🔴 **可达范围的逐组合计数**（V2.1 · P1-1）：
   * 「比 Hero 强/弱」是【数学确定】的强弱比较，**不等于**「会下注取值/会诈唬」。
   *
   * ⚠️ 这些是**未加权的组合数**；`valueAssessment` 里的 `weakerShare` 等是
   * **概率质量占比**（同一分母）。两者回答不同的问题，界面上必须分列。
   */
  rangeCounts: Readonly<Record<string, number | string>> | null;
  /**
   * 🔴 **下注决策（每个尺寸独立）**（BET DECISION ENGINE PHASE 1）。
   *
   * 含每个尺寸的 `P(弃)/P(跟)/P(加)`、对**条件范围**的权益、三分支 EV、
   * BetEV、归一化偏好分，以及 Hero 听牌、权益实现因子与画像证据归属。
   *
   * ⚠️ 里面的 EV 是**启发式代理 EV**（未来街用权益实现因子近似），
   * 不是 Solver EV；证据等级在 `evidence` 里逐项标出。
   * 拿不到响应模型（翻前 / 无范围 / 面对下注）时为 `null`。
   */
  betDecision: Readonly<Record<string, unknown>> | null;
  /**
   * 🔴 **RIVER BET RANGE V2**：真正的「当前下注之前到达范围」快照。
   *
   * 不 `context.postflopFacts.betRangeArrival` **同源**（只做取值搬运，
   * 不做二次计算 —— 否则界面显示的就不再是参与判断的那份数据）。
   * `null` = 不是「他在下注」的节点。
   */
  betRangeArrival?: {
    readonly heroEquityVsArrivalRange: number | null;
    readonly supportCount: number;
    readonly bandMasses: Readonly<Record<string, number>> | null;
    readonly excludedActionZh: string | null;
    readonly noteZh: string;
  } | null;
  /** 下注范围（BET RANGE）的类别/牌型质量与权重模型（同源搬运）
*/
  bettingRangeFacts?: BettingRangeFactsSnapshot | null;
  /**
   * 可达范围的
*组合数
*（占比的分母）。没有范围数据时不 null。
   * 使用者 §14：是概率就必须给分母。
   */
  reachableComboCount: number | null;
  evScoreDisclaimerZh: string;
  /** 「首选比次选好多少」的置信度 */
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  confidenceGap: number;
  /** SPR 承诺评估 */
  commitment: Readonly<Record<string, string | number | boolean | null>>;
  /** 阻断牌评估 */
  blockers: Readonly<Record<string, string | number>>;
};

export type MathSnapshot = {
  street: Street;
  /** 当前底池（筹码单位，由行动记录重算） */
  pot: number;
  /** 我需要投入多少才能跟注 */
  callCost: number;
  /** 我的剩余筹码 */
  myRemainingStack: number;
  /** 有效筹码（我与对手中较小者） */
  effectiveStack: number;
  /** 我的本街已投入 */
  myCommittedThisStreet: number;
  /** 底池筹码比；底池为 0 时为 null（不是 NaN） */
  spr: number | null;
  /** 底池赔率（投入 / 可赢得总量） */
  potOdds: number;
  /** 跟注所需的最低权益 */
  requiredEquity: number;
  /**
   * 🔴 **`requiredEquity` 这个数是不是「单层胜率门槛」**（2026-09 多人边池修复）。
   *
   * - `true`：我只能争一层（主池）。此时 `权益 ≥ 所需权益` ⇔ 跟注 EV ≥ 0，
   *   门槛就是真实的盈亏平衡胜率。
   * - `false`：我**既争主池、又争边池** —— 两层的胜负条件不同
   *   （主池要赢所有人、边池只要赢同层的人）。此时门槛仍然给数（供显示与
   *   指纹比对），但**「权益低于门槛」不足以判定负期望**：单一门槛算出的
   *   EV 是本局面的**下界**，据此弃牌会系统性地弃掉本该跟的牌。
   *
   * ⚠️ 它由 `pots.previewCommit` 判定（有资格的层数 > 1 ⇒ false），
   * 属于**口径标记**，不是「九项事实」之一。
   */
  requiredEquityApplies?: boolean;
  /**
   * 🔴 **跟注之后我能争夺到的总量**（2026-09 多层权益轮补入）。
   *
   * 它等于 `previewCommit(state, 我, callCost).winnable`，也就是
   * **各层金额之和**（层额已含我这次跟注的钱）。三条用途：
   *
   * | 用途 | 说明 |
   * |---|---|
   * | 门槛的分母 | `requiredEquity = callCost / winnable` |
   * | EV 的基数 | `callEV = 权益 × winnable − callCost` |
   * | 判据的标尺 | 单层 `edge = callEV / winnable`，多层也必须除以它 |
   *
   * ⚠️ 它与 `pot` **不是**同一个数，差额是「永远不会被争夺的筹码」
   *（对手跟不起的超额下注）。`POT-14` 里 `pot = 4150` 而 `winnable = 7050`
   *（我跟注 2900 后对手那笔钱才被激活）—— 拿 `pot` 当 EV 的分母/基数
   * 都会得到错误的量纲。
   */
  winnable: number;
  /**
   * 🔴 **分层权益的真实跟注 EV**（2026-09 多层权益轮）。
   *
   * ## 为什么必须有它
   *
   * `requiredEquityApplies === false` 时，「权益 ÷ 单一门槛」算出的 EV 只是
   * **下界**，据此弃牌会系统性地弃掉本该跟的牌 —— 实测有一手
   * 真实 EV = **+1764** 的牌被判成「跟注是负期望」。
   *
   * 正确的算法是**逐层算胜率**，且**层必须取自「跟注之后」的预览**
   *（`previewCommit`，与 `winnable` 同源）—— 决策时刻的层会把
   *「我还没跟注」误当成「对手那笔钱不会被争」：
   *
   * ```text
   * 预览 = previewCommit(state, 我, 跟注额)
   * 对 预览.layersForPlayer 的每一层 j：
   *   该层对手 = 该层 eligibleIds − 我，且必须已实现（有范围）
   *   胜率_j   = computeHeroEquity(我, 牌面, 该层对手)
   * EV = Σ_j (胜率_j × 层额_j) − 跟注额        （层额已含我在这层里的钱）
   * 恒等式：Σ_j 层额_j === winnable === previewCommit(...).winnable
   * ```
   *
   * 实测（`POT-14`：UTG 短码全下、BTN 全下、我 BB 需跟 2900）：
   *
   * | 层 | 层额 | 该层对手 | 胜率 |
   * |---|---|---|---|
   * | 主池 | 3050 | UTG + BTN | 72.0%（= 整池权益） |
   * | 边池 | 4000 | 仅 BTN | **84.2%**（反解自实测 EV） |
   *
   * ⇒ 分层 EV = **+2664**，而门槛口径的下界是 +2176、**决策时刻分层**的错误
   * 口径是 **−1352**（把一手必须跟的牌判成弃牌）。
   *
   * ## 字段含义
   *
   * | 字段 | 含义 |
   * |---|---|
   * | `exact` | `true` ⇒ 每一层都拿到了对手范围，`value` 可用于判方向 |
   * | `value` | 精确分层 EV（`exact` 时）或**保守下界**（否则） |
   * | `lowerBound` / `upperBound` | 同一口径下的区间：未知层的贡献分别按 0 / 按 1 计 |
   * | `layerCount` | 我有资格争夺的层数（= `layersForPlayer.length`） |
   * | `costMs` | 这次分层计算花掉的毫秒数（实测 90–300 ms） |
   *
   * ⚠️ `exact === false` 时**不得**用 `value` 判定方向 —— 那正是修复前
   * 那类系统性错误。此时应回落「不给方向」（或按可证明的下界给保守建议）。
   *
   * ⚠️ 它是**逐层蒙特卡洛估计**，不是无损真值；判方向时用与单层相同的
   * ±`MARGINAL_EV_GAP_RATIO` 带，而不是「EV < 0 即硬判」。
   *
   * ⚠️ `exact === false` 时 `value` 与 `callEV` **不是同一个数**，两者都是
   * 真值的**下界**、只是口径不同（`value` = 逐层口径：未知层按 0 计；
   * `callEV` = 门槛口径：`权益 × winnable − 跟注额`）。同一响应里能看到
   * 两个数，**都不用于判方向**（分层算不准时决策层不给方向）。
   *
   * ⚠️ `exact` 只表示「每一层都拿到了对手范围」，**不表示计算方式**：
   * 逐层调用 `computeHeroEquity`，各层可能一层走精确枚举、另一层走蒙特卡洛
   *（迭代数按该层对手数分档）。诊断区目前不区分这两件事。
   */
  layeredEV?: {
    exact: boolean;
    value: number;
    lowerBound: number;
    upperBound: number;
    layerCount: number;
    costMs: number;
  };
  /** 权益估计（依赖对手范围）——**到达范围**口径 */
  heroEquity: number | null;
  /**
   * 🔴 **TEST 09 P0-1**：`Hero vs Villain **下注范围**` 的权益。
   *
   * 与 `heroEquity`（到达范围）是**两个不同的量**，刻意分开保存（§八）：
   *
   * | 字段 | 回答的问题 |
   * |---|---|
   * | `heroEquity` | 我领先他走到这个节点的**整体范围**吗 |
   * | `heroEquityVsBetRange` | 跟**这一注**划不划算 |
   *
   * `callEV` 在「面对已下注」节点用的是**本字段**。`null` 表示
   * 该节点不适用（不是面对下注 / 算不出下注范围）——不是 0。
   */
  heroEquityVsBetRange: number | null;
  /** 权益的来源与精度 */
  equitySource: EquitySource | null;
  /** 跟注的期望收益（筹码单位） */
  callEV: number | null;
  /** 我的当前牌力（中文，来自 handDescription） */
  handRankZh: string;
  /** 牌力类别序号 1..9 */
  handCategory: number;
  /** 大盲（筹码单位），用于把金额换算成 BB 显示 */
  bigBlind: number;
  /**
   * 🔴 抽水模型状态。
   *
   * 本项目**没有** Rake Engine，因此一律为 `NOT_APPLIED`：
   * 所有 EV 都是**未计抽水**的。界面与诊断必须显示这一点 ——
   * 否则使用者会把「+0.3BB 的跟注」当成长期精确期望。
   */
  rakeModel: 'NOT_APPLIED';
};

export type EquitySource = {
  method: 'EXACT' | 'MONTE_CARLO';
  /** 枚举局数或抽样次数 */
  iterations: number;
  /** 蒙特卡洛的 95% 半宽；精确枚举为 0 */
  confidenceHalfWidth: number;
  /** 是否因时间预算从精确枚举降级 */
  downgradedFromExact: boolean;
};

/* ============================================================
 * 范围快照
 * ============================================================ */

/**
 * 对手范围快照。
 *
 * ## ⚠️ 「范围」是**估计**，不是事实
 *
 * 因此它携带 `sourceKind` / `confidence` / `metrics`，
 * 且**允许为空**（`supportSize === 0` 表示范围塌缩 → 决策必须返回信息不足，
 * **绝不**自动补一个均匀范围）。
 */
export type RangeSnapshot = {
  /** 范围针对的对手（玩家 id） */
  opponentId: string;
  /** 对手位置（中文） */
  opponentPositionZh: string;
  /**
   * **来源标识**（结构化，例如 `solver.preflop-range.92c86ed` /
   * `heuristic.preflop-rfi.v1`）。
   *
   * 🔴 为什么需要它：`sourceKind` **区分不出**「求解器范围」与「经验数据」——
   * 前者刻意用 `EMPIRICAL`（不用 `THEORY_SOURCE`，因为翻前是**近似模型**，
   * 标成理论来源会抬高它），而两者在 `sourceKind` 上完全一样。
   *
   * 界面要回答「这份范围是不是算出来的」时**必须**读这个字段，
   * 不能读 `sourceKind`、更不能在中文描述里搜字符串 ——
   * 启发式的描述里写着「**非**求解器输出」，搜它会命中，
   * 把猜的判成算的（这个坑真的踩过）。
   */
  sourceId: string;
  /** 范围来源（HEURISTIC / VERIFIED_DATA …） */
  sourceKind: RangeSource;
  /** 来源说明（中文） */
  sourceDescription: string;
  /** 范围可信度 0..1 */
  confidence: number;
  /** 有效组合数（扣除已知牌后） */
  supportSize: number;
  /** 组合占比（相对 1326） */
  supportShare: number;
  /** 范围指标（熵 / 有效组合数等），用于「塌缩 / 过宽」判断 */
  metrics: RangeMetrics;
  /**
   * 是否发生**范围塌缩**（0 个合法组合）。
   *
   * 为 `true` 时决策**必须**返回 `INSUFFICIENT_INFORMATION`，
   * 禁止自动补均匀范围（规范第 84 节）。
   */
  collapsed: boolean;
  /** 范围更新日志摘要（每步行动后范围如何变化，可追溯） */
  updateTrace: readonly RangeUpdateTraceEntry[];
};

export type RangeUpdateTraceEntry = {
  street: Street;
  action: string;
  actorPositionZh: string;
  supportBefore: number;
  supportAfter: number;
  entropyBefore: number;
  entropyAfter: number;
  /**
   * 本条目的一条中文说明（可选）。
   *
   * 目前由**河牌画像似然**写入：说明这条动作是否启用了画像感知似然、
   * 以及**为什么回落**（节点上下文不足 / 组合无法如实分类 /
   * 或已抑制倾斜通道以免画像计两次）。规范第 43 节要求
   * 「画像到没到范围」必须可调试 —— 静默降级不算可调试。
   */
  noteZh?: string;
};

/* ============================================================
 * 玩家 / 环境 / 动态
 * ============================================================ */

export type PlayerSnapshot = {
  playerId: string;
  label: PlayerLabel;
  labelZh: string;
  /**
   * 🔴 **用户手选的定性画像**（2026-09 翻后升级 · P2 补入）。
   *
   * | 字段 | 来源 | 性质 |
   * |---|---|---|
   * | `label` | 实测数据（`playerClassifier`） | **证据** |
   * | `quickProfile` | 用户在界面上选的 | **主观判断**，可信度受 `QUICK_PROFILE_CONFIDENCE` 上限约束 |
   *
   * ⚠️ 修复前这个输入**根本没有传到决策层**：它只影响 `confidence` 与 `note`，
   * 而 `label` 仍是数据算出来的（无数据时就是 UNKNOWN）。于是「用户说是跟注站」
   * 这件事在决策里完全不起作用 —— 实测「跟注站 vs 极紧」给出**逐位相同**的建议。
   *
   * 消费纪律（`exploit.ts` 的分层）：证据优先，主观画像兜底，
   * 且**偏移幅度按来源的可信度缩放** —— 小样本/主观画像不得导致过度剥削。
   */
  quickProfile: QuickProfile | null;
  /** 画像可信度（0 = 无数据） */
  confidence: number;
  /** 已观测手数 */
  handsObserved: number;
  /**
   * 🔴 **PLAYER PROFILE EXPLOIT V1：本次决策真正使用的实测统计披露**。
   *
   * 与 `handsObserved`（来自 `PlayerProfile` 手日志）**不是一回事**：
   * 真实历史走的是 `villain.observedStats` 通道（扁平静态统计），
   * 它不构造成手日志（**绝不为补齐统计虚构玩家历史**）。
   *
   * | 字段 | 含义 |
   * |---|---|
   * | `handsObserved` | 该玩家累计被记录的真实手数（来自历史存储） |
   * | `usedStatKeys` | **本次真正进入模型**的统计项（其余项没有输入通道） |
   * | `noteZh` | 中文披露：样本量 / 有效机会数 / 哪几项接入 / 哪些未接入 |
   */
  measuredStats?: {
    readonly handsObserved: number;
    readonly usedStatKeys: readonly string[];
    readonly noteZh: string;
  };
  /** 调整因子（**只影响概率**，不含任何动作） */
  adjustment: ProfileAdjustment;
  /** 中文说明 */
  note: string;
  /** 该玩家的范围调整是否因样本不足而被中和 */
  neutralized: boolean;
};

export type EnvironmentSnapshot = {
  environment: GameEnvironmentId;
  /** 中文名 */
  labelZh: string;
  /** 方向建议（**无幅度**） */
  advice: readonly EnvironmentAdvice[];
  /** 因目标未映射而未生效的规则 */
  unmappedTargets: readonly { ruleId: string; target: string }[];
  /** 因街道不匹配而未采用的规则 */
  skippedByStreet: readonly { ruleId: string; ruleStreet: string }[];
  /** 个体数据 vs 环境先验的裁决结果 */
  priority: PriorityVerdict;
  /** 是否有规则带幅度（**必须为 false**；为 true 说明知识层出了纪律问题） */
  anyMagnitudePresent: boolean;
};

export type DynamicSnapshot = {
  /** 是否实际计算了 Dynamic（无事件时为 false） */
  computed: boolean;
  /** 0..100 */
  deviationScore: number;
  state: string;
  stateProvenance: string;
  /** Dynamic 自身的置信度（**不是**决策置信度） */
  confidence: number;
  /** 倾斜概率（永远是概率，不是布尔） */
  tiltProbability: number;
  /** 方向调整的适配结果（幅度一律标 UNVERIFIED_MAGNITUDE） */
  adapted: readonly {
    target: string;
    direction: string;
    multiplier: number;
    magnitudeProvenance: string;
    conflicting: boolean;
  }[];
  /** 中文解释 */
  explanation: readonly string[];
  /** Dynamic 是否被采用（Shadow 阶段可能不采用） */
  applied: boolean;
};

/* ============================================================
 * 画像进入范围链路的证据（P0 架构修复）
 * ============================================================ */

/**
 * 🔴 **画像 / 近期倾向进入 action-conditioned range 的证据**。
 *
 * ## 为什么必须存在这个结构
 *
 * 使用者点名的缺陷是「画像没有进入范围与权益主链，只在末端当偏好修正」。
 * 一个**结构上的证据**是唯一能证明它被修好的东西：`equityBefore` 与
 * `equityAfter` 是同一手牌、同一牌面、同一随机种子下，
 * 范围在画像调整**前 / 后**对 Hero 的权益。
 *
 * - 两者**相等** ⇒ 画像没有进入主链（无论文案怎么写）
 * - 两者**不等** ⇒ 画像确实改变了权益，进而改变底池赔率比较与 Call EV
 */
export type ProfileRangeEvidence = {
  /** provider 侧证据（乘数摘要、是否被夹、中文说明） */
  provider: TendencyEvidence;
  /** 维度来源（实测 / 手选原型 / 加权合并 / 无证据） */
  dimensionTier: string;
  dimensionTierZh: string;
  dimensionNoteZh: string;
  /** 调整前后可达组合数（**必须相等**：只改概率，不产生/删除组合） */
  combosBefore: number;
  combosAfter: number;
  equityBefore: number | null;
  equityAfter: number | null;
  /** 权益变化（百分点） */
  equityDeltaPct: number | null;
};

/**
 * **决策边际**（与「模型置信度」是两件事）。
 *
 * | 量 | 回答的问题 | 判据 |
 * |---|---|---|
 * | `DecisionMargin` | 这个决策离「翻面」有多远？ | 真实 EV 与 0 的距离 vs 工程容差带 |
 * | `ModelConfidence` | 首选比次选好多少？ | 偏好分差（`confidenceOf`） |
 *
 * 修复前只有后者，于是「CALL EV = −317.61 筹码、差 392 才算边缘」与
 * 「模型置信度 LOW」被混成一句话 —— 使用者无法区分
 * 「数学上差得很远」与「模型自己不确定」。
 */
export const DecisionMargin = {
  /** 明显该弃牌：EV 低于容差带下界 */
  CLEAR_FOLD: 'CLEAR_FOLD',
  /** 边缘：EV 落在工程容差带内（**不是**统计误差，是本项目的工程容差） */
  MARGINAL: 'MARGINAL',
  /**
   * 明显优于**弃牌**：EV 高于容差带上界。
   *
   * 🔴 名字里必须有 `OVER_FOLD`：这个结论的**证据只有「跟注 vs 弃牌」这一对**
   * （见 `DecisionMarginScope.VS_FOLD_ONLY`）。它**不能**推出
   * 「跟注优于其他所有动作」—— 加注从未被算过 EV。
   * 历史缺陷：把 `CLEAR_CALL` 当作全局最优证明，于是隔离加注被静默拦掉。
   */
  CLEAR_CALL_OVER_FOLD: 'CLEAR_CALL_OVER_FOLD',
} as const;
export type DecisionMargin = (typeof DecisionMargin)[keyof typeof DecisionMargin];

export const DECISION_MARGIN_ZH: Readonly<Record<DecisionMargin, string>> = Object.freeze({
  CLEAR_FOLD: '明显弃牌（真实 EV 明显低于 0）',
  MARGINAL: '边缘（真实 EV 落在工程容差带内）',
  CLEAR_CALL_OVER_FOLD: '明显优于弃牌（**仅**已证明 CALL > FOLD，未比较加注）',
});

/**
 * 容差结论的**作用域**（§1/§17）。
 *
 * ⚠️ 没有作用域的「明显」是**无权**越界拦截其他动作的。
 */
export const DecisionMarginScope = {
  /** 只与 FOLD 比较过；对加注/全下**没有**发言权 */
  VS_FOLD_ONLY: 'VS_FOLD_ONLY',
  /** 已在同一零点上与同层其他动作（含加注）比较过 */
  CROSS_ACTION: 'CROSS_ACTION',
  /** 本节点不是「跟注 vs 弃牌」决策（例如无人下注） */
  NONE: 'NONE',
} as const;
export type DecisionMarginScope = (typeof DecisionMarginScope)[keyof typeof DecisionMarginScope];

export type DecisionMarginFacts = {
  /** `null` = 本节点不是「跟注 vs 弃牌」决策（例如无人下注） */
  kind: DecisionMargin | null;
  kindZh: string;
  /** 这个结论**能覆盖到哪些动作**（缺省即 `NONE`，不可推断） */
  scope: DecisionMarginScope;
  /** 判据用的真实 EV（筹码）；拿不到时为 null */
  evChips: number | null;
  /** 工程容差带（筹码） */
  bandChips: number;
  noteZh: string;
};


/* ============================================================
 * 决策上下文
 * ============================================================ */

/**
 * 决策上下文 —— `buildDecisionContext()` 的产物。
 *
 * ## 本结果
*刻意**不含的东西（规范第 20 节）
 *
 * - 对手底牌（`villainHoleCards`（
 * - 结果（`result` / `winner` / `heroProfit`）
 * - 摊牌结果（`showdownOutcome`）
 *
 * 这不是「约定不读」，而是**类型里没有**：`DecisionContext` 的字段集
 * 被测试锁定，任何新增字段都必须显式经过审查。
 */
export type DecisionContext = {
  /** Hero 的牌 */
  heroCards: readonly Card[];
  /** 公共牌 */
  board: readonly Card[];
  /**
   * 本手**仍未弃牌**的对手数（含尚未行动的人）。
   *
   * ⚠️ 它**不是**「已经进池的对手数」。9 人桌 Hero 在 UTG 时它是 8 ——
   * 但那时还没有任何人表示要打这一手。要把「已实现」与「可能」分开，
   * 见 `realizedOpponentCount`。
   */
  activeOpponentCount: number;
  /**
   * **已实现**的对手数（Table Topology Correction）。
   *
   * = 未弃牌、且**已经主动投入过**（跟注 / 下注 / 加注）或已全下的对手数。
   *
   * ## 为什么必须与 `activeOpponentCount` 分开
   *
   * 「机会由牌局状态定义，绝不由玩家的动作定义」—— 这句话的反面同样成立：
   * **对手也由动作定义，不由座位定义**。
   *
   * 修复前决策层用 `activeOpponentCount >= 3` 当作「多人池」而拒绝。
   * 后果：Hero 在 UTG 时，后面 7 个人**还没轮到说话**，
   * 系统就已经认定「8 人池，超出能力」→ 满桌开池全部被拒。
   * 这不是谨慎，是把「未行动」当成了「已参战」。
   *
   * 现在：**是否拒绝**看 `realizedOpponentCount`（真的有人进来了吗），
   * **权益有多乐观**看 `activeOpponentCount`（还有多少人可能进来）。
   * 两件事，两个数字。
   */
  realizedOpponentCount: number;
  /**
   * 还没轮到说话的对手里，仍**未弃牌且还能行动**的人数。
   *
   * ⚠️ 他们**没有**进池、**没有**范围，因此不能计入权益 ——
   * 只用于如实提示「后面还有 N 个人可能跟进来，实际权益可能更低」。
   */
  playersYetToAct: number;
  /**
   * 🔴 **我行动之后还有几个对手必须行动**（TEST HAND MULTIWAY TURN FIX · 问题 3）。
   *
   * 取自引擎**自己的行动队列** `state.pendingQueue`（当前行动者之后的部分），
   * 因此「下注重新打开行动」自动被包含：一个已经过牌的玩家在有人下注后
   * **仍然要再表态**。
   *
   * ⚠️ 与 `playersYetToAct` 的区别：后者是「本街还没说过话的人」（信息不足提示用），
   * 前者是「我之后还要行动的人」（EV 口径与 closing action 用）。修复前两者被混为一谈，
   * 于是「UTG+1 过牌 → LJ 下注 → Hero」被写成「本街已无人待行动」。
   */
  playersRemainingToAct: number;
  /** 我这次跟注就是本街最后一次行动（= `playersRemainingToAct === 0`） */
  isClosingAction: boolean;
  math: MathSnapshot;
  /**
   * 🔴 **画像进入范围链路的证据**（P0 架构修复）。
   *
   * 只在「画像或近期倾向确实参与了范围调整」时存在 —— 没有画像的牌局
   * 不会凭空多出这个字段（信息缺失 ≠ 中性调整）。
   */
  profileRangeEvidence?: ProfileRangeEvidence;
  /**
   * 🔴 **画像是否真的改变了对手范围**（V2.1 去重闸门修复）。
   *
   * ## 为什么必须与 `profileRangeEvidence` 分开
   *
   * 去重闸门原先读 `profileRangeEvidence?.provider.applied === true`，
   * 而那**不等于**「画像改了范围」：
   *
   * | 通道 | `provider.applied` | 范围是否真的变了 |
   * |---|---|---|
   * | 倾向乘法通道 | true | 是 |
   * | **河牌统一似然通道**（provider 被主动抑制） | **false** | **是** |
   * | **跛入原型通道**（不经过 provider） | **false** | **是** |
   * | 画像挂在非首要对手身上 | 证据对象**缺失** | **是** |
   *
   * 三个反例都有实测（`reports/V21_REVIEW_3_PIPELINE.md` 的 A/B 洞与
   * `reports/V21_FAILURE_MODE_AUDIT.md` #12）：同一份「范围强度」证据
   * 会在权益层与 scorer 层**各计一次**。
   *
   * ⚠️ 因此本字段是**唯一**允许被去重闸门读取的依据；
   * 它缺失（`undefined`）时按 `false` 处理（与历史行为一致）。
   */
  profileAppliedToRange?: boolean;
  /**
   * 🔴 **翻后事实包**（2026-09 翻后升级 · P2）——翻前为 `undefined`。
   *
   * 它把「决策层需要、但只有范围层能算」的真相带上来：
   *
   * | 字段 | 谁算的 | 为什么不能放在决策层算 |
   * |---|---|---|
   * | `opponentRangeFacts` | `contextBuilder`（有 `Range` 对象） | 决策层只拿得到**快照**，拿不到逐组合概率 |
   * | `previousBoard` | `contextBuilder` | 上一街牌面 = 当前牌面的前缀；决策层只有最终牌面 |
   * | `street` 起止信息 | 同上 | — |
   *
   * ⚠️ 这些是**已算好的事实**，不是猜测：`opponentRangeFacts` 是对已知范围
   * 按当前牌面重新加权的统计（见 `rangeFacts.ts`）。
   */
  postflopFacts?: PostflopFacts;
  /**
   * **多人 limp 隔离加注**事实包（翻前专属，§2/§4–§8）。
   *
   * 只有「Hero 面对 ≥1 个跛入者、且尚无人加注」的翻前节点才有；
   * 其他节点为 `null` 或 `undefined`。
   *
   * 它带来三件决策层自己算不出来的东西：
   *
   * 1. 每个 limp 的**到达范围 / 跟注范围 / 再加注范围**（切分后的条件范围）；
   * 2. 对**跟注范围**（而不是到达范围）的权益 —— 加注只能拿这个当依据；
   * 3. 隔离加注的**独立代理 EV**（与 CALL 的代理 EV 同一零点 = 弃牌 0）。
   *
   * ⚠️ 没有这个包时，决策层**不允许**给隔离加注编造 EV。
   */
  preflopIso?: PreflopIsoFacts | null;
  /**
   * **首要对手**的范围快照（= 第一个已实现的对手）。
   *
   * 🔴 它**只用于展示与玩家画像**，**不再**是权益的依据 ——
   * 权益由 `opponentRanges`（全部已实现对手）算出，见该字段。
   */
  range: RangeSnapshot | null;
  /**
   * **全部已实现对手**的范围快照（权益就是按这些算的）。
   *
   * ## 为什么需要它（本轮修复的缺口）
   *
   * 修复前 `contextBuilder` 只把 `opponents[0]` 交给范围构建，权益因此是
   * **单挑口径**：5 家进池时底池赔率按 5 家算、权益却按 1 家算，
   * 结果系统性偏乐观。决策层为了不给出误导性建议，只好在
   * `realizedOpponentCount >= 3` 时**直接拒绝**。
   *
   * 但那条拒绝把工具在真实牌桌上废掉了：9 人桌现金局里
   * 「一家开池、几家跟注」是**常态**，一律拒答等于没有工具。
   *
   * 实测（同一手 AK 顶对，`scripts/__tmp-multiway-bench.ts` 的量级）：
   *
   * | 对手数 | 权益 |
   * |---|---|
   * | 1 | 87.1% |
   * | 3 | 67.3% |
   * | 5 | 53.8% |
   *
   * 差 33 个百分点 —— 足以让「跟注」变成「弃牌」。
   * 权益引擎**本来就支持多人**（`computeEquity` 的 `opponents` 是列表），
   * 缺的只是调用方没把对手传全。
   *
   * ⚠️ 顺序与 `realizedOpponents` 一致（按座位顺序）。
   */
  opponentRanges: readonly RangeSnapshot[];
  player: PlayerSnapshot | null;
  /**
   * 🔴 **PLAYER PROFILE V3**：在这一手实际生效的「标签 Prior + 实测统计」解析结果。
   *
   * 它在 `contextBuilder` 里算**一次**，同时供：
   * ① 响应层（分街系数）；② 诊断/界面（Profile Trace）。
   *
   * ⚠️ 严格可选：没有连续统计时它为 `undefined`，全部下游行为与 V2 **逐位一致**。
   */
  profileV3?: {
    baseArchetype: string | null;
    observedStatCount: number;
    confidenceTierZh: string;
    /**
     * 🔴 **TEST 08 P0-3**：当前决策点的**动作节点语义**。
     *
     * `FACING_CBET` / `FACING_DONK` / `GENERIC_BET`，或 `null`（本街尚无人下注）。
     * `FoldTo*CBet` 这类「面对持续下注」的统计**只**在 `FACING_CBET` 下生效。
     */
    actionContext?: 'FACING_CBET' | 'FACING_DONK' | 'GENERIC_BET' | null;
    /**
     * 🔴 **TEST 08 P0-3**：统计**给了但因节点语义不匹配而未生效**的分街条目。
     *
     * 非空表示「引擎刻意忽略了这些统计」——这是设计行为（避免证据错配），
     * 但必须可审计，否则会变成静默失效。
     */
    deniedStreetTraits?: readonly string[];
    dimensions: Readonly<Record<string, number>>;
    /**
     * 🔴 **P0-B**：三个维度字段必须分清（`dimensions` 语义未变 = 只有实测）。
     *
     * | 字段 | 含义 |
     * |---|---|
     * | `dimensions` | ① 只有实测说话（无实测 ⇒ 精确 0.5）—— 既有字段 |
     * | `observedDimensions` | ① 的显式别名 |
     * | `resolvedDimensions` | ① 标签 prior ⊕ 实测**融合**（响应层消费的就是它） |
     * | `baseDimensions` | 融合基准 = 标签维度（无标签 ⇒ 先 0.5） |
     */
    observedDimensions?: Readonly<Record<string, number>>;
    resolvedDimensions?: Readonly<Record<string, number>>;
    baseDimensions?: Readonly<Record<string, number>>;
    /** 逐轴证据质量（`Σ |极性| × 原始机会数`）；0 ⇒ 该轴保留标签，绝不重置成 0.5 */
    evidenceMass?: Readonly<Record<string, number>>;
    /** 逐轴融合权重 `w = mass/(mass+K_PROFILE_LABEL)`（无标签 ⇒ 1，无证据 ⇒ 0）
*/
    blendWeight?: Readonly<Record<string, number>>;
    street: Readonly<Record<string, Readonly<Record<string, number>>>>;
    trace: readonly Readonly<Record<string, unknown>>[];
    issues: readonly Readonly<Record<string, unknown>>[];
    noteZh: string;
  };
  environment: EnvironmentSnapshot;
  dynamic: DynamicSnapshot;
  /** 时间预算 */
  deadlineBudget: { softMs: number; hardMs: number; elapsedMs: number };
  /** 各阶段耗时 */
  timings: Readonly<Record<string, number>>;
};

/* ============================================================
 * 决策输出
 * ============================================================ */

export type DecisionReason = {
  /** 机器可读代码（静态字符串，便于测试与日志聚合） */
  code: string;
  /** 中文说明（界面直接显示） */
  textZh: string;
  /** 该理由涉及的关键数字（供诊断区展开） */
  data?: Readonly<Record<string, number | string>>;
};

/** 一个候选动作及其评估 */
export type DecisionCandidate = {  action: DecisionAction;
  /** 建议尺寸（筹码单位）；FOLD/CHECK 时为 undefined */
  sizeChips?: number;
  /** 建议尺寸（BB，界面显示用） */
  sizeBB?: number;
  /** 该动作的期望收益（筹码单位）；无法计算时为 null */
  ev: number | null;
  /** 该动作是否**数学可行**（不亏损 / 满足赔率） */
  mathFeasible: boolean;
  /**
   * 「数学可行/不成立」这个标签的**替代说法**（可选）。
   *
   * 用于「口径不适用」的局面 —— 目前只有一种：多人边池（`requiredEquityApplies === false`）
   * 时，单一权益门槛判不了跟注的方向，此时界面必须显示「不适用」，
   * 而不是把「数学不成立」这种**结论性**标签贴上去。
   */
  feasibleNoteZh?: string;
  /** 中文说明 */
  noteZh: string;
};

/**
 * 诊断信息 —— 内部调试区展示的全部内容。
 *
 * 界面**只消费**这份结构，不自己判断策略（规范第 63 节）。
 */
export type DecisionDiagnostics = {
  /** 数学九项（只读快照） */
  math: MathSnapshot;
  /** 合法动作（来自 Poker Core） */
  legalActions: readonly DecisionAction[];
  /** 全部候选及其 EV */
  candidates: readonly DecisionCandidate[];
  /** 基础决策（**未应用 Dynamic**） */
  baseDecision: DecisionCandidate | null;
  /** 应用 Dynamic 后的决策 */
  adjustedDecision: DecisionCandidate | null;
  /** Shadow 对比 */
  shadow: DynamicShadowComparison;
  /** Math Dominance Guard 的裁决 */
  mathDominance: MathDominanceVerdict;
  /**
   * 🔴 **翻后决策快照**（2026-09 翻后升级 · P3）—— 翻前为 `undefined`。
   *
   * 界面只显示其中五项（动作 / 尺度 / 主因 / 风险 / 置信度），
   * 其余供诊断与事后复盘使用。**全部字段都是启发式量**，见该类型的说明。
   */
  postflop?: PostflopDecisionSnapshot;
  /**
   * 🔴 **一致性守卫结果**（RIVER CONSISTENCY V2 · 使用者 §19）。
   *
   * 界面在 `ok === false` 时必须显著提示 `DECISION_CONSISTENCY_ERROR`；
   * 测试必须断言 `violations.length === 0`。
   * 类型在这里内联（而不是 import 守卫模块的类型）是为了让决策类型层
   * 不反向依赖判定逻辑 —— 那会让「类型 → 逻辑 → 类型」成环。
   */
  consistency?: {
    ok: boolean;
    violations: readonly { code: string; textZh: string }[];
  };
  /** 本次动作的决策依据（`CHIP_EV` / `PREFERENCE_SCORE` / `INDIFFERENCE_BAND` / `SAFETY_RULE`） */
  decisionBasis?: { kind: string; noteZh: string };
  /** 画像进入范围链路的证据（P0 修复；没有画像时为 null） */
  profileRange?: ProfileRangeEvidence | null;
  /** 决策边际（**与模型置信度分开**，见 `DecisionMarginFacts`） */
  decisionMargin?: DecisionMarginFacts;
  /** 下注决策（每个尺寸独立的响应概率与 BetEV；没有模型时为 null） */
  betDecision?: Readonly<Record<string, unknown>> | null;
  /** 🔴 多人 limp 隔离加注事实包（只有「面对跛入且无人加注」的翻前节点才有） */
  preflopIso?: PreflopIsoFacts | null;
  /**
   * 🔴 **多人联合响应树**（MULTIWAY POSTFLOP RESPONSE TREE PHASE 1）。
   *
   * ≥2 家时才非 null：逐对手响应 / 联合状态 / 条件权益 / 逐分支 EV / 总 EV，
   * 以及 `primaryOpponentUsedForEV = false` 这条硬性声明。
   */
  multiwayBetDecision?: MultiwayBetFacts | null;
  /**
   * 🔴 **动作证据与来源**（PREFLOP EVIDENCE PRIORITY FIX）。
   *
   * 回答「这个动作是谁选的、它凭什么覆盖别人」：
   * `kind`（HARD_CONSTRAINT / SUPPORTED_ACTION_PRIORITY / HEURISTIC_TIEBREAK /
   * STRATEGIC_HEURISTIC / FALLBACK）、`priority`、`canOverrideEvidence`、
   * `evidenceScope`、被阻断的覆盖尝试与原因。
   */
  decisionSource?: Readonly<Record<string, unknown>> | null;
  /** 各动作的证据类型 / EV / 边际 / 假设 / 升级条件 */
  actionEvidence?: readonly Readonly<Record<string, unknown>>[];
  /**
   * 🔴 **RIVER RAISE DECISION V2 · 动作形态
*（§四：普通加注 / 加注到全下 / 直接全下）。
   *
   * `sizeChips` 是
**raise-to** 口径，所以」 74」既可能是「加注到 174。
   * 也可能是「把 87BB 全部推入」—— 两者在证据权限不
*完全不同**（
   * 必须由本字段显式区分，而不是让调用方按底池比例猜。
   */
  actionShape?: {
    readonly kind: 'FOLD' | 'CALL' | 'CHECK' | 'BET' | 'NORMAL_RAISE' | 'RAISE_TO_ALL_IN' | 'DIRECT_ALL_IN' | 'NONE';
    readonly sizeChips: number | null;
    readonly allInToAmount: number;
    /** 这次动作是否把剩余筹码全部投入（全下）
*/
    readonly consumesStack: boolean;
  readonly noteZh: string;
};

/**
 * 🔴 **RIVER RAISE DECISION V2 · 全下保护判定**（§四）。
   *
   * 「一对牌 + 打光筹码 + 没有自己的 EV」必须被拦下 —— 本字段如实记录
   * 该保护
*是否命中**以及命中的依据（牌力类别 / 是否全下 / 是否有自己的 EV）。
   */
  allInGuard?: {
    readonly handCategory: number;
    readonly minCategoryForLargeRaise: number;
    /**
     * 🔴 **PREFLOP P0（F2）**：本判定所适用的街道。
     *
     * 「一对牌全下」保护的判据是成手牌类别，而**翻前没有成手牌**
     *（`handCategory ≡ 0`）⇒ 该保护在 `PREFLOP` 上**按街道不适用**。
     * 把这个字段带出来，使用者才能判断 `onePairAllInBlocked = false`
     * 到底是「保护让位于自有 EV」还是「本街道根本不适用」。
     */
    readonly street?: Street;
    readonly consumesStack: boolean;
    readonly hasOwnEV: boolean;
    /**
     * 🔴 **U1 披露一致性
*：真正有自有可比 EV 的加注尺寸（raise-to 口径）。
     *
     * 存在的理由：加注候选的 `ev` 字段恒为 null（加注 EV 挂在证据表上），
     * 所以「没有 EV 模型」
*不能**用 `candidate.ev === null` 判断「
     * 没有这个字段时产品会自相矛盾：动作靠 RAISE EV 选出（ 9 暗三重节点
     * RAISE 174 ⇒ MODEL_EV +140.01），同一份诊断却把 174 列进
     * `unevaluatedActions` 的 `RAISE_EV_NOT_IMPLEMENTED`、
     */
    readonly raiseSizesWithOwnEV?: readonly number[];
    readonly raiseToPotRatio: number | null;
    /** 命中「一对牌全下且无自有 EV」⇒ 该加注被拒
*/
    readonly onePairAllInBlocked: boolean;
    /** 命中旧的底池比例档保护
*/
    readonly largeRaiseBlocked: boolean;
    /** 🔴 §五：放行条款逐条可审计 —— 牌力角色强度 */
    readonly roleStrength?: number | null;
    readonly spr?: number | null;
    readonly stackOffAllowed?: boolean | null;
    /** 承诺例外是否成立 */
    readonly commitmentException?: boolean;
    /** **实际触发的
*承诺条款（`null` = 没有条款触发 / 河牌上整条通道关闭（
*/
    readonly commitmentClause?: 'ROLE_STRENGTH' | 'FUTURE_STREET_COMMITMENT' | null;
    /** 启发式加注用来覆盖清晰 CALL 的论证类型（`null` = 没有论证：
*/
    readonly overrideJustificationKind?: string | null;
  readonly noteZh: string;
};

/**
 * 🔴 **RIVER RAISE DECISION V2 · 尚未评估的合法动作
*（§三）。
   *
   * 「如果系统需要给出唯一最终动作，应在**可评估
*候选动作之间裁决，
   * 并显示尚有未评估的合法动作。不要把当前选择声称为所有合法动作中的最优解。「
   */
  unevaluatedActions?: readonly {
    readonly action: string;
    readonly sizeChips: number | null;
    readonly ev: null;
    readonly reasonCode: string;
    readonly reasonZh: string;
  }[];
  /**
   * 🔴 **RIVER RAISE DECISION V2 · 条件权益清单**（§六）。
   *
   * 三个（四个）条件范围必须**显式**区分，缺失的必须标注 `NOT_IMPLEMENTED`（
   * 不允许用别的条件权益静默顶替。
   */
  conditionalEquities?: {
    readonly arrivalRange: number | null;
    readonly betRange: number | null;
    readonly wholeRange: number | null;
    /**
     * 🔴 **面对加注的继续范围权益
*（U1 实现后为数值）。
     * 仍然可能不可得（没有加注候选 / 权益算不出来）⇒ 那时不 `'NOT_IMPLEMENTED'`、
     */
    readonly raiseContinueRange: number | 'NOT_IMPLEMENTED';
    /** 加注门槛实际读取的是哪一个
*/
    readonly usedByRaiseThreshold: 'EqVsBetRange' | 'FALLBACK_WHOLE_RANGE' | null;
  readonly noteZh: string;
};

/**
 * 🔴 **U1：面对加注的响应 + 加注 EV**（`reports/UNCERTAINTY_REGISTER.md`）。
   *
   * 公共信息口径（不证 Hero 底牌）的结构性先验；`raiseEV` 的再加注分支明
*下界**。
   * `null` = 本节点不可得（不是「EV = 0」）。
   */
  /**
   * 🔴 诊断与事实包**同源透传**：这里暴露的就是 \PostflopFacts['raiseResponse']\ 本身。
   *
   * 修复说明（2026-09-19 恢复轮）：本声明原先手抄了一份成员表，在 P1-2b 增加
   * \eraiseBranch*\ / \eRaise*\ / \heroFourBetSupported\ 之后**未同步**，
   * 导致 \contextBuilder\ 的透传赋值无法通过类型检查。改为直接引用同一形状，
   * 从结构上保证两者不会再漂移（不新增任何字段，字段定义仍在上面那一处）。
   */
  raiseResponse?: PostflopFacts['raiseResponse'];
  /** 主推荐动作
*/
  primaryAction?: string | null;
  /** 备选动作（**不是**最终动作；保留混合策略信息） */
  alternativeActions?: readonly Readonly<Record<string, unknown>>[];
  /** 触发的降级 */
  degradations: readonly DegradationEntry[];
  /** 使用的版本（追溯「昨天 CALL 今天 FOLD」） */
  versions: Readonly<Record<string, string>>;
  /** 环境（含未映射规则与优先级裁决） */
  environment: EnvironmentSnapshot;
  /** 范围（含更新轨迹）—— **首要对手**那一个，用于展示与玩家画像 */
  range: RangeSnapshot | null;
  /**
   * **全部已实现对手**的范围 —— **权益就是按这些算的**。
   *
   * 🔴 与 `range` 的关系：`range` 只是 `opponentRanges[0]`。
   * 两者的差别在多人池里是**实质性的**：
   *
   * - 只看 `range` ⇒ 会以为「权益是单挑口径」
   * - 看 `opponentRanges` ⇒ 才知道权益按几家算、每家的范围可不可信
   *
   * 界面的「这条建议用了什么范围」必须读这个字段，不能读 `range`。
   * 顺序与 `DecisionContext.opponentRanges` 一致。
   */
  opponentRanges: readonly RangeSnapshot[];
  /** 玩家 */
  player: PlayerSnapshot | null;
  /** 动态 */
  dynamic: DynamicSnapshot;
};

/**
 * Dynamic Shadow 对比（规范第 37 节）。
 *
 * ⚠️ Alpha 阶段 Dynamic **不得静默成为唯一决策来源**：
 * 必须同时算出「不应用 Dynamic」与「应用 Dynamic」两个结果，
 * 并把差异显式暴露出来。
 */
export type DynamicShadowComparison = {
  baseDecision: DecisionCandidate | null;
  adjustedDecision: DecisionCandidate | null;
  actionChanged: boolean;
  sizeChanged: boolean;
  confidenceChanged: boolean;
  /** Dynamic 自身的置信度 */
  dynamicConfidence: number;
  /** 幅度的来源标注（Alpha 阶段永远是 UNVERIFIED_MAGNITUDE） */
  magnitudeProvenance: 'VERIFIED' | 'HEURISTIC' | 'UNVERIFIED_MAGNITUDE';
  /** Dynamic 是否**被允许**改变最终动作（受 MathDominanceGuard 限制） */
  dynamicAllowedToFlip: boolean;
  /** 中文说明（若发生翻转，必须能读懂原因） */
  noteZh: string;
};

/**
 * 强数学优势保护（规范第 30 / 31 节）。
 *
 * 当某动作相对替代动作的 EV 优势**明显**时，
 * 低置信度的 Dynamic 不得轻易翻转它。
 *
 * ## ⚠️ 阈值是 `HEURISTIC_THRESHOLD`，不是已验证参数
 *
 * 本项目**没有**经验证的 EV gap 阈值。因此：
 * - 阈值放在显式配置里，标 `HEURISTIC_THRESHOLD`
 * - 必须出现在 Diagnostics 里，**不许藏起来**
 */
export type MathDominanceVerdict = {
  /** 是否存在明显优势动作 */
  dominant: boolean;
  /** 占优动作与次优动作的 EV 差（筹码单位）；无法比较时为 null */
  evGap: number | null;
  /** EV 差占底池的比例（可解释性更好） */
  evGapToPotRatio: number | null;
  /** 该阈值是否为启发式（**永远为 true**，直到有真实校准） */
  thresholdProvenance: 'HEURISTIC_THRESHOLD';
  /** 使用的阈值（占底池比例） */
  thresholdRatio: number;
  /** 中文说明 */
  noteZh: string;
};

export type DegradationEntry = {
  /** 降级代码 */
  code: string;
  /** 中文说明 */
  textZh: string;
  /**
   * 影响了什么。
   *
   * - `EXPLANATION` — 只影响解释文本，不影响结论
   * - `SIZE` — 影响建议的尺寸
   * - `CONFIDENCE` — 影响置信度
   * - `MODULE` — 某个模块整体被降级（例如动态层不可用）
   * - `MATH` — **数学输入本身是近似值**，因此结论方向可能偏
   *   （红队 F-06：多人池里权益只能按单挑口径估，真实值更低）
   *
   * 🔴 `MATH` 是最重的一档：它意味着「数字是算对的，但算的不是那件事」。
   * 这种降级**必须**出现在使用者看得到的地方，不能只进 Diagnostics。
   */
  impact: 'EXPLANATION' | 'SIZE' | 'CONFIDENCE' | 'MODULE' | 'MATH';
};

/* ============================================================
 * 最终输出
 * ============================================================ */

/**
 * Alpha 决策结果。
 *
 * `action` 与 `legalActions` 的
*关系**由测试锁定：
 * 输出的动作必须属于合法动作集合。这是规范第 22 节的落地。
 */
export type AlphaDecision = {
  /**
   * 建议的动作。
   *
   * ## ⚠️ 信息不足时为 `null`（红队 F-05 的修复）
   *
   * 修复前这里是 `finalCandidate?.action ?? DecisionAction.FOLD` ——
   * 于是**信息不足**时机器可读字段仍然是 `'FOLD'`，
   * 并原样外流到 HTTP 响应体与决策日志 JSONL。
   * 使用者（或任何消费日志的脚本）看到的是
   * 「系统建议弃牌」，而真实语义是「系统拒绝给建议」。
   *
   * 现在：`actionable === false` 时本字段为 `null`，
   * **没有动作**与**建议弃牌**在机器可读层面被彻底分开。
   */
  action: DecisionAction | null;
  /** 建议尺寸（筹码单位）；不适用时为 undefined */
  sizeChips?: number;
  /** 建议尺寸（BB） */
  sizeBB?: number;
  confidence: number;
  band: ConfidenceBand;
  classification: DecisionClassification;
  reasons: readonly DecisionReason[];
  diagnostics: DecisionDiagnostics;
  /** 是否可以放心执行（`INSUFFICIENT_INFORMATION` 时为 false） */
  actionable: boolean;
};

/* ============================================================
 * 常量
 * ============================================================ */

/**
 * 「边缘区间」半宽（占底池比）。
 *
 * 当占优动作与次优动作的 EV 差小于 `底池 × 该比例` 时判 `MARGINAL`。
 *
 * 🔴 **`HEURISTIC_THRESHOLD`**：这是工程选择，不是从数据估出的参数。
 * 本项目没有经验证的 EV gap 阈值。它出现在 Diagnostics 里。
 *
 * ## 🔴 RIVER CONSISTENCY V2.1：它**不是**数学上的无差异（P0-2）
 *
 * 使用者点名的一句话：
 *
 * ```text
 * 「EV = −317.61 vs 0 落在 ±392.50 带内 ⇒ 数学上没有明显优劣」  ← 这句话不成立
 * 0 > −317.61 是确定的：数学上 FOLD 的 EV 更高。
 * ```
 *
 * 这个 5% 的来历必须说清楚（**唯一**公式）：
 *
 * ```text
 * toleranceChips = MARGINAL_EV_GAP_RATIO × winnable
 *                = 5% × 跟注后的可争夺量（P + 2B）
 * 本节点：5% × 7850 = 392.50 筹码
 * 对照：5% × pot = 282.50、5% × callCost = 110.00、
 *       5% × effectiveStack = 307.50、5% × myRemainingStack = 417.50  ← 都不是它
 * ```
 *
 * 它**不是**统计误差（没有置信区间）、**不是** solver error bound（本项目没有求解器树）、
 * **不是** sampling variance（本节点是精确枚举，`confidenceHalfWidth = 0`）——
 * 它是**人为的工程容差**。
 *
 * 因此从 V2.1 起：
 *
 * | 用途 | 行为 |
 * |---|---|
 * | **动作选择** | **只看真实 EV 排名**（`callEV` 与 0 比较，仅留 `MATH_EV_EPSILON` 的浮点余量） |
 * | 边缘标记 | 仍然用它把局面标成 `MARGINAL`（分类与置信度） |
 * | 覆盖（override） | 仅当调用方**显式开启** `allowUncertaintyOverride` 才允许偏离 EV 第一名，且必须标成 `MODEL_UNCERTAINTY_OVERRIDE`（工程启发式，不是数学结论） |
 *
 * 名字保留 `MARGINAL_EV_GAP_RATIO` 是为了不让既有调用点静默改变含义；
 * **对外表述**统一叫「模型容差带 / 工程容差」，禁止叫「无差异」。
 */
export const MARGINAL_EV_GAP_RATIO = 0.05;

/**
 * 🔴 **模型容差带**：与 `MARGINAL_EV_GAP_RATIO` 同值，用于**对外表述**。
 *
 * 使用者第十九节 / 第五节的改名要求：既然它不是统计误差，
 * 就不该叫 `INDIFFERENCE_BAND`（数学无差异）—— 它是
 * **DECISION_TOLERANCE_BAND / MODEL_UNCERTAINTY_BAND**。
 */
export const MODEL_UNCERTAINTY_RATIO = MARGINAL_EV_GAP_RATIO;

/**
 * 🔴 **数学无差异的阈值**（P0-2 · 使用者第六节）。
 *
 * 真正的数学 indifference 是 `|EV_a − EV_b| ≤ ε`，其中 ε 只用于
 * **浮点/数值误差**。本项目所有量都以筹码为单位、由精确算术得到，
 * 因此取 `1e-6` 筹码作为「恰好相等」的判据。
 *
 * ⚠️ 它**永远不能**被换成「5% 底池」那种尺度 —— 那会把
 * 「FOLD 比 CALL 好 317.61 筹码」说成「数学上无差异」。
 */
export const MATH_EV_EPSILON = 1e-6;

/**
 * 「强数学优势」阈值（占底池比）。
 *
 * 超过它时，低置信度的 Dynamic **不允许翻转动作**（只能影响置信度与分类）。
 *
 * 🔴 **`HEURISTIC_THRESHOLD`**：同上，并在 Diagnostics 中显式标注。
 */
export const DOMINANT_EV_GAP_RATIO = 0.15;

/** 允许 Dynamic 翻转动作所需的最低 Dynamic 置信度 */
export const DYNAMIC_FLIP_MIN_CONFIDENCE = 0.5;

/**
 * 版本号（进日志与缓存 key）。
 *
 * ## 变更记录
 *
 * - `1.0.0` — Alpha 首版（尚未用于任何真实牌局复盘）
 * - `1.0.1` — Alpha 冻结前的红队修复轮。**未发布过**，不改动任何已归档的历史记录：
 *   - **F-04**：`CLEAR`（明确决策）新增置信度下限 `CLEAR_MIN_CONFIDENCE = 0.55`，
 *     低置信度一律降为 `MARGINAL`。修复前「置信度 0.1537」也会被标成「明确决策」。
 *   - **F-05**：`AlphaDecision.action` 改为 `DecisionAction | null`。
 *     `null` **专指**「信息不足，拒绝给建议」，不再伪装成 `FOLD`。
 *     这是**输出契约**变化：机器可读字段（HTTP 响应 / JSONL 日志）的语义变了。
 *   - `decision.types.ts` 的改动按 `artifactDefinitions.ts` 的纪律必须升版本号，
 *     本次即按该纪律执行。
 * - `1.0.2` — **多人边池的判定口径修正**（2026-09 边池轮）：
 *   - 新增 `MathSnapshot.requiredEquityApplies`（可选）。`false` 表示
 *     **我有资格争夺的层 ≥ 2**，此时**不存在**单一胜率门槛 ——
 *     主池要赢所有人、边池只要赢同层的人，两笔钱的胜负条件不同。
 *   - `requiredEquity` 仍给数（界面要显示、指纹测试要比对），
 *     但 `decisionEngine` **不得**据此硬判「负期望」（`MATH_FOLD_DOMINANT` 关闭），
 *     并改显示「不适用（多人边池）」以替代结论性标签。
 *   - 为什么必须升版本：这改变了**输出契约的语义** ——
 *     同一手牌的 `classification` / `confidence` 与理由文案会变。
 *     实测反例：短码暗三条全下、大筹码听牌全下、我 A♥A♦ 需跟 2000
 *     ⇒ 单一门槛 28.4% 而我的整池权益 4.8%，修复前硬判「跟注是负期望」，
 *     真实跟注 EV 却是 **+1764**（我 90.5% 赢边池）。
 *   - ⚠️ 只在 `requiredEquityApplies === false` 时生效；「权益高于门槛」那一侧
 *     不受影响（下界说划算，真实值只会更划算）。
 * - `1.0.3` — **分层权益（逐层胜率）真正生效**（2026-09 多层权益轮 · 修正轮）：
 *   - 新增 `MathSnapshot.layeredEV`（可选）与 `MathSnapshot.winnable`（必填）。
 *     `winnable` = `previewCommit(state, 我, callCost).winnable` = 各层金额之和，
 *     它既是门槛的分母，也是 EV 的基数，还是判据的标尺。
 *   - 🔴 **修正一个 CRITICAL 口径错误**：分层原先取自**决策时刻**的
 *     `computeLayeredPot(state)`，而 `winnable` 取自**跟注之后**的
 *     `previewCommit` —— 违反 `pots.ts` 自己写明的「先假设投入，再分层」。
 *     后果实测：`POT-14` 形态（跟 2900 > 决策时刻可争夺量 2150）的 EV 被
 *     **算术强制为负**（−1352），一手真实 EV +2664 的牌被判
 *     `MATH_FOLD_DOMINANT`（**不可翻转**）。修正后为 +2664 ⇒ 跟注。
 *   - 🔴 判据标尺改为 `EV / winnable`（原先除以 `pot`，而 `pot` 含永远不会被
 *     争夺的筹码）⇒ 与单层的 `edge = callEV / winnable` 同量纲、同阈值。
 *   - 🔴 取消「精确分层 EV > 0 就直接返回跟注」的短路 —— 它**绕过了
 *     `shouldRaise`**，使「EV 越明显越不能加注」。现在与单层合流。
 *   - `layeredEV` 只在 `previewCommit(...).singleThresholdApplies === false`
 *     时产出：与 `requiredEquityApplies` **同一个来源**。此前用
 *     「决策时刻层数 > 1」判定，导致「hero 已投盲注而对手在其上方」的
 *     **暂时性层**把单层局面改判（红队 `F-06` 局面由 RAISE 变成 CALL）。
 *   - 为什么必须升版本：动作/分类/置信度与理由文案都会变 ——
 *     实测 `POT-14` 由 FOLD 变 CALL，`F-06` 由 CALL 变回 RAISE。
 * - `1.0.4` — **人物画像量化 V1 真正进入动作似然**（PLAYER PROFILE
 *   QUANTIFICATION V1 + NODE DETERMINISM AUDIT）：
 *   - 新增 `ProfileRangeEvidence` 与 `PostflopSnapshot.profileRange`（可选，只读诊断）。
 *   - 🔴 画像此前是一座**孤儿**：量化模块 `player/behaviorProfile.ts` 完整且单测全绿，
 *     但 `behaviorProfileOf` **没有任何生产调用者**，界面只设置 `quickProfile`
 *     而 `contextBuilder` 只认显式传入的 `behaviorProfile` ⇒ 画像从未进入决策链。
 *     现在由 `quickProfile` 在 `buildDecisionContext` 内派生（`UNKNOWN` 排除）。
 *   - 画像经**动作似然**进入对手范围：`likelihood = 档位似然 × 似然比(画像/中性)`，
 *     仅作用于**河牌进攻性动作**，并在同一条动作上抑制旧的倾斜通道（避免同一份
 *     证据计两次）。中性画像的比值恒为 1.000 ⇒ 与既有模型逐位一致。
 *   - 为什么必须升版本：**对手范围 → 权益 → EV → 建议**都会随画像变化。
 *     实测（§十七 黄金手，只改 `quickProfile`）：`bluffMass` 0.0470→0.1136、
 *     `missedDrawBluffMass` 0.0345→0.0865、`heroEquity` 0.6579→0.6799、
 *     `callEV` 16.92→17.95（四条单调性全通过）。
 *   - ⚠️ 明确**未**改动的部分：`handEval` / 底池赔率 / 所需权益 / SPR /
 *     combo 数学 / 权益算法 / EV 公式 —— 全部冻结（规范 §三十九）。
 * - `1.0.5` — **统一动作似然（PLAYER PROFILE QUANTIFICATION V2）**：
 *   - 新增 `estimateUnifiedActionLikelihood`（`domain/player/behaviorProfile.ts`），
 *     成为河牌进攻性动作**唯一**的似然来源：
 *     `likelihood = 中性校准层(既有档位权重) × (Π 已施加几率比)^(1/K)`。
 *   - 🔴 **取消两个生产入口并存的局面**：V1 的 `archetypePriorAvailable` 闸门已移除。
 *     它存在的前提是「中性标签必须走旧路径」；而 V2 的中性校准层让中性画像
 *     **逐位等于**旧结果（实测 48/48 网格单元最大绝对差 **0**），
 *     于是闸门是恒等变换，保留它只会长期并存两个模型（§四十五）。
 *   - 条件化由**有界线性**改为**几率比**（`odds(r)/odds(π)`），动态范围 ≈1.75× → ≈19×；
 *     多条**相关**条目按**结构槽位数**取几何平均（不是乘积：乘积实测放大 417×
 *     并撞上钳位，会把「错过听牌」与「坚果」压平成同一个值）。
 *   - `MEDIUM_VALUE` 从 `RiverComboClass` **删除**（生产永不可达的死成员）。
 *   - 为什么必须升版本：**对手范围 → 权益 → EV → 建议**都随画像变化。
 *     实测（§十七 黄金手，只改 `quickProfile`）：`bluffMass` 0.78%→5.00%、
 *     `missedDrawBluffMass` 0.49%→3.40%、`heroEquity` 55.81%→57.61%（+1.80pp）、
 *     `callEV` 12.230→13.076；四条单调性全部成立。
 *   - ⚠️ 仍**未**改动的部分：上一条列出的全部数学层，同样冻结。
 *
 * - `1.0.5` → **`1.0.6`**（PLAYER PROFILE V3 · 连续统计 + 样本置信度）：
 *   - `DecisionContext` 新增**可选**字段 `profileV3`（「标签 Prior + 实测连续统计」
 *     的解析结果与逐统计 trace）。它是**诊断 / 审计**字段，**不参与任何判定**。
 *   - ⚠️ **为什么必须升版本**：`artifactDefinitions.ts:314` 对本文件的纪律是
 *     「该文件改动**必须**升 `ALPHA_DECISION_MODEL_VERSION`」，措辞**无条件**。
 *     且 `DecisionContext` 的形状变化会影响指纹 / 确定性比对的 digest ——
 *     不升版本就无法回答「这手的 digest 为什么变了」。
 *   - 🔴 **明确未改动的部分（全部冻结）**：`handEval` / 底池赔率 / 所需权益 /
 *     SPR / combo 数学 / 权益算法 / EV 公式 / `MATERIALITY_THRESHOLDS` /
 *     全部判定阈值 / `MathSnapshot` 既有字段语义。
 *   - V3 只通过**既有**通道生效：`ResponseTendencies` 新增三个**可选**分街系数
 *     （`streetFoldScale` / `streetCallScale` / `streetCheckRaiseScale`），
 *     缺省**恒为精确的 1** ⇒ 无连续统计时下游**逐位不变**（有 P1/P1b 锁定）。
 *
 * - `1.0.6` →
**`1.0.7`**（PLAYER PROFILE V3 RESOLVER 定向修复）：
 *   - `profileV3` 快照新增**可选
*诊断字段 `observedDimensions` /
 *     `resolvedDimensions` / `baseDimensions` / `evidenceMass` / `blendWeight`、
 *     既有字段 `dimensions` 语义**未变**（仍然只有实测说话、无实测 ⇒ 精确 0.5）。
 *   - 🔴 **不 1.0.6 不同：这次真的改了判定
*（不是纯诊断字段）。
 *     响应层消费的维度由。
*只有实测**」改为「
*标签 prior ⊕ 实测**」的融合值
 *     （`contextBuilder` 注入的 `v3Dimensions`）。带 `observedStats` 的手牌，
 *     全 Fold/Call/Raise 概率、EqVsCall、BetEV 与最终建议
*都可能变化
*。
 *   - 实测（TEST 12 真跟注站 1500 手）：tightness 0.5377 →
**0.3101**。
 *     passivity 0.4700 →
**0.7594**、bluffTendency 0.5000 →
**0.3500**（保留标签）。
 *   - 🔴 **明确未改动的部分（全部冻结）**：全部数学层、全部判定阈值。
 *     `MATERIALITY_THRESHOLDS`、以及
*分街直接统计通道**
 *     （`streetFactorOf` 与 `calibratedBetScaleOf` 的输入仍是 observed-only 维度）。
 *   - 无 `observedStats` 时行为
*逐位不变**：融合权重为 0 ⇒ 融合维度 = 标签维度（
 *     不 `v3Dimensions` 仍
*只在** `observedStatCount > 0` 时注入（P1 / P1b 锁定）。
 */
export const ALPHA_DECISION_MODEL_VERSION = '1.0.7';
/**
 * 决策**上下文
*（`DecisionContext` / `MathSnapshot`）的形状与语义版本。
 *
 * 变更记录：
 * - `1.0.0` — 首版。
 * - `1.0.1` — `MathSnapshot` 新增 `winnable`（跟注后可争夺量，门槛与 EV 的基数）；
 *   多层局面的 `callEV` 语义由「门槛下界」改为「精确分层 EV」。⚠️ 不升版本会让
 *   JSONL 日志里同一版本号同时对应修复前后的两种口径。
 *
 * ⚠️ 它必须进 `diagnostics.versions`（`decisionEngine` 已于 2026-09 修正轮接上）——
 * 此前这个常量全项目**零读者**，等于没有版本。
 */
export const ALPHA_CONTEXT_VERSION = '1.0.1';
