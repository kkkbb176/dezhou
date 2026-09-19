import { startAlphaServer } from '../src/app/webServer.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const dir = mkdtempSync(join(tmpdir(), 'v21rev3-'));
const server = await startAlphaServer({ port: 0, host: '127.0.0.1', rules: RULES, logPath: join(dir, 'l.jsonl') });
const input = {
  tableSize: 6, heroPosition: 'BB', heroCards: ['Ah','9h'], board: ['Kc','9s','5d','2h','7c'],
  street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  actionHistory: [
    { position: 'UTG', type: 'CALL', amountBB: 1 }, { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'CALL', amountBB: 1 }, { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'CHECK' },
    { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'UTG', type: 'CHECK', street: 'FLOP' },
    { position: 'CO', type: 'BET', amountBB: 1.5, street: 'FLOP' }, { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'FLOP' },
    { position: 'UTG', type: 'CALL', amountBB: 1.5, street: 'FLOP' },
    { position: 'BB', type: 'CHECK', street: 'TURN' }, { position: 'UTG', type: 'CHECK', street: 'TURN' },
    { position: 'CO', type: 'BET', amountBB: 4, street: 'TURN' }, { position: 'BB', type: 'CALL', amountBB: 4, street: 'TURN' },
    { position: 'UTG', type: 'CALL', amountBB: 4, street: 'TURN' },
    { position: 'BB', type: 'CHECK', street: 'RIVER' }, { position: 'UTG', type: 'CHECK', street: 'RIVER' },
    { position: 'CO', type: 'BET', amountBB: 12, street: 'RIVER' },
  ],
  environment: 'MID_LOW_STAKES',
  villain: { quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100 },
  villainPlayerId: 'seat_CO',
};
const res = await fetch(server.url + '/api/analyze', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ input }) });
const payload = await res.json();
console.log('top keys:', Object.keys(payload));
const d = payload.decision;
console.log('decision keys:', d === undefined ? 'undefined' : Object.keys(d));
console.log('view keys:', payload.view === undefined ? 'no view' : Object.keys(payload.view));
console.log(JSON.stringify(payload).slice(0, 1500));
await server.close();
rmSync(dir, { recursive: true, force: true });
