/**
 * 🔴 **下注响应模型 + 下注 EV（BET DECISION ENGINE PHASE 1）**
 *
 * ## 这个模块解决什么（真实缺陷，不是理论洁癖）
 *
 * 审计（`reports/TURN_SEMIBLUFF_ZERO_AUDIT.md`）确认：修复前的下注决策只有
 * **一个** size-blind 的启发式偏好分，并且：
 *
 * ```text
 * 半诈唬的全部正项 = bluffComponent × 0.5（一个近似常数）
 * valuePart        = (equity − 50%) / 50%  ⇒ 权益 < 50% 时恒为 0
 * foldEquity       = NOT_IMPLEMENTED
 * Hero 自身听牌     = 只用于打标签，不进评分
 * ⇒ 权益 44% 的坚果同花听在转牌 raw = −0.0985，结构上不可能为正
 * ```
 *
 * 本模块补上缺的三块能力（**全部可解释、有界、可审计**）：
 *
 * | 能力 | 落点 | 证据等级 |
 * |---|---|---|
 * | 对手面对**每个尺寸**的 fold / call / raise 概率 | `buildResponseModel` | 【启发式】分类 + 【数学确定】逐组合强弱比较 |
 * | 每个尺寸的 fold / call / raise 条件范围 | `buildResponseModel().sizes[].buckets` | 组合权重变化（组合集不变） |
 * | 下注 EV（三分支）+ 权益实现因子 | `composeBetEV` / `realizationFactorOf` | 三分支公式【数学确定】；realization【启发式·代理】 |
 * | Hero 自身听牌的**非权益**通道 | `heroDrawPotentialOf` | 【数学确定】补牌计数 + 【启发式】nut 潜力 |
 *
 * ## 三条不可违背的纪律
 *
 * 1. **不许把听牌当第二次权益**：`computeEquity` 已经把「未来发牌」跑完
 *    （`equity.ts` 枚举/抽样到河牌），因此 `heroDrawPotentialOf` 的结果
 *    **只**用于权益实现（realization）、nut 潜力与半诈唬质量，
 *    **绝不**再加到 equity 上。这条有测试锁定（§十三.1）。
 * 2. **不硬编码牌局/牌面/具体手牌**：所有输入都来自范围、牌面、位置、
 *    筹码、画像维度与观测；没有任何 `if (hand === 'AsJs')` 之类分支。
 * 3. **不伪造 EV**：本模块输出的是**启发式代理 EV**（三分支结构的期望值，
 *    未来街用 `realizationFactor` 近似）。UI 与 debug 必须标 `HEURISTIC`，
 *    不得称为 Solver EV。
 */

import type { Card, Street } from '../types.ts';
import { ALL_CARDS } from '../types.ts';
import { compareHands, evaluateCards, type EvaluatedHand } from '../poker/handEval.ts';
import { boardRelativeTierOf } from '../poker/boardRelativeStrength.ts';
import { drawProfileOf } from './draws.ts';
import type { PlayerDimensions } from '../player/playerClassifier.ts';

/* ============================================================
 * 尺寸
 * ============================================================ */

export const BetSizeClass = {
  SMALL: 'BET_SMALL',
  MEDIUM: 'BET_MEDIUM',
  LARGE: 'BET_LARGE',
} as const;
export type BetSizeClass = (typeof BetSizeClass)[keyof typeof BetSizeClass];

/**
 * 三个尺寸类别 → 建模用的底池比例。
 *
 * ⚠️ 这三个比例是**建模刻度**（与 `legalActions` 的下注网格 25%/33%/50%/67%/75%/100%
 * 对齐），实际落注金额仍由既有 `buildSizeGrid` + `pickClosestAggressive` 决定 ——
 * 本模块不生成金额，只回答「这个尺寸下他会怎么反应」。
 */
export const BET_SIZE_SPECS: readonly {
  kind: BetSizeClass;
  ratioToPot: number;
  labelZh: string;
}[] = Object.freeze([
  { kind: BetSizeClass.SMALL, ratioToPot: 1 / 3, labelZh: '小注（≈1/3 池）' },
  { kind: BetSizeClass.MEDIUM, ratioToPot: 2 / 3, labelZh: '中注（≈2/3 池）' },
  { kind: BetSizeClass.LARGE, ratioToPot: 1, labelZh: '大注（≈1 池）' },
]);

export const BET_SIZE_CLASS_ZH: Readonly<Record<BetSizeClass, string>> = Object.freeze({
  BET_SMALL: '小注',
  BET_MEDIUM: '中注',
  BET_LARGE: '大注',
});

/* ============================================================
 * 🔴 合法尺寸（P0：先合法化，再算 Response / EQ / EV）
 * ============================================================ */

/**
 * 一个**合法**下注尺寸。
 *
 * ## 为什么必须先合法化（本轮 P0 的根因）
 *
 * 修复前的顺序是「理论尺寸 → 响应模型 → EV → 最后才映射到合法动作」，
 * 于是在低 SPR 河牌出现：
 *
 * ```text
 * MEDIUM 理论 118（> 身后 112）→ 用 118 算 P(弃)/EV = 169.2 → 最后映射成 112
 * LARGE  理论 177（> 身后 112）→ 用 177 算 P(弃)/EV =  89.7 → 最后映射成 112
 * ⇒ 同一个**合法**动作（全下 112）却有两套不同的响应概率与 EV —— 非法游戏树
 * ```
 *
 * 正确顺序（本轮实现）：
 *
 * ```text
 * 理论尺寸 → 按有效筹码封顶 → 夹到合法区间 → 按金额去重
 *          → 用**合法金额**建响应模型 → 条件范围 → 权益 → EV → 动作
 * ```
 *
 * 由此得到强契约（有测试锁定）：
 * **同一个合法金额 ⇒ 同一份响应模型 ⇒ 同一条件范围 ⇒ 同一权益 ⇒ 同一 EV**。
 */
export type LegalBetSize = {
  /** 合法动作标签（`ALL_IN` = 合法金额等于 Hero 剩余筹码） */
  kind: BetSizeClass | 'ALL_IN';
  /** 理论目标金额（`pot × ratio`）—— 只进 debug，绝不参与 EV */
  requestedAmount: number;
  /** 合法金额（已按有效筹码与最大下注封顶）—— **所有计算都用它** */
  legalAmount: number;
  /** 是否被封顶（`requestedAmount > legalAmount`） */
  wasCapped: boolean;
  /** 该合法金额来自哪个理论类别（去重后保留理论金额最小的那个） */
  requestedKind: BetSizeClass;
  labelZh: string;
};

/**
 * 把理论尺寸合法化。
 *
 * ```text
 * maxBet   = min(Hero 剩余筹码, 对手剩余筹码)      ← 单挑有效筹码（不能只用自己的）
 * legal    = clamp(requested, 0, maxBet)
 * 若 legal < 最小下注 且 legal < Hero 剩余筹码 ⇒ 该尺寸在本节点**不合法**，丢弃
 * 若 legal ≥ Hero 剩余筹码                    ⇒ 标签 ALL_IN（不足最小注的全下仍合法）
 * 按 legal 金额去重（保留理论金额最小者）
 * ```
 *
 * ⚠️ 用的是**当前剩余**筹码，不是带入筹码；也不是「Hero 总筹码」（Murphy §14.1/§14.16）。
 */
export function legalizeBetSizes(input: {
  pot: number;
  heroRemaining: number;
  villainRemaining: number;
  /** 最小下注额（通常 1 个大盲；全下不受此约束） */
  minBet: number;
  specs?: readonly { kind: BetSizeClass; ratioToPot: number; labelZh: string }[];
}): { sizes: readonly LegalBetSize[]; dropped: readonly LegalBetSize[] } {
  const specs = input.specs ?? BET_SIZE_SPECS;
  const heroRemaining = Math.max(0, Number.isFinite(input.heroRemaining) ? input.heroRemaining : 0);
  const villainRemaining = Math.max(0, Number.isFinite(input.villainRemaining) ? input.villainRemaining : 0);
  const pot = Math.max(0, Number.isFinite(input.pot) ? input.pot : 0);
  // 单挑有效筹码：他跟我都拿不出更多 ⇒ 这是真正能进底池的上限
  const maxBet = Math.min(heroRemaining, villainRemaining);

  const kept: LegalBetSize[] = [];
  const dropped: LegalBetSize[] = [];
  const seen = new Set<number>();

  for (const spec of specs) {
    const requestedAmount = pot * spec.ratioToPot;
    /*
     * ⚠️ **合法下注额保留小数**（既有契约，`test/betDecisionEngine.test.ts` 的 P0-1/P0-1b 明写：
     * 「底池 29 ⇒ 三个尺寸必须是 9.667 / 19.333 / 29」）。
     *
     * 我一度在这里加 `Math.round` 去修「被评估金额 vs 被推荐金额」的不一致 ——
     * 那会破坏这条已验证的比例契约（尺寸必须严格按底池比例），因此**回退**。
     * 一致性改由**决策层**保证：把「被评估的那个金额」补进候选
     *（见 `decisionEngine` 的 `candidatesForDecision`），推荐金额随之等于被评估金额。
     */
    const legalAmount = Math.max(0, Math.min(requestedAmount, maxBet));
    const isAllIn = legalAmount >= heroRemaining - 1e-9 && heroRemaining > 0;
    const base: LegalBetSize = {
      kind: isAllIn ? 'ALL_IN' : spec.kind,
      requestedAmount,
      legalAmount,
      wasCapped: requestedAmount > legalAmount + 1e-9,
      requestedKind: spec.kind,
      labelZh: isAllIn ? '全下（= 剩余筹码）' : spec.labelZh,
    };

    // §14.19：没有筹码 ⇒ 不能产生 BET
    if (heroRemaining <= 0 || legalAmount <= 0) {
      dropped.push(base);
      continue;
    }
    // 最小下注约束：不足最小注且不是全下 ⇒ 该尺寸不合法（§14.20）
    if (legalAmount < input.minBet - 1e-9 && !isAllIn) {
      dropped.push(base);
      continue;
    }
    // 同一合法金额只保留一个候选（§1 / T1）
    const key = Math.round(legalAmount * 1e6) / 1e6;
    if (seen.has(key)) {
      dropped.push(base);
      continue;
    }
    seen.add(key);
    kept.push(base);
  }

  return { sizes: Object.freeze(kept), dropped: Object.freeze(dropped) };
}

/* ============================================================
 * 对手面对下注的行为倾向（**响应层** —— 与 range 层是不同的量）
 * ============================================================ */

/**
 * 由画像维度导出的**响应**倾向。
 *
 * ## 为什么这不是「画像重复计数」
 *
 * range 层用画像回答的是 `P(手牌 | 动作, 画像)` —— **他有什么牌**。
 * 本结构回答的是 `P(反应 | 我的下注, 画像)` —— **他拿着这些牌会怎么做**。
 * 两个量不同，因此允许同时使用同一份画像维度。
 *
 * ⚠️ 但**同一份证据不得在同一个量上收两次费**：
 * - 压缩因子（`aggressionCredibility`）已经由 range 层（画像调整后的范围）承担，
 *   因此 scorer 层**不再**乘 `profileCompressionMultiplier`（见 `DOUBLE_COUNT_BLOCKED`）。
 * - 近期观测（`AGGRESSION_UP` 等）已在 range 层改过似然，因此**不**在这里二次生效。
 */
export type ResponseTendencies = {
  /** 更爱跟（跟注站 / 松） */
  callScale: number;
  /** 更爱弃（紧 / 过弃） */
  foldScale: number;
  /** 更爱加注（凶 / 疯子） */
  raiseScale: number;
  /** 诈唬加注倾向（爱诈唬） */
  bluffRaiseScale: number;
  /**
   * 🔴 **Hero 过牌之后他下注的倾向**（河牌 CHECK 树用；§7）。
   *
   * 由 aggression / bluffTendency / passivity 三个维度合成：
   * 跟注站/被动 ⇒ ↓、疯子/过度诈唬 ⇒ ↑、不诈唬型/极紧 ⇒ ↓。
   * 它**只改变行为概率**，不制造任何不存在的组合。
   */
  riverBetScale: number;
  /**
   * 🔴 **PLAYER PROFILE V3：分街系数**。
   *
   * 由**连续统计**（`FoldTo{Flop,Turn,River}CBet` / `*CheckRaise`）解析而来，
   * 每条统计**只进它自己那一街**（§七 / §八）。
   *
   * ⚠️ 缺省（无统计）时三个字段**逐位等于 1** ⇒ 与 V2 **恒等**，
   * 因此这是一个**纯增量**字段，不改变任何既有行为。
   */
  streetFoldScale?: number;
  streetCallScale?: number;
  streetCheckRaiseScale?: number;
  /**
   * 🔴 **TEST 08 P0-2：分街下注倾向**（Hero 过牌之后他开枪的倾向）。
   *
   * `riverBetScale` 是**河牌专属**（由 aggression / bluffTendency / passivity
   * 合成，语义是「河牌他愿不愿意开最后一枪」）。翻牌/转牌用同一个数会
   * 忽略「他这一街到底爱不爱开火」。
   *
   * 本字段把 V3 的**分街**证据接进来：他在这条街上**继续游戏**的强度越高
   * （`streetCallScale` 由该街的面对下注弃牌率反推），说明他的范围在这一街
   * 越有黏性 ⇒ 开枪倾向越高。幅度刻意**很温和**（±20%），因为
   * 「不爱弃」与「爱下注」是两个不同的量，不能等同。
   *
   * ⚠️ 缺省（无统计 / 非河牌以外的旧调用）为**精确的 1** ⇒ V2 恒等。
   */
  streetBetScale?: number;
  /**
   * 🔴 **TEST 09**：实际参与计算的四个维度（已含标签/实测的合并结果）。
   *
   * 为什么必须显式带出来：下游（例如 `bettingRange.ts`）需要
   * `bluffTendency` 来定「他拿无摊牌价值的牌诈唬的比例」，而
   * `ResponseTendencies` 只暴露**已按可信度缩放**的倍率
   * （`bluffRaiseScale = 1 + 0.35 × center(bluff) × confidence`），
   * 从它反推维度要除一个可能为 0 的 `confidence` —— 那既脆弱又会掩盖错误。
   *
   * `null` ⇒ 无画像（四个维度都是中立 0.5）。
   */
  effectiveDimensions?: {
    tightness: number;
    aggression: number;
    bluffTendency: number;
    passivity: number;
  } | null;
  /** 参与计算的画像可信度（0 = 无画像 ⇒ 全部为 1） */
  confidence: number;
  noteZh: string;
};

/**
 * 🔴 **TEST 08 P0-2：分街下注倾向（最终值）**。
 *
 * 输入是 V3 已经算好的 `StreetFactors.betScale`（由**未受节点语义门约束**的
 * 该街弃牌统计导出，见 `observedStats.streetBetScaleOfTrait`），
 * 这里只按画像可信度收缩一次。
 *
 * ```text
 * streetBetScale = 1 + (betScaleFromStats − 1) × confidence
 * ```
 *
 * - `betScaleFromStats = 1`（无统计 / 无语义）⇒ 结果**精确的 1** ⇒ V2 恒等；
 * - `confidence` 只在这里乘**一次**（`observedStats` 那边已经通过
 *   `effectiveRate` 收过一次，但那是**统计的**收缩，不是**画像可信度**的）
 *   —— 两者是不同来源，不构成重复计费。
 *
 * ⚠️ 保留 `streetFoldScale` 形参**只为向后兼容签名**，不再参与计算：
 * 第一版用它做映射，符号是错的（高 `foldScale` = 他更爱弃 ≠ 他更爱开枪）；
 * 正确做法是从统计的**原始语义**出发（见 `streetBetScaleOfTrait`）。
 */
export function streetBetScaleOf(
  streetFoldScale: number,
  confidence: number,
  betScaleFromStats: number,
): number {
  void streetFoldScale;
  const raw = Number.isFinite(betScaleFromStats) ? betScaleFromStats : 1;
  const conf = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
  return 1 + (raw - 1) * conf;
}

/** 中立倾向（无画像 / 可信度 0） */
export function neutralResponseTendencies(noteZh = '无画像：响应概率只用范围与尺寸决定'): ResponseTendencies {
  return Object.freeze({
    callScale: 1,
    foldScale: 1,
    raiseScale: 1,
    bluffRaiseScale: 1,
    riverBetScale: 1,
    /*
     * 🔴 V3 分街系数：缺省必须是**精确的 1**（不是 0.999…）。
     * 这样 [strength × 1] 与 [strength] 逐位相同 ⇒ 无统计时与 V2 **恒等**。
     */
    streetFoldScale: 1,
    streetCallScale: 1,
    streetCheckRaiseScale: 1,
    streetBetScale: 1,
    effectiveDimensions: null,
    confidence: 0,
    noteZh,
  });
}

/**
 * 画像维度 → 响应倾向。
 *
 * 刻度（【启发式】结构性判断，只有方向与序关系有意义）：
 *
 * | 维度 | 影响 |
 * |---|---|
 * | `passivity` ↑ | 更爱跟（`callScale` ↑）、更少弃（`foldScale` ↓） |
 * | `tightness` ↑ | 更爱弃（`foldScale` ↑）、更少跟（`callScale` ↓） |
 * | `aggression` ↑ | 更爱加注（`raiseScale` ↑） |
 * | `bluffTendency` ↑ | 诈唬加注 ↑（`bluffRaiseScale` ↑） |
 *
 * 幅度按**可信度**缩放：`scale = 1 + (raw − 1) × confidence`
 * —— 与 `profileCompressionMultiplier` / exploit 偏移的缩放规则一致，
 * 可信度 0 时**恒为 1**（不做任何画像调整）。
 */
export function responseTendenciesOf(
  dimensions: PlayerDimensions | null,
  /** 画像可信度（手选画像 0.35 / 实测画像按样本；0 = 不调整） */
  confidence: number,
  /**
   * 🔴 **PLAYER PROFILE V3**：当前街与其分街系数。
   *
   * `null` / 未给 ⇒ 三个分街系数恒为 1 ⇒ 与 V2 **逐位一致**。
   * 给了 ⇒ 只有「属于这一街」的连续统计生效（例如河牌只看 `FoldToRiverBet`）。
   */
  streetInput?: { street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER'; factors: { foldScale: number; callScale: number; checkRaiseScale: number; betScale?: number } } | null,
): ResponseTendencies {
  const conf = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
  const streetFactors = streetInput?.factors ?? null;
  const street = streetInput?.street ?? null;
  if (dimensions === null || conf <= 0) {
    /*
     * ⚠️ 画像可信度为 0 时**仍然要应用分街系数** —— 两者是**独立**的证据来源：
     * 标签可信度 0 只表示「没有标签证据」，不代表「没有实测统计」。
     * 反过来也一样。因此这里不能用「conf<=0 ⇒ 全部中立」一刀切。
     */
    if (streetFactors === null) return neutralResponseTendencies();
    const noLabelDims = {
      tightness: 0.5,
      aggression: 0.5,
      bluffTendency: 0.5,
      passivity: 0.5,
    };
    return Object.freeze({
      ...neutralResponseTendencies('无标签证据：响应基线只用范围与尺寸；但**有 V3 分街统计**'),
      streetFoldScale: streetFactors.foldScale,
      streetCallScale: streetFactors.callScale,
      streetCheckRaiseScale: streetFactors.checkRaiseScale,
      streetBetScale: streetFactors.betScale ?? 1,
      effectiveDimensions: Object.freeze(noLabelDims),
      noteZh:
        `无标签证据（可信度 0）｜**V3 分街系数**（${street ?? '?'}）：` +
        `弃 ×${streetFactors.foldScale.toFixed(3)}、跟 ×${streetFactors.callScale.toFixed(3)}、` +
        `过牌加注 ×${streetFactors.checkRaiseScale.toFixed(3)}、下注 ×${(streetFactors.betScale ?? 1).toFixed(3)}`,
    });
  }

  const center = (v: number): number => Math.max(-1, Math.min(1, (v - 0.5) * 2));
  const passive = center(dimensions.passivity);
  const tight = center(dimensions.tightness);
  const aggro = center(dimensions.aggression);
  const bluff = center(dimensions.bluffTendency);

  const scaled = (raw: number): number => 1 + (raw - 1) * conf;

  /*
   * 🔴 **PLAYER PROFILE V3：分街系数**（连续统计驱动，只进自己那一街）。
   *
   * `street` 缺省为 `null` ⇒ 三个系数**恒为精确的 1** ⇒ 与 V2 逐位一致。
   */
  const sf = streetFactors;
  const streetFoldScale = sf === null || sf === undefined ? 1 : sf.foldScale;
  const streetCallScale = sf === null || sf === undefined ? 1 : sf.callScale;
  const streetCheckRaiseScale = sf === null || sf === undefined ? 1 : sf.checkRaiseScale;

  return Object.freeze({
    // 跟注站：passivity 0.8、tightness 0.3 ⇒ 更爱跟、更少弃
    callScale: scaled(1 + 0.30 * passive - 0.18 * tight),
    foldScale: scaled(1 + 0.32 * tight - 0.25 * passive),
    raiseScale: scaled(1 + 0.30 * aggro),
    bluffRaiseScale: scaled(1 + 0.35 * bluff),
    /*
     * 🔴 River CHECK 树：Hero 过牌之后他下注的倾向（§7）。
     * 疯/诈唬 ↑、被动/跟注站 ↓、不诈唬型 ↓ —— 只改概率，不造牌。
     */
    riverBetScale: scaled(1 + 0.3 * aggro + 0.25 * bluff - 0.3 * passive),
    streetFoldScale,
    streetCallScale,
    streetCheckRaiseScale,
    /*
     * 🔴 分街下注倾向：河牌用 `riverBetScale`（不变），翻牌/转牌用本字段。
     * 无统计 ⇒ `callScale = 1` ⇒ 本字段**精确为 1**（P0-2 的门在
     * `classifyVillainAfterCheck` 里按街选用）。
     */
    streetBetScale: streetBetScaleOf(streetFoldScale, conf, sf?.betScale ?? 1),
    effectiveDimensions: Object.freeze({
      tightness: dimensions.tightness,
      aggression: dimensions.aggression,
      bluffTendency: dimensions.bluffTendency,
      passivity: dimensions.passivity,
    }),
    confidence: conf,
    noteZh:
      `画像响应倾向（可信度 ${conf.toFixed(2)}）：跟注 ×${(1 + 0.30 * passive - 0.18 * tight).toFixed(3)}、` +
      `弃牌 ×${(1 + 0.32 * tight - 0.25 * passive).toFixed(3)}、加注 ×${(1 + 0.30 * aggro).toFixed(3)}、` +
      `诈唬加注 ×${(1 + 0.35 * bluff).toFixed(3)}、过牌后下注 ×${(1 + 0.3 * aggro + 0.25 * bluff - 0.3 * passive).toFixed(3)}` +
      '（按可信度缩放到最终值）' +
      (sf === null || sf === undefined
        ? '｜**无分街统计**（V3 分街系数 = 1.000，与 V2 一致）'
        : `｜**V3 分街系数**（${street ?? '?'}）：弃 ×${streetFoldScale.toFixed(3)}、` +
          `跟 ×${streetCallScale.toFixed(3)}、过牌加注 ×${streetCheckRaiseScale.toFixed(3)}、` +
          `下注 ×${streetBetScaleOf(streetFoldScale, conf, sf?.betScale ?? 1).toFixed(3)}`),
  });
}

/* ============================================================
 * Hero 自身听牌（**只做 realization / nut 潜力 / 半诈唬质量**）
 * ============================================================ */

export type HeroDrawPotential = {
  /** 真听牌（同花听 / 两头顺） */
  flushDraw: boolean;
  openEnded: boolean;
  gutshot: boolean;
  /** 该街的补牌数（`drawProfileOf` 给出；**不**再加到权益上） */
  outs: number;
  /** 还有几张公共牌要发（翻牌 2 / 转牌 1 / 河牌 0） */
  cardsToCome: number;
  /** 听牌质量 0..1（补牌数 / 15，截断）—— 【数学确定】的计数归一化 */
  drawQuality: number;
  /**
   * 坚果潜力 0..1：
   * 同花听且持有该花色**最高可用牌** ⇒ 1；否则按听牌类型给结构性刻度。
   * 【数学确定】的「持有哪张牌」判断 + 【启发式】刻度。
   */
  nutPotential: number;
  /** 本街到河牌的改进概率（仅用于展示与 realization，**不进权益**） */
  improvementProbability: number;
  noteZh: string;
};

/** 街 → 还有几张公共牌要发（河牌 0 张 ⇒ 不存在未来权益） */
export function cardsToComeOf(boardLength: number, street: Street): number {
  if (street === 'RIVER' || boardLength >= 5) return 0;
  if (street === 'TURN' || boardLength === 4) return 1;
  if (street === 'FLOP' || boardLength === 3) return 2;
  return 0;
}

/**
 * Hero 自身听牌潜力。
 *
 * 🔴 **它绝不产生权益**：`computeEquity` 已经把未来发牌算完，
 * 把补牌当成第二份权益就是重复计票（本轮明令禁止）。
 * 本函数的三个输出各有明确用途：
 * - `drawQuality`  → 权益实现因子（有真听牌的牌更容易实现权益）+ 半诈唬质量
 * - `nutPotential` → 半诈唬质量上限（坚果听比弱听更值得下注）
 * - `improvementProbability` → **仅供展示与 debug**（不参与任何加法）
 */
export function heroDrawPotentialOf(heroHole: readonly Card[], board: readonly Card[]): HeroDrawPotential {
  const street: Street = board.length <= 2 ? 'PREFLOP' : board.length === 3 ? 'FLOP' : board.length === 4 ? 'TURN' : 'RIVER';
  const cardsToCome = cardsToComeOf(board.length, street);
  if (heroHole.length !== 2 || board.length < 3) {
    return Object.freeze({
      flushDraw: false,
      openEnded: false,
      gutshot: false,
      outs: 0,
      cardsToCome,
      drawQuality: 0,
      nutPotential: 0,
      improvementProbability: 0,
      noteZh: '翻前或无牌面：没有听牌潜力',
    });
  }

  const profile = drawProfileOf(heroHole, board);
  const outs = Math.max(0, profile.outs);
  const drawQuality = Math.max(0, Math.min(1, outs / 15));

  /*
   * ---- 坚果潜力：同花听且持有该花色**最高可用牌** ⇒ 成牌即坚果 ----
   * 【数学确定】的是「我这张在该花色里还有没有更大的牌在外面」这个计数；
   * 【启发式】的是把计数映射到 0..1 的刻度。
   */
  let nutPotential = 0;
  if (profile.flushDraw) {
    const holeSuit = heroHole.find((h) => board.some((b) => b.suit === h.suit));
    if (holeSuit !== undefined) {
      const higherLeft = [...board, ...heroHole].filter(
        (c) => c.suit === holeSuit.suit && c.rank > holeSuit.rank,
      ).length;
      nutPotential = higherLeft === 0 ? 1 : Math.max(0.45, 1 - 0.25 * higherLeft);
    } else {
      nutPotential = 0.45;
    }
  } else if (profile.openEnded) {
    nutPotential = 0.7;
  } else if (profile.gutshot) {
    nutPotential = 0.45;
  } else {
    nutPotential = 0.15; // 只有高张/后门：几乎没有坚果潜力
  }

  // ---- 改进概率（**仅展示**）：按剩余张数精确计数 ----
  const unseen = 52 - 2 - board.length;
  const improvementProbability =
    cardsToCome <= 0
      ? 0
      : cardsToCome === 1
        ? Math.min(1, outs / Math.max(1, unseen))
        : 1 -
          (Math.max(0, unseen - outs) / Math.max(1, unseen)) *
            (Math.max(0, unseen - outs - 1) / Math.max(1, unseen - 1));

  return Object.freeze({
    flushDraw: profile.flushDraw,
    openEnded: profile.openEnded,
    gutshot: profile.gutshot,
    outs,
    cardsToCome,
    drawQuality,
    nutPotential,
    improvementProbability,
    noteZh:
      `补牌 ${outs} 张（${cardsToCome} 张待发）｜听牌质量 ${drawQuality.toFixed(2)}｜` +
      `坚果潜力 ${nutPotential.toFixed(2)}｜改进概率 ${(improvementProbability * 100).toFixed(1)}%` +
      '（**仅用于权益实现与半诈唬质量，已包含在权益中，不重复计入**）',
  });
}

/* ============================================================
 * 权益实现因子（代理模型，明确标注 HEURISTIC）
 * ============================================================ */

export type RealizationBreakdown = {
  factor: number;
  components: Readonly<Record<string, number>>;
  kind: 'HEURISTIC';
  noteZh: string;
};

/**
 * 权益实现因子（0..1）：把「跑完所有街的原始权益」折成**被跟注分支**上
 * 真正能拿到的份额。
 *
 * ## 为什么需要它，以及为什么它是代理
 *
 * 本项目**没有**未来街的博弈树。被跟注之后（翻牌/转牌）还有后续街的下注，
 * 而原始权益假设「一路摊牌」。因此用一个**有界、可解释**的因子近似：
 *
 * ```text
 * 基准（按街）：翻牌 0.78、转牌 0.84、河牌 1.00   ← 越靠后越接近直接摊牌
 * + 主动权（我在下注）        +0.04
 * + 位置（我在后位）          +0.03
 * − 深筹码（SPR > 4 起扣）    最多 −0.08
 * + 听牌实现（真听牌 + 坚果潜力）最多 +0.06
 * ```
 *
 * ⚠️ 加成合计最多 +0.13，因此翻牌上限 0.91、转牌上限 0.97 —— **不可能**靠
 * 加成把实现损失抹平成 1.0（第一版把基准定得过高，实测转牌直接饱和到 1.000，
 * 等于这条通道失效）。河牌恒为 **1.000**（没有未来街 ⇒ 不存在实现损失），
 * 有测试锁定。
 * ⚠️ 它是**代理模型**，UI 与 debug 必须标 `HEURISTIC`，不得称为 Solver EV。
 */
export function realizationFactorOf(input: {
  street: Street;
  hasInitiative: boolean;
  inPosition: boolean;
  spr: number | null;
  draw: HeroDrawPotential;
}): RealizationBreakdown {
  const base = input.street === 'RIVER' ? 1 : input.street === 'TURN' ? 0.84 : input.street === 'FLOP' ? 0.78 : 0.72;
  const initiative = input.hasInitiative ? 0.04 : 0;
  const position = input.inPosition ? 0.03 : 0;
  const sprPenalty = input.spr === null ? 0 : Math.max(0, Math.min(0.08, (input.spr - 4) * 0.02));
  const drawBonus =
    input.street === 'RIVER'
      ? 0
      : Math.max(0, Math.min(0.06, 0.04 * input.draw.drawQuality + 0.02 * input.draw.nutPotential));

  const raw = base + initiative + position - sprPenalty + drawBonus;
  const factor = Math.max(0, Math.min(1, input.street === 'RIVER' ? 1 : raw));

  return Object.freeze({
    factor,
    components: Object.freeze({
      base,
      initiative,
      position,
      sprPenalty: -sprPenalty,
      drawBonus,
    }),
    kind: 'HEURISTIC',
    noteZh:
      `权益实现因子 ${factor.toFixed(3)}（代理模型：基准 ${base.toFixed(2)}` +
      `${initiative > 0 ? ' + 主动权 0.04' : ''}${position > 0 ? ' + 位置 0.03' : ''}` +
      `${sprPenalty > 0 ? ` − 深筹码 ${sprPenalty.toFixed(2)}` : ''}` +
      `${drawBonus > 0 ? ` + 听牌实现 ${drawBonus.toFixed(2)}` : ''}）` +
      (input.street === 'RIVER' ? '；河牌无未来街 ⇒ 恒为 1' : ''),
  });
}

/* ============================================================
 * 对手响应分类（逐组合）
 * ============================================================ */

export const ResponseBucket = {
  FOLD: 'FOLD',
  CALL: 'CALL',
  RAISE: 'RAISE',
} as const;
export type ResponseBucket = (typeof ResponseBucket)[keyof typeof ResponseBucket];

export const RESPONSE_BUCKET_ZH: Readonly<Record<ResponseBucket, string>> = Object.freeze({
  FOLD: '弃牌',
  CALL: '跟注',
  RAISE: '加注',
});

export type ResponseInput = {
  /** 对手组合（牌面索引） */
  hole: readonly [Card, Card];
  /** 与 Hero 的精确强弱（`compareHands`，【数学确定】） */
  versusHero: 'STRONGER' | 'WEAKER' | 'EQUAL';
  /** 牌面相对档（0 最强 .. 5 最弱，【数学确定】结构式） */
  tier: number;
  street: Street;
  /** 本街剩余要发的牌数（街 ⇒ 压力） */
  cardsToCome: number;
  /** 建模用的下注比例（相对底池） */
  ratioToPot: number;
  /** 他面对的价格：跟注额 / (底池 + 2×跟注额) —— 【数学确定】 */
  priceRequiredEquity: number;
  spr: number | null;
  opponentCount: number;
  /** 牌面湿润度（0..1） */
  wetness: number;
  tendencies: ResponseTendencies;
  /**
   * 🔴 **Hero 是否已经全下**（§3）：真 ⇒ 他不能加注，
   * 原本会加注的权重迁移到跟注（弃 + 跟 = 1）。
   */
  heroIsAllIn: boolean;
  /**
   * 🔴 **P1-4：对手「跟注即全下」**（他的剩余筹码 ≤ 本次下注额）。
   *
   * 与 `heroIsAllIn` 是**两个独立判据**：
   * | 判据 | 含义 | 为什么他不能加注 |
   * |---|---|---|
   * | `heroIsAllIn` | 我把筹码投光 | 没人能再跟 ⇒ 加注无意义 |
   * | `villainIsAllInByCall` | 他跟这一注就投光 | 他跟注即 allIn，下注轮结束 ⇒ 引擎拒绝他的加注 |
   *
   * 生产路径由 `buildResponseModel` 用**实际剩余筹码**算出并传入（见 `villainRemaining`）。
   */
  villainIsAllInByCall: boolean;
  /**
   * 该组合**自己**的听牌等级（用于可玩性/隐含赔率与诈唬加注判定）。
   * 由调用方预计算（每个组合只算一次，三个尺寸共用）。
   */
  villainDraw: 'STRONG_DRAW' | 'WEAK_DRAW' | 'NO_DRAW';
};

export type ResponseClassification = {
  bucket: ResponseBucket;
  /**
   * 🔴 **混频权重**（§8，Phase 1 最小实现）：一个组合可以同时以不同概率
   * 落入多个桶，三者之和恒为 1。
   *
   * - 不继续 ⇒ `{fold:1, call:0, raise:0}`
   * - 继续但不够强加注 ⇒ `{fold:0, call:1, raise:0}`
   * - 强到会加注 ⇒ `{fold:0, call:1−r, raise:r}`
   * - **Hero 已全下 ⇒ `r = 0`**（他只能弃或跟；原本会加注的强牌**迁移到跟注**，
   *   而不是从条件范围里消失 —— 这正是 T2/T3 要锁的契约）
   *
   * `bucket` 仍是「主导桶」（权重最大的那个），供展示与旧字段兼容。
   */
  weights: { fold: number; call: number; raise: number };
  /**
   * 🔴 **封顶前**的权重（`heroIsAllIn` 的权重迁移之前）。
   *
   * 为什么必须单独带出来（使用者 §14/§23）：否则「P(加注) = 0」既可能是
   * 「他真的不会加注」，也可能是「Hero 全下把他压住了」—— 两者在
   * **尺寸弹性审计**里的含义完全不同，不能共用同一个 0。
   */
  rawWeights: { fold: number; call: number; raise: number };
  /** 继续指数（0..1；越大越愿意继续）—— 与「价格」直接比较的量 */
  continueIndex: number;
  /** 他面对的价格：本尺寸下需要的底池权益（门槛） */
  requiredEquity: number;
  requiredWithMargin: number;
  strengthScore: number;
  playability: number;
  sizePressure: number;
  streetPressure: number;
  reasonsZh: readonly string[];
};

/**
 * 单个组合面对某个尺寸的反应。
 *
 * ## 判据是「**价格 vs 牌力**」，不是人为分数门槛
 *
 * 面对 `b` 注入 `P` 的底池，他跟注需要的权益是
 * `r = b / (P + 2b)`（【数学确定】）。他的牌力用一个 0..1 的代理表示，
 * 再加上**可玩性**（真听牌 ⇒ 隐含赔率），然后与价格比较：
 *
 * ```text
 * 牌力代理 strength：
 *   比我强 ⇒ 0.70 + 0.28 × (1 − 档/5)      （越强越会继续）
 *   打平   ⇒ 0.58
 *   比我弱 ⇒ 0.12 + 0.46 × (1 − 档/5)      （纯空气最容易弃）
 * 可玩性 playability：同花听/两头顺 +0.10、卡顺 +0.05（他有补牌 ⇒ 更容易继续）
 * 继续指数 continueIndex = (strength + playability) × callScale − 0.05 × foldScale
 * 门槛     requiredWithMargin = r + margin
 *   margin = 0.16 − 0.06 × 街压力   （翻牌 0.16 / 转牌 0.14 / 河牌 0.10：
 *                                    越靠后越没有隐含赔率，余量越小）
 * 继续 ⇔ continueIndex ≥ requiredWithMargin
 * ```
 *
 * 于是「小注 ⇒ 弱牌也能跟」「大注 ⇒ 只有强牌跟」**自动**成立，
 * 而画像只通过 `callScale`（爱跟）/`foldScale`（爱弃）改变方向 ——
 * 不再有任何「分数 vs 常数门槛」的错配（第一版实测：中/大注把**所有**牌
 * 都判成弃牌，因为门槛与分数不同量纲）。
 *
 * 加注需要**独立条件**（不许「因为他弱所以他会加注」）：
 * - 价值加注：牌力明显高于继续门槛（`≥ r + margin + 0.20`）并按 `raiseScale` 放大；
 * - 诈唬/半诈唬加注：他有真听牌、画像偏诈唬（`bluffRaiseScale > 1.05`）且我的注不大。
 */
export function classifyResponse(input: ResponseInput): ResponseClassification {
  /*
   * 牌力代理**必须以牌面相对强度为主**：
   * 价格比较（`r = b/(P+2b)`）问的是「这手牌在**绝对意义**上够不够强」，
   * 而 `versusHero` 只给出「比我好还是差」的符号。
   *
   * 第一版只用 `versusHero` 分档（比我强 ⇒ 0.70~0.98），结果「比我好的牌」
   * 无论注多大都不弃牌 —— 实测中/大注的弃牌率与小注**完全相同**
   *（0.255/0.255/0.255），尺寸完全失效。而现实中「刚好比我好一点点」的牌
   *（例如 A-K 高张 vs 我的 A-J 高张）面对满池转牌下注是会弃的。
   */
  const boardStrength = 0.15 + 0.6 * (1 - input.tier / 5);
  const relativeAdj =
    input.versusHero === 'STRONGER' ? 0.15 : input.versusHero === 'EQUAL' ? 0.05 : -0.05;
  const strengthScore = Math.max(0, Math.min(1, boardStrength + relativeAdj));

  const playability = input.villainDraw === 'STRONG_DRAW' ? 0.1 : input.villainDraw === 'WEAK_DRAW' ? 0.05 : 0;
  const sizePressure = Math.max(0, Math.min(1, input.ratioToPot / 1));
  // 翻牌（2 张待发）压力最低、转牌（1 张）居中、河牌（0 张）最高
  const streetPressure = Math.max(0, Math.min(1, (2 - input.cardsToCome) / 2));

  const t = input.tendencies;
  const continueIndex = Math.max(
    0,
    Math.min(1, (strengthScore + playability) * t.callScale - 0.05 * t.foldScale),
  );
  const requiredEquity = Math.max(0, Math.min(1, input.priceRequiredEquity));
  const margin = 0.16 - 0.06 * streetPressure;
  const requiredWithMargin = requiredEquity + margin;

  const reasons: string[] = [];
  let weights: { fold: number; call: number; raise: number };
  let rawWeights: { fold: number; call: number; raise: number };
  /*
   * 🔴 **继续与否是连续的混频，不是硬切**（MULTIWAY RESPONSE TREE 阶段修复）。
   *
   * 修复前：`continueIndex < requiredWithMargin ⇒ 全弃，否则全跟`。
   * 而 `continueIndex` 的牌力部分只有 6 档（`boardStrength = 0.15 + 0.6×(1−tier/5)`），
   * 相邻两档之间相差约 0.12 —— 远大于画像带来的变化（`callScale` 差 25%
   * 只挪动约 0.05）。于是出现两个**实测**后果：
   *
   * 1. **画像在翻后响应层完全失效**：跟注站与普通玩家拿到**逐位相同**的
   *    弃/跟/加概率（T2 实测 0.34743787553756983 vs 0.34743787553756983）；
   * 2. **尺寸饱和**：67% 与 100% 池的门槛都落在同一档的同一侧 ⇒ 响应逐位相同。
   *
   * 修复：在门槛附近按**线性混频**分流，窗口宽度 = 余量本身（`margin`，
   * 既有量，**不是新参数**）：
   *
   * ```text
   * 继续比例 = clamp01( (continueIndex − 门槛) / (2×margin) + 0.5 )
   * ```
   *
   * 恰好落在门槛上 ⇒ 一半继续（标准混频语义）；离门槛越远越确定。
   * 方向与旧实现完全一致（越强/越便宜 ⇒ 越可能继续），只是不再把
   * 「差一点点」和「差很多」压成同一个 0/1。
   */
  const excess = continueIndex - requiredWithMargin;
  const continueFraction = Math.max(0, Math.min(1, excess / (2 * margin) + 0.5));
  if (continueFraction <= 0) {
    weights = { fold: 1, call: 0, raise: 0 };
    rawWeights = { fold: 1, call: 0, raise: 0 };
    reasons.push(
      `继续指数 ${continueIndex.toFixed(3)} 低于价格门槛 ${requiredWithMargin.toFixed(3)} 超过一个余量` +
        `（价格 ${requiredEquity.toFixed(3)} + 余量 ${margin.toFixed(2)}）⇒ 弃牌`,
    );
  } else {
    /*
     * 价值加注需要**真正强的牌**（牌面相对档 ≤1，或档 2 且有真听牌），
     * 而不是「比我好」——后者在本节点占他范围的 2/3，
     * 若按「比我好就加注」会得出「他会用 75% 的范围反击」这种荒谬结果
     *（第一版实测：P(raise) = 0.745）。
     */
    const genuinelyStrong = input.tier <= 1 || (input.tier === 2 && playability > 0);
    const excess = strengthScore + playability - requiredWithMargin;
    const valueRaise = genuinelyStrong && excess >= 0.2;
    const bluffRaise =
      input.villainDraw !== 'NO_DRAW' &&
      t.bluffRaiseScale > 1.05 &&
      requiredEquity < 0.25 &&
      input.wetness > 0.35;

    /*
     * 🔴 **Hero 全下 ⇒ 他不能加注**（§3）：raise 权重强制为 0，
     * 原本会加注的权重**迁移到跟注**（`call = 1 − fold`），
     * 因此 `P(弃) + P(跟) = 1` 且强牌不会从条件范围里消失。
     * 这不是「UI 显示 0」—— 它改变了条件范围的构造（有测试锁）。
     *
     * 🔴 **P1-4：他跟这一注就投光时同样不能加注**（判据是**他的**筹码）：
     * 他跟注即 allIn、下注轮结束，引擎会拒绝他的任何加注
     *（与 U1 加注响应链同一条规则，`villainIsAllInByCall` 与 `heroIsAllIn` **不得合并**）。
     */
    const rawRaiseShare = valueRaise
      ? Math.max(0, Math.min(1, 0.45 + 0.35 * excess + 0.25 * (t.raiseScale - 1) - 0.2 * sizePressure))
      : bluffRaise
        ? Math.max(0, Math.min(1, 0.25 + 0.5 * (t.bluffRaiseScale - 1) - 0.3 * sizePressure))
        : 0;
    const cannotRaise = input.heroIsAllIn || input.villainIsAllInByCall;
    const raiseShare = cannotRaise ? 0 : rawRaiseShare;

    // 混频：继续的那一部分里再按 `raiseShare` 分成跟注与加注
    weights = {
      fold: 1 - continueFraction,
      call: continueFraction * (1 - raiseShare),
      raise: continueFraction * raiseShare,
    };
    // 封顶前：把「他本来会加注、但 Hero 已全下 ⇒ 迁移到跟注」如实分开记录
    rawWeights = {
      fold: 1 - continueFraction,
      call: continueFraction * (1 - rawRaiseShare),
      raise: continueFraction * rawRaiseShare,
    };
    if (raiseShare > 0) {
      reasons.push(
        `${valueRaise ? '强成手加注' : '诈唬加注'}：加注权重 ${raiseShare.toFixed(3)}、跟注权重 ${(1 - raiseShare).toFixed(3)}` +
          `（同一组合混频，不是全有全无）`,
      );
    } else if (input.heroIsAllIn && rawRaiseShare > 0) {
      reasons.push(
        `Hero 已全下 ⇒ 不能加注：原本 ${rawRaiseShare.toFixed(3)} 的加注权重**迁移到跟注**（弃+跟 = 1）`,
      );
    } else if (input.villainIsAllInByCall && rawRaiseShare > 0) {
      reasons.push(
        `他跟这一注就**全下**（剩余筹码 ≤ 下注额）⇒ 他不能再加注：` +
          `原本 ${rawRaiseShare.toFixed(3)} 的加注权重**迁移到跟注**（弃+跟 = 1）`,
      );
    } else {
      reasons.push(`继续指数 ${continueIndex.toFixed(3)} ≥ 价格门槛 ${requiredWithMargin.toFixed(3)} ⇒ 跟注`);
    }
  }

  /*
   * ============================================================
   * 🔴 **PLAYER PROFILE V3：分街系数**（连续统计驱动）
   * ============================================================
   *
   * ## 为什么放在这里（而不是在 `continueIndex` 里）
   *
   * `continueIndex` 是「牌力 + 可玩性」的连续量，`foldScale/callScale` 只以
   * `−0.05×foldScale` 这种**很小**的方式影响它。而连续统计要表达的是
   * 「**这个人在这一街面对下注到底多容易弃**」——它是对**最终分流**的直接修正，
   * 不是对牌力判断的修正。放在这里语义正确、且**可加性清晰**。
   *
   * ## 三条性质（有测试锁）
   *
   * 1. **恒等**：两个系数都是精确的 1 ⇒ 三个权重**逐位不变**（V2 兼容）。
   * 2. **守恒**：修正后 `fold + call + raise === 1`（先缩放、再重归一化）。
   * 3. **有界**：系数来自 `streetFactorOf`（1 ± 0.35），且重归一化后仍 ∈ [0,1]。
   *
   * ## 加注权重也要跟着动
   *
   * 若只缩放 fold/call 而不动 raise，跟注站的「更爱跟」会被算成「更爱加注」——
   * 那是**维度混淆**。因此三路一起缩放：
   * 弃 × `streetFoldScale`、跟 × `streetCallScale`、加注 × `streetCheckRaiseScale`。
   */
  const sf = t.streetFoldScale ?? 1;
  const sc = t.streetCallScale ?? 1;
  const sr = t.streetCheckRaiseScale ?? 1;
  if (sf !== 1 || sc !== 1 || sr !== 1) {
    const raw = { fold: weights.fold * sf, call: weights.call * sc, raise: weights.raise * sr };
    const sum = raw.fold + raw.call + raw.raise;
    if (sum > 0 && Number.isFinite(sum)) {
      weights = { fold: raw.fold / sum, call: raw.call / sum, raise: raw.raise / sum };
      reasons.push(
        `**V3 分街系数**（有实测统计）：弃 ×${sf.toFixed(3)}、跟 ×${sc.toFixed(3)}、过牌加注 ×${sr.toFixed(3)}` +
          ` ⇒ 重归一化前 ${raw.fold.toFixed(4)}/${raw.call.toFixed(4)}/${raw.raise.toFixed(4)}` +
          ` ⇒ 弃 ${weights.fold.toFixed(4)}、跟 ${weights.call.toFixed(4)}、加注 ${weights.raise.toFixed(4)}（合计 1）`,
      );
    } else {
      /*
       * 极端数据防护（§十三）：缩放后总和为 0 / 非有限时**不回退到 NaN**，
       * 而是保持缩放前的合法权重（它本来就满足合计 1）。
       */
      reasons.push('⚠️ V3 分街系数缩放后总和非正 ⇒ 保持缩放前的合法权重（不产生 NaN）');
    }
  }

  const bucket =
    weights.raise >= weights.call && weights.raise > 0
      ? ResponseBucket.RAISE
      : weights.fold >= weights.call
        ? ResponseBucket.FOLD
        : ResponseBucket.CALL;

  return Object.freeze({
    bucket,
    weights: Object.freeze(weights),
    rawWeights: Object.freeze(rawWeights),
    continueIndex,
    requiredEquity,
    requiredWithMargin,
    strengthScore,
    playability,
    sizePressure,
    streetPressure,
    reasonsZh: Object.freeze(reasons),
  });
}

/* ============================================================
 * 响应模型（每个尺寸）
 * ============================================================ */

export type ResponseBucketRange = {
  bucket: ResponseBucket;
  /** 组合 + **重新归一化后的权重**（组合集不变，只有权重变） */
  entries: readonly { cardIndices: readonly [number, number]; probability: number }[];
  /** 该桶的概率质量（Σ 原始权重，未归一） */
  mass: number;
  /** 组合数（供 §十三.15 card removal / 组合集不变的断言） */
  comboCount: number;
};

export type SizeResponse = {
  kind: BetSizeClass | 'ALL_IN';
  /** **合法**金额对应的底池比例（所有计算都用它） */
  ratioToPot: number;
  labelZh: string;
  /** 合法下注额（= `legalAmount`） */
  betAmount: number;
  /** 理论目标金额（只供 debug，绝不参与 EV） */
  requestedAmount: number;
  /** 是否因有效筹码/最大下注被封顶 */
  wasCapped: boolean;
  /** 该合法金额来自哪个理论类别 */
  requestedKind: BetSizeClass;
  /** Hero 下这个金额是否等于全下（真 ⇒ 他不能加注） */
  heroIsAllIn: boolean;
  foldLikelihood: number;
  callLikelihood: number;
  raiseLikelihood: number;
  /**
   * **封顶前**的三个概率（`heroIsAllIn` 的权重迁移之前）。与最终值的差异
   * 就是「Hero 全下把他压住了」这一条 —— 尺寸弹性审计必须能分开这两件事（§14）。
   */
  rawFoldLikelihood: number;
  rawCallLikelihood: number;
  rawRaiseLikelihood: number;
  /**
   * 🔴 **P1-4**：他跟这一注就**全下**（`betAmount ≥ 他的剩余筹码`）。
   *
   * 真 ⇒ 他跟注即 allIn、下注轮结束 ⇒ 该尺寸下**不可能**有加注分支
   *（`raiseLikelihood` 必为 0，原本会加注的权重迁移到跟注）。
   * 与 `heroIsAllIn` 是**两个独立判据**，不得合并。
   */
  villainIsAllInByCall: boolean;
  /** 三桶质量（Σp，已含混频权重；三者之和 = 1） */
  buckets: readonly ResponseBucketRange[];
  /** 分类逐组合的证据等级 */
  classificationKind: 'HEURISTIC';
  noteZh: string;
};

export type ResponseModel = {
  sizes: readonly SizeResponse[];
  /** 参与分类的可达组合数（分母） */
  comboCount: number;
  /** 总质量（Σp，应 ≈ 1） */
  totalMass: number;
  tendencies: ResponseTendencies;
  noteZh: string;
};

/**
 * 为每个下注尺寸构建响应模型（fold / call / raise 概率 + 条件范围）。
 *
 * @param input.entries 对手**可达范围**（已做死牌过滤；权重为后验概率）
 * @param input.heroHole Hero 底牌
 * @param input.board 当前公共牌（≥3 张）
 * @param input.pot 下注**前**的底池（筹码）
 * @param input.sizes 尺寸规格（缺省用 `BET_SIZE_SPECS`）
 * @returns 拿不到牌面 / 没有组合时返回 `null`（不编造概率）
 */
export function buildResponseModel(input: {
  entries: readonly { cardIndices: readonly [number, number]; probability: number }[];
  heroHole: readonly Card[];
  board: readonly Card[];
  pot: number;
  street: Street;
  spr: number | null;
  opponentCount: number;
  wetness: number;
  tendencies: ResponseTendencies;
  /** **已合法化**的尺寸（`legalizeBetSizes` 的产物）—— 必须是合法金额 */
  sizes: readonly LegalBetSize[];
  /** Hero 剩余筹码（用于判定全下：`betAmount ≥ heroRemaining ⇒ 不能加注`） */
  heroRemaining?: number;
  /**
   * 🔴 **P1-4：对手剩余筹码**（用于判定「他跟这一注就全下 ⇒ 他不能再加注」）。
   * 与 `heroRemaining` 分开传入，**不得**用同一个字段代替。
   */
  villainRemaining?: number;
}): ResponseModel | null {
  if (input.board.length < 3 || input.heroHole.length !== 2) return null;

  let heroEval: EvaluatedHand;
  try {
    heroEval = evaluateCards([...input.heroHole, ...input.board]);
  } catch {
    return null;
  }

  const heroKeys = new Set(input.heroHole.map((c) => `${c.rank}${c.suit}`));
  const boardKeys = new Set(input.board.map((c) => `${c.rank}${c.suit}`));
  const cardsToCome = cardsToComeOf(input.board.length, input.street);
  const sizes = input.sizes ?? BET_SIZE_SPECS;

  // ---- 逐组合预计算（只算一次，三个尺寸共用）----
  type Prepared = {
    cardIndices: readonly [number, number];
    probability: number;
    versusHero: 'STRONGER' | 'WEAKER' | 'EQUAL';
    tier: number;
    villainDraw: 'STRONG_DRAW' | 'WEAK_DRAW' | 'NO_DRAW';
  };
  const prepared: Prepared[] = [];
  for (const entry of input.entries) {
    if (!(entry.probability > 0)) continue;
    const hole: [Card, Card] = [ALL_CARDS[entry.cardIndices[0]]!, ALL_CARDS[entry.cardIndices[1]]!];
    // 与 Hero / 公共牌重叠的组合不可能在他的可达范围里（防御性跳过，且不计入任何桶）
    if (hole.some((c) => heroKeys.has(`${c.rank}${c.suit}`) || boardKeys.has(`${c.rank}${c.suit}`))) continue;
    let versusHero: 'STRONGER' | 'WEAKER' | 'EQUAL';
    try {
      const cmp = compareHands(evaluateCards([...hole, ...input.board]), heroEval);
      versusHero = cmp > 0 ? 'STRONGER' : cmp < 0 ? 'WEAKER' : 'EQUAL';
    } catch {
      continue;
    }
    const draw = drawProfileOf(hole, input.board);
    prepared.push({
      cardIndices: entry.cardIndices,
      probability: entry.probability,
      versusHero,
      tier: boardRelativeTierOf(hole, input.board) ?? 5,
      villainDraw:
        draw.flushDraw || draw.openEnded ? 'STRONG_DRAW' : draw.gutshot ? 'WEAK_DRAW' : 'NO_DRAW',
    });
  }
  if (prepared.length === 0) return null;

  const totalMass = prepared.reduce((sum, p) => sum + p.probability, 0);
  if (!(totalMass > 0)) return null;

  const result: SizeResponse[] = [];
  for (const spec of sizes) {
    const foldEntries: { cardIndices: readonly [number, number]; probability: number }[] = [];
    const callEntries: { cardIndices: readonly [number, number]; probability: number }[] = [];
    const raiseEntries: { cardIndices: readonly [number, number]; probability: number }[] = [];
    let foldMass = 0;
    let callMass = 0;
    let raiseMass = 0;

    /*
     * 🔴 **一律用合法金额**（§1）：`spec.legalAmount` 已经按有效筹码封顶，
     * 因此价格 `r = b/(P+2b)` 与尺寸压力都由**真正会发生的那个注额**决定。
     * 理论金额只保留在 `requestedAmount` 里供 debug，绝不参与计算。
     */
    const betAmount = Math.max(0, spec.legalAmount);
    const ratioToPot = input.pot > 0 ? betAmount / input.pot : 0;
    const heroIsAllIn = input.heroRemaining !== undefined && betAmount >= input.heroRemaining - 1e-9;
    /*
     * 🔴 **P1-4：他跟这一注就投光**（`betAmount ≥ 他的剩余筹码`）⇒ 他不能再加注。
     * 判据只用**实际筹码**（`villainRemaining` 由调用方从合法动作推导处传入），
     * 与 `heroIsAllIn` 分开计算，**不合并**。
     */
    const villainIsAllInByCall =
      input.villainRemaining !== undefined &&
      input.villainRemaining > 0 &&
      betAmount >= input.villainRemaining - 1e-9;
    const priceRequiredEquity =
      input.pot + 2 * betAmount > 0 ? betAmount / (input.pot + 2 * betAmount) : 0;

    /** 封顶前（`heroIsAllIn` 迁移之前）的三桶质量 —— 尺寸弹性审计用（§14） */
    let rawFoldMass = 0;
    let rawCallMass = 0;
    let rawRaiseMass = 0;

    for (const combo of prepared) {
      const classification = classifyResponse({
        hole: [ALL_CARDS[combo.cardIndices[0]]!, ALL_CARDS[combo.cardIndices[1]]!],
        versusHero: combo.versusHero,
        tier: combo.tier,
        street: input.street,
        cardsToCome,
        ratioToPot,
        priceRequiredEquity,
        spr: input.spr,
        opponentCount: input.opponentCount,
        wetness: input.wetness,
        tendencies: input.tendencies,
        villainDraw: combo.villainDraw,
        heroIsAllIn,
        villainIsAllInByCall,
      });
      /*
       * **混频**（§8）：同一个组合按权重同时进入多个桶。
       * 桶内权重 = `combo.probability × w_bucket`，再按桶归一化 ——
       * 于是「组合集不变、只有权重变」这条不变量在混频下依然成立，
       * 且 Σ(桶质量) = 总质量（mass 守恒，Murphy §14.5/§14.6）。
       */
      const w = classification.weights;
      const rw = classification.rawWeights;
      rawFoldMass += combo.probability * rw.fold;
      rawCallMass += combo.probability * rw.call;
      rawRaiseMass += combo.probability * rw.raise;
      if (w.fold > 0) {
        foldEntries.push({ cardIndices: combo.cardIndices, probability: combo.probability * w.fold });
        foldMass += combo.probability * w.fold;
      }
      if (w.call > 0) {
        callEntries.push({ cardIndices: combo.cardIndices, probability: combo.probability * w.call });
        callMass += combo.probability * w.call;
      }
      if (w.raise > 0) {
        raiseEntries.push({ cardIndices: combo.cardIndices, probability: combo.probability * w.raise });
        raiseMass += combo.probability * w.raise;
      }
    }

    const normalize = (entries: typeof foldEntries, mass: number): ResponseBucketRange['entries'] =>
      mass <= 0
        ? Object.freeze([])
        : Object.freeze(entries.map((e) => Object.freeze({ ...e, probability: e.probability / mass })));

    result.push(
      Object.freeze({
        kind: spec.kind,
        ratioToPot,
        labelZh: spec.labelZh,
        betAmount,
        requestedAmount: spec.requestedAmount,
        wasCapped: spec.wasCapped,
        requestedKind: spec.requestedKind,
        heroIsAllIn,
        /** 🔴 P1-4：他跟这一注就投光 ⇒ 该尺寸下不可能有加注分支 */
        villainIsAllInByCall,
        foldLikelihood: foldMass / totalMass,
        callLikelihood: callMass / totalMass,
        raiseLikelihood: raiseMass / totalMass,
        rawFoldLikelihood: rawFoldMass / totalMass,
        rawCallLikelihood: rawCallMass / totalMass,
        rawRaiseLikelihood: rawRaiseMass / totalMass,
        buckets: Object.freeze([
          Object.freeze({
            bucket: ResponseBucket.FOLD,
            entries: normalize(foldEntries, foldMass),
            mass: foldMass / totalMass,
            comboCount: foldEntries.length,
          }),
          Object.freeze({
            bucket: ResponseBucket.CALL,
            entries: normalize(callEntries, callMass),
            mass: callMass / totalMass,
            comboCount: callEntries.length,
          }),
          Object.freeze({
            bucket: ResponseBucket.RAISE,
            entries: normalize(raiseEntries, raiseMass),
            mass: raiseMass / totalMass,
            comboCount: raiseEntries.length,
          }),
        ]),
        classificationKind: 'HEURISTIC' as const,
        noteZh:
          `面对 ${spec.labelZh}（合法 ${betAmount.toFixed(1)} 筹码 = ${(ratioToPot * 100).toFixed(0)}% 池` +
          `${spec.wasCapped ? `；理论 ${spec.requestedAmount.toFixed(1)} 已按有效筹码封顶` : ''}` +
          `${heroIsAllIn ? '；**Hero 全下 ⇒ 他不能加注**' : ''}）：` +
          `弃 ${((foldMass / totalMass) * 100).toFixed(1)}% / 跟 ${((callMass / totalMass) * 100).toFixed(1)}% / ` +
          `加 ${((raiseMass / totalMass) * 100).toFixed(1)}%（他需要的底池权益 ${(priceRequiredEquity * 100).toFixed(1)}%）`,
      }),
    );
  }

  return Object.freeze({
    sizes: Object.freeze(result),
    comboCount: prepared.length,
    totalMass,
    tendencies: input.tendencies,
    noteZh:
      `响应模型：${prepared.length} 个可达组合逐组合分类（精确强弱比较 + 档位 + 价格 + 尺寸 + 街 + 画像响应倾向）；` +
      '⚠️ 分类刻度是**启发式结构式**，不是求解器频率',
  });
}

/* ============================================================
 * 🔴 河牌 CHECK 树（§5 / §6）：Hero 过牌**不等于**立即摊牌
 * ============================================================ */

export const CheckTreeKind = {
  /** 河牌 + 我在**后位**（对手已经过牌）⇒ 我过牌即摊牌，动作终止 */
  SHOWDOWN_TERMINAL: 'SHOWDOWN_TERMINAL',
  /** 河牌 + 我在**前位** ⇒ 我过牌后对手仍可下注（最小 CHECK 树） */
  HEURISTIC_TREE: 'HEURISTIC_TREE',
  /** 翻牌/转牌 ⇒ 还有未来街，用权益实现代理（与 Phase 1 同口径） */
  HEURISTIC_ONE_STREET: 'HEURISTIC_ONE_STREET',
} as const;
export type CheckTreeKind = (typeof CheckTreeKind)[keyof typeof CheckTreeKind];

export type VillainAfterCheckClassification = {
  weights: { checkBack: number; bet: number };
  /** 是否价值下注（牌面相对档 ≤2 且比我强） */
  valueBet: boolean;
  /** 是否诈唬下注（弱尾 + 画像偏诈唬） */
  bluffBet: boolean;
  /**
   * 🔴 **TEST 09**：该组合**有没有摊牌价值**（牌面相对档 ≥4 = 弱尾）。
   *
   * `bluffBet` 是「弱尾 **且** 画像偏诈唬」的**结论**；本字段是**前提**。
   * 分开暴露是必要的：下游（`bettingRange.ts`）需要在
   * 「用一个显式的范围构成假设」构造下注范围时，知道**哪些组合可以当诈唬**，
   * 而不能依赖「原模型是否已经决定诈唬」—— 那会让注入点失效
   *（实测：NORMAL 的 `riverBetScale = 1.0` ⇒ `bluffBet` 恒 false ⇒
   *  注入 50% 诈唬也一个组合都进不来，下注范围 100% 价值）。
   */
  weakTail: boolean;
  noteZh: string;
};

/**
 * **Hero 过牌之后他的反应**（河牌最小树：`CHECK_BACK` | `BET`）。
 *
 * ```text
 * 价值下注：牌面相对档 ≤2（强成手）⇒ betShare 高（随 raiseScale / riverBetScale 缩放）
 * 诈唬下注：档 ≥4 且无摊牌价值、牌面允许 ⇒ betShare 由画像的诈唬倾向决定
 * 其余      ：CHECK_BACK（摊牌）
 * ```
 *
 * ⚠️ 画像只改**概率**（`riverBetScale`：跟注站/被动 ↓、疯子/过度诈唬 ↑、
 * 不诈唬型/极紧的大注诈唬 ↓），**不制造任何不存在的组合**
 *（权重只会把一个组合在 CHECK_BACK 与 BET 之间分流）。
 */
export function classifyVillainAfterCheck(input: {
  tier: number;
  versusHero: 'STRONGER' | 'WEAKER' | 'EQUAL';
  tendencies: ResponseTendencies;
  /** 他面对我的下注时需要多少权益（此处用「他下注」的价格：忽略，价值/诈唬判定用它做保守修正） */
  pot: number;
  /** 他下注的代表尺寸（合法后） */
  betSize: number;
  street: Street;
}): VillainAfterCheckClassification {
  const t = input.tendencies;
  const strongMade = input.tier <= 2;
  const weakTail = input.tier >= 4;

  /*
   * 🔴 **TEST 08 P0-2：本函数不再只服务河牌**。
   *
   * 原实现把「Hero 过牌后他开枪」只放在河牌，因此 `bluffBet` 的条件里
   * 硬写了「② 河牌（无未来街，不存在半诈唬）」。翻牌/转牌上他同样可以开枪 ——
   * 只是那属于**半诈唬**（还有未来街可以改进）。
   *
   * 分街下注倾向的来源按街分开：
   * - 河牌 ⇒ `riverBetScale`（**逐位不变**，T4/T6 锁的就是它）
   * - 翻牌/转牌 ⇒ `streetBetScale`（V3 分街统计驱动，无统计时精确为 1）
   */
  const onRiver = input.street === 'RIVER';
  const betScale = onRiver ? t.riverBetScale : (t.streetBetScale ?? 1);

  const valueBet = strongMade && (input.versusHero === 'STRONGER' || input.tier <= 1);
  /*
   * 诈唬/半诈唬需要**独立条件**（不能因为「他弱」就假定他一定下注）：
   * ① 弱尾（档 ≥4，没有摊牌价值）；② 分街下注倾向高于基线（`betScale > 1`）。
   *
   * ⚠️ 河牌上「无未来街 ⇒ 不存在半诈唬」仍然成立，但它**不是**判据的一部分：
   * 河牌用 `riverBetScale`、翻牌/转牌用 `streetBetScale`，两者都是
   * 「这一街他愿不愿意开枪」的直接度量。因此不需要再写街的硬条件。
   */
  const bluffBet = weakTail && betScale > 1;

  if (valueBet) {
    /*
     * 强成手的开枪份额：河牌保持原式（逐位不变）；翻牌/转牌把
     * `riverBetScale` 换成 `streetBetScale`。
     */
    const share = Math.max(
      0,
      Math.min(0.85, 0.55 + 0.25 * (t.raiseScale - 1) + 0.15 * (betScale - 1)),
    );
    return {
      weights: { checkBack: 1 - share, bet: share },
      valueBet: true,
      bluffBet: false,
      weakTail,
      noteZh: `强成手（档 ${input.tier}）⇒ 下注权重 ${share.toFixed(3)}（其余慢打/check-back）`,
    };
  }
  if (bluffBet) {
    const share = Math.max(0, Math.min(0.5, 0.22 * (betScale - 1) * 4));
    return {
      weights: { checkBack: 1 - share, bet: share },
      valueBet: false,
      bluffBet: true,
      weakTail,
      noteZh:
        `弱尾（档 ${input.tier}）+ ${onRiver ? '河牌' : input.street}下注倾向 ` +
        `×${betScale.toFixed(2)} ⇒ ${onRiver ? '诈唬' : '半诈唬'}下注权重 ${share.toFixed(3)}`,
    };
  }
  return {
    weights: { checkBack: 1, bet: 0 },
    valueBet: false,
    bluffBet: false,
    weakTail,
    noteZh: `档 ${input.tier} 且无${onRiver ? '诈唬' : '半诈唬'}条件 ⇒ 全部过牌摊牌`,
  };
}

export type CheckTreeResult = {
  checkEV: number | null;
  kind: CheckTreeKind;
  isInPosition: boolean;
  /** 他过牌（摊牌）的概率与 Hero 对其过牌范围的权益 */
  checkBackLikelihood: number;
  heroEquityVsCheckBackRange: number | null;
  evShowdown: number | null;
  /** 他下注的概率、代表尺寸、Hero 对其下注范围的权益 */
  betLikelihood: number;
  villainBetAmount: number;
  heroEquityVsBetRange: number | null;
  /** Hero 的最佳应手（河牌：CALL vs FOLD；RAISE 未实现） */
  heroCallEV: number | null;
  heroFoldEV: number;
  heroBestResponseEV: number | null;
  /** 未实现的分支必须显式标注 */
  raiseResponse: 'NOT_IMPLEMENTED';
  components: Readonly<Record<string, number>>;
  noteZh: string;
};

/**
 * 河牌 CHECK 的 EV（§6 最小公式）。
 *
 * ```text
 * 后位（对手已过牌）：CheckEV = HeroEquityVsArrivalRange × Pot          ← 摊牌，动作终止
 * 前位（我 OOP 先过牌）：
 *   CheckEV = P(checkBack) × [EqVsCheckBackRange × Pot]
 *           + P(bet)      × HeroBestResponseEV
 *   HeroBestResponseEV = max(FoldEV = 0, CallEV = EqVsBetRange × (Pot + 2b) − b)
 *   （加注应手 = NOT_IMPLEMENTED，不伪造）
 * ```
 *
 * 🔴 **零点是「当前决策点」**：弃牌 = 0，已投入筹码全部是沉没成本（§12）。
 * 因此 `CheckEV` 与 `BetEV` 可以直接 argmax 比较。
 */
export function composeCheckEVTree(input: {
  pot: number;
  street: Street;
  isInPosition: boolean;
  heroEquityVsArrivalRange: number | null;
  /** 翻牌/转牌的权益实现代理（河牌不用） */
  realizationFactor: number;
  /** 河牌前位必需：他过牌/下注的分流与条件范围权益 */
  afterCheck?: {
    checkBackLikelihood: number;
    betLikelihood: number;
    heroEquityVsCheckBackRange: number | null;
    heroEquityVsBetRange: number | null;
    villainBetAmount: number;
    /**
     * 🔴 **TEST 08 P0-2 诊断**：与范围宽度无关的「平均一手牌的开枪意愿」。
     *
     * `betLikelihood` 是**份额**（会被宽范围稀释），因此不能用它比较
     * 「MANIAC 是否比 NIT 更爱开枪」。本字段是逐组合下注权重的范围均值，
     * 只用于审计与可读对比，**不参与 EV**。
     */
    fireWeight?: number | null;
  } | null;
}): CheckTreeResult {
  const pot = Math.max(0, input.pot);
  const base = {
    isInPosition: input.isInPosition,
    raiseResponse: 'NOT_IMPLEMENTED' as const,
  };

  /*
   * 🔴 **TEST 08 P0-2：OOP CHECK 树不再限定河牌**。
   *
   * 修复前这里只认 `RIVER`：转牌（乃至翻牌）的 OOP 过牌一律走
   * `HEURISTIC_ONE_STREET`，`betLikelihood` 被硬编码为 0 ——
   * 等于宣称「我过牌之后他一定过牌」，对 MANIAC / NIT 给出**完全相同**的结果。
   *
   * 但「我 OOP 过牌 ⇒ 他仍可下注」这件事与街无关，是**行动顺序**问题。
   * `afterCheck` 分流数据在翻牌/转牌同样算得出来（`classifyVillainAfterCheck`
   * 本来就收 `street`），所以门应当只由 `isInPosition` 决定。
   *
   * ⚠️ 我这里**保持 `isInPosition` 的摊牌终止分支在下面优先**：后位（他刚过牌）
   * 时我过牌即摊牌，动作终止，与街无关。
   */
  const afterCheck = input.afterCheck ?? null;

  if (input.street !== 'RIVER' && (input.isInPosition || afterCheck === null)) {
    const realized =
      input.heroEquityVsArrivalRange === null
        ? null
        : Math.max(0, Math.min(1, input.heroEquityVsArrivalRange * input.realizationFactor));
    const ev = realized === null ? null : realized * pot;
    return Object.freeze({
      ...base,
      checkEV: ev,
      kind: CheckTreeKind.HEURISTIC_ONE_STREET,
      checkBackLikelihood: 1,
      heroEquityVsCheckBackRange: input.heroEquityVsArrivalRange,
      evShowdown: ev,
      betLikelihood: 0,
      villainBetAmount: 0,
      heroEquityVsBetRange: null,
      heroCallEV: null,
      heroFoldEV: 0,
      heroBestResponseEV: null,
      components: Object.freeze({ realizedEquity: realized ?? 0, pot }),
      noteZh:
        `翻牌/转牌：${input.isInPosition ? '我在后位（对手已过牌）⇒ 过牌后**动作终止**' : '拿不到「他过牌/下注」的分流数据'} ⇒ ` +
        `用权益实现代理（${input.realizationFactor.toFixed(3)}）；` +
        '这不是摊牌 EV（HEURISTIC_ONE_STREET）',
    });
  }

  if (input.isInPosition && input.street === 'RIVER') {
    const eq = input.heroEquityVsArrivalRange;
    const ev = eq === null ? null : eq * pot;
    return Object.freeze({
      ...base,
      checkEV: ev,
      kind: CheckTreeKind.SHOWDOWN_TERMINAL,
      checkBackLikelihood: 1,
      heroEquityVsCheckBackRange: eq,
      evShowdown: ev,
      betLikelihood: 0,
      villainBetAmount: 0,
      heroEquityVsBetRange: null,
      heroCallEV: null,
      heroFoldEV: 0,
      heroBestResponseEV: null,
      components: Object.freeze({ equityVsCheckedRange: eq ?? 0, pot }),
      noteZh: '河牌 + 我在后位（对手已过牌）⇒ 我过牌即摊牌，动作终止（SHOWDOWN_TERMINAL）',
    });
  }

  const tree = input.afterCheck ?? null;
  if (tree === null) {
    return Object.freeze({
      ...base,
      checkEV: null,
      kind: CheckTreeKind.HEURISTIC_TREE,
      checkBackLikelihood: 0,
      heroEquityVsCheckBackRange: null,
      evShowdown: null,
      betLikelihood: 0,
      villainBetAmount: 0,
      heroEquityVsBetRange: null,
      heroCallEV: null,
      heroFoldEV: 0,
      heroBestResponseEV: null,
      components: Object.freeze({}),
      noteZh: '河牌 + 我在前位，但拿不到「他过牌/下注」的分流数据 ⇒ CHECK EV 不可计算（不伪造）',
    });
  }

  const bet = Math.max(0, tree.villainBetAmount);
  /*
   * 🔴 **翻牌/转牌：两条分支都要乘权益实现因子**。
   *
   * 河牌没有未来街，权益即最终权益（因子 = 1，逐位不变）。
   * 但翻牌/转牌上：
   * - 他过牌后**仍有未来街**（半诈唬可能开出、我被反超）⇒ 过牌分支必须打折；
   * - 我跟注后**也仍有未来街** ⇒ 跟注分支同样不能用裸权益，否则
   *   「跟注 EV」会系统性高于「过牌 EV」，逼出无条件的跟注。
   *
   * 用的是**入口传进来的那个 `realizationFactor`**，与既有的
   * `HEURISTIC_ONE_STREET` 分支同一个因子 —— 不引入第二个来源。
   */
  const futureStreets = input.street !== 'RIVER';
  const realize = (eq: number | null): number | null =>
    eq === null
      ? null
      : futureStreets
        ? Math.max(0, Math.min(1, eq * input.realizationFactor))
        : eq;

  const eqCheckBack = realize(tree.heroEquityVsCheckBackRange);
  const eqVsBet = realize(tree.heroEquityVsBetRange);
  const evShowdown = eqCheckBack === null ? null : eqCheckBack * pot;
  const heroCallEV = eqVsBet === null ? null : eqVsBet * (pot + 2 * bet) - bet;
  const heroBestResponseEV = heroCallEV === null ? null : Math.max(0, heroCallEV);
  const checkEV =
    evShowdown === null || heroBestResponseEV === null
      ? null
      : tree.checkBackLikelihood * evShowdown + tree.betLikelihood * heroBestResponseEV;

  return Object.freeze({
    ...base,
    checkEV,
    kind: CheckTreeKind.HEURISTIC_TREE,
    checkBackLikelihood: tree.checkBackLikelihood,
    heroEquityVsCheckBackRange: tree.heroEquityVsCheckBackRange,
    evShowdown,
    betLikelihood: tree.betLikelihood,
    villainBetAmount: bet,
    heroEquityVsBetRange: tree.heroEquityVsBetRange,
    heroCallEV,
    heroFoldEV: 0,
    heroBestResponseEV,
    components: Object.freeze({
      pCheckBack: tree.checkBackLikelihood,
      pBet: tree.betLikelihood,
      evShowdown: evShowdown ?? 0,
      heroBestResponseEV: heroBestResponseEV ?? 0,
      heroCallEV: heroCallEV ?? 0,
      villainBetAmount: bet,
      pot,
      realizationFactor: futureStreets ? input.realizationFactor : 1,
      /*
       * 诊断量：与范围宽度无关的开枪意愿。**不进 EV 公式**。
       * 缺省时记为 0 而不是伪造一个值。
       */
      fireWeight: tree.fireWeight ?? 0,
    }),
    noteZh:
      `${input.street} + 我在前位 ⇒ 过牌**不是**摊牌：` +
      `P(他过牌) ${tree.checkBackLikelihood.toFixed(3)} × 摊牌 EV ${evShowdown === null ? '—' : evShowdown.toFixed(1)}` +
      ` + P(他下注 ${bet.toFixed(1)}) ${tree.betLikelihood.toFixed(3)} × Hero 最佳应手 ${heroBestResponseEV === null ? '—' : heroBestResponseEV.toFixed(1)}` +
      ` = ${checkEV === null ? '—' : checkEV.toFixed(1)}` +
      `（加注应手 NOT_IMPLEMENTED；HEURISTIC` +
      (futureStreets ? `；两分支均乘权益实现 ${input.realizationFactor.toFixed(3)}` : '') +
      '）',
  });
}

/* ============================================================
 * 下注 EV（三分支；启发式代理）
 * ============================================================ */

export type BetEVBreakdown = {
  kind: BetSizeClass | 'ALL_IN';
  ratioToPot: number;
  betAmount: number;
  foldLikelihood: number;
  callLikelihood: number;
  raiseLikelihood: number;
  heroEquityVsCallRange: number | null;
  heroEquityVsRaiseRange: number | null;
  realizationFactor: number;
  realizedEquityVsCall: number | null;
  realizedEquityVsRaise: number | null;
  /** 他弃牌 ⇒ 我直接赢下**下注前**的底池（**不含** Hero 权益） */
  evFoldBranch: number;
  /** 跟注：eq×(pot + 2×bet) − bet */
  evCallBranch: number | null;
  /** 被加注（简化：我再跟一次同额注）：eq×(pot + 4×bet) − 2×bet */
  evRaiseBranch: number | null;
  /** 被加注后直接弃牌的下界：−bet */
  evRaiseFoldLowerBound: number;
  /** 概率加权 + 已扣投入 */
  betEV: number | null;
  /** 与过牌分支的差（> 0 表示下注更好） */
  deltaVsCheck: number | null;
  evidence: {
    branchFormula: 'EXACT_ONE_STREET';
    equity: 'EXACT' | 'MONTE_CARLO' | 'NOT_AVAILABLE';
    realization: 'HEURISTIC';
    raiseBranch: 'HEURISTIC_ONE_MORE_BET';
  };
  noteZh: string;
};

/**
 * 组合下注 EV。
 *
 * ```text
 * BetEV(size) = P(fold)×pot + P(call)×[eqCall×(pot+2b) − b] + P(raise)×[eqRaise×(pot+4b) − 2b]
 * ```
 *
 * 三条纪律：
 * 1. **弃牌分支不含 Hero 权益**（他弃了就没有摊牌）—— 有测试锁定；
 * 2. **投入只扣一次**（每个分支各自扣掉自己投入的部分，没有额外的成本项）；
 * 3. `pot` 一律是**下注前**的底池（有测试锁定）。
 *
 * ⚠️ 被加注分支是**代理**（假设我再跟一次同额注）。若选择不继续，EV 为 `−bet`
 * （同时暴露为 `evRaiseFoldLowerBound`）。
 */
export function composeBetEV(input: {
  kind: BetSizeClass | 'ALL_IN';
  ratioToPot: number;
  /** 下注**前**的底池（筹码） */
  pot: number;
  foldLikelihood: number;
  callLikelihood: number;
  raiseLikelihood: number;
  /** 对「跟注范围」的原始权益（跑完所有街） */
  heroEquityVsCallRange: number | null;
  /** 对「加注范围」的原始权益 */
  heroEquityVsRaiseRange: number | null;
  realizationFactor: number;
  /** 过牌分支的 EV（用于比较；由调用方按同一口径给出） */
  checkEV: number | null;
}): BetEVBreakdown {
  const bet = Math.max(0, input.pot * input.ratioToPot);
  const pot = input.pot;
  const eqCall = input.heroEquityVsCallRange;
  const eqRaise = input.heroEquityVsRaiseRange;
  const realizedCall = eqCall === null ? null : Math.max(0, Math.min(1, eqCall * input.realizationFactor));
  const realizedRaise = eqRaise === null ? null : Math.max(0, Math.min(1, eqRaise * input.realizationFactor));

  const evFold = pot;
  const callNeeded = input.callLikelihood > 0;
  const raiseNeeded = input.raiseLikelihood > 0;
  const evCall = realizedCall === null ? null : realizedCall * (pot + 2 * bet) - bet;
  const evRaise = realizedRaise === null ? null : realizedRaise * (pot + 4 * bet) - 2 * bet;

  /*
   * 🔴 **空桶不参与，也不阻断 EV。**
   *
   * 概率为 0 的分支对期望没有贡献 —— 若因为它拿不到权益就把整个 BetEV 变成
   * `null`，那么「他不会加注」这种完全正常的情形反而会让 EV 无法计算
   *（第一版实测：转牌小注的加注桶为空 ⇒ BetEV = null ⇒ 三个尺寸全 0，
   * 与修复前的症状一模一样）。
   * 只有当**某个概率 > 0 的分支缺权益**时，BetEV 才是 `null`（如实报缺）。
   */
  const callContribution = !callNeeded ? 0 : evCall === null ? null : input.callLikelihood * evCall;
  const raiseContribution = !raiseNeeded ? 0 : evRaise === null ? null : input.raiseLikelihood * evRaise;
  const betEV =
    callContribution === null || raiseContribution === null
      ? null
      : input.foldLikelihood * evFold + callContribution + raiseContribution;

  return Object.freeze({
    kind: input.kind,
    ratioToPot: input.ratioToPot,
    betAmount: bet,
    foldLikelihood: input.foldLikelihood,
    callLikelihood: input.callLikelihood,
    raiseLikelihood: input.raiseLikelihood,
    heroEquityVsCallRange: eqCall,
    heroEquityVsRaiseRange: eqRaise,
    realizationFactor: input.realizationFactor,
    realizedEquityVsCall: realizedCall,
    realizedEquityVsRaise: realizedRaise,
    evFoldBranch: evFold,
    evCallBranch: callNeeded ? evCall : null,
    evRaiseBranch: raiseNeeded ? evRaise : null,
    evRaiseFoldLowerBound: -bet,
    betEV,
    deltaVsCheck: betEV === null || input.checkEV === null ? null : betEV - input.checkEV,
    evidence: Object.freeze({
      branchFormula: 'EXACT_ONE_STREET' as const,
      equity:
        (callNeeded && eqCall === null) || (raiseNeeded && eqRaise === null)
          ? ('NOT_AVAILABLE' as const)
          : ('EXACT' as const),
      realization: 'HEURISTIC' as const,
      raiseBranch: 'HEURISTIC_ONE_MORE_BET' as const,
    }),
    noteZh:
      `BetEV(${(input.ratioToPot * 100).toFixed(0)}% 池 = ${bet.toFixed(1)} 筹码) = ` +
      `${input.foldLikelihood.toFixed(3)}×${evFold.toFixed(1)}` +
      `${callNeeded ? ` + ${input.callLikelihood.toFixed(3)}×${evCall === null ? '—' : evCall.toFixed(1)}` : '（无人跟注桶）'}` +
      `${raiseNeeded ? ` + ${input.raiseLikelihood.toFixed(3)}×${evRaise === null ? '—' : evRaise.toFixed(1)}` : '（无人加注桶）'}` +
      ` ⇒ ${betEV === null ? '—（缺权益，不编造）' : betEV.toFixed(2) + ' 筹码'}（⚠️ 启发式代理 EV，不是 Solver EV）`,
  });
}

/** 过牌分支 EV 口径（与下注分支同源：都从「下注前的底池」起算） */
export function composeCheckEV(input: {
  pot: number;
  /** 对**到达范围**的原始权益 */
  heroEquityVsArrivalRange: number | null;
  realizationFactor: number;
}): number | null {
  if (input.heroEquityVsArrivalRange === null) return null;
  const realized = Math.max(0, Math.min(1, input.heroEquityVsArrivalRange * input.realizationFactor));
  return realized * input.pot;
}

/* ============================================================
 * 事实包（由 `contextBuilder` 计算，评分层只读）
 * ============================================================ */

/**
 * 一个尺寸的响应事实 + **条件范围权益**。
 *
 * 条件范围权益必须在 `contextBuilder` 里算 —— 决策层拿不到 `Range` 对象
 *（与 `opponentRangeFacts` 同一条架构纪律）。
 */
export type SizeResponseWithEquity = SizeResponse & {
  /** 对**跟注范围**的原始权益（跑完所有街）；拿不到为 null */
  heroEquityVsCallRange: number | null;
  /** 对**加注范围**的原始权益 */
  heroEquityVsRaiseRange: number | null;
  equityMethod: 'EXACT' | 'MONTE_CARLO' | 'NOT_AVAILABLE';
  equityIterations: number;
  /**
   * 🔴 **多人联合树的 BetEV**（≥2 家）。1 家时为 `null` —— 那时 `betEV` 就是
   * 单挑口径，两条路径不会同时存在（避免「哪个才是真的」）。
   */
  multiway: MultiwayBetEV | null;
  /** 证据等级（§17）：多人树 / 含启发式加注分支 / 单挑旧口径 */
  evKind: 'MODEL_EV_MULTIWAY' | 'MODEL_EV_WITH_HEURISTIC_RAISE_BRANCH' | 'SINGLE_OPPONENT_MODEL_EV' | 'NOT_AVAILABLE';
};

/** 逐对手 × 逐尺寸的响应明细（§18 Per-opponent response） */
export type OpponentSizeResponse = {
  opponentId: string;
  positionZh: string;
  tendencyNoteZh: string;
  kind: BetSizeClass | 'ALL_IN';
  betAmount: number;
  foldProbability: number;
  callProbability: number;
  raiseProbability: number;
  rawFoldProbability: number;
  rawCallProbability: number;
  rawRaiseProbability: number;
  /** 与**前一个尺寸**相比 P(弃) 的变化（弹性；第一个尺寸为 null） */
  foldElasticityVsPrevious: number | null;
  heroEquityVsCallRange: number | null;
  heroEquityVsRaiseRange: number | null;
  noteZh: string;
};

/** 尺寸饱和审计（§14） */
export type SizeSaturationAudit = {
  status: 'DISTINCT_RESPONSES' | 'IDENTICAL_RESPONSE_QUANTIZED' | 'IDENTICAL_RESPONSE_SAME_AMOUNT' | 'CLAMPED_BY_ALLIN';
  /** 响应向量逐位相同的尺寸类别对 */
  identicalPairs: readonly { a: string; b: string; opponents: readonly string[] }[];
  reasonZh: string;
};

/** 多人下注决策事实包（`debug.multiwayBetDecision`，§23） */
export type MultiwayBetFacts = {
  /** 参与联合树的对手（**完整列表**，不是 primary 一个） */
  opponents: readonly { opponentId: string; positionZh: string; tendencyNoteZh: string; comboCount: number }[];
  jointModel: JointModel;
  independenceAssumption: string;
  /** 逐尺寸的联合状态（§5/§18） */
  jointStates: readonly { kind: BetSizeClass | 'ALL_IN'; betAmount: number; states: JointStates }[];
  conditionalEquities: readonly {
    kind: BetSizeClass | 'ALL_IN';
    betAmount: number;
    byCallerId: Readonly<Record<string, number | null>>;
    allCall: number | null;
    anyRaise: number | null;
    noteZh: string;
  }[];
  branchEVs: readonly { kind: BetSizeClass | 'ALL_IN'; betAmount: number; branches: readonly MultiwayBranchEV[] }[];
  totalBetEV: readonly { kind: BetSizeClass | 'ALL_IN'; betAmount: number; totalEV: number | null; evKind: string }[];
  sizeElasticity: readonly { opponentId: string; foldDeltaPerSize: readonly number[] }[];
  sizeSaturation: SizeSaturationAudit;
  /** 逐对手 × 逐尺寸的响应明细（§18 Per-opponent response） */
  perOpponentResponse: readonly OpponentSizeResponse[];
  /** 硬性声明：多人 EV **没有**用 primary opponent 决定（§13） */
  primaryOpponentUsedForEV: false;
  modelConfidence: number;
  noteZh: string;
};

/** 下注决策的完整事实包（`PostflopFacts.betDecision`） */
export type BetDecisionFacts = {
  /** 下注**前**的底池（筹码）—— 所有分支口径的基准 */
  pot: number;
  /** 对到达范围（未条件化）的权益 */
  heroEquityVsArrivalRange: number | null;
  /** Hero 自身听牌潜力（**不进权益**，只做 realization / 半诈唬质量） */
  draw: HeroDrawPotential;
  /** 权益实现因子（**下注被跟注**分支；代理模型，标 HEURISTIC） */
  realization: RealizationBreakdown;
  /**
   * **过牌**分支的权益实现因子（同一代理模型，但**没有主动权、也不享受
   * 听牌实现加成**）。
   *
   * ## 为什么必须分开
   *
   * `realizationFactor` 里的 `initiative` 与 `drawBonus` 描述的是
   * 「我下注被跟注后还能继续施压/在成牌时取值」这件事 —— 过牌**没有**这个
   * 优势（我把主动权交出去了，成牌也只能靠对手再下注）。
   * 第一版两条分支共用同一个因子，等于给「过牌」白送了下注才有的实现优势
   *（实测：坚果同花听的过牌 EV 被抬高到 16.17，而空气只有 5.32 ——
   *  这不是错在数量级，而是**口径不对称**）。
   */
  checkRealizationFactor: number;
  /**
   * **已合法化**的尺寸（同金额已去重）。
   *
   * 强契约（§1）：**同一个 `legalAmount` ⇒ 同一份响应模型 ⇒ 同一条件范围
   * ⇒ 同一权益 ⇒ 同一 EV**。被封顶到同一金额的候选只会保留一个。
   */
  sizes: readonly SizeResponseWithEquity[];
  /** 因「封顶后金额重复」或「低于最小注」被丢弃的候选（只进 debug，绝不参与 EV） */
  droppedSizes: readonly LegalBetSize[];
  /** 参与分类的可达组合数 */
  comboCount: number;
  /** 响应层使用的画像倾向 */
  tendencies: ResponseTendencies;
  /**
   * 🔴 **河牌 CHECK 树**（§5/§6）：Hero 过牌**不等于**立即摊牌。
   * 前位 ⇒ 他仍可下注（`CHECK_BACK` | `BET` 最小树）；后位 ⇒ 摊牌终止。
   */
  checkTree: CheckTreeResult;
  /** 模型说明（含证据等级与代理声明） */
  modelNoteZh: string;
  /**
   * 🔴 **多人联合响应树**（≥2 家才非 null）。
   *
   * 修复前：三人池只有**一组** Fold/Call/Raise（= primary opponent 的响应），
   * 而弃牌分支被当成「直接拿下底池」⇒ 系统性高估下注 EV。
   * 现在每个尺寸都走完整联合树，EV 由逐分支加权得出。
   */
  multiway: MultiwayBetFacts | null;
};

/* ============================================================
 * 多人联合响应树（MULTIWAY POSTFLOP RESPONSE TREE PHASE 1）
 * ============================================================ */

/**
 * 联合模型的假设等级。
 *
 * Phase 1 只有条件独立：`P(A ∧ B) ≈ P(A) × P(B)`。
 * ⚠️ 这不是「真相」，是一个**显式声明的近似**；真实牌局里两人的响应正相关
 *（同一张牌面同时帮到/伤到两个人）。
 */
export const JointModel = {
  CONDITIONAL_INDEPENDENCE: 'CONDITIONAL_INDEPENDENCE',
} as const;
export type JointModel = (typeof JointModel)[keyof typeof JointModel];

export const JOINT_INDEPENDENCE_NOTE =
  'HEURISTIC_INDEPENDENCE_ASSUMPTION：各对手响应按条件独立相乘（未建模相关性）';

export const JointStateKind = {
  /** 全部弃牌 —— Hero 直接拿下底池。**必须是连乘**，不是平均、不是 primary */
  ALL_FOLD: 'ALL_FOLD',
  /** 恰好一家跟注（`callerId` 指明是谁） */
  ONLY_ONE_CALLS: 'ONLY_ONE_CALLS',
  /** 所有人都跟注 */
  ALL_CALL: 'ALL_CALL',
  /** 部分跟注（≥2 家但没全跟）—— 只有 3 家及以上才可能出现 */
  PARTIAL_CALLS: 'PARTIAL_CALLS',
  /** 至少一家加注（聚合分支；完整再加注树未实现 ⇒ 只给下界） */
  ANY_RAISE: 'ANY_RAISE',
} as const;
export type JointStateKind = (typeof JointStateKind)[keyof typeof JointStateKind];

export const JOINT_STATE_ZH: Readonly<Record<JointStateKind, string>> = Object.freeze({
  ALL_FOLD: '全部弃牌（Hero 直接拿下底池）',
  ONLY_ONE_CALLS: '恰好一家跟注',
  ALL_CALL: '全部跟注',
  PARTIAL_CALLS: '部分跟注（≥2 家未全跟）',
  ANY_RAISE: '至少一家加注（聚合）',
});

/** 一个对手对**某个尺寸**的响应（每家一个独立对象，禁止跨对手复用） */
export type OpponentResponseShares = {
  opponentId: string;
  positionZh: string;
  /** 画像来源说明（哪一家带了画像、哪一家是中立先验） */
  tendencyNoteZh: string;
  foldProbability: number;
  callProbability: number;
  raiseProbability: number;
};

export type JointStateEntry = {
  kind: JointStateKind;
  /** `ONLY_ONE_CALLS` 时是谁在跟 */
  callerId: string | null;
  probability: number;
  noteZh: string;
};

export type JointStates = {
  model: JointModel;
  independenceNoteZh: string;
  /** 全部对手都弃牌的概率（**连乘**；2 家 = f₁×f₂） */
  allFold: number;
  /** 状态概率之和（构造上应为 1；用于墨菲检查） */
  total: number;
  states: readonly JointStateEntry[];
  noteZh: string;
};

/**
 * 把「每个对手各自的 fold/call/raise」合成为**联合状态分布**。
 *
 * ```text
 * P(ALL_FOLD)      = Π f_i
 * P(ONLY_j_CALLS)  = c_j × Π_{i≠j} f_i
 * P(ALL_CALL)      = Π c_i
 * P(ANY_RAISE)     = 1 − Π(f_i + c_i)          ← 至少一家加注
 * P(PARTIAL_CALLS) = 其余（N ≥ 3 才非零）
 * ```
 *
 * 🔴 **禁止**用平均弃牌率 / primary 弃牌率 / 「任意一家弃牌」顶替 `ALL_FOLD`：
 * 直接拿下底池要求**所有对手同时弃牌**，两人各弃 50% ⇒ 15% 而不是 50%。
 */
export function jointStatesOf(
  responses: readonly OpponentResponseShares[],
): JointStates | null {
  if (responses.length === 0) return null;

  // 每个对手的三个概率必须自己归一（浮点误差容差 1e-9）
  const normalized = responses.map((r) => {
    const sum = r.foldProbability + r.callProbability + r.raiseProbability;
    if (!(sum > 0) || !Number.isFinite(sum)) return null;
    return {
      id: r.opponentId,
      fold: r.foldProbability / sum,
      call: r.callProbability / sum,
      raise: r.raiseProbability / sum,
    };
  });
  if (normalized.some((n) => n === null)) return null;
  const list = normalized as { id: string; fold: number; call: number; raise: number }[];

  const product = (pick: (x: (typeof list)[number]) => number): number =>
    list.reduce((acc, x) => acc * pick(x), 1);

  const allFold = product((x) => x.fold);
  const allCall = list.length >= 2 ? product((x) => x.call) : 0;
  const anyRaise = 1 - product((x) => x.fold + x.call);

  const states: JointStateEntry[] = [
    {
      kind: JointStateKind.ALL_FOLD,
      callerId: null,
      probability: allFold,
      noteZh: `Π P(弃) = ${list.map((x) => x.fold.toFixed(3)).join(' × ')} = ${allFold.toFixed(4)}`,
    },
  ];

  for (const caller of list) {
    const others = list.filter((x) => x.id !== caller.id);
    const probability = list.length === 1 ? caller.call : caller.call * others.reduce((acc, x) => acc * x.fold, 1);
    states.push({
      kind: JointStateKind.ONLY_ONE_CALLS,
      callerId: caller.id,
      probability,
      noteZh:
        list.length === 1
          ? `P(跟) = ${caller.call.toFixed(3)}`
          : `P(他跟) × Π(其余弃) = ${caller.call.toFixed(3)} × ${others.map((x) => x.fold.toFixed(3)).join(' × ')}`,
    });
  }

  if (list.length >= 2) {
    states.push({
      kind: JointStateKind.ALL_CALL,
      callerId: null,
      probability: allCall,
      noteZh: `Π P(跟) = ${list.map((x) => x.call.toFixed(3)).join(' × ')} = ${allCall.toFixed(4)}`,
    });
  }

  states.push({
    kind: JointStateKind.ANY_RAISE,
    callerId: null,
    probability: Math.max(0, anyRaise),
    noteZh:
      `1 − Π P(弃或跟) = 1 − ${list.map((x) => (x.fold + x.call).toFixed(3)).join(' × ')} = ` +
      `${anyRaise.toFixed(4)}（聚合分支：谁加注、之后 Hero 怎么应对**未建模**）`,
  });

  const accounted = states.reduce((acc, s) => acc + s.probability, 0);
  const residual = 1 - accounted;
  if (residual > 1e-9 && list.length >= 3) {
    states.push({
      kind: JointStateKind.PARTIAL_CALLS,
      callerId: null,
      probability: residual,
      noteZh:
        `余量 ${residual.toFixed(4)}：≥2 家跟注但没全跟（3 家及以上才会出现；` +
        '权益用「全部跟注」口径 ⇒ 保守下界）',
    });
  } else if (residual < -1e-9) {
    // 概率不守恒 ⇒ 拒绝输出（宁可不给，也不给一个自相矛盾的概率表）
    return null;
  }

  const total = states.reduce((acc, s) => acc + s.probability, 0);
  return Object.freeze({
    model: JointModel.CONDITIONAL_INDEPENDENCE,
    independenceNoteZh: JOINT_INDEPENDENCE_NOTE,
    allFold,
    total,
    states: Object.freeze(states.map((s) => Object.freeze(s))),
    noteZh:
      `${responses.length} 家联合状态：` +
      states.map((s) => `${s.kind}${s.callerId === null ? '' : `(${s.callerId})`} ${(s.probability * 100).toFixed(1)}%`).join('｜') +
      `｜${JOINT_INDEPENDENCE_NOTE}`,
  });
}

/** 联合分支的 EV 明细（每项可逐项复算，§18） */
export type MultiwayBranchEV = {
  kind: JointStateKind;
  callerId: string | null;
  probability: number;
  heroEquity: number | null;
  realizationFactor: number;
  realizedEquity: number | null;
  /** 该分支结束时的底池（含所有跟注者的投入） */
  resultingPot: number;
  /** Hero 在这一分支投入的筹码 —— **每个分支都只扣一次下注成本**（§8） */
  heroCostChips: number;
  ev: number | null;
  noteZh: string;
};

export type MultiwayBetEV = {
  betAmount: number;
  ratioToPot: number;
  jointStates: JointStates;
  branches: readonly MultiwayBranchEV[];
  /** Σ 概率×分支EV；任一 p>0 的分支缺权益时为 null（不编造） */
  totalEV: number | null;
  /**
   * 证据等级（§17）：`MODEL_EV_MULTIWAY` = 各分支权益独立计算；
   * `MODEL_EV_WITH_HEURISTIC_RAISE_BRANCH` = 加注分支只有下界（未实现再加注树）。
   */
  evKind: 'MODEL_EV_MULTIWAY' | 'MODEL_EV_WITH_HEURISTIC_RAISE_BRANCH' | 'NOT_AVAILABLE';
  /** Hero 的下注成本在整棵树上**只扣一次**（= betAmount；用于墨菲检查） */
  heroCostChargedOnce: number;
  noteZh: string;
};

/**
 * 多人下注 EV（§7–§10）。
 *
 * ```text
 * BetEV = P(ALL_FOLD)      × 底池
 *       + Σ_j P(仅 j 跟)    × [eq_j × (底池 + 2B) × 实现率 − B]
 *       + P(ALL_CALL)      × [eq_all × (底池 + (N+1)B) × 实现率 − B]
 *       + P(PARTIAL_CALLS) × [eq_all × (底池 + 3B) × 实现率 − B]     ← k=2 保守下界
 *       + P(ANY_RAISE)     × (−B)                                    ← Hero 放弃，下界
 * ```
 *
 * ⚠️ 三条纪律：
 * 1. **B 只扣一次**：每个分支各扣一次是**对的**（分支互斥，期望里按概率加权），
 *    但同一分支内不得重复扣（这正是旧版容易出错的地方）；
 * 2. 各分支的底池**各不相同**，必须按实际跟注人数累加（§9）；
 * 3. 加注分支只给下界并标 `HEURISTIC`（§10），**不允许**丢分支。
 */
export function composeMultiwayBetEV(input: {
  pot: number;
  betAmount: number;
  ratioToPot: number;
  realizationFactor: number;
  states: JointStates;
  /** 各「仅一家跟」分支的权益（按 callerId 索引） */
  equityByCallerId: Readonly<Record<string, number | null>>;
  /** 全部跟注（真多人权益） */
  allCallEquity: number | null;
  /** 加注分支的权益（对加注范围；只用于展示，EV 取下界） */
  anyRaiseEquity: number | null;
  /** 对手家数（用于 ALL_CALL 的底池口径） */
  opponentCount: number;
}): MultiwayBetEV {
  const { pot, betAmount: bet, realizationFactor } = input;
  const n = Math.max(1, input.opponentCount);
  const realized = (eq: number | null): number | null =>
    eq === null ? null : Math.max(0, Math.min(1, eq * realizationFactor));

  const branches: MultiwayBranchEV[] = input.states.states.map((state) => {
    if (state.kind === JointStateKind.ALL_FOLD) {
      return Object.freeze({
        kind: state.kind,
        callerId: null,
        probability: state.probability,
        heroEquity: null,
        realizationFactor,
        realizedEquity: null,
        resultingPot: pot,
        heroCostChips: 0,
        ev: pot,
        noteZh: '全部弃牌 ⇒ Hero 拿下当前底池（下注额收回，不扣成本）',
      });
    }
    if (state.kind === JointStateKind.ANY_RAISE) {
      return Object.freeze({
        kind: state.kind,
        callerId: null,
        probability: state.probability,
        heroEquity: input.anyRaiseEquity,
        realizationFactor,
        realizedEquity: null,
        resultingPot: pot + bet,
        heroCostChips: bet,
        ev: -bet,
        noteZh:
          '加注分支：完整再加注树未实现 ⇒ 按 **Hero 直接放弃**取**下界**（−下注额）；' +
          `他对加注范围的权益 ${input.anyRaiseEquity === null ? '—' : (input.anyRaiseEquity * 100).toFixed(1) + '%'} 仅作展示` +
          '（RAISE_RESPONSE = HEURISTIC）',
      });
    }

    // 跟注类分支：只有底池口径与权益不同
    const callers =
      state.kind === JointStateKind.ONLY_ONE_CALLS
        ? 1
        : state.kind === JointStateKind.ALL_CALL
          ? n
          : 2; // PARTIAL_CALLS：至少 2 家（保守下界）
    const equity =
      state.kind === JointStateKind.ONLY_ONE_CALLS
        ? (state.callerId === null ? null : (input.equityByCallerId[state.callerId] ?? null))
        : input.allCallEquity;
    const eq = realized(equity);
    const resultingPot = pot + bet + callers * bet;
    const ev = eq === null ? null : eq * resultingPot - bet;
    return Object.freeze({
      kind: state.kind,
      callerId: state.callerId,
      probability: state.probability,
      heroEquity: equity,
      realizationFactor,
      realizedEquity: eq,
      resultingPot,
      heroCostChips: bet,
      ev,
      noteZh:
        `${callers} 家跟注 ⇒ 底池 ${pot} + 我 ${bet} + ${callers}×${bet} = ${resultingPot}；` +
        `权益 ${equity === null ? '—' : (equity * 100).toFixed(1) + '%'} × 实现率 ${realizationFactor.toFixed(3)} ⇒ ` +
        `EV = ${ev === null ? '—' : ev.toFixed(2)}`,
    });
  });

  const missing = branches.some((b) => b.probability > 1e-9 && b.ev === null);
  const totalEV = missing
    ? null
    : branches.reduce((acc, b) => acc + b.probability * (b.ev ?? 0), 0);

  const raiseIsHeuristic = branches.some(
    (b) => b.kind === JointStateKind.ANY_RAISE && b.probability > 1e-9,
  );
  return Object.freeze({
    betAmount: bet,
    ratioToPot: input.ratioToPot,
    jointStates: input.states,
    branches: Object.freeze(branches),
    totalEV,
    evKind: missing
      ? ('NOT_AVAILABLE' as const)
      : raiseIsHeuristic
        ? ('MODEL_EV_WITH_HEURISTIC_RAISE_BRANCH' as const)
        : ('MODEL_EV_MULTIWAY' as const),
    heroCostChargedOnce: bet,
    noteZh:
      `多人 BetEV（${n} 家）= ` +
      branches
        .map((b) => `${(b.probability * 100).toFixed(1)}%×${b.ev === null ? '—' : b.ev.toFixed(2)}`)
        .join(' + ') +
      ` ⇒ ${totalEV === null ? '—（有分支缺权益）' : totalEV.toFixed(2)} 筹码` +
      `｜下注成本 ${bet} 全树只扣一次/分支｜加注分支 = 下界（HEURISTIC）`,
  });
}

/* ============================================================
 * 评分（每尺寸独立；不再共用同一个分数）
 * ============================================================ */

/**
 * 把「与过牌分支的 EV 差」映射到 0..1 的比较分（**只为既有 `scores` 数组与置信度服务**）。
 *
 * ```text
 * score = clamp01( 0.5 + 0.5 × (ev − checkEV) / pot )
 * ```
 *
 * 过牌 = 0.5 基准；比过牌好 0.5 个底池 ⇒ 0.75。它是**展示/比较用的归一化刻度**，
 * 不是概率、不是 EV —— UI 必须同时显示真实 EV（筹码）。
 */
export function normalizeEVScore(ev: number | null, checkEV: number | null, pot: number): number {
  if (ev === null || checkEV === null || !(pot > 0)) return 0;
  const value = 0.5 + (0.5 * (ev - checkEV)) / pot;
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
