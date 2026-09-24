import { analyzeManualHand } from "../../src/app/alphaPipeline.ts";
import { buildDecisionContext } from "../../src/app/manualInput/contextBuilder.ts";
import { parseManualInput, type ManualHandInput } from "../../src/app/manualInput/manualInput.ts";
import { buildAnalyzableState } from "../../src/app/manualInput/reconstruct.ts";
import { deriveLegalActions } from "../../src/app/manualInput/legalActions.ts";
import { advisePostflop } from "../../src/app/decision/postflopAdvisor.ts";
import { loadKnowledgeBaseOrThrow } from "../../src/domain/knowledge/knowledgeLoader.ts";
const RULES = loadKnowledgeBaseOrThrow().allRules();
const F = (p: string) => ({ position: p, type: "FOLD" as const });
function spot(profile: string): ManualHandInput { return { tableSize: 9, heroPosition: "BTN", heroCards: ["Kd","Th"], board: ["Ts","7c","3h"], street: "FLOP", effectiveStackBB: 100, seatStacksBB: { UTG:100, BTN:100, BB:100 }, actionHistory: [{position:"UTG",type:"CALL",amountBB:1},F("UTG1"),F("UTG2"),F("LJ"),F("HJ"),F("CO"),{position:"BTN",type:"CALL",amountBB:1},F("SB"),{position:"BB",type:"CHECK"},{position:"BB",type:"CHECK",street:"FLOP"},{position:"UTG",type:"CHECK",street:"FLOP"}], environment: "MID_LOW_STAKES", villain: { quickProfile: profile, dynamicHint: "UNKNOWN" } } as unknown as ManualHandInput; }
for (const p of ["CALLING_STATION","VERY_TIGHT"]) {
  const input = spot(p);
  const parsed = parseManualInput(input); if (!parsed.ok) continue;
  const gate = buildAnalyzableState(parsed.value); if (!gate.ok) continue;
  const built = buildDecisionContext({ state: gate.state, rules: RULES, environment: "MID_LOW_STAKES", asOf: 1757000000000, quickProfile: p });
  const hero = gate.state.players.find((x:any)=>x.holeCards!==null);
  const legal = deriveLegalActions(gate.state, hero);
  const adv:any = advisePostflop(built.context, { facingBet: legal.callCost>0, requiredEquity: built.context.math.requiredEquity, potAfterCall: built.context.math.pot+legal.callCost });
  console.log("===", p, "pot=", built.context.math.pot);
  console.log("  sizing.gridRatio=", adv.sizing.gridRatio, "targetRatio=", adv.sizing.targetRatio);
  console.log("  betDecision.bestSize=", adv.betDecision.bestSize, "bestAmount=", adv.betDecision.bestAmount, "bestScore=", adv.betDecision.bestScore?.toFixed(4));
  for (const s of adv.betDecision.sizes) console.log("    ", s.kind, "ratioToPot=", s.ratioToPot, "amount=", s.betAmount, "score=", s.score.toFixed(4));
  const r:any = analyzeManualHand(input, { rules: RULES, asOf: 1757000000000, writeLog:false } as any);
  console.log("  FINAL action=", r.decision.action, "sizeChips=", r.decision.sizeChips, "(pot ratio", (r.decision.sizeChips/built.context.math.pot).toFixed(3), ")");
}
