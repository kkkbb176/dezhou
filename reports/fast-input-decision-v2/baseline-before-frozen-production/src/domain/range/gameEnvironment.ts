/**
 * 牌局环境（GameEnvironment）—— 三种模式
 *
 * ## ⚠️ 当前状态：**方向由知识层决定，本文件的数值是待校准的遗留占位**
 *
 * 自 Phase 4.5 起，本项目对环境模式的纪律收紧为：
 *
 * > **只允许方向型规则，不允许固定百分比。**
 >
 * 原因：没有任何可引用的分级别统计数据（Phase 4.5 审计的四个项目都不提供），
 * 因此任何具体倍数都是**假精确**。
 *
 * ### 权威来源
 *
 * 环境该往哪个方向调，由**知识层**决定：
 * `data/knowledge/strategy-rules.json` 中 `gameEnvironment` 字段指向本模块的规则，
 * 全部 `evidenceLevel: HEURISTIC` 且 **`magnitude` 缺省**（有硬校验保证）。
 *
 * ### 本文件里的数字是什么
 *
 * `adjustment` 里的倍数是**Phase 4.5 之前的遗留实现**，保留它们的原因有两条：
 * 1. **向后兼容**：既有测试与调用方仍可使用，不制造无谓的破坏性变更；
 * 2. **等待校准**：它们将被真实牌局数据逐步替换，而不是被重新编造一遍。
 *
 * 但必须明确：**它们没有任何数据支撑**，`confidence` 刻意压低到 0.3–0.4，
 * 且 `THEORY_REFERENCE` 的中文描述里写明「本项目没有求解器输出，不得称为 GTO 最优」。
 *
 * → 新增环境行为时，**先在知识层加一条方向型规则**，
 *   而不是在这里再调一个数字。
 *
 * ## 绝对不可越界的地方（硬约束）
 *
 * 环境**只允许**改变：
 * - Range 先验的宽窄与形状
 * - 动作似然的相对权重
 * - 各类决策阈值（例如价值下注门槛、抓诈唬门槛）
 *
 * 环境**绝对不允许**改变：
 * - 牌力大小（Hand Rank）
 * - 底池、筹码、SPR
 * - 底池赔率、所需权益、权益计算公式
 *
 * 这不是「注意一下」，而是**结构上做不到**：本模块不导入任何
 * 牌力评估 / 赔率 / 权益模块。测试会用模块导出断言锁定这一点。
 */

import { RangeSource, type RangeProvenance } from './range.types.ts';

/* ============================================================
 * 模式与调整维度
 * ============================================================ */

export const GameEnvironment = {
  /** 低级别线上：跟注多、诈唬少、位置意识弱 */
  LOW_STAKES_ONLINE: 'LOW_STAKES_ONLINE',
  /** 中低级别（默认）：介于两者之间，最接近本项目的启发式先验 */
  MID_LOW_STAKES: 'MID_LOW_STAKES',
  /** 理论参考：不受真人偏差影响，只关心数学上应该怎么打 */
  THEORY_REFERENCE: 'THEORY_REFERENCE',
} as const;
export type GameEnvironment = (typeof GameEnvironment)[keyof typeof GameEnvironment];

export const ALL_GAME_ENVIRONMENTS: readonly GameEnvironment[] = [
  GameEnvironment.LOW_STAKES_ONLINE,
  GameEnvironment.MID_LOW_STAKES,
  GameEnvironment.THEORY_REFERENCE,
];

export const DEFAULT_GAME_ENVIRONMENT: GameEnvironment = GameEnvironment.MID_LOW_STAKES;

/**
 * 环境带来的**相对**概率调整因子（乘性，1 = 不调整）。
 *
 * ## 🔴 `deprecated / legacy-only`
 *
 * 自 Phase 4.5 起，本项目的纪律是：
 *
 * > **环境模式只允许方向型调整，不允许固定百分比。**
 >
 * 原因：**没有任何可引用的分级别统计数据**（Phase 4.5 审计了 4 个 GitHub 项目与 6 本书，
 * 没有一个能提供）。因此这些具体倍数是**假精确**。
 *
 * ### 三条使用限制
 *
 * 1. **禁止新的生产 Decision 路径依赖本结构的具体数值。**
 *    新增环境行为必须先在 `data/knowledge/strategy-rules.json` 加一条**方向型规则**
 *    （`magnitude` 缺省，有硬校验保证），而不是在这里再调一个数字。
 * 2. 保留这些数值的**唯一原因**是向后兼容既有测试与调用方，
 *    并等待真实牌局数据校准后替换 —— 而不是被重新编造一遍。
 * 3. 环境该往哪个方向调，**权威来源是知识层**（`env.*` 规则），不是本文件。
 *
 * 未来若要恢复幅度，必须满足 `docs/KNOWLEDGE_POLICY.md` §3.2 的**四条准入条件**。
 *
 * ## 字段语义
 *
 * 全部是「相对倍数」而不是绝对百分比频率：绝对频率需要真实数据支撑，
 * 倍数只需要「比基准更宽/更窄」这种定性判断。
 */
export type EnvironmentAdjustment = {
  /** 对手范围整体宽窄（>1 更宽） */
  rangeWidth: number;
  /** 对手诈唬在激进动作中的占比（>1 更多诈唬） */
  bluffShare: number;
  /** 对手价值下注门槛（>1 更容易用中等牌下注价值） */
  valueThreshold: number;
  /** 对手整体攻击性（>1 更凶） */
  aggression: number;
  /** 河牌特有的偏差（>1 河牌更激进） */
  riverAdjustment: number;
  /** 多人池额外偏差（>1 人越多越放宽） */
  multiwayAdjustment: number;
  /**
   * 范围**弱牌端**的倾斜强度倍数。
   *
   * 为什么必须有这一项：范围因子集合会被**几何均值归一**，
   * 而单纯缩放整体 `rangeWidth` 在归一化后会被抵消一部分 ——
   * 实测只靠 `rangeWidth` 时，环境对弱牌端的净影响被压缩到几乎为零。
   * 本项直接作用于「弱牌端相对强牌端抬高多少」，
   * 因此是环境真正能被观测到的那条通道。
   */
  weakEndTilt: number;
  /**
   * 范围**强牌端**的倾斜强度倍数。
   * 与 `weakEndTilt` 配对：两者一起决定范围的**强度梯度**（陡峭程度）。
   */
  strongEndTilt: number;
};

/**
 * 一个牌局环境的完整、可版本化的配置。
 *
 * **不得**把环境判断写成散落的 if/else —— 一切差异必须表达为本结构。
 *
 * ⚠️ `adjustment` 字段已标 **`deprecated / legacy-only`**（见 `EnvironmentAdjustment` 文档）。
 */
export type GameEnvironmentProfile = {
  environment: GameEnvironment;
  /** 中文显示名 */
  label: string;
  /** 配置版本；数值变化必须升版本（缓存与复盘依赖它） */
  version: string;
  /** 中文说明：这个环境假设对手大致怎么打 */
  description: string;
  /**
   * 🔴 **`deprecated / legacy-only`** —— 相对倍数调整。
   *
   * 环境的方向由知识层 `data/knowledge/strategy-rules.json` 的 `env.*` 规则决定。
   * 本字段禁止被新的生产 Decision 路径依赖。
   */
  adjustment: EnvironmentAdjustment;
  provenance: RangeProvenance;
  /** 该配置的可信度（0..1；启发式配置刻意压低） */
  confidence: number;
};

/* ============================================================
 * 三个 profile
 * ============================================================ */

/**
 * 相对倍数的工程护栏。
 *
 * 上限取 ±25%：这些都是**启发式**判断，超过这个幅度就该质疑
 * 「我们凭什么这么确定」。护栏是硬约束，配置写超了会被拒绝而不是夹住 ——
 * 静默夹住会让配置作者以为自己写的生效了。
 *
 * 注：`rangeWidth` 在多人池下会乘以人数因子，因此**最终**有效值可能超过
 * 该护栏。护栏约束的是**配置本身**，不是运行时派生值。
 */
export const MAX_ENVIRONMENT_ADJUSTMENT = 0.25;

/** 多人池因子的工程上限（防止 9 人桌把范围无限放宽） */
export const MAX_MULTIWAY_FACTOR = 1.6;

function provenanceOf(environment: GameEnvironment, description: string): RangeProvenance {
  return {
    sourceId: `environment.${environment.toLowerCase()}.v1`,
    sourceType: RangeSource.HEURISTIC,
    version: '1.0.0',
    description,
    verified: false,
    // 启发式环境配置刻意给低可信度：它描述的是「人群大致倾向」，不是精确频率
    confidence: 0.35,
  };
}

const PROFILES: Readonly<Record<GameEnvironment, GameEnvironmentProfile>> = Object.freeze({
  [GameEnvironment.LOW_STAKES_ONLINE]: Object.freeze({
    environment: GameEnvironment.LOW_STAKES_ONLINE,
    label: '低级别线上',
    version: '1.0.0',
    description:
      '假设对手整体偏松偏被动：跟注多、主动诈唬少、位置意识较弱、河牌大注更容易是真牌。',
    adjustment: Object.freeze({
      rangeWidth: 1.2,
      // 0.8 已经触及 ±25% 护栏的下沿：再低就等于声称「低级别几乎没有诈唬」，
      // 而那是需要真实数据才能下的结论，本项目没有。宁可保守。
      bluffShare: 0.8,
      valueThreshold: 0.88,
      aggression: 0.85,
      riverAdjustment: 0.9,
      multiwayAdjustment: 1.12,
      // 低级别：弱牌端明显抬高（他们真的什么牌都玩），强牌端几乎不变
      weakEndTilt: 1.25,
      strongEndTilt: 0.95,
    }),
    provenance: provenanceOf(
      GameEnvironment.LOW_STAKES_ONLINE,
      '依据公开的扑克常识构造的相对调整（无分级别统计数据支撑）',
    ),
    confidence: 0.35,
  }),

  [GameEnvironment.MID_LOW_STAKES]: Object.freeze({
    environment: GameEnvironment.MID_LOW_STAKES,
    label: '中低级别',
    version: '1.0.0',
    description: '默认环境。假设对手接近本项目启发式先验所描述的中等常客：不极端松，也不极端凶。',
    adjustment: Object.freeze({
      rangeWidth: 1,
      bluffShare: 1,
      valueThreshold: 1,
      aggression: 1,
      riverAdjustment: 1,
      multiwayAdjustment: 1,
      weakEndTilt: 1,
      strongEndTilt: 1,
    }),
    provenance: provenanceOf(
      GameEnvironment.MID_LOW_STAKES,
      '基准环境：所有调整因子为 1，等价于不做任何环境修正',
    ),
    confidence: 0.4,
  }),

  [GameEnvironment.THEORY_REFERENCE]: Object.freeze({
    environment: GameEnvironment.THEORY_REFERENCE,
    label: '理论参考',
    version: '1.0.0',
    description:
      '不受真人偏差影响的参考视角：对手被视为理性且平衡。⚠️ 本项目**没有求解器输出**，因此这里的「理论」是**结构性假设**（平衡、无系统性漏洞），不是求解器输出，不得在界面上称为 GTO 最优。',
    adjustment: Object.freeze({
      rangeWidth: 0.92,
      bluffShare: 1.15,
      valueThreshold: 1.08,
      aggression: 1.12,
      riverAdjustment: 1.05,
      multiwayAdjustment: 1,
      // 理性对手：弱牌端收窄（他们不会用垃圾牌进池），强牌端相对更集中
      weakEndTilt: 0.8,
      strongEndTilt: 1.05,
    }),
    provenance: provenanceOf(
      GameEnvironment.THEORY_REFERENCE,
      '结构性平衡假设（非求解器输出，不得称为 GTO）',
    ),
    confidence: 0.3,
  }),
});

/* ============================================================
 * 查询与校验
 * ============================================================ */

export function isGameEnvironment(value: unknown): value is GameEnvironment {
  return typeof value === 'string' && (ALL_GAME_ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * 取某个环境的配置。
 *
 * 未登记的环境值**抛错**而不是回退到默认 —— 静默回退会让一个拼错的
 * 环境名悄悄用上错误的假设，而这正是最难发现的一类错误。
 */
export function environmentProfile(environment: GameEnvironment): GameEnvironmentProfile {
  if (!isGameEnvironment(environment)) {
    throw new Error(
      `environmentProfile: 未登记的牌局环境「${String(environment)}」。` +
        `已登记：${ALL_GAME_ENVIRONMENTS.join(' / ')}`,
    );
  }
  return PROFILES[environment];
}

/** 默认环境配置 */
export function defaultEnvironmentProfile(): GameEnvironmentProfile {
  return PROFILES[DEFAULT_GAME_ENVIRONMENT];
}

export type EnvironmentIssue = {
  code: 'UNKNOWN_ENVIRONMENT' | 'ADJUSTMENT_OUT_OF_BOUNDS' | 'NON_POSITIVE_ADJUSTMENT' | 'MISSING_VERSION';
  params: Readonly<Record<string, string | number>>;
};

/**
 * 校验一个环境配置是否合法。
 *
 * 收集**全部**问题而不是遇到第一个就停，便于一次改完。
 */
export function validateEnvironmentProfile(profile: GameEnvironmentProfile): EnvironmentIssue[] {
  const issues: EnvironmentIssue[] = [];

  if (!isGameEnvironment(profile.environment)) {
    issues.push({ code: 'UNKNOWN_ENVIRONMENT', params: { environment: String(profile.environment) } });
  }
  if (!profile.version || profile.version.trim().length === 0) {
    issues.push({ code: 'MISSING_VERSION', params: { environment: profile.environment } });
  }

  const bound = 1 + MAX_ENVIRONMENT_ADJUSTMENT;
  for (const [key, value] of Object.entries(profile.adjustment)) {
    if (!Number.isFinite(value) || value <= 0) {
      issues.push({
        code: 'NON_POSITIVE_ADJUSTMENT',
        params: { environment: profile.environment, field: key, value: String(value) },
      });
      continue;
    }
    if (value > bound || value < 1 / bound) {
      issues.push({
        code: 'ADJUSTMENT_OUT_OF_BOUNDS',
        params: {
          environment: profile.environment,
          field: key,
          value,
          min: Number((1 / bound).toFixed(4)),
          max: Number(bound.toFixed(4)),
        },
      });
    }
  }

  return issues;
}

/** 断言配置合法（构建期即失败，绝不带着坏配置跑） */
export function assertValidEnvironmentProfile(profile: GameEnvironmentProfile): void {
  const issues = validateEnvironmentProfile(profile);
  if (issues.length > 0) {
    const detail = issues.map((i) => `${i.code} ${JSON.stringify(i.params)}`).join('；');
    throw new Error(`assertValidEnvironmentProfile: 环境配置「${profile.environment}」不合法：${detail}`);
  }
}

/* ============================================================
 * 组合：环境 × 多人池
 * ============================================================ */

/**
 * 加上人数维度的**有效**调整。
 *
 * 人数越多，对手整体范围越宽（更多人意味着有人拿到好牌的概率更高，
 * 但**单个**对手的平均牌力反而更低）。方向容易写反，因此单独抽成函数并有测试锁定。
 *
 * ## 为什么用线性而不是幂
 *
 * 幂形式 `factor^(players-2)` 会爆炸：`1.12^7 ≈ 2.21`，
 * 9 人桌的对手范围会被放宽到基准的 2.2 倍 —— 这不是「微调」，
 * 而是把启发式猜测量级放大成了结论。因此改用线性累加并夹到
 * `MAX_MULTIWAY_FACTOR`，使环境修正始终停留在「微调」的量级。
 *
 * @param activePlayerCount 场上活跃人数（含自己），最小 2
 */
export function effectiveAdjustment(
  profile: GameEnvironmentProfile,
  activePlayerCount: number,
): EnvironmentAdjustment {
  const players = Number.isFinite(activePlayerCount) ? Math.max(2, Math.floor(activePlayerCount)) : 2;
  const extraPlayers = Math.min(players - 2, 8);
  const rawMultiway = 1 + (profile.adjustment.multiwayAdjustment - 1) * extraPlayers;
  const multiway = Math.max(1 / MAX_MULTIWAY_FACTOR, Math.min(MAX_MULTIWAY_FACTOR, rawMultiway));

  const a = profile.adjustment;
  return {
    rangeWidth: a.rangeWidth * multiway,
    bluffShare: a.bluffShare,
    valueThreshold: a.valueThreshold,
    aggression: a.aggression,
    riverAdjustment: a.riverAdjustment,
    multiwayAdjustment: a.multiwayAdjustment,
    // 人越多，单个对手的弱牌端越宽（他更可能是「随便玩一手」的那个人）
    weakEndTilt: Math.min(MAX_MULTIWAY_FACTOR, a.weakEndTilt * multiway),
    strongEndTilt: a.strongEndTilt,
  };
}

/* ============================================================
 * 中文说明（UI 必须能说清「为什么这次不一样」）
 * ============================================================ */

/**
 * 生成「这个环境相对基准改了什么」的中文说明。
 *
 * 只列出**真的不等于 1** 的维度 —— 列出全部会让用户以为六项都在生效。
 */
export function environmentDeltaNote(
  profile: GameEnvironmentProfile,
  effective?: EnvironmentAdjustment,
): string[] {
  const base = PROFILES[GameEnvironment.MID_LOW_STAKES].adjustment;
  const current = effective ?? profile.adjustment;
  const notes: string[] = [];

  const describe = (field: keyof EnvironmentAdjustment, wider: string, narrower: string): void => {
    const value = current[field];
    const baseValue = base[field];
    if (Math.abs(value - baseValue) < 1e-9) return;
    const direction = value > baseValue ? wider : narrower;
    const pct = Math.round(Math.abs(value / baseValue - 1) * 100);
    notes.push(`${direction}约 ${pct}%`);
  };

  describe('rangeWidth', '对手范围更宽', '对手范围更窄');
  describe('bluffShare', '对手诈唬占比更高', '对手诈唬占比更低');
  describe('valueThreshold', '对手价值下注门槛更低', '对手价值下注门槛更高');
  describe('aggression', '对手整体更凶', '对手整体更被动');
  describe('riverAdjustment', '河牌更激进', '河牌更保守');
  describe('multiwayAdjustment', '多人池影响更强', '多人池影响更弱');

  return notes;
}
