
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const round = process.argv[2];
const cacheDir = join(round, 'cache');
process.env['ALPHA_GTO_CACHE_DIR'] = cacheDir;
process.env['GTOPEN_URL'] = 'http://127.0.0.1:3761';
const { startAlphaServer } = await import('file:///D:/德州决策/src/app/webServer.ts');
const input = {
  tableSize: 9, heroPosition: 'BB', heroCards: ['Ah','Ad'], board: [], street: 'PREFLOP', effectiveStackBB: 100,
  actionHistory: [
    { position: 'UTG', type: 'RAISE', amountBB: 2.5, street: 'PREFLOP' },
    { position: 'UTG1', type: 'FOLD', street: 'PREFLOP' }, { position: 'UTG2', type: 'FOLD', street: 'PREFLOP' },
    { position: 'LJ', type: 'FOLD', street: 'PREFLOP' }, { position: 'HJ', type: 'FOLD', street: 'PREFLOP' },
    { position: 'CO', type: 'FOLD', street: 'PREFLOP' }, { position: 'BTN', type: 'FOLD', street: 'PREFLOP' },
    { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
  ], environment: 'LOW_STAKES_ONLINE',
};
const server = await startAlphaServer({ port: 0, host: '127.0.0.1', gtoBackgroundSolve: false, logPath: null });
try {
  const started = Date.now();
  const res = await fetch(server.url + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input, mode: 'OFF' }) });
  const body = await res.json();
  const r = body.result ?? body; const vm = r.viewModel ?? {};
  const math = (vm?.debug?.math ?? []).find(m => String(m.label).includes('整体范围权益'))?.value ?? null;
  const out = {
    processId: globalThis.process?.pid ?? null,
    elapsedMs: Date.now() - started,
    httpStatus: res.status,
    gtoStatus: r.gtoStatus ?? null,
    rangeProvenance: (r.rangeProvenance ?? []).map(p => ({ positionZh: p.positionZh, sourceKind: p.sourceKind, fromSolver: p.fromSolver, confidence: p.confidence, supportSize: p.supportSize, effectiveComboCount: p.effectiveComboCount, normalizedEntropy: p.normalizedEntropy, gtoOutcomeState: p.gtoOutcomeState, gtoReasonZh: p.gtoReasonZh })),
    actionZh: vm.actionZh ?? null, sizeZh: vm.sizeZh ?? null, equity: math,
    cacheFiles: (() => { const out=[]; const walk=d=>{ if(!existsSync(d)) return; for(const e of readdirSync(d,{withFileTypes:true})){ const p=join(d,e.name); if(e.isDirectory()) walk(p); else out.push({path:p,bytes:statSync(p).size}); }}; walk(cacheDir); return out; })(),
  };
  console.log(JSON.stringify(out, null, 2));
} finally { await server.close(); }

