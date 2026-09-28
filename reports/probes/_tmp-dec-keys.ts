import { analyzeManualHand } from '../../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const node = { tableSize:6, heroPosition:'BTN', heroCards:['As','Js'], board:['Kh','7c','2d'], street:'FLOP', effectiveStackBB:100, bigBlindBB:2, seatStacksBB:{UTG:100,HJ:100,CO:100,BTN:100,SB:100,BB:100}, actionHistory:[{position:'UTG',type:'FOLD'},{position:'HJ',type:'RAISE',amountBB:3},{position:'CO',type:'FOLD'},{position:'BTN',type:'CALL',amountBB:3},{position:'SB',type:'FOLD'},{position:'BB',type:'FOLD'},{position:'HJ',type:'CHECK',street:'FLOP'}], environment:'MID_LOW_STAKES', villain:{quickProfile:'NORMAL',dynamicHint:'UNKNOWN',stackBB:100} };
const r = analyzeManualHand(node as never, { rules: RULES, asOf: 1757000000000, writeLog: false });
if (!r.ok) { console.log('fail'); process.exit(0); }
console.log('decision keys=', Object.keys(r.decision));
console.log(JSON.stringify(r.decision, (k,v)=> v instanceof Map ? Array.from(v.entries()) : v, 1).slice(0, 2500));
