/**
 * 牌：构造、严格解析、52 张唯一性检查、重复牌检查
 *
 * 规范第 6 / 7 / 13 / 14 条；Bug 预判 B1 / B2 / B3 / B22。
 *
 * 核心立场：**牌不会认错**。
 * 解析器宁可报错，也绝不猜测式纠正（例如绝不把 7♦ 自动改成 7♣）。
 */

import {
  ALL_CARDS,
  ALL_RANKS,
  ALL_SUITS,
  CHAR_RANKS,
  RANK_CHARS,
  Rank,
  Suit,
  cardKey,
  type Card,
} from '../types.ts';
import { CardParseCode } from '../domainCodes.ts';

export { ALL_CARDS, cardKey };

/* ============================================================
 * 构造
 * ============================================================ */

/** 构造一张牌，越界立即抛错（不静默纠正） */
export function makeCard(rank: Rank, suit: Suit): Card {
  if (!(rank >= 2 && rank <= 14) || !Number.isInteger(rank)) {
    throw new Error(`makeCard: 点数必须是 2..14 的整数，收到 ${rank}`);
  }
  if (!ALL_SUITS.includes(suit)) {
    throw new Error(`makeCard: 花色必须是 s/h/d/c 之一，收到 ${suit}`);
  }
  return { rank, suit };
}

/** 牌的规范紧凑字符串：As / Td / 7c / 2h */
export function cardToString(card: Card): string {
  return `${RANK_CHARS[card.rank]}${card.suit}`;
}

/* ============================================================
 * 严格解析
 * ============================================================ */

export type CardParseFailure = {
  ok: false;
  code: CardParseCode;
  params: Readonly<Record<string, string>>;
};

export type CardParseSuccess = { ok: true; card: Card };

export type CardParseResult = CardParseSuccess | CardParseFailure;

function fail(code: CardParseCode, params: Record<string, string>): CardParseFailure {
  return { ok: false, code, params };
}

const SUIT_CHARS = 'shdc';

/**
 * 严格解析单张牌。接受 As / AS / aS（大小写不敏感），
 * 但**不接受** 10s、sA、Asx、A 等写法。
 */
export function parseCard(input: unknown): CardParseResult {
  if (typeof input !== 'string') {
    return fail(CardParseCode.NOT_A_STRING, { input: String(input) });
  }
  const raw = input.trim();
  if (raw.length === 0) {
    return fail(CardParseCode.EMPTY, { input: raw });
  }

  // 特例：用户把 10 写成 "10"，给出精确而友好的提示
  if (raw.length === 3 && raw.slice(0, 2) === '10' && SUIT_CHARS.includes(raw[2]!.toLowerCase())) {
    return fail(CardParseCode.TEN_AS_10, { input: raw });
  }

  if (raw.length !== 2) {
    return fail(CardParseCode.BAD_LENGTH, { input: raw });
  }

  const first = raw[0]!;
  const second = raw[1]!;

  // 顺序错误：「花色在前、点数在后」，例如 sA、dT
  if (SUIT_CHARS.includes(first.toLowerCase()) && CHAR_RANKS[second.toUpperCase()] !== undefined) {
    return fail(CardParseCode.RANK_SUIT_ORDER, { input: raw });
  }

  const rankCh = first.toUpperCase();
  const suitCh = second.toLowerCase();

  const rank = CHAR_RANKS[rankCh];
  if (rank === undefined) {
    return fail(CardParseCode.BAD_RANK, { input: raw, rank: first });
  }
  if (!SUIT_CHARS.includes(suitCh)) {
    return fail(CardParseCode.BAD_SUIT, { input: raw, suit: second });
  }

  return { ok: true, card: { rank, suit: suitCh as Suit } };
}

/** 解析成功返回牌，失败抛错（测试与内部使用） */
export function parseCardStrict(input: string): Card {
  const result = parseCard(input);
  if (!result.ok) {
    throw new Error(`parseCardStrict: 无法解析「${input}」（${result.code}）`);
  }
  return result.card;
}

/**
 * 批量解析。支持三种写法：
 * - 带分隔符："As Kd 7c"、"As,Kd,7c"、"As、Kd，7c"
 * - 紧凑连写："AsKd7c"（无分隔符时按「点数 + 花色」逐两张切分）
 *
 * 仍然严格：任何一张牌不合法就整体失败，并给出该张牌的具体原因。
 */
export function parseCardsLoose(input: string): Card[] {
  const tokens = input
    .split(/[\s,，、/|]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

  const out: Card[] = [];
  for (const token of tokens) {
    if (token.length === 2) {
      const result = parseCard(token);
      if (!result.ok) throw parseError(token, result);
      out.push(result.card);
      continue;
    }
    // 紧凑连写：两两切分
    if (token.length % 2 !== 0) {
      const result = parseCard(token);
      throw parseError(token, result.ok ? { ok: false, code: CardParseCode.BAD_LENGTH, params: { input: token } } : result);
    }
    for (let i = 0; i < token.length; i += 2) {
      const piece = token.slice(i, i + 2);
      const result = parseCard(piece);
      if (!result.ok) throw parseError(piece, result);
      out.push(result.card);
    }
  }
  return out;
}

function parseError(input: string, result: CardParseFailure): Error {
  return new Error(`parseCardsLoose: 无法解析「${input}」（${result.code}）`);
}

/* ============================================================
 * 编码 / 解码（供高速枚举使用）
 * ============================================================ */

/**
 * 某张牌相对规范全集的索引。索引布局：rank 循环内层、suit 循环外层。
 *
 * ⚠️ 大小写敏感：花色必须是**小写** `s/h/d/c`。
 * 传入 `'S'` 会返回 `-1`（而不是把 S 当作 s），因为下游热路径依赖
 * 「索引必须是 0..51」这一前提 —— 返回 -1 会让死牌过滤静默失效。
 *
 * 调用方若需要构造牌，请用 `normalizeCard()`；
 * 若需要校验，请用 `isCardIndexInRange()`。
 */
export function cardIndex(card: Card): number {
  const suitIndex = ALL_SUITS.indexOf(card.suit);
  if (suitIndex < 0) return -1;
  const rank = card.rank;
  if (!Number.isInteger(rank) || rank < 2 || rank > 14) return -1;
  return suitIndex * 13 + (rank - 2);
}

/** 索引是否落在合法范围（0..51） */
export function isCardIndexInRange(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index <= 51;
}

export type CardNormalizeIssue = { problem: string };

/**
 * 规范化一张外部传入的牌。
 *
 * 宽容之处（因为这些是**无害的表示差异**）：
 * - 花色统一转小写（`'S'` → `'s'`）
 *
 * 严格之处（因为这些是**真实错误**，必须报错而不是猜测）：
 * - 点数不是 2..14 的整数
 * - 花色不是 s/h/d/c 之一
 *
 * 返回 `{ card }` 或 `{ issue }`，而不是抛错或静默返回原值 ——
 * 让调用方决定是「报错」还是「忽略」。
 */
export function normalizeCard(input: {
  rank: number;
  suit: string;
}): { card: Card } | { issue: CardNormalizeIssue } {
  const suitRaw = String(input.suit);
  const suit = suitRaw.toLowerCase();
  if (!ALL_SUITS.includes(suit as Suit)) {
    return { issue: { problem: `花色必须是 s/h/d/c 之一，收到「${suitRaw}」` } };
  }
  const rank = input.rank;
  if (!Number.isInteger(rank) || rank < 2 || rank > 14) {
    return { issue: { problem: `点数必须是 2..14 的整数，收到 ${String(input.rank)}` } };
  }
  return { card: { rank: rank as Rank, suit: suit as Suit } };
}

/** 0..51 → 牌 */
export function indexToCard(index: number): Card {
  if (!Number.isInteger(index) || index < 0 || index > 51) {
    throw new Error(`indexToCard: 索引必须在 0..51，收到 ${index}`);
  }
  return ALL_CARDS[index]!;
}

/* ============================================================
 * 牌堆与唯一性
 * ============================================================ */

/** 一副完整的 52 张牌（返回新数组，调用方可安全修改） */
export function createDeck(): Card[] {
  return ALL_CARDS.map((c) => ({ rank: c.rank, suit: c.suit }));
}

/** 52 张牌互不重复（属性测试的基础断言） */
export function deckIsUnique(deck: readonly Card[] = ALL_CARDS): boolean {
  return new Set(deck.map(cardKey)).size === deck.length;
}

export function countByRank(cards: readonly Card[]): Map<Rank, number> {
  const map = new Map<Rank, number>();
  for (const c of cards) map.set(c.rank, (map.get(c.rank) ?? 0) + 1);
  return map;
}

export function countBySuit(cards: readonly Card[]): Map<Suit, number> {
  const map = new Map<Suit, number>();
  for (const c of cards) map.set(c.suit, (map.get(c.suit) ?? 0) + 1);
  return map;
}

/* ============================================================
 * 重复牌检查（带位置标注，便于生成「哪两张牌撞了」的中文提示）
 * ============================================================ */

export const CardHolder = {
  USER_HOLE: 'USER_HOLE',
  OPPONENT_HOLE: 'OPPONENT_HOLE',
  BOARD_FLOP: 'BOARD_FLOP',
  BOARD_TURN: 'BOARD_TURN',
  BOARD_RIVER: 'BOARD_RIVER',
} as const;
export type CardHolder = (typeof CardHolder)[keyof typeof CardHolder];

export type LocatedCard = {
  card: Card;
  holder: CardHolder;
  /** 玩家 id（手牌时必填） */
  playerId?: string;
  /** 玩家显示名（用于中文提示） */
  playerName?: string;
};

export type DuplicateGroup = {
  card: Card;
  /** 该牌出现的全部位置，长度 ≥ 2 */
  occurrences: LocatedCard[];
  /** 涉及的玩家 id（去重、保持出现顺序） */
  playerIds: string[];
};

/**
 * 在一组带位置的牌中查找重复。
 *
 * 重要：即使同一张牌出现 3 次以上，也只返回一个分组，
 * 由界面层决定如何提示，避免出现「重复报告重复」的信息噪音。
 */
export function findDuplicates(located: readonly LocatedCard[]): DuplicateGroup[] {
  const byKey = new Map<string, LocatedCard[]>();
  for (const item of located) {
    const key = cardKey(item.card);
    const list = byKey.get(key);
    if (list) list.push(item);
    else byKey.set(key, [item]);
  }

  const groups: DuplicateGroup[] = [];
  for (const [, occurrences] of byKey) {
    if (occurrences.length < 2) continue;
    const playerIds: string[] = [];
    for (const occ of occurrences) {
      if (occ.playerId !== undefined && !playerIds.includes(occ.playerId)) {
        playerIds.push(occ.playerId);
      }
    }
    groups.push({ card: occurrences[0]!.card, occurrences, playerIds });
  }
  return groups;
}

export function hasDuplicates(located: readonly LocatedCard[]): boolean {
  return findDuplicates(located).length > 0;
}

/** 从候选池中剔除已使用的牌（发牌/模拟用） */
export function removeUsedCards(pool: readonly Card[], used: readonly Card[]): Card[] {
  const usedKeys = new Set(used.map(cardKey));
  return pool.filter((c) => !usedKeys.has(cardKey(c)));
}

/** 判断某张牌是否已在给定集合中 */
export function containsCard(cards: readonly Card[], card: Card): boolean {
  const key = cardKey(card);
  return cards.some((c) => cardKey(c) === key);
}

export const RANKS = ALL_RANKS;
export const SUITS = ALL_SUITS;
export type { Card, Rank, Suit };
