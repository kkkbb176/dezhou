/**
 * 测试牌局 11 —— BTN K♠Q♠，**河牌薄价值榨取**（BB 第三次过牌，轮到我）
 *
 * 6-max 现金桌，盲注 1/2，有效筹码 200（100BB）
 *
 * 翻前：UTG/HJ/CO 弃 → **BTN 开 6（3BB）** → SB 弃 → BB 跟 ⇒ 底池 13
 * 翻牌 K♦8♣4♥：BB 过 / BTN 下 5 / BB 跟 ⇒ 底池 23
 * 转牌 6♠：BB 过 / BTN 下 15 / BB 跟 ⇒ 底池 53
 * 河牌 2♦：BB 第三次过牌 ⇒ **Hero 决策（本脚本的决策点）**
 *
 * Hero = 顶对 Q 踢脚（K♠Q♠）｜河牌 2♦ 是 blank ｜ SPR 3.28
 * 三轮全部由 Hero 开枪 ⇒ 河牌下注 = 第三次开火 ⇒ 节点应为 FACING_CBET
 *
 * 四组画像：
 *   A. CALLING_STATION + 980 手实测（老周）
 *   B. CALLING_STATION，无 observedStats
 *   C. NORMAL，无 observedStats
 *   D. VERY_TIGHT + 1250 手实测（老郑）
 *
 * 用法：node --experimental-strip-types scripts/test11-river-thin-value.ts
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { deriveLegalActions, buildSizeGrid } from '../src/app/manualInput/legalActions.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { PlayerObservedStats } from '../src/domain/player/observedStats.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_011;
const ASOF = 1_757_000_000_000;

const H = (p: string, t: string, a?: number, s?: string) => ({
  position: p, type: t,
  ...(a === undefined ? {} : { amountBB: a }),
  ...(s === undefined ? {} : { street: s }),
});

/** 完整历史（到河牌 BB 第三次过牌为止） */
const HISTORY = [
  H('UTG', 'FOLD'), H('HJ', 'FOLD'), H('CO', 'FOLD'),
  H('BTN', 'RAISE', 3), H('SB', 'FOLD'), H('BB', 'CALL', 2),
  H('BB', 'CHECK', undefined, 'FLOP'), H('BTN', 'BET', 2.5, 'FLOP'), H('BB', 'CALL', 2.5, 'FLOP'),
  H('BB', 'CHECK', undefined, 'TURN'), H('BTN', 'BET', 7.5, 'TURN'), H('BB', 'CALL', 7.5, 'TURN'),
  H('BB', 'CHECK', undefined, 'RIVER'),
];
const BOARD = ['Kd', '8c', '4h', '6s', '2d'];
const SEATS: Record<string, number> = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };

const LAOZHOU: PlayerObservedStats = {
  handsObserved: 980,
  vpip: 0.51, pfr: 0.08, threeBet: 0.03, wtsd: 0.42,
  foldToFlopCBet: 0.22, foldToTurnCBet: 0.20, foldToRiverBet: 0.15,
  flopCheckRaise: 0.05, turnCheckRaise: 0.03, riverCheckRaise: 0.02,
};
const LAOZHENG: PlayerObservedStats = {
  handsObserved: 1250,
  vpip: 0.17, pfr: 0.11, threeBet: 0.04, wtsd: 0.21,
  foldToFlopCBet: 0.46, foldToTurnCBet: 0.54, foldToRiverBet: 0.62,
  flopCheckRaise: 0.04, turnCheckRaise: 0.03, riverCheckRaise: 0.01,
};

type M = Record<string, any>;

function inputFor(quickProfile: string, observedStats: PlayerObservedStats | null): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['Ks', 'Qs'],
    board: BOARD, street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: HISTORY.map((a) => ({ ...a })),
    environment: 'MID_LOW_STAKES',
    villain: {
      quickProfile, dynamicHint: 'UNKNOWN', stackBB: 100,
      ...(observedStats === null ? {} : { observedStats }),
    },
  } as unknown as ManualHandInput;
}

type Row = {
  label: string;
  action: string;
  sizeChips: number | null;
  sizeBB: number | null;
  sizeRatio: number | null;
  confidence: number;
  classification: string;
  heroEquity: number | null;
  equityMethod: string;
  supportSize: number | null;
  rangeSourceKind: string | null;
  checkEV: number | null;
  pot: number;
  sizes: M[];
  targetSmall: number | null;
  gridAmounts: number[];
  minBet: number;
  allInToAmount: number;
  riverFactors: M | null;
  actionContext: string | null;
  denied: readonly string[];
  dimensions: M;
  observedStatCount: number | null;
  traitRouting: Record<string, { value: number | null; denied: boolean; applied: boolean }>;
  reasons: readonly M[];
};

function run(label: string, quickProfile: string, observedStats: PlayerObservedStats | null): Row {
  const input = inputFor(quickProfile, observedStats);

  const parsed = parseManualInput(input);
  if (!parsed.ok) throw new Error(`PARSE ${JSON.stringify(parsed.issues.slice(0, 3))}`);
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error(`STATE ${JSON.stringify(gate.issues.slice(0, 3))}`);

  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
    asOf: ASOF, quickProfile: quickProfile as never,
    ...(observedStats === null ? {} : { observedStats }),
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

  const hero = gate.state.players.find((p) => p.holeCards !== null)!;
  const legal = deriveLegalActions(gate.state, hero);
  const grid = buildSizeGrid(legal, Number(math['pot']), 'BET');

  const trace = ((v3?.['trace'] ?? []) as readonly M[]);
  const deniedSet = new Set<string>((v3?.['deniedStreetTraits'] ?? []) as readonly string[]);
  const traitRouting: Record<string, { value: number | null; denied: boolean; applied: boolean }> = {};
  for (const stat of ['foldToFlopCBet', 'foldToTurnCBet', 'foldToRiverBet']) {
    const row = trace.find((x) => x['stat'] === stat) ?? null;
    const trait = (row?.['streetTrait'] ?? null) as string | null;
    const isDenied = trait !== null && deniedSet.has(trait);
    const value = row === null || row['streetTraitEffectiveRate'] === null
      ? null : Number(row['streetTraitEffectiveRate']);
    traitRouting[stat] = {
      value, denied: isDenied,
      applied: !isDenied && value !== null && Math.abs(value - 0.5) > 1e-12,
    };
  }

  const sizes = ((bd?.['sizes'] ?? []) as readonly M[]).map((s) => ({ ...s }));
  const small = sizes.find((s) => String(s['size']) === 'BET_SMALL') ?? null;

  return {
    label, action: String(d['action']),
    sizeChips: d['sizeChips'] === undefined ? null : Number(d['sizeChips']),
    sizeBB: d['sizeBB'] === undefined ? null : Number(d['sizeBB']),
    sizeRatio: d['sizeChips'] === undefined ? null : Number(d['sizeChips']) / Number(math['pot']),
    confidence: Number(d['confidence']),
    classification: String(d['classification']),
    heroEquity: math['heroEquity'] === null || math['heroEquity'] === undefined
      ? null : Number(math['heroEquity']),
    equityMethod: String((math['equitySource'] as M | null)?.['method'] ?? '—'),
    supportSize: diag['range']?.['supportSize'] ?? null,
    rangeSourceKind: diag['range']?.['sourceKind'] ?? null,
    checkEV: bd?.['checkEV'] ?? null,
    pot: Number(math['pot']),
    sizes,
    targetSmall: small === null ? null : Number(small['betAmount']),
    gridAmounts: grid.map((g) => g.toAmount),
    minBet: legal.minBet,
    allInToAmount: legal.allInToAmount,
    riverFactors: v3?.['street']?.['RIVER'] ?? null,
    actionContext: (v3?.['actionContext'] ?? null) as string | null,
    denied: (v3?.['deniedStreetTraits'] ?? []) as readonly string[],
    dimensions: (v3?.['dimensions'] ?? {}) as M,
    observedStatCount: v3?.['observedStatCount'] ?? null,
    traitRouting,
    reasons: (d['reasons'] ?? []) as readonly M[],
  };
}

const GROUPS: readonly { label: string; profile: string; stats: PlayerObservedStats | null }[] = [
  { label: 'A. 老周 Calling Station + 980 手', profile: 'CALLING_STATION', stats: LAOZHOU },
  { label: 'B. Calling Station，无统计', profile: 'CALLING_STATION', stats: null },
  { label: 'C. NORMAL', profile: 'NORMAL', stats: null },
  { label: 'D. 老郑 NIT + 1250 手', profile: 'VERY_TIGHT', stats: LAOZHENG },
];
const ROWS = GROUPS.map((g) => run(g.label, g.profile, g.stats));

const f = (x: unknown, d = 2): string =>
  (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '—');
const pct = (x: unknown, d = 2): string =>
  (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const line = (s = ''): void => console.log(s);
const pad = (s: unknown, n: number): string => String(s).padEnd(n);
const sizeOf = (r: Row, kind: string): M | null => r.sizes.find((s) => String(s['size']) === kind) ?? null;
const KIND_ZH: Record<string, string> = {
  BET_SMALL: 'BET_SMALL（1/3 池）',
  BET_MEDIUM: 'BET_MEDIUM（2/3 池）',
  BET_LARGE: 'BET_LARGE（1 池）',
  ALL_IN: 'ALL_IN',
};

line('='.repeat(120));
line(' 测试牌局 11 —— BTN K♠Q♠ ｜ K♦8♣4♥6♠2♦ ｜ **河牌 BB 第三次过牌 ⇒ 薄价值榨取**');
line('='.repeat(120));
line();

/* ============================================================
 * 每组完整输出
 * ============================================================ */

for (const r of ROWS) {
  line('─'.repeat(120));
  line(`【${r.label}】`);
  line('─'.repeat(120));
  line(`  Final Action            = ${r.action}`);
  line(`  Recommended Size        = ${r.sizeChips === null ? '—（无下注尺寸）' : `${f(r.sizeChips)} 筹码`}`);
  line(`  Recommended Chips/BB/%  = ${f(r.sizeChips)} / ${f(r.sizeBB, 3)}BB / ${pct(r.sizeRatio)}`);
  line(`  Confidence              = ${f(r.confidence, 3)}`);
  line(`  Classification          = ${r.classification}`);
  line('');
  line(`  Hero Equity vs Arrival Range = ${pct(r.heroEquity, 3)}（${r.equityMethod}）`);
  line(`  Range supportSize       = ${String(r.supportSize)} 个组合 ｜ 来源 ${String(r.rangeSourceKind)}`);
  line(`  CHECK EV                = ${f(r.checkEV, 3)} 筹码`);
  line('');
  line('  ── 三档尺寸明细 ──');
  line('  ' + pad('尺寸档', 22) + pad('amount', 10) + pad('%池', 9) + pad('Fold%', 9) + pad('Call%', 9) +
    pad('Raise%', 9) + pad('EqVsCall', 10) + pad('BetEV', 10) + pad('ΔvsCheck', 10) + 'Score');
  line('  ' + '-'.repeat(112));
  for (const kind of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE', 'ALL_IN']) {
    const s = sizeOf(r, kind);
    if (s === null) {
      line('  ' + pad(KIND_ZH[kind] ?? kind, 22) + '（不在下注决策模型里）');
      continue;
    }
    line('  ' + pad(KIND_ZH[kind] ?? kind, 22) +
      pad(f(s['betAmount'], 2), 10) +
      pad(pct(s['ratioToPot'], 2), 9) +
      pad(pct(s['foldLikelihood'], 2), 9) +
      pad(pct(s['callLikelihood'], 2), 9) +
      pad(pct(s['raiseLikelihood'], 2), 9) +
      pad(pct(s['heroEquityVsCallRange'], 2), 10) +
      pad(f(s['betEV'], 3), 10) +
      pad(f(s['deltaVsCheck'], 3), 10) +
      f(s['score'], 4));
  }
  line('');

  /* ---- 合法化审计 ---- */
  const target = r.targetSmall;
  const nearest = target === null ? null
    : r.gridAmounts.reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best), r.gridAmounts[0]!);
  const smallRow = sizeOf(r, 'BET_SMALL');
  const medRow = sizeOf(r, 'BET_MEDIUM');
  const slope = smallRow !== null && medRow !== null &&
    typeof smallRow['betEV'] === 'number' && typeof medRow['betEV'] === 'number'
    ? (Number(medRow['betEV']) - Number(smallRow['betEV'])) /
      (Number(medRow['betAmount']) - Number(smallRow['betAmount']))
    : null;
  line('  ── 合法化审计（BET_SMALL） ──');
  line(`  Target BET_SMALL amount    = ${f(target, 4)} 筹码 = ${pct(target === null ? null : target / r.pot, 3)} 池`);
  line(`  Legalized BET_SMALL amount = ${f(nearest, 2)} 筹码 = ${pct(nearest === null ? null : nearest / r.pot, 3)} 池` +
    `（引擎实际推荐 ${f(r.sizeChips, 2)}）`);
  line(`  合法 BET 网格              = [${r.gridAmounts.join(', ')}] ｜ 最小下注 ${f(r.minBet, 2)} ｜ 全下 ${f(r.allInToAmount, 2)}`);
  line(`  EV(target size)            = ${f(smallRow?.['betEV'], 4)} 筹码（**管线真实计算值**，在 ${f(target, 4)} 上算的）`);
  line(`  EV(legalized size)         = **未计算** —— 管线按设计只在模型自己的尺寸上算 EV`);
  if (slope !== null && target !== null && nearest !== null) {
    line(`  └ 局部斜率（SMALL→MEDIUM 区间）= ${f(slope, 5)} 筹码 EV / 筹码尺寸` +
      ` ⇒ 线性外推 ΔEV(取整 ${f(nearest - target, 3)} 筹码) ≈ ${f(slope * (nearest - target), 5)} 筹码`);
  }
  line('');
  line(`  ── 河牌分街系数与路由 ──`);
  line(`  河牌因子 = ${JSON.stringify(r.riverFactors)}`);
  line(`  actionContext = ${String(r.actionContext)} ｜ denied = [${r.denied.join(', ')}]`);
  for (const [stat, info] of Object.entries(r.traitRouting)) {
    line(`    ${pad(stat, 18)} 生效值 ${pad(f(info.value, 4), 8)} ｜ 进入模型 ${info.applied ? '是' : '否'}` +
      ` ｜ 被语义门挡下 ${info.denied ? '是' : '否'}`);
  }
  line(`  实测项数 = ${String(r.observedStatCount)} ｜ 维度 = ${JSON.stringify(r.dimensions)}`);
  line('');
  line('  ── 引擎理由 ──');
  for (const reason of r.reasons.slice(0, 8)) {
    line(`    [${String(reason['code'])}] ${String(reason['textZh']).slice(0, 240)}`);
  }
  line('');
}

/* ============================================================
 * 汇总对比表
 * ============================================================ */

line('='.repeat(120));
line(' 汇总对比');
line('='.repeat(120));
line('');
line(pad('字段', 30) + ROWS.map((r) => pad(r.label.split('.')[0] + '.' + r.label.split(' ')[1], 18)).join(''));
line('-'.repeat(102));
const cmp = (name: string, get: (r: Row) => unknown): void =>
  line(pad(name, 30) + ROWS.map((r) => pad(get(r), 18)).join(''));
cmp('Final Action', (r) => r.action);
cmp('Recommended Chips', (r) => f(r.sizeChips, 2));
cmp('Recommended BB', (r) => f(r.sizeBB, 3));
cmp('Recommended %Pot', (r) => pct(r.sizeRatio, 2));
cmp('Confidence', (r) => f(r.confidence, 3));
cmp('Classification', (r) => r.classification);
cmp('Hero Equity（到达范围）', (r) => pct(r.heroEquity, 3));
cmp('Range supportSize', (r) => String(r.supportSize));
cmp('CHECK EV', (r) => f(r.checkEV, 3));
line('');
for (const kind of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  cmp(`${kind} Fold%`, (r) => pct(sizeOf(r, kind)?.['foldLikelihood'], 2));
}
line('');
for (const kind of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  cmp(`${kind} Call%`, (r) => pct(sizeOf(r, kind)?.['callLikelihood'], 2));
}
line('');
for (const kind of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  cmp(`${kind} Raise%`, (r) => pct(sizeOf(r, kind)?.['raiseLikelihood'], 2));
}
line('');
for (const kind of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  cmp(`${kind} EqVsCall`, (r) => pct(sizeOf(r, kind)?.['heroEquityVsCallRange'], 2));
}
line('');
for (const kind of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  cmp(`${kind} BetEV`, (r) => f(sizeOf(r, kind)?.['betEV'], 3));
}
line('');
for (const kind of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  cmp(`${kind} ΔvsCheck`, (r) => f(sizeOf(r, kind)?.['deltaVsCheck'], 3));
}
line('');
for (const kind of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  cmp(`${kind} Strategy Score`, (r) => f(sizeOf(r, kind)?.['score'], 4));
}
line('');
line('  合法化审计（BET_SMALL）：');
line(`    Target amount      = ${f(ROWS[0]!.targetSmall, 4)} 筹码（五组共用同一牌局 ⇒ 同值）`);
line(`    Legalized amount   = 引擎推荐 ${f(ROWS[0]!.sizeChips, 2)} 筹码 = ${pct(ROWS[0]!.sizeRatio, 2)} 池`);
line(`    EV(target)         = ${f(sizeOf(ROWS[0]!, 'BET_SMALL')?.['betEV'], 4)}（A 组；各组的 EV 见上表）`);
line(`    EV(legalized)      = 未计算（设计如此：EV 只在模型尺寸上算，映射到合法按钮时不再重算）`);
line('');
