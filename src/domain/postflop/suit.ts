/**
 * 花色 / 点数的小工具（翻后模块共用）
 *
 * ⚠️ 与 `poker/cards.ts` 的分工：那里是**索引与规范化**（`cardIndex` / `cardKey`），
 * 这里是**花色序号**（0..3，用于数组计数）。花色序号只在本模块内部使用，
 * 不做任何跨模块传递，避免出现第二套「花色编码」。
 */

import type { Card } from '../types.ts';

/** 花色序号：s=0, h=1, d=2, c=3（与 `Card.suit` 的联合类型一一对应） */
export const SUIT_ORDER = ['s', 'h', 'd', 'c'] as const;

export function suitIndexOfCard(card: Card): number {
  const index = SUIT_ORDER.indexOf(card.suit);
  return index < 0 ? 0 : index;
}
