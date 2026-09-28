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
 * ## 🔴 RIVER RAISE DECISION V2（2026-09）：规则 1 的例外被收窄
 *
 * 修复前规则 1 有一个例外口子：只要启发式动作带 `overrideJustification`，
 * 它就能覆盖**清晰**的量化赢家。对赌审计实测（AK 面对河牌下注）：
 *
 * ```text
 * CALL : PROXY_EV +19.70，容差带 ±6.65 ⇒ CLEAR_CALL_OVER_FOLD
 * RAISE: HEURISTIC, ev = null（"加注的 EV 无法计算"）
 * FINAL: RAISE 174（= 全下 87BB）← 覆盖成功，overrideBlockedReason = null
 * 理由：LOW_SPR_COMMITMENT（SPR 1.441 ≤ 1.5）
 * ```
 *
 * 而同一个 `commitment` 模块给这次决策生成的注记是：
 * 「河牌**没有下一街**，SPR 只作背景信息……**不构成打光的理由**」。
 *
 * 现在例外只保留给**不消耗筹码**的加注：
 *
 * | 启发式动作 | 能否覆盖清晰量化赢家 |
 * |---|---|
 * | 不消耗筹码（部分加注 / 4bet 之类） | ✅ 可以（带独立论证时） |
 * | **打光筹码（全下 / raise-to = 全部剩余）** | ❌ **不可以** —— 只能走 `HEURISTIC_TIEBREAK`（量化证据只到 MARGINAL）或自带 EV |
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
   * 🔴 **RIVER RAISE DECISION V2：这个动作是否**把剩余筹码全部投入**（全下）。
   *
   * ## 为什么覆盖权限必须看它
   *
   * 2026-09 的对赌审计（`reports/RIVER_RAISE_DECISION_AUDIT.md`）实测：
   * 一个**没有 EV** 的启发式加注覆盖了边际**清晰**的 CALL（AK 面对河牌下注，
   * `CALL EV = +19.70`、容差带 ±6.65），理由是 `LOW_SPR_COMMITMENT`；
   * 而它自己的注释在河牌上写着「SPR 只作背景信息，不构成打光的理由」。
   *
   * 两类加注的性质完全不同：
   *
   * | 类型 | 后果 | 允许启发式覆盖清晰 EV 赢家？ |
   * |---|---|---|
   * | **不消耗筹码**的加注（例如 AA 面对 3bet 的 4bet） | 只投入一部分，决定仍然活着 | ✅ 允许（战略偏好在两条「继续」线之间选择） |
   * | **打光筹码**的加注（全下 / raise-to = 全部剩余） | 不可逆、一次性押上全部 | ❌ **不允许** —— 没有对手继续范围与加注 EV 就无法论证 |
   *
   * 这正是「不得无条件删除合法加注」（AA 面对 3bet 的价值加注仍然可达）
   * 与「不得用启发式把跟注升级成全下」两条要求的唯一交点。
   *
   * `true` ⇒ 该启发式证据**不得**凭借 `overrideJustification` 覆盖清晰的量化赢家
   *（它只能走 `HEURISTIC_TIEBREAK`：量化证据只到 MARGINAL 时）。
   */
  commitsStack?: boolean;
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
  /**
   * 🔴 **CB-5 · 打光筹码的容差带护栏**（仅在该护栏触发时存在）。
   *
   * 语义：量化最优动作**会消耗 Hero 全部剩余筹码**，而它相对「最佳非全下候选」
   * 的优势 `0 ≤ 差 ≤ 容差带` ⇒ 这点优势**不足以单独授权**打光筹码，
   * 于是改按既有证据优先级选那个不消耗筹码的动作。
   *
   * ⚠️ 它**不**声称备选动作在真实牌局中更高 —— 两个数字都在模型自己的分辨力之内。
   * ⚠️ 被拦截的动作**不会**从候选表/证据表里删除：这里只改最终裁决。
   */
  stackCommitmentGuard?: {
    readonly blockedAction: string;
    readonly alternativeAction: string;
    readonly blockedEV: number;
    readonly alternativeEV: number;
    readonly gapChips: number;
    readonly bandChips: number;
    readonly blockedEstimateType: EstimateType;
    readonly alternativeEstimateType: EstimateType;
    readonly reasonZh: string;
  };
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
  /**
   * 🔴 **CB-5 · 本节点是否适用「打光筹码需要超过容差带的依据」这条护栏。**
   *
   * 由**调用方**判定（`street === RIVER && 面对下注`），因为「哪条街 / 是否面对下注」
   * 是决策层的知识，本模块只做**权限裁决**、不重新实现牌局状态判断
   *（同一条纪律：同一个判据只能有一处实现）。
   *
   * 缺省 / `false` ⇒ 行为与本护栏引入前**逐位一致**。
   */
  stackCommitmentGuardApplies?: boolean;
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

    /*
     * 🔴 **CB-5 · 打光筹码的动作需要「超过容差带」的依据。**
     *
     * ## 缺陷（`reports/FLOP_RIVER_THEORY_EXPLOIT_AUDIT_V1.md` CB-5）
     *
     * 河牌面对下注时，一个**消耗全部剩余筹码**的加注只要 EV 比最佳备选高一丁点，
     * 就会在同一张表的跨动作比较里胜出。实测（A♠K♠｜K♦9♣4♥6♠2♦，`analyzeManualHand`）：
     *
     * ```text
     * RAISE(MODEL_EV) 48.48 vs CALL(PROXY_EV) 45.33 ⇒ 差 3.15，容差带 ±10.95
     * RAISE(MODEL_EV) 42.96 vs CALL(PROXY_EV) 42.92 ⇒ 差 0.03，容差带 ±9.55
     * ```
     *
     * 而 `decisionMargin.noteZh` 自己写着「容差带是**工程容差**，不是统计误差，
     * 也不自动翻转动作」—— 它却在这里授权了**不可逆**的全下。
     *
     * ## 本护栏说什么 / 不说什么
     *
     * 说：`0 ≤ EV_stack − EV_alternative ≤ 容差带` ⇒ 这点优势**不足以单独授权**
     * 把全部筹码押上；改按既有证据优先级选**最佳非全下**候选。
     * **不**说：备选动作在真实牌局中一定更高（两个数字都在模型分辨力之内）。
     *
     * ## 触发条件（全部为硬条件，任一不成立即不触发）
     *
     * | # | 条件 | 防的是 |
     * |---|---|---|
     * | ① | `input.stackCommitmentGuardApplies === true`（调用方判定：**河牌 + 面对下注**） | 误伤翻前 / 翻牌 / 转牌的既有策略 |
     * | ② | `band !== undefined` | 没有容差带 ⇒ 不做跨动作结论 |
     * | ③ | `best.commitsStack === true` | 只约束**打光筹码**的动作 |
     * | ④ | `second !== null && second.commitsStack !== true` | 必须存在**不消耗筹码**的备选 |
     * | ⑤ | 两条 EV 都是有限数（`quantified` 已保证非 null） | **绝不把 null 当 0** |
     * | ⑥ | `0 ≤ 差 ≤ band`（含边界） | 优势超过容差带 ⇒ 量化证据仍然支持加注 |
     *
     * ⚠️ 本轮不新增任何模型系数、不改任何 EV 公式；候选表与证据表**原样保留**。
     */
    const stackGuardGap =
      best.commitsStack === true && second !== null && second.commitsStack !== true
        ? best.ev! - second.ev!
        : null;
    /** 护栏的有效备选（已由条件保证非 null 且不消耗筹码） */
    const stackGuardAlternative = second;
    let stackCommitmentGuard: EvidenceDecision['stackCommitmentGuard'];
    if (
      input.stackCommitmentGuardApplies === true &&
      band !== undefined &&
      Number.isFinite(band) &&
      stackGuardGap !== null &&
      Number.isFinite(stackGuardGap) &&
      stackGuardGap >= 0 &&
      stackGuardGap <= band &&
      stackGuardAlternative !== null
    ) {
      /** 显式取局部常量：`band` / 备选动作在上面这组条件之后已确定为有效值 */
      const guardBand: number = band;
      const guardAlternativeEV: number = stackGuardAlternative.ev!;
      stackCommitmentGuard = Object.freeze({
        blockedAction: best.action,
        alternativeAction: stackGuardAlternative.action,
        blockedEV: best.ev!,
        alternativeEV: guardAlternativeEV,
        gapChips: stackGuardGap,
        bandChips: guardBand,
        blockedEstimateType: best.estimateType,
        alternativeEstimateType: stackGuardAlternative.estimateType,
        reasonZh:
          `「${best.action}」（${best.estimateType} EV ${best.ev!.toFixed(2)}）会让 Hero 把剩余筹码**全部投入**，` +
          `而它相对最佳非全下候选「${stackGuardAlternative.action}」（${stackGuardAlternative.estimateType} ` +
          `EV ${guardAlternativeEV.toFixed(2)}）只高 ${stackGuardGap.toFixed(2)} 筹码 —— ` +
          `落在模型自身的工程容差带 ±${guardBand.toFixed(2)} 之内。` +
          '⇒ **这点优势不足以单独授权打光筹码**，改按既有证据优先级选择不消耗筹码的动作。' +
          '⚠️ 这不等于声称备选动作在真实牌局中更高（两个数字都在模型的分辨力之内）。',
      });
    }
    if (stackCommitmentGuard !== undefined) {
      return Object.freeze({
        action: stackCommitmentGuard.alternativeAction,
        source:
          stackCommitmentGuard.alternativeEstimateType === EstimateType.INDEPENDENT_STRATEGIC_EVIDENCE
            ? DecisionSourceKind.INDEPENDENT_STRATEGIC_EVIDENCE
            : DecisionSourceKind.SUPPORTED_ACTION_PRIORITY,
        priority: EVIDENCE_PRIORITY[stackCommitmentGuard.alternativeEstimateType],
        estimateType: stackCommitmentGuard.alternativeEstimateType,
        canOverrideEvidence: false,
        evidenceScope: `${best.action}_STACK_COMMITMENT_WITHIN_BAND`,
        overrideAttempt: `${best.action}_STACK_COMMITMENT`,
        overrideBlockedReason: 'STACK_COMMITMENT_MARGIN_GUARD',
        reasonZh: Object.freeze([
          `量化赢家「${best.action}」会打光筹码：${best.estimateType} EV ${best.ev!.toFixed(2)}` +
            `｜最佳非全下候选「${stackCommitmentGuard.alternativeAction}」` +
            `${stackCommitmentGuard.alternativeEstimateType} EV ${stackCommitmentGuard.alternativeEV.toFixed(2)}` +
            `｜差 ${stackCommitmentGuard.gapChips.toFixed(2)} ≤ 容差带 ±${stackCommitmentGuard.bandChips.toFixed(2)}`,
          stackCommitmentGuard.reasonZh,
          `最终动作 = ${stackCommitmentGuard.alternativeAction}；被拦截的打光动作**仍然保留**在候选表与证据表里（可审计）。`,
        ]),
        stackCommitmentGuard,
      });
    }

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

    // ②-a 清晰边际：低质量证据**不得**覆盖
    if (clear) {
      /*
       * 🔴 **RIVER RAISE DECISION V2：打光筹码的启发式动作没有覆盖权。**
       *
       * 修复前这里是「只要带 `overrideJustification` 就放行」——于是
       * 「一对牌 + 没有加注 EV + 河牌把 87BB 全部推入」也能覆盖
       * `CALL EV = +19.70`（边际 CLEAR）。审计实测（AK 节点）：
       * `evidenceScope = CALL_CLEAR_CALL_OVER_FOLD_OVERRIDDEN`、
       * `overrideBlockedReason = null`。
       *
       * 现在：
       * - **不消耗筹码**的加注仍然可以靠独立论证覆盖（AA 面对 3bet 的价值加注
       *   必须保持可达 —— 见 `ActionEvidence.commitsStack` 的说明）；
       * - **打光筹码**的加注只能走两条路：① 自带可比 EV（那它本来就在
       *   `quantified` 里按 EV 比较）；② 量化证据只到 MARGINAL（`HEURISTIC_TIEBREAK`）。
       */
      const justified =
        strongestHeuristic !== null &&
        strongestHeuristic.action !== best.action &&
        strongestHeuristic.commitsStack !== true &&
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
            `该加注**不消耗筹码**（不是全下）⇒ 允许战略启发式覆盖` +
              `（来源 ${DecisionSourceKind.STRATEGIC_HEURISTIC}；不是 EV 优胜，不得如此呈现）`,
          ]),
        });
      }
      const stackCommitting =
        strongestHeuristic !== null &&
        strongestHeuristic.action !== best.action &&
        strongestHeuristic.commitsStack === true;
      const blocked =
        strongestHeuristic !== null && strongestHeuristic.action !== best.action
          ? {
              attempt: `${strongestHeuristic.action}_HEURISTIC`,
              reason: stackCommitting
                ? `CANNOT_OVERRIDE_CLEAR_SUPPORTED_${best.action}_WITH_UNEVALUATED_ALL_IN`
                : `CANNOT_OVERRIDE_CLEAR_SUPPORTED_${best.action}`,
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
                  '但它的 EV 不可得（HEURISTIC）' +
                  (stackCommitting
                    ? '，而且**会把剩余筹码全部投入**（全下）—— 没有对手继续范围与加注 EV 就无法论证这一押'
                    : '，且**没有**独立论证（MONSTER 强度优势 / 低 SPR 承诺）') +
                  '⇒ **不得覆盖清晰的可比 EV 证据**',
                `overrideBlockedReason = ${blocked.reason}`,
                '⚠️ 被阻断的加注仍是**合法但未评估**的动作：本次动作是「在**可评估**候选之间」的裁决，' +
                  '不是「所有合法动作中的最优解」',
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
