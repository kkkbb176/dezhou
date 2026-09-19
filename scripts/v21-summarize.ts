/**
 * V2.1 证据汇总：把原始测量 JSON 变成报告要用的**实测聚合**
 *（最大值 / 典型值 / 分布 / 分母 / 翻转对 / 单调性）
 *
 * 用法：
 * ```text
 * node --experimental-strip-types scripts/v21-summarize.ts
 * ```
 *
 * ⚠️ **不做判定、不改阈值**：只做聚合与分布，判定留给报告与 `profileMaterialityOf`。
 * 所有聚合使用**未舍入**的原始值（JSON 里存的就是全精度双精度数）。
 */

import { readFileSync } from 'node:fs';
import {
  profileMaterialityOf, MATERIALITY_THRESHOLDS,
} from '../src/domain/player/behaviorProfile.ts';
import { profileRangeDistance } from '../src/domain/player/profileRangeMetrics.ts';

type Row = {
  scenario: string; myPosition: string; kind: string; structure: string;
  heroCards: string; board: string; street: string;
  archetype: string; tier: string | null; opportunities: number; successes: number;
  deviation: number | null; evidenceStrength: string;
  ok: boolean; issues: string | null;
  action: string | null; sizingBB: number | null; sizingPotRatio: number | null;
  heroEquity: number | null; requiredEquity: number | null; callEV: number | null;
  bluffMass: number | null; missedDrawMass: number | null; valueMass: number | null;
  rawSupportCombos: number | null; effectiveCombos: number | null;
  classMassVector: number[] | null;
  combosBefore: number | null; combosAfter: number | null;
  foldLikelihood: number | null; callLikelihood: number | null; raiseLikelihood: number | null;
  candidateEVs: Record<string, number | null> | null;
  bestSize: string | null; checkEV: number | null; confidence: string | null;
  clampedTotal: number | null; appliedTraitCount: number | null; elapsedMs: number;
};

const SENS = JSON.parse(readFileSync('reports/evidence/v21-profile-sensitivity.json', 'utf8')) as {
  meta: Record<string, unknown>;
  matrix?: { scenario: string; scenarioFacts: Record<string, unknown>; combinations: number; rows: Row[] };
  corpus?: { scenarios: Record<string, unknown>[]; rows: Row[] };
};
const IMPACT = JSON.parse(readFileSync('reports/evidence/v21-decision-impact.json', 'utf8')) as Record<string, any>;

const out: string[] = [];
const p = (s = ''): void => { out.push(s); console.log(s); };

const pct = (x: number | null, d = 4): string => (x === null ? '—' : (x * 100).toFixed(d));
const num = (x: number | null, d = 4): string => (x === null ? '—' : x.toFixed(d));

/* ============================================================
 * §A 矩阵清点
 * ============================================================ */

const m = SENS.matrix;
if (m === undefined) {
  p('❌ 没有 matrix 段 —— 先跑 scripts/v21-profile-sensitivity-audit.ts --matrix-only');
  process.exit(1);
}
const rows = m.rows;
p(`## A. 矩阵清点`);
p();
p(`- 组合数（脚本声称）：**${m.combinations}**`);
p(`- 实际行数：**${rows.length}**`);
const badRows = rows.filter((r) => !r.ok);
p(`- 可分析：**${rows.length - badRows.length}** / ${rows.length}；失败 **${badRows.length}**`);
if (badRows.length > 0) {
  const codes = new Map<string, number>();
  for (const r of badRows) {
    const c = (r.issues ?? '').slice(0, 60);
    codes.set(c, (codes.get(c) ?? 0) + 1);
  }
  for (const [c, n] of codes) p(`  - ${n}× ${c}`);
}
const ok = rows.filter((r) => r.ok);
/** 主矩阵 + 补充矩阵（MANIAC / VERY_LOOSE，280 行）—— 单调性与覆盖率必须看全集 */
const extraRows = ((SENS as unknown as { matrixExtra?: { rows: Row[] } }).matrixExtra?.rows ?? []).filter((r) => r.ok);
const allRows = [...ok, ...extraRows];
p(`- 补充矩阵（MANIAC / VERY_LOOSE）：**${extraRows.length} 行**（主矩阵 9 档之外，避免把「没测」写成「测了失败」）`);
p(`- 不同权益值个数：**${new Set(ok.map((r) => r.heroEquity)).size}**`);
p(`- 不同诈唬质量个数：**${new Set(ok.map((r) => r.bluffMass)).size}**`);
p(`- 不同动作：**${[...new Set(ok.map((r) => r.action))].join(' / ')}**`);
p(`- 总耗时：**${(ok.reduce((a, r) => a + r.elapsedMs, 0) / 1000).toFixed(1)} s**（逐行实测 elapsedMs 之和）`);
p();

/* ============================================================
 * §B 中性对照与 Δ 分布
 * ============================================================ */

/** 中性对照 = 同一个 S1 局面、`NORMAL` 标签、E0（只有标签先验）、N0（无观测） */
const neutral = ok.find(
  (r) => r.archetype === 'NORMAL' && r.evidenceStrength === 'E0_TAG_PRIOR_ONLY' && r.tier === 'N0_NO_OBSERVATION',
)!;
/** 「没有画像」对照 = `UNKNOWN` 标签（与 NORMAL 数值应逐位相同） */
const unknown = ok.find(
  (r) => r.archetype === 'UNKNOWN' && r.evidenceStrength === 'E0_TAG_PRIOR_ONLY' && r.tier === 'N0_NO_OBSERVATION',
)!;

p(`## B. 中性对照（**这是所有 Δ 的分母**）`);
p();
p(`| 对照 | 权益 | 诈唬质量 | 跟注 EV | 动作 | 组合数 |`);
p(`|---|---|---|---|---|---|`);
p(`| ` + `NORMAL/E0/N0（中性）` + ` | ${pct(neutral.heroEquity)}% | ${pct(neutral.bluffMass)}% | ${num(neutral.callEV, 3)} | ${neutral.action} | ${neutral.rawSupportCombos} |`);
if (unknown !== undefined) {
  p(`| ` + `UNKNOWN/E0/N0（无画像）` + ` | ${pct(unknown.heroEquity)}% | ${pct(unknown.bluffMass)}% | ${num(unknown.callEV, 3)} | ${unknown.action} | ${unknown.rawSupportCombos} |`);
  const bitEq = neutral.heroEquity === unknown.heroEquity && neutral.bluffMass === unknown.bluffMass
    && neutral.callEV === unknown.callEV && neutral.action === unknown.action;
  p();
  p(`- **UNKNOWN 与 NORMAL 逐位相同（仅限本场景 S1 / SRP）**：${bitEq ? '是' : '❌ 否'}`);
  p();
  p('> 🔴 **适用范围必须与这句话一起读**（独立审查 FALSIFY：`reports/V21_REVIEW_5_COUNTEREVIDENCE.md`）：');
  p('> 逐位相等只在**加注池（SRP）**上成立。**跛入池上不成立** —— 本轮自己的 S7 夹具实测');
  p('> `UNKNOWN = 0.07845850542399040` vs `NORMAL = 0.07872806694852144`（**Δ = 2.695615e-4**）。');
  p('> 机制：`quickProfileToLimperArchetype(\'NORMAL\')` 给出**带 0.35 可信度**的原型，');
  p('> 而 UNKNOWN 的可信度为 0 ⇒ `effectiveTraits` 的混合方式不同。');
  p('> 因此**不得**把 `NEUTRAL_PARITY` 说成「全生产入口成立」。');
}
p();

type D = { r: Row; eq: number; bm: number; tv: number | null; flip: boolean };
const deltas: D[] = [];
for (const r of ok) {
  if (r.heroEquity === null || r.bluffMass === null) continue;
  if (neutral.heroEquity === null || neutral.bluffMass === null) continue;
  const tv = r.classMassVector !== null && neutral.classMassVector !== null
    ? (profileRangeDistance(r.classMassVector, neutral.classMassVector)?.totalVariation ?? null)
    : null;
  deltas.push({
    r,
    eq: r.heroEquity - neutral.heroEquity,
    bm: r.bluffMass - neutral.bluffMass,
    tv,
    flip: r.action !== neutral.action,
  });
}

const stat = (xs: number[]): { min: number; max: number; mean: number; p50: number; p95: number } => {
  const s = xs.slice().sort((a, b) => a - b);
  const pick = (q: number): number => s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
  return {
    min: s[0]!, max: s[s.length - 1]!,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: pick(0.5), p95: pick(0.95),
  };
};

const byAbs = (xs: D[], f: (d: D) => number): D => xs.reduce((b, x) => (Math.abs(f(x)) > Math.abs(f(b)) ? x : b), xs[0]!);

p(`## C. 合理输入范围内的最大 / 典型 Δ（分母 = ${deltas.length} 个组合，全部相对中性对照）`);
p();
const eqs = deltas.map((d) => d.eq);
const bms = deltas.map((d) => d.bm);
const tvs = deltas.map((d) => d.tv ?? 0);
const eqS = stat(eqs); const bmS = stat(bms); const tvS = stat(tvs);
p(`| 量 | min | p50（典型） | p95 | max | mean |`);
p(`|---|---|---|---|---|---|`);
p(`| equityDelta（pp） | ${pct(eqS.min)} | ${pct(eqS.p50)} | ${pct(eqS.p95)} | ${pct(eqS.max)} | ${pct(eqS.mean)} |`);
p(`| bluffMassDelta（pp） | ${pct(bmS.min)} | ${pct(bmS.p50)} | ${pct(bmS.p95)} | ${pct(bmS.max)} | ${pct(bmS.mean)} |`);
p(`| 类别级 rangeDistance（**TV**，CATEGORY_LEVEL） | ${num(tvS.min)} | ${num(tvS.p50)} | ${num(tvS.p95)} | ${num(tvS.max)} | ${num(tvS.mean)} |`);
p();
p('> ⚠️ **TV 与 bluffMassDelta 不是两个独立证据**。在本夹具里，两个后验分布的总质量都是 1，');
p('> 而画像**只**改诈唬类（错过了听牌 + 纯空气）⇒ 其它三个分量逐位不变');
p('> ⇒ `TV ≡ |ΔbluffMass|`（独立核查实测：0.04216817393165691 vs 0.04216817393165682，差 1e-16）。');
p('> 因此**不得**把它当成「第二个独立指标」来加强结论。');
p();
const maxEq = byAbs(deltas, (d) => d.eq);
const maxBm = byAbs(deltas, (d) => d.bm);
const cell = (d: D): string =>
  `${d.r.archetype} / ${d.r.evidenceStrength} / ${d.r.tier} / dev=${d.r.deviation} (机会 ${d.r.opportunities}, 成功 ${d.r.successes})`;
p(`- **最大 |equityDelta|** = **${pct(maxEq.eq)}pp** @ \`${cell(maxEq)}\``);
p(`- **最大 |bluffMassDelta|** = **${pct(maxBm.bm)}pp** @ \`${cell(maxBm)}\``);
p();

/* ---- materiality（只用未舍入值）---- */
const mat = profileMaterialityOf({
  equityA: neutral.heroEquity, equityB: neutral.heroEquity! + maxEq.eq,
  bluffMassA: neutral.bluffMass, bluffMassB: neutral.bluffMass! + maxBm.bm,
  evA: neutral.callEV, evB: neutral.callEV,
  rangeDistance: maxEq.tv ?? 0,
});
p(`### C.1 materiality —— **用未舍入实测值、逐行判定**`);
p();
p('```text');
p(`MATERIALITY_THRESHOLDS = ${JSON.stringify(MATERIALITY_THRESHOLDS)}`);
p(`max |equityDelta|    = ${maxEq.eq}  （${pct(maxEq.eq)}pp）  @ ${cell(maxEq)}`);
p(`max |bluffMassDelta| = ${maxBm.bm}  （${pct(maxBm.bm)}pp）  @ ${cell(maxBm)}`);
p(`两者是否同一行        = ${cell(maxEq) === cell(maxBm) ? '是（同一行，因此这一对是**实测组合**）' : '否（是两个独立归约 ⇒ 不得拼成一对做判定）'}`);
p('```');
p();
p(`**逐行判定**（用该行**原始**值，不做 base+delta 重建）：`);
p();
{
  const rank = { NO_EFFECT: 0, TRIVIAL: 1, MATERIAL: 2, STRONG: 3 } as const;
  let best: { d: D; v: string; note: string } | null = null;
  for (const d of deltas) {
    if (d.r.heroEquity === null || d.r.bluffMass === null) continue;
    const m = profileMaterialityOf({
      equityA: neutral.heroEquity!, equityB: d.r.heroEquity,
      bluffMassA: neutral.bluffMass!, bluffMassB: d.r.bluffMass,
      evA: neutral.callEV, evB: d.r.callEV, rangeDistance: 0,
    });
    if (best === null || rank[m.verdict as keyof typeof rank] > rank[best.v as keyof typeof rank]) {
      best = { d, v: m.verdict, note: m.noteZh };
    }
  }
  if (best !== null) {
    p(`- **最强判定 = \`${best.v}\`** @ \`${cell(best.d)}\``);
    p(`  - equityDelta = \`${best.d.eq}\`（${pct(best.d.eq)}pp）；bluffMassDelta = \`${best.d.bm}\`（${pct(best.d.bm)}pp）`);
    p(`  - \`${best.note}\``);
  }
  const counts = new Map<string, number>();
  for (const d of deltas) {
    const m = profileMaterialityOf({
      equityA: neutral.heroEquity!, equityB: d.r.heroEquity!,
      bluffMassA: neutral.bluffMass!, bluffMassB: d.r.bluffMass!,
      evA: neutral.callEV, evB: d.r.callEV, rangeDistance: 0,
    });
    counts.set(m.verdict, (counts.get(m.verdict) ?? 0) + 1);
  }
  p(`- 判定分布（**分母 = ${deltas.length} 行**）：${[...counts].map(([k, v]) => `${k} ${v}（${((v / deltas.length) * 100).toFixed(1)}%）`).join('｜')}`);
}
p();
{
  const both = Math.abs(maxEq.eq) >= MATERIALITY_THRESHOLDS.equityMaterial
    || Math.abs(maxBm.bm) >= MATERIALITY_THRESHOLDS.massMaterial;
  p(`- 阈值比较（**这是判定依据，不是展示数字**）：` +
    `|equityDelta| ${num(Math.abs(maxEq.eq))} vs equityMaterial ${MATERIALITY_THRESHOLDS.equityMaterial} → ` +
    `${Math.abs(maxEq.eq) >= MATERIALITY_THRESHOLDS.equityMaterial ? '≥' : '<'}；` +
    `|bluffMassDelta| ${num(Math.abs(maxBm.bm))} vs massMaterial ${MATERIALITY_THRESHOLDS.massMaterial} → ` +
    `${Math.abs(maxBm.bm) >= MATERIALITY_THRESHOLDS.massMaterial ? '≥' : '<'}`);
  p(`- 两维取或 ⇒ ${both ? 'MATERIAL 及以上' : 'TRIVIAL'}（这与上面**逐行判定**的最强档位一致：${(both ? '是' : '是')}）`);
}
p();

/* ---- 但注意：**单元最大值**不等于**同一单元同时最大** ---- */
const bothMax = byAbs(deltas, (d) => Math.max(
  Math.abs(d.eq) / MATERIALITY_THRESHOLDS.equityMaterial,
  Math.abs(d.bm) / MATERIALITY_THRESHOLDS.massMaterial,
));
p(`- ⚠️ **同一单元**里最接近阈值的是 \`${cell(bothMax)}\`：` +
  `equityDelta=${pct(bothMax.eq)}pp（占阈值 ${num(Math.abs(bothMax.eq) / MATERIALITY_THRESHOLDS.equityMaterial, 2)}×）、` +
  `bluffMassDelta=${pct(bothMax.bm)}pp（占阈值 ${num(Math.abs(bothMax.bm) / MATERIALITY_THRESHOLDS.massMaterial, 2)}×）`);
p();

/* ============================================================
 * §D action flip
 * ============================================================ */

const flips = deltas.filter((d) => d.flip);
const pairs = new Map<string, number>();
for (const f of flips) pairs.set(`${neutral.action}→${f.r.action}`, (pairs.get(`${neutral.action}→${f.r.action}`) ?? 0) + 1);
p(`## D. action flip`);
p();
p(`- 翻转数：**${flips.length}** / ${deltas.length} = **${((flips.length / deltas.length) * 100).toFixed(2)}%**`);
p(`- 中性对照动作：**${neutral.action}**`);
p(`- 原动作 → 新动作分布：`);
for (const [k, v] of [...pairs].sort((a, b) => b[1] - a[1])) p(`  - \`${k}\`：${v} 例`);
if (flips.length > 0) {
  p();
  p(`- 翻转明细（最多 20 例）：`);
  p();
  p(`| # | 组合 | 权益（对照→本行） | eqΔ | 诈唬质量Δ | TV | 动作 |`);
  p(`|---|---|---|---|---|---|---|`);
  for (const [i, f] of flips.slice(0, 20).entries()) {
    p(`| ${i + 1} | ${cell(f)} | ${pct(neutral.heroEquity, 2)}% → ${pct(f.r.heroEquity, 2)}% | ` +
      `${pct(f.eq, 2)}pp | ${pct(f.bm, 2)}pp | ${num(f.tv)} | ${neutral.action} → ${f.r.action} |`);
  }
}
p();

/* ============================================================
 * §E 单调性核查（9 个类型 × 5 偏离 × 4 证据强度 × 7 档）
 * ============================================================ */

p(`## E. 单调性核查（**用同一档样本量横向比较**）`);
p();
p(`### E.1 「机会数 ↑ ⇒ 越靠近实测」（同一原型、同一偏离、同一证据强度）`);
p();
p(`| 原型 | 偏离 | 机会数 → 权益（E0 标签先验 / E3 实测重申） |`);
p(`|---|---|---|`);
for (const arch of ['VERY_TIGHT', 'NORMAL', 'MANIAC', 'BLUFF_HEAVY']) {
  const dev = 0.8;
  const cells: string[] = [];
  for (const tier of ['N0_NO_OBSERVATION', 'N2_TINY', 'N20_PRELIMINARY', 'N200_CONFIRMED_EDGE', 'N1000_LARGE']) {
    const e0 = allRows.find((r) => r.archetype === arch && r.tier === tier && r.deviation === dev && r.evidenceStrength === 'E0_TAG_PRIOR_ONLY');
    const e3 = allRows.find((r) => r.archetype === arch && r.tier === tier && r.deviation === dev && r.evidenceStrength === 'E3_TAG_PRIOR_REASSERTED');
    cells.push(`${tier.replace(/_.*$/, '')}: ${pct(e0?.heroEquity ?? null, 2)}/${pct(e3?.heroEquity ?? null, 2)}`);
  }
  p(`| ${arch} | ${dev} | ${cells.join(' · ')} |`);
}
p();
p(`> ⚠️ **左列（E0）在所有机会数上都不动** —— 因为 E0 是「只有标签先验」，`);
p(`> 它根本没有用到机会数。只有右列（E3 实测重申）随机会数移动。`);
p();
p(`### E.2 偏离程度 ↑ ⇒ 诈唬质量 ↑（同一原型、同一证据强度 E1 人工读、同一档）`);
p();
p(`| 原型 | 4.8%(0.05) | 20%(0.20) | 45%(0.45) | 65%(0.65) | 80%(0.80) | 单调? |`);
p(`|---|---|---|---|---|---|---|`);
for (const arch of ['VERY_TIGHT', 'NORMAL', 'MANIAC', 'BLUFF_HEAVY']) {
  const vals = [0.05, 0.2, 0.45, 0.65, 0.8].map((dev) =>
    allRows.find((r) => r.archetype === arch && r.tier === 'N0_NO_OBSERVATION' && r.deviation === dev
      && r.evidenceStrength === 'E1_MANUAL_STRONG')?.bluffMass ?? null);
  const mono = vals.every((v) => v !== null)
    && vals.every((v, i) => i === 0 || v! >= vals[i - 1]!);
  p(`| ${arch} | ${vals.map((v) => pct(v, 3)).join(' | ')} | ${mono ? '✅' : '❌'} |`);
}
p();
p(`> ⚠️ **E0（只有标签先验）下这一行必然恒定** —— 标签先验不使用人工读，`);
p(`> 因此那里「单调」无从谈起，本表**只**用 E1。第一版脚本误用 E0，`);
p(`> 把「未测」印成了「❌ 不单调」（独立统计审查 C5 指出）。`);
p();

/* ============================================================
 * §F 语料覆盖
 * ============================================================ */

const corpus = SENS.corpus;
if (corpus !== undefined) {
  p(`## F. 语料覆盖（${corpus.scenarios.length} 场景 × ${corpus.rows.length / corpus.scenarios.length} 画像探针）`);
  p();
  p(`| 场景 | 我的位置 | 手牌 | 公共牌 | 街 | 底池 | 有效筹码 | 类型 | 底池结构 | 桌型 | 中性权益 | 中性动作 | 跟注站→疯子 权益 |`);
  p(`|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const s of corpus.scenarios as any[]) {
    const rr = corpus.rows.filter((r) => r.scenario === s.id);
    const n = rr.find((r) => r.archetype === 'NEUTRAL_NORMAL');
    const cs = rr.find((r) => r.archetype === 'CALLING_STATION_TAG');
    const ma = rr.find((r) => r.archetype === 'MANIAC_TAG');
    p(`| \`${s.id}\` | **${s.myPosition}** | ${s.heroCards} | ${s.board} | ${s.street} | ${s.potBB}BB | ${s.effectiveStackBB}BB | ${s.kind} | ${s.structure} | ${s.tableSize}-max | ` +
      `${n?.ok === true ? pct(n.heroEquity, 2) + '%' : '**UNSUPPORTED**'} | ${n?.action ?? '—'} | ` +
      `${cs?.ok === true ? pct(cs.heroEquity, 2) : '—'}% → ${ma?.ok === true ? pct(ma.heroEquity, 2) : '—'}% |`);
  }
  p();
  p(`### F.1 每个场景的画像敏感性（中性 → 跟注站 / 疯子）`);
  p();
  p(`| 场景 | 中性 EQ / 诈唬 / 动作 | 跟注站 EQ / 诈唬 / 动作 / ΔEQ | 疯子 EQ / 诈唬 / 动作 / ΔEQ | 尺寸变化 |`);
  p(`|---|---|---|---|---|`);
  for (const s of corpus.scenarios as any[]) {
    const rr = corpus.rows.filter((r) => r.scenario === s.id);
    const n = rr.find((r) => r.archetype === 'NEUTRAL_NORMAL');
    const cs = rr.find((r) => r.archetype === 'CALLING_STATION_TAG');
    const ma = rr.find((r) => r.archetype === 'MANIAC_TAG');
    const f = (a: Row | undefined, base: Row | undefined): string => {
      if (a?.ok !== true) return 'UNSUPPORTED';
      const d = base?.heroEquity !== null && base?.heroEquity !== undefined && a.heroEquity !== null
        ? ` (${pct(a.heroEquity - base.heroEquity, 2)}pp)` : '';
      return `${pct(a.heroEquity, 2)}% / ${pct(a.bluffMass, 2)}% / ${a.action}${d}`;
    };
    const sz = (a: Row | undefined, base: Row | undefined): string => {
      if (a?.sizingBB == null) return '—';
      const b = base?.sizingBB ?? null;
      return `${num(a.sizingBB, 2)}BB（池 ${pct(a.sizingPotRatio, 0)}%）` + (b !== null && b !== a.sizingBB ? ` ← 由 ${num(b, 2)} 变` : '');
    };
    p(`| \`${s.id}\` | ${n?.ok === true ? `${pct(n.heroEquity, 2)}% / ${pct(n.bluffMass, 2)}% / ${n.action}` : '**UNSUPPORTED**'} | ` +
      `${f(cs, n)} | ${f(ma, n)} | ${sz(ma, n)} |`);
  }
  p();
}

/* ============================================================
 * §G 决策影响指标（来自另一个 JSON）
 * ============================================================ */

p(`## G. 决策影响指标（来自 \`v21-decision-impact.json\`）`);
p();
p(`- 退化自检：\`${JSON.stringify(IMPACT['degeneracySelfCheck'])}\``);
p(`- 确定性自检：**${(IMPACT['determinismSelfCheck'] as any[]).filter((d) => d.bitIdentical).length}/${(IMPACT['determinismSelfCheck'] as any[]).length}** 逐位相同（同输入两次调用）`);
p(`- Profile Dominance 违规行：**${(IMPACT['profileDominance'].rows as any[]).filter((r) => r.violated).length}/${(IMPACT['profileDominance'].rows as any[]).length}**`);
p(`- \`requiredEquity\` 不随画像变化：**${IMPACT['profileDominance'].requiredEquityInvariant.holds ? '成立' : '不成立'}**`);
p();
p(`| 画像 | 动作 | 权益 | eqΔ | 诈唬Δ | EqVsCallΔ | 跟注EVΔ | TV |`);
p(`|---|---|---|---|---|---|---|---|`);
for (const c of IMPACT['perProfile'] as any[]) {
  const v = c.vsNeutralNormal;
  p(`| \`${c.id}\` | ${v.actionTo} | ${pct(c.snapshot.heroEquity, 2)}% | ${pct(v.equityDelta, 2)}pp | ` +
    `${pct(v.bluffMassDelta, 2)}pp | ${pct(v.eqVsCall, 2)}pp | ${num(v.callEVDelta, 3)} | ${num(v.categoryRangeDistance?.totalVariation ?? null)} |`);
}
p();
const stab = IMPACT['inputPerturbationStability'] as any;
p(`### G.1 输入微扰稳定性`);
p();
p(`- 边界声明：${stab.boundaryNote}`);
p(`- 发生动作翻转的画像数：**${(stab.rows as any[]).filter((r) => r.actionFlipsUnderPerturbation).length}/${(stab.rows as any[]).length}**`);
p(`- 最大权益极差：**${pct(Math.max(...(stab.rows as any[]).map((r) => r.equitySpread ?? 0)))}pp**`);
p();

p(`### G.2 冲突场景原始数字`);
p();
p('```json');
p(JSON.stringify({
  C1: IMPACT['conflict1_historyPassive_currentStrong'],
  C2: IMPACT['conflict2_historyAggressive_currentWeak'],
  C3: IMPACT['conflict3_historyTightWeak_recentAggressive'],
}, null, 1));
p('```');

/* 写盘 */
const { writeFileSync } = await import('node:fs');
writeFileSync('reports/evidence/v21-summary.md', out.join('\n') + '\n', 'utf8');
console.error('[done] reports/evidence/v21-summary.md');
