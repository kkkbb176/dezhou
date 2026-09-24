import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startAlphaServer, type AlphaServer } from '../src/app/webServer.ts';
import { createTable } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';
import { isGtoEnabled, setGtoEnabled } from '../src/app/gto/gtoApi.ts';
import { AnalysisScheduler, AnalysisSchedulingError } from '../src/app/analysisScheduler.ts';
import { tableStateToManualHandInput } from '../src/app/table/tableAdapter.ts';

function slowTable(): PokerTableState {
  let state = createTable({ tableId: 'scheduling-real-flop', heroPosition: 'CO' });
  const ops: TableOp[] = [
    { kind: 'FILL_EMPTY_SEATS' },
    { kind: 'SET_HERO_CARD', card: 'As' }, { kind: 'SET_HERO_CARD', card: 'Kd' },
    { kind: 'ACT', action: { type: 'FOLD' } }, { kind: 'ACT', action: { type: 'FOLD' } },
    { kind: 'ACT', action: { type: 'RAISE', amountChips: 300 } },
    { kind: 'ACT', action: { type: 'FOLD' } }, { kind: 'ACT', action: { type: 'FOLD' } },
    { kind: 'ACT', action: { type: 'CALL' } },
    { kind: 'SET_BOARD_CARD', card: 'Kh', slot: 0 },
    { kind: 'SET_BOARD_CARD', card: '7c', slot: 1 },
    { kind: 'SET_BOARD_CARD', card: '2d', slot: 2 },
    { kind: 'ACT', action: { type: 'BET', amountChips: 300 } },
  ];
  for (const op of ops) {
    if (op.kind === 'ACT' && op.action.type === 'CALL') {
      const call = buildTablePreview(state).actionButtons.find((b) => b.type === 'CALL');
      assert.ok(call);
      op.action.amountChips = call.amountChips;
    }
    const result = applyTableOp(state, op);
    assert.ok(result.ok, JSON.stringify(result));
    state = result.state;
  }
  return state;
}

async function withServer(run: (server: AlphaServer) => Promise<void>) {
  const history = mkdtempSync(join(tmpdir(), 'analysis-scheduling-'));
  const oldHistory = process.env.DSH_PLAYER_HISTORY_DIR;
  const oldGto = isGtoEnabled();
  process.env.DSH_PLAYER_HISTORY_DIR = history;
  setGtoEnabled(false);
  const server = await startAlphaServer({ port: 0, logPath: null, gtoBackgroundSolve: false });
  try { await run(server); }
  finally {
    await server.close();
    setGtoEnabled(oldGto);
    if (oldHistory === undefined) delete process.env.DSH_PLAYER_HISTORY_DIR;
    else process.env.DSH_PLAYER_HISTORY_DIR = oldHistory;
    rmSync(history, { recursive: true, force: true });
  }
}

function post(server: AlphaServer, path: string, body: unknown, signal?: AbortSignal) {
  return fetch(`${server.url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  });
}

async function until(check: () => Promise<boolean> | boolean, message: string, timeoutMs = 5000) {
  const started = performance.now();
  while (!(await check())) {
    assert.ok(performance.now() - started < timeoutMs, message);
    await delay(5);
  }
}

async function stats(server: AlphaServer) {
  return ((await (await fetch(`${server.url}/api/health`)).json()) as {
    analysis: { active: number; pending: number; computing: boolean; cancellations: number; completed: number }
  }).analysis;
}

test('FAST server: replay a lost mutation response exactly once; reused ID with different payload is rejected', async () => {
  await withServer(async (server) => {
    const create = { tableSize: 6, requestId: 'create-retry' };
    const first = await (await post(server, '/api/table', create)).json() as any;
    const replay = await (await post(server, '/api/table', create)).json();
    assert.deepEqual(replay, first);
    const mutation = { state: first.state, requestId: 'fill-retry', op: { kind: 'FILL_EMPTY_SEATS' } };
    const changed = await (await post(server, '/api/table', mutation)).json() as any;
    assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.equal(changed.state.revision, first.state.revision + 1);
    assert.deepEqual(await (await post(server, '/api/table', mutation)).json(), changed);
    const conflict = await post(server, '/api/table', { ...mutation, op: { kind: 'SET_HERO_CARD', card: 'Ks' } });
    assert.equal(conflict.status, 409);
    const stale = await (await post(server, '/api/table', { ...mutation, requestId: 'new-id-old-state' })).json() as any;
    assert.equal(stale.ok, false, 'new request ID must still pass RevisionGuard');
  });
});

test('FAST server: real flop computation does not block /api/table; mutation terminates obsolete worker', async (t) => {
  await withServer(async (server) => {
    const table = slowTable();
    const analysis = post(server, '/api/analyze', { table, modeEpoch: 1, requestToken: 1 });
    await until(async () => (await stats(server)).computing, 'real worker never entered pipeline');
    const started = performance.now();
    const mutation = await post(server, '/api/table', { state: table, requestId: 'undo-running-analysis', op: { kind: 'UNDO' } });
    const latency = performance.now() - started;
    assert.equal((await mutation.json() as any).ok, true);
    assert.ok(latency < 500, `table operation took ${latency.toFixed(1)} ms`);
    const obsolete = await analysis;
    assert.equal(obsolete.status, 409);
    assert.equal((await obsolete.json() as any).issues[0].code, 'ANALYSIS_CANCELLED');
    await until(async () => (await stats(server)).active === 0, 'obsolete worker did not terminate', 1000);
    const final = await stats(server);
    assert.equal(final.completed, 0, 'CPU job must be interrupted, not allowed to finish and merely hide output');
    assert.equal(final.cancellations, 1);
    t.diagnostic(`real-compute concurrent /api/table latency ${latency.toFixed(1)} ms; worker terminated before completion`);
  });
});

test('FAST server: aborting fetch interrupts the actual worker after the POST body completed', async () => {
  await withServer(async (server) => {
    const controller = new AbortController();
    const analysis = post(server, '/api/analyze', { table: slowTable() }, controller.signal)
      .then(() => 'completed', (error: Error) => error.name);
    await until(async () => (await stats(server)).computing, 'real worker never entered pipeline');
    controller.abort();
    assert.equal(await analysis, 'AbortError');
    await until(async () => (await stats(server)).active === 0, 'disconnect did not terminate worker', 1000);
    const final = await stats(server);
    assert.equal(final.completed, 0);
    assert.equal(final.cancellations, 1);
  });
});

test('FAST server: latest epoch cancels prior work; successful output reports measured timing and identity', async () => {
  await withServer(async (server) => {
    const table = slowTable();
    const obsolete = post(server, '/api/analyze', { table, modeEpoch: 1, requestToken: 1 });
    await until(async () => (await stats(server)).computing, 'real worker never entered pipeline');
    const current = post(server, '/api/analyze', { table, modeEpoch: 2, requestToken: 2 });
    assert.equal((await obsolete).status, 409);
    const response = await current;
    const result = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.meta.request, { tableId: table.tableId, revision: table.revision, modeEpoch: 2, requestToken: 2 });
    assert.ok(result.meta.serverTimings.computeMs > 0);
    assert.ok(result.meta.serverTimings.totalMs >= result.meta.serverTimings.computeMs);
    assert.ok(result.meta.serverTimings.queueMs >= 0);
    const delayed = await post(server, '/api/analyze', { table, modeEpoch: 1, requestToken: 3 });
    assert.equal(delayed.status, 409, 'late earlier mode cannot replace latest accepted mode');
    assert.equal((await stats(server)).completed, 1);
  });
});

test('FAST scheduler: one real worker and one latest pending slot; extra independent work is rejected', async () => {
  const scheduler = new AnalysisScheduler();
  const adapted = tableStateToManualHandInput(slowTable());
  assert.ok(adapted.ok);
  const work = async () => ({ input: adapted.input, table: null, options: { rules: [], writeLog: false } });
  const first = new AbortController();
  const second = new AbortController();
  try {
    const a = scheduler.run('a', work, first.signal).catch((e) => e);
    await until(() => scheduler.stats().computing, 'real worker never entered pipeline');
    const b = scheduler.run('b', work, second.signal).catch((e) => e);
    await assert.rejects(scheduler.run('c', work, new AbortController().signal),
      (e: unknown) => e instanceof AnalysisSchedulingError && e.code === 'ANALYSIS_BUSY');
    const replacement = scheduler.run('b', work, second.signal);
    assert.equal((await b).code, 'ANALYSIS_CANCELLED');
    assert.equal(scheduler.stats().active, 1);
    assert.equal(scheduler.stats().pending, 1);
    first.abort();
    assert.equal((await a).code, 'ANALYSIS_CANCELLED');
    assert.equal((await replacement).output.result.ok, true);
    await until(() => scheduler.stats().active === 0, 'finished worker did not exit');
    assert.equal(scheduler.stats().completed, 1);
  } finally { await scheduler.close(); }
});
