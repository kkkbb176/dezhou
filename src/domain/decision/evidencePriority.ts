/**
 * 🔴 **动作证据优先级与覆盖权限**（PREFLOP EVIDENCE PRIORITY FIX）
 *
 * ## 修的是什么（玩家实测的真实缺陷）
 *
 * 固定节点：6-max 1/2，Hero CO A♠J♠，HJ open 3BB。修复前的输出是：
 *
 * ```text
 * CALL : DecisionMargin = CLEAR_CALL，proxy EV = +2.73 筹码（**已量化**）
 * 3BET : EV = NOT_AVAILABLE（缺 fold-to-3bet / call-3bet / 4bet 数据）
 * FINAL: 3BET ← 由 `SAFETY_RULE` 覆盖
 * ```
 *
 * 即**一个没有任何 EV 证据的战略启发式，覆盖了一个已有清晰正边际的量化结论**，
 * 而且它套着「Safety」的名字 —— 这不是安全，是策略偏好。玩家原话：
 * 「SAFETY_RULE 可以覆盖已有数学证据动作」。
 *
 * ## 本模块建立的层级（使用者第二节）
 *
 * ```text
 * HARD_CONSTRAINT           合法性 / 输入损坏 / 无法构造合法动作   ← 可以覆盖一切
 *   >
 * COMPARABLE EV EVIDENCE    EXACT / MODEL_EV / PROXY_EV（**可比**的量化证据）
 *   >
 * STRATEGIC HEURISTIC       方向性战略判断（没有 EV）
 *   >
 * FALLBACK                  完全没有可用证据时的兜底
 * ```
 *
 * ## 三条硬规则
 *
 * 1. **低质量证据不得覆盖清晰的高质量证据**（没有显式规则时）。
 * 2. **UNKNOWN EV ≠ 0**：`ev === null` 的候选**不参与** EV 比较，
 *    也绝不被当成 0 而「输给 +2.73」（使用者 §19.12）。
 * 3. **MARGINAL 时允许启发式打断**（`HEURISTIC_TIEBREAK`），
 *    但必须如实标注来源，不得伪装成 EV 优胜。
 *
 * ⚠️ 本模块**只做权限裁决**：它不产生 EV、不改任何策略参数、不算弃牌率。
 * 未来若 3bet 建立了完整 EV（`MODEL_EV`），它会**自然**在同一张表里参与比较并获胜。
 */

import { DecisionMargin, type DecisionMargin as DecisionMarginType } from './decision.types.ts';

/* ============================================================
 * 证据类型与优先级
 * ============================================================ */

export const EstimateType = {
  /** 精确枚举 / 代数恒等（例：弃牌 EV ≡ 0、分层精确 EV） */
  EXACT: 'EXACT',
  /** 本项目自己建的模型 EV（有明确公式与假设） */
  MODEL_EV: 'MODEL_EV',
  /** 代理 EV：由既有权益/赔率推导，**不是**完整博弈树 EV */
  PROXY_EV: 'PROXY_EV',
  /**
   * 🔴 **独立战略证据**（§2）：某个动作有**自己的一套模型**，
   * 该模型给出代理 EV 的同时**显式声明了它的假设与不确定性**
   * （例：多人 limp 隔离加注 = limp 响应树 + 对跟注范围的权益 + 尺寸/身后风险）。
   *
   * 与 `PROXY_EV` 的关系：两者都是代理 EV，因此**可以在同一零点上比较**；
   * 区别在于「证据的作用域」—— `PROXY_EV` 常常只被算来回答「A vs B」，
   * 而 `INDEPENDENT_STRATEGIC_EVIDENCE` 是**为这个动作本身**建的模型，
   * 因此它有权要求「与其他动作正面比 EV」，而不是被别人的局部结论拦截。
   */
  INDEPENDENT_STRATEGIC_EVIDENCE: 'INDEPENDENT_STRATEGIC_EVIDENCE',
  /** 战略启发式：只有方向与序关系，没有 EV */
  HEURISTIC: 'HEURISTIC',
  /** 未知：数据不足，**绝不能当成 0** */
  UNKNOWN: 'UNKNOWN',
} as const;
export type EstimateType = (typeof EstimateType)[keyof typeof EstimateType];

/**
 * 证据优先级（**只用于「谁有资格覆盖谁」，不是打分表**）。
 *
 * ⚠️ 使用者 §12 明确要求：不得把它变成「全局常数打分」。
 * 因此本表只在两种场合被读取：
 * ① 判断某候选是否属于「可比 EV 证据」；② 同 EV 时的确定性排序。
 */
export const EVIDENCE_PRIORITY: Readonly<Record<EstimateType, number>> = Object.freeze({
  EXACT: 4,
  MODEL_EV: 4,
  PROXY_EV: 3,
  INDEPENDENT_STRATEGIC_EVIDENCE: 3,
  HEURISTIC: 2,
  UNKNOWN: 1,
});

/** 这一档证据是否属于「可比的量化证据」（只有它参与 EV 比较） */
function isQuantified(type: EstimateType): boolean {
  return (
    type === EstimateType.EXACT ||
    type === EstimateType.MODEL_EV ||
    type === EstimateType.PROXY_EV ||
    type === EstimateType.INDEPENDENT_STRATEGIC_EVIDENCE
  );
}

/* ============================================================
 * 决策来源
 * ============================================================ */

export const DecisionSourceKind = {
  /** 合法性 / 输入损坏 / 无合法候选 ⇒ 可以覆盖一切（**唯一的 Safety**） */
  HARD_CONSTRAINT: 'HARD_CONSTRAINT',
  /** 由一个「清晰边际 + 已量化 EV」的动作优胜（低质量证据不得覆盖它） */
  SUPPORTED_ACTION_PRIORITY: 'SUPPORTED_ACTION_PRIORITY',
  /**
   * 🔴 由某个动作**自有的独立模型**在跨动作 EV 比较中胜出
   * （赢的不是「启发式偏好」，而是一份声明了假设的代理 EV）。
   */
  INDEPENDENT_STRATEGIC_EVIDENCE: 'INDEPENDENT_STRATEGIC_EVIDENCE',
  /** 量化证据只到 MARGINAL ⇒ 允许战略启发式打断（来源如实标注） */
  HEURISTIC_TIEBREAK: 'HEURISTIC_TIEBREAK',
  /** 没有任何量化证据 ⇒ 纯战略启发式 */
  STRATEGIC_HEURISTIC: 'STRATEGIC_HEURISTIC',
  /** 连启发式都没有 ⇒ 兜底（按最小代价方向） */
  FALLBACK: 'FALLBACK',
} as const;
export type DecisionSourceKind = (typeof DecisionSourceKind)[keyof typeof DecisionSourceKind];

export const DECISION_SOURCE_ZH: Readonly<Record<DecisionSourceKind, string>> = Object.freeze({
  HARD_CONSTRAINT: '硬约束（合法性 / 输入安全）—— 唯一允许覆盖一切来源',
  SUPPORTED_ACTION_PRIORITY: '受支持动作优先（量化 EV + 清晰边际，低质量证据不得覆盖）',
  INDEPENDENT_STRATEGIC_EVIDENCE:
    '独立战略证据（该动作自有模型给出的代理 EV，已在同一零点与其他动作正面比较；假设与不确定性均已声明）',
  HEURISTIC_TIEBREAK: '启发式打断（量化证据只到边缘 ⇒ 允许战略判断，来源如实标注）',
  STRATEGIC_HEURISTIC: '战略启发式（无任何量化证据）',
  FALLBACK: '兜底（无可用证据，按最小代价方向）',
});

/* ============================================================
 * 证据与裁决
 * ============================================================ */

/** 单个动作的证据（使用者 §11） */
export type ActionEvidence = {
  action: string;
  estimateType: EstimateType;
  /** 筹码单位的 EV；`UNKNOWN`/`HEURISTIC` ⇒ `null`（**不是 0**） */
  ev: number | null;
  /** 相对工程容差带的边际；只有量化证据才有 */
  decisionMargin: DecisionMarginType | null;
  /** 启发式分（0..1；只在 `HEURISTIC` 档参与比较） */
  heuristicScore: number;
  confidence: number;
  /** 这个数字建立在什么假设上（必须可读） */
  assumptionsZh: readonly string[];
  /** 缺什么数据才能升级为更高一档证据（透明化，不伪造） */
  upgradeNoteZh: string | null;
  /**
   * 🔴 **覆盖清晰证据所需的独立论证**（没有它，启发式**不得**覆盖 CLEAR 证据）。
   *
   * 为什么需要这个字段：把规则写成「CLEAR_CALL ⇒ 永远不能被无 EV 的加注覆盖」
   * 会**打断正常的价值加注**（实测：AA 面对 3bet、低 SPR 下 AA 全下、
   * 三条面对下注——这些旧契约都会退回跟注）。而「加注的资金是在领先时投入的」
   * 这件事在本项目里**是有既有模型的**，不需要新参数：
   *
   * | 论证 | 依据（既有实现） |
   * |---|---|
   * | `MONSTER_STRENGTH_DOMINANCE` | 牌力档 = MONSTER 且权益优势 ≥ `RAISE_EDGE_ANY` ⇒ 对手范围几乎不可能反超 |
   * | `LOW_SPR_COMMITMENT` | `commitmentException`（低 SPR + 牌力足够 ⇒ 筹码已基本入池）⇒ 加注与跟注只差把剩余部分投入 |
   *
   * 中等强度的加注/3bet **没有**这两条论证 ⇒ 必须让位给清晰的 CALL 证据
   *（这正是本轮要修的缺陷）。
   */
  overrideJustification?: { kind: string; noteZh: string } | null;
};

export type EvidenceDecision = {
  action: string;
  source: DecisionSourceKind;
  /** 被选中证据的优先级（debug 用；不是打分） */
  priority: number;
  /** 被选中证据的类型 */
  estimateType: EstimateType;
  /** 该来源是否可以覆盖其他证据（`HARD_CONSTRAINT`/`HEURISTIC_TIEBREAK`/`FALLBACK` 为真） */
  canOverrideEvidence: boolean;
  /** 证据范围（例：`CALL_PROXY_ONLY` —— 最优量化证据只是代理 EV） */
  evidenceScope: string;
  /** 被阻断的覆盖尝试（例：`RAISE_HEURISTIC`） */
  overrideAttempt: string | null;
  /** 阻断原因（例：`CANNOT_OVERRIDE_CLEAR_SUPPORTED_CALL`） */
  overrideBlockedReason: string | null;
  reasonZh: readonly string[];
};

/** 由 EV 与容差带得到边际（与决策层同一口径，避免两处判断） */
export function marginOf(ev: number | null, bandChips: number): DecisionMarginType | null {
  if (ev === null || !Number.isFinite(ev) || !(bandChips >= 0)) return null;
  if (ev > bandChips) return DecisionMargin.CLEAR_CALL_OVER_FOLD;
  if (ev < -bandChips) return DecisionMargin.CLEAR_FOLD;
  return DecisionMargin.MARGINAL;
}

/**
 * 这一档证据是否属于「可比的量化证据」。
 *
 * ⚠️ 只导出给**作用域计算**（`decisionMargin.scope`）：决策层必须能独立说出
 * 「本次清晰边际是与几个动作比出来的」，否则又会退化成「没有作用域的明显」。
 */
export function isQuantifiedEvidence(type: EstimateType): boolean {
  return isQuantified(type);
}

/**
 * 按证据优先级裁决动作。
 *
 * @param input.candidates 全部合法动作的证据（顺序即确定性 tie-break 顺序）
 * @param input.hardConstraint 硬约束（某个动作因合法性/输入安全被强制）
 * @param input.allowHeuristicTiebreak 是否允许「量化证据只到 MARGINAL 时」被启发式打断（§6，默认允许）
 */
export function chooseByEvidencePriority(input: {
  candidates: readonly ActionEvidence[];
  hardConstraint?: { action: string; reasonZh: string } | null;
  allowHeuristicTiebreak?: boolean;
  /**
   * 🔴 模型容差带（筹码）—— 用于**跨动作**比较（§1/§17）。
   *
   * 缺省 ⇒ 不做跨动作结论（保守：不声称「谁更优」）。
   */
  bandChips?: number;
}): EvidenceDecision {
  const candidates = input.candidates;
  const hard = input.hardConstraint ?? null;

  // ---- ① 硬约束最高（**唯一的 Safety 用途**）----
  if (hard !== null) {
    const target = candidates.find((c) => c.action === hard.action);
    return Object.freeze({
      action: hard.action,
      source: DecisionSourceKind.HARD_CONSTRAINT,
      priority: 5,
      estimateType: target?.estimateType ?? EstimateType.UNKNOWN,
      canOverrideEvidence: true,
      evidenceScope: 'HARD_CONSTRAINT',
      overrideAttempt: null,
      overrideBlockedReason: null,
      reasonZh: Object.freeze([
        `HARD_CONSTRAINT：${hard.reasonZh}`,
        '硬约束只处理合法性 / 输入安全（不处理战略偏好），因此它可以覆盖任何证据',
      ]),
    });
  }

  const quantified = candidates.filter((c) => isQuantified(c.estimateType) && c.ev !== null);
  const heuristics = candidates
    .filter((c) => c.estimateType === EstimateType.HEURISTIC && c.heuristicScore > 0)
    .slice()
    .sort((a, b) => b.heuristicScore - a.heuristicScore);
  const strongestHeuristic = heuristics[0] ?? null;

  // ---- ② 有量化证据 ----
  if (quantified.length > 0) {
    const best = quantified
      .slice()
      .sort((a, b) => {
        if (b.ev! !== a.ev!) return b.ev! - a.ev!;
        if (EVIDENCE_PRIORITY[b.estimateType] !== EVIDENCE_PRIORITY[a.estimateType]) {
          return EVIDENCE_PRIORITY[b.estimateType] - EVIDENCE_PRIORITY[a.estimateType];
        }
        return candidates.indexOf(a) - candidates.indexOf(b);
      })[0]!;

    const scope =
      best.estimateType === EstimateType.PROXY_EV
        ? `${best.action}_PROXY_ONLY`
        : best.estimateType === EstimateType.EXACT || best.estimateType === EstimateType.MODEL_EV
          ? `${best.action}_${best.estimateType}`
          : best.estimateType === EstimateType.INDEPENDENT_STRATEGIC_EVIDENCE
            ? `${best.action}_INDEPENDENT_MODEL`
            : 'FULL';

    /*
     * 🔴 **跨动作比较**（MULTI_LIMP §1/§17）：谁有量化 EV，就必须与谁正面比。
     *
     * 修复前只有一条规则：「边际 CLEAR ⇒ 低质量证据不得覆盖」。而 CLEAR
     * 本身可能只是「CALL vs FOLD」这一对的结论（`CLEAR_CALL_OVER_FOLD`），
     * 于是**加注从未被算过 EV 就被拦截**。
     *
     * 现在：只要存在**另一个动作**自己的量化 EV，就在同一零点（弃牌 ≡ 0）上比较；
     * 差距落在容差带内 ⇒ 如实写成「模型分辨不出」并允许战略启发式打断。
     */
    const second =
      quantified
        .filter((c) => c.action !== best.action)
        .slice()
        .sort((a, b) => b.ev! - a.ev!)[0] ?? null;
    const band = input.bandChips;
    const crossActionGap = second === null ? null : Math.abs(best.ev! - second.ev!);
    const crossActionInconclusive =
      crossActionGap !== null &&
      band !== undefined &&
      crossActionGap <= band &&
      best.action !== 'FOLD';
    const crossActionNoteZh =
      second === null || crossActionGap === null
        ? null
        : `${best.action} vs ${second.action}：各自模型的 EV 差 ${crossActionGap.toFixed(2)} 筹码` +
          (band === undefined ? '（未提供容差带 ⇒ 不做结论）' : `，容差带 ±${band.toFixed(2)}`);

    if (crossActionInconclusive && strongestHeuristic !== null && strongestHeuristic.action !== best.action) {
      return Object.freeze({
        action: strongestHeuristic.action,
        source: DecisionSourceKind.HEURISTIC_TIEBREAK,
        priority: EVIDENCE_PRIORITY.HEURISTIC,
        estimateType: EstimateType.HEURISTIC,
        canOverrideEvidence: true,
        evidenceScope: `${best.action}_vs_${second!.action}_WITHIN_BAND`,
        overrideAttempt: `${strongestHeuristic.action}_HEURISTIC`,
        overrideBlockedReason: null,
        reasonZh: Object.freeze([
          `两个动作**各自都有量化证据**：${best.action} ${best.estimateType} EV ${best.ev!.toFixed(2)}、` +
            `${second!.action} ${second!.estimateType} EV ${second!.ev!.toFixed(2)}`,
          `${crossActionNoteZh!} ⇒ 差距在模型容差带内，**模型分辨不出谁更好**（不是「谁 EV 更高」）`,
          `⇒ 允许战略启发式打断：选 ${strongestHeuristic.action}（分 ${strongestHeuristic.heuristicScore.toFixed(2)}）；` +
            'FINAL_SOURCE = HEURISTIC_TIEBREAK（**不是** EV 优胜，不得如此呈现）',
        ]),
      });
    }

    const clear = best.decisionMargin === DecisionMargin.CLEAR_CALL_OVER_FOLD || best.decisionMargin === DecisionMargin.CLEAR_FOLD;
    /** 优胜证据来自自有独立模型 ⇒ 来源必须如实写成 `INDEPENDENT_STRATEGIC_EVIDENCE` */
    const winnerSource =
      best.estimateType === EstimateType.INDEPENDENT_STRATEGIC_EVIDENCE
        ? DecisionSourceKind.INDEPENDENT_STRATEGIC_EVIDENCE
        : DecisionSourceKind.SUPPORTED_ACTION_PRIORITY;

    // ②-a 清晰边际：低质量证据**不得**覆盖 —— 除非它带独立论证
    if (clear) {
      const justified =
        strongestHeuristic !== null &&
        strongestHeuristic.action !== best.action &&
        strongestHeuristic.overrideJustification !== null &&
        strongestHeuristic.overrideJustification !== undefined
          ? strongestHeuristic
          : null;
      if (justified !== null) {
        return Object.freeze({
          action: justified.action,
          source: DecisionSourceKind.STRATEGIC_HEURISTIC,
          priority: EVIDENCE_PRIORITY.HEURISTIC,
          estimateType: EstimateType.HEURISTIC,
          canOverrideEvidence: true,
          evidenceScope: `${best.action}_${best.decisionMargin ?? 'CLEAR'}_OVERRIDDEN`,
          overrideAttempt: `${justified.action}_HEURISTIC`,
          overrideBlockedReason: null,
          reasonZh: Object.freeze([
            `${best.action}：${best.estimateType} EV ${best.ev!.toFixed(2)} 筹码，边际 ${String(best.decisionMargin)}`,
            `但 ${justified.action} 带有**独立论证**：${justified.overrideJustification!.kind} —— ` +
              justified.overrideJustification!.noteZh,
            `⇒ 允许战略启发式覆盖（来源 ${DecisionSourceKind.STRATEGIC_HEURISTIC}；` +
              '不是 EV 优胜，不得如此呈现）',
          ]),
        });
      }
      const blocked =
        strongestHeuristic !== null && strongestHeuristic.action !== best.action
          ? {
              attempt: `${strongestHeuristic.action}_HEURISTIC`,
              reason: `CANNOT_OVERRIDE_CLEAR_SUPPORTED_${best.action}`,
            }
          : null;
      return Object.freeze({
        action: best.action,
        source: winnerSource,
        priority: EVIDENCE_PRIORITY[best.estimateType],
        estimateType: best.estimateType,
        canOverrideEvidence: false,
        evidenceScope: scope,
        overrideAttempt: blocked?.attempt ?? null,
        overrideBlockedReason: blocked?.reason ?? null,
        reasonZh: Object.freeze([
          `${best.action}：${best.estimateType} EV ${best.ev!.toFixed(2)} 筹码，边际 ${String(best.decisionMargin)}（清晰）`,
          ...(crossActionNoteZh === null ? [] : [crossActionNoteZh + ' ⇒ 跨动作比较**已做**（不是只和弃牌比过）']),
          ...(blocked === null
            ? []
            : [
                `有战略启发式想选 ${strongestHeuristic!.action}（分 ${strongestHeuristic!.heuristicScore.toFixed(2)}），` +
                  '但它的 EV 不可得（HEURISTIC），且**没有**独立论证（MONSTER 强度优势 / 低 SPR 承诺）' +
                  '⇒ **不得覆盖清晰的可比 EV 证据**',
                `overrideBlockedReason = ${blocked.reason}`,
              ]),
          ...(best.estimateType === EstimateType.PROXY_EV ||
          best.estimateType === EstimateType.INDEPENDENT_STRATEGIC_EVIDENCE
            ? ['⚠️ 该 EV 是**代理 EV**（不是完整博弈树 EV）—— 因此边际的含义是「在当前已建模的证据里清晰领先」，不是「全局最优」']
            : []),
        ]),
      });
    }

    // ②-b 只到 MARGINAL：允许启发式打断（来源如实标注）
    if (
      (input.allowHeuristicTiebreak ?? true) &&
      strongestHeuristic !== null &&
      strongestHeuristic.action !== best.action
    ) {
      return Object.freeze({
        action: strongestHeuristic.action,
        source: DecisionSourceKind.HEURISTIC_TIEBREAK,
        priority: EVIDENCE_PRIORITY.HEURISTIC,
        estimateType: EstimateType.HEURISTIC,
        canOverrideEvidence: true,
        evidenceScope: `${best.action}_MARGINAL`,
        overrideAttempt: `${strongestHeuristic.action}_HEURISTIC`,
        overrideBlockedReason: null,
        reasonZh: Object.freeze([
          `量化证据只到 MARGINAL（${best.action}：${best.estimateType} EV ${best.ev!.toFixed(2)}，边际 ${String(best.decisionMargin)}）`,
          `⇒ 允许战略启发式打断：选 ${strongestHeuristic.action}（分 ${strongestHeuristic.heuristicScore.toFixed(2)}）`,
          'FINAL_SOURCE = HEURISTIC_TIEBREAK（**不是** EV 优胜，不得如此呈现）',
        ]),
      });
    }

    return Object.freeze({
      action: best.action,
      source: winnerSource,
      priority: EVIDENCE_PRIORITY[best.estimateType],
      estimateType: best.estimateType,
      canOverrideEvidence: false,
      evidenceScope: scope,
      overrideAttempt: null,
      overrideBlockedReason: null,
      reasonZh: Object.freeze([
        `${best.action}：${best.estimateType} EV ${best.ev!.toFixed(2)} 筹码（边际 ${String(best.decisionMargin)}）` +
          '—— 在没有更高质量证据之前按它执行',
        ...(crossActionNoteZh === null ? [] : [crossActionNoteZh]),
      ]),
    });
  }

  // ---- ③ 没有任何量化证据：战略启发式 ----
  if (strongestHeuristic !== null) {
    return Object.freeze({
      action: strongestHeuristic.action,
      source: DecisionSourceKind.STRATEGIC_HEURISTIC,
      priority: EVIDENCE_PRIORITY.HEURISTIC,
      estimateType: EstimateType.HEURISTIC,
      canOverrideEvidence: true,
      evidenceScope: 'HEURISTIC_ONLY',
      overrideAttempt: null,
      overrideBlockedReason: null,
      reasonZh: Object.freeze([
        `没有任何可比的量化 EV 证据（全部 UNKNOWN）⇒ 按战略启发式选择 ${strongestHeuristic.action}`,
        `⚠️ 这是**战略判断**，不是 EV 结论${strongestHeuristic.upgradeNoteZh === null ? '' : `；${strongestHeuristic.upgradeNoteZh}`}`,
      ]),
    });
  }

  // ---- ④ 连启发式都没有：兜底 ----
  const fallback = candidates[candidates.length - 1] ?? null;
  return Object.freeze({
    action: fallback?.action ?? 'FOLD',
    source: DecisionSourceKind.FALLBACK,
    priority: EVIDENCE_PRIORITY.UNKNOWN,
    estimateType: EstimateType.UNKNOWN,
    canOverrideEvidence: true,
    evidenceScope: 'NONE',
    overrideAttempt: null,
    overrideBlockedReason: null,
    reasonZh: Object.freeze([
      '全部候选都没有可用证据（EV 不可得、也没有战略启发式）⇒ 走兜底：取代价最小的合法方向',
      'decisionBasis = FALLBACK（必须如实呈现，不得伪装成 EV 或策略结论）',
    ]),
  });
}
