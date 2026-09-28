import { readFileSync } from 'node:fs';
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
const out = await prefetchSolverRangesForInput(input as never, { gtoProvider: gtoProvider(), gtoLookup: gtoCachedLookup() });
const prior = out.outcomes[0]!.prior!;
console.log('PROD_PRIOR_SUM=' + Object.values(prior.weights).reduce((a,b)=>a+b,0).toFixed(6));
console.log('PROD_POSITIVE=' + Object.values(prior.weights).filter(v=>v>0).length);
console.log('PROD_AA=' + prior.weights['AA'] + ' PROD_AJo=' + prior.weights['AJo'] + ' PROD_72o=' + prior.weights['72o']);

const raw = JSON.parse(readFileSync('./data/gto-cache/strategy/c134d931a.json','utf8'));
const hands = raw.range.hands;
let indep = 0, pos = 0, aa=0, ajo=0, o72=0;
for (const h of hands) {
  let w = 0;
  for (const a of h.actions) if (a.kind==='RAISE'||a.kind==='ALL_IN') w += a.frequency;
  w = Math.min(1,Math.max(0,w));
  indep += w;
  if (w>0) pos++;
  if (h.hand==='AA') aa=w;
  if (h.hand==='AJo') ajo=w;
  if (h.hand==='72o') o72=w;
}
console.log('INDEP_SUM=' + indep.toFixed(6));
console.log('INDEP_POSITIVE=' + pos);
console.log('INDEP_AA=' + aa + ' INDEP_AJo=' + ajo + ' INDEP_72o=' + o72);
console.log('HANDS_COUNT=' + hands.length);
console.log('HAND_ORDER_FIRST5=' + hands.slice(0,5).map(h=>h.hand).join(','));
