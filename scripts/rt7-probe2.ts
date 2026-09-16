/**
 * rt7-probe2.ts —— 假阴性结构分析：为什么「明显的变化」报不出来
 *
 * 三种相关性变体（只有 VPIP / VPIP↑+PFR↓ / VPIP↑+PFR↑）逐一对比。
 * 另附「冲突 → LOOSER_RECENTLY」分支可达性扫描。
 *
 * 运行：node.exe --experimental-strip-types "scripts/rt7-probe2.ts"
 */

import {
  PLAYER,
  fmt,
  groupOf,
  makeBaseline,
  makeInput,
  mustOk,
  run,
  signalOf,
  spread,
  table,
  w20,
} from './rt7-lib.ts';
import type { ObservedPokerEvent, TableRow } from './rt7-lib.ts';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function build(
  n: number,
  vpipS: number,
  pfrS: number | null,
): ObservedPokerEvent[] {
  const fv = spread(n, vpipS);
  const fp = pfrS === null ? null : spread(n, pfrS);
  return fv.map((v, i) => {
    const opportunities: Array<{ metric: string; success: boolean }> = [
      { metric: 'VPIP', success: v },
    ];
    if (fp) opportunities.push({ metric: 'PFR', success: fp[i]! });
    return {
      eventId: `e${i + 1}`,
      handId: `h${i + 1}`,
      playerId: PLAYER,
      seq: i + 1,
      timestamp: new Date(T0 + (i + 1) * 60_000).toISOString(),
      opportunities,
    };
  });
}

type Variant = {
  label: string;
  rates: Record<string, number>;
  pfrOf: (n: number) => number | null;
};

const variants: Variant[] = [
  {
    label: 'A 仅 VPIP（无 PFR 机会）',
    rates: { VPIP: 0.15 },
    pfrOf: () => null,
  },
  {
    label: 'B VPIP↑ + PFR↓（被动跟注变多，最经典）',
    rates: { VPIP: 0.15, PFR: 0.12 },
    pfrOf: () => 0,
  },
  {
    label: 'C VPIP↑ + PFR↑（整体变松且更激进）',
    rates: { VPIP: 0.15, PFR: 0.12 },
    pfrOf: (n) => Math.round(n * 0.36),
  },
];

for (const variant of variants) {
  console.log('='.repeat(96));
  console.log(`变体 ${variant.label}`);
  console.log('基线：' + JSON.stringify(variant.rates) + '，基线 confidence 0.9；近期成功率 = 基线 15% → 目标值');
  console.log('='.repeat(96));
  const rows: TableRow[] = [];
  for (const target of [0.15, 0.25, 0.35, 0.45, 0.6, 0.8, 1.0]) {
    for (const n of [20]) {
      const s = Math.round(target * n);
      const base = makeBaseline(variant.rates);
      const events = build(n, s, variant.pfrOf(n));
      const snap = mustOk(run(makeInput(base, events)));
      const vpip = w20(snap, 'VPIP')!;
      rows.push({
        '目标率': fmt(target, 2),
        'VPIP': `${s}/${n}`,
        'PFR': variant.pfrOf(n) === null ? '—' : `${variant.pfrOf(n)}/${n}`,
        'VPIP方向': snap.groupScores.length ? '-' : '-',
        ENTRY方向: groupOf(snap, 'ENTRY').direction,
        ENTRY分: fmt(groupOf(snap, 'ENTRY').score, 4),
        最强: groupOf(snap, 'ENTRY').strongestMetric ?? '-',
        deviation: snap.deviationScore,
        状态: snap.dominantState,
        'LOOSER p': signalOf(snap, 'LOOSER_RECENTLY') ? fmt(signalOf(snap, 'LOOSER_RECENTLY')!.probability, 3) : '-',
        置信: fmt(snap.confidence, 3),
        RANGE调整: snap.adjustments
          .filter((a) => a.target === 'RANGE_WIDTH')
          .map((a) => a.direction)
          .join(',') || '无',
        冲突数: snap.conflicts.length,
      });
      void vpip;
    }
  }
  table(rows);
  // 解释与冲突原文（只在最后一个目标率上打印，避免刷屏）
  const base = makeBaseline(variant.rates);
  const snap = mustOk(run(makeInput(base, build(20, 20, variant.pfrOf(20)))));
  console.log(`  [VPIP 20/20 = 100%] 状态=${snap.dominantState} 分数=${snap.deviationScore}`);
  console.log(`     explanation = ${JSON.stringify(snap.explanation)}`);
  console.log(`     conflicts   = ${JSON.stringify(snap.conflicts)}`);
  console.log(`     adjustments = ${JSON.stringify(snap.adjustments.map((a) => [a.target, a.direction, fmt(a.confidence, 3)]))}`);
  console.log('');
}

console.log('='.repeat(96));
console.log('D. 「冲突 → LOOSER_RECENTLY」分支可达性：是否存在 ENTRY 方向仍为 HIGHER 的冲突场景');
console.log('='.repeat(96));

let conflictCases = 0;
let reachable = 0;
let unblockedAggressionUp = 0;
const samples: TableRow[] = [];
for (const vpipRate of [0.9, 1.0]) {
  for (const pfrRate of [0.0, 0.1]) {
    for (const tbRate of [0.0, 0.3]) {
      for (const n of [20, 40, 60]) {
        const rates = { VPIP: 0.15, PFR: 0.12, THREE_BET: 0.07 };
        const base = makeBaseline(rates);
        const fv = spread(n, Math.round(vpipRate * n));
        const fp = spread(n, Math.round(pfrRate * n));
        const ft = spread(n, Math.round(tbRate * n));
        const events: ObservedPokerEvent[] = fv.map((v, i) => ({
          eventId: `e${i + 1}`,
          handId: `h${i + 1}`,
          playerId: PLAYER,
          seq: i + 1,
          timestamp: new Date(T0 + (i + 1) * 60_000).toISOString(),
          opportunities: [
            { metric: 'VPIP', success: v },
            { metric: 'PFR', success: fp[i]! },
            { metric: 'THREE_BET', success: ft[i]! },
          ],
        }));
        const snap = mustOk(run(makeInput(base, events)));
        const entryDir = groupOf(snap, 'ENTRY').direction;
        const has = snap.conflicts.length > 0;
        if (has) {
          conflictCases++;
          const passiveConflict = snap.conflicts.some((c) => c.includes('被动跟注变多'));
          if (passiveConflict && entryDir !== 'NONE') {
            reachable++;
          }
          if (entryDir === 'HIGHER' && snap.dominantState === 'LOOSER_RECENTLY') unblockedAggressionUp++;
          if (samples.length < 12) {
            samples.push({
              'VPIP': `${Math.round(vpipRate * n)}/${n}`,
              'PFR': `${Math.round(pfrRate * n)}/${n}`,
              '3Bet': `${Math.round(tbRate * n)}/${n}`,
              ENTRY方向: entryDir,
              状态: snap.dominantState,
              deviation: snap.deviationScore,
              冲突: snap.conflicts.length,
              冲突首条: snap.conflicts[0]?.slice(0, 28) ?? '',
            });
          }
        }
      }
    }
  }
}
table(samples);
console.log(`出现冲突的配置数 = ${conflictCases}`);
console.log(`其中「被动跟注变多」冲突但 ENTRY 方向 ≠ NONE 的配置数 = ${reachable}`);
console.log('（说明 deriveState 里 `aggressionBlocked && entry?.direction === "HIGHER"` → LOOSER_RECENTLY 分支');
console.log('  在「VPIP↑ 但 PFR↓」这一经典冲突下不可达：ENTRY 组自身已把方向判成 NONE）');
console.log(`而 ENTRY=HIGHER 且状态恰为 LOOSER_RECENTLY 的配置数 = ${unblockedAggressionUp}`);
