import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mode = (process.argv[2] || 'A').toUpperCase();
const productionCache = 'D:/德州决策/data/gto-cache';
const cacheDir = mode === 'B' ? productionCache : mkdtempSync(join(tmpdir(), 'gtopen-9max-r7-A-'));
process.env['ALPHA_GTO_CACHE_DIR'] = cacheDir;
process.env['GTOPEN_URL'] = 'http://127.0.0.1:3737';
const { startAlphaServer } = await import('file:///D:/德州决策/src/app/webServer.ts');

const input = {
  tableSize: 9, heroPosition: 'BB', heroCards: ['Ah', 'Ad'], board: [], street: 'PREFLOP',
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

const idxPath = join(cacheDir, 'index.json');
let indexKeys = [];
if (existsSync(idxPath)) {
  try { indexKeys = (JSON.parse(readFileSync(idxPath, 'utf8')).entries ?? []).map((e) => e.cacheKey); } catch {}
}

function val(vm, n) {
  const row = (vm.debug?.math ?? []).find((m) => String(m.label).includes(n));
  return row ? row.value : null;
}
function summarize(body) {
  const r = body.result ?? body; const vm = r.viewModel;
  return {
    ok: r.ok, actionZh: vm.actionZh, sizeZh: vm.sizeZh, decision: r.decision,
    equity: val(vm, '整体范围权益'), callEv: val(vm, '跟注 EV'),
    gtoStatus: r.gtoStatus,
    rangeProvenance: (r.rangeProvenance ?? []).map((p) => ({
      sourceKind: p.sourceKind, fromSolver: p.fromSolver, confidence: p.confidence,
      supportSize: p.supportSize, effectiveComboCount: p.effectiveComboCount,
      normalizedEntropy: p.normalizedEntropy, gtoOutcomeState: p.gtoOutcomeState,
    })),
  };
}

const server = await startAlphaServer({ port: 0, host: '127.0.0.1', gtoBackgroundSolve: false, logPath: null });
try {
  const t0 = Date.now();
  const res = await fetch(server.url + '/api/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, mode: 'OFF' }),
  });
  const body = await res.json();
  const out = { mode, cacheDir, cacheDirExists: existsSync(cacheDir), indexKeys, elapsedMs: Date.now() - t0, httpStatus: res.status, ...summarize(body) };
  console.log(JSON.stringify(out, null, 2));
} finally {
  await server.close();
  if (mode === 'A') rmSync(cacheDir, { recursive: true, force: true });
}
