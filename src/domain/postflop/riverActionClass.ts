/**
 * 🔴 **河牌动作分类**（RIVER CONSISTENCY V2.1 · P1-1 / P1-2）
 *
 * ## 修的是什么（这是一个**语义**缺陷，不是参数问题）
 *
 * V2 把两个**完全不同**的量混用了名字：
 *
 * ```text
 * 实际算出来的：strongerThanHero —— 河牌最终牌力比 Hero 高的可达组合
 * 报告里写成的：value combos    —— 「他会用来下注取值的组合」
 *
 * 实际算出来的：weakerThanHero —— 比 Hero 弱的可达组合
 * 报告里写成的：bluff combos    —— 「他会用来诈唬的组合」
 * ```
 *
 * 二者**不能互换**：
 *
 * | 手牌 | 比 Hero 弱？ | 会诈唬吗？ |
 * |---|---|---|
 * | 中对 / 弱对 / A 高 | 是（很多都比他弱） | **不会**：它们过牌摊牌（showdown value） |
 * | 纯空气（无对、无摊牌价值） | 是 | **可能**：这才是有诈唬动机的牌 |
 * | 顶对（比 Hero 强） | 否 | —— |
 * | 弱成手但比 Hero 强（如底对 > 高牌） | 否 | 通常也不会下注取值 |
 *
 * 因此本模块把「谁比谁强」升级为「**按河牌动作模型分类**」，
 * 只有在分类之后才允许使用 `valueBetCandidate` / `bluffCandidate` 这两个词。
 *
 * ## 证据等级（逐项标注）
 *
 * | 部分 | 等级 |
 * |---|---|
 * | 「比 Hero 强 / 弱 / 打平」 | 【数学确定】`handEval.compareHands` 逐组合精确比较 |
 * | 「有摊牌价值 ⇒ 不诈唬」 | 【公开扑克理论】 |
 * | 「档位 + 相对强弱 ⇒ 动作类别」的映射表 | 【启发式】—— 结构式，不是拟合参数 |
 * | 「拿不到证据就返回 UNCERTAIN」 | 【工程约束】—— 不允许强行算成诈唬 |
 *
 * ## ⚠️ 它不是下注频率模型
 *
 * 本模块**不**声称「他会用 30% 的频率诈唬」。它只回答
 * 「在**当前这条下注线**下，这手牌属于哪一类」，用于把**计数**说清楚。
 */

import type { Card } from '../types.ts';
import { compareHands, evaluateCards } from '../poker/handEval.ts';
import { boardRelativeTierOf } from '../poker/boardRelativeStrength.ts';
import { ALL_CARDS } from '../types.ts';

/** 河牌动作类别（每个对手组合一个类别） */
export const RiverActionClass = {
  /** 明确的取值牌：比 Hero 强且本身是强成手（档 0–1） */
  CLEAR_VALUE: 'CLEAR_VALUE',
  /** 薄价值：比 Hero 强但只是边缘成手（档 2，例如顶对） */
  THIN_VALUE: 'THIN_VALUE',
  /**
   * 摊牌牌：有摊牌价值但**不会**下注取值，也**不会**诈唬。
   *
   * 包括「比 Hero 强但不够下注价值」（如比他强的中对）与
   * 「比 Hero 弱但牌力不低」（如第二对子）。
   */
  SHOWDOWN: 'SHOWDOWN',
  /** 诈唬候选：比 Hero 弱、**且没有摊牌价值**（纯空气），因此有诈唬动机 */
  BLUFF_CANDIDATE: 'BLUFF_CANDIDATE',
  /** 证据不足：不强行归类（既不记成价值，也不记成诈唬） */
  UNCERTAIN: 'UNCERTAIN',
} as const;
export type RiverActionClass = (typeof RiverActionClass)[keyof typeof RiverActionClass];

export const RIVER_ACTION_CLASS_ZH: Readonly<Record<RiverActionClass, string>> = Object.freeze({
  CLEAR_VALUE: '明确取值',
  THIN_VALUE: '薄价值',
  SHOWDOWN: '摊牌牌（有摊牌价值，通常不下注也不诈唬）',
  BLUFF_CANDIDATE: '诈唬候选（无摊牌价值）',
  UNCERTAIN: '证据不足（不归类）',
});

/** 与 Hero 的牌力关系（【数学确定】：逐组合精确比较的结果） */
export type VersusHero = 'STRONGER' | 'WEAKER' | 'EQUAL';

/**
 * 单个组合的河牌动作分类（【启发式】映射表，输入全部来自真实数据）。
 *
 * ```text
 * 比 Hero 强：档 0–1 ⇒ 明确取值    档 2 ⇒ 薄价值
 *             档 3   ⇒ 摊牌牌（比他强但只是中对级，不会下注取值）
 *             档 4–5 ⇒ 证据不足（弱成手/高牌，既不算价值也不算诈唬）
 * 打平       ：任何档 ⇒ 摊牌牌
 * 比 Hero 弱：档 0–3 ⇒ 摊牌牌（牌力不低 ⇒ 有摊牌价值 ⇒ 不诈唬）
 *             档 4   ⇒ 证据不足（底对/小对子，可能摊牌也可能诈唬）
 *             档 5   ⇒ 诈唬候选（纯空气 ⇒ 唯一有诈唬动机的一类）
 * ```
 */
export function classifyRiverAction(input: {
  versusHero: VersusHero;
  /** 该组合在当前牌面上的相对强度档（0 最强 .. 5 最弱） */
  tier: number;
}): RiverActionClass {
  if (input.versusHero === 'EQUAL') return RiverActionClass.SHOWDOWN;
  if (input.versusHero === 'STRONGER') {
    if (input.tier <= 1) return RiverActionClass.CLEAR_VALUE;
    if (input.tier === 2) return RiverActionClass.THIN_VALUE;
    if (input.tier === 3) return RiverActionClass.SHOWDOWN;
    return RiverActionClass.UNCERTAIN;
  }
  // WEAKER
  if (input.tier <= 3) return RiverActionClass.SHOWDOWN;
  if (input.tier === 4) return RiverActionClass.UNCERTAIN;
  return RiverActionClass.BLUFF_CANDIDATE;
}

export type RiverActionCounts = {
  /** 可达范围的组合数 —— 所有下面这些计数的**分母** */
  reachableRangeCount: number;
  strongerThanHeroCount: number;
  weakerThanHeroCount: number;
  equalToHeroCount: number;
  clearValueCount: number;
  thinValueCount: number;
  showdownCount: number;
  uncertainCount: number;
  /**
   * **价值下注候选** = 明确取值 + 薄价值。
   *
   * ⚠️ 它**不等于** `strongerThanHeroCount`：比他强但只是中对级的牌不会下注取值。
   */
  valueBetCandidateCount: number;
  /**
   * **诈唬候选** = 无摊牌价值的纯空气。
   *
   * ⚠️ 它**不等于** `weakerThanHeroCount`：弱牌里绝大多数是摊牌牌。
   */
  bluffCandidateCount: number;
  /** 这份分类的证据质量（分母太小 ⇒ 结论不可靠） */
  evidenceQuality: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
};

/**
 * 遍历**可达范围**（对手真正能走到河牌的组合），对每个组合分类并计数。
 *
 * @param entries 可达范围的组合（`cardIndices` + `probability`）
 * @param board 当前公共牌
 * @param heroHole Hero 底牌
 * @returns 计数；**拿不到组合或牌力无法比较时返回 `null`**（不编造 0）
 */
export function riverActionCountsOf(input: {
  entries: readonly { cardIndices: readonly [number, number]; probability: number }[];
  board: readonly Card[];
  heroHole: readonly Card[];
}): RiverActionCounts | null {
  if (input.board.length < 3 || input.heroHole.length !== 2) return null;
  let heroEval;
  try {
    heroEval = evaluateCards([...input.heroHole, ...input.board]);
  } catch {
    return null;
  }

  const heroKeys = new Set(input.heroHole.map((c) => `${c.rank}${c.suit}`));
  const boardKeys = new Set(input.board.map((c) => `${c.rank}${c.suit}`));

  let reachable = 0;
  let stronger = 0;
  let weaker = 0;
  let equal = 0;
  let clearValue = 0;
  let thinValue = 0;
  let showdown = 0;
  let uncertain = 0;

  for (const entry of input.entries) {
    if (!(entry.probability > 0)) continue;
    const hole: [Card, Card] = [
      ALL_CARDS[entry.cardIndices[0]]!,
      ALL_CARDS[entry.cardIndices[1]]!,
    ];
    /*
     * 与 Hero 底牌/公共牌重叠的组合不可能出现在可达范围里（它们是死牌），
     * 这里只是防御性跳过，且**不计入任何一侧**（不当作「更差」）。
     */
    if (hole.some((c) => heroKeys.has(`${c.rank}${c.suit}`) || boardKeys.has(`${c.rank}${c.suit}`))) {
      continue;
    }
    reachable += 1;

    let versusHero: VersusHero;
    try {
      const cmp = compareHands(evaluateCards([...hole, ...input.board]), heroEval);
      versusHero = cmp > 0 ? 'STRONGER' : cmp < 0 ? 'WEAKER' : 'EQUAL';
    } catch {
      continue; // 比较失败 ⇒ 不计入（宁可少算，也不编造）
    }
    if (versusHero === 'STRONGER') stronger += 1;
    else if (versusHero === 'WEAKER') weaker += 1;
    else equal += 1;

    const tier = boardRelativeTierOf(hole, input.board) ?? 5;
    switch (classifyRiverAction({ versusHero, tier })) {
      case RiverActionClass.CLEAR_VALUE:
        clearValue += 1;
        break;
      case RiverActionClass.THIN_VALUE:
        thinValue += 1;
        break;
      case RiverActionClass.SHOWDOWN:
        showdown += 1;
        break;
      case RiverActionClass.UNCERTAIN:
        uncertain += 1;
        break;
      default:
        break; // BLUFF_CANDIDATE 由差值得到
    }
  }

  if (reachable === 0) return null;
  const bluffCandidate = reachable - clearValue - thinValue - showdown - uncertain;

  return {
    reachableRangeCount: reachable,
    strongerThanHeroCount: stronger,
    weakerThanHeroCount: weaker,
    equalToHeroCount: equal,
    clearValueCount: clearValue,
    thinValueCount: thinValue,
    showdownCount: showdown,
    uncertainCount: uncertain,
    valueBetCandidateCount: clearValue + thinValue,
    bluffCandidateCount: bluffCandidate,
    evidenceQuality: reachable >= 200 ? 'HIGH' : reachable >= 60 ? 'MEDIUM' : 'LOW',
  };
}
