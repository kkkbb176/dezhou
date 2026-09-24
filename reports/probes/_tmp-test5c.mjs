import { advisePostflop } from "../../src/app/decision/postflopAdvisor.ts";
import { buildDecisionContext } from "../../src/app/manualInput/contextBuilder.ts";
import { parseManualInput } from "../../src/app/manualInput/manualInput.ts";
import { buildAnalyzableState } from "../../src/app/manualInput/reconstruct.ts";
import { deriveLegalActions } from "../../src/app/manualInput/legalActions.ts";
import { loadKnowledgeBaseOrThrow } from "../../src/domain/knowledge/knowledgeLoader.ts";
const RULES = loadKnowledgeBaseOrThrow().allRules();
const F = (position) => ({ position, type: "FOLD" });
function spot(profile) { return {
  tableSize: 9, heroPosition: "BTN", heroCards: ["Kd","Th"], board: ["Ts","7c","3h"], street: "FLOP",
  effectiveStackBB: 100, seatStacksBB: { UTG: 100, BTN: 100, BB: 100 },
  actionHistory: [
    { position:"UTG",type:"CALL",amountBB:1 }, F("UTG1"),F("UTG2"),F("LJ"),F("HJ"),F("CO"),
    { position:"BTN",type:"CALL",amountBB:1 }, F("SB"), { position:"BB",type:"CHECK" },
    { position:"BB",type:"CHECK",street:"FLOP" }, { position:"UTG",type:"CHECK",street:"FLOP" } ],
  environment:"MID_LOW_STAKES", villain:{ quickProfile: profile, dynamicHint:"UNKNOWN" } }; }
for (const profile of ["CALLING_STATION","VERY_TIGHT"]) {
  const parsed = parseManualInput(spot(profile)); const g = buildAnalyzableState(parsed.value);
  const built = buildDecisionContext({ state: g.state, rules: RULES, environment: "MID_LOW_STAKES", asOf: 1_757_000_000_000, quickProfile: profile });
  const hero = g.state.players.find((p) => p.holeCards !== null);
  const legal = deriveLegalActions(g.state, hero);
  const advice = advisePostflop(built.context, { facingBet: legal.callCost > 0, requiredEquity: built.context.math.requiredEquity, potAfterCall: built.context.math.pot + legal.callCost });
  console.log("=== " + profile + " ===");
  console.log("gate bet", advice.gate.estimatedBetEVScore.toFixed(4), "check", advice.gate.estimatedCheckEVScore.toFixed(4), "verdict", advice.gate.verdict, "role", advice.role);
  for (const s of advice.betDecision.sizes) console.log("  ", s.kind, "bet", s.betAmount.toFixed(1), "ratio", s.ratioToPot.toFixed(3), "fold", s.foldLikelihood.toFixed(4), "call", s.callLikelihood.toFixed(4), "EV", s.betEV?.toFixed(2), "eqCall", s.heroEquityVsCallRange?.toFixed(4));
}
