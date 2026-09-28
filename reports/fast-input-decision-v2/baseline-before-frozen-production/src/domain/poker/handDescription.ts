/**
 * 牌力中文描述生成（只输出码值 + 参数，中文由 i18n 渲染）
 *
 * 规范第 19 / 20 条。
 *
 * 输出示例（界面层渲染后）：
 *   当前牌力：顶两对 KQ
 *   当前牌力：J三条，Q踢脚
 *   当前牌力：公共牌就是最佳五张牌（打公共牌）
 */

import { HandCategory, Rank, RANK_CHARS, type Card } from '../types.ts';
import {
  HandCategoryLabelCode,
  HandRelationCode,
  HandShapeCode,
  type HandCategoryLabelCode as CategoryCode,
} from '../domainCodes.ts';
import { bestFiveOf, boardIsBestFive, evaluateCards, usesHoleCards } from './handEval.ts';
import { cardKey } from './cards.ts';

export type HandShape =
  | 'HIGH_CARD'
  | 'OVERPAIR'
  | 'TOP_PAIR'
  | 'OVERPAIR_TOP'
  | 'MIDDLE_PAIR'
  | 'BOTTOM_PAIR'
  | 'UNDERPAIR'
  | 'POCKET_PAIR_OVER'
  | 'TWO_PAIR'
  | 'TOP_TWO_PAIR'
  | 'SET'
  | 'TRIPS'
  | 'STRAIGHT'
  | 'FLUSH'
  | 'FULL_HOUSE'
  | 'QUADS'
  | 'STRAIGHT_FLUSH'
  | 'PLAY_THE_BOARD';

export type HandDescription = {
  /** 牌型（9 类）中文码值 */
  categoryCode: CategoryCode;
  category: HandCategory;
  /** 强度编码 */
  value: number;
  /** 关键点数（降序） */
  keyRanks: Rank[];
  /** 全部关键点数的显示字符，例如 "KQ" */
  keyRankText: string;
  /** 形态码值，例如顶两对 / 暗三条 */
  shapeCode: HandShapeCode;
  shape: HandShape;
  /** 形态涉及的点数（通常是底牌的点数） */
  shapeRanks: Rank[];
  /** 踢脚点数（若踢脚起作用） */
  kickerRank?: Rank;
  /** 关系码值列表 */
  relationCodes: HandRelationCode[];
  /** 底牌是否参与成牌 */
  holeCardsPlay: boolean;
  /** 公共牌是否就是最佳五张牌 */
  boardIsBest: boolean;
  /** 最佳五张 */
  bestFive: Card[];
};

function categoryCodeOf(category: HandCategory): CategoryCode {
  switch (category) {
    case HandCategory.HIGH_CARD:
      return HandCategoryLabelCode.HIGH_CARD;
    case HandCategory.ONE_PAIR:
      return HandCategoryLabelCode.ONE_PAIR;
    case HandCategory.TWO_PAIR:
      return HandCategoryLabelCode.TWO_PAIR;
    case HandCategory.THREE_OF_A_KIND:
      return HandCategoryLabelCode.THREE_OF_A_KIND;
    case HandCategory.STRAIGHT:
      return HandCategoryLabelCode.STRAIGHT;
    case HandCategory.FLUSH:
      return HandCategoryLabelCode.FLUSH;
    case HandCategory.FULL_HOUSE:
      return HandCategoryLabelCode.FULL_HOUSE;
    case HandCategory.FOUR_OF_A_KIND:
      return HandCategoryLabelCode.FOUR_OF_A_KIND;
    default:
      return HandCategoryLabelCode.STRAIGHT_FLUSH;
  }
}

function rankText(ranks: readonly Rank[]): string {
  return ranks.map((r) => RANK_CHARS[r] ?? '?').join('');
}

/** 找出最佳五张中来自底牌的点数（去重、降序） */
function holeRanksInBestFive(holeCards: readonly Card[], bestFive: readonly Card[]): Rank[] {
  const bestKeys = new Set(bestFive.map(cardKey));
  const ranks = new Set<Rank>();
  for (const card of holeCards) {
    if (bestKeys.has(cardKey(card))) ranks.add(card.rank);
  }
  return [...ranks].sort((a, b) => b - a);
}

/**
 * 生成牌力描述。
 * @param holeCards 你的两张底牌
 * @param board 公共牌（0~5 张）
 */
export function describeHand(holeCards: readonly Card[], board: readonly Card[]): HandDescription {
  if (holeCards.length !== 2) {
    throw new Error(`describeHand: 底牌必须是 2 张，收到 ${holeCards.length} 张`);
  }
  const all = [...holeCards, ...board];
  if (all.length < 5) {
    throw new Error(`describeHand: 底牌加公共牌至少 5 张，当前 ${all.length} 张`);
  }

  const evaluated = evaluateCards(all);
  const bestFive = bestFiveOf(all);
  const boardBest = boardIsBestFive(holeCards, board);
  const holePlays = usesHoleCards(holeCards, board);
  const involved = holeRanksInBestFive(holeCards, bestFive);

  const boardRanks = [...new Set(board.map((c) => c.rank))].sort((a, b) => b - a);
  const topBoardRank = boardRanks[0] ?? 0;

  const [h1, h2] = [holeCards[0]!.rank, holeCards[1]!.rank];
  const isPocketPair = h1 === h2;
  const pocketRank = isPocketPair ? h1 : 0;

  let shape: HandShape;
  let shapeRanks: Rank[] = involved.length > 0 ? involved : [h1, h2].sort((a, b) => b - a);
  let kickerRank: Rank | undefined;

  const cat = evaluated.category;

  if (!holePlays) {
    /**
     * 「打公共牌」必须在牌型分发**之前**判定。
     *
     * 否则会输出「同花顺 A」这类描述 —— 数字没错，但会让用户误以为
     * 是自己的底牌起了作用，掩盖了「公共牌就是最佳五张牌」这个关键事实
     * （例如公共牌本身是皇家同花顺时，任何底牌都无关紧要）。
     */
    shape = 'PLAY_THE_BOARD';
    shapeRanks = evaluated.ranks.slice();
  } else if (cat === HandCategory.STRAIGHT_FLUSH) {
    shape = 'STRAIGHT_FLUSH';
    shapeRanks = evaluated.ranks;
  } else if (cat === HandCategory.FOUR_OF_A_KIND) {
    shape = 'QUADS';
    shapeRanks = [evaluated.ranks[0]!];
    kickerRank = evaluated.ranks[1];
  } else if (cat === HandCategory.FULL_HOUSE) {
    shape = 'FULL_HOUSE';
    shapeRanks = [evaluated.ranks[0]!, evaluated.ranks[1]!];
  } else if (cat === HandCategory.FLUSH) {
    shape = 'FLUSH';
    shapeRanks = involved.length > 0 ? involved : evaluated.ranks.slice(0, 1);
  } else if (cat === HandCategory.STRAIGHT) {
    shape = 'STRAIGHT';
    shapeRanks = involved.length > 0 ? involved : evaluated.ranks.slice(0, 1);
  } else if (cat === HandCategory.THREE_OF_A_KIND) {
    const tripRank = evaluated.ranks[0]!;
    shape = isPocketPair && pocketRank === tripRank ? 'SET' : 'TRIPS';
    shapeRanks = [tripRank];
    // 明三条时踢脚可能起作用
    if (shape === 'TRIPS') kickerRank = evaluated.ranks[1];
  } else if (cat === HandCategory.TWO_PAIR) {
    const [hi, lo] = [evaluated.ranks[0]!, evaluated.ranks[1]!];
    // 顶两对：两对中的高点数为牌面最大牌，且两对都用到了牌面
    const topTwo =
      hi === topBoardRank && boardRanks.includes(lo) && (involved.includes(hi) || involved.includes(lo));
    shape = topTwo ? 'TOP_TWO_PAIR' : 'TWO_PAIR';
    shapeRanks = [hi, lo];
    kickerRank = evaluated.ranks[2];
  } else if (cat === HandCategory.ONE_PAIR) {
    const pairRank = evaluated.ranks[0]!;
    kickerRank = evaluated.ranks[1];
    if (isPocketPair && pocketRank === pairRank) {
      shape = pocketRank > topBoardRank ? 'OVERPAIR' : 'UNDERPAIR';
      shapeRanks = [pairRank];
    } else if (pairRank === topBoardRank) {
      shape = 'TOP_PAIR';
      shapeRanks = [pairRank];
    } else if (boardRanks.length >= 2 && pairRank === boardRanks[1]) {
      shape = 'MIDDLE_PAIR';
      shapeRanks = [pairRank];
    } else if (pairRank === boardRanks[boardRanks.length - 1]) {
      shape = 'BOTTOM_PAIR';
      shapeRanks = [pairRank];
    } else {
      shape = 'BOTTOM_PAIR';
      shapeRanks = [pairRank];
    }
  } else {
    // 高牌
    shape = 'HIGH_CARD';
    shapeRanks = involved.length > 0 ? involved : evaluated.ranks.slice(0, 2);
  }

  const shapeCode = HandShapeCode[shape];

  const relationCodes: HandRelationCode[] = [];
  if (holePlays) relationCodes.push(HandRelationCode.HOLE_CARDS_PLAY);
  if (boardBest) relationCodes.push(HandRelationCode.BOARD_IS_BEST_FIVE);
  if (kickerRank !== undefined) relationCodes.push(HandRelationCode.KICKER_PLAYS);

  return {
    categoryCode: categoryCodeOf(evaluated.category),
    category: evaluated.category,
    value: evaluated.value,
    keyRanks: evaluated.ranks,
    keyRankText: rankText(evaluated.ranks),
    shapeCode,
    shape,
    shapeRanks,
    kickerRank,
    relationCodes,
    holeCardsPlay: holePlays,
    boardIsBest: boardBest,
    bestFive,
  };
}
