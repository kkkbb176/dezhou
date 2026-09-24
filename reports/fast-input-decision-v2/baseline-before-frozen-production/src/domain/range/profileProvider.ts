/**
 * Player Profile → Range Engine 的桥接（Step 6，规范第二十六 / 二十八节）
 *
 * ## 本文件存在的唯一理由
 *
 * 规范第二十节的禁令：**画像绝不直接决策**。
 * 因此画像不能返回「弃牌」，只能通过 `RangeAdjustmentProvider`
 * 这个既有接口去改 **combo 权重** 与 **动作似然**。
 * 决策由 Decision Engine 在拿到调整后的范围与似然后再做。
 *
 * ## 三条硬约束
 *
 * 1. **只调整概率，不产生动作**。
 *    本文件导出的类型里没有任何 `Action` 字段。
 *
 * 2. **可解释**：每次调整都记录 stats（应用到多少个 combo、平均因子、
 *    最强/最弱因子），UI 必须能说清「为什么这个范围被调宽了 12%」。
 *
 * 3. **样本不足 → 完全不动**（因子恒为 1）。
 *    3 手 100% 入池绝不允许改变任何范围权重。
 *
 * ## 中性化（几何均值归一）
 *
 * 加权调整在归一化之后会抵消整体缩放，因此若不加处理，
 * 「所有因子的几何均值 ≠ 1」会让调整后的似然整体偏移（系统性偏差）。
 * 本文件的做法：先算出全部因子，再除以几何均值，使调整**只改变分布形状**。
 */

import {
  RangeAction,
  RangeSource,
  type ActionLikelihood,
  type RangeAdjustmentProvider,
  type RangeUpdateContext,
} from './range.types.ts';
import { comboById, type ExactCombo } from './combo.ts';
import { potentialOfComboId, weaknessOf, comboPotential } from './handPotential.ts';
import type { ProfileAdjustment } from '../player/playerClassifier.ts';
import { MAX_ADJUSTMENT, scaleAdjustmentConfidence } from '../player/playerClassifier.ts';
import {
  assertValidEnvironmentProfile,
  effectiveAdjustment,
  environmentDeltaNote,
  type EnvironmentAdjustment,
  type GameEnvironmentProfile,
} from './gameEnvironment.ts';

/* ============================================================
 * 配置
 * ============================================================ */

export type ProfileProviderConfig = {
  providerId: string;
  /**
   * 受调整影响的最小可信度。
   * 低于它则**完全不做调整**（返回恒等因子），而不是「按比例缩小」——
   * 后者会让低可信画像持续注入噪声。
   */
  minConfidence: number;
  /**
   * 单因子上下限（防止某个维度极端时把似然压成 0 或放大到荒谬）。
   * 这是**工程护栏**，不是理论数值。
   */
  minFactor: number;
  maxFactor: number;
  /**
   * 弱牌/强牌分界（potential 低于该值算弱牌、高于互补值算强牌，
   * 中间为「中等牌」不参与两端调整）。
   */
  weakBelow: number;
  strongAbove: number;
};

export const DEFAULT_PROVIDER_CONFIG: ProfileProviderConfig = {
  providerId: 'profile.range.adjustment.v1',
  minConfidence: 0.2,
  minFactor: 0.2,
  maxFactor: 5,
  weakBelow: 0.35,
  strongAbove: 0.6,
};

/* ============================================================
 * 统计（可解释性）
 * ============================================================ */

export type AdjustmentStats = {
  providerId: string;
  /** 被**调用**的次数（含因子为 1 的） */
  adjustments: number;
  /** 因子**确实不等于 1** 的次数（真正改变了概率形状的量） */
  effectiveAdjustments: number;
  minFactor: number;
  maxFactor: number;
  meanFactor: number;
  /** 平均因子 < 1 表示范围被整体调窄，> 1 表示调宽 */
  direction: 'WIDENED' | 'NARROWED' | 'UNCHANGED';
  /** 是否因可信度不足而未做任何调整 */
  neutralized: boolean;
  /** 遇到的未知 comboId 次数（未知 → 不调整，绝不假装是中等牌） */
  unknownCombos: number;
};

export function emptyStats(providerId: string): AdjustmentStats {
  return {
    providerId,
    adjustments: 0,
    effectiveAdjustments: 0,
    minFactor: 1,
    maxFactor: 1,
    meanFactor: 1,
    direction: 'UNCHANGED',
    neutralized: true,
    unknownCombos: 0,
  };
}

/* ============================================================
 * 几何均值归一
 * ============================================================ */

/**
 * 把因子集合除以自身几何均值，使调整**只改变分布形状**。
 *
 * 例：[2, 2, 2, 0.5] 的几何均值 = (2·2·2·0.5)^(1/4) = 1，无需调整；
 * [2, 2, 2, 2] 的几何均值 = 2，归一后全部变 1（正确的：一致放大无意义）。
 */
export function neutralizeGeometric(factors: readonly number[]): number[] {
  const positive = factors.filter((f) => Number.isFinite(f) && f > 0);
  if (positive.length === 0) return factors.map(() => 1);
  let logSum = 0;
  for (const f of positive) logSum += Math.log(f);
  const logMean = logSum / positive.length;
  const scale = Math.exp(-logMean);
  return factors.map((f) => (Number.isFinite(f) && f > 0 ? f * scale : 1));
}

/* ============================================================
 * 连续 → 因子
 * ============================================================ */

type CenteredTraits = {
  loose: number;
  aggro: number;
  bluff: number;
  passive: number;
  weakHand: number;
  confidence: number;
};

/**
 * 从调整对象取出「以 0 为中立」的特征值。
 *
 * ⚠️ 刻意**不使用标签**，只用连续维度 ——
 * 否则「刚好跨过紧凶阈值」会让建议突变（规范第十九节）。
 */
function traitsOf(adjustment: ProfileAdjustment, weakness: number): CenteredTraits {
  const d = adjustment.dimensions;
  return {
    loose: (1 - d.tightness - 0.5) * 2,
    aggro: (d.aggression - 0.5) * 2,
    bluff: (d.bluffTendency - 0.5) * 2,
    passive: (d.passivity - 0.5) * 2,
    weakHand: weakness,
    confidence: adjustment.confidence,
  };
}

/** 有界乘性因子：exp(MAX·confidence·v)，v ∈ [−1, 1] */
function boundedFactor(value: number, confidence: number): number {
  const v = Math.max(-1, Math.min(1, value));
  return Math.exp(MAX_ADJUSTMENT * confidence * v);
}

/** 把一个因子夹到工程护栏之内 */
function clampFactor(factor: number, config: ProfileProviderConfig): number {
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return Math.max(config.minFactor, Math.min(config.maxFactor, factor));
}

/* ============================================================
 * Provider
 * ============================================================ */

export type ProfileRangeProvider = RangeAdjustmentProvider & {
  /** 上一次调整的统计（可解释性用；**只读**快照） */
  stats(): AdjustmentStats;
  /** 是否处于「不调整」状态（样本不足 / 被显式禁用） */
  isNeutral(): boolean;
  /** 供 UI 展示的中文一句话说明 */
  describe(): string;
};

/**
 * 单个组合的**未归一**调整因子（乘性，1 = 不调整）。
 *
 * ## 为什么刻意不做几何均值归一
 *
 * 几何均值归一是一个**全局**操作：它需要看到整个范围的全部因子。
 * 对**单个**组合做归一，几何均值恰好等于该因子本身，结果永远是 1 ——
 * 也就是说逐 combo 的 `adjustComboWeight` 会变成**完全无效**的空开关
 * （实测：真实画像下 38 个组合的因子全部返回 1，而同一份数据用批量版
 * 有 38 个因子被改变）。
 *
 * 因此这里明确分工：
 * - **逐 combo 版（本函数）**：返回未归一的原始因子。
 *   消费方是 `updateRange`，它自己会做对数域归一化，
 *   整体尺度在那里被自然吸收，不需要也不应该在这里归一。
 * - **批量版（`adjustComboWeightsBatch`）**：在数组上做几何均值归一，
 *   适用于「拿到一批组合、一次性算出形状」的场景。
 *
 * 两者使用**同一套**原始因子计算，因此方向完全一致（有测试锁定）。
 */
export function rawComboWeightFactor(
  combo: ExactCombo,
  adjustment: ProfileAdjustment,
  config: ProfileProviderConfig = DEFAULT_PROVIDER_CONFIG,
  environment?: EnvironmentAdjustment,
): number {
  if (adjustment.confidence < config.minConfidence) return 1;

  const d = adjustment.dimensions;
  const loose = (1 - d.tightness - 0.5) * 2;
  const aggro = (d.aggression - 0.5) * 2;
  const bluff = (d.bluffTendency - 0.5) * 2;
  const confidence = adjustment.confidence;

  const weakTilt = environment?.weakEndTilt ?? 1;
  const strongTilt = environment?.strongEndTilt ?? 1;

  const potential = potentialOfComboId(combo);
  const weakness = weaknessOf(potential);
  const mid = (config.weakBelow + config.strongAbove) / 2;

  let v = 0;
  if (potential < mid) {
    v = loose * weakTilt * (0.5 + 0.5 * Math.max(0, weakness)) + bluff * Math.max(0, weakness) * 0.8;
  } else {
    v = aggro * strongTilt * Math.max(0, -weakness) * 0.6;
  }
  return clampFactor(boundedFactor(v, confidence), config);
}

/**
 * 由画像调整构造 Range 调整提供者。
 *
 * @param adjustment 画像的连续调整因子（来自 `computeAdjustment`）
 * @param config 工程护栏
 */
export function createProfileRangeProvider(
  adjustment: ProfileAdjustment,
  config: ProfileProviderConfig = DEFAULT_PROVIDER_CONFIG,
): ProfileRangeProvider {
  return createProfileRangeProviderInternal(adjustment, config);
}

function createProfileRangeProviderInternal(
  adjustment: ProfileAdjustment,
  config: ProfileProviderConfig,
  environment?: EnvironmentAdjustment,
): ProfileRangeProvider {
  const neutral = adjustment.confidence < config.minConfidence;

  /**
   * 运行中的统计。
   *
   * ## 为什么必须是增量累加，而不是「读完就清空」（红队 MAJOR-9）
   *
   * 旧版在 `describe()` 里才调用 `finalize()`，而 `finalize()` 会
   * **清空** `collected` —— 即 `describe()` 是一次**破坏性读取**。
   * 后果：`updateRange` 调用完 provider 后，`provider.stats()` 返回
   * `{adjustments: 0, neutralized: true}`，而 `providerLog` 显示
   * 刚刚发生了 1326 次权重调整。两个「事实来源」互相矛盾。
   *
   * 现有测试恰好先调 `describe()` 再调 `stats()`，完全绕过了这个问题。
   *
   * 现在改为增量维护：任何时刻调 `stats()` 都返回**到目前为止**的真实累计，
   * `describe()` 是纯读取，不再有副作用。
   */
  let count = 0;
  let effectiveCount = 0;
  let minFactor = Number.POSITIVE_INFINITY;
  let maxFactor = 0;
  let sumFactor = 0;
  let unknownCombos = 0;

  const record = (factor: number): number => {
    const clamped = clampFactor(factor, config);
    count++;
    if (Math.abs(clamped - 1) > 1e-15) effectiveCount++;
    if (clamped < minFactor) minFactor = clamped;
    if (clamped > maxFactor) maxFactor = clamped;
    sumFactor += clamped;
    return clamped;
  };

  /** 读取当前累计统计（**纯读取**，不改变任何状态） */
  const snapshot = (): AdjustmentStats => {
    if (count === 0) {
      return { ...emptyStats(config.providerId), neutralized: neutral, unknownCombos };
    }
    const mean = sumFactor / count;
    return {
      providerId: config.providerId,
      adjustments: count,
      effectiveAdjustments: effectiveCount,
      minFactor,
      maxFactor,
      meanFactor: mean,
      direction: mean > 1.02 ? 'WIDENED' : mean < 0.98 ? 'NARROWED' : 'UNCHANGED',
      neutralized: false,
      unknownCombos,
    };
  };

  return {
    providerId: config.providerId,

    adjustComboWeight(combo: ExactCombo, _context: RangeUpdateContext): number {
      if (neutral) return 1;
      // ⚠️ 用「未归一」的原始因子。原因见 `rawComboWeightFactor` 的文档：
      // 对单个组合做几何均值归一，结果恒为 1，会让整个 provider 变成空开关
      // （实测：真实画像下 38 个组合全部返回 1）。
      // `updateRange` 自己会做对数域归一化，整体尺度在那里被自然吸收。
      return record(rawComboWeightFactor(combo, adjustment, config, environment));
    },

    adjustActionLikelihood(likelihood: ActionLikelihood, _context: RangeUpdateContext): number {
      if (neutral) return 1;
      const combo = comboById(likelihood.comboId);
      // 未知 comboId → 明确「不调整」，而不是假装它是中等牌（红队 MAJOR-10）
      if (!combo) {
        unknownCombos++;
        return UNKNOWN_COMBO_FACTOR;
      }
      const weakness = weaknessOf(comboPotential(combo));
      const t = traitsOf(adjustment, weakness);

      // 「进攻性动作」程度：CHECK 为最低，ALL_IN 为最高
      const aggressionOfAction: Record<RangeAction, number> = {
        [RangeAction.CHECK]: -0.6,
        [RangeAction.FOLD]: -0.4,
        [RangeAction.CALL]: -0.1,
        [RangeAction.BET]: 0.6,
        [RangeAction.RAISE]: 0.9,
        [RangeAction.ALL_IN]: 1.0,
      };
      const actionAggression = aggressionOfAction[likelihood.action] ?? 0;

      // 1. 凶弱：所有进攻动作一起放大/缩小
      const aggressionTilt = t.aggro * actionAggression * 0.9;

      // 2. 被动：CALL 上升；其中「跟注站」会让 FOLD 大幅下降
      const passiveTilt = t.passive * (likelihood.action === RangeAction.CALL ? 0.8 : 0);
      const foldTilt = t.passive * (likelihood.action === RangeAction.FOLD ? -1.2 : 0);

      // 3. 诈唬倾向：弱牌的进攻动作放大（他就是用弱牌进攻的人）
      const isAggressiveAction = actionAggression >= 0.6;
      const bluffTilt = isAggressiveAction ? t.bluff * Math.max(0, weakness) * 1.0 : 0;

      // 4. 价值倾向：强牌的进攻动作放大（紧凶型下注往往真有牌）
      const valueTilt = isAggressiveAction ? t.aggro * Math.max(0, -weakness) * 0.7 : 0;

      const factor = boundedFactor(
        aggressionTilt + passiveTilt + foldTilt + bluffTilt + valueTilt,
        t.confidence,
      );
      return record(factor);
    },

    stats: snapshot,
    isNeutral: () => neutral,
    describe: () => {
      // **纯读取**：不得改变任何状态（旧版在这里 finalize() 并清空累计，
      // 导致 updateRange 之后 stats() 返回全零 —— 红队 MAJOR-9）
      const current = snapshot();
      if (neutral) return '玩家样本不足，未对范围做任何调整';
      if (current.adjustments === 0) return '玩家画像尚未参与任何调整';
      switch (current.direction) {
        case 'WIDENED':
          return `依据玩家画像整体调宽范围（平均因子 ${current.meanFactor.toFixed(2)}）`;
        case 'NARROWED':
          return `依据玩家画像整体调窄范围（平均因子 ${current.meanFactor.toFixed(2)}）`;
        default:
          return '玩家画像未改变范围的整体宽窄';
      }
    },
  };
}

/* ============================================================
 * 组合级调整（一次性批量，便于归一化）
 * ============================================================ */

/**
 * 对一组组合**批量**求权重因子，并做几何均值归一。
 *
 * 与逐 combo 调用 `adjustComboWeight` 的区别：
 * - 批量版能算出正确的相对形状（几何均值归一）
 * - 返回的因子保证「没有任何一个 combo 被无条件放大」
 *
 * **仍然只调整权重，不产生任何动作。**
 *
 * @param environment 可选的环境有效调整。提供时，`weakEndTilt` /
 *   `strongEndTilt` 会用于放大或压缩范围的**强度梯度**。
 *   刻意**不**在这里乘 `rangeWidth`：整体缩放会被几何均值归一抵消，
 *   真正可观测的是梯度 —— 只调 rangeWidth 会让「环境」变成一个空开关。
 */
export function adjustComboWeightsBatch(
  combos: readonly ExactCombo[],
  adjustment: ProfileAdjustment,
  config: ProfileProviderConfig = DEFAULT_PROVIDER_CONFIG,
  environment?: EnvironmentAdjustment,
): { factors: number[]; stats: AdjustmentStats } {
  if (adjustment.confidence < config.minConfidence || combos.length === 0) {
    return {
      factors: combos.map(() => 1),
      stats: { ...emptyStats(config.providerId), neutralized: true },
    };
  }

  const d = adjustment.dimensions;
  const loose = (1 - d.tightness - 0.5) * 2;
  const aggro = (d.aggression - 0.5) * 2;
  const bluff = (d.bluffTendency - 0.5) * 2;
  const confidence = adjustment.confidence;

  const raw = combos.map((combo) => rawComboWeightFactor(combo, adjustment, config, environment));

  const factors = neutralizeGeometric(raw);
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let sum = 0;
  for (const f of factors) {
    if (f < min) min = f;
    if (f > max) max = f;
    sum += f;
  }
  const mean = sum / factors.length;
  const changes = factors.reduce((n, f) => n + (Math.abs(f - 1) > 1e-15 ? 1 : 0), 0);

  return {
    factors,
    stats: {
      providerId: config.providerId,
      // 批量版：统计**实际改变**的因子（归一化后必然有大量因子恰为 1，
      // 把它们计入会让「影响范围」被严重高估）
      adjustments: changes,
      effectiveAdjustments: changes,
      minFactor: min,
      maxFactor: max,
      meanFactor: mean,
      direction: mean > 1.02 ? 'WIDENED' : mean < 0.98 ? 'NARROWED' : 'UNCHANGED',
      neutralized: false,
      unknownCombos: 0,
    },
  };
}

/**
 * 未知 comboId 的调整因子。
 *
 * ## 为什么不静默退化为「中等牌」（红队 MAJOR-10）
 *
 * 旧版 `comboById()` 返回 `undefined` 时取 `weakness = 0`（中等牌），
 * 于是**任意**未知 id —— 包括拼错的、来自其他数据源的、越界的 —— 
 * 都会得到与「真正的中等牌」**逐位相同**的因子。
 * 实测：未知 id 与最弱牌 7c2d 的因子都是 1.209107044689271。
 *
 * 这违反「绝不静默修复坏数据」：我们应该**明确表示不知道**，
 * 而不是假装它是一手中等牌。
 *
 * 现在的语义：未知 comboId → **不调整**（因子 1），并计入统计的 `unknownCombos`。
 * 因子 1 是「没有信息」的正确表达，而「中等牌」是一种信息。
 */
export const UNKNOWN_COMBO_FACTOR = 1;

/* ============================================================
 * 与环境修正的组合
 * ============================================================ */

/**
 * 把「玩家画像」与「牌局环境」两层修正组合成一份调整对象。
 *
 * ## 组合方式（刻意选择）
 *
 * - **维度**：取玩家画像的维度，**原样不动**。
 *   调整的方向必须由**观测到的这个人**决定。环境只影响幅度。
 * - **可信度**：`玩家可信度 × 环境可信度`。
 *   两层中任何一层不可信，组合结果都不可信 —— 这是乘法的自然语义，
 *   也是唯一不会让「高可信画像掩盖低可信环境」的做法。
 *
 * 为什么不做「环境直接给一套维度」：那会让环境**覆盖**观测数据，
 * 于是「同一个对手」在不同环境里被描述成不同的人。
 * 环境应该修正的是**群体层面的概率偏移**，不是这个人的画像。
 *
 * @param playerAdjustment 来自 `computeAdjustment`
 * @param environmentConfidence 环境配置的可信度（0..1）
 */
export function composeWithEnvironment(
  playerAdjustment: ProfileAdjustment,
  environmentConfidence: number,
): ProfileAdjustment {
  return scaleAdjustmentConfidence(playerAdjustment, environmentConfidence);
}

/**
 * 由「画像 + 环境」构造 Range 调整提供者。
 *
 * 这是本项目推荐的**默认入口** —— 环境修正不应由调用方记得手动叠加，
 * 否则迟早有人忘记，而忘记的症状是「结果看起来正常但少了修正」，
 * 属于最难发现的错误类型。
 */
export function createEnvironmentAwareProvider(
  playerAdjustment: ProfileAdjustment,
  profile: GameEnvironmentProfile,
  activePlayerCount: number,
  config: ProfileProviderConfig = DEFAULT_PROVIDER_CONFIG,
): ProfileRangeProvider & {
  environmentNote(): string;
  effectiveAdjustment(): EnvironmentAdjustment;
} {
  assertValidEnvironmentProfile(profile);
  const composed = composeWithEnvironment(playerAdjustment, profile.confidence);
  const effective = effectiveAdjustment(profile, activePlayerCount);
  const notes = environmentDeltaNote(profile, effective);
  const baseProvider = createProfileRangeProviderInternal(composed, config, effective);

  return {
    ...baseProvider,
    describe: () => {
      const base = baseProvider.describe();
      if (notes.length === 0) return `${base}（牌局环境：${profile.label}，未做额外修正）`;
      return `${base}（牌局环境：${profile.label} —— ${notes.join('、')}）`;
    },
    environmentNote: () =>
      notes.length === 0
        ? `牌局环境「${profile.label}」未对概率做额外修正`
        : `牌局环境「${profile.label}」：${notes.join('、')}`,
    effectiveAdjustment: () => effective,
  };
}
