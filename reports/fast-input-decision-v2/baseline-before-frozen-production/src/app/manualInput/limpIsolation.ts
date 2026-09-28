/**
 * 🔴 **多人 Limp 场景的隔离加注模型**（MULTI_LIMP ISOLATION RAISE PHASE 1）
 *
 * ## 修的是什么（玩家实测）
 *
 * 固定节点：6-max 1/2，UTG/HJ/CO 三个跛入，Hero BTN K♠Q♠。旧输出：
 *
 * ```text
 * CALL   PROXY_EV +2.05，CLEAR_CALL          ← 只证明了 CALL > FOLD
 * RAISE  6BB，HEURISTIC，EV = NOT_AVAILABLE
 * FINAL  CALL（被 CANNOT_OVERRIDE_CLEAR_SUPPORTED_CALL 阻断）
 * 三个 limper 的范围都 = 1225 组合（任意两张）
 * ```
 *
 * 三个缺陷：
 * 1. **边际没有作用域**：`CLEAR_CALL` 被当成「CALL 优于一切」，而它只比较了 CALL vs FOLD。
 * 2. **加注没有独立证据**：隔离加注在多人 limp 局面里有独立的价值来源
 *    （死钱、位置、对 limp 范围的压制、减少人数、主动权），却被当成「普通启发式」。
 * 3. **limp 范围过粗**：`bigBlindCheckWeights()`（任意两张）被当成 limp 范围，
 *    人物画像完全没进来。
 *
 * ## 本模块的做法
 *
 * ```text
 * ① limp 到达范围：以既有 `bigBlindCheckWeights()`（最宽基线）为起点，
 *    按「位置 × 原型 × 倾向」收窄 —— 权重按既有 `tierOfRankClass` 分档衰减，
 *    不新增任何 169 类权重表、不硬编码任何具体牌型百分比。
 * ② 每个 limper 的响应：P(limp-fold) / P(limp-call) / P(limp-reraise)，和为 1，
 *    由「他要补的价格 vs 该牌型的牌力代理」+ 原型倾向共同决定。
 * ③ 联合响应：条件独立近似（**显式标注** HEURISTIC_INDEPENDENCE_ASSUMPTION）。
 * ④ 隔离加注 EV：与 CALL 同一零点（弃牌 ≡ 0，筹码单位），因此**可直接比较** ——
 *    这就是「不同作用域的证据不能硬压、而要进入跨动作比较」的落地：
 *    两边各自带 scope，比较发生在**同一零点**上。
 * ⑤ 尺寸：`baseOpen + perLimper × 人数 + 位置/黏度/筹码修正`，公式公开、可测。
 *
 * ⚠️ 全部是**代理模型**（`ISO_RAISE_PROXY_EV`），不是求解器 EV。
 * ⚠️ RAKE 未实现（`RAKE = NOT_IMPLEMENTED`），CALL 与 RAISE 两条代理都必须显示这一点。
 */

import { Position } from '../../domain/types.ts';
import { tierOfRankClass } from './likelihoodModel.ts';
import { bigBlindCheckWeights } from './preflopPriors.ts';
import type { RankClassWeights } from '../../domain/range/range.ts';

/* ============================================================
 * 原型与位置先验
 * ============================================================ */

export const LimperArchetype = {
  TIGHT: 'TIGHT',
  NORMAL: 'NORMAL',
  LOOSE_PASSIVE: 'LOOSE_PASSIVE',
  CALLING_STATION: 'CALLING_STATION',
  LIMP_RERAISE_HEAVY: 'LIMP_RERAISE_HEAVY',
  /** 没有画像：只用位置群体先验 */
  POPULATION: 'POPULATION',
} as const;
export type LimperArchetype = (typeof LimperArchetype)[keyof typeof LimperArchetype];

export const LIMPER_ARCHETYPE_ZH: Readonly<Record<LimperArchetype, string>> = Object.freeze({
  TIGHT: '偏紧（limp 少、弃得多）',
  NORMAL: '普通（中立）',
  LOOSE_PASSIVE: '松弱（limp 宽、被动）',
  CALLING_STATION: '跟注站（limp 宽、几乎不弃）',
  LIMP_RERAISE_HEAVY: '爱 limp-reraise（埋伏型）',
  POPULATION: '无画像（位置群体先验）',
});

/**
 * 原型 → 「limp 到达范围宽度 / 弃牌倾向 / 跟注倾向 / 再加注倾向」。
 *
 * 【启发式】结构性刻度：只有序关系有意义（例如跟注站的 `call` 高于普通、
 * 埋伏型的 `reraise` 高于普通）。数值不是实测频率。
 */
export type LimperTraits = {
  /** limp 到达范围宽度 0..1（1 = 任意两张） */
  width: number;
  fold: number;
  call: number;
  reraise: number;
};

export const LIMP_TRAITS: Readonly<Record<LimperArchetype, LimperTraits>> = Object.freeze({
  TIGHT: { width: 0.38, fold: 1.35, call: 0.7, reraise: 0.9 },
  NORMAL: { width: 0.62, fold: 1.0, call: 1.0, reraise: 1.0 },
  LOOSE_PASSIVE: { width: 0.85, fold: 0.8, call: 1.2, reraise: 0.6 },
  CALLING_STATION: { width: 0.9, fold: 0.65, call: 1.35, reraise: 0.55 },
  LIMP_RERAISE_HEAVY: { width: 0.5, fold: 1.1, call: 0.85, reraise: 2.1 },
  POPULATION: { width: 0.68, fold: 1.0, call: 1.05, reraise: 0.85 },
});

/** 位置对 limp 宽度的修正：越靠前 limp 越少（但仍属被动型） */
const POSITION_WIDTH_ADJ: Readonly<Record<string, number>> = Object.freeze({
  UTG: -0.08,
  UTG1: -0.07,
  UTG2: -0.06,
  LJ: -0.05,
  HJ: -0.02,
  CO: 0.02,
  BTN: 0.05,
  SB: 0.04,
  BB: 0.06,
});

export type LimperInput = {
  position: Position;
  archetype: LimperArchetype;
  /** 画像可信度 0..1（0 = 无画像 ⇒ 只用位置 + POPULATION 先验） */
  confidence: number;
};

/** 把画像可信度算进去后的有效倾向：可信度 0 ⇒ 完全回落到群体先验 */
export function effectiveTraits(input: LimperInput): LimperTraits {
  const base = LIMP_TRAITS[input.archetype];
  const pop = LIMP_TRAITS.POPULATION;
  const c = Math.max(0, Math.min(1, input.confidence));
  const mix = (a: number, b: number): number => b + (a - b) * c;
  return {
    width: mix(base.width, pop.width) + (POSITION_WIDTH_ADJ[input.position] ?? 0) * c,
    fold: mix(base.fold, pop.fold),
    call: mix(base.call, pop.call),
    reraise: mix(base.reraise, pop.reraise),
  };
}

/* ============================================================
 * ① limp 到达范围
 * ============================================================ */

export type LimpArrivalRange = {
  /** 169 类权重（只含 limp 范围里的牌型） */
  weights: RankClassWeights;
  /** 占全部组合的比例（组合数口径，不是概率质量） */
  comboShare: number;
  /** 有效宽度（debug） */
  width: number;
  noteZh: string;
};

/**
 * limp 到达范围 = 最宽基线（既有 `bigBlindCheckWeights`）按档位衰减。
 *
 * ```text
 * weight(class) = baseline(class) × width^(tier / 5)
 * ```
 *
 * 弱档（tier 大）衰减更快 ⇒ 紧的 limp 范围只剩强档；`width = 1` 时逐位等于基线。
 * **没有**任何「AA 权重 0.9、72o 权重 0.1」这类硬编码。
 */
export function limpArrivalRangeOf(input: LimperInput): LimpArrivalRange {
  const traits = effectiveTraits(input);
  const width = Math.max(0.1, Math.min(1, traits.width));
  const baseline = bigBlindCheckWeights() as Readonly<Record<string, number>>;
  const weights: Record<string, number> = {};
  let combos = 0;
  let kept = 0;
  for (const [rankClass, base] of Object.entries(baseline)) {
    if (!(base > 0)) continue;
    combos += rankClassComboCount(rankClass);
    const tier = tierOfRankClass(rankClass);
    const scaled = base * Math.pow(width, tier / 5);
    if (scaled <= 1e-6) continue;
    weights[rankClass] = scaled;
    kept += rankClassComboCount(rankClass);
  }
  return Object.freeze({
    weights: Object.freeze(weights) as RankClassWeights,
    comboShare: combos > 0 ? kept / combos : 0,
    width,
    noteZh:
      `${LIMPER_ARCHETYPE_ZH[input.archetype]}（可信度 ${input.confidence.toFixed(2)}）⇒ ` +
      `limp 到达范围宽度 ${width.toFixed(2)}，保留组合占比 ${((kept / Math.max(1, combos)) * 100).toFixed(1)}%` +
      '（按档位衰减，不是任意两张）',
  });
}

/** 某个类别键的组合数（对子 6、同花 4、非同花 12） */
function rankClassComboCount(rankClass: string): number {
  if (rankClass.length === 2) return 6;
  return rankClass.endsWith('s') ? 4 : 12;
}

/* ============================================================
 * ② 每个 limper 的响应
 * ============================================================ */

export type LimpResponse = {
  foldProbability: number;
  callProbability: number;
  reraiseProbability: number;
  /** 组合占比（与概率区分：概率是「他会这么做」的总概率） */
  foldShare: number;
  callShare: number;
  reraiseShare: number;
  /** 他面对的价格（补注 / 最终底池） */
  priceRequiredEquity: number;
  noteZh: string;
};

/**
 * 响应切分 —— **唯一实现**（`limpResponseOf` 与 `limpResponseRangesOf` 共用）。
 *
 * ```text
 * price    = 他要补的筹码 / (隔离后的底池 + 他要补的筹码)
 * strength = 1 − tier/5                     （牌力代理，来自既有 tierOfRankClass）
 * 继续比例  = clamp((strength − price×fold/call) / (1/5) + 0.5, 0, 1)   ← 连续混频，见下
 * 概率      = 按**人群形状**对「跟注类集合 / 弃牌类集合」计权           ← 见下面的 🔴
 * reraise  ⇔ tier ≤ 1（强档）且 reraiseTendency 高（按权重混频，不是全有全无）
 * ```
 *
 * 🔴 **为什么概率用「人群形状」而不是他自己的到达范围形状计权。**
 *
 * 到达范围是 `基线 × 宽度^(档位/5)`：越宽的玩家，弱档牌在范围里的**占比**越高。
 * 若直接用这个形状算弃牌率，会得到一个反向的伪相关 ——
 * 实测：跟注站（宽度 0.76）弃牌率 55.8% **高于**人群先验（0.68）的 54.3%，
 * 因为「他limp的垃圾更多」压过了「他更不爱弃牌」。
 * 那不是我们要建模的东西：**宽度决定他用什么牌进池，倾向决定他怎么应对加注**。
 * 因此概率按人群形状计权（同一个牌面结构下比较倾向），
 * 而**范围本身**仍然按他自己的到达范围切（§5 的条件范围不受影响）。
 *
 * 方向（§13 要求）：CALLING_STATION ⇒ call ↑ / fold ↓；TIGHT ⇒ fold ↑；
 * LIMP_RERAISE_HEAVY ⇒ reraise ↑（但**不是所有牌**都 reraise，只有强档 + 权重）。
 */
function responseSplitOf(
  limper: LimperInput,
  price: number,
): {
  foldWeights: RankClassWeights;
  callWeights: RankClassWeights;
  reraiseWeights: RankClassWeights;
  foldShare: number;
  callShare: number;
  reraiseShare: number;
} {
  const traits = effectiveTraits(limper);
  const arrival = limpArrivalRangeOf(limper);
  // 概率计权用的**人群形状**（同位置、无画像）
  const shape = limpArrivalRangeOf({
    position: limper.position,
    archetype: LimperArchetype.POPULATION,
    confidence: 0,
  }).weights;

  const foldWeights: Record<string, number> = {};
  const callWeights: Record<string, number> = {};
  const reraiseWeights: Record<string, number> = {};
  let foldMass = 0;
  let callMass = 0;
  let reraiseMass = 0;
  let total = 0;
  /*
   * 🔴 继续的**比例**是连续的（不是一个硬切）。
   *
   * `strength` 只有 6 档（`1 − tier/5`），硬切会让「跟注站 vs 松弱」这种
   * 相邻倾向落到**同一档集合**上 ⇒ 两者的弃牌率完全相同 —— 画像形同没接进来。
   * 因此按「距离门槛还有几档」做线性混频：正好在门槛上的牌型一半继续。
   * 这不是新参数：`1/5` 就是档位步长本身。
   */
  const thresholdStrength = (price * traits.fold) / traits.call;
  const STEP = 1 / 5;
  for (const [rankClass, weight] of Object.entries(arrival.weights) as [string, number][]) {
    const combos = rankClassComboCount(rankClass);
    const mass = (shape[rankClass] ?? 0) * combos;
    total += mass;
    const tier = tierOfRankClass(rankClass);
    const strength = 1 - tier / 5;
    const continueFraction = Math.max(
      0,
      Math.min(1, (strength - thresholdStrength) / STEP + 0.5),
    );
    if (continueFraction <= 0) {
      foldWeights[rankClass] = weight;
      foldMass += mass;
      continue;
    }
    if (continueFraction < 1) {
      foldWeights[rankClass] = weight * (1 - continueFraction);
      foldMass += mass * (1 - continueFraction);
    }
    // 再加注：只有**强档**（tier ≤ 1）且原型倾向高时才发生，且按权重混频 ——
    // 「所有牌都 reraise」的疯子模型是**禁止**的（§5）。
    const reraiseWeight = tier <= 1 ? Math.max(0, Math.min(0.85, 0.35 * traits.reraise)) : 0;
    if (reraiseWeight > 0) {
      reraiseWeights[rankClass] = weight * continueFraction * reraiseWeight;
      reraiseMass += mass * continueFraction * reraiseWeight;
    }
    callWeights[rankClass] = weight * continueFraction * (1 - reraiseWeight);
    callMass += mass * continueFraction * (1 - reraiseWeight);
  }
  const safeTotal = total > 0 ? total : 1;
  return {
    foldWeights,
    callWeights,
    reraiseWeights,
    foldShare: foldMass / safeTotal,
    callShare: callMass / safeTotal,
    reraiseShare: reraiseMass / safeTotal,
  };
}

/** 他面对的价格（补注 / 最终底池） */
function priceOf(input: { potAfterRaise: number; chipsToCall: number }): number {
  return input.chipsToCall + input.potAfterRaise > 0
    ? input.chipsToCall / (input.potAfterRaise + input.chipsToCall)
    : 1;
}

export function limpResponseOf(input: {
  limper: LimperInput;
  /** Hero 隔离后的底池（筹码，含 Hero 的下注） */
  potAfterRaise: number;
  /** 他还要补多少（筹码） */
  chipsToCall: number;
}): LimpResponse {
  const price = priceOf(input);
  const split = responseSplitOf(input.limper, price);
  return Object.freeze({
    foldProbability: split.foldShare,
    callProbability: split.callShare,
    reraiseProbability: split.reraiseShare,
    foldShare: split.foldShare,
    callShare: split.callShare,
    reraiseShare: split.reraiseShare,
    priceRequiredEquity: price,
    noteZh:
      `${LIMPER_ARCHETYPE_ZH[input.limper.archetype]}：需要底池权益 ${(price * 100).toFixed(1)}% ⇒ ` +
      `弃 ${(split.foldShare * 100).toFixed(1)}% / 跟 ${(split.callShare * 100).toFixed(1)}% / ` +
      `再加注 ${(split.reraiseShare * 100).toFixed(1)}%`,
  });
}

/* ============================================================
 * ③ 联合响应（条件独立近似）
 * ============================================================ */

export type JointResponses = {
  allFold: number;
  oneCaller: number;
  twoCallers: number;
  threeCallers: number;
  anyReraise: number;
  expectedCallers: number;
  assumption: 'HEURISTIC_INDEPENDENCE_ASSUMPTION';
  noteZh: string;
};

/**
 * 多个 limper 的联合结果。
 *
 * ⚠️ **条件独立近似**：把每个 limper 的响应概率直接相乘。
 * 真实牌局里他们的手牌与倾向**相关**（同一批 limp 范围重叠、同一桌风格），
 * 因此这里显式标注 `HEURISTIC_INDEPENDENCE_ASSUMPTION`，
 * 不声称是精确联合分布。
 */
export function jointResponsesOf(responses: readonly LimpResponse[]): JointResponses {
  const n = responses.length;
  let allFold = 1;
  for (const r of responses) allFold *= 1 - r.callProbability - r.reraiseProbability;
  allFold = Math.max(0, Math.min(1, allFold));

  const anyReraise = 1 - responses.reduce((acc, r) => acc * (1 - r.reraiseProbability), 1);

  // k 个跟注者的概率：对「谁跟」求和（n ≤ 3，直接枚举）
  const callProbs = responses.map((r) => r.callProbability);
  const noCall = responses.map((r) => 1 - r.callProbability - r.reraiseProbability + r.reraiseProbability * 0);
  void noCall;
  const perCaller: number[] = [];
  const subsets = 1 << n;
  for (let mask = 0; mask < subsets; mask += 1) {
    let p = 1;
    let k = 0;
    for (let i = 0; i < n; i += 1) {
      if ((mask & (1 << i)) !== 0) {
        p *= callProbs[i]!;
        k += 1;
      } else {
        // 不跟 = 弃牌 + 再加注（两者都不产生「跟注者」）
        p *= 1 - callProbs[i]!;
      }
    }
    perCaller[k] = (perCaller[k] ?? 0) + p;
  }
  const at = (k: number): number => Math.max(0, Math.min(1, perCaller[k] ?? 0));
  const expectedCallers = callProbs.reduce((a, b) => a + b, 0);

  return Object.freeze({
    allFold,
    oneCaller: at(1),
    twoCallers: at(2),
    threeCallers: at(3),
    anyReraise: Math.max(0, Math.min(1, anyReraise)),
    expectedCallers,
    assumption: 'HEURISTIC_INDEPENDENCE_ASSUMPTION',
    noteZh:
      `条件独立近似：全弃 ${(allFold * 100).toFixed(1)}%｜1 家跟 ${(at(1) * 100).toFixed(1)}%｜` +
      `2 家跟 ${(at(2) * 100).toFixed(1)}%｜3 家跟 ${(at(3) * 100).toFixed(1)}%｜` +
      `任一再加注 ${(anyReraise * 100).toFixed(1)}%｜期望跟注人数 ${expectedCallers.toFixed(2)}` +
      '（⚠️ HEURISTIC_INDEPENDENCE_ASSUMPTION：未建模相关性）',
  });
}

/* ============================================================
 * ②b 条件范围（§4/§5/§8：call / reraise 必须切出**独立范围**）
 * ============================================================ */

export type LimpResponseRanges = {
  callWeights: RankClassWeights;
  reraiseWeights: RankClassWeights;
  foldShare: number;
  callShare: number;
  reraiseShare: number;
};

/**
 * 把 limp 到达范围按响应**切成三个条件范围**（组合占比之和 = 1）。
 *
 * ⚠️ 必须独立切分：`HeroEquityVsLimpArrivalRange ≠ HeroEquityVsLimpCallRange`。
 * 拿到达范围权益去证明隔离加注是**禁止**的（§8）。
 */
export function limpResponseRangesOf(input: {
  limper: LimperInput;
  potAfterRaise: number;
  chipsToCall: number;
}): LimpResponseRanges {
  const split = responseSplitOf(input.limper, priceOf(input));
  return Object.freeze({
    callWeights: Object.freeze(split.callWeights) as RankClassWeights,
    reraiseWeights: Object.freeze(split.reraiseWeights) as RankClassWeights,
    foldShare: split.foldShare,
    callShare: split.callShare,
    reraiseShare: split.reraiseShare,
  });
}

/** 快速画像 → limp 原型（唯一映射处；未列出的标签按 NORMAL） */
export function quickProfileToLimperArchetype(quickProfile: string | null | undefined): LimperArchetype {
  switch (quickProfile) {
    case 'CALLING_STATION':
      return LimperArchetype.CALLING_STATION;
    case 'LOOSE':
    case 'VERY_LOOSE':
      return LimperArchetype.LOOSE_PASSIVE;
    case 'TIGHT':
    case 'VERY_TIGHT':
    case 'UNDERBLUFFER':
      return LimperArchetype.TIGHT;
    case 'MANIAC':
    case 'BLUFF_HEAVY':
      return LimperArchetype.LIMP_RERAISE_HEAVY;
    default:
      return LimperArchetype.NORMAL;
  }
}

/* ============================================================
 * ⑦ 事实包（由 contextBuilder 计算，决策层只读）
 * ============================================================ */

export type PreflopIsoFacts = {
  limperCount: number;
  perLimper: readonly {
    positionZh: string;
    archetypeZh: string;
    /** 到达范围的有效宽度（0..1；1 = 任意两张）—— 组合占比在这里恒为 100%，没有信息量 */
    arrivalWidth: number;
    foldProbability: number;
    callProbability: number;
    reraiseProbability: number;
    priceRequiredEquity: number;
    confidence: number;
    noteZh: string;
  }[];
  joint: JointResponses;
  isoSize: IsoSizeBreakdown;
  heroEquity: {
    vsArrival: number | null;
    vsOneCaller: number | null;
    vsThreeCallers: number | null;
    vsReraise: number | null;
  };
  isoEV: IsoRaiseEV;
  /** CALL vs FOLD 的代理 EV（与 ISO 同一零点；**作用域只有 VS_FOLD**） */
  callProxyEV: number | null;
  callScope: 'VS_FOLD_ONLY';
  playersBehind: PlayersBehindRisk;
  rakeStatus: 'NOT_IMPLEMENTED';
  modelConfidence: number;
  assumptionsZh: readonly string[];
  noteZh: string;
};


/* ============================================================
 * ④ 隔离加注尺寸
 * ============================================================ */

export type IsoSizeBreakdown = {
  requestedIsoSize: number;
  legalIsoSize: number | null;
  limperCount: number;
  components: Readonly<Record<string, number>>;
  noteZh: string;
};

/**
 * 隔离加注尺寸（**公开公式、可测试**）。
 *
 * ```text
 * iso = baseOpen(3BB)
 *     + perLimper(1BB) × limperCount
 *     + position(BTN +0.5 / 后位 +0.25 / 前位 −0.25)
 *     + stickiness(对手越黏 +0.5BB/黏度档)
 *     + stackAdj(有效筹码 < 40BB ⇒ −0.5；> 150BB ⇒ +0.5)
 * ```
 *
 * 然后截断到合法范围（最小值 = 最小加注额；最大值 = 有效筹码）。
 * ⚠️ 没有任何「三 limp = 8BB」这类硬编码：人数、位置、黏度、筹码都是输入。
 */
export function isoRaiseSizeOf(input: {
  limperCount: number;
  heroPosition: Position;
  /** 对手黏度 0..1（由 limp-call 倾向合成） */
  stickiness: number;
  /** 有效筹码（BB） */
  effectiveStackBB: number;
  /** 最小加注到（BB） */
  minRaiseToBB: number;
}): IsoSizeBreakdown {
  const baseOpen = 3;
  const perLimper = 1;
  const positionAdj = input.heroPosition === Position.BTN ? 0.5 : input.heroPosition === Position.CO ? 0.25 : input.heroPosition === Position.SB ? 0 : -0.25;
  const stickinessAdj = Math.max(0, Math.min(1, input.stickiness)) * 1;
  const stackAdj = input.effectiveStackBB < 40 ? -0.5 : input.effectiveStackBB > 150 ? 0.5 : 0;
  const raw = baseOpen + perLimper * input.limperCount + positionAdj + stickinessAdj + stackAdj;
  const capped = Math.max(0, Math.min(input.effectiveStackBB, raw));
  const legal = Math.max(input.minRaiseToBB, capped);
  return Object.freeze({
    requestedIsoSize: raw,
    legalIsoSize: legal,
    limperCount: input.limperCount,
    components: Object.freeze({
      baseOpen,
      perLimperTotal: perLimper * input.limperCount,
      positionAdj,
      stickinessAdj,
      stackAdj,
    }),
    noteZh:
      `隔离尺寸：底 ${baseOpen}BB + ${input.limperCount}×${perLimper}BB（人数）` +
      `${positionAdj >= 0 ? ' + ' : ' − '}${Math.abs(positionAdj)}BB（位置 ${input.heroPosition}）` +
      ` + ${stickinessAdj.toFixed(2)}BB（对手黏度）${stackAdj >= 0 ? ' + ' : ' − '}${Math.abs(stackAdj)}BB（筹码深度）` +
      ` = ${raw.toFixed(2)}BB ⇒ 请求 ${legal.toFixed(2)}BB` +
      `（最小加注 ${input.minRaiseToBB}BB，有效筹码 ${input.effectiveStackBB}BB；` +
      '⚠️ 还要对齐**合法尺寸网格**才算最终加注额，见事实包 legalIsoSize）',
  });
}

/* ============================================================
 * ⑤ 身后玩家风险（SB/BB 也进比较，不只进文案）
 * ============================================================ */

export type PlayersBehindRisk = {
  /** 跟注路径：被 squeeze / 被 overlimp / 多路膨胀 */
  squeezeRisk: number;
  overlimpRisk: number;
  multiwayExpansionRisk: number;
  /** 加注路径：冷跟 / 冷 3bet / 冷 4bet */
  coldCallRisk: number;
  cold3betRisk: number;
  cold4betRisk: number;
  noteZh: string;
};

/**
 * 身后玩家风险（**作用于不同动作**，不是「有人凶 ⇒ 加注加分」这种单一加成）。
 *
 * 【启发式】结构性刻度：由「身后人数 × 其画像倾向 × 筹码深度」合成；
 * 没有画像时用位置群体先验（SB 偏紧、BB 普通）。
 */
export function playersBehindRiskOf(input: {
  behind: readonly { position: Position; archetype: LimperArchetype; confidence: number; effectiveStackBB: number }[];
}): PlayersBehindRisk {
  let squeeze = 0;
  let overlimp = 0;
  let coldCall = 0;
  let cold3bet = 0;
  for (const p of input.behind) {
    const t = effectiveTraits({ position: p.position, archetype: p.archetype, confidence: p.confidence });
    const shortStackBoost = p.effectiveStackBB < 40 ? 1.3 : 1;
    squeeze += 0.05 * t.reraise * shortStackBoost;
    overlimp += 0.05 * t.call;
    coldCall += 0.07 * t.call;
    cold3bet += 0.04 * t.reraise * shortStackBoost;
  }
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
  const anyReraiseBehind = clamp01(squeeze);
  const cold3 = clamp01(cold3bet);
  return Object.freeze({
    squeezeRisk: clamp01(squeeze),
    overlimpRisk: clamp01(overlimp),
    multiwayExpansionRisk: clamp01(overlimp * 0.8),
    coldCallRisk: clamp01(coldCall),
    cold3betRisk: cold3,
    cold4betRisk: clamp01(cold3 * 0.5),
    noteZh:
      `身后风险：squeeze ${(clamp01(squeeze) * 100).toFixed(1)}%｜overlimp ${(clamp01(overlimp) * 100).toFixed(1)}%｜` +
      `cold-call ${(clamp01(coldCall) * 100).toFixed(1)}%｜cold-3bet ${(cold3 * 100).toFixed(1)}%｜` +
      `cold-4bet ${(clamp01(cold3 * 0.5) * 100).toFixed(1)}%（${input.behind.length} 家未行动）` +
      (anyReraiseBehind > 0 ? '' : ''),
  });
}

/* ============================================================
 * ⑥ 隔离加注 EV（与 CALL 同一零点：弃牌 ≡ 0）
 * ============================================================ */

export type IsoRaiseEV = {
  proxyEV: number | null;
  allFoldContribution: number | null;
  callersContribution: number | null;
  reraiseContribution: number | null;
  heroInvestment: number;
  playersBehindAdjustment: number;
  assumptionsZh: readonly string[];
  rakeStatus: 'NOT_IMPLEMENTED';
  noteZh: string;
};

/**
 * 隔离加注的**代理 EV**（同一零点：弃牌 ≡ 0，单位 = 筹码）。
 *
 * ```text
 * EV_iso = P(all fold) × 当前底池
 *        + Σ_k P(k 家跟) × [eq_k × (底池 + R + k×Δ) − R]
 *        + P(任一再加注) × [eq_rr × (底池 + 2×R) − R]     ← 被再加注时按放弃处理（Hero 不继续）
 *        − cold-3bet 风险 × R                              ← 身后冷 3bet 的代价（简化）
 * ```
 *
 * 其中 `Δ = R − 跟注者本街已投入` = 跟注者**还要再投入**的筹码。
 *
 * 🔴 **`Δ` 不是 `R`**：跛入者已经把 1BB 放进底池了，那个 2 筹码**已经在
 * 「底池」里**。若按每个跟注者再加 `R` 计，等于把他们的已投入算两遍 ——
 * 实测该节点会被虚增约 1–2 筹码。修复前本函数用的正是 `2R + (k−1)R`。
 *
 * ⚠️ 使用：对「limp-call 范围」的多人权益（由调用方用**真实范围**算好传入，
 * **不得**用到达范围权益）、`realizationFactor` = 1（翻前不进翻后实现模型）、
 * 位置 = 见尺寸模型、**Rake 未实现**。
 */
export function isoRaiseEVOf(input: {
  potChips: number;
  isoRaiseChips: number;
  /**
   * 每个跟注者**还要再投入**的筹码（= 加注额 − 他本街已投入）。
   * 多家不完全相同时用其均值（`ponytail:` 单值近似，需要精确时改成逐家数组）。
   */
  callerAddsChips: number;
  joint: JointResponses;
  /** 对 1 个跟注者范围的权益 */
  equityVsOneCaller: number | null;
  /** 对 3 个跟注者范围的权益（用于插值） */
  equityVsThreeCallers: number | null;
  /** 对被再加注范围的权益（被再加注时按「不再继续」处理，此值仅供 debug） */
  equityVsReraise: number | null;
  playersBehind: PlayersBehindRisk;
}): IsoRaiseEV {
  const pot = input.potChips;
  const raise = input.isoRaiseChips;
  const eq1 = input.equityVsOneCaller;
  const eq3 = input.equityVsThreeCallers;
  const eq2 = eq1 === null || eq3 === null ? null : (eq1 + eq3) / 2;

  const allFoldContribution = input.joint.allFold * pot;

  const callerBranch = (k: number, eq: number | null): number | null =>
    eq === null ? null : eq * (pot + raise + k * input.callerAddsChips) - raise;

  const c1 = callerBranch(1, eq1);
  const c2 = callerBranch(2, eq2);
  const c3 = callerBranch(3, eq3);
  const callersContribution =
    c1 === null || c2 === null || c3 === null
      ? null
      : input.joint.oneCaller * c1 + input.joint.twoCallers * c2 + input.joint.threeCallers * c3;

  // 被再加注：Hero 放弃 ⇒ 损失本街投入
  const reraiseContribution = -input.joint.anyReraise * raise;

  const playersBehindAdjustment = -input.playersBehind.cold3betRisk * raise;

  const proxyEV =
    callersContribution === null ? null : allFoldContribution + callersContribution + reraiseContribution + playersBehindAdjustment;

  return Object.freeze({
    proxyEV,
    allFoldContribution,
    callersContribution,
    reraiseContribution,
    heroInvestment: raise,
    playersBehindAdjustment,
    assumptionsZh: Object.freeze([
      '使用范围：limp-call 条件范围（按 limp 到达范围 × 响应模型切出），**不是**到达范围',
      '权益实现因子 = 1（翻前不套用翻后实现模型）',
      '位置：已进入隔离尺寸（BTN/CO 加分）与响应价格，未单独作为 EV 项',
      `跟注者本次投入按 ${input.callerAddsChips.toFixed(1)} 筹码计（= 加注额 − 其本街已投入；不再把已投入算两遍）`,
      '多人权益：对 1 家与 3 家分别计算、2 家线性插值（HEURISTIC）',
      '被再加注：按 Hero 不再继续处理（损失本街投入）',
      '身后玩家：cold-3bet 风险按 −风险×投入 计入',
      'RAKE = NOT_IMPLEMENTED（未计抽水）',
    ]),
    rakeStatus: 'NOT_IMPLEMENTED',
    noteZh:
      `EV_iso（代理，零点 = 当前决策点）= 全弃 ${input.joint.allFold.toFixed(3)}×${pot.toFixed(1)}` +
      ` + 跟注分支 ${callersContribution === null ? '—' : callersContribution.toFixed(2)}` +
      ` + 再加注分支 ${reraiseContribution.toFixed(2)} + 身后修正 ${playersBehindAdjustment.toFixed(2)}` +
      ` ⇒ ${proxyEV === null ? '—（缺条件范围权益）' : proxyEV.toFixed(2) + ' 筹码'}｜RAKE = NOT_IMPLEMENTED`,
  });
}
