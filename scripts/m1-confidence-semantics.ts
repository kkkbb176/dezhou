/**
 * M1 · confidence 语义量化（只读；不修改任何生产代码）
 *
 * 用**生产函数**回答：
 *   Q1 `responseTendenciesOf(dims, conf)` 的 conf 作用在什么上？
 *   Q2 融合维度 + 0.35 是否构成「对实测部分的二次衰减」？
 *   Q3 融合维度 + 1.0 是否放大标签原有的响应倾向？
 *   Q4 是否存在一个**现有**标量能正确表达「融合画像」？
 */
import { responseTendenciesOf, neutralResponseTendencies } from '../src/domain/postflop/betResponse.ts';
import { archetypeDimensionsOf } from '../src/domain/player/archetypeDimensions.ts';
import { resolvePlayerProfile, betScaleOfUnifiedDimensions } from '../src/domain/player/observedStats.ts';
import { QUICK_PROFILE_CONFIDENCE } from '../src/app/manualInput/manualInput.ts';

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const pad = (s: string, w: number): string => {
  const len = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, w - len));
};
const rule = (w = 140): string => '='.repeat(w);

const STATS = {
  handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
  foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
} as const;

const label = archetypeDimensionsOf('MANIAC' as never, QUICK_PROFILE_CONFIDENCE)!;
const v3 = resolvePlayerProfile({
  baseArchetype: 'MANIAC' as never, observedStats: STATS as never, opportunities: null,
  actionContext: null, street: 'RIVER',
});
const observed = v3.resolved.observedOnlyDimensions;
const fused = v3.resolved.resolvedDimensions;
const base = v3.resolved.baseDimensions;
const w = v3.resolved.blendWeight;
const mass = v3.resolved.evidenceMass;

const C = (v: number): number => (v - 0.5) * 2;
const axes = ['tightness', 'aggression', 'bluffTendency', 'passivity'] as const;

line(rule());
line(' ① 三个维度层（MANIAC 标签 + 800 手四项统计）与逐轴融合权重');
line(rule());
line('  ' + pad('轴', 16) + pad('center(标签)', 14) + pad('center(实测)', 14) + pad('center(融合)', 14) + pad('blendWeight w', 14) + pad('evidenceMass', 14) + '说明');
for (const ax of axes) {
  line('  ' + pad(ax, 16) + pad(n(C(base[ax]), 4), 14) + pad(n(C(observed[ax]), 4), 14) + pad(n(C(fused[ax]), 4), 14) +
    pad(n(w[ax], 4), 14) + pad(n(mass[ax], 0), 14) +
    (mass[ax] === 0 ? '无证据 ⇒ 融合 = 标签（保持标签值）' : `融合 = (1−w)·标签 + w·实测`));
}

line('');
line(rule());
line(' ② `responseTendenciesOf(dims, conf)` 在四种输入下的输出（全部调用生产函数）');
line(rule());
line('  公式：raw = 1 + Σ coef×center(dims)；输出 scale = 1 + (raw − 1) × conf');
line('');
const CASES: [string, typeof label, number][] = [
  ['(a) 标签 + 0.35【今天的面对下注层】', label, QUICK_PROFILE_CONFIDENCE],
  ['(b) 融合 + 0.35（把 dims 换成融合）', fused, QUICK_PROFILE_CONFIDENCE],
  ['(c) 融合 + 1.00（去掉下游 conf）', fused, 1],
  ['(d) 标签 + 1.00（仅作对照）', label, 1],
];
line('  ' + pad('输入', 34) + pad('跟注 callScale', 16) + pad('弃牌 foldScale', 16) + pad('加注 raiseScale', 16) +
  pad('诈唬加注 bluffRaise', 18) + pad('过牌后下注 riverBet', 18) + '与 (a) 的偏离');
const baseT = responseTendenciesOf(label as never, QUICK_PROFILE_CONFIDENCE, null);
for (const [tag, dims, conf] of CASES) {
  const t = responseTendenciesOf(dims as never, conf, null);
  const dev = (k: 'callScale' | 'foldScale' | 'raiseScale' | 'bluffRaiseScale' | 'riverBetScale'): number =>
    Math.abs((t[k] as number) - 1) - Math.abs((baseT[k] as number) - 1);
  line('  ' + pad(tag, 34) + pad(n(t.callScale), 16) + pad(n(t.foldScale), 16) + pad(n(t.raiseScale), 16) +
    pad(n(t.bluffRaiseScale), 18) + pad(n(t.riverBetScale), 18) +
    `Δ跟 ${n(dev('callScale'), 4)}｜Δ弃 ${n(dev('foldScale'), 4)}｜Δ加 ${n(dev('raiseScale'), 4)}`);
}

line('');
line('  ── 拆解：融合后的响应偏离 = 标签份额 + 实测份额（center 是仿射函数 ⇒ 可逐项分解）──');
line('  ' + pad('输入', 34) + pad('conf', 8) + pad('标签份额贡献（×conf）', 24) + pad('实测份额贡献（×conf）', 24) + '标签是否被放大？');
{
  const COEF = { tightness: { call: -0.18, fold: 0.32 }, passivity: { call: 0.30, fold: -0.25 } } as const;
  void COEF;
  /* 用**可观测的**方式做分解：把「标签维度」与「融合维度」分别按 conf 缩放，比较其中心偏移 */
  const scaleOf = (dims: typeof label, conf: number): number => responseTendenciesOf(dims as never, conf, null).callScale;
  const labelOnly = scaleOf(label, QUICK_PROFILE_CONFIDENCE) - 1;
  const fusedAt035 = scaleOf(fused, QUICK_PROFILE_CONFIDENCE) - 1;
  const fusedAt1 = scaleOf(fused, 1) - 1;
  line('  ' + pad('标签 + 0.35', 34) + pad('0.35', 8) + pad(n(labelOnly, 6), 24) + pad('—（无实测）', 24) + '基准');
  line('  ' + pad('融合 + 0.35', 34) + pad('0.35', 8) + pad('(1−w)·0.35·… 见下', 24) + pad('w·0.35·… 见下', 24) +
    (Math.abs(fusedAt035) > Math.abs(labelOnly) ? '是 ⚠️' : '否（≤ 基准）'));
  line('  ' + pad('融合 + 1.00', 34) + pad('1.00', 8) + pad('(1−w)·1.00·…', 24) + pad('w·1.00·…', 24) +
    (Math.abs(fusedAt1) > Math.abs(labelOnly) ? '**是（放大 ' + n(Math.abs(fusedAt1) / Math.abs(labelOnly), 2) + '×）**' : '否'));
}

line('');
line(rule());
line(' ③ 逐轴 w 与「融合画像」的可用标量（回答 Q4）');
line(rule());
line(`  · 逐轴 blendWeight = ${axes.map((a) => `${a}=${n(w[a], 4)}`).join('、')}`);
line('  · 证据质量加权平均 w̄ = ' +
  n(axes.reduce((s, a) => s + w[a] * mass[a], 0) / Math.max(1, axes.reduce((s, a) => s + mass[a], 0)), 4) +
  '（若把它当 conf：标签份额会被 ×w̄、实测份额被 ×w̄·w ⇒ 仍是单标量，无法分别表达两个来源）');
line('  · `resolvePlayerProfile` 暴露的字段：dims / observedOnly / resolved / base / evidenceMass / blendWeight / street /');
line('    observedStatCount / confidenceTierZh(文本档) —— **没有任何标量 confidence**（见 observedStats.ts:1652-1712）');
line('  · `resolveTendencyDimensions({measured, measuredConfidence, quickProfile})` 的契约是「同一量的两个估计」：');
line('    measuredConfidence ≥ 0.35 时**标签整体退出**（archetypeDimensions.ts:304-309）—— 与 V3「标签按 w 保留」的融合口径冲突，不能复用。');
line('');
line('  ⇒ Q1：conf 作用在**整套画像偏离**上（raw−1 整体 × conf），不是只作用于标签→实测的差额。');
line('  ⇒ Q2：融合 + 0.35 ⇒ 实测份额被额外 ×0.35（0.35 = 手选标签可信度上限，与实测证据无关）⇒ 二次衰减成立。');
line('  ⇒ Q3：融合 + 1.00 ⇒ 标签份额由 0.35 变为 (1−w)（本例 0.37/0.33/1.00/0.68）⇒ 对多数轴是**放大**（最大 2.9×，见上表）。');
line('  ⇒ Q4：**现有接口没有任何标量能正确表达「标签按 0.35、实测按样本」这两个来源**；');
line('         `betScaleOfUnifiedDimensions` 是项目自己的反例先例：融合维度**整份只进一次、不再乘 conf**（observedStats.ts:1142-1162）。');
line(rule());
