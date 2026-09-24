import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const productionCache = 'D:/德州决策/data/gto-cache';
const emptyDir = mkdtempSync(join(tmpdir(), 'gtopen-9max-v2-A-'));
const input = {
  tableSize: 9, heroPosition: 'BB', heroCards: ['Ah','Ad'], board: [], street: 'PREFLOP',
  effectiveStackBB: 100,
  actionHistory: [
    { position:'UTG', type:'RAISE', amountBB:2.5, street:'PREFLOP' },
    { position:'UTG1', type:'FOLD', street:'PREFLOP' }, { position:'UTG2', type:'FOLD', street:'PREFLOP' },
    { position:'LJ', type:'FOLD', street:'PREFLOP' }, { position:'HJ', type:'FOLD', street:'PREFLOP' },
    { position:'CO', type:'FOLD', street:'PREFLOP' }, { position:'BTN', type:'FOLD', street:'PREFLOP' },
    { position:'SB', type:'FOLD', street:'PREFLOP' },
  ], environment: 'LOW_STAKES_ONLINE',
};
function summarize(payload) {
  const r = payload.result ?? payload; const vm = r.viewModel ?? {};
  const val = (n) => (vm.debug?.math ?? []).find((m) => String(m.label).includes(n))?.value ?? null;
  return { httpStatus: payload.httpStatus ?? 200, ok:r.ok, actionZh:vm.actionZh, sizeZh:vm.sizeZh,
    confidenceZh:vm.confidenceZh, classificationZh:vm.classificationZh, decision:r.decision,
    equity:val('整体范围权益'), callEv:val('跟注 EV'),
    candidates:(vm.debug?.candidates ?? []).map((c)=>({action:c.actionZh,size:c.sizeZh,ev:c.evZh})),
    reasonsZh:vm.reasonsZh, gtoStatus:r.gtoStatus,
    rangeProvenance:(r.rangeProvenance??[]).map((p)=>({sourceKind:p.sourceKind,sourceKindZh:p.sourceKindZh,fromSolver:p.fromSolver,confidence:p.confidence,supportSize:p.supportSize,effectiveComboCount:p.effectiveComboCount,normalizedEntropy:p.normalizedEntropy,gtoOutcomeState:p.gtoOutcomeState})),
    meta:r.meta,
  };
}
async function run(cacheDir, mode) {
  process.env['ALPHA_GTO_CACHE_DIR'] = cacheDir;
  process.env['GTOPEN_URL'] = 'http://127.0.0.1:3737';
  const { startAlphaServer } = await import('file:///D:/德州决策/src/app/webServer.ts');
  const server = await startAlphaServer({port:0,host:'127.0.0.1',gtoBackgroundSolve:false,logPath:null});
  try {
    const t0=Date.now(); const res=await fetch(server.url+'/api/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input,mode:'OFF'})});
    const body=await res.json();
    return {mode, cacheDir, elapsedMs:Date.now()-t0, ...summarize({httpStatus:res.status,...body})};
  } finally { await server.close(); }
}
const out={generatedAt:new Date().toISOString(), input, productionHealth:null, A:{}, B:{}};
out.productionHealth = await (await fetch('http://127.0.0.1:5173/api/gto/health')).json().catch(()=>null);
out.A=await run(emptyDir,'A_no_solver_range'); rmSync(emptyDir,{recursive:true,force:true});
out.B=await run(productionCache,'B_solver_range_persistent_cache');
const raw=JSON.parse(readFileSync(productionCache+'/strategy/c80e2e90a.json','utf8'));
let positiveClasses=0,totalCombos=0,comboWeightedMass=0,classFrequencySum=0;
for(const h of raw.range.hands){let w=0;for(const a of h.actions){if(a.kind==='RAISE'||a.kind==='ALL_IN')w+=Number(a.frequency)||0;}w=Math.min(1,Math.max(0,w));classFrequencySum+=w;comboWeightedMass+=w*Number(h.combos);totalCombos+=Number(h.combos);if(w>0)positiveClasses++;}
const named=(n)=>{const h=raw.range.hands.find(x=>x.hand===n);return Object.fromEntries((h?.actions??[]).map(a=>[a.kind,a.frequency]));};
out.rangeSummary={cacheKey:raw.cacheKey,scenarioHash:raw.scenarioHash,treeId:raw.treeId,scenario:raw.scenario,solveMeta:raw.solveMeta,quality:raw.quality,source:raw.source,hands:raw.range.hands.length,totalCombos,positiveClasses,classFrequencySum,comboWeightedMass,AA:named('AA'),AJo:named('AJo'),'72o':named('72o')};
console.log(JSON.stringify(out,null,2));
