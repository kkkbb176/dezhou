import { readFileSync } from 'node:fs';
const raw = JSON.parse(readFileSync('D:/德州决策/data/gto-cache/strategy/c7348fc89.json','utf8'));
const SUITS=['s','h','d','c']; const hero=new Set(['Ah','Ad']);
function combosOf(hand){ if(hand.length===2){const r=hand[0],out=[];for(let i=0;i<4;i++)for(let j=i+1;j<4;j++)out.push(r+SUITS[i]+r+SUITS[j]);return out;} const a=hand[0],b=hand[1],suited=hand[2]==='s',out=[]; for(const s1 of SUITS)for(const s2 of SUITS){if(suited&&s1!==s2)continue;if(!suited&&s1===s2)continue;out.push(a+s1+b+s2);}return out;}
function w(h){let x=0;for(const a of h.actions)if(a.kind==='RAISE'||a.kind==='ALL_IN')x+=Number(a.frequency)||0;return Math.min(1,Math.max(0,x));}
let fs=0,cwm=0,pc=0,tc=0; const ex=[];
for(const h of raw.range.hands){const x=w(h);fs+=x;cwm+=x*Number(h.combos);tc+=Number(h.combos);if(x>0)pc++;for(const c of combosOf(h.hand)){if(hero.has(c.slice(0,2))||hero.has(c.slice(2,4)))continue;ex.push({weight:x});}}
const mass=ex.reduce((s,x)=>s+x.weight,0); let ps=0,p2=0,supp=0,ent=0;
for(const x of ex){const p=x.weight/mass;ps+=p;p2+=p*p;if(p>0){supp++;ent-=p*Math.log(p);}}
console.log(JSON.stringify({cacheKey:raw.cacheKey,scenario:raw.scenario,solveMeta:raw.solveMeta,quality:raw.quality,source:raw.source,handClasses:raw.range.hands.length,totalClassCombos:tc,positiveClasses:pc,classFrequencySum:fs,comboWeightedMass:cwm,trueComboUniverseAfterDeadCards:1225,positiveCombosAfterDeadCards:supp,pSum:ps,effectiveComboCount:1/p2,normalizedEntropy:ent/Math.log(supp),examples:Object.fromEntries(['AA','AJo','72o'].map(n=>[n,w(raw.range.hands.find(h=>h.hand===n))]))},null,2));