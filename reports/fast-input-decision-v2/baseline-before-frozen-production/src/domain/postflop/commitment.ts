/**
 * **SPR / Stack Commitment**（2026-09 翻后升级 · P1）
 *
 * ## 修的是什么
 *
 * 审计实测：`decisionEngine.ts` 里 `spr` / `effectiveStack` **出现 0 次** ——
 * SPR 只被诊断面板读取（`decisionViewModel.ts:210`）。实测后果：
 *
 * ```text
 * 同一手三条 K、同一牌面、同样动作：
 *   25BB（SPR 2.32） / 100BB（SPR 10.21） / 200BB（SPR 20.74）
 *   三档全部输出 BET 633（67% 底池）—— 动作与尺寸逐位相同
 * ```
 *
 * 而 `SPR ≈ 0.5` 与 `SPR ≈ 20` 是完全不同的策略问题。
 *
 * ## 输出（不直接决定动作）
 *
 * | 输出 | 含义 |
 * |---|---|
 * | `band` | SPR 分档（COMMITTED / LOW / MEDIUM / HIGH / DEEP） |
 * | `commitmentScore` | 0..1：这手牌**值不值得**把剩下的筹码打进去 |
 * | `stackOffAllowed` | 是否允许把「一对级」牌力也纳入 stack-off 考虑（低 SPR 才允许） |
 * | `sizingCap` | 单次下注/加注的尺寸上限（相对底池），高 SPR 下把中等牌力的注限住 |
 *
 * ⚠️ **低 SPR 不等于无脑全下**：`stackOffAllowed` 只说「可以考虑」，
 * 真正的动作仍由 EV 比较与对手范围决定。使用者明确要求
 * 「AA 不能因为出了 J 就机械进入 pot control；Jam 仍必须可以成为高 EV 动作」——
 * 那正是 `stackOffAllowed` 存在的理由。
 */

export const SprBand = {
  /** 筹码几乎已经进去（≤1.5）：承诺已成事实 */
  COMMITTED: 'COMMITTED',
  /** 低 SPR（≤3）：一对级牌力可以打到全下 */
  LOW: 'LOW',
  /** 中 SPR（≤6）：强价值可以承诺，一对级要谨慎 */
  MEDIUM: 'MEDIUM',
  /** 高 SPR（≤12）：一对级应当控制底池 */
  HIGH: 'HIGH',
  /** 极深（>12）：只用手牌质量与坚果级承诺 */
  DEEP: 'DEEP',
} as const;
export type SprBand = (typeof SprBand)[keyof typeof SprBand];

export const SPR_BAND_ZH: Readonly<Record<SprBand, string>> = Object.freeze({
  COMMITTED: '筹码已基本入池',
  LOW: '低 SPR（可承诺）',
  MEDIUM: '中 SPR',
  HIGH: '高 SPR（需控池）',
  DEEP: '极深筹码',
});

export type CommitmentAssessment = {
  band: SprBand;
  bandZh: string;
  spr: number | null;
  commitmentScore: number;
  stackOffAllowed: boolean;
  sizingCap: number;
  /**
   * 🔴 **未来街承诺加分**（【数学确定】· RIVER CONSISTENCY V2）。
   *
   * 在还有牌要发的街上，「筹码已基本入池 ⇒ 以后反正要打光」是一个**真实的
   * 未来街理由**，它让当前跟注/加注更有吸引力。
   *
   * **河牌没有下一街**，这个理由在结构上不存在：
   *
   * ```text
   * street === 'RIVER'  ⇒  futureStreetCommitmentBonus === 0
   * ```
   *
   * 修复前实测（Hero BTN A♣Q♠，河牌面对 22BB 下注）：理由里出现
   * 「SPR 1.09（筹码已基本入池）⇒ 这手牌**可以**纳入 stack-off 考虑」，
   * 而 SPR 低只说明「底池相对筹码很大」，**不能**说明「所以现在该跟」——
   * 河牌的钱打进去就是最后一次投入，它必须由**当前节点**的赔率与牌力决定。
   *
   * SPR 本身仍然保留为**背景信息**（`spr` / `band` / `noteZh`），
   * 只是不再作为未来街承诺的加分项。
   */
  futureStreetCommitmentBonus: number;
  noteZh: string;
};

/**
 * @param potAfterCall 跟注后的底池（用于算「跟注后还剩多少可打」）
 * @param remainingAfterCall 跟注后我的剩余筹码
 * @param relativeRole 相对牌力角色（只有强牌才谈承诺）
 * @param street 当前街（河牌没有未来街 ⇒ 未来街承诺加分恒为 0）
 */
export function assessCommitment(input: {
  spr: number | null;
  remainingAfterCall: number;
  potAfterCall: number;
  /** 是否属于「一对级」牌力（低 SPR 下允许 stack-off，高 SPR 下不允许） */
  onePairOrBetter: boolean;
  /** 相对牌力角色的强度（0..1，越大越强；由角色映射而来） */
  roleStrength: number;
  /** 当前街（省略时按「非河牌」处理；生产路径必须传） */
  street?: string;
}): CommitmentAssessment {
  const spr = input.spr;
  const isRiver = input.street === 'RIVER';
  if (spr === null || !Number.isFinite(spr)) {
    return {
      band: SprBand.MEDIUM,
      bandZh: SPR_BAND_ZH.MEDIUM,
      spr: null,
      commitmentScore: 0,
      stackOffAllowed: false,
      sizingCap: 0.75,
      futureStreetCommitmentBonus: 0,
      noteZh: '底池为 0，SPR 不可计算 —— 不据此做任何承诺判断',
    };
  }

  const band: SprBand =
    spr <= 1.5 ? SprBand.COMMITTED : spr <= 3 ? SprBand.LOW : spr <= 6 ? SprBand.MEDIUM : spr <= 12 ? SprBand.HIGH : SprBand.DEEP;

  /*
   * 承诺分：SPR 越低越容易承诺，牌力越强越愿意承诺。
   * 低 SPR 下即使一对级也能承诺（筹码已经不多）；高 SPR 下只有强牌才谈承诺。
   */
  const sprFactor = Math.max(0, Math.min(1, 1 - (spr - 1.5) / 18));
  const commitmentScore = Math.max(
    0,
    Math.min(1, 0.55 * sprFactor + 0.45 * Math.max(0, Math.min(1, input.roleStrength))),
  );

  const stackOffAllowed =
    band === SprBand.COMMITTED ||
    (band === SprBand.LOW && input.onePairOrBetter) ||
    (band === SprBand.MEDIUM && input.roleStrength >= 0.75);

  /*
   * 尺寸上限：高 SPR 下把中等牌力的单次下注限住（避免用一对把底池做大到失控）；
   * 低 SPR 下允许更大（承诺本来就要发生）。
   */
  const sizingCap =
    band === SprBand.COMMITTED || band === SprBand.LOW
      ? 2.5
      : band === SprBand.MEDIUM
        ? 1.5
        : band === SprBand.HIGH
          ? 1.0
          : 0.75;

  /*
   * 🔴 未来街承诺加分：**河牌恒为 0**。
   *
   * 非河牌时它由「SPR 低 + 牌力够」给出（最多 0.2），代表
   * 「后面还有街，筹码已经不多 ⇒ 早晚要打光」这个**未来**理由。
   * 河牌没有未来街，因此这里不给任何加分，理由文本也改成如实说明。
   */
  const futureStreetCommitmentBonus =
    isRiver || !stackOffAllowed ? 0 : Math.max(0, Math.min(0.2, (3 - spr) / 15));

  const noteZh = isRiver
    ? `SPR ${spr.toFixed(2)}（${SPR_BAND_ZH[band]}）—— 河牌**没有下一街**，` +
      'SPR 只作背景信息：本次跟注/加注必须由当前节点的赔率与牌力决定，不构成「以后反正要打光所以现在该跟」的理由'
    : stackOffAllowed
      ? `SPR ${spr.toFixed(2)}（${SPR_BAND_ZH[band]}）⇒ 这手牌**可以**纳入 stack-off 考虑（仍需 EV 比较）`
      : `SPR ${spr.toFixed(2)}（${SPR_BAND_ZH[band]}）⇒ 不建议用当前牌力把筹码全部打进去`;

  return {
    band,
    bandZh: SPR_BAND_ZH[band],
    spr,
    commitmentScore,
    stackOffAllowed,
    sizingCap,
    futureStreetCommitmentBonus,
    noteZh,
  };
}

/** 跟注后还剩多少可打（真实 SPR，而不是「当前底池」口径） */
export function realSprAfterCall(
  remainingStack: number,
  callCost: number,
  potAfterCall: number,
): number | null {
  if (potAfterCall <= 0) return null;
  const remaining = Math.max(0, remainingStack - callCost);
  return remaining / potAfterCall;
}
