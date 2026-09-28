import { writeFileSync } from 'node:fs';
const roundDir = 'D:/德州决策/reports/aa-utg-sizing-v12';
process.env['ALPHA_GTO_CACHE_DIR'] = 'D:/德州决策/reports/gtopen-validation/9max-cold-solve-repro/cache';
process.env['GTOPEN_URL'] = 'http://127.0.0.1:3761';
const { startAlphaServer } = await import('file:///D:/德州决策/src/app/webServer.ts');
const input = { tableSize:9, heroPosition:'BB', heroCards:['Ah','Ad'], board:[], street:'PREFLOP', effectiveStackBB:100, actionHistory:[
 {position:'UTG',type:'RAISE',amountBB:2.5,street:'PREFLOP'},{position:'UTG1',type:'FOLD',street:'PREFLOP'},{position:'UTG2',type:'FOLD',street:'PREFLOP'},{position:'LJ',type:'FOLD',street:'PREFLOP'},{position:'HJ',type:'FOLD',street:'PREFLOP'},{position:'CO',type:'FOLD',street:'PREFLOP'},{position:'BTN',type:'FOLD',street:'PREFLOP'},{position:'SB',type:'FOLD',street:'PREFLOP'}], environment:'LOW_STAKES_ONLINE' };
const server = await startAlphaServer({ port:0, host:'127.0.0.1', gtoBackgroundSolve:false, logPath:null });
try {
 const res = await fetch(server.url+'/api/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input,mode:'OFF'})});
 const body=await res.json();
 writeFileSync(roundDir+'/raw-response.json',JSON.stringify(body,null,2),'utf8');
 const hits=[]; const seen=new WeakSet();
 const walk=(n,p)=>{ if(n===null||typeof n!=='object'||seen.has(n))return; seen.add(n);
  if(Array.isArray(n)){n.forEach((v,i)=>walk(v,`${p}[${i}]`));return;}
  const keys=Object.keys(n);
  if(keys.includes('sizes')||keys.includes('version')||keys.includes('modelVersion')) hits.push({path:p,keys,version:n.version,modelVersion:n.modelVersion,sizeCount:Array.isArray(n.sizes)?n.sizes.length:null});
  for(const k of keys) walk(n[k],`${p}.${k}`);
 };
 walk(body,'$');
 console.log(JSON.stringify(hits.filter(h=>h.sizeCount!==null||String(h.version).includes('PREFLOP')||String(h.modelVersion).includes('PREFLOP')),null,2));
} finally { await server.close(); }
