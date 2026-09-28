import { analyzeManualHand } from "../../src/app/alphaPipeline.ts";
import { buildDecisionContext } from "../../src/app/manualInput/contextBuilder.ts";
import { parseManualInput } from "../../src/app/manualInput/manualInput.ts";
import { buildAnalyzableState } from "../../src/app/manualInput/reconstruct.ts";
import { loadKnowledgeBaseOrThrow } from "../../src/domain/knowledge/knowledgeLoader.ts";
const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false };
const STACKS = { UTG: 90, HJ: 120, CO: 130, BTN: 150, SB: 95, BB: 110 };
const node = {
  tableSize: 6, heroPosition: "BTN", heroCards: ["Ks","Qs"], board: ["Jd","8c","4h"], street: "FLOP",
  effectiveStackBB: 82, bigBlindBB: 2, seatStacksBB: { ...STACKS },
  seatProfiles: { UTG: "LOOSE", CO: "CALLING_STATION" },
  actionHistory: [
    { position:"UTG",type:"CALL",amountBB:1 },{ position:"HJ",type:"CALL",amountBB:1 },{ position:"CO",type:"CALL",amountBB:1 },
    { position:"BTN",type:"RAISE",amountBB:8 },{ position:"SB",type:"FOLD" },{ position:"BB",type:"FOLD" },
    { position:"UTG",type:"CALL",amountBB:7 },{ position:"HJ",type:"FOLD" },{ position:"CO",type:"CALL",amountBB:7 },
    { position:"UTG",type:"CHECK",street:"FLOP" },{ position:"CO",type:"CHECK",street:"FLOP" } ],
  environment: "MID_LOW_STAKES", villain: { quickProfile:"UNKNOWN", dynamicHint:"UNKNOWN", stackBB:82 },
};
const parsed = parseManualInput(node);
if (!parsed.ok) { console.log("PARSE FAIL", JSON.stringify(parsed.issues)); process.exit(1); }
const g = buildAnalyzableState(parsed.value);
if (!g.ok) { console.log("STATE FAIL", JSON.stringify(g.issues)); process.exit(1); }
const built = buildDecisionContext({ state: g.state, rules: RULES, environment: "MID_LOW_STAKES", asOf: 1_757_000_000_000, seatProfiles: node.seatProfiles });
const bd = built.context.postflopFacts?.betDecision;
console.log("sizes:");
for (const s of bd.sizes) console.log(" ", s.kind, "bet", s.betAmount?.toFixed?.(1), "fold", s.foldLikelihood?.toFixed?.(5), "call", s.callLikelihood?.toFixed?.(5), "raise", s.raiseLikelihood?.toFixed?.(5), "evKind", s.evKind);
const m = bd.multiway;
if (m) { console.log("multi totalBetEV:"); for (const t of m.totalBetEV) console.log(" ", t.kind, t.betAmount?.toFixed?.(1), t.evKind, t.totalEV?.toFixed?.(2)); }

