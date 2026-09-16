/**
 * **Multiway Penalty**（2026-09 翻后升级 · P1）
 *
 * ## 修的是什么
 *
 * 审计实测：`realizedOpponentCount` 在决策层的**唯一数值作用**是把范围可信度
 * 门槛从 0.15 提到 0.25，而启发式先验本身是 0.3 ⇒ 几乎不触发。
 * 实测后果：单挑（权益 88.9%）与 3 人池（权益 70.8%）给出**同一个
 * `BET 50% 底池`**，只多一条降级文案。
 *
 * ## 原则（使用者给定）
 *
 * 人数越多：**诈唬减少、薄价值减少、继续范围平均强度上升、坚果密度上升**。
 *
 * ## 但**不许**简单「人多 ⇒ 过牌」
 *
 * 因此本模块只产出**单调的阈值/分数修正**，动作仍由 EV 比较决定：
 *
 * | 输出 | 含义 |
 * |---|---|
 * | `multiwayStrengthPenalty` | 相对牌力的**惩罚**（0..1，0 = 单挑） |
 * | `multiwayBluffPenalty` | 诈唬价值的惩罚（比强度惩罚更陡） |
 * | `multiwayValueThresholdAdjustment` | 价值下注所需的**权益门槛抬高量** |
 * | `equityThresholdShift` | 角色分档用的门槛偏移（与上一条同源，供 `relativeHandRole` 复用） |
 */

export type MultiwayAdjustment = {
  opponentCount: number;
  multiwayStrengthPenalty: number;
  multiwayBluffPenalty: number;
  multiwayValueThresholdAdjustment: number;
  equityThresholdShift: number;
};

/**
 * 惩罚是**人数**的单调函数，且**收益递减**（第 3 家带来的变化远大于第 5 家）。
 *
 * ```text
 * 1 家 ⇒ 0        2 家 ⇒ 0.10     3 家 ⇒ 0.18
 * 4 家 ⇒ 0.24     5 家 ⇒ 0.29     6 家 ⇒ 0.33
 * ```
 */
export function multiwayAdjustment(opponentCount: number): MultiwayAdjustment {
  const extra = Math.max(0, opponentCount - 1);
  if (extra === 0) {
    return {
      opponentCount,
      multiwayStrengthPenalty: 0,
      multiwayBluffPenalty: 0,
      multiwayValueThresholdAdjustment: 0,
      equityThresholdShift: 0,
    };
  }
  // 0.42 * (1 - 1/(1 + 0.9*extra)) —— 单调、上凸、有界（≤0.42）
  const strength = 0.42 * (1 - 1 / (1 + 0.9 * extra));
  /*
   * 诈唬的惩罚更陡：多一个人就多一个「可能跟注」的人，
   * 弃牌率是**连乘**下降的，而价值只被稀释。
   */
  const bluff = Math.min(0.75, 0.42 * (1 - 1 / (1 + 1.6 * extra)));
  return {
    opponentCount,
    multiwayStrengthPenalty: Number(strength.toFixed(4)),
    multiwayBluffPenalty: Number(bluff.toFixed(4)),
    multiwayValueThresholdAdjustment: Number((strength * 0.35).toFixed(4)),
    equityThresholdShift: Number((strength * 0.25).toFixed(4)),
  };
}

/** 便利函数：价值下注所需权益门槛（= 角色分档门槛 + 多人抬高量） */
export function valueThresholdWithMultiway(baseThreshold: number, opponentCount: number): number {
  return baseThreshold + multiwayAdjustment(opponentCount).multiwayValueThresholdAdjustment;
}
