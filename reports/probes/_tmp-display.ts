import { analyzeManualHand } from '../../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../../src/app/manualInput/manualInput.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const F = (p:string)=>({position:p,type:'FOLD' as const});
function spot(profile:string):ManualHandInput{return{tableSize:9,heroPosition:'BTN',heroCards:['Kd','Th'],board:['Ts','7c','3h'],street:'FLOP',effectiveStackBB:100,seatStacksBB:{UTG:100,BTN:100,BB:100},actionHistory:[{position:'UTG',type:'CALL',amountBB:1},F('UTG1'),F('UTG2'),F('LJ'),F('HJ'),F('CO'),{position:'BTN',type:'CALL',amountBB:1},F('SB'),{position:'BB',type:'CHECK'},{position:'BB',type:'CHECK',street:'FLOP'},{position:'UTG',type:'CHECK',street:'FLOP'}],environment:'MID_LOW_STAKES',villain:{quickProfile:profile,dynamicHint:'UNKNOWN'}} as unknown as ManualHandInput;}
for (const p of ['CALLING_STATION','VERY_TIGHT']) {
  const r = analyzeManualHand(spot(p), OPTIONS);
  if(!r.ok){console.log(p,'FAIL');continue;}
  const adv:any = (r as any).postflopAdvice ?? null;
  const d:any = r.decision;
  console.log('===',p,'action=',d.action,'sizeChips=',d.sizeChips,'sizeBB=',d.sizeBB);
  const lines = ((r as any).reasonsZh ?? (d.reasonsZh ?? [])).filter((t:string)=>String(t).includes('底池')||String(t).includes('尺寸'));
  for (const l of lines) console.log('   DISPLAY:', l);
}
