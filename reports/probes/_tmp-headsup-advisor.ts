import { analyzeManualHand } from '../../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../../src/app/manualInput/reconstruct.ts';
import { deriveLegalActions } from '../../src/app/manualInput/legalActions.ts';
import { advisePostflop } from '../../src/app/decision/postflopAdvisor.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';
import { composeBetEV } from '../../src/domain/postflop/betResponse.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const node = { tableSize:6, heroPosition:'BTN', heroCards:['As','Js'], board:['Kh','7c','2d'], street:'FLOP', effectiveStackBB:100, bigBlindBB:2, seatStacksBB:{UTG:100,HJ:100,CO:100,BTN:100,SB:100,BB:100}, actionHistory:[{position:'UTG',type:'FOLD'},{position:'HJ',type:'RAISE',amountBB:3},{position:'CO',type:'FOLD'},{position:'BTN',type:'CALL',amountBB:3},{position:'SB',type:'FOLD'},{position:'BB',type:'FOLD'},{position:'HJ',type:'CHECK',street:'FLOP'}], environment:'MID_LOW_STAKES', villain:{quickProfile:'NORMAL',dynamicHint:'UNKNOWN',stackBB:100} };
const parsed = parseManualInput(node as never); const g = buildAnalyzableState(parsed.value);
const built = buildDecisionContext({state:g.state, rules:RULES, environment:'MID_LOW_STAKES', asOf:1757000000000});
const hero = g.state.players.find((x)=>x.holeCards!==null)!;
const legal = deriveLegalActions(g.state, hero);
const a = advisePostflop(built.context, { facingBet: legal.callCost>0, requiredEquity: built.context.math.requiredEquity, potAfterCall: built.context.math.pot+legal.callCost });
const checkEV = a.betDecision.checkTree.checkEV;
for (const s of a.betDecision.sizes) {
  const legacy = composeBetEV({ kind:s.kind, ratioToPot:s.ratioToPot, pot:a.betDecision.pot, foldLikelihood:s.foldLikelihood, callLikelihood:s.callLikelihood, raiseLikelihood:s.raiseLikelihood, heroEquityVsCallRange:s.heroEquityVsCallRange, heroEquityVsRaiseRange:s.heroEquityVsRaiseRange, realizationFactor:a.betDecision.realization.factor, checkEV });
  console.log(s.kind, 'advisor.betEV=', s.betEV, 'legacy=', legacy.betEV, 'single=', s.betEVSingleOpponent, 'equalProduction=', s.betEV === legacy.betEV);
}
console.log('legalSizes=', a.betDecision.legalSizes.map(x=>({kind:x.kind, betEV:x.betEV})));
