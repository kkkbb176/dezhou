import fs from 'node:fs';
const j=JSON.parse(fs.readFileSync('reports/aa-utg-sizing-v2/production-diagnostics.json','utf8'));
const pr=j.preflopRaise;
for(const s of pr.sizes){
  const e=s.heroEquityVsRaiseCallRange, er=s.heroEquityVsReraiseRange;
  console.log(JSON.stringify({
    sizeBB:s.sizeBB,sizeChips:s.sizeChips,isAllIn:s.isAllIn,
    currentPot:s.currentPot,heroStreetCommitted:s.heroStreetCommitted,villainStreetCommitted:s.villainStreetCommitted,
    heroAdd:s.heroAdd,villainAddRaw:s.villainAddRaw,villainAdd:s.villainAdd,heroContestedAdd:s.heroContestedAdd,
    finalPot:s.finalPot,uncalledReturn:s.uncalledReturn,heroIsAllIn:s.heroIsAllIn,villainIsAllInByCall:s.villainIsAllInByCall,
    f:s.foldLikelihood,c:s.callLikelihood,rr:s.reRaiseLikelihood,sum:s.foldLikelihood+s.callLikelihood+s.reRaiseLikelihood,
    price:s.priceRequiredEquity,margin:s.priceMargin,
    eqCall:e&&{value:e.value,method:e.method,it:e.iterations},eqRR:er&&{value:er.value,method:er.method,it:er.iterations},
    reachableCombos:s.reachableCombos,callCombos:s.callCombos,rrCombos:s.reRaiseCombos,
    reraiseAvailable:s.reraiseAvailable,reRaiseTo:s.reRaiseTo,heroAdditional:s.heroAdditionalCallVsReRaise,
    rrFold:s.reraiseFoldBranchEV,rrCall:s.reraiseCallBranchEV,rrEV:s.reraiseBranchEV,rrKind:s.reraiseBranchKind,
    raiseEV:s.raiseEV
  }));
}
