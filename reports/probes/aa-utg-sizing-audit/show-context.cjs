const fs = require('fs');
function show(file, start, end) {
  const L = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  console.log('===== ' + file + ' ' + start + '-' + end + ' =====');
  for (let i = start; i <= end; i++) console.log(String(i).padStart(5) + ': ' + (L[i-1] ?? ''));
}
show('src/app/manualInput/contextBuilder.ts', 4300, 4405);
show('src/app/manualInput/contextBuilder.ts', 4950, 5070);
