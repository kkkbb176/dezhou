import { analyzeManualHand } from '../../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../../src/app/manualInput/manualInput.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const F = (p:string)=>({position:p,type:'FOLD' as const});
function spot(profile:string):ManualHandInput{return{tableSize:9,heroPosition:'BTN',heroCards:['Kd','Th'],board:['Ts','7c','3h'],street:'FLOP',effectiveStackBB:100,seatStacksBB:{UTG:100,BTN:100,BB:100},actionHistory:[{position:'UTG',type:'CALL',amountBB:1},F('UTG1'),F('UTG2'),F('LJ'),F('HJ'),F('CO'),{position:'BTN',type:'CALL',amountBB:1},F('SB'),{position:'BB',type:'CHECK'},{position:'BB',type:'CHECK',street:'FLOP'},{position:'UTG',type:'CHECK',street:'FLOP'}],environment:'MID_LOW_STAKES',villain:{quickProfile:profile,dynamicHint:'UNKNOWN'}} as unknown as ManualHandInput;}
const r:any = analyzeManualHand(spot('CALLING_STATION'), OPTIONS);
console.log('top keys:', Object.keys(r).join(','));
console.log('decision keys:', Object.keys(r.decision ?? {}).join(','));
const adv = r.postflopAdvice ?? r.advice ?? null;
console.log('advice present:', adv!==null, adv? Object.keys(adv).join(',') : '');
if (adv) { console.log('sizing:', JSON.stringify(adv.sizing)); console.log('reasonsZh:'); for (const t of (adv.reasonsZh??[])) console.log('  -', t); }
const ev = r.evidence ?? r.decision?.evidence ?? null;
console.log('evidence keys:', ev? Object.keys(ev).join(',') : 'none');
console.log('reasonCodes:', JSON.stringify(r.decision?.reasonCodes ?? null));
