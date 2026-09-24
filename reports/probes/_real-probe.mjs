import { analyzeManualHand, prefetchSolverRangesForInput } from 'file:///D:/德州决策/src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from 'file:///D:/德州决策/src/domain/knowledge/knowledgeLoader.ts';
import { preflopStrengthOf } from 'file:///D:/德州决策/src/app/manualInput/preflopRaiseResponse.ts';
import { rankClassOfIndices } from 'file:///D:/德州决策/src/app/manualInput/preflopRaiseFacts.ts';
process.env['ALPHA_GTO_CACHE_DIR']='D:/德州决策/reports/gtopen-validation/9max-cold-solve-repro/cache';
const input={tableSize:9,heroPosition:'BB',heroCards:['Ah','Ad'],board:[],street:'PREFLOP',effectiveStackBB:100,actionHistory:[{position:'UTG',type:'RAISE',amountBB:2.5,street:'PREFLOP'},{position:'UTG1',type:'FOLD',street:'PREFLOP'},{position:'UTG2',type:'FOLD',street:'PREFLOP'},{position:'LJ',type:'FOLD',street:'PREFLOP'},{position:'HJ',type:'FOLD',street:'PREFLOP'},{position:'CO',type:'FOLD',street:'PREFLOP'},{position:'BTN',type:'FOLD',street:'PREFLOP'},{position:'SB',type:'FOLD',street:'PREFLOP'}],environment:'LOW_STAKES_ONLINE'};
const pf=await prefetchSolverRangesForInput(input,{});
const r=analyzeManualHand(input,{rules:loadKnowledgeBaseOrThrow().allRules(),asOf:1757000000000,writeLog:false,equitySeed:20260913,budget:{softMs:120000,hardMs:240000},gtoRanges:pf.ranges});
if(!r.ok) throw new Error(JSON.stringify(r));
const pr=r.decision.diagnostics.preflopRaise;
const map=new Map();
for(const s of pr.sizes){ if(s.sizeBB>50) continue; }
console.log('sizes', pr.sizes.map(s=>s.sizeBB).join(','));
for(const s of pr.sizes){
  console.log(JSON.stringify({size:s.sizeBB,price:+s.priceRequiredEquity.toFixed(4),req:+(s.priceRequiredEquity+0.19).toFixed(4),f:+s.foldLikelihood.toFixed(4),c:+s.callLikelihood.toFixed(4),rr:+s.reRaiseLikelihood.toFixed(4),callC:s.callCombos,rrC:s.reRaiseCombos}));
}
