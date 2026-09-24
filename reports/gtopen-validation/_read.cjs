const fs=require('fs');
for (const f of ['reports/gtopen-validation/_now-ab2-9max.mts','reports/gtopen-validation/9max-known-node-v1/probe-9max-readonly-v1.mts']) {
  console.log('===== '+f+' =====');
  console.log(fs.readFileSync(f,'utf8'));
}
