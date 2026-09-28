/*
 * KQ FLOP RAISE 42BB CHECK — deep evidence dump (read-only).
 * Variant A (no read) and B (AGGRESSIVE label): full decision internals.
 */
const BASE = 'http://127.0.0.1:5173';

const base = {
  tableSize: 9,
  heroPosition: 'CO',
  heroCards: ['Ks', 'Qs'],
  board: ['Qh', '9s', '5s'],
  street: 'FLOP',
  effectiveStackBB: 100,
  bigBlindBB: 100,
  environment: 'LOW_STAKES_ONLINE',
  occupiedPositions: ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  buttonPosition: 'BTN',
  potBB: 23,
  actionHistory: [
    { position: 'UTG', type: 'FOLD', street: 'PREFLOP' },
    { position: 'UTG1', type: 'FOLD', street: 'PREFLOP' },
    { position: 'UTG2', type: 'FOLD', street: 'PREFLOP' },
    { position: 'LJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'HJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'BTN', type: 'FOLD', street: 'PREFLOP' },
    { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
    { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'PREFLOP' },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
    { position: 'CO', type: 'BET', amountBB: 3.5, street: 'FLOP' },
    { position: 'BB', type: 'RAISE', amountBB: 14, street: 'FLOP' },
  ],
};

async function analyze(input) {
  const r = await fetch(BASE + '/api/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  return r.json();
}

const show = (title, obj, cap = 2600) => {
  console.log(`\n--- ${title} ---`);
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1).slice(0, cap));
};

for (const [label, mutate] of [
  ['A 默认（无读牌）', (v) => { delete v.villain; delete v.seatProfiles; }],
  ['B AGGRESSIVE 标签', (v) => { v.seatProfiles = { BB: 'AGGRESSIVE' }; v.villain = { position: 'BB', quickProfile: 'AGGRESSIVE' }; }],
]) {
  const input = structuredClone(base);
  mutate(input);
  const b = await analyze(input);
  console.log(`\n${'#'.repeat(78)}\n## ${label}\n${'#'.repeat(78)}`);
  console.log('decision:', JSON.stringify(b.decision));
  const d = b.viewModel.debug;

  show('allReasonsZh (complete)', b.viewModel.allReasonsZh);
  show('warningsZh', b.viewModel.warningsZh);
  show('decisionSource', d.decisionSource);
  show('decisionMargin', d.decisionMargin);
  show('decisionBasis', d.decisionBasis, 1800);
  show('betDecision', d.betDecision, 2600);
  show('postflop', d.postflop, 3000);
  show('degradations', d.degradations, 1200);
  show('versions', d.versions, 800);
  show('consistency', d.consistency, 900);
}
