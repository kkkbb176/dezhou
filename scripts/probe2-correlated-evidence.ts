/**
 * PROBE 2 / 2B / 2C —— CORRELATED EVIDENCE MASS AUDIT（只诊断，不改产品代码）
 *
 * 目标：检查
 * ```text
 * evidenceMass = Σ |polarity| × opportunities
 * ```
 * 是否因为多个 HUD 指标都来自**同一批 hands**，而把证据量累计过快。
 *
 * - 2  ：base = NORMAL，固定比例，handss ∈ {25 … 3000}，逐轴 + 逐统计拆解
 * - 2B ：hands = 500，只给 VPIP / 给 VPIP+PFR / 给 VPIP+PFR+3Bet+WTSD
 * - 2C ：hands = 1000，人为指定真实 opportunities（20 vs 200）
 * - 尾段：Murphy 扩展检查 1–10
 *
 * 用法：node --experimental-strip-types scripts/probe2-correlated-evidence.ts
 */

import {
  resolvePlayerProfile,
  STAT_DIMENSION_POLARITY,
  ALL_OBSERVED_STAT_KEYS,
  K_PROFILE_LABEL,
  type PlayerObservedStats,
} from '../src/domain/player/observedStats.ts';

type Axis = 'tightness' | 'aggression' | 'bluffTendency' | 'passivity';
const AXES: readonly Axis[] = ['tightness', 'aggression', 'bluffTendency', 'passivity'];
type M = Record<string, number>;
type Snap = {
  base: M; observed: M; resolved: M; mass: M; w: M;
  trace: readonly Record<string, unknown>[];
};

const S = (o: Partial<PlayerObservedStats> & { handsObserved: number }): PlayerObservedStats =>
  o as PlayerObservedStats;
const d6 = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(6) : '—');
const pad = (s: unknown, n: number): string => String(s).padEnd(n);
const line = (s = ''): void => console.log(s);

/** 固定比例（用户给定） */
const RATIOS = {
  vpip: 0.42, pfr: 0.29, threeBet: 0.12, wtsd: 0.33,
  foldToFlopCBet: 0.32, foldToTurnCBet: 0.30, foldToRiverBet: 0.28,
  flopCheckRaise: 0.10, turnCheckRaise: 0.08, riverCheckRaise: 0.06,
} as const;

function snap(opts: {
  base: string | null; hands: number; fields?: readonly (keyof typeof RATIOS)[];
  opportunities?: Partial<Record<keyof typeof RATIOS, number>>;
}): Snap {
  const fields = opts.fields ?? (Object.keys(RATIOS) as (keyof typeof RATIOS)[]);
  const stats: Record<string, number> = { handsObserved: opts.hands };
  for (const f of fields) stats[f] = RATIOS[f];
  const p = resolvePlayerProfile({
    baseArchetype: opts.base as never,
    observedStats: stats as unknown as PlayerObservedStats,
    ...(opts.opportunities === undefined ? {} : { opportunities: opts.opportunities as never }),
  }) as unknown as {
    resolved: {
      baseDimensions: M; observedOnlyDimensions: M; resolvedDimensions: M;
      evidenceMass: M; blendWeight: M;
    };
    trace: readonly Record<string, unknown>[];
  };
  return {
    base: p.resolved.baseDimensions, observed: p.resolved.observedOnlyDimensions,
    resolved: p.resolved.resolvedDimensions, mass: p.resolved.evidenceMass,
    w: p.resolved.blendWeight, trace: p.trace,
  };
}

/* ============================================================
 * PROBE 2
 * ============================================================ */

line('='.repeat(116));
line(' PROBE 2 —— CORRELATED EVIDENCE MASS AUDIT ｜ base = NORMAL ｜ 固定比例，只加手数');
line('='.repeat(116));
line(`  K_PROFILE_LABEL = ${K_PROFILE_LABEL}`);
line('');

const HANDS = [25, 50, 100, 250, 500, 1000, 1500, 3000] as const;
const SNAPS = HANDS.map((hands) => ({ hands, s: snap({ base: 'NORMAL', hands }) }));

for (const axis of AXES) {
  line(`── ${axis} ──`);
  line(pad('hands', 8) + pad('evidenceMass', 15) + pad('blendWeight', 14) + pad('base', 10) +
    pad('observedOnly', 15) + pad('resolved', 12) + 'w×100%');
  line('-'.repeat(84));
  for (const { hands, s } of SNAPS) {
    line(pad(hands, 8) + pad(d6(s.mass[axis]), 15) + pad(d6(s.w[axis]), 14) + pad(d6(s.base[axis]), 10) +
      pad(d6(s.observed[axis]), 15) + pad(d6(s.resolved[axis]), 12) + `${(s.w[axis]! * 100).toFixed(2)}%`);
  }
  line('');
}

/* ---------- 500 手核心问题 ---------- */
line('### 核心问题：hands = 500 时 w 到底是多少？');
line('');
const s500 = snap({ base: 'NORMAL', hands: 500 });
line(pad('axis', 16) + pad('evidenceMass', 16) + pad('w = m/(m+500)', 18) + '与「等权 0.5」的差');
line('-'.repeat(74));
for (const axis of AXES) {
  const m = s500.mass[axis]!;
  const w = s500.w[axis]!;
  line(pad(axis, 16) + pad(d6(m), 16) + pad(d6(w), 18) + (w - 0.5 >= 0 ? '+' : '') + (w - 0.5).toFixed(6));
}
line('');
line('  设计声称：K_PROFILE_LABEL = 500 ≈ 「500 手时 label / observed 接近等权」');
const w500 = AXES.map((a) => s500.w[a]!);
line(`  实测：w ∈ [${Math.min(...w500).toFixed(6)}, ${Math.max(...w500).toFixed(6)}]`);
line(`  判定：${Math.max(...w500) <= 0.55 ? '等权成立（w ≈ 0.5）' : '**500 手时实测已占多数权重 —— K=500 的字面语义不成立**'}`);
line('');

/* ---------- 拆解 ---------- */
line('### 证据质量拆解（每个 stat 对每个 axis 的贡献）');
line('');
for (const hands of [500, 1500] as const) {
  const s = snap({ base: 'NORMAL', hands });
  line(`【hands = ${hands}】`);
  for (const axis of AXES) {
    const parts: string[] = [];
    let total = 0;
    for (const key of ALL_OBSERVED_STAT_KEYS) {
      const p = STAT_DIMENSION_POLARITY[key][axis];
      if (p === 0) continue;
      const row = s.trace.find((x) => x['stat'] === key) ?? null;
      const opp = row === null ? 0 : Number(row['opportunities']);
      const c = Math.abs(p) * opp;
      total += c;
      parts.push(`${key}(${opp}×${Math.abs(p)})=${c.toFixed(1)}`);
    }
    line(`  ${pad(axis, 16)} ${parts.length === 0 ? '（无统计作用于该轴）' : parts.join(' + ')}` +
      `  ⇒ TOTAL ${total.toFixed(1)}（管线 ${s.mass[axis]!.toFixed(1)}）`);
  }
  line('');
}

/* ============================================================
 * PROBE 2B —— SAME-HANDS DUPLICATION
 * ============================================================ */

line('### PROBE 2B —— 同一批 500 hands，多填几个相关字段是否被当成更多独立证据？');
line('');
const v1 = snap({ base: 'NORMAL', hands: 500, fields: ['vpip'] });
const v2 = snap({ base: 'NORMAL', hands: 500, fields: ['vpip', 'pfr'] });
const v3 = snap({ base: 'NORMAL', hands: 500, fields: ['vpip', 'pfr', 'threeBet', 'wtsd'] });
line(pad('版本', 34) + pad('tightness mass', 17) + pad('tightness w', 14) +
  pad('aggression mass', 17) + pad('aggression w', 14) + 'resolved tightness');
line('-'.repeat(112));
line(pad('V1 只给 VPIP', 34) + pad(d6(v1.mass['tightness']), 17) + pad(d6(v1.w['tightness']), 14) +
  pad(d6(v1.mass['aggression']), 17) + pad(d6(v1.w['aggression']), 14) + d6(v1.resolved['tightness']));
line(pad('V2 给 VPIP + PFR', 34) + pad(d6(v2.mass['tightness']), 17) + pad(d6(v2.w['tightness']), 14) +
  pad(d6(v2.mass['aggression']), 17) + pad(d6(v2.w['aggression']), 14) + d6(v2.resolved['tightness']));
line(pad('V3 给 VPIP+PFR+3Bet+WTSD', 34) + pad(d6(v3.mass['tightness']), 17) + pad(d6(v3.w['tightness']), 14) +
  pad(d6(v3.mass['aggression']), 17) + pad(d6(v3.w['aggression']), 14) + d6(v3.resolved['tightness']));
line('');
const ratioT = v3.w['tightness']! / v1.w['tightness']!;
line(`  同一批 500 手：tightness 的 w 从 ${v1.w['tightness']!.toFixed(4)}（1 项）升到 ` +
  `${v3.w['tightness']!.toFixed(4)}（4 项）⇒ 倍数 ${ratioT.toFixed(2)}×`);
line(`  CORRELATED_EVIDENCE_INFLATION 判据：${ratioT > 1.5 ? '**触发**（同一批 hands 被多个统计重复累计）' : '未触发'}`);
line('');

/* ============================================================
 * PROBE 2C —— TRUE OPPORTUNITIES
 * ============================================================ */

line('### PROBE 2C —— 真实机会数是否优先于「hands 推算」');
line('');
const approx20 = snap({ base: 'NORMAL', hands: 1000, fields: ['foldToRiverBet', 'wtsd'] });
const real20 = snap({
  base: 'NORMAL', hands: 1000, fields: ['foldToRiverBet', 'wtsd'],
  opportunities: { foldToRiverBet: 20, wtsd: 20 },
});
const real200 = snap({
  base: 'NORMAL', hands: 1000, fields: ['foldToRiverBet', 'wtsd'],
  opportunities: { foldToRiverBet: 200, wtsd: 200 },
});
const rowOf = (s: Snap, stat: string): Record<string, unknown> =>
  s.trace.find((x) => x['stat'] === stat) ?? {};
line(pad('情形', 30) + pad('FoldRiver opp', 15) + pad('FoldRiver effRate', 18) +
  pad('WTSD opp', 12) + pad('passivity mass', 16) + pad('passivity w', 13) + 'wtsd effRate');
line('-'.repeat(118));
const showRow = (name: string, s: Snap): void => {
  const fr = rowOf(s, 'foldToRiverBet');
  const wt = rowOf(s, 'wtsd');
  line(pad(name, 30) + pad(String(fr['opportunities']), 15) + pad(d6(fr['effectiveRate']), 18) +
    pad(String(wt['opportunities']), 12) + pad(d6(s.mass['passivity']), 16) +
    pad(d6(s.w['passivity']), 13) + d6(wt['effectiveRate']));
};
showRow('hands=1000（全部近似）', approx20);
showRow('hands=1000 + 真机会 20/20', real20);
showRow('hands=1000 + 真机会 200/200', real200);
line('');
line(`  ① FoldToRiverBet 的维度极性全为 0 ⇒ 它对任何 axis 的 evidenceMass 贡献恒为 0`);
line(`     （真实机会数只通过 effectiveRate/conf 影响**分街**通道）`);
line(`  ② WTSD 的真机会数 20 vs 200 ⇒ passivity 的 evidenceMass ` +
  `${d6(real20.mass['passivity'])} vs ${d6(real200.mass['passivity'])} ⇒ w ` +
  `${d6(real20.w['passivity'])} vs ${d6(real200.w['passivity'])}`);
line(`     ⇒ 20 次机会**没有**被当成 1000 次证据`);
line(`  TRUE_OPPORTUNITY_PRIORITY = ${real20.mass['passivity']! < approx20.mass['passivity']! ? 'PASS' : 'FAIL'}`);
line('');

/* ============================================================
 * Murphy 扩展检查 1–10
 * ============================================================ */

line('### Murphy 扩展检查（对这组探针输入自动判定）');
line('');
const checks: { id: string; pass: boolean; detail: string }[] = [];
const allSnaps = [...SNAPS.map((x) => x.s), v1, v2, v3, real20, real200];

checks.push({
  id: '1. blendWeight ∈ [0,1]',
  pass: allSnaps.every((s) => AXES.every((a) => s.w[a]! >= 0 && s.w[a]! <= 1)),
  detail: `全部 ${allSnaps.length} 个快照 × 4 轴`,
});
checks.push({
  id: '2. resolved ∈ [min(base,observed), max(base,observed)]',
  pass: allSnaps.every((s) => AXES.every((a) => {
    const lo = Math.min(s.base[a]!, s.observed[a]!) - 1e-12;
    const hi = Math.max(s.base[a]!, s.observed[a]!) + 1e-12;
    return s.resolved[a]! >= lo && s.resolved[a]! <= hi;
  })),
  detail: '凸组合不变量',
});
checks.push({
  id: '3. evidenceMass ≥ 0',
  pass: allSnaps.every((s) => AXES.every((a) => s.mass[a]! >= 0)),
  detail: '',
});
const zeroOpp = resolvePlayerProfile({
  baseArchetype: 'NORMAL' as never,
  observedStats: S({ handsObserved: 1000, vpip: 0.60 }),
  opportunities: { vpip: 0 },
}) as unknown as { resolved: { evidenceMass: M; blendWeight: M; resolvedDimensions: M; baseDimensions: M } };
checks.push({
  id: '4. opportunities = 0 ⇒ 不产生 evidence',
  pass: zeroOpp.resolved.evidenceMass['tightness'] === 0 && zeroOpp.resolved.blendWeight['tightness'] === 0 &&
    zeroOpp.resolved.resolvedDimensions['tightness'] === zeroOpp.resolved.baseDimensions['tightness'],
  detail: `mass=${zeroOpp.resolved.evidenceMass['tightness']} w=${zeroOpp.resolved.blendWeight['tightness']}`,
});
const nullStats = snap({ base: 'NORMAL', hands: 1000, fields: ['vpip'] });
const withNull = resolvePlayerProfile({
  baseArchetype: 'NORMAL' as never,
  observedStats: S({ handsObserved: 1000, vpip: 0.42, wtsd: null, pfr: undefined } as never),
}) as unknown as { resolved: { evidenceMass: M } };
checks.push({
  id: '5. null / undefined contribution = 0',
  pass: withNull.resolved.evidenceMass['passivity'] === 0 &&
    withNull.resolved.evidenceMass['aggression'] === 0,
  detail: `null WTSD ⇒ passivity mass=${withNull.resolved.evidenceMass['passivity']}；undefined PFR ⇒ aggression mass=${withNull.resolved.evidenceMass['aggression']}（参考 v1 tightness mass=${nullStats.mass['tightness']!.toFixed(1)}）`,
});
checks.push({
  id: '6. 无证据的轴 ⇒ resolved == base',
  pass: allSnaps.every((s) => AXES.every((a) => (s.mass[a] === 0 ? s.resolved[a] === s.base[a] : true))),
  detail: 'bluffTendency 在全部快照上都应逐位等于 base',
});
const s1 = snap({ base: 'NORMAL', hands: 500 });
const s2 = snap({ base: 'NORMAL', hands: 500 });
checks.push({
  id: '7. 同输入重复运行 ⇒ bitwise deterministic',
  pass: AXES.every((a) => s1.resolved[a] === s2.resolved[a] && s1.w[a] === s2.w[a]),
  detail: '',
});
checks.push({
  id: '8. 20→…→1500 手：证据影响总体单调',
  pass: AXES.every((a) => {
    const xs = HANDS.map((_, i) => SNAPS[i]!.s.w[a]!);
    for (let i = 1; i < xs.length; i += 1) if (xs[i]! < xs[i - 1]!) return false;
    return true;
  }),
  detail: 'handss 递增时 w 不得回落',
});
checks.push({
  id: '9. 大样本 ⇒ resolved 接近 observedOnly',
  pass: AXES.filter((a) => SNAPS[7]!.s.mass[a]! > 0)
    .every((a) => Math.abs(SNAPS[7]!.s.resolved[a]! - SNAPS[7]!.s.observed[a]!) <
      Math.abs(SNAPS[7]!.s.resolved[a]! - SNAPS[7]!.s.base[a]!)),
  detail: '3000 手时距离 observed 必须小于距离 base',
});
checks.push({
  id: '10. 小样本 ⇒ resolved 接近 base',
  pass: AXES.filter((a) => SNAPS[0]!.s.mass[a]! > 0)
    .every((a) => Math.abs(SNAPS[0]!.s.resolved[a]! - SNAPS[0]!.s.base[a]!) < 0.1),
  detail: '25 手时与 base 的差必须 < 0.1',
});

for (const c of checks) {
  line(`  ${c.pass ? '✅ PASS' : '❌ FAIL'}  ${c.id}${c.detail === '' ? '' : ` ｜ ${c.detail}`}`);
}
line('');
line(`  汇总：${checks.filter((c) => c.pass).length} / ${checks.length} 通过`);
line('');
