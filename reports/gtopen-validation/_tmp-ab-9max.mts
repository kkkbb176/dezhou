import { analyzeManualHand } from '../../src/app/alphaPipeline.ts';
import { prefetchSolverRangesForInput } from '../../src/app/alphaPipeline.ts';
import { gtoCachedLookup, gtoProvider } from '../../src/app/gto/gtoApi.ts';

const input = {
  tableSize: 9, heroPosition: 'BB', heroCards: ['Ah','Ad'], board: [], street: 'PREFLOP',
  effectiveStackBB: 40,
  actionHistory: [
    { position: 'UTG', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'UTG1', type: 'FOLD', street: 'PREFLOP' },
    { position: 'UTG2', type: 'FOLD', street: 'PREFLOP' },
    { position: 'LJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'CO', type: 'FOLD', street: 'PREFLOP' },
    { position: 'BTN', type: 'FOLD', street: 'PREFLOP' },
    { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
  ],
  environment: 'LOW_STAKES_ONLINE',
};

const A = analyzeManualHand(input as never, { asOf: 1758500000000 });
const pf = await prefetchSolverRangesForInput(input as never, { gtoProvider: gtoProvider(), gtoLookup: gtoCachedLookup() });
const B = analyzeManualHand(input as never, { asOf: 1758500000000, gtoRanges: pf.ranges });

function summary(r:any,label:string){
  const d = r.decision ?? r;
  console.log('=== ' + label + ' ===');
  console.log('ok=' + r.ok);
  const diag = d.diagnostics;
  if (diag) {
    console.log('opponentRanges=' + JSON.stringify(diag.opponentRanges?.map((x:any)=>({pos:x.opponentPositionZh, sourceId:x.sourceId, conf:x.confidence, combos:x.supportSize}))));
  }
  const eq = d.equity ?? d.equityEstimate;
  console.log('equity=' + JSON.stringify(eq));
  const acts = d.actions ?? d.actionEVs ?? d.actionEvs;
  if (acts) console.log('actions=' + JSON.stringify(acts).slice(0,1500));
  console.log('recommended=' + JSON.stringify(d.recommended ?? d.recommendation ?? d.chosen)).slice(0,600));
}
try { summary(A,'A 无求解器'); } catch(e){ console.log('A err', e); }
try { summary(B,'B 有求解器'); } catch(e){ console.log('B err', e); }
console.log('RANGES_KEYS=' + Object.keys(pf.ranges));
