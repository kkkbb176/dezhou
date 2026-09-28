const fs=require('fs');
const s=fs.readFileSync('src/app/gto/gtoApi.ts','utf8').split(/\r?\n/);
console.log(s.slice(95,180).join('\n'));
