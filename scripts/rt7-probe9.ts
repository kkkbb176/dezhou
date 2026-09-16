/**
 * rt7-probe9.ts —— 三个「头条」最小复现（可直接引用的判决级证据）
 *
 * 1) VPIP↑+PFR↓+3Bet↓（被动跟注变多）→ 与「只记 VPIP」的正确判决相反
 * 2) 完全照基线打、只有 2 手数据 → 0.900 置信度 + 三个 1.2523× 调整
 * 3) W20 窗口统计完全相同，仅因历史长度不同（60 手 vs 80 手）→ 方向从 NONE 翻成 HIGHER
 *
 * 运行：node.exe --experimental-strip-types "scripts/rt7-probe9.ts"
 */

import { adaptAdjustments } from '../src/domain/dynamic/dynamicAdapter.ts';
import { evaluateDynamicBehavior } from '../src/domain/dynamic/dynamicBehavior.ts';

import { PLAYER, T0, fmt, lcg, makeBaseline, makeInput, mustOk, spread } from './rt7-lib.ts';
import type { ObservedPokerEvent } from './rt7-lib.ts';

function seq(n: number, mkOpp: (i: number) => Array<{ metric: string; success: unknown }>): ObservedPokerEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    eventId: `e${i + 1}`,
    handId: `h${i + 1}`,
    playerId: PLAYER,
    seq: i + 1,
    timestamp: new Date(T0 + (i + 1) * 60_000).toISOString(),
    opportunities: mkOpp(i),
  })) as unknown as ObservedPokerEvent[];
}

function show(label: string, rates: Record<string, number>, makeEvents: () => ObservedPokerEvent[]): void {
  const base = makeBaseline(rates);
  const v = mustOk(evaluateDynamicBehavior(makeInput(base, makeEvents())));
  console.log(`### ${label}`);
  console.log(`  dominantState = ${v.dominantState}   deviationScore = ${v.deviationScore}   confidence = ${fmt(v.confidence, 3)}`);
  console.log(`  conflicts     = ${JSON.stringify(v.conflicts)}`);
  console.log(`  explanation   = ${JSON.stringify(v.explanation)}`);
  console.log(`  tilt          = ${JSON.stringify({ p: v.tilt.probability, c: v.tilt.confidence, e: v.tilt.evidence })}`);
  console.log(`  signals       = ${JSON.stringify(v.signals.map((s) => [s.state, Number(s.probability.toFixed(3)), s.drivers]))}`);
  console.log(`  groupScores   = ${JSON.stringify(v.groupScores.map((g) => [g.group, Number(g.score.toFixed(3)), g.direction, g.strongestMetric]))}`);
  console.log(`  adjustments   = ${JSON.stringify(v.adjustments.map((a) => [a.target, a.direction, Number(a.confidence.toFixed(3))]))}`);
  console.log(`  adapters      = ${JSON.stringify(adaptAdjustments(v).map((x) => [x.target, x.direction, Number(x.multiplier.toFixed(4)), x.magnitudeProvenance]))}`);
  console.log('');
}

console.log('#'.repeat(96));
console.log('头条 1：40 手，VPIP 15%→90%、PFR 12%→0%、3Bet 7%→0%（被动跟注变多）');
console.log('#'.repeat(96));
const v1 = spread(40, 36);
const p1 = spread(40, 0);
const t1 = spread(40, 0);
show('场景 1-A：三条指标都记（信息更完整）', { VPIP: 0.15, PFR: 0.12, THREE_BET: 0.07 }, () =>
  seq(40, (i) => [
    { metric: 'VPIP', success: v1[i] },
    { metric: 'PFR', success: p1[i] },
    { metric: 'THREE_BET', success: t1[i] },
  ]),
);
show('场景 1-B：只记 VPIP（信息更少）', { VPIP: 0.15 }, () => seq(40, (i) => [{ metric: 'VPIP', success: v1[i] }]));

console.log('#'.repeat(96));
console.log('头条 2：置信度与幅度不看「每个指标有多少机会」，只看「跨指标机会总数」');
console.log('#'.repeat(96));
const RATES: Record<string, number> = {
  VPIP: 0.22, PFR: 0.17, LIMP: 0.05, OPEN: 0.28, CALL_OPEN: 0.14, THREE_BET: 0.06, FOUR_BET: 0.02,
  CALL_THREE_BET: 0.3, CALL_CBET: 0.42, RIVER_CALL: 0.38, RIVER_BET: 0.33, RIVER_RAISE: 0.09, RIVER_FOLD: 0.48,
};
const M = Object.keys(RATES);

/** (a) 真实行为 = 基线的玩家（LCG 按基线率抽样），只给 1 / 2 / 3 手 */
for (const handsCount of [1, 2, 3, 20]) {
  const rand = lcg(20260913);
  show(`2a) 真实行为**恰好等于基线**的玩家，只观测 ${handsCount} 手（每手 13 个指标机会）`, RATES, () =>
    seq(handsCount, () => M.map((m) => ({ metric: m, success: rand() < RATES[m]! }))),
  );
}

/** (b) 行为极端偏离的玩家，只给 2 手 —— 看系统给出多少置信度与多大范围因子 */
show('2b) 行为极端偏离的玩家，只有 2 手数据（每手 13 个指标机会）', RATES, () =>
  seq(2, () => M.map((m, k) => ({ metric: m, success: k % 3 === 0 }))),
);

console.log('#'.repeat(96));
console.log('头条 3：W20 窗口统计完全相同，仅历史长度不同 → 方向从 NONE 翻成 HIGHER');
console.log('#'.repeat(96));
{
  const base = makeBaseline({ VPIP: 0.15 });
  console.log(' n   全历史机会数   W20 raw  W20 机会  W20 adjusted    ENTRY 方向  状态             分数  RANGE↑');
  for (const n of [40, 50, 60, 70, 80, 100, 200]) {
    const s = Math.round(0.25 * n);
    const events = seq(n, (i) => [{ metric: 'VPIP', success: spread(n, s)[i] }]) as ObservedPokerEvent[];
    const v = mustOk(evaluateDynamicBehavior(makeInput(base, events)));
    const w = v.windows.find((x) => x.size === 20)!.stats[0]!;
    const entry = v.groupScores.find((g) => g.group === 'ENTRY')!;
    const up = v.adjustments.some((a) => a.target === 'RANGE_WIDTH' && a.direction === 'INCREASE');
    console.log(
      `${String(n).padStart(3)}  ${String(n).padStart(11)}  ${String(w.rawRate).padStart(8)}  ${String(w.opportunities).padStart(8)}  ${w.adjustedRate.toFixed(6).padStart(12)}  ${entry.direction.padStart(11)}  ${v.dominantState.padEnd(16)}  ${String(v.deviationScore).padStart(4)}  ${up ? '有' : '无'}`,
    );
  }
  console.log(' 真实率恒为 25%（n=40/60/200 时 s/n 恰好 0.250）。');
}
