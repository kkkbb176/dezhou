import { classifyResponse, neutralResponseTendencies, responseTendenciesOf } from "./src/domain/postflop/betResponse.ts";
import { archetypeDimensionsOf, ARCHETYPE_CONFIDENCE } from "./src/domain/player/archetypeDimensions.ts";
import { ALL_CARDS } from "./src/domain/types.ts";
const base = { hole: [ALL_CARDS[0], ALL_CARDS[1]], versusHero: "STRONGER", tier: 3, street: "TURN", cardsToCome: 1, ratioToPot: 1, priceRequiredEquity: 0.33, spr: 4.67, opponentCount: 1, wetness: 0.2, heroIsAllIn: false, villainIsAllInByCall: false, villainDraw: "NO_DRAW" };
for (const [name, t] of [["neutral", neutralResponseTendencies()], ["tight", responseTendenciesOf(archetypeDimensionsOf("VERY_TIGHT", ARCHETYPE_CONFIDENCE), 1)]]) {
  const r = classifyResponse({ ...base, tendencies: t });
  console.log(JSON.stringify({name,tier:3,continueIndex:r.continueIndex,requiredWithMargin:r.requiredWithMargin,strengthScore:r.strengthScore,weights:r.weights,bucket:r.bucket,reasons:r.reasonsZh}));
}
