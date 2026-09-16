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
  const actionZh =
    decision.action !== null
      ? `${t('common.suggestion')}${actionZhOf(decision.action)}`
      : t('common.analysisBlocked');
  const sizeZh =
    decision.actionable && decision.sizeChips !== undefined
      ? `${bbZh(decision.sizeChips, bb)}（${chipsZh(decision.sizeChips)} ${t('common.chips')}）`
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
      row('估计权益', math.heroEquity === null ? '—（无法计算）' : percentZh(math.heroEquity, 1)),
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
            row(
              '动作偏好顺序（启发式比较分）',
              [...d.postflop.evRanking]
                .sort((a, b) => b.score - a.score)
                .map((x) => `${x.action} ${x.score.toFixed(2)}`)
                .join(' > ') +
                (String(d.postflop.decisionBasisKind ?? '') === 'PREFERENCE_SCORE'
                  ? '　← 本次动作即由它选出'
                  : `　← **本次动作不是由它选出的**（依据：${String(d.postflop.decisionBasisKind ?? '—')}），仅作参考`),
            ),
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
            row('有效组合数', `${d.range.supportSize} / 1326（${percentZh(d.range.supportShare, 1)}）`),
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
            row('实测手数', String(d.player.handsObserved)),
            row('可信度', d.player.confidence.toFixed(2)),
            row('是否中性化（样本不足）', boolZh(d.player.neutralized)),
            row('说明', d.player.note),
          ]),

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
