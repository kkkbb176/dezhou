/**
 * 知识来源体系 —— 加载、校验与查询（Phase 4.5）
 *
 * ## 三条硬纪律
 *
 * 1. **Fail-Closed（规范第 35 节）**
 *    来源缺失、JSON 损坏、schema 不符、引用悬空 → **拒绝加载**并报出具体问题。
 *    绝不「跳过坏条目继续跑」—— 那会让一个损坏的知识库看起来完全正常。
 *
 * 2. **不编造（规范第 17 节）**
 *    没有量化数据支撑的规则不得带 `magnitude`。这一条在
 *    `validateStrategyKnowledge` 里是**硬校验**，不是注释。
 *
 * 3. **知识不进热路径（规范第 41 / 42 节）**
 *    加载与校验在一次初始化时完成；运行时查询是**纯内存表查找**。
 *    `Source lookup` 明确标注为不进入决策热路径。
 *
 * ## 与领域层的边界
 *
 * 本模块只做「读取 + 校验 + 索引」，**不产生任何策略结论**。
 * 它不导入权益、赔率、牌力或决策引擎 —— 知识层与数学层永不互相依赖。
 */

import {
  AdjustmentDirection,
  AdjustmentTarget,
  AllowedUsage,
  EvidenceLevel,
  GameEnvironmentId,
  KnowledgeSourceType,
  StrategyStreet,
  allowsCodeCopy,
  licenseGateOf,
  validateKnowledgeBase,
  type GameEnvironmentId as GameEnvironmentIdType,
  type KnowledgeIssue,
  type KnowledgeSource,
  type StrategyKnowledge,
} from './knowledge.types.ts';

/* ============================================================
 * 解析结果（Fail-Closed）
 * ============================================================ */

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: KnowledgeIssue[] };

type Ctx = { issues: KnowledgeIssue[]; subject: string };

function fail(ctx: Ctx, code: KnowledgeIssue['code'], params: Record<string, string | number>, message: string): void {
  ctx.issues.push({ code, subject: ctx.subject, params, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(ctx: Ctx, object: Record<string, unknown>, field: string): string | null {
  const value = object[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(ctx, 'SCHEMA_FIELD_INVALID', { field }, `字段「${field}」必须是非空字符串（收到 ${JSON.stringify(value)}）`);
    return null;
  }
  return value;
}

function requireBoolean(ctx: Ctx, object: Record<string, unknown>, field: string): boolean | null {
  const value = object[field];
  if (typeof value !== 'boolean') {
    fail(ctx, 'SCHEMA_FIELD_INVALID', { field }, `字段「${field}」必须是布尔值（收到 ${JSON.stringify(value)}）`);
    return null;
  }
  return value;
}

function requireStringArray(ctx: Ctx, object: Record<string, unknown>, field: string): string[] | null {
  const value = object[field];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail(ctx, 'SCHEMA_FIELD_INVALID', { field }, `字段「${field}」必须是字符串数组`);
    return null;
  }
  return value as string[];
}

function requireEnum<T extends string>(
  ctx: Ctx,
  object: Record<string, unknown>,
  field: string,
  allowed: Readonly<Record<string, T>>,
): T | null {
  const value = object[field];
  if (typeof value !== 'string' || !Object.values(allowed).includes(value as T)) {
    fail(
      ctx,
      'SCHEMA_FIELD_INVALID',
      { field, value: String(value), allowed: Object.values(allowed).join('|') },
      `字段「${field}」必须是已登记取值之一（收到 ${JSON.stringify(value)}）`,
    );
    return null;
  }
  return value as T;
}

/* ============================================================
 * 来源解析
 * ============================================================ */

const KNOWN_EVIDENCE: Readonly<Record<string, EvidenceLevel>> = Object.freeze(
  Object.fromEntries(Object.values(EvidenceLevel).map((v) => [v, v])),
);

const KNOWN_USAGE: Readonly<Record<string, AllowedUsage>> = Object.freeze(
  Object.fromEntries(Object.values(AllowedUsage).map((v) => [v, v])),
);

const KNOWN_SOURCE_TYPE: Readonly<Record<string, KnowledgeSourceType>> = Object.freeze(
  Object.fromEntries(Object.values(KnowledgeSourceType).map((v) => [v, v])),
);

/**
 * 深冻结一个值（递归）。
 *
 * 红队 F-04 发现的真实缺陷：`Object.freeze(source)` 是**浅冻结**，
 * 于是 `source.scope.gameType = '...'` / `source.limitations.push(...)`
 * 都能成功改写 —— 而 `scope` 正是「防止范围混淆」的载体，
 * `limitations` 正是「不夸大证据」的载体。
 *
 * 这与本项目此前踩过的两次冻结坑（范围引擎 `ALL_COMBOS`、玩家画像
 * `decay` / `seenHandIds`）是同一类：**`Object.freeze` 只作用于第一层**。
 */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as unknown as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Object.keys(object)) {
    deepFreeze((object as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

/** scope 的已登记字段（白名单：未知字段一律拒绝，防止悄悄夹带未校验信息） */
const SCOPE_FIELDS = [
  'gameType',
  'tableSize',
  'stackDepthBB',
  'stakes',
  'street',
  'players',
] as const;

/**
 * 校验并规范化 `scope`。
 *
 * 红队 F-06 发现：旧版用 `input.scope as KnowledgeSource['scope']` **强转**，
 * 完全未校验 —— `{ tableSize: 42 }` 或含未登记字段的 scope 都能通过。
 * 而范围审计正是靠 scope 判断「锦标赛 / 现金」「6-max / 9-max」是否混淆，
 * 未校验的 scope 等于没有防护。
 */
function parseScope(ctx: Ctx, input: unknown): KnowledgeSource['scope'] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isRecord(input)) {
    fail(ctx, 'SCHEMA_FIELD_INVALID', { field: 'scope' }, 'scope 必须是对象');
    return undefined;
  }
  const scope: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (!(SCOPE_FIELDS as readonly string[]).includes(key)) {
      fail(
        ctx,
        'SCHEMA_FIELD_INVALID',
        { field: `scope.${key}`, allowed: SCOPE_FIELDS.join('|') },
        `scope 含未登记字段「${key}」（只允许 ${SCOPE_FIELDS.join(' / ')}）`,
      );
      continue;
    }
    const value = input[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      fail(
        ctx,
        'SCHEMA_FIELD_INVALID',
        { field: `scope.${key}`, value: String(value) },
        `scope.${key} 必须是非空字符串（收到 ${JSON.stringify(value)}）`,
      );
      continue;
    }
    scope[key] = value;
  }
  return Object.keys(scope).length > 0 ? (scope as KnowledgeSource['scope']) : undefined;
}

export function parseKnowledgeSource(input: unknown): ParseResult<KnowledgeSource> {
  const ctx: Ctx = {
    issues: [],
    subject: isRecord(input) && typeof input.id === 'string' ? input.id : '<unknown source>',
  };
  if (!isRecord(input)) {
    fail(ctx, 'SCHEMA_FIELD_INVALID', {}, '来源条目必须是对象');
    return { ok: false, issues: ctx.issues };
  }

  const id = requireString(ctx, input, 'id');
  const title = requireString(ctx, input, 'title');
  const type = requireEnum(ctx, input, 'type', KNOWN_SOURCE_TYPE);
  const license = requireString(ctx, input, 'license');
  const auditDate = requireString(ctx, input, 'auditDate');
  const evidenceLevel = requireEnum(ctx, input, 'evidenceLevel', KNOWN_EVIDENCE);
  const allowedUsage = requireEnum(ctx, input, 'allowedUsage', KNOWN_USAGE);
  const fullTextAvailable = requireBoolean(ctx, input, 'fullTextAvailable');
  const hasQuantitativeData = requireBoolean(ctx, input, 'hasQuantitativeData');
  const derivableQuantitativeData = requireBoolean(ctx, input, 'derivableQuantitativeData');
  const notes = requireString(ctx, input, 'notes');
  const limitations = requireStringArray(ctx, input, 'limitations');
  const scope = parseScope(ctx, input.scope);

  if (ctx.issues.length > 0) return { ok: false, issues: ctx.issues };

  // 门禁一律**由许可证推导**，不接受手写 —— 杜绝「声明一个更宽松的门禁」。
  // 若 JSON 里写了与推导结果不同的值，这里会**记录一条告警**（由
  // validateKnowledgeSource 的「声明 vs 推导」检查承担，解析器只负责推导）。
  const licenseGate = licenseGateOf(license);

  const source: KnowledgeSource = {
    id: id!,
    title: title!,
    type: type!,
    license: license!,
    licenseGate,
    auditDate: auditDate!,
    evidenceLevel: evidenceLevel!,
    allowedUsage: allowedUsage!,
    fullTextAvailable: fullTextAvailable!,
    hasQuantitativeData: hasQuantitativeData!,
    derivableQuantitativeData: derivableQuantitativeData!,
    notes: notes!,
    limitations: limitations!,
    ...(scope !== undefined ? { scope } : {}),
    ...(typeof input.author === 'string' ? { author: input.author } : {}),
    ...(typeof input.url === 'string' ? { url: input.url } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.commitHash === 'string' ? { commitHash: input.commitHash } : {}),
    ...(typeof input.lastActivity === 'string' ? { lastActivity: input.lastActivity } : {}),
    ...(typeof input.language === 'string' ? { language: input.language } : {}),
  };

  return { ok: true, value: source };
}

export function parseSourceRegistry(input: unknown): ParseResult<readonly KnowledgeSource[]> {
  const ctx: Ctx = { issues: [], subject: 'source-registry.json' };
  if (!isRecord(input)) {
    fail(ctx, 'SCHEMA_FIELD_INVALID', {}, '注册表根必须是对象');
    return { ok: false, issues: ctx.issues };
  }
  if (!Array.isArray(input.sources)) {
    fail(ctx, 'SCHEMA_FIELD_INVALID', { field: 'sources' }, '注册表必须含 sources 数组');
    return { ok: false, issues: ctx.issues };
  }

  const parsed: KnowledgeSource[] = [];
  const issues: KnowledgeIssue[] = [];
  for (const entry of input.sources) {
    const result = parseKnowledgeSource(entry);
    if (result.ok) parsed.push(result.value);
    else issues.push(...result.issues);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: parsed };
}

/* ============================================================
 * 规则解析
 * ============================================================ */

const KNOWN_STREET: Readonly<Record<string, StrategyStreet>> = Object.freeze(
  Object.fromEntries(Object.values(StrategyStreet).map((v) => [v, v])),
);

const KNOWN_ENV: Readonly<Record<string, GameEnvironmentId>> = Object.freeze(
  Object.fromEntries(Object.values(GameEnvironmentId).map((v) => [v, v])),
);

const KNOWN_DIRECTION: Readonly<Record<string, AdjustmentDirection>> = Object.freeze(
  Object.fromEntries(Object.values(AdjustmentDirection).map((v) => [v, v])),
);

/**
 * 已登记的调整目标。
 *
 * 与 `AdjustmentTarget` 必须**保持同步** —— 有测试断言两者的取值集合一致，
 * 防止「类型里加了目标但解析器不认」这种漂移。
 */
const KNOWN_TARGET: Readonly<Record<string, AdjustmentTarget>> = Object.freeze(
  Object.fromEntries(Object.values(AdjustmentTarget).map((v) => [v, v])),
);

export function parseStrategyKnowledge(input: unknown): ParseResult<StrategyKnowledge> {
  const ctx: Ctx = {
    issues: [],
    subject: isRecord(input) && typeof input.ruleId === 'string' ? input.ruleId : '<unknown rule>',
  };
  if (!isRecord(input)) {
    fail(ctx, 'SCHEMA_FIELD_INVALID', {}, '规则必须是对象');
    return { ok: false, issues: ctx.issues };
  }

  const ruleId = requireString(ctx, input, 'ruleId');
  const street = requireEnum(ctx, input, 'street', KNOWN_STREET);
  const gameEnvironment = requireEnum(ctx, input, 'gameEnvironment', KNOWN_ENV);
  const situation = requireString(ctx, input, 'situation');
  const adjustment = requireEnum(ctx, input, 'adjustment', KNOWN_DIRECTION);
  const target = requireEnum(ctx, input, 'target', KNOWN_TARGET);
  const evidenceLevel = requireEnum(ctx, input, 'evidenceLevel', KNOWN_EVIDENCE);
  const sources = requireStringArray(ctx, input, 'sources');
  const exceptions = requireStringArray(ctx, input, 'exceptions');
  const notes = requireString(ctx, input, 'notes');

  const confidence = input.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    fail(ctx, 'CONFIDENCE_OUT_OF_RANGE', { confidence: String(confidence) }, 'confidence 必须是数字');
  }

  // magnitude 可选；但一旦出现必须是数字（具体是否有数据支撑由 validate 检查）
  let magnitude: number | undefined;
  if (input.magnitude !== undefined && input.magnitude !== null) {
    if (typeof input.magnitude !== 'number' || !Number.isFinite(input.magnitude)) {
      fail(ctx, 'MAGNITUDE_OUT_OF_RANGE', { magnitude: String(input.magnitude) }, 'magnitude 必须是有限数字');
    } else {
      magnitude = input.magnitude;
    }
  }

  if (ctx.issues.length > 0) return { ok: false, issues: ctx.issues };

  return {
    ok: true,
    value: {
      ruleId: ruleId!,
      street: street!,
      gameEnvironment: gameEnvironment!,
      situation: situation!,
      adjustment: adjustment!,
      target: target!,
      evidenceLevel: evidenceLevel!,
      confidence: confidence as number,
      sources: sources!,
      exceptions: exceptions!,
      notes: notes!,
      ...(magnitude !== undefined ? { magnitude } : {}),
    },
  };
}

export function parseStrategyRules(input: unknown): ParseResult<readonly StrategyKnowledge[]> {
  const ctx: Ctx = { issues: [], subject: 'strategy-rules.json' };
  if (!isRecord(input)) {
    fail(ctx, 'SCHEMA_FIELD_INVALID', {}, '规则文件根必须是对象');
    return { ok: false, issues: ctx.issues };
  }
  if (!Array.isArray(input.rules)) {
    fail(ctx, 'SCHEMA_FIELD_INVALID', { field: 'rules' }, '规则文件必须含 rules 数组');
    return { ok: false, issues: ctx.issues };
  }

  const parsed: StrategyKnowledge[] = [];
  const issues: KnowledgeIssue[] = [];
  for (const entry of input.rules) {
    const result = parseStrategyKnowledge(entry);
    if (result.ok) parsed.push(result.value);
    else issues.push(...result.issues);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: parsed };
}

/* ============================================================
 * 知识库
 * ============================================================ */

export type KnowledgeBase = {
  version: string;
  auditDate: string;
  sources: readonly KnowledgeSource[];
  rules: readonly StrategyKnowledge[];
};

/** 只读索引（构建期算好，运行时 O(1) 查询） */
export type KnowledgeIndex = {
  readonly size: number;
  /** 全部来源（只读） */
  allSources(): readonly KnowledgeSource[];
  /** 全部规则（只读） */
  allRules(): readonly StrategyKnowledge[];
  /** 按 id 取来源 */
  source(id: string): KnowledgeSource | undefined;
  /** 按 id 取规则 */
  rule(ruleId: string): StrategyKnowledge | undefined;
  /** 某条规则引用的全部来源（悬空引用已被构建期拦截，因此不会缺项） */
  sourcesOf(ruleId: string): readonly KnowledgeSource[];
  /** 按环境 + 街道筛选规则 */
  rulesFor(environment: GameEnvironmentIdType, street?: StrategyStreet): readonly StrategyKnowledge[];
  /** 某个来源被哪些规则引用 */
  rulesUsing(sourceId: string): readonly StrategyKnowledge[];
  /** 允许复制代码的来源（门禁 GREEN 且用途为 CODE_REFERENCE） */
  codeCopyable(): readonly KnowledgeSource[];
  /** 合规审计：列出所有**不得**复制代码的来源及原因 */
  copyRestrictions(): ReadonlyArray<{ id: string; gate: string; reason: string }>;
  /** 统计摘要（供 UI 与报告使用） */
  summary(): {
    totalSources: number;
    totalRules: number;
    byEvidenceLevel: Record<string, number>;
    byLicenseGate: Record<string, number>;
    sourcesWithoutFullText: number;
    rulesWithoutMagnitude: number;
  };
};

/**
 * 构建知识索引。
 *
 * **Fail-Closed**：任何校验失败都抛错，绝不返回一个「部分可用」的索引。
 * 一个静默残缺的知识库比没有知识库更危险 —— 它会让人以为结论有依据。
 */
export function buildKnowledgeIndex(base: KnowledgeBase): KnowledgeIndex {
  const issues = validateKnowledgeBase({ sources: base.sources, rules: base.rules });
  if (issues.length > 0) {
    const detail = issues.map((i) => `  [${i.code}] ${i.subject}：${i.message}`).join('\n');
    throw new Error(`buildKnowledgeIndex: 知识库校验失败（${issues.length} 项），拒绝加载：\n${detail}`);
  }

  // 冻结必须**递归**（红队 F-04）：`Object.freeze` 只作用于第一层，
  // 于是 `source.scope.gameType = ...` 与 `source.limitations.push(...)`
  // 都能成功改写 —— 而这两者正是「防范围混淆」与「不夸大证据」的载体。
  const sources = Object.freeze(
    base.sources.map((s) => deepFreeze(s)),
  ) as readonly KnowledgeSource[];
  const rules = Object.freeze(
    base.rules.map((r) => deepFreeze(r)),
  ) as readonly StrategyKnowledge[];

  const sourceById = new Map<string, KnowledgeSource>();
  for (const source of sources) sourceById.set(source.id, source);

  const ruleById = new Map<string, StrategyKnowledge>();
  for (const rule of rules) ruleById.set(rule.ruleId, rule);

  // 反向索引的内部数组**冻结后再暴露**：直接返回内部引用会让调用方
  // 通过 push 污染索引（红队 F-04 实测：push 后下次读取变成 4 条）
  const rulesBySource = new Map<string, readonly StrategyKnowledge[]>();
  {
    const mutable = new Map<string, StrategyKnowledge[]>();
    for (const rule of rules) {
      for (const id of rule.sources) {
        const list = mutable.get(id) ?? [];
        list.push(rule);
        mutable.set(id, list);
      }
    }
    for (const [id, list] of mutable) rulesBySource.set(id, Object.freeze(list.slice()));
  }
  const EMPTY_RULES: readonly StrategyKnowledge[] = Object.freeze([]);
  const EMPTY_SOURCES: readonly KnowledgeSource[] = Object.freeze([]);

  return Object.freeze({
    size: sources.length,

    allSources: () => sources,
    allRules: () => rules,
    source: (id: string) => sourceById.get(id),
    rule: (ruleId: string) => ruleById.get(ruleId),
    sourcesOf: (ruleId: string) => {
      const rule = ruleById.get(ruleId);
      if (!rule) return EMPTY_SOURCES;
      const out: KnowledgeSource[] = [];
      for (const id of rule.sources) {
        const source = sourceById.get(id);
        if (source) out.push(source);
      }
      return Object.freeze(out);
    },

    rulesFor: (environment, street) =>
      Object.freeze(
        rules.filter(
          (rule) =>
            rule.gameEnvironment === environment &&
            (street === undefined || rule.street === street || rule.street === StrategyStreet.ANY),
        ),
      ),

    // 返回**冻结副本**，绝不暴露内部数组（红队 F-04）
    rulesUsing: (sourceId: string) => rulesBySource.get(sourceId) ?? EMPTY_RULES,

    codeCopyable: () => Object.freeze(sources.filter(
      (source) => allowsCodeCopy(source.licenseGate) && source.allowedUsage === AllowedUsage.CODE_REFERENCE,
    )),

    copyRestrictions: () =>
      sources
        .filter((source) => !allowsCodeCopy(source.licenseGate))
        .map((source) => ({
          id: source.id,
          gate: source.licenseGate,
          reason:
            source.licenseGate === 'RED'
              ? `许可证为 ${source.license ?? 'NONE'}（无许可证 / 权利不明）—— 只研究概念，禁止复制`
              : `许可证为 ${source.license ?? 'NONE'}（copyleft）—— 默认只研究思想，未经明确评估禁止复制`,
        })),

    summary: () => {
      const byEvidenceLevel: Record<string, number> = {};
      for (const source of sources) {
        byEvidenceLevel[source.evidenceLevel] = (byEvidenceLevel[source.evidenceLevel] ?? 0) + 1;
      }
      const byLicenseGate: Record<string, number> = {};
      for (const source of sources) {
        byLicenseGate[source.licenseGate] = (byLicenseGate[source.licenseGate] ?? 0) + 1;
      }
      return {
        totalSources: sources.length,
        totalRules: rules.length,
        byEvidenceLevel,
        byLicenseGate,
        sourcesWithoutFullText: sources.filter((s) => !s.fullTextAvailable).length,
        rulesWithoutMagnitude: rules.filter((r) => r.magnitude === undefined).length,
      };
    },
  });
}
