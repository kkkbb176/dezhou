import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = 'D:/德州决策/reports/gtopen-validation/9max-known-node-v1';
const PROD_CACHE = 'D:/德州决策/data/gto-cache';
const READONLY_CACHE = OUT + '/cache-readonly-20260922-161900';
const mode = (process.argv[2] || 'B').toUpperCase();
const tempDir = mode === 'A' ? mkdtempSync(join(tmpdir(), 'gtopen-9max-A-')) : null;
process.env['ALPHA_GTO_CACHE_DIR'] = mode === 'A' ? tempDir : READONLY_CACHE;
process.env['GTOPEN_URL'] = 'http://127.0.0.1:3737';

const { startAlphaServer } = await import('../../../src/app/webServer.ts');

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
  const provenance = result.rangeProvenance ?? [];
  return {
    httpStatus: payload.httpStatus ?? 200,
    ok: result.ok,
    actionZh: vm.actionZh,
    sizeZh: vm.sizeZh,
    confidenceZh: vm.confidenceZh,
    classificationZh: vm.classificationZh,
    decision: result.decision,
    equity: valueOf(vm, '整体范围权益'),
    callEv: valueOf(vm, '跟注 EV'),
    reasonsZh: vm.reasonsZh,
    candidates: (vm.debug?.candidates ?? []).map((c) => ({ action: c.actionZh, size: c.sizeZh, ev: c.evZh })),
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

let output;
try {
  const server = await startAlphaServer({ port: 0, host: '127.0.0.1', gtoBackgroundSolve: false, logPath: null });
  try {
    const res = await fetch(server.url + '/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input, mode: 'OFF' }),
    });
    const body = await res.json();
    output = {
      mode,
      cacheDir: process.env['ALPHA_GTO_CACHE_DIR'],
      result: summarize({ httpStatus: res.status, ...body }),
    };
  } finally {
    await server.close();
  }

  if (mode === 'R') {
    const raw = JSON.parse(readFileSync(PROD_CACHE + '/strategy/c80e2e90a.json', 'utf8'));
    let comboWeightedMass = 0;
    let classFrequencySum = 0;
    let positiveClasses = 0;
    let totalCombos = 0;
    for (const hand of raw.range.hands) {
      let w = 0;
      for (const action of hand.actions) {
        if (action.kind === 'RAISE' || action.kind === 'ALL_IN') w += Number(action.frequency) || 0;
      }
      w = Math.min(1, Math.max(0, w));
      classFrequencySum += w;
      comboWeightedMass += w * Number(hand.combos);
      totalCombos += Number(hand.combos);
      if (w > 0) positiveClasses += 1;
    }
    const byName = (name) => {
      const h = raw.range.hands.find((x) => x.hand === name);
      return Object.fromEntries((h?.actions ?? []).map((a) => [a.kind, a.frequency]));
    };
    output.independentRecompute = {
      method: 'read production cache raw JSON; per hand class name, sum RAISE + ALL_IN frequency; clamp [0,1]',
      cacheKey: raw.cacheKey,
      scenarioHash: raw.scenarioHash,
      treeId: raw.treeId,
      solveMeta: raw.solveMeta,
      quality: raw.quality,
      summary: {
        handClasses: raw.range.hands.length,
        totalCombos,
        positiveClasses,
        classFrequencySum,
        comboWeightedMass,
        AA: byName('AA'),
        AJo: byName('AJo'),
        '72o': byName('72o'),
        firstFive: raw.range.hands.slice(0, 5).map((h) => h.hand),
      },
      checks: {
        handClasses169: raw.range.hands.length === 169,
        namedHandsPresent: ['AA', 'AJo', '72o'].every((n) => raw.range.hands.some((h) => h.hand === n)),
        classFrequencySumFinitePositive: Number.isFinite(classFrequencySum) && classFrequencySum > 0,
        comboMassDiffersFromClassMass: Math.abs(comboWeightedMass - classFrequencySum) > 1e-9,
      },
    };
  }
} finally {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}

console.log(JSON.stringify(output, null, 2));
