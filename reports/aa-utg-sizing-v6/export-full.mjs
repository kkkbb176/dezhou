import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const roundDir = 'D:/德州决策/reports/aa-utg-sizing-v6';
process.env['ALPHA_GTO_CACHE_DIR'] = 'D:/德州决策/reports/gtopen-validation/9max-cold-solve-repro/cache';
process.env['GTOPEN_URL'] = 'http://127.0.0.1:3761';
const { startAlphaServer } = await import('file:///D:/德州决策/src/app/webServer.ts');
const input = {
  tableSize: 9, heroPosition: 'BB', heroCards: ['Ah','Ad'], board: [], street: 'PREFLOP', effectiveStackBB: 100,
  actionHistory: [
    { position:'UTG', type:'RAISE', amountBB:2.5, street:'PREFLOP' },
    { position:'UTG1', type:'FOLD', street:'PREFLOP' }, { position:'UTG2', type:'FOLD', street:'PREFLOP' },
    { position:'LJ', type:'FOLD', street:'PREFLOP' }, { position:'HJ', type:'FOLD', street:'PREFLOP' },
    { position:'CO', type:'FOLD', street:'PREFLOP' }, { position:'BTN', type:'FOLD', street:'PREFLOP' },
    { position:'SB', type:'FOLD', street:'PREFLOP' },
  ], environment:'LOW_STAKES_ONLINE',
};
const server = await startAlphaServer({ port:0, host:'127.0.0.1', gtoBackgroundSolve:false, logPath:null });
try {
  const started = Date.now();
  const res = await fetch(server.url + '/api/analyze', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({input, mode:'OFF'}) });
  const body = await res.json();
  const r = body.result ?? body;
  const vm = r.viewModel ?? {};
  const diagnostics = r.decision?.diagnostics ?? r.diagnostics ?? {};
  const pr = diagnostics?.preflopRaise ?? null;
  const out = { generatedAt:new Date().toISOString(), elapsedMs:Date.now()-started, httpStatus:res.status, gtoStatus:r.gtoStatus ?? null, rangeProvenance:r.rangeProvenance ?? null, decision:r.decision ?? null, diagnosticsKeys:Object.keys(diagnostics), preflopRaise:pr, vmPreflopRaise:vm?.debug?.preflopRaise ?? null, meta:r.meta ?? null };
  writeFileSync(join(roundDir, 'production-full.json'), JSON.stringify(out, null, 2), 'utf8');
  const rows = (pr?.sizes ?? []).map((s) => ({
    sizeBB:s.sizeBB, sizeChips:s.sizeChips, isAllIn:s.isAllIn,
    currentPot:s.currentPot, heroStreetCommitted:s.heroStreetCommitted, villainStreetCommitted:s.villainStreetCommitted,
    heroAdd:s.heroAdd, villainAddRaw:s.villainAddRaw, villainAdd:s.villainAdd, heroContestedAdd:s.heroContestedAdd,
    finalPot:s.finalPot, uncalledReturn:s.uncalledReturn,
    f:s.foldLikelihood, c:s.callLikelihood, rr:s.reRaiseLikelihood, sum:s.foldLikelihood+s.callLikelihood+s.reRaiseLikelihood,
    price:s.priceRequiredEquity, eqCall:s.heroEquityVsRaiseCallRange, eqRR:s.heroEquityVsReraiseRange,
    reachableCombos:s.reachableCombos, callCombos:s.callCombos, reRaiseCombos:s.reRaiseCombos,
    reraiseAvailable:s.reraiseAvailable, reRaiseTo:s.reRaiseTo, heroAdditionalCallVsReRaise:s.heroAdditionalCallVsReRaise,
    reraiseFoldBranchEV:s.reraiseFoldBranchEV, reraiseCallBranchEV:s.reraiseCallBranchEV,
    reraiseBranchEV:s.reraiseBranchEV, reraiseBranchKind:s.reraiseBranchKind,
    raiseEV:s.raiseEV, noteZh:s.noteZh,
  }));
  writeFileSync(join(roundDir, 'production-rows.json'), JSON.stringify({ generatedAt:out.generatedAt, elapsedMs:out.elapsedMs, arrival:pr?.arrival, modelVersion:pr?.modelVersion, cashflowContract:pr?.cashflowContract, rows }, null, 2), 'utf8');
  console.log(JSON.stringify({ elapsedMs:out.elapsedMs, gtoState:r.gtoStatus?.state, fromSolver:r.rangeProvenance?.[0]?.fromSolver, arrival:pr?.arrival, rows }, null, 2));
} finally { await server.close(); }
