import { readFileSync, writeFileSync } from 'node:fs';

function findPreflopRaise(node, path = '$') {
  if (node === null || typeof node !== 'object') return null;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'preflopRaise' && value && typeof value === 'object') return { path: `${path}.${key}`, value };
    const found = findPreflopRaise(value, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

const sources = [
  'reports/gtopen-validation/9max-cold-solve-v1/analysis/raw-production-response.json',
  'reports/gtopen-validation/9max-cold-solve-v1/hero-allin-explain.json',
  'reports/gtopen-validation/9max-cold-solve-repro/hero-allin-explain.json',
  'reports/aa-utg-sizing-v3/production-current.json',
  'reports/aa-utg-sizing-v4/production-solver-current.json',
];

const out = [];
for (const path of sources) {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const found = findPreflopRaise(json);
  if (!found) {
    out.push({ path, found: false, topKeys: Object.keys(json) });
    continue;
  }
  const pr = found.value;
  out.push({
    path,
    jsonPath: found.path,
    status: pr.status ?? null,
    modelVersion: pr.modelVersion ?? null,
    evidence: pr.evidence ?? null,
    arrival: pr.arrival ?? null,
    reasonZh: pr.reasonZh ?? null,
    sizes: (pr.sizes ?? []).map((s) => ({
      sizeBB: s.sizeBB ?? null,
      sizeChips: s.sizeChips ?? null,
      isAllIn: s.isAllIn ?? null,
      fold: s.foldLikelihood ?? null,
      call: s.callLikelihood ?? null,
      reRaise: s.reRaiseLikelihood ?? null,
      eqCall: s.heroEquityVsRaiseCallRange?.value ?? null,
      eqCallMethod: s.heroEquityVsRaiseCallRange?.method ?? null,
      callCombos: s.callCombos ?? null,
      reachableCombos: s.reachableCombos ?? null,
      heroAdd: s.heroAdd ?? null,
      villainAdd: s.villainAdd ?? null,
      finalPot: s.finalPot ?? null,
      uncalledReturn: s.uncalledReturn ?? null,
      raiseEV: s.raiseEV ?? null,
      reraiseBranchEV: s.reraiseBranchEV ?? null,
      reraiseBranchKind: s.reraiseBranchKind ?? null,
      reRaiseTo: s.reRaiseTo ?? null,
    })),
  });
}

const outPath = 'reports/aa-utg-sizing-v5/existing-timelines.json';
writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));
