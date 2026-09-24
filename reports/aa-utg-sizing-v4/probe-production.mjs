import { writeFileSync } from 'node:fs';
const ROUND = 'D:/德州决策/reports/aa-utg-sizing-v4';
const REPRO = 'D:/德州决策/reports/gtopen-validation/9max-cold-solve-repro';
process.env['ALPHA_GTO_CACHE_DIR'] = REPRO + '/cache';
process.env['GTOPEN_URL'] = 'http://127.0.0.1:3761';
const { analyzeManualHand, prefetchSolverRangesForInput } = await import('file:///D:/德州决策/src/app/alphaPipeline.ts');
const { loadKnowledgeBaseOrThrow } = await import('file:///D:/德州决策/src/domain/knowledge/knowledgeLoader.ts');
const input = {
  tableSize: 9, heroPosition: 'BB', heroCards: ['Ah','Ad'], board: [], street: 'PREFLOP', effectiveStackBB: 100,
  actionHistory: [
    { position:'UTG', type:'RAISE', amountBB:2.5, street:'PREFLOP' },
    { position:'UTG1', type:'FOLD', street:'PREFLOP' },
    { position:'UTG2', type:'FOLD', street:'PREFLOP' },
    { position:'LJ', type:'FOLD', street:'PREFLOP' },
    { position:'HJ', type:'FOLD', street:'PREFLOP' },
    { position:'CO', type:'FOLD', street:'PREFLOP' },
    { position:'BTN', type:'FOLD', street:'PREFLOP' },
    { position:'SB', type:'FOLD', street:'PREFLOP' },
  ],
  environment: 'LOW_STAKES_ONLINE',
};
const t0 = Date.now();
const pf = await prefetchSolverRangesForInput(input, {});
const prefetchMs = Date.now() - t0;
const rules = loadKnowledgeBaseOrThrow().allRules();
const t1 = Date.now();
const r = analyzeManualHand(input, { rules, asOf: 1757000000000, writeLog: false, equitySeed: 20260913, budget:{softMs:120000,hardMs:240000}, gtoRanges: pf.ranges });
const analyzeMs = Date.now() - t1;
const pr = r.ok ? r.decision.diagnostics.preflopRaise : null;
const out = {
  generatedAt: new Date().toISOString(),
  projectHead: '7dffffc',
  prefetchMs, analyzeMs,
  prefetch: { keys: Object.keys(pf.ranges ?? {}), warnings: pf.warnings, outcomes: pf.outcomes, elapsedMs: pf.elapsedMs },
  ok: r.ok,
  decision: r.ok ? { action: r.decision.action, sizeChips: r.decision.sizeChips, confidence: r.decision.confidence } : null,
  rangeProvenance: r.ok ? r.decision.diagnostics.rangeProvenance : null,
  preflopRaise: pr,
};
writeFileSync(ROUND + '/production-solver-current.json', JSON.stringify(out, null, 2), 'utf8');
const rows = (pr?.sizes ?? []).map((s) => ({
  sizeBB: s.sizeBB, sizeChips: s.sizeChips, isAllIn: s.isAllIn,
  currentPot: s.currentPot, heroCommitted: s.heroStreetCommitted, villainCommitted: s.villainStreetCommitted,
  heroAdd: s.heroAdd, villainAdd: s.villainAdd, heroContestedAdd: s.heroContestedAdd, finalPot: s.finalPot,
  uncalledReturn: s.uncalledReturn, f: s.foldLikelihood, c: s.callLikelihood, rr: s.reRaiseLikelihood,
  fcrrSum: s.foldLikelihood + s.callLikelihood + s.reRaiseLikelihood,
  price: s.priceRequiredEquity, eqCall: s.heroEquityVsRaiseCallRange?.value,
  eqRR: s.heroEquityVsReraiseRange?.value,
  reachableCombos: s.reachableCombos, callCombos: s.callCombos, reRaiseCombos: s.reRaiseCombos,
  rrAvail: s.reraiseAvailable, reRaiseTo: s.reRaiseTo, rrFoldEV: s.reraiseFoldBranchEV,
  rrCallEV: s.reraiseCallBranchEV, rrEV: s.reraiseBranchEV, rrKind: s.reraiseBranchKind, raiseEV: s.raiseEV,
}));
writeFileSync(ROUND + '/production-rows.json', JSON.stringify({ generatedAt: out.generatedAt, prefetchMs, analyzeMs, arrival: pr?.arrival, evidence: pr?.evidence, modelVersion: pr?.modelVersion, cashflowContract: pr?.cashflowContract, rows }, null, 2), 'utf8');
console.log(JSON.stringify({
  prefetchMs, analyzeMs, keys: Object.keys(pf.ranges ?? {}), warnings: pf.warnings, outcomes: pf.outcomes,
  action: out.decision, arrival: pr?.arrival, evidence: pr?.evidence, modelVersion: pr?.modelVersion,
  rows,
}, null, 2));
