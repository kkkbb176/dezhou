/*
 * KQ FLOP RAISE 42BB CHECK — locate every field feeding the chosen-size raise EV.
 */
const BASE = 'http://127.0.0.1:5173';
const input = {
  tableSize: 9, heroPosition: 'CO', heroCards: ['Ks', 'Qs'], board: ['Qh', '9s', '5s'],
  street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 100, environment: 'LOW_STAKES_ONLINE',
  occupiedPositions: ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  buttonPosition: 'BTN', potBB: 23,
  actionHistory: [
    { position: 'UTG', type: 'FOLD', street: 'PREFLOP' }, { position: 'UTG1', type: 'FOLD', street: 'PREFLOP' },
    { position: 'UTG2', type: 'FOLD', street: 'PREFLOP' }, { position: 'LJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'FOLD', street: 'PREFLOP' }, { position: 'CO', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'BTN', type: 'FOLD', street: 'PREFLOP' }, { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
    { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'PREFLOP' },
    { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'CO', type: 'BET', amountBB: 3.5, street: 'FLOP' },
    { position: 'BB', type: 'RAISE', amountBB: 14, street: 'FLOP' },
  ],
};
const r = await fetch(BASE + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input }) });
const b = await r.json();
const d = b.viewModel.debug;

console.log('=== ALL debug keys present ===');
console.log(Object.keys(d).join(' '));

const seenAlready = new Set(['math', 'candidates', 'player', 'profileRange', 'decisionMargin', 'betDecision', 'postflop', 'decisionSource', 'decisionBasis']);
console.log('\n=== remaining blocks ===');
for (const [k, v] of Object.entries(d)) {
  if (seenAlready.has(k)) continue;
  const s = JSON.stringify(v);
  console.log(`\n--- ${k} (${s.length} chars) ---`);
  console.log(s.slice(0, 1500));
}

console.log('\n=== hunt for the raise-response numbers anywhere in the response ===');
const full = JSON.stringify(b);
for (const needle of ['1948.14', '0.3128', '88.0', '7.7', '4.3', 'PUBLIC_BAND_RAISE_RESPONSE', 'raiseModelUsable', 'EqVsRaise', 'conditional', 'finalPot', 'heroAdd', 'villainAdd']) {
  const i = full.indexOf(needle);
  console.log(`"${needle}": ${i < 0 ? 'NOT FOUND' : 'found @' + i + ' -> ...' + full.slice(Math.max(0, i - 160), i + 200).replace(/\s+/g, ' ')}`);
}
