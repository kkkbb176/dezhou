const fs=require('fs');
const j=JSON.parse(fs.readFileSync('reports/gtopen-validation/9max-cold-solve-v1/cold-solve-run.json','utf8'));
console.log('generatedAt='+j.generatedAt);
console.log('first='+JSON.stringify(j.first&&{elapsedMs:j.first.elapsedMs,state:j.first.gtoStatus&&j.first.gtoStatus.state,action:j.first.actionZh,equity:j.first.equity,callEv:j.first.callEv,source:j.first.rangeProvenance},null,2));
console.log('second='+JSON.stringify(j.second&&{elapsedMs:j.second.elapsedMs,state:j.second.gtoStatus&&j.second.gtoStatus.state,action:j.second.actionZh,equity:j.second.equity,callEv:j.second.callEv,source:j.second.rangeProvenance},null,2));
console.log('final='+JSON.stringify(j.finalBackground,null,2));
console.log('timeline='+JSON.stringify(j.timeline.map(x=>({event:x.event,atMs:x.atMs,elapsedMs:x.elapsedMs,state:x.foregroundState,iter:x.background&&x.background.iterationZh,fileCount:x.cacheFiles.length})),null,2));
console.log('after='+JSON.stringify(j.after,null,2));
