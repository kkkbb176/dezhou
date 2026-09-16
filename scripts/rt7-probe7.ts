/**
 * rt7-probe7.ts —— 热路径性能：1 / 10 / 50 / 200 / 1000 / 5000 事件的 P50 / P95 / MAX
 *
 * 目标：P95 < 20ms。另检查增长曲线是否线性。
 *
 * 运行：node.exe --experimental-strip-types "scripts/rt7-probe7.ts"
 */

import { evaluateDynamicBehavior, estimateWorkload } from '../src/domain/dynamic/dynamicBehavior.ts';

import { PLAYER, T0, fmt, makeBaseline, makeInput, percentile, table } from './rt7-lib.ts';
import type { ObservedPokerEvent, TableRow } from './rt7-lib.ts';

const RATES: Record<string, number> = {
  VPIP: 0.22, PFR: 0.17, LIMP: 0.05, OPEN: 0.28, CALL_OPEN: 0.14, THREE_BET: 0.06, FOUR_BET: 0.02,
  CALL_THREE_BET: 0.3, CALL_CBET: 0.42, RIVER_CALL: 0.38, RIVER_BET: 0.33, RIVER_RAISE: 0.09, RIVER_FOLD: 0.48,
  FOLD_TO_THREE_BET: 0.45, CBET: 0.6, FOLD_TO_CBET: 0.45, RAISE_CBET: 0.15, CHECK_RAISE_FLOP: 0.1,
  TURN_BARREL: 0.55, TURN_FOLD: 0.45, TURN_RAISE: 0.12, TURN_CHECK_RAISE: 0.08, RIVER_BARREL: 0.5,
  RIVER_OVERBET: 0.08, RIVER_SHOWDOWN: 0.5,
};
const METRICS = Object.keys(RATES);

function build(handsCount: number, perHand: number): ObservedPokerEvent[] {
  const events: ObservedPokerEvent[] = [];
  for (let h = 1; h <= handsCount; h++) {
    const opportunities = Array.from({ length: perHand }, (_, k) => ({
      metric: METRICS[k % METRICS.length]!,
      success: (h + k) % 3 === 0,
    }));
    events.push({
      eventId: `e${h}`,
      handId: `h${h}`,
      playerId: PLAYER,
      seq: h,
      timestamp: new Date(T0 + h * 60_000).toISOString(),
      opportunities,
    });
  }
  return events;
}

const baseline = makeBaseline(RATES);

function measure(handsCount: number, perHand: number, iterations: number): { p50: number; p95: number; max: number; mean: number } {
  const events = build(handsCount, perHand);
  const input = makeInput(baseline, events);
  for (let i = 0; i < Math.max(5, Math.min(50, iterations)); i++) evaluateDynamicBehavior(input);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    evaluateDynamicBehavior(input);
    samples.push(performance.now() - t0);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1]!,
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
  };
}

console.log('='.repeat(96));
console.log('热路径性能（每个事件 5 次机会；基线含 25 个指标）目标 P95 < 20ms');
console.log('='.repeat(96));
const rows: TableRow[] = [];
const timings: Array<[number, number]> = [];
for (const [handsCount, iterations] of [
  [1, 3000],
  [10, 3000],
  [50, 2000],
  [200, 1000],
  [1000, 300],
  [5000, 100],
] as Array<[number, number]>) {
  const m = measure(handsCount, 5, iterations);
  const workload = estimateWorkload(makeInput(baseline, build(handsCount, 5)));
  rows.push({
    事件数: handsCount,
    '观测数': workload.observations,
    'W50 事件数': workload.windowEvents,
    迭代: iterations,
    'P50(ms)': fmt(m.p50, 4),
    'P95(ms)': fmt(m.p95, 4),
    'MAX(ms)': fmt(m.max, 4),
    '均值(ms)': fmt(m.mean, 4),
    'P95 达标': m.p95 < 20 ? '是' : '否',
  });
  timings.push([handsCount, m.p50]);
}
table(rows);

console.log('');
console.log('增长曲线（以 P50 为准，检查是否线性）：');
for (let i = 1; i < timings.length; i++) {
  const [n0, t0] = timings[i - 1]!;
  const [n1, t1] = timings[i]!;
  const sizeRatio = n1 / n0;
  const timeRatio = t1 / t0;
  console.log(
    `  ${String(n0).padStart(5)} → ${String(n1).padStart(5)} 事件：规模 ×${fmt(sizeRatio, 2)}，耗时 ×${fmt(timeRatio, 2)}（超线性指数 ≈ ${fmt(Math.log(timeRatio) / Math.log(sizeRatio), 3)}）`,
  );
}

console.log('');
console.log('最坏情况：每个事件 25 次机会（全部指标都记）');
const worst: TableRow[] = [];
for (const handsCount of [50, 200, 1000]) {
  const m = measure(handsCount, 25, handsCount >= 1000 ? 100 : 500);
  worst.push({
    事件数: handsCount,
    '观测数': handsCount * 25,
    'P50(ms)': fmt(m.p50, 4),
    'P95(ms)': fmt(m.p95, 4),
    'MAX(ms)': fmt(m.max, 4),
    'P95 达标': m.p95 < 20 ? '是' : '否',
  });
}
table(worst);

console.log('');
console.log('更长历史：2500 / 10000 事件（观察是否继续超线性）');
{
  const longer: TableRow[] = [];
  for (const [handsCount, iterations] of [
    [2500, 150],
    [10000, 40],
  ] as Array<[number, number]>) {
    const m = measure(handsCount, 5, iterations);
    longer.push({
      事件数: handsCount,
      'P50(ms)': fmt(m.p50, 3),
      'P95(ms)': fmt(m.p95, 3),
      'MAX(ms)': fmt(m.max, 3),
      'P95 达标': m.p95 < 20 ? '是' : '否',
    });
  }
  table(longer);
}

console.log('');
console.log('成本归因：normalizeEvents 的排序比较器里**每次比较都调用 Date.parse**');
{
  const events = build(5000, 5);
  // (a) 直接测 5000 条时间戳的解析成本
  const parses = 5000 * Math.ceil(Math.log2(5000)) * 2;
  const t0 = performance.now();
  let sink = 0;
  for (let i = 0; i < parses; i++) sink += Date.parse(events[i % events.length]!.timestamp);
  const parseMs = performance.now() - t0;
  console.log(`  ${parses} 次 Date.parse（≈5000 条排序的两次/比较上界）耗时 = ${fmt(parseMs, 3)}ms（sink=${sink % 7}）`);

  // (b) 比较「比较器内解析」与「预解析」的排序耗时
  const t1 = performance.now();
  const a = [...events].sort((x, y) => {
    const tx = Date.parse(x.timestamp);
    const ty = Date.parse(y.timestamp);
    if (tx !== ty) return tx - ty;
    return x.seq - y.seq;
  });
  const inComparator = performance.now() - t1;
  const keyed = events.map((e) => [Date.parse(e.timestamp), e.seq, e.eventId, e] as const);
  const t2 = performance.now();
  keyed.sort((x, y) => (x[0] !== y[0] ? x[0] - y[0] : x[1] !== y[1] ? x[1] - y[1] : x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0));
  const precomputed = performance.now() - t2;
  console.log(`  5000 条排序：比较器内 Date.parse = ${fmt(inComparator, 3)}ms；预解析后排序 = ${fmt(precomputed, 3)}ms`);
  console.log(`  仅排序一项就占 5000 事件总耗时（P50 ≈ 20ms）的 ${fmt((inComparator / 20) * 100, 1)}%`);
  void a;
}

console.log('');
console.log('estimateWorkload 开销（目标：不做实际计算即给出估算）');
{
  const events = build(1000, 5);
  const input = makeInput(baseline, events);
  const samples: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    estimateWorkload(input);
    samples.push(performance.now() - t0);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(`  1000 事件：P50=${fmt(percentile(sorted, 50), 4)}ms P95=${fmt(percentile(sorted, 95), 4)}ms MAX=${fmt(sorted[sorted.length - 1], 4)}ms`);
  console.log(`  估算结果 = ${JSON.stringify(estimateWorkload(input))}`);
}
