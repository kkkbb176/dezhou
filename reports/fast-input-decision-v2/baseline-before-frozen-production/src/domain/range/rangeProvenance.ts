/**
 * 来源登记表（规范第十三 / 十五 / 五十六节）
 *
 * 任何范围都必须能回答「这个数据从哪里来的」。
 *
 * 本文件刻意**不包含任何真实范围数据** —— 数据放在 data/ranges/** 下并版本化
 * （规范第十七节：禁止把范围数据硬编码进引擎）。
 * 这里只负责：登记、查询、校验来源元数据本身是否合规。
 */

import { EPSILON, RangeSource, type ProvenanceRegistry, type RangeProvenance } from './range.types.ts';

/**
 * 来源类型 → 允许的最大 confidence 上限。
 *
 * 这不是「保守」，而是**语义约束**：
 * - TEST_ONLY 永远不允许声称高可信
 * - FALLBACK 本身就是兜底，不许自称可信
 * - HEURISTIC 有原理支撑但无 solver 验证，上限刻意压低
 * - THEORY_SOURCE 若未 verified，也不允许满分
 *
 * ⚠️ 未知来源类型返回 **0**（而不是 undefined）。
 * 红队审计发现：旧版返回 undefined 会让 `confidence > cap` 变成
 * `NaN > undefined` → 恒为 false，于是**未知来源可以携带 confidence = 1 一路通关**。
 */
const CONFIDENCE_CAP: Readonly<Record<RangeSource, number>> = {
  THEORY_SOURCE: 0.95,
  VERIFIED_DATA: 0.9,
  USER_DEFINED: 0.85,
  EMPIRICAL: 0.7,
  HEURISTIC: 0.55,
  FALLBACK: 0.25,
  TEST_ONLY: 0.1,
};

export function confidenceCapFor(source: RangeSource): number {
  const cap = CONFIDENCE_CAP[source];
  // 未知来源类型 → 上限 0，任何正置信度都会被拒绝
  return cap === undefined ? 0 : cap;
}

/** 来源类型是否是已知的合法值 */
export function isKnownRangeSource(source: unknown): source is RangeSource {
  return typeof source === 'string' && Object.prototype.hasOwnProperty.call(CONFIDENCE_CAP, source);
}

/** TEST_ONLY 数据**禁止进入生产建议**（规范第十六节） */
export function isProductionUsable(provenance: RangeProvenance): boolean {
  return provenance.sourceType !== RangeSource.TEST_ONLY;
}

/** FALLBACK 不允许静默出现：任何使用者都必须显式处理它 */
export function isFallback(provenance: RangeProvenance): boolean {
  return provenance.sourceType === RangeSource.FALLBACK;
}

export type ProvenanceIssue = {
  field: string;
  problem: string;
};

/**
 * 校验来源元数据是否合规。
 *
 * 重点拦住「把启发式冒充理论」（规范第五十六 / 五十七节）：
 * - sourceType = THEORY_SOURCE 但没有任何验证依据 → 报错
 * - confidence 超过该来源类型的上限 → 报错
 */
export function validateProvenance(provenance: RangeProvenance): ProvenanceIssue[] {
  const issues: ProvenanceIssue[] = [];

  // ---- 来源类型必须是已知枚举值 ----
  // 红队审计发现：未知字符串（如 'GTO_SOLVER'）会让 confidence 上限比较退化为 NaN 比较，
  // 从而绕过全部可信度约束。必须在最前面显式拦截。
  if (!isKnownRangeSource(provenance.sourceType)) {
    issues.push({
      field: 'sourceType',
      problem:
        `未知的来源类型「${String(provenance.sourceType)}」。` +
        `必须是以下之一：${Object.keys(CONFIDENCE_CAP).join(' / ')}`,
    });
  }

  if (!provenance.sourceId || provenance.sourceId.trim().length === 0) {
    issues.push({ field: 'sourceId', problem: '来源标识不能为空' });
  }
  if (!provenance.version || provenance.version.trim().length === 0) {
    issues.push({ field: 'version', problem: '版本不能为空（缓存 key 依赖它）' });
  }
  if (!provenance.description || provenance.description.trim().length === 0) {
    issues.push({ field: 'description', problem: '必须说明这份范围基于什么' });
  }
  if (!Number.isFinite(provenance.confidence)) {
    issues.push({ field: 'confidence', problem: `confidence 必须是有限数（收到 ${provenance.confidence}）` });
  } else if (provenance.confidence < 0 || provenance.confidence > 1) {
    issues.push({ field: 'confidence', problem: `confidence 必须在 0..1（收到 ${provenance.confidence}）` });
  } else {
    const cap = confidenceCapFor(provenance.sourceType);
    if (provenance.confidence > cap + EPSILON) {
      issues.push({
        field: 'confidence',
        problem: `来源类型 ${String(provenance.sourceType)} 的 confidence 上限为 ${cap}，收到 ${provenance.confidence}`,
      });
    }
  }

  // 自称理论来源必须真的验证过 —— 否则就是「把启发式冒充 GTO」
  if (provenance.sourceType === RangeSource.THEORY_SOURCE && !provenance.verified) {
    issues.push({
      field: 'sourceType',
      problem: 'THEORY_SOURCE 必须 verified=true；没有 solver 输出或权威数据集时请改用 HEURISTIC',
    });
  }

  if (provenance.sourceType === RangeSource.VERIFIED_DATA && !provenance.verified) {
    issues.push({
      field: 'sourceType',
      problem: 'VERIFIED_DATA 必须 verified=true',
    });
  }

  return issues;
}

/**
 * 断言 provenance 合法；非法则抛错。
 *
 * 供所有**范围构建入口**调用 —— 红队审计发现旧版四个构建入口
 * 都不校验 provenance，于是「未验证的 THEORY_SOURCE + confidence 0.95」
 * 可以一路构建成功并 `isProductionUsable() === true`。
 */
export function assertValidProvenance(provenance: RangeProvenance): void {
  const issues = validateProvenance(provenance);
  if (issues.length > 0) {
    throw new Error(
      `assertValidProvenance: 来源「${String(provenance.sourceId)}」不合规：` +
        issues.map((i) => `${i.field}(${i.problem})`).join('；'),
    );
  }
}

/* ============================================================
 * 登记表
 * ============================================================ */

export function createProvenanceRegistry(
  entries: readonly RangeProvenance[] = [],
): ProvenanceRegistry {
  const map = new Map<string, RangeProvenance>();
  for (const entry of entries) {
    const issues = validateProvenance(entry);
    if (issues.length > 0) {
      throw new Error(
        `createProvenanceRegistry: 来源「${entry.sourceId}」不合规：` +
          issues.map((i) => `${i.field}(${i.problem})`).join('；'),
      );
    }
    if (map.has(entry.sourceId)) {
      throw new Error(`createProvenanceRegistry: 来源标识重复：${entry.sourceId}`);
    }
    map.set(entry.sourceId, { ...entry });
  }
  return map;
}

/** 把新来源加入登记表（返回新表，不修改原表） */
export function registerProvenance(
  registry: ProvenanceRegistry,
  provenance: RangeProvenance,
): Map<string, RangeProvenance> {
  const issues = validateProvenance(provenance);
  if (issues.length > 0) {
    throw new Error(
      `registerProvenance: 来源「${provenance.sourceId}」不合规：` +
        issues.map((i) => `${i.field}(${i.problem})`).join('；'),
    );
  }
  const next = new Map(registry);
  next.set(provenance.sourceId, { ...provenance });
  return next;
}

/** 取出来源；未登记则抛错（强制「来源必须可追踪」） */
export function requireProvenance(
  registry: ProvenanceRegistry,
  sourceId: string,
): RangeProvenance {
  const found = registry.get(sourceId);
  if (!found) {
    throw new Error(`requireProvenance: 未登记的范围来源「${sourceId}」`);
  }
  return found;
}

/* ============================================================
 * 测试专用来源
 * ============================================================ */

/**
 * 测试与合成夹具的统一来源。
 *
 * 刻意把 confidence 设为极低值并标注 TEST_ONLY，
 * 使得任何「误把测试数据当生产数据」的行为都会在下游置信度上立刻显形。
 */
export function testOnlyProvenance(sourceId: string, description: string): RangeProvenance {
  return {
    sourceId,
    sourceType: RangeSource.TEST_ONLY,
    version: '1.0.0',
    description,
    verified: false,
    confidence: 0.05,
  };
}

export { RangeSource };
export type { RangeProvenance, ProvenanceRegistry };
