/**
 * 河牌「组合 → 画像手牌类别」桥接（PLAYER PROFILE QUANTIFICATION V1 · §十一/§十二）
 *
 * ## 这个模块解决什么
 *
 * `betLikelihoodOf`（`domain/player/behaviorProfile.ts`）要的是
 * **`RiverComboClass`**（9 类），而范围里躺着的是**具体两张牌**。
 * 本模块只做这一件事：把 `(底牌, 公共牌, Hero 底牌)` 映射成一个类别。
 *
 * ## 🔴 单一事实来源：绝不重新实现分类
 *
 * 「谁比谁强」与「这是价值牌还是诈唬候选」**全部复用**既有实现：
 *
 * | 轴 | 来源 | 证据等级 |
 * |---|---|---|
 * | 与 Hero 的强弱 | `handEval.compareHands` | 【数学确定】 |
 * | 牌面相对强度档 | `boardRelativeTierOf` | 【数学确定】+【启发式】映射 |
 * | 价值/摊牌/诈唬候选 | `classifyRiverAction` | 【启发式】映射表 |
 * | 是否错过听牌 | 本模块（见下） | 【启发式】 |
 *
 * 与 `rangeFacts` / `riverActionMassesOf` 用的是**同一套判据**，
 * 因此「范围里的诈唬候选」与「画像模型认定的空气」不会各说各话。
 *
 * ## 「错过的听牌」判据（本模块唯一新增的判断）
 *
 * `classifyRiverAction` 只知道 `BLUFF_CANDIDATE`（无摊牌价值的空气），
 * 它不区分「这手空气是错过的听牌还是从头到尾没东西」。
 * 这里补上，判据刻意**保守**（宁可判 PURE_AIR，也不猜）：
 *
 * 1. **河牌上没成花/没成顺**（成手不可能落到 `BLUFF_CANDIDATE`，这里再断一次）；
 * 2. **那 4 张同花色里必须至少有 1 张在我的底牌里** ——
 *    否则那是**公共牌**的四张同花（谁都能打公共牌），不是「我的听牌」；
 * 3. **顺子同理**：补成顺子的那个 5 连必须**用得上我的底牌**，
 *    否则（例如公共牌 9TJQ 而我持 3-4）那不是我的听牌。
 *
 * ⚠️ 已知上限：本模块**不做**「我错过了听牌 → 我现在一定诈唬」这类推断，
 * 也不声称任何频率 —— 频率由 `betLikelihoodOf` 的画像条目给。
 */

import { type Card } from '../types.ts';
import { compareHands, evaluateCards } from '../poker/handEval.ts';
import { boardRelativeTierOf } from '../poker/boardRelativeStrength.ts';
import { boardTextureOf } from './boardDelta.ts';
import { suitCountsOf } from './draws.ts';
import { suitIndexOfCard } from './suit.ts';
import { classifyRiverAction, RiverActionClass, type VersusHero } from './riverActionClass.ts';
import type { BehaviorNodeContext, RiverComboClass } from '../player/behaviorProfile.ts';

/* ============================================================
 * 牌面纹理档
 * ============================================================ */

/**
 * 牌面纹理档 ——【启发式】，输入**全部**来自 `boardTextureOf` 的结构事实。
 *
 * 判定顺序（互斥，先判先得 —— 顺序本身是设计的一部分）：
 *
 * | 档 | 判据 | 理由 |
 * |---|---|---|
 * | `MONOTONE` | 单花色 ≥3 张 | 已成花可能，压倒其它一切特征 |
 * | `PAIRED` | 牌面有对子（含三条） | 葫芦/四条结构，价值分布双峰 |
 * | `WET` | 四张同花 \|\| 四连张 \|\| 同花可能与顺子可能**同时**成立 | 听牌密集 |
 * | `SEMI_WET` | 同花**或**顺子可能（单项） | 有一路听牌 |
 * | `DRY` | 其余 | 静态牌面 |
 *
 * ⚠️ **刻意不把「两张同花色」记成 SEMI_WET**：5 张公共牌里
 * 「某花色恰好 2 张」几乎恒成立（抽屉原理），拿它当湿润判据等于
 * 让几乎所有牌面都变 SEMI_WET —— 那样这一档就没有信息量了。
 *
 * @returns 牌面不足 3 张时 `null`（翻前/翻牌前）
 */
export function boardTextureLabelOf(board: readonly Card[]): BehaviorNodeContext['boardTexture'] | null {
  const facts = boardTextureOf(board);
  if (facts === null) return null;
  if (facts.maxSuitCount >= 3) return 'MONOTONE';
  if (facts.pairedBoard) return 'PAIRED';
  if (facts.fourToFlush || facts.fourToStraight || (facts.flushPossible && facts.straightPossible)) {
    return 'WET';
  }
  if (facts.flushPossible || facts.straightPossible) return 'SEMI_WET';
  return 'DRY';
}

/* ============================================================
 * 错过的听牌
 * ============================================================ */

/** 点数集合；A 同时记为 14 与 1（轮子 A2345） */
function rankSetWithWheel(cards: readonly Card[]): Set<number> {
  const present = new Set<number>(cards.map((c) => c.rank));
  if (present.has(14)) present.add(1);
  return present;
}

/** 这些点数里是否已存在一条 5 连 */
function hasFiveRun(present: ReadonlySet<number>): boolean {
  for (let start = 1; start <= 10; start += 1) {
    let ok = true;
    for (let step = 0; step < 5; step += 1) {
      if (!present.has(start + step)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * 是否存在一条 5 连，且这条 5 连**用到了我的底牌**。
 *
 * 这一条是「我的顺子听牌」与「公共牌自己的顺子结构」的分界线：
 * 公共牌 9TJQ 上持 3-4 的人**没有**顺子听牌（他两张都用不上），
 * 持 K-3 的人**有**（K 能补成 9TJQK）。
 */
function runUsingHole(present: ReadonlySet<number>, holeRanks: ReadonlySet<number>): boolean {
  for (let start = 1; start <= 10; start += 1) {
    let ok = true;
    let usesHole = false;
    for (let step = 0; step < 5; step += 1) {
      const rank = start + step;
      if (!present.has(rank)) {
        ok = false;
        break;
      }
      if (holeRanks.has(rank)) usesHole = true;
    }
    if (ok && usesHole) return true;
  }
  return false;
}

/**
 * 错过的顺子听牌：【启发式】结构判据。
 *
 * - 已成顺（任何形态）⇒ `null`（那不是「错过的」）
 * - 补两张不同点数都能成顺（且都用得上底牌）⇒ `OPEN_ENDED`
 * - 只有一个点数能补 ⇒ `GUTSHOT`
 * - 一个都没有 ⇒ `null`
 */
export function missedStraightDrawOf(
  hole: readonly Card[],
  board: readonly Card[],
): 'OPEN_ENDED' | 'GUTSHOT' | null {
  if (hole.length !== 2 || board.length < 3) return null;
  const present = rankSetWithWheel([...hole, ...board]);
  if (hasFiveRun(present)) return null;

  const holeRanks = rankSetWithWheel(hole);
  const completing: number[] = [];
  for (let rank = 1; rank <= 14; rank += 1) {
    if (present.has(rank)) continue;
    present.add(rank);
    if (runUsingHole(present, holeRanks)) completing.push(rank);
    present.delete(rank);
  }
  if (completing.length >= 2) return 'OPEN_ENDED';
  if (completing.length === 1) return 'GUTSHOT';
  return null;
}

/**
 * 错过的同花听牌：【启发式】结构判据。
 *
 * 河牌上「四张同花色但没成花」就是错过 —— 因此这里不需要额外判断
 * 「当时是不是听牌」：**河牌只有 5 张公共牌，四张同花只可能是没成**。
 *
 * ⚠️ 必须要求**底牌里有该花色**：公共牌自己四张同花时，
 * 任何人都能打公共牌，那不是「我的听牌」。
 */
export function missedFlushDrawOf(hole: readonly Card[], board: readonly Card[]): boolean {
  if (hole.length !== 2 || board.length < 3) return false;
  const counts = suitCountsOf([...hole, ...board]);
  const max = Math.max(...counts);
  if (max >= 5) return false; // 已成花
  if (max !== 4) return false; // 不是「四张同花」
  const suit = counts.indexOf(4);
  return hole.some((c) => suitIndexOfCard(c) === suit);
}

/** 错过的听牌种类（同花与顺子同时错过 ⇒ `COMBO`） */
export function missedDrawKindOf(
  hole: readonly Card[],
  board: readonly Card[],
): 'FLUSH' | 'STRAIGHT' | 'COMBO' | null {
  const flush = missedFlushDrawOf(hole, board);
  const straight = missedStraightDrawOf(hole, board);
  if (flush && straight !== null) return 'COMBO';
  if (flush) return 'FLUSH';
  if (straight !== null) return 'STRAIGHT';
  return null;
}

/* ============================================================
 * 组合 → RiverComboClass
 * ============================================================ */

/**
 * 把一个对手组合映射成画像模型要的 `RiverComboClass`。
 *
 * 映射（严格对齐 `classifyRiverAction` 的语义，不新增判据）：
 *
 * | `classifyRiverAction` | `RiverComboClass` |
 * |---|---|
 * | `CLEAR_VALUE` | 档 0 ⇒ `NUT_VALUE`；否则 `STRONG_VALUE` |
 * | `THIN_VALUE` | `THIN_VALUE` |
 * | `SHOWDOWN` | `SHOWDOWN_VALUE` |
 * | `BLUFF_CANDIDATE` | 按**实际**错过的听牌分 `MISSED_FLUSH_DRAW` / `MISSED_STRAIGHT_DRAW` / `MISSED_COMBO_DRAW`，都没有 ⇒ `PURE_AIR` |
 * | `UNCERTAIN` | `SHOWDOWN_VALUE`（见下） |
 *
 * 🔴 **`UNCERTAIN` 为什么落到 `SHOWDOWN_VALUE` 而不是别的**：
 * `classifyRiverAction` 把「底对/小对子」这类**证据不足**的组合单独标出来
 * （它既可能摊牌，也可能诈唬）。`SHOWDOWN_VALUE` 在 `betLikelihoodOf` 里
 * 基准 0.25 且**不乘任何画像条目** ⇒ 画像**不会动这些我们看不懂的组合**，
 * 作用被限制在有证据的类别上。这与「不编造」是同一条纪律。
 *
 * @returns `null` 表示**无法分类**（牌面不足 / 牌力比较失败）——
 *   调用方必须回落到既有的档位似然，**不允许**用一个猜出来的类别顶上。
 *
 * 🔴 **V2：同时返回 `strengthBucket`（既有档位）。**
 * 「中性校准层」（`estimateUnifiedActionLikelihood` 的第 1 段）需要**该 combo 的
 * 既有档位权重**，中性画像才可能**逐位复现** 1.0.4 的基线。
 * 档位在本函数内部**本来就已经算出来**（`boardRelativeTierOf`），此前被丢弃、
 * 由调用方另行推导 —— 那会形成**第二把尺子**。现在一次算出并返回，
 * 全局只有这一个来源（§十七 单一模型）。
 */
export function riverComboClassOf(input: {
  hole: readonly [Card, Card];
  board: readonly Card[];
  heroHole: readonly Card[];
}): { category: RiverComboClass; strengthBucket: number } | null {
  if (input.board.length < 3 || input.heroHole.length !== 2) return null;

  let versusHero: VersusHero;
  try {
    const villain = evaluateCards([...input.hole, ...input.board]);
    const hero = evaluateCards([...input.heroHole, ...input.board]);
    const cmp = compareHands(villain, hero);
    versusHero = cmp > 0 ? 'STRONGER' : cmp < 0 ? 'WEAKER' : 'EQUAL';
  } catch {
    // 比较失败 ⇒ 不分类（宁可回落到档位似然，也不猜）
    return null;
  }

  const tier = boardRelativeTierOf(input.hole, input.board) ?? 5;
  const actionClass = classifyRiverAction({ versusHero, tier });

  let category: RiverComboClass;
  switch (actionClass) {
    case RiverActionClass.CLEAR_VALUE:
      category = tier === 0 ? 'NUT_VALUE' : 'STRONG_VALUE';
      break;
    case RiverActionClass.THIN_VALUE:
      category = 'THIN_VALUE';
      break;
    case RiverActionClass.SHOWDOWN:
    case RiverActionClass.UNCERTAIN:
      // 见上方说明：证据不足 ⇒ 归到「画像不动它」的那一类
      category = 'SHOWDOWN_VALUE';
      break;
    case RiverActionClass.BLUFF_CANDIDATE: {
      const missed = missedDrawKindOf(input.hole, input.board);
      // 见文件头：分不清就如实记成纯空气，绝不猜成听牌
      category =
        missed === 'FLUSH'
          ? 'MISSED_FLUSH_DRAW'
          : missed === 'STRAIGHT'
            ? 'MISSED_STRAIGHT_DRAW'
            : missed === 'COMBO'
              ? 'MISSED_COMBO_DRAW'
              : 'PURE_AIR';
      break;
    }
    default: {
      const exhaustive: never = actionClass;
      void exhaustive;
      return null;
    }
  }
  return { category, strengthBucket: tier };
}
