/**
 * 🔴 **牌面相对强度**（2026-09 翻后升级 · C3）
 *
 * ## 为什么需要它
 *
 * 审计确认：修复前**范围完全不随牌面变化** —— 公共牌只被当「死牌」删组合，
 * 组合权重只由**翻前牌型档**决定。独立复算的证据：
 *
 * ```text
 * 同花完成的板面上，38 个同花类组合的概率比 = 1.000000000
 *   p(A♣Q♣) = p(A♠Q♠) = p(A♥Q♥) = p(A♦Q♦)
 * ♣♣ 总质量：同花完成的板 5.64%  vs  不可能有同花的板 7.08%
 *   （完成同花之后权重反而更低 —— 因为 T♣ 只是被当成死牌删掉了组合）
 * ```
 *
 * 后果：任何「同花完成 ⇒ 他的范围里同花变多」的判断在数据上**没有依据**。
 *
 * ## 这一层做什么
 *
 * 把「这手具体的两张底牌 + 当前公共牌」映射到一个 **0..5 的相对强度档**
 *（0 = 最强、5 = 垃圾），用于给范围更新选似然权重：
 *
 * | 档 | 形态 | 理由 |
 * |---|---|---|
 * | 0 | 同花顺 / 四条 / 葫芦 | 绝对坚果级 |
 * | 1 | 同花 / 顺子 / 暗三条 / 三条 | 强成手 |
 * | 2 | 顶两对 / 两对 / 超对 / 顶对 | 强价值 |
 * | 3 | 中对 | 中等成手 |
 * | 4 | 底对 / 小对子 | 边缘成手 |
 * | 5 | 高牌 | 无对 |
 *
 * ## ⚠️ 三条纪律
 *
 * 1. **不是胜率、不是频率**：它只是**排序标尺**，与 `handPotential` 的定位相同。
 *    真正的胜率一律由 `equity` 引擎算出（见规范第十四节禁令）。
 * 2. **不重复实现牌力判定**：形态来自既有的 `describeHand`（单一事实来源），
 *    本模块只做「形态 → 档位」的映射。
 * 3. **牌面不足 3 张时返回 `null`**（翻前）—— 调用方必须回落到翻前的牌型档，
 *    从而保证翻前行为**逐位不变**。
 *
 * ## 本版**刻意不做**的事
 *
 * 听牌（同花听牌 / 两头顺 / 卡顺）**尚未计入**档位：`describeHand` 描述的是
 * **已成牌**，而听牌质量需要单独的模型（属于 Board Delta 轮次）。
 * 现阶段的直接后果：**已经成花/成顺**的牌会被正确提档，
 * 但「还没成、正在听」的牌仍按成手档处理。
 * 这是**已知的阶段性缺口**，不是被忽略的错误。
 */

import type { Card } from '../types.ts';
import { describeHand, type HandShape } from './handDescription.ts';

/** 形态 → 0..5 相对强度档（0 最强）。映射是**结构性判断**，不是估出的参数。 */
export function boardRelativeTierOfShape(shape: HandShape): number {
  switch (shape) {
    case 'STRAIGHT_FLUSH':
    case 'QUADS':
    case 'FULL_HOUSE':
      return 0;
    case 'FLUSH':
    case 'STRAIGHT':
    case 'SET':
    case 'TRIPS':
      return 1;
    case 'TWO_PAIR':
    case 'TOP_TWO_PAIR':
    case 'OVERPAIR':
    case 'OVERPAIR_TOP':
    case 'TOP_PAIR':
    case 'POCKET_PAIR_OVER':
      return 2;
    case 'MIDDLE_PAIR':
      return 3;
    case 'BOTTOM_PAIR':
    case 'UNDERPAIR':
      return 4;
    case 'HIGH_CARD':
    case 'PLAY_THE_BOARD':
      return 5;
    default: {
      // 穷尽性由类型保证；运行时兜底为「垃圾档」而不是崩溃
      const exhaustive: never = shape;
      void exhaustive;
      return 5;
    }
  }
}

/**
 * 这手牌在**当前牌面**上的相对强度档（0..5）。
 *
 * @returns `null` 表示牌面不足 3 张（翻前）—— 调用方应回落到翻前牌型档。
 */
export function boardRelativeTierOf(
  holeCards: readonly Card[],
  board: readonly Card[],
): number | null {
  if (board.length < 3) return null;
  if (holeCards.length !== 2) return null;
  try {
    return boardRelativeTierOfShape(describeHand([holeCards[0]!, holeCards[1]!], board).shape);
  } catch {
    // `describeHand` 对畸形输入会抛错；这里是**排序标尺**，
    // 与其崩溃不如如实退回「垃圾档」，由调用方的可靠度标记去表达不确定性。
    return 5;
  }
}
