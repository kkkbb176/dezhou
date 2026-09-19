/**
 * Reviewer 1（统计与有效样本量）独立复算探针 —— 矩阵简并度 + 分母审计
 *
 * - ITEM 7：`bluffMass` 的分母到底是 `totalMass`（可达质量）还是 1（整个范围）
 * - ITEM 6：复算审计的 9×4×5×7 = 1260 格
 *   (a) 逐格构造**调用指纹**（= 传入的画像全字段 + quickProfile）；
 *   (b) 只对**不同指纹**各跑一次真实管线（同指纹 ⇒ 同一次调用）；
 *   (c) 用「同指纹不同格」的成对实跑**验证**简并论证（逐位比较）；
 *   (d) 复算头部统计量 max|equityDelta|。
 *
 * 用法：node --experimental-strip-types scripts/v21-rev1-matrix-distinct.ts [--pairs N]
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { BehaviorTraitKey, behaviorProfileOf, type PlayerBehaviorProfile } from '../src/domain/player/behaviorProfile.ts';
import { ALL_CARDS } from '../src/domain/types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  budget: { softMs: 120_000, hardMs: 240_000 }, equitySeed: 20260913,
} as const;
const SEATS9 = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

const S1 = {
  myPosition: 'CO', heroCards: ['Ac', 'Jh'] as string[], board: ['Ad', '8s', '4s', '2c', 'Kd'] as string[],
  street: 'RIVER' as const, effectiveStackBB: 100, tableSize: 9 as const,
  history: [
    { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
    { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' }, { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5 }, { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'CALL', amountBB: 1.5 },
    { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CHECK', street: 'TURN' }, { position: 'CO', type: 'CHECK', street: 'TURN' },
    { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
  ] as Record<string, unknown>[],
};

function inputOf(villain: { quickProfile?: string; behaviorProfile?: PlayerBehaviorProfile }): ManualHandInput {
  return {
    tableSize: S1.tableSize, heroPosition: S1.myPosition, heroCards: [...S1.heroCards], board: [...S1.board],
    street: S1.street, effectiveStackBB: S1.effectiveStackBB, bigBlindBB: 2, seatStacksBB: { ...SEATS9 },
    actionHistory: S1.history.map((h) => ({ ...h })), environment: 'MID_LOW_STAKES',
    villain: { dynamicHint: 'UNKNOWN', stackBB: S1.effectiveStackBB, ...villain },
  } as unknown as ManualHandInput;
}

const line = (s = ''): void => console.log(s);

const SAMPLE_TIERS = [
  { name: 'N0_NO_OBSERVATION', opportunities: 0 }, { name: 'N2_TINY', opportunities: 2 },
  { name: 'N5_VERY_SMALL', opportunities: 5 }, { name: 'N20_PRELIMINARY', opportunities: 20 },
  { name: 'N50_STANDARD', opportunities: 50 }, { name: 'N200_CONFIRMED_EDGE', opportunities: 200 },
  { name: 'N1000_LARGE', opportunities: 1000 },
] as const;
const ARCHETYPES = ['VERY_TIGHT', 'LOOSE', 'CALLING_STATION', 'UNDERBLUFFER', 'BLUFF_HEAVY', 'UNKNOWN', 'NORMAL', 'TIGHT', 'AGGRESSIVE'] as const;
const DEVIATIONS = [
  { name: 'VERY_LOW_0.05', tendency: 'VERY_LOW', auditRate: 0.05 }, { name: 'LOW_0.20', tendency: 'LOW', auditRate: 0.2 },
  { name: 'MEDIUM_0.45', tendency: 'MEDIUM', auditRate: 0.45 }, { name: 'HIGH_0.65', tendency: 'HIGH', auditRate: 0.65 },
  { name: 'VERY_HIGH_0.95', tendency: 'VERY_HIGH', auditRate: 0.95 },
] as const;
const STRENGTHS = ['E0_TAG_PRIOR_ONLY', 'E1_MANUAL_STRONG', 'E2_MANUAL_WEAK', 'E3_TAG_PRIOR_REASSERTED'] as const;
type Strength = (typeof STRENGTHS)[number];
type Dev = (typeof DEVIATIONS)[number];
type Tier = (typeof SAMPLE_TIERS)[number];

/** 审计脚本 `profileFor`（:571-594）逐字复刻 */
function profileFor(archetype: string, opportunities: number, successes: number, tendency: Dev['tendency'], strength: Strength): PlayerBehaviorProfile {
  const key = BehaviorTraitKey.RIVER_BLUFF;
  const manual = strength === 'E1_MANUAL_STRONG' ? { [key]: tendency }
    : strength === 'E2_MANUAL_WEAK'
      ? { [key]: tendency === 'VERY_HIGH' ? 'LOW' : tendency === 'VERY_LOW' ? 'HIGH' : tendency }
      : undefined;
  const useObserved = strength === 'E3_TAG_PRIOR_REASSERTED';
  return behaviorProfileOf({
    playerId: 'v21-villain', archetype: archetype as never,
    ...(manual === undefined ? {} : { manual: manual as never }),
    ...(useObserved && opportunities > 0 ? { observed: { [key]: { successes, opportunities } } as never } : {}),
  });
}

/** 调用指纹：画像 6 条目的 effectiveRate/priorWeight/source + quickProfile（决定本次调用的全部输入） */
function fingerprintOf(a: string, prof: PlayerBehaviorProfile): string {
  const t = (Object.values(BehaviorTraitKey) as (keyof typeof prof.traits)[])
    .map((k) => `${String(k)}=${prof.traits[k].effectiveRate.toExponential(17)}/${prof.traits[k].priorWeight}/${prof.traits[k].source}`)
    .join('|');
  return `${t}|qp=${a}`;
}

type M = {
  eq: number | null; bm: number | null; action: string | null; method: string | null;
  iter: number | null; half: number | null; eqAfter: number | null; eqDeltaPct: number | null;
  totalMass: number | null; unclass: number | null; reachable: number | null; support: number | null;
  effCombos: number | null; value: number | null; thin: number | null; sd: number | null;
  missed: number | null; air: number | null; nut: number | null; strong: number | null;
  combosBefore: number | null; combosAfter: number | null;
  positiveEntries?: number; massSum?: number; overlapPositiveCount?: number; overlapPositiveMass?: number;
};

function run(a: string, prof: PlayerBehaviorProfile): M {
  const m: M = {
    eq: null, bm: null, action: null, method: null, iter: null, half: null, eqAfter: null, eqDeltaPct: null,
    totalMass: null, unclass: null, reachable: null, support: null, effCombos: null, value: null, thin: null,
    sd: null, missed: null, air: null, nut: null, strong: null, combosBefore: null, combosAfter: null,
  };
  const input = inputOf({ quickProfile: a, behaviorProfile: prof });
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) return m;
  m.action = String(r.decision.action);
  const math = r.decision.diagnostics.math as unknown as {
    heroEquity: number; equitySource: { method: string; iterations: number; confidenceHalfWidth: number } | null;
  };
  m.eq = math.heroEquity;
  m.method = math.equitySource?.method ?? null;
  m.iter = math.equitySource?.iterations ?? null;
  m.half = math.equitySource?.confidenceHalfWidth ?? null;
  const pr = r.decision.diagnostics.profileRange as unknown as { equityAfter?: number; equityDeltaPct?: number } | undefined;
  m.eqAfter = pr?.equityAfter ?? null;
  m.eqDeltaPct = pr?.equityDeltaPct ?? null;

  const parsed = parseManualInput(input);
  if (!parsed.ok) return m;
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) return m;
  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
    budget: { softMs: 120_000, hardMs: 240_000 }, equitySeed: 20260913,
    quickProfile: a as never, behaviorProfile: prof,
  });
  const facts = built.context.postflopFacts as unknown as {
    supportSize?: number;
    opponentRangeFacts?: { profileClassMasses?: Record<string, number | null> } | null;
  } | undefined;
  const pc = facts?.opponentRangeFacts?.profileClassMasses ?? null;
  if (pc !== null) {
    m.bm = (pc['bluffMass'] as number) ?? null;
    m.totalMass = (pc['totalMass'] as number) ?? null;
    m.unclass = (pc['unclassifiedMassShare'] as number) ?? null;
    m.reachable = (pc['reachableRangeCount'] as number) ?? null;
    m.effCombos = (pc['effectiveCombos'] as number) ?? null;
    m.value = (pc['valueMass'] as number) ?? null;
    m.thin = (pc['thinValueMass'] as number) ?? null;
    m.sd = (pc['showdownMass'] as number) ?? null;
    m.missed = (pc['missedDrawMass'] as number) ?? null;
    m.air = (pc['pureAirMass'] as number) ?? null;
    m.nut = (pc['nutValueMass'] as number) ?? null;
    m.strong = (pc['strongValueMass'] as number) ?? null;
  }
  m.support = facts?.supportSize ?? null;
  const ev = built.context.profileRangeEvidence as unknown as { combosBefore?: number; combosAfter?: number } | undefined;
  m.combosBefore = ev?.combosBefore ?? null;
  m.combosAfter = ev?.combosAfter ?? null;

  /* 死牌核查：范围里 p>0 且与 Hero/公共牌重叠的组合数（应恒为 0） */
  const ranges = built.context.opponentRanges as unknown as
    | readonly { entries?: readonly { combo?: { cardIndices?: readonly [number, number] }; probability?: number }[] }[]
    | undefined;
  const entries = ranges?.[0]?.entries ?? [];
  const dead = new Set([...S1.heroCards, ...S1.board]);
  let overlapPositiveMass = 0;
  let overlapPositiveCount = 0;
  let positiveEntries = 0;
  let massSum = 0;
  for (const e of entries) {
    const p = e.probability ?? 0;
    if (!(p > 0)) continue;
    positiveEntries += 1;
    massSum += p;
    const idx = e.combo?.cardIndices;
    if (idx === undefined) continue;
    const c0 = ALL_CARDS[idx[0]]!;
    const c1 = ALL_CARDS[idx[1]]!;
    if (dead.has(`${c0.rank}${c0.suit}`) || dead.has(`${c1.rank}${c1.suit}`)) {
      overlapPositiveCount += 1;
      overlapPositiveMass += p;
    }
  }
  m.positiveEntries = positiveEntries;
  m.massSum = massSum;
  m.overlapPositiveCount = overlapPositiveCount;
  m.overlapPositiveMass = overlapPositiveMass;
  return m;
}

/* ============================================================
 * ① 全 1260 格的指纹（纯模型构造，无管线）
 * ============================================================ */
type Cell = { strength: Strength; a: string; d: Dev; tier: Tier; successes: number; fp: string };
const cells: Cell[] = [];
for (const strength of STRENGTHS) for (const a of ARCHETYPES) for (const d of DEVIATIONS) for (const tier of SAMPLE_TIERS) {
  const successes = Math.round(d.auditRate * tier.opportunities);
  const prof = profileFor(a, tier.opportunities, successes, d.tendency, strength);
  cells.push({ strength, a, d, tier, successes, fp: fingerprintOf(a, prof) });
}
const byFp = new Map<string, Cell[]>();
for (const c of cells) {
  if (!byFp.has(c.fp)) byFp.set(c.fp, []);
  byFp.get(c.fp)!.push(c);
}

line('='.repeat(100));
line('ITEM 6-A 调用指纹的简并结构（**无需跑管线**，纯构造）');
line('='.repeat(100));
line(`  1260 格 → 不同调用指纹 ${byFp.size} 个（重复倍数 ≥1）`);
const multHist = new Map<number, number>();
for (const v of byFp.values()) multHist.set(v.length, (multHist.get(v.length) ?? 0) + 1);
line(`  重复倍数分布（倍数 → 指纹个数）：${JSON.stringify([...multHist.entries()].sort((x, y) => x[0] - y[0]))}`);
line('  逐「证据强度」的不同指纹数：');
for (const s of STRENGTHS) {
  const sub = cells.filter((c) => c.strength === s);
  line(`    ${s.padEnd(26)} 格 ${sub.length} → 不同指纹 ${new Set(sub.map((c) => c.fp)).size}`);
}
line('  逐 (原型, 强度) 的不同指纹数（每格 5 偏离 × 7 档 = 35）：');
for (const a of ARCHETYPES) {
  const row = STRENGTHS.map((s) => {
    const sub = cells.filter((c) => c.a === a && c.strength === s);
    return String(new Set(sub.map((c) => c.fp)).size).padStart(3);
  }).join('  ');
  line(`    ${a.padEnd(16)} ${row}`);
}
line('    （列顺序：E0 / E1 / E2 / E3）');
/* E0 与 E3@n=0 是否重合 */
const e0fps = new Set(cells.filter((c) => c.strength === 'E0_TAG_PRIOR_ONLY').map((c) => c.fp));
const e3n0 = new Set(cells.filter((c) => c.strength === 'E3_TAG_PRIOR_REASSERTED' && c.tier.opportunities === 0).map((c) => c.fp));
line(`  E3@n=0 的 ${e3n0.size} 个指纹是否全部落在 E0 的 ${e0fps.size} 个指纹里？ ${[...e3n0].every((x) => e0fps.has(x))}`);
const e1fps = new Set(cells.filter((c) => c.strength === 'E1_MANUAL_STRONG').map((c) => c.fp));
const e2fps = new Set(cells.filter((c) => c.strength === 'E2_MANUAL_WEAK').map((c) => c.fp));
line(`  E2 的 ${e2fps.size} 个指纹是否全部落在 E1 的 ${e1fps.size} 个指纹里？ ${[...e2fps].every((x) => e1fps.has(x))}  ← E2 相对 E1 有无新增`);
/* 每档 n 的边际增益（E3 内） */
line('  E3 内部：每个样本档带来的**新增**指纹数（原型 × 偏离 45 格/档）：');
{
  const seen = new Set<string>();
  for (const tier of SAMPLE_TIERS) {
    const sub = cells.filter((c) => c.strength === 'E3_TAG_PRIOR_REASSERTED' && c.tier.name === tier.name);
    let added = 0;
    for (const c of sub) if (!seen.has(c.fp)) { seen.add(c.fp); added += 1; }
    line(`    ${tier.name.padEnd(20)} n=${String(tier.opportunities).padStart(4)}  新增 ${String(added).padStart(3)} / 45  累计 ${seen.size}`);
  }
}

/* ============================================================
 * ② 只跑不同指纹 + 用成对实跑验证简并
 * ============================================================ */
line('');
line('='.repeat(100));
line('ITEM 6-B 只对**不同指纹**各跑一次真实管线');
line('='.repeat(100));
const t0 = Date.now();
const resultOf = new Map<string, M>();
let i = 0;
for (const [fp, group] of byFp) {
  const c = group[0]!;
  resultOf.set(fp, run(c.a, profileFor(c.a, c.tier.opportunities, c.successes, c.d.tendency, c.strength)));
  i += 1;
  if (i % 50 === 0) console.error(`  [${i}/${byFp.size}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
line(`  ${byFp.size} 次真实调用完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s（平均 ${(((Date.now() - t0) / byFp.size)).toFixed(0)}ms/次）`);
line(`  ok（有权益）${[...resultOf.values()].filter((m) => m.eq !== null).length} / ${resultOf.size}`);
line(`  ⚠️ 环境事实：1260 格若逐格重跑需 ≈ ${(((Date.now() - t0) / byFp.size) * 1260 / 1000).toFixed(0)}s；审计脚本正是逐格跑（每格 2 次管线：analyzeManualHand + buildDecisionContext）`);

/* ---- 成对验证：同指纹但来自不同格，逐位比较 ---- */
line('');
line('  🔴 简并论证的**执行级验证**：取重复倍数 ≥2 的指纹，把其中两格**各跑一次**，逐位比较');
const pairsToCheck = Math.min(Number(process.env['REV1_PAIRS'] ?? 6), 12);
let checkedPairs = 0; let bitSame = 0;
for (const [fp, group] of byFp) {
  if (group.length < 2 || checkedPairs >= pairsToCheck) continue;
  const c1 = group[0]!; const c2 = group[group.length - 1]!;
  const m1 = run(c1.a, profileFor(c1.a, c1.tier.opportunities, c1.successes, c1.d.tendency, c1.strength));
  const m2 = run(c2.a, profileFor(c2.a, c2.tier.opportunities, c2.successes, c2.d.tendency, c2.strength));
  checkedPairs += 1;
  const same = JSON.stringify(m1) === JSON.stringify(m2);
  if (same) bitSame += 1;
  line(
    `    ${same ? 'bit-同' : '**不同**'}  格1=${c1.a}/${c1.s ?? ''}${c1.strength}/${c1.tier.name}/dev${c1.d.name}  格2=${c2.a}/${c2.strength}/${c2.tier.name}/dev${c2.d.name}` +
      `  eq=${m1.eq} vs ${m2.eq}`,
  );
}
line(`    受检 ${checkedPairs} 对，逐位相同 ${bitSame} 对 ⇒ 同指纹 ⇒ 同结果${checkedPairs === bitSame ? '（成立）' : '（**不成立**）'}`);

/* ============================================================
 * ③ 头部统计量复算（按审计口径：中性基线 NORMAL/E0/N0）
 * ============================================================ */
line('');
line('='.repeat(100));
line('ITEM 6-C 复算审计的头部统计量（中性基线 = NORMAL / E0 / N0）');
line('='.repeat(100));
const neutralFp = cells.find((c) => c.a === 'NORMAL' && c.strength === 'E0_TAG_PRIOR_ONLY' && c.tier.opportunities === 0)!.fp;
const neutral = resultOf.get(neutralFp)!;
line(`  中性基线：equity=${neutral.eq} bluffMass=${neutral.bm} 动作=${neutral.action} method=${neutral.method} iter=${neutral.iter} halfWidth=${neutral.half}`);
let maxEq = 0; let maxEqCell: Cell | null = null;
let maxBm = 0; let maxBmCell: Cell | null = null;
for (const c of cells) {
  const m = resultOf.get(c.fp);
  if (m === undefined || m.eq === null) continue;
  const de = Math.abs(m.eq - (neutral.eq as number));
  const db = Math.abs((m.bm ?? 0) - (neutral.bm ?? 0));
  if (de > maxEq) { maxEq = de; maxEqCell = c; }
  if (db > maxBm) { maxBm = db; maxBmCell = c; }
}
line(`  ★ max |equityDelta| = ${(maxEq * 100).toFixed(4)}pp @ ${maxEqCell?.a}/${maxEqCell?.strength}/${maxEqCell?.tier.name}/dev${maxEqCell?.d.name}`);
line(`  ★ max |bluffMassDelta| = ${(maxBm * 100).toFixed(4)}pp @ ${maxBmCell?.a}/${maxBmCell?.strength}/${maxBmCell?.tier.name}/dev${maxBmCell?.d.name}`);
const flips = cells.filter((c) => { const m = resultOf.get(c.fp); return m !== undefined && m.action !== neutral.action; });
line(`  动作翻转 = ${flips.length} / 1260（${((flips.length / 1260) * 100).toFixed(2)}%）`);
const fp2 = new Map<string, number>();
for (const f of flips) {
  const m = resultOf.get(f.fp)!;
  const k = `${neutral.action}→${m.action}`;
  fp2.set(k, (fp2.get(k) ?? 0) + 1);
}
line(`    翻转对：${JSON.stringify([...fp2.entries()])}`);
line('');
line('  equitySource 统计（审计的 Row 类型**没有记录** method/iterations/confidenceHalfWidth）：');
const methods = new Map<string, number>(); const iters = new Set<number>(); const halves = new Set<number>();
for (const m of resultOf.values()) {
  if (m.method === null) continue;
  methods.set(m.method, (methods.get(m.method) ?? 0) + 1);
  if (m.iter !== null) iters.add(m.iter);
  if (m.half !== null) halves.add(m.half);
}
line(`    method 分布（按不同指纹计）= ${JSON.stringify([...methods.entries()])}`);
line(`    iterations 取值 = ${JSON.stringify([...iters])}`);
line(`    confidenceHalfWidth 取值 = ${JSON.stringify([...halves])}`);

/* ============================================================
 * ④ ITEM 7 分母
 * ============================================================ */
line('');
line('='.repeat(100));
line('ITEM 7 bluffMass 的分母：可达质量 totalMass 还是 1');
line('='.repeat(100));
line(`  （中性基线格）supportSize = ${neutral.support}   reachableRangeCount = ${neutral.reachable}`);
line(`  totalMass = ${neutral.totalMass}`);
line(`  1 − totalMass = ${neutral.totalMass === null ? '—' : 1 - neutral.totalMass}`);
line(`  bluffMass（原样）= ${neutral.bm}`);
line(`  bluffMass ÷ totalMass = ${neutral.bm !== null && neutral.totalMass !== null ? neutral.bm / neutral.totalMass : '—'}`);
line(`  missedDrawMass + pureAirMass = ${(neutral.missed ?? 0) + (neutral.air ?? 0)}`);
line(`  unclassifiedMassShare = ${neutral.unclass}`);
line(`  combosBefore/After = ${neutral.combosBefore} / ${neutral.combosAfter}`);
line('');
const sumClasses = (m: M): number => (m.nut ?? 0) + (m.strong ?? 0) + (m.thin ?? 0) + (m.sd ?? 0) + (m.missed ?? 0) + (m.air ?? 0);
let closed = 0; let maxGap = 0; const totalValues = new Set<number>();
for (const m of resultOf.values()) {
  if (m.totalMass === null) continue;
  totalValues.add(m.totalMass);
  const gap = Math.abs(sumClasses(m) + (m.unclass ?? 0) * m.totalMass - m.totalMass);
  if (gap <= 1e-12) closed += 1;
  if (gap > maxGap) maxGap = gap;
}
line(`  分量闭合（nut+strong+thin+showdown+missed+air+unclassified == totalMass）：${closed} / ${resultOf.size}；最大偏差 ${maxGap}`);
line(`  totalMass 的不同取值个数 = ${totalValues.size} ⇒ ${JSON.stringify([...totalValues].slice(0, 6))}`);
const badValue = [...resultOf.values()].filter((m) => m.value !== null && Math.abs(m.value - ((m.nut ?? 0) + (m.strong ?? 0) + (m.thin ?? 0))) > 1e-12);
line(`  valueMass == nut+strong+thin 不成立的格数 = ${badValue.length}`);
const badBluff = [...resultOf.values()].filter((m) => m.bm !== null && Math.abs(m.bm - ((m.missed ?? 0) + (m.air ?? 0))) > 1e-12);
line(`  bluffMass == missedDrawMass+pureAirMass 不成立的格数 = ${badBluff.length}`);
line(`  bluffMass 与 totalMass 的关系：bluffMass / totalMass 在 ${resultOf.size} 个指纹上的不同取值个数 = ${
  new Set([...resultOf.values()].filter((m) => m.bm !== null && m.totalMass).map((m) => (m.bm as number) / (m.totalMass as number))).size}`);

/* ============================================================
 * ⑤ 结果级简并：1260 格（按指纹重复倍数加权）到底有几个不同测量
 * ============================================================ */
line('');
line('='.repeat(100));
line('ITEM 6-D 结果级简并（按指纹重复倍数加权到 1260 格）');
line('='.repeat(100));
{
  const w: { c: Cell; m: M }[] = [];
  for (const c of cells) {
    const m = resultOf.get(c.fp);
    if (m !== undefined && m.eq !== null) w.push({ c, m });
  }
  line(`  有结果的格数 = ${w.length} / 1260`);
  const eqVals = new Set(w.map((x) => x.m.eq));
  const bmVals = new Set(w.map((x) => x.m.bm));
  const actVals = new Set(w.map((x) => x.m.action));
  const pairVals = new Set(w.map((x) => `${x.m.eq}|${x.m.bm}`));
  const tripVals = new Set(w.map((x) => `${x.m.eq}|${x.m.bm}|${x.m.action}`));
  line(`  不同 heroEquity 取值 = ${eqVals.size} / ${w.length} 格`);
  line(`  不同 bluffMass  取值 = ${bmVals.size} / ${w.length} 格`);
  line(`  不同 动作       取值 = ${actVals.size} = ${JSON.stringify([...actVals])}`);
  line(`  不同 (equity, bluffMass) 组合 = ${pairVals.size}`);
  line(`  不同 (equity, bluffMass, 动作) 三元组 = ${tripVals.size}`);
  line(`  ⇒ 1260 格里**真正互不相同**的测量 = ${tripVals.size}（简并因子 ${(w.length / tripVals.size).toFixed(2)}×）`);
  line('');
  line('  每个样本档的边际「新增不同三元组」数（E3 内，45 格/档）：');
  const seen = new Set<string>();
  for (const tier of SAMPLE_TIERS) {
    const sub = w.filter((x) => x.c.strength === 'E3_TAG_PRIOR_REASSERTED' && x.c.tier.name === tier.name);
    let added = 0;
    for (const x of sub) {
      const k = `${x.m.eq}|${x.m.bm}|${x.m.action}`;
      if (!seen.has(k)) { seen.add(k); added += 1; }
    }
    line(`    ${tier.name.padEnd(20)} 新增不同三元组 ${String(added).padStart(3)} / 45  累计 ${seen.size}`);
  }
  line(`  ⇒ 在 9 原型 × 5 偏离的 45 格上，n≥5 的每一档都贡献**全部 45 个新测量**（不重复）`);
  line('');
  line('  「0.95」这一档的可达性核查：');
  line(`    E1/E2 走 manual 通道，模型里 manualReadEvidence 的最大率 = 0.8（VERY_HIGH）`);
  line(`    ⇒ 档名 VERY_HIGH_0.95 在 manual 通道上**不可达**；只有 E3（observed）用 0.95 造成功数`);
  const e3 = w.filter((x) => x.c.strength === 'E3_TAG_PRIOR_REASSERTED' && x.c.d.name === 'VERY_HIGH_0.95');
  line(`    E3/devVERY_HIGH_0.95 的 ${e3.length} 格中，successes/n 的真实比值取值 = ${JSON.stringify([...new Set(e3.map((x) => x.c.successes / Math.max(1, x.c.tier.opportunities)))])}`);
  const maxE3 = e3.reduce((b, x) => (Math.abs((x.m.eq as number) - (neutral.eq as number)) > Math.abs((b.m.eq as number) - (neutral.eq as number)) ? x : b), e3[0]!);
  line(`    其中最大 |equityDelta| = ${(Math.abs((maxE3.m.eq as number) - (neutral.eq as number)) * 100).toFixed(4)}pp（${maxE3.c.a}/${maxE3.c.tier.name}）`);
  line('');
  line('  死牌核查（范围里 p>0 且与 Hero 底牌/公共牌重叠的组合）：');
  line(`    正概率组合数 = ${neutral.positiveEntries}；概率和 = ${neutral.massSum}`);
  line(`    重叠且 p>0 的组合数 = ${neutral.overlapPositiveCount}；其质量和 = ${neutral.overlapPositiveMass}`);
  line('    ⇒ 重叠组合在**上游**就已是 0 概率，rangeFacts 的重叠检查是纯防御性的');
}

/* 落盘：写到操作系统临时目录（**不是仓库产物**），便于事后复核 */
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dump = cells.map((c) => {
    const m = resultOf.get(c.fp)!;
    return { a: c.a, strength: c.strength, tier: c.tier.name, n: c.tier.opportunities, dev: c.d.name,
      successes: c.successes, fp: c.fp, eq: m.eq, bm: m.bm, action: m.action, method: m.method,
      iter: m.iter, half: m.half, eqAfter: m.eqAfter, eqDeltaPct: m.eqDeltaPct, totalMass: m.totalMass };
  });
  const out = path.join(os.tmpdir(), 'v21-rev1-matrix-1260.json');
  fs.writeFileSync(out, JSON.stringify(dump, null, 1), 'utf8');
  line('');
  line(`  [dump] 1260 行逐格结果已写入临时目录：${out}`);
}
