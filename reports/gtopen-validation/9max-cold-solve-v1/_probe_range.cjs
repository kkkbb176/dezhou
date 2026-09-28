const fs=require('fs');
const path='reports/gtopen-validation/9max-cold-solve-v1/cache/strategy/c7348fc89.json';
const j=JSON.parse(fs.readFileSync(path,'utf8'));
console.log('menu=',JSON.stringify(j.range.actionMenu,null,2));
console.log('first3=',JSON.stringify(j.range.hands.slice(0,3),null,2));
const acts=new Map();
for(const h of j.range.hands){for(const a of h.actions){acts.set(a.kind,(acts.get(a.kind)||0)+1)}}
console.log('actionKinds', [...acts.entries()]);
const keys=Object.keys(j.range.hands[0].actions[0]); console.log('actionKeys',keys);
const sums={}; for(const h of j.range.hands){for(const a of h.actions){const v=a.frequency??a.weight??0; sums[a.kind]=(sums[a.kind]||0)+v}} console.log('sums',sums);
const cp=require('child_process');
