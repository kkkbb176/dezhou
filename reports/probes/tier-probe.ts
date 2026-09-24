import { classifyResponse, neutralResponseTendencies } from '../../src/domain/postflop/betResponse.ts';
import { ALL_CARDS } from '../../src/domain/types.ts';
for (const tier of [1,2,3,4]) {
  const r = classifyResponse({ hole:[ALL_CARDS[0]!,ALL_CARDS[1]!], versusHero:'STRONGER', tier, street:'TURN', cardsToCome:1, ratioToPot:1, priceRequiredEquity:0.33, spr:4.67, opponentCount:1, wetness:0.2, tendencies:neutralResponseTendencies(), villainDraw:'NO_DRAW', heroIsAllIn:false, villainIsAllInByCall:false });
  console.log(JSON.stringify({tier,bucket:r.bucket,weights:r.weights,continueIndex:r.continueIndex,requiredWithMargin:r.requiredWithMargin}));
}
