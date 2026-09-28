import { classifyResponse, neutralResponseTendencies, responseTendenciesOf } from "file:///D:/%E5%BE%B7%E5%B7%9E%E5%86%B3%E7%AD%96/src/domain/postflop/betResponse.ts";
import { archetypeDimensionsOf, ARCHETYPE_CONFIDENCE } from "file:///D:/%E5%BE%B7%E5%B7%9E%E5%86%B3%E7%AD%96/src/domain/player/archetypeDimensions.ts";
import { ALL_CARDS } from "file:///D:/%E5%BE%B7%E5%B7%9E%E5%86%B3%E7%AD%96/src/domain/types.ts";
const neutral = neutralResponseTendencies();
const d = archetypeDimensionsOf("VERY_TIGHT", ARCHETYPE_CONFIDENCE);
const tight = responseTendenciesOf(d, 1);
console.log("NEUTRAL callScale", neutral.callScale, "foldScale", neutral.foldScale);
console.log("TIGHT callScale", tight.callScale, "foldScale", tight.foldScale);
for (const tier of [0,1,2,3,4,5]) {
  const mk = (t) => classifyResponse({ hole:[ALL_CARDS[0],ALL_CARDS[1]], versusHero:"EQUAL", tier, street:"TURN", cardsToCome:1, ratioToPot:1, priceRequiredEquity:0.33, spr:4.67, opponentCount:1, wetness:0.2, tendencies:t, heroIsAllIn:false, villainIsAllInByCall:false, villainDraw:"NO_DRAW" });
  const n = mk(neutral), ti = mk(tight);
  console.log(`tier ${tier}: neutral fold=${n.weights.fold.toFixed(4)} call=${n.weights.call.toFixed(4)} bucket=${n.bucket} | tight fold=${ti.weights.fold.toFixed(4)} bucket=${ti.bucket}`);
}
