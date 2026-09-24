import { readFileSync } from 'node:fs';
// 9MAX / 100BB / BB VS_OPEN(UTG open 2.5) —— 独立复算：直接读缓存原始 JSON，按牌名取 RAISE/CALL 频率
const raw = JSON.parse(readFileSync('./data/gto-cache/strategy/c80e2e90a.json','utf8'));
console.log('actorPosition=' + raw.range.actorPosition);
console.log('reachable=' + raw.range.reachable);
console.log('hands=' + raw.range.hands.length);
const kinds = new Set(raw.range.hands[0].actions.map(a=>a.kind));
console.log('actionKinds=' + [...kinds].join(','));
let sum=0,pos=0,aa=0,ajo=0,o72=0;
for (const h of raw.range.hands) {
  let w=0; for (const a of h.actions) if (a.kind==='RAISE'||a.kind==='ALL_IN') w += a.frequency;
  w=Math.min(1,Math.max(0,w)); sum+=w; if(w>0)pos++;
  if(h.hand==='AA')aa=w; if(h.hand==='AJo')ajo=w; if(h.hand==='72o')o72=w;
}
console.log('FREQ_SUM='+sum.toFixed(6));
console.log('POSITIVE='+pos);
console.log('AA='+aa+' AJo='+ajo+' 72o='+o72);
console.log('FIRST5='+raw.range.hands.slice(0,5).map(h=>h.hand).join(','));
console.log('META_gap='+raw.metadata.solveSettings.reportedGap+' iters='+raw.metadata.solveSettings.iterationsCompleted+' target='+raw.metadata.solveSettings.targetGap);
console.log('META_commit='+raw.metadata.source.engineCommit);
