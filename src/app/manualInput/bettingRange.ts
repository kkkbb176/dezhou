/**
 * ============================================================================
 * BETTING RANGE —— 「他实际会下注的那一部分」
 * ============================================================================
 *
 * ## TEST 09 P0-1 的根因
 *
 * 面对 Villain 已经下注的节点，`CALL EV` 原本用的是
 * `math.heroEquity` = **Hero vs Villain ARRIVAL RANGE** 的权益。
 *
 * 那是错的，而且错得系统：`ARRIVAL RANGE` 回答「他走到这个节点**拥有**什么」，
 * 里面有一大半是**根本不会下注**的牌（中对、底对、错失听牌）。
 * 拿它们跟 Hero 摊牌，等于假设他会用这些牌主动打光 85 —— 他的下注范围
 * 远比到达范围**偏价值**，所以真实权益**更低**，`CALL EV` 被系统性**高估**。
 *
 * ## 三个范围层级（第十七节：不可混用）
 *
 * ```text
 * Arrival Range   他走到这个节点拥有什么            ← 已有（rangeBuild）
 *   ↓  × P(BET | combo, street, board, profile, size)
 * Betting Range   他实际选择下注的部分              ← 本模块新增
 *   ↓  ── 仅当 Hero 下注时才有意义 ──
 * Continue Range  P(他 call / raise | Hero bets)    ← 已有（响应模型桶）
 * ```
 *
 * ⚠️ 最后两层是**不同的条件概率**，不可互换：
 *
 * | 量 | 语义 |
 * |---|---|
 * | `P(Villain calls \| Hero bets)` | 响应模型的 CALL 桶 |
 * | `P(Villain bets \| Hero checks)` | **本模块** |
 *
 * TEST 08 的审计脚本曾试图拿 `CALL/RAISE` 桶当「他的下注范围」——
 * 那是拿第一行冒充第二行，本模块是它的正确替代。
 *
 * ## 最小模型（本轮范围）
 *
 * 不建 Solver 树。只有两步：
 *
 * ```text
 * betWeight(combo) = arrivalWeight(combo) × P(BET | combo)
 * BettingRange     = betWeight 归一化
 * ```
 *
 * `P(BET | combo)` **复用现有模型** —— `classifyVillainAfterCheck`
 * （它本来就是「Hero 过牌后他开枪」的逐组合混频），因此
 * `aggression` / `bluffTendency` / `passivity` / 街道 / 尺寸
 * 全都自动进入，**不新增任何硬编码阈值**（§六 / §十八）。
 */

import type { Card } from '../../domain/types.ts';
import { ALL_CARDS } from '../../domain/poker/cards.ts';
import { boardRelativeTierOf } from '../../domain/poker/boardRelativeStrength.ts';
import { compareHands, evaluateCards } from '../../domain/poker/handEval.ts';
import {
  classifyVillainAfterCheck,
  type ResponseTendencies,
} from '../../domain/postflop/betResponse.ts';
import { riverComboClassOf } from '../../domain/postflop/riverProfileClassify.ts';
import type { RiverComboClass } from '../../domain/player/behaviorProfile.ts';

/** 一个到达范围的组合（与 `rangeEquityOfMany` 的入参同形） */
export type ArrivalEntry = {
  readonly cardIndices: readonly [number, number];
  readonly probability: number;
};

/**
 * 下注范围的**手牌类别质量分解**（§十）。
 *
 * ⚠️ 必须与 `profileClassMasses`（**到达**范围）分开保存，二者语义不同。
 * 这里每一个字段都属于 **BET RANGE**。
 */
export type BetRangeClassMasses = {
  readonly totalMass: number;
  readonly reachableRangeCount: number;
  readonly nutValueMass: number;
  readonly strongValueMass: number;
  readonly thinValueMass: number;
  readonly showdownMass: number;
  readonly missedFlushMass: number;
  readonly missedStraightMass: number;
  readonly missedComboMass: number;
  readonly pureAirMass: number;
  /** `NUT + STRONG + THIN` */
  readonly valueMass: number;
  /** `missedDraw + pureAir` */
  readonly bluffMass: number;
  /** 无法分类的质量（**不猜**，单列） */
  readonly unclassifiedMass: number;
};

export type BetRangeFacts = {
  /** 归一化后的下注范围（可直接喂给权益引擎） */
  readonly entries: readonly ArrivalEntry[];
  /** 下注范围的类别质量（**属于 BET RANGE**） */
  readonly classMasses: BetRangeClassMasses;
  /** 到达范围的总质量（用于回答「他下注的比例」） */
  readonly arrivalMass: number;
  /** 下注范围的总质量（归一化前） */
  readonly betMass: number;
  /** `betMass / arrivalMass` —— 他到达的牌里有多少比例会下注 */
  readonly betShareOfArrival: number;
  /**
   * 🔴 **尺寸口径（§七）**：必须显式报告是否做了尺寸近似。
   *
   * 引擎的尺寸网格上限是 **100% 池**；TEST 09 的真实下注是
   * `85 / 71 = 1.197`（120% 超池）。此时：
   *
   * ```text
   * actualRatio  = 1.197   ← 实际
   * modeledRatio = 1.000   ← 模型能表达的上限
   * sizeApproximation = true
   * ```
   *
   * **静默把 85 当成 71 是不允许的** —— 那会让「超池」这个最强的
   * 范围极化信号消失。本模块用 `actualRatio` 计算 `P(BET | combo)`，
   * 因此强弱分化的方向仍然正确，只是幅度被网格上限限制。
   */
  readonly sizing: {
    readonly actualBetChips: number;
    readonly potChips: number;
    readonly actualRatio: number;
    readonly modeledRatio: number;
    readonly sizeApproximation: boolean;
  };
  readonly noteZh: string;
};

/**
 * 🔴 **P(BET | 手牌类别)** —— 下注概率的核心结构（§六）。
 *
 * ## 为什么不能复用 `classifyVillainAfterCheck` 的 `weights.bet`
 *
 * 那个函数只有**两条**下注分支：
 *
 * | 分支 | 判据 |
 * |---|---|
 * | 价值下注 | `tier ≤ 2` **且** `versusHero === 'STRONGER'`（或 `tier ≤ 1`） |
 * | 诈唬下注 | `tier ≥ 4` **且** `betScale > 1` |
 *
 * 于是 **tier 3 以及「tier 4 但 betScale ≤ 1」的全部组合被强制 100% 过牌**。
 * 而 `boardRelativeTierOf` 把**中等牌力**放在这些位置上：
 *
 * ```text
 * K-8-4-J 牌面实测：AA→2、AK→2、QQ→4、99→4、Tc9c→5
 * ```
 *
 * `QQ` 在这个牌面上是**超对**，实战中会下注；`AK`（顶对顶踢）也会。
 * 它们被判成「要么不比 Hero 强、要么是弱尾」⇒ 下注范围里只剩
 * 三条/两对/顶对好踢，权益被压到 8.67%（TEST 4 实测），
 * 而 AA 对**到达范围**的真实权益是 **81.18%**。
 *
 * ## 现在的口径：按类别给概率，全部由画像驱动
 *
 * | 类别 | P(BET) | 依据 |
 * |---|---|---|
 * | `NUT_VALUE` / `STRONG_VALUE` | `0.45 + 0.30×aggro + 0.25×bluff` | 强牌价值下注 |
 * | `THIN_VALUE` | `0.25 + 0.30×aggro + 0.30×bluff` | 薄价值，更依赖风格 |
 * | `SHOWDOWN_VALUE` | `0.10 + 0.15×aggro + 0.15×bluff − 0.20×passive` | 中等牌力，通常过牌 |
 * | 错失听牌 / 纯空气 | `bluffTendency × P(BET\\|价值)` | 诈唬，锚在价值频率上 |
 *
 * `center(v) = (v − 0.5) × 2`，四个维度都来自 V3 解析结果
 *（无统计时就是标签维度；无标签时全 0.5 ⇒ 每个类别都回到中性频率）。
 *
 * **没有任何一处写 `if MANIAC then 0.9`**（§十八）：疯子的
 * `aggression`/`bluffTendency` 高、`passivity` 低 ⇒ 每一类都更高；
 * 极紧型相反。类别之间的**序关系**（价值 > 薄价值 > 摊牌）是结构性判断。
 */
export type BetProbabilityByClass = Readonly<Record<RiverComboClass, number>>;

/**
 * 🔴 **尺寸 → 极化程度（§二十一）**。
 *
 * 下注范围的**构成必须随尺寸变化**，否则尺寸就没有真正进入模型。
 * 扑克上的机制是**极化**：
 *
 * | 尺寸 | 下注范围的形状 |
 * |---|---|
 * | 小注（≈1/3 池） | 线性 / 合并 —— 中等牌力也会下注取值 |
 * | 大注（≥ 2/3 池） | 极化 —— 要么坚果、要么空气，中等牌力改成过牌 |
 *
 * 用一条**单调、有界、连续**的曲线表达，锚点在「中注（2/3 池）」：
 *
 * ```text
 * ratio = betChips / pot
 * valueExponent = 1 + 0.5 × (ratio − 2/3)    // 大注 ⇒ 价值更集中
 * bluffExponent = 1 + 0.7 × (ratio − 2/3)    // 大注 ⇒ 诈唬更集中（幅度更大）
 * 把「相对基线 0.5 的偏离」按这两个指数放大，再夹回 [0,1]
 * ```
 *
 * 性质：
 * - `ratio = 2/3` ⇒ 两个指数都是 1 ⇒ **与无尺寸版本逐位相同**（锚点不引入偏置）；
 * - `ratio` ↑ ⇒ 价值与诈唬都往两端拉、薄价值/摊牌被压低（极化）；
 * - `ratio` ↓ ⇒ 反向（线性化）；
 * - 指数只作用于**相对 0.5 的偏离**，因此不会把任何一类推出 [0,1] 之外。
 *
 * ⚠️ 与 `classifyVillainAfterCheck` 的分街尺寸项**不重复计费**：那里改的是
 * 「他开不开枪」（总量），这里改的是「开了枪的范围长什么样」（构成）。
 */
function polarize(x: number, exponent: number): number {
  const centered = x - 0.5;
  return Math.max(0, Math.min(1, 0.5 + centered * exponent));
}

export function betProbabilityByClass(
  tendencies: ResponseTendencies,
  /**
   * `betChips / pot`。缺省（`undefined`）⇒ 用中注锚点 ⇒ 与无尺寸版本逐位一致。
   */
  ratioToPot?: number,
): BetProbabilityByClass {
  const dims = tendencies.effectiveDimensions;
  const c = (v: number | undefined): number => {
    const x = Number.isFinite(v) ? Math.max(0, Math.min(1, v as number)) : 0.5;
    return (x - 0.5) * 2;
  };
  const aggro = c(dims?.aggression);
  const bluff = c(dims?.bluffTendency);
  const passive = c(dims?.passivity);
  const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

  const ANCHOR = 2 / 3;
  const ratio = Number.isFinite(ratioToPot) ? Math.max(0, ratioToPot as number) : ANCHOR;
  const valueExponent = 1 + 0.5 * (ratio - ANCHOR);
  const bluffExponent = 1 + 0.7 * (ratio - ANCHOR);

  const strong = clamp01(0.45 + 0.3 * aggro + 0.25 * bluff);
  const thin = clamp01(0.25 + 0.3 * aggro + 0.3 * bluff);
  const showdown = clamp01(0.1 + 0.15 * aggro + 0.15 * bluff - 0.2 * passive);
  /*
   * 诈唬**锚在价值频率上**：`P(BET | 空气) = bluffTendency × P(BET | 强价值)`。
   * 这样「他多爱诈唬」与「他多爱价值下注」不会各自漂移成两个不相干的数。
   */
  const bluffRate = clamp01((dims?.bluffTendency ?? 0.5) * strong);

  return Object.freeze({
    NUT_VALUE: polarize(strong, valueExponent),
    STRONG_VALUE: polarize(strong, valueExponent),
    THIN_VALUE: polarize(thin, valueExponent),
    SHOWDOWN_VALUE: polarize(showdown, valueExponent),
    MISSED_FLUSH_DRAW: polarize(bluffRate, bluffExponent),
    MISSED_STRAIGHT_DRAW: polarize(bluffRate, bluffExponent),
    MISSED_COMBO_DRAW: polarize(bluffRate, bluffExponent),
    PURE_AIR: polarize(bluffRate, bluffExponent),
  });
}

/**
 * 他「拿强成手下注」的概率 —— 用于把诈唬比例锚定在价值比例上。
 *
 * 做法：拿一个**代表性价值手牌**去问同一个 `classifyVillainAfterCheck`，
 * 读它给出的 `valueBet` 份额。这样「价值下注频率」与「诈唬下注频率」
 * 来自**同一个模型**，不会各自漂移。
 */
function valueBetShareOf(tendencies: ResponseTendencies): number {
  const probe = classifyVillainAfterCheck({
    tier: 1,
    versusHero: 'STRONGER',
    tendencies,
    pot: 1,
    betSize: 1,
    street: 'RIVER',
  });
  return probe.valueBet ? probe.weights.bet : 0;
}

/** 他的诈唬倾向（0..1）；无画像 ⇒ 中性 0.5 */
function bluffTendencyOf(tendencies: ResponseTendencies): number {
  const d = tendencies.effectiveDimensions;
  if (d === null || d === undefined) return 0.5;
  const v = d.bluffTendency;
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
}

/**
 * 由到达范围构造**下注范围**。
 *
 * @param input.tendencies  Villain **本人**的响应倾向（无画像 ⇒ 中立先验）
 * @param input.betChips    他实际（或拟）下注的筹码额；用于 `P(BET | combo)` 的尺寸项
 * @param input.maxRatio    模型能表达的尺寸上限（默认 1.0 = 一池）
 */
export function buildBettingRangeFacts(input: {
  arrivalEntries: readonly ArrivalEntry[];
  board: readonly Card[];
  heroHole: readonly Card[];
  potChips: number;
  betChips: number;
  street: 'FLOP' | 'TURN' | 'RIVER';
  tendencies: ResponseTendencies;
  maxRatio?: number;
  /**
   * 🔴 **平衡诈唬注入点**（供合成向量测试 / 显式的范围假设使用）。
   *
   * 给了就直接用它当「纯空气与错失听牌」的下注概率，**不再**由
   * `classifyVillainAfterCheck` 推导。用途是 §二十 要求的那种测试：
   *
   * ```text
   * 50% 无解价值 + 50% 纯诈唬  ⇒  Hero 权益 ≈ 50%
   * 80% 价值     + 20% 诈唬     ⇒  Hero 权益 ≈ 20%
   * ```
   *
   * ⚠️ 它**不是**硬编码阈值 —— `null`（缺省）时一切都由画像推导；
   * 它只是让「给定范围构成 ⇒ 权益 ⇒ 动作」这条链路可以被独立验证。
   */
  bluffShareOverride?: number | null;
}): BetRangeFacts | null {
  const { board, heroHole } = input;
  if (board.length < 3 || heroHole.length !== 2) return null;
  if (!(input.potChips > 0)) return null;

  const maxRatio = input.maxRatio ?? 1;
  const actualRatio = input.betChips / input.potChips;
  const modeledRatio = Math.min(actualRatio, maxRatio);
  const sizeApproximation = actualRatio > maxRatio + 1e-9;

  /*
   * `P(BET | combo)` 用的**代表尺寸**：按模型能表达的比值折算。
   * 用 `actualRatio`（而非 `modeledRatio`）会让强弱分化更极端 ——
   * 超池下注本来就是「要么坚果要么空气」的信号。但尺寸项在
   * `classifyVillainAfterCheck` 里只以 `betSize / pot` 的**间接**形式出现，
   * 因此这里传按 `modeledRatio` 折算的金额，保证与模型刻度一致，
   * 同时把 `sizeApproximation` 如实标出来（§七 要求「不能静默」）。
   */
  const representativeBet = input.potChips * modeledRatio;

  const heroSet = new Set(heroHole.map((c) => `${c.rank}${c.suit}`));
  const boardSet = new Set(board.map((c) => `${c.rank}${c.suit}`));

  let heroEval;
  try {
    heroEval = evaluateCards([...heroHole, ...board]);
  } catch {
    heroEval = null;
  }
  if (heroEval === null) return null;

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

  const betEntries: ArrivalEntry[] = [];
  let arrivalMass = 0;
  let betMass = 0;
  let reachable = 0;
  let unclassifiedMass = 0;

  /** 按手牌类别的下注概率（§六）—— 全部由画像维度驱动，并随尺寸极化（§二十一） */
  const classP = betProbabilityByClass(input.tendencies, modeledRatio);

  for (const entry of input.arrivalEntries) {
    const p = entry.probability;
    if (!(p > 0)) continue;
    const hole: [Card, Card] = [
      ALL_CARDS[entry.cardIndices[0]]!,
      ALL_CARDS[entry.cardIndices[1]]!,
    ];
    // 与 Hero / 公共牌重叠的组合永远到不了这里（死牌），不计入任何一侧
    if (hole.some((c) => heroSet.has(`${c.rank}${c.suit}`) || boardSet.has(`${c.rank}${c.suit}`))) {
      continue;
    }
    const cls = riverComboClassOf({ hole, board, heroHole });
    if (cls === null) continue;
    reachable += 1;
    arrivalMass += p;

    /*
     * 🔴 **P(BET | combo) 按手牌类别取（§六）**。
     *
     * ⚠️ **不再用 `classifyVillainAfterCheck` 的 `weights.bet`**。
     * 那个函数只有两条下注分支（`tier ≤ 2 且更强` / `tier ≥ 4 且 betScale > 1`），
     * 于是**中等牌力被整批强制过牌** —— 而 `boardRelativeTierOf` 恰恰把
     * 超对 / 顶对放在那里：
     *
     * ```text
     * K-8-4-J 实测：AA→2、AK→2、QQ→4、99→4
     * ```
     *
     * `QQ`（超对）与 `AK`（顶对顶踢）在实战中会下注，却被判成
     * 「既不比 Hero 强、又不是诈唬候选」⇒ 下注范围只剩三条/两对，
     * `heroEquityVsBetRange` 被压到 8.67%，而 AA 对到达范围是 **81.18%**
     *（TEST 4 实测）。那是**假信号**，不是保守。
     *
     * 类别本身来自 `riverComboClassOf` —— 与 `profileClassMasses`
     * **同一把尺子**，因此「到达范围的类别质量」与「下注范围的类别质量」
     * 可以直接对比（§十）。
     */
    let w = classP[cls.category];
    if (
      typeof input.bluffShareOverride === 'number' &&
      (cls.category === 'MISSED_FLUSH_DRAW' ||
        cls.category === 'MISSED_STRAIGHT_DRAW' ||
        cls.category === 'MISSED_COMBO_DRAW' ||
        cls.category === 'PURE_AIR')
    ) {
      w = Math.max(0, Math.min(1, input.bluffShareOverride));
    }
    if (!(w > 0)) continue;

    const betWeight = p * w;
    betMass += betWeight;
    betEntries.push({
      cardIndices: entry.cardIndices,
      probability: betWeight,
    });
    byClass[cls.category] += betWeight;
  }

  if (!(betMass > 0) || betEntries.length === 0) return null;

  // 归一化 ⇒ 真正的下注范围（概率和 = 1）
  const normalized: ArrivalEntry[] = betEntries.map((e) => ({
    cardIndices: e.cardIndices,
    probability: e.probability / betMass,
  }));

  const missedDrawMass =
    byClass.MISSED_FLUSH_DRAW + byClass.MISSED_STRAIGHT_DRAW + byClass.MISSED_COMBO_DRAW;
  const valueMass = byClass.NUT_VALUE + byClass.STRONG_VALUE + byClass.THIN_VALUE;
  const n = (x: number): number => x / betMass;

  const classMasses: BetRangeClassMasses = Object.freeze({
    totalMass: 1,
    reachableRangeCount: normalized.length,
    nutValueMass: n(byClass.NUT_VALUE),
    strongValueMass: n(byClass.STRONG_VALUE),
    thinValueMass: n(byClass.THIN_VALUE),
    showdownMass: n(byClass.SHOWDOWN_VALUE),
    missedFlushMass: n(byClass.MISSED_FLUSH_DRAW),
    missedStraightMass: n(byClass.MISSED_STRAIGHT_DRAW),
    missedComboMass: n(byClass.MISSED_COMBO_DRAW),
    pureAirMass: n(byClass.PURE_AIR),
    valueMass: n(valueMass),
    bluffMass: n(missedDrawMass + byClass.PURE_AIR),
    unclassifiedMass: n(unclassifiedMass),
  });

  const sizing = Object.freeze({
    actualBetChips: input.betChips,
    potChips: input.potChips,
    actualRatio,
    modeledRatio,
    sizeApproximation,
  });

  return Object.freeze({
    entries: Object.freeze(normalized),
    classMasses,
    arrivalMass,
    betMass,
    betShareOfArrival: arrivalMass > 0 ? betMass / arrivalMass : 0,
    sizing,
    noteZh:
      `下注范围（BET RANGE，**不是**到达范围）：到达 ${reachable} 组合中 ` +
      `${normalized.length} 个会下注（质量占比 ${(arrivalMass > 0 ? (betMass / arrivalMass) * 100 : 0).toFixed(1)}%）｜` +
      `价值 ${(classMasses.valueMass * 100).toFixed(1)}% / 诈唬 ${(classMasses.bluffMass * 100).toFixed(1)}% / ` +
      `摊牌 ${(classMasses.showdownMass * 100).toFixed(1)}%｜` +
      `尺寸 实际 ${actualRatio.toFixed(3)} 池、建模 ${modeledRatio.toFixed(3)} 池` +
      (sizeApproximation ? ' ⇒ **SIZE_APPROXIMATION = TRUE**（超出网格上限）' : ''),
  });
}
