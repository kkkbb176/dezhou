/**
 * flriver-gent2-probe2 · READ-ONLY gap-filling probe (Agent 3)
 *
 * A) identifies which sweep configs failed and at which stage
 * B) low-SPR hero-bet node (does the bet model ever evaluate an ALL_IN bet size?)
 * C) multiway (2 opponents) FLOP/RIVER facing-bet node  → anomaly (i) hunt
 * D) TURN hero-bet / facing-bet node (per-street inventory completeness)
 * E) full user-visible viewModel debug rows for river value-bet / bluff-catcher
 * F) overbet node: where does the SIZE_APPROXIMATION disclosure surface?
 * G) hero bet grid: max pot ratio available (100% + ALL_IN only?)
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(),
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: 20_260_913,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A_ = (p: string, t: string, bb?: number, s?: string): Record<string, unknown> => ({
  position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }), ...(s === undefined ? {} : { street: s }),
});
const V_ = (q: string): ManualVillain => ({ quickProfile: q, dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain);
const num = (x: unknown, d = 3): string => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : String(x));
const J = (x: unknown): string => JSON.stringify(x, null, 1);

const base100 = {
  tableSize: 6, heroPosition: 'BTN', effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  environment: 'MID_LOW_STAKES',
} as const;
const base20 = { ...base100, effectiveStackBB: 20, seatStacksBB: { UTG: 20, HJ: 20, CO: 20, BTN: 20, SB: 20, BB: 20 } } as const;

const PRE_BTN = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];
const PRE_3WAY = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'CALL', 1), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2), A_('CO', 'CALL', 2)];

type Case = readonly [string, ManualHandInput];
const cases: Case[] = [];

/* --- B) low SPR 20BB: flop hero-bet node and river hero-bet node --- */
cases.push([
  'B1 20BB 翻牌后位无人下注 AKs（低 SPR ⇒ LARGE 可能被封顶成全下）',
  { ...base20, heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h'], street: 'FLOP', actionHistory: [...PRE_BTN, A_('BB', 'CHECK', undefined, 'FLOP')], villain: V_('NORMAL') } as unknown as ManualHandInput,
]);
cases.push([
  'B2 20BB 河牌后位无人下注 AA（极低 SPR ⇒ 尺寸封顶）',
  { ...base20, heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [...PRE_BTN, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2, 'FLOP'), A_('BB', 'CALL', 2, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 4, 'TURN'), A_('BB', 'CALL', 4, 'TURN'), A_('BB', 'CHECK', undefined, 'RIVER')], villain: V_('NORMAL') } as unknown as ManualHandInput,
]);

/* --- C) multiway FLOP/RIVER facing a bet (anomaly (i) hunt) --- */
cases.push([
  'C1 三人池 翻牌面对 5BB 领打 AKs',
  { ...base100, heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h'], street: 'FLOP', actionHistory: [...PRE_3WAY, A_('BB', 'BET', 5, 'FLOP'), A_('CO', 'CALL', 5, 'FLOP')], villain: V_('NORMAL') } as unknown as ManualHandInput,
]);
cases.push([
  'C2 三人池 翻牌面对 5BB 领打 76s（弱）',
  { ...base100, heroCards: ['7s', '6s'], board: ['Kd', '9c', '4h'], street: 'FLOP', actionHistory: [...PRE_3WAY, A_('BB', 'BET', 5, 'FLOP'), A_('CO', 'CALL', 5, 'FLOP')], villain: V_('NORMAL') } as unknown as ManualHandInput,
]);
cases.push([
  'C3 三人池 河牌面对 10BB 领打 99（中对）',
  { ...base100, heroCards: ['9h', '9c'], board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [...PRE_3WAY, A_('BB', 'CHECK', undefined, 'FLOP'), A_('CO', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('CO', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('CO', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('CO', 'CALL', 10, 'TURN'), A_('BB', 'BET', 20, 'RIVER'), A_('CO', 'CALL', 20, 'RIVER')], villain: V_('NORMAL') } as unknown as ManualHandInput,
]);

/* --- D) TURN nodes --- */
cases.push([
  'D1 转牌后位无人下注 AKs（K94-6）',
  { ...base100, heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s'], street: 'TURN', actionHistory: [...PRE_BTN, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN')], villain: V_('NORMAL') } as unknown as ManualHandInput,
]);
cases.push([
  'D2 转牌面对 10BB 领打 空气 76s（K94-6）',
  { ...base100, heroCards: ['7s', '6s'], board: ['Kd', '9c', '4h', '6s'], street: 'TURN', actionHistory: [...PRE_BTN, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'BET', 10, 'TURN')], villain: V_('NORMAL') } as unknown as ManualHandInput,
]);

/* --- E) user-visible dumps --- */
cases.push([
  'E1 河牌后位对手过牌 AK（薄价值，用于看用户可见文案）',
  { ...base100, heroCards: ['As', 'Ks'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [...PRE_BTN, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'CHECK', undefined, 'RIVER')], villain: V_('NORMAL') } as unknown as ManualHandInput,
]);
cases.push([
  'E2 河牌面对 20BB 领打 QQ（抓诈唬：Q 高）',
  { ...base100, heroCards: ['Qs', 'Qh'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [...PRE_BTN, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'BET', 20, 'RIVER')], villain: V_('NORMAL') } as unknown as ManualHandInput,
]);

/* --- F) overbet: villain bets 1.275× pot --- */
cases.push([
  'F1 河牌面对 120%+ 超池（villain bet 44BB into 69 筹码池）',
  { ...base100, heroCards: ['As', 'Ks'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [...PRE_BTN, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'BET', 44, 'RIVER')], villain: V_('NORMAL') } as unknown as ManualHandInput,
]);

for (const [tag, input] of cases) {
  console.log(`\n${'='.repeat(96)}\n### ${tag}\n${'='.repeat(96)}`);
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { console.log(`  !! FAILED stage=${r.stage}\n${J(r.issues)}`); continue; }
  const d = r.decision as unknown as Record<string, any>;
  const dx = d['diagnostics'] as Record<string, any>;
  const math = dx['math'] as Record<string, any>;
  console.log(`action=${String(d['action'])} size=${num(d['sizeChips'], 3)} conf=${num(d['confidence'])}`);
  console.log(`math: pot=${num(math['pot'])} callCost=${num(math['callCost'])} winnable=${num(math['winnable'])} requiredEquity=${num(math['requiredEquity'])} heroEquity=${num(math['heroEquity'])} callEV=${num(math['callEV'])} heroEquityVsBetRange=${num(math['heroEquityVsBetRange'])} realizedOpponentCount=${num(math['realizedOpponentCount'] ?? math['opponentCount'])}`);
  console.log('reasons:');
  for (const rs of (d['reasons'] as readonly Record<string, any>[]) ?? []) console.log(`  [${String(rs['code'])}] ${String(rs['textZh'])}`);
  const bd = dx['betDecision'] as Record<string, any> | null;
  if (bd !== null && bd !== undefined) {
    console.log(`betDecision: pot=${num(bd['pot'])} checkEV=${num(bd['checkEV'])} checkScore=${num(bd['checkScore'])} bestSize=${String(bd['bestSize'])} bestAmount=${num(bd['bestAmount'])} bestScore=${num(bd['bestScore'])} preferredAction=${String(bd['preferredAction'])}`);
    console.log(`  legalSizes=${J((bd['legalSizes'] as readonly Record<string, any>[]).map((s) => ({ kind: s['kind'], ratio: Number(num(s['ratioToPot'])), amt: Number(num(s['betAmount'])), wasCapped: s['wasCapped'], requestedKind: s['requestedKind'], heroIsAllIn: s['heroIsAllIn'] })))}`);
    console.log(`  sizes EV:`);
    for (const s of (bd['sizes'] as readonly Record<string, any>[]) ?? []) {
      console.log(`   ${String(s['kind'])} amt=${num(s['betAmount'])} r=${num(s['ratioToPot'])} P(f/c/r)=${num(s['foldLikelihood'])}/${num(s['callLikelihood'])}/${num(s['raiseLikelihood'])} evF/C/R=${num(s['evFoldBranch'])}/${num(s['evCallBranch'])}/${num(s['evRaiseBranch'])} betEV=${num(s['betEV'])} dChk=${num(s['deltaVsCheck'])} score=${num(s['score'])} evKind=${String(s['evKind'])}`);
    }
    console.log(`  droppedSizes=${J(bd['droppedSizes'])}`);
    console.log(`  heroEquityVsArrivalRange=${num(bd['heroEquityVsArrivalRange'])}`);
  } else console.log('betDecision = null');
  console.log(`candidates: ${J((dx['candidates'] as readonly Record<string, any>[]).map((c) => ({ a: c['action'], s: c['sizeChips'] === undefined ? null : Number(num(c['sizeChips'], 3)), ev: c['ev'] === null ? null : Number(num(c['ev'], 3)), note: String(c['noteZh']).slice(0, 40) })))}`);
  console.log(`actionEvidence: ${J(dx['actionEvidence'])}`);
  console.log(`decisionSource: ${J(dx['decisionSource'])}`);
  console.log(`decisionMargin: ${J(dx['decisionMargin'])}`);
  console.log(`unevaluatedActions: ${J((dx['unevaluatedActions'] as readonly Record<string, any>[]).map((u) => ({ a: u['action'], s: u['sizeChips'], c: u['reasonCode'] })))}`);
  console.log(`conditionalEquities: ${J(dx['conditionalEquities'])}`);
  console.log(`consistency: ${J(dx['consistency'])}`);
  const pf = dx['postflop'] as Record<string, any> | undefined;
  if (pf !== undefined) {
    console.log(`postflop.blockers=${J(pf['blockers'])}`);
    console.log(`postflop.valueAssessment=${J(pf['valueAssessment'])}`);
    console.log(`postflop.rangeCounts=${J(pf['rangeCounts'])}`);
    console.log(`postflop.evRanking=${J(pf['evRanking'])}`);
    console.log(`postflop.trueEvRanking=${J(pf['trueEvRanking'])}`);
    console.log(`postflop.betRangeArrival=${J(pf['betRangeArrival'])}`);
    console.log(`postflop.bettingRangeFacts=${J(pf['bettingRangeFacts'])}`);
    console.log(`postflop.raiseResponse(noteZh only) = ${String((pf['raiseResponse'] ?? {})['noteZh'] ?? '—')}`);
  }
}
console.log('\nDONE flriver-gent2-probe2');
