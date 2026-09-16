/**
 * 🔴 **Range Compression**（2026-09 翻后升级 · P1）
 *
 * ## 为什么必须有它
 *
 * 审计实测（独立复算、逐位吻合）：修复前「翻牌跟注 + 转牌跟注」与
 * 「翻牌过牌 + 转牌过牌」给出**完全相同**的范围 —— 对手在河牌仍然拥有
 * 和翻牌一样多的垃圾牌。C2 已修底层似然，本模块把「压缩到了什么程度」
 * 变成**可读、可测、可参与 EV 比较**的状态量。
 *
 * ## 语义
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `strengthFloor` | 范围强度**下限**（0..1，越大 = 最弱的那些牌已经被排除） |
 * | `nutDensity` | 坚果密度（0..1） |
 * | `mediumStrengthDensity` | 中等成手密度 |
 * | `drawDensity` | 听牌密度 |
 * | `airDensity` | 空气密度 |
 * | `showdownDensity` | 摊牌价值密度 |
 * | `aggressionCredibility` | 他这次进攻的**可信度**（0..1：同样的动作，尺寸越大、街越靠后、人越少 ⇒ 越可信） |
 *
 * ⚠️ 这些是 **0..1 的启发式标尺**，不是频率估计，也不声称是 solver 数据。
 * 它们的作用是**排序与阈值**，不是「他有 37% 诈唬」这种编造。
 *
 * ## 🔴 `strengthFloor` 的语义必须是「尾部」，不能是「占比」（审计修复）
 *
 * 第一版用 `strengthFloor = strongShare + factor × 0.55`，而 `strongShare` 是
 * 「范围里已成强牌的**占比**」。两者混用会饱和：成对牌面 K♠K♦6♣2♣9♣ 上
 * 每一手都是「一对 K（带踢脚）」，`strongShare` 实测 = **1.0000** ⇒
 * 「他的最弱牌也很强」这个结论被下游（Value Bet Gate）当成了
 * 「没有任何更差的牌能跟」 ⇒ 坚果同花（权益 94.7%）拒不下注。
 *
 * 现在 `strengthFloor` 只由**弱尾质量**（档 ≥4 的占比）驱动：
 * 弱尾被压缩掉多少，下限才抬高多少 —— 这才叫「下限」，且**永远不会因为
 * 牌面本身让所有人成对而饱和**（成对牌面上弱尾本来就接近 0，那是事实，
 * 但下游不再用它回答「有没有更差的牌」这个问题，那一问改由
 * `OpponentRangeFacts.weakerShare` 精确回答）。
 *
 * 同时**密度**类字段（`nutDensity`）改回由 `strongShare` 驱动 —— 密度是占比，
 * 占比就该用占比算。此前它由 `strengthFloor` 派生，两个语义被绑死。
 *
 * ## 压缩因子（使用者点名的公式）
 *
 * ```text
 * compressionFactor = f(betSize / pot, street, multiway, playerProfile, boardTexture)
 * ```
 *
 * 方向的正确性（这是本模块唯一声称的东西）：
 *
 * | 变量 | 方向 |
 * |---|---|
 * | 尺寸 / 底池 ↑ | 压缩 ↑（大注继续 = 更强） |
 * | 街越靠后 | 压缩 ↑（同样的钱在河牌代表更多） |
 * | 人数 ↑ | 压缩 ↓（多人池里继续的门槛更低、范围更宽） |
 * | 对手越松/越黏 | 压缩 ↓ |
 * | 牌面越湿（听牌多） | 压缩 ↓（湿面上继续范围包含更多听牌） |
 */

import type { Street } from '../types.ts';
import type { QuickProfileLike } from './exploit.ts';

export type RangeCompressionState = {
  strengthFloor: number;
  nutDensity: number;
  mediumStrengthDensity: number;
  drawDensity: number;
  airDensity: number;
  showdownDensity: number;
  aggressionCredibility: number;
};

export type CompressionInput = {
  /** 本次继续的金额 / 当时的底池（不知道时传 null） */
  betRatioToPot: number | null;
  street: Street;
  /** 已实现对手数（≥2 = 多人） */
  opponentCount: number;
  quickProfile: QuickProfileLike;
  /** 牌面湿润度 0..1（听牌/连接度越高越大；由 boardDelta 提供） */
  wetness: number;
  /** 是否进攻性动作（下注/加注）而不是跟注/过牌 */
  aggressive: boolean;
  /**
   * 🔴 **画像可信度 0..1**。生产路径必须传真实可信度 ——
   * 可信度 0 时画像对压缩**完全无效**（见 `profileCompressionMultiplier`）。
   */
  profileConfidence?: number;
};

const STREET_WEIGHT: Readonly<Record<Street, number>> = Object.freeze({
  PREFLOP: 0,
  FLOP: 1 / 3,
  TURN: 2 / 3,
  RIVER: 1,
});

/**
 * 压缩因子（0..1）：**越大 = 这次继续把范围压得越紧**。
 *
 * 公式是显式的结构式，不是拟合出来的参数。
 */
export function compressionFactor(input: CompressionInput): number {
  const ratio = input.betRatioToPot === null ? 0.5 : Math.max(0, Math.min(3, input.betRatioToPot));
  const sizePart = Math.min(1, ratio / 1.5); // 1.5 池 ≈ 满值
  const streetPart = STREET_WEIGHT[input.street] ?? 0;
  const multiwayPart = input.opponentCount >= 2 ? 1 / (1 + 0.35 * (input.opponentCount - 1)) : 1;
  const wetnessPart = 1 - 0.3 * Math.max(0, Math.min(1, input.wetness));
  const profilePart = profileCompressionMultiplier(input.quickProfile, input.profileConfidence);

  const raw =
    (input.aggressive ? 0.45 + 0.55 * sizePart : 0.3 + 0.4 * sizePart) *
      (0.7 + 0.3 * streetPart) *
      multiwayPart *
      wetnessPart *
      profilePart;

  return Math.max(0, Math.min(1, raw));
}

/**
 * 玩家类型对「这次继续有多强」的修正。
 *
 * | 类型 | 修正 | 理由 |
 * |---|---|---|
 * | 跟注站 / 松 | ↓ | 他们用很宽的范围跟注，同样的动作信息量更低 |
 * | 紧 / 极紧 | ↑ | 他们继续时手里更实在 |
 * | 疯子 / 诈唬型 | ↓ | 他们的进攻不区分牌力 |
 * | 不诈唬型 | ↑ | 他们的进攻几乎总是价值 |
 *
 * ## 🔴 必须按画像**可信度**缩放（审计抓到的「高」severity）
 *
 * 第一版直接返回修正系数、**不看可信度**。后果（实测）：用户手选画像
 * 在 `confidence = 0` 时仍然通过这个乘数**改变动作**
 *（`UNKNOWN = BET 3.25BB` → `VERY_TIGHT = CHECK`），而同一份输出里
 * 又打印「剥削偏移被缩放到 0（不做任何画像调整）」—— **界面文案与行为相反**，
 * 属于本项目定义的最危险一类缺陷。
 *
 * 现在：`修正 = 1 + (基础修正 − 1) × 可信度` ⇒ 可信度 0 时**恒等于 1**，
 * 与 exploit 偏移量的缩放规则完全一致。
 */
export function profileCompressionMultiplier(
  profile: QuickProfileLike,
  /**
   * 画像可信度 0..1。省略时按 1 处理（仅供单测直接调用；
   * 生产路径**必须**传 `exploitSourceOf` 给出的可信度）。
   */
  confidence = 1,
): number {
  const base = baseProfileMultiplier(profile);
  const scale = Math.max(0, Math.min(1, confidence));
  return 1 + (base - 1) * scale;
}

function baseProfileMultiplier(profile: QuickProfileLike): number {
  switch (profile) {
    case 'CALLING_STATION':
      return 0.7;
    case 'VERY_LOOSE':
      return 0.8;
    case 'LOOSE':
      return 0.88;
    case 'MANIAC':
      return 0.72;
    case 'BLUFF_HEAVY':
      return 0.85;
    case 'TIGHT':
      return 1.12;
    case 'VERY_TIGHT':
      return 1.25;
    case 'UNDERBLUFFER':
      return 1.15;
    default:
      return 1;
  }
}

/**
 * 从「被压缩的程度」推出状态量。
 *
 * @param base 压缩前的基线（通常来自 `opponentRangeFacts`：强牌占比 / 平均档位；
 *   没有范围事实时用「均匀先验」的保守基线）
 */
export function compressionStateOf(
  input: CompressionInput,
  base: {
    strongShare: number;
    drawShare: number;
    meanTier: number;
    /**
     * 范围的**弱尾质量**（档 ≥4 的占比，0..1）。省略时由 `meanTier`
     * 按单调结构式回退（仅供拿不到直方图的调用方；生产路径传真实值）。
     */
    weakShare?: number;
  } | null,
): RangeCompressionState {
  const factor = compressionFactor(input);

  /*
   * 基线（未压缩时）：
   * - 有范围事实 ⇒ 用它（这是**真实**数据）
   * - 没有 ⇒ 用「宽范围」的保守基线，并明确这是假设而不是观测
   */
  const baseStrong = base === null ? 0.18 : Math.max(0, Math.min(1, base.strongShare));
  const baseDraw = base === null ? 0.2 : Math.max(0, Math.min(1, base.drawShare));
  const baseMeanTier = base === null ? 3.2 : Math.max(0, Math.min(5, base.meanTier));
  const baseAir = Math.max(0, Math.min(1, (baseMeanTier / 5) * 0.75));
  /*
   * 🔴 弱尾质量：优先用**真实直方图**（档 ≥4 的占比），否则由平均档位按
   * **单调**结构式回退（meanTier ≤2.2 ⇒ 没有弱尾；meanTier 5 ⇒ 整段都是弱牌）。
   */
  const weakTail =
    base === null ? 0.45 : Math.max(0, Math.min(1, base.weakShare ?? (baseMeanTier - 2.2) / 2.8));

  /*
   * 压缩把质量从「空气」搬向「强牌 / 中等牌」，听牌在水位下降时也被挤压。
   *
   * 🔴 `strengthFloor` 只看**弱尾被压掉多少**（见文件头说明）：弱尾为 0 时
   * 下限为 1（他的范围里确实没有弱牌了），弱尾为满时压缩前下限为 0 —— 但
   * 「下限」从此**不再**被用来回答「有没有更差的牌能跟」那个问题
   *（那一问由 `OpponentRangeFacts.weakerShare` 精确回答）。
   */
  const strengthFloor = Math.max(0, Math.min(1, 1 - weakTail * (1 - factor * 0.75)));
  const airDensity = Math.max(0, baseAir * (1 - factor * 0.8));
  const drawDensity = Math.max(0, baseDraw * (1 - factor * 0.35));
  /*
   * 坚果密度 = **强牌占比**被压缩抬升后的值（占比用占比算）。
   * 它回答「他手里有多大概率是强牌」，不回答「他手里有没有更差的牌」。
   */
  const nutDensity = Math.max(0, Math.min(1, baseStrong * (0.7 + 0.6 * factor)));
  const mediumStrengthDensity = Math.max(
    0,
    Math.min(1, 1 - airDensity - nutDensity - drawDensity * 0.5),
  );
  const showdownDensity = Math.max(0, Math.min(1, mediumStrengthDensity * 0.8));

  return {
    strengthFloor,
    nutDensity,
    mediumStrengthDensity,
    drawDensity,
    airDensity,
    showdownDensity,
    aggressionCredibility: factor,
  };
}

/** 牌面湿润度（0..1）——供压缩与价值守门器共用 */
export function boardWetnessOf(facts: {
  maxSuitCount: number;
  maxRunLength: number;
  pairedBoard: boolean;
}): number {
  // 非有限数一律按「没有这个特征」处理（审计指出的未守卫入口）
  const suitCount = Number.isFinite(facts.maxSuitCount) ? facts.maxSuitCount : 1;
  const runLength = Number.isFinite(facts.maxRunLength) ? facts.maxRunLength : 2;
  const flushPart = Math.max(0, Math.min(1, (suitCount - 1) / 3));
  const straightPart = Math.max(0, Math.min(1, (runLength - 2) / 3));
  const pairedPart = facts.pairedBoard ? 0.15 : 0;
  return Math.max(0, Math.min(1, 0.5 * flushPart + 0.5 * straightPart + pairedPart));
}
