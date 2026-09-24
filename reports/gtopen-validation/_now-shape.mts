const input = { tableSize: 9, heroPosition: 'BB', heroCards: ['Ah','Ad'], board: [], street: 'PREFLOP', effectiveStackBB: 100,
  actionHistory: [
    { position: 'UTG', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'UTG1', type: 'FOLD', street: 'PREFLOP' },
    { position: 'UTG2', type: 'FOLD', street: 'PREFLOP' },
    { position: 'LJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'CO', type: 'FOLD', street: 'PREFLOP' },
    { position: 'BTN', type: 'FOLD', street: 'PREFLOP' },
    { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
  ], environment: 'LOW_STAKES_ONLINE' };
const { analyzeManualHand } = await import('../../src/app/alphaPipeline.ts');
const r = analyzeManualHand(input, { asOf: 1758500000000 });
console.log('OK=' + r.ok);
console.log('KEYS=' + JSON.stringify(Object.keys(r)));
console.log(JSON.stringify(r, null, 1).slice(0, 3000));

