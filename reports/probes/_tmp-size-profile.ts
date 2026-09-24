import { analyzeManualHand } from '../../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false };
const F = (position) => ({ position, type: 'FOLD' });
function spot(profile) {
  return {
    tableSize: 9, heroPosition: 'BTN', heroCards: ['Kd','Th'], board: ['Ts','7c','3h'], street: 'FLOP',
    effectiveStackBB: 100, seatStacksBB: { UTG:100, BTN:100, BB:100 },
    actionHistory: [
      { position:'UTG', type:'CALL', amountBB:1 }, F('UTG1'), F('UTG2'), F('LJ'), F('HJ'), F('CO'),
      { position:'BTN', type:'CALL', amountBB:1 }, F('SB'), { position:'BB', type:'CHECK' },
      { position:'BB', type:'CHECK', street:'FLOP' }, { position:'UTG', type:'CHECK', street:'FLOP' },
    ],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: profile, dynamicHint: 'UNKNOWN' },
  };
}
for (const p of ['CALLING_STATION','VERY_TIGHT']) {
  const r = analyzeManualHand(spot(p), OPTIONS);
  if (!r.ok) { console.log(p, 'FAILED', JSON.stringify(r.issues)); continue; }
  const bd = r.advice?.betDecision;
  console.log('===', p, 'action=', r.decision.action, 'size=', r.decision.sizeChips);
  console.log('checkEV=', bd?.checkEV, 'best=', bd?.bestSize, 'preferred=', bd?.preferredAction);
  for (const s of bd?.sizes ?? []) {
    console.log(s.kind, 'amount=', s.betAmount, 'fold=', s.foldLikelihood?.toFixed(4), 'call=', s.callLikelihood?.toFixed(4), 'raise=', s.raiseLikelihood?.toFixed(4), 'eqCall=', s.heroEquityVsCallRange?.toFixed(4), 'EV=', s.betEV?.toFixed(3), 'score=', s.score?.toFixed(4));
  }
}

