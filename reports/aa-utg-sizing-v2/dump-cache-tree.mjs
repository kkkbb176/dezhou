import fs from 'node:fs';
const p='reports/gtopen-validation/9max-cold-solve-repro/cache/strategy/c7348fc89.json';
const j=JSON.parse(fs.readFileSync(p,'utf8'));
const walk=(o,pre='',d=0)=>{if(d>3||o===null)return;if(Array.isArray(o)){console.log(pre+'[] len='+o.length+' sample='+JSON.stringify(o[0]).slice(0,500));return;}if(typeof o==='object'){for(const [k,v] of Object.entries(o)){if(v&&typeof v==='object'){console.log(pre+k+' '+(Array.isArray(v)?'array='+v.length:'object'));walk(v,pre+k+'.',d+1)}else console.log(pre+k+'='+JSON.stringify(v).slice(0,300));}}};
walk(j);
