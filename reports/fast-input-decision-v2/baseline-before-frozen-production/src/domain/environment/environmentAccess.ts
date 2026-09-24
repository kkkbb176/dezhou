/**
 * Alpha 牌局环境接入（最小版）
 *
 * ## 这个模块在端到端链中解决什么
 *
 * 把**知识层的方向型环境规则**（`data/knowledge/strategy-rules.json` 的 `env.*`）
 * 变成 Decision 层可以消费的**方向建议**。
 *
 * 它是「Environment 最小接入」这一步的全部内容 —— 刻意做得很小。
 *
 * ## 三条纪律（与 Phase 4.5 的裁定一致）
 *
 * ### 1. 只允许方向，绝不允许幅度
 *
 * 知识层当前**没有任何**可推导的量化依据（审计过 4 个 GitHub 项目 + 6 本书，
 * 没有一个提供分级别统计数据；`strategy-rules.json` 里 0 条规则带 `magnitude`）。
 * 因此本模块的输出类型**没有 `magnitude` 字段**，也没有 `multiplier`。
 *
 * 这不是「暂时不写」，而是类型上做不到：`EnvironmentAdvice` 只有
 * `target` / `direction` / `confidence` / `ruleId` / `because`。
 *
 * ### 2. 禁止依赖 legacy 数值
 *
 * `src/domain/range/gameEnvironment.ts` 的 `adjustment` 里有一组倍数值
 * （`weakEndTilt`、`bluffShare` 等），它们在 Phase 4.5 被标为
 * **`deprecated / legacy-only`**。本模块**不导入那个结构**，
 * 因此 Alpha Decision 路径在**结构上**不可能读到它们
 *（有源码扫描测试锁定这一点）。
 *
 * ### 3. 个体玩家数据优先于环境先验
 *
 * `priority.individual-over-environment` 是知识层里 `evidenceLevel: PRIMARY`、
 * `confidence: 0.95` 的规则。本模块把它翻译成一个**可执行的裁决函数**
 * `resolveIndividualOverEnvironment()`：
 * 当某个玩家的**实测**数据可信时，环境先验必须让位。
 *
 * 否则环境会把「所有低级别玩家」同质化 —— 那是被明确禁止的失败模式。
 */

import {
  AdjustmentTarget,
  GameEnvironmentId,
  StrategyStreet,
  type StrategyKnowledge,
} from '../knowledge/knowledge.types.ts';

/* ============================================================
 * 输出类型
 * ============================================================ */

/**
 * Decision 层能识别的调整目标。
 *
 * ⚠️ 与知识层的 `AdjustmentTarget` **不是**同一个枚举：
 * 知识层有 13 个目标（含 `BET_SIZE` / `FOLD_WEIGHT` 等本层不消费的），
 * 这里只保留 6 个能直接映射到「范围宽度 / 四类似然」的目标。
 *
 * 映射关系由 `TARGET_MAP` 显式声明；**未映射的目标会被如实记录为
 * `unmappedTargets`**，而不是静默丢弃 —— 静默丢弃会让
 * 「知识层加了规则但没生效」永远不被发现。
 */
export const EnvironmentAdjustmentTarget = {
  RANGE_WIDTH: 'RANGE_WIDTH',
  BLUFF_LIKELIHOOD: 'BLUFF_LIKELIHOOD',
  VALUE_LIKELIHOOD: 'VALUE_LIKELIHOOD',
  CALL_LIKELIHOOD: 'CALL_LIKELIHOOD',
  FOLD_LIKELIHOOD: 'FOLD_LIKELIHOOD',
  AGGRESSION_LIKELIHOOD: 'AGGRESSION_LIKELIHOOD',
} as const;
export type EnvironmentAdjustmentTarget =
  (typeof EnvironmentAdjustmentTarget)[keyof typeof EnvironmentAdjustmentTarget];

export const EnvironmentAdjustmentDirection = {
  INCREASE: 'INCREASE',
  DECREASE: 'DECREASE',
  /** 本环境下该项**没有系统性偏差** → 不调整 */
  NEUTRAL: 'NEUTRAL',
  /** 方向取决于具体局面（例如「取决于对手是否被动型」）→ **不得单独驱动决策** */
  CONTEXT_DEPENDENT: 'CONTEXT_DEPENDENT',
} as const;
export type EnvironmentAdjustmentDirection =
  (typeof EnvironmentAdjustmentDirection)[keyof typeof EnvironmentAdjustmentDirection];

/**
 * 一条环境建议。
 *
 * 🔴 **没有 `magnitude`，也没有 `multiplier`。**
 * 需要数值的调用方必须自己承担「这是启发式方向，不是已校准幅度」的责任。
 */
export type EnvironmentAdvice = {
  target: EnvironmentAdjustmentTarget;
  direction: EnvironmentAdjustmentDirection;
  /** 该方向的可信度（直接取知识规则的 confidence；多为 0.3） */
  confidence: number;
  /** 来源规则 id（可追溯） */
  ruleId: string;
  /** 中文：为什么（知识规则的 `notes`，界面可直接显示） */
  because: string;
  /**
   * 适用条件说明（知识规则的 `exceptions`）。
   *
   * UI **必须**能看到它 —— 「低级别河牌诈唬少」这类方向
   * 在「对手明显是常客局」时整条失效。
   */
  caveats: readonly string[];
};

/**
 * 环境规则筛选结果。
 *
 * `unmappedTargets` 与 `skippedRules` 都要如实输出：
 * 一个「知识层有 13 条 env 规则、实际只生效 8 条」的系统，
 * 必须能回答**另外 5 条去哪了**。
 */
export type EnvironmentAdviceResult = {
  environment: GameEnvironmentId;
  advice: readonly EnvironmentAdvice[];
  /** 规则存在但目标不在本层消费范围内 */
  unmappedTargets: readonly { ruleId: string; target: string }[];
  /** 因街道不匹配而未被采用的规则 */
  skippedByStreet: readonly { ruleId: string; ruleStreet: string }[];
  /** 本次实际参与筛选的知识层规则总数（用于诊断「规则有没有加载到」） */
  consideredRules: number;
};

/* ============================================================
 * 目标映射
 * ============================================================ */

/**
 * 知识层目标 → Decision 层目标。
 *
 * ## 为什么 `RIVER_POLARIZATION` 映射到 `AGGRESSION_LIKELIHOOD`
 *
 * 极化意味着「两极化下注范围」：强牌与空气都下注，中等牌不下注。
 * 它**不**告诉我们诈唬占比更高（知识层 `env.mid.river-polarization-up`
 * 的 exceptions 明确写了两者不可混淆），因此不能映射到 `BLUFF_LIKELIHOOD`。
 *
 * 能确定的是：**下注这个动作本身更频繁** → `AGGRESSION_LIKELIHOOD`。
 */
const TARGET_MAP: Readonly<Record<string, EnvironmentAdjustmentTarget>> = Object.freeze({
  [AdjustmentTarget.RANGE_WIDTH]: EnvironmentAdjustmentTarget.RANGE_WIDTH,
  [AdjustmentTarget.BLUFF_WEIGHT]: EnvironmentAdjustmentTarget.BLUFF_LIKELIHOOD,
  [AdjustmentTarget.VALUE_WEIGHT]: EnvironmentAdjustmentTarget.VALUE_LIKELIHOOD,
  [AdjustmentTarget.CALL_WEIGHT]: EnvironmentAdjustmentTarget.CALL_LIKELIHOOD,
  [AdjustmentTarget.FOLD_WEIGHT]: EnvironmentAdjustmentTarget.FOLD_LIKELIHOOD,
  [AdjustmentTarget.RIVER_POLARIZATION]: EnvironmentAdjustmentTarget.AGGRESSION_LIKELIHOOD,
  [AdjustmentTarget.THIN_VALUE_TENDENCY]: EnvironmentAdjustmentTarget.VALUE_LIKELIHOOD,
  // 以下目标**刻意不映射**（见 UNMAPPED_TARGET_REASONS）：
  // MULTIWAY_VALUE_THRESHOLD / BLUFF_CATCH_VIABILITY / BLOCKER_RELEVANCE /
  // PLAYER_DATA_WEIGHT / PASSIVE_LARGE_AGGRESSION_CREDIBILITY / BET_SIZE
});

/**
 * 未映射目标的**原因**（必须写清，否则读者会以为是漏了）。
 *
 * 这个表同时是文档与断言依据：`ENVIRONMENT_UNMAPPED_TARGETS` 里的每个 target
 * 都必须在这里有理由，测试会锁定这一点。
 */
export const UNMAPPED_TARGET_REASONS: Readonly<Record<string, string>> = Object.freeze({
  [AdjustmentTarget.MULTIWAY_VALUE_THRESHOLD]:
    '多人池的价值门槛：Alpha 第一版**不支持多人池决策**（会明确返回信息不足），因此该方向无处施加',
  [AdjustmentTarget.BLUFF_CATCH_VIABILITY]:
    '抓诈唬可行性：它改变的是「用什么牌跟注」的构成，需要与具体牌力交互；第一版没有该交互层',
  [AdjustmentTarget.BLOCKER_RELEVANCE]:
    '阻断牌权重：知识规则自己写明「阻断牌的**数学效果**永远由组合数学计算」，只是注意力分配；第一版无该层',
  [AdjustmentTarget.PLAYER_DATA_WEIGHT]:
    '个体数据权重：它是**优先级链**的元规则，不是一条行为方向；已由 `resolveIndividualOverEnvironment()` 实现',
  [AdjustmentTarget.PASSIVE_LARGE_AGGRESSION_CREDIBILITY]:
    '被动玩家大额进攻的可信度：需要「该玩家是否被动型」这一前提，属于 Profile × Environment 联合规则；第一版未实现该联合层',
  [AdjustmentTarget.BET_SIZE]:
    '下注尺寸：第一版的尺寸来自既有 `betSizeGrid`（数学模块），环境不得改尺寸',
});

/** 未映射目标清单（供诊断与测试） */
export const ENVIRONMENT_UNMAPPED_TARGETS: readonly string[] = Object.freeze(
  Object.keys(UNMAPPED_TARGET_REASONS),
);

/* ============================================================
 * 筛选
 * ============================================================ */

/** 街道是否适用：规则的街道为 `ANY`，或与当前街道一致 */
function streetApplies(ruleStreet: StrategyStreet, street: StrategyStreet): boolean {
  return ruleStreet === StrategyStreet.ANY || ruleStreet === street;
}

/**
 * 取某个环境在某个街道下的方向建议。
 *
 * ## Fail-Closed 纪律
 *
 * - `rules` 为空数组是**合法输入**（尚未加载知识库）→ 返回空建议，
 *   并在 `consideredRules: 0` 中如实反映。调用方据此把
 *   「环境不提供任何调整」当作正常情形，而不是报错。
 * - 未映射的目标**不静默丢弃** → 记入 `unmappedTargets`。
 * - `NEUTRAL` 方向的规则**不进入 advice**（它表示「无系统偏差」，
 *   把它当建议输出会让调用方以为环境在说话）。但它也不丢失：
 *   计入 `consideredRules`。
 *
 * @param rules 知识层的全部策略规则（由调用方注入，本层零 I/O）
 */
export function environmentAdviceFor(
  environment: GameEnvironmentId,
  street: StrategyStreet,
  rules: readonly StrategyKnowledge[],
): EnvironmentAdviceResult {
  const advice: EnvironmentAdvice[] = [];
  const unmappedTargets: { ruleId: string; target: string }[] = [];
  const skippedByStreet: { ruleId: string; ruleStreet: string }[] = [];
  let considered = 0;

  for (const rule of rules) {
    if (rule.gameEnvironment !== environment) continue;
    considered++;

    if (!streetApplies(rule.street, street)) {
      skippedByStreet.push({ ruleId: rule.ruleId, ruleStreet: rule.street });
      continue;
    }

    const target = TARGET_MAP[rule.target];
    if (target === undefined) {
      unmappedTargets.push({ ruleId: rule.ruleId, target: rule.target });
      continue;
    }

    // NEUTRAL = 「本环境下没有系统性偏差」→ 不是一条建议
    if (rule.adjustment === 'NEUTRAL') continue;

    advice.push({
      target,
      direction: rule.adjustment as EnvironmentAdjustmentDirection,
      confidence: rule.confidence,
      ruleId: rule.ruleId,
      because: rule.notes,
      caveats: Object.freeze([...rule.exceptions]),
    });
  }

  // 稳定排序：确定性输出（同一输入必须逐位一致）
  advice.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));

  return {
    environment,
    advice: Object.freeze(advice),
    unmappedTargets: Object.freeze(unmappedTargets),
    skippedByStreet: Object.freeze(skippedByStreet),
    consideredRules: considered,
  };
}

/* ============================================================
 * 优先级裁决：个体数据 vs 环境先验
 * ============================================================ */

/**
 * 谁赢：个体实测数据，还是环境先验？
 *
 * 对应知识层规则 `priority.individual-over-environment`
 *（`evidenceLevel: PRIMARY`、`confidence: 0.95`）：
 *
 * > 优先级：Math Truth > Verified Individual Data > Reliable Node-specific Data
 * > > Game Environment Prior > Generic Heuristic
 *
 * ## 为什么必须做成函数而不是「在别处小心一点」
 *
 * 被明确禁止的失败模式是「环境把所有低级别玩家同质化」。
 * 最危险的形态是它**静默**发生：某个玩家实测河牌诈唬频率明显偏高，
 * 但环境先验仍然把「低级别诈唬少」施加到他身上，
 * 于是系统对一个已知的诈唬型对手打出「他河牌大注多半是真牌」。
 *
 * 因此这里把裁决**显式化**：返回谁赢、为什么，供 Diagnostics 输出。
 *
 * ## 判据
 *
 * 个体数据要覆盖环境先验，必须**同时**满足：
 * 1. 有该玩家的画像（`hasProfile`）
 * 2. 画像可信度 ≥ `minIndividualConfidence`（默认 0.5，与
 *    `playerProfile.hasUsableSample` 的默认阈值同源）
 *
 * 两条都不满足时**环境先验保留** —— 这是保守方向：没有可靠个体数据时，
 * 人群倾向是唯一可用的信息。
 */
export const MIN_INDIVIDUAL_CONFIDENCE = 0.5;

export type PriorityVerdict = {
  /** 最终采用哪一侧 */
  winner: 'INDIVIDUAL' | 'ENVIRONMENT';
  /** 中文说明（进 Diagnostics 与界面） */
  reason: string;
  /** 个体侧的来源说明（无画像时为 null） */
  individualBasis: string | null;
};

export function resolveIndividualOverEnvironment(input: {
  /** 该玩家是否存在可用画像 */
  hasProfile: boolean;
  /** 画像可信度（0..1）；无画像时传 0 */
  individualConfidence: number;
  /** 画像的中文来源/性状说明（例如「实测 VPIP 41%，偏松」） */
  individualBasis?: string;
  /** 环境建议的条数（0 表示环境本来就没说话） */
  environmentAdviceCount: number;
}): PriorityVerdict {
  const confidence = Number.isFinite(input.individualConfidence)
    ? Math.max(0, Math.min(1, input.individualConfidence))
    : 0;

  if (!input.hasProfile) {
    return {
      winner: 'ENVIRONMENT',
      reason: '没有该玩家的实测数据，采用环境先验（人群倾向）',
      individualBasis: null,
    };
  }

  if (confidence >= MIN_INDIVIDUAL_CONFIDENCE) {
    return {
      winner: 'INDIVIDUAL',
      reason:
        `该玩家有可信实测数据（可信度 ${confidence.toFixed(2)} ≥ ${MIN_INDIVIDUAL_CONFIDENCE}），` +
        '个体数据优先于环境先验',
      individualBasis: input.individualBasis ?? null,
    };
  }

  return {
    winner: 'ENVIRONMENT',
    reason:
      `该玩家虽有数据但可信度不足（${confidence.toFixed(2)} < ${MIN_INDIVIDUAL_CONFIDENCE}），` +
      (input.environmentAdviceCount > 0
        ? '暂采用环境先验；样本积累后个体数据将接管'
        : '环境也未给出调整'),
    individualBasis: input.individualBasis ?? null,
  };
}

/* ============================================================
 * legacy 数值的隔离断言
 * ============================================================ */

/**
 * 本模块**不得**依赖 legacy 环境倍数值。
 *
 * 这是给「源码扫描测试」用的自查函数：它在运行时检查本模块是否
 * 意外持有了 legacy 结构的字段名。真正的保证来自
 * `test/alphaEnvironment.test.ts` 的 import 扫描断言。
 */
export const LEGACY_ENVIRONMENT_FIELDS: readonly string[] = Object.freeze([
  'weakEndTilt',
  'strongEndTilt',
  'bluffShare',
  'valueThreshold',
  'riverAdjustment',
  'multiwayAdjustment',
]);

/** 供测试：本模块导出的符号里不得出现 legacy 字段名 */
export function environmentModuleFieldNames(): readonly string[] {
  return LEGACY_ENVIRONMENT_FIELDS;
}

export { GameEnvironmentId, StrategyStreet };
