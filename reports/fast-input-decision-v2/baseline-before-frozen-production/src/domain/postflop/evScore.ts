/**
 * **动作评分与置信度**（2026-09 翻后升级 · P1 收口）
 *
 * ## 两个使用者点名的纪律
 *
 * ### 1. 禁止伪精确 EV
 *
 * 本项目没有完整 solver 树，因此**不得**输出 `BET EV = +17.43BB`。
 * 这里只输出 **0..1 的启发式比较分**（`normalizedEVScore`），并附
 * `NOT_SOLVER_EV` 标记 —— 界面必须如实说明它是内部比较分数。
 *
 * ### 2. 置信度的定义
 *
 * ```text
 * confidence ≠ 牌有多强
 * confidence = 首选动作比第二选择好多少
 * ```
 *
 * 因此 `confidenceOf` 只看**两个最高分之间的差**，与牌力无关。
 *
 * ## 动作与尺度分离（使用者第十五节）
 *
 * ```text
 * 第一步：BET / CHECK / CALL / RAISE / FOLD   ← 本模块的 evRanking
 * 第二步：25% / 33% / 50% / 67% / 75% / 100% / 全下   ← sizing.ts（独立）
 * ```
 */

export const ActionScoreKind = {
  FOLD: 'FOLD',
  CHECK: 'CHECK',
  CALL: 'CALL',
  BET_SMALL: 'BET_SMALL',
  BET_MEDIUM: 'BET_MEDIUM',
  BET_LARGE: 'BET_LARGE',
  RAISE: 'RAISE',
  ALL_IN: 'ALL_IN',
} as const;
export type ActionScoreKind = (typeof ActionScoreKind)[keyof typeof ActionScoreKind];

export type ActionScore = {
  action: ActionScoreKind;
  /** 0..1 启发式比较分（**不是** solver EV，**不是**货币期望） */
  normalizedEVScore: number;
};

export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';

export const CONFIDENCE_ZH: Readonly<Record<Confidence, string>> = Object.freeze({
  LOW: '低（首选与次选接近）',
  MEDIUM: '中',
  HIGH: '高（首选明显优于其他）',
});

/** 分数差 → 置信度（**只反映「首选比次选好多少」**） */
export function confidenceOf(scores: readonly ActionScore[]): { level: Confidence; gap: number } {
  if (scores.length < 2) {
    return { level: 'LOW', gap: 0 }; // 无可比对象 ⇒ 不声称确信
  }
  const sorted = [...scores].sort((a, b) => b.normalizedEVScore - a.normalizedEVScore);
  const gap = sorted[0]!.normalizedEVScore - sorted[1]!.normalizedEVScore;
  return {
    level: gap >= 0.15 ? 'HIGH' : gap >= 0.06 ? 'MEDIUM' : 'LOW',
    gap: Number(gap.toFixed(4)),
  };
}

/** EV 排序（降序），供界面显示「偏好顺序」而不是假 EV 数字 */
export function rankActions(scores: readonly ActionScore[]): readonly ActionScore[] {
  return Object.freeze([...scores].sort((a, b) => b.normalizedEVScore - a.normalizedEVScore));
}

/** 人类可读的偏好顺序：`CHECK > BET_SMALL > BET_LARGE` */
export function preferenceZh(scores: readonly ActionScore[]): string {
  return rankActions(scores)
    .map((s) => s.action)
    .join(' > ');
}

/** 伪精确 EV 的禁令标记（与分数一起输出，界面必须显示） */
export const EV_SCORE_DISCLAIMER_ZH =
  '⚠️ 以上是**内部启发式比较分**（0..1），用于排序与置信度判断；' +
  '本项目没有完整求解器树，因此**不是** solver EV，也**不是**货币期望值。';
