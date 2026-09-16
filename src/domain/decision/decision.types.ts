/**
 * Alpha 决策引擎 —— 类型与常量
 *
 * ## 这个模块在端到端链中解决什么
 *
 * 定义「决策」这件事的**完整词汇表**：动作、分类、理由、诊断、上下文。
 *
 * ## 分层纪律（第一原则的可执行版本）
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
import type { EnvironmentAdvice, PriorityVerdict } from '../../domain/environment/environmentAccess.ts';
import type { OpponentRangeFacts } from '../postflop/types.ts';
import type { QuickProfile } from '../../app/manualInput/manualInput.ts';

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
  /** 对手范围在当前牌面上的统计（`null` = 算不出来） */
  opponentRangeFacts: OpponentRangeFacts | null;
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
  evRanking: readonly { action: string; score: number }[];
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
   * 可达范围的**组合数**（占比的分母）。没有范围数据时为 null。
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
  /** 权益估计（依赖对手范围） */
  heroEquity: number | null;
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
 * 决策上下文
 * ============================================================ */

/**
 * 决策上下文 —— `buildDecisionContext()` 的产物。
 *
 * ## 本结构**刻意**不含的东西（规范第 20 节）
 *
 * - 对手底牌（`villainHoleCards`）
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
  math: MathSnapshot;
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
 * `action` 与 `legalActions` 的**关系**由测试锁定：
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
 */
export const ALPHA_DECISION_MODEL_VERSION = '1.0.3';
/**
 * 决策**上下文**（`DecisionContext` / `MathSnapshot`）的形状与语义版本。
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
