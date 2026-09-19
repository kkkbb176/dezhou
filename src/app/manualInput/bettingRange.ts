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
 * Arrival Range   他走到这个节点拥有什么            ← rangeBuild
 *   ↓  × P(BET | combo, street, board, profile, size)
 * Betting Range   他实际选择下注的部分              ← 本模块
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
 * ## 🔴 RIVER BET RANGE V2 —— 本轮修的三件事
 *
 * ### ① 到达范围必须**排除当前这一次下注**（消除重复计费）
 *
 * `applyLikelihoodUpdates` 会把**每一个**进攻动作当似然乘进范围 ——
 * 包括**当前这一次下注**。于是「到达范围」其实已经是
 * `P(手牌 | 他已经下注)`，本模块再乘一次 `P(BET | combo)` 就是**同一件事计两次费**：
 *
 * ```text
 * 修复前：betRange ∝ 先验 × P(BET | 手牌) × P(BET | 手牌)      ← 似然被平方
 * 修复后：betRange ∝ 到达范围(不含本次下注) × P(BET | 手牌)     ← 计一次
 * ```
 *
 * 实测（AK 河牌领打节点）：到达范围权益 75.52%（正确）被显示成 65.92%（含本次下注），
 * 而下注范围权益被压到 0.54%。**排除当前动作由 `contextBuilder` 负责**
 * （`applyLikelihoodUpdates` 的 `captureBeforeActionIndex`），本模块只消费结果。
 *
 * ### ② `SHOWDOWN_VALUE` 整类不得因为夹取而消失
 *
 * 修复前 `P(BET | SHOWDOWN_VALUE) = clamp01(0.10 + 0.15a + 0.15b − 0.20p)`
 * 在被动画像下是 **−0.125 ⇒ 精确 0**，于是「Hero 能击败的 70% 到达质量」
 * 被整类删除，下注范围只剩「能击败 Hero 的价值牌」——`EqVsBetRange`
 * 退化成模型自己设定的诈唬占比（实测 0.0054 = 诈唬质量）。
 *
 * 现在：
 * - 权重按**公共强度带**（见下）细分，摊牌区不再是一个黑洞；
 * - 夹取换成**结构性非退化变换**（softplus），保证任何带在任何画像下都 **> 0**，
 *   且**随画像 / 尺寸 / 牌面变化** —— 不是给所有摊牌牌加一个固定下限；
 * - 该变换的取值、来历与不确定性全部写进 `model` / `bandRates` 供审计。
 *
 * ### ③ 下注概率**不得读 Hero 的隐藏底牌**
 *
 * 修复前的类别来自 `riverComboClassOf`，而它的判据是
 * `versusHero = compareHands(他的手牌, Hero 的手牌)` —— **上帝视角**。
 * 后果：同一个对手组合、同一牌面、同一下注额、同一画像，
 * 只换掉 Hero 的底牌就会改变他的下注概率（实测 66/66 个组合全部变化）。
 *
 * 现在**权重只依赖公共信息**：
 *
 * ```text
 * 公共强度带（底牌 + 公共牌）  ×  尺寸  ×  牌面纹理  ×  画像维度
 * ```
 *
 * 而与 Hero 的关系（`RiverComboClass` / value / showdown / bluff 质量）
 * **只用于解释与报告**，不再控制任何一个权重。
 *
 * ## 一致性纪律
 *
 * `bettingRange.ts` 只做「到达范围 × 权重 ⇒ 下注范围」。
 * 它不重新算权益、不读决策层、不写 `math` ——
 * 权益与 `CALL EV` 由调用方用**同一份** `entries` 计算（§八：同一次范围计算）。
 */

import type { Card } from '../../domain/types.ts';
import { ALL_CARDS } from '../../domain/poker/cards.ts';
import { describeHand, type HandShape } from '../../domain/poker/handDescription.ts';
import { compareHands, evaluateCards } from '../../domain/poker/handEval.ts';
import {
  classifyVillainAfterCheck,
  type ResponseTendencies,
} from '../../domain/postflop/betResponse.ts';
import {
  boardTextureLabelOf,
  riverComboClassOf,
} from '../../domain/postflop/riverProfileClassify.ts';
import { effectiveCombosOf, posteriorMassCombosOf } from '../../domain/player/profileRangeMetrics.ts';
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
 *
 * 🔴 **这些类别相对 Hero 定义**（value = 能击败 Hero 的牌），
 * 因此它们**只用于解释**：RIVER BET RANGE V2 起，没有任何一个权重读它们
 * （读它们就等于让 Villain 的下注概率依赖 Hero 的隐藏底牌）。
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

/* ============================================================
 * 公共强度带（RIVER BET RANGE V2 · 第三/第四阶段）
 * ============================================================ */

/**
 * 🔴 **公共信息下的手牌强度带**。
 *
 * 判据**只有**「他的两张底牌 + 公共牌」，**绝不读 Hero 的底牌** ——
 * 这是第四阶段「下注行为模型」与「Hero 对下注范围的权益计算」解耦的落点。
 *
 * | 带 | 形态判据 | 为什么单独一档 |
 * |---|---|---|
 * | `NUT` | 同花顺 / 四条 / 葫芦 | 绝对坚果 |
 * | `STRONG_MADE` | 同花 / 顺子 / 三条 | 强成手 |
 * | `TWO_PAIR` | 两对（含顶两对） | 强价值 |
 * | `OVERPAIR` | 超对（含口袋对高于牌面） | 强价值，但比两对少一点保护价值 |
 * | `TOP_PAIR_GOOD` | 顶对 + **踢脚 ≥ 牌面第二高点** | 标准「top pair, good kicker」 |
 * | `TOP_PAIR_WEAK` | 顶对 + 踢脚低于牌面第二高点 | 弱顶对：会下注，但明显更少 |
 * | `MIDDLE_PAIR` | 中对 | 摊牌牌的主力 |
 * | `WEAK_PAIR` | 底对 / 小对子 | 摊牌牌的下沿 |
 * | `AIR` | 高牌 / 打公共牌（含错失听牌） | 唯一有诈唬动机的一档 |
 */
export const PublicStrengthBand = {
  NUT: 'NUT',
  STRONG_MADE: 'STRONG_MADE',
  TWO_PAIR: 'TWO_PAIR',
  OVERPAIR: 'OVERPAIR',
  TOP_PAIR_GOOD: 'TOP_PAIR_GOOD',
  TOP_PAIR_WEAK: 'TOP_PAIR_WEAK',
  MIDDLE_PAIR: 'MIDDLE_PAIR',
  WEAK_PAIR: 'WEAK_PAIR',
  AIR: 'AIR',
} as const;
export type PublicStrengthBand = (typeof PublicStrengthBand)[keyof typeof PublicStrengthBand];

export const PUBLIC_STRENGTH_BAND_ORDER: readonly PublicStrengthBand[] = Object.freeze([
  'NUT', 'STRONG_MADE', 'TWO_PAIR', 'OVERPAIR', 'TOP_PAIR_GOOD', 'TOP_PAIR_WEAK', 'MIDDLE_PAIR', 'WEAK_PAIR', 'AIR',
]);

export const PUBLIC_STRENGTH_BAND_ZH: Readonly<Record<PublicStrengthBand, string>> = Object.freeze({
  NUT: '坚果级（同花顺/四条/葫芦）',
  STRONG_MADE: '强成手（同花/顺子/三条）',
  TWO_PAIR: '两对',
  OVERPAIR: '超对',
  TOP_PAIR_GOOD: '顶对·好踢脚',
  TOP_PAIR_WEAK: '顶对·弱踢脚',
  MIDDLE_PAIR: '中对',
  WEAK_PAIR: '底对/小对子',
  AIR: '高牌（含错失听牌）',
});

/** 形态 → 公共强度带（纯映射，不新增判据） */
function bandOfShape(
  shape: HandShape,
  /** 顶对时用：**底牌里充当踢脚的那一张**的点数（必须是底牌自己的点数，见下） */
  holeKickerRank: number,
  secondBoardRank: number,
): PublicStrengthBand | null {
  switch (shape) {
    case 'STRAIGHT_FLUSH':
    case 'QUADS':
    case 'FULL_HOUSE':
      return PublicStrengthBand.NUT;
    case 'FLUSH':
    case 'STRAIGHT':
    case 'SET':
    case 'TRIPS':
      return PublicStrengthBand.STRONG_MADE;
    case 'TOP_TWO_PAIR':
    case 'TWO_PAIR':
      return PublicStrengthBand.TWO_PAIR;
    case 'OVERPAIR':
    case 'OVERPAIR_TOP':
    case 'POCKET_PAIR_OVER':
      return PublicStrengthBand.OVERPAIR;
    /*
     * 🔴 **踢脚判据必须用底牌自己的那张牌**（RIVER BET RANGE V2 修正）。
     *
     * `describeHand().kickerRank` 是「最佳五张里第二高的点数」——
     * 在 K-9-4-6-2 上持 K8 时它是 **9（公共牌自己的牌）**，
     * 于是 `kicker ≥ 牌面第二高点` 对**所有**顶对恒成立 ⇒ 「弱顶对」这一档
     * 永远为空（实测该带到达质量 0.000%）。那是判据退化，不是牌局事实。
     *
     * 正确口径：顶对时**另一张底牌**才是踢脚（配对的那张已经确定），
     * 用它跟牌面第二高点比较 —— 这就是扑克里的「top pair, good kicker」。
     */
    case 'TOP_PAIR':
      return holeKickerRank >= secondBoardRank
        ? PublicStrengthBand.TOP_PAIR_GOOD
        : PublicStrengthBand.TOP_PAIR_WEAK;
    case 'MIDDLE_PAIR':
      return PublicStrengthBand.MIDDLE_PAIR;
    case 'BOTTOM_PAIR':
    case 'UNDERPAIR':
      return PublicStrengthBand.WEAK_PAIR;
    case 'HIGH_CARD':
    case 'PLAY_THE_BOARD':
      return PublicStrengthBand.AIR;
    default: {
      // 穷尽性由类型保证；运行时遇到未知形态返回 null（宁可少算，也不猜）
      const exhaustive: never = shape;
      void exhaustive;
      return null;
    }
  }
}

/**
 * 一个对手组合的**公共**强度带。
 *
 * @returns `null` 表示牌面不足 3 张或牌力描述失败 —— 调用方必须把它单列成
 *   「无法分类」，**不允许**用一个猜出来的带顶上。
 */
export function publicStrengthBandOf(
  hole: readonly Card[],
  board: readonly Card[],
): PublicStrengthBand | null {
  if (hole.length !== 2 || board.length < 3) return null;
  let described: ReturnType<typeof describeHand>;
  try {
    described = describeHand([hole[0]!, hole[1]!], board);
  } catch {
    return null;
  }
  const boardRanks = [...new Set(board.map((c) => c.rank))].sort((a, b) => b - a);
  const topBoardRank = boardRanks[0] ?? 0;
  const secondBoardRank = boardRanks[1] ?? topBoardRank;
  /*
   * 顶对的踢脚 = **没有与牌面最高点配对的那一张底牌**。
   * 两张底牌点数相同时形态不可能是 `TOP_PAIR`（那时是对子/三条），
   * 因此这里必定能唯一确定踢脚。
   */
  const [r1, r2] = [hole[0]!.rank, hole[1]!.rank];
  const holeKickerRank = r1 === topBoardRank ? r2 : r1;
  return bandOfShape(described.shape, holeKickerRank, secondBoardRank);
}

/* ============================================================
 * P(BET | 公共强度带)
 * ============================================================ */

/**
 * 下注概率模型的**身份与不确定性**（可审计，不允许静默）。
 *
 * 🔴 这是一条**结构性先验**，不是校准过的频率。它只声称：
 * ① 单调（越强越可能下注，直到诈唬端反转）；② 非退化（任何带 > 0）；
 * ③ 随画像 / 尺寸 / 牌面变化。**它不声称任何具体百分比是真实的**。
 */
export type BetProbabilityModelFacts = {
  readonly kind: 'PUBLIC_BAND_SOFT_V2';
  readonly evidence: 'HEURISTIC_STRUCTURAL';
  /** 结构性非退化：任何带的任何画像下都严格 > 0（softplus 保证） */
  readonly nonDegenerate: true;
  /** 权重是否读过 Hero 的隐藏底牌 —— 恒为 `false`，由 D-1 测试锁住 */
  readonly usesHeroHiddenCards: false;
  /** softplus 的软化尺度（越小越接近原线性锚，越大越不容易退化为 0） */
  readonly softness: number;
  readonly ratioToPot: number;
  readonly boardTexture: string | null;
  /** 未校准的因子（全部列出来，便于将来用真实统计替换） */
  readonly factors: Readonly<Record<string, number>>;
  readonly noteZh: string;
};

/**
 * 🔴 **结构性非退化变换**（**不是**固定下限）。
 *
 * ```text
 * soft(x) = s · ln(1 + e^(x/s))          s = softness
 * ```
 *
 * | 性质 | 含义 |
 * |---|---|
 * | `soft(x) > 0` 恒成立 | 任何带都不会因为一次夹取而**整类消失** |
 * | `x ≥ 2s` 时 `soft(x) ≈ x` | 强价值锚**不被改写**（实测 +0.3%） |
 * | `x → −∞` 时指数衰减 | 不是「给所有牌加一个常数」：**随画像连续变化** |
 * | 在 `x/s < −40` 前都严格为正 | 本模型的取值域内不可能出现精确 0 |
 *
 * ⚠️ 与「固定下限」的区别（第三阶段明令禁止后者）：
 * 固定下限会让**不同画像、不同带**得到同一个数；这里每个带的值仍由
 * 画像维度、尺寸、牌面纹理共同决定，软化只改变「趋近 0 的方式」。
 */
function softPositive(x: number, softness: number): number {
  /*
   * 取值域夹取（**不是**下注率下限）：
   * - 上界 0.95：模型不声称任何带「必然下注」；尺寸极化在极端画像下
   *   可以把 x 推到 1 以上，而 `soft(x) ≈ x` 会让它越过 1（实测 1.0333）。
   * - 下界 −4：`soft(−4) ≈ 8e−31 > 0`，此处只是防止指数下溢成精确 0。
   */
  const bounded = Math.max(-4, Math.min(0.95, x));
  const z = bounded / softness;
  if (z > 40) return bounded;
  return softness * Math.log1p(Math.exp(z));
}

/**
 * 尺寸 → 极化程度（§二十一，**语义与修复前一致**）。
 *
 * 只把「尺寸」这一步从「先夹取再极化」改成「先极化、最后统一做非退化变换」，
 * 否则大尺寸的极化会把小概率带再一次夹到 0（那正是本轮要修的形态）。
 */
function sizePolarized(anchor: number, exponent: number): number {
  return 0.5 + (anchor - 0.5) * exponent;
}

/**
 * **P(BET | 公共强度带)** —— 本模块唯一的权重来源。
 *
 * 输入全部是**公共信息 + 画像**：
 * 画像维度（`ResponseTendencies.effectiveDimensions`）、下注额 / 底池、牌面纹理。
 * **没有任何一个输入是 Hero 的底牌。**
 *
 * ## 锚点（沿用修复前的三条公式，语义未变）
 *
 * ```text
 * value = 0.45 + 0.30×aggro + 0.25×bluff          强价值
 * thin  = 0.25 + 0.30×aggro + 0.30×bluff          薄价值
 * show  = 0.10 + 0.15×aggro + 0.15×bluff − 0.20×passive   摊牌牌
 * bluff = bluffTendency × value                    诈唬（锚在价值上）
 * center(v) = (v − 0.5) × 2
 * ```
 *
 * 修复前 `show` 在小/负值时被 `clamp01` 夹成**精确 0**；现在它经过
 * `softPositive` ⇒ 恒 > 0（实测被动画像：`show = −0.125 ⇒ 0.0071`）。
 *
 * ## 带 → 锚（结构性系数，**未校准**）
 *
 * | 带 | 锚 | 结构性系数 |
 * |---|---|---|
 * | `NUT` / `STRONG_MADE` | value | ×1 |
 * | `TWO_PAIR` | thin | ×1 |
 * | `OVERPAIR` | thin | ×0.85（保护价值略低） |
 * | `TOP_PAIR_GOOD` | thin | ×0.70 × 牌面系数 |
 * | `TOP_PAIR_WEAK` | thin | ×0.40 × 牌面系数 |
 * | `MIDDLE_PAIR` | show | ×1.00 × 牌面系数 |
 * | `WEAK_PAIR` | show | ×0.60 × 牌面系数 |
 * | `AIR` | bluff | ×1（独立于价值阶梯） |
 *
 * ⚠️ 这些系数只声称**序关系**（价值 > 薄价值 > 顶对 > 中对 > 底对；
 * 诈唬端独立），并由**强度阶梯护栏**强制保持。幅度是启发式的，
 * **没有任何实测统计支撑**，因此全部随 `model.factors` 一起导出，
 * 供将来用真实数据替换。
 */
export function betProbabilityByBand(input: {
  tendencies: ResponseTendencies;
  /** `betChips / pot`。缺省（`undefined`）⇒ 用中注锚点 ⇒ 与无尺寸版本逐位一致 */
  ratioToPot?: number;
  /** 牌面纹理（`boardTextureLabelOf` 的输出）；缺省 ⇒ 不做牌面调整 */
  boardTexture?: string | null;
}): {
  readonly rates: Readonly<Record<PublicStrengthBand, number>>;
  readonly anchors: { readonly value: number; readonly thin: number; readonly showdown: number; readonly bluff: number };
  readonly model: BetProbabilityModelFacts;
} {
  const dims = input.tendencies.effectiveDimensions;
  const centered = (v: number | undefined): number => {
    const x = Number.isFinite(v) ? Math.max(0, Math.min(1, v as number)) : 0.5;
    return (x - 0.5) * 2;
  };
  const aggro = centered(dims?.aggression);
  const bluff = centered(dims?.bluffTendency);
  const passive = centered(dims?.passivity);
  const bluffTendency = Number.isFinite(dims?.bluffTendency)
    ? Math.max(0, Math.min(1, dims!.bluffTendency as number))
    : 0.5;

  const ANCHOR = 2 / 3;
  const SOFTNESS = 0.06;
  /*
   * `ratioToPot` 的取值域：模型只声称在中注锚点附近有意义的行为，
   * 因此把它限制在 [0, 4] —— 超出这个范围时指数项会让所有带一起饱和，
   * 那是「模型没话说」而不是「他真的这么打」。
   */
  const ratio = Number.isFinite(input.ratioToPot)
    ? Math.max(0, Math.min(4, input.ratioToPot as number))
    : ANCHOR;
  const valueExponent = 1 + 0.5 * (ratio - ANCHOR);
  const bluffExponent = 1 + 0.7 * (ratio - ANCHOR);

  /** 结构性系数（未校准；只声称序关系） */
  const factors = Object.freeze({
    twoPair: 1,
    overpair: 0.85,
    topPairGood: 0.7,
    topPairWeak: 0.4,
    middlePair: 1,
    weakPair: 0.6,
  });

  /*
   * 牌面纹理：干燥牌面上的薄价值/摊牌牌更愿意下注（对手更难反超），
   * 湿润/成对牌面更倾向过牌控制底池。**只声称方向**。
   *
   * ⚠️ 系数刻意压在 1.10 以内（且小于相邻带的间距），
   * 使牌面调整**不会**把「两对 > 超对 > 顶对」这条序关系翻过来。
   */
  const texture = input.boardTexture ?? null;
  const textureThin =
    texture === 'DRY' ? 1.1
      : texture === 'PAIRED' ? 0.9
        : texture === 'WET' ? 0.85
          : texture === 'MONOTONE' ? 0.8
            : 1;
  const textureMid =
    texture === 'DRY' ? 1.1
      : texture === 'PAIRED' ? 0.95
        : texture === 'WET' ? 0.9
          : texture === 'MONOTONE' ? 0.85
            : 1;
  const clamped = ratio !== (Number.isFinite(input.ratioToPot) ? (input.ratioToPot as number) : ANCHOR);

  const valueAnchor = 0.45 + 0.3 * aggro + 0.25 * bluff;
  const thinAnchor = 0.25 + 0.3 * aggro + 0.3 * bluff;
  const showAnchor = 0.1 + 0.15 * aggro + 0.15 * bluff - 0.2 * passive;
  const bluffAnchor = bluffTendency * valueAnchor;

  /** 尺寸极化（§二十一）→ 非退化变换。**带系数在变换之后施加**（见下） */
  const anchorRate = (anchor: number, exponent: number): number =>
    softPositive(sizePolarized(anchor, exponent), SOFTNESS);

  const valueRate = anchorRate(valueAnchor, valueExponent);
  const thinRate = anchorRate(thinAnchor, valueExponent);
  const showRate = anchorRate(showAnchor, valueExponent);
  const airRate = anchorRate(bluffAnchor, bluffExponent);

  /*
   * 🔴 **序关系必须在「带系数」这一步保持**，因此系数乘在**变换之后的速率**上，
   * 而不是乘在锚点上。
   *
   * 反例（修复过程中实测到的形态）：把系数乘在锚点上时，若锚点为负
   * （被动画像的摊牌锚 `show = −0.125`），`show × 0.6` 反而**更接近 0**，
   * 于是「底对」的下注率高于「中对」—— 序关系被系数**翻转**。
   * 乘在正速率上则恒保持序关系（所有速率 > 0）。
   */
  const raw: Record<PublicStrengthBand, number> = {
    NUT: valueRate,
    STRONG_MADE: valueRate,
    TWO_PAIR: thinRate * factors.twoPair,
    OVERPAIR: thinRate * factors.overpair,
    TOP_PAIR_GOOD: thinRate * factors.topPairGood * textureThin,
    TOP_PAIR_WEAK: thinRate * factors.topPairWeak * textureThin,
    MIDDLE_PAIR: showRate * factors.middlePair * textureMid,
    WEAK_PAIR: showRate * factors.weakPair * textureMid,
    AIR: airRate,
  };

  /*
   * 🔴 **强度阶梯护栏**（结构性不变量，不是下限）：
   * 公共强度带越高，下注率必须**非递增**（到诈唬端为止）：
   *
   * ```text
   * NUT = STRONG_MADE ≥ TWO_PAIR ≥ OVERPAIR ≥ TOP_PAIR_GOOD ≥ TOP_PAIR_WEAK ≥ MIDDLE_PAIR ≥ WEAK_PAIR
   * AIR 独立（诈唬锚），不与价值阶梯比较
   * ```
   *
   * 它只做「取相邻上界的较小值」，因此：① 不会把任何带压到 0；
   * ② 不引入任何固定常数；③ 把「牌面/尺寸/画像把序关系弄反」这种
   * 建模事故挡在输出之外。
   */
  const ladder: PublicStrengthBand[] = [
    'NUT', 'STRONG_MADE', 'TWO_PAIR', 'OVERPAIR', 'TOP_PAIR_GOOD', 'TOP_PAIR_WEAK', 'MIDDLE_PAIR', 'WEAK_PAIR',
  ];
  const rates: Record<PublicStrengthBand, number> = { ...raw };
  for (let i = 1; i < ladder.length; i += 1) {
    const prev = rates[ladder[i - 1]!];
    const here = rates[ladder[i]!];
    if (here > prev) rates[ladder[i]!] = prev;
  }

  const model: BetProbabilityModelFacts = Object.freeze({
    kind: 'PUBLIC_BAND_SOFT_V2',
    evidence: 'HEURISTIC_STRUCTURAL',
    nonDegenerate: true,
    usesHeroHiddenCards: false,
    softness: SOFTNESS,
    ratioToPot: ratio,
    boardTexture: texture,
    factors: Object.freeze({ ...factors, textureThin, textureMid, valueExponent, bluffExponent }),
    noteZh:
      `公共强度带模型（结构性先验，**未经统计校准**）：软化 ${SOFTNESS}，` +
      `尺寸比 ${ratio.toFixed(3)}${clamped ? '（已按模型取值域 [0,4] 限制）' : ''}，` +
      `牌面 ${texture ?? '未知'}（薄价值 ×${textureThin}、摊牌 ×${textureMid}）｜` +
      `锚：价值 ${valueAnchor.toFixed(4)}、薄价值 ${thinAnchor.toFixed(4)}、摊牌 ${showAnchor.toFixed(4)}、诈唬 ${bluffAnchor.toFixed(4)}｜` +
      '权重**不读 Hero 底牌**；与 Hero 的关系只用于解释',
  });

  return Object.freeze({
    rates: Object.freeze(rates),
    anchors: Object.freeze({ value: valueAnchor, thin: thinAnchor, showdown: showAnchor, bluff: bluffAnchor }),
    model,
  });
}

/* ============================================================
 * 到达范围 → 下注范围
 * ============================================================ */

/** 下注范围按**公共强度带**的质量分解（§十 的第二把尺子：不依赖 Hero） */
export type BetRangeBandMasses = {
  /** 到达范围（扣死牌后归一）的带质量 */
  readonly arrival: Readonly<Record<PublicStrengthBand, number>>;
  /** 下注范围（归一后）的带质量 */
  readonly bet: Readonly<Record<PublicStrengthBand, number>>;
};

export type BetRangeFacts = {
  /** 归一化后的下注范围（可直接喂给权益引擎） */
  readonly entries: readonly ArrivalEntry[];
  /** 下注范围的类别质量（**属于 BET RANGE**；相对 Hero，**仅用于解释**） */
  readonly classMasses: BetRangeClassMasses;
  /** 下注范围 / 到达范围的**公共强度带**质量 */
  readonly bandMasses: BetRangeBandMasses;
  /** 每个公共强度带的 `P(BET | band)`（审计用） */
  readonly bandRates: Readonly<Record<PublicStrengthBand, number>>;
  /** 权重模型的身份与不确定性 */
  readonly model: BetProbabilityModelFacts;
  /** 到达范围的总质量（用于回答「他下注的比例」） */
  readonly arrivalMass: number;
  /** 下注范围的总质量（归一化前） */
  readonly betMass: number;
  /** `betMass / arrivalMass` —— 他到达的牌里有多少比例会下注 */
  readonly betShareOfArrival: number;
  /**
   * 🔴 **等效组合数** `(Σp)² / Σp²`（逆辛普森）。
   *
   * 软权重下**没有任何组合被精确清零**，因此 `entries.length` 恒等于到达支持集，
   * 它不再能回答「真正在下注的是多少手牌」。等权时它等于组合数，
   * 一个组合独占时它 → 1。**报告「下注范围有多宽」请用它，不要用 `entryCount`。**
   */
  readonly effectiveComboCount: number | null;
  /** 承载 90% 下注质量所需的最少组合数 */
  readonly posteriorMassCombos90: number | null;
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
   * 范围极化信号消失。本模块用 `actualRatio` 报告、用 `modeledRatio` 建模，
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
 * 他「拿强成手下注」的概率 —— 保留为**模型自检**（开发期交叉验证用）。
 *
 * ⚠️ 它**不参与**任何权重计算：V2 起价值端的频率完全由
 * `betProbabilityByBand` 的锚点决定，避免出现第二把尺子。
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

/**
 * 由**到达范围**构造**下注范围**。
 *
 * ```text
 * betWeight(combo) = arrivalWeight(combo) × P(BET | 公共强度带(combo))
 * BettingRange     = betWeight 归一化
 * ```
 *
 * ⚠️ **传入的到达范围必须已经排除「当前这一次下注」**（见文件头 ①）。
 * 本函数无法校验这一点（它只拿到权重），因此调用方
 * （`contextBuilder` 的 `betRangeArrival` 捕获）必须保证；
 * `updateTrace` 与 `betRangeArrival` 里都能看到证据。
 *
 * @param input.bluffShareOverride 平衡诈唬注入点（供合成向量测试使用）：
 *   给了就直接用它当 `AIR` 带的下注概率。⚠️ 它不是硬编码阈值 ——
 *   `null`（缺省）时一切都由公共强度带模型推导。
 */
export function buildBettingRangeFacts(input: {
  arrivalEntries: readonly ArrivalEntry[];
  board: readonly Card[];
  /**
   * Hero 底牌。
   *
   * 🔴 **只用于「合法阻断」与「相对 Hero 的类别报告」**，
   * **绝不进入任何下注权重**（第四阶段；D-1 测试锁住）。
   */
  heroHole: readonly Card[];
  potChips: number;
  betChips: number;
  street: 'FLOP' | 'TURN' | 'RIVER';
  tendencies: ResponseTendencies;
  maxRatio?: number;
  bluffShareOverride?: number | null;
  /** 牌面纹理（缺省 ⇒ 由 `board` 现算，保持单一事实来源） */
  boardTexture?: string | null;
}): BetRangeFacts | null {
  const { board, heroHole } = input;
  if (board.length < 3 || heroHole.length !== 2) return null;
  if (!(input.potChips > 0)) return null;
  /** 非法下注额（≤0 / NaN / Infinity）⇒ 没有「下注范围」可言，不编造 */
  if (!Number.isFinite(input.betChips) || !(input.betChips > 0)) return null;

  const maxRatio = input.maxRatio ?? 1;
  const actualRatio = input.betChips / input.potChips;
  const modeledRatio = Math.min(actualRatio, maxRatio);
  const sizeApproximation = actualRatio > maxRatio + 1e-9;

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
  const arrivalBand = Object.fromEntries(
    PUBLIC_STRENGTH_BAND_ORDER.map((b) => [b, 0]),
  ) as Record<PublicStrengthBand, number>;
  const betBand = Object.fromEntries(
    PUBLIC_STRENGTH_BAND_ORDER.map((b) => [b, 0]),
  ) as Record<PublicStrengthBand, number>;

  const betEntries: ArrivalEntry[] = [];
  let arrivalMass = 0;
  let betMass = 0;
  let reachable = 0;
  let unclassifiedMass = 0;
  let unclassifiedBetMass = 0;
  let blockedCount = 0;

  /** 唯一的权重来源：公共强度带（**不读 heroHole**） */
  const byBand = betProbabilityByBand({
    tendencies: input.tendencies,
    ratioToPot: modeledRatio,
    boardTexture: input.boardTexture ?? boardTextureLabelOf(board),
  });

  for (const entry of input.arrivalEntries) {
    const p = entry.probability;
    if (!(p > 0)) continue;
    const hole: [Card, Card] = [
      ALL_CARDS[entry.cardIndices[0]]!,
      ALL_CARDS[entry.cardIndices[1]]!,
    ];
    // 与 Hero / 公共牌重叠的组合永远到不了这里（死牌）——**合法阻断**，两侧都不计
    if (hole.some((c) => heroSet.has(`${c.rank}${c.suit}`) || boardSet.has(`${c.rank}${c.suit}`))) {
      blockedCount += 1;
      continue;
    }
    arrivalMass += p;
    reachable += 1;

    const band = publicStrengthBandOf(hole, board);
    if (band === null) {
      unclassifiedMass += p;
      continue;
    }
    arrivalBand[band] += p;

    let w = byBand.rates[band];
    if (typeof input.bluffShareOverride === 'number' && band === PublicStrengthBand.AIR) {
      w = Math.max(0, Math.min(1, input.bluffShareOverride));
    }

    /*
     * 相对 Hero 的类别 —— **只用于解释**。
     *
     * 分类失败**不影响权重**（权重是公共的），只是这一份质量进 `unclassified`：
     * 若让分类失败反过来删除组合，Hero 的底牌就又间接控制了下注范围。
     */
    const cls = riverComboClassOf({ hole, board, heroHole });
    if (cls === null) unclassifiedBetMass += p * w;
    else byClass[cls.category] += p * w;

    if (!(w > 0)) continue;
    const betWeight = p * w;
    betMass += betWeight;
    betBand[band] += betWeight;
    betEntries.push({ cardIndices: entry.cardIndices, probability: betWeight });
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
    unclassifiedMass: n(unclassifiedBetMass),
  });

  const normBand = (src: Record<PublicStrengthBand, number>, denom: number): Record<PublicStrengthBand, number> =>
    Object.fromEntries(
      PUBLIC_STRENGTH_BAND_ORDER.map((b) => [b, denom > 0 ? src[b] / denom : 0]),
    ) as Record<PublicStrengthBand, number>;

  const bandMasses: BetRangeBandMasses = Object.freeze({
    arrival: Object.freeze(normBand(arrivalBand, arrivalMass)),
    bet: Object.freeze(normBand(betBand, betMass)),
  });

  const sizing = Object.freeze({
    actualBetChips: input.betChips,
    potChips: input.potChips,
    actualRatio,
    modeledRatio,
    sizeApproximation,
  });

  const topBands = PUBLIC_STRENGTH_BAND_ORDER
    .map((b) => ({ b, m: bandMasses.bet[b] }))
    .sort((x, y) => y.m - x.m)
    .slice(0, 3)
    .map((x) => `${PUBLIC_STRENGTH_BAND_ZH[x.b]} ${(x.m * 100).toFixed(1)}%`)
    .join('、');

  return Object.freeze({
    entries: Object.freeze(normalized),
    classMasses,
    bandMasses,
    bandRates: byBand.rates,
    model: byBand.model,
    arrivalMass,
    betMass,
    betShareOfArrival: arrivalMass > 0 ? betMass / arrivalMass : 0,
    effectiveComboCount: effectiveCombosOf(normalized.map((e) => e.probability)),
    posteriorMassCombos90: posteriorMassCombosOf(normalized.map((e) => e.probability), 0.9),
    sizing,
    noteZh:
      `下注范围（BET RANGE，**不是**到达范围）：到达 ${reachable} 组合中 ` +
      `${normalized.length} 个会下注（质量占比 ${(arrivalMass > 0 ? (betMass / arrivalMass) * 100 : 0).toFixed(1)}%）｜` +
      `牌型主力：${topBands}｜` +
      `（与 Hero 的关系，**仅供解释**）价值 ${(classMasses.valueMass * 100).toFixed(1)}% / ` +
      `诈唬 ${(classMasses.bluffMass * 100).toFixed(1)}% / 摊牌 ${(classMasses.showdownMass * 100).toFixed(1)}%｜` +
      `尺寸 实际 ${actualRatio.toFixed(3)} 池、建模 ${modeledRatio.toFixed(3)} 池` +
      (sizeApproximation ? ' ⇒ **SIZE_APPROXIMATION = TRUE**（超出网格上限）' : '') +
      `｜死牌阻断 ${blockedCount} 组合（不计入任何一侧）`,
  });
}

/** 供测试/审计使用的自检入口（不参与生产权重） */
export const __betRangeSelftest = Object.freeze({ valueBetShareOf });
