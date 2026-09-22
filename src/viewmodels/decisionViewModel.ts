/**
 * Decision ViewModel —— 界面**唯一**允许消费的结构
 *
 * ## 这个模块在端到端链中解决什么
 *
 * 界面**绝不能**包含策略逻辑（规范第 63 节）：它不许自己判断
 * 「低级别所以弃牌」。所有判断都在引擎里完成，界面只负责显示。
 *
 * 因此本文件把 `AlphaDecision` 翻译成**纯展示**结构：
 * - 全部中文文案**经过 i18n 层**（`t()`），界面里不硬编码策略文案
 * - 数值已格式化（百分比、BB、筹码）
 * - 调试区忠实映射引擎输出，不做二次加工
 *
 * ## ⚠️ 忠实映射（红队重点 10）
 *
 * `ViewModel` 与 `AlphaDecision` 必须一一对应：界面显示的「建议：跟注」
 * 必须真的等于 `decision.action`。测试用属性断言锁定这一点。
 */

import {
  DECISION_ACTION_KEY,
  type AlphaDecision,
  type ConfidenceBand,
  type DecisionAction,
  type DecisionClassification,
} from '../domain/decision/decision.types.ts';
import { t } from '../i18n/index.ts';
import { consistencyErrorZh } from '../domain/decision/decisionConsistency.ts';
import { cardCodeOf } from '../app/manualInput/manualInput.ts';

/* ============================================================
 * i18n 词条键（动态取词的类型安全桥）
 * ============================================================ */

/** 分类 → 词条键 */
const CLASSIFICATION_KEY = {
  CLEAR: 'ALPHA_CLASSIFICATION.CLEAR',
  MARGINAL: 'ALPHA_CLASSIFICATION.MARGINAL',
  INSUFFICIENT_INFORMATION: 'ALPHA_CLASSIFICATION.INSUFFICIENT_INFORMATION',
} as const satisfies Readonly<Record<DecisionClassification, string>>;

/** 置信度档位 → 词条键 */
const BAND_KEY = {
  HIGH: 'CONFIDENCE.HIGH',
  MEDIUM_HIGH: 'CONFIDENCE.MEDIUM_HIGH',
  MEDIUM: 'CONFIDENCE.MEDIUM',
  MEDIUM_LOW: 'CONFIDENCE.MEDIUM_LOW',
  LOW: 'CONFIDENCE.LOW',
} as const satisfies Readonly<Record<ConfidenceBand, string>>;

/** 动作中文（走 i18n，支持未来语言包切换） */
function actionZhOf(action: DecisionAction): string {
  return t(DECISION_ACTION_KEY[action]);
}

/* ============================================================
 * 展示结构
 * ============================================================ */

export type DecisionViewModel = {
  /** 动作中文（例如「建议：跟注」）；不可执行时为提示语 */
  actionZh: string;
  /** 尺寸中文（例如「12.50BB（250 筹码）」）；不适用时 undefined */
  sizeZh?: string;
  /** 置信度档位中文（例如「中高」） */
  confidenceZh: string;
  /** 分类中文（例如「边缘决策」） */
  classificationZh: string;
  /** 核心原因（最多 3 条，首屏显示） */
  reasonsZh: readonly string[];
  /** 全部原因（调试区） */
  allReasonsZh: readonly string[];
  /** 警告（信息不足、口径说明、降级） */
  warningsZh: readonly string[];
  /** 是否有可执行建议 */
  actionable: boolean;
  /** 调试区（可折叠） */
  debug: DecisionDebugViewModel;
};

export type DecisionDebugViewModel = {
  math: readonly { label: string; value: string }[];
  legalActionsZh: readonly string[];
  candidates: readonly { actionZh: string; sizeZh: string; evZh: string; feasibleZh: string }[];
  baseDecisionZh: string;
  adjustedDecisionZh: string;
  /** 本次动作的决策依据（`CHIP_EV` / `PREFERENCE_SCORE` / `INDIFFERENCE_BAND` / `SAFETY_RULE`） */
  decisionBasis: readonly { label: string; value: string }[];
  /** 一致性守卫结果（`DECISION_CONSISTENCY_ERROR` 时逐条列出） */
  consistency: readonly { label: string; value: string }[];
  shadow: readonly { label: string; value: string }[];
  /**
   * 翻后决策链（诊断行）。翻前为 `[{ label: '翻后决策链', value: '—（翻牌前不适用）' }]`。
   *
   * 🔴 类型里**必须有这一项**：它一直存在于实现里，只是类型漏了 ——
   * 于是唯一的读者（P3 契约测试）只能靠 `as` 强转，而强转掩盖了
   * 「类型与实现不一致」这件事本身。
   */
  postflop: readonly { label: string; value: string }[];
  mathDominance: readonly { label: string; value: string }[];
  range: readonly { label: string; value: string }[];
  player: readonly { label: string; value: string }[];
  /**
   * 🔴 **画像 → Range → 权益主链**的证据（P0 架构修复）。
   *
   * 判据是**权益的前后对比**（`equityBefore` / `equityAfter`）：
   * 两者相等即说明画像没有进入主链。没有画像时为一行「—」。
   */
  profileRange: readonly { label: string; value: string }[];
  /** 🔴 决策边际（离翻面多远）—— 与模型置信度**分开**显示的一个量 */
  decisionMargin: readonly { label: string; value: string }[];
  /** 🔴 下注决策（每个尺寸独立的响应概率与 BetEV；证据等级逐项标注） */
  betDecision: readonly { label: string; value: string }[];
  /**
   * 🔴 **多人 limp 隔离加注**事实包（MULTI_LIMP ISOLATION RAISE PHASE 1）。
   *
   * 逐家 limp 的到达宽度 / 响应概率、联合响应、对**跟注条件范围**的权益、
   * 尺寸分解、身后风险、代理 EV —— 每项都标证据等级（代理 EV ≠ Solver EV）。
   */
  preflopIso: readonly { label: string; value: string }[];
  /**
   * 🔴 **翻前加注事实包**（PREFLOP RAISE DECISION 阶段 B）—— 逐尺寸的
   * 响应概率 / 条件权益 / 被再加注分支 / EV。
   *
   * 使用者第十一节要求诊断区显示「各候选动作与尺寸的 EV」「对手弃/跟/再加注概率」
   * 「不同分支的条件权益」「对手再加注后 Hero 评估过哪些应对」——
   * 这四件事都是**逐尺寸**的。
   */
  preflopRaise: readonly { label: string; value: string }[];
  /**
   * 🔴 **多人联合响应树**（MULTIWAY POSTFLOP RESPONSE TREE PHASE 1）。
   *
   * 逐对手响应 → 联合状态 → 条件权益 → 逐分支 EV → 总 EV，
   * 并硬性声明 `primaryOpponentUsedForEV = false`（§13/§23）。
   */
  multiwayBetDecision: readonly { label: string; value: string }[];
  /** 🔴 动作证据与来源（谁选的、凭什么覆盖别人、有没有被阻断的覆盖） */
  decisionSource: readonly { label: string; value: string }[];
  environment: readonly { label: string; value: string }[];
  dynamic: readonly { label: string; value: string }[];
  timing: readonly { label: string; value: string }[];
  degradations: readonly string[];
  versions: readonly { label: string; value: string }[];
};

/* ============================================================
 * 格式化辅助
 * ============================================================ */

function percentZh(ratio: number, digits = 1): string {
  return t('common.percent', { value: (ratio * 100).toFixed(digits) });
}

function chipsZh(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

function bbZh(chips: number, bigBlind: number): string {
  if (!(bigBlind > 0)) return `${chipsZh(chips)} ${t('common.chips')}`;
  const bb = chips / bigBlind;
  return `${bb.toFixed(bb >= 10 ? 1 : 2)}${t('common.bb')}`;
}

function boolZh(value: boolean): string {
  return value ? t('common.yes') : t('common.no');
}

/** 0..1 的比例 → 百分比文案（非有限数显示「—」，不显示 NaN%） */
function pctZh(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : '—';
}

function row(label: string, value: string): { label: string; value: string } {
  return { label, value };
}

/* ============================================================
 * 转换
 * ============================================================ */

/**
 * 把决策翻译成 ViewModel。
 *
 * @param decision 引擎输出
 * @param extraWarnings 管线层面的警告（截断、降级等）
 * @param timings 各阶段耗时（毫秒）
 */
export function toDecisionViewModel(
  decision: AlphaDecision,
  extraWarnings: readonly string[] = [],
  timings: Readonly<Record<string, number>> = {},
): DecisionViewModel {
  const d = decision.diagnostics;
  const math = d.math;
  const bb = math.bigBlind;

  /* ---- 动作与尺寸 ---- */
  //
  // ⚠️ 这里**以 `action` 是否为 `null` 为准**，而不是以 `actionable` 为准。
  //
  // 两者在引擎里当前是等价的（`actionable = insufficientReasons.length === 0`，
  // 且 `baseDecision` 仅在 `actionable` 时为非空），但**类型上不等价**：
  // 只有 `action !== null` 能让 TS 收窄到 `DecisionAction`。
  //
  // 更重要的是语义：真正决定「有没有建议」的是 `action`。
  // 用 `actionable` 分支会让「actionable=true 但 action=null」这种内部不一致
  // 静默走进 `actionZhOf(null)` 并抛异常 —— 现在它至少会被 `finalMathSanityCheck`
  // 先一步拦下并给出明确错误（红队 F-05）。
  /*
   * 🔴 **TEST 18 · 金额口径**：BET / RAISE / ALL_IN 的 `sizeChips` 是**本街累计**
   *（尺寸网格的 `toAmount`；`allInToAmount = 本街已投入 + 剩余筹码`），
   * CALL 的 `sizeChips` 是**本次新增投入**。下面的三行与 `sizeZh` 必须按此分档表达，
   * 否则使用者会把「加注至 186」读成「还要再拿出 186」。
   */
  const actionShapeKind = (d.actionShape?.['kind'] ?? null) as string | null;
  /*
   * 🔴 **RIVER DECISION CONSISTENCY**：下注额等于全部剩余筹码时，这一注**就是全下**。
   *
   * 引擎的 `actionShape.consumesStack` 已经如实判定（判据：`|sizeChips − allInToAmount| < ε`），
   * 但动作类型仍是 `BET`（金额口径不变：BET 的 `sizeChips` 是本街累计）。
   * 界面若只按动作类型写「下注 55BB」，使用者读到的就不是全下 —— 与内部候选表
   * （`ALL_IN` 最高分）看起来自相矛盾。这里按同一个事实补上「全下」语义，
   * **不改金额、不改动作类型、不改任何 EV**。
   */
  const betConsumesStack = decision.action === 'BET' && d.actionShape?.['consumesStack'] === true;
  const isCumulativeAmountAction =
    decision.action === 'BET' || decision.action === 'RAISE' || decision.action === 'ALL_IN';
  const isAllInRaise =
    actionShapeKind === 'RAISE_TO_ALL_IN' || actionShapeKind === 'DIRECT_ALL_IN' || betConsumesStack;
  const streetCommittedChips = math.myCommittedThisStreet;
  const incrementalChips =
    decision.sizeChips === undefined
      ? 0
      : isCumulativeAmountAction
        ? Math.max(0, decision.sizeChips - streetCommittedChips)
        : decision.sizeChips;
  const actionRowLabelZh =
    decision.action === 'BET' ? '本次下注' : decision.action === 'CALL' ? '本次补入' : '本次再投入';
  const totalRowLabelZh =
    decision.action === 'BET'
      ? '下注后的本街总额'
      : decision.action === 'CALL'
        ? '跟注后的本街总额'
        : '加注后的本街总额';

  const actionZh =
    decision.action !== null
      ? `${t('common.suggestion')}${isAllInRaise ? '全下' : actionZhOf(decision.action)}`
      : t('common.analysisBlocked');
  const sizeZh =
    decision.actionable && decision.sizeChips !== undefined
      ? isCumulativeAmountAction
        ? /* 口径标注：**先给筹码数**（与题面/界面的「加注至 186 筹码」一致），再给 BB */
          `${decision.action === 'BET' ? '下注' : '加注至'} ${chipsZh(decision.sizeChips)} ${t('common.chips')}` +
          `（${bbZh(decision.sizeChips, bb)}，本街累计${isAllInRaise ? '；本注即全下' : ''}）` +
          `｜本次再投入 ${chipsZh(incrementalChips)} ${t('common.chips')}（${bbZh(incrementalChips, bb)}）`
        : `${bbZh(decision.sizeChips, bb)}（${chipsZh(decision.sizeChips)} ${t('common.chips')}）`
      : undefined;

  /* ---- 分类与置信度（来自 i18n 词条） ---- */
  const classificationZh = t(CLASSIFICATION_KEY[decision.classification]);
  const confidenceZh = t(BAND_KEY[decision.band]);

  /* ---- 警告 ---- */
  const warnings: string[] = [];
  if (!decision.actionable) {
    warnings.push('当前信息不足，暂不建议强行决策。以下为已知情况与缺失项。');
  }
  if (math.rakeModel === 'NOT_APPLIED') {
    warnings.push('抽水模型：未计入（本项目尚无 Rake Engine，EV 为未计抽水口径）');
  }
  for (const entry of d.degradations) warnings.push(entry.textZh);
  /*
   * 🔴 **一致性违规必须以最高优先级显示**（RIVER CONSISTENCY V2 §19）。
   *
   * 使用者明确要求：不允许静默给一个自相矛盾的答案。这里把
   * `DECISION_CONSISTENCY_ERROR` 放在警告列表**最前面**（unshift），
   * 并附上逐条违规说明 —— 界面读不到「这次输出不可信」就等于静默。
   */
  if (d.consistency !== undefined && !d.consistency.ok) {
    warnings.unshift(
      'DECISION_CONSISTENCY_ERROR：本次输出内部不一致，**不要据此行动**，请把这条反馈给开发者 —— ' +
        d.consistency.violations.map((v) => `[${v.code}] ${v.textZh}`).join('；'),
    );
  }
  warnings.push(...extraWarnings);
  if (d.environment.anyMagnitudePresent) {
    warnings.push('⚠️ 知识层出现了带幅度的环境规则 —— 环境接入层不会使用它（违反 Phase 4.5 纪律）');
  }

  const debug: DecisionDebugViewModel = Object.freeze({
    math: Object.freeze([
      row('底池', `${chipsZh(math.pot)} ${t('common.chips')}（${bbZh(math.pot, bb)}）`),
      /*
       * 🔴 **可争夺量必须单独露出来**（2026-09 修正轮）。
       *
       * `底池` 是**台面上所有投入**，含「对手跟不起、永远不会被争夺」的超额下注；
       * 门槛与 EV 用的却是**跟注之后我能争夺到的量**（`winnable`）。
       * 两个数不等时（`POT-14` 形态：底池 4150 / 可争夺 7050），
       * 只显示前者会让使用者拿一个与 EV 无关的数去心算赔率。
       *
       * ⚠️ 只在两者确实不同时才加这一行 —— 相等时多一行只是噪音。
       */
      ...(math.winnable !== math.pot
        ? [
            row(
              '可争夺量（跟注后）',
              `${chipsZh(math.winnable)} ${t('common.chips')}（${bbZh(math.winnable, bb)}）` +
                '　← 门槛与 EV 用的是这个数',
            ),
          ]
        : []),
      row('跟注需要', `${chipsZh(math.callCost)} ${t('common.chips')}（${bbZh(math.callCost, bb)}）`),
      /*
       * 🔴 **TEST 18 · RAISE-TO AMOUNT CONSISTENCY**：金额口径三行。
       *
       * 引擎的 `sizeChips` 对 BET / RAISE / ALL_IN 是**本街累计（raise-to）**口径，
       * 而「我的剩余筹码」是**增量**口径 —— 两者在「我本街已投入 + 加注」的节点
       * 必然不同（TEST 18：已投入 20、加注至 186、剩余 166）。
       *
       * 修复前界面只显示「93.0BB（186 筹码）」紧挨「我的剩余筹码 166」，
       * 使用者会把 186 读成「还要再拿出 186」——而实际再投入只有 166。
       */
      row(
        '本街已投入',
        `${chipsZh(math.myCommittedThisStreet)} ${t('common.chips')}（${bbZh(math.myCommittedThisStreet, bb)}）`,
      ),
      ...(decision.sizeChips === undefined
        ? []
        : [
            row(
              actionRowLabelZh,
              `${chipsZh(incrementalChips)} ${t('common.chips')}（${bbZh(incrementalChips, bb)}）` +
                (isCumulativeAmountAction ? '　← 真正要从筹码里再拿出的部分' : ''),
            ),
            row(
              totalRowLabelZh,
              `${chipsZh(decision.sizeChips)} ${t('common.chips')}（${bbZh(decision.sizeChips, bb)}）` +
                (isCumulativeAmountAction ? '　← 含本街已投入' : '') +
                (isAllInRaise ? '；**本注即全下**' : ''),
            ),
          ]),
      row(
        '我的剩余筹码',
        `${chipsZh(math.myRemainingStack)} ${t('common.chips')}（${bbZh(math.myRemainingStack, bb)}）`,
      ),
      row('有效筹码', `${chipsZh(math.effectiveStack)} ${t('common.chips')}（${bbZh(math.effectiveStack, bb)}）`),
      row('SPR', math.spr === null ? '—（底池为 0）' : math.spr.toFixed(2)),
      row('底池赔率', percentZh(math.potOdds, 1)),
      row('所需权益', percentZh(math.requiredEquity, 1)),
      /*
       * 🔴 口径必须露出来（2026-09 多人边池修复）。
       * 多人边池时「所需权益」这个数**判不了跟注方向**（主池与边池的胜负条件
       * 不同，单一门槛算出的 EV 只是下界）。不写清楚，使用者会拿它当门槛用。
       */
      row(
        '所需权益口径',
        math.requiredEquityApplies === false
          ? '⚠️ 不适用：我既争主池又争边池（需按层分别算胜负条件）'
          : '单层门槛（权益 ≥ 所需权益 ⇔ 跟注不亏）',
      ),
      /*
       * 🔴 **TEST 17 · 两份条件权益必须分开展示，并各自写明用途**。
       *
       * - `math.heroEquityVsBetRange` = **对手下注范围**权益 ⇒ 面对下注时
       *   **跟注 EV 与加注门槛**用的就是它（测试节点的实测值 **73.51%**）；
       * - `math.heroEquity` = **整体（到达）范围**权益 ⇒ 只回答「我领先他的整体范围吗」
       *   （同节点实测 **68.22%**）。
       *
       * 两者在同一节点可差 5 个百分点以上；用整体范围权益去复算跟注 EV 会得到
       * 27.07 而不是 30.72 —— 修复前界面只显示「估计权益 68.2%」紧挨「跟注 EV 30.72」，
       * 使用者无法复算、也无法判断哪一份才是 EV 的输入。
       */
      row(
        '对手下注范围权益',
        math.heroEquityVsBetRange === null
          ? '—（本节点没有可用的下注范围 ⇒ 跟注 EV 与加注门槛回落用整体范围权益）'
          : `${percentZh(math.heroEquityVsBetRange, 2)}｜**本次跟注 EV（与加注门槛）的权益输入**`,
      ),
      row(
        '整体范围权益（仅参考）',
        math.heroEquity === null
          ? '—（无法计算）'
          : `${percentZh(math.heroEquity, 2)}｜` +
            (math.heroEquityVsBetRange === null
              ? '本次跟注 EV 的**回落**输入（本节点没有下注范围）'
              : '**不是**本次跟注 EV 的输入（那是「对手下注范围权益」）'),
      ),
      row(
        '权益来源',
        math.equitySource === null
          ? '—'
          : math.equitySource.method === 'EXACT'
            ? `精确枚举（${math.equitySource.iterations.toLocaleString('en-US')} 局）`
            : `蒙特卡洛（${math.equitySource.iterations.toLocaleString('en-US')} 次，±${(
                math.equitySource.confidenceHalfWidth * 100
              ).toFixed(1)}%）${math.equitySource.downgradedFromExact ? '【因时间预算从精确枚举降级】' : ''}`,
      ),
      /*
       * ⚠️ 精确分层算出来时，这个数**就是**分层 EV（两处口径已统一）——
       * 必须标出来，否则使用者会以为它是「单一门槛下界」，并拿它去对
       * 上面那行「所需权益口径：不适用」做心算（两者本来不该比）。
       *
       * 🔴 **RIVER CONSISTENCY V2：参考点必须写出来**（使用者 §5）。
       *
       * 「跟注 EV」只有在知道「EV 从哪里算起」时才有意义。本项目统一用
       * **节点增量口径**：从当前决策点往后算，已经投进底池的钱是沉没成本，
       * 因此**弃牌 EV ≡ 0**、跟注 EV = `权益 × 可争夺量 − 跟注额`。
       * 不写这一句，使用者会把它理解成「整手牌的累计收益」，从而把
       * 「−317 筹码」读成「这手牌亏了 317」。
       */
      row(
        '跟注 EV（节点增量口径）',
        math.callEV === null
          ? '—（无法计算）'
          : `${math.callEV.toFixed(2)} ${t('common.chips')}` +
            '｜参考点：从当前决策点往后算，**弃牌 EV ≡ 0**（已投入的筹码是沉没成本）' +
            /*
             * 🔴 **TEST 17**：EV 的权益输入必须写在行内，否则使用者会拿上面那行
             * 「整体范围权益」去复算（实测 68.22% ⇒ 27.07 ≠ 30.72）。
             */
            (math.heroEquityVsBetRange === null
              ? '｜权益输入：**整体范围权益**（回落口径，本节点没有下注范围）'
              : `｜权益输入：**对手下注范围权益 ${percentZh(math.heroEquityVsBetRange, 2)}**`) +
            (math.layeredEV?.exact === true
              ? `｜按**逐层**胜率算（${math.layeredEV.layerCount} 层分别计算）`
              : '｜按单一门槛口径算'),
      ),
      row('当前牌力', math.handRankZh),
      row('抽水模型', math.rakeModel === 'NOT_APPLIED' ? '未计入' : String(math.rakeModel)),
    ]),

    legalActionsZh: Object.freeze(d.legalActions.map((a) => actionZhOf(a))),

    candidates: Object.freeze(
      d.candidates.map((c) => ({
        actionZh: actionZhOf(c.action),
        sizeZh: c.sizeChips === undefined ? '—' : bbZh(c.sizeChips, bb),
        evZh: c.ev === null ? '—（依赖弃牌率，本项目无可信估计）' : `${c.ev.toFixed(2)} ${t('common.chips')}`,
        feasibleZh: c.feasibleNoteZh ?? (c.mathFeasible ? '数学可行' : '数学不成立'),
      })),
    ),

    baseDecisionZh: d.baseDecision === null ? '（信息不足，未给出）' : actionZhOf(d.baseDecision.action),
    adjustedDecisionZh:
      d.adjustedDecision === null ? '（信息不足，未给出）' : actionZhOf(d.adjustedDecision.action),

    /*
     * 🔴 **本次动作的决策依据**（使用者 §8：UI 解释与生产动作必须同一口径）。
     *
     * 它回答的是「这个动作到底是谁选的」：
     * `CHIP_EV`（真 chip EV）/ `PREFERENCE_SCORE`（启发式偏好分）/
     * `INDIFFERENCE_BAND`（EV 无差别带内取代价最小方向）/ `SAFETY_RULE`。
     * 没有这一行，使用者看到「偏好顺序 FOLD > CALL」配「建议：跟注」时
     * 无法判断系统是不是自相矛盾 —— 而修复前它**确实**是。
     */
    decisionBasis: Object.freeze([
      row('决策依据', d.decisionBasis === undefined ? '—' : d.decisionBasis.kind),
      row('依据说明', d.decisionBasis === undefined ? '—' : d.decisionBasis.noteZh),
    ]),

    consistency: Object.freeze([
      row(
        '一致性检查',
        d.consistency === undefined
          ? '—（本局面未运行守卫）'
          : d.consistency.ok
            ? '通过（动作 / 指标 / 解释属于同一体系）'
            : '**DECISION_CONSISTENCY_ERROR**',
      ),
      ...(d.consistency === undefined || d.consistency.ok
        ? []
        : d.consistency.violations.map((v) => row(v.code, v.textZh))),
    ]),

    shadow: Object.freeze([
      row('动作发生变化', boolZh(d.shadow.actionChanged)),
      row('尺寸发生变化', boolZh(d.shadow.sizeChanged)),
      row('置信度发生变化', boolZh(d.shadow.confidenceChanged)),
      row('动态层置信度', d.shadow.dynamicConfidence.toFixed(2)),
      row('幅度来源', d.shadow.magnitudeProvenance),
      row('动态是否被允许翻转动作', boolZh(d.shadow.dynamicAllowedToFlip)),
      row('说明', d.shadow.noteZh),
    ]),

    /*
     * 🔴 **翻后决策链**（2026-09 翻后升级 · P3）。
     *
     * 使用者第二十三节：界面**只显示五项** ——
     * 推荐动作 / 推荐尺度 / 主要原因 / 风险 / 置信度；
     * 其余细节放在这里供按需展开。翻前 `d.postflop === undefined` ⇒ 显示「—」。
     */
    postflop:
      d.postflop === undefined
        ? Object.freeze([row('翻后决策链', '—（翻牌前不适用）')])
        : Object.freeze([
            /*
             * 🔴 **成交牌型与相对角色必须分两行**（V2.1 · P0-1）：
             * 修复前只有一行角色，于是一手**中对**被显示成「空气」——
             * 使用者看到的是「我拿中对」配「我是空气」这种自相矛盾。
             */
            row('成交牌型（我是什么牌）', `${d.postflop.madeHandZh}（${d.postflop.madeHand}）`),
            row('相对牌力角色', `${d.postflop.handRoleZh}（${d.postflop.handRole}，强度 ${d.postflop.roleStrength.toFixed(2)}）`),
            /*
             * 🔴 **上一街角色必须单独一行**（RIVER CONSISTENCY V2 §3）。
             *
             * 「转牌是听牌」与「河牌是什么」是两个不同的问题。修复前只有一个
             * 角色字段，于是河牌把上一街的「听牌」当成了当前身份。
             */
            ...(d.postflop.previousHandRoleZh === null
              ? []
              : [
                  row(
                    '上一街角色（历史参考）',
                    `${d.postflop.previousHandRoleZh}（${String(d.postflop.previousHandRole)}）—— 历史身份，**不是**当前牌力`,
                  ),
                ]),
            ...(d.postflop.roleChangeReasonZh === null
              ? []
              : [row('角色迁移原因', d.postflop.roleChangeReasonZh)]),
            row(
              '牌面变化',
              d.postflop.boardDelta === null
                ? '—（无跨街比较）'
                : [
                    d.postflop.boardDelta.flushCompleted ? '同花成为可能' : null,
                    d.postflop.boardDelta.straightCompleted ? '顺子成为可能' : null,
                    d.postflop.boardDelta.fourToFlush ? '四张同花' : null,
                    d.postflop.boardDelta.pairedBoard ? '牌面成对' : null,
                    `白板度 ${Number(d.postflop.boardDelta.blankScore).toFixed(2)}`,
                  ]
                    .filter((x): x is string => x !== null)
                    .join('、'),
            ),
            /*
             * 🔴 **评分必须标成评分**（使用者 §14）。
             *
             * 「坚果密度 0.76」是 0..1 的**内部归一化评分**，不是「他有 76% 的
             * 概率是坚果」。修复前这一行只写「坚果密度 0.76」，任何人都会读成概率。
             */
            row(
              '对手范围压缩（内部评分，非概率）',
              `强度下限评分 ${d.postflop.rangeCompression['strengthFloor']!.toFixed(2)}、` +
                `坚果密度评分 ${d.postflop.rangeCompression['nutDensity']!.toFixed(2)}、` +
                `空气密度评分 ${d.postflop.rangeCompression['airDensity']!.toFixed(2)}`,
            ),
            /*
             * 🔴 真实 EV 排名（P0-2）：**谁更高是确定的**。
             * 修复前界面用「数学上没有明显优劣」把「0 > −317.61」说成无差异。
             */
            row(
              '真实 EV 排名（节点增量口径）',
              d.postflop.trueEvRanking
                .map(
                  (x) =>
                    `${x.action} ${x.evChips === null ? '—' : x.evChips.toFixed(2)}`,
                )
                .join('　vs　') +
                '　⇒　' +
                (() => {
                  const fold = d.postflop.trueEvRanking.find((x) => x.action === 'FOLD')?.evChips ?? 0;
                  const call = d.postflop.trueEvRanking.find((x) => x.action === 'CALL')?.evChips ?? null;
                  if (call === null) return '跟注 EV 不可算 ⇒ 无法排名';
                  if (Math.abs(call - fold) <= 1e-6) return '**数学上确实相等**（|ΔEV| ≤ 1e-6 筹码）';
                  return call > fold ? 'CALL 更高' : '**FOLD 更高**';
                })(),
            ),
            row(
              '模型容差带（工程容差，非数学无差异）',
              `±${d.postflop.uncertaintyBandChips.toFixed(2)} 筹码｜来源：${d.postflop.uncertaintyBandFormulaZh}` +
                `｜不确定性覆盖：${d.postflop.allowUncertaintyOverride ? '**已开启**' : '未开启（动作严格跟随 EV 排名）'}`,
            ),
            row(
              '价值判断',
              `${String(d.postflop.valueAssessment['verdict'])}` +
                `（下注偏好分 ${Number(d.postflop.valueAssessment['estimatedBetEVScore']).toFixed(2)} vs ` +
                `过牌偏好分 ${Number(d.postflop.valueAssessment['estimatedCheckEVScore']).toFixed(2)}，内部评分）`,
            ),
            /*
             * 🔴 把「更差 / 更好」这两个占比**显式显示**：它们是相对于**我这手牌**
             * 的精确比较结果，也是价值守门器第一、二问的唯一口径。
             * 修复前这两问由「他的范围整体多强」冒充，在没有这行显示的年代，
             * 使用者看到的是「权益 94.7%」+「没有任何更差的牌能跟」这样自相矛盾的输出。
             *
             * ⚠️ 这是**占比**（有分母），因此必须给出分母 —— 使用者 §14。
             */
            /*
             * 🔴 **组合数（未加权）与概率质量占比必须分列**（V2.1 · P1-1）：
             * 两者回答不同的问题 —— 「有多少手牌比我好」vs「他实际有多大概率比我好」，
             * 在真实后验下可以差很多（实测本节点：组合数 27% 更强，而概率质量 74% 更强）。
             */
            ...(d.postflop.rangeCounts === null
              ? []
              : [
                  row(
                    '可达范围（组合数，未加权）',
                    `共 ${String(d.postflop.rangeCounts['reachableRangeCount'])} 个组合：` +
                      `更强 ${String(d.postflop.rangeCounts['strongerThanHeroCount'])}、` +
                      `更弱 ${String(d.postflop.rangeCounts['weakerThanHeroCount'])}、` +
                      `打平 ${String(d.postflop.rangeCounts['equalToHeroCount'])}`,
                  ),
                  row(
                    '河牌动作分类（组合数）',
                    `价值下注候选 ${String(d.postflop.rangeCounts['valueBetCandidateCount'])}` +
                      `（明确取值 ${String(d.postflop.rangeCounts['clearValueCount'])} + 薄价值 ${String(d.postflop.rangeCounts['thinValueCount'])}）、` +
                      `诈唬候选 ${String(d.postflop.rangeCounts['bluffCandidateCount'])}、` +
                      `摊牌牌 ${String(d.postflop.rangeCounts['showdownCount'])}、` +
                      `证据不足 ${String(d.postflop.rangeCounts['uncertainCount'])}` +
                      `（证据质量 ${String(d.postflop.rangeCounts['evidenceQuality'])}）` +
                      '　⚠️「更弱」≠「会诈唬」，只有分类后的诈唬候选才计入',
                  ),
                ]),
            row(
              '对手范围 vs 我的牌（概率质量占比，有分母）',
              `更差 ${pctZh(d.postflop.valueAssessment['weakerShare'])}、` +
                `更好 ${pctZh(d.postflop.valueAssessment['strongerShare'])}` +
                `，分母 = 可达 ${String(d.postflop.reachableComboCount ?? '—')} 个组合` +
                `（更差的牌能跟注：${boolZh(d.postflop.valueAssessment['worseHandsCanCall'] === true)}）`,
            ),
            row(
              '摊牌 / 保护 / 诈唬潜力',
              `${d.postflop.showdownValue.toFixed(2)} / ${d.postflop.protectionValue.toFixed(2)} / ${d.postflop.bluffPotential.toFixed(2)}`,
            ),
            row(
              'SPR 承诺',
              `${String(d.postflop.commitment['bandZh'])}；可否承诺 ${boolZh(d.postflop.commitment['stackOffAllowed'] === true)}`,
            ),
            row(
              '阻断牌（可达范围逐组合）',
              `挡掉更强的组合 ${String(d.postflop.blockers['blockedStrongerCombos'] ?? '—')} 个、` +
                `更弱的组合 ${String(d.postflop.blockers['blockedWeakerCombos'] ?? '—')} 个；` +
                `其中经河牌动作分类：价值下注候选 ${Number(d.postflop.blockers['blockedValueBetCandidateCount'] ?? -1) < 0 ? '—' : String(d.postflop.blockers['blockedValueBetCandidateCount'])} 个、` +
                `诈唬候选 ${Number(d.postflop.blockers['blockedBluffCandidateCount'] ?? -1) < 0 ? '—' : String(d.postflop.blockers['blockedBluffCandidateCount'])} 个；` +
                `净偏好 ${Number(d.postflop.blockers['netBlockerPreference'] ?? 0).toFixed(2)}` +
                `（证据质量 ${String(d.postflop.blockers['evidenceQuality'] ?? '—')}，内部评分）` +
                '　⚠️「更强/更弱」是强弱比较，不等于价值/诈唬',
            ),
            row('画像偏移', d.postflop.exploitAdjustmentZh ?? '—（无画像或未触发偏移）'),
            /*
             * 🔴 「偏好顺序」必须**真的按分数降序**。
             *
             * 快照里的顺序是「候选动作的构造顺序」（CHECK / BET_SMALL / BET_MEDIUM /
             * BET_LARGE），直接拼出来会显示成 `CHECK 0.25 > BET_SMALL 0.69`——
             * 读起来像「首选过牌」，与同一行下方的分数自相矛盾。
             * 这里只做**显示排序**，不改任何分数、不改任何判据。
             *
             * ⚠️ 并且必须标明**它是不是本次决策依据**（使用者 §8/§15）：
             * 当动作由 chip EV 或「无差别带规则」选出时，偏好顺序只是参考，
             * 把它显示成「首选」会让使用者以为动作与它矛盾。
             */
            /*
             * 🔴 **语义分离**（TEST HAND MULTIWAY TURN FIX · 问题 4）：
             * 「有 EV 的动作」与「只有启发式偏好分的战略候选」**不能**混在一个排序里 ——
             * 修复前显示 `CALL 0.62 > FOLD 0.38 > RAISE 0.37`，而 RAISE 的 EV 是
             * NOT_AVAILABLE，读者会自然把三个数当成同一把尺子。
             */
            row(
              'EV 支持的动作（可互相比较）',
              [...d.postflop.evRanking]
                .filter((x) => x.kind === 'EV_SUPPORTED')
                .sort((a, b) => b.score - a.score)
                .map((x) => `${x.action} ${x.score.toFixed(2)}`)
                .join(' > ') +
                (String(d.postflop.decisionBasisKind ?? '') === 'PREFERENCE_SCORE'
                  ? '　← 本次动作即由它选出'
                  : `　← **本次动作不是由它选出的**（依据：${String(d.postflop.decisionBasisKind ?? '—')}），仅作参考`),
            ),
            row(
              '战略候选（**无 EV**，上面的分数不可比）',
              [...d.postflop.evRanking]
                .filter((x) => x.kind !== 'EV_SUPPORTED')
                .map((x) => `${x.action} heuristicScore ${x.score.toFixed(2)}（EV: NOT_AVAILABLE）`)
                .join('｜') || '—（本次没有无 EV 的候选）',
            ),
            row('排序语义说明', [...d.postflop.evRanking].map((x) => `${x.action} ${x.kind}`).join('｜')),
            row('置信度（首选比次选好多少）', `${d.postflop.confidence}（差 ${d.postflop.confidenceGap.toFixed(3)}）`),
            row('⚠️ EV 口径', d.postflop.evScoreDisclaimerZh),
          ]),

    mathDominance: Object.freeze([      row('是否存在数学明显占优动作', boolZh(d.mathDominance.dominant)),
      row(
        'EV 差',
        d.mathDominance.evGap === null ? '—' : `${d.mathDominance.evGap.toFixed(3)} ${t('common.chips')}`,
      ),
      row(
        'EV 差占底池',
        d.mathDominance.evGapToPotRatio === null ? '—' : percentZh(d.mathDominance.evGapToPotRatio, 2),
      ),
      row('阈值来源', d.mathDominance.thresholdProvenance),
      row('阈值', percentZh(d.mathDominance.thresholdRatio, 1)),
      row('说明', d.mathDominance.noteZh),
    ]),

    range:
      d.range === null
        ? Object.freeze([row('对手范围', '—（不可用）')])
        : Object.freeze([
            row('针对对手', d.range.opponentPositionZh),
            row('来源类型', d.range.sourceKind),
            row('来源可信度', d.range.confidence.toFixed(2)),
            /*
             * 🔴 **两个「组合数」必须分清**（2026-09-22 修复）。
             *
             * 修复前这一行写的是「有效组合数」，而 `range.types.ts` 里
             * **两个字段的注释都叫「有效组合数」**：
             *
             * | 字段 | 真实含义 | 9MAX 实测 |
             * |---|---|---|
             * | `supportSize` | `rawWeight > 0` 的组合数 | **1225**（= C(50,2)，即**全部**） |
             * | `effectiveComboCount` | `1 / Σ(p²)`，分布集中度 | **134.5** |
             *
             * 于是界面上会出现「有效组合数 1225 / 1326（92.4%）」——
             * 使用者会读成「他的范围有 1225 个组合那么宽」，
             * 而真实等效宽度只有 **134.5**（约 11%）。
             * 求解器在每类上都留了一点频率，所以正权重数必然等于全部组合，
             * 这个数字**不携带任何范围信息**。
             */
            row(
              '正权重组合数',
              `${d.range.supportSize} / 1326（${percentZh(d.range.supportShare, 1)}）` +
                '——**仅表示非零**；求解器范围通常覆盖全部组合，此数不反映范围宽窄',
            ),
            row(
              '有效组合数 1/Σp²',
              `${d.range.metrics.effectiveComboCount.toFixed(1)}` +
                `（等效宽度；占正权重组合的 ${percentZh(
                  d.range.supportSize > 0 ? d.range.metrics.effectiveComboCount / d.range.supportSize : 0,
                  1,
                )}）`,
            ),
            row('熵', `${d.range.metrics.entropyBits.toFixed(2)} bit`),
            row('是否塌缩', boolZh(d.range.collapsed)),
            row('来源说明', d.range.sourceDescription),
            row(
              '更新轨迹',
              d.range.updateTrace.length === 0
                ? '（无更新，直接使用先验）'
                : d.range.updateTrace
                    .map((u) => `${u.street} ${u.actorPositionZh} ${u.action}：${u.supportBefore}→${u.supportAfter}`)
                    .join('；'),
            ),
          ]),

    player:
      d.player === null
        ? Object.freeze([row('对手画像', '—')])
        : Object.freeze([
            row('标签', d.player.labelZh),
            /*
             * 🔴 **PLAYER PROFILE EXPLOIT V1 · 披露修复**。
             *
             * 修复前这一行只读 `d.player.handsObserved`（来自手日志 `PlayerProfile`），
             * 而真实历史走的是 `observedStats` 通道 ⇒ 模型**用了**实测证据，
             * 界面却显示「实测手数 0」。现在优先显示实测披露里的真实手数，
             * 并逐项说明**哪几项统计真的进入了本次决策**、哪些没有通道。
             */
            row(
              '实测手数',
              d.player.measuredStats === undefined
                ? String(d.player.handsObserved)
                : String(d.player.measuredStats.handsObserved),
            ),
            ...(d.player.measuredStats === undefined
              ? []
              : [
                  row('实测统计来源', d.player.measuredStats.noteZh),
                  row(
                    '本次进入模型',
                    d.player.measuredStats.usedStatKeys.length === 0
                      ? '无（该玩家尚无模型支持的统计项）'
                      : d.player.measuredStats.usedStatKeys.join('、'),
                  ),
                ]),
            row('可信度', d.player.confidence.toFixed(2)),
            row('是否中性化（样本不足）', boolZh(d.player.neutralized)),
            row('说明', d.player.note),
          ]),

    /*
     * 🔴 **画像 → Range → 权益主链**（P0 架构修复 · 使用者 §7 调试证据）。
     *
     * 这一组回答使用者点名的问题：「画像到底有没有进入范围」。
     * 判据是**权益的前后对比**，不是文案 —— 两者相等就说明没进主链。
     */
    profileRange:
      d.profileRange === undefined || d.profileRange === null
        ? Object.freeze([row('画像 → 范围', '—（本局没有画像 / 近期倾向）')])
        : Object.freeze([
            row('是否真的改变范围', boolZh(d.profileRange.provider.applied)),
            row('维度来源', `${d.profileRange.dimensionTierZh}（${d.profileRange.dimensionTier}）`),
            row('维度说明', d.profileRange.dimensionNoteZh),
            row(
              '权益（调整前 → 后）',
              d.profileRange.equityBefore === null || d.profileRange.equityAfter === null
                ? '—（拿不到权益，不编造）'
                : `${percentZh(d.profileRange.equityBefore, 2)} → ${percentZh(d.profileRange.equityAfter, 2)}` +
                  (d.profileRange.equityDeltaPct === null
                    ? ''
                    : `（${d.profileRange.equityDeltaPct >= 0 ? '+' : ''}${d.profileRange.equityDeltaPct.toFixed(3)} 个百分点）`),
            ),
            row(
              '可达组合数（前 → 后）',
              `${d.profileRange.combosBefore} → ${d.profileRange.combosAfter}` +
                (d.profileRange.combosBefore === d.profileRange.combosAfter
                  ? '（只改概率，不增删组合）'
                  : ' ⚠️ 组合数发生变化 —— 违反「只改概率」约束'),
            ),
            row(
              'PROFILE_MULTIPLIER',
              `${d.profileRange.provider.profileMultiplier.min.toFixed(3)}–${d.profileRange.provider.profileMultiplier.max.toFixed(3)}` +
                `（均值 ${d.profileRange.provider.profileMultiplier.mean.toFixed(3)}，生效 ${d.profileRange.provider.profileMultiplier.effective}/${d.profileRange.provider.profileMultiplier.calls}）`,
            ),
            row(
              'OBSERVATION_MULTIPLIER',
              d.profileRange.provider.observationMultiplier.calls === 0
                ? '—（没有近期倾向，或本次没有进攻动作）'
                : `${d.profileRange.provider.observationMultiplier.min.toFixed(3)}–${d.profileRange.provider.observationMultiplier.max.toFixed(3)}` +
                  `（生效 ${d.profileRange.provider.observationMultiplier.effective}/${d.profileRange.provider.observationMultiplier.calls}）`,
            ),
            row(
              'FINAL_MULTIPLIER',
              `${d.profileRange.provider.finalMultiplier.min.toFixed(3)}–${d.profileRange.provider.finalMultiplier.max.toFixed(3)}` +
                `（生效 ${d.profileRange.provider.finalMultiplier.effective}/${d.profileRange.provider.finalMultiplier.calls}）`,
            ),
            row(
              'CLAMP_APPLIED',
              d.profileRange.provider.clampApplied
                ? `是（${d.profileRange.provider.clampCount} 次被工程护栏截断）`
                : '否（未被护栏截断）',
            ),
            row('参与调整的动作', d.profileRange.provider.actions.join(' / ') || '—'),
            ...d.profileRange.provider.noteZh.map((t) => row('画像链路说明', t)),
          ]),

    /*
     * 🔴 **决策边际 vs 模型置信度**（必须分开显示）。
     *
     * 「数学上差得很远」与「模型自己不确定」是两件事：
     * 修复前只有后者，于是「跟注 EV = −317 筹码」被配上「置信度低」，
     * 使用者无法区分。现在两行并列。
     */
    decisionMargin:
      d.decisionMargin === undefined
        ? Object.freeze([row('决策边际', '—（旧快照，无此字段）')])
        : Object.freeze([
            row('决策边际', d.decisionMargin.kindZh),
            /*
             * 🔴 **作用域**（MULTI_LIMP §1/§17）：没有作用域的「明显」是越权结论。
             * `VS_FOLD_ONLY` = 这个边际只证明了「跟注 > 弃牌」，对加注**没有**发言权。
             */
            row(
              '边际作用域',
              d.decisionMargin.scope === 'VS_FOLD_ONLY'
                ? 'VS_FOLD_ONLY（只比较过「跟注 vs 弃牌」—— 不能推出「跟注优于加注」）'
                : d.decisionMargin.scope === 'CROSS_ACTION'
                  ? 'CROSS_ACTION（已有其他动作带着自己的量化 EV 参与同一零点比较）'
                  : 'NONE（本节点不是「跟注 vs 弃牌」决策）',
            ),
            row(
              '边际判据',
              d.decisionMargin.evChips === null
                ? '—（本节点不是「跟注 vs 弃牌」决策）'
                : `真实跟注 EV ${d.decisionMargin.evChips.toFixed(2)} ${t('common.chips')} vs 工程容差带 ±${d.decisionMargin.bandChips.toFixed(2)}`,
            ),
            row(
              '模型置信度（另一个量）',
              d.postflop === undefined
                ? '—（翻前不适用）'
                : `${d.postflop.confidence}（偏好分差 ${d.postflop.confidenceGap.toFixed(3)}）—— 回答「首选比次选好多少」，与上面的边际**不是**同一件事`,
            ),
            row('边际说明', d.decisionMargin.noteZh),
          ]),

    /*
     * 🔴 **下注决策（每个尺寸独立）**（BET DECISION ENGINE PHASE 1 · 使用者 §15）。
     *
     * 这一组回答「这个下注建议是怎么算出来的」：每个尺寸的
     * P(弃)/P(跟)/P(加)、对**条件范围**的权益、三分支 EV、BetEV、
     * Hero 听牌、权益实现因子，以及**证据等级**（EXACT / HEURISTIC / NOT_IMPLEMENTED）。
     */
    betDecision: (() => {
      const bd = d.betDecision ?? null;
      if (bd === null) {
        return Object.freeze([row('下注决策模型', '—（面对下注 / 翻前 / 拿不到对手范围）')]);
      }
      const sizes = (bd['sizes'] ?? []) as readonly Readonly<Record<string, unknown>>[];
      const num = (v: unknown, digits = 3): string =>
        typeof v === 'number' ? v.toFixed(digits) : '—';
      const pct = (v: unknown, digits = 1): string =>
        typeof v === 'number' ? `${(v * 100).toFixed(digits)}%` : '—';
      const draw = (bd['draw'] ?? {}) as Readonly<Record<string, unknown>>;
      const realization = (bd['realization'] ?? {}) as Readonly<Record<string, unknown>>;
      const profile = (bd['profileEvidence'] ?? {}) as Readonly<Record<string, unknown>>;
      const evidence = (bd['evidence'] ?? {}) as Readonly<Record<string, unknown>>;
      return Object.freeze([
        row(
          '下注决策模型',
          /*
           * 🔴 `checkScore` / `bestScore` 是**启发式偏好分（0–1）**，不是筹码 EV。
           * 修复前这里显示成「CHECK EV 0.4」，会让使用者以为过牌「赢 0.4 筹码」。
           * 两者语义完全不同：偏好分只回答「模型更偏好哪个动作」。
           * ⚠️ 与之相对，下方「CHECK 树」里的 `checkEV`（`checkTree.checkEV`）
           * 由 `composeCheckTreeEV` 按概率加权算出，**是真正的筹码 EV**，
           * 那里的「EV」标签是正确的，不要一起改。
           */
          `底池 ${num(bd['pot'], 1)}｜CHECK 策略评分 ${num(bd['checkScore'], 2)}（0–1 启发式偏好分，非筹码 EV）` +
            `｜最佳尺寸 ${String(bd['bestSize'] ?? '—')}` +
            `（策略评分 ${num(bd['bestScore'], 2)}）⇒ ${String(bd['preferredAction'] ?? '—')}`,
        ),
        row(
          '证据等级',
          `概率 ${String(evidence['probabilities'] ?? '—')}｜条件范围权益 ${String(evidence['equityVsConditionalRanges'] ?? '—')}｜` +
            `权益实现 ${String(evidence['realization'] ?? '—')}｜被加注分支 ${String(evidence['raiseBranch'] ?? '—')}｜` +
            `阻断牌 ${String(evidence['blockerAdjustment'] ?? '—')}`,
        ),
        row('Hero 听牌（不进权益）', String(draw['noteZh'] ?? '—')),
        /*
         * 🔴 **河牌 CHECK 树**（§5/§6）：前位过牌**不是**摊牌 ——
         * 必须显示「他过牌 / 他下注」的分流与 Hero 的最佳应手。
         */
        ...(() => {
          const tree = (bd['checkTree'] ?? null) as Readonly<Record<string, unknown>> | null;
          if (tree === null) return [];
          return [
            row(
              'CHECK 树',
              `${String(tree['kind'])}｜我在${tree['isInPosition'] === true ? '后位（过他牌 ⇒ 摊牌终止）' : '前位（他仍可下注）'}`,
            ),
            row(
              'P(他过牌) / P(他下注)',
              `${num(tree['checkBackLikelihood'])} / ${num(tree['betLikelihood'])}｜代表下注额 ${num(tree['villainBetAmount'], 1)} 筹码`,
            ),
            row(
              'CHECK 分支权益',
              `对过牌范围 ${pct(tree['heroEquityVsCheckBackRange'], 2)}（摊牌 EV ${num(tree['evShowdown'], 1)}）｜` +
                `对他下注范围 ${pct(tree['heroEquityVsBetRange'], 2)}（Hero 跟注 EV ${num(tree['heroCallEV'], 1)}、` +
                `弃牌 EV ${num(tree['heroFoldEV'], 1)} ⇒ 最佳应手 ${num(tree['heroBestResponseEV'], 1)}）`,
            ),
            row(
              'CHECK EV',
              `${num(tree['checkEV'], 1)} 筹码（加注应手 ${String(tree['raiseResponse'])}）｜${String(tree['noteZh'] ?? '')}`,
            ),
          ];
        })(),
        row(
          '权益实现因子',
          `${num(realization['factor'], 3)}（${String(realization['kind'] ?? '—')}）｜过牌分支 ` +
            `${num(bd['checkRealizationFactor'], 3)}｜${String(realization['noteZh'] ?? '—')}`,
        ),
        ...sizes.map((s) =>
          row(
            `尺寸 ${String(s['size'])}`,
            `${pct(s['ratioToPot'], 0)} 池 = **合法 ${num(s['betAmount'], 1)} 筹码**` +
              `${s['wasCapped'] === true ? `（理论 ${num(s['requestedAmount'], 1)} → 已按有效筹码封顶；来自 ${String(s['requestedKind'])}）` : ''}` +
              `${s['heroIsAllIn'] === true ? '｜**ALL-IN ⇒ 他不能加注**' : ''}｜` +
              `P(弃) ${num(s['foldLikelihood'])} / P(跟) ${num(s['callLikelihood'])} / P(加) ${num(s['raiseLikelihood'])}｜` +
              `桶组合数 ${String(s['foldComboCount'])}/${String(s['callComboCount'])}/${String(s['raiseComboCount'])}`,
          ),
        ),
        ...(() => {
          const dropped = (bd['droppedSizes'] ?? []) as readonly Readonly<Record<string, unknown>>[];
          if (dropped.length === 0) return [];
          return [
            row(
              '被丢弃的候选（不参与 EV）',
              dropped
                .map(
                  (d) =>
                    `${String(d['requestedKind'])} 理论 ${num(d['requestedAmount'], 1)} → 合法 ${num(d['legalAmount'], 1)}` +
                    `（${String(d['reasonZh'])}）`,
                )
                .join('；'),
            ),
          ];
        })(),
        ...sizes.map((s) =>
          row(
            `EV ${String(s['size'])}`,
            `EqVsArrival ${pct(bd['heroEquityVsArrivalRange'])}｜EqVsCall ${pct(s['heroEquityVsCallRange'], 2)}｜` +
              `EqVsRaise ${pct(s['heroEquityVsRaiseRange'], 2)}｜EV_fold ${num(s['evFoldBranch'], 2)}｜` +
              `EV_call ${num(s['evCallBranch'], 2)}｜EV_raise ${num(s['evRaiseBranch'], 2)}（不继续下界 ${num(s['evRaiseFoldLowerBound'], 2)}）｜` +
              `**BetEV ${num(s['betEV'], 2)}**（Δ vs CHECK ${num(s['deltaVsCheck'], 2)}）｜策略评分 ${num(s['score'])}（0–1 启发式偏好分，非筹码 EV）｜` +
              `权益方法 ${String(s['equityMethod'])}×${String(s['equityIterations'])}`,
          ),
        ),
        row(
          '画像证据归属',
          `range 层 ${boolZh(profile['rangeLayerApplied'] === true)}｜scorer 层 ${boolZh(profile['scorerLayerApplied'] === true)}｜` +
            `已阻断重复计数 ${boolZh(profile['doubleCountBlocked'] === true)}｜${String(profile['noteZh'] ?? '—')}`,
        ),
        row('响应倾向（画像）', String(bd['tendenciesZh'] ?? '—')),
        row('模型说明', String(bd['modelNoteZh'] ?? '—')),
      ]);
    })(),

    /*
     * 🔴 **多人 limp 隔离加注**（MULTI_LIMP ISOLATION RAISE PHASE 1）。
     *
     * 回答「加注这个动作是算出来的还是猜的」：逐家 limp 的响应、联合分布、
     * 对**跟注条件范围**的权益、尺寸怎么来的、身后有什么风险、EV 怎么合成。
     */
    preflopIso: (() => {
      const iso = d.preflopIso ?? null;
      if (iso === null) {
        return Object.freeze([row('隔离加注模型', '—（本节点不是「面对跛入且无人加注」的翻前节点）')]);
      }
      const num = (v: number | null, digits = 2): string => (v === null ? '—' : v.toFixed(digits));
      const pct = (v: number | null, digits = 1): string =>
        v === null ? '—' : `${(v * 100).toFixed(digits)}%`;
      return Object.freeze([
        row(
          '隔离加注模型',
          `${iso.limperCount} 家 limp ⇒ 加注到 ${num(iso.isoSize.legalIsoSize, 1)}BB` +
            `（模型请求 ${num(iso.isoSize.requestedIsoSize, 2)}BB）｜${iso.noteZh}`,
        ),
        row(
          '尺寸分解',
          Object.entries(iso.isoSize.components)
            .map(([k, v]) => `${k} ${(v as number) >= 0 ? '+' : ''}${(v as number).toFixed(2)}BB`)
            .join('｜'),
        ),
        ...iso.perLimper.map((l, i) =>
          row(
            `limp ${i + 1}｜${l.positionZh}`,
            `${l.archetypeZh}（可信度 ${l.confidence.toFixed(2)}）｜到达宽度 ${l.arrivalWidth.toFixed(2)}｜` +
              `弃 ${pct(l.foldProbability)} / 跟 ${pct(l.callProbability)} / 再加 ${pct(l.reraiseProbability)}｜` +
              `跟注需 ${pct(l.priceRequiredEquity)} 权益｜${l.noteZh}`,
          ),
        ),
        row(
          '联合响应（独立近似）',
          `全弃 ${pct(iso.joint.allFold)}｜1 家 ${pct(iso.joint.oneCaller)}｜2 家 ${pct(iso.joint.twoCallers)}｜` +
            `3 家 ${pct(iso.joint.threeCallers)}｜任一再加注 ${pct(iso.joint.anyReraise)}｜` +
            `期望跟注 ${num(iso.joint.expectedCallers)}｜假设 ${iso.joint.assumption}`,
        ),
        row(
          '权益（三种口径，不许混用）',
          `对到达范围 ${pct(iso.heroEquity.vsArrival)}（**不用于**证明加注）｜对 1 家跟注范围 ` +
            `${pct(iso.heroEquity.vsOneCaller)}｜对多家跟注范围 ${pct(iso.heroEquity.vsThreeCallers)}`,
        ),
        row(
          'EV（同一零点 = 弃牌 0）',
          `隔离加注代理 EV ${num(iso.isoEV.proxyEV)} 筹码｜跟注代理 EV ${num(iso.callProxyEV)} 筹码` +
            `（作用域 ${iso.callScope}）｜被再加注分支 ${num(iso.isoEV.reraiseContribution)}｜` +
            `身后修正 ${num(iso.isoEV.playersBehindAdjustment)}`,
        ),
        row('身后玩家风险（SB/BB）', iso.playersBehind.noteZh),
        row('模型假设', iso.assumptionsZh.join('；')),
        row('抽水', `${iso.rakeStatus}（本项目无 Rake Engine —— 所有 EV 都未计抽水）`),
      ]);
    })(),

    /*
     * 🔴 **翻前加注（PREFLOP RAISE DECISION 阶段 B）**。
     *
     * 使用者第十一节要求诊断区显示的五件事，这里逐尺寸给出：
     *
     * | 要求 | 本节的哪一行 |
     * |---|---|
     * | 各候选动作与尺寸的 EV | 「逐尺寸 EV」 |
     * | 对手弃／跟／再加注概率 | 「逐尺寸响应」 |
     * | 不同分支的条件权益 | 「条件权益」 |
     * | 对手再加注后 Hero 评估过哪些应对 | 「被再加注分支」 |
     * | 范围来源 / 模型版本 / 未支持项 | 「模型 / 范围来源」「未支持」 |
     */
    preflopRaise: (() => {
      const pr = d.preflopRaise ?? null;
      if (pr === null) {
        return Object.freeze([
          row(
            '翻前加注模型',
            '—（本节点不是「单挑 + 我之后无人未行动 + 面对加注」的翻前节点 ⇒ ' +
              '**没有**加注 EV，加注金额已如实列入「未评估动作」）',
          ),
        ]);
      }
      const num = (v: number | null | undefined, digits = 2): string =>
        v === null || v === undefined ? '—' : v.toFixed(digits);
      const pct = (v: number | null | undefined, digits = 1): string =>
        v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`;
      const eqOf = (e: { value: number | null; method: string; iterations: number }): string =>
        e.value === null ? '—' : `${pct(e.value)}（${e.method}，${e.iterations} 次）`;

      return Object.freeze([
        row('翻前加注模型', pr.noteZh),
        row(
          '模型 / 范围来源',
          `${pr.version} ｜ 响应模型 ${pr.modelVersion} ｜ 证据等级 ${pr.evidence} ｜ ` +
            `资金口径契约 ${pr.cashflowContract}`,
        ),
        row(
          '位置 / 筹码（来自真实桌型与行动顺序）',
          `Hero ${pr.heroPosition} vs ${pr.opponentPosition}｜底池 ${num(pr.currentPot)}｜` +
            `我跟注需 ${num(pr.heroCallCost)}｜我剩余 ${num(pr.heroRemaining)}｜` +
            `跟注后 SPR ${num(pr.sprAfterCall)}｜最小加注到 ${num(pr.minRaiseToAmount)}｜全下到 ${num(pr.allInToAmount)}`,
        ),
        row(
          '到达范围（他的，按行动历史条件化）',
          `${pr.arrival.comboCount} 组合｜质量 ${num(pr.arrival.mass, 4)}｜来源 ${pr.arrival.source}`,
        ),
        row(
          '逐尺寸 EV（零点 = 弃牌 ≡ 0，单位 = 筹码）',
          pr.sizes
            .map(
              (s) =>
                `${num(s.sizeBB, 1)}BB→${num(s.raiseEV)}${s.isAllIn ? '（全下）' : ''}`,
            )
            .join('｜'),
        ),
        row(
          '逐尺寸响应（他弃／跟／再加注）',
          pr.sizes
            .map(
              (s) =>
                `${num(s.sizeBB, 1)}BB：弃 ${pct(s.foldLikelihood)} / 跟 ${pct(s.callLikelihood)} / ` +
                `再加 ${pct(s.reRaiseLikelihood)}｜需权益 ${num(s.priceRequiredEquity, 4)}`,
            )
            .join('；'),
        ),
        row(
          '条件权益（每一支各一份，不许混用）',
          pr.sizes
            .map(
              (s) =>
                `${num(s.sizeBB, 1)}BB：对跟注桶 ${eqOf(s.heroEquityVsRaiseCallRange)}｜` +
                `对再加注桶 ${eqOf(s.heroEquityVsReraiseRange)}`,
            )
            .join('；'),
        ),
        row(
          '资金口径（我投入／被跟注／他补／终池／退回）',
          pr.sizes
            .map(
              (s) =>
                `${num(s.sizeBB, 1)}BB：我新增 ${num(s.heroAdd)}、被跟注 ${num(s.heroContestedAdd)}、` +
                `他补 ${num(s.villainAdd)}、终池 ${num(s.finalPot)}、退回 ${num(s.uncalledReturn)}` +
                `${s.villainIsAllInByCall ? '（他跟平即全下）' : ''}`,
            )
            .join('；'),
        ),
        row(
          '被再加注分支（只展开 Hero 的 FOLD / CALL）',
          pr.sizes
            .map((s) =>
              s.reraiseAvailable
                ? `${num(s.sizeBB, 1)}BB：他再加到 ${num(s.reRaiseTo)}（最小合法 ${num(s.reRaiseMinLegalTo)}` +
                  `${s.villainReRaiseIsAllIn ? '，全下' : ''}）⇒ Hero 弃牌 ${num(s.reraiseFoldBranchEV)} / ` +
                  `跟注 ${num(s.reraiseCallBranchEV)} ⇒ 取 **${num(s.reraiseBranchEV)}**（${s.reraiseBranchKind}）` +
                  `｜我再跟需 ${num(s.heroAdditionalCallVsReRaise)}`
                : `${num(s.sizeBB, 1)}BB：不产出再加注分支` +
                  `${s.reraiseBranchKind === 'FOLD_ONLY_UNAVAILABLE' ? '（权益不可得 ⇒ 该支按下界计）' : ''}`,
            )
            .join('；'),
        ),
        row(
          '未支持（必须与上面的数字一起读）',
          '① 被再加注分支**只**比较 Hero 的 FOLD / CALL —— **Hero 的 5Bet 应对未展开**' +
            `（heroFiveBetExpanded = ${String(pr.sizes[0]?.heroFiveBetExpanded ?? false)}）；` +
            '② 非全下分支是**摊牌终止近似**（未模拟后续街的下注/过牌/弃牌）；' +
            '③ 全下分支没有后续街 ⇒ 精确；' +
            '④ 多人池 / 身后有人未行动时**不产出**本事实包（不按单挑偷偷计算）；' +
            `⑤ 抽水 ${pr.rakeStatus}（本项目无 Rake Engine）`,
        ),
        row('模型假设（逐条）', pr.assumptionsZh.join('；')),
      ]);
    })(),

    /*
     * 🔴 **多人联合响应树**（MULTIWAY POSTFLOP RESPONSE TREE PHASE 1 · §23）。
     *
     * 回答「三人池的 BetEV 到底怎么来的」：逐对手响应 → 联合状态概率 →
     * 每个分支各自的权益与 EV → 总 EV，以及 primary opponent 有没有偷偷决定 EV。
     */
    multiwayBetDecision: (() => {
      const mw = d.multiwayBetDecision ?? null;
      if (mw === null) {
        return Object.freeze([
          row('多人联合树', '—（单挑节点，或拿不到全部对手的可达范围）'),
        ]);
      }
      const num = (v: number | null, digits = 2): string => (v === null ? '—' : v.toFixed(digits));
      const pct = (v: number | null, digits = 1): string =>
        v === null ? '—' : `${(v * 100).toFixed(digits)}%`;
      return Object.freeze([
        row('多人联合树', mw.noteZh),
        row('jointModel', `${mw.jointModel}｜${mw.independenceAssumption}`),
        row(
          '参与对手（完整列表）',
          mw.opponents
            .map((o) => `${o.positionZh}（${o.comboCount} 组合）—— ${o.tendencyNoteZh}`)
            .join('｜'),
        ),
        ...mw.perOpponentResponse.map((r) =>
          row(
            `响应｜${r.positionZh} × ${String(r.kind)}`,
            `弃 ${pct(r.foldProbability)} / 跟 ${pct(r.callProbability)} / 加 ${pct(r.raiseProbability)}` +
              `（封顶前加 ${pct(r.rawRaiseProbability)}）｜EqVsCall ${pct(r.heroEquityVsCallRange)}` +
              `｜${r.betAmount.toFixed(1)} 筹码`,
          ),
        ),
        ...mw.jointStates.map((s) =>
          row(
            `联合状态｜${String(s.kind)}`,
            s.states.states
              .map(
                (st) =>
                  `${st.kind}${st.callerId === null ? '' : `[${st.callerId}]`} ${pct(st.probability)}`,
              )
              .join('｜') + `（Σ ${s.states.total.toFixed(4)}；${s.states.independenceNoteZh}）`,
          ),
        ),
        ...mw.conditionalEquities.map((e) =>
          row(`条件权益｜${String(e.kind)}`, e.noteZh),
        ),
        ...mw.branchEVs.map((b) =>
          row(
            `分支 EV｜${String(b.kind)}`,
            b.branches
              .map(
                (br) =>
                  `${br.kind}${br.callerId === null ? '' : `[${br.callerId}]`} p ${pct(br.probability)}` +
                  ` ⇒ 底池 ${br.resultingPot.toFixed(1)}、我投入 ${br.heroCostChips.toFixed(1)}、EV ${num(br.ev)}`,
              )
              .join('；'),
          ),
        ),
        ...mw.totalBetEV.map((t) =>
          row(
            `总 EV｜${String(t.kind)}`,
            `${num(t.totalEV)} 筹码（证据等级 ${String(t.evKind)}；${t.betAmount.toFixed(1)} 筹码）`,
          ),
        ),
        row(
          '尺寸弹性（P(弃) 逐档变化）',
          mw.sizeElasticity
            .map(
              (e) =>
                `${e.opponentId}：[${e.foldDeltaPerSize.map((v) => v.toFixed(3)).join(', ')}]`,
            )
            .join('｜'),
        ),
        row(
          `尺寸饱和（sizeClampStatus = ${mw.sizeSaturation.status}）`,
          mw.sizeSaturation.reasonZh +
            (mw.sizeSaturation.identicalPairs.length === 0
              ? ''
              : `（逐位相同：${mw.sizeSaturation.identicalPairs
                  .map((p) => `${p.a}×${p.b}@${p.opponents.join('/')}`)
                  .join('、')}）`),
        ),
        row(
          'primary opponent 是否参与 EV',
          `${String(mw.primaryOpponentUsedForEV)}（false = 多人 EV 只消费完整对手列表；primary 仅用于展示）`,
        ),
        row('模型可信度', mw.modelConfidence.toFixed(2)),
      ]);
    })(),

    /*
     * 🔴 **动作证据与来源**（PREFLOP EVIDENCE PRIORITY FIX · 使用者 §16）。
     *
     * 回答「这个动作是谁选的、它凭什么覆盖别人」——
     * 可审计三件套：来源 / 优先级 / 被阻断的覆盖尝试。
     */
    decisionSource: (() => {
      const ds = d.decisionSource ?? null;
      if (ds === null) return Object.freeze([row('动作来源', '—（未经过证据裁决）')]);
      const evidence = (d.actionEvidence ?? []) as readonly Readonly<Record<string, unknown>>[];
      const alternatives = (d.alternativeActions ?? []) as readonly Readonly<Record<string, unknown>>[];
      const num = (v: unknown, digits = 2): string => (typeof v === 'number' ? v.toFixed(digits) : '—');
      return Object.freeze([
        row('动作来源（decisionSource）', `${String(ds['kind'])} —— ${String(ds['kindZh'] ?? '')}`),
        row(
          '优先级 / 是否可覆盖',
          `优先级 ${String(ds['priority'])}｜证据类型 ${String(ds['estimateType'])}｜` +
            `可覆盖其他证据 ${boolZh(ds['canOverrideEvidence'] === true)}｜证据范围 ${String(ds['evidenceScope'])}`,
        ),
        ...(ds['overrideAttempt'] === null || ds['overrideAttempt'] === undefined
          ? []
          : [
              row(
                '被阻断的覆盖尝试',
                `overrideAttempt = ${String(ds['overrideAttempt'])}｜overrideBlockedReason = ${String(ds['overrideBlockedReason'])}`,
              ),
            ]),
        row('主推荐动作', `${String(d['primaryAction'] ?? '—')}（最终动作 ${String(d['primaryAction'] ?? '—')}）`),
        ...(alternatives.length === 0
          ? []
          : [
              row(
                '备选动作（不是最终动作）',
                alternatives
                  .map((a) => `${String(a['action'])}｜${String(a['estimateType'])}｜EV ${num(a['ev'])}｜${String(a['statusZh'])}`)
                  .join('；'),
              ),
            ]),
        ...evidence.map((e) =>
          row(
            `证据 ${String(e['action'])}`,
            `${String(e['estimateType'])}｜EV ${num(e['ev'])}｜边际 ${String(e['decisionMargin'] ?? '—')}｜` +
              `启发式分 ${num(e['heuristicScore'])}｜置信度 ${num(e['confidence'])}` +
              (e['upgradeNoteZh'] === null || e['upgradeNoteZh'] === undefined ? '' : `｜升级条件：${String(e['upgradeNoteZh'])}`),
          ),
        ),
        row('来源说明', String(ds['noteZh'] ?? '—')),
      ]);
    })(),

    environment: Object.freeze([
      row('环境', d.environment.labelZh),
      row('方向建议条数', String(d.environment.advice.length)),
      row(
        '方向建议',
        d.environment.advice.length === 0
          ? '（本环境在当前街道无方向型规则）'
          : d.environment.advice
              .map((a) => `${a.target} ${a.direction}（${a.ruleId}，可信度 ${a.confidence}）`)
              .join('；'),
      ),
      row(
        '未映射的目标',
        d.environment.unmappedTargets.length === 0
          ? '（无）'
          : d.environment.unmappedTargets.map((u) => `${u.ruleId}→${u.target}`).join('；'),
      ),
      row(
        '街道不适用',
        d.environment.skippedByStreet.length === 0
          ? '（无）'
          : d.environment.skippedByStreet.map((u) => `${u.ruleId}(${u.ruleStreet})`).join('；'),
      ),
      row('个体数据 vs 环境先验', `${d.environment.priority.winner} —— ${d.environment.priority.reason}`),
      row('是否存在未验证幅度', boolZh(d.environment.anyMagnitudePresent)),
    ]),

    dynamic: Object.freeze([
      row('是否计算', boolZh(d.dynamic.computed)),
      row('状态', d.dynamic.state),
      row('状态来源', d.dynamic.stateProvenance),
      row('偏离分', String(d.dynamic.deviationScore)),
      row('动态层置信度', d.dynamic.confidence.toFixed(2)),
      row('Tilt 概率', d.dynamic.tiltProbability.toFixed(2)),
      row(
        '方向调整',
        d.dynamic.adapted.length === 0
          ? '（无）'
          : d.dynamic.adapted
              .map((a) => `${a.target} ${a.direction} ×${a.multiplier.toFixed(3)}（${a.magnitudeProvenance}）`)
              .join('；'),
      ),
      row('解释', d.dynamic.explanation.join(' / ')),
    ]),

    timing: Object.freeze(Object.entries(timings).map(([key, value]) => row(key, `${value.toFixed(1)} ms`))),
    degradations: Object.freeze(d.degradations.map((x) => x.textZh)),

    versions: Object.freeze(Object.entries(d.versions).map(([key, value]) => row(key, String(value)))),
  });

  return Object.freeze({
    actionZh,
    ...(sizeZh !== undefined ? { sizeZh } : {}),
    confidenceZh,
    classificationZh,
    reasonsZh: Object.freeze(decision.reasons.slice(0, 3).map((r) => r.textZh)),
    allReasonsZh: Object.freeze(decision.reasons.map((r) => r.textZh)),
    warningsZh: Object.freeze(warnings),
    actionable: decision.actionable,
    debug,
  });
}

/** 牌面中文（供界面显示 Hero 手牌与公共牌） */
export function cardsZhOf(cards: readonly { rank: number; suit: string }[]): string {
  return cards.map((c) => cardCodeOf(c as never)).join(' ');
}

/**
 * 把**最终**耗时表回填进 ViewModel。
 *
 * ## 🔴 红队 F-09：为什么需要这个函数
 *
 * `toDecisionViewModel` 是在 `mark('viewmodel', …)` **内部**被调用的，
 * 因此它拿到的 `timings` 里**必然**还没有 `viewmodel` 与 `total` 两项
 *（它们要等这次调用返回之后才写得进去）。
 *
 * 后果：调试面板里 `viewmodel` / `total` 永远是 `0.0 ms`，
 * 使用者无法从结果面板看到总耗时，也无法看到 ViewModel 构建耗时。
 *
 * 修复方式刻意选择「**回填**」而不是「让 ViewModel 自己计时」：
 * 后者会算出**另一个** total（少了日志写入、多了自计时的开销），
 * 于是界面上的 total 与管线返回的 `timings.total` 对不上 ——
 * 那只是把一个不一致换成另一个不一致。
 *
 * 现在：管线把**同一个** `finalTimings` 对象同时用于
 * 返回值的 `timings`、决策日志的 `timingMs`、以及这里的显示。
 * 三处必然逐位一致，可被测试直接锁定。
 */
export function withFinalTimings(
  viewModel: DecisionViewModel,
  timings: Readonly<Record<string, number>>,
): DecisionViewModel {
  return Object.freeze({
    ...viewModel,
    debug: Object.freeze({
      ...viewModel.debug,
      timing: Object.freeze(
        Object.entries(timings).map(([key, value]) => row(key, `${value.toFixed(1)} ms`)),
      ),
    }),
  });
}
