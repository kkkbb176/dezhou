/**
 * rt7-probe1.ts —— 假阴性边界 + 单调性 + 样本保护 + 收缩公式核对
 *
 * 全部结论来自本脚本的真实输出，不引用作者测试。
 *
 * 运行：node.exe --experimental-strip-types "scripts/rt7-probe1.ts"
 */

import { capSingleHandWeight, effectiveSampleSize } from '../src/domain/player/playerStats.ts';
import {
  RECENT_HALF_LIFE_HANDS,
  SHRINKAGE_REFERENCE_OPPORTUNITIES,
  SUFFICIENT_RECENT_OPPORTUNITIES,
} from '../src/domain/dynamic/dynamic.types.ts';

import {
  PLAYER,
  fmt,
  groupOf,
  hands,
  makeBaseline,
  makeInput,
  mustOk,
  run,
  signalOf,
  spread,
  table,
  w20,
} from './rt7-lib.ts';

const VPIP_BASE = 0.15;
const OTHER = { PFR: false };

function evaluate(fn: Parameters<typeof run>[0]) {
  return run(fn);
}

console.log('='.repeat(78));
console.log('A. 假阴性边界：基线 VPIP 15% → 近期 45%，手数 N 从 6 扫到 80');
console.log('   （每手 1 次 VPIP 机会，另附 1 次 PFR 机会但不命中；成功率按 45% 均匀铺开）');
console.log('='.repeat(78));

const rowsA: Array<Record<string, string | number>> = [];
for (const n of [6, 7, 8, 10, 12, 15, 18, 20, 25, 30, 40, 50, 60, 80]) {
  const s = Math.round(0.45 * n);
  const base = makeBaseline({ VPIP: VPIP_BASE, PFR: 0.12 });
  const events = hands(spread(n, s), 'VPIP', OTHER);
  const outcome = evaluate(makeInput(base, events));
  if (!outcome.ok) {
    rowsA.push({ N: n, 成功: s, 原始率: fmt(s / n, 3), 结果: `FAIL ${outcome.code}` });
    continue;
  }
  const snap = outcome.value;
  const stat = w20(snap, 'VPIP')!;
  const looser = signalOf(snap, 'LOOSER_RECENTLY');
  rowsA.push({
    N: n,
    成功: s,
    原始率: fmt(s / n, 3),
    窗口机会: stat.opportunities,
    收缩后: fmt(stat.adjustedRate, 4),
    'deviation': snap.deviationScore,
    状态: snap.dominantState,
    'LOOSER p': looser ? fmt(looser.probability, 3) : '-',
    置信: fmt(snap.confidence, 3),
    调整数: snap.adjustments.length,
  });
}
table(rowsA);

console.log('');
console.log('='.repeat(78));
console.log('B. 20 次机会固定，成功率从 15% 单调抬到 100% —— deviationScore 是否单调不减');
console.log('='.repeat(78));

const rowsB: Array<Record<string, string | number>> = [];
let prevScore = -1;
let monotone = true;
let firstLooser: number | null = null;
for (let s = 3; s <= 20; s++) {
  const base = makeBaseline({ VPIP: VPIP_BASE, PFR: 0.12 });
  const events = hands(spread(20, s), 'VPIP', OTHER);
  const snap = mustOk(evaluate(makeInput(base, events)));
  const stat = w20(snap, 'VPIP')!;
  const looser = signalOf(snap, 'LOOSER_RECENTLY');
  if (snap.deviationScore < prevScore) monotone = false;
  const dip = snap.deviationScore < prevScore ? ' ← 下降!' : '';
  if (looser && firstLooser === null) firstLooser = s;
  rowsB.push({
    成功: `${s}/20`,
    原始率: fmt(s / 20, 2),
    收缩后: fmt(stat.adjustedRate, 4),
    偏差: fmt(stat.deviation, 4),
    ENTRY分: fmt(groupOf(snap, 'ENTRY').score, 4),
    deviation: `${snap.deviationScore}${dip}`,
    状态: snap.dominantState,
    'LOOSER p': looser ? fmt(looser.probability, 3) : '-',
    置信: fmt(snap.confidence, 3),
  });
  prevScore = snap.deviationScore;
}
table(rowsB);
console.log(`单调不减：${monotone ? '是（本扫描内）' : '否 —— 存在下降台阶'}；LOOSER_RECENTLY 首次出现于 ${firstLooser}/20`);

console.log('');
console.log('='.repeat(78));
console.log('C. 单指标偏离幅度递增（固定 20 次机会）—— 全窗口 10/20/50 与总分');
console.log('='.repeat(78));

const rowsC: Array<Record<string, string | number>> = [];
for (const rate of [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
  const s = Math.round(rate * 20);
  const base = makeBaseline({ VPIP: VPIP_BASE, PFR: 0.12 });
  const events = hands(spread(20, s), 'VPIP', OTHER);
  const snap = mustOk(evaluate(makeInput(base, events)));
  const stat = w20(snap, 'VPIP')!;
  rowsC.push({
    成功率: fmt(s / 20, 2),
    rawRate: fmt(stat.rawRate, 3),
    adjustedRate: fmt(stat.adjustedRate, 4),
    ENTRY: fmt(groupOf(snap, 'ENTRY').score, 4),
    方向: groupOf(snap, 'ENTRY').direction,
    deviation: snap.deviationScore,
    状态: snap.dominantState,
    RANGE_WIDTH调整: snap.adjustments.some((a) => a.target === 'RANGE_WIDTH') ? '有' : '无',
  });
}
table(rowsC);

console.log('');
console.log('='.repeat(78));
console.log('D. 样本保护：1/1 100%  vs  20/9 45%  —— 谁的影响更大？');
console.log('='.repeat(78));

const cases: Array<[string, number, number]> = [
  ['1 次机会 1 次命中（100%）', 1, 1],
  ['1 次机会 1 次命中（100%，重复 3 手）', 3, 3],
  ['5 次机会 5 次命中（100%）', 5, 5],
  ['8 次机会 8 次命中（100%）', 8, 8],
  ['20 次机会 20 次命中（100%）', 20, 20],
  ['20 次机会 9 次命中（45%）', 20, 9],
  ['20 次机会 12 次命中（60%）', 20, 12],
  ['60 次机会 27 次命中（45%）', 60, 27],
];
const rowsD: Array<Record<string, string | number>> = [];
for (const [label, n, s] of cases) {
  const base = makeBaseline({ VPIP: VPIP_BASE, PFR: 0.12 });
  const events = hands(spread(n, s), 'VPIP', OTHER);
  const snap = mustOk(evaluate(makeInput(base, events)));
  const stat = w20(snap, 'VPIP')!;
  rowsD.push({
    场景: label,
    窗口机会: stat.opportunities,
    收缩后: fmt(stat.adjustedRate, 4),
    强度: fmt(groupOf(snap, 'ENTRY').score, 4),
    deviation: snap.deviationScore,
    状态: snap.dominantState,
    'LOOSER p': signalOf(snap, 'LOOSER_RECENTLY')
      ? fmt(signalOf(snap, 'LOOSER_RECENTLY')!.probability, 3)
      : '-',
    置信: fmt(snap.confidence, 3),
    调整数: snap.adjustments.length,
  });
}
table(rowsD);

console.log('');
console.log('='.repeat(78));
console.log('E. 收缩公式核对：实现到底给了基线多少权重？');
console.log(`   REF = SHRINKAGE_REFERENCE_OPPORTUNITIES = ${SHRINKAGE_REFERENCE_OPPORTUNITIES}`);
console.log(`   SUFFICIENT_RECENT_OPPORTUNITIES = ${SUFFICIENT_RECENT_OPPORTUNITIES}`);
console.log('='.repeat(78));

// 复现 20 手窗口的 capped 权重（1 次机会/手，age = 19..0）
const weights: number[] = [];
for (let age = 19; age >= 0; age--) weights.push(Math.pow(2, -age / RECENT_HALF_LIFE_HANDS));
const capped = capSingleHandWeight(weights, 0.05);
const sumRaw = weights.reduce((a, b) => a + b, 0);
const sumCapped = capped.reduce((a, b) => a + b, 0);
const uniq = [...new Set(capped.map((w) => w.toFixed(12)))];
console.log(`20 次机会的原始权重（age 19..0，半衰期 ${RECENT_HALF_LIFE_HANDS}）：`);
console.log(`  Σw(原始) = ${fmt(sumRaw, 6)}，Σw(capped) = ${fmt(sumCapped, 6)}`);
console.log(`  capped 权重去重后个数 = ${uniq.length}${uniq.length === 1 ? '（**完全均匀 —— 时间衰减被单手影响上限抹平**）' : ''}`);
console.log(`  effectiveSampleSize(原始) = ${fmt(effectiveSampleSize(weights), 4)}；capped = ${fmt(effectiveSampleSize(capped), 4)}`);
console.log('');

// 实测：20 次机会、12 次命中、基线 0.15、基线置信度 0.9
const base = makeBaseline({ VPIP: VPIP_BASE, PFR: 0.12 }, { confidence: 0.9 });
const events = hands(spread(20, 12), 'VPIP', OTHER);
const snap = mustOk(evaluate(makeInput(base, events)));
const stat = w20(snap, 'VPIP')!;
console.log('场景：20 次机会、12 次命中、基线率 0.15、基线 confidence 0.9');
console.log(`  快照给出的 adjustedRate = ${fmt(stat.adjustedRate, 6)}（rawRate = ${fmt(stat.rawRate, 4)}，successes = ${stat.successes}）`);

const quality = 0.9;
const kActual = ((SHRINKAGE_REFERENCE_OPPORTUNITIES - 20) / 20) * quality;
const kDoc = (SHRINKAGE_REFERENCE_OPPORTUNITIES - 20) * quality; // 文档声称的「基线被当作多少次观测」
const wSum = sumCapped;
// 加权成功数：12 次命中按 spread 铺开，用 capped 权重近似（均匀 → 12/20 × Σw）
const weightedSuccesses = (12 / 20) * wSum;
console.log(`  实现所用 k = ((REF − c)/c) × quality = ((${SHRINKAGE_REFERENCE_OPPORTUNITIES} − 20)/20) × ${quality} = ${fmt(kActual, 4)}`);
console.log(`  文档声称「基线 : 近期 = (REF − c) : c = ${SHRINKAGE_REFERENCE_OPPORTUNITIES - 20} : 20」，即 k 应为 ${fmt(kDoc, 1)}`);
console.log(`  实测权重占比：基线 = ${fmt(kActual / (wSum + kActual), 4)}（${fmt((kActual / (wSum + kActual)) * 100, 1)}%），近期 = ${fmt(wSum / (wSum + kActual), 4)}`);
console.log(`  若 k = ${fmt(kDoc, 1)}（文档口径）→ adjustedRate = ${fmt((weightedSuccesses + kDoc * VPIP_BASE) / (wSum + kDoc), 6)}`);
console.log(`  若 k = ${fmt(kActual, 4)}（实现口径）→ adjustedRate = ${fmt((weightedSuccesses + kActual * VPIP_BASE) / (wSum + kActual), 6)}`);
console.log(`  ⇒ 实现与文档口径的 adjustedRate 差异 = ${fmt(Math.abs((weightedSuccesses + kDoc * VPIP_BASE) / (wSum + kDoc) - (weightedSuccesses + kActual * VPIP_BASE) / (wSum + kActual)), 6)}`);

console.log('');
console.log('  关键刻度（文档声称 vs 实现）：');
const rowsE: Array<Record<string, string | number>> = [];
for (const c of [1, 2, 5, 10, 20, 30, 40, 50, 59, 60]) {
  const k = c < SHRINKAGE_REFERENCE_OPPORTUNITIES ? ((SHRINKAGE_REFERENCE_OPPORTUNITIES - c) / c) * 1.0 : 0;
  const share = k / (c + k);
  rowsE.push({
    'c（机会数）': c,
    'k（实现）': fmt(k, 4),
    '基线权重占比': `${fmt(share * 100, 1)}%`,
    '文档声称占比': `${fmt(((SHRINKAGE_REFERENCE_OPPORTUNITIES - c) / SHRINKAGE_REFERENCE_OPPORTUNITIES) * 100, 1)}%`,
    '是否为文档口径': Math.abs(share - (SHRINKAGE_REFERENCE_OPPORTUNITIES - c) / SHRINKAGE_REFERENCE_OPPORTUNITIES) < 1e-9 ? '是' : '否',
  });
}
table(rowsE);
console.log('  注：文档称「c = REF/2 → 基线与近期等权」。以 c=30 计，实现给出基线权重 ' +
  `${fmt((((SHRINKAGE_REFERENCE_OPPORTUNITIES - 30) / 30) / (30 + (SHRINKAGE_REFERENCE_OPPORTUNITIES - 30) / 30)) * 100, 1)}%。`);

console.log('');
console.log('='.repeat(78));
console.log('F. 非单调台阶搜索：同组内两个反向指标同时远离基线');
console.log('='.repeat(78));

// ENTRY 组：VPIP 上升 + LIMP 下降。扫描「同时加大两者幅度」。
const baseF = makeBaseline({ VPIP: 0.15, PFR: 0.12, LIMP: 0.10 });
const rowsF: Array<Record<string, string | number>> = [];
let prevF = -1;
let dips = 0;
for (let d = 0; d <= 12; d++) {
  const vpipS = 3 + d; // 15% → 75%
  const limpS = Math.max(0, 2 - Math.floor(d / 2)); // 10% → 0%
  const flagsV = spread(20, vpipS);
  const flagsL = spread(20, limpS);
  const events = flagsV.map((v, i) =>
    // eslint-disable-next-line
    ({
      eventId: `e${i + 1}`,
      handId: `h${i + 1}`,
      playerId: PLAYER,
      seq: i + 1,
      timestamp: new Date(Date.parse('2026-01-01T00:00:00.000Z') + (i + 1) * 60_000).toISOString(),
      opportunities: [
        { metric: 'VPIP', success: v },
        { metric: 'PFR', success: false },
        { metric: 'LIMP', success: flagsL[i]! },
      ],
    }),
  );
  const snap = mustOk(evaluate(makeInput(baseF, events)));
  const entry = groupOf(snap, 'ENTRY');
  const dip = snap.deviationScore < prevF;
  if (dip) dips++;
  rowsF.push({
    d,
    VPIP: `${vpipS}/20`,
    LIMP: `${limpS}/20`,
    ENTRY方向: entry.direction,
    ENTRY分: fmt(entry.score, 4),
    最强指标: entry.strongestMetric ?? '-',
    deviation: `${snap.deviationScore}${dip ? ' ← 下降' : ''}`,
    状态: snap.dominantState,
    冲突: snap.conflicts.length,
  });
  prevF = snap.deviationScore;
}
table(rowsF);
console.log(`本扫描中 deviationScore 下降台阶数 = ${dips}`);
