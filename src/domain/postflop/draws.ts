/**
 * 听牌检测（2026-09 翻后升级 · P1）
 *
 * ## 为什么单独一个文件
 *
 * 「听牌」与「成手」是两件事：`describeHand` 描述**已成牌**，
 * 而翻后决策必须知道「还没成、但补牌在追」的牌 —— 否则
 * 半诈唬会被误判成纯空气，听牌被误判成垃圾。
 *
 * ⚠️ 这里输出的是**补牌计数**（outs），不是胜率。
 * 胜率一律由 `equity` 引擎算出（规范第十四节禁止拿启发式标尺冒充胜率）。
 */

import type { Card } from '../types.ts';
import { suitIndexOfCard } from './suit.ts';

export type DrawProfile = {
  flushDraw: boolean;
  openEnded: boolean;
  gutshot: boolean;
  /** 大致的补牌数（**只用于排序**，不是胜率） */
  outs: number;
};

/** 各花色计数，索引与 `SUIT_ORDER` 一致 */
export function suitCountsOf(cards: readonly Card[]): readonly number[] {
  const counts = [0, 0, 0, 0];
  for (const card of cards) counts[suitIndexOfCard(card)] += 1;
  return counts;
}

/** 点数集合 */
export function rankSetOf(cards: readonly Card[]): ReadonlySet<number> {
  return new Set(cards.map((c) => c.rank));
}

/** 听牌剖面：`holeCards` 2 张 + `board` 3..5 张 */
export function drawProfileOf(
  holeCards: readonly Card[],
  board: readonly Card[],
): DrawProfile {
  if (holeCards.length !== 2 || board.length < 3) {
    return { flushDraw: false, openEnded: false, gutshot: false, outs: 0 };
  }

  const all = [...holeCards, ...board];

  // ---- 同花听牌：四张同花色（且不是已经成花）----
  const suitCounts = suitCountsOf(all);
  const maxSuit = Math.max(...suitCounts);
  const flushMade = maxSuit >= 5;
  const flushDraw = !flushMade && maxSuit === 4;

  // ---- 顺子听牌：用「点数是否构成 4 连/3 连」判断 ----
  const present = new Set<number>(all.map((c) => c.rank));
  if (present.has(14)) present.add(1); // A 可作 1（A2345）

  /** 是否存在 5 连 */
  const hasFive = (): boolean => {
    for (let start = 1; start <= 10; start += 1) {
      let ok = true;
      for (let step = 0; step < 5; step += 1) if (!present.has(start + step)) ok = false;
      if (ok) return true;
    }
    return false;
  };
  /** 补一张就能成 5 连的点数个数（= 卡顺/两头顺的补牌点数） */
  const completingRanks = (): number[] => {
    const out: number[] = [];
    for (let rank = 1; rank <= 14; rank += 1) {
      if (present.has(rank)) continue;
      present.add(rank);
      if (hasFive()) out.push(rank);
      present.delete(rank);
    }
    return out;
  };

  if (hasFive()) {
    // 已成顺子 ⇒ 不是听牌
    return {
      flushDraw,
      openEnded: false,
      gutshot: false,
      outs: (flushDraw ? 9 : 0),
    };
  }

  const completing = completingRanks();
  const openEnded = completing.length >= 2;
  const gutshot = completing.length === 1;

  /*
   * 补牌数（结构性计数，不是胜率）：
   *   同花听牌 9 张；两头顺 8 张（两个点数各 4 张）；卡顺 4 张。
   * ⚠️ 不做「扣除已知牌/对手持牌」的精细调整 —— 那会假装精确。
   */
  const straightOuts = openEnded ? 8 : gutshot ? 4 : 0;
  const outs = Math.min(15, straightOuts + (flushDraw ? 9 : 0));

  return { flushDraw, openEnded, gutshot, outs };
}
