import { prefetchSolverRangesForInput } from '../../src/app/alphaPipeline.ts';
import { parseManualInput } from '../../src/app/manualInput/manualInput.ts';
import { gtoCachedLookup, gtoProvider, gtoHealth, isGtoEnabled } from '../../src/app/gto/gtoApi.ts';

const input = {
  tableSize: 9,
  heroPosition: 'BB',
  heroCards: ['Ah', 'Ad'],
  board: [],
  street: 'PREFLOP',
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
console.log('enabled=' + isGtoEnabled());
console.log('health=' + JSON.stringify(await gtoHealth()));
const parsed = parseManualInput(input);
console.log('parsed=' + JSON.stringify(parsed, null, 2));
const out = await prefetchSolverRangesForInput(input, { gtoProvider: gtoProvider(), gtoLookup: gtoCachedLookup() });
console.log('prefetch=' + JSON.stringify(out, null, 2));
