/**
 * PROBE 1 / 1B —— LABEL PRIOR NUMERIC PROOF（只诊断，不改产品代码）
 *
 * 用 TEST 12 的同一份 Weak-Tight observed stats，分别以
 * `baseArchetype = CALLING_STATION` 与 `VERY_TIGHT (NIT)` 跑 resolver，
 * 逐轴把融合公式**手算**一遍，并与产品代码实际输出做 1e-10 级比对。
 *
 * ```text
 * baseContribution     = (1 − w) × baseDimension
 * observedContribution = w × observedOnlyDimension
 * resolvedCalculated   = baseContribution + observedContribution
 * resolvedPipeline     = 产品代码 resolved.resolvedDimensions
 * absError             = |calculated − pipeline|
 * ```
 *
 * 用法：node --experimental-strip-types scripts/probe1-label-prior-proof.ts
 */

import {
  resolvePlayerProfile,
  K_PROFILE_LABEL,
  type PlayerObservedStats,
} from '../src/domain/player/observedStats.ts';
import { ARCHETYPE_DIMENSIONS } from '../src/domain/player/archetypeDimensions.ts';
import type { QuickProfile } from '../src/app/manualInput/manualInput.ts';

type Axis = 'tightness' | 'aggression' | 'bluffTendency' | 'passivity';
const AXES: readonly Axis[] = ['tightness', 'aggression', 'bluffTendency', 'passivity'];

/** 15 位小数（防止「四位显示相同」掩盖真实差异） */
const d15 = (v: number): string => (Number.isFinite(v) ? v.toFixed(15) : String(v));
const pad = (s: unknown, n: number): string => String(s).padEnd(n);
const line = (s = ''): void => console.log(s);

const WEAK_TIGHT: PlayerObservedStats = {
  handsObserved: 1500,
  vpip: 0.18, pfr: 0.12, threeBet: 0.04, wtsd: 0.20,
  foldToFlopCBet: 0.52, foldToTurnCBet: 0.61, foldToRiverBet: 0.68,
  flopCheckRaise: 0.03, turnCheckRaise: 0.02, riverCheckRaise: 0.01,
};

type Row = {
  axis: Axis; base: number; observed: number; mass: number; w: number;
  basePart: number; obsPart: number; calc: number; pipe: number; err: number;
};

function rowsOf(base: QuickProfile): Row[] {
  const p = resolvePlayerProfile({ baseArchetype: base as never, observedStats: WEAK_TIGHT }) as unknown as {
    resolved: {
      baseDimensions: Record<Axis, number>;
      observedOnlyDimensions: Record<Axis, number>;
      resolvedDimensions: Record<Axis, number>;
      evidenceMass: Record<Axis, number>;
      blendWeight: Record<Axis, number>;
    };
  };
  return AXES.map((axis) => {
    const b = p.resolved.baseDimensions[axis];
    const o = p.resolved.observedOnlyDimensions[axis];
    const mass = p.resolved.evidenceMass[axis];
    const w = p.resolved.blendWeight[axis];
    const basePart = (1 - w) * b;
    const obsPart = w * o;
    const calc = basePart + obsPart;
    const pipe = p.resolved.resolvedDimensions[axis];
    return { axis, base: b, observed: o, mass, w, basePart, obsPart, calc, pipe, err: Math.abs(calc - pipe) };
  });
}

line('='.repeat(118));
line(' PROBE 1 —— LABEL PRIOR NUMERIC PROOF ｜ Weak-Tight 1500 手 ｜ CS 标签 vs NIT 标签');
line('='.repeat(118));
line(`  K_PROFILE_LABEL = ${K_PROFILE_LABEL}   ｜ 轴内收缩质量固定（不参与本表，只影响 observedOnly）`);
line('');

const cs = rowsOf('CALLING_STATION');
const nit = rowsOf('VERY_TIGHT');

for (const [name, rows] of [['CASE A：baseArchetype = CALLING_STATION', cs],
  ['CASE B：baseArchetype = VERY_TIGHT (NIT)', nit]] as const) {
  line('─'.repeat(118));
  line(`【${name}】`);
  line('─'.repeat(118));
  line(pad('axis', 16) + pad('base', 20) + pad('observedOnly', 20) + pad('evidenceMass', 15) +
    pad('w', 20) + pad('basePart=(1−w)·b', 20) + pad('obsPart=w·o', 20) + pad('calculated', 20) + 'pipeline');
  line('-'.repeat(140));
  for (const r of rows) {
    line(pad(r.axis, 16) + pad(d15(r.base), 20) + pad(d15(r.observed), 20) + pad(d15(r.mass), 15) +
      pad(d15(r.w), 20) + pad(d15(r.basePart), 20) + pad(d15(r.obsPart), 20) + pad(d15(r.calc), 20) + d15(r.pipe));
    line(pad('', 16) + `absError = ${r.err.toExponential(3)}  ⇒ ${r.err < 1e-10 ? 'PASS' : '**FAIL**'}`);
  }
  line('');
}

/* ---------- 1B：精度与 CS/NIT 差异 ---------- */
line('### PROBE 1B —— 精度排除：CS 与 NIT 的 resolved 必须不同');
line('');
line(pad('axis', 16) + pad('resolved_CS', 22) + pad('resolved_NIT', 22) + pad('delta', 22) + '是否逐位相同');
line('-'.repeat(104));
let allDifferent = true;
let anyW1 = false;
for (let i = 0; i < AXES.length; i += 1) {
  const a = cs[i]!, b = nit[i]!;
  const same = a.pipe === b.pipe;
  if (same && a.w < 1 && a.w > 0) allDifferent = false;
  if (a.w === 1 || b.w === 1) anyW1 = true;
  line(pad(a.axis, 16) + pad(d15(a.pipe), 22) + pad(d15(b.pipe), 22) + pad(d15(a.pipe - b.pipe), 22) +
    (same ? '**相同**' : '不同'));
}
line('');
line(`  最大 absError（两 case 共 8 轴） = ${Math.max(...[...cs, ...nit].map((r) => r.err)).toExponential(3)}`);
line(`  出现 w === 1 的轴 = ${anyW1 ? '有（见上表）' : '无'}`);
line('');
line('### PROBE 1 结论');
line('');
const maxErr = Math.max(...[...cs, ...nit].map((r) => r.err));
line(`  LABEL_PRIOR_NUMERIC_PROOF = ${maxErr < 1e-10 ? 'PASS' : 'FAIL'}`);
line(`  （判据：absError < 1e-10。实测最大误差 ${maxErr.toExponential(3)}）`);
line(`  标签 prior 在四个轴上是否都保留 = ${allDifferent ? 'YES（四个轴的 resolved 都不同）' : '**NO —— 某些轴两种标签下逐位相同**'}`);
line('');
line('  w 的说明（数值事实，不是解释）：');
for (const r of cs) {
  line(`    ${pad(r.axis, 16)} evidenceMass=${d15(r.mass)} ⇒ w=${d15(r.w)}` +
    (r.mass === 0 ? '  ← **该轴无证据 ⇒ w = 0 ⇒ resolved 逐位等于 base**' : ''));
}
line('');
line('  参考：ARCTYPE 表（base 来源）');
line(`    CALLING_STATION = ${JSON.stringify(ARCHETYPE_DIMENSIONS.CALLING_STATION)}`);
line(`    VERY_TIGHT     = ${JSON.stringify(ARCHETYPE_DIMENSIONS.VERY_TIGHT)}`);
line('');
