import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const roundDir = 'D:/德州决策/reports/gtopen-validation/9max-cold-solve-repro';
process.env['ALPHA_GTO_CACHE_DIR'] = join(roundDir, 'cache');
process.env['GTOPEN_URL'] = 'http://127.0.0.1:3761';

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

const server = await startAlphaServer({ port: 0, host: '127.0.0.1', gtoBackgroundSolve: false, logPath: null });
try {
  const started = Date.now();
  const res = await fetch(server.url + '/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, mode: 'OFF' }),
  });
  const body = await res.json();
  const r = body.result ?? body;
  const vm = r.viewModel ?? {};
  const pr = vm?.debug?.preflopRaise ?? null;
  const out = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    httpStatus: res.status,
    gtoStatus: r.gtoStatus ?? null,
    rangeProvenance: r.rangeProvenance ?? null,
    actionZh: vm.actionZh ?? null,
    sizeZh: vm.sizeZh ?? null,
    decision: r.decision ?? null,
    preflopRaise: pr,
    preflopRaiseChoice: vm?.debug?.preflopRaiseChoice ?? null,
    math: vm?.debug?.math ?? null,
    meta: r.meta ?? null,
  };
  const outPath = join(roundDir, 'hero-allin-explain.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify({
    outPath,
    elapsedMs: out.elapsedMs,
    gtoStatus: out.gtoStatus,
    actionZh: out.actionZh,
    sizeZh: out.sizeZh,
    preflopRaiseSummary: pr ? {
      status: pr.status,
      reasonZh: pr.reasonZh,
      pot0: pr.pot0,
      heroStreetCommitted: pr.heroStreetCommitted,
      villainStreetTotal: pr.villainStreetTotal,
      currentDecisionCost: pr.currentDecisionCost,
      sizes: (pr.sizes ?? []).map((s) => ({
        sizeBB: s.sizeBB,
        heroAdd: s.heroAdd,
        heroContestedAdd: s.heroContestedAdd,
        uncalledReturn: s.uncalledReturn,
        foldLikelihood: s.foldLikelihood,
        callLikelihood: s.callLikelihood,
        reRaiseLikelihood: s.reRaiseLikelihood,
        heroEquityVsRaiseCallRange: s.heroEquityVsRaiseCallRange,
        finalPot: s.finalPot,
        raiseEV: s.raiseEV,
        heroIsAllIn: s.heroIsAllIn,
        villainIsAllInByCall: s.villainIsAllInByCall,
        reraiseAvailable: s.reraiseAvailable,
        reraiseBranchEV: s.reraiseBranchEV,
      })),
    } : null,
  }, null, 2));
} finally {
  await server.close();
}

