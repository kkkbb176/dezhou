import fs from 'node:fs';
const j=JSON.parse(fs.readFileSync('reports/aa-utg-sizing-v2/production-diagnostics.json','utf8'));
const pr=j.preflopRaise;
console.log('pr keys',Object.keys(pr));
console.log('assumptions',JSON.stringify(pr.assumptionsZh,null,2));
console.log('note',pr.noteZh);
console.log('arrival',JSON.stringify(pr.arrival,null,2));
