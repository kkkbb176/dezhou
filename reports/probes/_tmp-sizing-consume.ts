import { buildDecisionContext } from '../../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../../src/app/manualInput/reconstruct.ts';
import { deriveLegalActions } from '../../src/app/manualInput/legalActions.ts';
import { advisePostflop } from '../../src/app/decision/postflopAdvisor.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const F = (position) => ({ position, type: 'FOLD' });
const spot = (profile) => ({ tableSize:9, heroPosition:'BTN', heroCards:['Kd','Th'], board:['Ts','7c','3h'], street:'FLOP', effectiveStackBB:100, seatStacksBB:{UTG:100,BTN:100,BB:100}, actionHistory:[{position:'UTG',type:'CALL',amountBB:1},F('UTG1'),F('UTG2'),F('LJ'),F('HJ'),F('CO'),{position:'BTN',type:'CALL',amountBB:1},F('SB'),{position:'BB',type:'CHECK'},{position:'BB',type:'CHECK',street:'FLOP'},{position:'UTG',type:'CHECK',street:'FLOP'}], environment:'MID_LOW_STAKES', villain:{quickProfile:profile,dynamicHint:'UNKNOWN'} });
for (const p of ['CALLING_STATION','VERY_TIGHT','NORMAL']) {
  const parsed = parseManualInput(spot(p)); const g = buildAnalyzableState(parsed.value);
  const built = buildDecisionContext({state:g.state, rules:RULES, environment:'MID_LOW_STAKES', asOf:1757000000000, quickProfile:p});
  const hero = g.state.players.find(x=>x.holeCards!==null);
  const legal = deriveLegalActions(g.state, hero);
  const adv = advisePostflop(built.context, {facingBet: legal.callCost>0, requiredEquity: built.context.math.requiredEquity, potAfterCall: built.context.math.pot+legal.callCost});
  console.log('===',p);
  console.log('sizing.gridRatio=', adv.sizing.gridRatio, 'target=', adv.sizing.targetRatio);
  console.log('sizing.reasons=', adv.sizing.reasonsZh.join(' | '));
  console.log('betDecision.bestSize=', adv.betDecision?.bestSize, 'bestAmount=', adv.betDecision?.bestAmount);
  for (const s of adv.betDecision?.sizes ?? []) console.log('  ', s.kind, 'amount', s.betAmount, 'EV', s.betEV?.toFixed(2), 'score', s.score.toFixed(4));
}
