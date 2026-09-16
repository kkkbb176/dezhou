/**
 * 范围构建与度量（规范第六 / 七 / 九 / 二十九 / 四十一节）
 *
 * 核心职责：
 * 1. 从「类别权重」或「组合权重」构建**不可变** Range
 * 2. 严格遵守「建立 Prior → 移除死牌 → 归一化」的顺序
 * 3. 计算度量（supportSize / effectiveComboCount / entropy）
 *
 * 不可变是硬要求（规范第四十一节）：复盘时必须能取回「当时那一步的范围」，
 * 若被后续动作原地修改，历史范围就永久污染了。
 * 因此所有构建函数最后都会 `Object.freeze` 顶层对象与数组。
 */

import type { Card } from '../types.ts';
import {
  ALL_COMBOS,
  COMBO_BY_ID,
  expandRankClasses,
  type ExactCombo,
} from './combo.ts';
import { deadCardsFrom, isBlocked, type DeadCardSet } from './rangeBlockers.ts';
import { normalizeWeights, probabilityMetrics } from './rangeNormalize.ts';
import { assertValidProvenance } from './rangeProvenance.ts';
import {
  RangeErrorCode,
  RangeSource,
  RangeState,
  rangeFailure,
  type Range,
  type RangeEntry,
  type RangeMetrics,
  type RangeOutcome,
  type RangeProvenance,
  type ReadOnlyIndex,
} from './range.types.ts';

/* ============================================================
 * 权重输入
 * ============================================================ */

/**
 * 类别的权重输入：`{ AA: 1.0, KK: 1.0, QQ: 0.5 }`。
 *
 * 这是**数据输入层**的表达方式（169 类），进入计算前会被展开成 exact combos。
 * 同一个类别下的所有组合共享该权重（例如 AA 的 6 个组合权重都是 1.0）。
 */
export type RankClassWeights = Readonly<Record<string, number>>;

/** 组合的权重输入：`{ 'AsKd': 1.0 }` */
export type ComboWeights = ReadonlyMap<string, number>;

export type BuildRangeOptions = {
  provenance: RangeProvenance;
  /**
   * 死牌（Hero 底牌 + 公共牌 + 已知对手牌）。会被移除且**重新归一化**。
   *
   * 类型刻意是 unknown：deadCardsFrom 会严格校验并规范化任意形状的输入，
   * 非法表示**抛错**而不是静默失效（红队 MAJOR-4）。
   */
  deadCards?: unknown;
  /** 生成 rangeId 时使用的前缀，便于日志识别 */
  rangeIdPrefix?: string;
  /** 上一次的范围 id（用于 previousRangeId 链） */
  previousRangeId?: string | null;
  /** 覆盖条目的 source（默认取 provenance.sourceType） */
  source?: RangeSource;
  tags?: readonly string[];
};

let rangeCounter = 0;

/** 生成稳定、可复现的范围 id（同一进程内单调递增） */
export function nextRangeId(prefix = 'r'): string {
  rangeCounter += 1;
  return `${prefix}-${rangeCounter}`;
}

/** 仅供测试：重置计数器，使快照可复现 */
export function __resetRangeIdCounter(): void {
  rangeCounter = 0;
}

/**
 * 规范化死牌输入。
 *
 * 刻意**不**用鸭子类型判断「看起来像 Set 就直接用」——
 * 红队审计发现那样会让 `new Set(['As','Kd'])`（字符串集合）被当作合法索引集合，
 * 于是死牌过滤**静默失效**（1326 而不是 1225），且没有任何报错。
 * 现在一律交给 `deadCardsFrom` 做严格校验与大小写归一化。
 */
function resolveDeadCards(dead: unknown): DeadCardSet {
  return deadCardsFrom(dead);
}

/* ============================================================
 * 构建
 * ============================================================ */

/**
 * 从「组合 → 原始权重」构建范围。
 *
 * 严格顺序：
 *   1. 只保留 canonicalId 有效的组合（未知 id 直接报错，不静默忽略）
 *   2. 移除与死牌冲突的组合
 *   3. 归一化
 *   4. 计算度量
 */
export function buildRangeFromComboWeights(
  weights: ComboWeights,
  options: BuildRangeOptions,
): RangeOutcome<Range> {
  // 构建入口必须校验来源元数据（红队 MAJOR-5：旧版完全绕过校验，
  // 未验证的 THEORY_SOURCE + confidence 0.95 可以一路构建成功）
  assertValidProvenance(options.provenance);

  const dead = resolveDeadCards(options.deadCards);
  const source = options.source ?? options.provenance.sourceType;
  const tags = options.tags;

  const pairs: Array<{ combo: ExactCombo; rawWeight: number }> = [];
  const unknown: string[] = [];

  for (const [comboId, rawWeight] of weights) {
    const combo = COMBO_BY_ID.get(comboId);
    if (!combo) {
      unknown.push(comboId);
      continue;
    }
    if (isBlocked(combo, dead)) continue;
    pairs.push({ combo, rawWeight });
  }

  if (unknown.length > 0) {
    return rangeFailure(RangeErrorCode.RANGE_UNKNOWN_COMBO, {
      comboIds: unknown.slice(0, 5).join(','),
      unknownCount: unknown.length,
    });
  }

  if (pairs.length === 0) {
    return rangeFailure(RangeErrorCode.RANGE_COLLAPSE, {
      reason: '移除死牌后没有任何合法组合',
      deadCardCount: dead.size,
    });
  }

  // 确定性顺序：按 canonicalId 排序，使同一范围在缓存与日志里总是同一序列
  pairs.sort((a, b) => (a.combo.canonicalId < b.combo.canonicalId ? -1 : 1));

  const normalized = normalizeWeights(
    pairs.map((p) => ({ comboId: p.combo.canonicalId, rawWeight: p.rawWeight })),
  );
  if (!normalized.ok) return normalized;

  const entries: RangeEntry[] = pairs.map((pair, index) => ({
    combo: pair.combo,
    rawWeight: pair.rawWeight,
    probability: normalized.value.probabilities[index]!,
    source,
    confidence: options.provenance.confidence,
    ...(tags ? { tags } : {}),
  }));

  return {
    ok: true,
    value: freezeRange({
      rangeId: nextRangeId(options.rangeIdPrefix),
      previousRangeId: options.previousRangeId ?? null,
      state: RangeState.NORMALIZED,
      entries,
      provenance: options.provenance,
      metrics: buildMetrics(entries),
    }),
  };
}

/**
 * 从「起手牌类别 → 原始权重」构建范围。
 *
 * 这是最常见的数据输入方式（范围表通常按 169 类给出），
 * 内部展开成 exact combos 后走同一条构建路径。
 */
export function buildRangeFromRankClasses(
  classWeights: RankClassWeights,
  options: BuildRangeOptions,
): RangeOutcome<Range> {
  assertValidProvenance(options.provenance);

  const dead = resolveDeadCards(options.deadCards);
  const source = options.source ?? options.provenance.sourceType;
  const tags = options.tags;

  const pairs: Array<{ combo: ExactCombo; rawWeight: number }> = [];
  const unknown: string[] = [];

  for (const [rankClass, rawWeight] of Object.entries(classWeights)) {
    const combos = expandRankClasses([rankClass]);
    if (combos.length === 0) {
      unknown.push(rankClass);
      continue;
    }
    for (const combo of combos) {
      if (isBlocked(combo, dead)) continue;
      pairs.push({ combo, rawWeight });
    }
  }

  if (unknown.length > 0) {
    return rangeFailure(RangeErrorCode.RANGE_UNKNOWN_COMBO, {
      comboIds: unknown.slice(0, 5).join(','),
      unknownCount: unknown.length,
    });
  }

  if (pairs.length === 0) {
    return rangeFailure(RangeErrorCode.RANGE_COLLAPSE, {
      reason: '移除死牌后没有任何合法组合',
      deadCardCount: dead.size,
    });
  }

  pairs.sort((a, b) => (a.combo.canonicalId < b.combo.canonicalId ? -1 : 1));

  const normalized = normalizeWeights(
    pairs.map((p) => ({ comboId: p.combo.canonicalId, rawWeight: p.rawWeight })),
  );
  if (!normalized.ok) return normalized;

  const entries: RangeEntry[] = pairs.map((pair, index) => ({
    combo: pair.combo,
    rawWeight: pair.rawWeight,
    probability: normalized.value.probabilities[index]!,
    source,
    confidence: options.provenance.confidence,
    ...(tags ? { tags } : {}),
  }));

  return {
    ok: true,
    value: freezeRange({
      rangeId: nextRangeId(options.rangeIdPrefix),
      previousRangeId: options.previousRangeId ?? null,
      state: RangeState.NORMALIZED,
      entries,
      provenance: options.provenance,
      metrics: buildMetrics(entries),
    }),
  };
}

/* ============================================================
 * 由条目直接重建（供更新流程与缓存使用）
 * ============================================================ */

/**
 * 从「组合 + 原始权重」条目列表冻结出一个 Range。
 *
 * 更新流程（rangeUpdate）用它把 posteriorRawWeight 变成新的不可变范围。
 */
export function freezeRangeFromPairs(
  pairs: ReadonlyArray<{ combo: ExactCombo; rawWeight: number }>,
  provenance: RangeProvenance,
  options: {
    rangeIdPrefix?: string;
    previousRangeId?: string | null;
    source?: RangeSource;
    tags?: readonly string[];
  } = {},
): RangeOutcome<Range> {
  assertValidProvenance(provenance);

  if (pairs.length === 0) {
    return rangeFailure(RangeErrorCode.RANGE_COLLAPSE, { reason: '条目数为 0' });
  }

  const normalized = normalizeWeights(
    pairs.map((p) => ({ comboId: p.combo.canonicalId, rawWeight: p.rawWeight })),
  );
  if (!normalized.ok) return normalized;

  const source = options.source ?? provenance.sourceType;
  const entries: RangeEntry[] = pairs.map((pair, index) => ({
    combo: pair.combo,
    rawWeight: pair.rawWeight,
    probability: normalized.value.probabilities[index]!,
    source,
    confidence: provenance.confidence,
    ...(options.tags ? { tags: options.tags } : {}),
  }));

  return {
    ok: true,
    value: freezeRange({
      rangeId: nextRangeId(options.rangeIdPrefix),
      previousRangeId: options.previousRangeId ?? null,
      state: RangeState.NORMALIZED,
      entries,
      provenance,
      metrics: buildMetrics(entries),
    }),
  };
}

/* ============================================================
 * 冻结与度量
 * ============================================================ */

/**
 * 把范围冻结成不可变对象（规范第四十一节）。
 *
 * ⚠️ **必须逐条冻结 entry 对象本身**，不能只冻结 entries 数组。
 * `Object.freeze(array)` 只阻止「增删改数组下标」，
 * **不会**阻止 `array[0].probability = 0.99` —— 元素对象仍然可变。
 * 这是本项目实际踩到的坑：缓存命中后调用者可以原地改掉概率，
 * 从而污染后续所有使用该缓存的手牌。
 */
export function freezeRange(range: Omit<Range, 'indexById'>): Range {
  const lookup = new Map<string, number>();
  for (let i = 0; i < range.entries.length; i++) {
    lookup.set(range.entries[i]!.combo.canonicalId, i);
  }
  // 只读视图：不暴露 set/clear/delete，运行时无可用的写入口。
  // （ReadonlyMap 只是编译期约束，运行时仍可 .set —— 红队审计已证实。）
  const indexById: ReadOnlyIndex = Object.freeze({
    get: (key: string) => lookup.get(key),
    has: (key: string) => lookup.has(key),
  });

  const frozenEntries = range.entries.map((entry) =>
    Object.freeze({ ...entry, tags: entry.tags ? Object.freeze([...entry.tags]) : undefined }),
  );

  const frozen: Range = {
    ...range,
    entries: Object.freeze(frozenEntries),
    provenance: Object.freeze({ ...range.provenance }),
    metrics: Object.freeze({ ...range.metrics }),
    indexById,
  };
  return Object.freeze(frozen);
}

export function buildMetrics(entries: readonly RangeEntry[]): RangeMetrics {
  const probabilities = entries.map((e) => e.probability);
  const base = probabilityMetrics(probabilities);

  let weightedConfidence = 0;
  let minConfidence = entries.length > 0 ? Number.POSITIVE_INFINITY : 0;
  for (const entry of entries) {
    weightedConfidence += entry.probability * entry.confidence;
    if (entry.confidence < minConfidence) minConfidence = entry.confidence;
  }

  return {
    supportSize: base.supportSize,
    totalEntries: base.totalEntries,
    effectiveComboCount: base.effectiveComboCount,
    entropyBits: base.entropyBits,
    normalizedEntropy: base.normalizedEntropy,
    probabilitySum: base.probabilitySum,
    weightedConfidence,
    minConfidence: Number.isFinite(minConfidence) ? minConfidence : 0,
    topProbability: base.topProbability,
  };
}

/* ============================================================
 * 查询辅助
 * ============================================================ */

/** 按组合 id 取条目 */
export function entryOf(range: Range, comboId: string): RangeEntry | undefined {
  const index = range.indexById.get(comboId);
  return index === undefined ? undefined : range.entries[index];
}

/** 按类别汇总概率（169 类视图，仅供显示层使用） */
export function probabilityByRankClass(range: Range): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of range.entries) {
    const key = entry.combo.rankClass;
    map.set(key, (map.get(key) ?? 0) + entry.probability);
  }
  return map;
}

/** 按类别汇总原始权重 */
export function rawWeightByRankClass(range: Range): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of range.entries) {
    const key = entry.combo.rankClass;
    map.set(key, (map.get(key) ?? 0) + entry.rawWeight);
  }
  return map;
}

/**
 * 全范围（未阻断的 1326 组合，权重相同）—— **兜底用**。
 *
 * 注意：它的 sourceType 由调用方传入的 provenance 决定。
 * 若用作「不知道对手范围」的兜底，调用方**必须**传 FALLBACK 来源，
 * 使下游置信度立刻反映「这不是可信数据」。
 */
export function uniformRange(
  provenance: RangeProvenance,
  deadCards?: readonly Card[] | DeadCardSet,
): RangeOutcome<Range> {
  const dead = resolveDeadCards(deadCards);
  const pairs = ALL_COMBOS.filter((combo) => !isBlocked(combo, dead)).map((combo) => ({
    combo,
    rawWeight: 1,
  }));
  return freezeRangeFromPairs(pairs, provenance, { rangeIdPrefix: 'uniform' });
}

export { RangeSource, RangeState };
