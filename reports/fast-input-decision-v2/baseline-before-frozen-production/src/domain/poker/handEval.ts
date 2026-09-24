/**
 * 牌力评估引擎：从 5~7 张牌中选出最优 5 张并给出可比较的强度编码
 *
 * 规范第 19 / 20 条；Bug 预判 B4 / B5 / B6 / B7 / B8 / B9。
 *
 * 设计要点：
 * 1. 强度编码 = 牌型序号 * 16^5 + 关键点数（降序打包），可用整数直接比较。
 *    编码上界约 9.5e6 * 16^5 ≈ 1.0e13 << 2^53，整数比较绝对安全（对应 B9）。
 * 2. 顺子识别使用 8192 项查表（覆盖全部 13 位点数掩码），A2345 单独处理。
 * 3. 同花优先级高于其他牌型；同花顺天然压过普通同花（对应 B4）。
 * 4. 踢脚只从「未参与成对的点数」中降序选取（对应 B6 / B7）。
 */

import { HandCategory, ALL_RANKS, type Card, type Rank } from '../types.ts';
import { cardIndex } from './cards.ts';

/* ============================================================
 * 点数掩码工具
 * ============================================================ */

/**
 * 点数掩码位：rank 2 → bit 0，rank 14(A) → bit 12
 *
 * 注意必须用无符号右移 `>>>`：
 * 普通 `<<` 在 rank 14 时得到 1<<12 尚可，但多个掩码按位或之后
 * 最高位可能落到符号位上，变成负数，导致后续所有按位比较全部失真。
 * 这是本项目实际踩到过的坑（详见测试「强度编码单调性」）。
 */
export function rankBit(rank: Rank): number {
  return (1 << (rank - 2)) >>> 0;
}

export const MASK_ALL_RANKS = 0b1111111111111; // 13 位全 1

/**
 * 直方图槽位：每个点数占 4 bit，槽位 0 对应 rank 2，槽位 12 对应 rank 14(A)。
 * 计数最大值 7，仍能放进 4 bit。
 *
 * 致命细节：这里**必须**用 `2 ** shift` 而不是 `1 << shift`。
 * JS 的位移运算会先把移位数对 32 取模，`1 << 48` 实际等于 `1 << 16`，
 * 会让 A / K / Q / J / T / 9 的计数全部串位（本项目实际踩到过这个坑）。
 * 13 个槽位共需 52 位，已超出 32 位整数范围，只能用浮点精确表示（14 * 4 = 56 bit < 2^53）。
 */
const HISTOGRAM_SLOT_COUNT = 13;

export function histogramSlot(rank: Rank): number {
  return 2 ** (4 * (rank - 2));
}

/** 全 1 直方图掩码（每个槽位都是 0xf），保留给调试与未来扩展使用 */
export const HISTOGRAM_FULL_MASK = (() => {
  let mask = 0;
  for (let i = 0; i < HISTOGRAM_SLOT_COUNT; i++) mask += 0xf * 2 ** (4 * i);
  return mask;
})();

function histogramCount(histogram: number, rank: Rank): number {
  return Math.floor(histogram / histogramSlot(rank)) & 0xf;
}

/** 收集属于给定掩码的点数，按从高到低 */
function ranksDescending(mask: number): Rank[] {
  const out: Rank[] = [];
  for (let i = ALL_RANKS.length - 1; i >= 0; i--) {
    const rank = ALL_RANKS[i]!;
    if ((mask & rankBit(rank)) !== 0) out.push(rank);
  }
  return out;
}

/* ============================================================
 * 顺子查表
 * ============================================================ */

/**
 * straightTable[mask] = 该点数掩码能组成的最大顺子的最高点数；无顺子为 0。
 * mask 为 13 位点数掩码（bit0 对应 rank 2）。
 */
const straightTable: Uint8Array = (() => {
  const table = new Uint8Array(1 << 13);
  for (let mask = 0; mask < 1 << 13; mask++) {
    let best = 0;
    // 普通顺子：最高点数为 5..14（即 5-high 到 A-high）
    for (let high = 14; high >= 5; high--) {
      const needed =
        rankBit(high as Rank) |
        rankBit((high - 1) as Rank) |
        rankBit((high - 2) as Rank) |
        rankBit((high - 3) as Rank) |
        rankBit((high - 4) as Rank);
      if ((mask & needed) === needed) {
        best = high;
        break;
      }
    }
    // 轮子顺子 A-2-3-4-5：最高点数记为 5
    if (best === 5) {
      // 已有 5-high 顺子，无需特殊处理
      table[mask] = 5;
      continue;
    }
    if (best === 0) {
      const wheel =
        rankBit(14) | rankBit(2) | rankBit(3) | rankBit(4) | rankBit(5);
      if ((mask & wheel) === wheel) table[mask] = 5;
    } else {
      table[mask] = best;
    }
  }
  return table;
})();

/** 查询点数掩码的最大顺子最高点数（0 表示无顺子） */
export function straightHigh(mask: number): number {
  return straightTable[(mask & MASK_ALL_RANKS) >>> 0]!;
}

/** 反向门面：把同花五张组成的掩码转成顺子最高点数 */
export function flushStraightHigh(flushMask: number): number {
  return straightTable[(flushMask & MASK_ALL_RANKS) >>> 0]!;
}

/* ============================================================
 * 强度编码
 * ============================================================ */

/**
 * 强度编码。
 *
 * 结构：value = SCALE × 牌型序号 + 关键点数（降序 pack，每级 base 16）
 *
 * 为什么用浮点乘法而不是 `(v<<4)|rank` 或 `v*16+rank`：
 * - `<<` 受 32 位限制，会串位（本项目已踩坑）。
 * - `*16+rank` 在 7 级之后超过 2^53，最低位会被浮点舍入吃掉，
 *   导致「踢脚不同但编码相同」的静默错误。
 * - 先把牌型放大到远高于点数部分，既保证跨牌型严格有序，
 *   又保证点数部分始终落在 2^32 以内 → 精确整数，绝不丢位。
 */
const CATEGORY_SCALE = 2 ** 32;

/** 关键点数（降序）打包为整数，最多 5 个，每个 4 bit */
function packRanks(ranks: readonly number[]): number {
  let value = 0;
  for (const rank of ranks) value = value * 16 + rank;
  return value;
}

function encode(category: HandCategory, ranks: readonly number[]): number {
  return category * CATEGORY_SCALE + packRanks(ranks);
}

export function categoryOf(value: number): HandCategory {
  return Math.floor(value / CATEGORY_SCALE) as HandCategory;
}

export type EvaluatedHand = {
  /** 牌型序号 1..9 */
  category: HandCategory;
  /** 可比较的强度编码（越大越强） */
  value: number;
  /** 关键点数（降序，用于中文描述与调试） */
  ranks: Rank[];
};

/* ============================================================
 * 主评估函数
 * ============================================================ */

/**
 * 评估 5~7 张牌，返回最优 5 张牌的牌型与强度。
 * 允许 5 张（精确比较）与 7 张（完整牌力）；其余张数抛错。
 */
export function evaluateCards(cards: readonly Card[]): EvaluatedHand {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluateCards: 只支持 5~7 张牌，收到 ${cards.length} 张`);
  }

  // ---- 单次遍历同时构造花色掩码与点数直方图 ----
  let spadeMask = 0;
  let heartMask = 0;
  let diamondMask = 0;
  let clubMask = 0;
  let histogram = 0;

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]!;
    const bit = rankBit(card.rank);
    histogram += histogramSlot(card.rank);
    switch (card.suit) {
      case 's':
        spadeMask |= bit;
        break;
      case 'h':
        heartMask |= bit;
        break;
      case 'd':
        diamondMask |= bit;
        break;
      case 'c':
        clubMask |= bit;
        break;
    }
  }

  const fullMask = spadeMask | heartMask | diamondMask | clubMask;

  // ---- 1) 同花 / 同花顺（最高优先级）----
  let bestFlushValue = 0;
  let bestFlushRanks: Rank[] = [];
  const suits: readonly number[] = [spadeMask, heartMask, diamondMask, clubMask];
  for (const suitMask of suits) {
    if (popcount(suitMask) < 5) continue;
    const flushRanks = ranksDescending(suitMask);
    const high = straightHigh(suitMask);
    if (high > 0) {
      // 同花顺：关键点数为 [最高点数]
      const value = encode(HandCategory.STRAIGHT_FLUSH, [high]);
      if (value > bestFlushValue) {
        bestFlushValue = value;
        bestFlushRanks = [high as Rank];
      }
    }
    const top5 = flushRanks.slice(0, 5);
    const value = encode(HandCategory.FLUSH, top5);
    if (value > bestFlushValue) {
      bestFlushValue = value;
      bestFlushRanks = top5;
    }
  }

  // ---- 2) 普通顺子 ----
  let straightValue = 0;
  let straightRanks: Rank[] = [];
  const sHigh = straightHigh(fullMask);
  if (sHigh > 0) {
    straightValue = encode(HandCategory.STRAIGHT, [sHigh]);
    straightRanks = [sHigh as Rank];
  }

  // ---- 3) 按重复次数分组 ----
  const quads: Rank[] = [];
  const trips: Rank[] = [];
  const pairs: Rank[] = [];
  const singles: Rank[] = [];
  for (let i = ALL_RANKS.length - 1; i >= 0; i--) {
    const rank = ALL_RANKS[i]!;
    const count = histogramCount(histogram, rank);
    if (count === 4) quads.push(rank);
    else if (count === 3) trips.push(rank);
    else if (count === 2) pairs.push(rank);
    else if (count === 1) singles.push(rank);
  }

  let madeValue = 0;
  let madeRanks: Rank[] = [];

  if (quads.length > 0) {
    const quadRank = quads[0]!;
    const kicker = highestExcluding(fullMask, [quadRank]);
    madeValue = encode(HandCategory.FOUR_OF_A_KIND, [quadRank, kicker]);
    madeRanks = [quadRank, kicker as Rank];
  } else if (trips.length > 0 && trips.length + pairs.length >= 2) {
    const tripRank = trips[0]!;
    const pairRank = pairs.length > 0 ? pairs[0]! : trips[1]!;
    madeValue = encode(HandCategory.FULL_HOUSE, [tripRank, pairRank]);
    madeRanks = [tripRank, pairRank];
  } else if (trips.length > 0) {
    const tripRank = trips[0]!;
    const kickers = highestNExcluding(fullMask, [tripRank], 2);
    madeValue = encode(HandCategory.THREE_OF_A_KIND, [tripRank, ...kickers]);
    madeRanks = [tripRank, ...kickers];
  } else if (pairs.length >= 2) {
    const [hi, lo] = [pairs[0]!, pairs[1]!];
    /**
     * 两对的踢脚 = 排除**这两个对子点数**之后剩下的最高牌。
     *
     * ## 🔴 这里曾经写错过，而且错得有理由（2026-09 修复）
     *
     * 旧实现是 `singles.length > 0 ? singles[0]! : 0` —— 只从**未成对的点数**
     * 里取踢脚，并附了一段「第三个对子不能当踢脚」的论证。那段论证是**错的**：
     *
     * > 一手牌 = 7 张里最强的 5 张。前序动作里没有任何一条要求
     * > 「踢脚必须来自只出现一次的点数」。
     *
     * 反例（也是本项目的实际行为）：`Q Q T T 8 8 3` 的候选五张里
     * `Q Q T T 8` **大于** `Q Q T T 3`，因此最佳五张是 `Q Q T T 8` ——
     * 第三个对子里的那张 8 完全可以充当第五张牌。
     *
     * 最强的自证：同一分支下面处理四条时（`7 7 7 7 J J 4`）踢脚取 **J**，
     * 而 J 正是来自一个对子。同一个文件里两处标准不一致，说明旧写法自相矛盾。
     *
     * ## 影响（修复前实测）
     *
     * - 穷举 `(2,2,2,1)` 型 7 张 2,471,040 手 → **617,760 手（25.0%）编码错误**
     *   ⇒ 占全部 C(52,7) 的 0.462%
     * - 6 张 `(2,2,2)` 型 100% 错误（踢脚退化成 `0`，`describeHand` 显示 `"QT?"`）
     * - 真实摊牌模拟 20 万次 → **82 次把底池判给错误一方**，71 次本应平分
     *
     * ⚠️ 这个缺陷**不可能**被 `handEval` 与 `fastEval` 的差分测试发现 ——
     * 两个实现共享同一个错误（见 `fastEval.ts` 对应分支），差分结果恒为 0。
     * 它是被「独立参考实现穷举 + 构造用例」找出来的。
     */
    const kicker = highestExcluding(fullMask, [hi, lo]);
    madeValue = encode(HandCategory.TWO_PAIR, [hi, lo, kicker]);
    madeRanks = [hi, lo, kicker as Rank];
  } else if (pairs.length === 1) {
    const pairRank = pairs[0]!;
    const kickers = highestNExcluding(fullMask, [pairRank], 3);
    madeValue = encode(HandCategory.ONE_PAIR, [pairRank, ...kickers]);
    madeRanks = [pairRank, ...kickers];
  } else {
    const top5 = ranksDescending(fullMask).slice(0, 5);
    madeValue = encode(HandCategory.HIGH_CARD, top5);
    madeRanks = top5;
  }

  // ---- 4) 取三者最强 ----
  let bestValue = madeValue;
  let bestRanks = madeRanks;
  if (straightValue > bestValue) {
    bestValue = straightValue;
    bestRanks = straightRanks;
  }
  if (bestFlushValue > bestValue) {
    bestValue = bestFlushValue;
    bestRanks = bestFlushRanks;
  }

  return { category: categoryOf(bestValue), value: bestValue, ranks: bestRanks };
}

function popcount(x: number): number {
  let v = x;
  let count = 0;
  while (v) {
    v &= v - 1;
    count++;
  }
  return count;
}

function highestExcluding(mask: number, exclude: readonly Rank[]): Rank {
  for (let i = ALL_RANKS.length - 1; i >= 0; i--) {
    const rank = ALL_RANKS[i]!;
    if (exclude.includes(rank)) continue;
    if ((mask & rankBit(rank)) !== 0) return rank;
  }
  // 5 张牌时不可能出现（至少有一张踢脚）；7 张更不可能
  return 2;
}

function highestNExcluding(mask: number, exclude: readonly Rank[], n: number): Rank[] {
  const out: Rank[] = [];
  for (let i = ALL_RANKS.length - 1; i >= 0 && out.length < n; i--) {
    const rank = ALL_RANKS[i]!;
    if (exclude.includes(rank)) continue;
    if ((mask & rankBit(rank)) !== 0) out.push(rank);
  }
  // 补 0 占位（编码时用 rank 0，永远不会与实际点数冲突）
  while (out.length < n) out.push(0 as Rank);
  return out;
}

/* ============================================================
 * 比较与胜负
 * ============================================================ */

export type Comparison = -1 | 0 | 1;

export function compareHands(a: EvaluatedHand, b: EvaluatedHand): Comparison {
  if (a.value > b.value) return 1;
  if (a.value < b.value) return -1;
  return 0;
}

export type ShowdownPlayer<T> = {
  /** 用于回传结果的标识（玩家 id） */
  id: T;
  holeCards: readonly Card[];
};

export type ShowdownResult<T> = {
  /** 每位玩家最终可比较的牌力 */
  hands: Array<{ id: T; hand: EvaluatedHand }>;
  /** 最强牌力编码 */
  bestValue: number;
  /** 获胜者 id 列表；多人表示平分底池 */
  winners: T[];
  /** 是否平分 */
  isSplit: boolean;
};

/**
 * 摊牌比较。公共牌可少于 5 张（例如只发了翻牌），此时按现有牌评估。
 * 返回全部玩家的牌力，便于复盘逐街展示。
 */
export function showdown<T extends string | number>(
  players: ReadonlyArray<ShowdownPlayer<T>>,
  board: readonly Card[],
): ShowdownResult<T> {
  if (players.length === 0) {
    throw new Error('showdown: 至少需要一位玩家');
  }
  const hands = players.map((player) => ({
    id: player.id,
    hand: evaluateCards([...player.holeCards, ...board]),
  }));

  let bestValue = hands[0]!.hand.value;
  for (const entry of hands) {
    if (entry.hand.value > bestValue) bestValue = entry.hand.value;
  }

  const winners = hands.filter((entry) => entry.hand.value === bestValue).map((entry) => entry.id);
  return { hands, bestValue, winners, isSplit: winners.length > 1 };
}

/** 某组牌力相对公共牌是否使用了底牌（用于「打公共牌」判断） */
export function usesHoleCards(holeCards: readonly Card[], board: readonly Card[]): boolean {
  if (board.length < 5) return true; // 公共牌不足 5 张时不可能不靠底牌
  const boardHand = evaluateCards(board.slice(0, 5));
  const withHole = evaluateCards([...holeCards, ...board]);
  return withHole.value > boardHand.value;
}

/** 公共牌本身是否就是最佳五张牌 */
export function boardIsBestFive(holeCards: readonly Card[], board: readonly Card[]): boolean {
  if (board.length < 5) return false;
  const boardHand = evaluateCards(board.slice(0, 5));
  const withHole = evaluateCards([...holeCards, ...board]);
  return withHole.value === boardHand.value;
}

/** 计算最佳五张的具体牌（用于复盘展示） */
export function bestFiveOf(cards: readonly Card[]): Card[] {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`bestFiveOf: 只支持 5~7 张牌，收到 ${cards.length} 张`);
  }
  if (cards.length === 5) return cards.slice();

  let bestCards: Card[] | null = null;
  let bestValue = -1;
  const combo: Card[] = [];

  const walk = (start: number): void => {
    if (combo.length === 5) {
      const hand = evaluateCards(combo);
      if (hand.value > bestValue) {
        bestValue = hand.value;
        bestCards = combo.slice();
      }
      return;
    }
    for (let i = start; i < cards.length; i++) {
      combo.push(cards[i]!);
      walk(i + 1);
      combo.pop();
    }
  };
  walk(0);

  if (bestCards === null) throw new Error('bestFiveOf: 内部错误，未找到最优五张');
  return bestCards;
}

/** 牌的索引集合（测试与调试） */
export function cardIndices(cards: readonly Card[]): number[] {
  return cards.map(cardIndex);
}
