import { writeFileSync, mkdirSync } from 'node:fs';
const OUT='D:/德州决策/reports/aa-utg-sizing-v11';
mkdirSync(OUT,{recursive:true});
const comboMod=await import('file:///D:/德州决策/src/domain/range/combo.ts');
const typesMod=await import('file:///D:/德州决策/src/domain/types.ts');
const eqMod=await import('file:///D:/德州决策/src/domain/poker/equity.ts');
const eqTypes=await import('file:///D:/德州决策/src/domain/poker/equity.types.ts');
const fs=await import('node:fs');
const strat=JSON.parse(fs.readFileSync('D:/德州决策/reports/gtopen-validation/9max-cold-solve-repro/cache/strategy/c7348fc89.json','utf8'));
const keyOf=c=>`${typesMod.RANK_CHARS[c.rank]}${c.suit}`;
const heroKeys=new Set(['Ah','Ad']);
const RK=new Set(['RAISE','ALL_IN']);
const arrival=[];
for(const h of strat.range.hands){ let w=0; for(const a of h.actions) if(RK.has(a.kind)) w+=a.frequency; w=Math.min(1,Math.max(0,w)); if(!(w>0))continue;
  for(const c of comboMod.COMBOS_BY_RANK_CLASS.get(h.hand)??[]){ if(heroKeys.has(keyOf(c.card1))||heroKeys.has(keyOf(c.card2)))continue; arrival.push({combo:c,probability:w}); } }
const tm=arrival.reduce((a,x)=>a+x.probability,0);
const arrivalNorm=arrival.map(x=>({combo:x.combo,probability:x.probability/tm}));
const RANKS=['A','K','Q','J','T','9','8','7','6','5','4','3','2'];
const ri=ch=>RANKS.indexOf(ch);
function strengthOf(rc){ const pair=rc.length===2,su=rc.endsWith('s'),h=ri(rc[0]),l=ri(rc[1]);
  if(pair)return 1-0.045*h; const con=Math.abs(l-h-1)<=1?0.008:0;
  return Math.max(0.05,Math.min(0.99,0.55-0.02*(h+l)+(su?0.035:0)+con)); }
const sizes=[{sizeBB:4,raiseTo:400},{sizeBB:4.5,raiseTo:450},{sizeBB:6,raiseTo:600},{sizeBB:7.5,raiseTo:750},{sizeBB:9,raiseTo:900},{sizeBB:12,raiseTo:1200},{sizeBB:100,raiseTo:10000}];
const pot0=400,hC=100,vC=250,hR=9900,vR=9750,SEED=1757000000000,ITER=6000;
function eqVs(entries,seed){ const o=eqMod.computeEquity([{rank:14,suit:'h'},{rank:14,suit:'d'}],[], [ {label:'c',combos:entries.map(e=>[e.combo.card1,e.combo.card2])} ], {mode:eqTypes.EquityComputeMode.FAST,seed,iterations:ITER,opponentWeights:[entries.map(e=>e.probability)]}); return o.ok?o.result.equity:null; }
function run(cfg){
  const {MARGIN,GATE,VT,VF,MS,BLUFFMAX,FIVEBET_BRANCH_BOOST}=cfg;
  const out=[];
  for(const d of sizes){
    const hAdd=d.raiseTo-hC, vAddRaw=d.raiseTo-vC, vAdd=Math.min(vAddRaw,vR), vTot=vC+vAdd;
    const cont=Math.min(hAdd,vTot-hC), fp=pot0+cont+Math.min(vAdd,cont);
    const allIn=d.raiseTo>=10000-1e-9, vAllInCall=vR<=vAdd+1e-9, canRR=!allIn&&!vAllInCall, price=vAdd/fp;
    const required=Math.max(0,price+MARGIN);
    let fold=0,call=0,rr=0; const ce=[],re=[];
    for(const e of arrivalNorm){ const p=e.probability,s=strengthOf(e.combo.rankClass);
      if(s<required){fold+=p;continue;}
      let share=0; if(canRR&&s>=GATE){ const span=1-GATE,pos=span>0?(s-GATE)/span:0; const isV=s>=VT;
        const vShare=isV?VF+(MS-VF)*Math.max(0,Math.min(1,pos)):0; const bShare=BLUFFMAX>0&&BLUFFMAX<1?0:0; share=Math.max(vShare,bShare); share=Math.max(0,Math.min(1,share)); }
      call+=p*(1-share); rr+=p*share; if(1-share>0)ce.push({combo:e.combo,probability:p*(1-share)}); if(share>0)re.push({combo:e.combo,probability:p*share}); }
    const nrm=a=>{const t=a.reduce((x,y)=>x+y.probability,0);return t>0?a.map(x=>({combo:x.combo,probability:x.probability/t})):[]};
    const nC=nrm(ce),nR=nrm(re);
    const eqC=eqVs(nC,SEED+1301), eqR=nR.length?eqVs(nR,SEED+2601):null;
    let rrFold=-cont, rrCall=null, rrWin=null, rrTo=null, addCall=null;
    if(canRR){ const minRR=d.raiseTo+(d.raiseTo-vC), maxTo=vTot+Math.max(0,vR-vAdd); rrTo=Math.min(minRR,maxTo); addCall=Math.min(rrTo-d.raiseTo,Math.max(0,hR-hAdd)); rrWin=pot0+Math.max(hAdd,rrTo-hC)+vAdd+addCall; rrCall=eqR===null?null:eqR*rrWin-cont-addCall; }
    let rrEV=rrCall===null?rrFold:Math.max(rrFold,rrCall);
    if(FIVEBET_BRANCH_BOOST && rrCall!==null) rrEV=Math.max(rrEV, FIVEBET_BRANCH_BOOST*Math.max(0,(hR-hAdd)));
    const ev=eqC===null?null:fold*pot0+call*(eqC*fp-cont)+rr*rrEV;
    out.push({sizeBB:d.sizeBB,f:fold,c:call,rr,sum:fold+call+rr,price,eqC,eqR,rrEV,ev});
  }
  return out;
}
const base={MARGIN:0.19,GATE:0.44,VT:0.6,VF:0.25,MS:0.85,BLUFFMAX:0};
const variants=[
  ['BASE (production constants)',base],
  ['continueMargin=0.09',{...base,MARGIN:0.09}],
  ['continueMargin=0.14',{...base,MARGIN:0.14}],
  ['continueMargin=0.24',{...base,MARGIN:0.24}],
  ['continueMargin=0.29',{...base,MARGIN:0.29}],
  ['reraiseGate=0.55',{...base,GATE:0.55}],
  ['reraiseGate=0.35',{...base,GATE:0.35}],
  ['reraiseMaxShare=0.60',{...base,MS:0.60}],
  ['reraiseValueThreshold=0.70',{...base,VT:0.70}],
];
const report={};
for(const [name,cfg] of variants){ const rows=run(cfg); report[name]=rows;
  const best=rows.reduce((a,b)=>b.ev>a.ev?b:a);
  console.log('\n### '+name+'   -> best = '+best.sizeBB+'BB ('+best.ev.toFixed(1)+')');
  console.log('  sizeBB  f       c       rr      EV');
  for(const r of rows) console.log('  '+String(r.sizeBB).padEnd(7)+r.f.toFixed(4)+' '+r.c.toFixed(4)+' '+r.rr.toFixed(4)+' '+r.ev.toFixed(2).padStart(9));
}
writeFileSync(OUT+'/sensitivity.json',JSON.stringify(report,null,2),'utf8');
