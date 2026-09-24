/**
 * 人物画像量化（PLAYER PROFILE QUANTIFICATION V1）—— 数据模型与行为先验
 *
 * ## 链路（必须严格按这个方向，禁止反向修正）
 *
 * ```text
 * Player Profile → Node-specific Behavior → P(Action | Hand, Node, Profile)
 *   → Combo Reweighting → Weighted Range → Hero Equity → EV → Decision
 * ```
 *
 * 本模块**只产出「动作概率」**：不碰权益、不碰 EV、不碰最终动作。
 * 标签（NIT/TAG/LAG/MANIAC/CALLING_STATION）**只**作为先验向量的来源，
 * 永远不直接乘到 combo 权重上（§三/§四十四）。
 *
 * 【数学确定】收缩公式 = Beta-Binomial 后验均值；【工程约束】先验权重是**伪计数**，
 * 不是实测样本量（§二十八：不得为了数值化而伪造精确度）。
 */

import type { QuickProfile } from '../../app/manualInput/manualInput.ts';
/*
 * 🔴 **中性校准层来自既有实现，不重新实现**（§十七 单一模型）。
 *
 * `likelihoodWeights` / `tierWeightOf` 是本项目**已经校准过**的档位曲线
 * （`ABNORMAL_WEIGHTS` + 下注量放大器），中性画像的 `baseLikelihood`
 * 直接取它 —— 这样 NEUTRAL_PARITY 才可能**逐位**成立。
 *
 * ⚠️ 这是 `domain → app` 的**值导入**。项目已有同向先例
 * （`domain/postflop/exploit.ts` 导入 `QuickProfile`、
 * `domain/poker/equityPolicy.ts` 导入 `DecisionDeadline`），
 * 因此与既有分层实践一致；且这些常量是纯函数/纯数据，无副作用。
 */
import { likelihoodWeights, tierWeightOf } from '../../app/manualInput/likelihoodModel.ts';

/* ============================================================
 * ① StatEvidence：任何比率都必须带「机会数」，不能只存一个数
 * ============================================================ */

export const StatSource = {
  OBSERVED_HAND_HISTORY: 'OBSERVED_HAND_HISTORY',
  MANUAL_USER_INPUT: 'MANUAL_USER_INPUT',
  PROFILE_PRIOR: 'PROFILE_PRIOR',
  ENVIRONMENT_PRIOR: 'ENVIRONMENT_PRIOR',
} as const;
export type StatSource = (typeof StatSource)[keyof typeof StatSource];

export const STAT_SOURCE_ZH: Readonly<Record<StatSource, string>> = Object.freeze({
  OBSERVED_HAND_HISTORY: '实测手牌历史',
  MANUAL_USER_INPUT: '人工画像（主观判断，非实测）',
  PROFILE_PRIOR: '玩家类型先验（标签 → 先验向量）',
  ENVIRONMENT_PRIOR: '环境/池先验（无任何个人证据）',
});

export type StatEvidence = {
  /** 实测比率（**没有实测则为 null**，不得用先验冒充） */
  observedRate: number | null;
  /** 该行为的**机会数**（§二十九：不是总手数） */
  opportunities: number;
  /** 实测成功次数 */
  successes: number;
  /** 未知结果的机会数（§三十：不得当成「不是诈唬」） */
  unknownOutcomeOpportunities: number;
  /** 先验比率（个人实测缺失时用它起步） */
  priorRate: number;
  /** 先验伪计数权重（越大越不信小样本） */
  priorWeight: number;
  /** **最终进入模型**的比率 = 后验均值 */
  effectiveRate: number;
  /** 置信度 = opportunities / (opportunities + priorWeight) */
  confidence: number;
  source: StatSource;
  noteZh: string;
};

export const ENVIRONMENT_PRIOR_WEIGHT = 6;
export const MANUAL_READ_PSEUDO_COUNT = 3;
export const MANUAL_READ_CONFIDENCE_CAP = 0.35;

/**
 * 构造一条行为证据。
 *
 * ```text
 * effectiveRate = (priorRate × priorWeight + successes) / (priorWeight + opportunities)
 * ```
 *
 * 性质（有测试锁）：单调（成功数↑ ⇒ 比率↑）｜有界 [0,1]｜
 * 小样本 ≈ 先验（2/2 不会变成 100%）｜大样本 → 实测（机会数 ≫ 先验权重）。
 */
export function statEvidenceOf(input: {
  successes: number;
  opportunities: number;
  priorRate: number;
  priorWeight: number;
  source: StatSource;
  /** 未知结果的机会数（分开记，**不**计入分母的成功/失败推断） */
  unknownOutcomeOpportunities?: number;
}): StatEvidence {
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  const opportunities = Math.max(0, input.opportunities);
  const successes = Math.max(0, Math.min(opportunities, input.successes));
  const priorRate = clamp01(input.priorRate);
  const priorWeight = Math.max(0, input.priorWeight);
  /*
   * 🔴 **零机会时必须**逐位**返回先验**（V2 · NEUTRAL_PARITY 的必需条件）。
   *
   * 原式在 `opportunities === 0` 时退化为 `(priorRate × priorWeight) / priorWeight`：
   * 实数域恒等于 `priorRate`，**浮点**上却不总是逐位相等 ——
   * 实测 `(0.2 × 6) / 6 = 0.20000000000000004`（差 1 ULP）。
   *
   * 那 1 ULP 会让「中性画像的几率比恒为 1.000」不成立，于是 NEUTRAL_PARITY
   * 只能做到 ≈5.55e-17 而做不到**逐位** —— 而「逐位」正是让统一路径
   * 可以**取代**闸门（而不是与旧路径并存）的前提（§四十五）。
   *
   * 语义上也更正确：**没有观测时，生效值就是先验本身**，不必绕一圈除法。
   */
  const effectiveRate =
    opportunities === 0
      ? priorRate
      : (priorRate * priorWeight + successes) / (priorWeight + opportunities);
  return Object.freeze({
    observedRate: opportunities === 0 ? null : successes / opportunities,
    opportunities,
    successes,
    unknownOutcomeOpportunities: Math.max(0, input.unknownOutcomeOpportunities ?? 0),
    priorRate,
    priorWeight,
    effectiveRate,
    confidence: opportunities === 0 ? 0 : opportunities / (opportunities + priorWeight),
    source: input.source,
    noteZh:
      `${STAT_SOURCE_ZH[input.source]}：实测 ${opportunities === 0 ? '—' : `${successes}/${opportunities}`}` +
      `｜未知结果 ${input.unknownOutcomeOpportunities ?? 0} 次（**不计入分母**）` +
      `｜先验 ${priorRate.toFixed(3)}（伪计数 ${priorWeight}）⇒ 生效 ${effectiveRate.toFixed(3)}` +
      `｜置信度 ${(opportunities === 0 ? 0 : opportunities / (opportunities + priorWeight)).toFixed(3)}`,
  });
}

/**
 * 人工画像：**明确标成 MANUAL_USER_INPUT**，按伪计数进入先验（§二十七）。
 * 绝不允许把它伪装成「观测了 N 手」。
 */
export function manualReadEvidence(input: {
  tendency: 'VERY_LOW' | 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';
  environmentPrior: number;
}): StatEvidence {
  const rate = {
    VERY_LOW: 0.05,
    LOW: 0.2,
    MEDIUM: 0.45,
    HIGH: 0.65,
    VERY_HIGH: 0.8,
  }[input.tendency];
  return statEvidenceOf({
    successes: 0,
    opportunities: 0,
    priorRate: rate,
    priorWeight: MANUAL_READ_PSEUDO_COUNT,
    source: StatSource.MANUAL_USER_INPUT,
  });
}

/* ============================================================
 * ② 行为条目（主动 / 被动分开，§七）
 * ============================================================ */

export const BehaviorTraitKey = {
  /** 主动：河牌会诈唬 */
  RIVER_BLUFF: 'riverBluff',
  /** 主动：河牌大注里含诈唬 */
  RIVER_LARGE_BET_BLUFF: 'riverLargeBetBluff',
  /** 主动：错过听牌转诈唬 */
  MISSED_DRAW_BLUFF: 'missedDrawBluff',
  /** 主动：我过牌后他主动开火（§八/§三十八 line-specific） */
  PROBE_AFTER_TURN_CHECK_BACK: 'probeAfterTurnCheckBack',
  /** 主动：薄价值下注 */
  THIN_VALUE_BET: 'thinValueBet',
  /** 被动：面对下注跟得太宽（**与主动条目完全独立**，§三十五） */
  CALL_TOO_WIDE: 'callTooWide',
} as const;
export type BehaviorTraitKey = (typeof BehaviorTraitKey)[keyof typeof BehaviorTraitKey];

export const BEHAVIOR_TRAIT_ZH: Readonly<Record<BehaviorTraitKey, string>> = Object.freeze({
  riverBluff: '河牌诈唬倾向（主动）',
  riverLargeBetBluff: '河牌大注诈唬倾向（主动）',
  missedDrawBluff: '错过听牌转诈唬倾向（主动）',
  probeAfterTurnCheckBack: '我过牌后主动开火倾向（主动）',
  thinValueBet: '薄价值下注倾向（主动）',
  callTooWide: '跟注过宽倾向（**被动**，不参与主动下注模型）',
});

/** 标签 → 行为先验向量（**只到这里为止**，不进 combo 权重） */
export const ARCHETYPE_BEHAVIOR_PRIORS: Readonly<
  Partial<Record<QuickProfile, Partial<Record<BehaviorTraitKey, { rate: number; weight: number }>>>>
> = Object.freeze({
  CALLING_STATION: Object.freeze({
    // 被动型：主动条目都很低；被动条目很高 —— 两者来自**各自**的先验，不互相推导
    riverBluff: { rate: 0.15, weight: ENVIRONMENT_PRIOR_WEIGHT },
    riverLargeBetBluff: { rate: 0.08, weight: ENVIRONMENT_PRIOR_WEIGHT },
    missedDrawBluff: { rate: 0.1, weight: ENVIRONMENT_PRIOR_WEIGHT },
    probeAfterTurnCheckBack: { rate: 0.18, weight: ENVIRONMENT_PRIOR_WEIGHT },
    // `thinValueBet` 刻意不给 —— 见下方 `THIN_VALUE_TRAIT_POLICY` 的说明
    callTooWide: { rate: 0.72, weight: ENVIRONMENT_PRIOR_WEIGHT },
  }),
  /*
   * 🔴 **本次补入**（原先缺失 ⇒ 标签被选中却什么都不发生）。
   *
   * 缺失的后果是**静默失效**：`behaviorProfileOf` 找不到标签先验就回落到
   * `ENVIRONMENT_BEHAVIOR_PRIOR`，而那里的乘数恒等于 1.000 ——
   * 用户在界面上认真选了「过度诈唬」，系统收到的是一个中性画像。
   * 而 `BLUFF_HEAVY` / `UNDERBLUFFER` 恰恰是 §十八/§十九 那两个战术标签，
   * 它们的含义没有歧义，因此必须给出先验。
   *
   * ## 数值纪律
   *
   * 全部是**结构性判断**（序关系），不是估出的频率：
   * `UNDERBLUFFER < 池先验 < BLUFF_HEAVY < MANIAC`，
   * 五个主动条目**逐条严格单调**（有测试锁）。
   * `callTooWide`（**被动**条目）刻意不给：诈唬倾向不蕴含跟注宽度
   * （§七/§三十五 主动被动隔离），它保持在池先验 0.5。
   */
  BLUFF_HEAVY: Object.freeze({
    riverBluff: { rate: 0.45, weight: ENVIRONMENT_PRIOR_WEIGHT },
    riverLargeBetBluff: { rate: 0.38, weight: ENVIRONMENT_PRIOR_WEIGHT },
    missedDrawBluff: { rate: 0.5, weight: ENVIRONMENT_PRIOR_WEIGHT },
    probeAfterTurnCheckBack: { rate: 0.45, weight: ENVIRONMENT_PRIOR_WEIGHT },
    /*
     * 🔴 **刻意不给 `thinValueBet`**（回落池先验 0.35 ⇒ 乘数 1.000）。
     *
     * §十九 把 03B「激进过度诈唬」**只**定义为诈唬类条目
     * （River Bluff / Missed Draw Bluff / Large River Bet Bluff / Probe 高），
     * **从未**声称它同时薄价值下注更多。而本模型里
     * `THIN_VALUE` 的判据是「比 Hero 强」—— 也就是说
     * 「薄价值更多」= **更多能打败 Hero 的牌**。
     * 给它加一条规范没有的先验，会在 §二十 要求的单调性上直接反向：
     * 实测（9-max CO A♣J♥ 河牌 A♦8♠4♠2♣K♦ 面对 70% 池下注）
     * MANIAC 的 valueMass 48.60% → 52.35%，权益 49.48% → 46.00%（**反的**）。
     * 去掉这条声称之后，03A/03B 的差别**恰好**是 §十九 描述的那条诈唬轴。
     */
  }),
  UNDERBLUFFER: Object.freeze({
    riverBluff: { rate: 0.12, weight: ENVIRONMENT_PRIOR_WEIGHT },
    riverLargeBetBluff: { rate: 0.08, weight: ENVIRONMENT_PRIOR_WEIGHT },
    missedDrawBluff: { rate: 0.12, weight: ENVIRONMENT_PRIOR_WEIGHT },
    probeAfterTurnCheckBack: { rate: 0.15, weight: ENVIRONMENT_PRIOR_WEIGHT },
    // 同 `CALLING_STATION`：不给 `thinValueBet`（见 `THIN_VALUE_TRAIT_POLICY`）
  }),
  MANIAC: Object.freeze({
    riverBluff: { rate: 0.5, weight: ENVIRONMENT_PRIOR_WEIGHT },
    riverLargeBetBluff: { rate: 0.42, weight: ENVIRONMENT_PRIOR_WEIGHT },
    missedDrawBluff: { rate: 0.55, weight: ENVIRONMENT_PRIOR_WEIGHT },
    probeAfterTurnCheckBack: { rate: 0.5, weight: ENVIRONMENT_PRIOR_WEIGHT },
    // 同 `BLUFF_HEAVY`：不给 `thinValueBet` —— 诈唬型不蕴含「薄价值更多」
    callTooWide: { rate: 0.45, weight: ENVIRONMENT_PRIOR_WEIGHT },
  }),
  LOOSE: Object.freeze({
    riverBluff: { rate: 0.3, weight: ENVIRONMENT_PRIOR_WEIGHT },
    missedDrawBluff: { rate: 0.3, weight: ENVIRONMENT_PRIOR_WEIGHT },
    probeAfterTurnCheckBack: { rate: 0.3, weight: ENVIRONMENT_PRIOR_WEIGHT },
    callTooWide: { rate: 0.6, weight: ENVIRONMENT_PRIOR_WEIGHT },
  }),
  VERY_TIGHT: Object.freeze({
    riverBluff: { rate: 0.12, weight: ENVIRONMENT_PRIOR_WEIGHT },
    missedDrawBluff: { rate: 0.12, weight: ENVIRONMENT_PRIOR_WEIGHT },
    // 同 `CALLING_STATION`：不给 `thinValueBet`（见 `THIN_VALUE_TRAIT_POLICY`）
    callTooWide: { rate: 0.25, weight: ENVIRONMENT_PRIOR_WEIGHT },
  }),
});

/**
 * 🔴 **`thinValueBet` 的先验政策**（结构决定，不是调参）。
 *
 * ## 事实
 *
 * 在 `betLikelihoodOf` 里，`THIN_VALUE` 的判据是
 * 「`classifyRiverAction` ⇒ `THIN_VALUE`」，而它来自
 * **`versusHero === 'STRONGER'`** —— 也就是说：
 *
 * > **薄价值这一类，就是「能打败 Hero 的那些牌」。**
 *
 * ## 后果
 *
 * `thinValueBet` 是**唯一**会缩放「打败 Hero 那一侧」的动作条目
 * （`NUT_VALUE` / `STRONG_VALUE` / `MEDIUM_VALUE` 都不带任何画像乘数）。
 * 因此任何按标签给出的 `thinValueBet` 先验，都会让该标签同时携带
 * 一条**规范没有声称的**价值侧主张，并直接污染 §二十 要求的权益单调性。
 *
 * 实测（9-max CO A♣J♥｜河牌 A♦8♠4♠2♣K♦｜BB 下注 70% 池）：
 *
 * ```text
 * 带 thinValueBet 先验：
 *   CALLING_STATION thinValueBet 0.22（×0.847）  权益 68.17%
 *   MANIAC          thinValueBet 0.50（×1.176）  权益 67.99%   ← 反的
 *   thin 质量 19.98% → 21.57%（+1.59pp，全部是「打败 Hero」的牌）
 *   它几乎抵消了同一次对比里 +6.5pp 的诈唬质量（Hero 赢的那些牌）
 * ```
 *
 * `CALLING_STATION` 的薄价值**低**（×0.847）反而把「打败 Hero」的质量压下去
 * ⇒ 英雄权益被抬高。两头都不对，**方向由薄价值这一条决定，而不是由诈唬轴决定**。
 *
 * ## 决定
 *
 * **标签先验一律不给 `thinValueBet`**（回落池先验 0.35 ⇒ 乘数 1.000）。
 * 于是 03A/03B 的差别**恰好**是 §十九 描述的那条诈唬轴
 * （River Bluff / Missed Draw Bluff / Large River Bet Bluff / Probe）。
 *
 * ## 机制没有被删除
 *
 * `thinValueBet` 仍然可以通过
 * `behaviorProfileOf({ manual: { thinValueBet: … } })` 或
 * `observed`（带机会数）表达 —— 那才是「我确实读到他爱薄价值下注」的
 * 诚实入口，而不是从「他是跟注站」推出来的跨维度主张（§七/§三十五）。
 */
const THIN_VALUE_TRAIT_POLICY = '标签先验不给 thinValueBet：它只缩放「打败 Hero」的一侧';
void THIN_VALUE_TRAIT_POLICY;

/**
 * **刻意中性**的标签 —— 出现在这里的意思是
 * 「这个标签**不**改变行为先验」，而不是「我们忘了给它写先验」。
 *
 * ## 为什么必须显式声明（而不是靠「表里没有」表达）
 *
 * 「表里没有」与「忘了写」在数据上**无法区分**，这正是
 * `BLUFF_HEAVY` / `UNDERBLUFFER` 静默失效一直没被发现的原因：
 * 它们被选中、被记录，然后什么都不发生。
 * 显式声明把这个区别变成可断言的东西（见 `selfCheckArchetypePriors`）。
 *
 * | 标签 | 中性的理由 |
 * |---|---|
 * | `UNKNOWN` | 语义就是「未知」⇒ 必须等于池先验，否则等于替陌生人套一个原型（§二十五） |
 * | `NORMAL` | 「常规玩家」的定义**就是**牌池基线本身 ⇒ 中性是定义，不是缺失 |
 * | `TIGHT` | 它描述的是**翻前入池宽度**，与「河牌主动诈唬倾向」之间没有确定的单调关系（紧凶型恰恰高频诈唬）⇒ 无依据，待实测替换 |
 * | `VERY_LOOSE` | 与 `LOOSE` 只差程度，而「更松 ⇒ 更爱诈唬」并不成立（超松被动型反而更少诈唬）⇒ 无依据，待实测替换 |
 * | `AGGRESSIVE` | 「激进」在本项目指**整体进攻性**（下注/加注频率），它**不专门指诈唬** —— 激进也可能是高频价值下注；映射成诈唬倾向属于跨维度推断 ⇒ 无依据 |
 */
export const NEUTRAL_ARCHETYPES: Readonly<Partial<Record<QuickProfile, string>>> = Object.freeze({
  UNKNOWN: '语义即「未知」⇒ 等于池先验（替陌生人套原型＝编造数据）',
  NORMAL: '定义即牌池基线 ⇒ 中性是定义，不是缺失',
  TIGHT: '描述翻前入池宽度，与河牌诈唬倾向无确定单调关系（紧凶型高频诈唬）⇒ 无依据',
  VERY_LOOSE: '与 LOOSE 只差程度，「更松 ⇒ 更爱诈唬」不成立（超松被动型更少诈唬）⇒ 无依据',
  AGGRESSIVE: '指整体进攻性而非诈唬；激进也可能是高频价值下注 ⇒ 跨维度推断，无依据',
});

/**
 * 标签先验**覆盖自检**：不允许存在既无先验、也未声明中性的「静默失效」标签。
 *
 * @param archetypes 全部标签（**由调用方传入**：`QuickProfile` 是 `app` 层的值，
 *   而本模块是领域层，不引入 `domain → app` 的**运行时**依赖；
 *   测试传 `ALL_QUICK_PROFILES`）。
 * @returns 问题列表（空数组 = 通过）
 */
export function selfCheckArchetypePriors(archetypes: readonly QuickProfile[]): string[] {
  const problems: string[] = [];
  for (const archetype of archetypes) {
    const hasPrior = Object.prototype.hasOwnProperty.call(ARCHETYPE_BEHAVIOR_PRIORS, archetype);
    const declaredNeutral = Object.prototype.hasOwnProperty.call(NEUTRAL_ARCHETYPES, archetype);
    if (!hasPrior && !declaredNeutral) {
      problems.push(
        `标签「${archetype}」既没有行为先验，也没有声明为刻意中性 —— ` +
          '这是一个**静默失效**的标签：它会被选中、被记录，然后什么都不发生',
      );
    }
    if (hasPrior && declaredNeutral) {
      problems.push(`标签「${archetype}」同时拥有行为先验与「刻意中性」声明 —— 二者只能有一个`);
    }
  }
  return problems;
}

/** 无任何个人证据时的池/环境先验（§二十四：不允许「一律 0.5」） */
export const ENVIRONMENT_BEHAVIOR_PRIOR: Readonly<Record<BehaviorTraitKey, number>> = Object.freeze({
  riverBluff: 0.28,
  riverLargeBetBluff: 0.2,
  missedDrawBluff: 0.25,
  probeAfterTurnCheckBack: 0.3,
  thinValueBet: 0.35,
  callTooWide: 0.5,
});

export type PlayerBehaviorProfile = {
  /** 未来可从历史库持续更新（§二十三）；V1 只保证结构上能绑定 */
  playerId: string;
  playerName: string | null;
  /** 高层标签只用于 UI 与先验（§三） */
  archetype: QuickProfile | null;
  traits: Readonly<Record<BehaviorTraitKey, StatEvidence>>;
  /** 是否只是池先验（未知玩家，§二十五） */
  isUnknownPlayer: boolean;
  /**
   * 🔴 **这个标签是否真的有行为先验**（§二十五：不得假装确定）。
   *
   * | 值 | 含义 |
   * |---|---|
   * | `true` | 标签在 `ARCHETYPE_BEHAVIOR_PRIORS` 里 ⇒ 它与池先验**不同** |
   * | `false` | 标签**刻意中性**（见 `NEUTRAL_ARCHETYPES`）⇒ 行为条目 == 池先验 |
   *
   * ## 为什么必须单独一个字段
   *
   * `isUnknownPlayer` 只回答「有没有给标签」（`archetype === null`）。
   * 而「给了 `NORMAL` / `BLUFF_HEAVY`」与「什么都没给」在**行为上完全一致**
   * （乘数恒为 1.000）—— 界面若据此写「画像已生效」就是在
   * **假装确定**，正是 §二十五 点名的那类风险。
   * 现在界面可以如实区分「有画像」与「有标签但没有先验」。
   */
  archetypePriorAvailable: boolean;
  /** 该画像的中文说明（可审计：标签来源、是否中性、是否有实测/人工条目） */
  priorNoteZh: string;
};

/** 构造行为画像：实测 > 人工画像 > 标签先验 > 池先验（§二十四/§二十六） */
export function behaviorProfileOf(input: {
  playerId: string;
  playerName?: string | null;
  archetype?: QuickProfile | null;
  /** 逐条人工画像（可选）：只对有把握的条目给 */
  manual?: Partial<Record<BehaviorTraitKey, 'VERY_LOW' | 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH'>>;
  /** 逐条实测（带**机会数**）：来源必须是真实历史统计 */
  observed?: Partial<Record<BehaviorTraitKey, { successes: number; opportunities: number; unknownOutcomeOpportunities?: number }>>;
}): PlayerBehaviorProfile {
  const archetype = input.archetype ?? null;
  const traits = {} as Record<BehaviorTraitKey, StatEvidence>;
  for (const key of Object.values(BehaviorTraitKey)) {
    const archetypePrior = archetype === null ? undefined : ARCHETYPE_BEHAVIOR_PRIORS[archetype]?.[key];
    const priorRate = archetypePrior?.rate ?? ENVIRONMENT_BEHAVIOR_PRIOR[key];
    const priorWeight = archetypePrior?.weight ?? ENVIRONMENT_PRIOR_WEIGHT;
    const manual = input.manual?.[key];
    const observed = input.observed?.[key];
    if (observed !== undefined) {
      traits[key] = statEvidenceOf({
        successes: observed.successes,
        opportunities: observed.opportunities,
        priorRate,
        priorWeight,
        source: StatSource.OBSERVED_HAND_HISTORY,
        ...(observed.unknownOutcomeOpportunities === undefined
          ? {}
          : { unknownOutcomeOpportunities: observed.unknownOutcomeOpportunities }),
      });
      continue;
    }
    if (manual !== undefined) {
      const manualEvidence = manualReadEvidence({ tendency: manual, environmentPrior: priorRate });
      // 人工画像作为**伪计数先验**叠加在标签先验之上（不冒充实测）
      traits[key] = statEvidenceOf({
        successes: 0,
        opportunities: 0,
        priorRate: manualEvidence.effectiveRate,
        priorWeight: MANUAL_READ_PSEUDO_COUNT,
        source: StatSource.MANUAL_USER_INPUT,
      });
      continue;
    }
    traits[key] = statEvidenceOf({
      successes: 0,
      opportunities: 0,
      priorRate,
      priorWeight,
      source: archetypePrior === undefined ? StatSource.ENVIRONMENT_PRIOR : StatSource.PROFILE_PRIOR,
    });
  }
  return Object.freeze({
    playerId: input.playerId,
    playerName: input.playerName ?? null,
    archetype,
    traits: Object.freeze(traits),
    isUnknownPlayer: input.archetype === null || input.archetype === undefined,
    archetypePriorAvailable:
      archetype !== null &&
      Object.prototype.hasOwnProperty.call(ARCHETYPE_BEHAVIOR_PRIORS, archetype),
    priorNoteZh: priorNoteOf({
      archetype,
      manualKeys: Object.keys(input.manual ?? {}),
      observedKeys: Object.keys(input.observed ?? {}),
    }),
  });
}

/**
 * 画像来源的中文说明（§四十三：可审计）。
 *
 * 它必须让界面**无法**把「有标签但先验中性」说成「画像已生效」。
 */
function priorNoteOf(input: {
  archetype: QuickProfile | null;
  manualKeys: readonly string[];
  observedKeys: readonly string[];
}): string {
  const extra: string[] = [];
  if (input.observedKeys.length > 0) {
    extra.push(`实测条目 ${input.observedKeys.length} 条（${input.observedKeys.join('、')}）`);
  }
  if (input.manualKeys.length > 0) {
    extra.push(`人工条目 ${input.manualKeys.length} 条（${input.manualKeys.join('、')}）`);
  }
  const suffix = extra.length === 0 ? '' : `｜${extra.join('｜')}`;

  if (input.archetype === null) {
    return `无标签：行为条目只来自人工/实测（缺失的条目回落到池先验，**不是**「一律 0.5」）${suffix}`;
  }
  if (Object.prototype.hasOwnProperty.call(ARCHETYPE_BEHAVIOR_PRIORS, input.archetype)) {
    return `标签「${input.archetype}」提供行为先验（与池先验**不同**）${suffix}`;
  }
  const reason = NEUTRAL_ARCHETYPES[input.archetype] ?? '未声明（应由 selfCheckArchetypePriors 拦下）';
  return `标签「${input.archetype}」**刻意中性**：${reason} —— 行为条目等于池先验，画像在这一层不提供信息${suffix}`;
}

/* ============================================================
 * ③ NodeContext + 手牌类别 + 尺寸档（§八/§十/§十一）
 * ============================================================ */

/**
 * 🔴 **V2 §六/§四十一：`MEDIUM_VALUE` 已从本枚举删除。**
 *
 * 它在这套判据下**永远不可能被产生**：`classifyRiverAction` 对
 * `versusHero === 'STRONGER'` 只给 `CLEAR_VALUE`（档 0–1 ⇒ NUT / STRONG）与
 * `THIN_VALUE`（档 2），档 3 落到 `SHOWDOWN`。因此旧枚举里的 `MEDIUM_VALUE`
 * 是一条**生产永远走不到的分支**（其 `base = 0.4` 是死代码）。
 * 规范 §六/§四十一 要求「不得留下生产永不可达的枚举成员」⇒ 删除，
 * 而不是让它继续假装存在。
 *
 * ⚠️ **这与 `RelativeHandRole.MEDIUM_VALUE`（`domain/postflop/types.ts`）
 * 不是同一个枚举** —— 那个是翻后**手牌角色**，可达且被
 * `relativeHandRole` / `valueBetGate` 与多个测试广泛使用，**未改动**。
 *
 * 若将来要让「中等价值」在**本**枚举里可达，必须先把它在
 * `classifyRiverAction` 里真实分出来（例如 `STRONGER` + 档 3 单列），
 * 并同步更新 `riverActionMassesOf` 与 03A/03B 黄金夹具；
 * `test/riverComboClassCoverage.test.ts` 的覆盖锁会强制这一步。
 */
export type RiverComboClass =
  | 'NUT_VALUE'
  | 'STRONG_VALUE'
  | 'THIN_VALUE'
  | 'SHOWDOWN_VALUE'
  | 'MISSED_FLUSH_DRAW'
  | 'MISSED_STRAIGHT_DRAW'
  | 'MISSED_COMBO_DRAW'
  | 'PURE_AIR';

export const BetSizeBucketOf = (ratioToPot: number): 'SMALL' | 'MEDIUM' | 'LARGE' | 'OVERBET' =>
  ratioToPot >= 1.25 ? 'OVERBET' : ratioToPot >= 0.6 ? 'LARGE' : ratioToPot >= 0.4 ? 'MEDIUM' : 'SMALL';

export type BehaviorNodeContext = {
  street: 'FLOP' | 'TURN' | 'RIVER';
  heroPosition: string;
  villainPosition: string;
  potType: 'SRP' | 'THREE_BET' | 'LIMPED' | 'OTHER';
  playerCount: number;
  /** 前序行动：这一项让「我 check-back → 他 probe」与「他跟注 → 他 donk」不同（§三十八） */
  previousStreetLine: 'TURN_CHECK_BACK' | 'TURN_BET_CALL' | 'OTHER';
  currentAction: 'BET' | 'CHECK' | 'CALL' | 'RAISE';
  sizeBucket: 'SMALL' | 'MEDIUM' | 'LARGE' | 'OVERBET';
  boardTexture: 'DRY' | 'SEMI_WET' | 'WET' | 'PAIRED' | 'MONOTONE';
};

/* ============================================================
 * ④ Action Likelihood：P(动作 | 手牌类别, 节点, 画像)
 * ============================================================ */

const VALUE_CLASSES: readonly RiverComboClass[] = ['NUT_VALUE', 'STRONG_VALUE'];
const MISSED_DRAW_CLASSES: readonly RiverComboClass[] = [
  'MISSED_FLUSH_DRAW',
  'MISSED_STRAIGHT_DRAW',
  'MISSED_COMBO_DRAW',
];

/* ------------------------------------------------------------
 * V2 · 画像条件化：**几率比（Bayesian likelihood ratio）**
 * ------------------------------------------------------------
 *
 * 🔴 **这是结构性选择，不是调参。**
 *
 * 一个 Bernoulli 动作在「该玩家做这个动作的率 = r」下的似然是 `r`；
 * 而「相对于池先验 `π` 的证据强度」在贝叶斯意义下就是**几率比**：
 *
 * ```text
 * cond(trait) = (r/(1−r)) / (π/(1−π))
 * ```
 *
 * 三条性质是选它的理由（都是数学性质，不是拟合出来的）：
 *
 * 1. **中性恒等**：`r === π` ⇒ `cond ≡ 1.0`（**逐位**成立，因为分子分母
 *    是同一个浮点表达式）⇒ 中性画像与既有基线**逐位一致**，NEUTRAL_PARITY
 *    由构造保证；
 * 2. **有界且单调**：`r ∈ (0,1)` 上严格单调递增，且以几率的形式把
 *    0.10 → 0.55 这种「看起来只差 0.45」的差异放大成 **≈11× 的动态范围**
 *    （旧的有界线性式 `(0.5+r)/(0.5+π)` 只有 ≈1.75×）——
 *    这正是 V1 实测 `PROFILE_RANGE_INFLUENCE = TRIVIAL` 的成因；
 * 3. **可解释**：它就是「观察到这个动作后，关于该条目的赔率改变了多少倍」，
 *    可以直接写进 trace 供审计（§四十三）。
 *
 * ⚠️ 旧的有界线性式 `(0.5+rate)/(0.5+envPrior)` 已**删除**，不再有任何调用者。
 */
const rateOdds = (rate: number): number => {
  const p = Math.max(0.001, Math.min(0.999, rate));
  return p / (1 - p);
};

/** 相对池先验的**几率比**；中性画像（`rate === envPrior`）恒为 `1.0`。 */
const cond = (key: BehaviorTraitKey, rate: number): number =>
  rateOdds(rate) / rateOdds(ENVIRONMENT_BEHAVIOR_PRIOR[key]);

/** trace 的一段：记录**每一个**被施加的因子与它背后的条目/生效值（§四十三 可审计）。 */
export type UnifiedFactorTrace = {
  stage: 'BASE' | 'SIZE' | 'NODE' | 'PROFILE';
  factor: number;
  trait?: BehaviorTraitKey;
  rate?: number;
  noteZh: string;
};

/**
 * **统一动作似然**（V2 §十七 单一模型）—— 生产路径上**唯一**的似然来源。
 *
 * ```text
 * likelihood = baseLikelihood × sizeAdjustment × nodeAdjustment × profileAdjustment
 * ```
 *
 * | 段 | 含义 | 中性画像时的值 |
 * |---|---|---|
 * | `baseLikelihood` | **中性校准层** = 既有档位权重（`likelihoodWeights` × 该 combo 的档位） | 既有基线本身 |
 * | `sizeAdjustment` | 尺寸专属语义（LARGE/OVERBET 才施加「大注诈唬」条目） | **1.0** |
 * | `nodeAdjustment` | 前序线（`TURN_CHECK_BACK` ⇒ 我让牌后他开火倾向） | **1.0** |
 * | `profileAdjustment` | 类别专属的画像条件化（几率比） | **1.0** |
 *
 * 🔴 **NEUTRAL_PARITY 由构造保证**：中性画像下三个调整因子都**恰好**是
 * `1.0`（几率比分子分母同式），于是 `likelihood === baseLikelihood` ——
 * 而 `baseLikelihood` **就是** 1.0.4 的档位权重，因此结果与旧实现
 * **逐位一致**，不需要任何容差。
 *
 * ⚠️ `callTooWide`（被动条目）**不参与**本函数（§七/§三十五）：
 * 它只属于「面对下注」的响应模型。
 */
export type UnifiedActionLikelihood = BetLikelihood & {
  /** 中性校准层：**既有档位权重本身**（中性画像下 `likelihood` 与它逐位相等） */
  baseLikelihood: number;
  /** 钳位**之前**的原始值 —— 用于证明钳位没有偷偷吸收饱和（父代理要求） */
  rawLikelihood: number;
  /** 钳位是否真的起作用；**必须为 `false`**，否则类别区分已被压平 */
  clamped: boolean;
  /** 真正参与计算的倍率 = 已施加条目的**几何平均** */
  combinedAdjustment: number;
  /** 已施加的条件化条目数（几何平均的分母） */
  appliedTraitCount: number;
  /** ⚠️ 各段**原始乘积**，仅供审计 —— 不可再相乘回去 */
  sizeAdjustment: number;
  nodeAdjustment: number;
  profileAdjustment: number;
  trace: readonly UnifiedFactorTrace[];
};

export function estimateUnifiedActionLikelihood(input: {
  /** 手牌类别（来自 `riverComboClassOf().category`） */
  semanticClass: RiverComboClass;
  /**
   * **既有档位**（来自 `riverComboClassOf().strengthBucket`，0 最强 … 5 最弱）。
   * 必须由**同一个来源**提供 —— 在别处重新推导档位就是第二把尺子。
   */
  strengthBucket: number;
  /** 下注额 / 底池（决定档位曲线的陡度；缺省时按既有 `likelihoodWeights` 的默认值） */
  betRatio?: number;
  node: BehaviorNodeContext;
  profile: PlayerBehaviorProfile;
  /** 当前动作（BET / RAISE）—— 只用于 trace 叙述，不改变数值 */
  action: 'BET' | 'RAISE';
  /**
   * 是否构建**审计 trace**（默认 `false`）。
   *
   * 🔴 热路径必须关掉它：本函数在河牌动作上**逐 combo** 调用（实测 Θ(449)），
   * 每 combo 建 4 个 trace 对象 + 一段中文字符串会把热路径预算打爆 ——
   * 实测「1/10/50/200/1000/5000 事件的 P50/P95/MAX」性能测试变红。
   * 审计时（探针 / 专项测试）显式传 `true`。
   */
  withTrace?: boolean;
  /**
   * 已算好的**档位权重**（可选注入）。
   *
   * 调用方（`contextBuilder`）对**同一个动作**只需算一次
   * `likelihoodWeights('AGGRESSIVE', betRatio)`，注入进来即可避免逐 combo
   * 重新归一化（那是 449 次 6 元数组分配）。缺省时本函数自行计算（单测/探针用）。
   */
  baseWeights?: readonly number[];
}): UnifiedActionLikelihood {
  /*
   * 🔴 **`traits` 缺条目必须回落到池先验，而不是崩掉整手牌**（V2.1 失败模式审计 #3）。
   *
   * `PlayerBehaviorProfile.traits` 在**类型上**是
   * `Record<BehaviorTraitKey, StatEvidence>`（非可选），但它是**外部可注入的对象**
   * （`ManualVillain.behaviorProfile`），运行时完全可以缺条目。修复前实测：
   * `traits: {}` 或只给一条 ⇒ `Cannot read properties of undefined (reading
   * 'effectiveRate')` ⇒ `stage=CONTEXT / CONTEXT_BUILD_FAILED` ⇒ **整手牌无法分析**。
   *
   * 语义上「这一条没有证据」本来就是合法状态（`behaviorProfileOf` 对没有先验的
   * 标签也是回落池先验），因此这里**回落**而不是抛错。
   * 只有**形状错误**（非法数值、successes > opportunities）才由
   * `manualInput` 在信任边界上阻断 —— 那种错误绝不能静默夹取。
   */
  const t = input.profile.traits ?? ({} as PlayerBehaviorProfile['traits']);
  /**
   * **单条目的生效比率**：缺失或非有限 ⇒ 回落池先验。
   * 这是「这一条没有证据」的合法语义，不是静默修正非法数据
   *（非法数据在 `manualInput` 的信任边界上已被阻断）。
   */
  const poolRateOf = (key: BehaviorTraitKey): number => {
    const evidence = (t as Partial<PlayerBehaviorProfile['traits']>)[key];
    const rate = evidence?.effectiveRate;
    return typeof rate === 'number' && Number.isFinite(rate)
      ? Math.max(0, Math.min(1, rate))
      : ENVIRONMENT_BEHAVIOR_PRIOR[key];
  };
  const big = input.node.sizeBucket === 'LARGE' || input.node.sizeBucket === 'OVERBET';
  /**
   * **诈唬类**（错过听牌 / 纯空气）—— 唯一接受**尺寸与节点**条件化的类别。
   *
   * 🔴 **为什么 `THIN_VALUE` 必须排除**（V2 实测：它会把符号弄反）。
   *
   * `THIN_VALUE` 的判据是 `versusHero === 'STRONGER'` ⇒ 它是**能打败 Hero**
   * 的牌。而「他愿意下大注」「他在我让牌后开火」描述的是**诈唬/进攻倾向**。
   * 把它乘到薄价值上，等于**同时**抬高「能赢 Hero」那一端；实测（03A/03B
   * 黄金手，只改画像）：
   *
   * ```text
   * THIN_VALUE 的节点因子：03A √0.512 = 0.716   03B √2.333 = 1.528
   * ⇒ 03A 的薄价值质量被压低 ⇒「被动玩家反而让 Hero 权益更高」
   *   03A 60.94% > 03B 50.02%  ← 与 §二十 要求相反
   * ```
   *
   * 隔离实验证明这不是基础范围造成的：把似然固定为中性时，
   * 两个原型的权益是 56.31% vs 56.20%（差 0.11pp，蒙特卡洛噪声内）。
   *
   * 排除之后薄价值只保留**它自己的**条目（`thinValueBet`）作为类别因子，
   * 而该条目在**所有**原型先验里都是中性的（V1 的 D4 已移除），
   * 因此对原型画像而言 `THIN_VALUE` 不再被调整；若将来用**实测/人工证据**
   * 声明薄价值倾向，该通道仍然可用。
   */
  const bluffClass =
    MISSED_DRAW_CLASSES.includes(input.semanticClass) || input.semanticClass === 'PURE_AIR';
  /** 薄价值：**只**接受 `thinValueBet` 类别因子，不接受尺寸/节点因子 */
  const thinClass = input.semanticClass === 'THIN_VALUE';
  const contributions: { trait: BehaviorTraitKey; effectiveRate: number; multiplier: number; noteZh: string }[] = [];
  const trace: UnifiedFactorTrace[] = [];
  /**
   * 本次**实际施加**的条件化因子（尺寸 / 节点两段）。
   * 类别段的因子不重复记在这里 —— `contributions` 已经逐条记录了
   * trait / 生效值 / 乘子，从那里取即可（避免两处记账漂移）。
   */
  const stageConds: { stage: 'SIZE' | 'NODE'; cond: number }[] = [];

  /* ---- 段 1：中性校准层（= 既有档位权重本身）---- */
  const baseLikelihood = tierWeightOf(
    input.baseWeights ?? likelihoodWeights('AGGRESSIVE', input.betRatio),
    input.strengthBucket,
  );
  const wantTrace = input.withTrace === true;
  if (wantTrace) trace.push({
    stage: 'BASE',
    factor: baseLikelihood,
    noteZh:
      `中性校准层：档位 ${input.strengthBucket}` +
      `${input.betRatio === undefined ? '（无下注比例）' : `，下注/底池 ${input.betRatio.toFixed(3)}`}` +
      ` ⇒ ${baseLikelihood.toFixed(6)}`,
  });

  /* ---- 段 2：尺寸专属语义（中性画像 ⇒ 1.0）---- */
  let sizeAdjustment = 1;
  /** 尺寸段施加的条目（只对诈唬端有意义） */
  const sizeTraitApplies =
    big && (MISSED_DRAW_CLASSES.includes(input.semanticClass) || input.semanticClass === 'PURE_AIR');
  if (sizeTraitApplies) {
    const rate = poolRateOf(BehaviorTraitKey.RIVER_LARGE_BET_BLUFF);
    const f = cond(BehaviorTraitKey.RIVER_LARGE_BET_BLUFF, rate);
    sizeAdjustment *= f;
    stageConds.push({ stage: 'SIZE', cond: f });
    if (wantTrace) trace.push({
      stage: 'SIZE',
      factor: f,
      trait: BehaviorTraitKey.RIVER_LARGE_BET_BLUFF,
      rate,
      noteZh:
        `尺寸 ${input.node.sizeBucket} ⇒ 施加「大注诈唬」条目 ${rate.toFixed(3)}` +
        `（池先验 ${ENVIRONMENT_BEHAVIOR_PRIOR.riverLargeBetBluff}）⇒ ×${f.toFixed(4)}`,
    });
  } else {
    if (wantTrace) trace.push({
      stage: 'SIZE',
      factor: 1,
      noteZh: `尺寸 ${input.node.sizeBucket} ⇒ 不施加尺寸专属条目 ⇒ ×1.0000`,
    });
  }

  /* ---- 段 3：节点/前序线（中性画像 ⇒ 1.0）---- */
  let nodeAdjustment = 1;
  if (bluffClass && input.node.previousStreetLine === 'TURN_CHECK_BACK') {
    const rate = poolRateOf(BehaviorTraitKey.PROBE_AFTER_TURN_CHECK_BACK);
    const f = cond(BehaviorTraitKey.PROBE_AFTER_TURN_CHECK_BACK, rate);
    nodeAdjustment *= f;
    stageConds.push({ stage: 'NODE', cond: f });
    if (wantTrace) trace.push({
      stage: 'NODE',
      factor: f,
      trait: BehaviorTraitKey.PROBE_AFTER_TURN_CHECK_BACK,
      rate,
      noteZh:
        `前序线 TURN_CHECK_BACK ⇒ 我让牌后他开火倾向 ${rate.toFixed(3)}` +
        `（池先验 ${ENVIRONMENT_BEHAVIOR_PRIOR.probeAfterTurnCheckBack}）⇒ ×${f.toFixed(4)}`,
    });
  } else {
    if (wantTrace) trace.push({
      stage: 'NODE',
      factor: 1,
      noteZh: bluffClass
        ? `前序线 ${input.node.previousStreetLine} ⇒ 不施加开火条目 ⇒ ×1.0000`
        : `${input.semanticClass} 不接受节点条件化（只有诈唬类接受）⇒ ×1.0000`,
    });
  }

  /* ---- 段 4：类别专属的画像条件化（中性画像 ⇒ 1.0）---- */
  let profileAdjustment = 1;
  if (VALUE_CLASSES.includes(input.semanticClass)) {
    if (wantTrace) trace.push({
      stage: 'PROFILE',
      factor: 1,
      noteZh: `${input.semanticClass} 是价值端 ⇒ 画像**不**调整（价值档曲线本身承载形状）⇒ ×1.0000`,
    });
  } else if (input.semanticClass === 'SHOWDOWN_VALUE') {
    if (wantTrace) trace.push({
      stage: 'PROFILE',
      factor: 1,
      noteZh: 'SHOWDOWN_VALUE（含证据不足的 UNCERTAIN）⇒ 画像不动看不懂的组合 ⇒ ×1.0000',
    });
  } else if (input.semanticClass === 'THIN_VALUE') {
    const rate = poolRateOf(BehaviorTraitKey.THIN_VALUE_BET);
    const f = cond(BehaviorTraitKey.THIN_VALUE_BET, rate);
    profileAdjustment *= f;
    contributions.push({
      trait: BehaviorTraitKey.THIN_VALUE_BET,
      effectiveRate: rate,
      multiplier: f,
      noteZh: `薄价值倾向 ${rate.toFixed(3)} ⇒ 几率比 ×${f.toFixed(4)}`,
    });
    if (wantTrace) trace.push({
      stage: 'PROFILE',
      factor: f,
      trait: BehaviorTraitKey.THIN_VALUE_BET,
      rate,
      noteZh: `THIN_VALUE × 薄价值条目 ${rate.toFixed(3)}（池先验 ${ENVIRONMENT_BEHAVIOR_PRIOR.thinValueBet}）⇒ ×${f.toFixed(4)}`,
    });
  } else if (MISSED_DRAW_CLASSES.includes(input.semanticClass)) {
    const rate = poolRateOf(BehaviorTraitKey.MISSED_DRAW_BLUFF);
    const f = cond(BehaviorTraitKey.MISSED_DRAW_BLUFF, rate);
    profileAdjustment *= f;
    contributions.push({
      trait: BehaviorTraitKey.MISSED_DRAW_BLUFF,
      effectiveRate: rate,
      multiplier: f,
      noteZh: `错过听牌转诈唬 ${rate.toFixed(3)} ⇒ 几率比 ×${f.toFixed(4)}`,
    });
    if (wantTrace) trace.push({
      stage: 'PROFILE',
      factor: f,
      trait: BehaviorTraitKey.MISSED_DRAW_BLUFF,
      rate,
      noteZh:
        `${input.semanticClass} × 错过听牌转诈唬 ${rate.toFixed(3)}` +
        `（池先验 ${ENVIRONMENT_BEHAVIOR_PRIOR.missedDrawBluff}）⇒ ×${f.toFixed(4)}` +
        `（错过听牌的基础频率是**类别**结构项，不随画像变 ⇒ 移到中性校准层）`,
    });
  } else {
    const rate = poolRateOf(BehaviorTraitKey.RIVER_BLUFF);
    const f = cond(BehaviorTraitKey.RIVER_BLUFF, rate);
    profileAdjustment *= f;
    contributions.push({
      trait: BehaviorTraitKey.RIVER_BLUFF,
      effectiveRate: rate,
      multiplier: f,
      noteZh: `纯空气诈唬 ${rate.toFixed(3)} ⇒ 几率比 ×${f.toFixed(4)}`,
    });
    if (wantTrace) trace.push({
      stage: 'PROFILE',
      factor: f,
      trait: BehaviorTraitKey.RIVER_BLUFF,
      rate,
      noteZh: `PURE_AIR × 河牌诈唬 ${rate.toFixed(3)}（池先验 ${ENVIRONMENT_BEHAVIOR_PRIOR.riverBluff}）⇒ ×${f.toFixed(4)}`,
    });
  }

  /*
   * 🔴 **组合方式是几何平均，不是乘积**（V2 · 实测纠正）。
   *
   * 尺寸 / 节点 / 类别三段施加的条目**不是相互独立的证据** ——
   * `missedDrawBluff`、`riverLargeBetBluff`、`probeAfterTurnCheckBack`
   * 表达的是**同一个潜在倾向**（「这个人爱开火」）。把三个似然比**相乘**
   * 等于把同一条倾向**数了三次**。实测后果（03A→03B）：
   *
   * ```text
   * 错过听牌 × 三条目（乘积） 0.0594 → 24.7816   放大 417×
   * 基准 ≈0.055 ⇒ 0.055 × 24.78 = 1.36 ⇒ **被钳到 1.0**
   * ```
   *
   * 即：对 03B 而言「错过听牌」与**坚果**一样可能开火，且
   * `MISSED_DRAW` 与 `PURE_AIR` 会被一起压平到 1.0 ——
   * 恰好摧毁 V2 要建立的**类别区分**。故改为：
   *
   * ```text
   * combinedAdjustment = ( Π 所有已施加的 cond ) ^ (1/n)      n = 已施加条目数
   * ```
   *
   * 性质（结构性，不是调出来的）：
   * - **中性恒等**：每个 `cond` 恰为 `1.0` ⇒ `1^(1/n) = 1` ⇒ NEUTRAL_PARITY 由构造保证；
   * - **不重复计票**：n 条相关条目只贡献一个「平均」倍率；
   * - **不饱和**：实测 `417^(1/3) ≈ 7.5×`（而非 417×），
   *   `0.055 × 7.5 ≈ 0.41` ≪ 坚果 ≈0.95 ⇒ 序关系正确且远离钳位。
   *
   * ⚠️ **`sizeAdjustment` / `nodeAdjustment` / `profileAdjustment` 是各段的
   * 原始乘积，仅供审计；它们不是可以再相乘回去的独立因子。**
   * 真正参与计算的是 `combinedAdjustment`。
   */
  const profileConds = contributions.map((c) => c.multiplier);
  const allConds = [...stageConds.map((s) => s.cond), ...profileConds];
  const appliedTraitCount = allConds.length;
  const product = allConds.reduce((acc, x) => acc * x, 1);
  /*
   * 🔴 **分母是「结构槽位数」，不是「已施加条目数」**（实测纠正）。
   *
   * 用**已施加条目数**做分母会破坏 §三十八 的方向语义。实测（MANIAC ·
   * 错过听牌 · LARGE）：
   *
   * ```text
   * 我让牌后他开火（3 条）  0.348 × 3.667 × 2.333 = 24.78 ⇒ 24.78^(1/3) = 2.915
   * 他跟注后他 donk（2 条） 0.348 × 3.667          = 10.62 ⇒ 10.62^(1/2) = 3.259
   * ⇒ 3.259 > 2.915：**「让牌后开火」的似然反而更低**，与 §三十八 相反
   * ```
   *
   * 原因是「开火」这个因子（2.333）**低于另外两条的几何平均**，
   * 把它计入分母等于给「多施加一条」这件事附带了惩罚。
   *
   * 现在分母 = 该（类别, 尺寸）下的**结构槽位数**，与画像、与前序线**无关**：
   *
   * ```text
   * K = 1（节点槽） + (诈唬类 ? 1 : 0)（尺寸槽） + (可条件化 ? 1 : 0)（类别槽）
   * ```
   *
   * ⇒ 「多施加一个 >1 的因子必然抬高调整值」这条**单调性恢复**，
   * 同时仍是非复合的（把乘积开 K 次方），且中性画像下 `1^(1/K) = 1`：
   *
   * ```text
   * 让牌后开火 24.78^(1/3) = 2.915  >  跟注后 donk 10.62^(1/3) = 2.198   ✓ 方向正确
   * 03A→03B 放大 2.915 / 0.390 ≈ 7.5×（V1 有界线性式只有 4.08×）
   * 0.055 × 2.915 ≈ 0.160 ≪ 坚果 0.95  ⇒ **远离钳位**，类别区分保住
   * ```
   */
  const sizeSlot = bluffClass ? 1 : 0;
  const slotCount = Math.max(1, 1 + sizeSlot + (bluffClass || thinClass ? 1 : 0));
  const combinedAdjustment = appliedTraitCount === 0 ? 1 : Math.pow(product, 1 / slotCount);

  const rawLikelihood = baseLikelihood * combinedAdjustment;
  const likelihood = Math.max(0, Math.min(1, rawLikelihood));
  /** 钳位是否**真的**起作用 —— 若为 `true`，说明类别区分已被压平，
   *  父代理要求它**显式可见**而不是被静默吸收。 */
  const clamped = likelihood !== rawLikelihood;

  return Object.freeze({
    likelihood,
    rawLikelihood,
    clamped,
    baseLikelihood,
    combinedAdjustment,
    appliedTraitCount,
    sizeAdjustment,
    nodeAdjustment,
    profileAdjustment,
    contributions: Object.freeze(contributions),
    trace: Object.freeze(trace),
    /*
     * `noteZh` 同样只在要审计时才拼 —— 它含中文与多次 `toFixed`，
     * 在 Θ(449) 的逐 combo 调用里是实打实的分配开销（热路径预算）。
     */
    noteZh: wantTrace
      ? `${input.action} ${input.semanticClass} @ ${input.node.street}/${input.node.sizeBucket}/` +
        `${input.node.previousStreetLine}：` +
        `基准 ${baseLikelihood.toFixed(6)} × 几何平均调整 ${combinedAdjustment.toFixed(4)}` +
        `（${appliedTraitCount} 条：尺寸 ${sizeAdjustment.toFixed(4)} / 节点 ${nodeAdjustment.toFixed(4)}` +
        ` / 类别 ${profileAdjustment.toFixed(4)}）= ${rawLikelihood.toFixed(6)}` +
        (clamped ? `（**已钳到 ${likelihood.toFixed(6)}**）` : '') +
        (contributions.length === 0
          ? '（无画像调整）'
          : `（${contributions.map((c) => `${c.trait}×${c.multiplier.toFixed(2)}`).join('｜')}）`)
      : `${input.semanticClass}@${input.node.sizeBucket}=${likelihood.toFixed(6)}${clamped ? '（钳位）' : ''}`,
  });
}

/* `relMultiplier`（旧的有界线性条件化）已随 `betLikelihoodOf` 一并删除。 */

export type BetLikelihood = {
  /** 相对似然权重（≥0；**不是**概率，也不是最终权重） */
  likelihood: number;
  /** 参与运算的行为条目与它们的生效值（可审计，§四十三） */
  contributions: readonly { trait: BehaviorTraitKey; effectiveRate: number; multiplier: number; noteZh: string }[];
  noteZh: string;
};

/**
 * 河牌下注的**相对似然**（§九/§十一/§十二）。
 *
 * 结构性基线（与画像无关）：
 * ```
 * 坚果价值 → 1.00｜强价值 → 0.48｜中等价值 → 0.40｜薄价值 → 0.23
 * 摊牌价值   → 0.25（**一对常常直接摊牌**这一条是结构性的，不是靠标签）
 * 错过听牌   → 0.30/0.35（基础诈唬频率）｜纯空气 → 0.20
 * ```
 * 画像只通过**动作条目**调整（绝不直接改权益/EV/动作）：
 * ```
 * 错过听牌 × (0.5 + missedDrawBluff)              ，尺寸为 LARGE/OVERBET 时改用 riverLargeBetBluff
 * 纯空气   × (0.5 + riverBluff)                   ，尺寸为 LARGE/OVERBET 时再乘 (0.5 + riverLargeBetBluff)
 * 薄价值   × (0.5 + thinValueBet)
 * 前序为 TURN_CHECK_BACK ⇒ 全部 × (0.5 + probeAfterTurnCheckBack)（§三十八 line-specific）
 * ```
 * ⚠️ `callTooWide`（被动条目）**不参与**本函数 —— 它只出现在「面对下注」的响应模型里（§七/§三十五）。
 *
 * ## 🔴 价值档为什么是**陡**的（而不是等权）
 *
 * 一个**似然**只有在被 `prior × likelihood` 乘进范围之后才有意义，
 * 因此它的形状必须与「范围原有的档位形状」相配。修复前的价值档是
 * `1.00 / 1.00 / 0.85`（坚果与强价值**等权**），实测后果是
 * 「强价值」的质量相对翻倍 —— 而在河牌上「强价值」正是
 * **能打败 Hero 的那些牌**，于是 Hero 权益被系统性压低：
 *
 * ```text
 * 9-max CO A♣J♥｜河牌 A♦8♠4♠2♣K♦｜BB 下注 70% 池
 *   旧档位似然路径（无画像）          权益 56.26%
 *   修复前的新模型（价值档等权）      权益 47.05%（NORMAL）
 * ⇒ 一次「换模型」被误读成「画像的影响」，也把 03A/03B 的方向压反
 * ```
 *
 * 现在价值档沿用**既有档位曲线的形状**（该曲线是经过校准的，
 * 见 `likelihoodModel.ts` 的 `ABNORMAL_WEIGHTS` 配上下注量放大器：
 * 其归一化形状约为 `1.00 / 0.48 / 0.23`）：坚果明显主导，
 * 强价值次之，薄价值再次之。这是**结构性**修正（恢复既有形状），
 * 不是把某个常数调到符号翻转为止（§二十二 / §四十八）。
 *
 * ## 🔴 **V2：旧的有界线性条件化已整段删除**
 *
 * 这里原先是 `betLikelihoodOf(comboClass, node, profile)` —— 用
 * `(0.5+rate)/(0.5+envPrior)` 这种**有界线性**式乘在一个**独立于档位的**
 * 类别基准上（1.00 / 0.48 / 0.40 / 0.23 / 0.25 / 0.30 / 0.35 / 0.20）。
 *
 * 它有两个致命问题，都已被实测钉死：
 *
 * 1. **动态范围太窄**（≈1.75×）⇒ `PROFILE_RANGE_INFLUENCE = TRIVIAL`
 *    （权益仅动 0.79pp）。这是 V1 的核心遗留问题。
 * 2. **它是第二把尺子**：那些类别基准与「既有档位曲线」不是同一个划分，
 *    一旦某个原型走它、另一个走档位路径，两者的权益就**不可比**
 *    （实测 `VERY_TIGHT 31.962%` vs `NORMAL 17.495%`）。
 *
 * 现在只有一个似然实现：`estimateUnifiedActionLikelihood` ——
 * 中性校准层**就是**既有档位权重，画像只施加几率比条件化，
 * 多条目按**几何平均**合并。**不再保留任何并行的旧实现**，
 * 以免将来又出现「两个模型各说各话」（V1 阶段为此误判过两次）。
 */

/* ============================================================
 * ⑤ Combo Reweighting（§十三）：posterior ∝ prior × likelihood
 * ============================================================ */

export type ReweightedCombo<T> = { combo: T; priorWeight: number; posteriorWeight: number };

export function reweightCombos<T>(input: {
  combos: readonly {
    combo: T;
    priorWeight: number;
    comboClass: RiverComboClass;
    /** 该 combo 的**既有档位**（来自 `riverComboClassOf().strengthBucket`） */
    strengthBucket: number;
  }[];
  node: BehaviorNodeContext;
  profile: PlayerBehaviorProfile;
  betRatio?: number;
}): {
  combos: readonly ReweightedCombo<T>[];
  totalPosteriorMass: number;
  likelihoods: readonly UnifiedActionLikelihood[];
} {
  const likelihoods: UnifiedActionLikelihood[] = [];
  const raw = input.combos.map((entry) => {
    const like = estimateUnifiedActionLikelihood({
      semanticClass: entry.comboClass,
      strengthBucket: entry.strengthBucket,
      ...(input.betRatio === undefined ? {} : { betRatio: input.betRatio }),
      node: input.node,
      profile: input.profile,
      action: 'BET',
    });
    likelihoods.push(like);
    return { combo: entry.combo, priorWeight: entry.priorWeight, raw: entry.priorWeight * like.likelihood };
  });
  const total = raw.reduce((acc, x) => acc + x.raw, 0) || 1;
  return {
    combos: Object.freeze(
      raw.map((x) =>
        Object.freeze({ combo: x.combo, priorWeight: x.priorWeight, posteriorWeight: x.raw / total }),
      ),
    ),
    totalPosteriorMass: 1,
    likelihoods: Object.freeze(likelihoods) as readonly UnifiedActionLikelihood[],
  };
}

/* ============================================================
 * ⑥ Materiality（§二十一）：两个极端画像对范围/权益的影响有多大
 * ============================================================ */

export const ProfileMateriality = {
  NO_EFFECT: 'NO_EFFECT',
  TRIVIAL: 'TRIVIAL',
  MATERIAL: 'MATERIAL',
  STRONG: 'STRONG',
} as const;
export type ProfileMateriality = (typeof ProfileMateriality)[keyof typeof ProfileMateriality];

/** 实验性阈值（**不是**永久契约；V1 先放这里，报告里标 EXPERIMENTAL） */
export const MATERIALITY_THRESHOLDS = Object.freeze({
  equityTrivial: 0.005,
  equityMaterial: 0.02,
  equityStrong: 0.05,
  massTrivial: 0.01,
  massMaterial: 0.05,
});

export function profileMaterialityOf(input: {
  equityA: number | null;
  equityB: number | null;
  bluffMassA: number;
  bluffMassB: number;
  evA: number | null;
  evB: number | null;
  rangeDistance: number;
}): {
  verdict: ProfileMateriality;
  equityDelta: number | null;
  bluffMassDelta: number;
  evDelta: number | null;
  rangeDistance: number;
  noteZh: string;
} {
  /*
   * 🔴 **非有限输入必须被判成「无法判定」而不是悄悄落到某个档位**
   *（V2.1 数值审查 C3 实测）：
   *
   * ```text
   * equityB = NaN      ⇒ equityDelta = NaN ⇒ 四个比较全 false ⇒ 落到 **TRIVIAL**
   * equityB = Infinity ⇒ **STRONG**，且 noteZh 打印「权益差 Infinitypp」
   * bluffMassB = NaN   ⇒ 质量维度被静默忽略，判定只看权益
   * ```
   *
   * 也就是说：**一个坏数字会被展示成一个正常档位**。这里改成显式的
   * `NO_EFFECT` + 说明 —— 「算不出来」与「影响很小」是两件不同的事。
   */
  const badInput =
    !Number.isFinite(input.bluffMassA) || !Number.isFinite(input.bluffMassB)
    || (input.equityA !== null && !Number.isFinite(input.equityA))
    || (input.equityB !== null && !Number.isFinite(input.equityB))
    || !Number.isFinite(input.rangeDistance);
  if (badInput) {
    return {
      verdict: ProfileMateriality.NO_EFFECT,
      equityDelta: null,
      bluffMassDelta: 0,
      evDelta: null,
      rangeDistance: Number.isFinite(input.rangeDistance) ? input.rangeDistance : 0,
      noteZh:
        '画像物性 NO_EFFECT：输入含**非有限数值**（NaN / Infinity）⇒ **无法判定**。' +
        '这不是「影响很小」—— 「算不出来」与「影响很小」必须分开。',
    };
  }

  const equityDelta =
    input.equityA === null || input.equityB === null ? null : input.equityB - input.equityA;
  const evDelta = input.evA === null || input.evB === null ? null : input.evB - input.evA;
  const bluffMassDelta = input.bluffMassB - input.bluffMassA;
  const verdict: ProfileMateriality =
    equityDelta === null
      ? ProfileMateriality.NO_EFFECT
      : Math.abs(equityDelta) < MATERIALITY_THRESHOLDS.equityTrivial &&
          Math.abs(bluffMassDelta) < MATERIALITY_THRESHOLDS.massTrivial
        ? ProfileMateriality.TRIVIAL
        : Math.abs(equityDelta) >= MATERIALITY_THRESHOLDS.equityStrong
          ? ProfileMateriality.STRONG
          : Math.abs(equityDelta) >= MATERIALITY_THRESHOLDS.equityMaterial ||
              Math.abs(bluffMassDelta) >= MATERIALITY_THRESHOLDS.massMaterial
            ? ProfileMateriality.MATERIAL
            : ProfileMateriality.TRIVIAL;
  return {
    verdict,
    equityDelta,
    bluffMassDelta,
    evDelta,
    rangeDistance: input.rangeDistance,
    noteZh:
      `画像物性 ${verdict}（EXPERIMENTAL 阈值）：权益差 ${equityDelta === null ? '—' : (equityDelta * 100).toFixed(2) + 'pp'}` +
      `｜诈唬质量差 ${(bluffMassDelta * 100).toFixed(2)}pp｜EV 差 ${evDelta === null ? '—' : evDelta.toFixed(2)} 筹码` +
      `｜范围距离 ${input.rangeDistance.toFixed(4)}`,
  };
}
