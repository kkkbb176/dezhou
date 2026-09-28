import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync('reports/gtopen-validation/9max-cold-solve-v1/analysis/raw-production-response.json', 'utf8'));
const p = j.raw.viewModel.debug.preflopRaise;
const summary = {
  topKeys: Object.keys(j.raw ?? {}),
  debugKeys: Object.keys(j.raw?.viewModel?.debug ?? {}),
  preflopRaiseType: Array.isArray(p) ? 'array' : typeof p,
  preflopRaiseKeys: p && !Array.isArray(p) ? Object.keys(p) : null,
};
console.log(JSON.stringify(summary, null, 2));
if (Array.isArray(p)) console.log(JSON.stringify(p, null, 2));
else console.log(JSON.stringify(p, null, 2));
