import { writeFileSync } from 'node:fs';
const ROUND = 'D:/德州决策/reports/aa-utg-sizing-v3';
const REPRO = 'D:/德州决策/reports/gtopen-validation/9max-cold-solve-repro';
process.env['ALPHA_GTO_CACHE_DIR'] = REPRO + '/cache';
process.env['GTOPEN_URL'] = 'http://127.0.0.1:3761';

const { analyzeManualHand, prefetchSolverRangesForInput } = await import('file:///D:/德州决策/src/app/alphaPipeline.ts');
const { loadKnowledgeBaseOrThrow } = await import('file:///D:/德州决策/src/domain/knowledge/knowledgeLoader.ts');

const input = { tableSize:9, heroPosition:'BB', heroCards:['Ah','Ad'], board:[], street:'PREFLOP', effectiveStackBB:100,
 actionHistory:[
  {position:'UTG',type:'RAISE',amountBB:2.5,street:'PREFLOP'},
  {position:'UTG1',type:'FOLD',street:'PREFLOP'},
  {position:'UTG2',type:'FOLD',street:'PREFLOP'},
  {position:'LJ',type:'FOLD',street:'PREFLOP'},
  {position:'HJ',type:'FOLD',street:'PREFLOP'},
  {position:'CO',type:'FOLD',street:'PREFLOP'},
  {position:'BTN',type:'FOLD',street:'PREFLOP'},
  {position:'SB',type:'FOLD',street:'PREFLOP'}], environment:'LOW_STAKES_ONLINE' };

const t0 = Date.now();
const pf = await prefetchSolverRangesForInput(input, {});
const prefetchMs = Date.now() - t0;
const rules = loadKnowledgeBaseOrThrow().allRules();
const r = analyzeManualHand(input,{rules,asOf:1757000000000,writeLog:false,equitySeed:20260913,budget:{softMs:120000,hardMs:240000},gtoRanges:pf.ranges});
const pr = r.ok ? r.decision.diagnostics.preflopRaise : null;
const out = {
  generatedAt: new Date().toISOString(),
  prefetchMs,
  prefetch: {
    keys: Object.keys(pf.ranges ?? {}),
    warnings: pf.warnings,
    outcomes: pf.outcomes,
    elapsedMs: pf.elapsedMs,
  },
  ok: r.ok,
  decision: r.ok ? { action: r.decision.action, sizeChips: r.decision.sizeChips } : null,
  rangeProvenance: r.ok ? r.decision.diagnostics.rangeProvenance : null,
  preflopRaise: pr,
};
writeFileSync(ROUND + '/production-current.json', JSON.stringify(out,null,2),'utf8');
console.log(JSON.stringify({
  prefetchMs, prefetchKeys: Object.keys(pf.ranges ?? {}), warnings: pf.warnings, outcomes: pf.outcomes,
  ok: r.ok, action: out.decision, arrival: pr && pr.arrival, modelVersion: pr && pr.modelVersion, evidence: pr && pr.evidence,
  sizes: (pr?.sizes ?? []).map(s=>({bb:s.sizeBB, add:s.heroAdd, vAdd:s.villainAdd, finalPot:s.finalPot, ret:s.uncalledReturn, f:+s.foldLikelihood.toFixed(6), c:+s.callLikelihood.toFixed(6), rr:+s.reRaiseLikelihood.toFixed(6), sum:+(s.foldLikelihood+s.callLikelihood+s.reRaiseLikelihood).toFixed(9), eqCall:s.heroEquityVsRaiseCallRange?.value, eqRR:s.heroEquityVsReraiseRange?.value, reach:s.reachableCombos, callC:s.callCombos, rrC:s.reRaiseCombos, ev:s.raiseEV, rrEV:s.reraiseBranchEV, rrKind:s.reraiseBranchKind})),
}, null, 2));
