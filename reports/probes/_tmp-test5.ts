import { analyzeManualHand } from '../../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../../src/app/manualInput/reconstruct.ts';
import { deriveLegalActions } from '../../src/app/manualInput/legalActions.ts';
import { advisePostflop } from '../../src/app/decision/postflopAdvisor.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
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

for (const profile of ['CALLING_STATION', 'VERY_TIGHT']) {
  const input = stationSpot(profile);
  const result = analyzeManualHand(input, OPTIONS);
  if (!result.ok) { console.log(profile, 'ANALYZE FAIL'); continue; }
  const parsed = parseManualInput(input);
  if (!parsed.ok) { console.log(profile, 'PARSE FAIL'); continue; }
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) { console.log(profile, 'GATE FAIL'); continue; }
  const built = buildDecisionContext({ state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000, quickProfile: profile });
  const hero = gate.state.players.find((p) => p.holeCards !== null)!;
  const legal = deriveLegalActions(gate.state, hero);
  const advice = advisePostflop(built.context, { facingBet: legal.callCost > 0, requiredEquity: built.context.math.requiredEquity, potAfterCall: built.context.math.pot + legal.callCost });
  const d = result.decision as unknown as Record<string, unknown>;
  console.log('===', profile, '===');
  console.log('action=', d['action'], 'sizeChips=', d['sizeChips'], 'betEV=', d['betEV'], 'checkEV=', d['checkEV']);
  console.log('pot=', built.context.math.pot, 'bigBlind=', built.context.math.bigBlind);
  console.log('gate bet=', advice.gate.estimatedBetEVScore, 'check=', advice.gate.estimatedCheckEVScore);
  const sizes = advice.betDecision?.sizes ?? [];
  for (const s of sizes) {
    console.log('  ', s.kind, 'amt=', s.betAmount, 'fold=', (s.foldLikelihood ?? NaN).toFixed(4), 'call=', (s.callLikelihood ?? NaN).toFixed(4), 'raise=', (s.raiseLikelihood ?? NaN).toFixed(4), 'eqCall=', (s.heroEquityVsCallRange ?? NaN).toFixed(4));
  }
}
