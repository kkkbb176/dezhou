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
const r = body.result ?? body; const vm = r.viewModel ?? {};
const val = (n) => (vm.debug?.math ?? []).find(m => String(m.label).includes(n))?.value ?? null;
console.log(JSON.stringify({httpStatus:res.status, elapsedMs:Date.now()-t0, input, ok:r.ok, actionZh:vm.actionZh, sizeZh:vm.sizeZh, decision:r.decision, equity:val('整体范围权益'), callEv:val('跟注 EV'), gtoStatus:r.gtoStatus, rangeProvenance:r.rangeProvenance, meta:r.meta, candidates:(vm.debug?.candidates??[]).map(c=>({action:c.actionZh,size:c.sizeZh,ev:c.evZh}))}, null, 2));
