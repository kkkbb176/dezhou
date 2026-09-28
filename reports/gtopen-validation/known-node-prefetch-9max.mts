import { prefetchSolverRangesForInput } from '../../src/app/alphaPipeline.ts';
import { gtoCachedLookup, gtoProvider, gtoHealth, isGtoEnabled } from '../../src/app/gto/gtoApi.ts';

const input = {
  tableSize: 9 as const,
  heroPosition: 'BB',
  heroCards: ['Ah', 'Ad'] as const,
  board: [] as string[],
  street: 'PREFLOP' as const,
  effectiveStackBB: 40,
  actionHistory: [
    { position: 'UTG' as const, type: 'RAISE' as const, amountBB: 2.5, street: 'PREFLOP' as const },
    { position: 'UTG1' as const, type: 'FOLD' as const, street: 'PREFLOP' as const },
    { position: 'UTG2' as const, type: 'FOLD' as const, street: 'PREFLOP' as const },
    { position: 'LJ' as const, type: 'FOLD' as const, street: 'PREFLOP' as const },
    { position: 'HJ' as const, type: 'FOLD' as const, street: 'PREFLOP' as const },
    { position: 'CO' as const, type: 'FOLD' as const, street: 'PREFLOP' as const },
    { position: 'BTN' as const, type: 'FOLD' as const, street: 'PREFLOP' as const },
    { position: 'SB' as const, type: 'FOLD' as const, street: 'PREFLOP' as const },
  ],
  environment: 'LOW_STAKES_ONLINE' as const,
};

console.log('enabled=' + isGtoEnabled());
console.log('health=' + JSON.stringify(await gtoHealth(), null, 2));
const out = await prefetchSolverRangesForInput(input as never, { gtoProvider: gtoProvider(), gtoLookup: gtoCachedLookup() });
console.log('prefetch=' + JSON.stringify(out, null, 2));
