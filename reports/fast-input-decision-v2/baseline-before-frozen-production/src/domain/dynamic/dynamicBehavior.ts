/**
 * 动态真人行为模型 —— 主引擎（Step 7）
 *
 * > 回答**一个**问题：**他最近是否偏离了自己？**
 *
 * 它**不**回答：他这手是什么牌 / 我该怎么打 / 他是不是在 Tilt（只给概率）。
 *
 * ## 数据流（规范第 4 节的合法链）
 *
 * ```
 * 真实行为（ObservedPokerEvent）
 *   ↓ 规范化：排序 / 去重 / 过滤未来
 * 个人长期基线（来自 Step 6，本层不重建）
 *   ↓ 10/20/50 手窗口 + 机会感知统计
 * 偏移检测（有界归一化差值 → 相关组聚合 → 组上限）
 *   ↓
 * Dynamic State（9 种）
 *   ↓
 * Range Adjustment（方向 only，绝无 multiplier）
 * ```
 *
 * ## 严禁的非法链（规范第 4 节）
 *
 * ```
 * 预测玩家 Tilt → 扩大 Range → 因为 Range 扩大 → 更加确认玩家 Tilt
 * ```
 *
 * 本模块在**类型层**上就无法读取 `previousState` / `adjustedRange` /
 * `decision` / `result` —— `DynamicBehaviorInput` 里根本没有这些字段，
 * 且本文件不导入任何范围 / 决策 / 复盘模块（有源码扫描测试断言）。
 */

import { PlayerMetric } from '../player/player.types.ts';

import {
  ALL_WINDOW_SIZES,
  DYNAMIC_MODEL_VERSION,
  DynamicAdjustmentTarget,
  DynamicErrorCode,
  DynamicState,
  GROUP_CAPS,
  MIN_RECENT_OPPORTUNITIES,
  USER_HINT_CONFIDENCE_CAP,
  USER_HINT_PROBABILITY_CAP,
  UserHintKind,
  WindowSize,
  dynamicFailure,
  type ContextEvent,
  type DeviationGroup,
  type DynamicBehaviorInput,
  type DynamicBehaviorSnapshot,
  type DynamicOutcome,
  type DynamicRangeAdjustment,
  type DynamicSignal,
  type GroupDeviation,
  type ObservedPokerEvent,
  type RecentWindow,
  type TiltSignal,
  type UserObservedHint,
} from './dynamic.types.ts';
import {
  baselineUsable,
  buildWindows,
  normalizeEvents,
  statOf,
  takeWindow,
  totalOpportunities,
  validateBaseline,
} from './dynamicStats.ts';
import {
  boundedNormalizedDifference,
  computeGroupDeviations,
  detectConflicts,
  deviationScoreOf,
  metricDeviation,
} from './dynamicDeviation.ts';

/* ============================================================
 * 一、每个状态所需的分组依据
 * ============================================================ */

const STATE_REQUIRES: Readonly<
  Record<Exclude<DynamicState, 'NORMAL' | 'UNKNOWN'>, readonly DeviationGroup[]>
> = Object.freeze({
  LOOSER_RECENTLY: ['ENTRY'],
  TIGHTER_RECENTLY: ['ENTRY'],
  AGGRESSION_UP: ['AGGRESSION'],
  AGGRESSION_DOWN: ['AGGRESSION'],
  SIZE_ANOMALY: ['SIZING'],
  CHASE_LOSS_SIGNAL: ['ENTRY', 'AGGRESSION', 'SIZING', 'CALLING'],
  TILT_SIGNAL: ['ENTRY', 'AGGRESSION', 'SIZING', 'CALLING'],
});

/**
 * 只由**单一指标**驱动时的信号折扣（独立红队第二轮）。
 *
 * ## 为什么需要
 *
 * 一个窗口同时检验多项指标，每项各自 1.5σ 的假阳性会累积
 * （多重比较问题）。实测「真值 = 基线」的数据集有约 17% 报出状态改变，
 * 其中大部分**只由一个指标显著**。
 *
 * 而「一项指标的轻微偏移」与「多项相关指标同向偏移」的证据强度
 * 是不同的：前者更像噪声。因此单项驱动时把概率打折，
 * 让它更难越过 `SIGNAL_THRESHOLD`、也给出更保守的幅度。
 *
 * 这不是「凭感觉调参」：它就是多重比较校正的工程近似 ——
 * 检验数越多，单个检验需要的证据越强。
 */
const SINGLE_METRIC_DISCOUNT = 0.6;

/** 由一个组的证据生成信号概率 */
function groupSignal(
  state: Exclude<DynamicState, 'NORMAL' | 'UNKNOWN'>,
  groups: readonly GroupDeviation[],
  required: readonly DeviationGroup[],
): DynamicSignal | null {
  const relevant = groups.filter((g) => required.includes(g.group));
  if (relevant.length === 0) return null;

  const maxScore = Math.max(...relevant.map((g) => g.score));
  // 组上限**必须**来自 `GROUP_CAPS`（单一事实来源）。
  // 这里原先硬编码了一份 switch（1.0 / 0.9 / 0.7 / 0.6 / 0.6）——
  // 数值当时是对的，但等于把同一个常量写了两遍：
  // 一旦 `GROUP_CAPS` 调整而这里漏改，信号概率会**静默**算错。
  const maxCap = Math.max(...relevant.map((g) => GROUP_CAPS[g.group]));
  if (maxCap <= 0) return null;

  // 参与比较的指标数（有基线、有数据者）
  const comparedMetrics = relevant.reduce((sum, g) => sum + g.comparedMetrics, 0);
  const discount = comparedMetrics <= 1 ? SINGLE_METRIC_DISCOUNT : 1;

  const probability = Math.max(0, Math.min(1, (maxScore / maxCap) * discount));
  const confidence = Math.max(...relevant.map((g) => g.confidence));
  if (probability <= 0.05) return null;

  const drivers = relevant
    .map((g) => g.strongestMetric)
    .filter((m): m is PlayerMetric => m !== null);

  return { state, probability, confidence, drivers: Object.freeze(drivers) };
}

/* ============================================================
 * 二、上下文事件：**只作为时间锚点，绝不直接加分**
 * ============================================================ */

/**
 * 位置偏移的聚合强度。
 *
 * 用于「事件后偏移」与「事件前偏移」的比较 ——
 * 两侧用**同一套**度量，因此比较是有意义的。
 */
function positionalStrength(
  events: readonly ObservedPokerEvent[],
  baseline: DynamicBehaviorSnapshotInput['baseline'],
  maxSeq: number,
): { strength: number; metrics: number } {
  const metricsInPlay: PlayerMetric[] = [
    PlayerMetric.VPIP,
    PlayerMetric.PFR,
    PlayerMetric.THREE_BET,
    PlayerMetric.CALL_OPEN,
    PlayerMetric.RIVER_CALL,
  ];
  let total = 0;
  let counted = 0;
  for (const metric of metricsInPlay) {
    if (!baselineUsable(baseline, metric)) continue;
    const relevant = events.filter((e) => e.opportunities.some((o) => o.metric === metric));
    if (relevant.length === 0) continue;

    let successes = 0;
    for (const e of relevant) {
      for (const o of e.opportunities) if (o.metric === metric && o.success) successes++;
    }
    const rate = successes / relevant.length;
    const base = baseline.metrics[metric]?.adjustedRate ?? null;
    if (base === null) continue;
    total += boundedNormalizedDifference(rate, base);
    counted++;
  }
  void maxSeq;
  return { strength: counted > 0 ? total / counted : 0, metrics: counted };
}

type DynamicBehaviorSnapshotInput = DynamicBehaviorInput;

/**
 * 校验上下文事件（独立红队 F6）。
 *
 * ## 为什么必须校验
 *
 * 修复前 `ContextEvent` 的 `playerId` / `timestamp` / 观察时刻
 * **完全不参与校验**，后果是：
 *
 * | 输入 | 修复前行为 |
 * |---|---|
 * | `playerId = 'somebody-else'` | Tilt 概率 **逐位一致** —— **别人的损失会抬高本人的 Tilt 概率** |
 * | `timestamp = 2099`（未来） | 逐位一致 —— 未来发生的事影响着现在的判断 |
 *
 * 在高频线下的多人池场景里，误把别人的标记挂到本人身上，
 * 会直接产出「他在上头」这种会导致错误跟注/弃牌的结论。
 *
 * 现在：`playerId` 不匹配、`timestamp` 在未来、`timestamp` 无法解析
 * 的上下文事件一律**忽略并记录**（不静默）。
 */
function validateContextEvents(
  contextEvents: readonly ContextEvent[],
  playerId: string,
  asOf: number,
): { accepted: ContextEvent[]; rejected: { eventId: string; reason: string }[] } {
  const accepted: ContextEvent[] = [];
  const rejected: { eventId: string; reason: string }[] = [];
  for (const event of contextEvents) {
    if (event === null || typeof event !== 'object') {
      rejected.push({ eventId: '<非对象>', reason: '上下文事件不是对象' });
      continue;
    }
    if (event.playerId !== playerId) {
      rejected.push({
        eventId: event.contextEventId,
        reason: `上下文事件属于其他玩家（${String(event.playerId)}）—— 已忽略，不得抬高本人判定`,
      });
      continue;
    }
    const time = Date.parse(event.timestamp);
    if (Number.isNaN(time)) {
      rejected.push({
        eventId: event.contextEventId,
        reason: `上下文事件 timestamp 无法解析（${String(event.timestamp)}）`,
      });
      continue;
    }
    if (time > asOf) {
      rejected.push({
        eventId: event.contextEventId,
        reason: `上下文事件发生在 asOf 之后（${event.timestamp}）—— 不得影响当前判断`,
      });
      continue;
    }
    accepted.push(event);
  }
  return { accepted, rejected };
}

/**
 * 由上下文事件推导「事后偏移」与「追损/上头」证据。
 *
 * ## 关键设计：输赢**本身不加分**
 *
 * 本函数只做一件事：**比较「事件之前」与「事件之后」的实际打法**。
 * 因此：
 * - 连输三个 Cooler 但打法不变 → `postStrength ≈ preStrength` → 证据 ≈ 0
 * - 输一个大池后开始乱打 → `postStrength` 显著高于 `preStrength` → 证据上升
 *
 * 「赢」与「输」在计算中**没有区别** —— 都用同一条路径衡量行为变化
 * （规范第 30 节：赢后变松只表现为 `LOOSER_RECENTLY` / `AGGRESSION_UP`）。
 */
function analyzeContextEvents(
  ordered: readonly ObservedPokerEvent[],
  contextEvents: readonly ContextEvent[],
  baseline: DynamicBehaviorInput['baseline'],
): {
  /** 0..1：事件后行为相比事件前**额外**偏离的程度 */
  postShift: number;
  /** 参与分析的事件数 */
  anchors: number;
  /** 最强锚点的中文说明（可为空） */
  note: string | null;
} {
  if (contextEvents.length === 0 || ordered.length === 0) {
    return { postShift: 0, anchors: 0, note: null };
  }

  const maxSeq = ordered.reduce((max, e) => (e.seq > max ? e.seq : max), 0);
  const anchorSeqs = [...new Set(contextEvents.map((c) => c.seq))].sort((a, b) => a - b);

  let bestShift = 0;
  let bestNote: string | null = null;
  let analysed = 0;

  for (const anchorSeq of anchorSeqs) {
    const before = ordered.filter((e) => e.seq < anchorSeq);
    const after = ordered.filter((e) => e.seq > anchorSeq);
    // 两侧都必须有足够样本，否则比较没有意义
    if (before.length < 5 || after.length < 5) continue;

    const pre = positionalStrength(before, baseline, maxSeq);
    const post = positionalStrength(after, baseline, maxSeq);
    if (pre.metrics === 0 || post.metrics === 0) continue;

    analysed++;
    const shift = Math.max(0, post.strength - pre.strength);
    if (shift > bestShift) {
      bestShift = shift;
      bestNote = `第 ${anchorSeq} 手之后的行为偏移明显大于之前`;
    }
  }

  return { postShift: bestShift, anchors: analysed, note: analysed > 0 ? bestNote : null };
}

/* ============================================================
 * 三、窗口一致性
 * ============================================================ */

/**
 * 窗口一致性 → `[0, 1]`。
 *
 * - 三个窗口都指向同一方向、同一强度 → 接近 1
 * - 只有 10 手异常、50 手正常 → 明显低于 1（**短期噪声**）
 *
 * 实现：对**最大窗口**（最稳定）与**最小窗口**的组分数向量求余弦式相似度。
 * 用相对比例而不是绝对差值，避免把「整体偏移小」误判成「不一致」。
 */
export function windowConsistency(windows: readonly RecentWindow[]): number {
  if (windows.length < 2) return 0;
  const sorted = [...windows].sort((a, b) => a.size - b.size);
  const small = sorted[0]!;
  const large = sorted[sorted.length - 1]!;

  const smallGroups = computeGroupDeviations(small);
  const largeGroups = computeGroupDeviations(large);

  let dot = 0;
  let normSmall = 0;
  let normLarge = 0;
  for (let i = 0; i < smallGroups.length; i++) {
    const a = smallGroups[i]!.score;
    const b = largeGroups[i]!.score;
    dot += a * b;
    normSmall += a * a;
    normLarge += b * b;
  }
  if (normSmall === 0 || normLarge === 0) {
    // 两者都无偏移 → 完全一致
    return normSmall === 0 && normLarge === 0 ? 1 : 0;
  }
  return Math.max(0, Math.min(1, dot / Math.sqrt(normSmall * normLarge)));
}

/* ============================================================
 * 四、置信度（**不等于 deviationScore**）
 * ============================================================ */

/**
 * 计算 Dynamic 置信度（规范第 40 节）。
 *
 * ⚠️ **刻意不使用 `deviationScore`** —— 偏移大不代表判断可信
 * （一手极端行为就能造成大偏移）。
 *
 * 置信度只来自四件事：
 * 1. **基线覆盖**：有多少比例的指标有可用基线
 * 2. **基线质量**：基线自身的平均置信度
 * 3. **近期机会**：近期机会数是否足够
 * 4. **窗口一致性**：三个窗口是否指向同一件事
 *
 * 取四项的**最小值**：任一环节弱，整体就不可信。
 * 这比取平均保守，符合「不确定时宁可说不知道」的项目立场。
 */
export function dynamicConfidence(input: {
  baselineCoverage: number;
  baselineQuality: number;
  recentOpportunities: number;
  consistency: number;
}): number {
  const coverage = Math.max(0, Math.min(1, input.baselineCoverage));
  const quality = Math.max(0, Math.min(1, input.baselineQuality));
  const sample = Math.max(0, Math.min(1, input.recentOpportunities / (MIN_RECENT_OPPORTUNITIES * 3)));
  const consistency = Math.max(0, Math.min(1, input.consistency));
  return Math.max(0, Math.min(1, Math.min(coverage, quality, sample, consistency)));
}

/* ============================================================
 * 五、状态推导
 * ============================================================ */

export type StateDerivation = {
  dominantState: DynamicState;
  signals: readonly DynamicSignal[];
  tilt: TiltSignal;
  explanation: readonly string[];
};

/** 状态概率达到该值才作为「信号」输出 */
const SIGNAL_THRESHOLD = 0.25;

export function deriveState(input: {
  groups: readonly GroupDeviation[];
  windows: readonly RecentWindow[];
  conflicts: readonly string[];
  /**
   * **单指标最大机会数**（判断门槛的判据）。
   *
   * 独立红队 F2：这里**不能**用跨指标机会总数 ——
   * 一手牌声明 8 个机会就能骗过门槛，而每项指标只有 0~1 次观测。
   */
  recentOpportunities: number;
  /** 窗口内全部指标的机会总数（仅用于解释文本，不参与判定） */
  totalOpportunities?: number;
  /** 自身机会数达到门槛的可比指标数 */
  sufficientMetrics?: number;
  confidence: number;
  contextShift: number;
  contextNote: string | null;
  ignoredCount: number;
}): StateDerivation {
  const { groups, conflicts, recentOpportunities, confidence } = input;

  // ---- 样本不足 → 强制 UNKNOWN，**绝不默认 NORMAL**（规范第 22 / 23 / 61 节）----
  if (recentOpportunities < MIN_RECENT_OPPORTUNITIES) {
    const detail =
      input.totalOpportunities !== undefined && input.totalOpportunities > recentOpportunities
        ? `近期机会数不足以对任何单项指标下结论（最多的一项仅 ${recentOpportunities} 次，` +
          `合计 ${input.totalOpportunities} 次分散在多项指标上）`
        : '近期机会数不足，无法判断行为是否偏移';
    return {
      dominantState: DynamicState.UNKNOWN,
      signals: Object.freeze([]),
      tilt: Object.freeze({
        probability: 0,
        confidence: 0,
        evidence: Object.freeze([detail]),
      }),
      explanation: Object.freeze([detail]),
    };
  }

  const byGroup = (group: DeviationGroup): GroupDeviation | undefined =>
    groups.find((g) => g.group === group);

  const entry = byGroup('ENTRY');
  const aggression = byGroup('AGGRESSION');
  const sizing = byGroup('SIZING');
  const river = byGroup('RIVER');

  // ---- 收集候选信号 ----
  const candidates: DynamicSignal[] = [];
  const push = (signal: DynamicSignal | null): void => {
    if (signal && signal.probability >= SIGNAL_THRESHOLD) candidates.push(signal);
  };

  if (entry?.direction === 'HIGHER') push(groupSignal(DynamicState.LOOSER_RECENTLY, groups, ['ENTRY']));
  if (entry?.direction === 'LOWER') push(groupSignal(DynamicState.TIGHTER_RECENTLY, groups, ['ENTRY']));

  // 冲突保护：入池变多但进攻变弱 → 不是 AGGRESSION_UP（规范第 42 节）
  const aggressionBlocked = conflicts.some((c) => c.includes('进攻性变化方向不一致') || c.includes('被动跟注变多') || c.includes('跟注变多'));
  if (aggression?.direction === 'HIGHER' && !aggressionBlocked) {
    push(groupSignal(DynamicState.AGGRESSION_UP, groups, ['AGGRESSION']));
  }
  if (aggression?.direction === 'LOWER') {
    push(groupSignal(DynamicState.AGGRESSION_DOWN, groups, ['AGGRESSION']));
  }
  if (sizing && sizing.score > 0) push(groupSignal(DynamicState.SIZE_ANOMALY, groups, ['SIZING']));

  // ---- 上下文驱动：追损 / 上头（**必须**依赖真实行为变化）----
  // 注意：`contextShift` 已经是「事件后 vs 事件前」的行为差异，
  // 输赢本身在它里面**没有任何权重**。
  if (input.contextShift > 0.1) {
    const behaviorBacking = Math.max(
      entry?.direction === 'HIGHER' ? (entry?.score ?? 0) : 0,
      aggression?.direction === 'HIGHER' && !aggressionBlocked ? (aggression?.score ?? 0) : 0,
      sizing?.score ?? 0,
      byGroup('CALLING')?.direction === 'HIGHER' ? (byGroup('CALLING')?.score ?? 0) : 0,
    );
    if (behaviorBacking > 0) {
      const probability = Math.max(0, Math.min(1, input.contextShift * 0.6 + behaviorBacking * 0.4));
      const drivers: PlayerMetric[] = [];
      if (entry?.direction === 'HIGHER' && entry.strongestMetric) drivers.push(entry.strongestMetric);
      if (aggression?.direction === 'HIGHER' && aggression.strongestMetric) drivers.push(aggression.strongestMetric);
      if (sizing?.strongestMetric) drivers.push(sizing.strongestMetric);

      candidates.push({
        state: DynamicState.CHASE_LOSS_SIGNAL,
        probability,
        confidence,
        drivers: Object.freeze(drivers),
      });
    }
  }

  // ---- 排序：概率优先，同概率时按状态名稳定排序 ----
  candidates.sort((a, b) =>
    b.probability !== a.probability
      ? b.probability - a.probability
      : a.state < b.state
        ? -1
        : a.state > b.state
          ? 1
          : 0,
  );

  // ---- Tilt 倾向 = 把追损与进攻性变化**叠加**成一个概率（仍然只是概率）----
  const chase = candidates.find((c) => c.state === DynamicState.CHASE_LOSS_SIGNAL);
  const aggroUp = candidates.find((c) => c.state === DynamicState.AGGRESSION_UP);
  const tiltProbability = Math.max(
    0,
    Math.min(1, (chase?.probability ?? 0) * 0.7 + (aggroUp?.probability ?? 0) * 0.3),
  );

  const tilt: TiltSignal = Object.freeze({
    probability: tiltProbability,
    confidence: tiltProbability > 0 ? confidence : 0,
    evidence: Object.freeze(
      [
        chase ? '重大损失之后的行为偏移大于之前' : null,
        aggroUp ? '主动进攻频率高于个人基线' : null,
        input.contextNote,
      ].filter((x): x is string => x !== null),
    ),
  });

  // ---- 主导状态 ----
  let dominantState: DynamicState = DynamicState.NORMAL;
  if (tiltProbability >= 0.5 && chase) {
    dominantState = DynamicState.TILT_SIGNAL;
  } else if (chase && chase.probability >= 0.4) {
    dominantState = DynamicState.CHASE_LOSS_SIGNAL;
  } else if (aggressionBlocked && entry?.direction === 'HIGHER') {
    // 冲突 → 明确判为「变松」而不是「变激进」
    dominantState = DynamicState.LOOSER_RECENTLY;
  } else if (candidates.length > 0) {
    dominantState = candidates[0]!.state;
  }

  // 尺寸异常单独异常时也算主导（它是最容易被忽略的一类）
  if (dominantState === DynamicState.NORMAL && sizing && sizing.score > 0.25) {
    dominantState = DynamicState.SIZE_ANOMALY;
  }

  // 河牌行为也有偏移但没进候选时，至少说明存在偏移 → 不强制降级
  void river;

  // ---- 解释（最多 3 条，中文，来自真实证据）----
  const explanation = explain({ dominantState, groups, conflicts, recentOpportunities, tilt });

  return {
    dominantState,
    signals: Object.freeze(candidates),
    tilt,
    explanation: Object.freeze(explanation),
  };
}

/* ============================================================
 * 六、解释（最多 3 条）
 * ============================================================ */

const GROUP_LABEL: Readonly<Record<DeviationGroup, string>> = Object.freeze({
  ENTRY: '翻牌前入池',
  AGGRESSION: '主动进攻',
  CALLING: '被动跟注',
  SIZING: '下注尺寸',
  RIVER: '河牌行为',
});

function explain(input: {
  dominantState: DynamicState;
  groups: readonly GroupDeviation[];
  conflicts: readonly string[];
  recentOpportunities: number;
  tilt: TiltSignal;
}): string[] {
  const lines: string[] = [];

  if (input.dominantState === DynamicState.UNKNOWN) {
    return ['近期机会数不足，无法判断行为是否偏移'];
  }

  // 1. 最强的偏移组
  const strongest = [...input.groups]
    .filter((g) => g.score > 0)
    .sort((a, b) => b.score - a.score)[0];
  if (strongest) {
    const directionText = strongest.direction === 'HIGHER' ? '高于' : strongest.direction === 'LOWER' ? '低于' : '偏离';
    lines.push(`${GROUP_LABEL[strongest.group]}${directionText}个人基线（主要指标：${strongest.strongestMetric ?? '多项'}）`);
  }

  // 2. 冲突（若有）
  if (input.conflicts.length > 0) lines.push(input.conflicts[0]!);

  // 3. Tilt 迹象（仅当有概率时）
  if (input.tilt.probability > 0.2 && lines.length < 3) {
    lines.push(`存在上头迹象（概率 ${input.tilt.probability.toFixed(2)}）`);
  }

  if (lines.length === 0) {
    lines.push('近期打法与个人基线接近');
  }
  return lines.slice(0, 3);
}

/* ============================================================
 * 七、人工 Hint（USER_OBSERVED）
 * ============================================================ */

const HINT_TO_STATE: Readonly<Record<UserHintKind, DynamicState | null>> = Object.freeze({
  NORMAL: DynamicState.NORMAL,
  LOOSER_RECENTLY: DynamicState.LOOSER_RECENTLY,
  TIGHTER_RECENTLY: DynamicState.TIGHTER_RECENTLY,
  AGGRESSIVE_RECENTLY: DynamicState.AGGRESSION_UP,
  SUSPECT_TILT: DynamicState.TILT_SIGNAL,
  SUSPECT_CHASE_LOSS: DynamicState.CHASE_LOSS_SIGNAL,
  UNKNOWN: DynamicState.UNKNOWN,
});

export type HintResolution = {
  /** 被采用的状态（null = 无 hint 或全部被拒绝） */
  state: DynamicState | null;
  /** 该 hint 的置信度（≤ USER_HINT_CONFIDENCE_CAP） */
  confidence: number;
  /** 与真实数据的冲突说明 */
  conflicts: readonly string[];
  /** 是否被真实数据推翻 */
  overridden: boolean;
};

/**
 * 解析人工 Hint（规范第 80–82 节）。
 *
 * ## 三条纪律
 *
 * 1. **不能直接变成 Action** —— 它只进入 Dynamic 证据，`provenance = USER_OBSERVED`
 * 2. **不得压倒真实数据**：若已有充足真实数据且与之冲突，**记录冲突并拒绝覆盖**
 * 3. **无真实数据时也受限**：置信度 ≤ `USER_HINT_CONFIDENCE_CAP`，
 *    概率 ≤ `USER_HINT_PROBABILITY_CAP` —— 一键「疑似上头」不会直接给 0.95
 */
export function resolveUserHints(
  hints: readonly UserObservedHint[],
  realData: {
    recentOpportunities: number;
    confidence: number;
    dominantState: DynamicState;
  },
  /** 计算基准时刻：**晚于它**的观察不得影响当前判断（独立红队 F7） */
  asOf?: number,
): HintResolution {
  if (hints.length === 0) {
    return { state: null, confidence: 0, conflicts: Object.freeze([]), overridden: false };
  }

  const conflicts: string[] = [];

  // ---- 1. 过滤未来观察（独立红队 F7）----
  //
  // 修复前 `timestamp` 完全不参与校验：时间戳 2099 与 2020 的输出**逐位一致**。
  // 一条「未来才会发生的观察」影响现在的判断，与未来事件影响偏差是同一类错误。
  const usable = hints.filter((h) => {
    if (asOf === undefined) return true;
    const time = Date.parse(h.timestamp);
    if (Number.isNaN(time)) {
      conflicts.push(`人工观察的 timestamp 无法解析（${String(h.timestamp)}）—— 已忽略`);
      return false;
    }
    if (time > asOf) {
      conflicts.push(`人工观察发生在 asOf 之后（${h.timestamp}）—— 已忽略，不得影响当前判断`);
      return false;
    }
    return true;
  });
  if (usable.length === 0) {
    return { state: null, confidence: 0, conflicts: Object.freeze(conflicts), overridden: false };
  }

  // ---- 2. 取**时间戳最新**的一条，而不是数组最后一条（独立红队 F7）----
  //
  // 修复前用 `hints[hints.length - 1]`：调用方按旧→新排列时结果正确，
  // 按新→旧排列时就取到了**最旧**的观察（实测 `[NORMAL(新), SUSPECT_TILT(旧)]`
  // 会输出 `TILT_SIGNAL`）。顺序不该由数组下标决定。
  const hint = usable.reduce((latest, h) =>
    Date.parse(h.timestamp) > Date.parse(latest.timestamp) ? h : latest,
  );
  const state = HINT_TO_STATE[hint.kind];
  if (state === null) {
    return { state: null, confidence: 0, conflicts: Object.freeze(conflicts), overridden: false };
  }

  const hasSolidRealData =
    realData.recentOpportunities >= MIN_RECENT_OPPORTUNITIES * 2 && realData.confidence >= 0.5;

  // ---- 3. 与真实数据冲突检测 ----
  if (hasSolidRealData && state !== realData.dominantState && state !== DynamicState.NORMAL) {
    conflicts.push(
      `人工观察（${hint.kind}）与真实数据（${realData.dominantState}）不一致 —— 真实数据优先，人工观察仅作记录`,
    );
    return { state: null, confidence: 0, conflicts: Object.freeze(conflicts), overridden: true };
  }

  // ---- 4. 有充足真实数据但结论不同、且两者都非 NORMAL → 必须**可见**（独立红队 F7）----
  //
  // 修复前这种情形直接 `return state`，而主流程在
  // `confidence >= 0.5 && hint.state !== dominantState` 分支**什么都不做**，
  // 于是 Hint 被**静默丢弃**：没有 conflict 记录，`overridden` 仍是 false，
  // 调用方无法察觉自己点的那一项被忽略了。
  if (hasSolidRealData && state !== realData.dominantState) {
    conflicts.push(
      `人工观察（${hint.kind}）与真实数据（${realData.dominantState}）不一致 —— ` +
        '真实数据充足，因此人工观察不改变结论（已记录以保持一致）',
    );
    return { state, confidence: 0, conflicts: Object.freeze(conflicts), overridden: false };
  }

  const hintConfidence = Math.min(USER_HINT_CONFIDENCE_CAP, 0.25 + realData.confidence * 0.2);
  return { state, confidence: hintConfidence, conflicts: Object.freeze(conflicts), overridden: false };
}

/* ============================================================
 * 八、调整（方向 only）
 * ============================================================ */

/**
 * 由状态推导**方向性**调整。
 *
 * ⚠️ 刻意**没有 `multiplier` 字段**（规范第 37 / 38 节）。
 * 需要数值的调用方必须走 `dynamicAdapter.ts`，那里会显式标注 `UNVERIFIED_MAGNITUDE`。
 */
export function deriveAdjustments(input: {
  dominantState: DynamicState;
  signals: readonly DynamicSignal[];
  confidence: number;
  evidenceEventIds: readonly string[];
}): DynamicRangeAdjustment[] {
  const adjustments: DynamicRangeAdjustment[] = [];
  const add = (
    target: DynamicAdjustmentTarget,
    direction: 'INCREASE' | 'DECREASE',
    reason: string,
  ): void => {
    if (input.confidence <= 0) return;
    adjustments.push({
      target,
      direction,
      confidence: input.confidence,
      reasons: Object.freeze([reason]),
      evidenceEventIds: input.evidenceEventIds,
    });
  };

  const has = (state: DynamicState): boolean =>
    input.dominantState === state || input.signals.some((s) => s.state === state);
  const probabilityOf = (state: DynamicState): number => {
    if (input.dominantState === state) return 1;
    return input.signals.find((s) => s.state === state)?.probability ?? 0;
  };
  /**
   * ⚠️ **刻意不再乘 `input.confidence`**（Step 7 红队修复，v1.1.0）。
   *
   * 原先 `weightOf = probabilityOf × confidence`，而
   * `probabilityOf` 本身已经由 `groupSignal` 从**置信度加权的组分数**推出 ——
   * 同一个 `confidence` 在 `aggregateGroup` → `groupSignal` → 这里被连乘三次，
   * 于是一个 20 次机会、变化幅度 30 个百分点的玩家，
   * 最终权重只剩 `0.45 × 0.5 × 0.5 ≈ 0.11`，方向调整被静默丢弃。
   *
   * 置信度的职责是**独立输出给调用方**（`DynamicRangeAdjustment.confidence`），
   * 而不是在内部把自己乘小。样本保护已经由窗口层的收缩负责，不需要再压一次。
   */
  const weightOf = (state: DynamicState): number => probabilityOf(state);

  // 近期变松 → 范围更宽
  if (weightOf(DynamicState.LOOSER_RECENTLY) > 0.15) {
    add(DynamicAdjustmentTarget.RANGE_WIDTH, 'INCREASE', '近期入池频率高于个人基线');
  }
  // 近期变紧 → 范围更窄
  if (weightOf(DynamicState.TIGHTER_RECENTLY) > 0.15) {
    add(DynamicAdjustmentTarget.RANGE_WIDTH, 'DECREASE', '近期入池频率低于个人基线');
  }
  // 进攻性上升 → 加注/下注似然上升、诈唬与价值都要考虑
  if (weightOf(DynamicState.AGGRESSION_UP) > 0.15) {
    add(DynamicAdjustmentTarget.AGGRESSION_LIKELIHOOD, 'INCREASE', '近期主动进攻频率高于个人基线');
    add(DynamicAdjustmentTarget.BLUFF_LIKELIHOOD, 'INCREASE', '进攻性上升可能包含更多诈唬');
    add(DynamicAdjustmentTarget.VALUE_LIKELIHOOD, 'INCREASE', '进攻性上升也可能包含更多价值下注');
  }
  // 进攻性下降 → 下注/加注似然下降、弃牌似然上升
  if (weightOf(DynamicState.AGGRESSION_DOWN) > 0.15) {
    add(DynamicAdjustmentTarget.AGGRESSION_LIKELIHOOD, 'DECREASE', '近期主动进攻频率低于个人基线');
    add(DynamicAdjustmentTarget.FOLD_LIKELIHOOD, 'INCREASE', '进攻性下降通常伴随更愿意弃牌');
  }
  // 尺寸异常 → 尺寸不能给方向（只能说「异常」），因此只调似然
  if (weightOf(DynamicState.SIZE_ANOMALY) > 0.15) {
    add(DynamicAdjustmentTarget.BLUFF_LIKELIHOOD, 'INCREASE', '下注尺寸偏离个人基线 —— 尺寸异常本身不是价值信号');
  }
  // 追损 / 上头 → 跟注似然上升、弃牌似然下降
  if (weightOf(DynamicState.CHASE_LOSS_SIGNAL) > 0.2 || weightOf(DynamicState.TILT_SIGNAL) > 0.2) {
    add(DynamicAdjustmentTarget.CALL_LIKELIHOOD, 'INCREASE', '损失之后行为偏移，可能更倾向于跟注');
    add(DynamicAdjustmentTarget.FOLD_LIKELIHOOD, 'DECREASE', '损失之后行为偏移，可能更不愿意弃牌');
  }

  return adjustments;
}

/* ============================================================
 * 九、深冻结
 * ============================================================ */

/**
 * 递归深冻结。
 *
 * 参照范围引擎与玩家画像的教训：`Object.freeze(数组)` **不冻结元素**。
 * 因此快照里的每个数组元素、每个嵌套对象都必须逐层冻结。
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

/* ============================================================
 * 十、主入口
 * ============================================================ */

/**
 * 计算玩家的动态行为快照。
 *
 * Fail Closed：基线缺失、数值非法、玩家不匹配一律返回失败，
 * **绝不用人口平均生成一个「看起来合理」的高置信结果**（规范第 62 节）。
 */
export function evaluateDynamicBehavior(
  input: DynamicBehaviorInput,
): DynamicOutcome<DynamicBehaviorSnapshot> {
  const warnings: string[] = [];

  // ---- 1. 基线存在性（Fail Closed）----
  if (!input.baseline || typeof input.baseline !== 'object') {
    return dynamicFailure(DynamicErrorCode.MISSING_BASELINE, { playerId: input.playerId });
  }
  if (input.baseline.playerId !== input.playerId) {
    return dynamicFailure(DynamicErrorCode.PLAYER_MISMATCH, {
      expected: input.playerId,
      actual: input.baseline.playerId,
    });
  }

  // ---- 2. 数值合法性（Fail Closed）----
  //
  // ⚠️ `asOf` 必须先验（独立红队 F9）：`NaN` / `Infinity` 会让
  // `timestamp > asOf` **永远为假** → 未来事件全部进入计算，
  // 而且非法值会被原样写进快照（JSON 序列化成 `null`）。
  if (!Number.isFinite(input.asOf)) {
    return dynamicFailure(DynamicErrorCode.INVALID_AS_OF, { asOf: String(input.asOf) });
  }
  const baselineProblems = validateBaseline(input.baseline);
  if (baselineProblems.length > 0) {
    return dynamicFailure(DynamicErrorCode.INVALID_NUMERIC, {
      detail: baselineProblems.slice(0, 3).join('；'),
      count: baselineProblems.length,
    });
  }

  // ---- 3. 事件规范化（幂等 / 排序 / 未来过滤）----
  const normalized = normalizeEvents(input.recentEvents, input.asOf);

  // ---- 4. 窗口 ----
  const { windows, deviations } = buildWindows(normalized.ordered, input.baseline, ALL_WINDOW_SIZES);
  if (deviations.length > 0) {
    return dynamicFailure(DynamicErrorCode.INVALID_NUMERIC, {
      detail: deviations.slice(0, 3).join('；'),
      count: deviations.length,
    });
  }

  const primaryWindow = windows.find((w) => w.size === WindowSize.W20) ?? windows[windows.length - 1]!;
  /** 窗口内**全部**指标的机会总数（仅用于显示与工作量估算） */
  const recentOpportunities = totalOpportunities(primaryWindow);

  // ---- 5. 基线覆盖度与质量 ----
  const metricsWithBaseline = Object.keys(input.baseline.metrics).length;
  const comparableStats = primaryWindow.stats.filter((s) =>
    baselineUsable(input.baseline, s.metric),
  );
  const baselineCoverage =
    primaryWindow.stats.length > 0 ? comparableStats.length / primaryWindow.stats.length : 0;
  const baselineQuality =
    metricsWithBaseline > 0
      ? Object.values(input.baseline.metrics).reduce((sum, s) => sum + (s?.confidence ?? 0), 0) /
        metricsWithBaseline
      : 0;

  // ---- 6. 组偏差（在 20 手窗口上计算，兼顾稳定性与敏感度）----
  const groups = computeGroupDeviations(primaryWindow);
  const conflicts = detectConflicts(primaryWindow);

  // ---- 7. 上下文事件（只作时间锚点）----
  const contextCheck = validateContextEvents(
    input.contextEvents ?? [],
    input.playerId,
    input.asOf,
  );
  const context = analyzeContextEvents(
    normalized.ordered,
    contextCheck.accepted,
    input.baseline,
  );

  // ---- 8. 置信度 ----
  //
  // ⚠️ **样本充分性用「参与比较的指标中最小的机会数」，不是跨指标总数**
  // （独立红队 F2）。
  //
  // 原先用 `totalOpportunities(W20)`（所有指标机会**之和**）：
  // 一手牌若声明 8 个机会就脱离 UNKNOWN，而其中 7 个可以是与基线无法比较的指标；
  // 更要命的是 `2 手 → confidence 0.900`（总机会 26 / 24 被截断到 1），
  // 而 `20 手 → 0.851` —— **置信度随样本增加而下降**，且用 2 手牌
  // 就能拿到满额 1.2523× 范围因子。那直接违反「不确定时宁可说不知道」。
  //
  // 现在：`样本项 = 可比指标中最小的机会数`。任一指标样本不足，
  // 整体置信度就被它拉下来 —— 与 `dynamicConfidence` 取**最小值**的立场一致。
  const minComparableOpportunities = comparableStats.reduce(
    (min, s) => (s.opportunities < min ? s.opportunities : min),
    Number.POSITIVE_INFINITY,
  );
  const sampleOpportunities = Number.isFinite(minComparableOpportunities)
    ? minComparableOpportunities
    : 0;
  const consistency = windowConsistency(windows);
  const confidence = dynamicConfidence({
    baselineCoverage,
    baselineQuality,
    recentOpportunities: sampleOpportunities,
    consistency,
  });

  // ---- 9. 状态 ----
  //
  // ⚠️ 充分性门槛用**每项指标的机会数**，不是跨指标总数（独立红队 F2）。
  //
  // 修复前 `MIN_RECENT_OPPORTUNITIES` 比较的是 `totalOpportunities(W20)`：
  // 一手牌声明 8 个机会就脱离 UNKNOWN，而每项指标可能只有 0~1 次观测 ——
  // 于是 1/1 的 VPIP 被当成真实偏差。现在要求**至少一项指标**
  // 自身达到门槛，这样「1 手塞 13 个指标」不再能骗过判定。
  const sufficientMetrics = comparableStats.filter(
    (s) => s.opportunities >= MIN_RECENT_OPPORTUNITIES,
  ).length;
  const perMetricOpportunities = comparableStats.reduce(
    (max, s) => (s.opportunities > max ? s.opportunities : max),
    0,
  );
  const derived = deriveState({
    groups,
    windows,
    conflicts,
    recentOpportunities: perMetricOpportunities,
    totalOpportunities: recentOpportunities,
    sufficientMetrics,
    confidence,
    contextShift: context.postShift,
    contextNote: context.note,
    ignoredCount: normalized.ignored.length,
  });

  // ---- 10. 人工 Hint（受限，且不得压倒真实数据）----
  const hint = resolveUserHints(
    input.userHints ?? [],
    {
      recentOpportunities,
      confidence,
      dominantState: derived.dominantState,
    },
    input.asOf,
  );
  let dominantState = derived.dominantState;
  let finalConfidence = confidence;
  let stateProvenance: DynamicBehaviorSnapshot['stateProvenance'] = 'OBSERVED_BEHAVIOR';
  // Hint 覆盖状态时，tilt 也必须同步（独立红队 F7）
  let tilt: TiltSignal = derived.tilt;
  const finalConflicts = [...conflicts];

  // Hint 自身的记录（未来观察被忽略 / 与真实数据冲突）**始终**可见
  finalConflicts.push(...hint.conflicts);

  if (!hint.overridden && hint.state !== null) {
    // 只在真实数据**不足**时，人工观察才可能成为主导状态
    if (confidence < 0.5) {
      dominantState = hint.state;
      finalConfidence = Math.min(hint.confidence, USER_HINT_PROBABILITY_CAP);
      stateProvenance = 'USER_HINT';
      // ⚠️ 修复前这里只改 `dominantState`，不改 `tilt` ——
      // 结果快照同时说「状态 = TILT_SIGNAL」和「Tilt 概率 = 0」，
      // 而 `deriveAdjustments` 又按 `dominantState` 匹配，
      // 于是还输出了 `CALL_LIKELIHOOD` / `FOLD_LIKELIHOOD` 调整。
      // 三个字段互相矛盾，使用者无法判断该信哪个。
      //
      // 现在：状态被人工观察覆盖时，Tilt 概率取该观察的置信度
      //（**不超过** USER_HINT_PROBABILITY_CAP，且来源可追溯）。
      if (hint.state === DynamicState.TILT_SIGNAL) {
        const probability = Math.min(hint.confidence, USER_HINT_PROBABILITY_CAP);
        tilt = Object.freeze({
          probability,
          confidence: hint.confidence,
          evidence: Object.freeze([
            '来源：人工观察（USER_OBSERVED），没有真实行为证据支撑',
          ]),
        });
      }
    } else if (hint.state === dominantState) {
      // 与真实数据一致 → 略微提升置信度（但仍在上限内）
      finalConfidence = Math.min(1, confidence + 0.05);
    }
  }
  if (normalized.orderingConflicts > 0) {
    warnings.push(`存在 ${normalized.orderingConflicts} 处同手牌序号冲突，排序可能不稳定`);
    finalConfidence = finalConfidence * 0.8;
  }

  // ---- 11. 总分（**只由真实行为偏差构成**）----
  const deviationScore = deviationScoreOf(groups);

  // ---- 12. 调整 ----
  const evidenceEventIds = Object.freeze(primaryWindow.eventIds);
  const adjustments = deriveAdjustments({
    dominantState,
    signals: derived.signals,
    confidence: finalConfidence,
    evidenceEventIds,
  });

  // ---- 13. 快照（深冻结）----
  const snapshot: DynamicBehaviorSnapshot = deepFreeze({
    playerId: input.playerId,
    asOf: input.asOf,
    deviationScore,
    confidence: finalConfidence,
    dominantState,
    stateProvenance,
    signals: derived.signals,
    groupScores: Object.freeze(groups),
    windows: Object.freeze(windows),
    tilt,
    adjustments: Object.freeze(adjustments),
    evidenceEventIds,
    ignoredEvents: Object.freeze([
      ...normalized.ignored,
      // 被拒绝的上下文事件也必须可见（独立红队 F6：不得静默丢弃）
      ...contextCheck.rejected.map((r) => ({
        eventId: r.eventId,
        reason: `上下文事件被忽略：${r.reason}`,
      })),
    ]),
    conflicts: Object.freeze(finalConflicts),
    explanation: Object.freeze([
      ...derived.explanation,
      ...(warnings.length > 0 && derived.explanation.length < 3 ? [warnings[0]!] : []),
    ].slice(0, 3)),
    version: DYNAMIC_MODEL_VERSION,
  });

  return { ok: true, value: snapshot };
}

/* ============================================================
 * 十一、热路径性能辅助
 * ============================================================ */

/**
 * 估算一次评估需要处理的观测数。
 *
 * 用于**不做实际计算**就判断时间预算是否够 ——
 * Dynamic 是热路径模块（目标 P95 < 20ms，规范第 48 节）。
 */
export function estimateWorkload(input: DynamicBehaviorInput): {
  events: number;
  observations: number;
  windowEvents: number;
} {
  const windowEvents = takeWindow(
    normalizeEvents(input.recentEvents, input.asOf).ordered,
    WindowSize.W50,
  ).length;
  return {
    events: input.recentEvents.length,
    observations: input.recentEvents.reduce((sum, e) => sum + e.opportunities.length, 0),
    windowEvents,
  };
}

export { MAX_SINGLE_EVENT_SHARE } from './dynamic.types.ts';
