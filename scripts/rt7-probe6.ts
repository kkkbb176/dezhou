/**
 * rt7-probe6.ts —— A. 适配层 direction/multiplier 自相矛盾（修正构造）
 *                   B. 误报率随历史长度增长的曲线（方向检验与强度用了不同的样本量）
 *
 * 运行：node.exe --experimental-strip-types "scripts/rt7-probe6.ts"
 */

import { adaptAdjustments, describeAdaptation } from '../src/domain/dynamic/dynamicAdapter.ts';

import {
  PLAYER,
  T0,
  fmt,
  lcg,
  makeBaseline,
  makeInput,
  mustOk,
  percentile,
  run,
  spread,
  table,
} from './rt7-lib.ts';
import type { ObservedPokerEvent, TableRow } from './rt7-lib.ts';

console.log('='.repeat(96));
console.log('A. 适配层：FOLD_LIKELIHOOD 同时收到 INCREASE 与 DECREASE → 因子恰好回到 1');
console.log('='.repeat(96));
{
  const base = makeBaseline({ VPIP: 0.15, THREE_BET: 0.25, CALL_OPEN: 0.14 });
  const vpipFlags = [...spread(20, 3), ...spread(20, 12)];
  const events: ObservedPokerEvent[] = vpipFlags.map((f, i) => ({
    eventId: `e${i + 1}`,
    handId: `h${i + 1}`,
    playerId: PLAYER,
    seq: i + 1,
    timestamp: new Date(T0 + (i + 1) * 60_000).toISOString(),
    opportunities: [
      { metric: 'VPIP', success: f },
      { metric: 'THREE_BET', success: false },
      { metric: 'CALL_OPEN', success: true },
    ],
  }));
  const anchor = {
    contextEventId: 'c1',
    handId: 'h20',
    playerId: PLAYER,
    seq: 20,
    timestamp: new Date(T0 + 20 * 60_000).toISOString(),
    kind: 'LOST_BIG_POT' as const,
  };
  const snap = mustOk(run(makeInput(base, events, { contextEvents: [anchor] })));
  console.log(`  快照：状态=${snap.dominantState} 分数=${snap.deviationScore} 置信=${fmt(snap.confidence, 4)} tilt=${fmt(snap.tilt.probability, 4)}`);
  console.log(`  signals = ${JSON.stringify(snap.signals.map((s) => [s.state, fmt(s.probability, 3)]))}`);
  console.log(`  adjustments = ${JSON.stringify(snap.adjustments.map((a) => [a.target, a.direction, fmt(a.confidence, 4)]))}`);
  console.log('  adaptAdjustments 输出：');
  const adapted = adaptAdjustments(snap);
  for (const x of adapted) {
    console.log(`    ${describeAdaptation(x)}`);
    console.log(`      reasons = ${JSON.stringify(x.reasons)}`);
  }
  const contradictions = adapted.filter(
    (x) => x.multiplier === 1 || (x.direction === 'INCREASE' && x.multiplier < 1) || (x.direction === 'DECREASE' && x.multiplier > 1),
  );
  console.log(`  ⇒ 自相矛盾条数 = ${contradictions.length}`);
  for (const c of contradictions) {
    console.log(`     ${c.target}: direction=${c.direction} multiplier=${fmt(c.multiplier, 12)} reasons=${JSON.stringify(c.reasons)}`);
  }
}

console.log('');
console.log('='.repeat(96));
console.log('B. 误报率 vs 历史长度：数据恒等于基线，只有「近多少手进入统计」在变');
console.log('   （每手 13 个已登记指标全部出现；真值 = 基线率；400 个确定性种子）');
console.log('='.repeat(96));
{
  const RATES: Record<string, number> = {
    VPIP: 0.22, PFR: 0.17, LIMP: 0.05, OPEN: 0.28, CALL_OPEN: 0.14, THREE_BET: 0.06, FOUR_BET: 0.02,
    CALL_THREE_BET: 0.3, CALL_CBET: 0.42, RIVER_CALL: 0.38, RIVER_BET: 0.33, RIVER_RAISE: 0.09, RIVER_FOLD: 0.48,
  };
  const METRICS = Object.keys(RATES);
  const rows: TableRow[] = [];
  for (const handsCount of [20, 30, 40, 60, 100, 200]) {
    const scores: number[] = [];
    let nonNormal = 0;
    let conflicts = 0;
    let adjustments = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rand = lcg(seed * 104729);
      const events: ObservedPokerEvent[] = [];
      for (let h = 1; h <= handsCount; h++) {
        events.push({
          eventId: `e${h}`,
          handId: `h${h}`,
          playerId: PLAYER,
          seq: h,
          timestamp: new Date(T0 + h * 60_000).toISOString(),
          opportunities: METRICS.map((m) => ({ metric: m, success: rand() < RATES[m]! })),
        });
      }
      const snap = mustOk(run(makeInput(makeBaseline(RATES), events)));
      scores.push(snap.deviationScore);
      if (snap.dominantState !== 'NORMAL') nonNormal++;
      if (snap.conflicts.length > 0) conflicts++;
      if (snap.adjustments.length > 0) adjustments++;
    }
    const sorted = [...scores].sort((a, b) => a - b);
    rows.push({
      '历史手数': handsCount,
      '每手机会数': 13,
      'W20 内每指标机会': 20,
      '状态≠NORMAL': `${fmt((nonNormal / 400) * 100, 1)}%`,
      '有冲突提示': `${fmt((conflicts / 400) * 100, 1)}%`,
      '有调整': `${fmt((adjustments / 400) * 100, 1)}%`,
      '分数均值': fmt(scores.reduce((a, b) => a + b, 0) / scores.length, 1),
      '分数P95': fmt(percentile(sorted, 95), 0),
    });
  }
  table(rows);
  console.log('  机制：方向检验用的样本量 = countOpportunities(全部近期事件)（随手数增长而增长），');
  console.log('        强度与窗口统计只用 W20（恒为 ~20 次机会）；两者样本量不一致 →');
  console.log('        历史越长，方向越容易被判成 HIGHER/LOWER，而窗口内的随机波动没变 → 误报率随历史上升。');
}
