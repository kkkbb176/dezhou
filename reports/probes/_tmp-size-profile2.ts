import { analyzeManualHand } from '../../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false };
const F = (position) => ({ position, type: 'FOLD' });
const spot = (profile) => ({ tableSize:9, heroPosition:'BTN', heroCards:['Kd','Th'], board:['Ts','7c','3h'], street:'FLOP', effectiveStackBB:100, seatStacksBB:{UTG:100,BTN:100,BB:100}, actionHistory:[{position:'UTG',type:'CALL',amountBB:1},F('UTG1'),F('UTG2'),F('LJ'),F('HJ'),F('CO'),{position:'BTN',type:'CALL',amountBB:1},F('SB'),{position:'BB',type:'CHECK'},{position:'BB',type:'CHECK',street:'FLOP'},{position:'UTG',type:'CHECK',street:'FLOP'}], environment:'MID_LOW_STAKES', villain:{quickProfile:profile,dynamicHint:'UNKNOWN'} });
for (const p of ['CALLING_STATION','VERY_TIGHT']) {
  const r = analyzeManualHand(spot(p), OPTIONS);
  const reason = r.decision.reasons.find(x=>x.code==='STRATEGIC_VALUE_BET');
  console.log('===',p,'final=',r.decision.action,r.decision.sizeChips);
  console.log(reason?.textZh);
  const vm = r.viewModel;
  // find diagnostic rows mentioning sizes / EV
  const all = JSON.stringify(vm);
  const m = all.match(/下注决策模型[^"]*/); if (m) console.log('VM:', m[0].slice(0,800));
}
