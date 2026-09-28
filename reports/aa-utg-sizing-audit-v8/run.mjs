import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'D:/德州决策/reports/aa-utg-sizing-audit-v8';
const REPRO = 'D:/德州决策/reports/gtopen-validation/9max-cold-solve-repro';
process.env['ALPHA_GTO_CACHE_DIR'] = REPRO + '/cache';
process.env['GTOPEN_URL'] = 'http://127.0.0.1:3761';

const { analyzeManualHand, prefetchSolverRangesForInput } = await import('file:///D:/德州决策/src/app/alphaPipeline.ts');
const { loadKnowledgeBaseOrThrow } = await import('file:///D:/德州决策/src/domain/knowledge/knowledgeLoader.ts');

const input = {
  tableSize: 9,
  heroPosition: 'BB',
  heroCards: ['Ah', 'Ad'],
  board: [],
  street: 'PREFLOP',
  effectiveStackBB: 100,
  actionHistory: [
    { position: 'UTG', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'UTG1', type: 'FOLD', street: 'PREFLOP' },
    { position: 'UTG2', type: 'FOLD', street: 'PREFLOP' },
    { position: 'LJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'CO', type: 'FOLD', street: 'PREFLOP' },
    { position: 'BTN', type: 'FOLD', street: 'PREFLOP' },
    { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
  ],
  environment: 'LOW_STAKES_ONLINE',
};

const pf = await prefetchSolverRangesForInput(input, {});
const rules = loadKnowledgeBaseOrThrow().allRules();
const r = analyzeManualHand(input, {
  rules,
  asOf: 1757000000000,
  writeLog: false,
  equitySeed: 20260913,
  budget: { softMs: 120000, hardMs: 240000 },
  gtoRanges: pf.ranges,
});
if (!r.ok) throw new Error(JSON.stringify(r));
const d = r.decision;
const pr = d.diagnostics.preflopRaise;
if (!pr) throw new Error('preflopRaise missing');

const rows = pr.sizes.map((s) => {
  const f = s.foldLikelihood;
  const c = s.callLikelihood;
  const rr = s.reRaiseLikelihood;
  const eq = s.heroEquityVsRaiseCallRange.value;
  const rrEV = s.reraiseBranchEV;
  const odds = 1 - f;
  const conditionalRR = odds > 0 ? rr / odds : null;
  const recomputed = eq === null ? null
    : f * s.currentPot + c * (eq * s.finalPot - s.heroContestedAdd) + rr * rrEV;
  return {
    sizeBB: s.sizeBB,
    sizeChips: s.sizeChips,
    isAllIn: s.isAllIn,
    labelZh: s.labelZh,
    currentPot: s.currentPot,
    heroStreetCommitted: s.heroStreetCommitted,
    villainStreetCommitted: s.villainStreetCommitted,
    heroAdd: s.heroAdd,
    villainAddRaw: s.villainAddRaw,
    villainAdd: s.villainAdd,
    heroContestedAdd: s.heroContestedAdd,
    finalPot: s.finalPot,
    uncalledReturn: s.uncalledReturn,
    heroIsAllIn: s.heroIsAllIn,
    villainIsAllInByCall: s.villainIsAllInByCall,
    f, c, rr, sum: f + c + rr,
    conditionalRR,
    price: s.priceRequiredEquity,
    eqCall: eq,
    eqRR: s.heroEquityVsReraiseRange.value,
    reachableCombos: s.reachableCombos,
    callCombos: s.callCombos,
    reRaiseCombos: s.reRaiseCombos,
    reraiseAvailable: s.reraiseAvailable,
    reRaiseTo: s.reRaiseTo,
    heroAdditionalCallVsReRaise: s.heroAdditionalCallVsReRaise,
    reraiseFoldBranchEV: s.reraiseFoldBranchEV,
    reraiseCallBranchEV: s.reraiseCallBranchEV,
    reraiseBranchEV: rrEV,
    reraiseBranchKind: s.reraiseBranchKind,
    heroFiveBetExpanded: s.heroFiveBetExpanded,
    raiseEV: s.raiseEV,
    recomputed,
    delta: recomputed === null ? null : recomputed - s.raiseEV,
  };
});

const out = {
  generatedAt: new Date().toISOString(),
  input,
  projectHead: '7dffffc965116c0a688d3357244624153def6a52',
  solverCacheDir: REPRO + '/cache',
  gtoStatus: d.diagnostics.gtoStatus ?? null,
  rangeProvenance: d.diagnostics.rangeProvenance ?? null,
  decision: { action: d.action, sizeChips: d.sizeChips, confidence: d.confidence },
  arrival: pr.arrival,
  evidence: pr.evidence,
  modelVersion: pr.modelVersion,
  cashflowContract: pr.cashflowContract,
  chosenSizeChips: pr.chosenSizeChips,
  assumptionsZh: pr.assumptionsZh,
  rows,
};
writeFileSync(join(OUT, 'production-rows.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify({ decision: out.decision, gtoStatus: out.gtoStatus, arrival: out.arrival, rows }, null, 2));
