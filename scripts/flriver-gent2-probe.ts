/**
 * flriver-gent2-probe · READ-ONLY audit probe (Agent 3: mathematical basis of betting decisions)
 *
 * Dumps raw EV-bearing diagnostics for FLOP and RIVER decision nodes:
 *   decision.action / sizeChips / reasons
 *   diagnostics.betDecision (checkEV / checkScore / bestScore / per-size betEV)
 *   diagnostics.actionEvidence, unevaluatedActions, conditionalEquities,
 *   decisionSource, decisionMargin, actionShape, allInGuard
 *   diagnostics.postflop.betRangeArrival / bettingRangeFacts (sizeApproximation etc.)
 *
 * Writes NOTHING except stdout. No production file is touched.
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

const base = {
  tableSize: 6,
  heroPosition: 'BTN',
  effectiveStackBB: 100,
  bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  environment: 'MID_LOW_STAKES',
} as const;

const V_ = (q: string): ManualVillain =>
  ({ quickProfile: q, dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain);

/** PREFLOP standard: BTN raise 3, BB call. */
const PF = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];

const preflopToFlopBtnBet = (flopBet: number, flopCall: number) => [
  ...PF,
  A_('BB', 'CHECK', undefined, 'FLOP'),
  A_('BTN', 'BET', flopBet, 'FLOP'),
  A_('BB', 'CALL', flopCall, 'FLOP'),
];

const j = (x: unknown): string => JSON.stringify(x, null, 1);

function num(x: unknown, d = 3): string {
  return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : String(x);
}

type Case = readonly [string, ManualHandInput];

const cases: readonly Case[] = [
  /* ---------- FLOP: hero IP, villain checked (BET/CHECK node) ---------- */
  [
    'FLOP-A 翻牌后位无人下注 AKs on K94（顶对顶踢）',
    { ...base, heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h'], street: 'FLOP', actionHistory: [...PF, A_('BB', 'CHECK', undefined, 'FLOP')], villain: V_('NORMAL') } as unknown as ManualHandInput,
  ],
  [
    'FLOP-B 翻牌后位无人下注 空气 76s on K94',
    { ...base, heroCards: ['7s', '6s'], board: ['Kd', '9c', '4h'], street: 'FLOP', actionHistory: [...PF, A_('BB', 'CHECK', undefined, 'FLOP')], villain: V_('NORMAL') } as unknown as ManualHandInput,
  ],
  /* ---------- FLOP: hero faces a bet (CALL/FOLD/RAISE node) ---------- */
  [
    'FLOP-C 翻牌面对 5BB 领打 AKs TPTK',
    { ...base, heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h'], street: 'FLOP', actionHistory: [...PF, A_('BB', 'BET', 5, 'FLOP')], villain: V_('NORMAL') } as unknown as ManualHandInput,
  ],
  /* ---------- FLOP: hero OOP checks first (villain to act) ---------- */
  [
    'FLOP-D 翻牌前位（BB）AKs 先过牌',
    { ...base, heroPosition: 'BB', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h'], street: 'FLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)], villain: V_('NORMAL') } as unknown as ManualHandInput,
  ],
  /* ---------- RIVER: hero IP facing a villain bet ---------- */
  [
    'RIVER-A 河牌面对 10BB 领打 AA（顶暗三）',
    { ...base, heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [...PF, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'BET', 10, 'RIVER')], villain: V_('NORMAL') } as unknown as ManualHandInput,
  ],
  /* ---------- RIVER: hero IP, villain checked (CHECK/BET node) ---------- */
  [
    'RIVER-B 河牌后位对手过牌 AK（河牌 A 高不成对）',
    { ...base, heroCards: ['As', 'Ks'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [...PF, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'CHECK', undefined, 'RIVER')], villain: V_('NORMAL') } as unknown as ManualHandInput,
  ],
  /* ---------- RIVER: hero OOP checks first ---------- */
  [
    'RIVER-C 河牌前位（BB）AA 先过牌',
    { ...base, heroPosition: 'BB', heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2), A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN')], villain: V_('NORMAL') } as unknown as ManualHandInput,
  ],
  /* ---------- RIVER overbet node: villain bets 120% pot ---------- */
  [
    'RIVER-D 河牌面对 ~120% 超池（pot 36.5 ⇒ bet 44）AK 抓诈',
    { ...base, heroCards: ['As', 'Ks'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [...PF, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'BET', 44, 'RIVER')], villain: V_('NORMAL') } as unknown as ManualHandInput,
  ],
];

for (const [tag, input] of cases) {
  console.log(`\n${'='.repeat(100)}\n### ${tag}\n${'='.repeat(100)}`);
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) {
    console.log(`  !! FAILED stage=${r.stage}\n${j(r.issues)}`);
    continue;
  }
  const d = r.decision as unknown as Record<string, any>;
  const dx = d['diagnostics'] as Record<string, any>;
  const math = dx['math'] as Record<string, any>;

  console.log(`action=${String(d['action'])} sizeChips=${String(d['sizeChips'])} sizeBB=${num(d['sizeBB'])} confidence=${num(d['confidence'])}`);
  console.log(`--- reasons ---`);
  for (const rs of (d['reasons'] as readonly Record<string, any>[]) ?? []) {
    console.log(`  [${String(rs['code'])}] ${String(rs['textZh'])}`);
    if (rs['data'] !== undefined) console.log(`        data=${JSON.stringify(rs['data'])}`);
  }
  console.log(`--- math (EV core) ---`);
  console.log(`  pot=${num(math['pot'])} callCost=${num(math['callCost'])} requiredEquity=${num(math['requiredEquity'])} heroEquity=${num(math['heroEquity'])}`);
  console.log(`  callEV=${num(math['callEV'])} foldEV=${num(math['foldEV'])} winnable=${num(math['winnable'])} spr=${num(math['spr'])}`);
  console.log(`  heroEquityVsBetRange=${num(math['heroEquityVsBetRange'])} layeredEV=${JSON.stringify(math['layeredEV'])}`);
  console.log(`  handCategory=${String(math['handCategory'])} street=${String(math['street'])}`);

  console.log(`--- diagnostics.candidates ---`);
  for (const c of (dx['candidates'] as readonly Record<string, any>[]) ?? []) {
    console.log(`  ${String(c['action'])} size=${num(c['sizeChips'], 3)} ev=${c['ev'] === null ? 'null' : num(c['ev'])} feasible=${String(c['mathFeasible'])} note=${String(c['noteZh'] ?? '')}`);
  }
  console.log(`--- diagnostics.actionEvidence ---`);
  for (const e of (dx['actionEvidence'] as readonly Record<string, any>[]) ?? []) {
    console.log(`  ${j(e)}`);
  }
  console.log(`--- diagnostics.decisionSource ---`);
  console.log(`  ${j(dx['decisionSource'])}`);
  console.log(`--- diagnostics.decisionMargin ---`);
  console.log(`  ${j(dx['decisionMargin'])}`);
  console.log(`--- diagnostics.unevaluatedActions ---`);
  for (const u of (dx['unevaluatedActions'] as readonly Record<string, any>[]) ?? []) console.log(`  ${j(u)}`);
  console.log(`--- diagnostics.conditionalEquities ---`);
  console.log(`  ${j(dx['conditionalEquities'])}`);
  console.log(`--- diagnostics.actionShape / allInGuard ---`);
  console.log(`  shape=${j(dx['actionShape'])}`);
  console.log(`  guard=${j(dx['allInGuard'])}`);

  const bd = dx['betDecision'] as Record<string, any> | null;
  if (bd !== null && bd !== undefined) {
    console.log(`--- diagnostics.betDecision ---`);
    console.log(`  pot=${num(bd['pot'])} checkEV=${num(bd['checkEV'])} checkScore=${num(bd['checkScore'])} bestSize=${String(bd['bestSize'])} bestAmount=${num(bd['bestAmount'])} bestScore=${num(bd['bestScore'])} preferredAction=${String(bd['preferredAction'])}`);
    console.log(`  evKind=${String(bd['betEvKind'])} modelNoteZh=${String(bd['modelNoteZh'])}`);
    console.log(`  checkTree=${j(bd['checkTree'])}`);
    console.log(`  realization=${j(bd['realization'])} checkRealizationFactor=${num(bd['checkRealizationFactor'])}`);
    console.log(`  sizes:`);
    for (const s of (bd['sizes'] as readonly Record<string, any>[]) ?? []) {
      console.log(
        `   kind=${String(s['kind'])} ratioToPot=${num(s['ratioToPot'])} betAmount=${num(s['betAmount'])} ` +
        `P(fold)=${num(s['foldLikelihood'])} P(call)=${num(s['callLikelihood'])} P(raise)=${num(s['raiseLikelihood'])} ` +
        `eqCall=${num(s['heroEquityVsCallRange'])} eqRaise=${num(s['heroEquityVsRaiseRange'])} ` +
        `evFold=${num(s['evFoldBranch'])} evCall=${num(s['evCallBranch'])} evRaise=${num(s['evRaiseBranch'])} ` +
        `evRaiseFoldLB=${num(s['evRaiseFoldLowerBound'])} betEV=${num(s['betEV'])} dVsCheck=${num(s['deltaVsCheck'])} score=${num(s['score'])} evKind=${String(s['evKind'])}`,
      );
      console.log(`        evidence=${j(s['evidence'])} note=${String(s['noteZh'])}`);
      if (s['multiway'] !== null && s['multiway'] !== undefined) console.log(`        multiway=${j(s['multiway'])}`);
    }
    console.log(`  droppedSizes=${j(bd['droppedSizes'])}`);
  } else {
    console.log(`--- diagnostics.betDecision = ${String(bd)} ---`);
  }

  const pf = dx['postflop'] as Record<string, any> | undefined;
  if (pf !== undefined) {
    console.log(`--- diagnostics.postflop (betRange/response) ---`);
    console.log(`  betRangeArrival keys=${Object.keys(pf['betRangeArrival'] ?? {}).join(',')}`);
    const bra = pf['betRangeArrival'] as Record<string, any> | null;
    if (bra !== null && bra !== undefined) {
      console.log(`   heroEquityVsArrivalRange=${num(bra['heroEquityVsArrivalRange'])} sizing=${j(bra['sizing'])}`);
      console.log(`   noteZh=${String(bra['noteZh'])}`);
    }
    const brf = pf['bettingRangeFacts'] as Record<string, any> | null;
    if (brf !== null && brf !== undefined) {
      console.log(`  bettingRangeFacts.sizing=${j(brf['sizing'])}`);
      console.log(`  bettingRangeFacts.noteZh=${String(brf['noteZh'])}`);
    }
    const rr = pf['raiseResponse'] as Record<string, any> | null;
    if (rr !== null && rr !== undefined) {
      console.log(`  raiseResponse=${j({ ...rr, buckets: undefined })}`);
    }
    console.log(`  postflop keys=${Object.keys(pf).join(',')}`);
  }
  console.log(`--- viewModel.warningsZh ---`);
  const vm = r.viewModel as unknown as Record<string, any>;
  console.log(`  ${j(vm['warningsZh'])}`);
}
console.log('\nDONE flriver-gent2-probe');
