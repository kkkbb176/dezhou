/**
 * 范围似然模型（**启发式，只表达单调倾向**）
 *
 * ## 这个模块在端到端链中解决什么
 *
 * 对手的**行动**携带信息：他加注说明他的手牌偏向强牌，他跟注说明偏中等，
 * 他弃牌说明偏弱。把这些行动转成对范围权重的修正，就是似然模型。
 *
 * ## 🔴 它是什么，不是什么
 *
 * **是**：一个只表达「强牌更可能加注、弱牌更可能弃牌」的**单调倾向**函数。
 *
 * **不是**：
 * - 不是 GTO 频率（本项目没有求解器）
 * - 不是实测频率（本项目没有分级别统计数据）
 * - 不是「加注有 70% 是强牌」这类可引用的断言
 *
 * 因此这里的数字**刻意只有序关系有意义**：
 * `ABNORMAL` 对强牌给更高似然、对弱牌给更低似然；
 * 具体的 0.3 / 0.9 只是**刻度**，不代表任何真实频率。
 *
 * ## 为什么必须设**似然下限**（重要的工程细节）
 *
 * 范围引擎按 `prior × likelihood` 更新。若某个类别被赋 `likelihood = 0`，
 * 它在更新后**永久消失**。而「某个位置从不用 X 牌加注」这种判断
 * 本项目**没有依据**下。因此最弱档位也给一个小的正数下限，
 * 使范围**收缩而不塌缩**。
 *
 * 若真的出现 0 组合（例如死牌把唯一组合封掉），
 * `updateRange` 会返回 `RANGE_COLLAPSE`，
 * 决策层据此返回「信息不足」—— 那才是正确处理，
 * 而不是靠似然下限掩盖。
 */

/**
 * 似然权重档位（**刻度**，不是频率）。
 *
 * 强牌在 `ABNORMAL` 下权重 4.0、在 `NORMAL` 下 1.2；
 * 弱牌反之。两者之比 ≈ 3.3 与 0.3 —— 这个**比值**才是模型的内容。
 *
 * ⚠️ **这些是权重，不是概率。** 它们会被归一化到 `[0, 1]`
 *（见 `normalizeLikelihood`），因为范围引擎要求 `likelihood` 是
 * **条件概率** `P(动作 | 手牌)`，落在 `[0, 1]` 内。
 *
 * 实测踩到的坑：直接把权重当似然传入，`validateActionModel` 会以
 * `likelihood 越界（4）` 拒绝整个动作模型，于是**每一次范围更新都静默失败**
 *（只在 `updateTrace` 里留下一行「更新失败」）。
 */
const ABNORMAL_WEIGHTS: readonly number[] = [
  4.0, // 顶级（AA/KK/QQ/AKs）
  2.5, // 强
  1.2, // 中
  0.7, // 偏弱
  0.45, // 弱
  0.3, // 垃圾
];

const NORMAL_WEIGHTS: readonly number[] = [
  1.2, // 顶级
  1.4, // 强
  1.5, // 中
  1.4, // 偏弱
  1.2, // 弱
  1.0, // 垃圾
];

/**
 * 🔴 **跟注**的档位权重（2026-09 审计修复，C2）。
 *
 * 与 `NORMAL_WEIGHTS`（过牌）的差别就是这个模型的全部内容：
 * **空气显著更低**（0.5 vs 1.0）、**中上档更高**（2.2/2.6 vs 1.4/1.5）。
 * 与 `ABNORMAL_WEIGHTS`（加注）的差别是**顶级档低得多**（1.6 vs 4.0）——
 * 因为顶级牌更常加注，用它跟注属于慢打，是少数。
 *
 * ⚠️ 这些是**权重**不是概率（同 `ABNORMAL_WEIGHTS` 的说明），
 * 会被 `normalizeLikelihood` 归一化到 `[0,1]`。
 * 它们表达的是**单调倾向**，不是「跟注频率」的估计。
 */
const CALL_WEIGHTS: readonly number[] = [
  1.6, // 顶级：会跟（慢打/诱导），但明显少于加注
  2.2, // 强：强成手与强听牌 —— 继续的主力
  2.6, // 中：一对/中等成手 —— 跟注里最常见的一档
  1.8, // 偏弱：弱对/后门听牌，小额跟注会带一些
  0.9, // 弱
  0.5, // 垃圾：**低于过牌**（过牌可以带空气，跟注不行）
];

export type LikelihoodActionKind = 'AGGRESSIVE' | 'CALL' | 'CHECK';

/**
 * 似然下限（**归一化之前**的权重下限）。
 *
 * 取 0.05：足够小以致它几乎不影响形状，
 * 又足够大以致一个类别不会因为似然而被**完全删除**。
 */
export const LIKELIHOOD_FLOOR = 0.05;

/** 归一化上限：保证归一化后的似然严格落在 (0, 1) */
const NORMALIZED_CEILING = 0.95;

/**
 * 把一组权重归一化成 `[0,1]` 的**概率**。
 *
 * ## 归一化方式与它的含义
 *
 * `max` 归一化（每个权重除以最大权重），并乘以 `NORMALIZED_CEILING`：
 *
 * ```
 * likelihood_i = weight_i / max(weight) × 0.95
 * ```
 *
 * 于是最强档位得到 0.95、最弱档位得到 `0.3/4.0 × 0.95 ≈ 0.071`。
 * **比值被完整保留**，因此「强牌更可能加注」这一单调倾向不受影响。
 *
 * ## 为什么不用「除以总和」
 *
 * 除以总和会依赖「有几个档位」这个与手牌无关的量，
 * 让同一手牌的似然随着模型里有几个档位而漂移 —— 那是隐性耦合。
 * `max` 归一化只依赖当前档位集合内部的相对关系，语义更干净。
 *
 * ## ⚠️ 它不是「完整策略」
 *
 * 归一化后的值**不是** `P(加注 | 这手牌)` 的估计 ——
 * 真正的条件概率需要「同一手牌在跟注/弃牌下的似然」才能配平。
 * 它只是一个**单调倾向因子**，因此动作模型必须标 `complete: false`
 * 并附 `PARTIAL_ACTION_MODEL` 说明。
 */
export function normalizeLikelihood(weights: readonly number[]): readonly number[] {
  const max = Math.max(...weights);
  if (!(max > 0)) return weights.map(() => LIKELIHOOD_FLOOR);
  return Object.freeze(weights.map((w) => (w / max) * NORMALIZED_CEILING));
}

/**
 * 把 169 个类别映射到 6 个牌力档位。
 *
 * ## ⚠️ 必须**解析牌型本身**，不能用索引位置（红队 F-02 的修复）
 *
 * 曾经的实现假设「`preflopPriors` 的键序就是牌力降序」，于是按
 * `index / total` 的百分比切档。**那个假设是错的** ——
 * 键序是「所有对子 → A 带脚同花 → A 带脚非同花 → K 带脚同花 → …」，
 * 对子只占前 13 个，而 A 带脚从第 13 个才开始。
 *
 * 后果（红队实测，全部是**牌力倒挂**）：
 *
 * | 类别 | 索引 | 进攻似然 | 被动似然 |
 * |---|---|---|---|
 * | AA | 0 | 0.9500 | 0.7600 |
 * | KK | **25** | 0.9500 | 0.7600 |
 * | QQ | **48** | **0.5938** | **0.8867** |
 * | A7s | 13 | 0.9500 | 0.7600 |
 * | 22 | 168 | 0.0712 | 0.6333 |
 * | 72o | **143** | 0.1069 | **0.7600** |
 *
 * 即：**QQ 的进攻似然低于 A7s，22 的被动似然低于 72o**。
 * 自检函数 `selfCheckLikelihoodModel` 会如实报错，但它当时**没有任何调用者**。
 *
 * ## 现在的判据
 *
 * 直接解析类别键（`AA` / `AKs` / `AKo` 三种形态）：
 * - **对子**：按对子大小（AA-QQ → 0，JJ-88 → 1，77-55 → 2，44-22 → 3）
 * - **同花**：比非同花更有可玩性，档位相应提升
 * - **最大牌**：A > K > Q > J > T > 其余
 *
 * 这是**结构性判断**（牌力序），不是从数据估出的参数。
 */
export function tierOfRankClass(rankClass: string): number {
  const text = rankClass.trim();
  if (text.length < 2 || text.length > 3) return 5;

  const RANK_ORDER = 'AKQJT98765432';
  const hiIndex = RANK_ORDER.indexOf(text[0]!);
  if (hiIndex < 0) return 5;
  const isPair = text.length === 2;
  const suited = text.endsWith('s');

  if (isPair) {
    // 对子：AA..22
    if (hiIndex <= 2) return 0; // AA KK QQ
    if (hiIndex <= 6) return 1; // JJ TT 99 88
    if (hiIndex <= 9) return 2; // 77 66 55
    return 3; // 44 33 22
  }

  const loIndex = RANK_ORDER.indexOf(text[1]!);
  if (loIndex < 0) return 5;

  if (hiIndex === 0) {
    // A 带脚
    if (loIndex <= 2) return 0; // AK AQ
    if (loIndex <= 4) return suited ? 1 : 2; // AJ AT
    if (loIndex <= 9) return suited ? 2 : 4; // A9..A5
    return suited ? 3 : 5; // A4..A2
  }
  if (hiIndex <= 2) {
    // K / Q 带脚
    if (loIndex <= 4) return suited ? 1 : 2; // KQ KJ KT / QJ QT
    if (loIndex <= 7) return suited ? 2 : 4; // K9 K8 K7 / Q9 Q8 Q7
    return suited ? 3 : 5;
  }
  if (hiIndex <= 6) {
    // J / T / 9 带脚（含同花连张）
    if (loIndex - hiIndex === 1) return suited ? 2 : 4; // 连张
    return suited ? 3 : 5;
  }
  // 其余：只有同花连张有一点可玩性
  if (suited && loIndex - hiIndex <= 2) return 3;
  return suited ? 4 : 5;
}

/**
 * 由索引反查类别键需要全表；为避免在热路径上做映射，
 * 这里保留一个**兼容签名**：调用方若只有索引，请改用 `tierOfRankClass`。
 *
 * @deprecated 索引位置**不是**牌力序（见 `tierOfRankClass` 的说明）。
 *   保留仅为不破坏既有 import；内部已不再使用。
 */
export function tierOfRankClassIndex(index: number, total: number): number {
  if (total <= 0) return 5;
  return Math.max(0, Math.min(5, Math.floor((index / total) * 6)));
}

/**
 * 返回一个「rankClass → 似然」的函数。
 *
 * ## 判据是**牌型本身**，不是索引位置
 *
 * 见 `tierOfRankClass` 的说明：索引位置**不是**牌力序，
 * 按索引分档会造成 QQ < A7s 这类倒挂（红队 F-02）。
 *
 * ## 下注量修正（红队 F-03 的同类缺陷）
 *
 * `betSizeBB` 提供时，会按**下注量相对底池的大小**进一步修正范围形状：
 * **注越大 → 越偏强牌**。
 *
 * 为什么必须做：修复前似然是**常数**，完全忽略下注量。实测后果是
 * 河牌持**一对 K** 面对 **3 倍超池下注**时，系统算出 **90.2% 权益**
 * 并建议加注到 40BB —— 而任何真实对手的 3 倍超池下注都不是
 * 「一半是诈唬」的范围。用一对 K 把它当成领先牌是严重误判。
 *
 * 修正方式：对**第一档（顶级）**的权重乘以放大因子，
 * 从而把概率质量往上推 —— 这样比值（攻击性 vs 被动的相对倾向）保持不变，
 * 只有分布形状变陡。倍数是**结构性判断**（多大的注代表多强的牌），
 * 不是从数据估出的参数。
 *
 * @param abnormal `true` = 进攻性动作（下注/加注/全下）
 *                 `false` = 被动动作（跟注/过牌）
 */
export function makeLikelihood(
  abnormal: boolean,
  betRatioToPot?: number,
): (rankClass: string) => number {
  const baseWeights = abnormal ? ABNORMAL_WEIGHTS : NORMAL_WEIGHTS;

  // 下注量 → 顶级档位的放大倍数。
  //
  // | 注/底池 | 倍数 | 含义 |
  // |---|---|---|
  // | ≤ 0.5 | ×1.0 | 小注：范围宽，不额外收紧 |
  // | 1.0 | ×1.5 | 正常注 |
  // | 2.0 | ×3.0 | 大注 |
  // | ≥ 3.0 | ×4.0 | 超池：强烈指向强牌 |
  //
  // 只放大第一档而**不动其它档位**：范围会整体向顶级移动，
  // 但「强牌比弱牌更可能下注」这个单调性只会更强，不会反转。
  let amplifier = 1;
  if (betRatioToPot !== undefined && Number.isFinite(betRatioToPot) && betRatioToPot > 0.5) {
    amplifier = Math.min(4, Math.sqrt(Math.max(0.5, betRatioToPot)) * 1.5);
  }

  const weighted = amplifier === 1 ? baseWeights : [baseWeights[0]! * amplifier, ...baseWeights.slice(1)];
  const normalized = normalizeLikelihood(weighted);

  return (rankClass: string): number => {
    const tier = tierOfRankClass(rankClass);
    const value = normalized[tier] ?? normalized[normalized.length - 1]!;
    // 双保险：范围引擎要求 likelihood ∈ [0,1]
    return Math.max(0, Math.min(1, value));
  };
}

/** 由「下注额 / 底池」得到似然修正用的比例（无法计算时返回 undefined） */
export function betRatioOf(
  betSize: number | undefined,
  potSize: number | undefined,
): number | undefined {
  if (betSize === undefined || potSize === undefined) return undefined;
  if (!Number.isFinite(betSize) || !Number.isFinite(potSize)) return undefined;
  if (potSize <= 0 || betSize <= 0) return undefined;
  return betSize / potSize;
}

/**
 * 进攻性动作的似然函数工厂。
 *
 * @deprecated 判据已改为**牌型本身**（见 `tierOfRankClass`）。
 *   参数被忽略，保留签名只为不破坏既有 import。
 */
export function abnormalLikelihoodFactory(): (rankClass: string) => number {
  return makeLikelihood(true);
}

/* ============================================================
 * 类别键
 * ============================================================ */

import { allRankClassKeys } from './preflopPriors.ts';

const KEYS = allRankClassKeys();

/** 默认类别总数（169） */
export const DEFAULT_TOTAL_CLASSES = KEYS.length;

/**
 * 类别的序号（仅用于展示与排序，**不是**牌力判据）。
 *
 * @deprecated 索引位置不是牌力序，不要用它判断牌力（红队 F-02）。
 */
export function defaultRankClassIndex(rankClass: string): number {
  return KEYS.indexOf(rankClass);
}

/**
 * 🔴 **动作类型 → 归一化的 6 档权重**（2026-09 审计修复的统一入口）。
 *
 * 这是 C2（跟注 ≠ 过牌）与 C3（范围必须看牌面）共同的基础：
 * 权重只表达「什么样的牌会做这个动作」，**用什么牌力档去索引它**
 * 由调用方决定 —— 翻前用 `tierOfRankClass(rankClass)`，
 * 翻后用**该组合在当前牌面上的形态**（见 `boardRelativeTierOf`）。
 *
 * @param kind `AGGRESSIVE` = 下注/加注/全下；`CALL` = 跟注；`CHECK` = 过牌
 * @param betRatioToPot 金额相对底池（可选；越大 ⇒ 越偏强牌）
 * @returns 长度 6 的归一化权重，索引 0 = 最强、5 = 垃圾
 */
export function likelihoodWeights(
  kind: LikelihoodActionKind,
  betRatioToPot?: number,
): readonly number[] {
  const ratio =
    betRatioToPot !== undefined && Number.isFinite(betRatioToPot) && betRatioToPot > 0
      ? betRatioToPot
      : 0;

  if (kind === 'CHECK') {
    // 过牌与任何牌力都相容 ⇒ 保持宽范围，不做任何收紧
    return normalizeLikelihood(NORMAL_WEIGHTS);
  }

  if (kind === 'CALL') {
    /*
     * 跟注强度因子（与 `makeCallLikelihood` 的文档一致）：
     * 0.2 池 ≈ 1.14，0.5 池 ≈ 1.45，1 池 ≈ 1.80，2 池 ≈ 2.30
     */
    const factor = Math.min(2.5, 0.6 + Math.sqrt(ratio) * 1.2);
    return normalizeLikelihood([
      CALL_WEIGHTS[0]! * factor,
      CALL_WEIGHTS[1]!,
      CALL_WEIGHTS[2]!,
      CALL_WEIGHTS[3]!,
      CALL_WEIGHTS[4]! / factor,
      CALL_WEIGHTS[5]! / factor,
    ]);
  }

  // 进攻性动作：沿用既有放大器（只放大顶级档 ⇒ 保序）
  const amplifier = ratio > 0.5 ? Math.min(4, Math.sqrt(Math.max(0.5, ratio)) * 1.5) : 1;
  return normalizeLikelihood(
    amplifier === 1
      ? ABNORMAL_WEIGHTS
      : [ABNORMAL_WEIGHTS[0]! * amplifier, ...ABNORMAL_WEIGHTS.slice(1)],
  );
}

/** 似然权重档位的索引（0 = 最强）。越界时钳到 5（垃圾档）。 */
export function tierWeightOf(weights: readonly number[], tier: number): number {
  const index = Number.isFinite(tier) ? Math.max(0, Math.min(5, Math.floor(tier))) : 5;
  return weights[index] ?? weights[weights.length - 1] ?? LIKELIHOOD_FLOOR;
}

/**
 * 进攻性动作（下注/加注/全下）的似然。
 *
 * @param betRatioToPot 下注额相对底池的比例（可选；影响范围收紧程度）
 */
export function abnormalLikelihood(betRatioToPot?: number): (rankClass: string) => number {
  return makeLikelihood(true, betRatioToPot);
}

/**
 * 被动动作（跟注/过牌）的似然。
 *
 * ⚠️ **这个函数把「跟注」与「过牌」当成同一件事**，那是 2026-09 审计确认的缺陷
 * （见 `callLikelihood`）。保留它只为兼容既有调用与测试；新代码应当用
 * `checkLikelihood` / `callLikelihood` 明确区分。
 *
 * @param betRatioToPot 面对的下注额相对底池的比例（可选）
 */
export function normalLikelihood(betRatioToPot?: number): (rankClass: string) => number {
  return makeLikelihood(false, betRatioToPot);
}

/**
 * 「过牌」的似然：**保持宽范围**。
 *
 * 过牌与任何牌力都相容（可以是用空气过牌-弃牌，也可以是慢打强牌），
 * 因此它几乎不提供信息 —— 这是刻意的：**不能因为对手过牌就把他的范围收窄**。
 */
export function checkLikelihood(): (rankClass: string) => number {
  return makeLikelihood(false, undefined);
}

/**
 * 🔴 **「跟注」的似然**（2026-09 审计修复，C2）。
 *
 * ## 修的是什么
 *
 * 修复前 `CALL` 与 `CHECK` 走**同一个** `normalLikelihood`，而它的
 * 「下注量放大器」只在 `bet/pot > 0.5` 时生效 ⇒ 正常跟注（≤0.5 池）
 * 与过牌的似然**逐位相同**。实测后果（独立复算，逐位吻合）：
 *
 * ```text
 * 翻前 3Bet 后：对手「翻牌跟注 + 转牌跟注」与「翻牌过牌 + 转牌过牌」
 *   得到**完全相同**的范围（TV = 0、KL = 0）
 *   河牌时的顶级牌质量 7.500% vs 翻前先验 8.148%、熵仍是先验的 98%
 * ⇒ 「他连跟两街」这件事在河牌几乎没有改变他的范围 —— 与直觉和事实都相反
 * ```
 *
 * ## 新模型（结构性判断，方向正确即可，不声称精确）
 *
 * 跟注夹在「过牌」与「加注」之间：
 *
 * | 档位 | 过牌 | **跟注** | 加注 |
 * |---|---|---|---|
 * | 顶级（AA/KK/QQ/AKs） | 1.2 | **1.6**（会跟，但比加注少得多） | 4.0 |
 * | 强 | 1.4 | **2.2** | 2.5 |
 * | 中 | 1.5 | **2.6**（跟注最常见的档） | 1.2 |
 * | 偏弱 | 1.4 | **1.8** | 0.7 |
 * | 弱 | 1.2 | **0.9** | 0.45 |
 * | 垃圾 | 1.0 | **0.5**（明显低于过牌：过牌可以带空气，跟注不行） | 0.3 |
 *
 * 再按**跟注额相对底池**调制：跟得越大，越像加注（顶级更重、垃圾更轻）。
 * 这与既有「下注量放大器」是同一个思想，只是把阈值从 `> 0.5` 改成对
 * **任何**跟注都生效的连续函数 —— 因为「跟 0.3 池」与「过牌」本来就不是一回事。
 *
 * @param betRatioToPot 面对的下注额相对底池的比例（可选）
 */
export function callLikelihood(betRatioToPot?: number): (rankClass: string) => number {
  return makeCallLikelihood(betRatioToPot);
}

/**
 * 跟注视然的实现：`CALL_WEIGHTS` + 按跟注额向上/向下调制。
 *
 * 调制方式刻意与 `makeLikelihood` 一致（放大顶级档），
 * 因为那条路径已经被证明**保序**（不会让强牌比弱牌更不可能继续）。
 */
function makeCallLikelihood(betRatioToPot?: number): (rankClass: string) => number {
  const ratio =
    betRatioToPot !== undefined && Number.isFinite(betRatioToPot) && betRatioToPot > 0
      ? betRatioToPot
      : 0;
  /*
   * 跟注强度因子：
   *   0.2 池 → 0.6 + √0.2×1.2 ≈ 1.14（小注：接近「宽范围继续」）
   *   0.5 池 → ≈ 1.45
   *   1.0 池 → ≈ 1.80
   *   2.0 池 → ≈ 2.30（超大注：几乎只剩强牌/强听牌）
   */
  const factor = Math.min(2.5, 0.6 + Math.sqrt(ratio) * 1.2);
  const weighted = [
    CALL_WEIGHTS[0]! * factor, // 顶级：跟得越大越可能是强牌在慢打/诱导
    CALL_WEIGHTS[1]!,
    CALL_WEIGHTS[2]!,
    CALL_WEIGHTS[3]!,
    CALL_WEIGHTS[4]! / factor, // 弱
    CALL_WEIGHTS[5]! / factor, // 垃圾：大注下几乎不可能
  ];
  const normalized = normalizeLikelihood(weighted);

  return (rankClass: string): number => {
    const tier = tierOfRankClass(rankClass);
    const value = normalized[tier] ?? normalized[normalized.length - 1]!;
    return Math.max(0, Math.min(1, value));
  };
}

/**
 * 模型自检（测试用）：确认单调倾向成立。
 *
 * 判据：顶级牌在进攻性动作下的似然 **严格大于** 垃圾牌；
 * 垃圾牌在被动动作下的似然 **严格大于** 顶级牌在被动动作下的似然。
 * 这两条就是「模型表达了什么」的全部内容 —— 除此之外不声称任何东西。
 */
/**
 * 模型自检（测试与启动期使用）。
 *
 * ## 🔴 为什么必须用**具名牌型**而不是数组首尾（红队 F-02 的第二次修复）
 *
 * 修复前的版本用 `KEYS[0]` 与 `KEYS[KEYS.length - 1]` 当「最好/最差」，
 * 并在注释里把它们写成 `AA` 与 `32o`。**那个注释是错的**：
 * `allRankClassKeys()` 的键序是「按最大牌降序，对子排在该最大牌的最前面」，
 * 因此数组**最后一个是 `22`**（不是 `32o`）。
 *
 * 于是自检实际比较的是 `22` vs `AA`，而它自己声称在比较 `32o` vs `AA` ——
 * 一个「通过」的自检在验证一个**不是它声称的不变量**。
 * 这与 F-02 的根因是同一类错误：**判据依赖数组位置而不是牌型本身**。
 *
 * 现在全部改用显式牌型名，并把 169 个类别逐档扫描：
 * 不再有任何一条判据依赖数组顺序。
 *
 * ## 本模型**真正**的不变量（与 `NORMAL_WEIGHTS` 的语义一致）
 *
 * 1. **进攻性单调**：牌力越强，主动下注/加注的似然越高（档位 0→5 严格递减）
 * 2. **被动性单峰**：跟注/过牌的似然在**中档**达到峰值 ——
 *    垃圾牌大多直接弃牌（最低），顶级牌更倾向主动进攻（次低），
 *    中间的投机牌才是跟注的主力
 * 3. **同手牌的攻防对比**：顶级牌「进攻 > 被动」，垃圾牌「被动 > 进攻」
 * 4. **人人有份**：任何类别在任何动作下的似然都 **> 0**
 *    （否则该类别会因一次更新被永久删除）
 *
 * 第 2 条曾经被错误地写成「垃圾牌的被动似然 > 顶级牌的被动似然」——
 * 那不是本模型的内容：`72o` 的被动似然（0.633）**低于** `AA` 的（0.760），
 * 因为 72o 绝大多数时候是**直接弃牌**，而不是跟注。
 */
export function selfCheckLikelihoodModel(): string[] {
  const problems: string[] = [];
  const abnormal = abnormalLikelihood();
  const normal = normalLikelihood();

  /**
   * 具名样本 —— **恰好每档一个**，且**不依赖任何数组顺序**。
   *
   * | 牌型 | 档 | 理由 |
   * |---|---|---|
   * | `AA` | 0 | QQ 及以上的大对子 |
   * | `JJ` | 1 | JJ-88 的中对子 |
   * | `A5s` | 2 | A 带脚同花（A9s-A5s） |
   * | `22` | 3 | 44-22 的小对子 |
   * | `A5o` | 4 | A 带脚非同花（A9o-A5o） |
   * | `72o` | 5 | 垃圾非同花 |
   *
   * ⚠️ 每档取一个，是为了让「档位期望值」这一列本身就成为断言 ——
   * 若 `tierOfRankClass` 改了分档，这里第一时间就会报错。
   */
  const TIER_SAMPLES: readonly (readonly [string, number])[] = [
    ['AA', 0],
    ['JJ', 1],
    ['A5s', 2],
    ['22', 3],
    ['A5o', 4],
    ['72o', 5],
  ];
  for (const [cls, expected] of TIER_SAMPLES) {
    const actual = tierOfRankClass(cls);
    if (actual !== expected) {
      problems.push(`tierOfRankClass('${cls}') 应为 ${expected}，实际 ${actual}`);
    }
  }

  // ---- 1. 进攻性单调：档位越高（越弱）似然越低 ----
  let prevAbnormal = Number.POSITIVE_INFINITY;
  for (const [cls] of TIER_SAMPLES) {
    const value = abnormal(cls);
    if (!(value <= prevAbnormal)) {
      problems.push(
        `进攻性似然必须随牌力单调不增：${cls} 的 ${value} > 上一档的 ${prevAbnormal}`,
      );
    }
    prevAbnormal = value;
  }
  if (!(abnormal('AA') > abnormal('72o'))) {
    problems.push(`进攻性似然应满足 AA > 72o（实际 ${abnormal('AA')} vs ${abnormal('72o')}）`);
  }

  // ---- 2. 被动性单峰：中档最高 ----
  //
  // 中档 = 「A 带脚同花 / 中小对子」这一档（`NORMAL_WEIGHTS` 的峰值档）。
  const peak = normal('A5s');
  if (!(peak > normal('AA'))) {
    problems.push(
      `被动似然应在中档达到峰值：中档 ${peak} 不大于顶级 ${normal('AA')} —— ` +
        '顶级牌更倾向主动进攻，而不是跟注',
    );
  }
  if (!(peak > normal('72o'))) {
    problems.push(
      `被动似然应在中档达到峰值：中档 ${peak} 不大于垃圾 ${normal('72o')} —— ` +
        '垃圾牌绝大多数时候直接弃牌',
    );
  }
  if (!(peak > normal('JJ'))) {
    problems.push(
      `被动似然应在中档达到峰值：中档 ${peak} 不大于中对子档 ${normal('JJ')}`,
    );
  }

  // ---- 3. 同手牌的攻防对比 ----
  if (abnormal('AA') <= normal('AA')) {
    problems.push(
      `顶级牌在进攻性动作下的似然应高于被动动作（攻 ${abnormal('AA')} vs 守 ${normal('AA')}）`,
    );
  }
  if (normal('72o') <= abnormal('72o')) {
    problems.push(
      `垃圾牌在被动动作下的似然应高于进攻动作（守 ${normal('72o')} vs 攻 ${abnormal('72o')}）`,
    );
  }

  // ---- 4. 人人有份：169 个类别逐个查，任何动作下都必须为正 ----
  const missing: string[] = [];
  for (const key of KEYS) {
    if (!(abnormal(key) > 0) || !(normal(key) > 0)) missing.push(key);
  }
  if (missing.length > 0) {
    problems.push(
      `有 ${missing.length} 个类别的似然不为正（下限 ${LIKELIHOOD_FLOOR}），` +
        `例如 ${missing.slice(0, 5).join(', ')} —— 这些类别会被一次更新永久删除`,
    );
  }

  // ---- 5. 值域：范围引擎要求 likelihood ∈ [0,1] ----
  for (const key of KEYS) {
    for (const [name, f] of [
      ['进攻', abnormal],
      ['被动', normal],
    ] as const) {
      const v = f(key);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        problems.push(`${name}似然 ${key} = ${v} 超出 [0,1]`);
        break;
      }
    }
  }

  return problems;
}
