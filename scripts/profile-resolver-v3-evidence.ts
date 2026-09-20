/**
 * PLAYER PROFILE V3 RESOLVER 修复 —— 证据表（可复跑）
 *
 * 输出三张供报告引用的表：
 *   ① Before / After 维度对照（修复前数值在 `reports/` 与 TEST 12 的旧输出里已记录）
 *   ② 四象限（松/紧 × 凶/被动）—— 轴独立性
 *   ③ 证据饱和（100/500/1500/5000 手）与标签矛盾过渡（50/500/1500 手）
 *
 * 用法：node --experimental-strip-types scripts/profile-resolver-v3-evidence.ts
 */

import {
  resolvePlayerProfile,
  STAT_EVIDENCE_SPECS,
  ALL_OBSERVED_STAT_KEYS,
  K_PROFILE_LABEL,
  OBSERVED_AXIS_SHRINK_MASS,
  type PlayerObservedStats,
} from '../src/domain/player/observedStats.ts';
import { ARCHETYPE_DIMENSIONS } from '../src/domain/player/archetypeDimensions.ts';
import type { QuickProfile } from '../src/app/manualInput/manualInput.ts';

type Dims = { tightness: number; aggression: number; bluffTendency: number; passivity: number };
const AXES = ['tightness', 'aggression', 'bluffTendency', 'passivity'] as const;

const S = (o: Partial<PlayerObservedStats> & { handsObserved: number }): PlayerObservedStats =>
  o as PlayerObservedStats;

function R(base: QuickProfile | null, stats: PlayerObservedStats | null) {
  return resolvePlayerProfile({ baseArchetype: base as never, observedStats: stats }) as unknown as {
    resolved: {
      observedOnlyDimensions: Dims; resolvedDimensions: Dims; baseDimensions: Dims;
      evidenceMass: Record<string, number>; blendWeight: Record<string, number>;
    };
  };
}
const fused = (b: QuickProfile | null, s: PlayerObservedStats | null): Dims => R(b, s).resolved.resolvedDimensions;
const f = (x: unknown, d = 4): string => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '—');
const pad = (s: unknown, n: number): string => String(s).padEnd(n);
const line = (s = ''): void => console.log(s);

const TRUE_CS = S({
  handsObserved: 1500,
  vpip: 0.52, pfr: 0.09, threeBet: 0.03, wtsd: 0.43,
  foldToFlopCBet: 0.20, foldToTurnCBet: 0.18, foldToRiverBet: 0.14,
  flopCheckRaise: 0.04, turnCheckRaise: 0.03, riverCheckRaise: 0.02,
});
const TIGHT_WEAK = S({
  handsObserved: 1500,
  vpip: 0.18, pfr: 0.12, threeBet: 0.04, wtsd: 0.20,
  foldToFlopCBet: 0.52, foldToTurnCBet: 0.61, foldToRiverBet: 0.68,
  foldCheckRaise: undefined as never, flopCheckRaise: 0.03, turnCheckRaise: 0.02, riverCheckRaise: 0.01,
} as never);

line('='.repeat(104));
line(' PLAYER PROFILE V3 RESOLVER 修复 —— 证据表');
line('='.repeat(104));
line();

/* ---------- ① 锚点总表 ---------- */
line('### ① 逐统计锚点 / 半宽（P0-A：替换统一的 0.5 锚点）');
line('');
line(pad('统计', 18) + pad('旧锚点', 9) + pad('旧公式', 22) + pad('新锚点', 10) + pad('半宽', 8) + '新公式 −1 / +1 对应值');
line('-'.repeat(100));
for (const key of ALL_OBSERVED_STAT_KEYS) {
  const s = STAT_EVIDENCE_SPECS[key];
  line(pad(key, 18) + pad('0.5', 9) + pad('(rate−0.5)×2', 22) +
    pad(f(s.neutralAnchor, 2), 10) + pad(f(s.scale, 2), 8) +
    `${f(s.neutralAnchor - s.scale, 2)} / ${f(s.neutralAnchor + s.scale, 2)}`);
}
line('');
line(`  归一化：deviation = clamp((rate − neutralAnchor) / scale, −1, +1)`);
line(`  轴内收缩质量 = ${OBSERVED_AXIS_SHRINK_MASS}（朝**中性 0.5**）｜标签伪机会数 K_PROFILE_LABEL = ${K_PROFILE_LABEL}（朝**标签**）`);
line('');

/* ---------- ② Before / After ---------- */
line('### ② Before / After（同一份实测统计）');
line('');
line(pad('画像', 26) + pad('指标', 14) + pad('Before', 10) + pad('After', 10) + ' 变化');
line('-'.repeat(76));
const beforeAfter: readonly [string, string, number, number][] = [
  ['真跟注站 + CS 标签', 'tightness', 0.5377, fused('CALLING_STATION', TRUE_CS).tightness],
  ['真跟注站 + CS 标签', 'aggression', 0.2277, fused('CALLING_STATION', TRUE_CS).aggression],
  ['真跟注站 + CS 标签', 'passivity', 0.4700, fused('CALLING_STATION', TRUE_CS).passivity],
  ['真跟注站 + CS 标签', 'bluffTendency', 0.5000, fused('CALLING_STATION', TRUE_CS).bluffTendency],
  ['紧弱 + CS 标签（贴错）', 'tightness', 0.6862, fused('CALLING_STATION', TIGHT_WEAK).tightness],
  ['紧弱 + CS 标签（贴错）', 'passivity', 0.3714, fused('CALLING_STATION', TIGHT_WEAK).passivity],
  ['紧弱 + CS 标签（贴错）', 'aggression', 0.2411, fused('CALLING_STATION', TIGHT_WEAK).aggression],
  ['紧弱 + CS 标签（贴错）', 'bluffTendency', 0.5000, fused('CALLING_STATION', TIGHT_WEAK).bluffTendency],
];
for (const [who, metric, before, after] of beforeAfter) {
  line(pad(who, 26) + pad(metric, 14) + pad(f(before), 10) + pad(f(after), 10) +
    ` ${after > before ? '↑' : after < before ? '↓' : '='} ${f(after - before)}`);
}
line('');
line('  Before = 统一 0.5 锚点 + 标签被覆盖（TEST 12 修复前实测值，已记录）');
line('  After  = 逐统计锚点 + 标签融合（本脚本实时计算）');
line('');

/* ---------- ③ 四象限 ---------- */
line('### ③ 四象限（label = NORMAL，只有实测在说话）');
line('');
const quadrants: readonly [string, Partial<PlayerObservedStats>][] = [
  ['Loose Passive  松被动', { vpip: 0.45, pfr: 0.09, threeBet: 0.03, wtsd: 0.40 }],
  ['Loose Aggressive 松凶', { vpip: 0.45, pfr: 0.35, threeBet: 0.15, wtsd: 0.28 }],
  ['Tight Passive  紧被动', { vpip: 0.18, pfr: 0.08, threeBet: 0.03, wtsd: 0.35 }],
  ['Tight Aggressive 紧凶', { vpip: 0.18, pfr: 0.28, threeBet: 0.14, wtsd: 0.24 }],
];
line(pad('象限', 26) + pad('VPIP/PFR/3Bet/WTSD', 22) + pad('tightness', 11) + pad('aggression', 12) + 'passivity');
line('-'.repeat(84));
for (const [name, spec] of quadrants) {
  const stats = S({ handsObserved: 1500, ...spec } as never);
  const d = fused('NORMAL', stats);
  line(pad(name, 26) +
    pad(`${spec.vpip}/${spec.pfr}/${spec.threeBet}/${spec.wtsd}`, 22) +
    pad(f(d.tightness), 11) + pad(f(d.aggression), 12) + f(d.passivity));
}
line('');
line('  ⇒ 松/紧由 VPIP·3Bet 决定，凶/被动由 PFR·3Bet 决定 —— **两轴可以独立翻转**，');
line('     四种组合全部可表达（不存在「松⇒凶」或「紧⇒被动」的机械绑定）。');
line('');

/* ---------- ④ 饱和与过渡 ---------- */
line('### ④ 证据饱和（同观察率，只加手数；label = CALLING_STATION，实测 = 紧弱）');
line('');
line(pad('手数', 10) + pad('evidenceMass', 14) + pad('blendWeight w', 15) + pad('tightness', 11) + pad('passivity', 11) + 'bluffTendency');
line('-'.repeat(76));
for (const n of [50, 100, 500, 1500, 3000, 5000]) {
  const p = R('CALLING_STATION', S({ ...TIGHT_WEAK, handsObserved: n }));
  const d = p.resolved.resolvedDimensions;
  line(pad(n, 10) + pad(f(p.resolved.evidenceMass['tightness'], 1), 14) +
    pad(f(p.resolved.blendWeight['tightness']), 15) + pad(f(d.tightness), 11) +
    pad(f(d.passivity), 11) + f(d.bluffTendency));
}
line('');
line(`  base（CS 标签）= tightness ${f(ARCHETYPE_DIMENSIONS.CALLING_STATION!.tightness, 2)} / ` +
  `passivity ${f(ARCHETYPE_DIMENSIONS.CALLING_STATION!.passivity, 2)} / ` +
  `bluffTendency ${f(ARCHETYPE_DIMENSIONS.CALLING_STATION!.bluffTendency, 2)}`);
line('  ⇒ tightness 随样本单调向紧侧移动且增量递减；passivity 同理；');
line('     **bluffTendency 恒定等于标签**（无观测通道 ⇒ 保留标签，不再被清成 0.5）。');
line('');
