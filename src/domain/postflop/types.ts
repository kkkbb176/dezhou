/**
 * 翻后决策的共享类型（2026-09 翻后升级 · P1）
 *
 * ## 这一层的定位
 *
 * ```text
 * Theory Baseline（既有：底池赔率 / 权益 / 门槛）
 *        ↓
 * Relative Hand Strength   ← relativeHandRole.ts
 *        ↓
 * Range Compression        ← rangeCompression.ts（含 boardDelta.ts）
 *        ↓
 * EV Guard                 ← valueBetGate.ts / multiway.ts / commitment.ts
 *        ↓
 * Human Exploit Adjustment ← exploit.ts（**只做受约束偏移，永不覆盖硬数学**）
 *        ↓
 * Final Decision           ← evScore.ts（动作与尺度分离）
 * ```
 *
 * ## 三条贯穿全层的纪律
 *
 * 1. **不针对具体牌面写死动作**。所有「危险牌」都只转成**分数**（`BoardDelta`），
 *    再由 EV 比较决定动作 —— 没有任何 `if (同花完成) then check`。
 * 2. **不伪造精确 EV**。全部输出是 `0..1` 的**启发式比较分**，字段名与文档都
 *    明确标注，绝不出现在界面上伪装成 solver EV 的货币数字。
 * 3. **信息不足时返回 `null`，不返回编造的值**。「不知道」与「等于 0」是两件事。
 */

import type { Card } from '../types.ts';
import type { HandShape } from '../poker/handDescription.ts';
import type { Street } from '../types.ts';

/**
 * Hero 的相对牌力角色（**相对于牌面与对手范围**，不是绝对牌型）。
 *
 * ⚠️ 与 `HandCategory`（1..9 的绝对牌型）是两件不同的事：
 * 同一个「一对」在不同牌面 / 不同对手范围下可以是顶对、中等价值、抓诈牌或空气。
 */
export const RelativeHandRole = {
  /** 坚果级：几乎不可能被更好的牌跟注/加注（同花顺/四条/葫芦，或权益极高） */
  NUT_VALUE: 'NUT_VALUE',
  /** 强价值：三条/顺子/同花级，或权益显著领先 */
  STRONG_VALUE: 'STRONG_VALUE',
  /** 中等价值：顶对/超对/两对，能取值但不该把底池做大到失控 */
  MEDIUM_VALUE: 'MEDIUM_VALUE',
  /** 薄价值：中等对子等，只在「更差的牌会跟」时才有价值 */
  THIN_VALUE: 'THIN_VALUE',
  /** 抓诈牌：只赢诈唬，面对下注的价值来自底池赔率 + 对手诈唬倾向 */
  BLUFF_CATCHER: 'BLUFF_CATCHER',
  /** 听牌：还没有成手，但补牌质量支持继续 */
  DRAW: 'DRAW',
  /** 半诈唬：听牌 + 有下注主动权（弃牌率 + 补牌双重盈利） */
  SEMI_BLUFF: 'SEMI_BLUFF',
  /** 纯诈唬：没有成手也没有听牌，只能靠弃牌率盈利 */
  PURE_BLUFF: 'PURE_BLUFF',
  /** 摊牌价值：过牌到摊牌能赢一部分，但不值得下注 */
  SHOWDOWN_VALUE: 'SHOWDOWN_VALUE',
  /** 空气：什么都赢不了 */
  AIR: 'AIR',
} as const;
export type RelativeHandRole = (typeof RelativeHandRole)[keyof typeof RelativeHandRole];

export const RELATIVE_ROLE_ZH: Readonly<Record<RelativeHandRole, string>> = Object.freeze({
  NUT_VALUE: '坚果级价值',
  STRONG_VALUE: '强价值',
  MEDIUM_VALUE: '中等价值',
  THIN_VALUE: '薄价值',
  BLUFF_CATCHER: '抓诈牌',
  DRAW: '听牌',
  SEMI_BLUFF: '半诈唬',
  PURE_BLUFF: '纯诈唬',
  SHOWDOWN_VALUE: '摊牌价值',
  AIR: '空气',
});

/**
 * 对手范围的「牌面事实」——由 `contextBuilder` 从**真实范围**算出后注入。
 *
 * 🔴 为什么必须由范围层提供，而不是在这一层凭空估：
 * 「这张牌对他的范围有没有帮助」只有**他的范围**能回答。我们不做
 * 「我觉得这张 A 帮到他了」这种猜测 —— 那是编造数据。
 *
 * ⚠️ 拿不到时传 `null`，相应字段返回 `null`（不是 0）。
 */
export type OpponentRangeFacts = {
  /** 范围里「在当前牌面上已成强牌（档 ≤2）」的概率质量 */
  strongShare: number;
  /** 范围里「已成顶对及以上」的概率质量 */
  topPairPlusShare: number;
  /** 范围在当前牌面的**平均**相对强度档（0 最强 .. 5 最弱） */
  meanTier: number;
  /** 范围与牌面的花色适配度（0..1）：范围里持有牌面主导花色的质量 */
  suitFit: number;
  /** 范围里「有真听牌（同花听 / 两头顺）」的概率质量 */
  drawShare: number;
  /**
   * 🔴 **对手范围逐组合的档位直方图**（索引 = 档 0..5，值 = 概率质量占比）。
   *
   * 为什么需要它：「强度下限」这类**分布尾部**的量无法由 `strongShare`
   * 一个数字还原。对抗性审计实测（成对牌面 K♠K♦6♣2♣9♣ 上 UTG 范围）：
   * `strongShare = 1.0000`（成对牌面让**每一手**都至少是「一对 K」），
   * 若把它当作「他的最弱牌也这么强」，就会得出「没有任何更差的牌能跟注」
   * —— 于是**坚果同花（权益 94.7%）被判为不该下注**。直方图让下游可以
   * 只取真正的弱尾（档 ≥4），而不是拿一个饱和的占比去当尾部。
   */
  tierHistogram: readonly number[];
  /**
   * 🔴 **对手范围里「比我这手牌更差」的概率质量**（精确比较，不是档位近似）。
   *
   * 这是 Value Bet Gate 第一问（「有哪些**更差**的牌会跟？」）的**唯一正确口径**：
   * 它是**相对于我的牌**的量。修复前该问题用「他的范围下限」来回答，
   * 与我的牌无关 ⇒ 同一个数字既用于「我拿坚果」也用于「我拿空气」。
   *
   * 计算方式：逐组合用 `compareHands`（既有 `handEval`，单一事实来源）
   * 比较「他的 7 张」与「我的 7 张」，累加我赢 / 平 / 输的质量。
   */
  weakerShare: number;
  /** 同上：**打平**（同一牌面同牌力）的概率质量 */
  equalShare: number;
  /** 同上：**比我更好**的概率质量 */
  strongerShare: number;
  /**
   * 🔴 **可达范围的组合数**（概率 > 0 的组合个数）—— 也就是上面所有
   * 「占比」的**分母**。
   *
   * 为什么必须暴露：`strongerShare = 0.741` 这种数字只有在知道分母时
   * 才有意义（「可达范围 300 个组合里的 74.1%」与「12 个组合里的 74.1%」
   * 是两种完全不同的证据强度）。使用者明确要求：**是概率就必须给分母**，
   * 是归一化评分就必须标成评分 —— 不能让人把评分读成概率。
   */
  supportSize: number;
  /**
   * 🔴 **可达范围的逐组合计数**（RIVER CONSISTENCY V2.1 · P1-1）。
   *
   * 修复前只有**占比**，而报告/界面把它们直接叫成「价值组合 / 诈唬组合」——
   * 那两者不是一回事（详见 `riverActionClass.ts`）。现在：
   *
   * | 字段 | 含义 | 与「价值/诈唬」的关系 |
   * |---|---|---|
   * | `strongerThanHeroCount` | 最终牌力**比 Hero 强**的组合数 | 【数学确定】强弱比较，**不是**价值下注组合 |
   * | `weakerThanHeroCount` | 比 Hero **弱**的组合数 | 【数学确定】强弱比较，**不是**诈唬组合 |
   * | `valueBetCandidateCount` | 经**河牌动作分类**后属于「会下注取值」的组合数 | 只有在分类之后才允许叫「价值」 |
   * | `bluffCandidateCount` | 经分类后属于「无摊牌价值 ⇒ 有诈唬动机」的组合数 | 只有分类之后才允许叫「诈唬」 |
   *
   * ⚠️ 全部为**整数组合数**（分母 = `reachableRangeCount`）。
   */
  counts: {
    reachableRangeCount: number;
    strongerThanHeroCount: number;
    weakerThanHeroCount: number;
    equalToHeroCount: number;
    valueBetCandidateCount: number;
    bluffCandidateCount: number;
    showdownCount: number;
    uncertainCount: number;
    clearValueCount: number;
    thinValueCount: number;
    /** 分类的证据质量（可达组合数太少时结论不可靠） */
    evidenceQuality: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  } | null;
};

/** 听牌剖面（Hero 自己） */
export type DrawProfile = {
  flushDraw: boolean;
  openEnded: boolean;
  gutshot: boolean;
  /** 大致的补牌数（**只用于排序**，不是胜率） */
  outs: number;
};

export type PostflopInputs = {
  heroHole: readonly Card[];
  board: readonly Card[];
  street: Street;
  shape: HandShape;
  category: number;
  /** 对全部已实现对手的权益（既有权益引擎给出；未知为 null） */
  heroEquity: number | null;
  /** 跟注所需权益（既有底池赔率口径） */
  requiredEquity: number;
  spr: number | null;
  /** 已实现对手数（≥2 = 多人池） */
  opponentCount: number;
  /** 面对下注 = true；无人下注（轮到我决定是否下注）= false */
  facingBet: boolean;
  /** 我是否有下注主动权（本街前面没有别人的进攻动作，且前面街我表现强势） */
  hasInitiative: boolean;
  /** 对手范围事实（拿不到为 null） */
  opponentRangeFacts: OpponentRangeFacts | null;
  draws: DrawProfile;
};
