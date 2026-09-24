import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root=process.cwd(), out=path.join(root,'reports/fast-input-decision-v2');
const read=p=>JSON.parse(fs.readFileSync(path.join(out,p),'utf8'));
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex');
function stats(values){const v=values.filter(Number.isFinite).sort((a,b)=>a-b);return {n:v.length,p50:v[Math.ceil(v.length*.5)-1]??null,p95:v[Math.ceil(v.length*.95)-1]??null,max:v.at(-1)??null};}
const browser=read('browser/acceptance.json'), cache=read('browser-cache-final/cached-performance.json');
const responsive=read('browser-final-supplement/acceptance.json');
const player=read('browser-player-final/acceptance.json');
const unique=[...new Map(browser.timings.flatMap(x=>x.metrics||[]).map(x=>[JSON.stringify(x),x])).values()];
const samples=cache.samples;
const initial=read('browser-cache-final/acceptance.json').timings.filter(x=>x.kind==='serverAnalysis').at(0);
const before=read('baseline-before-metadata.json');
const protectedChanges=Object.entries(before.hashes).filter(([p,h])=>!p.startsWith('src/app/web/')&&fs.existsSync(path.join(root,p))&&sha(p)!==h).map(([p])=>p);
const log=fs.readFileSync(path.join(out,'final-verify.log'),'utf8');
const counts=Object.fromEntries([...log.matchAll(/^(?:#|ℹ) (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (.+)$/gm)].map(m=>[m[1],Number(m[2])]));
const result={generatedAt:new Date().toISOString(),percentile:'Nearest rank ceil(0.95*n); milliseconds; duplicate snapshots removed by exact metric identity',
 machine:read('browser-cache-final/acceptance.json').machine,
 verification:{counts,logSha256:sha('reports/fast-input-decision-v2/final-verify.log')},
 browser:{primaryApplicable:{passed:browser.results.filter(x=>x.pass&&x.name!=='cached supported nodes repeated real browser analysis').length,failed:browser.results.filter(x=>!x.pass).length},
  responsiveApplicable:{passed:responsive.results.filter(x=>x.pass).length,failed:responsive.results.filter(x=>!x.pass).length,
    supersededHarnessFailure:'player profile attempt clicked the nested stack target and opened chip management; corrected selector reran separately'},
  playerFinal:player.summary,cacheFinal:read('browser-cache-final/acceptance.json').summary,
  evidenceFiles:['browser/acceptance.json','browser-final-supplement/acceptance.json','browser-player-final/acceptance.json','browser-cache-final/acceptance.json']},
 uiFeedback:stats(unique.filter(x=>x.kind==='ui-feedback').map(x=>x.frameMs)),
 actionSave:stats(unique.filter(x=>x.kind==='action-save'&&x.ok).map(x=>x.requestMs)),
 cacheHit:{nodes:['9MAX BB AhAd vs UTG 2.5BB','9MAX BB AsKs vs UTG 2.5BB','9MAX BB QhQd vs UTG 2.5BB'],samples:samples.length,
  observedDisplay:stats(samples.map(x=>x.displayObservedMs)),
  request:stats(samples.map(x=>x.metric.requestMs)),render:stats(samples.map(x=>x.metric.renderMs)),
  queue:stats(samples.map(x=>x.metric.server.queueMs)),prepare:stats(samples.map(x=>x.metric.server.prepareMs)),
  compute:stats(samples.map(x=>x.metric.server.computeMs)),worker:stats(samples.map(x=>x.metric.server.workerMs)),
  transportAndDecode:stats(samples.map(x=>x.metric.transportAndDecodeMs)),
  firstPersistedCacheRequest:initial,
  caveat:'No fresh solver run. Persisted cache copied read-only for these tests; repeated decisions are recomputed, not cached. Observed display includes CDP polling up to 40ms. Transport residual also includes response assembly/decode; not isolated wire time.'},
 protectedChanges,
 finalSourceHashes:Object.fromEntries(['src/app/web/index.html','src/app/web/table.js','src/app/web/fast-input.js','src/app/web/fast-ui.css','src/app/webServer.ts','src/app/analysisScheduler.ts','src/app/analysisWork.ts','src/app/analysisWorker.ts','src/app/mutationMemo.ts','src/app/table/tablePreview.ts','src/app/table/table.types.ts'].map(p=>[p,sha(p)])),
 consoleExceptions:read('browser/console.json').filter(x=>x.method==='Runtime.exceptionThrown'),
 limitations:['Primary browser timings collected while verification ran; cached-node performance collected separately after verify completed.','No fresh uncached solver completion performance measurement; no reduced solver quality to meet targets.']};
fs.writeFileSync(path.join(out,'final-summary.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
