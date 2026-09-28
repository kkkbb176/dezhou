/**
 * 知识来源体系 —— 类型定义（Phase 4.5）
 *
 * ## 这个模块存在的唯一理由
 *
 * 让系统能够回答：**「这条策略结论来自哪里？」**
 *
 * 规范第 1 节要求严格区分四类东西，它们**绝不允许互相冒充**：
 *
 * | 类别 | 例子 | 要求 |
 * |---|---|---|
 * | **A 数学真值** | Hand Rank / Pot Odds / Equity / EV / Combinations / Blocker | 可验证 |
 * | **B 理论基线** | GTO / CFR / Range construction / Bet sizing theory | 注明模型、抽象与适用条件 |
 * | **C 牌池经验规律** | 低级别 River 诈唬不足、Calling Station 过度跟注 | **只能作为经验假设** |
 * | **D 个体玩家数据** | 这个玩家实际 River 诈唬偏高 | **优先级高于泛化牌池假设** |
 *
 * 本文件用类型系统把这四类分开：来源在 `KnowledgeSource`，
 * 证据等级在 `EvidenceLevel`，允许的用途在 `AllowedUsage`。
 *
 * ## 一条不可绕过的纪律
 *
 * **没有可靠量化依据时，`magnitude` 必须为空。**
 * 禁止因为一本书说「低级别 River 诈唬不足」就写
 * `riverBluffMultiplier = 0.61` —— 那是编造。
 * 没有数据时只允许 `direction = DECREASE` + `magnitude = undefined`，
 * 等真实牌局数据来校准。
 */

/* ============================================================
 * 来源类型与证据等级
 * ============================================================ */

export const KnowledgeSourceType = {
  GITHUB: 'GITHUB',
  BOOK: 'BOOK',
  PAPER: 'PAPER',
  HAND_HISTORY: 'HAND_HISTORY',
  USER_NOTE: 'USER_NOTE',
  SOLVER_OUTPUT: 'SOLVER_OUTPUT',
} as const;
export type KnowledgeSourceType = (typeof KnowledgeSourceType)[keyof typeof KnowledgeSourceType];

/**
 * 证据等级。
 *
 * 刻意**没有** `THEORY` 这个取值 —— 本项目没有 solver 输出，
 * 因此任何「理论」都只能落到 `HEURISTIC` 或 `SECONDARY`。
 * 这与 `PriorSource` 禁止 `THEORY_PRIOR` / `GTO_PRIOR` 是同一条纪律。
 */
export const EvidenceLevel = {
  /** 一手证据：原始数据、求解器输出、规范文本、可复现实验 */
  PRIMARY: 'PRIMARY',
  /** 经过独立复核的二手证据：有方法与样本量、可追溯到原始数据 */
  VERIFIED_SECONDARY: 'VERIFIED_SECONDARY',
  /** 二手证据：有出处但无法独立复核原始数据 */
  SECONDARY: 'SECONDARY',
  /** 启发式：依据公认原理构造，无数据支撑 */
  HEURISTIC: 'HEURISTIC',
} as const;
export type EvidenceLevel = (typeof EvidenceLevel)[keyof typeof EvidenceLevel];

/** 该来源**允许**用来做什么。这是许可证门禁的落地形式。 */
export const AllowedUsage = {
  /** 可以借鉴/移植代码（需满足许可证条件） */
  CODE_REFERENCE: 'CODE_REFERENCE',
  /** 只研究思想，**禁止**复制代码 */
  CONCEPT_ONLY: 'CONCEPT_ONLY',
  /** 作为案例库素材（Decision 与 Result 必须分离） */
  CASE_STUDY: 'CASE_STUDY',
  /** 作为策略参考（必须带证据等级与适用范围） */
  STRATEGY_REFERENCE: 'STRATEGY_REFERENCE',
} as const;
export type AllowedUsage = (typeof AllowedUsage)[keyof typeof AllowedUsage];

/**
 * 许可证门禁分类（规范第 5 节）。
 *
 * - `GREEN`：MIT / Apache / BSD 等宽松许可证 → 满足条件时可借鉴或移植
 * - `YELLOW`：GPL / AGPL / LGPL → 默认**只研究思想**，未经明确评估禁止复制
 * - `RED`：无许可证 / 权利不明 → 只研究概念，**禁止复制**
 */
export const LicenseGate = {
  GREEN: 'GREEN',
  YELLOW: 'YELLOW',
  RED: 'RED',
} as const;
export type LicenseGate = (typeof LicenseGate)[keyof typeof LicenseGate];

/** 项目自有内容的许可证标识（不是 SPDX 标识） */
export const PROJECT_INTERNAL_LICENSE = 'PROJECT_INTERNAL';

/**
 * 由 SPDX 标识推断门禁分类。
 *
 * 未知 / 空 → 一律 `RED`（**保守默认**）。
 * 这是刻意的：把「不知道」当成「可以用」是本项目最不能犯的错误。
 *
 * ## 边界的判定依据（每条都写出来，便于复核）
 *
 * | 输入 | 判定 | 依据 |
 * |---|---|---|
 * | `PROJECT_INTERNAL` | **GREEN** | 项目自有内容（本文件、内部规范）。它不是第三方来源，不存在「权利不明」问题 |
 * | `MIT` / `Apache-2.0` / BSD-2/3-Clause / ISC / 0BSD / Unlicense / CC0 / MIT-0 | GREEN | 宽松，允许复制 |
 * | `GPL-*` / `AGPL-*` / `LGPL-*` / `MPL-2.0` | YELLOW | copyleft —— 只研究思想 |
 * | `CC-BY-SA-*` | **YELLOW** | 带 ShareAlike 的 copyleft，性质与 GPL 同类；归 RED 会低估其可用性，归 GREEN 会允许污染 |
 * | `CC-BY-NC-*` / `CC-BY-ND-*` | RED | 非商业 / 禁止演绎 —— 不得进入本项目 |
 * | `CC-BY-*`（无 SA/NC/ND） | RED | 署名即可商用，但本项目**未做署名基础设施**，保守归 RED |
 * | `MIT OR Apache-2.0` 等 OR 表达式 | 取**最宽松**的分支 | 双许可意味着使用者**可以选择**任一许可 |
 * | `A AND B` 表达式 | 取**最严格**的分支 | 必须同时满足两者 |
 * | 未知字符串 | RED | 保守默认 |
 */
export function licenseGateOf(spdxId: string | null | undefined): LicenseGate {
  if (!spdxId || spdxId.trim().length === 0) return LicenseGate.RED;
  const normalized = spdxId.trim().toUpperCase();
  if (normalized === 'NONE' || normalized === 'NOASSERTION') return LicenseGate.RED;

  // 项目自有内容：不是第三方来源，因此不存在权利不明的问题。
  // ⚠️ 这一条必须在「未知 → RED」之前判断，否则自家规范会被报成
  // 「无许可证 / 权利不明，禁止复制」—— 那会让合规报告自相矛盾。
  if (normalized === PROJECT_INTERNAL_LICENSE) return LicenseGate.GREEN;

  // SPDX 表达式：OR 取最宽松，AND 取最严格
  if (normalized.includes(' OR ')) {
    const branches = normalized.split(' OR ').map((b) => licenseGateOf(b.trim()));
    // 只要有一条分支是 GREEN，使用者就可以选择它 → GREEN
    if (branches.includes(LicenseGate.GREEN)) return LicenseGate.GREEN;
    if (branches.includes(LicenseGate.YELLOW)) return LicenseGate.YELLOW;
    return LicenseGate.RED;
  }
  if (normalized.includes(' AND ')) {
    const branches = normalized.split(' AND ').map((b) => licenseGateOf(b.trim()));
    // 必须同时满足 → 取最严格
    if (branches.includes(LicenseGate.RED)) return LicenseGate.RED;
    if (branches.includes(LicenseGate.YELLOW)) return LicenseGate.YELLOW;
    return LicenseGate.GREEN;
  }
  // 带例外的表达式（如 `Apache-2.0 WITH LLVM-exception`）：按主许可判定
  let base = normalized;
  if (base.includes(' WITH ')) base = base.split(' WITH ')[0]!.trim();

  // CC-BY-SA 必须在 CC-BY-NC / CC-BY-ND 之前判断（否则会被前缀规则吞掉）
  if (base.startsWith('CC-BY-SA')) return LicenseGate.YELLOW;
  if (base.startsWith('CC-BY-NC') || base.startsWith('CC-BY-ND') || base.startsWith('CC-BY-NC-SA')) {
    return LicenseGate.RED;
  }
  if (base.startsWith('CC-BY')) return LicenseGate.RED;

  const green = [
    'MIT',
    'APACHE-2.0',
    'BSD-2-CLAUSE',
    'BSD-3-CLAUSE',
    'ISC',
    '0BSD',
    'UNLICENSE',
    'CC0-1.0',
    'MIT-0',
  ];
  if (green.includes(base)) return LicenseGate.GREEN;
  // BSD 变体（含 4-clause 与未指明条款数）：保守归 YELLOW 而非 GREEN，
  // 因为 4-clause BSD 带有广告条款，不是纯宽松许可
  if (base === 'BSD' || base === 'BSD-4-CLAUSE') return LicenseGate.YELLOW;

  const yellow = ['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'MPL-2.0'];
  if (yellow.some((y) => base.startsWith(y))) return LicenseGate.YELLOW;

  return LicenseGate.RED;
}

/** 该门禁下是否允许复制代码 */
export function allowsCodeCopy(gate: LicenseGate): boolean {
  return gate === LicenseGate.GREEN;
}

/* ============================================================
 * 来源注册表条目
 * ============================================================ */

export type KnowledgeSource = {
  /** 稳定 id，被策略规则引用 */
  id: string;
  title: string;
  type: KnowledgeSourceType;

  author?: string;
  /** SPDX 标识；无许可证时必须是 `'NONE'` 而不是省略 */
  license?: string;
  licenseGate: LicenseGate;
  url?: string;
  /** 审计日期（ISO 8601 日期） */
  auditDate: string;

  version?: string;
  /** GitHub 项目的提交哈希（可复现性依赖它） */
  commitHash?: string;
  /** 最近活动时间 */
  lastActivity?: string;
  /** 主要语言 / 类型 */
  language?: string;

  evidenceLevel: EvidenceLevel;
  allowedUsage: AllowedUsage;

  /**
   * 是否有可用的完整正文。
   *
   * 书籍类来源若为 `false`，则**只能登记主题索引**，
   * 绝不允许据此写出具体频率、章节内容或结论 —— 那是编造。
   */
  fullTextAvailable: boolean;
  /** 该来源**包含**可靠量化数据（不代表我们能取用） */
  hasQuantitativeData: boolean;
  /**
   * 该来源的量化数据是否**可被本项目取用并据以推导数值参数**。
   *
   * ## 为什么必须与 `hasQuantitativeData` 分开
   *
   * 这两个问题完全不同：
   * - 「这份来源里有没有数字？」→ `hasQuantitativeData`
   * - 「我们能拿这些数字来定参数吗？」→ `derivableQuantitativeData`
   *
   * 实测的四种「有数据但取不到」的情形：
   * 1. **无许可证**（GTOpen）：数据权利不明，不得引用
   * 2. **数据在上游、来源未确认**（Poker Lab 的翻牌前图表）：即使代码是 MIT，
   *    数据本身的权利仍需单独核实
   * 3. **数据是被审计项目的求解器输出**（DCFR-SOLVER / poker_solver）：
   *    本项目没有运行它们，无法独立复现
   * 4. **无可复现路径**：只存在于其内部流水线
   *
   * 只有 `derivableQuantitativeData: true` 才允许规则带 `magnitude`。
   * 这一条把「不从外部数字编造参数」变成了**可执行断言**。
   */
  derivableQuantitativeData: boolean;

  /** 适用范围（缺失即为「未知」，不得假设通用） */
  scope?: {
    gameType?: string;
    tableSize?: string;
    stackDepthBB?: string;
    stakes?: string;
    street?: string;
    players?: string;
  };

  /** 中文说明：这份来源基于什么、有什么已知限制 */
  notes: string;
  /** 已知限制与警告（中文） */
  limitations: string[];
};

/* ============================================================
 * 策略知识
 * ============================================================ */

export const StrategyStreet = {
  PREFLOP: 'PREFLOP',
  FLOP: 'FLOP',
  TURN: 'TURN',
  RIVER: 'RIVER',
  ANY: 'ANY',
} as const;
export type StrategyStreet = (typeof StrategyStreet)[keyof typeof StrategyStreet];

export const GameEnvironmentId = {
  LOW_STAKES_ONLINE: 'LOW_STAKES_ONLINE',
  MID_LOW_STAKES: 'MID_LOW_STAKES',
  THEORY_REFERENCE: 'THEORY_REFERENCE',
} as const;
export type GameEnvironmentId = (typeof GameEnvironmentId)[keyof typeof GameEnvironmentId];

export const AdjustmentDirection = {
  INCREASE: 'INCREASE',
  DECREASE: 'DECREASE',
  NEUTRAL: 'NEUTRAL',
  CONTEXT_DEPENDENT: 'CONTEXT_DEPENDENT',
} as const;
export type AdjustmentDirection = (typeof AdjustmentDirection)[keyof typeof AdjustmentDirection];

export const AdjustmentTarget = {
  VALUE_WEIGHT: 'VALUE_WEIGHT',
  BLUFF_WEIGHT: 'BLUFF_WEIGHT',
  CALL_WEIGHT: 'CALL_WEIGHT',
  FOLD_WEIGHT: 'FOLD_WEIGHT',
  BET_SIZE: 'BET_SIZE',
  RANGE_WIDTH: 'RANGE_WIDTH',
  /** 多路底池的价值下注门槛 */
  MULTIWAY_VALUE_THRESHOLD: 'MULTIWAY_VALUE_THRESHOLD',
  /** 薄价值下注的倾向 */
  THIN_VALUE_TENDENCY: 'THIN_VALUE_TENDENCY',
  /** 河牌极化程度 */
  RIVER_POLARIZATION: 'RIVER_POLARIZATION',
  /** 抓诈唬的可行性 */
  BLUFF_CATCH_VIABILITY: 'BLUFF_CATCH_VIABILITY',
  /** 阻断牌在决策中的权重 */
  BLOCKER_RELEVANCE: 'BLOCKER_RELEVANCE',
  /** 个体玩家数据相对环境先验的权重 */
  PLAYER_DATA_WEIGHT: 'PLAYER_DATA_WEIGHT',
  /** 被动玩家大额河牌进攻的可信度 */
  PASSIVE_LARGE_AGGRESSION_CREDIBILITY: 'PASSIVE_LARGE_AGGRESSION_CREDIBILITY',
} as const;
export type AdjustmentTarget = (typeof AdjustmentTarget)[keyof typeof AdjustmentTarget];

/**
 * 一条策略知识。
 *
 * ⚠️ **`magnitude` 的纪律**：没有可靠量化依据时必须缺省。
 * 类型上它是可选的，但真正强制它的是校验函数 `validateStrategyKnowledge` ——
 * 它要求「有 magnitude ⇒ 必须至少有一个 `hasQuantitativeData: true` 的来源」。
 */
export type StrategyKnowledge = {
  ruleId: string;
  street: StrategyStreet;
  gameEnvironment: GameEnvironmentId;
  /** 中文：这条规则描述的**局面** */
  situation: string;
  adjustment: AdjustmentDirection;
  target: AdjustmentTarget;
  /**
   * 调整幅度。
   *
   * **没有可靠量化依据时必须缺省**（规范第 17 节）。
   * 禁止因为一本书说「低级别 River 诈唬不足」就写 0.61。
   */
  magnitude?: number;
  evidenceLevel: EvidenceLevel;
  confidence: number;
  /** 引用的来源 id（必须都能在注册表里找到） */
  sources: string[];
  /** 中文：什么情况下**不**适用 */
  exceptions: string[];
  notes: string;
};

/* ============================================================
 * 校验
 * ============================================================ */

export type KnowledgeIssueCode =
  | 'UNKNOWN_SOURCE_REFERENCE'
  | 'MAGNITUDE_WITHOUT_DATA'
  | 'MAGNITUDE_OUT_OF_RANGE'
  | 'CONFIDENCE_OUT_OF_RANGE'
  | 'DUPLICATE_RULE_ID'
  | 'DUPLICATE_SOURCE_ID'
  | 'COPY_NOT_ALLOWED'
  | 'FULL_TEXT_UNAVAILABLE_BUT_CLAIMED'
  | 'MISSING_LIMITATIONS'
  /** 字段缺失、类型错误或取值不在已登记集合内 */
  | 'SCHEMA_FIELD_INVALID'
  | 'EVIDENCE_EXCEEDS_SOURCES'
  | 'INVALID_DATE';

export type KnowledgeIssue = {
  code: KnowledgeIssueCode;
  subject: string;
  params: Readonly<Record<string, string | number>>;
  /** 中文说明 */
  message: string;
};

/**
 * 证据等级的强弱序。规则自身的等级**不得高于**其最强来源的等级
 * —— 否则就是在夸大证据。
 */
const EVIDENCE_RANK: Readonly<Record<EvidenceLevel, number>> = {
  PRIMARY: 3,
  VERIFIED_SECONDARY: 2,
  SECONDARY: 1,
  HEURISTIC: 0,
};

/**
 * 证据等级的强弱序。
 *
 * ## 为什么对未登记等级返回 `null` 而不是 `undefined`
 *
 * 红队 F-13 发现的真实缺陷：旧版直接查表，未登记等级得到 `undefined`，
 * 而 `Math.max(...)` 与 `>` 比较遇到 `undefined` 会**静默通过**
 * （`undefined > 0` 为 `false`，`Math.max(undefined, 0)` 为 `NaN`），
 * 于是「未登记的证据等级」能建出索引并通过全部校验。
 *
 * 现在返回 `null`，调用方必须显式处理，无法静默通过。
 */
export function evidenceRank(level: EvidenceLevel): number | null {
  const rank = EVIDENCE_RANK[level];
  return rank === undefined ? null : rank;
}

/** 该证据等级是否已登记 */
export function isKnownEvidenceLevel(level: unknown): level is EvidenceLevel {
  return typeof level === 'string' && Object.prototype.hasOwnProperty.call(EVIDENCE_RANK, level);
}

/** 校验一份来源条目 */
export function validateKnowledgeSource(source: KnowledgeSource): KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];

  // 门禁必须与许可证一致（不允许手写一个更宽松的门禁）
  const derived = licenseGateOf(source.license);
  if (derived !== source.licenseGate) {
    issues.push({
      code: 'COPY_NOT_ALLOWED',
      subject: source.id,
      params: { declared: source.licenseGate, derived, license: source.license ?? 'NONE' },
      message: `门禁声明（${source.licenseGate}）与许可证（${source.license ?? 'NONE'}）推出的（${derived}）不一致`,
    });
  }
  if (source.allowedUsage === AllowedUsage.CODE_REFERENCE && !allowsCodeCopy(source.licenseGate)) {
    issues.push({
      code: 'COPY_NOT_ALLOWED',
      subject: source.id,
      params: { gate: source.licenseGate },
      message: `${source.licenseGate} 门禁的来源不得标记为 CODE_REFERENCE`,
    });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source.auditDate)) {
    issues.push({
      code: 'INVALID_DATE',
      subject: source.id,
      params: { auditDate: source.auditDate },
      message: `审计日期必须是 YYYY-MM-DD（收到 ${source.auditDate}）`,
    });
  }
  if (source.limitations.length === 0) {
    issues.push({
      code: 'MISSING_LIMITATIONS',
      subject: source.id,
      params: {},
      message: '每个来源必须至少登记一条已知限制（没有限制的来源不存在）',
    });
  }
  if (source.type === KnowledgeSourceType.BOOK && !source.fullTextAvailable && source.hasQuantitativeData) {
    issues.push({
      code: 'FULL_TEXT_UNAVAILABLE_BUT_CLAIMED',
      subject: source.id,
      params: {},
      message: '没有完整正文的书籍不得声称拥有可靠量化数据',
    });
  }
  // 可推导必然蕴含包含：不得声称「能取用」却「没有数据」
  if (source.derivableQuantitativeData && !source.hasQuantitativeData) {
    issues.push({
      code: 'FULL_TEXT_UNAVAILABLE_BUT_CLAIMED',
      subject: source.id,
      params: {},
      message: '声称数据可推导（derivableQuantitativeData）却同时声称没有量化数据，二者矛盾',
    });
  }
  // 无许可证来源的数据不得被声明为可推导（权利不明 → 不可取用）
  if (source.derivableQuantitativeData && !allowsCodeCopy(source.licenseGate)) {
    issues.push({
      code: 'COPY_NOT_ALLOWED',
      subject: source.id,
      params: { gate: source.licenseGate, license: source.license ?? 'NONE' },
      message: `${source.licenseGate} 门禁来源的数据不得被声明为「可推导」—— 权利不明或 copyleft，不得取用`,
    });
  }

  return issues;
}

/** 校验一条策略知识（需要来源注册表来解析引用） */
export function validateStrategyKnowledge(
  rule: StrategyKnowledge,
  registry: ReadonlyMap<string, KnowledgeSource>,
): KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];

  // ---- 自身的枚举合法性（红队 F-13）----
  // 未登记的证据等级必须被拒绝，而不是让 rank 比较静默通过
  if (!isKnownEvidenceLevel(rule.evidenceLevel)) {
    issues.push({
      code: 'SCHEMA_FIELD_INVALID',
      subject: rule.ruleId,
      params: { field: 'evidenceLevel', value: String(rule.evidenceLevel) },
      message: `未登记的证据等级「${String(rule.evidenceLevel)}」`,
    });
  }

  if (!Number.isFinite(rule.confidence) || rule.confidence < 0 || rule.confidence > 1) {
    issues.push({
      code: 'CONFIDENCE_OUT_OF_RANGE',
      subject: rule.ruleId,
      params: { confidence: rule.confidence },
      message: `confidence 必须在 [0, 1]（收到 ${rule.confidence}）`,
    });
  }

  // ---- 来源引用（红队 F-03）----
  // 一条**没有任何来源**的规则必须被拒绝：否则「每条结论都可追溯到来源」
  // 就只是一句口号。旧版缺这条检查，于是 `sources: []` + `PRIMARY` +
  // confidence 0.99 的规则能成功建索引。
  if (rule.sources.length === 0) {
    issues.push({
      code: 'UNKNOWN_SOURCE_REFERENCE',
      subject: rule.ruleId,
      params: {},
      message:
        '规则必须至少引用一个来源 —— 没有来源的结论无法追溯，' +
        '而「可追溯到来源」是本知识体系存在的唯一理由',
    });
  }

  const resolved: KnowledgeSource[] = [];
  for (const id of rule.sources) {
    const source = registry.get(id);
    if (!source) {
      issues.push({
        code: 'UNKNOWN_SOURCE_REFERENCE',
        subject: rule.ruleId,
        params: { sourceId: id },
        message: `引用了未登记的来源「${id}」`,
      });
      continue;
    }
    resolved.push(source);
  }

  // ⚠️ 规范第 17 节的核心断言：**可推导**的量化数据是 magnitude 的唯一依据。
  // 注意用的是 `derivableQuantitativeData` 而不是 `hasQuantitativeData` ——
  // 「来源里有数字」与「我们能拿这些数字定参数」是两件事。
  if (rule.magnitude !== undefined) {
    const hasData = resolved.some((s) => s.derivableQuantitativeData);
    if (!hasData) {
      issues.push({
        code: 'MAGNITUDE_WITHOUT_DATA',
        subject: rule.ruleId,
        params: { magnitude: rule.magnitude, sources: rule.sources.join(',') },
        message:
          '给出了具体幅度，但没有任何引用来源提供**可推导**的量化数据 —— 这是编造（规范第 17 节）。' +
          '来源「包含」量化数据并不够：无许可证、上游权利不明、或被审计项目的求解器输出都不可取用。',
      });
    }
    if (!Number.isFinite(rule.magnitude) || rule.magnitude <= 0) {
      issues.push({
        code: 'MAGNITUDE_OUT_OF_RANGE',
        subject: rule.ruleId,
        params: { magnitude: rule.magnitude },
        message: `magnitude 必须是正有限数（收到 ${rule.magnitude}）`,
      });
    }
  }

  // 规则自身的证据等级不得高于其最强来源
  if (resolved.length > 0 && isKnownEvidenceLevel(rule.evidenceLevel)) {
    const ranks = resolved.map((s) => evidenceRank(s.evidenceLevel));
    // 来源等级也必须全部已登记，否则比较无意义
    const unknownSource = resolved.find((s) => evidenceRank(s.evidenceLevel) === null);
    if (unknownSource) {
      issues.push({
        code: 'SCHEMA_FIELD_INVALID',
        subject: rule.ruleId,
        params: { sourceId: unknownSource.id, level: String(unknownSource.evidenceLevel) },
        message: `来源「${unknownSource.id}」的证据等级未登记，无法比较`,
      });
    } else {
      const bestSourceRank = Math.max(...(ranks as number[]));
      if (evidenceRank(rule.evidenceLevel)! > bestSourceRank) {
        issues.push({
          code: 'EVIDENCE_EXCEEDS_SOURCES',
          subject: rule.ruleId,
          params: {
            ruleLevel: rule.evidenceLevel,
            bestSourceLevel: resolved.find((s) => evidenceRank(s.evidenceLevel) === bestSourceRank)!
              .evidenceLevel,
          },
          message: '规则声明的证据等级高于其来源中的最高等级 —— 属于夸大证据',
        });
      }
    }
  }

  if (rule.exceptions.length === 0) {
    issues.push({
      code: 'MISSING_LIMITATIONS',
      subject: rule.ruleId,
      params: {},
      message: '每条策略规则必须登记至少一条例外（没有例外的规则必然过宽）',
    });
  }

  return issues;
}

/** 校验整个知识库（来源 + 规则），返回**全部**问题而不是遇到第一个就停 */
export function validateKnowledgeBase(input: {
  sources: readonly KnowledgeSource[];
  rules: readonly StrategyKnowledge[];
}): KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];

  const registry = new Map<string, KnowledgeSource>();
  for (const source of input.sources) {
    if (registry.has(source.id)) {
      issues.push({
        code: 'DUPLICATE_SOURCE_ID',
        subject: source.id,
        params: {},
        message: `来源 id 重复：${source.id}`,
      });
    }
    registry.set(source.id, source);
    issues.push(...validateKnowledgeSource(source));
  }

  const seenRules = new Set<string>();
  for (const rule of input.rules) {
    if (seenRules.has(rule.ruleId)) {
      issues.push({
        code: 'DUPLICATE_RULE_ID',
        subject: rule.ruleId,
        params: {},
        message: `规则 id 重复：${rule.ruleId}`,
      });
    }
    seenRules.add(rule.ruleId);
    issues.push(...validateStrategyKnowledge(rule, registry));
  }

  return issues;
}
