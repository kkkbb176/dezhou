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

import { ALL_CARDS, type Card } from '../types.ts';
import { suitIndexOfCard } from './suit.ts';

export type DrawProfile = {
  flushDraw: boolean;
  openEnded: boolean;
  gutshot: boolean;
  /** 大致的补牌数（**只用于排序**，不是胜率） */
  outs: number;
};

/**
 * 🔴 **补牌审计**（TEST HAND MULTIWAY TURN FIX · 问题 2/3）：
 * 把「改善我的牌」的牌分成四个桶，**互相不重复**。
 *
 * ```text
 * RAW_OUT         所有能改善我牌力的牌（并集，不重复计数）
 * CLEAN_OUT       干净补牌：无论如何都是坚果级或接近坚果（非花色的顺子补牌）
 * DISCOUNTED_OUT  打折补牌：能改善我，但对手可能有更好的同款（非坚果同花补牌、
 *                 可能让对手成顺的两对/三条补牌）
 * DIRTY_OUT       脏补牌：改善我但**更可能**改善他的牌（成对牌面上的踢脚补牌等）
 * ```
 *
 * ⚠️ 纪律（使用者 §8）：**禁止**把 raw out 数直接换成胜率（`outs × 2%` 那种）。
 * 这里只输出**结构计数与理由**，胜率一律由权益引擎给出。
 */
export type OutAudit = {
  rawOuts: number;
  cleanOuts: number;
  discountedOuts: number;
  dirtyOuts: number;
  /** 被重复计算的牌（同时属于顺子与同花补牌）—— 只统计一次，但要报出来 */
  doubleCounted: readonly string[];
  /** 非坚果同花听：成花也可能输给更大的花 ⇒ 同花补牌进 DISCOUNTED */
  nonNutFlushDraw: boolean;
  notesZh: readonly string[];
};

const RANK_LABEL: Readonly<Record<number, string>> = Object.freeze({
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: 'T',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A',
});

/** 逐张牌的补牌审计（`hole` 2 张 + `board` 3..5 张） */
export function outAuditOf(holeCards: readonly Card[], board: readonly Card[]): OutAudit {
  if (holeCards.length !== 2 || board.length < 3) {
    return {
      rawOuts: 0,
      cleanOuts: 0,
      discountedOuts: 0,
      dirtyOuts: 0,
      doubleCounted: [],
      nonNutFlushDraw: false,
      notesZh: ['牌面或手牌不足 ⇒ 不做补牌审计'],
    };
  }
  const seen = new Set<string>([...holeCards, ...board].map((c) => `${c.rank}${c.suit}`));
  const presentRanks = new Set<number>([...holeCards, ...board].map((c) => c.rank));
  if (presentRanks.has(14)) presentRanks.add(1);

  const makesFive = (ranks: Set<number>): boolean => {
    for (let start = 1; start <= 10; start += 1) {
      let ok = true;
      for (let step = 0; step < 5; step += 1) if (!ranks.has(start + step)) ok = false;
      if (ok) return true;
    }
    return false;
  };

  const suitCounts = suitCountsOf([...holeCards, ...board]);
  const flushSuit = suitCounts.findIndex((n) => n === 4);
  const flushDraw = flushSuit >= 0;
  // 非坚果同花听：我手里该花色的最大点**小于**未见过的更大点数 ⇒ 成花可能被更大同花压住
  const myFlushTop = Math.max(
    0,
    ...holeCards.filter((c) => suitIndexOfCard(c) === flushSuit).map((c) => c.rank),
  );
  const unseenBigger = [...Array(15).keys()]
    .filter((r) => r > myFlushTop && r >= 2)
    .some((r) => ![...holeCards, ...board].some((c) => c.rank === r && suitIndexOfCard(c) === flushSuit));
  const nonNutFlushDraw = flushDraw && unseenBigger;

  const straightOuts: string[] = [];
  const flushOuts: string[] = [];
  const improvementOuts: string[] = [];
  const holeRanks = holeCards.map((c) => c.rank);
  /*
   * 逐张**真实存在的牌**遍历（用 `ALL_CARDS` 而不是自己拼 rank+suit 字符串，
   * 避免 rank 的字面量与内部数值编码不一致）。
   * ⚠️ V1 限制：A2345 的「轮子」补牌只处理 A 已出现的情形，未单独枚举。
   */
  for (const card of ALL_CARDS) {
    const key = `${card.rank}${card.suit}`;
    if (seen.has(key)) continue;
    const ranks = new Set(presentRanks);
    ranks.add(card.rank);
    if (makesFive(ranks)) straightOuts.push(key);
    if (flushDraw && suitIndexOfCard(card) === flushSuit) flushOuts.push(key);
    if (holeRanks.includes(card.rank)) improvementOuts.push(key);
  }

  const straightSet = new Set(straightOuts);
  const flushSet = new Set(flushOuts);
  const doubleCounted = [...straightSet].filter((k) => flushSet.has(k));
  const pairSet = new Set(improvementOuts);
  const rawSet = new Set([...straightSet, ...flushSet, ...pairSet]);
  // 干净 = 非花色的顺子补牌（成顺且不依赖同花）
  const cleanSet = new Set(
    [...straightSet].filter((k) => !flushSet.has(k)),
  );
  const dirtySet = new Set([...pairSet].filter((k) => !straightSet.has(k) && !flushSet.has(k)));
  const discountedSet = new Set(
    [...rawSet].filter((k) => !cleanSet.has(k) && !dirtySet.has(k)),
  );

  const labelOf = (key: string): string => `${RANK_LABEL[Number(key.slice(0, -1))] ?? '?'}${key.slice(-1)}`;
  return {
    rawOuts: rawSet.size,
    cleanOuts: cleanSet.size,
    discountedOuts: discountedSet.size,
    dirtyOuts: dirtySet.size,
    doubleCounted: Object.freeze(doubleCounted.map(labelOf)),
    nonNutFlushDraw,
    notesZh: Object.freeze([
      `RAW ${rawSet.size} = 顺子补牌 ${straightSet.size} ∪ 同花补牌 ${flushSet.size} ∪ 成对补牌 ${pairSet.size}` +
        `（其中 ${doubleCounted.map(labelOf).join('/') || '无'} 同时属于顺子与同花，**只计一次**）`,
      `CLEAN ${cleanSet.size}（非花色的顺子补牌）｜DISCOUNTED ${discountedSet.size}` +
        `${nonNutFlushDraw ? '（非坚果同花听：成花也可能输给更大的花）' : ''}｜DIRTY ${dirtySet.size}（成对补牌：改善我但可能同时给对手更強的成牌）`,
      '⚠️ 这些是**结构计数**，不是胜率 —— 胜率由权益引擎给出（禁止 outs × 2% 那类换算）',
    ]),
  };
}

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
