import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { startAlphaServer } = await import('../../../src/app/webServer.ts');

const OUT = 'D:/德州决策/reports/gtopen-validation/9max-known-node-v1';
const PROD_CACHE = 'D:/德州决策/data/gto-cache';
const READONLY_CACHE = OUT + '/cache-readonly-20260922-161900';

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

function valueOf(viewModel, needle) {
  const row = (viewModel.debug?.math ?? []).find((m) => String(m.label).includes(needle));
  return row ? row.value : null;
}

function summarize(payload) {
  const result = payload.result ?? payload;
  const vm = result.viewModel;
  const outcomes = result.gtoStatus?.outcomes ?? [];
  const provenance = result.rangeProvenance ?? [];
  const candidates = (vm.debug?.candidates ?? []).map((c) => ({
    action: c.actionZh,
    size: c.sizeZh,
    ev: c.evZh,
  }));
  return {
    ok: result.ok,
    actionZh: vm.actionZh,
    sizeZh: vm.sizeZh,
    confidenceZh: vm.confidenceZh,
    classificationZh: vm.classificationZh,
    equity: valueOf(vm, '整体范围权益'),
    callEv: valueOf(vm, '跟注 EV'),
    candidates,
    reasonsZh: vm.reasonsZh,
    gtoStatus: result.gtoStatus,
    rangeProvenance: provenance.map((p) => ({
      positionZh: p.positionZh,
      sourceKind: p.sourceKind,
      fromSolver: p.fromSolver,
      confidence: p.confidence,
      supportSize: p.supportSize,
      effectiveComboCount: p.effectiveComboCount,
      normalizedEntropy: p.normalizedEntropy,
      sourceZh: p.sourceZh,
    })),
    meta: result.meta,
  };
}

async function postAnalyze(url) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, mode: 'OFF' }),
  });
  const body = await res.json();
  return { httpStatus: res.status, body };
}

const emptyDir = mkdtempSync(join(tmpdir(), 'gtopen-9max-A-'));
process.env['ALPHA_GTO_CACHE_DIR'] = emptyDir;
const serverA = await startAlphaServer({ port: 0, host: '127.0.0.1', gtoBackgroundSolve: false, logPath: null });
const payloadA = await postAnalyze(serverA.url + '/api/analyze');
const summaryA = summarize(payloadA.body);
await serverA.close();
rmSync(emptyDir, { recursive: true, force: true });

process.env['ALPHA_GTO_CACHE_DIR'] = READONLY_CACHE;
const serverB = await startAlphaServer({ port: 0, host: '127.0.0.1', gtoBackgroundSolve: false, logPath: null });
const payloadB = await postAnalyze(serverB.url + '/api/analyze');
const summaryB = summarize(payloadB.body);
await serverB.close();

const raw = JSON.parse(readFileSync(PROD_CACHE + '/strategy/c80e2e90a.json', 'utf8'));
let raiseMass = 0;
let positiveClasses = 0;
let totalCombos = 0;
let weightMass = 0;
for (const hand of raw.range.hands) {
  let w = 0;
  for (const action of hand.actions) {
    if (action.kind === 'RAISE' || action.kind === 'ALL_IN') w += Number(action.frequency) || 0;
  }
  w = Math.min(1, Math.max(0, w));
  raiseMass += w;
  weightMass += w * Number(hand.combos);
  totalCombos += Number(hand.combos);
  if (w > 0) positiveClasses += 1;
}
const aa = raw.range.hands.find((h) => h.hand === 'AA');
const ajo = raw.range.hands.find((h) => h.hand === 'AJo');
const o72 = raw.range.hands.find((h) => h.hand === '72o');
const weightsOf = (h) => Object.fromEntries((h?.actions ?? []).map((a) => [a.kind, a.frequency]));

const report = {
  generatedAt: new Date().toISOString(),
  code: {
    decisionHead: '7dffffc (main)',
    decisionDirty: 'existing working-tree changes preserved; GTO verification only',
    solverProcess: 'D:\\德州GTO\\target\\desktop-runtime\\release\\gto-server.exe (PID 20356)',
    solverEndpoint: 'http://127.0.0.1:3737',
  },
  candidate: {
    label: '9MAX / 100BB / BB vs UTG open 2.5BB / AhAd',
    cacheKey: raw.cacheKey,
    scenarioHash: raw.scenarioHash,
    treeId: raw.treeId,
    scenario: raw.scenario,
    solveMeta: raw.solveMeta,
    quality: raw.quality,
    qualitySummaryZh: raw.qualitySummaryZh,
    source: raw.source,
    caveat: 'cacheKey c80e2e90a 与 9MAX RFI c7348fc89 共用 treeId 且 BR gap 完全相同；失败假设已排除（后者未覆盖，直接 json 对比 169 类频率逐类不同）',
  },
  serviceHealth: {
    A: payloadA.body?.result?.gtoStatus ?? null,
    B: payloadB.body?.result?.gtoStatus ?? null,
  },
  A_noSolverRange: summaryA,
  B_solverRange: summaryB,
  rangeSummary: {
    handClasses: raw.range.hands.length,
    totalCombos,
    positiveClasses,
    positiveComboMass_unclamped: weightMass,
    actionMass_sumOverClasses: raiseMass,
    AA: weightsOf(aa),
    AJo: weightsOf(ajo),
    '72o': weightsOf(o72),
    firstFive: raw.range.hands.slice(0, 5).map((h) => h.hand),
  },
  independentRecompute: {
    method: 'read cache raw JSON; per hand-class name, sum RAISE + ALL_IN frequency; clamp [0,1]',
    checks: {
      handClasses169: raw.range.hands.length === 169,
      namedHandsPresent: ['AA', 'AJo', '72o'].every((n) => raw.range.hands.some((h) => h.hand === n)),
      actionMassFinite: Number.isFinite(raiseMass) && raiseMass > 0,
      actionMassNotEqualToComboMass: Math.abs(raiseMass - weightMass) > 1e-9,
    },
  },
};

console.log(JSON.stringify(report, null, 2));



