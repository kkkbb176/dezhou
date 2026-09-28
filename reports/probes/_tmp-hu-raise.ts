import { buildDecisionContext } from '../../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
function ctxOf(heroCards: string[], board: string[], hist: unknown[]) {
  const node = { tableSize:6, heroPosition:'BTN', heroCards, board, street:'FLOP', effectiveStackBB:100, bigBlindBB:2,
    seatStacksBB:{UTG:100,HJ:100,CO:100,BTN:100,SB:100,BB:100}, actionHistory:hist,
    environment:'MID_LOW_STAKES', villain:{quickProfile:'NORMAL',dynamicHint:'UNKNOWN',stackBB:100} };
  const parsed = parseManualInput(node as never); const g = buildAnalyzableState(parsed.value);
  return buildDecisionContext({state:g.state, rules:RULES, environment:'MID_LOW_STAKES', asOf:1757000000000}).context;
}
const huHist = [{position:'UTG',type:'FOLD'},{position:'HJ',type:'RAISE',amountBB:3},{position:'CO',type:'FOLD'},{position:'BTN',type:'CALL',amountBB:3},{position:'SB',type:'FOLD'},{position:'BB',type:'FOLD'},{position:'HJ',type:'CHECK',street:'FLOP'}];
const bd = ctxOf(['As','Js'],['Kh','7c','2d'],huHist).postflopFacts?.betDecision;
console.log('HU pot=',bd.pot);
for (const s of bd.sizes) console.log(' ', s.kind, 'amt=',s.betAmount, 'fold=',s.foldLikelihood.toFixed(3),'call=',s.callLikelihood.toFixed(3),'raise=',s.raiseLikelihood.toFixed(4),'villainAllInByCall=',s.villainIsAllInByCall);
const threeHist = [...huHist.slice(0,3),{position:'BTN',type:'CALL',amountBB:1}];
