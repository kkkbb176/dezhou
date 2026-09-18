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
import { evaluateCards } from '../poker/handEval.ts';
import { ALL_CARDS } from '../types.ts';
import { ALL_RANK_CLASSES, COMBOS_BY_RANK_CLASS } from '../range/combo.ts';

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
  /**
   * 顺子**结构**变化（不是「首次成为可能」）：牌面最长连张的变化 + 补牌点数变化。
   * 修复前只看 `straightPossible` 这个布尔翻转，于是 `T72 → 8`（T-8-7 连成三张、
   * 顺子补牌从 0 变成 J/6 两个点数）被判成空白。
   */
  straightDrawDelta: number;
  /** 同花**听牌**结构变化（2 张 → 3 张同花色时，手里有该花色两张的人已成花） */
  flushDrawDelta: number;
  /** 这张牌让多少「起手牌类别」变强（按代表性组合逐个比较，通用、与 Hero 无关） */
  classCompletion: ClassCompletion;
  /** 结构性分类（使用者要求：blank / semi-blank / dynamic / high-impact） */
  kind: BoardDeltaKind;
  /** 动态度 = 1 − blankScore（方便阅读；与 blankScore 互补） */
  dynamicScore: number;
  blankScore: number;
};

export const BoardDeltaKind = {
  BLANK: 'BLANK',
  SEMI_BLANK: 'SEMI_BLANK',
  DYNAMIC: 'DYNAMIC',
  HIGH_IMPACT: 'HIGH_IMPACT',
} as const;
export type BoardDeltaKind = (typeof BoardDeltaKind)[keyof typeof BoardDeltaKind];

export const BOARD_DELTA_KIND_ZH: Readonly<Record<BoardDeltaKind, string>> = Object.freeze({
  BLANK: '空白牌（几乎没有改变结构）',
  SEMI_BLANK: '半空白（略有变化，但不改变坚果结构）',
  DYNAMIC: '动态牌（改变了连张/听牌/成牌结构）',
  HIGH_IMPACT: '高影响牌（显著改变坚果与完成牌类）',
});

export type ClassCompletion = {
  /** 有多少比例的起手牌类别在这张牌上**变强**（代表性组合口径） */
  improvedShare: number;
  /** 这张牌**新完成**的顺子类别数（例如 T87→8 上的 J9 / 96） */
  newStraightClasses: number;
  newTwoPairClasses: number;
  newSetClasses: number;
  newFlushClasses: number;
  noteZh: string;
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
   *
   * 🔴 **修复记录（TEST HAND MULTIWAY TURN FIX）**：修复前 `changed` 只由
   * 「高张 + 四个布尔结构翻转 + 我方档位」构成，于是 `T♠7♦2♠ → 8♦` 得到
   * `blankScore = 0.87`（被写成「接近空白」）—— 而这张牌：
   *   · 让牌面出现 T-8-7 的连张（顺子听牌结构成型）；
   *   · 让 J9 / 96 成顺、88 成三条、T8 / 87 成两对；
   *   · 让我方从「高张 + 听牌」变成「一对 + 两头顺 + 同花听」。
   * 四个布尔里没有一个会翻转，所以它被判成空白 —— 这是**结构性漏判**，不是阈值问题。
   *
   * 现在把「变化」写成**连续量**的加权和：高张、结构布尔翻转、**连张变化**、
   * **同花听结构变化**、**新完成的牌类**、我方档位变化、对手范围改善。
   */
  const structureChange =
    (Number(texture.fourToFlush) - Number(before?.fourToFlush ?? false)) +
    (Number(texture.fourToStraight) - Number(before?.fourToStraight ?? false)) +
    (Number(texture.pairedBoard) - Number(before?.pairedBoard ?? false)) +
    (Number(texture.flushPossible) - Number(before?.flushPossible ?? false));

  /*
   * 连张变化：牌面最长连续点数（0..5）+ 顺子补牌点数（能让牌面出现 5 连的点数个数）。
   * 两者都是**连续量**，且与 Hero 无关（纯公共牌结构，§22.13）。
   */
  const boardStraightOuts = (cards: readonly Card[]): number => {
    const present = new Set<number>(cards.map((c) => c.rank));
    if (present.has(14)) present.add(1);
    let count = 0;
    for (let rank = 1; rank <= 14; rank += 1) {
      if (present.has(rank)) continue;
      present.add(rank);
      let hasFive = false;
      for (let start = 1; start <= 10 && !hasFive; start += 1) {
        let ok = true;
        for (let step = 0; step < 5; step += 1) if (!present.has(start + step)) ok = false;
        if (ok) hasFive = true;
      }
      present.delete(rank);
      if (hasFive) count += 1;
    }
    return count;
  };

  const runDelta = texture.maxRunLength - (before?.maxRunLength ?? 0);
  const straightOutsDelta = boardStraightOuts(input.board) - boardStraightOuts(input.previousBoard);
  const straightDrawDelta = Math.max(0, Math.min(1, 0.5 * Math.max(0, runDelta) / 3 + 0.5 * Math.max(0, straightOutsDelta) / 3));
  const flushDrawDelta = Math.max(
    0,
    Math.min(1, (texture.maxSuitCount - (before?.maxSuitCount ?? 0)) / 2),
  );

  /*
   * 新完成的牌类（通用、与 Hero 无关）：对 169 个起手牌类别各取一个代表性组合，
   * 比较「这张牌之前 / 之后」的成手类别。J9 成顺、88 成三条、T8 成两对都会在这里计入。
   * ⚠️ 代表性组合可能与公共牌重叠（死牌）⇒ 跳过并在 noteZh 里如实计数。
   */
  const classCompletion: ClassCompletion = (() => {
    if (input.previousBoard.length < 3) {
      return {
        improvedShare: 0,
        newStraightClasses: 0,
        newTwoPairClasses: 0,
        newSetClasses: 0,
        newFlushClasses: 0,
        noteZh: '没有上一街牌面（翻牌）⇒ 不做完成牌类统计',
      };
    }
    const boardKeys = new Set(input.board.map((c) => `${c.rank}${c.suit}`));
    const beforeKeys = new Set(input.previousBoard.map((c) => `${c.rank}${c.suit}`));
    let improved = 0;
    let total = 0;
    let straight = 0;
    let twoPair = 0;
    let set = 0;
    let flush = 0;
    for (const rankClass of ALL_RANK_CLASSES) {
      /*
       * 代表性组合必须**避开公共牌/上一街的牌**：`88` 这类类别的第一个组合
       * 很可能正好是公共牌上的那张（8♦）⇒ 会被当成死牌跳过，于是「88 成三条」
       * 这类完成牌就统计不到（实测：三条数恒为 0）。因此按类别逐个试。
       */
      const combos = COMBOS_BY_RANK_CLASS.get(rankClass) ?? [];
      const combo = combos.find((c) => {
        const a = ALL_CARDS[c.cardIndices[0]]!;
        const b = ALL_CARDS[c.cardIndices[1]]!;
        return (
          !boardKeys.has(`${a.rank}${a.suit}`) &&
          !boardKeys.has(`${b.rank}${b.suit}`) &&
          !beforeKeys.has(`${a.rank}${a.suit}`) &&
          !beforeKeys.has(`${b.rank}${b.suit}`)
        );
      });
      if (combo === undefined) continue;
      const hole = [
        ALL_CARDS[combo.cardIndices[0]]!,
        ALL_CARDS[combo.cardIndices[1]]!,
      ] as const;
      total += 1;
      try {
        const afterCategory = evaluateCards([...hole, ...input.board]).category;
        const beforeCategory = evaluateCards([...hole, ...input.previousBoard]).category;
        if (afterCategory > beforeCategory) {
          improved += 1;
          if (afterCategory === 5 && beforeCategory < 5) straight += 1;
          if (afterCategory === 4 && beforeCategory < 4) set += 1;
          if (afterCategory === 3 && beforeCategory < 3) twoPair += 1;
          if (afterCategory === 6 && beforeCategory < 6) flush += 1;
        }
      } catch {
        continue;
      }
    }
    const improvedShare = total === 0 ? 0 : improved / total;
    return {
      improvedShare,
      newStraightClasses: straight,
      newTwoPairClasses: twoPair,
      newSetClasses: set,
      newFlushClasses: flush,
      noteZh:
        `这张牌让 ${improved}/${total} 个起手牌类别变强` +
        `（新成顺 ${straight}｜新成三条 ${set}｜新成两对 ${twoPair}｜新成同花 ${flush}）`,
    };
  })();

  /*
   * 「新完成」的直接影响：新成顺的类别数是最强的信号（顺子是最容易被这张牌
   * 一次性完成的坚果级牌类），其次是新三条 / 新两对。
   * 上限分别按「典型可达数量」归一（4 个顺子类别 / 2 个三条类别 / 8 个两对类别）。
   */
  const completionImpact = Math.min(
    1,
    0.7 * Math.min(1, classCompletion.newStraightClasses / 4) +
      0.2 * Math.min(1, classCompletion.newFlushClasses / 4) +
      /*
       * ⚠️ 「新三条 / 新两对」对**任何**一张牌都会非零（新牌自己就与牌面组成两对，
       * 拿两张同点就是三条），因此它们只能作为**弱**信号：真正区分
       * 「动态牌 vs 空白牌」的是**新成顺 / 新成花**（只有与牌面连接的牌才会产生）。
       */
      0.05 * Math.min(1, classCompletion.newSetClasses / 2) +
      0.05 * Math.min(1, classCompletion.newTwoPairClasses / 8),
  );

  const changed = Math.min(
    1,
    Math.abs(overcardImpact) * 0.2 +
      Math.abs(structureChange) * 0.15 +
      straightDrawDelta * 0.35 +
      flushDrawDelta * 0.2 +
      completionImpact * 0.65 +
      Math.min(1, Math.abs(heroRelativeStrengthChange) / 3) * 0.15 +
      Math.min(1, Math.abs(nutShift)) * 0.1 +
      (villainRangeImprovement === null ? 0 : villainRangeImprovement * 0.1),
  );

  const blankScore = 1 - changed;
  /*
   * 分类阈值是**具名常量**，不是散落的数字：
   *   BLANK        ≥ 0.85（几乎什么都没变）
   *   SEMI_BLANK   ≥ 0.65
   *   DYNAMIC      ≥ 0.40
   *   HIGH_IMPACT  < 0.40（显著改变坚果与完成牌类）
   */
  const kind: BoardDeltaKind =
    blankScore >= 0.85
      ? BoardDeltaKind.BLANK
      : blankScore >= 0.65
        ? BoardDeltaKind.SEMI_BLANK
        : blankScore >= 0.4
          ? BoardDeltaKind.DYNAMIC
          : BoardDeltaKind.HIGH_IMPACT;

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
    straightDrawDelta,
    flushDrawDelta,
    classCompletion,
    kind,
    dynamicScore: changed,
    blankScore,
  };
}

/** 给我方补牌剖面（供 `computeBoardDelta` 与角色判定共用） */
export function heroDraws(heroHole: readonly Card[], board: readonly Card[]): DrawProfile {
  return drawProfileOf(heroHole, board);
}
