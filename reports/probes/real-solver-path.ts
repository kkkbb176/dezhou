/** 探针：真实生产路径 + 真实缓存 */
import { prefetchSolverRangesForInput } from '../../src/app/alphaPipeline.ts';
import { gtoProvider, gtoCachedLookup, setGtoEnabled } from '../../src/app/gto/gtoApi.ts';
import { Position, Street } from '../../src/domain/types.ts';
import type { ManualHandInput } from '../../src/app/manualInput/manualInput.ts';

setGtoEnabled(true);

const input: ManualHandInput = {
  tableSize: 6,
  heroPosition: Position.BB,
  heroCards: ['Ah', 'Kh'],
  board: [],
  street: Street.PREFLOP,
  effectiveStackBB: 100,
  actionHistory: [
    { position: Position.UTG, type: 'RAISE', amountBB: 2.5 },
    { position: Position.HJ, type: 'FOLD' },
    { position: Position.CO, type: 'FOLD' },
    { position: Position.BTN, type: 'FOLD' },
    { position: Position.SB, type: 'FOLD' },
  ],
  environment: 'MID_LOW_STAKES',
  villain: { quickProfile: 'NORMAL' },
};

const prefetched = await prefetchSolverRangesForInput(input, {
  gtoProvider: gtoProvider(),
  gtoLookup: gtoCachedLookup(),
});

console.log('ranges keys:', Object.keys(prefetched.ranges));
console.log('outcomes:', JSON.stringify(prefetched.outcomes, null, 2));
console.log('warnings:', JSON.stringify(prefetched.warnings, null, 2));
console.log('elapsedMs:', prefetched.elapsedMs);
