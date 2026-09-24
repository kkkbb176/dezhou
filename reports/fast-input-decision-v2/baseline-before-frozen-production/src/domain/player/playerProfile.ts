/**
 * 玩家画像引擎：事件驱动的增量统计（Step 6，规范第十一 / 十五 / 十七 / 十八节）
 *
 * ## 设计要点
 *
 * 1. **事件驱动 + 增量更新**
 *    每手牌产生若干「机会观测」，追加到该玩家的观测序列。
 *    绝不每次分析都重扫全部历史（规范第二十七节的要求同源）。
 *
 * 2. **重复 Hand 必须幂等**（规范第十七节）
 *    同一 handId 重复录入时必须被拒绝，否则统计会被重复计数。
 *
 * 3. **支持重建以修正历史**（规范第十八节）
 *    用户修改一手牌时，**不能**「旧统计留着 + 新统计再加一次」。
 *    因此保留事件日志，修正时移除旧事件并重放。
 *
 * 4. **每个指标独立样本量**（规范第十五节）
 *    500 手观赛 ≠ 河牌超池样本 500。每项指标各自累计自己机会。
 *
 * 5. **玩家之间物理隔离**
 *    每个玩家一份独立的观测序列，绝不共享可变对象（防跨玩家污染）。
 */

import {
  ALL_PLAYER_METRICS,
  METRIC_DEFINITIONS,
  type MetricStat,
  type PlayerMetric,
} from './player.types.ts';
import {
  DEFAULT_DECAY,
  computeMetricStat,
  type DecayOptions,
} from './playerStats.ts';

/* ============================================================
 * 事件
 * ============================================================ */

/** 一次「机会观测」：某项指标在某一手中出现过一次机会，以及是否成功 */
export type OpportunityObservation = {
  metric: PlayerMetric;
  success: boolean;
};

/**
 * 一手牌对某个玩家产生的全部观测。
 *
 * 一手牌对同一指标最多产生一次机会（避免「同一手内多次行动」被重复计数）。
 */
export type HandObservation = {
  handId: string;
  playerId: string;
  /** 该手牌在玩家历史中的序号（单调递增，用于时间衰减） */
  seq: number;
  /** 时间戳（ISO）；非法时间戳会被拒绝 */
  timestamp: string;
  observations: readonly OpportunityObservation[];
};

/* ============================================================
 * 画像对象
 * ============================================================ */

export type PlayerProfile = {
  playerId: string;
  /** 已纳入统计的手牌数 */
  handsObserved: number;
  /**
   * 已见过的最大序号。
   *
   * `recompute` 用「最大 seq 当作现在」计算每手的时间衰减 age，
   * 因此 seq 的**范围**直接决定全部历史权重（红队 CRITICAL-2）。
   * 单独保存是为了能在录入时**立刻**拒绝异常序号，
   * 而不是等统计已经错掉之后才发现。
   */
  maxSeq: number;
  /** 每项指标的统计 */
  metrics: Readonly<Record<PlayerMetric, MetricStat>>;
  /** 已处理的手牌 id 只读视图（幂等保护） */
  seenHandIds: ReadOnlyHandIdSet;
  /** 事件日志（用于重建与修正历史） */
  log: readonly HandObservation[];
  decay: DecayOptions;
  /** 画像数据版本（缓存与日志用） */
  version: string;
};

export const PROFILE_VERSION = '1.0.0';

/**
 * 允许的序号跳跃上限。
 *
 * 序号只用于**相对**时间衰减（age = maxSeq − seq），因此中间跳号本身无害 ——
 * 用户可能只录入了自己关心的那些牌局。但一次跳跃过大就会把
 * 全部已有历史推到「很久以前」，等效于**作废历史**。
 *
 * 红队实测：200 手 100% 入池的画像，插入一手 `seq = 500000` 后
 * `adjustedRate` 从 0.8870 掉到 0.2419（**低于先验中心 0.25**），
 * `n_eff` 198→1，而 `warnings = 0`。
 *
 * 1000 手足以覆盖「一段时间没打牌」的正常情况，同时挡住上述错误。
 */
export const SEQ_GAP_TOLERANCE = 1000;

export type ProfileIssue = {
  code:
    | 'DUPLICATE_HAND'
    | 'INVALID_TIMESTAMP'
    | 'OUT_OF_ORDER_SEQ'
    | 'SEQ_OUT_OF_RANGE'
    | 'UNKNOWN_METRIC'
    | 'NEGATIVE_COUNT'
    | 'PLAYER_MISMATCH'
    | 'UNKNOWN_PLAYER';
  params: Readonly<Record<string, string | number>>;
};

export type ProfileOutcome<T> =
  | { ok: true; value: T; warnings: ProfileIssue[] }
  | { ok: false; issues: ProfileIssue[] };

/* ============================================================
 * 构造
 * ============================================================ */

export function createProfile(
  playerId: string,
  options: { decay?: DecayOptions } = {},
): PlayerProfile {
  if (!playerId || playerId.trim().length === 0) {
    throw new Error('createProfile: playerId 不能为空');
  }
  // ⚠️ **必须拷贝**，不能按引用存入 `DEFAULT_DECAY`。
  // 红队发现：旧版直接按引用存入全局共享常量，而 `freezeProfile` 又漏冻结
  // `decay` 这一层，于是一行 `profile.decay.halfLife = 50` 会永久污染
  // **此后每一个新建画像**的衰减（实测 adjustedRate 从 0.3475 变 0.2481）。
  // 这与「prior 污染 METRIC_DEFINITIONS」是同一类缺陷。
  const decay = freezeDecay(options.decay ?? DEFAULT_DECAY);
  const metrics = {} as Record<PlayerMetric, MetricStat>;
  for (const metric of ALL_PLAYER_METRICS) {
    metrics[metric] = computeMetricStat(metric, [], { decay });
  }
  return freezeProfile({
    playerId,
    handsObserved: 0,
    maxSeq: 0,
    metrics,
    seenHandIds: new Set<string>(),
    log: [],
    decay,
    version: PROFILE_VERSION,
  });
}

/** 冻结衰减配置（先拷贝再冻结，绝不改动传入的共享常量） */
function freezeDecay(decay: DecayOptions): DecayOptions {
  return Object.freeze({ ...decay });
}

/**
 * 只读集合视图。
 *
 * 与 `range.types.ts` 的 `ReadOnlyIndex` 同一条教训：
 * `Object.freeze(new Set())` **不阻止** `.add()` / `.delete()` ——
 * 冻结只作用于对象自身的属性槽，而 Set 的内容在内部槽位里。
 * 因此这里不暴露 `Set`，只暴露 `has()` / `size` / 迭代。
 *
 * 红队发现：旧版把可变 `Set` 直接挂在画像上，`.delete('S0')` 之后
 * 同一 handId 会被**二次接受**，`handsObserved` 3→4、日志里 handId 出现两次。
 */
export type ReadOnlyHandIdSet = {
  has(handId: string): boolean;
  readonly size: number;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<string>;
};

function toReadOnlyHandIds(handIds: ReadonlySet<string>): ReadOnlyHandIdSet {
  return Object.freeze({
    has: (handId: string) => handIds.has(handId),
    size: handIds.size,
    values: () => handIds.values(),
    [Symbol.iterator]: () => handIds.values(),
  });
}

/**
 * 深冻结一手观测（含 observations 数组与其中每个元素）。
 *
 * 教训与范围引擎的 CRITICAL-1 完全同源：`Object.freeze(数组)` **不冻结元素**。
 * 若只冻结 `log` 数组，一行 `profile.log[0].seq = 999` 就会
 * 把历史序号改掉，而下游的时间衰减完全依赖 seq ——
 * 统计会**无声地**偏移，且 `Object.isFrozen(profile)` 仍然返回 true。
 */
function freezeHandObservation(hand: HandObservation): HandObservation {
  const observations = hand.observations.map((o) => Object.freeze({ ...o }));
  return Object.freeze({ ...hand, observations: Object.freeze(observations) });
}

/**
 * 深冻结画像。
 *
 * ## 冻结清单（表驱动测试逐项断言，见 `test/playerRedTeam.test.ts`）
 *
 * | 层 | 说明 |
 * |---|---|
 * | `profile` 本体 | 所有顶层字段 |
 * | `metrics` 容器 | 25 项指标的字典 |
 * | 每个 `MetricStat` | 含 successes / adjustedRate 等 |
 * | 每个 `stat.prior` | **共享常量**，最危险的一层 |
 * | `decay` | **共享常量 `DEFAULT_DECAY`**，红队 CRITICAL |
 * | `log` 数组 | 事件日志 |
 * | 每个 `log[i]` | 单条事件 |
 * | `log[i].observations` 数组 | 观测列表 |
 * | 每个观测元素 | 最内层 |
 * | `seenHandIds` | 只读视图（不是可变 Set） |
 *
 * 这个清单本身就是修复红队 CRITICAL 的产物：旧版漏了 `decay`，
 * 于是「逐层检查 8 个位置」的测试全绿，而第 9 层是敞开的。
 * 现在由表驱动测试遍历**全部**属性，新增字段忘记冻结会立刻失败。
 */
/**
 * 冻结前的**可变**画像（内部用）。
 *
 * 刻意与对外的 `PlayerProfile` 分开：对外类型里 `seenHandIds` 是只读视图、
 * 一切皆冻结；对内需要可变 `Set` 来构建。类型分开后，
 * 「忘记冻结就交出去」会变成编译错误，而不是运行期的静默可变。
 */
type MutableProfile = {
  playerId: string;
  handsObserved: number;
  maxSeq: number;
  metrics: Record<PlayerMetric, MetricStat>;
  seenHandIds: ReadonlySet<string>;
  log: readonly HandObservation[];
  decay: DecayOptions;
  version: string;
};

function freezeProfile(profile: MutableProfile): PlayerProfile {
  const metrics = {} as Record<PlayerMetric, MetricStat>;
  for (const metric of ALL_PLAYER_METRICS) {
    const stat = profile.metrics[metric];
    metrics[metric] = Object.freeze({
      ...stat,
      // `prior` 是嵌套对象，且**直接来自 METRIC_DEFINITIONS 的共享常量**。
      // 若只冻结外层，一行 `stat.prior.center = 0.99` 会永久污染
      // 全局先验表 —— 之后**每一个**新建画像的收缩目标都被改掉，
      // 而 Object.isFrozen(stat) 仍返回 true。因此必须冻结这一层。
      prior: Object.freeze({ ...stat.prior }),
    });
  }
  return Object.freeze({
    ...profile,
    metrics: Object.freeze(metrics),
    decay: freezeDecay(profile.decay),
    seenHandIds: toReadOnlyHandIds(profile.seenHandIds),
    log: Object.freeze(profile.log.map(freezeHandObservation)),
  });
}

/* ============================================================
 * 校验
 * ============================================================ */

/** 时间戳是否合法（必须是可解析的 ISO 字符串，且不是远古/未来时间） */
export function isValidTimestamp(timestamp: string): boolean {
  if (typeof timestamp !== 'string' || timestamp.trim().length === 0) return false;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return false;
  // 合理区间：2000-01-01 ~ 2100-01-01，拦住明显错误的输入
  const min = Date.UTC(2000, 0, 1);
  const max = Date.UTC(2100, 0, 1);
  return parsed >= min && parsed <= max;
}

function validateObservation(
  profile: PlayerProfile,
  observation: HandObservation,
): ProfileIssue[] {
  const issues: ProfileIssue[] = [];

  if (observation.playerId !== profile.playerId) {
    issues.push({
      code: 'PLAYER_MISMATCH',
      params: { expected: profile.playerId, actual: observation.playerId },
    });
  }
  if (profile.seenHandIds.has(observation.handId)) {
    issues.push({ code: 'DUPLICATE_HAND', params: { handId: observation.handId } });
  }
  if (!isValidTimestamp(observation.timestamp)) {
    issues.push({ code: 'INVALID_TIMESTAMP', params: { timestamp: String(observation.timestamp) } });
  }
  if (!isValidSeq(observation.seq)) {
    // **阻塞级**：seq 直接决定时间衰减权重。NaN → 权重 NaN 并污染全部统计；
    // 负数 → 权重 > 1（未来的牌局比现在还重）。两者都是「静默算错」，
    // 因此必须拒绝而不是警告。
    issues.push({ code: 'NEGATIVE_COUNT', params: { seq: String(observation.seq) } });
  } else if (observation.seq > profile.maxSeq + SEQ_GAP_TOLERANCE) {
    // **阻塞级**：`recompute` 用「最大 seq 当作现在」计算每手的 age。
    // 因此一个远大于历史值的 seq 会把**所有**已有牌局的 age 抬高，
    // 使它们的权重趋近 0 —— 一手录入错误即可作废几百手历史。
    // 红队实测：200 手 100% 入池的 adjustedRate 从 0.8870 掉到 0.2419
    //（**低于先验中心 0.25**），n_eff 198→1，且 warnings = 0。
    issues.push({
      code: 'SEQ_OUT_OF_RANGE',
      params: {
        seq: observation.seq,
        maxSeq: profile.maxSeq,
        tolerance: SEQ_GAP_TOLERANCE,
        hint: `序号必须按顺序递增，最大跳跃 ${SEQ_GAP_TOLERANCE}`,
      },
    });
  }

  const seenMetrics = new Set<PlayerMetric>();
  for (const item of observation.observations) {
    if (!ALL_PLAYER_METRICS.includes(item.metric)) {
      issues.push({ code: 'UNKNOWN_METRIC', params: { metric: String(item.metric) } });
    }
    if (seenMetrics.has(item.metric)) {
      // 同一手内重复指标：只保留第一次，并给出警告（由调用方决定是否视为错误）
      issues.push({ code: 'UNKNOWN_METRIC', params: { metric: item.metric, note: '同一手内重复指标' } });
    }
    seenMetrics.add(item.metric);
  }

  return issues;
}

/* ============================================================
 * 增量更新
 * ============================================================ */

/**
 * 规范化观测列表：过滤未知指标 + 同一手内同指标只取第一次。
 *
 * **所有接收 observations 的入口都必须经过它**（`observeHand` 与 `amendHand`）。
 * 红队 CRITICAL-3 发现：旧版只有 `observeHand` 做了去重，`amendHand` 没有，
 * 于是同一手内 3 条重复指标在修正路径上得到 `opportunities = 4`，
 * 而在录入路径上是 `2` —— 直接违反 `amendHand` 自己声明的
 * 「与一开始就录对完全一致」契约。
 *
 * 抽成单一函数，是为了让「两条路径行为一致」成为**结构保证**，
 * 而不是「记得在两处都写一遍」。
 */
function normalizeObservations(
  observations: readonly OpportunityObservation[],
): OpportunityObservation[] {
  const deduped: OpportunityObservation[] = [];
  const seen = new Set<PlayerMetric>();
  for (const item of observations) {
    if (!ALL_PLAYER_METRICS.includes(item.metric)) continue;
    if (seen.has(item.metric)) continue;
    seen.add(item.metric);
    deduped.push({ metric: item.metric, success: item.success });
  }
  return deduped;
}

/** `seq` 必须是非负整数；否则时间衰减会得到 NaN / 负数权重 */
function isValidSeq(seq: number): boolean {
  return Number.isInteger(seq) && seq >= 0;
}

/**
 * 纳入一手牌。
 *
 * 幂等：同一 handId 重复调用返回 `DUPLICATE_HAND` 失败，**不改变画像**。
 */
export function observeHand(
  profile: PlayerProfile,
  observation: HandObservation,
): ProfileOutcome<PlayerProfile> {
  const issues = validateObservation(profile, observation);
  const blocking = issues.filter(
    (i) =>
      i.code === 'PLAYER_MISMATCH' ||
      i.code === 'DUPLICATE_HAND' ||
      i.code === 'INVALID_TIMESTAMP' ||
      i.code === 'NEGATIVE_COUNT' ||
      i.code === 'SEQ_OUT_OF_RANGE',
  );
  if (blocking.length > 0) return { ok: false, issues: blocking };

  const deduped = normalizeObservations(observation.observations);

  const seenHandIds = new Set(profile.seenHandIds);
  seenHandIds.add(observation.handId);
  const log = [...profile.log, { ...observation, observations: deduped }];

  return {
    ok: true,
    value: freezeProfile(recompute(profile.playerId, log, seenHandIds, profile.decay)),
    warnings: issues.filter((i) => !blocking.includes(i)),
  };
}

/**
 * 从事件日志全量重算画像。
 *
 * 时间衰减以**最后一手的序号**为「现在」，因此每手的 age = maxSeq − seq。
 * 这样重建结果与增量结果完全一致（有测试保证）。
 */
function recompute(
  playerId: string,
  log: readonly HandObservation[],
  seenHandIds: ReadonlySet<string>,
  decay: DecayOptions,
): MutableProfile {
  const maxSeq = log.reduce((max, item) => (item.seq > max ? item.seq : max), 0);

  const perMetric = new Map<PlayerMetric, Array<{ weight: number; success: boolean }>>();
  for (const metric of ALL_PLAYER_METRICS) perMetric.set(metric, []);

  // 按 seq 升序处理，保证确定性
  const ordered = [...log].sort((a, b) => a.seq - b.seq || (a.handId < b.handId ? -1 : 1));

  for (const hand of ordered) {
    const age = maxSeq - hand.seq;
    const weight = Math.pow(2, -age / decay.halfLife);
    for (const item of hand.observations) {
      perMetric.get(item.metric)?.push({ weight, success: item.success });
    }
  }

  const metrics = {} as Record<PlayerMetric, MetricStat>;
  for (const metric of ALL_PLAYER_METRICS) {
    metrics[metric] = computeMetricStat(metric, perMetric.get(metric) ?? [], {
      decay,
      lastUpdatedSeq: maxSeq,
    });
  }

  return {
    playerId,
    handsObserved: ordered.length,
    maxSeq: ordered.length === 0 ? 0 : maxSeq,
    metrics,
    seenHandIds,
    log: ordered,
    decay,
    version: PROFILE_VERSION,
  };
}

/* ============================================================
 * 修正历史（规范第十八节）
 * ============================================================ */

/**
 * 替换一手牌的观测（用于用户修正历史牌局）。
 *
 * **关键**：不是「旧统计留着 + 新统计再加一次」，而是
 * 从日志中移除旧事件、插入新事件、然后全量重算。
 *
 * ## 红队 CRITICAL-3 的修复
 *
 * 旧版有两个缺陷，都会让「修正后 = 一开始就录对」这条契约失效：
 * 1. **不去重**：同一手内重复指标被全部计入，`opportunities` 比录入路径多。
 * 2. **不校验 seq**：`seq = NaN` 会在 `computeMetricStat` 深处抛错
 *    （错误信息与真正原因相距很远）；`seq = -5` / `1.5` 被静默接受。
 *
 * 现在两条路径**共用** `normalizeObservations` 与 `isValidSeq`，
 * 行为一致性由结构保证，而不是靠记得在两处都写。
 */
export function amendHand(
  profile: PlayerProfile,
  handId: string,
  replacement: Omit<HandObservation, 'playerId' | 'handId' | 'seq'> & { seq?: number },
): ProfileOutcome<PlayerProfile> {
  if (!profile.seenHandIds.has(handId)) {
    return { ok: false, issues: [{ code: 'DUPLICATE_HAND', params: { handId, note: '该手牌不在画像中' } }] };
  }
  if (!isValidTimestamp(replacement.timestamp)) {
    return { ok: false, issues: [{ code: 'INVALID_TIMESTAMP', params: { timestamp: replacement.timestamp } }] };
  }

  const target = profile.log.find((item) => item.handId === handId)!;
  const nextSeq = replacement.seq ?? target.seq;
  if (!isValidSeq(nextSeq)) {
    return { ok: false, issues: [{ code: 'NEGATIVE_COUNT', params: { seq: String(nextSeq) } }] };
  }

  const nextLog = profile.log.map((item) =>
    item.handId === handId
      ? {
          handId,
          playerId: profile.playerId,
          seq: nextSeq,
          timestamp: replacement.timestamp,
          // 与录入路径共用同一份规范化逻辑（过滤未知指标 + 去重）
          observations: normalizeObservations(replacement.observations),
        }
      : item,
  );

  return {
    ok: true,
    value: freezeProfile(recompute(profile.playerId, nextLog, new Set(profile.seenHandIds), profile.decay)),
    warnings: [],
  };
}

/** 移除一手牌（修正为「这手不算」） */
export function removeHand(profile: PlayerProfile, handId: string): PlayerProfile {
  if (!profile.seenHandIds.has(handId)) return profile;
  const seenHandIds = new Set(profile.seenHandIds);
  seenHandIds.delete(handId);
  const nextLog = profile.log.filter((item) => item.handId !== handId);
  return freezeProfile(recompute(profile.playerId, nextLog, seenHandIds, profile.decay));
}

/* ============================================================
 * 查询
 * ============================================================ */

export function metricOf(profile: PlayerProfile, metric: PlayerMetric): MetricStat {
  return profile.metrics[metric];
}

/**
 * 画像是否可用（至少有一项指标达到「标准」可信度）。
 *
 * 用于下游：「样本不足时不得作为稳定画像使用」。
 */
export function hasUsableSample(profile: PlayerProfile, minConfidence = 0.5): boolean {
  return ALL_PLAYER_METRICS.some((metric) => profile.metrics[metric].confidence >= minConfidence);
}

/**
 * 画像摘要：哪些指标样本充足、哪些不足。
 *
 * ## 判定用 `effectiveSampleSize`，不用 `opportunities`（红队 MAJOR-4）
 *
 * 旧版用原始机会数 `stat.opportunities >= 30`，而同一文件的
 * `sampleTier` 文档明确写着「注意用的是 effectiveSampleSize 而不是
 * 原始 opportunities —— 时间衰减之后，300 手旧数据的信息量可能远小于 300」。
 * **文档与实现相反。**
 *
 * 实测后果：一个 300 次机会、但有效样本量只有 22 的指标会被判为
 * 「样本充足」—— 恰好是这个项目最想避免的那种「看似有数据，其实没有」。
 *
 * 现在统一用有效样本量，与 `sampleTier` / `confidence` 口径一致。
 */
export function sampleSummary(profile: PlayerProfile): {
  totalHands: number;
  sufficientMetrics: PlayerMetric[];
  insufficientMetrics: PlayerMetric[];
} {
  const sufficient: PlayerMetric[] = [];
  const insufficient: PlayerMetric[] = [];
  for (const metric of ALL_PLAYER_METRICS) {
    const stat = profile.metrics[metric];
    // 「足够」= **有效**样本量至少 30（规范第二十五节的初步门槛）
    // 且可信度达标（可信度同时惩罚「机会少」与「权重不均」）
    if (stat.effectiveSampleSize >= 30 && stat.confidence >= 0.3) sufficient.push(metric);
    else insufficient.push(metric);
  }
  return { totalHands: profile.handsObserved, sufficientMetrics: sufficient, insufficientMetrics: insufficient };
}

export { METRIC_DEFINITIONS };
