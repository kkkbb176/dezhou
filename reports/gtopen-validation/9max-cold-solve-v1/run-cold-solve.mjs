import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const roundDir = dirname(fileURLToPath(import.meta.url));
const cacheDir = join(roundDir, 'cache');
const solverDir = join(roundDir, 'solver-cache');
const solverUrl = process.env.GTOPEN_URL ?? 'http://127.0.0.1:3747';
const outPath = join(roundDir, 'cold-solve-run.json');
const budgetMs = Number(process.env.COLD_SOLVE_BUDGET_MS ?? 600000);
const key = 'c7348fc89';

process.env['ALPHA_GTO_CACHE_DIR'] = cacheDir;
process.env['GTOPEN_URL'] = solverUrl;

const { startAlphaServer } = await import('file:///D:/德州决策/src/app/webServer.ts');

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

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push({ path: p, bytes: statSync(p).size, sha256: sha256File(p) });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function mathValue(vm, needle) {
  return (vm?.debug?.math ?? []).find((m) => String(m.label).includes(needle))?.value ?? null;
}

function extract(body, elapsedMs, httpStatus) {
  const r = body.result ?? body;
  const vm = r.viewModel ?? {};
  return {
    httpStatus,
    elapsedMs,
    actionZh: vm.actionZh ?? null,
    sizeZh: vm.sizeZh ?? null,
    decision: r.decision ?? null,
    equity: mathValue(vm, '整体范围权益'),
    callEv: mathValue(vm, '跟注 EV'),
    candidates: (vm.debug?.candidates ?? []).map((c) => ({ action: c.actionZh, size: c.sizeZh, ev: c.evZh })),
    gtoStatus: r.gtoStatus ?? null,
    rangeProvenance: (r.rangeProvenance ?? []).map((p) => ({
      positionZh: p.positionZh,
      sourceKind: p.sourceKind,
      fromSolver: p.fromSolver,
      confidence: p.confidence,
      supportSize: p.supportSize,
      effectiveComboCount: p.effectiveComboCount,
      normalizedEntropy: p.normalizedEntropy,
      gtoOutcomeState: p.gtoOutcomeState,
      gtoReasonZh: p.gtoReasonZh,
    })),
    meta: r.meta ?? null,
  };
}

async function analyze(server, timeline, label) {
  const started = Date.now();
  const res = await fetch(server.url + '/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, mode: 'OFF' }),
  });
  const body = await res.json();
  const elapsed = Date.now() - started;
  const extracted = extract(body, elapsed, res.status);
  const bg = extracted.gtoStatus?.background?.find((b) => b.cacheKey === key) ?? null;
  timeline.push({
    event: label,
    atMs: Date.now() - runStarted,
    httpStatus: res.status,
    elapsedMs: elapsed,
    foregroundState: extracted.gtoStatus?.state ?? null,
    background: bg,
    cacheFiles: listFiles(cacheDir),
  });
  return { extracted, raw: body, bg };
}

const before = {
  cacheDir,
  cacheDirExists: existsSync(cacheDir),
  cacheFiles: listFiles(cacheDir),
  solverDir,
  solverDirExists: existsSync(solverDir),
  solverFiles: listFiles(solverDir),
  solverUrl,
};
if (before.cacheFiles.length !== 0) throw new Error(`isolated decision cache is not empty: ${JSON.stringify(before.cacheFiles)}`);
if (before.solverFiles.length !== 0) throw new Error(`isolated solver cache is not empty: ${JSON.stringify(before.solverFiles)}`);

const solverStatusRes = await fetch(solverUrl + '/api/status');
const solverStatusBefore = await solverStatusRes.json();
if (!solverStatusRes.ok) throw new Error(`isolated solver status failed: HTTP ${solverStatusRes.status}`);
let isolatedSessionBefore = null;
try {
  const s = await fetch(solverUrl + '/api/preflop/session');
  if (s.ok) isolatedSessionBefore = await s.json();
} catch {}
if (isolatedSessionBefore !== null && isolatedSessionBefore?.action_nodes) {
  throw new Error('isolated solver already had a preflop session before the first request');
}

const server = await startAlphaServer({ port: 0, host: '127.0.0.1', gtoBackgroundSolve: true, logPath: null });
const timeline = [];
const runStarted = Date.now();
let first = null;
let second = null;
let last = null;
try {
  first = await analyze(server, timeline, 'first-analyze-response');
  last = first;

  const deadline = Date.now() + budgetMs;
  let pollCount = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    pollCount += 1;
    const poll = await analyze(server, timeline, `poll-${pollCount}`);
    last = poll;
    const state = poll.bg?.state ?? null;
    if (state === 'DONE' || state === 'FAILED') break;
  }

  second = await analyze(server, timeline, 'post-solve-analyze-response');
  last = second;
} finally {
  await server.close();
}

const after = {
  cacheFiles: listFiles(cacheDir),
  solverFiles: listFiles(solverDir),
};
const targetFile = after.cacheFiles.find((f) => f.path.toLowerCase().includes(key)) ?? null;
const result = {
  generatedAt: new Date().toISOString(),
  solverUrl,
  budgetMs,
  before,
  isolatedSolverStatusBefore: solverStatusBefore,
  isolatedSessionBefore,
  first: first?.extracted ?? null,
  second: second?.extracted ?? null,
  finalBackground: last?.bg ?? null,
  timeline,
  after,
  targetFile,
};
mkdirSync(roundDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({
  outPath,
  firstForeground: first?.extracted.gtoStatus?.state ?? null,
  firstBackground: first?.bg ?? null,
  finalForeground: second?.extracted.gtoStatus?.state ?? null,
  finalBackground: last?.bg ?? null,
  actionZh: second?.extracted.actionZh ?? null,
  sizeZh: second?.extracted.sizeZh ?? null,
  cacheFiles: after.cacheFiles.map((f) => f.path),
}, null, 2));
