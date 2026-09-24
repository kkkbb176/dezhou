/**
 * 组合宇宙（Step 5A）
 *
 * 本文件是全项目「两张底牌」的**唯一底层表示**：1326 个精确组合。
 *
 * 第一性原理（规范第三节）：德州的底牌是两张**具体实体牌**，不是「AKs」这种类别。
 *   A♠K♠ / A♥K♥ / A♦K♦ / A♣K♣ 是四个不同组合。
 * 因此内部计算一律用 exact combo；169 类起手牌**只允许**出现在显示层与数据输入层，
 * 进入计算前必须展开回 exact combos。
 *
 * 为什么坚持这一点：如果用 169 类做计算，就无法表达「同样是一对 A，
 * 其中 A♠A♥ 被对手的阻断牌排除，而 A♦A♣ 仍然可能」这种区别 ——
 * 而这恰恰是 blocker 与 Bayesian 更新的全部意义所在。
 */

import { ALL_CARDS, ALL_SUITS, type Card, type Rank, type Suit } from '../types.ts';
import { cardIndex } from '../poker/cards.ts';
import { RANK_CHARS } from '../types.ts';

/* ============================================================
 * 常量
 * ============================================================ */

/** C(52,2) = 1326 —— 两张不同实体牌的全部组合数 */
export const TOTAL_COMBO_COUNT = 1326;

/** 169 类起手牌（13 对子 + 78 同花 + 78 不同花） */
export const RANK_CLASS_COUNT = 169;

export const Suitedness = {
  PAIR: 'PAIR',
  SUITED: 'SUITED',
  OFFSUIT: 'OFFSUIT',
} as const;
export type Suitedness = (typeof Suitedness)[keyof typeof Suitedness];

/* ============================================================
 * 花色顺序与规范化
 * ============================================================ */

/**
 * **canonical 花色顺序**：s < h < d < c（黑桃、红桃、方块、梅花）。
 *
 * 全部组合的牌都按「点数降序；点数相同则花色按本顺序升序」排列。
 * 这样 AsKd 与 KdAs 会规范化成同一个组合，绝不会同时出现（规范第六节）。
 */
export const CANONICAL_SUIT_ORDER: Readonly<Record<Suit, number>> = {
  s: 0,
  h: 1,
  d: 2,
  c: 3,
};

/** 组合的规范字符串（A♠ + K♦ → "AsKd"） */
export function comboIdOf(a: Card, b: Card): string {
  const [high, low] = orderCards(a, b);
  return `${RANK_CHARS[high.rank]}${high.suit}${RANK_CHARS[low.rank]}${low.suit}`;
}

/** 按规范顺序排列两张牌：点数降序，同点数按花色规范顺序升序 */
export function orderCards(a: Card, b: Card): [Card, Card] {
  if (a.rank > b.rank) return [a, b];
  if (a.rank < b.rank) return [b, a];
  return CANONICAL_SUIT_ORDER[a.suit] <= CANONICAL_SUIT_ORDER[b.suit] ? [a, b] : [b, a];
}

/* ============================================================
 * ExactCombo
 * ============================================================ */

/**
 * 一个精确组合。
 *
 * `canonicalId`、`rankClass`、`suitedness`、`cardIndices`、`ranks` 都是派生字段，
 * 在构造时一次性算好，避免热路径反复计算（1326 个组合 × 每次更新）。
 *
 * ⚠️ **全部字段必须是 readonly**。
 * 红队审计发现的 CRITICAL 缺陷：`ALL_COMBOS` 的元素是模块级共享对象，
 * 而范围条目的 `combo` 直接指向它们。若字段可变，一行**类型安全的**赋值
 * `range.entries[0].combo.canonicalId = 'ZZZZ'` 就会污染
 * `COMBO_BY_ID`、所有已缓存的范围、以及之后新建的每一个范围 ——
 * 而 `isFrozen()` 仍会返回 true（冻结原本只到第一层）。
 *
 * 两道防线：
 * 1. `readonly` 让这类赋值在**编译期**被拒绝
 * 2. `ALL_COMBOS` / `ALL_CARDS` 的元素在模块初始化时被 `Object.freeze` 深冻结
 */
export type ExactCombo = {
  /** 规范顺序的第一张（点数较大者） */
  readonly card1: Card;
  /** 规范顺序的第二张 */
  readonly card2: Card;
  /** 稳定唯一 id，例如 "AsKd"；As Kd 与 Kd As 得到同一个 id */
  readonly canonicalId: string;
  /** 169 类之一，例如 "AKs" / "AKo" / "AA" */
  readonly rankClass: string;
  readonly suitedness: Suitedness;
  /** 两张牌的 0..51 整数索引（升序），用于 O(1) 死牌判断 */
  readonly cardIndices: readonly [number, number];
  /** 两张牌的点数（降序） */
  readonly ranks: readonly [Rank, Rank];
};

/**
 * 深冻结一张牌（返回同一对象，便于链式书写）。
 *
 * 牌对象在 `ALL_CARDS` 与 `ALL_COMBOS` 之间**共享**，
 * 因此必须冻结 `ALL_CARDS` 的元素本身，否则 `combo.card1.rank = 99`
 * 会让 `cardIndex()` 返回越界值，该牌的死牌过滤**永久失效且无声**。
 */
function freezeCard(card: Card): Card {
  return Object.freeze(card);
}

/** 深冻结一个组合（连同它引用的两张牌） */
function freezeCombo(combo: ExactCombo): ExactCombo {
  freezeCard(combo.card1);
  freezeCard(combo.card2);
  return Object.freeze(combo);
}

export function makeCombo(a: Card, b: Card): ExactCombo {
  if (a.rank === b.rank && a.suit === b.suit) {
    throw new Error(`makeCombo: 不能由同一张牌组成组合（${RANK_CHARS[a.rank]}${a.suit}）`);
  }
  const [card1, card2] = orderCards(a, b);
  const suitedness =
    card1.rank === card2.rank
      ? Suitedness.PAIR
      : card1.suit === card2.suit
        ? Suitedness.SUITED
        : Suitedness.OFFSUIT;

  const i1 = cardIndex(card1);
  const i2 = cardIndex(card2);
  if (i1 < 0 || i2 < 0) {
    throw new Error(
      `makeCombo: 牌面不合法（cardIndex 返回 ${i1}/${i2}）。` +
        '花色必须是小写 s/h/d/c，点数必须在 2..14。请检查上游数据是否用了大写花色或越界点数。',
    );
  }

  return freezeCombo({
    card1,
    card2,
    canonicalId: `${RANK_CHARS[card1.rank]}${card1.suit}${RANK_CHARS[card2.rank]}${card2.suit}`,
    rankClass: rankClassOf(card1, card2, suitedness),
    suitedness,
    cardIndices: Object.freeze(i1 <= i2 ? [i1, i2] : [i2, i1]) as readonly [number, number],
    ranks: Object.freeze([card1.rank, card2.rank]) as readonly [Rank, Rank],
  });
}

/** 169 类名称：对子用 "AA"，同花用 "AKs"，不同花用 "AKo" */
export function rankClassOf(a: Card, b: Card, suitedness: Suitedness): string {
  const [high, low] = orderCards(a, b);
  const h = RANK_CHARS[high.rank];
  const l = RANK_CHARS[low.rank];
  switch (suitedness) {
    case Suitedness.PAIR:
      return `${h}${l}`;
    case Suitedness.SUITED:
      return `${h}${l}s`;
    default:
      return `${h}${l}o`;
  }
}

/* ============================================================
 * 1326 组合宇宙
 * ============================================================ */

/**
 * 全部 1326 个精确组合，按确定性顺序（canonicalId 字典序）排列。
 *
 * 顺序确定性很重要：它让「同一个范围」在缓存与日志里总是同一个序列，
 * 便于 diff 与快照测试。
 */
export const ALL_COMBOS: readonly ExactCombo[] = (() => {
  const combos: ExactCombo[] = [];
  for (let i = 0; i < ALL_CARDS.length; i++) {
    for (let j = i + 1; j < ALL_CARDS.length; j++) {
      combos.push(makeCombo(ALL_CARDS[i]!, ALL_CARDS[j]!));
    }
  }
  combos.sort((x, y) => (x.canonicalId < y.canonicalId ? -1 : x.canonicalId > y.canonicalId ? 1 : 0));
  // 列表本身也必须冻结：ALL_COMBOS[0] = 任意组合 会污染整个组合宇宙
  return Object.freeze(combos);
})();

/** canonicalId → 组合 */
export const COMBO_BY_ID: ReadonlyMap<string, ExactCombo> = new Map(
  ALL_COMBOS.map((c) => [c.canonicalId, c]),
);

/** 169 类 → 该类包含的精确组合 */
export const COMBOS_BY_RANK_CLASS: ReadonlyMap<string, readonly ExactCombo[]> = (() => {
  const map = new Map<string, ExactCombo[]>();
  for (const combo of ALL_COMBOS) {
    const list = map.get(combo.rankClass);
    if (list) list.push(combo);
    else map.set(combo.rankClass, [combo]);
  }
  return map;
})();

/** 全部 169 个类别名（确定性顺序） */
export const ALL_RANK_CLASSES: readonly string[] = (() => {
  const classes = [...COMBOS_BY_RANK_CLASS.keys()];
  classes.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return classes;
})();

/** 解析紧凑写法："AsKd" / "As Kd" / "AKs"（类别写法需展开，见 expandRankClass） */
export function comboById(canonicalId: string): ExactCombo | undefined {
  return COMBO_BY_ID.get(canonicalId);
}

/** 类别 → 精确组合（对子 6、同花 4、不同花 12） */
export function expandRankClass(rankClass: string): readonly ExactCombo[] {
  return COMBOS_BY_RANK_CLASS.get(rankClass) ?? [];
}

/** 一批类别 → 精确组合（自动去重，保持确定性顺序） */
export function expandRankClasses(rankClasses: readonly string[]): ExactCombo[] {
  const seen = new Set<string>();
  const out: ExactCombo[] = [];
  for (const rankClass of rankClasses) {
    for (const combo of expandRankClass(rankClass)) {
      if (seen.has(combo.canonicalId)) continue;
      seen.add(combo.canonicalId);
      out.push(combo);
    }
  }
  out.sort((x, y) => (x.canonicalId < y.canonicalId ? -1 : x.canonicalId > y.canonicalId ? 1 : 0));
  return out;
}

/* ============================================================
 * 组合容量基准值（写死为常量，供测试与验证引用）
 * ============================================================ */

/**
 * 已知牌张数 → 剩余合法组合数。
 *
 * C(52,2) = 1326
 * 只有 Hero 两张已知   → C(50,2) = 1225
 * Hero + 翻牌 5 张已知 → C(47,2) = 1081
 * Hero + 转牌 6 张已知 → C(46,2) = 1035
 * Hero + 河牌 7 张已知 → C(45,2) = 990
 */
export const COMBO_CAPACITY: Readonly<Record<number, number>> = {
  0: 1326,
  2: 1225,
  3: 1176,
  5: 1081,
  6: 1035,
  7: 990,
};

/** 给定已知牌张数时的理论最大合法组合数 = C(52 − n, 2) */
export function maxCombosForKnownCards(knownCount: number): number {
  const remaining = 52 - knownCount;
  if (remaining < 2) return 0;
  return (remaining * (remaining - 1)) / 2;
}

/** 全部花色（供测试遍历） */
export { ALL_SUITS };
