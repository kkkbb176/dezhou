/**
 * rt7-probe8.ts —— 干净场景下的假阴性边界与样本保护倒挂
 *
 * 只用 VPIP（基线 15%），**不引入任何组内冲突**，从而把「样本量」这一个变量单独隔离出来。
 *
 * 运行：node.exe --experimental-strip-types "scripts/rt7-probe8.ts"
 */

import {
  PLAYER,
  T0,
  fmt,
  makeBaseline,
  makeInput,
  mustOk,
  run,
  spread,
  table,
} from './rt7-lib.ts';
import type { ObservedPokerEvent, TableRow } from './rt7-lib.ts';

const base = makeBaseline({ VPIP: 0.15 });
const RATE = 0.45;

function eventsOf(n: number, s: number): ObservedPokerEvent[] {
  const flags = spread(n, s);
  return flags.map((f, i) => ({
    eventId: `e${i + 1}`,
    handId: `h${i + 1}`,
    playerId: PLAYER,
    seq: i + 1,
    timestamp: new Date(T0 + (i + 1) * 60_000).toISOString(),
    opportunities: [{ metric: 'VPIP', success: f }],
  }));
}

function verdict(n: number, s: number): TableRow {
  const snap = mustOk(run(makeInput(base, eventsOf(n, s))));
  const w20 = snap.windows.find((w) => w.size === 20)!.stats[0]!;
  return {
    n,
    命中: s,
    实际率: fmt(s / n, 3),
    窗口机会: w20.opportunities,
    收缩后: fmt(w20.adjustedRate, 4),
    分数: snap.deviationScore,
    状态: snap.dominantState,
    'LOOSER p': snap.signals.find((x) => x.state === 'LOOSER_RECENTLY')
      ? fmt(snap.signals.find((x) => x.state === 'LOOSER_RECENTLY')!.probability, 3)
      : '-',
    置信: fmt(snap.confidence, 3),
    'RANGE↑': snap.adjustments.some((a) => a.target === 'RANGE_WIDTH' && a.direction === 'INCREASE') ? '有' : '无',
  };
}

console.log('='.repeat(100));
console.log('A. 干净场景（只有 VPIP，无任何组内冲突）：基线 15%，近期真实率 45%，N 从 1 扫到 60');
console.log('='.repeat(100));
const rowsA: TableRow[] = [];
let firstDetect: number | null = null;
let lostAfter: number | null = null;
for (let n = 1; n <= 60; n++) {
  const s = Math.round(RATE * n);
  const row = verdict(n, s);
  if (row['RANGE↑'] === '有' && firstDetect === null) firstDetect = n;
  if (firstDetect !== null && n > firstDetect && row['RANGE↑'] === '无' && lostAfter === null) lostAfter = n;
  rowsA.push(row);
}
table(rowsA);
console.log(`最早报出「变松 + 范围放宽」的 N = ${firstDetect}`);
console.log(`报出之后又丢失检测的最小 N = ${lostAfter ?? '（本扫描未出现）'}`);

console.log('');
console.log('='.repeat(100));
console.log('B. 干净场景：样本保护倒挂 —— 少样本反而更容易触发调整');
console.log('='.repeat(100));
const rowsB: TableRow[] = [];
for (const [n, s, label] of [
  [1, 1, '1 次机会 1 次命中（100%）'],
  [2, 2, '2 次机会 2 次命中（100%）'],
  [3, 3, '3 次机会 3 次命中（100%）'],
  [5, 5, '5 次机会 5 次命中（100%）'],
  [8, 8, '8 次机会 8 次命中（100%）'],
  [10, 10, '10 次机会 10 次命中（100%）'],
  [20, 20, '20 次机会 20 次命中（100%）'],
  [20, 9, '20 次机会 9 次命中（45%）'],
  [30, 14, '30 次机会 14 次命中（47%）'],
  [50, 23, '50 次机会 23 次命中（46%）'],
  [60, 27, '60 次机会 27 次命中（45%）'],
] as Array<[number, number, string]>) {
  const row = verdict(n, s);
  rowsB.push({ 场景: label, ...row });
}
table(rowsB);
console.log('注意：10/10（10 次机会全命中）与 20/9（45%）相比 —— 前者报出调整，后者不报。');

console.log('');
console.log('='.repeat(100));
console.log('C. n × 真实率 的检出矩阵（状态 / 是否放宽范围）');
console.log('='.repeat(100));
const ns = [8, 10, 12, 15, 18, 20, 30, 50, 60];
const rates = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.8, 1.0];
const header: TableRow = { n: 'n \\ 率' };
for (const r of rates) header[fmt(r, 2)] = '';
console.log(Object.keys(header).join('  '));
for (const n of ns) {
  const cells: string[] = [];
  for (const rate of rates) {
    const s = Math.round(rate * n);
    const snap = mustOk(run(makeInput(base, eventsOf(n, s))));
    const up = snap.adjustments.some((a) => a.target === 'RANGE_WIDTH' && a.direction === 'INCREASE');
    const state = snap.dominantState;
    const mark = up ? '↑' : state === 'TIGHTER_RECENTLY' ? '↓' : state === 'UNKNOWN' ? '?' : '·';
    cells.push(mark.padEnd(4));
  }
  console.log(String(n).padStart(3) + '  ' + cells.join('  '));
}
console.log('  ↑ = 报出 LOOSER_RECENTLY 且放宽范围；↓ = 报出 TIGHTER_RECENTLY；· = NORMAL；? = UNKNOWN');
