/**
 * TEST 10B —— FoldToTurnCBet 敏感度专项扫描
 *
 * 完全沿用 TEST 10 的牌局（不换牌 / 不换位置 / 不换范围），
 * **只改一个字段**：`foldToTurnCBet` ∈ {0.10, 0.30, 0.50, 0.70, 0.90}。
 *
 * 牌局：6-max 1/2，CO A♥5♥，K♥7♣3♥4♠ 转牌 BB 过牌 ⇒ Hero 决策
 * 底池 23 筹码（11.5BB），Hero/Villain 各剩 189，SPR 8.22
 * 节点：Hero 翻前进攻者 + 翻牌进攻者 ⇒ 转牌下注 = **真 Turn CBet** ⇒ FACING_CBET
 *
 * 固定画像：NORMAL · 1500 手 · VPIP .30 / PFR .20 / 3Bet .08 / WTSD .28
 *          FoldFlop .40 / FoldRiver .40 / CR .08/.08/.08
 *
 * 用法：node --experimental-strip-types scripts/test10b-foldturn-sensitivity.ts
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { deriveLegalActions, buildSizeGrid } from '../src/app/manualInput/legalActions.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { PlayerObservedStats } from '../src/domain/player/observedStats.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_010;
const ASOF = 1_757_000_000_000;

/* ============================================================
 * 固定牌局
 * ============================================================ */

const H = (p: string, t: string, a?: number, s?: string) => ({
  position: p, type: t,
  ...(a === undefined ? {} : { amountBB: a }),
  ...(s === undefined ? {} : { street: s }),
});

const HISTORY = [
  H('UTG', 'FOLD'), H('HJ', 'FOLD'),
  H('CO', 'RAISE', 3), H('BTN', 'FOLD'), H('SB', 'FOLD'), H('BB', 'CALL', 2),
  H('BB', 'CHECK', undefined, 'FLOP'), H('CO', 'BET', 2.5, 'FLOP'), H('BB', 'CALL', 2.5, 'FLOP'),
  H('BB', 'CHECK', undefined, 'TURN'),
];
const SEATS: Record<string, number> = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };

const FOLD_TURNS = [0.10, 0.30, 0.50, 0.70, 0.90] as const;

function inputFor(foldToTurnCBet: number): ManualHandInput {
  const observedStats: PlayerObservedStats = {
    handsObserved: 1500,
    vpip: 0.30, pfr: 0.20, threeBet: 0.08, wtsd: 0.28,
    foldToFlopCBet: 0.40,
    foldToTurnCBet,            // ← 唯一变量
    foldToRiverBet: 0.40,
    flopCheckRaise: 0.08, turnCheckRaise: 0.08, riverCheckRaise: 0.08,
  };
  return {
    tableSize: 6, heroPosition: 'CO', heroCards: ['Ah', '5h'],
    board: ['Kh', '7c', '3h', '4s'], street: 'TURN',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: HISTORY.map((a) => ({ ...a })),
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats },
  } as unknown as ManualHandInput;
}

/* ============================================================
 * 一次运行：收集全部需要审计的字段
 * ============================================================ */

type M = Record<string, any>;

type CaseResult = {
  input: number;
  /** 统计层 */
  effectiveFoldTurn: number | null;
  evidenceWeight: number | null;
  opportunities: number | null;
  priorRate: number | null;
  priorWeight: number | null;
  streetTraitEffective: number | null;
  approximated: boolean | null;
  /** 分街系数 */
  turnFoldScale: number | null;
  turnCallScale: number | null;
  turnCheckRaiseScale: number | null;
  turnBetScale: number | null;
  dimensions: M;
  actionContext: string | null;
  deniedStreetTraits: readonly string[];
  observedStatCount: number | null;
  /** 三档 fold 统计的放行情况 */
  traitRouting: Record<string, { applied: boolean | null; denied: boolean; value: number | null }>;
  /** 响应与 EV */
  sizes: M[];
  checkEV: number | null;
  bestSize: string | null;
  /** 决策 */
  action: string;
  sizeChips: number | null;
  sizeBB: number | null;
  confidence: number;
  classification: string;
  /** 数学与范围（隔离检查用） */
  pot: number;
  heroEquity: number | null;
  equityMethod: string;
  supportSize: number | null;
  /** 合法尺寸网格 */
  gridAmounts: number[];
  minBet: number;
  allInToAmount: number;
};

function runCase(foldToTurnCBet: number): CaseResult {
  const input = inputFor(foldToTurnCBet);

  const parsed = parseManualInput(input);
  if (!parsed.ok) throw new Error(`PARSE ${JSON.stringify(parsed.issues.slice(0, 3))}`);
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error(`STATE ${JSON.stringify(gate.issues.slice(0, 3))}`);

  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
    asOf: ASOF, quickProfile: 'NORMAL' as never,
    observedStats: (input.villain as unknown as { observedStats: PlayerObservedStats }).observedStats,
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
  const math = d['diagnostics']['math'] as M;
  const bd = d['diagnostics']['postflop']?.['betDecision'] as M | null;

  const trace = ((v3?.['trace'] ?? []) as readonly M[]);
  const t = trace.find((x) => x['stat'] === 'foldToTurnCBet') ?? null;

  const denied = new Set<string>((v3?.['deniedStreetTraits'] ?? []) as readonly string[]);
  const traitRouting: Record<string, { applied: boolean | null; denied: boolean; value: number | null }> = {};
  for (const stat of ['foldToFlopCBet', 'foldToTurnCBet', 'foldToRiverBet']) {
    const row = trace.find((x) => x['stat'] === stat) ?? null;
    const streetTrait = row?.['streetTrait'] as string | null ?? null;
    const isDenied = streetTrait !== null && denied.has(streetTrait);
    const value = row === null || row['streetTraitEffectiveRate'] === null
      ? null
      : Number(row['streetTraitEffectiveRate']);
    traitRouting[stat] = {
      /*
       * 「进入模型」的判据 = **未被语义门挡下** 且 生效值**离开中性 0.5**。
       *
       * ⚠️ 第一版只判 `streetTraitEffectiveRate !== null`，把两条被挡下的统计
       * 也算成「进入模型」——被挡下时该字段是 **0.5000（中性）**而不是 null，
       * 于是断言误报 FAIL。这里按语义修正。
       */
      applied: !isDenied && value !== null && Math.abs(value - 0.5) > 1e-12,
      denied: isDenied,
      value,
    };
  }

  const hero = gate.state.players.find((p) => p.holeCards !== null)!;
  const legal = deriveLegalActions(gate.state, hero);
  const grid = buildSizeGrid(legal, math['pot'] as number, 'BET');

  return {
    input: foldToTurnCBet,
    effectiveFoldTurn: t === null ? null : Number(t['effectiveRate']),
    evidenceWeight: t === null ? null : Number(t['confidence']),
    opportunities: t === null ? null : Number(t['opportunities']),
    priorRate: t === null ? null : Number(t['priorRate']),
    priorWeight: t === null ? null : Number(t['priorWeight']),
    streetTraitEffective: t === null || t['streetTraitEffectiveRate'] === null
      ? null : Number(t['streetTraitEffectiveRate']),
    approximated: t === null ? null : Boolean(t['approximated']),
    turnFoldScale: v3?.['street']?.['TURN']?.['foldScale'] ?? null,
    turnCallScale: v3?.['street']?.['TURN']?.['callScale'] ?? null,
    turnCheckRaiseScale: v3?.['street']?.['TURN']?.['checkRaiseScale'] ?? null,
    turnBetScale: v3?.['street']?.['TURN']?.['betScale'] ?? null,
    dimensions: (v3?.['dimensions'] ?? {}) as M,
    actionContext: (v3?.['actionContext'] ?? null) as string | null,
    deniedStreetTraits: (v3?.['deniedStreetTraits'] ?? []) as readonly string[],
    observedStatCount: v3?.['observedStatCount'] ?? null,
    traitRouting,
    sizes: ((bd?.['sizes'] ?? []) as readonly M[]).map((s) => ({ ...s })),
    checkEV: bd?.['checkEV'] ?? null,
    bestSize: bd?.['bestSize'] ?? null,
    action: String(d['action']),
    sizeChips: d['sizeChips'] === undefined ? null : Number(d['sizeChips']),
    sizeBB: d['sizeBB'] === undefined ? null : Number(d['sizeBB']),
    confidence: Number(d['confidence']),
    classification: String(d['classification']),
    pot: Number(math['pot']),
    heroEquity: math['heroEquity'] === null || math['heroEquity'] === undefined
      ? null : Number(math['heroEquity']),
    equityMethod: String((math['equitySource'] as M | null)?.['method'] ?? '—'),
    supportSize: d['diagnostics']['range']?.['supportSize'] ?? null,
    gridAmounts: grid.map((g) => g.toAmount),
    minBet: legal.minBet,
    allInToAmount: legal.allInToAmount,
  };
}

const CASES = FOLD_TURNS.map((v) => runCase(v));

/* ============================================================
 * 输出工具
 * ============================================================ */

const f = (x: unknown, d = 3): string =>
  (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '—');
const pct = (x: unknown, d = 2): string =>
  (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const pp = (x: unknown, d = 2): string =>
  (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(d)}pp` : '—');
const line = (s = ''): void => console.log(s);
const sizeOf = (c: CaseResult, kind: string): M | null =>
  c.sizes.find((s) => String(s['size']) === kind) ?? null;
const pad = (s: unknown, n: number): string => String(s).padEnd(n);

line('='.repeat(120));
line(' TEST 10B —— FoldToTurnCBet 敏感度专项扫描（只改这一个字段）');
line(' 牌局：6-max 1/2 ｜ CO A♥5♥ ｜ K♥7♣3♥4♠ ｜ 转牌 BB 过牌 ⇒ Hero 决策 ｜ 底池 23 ｜ SPR 8.22');
line(' 固定：NORMAL ・ 1500 手 ・ VPIP .30 / PFR .20 / 3Bet .08 / WTSD .28 / FoldFlop .40 / FoldRiver .40 / CR .08');
line('='.repeat(120));
line();

/* ---------- A. Sensitivity Table ---------- */

line('### A. Sensitivity Table');
line('');
line(pad('FoldTurn输入', 13) + pad('EffFoldTurn', 13) + pad('EvidWeight', 12) + pad('TurnFoldScale', 15) +
  pad('SmallFold%', 12) + pad('MedFold%', 12) + pad('LargeFold%', 12) +
  pad('SmallBetEV', 12) + pad('MedBetEV', 12) + pad('LargeBetEV', 12) +
  pad('CHECK EV', 11) + pad('Final Action', 14) + 'SizeChips / BB');
line('-'.repeat(174));
for (const c of CASES) {
  line(
    pad(c.input.toFixed(2), 13) +
    pad(f(c.effectiveFoldTurn, 4), 13) +
    pad(f(c.evidenceWeight, 4), 12) +
    pad(f(c.turnFoldScale, 4), 15) +
    pad(pct(sizeOf(c, 'BET_SMALL')?.['foldLikelihood'], 2), 12) +
    pad(pct(sizeOf(c, 'BET_MEDIUM')?.['foldLikelihood'], 2), 12) +
    pad(pct(sizeOf(c, 'BET_LARGE')?.['foldLikelihood'], 2), 12) +
    pad(f(sizeOf(c, 'BET_SMALL')?.['betEV'], 2), 12) +
    pad(f(sizeOf(c, 'BET_MEDIUM')?.['betEV'], 2), 12) +
    pad(f(sizeOf(c, 'BET_LARGE')?.['betEV'], 2), 12) +
    pad(f(c.checkEV, 3), 11) +
    pad(c.action, 14) +
    (c.sizeChips === null ? '—' : `${f(c.sizeChips, 2)} / ${f(c.sizeBB, 2)}BB`),
  );
}
line('');

line('  补充：Call% / Raise%（三档）');
line('');
line(pad('FoldTurn输入', 13) + pad('S-Call%', 11) + pad('S-Raise%', 11) +
  pad('M-Call%', 11) + pad('M-Raise%', 11) + pad('L-Call%', 11) + pad('L-Raise%', 11) +
  pad('EqVsCall-S', 12) + pad('EqVsCall-M', 12) + pad('EqVsCall-L', 12) + pad('HeroEq', 10) + 'Method');
line('-'.repeat(126));
for (const c of CASES) {
  const s = sizeOf(c, 'BET_SMALL'), m = sizeOf(c, 'BET_MEDIUM'), l = sizeOf(c, 'BET_LARGE');
  line(
    pad(c.input.toFixed(2), 13) +
    pad(pct(s?.['callLikelihood'], 2), 11) + pad(pct(s?.['raiseLikelihood'], 2), 11) +
    pad(pct(m?.['callLikelihood'], 2), 11) + pad(pct(m?.['raiseLikelihood'], 2), 11) +
    pad(pct(l?.['callLikelihood'], 2), 11) + pad(pct(l?.['raiseLikelihood'], 2), 11) +
    pad(pct(s?.['heroEquityVsCallRange'], 2), 12) +
    pad(pct(m?.['heroEquityVsCallRange'], 2), 12) +
    pad(pct(l?.['heroEquityVsCallRange'], 2), 12) +
    pad(pct(c.heroEquity, 2), 10) + c.equityMethod,
  );
}
line('');

/* ---------- B. Size Audit ---------- */

line('### B. Size Audit');
line('');
const suitables = CASES.filter((c) => c.sizeChips !== null);
/*
 * ⚠️ 第一版用了 CASE 3（FoldTurn = 0.50）做尺寸审计 —— 而那一档最终动作是
 * **CHECK**，根本没有推荐尺寸，于是断言 1/4 无对象可比而误报 FAIL。
 * 正确做法：取**真的有推荐的尺寸**的那一档（本扫描里是 0.70 / 0.90）。
 */
const c0 = suitables.length > 0 ? suitables[suitables.length - 1]! : CASES[CASES.length - 1]!;
line(`  审计对象 = CASE FoldTurn ${c0.input.toFixed(2)}（最终动作 ${c0.action}，有推荐尺寸的那一档）`);
if (suitables.length === 0) line('  ⚠️ 五档全部 CHECK ⇒ 本轮没有可审计的推荐尺寸');
line(`  Pot = ${f(c0.pot, 2)} 筹码 ｜ 最小下注 = ${f(c0.minBet, 2)} ｜ 全下到 = ${f(c0.allInToAmount, 2)}`);
line(`  合法 BET 网格（buildSizeGrid）= [${c0.gridAmounts.join(', ')}]`);
line('');
line(pad('尺寸档', 14) + pad('requestedAmount', 17) + pad('betAmount(合法)', 17) +
  pad('ratioToPot', 13) + pad('= 底池%', 11) + pad('wasCapped', 11) + 'kind');
line('-'.repeat(96));
for (const kind of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  const s = sizeOf(c0, kind);
  if (s === null) { line(pad(kind, 14) + '（本节点无此档）'); continue; }
  line(
    pad(kind, 14) +
    pad(f(s['requestedAmount'], 4), 17) +
    pad(f(s['betAmount'], 4), 17) +
    pad(f(s['ratioToPot'], 4), 13) +
    pad(pct(s['ratioToPot'], 2), 11) +
    pad(String(s['wasCapped']), 11) +
    String(s['requestedKind']),
  );
}
line('');

const best = c0.bestSize === null ? null : sizeOf(c0, c0.bestSize);
const recChips = c0.sizeChips;
line(`  recommendedSizeChips = ${f(recChips, 2)} ｜ recommendedSizeBB = ${f(c0.sizeBB, 3)} ｜ ` +
  `recommendedRatioToPot = ${recChips === null ? '—' : pct(recChips / c0.pot, 2)}`);
line(`  被选中档（bestSize）= ${String(c0.bestSize)} ｜ 该档 betAmount = ${f(best?.['betAmount'], 4)}` +
  ` ｜ 该档 ratioToPot = ${f(best?.['ratioToPot'], 4)}`);
line('');
const gridDrift = new Set(CASES.map((c) => c.gridAmounts.join(','))).size === 1;
line(`  尺寸网格跨五档是否一致 ⇒ ${gridDrift ? '一致（与统计无关）' : '不一致'}`);
const strictEqual = recChips !== null && best !== null && Math.abs(recChips - (best['betAmount'] as number)) < 1e-9;
const gapChips = recChips === null || best === null ? null : recChips - (best['betAmount'] as number);
const gapPct = gapChips === null ? null : gapChips / c0.pot;
line('');
line(`  断言 1：recommendedSizeChips === 被选中档 betAmount  ⇒ ${strictEqual ? 'PASS' : 'FAIL'}` +
  (gapChips === null ? '' : `（差额 ${f(gapChips, 4)} 筹码 = ${pct(gapPct, 2)} 底池；来源：合法网格取整 round(pot×ratio)）`));
const ratioConsistent = c0.sizes.every((s) =>
  Math.abs((s['betAmount'] as number) / c0.pot - (s['ratioToPot'] as number)) < 1e-9);
line(`  断言 2：betAmount / pot ≈ ratioToPot（逐档）           ⇒ ${ratioConsistent ? 'PASS' : 'FAIL'}`);
const bestRatio = best === null ? null : (best['ratioToPot'] as number);
const labelMatch = bestRatio === null ? false : Math.abs(bestRatio - 1 / 3) < 0.05;
line(`  断言 3：BET_SMALL 的 ratioToPot ≈ 33%（标签口径）      ⇒ ${labelMatch ? 'PASS' : 'FAIL'}（实测 ${pct(bestRatio, 2)}）`);
const recommendedRatioPct = recChips === null ? null : recChips / c0.pot;
const noLabelLeak = recommendedRatioPct === null ? false : recommendedRatioPct > 0.25 && recommendedRatioPct < 0.45;
line(`  断言 4：推荐尺寸没有落到「标签 33% / 实际 ~17%」形态    ⇒ ${noLabelLeak ? 'PASS' : 'FAIL'}` +
  `（实际 ${pct(recommendedRatioPct, 2)}）`);
line('');

/* ---------- C. Directionality ---------- */

line('### C. Directionality');
line('');
const strictlyIncreasing = (xs: readonly (number | null)[]): boolean => {
  for (let i = 1; i < xs.length; i += 1) {
    const a = xs[i - 1], b = xs[i];
    if (a === null || b === null || !(b > a)) return false;
  }
  return true;
};
const nonDecreasing = (xs: readonly (number | null)[], tol = 1e-9): boolean => {
  for (let i = 1; i < xs.length; i += 1) {
    const a = xs[i - 1], b = xs[i];
    if (a === null || b === null || b < a - tol) return false;
  }
  return true;
};
const effMono = strictlyIncreasing(CASES.map((c) => c.effectiveFoldTurn));
const scaleMono = strictlyIncreasing(CASES.map((c) => c.turnFoldScale));
for (const kind of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE']) {
  const xs = CASES.map((c) => sizeOf(c, kind)?.['foldLikelihood'] ?? null) as (number | null)[];
  const evs = CASES.map((c) => sizeOf(c, kind)?.['betEV'] ?? null) as (number | null)[];
  line(`  ${pad(kind, 12)} Fold% 序列 = [${xs.map((x) => pct(x, 2)).join(', ')}]` +
    ` ⇒ 严格单调 ${strictlyIncreasing(xs) ? 'YES' : 'NO'} ｜ 总体单调 ${nonDecreasing(xs, 1e-6) ? 'YES' : 'NO'}`);
  line(`  ${pad('', 12)} BetEV 序列 = [${evs.map((x) => f(x, 3)).join(', ')}]` +
    ` ⇒ 严格单调 ${strictlyIncreasing(evs) ? 'YES' : 'NO'} ｜ 总体单调 ${nonDecreasing(evs, 1e-6) ? 'YES' : 'NO'}`);
}
line('');
line(`  Effective FoldTurn 单调：${effMono ? 'YES（严格）' : 'NO'}`);
line(`  TurnFoldScale     单调：${scaleMono ? 'YES（严格）' : 'NO'}`);
const checkEvs = CASES.map((c) => c.checkEV) as (number | null)[];
line(`  CHECK EV 序列 = [${checkEvs.map((x) => f(x, 3)).join(', ')}]`);
const directionalFail =
  (sizeOf(CASES[0]!, 'BET_SMALL')!['foldLikelihood'] as number) >
  (sizeOf(CASES[4]!, 'BET_SMALL')!['foldLikelihood'] as number);
line('');
line(`  DIRECTIONAL_FAIL 判据（90% 档反而比 10% 档更少弃）⇒ ${directionalFail ? 'DIRECTIONAL_FAIL' : '未触发'}`);
line('');

/* ---------- D. Leverage ---------- */

line('### D. Leverage');
line('');
const first = CASES[0]!, last = CASES[4]!;
const dOf = (kind: string, field: string): number | null => {
  const a = sizeOf(first, kind)?.[field], b = sizeOf(last, kind)?.[field];
  return typeof a === 'number' && typeof b === 'number' ? b - a : null;
};
const smallFoldDelta = dOf('BET_SMALL', 'foldLikelihood');
const medFoldDelta = dOf('BET_MEDIUM', 'foldLikelihood');
const largeFoldDelta = dOf('BET_LARGE', 'foldLikelihood');
const smallEvDelta = dOf('BET_SMALL', 'betEV');
const medEvDelta = dOf('BET_MEDIUM', 'betEV');
const largeEvDelta = dOf('BET_LARGE', 'betEV');
line(`  FoldTurn 输入跨度：10% → 90%（+80pp 输入）`);
line(`  Effective FoldTurn：${f(first.effectiveFoldTurn, 4)} → ${f(last.effectiveFoldTurn, 4)}` +
  `（跨度 ${pp((last.effectiveFoldTurn ?? 0) - (first.effectiveFoldTurn ?? 0))}）`);
line(`  TurnFoldScale：${f(first.turnFoldScale, 4)} → ${f(last.turnFoldScale, 4)}` +
  `（跨度 ${f((last.turnFoldScale ?? 0) - (first.turnFoldScale ?? 0), 4)} = ${pct((last.turnFoldScale ?? 0) / (first.turnFoldScale ?? 1) - 1, 2)}）`);
line('');
line(`  Δ Small Fold：${pp(smallFoldDelta)}`);
line(`  Δ Medium Fold：${pp(medFoldDelta)}`);
line(`  Δ Large Fold：${pp(largeFoldDelta)}`);
line('');
line(`  Δ Small BetEV：${f(smallEvDelta, 3)} 筹码`);
line(`  Δ Medium BetEV：${f(medEvDelta, 3)} 筹码`);
line(`  Δ Large BetEV：${f(largeEvDelta, 3)} 筹码`);
line('');
const maxFoldDeltaPp = Math.max(
  Math.abs(smallFoldDelta ?? 0), Math.abs(medFoldDelta ?? 0), Math.abs(largeFoldDelta ?? 0)) * 100;
const leverageVerdict = maxFoldDeltaPp < 3 ? 'WEAK' : maxFoldDeltaPp > 20 ? 'TOO_STRONG' : 'NORMAL';
line(`  FoldTurn 10%→90% 引起的最大 Fold% 变化 = ${maxFoldDeltaPp.toFixed(2)}pp`);
line(`  STAT_LEVERAGE = ${leverageVerdict}`);
line(`  （判据：< 3pp = WEAK ｜ 3–20pp = NORMAL ｜ > 20pp = TOO_STRONG。` +
  `统计是**众因素之一**，单条统计把最终概率推动 20pp 以上会盖过范围与牌面证据）`);
line('');

/* ---------- E. Isolation ---------- */

line('### E. Isolation（只有 foldToTurnCBet 变化，其余应基本不动）');
line('');
const drift = (xs: readonly (number | null)[]): number => {
  const vals = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return vals.length === 0 ? 0 : Math.max(...vals) - Math.min(...vals);
};
const eqDrift = drift(CASES.map((c) => c.heroEquity));
const checkEvDrift = drift(CASES.map((c) => c.checkEV));
const eqCallDrift = drift(CASES.map((c) => sizeOf(c, 'BET_SMALL')?.['heroEquityVsCallRange'] ?? null));
const eqCallMedDrift = drift(CASES.map((c) => sizeOf(c, 'BET_MEDIUM')?.['heroEquityVsCallRange'] ?? null));
const eqCallLargeDrift = drift(CASES.map((c) => sizeOf(c, 'BET_LARGE')?.['heroEquityVsCallRange'] ?? null));
const crDrift = drift(CASES.map((c) => c.turnCheckRaiseScale));
const betScaleDrift = drift(CASES.map((c) => c.turnBetScale));
const dimDrift = (k: string): number => drift(CASES.map((c) => c.dimensions[k] ?? null));
const supportDrift = drift(CASES.map((c) => c.supportSize));

line(`  Hero Equity drift            = ${pct(eqDrift, 4)}`);
line(`  EqVsCall drift（S/M/L）      = ${pct(eqCallDrift, 4)} / ${pct(eqCallMedDrift, 4)} / ${pct(eqCallLargeDrift, 4)}`);
line(`  CHECK EV drift               = ${f(checkEvDrift, 6)} 筹码`);
line(`  Range supportSize drift      = ${f(supportDrift, 0)} 个组合`);
line(`  TurnCheckRaiseScale drift    = ${f(crDrift, 6)}`);
line(`  TurnBetScale drift           = ${f(betScaleDrift, 6)}`);
line(`  维度 drift：tightness ${f(dimDrift('tightness'), 6)} ｜ aggression ${f(dimDrift('aggression'), 6)} ｜ ` +
  `bluffTendency ${f(dimDrift('bluffTendency'), 6)} ｜ passivity ${f(dimDrift('passivity'), 6)}`);
line('');
const leak = eqDrift > 1e-6 || checkEvDrift > 1e-3 || crDrift > 1e-9 ||
  dimDrift('aggression') > 1e-9 || dimDrift('bluffTendency') > 1e-9;
line(`  「统计污染到不应进入的通道」⇒ ${leak ? '发现漂移（见上）' : '未发现（全部在浮点误差内）'}`);
line('');

/* ---------- 节点路由（验收重点 4） ---------- */

line('### 节点路由（actionContext / allowed / denied）');
line('');
for (const c of [CASES[2]!]) {
  line(`  actionContext = ${String(c.actionContext)}`);
  line(`  deniedStreetTraits = [${c.deniedStreetTraits.join(', ')}]`);
  line(`  三档 fold 统计的路由：`);
  for (const [stat, info] of Object.entries(c.traitRouting)) {
    line(`    ${pad(stat, 18)} 生效值 ${pad(f(info.value, 4), 8)} ｜ 进入模型 ${info.applied ? '是' : '否'}` +
      ` ｜ 被语义门挡下 ${info.denied ? '是' : '否'}`);
  }
  line(`  实测项数 = ${String(c.observedStatCount)}（1500 手 × 机会频率近似 ⇒ opportunities = ${String(c.opportunities)}）`);
}
line('');
const routingOk = CASES.every((c) =>
  c.actionContext === 'FACING_CBET' &&
  c.traitRouting['foldToTurnCBet']?.applied === true &&
  c.traitRouting['foldToFlopCBet']?.applied === false &&
  c.traitRouting['foldToRiverBet']?.applied === false);
line(`  FACING_CBET_ROUTING = ${routingOk ? 'PASS' : 'FAIL'}` +
  '（要求：节点 = FACING_CBET；只放行 foldToTurnCBet；flop / river 两条必须被挡）');
line('');

/* ---------- F. 判定 ---------- */

line('### F. Final Verdict');
line('');
const foldMonoAll = ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE'].every((kind) =>
  nonDecreasing(CASES.map((c) => sizeOf(c, kind)?.['foldLikelihood'] ?? null) as (number | null)[], 1e-6));
const sizeOk = strictEqual || (recommendedRatioPct !== null && recommendedRatioPct > 0.3 && recommendedRatioPct < 0.4);
/** 五档全部 CHECK ⇒ 没有推荐尺寸可审计（N/A，不是 FAIL） */
const noSizeToAudit = suitables.length === 0;
const actions = CASES.map((c) => c.action);
line(`  Final Action 序列 = [${actions.join(', ')}]`);
if (noSizeToAudit) line('  ⚠️ 五档全部 CHECK ⇒ 本轮无推荐尺寸可审计 ⇒ 尺寸映射记 **N/A**');
line('');
const failures: string[] = [];
if (!routingOk) failures.push('路由');
if (!effMono || !scaleMono || !foldMonoAll || directionalFail) failures.push('单调性');
if (leak) failures.push('隔离');
if (!noSizeToAudit && !sizeOk) failures.push('尺寸映射');
const verdict = failures.length === 0
  ? (strictEqual || noSizeToAudit ? 'TEST10B_FOLDTURN_SENSITIVITY — PASS' : 'TEST10B_FOLDTURN_SENSITIVITY — PASS_WITH_WARNINGS')
  : 'TEST10B_FOLDTURN_SENSITIVITY — FAIL';
line(`  ${verdict}${failures.length === 0 ? '' : `（未通过：${failures.join(' / ')}）`}`);
line('');
line(`  FACING_CBET_ROUTING          = ${routingOk ? 'PASS' : 'FAIL'}`);
line(`  FOLDTURN_MONOTONIC           = ${effMono && scaleMono && foldMonoAll && !directionalFail ? 'PASS' : 'FAIL'}`);
line(`  STAT_LEVERAGE_ACCEPTABLE     = ${leverageVerdict === 'NORMAL' ? 'PASS' : `PASS_WITH_WARNINGS(${leverageVerdict})`}`);
line(`  SIZE_MAPPING                 = ${noSizeToAudit ? 'N/A（五档全 CHECK）' : sizeOk ? (strictEqual ? 'PASS' : 'PASS_WITH_ROUNDING_GAP') : 'FAIL'}`);
line(`  SAFE_TO_CONTINUE_HAND_TESTING = ${failures.length === 0 ? 'YES' : 'REVIEW_REQUIRED'}`);
line('');
