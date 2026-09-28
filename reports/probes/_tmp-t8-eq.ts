import { buildDecisionContext } from '../../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';
import { composeBetEV } from '../../src/domain/postflop/betResponse.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const node = { tableSize:6, heroPosition:'BTN', heroCards:['As','Js'], board:['Kh','7c','2d'], street:'FLOP', effectiveStackBB:100, bigBlindBB:2, seatStacksBB:{UTG:100,HJ:100,CO:100,BTN:100,SB:100,BB:100}, actionHistory:[{position:'UTG',type:'FOLD'},{position:'HJ',type:'RAISE',amountBB:3},{position:'CO',type:'FOLD'},{position:'BTN',type:'CALL',amountBB:3},{position:'SB',type:'FOLD'},{position:'BB',type:'FOLD'},{position:'HJ',type:'CHECK',street:'FLOP'}], environment:'MID_LOW_STAKES', villain:{quickProfile:'NORMAL',dynamicHint:'UNKNOWN',stackBB:100} };
const parsed = parseManualInput(node as never); const g = buildAnalyzableState(parsed.value);
const ctx = buildDecisionContext({state:g.state, rules:RULES, environment:'MID_LOW_STAKES', asOf:1757000000000}).context;
const bd = ctx.postflopFacts?.betDecision;
const checkEV = bd.checkTree.checkEV;
for (const size of bd.sizes) {
  const legacy = composeBetEV({ kind:size.kind, ratioToPot:size.ratioToPot, pot:bd.pot, foldLikelihood:size.foldLikelihood, callLikelihood:size.callLikelihood, raiseLikelihood:size.raiseLikelihood, heroEquityVsCallRange:size.heroEquityVsCallRange, heroEquityVsRaiseRange:size.heroEquityVsRaiseRange, realizationFactor:bd.realization.factor, checkEV });
  console.log(size.kind, 'size.betEV=', size.betEV, 'legacy=', legacy.betEV, 'equal=', size.betEV === legacy.betEV, 'evKind=', size.evKind, 'multiway=', size.multiway);
}
