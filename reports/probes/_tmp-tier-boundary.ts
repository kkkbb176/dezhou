import { classifyResponse, responseTendenciesOf } from '../../src/domain/postflop/betResponse.ts';
import { archetypeDimensionsOf } from '../../src/domain/player/archetypeDimensions.ts';
import { parseCardStrict } from '../../src/domain/poker/cards.ts';
const neutral = responseTendenciesOf(archetypeDimensionsOf('UNKNOWN', 0.5), 0.5, null);
const tight = responseTendenciesOf(archetypeDimensionsOf('VERY_TIGHT', 0.5), 0.5, null);
const mk = (t: unknown, tier: number) => classifyResponse({ hole:[parseCardStrict('Kc'),parseCardStrict('Jd')], versusHero:'STRONGER', tier, street:'TURN', cardsToCome:1, ratioToPot:1, priceRequiredEquity:0.33, spr:4.67, opponentCount:1, wetness:0.2, tendencies:t as never, villainDraw:'NO_DRAW', heroIsAllIn:false, villainIsAllInByCall:false }).weights;
for (const tier of [0,1,2,3,4,5]) {
  const n = mk(neutral, tier), g = mk(tight, tier);
  console.log('tier', tier, 'neutral', JSON.stringify(n), 'tight', JSON.stringify(g));
}
console.log('--- strictness checks ---');
const n2=mk(neutral,2), n3=mk(neutral,3), t3=mk(tight,3);
console.log('neutral2.call>neutral3.call ?', n2.call>n3.call, n2.call, n3.call);
console.log('tight3.fold>neutral3.fold ?', t3.fold>n3.fold, t3.fold, n3.fold);
