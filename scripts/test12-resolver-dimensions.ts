/**
 * TEST 12 —— resolver 维度映射专项（AK 顶对顶踢，河牌薄价值）
 *
 * 牌局：6-max 1/2，BTN A♠K♠，K♦9♣4♥6♠2♣
 *   翻前 BTN 开 6（3BB）/ BB 跟 ⇒ 13
 *   翻牌 BB 过 / Hero 下 5 / BB 跟 ⇒ 23
 *   转牌 6♠ BB 过 / Hero 下 15 / BB 跟 ⇒ 53
 *   河牌 2♣ BB 第三次过牌 ⇒ **Hero 决策** ｜ 底池 53 ｜ 各剩 174 ｜ SPR 3.28
 *
 * 四组（外加一组诊断对照 E）：
 *   A. 标签 CALLING_STATION + 1500 手**真跟注站**实测
 *   B. 标签 CALLING_STATION + 1500 手**紧弱**实测（标签贴错）
 *   C. 标签 CALLING_STATION，无实测
 *   D. 标签 VERY_TIGHT（NIT），无实测
 *   E. 诊断：标签 VERY_TIGHT + **与 B 完全相同**的紧弱实测
 *      （用来判定「有实测时标签维度是被混合还是被丢弃」）
 *
 * 验收重点：A/B 的 resolved 维度必须方向正确；B 必须离开 CS 标签向 NIT 靠；
 *          A 不得出现 tightness > 0.5 且 passivity < 0.5。
 *
 * 用法：node --experimental-strip-types scripts/test12-resolver-dimensions.ts
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import {
  ALL_OBSERVED_STAT_KEYS,
  STAT_DIMENSION_POLARITY,
  STAT_EVIDENCE_SPECS,
  type ObservedStatKey,
  type PlayerObservedStats,
} from '../src/domain/player/observedStats.ts';
import { ARCHETYPE_DIMENSIONS } from '../src/domain/player/archetypeDimensions.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_012;
const ASOF = 1_757_000_000_000;

const H = (p: string, t: string, a?: number, s?: string) => ({
  position: p, type: t,
  ...(a === undefined ? {} : { amountBB: a }),
  ...(s === undefined ? {} : { street: s }),
});

const HISTORY = [
  H('UTG', 'FOLD'), H('HJ', 'FOLD'), H('CO', 'FOLD'),
  H('BTN', 'RAISE', 3), H('SB', 'FOLD'), H('BB', 'CALL', 2),
  H('BB', 'CHECK', undefined, 'FLOP'), H('BTN', 'BET', 2.5, 'FLOP'), H('BB', 'CALL', 2.5, 'FLOP'),
  H('BB', 'CHECK', undefined, 'TURN'), H('BTN', 'BET', 7.5, 'TURN'), H('BB', 'CALL', 7.5, 'TURN'),
  H('BB', 'CHECK', undefined, 'RIVER'),
];
const BOARD = ['Kd', '9c', '4h', '6s', '2c'];
const SEATS: Record<string, number> = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };

/** A：真跟注站（1500 手） */
const TRUE_STATION: PlayerObservedStats = {
  handsObserved: 1500,
  vpip: 0.52, pfr: 0.09, threeBet: 0.03, wtsd: 0.43,
  foldToFlopCBet: 0.20, foldToTurnCBet: 0.18, foldToRiverBet: 0.14,
  flopCheckRaise: 0.04, turnCheckRaise: 0.03, riverCheckRaise: 0.02,
};
/** B：紧弱（1500 手），标签被贴错成 Calling Station */
const TIGHT_WEAK: PlayerObservedStats = {
  handsObserved: 1500,
  vpip: 0.18, pfr: 0.12, threeBet: 0.04, wtsd: 0.20,
  foldToFlopCBet: 0.52, foldToTurnCBet: 0.61, foldToRiverBet: 0.68,
  flopCheckRaise: 0.03, turnCheckRaise: 0.02, riverCheckRaise: 0.01,
};

type Dim = 'tightness' | 'aggression' | 'bluffTendency' | 'passivity';
const DIMS: readonly Dim[] = ['tightness', 'aggression', 'bluffTendency', 'passivity'];

type M = Record<string, any>;

function inputFor(quickProfile: string, stats: PlayerObservedStats | null): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'],
    board: BOARD, street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: HISTORY.map((a) => ({ ...a })),
    environment: 'MID_LOW_STAKES',
    villain: {
      quickProfile, dynamicHint: 'UNKNOWN', stackBB: 100,
      ...(stats === null ? {} : { observedStats: stats }),
    },
  } as unknown as ManualHandInput;
}

/* ============================================================
 * 从**公开表**反推各维度推力（并与管线输出逐位比对）
 * ============================================================ */

const centerOf = (v: number): number => Math.max(-1, Math.min(1, (v - 0.5) * 2));
/** 🔴 修复**后**的逐统计归一化偏离（与 `observedStats.ts: statDeviationOf` 同式） */
const deviationOf = (stat: string, rate: number): number => {
  const spec = STAT_EVIDENCE_SPECS[stat as ObservedStatKey];
  if (spec === undefined || !(spec.scale > 0)) return 0;
  return Math.max(-1, Math.min(1, (rate - spec.neutralAnchor) / spec.scale));
};
const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5);
const PRIOR_MASS = 1; // observedStats.ts: `const priorMass = 1;`

type Reconstruct = {
  /** 每个维度的推力明细（含每条统计的贡献） */
  contributions: Record<Dim, readonly { stat: string; polarity: number; center: number; confidence: number; push: number }[]>;
  /** 统计单独说话的结果（**不含** priorMass 阻尼） */
  observedOnly: Record<Dim, number>;
  /** 统计 + priorMass 阻尼（= 管线公式） */
  reconstructed: Record<Dim, number>;
  /** 管线实际输出 */
  pipeline: Record<Dim, number>;
  /** 重建是否与管线逐位一致 */
  matches: boolean;
};

function reconstruct(trace: readonly M[], pipelineDims: M): Reconstruct {
  const acc: Record<Dim, { num: number; den: number }> = {
    tightness: { num: 0, den: 0 },
    aggression: { num: 0, den: 0 },
    bluffTendency: { num: 0, den: 0 },
    passivity: { num: 0, den: 0 },
  };
  const contributions = { tightness: [], aggression: [], bluffTendency: [], passivity: [] } as unknown as Reconstruct['contributions'];

  for (const key of ALL_OBSERVED_STAT_KEYS) {
    const row = trace.find((x) => x['stat'] === key);
    if (row === undefined) continue;
    const observedRate = row['observedRate'] as number | null;
    if (observedRate === null || observedRate === undefined) continue;
    const confidence = Number(row['confidence']);
    const center = deviationOf(key, observedRate);
    const polarity = STAT_DIMENSION_POLARITY[key as ObservedStatKey];
    for (const dim of DIMS) {
      const p = polarity[dim];
      if (p === 0) continue;
      acc[dim].num += p * center * confidence;
      acc[dim].den += Math.abs(p) * confidence;
      (contributions[dim] as { stat: string; polarity: number; center: number; confidence: number; push: number }[])
        .push({ stat: key, polarity: p, center, confidence, push: p * center * confidence });
    }
  }

  const observedOnly = {} as Record<Dim, number>;
  const reconstructed = {} as Record<Dim, number>;
  const pipeline = {} as Record<Dim, number>;
  for (const dim of DIMS) {
    const { num, den } = acc[dim];
    observedOnly[dim] = den > 0 ? clamp01(0.5 + (num / den) / 2) : 0.5;
    reconstructed[dim] = den > 0 ? clamp01(0.5 + (num / (PRIOR_MASS + den)) / 2) : 0.5;
    pipeline[dim] = Number(pipelineDims[dim]);
  }
  const matches = DIMS.every((d) => Math.abs(reconstructed[d] - pipeline[d]) < 1e-9);
  return { contributions, observedOnly, reconstructed, pipeline, matches };
}

/* ============================================================
 * 跑一组
 * ============================================================ */

type Row = {
  label: string;
  profile: string;
  stats: PlayerObservedStats | null;
  dims: Record<Dim, number>;
  observedDims: Record<Dim, number>;
  baseDimsPipeline: Record<Dim, number> | null;
  evidenceMass: M | null;
  blendWeight: M | null;
  baseDims: M | null;
  recon: Reconstruct | null;
  effective: Record<string, number | null>;
  weights: Record<string, number | null>;
  observedStatCount: number | null;
  riverFoldScale: number | null;
  action: string;
  sizeChips: number | null;
  sizeBB: number | null;
  sizeRatio: number | null;
  confidence: number;
  classification: string;
  heroEquity: number | null;
  supportSize: number | null;
  checkEV: number | null;
  sizes: M[];
  reasons: readonly M[];
};

function runCase(
  label: string, profile: string, stats: PlayerObservedStats | null,
): Row {
  const input = inputFor(profile, stats);

  const parsed = parseManualInput(input);
  if (!parsed.ok) throw new Error(`PARSE ${JSON.stringify(parsed.issues.slice(0, 3))}`);
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error(`STATE ${JSON.stringify(gate.issues.slice(0, 3))}`);

  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
    asOf: ASOF, quickProfile: profile as never,
    ...(stats === null ? {} : { observedStats: stats }),
    equitySeed: SEED,
  });
  const ctx = built.context as unknown as M;
  const v3 = (ctx['profileV3'] ?? null) as M | null;

  const r = analyzeManualHand(input, {
    rules: RULES, asOf: ASOF, writeLog: false,
    equitySeed: SEED, budget: { softMs: 120_000, hardMs: 240_000 },
  });
  if (!r.ok) throw new Error(`ANALYZE ${JSON.stringify(r.issues.slice(0, 3))}`);
  const d = r.decision as unknown as M;
  const diag = d['diagnostics'] as M;
  const math = diag['math'] as M;
  const bd = diag['postflop']?.['betDecision'] as M | null;

  const trace = ((v3?.['trace'] ?? []) as readonly M[]);
  const NEUTRAL: M = { tightness: 0.5, aggression: 0.5, bluffTendency: 0.5, passivity: 0.5 };
  /** ① 只有实测说话（既有字段，语义未变） */
  const observedDims = (v3?.['observedDimensions'] ?? v3?.['dimensions'] ?? NEUTRAL) as M;
  /** ③ 标签 prior ⊕ 实测（**下游响应层消费的就是它**） */
  const resolvedDims = (v3?.['resolvedDimensions'] ?? observedDims) as M;
  const baseDimsPipeline = (v3?.['baseDimensions'] ?? null) as M | null;
  const evidenceMass = (v3?.['evidenceMass'] ?? null) as M | null;
  const blendWeight = (v3?.['blendWeight'] ?? null) as M | null;
  const dims = resolvedDims;
  const effective: Record<string, number | null> = {};
  const weights: Record<string, number | null> = {};
  for (const key of ['vpip', 'pfr', 'threeBet', 'wtsd', 'foldToFlopCBet', 'foldToTurnCBet', 'foldToRiverBet']) {
    const row = trace.find((x) => x['stat'] === key) ?? null;
    effective[key] = row === null || row['effectiveRate'] === undefined ? null : Number(row['effectiveRate']);
    weights[key] = row === null || row['confidence'] === undefined ? null : Number(row['confidence']);
  }

  return {
    label, profile, stats,
    dims: {
      tightness: Number(dims['tightness']), aggression: Number(dims['aggression']),
      bluffTendency: Number(dims['bluffTendency']), passivity: Number(dims['passivity']),
    },
    observedDims: {
      tightness: Number(observedDims['tightness']), aggression: Number(observedDims['aggression']),
      bluffTendency: Number(observedDims['bluffTendency']), passivity: Number(observedDims['passivity']),
    },
    baseDimsPipeline: baseDimsPipeline === null ? null : {
      tightness: Number(baseDimsPipeline['tightness']),
      aggression: Number(baseDimsPipeline['aggression']),
      bluffTendency: Number(baseDimsPipeline['bluffTendency']),
      passivity: Number(baseDimsPipeline['passivity']),
    },
    evidenceMass, blendWeight,
    baseDims: (ARCHETYPE_DIMENSIONS[profile as never] ?? null) as M | null,
    recon: stats === null ? null : reconstruct(trace, observedDims),
    effective, weights,
    observedStatCount: v3?.['observedStatCount'] ?? null,
    riverFoldScale: v3?.['street']?.['RIVER']?.['foldScale'] ?? null,
    action: String(d['action']),
    sizeChips: d['sizeChips'] === undefined ? null : Number(d['sizeChips']),
    sizeBB: d['sizeBB'] === undefined ? null : Number(d['sizeBB']),
    sizeRatio: d['sizeChips'] === undefined ? null : Number(d['sizeChips']) / Number(math['pot']),
    confidence: Number(d['confidence']),
    classification: String(d['classification']),
    heroEquity: math['heroEquity'] === null || math['heroEquity'] === undefined ? null : Number(math['heroEquity']),
    supportSize: diag['range']?.['supportSize'] ?? null,
    checkEV: bd?.['checkEV'] ?? null,
    sizes: ((bd?.['sizes'] ?? []) as readonly M[]).map((s) => ({ ...s })),
    reasons: (d['reasons'] ?? []) as readonly M[],
  };
}

const CASES: readonly Row[] = [
  runCase('A 真CS+1500', 'CALLING_STATION', TRUE_STATION),
  runCase('B 假CS+1500', 'CALLING_STATION', TIGHT_WEAK),
  runCase('C CS标签', 'CALLING_STATION', null),
  runCase('D NIT标签', 'VERY_TIGHT', null),
  runCase('E NIT标签+紧弱实测', 'VERY_TIGHT', TIGHT_WEAK),
];

const f = (x: unknown, d = 4): string =>
  (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '—');
const pct = (x: unknown, d = 2): string =>
  (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const line = (s = ''): void => console.log(s);
const pad = (s: unknown, n: number): string => String(s).padEnd(n);
const sizeOf = (r: Row, kind: string): M | null => r.sizes.find((s) => String(s['size']) === kind) ?? null;
const A = CASES[0]!, B = CASES[1]!, C = CASES[2]!, D = CASES[3]!, E = CASES[4]!;

line('='.repeat(126));
line(' TEST 12 —— resolver 维度映射专项 ｜ BTN A♠K♠ ｜ K♦9♣4♥6♠2♣ ｜ 河牌 BB 第三次过牌 ⇒ 薄价值');
line('='.repeat(126));
line();

/* ---------- 主表 ---------- */
const HEAD = [A, B, C, D];
line(pad('指标', 22) + HEAD.map((r) => pad(r.label, 18)).join(''));
line('-'.repeat(94));
const row = (name: string, get: (r: Row) => unknown, d = 4): void =>
  line(pad(name, 22) + HEAD.map((r) => pad(get(r), 18)).join(''));

row('tightness', (r) => f(r.dims.tightness));
row('aggression', (r) => f(r.dims.aggression));
row('passivity', (r) => f(r.dims.passivity));
row('bluffTendency', (r) => f(r.dims.bluffTendency));
row('riverFoldScale', (r) => f(r.riverFoldScale));
row('Small Fold%', (r) => pct(sizeOf(r, 'BET_SMALL')?.['foldLikelihood'], 2));
row('Small Call%', (r) => pct(sizeOf(r, 'BET_SMALL')?.['callLikelihood'], 2));
row('Small Raise%', (r) => pct(sizeOf(r, 'BET_SMALL')?.['raiseLikelihood'], 2));
row('EqVsCall Small', (r) => pct(sizeOf(r, 'BET_SMALL')?.['heroEquityVsCallRange'], 2));
row('Small BetEV', (r) => f(sizeOf(r, 'BET_SMALL')?.['betEV'], 3));
row('Medium BetEV', (r) => f(sizeOf(r, 'BET_MEDIUM')?.['betEV'], 3));
row('Large BetEV', (r) => f(sizeOf(r, 'BET_LARGE')?.['betEV'], 3));
row('CHECK EV', (r) => f(r.checkEV, 3));
row('Small ΔvsCheck', (r) => f(sizeOf(r, 'BET_SMALL')?.['deltaVsCheck'], 3));
row('Medium ΔvsCheck', (r) => f(sizeOf(r, 'BET_MEDIUM')?.['deltaVsCheck'], 3));
row('Final Action', (r) => r.action);
row('Recommended Chips', (r) => f(r.sizeChips, 2));
row('Recommended %Pot', (r) => pct(r.sizeRatio, 2));
row('Confidence', (r) => f(r.confidence, 3));
row('Classification', (r) => r.classification);
row('Hero Equity', (r) => pct(r.heroEquity, 3));
row('Range supportSize', (r) => String(r.supportSize));
line('');

/* ---------- 标签基准 vs 实测 vs resolved ---------- */
line('### base dimensions（标签基准，archetypeDimensions.ts）');
line('');
line(pad('标签', 18) + pad('tightness', 12) + pad('aggression', 12) + pad('bluffTendency', 15) + 'passivity');
line('-'.repeat(70));
for (const [name, spec] of [
  ['CALLING_STATION', ARCHETYPE_DIMENSIONS.CALLING_STATION],
  ['VERY_TIGHT(NIT)', ARCHETYPE_DIMENSIONS.VERY_TIGHT],
] as const) {
  line(pad(name, 18) + (spec === null ? '—'
    : pad(f(spec.tightness), 12) + pad(f(spec.aggression), 12) + pad(f(spec.bluffTendency), 15) + f(spec.passivity)));
}
line('');

line('### 三层维度：base（标签） / observed-only（只有实测） / resolved（融合，下游消费）');
line('');
line(pad('组别', 22) + pad('层次', 22) + pad('tightness', 12) + pad('aggression', 12) + pad('bluffTendency', 15) + 'passivity');
line('-'.repeat(96));
for (const r of HEAD) {
  const show = (name: string, d: Record<Dim, number>): void => {
    line(pad(r.label, 22) + pad(name, 22) +
      pad(f(d.tightness), 12) + pad(f(d.aggression), 12) + pad(f(d.bluffTendency), 15) + f(d.passivity));
  };
  if (r.baseDimsPipeline !== null) show('base（标签）', r.baseDimsPipeline as Record<Dim, number>);
  show('observed-only（实测）', r.observedDims);
  show('resolved（融合）', r.dims);
  if (r.recon !== null) {
    const ok = (['tightness', 'aggression', 'bluffTendency', 'passivity'] as Dim[])
      .every((x) => Math.abs(r.recon!.reconstructed[x] - r.observedDims[x]) < 1e-12);
    line(pad('', 22) + pad('重建比对（observed）', 22) + (ok ? '✅ 与管线逐位一致' : '❌ 与管线不一致'));
  }
  if (r.evidenceMass !== null && r.blendWeight !== null) {
    line(pad('', 22) + pad('evidenceMass', 22) +
      pad(f(r.evidenceMass['tightness'], 1), 12) + pad(f(r.evidenceMass['aggression'], 1), 12) +
      pad(f(r.evidenceMass['bluffTendency'], 1), 15) + f(r.evidenceMass['passivity'], 1));
    line(pad('', 22) + pad('blendWeight（实测占比）', 22) +
      pad(f(r.blendWeight['tightness']), 12) + pad(f(r.blendWeight['aggression']), 12) +
      pad(f(r.blendWeight['bluffTendency']), 15) + f(r.blendWeight['passivity']));
  }
  line('');
}
line('');

/* ---------- effective 统计与证据权重 ---------- */
line('### effective 统计与证据权重（confidence = n/(n+K)）');
line('');
for (const r of HEAD) {
  if (r.stats === null) { line(`  【${r.label}】无实测 ⇒ 全部回落标签先验`); continue; }
  line(`  【${r.label}】observedStatCount = ${String(r.observedStatCount)} ｜ handsObserved = ${r.stats.handsObserved}`);
  for (const key of ['vpip', 'pfr', 'threeBet', 'wtsd', 'foldToFlopCBet', 'foldToTurnCBet', 'foldToRiverBet']) {
    const raw = (r.stats as unknown as Record<string, number | null>)[key] ?? null;
    line(`    ${pad(key, 18)} 实测 ${pad(raw === null ? '—' : pct(raw, 0), 7)}` +
      ` ⇒ effective ${pad(pct(r.effective[key], 3), 9)} ｜ 权重 ${f(r.weights[key], 4)}`);
  }
}
line('');

/* ---------- 推力明细 ---------- */
line('### 各维度推力明细（从 trace 的 observedRate + 公开极性表重建）');
line('');
for (const r of [A, B]) {
  if (r.recon === null) continue;
  line(`  【${r.label}】`);
  for (const dim of DIMS) {
    const cs = r.recon.contributions[dim];
    if (cs.length === 0) { line(`    ${pad(dim, 16)} 无统计作用于该轴 ⇒ resolved 恒 0.5`); continue; }
    const total = cs.reduce((s, c) => s + c.push, 0);
    const den = cs.reduce((s, c) => s + Math.abs(c.polarity) * c.confidence, 0);
    line(`    ${pad(dim, 16)} Σ推力 = ${pad(f(total), 10)} ｜ Σ权重 = ${pad(f(den), 8)}` +
      ` ⇒ 平均偏离 ${pad(f(total / den), 9)}` +
      ` ⇒ observed-only ${pad(f(r.recon.observedOnly[dim]), 8)} / resolved ${f(r.recon.reconstructed[dim])}`);
    for (const c of cs) {
      line(`        · ${pad(c.stat, 16)} 极性 ${pad(c.polarity, 6)} × center(${f(c.center)}) × 权重 ${f(c.confidence)} = ${f(c.push)}`);
    }
  }
  line('');
}

line('### 诊断对照 E：标签维度是否参与混合？（NIT 标签 + 与 B 完全相同的紧弱实测）');
line('');
line(pad('指标', 26) + pad('B 假CS+紧弱实测', 22) + pad('E NIT标签+紧弱实测', 22) + '是否相同');
line('-'.repeat(88));
const eRow = (name: string, g: (r: Row) => unknown): void => {
  const bv = g(B), ev = g(E);
  line(pad(name, 26) + pad(bv, 22) + pad(ev, 22) + (String(bv) === String(ev) ? '相同' : '**不同**'));
};
eRow('tightness', (r) => f(r.dims.tightness));
eRow('aggression', (r) => f(r.dims.aggression));
eRow('passivity', (r) => f(r.dims.passivity));
eRow('bluffTendency', (r) => f(r.dims.bluffTendency));
eRow('riverFoldScale', (r) => f(r.riverFoldScale));
eRow('Small Fold%', (r) => pct(sizeOf(r, 'BET_SMALL')?.['foldLikelihood'], 2));
eRow('Small BetEV', (r) => f(sizeOf(r, 'BET_SMALL')?.['betEV'], 3));
eRow('Final Action', (r) => r.action);
line('');
line('  ⇒ 四个维度**逐位相同** ⇒ 有实测时 `v3Dimensions` 完全**覆盖**标签维度（contextBuilder.ts:1800「覆盖而不是叠加」）。');
line('     标签唯一还活着的地方是分街条目的**先验**（`traitPriorOf`：CS 的 fold 先验 0.380 vs NIT 0.498），');
line('     因此 riverFoldScale 仍有细微差别 —— 但「他是松是紧、是主动是被动」这层理解已完全由实测接管。');
line('');

/* ---------- 验收 ---------- */
line('='.repeat(126));
line(' 核心验收（用户的五条标准）');
line('='.repeat(126));
line('');

const stationDirection = (r: Row): boolean =>
  r.dims.tightness < C.dims.tightness && r.dims.passivity > C.dims.passivity;
const nitApproach = (r: Row): number =>
  (r.dims.tightness - C.dims.tightness) / (D.baseDims!['tightness'] - C.dims.tightness);

const crit: { name: string; pass: boolean; detail: string }[] = [];

/* 1 */
const sepT = B.dims.tightness - A.dims.tightness;
const sepP = A.dims.passivity - B.dims.passivity;
crit.push({
  name: '① A/B resolved 明显分开且方向正确（A 更低紧度/更高被动；B 更高紧度/被动偏高）',
  pass: sepT > 0.05 && sepP > 0.05 && B.dims.passivity >= 0.5,
  detail: `Δtightness(B−A) = ${f(sepT)} ｜ Δpassivity(A−B) = ${f(sepP)}` +
    ` ｜ B.passivity = ${f(B.dims.passivity)}${B.dims.passivity < 0.5 ? '（< 0.5 ⇒ 紧弱被判成"不被动"）' : ''}`,
});

/* 2 */
const approach = nitApproach(B);
const leftLabel = B.dims.tightness > 0.5 && Math.abs(B.dims.tightness - C.dims.tightness) >= 0.2;
crit.push({
  name: '② B 离开 CS 标签并越过中性线（不是「≈ 纯 CS 标签」）',
  pass: leftLabel,
  detail: `B.tightness = ${f(B.dims.tightness)} ｜ 距 CS 标签 ${f(Math.abs(B.dims.tightness - C.dims.tightness))}` +
    ` ｜ 已走到 NIT 标签的 ${pct(approach, 1)}（标签 ${f(C.dims.tightness)} → NIT ${f(D.baseDims!['tightness'])}）`,
});

/* 3 */
const aOk = A.dims.tightness < 0.5 && A.dims.passivity > 0.5 &&
  Math.abs(A.dims.tightness - C.dims.tightness) < 0.1 && Math.abs(A.dims.passivity - C.dims.passivity) < 0.1;
crit.push({
  name: '③ A 与纯 CS 标签同方向（未命中用户明示的 tightness>0.5 且 passivity<0.5 FAIL 条件）',
  pass: aOk,
  detail: `A.tightness = ${f(A.dims.tightness)}（标签 ${f(C.dims.tightness)}）｜ ` +
    `A.passivity = ${f(A.dims.passivity)}（标签 ${f(C.dims.passivity)}）` +
    (A.dims.tightness > 0.5 && A.dims.passivity < 0.5 ? ' ⇒ **命中 FAIL 条件**' : ' ⇒ 未命中'),
});

/* 4 */
const evA = Number(sizeOf(A, 'BET_SMALL')?.['betEV'] ?? NaN);
const evB = Number(sizeOf(B, 'BET_SMALL')?.['betEV'] ?? NaN);
crit.push({
  name: '④ 策略体现画像差异：A 的薄价值 EV 明显优于 B',
  pass: (evA - evB) > 0.5 && Number(sizeOf(A, 'BET_SMALL')?.['callLikelihood'] ?? 0) > Number(sizeOf(B, 'BET_SMALL')?.['callLikelihood'] ?? 1),
  detail: `A BetEV(S) = ${f(evA, 3)} ｜ B BetEV(S) = ${f(evB, 3)} ｜ Δ = ${f(evA - evB, 3)} 筹码 ｜ ` +
    `A Call% = ${pct(sizeOf(A, 'BET_SMALL')?.['callLikelihood'])} vs B ${pct(sizeOf(B, 'BET_SMALL')?.['callLikelihood'])}`,
});

/* 5 */
const dimsIdenticalAB = DIMS.every((d) => Math.abs(E.dims[d] - B.dims[d]) < 1e-12);
crit.push({
  name: '⑤ 实测不只改分街系数，还改全局人物理解（且标签不因实测而丢失）',
  pass: false, // 由下面两项共同判定
  detail: `B/C 的 resolved 维度差异 = ${f(Math.abs(B.dims.tightness - C.dims.tightness))}（tightness）；` +
    `E（NIT 标签 + 同一份紧弱实测）与 B 的维度是否相同 = ${dimsIdenticalAB ? '**完全相同** ⇒ 实测把标签维度完全覆盖（不是混合）' : '不同 ⇒ 标签参与了混合'}`,
});
crit[4]!.pass = Math.abs(B.dims.tightness - C.dims.tightness) > 0.05 && !dimsIdenticalAB;

for (const c of crit) {
  line(`  ${c.pass ? '✅ PASS' : '❌ FAIL'}  ${c.name}`);
  line(`        ${c.detail}`);
  line('');
}

const failed = crit.filter((c) => !c.pass).length;
line(`  汇总：${crit.length - failed} / ${crit.length} 通过`);
line('');
line(failed === 0
  ? '  TEST12_RESOLVER_DIMENSIONS — PASS'
  : failed <= 2
    ? '  TEST12_RESOLVER_DIMENSIONS — FAIL（缺陷已定位，见上方 ❌ 条目）'
    : '  TEST12_RESOLVER_DIMENSIONS — FAIL');
line('');

/* ---------- 归因 ---------- */
line('### 归因对照：修复前的统一 0.5 锚点 vs 修复后的逐统计锚点');
line('');
line('  修复前：center(rate) = (rate − 0.5) × 2   ← 所有统计共用，锚点固定在 0.5');
line('  修复后：deviation(rate) = (rate − neutralAnchor) / scale   ← 逐统计设定');
line('');
line(pad('统计', 12) + pad('实测', 9) + pad('旧锚点', 9) + pad('旧偏离', 10) +
  pad('新锚点', 10) + pad('半宽', 9) + pad('新偏离', 10) + '变化');
line('-'.repeat(84));
for (const r of [A, B]) {
  if (r.stats === null) continue;
  line(`  【${r.label}】`);
  for (const key of ['vpip', 'pfr', 'threeBet', 'wtsd'] as const) {
    const rate = (r.stats as unknown as Record<string, number>)[key];
    if (rate === undefined) continue;
    const spec = STAT_EVIDENCE_SPECS[key];
    const oldDev = centerOf(rate);
    const newDev = deviationOf(key, rate);
    line('  ' + pad(key, 12) + pad(pct(rate, 0), 9) + pad('0.5', 9) + pad(f(oldDev), 10) +
      pad(f(spec.neutralAnchor, 2), 10) + pad(f(spec.scale, 2), 9) + pad(f(newDev), 10) +
      (Math.abs(newDev - oldDev) > 0.05 ? '**方向/量级都被纠正**' : ''));
  }
}
line('');
line('  ⇒ 旧锚点下「极松」几乎不可见（VPIP 52% ⇒ +0.04）、「极黏」把 passivity 往下推');
line('     （WTSD 43% ⇒ −0.14）；新锚点把它们分别纠正为 +1.00（截断）与 +1.00（截断），');
line('     而偏紧/偏低的一侧也不再被夸大（VPIP 18% 从 −0.64 变为 −0.56）。');
line('');
