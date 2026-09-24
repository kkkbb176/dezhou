import fs from 'node:fs';
const p = 'reports/gtopen-validation/9max-cold-solve-repro/hero-allin-explain.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const pr = j.preflopRaise;
const sizes = Array.isArray(pr) ? pr : (pr?.sizes ?? []);
console.log('sizes count:', sizes.length);
for (const s of sizes) {
  const f = s.foldLikelihood, c = s.callLikelihood, rr = s.reRaiseLikelihood;
  const eqCall = s.heroEquityVsRaiseCallRange?.value;
  const recomputed = eqCall == null ? null : f * s.currentPot + c * (eqCall * s.finalPot - s.heroContestedAdd) + rr * s.reraiseBranchEV;
  console.log(JSON.stringify({ sizeBB: s.sizeBB, sizeChips: s.sizeChips, isAllIn: s.isAllIn, f, c, rr, sum: f + c + rr, currentPot: s.currentPot, heroAdd: s.heroAdd, villainAdd: s.villainAdd, heroContestedAdd: s.heroContestedAdd, finalPot: s.finalPot, uncalledReturn: s.uncalledReturn, eqCall, eqRR: s.heroEquityVsReraiseRange?.value, reraiseAvailable: s.reraiseAvailable, reRaiseTo: s.reRaiseTo, heroAdditionalCallVsReRaise: s.heroAdditionalCallVsReRaise, reraiseFoldBranchEV: s.reraiseFoldBranchEV, reraiseCallBranchEV: s.reraiseCallBranchEV, reraiseBranchEV: s.reraiseBranchEV, reraiseBranchKind: s.reraiseBranchKind, heroFiveBetExpanded: s.heroFiveBetExpanded, reportEV: s.raiseEV, recomputed, delta: recomputed == null ? null : recomputed - s.raiseEV, reachableCombos: s.reachableCombos, callCombos: s.callCombos, reRaiseCombos: s.reRaiseCombos }));
}
