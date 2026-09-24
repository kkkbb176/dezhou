/**
 * 🔴 **对手范围的牌面事实**（2026-09 翻后升级 · P2 数据层）
 *
 * ## 为什么必须有这一层
 *
 * P1 的 `BoardDelta.villainRangeImprovement` 回答「这张牌对他的范围有没有帮助」，
 * 而这个问题**只有他的范围能回答**。不做「我觉得这张 A 帮到他了」这种猜测 ——
 * 那是编造数据（规范第十四节禁令）。
 *
 * 因此本模块把**真实范围**（`Range.entries` 的逐组合概率）与当前牌面结合，
 * 产出可直接使用的统计量：
 *
 * | 输出 | 定义 |
 * |---|---|
 * | `strongShare` | 范围里「在当前牌面上已成强牌（相对档 ≤2）」的概率质量 |
 * | `topPairPlusShare` | 同上（顶对及以上）—— 与 `strongShare` 同源，单独命名便于界面区分 |
 * | `meanTier` | 概率加权的平均相对档位（0 最强 .. 5 最弱） |
 * | `suitFit` | 范围里持有**牌面主导花色**的概率质量（衡量「牌面跟他的花色有多贴合」） |
 * | `drawShare` | 范围里有**真听牌**（同花听/两头顺）的概率质量 |
 * | `tierHistogram` | 逐档（0..5）的概率质量占比 |
 * | `weakerShare` / `equalShare` / `strongerShare` | 逐组合与**我方底牌**精确比大小后的质量分布 |
 *
 * ⚠️ 全部是**对已知范围的重新加权统计**，不是对未知信息的猜测；
 * 也没有引入任何新的先验。
 *
 * ## 🔴 为什么必须有「与我的牌比较」这一组字段（对抗性审计修复）
 *
 * 审计实测反例（真实管线，Hero BTN A♣Q♣ 坚果同花，牌面 K♠K♦6♣2♣9♣，
 * UTG 三条街全过牌）：
 *
 * ```text
 * 权益 = 94.7%   （我对他的范围遥遥领先）
 * strongShare = 1.0000 ⇒ strengthFloor = 1.0000 ⇒ worseCallDensity = 0.049
 * ⇒ 判定 NOT_VALUE、引擎过牌
 * ```
 *
 * 两句话直接自相矛盾：**「我领先 94.7%」与「没有任何更差的牌能跟」不可能同时成立**。
 * 根因是「有哪些更差的牌会跟」这个问题的口径错了 —— 它是**相对于我的牌**的
 * 问题（更差 = 比我这手牌差），却被用「他的范围整体有多强」来回答。
 * 成对牌面上（人人都是「一对 K」）后者必然饱和到 1。
 *
 * 现在这一问**只**由 `weakerShare` 回答，而它来自 `handEval.compareHands`
 * 的**精确**比较（不是档位近似），因此「我拿坚果 ⇒ 几乎全是更差的牌」
 * 在任何牌面上都成立，与 `strongShare` 是否饱和无关。
 */

import type { Card } from '../../domain/types.ts';
import type { Range } from '../../domain/range/range.types.ts';
import { boardRelativeTierOf } from '../../domain/poker/boardRelativeStrength.ts';
import { compareHands, evaluateCards, type EvaluatedHand } from '../../domain/poker/handEval.ts';
import { drawProfileOf } from '../../domain/postflop/draws.ts';
import { suitCountsOf } from '../../domain/postflop/draws.ts';
import { riverActionCountsOf, riverActionMassesOf } from '../../domain/postflop/riverActionClass.ts';
import { riverComboClassOf } from '../../domain/postflop/riverProfileClassify.ts';
import {
  effectiveCombosOf,
  posteriorMassCombosOf,
} from '../../domain/player/profileRangeMetrics.ts';
import type { RiverComboClass } from '../../domain/player/behaviorProfile.ts';
import { SUIT_ORDER } from '../../domain/postflop/suit.ts';
import { ALL_CARDS } from '../../domain/types.ts';
import type { OpponentRangeFacts } from '../../domain/postflop/types.ts';

/** 牌面主导花色（出现最多的花色）；牌面不足 3 张时返回 null */
function dominantSuitOf(board: readonly Card[]): string | null {
  if (board.length < 3) return null;
  const counts = suitCountsOf(board);
  const max = Math.max(...counts);
  if (max < 2) return null; // 没有花色成对 ⇒ 不存在「主导花色」
  return SUIT_ORDER[counts.indexOf(max)]!;
}

/**
 * 计算对手范围的牌面事实。
 *
 * @param range 对手范围（概率已按行动历史重加权）
 * @param board 当前公共牌（≥3 张）
 * @param heroHole 我方底牌 —— **必传**：`weakerShare` / `strongerShare` 是
 *   相对于这手牌的量，缺了它这两问就没有正确口径（审计抓到的 CRITICAL 正是
 *   用「他的范围有多强」冒充了这两问）。
 * @returns 牌面不足 3 张（翻前）、范围为空、或缺我方底牌时返回 `null`
 *   —— **不返回编造的 0**
 */
export function opponentRangeFactsOf(
  range: Range | null,
  board: readonly Card[],
  heroHole: readonly Card[],
): OpponentRangeFacts | null {
  if (range === null || board.length < 3) return null;
  if (heroHole.length !== 2) return null;

  const heroSet = new Set(heroHole.map((c) => `${c.rank}${c.suit}`));
  const boardSet = new Set(board.map((c) => `${c.rank}${c.suit}`));

  /*
   * 我方 7 张的牌力。`describeHand` 已在其它模块用过，这里用更底层的
   * `evaluateCards` 是因为需要**逐组合比较**（`compareHands` 的输入类型）。
   * 两者同为 `handEval` 的产物，不存在第二套牌力判定。
   */
  let heroEval: EvaluatedHand | null = null;
  try {
    heroEval = evaluateCards([...heroHole, ...board]);
  } catch {
    heroEval = null; // 底牌与公共牌重叠等畸形输入 ⇒ 退化为「只统计范围本身」
  }

  const dominant = dominantSuitOf(board);
  const histogram = [0, 0, 0, 0, 0, 0];
  let total = 0;
  let strong = 0;
  let tierSum = 0;
  let suitFit = 0;
  let draws = 0;
  let weaker = 0;
  let equal = 0;
  let stronger = 0;
  let supportSize = 0;

  for (const entry of range.entries) {
    const p = entry.probability;
    if (!(p > 0)) continue;
    supportSize += 1;
    const hole: [Card, Card] = [
      ALL_CARDS[entry.combo.cardIndices[0]]!,
      ALL_CARDS[entry.combo.cardIndices[1]]!,
    ];
    total += p;

    const tier = boardRelativeTierOf(hole, board);
    const effectiveTier = tier ?? 5;
    tierSum += p * effectiveTier;
    histogram[effectiveTier] += p;
    if (effectiveTier <= 2) strong += p;

    if (dominant !== null && hole.some((c) => c.suit === dominant)) suitFit += p;

    const draw = drawProfileOf(hole, board);
    if (draw.flushDraw || draw.openEnded) draws += p;

    /*
     * 与我的牌精确比大小。组合与我方底牌/公共牌重叠时跳过 ——
     * 那些组合在实践中已被死牌剔除，这里只是**防御性**判断，
     * 并且如实不计入任何一侧（而不是把它们当成「更差」）。
     */
    if (heroEval === null) continue;
    if (hole.some((c) => heroSet.has(`${c.rank}${c.suit}`) || boardSet.has(`${c.rank}${c.suit}`))) {
      continue;
    }
    let cmp: number;
    try {
      cmp = compareHands(evaluateCards([...hole, ...board]), heroEval);
    } catch {
      continue;
    }
    if (cmp < 0) weaker += p;
    else if (cmp > 0) stronger += p;
    else equal += p;
  }

  if (!(total > 0)) return null;

  /*
   * 🔴 **逐组合的河牌动作分类计数**（RIVER CONSISTENCY V2.1 · P1-1）。
   *
   * 「比 Hero 强 / 弱」与「会下注取值 / 会诈唬」是**两种不同的量**：
   * 弱牌里绝大多数是摊牌牌（有过牌摊牌价值），不会诈唬。
   * 因此这里额外跑一遍分类，并把**整数计数**交给上层 —— 只有当分类完成后，
   * 才允许使用 `valueBetCandidate` / `bluffCandidate` 这两个词。
   */
  const counts = riverActionCountsOf({
    entries: range.entries.map((e) => ({
      cardIndices: e.combo.cardIndices as unknown as readonly [number, number],
      probability: e.probability,
    })),
    board,
    heroHole,
  });

  /*
   * 🔴 **质量口径**（P0 修复）：画像只改概率、不改组合数，
   * 因此「画像有没有起作用」只有质量口径看得见（见 `riverActionMassesOf`）。
   */
  const actionMasses = riverActionMassesOf({
    entries: range.entries.map((e) => ({
      cardIndices: e.combo.cardIndices as unknown as readonly [number, number],
      probability: e.probability,
    })),
    board,
    heroHole,
  });

  /*
   * 🔴 **画像手牌类别的质量分解**（PLAYER PROFILE QUANTIFICATION V1 · §二十）。
   *
   * 用 `riverComboClassOf`（画像模型的**同一套判据**）再累加一遍，
   * 使「画像到底把哪些牌推多了」在证据里**看得见**：
   * `actionMasses` 只到「诈唬候选」这一层，分不出
   * 「错过听牌」与「纯空气」，而 §二十 要求它们是两条独立断言。
   *
   * ⚠️ 与 `riverActionMassesOf` 同一纪律：与 Hero/公共牌重叠的组合
   * 不计入任何一侧；分类失败的质量单列 `unclassifiedMass`（不猜）。
   */
  const profileClassMasses = (() => {
    let total = 0;
    let reachable = 0;
    let unclassified = 0;
    /** 后验权重（用于 §二十七 等效组合数与 §二十八 质量集中度） */
    const weights: number[] = [];
    const byClass: Record<RiverComboClass, number> = {
      NUT_VALUE: 0,
      STRONG_VALUE: 0,
      THIN_VALUE: 0,
      SHOWDOWN_VALUE: 0,
      MISSED_FLUSH_DRAW: 0,
      MISSED_STRAIGHT_DRAW: 0,
      MISSED_COMBO_DRAW: 0,
      PURE_AIR: 0,
    };
    for (const entry of range.entries) {
      const p = entry.probability;
      if (!(p > 0)) continue;
      const hole: [Card, Card] = [
        ALL_CARDS[entry.combo.cardIndices[0]]!,
        ALL_CARDS[entry.combo.cardIndices[1]]!,
      ];
      if (hole.some((c) => heroSet.has(`${c.rank}${c.suit}`) || boardSet.has(`${c.rank}${c.suit}`))) {
        continue;
      }
      reachable += 1;
      total += p;
      weights.push(p);
      const comboClass = riverComboClassOf({ hole, board, heroHole });
      if (comboClass === null) {
        unclassified += p;
        continue;
      }
      byClass[comboClass.category] += p;
    }
    if (!(total > 0)) return null;
    const missedDrawMass =
      byClass.MISSED_FLUSH_DRAW + byClass.MISSED_STRAIGHT_DRAW + byClass.MISSED_COMBO_DRAW;
    const valueMass = byClass.NUT_VALUE + byClass.STRONG_VALUE + byClass.THIN_VALUE;
    return {
      totalMass: total,
      reachableRangeCount: reachable,
      nutValueMass: byClass.NUT_VALUE,
      strongValueMass: byClass.STRONG_VALUE,
      thinValueMass: byClass.THIN_VALUE,
      showdownMass: byClass.SHOWDOWN_VALUE,
      missedFlushMass: byClass.MISSED_FLUSH_DRAW,
      missedStraightMass: byClass.MISSED_STRAIGHT_DRAW,
      missedComboMass: byClass.MISSED_COMBO_DRAW,
      pureAirMass: byClass.PURE_AIR,
      valueMass,
      missedDrawMass,
      bluffMass: missedDrawMass + byClass.PURE_AIR,
      unclassifiedMassShare: unclassified / total,
      /*
       * V2 §二十七 / §二十八 —— 让「组合数」不再被读成「等权手牌数」。
       * 精确定义见 `domain/player/profileRangeMetrics.ts` 的文件头。
       */
      rawSupportCombos: reachable,
      effectiveCombos: effectiveCombosOf(weights),
      posteriorMassCombos90: posteriorMassCombosOf(weights, 0.9),
      posteriorMassCombos95: posteriorMassCombosOf(weights, 0.95),
    };
  })();

  return {
    strongShare: strong / total,
    // 「顶对及以上」与「强牌档」同源：档 ≤2 已经涵盖顶对/超对/两对/强成手
    topPairPlusShare: strong / total,
    meanTier: tierSum / total,
    suitFit: suitFit / total,
    drawShare: draws / total,
    tierHistogram: Object.freeze(histogram.map((m) => m / total)),
    weakerShare: weaker / total,
    equalShare: equal / total,
    strongerShare: stronger / total,
    supportSize,
    counts,
    actionMasses,
    profileClassMasses,
  };
}
