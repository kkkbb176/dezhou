/**
 * 高速 7 张牌评估器（蒙特卡洛 / 精确枚举的热路径）
 *
 * 设计目标：让 50 万次模拟在可接受时间内完成
 * （规范第 14 条要求模拟次数可达 500,000 并给出误差范围）。
 *
 * 与 handEval.ts 的关系：
 * - handEval.ts 是**权威语义实现**，可读性优先（5/6/7 张、返回牌型与关键点数）。
 * - 本文件是**同一套规则的快速路径**，只返回可比较的强度编码（恰好 7 张）。
 * - 两者必须返回**逐位相同**的编码，由 test/equity.test.ts 的差分测试保证。
 *
 * 编码方案（与 handEval 完全一致）：
 *   value = 牌型序号 × 2^32 + packRanks(关键点数降序)
 *   packRanks = 依次 `v = v * 16 + rank`（与降序点数的字典序比较等价）
 *
 * 两个必须避免的陷阱（本项目都实际踩到过）：
 * 1. **不能**用 `1 << (4 * rankIndex)` 构建点数直方图。
 *    JS 位移会先把移位数对 32 取模，`1 << 48` 等于 `1 << 16`，
 *    会让 A/K/Q/J/T/9 的计数全部串位。必须用 `2 ** n` 常量相加。
 * 2. **不能**用「位置权值」（例如让每个点数占一个固定的十进制位）来拼接关键点数。
 *    两对里如果踢脚比小对子还大（例如 AAK33），位置权值会让踢脚盖过对子，
 *    导致 AAK33 被判成比 AAQQ3 更弱 —— 排序静默出错。
 *    必须严格按「降序点数依次 ×16 + rank」拼接。
 */

import { HandCategory, type Card, type Rank } from '../types.ts';

/* ============================================================
 * 预计算表
 * ============================================================ */

/** rank → 直方图槽位增量（必须用幂运算，不能用位移） */
const HIST_ADD: Float64Array = (() => {
  const table = new Float64Array(15);
  for (let rank = 2; rank <= 14; rank++) table[rank] = 2 ** (4 * (rank - 2));
  return table;
})();

/** rank → 13 位点数掩码位 */
const RANK_BIT: Int32Array = (() => {
  const table = new Int32Array(15);
  for (let rank = 2; rank <= 14; rank++) table[rank] = 1 << (rank - 2);
  return table;
})();

/** 牌型序号 → 强度编码基数（与 handEval 的 CATEGORY_SCALE 一致） */
const CATEGORY_BASE: Float64Array = (() => {
  const table = new Float64Array(10);
  for (let category = 1; category <= 9; category++) table[category] = category * 2 ** 32;
  return table;
})();

/** 掩码 → 最高点数（点数本身，0 表示空） */
const HIGHEST_RANK: Int8Array = (() => {
  const table = new Int8Array(1 << 13);
  for (let mask = 0; mask < 1 << 13; mask++) {
    for (let i = 12; i >= 0; i--) {
      if ((mask >> i) & 1) {
        table[mask] = i + 2;
        break;
      }
    }
  }
  return table;
})();

/** 掩码 → 13 位内 1 的个数 */
const POPCOUNT: Int8Array = (() => {
  const table = new Int8Array(1 << 13);
  for (let mask = 0; mask < 1 << 13; mask++) {
    let v = mask;
    let count = 0;
    while (v) {
      v &= v - 1;
      count++;
    }
    table[mask] = count;
  }
  return table;
})();

/**
 * 掩码 → 「最高 n 个降序点数按 ×16 拼接」的结果（n = 0..5）。
 *
 * KEYS[n][mask] = packRanks(该掩码里最高的 n 个点数，降序)
 *
 * 取值恰好等于 handEval 的 packRanks，因此两者编码逐位相同。
 * 上界：n=5 时最多 16^5 ≈ 1e6，安全落在整数范围。
 */
const KEYS: Int32Array[] = (() => {
  const tables: Int32Array[] = [];
  for (let n = 0; n <= 5; n++) {
    const table = new Int32Array(1 << 13);
    for (let mask = 0; mask < 1 << 13; mask++) {
      let value = 0;
      let taken = 0;
      for (let i = 12; i >= 0 && taken < n; i--) {
        if ((mask >> i) & 1) {
          value = value * 16 + (i + 2);
          taken++;
        }
      }
      table[mask] = value;
    }
    tables.push(table);
  }
  return tables;
})();

/** rank → 单张点数的编码（相当于 packRanks([rank])） */
const SINGLE_KEY: Int32Array = (() => {
  const table = new Int32Array(15);
  for (let rank = 2; rank <= 14; rank++) table[rank] = rank;
  return table;
})();

/**
 * 顺子表：13 位点数掩码 → 最大顺子的最高点数（0 = 无顺子）。
 * 含 A2345 轮子（记为 5 高）。
 */
const STRAIGHT_HIGH: Int8Array = (() => {
  const table = new Int8Array(1 << 13);
  for (let mask = 0; mask < 1 << 13; mask++) {
    let best = 0;
    for (let high = 14; high >= 6; high--) {
      const needed =
        RANK_BIT[high]! |
        RANK_BIT[high - 1]! |
        RANK_BIT[high - 2]! |
        RANK_BIT[high - 3]! |
        RANK_BIT[high - 4]!;
      if ((mask & needed) === needed) {
        best = high;
        break;
      }
    }
    if (best === 0) {
      const wheel = RANK_BIT[14]! | RANK_BIT[2]! | RANK_BIT[3]! | RANK_BIT[4]! | RANK_BIT[5]!;
      if ((mask & wheel) === wheel) best = 5;
    }
    table[mask] = best;
  }
  return table;
})();

/* ============================================================
 * 直方图 → 重复结构
 * ============================================================ */

/**
 * 从直方图解出四张 / 三张 / 对子 / 单张的点数掩码（13 次查表）。
 *
 * 不用 2^52 巨型查表：那张表需要天文数字的内存。
 */
function breakdown(
  histogram: number,
  out: { quads: number; trips: number; pairs: number; singles: number },
): void {
  let quads = 0;
  let trips = 0;
  let pairs = 0;
  let singles = 0;
  for (let rank = 14; rank >= 2; rank--) {
    const count = Math.floor(histogram / HIST_ADD[rank]!) & 0xf;
    if (count === 0) continue;
    const bit = RANK_BIT[rank]!;
    if (count === 4) quads |= bit;
    else if (count === 3) trips |= bit;
    else if (count === 2) pairs |= bit;
    else singles |= bit;
  }
  out.quads = quads;
  out.trips = trips;
  out.pairs = pairs;
  out.singles = singles;
}

/* ============================================================
 * 主函数
 * ============================================================ */

/** 复用的解构结果对象，避免热路径分配 */
const scratch = { quads: 0, trips: 0, pairs: 0, singles: 0 };
/** 复用的花色掩码数组 */
const suitMasks = new Int32Array(4);

/**
 * 评估恰好 7 张牌，返回可比较的强度编码。
 *
 * 调用方必须保证传入的恰好是 7 张互不相同的牌；本函数不做重复牌检查
 * （热路径，唯一性由上游 validator 负责）。
 */
export function evaluateSeven(cards: readonly Card[]): number {
  let mask = 0;
  let histogram = 0;
  suitMasks[0] = 0;
  suitMasks[1] = 0;
  suitMasks[2] = 0;
  suitMasks[3] = 0;

  for (let i = 0; i < 7; i++) {
    const card = cards[i]!;
    const rank = card.rank as number;
    const bit = RANK_BIT[rank]!;
    mask |= bit;
    histogram += HIST_ADD[rank]!;
    const suit = card.suit;
    if (suit === 's') suitMasks[0] |= bit;
    else if (suit === 'h') suitMasks[1] |= bit;
    else if (suit === 'd') suitMasks[2] |= bit;
    else suitMasks[3] |= bit;
  }

  // ---- 同花 / 同花顺（最高优先级）----
  let bestFlush = 0;
  for (let s = 0; s < 4; s++) {
    const suitMask = suitMasks[s]!;
    if (suitMask === 0 || POPCOUNT[suitMask]! < 5) continue;
    const straight = STRAIGHT_HIGH[suitMask]!;
    if (straight > 0) {
      // 同花顺已是最高牌型，无需继续比较
      return CATEGORY_BASE[9]! + SINGLE_KEY[straight]!;
    }
    bestFlush = CATEGORY_BASE[6]! + KEYS[5]![suitMask]!;
  }

  // ---- 普通顺子 ----
  const straightHigh = STRAIGHT_HIGH[mask]!;
  const straightValue = straightHigh > 0 ? CATEGORY_BASE[5]! + SINGLE_KEY[straightHigh]! : 0;

  // ---- 重复结构 ----
  breakdown(histogram, scratch);
  const { quads, trips, pairs, singles } = scratch;
  let madeValue: number;

  if (quads !== 0) {
    /**
     * 四条 + 踢脚：踢脚是「除四条点数之外的最高牌」。
     *
     * 不能用 singles 掩码：单张掩码只包含**恰好出现 1 次**的点数，
     * 而在 7 张牌里除四条外还可能存在一个对子（例如 7 7 7 7 J J 4）。
     * 那种情况下真正的踢脚是 J（对子里的点数），但 J 不会出现在 singles 里。
     * 正确做法是从全掩码里排除四条点数后取最高。
     */
    const quadRank = HIGHEST_RANK[quads]!;
    const kickerMask = mask & ~RANK_BIT[quadRank]!;
    const kickerRank = HIGHEST_RANK[kickerMask]!;
    madeValue = CATEGORY_BASE[8]! + SINGLE_KEY[quadRank]! * 16 + SINGLE_KEY[kickerRank]!;
  } else if (trips !== 0 && (pairs !== 0 || POPCOUNT[trips]! >= 2)) {
    // 葫芦：三条在前、对子在后（顺序绝不能反）
    const tripRank = HIGHEST_RANK[trips]!;
    const pairMask = pairs !== 0 ? pairs : trips & ~RANK_BIT[tripRank]!;
    const pairRank = HIGHEST_RANK[pairMask]!;
    madeValue = CATEGORY_BASE[7]! + SINGLE_KEY[tripRank]! * 16 + SINGLE_KEY[pairRank]!;
  } else if (trips !== 0) {
    const tripRank = HIGHEST_RANK[trips]!;
    madeValue = CATEGORY_BASE[4]! + SINGLE_KEY[tripRank]! * 256 + KEYS[2]![singles]!;
  } else if (POPCOUNT[pairs]! >= 2) {
    const hi = HIGHEST_RANK[pairs]!;
    const lo = HIGHEST_RANK[pairs & ~RANK_BIT[hi]!]!;
    /*
     * 🔴 踢脚 = 排除这两个对子点数后剩下的**最高牌**，而不是「未成对点数里的最高牌」。
     *
     * 两者只在「恰好两对 + 一个单张」时相同；7 张里出现**三个对子**时不同：
     * `Q Q T T 8 8 3` 的最佳五张是 `Q Q T T 8`（第三个对子的 8 作踢脚），
     * 而不是 `Q Q T T 3`。
     *
     * ⚠️ 不能写成 `singles & …`：三对时第三个对子的点数**不在** `singles` 里
     *（它出现两次），因此从 singles 取永远拿不到它。这与上面四条分支同理
     *（那里也刻意不用 singles）—— 直接从全掩码 `mask` 排除。
     *
     * ⚠️ 本函数与 `handEval.ts` 的两对分支**必须语义一致**。
     * 两者共享同一个错误时，它们之间的差分测试恒为 0，
     * 因此那种测试**发现不了**这一类缺陷（2026-09 实际发生过）。
     */
    const kickerMask = mask & ~RANK_BIT[hi]! & ~RANK_BIT[lo]!;
    const kickerRank = HIGHEST_RANK[kickerMask]!;
    madeValue =
      CATEGORY_BASE[3]! + SINGLE_KEY[hi]! * 256 + SINGLE_KEY[lo]! * 16 + SINGLE_KEY[kickerRank]!;
  } else if (pairs !== 0) {
    const pairRank = HIGHEST_RANK[pairs]!;
    madeValue = CATEGORY_BASE[2]! + SINGLE_KEY[pairRank]! * 4096 + KEYS[3]![singles]!;
  } else {
    madeValue = CATEGORY_BASE[1]! + KEYS[5]![singles]!;
  }

  return Math.max(madeValue, straightValue, bestFlush);
}

/** 供测试与调试：把强度编码还原为牌型 */
export function fastCategoryOf(value: number): HandCategory {
  return Math.floor(value / 2 ** 32) as HandCategory;
}

/** 供范围层使用 */
export function rankValueOf(rank: Rank): number {
  return rank;
}
