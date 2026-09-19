/**
 * ============================================================================
 * 面对下注模型的有效人物画像（PLAYER PROFILE V3 · M1 · 方案 D）
 * ============================================================================
 *
 * ## 为什么需要这个模块（审计结论，见 `reports/evidence/profile-downstream-audit.txt`）
 *
 * 修复前，「面对下注」的三条生产链（**到达范围 / 当前主动下注范围 / 面对加注的响应**）
 * 只消费 `quickProfile` **标签维度**，实测四轴（`resolvedDimensions`）的唯一消费者是
 * 「Hero 主动下注/过牌」分支 —— 而该分支在 `facingBet` 节点被
 * `postflopAdvisor.ts:576` 整块判空 ⇒ 实测统计对该节点**零影响**。
 *
 * 直接把 `resolvedDimensions` 塞进 `responseTendenciesOf(dims, conf)` 会有两个已知缺陷
 *（`reports/evidence/m1-confidence-semantics.txt` 已量化）：
 *
 * | 方案 | 缺陷 |
 * |---|---|
 * | 融合维度 + `conf = 0.35` | 实测份额被**二次衰减**（w 已含样本量，再乘一次标签上限 0.35） |
 * | 融合维度 + `conf = 1` | 标签份额由 0.35 变为 (1−w) ⇒ 单轴最高放大 1.93×、小样本极限 2.9× |
 *
 * ## 方案 D：把「两个来源各自的置信度」在**构造有效维度**时表达清楚，下游只进一次
 *
 * ```text
 * 实测贡献 = w_axis × center(observed_axis)              ← 样本量只体现在 w，不再乘第二次
 * 标签贡献 = 0.35 × (1 − w_axis) × center(base_axis)      ← 手选标签的结构性上限，保持不变
 * 有效中心 = 标签贡献 + 实测贡献
 * 有效维度 = 0.5 + 有效中心 / 2                            ← center 的仿射逆变换
 * ```
 *
 * 然后以 `confidence = 1` 交给 `responseTendenciesOf` —— 因为「两个来源各进了几次」
 * 已经在上面算清，下游**不得**再乘一次（这正是 `betScaleOfUnifiedDimensions` 的既有纪律：
 * 「标签经融合层进入且只进入一次」，见 `observedStats.ts:1142-1162`）。
 *
 * ## 三条硬性质（有测试锁定）
 *
 * 1. **无轴证据 ⇒ 逐位退回旧标签实现**：`hasObservedEvidence = false`，调用方必须原样
 *    使用标签维度 + 原标签置信系数（不经过本模块的仿射往返，避免浮点末位漂移）。
 * 2. **实测不被二次衰减**：实测贡献精确等于 `w × center(observed)`。
 * 3. **标签不被放大**：标签贡献 `≤ 0.35 × |center(base)|`；且无观测通道的轴
 *    （例如 `bluffTendency`：全项目极性为 0）保持「标签 × 0.35」，**不会被推成中性 0**。
 *
 * ## ⚠️ 本模块只服务「**读 confidence**」的那一个消费者（2026-09 自审 F1 ⇒ 修复）
 *
 * 面对下注节点上其实有**两个**消费者，它们对 `confidence` 的处理**不同**：
 *
 * | 消费者 | 读什么 | 应当吃哪份维度 |
 * |---|---|---|
 * | 响应层 `buildRaiseResponse` | `callScale/foldScale/...`（**按 `confidence` 缩放**） | 本模块的**有效维度**（标签 ×0.35 只进一次） |
 * | 下注范围层 `betProbabilityByBand` | **只读 `effectiveDimensions`，完全不读 `confidence`**（`bettingRange.ts:390`） | V3 **融合维度** `resolvedDimensions`（标签 `(1−w)`、实测 `w`，**不折 0.35**） |
 *
 * 把本模块的输出同时喂给下注范围层，等于把标签从 `×1.0` 打到 `×0.35`：
 * 实测在**第一个观测**处跳变（`betMass` −38.1%），并波及**无观测通道**的 `bluffTendency`；
 * 该层还会经 `betRangeEntries` 回流进加注响应的桶划分（上一轮验收块的 `RAISE EV`
 * 有 69.9% 来自这条路）。因此调用方必须**分开取证**：
 * `contextBuilder.ts` 的 `tendenciesForSeat`（响应层）用本模块，
 * `betRangeTendenciesForSeat`（下注范围层）改用 `resolvedDimensions`。
 *
 * ## 本模块不是什么
 *
 * - 不引入任何**新参数**：`0.35` 由调用方传入（= 既有手选标签可信度上限
 *   `QUICK_PROFILE_CONFIDENCE`），K 值、先验、响应系数、强度带参数一律未动；
 * - 不修改任何 EV / 资金 / 合法动作 / 条件权益公式；
 * - 不篡改身份路由：调用方（`tendenciesForSeat` / `betRangeTendenciesForSeat`）
 *   已经保证「只对画像描述的那一家、且只在他本人下注/响应时」使用这份维度。
 */

import type { PlayerDimensions } from '../../domain/player/playerClassifier.ts';
import { SampleTier } from '../../domain/player/playerStats.ts';

/** 四个连续轴（与 `PlayerDimensions` 的同名轴一一对应） */
export type FacingBetAxis = 'tightness' | 'aggression' | 'bluffTendency' | 'passivity';

export const FACING_BET_AXES: readonly FacingBetAxis[] = Object.freeze([
  'tightness',
  'aggression',
  'bluffTendency',
  'passivity',
]);

/**
 * 中心化：`center(x) = clamp((x − 0.5) × 2, −1, +1)`。
 *
 * ⚠️ 它是 §三 契约里**给定的仿射变换**（与 `betResponse.ts` 的 `center` /
 * `observedStats.ts` 的 `centerOf` 同一口径），**不是**模型系数：
 * 这里只是把它显式化，供「有效维度」的构造与审计核对使用。
 */
export function centeredOf(dimension: number): number {
  if (!Number.isFinite(dimension)) return 0;
  return Math.max(-1, Math.min(1, (dimension - 0.5) * 2));
}

/** `center` 的仿射逆变换（夹到 [0,1]，保证有效维度仍是合法维度） */
function uncenterOf(centered: number): number {
  const v = 0.5 + centered / 2;
  return Math.max(0, Math.min(1, v));
}

export type FacingBetProfileInput = {
  /** 标签基线维度（`ResolvedPlayerProfile.resolved.baseDimensions`） */
  readonly baseDimensions: Readonly<Record<FacingBetAxis, number>>;
  /** **observed-only** 维度（`resolved.observedOnlyDimensions`；无证据轴恒为精确 0.5） */
  readonly observedDimensions: Readonly<Record<FacingBetAxis, number>>;
  /** 逐轴融合权重（`resolved.blendWeight`；无证据轴恒为 0，无标签时恒为 1） */
  readonly blendWeight: Readonly<Record<FacingBetAxis, number>>;
  /**
   * 手选标签的**结构性**置信系数（调用方传入既有的
   * `playerBuilt.confidence` = `QUICK_PROFILE_CONFIDENCE` = 0.35）。
   * ⚠️ 它不是「经真实玩家数据校准的最佳值」，只是沿用既有作用。
   */
  readonly labelConfidence: number;
  /** 标签维度（旧实现使用的同一份维度；无证据分支原样返回它，保证逐位兼容） */
  readonly labelDimensions: Readonly<Record<FacingBetAxis, number>>;
};

export type FacingBetProfile = {
  /** 传给 `responseTendenciesOf` 的维度（`confidence = 1` 消费） */
  readonly dimensions: PlayerDimensions;
  /** 传给 `responseTendenciesOf` 的置信系数（有实测时恒为 1） */
  readonly confidence: number;
  /**
   * 是否存在**任一轴**的实测证据。
   *
   * `false` ⇒ 返回的就是标签维度 + 原标签置信系数 ⇒ 调用方走**旧实现**（逐位兼容）。
   */
  readonly hasObservedEvidence: boolean;
  /** 逐轴有效中心（= 标签贡献 + 实测贡献）；审计与测试直接读它 */
  readonly centered: Readonly<Record<FacingBetAxis, number>>;
  /** 逐轴的标签贡献 / 实测贡献（可审计） */
  readonly labelContribution: Readonly<Record<FacingBetAxis, number>>;
  readonly observedContribution: Readonly<Record<FacingBetAxis, number>>;
  readonly noteZh: string;
};

/**
 * 构造「面对下注模型」需要的人物画像维度。
 *
 * @returns `hasObservedEvidence === false` 时：`dimensions = labelDimensions`、
 *          `confidence = labelConfidence`（**逐位等于修复前**）；
 *          否则：`dimensions = 有效维度`、`confidence = 1`。
 */
export function facingBetProfileOf(input: FacingBetProfileInput): FacingBetProfile {
  const labelConfidence = Number.isFinite(input.labelConfidence)
    ? Math.max(0, Math.min(1, input.labelConfidence))
    : 0;

  const hasObservedEvidence = FACING_BET_AXES.some((axis) => {
    const w = input.blendWeight[axis];
    return Number.isFinite(w) && w > 0;
  });

  const centered = {} as Record<FacingBetAxis, number>;
  const labelContribution = {} as Record<FacingBetAxis, number>;
  const observedContribution = {} as Record<FacingBetAxis, number>;
  const effective = {} as Record<FacingBetAxis, number>;

  for (const axis of FACING_BET_AXES) {
    const rawW = input.blendWeight[axis];
    const w = Number.isFinite(rawW) ? Math.max(0, Math.min(1, rawW)) : 0;
    const label = labelConfidence * (1 - w) * centeredOf(input.labelDimensions[axis]);
    /* 实测贡献**只乘 w 一次**；`observed-only` 无证据时中心恒为 0 ⇒ 该项恒为 0 */
    const observed = w * centeredOf(input.observedDimensions[axis]);
    labelContribution[axis] = label;
    observedContribution[axis] = observed;
    centered[axis] = label + observed;
    effective[axis] = uncenterOf(centered[axis]);
  }

  if (!hasObservedEvidence) {
    /*
     * 🔴 **无轴证据 ⇒ 逐位退回旧实现**：
     * 返回标签维度 + 原标签置信系数，**不经过**中心的仿射往返
     *（往返会在浮点末位引入不必要的变化；§六 要求无统计路径不得回归）。
     */
    return Object.freeze({
      dimensions: Object.freeze({
        tightness: input.labelDimensions.tightness,
        aggression: input.labelDimensions.aggression,
        bluffTendency: input.labelDimensions.bluffTendency,
        passivity: input.labelDimensions.passivity,
        confidence: labelConfidence,
        sampleSize: 0,
        tier: SampleTier.PRELIMINARY,
      }),
      confidence: labelConfidence,
      hasObservedEvidence: false,
      centered: Object.freeze(centered),
      labelContribution: Object.freeze(labelContribution),
      observedContribution: Object.freeze(observedContribution),
      noteZh:
        `面对下注画像：**无任何轴的实测证据** ⇒ 沿用旧标签实现` +
        `（标签维度 × 置信系数 ${labelConfidence.toFixed(2)}；与修复前逐位一致）`,
    });
  }

  return Object.freeze({
    dimensions: Object.freeze({
      tightness: effective.tightness,
      aggression: effective.aggression,
      bluffTendency: effective.bluffTendency,
      passivity: effective.passivity,
      /* 「两个来源各进一次」已经算进有效维度 ⇒ 下游置信系数恒为 1（不得再缩放一次） */
      confidence: 1,
      sampleSize: 0,
      tier: SampleTier.PRELIMINARY,
    }),
    confidence: 1,
    hasObservedEvidence: true,
    centered: Object.freeze(centered),
    labelContribution: Object.freeze(labelContribution),
    observedContribution: Object.freeze(observedContribution),
    noteZh:
      `面对下注画像（M1 方案 D）：有效中心 = 标签 ${FACING_BET_AXES.map((a) => labelContribution[a].toFixed(4)).join('/')} ` +
      `+ 实测 ${FACING_BET_AXES.map((a) => observedContribution[a].toFixed(4)).join('/')}` +
      `｜标签上限 ${labelConfidence.toFixed(2)}（仅作用标签份额）｜实测按逐轴融合权重各进一次` +
      '｜下游以 confidence=1 消费（不再二次缩放）',
  });
}
