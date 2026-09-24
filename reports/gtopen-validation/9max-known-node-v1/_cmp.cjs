const fs=require('fs');
const dir='reports/gtopen-validation/9max-known-node-v1';
for(const f of ['isolated-A.json','isolated-B.json']){
 const r=JSON.parse(fs.readFileSync(dir+'/'+f,'utf8'));
 const x=r.result;
 console.log(JSON.stringify({file:f,mode:r.mode,cacheDir:r.cacheDir,action:x.actionZh,size:x.sizeZh,equity:x.equity,callEv:x.callEv,gtoState:x.gtoStatus.state,outcomes:x.gtoStatus.outcomes,cacheSource:x.gtoStatus.outcomes[0]?.cacheSource,prov:x.rangeProvenance[0],candidates:x.candidates},null,2));
}
