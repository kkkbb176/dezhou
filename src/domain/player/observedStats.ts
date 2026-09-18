/**
 * PLAYER PROFILE V3 —— 连续统计 + 样本置信度 + 标签先验
 *
 * ## 这一层解决什么
 *
 * V2 之前只有「用户手选标签」这一种认识玩家的方式：
 *
 * ```text
 * Archetype → archetypeDimensions → resolveTendencyDimensions → responseTendenciesOf
 * ```
 *
 * 标签是**主观断言**（`ARchetype_CONFIDENCE = 0.35`），它永远停在「我猜他是跟注站」。
 * V3 加入第二个来源：
 *
 * ```text
 * 标签 Prior  +  真实统计（带机会数）  +  样本量 ⇒ 可信度
 *                       ↓
 *              Resolved Player Profile
 *                       ↓
 *                 现有决策链（不改）
 * ```
 *
 * ## 三条不可违反的纪律
 *
 * 1. **标签不是事实，只是 Prior**。实测数据**逐步拉动**它，从不瞬间覆盖。
 * 2. **统计不是一有数据就全信**。可信度 = `n / (n + K)`，K 逐统计不同。
 * 3. **缺失 ≠ 0**。没观测过的字段回落到先验，绝不当作「观测到 0 次」。
 *
 * ## 复用而非重造
 *
 * 本项目**已经**有正确的收缩机制（`statEvidenceOf` / `confidenceFromSamples`）：
 *
 * ```text
 * effectiveRate = (priorRate × K + successes) / (K + opportunities)
 * confidence    = opportunities / (opportunities + K)
 * ```
 *
 * 这正是 Beta-Binomial 后验均值与「观测在总证据中的占比」。
 * 本模块**不重新实现**它，只负责：
 *   · 把「连续统计（比率 + 手数）」翻译成「带机会数的 successes/opportunities」；
 *   · 按**统计频次**给出各自的 K；
 *   · 把结果映射到**互相独立**的行为维度与**分街**响应因子；
 *   · 产出可审计的 trace。
 *
 * ## 为什么统计频次不同的 K 不同（§五）
 *
 * 一个统计量在 N 手里出现的机会次数差别极大：
 *
 * | 统计 | 每手机会 | 直觉 |
 * |---|---|---|
 * | VPIP | ≈ 1 次/手 | 300 手就有 300 次观测 ⇒ 小 K 即可信 |
 * | FoldToFlopCBet | 只在「面对翻牌 cbet」时算 | 300 手里也许只有 60 次 |
 * | FoldToRiverBet | 只在「河牌面对下注」时算 | 300 手里也许只有 25 次 |
 *
 * ⇒ 同样写「300 手」，对这三个统计的**证据量完全不同**。
 * 因此 K 必须按「该行为多久发生一次」来定，**不能统一**。
 *
 * ⚠️ **诚实说明**：调用方只给 `handsObserved` 时，机会数是用
 * `handsObserved × STAT_FREQUENCY[stat]` 近似的（见 §近似），
 * **不是真实机会数**。真实机会数在 `PlayerProfile.metrics[m].opportunities` 里，
 * 有经验的调用方应当传它（`opportunities` 字段优先级更高）。
 */

import type { QuickProfile } from '../../app/manualInput/manualInput.ts';
import {
  ENVIRONMENT_PRIOR_WEIGHT,
  StatSource,
  statEvidenceOf,
  type StatEvidence,
} from './behaviorProfile.ts';
import { ARCHETYPE_DIMENSIONS } from './archetypeDimensions.ts';
import { STAT_SOURCE_ZH } from './behaviorProfile.ts';

/* ============================================================
 * ① 连续统计的输入结构
 * ============================================================ */

/**
 * 第一版支持的连续统计（全部为 `0..1` 的比率；缺失用 `null`）。
 *
 * 🔴 **单位统一为 0..1**，绝不接受 `52` 这种「百分数」写法 ——
 * 混用两种单位是本项目历史上出现过的那类静默错答。
 * 传入 `52` 会被 `normalizeObservedStats` 判定为非法并拒绝（见 §七）。
 *
 * 🔴 **禁用 0 冒充缺失**：没观测到就是 `null`，不是 `0`。
 */
export type PlayerObservedStats = {
  /** 已观测手数（≥ 0）。它是所有统计的**机会数代理** */
  handsObserved: number;

  /* ---- 翻前 ---- */
  vpip?: number | null;
  pfr?: number | null;
  threeBet?: number | null;

  /* ---- 摊牌 ---- */
  wtsd?: number | null;

  /* ---- 面对持续下注的弃牌（**分街**，不得跨街套用） ---- */
  foldToFlopCBet?: number | null;
  foldToTurnCBet?: number | null;
  foldToRiverBet?: number | null;

  /* ---- 过牌-加注（**分街**） ---- */
  flopCheckRaise?: number | null;
  turnCheckRaise?: number | null;
  riverCheckRaise?: number | null;
};

/** 统计键（与 `PlayerObservedStats` 的字段一一对应，便于表驱动） */
export const ObservedStatKey = {
  VPIP: 'vpip',
  PFR: 'pfr',
  THREE_BET: 'threeBet',
  WTSD: 'wtsd',
  FOLD_TO_FLOP_CBET: 'foldToFlopCBet',
  FOLD_TO_TURN_CBET: 'foldToTurnCBet',
  FOLD_TO_RIVER_BET: 'foldToRiverBet',
  FLOP_CHECK_RAISE: 'flopCheckRaise',
  TURN_CHECK_RAISE: 'turnCheckRaise',
  RIVER_CHECK_RAISE: 'riverCheckRaise',
} as const;
export type ObservedStatKey = (typeof ObservedStatKey)[keyof typeof ObservedStatKey];

export const ALL_OBSERVED_STAT_KEYS: readonly ObservedStatKey[] = Object.freeze(
  Object.values(ObservedStatKey),
);

/* ============================================================
 * ② 每统计的 K 与「机会频率」
 * ============================================================ */

/**
 * 一个统计的证据参数。
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `priorWeight` (K) | 先验伪计数。可信度 = `n/(n+K)`，K 越大越不信小样本 |
 * | `priorRate` | 无个人证据时的比率（**与行为先验表同源**，不另设一套） |
 * | `opportunityRate` | 该行为**每手大约出现几次机会**（用于从手数近似机会数） |
 * | `frequencyTier` | 高频 / 中频 / 低频（报告要按这个分组解释 K） |
 * | `designZh` | K 的设计依据（必须能解释） |
 */
export type StatEvidenceSpec = {
  priorWeight: number;
  priorRate: number;
  opportunityRate: number;
  frequencyTier: 'HIGH' | 'MEDIUM' | 'LOW';
  designZh: string;
};

/**
 * 🔴 **K 与机会频率表**（V3 的核心参数表）。
 *
 * ## K 的选取依据（不是随手填的）
 *
 * 统一原则：**K ≈ 「要让实测占一半权重，需要多少次机会」**。
 * `n = K` 时可信度恰好 0.5，这是最容易解释的锚点。
 *
 * | 统计 | K | 含义：多少次机会才让实测占一半 | 频次档 |
 * |---|---|---|---|
 * | VPIP / PFR | 30 | 30 次机会（≈30 手） | 高频 |
 * | 3Bet | 25 | 25 次机会 | 中频 |
 * | WTSD | 20 | 20 次摊牌机会 | 中频 |
 * | FoldTo{Flop,Turn}CBet | 25 | 25 次面对 cbet | 中频 |
 * | FoldToRiverBet | 25 | 25 次河牌面对下注 | 低频 |
 * | CheckRaise（三街） | 20 | 20 次可过牌-加注的局面 | 低频 |
 *
 * ⚠️ 这些 K 与 `player.types.ts` 的 `METRIC_DEFINITIONS[*].prior.strength`
 * **刻意取同一量级**（那些是 20–30），因为它们描述的是同一批指标的同一件事。
 * 本表**不覆盖**那些值，而是在「只有比率、没有逐手观测」时提供等价的收缩强度。
 *
 * ## 机会频率的依据
 *
 * `opportunityRate` 表示「一手牌里该行为平均出现几次机会」。它是**保守估计**：
 *
 * | 统计 | 估计 | 理由 |
 * |---|---|---|
 * | VPIP / PFR | 1.0 | 每手都面对一次「要不要入池 / 要不要加注」 |
 * | 3Bet | 0.25 | 只有前面有人开池时才面对 3Bet 决策 |
 * | WTSD | 0.30 | 只有走到摊牌的牌局才算 |
 * | FoldToFlopCBet | 0.35 | 只有「他翻前进池且对手下注」才算 |
 * | FoldToTurnCBet | 0.18 | 还要先过翻牌 |
 * | FoldToRiverBet | 0.10 | 还要再过转牌 —— 约 10 手里 1 次 |
 * | CheckRaise | 0.15 | 需要「他先过牌且对手下注」 |
 *
 * 🔴 **这些是近似**。真实机会数应从 `PlayerProfile.metrics[m].opportunities` 取；
 * 调用方给了 `opportunities` 时**优先用它**，本表只作为兜底。
 */
export const STAT_EVIDENCE_SPECS: Readonly<Record<ObservedStatKey, StatEvidenceSpec>> = Object.freeze({
  vpip: Object.freeze({
    priorWeight: 75, priorRate: 0.5, opportunityRate: 1.0,
    frequencyTier: 'HIGH' as const,
    designZh:
      '每手都有一次入池机会 ⇒ **高频统计**，K=75（任务书 §五 高频档 50–100，取中值）：' +
      '75 次机会（≈75 手）才让实测占一半权重',
  }),
  pfr: Object.freeze({
    priorWeight: 75, priorRate: 0.5, opportunityRate: 1.0,
    frequencyTier: 'HIGH' as const,
    designZh: '每手都有一次主动加注机会 ⇒ 高频统计，K=75（与 VPIP 同档）',
  }),
  threeBet: Object.freeze({
    priorWeight: 150, priorRate: 0.5, opportunityRate: 0.25,
    frequencyTier: 'MEDIUM' as const,
    designZh:
      '只有前面有人开池时才面对 3Bet 决策（≈每 4 手 1 次）⇒ **中频统计**，' +
      'K=150（任务书 §五 中频档 100–250）：需要 ≈150 次机会 ≈ 600 手',
  }),
  wtsd: Object.freeze({
    priorWeight: 150, priorRate: 0.5, opportunityRate: 0.30,
    frequencyTier: 'MEDIUM' as const,
    designZh: '只有走到摊牌才算（≈每 3 手 1 次）⇒ 中频统计，K=150 ⇒ 需 ≈500 手',
  }),
  foldToFlopCBet: Object.freeze({
    priorWeight: 150, priorRate: 0.5, opportunityRate: 0.35,
    frequencyTier: 'MEDIUM' as const,
    designZh: '需要「他翻前进池 + 对手翻牌下注」⇒ 中频统计，K=150 ⇒ 需 ≈430 手',
  }),
  foldToTurnCBet: Object.freeze({
    priorWeight: 150, priorRate: 0.5, opportunityRate: 0.18,
    frequencyTier: 'MEDIUM' as const,
    designZh: '还要先有翻牌 cbet ⇒ 中频统计，K=150 ⇒ 需 ≈830 手',
  }),
  foldToRiverBet: Object.freeze({
    priorWeight: 200, priorRate: 0.5, opportunityRate: 0.10,
    frequencyTier: 'LOW' as const,
    designZh:
      '需要「翻前进池 + 三街都有下注」⇒ 约 10 手 1 次。**低频统计**，' +
      'K=200（任务书 §五 低频档「明显更多」）⇒ 需 ≈200 次机会 ≈ **2000 手**。' +
      '⚠️ 它是河牌诈唬 EV 最关键的输入，也是最难攒够样本的一项',
  }),
  flopCheckRaise: Object.freeze({
    priorWeight: 200, priorRate: 0.5, opportunityRate: 0.15,
    frequencyTier: 'LOW' as const,
    designZh: '需要「他先过牌且对手下注」⇒ 低频统计，K=200 ⇒ 需 ≈1300 手',
  }),
  turnCheckRaise: Object.freeze({
    priorWeight: 200, priorRate: 0.5, opportunityRate: 0.15,
    frequencyTier: 'LOW' as const,
    designZh: '同翻牌，且要有转牌 ⇒ 低频统计，K=200',
  }),
  riverCheckRaise: Object.freeze({
    priorWeight: 200, priorRate: 0.5, opportunityRate: 0.15,
    frequencyTier: 'LOW' as const,
    designZh: '同翻牌，且要有河牌 ⇒ 低频统计，K=200',
  }),
});

/* ============================================================
 * ③ 校验与归一化（§三 / §七）
 * ============================================================ */

export type StatNormalizeIssue = {
  field: string;
  code: 'OUT_OF_RANGE' | 'NOT_FINITE' | 'NEGATIVE_HANDS' | 'WRONG_UNIT_SUSPECTED';
  message: string;
  /** 被拒绝的原始值（用于诊断，不参与计算） */
  raw: number;
};

export type NormalizeResult = {
  /** 归一化后的统计（非法字段被置为 `null`，**不会**传播 NaN） */
  stats: PlayerObservedStats;
  /** 被拒绝的字段（如实记录，便于界面提示用户） */
  issues: readonly StatNormalizeIssue[];
};

/**
 * 校验并归一化连续统计。
 *
 * ## 规则
 *
 * | 情况 | 处理 |
 * |---|---|
 * | 值 ∈ [0,1] | 接受 |
 * | 值 ∈ (1,100] 且像百分数 | **拒绝并提示单位**（不静默除以 100 —— 那会掩盖录入错误） |
 * | `NaN` / `Infinity` / 非数 | 拒绝该字段 ⇒ `null`（回落到先验） |
 * | 负数 / > 100 | 拒绝该字段 ⇒ `null` |
 * | `handsObserved` 非有限或 < 0 | 置 0 |
 *
 * 🔴 **绝不传播 `NaN`**：任何非法值都被换成 `null`，下游一律走先验。
 * 🔴 **不静默改单位**：`52` 被拒绝而不是变成 `0.52` —— 因为「用户想写 52%」
 * 与「用户写错了字段」无法区分，静默转换会让错误的数据看起来是对的。
 */
export function normalizeObservedStats(input: {
  handsObserved: number;
  stats: Partial<Record<ObservedStatKey, number | null | undefined>>;
}): NormalizeResult {
  const issues: StatNormalizeIssue[] = [];
  const handsRaw = input.handsObserved;
  if (Number.isFinite(handsRaw) && handsRaw < 0) {
    issues.push({
      field: 'handsObserved', code: 'NEGATIVE_HANDS',
      message: `手数不能为负（收到 ${handsRaw}）⇒ 置 0（视作无样本）`,
      raw: handsRaw,
    });
  } else if (!Number.isFinite(handsRaw)) {
    issues.push({
      field: 'handsObserved', code: 'NOT_FINITE',
      message: `手数不是有限数（收到 ${String(handsRaw)}）⇒ 置 0`,
      raw: Number.NaN,
    });
  }
  const handsObserved =
    Number.isFinite(handsRaw) && handsRaw > 0 ? Math.floor(handsRaw) : 0;

  const out: Record<string, number | null> = {};
  for (const key of ALL_OBSERVED_STAT_KEYS) {
    const raw = input.stats[key];
    if (raw === null || raw === undefined) { out[key] = null; continue; }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      issues.push({
        field: key, code: 'NOT_FINITE',
        message: `「${key}」不是有限数（收到 ${String(raw)}）⇒ 忽略该字段，回落到先验`,
        raw: typeof raw === 'number' ? raw : Number.NaN,
      });
      out[key] = null; continue;
    }
    if (raw < 0) {
      issues.push({
        field: key, code: 'OUT_OF_RANGE',
        message: `「${key}」为负数（${raw}）⇒ 忽略该字段，回落到先验`,
        raw,
      });
      out[key] = null; continue;
    }
    if (raw > 1) {
      /*
       * > 1 有两种可能：输入错误，或者用户写了百分数（52 而不是 0.52）。
       * 两者都无法从数值本身区分 ⇒ **拒绝并明确提示**，不猜。
       */
      issues.push({
        field: key,
        code: raw <= 100 ? 'WRONG_UNIT_SUSPECTED' : 'OUT_OF_RANGE',
        message:
          raw <= 100
            ? `「${key}」= ${raw} 超出 [0,1]。本系统统一用 0..1 口径 —— ` +
              '若你要表达百分数请写 ' + (raw / 100).toFixed(4) + '（**不会自动换算**，避免掩盖录入错误）'
            : `「${key}」= ${raw} 远超 [0,1] ⇒ 忽略该字段`,
        raw,
      });
      out[key] = null; continue;
    }
    out[key] = raw;
  }

  return {
    stats: {
      handsObserved,
      ...out,
    } as PlayerObservedStats,
    issues: Object.freeze(issues),
  };
}

/* ============================================================
 * ④ 统计 → 行为条目（带机会数与 K 的收缩）
 * ============================================================ */

export type Street = 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER';

/**
 * V3 新增的行为条目。
 *
 * 🔴 **为什么必须新增这些条目，而不是复用 V2 的 6 条**：
 *
 * V2 的条目（`riverBluff` / `callTooWide` / …）描述的是**主动下注与跟注宽度**，
 * 它们**不含分街的「面对下注弃牌」**。而连续统计里最有价值的一批
 * （`FoldTo*CBet` / `FoldToRiverBet` / `*CheckRaise`）恰恰是**分街的**。
 *
 * 若把它们硬塞进 `callTooWide`，就会犯任务书 §七 明令禁止的跨街推断
 *（「河牌弃牌率高」被错误地用来调**翻牌**的跟注宽度）。因此新增独立条目，
 * 每条**只在它自己那一街**生效。
 */
export const StreetTraitKey = {
  FOLD_TO_FLOP_BET: 'foldToFlopBet',
  FOLD_TO_TURN_BET: 'foldToTurnBet',
  FOLD_TO_RIVER_BET: 'foldToRiverBet',
  FLOP_CHECK_RAISE: 'flopCheckRaise',
  TURN_CHECK_RAISE: 'turnCheckRaise',
  RIVER_CHECK_RAISE: 'riverCheckRaise',
} as const;
export type StreetTraitKey = (typeof StreetTraitKey)[keyof typeof StreetTraitKey];

export const ALL_STREET_TRAIT_KEYS: readonly StreetTraitKey[] = Object.freeze(
  Object.values(StreetTraitKey),
);

export const STREET_TRAIT_ZH: Readonly<Record<StreetTraitKey, string>> = Object.freeze({
  foldToFlopBet: '翻牌面对下注弃牌倾向',
  foldToTurnBet: '转牌面对下注弃牌倾向',
  foldToRiverBet: '河牌面对下注弃牌倾向',
  flopCheckRaise: '翻牌过牌-加注倾向',
  turnCheckRaise: '转过牌-加注倾向',
  riverCheckRaise: '河牌过牌-加注倾向',
});

/** 统计 → 它驱动的**行为条目**与**分街**归属 */
export type StatMapping = {
  stat: ObservedStatKey;
  /** 驱动的分街条目；`null` = 这条统计只影响维度，不影响分街响应 */
  streetTrait: StreetTraitKey | null;
  street: Street | null;
  noteZh: string;
};

/**
 * 🔴 **统计 → 行为条目的映射（只允许同街）**。
 *
 * 这张表是「禁止跨街过度推断」（§七）的**唯一执行点**：
 * 每条分街统计只映射到它自己那一街的条目，没有第二条路径。
 */
export const STAT_TO_STREET_TRAIT: Readonly<Record<string, StatMapping>> = Object.freeze({
  foldToFlopCBet: Object.freeze({
    stat: 'foldToFlopCBet' as ObservedStatKey,
    streetTrait: 'foldToFlopBet' as StreetTraitKey,
    street: 'FLOP' as Street,
    noteZh: '翻牌 cbet 弃牌率 ⇒ **只**作用于翻牌的面对下注响应',
  }),
  foldToTurnCBet: Object.freeze({
    stat: 'foldToTurnCBet' as ObservedStatKey,
    streetTrait: 'foldToTurnBet' as StreetTraitKey,
    street: 'TURN' as Street,
    noteZh: '转牌 cbet 弃牌率 ⇒ **只**作用于转牌',
  }),
  foldToRiverBet: Object.freeze({
    stat: 'foldToRiverBet' as ObservedStatKey,
    streetTrait: 'foldToRiverBet' as StreetTraitKey,
    street: 'RIVER' as Street,
    noteZh: '河牌面对下注弃牌率 ⇒ **只**作用于河牌（河牌诈唬 EV 的关键输入）',
  }),
  flopCheckRaise: Object.freeze({
    stat: 'flopCheckRaise' as ObservedStatKey,
    streetTrait: 'flopCheckRaise' as StreetTraitKey,
    street: 'FLOP' as Street,
    noteZh: '翻牌过牌-加注率 ⇒ **只**作用于翻牌',
  }),
  turnCheckRaise: Object.freeze({
    stat: 'turnCheckRaise' as ObservedStatKey,
    streetTrait: 'turnCheckRaise' as StreetTraitKey,
    street: 'TURN' as Street,
    noteZh: '转过牌-加注率 ⇒ **只**作用于转牌',
  }),
  riverCheckRaise: Object.freeze({
    stat: 'riverCheckRaise' as ObservedStatKey,
    streetTrait: 'riverCheckRaise' as StreetTraitKey,
    street: 'RIVER' as Street,
    noteZh: '河牌过牌-加注率 ⇒ **只**作用于河牌。**不得**因为翻牌 XR 高就调高河牌',
  }),
});

/**
 * 行为条目的先验比率：从**标签维度**取，没有标签则用中性 0.5。
 *
 * ## 🔴 这里曾经写错，值得记录
 *
 * 第一版把分街条目的先验恒设为 **0.5**（「没有标签先验就用中性」）。后果是
 * **方向被弄反**：老周实测 `FoldToRiverBet = 0.19`（比中性更少弃），
 * 但收缩公式 `(0.5×K + successes)/(K + n)` 会把这个 0.19 从 **0.5** 往下拉，
 * 而 0.5 高于 0.19 ⇒ 生效值 **0.459 仍然高于** 中性 ⇒ 引擎得出
 * 「他比普通人**更爱**弃」——与「跟注站」正好相反。
 *
 * 根因不是公式，是**先验选错了对象**：这个条目的先验应当来自
 * **标签对「弃牌倾向」的认识**，而不是一个常数。
 *
 * ## 现在的口径
 *
 * ```text
 * fold 类条目先验 = clamp01(0.20 + 0.6 × tightness − 0.5 × passivity)
 * checkRaise 先验 = clamp01(0.10 + 0.3 × aggression + 0.3 × bluffTendency)
 * ```
 *
 * 系数是**结构性判断**（方向 + 量级），不是拟合出来的：
 *
 * | 标签 | tightness | passivity | fold 先验 | 语义 |
 * |---|---|---|---|---|
 * | CALLING_STATION | 0.30 | 0.80 | 0.20+0.18−0.40 = **−0.02 → 0.02** | 几乎不弃 |
 * | VERY_TIGHT | 0.88 | 0.45 | 0.20+0.528−0.225 = **0.503** | 经常弃 |
 * | MANIAC | 0.15 | 0.35 | 0.20+0.09−0.175 = **0.115** | 很少弃 |
 * | NORMAL | 0.50 | 0.50 | 0.20+0.30−0.25 = **0.25** | 中性偏低 |
 *
 * ⇒ 跟注站先验 0.02、极紧 0.503，**方向正确且量级合理**。
 *
 * ⚠️ 先验权重刻意用**池先验权重（6）**而不是某个更大的数：
 * 标签只是 Prior（§一），不该压过 100+ 次真实机会的实测。
 */
function traitPriorOf(
  archetype: QuickProfile | null,
): { rate: number; weight: number } {
  const dims = archetype === null ? null : ARCHETYPE_DIMENSIONS[archetype];
  const tightness = dims?.tightness ?? 0.5;
  const passivity = dims?.passivity ?? 0.5;
  const aggression = dims?.aggression ?? 0.5;
  const bluff = dims?.bluffTendency ?? 0.5;
  const clamp = (lo: number, hi: number, v: number): number => Math.max(lo, Math.min(hi, v));
  return {
    /**
     * 面对下注弃牌的标签先验（flop/turn/river 共用同一形状）。
     *
     * ## 为什么锚在 **0.45**（而不是 0.5 或某个标签专属的低值）
     *
     * 0.45 是**人群中心**（`PlayerMetric.FOLD_TO_CBET` 的启发式先验
     * 「面对持续下注的弃牌率中心约 45%」）。把标签先验锚在人群中心，
     * 再用标签维度做**偏移**，有三个好处：
     *
     * 1. **语义正确**：标签改变的是「相对普通人偏多少」，不是「绝对值是多少」。
     *    这正好对应 §一 第 1 条「标签不是事实，只是 Prior」。
     * 2. **方向可保证**：`prior + (observed − prior) × conf` 中，
     *    `effective > 0.5 ⇔ observed > 0.5`（当 prior 在中心附近）。
     *    若把 prior 压到 0.095，则 `observed = 0.80` 也会被压到 0.5 以下 ——
     *    **引擎会得出「他比普通人更爱跟」**，与读牌完全相反（本轮实测踩到）。
     * 3. **可解释**：`0.45` 有既有出处，不是为本测试新挑的数。
     *
     * ## 偏移量
     *
     * ```text
     * offset = 0.30 × (passivity − 0.5) − 0.25 × (tightness − 0.5)   ∈ [−0.28, +0.28]
     * prior  = clamp(0.08, 0.92, 0.45 − 0.5 × offset)
     * ```
     *
     * | 标签 | passivity | tightness | offset | prior |
     * |---|---|---|---|---|
     * | CALLING_STATION | 0.80 | 0.30 | +0.140 | **0.380** |
     * | VERY_TIGHT | 0.45 | 0.88 | −0.095 | **0.498** |
     * | MANIAC | 0.35 | 0.15 | −0.043 | **0.471** |
     * | NORMAL | 0.50 | 0.50 | 0.000 | **0.450** |
     *
     * ⚠️ 注意 `traitPriorOf` 只影响**分街条目**（`FoldTo*CBet` / `*CheckRaise`）。
     * 它**不**参与 VPIP/PFR/WTSD 的维度推送 —— 那些走
     * `STAT_DIMENSION_POLARITY`，是另一条独立通道（§七 维度独立）。
     */
    fold: (() => {
      const offset = 0.30 * (passivity - 0.5) - 0.25 * (tightness - 0.5);
      return clamp(0.08, 0.92, 0.45 - 0.5 * offset);
    })(),
    /** 过牌-加注的标签先验：人群中心 0.10（`CHECK_RAISE_FLOP` 先验），向上偏移 */
    checkRaise: (() => {
      const offset = 0.5 * (aggression - 0.5) + 0.5 * (bluff - 0.5);
      return clamp(0.03, 0.60, 0.10 + 0.5 * offset);
    })(),
    aggression,
    bluff,
    passivity,
    tightness,
  } as never;
}

/**
 * 把一条连续统计（比率 + 手数）变成带机会数与收缩的 `StatEvidence`。
 *
 * @param opportunitiesOverride 真实机会数（来自 `PlayerProfile.metrics`）。
 *   给了就用它；没给则用 `handsObserved × opportunityRate` **近似**（并在 note 里标明）。
 */
export function statEvidenceOfRate(input: {
  stat: ObservedStatKey;
  rate: number;
  handsObserved: number;
  opportunitiesOverride?: number | null;
  archetype: QuickProfile | null;
}): StatEvidence & { approximated: boolean; spec: StatEvidenceSpec } {
  const spec = STAT_EVIDENCE_SPECS[input.stat];
  const approximated = input.opportunitiesOverride === null || input.opportunitiesOverride === undefined;
  const opportunities = approximated
    ? Math.round(input.handsObserved * spec.opportunityRate)
    : Math.max(0, Math.floor(input.opportunitiesOverride!));
  /*
   * 🔴 **先验按条目类型取**（不是恒 0.5 —— 那会把方向弄反，见 `traitPriorOf` 的说明）：
   * fold 类走「标签对弃牌倾向的认识」，check-raise 类走「主动 + 诈唬」。
   */
  const trait = traitPriorOf(input.archetype) as unknown as {
    fold: number; checkRaise: number;
  };
  const isFoldTrait = input.stat.startsWith('foldTo');
  const priorRate = isFoldTrait ? trait.fold : trait.checkRaise;

  /*
   * ============================================================
   * 🔴 **为什么这里不用 `statEvidenceOf`（按次数收缩）—— 一次实测纠错**
   * ============================================================
   *
   * 第一版复用了 `statEvidenceOf(successes, opportunities, priorRate, priorWeight)`。
   * 那是**按离散成功次数**的 Beta-Binomial 收缩，适合「一手一手录进来」的场合。
   *
   * 但这里的输入是一个 **HUD 比率**（`FoldToRiverBet = 0.19`，来自 310 手统计）。
   * 把一个**已经是从 N 次机会聚合出来的比率**再当作「4 次机会里的 0.76 次」
   * 去收缩，是**量纲错误** —— 实测后果（老周案例）：
   *
   * ```text
   * 先验 0.000（跟注站不爱弃）
   * 实测 FoldRiver 0.19、机会数 ≈31
   * ⇒ successes = round(31 × 0.19) = 6
   * ⇒ effective = (0.000×6 + 6) / (6 + 31) = 0.162   ← 被拉向先验
   * 而 small sample 8 手时：
   * ⇒ opportunities = round(8 × 0.1) = 1、successes = round(0.1) = 0
   * ⇒ effective = (0.000×6 + 0) / (6 + 1) = **0.000**   ← 实测 0.10 被抹成 0！
   * ```
   *
   * `0.000` 意味着「他从不弃河牌」—— 正是任务书 §十二 明令禁止的结论。
   * 根因是 `round(opportunities × rate)` 在机会数很小时把**比率本身**四舍五入没了。
   *
   * ## 正确的模型：比率 × 可信度的线性混合
   *
   * HUD 比率**已经是**观测的汇总，所以正确的做法是直接混合，不再二次离散化：
   *
   * ```text
   * confidence   = n_opp / (n_opp + K)          ← 与任务书 §五 的 n/(n+K) 同式
   * effectiveRate = prior + (observed − prior) × confidence
   * ```
   *
   * 这正是任务书 §六 要求的形状（`prior×(1−conf) + observed×conf`）。
   *
   * 三条性质（有测试锁）：
   * - `n_opp = 0` ⇒ `confidence = 0` ⇒ `effectiveRate` **逐位等于 priorRate**（V2 恒等）；
   * - `n_opp → ∞` ⇒ `effectiveRate → observedRate`（大样本最终相信实测）；
   * - 单调：同一 observed 下 `n_opp` 越大，`|effective − observed|` **越小**。
   *
   * ⚠️ 与「按次数收缩」的差别在**小样本**上最明显，而小样本正是本任务的核心场景。
   * `statEvidenceOf` 仍用于 `PlayerProfile` 的**逐手录入**路径（那里确实是计数），
   * 两者分工不同，**不是两套尺子**：一个处理计数、一个处理已聚合的比率。
   */
  const confidence = opportunities === 0 ? 0 : opportunities / (opportunities + spec.priorWeight);
  const effectiveRate =
    opportunities === 0 ? priorRate : priorRate + (input.rate - priorRate) * confidence;

  return {
    observedRate: opportunities === 0 ? null : input.rate,
    opportunities,
    successes: Math.round(opportunities * input.rate),
    unknownOutcomeOpportunities: 0,
    priorRate,
    priorWeight: spec.priorWeight,
    effectiveRate,
    confidence,
    source: StatSource.OBSERVED_HAND_HISTORY,
    approximated,
    spec,
    noteZh:
      `${STAT_SOURCE_ZH[StatSource.OBSERVED_HAND_HISTORY]}：实测比率 ${opportunities === 0 ? '—' : input.rate.toFixed(3)}` +
      `（机会数 ${opportunities}${approximated ? '，**由手数 × 频率近似**' : '，来自实测统计'}）` +
      `｜**标签先验**（${isFoldTrait ? '弃牌' : '过牌-加注'}）${priorRate.toFixed(3)}` +
      `（伪计数 ${ENVIRONMENT_PRIOR_WEIGHT}）` +
      `｜样本 K=${spec.priorWeight}（${spec.frequencyTier} 频次档）` +
      ` ⇒ 可信度 ${confidence.toFixed(4)}` +
      ` ⇒ 生效 ${effectiveRate.toFixed(4)}（= 先验 + (实测 − 先验) × 可信度）` +
      (approximated
        ? `｜⚠️ 机会数由 ${input.handsObserved} 手 × 频率 ${spec.opportunityRate} **近似**（非逐手实测机会数）`
        : '｜✅ 机会数来自实测统计的 opportunities'),
  };
}

/* ============================================================
 * ⑤ 统计 → 维度（**只允许同轴**，§七）
 * ============================================================ */

export type DimensionPolarity = {
  /** 该统计对 tightness 的推力方向：`+1` = 推高 tightness（更紧） */
  tightness: number;
  aggression: number;
  bluffTendency: number;
  passivity: number;
};

/**
 * 🔴 **统计 → 四维度的极性表**（§七「必须保持维度独立」的执行点）。
 *
 * ## 为什么是「极性」而不是「直接映射」
 *
 * 四维度的取值域是 `0..1`（0.5 = 中立），而统计也是 `0..1`。
 * 若直接把比率写进维度，就会犯「VPIP 0.52 ⇒ tightness 0.52」这种
 * **尺度混淆** —— 两者虽然都在 0..1，语义完全不同。
 *
 * 正确做法：把统计的**偏离**（相对池先验中心）映射成维度的**偏离**。
 *
 * ```text
 * center(v)     = clamp((v − 0.5) × 2, −1, +1)      // 归一到 −1..+1
 * push(dim)     = center(dim) + polarity[dim] × center(stat) × confidence
 * resolved(dim) = clamp01(0.5 + push(dim) / 2)
 * ```
 *
 * ## 极性方向的依据
 *
 * | 统计 | tightness | aggression | bluffTendency | passivity | 依据 |
 * |---|---|---|---|---|---|
 * | VPIP 高 | **−1**（更松） | 0 | 0 | 0 | VPIP 只讲**入池宽度**；不蕴含凶或诈唬 |
 * | PFR 高 | 0 | **+1** | 0 | 0 | PFR 是**翻前主动性**；与河牌诈唬无关 |
 * | 3Bet 高 | −0.3 | **+1** | 0 | 0 | 3Bet 是翻前激进范围（略放宽宽度） |
 * | WTSD 高 | 0 | 0 | 0 | **+1** | 摊牌坚持 = 不爱弃（被动轴），**不等于**跟注站 |
 * | FoldTo*CBet 高 | +0.4 | 0 | 0 | **−1** | 爱弃 ⇒ 更紧、更不被动 |
 * | *CheckRaise 高 | 0 | +0.5 | +0.5 | −0.4 | 过牌-加注是**主动**且**带诈唬**的动作 |
 *
 * 🔴 **每个统计只出现在它语义所属的轴上**：
 * VPIP 不碰 `bluffTendency`（禁止「松 ⇒ 爱诈唬」），
 * PFR 不碰 `bluffTendency`（禁止「翻前凶 ⇒ 河牌爱诈唬」）。
 */
export const STAT_DIMENSION_POLARITY: Readonly<Record<ObservedStatKey, DimensionPolarity>> =
  Object.freeze({
    vpip: Object.freeze({ tightness: -1.0, aggression: 0, bluffTendency: 0, passivity: 0 }),
    pfr: Object.freeze({ tightness: 0, aggression: +1.0, bluffTendency: 0, passivity: 0 }),
    threeBet: Object.freeze({ tightness: -0.3, aggression: +1.0, bluffTendency: 0, passivity: 0 }),
    wtsd: Object.freeze({ tightness: 0, aggression: 0, bluffTendency: 0, passivity: +1.0 }),
    /*
     * 🔴 **`FoldTo*CBet` / `*CheckRaise` 的维度极性刻意全为 0** —— 消除**重复计票**。
     *
     * 第一版给它们 `passivity −1 / tightness +0.4`（爱弃 ⇒ 更不被动、更紧）。
     * 实测后果：**同一条统计被用了两次** ——
     *
     * ```text
     * ① 经「维度 → responseTendenciesOf 的 foldScale/callScale」
     * ② 再经「分街条目 → streetFactorOf 的 streetFoldScale」
     * ```
     *
     * 老周案例的实测表现：`streetFoldScale = 0.898`（< 1 ⇒ 应该**更少**弃），
     * 但 Small Fold% 反而从 0.937% **升到** 1.844% ——
     * 因为 ① 把 `passivity` 推到 0.639、`tightness` 拉到 0.457，
     * 那一路的变化盖过了 ② 的方向。
     *
     * 现在职责切干净：
     *
     * | 统计 | 走哪条通道 | 理由 |
     * |---|---|---|
     * | VPIP / PFR / 3Bet | **只走维度** | 它们是**翻前**行为，而分街条目只覆盖翻后 |
     * | WTSD | **只走维度** | 它是**跨街**的摊牌坚持，不专属某一街 |
     * | FoldTo{Flop,Turn,River}CBet | **只走分街条目** | 它**本来就分街**，那条通道语义更精确 |
     * | \*CheckRaise | **只走分街条目** | 同上 |
     *
     * ⇒ 每条统计**恰好**影响一个通道（§七「维度独立」+ 「不得重复计入」）。
     */
    foldToFlopCBet: Object.freeze({ tightness: 0, aggression: 0, bluffTendency: 0, passivity: 0 }),
    foldToTurnCBet: Object.freeze({ tightness: 0, aggression: 0, bluffTendency: 0, passivity: 0 }),
    foldToRiverBet: Object.freeze({ tightness: 0, aggression: 0, bluffTendency: 0, passivity: 0 }),
    flopCheckRaise: Object.freeze({ tightness: 0, aggression: 0, bluffTendency: 0, passivity: 0 }),
    turnCheckRaise: Object.freeze({ tightness: 0, aggression: 0, bluffTendency: 0, passivity: 0 }),
    riverCheckRaise: Object.freeze({ tightness: 0, aggression: 0, bluffTendency: 0, passivity: 0 }),
  });

/* ============================================================
 * ⑥ Resolver：标签 Prior + 实测统计 ⇒ Resolved Profile
 * ============================================================ */

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5);
/** 把 0..1 的比率归一到 −1..+1 的「偏离中心」量（0.5 ⇒ 0） */
const centerOf = (v: number): number => Math.max(-1, Math.min(1, (clamp01(v) - 0.5) * 2));

/** 一条统计的完整解析记录（报告与 trace 都读它） */
export type StatResolutionTrace = {
  stat: ObservedStatKey;
  /** 用户给的原始比率（未被接受的为 null） */
  observedRate: number | null;
  /** 被接受、且实际进入计算的比率 */
  effectiveRate: number;
  opportunities: number;
  successes: number;
  /** 机会数是否为「手数 × 频率」近似 */
  approximated: boolean;
  priorWeight: number;
  priorRate: number;
  frequencyTier: StatEvidenceSpec['frequencyTier'];
  confidence: number;
  /** 驱动的分街条目（没有则为 null） */
  streetTrait: StreetTraitKey | null;
  /** 该条目收缩后的生效比率（没有分街条目则为 null） */
  streetTraitEffectiveRate: number | null;
  noteZh: string;
};

export type ResolvedDimensions = {
  tightness: number;
  aggression: number;
  bluffTendency: number;
  passivity: number;
};

/** 分街的响应因子（**只在它自己那一街生效**） */
export type StreetFactors = {
  /** 面对下注时「更爱弃」的倍率；>1 = 更容易弃 */
  foldScale: number;
  /** 面对下注时「更爱跟」的倍率；>1 = 更爱跟 */
  callScale: number;
  /** 过牌-加注的倍率；>1 = 更爱过牌-加注 */
  checkRaiseScale: number;
};

export type StreetProfile = {
  PREFLOP: StreetFactors;
  FLOP: StreetFactors;
  TURN: StreetFactors;
  RIVER: StreetFactors;
};

export type ResolvedPlayerProfile = {
  /** —— 三层概念（§四）—— */
  /** ① 用户手选的标签，**原样保留**（本轮不做自动重分类，§十六） */
  baseArchetype: QuickProfile | null;
  /** ② 实际被接受、参与计算的连续统计（非法字段已剔除） */
  observedStats: PlayerObservedStats;
  /** ③ 解析结果 */
  resolved: {
    dimensions: ResolvedDimensions;
    /** 解析出的分街因子 */
    street: StreetProfile;
  };

  /** 校验问题（非法字段在这里如实报出，**不静默**） */
  issues: readonly StatNormalizeIssue[];
  /** 逐统计的可审计记录 */
  trace: readonly StatResolutionTrace[];
  /** 有多少条统计真的参与了（= 有非 null 观测的条数） */
  observedStatCount: number;
  /** 整体可信度的可读档位 */
  confidenceTierZh: string;
  noteZh: string;
};

/** 中立的分街因子（全 1 ⇒ 恒等变换） */
export function neutralStreetFactors(): StreetProfile {
  const one: StreetFactors = Object.freeze({ foldScale: 1, callScale: 1, checkRaiseScale: 1 });
  return Object.freeze({ PREFLOP: one, FLOP: one, TURN: one, RIVER: one });
}

/**
 * 分街条目的**因子换算**。
 *
 * 条目存的是「这个倾向有多强」（0..1，0.5 = 中立），
 * 而响应层要的是**倍率**。换算必须**有界**，否则 1.0 的极端统计
 * 会产出无限倍率（§十三「极端数据防护」）。
 *
 * ```text
 * factor(value, span) = 1 + span × (value − 0.5) × 2      // ⇒ 1 ± span
 * ```
 *
 * `span` 的选取：单一条目的最大影响限制在 **±35%**，与 V2
 * `responseTendenciesOf` 的 0.25–0.35 量级一致（同一纪律：单条证据不得支配全局）。
 */
const STREET_FACTOR_SPAN = 0.35;
export function streetFactorOf(value: number, span = STREET_FACTOR_SPAN): number {
  return 1 + span * centerOf(value);
}

/**
 * 解析「标签 Prior + 实测统计」为可用于决策链的画像（§四 / §六）。
 *
 * ## 收缩从哪来
 *
 * **不重新实现**收缩公式 —— 它由 `statEvidenceOf` 给出：
 *
 * ```text
 * effectiveRate = (priorRate × K + successes) / (K + opportunities)
 * confidence    = opportunities / (opportunities + K)
 * ```
 *
 * 这正是任务书 §六 要求的
 * `resolved = prior × (1 − confidence) + observed × confidence` 的**等价形式**
 *（Beta-Binomial 后验均值），且它额外正确处理了**离散成功数**。
 *
 * ## V2 兼容（§十一）
 *
 * `observedStats = null` 或全部字段缺失时：
 * 每条统计的 `confidence = 0` ⇒ `push = 0` ⇒ 维度**逐位**等于 0.5、
 * 分街因子**逐位**等于 1 ⇒ 下游行为与 V2 archetype-only **完全一致**。
 * 这不是「近似兼容」，是**恒等**。
 */
export function resolvePlayerProfile(input: {
  baseArchetype: QuickProfile | null;
  observedStats: PlayerObservedStats | null;
  /**
   * 真实机会数（来自 `PlayerProfile.metrics[m].opportunities`）。
   * 给了就优先用它；没给则按「手数 × 频率」近似。
   */
  opportunities?: Partial<Record<ObservedStatKey, number | null>> | null;
  /** 手选标签的先验可信度（默认与 `ARCHETYPE_CONFIDENCE` 同值由调用方给） */
}): ResolvedPlayerProfile {
  const raw = input.observedStats;
  const normalized = normalizeObservedStats({
    handsObserved: raw?.handsObserved ?? 0,
    stats: (raw ?? {}) as Partial<Record<ObservedStatKey, number | null>>,
  });
  const stats = normalized.stats;

  const trace: StatResolutionTrace[] = [];
  /**
   * 🔴 **逐维度的「加权平均」累加器**（不是简单求和）。
   *
   * 第一版用 `push[dim] += polarity × center × confidence` —— 那是**求和**。
   * 后果实测：一个跟注站的 `passivity` 被 WTSD 与三条 FoldTo*CBet 一起推到
   * **精确的 1.0**、`aggression` 被压到 **精确的 0**，`tightness` 也一样贴边。
   * 四个人为设定的极性系数（0.4–1.0）求和后轻松超过 1，**夹取**就成了常态 ——
   * 而夹取会把「很极端」和「极其极端」压成同一个值，正是本项目一直避免的形态。
   *
   * 正确形状是**加权平均**：
   *
   * ```text
   *      Σ (polarity_i × center_i × confidence_i)
   * res = ───────────────────────────────────────   ∈ [−1, +1]
   *              Σ |polarity_i| × confidence_i
   * ```
   *
   * 性质：① 单条统计的最大影响恒为 `|center| ≤ 1`；
   * ② 多条统计是**互相平均**而不是叠加；③ 分母为 0（没有任何统计）
   * ⇒ 结果 0 ⇒ 维度恒为 0.5 ⇒ **V2 恒等**。
   */
  const acc: Record<'tightness' | 'aggression' | 'bluffTendency' | 'passivity', { num: number; den: number }> = {
    tightness: { num: 0, den: 0 },
    aggression: { num: 0, den: 0 },
    bluffTendency: { num: 0, den: 0 },
    passivity: { num: 0, den: 0 },
  };
  /**
   * 🔴 **标签先验的证据质量**（权重 1 = 与「1 次满证据的观测」等价）。
   *
   * ## 为什么分母里必须有它（否则维度会**饱和**）
   *
   * 第一版的分母只有 `Σ|polarity| × confidence` —— 那是把**所有**已给统计
   * 按可信度加权平均。后果实测：
   *
   * ```text
   * VPIP = 0.24，160 手  ⇒ tightness = 0.760
   * VPIP = 0.24，1500 手 ⇒ tightness = 0.760   ← **完全相同**
   * ```
   *
   * 两处都在 `clamp01(0.5 + 1/2) = 1.0` 上**撞顶**了：只要置信度不是极小，
   * 加权平均就等于那唯一一条统计的中心偏离（VPIP 0.24 ⇒ −0.52），
   * 再除以 2 得 −0.26… 实际上偏离直接取满 ⇒ `0.5 + 0.5 = 1.0`。
   * 于是「160 手」与「1500 手」**无法区分** —— 而样本量正是本轮的核心。
   *
   * 加入 `priorMass` 后：
   *
   * ```text
   * res = Σ(p × center × conf) / (priorMass + Σ|p| × conf)
   * ```
   *
   * 性质：① 无观测 ⇒ num = 0 ⇒ res = 0（**精确中立**，V2 恒等）；
   * ② `conf` 小 ⇒ 先验占主导 ⇒ res 小；③ `conf → 1` ⇒ res → center（相信实测）；
   * ④ **严格单调**：同一 center 下 conf 越大，|res| 越大，直至逼近 center。
   * ⇒ 「样本越大，实测纠正越强」（§十二 / P8b）由一个**结构性质**保证。
   */
  const priorMass = 1;
  /** 分街条目的生效值（未观测到则为 0.5 = 中立） */
  const streetTraitValue: Record<StreetTraitKey, number> = {
    foldToFlopBet: 0.5,
    foldToTurnBet: 0.5,
    foldToRiverBet: 0.5,
    flopCheckRaise: 0.5,
    turnCheckRaise: 0.5,
    riverCheckRaise: 0.5,
  };

  let observedStatCount = 0;

  for (const stat of ALL_OBSERVED_STAT_KEYS) {
    const rate = (stats as Record<string, number | null>)[stat] ?? null;
    const spec = STAT_EVIDENCE_SPECS[stat];
    const mapping = STAT_TO_STREET_TRAIT[stat] ?? null;

    if (rate === null) {
      /*
       * 🔴 **缺失字段必须回落到先验**（§十四）：这里**什么都不做** ——
       * 不推维度、不动分街条目。等价于「没有这条证据」。
       * 绝不能把缺失当 0（那会把「没观测」变成「观测到他从不这样做」）。
       */
      trace.push({
        stat, observedRate: null, effectiveRate: spec.priorRate,
        opportunities: 0, successes: 0, approximated: false,
        priorWeight: spec.priorWeight, priorRate: spec.priorRate,
        frequencyTier: spec.frequencyTier, confidence: 0,
        streetTrait: mapping?.streetTrait ?? null, streetTraitEffectiveRate: null,
        noteZh: `「${stat}」未观测（null）⇒ **不使用该证据**，相关维度与分街因子保持先验（不是 0）`,
      });
      continue;
    }

    observedStatCount += 1;
    const oppOverride = input.opportunities?.[stat] ?? null;
    const ev = statEvidenceOfRate({
      stat, rate,
      handsObserved: stats.handsObserved,
      opportunitiesOverride: oppOverride,
      archetype: input.baseArchetype,
    });

    // ---- 维度：按极性推送（只在它语义所属的轴上） ----
    /*
     * 🔴 **推力必须用「实测相对中性的偏离」，不能用 `effectiveRate`**。
     *
     * `effectiveRate` 已经含了先验（它是后验均值）。若用它算推力，
     * 「先验 0.02（跟注站不爱弃）、实测 0.19」时的偏离
     * `center(0.19) = −0.62` 就**几乎全是先验的贡献** —— 等于把标签
     * **数了两次**（一次经 `effectiveRate`，一次经维度）。
     *
     * 正确分解：
     *
     * ```text
     * 实测相对中性的偏离 = center(observedRate)        ← 纯证据
     * 证据强度           = confidence                  ← 样本量
     * 推力               = polarity × 偏离 × confidence ← 先验不参与
     * ```
     *
     * 先验已通过「标签维度本身」进入模型
     *（`resolveTendencyDimensions` 的 `measured × w + archetype × (1−w)`），
     * 因此这里**只补上实测那部分**。
     *
     * ⚠️ 零机会时 `observedRate === null` ⇒ 推力恒为 0（纯先验），
     * 这正是 §十一 要求的「无统计 = V2 逐位一致」。
     */
    const polarity = STAT_DIMENSION_POLARITY[stat];
    const observedCenter = ev.observedRate === null ? 0 : centerOf(ev.observedRate);
    for (const dim of ['tightness', 'aggression', 'bluffTendency', 'passivity'] as const) {
      const p = polarity[dim];
      if (p === 0) continue; // 极性为 0 ⇒ 这条统计**不碰**这个维度（§七 的硬约束）
      acc[dim].num += p * observedCenter * ev.confidence;
      acc[dim].den += Math.abs(p) * ev.confidence;
    }

    // ---- 分街条目：同样的收缩，但存成「倾向强度」0..1 ----
    if (mapping !== null && mapping.streetTrait !== null) {
      /*
       * 🔴 用 `effectiveRate`（**已经**含了 `prior + Δ×conf` 的收缩），
       * 且**不再**乘可信度 —— 那会把 confidence **算两次**
       *（一次在 `effectiveRate` 里、一次在 `streetFactorOf` 外）。
       */
      streetTraitValue[mapping.streetTrait] = ev.effectiveRate;
    }

    trace.push({
      stat,
      observedRate: ev.observedRate,
      effectiveRate: ev.effectiveRate,
      opportunities: ev.opportunities,
      successes: ev.successes,
      approximated: ev.approximated,
      priorWeight: ev.priorWeight,
      priorRate: ev.priorRate,
      frequencyTier: ev.spec.frequencyTier,
      confidence: ev.confidence,
      streetTrait: mapping?.streetTrait ?? null,
      streetTraitEffectiveRate:
        mapping !== null && mapping.streetTrait !== null
          ? streetTraitValue[mapping.streetTrait]!
          : null,
      noteZh:
        `${ev.noteZh}｜对维度推力：` +
        (
          [
            ['tightness', polarity.tightness],
            ['aggression', polarity.aggression],
            ['bluffTendency', polarity.bluffTendency],
            ['passivity', polarity.passivity],
          ] as const
        )
          .filter(([, p]) => p !== 0)
          .map(([d, p]) => `${d} ${p > 0 ? '+' : ''}${(p * observedCenter * ev.confidence).toFixed(4)}`)
          .join('、') || '（该统计不影响任何维度）',
    });
  }

  // ---- 维度落地：0.5 + (加权平均偏离)/2 ----
  const resolvedOf = (dim: 'tightness' | 'aggression' | 'bluffTendency' | 'passivity'): number => {
    const { num, den } = acc[dim];
    if (!(den > 0)) return 0.5; // 没有任何该轴证据 ⇒ 精确 0.5 ⇒ 下游恒等
    return clamp01(0.5 + (num / (priorMass + den)) / 2);
  };
  const dims: ResolvedDimensions = {
    tightness: resolvedOf('tightness'),
    aggression: resolvedOf('aggression'),
    bluffTendency: resolvedOf('bluffTendency'),
    passivity: resolvedOf('passivity'),
  };

  // ---- 分街因子 ----
  const factorsOf = (street: Street): StreetFactors => {
    const foldTrait =
      street === 'FLOP' ? streetTraitValue.foldToFlopBet
        : street === 'TURN' ? streetTraitValue.foldToTurnBet
          : street === 'RIVER' ? streetTraitValue.foldToRiverBet
            : 0.5;
    const xrTrait =
      street === 'FLOP' ? streetTraitValue.flopCheckRaise
        : street === 'TURN' ? streetTraitValue.turnCheckRaise
          : street === 'RIVER' ? streetTraitValue.riverCheckRaise
            : 0.5;
    const foldScale = streetFactorOf(foldTrait);
    return Object.freeze({
      foldScale,
      /*
       * 🔴 跟注倍率**必须与弃牌倍率反向耦合**，否则会同时「更爱弃」又「更爱跟」，
       * 三者相加不再守恒（§十三 要求 Fold+Call+Raise ≈ 1）。
       * 这里用 `2 − foldScale`：弃牌 ×1.35 ⇒ 跟注 ×0.65，对称且有界。
       */
      callScale: Math.max(0.1, Math.min(2, 2 - foldScale)),
      checkRaiseScale: streetFactorOf(xrTrait),
    });
  };

  const street: StreetProfile = Object.freeze({
    PREFLOP: factorsOf('PREFLOP'),
    FLOP: factorsOf('FLOP'),
    TURN: factorsOf('TURN'),
    RIVER: factorsOf('RIVER'),
  });

  const confidenceTierZh =
    observedStatCount === 0
      ? '无（无任何实测统计 ⇒ 完全依赖标签先验）'
      : stats.handsObserved >= 500 ? '高'
        : stats.handsObserved >= 100 ? '中高'
          : stats.handsObserved >= 30 ? '中' : '低（小样本，已强收缩到先验）';

  return Object.freeze({
    baseArchetype: input.baseArchetype,
    observedStats: stats,
    resolved: Object.freeze({ dimensions: Object.freeze(dims), street }),
    issues: normalized.issues,
    trace: Object.freeze(trace),
    observedStatCount,
    confidenceTierZh,
    noteZh:
      `标签「${input.baseArchetype ?? '无'}」（**Prior**）` +
      `＋实测统计 ${observedStatCount}/${ALL_OBSERVED_STAT_KEYS.length} 项（${stats.handsObserved} 手）` +
      ` ⇒ 解析后维度 tightness ${dims.tightness.toFixed(3)} / aggression ${dims.aggression.toFixed(3)}` +
      ` / bluffTendency ${dims.bluffTendency.toFixed(3)} / passivity ${dims.passivity.toFixed(3)}` +
      `｜可信度档 ${confidenceTierZh}` +
      (observedStatCount === 0 ? '｜⚠️ 无实测 ⇒ 与 V2 archetype-only **逐位一致**' : ''),
  });
}

/** 由解析结果取「某一街」的因子（不在该街的分街统计不会影响它） */
export function factorsForStreet(p: ResolvedPlayerProfile, street: Street): StreetFactors {
  return p.resolved.street[street];
}

