import { startAlphaServer } from '../../src/app/webServer.ts';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const input = {
  tableSize: 9,
  heroPosition: 'BB',
  heroCards: ['Ah', 'Ad'],
  board: [],
  street: 'PREFLOP',
  effectiveStackBB: 40,
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

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const cacheDir = mkdtempSync(join(tmpdir(), 'gtopen-9max-readonly-'));
const server = await startAlphaServer({ port: 0, host: '127.0.0.1', gtoCacheDir: cacheDir, gtoBackgroundSolve: false });
try {
  const url = server.url + '/api/analyze';
  const out = await postJson(url, { input });
  console.log(JSON.stringify({ ok: true, serverUrl: server.url, httpStatus: out.status, result: out.json }, null, 2));
} finally {
  await server.close();
  rmSync(cacheDir, { recursive: true, force: true });
}
