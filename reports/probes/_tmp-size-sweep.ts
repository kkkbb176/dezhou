import { buildDecisionContext } from '../../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../../src/app/manualInput/reconstruct.ts';
import { deriveLegalActions } from '../../src/app/manualInput/legalActions.ts';
import { advisePostflop } from '../../src/app/decision/postflopAdvisor.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const F = (position: string) => ({ position, type: 'FOLD' as const });
function spot(profile: string, heroCards: string[], board: string[]): unknown {
  return { tableSize: 9, heroPosition: 'BTN', heroCards, board, street: 'FLOP',
    effectiveStackBB: 100, seatStacksBB: { UTG:100, BTN:100, BB:100 },
    actionHistory: [ {position:'UTG',type:'CALL',amountBB:1}, F('UTG1'),F('UTG2'),F('LJ'),F('HJ'),F('CO'),
      {position:'BTN',type:'CALL',amountBB:1}, F('SB'), {position:'BB',type:'CHECK'},
      {position:'BB',type:'CHECK',street:'FLOP'}, {position:'UTG',type:'CHECK',street:'FLOP'} ],
    environment:'MID_LOW_STAKES', villain:{quickProfile:profile,dynamicHint:'UNKNOWN'} };
}
function best(profile: string, heroCards: string[], board: string[]) {
  const input = spot(profile, heroCards, board);
  const parsed = parseManualInput(input as never); const g = buildAnalyzableState(parsed.value);
  const built = buildDecisionContext({state:g.state, rules:RULES, environment:'MID_LOW_STAKES', asOf:1757000000000, quickProfile:profile});
  const hero = g.state.players.find((x)=>x.holeCards!==null)!;
  const legal = deriveLegalActions(g.state, hero);
  const a = advisePostflop(built.context, { facingBet: legal.callCost>0, requiredEquity: built.context.math.requiredEquity, potAfterCall: built.context.math.pot+legal.callCost });
  const bd = a.betDecision; if (!bd) return 'n/a';
  const uniq = bd.legalSizes;
  let bestS = uniq[0];
  for (const s of uniq) if (s.score > bestS.score) bestS = s;
  return bestS.kind+'@'+bestS.betAmount.toFixed(1)+' ev='+bestS.betEV?.toFixed(2);
}
const cases: [string,string[],string[]][] = [
  ['KdTh / Ts7c3h', ['Kd','Th'], ['Ts','7c','3h']],
  ['AsKs / Qd8c2h', ['As','Ks'], ['Qd','8c','2h']],
  ['QsJs / Qh7d2c', ['Qs','Js'], ['Qh','7d','2c']],
  ['AhAd / Ks8d3c', ['Ah','Ad'], ['Ks','8d','3c']],
  ['7h6h / 8s5s2d', ['7h','6h'], ['8s','5s','2d']],
  ['JcJd / 9h6c3s', ['Jc','Jd'], ['9h','6c','3s']],
  ['AcKd / Ah9c4d', ['Ac','Kd'], ['Ah','9c','4d']],
];
for (const [name,h,b] of cases) {
  const st = best('CALLING_STATION',h,b), nt = best('VERY_TIGHT',h,b);
  console.log(name.padEnd(22), 'Station=', String(st).padEnd(22), 'Nit=', String(nt).padEnd(22), st===nt?'SAME':'DIFF');
}
