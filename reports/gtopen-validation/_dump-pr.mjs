import fs from 'node:fs';
const p = 'reports/gtopen-validation/9max-cold-solve-v1/analysis/raw-production-response.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const raw = j.raw ?? j.body?.result ?? j;
const debug = raw.viewModel?.debug ?? raw.body?.result?.viewModel?.debug ?? raw.body?.viewModel?.debug;
console.log('raw keys', Object.keys(raw));
console.log('viewModel?', !!raw.viewModel, 'debug keys', debug ? Object.keys(debug) : null);
if (debug?.preflopRaise) {
  console.log(JSON.stringify(debug.preflopRaise, null, 2));
} else {
  const s = JSON.stringify(raw);
  console.log('preflopRaise index', s.indexOf('preflopRaise'));
}
