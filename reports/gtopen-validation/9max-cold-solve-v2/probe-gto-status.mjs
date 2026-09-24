process.env['ALPHA_GTO_CACHE_DIR'] = 'D:/德州决策/reports/gtopen-validation/9max-cold-solve-v2/cache';
process.env['GTOPEN_URL'] = 'http://127.0.0.1:3757';
const { startAlphaServer } = await import('file:///D:/德州决策/src/app/webServer.ts');
const input = { tableSize: 9, heroPosition: 'BB', heroCards: ['Ah','Ad'], board: [], street: 'PREFLOP', effectiveStackBB: 100, actionHistory: [ { position:'UTG', type:'RAISE', amountBB:2.5, street:'PREFLOP' }, { position:'UTG1', type:'FOLD', street:'PREFLOP' }, { position:'UTG2', type:'FOLD', street:'PREFLOP' }, { position:'LJ', type:'FOLD', street:'PREFLOP' }, { position:'HJ', type:'FOLD', street:'PREFLOP' }, { position:'CO', type:'FOLD', street:'PREFLOP' }, { position:'BTN', type:'FOLD', street:'PREFLOP' }, { position:'SB', type:'FOLD', street:'PREFLOP' } ], environment:'LOW_STAKES_ONLINE' };
const server = await startAlphaServer({ port: 0, host: '127.0.0.1', gtoBackgroundSolve: true, logPath: null });
try {
  const res = await fetch(server.url + '/api/analyze', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ input, mode:'OFF' }) });
  const body = await res.json();
  const r = body.result ?? body;
  console.log(JSON.stringify({ httpStatus: res.status, gtoStatus: r.gtoStatus, rangeProvenance: r.rangeProvenance, actionZh: r.viewModel?.actionZh, sizeZh: r.viewModel?.sizeZh, decision: r.decision }, null, 2));
} finally { await server.close(); }
