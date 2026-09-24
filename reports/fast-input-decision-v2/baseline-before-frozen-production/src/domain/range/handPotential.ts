/**
 * 手牌潜力（hand potential）—— 玩家画像调整用的**启发式**强度标尺
 *
 * ## 为什么需要这个文件
 *
 * 画像调整要回答一个问题：对手的**哪一端**范围在变宽/变窄？
 * 松的对手多玩的是 72o、J4s 这类弱牌；紧的对手放弃的也是这些牌。
 * 因此需要一个「起手牌相对强弱」的连续标尺。
 *
 * ## 这里的数值不是胜率，也绝不是 GTO 频率
 *
 * `potential` 是一个 **0..1 的启发式排序标尺**，只用于比较
 * 「A 组合比 B 组合更强」，**不用于任何概率计算**。
 * 真正的胜率一律由 `equity` 引擎枚举/模拟得出。
 *
 * 之所以显式写明这一点：把启发式标尺误当成胜率是本项目最容易犯的
 * 「编造数据」错误之一（规范第十四节的禁令）。
 */

import type { Rank } from '../types.ts';
import type { ExactCombo } from './combo.ts';
import { Suitedness } from './combo.ts';

/**
 * 单张牌的基础价值（0..1，A 最高）。
 *
 * 用平方而非线性：扑克中牌力的差距是非线性的 ——
 * A 与 K 之间的差距远大于 7 与 6 之间的差距。
 */
function rankValue(rank: Rank): number {
  const normalized = (rank - 2) / 12; // 2 → 0, A → 1
  return normalized * normalized;
}

/**
 * 起手牌潜力，0..1。
 *
 * 组成因素（全部为公开扑克常识，无 solver 输出）：
 * - 对子：额外加成（对子天然有一手成牌潜力）
 * - 同花：额外加成（提升同花与顺子听牌质量）
 * - 连张：额外加成（提升顺子潜力）
 * - 高张：主导权重
 */
export function comboPotential(combo: ExactCombo): number {
  const [high, low] = combo.ranks;
  const isPair = high === low;

  // 高张主导（平方后取平均，避免小连张被高估）
  const highScore = rankValue(high);
  const lowScore = rankValue(low);
  let score = 0.68 * highScore + 0.22 * lowScore;

  if (isPair) {
    // 对子：以低张价值为基准，再给固定加成
    score = 0.35 + 0.65 * lowScore;
    score += 0.06;
  } else {
    // 连张加成：间隔越小越好（A2 不算连张，因为顺子要绕一圈）
    const gap = high - low;
    if (gap <= 4) {
      const gapBonus = (5 - gap) / 5; // 1 → 0.8, 4 → 0.2
      score += 0.07 * gapBonus * (1 - highScore * 0.5);
    }
    if (combo.suitedness === Suitedness.SUITED) score += 0.07;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * 把 potential 转成「弱牌程度」(−1..1)：弱牌为正，强牌为负。
 *
 * 以 0.45 为中立点（略低于 0.5，因为大多数起手牌偏弱）。
 */
export function weaknessOf(potential: number): number {
  const centered = (0.45 - potential) / 0.45;
  return Math.max(-1, Math.min(1, centered));
}

/** 组合 → potential 的缓存（1326 个组合的映射是纯函数，可安全缓存） */
const potentialCache = new Map<string, number>();

export function potentialOfComboId(combo: ExactCombo): number {
  const cached = potentialCache.get(combo.canonicalId);
  if (cached !== undefined) return cached;
  const value = comboPotential(combo);
  potentialCache.set(combo.canonicalId, value);
  return value;
}
