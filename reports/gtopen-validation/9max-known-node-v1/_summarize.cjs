const fs=require('fs');
const r=JSON.parse(fs.readFileSync('reports/gtopen-validation/9max-known-node-v1/run-9max-readonly-v1-latest.json','utf8'));
const pick=x=>({actionZh:x.actionZh,sizeZh:x.sizeZh,equity:x.equity,callEv:x.callEv,confidenceZh:x.confidenceZh,gtoState:x.gtoStatus.state,outcomes:x.gtoStatus.outcomes,provenance:x.rangeProvenance,reasons:x.reasonsZh});
console.log(JSON.stringify({candidate:r.candidate,A:pick(r.A_noSolverRange),B:pick(r.B_solverRange),successA:r.serviceHealth.A,successB:r.serviceHealth.B},null,2));
