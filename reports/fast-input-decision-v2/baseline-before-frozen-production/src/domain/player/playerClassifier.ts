/**
 * 玩家分类：连续维度 + 标签摘要 + 概率调整（Step 6，规范第十九 / 二十节）
 *
 * ## 两条不可违背的约束
 *
 * 1. **标签只是摘要，底层永远是连续值**（规范第十九节）。
 *    「紧凶」是一个便于人读的概括；真正驱动计算的是
 *    `rangeWidthFactor / aggressionFactor / bluffFactor` 这些连续量。
 *
 * 2. **画像绝不直接决策**（规范第二十节）。
 *    禁止 `Nit → Fold`、`Calling Station → Bet`。
 *    画像**只允许**修改 Range 权重与 Action Likelihood，
 *    最终动作由 Decision Engine 决定（Phase 8）。
 *    因此本文件输出的类型里**没有任何动作字段** —— 这是刻意的架构约束。
 *
 * ## 样本保护贯穿其中
 * 样本不足时：标签强制为「未知玩家」，所有调整因子强制为 1（即「不做任何调整」）。
 */

import {
  METRIC_DEFINITIONS,
  PlayerMetric,
  type MetricStat,
  type PriorSource,
} from './player.types.ts';
import { SampleTier, sampleTier, type TierThresholds } from './playerStats.ts';
import type { PlayerProfile as Profile } from './playerProfile.ts';

/* ============================================================
 * 标签与维度
 * ============================================================ */

/** 中文标签（规范第十九节列出的 11 种） */
export const PlayerLabel = {
  UNKNOWN: 'UNKNOWN',
  TIGHT_PASSIVE: 'TIGHT_PASSIVE',
  TIGHT_AGGRESSIVE: 'TIGHT_AGGRESSIVE',
  LOOSE_PASSIVE: 'LOOSE_PASSIVE',
  LOOSE_AGGRESSIVE: 'LOOSE_AGGRESSIVE',
  CALLING_STATION: 'CALLING_STATION',
  BLUFF_HEAVY: 'BLUFF_HEAVY',
  BLUFF_LIGHT: 'BLUFF_LIGHT',
  ULTRA_TIGHT: 'ULTRA_TIGHT',
  REG_AVERAGE: 'REG_AVERAGE',
  REG_STRONG: 'REG_STRONG',
} as const;
export type PlayerLabel = (typeof PlayerLabel)[keyof typeof PlayerLabel];

/**
 * 连续维度。
 *
 * 每个维度都是 0..1 的连续量，1 表示「该倾向最强」。
 * 阈值只用于**生成标签**，不用于生成调整因子 ——
 * 调整因子直接由连续量计算，因此不会因为恰好跨过某个阈值而突变。
 */
export type PlayerDimensions = {
  /** 紧（1）↔ 松（0）：由入池率决定 */
  tightness: number;
  /** 凶（1）↔ 弱（0）：由主动加注率相对于入池率的比值决定 */
  aggression: number;
  /** 诈唬多（1）↔ 诈唬少（0） */
  bluffTendency: number;
  /** 被动跟注（1）↔ 主动弃牌（0） */
  passivity: number;
  /** 综合可信度 0..1 */
  confidence: number;
  /** 参与计算的指标样本量 */
  sampleSize: number;
  /** 样本分层 */
  tier: SampleTier;
};

/* ============================================================
 * 概率调整（只影响 Range / Likelihood）
 * ============================================================ */

/**
 * 画像带来的概率调整因子。
 *
 * ⚠️ **刻意不含任何动作字段**。
 * 所有因子都是「乘性调整」，1 表示不调整：
 * - `rangeWidthFactor > 1` → 对手范围更宽（更多弱牌）
 * - `bluffWeightFactor > 1` → 对手诈唬权重更高
 * - `valueWeightFactor > 1` → 对手价值牌权重更高
 * - `callingThresholdFactor > 1` → 对手更愿意跟注（我们减少诈唬）
 * - `foldToAggressionFactor > 1` → 对手更容易弃牌（我们可增加诈唬）
 */
export type ProfileAdjustment = {
  rangeWidthFactor: number;
  bluffWeightFactor: number;
  valueWeightFactor: number;
  callingThresholdFactor: number;
  foldToAggressionFactor: number;
  /** 调整的可信度（= 画像置信度；样本不足时为 0） */
  confidence: number;
  /** 调整依据的连续维度 */
  dimensions: PlayerDimensions;
};

/** 无调整（未知玩家 / 样本不足） */
export function neutralAdjustment(dimensions: PlayerDimensions): ProfileAdjustment {
  return {
    rangeWidthFactor: 1,
    bluffWeightFactor: 1,
    valueWeightFactor: 1,
    callingThresholdFactor: 1,
    foldToAggressionFactor: 1,
    confidence: 0,
    dimensions,
  };
}

/* ============================================================
 * 维度计算
 * ============================================================ */

/**
 * 入池率维度的定标端点（`tightness = 1` 对应 VPIP = 0，`tightness = 0` 对应 VPIP = VPIP_SCALE）。
 *
 * ## 为什么必须锚定到**先验中心**
 *
 * 维度是给「调整因子」用的，因此它的**中立点必须恰好是「与先验一致」**。
 * 否则会出现红队实测到的荒谬情形：
 *
 * > 一个打法**全程不变**、恰好等于项目自述常客中心（VPIP 25%）的玩家，
 * > 仅仅因为攒了更多手数，`rangeWidthFactor` 就从 1.0000 漂到 0.9644。
 * > 而**完全没数据的陌生人**反而是中立的。
 *
 * 也就是说「先验」被当成了「观测」。根因是旧版把中立点取在
 * `VPIP_SCALE / 2 = 0.275`，而先验中心是 0.25 —— 两者不一致。
 *
 * 现在中立点由先验中心**推导**得到（`2 × prior.center`），
 * 因此「先验中心 → 维度 0.5 → 调整因子 1」这条链是恒等式，
 * 有专门的表驱动测试锁定。
 */
function vpipScale(): number {
  return 2 * METRIC_DEFINITIONS[PlayerMetric.VPIP].prior.center;
}

/** 入池率 → 紧度维度（1 = 极紧，0 = 极松；**先验中心恰好映射到 0.5**） */
export function tightnessFromVpip(vpipRate: number): number {
  const clamped = Number.isFinite(vpipRate) ? Math.max(0, Math.min(1, vpipRate)) : 0;
  const scale = vpipScale();
  if (!(scale > 0)) return 0.5;
  return Math.max(0, Math.min(1, 1 - clamped / scale));
}

/** 紧度维度 → 入池率（与 tightnessFromVpip 严格互逆） */
export function vpipRateOf(tightness: number): number {
  const clamped = Number.isFinite(tightness) ? Math.max(0, Math.min(1, tightness)) : 0;
  return Math.max(0, Math.min(1, (1 - clamped) * vpipScale()));
}

/** 先验中心对应的入池率（中立点，供测试与 UI 引用） */
export function neutralVpipRate(): number {
  return METRIC_DEFINITIONS[PlayerMetric.VPIP].prior.center;
}

/** 把 0..1 的比率线性映射到 [-1, 1]，中心为 center */
function relativeToCenter(rate: number, center: number): number {
  if (!(center > 0 && center < 1)) return 0;
  const raw = (rate - center) / (rate >= center ? 1 - center : center);
  return Math.max(-1, Math.min(1, raw));
}

/** 取指标的调整后比率；无样本时返回 null */
function rateOf(profile: Profile, metric: PlayerMetric): number | null {
  const stat: MetricStat = profile.metrics[metric];
  if (stat.opportunities === 0) return null;
  return stat.adjustedRate;
}

/** 加权平均（忽略 null） */
function weightedAverage(entries: Array<{ value: number | null; weight: number }>): number | null {
  let sum = 0;
  let totalWeight = 0;
  for (const entry of entries) {
    if (entry.value === null) continue;
    sum += entry.value * entry.weight;
    totalWeight += entry.weight;
  }
  return totalWeight > 0 ? sum / totalWeight : null;
}

/**
 * 由画像计算连续维度。
 *
 * 关键点：**每个维度都由它自己的样本量支撑** ——
 * 500 手总样本不等于河牌超池样本 500（规范第十五节）。
 */
export function computeDimensions(
  profile: Profile,
  thresholds: TierThresholds | undefined = undefined,
): PlayerDimensions {
  // ---- 紧松：以 VPIP 为主 ----
  const vpip = rateOf(profile, PlayerMetric.VPIP);
  const vpipPrior = METRIC_DEFINITIONS[PlayerMetric.VPIP].prior;
  const tightness = vpip === null ? tightnessFromVpip(vpipPrior.center) : tightnessFromVpip(vpip);

  // ---- 凶弱：PFR / VPIP 比值（相对基线比值） ----
  const pfr = rateOf(profile, PlayerMetric.PFR);
  const aggressionRatio = vpip !== null && vpip > 0 && pfr !== null ? pfr / vpip : null;
  const baselineRatio =
    METRIC_DEFINITIONS[PlayerMetric.PFR].prior.center / METRIC_DEFINITIONS[PlayerMetric.VPIP].prior.center;
  const aggression =
    aggressionRatio === null ? 0.5 : 0.5 + relativeToCenter(Math.min(1, aggressionRatio), Math.min(1, baselineRatio)) / 2;

  // ---- 诈唬倾向：3Bet + 面对下注加注率 ----
  //
  // ⚠️ 没有机会时必须返回**中立 0.5**，而不是让 adjustedRate 落在先验中心后
  // 算出「偏向诈唬少」。先验中心本身偏向保守（3Bet 约 7%、加注约 15%），
  // 若把「没数据」当证据，一个完全没有 3Bet 机会的玩家会被贴成
  // 「很少诈唬」—— 这是把先验伪装成观测，属于编造。
  const threeBet = rateOf(profile, PlayerMetric.THREE_BET);
  const raiseCbet = rateOf(profile, PlayerMetric.RAISE_CBET);
  const hasBluffEvidence =
    profile.metrics[PlayerMetric.THREE_BET].opportunities > 0 ||
    profile.metrics[PlayerMetric.RAISE_CBET].opportunities > 0;
  const aggressionForBluff = weightedAverage([
    { value: threeBet, weight: 2 },
    { value: raiseCbet, weight: 1 },
  ]);
  const bluffBaseline = weightedAverage([
    { value: METRIC_DEFINITIONS[PlayerMetric.THREE_BET].prior.center, weight: 2 },
    { value: METRIC_DEFINITIONS[PlayerMetric.RAISE_CBET].prior.center, weight: 1 },
  ])!;
  const bluffTendency =
    !hasBluffEvidence || aggressionForBluff === null
      ? 0.5
      : 0.5 + relativeToCenter(aggressionForBluff, bluffBaseline) / 2;

  // ---- 被动跟注：面对下注时跟注 vs 弃牌 ----
  //
  // ⚠️ 必须做先验定标，与上面的 `aggression` 用**同一套** `relativeToCenter`。
  // 红队实测：旧版直接返回「跟注 / (跟注 + 弃牌)」的原始比值，
  // 而 CALL_CBET / FOLD_TO_CBET 的先验是 0.40 / 0.45 → 比值 0.4706 ≠ 0.5。
  // 于是一个「打法恰好等于项目自述常客中心」的玩家得到 passivity = 0.4705，
  // 而**完全没数据的陌生人**却是 0.5 —— 又是「先验被当成观测」。
  // 正确做法就在同一个函数里（bluffTendency 做了 relativeToCenter，
  // 偏差仅 -0.0035），此处照做。
  const callCbet = rateOf(profile, PlayerMetric.CALL_CBET);
  const foldCbet = rateOf(profile, PlayerMetric.FOLD_TO_CBET);
  const passiveDenominator = callCbet !== null && foldCbet !== null ? callCbet + foldCbet : null;
  const callShare = passiveDenominator && passiveDenominator > 0 ? callCbet! / passiveDenominator : null;
  const passiveBaseline = (() => {
    const callPrior = METRIC_DEFINITIONS[PlayerMetric.CALL_CBET].prior.center;
    const foldPrior = METRIC_DEFINITIONS[PlayerMetric.FOLD_TO_CBET].prior.center;
    const sum = callPrior + foldPrior;
    return sum > 0 ? callPrior / sum : 0.5;
  })();
  const passivity =
    callShare === null ? 0.5 : 0.5 + relativeToCenter(Math.min(1, callShare), Math.min(1, passiveBaseline)) / 2;

  // ---- 可信度与样本量 ----
  const coreStats = [
    profile.metrics[PlayerMetric.VPIP],
    profile.metrics[PlayerMetric.PFR],
  ];
  const confidence = Math.max(...coreStats.map((s) => s.confidence), 0);
  const sampleSize = Math.min(...coreStats.map((s) => s.effectiveSampleSize));
  const tier = sampleTier(confidence > 0 ? sampleSize : 0, thresholds);

  return {
    tightness: clamp01(tightness),
    aggression: clamp01(aggression),
    bluffTendency: clamp01(bluffTendency),
    passivity: clamp01(passivity),
    confidence,
    sampleSize,
    tier,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

/* ============================================================
 * 标签（摘要）
 * ============================================================ */

export type LabelThresholds = {
  /** 极紧：入池率（VPIP）低于该值 */
  ultraTightVpip: number;
  /** 紧：入池率低于该值 */
  tightVpip: number;
  /** 松：入池率不低于该值 */
  looseVpip: number;
  /** 凶 / 弱的分界（凶度维度） */
  aggressive: number;
  /** 诈唬多 / 少的分界（诈唬倾向维度） */
  bluffHeavy: number;
  bluffLight: number;
  /** 跟注站：被动度不低于该值 */
  callingStationPassivity: number;
  /** 跟注站：入池率不低于该值 */
  callingStationVpip: number;
};

/**
 * 标签阈值。
 *
 * ⚠️ **单位必须统一**：三个入池相关阈值都是「入池率（VPIP）本身」，
 * 与 `computeDimensions` 内部的紧度维度**不是**同一个量。
 * 早先版本把「松的阈值」与紧度维度直接比较，导致阈值改了也不生效
 * （紧度 0.6 永远小于 0.95）—— 这是本轮修掉的真实 Bug。
 * 因此这里通过 `vpipRateOf` 把维度反解回入池率再比较。
 * 由于 `tightnessFromVpip` / `vpipRateOf` 是严格互逆的线性定标，
 * 反解是精确的（不是近似）。
 */
export const DEFAULT_LABEL_THRESHOLDS: LabelThresholds = {
  ultraTightVpip: 0.14,
  tightVpip: 0.22,
  looseVpip: 0.32,
  aggressive: 0.6,
  bluffHeavy: 0.65,
  bluffLight: 0.35,
  callingStationPassivity: 0.7,
  callingStationVpip: 0.32,
};

/**
 * 由连续维度生成标签。
 *
 * 判定顺序刻意从「最特征化」到「最一般化」：
 * 跟注站 > 诈唬倾向 > 紧松 × 凶弱 > 普通常客。
 * 这样「又松又被动又爱跟注」的玩家得到「跟注站」而不是「松弱型」——
 * 后者丢失了「他几乎不弃牌」这个最关键的针对性信息。
 */
export function deriveLabel(
  dimensions: PlayerDimensions,
  thresholds: LabelThresholds = DEFAULT_LABEL_THRESHOLDS,
  hasEnoughSample = true,
): PlayerLabel {
  // 样本不足 → 强制未知，绝不贴标签（规范第十三 / 二十五节）
  if (!hasEnoughSample || dimensions.tier === SampleTier.PRELIMINARY) {
    return PlayerLabel.UNKNOWN;
  }

  const { aggression, bluffTendency, passivity } = dimensions;
  const vpip = vpipRateOf(dimensions.tightness);

  // 跟注站：高被动 + 入池偏高
  if (passivity >= thresholds.callingStationPassivity && vpip >= thresholds.callingStationVpip) {
    return PlayerLabel.CALLING_STATION;
  }
  // 诈唬倾向极端时单独标出（比紧松维度更有针对性价值）
  if (bluffTendency >= thresholds.bluffHeavy && aggression >= thresholds.aggressive) {
    return PlayerLabel.BLUFF_HEAVY;
  }
  if (bluffTendency <= thresholds.bluffLight && vpip <= thresholds.tightVpip) {
    return PlayerLabel.BLUFF_LIGHT;
  }
  // 入池率极低
  if (vpip < thresholds.ultraTightVpip) return PlayerLabel.ULTRA_TIGHT;

  const isLoose = vpip >= thresholds.looseVpip;
  const isTight = vpip < thresholds.tightVpip;
  const isAggressive = aggression >= thresholds.aggressive;

  if (isTight && isAggressive) return PlayerLabel.TIGHT_AGGRESSIVE;
  if (isTight && !isAggressive) return PlayerLabel.TIGHT_PASSIVE;
  if (isLoose && isAggressive) return PlayerLabel.LOOSE_AGGRESSIVE;
  if (isLoose && !isAggressive) return PlayerLabel.LOOSE_PASSIVE;

  return isAggressive ? PlayerLabel.REG_STRONG : PlayerLabel.REG_AVERAGE;
}

/* ============================================================
 * 调整因子（连续，不依赖阈值）
 * ============================================================ */

/**
 * 由连续维度计算概率调整因子。
 *
 * 设计原则：**用连续量而不是标签**。
 * 因此「刚好跨过紧凶阈值」与「差一点跨过」得到的调整几乎相同，
 * 不会出现「标签跳变导致建议突变」。
 *
 * 因子强度上限刻意保守（±40%），因为这些都是**启发式**调整，
 * 没有真实人口统计数据支撑（规范第十四节）。
 */
export const MAX_ADJUSTMENT = 0.4;

export function computeAdjustment(
  dimensions: PlayerDimensions,
  options: { hasEnoughSample?: boolean } = {},
): ProfileAdjustment {
  const hasEnoughSample = options.hasEnoughSample ?? dimensions.tier !== SampleTier.PRELIMINARY;
  if (!hasEnoughSample || dimensions.confidence <= 0) {
    return neutralAdjustment(dimensions);
  }

  const { tightness, aggression, bluffTendency, passivity, confidence } = dimensions;
  const looseness = 1 - tightness;

  // 以 0.5 为中立点，映射到 [-1, 1]
  const loose = (looseness - 0.5) * 2;
  const aggro = (aggression - 0.5) * 2;
  const bluff = (bluffTendency - 0.5) * 2;
  const passive = (passivity - 0.5) * 2;

  // 用指数形式保证乘性因子的对称性：exp(±x) 与 exp(∓x) 互为倒数
  const factor = (value: number): number =>
    Math.exp(MAX_ADJUSTMENT * confidence * Math.max(-1, Math.min(1, value)));

  return {
    // 越松 → 范围越宽
    rangeWidthFactor: factor(loose * 1.0),
    // 越爱诈唬 → 诈唬权重越高
    bluffWeightFactor: factor(bluff * 1.0),
    // 越紧越凶 → 价值牌权重越高（紧凶型下注往往真有牌）
    valueWeightFactor: factor((tightness * 0.5 + aggression * 0.5 - 0.5) * 2 * 0.8),
    // 越被动 → 越愿意跟注（我们应该减少诈唬）
    callingThresholdFactor: factor(passive * 1.0),
    // 越被动/越松 → 越不容易弃牌，我们的诈唬越没用
    foldToAggressionFactor: factor(-passive * 1.2),
    confidence,
    dimensions,
  };
}

/* ============================================================
 * 便捷入口
 * ============================================================ */

export type PlayerRead = {
  playerId: string;
  label: PlayerLabel;
  dimensions: PlayerDimensions;
  adjustment: ProfileAdjustment;
  /** 各项指标的样本情况（供 UI 展示「样本不足」） */
  sampleNote: { totalHands: number; tier: SampleTier };
  /** 先验来源（透明化：绝不允许冒充理论） */
  priorSources: PriorSource[];
};

/**
 * 按一个额外的可信度因子缩放画像调整强度。
 *
 * ## 用途
 *
 * 牌局环境本身带有可信度（启发式配置刻意压低）。把「环境」与
 * 「玩家画像」两层修正组合时，**必须**让组合后的调整强度反映
 * 两层中较弱的那一层 —— 否则一个高度可信的画像会掩盖
 * 「环境配置其实只是猜测」这件事。
 *
 * 做法：只缩放 `confidence`，**不触碰任何维度**。
 * 因此调整的**方向**永远由观测数据决定，环境只能影响**幅度**。
 * 这条性质有测试锁定。
 *
 * @param scale 额外的可信度因子，会被夹到 [0, 1]
 */
export function scaleAdjustmentConfidence(
  adjustment: ProfileAdjustment,
  scale: number,
): ProfileAdjustment {
  if (!Number.isFinite(scale)) return adjustment;
  const clamped = Math.max(0, Math.min(1, scale));
  if (clamped >= 1) return adjustment;
  return { ...adjustment, confidence: adjustment.confidence * clamped };
}

export function readPlayer(
  profile: Profile,
  options: {
    tierThresholds?: TierThresholds;
    labelThresholds?: LabelThresholds;
    /** 禁用调整（例如理论参考模式） */
    neutral?: boolean;
  } = {},
): PlayerRead {
  const dimensions = computeDimensions(profile, options.tierThresholds);
  const hasEnoughSample = dimensions.tier !== SampleTier.PRELIMINARY;
  const label = deriveLabel(dimensions, options.labelThresholds ?? DEFAULT_LABEL_THRESHOLDS, hasEnoughSample);
  const adjustment = options.neutral
    ? neutralAdjustment(dimensions)
    : computeAdjustment(dimensions, { hasEnoughSample });

  const priorSources = [...new Set(Object.values(METRIC_DEFINITIONS).map((d) => d.prior.source))];

  return {
    playerId: profile.playerId,
    label,
    dimensions,
    adjustment,
    sampleNote: { totalHands: profile.handsObserved, tier: dimensions.tier },
    priorSources,
  };
}

export { PlayerMetric };
