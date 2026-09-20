/**
 * flriver-gent2-probe4 · READ-ONLY (Agent 3): OOP check-tree nodes + TURN nodes + per-street inventory
 *
 * Fixes the RIVER-OOP history used by the sweep (which failed with
 * HISTORY_DOES_NOT_REACH_STREET) and adds:
 *   - FLOP/TURN/RIVER OOP hero-check nodes (checkTree = HEURISTIC_TREE / SHOWDOWN_TERMINAL)
 *   - anomaly predicates (i)/(ii)/(iii) at those nodes
 *   - the per-street / per-action EV inventory (which EV quantity exists where)
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(),
  asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const A_ = (p: string, t: string, bb?: number, s?: string): Record<string, unknown> => ({
  position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }), ...(s === undefined ? {} : { street: s }),
});
const V_ = (q: string): ManualVillain => ({ quickProfile: q, dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain);
const num = (x: unknown, d = 3): string => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : String(x));
const J = (x: unknown): string => JSON.stringify(x, null, 1);
const base = {
  tableSize: 6, effectiveStackBB: 100, bigBlindBB: 2, heroPosition: 'BB',
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  environment: 'MID_LOW_STAKES',
} as const;
const PRE = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];
/** hero = BB; BTN c-bet flop + turn, hero calls both → hero acts first on the river */
const TO_RIVER_OOP = [...PRE,
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
  A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN')];
/** hero = BB; BTN c-bets flop only, checks back turn → hero acts first on the river, villain still to act */
const TO_RIVER_OOP2 = [...PRE,
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
  A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'CHECK', undefined, 'TURN')];
/** hero = BB, villain checked back the flop → hero acts first on the turn */
const TO_TURN_OOP = [...PRE, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'CHECK', undefined, 'FLOP')];
/** hero = BB, flop checked through, turn bet/call → hero acts first on the river */
const TO_RIVER_OOP3 = [...PRE,
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'CHECK', undefined, 'FLOP'),
  A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN')];

type Case = readonly [string, ManualHandInput];
const cases: Case[] = [];
const HANDS: ReadonlyArray<readonly [string, readonly [string, string]]> = [
  ['AKs', ['As', 'Ks']], ['AA', ['As', 'Ah']], ['99', ['9h', '9c']], ['QJs', ['Qs', 'Js']], ['72o', ['7h', '2d']],
];
for (const [hn, hc] of HANDS) {
  cases.push([`OOP1 RIVER(前位过牌树) ${hn}`, { ...base, heroCards: [...hc], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: TO_RIVER_OOP, villain: V_('NORMAL') } as unknown as ManualHandInput]);
  cases.push([`OOP2 RIVER(他转牌过牌) ${hn}`, { ...base, heroCards: [...hc], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: TO_RIVER_OOP2, villain: V_('NORMAL') } as unknown as ManualHandInput]);
  cases.push([`OOP3 RIVER(翻牌过牌后) ${hn}`, { ...base, heroCards: [...hc], board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: TO_RIVER_OOP3, villain: V_('NORMAL') } as unknown as ManualHandInput]);
  cases.push([`OOP4 TURN(前位过牌树) ${hn}`, { ...base, heroCards: [...hc], board: ['Kd', '9c', '4h', '6s'], street: 'TURN', actionHistory: TO_TURN_OOP, villain: V_('NORMAL') } as unknown as ManualHandInput]);
}

const hits: string[] = [];
console.log('tag | action | size | callEV | checkEV/kind | perSizeEV | best | check | FOLD-with-pos-CALL?');
for (const [tag, input] of cases) {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { console.log(`${tag} | FAILED ${r.stage} ${(r.issues as readonly Record<string, unknown>[]).map((x) => String(x['code'])).join(',')}`); continue; }
  const d = r.decision as unknown as Record<string, any>;
  const dx = d['diagnostics'] as Record<string, any>;
  const math = dx['math'] as Record<string, any>;
  const bd = dx['betDecision'] as Record<string, any> | null;
  const action = String(d['action']);
  const tree = (bd?.['checkTree'] ?? null) as Record<string, any> | null;
  const sizes = ((bd?.['sizes'] ?? []) as readonly Record<string, any>[]).map((s) => `${String(s['kind']).replace('BET_', '')}:${num(s['betEV'], 2)}`);
  const ev = (dx['actionEvidence'] as readonly Record<string, any>[]) ?? [];
  const callEv = ev.find((e) => e['action'] === 'CALL');
  const raiseEv = ev.find((e) => e['action'] === 'RAISE');
  console.log(
    `${tag} | ${action} | ${num(d['sizeChips'], 2)} | ${num(math['callEV'])} | ${num(bd?.['checkEV'])}/${String(tree?.['kind'] ?? '-')} | [${sizes.join(',')}] | ` +
    `${num(bd?.['bestScore'])}/${bd?.['bestSize'] === null ? '-' : String(bd?.['bestSize'])} | ${num(bd?.['checkScore'])} | ` +
    `callEvSrc=${callEv === undefined ? '-' : String(callEv['estimateType']) + '/' + num(callEv['ev'], 2)} raiseEvSrc=${raiseEv === undefined ? '-' : String(raiseEv['estimateType']) + '/' + num(raiseEv['ev'], 2)}`,
  );
  /* anomaly predicates */
  if (action === 'FOLD') {
    const pos: string[] = [];
    if (typeof math['callEV'] === 'number' && math['callEV'] > 0) pos.push(`math.callEV=${num(math['callEV'])}`);
    if (callEv && typeof callEv['ev'] === 'number' && callEv['ev'] > 0) pos.push(`evidenceCALL=${num(callEv['ev'])}`);
    if (pos.length > 0) hits.push(`[ANOM-i] ${tag}: FOLD with positive CALL EV → ${pos.join(' ; ')} | ${J(d['reasons'])}`);
  }
  if ((action === 'BET' || action === 'ALL_IN') && bd !== null && bd['checkEV'] !== null) {
    const vals = ((bd['sizes'] ?? []) as readonly Record<string, any>[]).filter((s) => s['betEV'] !== null).map((s) => s['betEV'] as number);
    const maxBet = vals.length === 0 ? null : Math.max(...vals);
    if (maxBet !== null && maxBet < (bd['checkEV'] as number)) hits.push(`[ANOM-ii] ${tag}: BET with CHECK higher (checkEV=${num(bd['checkEV'])} maxBetEV=${num(maxBet)})`);
    if (bd['bestScore'] <= bd['checkScore']) hits.push(`[ANOM-ii-score] ${tag}: bestScore ${num(bd['bestScore'])} <= checkScore ${num(bd['checkScore'])} while action=${action}`);
  }
  if (action === 'CHECK' && bd !== null && bd['checkEV'] !== null) {
    const vals = ((bd['sizes'] ?? []) as readonly Record<string, any>[]).filter((s) => s['betEV'] !== null).map((s) => s['betEV'] as number);
    const maxBet = vals.length === 0 ? null : Math.max(...vals);
    if (bd['bestScore'] > bd['checkScore'] || (maxBet !== null && maxBet > (bd['checkEV'] as number))) hits.push(`[ANOM-iiR] ${tag}: CHECK while bet higher (checkEV=${num(bd['checkEV'])} maxBetEV=${num(maxBet)} bestScore=${num(bd['bestScore'])})`);
  }
  if ((action === 'RAISE' || action === 'ALL_IN') && (raiseEv === undefined || raiseEv['ev'] === null)) {
    hits.push(`[ANOM-iii] ${tag}: RAISE-like action with no RAISE EV → ${J(d['reasons'])}`);
  }
  const viol = (dx['consistency']?.['violations'] ?? []) as readonly unknown[];
  if (viol.length > 0) hits.push(`[CONSISTENCY] ${tag}: ${J(viol)}`);
  /* check-tree detail for the OOP nodes */
  if (tree !== null) {
    console.log(
      `    tree: kind=${String(tree['kind'])} pCheckBack=${num(tree['checkBackLikelihood'])} pBet=${num(tree['betLikelihood'])} betAmt=${num(tree['villainBetAmount'])} ` +
      `eqCheckBack=${num(tree['heroEquityVsCheckBackRange'])} evShowdown=${num(tree['evShowdown'])} eqVsBet=${num(tree['heroEquityVsBetRange'])} heroCallEV=${num(tree['heroCallEV'])} ` +
      `heroFoldEV=${num(tree['heroFoldEV'])} bestResp=${num(tree['heroBestResponseEV'])} raiseResp=${String(tree['raiseResponse'])} checkEV=${num(tree['checkEV'])}`,
    );
    console.log(`    tree.noteZh=${String(tree['noteZh'])}`);
  }
}
console.log('\n===== HITS =====');
if (hits.length === 0) console.log('NO HITS');
for (const h of hits) console.log(`\n${h}`);

/* ============ per-street / per-action EV inventory ============ */
console.log('\n===== PER-STREET EV INVENTORY =====');
const invCases: Case[] = [
  ['FLOP-无下注(后位)', { ...base, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h'], street: 'FLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2), A_('BB', 'CHECK', undefined, 'FLOP')], villain: V_('NORMAL') } as unknown as ManualHandInput],
  ['FLOP-面对下注', { ...base, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h'], street: 'FLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2), A_('BB', 'BET', 5, 'FLOP')], villain: V_('NORMAL') } as unknown as ManualHandInput],
  ['TURN-无下注(后位)', { ...base, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s'], street: 'TURN', actionHistory: [...PRE.slice(0, 0), A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2), A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN')], villain: V_('NORMAL') } as unknown as ManualHandInput],
  ['RIVER-无下注(后位)', { ...base, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2), A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'CHECK', undefined, 'RIVER')], villain: V_('NORMAL') } as unknown as ManualHandInput],
  ['RIVER-面对下注', { ...base, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2), A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'BET', 10, 'RIVER')], villain: V_('NORMAL') } as unknown as ManualHandInput],
];
for (const [tag, input] of invCases) {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { console.log(`${tag}: FAILED ${r.stage}`); continue; }
  const d = r.decision as unknown as Record<string, any>;
  const dx = d['diagnostics'] as Record<string, any>;
  const math = dx['math'] as Record<string, any>;
  const ev = (dx['actionEvidence'] as readonly Record<string, any>[]) ?? [];
  const bd = dx['betDecision'] as Record<string, any> | null;
  console.log(`\n--- ${tag} → action=${String(d['action'])} size=${num(d['sizeChips'], 2)} ---`);
  console.log(`  FOLD: actionEvidence=${ev.some((e) => e['action'] === 'FOLD') ? ev.find((e) => e['action'] === 'FOLD')!['estimateType'] + ' ev=' + num(ev.find((e) => e['action'] === 'FOLD')!['ev']) : 'ABSENT'} | candidates FOLD ev=${num(((dx['candidates'] as readonly Record<string, any>[]).find((c) => c['action'] === 'FOLD') ?? {})['ev'])}`);
  const callRow = ev.find((e) => e['action'] === 'CALL');
  console.log(`  CALL: math.callEV=${num(math['callEV'])} | evidence=${callRow === undefined ? 'ABSENT' : callRow['estimateType'] + ' ev=' + num(callRow['ev'])} | candidates=${num(((dx['candidates'] as readonly Record<string, any>[]).find((c) => c['action'] === 'CALL') ?? {})['ev'])}`);
  const checkTree = bd?.['checkTree'] ?? null;
  console.log(`  CHECK: betDecision.checkEV=${num(bd?.['checkEV'])} | checkTree.kind=${String(checkTree?.['kind'] ?? 'NONE')} checkTree.checkEV=${num(checkTree?.['checkEV'])} raiseResponse=${String(checkTree?.['raiseResponse'] ?? '-')} | candidates CHECK ev=${num(((dx['candidates'] as readonly Record<string, any>[]).find((c) => c['action'] === 'CHECK') ?? {})['ev'])}`);
  console.log(`  BET: betDecision.sizes=[${((bd?.['sizes'] ?? []) as readonly Record<string, any>[]).map((s) => `${String(s['kind'])}/${num(s['betAmount'], 1)}/ev=${num(s['betEV'], 2)}/score=${num(s['score'])})`).join(' ')}] candidates BET ev=null? ${((dx['candidates'] as readonly Record<string, any>[]).filter((c) => c['action'] === 'BET').every((c) => c['ev'] === null))}`);
  const raiseRow = ev.find((e) => e['action'] === 'RAISE');
  console.log(`  RAISE: evidence=${raiseRow === undefined ? 'ABSENT' : raiseRow['estimateType'] + ' ev=' + (raiseRow['ev'] === null ? 'null' : num(raiseRow['ev'], 2))} | ownEVsizes=${J(dx['allInGuard']?.['raiseSizesWithOwnEV'])} raiseCont=${String(dx['conditionalEquities']?.['raiseContinueRange'])}`);
  const allInCand = (dx['candidates'] as readonly Record<string, any>[]).find((c) => c['action'] === 'ALL_IN');
  console.log(`  ALL_IN: candidate=${allInCand === undefined ? 'ABSENT' : 'size=' + num(allInCand['sizeChips']) + ' ev=' + String(allInCand['ev'])} | unevaluated=${J(((dx['unevaluatedActions'] as readonly Record<string, any>[]).filter((u) => u['action'] === 'ALL_IN')))}`);
  console.log(`  unevaluated count=${(dx['unevaluatedActions'] as readonly unknown[]).length} decisionMargin=${J(dx['decisionMargin']?.['kind'])}/${J(dx['decisionMargin']?.['scope'])}/${num(dx['decisionMargin']?.['evChips'])}`);
}
console.log('\nDONE flriver-gent2-probe4');
