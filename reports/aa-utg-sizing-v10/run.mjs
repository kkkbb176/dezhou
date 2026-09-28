import { writeFileSync } from 'node:fs';
const OUT = 'D:/德州决策/reports/aa-utg-sizing-v10';
const REPRO = 'D:/德州决策/reports/gtopen-validation/9max-cold-solve-repro';
process.env['ALPHA_GTO_CACHE_DIR'] = REPRO + '/cache';
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
  const res = await fetch(server.url + '/api/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, mode: 'OFF' }),
  });
  const body = await res.json();

  // find first object with a sizes array of length >= 5 whose elements have sizeBB & raiseEV
  let found = null;
  const seen = new WeakSet();
  const walk = (node, path) => {
    if (found || node === null || typeof node !== 'object') return;
    if (seen.has(node)) return; seen.add(node);
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, path + '[' + i + ']')); return; }
    const s = node.sizes;
    if (Array.isArray(s) && s.length >= 5 && s[0] && typeof s[0].sizeBB === 'number' && 'raiseEV' in s[0]) {
      found = { path, facts: node }; return;
    }
    for (const k of Object.keys(node)) walk(node[k], path + '.' + k);
  };
  walk(body, '$');

  const out = {
    generatedAt: new Date().toISOString(),
    httpStatus: res.status,
    topLevelKeys: Object.keys(body ?? {}),
    foundPath: found ? found.path : null,
    gtoStatus: body?.result?.gtoStatus ?? body?.gtoStatus ?? null,
    rangeProvenance: body?.result?.rangeProvenance ?? body?.rangeProvenance ?? null,
    facts: found ? found.facts : null,
  };
  writeFileSync(OUT + '/production-raw-facts.json', JSON.stringify(out, null, 2), 'utf8');

  const rows = (found?.facts?.sizes ?? []).map((s) => ({
    sizeBB: s.sizeBB, sizeChips: s.sizeChips, isAllIn: s.isAllIn,
    currentPot: s.currentPot, heroStreetCommitted: s.heroStreetCommitted,
    villainStreetCommitted: s.villainStreetCommitted, heroAdd: s.heroAdd,
    villainAddRaw: s.villainAddRaw, villainAdd: s.villainAdd,
    heroContestedAdd: s.heroContestedAdd, finalPot: s.finalPot, uncalledReturn: s.uncalledReturn,
    f: s.foldLikelihood, c: s.callLikelihood, rr: s.reRaiseLikelihood,
    sum: s.foldLikelihood + s.callLikelihood + s.reRaiseLikelihood,
    conditionalRR: (1 - s.foldLikelihood) > 0 ? s.reRaiseLikelihood / (1 - s.foldLikelihood) : null,
    price: s.priceRequiredEquity,
    eqCall: s.heroEquityVsRaiseCallRange?.value ?? null,
    eqRR: s.heroEquityVsReraiseRange?.value ?? null,
    reachableCombos: s.reachableCombos, callCombos: s.callCombos, reRaiseCombos: s.reRaiseCombos,
    reraiseAvailable: s.reraiseAvailable, reRaiseTo: s.reRaiseTo,
    heroAdditionalCallVsReRaise: s.heroAdditionalCallVsReRaise,
    reraiseFoldBranchEV: s.reraiseFoldBranchEV, reraiseCallBranchEV: s.reraiseCallBranchEV,
    reraiseBranchEV: s.reraiseBranchEV, reraiseBranchKind: s.reraiseBranchKind,
    heroFiveBetExpanded: s.heroFiveBetExpanded,
    raiseEV: s.raiseEV,
    recomputed: s.heroEquityVsRaiseCallRange?.value == null ? null
      : s.foldLikelihood * s.currentPot
        + s.callLikelihood * (s.heroEquityVsRaiseCallRange.value * s.finalPot - s.heroContestedAdd)
        + s.reRaiseLikelihood * s.reraiseBranchEV,
  }));
  const withDelta = rows.map((r) => ({ ...r, delta: r.recomputed == null ? null : r.recomputed - r.raiseEV }));
  writeFileSync(OUT + '/production-rows.json', JSON.stringify({ generatedAt: out.generatedAt, gtoStatus: out.gtoStatus, rangeProvenance: out.rangeProvenance, arrival: found?.facts?.arrival ?? null, rows: withDelta }, null, 2), 'utf8');
  console.log(JSON.stringify({ status: res.status, foundPath: out.foundPath, arrival: found?.facts?.arrival ?? null, gtoState: out.gtoStatus?.state ?? null, provenance: out.rangeProvenance?.map?.((p) => ({ pos: p.positionZh, support: p.supportSize, eff: p.effectiveComboCount })) ?? null, rows: withDelta }, null, 2));
} finally {
  await server.close();
}
