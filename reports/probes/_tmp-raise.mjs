import { classifyResponse, neutralResponseTendencies } from "../../src/domain/postflop/betResponse.ts";
import { ALL_CARDS } from "../../src/domain/types.ts";
const t = neutralResponseTendencies();
for (const ratio of [0.333, 0.667, 1.0]) {
  const b = ratio * 50; const r = b/(50+2*b);
  const c = classifyResponse({ hole:[ALL_CARDS[0],ALL_CARDS[1]], versusHero:"EQUAL", tier:0, street:"FLOP", cardsToCome:2, ratioToPot:ratio, priceRequiredEquity:r, spr:5, opponentCount:1, wetness:0.3, tendencies:t, heroIsAllIn:false, villainIsAllInByCall:false, villainDraw:"NO_DRAW" });
  console.log(ratio, "price", r.toFixed(3), "raise", c.weights.raise.toFixed(4));
}
