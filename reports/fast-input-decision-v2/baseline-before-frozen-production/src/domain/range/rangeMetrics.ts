/**
 * 范围度量与变更摘要（规范第二十八 / 二十九 / 三十 / 三十二节）
 *
 * 两条设计要点：
 *
 * 1. **不能只看组合数量**（规范第二十九节）
 *    100 个组合可能权重高度集中（实际只有 2~3 个组合有实质概率），也可能完全平均。
 *    因此同时给出 `effectiveComboCount = 1/Σ(p²)` 与香农熵。
 *
 * 2. **不保存 1326 条完整 diff**（规范第三十二节）
 *    每街每次动作都存全量 diff 会让日志迅速膨胀。
 *    默认只保存摘要：Top increases / Top decreases / support 变化 / 熵变化。
 *    完整 diff 由调用方在调试时按需生成。
 */

import type { Range } from './range.types.ts';
import type { RangeDiffEntry, RangeDiffSummary } from './range.types.ts';

/* ============================================================
 * 概率向量工具
 * ============================================================ */

/**
 * 把范围折叠成「comboId → probability」的稠密向量所需的条目集合。
 *
 * 说明：这里刻意用 Map 而不是 1326 长数组，因为范围通常是稀疏的
 * （合法组合往往只有几十到几百个），稀疏表示更省内存也更快。
 */
export function probabilityVector(range: Range): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of range.entries) map.set(entry.combo.canonicalId, entry.probability);
  return map;
}

/* ============================================================
 * 分布比较
 * ============================================================ */

/**
 * 两个概率分布的 KL 散度 D(a ‖ b)，单位 bit。
 *
 * 用途：衡量「一次动作把范围改变了多少」。
 * 约定：a_i > 0 而 b_i = 0 时返回 Infinity（该结果不可能出现在 b 中）。
 */
export function klDivergence(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): number {
  let divergence = 0;
  for (const [comboId, pa] of a) {
    if (pa <= 0) continue;
    const pb = b.get(comboId) ?? 0;
    if (pb <= 0) return Number.POSITIVE_INFINITY;
    divergence += pa * Math.log2(pa / pb);
  }
  return divergence;
}

/**
 * 两次范围之间的「范围收窄程度」，0..1。
 *
 * 定义为相对熵的归一化版本：0 表示完全没变，1 表示收到了单点分布。
 * 用 1 − exp(−D) 而不是直接 D，是为了让数值落在人类可读的 0..1 区间。
 */
export function narrowingRatio(before: Range, after: Range): number {
  const a = probabilityVector(before);
  const b = probabilityVector(after);
  const d = klDivergence(a, b);
  if (!Number.isFinite(d)) return 1;
  return 1 - Math.exp(-Math.max(0, d));
}

/* ============================================================
 * 变更摘要
 * ============================================================ */

export type RemovalBreakdown = {
  byDeadCards: number;
  byZeroLikelihood: number;
};

/**
 * 计算两次范围的变更摘要。
 *
 * @param removal 移除原因的分类计数。默认全 0 —— 本函数**无法从两个范围本身**
 *   推断组合是「被死牌移除」还是「被零似然移除」，因此必须由调用方（更新流程）传入。
 *   旧版让本函数自己猜，结果把「似然为 0」误算成 `removedByBlockers`（红队 MAJOR-2）。
 */
export function diffRanges(
  before: Range,
  after: Range,
  topN = 5,
  removal: RemovalBreakdown = { byDeadCards: 0, byZeroLikelihood: 0 },
): RangeDiffSummary {
  const beforeMap = probabilityVector(before);
  const afterMap = probabilityVector(after);

  const allIds = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);
  const entries: RangeDiffEntry[] = [];

  for (const comboId of allIds) {
    const beforeProbability = beforeMap.get(comboId) ?? 0;
    const afterProbability = afterMap.get(comboId) ?? 0;
    if (beforeProbability === afterProbability) continue;
    entries.push({
      comboId,
      rankClass: rankClassOf(before, after, comboId),
      beforeProbability,
      afterProbability,
      delta: afterProbability - beforeProbability,
    });
  }

  const increases = entries
    .filter((e) => e.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, topN);
  const decreases = entries
    .filter((e) => e.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, topN);

  return {
    topIncreases: increases,
    topDecreases: decreases,
    removedByBlockers: removal.byDeadCards,
    removedByZeroLikelihood: removal.byZeroLikelihood,
    removedTotal: removal.byDeadCards + removal.byZeroLikelihood,
    supportSizeBefore: before.metrics.supportSize,
    supportSizeAfter: after.metrics.supportSize,
    entropyBefore: before.metrics.entropyBits,
    entropyAfter: after.metrics.entropyBits,
  };
}

/**
 * 取组合的类别名。
 *
 * 只在 `after` 里查就够 —— `diffRanges` 的调用方都是
 * 「先验 → 后验」的更新方向，因此消失的组合仍会在后验的 entries 里
 * （后验保留了全部条目，只是概率可能为 0）。
 * 旧版还去 `before` 里找，但索引方向写反，恒返回空字符串。
 */
function rankClassOf(after: Range, _before: Range, comboId: string): string {
  const index = after.indexById.get(comboId);
  return index === undefined ? '' : (after.entries[index]?.combo.rankClass ?? '');
}

/* ============================================================
 * 牌力密度（需要公共牌）
 * ============================================================ */

/**
 * 牌力密度指标（规范第二十八节）。
 *
 * **只在公共牌存在时才有意义** —— 翻牌前没有公共牌，无法谈「顶对以上密度」。
 * 因此这些指标由 rangeMetrics 的调用方在 flop/turn/river 上按需计算，
 * 不放进 Range 核心对象（核心对象必须在任何街道都成立）。
 */
export type HandClassDensity = {
  /** 参与统计的概率总量（应 ≈ 1） */
  coverage: number;
  /** 顶对及以上（含超对、两对、三条、顺子、同花、葫芦、四条、同花顺） */
  topPairPlus: number;
  /** 两对及以上 */
  twoPairPlus: number;
  /** 三条及以上（含暗三条） */
  setPlus: number;
  /** 坚果级（同花顺 / 四条 / 葫芦 / 顶三条） */
  nutDensity: number;
};

/**
 * 由「组合 → 牌力分类」的映射聚合出密度。
 *
 * 本函数**不自己判断牌力** —— 牌力判断属于 V1 已冻结的 handEval 引擎。
 * 调用方（postflop 范围分析）负责把每个组合分类好再传进来，
 * 这样职责边界清晰，也避免范围引擎重复实现牌力规则。
 */
export function densityFromCategories(
  range: Range,
  categoryOf: (comboId: string) => 'AIR' | 'WEAK' | 'TOP_PAIR' | 'TWO_PAIR' | 'SET' | 'NUT',
): HandClassDensity {
  const buckets = { AIR: 0, WEAK: 0, TOP_PAIR: 0, TWO_PAIR: 0, SET: 0, NUT: 0 };
  let coverage = 0;

  for (const entry of range.entries) {
    const category = categoryOf(entry.combo.canonicalId);
    if (!(category in buckets)) continue;
    buckets[category] += entry.probability;
    coverage += entry.probability;
  }

  return {
    coverage,
    topPairPlus: buckets.TOP_PAIR + buckets.TWO_PAIR + buckets.SET + buckets.NUT,
    twoPairPlus: buckets.TWO_PAIR + buckets.SET + buckets.NUT,
    setPlus: buckets.SET + buckets.NUT,
    nutDensity: buckets.NUT,
  };
}

/* ============================================================
 * 人类可读摘要
 * ============================================================ */

/** 把范围度量渲染成一行中文摘要（供 CLI / 日志使用） */
export function describeRangeMetrics(metrics: Range['metrics']): string {
  return (
    `有效组合 ${metrics.supportSize}（参与 ${metrics.totalEntries}）｜` +
    `有效组合数 ${metrics.effectiveComboCount.toFixed(1)}｜` +
    `熵 ${metrics.entropyBits.toFixed(2)} bit（归一化 ${(metrics.normalizedEntropy * 100).toFixed(1)}%）｜` +
    `主导概率 ${(metrics.topProbability * 100).toFixed(1)}%｜` +
    `加权可信度 ${(metrics.weightedConfidence * 100).toFixed(0)}%`
  );
}

/** 把变更摘要渲染成中文多行（供 CLI / 复盘使用） */
export function describeDiffSummary(summary: RangeDiffSummary): string[] {
  const lines: string[] = [];
  lines.push(
    `有效组合：${summary.supportSizeBefore} → ${summary.supportSizeAfter}（移除 ${summary.removedByBlockers}）`,
  );
  lines.push(
    `熵：${summary.entropyBefore.toFixed(3)} → ${summary.entropyAfter.toFixed(3)} bit`,
  );
  if (summary.topIncreases.length > 0) {
    lines.push(
      '概率上升最多：' +
        summary.topIncreases
          .map((e) => `${e.comboId} ${(e.beforeProbability * 100).toFixed(2)}%→${(e.afterProbability * 100).toFixed(2)}%`)
          .join('，'),
    );
  }
  if (summary.topDecreases.length > 0) {
    lines.push(
      '概率下降最多：' +
        summary.topDecreases
          .map((e) => `${e.comboId} ${(e.beforeProbability * 100).toFixed(2)}%→${(e.afterProbability * 100).toFixed(2)}%`)
          .join('，'),
    );
  }
  return lines;
}
