import { buildPreflopRaiseResponse } from 'file:///D:/德州决策/src/app/manualInput/preflopRaiseResponse.ts';
import { ALL_COMBOS } from 'file:///D:/德州决策/src/domain/range/combo.ts';
const keyOf=(ranks)=>{const a=ranks[0],b=ranks[1];return a===b?`${a}${b}`:`${a}${b}${ranks[2]??'s'}`};
const RANK_ORDER=['A','K','Q','J','T','9','8','7','6','5','4','3','2'];
const rankChar=(r)=>RANK_ORDER[12-r];
// Use actual combos with preflopStrengthOf-equivalent gate: build a strong-only arrival range AA..TT + AKs.
const wanted=new Set(['AA','KK','QQ','JJ','TT','AKs']);
const entries=[];
for(const c of ALL_COMBOS){const [x,y]=c.cardIndices;const r1=rankChar(x%13),r2=rankChar(y%13);const suited=Math.floor(x/13)===Math.floor(y/13);const hi=RANK_ORDER.indexOf(r1)<=RANK_ORDER.indexOf(r2)?r1:r2;const lo=hi===r1?r2:r1;const key=hi===lo?`${hi}${lo}`:`${hi}${lo}${suited?'s':'o'}`;if(wanted.has(key)) entries.push({cardIndices:c.cardIndices,probability:1});}
entries.forEach((e,i)=>{e.probability=1;});
const total=entries.reduce((a,e)=>a+e.probability,0);
entries.forEach(e=>e.probability/=total);
const tend={callScale:1,foldScale:1,raiseScale:1,bluffRaiseScale:1};
for(const villainAdd of [150,200,350,500,650,950,9750]){const finalPot=400+300+villainAdd;const r=buildPreflopRaiseResponse({arrivalEntries:entries,currentPot:400,heroAdd:300,villainAdd,finalPot,tendencies:tend,heroIsAllIn:false,villainIsAllInByCall:false});console.log(JSON.stringify({villainAdd,combos:entries.length,price:+r.priceRequiredEquity.toFixed(4),req:+r.requiredStrength.toFixed(4),f:+r.foldLikelihood.toFixed(4),c:+r.callLikelihood.toFixed(4),rr:+r.reRaiseLikelihood.toFixed(4),callCombos:r.callCombos,reRaiseCombos:r.reRaiseCombos}));}
