import { analyzeManualHand } from '../../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const node = { tableSize:6, heroPosition:'BTN', heroCards:['As','Js'], board:['Kh','7c','2d'], street:'FLOP', effectiveStackBB:100, bigBlindBB:2, seatStacksBB:{UTG:100,HJ:100,CO:100,BTN:100,SB:100,BB:100}, actionHistory:[{position:'UTG',type:'FOLD'},{position:'HJ',type:'RAISE',amountBB:3},{position:'CO',type:'FOLD'},{position:'BTN',type:'CALL',amountBB:3},{position:'SB',type:'FOLD'},{position:'BB',type:'FOLD'},{position:'HJ',type:'CHECK',street:'FLOP'}], environment:'MID_LOW_STAKES', villain:{quickProfile:'NORMAL',dynamicHint:'UNKNOWN',stackBB:100} };
const r = analyzeManualHand(node as never, { rules: RULES, asOf: 1757000000000, writeLog: false });
console.log('ok=', r.ok);
if (r.ok) {
  const d = r.decision as unknown as Record<string, unknown>;
  console.log('action=', d['action'], 'sizeChips=', d['sizeChips']);
  const m = d['evBySizeChips'] as Map<number, number> | undefined;
  console.log('hasMap=', m instanceof Map, 'entries=', m ? Array.from(m.entries()) : null);
  const parsed = parseManualInput(node as never); const g = buildAnalyzableState(parsed.value);
  const bd = buildDecisionContext({state:g.state, rules:RULES, environment:'MID_LOW_STAKES', asOf:1757000000000}).context.postflopFacts?.betDecision;
  for (const s of bd.sizes) console.log('  size', s.kind, 'betAmount=', s.betAmount, 'betEV=', s.betEV, 'mapHit=', m ? m.get(s.betAmount) : null);
}
