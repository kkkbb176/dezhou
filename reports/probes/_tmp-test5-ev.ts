import { analyzeManualHand } from '../../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../../src/app/manualInput/reconstruct.ts';
import { deriveLegalActions } from '../../src/app/manualInput/legalActions.ts';
import { advisePostflop } from '../../src/app/decision/postflopAdvisor.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const F = (position: string) => ({ position, type: 'FOLD' as const });
function stationSpot(profile: string): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BTN', heroCards: ['Kd', 'Th'],
    board: ['Ts', '7c', '3h'], street: 'FLOP',
    effectiveStackBB: 100, seatStacksBB: { UTG: 100, BTN: 100, BB: 100 },
    actionHistory: [
      { position: 'UTG', type: 'CALL', amountBB: 1 }, F('UTG1'), F('UTG2'), F('LJ'), F('HJ'), F('CO'),
      { position: 'BTN', type: 'CALL', amountBB: 1 }, F('SB'), { position: 'BB', type: 'CHECK' },
      { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'UTG', type: 'CHECK', street: 'FLOP' },
    ],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: profile, dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}
for (const profile of ['CALLING_STATION','VERY_TIGHT']) {
  const input = stationSpot(profile);
  const parsed = parseManualInput(input); const gate = buildAnalyzableState(parsed.value);
  const built = buildDecisionContext({ state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000, quickProfile: profile });
  const hero = gate.state.players.find((p)=>p.holeCards!==null);
  const legal = deriveLegalActions(gate.state, hero);
  const advice = advisePostflop(built.context, { facingBet: legal.callCost>0, requiredEquity: built.context.math.requiredEquity, potAfterCall: built.context.math.pot+legal.callCost });
  const bd = advice.betDecision;
  console.log('===', profile, 'pot=', bd.pot, '===');
  for (const s of bd.sizes) console.log('  ', s.kind, 'amt=', s.betAmount?.toFixed(2), 'betEV=', s.betEV?.toFixed(4), 'deltaVsCheck=', s.deltaVsCheck?.toFixed(4), 'score=', s.score?.toFixed(4));
  console.log('  checkTree.kind=', bd.checkTree.kind, 'checkEV=', bd.checkTree.checkEV?.toFixed(4));
}
