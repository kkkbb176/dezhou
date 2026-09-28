import fs from 'node:fs';
const paths = [
  'reports/gtopen-validation/9max-cold-solve-v1/analysis/raw-production-response.json',
  'reports/gtopen-validation/9max-known-node-v2/production-5173-live-response.json',
];
for (const p of paths) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  console.log('\nFILE', p);
  console.log('top keys', Object.keys(raw));
  const vm = raw.viewModel ?? raw;
  console.log('vm keys', Object.keys(vm));
  console.log('preflopRaise', typeof vm.preflopRaise, Array.isArray(vm.preflopRaise));
  if (vm.preflopRaise) console.log(JSON.stringify(vm.preflopRaise, null, 2).slice(0, 2500));
}
