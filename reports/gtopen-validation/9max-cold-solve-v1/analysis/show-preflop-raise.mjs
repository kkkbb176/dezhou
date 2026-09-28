import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync('reports/gtopen-validation/9max-cold-solve-v1/analysis/raw-production-response.json', 'utf8'));
console.log(JSON.stringify(j.raw.viewModel.debug.preflopRaise, null, 2));
