const base = 'http://127.0.0.1:5173';
const input = {
  tableSize: 9,
  heroPosition: 'BB',
  heroCards: ['Ah', 'Ad'],
  board: [],
  street: 'PREFLOP',
  effectiveStackBB: 100,
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
const t0 = Date.now();
const res = await fetch(base + '/api/analyze', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({input, mode:'OFF'}) });
const body = await res.json();
const out = { httpStatus: res.status, elapsedMs: Date.now()-t0, input, body };
await import('node:fs').then(fs => fs.writeFileSync('reports/gtopen-validation/9max-known-node-round6/raw-analyze.json', JSON.stringify(out, null, 2)));
console.log(JSON.stringify({httpStatus:out.httpStatus, elapsedMs:out.elapsedMs, ok:body.result?.ok, state:body.result?.gtoStatus?.state, cacheKey:body.result?.gtoStatus?.background?.[0]?.cacheKey, source:body.result?.rangeProvenance?.[0]?.sourceKind}, null, 2));
