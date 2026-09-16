/**
 * rt7-probe3.ts —— 假阳性批量统计 + 「宽度冒充深度」的样本保护失效
 *
 * 用确定性 LCG 生成**完全符合基线**的数据（每个指标的真实率 = 基线率），
 * 批量统计系统报告的误报率。绝不使用 Math.random。
 *
 * 运行：node.exe --experimental-strip-types "scripts/rt7-probe3.ts"
 */

import { adaptAdjustments } from '../src/domain/dynamic/dynamicAdapter.ts';
import { MIN_RECENT_OPPORTUNITIES, SUFFICIENT_RECENT_OPPORTUNITIES } from '../src/domain/dynamic/dynamic.types.ts';

import {
  AS_OF,
  PLAYER,
  T0,
  fmt,
  groupOf,
  lcg,
  makeBaseline,
  makeInput,
  mustOk,
  percentile,
  run,
  signalOf,
  table,
} from './rt7-lib.ts';
import type { ObservedPokerEvent, TableRow } from './rt7-lib.ts';

/** 13 个已登记进 METRIC_GROUP 的指标 —— 一个务实的记录器大致会记这些 */
const RATES: Record<string, number> = {
  VPIP: 0.22,
  PFR: 0.17,
  LIMP: 0.05,
  OPEN: 0.28,
  CALL_OPEN: 0.14,
  THREE_BET: 0.06,
  FOUR_BET: 0.02,
  CALL_THREE_BET: 0.3,
  CALL_CBET: 0.42,
  RIVER_CALL: 0.38,
  RIVER_BET: 0.33,
  RIVER_RAISE: 0.09,
  RIVER_FOLD: 0.48,
};
const METRICS = Object.keys(RATES);

function generate(seed: number, handsCount: number, appear: number): ObservedPokerEvent[] {
  const rand = lcg(seed);
  const events: ObservedPokerEvent[] = [];
  for (let h = 1; h <= handsCount; h++) {
    const opportunities: Array<{ metric: string; success: boolean }> = [];
    for (const metric of METRICS) {
      // 机会是否存在由「牌局状态」决定 —— 这里用独立的伯努利近似
      if (rand() < appear) opportunities.push({ metric, success: rand() < RATES[metric]! });
    }
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

function ensemble(label: string, handsCount: number, appear: number, seeds: number): void {
  const scores: number[] = [];
  let nonNormal = 0;
  let withConflict = 0;
  let withAdjustment = 0;
  let looser = 0;
  let tighter = 0;
  let scoreOver20 = 0;
  let scoreOver30 = 0;
  let maxMultiplierDeviation = 0;
  let unknown = 0;
  const stateCounts: Record<string, number> = {};
  let sampleSnapshot: string = '';
  let confidenceSum = 0;

  for (let seed = 1; seed <= seeds; seed++) {
    const baseline = makeBaseline(RATES);
    const events = generate(seed * 7919, handsCount, appear);
    const outcome = run(makeInput(baseline, events));
    if (!outcome.ok) throw new Error(`期望 ok，得到 ${outcome.code}`);
    const snap = outcome.value;
    scores.push(snap.deviationScore);
    confidenceSum += snap.confidence;
    if (snap.dominantState === 'UNKNOWN') unknown++;
    else if (snap.dominantState !== 'NORMAL') {
      nonNormal++;
      if (snap.dominantState === 'LOOSER_RECENTLY') looser++;
      if (snap.dominantState === 'TIGHTER_RECENTLY') tighter++;
    }
    stateCounts[snap.dominantState] = (stateCounts[snap.dominantState] ?? 0) + 1;
    if (snap.conflicts.length > 0) withConflict++;
    if (snap.adjustments.length > 0) withAdjustment++;
    if (snap.deviationScore > 20) scoreOver20++;
    if (snap.deviationScore > 30) scoreOver30++;
    for (const adapted of adaptAdjustments(snap)) {
      maxMultiplierDeviation = Math.max(maxMultiplierDeviation, Math.abs(adapted.multiplier - 1));
    }
    if (sampleSnapshot === '' && snap.dominantState !== 'NORMAL') {
      sampleSnapshot = `seed=${seed * 7919} 状态=${snap.dominantState} 分数=${snap.deviationScore} 冲突=${JSON.stringify(
        snap.conflicts,
      )} 调整=${JSON.stringify(snap.adjustments.map((a) => [a.target, a.direction, fmt(a.confidence, 3)]))}`;
    }
  }
  const sorted = [...scores].sort((a, b) => a - b);
  console.log('');
  console.log(`—— ${label}（${seeds} 个种子，每手出现概率 ${appear}）——`);
  const rows: TableRow[] = [
    { 指标: 'deviationScore 均值', 值: fmt(scores.reduce((a, b) => a + b, 0) / scores.length, 2) },
    { 指标: 'deviationScore P50', 值: fmt(percentile(sorted, 50), 0) },
    { 指标: 'deviationScore P95', 值: fmt(percentile(sorted, 95), 0) },
    { 指标: 'deviationScore MAX', 值: fmt(sorted[sorted.length - 1], 0) },
    { 指标: 'confidence 均值', 值: fmt(confidenceSum / seeds, 3) },
    { 指标: 'UNKNOWN 比例', 值: `${unknown}/${seeds} = ${fmt((unknown / seeds) * 100, 1)}%` },
    { 指标: '状态 ≠ NORMAL 比例（误报）', 值: `${nonNormal}/${seeds} = ${fmt((nonNormal / seeds) * 100, 1)}%` },
    { 指标: '  ↳ LOOSER_RECENTLY', 值: `${looser} = ${fmt((looser / seeds) * 100, 1)}%` },
    { 指标: '  ↳ TIGHTER_RECENTLY', 值: `${tighter} = ${fmt((tighter / seeds) * 100, 1)}%` },
    { 指标: '出现「方向冲突」提示的比例', 值: `${withConflict}/${seeds} = ${fmt((withConflict / seeds) * 100, 1)}%` },
    { 指标: '产生调整（非空 adjustments）比例', 值: `${withAdjustment}/${seeds} = ${fmt((withAdjustment / seeds) * 100, 1)}%` },
    { 指标: 'deviationScore > 20 比例', 值: `${scoreOver20} = ${fmt((scoreOver20 / seeds) * 100, 1)}%` },
    { 指标: 'deviationScore > 30 比例', 值: `${scoreOver30} = ${fmt((scoreOver30 / seeds) * 100, 1)}%` },
    { 指标: '误报调整的最大幅度 |因子−1|', 值: fmt(maxMultiplierDeviation, 4) },
  ];
  table(rows);
  console.log(`   状态分布：${JSON.stringify(stateCounts)}`);
  if (sampleSnapshot) console.log(`   一个误报样例：${sampleSnapshot}`);
}

console.log('='.repeat(96));
console.log('A. 假阳性：数据**完全由基线率生成**（真值 = 基线），任何报告都是误报');
console.log(`   指标数 = ${METRICS.length}，基线 confidence 0.9 / opportunities 400`);
console.log('='.repeat(96));

ensemble('20 手历史（每手几乎全指标出现）', 20, 0.95, 400);
ensemble('40 手历史（每手几乎全指标出现）', 40, 0.95, 400);
ensemble('20 手历史（每指标出现概率 0.4，样本较稀疏）', 20, 0.4, 400);

console.log('');
console.log('='.repeat(96));
console.log('B. 「宽度冒充深度」：机会总数把足够的门槛骗过去了吗');
console.log(`   MIN_RECENT_OPPORTUNITIES = ${MIN_RECENT_OPPORTUNITIES}（总机会数门槛）`);
console.log(`   SUFFICIENT_RECENT_OPPORTUNITIES = ${SUFFICIENT_RECENT_OPPORTUNITIES}（confidence 的样本刻度分母 ÷3 = 24）`);
console.log('='.repeat(96));

const rowsB: TableRow[] = [];
for (const handsCount of [1, 2, 3, 5, 8, 20]) {
  const events = generate(12345, handsCount, 0.95);
  const totalOpps = events.reduce((sum, e) => sum + e.opportunities.length, 0);
  const baseline = makeBaseline(RATES);
  const snap = mustOk(run(makeInput(baseline, events)));
  rowsB.push({
    手数: handsCount,
    总机会数: totalOpps,
    '每指标机会(最大)': Math.max(
      ...snap.windows[0]!.stats.map((s) => s.opportunities),
    ),
    状态: snap.dominantState,
    deviation: snap.deviationScore,
    置信: fmt(snap.confidence, 4),
    调整数: snap.adjustments.length,
    调整幅度: adaptAdjustments(snap)
      .map((a) => `${a.target}:${fmt(a.multiplier, 4)}`)
      .join(' '),
  });
}
table(rowsB);

console.log('');
console.log('  极端构造：1 手牌里塞进 13 个指标的机会，且 VPIP 命中（真实率无从谈起）');
const oneHand: ObservedPokerEvent[] = [
  {
    eventId: 'e1',
    handId: 'h1',
    playerId: PLAYER,
    seq: 1,
    timestamp: new Date(T0 + 60_000).toISOString(),
    opportunities: METRICS.map((m) => ({ metric: m, success: m === 'VPIP' })),
  },
];
{
  const baseline = makeBaseline(RATES);
  const snap = mustOk(run(makeInput(baseline, oneHand)));
  console.log(`    1 手 / ${oneHand[0]!.opportunities.length} 个机会 → 状态=${snap.dominantState} 置信=${fmt(snap.confidence, 4)} 分数=${snap.deviationScore} 调整=${snap.adjustments.length}`);
  console.log(`    explanation = ${JSON.stringify(snap.explanation)}`);
}

console.log('  极端构造：同一手牌塞进 24 个机会（含 12 个未登记进 METRIC_GROUP 的真实指标）');
const UNREGISTERED = [
  'FOLD_TO_THREE_BET',
  'CBET',
  'FOLD_TO_CBET',
  'RAISE_CBET',
  'CHECK_RAISE_FLOP',
  'TURN_BARREL',
  'TURN_FOLD',
  'TURN_RAISE',
  'TURN_CHECK_RAISE',
  'RIVER_BARREL',
  'RIVER_OVERBET',
  'RIVER_SHOWDOWN',
];
{
  const allRates: Record<string, number> = { ...RATES };
  for (const m of UNREGISTERED) allRates[m] = 0.4;
  const baseline = makeBaseline(allRates);
  const events: ObservedPokerEvent[] = [
    {
      eventId: 'e1',
      handId: 'h1',
      playerId: PLAYER,
      seq: 1,
      timestamp: new Date(T0 + 60_000).toISOString(),
      opportunities: Object.keys(allRates).map((m) => ({ metric: m, success: m === 'VPIP' })),
    },
  ];
  const snap = mustOk(run(makeInput(baseline, events)));
  console.log(`    1 手 / ${events[0]!.opportunities.length} 个机会 → 状态=${snap.dominantState} 置信=${fmt(snap.confidence, 4)} 分数=${snap.deviationScore} 调整=${snap.adjustments.length}`);
  console.log(`    explanation = ${JSON.stringify(snap.explanation)}`);
}

console.log('');
console.log('='.repeat(96));
console.log('C. 同一构造成真值时，系统给了多少置信度 / 多大调整');
console.log('='.repeat(96));
{
  const rowsC: TableRow[] = [];
  for (const handsCount of [1, 2, 3, 5, 20]) {
    const rand = lcg(4242);
    const events: ObservedPokerEvent[] = [];
    for (let h = 1; h <= handsCount; h++) {
      events.push({
        eventId: `e${h}`,
        handId: `h${h}`,
        playerId: PLAYER,
        seq: h,
        timestamp: new Date(T0 + h * 60_000).toISOString(),
        opportunities: Object.keys(RATES).map((m) => ({ metric: m, success: rand() < 1 })),
      });
    }
    // 全部命中 → 除 VPIP/LIMP 外几乎全部指标都远高于基线
    const baseline = makeBaseline(RATES);
    const snap = mustOk(run(makeInput(baseline, events)));
    rowsC.push({
      手数: handsCount,
      状态: snap.dominantState,
      deviation: snap.deviationScore,
      置信: fmt(snap.confidence, 4),
      调整: adaptAdjustments(snap)
        .map((a) => `${a.target}=${fmt(a.multiplier, 4)}`)
        .join(' '),
    });
  }
  table(rowsC);
  console.log('   （该构造中每手每个指标都记为「命中」，即行为极端；用于观察置信度与幅度的天花板）');
}
void AS_OF;
void signalOf;
void groupOf;
