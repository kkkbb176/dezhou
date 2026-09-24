import fs from 'node:fs';
const src = fs.readFileSync('reports/aa-utg-sizing-v4/_src-dump.txt','utf8');
const idx = src.indexOf('===== src/app/manualInput/preflopRaiseFacts.ts =====');
const end = src.indexOf('===== src/app/manualInput/preflopRaiseResponse.ts =====');
const a = src.slice(idx, end);
const start = a.indexOf('export function buildPreflopRaiseFacts');
console.log(a.slice(start, start + 26000));
