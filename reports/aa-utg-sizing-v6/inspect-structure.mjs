import { readFileSync } from 'node:fs';
for (const path of [
  'reports/aa-utg-sizing-v6/production-full.json',
  'reports/gtopen-validation/9max-cold-solve-repro/hero-allin-explain.json',
  'reports/aa-utg-sizing-v4/production-solver-current.json',
  'reports/gtopen-validation/9max-cold-solve-v1/analysis/raw-production-response.json',
]) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const p = j.preflopRaise ?? j.raw?.viewModel?.debug?.preflopRaise ?? null;
  console.log(JSON.stringify({
    path,
    topKeys: Object.keys(j),
    pType: Array.isArray(p) ? 'array' : typeof p,
    pKeys: p && !Array.isArray(p) ? Object.keys(p) : null,
    pSizes: Array.isArray(p?.sizes) ? p.sizes.length : null,
    gtoState: j.gtoStatus?.state ?? j.raw?.gtoStatus?.state ?? null,
    fromSolver: j.rangeProvenance?.[0]?.fromSolver ?? j.raw?.rangeProvenance?.[0]?.fromSolver ?? null,
    viewDebugKeys: j.raw?.viewModel?.debug ? Object.keys(j.raw.viewModel.debug) : null,
  }, null, 2));
}
