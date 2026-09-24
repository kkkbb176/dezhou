/**
 * 动态行为 —— 窗口统计（Step 7）
 *
 * ## 本模块负责
 *
 * 1. **事件规范化**：排序、去重（幂等）、过滤未来事件、校验非法数值
 * 2. **机会感知的窗口统计**：分母来自真实的 opportunity，**不是手数**
 * 3. **样本保护**：复用 Step 6 的时间衰减 + 单手影响上限 + Beta-Binomial 收缩
 *
 * ## 三条不可违背的纪律
 *
 * ### 1. 手数不是统计分母（规范第 11 / 12 节）
 *
 * 一个玩家最近 20 手可能只有 3 次 3Bet 机会。
 * 因此窗口统计一律按 `opportunities` 计算，`hands` 只用于确定窗口边界。
 *
 * ### 2. 机会必须来自牌局状态（沿用 Step 6 的核心纪律）
 *
 * 调用方在每条事件上记录「本手他有哪些机会」，
 * 而不是「他做了什么」。否则**从不 3Bet 的玩家永远不会进入 3Bet 的分母**，
 * 他的「变紧」就完全无法被察觉。
 *
 * ### 3. Fail Closed（规范第 21 节）
 *
 * 非法数值（NaN / Infinity / 负机会数 / successes > opportunities / 越界 confidence）
 * **必须被拒绝**，不得静默修正成一个「看起来合理」的值。
 */

import { PlayerMetric } from '../player/player.types.ts';
import { capSingleHandWeight, effectiveSampleSize } from '../player/playerStats.ts';

import {
  DynamicErrorCode,
  MAX_SINGLE_EVENT_SHARE,
  METRIC_GROUP,
  MILD_SHRINKAGE_RATIO,
  MIN_BASELINE_OPPORTUNITIES,
  MIN_RECENT_OPPORTUNITIES,
  RECENT_HALF_LIFE_HANDS,
  SUFFICIENT_RECENT_OPPORTUNITIES,
  WindowSize,
  dynamicFailure,
  type BaselineMetricStat,
  type DynamicOutcome,
  type ObservedPokerEvent,
  type PlayerProfileSnapshot,
  type RecentBehaviorStat,
  type RecentWindow,
} from './dynamic.types.ts';

/* ============================================================
 * 一、校验
 * ============================================================ */

/** 指标统计的数值合法性（Fail Closed） */
export function validateStatNumbers(
  subject: string,
  successes: number,
  opportunities: number,
  confidence: number,
): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(successes)) problems.push(`${subject}: successes 不是有限数（${successes}）`);
  if (!Number.isFinite(opportunities)) problems.push(`${subject}: opportunities 不是有限数（${opportunities}）`);
  if (!Number.isFinite(confidence)) problems.push(`${subject}: confidence 不是有限数（${confidence}）`);
  if (opportunities < 0) problems.push(`${subject}: opportunities 为负（${opportunities}）`);
  if (successes < 0) problems.push(`${subject}: successes 为负（${successes}）`);
  if (successes > opportunities) {
    problems.push(`${subject}: successes(${successes}) > opportunities(${opportunities})`);
  }
  if (confidence < 0 || confidence > 1) {
    problems.push(`${subject}: confidence 越界（${confidence}）`);
  }
  return problems;
}

/** 校验基线里每一项指标的数值 */
export function validateBaseline(baseline: PlayerProfileSnapshot): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(baseline.handsObserved) || baseline.handsObserved < 0) {
    problems.push(`baseline.handsObserved 非法（${baseline.handsObserved}）`);
  }
  for (const [metric, stat] of Object.entries(baseline.metrics)) {
    if (!stat) continue;
    problems.push(
      ...validateStatNumbers(
        `baseline.${metric}`,
        stat.successes,
        stat.opportunities,
        stat.confidence,
      ),
    );
    if (stat.adjustedRate !== null && (!Number.isFinite(stat.adjustedRate) || stat.adjustedRate < 0 || stat.adjustedRate > 1)) {
      problems.push(`baseline.${metric}.adjustedRate 越界（${stat.adjustedRate}）`);
    }
  }
  return problems;
}

/** 校验一条事件的基本结构 */
export function validateEvent(event: ObservedPokerEvent): string[] {
  const problems: string[] = [];
  if (event === null || typeof event !== 'object') return ['事件不是对象'];
  if (typeof event.eventId !== 'string' || event.eventId.trim().length === 0) {
    problems.push('eventId 为空或不是字符串');
  }
  if (typeof event.handId !== 'string' || event.handId.trim().length === 0) {
    problems.push('handId 为空或不是字符串');
  }
  if (!Number.isInteger(event.seq) || event.seq < 0) problems.push(`seq 非法（${event.seq}）`);
  if (typeof event.timestamp !== 'string' || Number.isNaN(Date.parse(event.timestamp))) {
    problems.push(`timestamp 无法解析（${event.timestamp}）`);
  }
  if (event.playerId !== undefined && typeof event.playerId !== 'string') {
    problems.push('playerId 不是字符串');
  }

  // ---- opportunities 必须是数组，且每一项结构合法（独立红队 F8）----
  //
  // 修复前：`{}` / `42` / `[null]` 会直接抛 `TypeError`（**不是** Fail Closed），
  // `[{}]` 会产生 `undefined:0/1` 这样的统计项，
  // `metric: 'NOT_A_METRIC'` / `null` 被当成正常指标进入 stats 与门槛判断，
  // `success: 'yes'` / `1` 与 `true` 等效，`success` 缺失被视为失败。
  // 这些都会让「非法输入」伪装成合法结论。
  if (!Array.isArray(event.opportunities)) {
    problems.push('opportunities 不是数组');
    return problems;
  }
  const seen = new Set<PlayerMetric>();
  for (const [index, item] of event.opportunities.entries()) {
    if (item === null || typeof item !== 'object') {
      problems.push(`opportunities[${index}] 不是对象`);
      continue;
    }
    if (!isKnownMetric(item.metric)) {
      problems.push(`opportunities[${index}].metric 不是已登记的指标（${String(item.metric)}）`);
      continue;
    }
    if (typeof item.success !== 'boolean') {
      problems.push(
        `opportunities[${index}].success 必须是布尔（收到 ${typeof item.success}：${String(item.success)}）`,
      );
    }
    if (seen.has(item.metric)) problems.push(`同一事件内重复指标（${item.metric}）`);
    seen.add(item.metric);
  }

  // ---- 可选字段：类型错就当结构非法（不让它们静默丢弃整条事件）----
  //
  // ⚠️ 尺寸字段**不参与**任何指标的偏差计算（独立红队 F5：SIZING 组目前无指标映射）。
  // 因此一个非法的 `betSizePotRatio` 或 `isOverbet` **不应该**让整条事件的
  // 行为机会全部作废 —— 修复前 `betSizePotRatio = -1` 会让 8 条事件
  // 全部丢弃、状态从 `LOOSER_RECENTLY 26 分` 变成 `UNKNOWN 0 分 无调整`。
  // 现在这类字段由 `sanitizeEvent` 剥离（降级为「未提供」），
  // 行为机会照常参与统计。
  return problems;
}

/** metric 是否是一个已登记的指标（防止 `'NOT_A_METRIC'` / `null` 混入统计） */
function isKnownMetric(metric: unknown): metric is PlayerMetric {
  return typeof metric === 'string' && Object.prototype.hasOwnProperty.call(METRIC_GROUP, metric);
}

/**
 * 剥离非法的**可选展示字段**，保留事件的行为机会（独立红队 F10）。
 *
 * 与「拒绝整条事件」的区别：
 * - `betSizePotRatio` / `isOverbet` / `isAllIn` 目前**不参与**偏差计算
 *   （`SIZING` 组尚无指标映射），因此它们的类型错误只应降级为「未提供」，
 *   不该让同一手牌的 VPIP / PFR 机会一起作废。
 * - 返回被剥离的字段名，供调用方记录（**不静默**）。
 */
export function sanitizeEvent(event: ObservedPokerEvent): {
  event: ObservedPokerEvent;
  droppedFields: readonly string[];
} {
  const dropped: string[] = [];
  const ratio = event.betSizePotRatio as unknown;
  const badRatio =
    ratio !== undefined && (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0);
  const badFlags: string[] = [];
  for (const flag of ['isOverbet', 'isAllIn'] as const) {
    const value = event[flag] as unknown;
    if (value !== undefined && typeof value !== 'boolean') badFlags.push(flag);
  }
  if (!badRatio && badFlags.length === 0) return { event, droppedFields: [] };

  if (badRatio) dropped.push('betSizePotRatio');
  dropped.push(...badFlags);
  const copy: Record<string, unknown> = { ...event };
  delete copy.betSizePotRatio;
  for (const flag of badFlags) delete copy[flag];
  return { event: copy as unknown as ObservedPokerEvent, droppedFields: dropped };
}

/* ============================================================
 * 二、规范化（排序 / 去重 / 未来过滤）
 * ============================================================ */

export type NormalizeResult = {
  /** 参与计算的事件（按 timestamp → seq → eventId 稳定排序） */
  ordered: readonly ObservedPokerEvent[];
  /** 被忽略的事件及原因 */
  ignored: readonly { eventId: string; reason: string }[];
  /** 是否存在无法排序的冲突 */
  orderingConflicts: number;
};

/**
 * 两条事件的内容是否完全相同（用于区分「真正的重复」与「eventId 冲突」）。
 *
 * 比较影响计算的全部字段：handId / seq / timestamp / opportunities。
 * 可选展示字段（尺寸）不参与 —— 它们已被 `sanitizeEvent` 处理过。
 */
function sameEventContent(a: ObservedPokerEvent, b: ObservedPokerEvent): boolean {
  return canonicalEventKey(a) === canonicalEventKey(b);
}

function canonicalEventKey(event: ObservedPokerEvent): string {
  const opportunities = [...event.opportunities]
    .map((o) => `${o.metric}:${o.success ? 1 : 0}`)
    .sort()
    .join(',');
  return `${event.handId}|${event.seq}|${event.timestamp}|${opportunities}`;
}

/**
 * 在两条 eventId 相同的事件中**确定性地**选一条（独立红队 F14）。
 *
 * 规则：时间戳最早 → seq 最小 → 规范键字典序最小。
 * 与输入顺序完全无关，因此 `[a, b]` 与 `[b, a]` 结果逐位一致。
 */
function pickDeterministicDuplicate(
  a: ObservedPokerEvent,
  b: ObservedPokerEvent,
): ObservedPokerEvent {
  const ta = Date.parse(a.timestamp);
  const tb = Date.parse(b.timestamp);
  if (ta !== tb) return ta < tb ? a : b;
  if (a.seq !== b.seq) return a.seq < b.seq ? a : b;
  const ka = canonicalEventKey(a);
  const kb = canonicalEventKey(b);
  return ka <= kb ? a : b;
}

/**
 * 规范化事件序列。
 *
 * ## 幂等（规范第 7 / 59 节）
 *
 * 同一个 `eventId` 只保留**第一次**出现，重复的被忽略并记录原因。
 * 因此 `process(events)` 与 `process(events + duplicates)` 结果逐位一致。
 *
 * ## 未来事件（规范第 65 节）
 *
 * `timestamp > asOf` 的事件**不得进入计算**。
 *
 * ## 排序（规范第 64 节）
 *
 * 按 `timestamp → seq → eventId` 排序，因此结果**不依赖输入数组顺序**。
 * 排序键里带 `eventId` 是为了让「同一时间戳且同 seq」也有确定顺序 ——
 * 否则结果会依赖 V8 的排序稳定性，属于隐性不确定性。
 */
export function normalizeEvents(
  events: readonly ObservedPokerEvent[],
  asOf: number,
): NormalizeResult {
  const ignored: { eventId: string; reason: string }[] = [];
  const byId = new Map<string, ObservedPokerEvent>();

  for (const event of events) {
    if (event === null || typeof event !== 'object') {
      ignored.push({ eventId: '<非对象>', reason: '结构非法：事件不是对象' });
      continue;
    }
    const problems = validateEvent(event);
    if (problems.length > 0) {
      ignored.push({ eventId: event.eventId ?? '<无 id>', reason: `结构非法：${problems.join('；')}` });
      continue;
    }
    // 剥离非法可选字段（保留行为机会），并**记录**剥离动作，不静默
    const { event: clean, droppedFields } = sanitizeEvent(event);
    if (droppedFields.length > 0) {
      ignored.push({
        eventId: event.eventId,
        reason: `已忽略非法字段（${droppedFields.join(' / ')}）—— 该事件的行为机会仍然参与统计`,
      });
    }
    // ---- 重复 eventId 的确定性解析（独立红队 F14）----
    //
    // 修复前保留「第一条出现的」，于是**内容不同**的重复 eventId 会让结果
    // 依赖输入数组顺序：`[a, b]` 与 `[b, a]` 得到不同的窗口统计，
    // 与「结果不依赖输入顺序」的承诺直接冲突。
    //
    // 现在按内容选出**确定性的那一条**：时间戳最早 → seq 最小 →
    // 序列化后字典序最小。与输入顺序完全无关，且冲突被明确记录。
    const existing = byId.get(clean.eventId);
    if (existing !== undefined) {
      const winner = pickDeterministicDuplicate(existing, clean);
      const loser = winner === existing ? clean : existing;
      if (!sameEventContent(existing, clean)) {
        ignored.push({
          eventId: clean.eventId,
          reason:
            '重复 eventId 但内容不同 —— 已按确定性规则保留一条（时间戳最早 → seq 最小 → 内容字典序），' +
            `被丢弃的那条 handId=${loser.handId}`,
        });
      } else {
        ignored.push({ eventId: clean.eventId, reason: '重复事件（幂等保护）' });
      }
      byId.set(clean.eventId, winner);
      continue;
    }
    const time = Date.parse(clean.timestamp);
    if (time > asOf) {
      ignored.push({ eventId: clean.eventId, reason: `未来事件（timestamp ${clean.timestamp} > asOf）` });
      continue;
    }
    byId.set(clean.eventId, clean);
  }

  // ⚠️ 独立红队 F12：排序前**预解析**时间戳。
  //
  // 修复前比较器内每次比较调用两次 `Date.parse` —— 5000 条事件的排序
  // 耗时 3.568ms，而预解析后只要 0.355ms（**10 倍**），
  // 且它占 5000 条 P50 的约 18%。比较器是 O(n log n) 次调用的热路径。
  const withTime = [...byId.values()].map((event) => ({
    event,
    time: Date.parse(event.timestamp),
  }));

  withTime.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    if (a.event.seq !== b.event.seq) return a.event.seq - b.event.seq;
    // 排序键里带 `eventId` 是为了让「同一时间戳且同 seq」也有确定顺序 ——
    // 否则结果会依赖 V8 的排序稳定性，属于隐性不确定性
    return a.event.eventId < b.event.eventId ? -1 : a.event.eventId > b.event.eventId ? 1 : 0;
  });
  const ordered = withTime.map((entry) => entry.event);

  // 「同一手牌内 seq 冲突」属于可检测的排序异常：
  // 同一 handId 出现两条 seq 相同但 eventId 不同的事件
  let orderingConflicts = 0;
  const seenHandSeq = new Set<string>();
  for (const event of ordered) {
    const key = `${event.handId}#${event.seq}`;
    if (seenHandSeq.has(key)) orderingConflicts++;
    seenHandSeq.add(key);
  }

  return { ordered: Object.freeze(ordered), ignored: Object.freeze(ignored), orderingConflicts };
}

/* ============================================================
 * 三、窗口统计
 * ============================================================ */

/**
 * 取「最近 N 手」的事件。
 *
 * 窗口边界由**不同的 handId 数量**决定，而不是事件条数 ——
 * 一个玩家一手牌可能产生多条事件。
 */
export function takeWindow(
  ordered: readonly ObservedPokerEvent[],
  size: WindowSize,
): readonly ObservedPokerEvent[] {
  const hands: string[] = [];
  const seen = new Set<string>();
  // 从最新往旧数，凑满 size 手为止
  for (let i = ordered.length - 1; i >= 0; i--) {
    const handId = ordered[i]!.handId;
    if (!seen.has(handId)) {
      if (hands.length >= size) break;
      seen.add(handId);
      hands.push(handId);
    }
  }
  const inWindow = new Set(hands);
  return Object.freeze(ordered.filter((e) => inWindow.has(e.handId)));
}

/**
 * 计算窗口内每项指标的统计。
 *
 * ## 分母来自机会，不是手数
 *
 * `opportunities` = 该窗口内**声明过该指标机会**的观测次数。
 * 与玩家做了多少次动作无关 —— 这正是「机会由牌局状态定义」的落地。
 *
 * ## 样本保护（复用 Step 6 机制，不重复实现）
 *
 * - 时间衰减：`2^(-age/halfLife)`，半衰期 30 手（近期权重略高，但**有界**）
 * - 单手影响上限：`capSingleHandWeight`（防止一手推翻全部）
 * - 收缩：向**基线**收缩，而不是向人口先验收缩 ——
 *   Dynamic 不重建人口基线（规范第 10 节）
 */
export function computeWindowStats(
  windowEvents: readonly ObservedPokerEvent[],
  maxSeq: number,
  baseline: PlayerProfileSnapshot,
): {
  stats: RecentBehaviorStat[];
  deviations: string[];
} {
  const deviations: string[] = [];

  /** metric → 每次机会的观测（weight / success） */
  const perMetric = new Map<PlayerMetric, { weights: number[]; successes: boolean[] }>();

  for (const event of windowEvents) {
    const age = Math.max(0, maxSeq - event.seq);
    const weight = Math.pow(2, -age / RECENT_HALF_LIFE_HANDS);
    for (const observation of event.opportunities) {
      const bucket = perMetric.get(observation.metric) ?? { weights: [], successes: [] };
      bucket.weights.push(weight);
      bucket.successes.push(observation.success);
      perMetric.set(observation.metric, bucket);
    }
  }

  const stats: RecentBehaviorStat[] = [];
  for (const [metric, bucket] of perMetric) {
    const opportunities = bucket.weights.length;
    const successes = bucket.successes.filter(Boolean).length;

    const problems = validateStatNumbers(`recent.${metric}`, successes, opportunities, 0.5);
    // 只保留与计数相关的检查（confidence 尚未计算）
    const countProblems = problems.filter((p) => !p.includes('confidence'));
    if (countProblems.length > 0) {
      deviations.push(...countProblems);
      continue;
    }

    // ---- 单手影响上限 ----
    //
    // ⚠️ 独立红队 F11：这里原先用 `DEFAULT_DECAY.maxSingleHandShare`，
    // 而 Dynamic 自己在 `dynamic.types.ts` 声明的 `MAX_SINGLE_EVENT_SHARE`
    // 只被 import 后原样 re-export —— **改它不会改变任何输出**（死常量）。
    // 现在以 `MAX_SINGLE_EVENT_SHARE` 为唯一权威，它真正控制单手影响上限。
    const capped = capSingleHandWeight(bucket.weights, MAX_SINGLE_EVENT_SHARE);
    const effectiveSample = effectiveSampleSize(capped);
    const cappedSum = capped.reduce((s, w) => s + w, 0);

    let weightedSuccesses = 0;
    for (let i = 0; i < opportunities; i++) {
      if (bucket.successes[i]) weightedSuccesses += capped[i] ?? 0;
    }

    const rawRate = opportunities > 0 ? successes / opportunities : null;
    const baselineStat = baseline.metrics[metric] ?? null;
    const baselineRate = baselineStat?.adjustedRate ?? null;

    // ---- 向**基线**收缩（不是向人口先验）----
    //
    // ```
    // adjustedRate = (Σ 近期权重·命中 + k·基线率) / (Σ 近期权重 + k)
    // k = MILD_SHRINKAGE_RATIO × c × 基线质量      （c = 该指标近期机会数）
    // ```
    //
    // ## 为什么是**温和**收缩（独立红队第二轮 F4 的教学）
    //
    // 收缩在这里有两个互相拉扯的目标：
    // 1. **抑制噪声**：样本少时不要把随机波动当成真实变化
    // 2. **不掩盖真实变化**：一个真的从 15% 变成 45% 的玩家必须看得出来
    //
    // 红队实测了三种强度在「真值 = 基线」数据上的表现：
    //
    // | 收缩强度 | 误报率 | 真实变化（VPIP 15%→45%，20 手） |
    // |---|---|---|
    // | `k = c`（等权） | 12~36% | 检出，41 分 ✅ |
    // | `k = 2c`（基线权重 2 倍） | 7% | **被压到 12 分** ❌ |
    //
    // 上表说明：**靠收缩压制误报是错的方向** —— 压制噪声和压制真实变化
    // 是同一条曲线。正确的分工是：
    // - **收缩**只负责温和地抑制极端值（`k = c/3`，基线约占 25% 权重）
    // - **显著性检验**负责区分噪声与真实变化（见 `metricDeviation`）
    //
    // 误报率从 36.5% 降到 7.0% 是**显著性检验 + 方差边界修正**的功劳，
    // 不是收缩的功劳。
    const baselineQuality = baselineStat ? Math.max(0, Math.min(1, baselineStat.confidence)) : 0;
    const k = MILD_SHRINKAGE_RATIO * opportunities * baselineQuality;
    const adjustedRate =
      cappedSum + k > 0 && baselineRate !== null
        ? (weightedSuccesses + k * baselineRate) / (cappedSum + k)
        : rawRate;

    // ---- 近期置信度 ----
    //
    // 按**该项指标自身的机会数**做结构性映射：
    // `0 → 0`，`SUFFICIENT_RECENT_OPPORTUNITIES → 1`，线性。
    //
    // ⚠️ 独立红队 F2：**不要**再引入「超过判断门槛就从某个正值起步」
    // 之类的偏移。判断门槛（8）是「够不够格下结论」，
    // 不是「可信度从多少起步」；两者混用会让 8 次机会的单项指标
    // 拿着非零置信度参与状态判定。
    const recentConfidence = Math.max(
      0,
      Math.min(1, opportunities / SUFFICIENT_RECENT_OPPORTUNITIES),
    );

    const stat: RecentBehaviorStat = {
      metric,
      successes,
      opportunities,
      rawRate,
      adjustedRate,
      baselineRate,
      // 基线样本量：方向检验用它估计基线侧标准误（独立红队 F3）
      baselineOpportunities: baselineStat?.opportunities ?? null,
      deviation: adjustedRate !== null && baselineRate !== null ? adjustedRate - baselineRate : null,
      effectiveSample,
      confidence: Math.max(0, Math.min(1, recentConfidence)),
    };
    stats.push(stat);
  }

  stats.sort((a, b) => (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0));
  return { stats, deviations };
}

/** 构建全部三个窗口 */
export function buildWindows(
  ordered: readonly ObservedPokerEvent[],
  baseline: PlayerProfileSnapshot,
  sizes: readonly WindowSize[],
): { windows: RecentWindow[]; deviations: string[] } {
  const maxSeq = ordered.reduce((max, e) => (e.seq > max ? e.seq : max), 0);
  const windows: RecentWindow[] = [];
  const deviations: string[] = [];

  for (const size of sizes) {
    const windowEvents = takeWindow(ordered, size);
    const hands = new Set(windowEvents.map((e) => e.handId)).size;
    const { stats, deviations: statProblems } = computeWindowStats(windowEvents, maxSeq, baseline);
    deviations.push(...statProblems);
    windows.push({
      size,
      hands,
      eventIds: Object.freeze(windowEvents.map((e) => e.eventId)),
      stats: Object.freeze(stats),
    });
  }

  return { windows, deviations };
}

/* ============================================================
 * 四、便捷查询
 * ============================================================ */

export function statOf(window: RecentWindow, metric: PlayerMetric): RecentBehaviorStat | undefined {
  return window.stats.find((s) => s.metric === metric);
}

/**
 * 统计每项指标在**全部**给定事件中的机会数。
 *
 * ## 为什么需要它
 *
 * 方向判定要做「观测率 vs 基线率」的统计检验，样本量必须是
 * **全部近期事件**中的机会数，而不是 20 手窗口内的计数 ——
 * 窗口只是取样本的位置，不改变样本量。用窗口计数会把方差估大，
 * 让明显的变化被判成「无方向」（红队实测：60 手数据、PFR 20%→5%
 * 被判成 NONE，进而漏掉一次真实的「变松且变被动」冲突）。
 *
 * 强度（`strength`）仍然只用窗口统计 —— 那才需要「只看最近」。
 */
export function countOpportunities(
  events: readonly ObservedPokerEvent[],
): ReadonlyMap<PlayerMetric, number> {
  const counts = new Map<PlayerMetric, number>();
  for (const event of events) {
    for (const observation of event.opportunities) {
      counts.set(observation.metric, (counts.get(observation.metric) ?? 0) + 1);
    }
  }
  return counts;
}

/** 窗口内全部指标的机会总数（用于样本充分性判定） */
export function totalOpportunities(window: RecentWindow): number {
  return window.stats.reduce((sum, s) => sum + s.opportunities, 0);
}

/** 基线是否足以用于比较（某项指标） */
export function baselineUsable(baseline: PlayerProfileSnapshot, metric: PlayerMetric): boolean {
  const stat: BaselineMetricStat | undefined = baseline.metrics[metric];
  if (!stat) return false;
  return (
    stat.opportunities >= MIN_BASELINE_OPPORTUNITIES &&
    stat.adjustedRate !== null &&
    stat.confidence > 0
  );
}

export { DynamicErrorCode, dynamicFailure, type DynamicOutcome };
