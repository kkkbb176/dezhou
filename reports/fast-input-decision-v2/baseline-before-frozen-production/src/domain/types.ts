/**
 * 领域基础类型（强类型值对象定义）
 *
 * 设计约束：
 * 1. 全部使用「as const 对象 + 派生联合类型」而非 TS enum。
 *    原因：Node 直接剥离类型运行时不允许 enum 语法；且面向未来 UI 时纯值更友好。
 * 2. 本文件只定义「内部英文枚举」与「结构」，不含任何中文文案。
 *    中文显示统一由 src/i18n 映射层负责（规范第 40 / 47 条）。
 */

/* ============================================================
 * 牌
 * ============================================================ */

/** 点数：内部码 2..14，其中 11=J、12=Q、13=K、14=A */
export const Rank = {
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
  SIX: 6,
  SEVEN: 7,
  EIGHT: 8,
  NINE: 9,
  TEN: 10,
  JACK: 11,
  QUEEN: 12,
  KING: 13,
  ACE: 14,
} as const;
export type Rank = (typeof Rank)[keyof typeof Rank];

/** 点数显示用字符：2..9 / T / J / Q / K / A */
export type RankChar = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';

export const Suit = {
  SPADES: 's',
  HEARTS: 'h',
  DIAMONDS: 'd',
  CLUBS: 'c',
} as const;
export type Suit = (typeof Suit)[keyof typeof Suit];

/** 一副牌 + 一张牌 */
export type Card = { readonly rank: Rank; readonly suit: Suit };

/* ============================================================
 * 位置
 * ============================================================ */

/**
 * 位置内部键。
 * 注意：UTG / HJ 在 6 人桌与 9 人桌上都存在，但中文语义不同，
 *      因此「中文显示」必须结合桌型解析，见 src/i18n。
 */
export const Position = {
  UTG: 'UTG',
  UTG1: 'UTG1',
  UTG2: 'UTG2',
  LJ: 'LJ',
  HJ: 'HJ',
  CO: 'CO',
  BTN: 'BTN',
  SB: 'SB',
  BB: 'BB',
} as const;
export type Position = (typeof Position)[keyof typeof Position];

export const TableSize = {
  SIX_MAX: 6,
  NINE_MAX: 9,
} as const;
export type TableSize = (typeof TableSize)[keyof typeof TableSize];

/* ============================================================
 * 街与动作
 * ============================================================ */

export const Street = {
  PREFLOP: 'PREFLOP',
  FLOP: 'FLOP',
  TURN: 'TURN',
  RIVER: 'RIVER',
} as const;
export type Street = (typeof Street)[keyof typeof Street];

/**
 * 动作类型。
 * 内部记录统一使用 toAmount 语义（「加注到」而不是「加注多少」），
 * 避免规范第 46 条提到的历史 Bug B12。
 */
export const ActionType = {
  FOLD: 'FOLD',
  CHECK: 'CHECK',
  CALL: 'CALL',
  BET: 'BET',
  RAISE: 'RAISE',
  RERAISE: 'RERAISE',
  ALL_IN: 'ALL_IN',
  POST_SB: 'POST_SB',
  POST_BB: 'POST_BB',
  POST_ANTE: 'POST_ANTE',
  STRADDLE: 'STRADDLE',
  REVEAL: 'REVEAL',
  SHOWDOWN: 'SHOWDOWN',
} as const;
export type ActionType = (typeof ActionType)[keyof typeof ActionType];

/* ============================================================
 * 牌型
 * ============================================================ */

/** 牌型强度序号：1 高牌 .. 9 同花顺（数值越大越强） */
export const HandCategory = {
  HIGH_CARD: 1,
  ONE_PAIR: 2,
  TWO_PAIR: 3,
  THREE_OF_A_KIND: 4,
  STRAIGHT: 5,
  FLUSH: 6,
  FULL_HOUSE: 7,
  FOUR_OF_A_KIND: 8,
  STRAIGHT_FLUSH: 9,
} as const;
export type HandCategory = (typeof HandCategory)[keyof typeof HandCategory];

/* ============================================================
 * 玩家类型（规范第 12 条）
 * ============================================================ */

export const PlayerType = {
  UNKNOWN: 'UNKNOWN',
  TIGHT_PASSIVE: 'TIGHT_PASSIVE',
  TIGHT_AGGRESSIVE: 'TIGHT_AGGRESSIVE',
  LOOSE_PASSIVE: 'LOOSE_PASSIVE',
  LOOSE_AGGRESSIVE: 'LOOSE_AGGRESSIVE',
  CALLING_STATION: 'CALLING_STATION',
  BLUFF_HEAVY: 'BLUFF_HEAVY',
  BLUFF_LIGHT: 'BLUFF_LIGHT',
  ULTRA_TIGHT: 'ULTRA_TIGHT',
  REG_AVERAGE: 'REG_AVERAGE',
  REG_STRONG: 'REG_STRONG',
} as const;
export type PlayerType = (typeof PlayerType)[keyof typeof PlayerType];

/* ============================================================
 * 通用工具类型
 * ============================================================ */

/** 点数 → 显示字符 */
export const RANK_CHARS: Readonly<Record<Rank, RankChar>> = {
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: 'T',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
};

/** 显示字符 → 点数 */
export const CHAR_RANKS: Readonly<Record<string, Rank>> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

export const ALL_RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
export const ALL_SUITS: readonly Suit[] = [Suit.SPADES, Suit.HEARTS, Suit.DIAMONDS, Suit.CLUBS];

/** 全部 52 张牌的规范顺序（点数升序、花色固定顺序） */
export const ALL_CARDS: readonly Card[] = (() => {
  const out: Card[] = [];
  for (const suit of ALL_SUITS) {
    for (const rank of ALL_RANKS) out.push({ rank, suit });
  }
  return out;
})();

/** 牌的结构化唯一键，例如 {rank:14,suit:'d'} → "14d" */
export function cardKey(card: Card): string {
  return `${card.rank}${card.suit}`;
}

/**
 * 某桌型下按座位顺序排列的全部位置。
 *
 * 这里直接给出数据而不再从 positions.ts 转发，是为了让 types.ts 保持零依赖，
 * 同时让「桌型 → 位置集合」成为一份可被 i18n 与领域层共同引用的权威定义。
 * 一致性由测试保证（positions.test.ts 会比对两份定义）。
 */
export function positionsForTableOf(tableSize: TableSize): readonly Position[] {
  if (tableSize === TableSize.SIX_MAX) {
    return [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB, Position.BB];
  }
  return [
    Position.UTG,
    Position.UTG1,
    Position.UTG2,
    Position.LJ,
    Position.HJ,
    Position.CO,
    Position.BTN,
    Position.SB,
    Position.BB,
  ];
}
