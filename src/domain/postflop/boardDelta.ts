/**
 * 🔴 **Board Delta Engine**（2026-09 翻后升级 · P1 · C3 的上层）
 *
 * ## 为什么必须有它
 *
 * 审计实测：修复前引擎里**完全没有**「新牌改变了什么」这个概念 ——
 * 空白河牌与三张黑桃河牌输出**逐位相同**的决策与理由码。
 * `domainCodes.ts` 里 20 个 `BoardTextureCode`（含 `FLUSH_COMPLETE` /
 * `BLANK_TURN` / `DANGER_CARD`）**有定义、有中文翻译、零生产者零消费者**。
 *
 * ## 关键纪律：输出**数值**，不是布尔
 *
 * 使用者明确要求：不许 `if (flushCompleted) then check`。因此本模块只回答
 * 「这张牌把局面往哪个方向推、推了多少（0..1）」，**不做任何动作判断** ——
 * 动作由 EV 比较决定（见 `evScore.ts`）。
 *
 * 典型反例（本模块**不会**做的事）：
 *
 * ```text
 * ✗ 同花完成 ⇒ 过牌          （坚果同花仍然该下注；阻断牌诈唬仍然是好牌）
 * ✗ 河牌是空白 ⇒ 恢复下注     （相对牌力不因「牌面没变」而回升）
 * ✗ 出现 A ⇒ 停止下注         （A 可能提高我们的范围而不是对手的）
 * ```
 *
 * ## 字段的语义（每个都必须能被验证）
 *
 * | 字段 | 含义 | 取值 |
 * |---|---|---|
 * | `overcardImpact` | 新牌相对**当前牌面**有多高（是不是高张） | 0..1 |
 * | `flushCompleted` | 牌面已有 4/5 张同花色（同花**可能已成**） | bool |
 * | `straightCompleted` | 牌面 5 张里已有 5 连的**结构**（顺子可能已成） | bool |
 * | `fourToFlush` | 牌面 4 张同花色（转牌/河牌的同花听牌面） | bool |
 * | `fourToStraight` | 牌面 4 张连（顺子听牌面） | bool |
 * | `pairedBoard` | 公共牌出现对子（含三条） | bool |
 * | `nutShift` | 坚果归属往哪边移（+ = 偏对手，− = 偏我们） | −1..1 |
 * | `heroRelativeStrengthChange` | 我们这手牌的相对档位跨街变化（用形态档差） | −5..5 |
 * | `villainRangeImprovement` | 对手范围与**新牌面**的适配提升（需范围事实） | 0..1 or null |
 * | `heroRangeImprovement` | 同上，我们这一侧（用我方补牌/成手变化估计） | 0..1 |
 * | `blankScore` | 越接近 1 越「白板」（什么都没改变） | 0..1 |
 */

import type { Card, Street } from '../types.ts';
import { describeHand } from '../poker/handDescription.ts';
import { boardRelativeTierOf } from '../poker/boardRelativeStrength.ts';
import type { DrawProfile, OpponentRangeFacts } from './types.ts';
import { drawProfileOf, suitCountsOf, rankSetOf } from './draws.ts';
import { suitIndexOfCard } from './suit.ts';

export type BoardDelta = {
  overcardImpact: number;
  flushCompleted: boolean;
  straightCompleted: boolean;
  pairedBoard: boolean;
  fourToStraight: boolean;
  fourToFlush: boolean;
  nutShift: number;
  heroRelativeStrengthChange: number;
  villainRangeImprovement: number | null;
  heroRangeImprovement: number;
  blankScore: number;
};

/** 牌面结构事实（与「上一街相比」无关的部分，单独可测） */
export type BoardTextureFacts = {
  suitCounts: readonly number[];
  maxSuitCount: number;
  pairedBoard: boolean;
  tripsOnBoard: boolean;
  fourToFlush: boolean;
  flushPossible: boolean;
  /** 顺子结构：牌面点数能组成的最大连续长度（含 A 两头） */
  maxRunLength: number;
  fourToStraight: boolean;
  straightPossible: boolean;
  highestRank: number;
};

/** 计算牌面结构（`board` 必须 ≥3 张；不足时返回 null） */
export function boardTextureOf(board: readonly Card[]): BoardTextureFacts | null {
  if (board.length < 3) return null;
  const suitCounts = suitCountsOf(board);
  const maxSuitCount = Math.max(...suitCounts);
  const ranks = [...rankSetOf(board)].sort((a, b) => b - a);
  const counts = new Map<number, number>();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  const pairedBoard = [...counts.values()].some((n) => n >= 2);
  const tripsOnBoard = [...counts.values()].some((n) => n >= 3);

  // 最长的连续点数（把 A 当 1 也算，处理 A2345）
  const present = new Set<number>(ranks);
  if (present.has(14)) present.add(1);
  let maxRunLength = 0;
  let run = 0;
  for (let rank = 1; rank <= 14; rank += 1) {
    if (present.has(rank)) {
      run += 1;
      maxRunLength = Math.max(maxRunLength, run);
    } else {
      run = 0;
    }
  }

  return {
    suitCounts,
    maxSuitCount,
    pairedBoard,
    tripsOnBoard,
    fourToFlush: maxSuitCount >= 4,
    /*
     * 「同花可能」= 牌面有 3 张同花色：任何**手里有该花色**的人都已成花，
     * 因此它已经改变了范围构成（不是等到第 5 张才算）。
     */
    flushPossible: maxSuitCount >= 3,
    maxRunLength,
    fourToStraight: maxRunLength >= 4,
    straightPossible: maxRunLength >= 3,
    highestRank: ranks[0] ?? 0,
  };
}

/**
 * 计算「上一街 → 这一街」的变化。
 *
 * @param previousBoard 上一街的公共牌（翻牌时传空数组 ⇒ 与「无」比较）
 * @param rangeFacts 对手范围事实（拿不到传 null ⇒ 相应字段为 null）
 */
export function computeBoardDelta(input: {
  previousBoard: readonly Card[];
  board: readonly Card[];
  heroHole: readonly Card[];
  street: Street;
  rangeFacts: OpponentRangeFacts | null;
  /** 上一街我方的相对档位（0 最强 .. 5 最弱）；没有则 null */
  previousTier: number | null;
}): BoardDelta | null {
  const texture = boardTextureOf(input.board);
  if (texture === null) return null;

  const before = boardTextureOf(input.previousBoard);
  const newCard = input.board.length > input.previousBoard.length
    ? input.board[input.board.length - 1]
    : null;

  /*
   * overcardImpact：新牌比**此前的牌面**高多少。
   * 只表达「这张牌有多高」，不表达「它对谁有利」—— 那是 nutShift / rangeImprovement 的事。
   */
  const previousHighest = before?.highestRank ?? 0;
  const overcardImpact =
    newCard === null
      ? 0
      : Math.max(0, Math.min(1, (newCard.rank - previousHighest) / 6));

  /*
   * 🔴 语义必须精确（第一版把 `flushCompleted` 写成「牌面 5 张同花色」，
   * 那几乎永不发生，等于这个字段没用）：
   *
   * | 字段 | 精确含义 |
   * |---|---|
   * | `flushCompleted` | **这张牌让同花成为可能**（牌面同花色张数首次达到 3 —— 手里有该花色两张的人已成花） |
   * | `straightCompleted` | **这张牌让顺子成为可能**（牌面最长连张首次达到 3） |
   * | `fourToFlush` | 牌面已有 **4 张**同花色（听牌面成型） |
   * | `fourToStraight` | 牌面已有 **4 张**连张 |
   *
   * 例（使用者给的例子）：`J♦ 9♣ 6♣ 2♠` → `T♣` ⇒ 牌面首次出现 3 张♣
   * ⇒ `flushCompleted = true`、`fourToFlush = false`。
   */
  const flushBecamePossible = texture.flushPossible && !(before?.flushPossible ?? false);
  const straightBecamePossible = texture.straightPossible && !(before?.straightPossible ?? false);
  const flushCompleted = flushBecamePossible;
  const straightCompleted = straightBecamePossible;

  // 我方相对档位跨街变化（正 = 变强）
  const currentTier = boardRelativeTierOf(input.heroHole, input.board);
  const heroRelativeStrengthChange =
    currentTier === null || input.previousTier === null ? 0 : input.previousTier - currentTier;

  /*
   * nutShift：把「这张牌偏谁」拆成三个可解释的成分，各占权重后相加。
   *
   *   + 偏对手：新牌是**高张**（先前的下注者/加注者范围里高张更多）
   *   − 偏对手：新牌完成的花色是**我们手里有**的花色（我们更可能持有同花）
   *   + 偏对手：新牌与牌面连成顺子结构，而顺子听牌在**他的继续范围**里更常见
   *
   * ⚠️ 系数是**结构性判断**（方向与相对量级），不是从数据估出的参数。
   */
  const heroSuits = suitCountsOf(input.heroHole);
  const newSuitIndex = newCard === null ? -1 : suitIndexOfCard(newCard);
  const heroHasNewSuit = newSuitIndex >= 0 && heroSuits[newSuitIndex]! > 0;
  const flushIsOurs = newSuitIndex >= 0 && texture.maxSuitCount >= 3 && heroHasNewSuit;

  const nutShift = Math.max(
    -1,
    Math.min(
      1,
      0.5 * overcardImpact +
        (texture.fourToStraight && !(before?.fourToStraight ?? false) ? 0.25 : 0) -
        (flushIsOurs ? 0.35 : 0) -
        (heroRelativeStrengthChange > 0 ? 0.2 : 0),
    ),
  );

  /*
   * 对手范围改善：**必须**来自真实范围（他的范围里有多少组合因为这张牌变强）。
   * 拿不到范围事实时返回 null —— 不编造。
   */
  const villainRangeImprovement =
    input.rangeFacts === null
      ? null
      : Math.max(
          0,
          Math.min(
            1,
            0.55 * input.rangeFacts.strongShare +
              0.25 * input.rangeFacts.suitFit +
              0.2 * (1 - Math.min(1, input.rangeFacts.meanTier / 5)),
          ),
        );

  // 我方改善：用**成手档位变化 + 补牌变化**估计（都是我们自己的信息，可靠）
  const drawsAfter = drawProfileOf(input.heroHole, input.board);
  const drawsBefore = input.previousBoard.length >= 3 ? drawProfileOf(input.heroHole, input.previousBoard) : null;
  const heroRangeImprovement = Math.max(
    0,
    Math.min(
      1,
      0.5 * Math.max(0, heroRelativeStrengthChange) / 3 +
        0.5 * Math.max(0, drawsAfter.outs - (drawsBefore?.outs ?? drawsAfter.outs)) / 8,
    ),
  );

  /*
   * blankScore：越接近 1 越说明「什么都没改变」。
   * 构成：不是高张、没有新完成的花色/顺子结构、我方档位没变、对手范围改善很小。
   */
  const structureChange =
    (Number(texture.fourToFlush) - Number(before?.fourToFlush ?? false)) +
    (Number(texture.fourToStraight) - Number(before?.fourToStraight ?? false)) +
    (Number(texture.pairedBoard) - Number(before?.pairedBoard ?? false)) +
    (Number(texture.flushPossible) - Number(before?.flushPossible ?? false));
  const changed = Math.min(
    1,
    Math.abs(overcardImpact) * 0.5 +
      Math.abs(structureChange) * 0.3 +
      Math.min(1, Math.abs(heroRelativeStrengthChange) / 3) * 0.2,
  );

  return {
    overcardImpact,
    flushCompleted,
    straightCompleted,
    pairedBoard: texture.pairedBoard,
    fourToStraight: texture.fourToStraight,
    fourToFlush: texture.fourToFlush,
    nutShift,
    heroRelativeStrengthChange,
    villainRangeImprovement,
    heroRangeImprovement,
    blankScore: 1 - changed,
  };
}

/** 给我方补牌剖面（供 `computeBoardDelta` 与角色判定共用） */
export function heroDraws(heroHole: readonly Card[], board: readonly Card[]): DrawProfile {
  return drawProfileOf(heroHole, board);
}
