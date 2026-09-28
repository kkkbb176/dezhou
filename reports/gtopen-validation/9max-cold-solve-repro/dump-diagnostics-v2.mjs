import { writeFileSync } from 'node:fs';
const roundDir = 'D:/德州决策/reports/gtopen-validation/9max-cold-solve-repro';
process.env['ALPHA_GTO_CACHE_DIR'] = roundDir + '/cache';
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
const pf = await prefetchSolverRangesForInput(input, {});
const rules = loadKnowledgeBaseOrThrow().allRules();
const r = analyzeManualHand(input,{rules,asOf:1757000000000,writeLog:false,equitySeed:20260913,budget:{softMs:120000,hardMs:240000},gtoRanges:pf.ranges});
const diag = r.ok ? r.decision.diagnostics : null;
const pr = diag?.preflopRaise ?? null;
const out={ok:r.ok,prefetch:{state:pf.status?.state,outcomes:pf.status?.outcomes},decision:{action:r.ok?r.decision.action:null,sizeChips:r.ok?r.decision.sizeChips:null,confidence:r.ok?r.decision.confidence:null},preflopRaise:pr};
const p='D:/德州决策/reports/aa-utg-sizing-v2/production-diagnostics.json';
writeFileSync(p,JSON.stringify(out,null,2),'utf8');
console.log(JSON.stringify({path:p,ok:r.ok,prefetch:out.prefetch,action:out.decision,prStatus:pr?.status,prReason:pr?.reasonZh,sizeCount:pr?.sizes?.length,chosen:pr?.chosenSizeChips},null,2));
