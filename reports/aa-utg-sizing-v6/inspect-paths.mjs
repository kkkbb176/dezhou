import { readFileSync } from 'node:fs';
const j = JSON.parse(readFileSync('reports/aa-utg-sizing-v6/production-full.json','utf8'));
function walk(o, path='$', depth=0, out=[]) {
  if (o === null || typeof o !== 'object' || depth > 5) return out;
  for (const [k,v] of Object.entries(o)) {
    const p = `${path}.${k}`;
    if (/preflop|diagnostic|debug|raise/i.test(k)) out.push({path:p, type:Array.isArray(v)?'array':typeof v, keys:v&&!Array.isArray(v)&&typeof v==='object'?Object.keys(v).slice(0,30):null});
    walk(v,p,depth+1,out);
  }
  return out;
}
console.log(JSON.stringify(walk(j),null,2));
console.log(JSON.stringify({decisionKeys:Object.keys(j.decision??{}), diagKeys:Object.keys(j.decision?.diagnostics??{}), top:Object.keys(j)},null,2));
