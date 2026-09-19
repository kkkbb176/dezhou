/**
 * Reviewer 4 · probe 3 — 质量守恒（`profileClassMasses`，黄金夹具 03A / 03B）
 *
 * 只读生产路径（`analyzeManualHand` / `buildDecisionContext`）。
 * 运行：node --experimental-strip-types scripts/v21-rev4-masses.ts
 */
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { riverComboClassOf } from '../src/domain/postflop/riverProfileClassify.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import type { Card } from '../src/domain/types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEATS = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };

const HISTORY = [
  { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' }, { position: 'UTG2', type: 'FOLD' },
  { position: 'LJ', type: 'FOLD' }, { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 }, { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 1.5 },
  { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'TURN' }, { position: 'CO', type: 'CHECK', street: 'TURN' },
  { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
] as const;

function hand(quickProfile: string): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'CO', heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS },
    actionHistory: [...HISTORY], environment: 'MID_LOW_STAKES',
    villain: { quickProfile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

const HEX = (x: number): string => (Number.isFinite(x) ? x.toPrecision(17) : String(x));

type Masses = Record<string, number> & {
  totalMass: number; reachableRangeCount: number; unclassifiedMassShare: number;
  nutValueMass: number; strongValueMass: number; thinValueMass: number; showdownMass: number;
  missedFlushMass: number; missedStraightMass: number; missedComboMass: number; pureAirMass: number;
  valueMass: number; missedDrawMass: number; bluffMass: number;
};

for (const profile of ['CALLING_STATION', 'MANIAC', 'NORMAL', 'UNKNOWN']) {
  console.log(`\n################ 画像 = ${profile} ################`);
  const parsed = parseManualInput(hand(profile));
  if (!parsed.ok) { console.log('  解析失败', parsed.issues); continue; }
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) { console.log('  重建失败', gate.issues); continue; }
  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000, quickProfile: profile as never,
  });

  const entries = built.context.range?.entries ?? [];
  const snap = built.context.range as unknown as
    | { metrics?: { supportSize?: number; totalEntries?: number; probabilitySum?: number; entropy?: number }; collapsed?: boolean }
    | undefined;
  const facts = built.context.postflopFacts?.opponentRangeFacts as unknown as
    | { profileClassMasses?: Masses; supportSize?: number; strongShare?: number; weakerShare?: number; strongerShare?: number; equalShare?: number; counts?: Record<string, number> }
    | undefined;
  const prev = built.context.profileRangeEvidence as unknown as
    | { combosBefore?: number; combosAfter?: number; equityBefore?: number | null; equityAfter?: number | null }
    | undefined;
  const m = facts?.profileClassMasses;

  /* ---- (b) Σ entries.probability = metrics.probabilitySum ---- */
  let sumAll = 0; let sumPositive = 0; let nonPositive = 0; let nonFinite = 0;
  for (const e of entries) {
    const p = e.probability;
    if (!Number.isFinite(p)) nonFinite++;
    sumAll += p;
    if (p > 0) sumPositive += p; else nonPositive++;
  }
  const ps = snap?.metrics?.probabilitySum ?? null;
  console.log(`  (b) range.entries = ${entries.length}（快照 metrics.totalEntries=${String(snap?.metrics?.totalEntries)}）`);
  console.log(`      metrics.probabilitySum = ${ps === null ? '—' : HEX(ps)}（Δ vs 1 = ${ps === null ? '—' : HEX(ps - 1)}）`);
  console.log(`      经快照 entries 求和 Σp = ${HEX(sumAll)}（Δ vs 1 = ${HEX(sumAll - 1)}）`);
  console.log(`      range.metrics.supportSize = ${String(snap?.metrics?.supportSize)}；facts.supportSize = ${String(facts?.supportSize)}；collapsed=${String(snap?.collapsed)}`);
  console.log(`      p<=0 条目数 = ${nonPositive}；非有限 p = ${nonFinite}`);
  console.log(`      profileRangeEvidence: combosBefore=${String(prev?.combosBefore)} combosAfter=${String(prev?.combosAfter)} 相等=${prev?.combosBefore === prev?.combosAfter ? 'Y' : 'N'}`);
  console.log(`      equityBefore=${String(prev?.equityBefore)} equityAfter=${String(prev?.equityAfter)}`);

  if (m === undefined) { console.log('  profileClassMasses = null（范围坍塌或 total=0）'); continue; }

  /* ---- (a) 类别质量 + unclassified ≡ reachable 总质量 ---- */
  const byClass = {
    NUT_VALUE: m.nutValueMass, STRONG_VALUE: m.strongValueMass, THIN_VALUE: m.thinValueMass,
    SHOWDOWN_VALUE: m.showdownMass, MISSED_FLUSH_DRAW: m.missedFlushMass,
    MISSED_STRAIGHT_DRAW: m.missedStraightMass, MISSED_COMBO_DRAW: m.missedComboMass,
    PURE_AIR: m.pureAirMass,
  };
  let classSum = 0;
  for (const v of Object.values(byClass)) classSum += v;
  const unclassified = m.unclassifiedMassShare * m.totalMass;
  console.log(`  (a) m.totalMass = ${HEX(m.totalMass)}；reachableRangeCount = ${m.reachableRangeCount}`);
  console.log(`      Σ 8 类质量 = ${HEX(classSum)}`);
  console.log(`      unclassifiedMassShare = ${HEX(m.unclassifiedMassShare)} ⇒ unclassifiedMass = ${HEX(unclassified)}`);
  console.log(`      Σ类 + unclassified = ${HEX(classSum + unclassified)}`);
  console.log(`      Δ(Σ类+unclassified − totalMass) = ${HEX(classSum + unclassified - m.totalMass)}  ⇒ 守恒=${classSum + unclassified === m.totalMass ? 'Y（逐位）' : 'N'}`);
  console.log(`      独立重算：Σ_{entries, p>0, 不与 Hero/公共牌重叠} p = ${HEX(sumPositive)}`);
  console.log(`      Δ(totalMass − Σ entries p>0) = ${HEX(m.totalMass - sumPositive)}`);

  /* ---- (c) bluffMass === missedDrawMass + pureAirMass ---- */
  const md = m.missedFlushMass + m.missedStraightMass + m.missedComboMass;
  console.log(`  (c) missedDrawMass（字段）= ${HEX(m.missedDrawMass)}；missedFlush+Straight+Combo = ${HEX(md)}；Δ=${HEX(m.missedDrawMass - md)} ⇒ ${m.missedDrawMass === md ? 'Y（逐位）' : 'N'}`);
  console.log(`      missedDrawMass + pureAirMass = ${HEX(m.missedDrawMass + m.pureAirMass)}；bluffMass（字段）= ${HEX(m.bluffMass)}；Δ=${HEX(m.bluffMass - (m.missedDrawMass + m.pureAirMass))} ⇒ ${m.bluffMass === m.missedDrawMass + m.pureAirMass ? 'Y（逐位）' : 'N'}`);

  /* ---- (d) valueMass === nut + strong + thin ---- */
  const vs = m.nutValueMass + m.strongValueMass + m.thinValueMass;
  console.log(`  (d) valueMass（字段）= ${HEX(m.valueMass)}；nut+strong+thin = ${HEX(vs)}；Δ=${HEX(m.valueMass - vs)} ⇒ ${m.valueMass === vs ? 'Y（逐位）' : 'N'}`);

  /* ---- 切分是否真的完备：独立按 riverComboClassOf 重算一遍 ---- */
  const hero = ['Ac', 'Jh'] as unknown as readonly Card[];
  const board = ['Ad', '8s', '4s', '2c', 'Kd'] as unknown as readonly Card[];
  const heroSet = new Set(['Ac', 'Jh']); const boardSet = new Set(['Ad', '8s', '4s', '2c', 'Kd']);
  const ALL = [] as Card[];
  for (const r of [2,3,4,5,6,7,8,9,10,11,12,13,14]) for (const s of ['s','h','d','c'] as const) {
    ALL.push({ rank: r, suit: s } as unknown as Card);
  }
  const CS = { s: 's', h: 'h', d: 'd', c: 'c' } as const;
  const cardStr = (c: Card): string => `${({2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'T',11:'J',12:'Q',13:'K',14:'A'} as Record<number,string>)[c.rank]!}${c.suit}`;
  const recount: Record<string, number> = {};
  let hitNull = 0; let overlap = 0; let total2 = 0;
  const bucketOf: Record<string, Set<number>> = {};
  for (const e of entries) {
    if (!(e.probability > 0)) continue;
    const c0 = ALL[e.combo.cardIndices[0]!]!; const c1 = ALL[e.combo.cardIndices[1]!]!;
    const holes = [c0, c1] as [Card, Card];
    if (holes.some((c) => heroSet.has(cardStr(c)) || boardSet.has(cardStr(c)))) { overlap++; continue; }
    const cls = riverComboClassOf({ hole: holes, board, heroHole: hero });
    if (cls === null) { hitNull++; continue; }
    recount[cls.category] = (recount[cls.category] ?? 0) + e.probability;
    (bucketOf[cls.category] ??= new Set()).add(cls.strengthBucket);
    total2 += e.probability;
  }
  console.log(`  (a') 独立重算：与 Hero/公共牌重叠条目 = ${overlap}；分类返回 null = ${hitNull}；Σ 重算 = ${HEX(total2)}`);
  for (const k of Object.keys(byClass)) {
    const a = byClass[k as keyof typeof byClass]; const b = recount[k] ?? 0;
    console.log(`      ${k.padEnd(21)} 字段=${HEX(a)} 重算=${HEX(b)} Δ=${HEX(a - b)} ${a === b ? '✓逐位' : '✗'}`);
  }
  console.log(`      unclassifiedMassShare 是否非零：${m.unclassifiedMassShare !== 0 ? `是（${HEX(m.unclassifiedMassShare)}）` : '否（0）'} ⇒ 与「分类返回 null = ' + hitNull + '」一致=${(hitNull === 0) === (m.unclassifiedMassShare === 0) ? 'Y' : 'N'}`);
  console.log(`      可达类别的 (category → strengthBucket) 实测：${Object.entries(bucketOf).map(([k, v]) => `${k}:{${[...v].sort().join(',')}}`).join(' ')}`);

  /* ---- 其它份额字段的守恒 ---- */
  const shares = (facts?.weakShareOfHero ?? null) as number | null;
  void shares;
  const sw = facts?.strongerShare ?? 0; const eqq = facts?.equalShare ?? 0; const wk = facts?.weakerShare ?? 0;
  console.log(`  (e) strongerShare=${HEX(sw)} equalShare=${HEX(eqq)} weakerShare=${HEX(wk)} Σ=${HEX(sw + eqq + wk)}（应=1，但只覆盖 p>0 且可达的条目）`);
  console.log(`      strongShare=${HEX(facts?.strongShare ?? 0)}`);

  /* ---- updateTrace：supportBefore / supportAfter ---- */
  const trace = (built.context.range?.updateTrace ?? []) as unknown as
    readonly { street?: string; action?: string; noteZh?: string; supportBefore?: number; supportAfter?: number; entropyBefore?: number; entropyAfter?: number }[];
  console.log(`  (f) updateTrace 步数 = ${trace.length}`);
  for (const t of trace) {
    console.log(`      ${String(t.street).padEnd(6)} ${String(t.action).padEnd(10)} support ${String(t.supportBefore)} → ${String(t.supportAfter)}  H ${String(t.entropyBefore)} → ${String(t.entropyAfter)}`);
    if (t.noteZh !== undefined && t.noteZh !== '') console.log(`          noteZh=${t.noteZh}`);
  }
}
