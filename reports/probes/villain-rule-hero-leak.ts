import { classifyResponse, classifyVillainAfterCheck, responseTendenciesOf } from '../../src/domain/postflop/betResponse.ts';
import { archetypeDimensionsOf } from '../../src/domain/player/archetypeDimensions.ts';
import { parseCardStrict } from '../../src/domain/poker/cards.ts';
const t = responseTendenciesOf(archetypeDimensionsOf('CALLING_STATION', 0.35), 0.35, null);
const base = { hole: ['Kc','Jd'].map(parseCardStrict), tier: 3, street: 'RIVER' as const, cardsToCome: 0, ratioToPot: 1, priceRequiredEquity: 0.25, spr: 2, opponentCount: 1, wetness: 0.2, tendencies: t, heroIsAllIn: false, villainIsAllInByCall: false, villainDraw: 'NO_DRAW' as const };
for (const versusHero of ['STRONGER','EQUAL','WEAKER'] as const) {
  const r = classifyResponse({ ...base, versusHero });
  const c = classifyVillainAfterCheck({ tier: 3, versusHero, tendencies: t, pot: 100, betSize: 75, street: 'RIVER' });
  console.log(versusHero, JSON.stringify(r.weights), JSON.stringify(c.weights), c.valueBet, c.bluffBet);
}
