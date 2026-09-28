/**
 * 🔴 **画像 / 近期倾向 → Range 调整提供者**（P0 架构修复的核心接线）
 *
 * ## 修的是什么
 *
 * 使用者点名的架构缺陷：
 *
 * > 人物画像目前没有进入 Villain action-conditioned range 和 Hero equity /
 * > CHIP_EV 主链，只在决策末端充当 preference modifier。
 *
 * 事实核查（本轮逐行确认）：
 *
 * 1. 项目**早就有**规范第二十节要求的接口 `RangeAdjustmentProvider`
 *    （`src/domain/range/profileProvider.ts`，含 `adjustActionLikelihood` 的
 *    诈唬/价值倾斜），也有完整的对数域乘法与日志（`updateRange` §3b/§3c）。
 * 2. 但生产路径**从未传入** `adjustmentProvider`：
 *    `contextBuilder.applyLikelihoodUpdates` 调用 `updateRange(..., { withDiff: false })`，
 *    于是那份实现是**死代码** —— 画像只在 `advisePostflop` 的偏好分里生效。
 * 3. 更进一步：手选画像即使被传下去也**没有维度可用**
 *    （见 `archetypeDimensions.ts` 的说明：维度全部落在 0.5 ⇒ 因子恒为 1）。
 *
 * 本模块把这两条一起修好，并把「近期倾向」（`DynamicHint`，例如
 * 「他最近变凶了」）作为**独立的第二层证据**接进同一条似然通道 ——
 * 修复前 `AGGRESSION_UP` 在实测中**逐位不产生任何变化**（陈旧性缺陷）。
 *
 * ## 数据流（严格按使用者给定的顺序）
 *
 * ```text
 * 到达范围（先验）
 *   → 街道/动作/尺寸条件化（既有 likelihoodWeights，本模块不改）
 *   → 画像似然调整（本模块 PROFILE_MULTIPLIER）
 *   → 近期倾向调整（本模块 OBSERVATION_MULTIPLIER）
 *   → 归一化（updateRange 的对数域 Log-Sum-Exp）
 *   → Hero equity（contextBuilder 既有路径，自动跟着变）
 *   → 底池赔率 → Call EV → 动作排名（decisionEngine 既有路径）
 * ```
 *
 * ## 三条硬约束（与本项目既有纪律一致）
 *
 * 1. **不产生动作**：本模块导出的类型里没有任何 `Action` 字段。
 * 2. **有界**：每个因子都被夹在 `[minFactor, maxFactor]`，且**夹了就说**
 *    （`clampApplied` / `clampCount` 进证据，绝不静默截断）。
 * 3. **可信度不足 ⇒ 恒等**：可信度低于 `minConfidence` 时因子恒为 1，
 *    并如实记为「未调整」。
 *
 * ## 与既有 `profileProvider` 的关系
 *
 * 本模块**不重复实现**画像因子 —— 它复用 `rawComboWeightFactor` /
 * `createProfileRangeProvider`（既有、已测试），只做两件事：
 * - 叠加「近期倾向」这一层（`AGGRESSION_UP` 等，作用于**弱牌的进攻动作**）；
 * - 记录**可审计的乘数证据**（PROFILE / OBSERVATION / FINAL / CLAMP）。
 */

import {
  RangeAction,
  type ActionLikelihood,
  type RangeAdjustmentProvider,
  type RangeUpdateContext,
} from '../range/range.types.ts';
import { comboById, type ExactCombo } from '../range/combo.ts';
import { comboPotential, weaknessOf } from '../range/handPotential.ts';
import { boardRelativeTierOf } from '../poker/boardRelativeStrength.ts';
import { ALL_CARDS, type Card, type Street } from '../types.ts';
import type { DynamicHint } from '../../app/manualInput/manualInput.ts';
import type { ProfileAdjustment } from './playerClassifier.ts';
import { MAX_ADJUSTMENT } from './playerClassifier.ts';
import {
  DEFAULT_PROVIDER_CONFIG,
  rawComboWeightFactor,
  type ProfileProviderConfig,
} from '../range/profileProvider.ts';

/* ============================================================
 * 近期倾向（观察层）
 * ============================================================ */

/**
 * 近期倾向 → 「弱牌做进攻动作」的对数倾斜方向与幅度。
 *
 * ## 证据等级
 *
 * | 内容 | 等级 |
 * |---|---|
 * | 「近期变凶/倾斜 ⇒ 他会用更多弱牌开火」这一**方向** | 【公开扑克理论】 |
 * | 具体倾斜幅度 `weakAggression` | 【启发式】刻度，只有序关系有意义 |
 * | 可信度上限 `OBSERVATION_CONFIDENCE` | 【工程约束】用户的主观近期观察，不得高于手选画像 |
 *
 * ⚠️ 它**只作用在进攻动作的弱牌端**。原因：对一个抓诈唬的人来说，
 * 「他最近变凶了」唯一能改变权益的通道就是「他的下注范围里空气变多了」。
 * 强牌端不动，因此「强牌比弱牌更可能下注」这一单调性只会更强，不会反转。
 */
export type ObservationTilt = {
  /** > 1：弱牌更可能开火（他的下注范围里空气变多）；< 1：反之 */
  weakAggression: number;
  labelZh: string;
};

/** 近期观察的可信度上限（主观、近期、样本极小） */
export const OBSERVATION_CONFIDENCE = 0.3;

/**
 * 对数倾斜的最大幅度（工程护栏）。
 *
 * `exp(0.35 × 0.3) ≈ 1.11` ⇒ 弱牌端的似然最多变化约 ±11%。
 * 这个量级是**刻意**与画像层（`MAX_ADJUSTMENT = 0.4`）同阶的：
 * 两层叠加后的总幅度仍在「方向性提示」的范围内，不足以单独翻转动作 ——
 * 那正是设计意图（不许画像覆盖硬数学）。
 */
export const OBSERVATION_MAX_TILT = 0.35;

/**
 * 「大注诈唬 / 小注诈唬」这条**尺寸通道**的最大幅度（工程护栏）。
 *
 * 见 `rawActionLikelihoodFactor` 的说明：`sizeBoost ∈ [1 − 0.25, 1 + 0.25]`。
 * 它与 `OBSERVATION_MAX_TILT` 同量级，因此「大注」这一条信息不会单独翻转动作 ——
 * 它只能与画像、观测、似然一起作用。这是刻意设计（画像不得覆盖硬数学）。
 */
export const SIZE_TILT_MAX = 0.25;

export const OBSERVATION_TILTS: Readonly<Record<DynamicHint, ObservationTilt | null>> =
  Object.freeze({
    UNKNOWN: null,
    NORMAL: null,
    // 近期变松/变凶：弱牌更可能入池与开火
    LOOSER_RECENTLY: { weakAggression: 1.2, labelZh: '近期变松（弱牌更常进池）' },
    AGGRESSION_UP: { weakAggression: 1.45, labelZh: '近期攻击性上升（弱牌更常开火）' },
    TILT_SIGNAL: { weakAggression: 1.6, labelZh: '倾斜信号（弱牌开火明显增多）' },
    CHASE_LOSS_SIGNAL: { weakAggression: 1.15, labelZh: '连续受挫（可能增多弱牌开火）' },
    // 反向：打得更紧 ⇒ 他的进攻更像有牌
    TIGHTER_RECENTLY: { weakAggression: 0.8, labelZh: '近期变紧（进攻更像有牌）' },
  });

/* ============================================================
 * 证据
 * ============================================================ */

/** 一组乘性因子的可审计摘要 */
export type MultiplierSummary = {
  min: number;
  max: number;
  mean: number;
  /** 真正改变了形状（≠1）的次数 */
  effective: number;
  /** 被调用次数 */
  calls: number;
};

export type TendencyEvidence = {
  /** 是否**确实**改变了范围形状（有效因子 > 0 且 applied） */
  applied: boolean;
  /** 画像是否被判定为中性（可信度不足 / 无可调整维度） */
  profileNeutral: boolean;
  /** 观测层是否参与（有近期倾向且动作是进攻） */
  observationApplied: boolean;
  /** 参与调整的动作（去重，按出现顺序） */
  actions: readonly string[];
  /** PROFILE_MULTIPLIER：来自画像维度的因子 */
  profileMultiplier: MultiplierSummary;
  /** OBSERVATION_MULTIPLIER：来自近期倾向的因子 */
  observationMultiplier: MultiplierSummary;
  /** FINAL_MULTIPLIER：实际写进似然的因子（= profile × observation，已夹） */
  finalMultiplier: MultiplierSummary;
  /** CLAMP_APPLIED：是否有因子被工程护栏夹过 */
  clampApplied: boolean;
  clampCount: number;
  /** 先验形状层（`adjustComboWeight`）的因子摘要；`calls === 0` 表示未施加 */
  comboWeightMultiplier: MultiplierSummary;
  /** 先验形状层是否已施加（**只施加一次**，见 `adjustComboWeight`） */
  comboWeightApplied: boolean;
  /** 未知 comboId 次数（未知 ⇒ 因子 1，绝不假装是中等牌） */
  unknownCombos: number;
  /** 中文说明（逐条，进 UI 与报告） */
  noteZh: readonly string[];
};

function emptySummary(): MultiplierSummary {
  return { min: 1, max: 1, mean: 1, effective: 0, calls: 0 };
}

function pushFactor(summary: MultiplierSummary, factor: number): void {
  summary.calls += 1;
  if (summary.calls === 1) {
    summary.min = factor;
    summary.max = factor;
    summary.mean = factor;
  } else {
    if (factor < summary.min) summary.min = factor;
    if (factor > summary.max) summary.max = factor;
    // 增量均值（避免保存全部样本）
    summary.mean += (factor - summary.mean) / summary.calls;
  }
  if (Math.abs(factor - 1) > 1e-15) summary.effective += 1;
}

/* ============================================================
 * Provider
 * ============================================================ */

export type TendencyProvider = RangeAdjustmentProvider & {
  /** 到目前为止的乘数证据（**纯读取**，不改变状态） */
  evidence(): TendencyEvidence;
  /** 供 UI 展示的一句话 */
  describe(): string;
};

export type TendencyProviderOptions = {
  adjustment: ProfileAdjustment;
  /** 近期倾向（`null` = 无近期观察） */
  observation: DynamicHint | null;
  /**
   * 🔴 **某个街道上「当时」的公共牌**（用于把「弱牌」判据锚定到当前牌面）。
   *
   * ## 为什么必须锚定到牌面（实测缺陷，不是理论洁癖）
   *
   * 修复前沿用了 `profileProvider` 的判据：`weaknessOf(comboPotential(combo))`
   * —— 那是**翻前牌力潜力**。用它去判断「他在**这个牌面**上是不是空气」
   * 会得出**反向**的结论，实测（测试局 3 河牌节点，CO 下注 82% 池）：
   *
   * ```text
   * VERY_TIGHT（应当收紧他的进攻范围 ⇒ 我的抓诈唬权益下降）
   *   ⇒ 画像因子 ×0.912–0.992，**权益 17.508%**（NORMAL 是 17.495%）
   * BLUFF_HEAVY（应当让他的进攻范围更含空气 ⇒ 我的权益上升）
   *   ⇒ 画像因子 ×1.043–1.136，**权益 17.511%**
   * ⇒ A / B / C 三个方向**同时**抬高权益，**非单调**
   * ```
   *
   * 根因：本牌面上「翻前潜力低」的牌（33 / 88 / 6x）恰恰是**成了三条/两对**
   * 的那些牌 —— 它们**比我强**。压低它们等于抬高我的权益，
   * 与「收紧他的诈唬」想表达的意思正好相反。
   *
   * 因此翻后一律改用**牌面相对强度档**（既有 `boardRelativeTierOf`，
   * 与似然模型用的是同一个判据）：档 4–5 = 真正在这张牌面上的空气。
   * 翻前（公共牌不足 3 张）仍用翻前潜力 —— 那时「弱牌」本来就该按起手牌判。
   */
  boardOfStreet?: (street: Street) => readonly Card[];
  config?: ProfileProviderConfig;
};

/**
 * 构造一个把「画像 + 近期倾向」写进动作似然的 provider。
 *
 * ⚠️ 返回的对象**没有任何动作字段**，它只能改概率。
 */
export function createTendencyProvider(options: TendencyProviderOptions): TendencyProvider {
  const config = options.config ?? DEFAULT_PROVIDER_CONFIG;
  const adjustment = options.adjustment;
  const tilt = options.observation === null ? null : OBSERVATION_TILTS[options.observation];
  const neutral = adjustment.confidence < config.minConfidence;

  const profileSummary = emptySummary();
  const observationSummary = emptySummary();
  const finalSummary = emptySummary();
  /** 先验形状层（`adjustComboWeight`）的因子；**只在第一次更新时施加** */
  const comboWeightSummary = emptySummary();
  /**
   * 已经见过的 `updateRange` 调用序号（用 `街道|动作|序号` 三元组识别）。
   *
   * ⚠️ `updateRange` 是**逐组合**回调 provider 的，因此不能用「一个布尔量」
   * 表示「这一轮已经施加过」—— 那会让先验形状层只作用于**第一个组合**
   * （实测：`1 个组合被改变`，而正确的应该是本轮全部可达组合）。
   * 判据必须是「第几次更新调用」。
   */
  let updateCallIndex = 0;
  let lastUpdateKey = '';
  const actions: string[] = [];
  let clampCount = 0;
  let unknownCombos = 0;
  let observationApplied = false;

  const clamp = (factor: number): number => {
    const bounded = Math.max(config.minFactor, Math.min(config.maxFactor, factor));
    if (Math.abs(bounded - factor) > 1e-15) clampCount += 1;
    return bounded;
  };

  const evidence = (): TendencyEvidence => {
    const applied =
      !neutral &&
      (profileSummary.effective > 0 ||
        observationSummary.effective > 0 ||
        comboWeightSummary.effective > 0);
    const notes: string[] = [];
    if (neutral) {
      notes.push(
        `画像可信度 ${adjustment.confidence.toFixed(2)} 低于门槛 ${config.minConfidence} ⇒ **不做任何画像调整**（因子恒为 1）`,
      );
    } else {
      notes.push(
        `画像因子：×${profileSummary.min.toFixed(3)}–${profileSummary.max.toFixed(3)}（均值 ${profileSummary.mean.toFixed(3)}，` +
          `${profileSummary.effective}/${profileSummary.calls} 次真正生效）`,
      );
    }
    if (tilt !== null) {
      notes.push(
        `近期倾向「${tilt.labelZh}」：弱牌开火因子 ×${observationSummary.min.toFixed(3)}–${observationSummary.max.toFixed(3)}` +
          (observationApplied ? '（已作用于进攻动作）' : '（本次没有进攻动作，未生效）'),
      );
    }
    notes.push(
      `最终似然因子：×${finalSummary.min.toFixed(3)}–${finalSummary.max.toFixed(3)}（${finalSummary.effective}/${finalSummary.calls} 次生效）` +
        (clampCount > 0
          ? `；⚠️ CLAMP_APPLIED：${clampCount} 次被工程护栏 [${config.minFactor}, ${config.maxFactor}] 截断`
          : '；未被工程护栏截断'),
    );
    if (comboWeightSummary.calls > 0) {
      notes.push(
        `先验形状层（只在第一次更新时施加一次）：×${comboWeightSummary.min.toFixed(3)}–` +
          `${comboWeightSummary.max.toFixed(3)}（均值 ${comboWeightSummary.mean.toFixed(3)}，${comboWeightSummary.effective} 个组合被改变）`,
      );
    }
    if (unknownCombos > 0) {
      notes.push(`⚠️ ${unknownCombos} 个未知 comboId ⇒ 不调整（不假装是中等牌）`);
    }
    return Object.freeze({
      applied,
      profileNeutral: neutral,
      observationApplied,
      actions: Object.freeze([...actions]),
      profileMultiplier: Object.freeze({ ...profileSummary }),
      observationMultiplier: Object.freeze({ ...observationSummary }),
      finalMultiplier: Object.freeze({ ...finalSummary }),
      clampApplied: clampCount > 0,
      clampCount,
      comboWeightMultiplier: Object.freeze({ ...comboWeightSummary }),
      comboWeightApplied: updateCallIndex > 0 && comboWeightSummary.calls > 0,
      unknownCombos,
      noteZh: Object.freeze(notes),
    });
  };

  /** 用 `街道|动作|序号` 识别「这是第几次 updateRange 调用」 */
  const updateKeyOf = (context: RangeUpdateContext): string =>
    `${context.street}|${context.action}|${context.actionIndex}`;

  /**
   * 把「他在这个牌面上有多弱」映射到 **[-1, +1]** 的中心化刻度
   * （与既有 `weaknessOf` 同量纲：正 = 弱端、负 = 强端）。
   *
   * 翻后（公共牌 ≥3）用**牌面相对档**：档 0–1 ⇒ −1..−0.6、档 4–5 ⇒ +0.6..+1；
   * 翻前回落 `weaknessOf(comboPotential(combo))`（那时「弱」本来就该按起手牌判）。
   */
  const weaknessAt = (combo: ExactCombo, context: RangeUpdateContext): number => {
    const board = options.boardOfStreet?.(context.street) ?? [];
    if (board.length >= 3) {
      const hole: [Card, Card] = [
        ALL_CARDS[combo.cardIndices[0]]!,
        ALL_CARDS[combo.cardIndices[1]]!,
      ];
      const tier = boardRelativeTierOf(hole, board);
      if (tier !== null) return (tier - 2.5) / 2.5;
    }
    return weaknessOf(comboPotential(combo));
  };

  return {
    providerId: 'tendency.range.adjustment.v1',

    adjustComboWeight(combo: ExactCombo, context: RangeUpdateContext): number {
      /*
       * 🔴 **先验形状层只在第一次更新调用时施加**（防重复计票）。
       *
       * `updateRange` 是**逐条行动**调用的（翻牌跟注、转牌跟注、河牌下注…）。
       * 「这个人是松/凶」是**同一个持续特质**：如果在每条行动上都乘一次，
       * 三条街之后它被乘了三次，一个「偏松」的对手会被调整成荒谬的宽度。
       *
       * 因此本层只在**第一次**更新时生效（= 到达范围本身的形状），
       * 之后的每一条行动只通过各自的动作似然携带新信息。
       * 这不是静默行为：`evidence().noteZh` 会写明它是否生效。
       */
      const key = updateKeyOf(context);
      if (key !== lastUpdateKey) {
        lastUpdateKey = key;
        updateCallIndex += 1;
      }
      if (updateCallIndex > 1 || neutral) return 1;

      const factor = rawComboWeightFactor(combo, adjustment, config);
      pushFactor(comboWeightSummary, factor);
      return factor;
    },

    adjustActionLikelihood(likelihood: ActionLikelihood, context: RangeUpdateContext): number {
      if (neutral && tilt === null) return 1;

      const combo = comboById(likelihood.comboId);
      if (!combo) {
        unknownCombos += 1;
        return 1; // 未知 ⇒ 明确「不调整」
      }

      const isAggressive =
        likelihood.action === RangeAction.BET ||
        likelihood.action === RangeAction.RAISE ||
        likelihood.action === RangeAction.ALL_IN;
      const weakness = weaknessAt(combo, context);

      // ---- 第 1 层：画像（弱牌进攻 × 诈唬倾向；强牌进攻 × 价值倾向）----
      const profileFactor = neutral
        ? 1
        : rawActionLikelihoodFactor(likelihood, adjustment, isAggressive, weakness, context);
      if (!neutral) pushFactor(profileSummary, profileFactor);

      // ---- 第 2 层：近期倾向（**只作用于进攻动作的弱牌端**）----
      let observationFactor = 1;
      if (tilt !== null && isAggressive) {
        /*
         * 弱牌端拿满倾斜、强牌端拿 25%：
         * 一个「最近变凶」的对手不只多诈唬，也会更多价值下注，
         * 因此强牌端不能完全不动；但**能让抓诈唬权益变化的通道是弱牌端**，
         * 所以权重压在弱牌上。
         */
        const weakShare = 0.25 + 0.75 * Math.max(0, weakness);
        const direction = Math.log(tilt.weakAggression);
        observationFactor = Math.exp(OBSERVATION_MAX_TILT * OBSERVATION_CONFIDENCE * direction * weakShare);
        observationApplied = true;
        pushFactor(observationSummary, observationFactor);
      }

      const final = clamp(profileFactor * observationFactor);
      pushFactor(finalSummary, final);
      if (!actions.includes(likelihood.action)) actions.push(likelihood.action);
      return final;
    },

    evidence,
    describe: () => {
      const current = evidence();
      if (!current.applied) return '画像与近期倾向未改变任何动作似然';
      return (
        `画像与近期倾向已进入动作似然：最终因子 ×${current.finalMultiplier.min.toFixed(3)}–` +
        `${current.finalMultiplier.max.toFixed(3)}（动作：${current.actions.join('/')}）`
      );
    },
  };
}

/**
 * 画像对**单个动作似然**的因子。
 *
 * ## 与 `profileProvider.adjustActionLikelihood` 的关系（**两处刻意的差别**）
 *
 * 相同：动作攻击性刻度（CHECK −0.6 … ALL_IN +1.0）、五个 tilt 的定义、
 * `MAX_ADJUSTMENT`、可信度加权、指数形式（乘性对称）。
 *
 * | 差别 | `profileProvider`（既有，未改动） | 本模块 |
 * |---|---|---|
 * | 「弱牌」判据 | `weaknessOf(comboPotential(combo))`（**翻前潜力**） | 翻后用**牌面相对档**（`boardRelativeTierOf`），翻前仍用翻前潜力 |
 * | 统计 | provider 内部自己的累计 | 画像层 / 观测层 / 最终层**三组**分别记录 |
 *
 * 第一条差别不是口味问题，而是**实测出来的方向错误**（见
 * `TendencyProviderOptions.boardOfStreet` 的说明）：
 * 用翻前潜力判断「他在这个牌面上是不是空气」，会让
 * VERY_TIGHT 与 BLUFF_HEAVY **同时**抬高 Hero 的权益（非单调）。
 * 既有 provider 保持原样（它有自己的测试与调用方），
 * 本模块在生产路径上使用**牌面锚定**的版本。
 *
 * ⚠️ 因此本模块**不**声称与 `profileProvider` 逐位一致；
 * 测试断言的是**方向与单调性**（A < B < C），以及五个 tilt 的结构一致。
 */
function rawActionLikelihoodFactor(
  likelihood: ActionLikelihood,
  adjustment: ProfileAdjustment,
  isAggressive: boolean,
  weakness: number,
  /** `updateRange` 提供的上下文（含 `betSize` / `potSize`，用于「大注炸唬」调制） */
  context: RangeUpdateContext,
): number {
  // 与 profileProvider 完全相同的动作攻击性刻度
  const aggressionOfAction: Record<RangeAction, number> = {
    [RangeAction.CHECK]: -0.6,
    [RangeAction.FOLD]: -0.4,
    [RangeAction.CALL]: -0.1,
    [RangeAction.BET]: 0.6,
    [RangeAction.RAISE]: 0.9,
    [RangeAction.ALL_IN]: 1.0,
  };
  const actionAggression = aggressionOfAction[likelihood.action] ?? 0;

  const d = adjustment.dimensions;
  const aggro = (d.aggression - 0.5) * 2;
  const passive = (d.passivity - 0.5) * 2;
  const bluff = (d.bluffTendency - 0.5) * 2;

  /*
   * 🔴 **「进攻性」不能同时记在两端**（本轮实测出来的结构性缺陷）。
   *
   * 修复前：`valueTilt = aggro × 强牌 × 0.7`，而 `bluffTilt = bluff × 弱牌`。
   * 于是「又凶又爱诈唬」的对手**两端同时**被抬高，
   * 而两端谁抬得多决定了 Hero 权益往哪走 —— 实测（测试局 3 河牌节点）：
   *
   * ```text
   * BLUFF_HEAVY（aggro 0.56, bluff 0.70）⇒ 空气 ×1.103、价值 ×1.056
   *   ⇒ 价值端的增益（他那些**比我强**的牌）盖过空气端 ⇒ 权益 17.465%，
   *     反而**低于** NORMAL 的 17.495% —— 用「他爱诈唬」推出「我更该弃牌」
   * MANIAC（aggro 0.84, bluff 0.80）⇒ 空气 ×1.118、价值 ×1.086
   *   ⇒ 比值 (1.118/1.086) 甚至**小于** BLUFF_HEAVY 的 (1.103/1.056)
   *   ⇒ 「更疯」反而空气占比更低，与语义相反
   * ```
   *
   * 修正：**只有「未被诈唬解释的那部分进攻性」才抬高价值端**。
   * `bluffShare = max(0, bluffTendency 的偏移) ∈ [0,1]`：
   * 一个诈唬倾向 0.85 的对手，他的高进攻性主要由诈唬解释，
   * 因此价值端只拿 `1 − 0.7 = 0.3` 的权重。
   *
   * 这条修正不引入任何新参数（复用同一个 `aggro` 与 `bluff`），
   * 只是**去掉重复计票**：同一个「凶」不再被算两次。
   *
   * ⚠️ 顺带说明：`aggressionTilt`（与牌力无关的那一项）在归一化时会
   * **整体抵消** —— 它对范围的形状没有任何影响，只在极值处经钳位起作用。
   * 保留它是为了与既有 provider 的结构一致（可读性），而不是因为它有效。
   */
  const bluffShare = Math.max(0, Math.min(1, bluff));
  const valueTilt = isAggressive ? aggro * (1 - bluffShare) * Math.max(0, -weakness) * 0.7 : 0;
  const bluffTilt = isAggressive ? bluff * Math.max(0, weakness) * 1.0 : 0;

  const aggressionTilt = aggro * actionAggression * 0.9;
  const passiveTilt = passive * (likelihood.action === RangeAction.CALL ? 0.8 : 0);
  const foldTilt = passive * (likelihood.action === RangeAction.FOLD ? -1.2 : 0);

  const v = aggressionTilt + passiveTilt + foldTilt + bluffTilt + valueTilt;
  const bounded = Math.max(-1, Math.min(1, v));

  /*
   * 🔴 **「大注诈唬」与「小注诈唬」不是同一件事**（使用者 §6 的街道级倾向字段）。
   *
   * 同一个「爱诈唬」的对手，在大注上偏离群体基线的幅度更大：
   * 大注的群体基线本来就偏强（`likelihoodWeights` 的下注量放大器），
   * 而一个爱诈唬的人在大注上的**弱牌占比**也就更反常。
   *
   * ## 为什么它必须在 ±1 护栏**之外**
   *
   * 第一版把尺寸调制乘在 `bluffTilt` 上，实测**几乎看不到**
   *（`scripts/tmp-size-probe.ts`）：弱牌端的倾斜和已经撞到 ±1 的工程护栏，
   * 再乘一个 > 1 的系数被护栏完全吸收 —— 于是「大注诈唬」在
   * **最弱的那一档**上恰好失效，而那正是抓诈唬最关心的那一档。
   *
   * 现在改为**独立的一条有界通道**（与主倾斜相加，而不是相乘）：
   *
   * ```text
   * sizeBoost = 1 + 0.25 × sizeWeight × max(0, weakness) × bluff
   * sizeWeight = clamp01((bet/pot − 0.5) / 0.5)      // 半池以下 0，满池及以上 1
   * ```
   *
   * 三条性质（都有测试）：
   * 1. **有界**：`sizeBoost ∈ [0.75, 1.25]`（`bluff` 与 `weakness` 都在 [−1,1]）；
   * 2. **对诈唬倾向单调**：`bluff` 越大，正倾斜越大、负倾斜越小 —— 因此
   *    A/B/C 单调性不受影响；
   * 3. **只作用于弱牌端**：`max(0, weakness)` ⇒ 强牌端恒为 1，
   *    「强牌比弱牌更可能下注」不会被反转。
   */
  const betRatio =
    context.potSize !== undefined && context.potSize > 0 && context.betSize !== undefined
      ? context.betSize / context.potSize
      : null;
  const sizeWeight = betRatio === null ? 0 : Math.max(0, Math.min(1, (betRatio - 0.5) / 0.5));
  const sizeBoost = isAggressive
    ? 1 + SIZE_TILT_MAX * sizeWeight * Math.max(0, weakness) * bluff
    : 1;

  return Math.exp(MAX_ADJUSTMENT * adjustment.confidence * bounded) * sizeBoost;
}
