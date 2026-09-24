import fs from 'node:fs';
const files = [
  'src/app/manualInput/preflopRaiseFacts.ts',
  'src/app/manualInput/preflopRaiseResponse.ts',
  'src/app/decision/decisionEngine.ts',
];
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  console.log('===== ' + f + ' =====');
  console.log(s);
}
