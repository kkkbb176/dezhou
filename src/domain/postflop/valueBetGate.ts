/**
 * 🔴 **Value Bet Gate**（2026-09 翻后升级 · P1）
 *
 * ## 为什么必须有它
 *
 * 审计实测：修复前「无人下注」时的唯一判据是
 * `equity > 0.55 且 tier ≠ WEAK`（`decisionEngine.ts:972-975`），
 * 而 BET / RAISE 的 `ev` 恒为 `null`（「下注 EV 依赖弃牌率，本项目没有可信估计」）
 * ⇒ **下注类动作永远不参与 EV 比较**，分类永远是 MARGINAL。
 *
 * 结果：像「大量更差的牌会弃、大量更好的牌会跟、而我摊牌价值很高」这种
 * **显然该过牌**的局面，引擎照样下注 45% 底池。
 *
 * ## 使用者点名的五个问题（逐条落到字段上）
 *
 * | # | 问题 | 字段 |
 * |---|---|---|
 * | 1 | 有哪些**更差**的牌会跟？ | `worseHandsCanCall` / `worseCallDensity` |
 * | 2 | 有哪些**更好**的牌会跟？ | `betterHandsContinue` / `betterContinueDensity` |
 * | 3 | 更好的牌会不会**加注**？ | `raiseRisk` |
 * | 4 | 如果过牌，我有多大的**摊牌价值**？ | `showdownValue` |
 * | 5 | 下注是否迫使「更差但有权益」的牌弃掉？ | `protectionBenefit` |
 *
 * ## 核心 +EV 规则（使用者给定，此处**只调 EV 分数，不硬编码动作**）
 *
 * ```text
 * 摊牌价值高 + 更差牌跟注少 + 更好牌继续多  ⇒  下注 EV ↓、过牌 EV ↑
 * ```
 *
 * ## 🔴 第二轮对抗性审计修复的两个 CRITICAL（口径错误，不是调参）
 *
 * ### ① 问题 1 / 2 必须**相对于我这手牌**回答
 *
 * 审计实测（真实管线，Hero BTN A♣Q♣ 坚果同花，牌面 K♠K♦6♣2♣9♣，UTG 三条街全过牌）：
 *
 * ```text
 * 权益 94.7%  ⇒  同一份输出里 worseCallDensity = 0.049 ⇒ 判定 NOT_VALUE、引擎过牌
 * 即「我领先 94.7%」与「没有任何更差的牌能跟」同时成立 —— 自相矛盾
 * ```
 *
 * 根因：问题 1「有哪些**更差**的牌会跟？」被用「他的范围整体有多强」来回答，
 * 而后者在成对/成花牌面上必然饱和（成对牌面上每手都是「一对 K」，
 * 实测 `strongShare = 1.0000`）。这与我的牌无关，所以拿坚果和拿空气得到同一个答案。
 *
 * 现在问题 1 / 2 只由 `rangeComparison`（`compareHands` 逐组合精确比较）
 * 或由权益反推的单对手胜负质量回答。**坚果牌在这里自动得到「几乎全是更差的牌」**，
 * 不再依赖任何是否饱和的占比。
 *
 * ### ② `valuePart` 的分母必须与基线同源
 *
 * 第一版 `valuePart = (权益 − 基线) / 0.35`，权益 ≥0.85 时整段饱和到 1
 * ⇒ 坚果同花（94.7%）与最小同花（88.0%）拿到**相同**的优势分，下注分的排序
 * 只能由保护分决定，实测出现「最小同花的下注分 = 坚果同花的 1.22 倍」。
 * 现在分母 = `1 − 公平基线`，`valuePart` 在整段上严格单调于权益。
 *
 * ### ③ 保护收益在河牌恒为 0
 *
 * 河牌没有补牌，「让更差但有权益的牌弃牌」这件事不存在。修复前河牌仍能拿到
 * 最高 0.15 的保护分（与 0.06 的判定阈值同量级），足以翻转薄价值判定。
 *
 * ## ⚠️ 绝不伪造精确 EV
 *
 * `estimatedBetEVScore` / `estimatedCheckEVScore` 是 **0..1 的启发式比较分**，
 * 不是 solver EV、不是货币期望。字段名与 UI 都必须标注这一点。
 */

import { RelativeHandRole } from './types.ts';
import { multiwayAdjustment } from './multiway.ts';
import type { RangeCompressionState } from './rangeCompression.ts';

export type ValueBetVerdict =
  | 'CLEAR_VALUE'
  | 'THIN_VALUE'
  | 'MARGINAL'
  | 'PREFER_CHECK'
  | 'NOT_VALUE';

export type ValueBetAssessment = {
  worseHandsCanCall: boolean;
  worseCallDensity: number;
  betterHandsContinue: boolean;
  betterContinueDensity: number;
  raiseRisk: number;
  showdownValue: number;
  /**
   * 🔴 **未来补牌保护分**（原名 `protectionBenefit`，语义不变，名字收窄）。
   *
   * 定义严格限定为：「通过下注迫使对手放弃**仍有未来改善权益**的牌」。
   * 因此：
   *
   * ```text
   * street === 'RIVER'  ⇒  futureCardProtectionScore === 0
   * ```
   *
   * 河牌没有补牌 ⇒ 这个收益**在定义上**为零。
   *
   * ⚠️ 它与下面这些**完全不同的东西**分开存放，不得混为一谈
   *（使用者 §12：不能把价值/诈唬/弃牌率都说成 protection 然后一起清零）：
   *
   * | 概念 | 字段 |
   * |---|---|
   * | 起手价值 | `estimatedBetEVScore` 中的 `valuePart` 部分 |
   * | 诈唬收益 | `bluffComponent`（角色为空气/听牌时） |
   * | 弃牌率 | **不建模**（本项目没有可信的弃牌率估计，见 `decisionEngine`） |
   * | 未来补牌保护 | 本字段 |
   */
  futureCardProtectionScore: number;
  /** 兼容别名：与 `futureCardProtectionScore` 恒等（旧字段名） */
  protectionBenefit: number;
  /**
   * 对手范围里**比我这手牌差**的概率质量（精确比较；拿不到范围时由权益反推）。
   * 这是问题 1 的原始输入，单独暴露以便界面直接显示「更差 / 更好」两个口径。
   */
  weakerShare: number;
  /** 对手范围里**比我这手牌好**的概率质量（同上） */
  strongerShare: number;
  /**
   * 这个判定用的是**哪一个体系**的指标（使用者 §8 / §19）。
   *
   * ```text
   * 'PREFERENCE_SCORE' —— 只有 0..1 的启发式比较分（本项目当前口径）
   * 'CHIP_EV'          —— 真的有货币单位的动作 EV（`math.callEV`，节点增量口径）
   * ```
   *
   * ⚠️ 本模块**只产出偏好分**，永远不产出 chip EV ⇒ 恒为 `PREFERENCE_SCORE`。
   * 字段存在是为了让下游/界面能**显式**知道「动作与指标同体系」这件事，
   * 而不是靠约定。
   */
  metricKind: 'PREFERENCE_SCORE' | 'CHIP_EV';
  estimatedBetEVScore: number;
  estimatedCheckEVScore: number;
  verdict: ValueBetVerdict;
  reasonsZh: readonly string[];
};

export type ValueGateInput = {
  role: RelativeHandRole;
  /** 对全部已实现对手的权益（0..1） */
  heroEquity: number;
  opponentCount: number;
  compression: RangeCompressionState;
  /** 牌面湿润度 0..1 */
  wetness: number;
  spr: number | null;
  /** 我是否有主动权（无人下注时几乎总是 true） */
  hasInitiative: boolean;
  /** 玩家画像带来的薄价值修正（`exploit.ts` 给出；无画像为 0） */
  thinValueDelta: number;
  /** 诈唬修正（`exploit.ts`） */
  bluffDelta: number;
  /** 我的下注是否会让「更差但有权益」的牌弃掉（听牌面 / 高张面为真） */
  protectionRelevant: boolean;
  /**
   * 🔴 **对手范围与我这手牌的逐组合比较**（来自 `OpponentRangeFacts`）。
   *
   * 问题 1「有哪些**更差**的牌会跟」与问题 2「有哪些**更好**的牌会跟」都是
   * **相对于我的牌**的问题，只有这份精确比较能回答（审计抓到的 CRITICAL：
   * 用「他的范围整体多强」冒充这两问，导致坚果牌拒不下注）。
   *
   * 传 `null`（拿不到范围）时，由**权益**反推单对手的胜负质量
   * （`每对手不输给我的概率 = 权益^(1/人数)`，平局按劣势一侧处理）——
   * 这是从既有权益引擎的输出推导，不是凭空估一个数。
   */
  rangeComparison?: { weakerShare: number; strongerShare: number } | null;
  /**
   * 后面还有没有牌发（河牌 = false）。
   *
   * 🔴 保护收益只可能存在于「还有牌要发」的街上：河牌没有补牌，
   * 「让更差但有权益的牌弃牌」这件事在河牌**不存在**。省略时按 `true`
   * 处理（仅供无法确定街道的直接调用方；生产路径必须传）。
   */
  hasCardsToCome?: boolean;
};

/** 角色 → 0..1 的强度刻度（仅用于**比较**，不是胜率） */
export function roleStrengthOf(role: RelativeHandRole): number {
  switch (role) {
    case RelativeHandRole.NUT_VALUE:
      return 1;
    case RelativeHandRole.STRONG_VALUE:
      return 0.82;
    case RelativeHandRole.MEDIUM_VALUE:
      return 0.62;
    case RelativeHandRole.THIN_VALUE:
      return 0.45;
    case RelativeHandRole.BLUFF_CATCHER:
      return 0.38;
    case RelativeHandRole.SEMI_BLUFF:
      return 0.35;
    case RelativeHandRole.DRAW:
      return 0.3;
    case RelativeHandRole.SHOWDOWN_VALUE:
      return 0.28;
    case RelativeHandRole.PURE_BLUFF:
      return 0.12;
    default:
      return 0.05;
  }
}

/**
 * 有限数守卫：NaN / ±Infinity 一律回落到给定的默认值。
 *
 * 审计指出的未守卫入口（当前输入路径不可达，但成本极低）：
 * `assessValueBet(heroEquity = NaN)` 会让 `estimatedBetEVScore` 变成 `NaN`
 * —— 而 `?? 0` 拦不住 `NaN`（它不是 `null`/`undefined`）。
 */
const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

const clamp01 = (v: number): number => Math.max(0, Math.min(1, finiteOr(v, 0)));

/**
 * 评估「下注取值」是否成立。
 *
 * 全部输入都是**已知事实**（权益、范围与我这手牌的精确比较、牌面湿润度、人数、
 * SPR、角色），没有任何针对具体牌面的分支。
 */
export function assessValueBet(input: ValueGateInput): ValueBetAssessment {
  const strength = roleStrengthOf(input.role);
  const multi = multiwayAdjustment(input.opponentCount);
  const reasons: string[] = [];
  const equity = clamp01(input.heroEquity);
  const opponentCount = Math.max(1, Math.round(finiteOr(input.opponentCount, 1)));

  /*
   * ---- 问题 1 / 2 的口径：**相对于我这手牌** ----
   *
   * 审计实测反例：成对牌面 K♠K♦6♣2♣9♣ 上 `strongShare = 1.0000`
   *（每手都是「一对 K」），而 Hero 拿坚果同花、权益 94.7% 时
   * 旧公式仍给出 `worseCallDensity = 0.049` ⇒ 判定「没有任何更差的牌能跟」。
   * 「我领先 94.7%」与「没人能用更差的牌跟」不可能同时成立 —— 口径错了。
   *
   * 现在：
   *   weakerShare   = 他的范围里**比我这手牌差**的质量（精确比大小）
   *   strongerShare = **比我这手牌好**的质量
   * 拿不到范围比较时，由权益反推（`每人` 的胜负质量），平局并入劣势一侧。
   */
  const perOpponentNotLose = Math.pow(equity, 1 / opponentCount);
  const weakerShare = clamp01(input.rangeComparison?.weakerShare ?? perOpponentNotLose);
  const strongerShare = clamp01(input.rangeComparison?.strongerShare ?? 1 - perOpponentNotLose);

  /*
   * 问题 1：更差的牌会不会跟？
   *
   * 判据 = 「他手里有多少更差的牌」×「他有多愿意用非坚果牌继续」。
   * 前者是**相对于我的牌**的质量（`weakerShare`）；后者来自范围压缩状态
   *（摊牌价值密度 / 中等牌密度：他越黏，越可能用更差的牌跟）。
   */
  const stickiness = clamp01(
    input.compression.showdownDensity * 0.6 + input.compression.mediumStrengthDensity * 0.4 + 0.25,
  );
  const worseCallDensity = clamp01(
    weakerShare * (0.55 + 0.45 * stickiness) - multi.multiwayValueThresholdAdjustment * 0.5,
  );
  const worseHandsCanCall = worseCallDensity > 0.25;

  /*
   * 问题 2：更好的牌会不会继续？
   *
   * 判据 = 「他手里有多少比我这手牌好的牌」（`strongerShare`）× 他继续的可信度。
   * 坚果级牌力在这里**自动**得到 0 —— 这正是它应有的待遇
   *（修复前这一项由「他的范围整体多强」驱动，与我的牌无关 ⇒ 坚果牌被罚）。
   */
  const betterContinueDensity = clamp01(
    strongerShare * (0.6 + 0.4 * input.compression.aggressionCredibility),
  );
  const betterHandsContinue = betterContinueDensity > 0.45;

  /*
   * 问题 3：更好的牌会不会加注？
   *
   * 加注风险 = 「有多少牌比我好」× 进攻可信度 + 少量**诈唬加注**成分
   *（后者与我的牌无关，所以单独一项，且权重低）；
   * 且**听牌未成的湿面会降低**这个风险（他的加注里可能有半诈唬）。
   */
  const raiseRisk = clamp01(
    strongerShare * 0.7 +
      input.compression.aggressionCredibility * 0.15 -
      clamp01(input.wetness) * 0.1,
  );

  /*
   * 问题 4：过牌的摊牌价值。
   *
   * 「我这手牌在摊牌时能赢多少」= 相对强度刻度与**真实权益**的结合
   *（两者都随牌力单调）。修复前它由「他的范围下限」驱动 ⇒ 同样被成对牌面
   * 饱和到「摊牌价值恒定偏低」，与权益脱钩。
   */
  const showdownValue = clamp01(strength * 0.5 + equity * 0.5);

  /*
   * 问题 5：保护收益。
   *
   * 只在「牌面有听牌/高张」**且后面还有牌发**时存在（`protectionRelevant`），
   * 且**不等于价值** —— 它是「让更差但有权益的牌弃牌」的收益。
   * 河牌没有任何补牌 ⇒ 这一项必然为 0（审计实测：修复前河牌仍能拿到保护分，
   * 于是「最小同花」靠保护分超过「坚果同花」，下注分对牌力非单调）。
   */
  const hasCardsToCome = input.hasCardsToCome ?? true;
  const protectionBenefit =
    input.protectionRelevant && hasCardsToCome
      ? clamp01(clamp01(input.wetness) * 0.6 + (1 - input.compression.airDensity) * 0.2)
      : 0;

  /*
   * ---- EV 分数（0..1 的启发式比较分）----
   *
   * valuePart   ：我方优势（权益 − 门槛）越大越值
   * callerPart  ：更差的牌会跟（= 真价值）
   * riskPart    ：更好的牌继续/加注（= 负项）
   * protectPart ：保护收益（真收益，但不是价值 ⇒ 权重更低）
   * bluffPart   ：诈唬成分（空气/听牌时才有意义）
   */
  /*
   * 🔴 **权益基线必须按人数走**（审计抓到的 MAJOR）。
   *
   * 第一版把 0.5 当成「无优势基线」，但 `heroEquity` 是**对全部已实现对手**
   * 的权益（多人口径）：单挑的公平基线是 50%，而 4 人池的公平基线是 25%。
   * 用 0.5 当基线会让 4 人池里 40% 的真实优势被判成「弱」。
   *
   * 🔴 **分母必须用同一把尺子**（第二轮审计抓到的 CRITICAL）：
   * 第一版分母是固定的 `0.35`，于是权益 ≥0.85 时 `valuePart` 全部饱和到 1
   * —— 坚果同花（94.7%）与最小同花（88.0%）拿到**完全相同**的优势分，
   * 下注分的排序只能由保护分/阻断牌决定 ⇒ 实测「最小同花的下注分是坚果同花的
   * 1.22 倍」。现在分母 = `1 − 公平基线`，`valuePart` 在整段上**严格单调**
   * 于权益：权益越高，优势分越高（这正是「EV 更高」的定义方向）。
   */
  const fairShare = 1 / (opponentCount + 1);
  const valuePart = clamp01((equity - fairShare) / Math.max(1e-6, 1 - fairShare));
  const bluffComponent =
    input.role === RelativeHandRole.PURE_BLUFF || input.role === RelativeHandRole.SEMI_BLUFF
      ? clamp01(clamp01(input.wetness) * 0.4 + (1 - input.compression.airDensity) * 0.2 + 0.2)
      : 0;

  const betScoreRaw =
    valuePart * (0.5 + 0.5 * worseCallDensity) + // 更差牌会跟 ⇒ 价值真正兑现
    bluffComponent * (0.5 - multi.multiwayBluffPenalty) +
    protectionBenefit * 0.15 -
    betterContinueDensity * 0.35 -
    raiseRisk * 0.2;

  /*
   * 🔴 **核心 +EV 规则**：摊牌价值高 + 更差的牌跟得少 + 更好的牌继续多
   * ⇒ 下注 EV 下降、过牌 EV 上升。
   * 这不是「硬编码过牌」—— 它只改分数，最终动作由分数比较决定。
   *
   * ⚠️ 过牌分的构成经过一次**重标定**（测试抓到的问题）：
   * 第一版给摊牌价值 0.55 的权重、对「更差牌会跟」只扣 0.1，
   * 结果**跟注站局面下薄价值顶对也被判成过牌**（bet 0.091 vs check 0.228）——
   * 那正是使用者点名要防的「Value Bet Gate 把所有薄价值都 check 掉」。
   * 现在：摊牌价值的权重降到 0.35，且「更差牌会跟」的惩罚与跟注意愿成正比。
   */
  const trapCondition =
    showdownValue > 0.55 && !worseHandsCanCall && betterContinueDensity > 0.4;
  const checkScoreRaw =
    showdownValue * 0.35 +
    (worseHandsCanCall ? -0.15 * worseCallDensity : 0.1) +
    (trapCondition ? 0.25 : 0);

  const betScore = clamp01(
    betScoreRaw + (input.role === RelativeHandRole.THIN_VALUE ? input.thinValueDelta : 0) +
      (bluffComponent > 0 ? input.bluffDelta : 0),
  );
  const checkScore = clamp01(checkScoreRaw);

  if (trapCondition) {
    reasons.push(
      '摊牌价值高、更差的牌跟注意愿低、更好的牌会继续 ⇒ 下注的边际收益下降，过牌的相对分数上升（**只调 EV，不硬编码过牌**）',
    );
  }
  reasons.push(
    `对手范围与我的牌逐组合比较：更差 ${(weakerShare * 100).toFixed(1)}% / 更好 ${(strongerShare * 100).toFixed(1)}%` +
      (input.rangeComparison == null ? '（无范围数据，由权益反推）' : ''),
  );
  if (betterHandsContinue) {
    reasons.push(
      `对手范围里有 ${(strongerShare * 100).toFixed(1)}% 的牌比我这手更好且会继续 ⇒ 价值下注容易被反制`,
    );
  }
  if (raiseRisk > 0.55) reasons.push('被加注的风险偏高（比他好的牌占比 × 进攻可信度）');
  if (!worseHandsCanCall) {
    reasons.push(
      `更差的牌跟注意愿不足（更差占比 ${(weakerShare * 100).toFixed(1)}%、黏度 ${stickiness.toFixed(2)}）：这不是一个「取值」场合`,
    );
  } else if (weakerShare > 0.6) {
    reasons.push(`对手范围里 ${(weakerShare * 100).toFixed(1)}% 的牌比我这手差 ⇒ 存在取值对象`);
  }
  if (protectionBenefit > 0.4) {
    reasons.push('牌面有听牌/高张且后面还有牌发：下注有**保护收益**（但它不是价值）');
  }
  if (input.protectionRelevant && !hasCardsToCome) {
    reasons.push('河牌没有任何补牌 ⇒ **保护收益恒为 0**（不存在「让听牌弃牌」这件事）');
  }
  if (multi.multiwayValueThresholdAdjustment > 0) {
    reasons.push(
      `多人池（${opponentCount} 家）：价值门槛抬高 ${multi.multiwayValueThresholdAdjustment.toFixed(3)}、诈唬惩罚 ${multi.multiwayBluffPenalty.toFixed(3)}`,
    );
  }

  const gap = betScore - checkScore;
  const verdict: ValueBetVerdict =
    gap >= 0.18
      ? 'CLEAR_VALUE'
      : gap >= 0.06
        ? 'THIN_VALUE'
        : gap > -0.06
          ? 'MARGINAL'
          : gap > -0.18
            ? 'PREFER_CHECK'
            : 'NOT_VALUE';

  return {
    worseHandsCanCall,
    worseCallDensity,
    betterHandsContinue,
    betterContinueDensity,
    raiseRisk,
    showdownValue,
    futureCardProtectionScore: protectionBenefit,
    protectionBenefit,
    weakerShare,
    strongerShare,
    /*
     * ⚠️ 本模块**永远**只产出偏好分：它没有对手动作概率，也没有 payoff，
     * 因此不满足「EV = Σ P(outcome) × payoff(outcome)」的定义。
     * 真正的 chip EV 在 `math.callEV`（节点增量口径，带单位与参考点）。
     */
    metricKind: 'PREFERENCE_SCORE',
    estimatedBetEVScore: betScore,
    estimatedCheckEVScore: checkScore,
    verdict,
    reasonsZh: reasons,
  };
}
