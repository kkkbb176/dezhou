import { readFileSync } from 'node:fs';
const j = JSON.parse(readFileSync('reports/aa-utg-sizing-v6/production-full.json','utf8'));
const p = j.preflopRaise;
console.log(JSON.stringify({type:Array.isArray(p)?'array':typeof p, keys:p?Object.keys(p):null, sizes:Array.isArray(p?.sizes)?p.sizes.length:null, arrival:p?.arrival, first:p?.sizes?.[0]},null,2));
