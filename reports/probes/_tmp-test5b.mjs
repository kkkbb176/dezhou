import { analyzeManualHand } from "../../src/app/alphaPipeline.ts";
import { buildDecisionContext } from "../../src/app/manualInput/contextBuilder.ts";
import { parseManualInput } from "../../src/app/manualInput/manualInput.ts";
import { buildAnalyzableState } from "../../src/app/manualInput/reconstruct.ts";
import { loadKnowledgeBaseOrThrow } from "../../src/domain/knowledge/knowledgeLoader.ts";
const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false };
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
  const r = analyzeManualHand(spot(profile), OPTIONS);
  if (!r.ok) { console.log(profile, "FAIL"); continue; }
  console.log("=== " + profile + " ===");
  console.log("top keys:", Object.keys(r).join(","));
  console.log("advice keys:", r.advice ? Object.keys(r.advice).join(",") : "none");
  const s = JSON.stringify(r.advice, (k,v)=>typeof v==="number"?Number(v.toFixed(5)):v);
  console.log(s.slice(0, 4000));
}
