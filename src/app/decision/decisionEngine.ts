/**
 * Alpha Decision Engine
 *
 * ## 这个模块在端到端链中解决什么
 *
 * 回答**一个问题**：现在合理动作是什么？
 *
 * ## 核心思想（规范第 25 节）
 *
 * ```
 * 先 Math Feasibility  →  再 Strategic Preference
 * ```
 *
 * 即：**先算出数学上可行的动作集合**，再在可行集合内按策略偏好排序。
 * 而不是先凭「牌强 / 对手松」挑一个动作，再去事后合理化。
 *
 * ## 六条不可违背的纪律
 *
 * 1. **候选动作只能来自 `legal.actions`**（规范第 22 节）。
 *    本文件**不构造**任何不在合法集合里的动作；
 *    输出前还有一道 assert 兜底。
 * 2. **尺寸必须合法**（规范第 23 节）：来自 `buildSizeGrid`，
 *    它已按最小下注 / 剩余筹码 / 全下规则夹取。
 * 3. **不做完整 GTO**（规范第 24 节）：输出**主导动作**，
 *    接近时标 `MARGINAL`。绝不输出「Raise 32.7%」这种伪精确频率。
 * 4. **数学明显负 EV 时，语言描述不能翻转**（规范第 27 节）。
 *    对手范围变了必须**重新算权益并跨过阈值**，否则不翻。
 * 5. **信息不足时要敢说不知道**（规范第 33 节）。
 * 6. **置信度 ≠ 权益**（规范第 34 / 35 节）：
 *    `confidenceOf()` 的输入里**没有** `heroEquity`。
 */

import { Street } from '../../domain/types.ts';
import { advisePostflop, type PostflopAdvice } from './postflopAdvisor.ts';
import { EV_SCORE_DISCLAIMER_ZH } from '../../domain/postflop/evScore.ts';
import { allBoardCards } from '../../domain/poker/gameState.ts';
import {
  ALPHA_CONTEXT_VERSION,
  ALPHA_DECISION_MODEL_VERSION,
  DOMINANT_EV_GAP_RATIO,
  DYNAMIC_FLIP_MIN_CONFIDENCE,
  DecisionAction,
  DecisionClassification,
  DecisionMargin,
  DECISION_MARGIN_ZH,
  DecisionMarginScope,
  MARGINAL_EV_GAP_RATIO,
  MATH_EV_EPSILON,
  MODEL_UNCERTAINTY_RATIO,
  confidenceBandOf,
  type AlphaDecision,
  type DecisionCandidate,
  type DecisionContext,
  type DecisionDiagnostics,
  type DecisionMarginFacts,
  type DecisionReason,
  type DegradationEntry,
  type DynamicShadowComparison,
  type MathDominanceVerdict,
  type PostflopDecisionSnapshot,
} from '../../domain/decision/decision.types.ts';
import {
  buildSizeGrid,
  closestSizeTo,
  type LegalActions,
  type SizeOption,
} from '../manualInput/legalActions.ts';
/**
 * 🔴 U1 P0：加注 EV 的
*资金口径契约版本**。
 *
 * 决策层用它当硬门槛：只有带这个标记的事实包才有资格进跨动作 EV 比较
 *（旧口径把对手已下注的筹码漏出底池，见 `reports/U1_RAISE_EV_LIGHT_AUDIT.md`）。
 */
import { CASHFLOW_CONTRACT } from '../manualInput/raiseResponse.ts';
import {
  DECISION_SOURCE_ZH,
  DecisionSourceKind,
  EstimateType,
  chooseByEvidencePriority,
  isQuantifiedEvidence,
  marginOf,
  type ActionEvidence,
  type EvidenceDecision,
} from '../../domain/decision/evidencePriority.ts';
import { DECISION_ACTION_ZH } from '../../domain/decision/decision.types.ts';
import { RELATIVE_ROLE_ZH } from '../../domain/postflop/types.ts';
import { madeHandClassOf, MADE_HAND_CLASS_ZH } from '../../domain/postflop/relativeHandRole.ts';
import {
  consistencyErrorZh,
  decisionBasisOf,
  validateDecisionConsistency,
  type ConsistencyViolation,
  type DecisionBasis,
} from '../../domain/decision/decisionConsistency.ts';

/* ============================================================
 * 信息充分性门槛
 * ============================================================ */

/*
 * 🔴 **`MULTIWAY_REFUSE_THRESHOLD` 已删除**（本轮）。
 *
 * 它曾经是「已实现对手 ≥3 ⇒ 拒绝给建议」的门槛。删除的理由不是它写错了，
 * 而是**它要防的那件事已经被修好了**：
 *
 * | | 修复前 | 修复后 |
 * |---|---|---|
 * | 权益口径 | **单挑**（只用首要对手的范围） | **全部已实现对手** |
 * | 与底池赔率 | **口径不一致**（赔率按 N 家、权益按 1 家） | 一致 |
 * | ≥3 家时的行为 | 拒绝给建议 | 正常分析 + 如实声明 |
 *
 * 那条拒绝的**动机是对的**（宁可不答，也不给口径不一致的数字），
 * 但代价是把工具在真实牌桌上废掉 —— 9 人桌现金局里
 * 「一家开池、几家跟注」是**常态**。
 *
 * 实测同一手 AK 顶对（`board=Kc8h3d`，6 家进池）：
 *
 * ```text
 * 修复前：当前无法给出可靠打法（信息不足）
 * 修复后：建议：跟注 4.00BB · 权益 37.9% · 所需 10.7% · 161 ms
 * ```
 *
 * ⚠️ 删掉的是**拒绝**，不是**谨慎**。仍然保留的三道防线：
 *
 * 1. `MIN_RANGE_CONFIDENCE_MULTIWAY` —— 多人池要求**更高**的范围可信度
 * 2. `MULTIWAY_APPROXIMATION` 降级条目 —— 写明权益按几家算、还有几家没说话
 * 3. `PLAYERS_YET_TO_ACT` —— 未行动的人不在权益里，如实提示
 */

/**
 * 触发「后面还有人在等」提示的**未行动**对手数门槛。
 *
 * | 数字 | 问的问题 | 后果 |
 * |---|---|---|
 * | `realizedOpponentCount` | 真的有人进池了吗 | **决定权益按几家算**（不再拒绝） |
 * | `playersYetToAct` | 还有多少人可能进来 | ≥2 → **给出「他们不在权益里」提示** |
 *
 * 为什么「有 2 个人还没说话」值得提示而不是拒绝：
 * 他们**没有范围、没有投入**，权益里根本没有他们；但他们的存在意味着
 * 「现在这个权益」描述的是一个**还没结束**的局面。如实说出来，
 * 让使用者自己决定要不要按更紧的线打 —— 而不是替他做一个假的拒绝。
 */
export const YET_TO_ACT_NOTICE_THRESHOLD = 2;

/**
 * 可用权益所需的最低对手范围可信度。
 *
 * 低于它时**不给建议**，而不是「用一个很不可信的范围算个数字」。
 *
 * 取值 0.15 的依据：启发式先验的 confidence 是 0.3，
 * 真实画像可达 0.6+。门槛设在 0.15 意味着
 * 「连启发式先验都拿不到」时才放弃。
 */
export const MIN_RANGE_CONFIDENCE = 0.15;

/**
 * **2 个活跃对手**时要求的范围可信度（比单挑更高）。
 *
 * ## 依据（工程选择，非经验参数）
 *
 * 多人池里，范围误差对结论的杀伤力被放大：单挑时权益只取决于一个范围，
 * 而 3 人池里第二家对手的真实范围会显著压低我们的权益。
 * 既然第一版**没有**把第二家的行动历史纳入模型（见 `MULTIWAY_APPROXIMATION`），
 * 那就用「更严的可信度门槛」来换取「少给一些本就不该给的自信建议」。
 *
 * 🔴 **`HEURISTIC_THRESHOLD`**：0.25 是工程选择，不是从数据估出的参数。
 * 它出现在 Diagnostics 的降级说明里，不隐藏。
 */
export const MIN_RANGE_CONFIDENCE_MULTIWAY = 0.25;

/**
 * 被判定为「观察到偏离」的动态状态集合。
 *
 * 只有这些状态才允许**降低**决策置信度 —— 它们是「对手的打法偏离了他的基线」，
 * 意味着我们据以建模的画像/范围没那么可靠了。
 *
 * `NORMAL`（观察到他打法正常）与 `UNKNOWN`（没有观察）都**不在**此列：
 * 前者是「没有坏消息」，后者是「没有消息」，两者都不构成降低可信度的理由。
 *
 * 🔴 红队 F-11：修复前只要 `confidence > 0` 就施加惩罚，
 * 于是「主动填了观察」反而比「什么都不填」置信度更低。
 */
const DYNAMIC_ANOMALY_STATES: ReadonlySet<string> = new Set([
  'TILT_SIGNAL',
  'SIZE_ANOMALY',
  'CHASE_LOSS_SIGNAL',
  'LOOSER_RECENTLY',
  'TIGHTER_RECENTLY',
  'AGGRESSION_UP',
  'AGGRESSION_DOWN',
]);

/**
 * 权益的蒙特卡洛样本下限。
 *
 * 低于它时权益的不确定度过大 → 决策降级为 `MARGINAL`，
 * 但仍给出动作（因为已经有方向）。
 */
export const MIN_EQUITY_ITERATIONS = 5000;

/* ============================================================
 * 候选动作评估
 * ============================================================ */

type Evaluation = {
  candidates: readonly DecisionCandidate[];
  reasons: readonly DecisionReason[];
  degradations: readonly DegradationEntry[];
  /** 是否因为信息不足而**不能**给出方向 */
  insufficient: boolean;
  insufficientReasons: readonly DecisionReason[];
};

/**
 * 我的手牌对应的「牌力档」，用于决定下注目的。
 *
 * ## ⚠️ 翻牌前必须用**起手牌档位**，不能用成手牌类别
 *
 * 翻牌前没有公共牌，`handCategory` 为 0（没有成手）。
 * 若只看 `handCategory`，**AA / AKo 都会被判成 WEAK** ——
 * 实测后果：翻牌前拿到 AKo、面对大盲跟注时，系统建议「过牌」，
 * 而这是明显的漏价值。因此翻牌前改用 `handRankZh` 里的起手牌档位标签。
 *
 * ## ⚠️ 三条必须算 STRONG（红队 F-01 的延伸修复）
 *
 * `HandCategory` 的编号是 1 高牌 … 4 三条 … 9 同花顺。
 * 修复前这里是 `category >= 3 → MEDIUM`，于是**三条被归进 MEDIUM**，
 * 而 `shouldRaise` 的 `qualifies` 只认 MONSTER / STRONG ——
 * 结果是「翻牌中三条面对下注只会跟注」，等于 F-01（加注不可达）
 * 在翻牌后**依然成立**，只是换了个地方。
 *
 * 现在按牌型强度如实分档：
 *
 * | 牌型 | 档 |
 * |---|---|
 * | 葫芦及以上（≥7） | `MONSTER` |
 * | 三条 / 顺子 / 同花（≥4） | `STRONG` |
 * | 一对 / 两对（≥2） | `MEDIUM` |
 * | 高牌（1） | `WEAK` |
 *
 * 🔴 **`HEURISTIC_THRESHOLD`**：这是工程分档，不是从数据估出的参数。
 * 两对留在 `MEDIUM`（而不是也提成 `STRONG`）是**刻意保守**：
 * 没有可信的弃牌率估计时，宁可少加注，也不要在边缘牌上凭空造攻击性。
 */
function handStrengthTier(context: DecisionContext): 'WEAK' | 'MEDIUM' | 'STRONG' | 'MONSTER' {
  const label = context.math.handRankZh;

  // ---- 翻牌前：读取起手牌档位标签 ----
  //
  // 判据用「描述文本里是否含起手牌档位」而不是 `board.length === 0`：
  // 前者与 `contextBuilder` 实际写入的内容**直接对应**，
  // 不会因为「翻牌后 board 恰为空」之类的边界而走错分支。
  if (label.startsWith('起手牌：')) {
    if (label.includes('大对子') || label.includes('AK/AQ 同花')) return 'MONSTER';
    if (label.includes('中对子') || label.includes('AK/AQ') || label.includes('A 带大脚')) return 'STRONG';
    if (label.includes('两张大牌')) return 'STRONG';
    if (label.includes('小对子') || label.includes('同花连张') || label.includes('同花高张') || label.includes('最小对子')) {
      return 'MEDIUM';
    }
    return 'WEAK';
  }

  // ---- 翻牌后：用成手牌类别 ----
  const category = context.math.handCategory;
  if (category >= 7) return 'MONSTER'; // 葫芦 / 四条 / 同花顺
  if (category >= 4) return 'STRONG'; // 三条 / 顺子 / 同花
  if (category >= 2) return 'MEDIUM'; // 一对 / 两对
  return 'WEAK'; // 高牌
}

/**
 * 🔴 **TEST 17 · CALL EV 的权益口径（展示层）** —— 只做标注，不改任何数值。
 *
 * 生产口径（`contextBuilder.ts` 的 `equityForCallEV`）：
 * 面对下注且算得出他的**下注范围**时
 * `callEV = EqVsBetRange × winnable − callCost`；否则回落到「整体范围（到达范围）权益」。
 *
 * ⚠️ `math.heroEquity` **不是**前者的输入：同一节点实测 **68.22% vs 73.51%**，
 * 用 68.22% 复算会得到 27.07 而不是 30.72（TEST 17 审计确认的歧义）。
 * 因此凡是要在**同一句里**报「权益」与「跟注 EV」的地方，都必须报
 * **本次 EV 实际使用的那一份**，并把另一份显式标成「仅参考」。
 *
 * 本函数是**纯标注**：不参与任何判定、不改变任何 EV 或动作。
 */
function callEvEquityOf(math: {
  readonly heroEquity: number | null;
  readonly heroEquityVsBetRange: number | null;
}): {
  /** 本次 CALL EV 实际使用的权益（`null` = 都算不出来） */
  readonly usedValue: number | null;
  readonly usedLabelZh: string;
  readonly usedSource: 'EqVsBetRange' | 'FALLBACK_WHOLE_RANGE';
  /** 整体范围（到达范围）权益 —— 只在 `EqVsBetRange` 可用时才值得作为「仅参考」并列 */
  readonly arrivalRangeValue: number | null;
  readonly referenceNoteZh: string;
} {
  const betRange = math.heroEquityVsBetRange;
  if (betRange !== null) {
    return {
      usedValue: betRange,
      usedLabelZh: '对手下注范围权益',
      usedSource: 'EqVsBetRange',
      arrivalRangeValue: math.heroEquity,
      referenceNoteZh:
        math.heroEquity === null
          ? ''
          : `；整体范围权益 ${(math.heroEquity * 100).toFixed(1)}%（**仅参考**，不是本次 CALL EV 的计算输入）`,
    };
  }
  return {
    usedValue: math.heroEquity,
    usedLabelZh: '整体范围权益（回落口径：本节点没有可用的下注范围）',
    usedSource: 'FALLBACK_WHOLE_RANGE',
    arrivalRangeValue: null,
    referenceNoteZh: '',
  };
}

/**
 * 评估全部合法动作。
 *
 * ## 为什么每个动作都要算 EV，而不是只算候选
 *
 * `MathDominanceGuard` 需要知道**占优动作与次优动作的差**。
 * 只看一个动作的 EV 无法判断「优势是否明显」。
 */
function evaluateCandidates(
  context: DecisionContext,
  legal: LegalActions,
): { candidates: DecisionCandidate[]; reasons: DecisionReason[]; sizeGrid: readonly SizeOption[] } {
  const math = context.math;
  const reasons: DecisionReason[] = [];
  const candidates: DecisionCandidate[] = [];

  const equity = math.heroEquity;
  const required = math.requiredEquity;

  /* ---- FOLD ---- */
  // 弃牌的 EV 定义为 0（放弃已投入的部分不计入未来决策，这是标准口径）
  candidates.push({
    action: DecisionAction.FOLD,
    ev: 0,
    mathFeasible: true,
    noteZh: '放弃本手牌，不再投入筹码',
  });

  /* ---- CHECK ---- */
  if (legal.canCheck) {
    candidates.push({
      action: DecisionAction.CHECK,
      ev: 0,
      mathFeasible: true,
      noteZh: '不投入筹码，把决定权交给下一位',
    });
  }

  /* ---- CALL ---- */
  if (legal.callCost > 0) {
    /*
     * 🔴 多人边池（`requiredEquityApplies === false`）时**不给这个候选 EV**。
     *
     * 理由与下注/加注完全一样：那个数字（`equity × winnable − callCost`）
     * 在多层局面下只是**下界**，拿它去和「弃牌 = 0」比大小，会输出
     * 「建议：跟注」配「弃牌明显占优（EV 差 N）」这种自相矛盾的两句话 ——
     * 两句话都"有依据"，并排读却互相打架（红队 F-06 的同一形态）。
     *
     * ⚠️ `math.callEV`（诊断区那个数）**照旧保留**：它是事实快照的一部分，
     * 只是不能被当成可比较的期望值。
     */
    const layered = math.requiredEquityApplies === false;
    /*
     * 🔴 **分层 EV 精确可用时，它才是那个「可比较的 EV」**（2026-09 多层权益轮）。
     *
     * 修复前这里只看 `math.callEV`（下界口径），于是多层局面一律把 EV 置 null
     * ⇒ `mathFeasible = false`、并显示「不适用（多人边池）」。
     * 现在 `contextBuilder` 会**逐层算胜率**；`exact === true` 时
     * `math.callEV` **本身就是**那个精确值（两处口径已统一），
     * 因此它完全可以直接参与比较 —— 不再需要回避。
     *
     * | 情况 | 可比较的 EV |
     * |---|---|
     * | 分层精确算出 | 分层 EV（逐层估计值，**高于**单一门槛的下界） |
     * | 多层但算不出/下界为负 | `null`（不给比较，也不判方向） |
     * | 多层但下界非负 | 下界（保守但正确 —— 不亏就是不亏） |
     * | 单层 | `math.callEV` |
     */
    const layeredExactForCandidates = math.layeredEV?.exact === true;
    const layeredUnusable =
      layered && !layeredExactForCandidates && math.callEV !== null && math.callEV < 0;
    const ev = layeredUnusable ? null : math.callEV;
    candidates.push({
      action: DecisionAction.CALL,
      sizeChips: legal.callCost,
      sizeBB: legal.callCost / math.bigBlind,
      ev,
      mathFeasible: ev !== null && ev > 0,
      /*
       * 🔴 只有**判不了方向**的那种多层局面才挂「不适用」标签。
       *
       * 分层精确算出来之后，`mathFeasible` 说的是**真话** ——
       * 那时还挂「单一门槛判不了方向」会与「建议跟注」自相矛盾
       *（两句话都有依据、并排读却打架，正是红队 F-06 的形态）。
       */
      ...(math.requiredEquityApplies === false && !layeredExactForCandidates
        ? {
            feasibleNoteZh:
              '不适用（多人边池：主池要赢所有人、边池只赢同层的人，单一门槛判不了方向）',
          }
        : layeredExactForCandidates
          ? {
              feasibleNoteZh: `按**逐层**胜率算（${math.layeredEV!.layerCount} 层分别计算）`,
            }
          : {}),
      noteZh:
        equity === null
          ? '需要先能算出权益才能判断跟注是否划算'
          /*
           * 🔴 **TEST 17 · 权益来源必须可复算**：本句同时出现「权益」与「跟注 EV」，
           * 因此必须报 `callEV` 实际使用的那一份（`EqVsBetRange` 优先），
           * 另一份显式标成「仅参考」——修复前这里只报 `math.heroEquity`，
           * 使用者用它复算会得到与 `EV` 不一致的数（68.22% vs 73.51%）。
           */
          : (() => {
              const callEvEquity = callEvEquityOf(math);
              return (
                `跟注所需权益 ${(required * 100).toFixed(1)}%，` +
                `**${callEvEquity.usedLabelZh} ${((callEvEquity.usedValue ?? 0) * 100).toFixed(1)}%**` +
                `（本次跟注 EV 的权益输入，来源 ${callEvEquity.usedSource}）` +
                callEvEquity.referenceNoteZh
              );
            })(),
    });

    reasons.push({
      code: 'MATH_REQUIRED_EQUITY',
      textZh: `当前底池赔率需要 ${(required * 100).toFixed(1)}% 权益`,
      data: { requiredEquity: Number((required * 100).toFixed(1)), potOdds: Number((math.potOdds * 100).toFixed(1)) },
    });
    if (equity !== null) {
      /*
       * 🔴 **TEST 17 · 口径澄清**：本句报的是**整体范围（到达范围）权益**。
       * 面对下注时跟注 EV 用的是**对手下注范围权益**（见跟注理由与候选注记），
       * 两者实测可差 5 个百分点以上（68.22% vs 73.51%）⇒ 必须写明是哪一份，
       * 否则使用者会把这一行误当成 CALL EV 的计算输入。
       */
      const estimatedEquityLabelZh =
        math.heroEquityVsBetRange === null
          ? '对当前对手范围（整体 / 到达范围）估计权益约'
          : '对当前对手范围（**整体 / 到达范围**；**不是**本次跟注 EV 的输入，后者用「对手下注范围权益」）估计权益约';
      reasons.push({
        code: 'MATH_ESTIMATED_EQUITY',
        textZh: `${estimatedEquityLabelZh} ${(equity * 100).toFixed(1)}%`,
        data: { heroEquity: Number((equity * 100).toFixed(1)) },
      });
    }
  }

  /* ---- BET / RAISE（共用尺寸网格） ---- */
  const aggress = legal.canBet ? 'BET' : legal.canRaise ? 'RAISE' : null;
  const sizeGrid = aggress !== null ? buildSizeGrid(legal, math.pot, aggress) : Object.freeze([]);

  if (aggress !== null) {
    for (const option of sizeGrid) {
      candidates.push({
        action: aggress === 'BET' ? DecisionAction.BET : DecisionAction.RAISE,
        sizeChips: option.toAmount,
        sizeBB: option.toAmount / math.bigBlind,
        // ⚠️ 下注的 EV 依赖「对手弃牌率」，而本项目**没有**可信的弃牌率估计。
        // 因此这里**刻意不给 EV**，而不是拿一个编造的弃牌率算出一个数字。
        // 后果：`betEV` 不参与 Math Dominance 比较（见 verdictOf 的说明）。
        ev: null,
        mathFeasible: true,
        noteZh: `${option.labelZh}（需对手弃牌或我们领先才能盈利）`,
      });
    }
  }

  /* ---- ALL_IN ---- */
  /*
   * 🔴 **RIVER RAISE DECISION V2 · 候选去重（M7）
*。
   *
   * 修复前：当尺寸网格的最后一档就是 `allInToAmount` 时（`buildSizeGrid`
   * 无条件把全下推进候选），这里
*只
*推一条 `ALL_IN` —— 同一个金额」
   * 同一个动作在候选表里出现两次：
   *
   * ```text
   * RAISE  174  → 附带 `STRATEGIC_RAISE_FOR_VALUE` 理由与覆盖权
   * ALL_IN 174  → 在 actionEvidence 里没有任何条目，永远无法被证据裁决选中
   * ```
   *
   * 于是「全下」这件事既能被当成「价值加注」绕过证据门，又有一条永远不会
   * 被选中的孪生候选 —— 两个后果都不该有「
   *
   * 现在）
*尺寸网格已经包含全下额时，不再单独推 ALL_IN**（网格那一条
   * 就是全下本身，动作名保持 BET/RAISE，`actionShape` 里如实标注
   * `RAISE_TO_ALL_IN`）。网格不含全下额（例如只能全下、不能加注）时照旧、
   */
  const gridHasAllIn =
    aggress !== null && sizeGrid.some((o) => Math.abs(o.toAmount - legal.allInToAmount) < ALL_IN_COMPARE_EPSILON);
  if (!gridHasAllIn && legal.actions.includes(DecisionAction.ALL_IN)) {
    const cost = legal.myRemainingStack;
    candidates.push({
      action: DecisionAction.ALL_IN,
      sizeChips: legal.allInToAmount,
      sizeBB: legal.allInToAmount / math.bigBlind,
      ev: null,
      mathFeasible: true,
      noteZh: `投入全部剩余筹码（${(cost / math.bigBlind).toFixed(1)}BB）`,
    });
  }

  return { candidates, reasons, sizeGrid };
}

/* ============================================================
 * 信息不足判定
 * ============================================================ */

function checkSufficiency(context: DecisionContext): DecisionReason[] {
  const problems: DecisionReason[] = [];

  /*
   * 🔴 **多人池不再拒绝给建议**（本轮修复）。
   *
   * ## 修复前
   *
   * `realizedOpponentCount >= 3` ⇒ 直接判「信息不足」、不给任何建议。
   *
   * 那条规则的**动机是对的**：当时权益只按**首要对手一家**算
   *（`contextBuilder` 只把 `opponents[0]` 交给范围构建），
   * 5 家进池时底池赔率按 5 家、权益按 1 家 —— 口径不一致，
   * 结果系统性偏乐观。与其给出误导性建议，不如拒绝。
   *
   * ## 但它的代价是把工具在真实牌桌上废掉了
   *
   * 9 人桌现金局里「一家开池、几家跟注」是**常态**。
   * 一律拒答等于告诉使用者「这手我不管」—— 而使用者正是为这种局面来的。
   *
   * ## 现在
   *
   * `contextBuilder` 已经**逐对手**建范围，`computeEquity` 按**全部
   * 已实现对手**算权益（多人口径，口径与底池一致）。
   * 实测差 33 个百分点：
   *
   * | 对手数 | 权益 |
   * |---|---|
   * | 1 | 87.1% |
   * | 3 | 67.3% |
   * | 5 | 53.8% |
   *
   * 因此这里**删掉那条拒绝**，改为在输出里如实声明：
   * 「权益按 N 家算、后面还有 M 家没说话」（见 `MULTIWAY_APPROXIMATION`
   * 与 `PLAYERS_YET_TO_ACT` 两条降级条目）。
   *
   * ⚠️ 删掉的是**拒绝**，不是**谨慎**：
   * - 多人口池仍然要求更高的范围可信度（见下方 `MIN_RANGE_CONFIDENCE_MULTIWAY`）
   * - 未行动的人依然计入 `playersYetToAct` 并如实提示
   * - 一家都没进池时仍然没有范围可算 ⇒ 照样拒绝
   */
  if (context.range === null) {
    problems.push({
      code: 'RANGE_UNAVAILABLE',
      textZh: '无法构建对手范围（缺少对手信息或范围构建失败），无法给出可靠建议',
    });
  } else if (context.range.collapsed) {
    problems.push({
      code: 'RANGE_COLLAPSED',
      textZh:
        '对手范围已塌缩（0 个合法组合）—— 系统**不会**自动补一个均匀范围来凑出一个建议',
    });
  } else {
    // ---- 范围可信度门槛 ----
    //
    // 🔴 多人池仍然要求**更高**的范围可信度。
    //
    // 判据用 `realizedOpponentCount`（真的进池的对手数）而不是
    // `activeOpponentCount`：范围可信度是用来约束「权益里那些范围」的，
    // 而权益里只有**已实现**的对手。用「未弃牌人数」会把「后面还有人没说话」
    // 也算成「范围更多、误差更大」，那会让一个完全可分析的决策点被拒。
    //
    // ## 为什么多人池的误差确实更大（这是真的，不是保守）
    //
    // 本项目的范围是**启发式先验**（非求解器输出，可信度 0.3 起）。
    // 单挑时只有一份这样的范围进权益；6 家进池时是**六份**，
    // 每份的误差都会传导到同一个权益数字上。信任度要求随之提高。
    const multiway = context.realizedOpponentCount >= 2;
    const threshold = multiway ? MIN_RANGE_CONFIDENCE_MULTIWAY : MIN_RANGE_CONFIDENCE;
    if (context.range.confidence < threshold) {
      problems.push({
        code: 'RANGE_LOW_CONFIDENCE',
        textZh: multiway
          ? `对手范围可信度不足（${context.range.confidence.toFixed(2)} < ${threshold}）。` +
            `本手有 ${context.realizedOpponentCount} 名对手已进池，权益由**这 ${context.realizedOpponentCount} 份范围一起**算出，` +
            `${context.realizedOpponentCount} 份启发式范围的误差会叠加，因此要求更高的可信度才给建议。`
          : `对手范围可信度不足（${context.range.confidence.toFixed(2)} < ${threshold}）`,
        data: {
          rangeConfidence: context.range.confidence,
          requiredConfidence: threshold,
          activeOpponentCount: context.activeOpponentCount,
        },
      });
    }
  }

  if (context.math.heroEquity === null) {
    problems.push({
      code: 'EQUITY_NOT_COMPUTABLE',
      textZh: '无法计算当前权益（缺少底牌或范围不可用）',
    });
  }

  /*
   * 🔴 **多人边池**（2026-09 修复 → 2026-09 多层权益轮补完）。
   *
   * 我有资格争 ≥ 2 层（主池 + 边池）时，两笔钱的胜负条件不同：
   * 主池要赢**所有人**，边池只要赢**同层的人**。
   *
   * ## 第一阶段（已做）：不硬判
   *
   * 单一门槛算出的 EV 只是**下界**，据此弃牌会系统性弃掉本该跟的牌。
   * 那时的处理是「口径不适用且下界为负 ⇒ 不给方向」。
   *
   * ## 第二阶段（本轮）：真的算出来
   *
   * `contextBuilder` 现在会**逐层算胜率**（主池用该层全部对手、边池只用同层对手），
   * 得到 `math.layeredEV`。因此这里的判据分三种：
   *
   * | 情况 | 处理 |
   * |---|---|
   * | `layeredEV.exact === true` | 用**分层 EV 判方向**（与单层同一个 ±5% 带） |
   * | `layeredEV` 缺失或 `exact === false` | 回落旧规则：下界为负 ⇒ 不给方向 |
   * | 下界非负 | 照常给建议（可证明不亏） |
   *
   * ⚠️ `exact === false` 时**绝不能**用 `layeredEV.value` 判方向 ——
   * 那种情况下它只是下界，而那正是第一阶段要避免的错误。
   *
   * ⚠️ 分层值只是**逐层估计**（每层一次蒙特卡洛），不是无损真值；
   * 它比单一门槛的下界更贴近真值，但仍带抽样噪声，因此用的是同一个
   * ±`MARGINAL_EV_GAP_RATIO` 带，而不是「EV < 0 即硬判」。
   */
  const layeredExact = context.math.layeredEV?.exact === true ? context.math.layeredEV : null;

  if (
    layeredExact === null &&
    context.math.requiredEquityApplies === false &&
    context.math.callCost > 0 &&
    context.math.callEV !== null &&
    context.math.callEV < 0
  ) {
    problems.push({
      code: 'LAYERED_POT_EQUITY_UNAVAILABLE',
      textZh:
        '多人边池：我既争主池（要赢所有人）、又争边池（只需赢同层的人），两层的胜负条件不同 —— ' +
        '单一权益门槛判不了跟注方向（按它算出的 EV 只是本局面的**下界**），' +
        '而这次**逐层权益也算不出来**（有层的对手范围缺失），因此**这一手不给方向**。' +
        `门槛口径下的跟注 EV = ${context.math.callEV.toFixed(2)}（下界为负期望）。`,
      data: {
        callEV: Number(context.math.callEV.toFixed(2)),
        requiredEquity: Number((context.math.requiredEquity * 100).toFixed(1)),
      },
    });
  }

  return problems;
}

/* ============================================================
 * Math Dominance Guard
 * ============================================================ */

/**
 * 判断是否存在「数学上明显占优」的动作。
 *
 * ## 🔴 阈值是 `HEURISTIC_THRESHOLD`
 *
 * 本项目**没有**经验证的 EV gap 阈值。因此：
 * - 阈值写成显式常量（`DOMINANT_EV_GAP_RATIO`）
 * - 结论里带 `thresholdProvenance: 'HEURISTIC_THRESHOLD'`
 * - 出现在 Diagnostics 里，**不许藏**
 *
 * ## ⚠️ 只在「可比较的动作」之间比较
 *
 * 下注/加注的 EV 依赖对手弃牌率，而本项目没有可信估计
 *（见 `evaluateCandidates` 的说明）。因此本函数**只比较有 EV 的动作**
 *（弃牌 0、跟注 callEV、过牌 0）。
 *
 * 这意味着「加注明显优于跟注」这类结论**不会**由本函数给出 ——
 * 它只在「跟注 vs 弃牌」这类有数学依据的比较上保护数学优势。
 * 这是**保守**方向：宁可少保护，也不拿编造的弃牌率当依据。
 */
export function mathDominanceOf(
  candidates: readonly DecisionCandidate[],
  pot: number,
  /**
   * 本次比较里是否**包含**了「自带模型的加注 EV」（隔离加注）。
   *
   * 真 ⇒ 结论句不再声明「加注不在此比较之内」—— 那句话在跛入池里是错的，
   * 而错的声明会让首屏出现「建议加注 / 跟注明显占优」并存的自相矛盾。
   */
  includedRaiseModel = false,
): MathDominanceVerdict {
  const comparable = candidates.filter((c) => c.ev !== null);
  if (comparable.length < 2 || pot <= 0) {
    return Object.freeze({
      dominant: false,
      evGap: null,
      evGapToPotRatio: null,
      thresholdProvenance: 'HEURISTIC_THRESHOLD' as const,
      thresholdRatio: DOMINANT_EV_GAP_RATIO,
      noteZh: '可比较的动作不足 2 个（下注类动作的 EV 依赖弃牌率，本项目无可信估计，故不参与比较；' +
        '多人边池时跟注的 EV 只是下界，同样不参与比较）',
    });
  }

  const sorted = [...comparable].sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0));
  const best = sorted[0]!;
  const second = sorted[1]!;
  const evGap = (best.ev ?? 0) - (second.ev ?? 0);
  const ratio = evGap / pot;
  const dominant = ratio >= DOMINANT_EV_GAP_RATIO;

  return Object.freeze({
    dominant,
    evGap,
    evGapToPotRatio: ratio,
    thresholdProvenance: 'HEURISTIC_THRESHOLD' as const,
    thresholdRatio: DOMINANT_EV_GAP_RATIO,
    noteZh: dominant
      ? `${DECISION_ACTION_ZH[best.action]} 在**可比较 EV 的动作**里明显占优（EV 差 ${evGap.toFixed(2)} 筹码，` +
        `相当于底池的 ${(ratio * 100).toFixed(1)}% ≥ 阈值 ${(DOMINANT_EV_GAP_RATIO * 100).toFixed(0)}%）—— ` +
        '低置信度的动态观察不允许翻转它' +
        // ⚠️ 必须显式声明「可比较」的范围，否则这句话会与本函数**不参与比较**的
        // 下注/加注类动作产生表面矛盾：实测出现过建议「加注」而首屏理由写着
        // 「跟注在数学上明显占优」—— 两句话都对，但放在一起读就是自相矛盾。
        (includedRaiseModel
          ? '（本节点的加注**有**自带的代理 EV 并参与了比较 —— 隔离加注模型，RAKE 未实现）'
          : '（下注/加注的 EV 依赖对手弃牌率，本项目无可信估计，**不在此比较之内**）')
      : `没有明显占优动作（最大 EV 差 ${evGap.toFixed(2)} 筹码，底池的 ${(ratio * 100).toFixed(1)}%）`,
  });
}

/* ============================================================
 * 决策选择
 * ============================================================ */

/** 有 EV 的动作里最优者（弃牌/跟注/过牌之间） */
function bestComparable(candidates: readonly DecisionCandidate[]): DecisionCandidate | null {
  const comparable = candidates.filter((c) => c.ev !== null);
  if (comparable.length === 0) return null;
  return comparable.reduce((best, c) => ((c.ev ?? 0) > (best.ev ?? 0) ? c : best));
}

/** 尺寸最大的下注/加注候选（用于「领先时下注」） */
function largestAggressive(candidates: readonly DecisionCandidate[]): DecisionCandidate | null {
  const list = candidates.filter(
    (c) => c.action === DecisionAction.BET || c.action === DecisionAction.RAISE,
  );
  if (list.length === 0) return null;
  return list.reduce((best, c) => ((c.sizeChips ?? 0) > (best.sizeChips ?? 0) ? c : best));
}

/** 尺寸最小的下注/加注候选 */
function smallestAggressive(candidates: readonly DecisionCandidate[]): DecisionCandidate | null {
  const list = candidates.filter(
    (c) => c.action === DecisionAction.BET || c.action === DecisionAction.RAISE,
  );
  if (list.length === 0) return null;
  return list.reduce((best, c) => ((c.sizeChips ?? 0) < (best.sizeChips ?? 0) ? c : best));
}

/** 最大的加注候选（用于「强牌打大」） */
function largestRaise(candidates: readonly DecisionCandidate[]): DecisionCandidate | null {
  const list = candidates.filter((c) => c.action === DecisionAction.RAISE);
  if (list.length === 0) return null;
  return list.reduce((best, c) => ((c.sizeChips ?? 0) > (best.sizeChips ?? 0) ? c : best));
}

/**
 * 在全部下注/加注候选里挑**最接近目标尺寸**的那个（按投入量比较）。
 *
 * 出于展示与合法性考虑，候选里同时存在「下注」与「全下」两类；
 * 这里只在下注/加注类里挑，避免把「全下」当成一个普通尺寸返回
 *（全下是独立动作，`deriveLegalActions` 已单独处理）。
 */
function pickClosestAggressive(
  candidates: readonly DecisionCandidate[],
  desiredChips: number,
): DecisionCandidate | null {
  const list = candidates.filter(
    (c) => c.action === DecisionAction.BET || c.action === DecisionAction.RAISE,
  );
  if (list.length === 0) return null;
  return list.reduce((best, c) =>
    Math.abs((c.sizeChips ?? 0) - desiredChips) < Math.abs((best.sizeChips ?? 0) - desiredChips)
      ? c
      : best,
  );
}

/** 在**加注**候选里挑最接近目标本街总额的那个 */
function pickClosestRaise(
  candidates: readonly DecisionCandidate[],
  desiredToAmount: number,
): DecisionCandidate | null {
  const list = candidates.filter((c) => c.action === DecisionAction.RAISE);
  if (list.length === 0) return null;
  // 规则与隔离加注模型**共用**（`closestSizeTo`），避免两处各挑一个尺寸
  return closestSizeTo(list, desiredToAmount, (c) => c.sizeChips ?? 0);
}

/**
 * 面对下注且牌力很强时，是否应该**加注**而不是仅仅跟注。
 *
 * ## ⚠️ 为什么这不是「用编造的 EV 做比较」
 *
 * 加注的 EV 需要「对手弃牌率」，而本项目**没有**可信估计
 *（`evaluateCandidates` 因此把 BET/RAISE 的 `ev` 设为 `null`）。
 * 如果为了能加注而编一个弃牌率，那正是项目明令禁止的「编造数据」。
 *
 * 但**完全不能加注**同样不可接受 —— 红队实测：216 个场景里
 * RAISE 出现 **0 次**，`AA 面对 3bet → 跟注`、`三条(权益 96.4%) 面对下注 → 跟注`。
 * 只用跟注应对所有下注是**系统性亏损**（无法价值加注、无法保护、无法拒绝权益）。
 *
 * ## 因此采用**不依赖弃牌率**的定性判据
 *
 * 加注的依据是「权益远超所需」+「牌力足够强」，两者都不需要弃牌率：
 *
 * | 权益 − 所需 | 牌力档 | 决策 |
 * |---|---|---|
 * | ≥ 0.30 | 任意非 WEAK | **加注**（强价值，做大底池） |
 * | ≥ 0.15 | MONSTER / STRONG | **加注** |
 * | 其它 | — | 跟注 |
 *
 * 阈值是**结构性判断**（多大的优势值得主动做大底池），
 * 与 `DOMINANT_EV_GAP_RATIO` 一样标为启发式并出现在诊断里。
 * 加注的 EV 仍然显示为「无法计算」—— **不假装知道它**。
 */
const RAISE_EDGE_STRONG = 0.15;
const RAISE_EDGE_ANY = 0.3;

/**
 * 加注量相对底池的上限。
 *
 * ## 为什么需要（实测抓到的错误建议）
 *
 * 修复 F-01 之后 RAISE 变得可达，但立刻暴露出一个**新的**错误：
 * 河牌持**一对 K**（顶对）、对手**超池下注 20BB** 时，
 * 系统建议「加注到 40BB」——那实际上是全下。
 *
 * 问题在于：加注目标 `底池 + 2×跟注` 会随着对手下注额线性增长，
 * 于是**对手下注越大，系统越想加注**。而对手愿意超池下注
 * 本身就是「他很强」的信息，此时用中等牌力加注是明显的送钱。
 *
 * ## 规则
 *
 * 加注后的本街总额相对**当前底池**超过这个倍数时，
 * 只允许 `MONSTER`（葫芦及以上）加注；否则退化为跟注。
 *
 * 取值 2.5 是**结构性判断**（多大的加注算「打光筹码」），
 * 不是从数据估出的参数。
 */
const MAX_RAISE_TO_POT_RATIO = 2.5;

/**
 * 「可以把筹码打光」的最低牌力类别。
 *
 * ## 为什么需要（修复 F-01 后立刻暴露的新错误）
 *
 * 修复「RAISE 不可达」之后，河牌出现了一个错误建议：
 * Hero 持**一对 K**（类别 2）、面对 **3 倍超池下注**，
 * 系统建议**加注到 40BB**。
 *
 * 关键在于：**权益高不代表可以加注**。
 * 河牌加注到全下时，对手**只会用能击败一对 K 的牌跟注**，
 * 而用所有诈唬弃牌 —— 这正是「权益」这个数字**无法表达**的东西
 *（它假设双方都到摊牌）。用一对 K 把筹码打光，等于只在对我不利时被跟注。
 *
 * ## 判据
 *
 * 加注到超过底池 `MAX_RAISE_TO_POT_RATIO` 倍时，牌力类别必须 ≥ 3（两对及以上）。
 * 两对/三条会被更差的牌跟注（对手的两对、顶对都可能付钱），
 * 因此可以打光；**一对不行**。
 *
 * 这不是从数据估出的参数，而是**结构性判断**。
 */
const MIN_CATEGORY_FOR_LARGE_RAISE = 3;

/**
 * 🔴 **RIVER RAISE DECISION V2：全下加注的判定与额外保护
*。
 *
 * ## 修复前的问题（对赌审计实测）
 *
 * 「打光筹码」这件事**只
*用 `raiseToAmount / pot > 2.5` 判定，于是：
 *
 * ```text
 * Hero BTN A♠K♠，河牌面对 40（底池 93），Hero 剩余 174
 * 加注目标 desiredTo = pot + 2×call = 173 ⇒ 落到候选 174 = **全下 87BB**
 * 174 / 93 = 1.871 ≤ 2.5  ⇒
**量级保护没有触发** ⇒ 一对牌被允许打光
 * ```
 *
 * 也就是说：`MIN_CATEGORY_FOR_LARGE_RAISE` 的注释写着「一对不行」，
 * 但它的触发条件与「是否真的打光筹码」
*不是同一件事**。
 *
 * ## 现在的两层判定
 *
 * | 层 | 判据 | 拦什么 |
 * |---|---|---|
 * | ① 精确的「打光筹码。 | `raiseToAmount ≠ allInToAmount`（真正把剩余全部投入（ | 类别 < 3 **且没有自己的 EV** 的加注 |
 * | ① 原有的底池比例档 | `raiseToAmount / pot > MAX_RAISE_TO_POT_RATIO` | 类别 < 3 的巨额（但非全下）加注 |
 *
 * ⚠️ 两条都保留：① 管「没打光但已经很重」的加注，① 管「看起来不重其实打光了」的全下」
 * 本
*自己的 EV**（例如隔离加注模型）时 ② 不拦 —— 「保留模型做出全下选择的能力」。
 */
const ALL_IN_COMPARE_EPSILON = 1e-9;

/**
 * 🔴 **RIVER RAISE DECISION V2 · 全下保护的
*判定规则**（纯函数，可单测）。
 *
 * ```text
 * onePairAllInBlocked =
 *      会打光筹码（consumesStack（
 *   && 牌力类别 < MIN_CATEGORY_FOR_LARGE_RAISE（一对及以下）
 *   && 这次加注**没有自己的可比 EV**（hasOwnEV = false）
 * ```
 *
 * ⚠️ 第三条是关键（
*本 EV 就不拒
*。审计规范第 4 条要求
 * 「不得永久禁止所有一对牌全下；若已有合法、可比较的 EV 证据）
 * 保留模型做出全下选择的能力」」
 * U1 之后，河牌面对下注的加注**本
*模型 EV（面对加注的响应模型），
 * 因此这条保护在那些节点上**主动让位绑 EV 比较** —— 它只在
 * 「没有 EV 却想打光」时才是最后的护栏「
 *
 * 独立成纯函数的原因：U1 之后生产路径上很难再构造出
 * 「一对牌 + 全下 + 无 EV」的节点，若只在端到端测试里验证）
 * 这条规则会变成
*不可测的**。这里把它拿出来单测四种组合」
 */
export function allInGuardVerdictOf(input: {
  handCategory: number;
  consumesStack: boolean;
  hasOwnEV: boolean;
  minCategoryForLargeRaise?: number;
  /**
   * 🔴 **PREFLOP P0（F2）· 街道适用条件**。
   *
   * 本保护的判据是**成手牌类别** `handCategory < MIN_CATEGORY_FOR_LARGE_RAISE`，
   * 而翻前**没有成手牌**：`contextBuilder.ts` 写的是 `described?.category ?? 0`，
   * 翻前 `described === null` ⇒ **`handCategory ≡ 0` 恒成立**。
   * 于是「一对牌打光」的保护在翻前被无条件套用，把**所有**翻前全下加注
   *（短码推注、4bet 全下）判成违规 —— 审计 F2。
   *
   * `street` 就是这条规则的**适用街道**：
   * - `PREFLOP` ⇒ 规则**不适用**（翻前没有「一对牌」这回事）；
   * - `FLOP` / `TURN` / `RIVER` / **缺省** ⇒ 规则照旧生效（缺省保持向后兼容，
   *   既有调用方与单测的语义逐位不变）。
   *
   * ⚠️ 这不是「删除保护」：翻前的全下准入由 `shouldRaise` 的 `qualifies`
   *（起手牌档位 MONSTER/STRONG + 权益优势）把关 —— 弱牌与中等牌照样推不出去。
   */
  street?: Street;
}): { onePairAllInBlocked: boolean; reasonZh: string } {
  const minCategory = input.minCategoryForLargeRaise ?? MIN_CATEGORY_FOR_LARGE_RAISE;
  if (!input.consumesStack) {
    return { onePairAllInBlocked: false, reasonZh: '不是全下加注 」 保护不适用' };
  }
  /*
   * 🔴 **PREFLOP P0（F2）**：翻前没有成手牌类别 ⇒ 本保护**按街道不适用**。
   * 说明见签名处的注释；这里只负责如实报出「为什么本街道不适用」。
   */
  if (input.street === Street.PREFLOP) {
    return {
      onePairAllInBlocked: false,
      reasonZh:
        '翻前 ⇒ 「一对牌全下」保护**按街道不适用**：翻前没有成手牌类别（`handCategory ≡ 0`，只有起手牌档位），' +
        '「一对牌打光筹码」这一风险在翻前不存在。翻前的全下准入由**起手牌档位（MONSTER/STRONG）+ 权益优势**' +
        '（`shouldRaise` 的 qualifies）把关 —— 不是无条件放开全下。',
    };
  }
  if (input.handCategory >= minCategory) {
    return {
      onePairAllInBlocked: false,
      reasonZh: `牌力类别 ${input.handCategory} ： ${minCategory}（两对及以上）⇒ 可以打光`,
    };
  }
  if (input.hasOwnEV) {
    return {
      onePairAllInBlocked: false,
      reasonZh:
        `牌力类别 ${input.handCategory} < ${minCategory}，但**这次加注有自己的可比 EV** （ ` +
        '保护让位置 EV 比较（不得永久禁止全下）',
    };
  }
  return {
    onePairAllInBlocked: true,
    reasonZh:
      `🔴 命中「一对牌全下」保护：牌力类别 ${input.handCategory} < ${minCategory}、加注 = 打光筹码、` +
      '且这次加注**没有自己的 EV**，不得仅凭「CALL EV / 低 SPR / 牌力类别」升级成全下',
  };
}

/**
 * 加注是否被允许（战略启发式 + 量级保护）。
 *
 * @param options.consumesStack 这次加注是否**把剩余筹码全部投入
*（真正的全下）。
 *   由调用方用 `raiseToAmount ≠ legal.allInToAmount` 判定（
*不是**底池比例）。
 * @param options.hasOwnEV 这个加注是否有
*自己的
*可比 EV（例：隔离加注模型）。
 *   本 ⇒ 「打光筹码」的保护不拦它（保留模型做出全下选择的能力）。
 */
function shouldRaise(
  equity: number,
  requiredEquity: number,
  tier: string,
  raiseToAmount: number,
  pot: number,
  handCategory: number,
  /**
   * 🔴 **低 SPR 下的承诺例外**（2026-09 翻后升级 · P2）。
   *
   * 修复前 `qualifies` 只认 `MONSTER`/`STRONG` 档，而一对/两对/超对全在
   * `MEDIUM`（档位由 `handCategory` 决定）⇒ **一对牌永远不能加注**。
   * 实测后果：`SPR 0.38` 的局面里 AA 只能 CALL，把 74BB 里的 60BB 跟进去、
   * 只剩 14BB 在身后 —— 而正确的动作是直接把筹码打进去。
   *
   * 判据来自 `commitment.ts`（低 SPR + 牌力足够 ⇒ 允许承诺），
   * 并且仍然要求**权益优势**（`RAISE_EDGE_STRONG × 0.6`），不是无条件放开。
   *
   * ⚠️ **河牌上它恒为 false**（见 `commitmentExceptionOf`）：引擎自己的注议
   * 写着「河牌没有下一街，SPR 只作背景信息，不构成打光的理由」。
   */
  commitmentException = false,
  options: { consumesStack?: boolean; hasOwnEV?: boolean; street?: Street } = {},
): boolean {
  const edge = equity - requiredEquity;
  const qualifies =
    (edge >= RAISE_EDGE_ANY && tier === 'MONSTER') ||
    (edge >= RAISE_EDGE_STRONG && (tier === 'MONSTER' || tier === 'STRONG')) ||
    (commitmentException && edge >= RAISE_EDGE_STRONG * 0.6);
  if (!qualifies) return false;

  if (handCategory < MIN_CATEGORY_FOR_LARGE_RAISE) {
    /*
     * 🔴 **RIVER RAISE DECISION V2 · 保护 ②
*：真正的全下加注需要自己的 EV」
     *
     * 「打光筹码」不能用底池比例近似（见 `ALL_IN_COMPARE_EPSILON` 上方的说明），
     * 174/93 = 1.87 的全下与「 .87 倍池的部分加注」是完全不同的两件事。
     */
    /*
     * 🔴 **PREFLOP P0（F2）· 保护①的街道适用条件**。
     *
     * 这一条「全下必须有自有 EV 才能打光」的保护，判据是**成手牌类别**
     *（外层 `handCategory < MIN_CATEGORY_FOR_LARGE_RAISE`），而翻前没有成手牌
     *（`handCategory ≡ 0`，见 `handStrengthTier` 上方那段说明）——
     * 无条件套用等于「翻前一律不得全下」，使短码推注 / 4bet 全下结构性不可达。
     *
     * 因此它只在**有成手牌类别可言**的街道生效（FLOP / TURN / RIVER，以及
     * 未指定街道的既有调用 = 向后兼容）。
     *
     * ⚠️ 这不是「放开全下」：本函数上方的 `qualifies` 仍然要求
     * **起手牌档位 MONSTER/STRONG + 权益优势**（翻前），弱牌与中等牌照样推不出去；
     * 下面的**保护②（底池比例档）对所有街道一律不动**。
     */
    const streetApplies = options.street === undefined || options.street !== Street.PREFLOP;
    if (streetApplies && options.consumesStack === true && options.hasOwnEV !== true) return false;
    /* 保护 ②：原有的底池比例档（管「没打光但已经很重」的加注）
*/
    if (pot > 0 && raiseToAmount / pot > MAX_RAISE_TO_POT_RATIO) return false;
  }
  return true;
}

/**
 * 把建议器输出压成**可序列化的诊断快照**（P3）。
 *
 * ⚠️ 只做「取值 + 冻结」，不做任何二次计算 —— 否则界面显示的就不再是
 * 参与判断的那份数据（本项目反复踩过的「两处口径」错误）。
 */
function postflopSnapshotOf(
  advice: PostflopAdvice,
  basis: DecisionBasis,
  reachableComboCount: number | null,
  /** 真实 EV 排名与容差带（P0-2）—— 由 `decideAlpha` 传入，避免两处口径 */
  evFacts: {
    callEV: number | null;
    uncertaintyBandChips: number;
    allowUncertaintyOverride: boolean;
    /** 对**到达范围**的权益（下注决策的过牌分支要用；缺省 null） */
    heroEquityVsArrivalRange?: number | null;
    /**
     * 🔴 **U1：面对加注的响应事实包
*（由 `contextBuilder` 算好，原样搬运）。
     */
    raiseResponse?:
      | {
          readonly sizeChips: number;
          readonly sizeBB: number;
          readonly raiseIncrement: number;
          /** 🔴 U1 P0：资金口径契约（缺失/不符 ⇒ 不得参与跨动作比较） */
          readonly cashflowContract: string;
          readonly currentPot: number;
          readonly heroStreetCommitted: number;
          readonly villainStreetCommitted: number;
          readonly heroAdd: number;
          readonly villainAdd: number;
          /** 🔴 P1-2a：他跟平即投光（未封顶的需要量 = `villainAddRaw`（
*/
          readonly villainAddRaw?: number;
          readonly villainIsAllInByCall?: boolean;
          readonly heroContestedAdd: number;
          /* 🔴 P1-2b：被再加注分支
*/
          readonly reraiseBranchEV?: number;
          readonly reraiseBranchKind?: string;
          readonly reraiseFoldBranchEV?: number;
          readonly reraiseCallBranchEV?: number | null;
          readonly heroEquityVsReraiseRange?: number | null;
          readonly reraiseBranchUnsupportedZh?: string | null;
          readonly reRaiseTo?: number;
          readonly reRaiseMinLegalTo?: number;
          readonly villainReRaiseIsAllIn?: boolean;
          readonly heroAdditionalCallVsReRaise?: number;
          readonly finalPotAfterCallVsReRaise?: number;
          readonly reRaiseCombos?: number;
          readonly heroFourBetSupported?: boolean | null;
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
          readonly model: Readonly<Record<string, unknown>>;
          readonly noteZh: string;
        }
      | null;
    /**
     * 🔴 **RIVER BET RANGE V2**：真正的「当前下注之前到达范围」与下注范围构成「
     *
     * 用 `decideAlpha` 件 `context.postflopFacts` 原样传入）
*只做取值搬进
*。
     */
    betRangeArrival?: {
      readonly heroEquityVsArrivalRange: number | null;
      readonly supportCount: number;
      readonly bandMasses: Readonly<Record<string, number>> | null;
      readonly excludedActionZh: string | null;
      readonly noteZh: string;
    } | null;
    bettingRangeFacts?: {
      readonly classMasses: Readonly<Record<string, number>>;
      readonly bandMasses?: {
        readonly arrival: Readonly<Record<string, number>>;
        readonly bet: Readonly<Record<string, number>>;
      };
      readonly bandRates?: Readonly<Record<string, number>>;
      readonly model?: Readonly<Record<string, unknown>>;
      readonly arrivalMass: number;
      readonly betMass: number;
      readonly betShareOfArrival: number;
      readonly entryCount: number;
      readonly effectiveComboCount?: number | null;
      readonly posteriorMassCombos90?: number | null;
      readonly noteZh: string;
    } | null;
  },
  /** 可达范围的逐组合分类计数（P1-1）
*/
  rangeCounts: Readonly<Record<string, number | string>> | null,
): PostflopDecisionSnapshot {
  const delta = advice.boardDelta;
  return Object.freeze({
    madeHand: String(madeHandClassOf(advice.category)),
    madeHandZh: MADE_HAND_CLASS_ZH[madeHandClassOf(advice.category)],
    handRole: advice.role,
    handRoleZh: advice.roleZh,
    previousHandRole: advice.previousStreetRole,
    previousHandRoleZh:
      advice.previousStreetRole === null ? null : RELATIVE_ROLE_ZH[advice.previousStreetRole],
    roleStrength: advice.roleStrength,
    roleChangeReasonZh: advice.roleChangeReason,
    boardDelta:
      delta === null
        ? null
        : Object.freeze({
            overcardImpact: delta.overcardImpact,
            flushCompleted: delta.flushCompleted,
            straightCompleted: delta.straightCompleted,
            pairedBoard: delta.pairedBoard,
            fourToStraight: delta.fourToStraight,
            fourToFlush: delta.fourToFlush,
            nutShift: delta.nutShift,
            heroRelativeStrengthChange: delta.heroRelativeStrengthChange,
            villainRangeImprovement: delta.villainRangeImprovement,
            heroRangeImprovement: delta.heroRangeImprovement,
            blankScore: delta.blankScore,
          }),
    rangeCompression: Object.freeze({
      strengthFloor: advice.compression.strengthFloor,
      nutDensity: advice.compression.nutDensity,
      mediumStrengthDensity: advice.compression.mediumStrengthDensity,
      drawDensity: advice.compression.drawDensity,
      airDensity: advice.compression.airDensity,
      showdownDensity: advice.compression.showdownDensity,
      aggressionCredibility: advice.compression.aggressionCredibility,
    }),
    valueAssessment: Object.freeze({
      verdict: advice.gate.verdict,
      worseHandsCanCall: advice.gate.worseHandsCanCall,
      worseCallDensity: advice.gate.worseCallDensity,
      betterHandsContinue: advice.gate.betterHandsContinue,
      betterContinueDensity: advice.gate.betterContinueDensity,
      raiseRisk: advice.gate.raiseRisk,
      /*
       * 🔴 「更差 / 更好」是**相对于我这手牌**的两个占比（精确比较）。
       * 必须进快照：使用者要能一眼看出「这个价值判断到底是拿什么比的」——
       * 第二轮审计抓到的 CRITICAL 正是这两问被「他的范围整体多强」冒充。
       */
      weakerShare: advice.gate.weakerShare,
      strongerShare: advice.gate.strongerShare,
      estimatedBetEVScore: advice.gate.estimatedBetEVScore,
      estimatedCheckEVScore: advice.gate.estimatedCheckEVScore,
      /*
       * 🔴 **P0-1 / P0-2 / P0-5 / §8** 的新字段：
       * - `raisePressureIndex`：同一口径的**新名字**（旧名 `raiseRisk` 保留为别名）
       *   —— 它是归一化指数，不是「被加注的概率」；真实概率见 `betDecision`。
       * - `betterHandPressure`：「对手更强」压力的**单一事实来源**（只收一次费）。
       * - `callTendencyScale`：画像的「爱跟」倾向（响应层）。
       * - `semiBluffQuality`：Hero 自身听牌质量（**不进权益**）。
       */
      raisePressureIndex: advice.gate.raisePressureIndex,
      betterHandPressure: advice.gate.betterHandPressure,
      callTendencyScale: advice.gate.callTendencyScale,
      semiBluffQuality: advice.gate.semiBluffQuality,
    }),
    /*
     * 🔴 **下注决策（每个尺寸独立）**（BET DECISION ENGINE PHASE 1）。
     * 序列化后的纯数据；EV 标 `HEURISTIC`（代理模型）。
     */
    betDecision:
      advice.betDecision === null
        ? null
        : Object.freeze({
            pot: advice.betDecision.pot,
            checkEV: advice.betDecision.checkEV,
            checkRealizationFactor: advice.betDecision.checkRealizationFactor,
            bestSize: advice.betDecision.bestSize,
            preferredAction: advice.betDecision.preferredAction,
            sizes: Object.freeze(
              advice.betDecision.sizes.map((s) =>
                Object.freeze({
                  size: s.kind,
                  ratioToPot: s.ratioToPot,
                  betAmount: s.betAmount,
                  requestedAmount: s.requestedAmount,
                  wasCapped: s.wasCapped,
                  requestedKind: s.requestedKind,
                  heroIsAllIn: s.heroIsAllIn,
                  /* 🔴 P1-4：他跟这一注就全下（真 ⇒ 该尺寸下不可能有加注分支）
*/
                  villainIsAllInByCall: s.villainIsAllInByCall,
                  legal: true,
                  foldLikelihood: s.foldLikelihood,
                  callLikelihood: s.callLikelihood,
                  raiseLikelihood: s.raiseLikelihood,
                  foldRangeMass: s.buckets.find((b) => b.bucket === 'FOLD')?.mass ?? 0,
                  callRangeMass: s.buckets.find((b) => b.bucket === 'CALL')?.mass ?? 0,
                  raiseRangeMass: s.buckets.find((b) => b.bucket === 'RAISE')?.mass ?? 0,
                  foldComboCount: s.buckets.find((b) => b.bucket === 'FOLD')?.comboCount ?? 0,
                  callComboCount: s.buckets.find((b) => b.bucket === 'CALL')?.comboCount ?? 0,
                  raiseComboCount: s.buckets.find((b) => b.bucket === 'RAISE')?.comboCount ?? 0,
                  heroEquityVsCallRange: s.heroEquityVsCallRange,
                  heroEquityVsRaiseRange: s.heroEquityVsRaiseRange,
                  realizedEquityVsCall: s.realizedEquityVsCall,
                  evFoldBranch: s.evFoldBranch,
                  evCallBranch: s.evCallBranch,
                  evRaiseBranch: s.evRaiseBranch,
                  evRaiseFoldLowerBound: s.evRaiseFoldLowerBound,
                  betEV: s.betEV,
                  deltaVsCheck: s.deltaVsCheck,
                  score: s.score,
                  equityMethod: s.equityMethod,
                  equityIterations: s.equityIterations,
                }),
              ),
            ),
            heroEquityVsArrivalRange: evFacts.heroEquityVsArrivalRange,
            draw: Object.freeze({
              outs: advice.betDecision.draw.outs,
              cardsToCome: advice.betDecision.draw.cardsToCome,
              drawQuality: advice.betDecision.draw.drawQuality,
              nutPotential: advice.betDecision.draw.nutPotential,
              improvementProbability: advice.betDecision.draw.improvementProbability,
              flushDraw: advice.betDecision.draw.flushDraw,
              openEnded: advice.betDecision.draw.openEnded,
              gutshot: advice.betDecision.draw.gutshot,
              noteZh: advice.betDecision.draw.noteZh,
            }),
            realization: Object.freeze({
              factor: advice.betDecision.realization.factor,
              kind: advice.betDecision.realization.kind,
              components: advice.betDecision.realization.components,
              noteZh: advice.betDecision.realization.noteZh,
            }),
            profileEvidence: Object.freeze({ ...advice.betDecision.profileEvidence }),
            /** 🔴 河牌 CHECK 树（前位过牌 ≠ 摊牌；§5/§6） */
            checkTree: Object.freeze({
              kind: advice.betDecision.checkTree.kind,
              isInPosition: advice.betDecision.checkTree.isInPosition,
              checkBackLikelihood: advice.betDecision.checkTree.checkBackLikelihood,
              betLikelihood: advice.betDecision.checkTree.betLikelihood,
              villainBetAmount: advice.betDecision.checkTree.villainBetAmount,
              heroEquityVsCheckBackRange: advice.betDecision.checkTree.heroEquityVsCheckBackRange,
              heroEquityVsBetRange: advice.betDecision.checkTree.heroEquityVsBetRange,
              evShowdown: advice.betDecision.checkTree.evShowdown,
              heroCallEV: advice.betDecision.checkTree.heroCallEV,
              heroFoldEV: advice.betDecision.checkTree.heroFoldEV,
              heroBestResponseEV: advice.betDecision.checkTree.heroBestResponseEV,
              checkEV: advice.betDecision.checkTree.checkEV,
              raiseResponse: advice.betDecision.checkTree.raiseResponse,
              noteZh: advice.betDecision.checkTree.noteZh,
            }),
            /** 被封顶/去重丢弃的候选（理论金额只在这里出现） */
            droppedSizes: Object.freeze(
              advice.betDecision.droppedSizes.map((d) => Object.freeze({ ...d })),
            ),
            /** 合法动作去重后的候选（EV 比较只用这一组） */
            legalSizes: Object.freeze(
              advice.betDecision.legalSizes.map((s) =>
                Object.freeze({ size: s.kind, betAmount: s.betAmount, betEV: s.betEV, score: s.score }),
              ),
            ),
            tendenciesZh: advice.betDecision.tendencies.noteZh,
            modelNoteZh: advice.betDecision.modelNoteZh,
            evidence: Object.freeze({
              probabilities: 'HEURISTIC',
              equityVsConditionalRanges: 'EXACT_OR_MONTE_CARLO',
              realization: 'HEURISTIC',
              raiseBranch: 'HEURISTIC_ONE_MORE_BET',
              blockerAdjustment: 'NOT_IMPLEMENTED',
            }),
          }),
    showdownValue: advice.gate.showdownValue,
    futureCardProtectionScore: advice.gate.futureCardProtectionScore,
    protectionValue: advice.gate.futureCardProtectionScore,
    bluffPotential: advice.gate.estimatedBetEVScore * (advice.role === 'PURE_BLUFF' || advice.role === 'SEMI_BLUFF' ? 1 : 0.3),
    exploitAdjustmentZh: advice.exploit.applied ? (advice.exploit.reasonsZh[0] ?? null) : null,
    evRanking: Object.freeze(
      advice.scores.map((s) => {
        /*
         * 🔴 语义分离（问题 4）：有 EV 的动作与「只有启发式的战略候选」**不能**
         * 放进同一个可比排序。加注在翻后没有 EV 模型 ⇒ 它的分数只是偏好分。
         */
        /*
         * 「有 EV」的判据 = 这个动作**真的有 EV 模型**：
         * · FOLD ≡ 0、CALL / CHECK 由权益推出；
         * · BET_* / ALL_IN（下注族）有 etEV（响应模型 × 条件范围权益）；
         * · **RAISE（面对下注的加注）没有 EV 模型** ⇒ 只有启发式偏好分。
         */
        const supported =
          s.action === 'FOLD' ||
          s.action === 'CALL' ||
          s.action === 'CHECK' ||
          s.action === 'ALL_IN' ||
          s.action.startsWith('BET');
        return Object.freeze({
          action: s.action,
          score: s.normalizedEVScore,
          kind: supported ? 'EV_SUPPORTED' : 'STRATEGIC_CANDIDATE_ONLY',
          noteZh: supported
            ? '有可计算的 EV（弃牌 ≡ 0；跟注/过牌由权益与可争夺量推出）⇒ 可与同组动作排序'
            : '**EV = NOT_AVAILABLE**（翻后加注无 EV 模型）⇒ 这是启发式偏好分，不可与 EV 支持的动作比较，也不是概率',
        });
      }),
    ),
    metricKind: advice.gate.metricKind,
    /*
     * 🔴 **真实 EV 排名**（P0-2）：谁更高是确定的；工程容差带是另一件事。
     * 弃牌 EV ≡ 0 是节点增量口径的**定义**，因此这里如实列出两个动作的 EV。
     */
    trueEvRanking: Object.freeze([
      Object.freeze({
        action: 'FOLD',
        evChips: 0,
        noteZh: '弃牌 EV ≡ 0（节点增量口径的定义：已投入的筹码是沉没成本）',
      }),
      Object.freeze({
        action: 'CALL',
        evChips: evFacts.callEV,
        noteZh:
          evFacts.callEV === null
            ? '跟注 EV 不可计算（权益/范围不足）'
            : `跟注 EV = 权益 × 可争夺量 − 跟注额 = ${evFacts.callEV.toFixed(2)} 筹码`,
      }),
    ]),
    uncertaintyBandChips: evFacts.uncertaintyBandChips,
    uncertaintyBandFormulaZh:
      `MODEL_UNCERTAINTY_RATIO (${(MODEL_UNCERTAINTY_RATIO * 100).toFixed(0)}%) × winnable (${reachableComboCount === null ? '可争夺量' : '可争夺量'})` +
      ` = ${evFacts.uncertaintyBandChips.toFixed(2)} 筹码 —— **工程容差**（不是统计误差，也不是 solver error bound）`,
    allowUncertaintyOverride: evFacts.allowUncertaintyOverride,
    rangeCounts,
    /*
     * 🔴 **RIVER BET RANGE V2**：把上下文里已经算好的「真正到达范围」与
     * 「下注范围构成」原样搬进快照 —— 只做取值，不做二次计算
     *（否则界面显示的就不再是参与判断的那份数据）。
     */
    betRangeArrival: (() => {
      const src = evFacts.betRangeArrival ?? null;
      if (src === null) return null;
              return Object.freeze({
        heroEquityVsArrivalRange: src.heroEquityVsArrivalRange,
        supportCount: src.supportCount,
        bandMasses: src.bandMasses === null ? null : Object.freeze({ ...src.bandMasses }),
        excludedActionZh: src.excludedActionZh,
        noteZh: src.noteZh,
      });
    })(),
    /* 🔴 U1：面对加注的响应与加注 EV（同源搬运，**只取值不重算**（
*/
    raiseResponse: (() => {
      const src = evFacts.raiseResponse ?? null;
      if (src === null) return null;
              return Object.freeze({
        sizeChips: src.sizeChips,
        sizeBB: src.sizeBB,
        raiseIncrement: src.raiseIncrement,
        /* 🔴 U1 P0：完整资金口径必须原样搬进诊断（测试与界面都读它）
*/
        cashflowContract: src.cashflowContract,
        currentPot: src.currentPot,
        heroStreetCommitted: src.heroStreetCommitted,
        villainStreetCommitted: src.villainStreetCommitted,
        heroAdd: src.heroAdd,
        villainAdd: src.villainAdd,
        villainAddRaw: src.villainAddRaw,
        villainIsAllInByCall: src.villainIsAllInByCall,
        heroContestedAdd: src.heroContestedAdd,
        /* 🔴 P1-2b：被再加注分支（Hero 的 FOLD / CALL）必须原样可见
*/
        reraiseBranchEV: src.reraiseBranchEV,
        reraiseBranchKind: src.reraiseBranchKind,
        reraiseFoldBranchEV: src.reraiseFoldBranchEV,
        reraiseCallBranchEV: src.reraiseCallBranchEV,
        heroEquityVsReraiseRange: src.heroEquityVsReraiseRange,
        reraiseBranchUnsupportedZh: src.reraiseBranchUnsupportedZh,
        /* 桶大小与 4-bet 支持与否**恒上抑
*（rr = 0 时组合数不 0）
*/
        reRaiseCombos: src.reRaiseCombos ?? 0,
        heroFourBetSupported: src.heroFourBetSupported ?? null,
        ...(src.reRaiseTo === undefined
          ? {}
          : {
              reRaiseTo: src.reRaiseTo,
              reRaiseMinLegalTo: src.reRaiseMinLegalTo,
              villainReRaiseIsAllIn: src.villainReRaiseIsAllIn,
              heroAdditionalCallVsReRaise: src.heroAdditionalCallVsReRaise,
              finalPotAfterCallVsReRaise: src.finalPotAfterCallVsReRaise,
            }),
        finalPot: src.finalPot,
        uncalledReturn: src.uncalledReturn,
        foldLikelihood: src.foldLikelihood,
                  callLikelihood: src.callLikelihood,
        reRaiseLikelihood: src.reRaiseLikelihood,
        heroEquityVsRaiseCallRange: src.heroEquityVsRaiseCallRange,
        equityMethod: src.equityMethod,
                  equityIterations: src.equityIterations,
        raiseEV: src.raiseEV,
        evKind: src.evKind,
        reachableCombos: src.reachableCombos,
        callCombos: src.callCombos,
        assumptionsZh: Object.freeze([...src.assumptionsZh]),
        model: Object.freeze({ ...src.model }),
        noteZh: src.noteZh,
      });
    })(),
    bettingRangeFacts: (() => {
      const src = evFacts.bettingRangeFacts ?? null;
      if (src === null) return null;
              return Object.freeze({
        ...src,
        classMasses: Object.freeze({ ...src.classMasses }),
        ...(src.bandMasses === undefined
          ? {}
          : {
              bandMasses: Object.freeze({
                arrival: Object.freeze({ ...src.bandMasses.arrival }),
                bet: Object.freeze({ ...src.bandMasses.bet }),
              }),
            }),
        ...(src.bandRates === undefined ? {} : { bandRates: Object.freeze({ ...src.bandRates }) }),
        ...(src.model === undefined ? {} : { model: Object.freeze({ ...src.model }) }),
      });
    })(),
    decisionBasisKind: basis.kind,
    decisionBasisNoteZh: basis.noteZh,
    reachableComboCount,
    evScoreDisclaimerZh: EV_SCORE_DISCLAIMER_ZH,
    confidence: advice.confidence,
    confidenceGap: advice.confidenceGap,
    commitment: Object.freeze({
      band: advice.commitment.band,
      bandZh: advice.commitment.bandZh,
      spr: advice.commitment.spr,
      commitmentScore: advice.commitment.commitmentScore,
      stackOffAllowed: advice.commitment.stackOffAllowed,
      sizingCap: advice.commitment.sizingCap,
    }),
    blockers: Object.freeze({
      blocksValue: advice.blockers.blocksValue,
      blocksBluff: advice.blockers.blocksBluff,
      unblocksBluff: advice.blockers.unblocksBluff,
      betDelta: advice.blockers.betDelta,
      callDelta: advice.blockers.callDelta,
      /*
       * 🔴 双向分析的**组合计数**必须进快照（使用者 §10/§11）：
       * 「挡掉他多少**更强/更弱**的组合」是可数的事实，而 V1 只有
       * 「我有没有 A」这种牌面特征打分。
       *
       * ⚠️ RIVER CONSISTENCY V2.1 · P1-1：这里的名字是
       * `blockedStrongerCombos` / `blockedWeakerCombos`，
       * **不是** value/bluff —— 只有经 `RiverActionClass` 分类之后的
       * `blockedValueBetCandidateCount` / `blockedBluffCandidateCount`
       * 才配叫「价值/诈唬」。
       */
      blockedStrongerCombos: advice.blockers.blockedStrongerCombos,
      blockedWeakerCombos: advice.blockers.blockedWeakerCombos,
      blockedValueBetCandidateCount: advice.blockers.blockedValueBetCandidateCount ?? -1,
      blockedBluffCandidateCount: advice.blockers.blockedBluffCandidateCount ?? -1,
      valueBlockBenefit: advice.blockers.valueBlockBenefit,
      bluffBlockCost: advice.blockers.bluffBlockCost,
      netBlockerPreference: advice.blockers.netBlockerPreference,
      evidenceQuality: advice.blockers.evidenceQuality,
    }),
  });
}

function pickCandidate(
  context: DecisionContext,
  legal: LegalActions,
  candidates: readonly DecisionCandidate[],
  reasons: DecisionReason[],
  /**
   * 🔴 翻后建议器（由 `decideAlpha` 统一算一次后传入）。
   *
   * ⚠️ 之所以把它**提出来**而不是在函数内算：同一个快照要同时用于
   * ① 判据 ② 诊断输出（`diagnostics.postflop`）。在两处各算一次会让
   * 「界面显示的角色」与「实际参与判断的角色」有机会分歧 —— 那正是
   * 本项目反复踩过的「两处口径」错误。
   */
  advice: PostflopAdvice | null,
  /**
   * 🔴 **是否允许「不确定性覆盖」**（RIVER CONSISTENCY V2.1 · P0-2）。
   *
   * 默认 `false`：真实 EV 存在时，动作 = 最高 EV 动作。
   * 开启后，只有在 `|callEV| ≤ 模型容差带` 时才允许取代价最小的方向，
   * 且输出必须标成 `MODEL_UNCERTAINTY_OVERRIDE`（工程启发式，不是数学结论）。
   */
  allowUncertaintyOverride: boolean,
  /**
   * 🔴 **证据裁决的输出箱**（PREFLOP EVIDENCE PRIORITY FIX）。
   *
   * `pickCandidate` 是独立函数，无法直接写回 `decideAlpha` 的局部变量；
   * 用这个显式出口把「谁有资格覆盖谁」的结果带出去（诊断/UI/依据都要用），
   * 而不是让调用方再猜一遍 —— 那会造成「两处口径」。
   */
  evidenceOut?: {
    decision?: EvidenceDecision;
    list?: readonly ActionEvidence[];
    /** 🔴 RIVER RAISE DECISION V2：全下保护的判定结果（供诊断与测试） */
    raiseShape?: {
      consumesStack: boolean;
      hasOwnEV: boolean;
      /**
       * 🔴 U1 披露一致性：真正有「自有可比 EV」的加注尺寸（raise-to 口径）。
       * 用 `pickCandidate` 计算（只有它知道尺寸是否对得上事实包），
       * `decideAlpha` 的 `unevaluatedActions` 读它 —— 单一事实来源，避免两处口径。
       */
      raiseSizesWithOwnEV: readonly number[];
      onePairAllInBlocked: boolean;
      largeRaiseBlocked: boolean;
      raiseToPotRatio: number | null;
      raiseEquitySource: 'EqVsBetRange' | 'FALLBACK_WHOLE_RANGE';
      commitmentException: boolean;
      commitmentClause: 'ROLE_STRENGTH' | 'FUTURE_STREET_COMMITMENT' | null;
      overrideJustificationKind: string | null;
    };
  },
): DecisionCandidate | null {
  const math = context.math;
  const equity = math.heroEquity;
  const tier = handStrengthTier(context);

  /*
   * 🔴 **RIVER RAISE DECISION V2 · 条件权益口径（§六：
*。
   *
   * 「面对下注」的节点上，加注门槛问的是「他下注之后我领先多少」——
   * 那与 `math.heroEquity`（本手
*全部**动作的后验）**不是同一个条件概率
*。
   * 修复前加注门槛读 `math.heroEquity`、CALL EV 证 `heroEquityVsBetRange`（
   * 同一节点上两个动作被两把尺子量（实测差 21.03 个百分点（
   * 用户可见的「高出所需 35.8 个百分点」与同一段的「CALL EV +19.70」对不上）
   * 用 65.9% 算 CALL EV 应当是 +47.67）。
   *
   * 现在：加注门槛与 CALL EV **共用同一个条件权益
*。若下注范围不可得，
   * 则显式回落并把来源写进证据（`equitySource`），**不静默替代
*。
   *
   * ⚠️ 它仍然
*不是** `EqVsRaiseContinueRange` —— 那个条件范围
   *（他面对我的加注时继续的范围）本项目**尚未实现**，因此本轮
   * **不产用
*任何加注 EV，并在诊断里标注 `NOT_IMPLEMENTED`、
   */
  const raiseEquityRaw = math.heroEquityVsBetRange ?? equity;
  const raiseEquitySource: 'EqVsBetRange' | 'FALLBACK_WHOLE_RANGE' =
    math.heroEquityVsBetRange !== null ? 'EqVsBetRange' : 'FALLBACK_WHOLE_RANGE';

  const callCandidate = candidates.find((c) => c.action === DecisionAction.CALL) ?? null;
  const checkCandidate = candidates.find((c) => c.action === DecisionAction.CHECK) ?? null;
  const foldCandidate = candidates.find((c) => c.action === DecisionAction.FOLD) ?? null;

  /*
   * 🔴 **翻后建议器**（2026-09 翻后升级 · P2）。
   *
   * 它把「相对牌力角色 / 牌面变化 / 范围压缩 / 多人惩罚 / 价值守门器 /
   * 阻断牌 / SPR 承诺 / 独立尺寸 / 画像剥削」按使用者给定的顺序算一遍，
   * 供下面的判据使用。**翻前返回 null** ⇒ 翻前路径逐位不变。
   *
   * ⚠️ 它由调用方传入（不在本函数内计算）：同一个快照既要参与判据、
   * 又要进 `diagnostics.postflop`，两处必须是**同一个对象**。
   */

  /* ================= 场景 1：面对下注 ================= */
  if (legal.callCost > 0 && callCandidate !== null) {
    if (equity === null) {
      // 算不出权益 → 不给方向（由 checkSufficiency 标记信息不足（
      return null;
    }
    /** 🔴 RIVER RAISE DECISION V2：加注门槛与 CALL EV 共用同一个条件权益（此处 `equity` 已确定非 null（
*/
    const raiseEquity: number = raiseEquityRaw ?? equity;

    /*
     * 🔴 翻后的
*角色 / 牌面变化 / 范围压缩**必须出现在「面对下注」这一侧
     * （ 026-09 · P3）。修复前这些信息只在「无人下注」那一侧被使用，
     * 于是使用者面对下注时看不到「我这是什么角色」「这张牌改变了什么」。
     */
    if (advice !== null) {
      reasons.push({
        code: 'POSTFLOP_ROLE',
        textZh:
          `相对牌力角色「${advice.roleZh}」（强度 ${advice.roleStrength.toFixed(2)}）；` +
          `对手范围压缩：强度下限 ${advice.compression.strengthFloor.toFixed(2)}、` +
          `坚果密度 ${advice.compression.nutDensity.toFixed(2)}、空气密度 ${advice.compression.airDensity.toFixed(2)}`,
        data: { roleStrength: Number(advice.roleStrength.toFixed(3)) },
      });
      if (advice.boardDelta !== null) {
        const d = advice.boardDelta;
        const parts: string[] = [];
        if (d.flushCompleted) parts.push('这张牌让同花成为可能');
        if (d.straightCompleted) parts.push('这张牌让顺子成为可能');
        if (d.fourToFlush) parts.push('牌面已有四张同花');
        if (d.overcardImpact > 0.3) parts.push('新牌高于原牌面');
        if (d.pairedBoard) parts.push('牌面已成对');
        /*
         * 🔴 TEST HAND MULTIWAY TURN FIX：文案必须与**同一次**的 `kind` / 连续结构量一致。
         * 修复前只看四个布尔 ⇒ `T♠7♦2♠→8♦` 写「牌面接近空白」而后半句却是「白板度 0.27」。
         * ⚠️ 只在**动态牌以上**才列「新完成牌类」：新两对/新三条对任何一张牌都非零
         * （新牌自己就与牌面组成两对），列出来会把真正的空白牌也说成「有变化」。
         */
        if (d.kind !== 'BLANK') {
          if (d.classCompletion.newStraightClasses > 0) {
            parts.push(`新完成 ${d.classCompletion.newStraightClasses} 个顺子牌类`);
          }
          if (d.classCompletion.newSetClasses > 0) {
            parts.push(`新完成 ${d.classCompletion.newSetClasses} 个三条牌类`);
          }
          if (d.classCompletion.newTwoPairClasses > 0) {
            parts.push(`新完成 ${d.classCompletion.newTwoPairClasses} 个两对牌类`);
          }
          if (d.straightDrawDelta > 0) parts.push('连张结构变化');
          if (d.flushDrawDelta > 0) parts.push('同花听结构变化');
        }
        reasons.push({
          code: 'BOARD_DELTA',
          textZh:
            (parts.length > 0 ? `牌面变化（${d.kind}）：${parts.join('；')}；` : '牌面接近空白 —— **不因此恢复牌力**；') +
            `白板度 ${d.blankScore.toFixed(2)}` +
            (d.villainRangeImprovement === null
              ? '（对手范围适配度：无范围事实，未计算）'
              : `；对手范围适配度 ${d.villainRangeImprovement.toFixed(2)}`),
          data: { blankScore: Number(d.blankScore.toFixed(3)) },
        });
      }
      reasons.push({
        code: 'SPR_COMMITMENT',
        textZh: advice.commitment.noteZh,
        data: {
          commitmentScore: Number(advice.commitment.commitmentScore.toFixed(3)),
          stackOffAllowed: advice.commitment.stackOffAllowed ? 1 : 0,
        },
      });
    }

    const edge = equity - math.requiredEquity;

    /*
     * 🔴 **多人边池：「权益低于门槛」不能证明负期望**（2026-09 修复）。
     *
     * 我有资格争夺 ≥ 2 层时（主池 + 边池），两笔钱的胜负条件不同：
     * 主池要赢**所有人**，边池只要赢**同层的人**。于是「输掉主池、赢下边池」
     * 是可能的 —— 单一门槛算出的 EV 因此是**下界**，而不是估计值。
     *
     * 实测反例（`test/layeredPot.test.ts` POT-13）：
     *
     * ```text
     * 短码 9♥9♣ 暗三条全下 1000／大筹码 T♥J♥ 听牌全下 3000／我 A♥A♦ 需跟 2000
     * 单一门槛：2000 / 7050 = 28.4%，我的整池权益 4.8% ⇒ 差 −23.6 个百分点
     * 修复前：输出「跟注在数学上是负期望」并直接弃牌（不允许策略层翻转）
     * 真实：我 90.5% 赢边池（4000）⇒ 跟注 EV = +1764，是一手**必须跟**的牌
     * ```
     *
     * 因此：门槛不适用时**不做数学方向的硬判**，如实说明并交给牌力/策略层。
     * 「权益高于门槛」那一侧不受影响 —— 下界说划算，真实值只会更划算。
     */
    const layeredEquity = math.requiredEquityApplies === false;

    /*
     * 🔴 **分层 EV 可用时，用它判方向**（2026-09 多层权益轮）。
     *
     * `math.layeredEV.exact === true` 意味着每一层都用**该层的对手**
     * 单独算过胜率，因此它比「单一门槛 × 全部可争夺量」更贴近真值
     *（后者是下界：每一层的胜率都不低于「赢下所有人」的胜率）。
     *
     * ⚠️ 它仍然是**估计值**而不是无损真值（逐层蒙特卡洛），且只覆盖
     * 「各层参与者已确定」的情形 —— 这正是 `contextBuilder` 只在
     * `singleThresholdApplies === false`（层界被已全下的人冻结）时才给它的原因。
     *
     * 只有当分层算不出来（`exact === false` 或字段缺失）时，
     * 才回落到「不拿下界硬判」的保守规则。
     */
    const exactLayeredEV = math.layeredEV?.exact === true ? math.layeredEV.value : null;

    /*
     * 🔴 **判据的标尺必须与单层同源：除以「可争夺量」，不是除以「底池」**。
     *
     * 单层时 `edge = E − c/winnable = callEV / winnable`；而 `pot` 含
     * 「永远不会被争夺的筹码」（`POT-14` 里 `pot = 4150`，实际基数
     * `winnable = 7050`，决策时刻的可争夺量只有 2150）。同一个 5% 阈值
     * 除以两个不同的分母，等于拿两把刻度不同的尺子量同一件事。
     */
    const layeredEdge =
      exactLayeredEV !== null && math.winnable > 0 ? exactLayeredEV / math.winnable : null;

    /*
     * 🔴 **P1 · 单层裁决必须与 CALL EV 用同一把尺子**
     *（`reports/P1_99_CALL_FOLD_CONSISTENCY_AUDIT.md`）。
     *
     * `math.callEV` 的权益输入是 **`EqVsBetRange ?? heroEquity`**（`contextBuilder.ts:585`），
     * 而 `edge`（本函数上方）用的是 **`math.heroEquity`**（整体/到达范围）。
     * 上面那段注释声明「单层时 `edge = E − c/winnable = callEV / winnable`」——
     * 这条恒等式**只在两份条件权益相同时成立**。
     *
     * 原始 99 节点（BTN 9♥9♣，转牌面对 BB 20 领打）实测：
     * `EqVsBetRange = 32.906%`、`heroEquity = 21.546%` ⇒ `callEV / winnable = +3.92%`
     * 却被 `edge = −7.44%` 判成「数学明显不划算」，一个 **+2.705 筹码的跟注被弃掉**，
     * 并触发 `ACTION_CONTRADICTS_CHIP_EV`。
     *
     * 修法：单层时**直接用已有的 CALL EV 反推**每 1 可争夺筹码的边际
     *（`callEV / winnable`，与 `edge` 的既有定义式同源，不重复估计权益）。
     *
     * ⚠️ 仅在 CALL EV **存在、有限，且 `winnable` 有限且为正**时使用；
     * 否则保持原有回退（`edge` / `layeredEquity ⇒ null`），**绝不通过除法伪造裁决边际**。
     * 分层底池优先级（`layeredEdge`）与 `MATH_EV_EPSILON` / `MARGINAL_EV_GAP_RATIO` 均不变。
     */
    const singleLayerEdge =
      exactLayeredEV === null &&
      !layeredEquity &&
      math.callEV !== null &&
      Number.isFinite(math.callEV) &&
      Number.isFinite(math.winnable) &&
      math.winnable > 0
        ? math.callEV / math.winnable
        : null;

    /** 用于硬判的「每 1 可争夺筹码的 EV」；`null` ⇒ 口径不足，不判方向 */
    const verdictEdge = layeredEdge ?? (layeredEquity ? null : (singleLayerEdge ?? edge));

    /*
     * ============================================================
     * 🔴 **真实 EV 排名决定动作**（RIVER CONSISTENCY V2.1 · P0-2）
     * ============================================================ *
     * ## 修复前错在哪
     *
     * 判据是 `verdictEdge < − %` ⇒ 弃牌；`> +5%` ⇒ 跟注）
*带内**（§ %）
     * 一律返回跟注。实测本节点（
     *
     * ```text
     * FOLD EV = 0         → 节点增量口径的定义
     * CALL EV = − 17.61 筹码
     * |− 17.61| ≤ 5% × 7850 = 392.50 ⇒ 判「边缘局面 并**跟注**
     * 界面还写「数学上没有明显优劣。           → 这句话不成立
     * ```
     *
     * `0 > − 17.61` 是确定的：数学上弃牌更高。 % 那个带子**不是**统计误差
     * （没有置信区间）。
*不是** solver error bound（本项目没有求解树）。
     * **不是** sampling variance（本节点是精确枚举，±半宽 = 0）——
     * 它只是**人为的工程容差**，因此**不允许**自动翻转动作。
     *
     * ## 现在的规则（三段）
     *
     * | 区间 | 动作 | 依据 |
     * |---|---|---|
     * | `EV > +ε` | 跟注（强牌可加注） | `CHIP_EV` |
     * | `EV < −ε` | **弃牌** | `CHIP_EV` |
     * | `\|EV\| ≤ ε = 1e-6` 筹码 | 由偏好分取代价最小方向 | `MATH_INDIFFERENCE`（**真正的**数学无差异） |
     *
     * 其中「不确定性覆盖」**默认关闭**：只有调用方显式传
     * `allowUncertaintyOverride: true` 时，才允许在容差带内偏离 EV 排名，
     * 且必须标成 `MODEL_UNCERTAINTY_OVERRIDE`（工程启发式，不是数学结论）。
     */
    const uncertaintyBandChips = MODEL_UNCERTAINTY_RATIO * math.winnable;
    const evOfCall = exactLayeredEV ?? math.callEV;
    const evEdge = evOfCall;

    /*
     * 🔴 **唯一允许偏离 EV 排名的情况：显式开启的不确定性覆盖**
     *（RIVER CONSISTENCY V2.1 · P0-2 · 默认关闭）。
     *
     * ⚠️ 它必须排在「按真实 EV 排名硬判」**之前**：否则负 EV 的跟注
     * 会先被硬判弃牌，覆盖分支永远不可达（实测踩到过）。
     *
     * 三条同时成立才允许：
     *  ① 调用方显式开启 `allowUncertaintyOverride`；
     *  ② 真实 EV 存在且落在**模型容差带**内（`|EV| ≤ 5% × 可争夺量`）；
     *  ③ 真实 EV 为负 ⇒ 覆盖方向 = 取代价最小的跟注（弃牌不可逆）。
     *
     * 触发后必须标成 `MODEL_UNCERTAINTY_OVERRIDE`（工程启发式，**不是**数学结论）。
     */
    if (
      allowUncertaintyOverride &&
      evOfCall !== null &&
      evOfCall < -MATH_EV_EPSILON &&
      Math.abs(evOfCall) <= uncertaintyBandChips
    ) {
      reasons.push({
        code: 'MATH_FOLD_DOMINANT',
        textZh:
          `真实 EV 排名：**弃牌更高**（FOLD EV ≡ 0 > CALL EV ${evOfCall.toFixed(2)}）；` +
          `差距 ${Math.abs(evOfCall).toFixed(2)} 筹码落在**模型容差带** ±${uncertaintyBandChips.toFixed(2)} 内，` +
          '且本次分析**显式开启了不确定性覆盖** ⇒ 取代价最小的方向（跟注）。' +
          '⚠️ 这是**工程启发式，不是数学结论**（数学上弃牌 EV 更高）',
        data: {
          callEV: Number(evOfCall.toFixed(2)),
          uncertaintyBandChips: Number(uncertaintyBandChips.toFixed(2)),
          override: 1,
        },
      });
      return callCandidate;
    }

    // 数学明显不划算（真实 EV 为负）→ 弃牌。**不允许被策略层翻转**（规范第 27 节）
    if (verdictEdge !== null && ((evEdge !== null && evEdge < -MATH_EV_EPSILON) || verdictEdge < -MARGINAL_EV_GAP_RATIO)) {
      const withinTolerance = evEdge !== null && Math.abs(evEdge) <= uncertaintyBandChips;
      /* 🔴 TEST 17：本句同时报「权益」与「跟注 EV」⇒ 两者必须同源（纯标注，不改数值） */
      const callEvEquity = callEvEquityOf(math);
      /*
       * 🔴 **P1 · 本句必须描述「判据实际用的那把尺子」**。
       *
       * 走 `verdictEdge < −5%` 这条支路时，若 CALL EV 可得，则 `verdictEdge = callEV / winnable`
       * ⇒ `callEV < 0` ⇒ 用 `EqVsBetRange` 报「权益低于门槛」是**真的**；
       * 而 CALL EV 不可得时判据退回 `edge`（**整体范围权益**口径），
       * 此时若仍引用下注范围权益就会出现「32.9% 低于 29.0%」这种自相矛盾的句子
       *（P1 审计在 99 节点抓到过）。因此按**实际标尺**选择要报的权益。
       */
      const foldRuler =
        math.callEV === null
          ? {
              labelZh: '整体范围权益（到达范围；CALL EV 不可得时判据用的标尺）',
              value: math.heroEquity,
            }
          : { labelZh: callEvEquity.usedLabelZh, value: callEvEquity.usedValue };
      reasons.push({
        code: 'MATH_FOLD_DOMINANT',
        textZh:
          exactLayeredEV !== null
            ? `按**逐层**胜率算，跟注 EV = ${exactLayeredEV.toFixed(2)} 筹码（${math.layeredEV!.layerCount} 层分别计），` +
              `弃牌 EV ≡ 0 ⇒ **弃牌 EV 更高**（真实 EV 排名：FOLD > CALL）` +
              (withinTolerance
                ? `；差距在**模型容差带** ±${uncertaintyBandChips.toFixed(2)} 筹码内（工程容差，不是统计误差），` +
                  '但容差**不改变 EV 排名**，也不自动翻转动作'
                : '')
            : `${foldRuler.labelZh} ${((foldRuler.value ?? 0) * 100).toFixed(1)}% ` +
              `低于跟注所需 ${(math.requiredEquity * 100).toFixed(1)}%：` +
              (math.callEV === null
                ? '跟注在数学上是负期望'
                : `跟注 EV = ${math.callEV.toFixed(2)} 筹码（该 EV 的权益输入 = ${callEvEquity.usedLabelZh}），` +
                  `弃牌 EV ≡ 0 ⇒ **弃牌 EV 更高**` +
                  (withinTolerance
                    ? `（差距在模型容差带 ±${uncertaintyBandChips.toFixed(2)} 内 —— 那是工程容差，不改变 EV 排名）`
                    : '')) +
              callEvEquity.referenceNoteZh,
        data:
          exactLayeredEV !== null
            ? { layeredEV: Number(exactLayeredEV.toFixed(2)) }
            : {
                /*
                 * 🔴 **TEST 17 · 声明的口径必须与数值自洽**（与加注理由同一纪律，
                 * 见 `riverRaiseDecisionV2.test.ts` 的 V2-4）：本句报的 `edge`
                 * 必须由「本次 CALL EV 实际使用的权益」算出，并同时声明来源。
                 * ⚠️ 判据内部用的 `edge`（整体范围口径）**未被改动** —— 这里只是显示口径。
                 */
                edge: Number((((callEvEquity.usedValue ?? 0) - math.requiredEquity) * 100).toFixed(1)),
                equitySource: callEvEquity.usedSource,
                callEvEquity: Number((callEvEquity.usedValue ?? 0).toFixed(6)),
                equityLabelZh: callEvEquity.usedLabelZh,
                ...(math.heroEquity === null ? {} : { arrivalRangeEquity: Number(math.heroEquity.toFixed(6)) }),
                ...(math.callEV === null ? {} : { callEV: Number(math.callEV.toFixed(2)) }),
              },
      });
      return foldCandidate;
    }

    // 真实 EV 为正 → 视牌力决定「加注」还是「跟注」
    const callSupported =
      (evEdge !== null && evEdge > MATH_EV_EPSILON) ||
      (evEdge === null && verdictEdge !== null && verdictEdge > MARGINAL_EV_GAP_RATIO);
    if (callSupported) {
      /* 🔴 TEST 17：本句同时报「权益」与「跟注 EV」⇒ 两者必须同源（纯标注，不改数值） */
      const callEvEquity = callEvEquityOf(math);
      reasons.push({
        code: 'MATH_CALL_SUPPORTED',
        textZh:
          exactLayeredEV !== null
            ? `按**逐层**胜率算，跟注 EV = ${exactLayeredEV.toFixed(2)} 筹码（${math.layeredEV!.layerCount} 层分别计），` +
              `弃牌 EV ≡ 0 ⇒ **跟注 EV 更高**（真实 EV 排名：CALL > FOLD）`
            : `${callEvEquity.usedLabelZh} ${((callEvEquity.usedValue ?? 0) * 100).toFixed(1)}% ` +
              `高于跟注所需 ${(math.requiredEquity * 100).toFixed(1)}%：` +
              (math.callEV === null
                ? '跟注在数学上成立'
                : `跟注 EV = ${math.callEV.toFixed(2)} 筹码（该 EV 的权益输入 = ${callEvEquity.usedLabelZh}），` +
                  `弃牌 EV ≡ 0 ⇒ **跟注 EV 更高**` +
                  /*
                   * 🔴 U1：这句话的比较范围必须写明。加注现在**有**模型 EV
                   *（`raiseResponse`），因此「跟注 EV 更高」只在 **CALL vs FOLD**
                   * 之间成立 —— 实测 99 暗三条节点上 RAISE EV +140.01 > CALL +79.22，
                   * 最终动作是 RAISE；若这里不声明范围，同一份输出的首屏理由
                   *（「跟注 EV 更高」）就和动作自相矛盾。
                   * 只改措辞，不动任何数值与动作选择。
                   */
                  `（本句只比较 CALL vs FOLD）` +
                  (Math.abs(math.callEV) <= uncertaintyBandChips
                    ? `（差距在模型容差带 ±${uncertaintyBandChips.toFixed(2)} 内 ⇒ 置信度偏低，但 EV 排名不变）`
                    : '')) +
              callEvEquity.referenceNoteZh,
        data:
          exactLayeredEV !== null
            ? { layeredEV: Number(exactLayeredEV.toFixed(2)) }
            : {
                /* 🔴 TEST 17：口径自洽 —— `edge` 由本次 CALL EV 的同一份权益算出 */
                edge: Number((((callEvEquity.usedValue ?? 0) - math.requiredEquity) * 100).toFixed(1)),
                equitySource: callEvEquity.usedSource,
                callEvEquity: Number((callEvEquity.usedValue ?? 0).toFixed(6)),
                equityLabelZh: callEvEquity.usedLabelZh,
                ...(math.heroEquity === null ? {} : { arrivalRangeEquity: Number(math.heroEquity.toFixed(6)) }),
                ...(math.callEV === null ? {} : { callEV: Number(math.callEV.toFixed(2)) }),
              },
      });

      // ---- 强牌主动加注（红队 F-01：修复前这里永远返回跟注）----
      //
      // 加注到约「底池 + 2×跟注」的量级：既做大底池又不把对手一次打跑。
      // 但必须过 `shouldRaise` 的**量级保护** —— 对手下注越大，
      // 这个目标值越高，而「对手大注」本身就是他很强的信号（见常量说明）。
      const desiredTo = math.pot + math.callCost * 2;
      /*
       * 🔴 **跛入池：加注尺寸由隔离模型给**（§6）。
       *
       * 事实包里的 `legalIsoSize` 是「基准开池 + 每个 limp + 位置 + 黏度 + 筹码」
       * 算出来的（见 `limpIsolation.isoRaiseSizeOf`），并且已经截断到合法范围；
       * 因此这里只是**取用它**，不在决策层重算任何尺寸公式。
       * 非跛入池（或没有事实包）时逐位保持既有行为。
       */
      const iso = context.preflopIso ?? null;
      const isoToChips =
        iso !== null && iso.isoSize.legalIsoSize !== null ? iso.isoSize.legalIsoSize * math.bigBlind : null;
      const raiseCandidate =
        pickClosestRaise(candidates, isoToChips ?? desiredTo) ?? largestRaise(candidates);
      /*
       * 隔离加注的 EV **只有在下面两件事同时成立时**才可使用（否则宁可不给）：
       * ① 事实上算得出来（`proxyEV !== null`）；
       * ② 实际选中的加注尺寸**就是**模型算 EV 用的那个尺寸
       *   （尺寸对不上却拿这个 EV 说事，就是拿另一个动作的数字冒充本动作）。
       */
      const isoEv = iso !== null ? iso.isoEV.proxyEV : null;
      const isoUsable =
        iso !== null && isoEv !== null && raiseCandidate !== null && raiseCandidate.sizeChips === isoToChips;
      /*
       *
       * 🔴 **U1：面对加注的响应事实化
*（`contextBuilder` 用公共信息口径算好）。
       *
       * `null` = 本节点没有可用的加注响应模型（不是「RAISE EV = 0」）。
       */
      const raiseModelFacts = ((context.postflopFacts as unknown as Record<string, any> | undefined)?.[
        'raiseResponse'
      ] ?? null) as
        | {
            sizeChips: number;
            raiseEV: number | null;
            assumptionsZh: readonly string[];
            /** 🔴 U1 P0：资金口径契约（缺失 ⇒ 旧口径 缓存化 ⇒ 不得参与比较）
*/
            cashflowContract?: string;
            currentPot?: number;
            heroAdd?: number;
            villainAdd?: number;
            heroContestedAdd?: number;
            finalPot?: number;
          }
        | null;
      /*
       * 🔴 **U1：加注自有 EV 现在存在人
*（`reports/UNCERTAINTY_REGISTER.md`）。
       *
       * `contextBuilder` 用
*面对加注的响应模型
*算出（
       *
       * ```text
       * RAISE EV = P(弃 ×pot + P(跟 ×(EqVsRaiseCall×(pot+2·inc) − inc) + P(再加注 ×(−inc)
       * ```
       *
       * 只有「决策层选中的加注尺寸 = 模型算 EV 的那个尺寸」才允许使用它
       *（与隔离加注 `isoUsable` 同一条纪律：尺寸对不上却拿这个 EV 说事，
       * 就是拿另一个动作的数字冒充本动作）。
       */
      /*
       * 🔴🔴 **U1 P0 修复 · 比较资格的硬门槛**（`reports/U1_RAISE_EV_LIGHT_AUDIT.md`）。
       *
       * 修复前 U1 的加注 EV 用了**不 CALL EV 不同**的筹码口径（漏掉对手已下注的筹码），
       * 却照样进了跨动作 EV 排名。现在要求三件事**同时**成立）
       *
       * | # | 条件 | 防的是 |
       * |---|---|---|
       * | ① | `cashflowContract === CASHFLOW_CONTRACT` | 旧口径 / 缓存里的旧事实包重新混进比较 |
       * | ① | 四个资金量都是有限数且自洽 | 上游半成品（缺字段）被当成 0 用 |
       * | ① | 实际选中的尺寸 = 模型算 EV 的尺寸 | 拿另一个动作的数字冒充本动作 |
       *
       * ① 不成立时**不再静默关闭**：下面会推一条 `RAISE_EV_SIZE_MISMATCH` 的显式理由」
       */
      const raiseFactsCashOk =
        raiseModelFacts !== null &&
        raiseModelFacts.cashflowContract === CASHFLOW_CONTRACT &&
        Number.isFinite(raiseModelFacts.currentPot) &&
        Number.isFinite(raiseModelFacts.heroAdd) &&
        Number.isFinite(raiseModelFacts.villainAdd) &&
        Number.isFinite(raiseModelFacts.heroContestedAdd) &&
        Number.isFinite(raiseModelFacts.finalPot) &&
        (raiseModelFacts.heroAdd ?? 0) > 0 &&
        (raiseModelFacts.villainAdd ?? 0) > 0 &&
        (raiseModelFacts.finalPot ?? 0) > 0;
      const raiseModelSizeMatches =
        raiseModelFacts !== null && raiseCandidate !== null && raiseCandidate.sizeChips !== undefined &&
        Math.abs(raiseCandidate.sizeChips - raiseModelFacts.sizeChips) < ALL_IN_COMPARE_EPSILON;
      const raiseModelUsable = raiseFactsCashOk && raiseModelSizeMatches;
      /*
       * 🔴 事实包存在、但尺寸对不一
⇒
**必须说出来
*，不许静默把 U1 关掉。
       * （修复前正是这种静默关闭掩盖了「两层各自算 desiredTo」的缺陷。）
       */
      if (raiseModelFacts !== null && raiseFactsCashOk && !raiseModelSizeMatches) {
        reasons.push({
          code: 'RAISE_EV_SIZE_MISMATCH',
          textZh:
            `加注 EV 不可用：事实包算的是加注额 ${raiseModelFacts.sizeChips}，` +
            `而本次候选尺寸是 ${raiseCandidate?.sizeChips === undefined ? '（无加注候选）' : String(raiseCandidate.sizeChips)}` +
            ' —— 尺寸不一致时不允许把它的 EV 当作本动作的 EV（不得拿另一个尺寸的数字冒充）',
          data: {
            factsSizeChips: raiseModelFacts.sizeChips,
            candidateSizeChips: raiseCandidate?.sizeChips ?? 'NONE',
          },
        });
      }
      if (raiseModelFacts !== null && !raiseFactsCashOk && raiseModelFacts.raiseEV !== null) {
        reasons.push({
          code: 'RAISE_EV_CASHFLOW_CONTRACT_REJECTED',
          textZh:
            '加注 EV 被资金口径门槛拒绝：事实包缺少（或版本不符）' +
            `\`cashflowContract = ${CASHFLOW_CONTRACT}\` 或资金量不自洽 ⇒ 不参与 EV 比较` +
            '（U1 P0：旧口径曾把对手已下注的筹码漏出底池）',
          data: { cashflowContract: raiseModelFacts.cashflowContract ?? 'MISSING' },
        });
      }
      /*
       * 🔴 **这次加注是否把剩余筹码全部投入
*（真正的全下）。
       *
       * 判据是 `raise-to ≥ allInToAmount`（本街总额的上限），
*不是**底池比例（
       * 实测的 AK 节点量 174/93 = 1.87 看起来「不重」，但 174 就是
       * Hero 的全部剩余（87BB）—— 用比例近似会把全下误判成普通加注」
       */
      const raiseConsumesStack =
        raiseCandidate !== null && raiseCandidate.sizeChips !== undefined &&
        raiseCandidate.sizeChips >= legal.allInToAmount - ALL_IN_COMPARE_EPSILON;
      /*
       * 🔴 但 SPR 的承诺例外：**两个条件之一**即可」
       *
       * | 条件 | 理由 |
       * |---|---|
       * | 角色强度足够（≥0.55） | 强牌本来就应该把筹码打进去 |
       * | **筹码已基本入池（COMMITTED）且权益优势非负** | 此时「加注」与「跟注」的差别只是把剩下的一点点投进去 |
       *
       * ⚠️ 第一版这里用了一个我**自己推的**全下赔率公式 `R/(P+c+R)`。
       * 对抗性审计指出它漏掉了跟注额与对手的再加注，精确值应为
       * `(c+R)/(P+2c+2R)`，且偏差会**变号**（`R ≈ c/3` 处翻转）：
       * 既可能拦住正 EV 全下，也可能放行负 EV 全下。实测反例：
       * `P=100,c=100,R=100,E=35%` 时它放行的全下真实 EV 是
**− 5**。
       *
       * 因此现在**不再使用任何自造公式
*：改用本函数已经算出来的
       * `edge`（  权益 − 门槛，且能走到这里说明它已经过了 ±5% 带）
       * 加上 SPR 分档 —— 两者都是既有、已被测试锁住的口径。
       *
       * ## 🔴 RIVER RAISE DECISION V2：河牌上整条通道关闭 + 条款如实上报
       *
       * 修复前这里
*只
*给第二个条款加了河牌守卫（`futureStreetCommitmentBonus`
       * 在河牌恒与 0 ⇒ 自然失效），第一个条款（`roleStrength ≥ 0.55`（
       * 在河牌上**照旧生效**。于是「河牌不能再用『以后反正要打光』放行加注」
       * 这条注释只对了一半 —— 而实测放补 AK 那次全下的正是第一条「
       *
       * 现在（
*河牌下 `commitmentException` 恒为 false**（SPR 只作背景信息，
       * 不 `commitment.ts` 自己生成的注记一致），并用 `commitmentClause`
       * 如实上报到底是哪一条（或没有）放行 —— 修复旧报告里
       * 「注记说位 SPR、实际靠 roleStrength」的描述不一致。
       */
      const isRiverStreet = math.street === Street.RIVER;
      const commitmentClause: 'ROLE_STRENGTH' | 'FUTURE_STREET_COMMITMENT' | null =
        advice === null || isRiverStreet || !advice.commitment.stackOffAllowed
          ? null
          : advice.roleStrength >= 0.55
            ? 'ROLE_STRENGTH'
            : advice.commitment.futureStreetCommitmentBonus > 0 &&
            advice.commitment.band === 'COMMITTED' &&
            equity - math.requiredEquity >= 0
              ? 'FUTURE_STREET_COMMITMENT'
              : null;
      const commitmentException = commitmentClause !== null;
      /*
       * ---- 动作证据优先级裁决（PREFLOP EVIDENCE PRIORITY FIX）----
       *
       * 🔴 修复前：上面已经把 CALL 的证据算清楚了
       *（`evOfCall = +2.73`、边际 `CLEAR_CALL`），但接下来只要
       * `shouldRaise(...)` 这个**战略启发式**通过，就 `return raiseCandidate`，
       * 把清晰的可比 EV 证据丢掉，并且最终把来源写成 `SAFETY_RULE`。
       *
       * 现在：把三个动作各自的**证据类型**摆出来，交给
       * `chooseByEvidencePriority` 裁决 —— 它只回答「谁有资格覆盖谁」：
       *
       * ```text
       * FOLD  : EXACT   EV ≡ 0（节点增量口径的定义）
       * CALL  : EXACT（分层精确）或 PROXY_EV（由权益/赔率推导）
       * RAISE : HEURISTIC，EV = null（缺 fold-to-3bet / call-3bet / 4bet）
       * ```
       *
       * ⇒ CALL 有量化证据且边际清晰 ⇒ **战略启发式不得覆盖它**；
       * 若 CALL 只到 MARGINAL，则允许启发式打断并标成 `HEURISTIC_TIEBREAK`。
       * ⚠️ 未来 3bet 若建立完整 EV，会自动以 `MODEL_EV` 参与同一张表并可能获胜
       *（本模块不硬编码「CLEAR_CALL ⇒ 永远跟注」）。
       */
      const raiseQualifies =
        raiseCandidate !== null &&
        shouldRaise(
          raiseEquity,
          math.requiredEquity,
          tier,
          raiseCandidate.sizeChips ?? 0,
          math.pot,
          math.handCategory,
          commitmentException,
          /* 🔴 RIVER RAISE DECISION V2：全下必须用自己的 EV 才能证明「打光更好」
*/
          /* 🔴 PREFLOP P0（F2）：`street` 决定「全下保护」是否适用（翻前不适用） */
          { consumesStack: raiseConsumesStack, hasOwnEV: raiseModelUsable || isoUsable, street: math.street },
        );
      /*
       * 🔴 **RIVER RAISE DECISION V2 · 全下保护的可审计判定**（§四）。
       *
       * 三条判据分开记录，因为它们的**含义不同**（
       * | 判据 | 拦什么 |
       * |---|---|
       * | `onePairAllInBlocked` | 一对牌（类别 < 3）
*真正打光筹码**且没有自己的 EV |
       * | `largeRaiseBlocked` | 类别 < 3 且加注额 / 底池 > 2.5（原有的档位保护） |
       */
      const raiseToPotRatio = raiseCandidate === null || !(math.pot > 0)
        ? null
        : (raiseCandidate.sizeChips ?? 0) / math.pot;
      const onePairAllInBlocked = allInGuardVerdictOf({
        handCategory: math.handCategory,
        consumesStack: raiseConsumesStack,
        hasOwnEV: raiseModelUsable || isoUsable,
        /* 🔴 PREFLOP P0（F2）：与 `shouldRaise` 用**同一个**街道判据（M2：不得两处口径） */
        street: math.street,
      }).onePairAllInBlocked;
      const largeRaiseBlocked =
        raiseCandidate !== null &&
        math.handCategory < MIN_CATEGORY_FOR_LARGE_RAISE &&
        raiseToPotRatio !== null &&
        raiseToPotRatio > MAX_RAISE_TO_POT_RATIO;
      /*
       * 🔴 §五：**实际触发的放行分支
*必须可审计。
       * 修复前「注记说位 SPR 承诺、实际靠 roleStrength」这两种说法混在一起，
       * 使用者无法判断到底是谁放行的「
       */
      const raiseOverrideJustificationKind: string | null =
        raiseCandidate === null || raiseModelUsable || isoUsable || !raiseQualifies
          ? null
          : tier === 'MONSTER' ||
              (math.handCategory >= MIN_CATEGORY_FOR_LARGE_RAISE &&
                raiseEquity - math.requiredEquity >= RAISE_EDGE_ANY)
            ? 'MONSTER_STRENGTH_DOMINANCE'
            : commitmentException
              ? 'LOW_SPR_COMMITMENT'
              : null;
      if (evidenceOut !== undefined && raiseCandidate !== null) {
        evidenceOut.raiseShape = {
          consumesStack: raiseConsumesStack,
          /* 🔴 U1：加注现在有自己的模型 EV ⇒ 它也算「自有 EV」，全下保护不再需要拦它
*/
          hasOwnEV: raiseModelUsable || isoUsable,
          /*
           * 🔴 **U1 披露一致性
*：真正拿到「自己的可比 EV」的那
*些加注尺寸
*。
           *
           * 为什么必须从这里带出去：`unevaluatedActions`（decideAlpha 里算）用
           * `candidate.ev === null` 当作「没有 EV 模型」的代理 —— 而加注候选的
           * `ev` 字段**永远**是 null（加注 EV 挂在证据表上，不在候选表上）。
           * 于是修复前会出现自相矛盾的输出：动作 **非
* RAISE EV 选出， 9 暗三条
           * 节点：RAISE 174 ⇒ MODEL_EV +140.01），同一份诊断却把 174 列进
           * 「RAISE_EV_NOT_IMPLEMENTED 未评估」。这里把事实带出去，让披露层
           * 只列**真的**没有 EV 的金额」
           */
          raiseSizesWithOwnEV: Object.freeze(
            raiseModelUsable || isoUsable
              ? (raiseCandidate.sizeChips === undefined ? [] : [raiseCandidate.sizeChips])
              : [],
          ),
          onePairAllInBlocked,
          largeRaiseBlocked,
          raiseToPotRatio,
          raiseEquitySource,
          commitmentException,
          commitmentClause,
          overrideJustificationKind: raiseOverrideJustificationKind,
        };
      }

      const evidence: ActionEvidence[] = [
        {
          action: 'FOLD',
          estimateType: EstimateType.EXACT,
          ev: 0,
          decisionMargin: marginOf(0, uncertaintyBandChips),
          heuristicScore: 0,
          confidence: 1,
          assumptionsZh: Object.freeze(['弃牌 EV ≡ 0 是节点增量口径的**定义**（已投入筹码是沉没成本）']),
          upgradeNoteZh: null,
        },
        {
          action: 'CALL',
          estimateType: exactLayeredEV !== null ? EstimateType.EXACT : EstimateType.PROXY_EV,
          ev: evOfCall,
          decisionMargin: marginOf(evOfCall, uncertaintyBandChips),
          heuristicScore: 0,
          confidence: 1 - MODEL_UNCERTAINTY_RATIO,
          assumptionsZh: Object.freeze([
            exactLayeredEV !== null
              ? '逐层精确胜率（每层调用权益引擎）'
              : '由「估计权益 × 可争夺量 − 跟注额」推导的**代理 EV**（未建模对手弃牌率）',
            '未计抽水（本项目无 Rake Engine）',
          ]),
          upgradeNoteZh: null,
        },
      ];
      if (raiseCandidate !== null) {
        /*
         * 🔴 **隔离加注的证据**（§2/§5–§8）。
         *
         * 跛入池里 RAISE **不是**启发式：`context.preflopIso` 里带着
         * 「limp 响应树 + 对 limp-call 条件范围的权益 + 尺寸 + 身后风险」
         * 算出来的独立代理 EV。把它当 `INDEPENDENT_STRATEGIC_EVIDENCE`
         * 放进同一张证据表，它才有资格与其他动作**正面比 EV**。
         *
         * ⚠️ 拿不到事实包（含「面对真实开池」的节点）⇒ 原样退回启发式，
         * 旧契约（AJs 面对开池等）逐位不变。
         */
        const isoEv = iso !== null ? iso.isoEV.proxyEV : null;
        evidence.push({
          action: 'RAISE',
          estimateType: raiseModelUsable
            ? EstimateType.MODEL_EV
            : isoUsable
            ? EstimateType.INDEPENDENT_STRATEGIC_EVIDENCE
            : // 🔴 非跛入池的 3bet 目前**没有** EV 模型：缺 fold-to-3bet / call-3bet / 4bet 三类响应数据
              EstimateType.HEURISTIC,
          ev: raiseModelUsable ? raiseModelFacts!.raiseEV : isoUsable ? isoEv : null,
          decisionMargin: raiseModelUsable
            ? marginOf(raiseModelFacts!.raiseEV, uncertaintyBandChips)
            : isoUsable ? marginOf(isoEv, uncertaintyBandChips) : null,
          heuristicScore: raiseQualifies
            ? Math.max(0, Math.min(1, 0.5 + (raiseEquity - math.requiredEquity) * 1.5))
            : 0,
          confidence: raiseModelUsable ? 0.7 : isoUsable ? iso!.modelConfidence : 0.5,
          assumptionsZh: raiseModelUsable
            ? raiseModelFacts!.assumptionsZh: isoUsable
            ? iso!.assumptionsZh
            : Object.freeze([
                '牌力 + 权益优势的量级保护（`shouldRaise`）：既有启发式，**不是** EV',
                '缺 fold-to-3bet / call-3bet / 4bet 响应数据 ⇒ EV 不可得',
                  `这次加注是否把剩余筹码全部投入（全下） ${raiseConsumesStack ? 'true' : 'false'}` +
                    '；全下时启发式**没有**覆盖清晰 CALL 证据的权限（RIVER RAISE DECISION V2）',
                ]),
          upgradeNoteZh: raiseModelUsable
            ? '⚠️ EV 已是**模型 EV**（面对加注的响应模型），但两组先验系数（强度阶梯 / 加注份额）**未经统计校准**，' +
              '再加注分支按**摊牌终止近似**计入（未模拟后续街行动 ⇒ 该 EV 偏低，且**不构成**对真实牌局 EV 的严格下界）；RAKE 未实现'
            : isoUsable
              ? '⚠️ EV 仍是**代理**：需要真实 limp 响应频率（本项目无此数据）才能升级为 MODEL_EV；RAKE 未实现'
              : '若建立完整的 3bet EV 模型（三类响应概率），本项可升级为 MODEL_EV 并自然参与比较',
          /*
           * 🔴 **RIVER RAISE DECISION V2**：这一条决定它能否覆盖清晰 CALL 证据」
           * 打光筹码的加注 ⇒ `commitsStack = true` ⇒ 覆盖权限被收窄
           *（只能靠自带 EV，或量化证据只到 MARGINAL 时的 `HEURISTIC_TIEBREAK`）。
           * ⚠️ U1 之后「自带 EV」已是现实路径：`raiseModelUsable = true` 时它直接近 `quantified` 比 EV）
           * **不需要
*任何覆盖授权。
           */
          commitsStack: raiseConsumesStack,
          /*
           * 🔴 **覆盖清晰 CALL 证据所需的独立论证
*（没有它就必须让位给 CALL）。
           *
           * ⚠️ 只对**没有自己的 EV** 的启发式加注有意义：一旦隔离模型给了 EV（
           * 它就是靠 EV 参与比较）
*不需要
*「例外授权」（授权会让它变成
           * 规则性加注，而不是算出来的）。
           *
           * ⚠️ V2 起：**打光筹码**时这份论证不再构成覆盖授权（规
           * `evidencePriority.ts` 的模块说明）；它保留下来只用于如实叙过
           * 「启发式本来想怎么做、用什么理由」。
           */
          overrideJustification:
            raiseOverrideJustificationKind === 'MONSTER_STRENGTH_DOMINANCE'
              ? {
                  kind: 'MONSTER_STRENGTH_DOMINANCE',
                  noteZh:
                    `牌力（${math.handRankZh}，档 ${tier}，类别 ${math.handCategory}）且权益优势 ` +
                    `${((raiseEquity - math.requiredEquity) * 100).toFixed(1)} 个百分点 ≥ ${(RAISE_EDGE_ANY * 100).toFixed(0)}%` +
                    '⚠️ 加注的额外筹码是在领先时投入的',
                }
              : raiseOverrideJustificationKind === 'LOW_SPR_COMMITMENT'
                ? {
                    kind: 'LOW_SPR_COMMITMENT',
                    noteZh: `承诺例外放行（实际条） = ${String(commitmentClause)}）` +
                      `｜${advice?.commitment.noteZh ?? '筹码已基本入池'}）⇒ 加注与跟注只差把剩余部分投入` +
                      '；⚠️ 河牌上该条款已被关闭（引擎自己的注记：河牌 SPR 只作背景信息）',
                  }
                : null,
        });
      }

      const evidenceDecision = chooseByEvidencePriority({
        candidates: evidence,
        // 硬约束**只**用于合法性/输入安全：这里 CALL 候选缺失时才是硬约束
        hardConstraint:
          callCandidate === null
            ? { action: raiseCandidate !== null ? 'RAISE' : 'FOLD', reasonZh: 'CALL 候选不存在（不合法）—— 必须换动作' }
            : null,
        allowHeuristicTiebreak: true,
        // 跨动作比较用同一把容差带尺子（§1/§17）
        bandChips: uncertaintyBandChips,
        /*
         * 🔴 **CB-5**：本节点是否适用「打光筹码需要超过容差带的依据」这条护栏。
         *
         * 判据只有一处（这里）：**河牌 + 面对下注**。
         * `callCandidate !== null` 就是「有一次跟注要付」= 面对下注
         *（无人下注的节点只有 CHECK，没有 CALL 候选 —— 与本函数上方
         * `hardConstraint` 用的是同一个既有判据，不另写一份）。
         */
        stackCommitmentGuardApplies: math.street === Street.RIVER && callCandidate !== null,
      });
      if (evidenceOut !== undefined) {
        evidenceOut.decision = evidenceDecision;
        evidenceOut.list = Object.freeze(evidence);
      }

      /*
       * 🔴 RAISE 胜出的**两条**合法路径（§2）：
       * ① 隔离模型给了 EV 且在跨动作比较中胜出（来源 = INDEPENDENT_STRATEGIC_EVIDENCE）；
       * ② 没有 EV 时的战略启发式路径（来源 = STRATEGIC_HEURISTIC / HEURISTIC_TIEBREAK）。
       *
       * ⚠️ 修复前只有 ②，且 ② 必须先过 `shouldRaise`；于是「有独立 EV 的隔离加注」
       * 也被 `shouldRaise` 与 CALL 的清晰边际拦住了。
       */
      const raiseByModel = evidenceDecision.action === 'RAISE' && isoUsable && raiseCandidate !== null;
      /*
       * 🔴 **U1：加注由「面对加注的响应模型」的 EV 胜出**（与隔离加注并列的第三条路径）。
       *
       * 修复前这里只有「隔离模型」与「战略启发式」两条路：U1 落地后，
       * 99 暗三条节点的 RAISE（依据 `MODEL_EV +140.01`）会掉进启发式分支，
       * 于是首屏理由写着「加注的 EV 无法计算」——
**在刚刚用加注 EV 做决策的节点上撒谎
*。
       * 现在这条路径单独成支，并如实报出模型 EV、跟注 EV 与响应权重。
       */
      const raiseByU1Model = evidenceDecision.action === 'RAISE' && !isoUsable && raiseModelUsable && raiseCandidate !== null;
      if (
        evidenceDecision.action === 'RAISE' &&
        raiseCandidate !== null &&
        (raiseByModel || raiseByU1Model || raiseQualifies)
      ) {
        const u1Facts = ((context.postflopFacts as unknown as Record<string, any> | undefined)?.[
          'raiseResponse'
        ] ?? null) as Record<string, any> | null;
        reasons.push({
          code: raiseByModel ? 'ISO_RAISE_MODEL_EV' : raiseByU1Model ? 'RAISE_MODEL_EV' : 'STRATEGIC_RAISE_FOR_VALUE',
          textZh: raiseByModel
            ? `隔离加注（加注到 ${(raiseCandidate.sizeBB ?? 0).toFixed(1)}BB）：${iso!.noteZh}` +
              `｜对 limp-call 条件范围权益 ${iso!.heroEquity.vsOneCaller === null ? '—' : (iso!.heroEquity.vsOneCaller * 100).toFixed(1) + '%'}` +
              `（对到达范围权益 ${iso!.heroEquity.vsArrival === null ? '—' : (iso!.heroEquity.vsArrival * 100).toFixed(1) + '%'}，` +
              '**不用于**证明加注）；' +
              `代理 EV = ${isoEv === null ? '—' : isoEv.toFixed(2)} 筹码 vs 跟注 ${evOfCall === null ? '—' : evOfCall.toFixed(2)} 筹码` +
              `（同一零点 = 弃牌 0）⇒ 依据来源 = **${evidenceDecision.source}**` +
              '；⚠️ 这是**代理 EV**，不是 Solver EV，RAKE 未实现'
            : raiseByU1Model
              ? `加注： ${(raiseCandidate.sizeBB ?? 0).toFixed(1)}BB。**面对加注的响应模型 EV** = ` +
                `${raiseModelFacts!.raiseEV!.toFixed(2)} 筹码 vs 跟注 ${evOfCall === null ? '—' : evOfCall.toFixed(2)} 筹码` +
              `（同一零点 = 弃牌 0）⇒ 依据来源 = **${evidenceDecision.source}**` +
                (u1Facts === null
                  ? ''
                  : `｜他面对这次加注：弃 ${((u1Facts['foldLikelihood'] as number) * 100).toFixed(1)}% / ` +
                    `跟 ${((u1Facts['callLikelihood'] as number) * 100).toFixed(1)}% / ` +
                    `再加注 ${((u1Facts['reRaiseLikelihood'] as number) * 100).toFixed(1)}%` +
                    `（价格 ${((u1Facts['model']?.['priceRequiredEquity'] as number) ?? 0).toFixed(4)}）`) +
                '；⚠️ 响应模型是**结构性先验、未经统计校准**（公共信息口径，不读我的底牌）；' +
                '再加注分支按**摊牌终止近似**计入（未模拟后续街的下注/过牌/弃牌 ⇒ 该 EV 偏低，' +
                '且**不构成**对真实牌局 EV 的严格下界，见 assumptionsZh）；RAKE 未实现'
              : `牌力（${math.handRankZh}）与权益优势（高出跟注所需 ${((raiseEquity - math.requiredEquity) * 100).toFixed(1)} 个百分点，` +
                `按 **${raiseEquitySource}** 条件权益计算）` +
                '支持主动加注做大底池' +
              (commitmentException && tier !== 'MONSTER' && tier !== 'STRONG'
                ? `本次加注是**承诺例外**放行（实际条件 = ${String(commitmentClause)}｜${advice!.commitment.noteZh}）；`
                : '') +
              `⚠️ 加注的 EV 无法计算（缺可信的对手弃牌率估计）⇒ 依据来源 = **${evidenceDecision.source}**` +
              (evidenceDecision.source === DecisionSourceKind.HEURISTIC_TIEBREAK
                ? '（量化证据只到 MARGINAL，允许战略启发式打断）'
                  : '（无任何量化 EV 证据）'),
          data: {
            edge: Number(((raiseEquity - math.requiredEquity) * 100).toFixed(1)),
            tier,
            source: evidenceDecision.source,
            /* 🔴 §六：加注门槛用的是哪一个条件权益，必须可审计
*/
            equitySource: raiseEquitySource,
            raiseEquity: Number(raiseEquity.toFixed(6)),
            consumesStack: raiseConsumesStack ? 1 : 0,
            ...(raiseByModel ? { isoEV: isoEv === null ? 'NOT_AVAILABLE' : Number(isoEv.toFixed(2)) } : {}),
            /* 🔴 U1：模型 EV 路径必须把两个 EV 与响应权重一起带出来（可审计（
*/
            ...(raiseByU1Model
              ? {
                  raiseEV: Number(raiseModelFacts!.raiseEV!.toFixed(6)),
                  callEV: evOfCall === null ? 'NOT_AVAILABLE' : Number(evOfCall.toFixed(6)),
                  responseModel: 'PUBLIC_BAND_RAISE_RESPONSE_V1',
                  ...(u1Facts === null
                    ? {}
                    : {
                        foldLikelihood: Number((u1Facts['foldLikelihood'] as number).toFixed(6)),
                        callLikelihood: Number((u1Facts['callLikelihood'] as number).toFixed(6)),
                        reRaiseLikelihood: Number((u1Facts['reRaiseLikelihood'] as number).toFixed(6)),
                      }),
                } : {}),
          },
        });
        return raiseCandidate;
      }

      /*
       * ---- CALL 胜出：把「为什么没有被加注覆盖」写清楚（使用者 §15 的理由链）----
       */
      reasons.push({
        code: 'CALL_PROXY_EV_POSITIVE',
        textZh:
          `CALL：${exactLayeredEV !== null ? 'EXACT' : 'PROXY_EV'} ${evOfCall === null ? '—' : evOfCall.toFixed(2)} 筹码，` +
          `决策边际 ${String(marginOf(evOfCall, uncertaintyBandChips))}（容差带 ±${uncertaintyBandChips.toFixed(2)}）` +
          (exactLayeredEV !== null ? '' : '；⚠️ 这是**代理 EV**（未建模对手弃牌率），不是完整博弈树 EV'),
        data: {
          ...(evOfCall === null ? {} : { callEV: Number(evOfCall.toFixed(2)) }),
          estimateType: exactLayeredEV !== null ? 'EXACT' : 'PROXY_EV',
        },
      });
      if (raiseCandidate !== null) {
        /*
         * 🔴 **U1 披露一致性（第三处）**：CALL 胜出时，「为什么不加注」的理由必须
         * 报出**真的算过的
*加注 EV」
         *
         * 修复前这里只有两条分支（隔离加注模型 / 「没有 EV」），U1 的模型路径落进后者，
         * 于是 AK 河牌节点的首屏理由写着 `EV = NOT_AVAILABLE（缺 fold-to-3bet …）`（
         * 而同一份诊断的证据表里明明有 `RAISE MODEL_EV = − .4475 < CALL +19.6979`、
         * 「算过但更低」与「没算过」是两件事，不能共用一句话」
         */
        reasons.push({
          code:
            evidenceDecision.stackCommitmentGuard !== undefined
              ? 'STACK_COMMITMENT_MARGIN_GUARD'
              : isoUsable
                ? 'ISO_RAISE_LOSES_ON_EV'
                : raiseModelUsable
                  ? 'RAISE_MODEL_EV_LOSES'
                  : 'RAISE_STRATEGIC_CANDIDATE',
          textZh:
            evidenceDecision.stackCommitmentGuard !== undefined
              ? /* 🔴 CB-5：这里**不能**说「跟注更高」—— 加注 EV 其实略高，只是高得没有意义 */
                `RAISE（${(raiseCandidate.sizeBB ?? 0).toFixed(1)}BB）：${evidenceDecision.stackCommitmentGuard.reasonZh}` +
                `｜被拦截动作 = ${evidenceDecision.stackCommitmentGuard.blockedAction}，` +
                `有效备选 = ${evidenceDecision.stackCommitmentGuard.alternativeAction}` +
                `（⚠️ 该加注的 EV 与候选金额均**未被修改**，仍可在诊断里查看）`
              : isoUsable
            ? `RAISE（${(raiseCandidate.sizeBB ?? 0).toFixed(1)}BB）：**有**隔离加注模型的代理 EV ` +
              `${isoEv === null ? '—' : isoEv.toFixed(2)} 筹码 ⇒ 本次比较是**算出来的**：` +
              `跟注 ${evOfCall === null ? '—' : evOfCall.toFixed(2)} 更高 ⇒ 不加注` +
              '（⚠️ 两个 EV 都是代理口径，RAKE 未实现）'
            : raiseModelUsable
              ? `RAISE（${(raiseCandidate.sizeBB ?? 0).toFixed(1)}BB）：**面对加注的响应模型 EV = ` +
                `${raiseModelFacts!.raiseEV!.toFixed(2)} 筹码 ⇒ 本次比较是**算出来的**：` +
              `跟注 ${evOfCall === null ? '—' : evOfCall.toFixed(2)} 更高 ⇒ 不加注` +
                '（⚠️ 响应模型是结构性先验、**未经统计校准**；再加注分支按**摊牌终止近似**计入 ⇒ 该 EV 偏低，' +
                '且**不构成**对真实牌局 EV 的严格下界；RAKE 未实现）'
              : `RAISE（${(raiseCandidate.sizeBB ?? 0).toFixed(1)}BB）：合法候选，来源 = STRATEGIC_CANDIDATE，` +
              'EV = NOT_AVAILABLE（缺 fold-to-3bet / call-3bet / 4bet 响应数据）',
          data: {
            sizeBB: Number((raiseCandidate.sizeBB ?? 0).toFixed(2)),
            ev: isoUsable && isoEv !== null ? Number(isoEv.toFixed(2)) : raiseModelUsable
                ? Number(raiseModelFacts!.raiseEV!.toFixed(2))
                : 'NOT_AVAILABLE',
            ...(raiseModelUsable ? { responseModel: 'PUBLIC_BAND_RAISE_RESPONSE_V1', responseModelCalibrated: 0 } : {}),
          },
        });
      }
      reasons.push({
        code: 'SUPPORTED_EVIDENCE_PRIORITY',
        textZh:
          `比较：${evidenceDecision.reasonZh.join('；')}` +
          (evidenceDecision.overrideBlockedReason === null
            ? ''
            : `｜overrideAttempt = ${String(evidenceDecision.overrideAttempt)}｜overrideBlockedReason = ${evidenceDecision.overrideBlockedReason}`),
        data: {
          source: evidenceDecision.source,
          evidenceScope: evidenceDecision.evidenceScope,
          canOverrideEvidence: evidenceDecision.canOverrideEvidence ? 1 : 0,
        },
      });
      return callCandidate;
    }

    /*
     * 🔴 **精确分层 EV 落在边缘带内**（`|EV| / 可争夺量 ≤ 5%`，走到这里说明
     * 既没到「明显占优」也没到「明显不划算」）⇒ 与单层同口径：判「边缘局面」
     * 并给跟注（代价最小的方向），同时把 EV 如实写出来。
     *
     * ⚠️ 此前这一带**不可达** —— 那时只要 `exact === true` 就必然从上面
     * 「EV > 0 ⇒ 直接跟注」返回，于是「EV = −0.5 也当成成立」。
     */
    if (exactLayeredEV !== null) {
      reasons.push({
        code: 'MATH_MARGINAL',
        textZh:
          `按**逐层**胜率算，跟注 EV = ${exactLayeredEV.toFixed(6)} 筹码，弃牌 EV ≡ 0 ⇒ ` +
          '两者之差在**浮点误差以内**，数学上确实无差异；按代价最小的方向给出建议',
        data: { layeredEV: Number(exactLayeredEV.toFixed(2)) },
      });
      return callCandidate;
    }

    /*
     * 多人边池、且门槛口径的 EV **下界非负**（`edge >= 0`，走到这里说明落在
     * 边缘带内）⇒ 跟注是**可证明不亏**的（真实 EV 只会比下界更高），
     * 只是这个结论不是由「单一权益门槛」推出来的，所以如实说明。
     */
    if (layeredEquity) {
      /* 🔴 TEST 17：同一句里出现「权益」与「跟注 EV」⇒ 必须写明 EV 用的是哪一份（纯标注） */
      const callEvEquity = callEvEquityOf(math);
      reasons.push({
        code: 'SIDE_POT_LAYERED_EQUITY',
        textZh:
          `多人边池：我既争主池（要赢所有人）、又争边池（只需赢同层的人），` +
          '两层的胜负条件不同 ⇒ 单一权益门槛**不适用**；' +
          `但门槛口径的跟注 EV（${(math.callEV ?? 0).toFixed(2)}，本局面的**下界**，权益输入 = ${callEvEquity.usedLabelZh}）已经不为负，` +
          '跟注可证明不亏。请人工确认边池里的对手范围。',
        data: {
          edge: Number((((callEvEquity.usedValue ?? 0) - math.requiredEquity) * 100).toFixed(1)),
          equitySource: callEvEquity.usedSource,
          callEvEquity: Number((callEvEquity.usedValue ?? 0).toFixed(6)),
          equityLabelZh: callEvEquity.usedLabelZh,
          heroEquity: Number((equity * 100).toFixed(1)),
          requiredEquity: Number((math.requiredEquity * 100).toFixed(1)),
        },
      });
      return callCandidate;
    }

    /*
     * 走到这里说明真实 EV 已经判过方向（既不是负、也不是正）：
     * 只可能是「数学上真的相等」（`|EV| ≤ 1e-6` 筹码），
     * 或者**口径不足**（`verdictEdge === null`：多人边池下单一门槛不适用，
     * 且逐层 EV 算不出来）。
     */
    const bandChips = uncertaintyBandChips;

    /*
     * 🔴 **唯一允许偏离 EV 排名的情况：显式开启的不确定性覆盖**
     *（RIVER CONSISTENCY V2.1 · P0-2 · 默认关闭）。
     *
     * 判据三条同时成立才允许：
     *  ① 调用方显式开启 `allowUncertaintyOverride`；
     *  ② 真实 EV 存在且落在**模型容差带**内（`|EV| ≤ 5% × 可争夺量`）；
     *  ③ 真实 EV 为负 ⇒ 覆盖方向 = 取代价最小的跟注（弃牌不可逆）。
     *
     * 触发后必须标成 `MODEL_UNCERTAINTY_OVERRIDE`（工程启发式，**不是**数学结论）。
     */
    if (
      allowUncertaintyOverride &&
      evOfCall !== null &&
      evOfCall < -MATH_EV_EPSILON &&
      Math.abs(evOfCall) <= bandChips
    ) {
      reasons.push({
        code: 'MATH_FOLD_DOMINANT',
        textZh:
          `真实 EV 排名：**弃牌更高**（FOLD EV ≡ 0 > CALL EV ${evOfCall.toFixed(2)}）；` +
          `差距 ${Math.abs(evOfCall).toFixed(2)} 筹码落在**模型容差带** ±${bandChips.toFixed(2)} 内，` +
          '且本次分析**显式开启了不确定性覆盖** ⇒ 取代价最小的方向（跟注）。' +
          '⚠️ 这是**工程启发式，不是数学结论**（数学上弃牌 EV 更高）',
        data: {
          callEV: Number(evOfCall.toFixed(2)),
          uncertaintyBandChips: Number(bandChips.toFixed(2)),
          override: 1,
        },
      });
      return callCandidate;
    }

    /*
     * 真正的「边缘局面」：EV 相等（|ΔEV| ≤ 浮点余量）或口径不足。
     *
     * 🔴 措辞纪律（P0-2）：**不得**写「数学上没有明显优劣」——
     * 只要真实 EV 有符号，谁更高就是确定的。这里只描述两种情况：
     * ① 数学上确实相等（浮点级）；② 口径不足 ⇒ **不知道**谁更高。
     */
    reasons.push({
      code: 'MATH_MARGINAL',
      textZh:
        math.callEV === null
          ? `跟注 EV 无法计算（口径不足）⇒ **不知道**哪个动作 EV 更高，按代价最小的方向给出建议（置信度已下调）`
          : Math.abs(math.callEV) <= MATH_EV_EPSILON
            ? `跟注 EV = ${math.callEV.toFixed(6)} 筹码，弃牌 EV ≡ 0 ⇒ 两者之差在**浮点误差**以内，` +
              '**数学上确实无差异**；按代价最小的方向给出建议'
            : `真实 EV 排名：${math.callEV > 0 ? 'CALL 更高' : 'FOLD 更高'}（CALL ${math.callEV.toFixed(2)} vs FOLD 0）—— ` +
              '走到这一步说明判据口径不足，因此**不声称**数学优劣，只如实给出建议',
      data: {
        edge: Number((edge * 100).toFixed(1)),
        ...(math.callEV === null ? {} : { callEV: Number(math.callEV.toFixed(2)) }),
        uncertaintyBandChips: Number(bandChips.toFixed(2)),
      },
    });
    return callCandidate;
  }

  /* ================= 场景 2：无人下注 ================= */
  if (checkCandidate !== null) {
    const aggressive = largestAggressive(candidates);

    /*
     * 🔴 **下注资格：从「价值守门器」升级为「下注决策器」**（BET DECISION ENGINE PHASE 1）。
     *
     * 修复前：`gateWantsBet` 只认 `verdict ∈ {CLEAR_VALUE, THIN_VALUE}` 或
     * `MARGINAL 且 bet > check`。后果（审计实证）：`NOT_VALUE` 的**半诈唬**
     * 无论 EV 如何都拿不到下注资格，而半诈唬在权益 < 50% 时 `valuePart = 0`，
     * 于是结构上永远不能下注。
     *
     * 现在：当响应模型可用（`advice.betDecision !== null`）时，动作由
     * **CHECK / BET_SMALL / BET_MEDIUM / BET_LARGE 四个分支的 EV 比较**自然产生
     *（同一筹码口径）—— `NOT_VALUE` 不再禁止下注，它只是**价值侧**的判断。
     * 拿不到响应模型时回落到旧的守门器逻辑（翻前 / 无范围 ⇒ 旧行为逐位不变）。
     */
    const legacyHasInitiativeValue =
      equity !== null && context.range !== null && equity > 0.5 + MARGINAL_EV_GAP_RATIO;

    const betModel = advice?.betDecision ?? null;
    const modelWantsBet =
      betModel === null
        ? null
        : betModel.bestSize !== null && betModel.bestScore > betModel.checkScore;

    const gateWantsBet =
      advice === null
        ? null
        : advice.gate.verdict === 'CLEAR_VALUE' ||
          advice.gate.verdict === 'THIN_VALUE' ||
          (advice.gate.verdict === 'MARGINAL' &&
            advice.gate.estimatedBetEVScore > advice.gate.estimatedCheckEVScore);

    const wantsBet =
      aggressive !== null &&
      (modelWantsBet !== null
        ? modelWantsBet
        : gateWantsBet === null
          ? legacyHasInitiativeValue && tier !== 'WEAK'
          : gateWantsBet && (equity !== null || advice !== null));

    if (wantsBet) {
      reasons.push({
        code: 'STRATEGIC_VALUE_BET',
        textZh:
          betModel !== null && betModel.bestSize !== null
            ? `下注决策模型：${betModel.sizes
                .map(
                  (s) =>
                    `${s.kind} EV ${s.betEV === null ? '—' : s.betEV.toFixed(1)}`,
                )
                .join('｜')}｜CHECK EV ${betModel.checkEV === null ? '—' : betModel.checkEV.toFixed(1)}` +
              ` ⇒ 最佳尺寸 ${betModel.bestSize}（偏好分 ${betModel.bestScore.toFixed(3)} vs 过牌 0.500）` +
              '（⚠️ 启发式代理 EV，非 Solver EV）'
            : advice === null
              ? `对对手范围估计权益 ${(equity! * 100).toFixed(1)}% 且明显领先，` +
                `当前牌力（${math.handRankZh}）适合主动下注取值`
              : `相对牌力角色「${advice.roleZh}」，价值守门器判定 ${advice.gate.verdict}` +
                `（下注分 ${advice.gate.estimatedBetEVScore.toFixed(2)} vs 过牌分 ${advice.gate.estimatedCheckEVScore.toFixed(2)}，` +
                `属内部启发式比较分，非求解器 EV）`,
        data: {
          ...(equity === null ? {} : { heroEquity: Number((equity * 100).toFixed(1)) }),
          ...(advice === null ? {} : { gateVerdict: advice.gate.verdict }),
          ...(betModel === null || betModel.bestSize === null
            ? {}
            : { betSize: betModel.bestSize }),
        },
      });
      if (advice !== null) {
        for (const text of advice.gate.reasonsZh) {
          reasons.push({ code: 'VALUE_GATE', textZh: text });
        }
      }

      /*
       * 尺寸：**独立的一步**（使用者第十五节）。
       *
       * ⚠️ 当响应模型给出最佳尺寸时，用它的**合法金额**去挑候选：
       * - 最佳尺寸是 ALL_IN ⇒ **必须**落到 ALL_IN 候选（否则「模型选全下、引擎下注」
       *   会被一致性守卫判为 `ACTION_CONTRADICTS_PREFERENCE` —— 实测踩到过）；
       * - 其余 ⇒ 取离该金额最近的激进候选。
       */
      const bestSpec =
        betModel === null || betModel.bestSize === null
          ? null
          : betModel.legalSizes.find((s) => s.kind === betModel.bestSize) ?? null;
      const targetRatio =
        bestSpec !== null
          ? bestSpec.ratioToPot
          : advice !== null
            ? advice.sizing.gridRatio
            : tier === 'MONSTER'
              ? 0.75
              : tier === 'STRONG'
                ? 0.6
                : 0.45;
      const desired = bestSpec !== null ? bestSpec.betAmount : math.pot * targetRatio;
      const picked =
        bestSpec !== null && bestSpec.kind === 'ALL_IN'
          ? candidates.find((c) => c.action === DecisionAction.ALL_IN) ?? aggressive
          : pickClosestAggressive(candidates, desired) ?? aggressive;
      return picked;
    }

    reasons.push({
      code: 'STRATEGIC_CHECK',
      textZh:
        betModel !== null
          ? `下注决策模型：CHECK 策略评分 ${betModel.checkScore.toFixed(2)}（0–1 启发式偏好分，**不是筹码 EV**）` +
            `｜最佳下注 ${betModel.bestSize ?? '—'} 策略评分 ${betModel.bestScore.toFixed(2)}` +
            ` ⇒ CHECK 更受偏好（⚠️ 启发式代理模型，非 Solver EV；评分高低只表示模型偏好，**不代表任何筹码盈亏**）`
          : advice !== null
            ? `价值守门器判定 ${advice.gate.verdict}（下注分 ${advice.gate.estimatedBetEVScore.toFixed(2)} vs ` +
              `过牌分 ${advice.gate.estimatedCheckEVScore.toFixed(2)}）—— 不足以支撑主动下注，建议过牌`
            : equity === null
              ? '无法计算权益，建议过牌以控制底池'
              : `估计权益 ${(equity * 100).toFixed(1)}% 不足以支撑主动下注取值，建议过牌`,
    });
    return checkCandidate;
  }

  /* ================= 场景 3：既不能过牌也不能跟注（异常） ================= */
  return bestComparable(candidates) ?? foldCandidate;
}

/* ============================================================
 * 置信度（**刻意不含权益**（
 * ============================================================ */

/**
 * 计算决策置信度（规范第 34 / 35 节）。
 *
 * ## ⚠️ 输入里
*没有** `heroEquity`
 *
 * 「Hero 权益 80%」不代表「这个判断可信」——
 * 如果范围来源极不可靠，权益再高也不可信。
 * 因此本函数的输入只有：
 *
 * | 分量 | 含义 |
 * |---|---|
 * | 输入完整度 | 底牌 / 公共牌 / 行动历史是否齐备 |
 * | 范围可信度 | 来源是先验还是实测 |
 * | 玩家样本 | 有多少手观测 |
 * | 环境来源 | 一律启发式（0.3~0.4） |
 * | 动态置信度 | Step 7 输出的置信度 |
 * | EV 分离度 | 是否有明显占优动作 |
 * | 数学精度 | 蒙特卡洛样本量与置信区间 |
 * | 降级 | 是否发生了模块降级 |
 *
 * 取**最小值**：任一环节弱，整体就不可信。
 */
export function confidenceOf(input: {
  context: DecisionContext;
  evGapToPotRatio: number | null;
  degradations: readonly DegradationEntry[];
}): { value: number; parts: Readonly<Record<string, number>> } {
  const { context } = input;

  // ---- 1. 输入完整度 ----
  let completeness = 1;
  if (context.heroCards.length !== 2) completeness = 0;
  if (context.board.length !== 0 && context.board.length !== 3 && context.board.length !== 4 && context.board.length !== 5) {
    completeness = Math.min(completeness, 0.3);
  }
  if (context.range === null) completeness = Math.min(completeness, 0.2);
  else if (context.range.updateTrace.length === 0) completeness = Math.min(completeness, 0.7);

  // ---- 2. 范围可信度 ----
  const rangeConfidence = context.range?.confidence ?? 0;

  // ---- 3. 玩家样本 ----
  //
  // ⚠️ `0` 与「没有数据」必须区分（见 `contextBuilder` 的 `NO_DATA_NEUTRAL`）。
  // 玩家层返回 0 有两种可能：
  // - 有画像但可信度为 0（样本几乎为空）→ 真的不可信
  // - 完全没有画像且用户未手选 → 信息缺失
  // 快照的 `note` 已经区分了这两种情形，这里按 `neutralized` 判断：
  // 中性化（无数据）时视作信息缺失，给中性值；否则用真实置信度。
  const playerConfidence =
    context.player === null
      ? 0.5
      : context.player.neutralized
        ? 0.5
        : context.player.confidence > 0
          ? context.player.confidence
          : 0.5;

  // ---- 4. 环境来源（一律启发式） ----
  const environmentConfidence = context.environment.advice.length > 0 ? 0.4 : 0.3;

  // ---- 5. 动态置信度 ----
  //
  // ⚠️ 同一个区分：「本手没有该对手的事件」是信息缺失，不是数据不可信。
  // 动态层**未计算**、或算出来是 UNKNOWN（样本不足）时都给中性值，
  // 并在诊断里说明 —— 绝不让它把整体置信度拉到 0。
  //
  // 🔴 红队 F-11：`NORMAL` 也必须给**中性值**，而不能用动态层自己的
  // `confidence`（实测只有 0.25）。理由：
  //
  // `dynamic.confidence` 回答的是「我们对『他是正常打法』这个判断有多确定」，
  // 而本函数回答的是「这个决策有多可信」。两者**不是一回事**。
  // 修复前把前者直接当成后者，于是：
  //
  // | 用户提供的观察 | 端到端置信度 |
  // |---|---|
  // | 什么都不说（UNKNOWN） | **0.3000**（最高） |
  // | 主动说「他打法正常」（NORMAL） | 0.2344 |
  //
  // 「更多的信息让结论更不可信」在语义上说不通，而且会**惩罚诚实填表的用户**。
  //
  // 现在：只有**观察到偏离**（异常状态）才降低决策置信度，
  // 降幅随该观察的置信度增大。
  const dynamicAnomalous =
    context.dynamic.computed && DYNAMIC_ANOMALY_STATES.has(context.dynamic.state);
  const dynamicConfidence = dynamicAnomalous
    ? Math.max(0.3, 0.5 - 0.2 * context.dynamic.confidence)
    : 0.5;

  // ---- 6. EV 分离度 ----
  //
  // ⚠️ 语义是「占优动作与次优动作差多少」，而不是「置信度是多少」。
  // 因此 `null`（无法比较，例如只有下注类动作可比）与 `0`（完全无差异）
  // 都应当给**中性偏保守**的值，而不是 0.1 ——
  // 实测曾经因为下限 0.1 让「翻牌前 AKo 面对跟注」的置信度被压到 0.1。
  const separation =
    input.evGapToPotRatio === null
      ? 0.5
      : Math.max(0.3, Math.min(1, Math.abs(input.evGapToPotRatio) / DOMINANT_EV_GAP_RATIO));

  // ---- 7. 数学精度 ----
  const equitySource = context.math.equitySource;
  const precision =
    equitySource === null
      ? 0.2
      : equitySource.method === 'EXACT'
        ? 1
        : equitySource.iterations >= MIN_EQUITY_ITERATIONS
          ? Math.max(0.3, Math.min(1, 1 - equitySource.confidenceHalfWidth * 10))
          : 0.3;

  // ---- 8. 降级 ----
  const degradationPenalty = input.degradations.length === 0 ? 1 : Math.max(0.4, 1 - 0.2 * input.degradations.length);

  const parts = Object.freeze({
    completeness,
    rangeConfidence,
    playerConfidence,
    environmentConfidence,
    dynamicConfidence,
    separation,
    precision,
    degradationPenalty,
  });

  const value = Math.max(0, Math.min(1, Math.min(...Object.values(parts))));
  return { value, parts };
}

/* ============================================================
 * 分类
 * ============================================================ */

/**
 * 决策分类。
 *
 * ## ⚠️ `CLEAR` 必须同时满足「数学分离」与「数据可信」（红队 F-04 的修复）
 *
 * 修复前的判据**只看 EV 分离度**，与置信度无关。后果是批量输出
 * 「明确决策 + 中低置信度」这种自相矛盾的组合 ——
 * 实测 40 个样本里 `CLEAR × MEDIUM_LOW` 占 **21/40**，
 * 甚至连「AA 面对 100BB 全下」都显示
 * `建议：跟注 / 置信度「中低」/ 类型「明确决策」`。
 *
 * 对使用者来说「明确」意味着「不用犹豫」，而置信度只有 0.3
 * 意味着「数据基本不可信」——两者同时出现就是在误导。
 *
 * 现在的判据：
 *
 * | 条件 | 分类 |
 * |---|---|
 * | 信息不足 | `INSUFFICIENT_INFORMATION`（由调用方短路） |
 * | 置信度 < `CLEAR_MIN_CONFIDENCE` | `MARGINAL`（无论数学多清晰） |
 * | EV 分离度不足 / 权益区间过宽 | `MARGINAL` |
 * | 以上都不满足 | `CLEAR` |
 */
const CLEAR_MIN_CONFIDENCE = 0.55;

function classifyOf(
  actionable: boolean,
  evGapToPotRatio: number | null,
  confidence: number,
  context: DecisionContext,
): DecisionClassification {
  if (!actionable) return DecisionClassification.INSUFFICIENT_INFORMATION;

  // 数据不够可信时**不允许**标「明确」
  if (confidence < CLEAR_MIN_CONFIDENCE) return DecisionClassification.MARGINAL;

  // 权益不确定度过大 → 至少是边缘
  const source = context.math.equitySource;
  const wideInterval = source !== null && source.confidenceHalfWidth > 0.03;
  if (wideInterval) return DecisionClassification.MARGINAL;

  if (evGapToPotRatio === null) return DecisionClassification.MARGINAL;
  const clear = Math.abs(evGapToPotRatio) >= MARGINAL_EV_GAP_RATIO * 2;
  return clear ? DecisionClassification.CLEAR : DecisionClassification.MARGINAL;
}

/* ============================================================
 * Dynamic Shadow
 * ============================================================ */

/**
 * 计算 Dynamic 的影响（Shadow 模式）。
 *
 * ## 第一版的核心纪律（规范第 36 / 39 / 40 / 76 节）
 *
 * - Dynamic **不直接改动作**。它只改**置信度**与**分类**。
 * - 只有当 Dynamic 置信度 ≥ `DYNAMIC_FLIP_MIN_CONFIDENCE` **且**
 *   不存在明显数学占优动作时，才**允许**「降级建议」（把 CLEAR 降为 MARGINAL）。
 * - Alpha 第一版**不允许** Dynamic 翻转动作 —— 因为它的幅度是
 *   `UNVERIFIED_MAGNITUDE`（没有任何校准数据）。
 *
 * 这不是「保守」，而是纪律：`dynamicAdapter` 自己标了幅度未验证，
 * 让一个未验证的幅度去翻转一个有数学依据的结论，是本项目明确禁止的。
 */
export function dynamicShadowOf(input: {
  baseDecision: DecisionCandidate | null;
  adjustedDecision: DecisionCandidate | null;
  context: DecisionContext;
  mathDominance: MathDominanceVerdict;
  baseConfidence: number;
  adjustedConfidence: number;
}): DynamicShadowComparison {
  const base = input.baseDecision;
  const adjusted = input.adjustedDecision;
  const dynamic = input.context.dynamic;

  const actionChanged = base !== null && adjusted !== null && base.action !== adjusted.action;
  const sizeChanged =
    base !== null && adjusted !== null && (base.sizeChips ?? 0) !== (adjusted.sizeChips ?? 0);
  const confidenceChanged = Math.abs(input.baseConfidence - input.adjustedConfidence) > 1e-9;

  const magnitudeProvenance =
    dynamic.adapted.length === 0
      ? ('HEURISTIC' as const)
      : (dynamic.adapted[0]!.magnitudeProvenance as 'VERIFIED' | 'HEURISTIC' | 'UNVERIFIED_MAGNITUDE');

  const dynamicAllowedToFlip =
    dynamic.computed &&
    dynamic.confidence >= DYNAMIC_FLIP_MIN_CONFIDENCE &&
    !input.mathDominance.dominant &&
    magnitudeProvenance === 'VERIFIED';

  let noteZh: string;
  if (!dynamic.computed) {
    noteZh = '动态层未参与（本手没有该对手的可用事件）';
  } else if (dynamic.state === 'UNKNOWN') {
    noteZh = `动态层状态 UNKNOWN（置信度 ${dynamic.confidence.toFixed(2)}），不构成调整依据`;
  } else if (input.mathDominance.dominant) {
    noteZh =
      '存在数学上明显占优的动作，动态观察**不允许**翻转它' +
      `（动态置信度 ${dynamic.confidence.toFixed(2)}，幅度来源 ${magnitudeProvenance}）`;
  } else if (!dynamicAllowedToFlip) {
    noteZh =
      `动态观察不足以翻转动作：置信度 ${dynamic.confidence.toFixed(2)}` +
      `（门槛 ${DYNAMIC_FLIP_MIN_CONFIDENCE}），幅度来源 ${magnitudeProvenance}` +
      '（Alpha 第一版只允许**已校准**幅度翻转动作）';
  } else {
    noteZh = `动态观察达到翻转条件（置信度 ${dynamic.confidence.toFixed(2)}，幅度来源 ${magnitudeProvenance}）`;
  }

  if (actionChanged && !dynamicAllowedToFlip) {
    noteZh += ' ⚠️ 内部检测到动作差异，但被 Shadow 纪律拒绝采用基础决策的动作';
  }

  return Object.freeze({
    baseDecision: base,
    adjustedDecision: adjusted,
    actionChanged,
    sizeChanged,
    confidenceChanged,
    dynamicConfidence: dynamic.confidence,
    magnitudeProvenance,
    dynamicAllowedToFlip,
    noteZh,
  });
}

/* ============================================================
 * 主入口
 * ============================================================ */

/**
 * 生成 Alpha 决策」
 *
 * ## 顺序（刻意固定）
 *
 * ```
 * 1. 信息充分性检查   → 不足则直接返回 INSUFFICIENT_INFORMATION
 * 2. 评估全部合法动作 → 每个动作的 EV 与可行性
 * 3. Math Dominance   → 是否存在明显占优动作（**只算，不推理由**）
 * 4. 选择动作         → 数学优先，策略其次；**动作的理由先进入首屏**
 * 4.5 Math Dominance 理由 → 排在动作理由之后（否则首屏会自相矛盾）
 * 5. 合法性自检       → 输出的动作必须在 legal.actions 内
 * 6. 置信度与分类     → 刻意不含权益
 * 7. Shadow 对比      → 动态层的影响显式暴露
 * ```
 */
export function decideAlpha(
  context: DecisionContext,
  legal: LegalActions,
  /**
   * 🔴 可选的决策策略开关（RIVER CONSISTENCY V2.1 · P0-2）。
   *
   * | 开关 | 默认 | 含义 |
   * |---|---|---|
   * | `allowUncertaintyOverride` | **false** | 真实 EV 存在时是否允许「模型容差带内取代价最小方向」。关闭时动作 = 最高真实 EV 动作 |
   */
  options: { allowUncertaintyOverride?: boolean } = {},
): AlphaDecision {
  const allowUncertaintyOverride = options.allowUncertaintyOverride === true;
  const degradations: DegradationEntry[] = [];

  /* ---- 1. 信息充分性 ---- */
  const insufficientReasons = checkSufficiency(context);
  const actionable = insufficientReasons.length === 0;

  /* ---- 2. 评估候选 ---- */
  //
  // ⚠️ 理由分成两批，**顺序就是界面首屏的优先级**：
  //
  // - `decisionReasons`：**这个动作为什么被选中**（第 4 步由 `pickCandidate` 推入）
  // - `factReasons`：通用事实（底池赔率、权益估计等），永远成立，但不解释动作
  //
  // 界面首屏只显示前 3 条（`reasons.slice(0, 3)`）。
  // 🔴 实测踩到的解释缺陷：通用事实先进入列表时，首屏会出现
  // 「建议：加注」配「**跟注**在数学上明显占优」——
  // 两句都真，并排读却自相矛盾，使用者无法知道该信哪句。
  const evaluated = evaluateCandidates(context, legal);
  const candidates = evaluated.candidates;
  const decisionReasons: DecisionReason[] = [];
  const factReasons: DecisionReason[] = [...evaluated.reasons];

  /* ---- 2.5 多人池口径声明 ----
   *
   * 🔴 这一条**必须在输出里**，不能只写在注释里（红队 F-06 的教训：
   * 注释里的承诺不算承诺，只有代码里的行为算）。
   *
   * ## 修复前它说的是「权益只按单挑口径估算」
   *
   * 那句话当时是**真的**：`contextBuilder` 只把首要对手交给范围构建。
   * 于是 ≥3 家时决策层干脆拒绝给建议。
   *
   * ## 现在权益是**多人口径**，因此这条声明的内容也要跟着改成事实
   *
   * 仍然要声明，因为「算了几家」这件事使用者看不见 ——
   * 而它直接决定权益数字能不能信。只是说法从
   * 「权益偏乐观、请人工下调」变成「权益已按 N 家算，未行动的 M 家不在里面」。
   */
  if (context.realizedOpponentCount >= 2) {
    const positions = context.opponentRanges
      .map((r) => r.opponentPositionZh)
      .filter((p) => p.length > 0);
    degradations.push({
      code: 'MULTIWAY_APPROXIMATION',
      textZh:
        `ℹ️ 本手有 ${context.realizedOpponentCount} 名对手**真正进入**了这一手，` +
        `权益已按**这 ${context.realizedOpponentCount} 家一起**计算` +
        (positions.length > 0 ? `（${positions.join(' / ')}），` : '，') +
        '与底池赔率口径一致。' +
        (context.playersRemainingToAct > 0
          ? `**我行动之后还有 ${context.playersRemainingToAct} 名对手必须行动**（下注重新打开了行动）——` +
            '本次跟注不是 closing action。'
          : '本街已无人待行动（closing action）。') +
        `多人池要求更高的范围可信度（${MIN_RANGE_CONFIDENCE_MULTIWAY}），` +
        '而本项目用的是**启发式**范围（非求解器输出），越多人池误差越大 —— ' +
        '请把它当作参考而非精确结论。',
      impact: 'MATH',
    });
  }

  /* ---- 2.6 「后面还有人没说话」提示（Table Topology Correction）----
   *
   * 🔴 与上面那条**不是同一件事**，必须分开说：
   *
   * - 上面那条：已经有人进池了 → 权益算少了 → **偏乐观**
   * - 这条：后面还有人**可能**进池 → 现在还算不出来 → **数字这一刻是准的，
   *   但它描述的是一个还没结束的局面**
   *
   * 修复前这两件事被同一个 `activeOpponentCount` 混着表达，于是
   * 「没人说话」和「有人跟注」在系统看来一模一样 —— 满桌开池因此被
   * 一律拒绝。分开之后：既不再误拒，也不隐瞒「后面还有人」。
   *
   * ⚠️ 同样**不做数值修正**（第一版没有多人权益引擎），只声明方向。
   */
  /*
   * 🔴 **跟注不是 closing action**（TEST HAND MULTIWAY TURN FIX · 问题 3）。
   *
   * 判据取自行列 `playersRemainingToAct`（下注重开行动 ⇒ 已经过牌的人还要再表态），
   * 而不是「本街还没说过话的人」。此时：
   * · 底池赔率 / 所需权益**照常给出**（它们是基础数学参考，§十四）；
   * · 但跟注 EV 必须如实标成**代理值**，并明确它不含后位玩家继续跟注/加注的影响。
   */
  if (actionable && legal.callCost > 0 && !context.isClosingAction) {
    degradations.push({
      code: 'ACTION_NOT_CLOSED',
      textZh:
        `⚠️ 跟注后仍有 ${context.playersRemainingToAct} 名对手未行动，` +
        '当前跟注 EV 为**简化代理值**，未包含后位玩家继续跟注或加注的影响' +
        '（底池赔率与所需权益仍然有效，可直接参考）。',
      impact: 'MATH',
    });
  }

  if (context.playersYetToAct >= YET_TO_ACT_NOTICE_THRESHOLD) {
    degradations.push({
      code: 'PLAYERS_YET_TO_ACT',
      textZh:
        `ℹ️ 后面还有 ${context.playersYetToAct} 名对手**尚未行动**（他们还没有投入、` +
        '因此没有进入权益计算）。如果他们中有人跟注或加注，本手会变成真正的多人池，' +
        '届时的实际权益会低于当前估计 —— **建议在有人进池后重新分析**。',
      impact: 'MATH',
    });
  }

  /* ---- 3. Math Dominance（先算，但**理由稍后再推**）---- */
  //
  // ⚠️ 计算必须在这里（`confidenceOf` 与 `dynamicShadowOf` 都要用），
  // 但**理由的插入顺序**刻意放在第 4 步之后 —— 见下面的说明。
  const mathDominance = (() => {
    const isoFacts = context.preflopIso ?? null;
    const isoChips =
      isoFacts !== null && isoFacts.isoSize.legalIsoSize !== null
        ? isoFacts.isoSize.legalIsoSize * context.math.bigBlind
        : null;
    const isoEV = isoFacts !== null ? isoFacts.isoEV.proxyEV : null;
    if (isoEV === null || isoChips === null) return mathDominanceOf(candidates, context.math.pot);
    /*
     * 🔴 隔离加注**带自己的 EV**时，必须让它进入「可比较动作」的比较集：
     * 否则会同时输出「建议加注」与「跟注明显占优」——自相矛盾。
     */
    let included = false;
    const augmented = candidates.map((c) => {
      if (c.action !== DecisionAction.RAISE || (c.sizeChips ?? 0) !== isoChips) return c;
      included = true;
      return { ...c, ev: isoEV };
    });
    return mathDominanceOf(augmented, context.math.pot, included);
  })();

  /* ---- 4. 选择动作 ---- */
  //
  // `pickCandidate` 把「为什么选这个动作」的理由推进 `decisionReasons`，
  // 这些理由**优先占据首屏**（见第 2 步的说明）。
  /*
   * 🔴 **翻后建议器**（2026-09 翻后升级 · P2/P3）：算**一次**，两处共用 ——
   * 判据用它、诊断输出也用它（同一个对象 ⇒ 界面显示的角色与实际参与
   * 判断的角色不可能分歧）。
   */
  const postflopAdvice = actionable
    ? advisePostflop(context, {
        facingBet: legal.callCost > 0,
        requiredEquity: context.math.requiredEquity,
        potAfterCall: context.math.pot + legal.callCost,
      })
    : null;

  /*
   * 🔴 **第二阶段任务一：下注金额一致性
*。
   *
   * 响应模型评估的是 `betDecision` 里那下
*合法金额**（按有效筹码封顶、整筹码），
   * 而决策层的候选网格来自另一套百分比） .25/1/3/0.5/2/3/0.75/1 × 底池）。
   * 两者可能都对不上（实测 BB 20BB 节点：被评估 **14**、网格里只有 13/18 ⇒ 推荐被吸别 13）。
   *
   * 后果不是「显示不精确」：**界面展示的响应概率与 EV 属于另一个金额
*。
   * 修复方式 = 把被评估的那个合法金额
*补进候选
*（只在缺失时补、只补一个「
   * 且与其它下注候选同样 `ev = null`）⇒ 尺寸规则随后自然选中它，
   * 既不改变任何 EV 判据，也不删除任何既有候选」
   */
  const candidatesForDecision = (() => {
    const bd = postflopAdvice?.betDecision ?? null;
    if (bd === null || bd.bestSize === null) return candidates;
    const spec = bd.sizes.find((s) => s.kind === bd.bestSize) ?? null;
    if (spec === null || !(spec.betAmount > 0)) return candidates;
    const amount = spec.betAmount;
    const already = candidates.some(
      (c) =>
        (c.action === DecisionAction.BET || c.action === DecisionAction.ALL_IN) &&
        c.sizeChips !== undefined &&
        Math.abs(c.sizeChips - amount) < ALL_IN_COMPARE_EPSILON,
    );
    if (already) return candidates;
    const extra: DecisionCandidate = {
      action: DecisionAction.BET,
      sizeChips: amount,
      sizeBB: amount / context.math.bigBlind,
      ev: null,
      mathFeasible: true,
      noteZh: '响应模型**被评估**的那个合法金额（补进候选以保证「推荐金额 = 被评估金额」）',
    };
    return Object.freeze([...candidates, Object.freeze(extra)]) as readonly DecisionCandidate[];
  })();

  const evidenceOut: { decision?: EvidenceDecision; list?: readonly ActionEvidence[];
    raiseShape?: {
      consumesStack: boolean;
      hasOwnEV: boolean;
      /**
       * 🔴 U1 披露一致性：真正有「自有可比 EV」的加注尺寸（raise-to 口径）。
       * `unevaluatedActions` 必须**跳过**这些尺寸，否则会一边用加注 EV 做决策。
       * 一边声称加注 EV 未实现「
       */
      raiseSizesWithOwnEV: readonly number[];
      onePairAllInBlocked: boolean;
      largeRaiseBlocked: boolean;
      raiseToPotRatio: number | null;
      raiseEquitySource: 'EqVsBetRange' | 'FALLBACK_WHOLE_RANGE';
      commitmentException: boolean;
      commitmentClause: 'ROLE_STRENGTH' | 'FUTURE_STREET_COMMITMENT' | null;
      overrideJustificationKind: string | null;
    };
  } = {};
  const baseDecision = actionable    ? pickCandidate(
        context,
        legal,
        candidatesForDecision,
        decisionReasons,
        postflopAdvice,
        allowUncertaintyOverride,
        evidenceOut,
      )
    : null;
  /** 证据优先级裁决结果（由 `pickCandidate` 的出口箱带回；供依据/诊断/UI 使用） */
  const evidenceDecisionForBasis: EvidenceDecision | null = evidenceOut.decision ?? null;
  const evidenceForBasis: readonly ActionEvidence[] = evidenceOut.list ?? Object.freeze([]);

  /*
   * ============================================================ * ---- 4.1 RIVER RAISE DECISION V2：动作形态 / 全下保护 / 未评估动作 ----
   * ============================================================ *
   * 三件必须在输出里说清楚的事（§主 / §四 / §六），
   *
   * ```text
   * ① 这次动作是什么形态（普通加注 / 加注到全下 / 直接全下（
   * ① 全下保护有没有命中（一对牌 + 打光筹码 + 无自有 EV（
   * ① 还有哪些**合法但未评估**的动作（EV = NOT_IMPLEMENTED）
   * ```
   *
   * ⚠️ ③ 是对外口径的关键：本次动作是「在**可评估
*候选之间」的裁决：
   * **不是**「所有合法动作中的最优解」。没有这一条，界面就会把一个
   * 未建模的动作说成已经被比过。
   */
  const finalSizeChips: number | null = baseDecision?.sizeChips ?? null;  const consumesStackForAction =
    finalSizeChips !== null && Math.abs(finalSizeChips - legal.allInToAmount) < ALL_IN_COMPARE_EPSILON;
  const actionShapeKind = ((): 'FOLD' | 'CALL' | 'CHECK' | 'BET' | 'NORMAL_RAISE' | 'RAISE_TO_ALL_IN' | 'DIRECT_ALL_IN' | 'NONE' => {
    if (baseDecision === null) return 'NONE';
    const a = String(baseDecision.action);
    if (a === 'RAISE') return consumesStackForAction ? 'RAISE_TO_ALL_IN' : 'NORMAL_RAISE';
    if (a === 'ALL_IN') return 'DIRECT_ALL_IN';
    if (a === 'BET') return 'BET';
    if (a === 'CALL') return 'CALL';
    if (a === 'CHECK') return 'CHECK';
    return 'FOLD';
  })();
  const actionShape = Object.freeze({
    kind: actionShapeKind,
    sizeChips: finalSizeChips,
    allInToAmount: legal.allInToAmount,
    consumesStack: consumesStackForAction,
    noteZh:
      actionShapeKind === 'RAISE_TO_ALL_IN'
        ? `加注： ${String(finalSizeChips)} = 本街总额上限（把剩余 ${legal.myRemainingStack} 全部投入）⇒ **这一注就是全下**`
        : actionShapeKind === 'NORMAL_RAISE'
          ? `普通加注（本街总额 ${String(finalSizeChips)}，上： ${legal.allInToAmount}）⇒ 不消耗全部筹码`
          : actionShapeKind === 'DIRECT_ALL_IN'
            ? '直接全下（不是加注到全下）'
            : `动作 ${actionShapeKind}（不涉及加注）`,
  });
  const rs = evidenceOut.raiseShape;
  const allInGuard = Object.freeze({
    handCategory: context.math.handCategory,
    minCategoryForLargeRaise: MIN_CATEGORY_FOR_LARGE_RAISE,
    /* 🔴 PREFLOP P0（F2）：本判定所适用的街道（决定保护是否适用，见 `allInGuardVerdictOf`） */
    street: context.math.street,
    consumesStack: rs?.consumesStack ?? false,
    hasOwnEV: rs?.hasOwnEV ?? false,
    /*
     * 🔴 U1 披露一致性：哪些加注尺寸真的有自有可比 EV（raise-to 口径）。
     * 不 `unevaluatedActions` 同源（`evidenceOut.raiseShape`）—— 两处口径必须一致，
     * 否则又会出现「用它做决策、同时说它没实现」。
     */
    raiseSizesWithOwnEV: rs?.raiseSizesWithOwnEV ?? Object.freeze([] as number[]),
    raiseToPotRatio: rs?.raiseToPotRatio ?? null,
    onePairAllInBlocked: rs?.onePairAllInBlocked ?? false,
    largeRaiseBlocked: rs?.largeRaiseBlocked ?? false,
    /* 🔴 §五：放行条款必须逐条可审计（修复「注记说何 SPR、实际靠 roleStrength」） */
    roleStrength: postflopAdvice === null ? null : postflopAdvice.roleStrength,
    spr: context.math.spr,
    stackOffAllowed:
          postflopAdvice === null ? null : postflopAdvice.commitment.stackOffAllowed,
    commitmentException: rs?.commitmentException ?? false,
    commitmentClause: rs?.commitmentClause ?? null,
    overrideJustificationKind: rs?.overrideJustificationKind ?? null,
    noteZh:
      rs === undefined
        ? '本节点没有加注候完 全下保护不适用'
        : allInGuardVerdictOf({
            handCategory: context.math.handCategory,
            consumesStack: rs.consumesStack,
            hasOwnEV: rs.hasOwnEV,
            /* 🔴 PREFLOP P0（F2）：诊断侧必须与决策侧传同一个街道（M2） */
            street: context.math.street,
          }).reasonZh,
  });
  const unevaluatedActions = (() => {
    const out: { action: string; sizeChips: number | null; ev: null; reasonCode: string; reasonZh: string }[] = [];
    /*
     * 🔴 **U1 披露一致性
*：已经有「自己的可比 EV」的加注尺寸**不是**未评估动作「
     *
     * 修复前的口径：`c.ev !== null` 才算已评估 —— 但加注候选的 `ev` 字段
     * **永远**是 null（加注 EV 挂在 `actionEvidence` 上）。实测的自相矛盾（
     *
     * ```text
     * 99 暗三条节点：动作 = RAISE @174（依据 RAISE MODEL_EV +140.01）
     * 同一份诊断：unevaluatedActions 里列着「RAISE 174 RAISE_EV_NOT_IMPLEMENTED」
     * ```
     *
     * 现在只列**真的**没有 EV 的金额（其余金额确实仍未建模，如实保留）。
     */
    const sizesWithOwnEV = evidenceOut.raiseShape?.raiseSizesWithOwnEV ?? [];
    for (const c of candidates) {
      if (c.ev !== null) continue;
      const label = String(c.action);
      const isRaiseLike = label === 'RAISE' || label === 'ALL_IN';
      if (isRaiseLike && c.sizeChips !== undefined && sizesWithOwnEV.some((s) => Math.abs(s - c.sizeChips!) < ALL_IN_COMPARE_EPSILON)) {
        continue;
      }
      out.push({
        action: label,
        sizeChips: c.sizeChips ?? null,
        ev: null,
        reasonCode: isRaiseLike ? 'RAISE_EV_NOT_IMPLEMENTED' : 'BET_EV_NOT_IMPLEMENTED',
        reasonZh: isRaiseLike
          ? 'RAISE_EV_NOT_IMPLEMENTED：该金额缺「他面对这次加注的响应概率与加注继续范围」⇒ ' +
            '本动作未参与 EV 比较（不是「EV = 0」，也不是「更差」）'
          : 'BET_EV_NOT_IMPLEMENTED：下注 EV 依赖对手弃牌率，本项目没有可信估计 ⇒ 本动作未参与 EV 比较',
      });
    }
    /*
     * ⚠️ **逐候选
*列出，不按动作名去重：同一个 RAISE 在不同金额上都是
     * 「合法但未评估」的动作，只报一个金额会让人误以为其余金额已被算过」
     */
    return Object.freeze(out.map((x) => Object.freeze(x)));
  })();
  if (unevaluatedActions.some((u) => u.reasonCode === 'RAISE_EV_NOT_IMPLEMENTED')) {
    const evaluatedRaiseSizes = evidenceOut.raiseShape?.raiseSizesWithOwnEV ?? [];
    factReasons.push({
      code: 'RAISE_EV_NOT_IMPLEMENTED',
      textZh:
        evaluatedRaiseSizes.length > 0
          ? `⚠️ **部分**加注金额没有 EV（RAISE_EV_NOT_IMPLEMENTED）：` +
            `加注： ${evaluatedRaiseSizes.map((s) => s.toFixed(0)).join(' / ')} 有模型 EV（面对加注的响应模型），` +
            `但其余金额仍缺「他面对这次加注的响应概率与加注继续范围」⇒ ` +
            '上述动作是「在**可评估**候选之间的裁决」，**不是**所有合法动作中的最优解'
          : `⚠️ 本次加注/全下**没有** EV 模型（RAISE_EV_NOT_IMPLEMENTED）：` +
            `缺「他面对这次加注的响应概率与加注继续范围」⇒ ` +
            `上述动作是「在**可评估**候选（弃牌 EV ≡ 0、跟注 EV）之间的裁决」，` +
            '**不是**所有合法动作中的最优解',
      data: { unevaluatedCount: unevaluatedActions.length, evaluatedRaiseSizes: evaluatedRaiseSizes.length },
    });
  }
  const conditionalEquities = Object.freeze({
    arrivalRange: context.postflopFacts?.betRangeArrival?.heroEquityVsArrivalRange ?? null,
    betRange: context.math.heroEquityVsBetRange,
    wholeRange: context.math.heroEquity,
    /*
     * 🔴 U1：面对加注的继续范围权益 —— 已实现（`contextBuilder` 的 `raiseResponse`）。
     * 仍然可能不可得（没有加注候选 / 权益算不出来）⇒ 那时如实标注 `NOT_IMPLEMENTED`、
     */
    raiseContinueRange:
      ((context.postflopFacts as unknown as Record<string, any> | undefined)?.['raiseResponse']?.[
        'heroEquityVsRaiseCallRange'
      ] as number | null | undefined) ?? ('NOT_IMPLEMENTED' as const),
    usedByRaiseThreshold: rs?.raiseEquitySource ?? null,
    noteZh:
      '到达范围 = P(手牌 | 他走到这个节点拥有什么)；下注范围 = P(手牌 | 他选择下注)（CALL EV 与加注门槛共用）' +
      '加注继续范围 = P(手牌 | 他下注且他跟注我的加注)（RAISE EV 用它；不可得时标注 NOT_IMPLEMENTED，绝不用别的条件权益顶替）',
  });

  /* ---- 4.2 理由合成：动作理由 → 通用事实 ---- */
  let reasons: DecisionReason[] = [...decisionReasons, ...factReasons];

  /* ---- 4.5 Math Dominance 的理由（排在动作理由之后）---- */
  if (mathDominance.dominant) {
    reasons.push({
      code: 'MATH_DOMINANCE',
      textZh: mathDominance.noteZh,
      data: {
        evGap: Number((mathDominance.evGap ?? 0).toFixed(3)),
        thresholdRatio: mathDominance.thresholdRatio,
      },
    });
  }

  /* ---- 5. 合法性自检（规范第 22 节的最后一道闸）---- */
  if (baseDecision !== null && !legal.actions.includes(baseDecision.action)) {
    // 这属于**代码缺陷**（不是数据问题）—— 必须显式暴露，绝不静默降级
    throw new Error(
      `decideAlpha: 内部错误 —— 选出的动作 ${baseDecision.action} 不在合法动作集合 ` +
        `[${legal.actions.join(', ')}] 内。这是决策引擎的 Bug，不允许静默降级。`,
    );
  }

  /* ---- 6. 置信度与分类 ---- */
  const confidenceResult = confidenceOf({
    context,
    evGapToPotRatio: mathDominance.evGapToPotRatio,
    degradations,
  });

  // 动态层只影响置信度（Shadow 模式）
  //
  // ⚠️ 三个条件缺一不可：
  // - `computed`：本手确实算过动态层
  // - `DYNAMIC_ANOMALY_STATES.has(state)`：动态层确实**观察到偏离**
  // - `confidence > 0`：该观察有非零置信度
  //
  // 🔴 红队 F-11：修复前只要求前两个条件的「宽松版」（`confidence > 0`
  // 而不看 `state`），于是「主动填了观察」反而比「什么都不填」置信度更低 ——
  // 语义上说不通，而且惩罚诚实填表的用户。
  //
  // 现在 `NORMAL` / `UNKNOWN` 一律不惩罚（惩罚因子 = 1），
  // 只有真正观察到偏离时才降低置信度。
  const dynamicPenalty =
    context.dynamic.computed &&
    DYNAMIC_ANOMALY_STATES.has(context.dynamic.state) &&
    context.dynamic.confidence > 0
      ? Math.max(0.3, 1 - 0.25 * context.dynamic.confidence)
      : 1;
  const adjustedConfidence = actionable ? confidenceResult.value * dynamicPenalty : 0;

  if (!actionable) {
    reasons.length = 0;
    reasons.push(...insufficientReasons);
  }

  const classification = classifyOf(
    actionable,
    mathDominance.evGapToPotRatio,
    adjustedConfidence,
    context,
  );

  /* ---- 7. Shadow 对比 ---- */
  const shadow = dynamicShadowOf({
    baseDecision,
    // Alpha 第一版：动态**不改变**动作，adjusted 与 base 相同。
    // 保留这个字段是为了让「未来允许动态调整」时的差异**可被观测**。
    adjustedDecision: baseDecision,
    context,
    mathDominance,
    baseConfidence: confidenceResult.value,
    adjustedConfidence,
  });

  if (context.dynamic.computed && context.dynamic.state !== 'NORMAL' && context.dynamic.state !== 'UNKNOWN') {
    reasons.push({
      code: 'DYNAMIC_OBSERVED',
      textZh:
        `对手近期行为观察：${context.dynamic.state}（证据置信度 ${context.dynamic.confidence.toFixed(2)}，` +
        '幅度未校准，仅用于调整置信度）',
      data: { dynamicConfidence: context.dynamic.confidence, deviationScore: context.dynamic.deviationScore },
    });
  }

  if (context.environment.advice.length > 0) {
    reasons.push({
      code: 'ENVIRONMENT_DIRECTION',
      textZh:
        `牌局环境「${context.environment.labelZh}」提供了 ${context.environment.advice.length} 条方向参考` +
        '（无幅度，仅方向）',
      data: { adviceCount: context.environment.advice.length },
    });
  }

  reasons.push({ code: 'RAKE_MODEL', textZh: '抽水模型：未计入（本项目尚无 Rake Engine，EV 为未计抽水口径）' });

  /* ---- 组装 ---- */
  const finalCandidate = baseDecision;
  // ⚠️ 信息不足时**没有动作**（`null`），而不是伪装成 `FOLD`（红队 F-05）。
  //
  // 修复前是 `finalCandidate?.action ?? DecisionAction.FOLD`，
  // 于是「系统拒绝给建议」在 HTTP 响应与 JSONL 日志里长得和
  // 「系统建议弃牌」一模一样 —— 机器可读字段与真实语义相反。
  const action = finalCandidate?.action ?? null;

  /* ============================================================
   * ---- 6.5 决策一致性守卫（RIVER CONSISTENCY V2 · 使用者 §19）----
   * ============================================================ */

  /*
   * 使用者的要求：**产出前**跑一遍，开发环境 assert / 测试失败，
   * 生产环境显式显示 `DECISION_CONSISTENCY_ERROR`，**绝不静默**。
   *
   * 本项目没有 `NODE_ENV` 这套约定，因此实现方式刻意选了「两边都安全」的一种：
   *
   * | 场合 | 行为 |
   * |---|---|
   * | 任何场合 | 违规进入 `diagnostics.consistency`，并在首屏理由里输出 `DECISION_CONSISTENCY_ERROR` 全文 |
   * | 测试 | `test/riverConsistency.test.ts` 直接断言 `violations.length === 0`（等于「必须失败」） |
   * | 生产 | 不抛异常 —— 抛异常会让使用者拿不到任何建议，比「带警告的建议」更糟 |
   *
   * 「开发即失败」由测试承担，而不是由 `throw` 承担：这样同一份代码在生产
   * 只会**大声报错**，不会把用户挡在门外。
   */
  const uncertaintyBandChips = MODEL_UNCERTAINTY_RATIO * context.math.winnable;
  /*
   * 本次动作**是否真的由「不确定性覆盖」产生**：严格复算那条分支的四个条件
   * （与 `pickCandidate` 里的判据同一表达式），因此守卫与界面不会各说各话。
   */
  const overrodeByUncertainty =
    allowUncertaintyOverride &&
    action === 'CALL' &&
    legal.callCost > 0 &&
    context.math.callEV !== null &&
    context.math.callEV < -MATH_EV_EPSILON &&
    Math.abs(context.math.callEV) <= uncertaintyBandChips;
  const consistencyViolations: ConsistencyViolation[] = actionable
    ? validateDecisionConsistency({
        street: context.math.street,
        action,
        actionable,
        legalActions: legal.actions,
        sizeChips: finalCandidate?.sizeChips ?? null,
        pot: context.math.pot,
        callCost: context.math.callCost,
        requiredEquity: context.math.requiredEquity,
        callEV: context.math.callEV,
        uncertaintyBand: uncertaintyBandChips,
        allowUncertaintyOverride,
        overrodeByUncertainty,
        role: postflopAdvice === null ? null : postflopAdvice.role,
        futureCardProtectionScore:
          postflopAdvice === null ? null : postflopAdvice.gate.futureCardProtectionScore,
        futureStreetCommitmentBonus:
          postflopAdvice === null ? null : postflopAdvice.commitment.futureStreetCommitmentBonus,
        preferenceScores: (postflopAdvice?.scores ?? []).map((s) => ({
          action: s.action,
          score: s.normalizedEVScore,
        })),
        warningsZh: reasons.map((r) => r.textZh),
        settlement: null,
      })
    : [];

  /*
   * ---- 6.6 决策依据必须写出来（使用者 §8：UI 解释与生产动作同一口径）----
   */
  const decisionBasis: DecisionBasis = decisionBasisOf({
    action,
    actionable,
    facingBet: legal.callCost > 0,
    callEV: context.math.callEV,
    uncertaintyBand: uncertaintyBandChips,
    allowUncertaintyOverride,
    overrodeByUncertainty,
    /*
     * 🔴 **解释层必须读真实决策来源**（§9）：无人下注时若动作由下注决策模型
     * 的 EV 比较选出，依据就写 `ACTION_EV_COMPARISON` 并附合法动作表，
     * 不再谎称「价值守门器的偏好分选出」。
     */
    byBetDecisionModel: !isFacingBet(context) && postflopAdvice?.betDecision !== null && postflopAdvice?.betDecision !== undefined && action !== 'CHECK',
    ...(postflopAdvice?.betDecision === null || postflopAdvice?.betDecision === undefined
      ? {}
      : {
          betDecisionTableZh: [
            `CHECK EV ${postflopAdvice.betDecision.checkEV === null ? '—' : postflopAdvice.betDecision.checkEV.toFixed(1)}`,
            ...postflopAdvice.betDecision.legalSizes.map(
              (s) =>
                `${s.kind === 'ALL_IN' ? 'ALL-IN' : s.kind} ${s.betAmount.toFixed(0)} EV ${s.betEV === null ? '—' : s.betEV.toFixed(1)}`,
            ),
            `最佳 = ${postflopAdvice.betDecision.bestSize ?? 'CHECK'}`,
          ].join('｜'),
        }),
    /*
     * 🔴 证据裁决来源（PREFLOP EVIDENCE PRIORITY FIX）：
     * 加注/全下动作的真实来源从此由 `chooseByEvidencePriority` 决定，
     * 不再一律写 `SAFETY_RULE`（§17）。
     */
    evidenceSource: evidenceDecisionForBasis?.source ?? null,
    evidenceNoteZh: evidenceDecisionForBasis === null ? null : evidenceDecisionForBasis.reasonZh.join('；'),
  });
  if (actionable) {
    reasons.push({
      code: 'DECISION_BASIS',
      textZh: `本次动作的决策依据（${decisionBasis.kind}）：${decisionBasis.noteZh}`,
      data: {
        basis: decisionBasis.kind,
        uncertaintyBandChips: Number(uncertaintyBandChips.toFixed(2)),
        allowUncertaintyOverride: allowUncertaintyOverride ? 1 : 0,
      },
    });
  }
  if (consistencyViolations.length > 0) {
    reasons.unshift({
      code: 'DECISION_CONSISTENCY_ERROR',
      textZh: consistencyErrorZh(consistencyViolations),
      data: { violationCount: consistencyViolations.length },
    });
  }

  /*
   * 🔴 **决策边际**（P0 修复）：与「模型置信度」是两件事。
   *
   * | 量 | 回答的问题 | 判据 |
   * |---|---|---|
   * | `decisionMargin` | 离「翻面」有多远 | 真实 EV 与 0 的距离 vs 工程容差带 |
   * | `postflop.confidence` | 首选比次选好多少 | 偏好分差（`confidenceOf`） |
   *
   * 修复前只有后者，于是「调用 EV = −317 筹码（比容差带大 3 倍）」与
   * 「模型置信度 LOW」被混成一句话。
   *
   * ⚠️ 用的 EV 与决策**同源**：分层精确值优先（`pickCandidate` 的口径），
   * 否则用 `math.callEV`。绝不在这里另算一遍。
   */
  const decisionMargin: DecisionMarginFacts = (() => {
    const layered = context.math.layeredEV;
    const evChips = layered?.exact === true ? layered.value : context.math.callEV;
    const bandChips = uncertaintyBandChips;
    if (evChips === null || legal.callCost <= 0) {
      return Object.freeze({
        kind: null,
        kindZh: '不适用（本节点不是「跟注 vs 弃牌」决策）',
        scope: DecisionMarginScope.NONE,
        evChips,
        bandChips,
        noteZh:
          '本节点没有跟注代价（无人下注 / 已全下），因此「跟注 EV vs 0」这条轴不存在 —— ' +
          '决策边际为 null，而不是 0（不编造）。',
      });
    }
    /*
     * ⚠️ 分类**复用** `evidencePriority.marginOf`（单一实现）：下注分支的动作证据
     * 也用同一把尺子判 CLEAR/MARGINAL，两处各写一份迟早分歧。
     */
    const kind = marginOf(evChips, bandChips)!;
    /*
     * 🔴 **作用域**（§1/§17）：`CLEAR_CALL_OVER_FOLD` 只是「CALL > FOLD」。
     *
     * 只有当**另一个动作自己也带着量化 EV** 参与了同一零点的比较，
     * 这个清晰边际才有资格叫「跨动作」；否则它只对弃牌有效，
     * 界面上必须这么写，决策层也不得拿它拦别的动作。
     */
    const crossActionCount = (evidenceOut.list ?? []).filter(
      (e) => e.action !== 'CALL' && e.action !== 'FOLD' && isQuantifiedEvidence(e.estimateType) && e.ev !== null,
    ).length;
    const scope =
      crossActionCount > 0 ? DecisionMarginScope.CROSS_ACTION : DecisionMarginScope.VS_FOLD_ONLY;
    return Object.freeze({
      kind,
      kindZh: DECISION_MARGIN_ZH[kind],
      scope,
      evChips,
      bandChips,
      noteZh:
        `真实跟注 EV = ${evChips.toFixed(2)} 筹码 vs 工程容差带 ±${bandChips.toFixed(2)} ` +
        `（= ${MODEL_UNCERTAINTY_RATIO} × 可争夺量 ${context.math.winnable.toFixed(2)}）` +
        `⇒ ${kind}。` +
        (scope === DecisionMarginScope.VS_FOLD_ONLY
          ? '⚠️ 作用域 VS_FOLD_ONLY：本次比较**只有跟注 vs 弃牌**，对加注/全下**没有**发言权。'
          : `作用域 CROSS_ACTION：另有 ${crossActionCount} 个动作带着自己的量化 EV 参与了同一零点比较。`) +
        '⚠️ 容差带是**工程容差**，不是统计误差，也不自动翻转动作。',
    });
  })();

  const diagnostics: DecisionDiagnostics = Object.freeze({
    math: context.math,
    legalActions: legal.actions,
    candidates: Object.freeze(candidatesForDecision),
    baseDecision,
    adjustedDecision: baseDecision,
    shadow,
    mathDominance,
    ...(postflopAdvice === null
      ? {}
      : {
          postflop: postflopSnapshotOf(
            postflopAdvice,
            decisionBasis,
            context.postflopFacts?.opponentRangeFacts?.supportSize ?? null,
            {
              callEV: context.math.callEV,
              uncertaintyBandChips,
              allowUncertaintyOverride,
              heroEquityVsArrivalRange: context.math.heroEquity,
              /* 🔴 RIVER BET RANGE V2：到达范围与下注范围构成同源搬运 */
              betRangeArrival: context.postflopFacts?.betRangeArrival ?? null,
              bettingRangeFacts: context.postflopFacts?.bettingRangeFacts ?? null,
              /* 🔴 U1：面对加注的响应与加注 EV（同源搬运） */
              raiseResponse: (context.postflopFacts as unknown as Record<string, any> | undefined)?.['raiseResponse'] ?? null,
            },
            (() => {
              const counts = context.postflopFacts?.opponentRangeFacts?.counts ?? null;
              if (counts === null) return null;
              return Object.freeze({
                reachableRangeCount: counts.reachableRangeCount,
                strongerThanHeroCount: counts.strongerThanHeroCount,
                weakerThanHeroCount: counts.weakerThanHeroCount,
                equalToHeroCount: counts.equalToHeroCount,
                clearValueCount: counts.clearValueCount,
                thinValueCount: counts.thinValueCount,
                showdownCount: counts.showdownCount,
                uncertainCount: counts.uncertainCount,
                valueBetCandidateCount: counts.valueBetCandidateCount,
                bluffCandidateCount: counts.bluffCandidateCount,
                evidenceQuality: counts.evidenceQuality,
              });
            })(),
          ),
        }),
    degradations: Object.freeze(degradations),
    versions: Object.freeze({
      decision: ALPHA_DECISION_MODEL_VERSION,
      /*
       * 🔴 `context` 现在**引用常量**而不是硬编码字符串 —— 此前
       * `ALPHA_CONTEXT_VERSION` 全项目零读者，于是「常量改了但日志不变」。
       */
      context: ALPHA_CONTEXT_VERSION,
      /*
       * 🔴 `math` 升到 `1.0.1`（2026-09 修正轮）：
       * - 新增 `winnable`（跟注后可争夺量）；
       * - 多层局面的 `callEV` 由「决策时刻的错误口径」改为**精确分层 EV**；
       * - 新增 `layeredEV`。
       *
       * ⚠️ 不升的话，JSONL 日志里**同一版本号**会同时对应修复前后的两种
       * 口径 —— 「昨天 CALL 今天 FOLD」就再也追溯不出来了。
       */
      math: '1.0.1',
      // 这些版本随快照一起进日志，是「昨天 CALL 今天 FOLD」的追溯依据
      ...(context.range !== null ? { rangeSource: context.range.sourceKind } : {}),
    }),
    environment: context.environment,
    range: context.range,
    /*
     * 🔴 把**全部已实现对手**的范围带进诊断。
     *
     * `context.range` 只是 `opponentRanges[0]`（首要对手），而权益是按
     * `opponentRanges` **全部**算的。界面回答「这条建议用了什么范围」时
     * 必须读这个字段 —— 否则多人池下会把「按 6 家算的权益」显示成
     * 「只针对某个位置的范围」，那是**把口径说错了**。
     */
    opponentRanges: context.opponentRanges,
    player: context.player,
    dynamic: context.dynamic,
    /*
     * 🔴 一致性守卫的结果进诊断（使用者 §19）：界面据此显示
     * `DECISION_CONSISTENCY_ERROR`，测试据此断言为 0。
     */
    consistency: Object.freeze({
      violations: Object.freeze(consistencyViolations),
      ok: consistencyViolations.length === 0,
    }),
    decisionBasis,
    /* 画像进入范围链路的证据（P0 修复）—— 没有画像时为 null */
    profileRange: context.profileRangeEvidence ?? null,
    decisionMargin,
    /* 下注决策（每尺寸独立）—— 面对下注 / 翻前 / 无范围时为 null */
    betDecision: postflopAdvice?.betDecision ?? null,
    /* 多人 limp 隔离加注事实包 —— 只有「面对跛入且无人加注」的翻前节点才有 */
    preflopIso: context.preflopIso ?? null,
    /* 多人联合响应树（≥2 家；单挑时为 null —— 那时 betEV 是单挑口径） */
    multiwayBetDecision: postflopAdvice?.betDecision?.multiway ?? null,
    /*
     * 🔴 **动作证据与来源**（PREFLOP EVIDENCE PRIORITY FIX）。
     *
     * `decisionSource` 是**动作选择的单一可追踪来源**：
     * 谁有资格覆盖谁、有没有被阻断的覆盖尝试、证据范围是什么。
     */
    decisionSource:
      evidenceDecisionForBasis === null
        ? null
        : Object.freeze({
            kind: evidenceDecisionForBasis.source,
            kindZh: DECISION_SOURCE_ZH[evidenceDecisionForBasis.source],
            priority: evidenceDecisionForBasis.priority,
            estimateType: evidenceDecisionForBasis.estimateType,
            canOverrideEvidence: evidenceDecisionForBasis.canOverrideEvidence,
            evidenceScope: evidenceDecisionForBasis.evidenceScope,
            overrideAttempt: evidenceDecisionForBasis.overrideAttempt,
            overrideBlockedReason: evidenceDecisionForBasis.overrideBlockedReason,
            /*
             * 🔴 **CB-5**：护栏的完整证据（被拦截动作 / 有效备选 / 两条 EV / 差 / 带 / 估计类型）。
             * 只在这里**如实带出**，不参与任何计算 —— 与 `overrideJustification` 同一条纪律。
             */
            ...(evidenceDecisionForBasis.stackCommitmentGuard === undefined
              ? {}
              : { stackCommitmentGuard: evidenceDecisionForBasis.stackCommitmentGuard }),
            noteZh: evidenceDecisionForBasis.reasonZh.join('；'),
          }),
    actionEvidence: Object.freeze(
      evidenceForBasis.map((e) =>
        Object.freeze({
          action: e.action,
          estimateType: e.estimateType,
          ev: e.ev,
          decisionMargin: e.decisionMargin === null ? null : String(e.decisionMargin),
          heuristicScore: e.heuristicScore,
          confidence: e.confidence,
          assumptionsZh: e.assumptionsZh,
          upgradeNoteZh: e.upgradeNoteZh,
          /* 🔴 RIVER RAISE DECISION V2：全下动作没有覆盖清晰 CALL 证据的权限
*/
          ...(e.commitsStack === undefined ? {} : { commitsStack: e.commitsStack }),
        }),
      ),
    ),
    /* 🔴 RIVER RAISE DECISION V2（§三/§四 §六） */
    actionShape,
    allInGuard,
    unevaluatedActions,
    conditionalEquities,
    /** 主推荐动作与备选（备选
*不是**最终动作，仅供混合策略参考） */
    primaryAction: action,
    alternativeActions: Object.freeze(
      evidenceForBasis
        .filter((e) => e.action !== action && (e.ev !== null || e.heuristicScore > 0))
        .map((e) =>
          Object.freeze({
            action: e.action,
            estimateType: e.estimateType,
            ev: e.ev,
            statusZh:
              e.estimateType === 'HEURISTIC' || e.estimateType === 'UNKNOWN'
                ? `STRATEGIC_CANDIDATE（${e.ev === null ? 'EV_NOT_AVAILABLE' : '有 EV'}）`
                : 'SUPPORTED_CANDIDATE',
          }),
        ),
    ),
  });

  return Object.freeze({
    action,
    ...(finalCandidate?.sizeChips !== undefined ? { sizeChips: finalCandidate.sizeChips } : {}),
    ...(finalCandidate?.sizeBB !== undefined ? { sizeBB: finalCandidate.sizeBB } : {}),
    confidence: adjustedConfidence,
    band: confidenceBandOf(adjustedConfidence),
    classification,
    reasons: Object.freeze(reasons.slice(0, 6)),
    diagnostics,
    actionable,
  });
}

/** 当前是否处于「面对下注」的局面（供界面与诊断区分） */
export function isFacingBet(context: DecisionContext): boolean {
  return context.math.callCost > 0;
}

/** 公共牌张数（用于确认街道一致） */
export function boardCountOf(context: DecisionContext): number {
  void allBoardCards;
  return context.board.length;
}

/** 本街（用于诊断显示） */
export function streetOf(context: DecisionContext): Street {
  return context.math.street;
}

