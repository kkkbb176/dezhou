/**
 * rt7-lib.ts —— Step 7 独立红队审计的公共工具
 *
 * 审计员自己的、与作者测试无关的构造器。
 * 全部随机性来自确定性 LCG（**绝不使用 Math.random**）。
 */

import { evaluateDynamicBehavior } from '../src/domain/dynamic/dynamicBehavior.ts';
import type {
  BaselineMetricStat,
  ContextEvent,
  DynamicBehaviorInput,
  DynamicBehaviorSnapshot,
  DynamicOutcome,
  ObservedPokerEvent,
  PlayerProfileSnapshot,
  UserObservedHint,
} from '../src/domain/dynamic/dynamic.types.ts';

export const T0 = Date.parse('2026-01-01T00:00:00.000Z');
export const AS_OF = Date.parse('2026-06-01T00:00:00.000Z');
export const PLAYER = 'p1';

/** 确定性 LCG（Numerical Recipes 参数） */
export function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export type Opps = Record<string, boolean>;

export type EventOptions = {
  playerId?: string;
  seq?: number;
  ts?: number;
  eventId?: string;
  /** 额外字段（用于注入 betSizePotRatio / isOverbet / isAllIn / 任意脏数据） */
  extra?: Record<string, unknown>;
};

/** 构造一条真实事件：一手牌 = 一条事件，seq 默认等于 hand 序号 */
export function ev(hand: number, opps: Opps, options: EventOptions = {}): ObservedPokerEvent {
  const opportunities = Object.entries(opps).map(([metric, success]) => ({ metric, success }));
  const base: Record<string, unknown> = {
    eventId: options.eventId ?? `e${hand}`,
    handId: `h${hand}`,
    playerId: options.playerId ?? PLAYER,
    seq: options.seq ?? hand,
    timestamp: new Date(options.ts ?? T0 + hand * 60_000).toISOString(),
    opportunities,
  };
  if (options.extra) Object.assign(base, options.extra);
  return base as unknown as ObservedPokerEvent;
}

export type BaselineOptions = {
  opportunities?: number;
  confidence?: number;
  handsObserved?: number;
  version?: string;
};

export function baselineStat(rate: number, options: BaselineOptions = {}): BaselineMetricStat {
  const opportunities = options.opportunities ?? 400;
  const confidence = options.confidence ?? 0.9;
  return {
    metric: '' as never,
    successes: Math.round(rate * opportunities),
    opportunities,
    adjustedRate: rate,
    effectiveSampleSize: opportunities,
    confidence,
  };
}

/** 由「指标 → 长期比率」构造基线快照 */
export function makeBaseline(
  rates: Record<string, number>,
  options: BaselineOptions & { playerId?: string } = {},
): PlayerProfileSnapshot {
  const metrics: Record<string, BaselineMetricStat> = {};
  for (const [metric, rate] of Object.entries(rates)) {
    metrics[metric] = { ...baselineStat(rate, options), metric } as unknown as BaselineMetricStat;
  }
  return {
    playerId: options.playerId ?? PLAYER,
    handsObserved: options.handsObserved ?? 500,
    version: options.version ?? '6.0.0',
    metrics: metrics as PlayerProfileSnapshot['metrics'],
  };
}

export function makeInput(
  baseline: PlayerProfileSnapshot,
  events: readonly ObservedPokerEvent[],
  extra: Partial<DynamicBehaviorInput> = {},
): DynamicBehaviorInput {
  return {
    playerId: baseline.playerId,
    baseline,
    recentEvents: events,
    asOf: AS_OF,
    ...extra,
  };
}

export function run(input: DynamicBehaviorInput): DynamicOutcome<DynamicBehaviorSnapshot> {
  return evaluateDynamicBehavior(input);
}

/** 取快照；失败时抛出可读错误（探针里用于「本应成功」的路径） */
export function mustOk(outcome: DynamicOutcome<DynamicBehaviorSnapshot>): DynamicBehaviorSnapshot {
  if (!outcome.ok) {
    throw new Error(`期望 ok，实际失败：${outcome.code} ${JSON.stringify(outcome.params)}`);
  }
  return outcome.value;
}

/** 20 手窗口里的某个指标统计 */
export function w20(snapshot: DynamicBehaviorSnapshot, metric: string) {
  const window = snapshot.windows.find((w) => w.size === 20)!;
  return window.stats.find((s) => s.metric === metric);
}

export function groupOf(snapshot: DynamicBehaviorSnapshot, group: string) {
  return snapshot.groupScores.find((g) => g.group === group)!;
}

export function signalOf(snapshot: DynamicBehaviorSnapshot, state: string) {
  return snapshot.signals.find((s) => s.state === state) ?? null;
}

/** 在 n 手中均匀铺开 s 次成功（确定性 Bresenham，避免「全在前 / 全在后」的偏置） */
export function spread(n: number, s: number): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.floor(((i + 1) * s) / n) > Math.floor((i * s) / n));
  }
  return out;
}

/** 由「每手成功与否」的布尔数组生成事件序列，可附加其他固定机会 */
export function hands(
  flags: readonly boolean[],
  metric: string,
  other: Opps = {},
  startHand = 1,
): ObservedPokerEvent[] {
  return flags.map((success, i) => ev(startHand + i, { [metric]: success, ...other }));
}

export function fmt(x: number | null | undefined, digits = 4): string {
  if (x === null || x === undefined) return 'null';
  if (!Number.isFinite(x)) return String(x);
  return x.toFixed(digits);
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export type TableRow = Record<string, string | number>;

export function table(rows: Array<Record<string, string | number>>): void {
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]!);
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  console.log(line(keys));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(keys.map((k) => String(row[k] ?? ''))));
}

/** 递归遍历快照的全部对象/数组，用于不变量检查 */
export function walk(value: unknown, path: string, visit: (path: string, v: unknown) => void): void {
  visit(path, value);
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, visit));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${path}.${k}`, visit);
}

export type { DynamicBehaviorSnapshot, ObservedPokerEvent, ContextEvent, UserObservedHint };
