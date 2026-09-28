/**
 * 对手行为规则的信息边界回归。
 *
 * 规则层只允许使用公共信息（公共牌档位、听牌、价格、街、画像）；
 * `versusHero` 只是范围汇总层的诊断标签，不得改变单个对手组合的行动概率。
 * 汇总层仍会因 Hero 底牌产生 blocker / 重归一化差异，这由 contextBuilder 测试覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyResponse,
  classifyVillainAfterCheck,
  responseTendenciesOf,
} from '../src/domain/postflop/betResponse.ts';
import { boardRelativeTierOf } from '../src/domain/poker/boardRelativeStrength.ts';
import { drawProfileOf } from '../src/domain/postflop/draws.ts';
import { compareHands, evaluateCards } from '../src/domain/poker/handEval.ts';
import { buildBettingRangeFacts, type ArrivalEntry } from '../src/app/manualInput/bettingRange.ts';
import { archetypeDimensionsOf } from '../src/domain/player/archetypeDimensions.ts';
import { ALL_CARDS, parseCardStrict } from '../src/domain/poker/cards.ts';
import type { Card } from '../src/domain/types.ts';

const tendencies = responseTendenciesOf(archetypeDimensionsOf('CALLING_STATION', 0.35), 0.35, null);
const BOARD = ['Jd', '8c', '4h'].map(parseCardStrict);

function cardIndexOf(raw: string): number {
  const card = parseCardStrict(raw);
  return ALL_CARDS.findIndex((c) => c.rank === card.rank && c.suit === card.suit);
}

function arrivalOf(combos: readonly (readonly [string, string])[]): ArrivalEntry[] {
  return combos.map(([a, b]) => ({
    cardIndices: [cardIndexOf(a), cardIndexOf(b)] as [number, number],
    probability: 1,
  }));
}

const ARRIVAL = arrivalOf([
  ['Ks', 'Qh'], ['Ks', 'Jh'], ['Ac', 'Ks'], ['Qc', 'Qd'],
  ['9d', '9h'], ['Ah', 'Qs'], ['Kh', 'Th'], ['7c', '7d'],
]);

function responseWeights(versusHero: 'STRONGER' | 'WEAKER' | 'EQUAL', tier: number) {
  return classifyResponse({
    hole: ['Kc', 'Jd'].map(parseCardStrict) as [Card, Card],
    versusHero,
    tier,
    street: 'RIVER',
    cardsToCome: 0,
    ratioToPot: 1,
    priceRequiredEquity: 0.25,
    spr: 2,
    opponentCount: 1,
    wetness: 0.2,
    tendencies,
    heroIsAllIn: false,
    villainIsAllInByCall: false,
    villainDraw: 'NO_DRAW',
  }).weights;
}

function afterCheckWeights(versusHero: 'STRONGER' | 'WEAKER' | 'EQUAL', tier: number) {
  return classifyVillainAfterCheck({
    tier,
    versusHero,
    tendencies,
    pot: 100,
    betSize: 75,
    street: 'RIVER',
  }).weights;
}

test('R1：对手响应规则不得随 Hero 隐藏底牌强弱变化', () => {
  for (const tier of [0, 1, 2, 3, 4, 5]) {
    const stronger = responseWeights('STRONGER', tier);
    const equal = responseWeights('EQUAL', tier);
    const weaker = responseWeights('WEAKER', tier);
    assert.deepEqual(equal, stronger, `档 ${tier}：EQUAL 与 STRONGER 必须逐位相同`);
    assert.deepEqual(weaker, stronger, `档 ${tier}：WEAKER 与 STRONGER 必须逐位相同`);
  }
});

test('R2：Hero 过牌后的对手下注规则不得读取 versusHero', () => {
  for (const tier of [0, 1, 2, 3, 4, 5]) {
    const stronger = afterCheckWeights('STRONGER', tier);
    const equal = afterCheckWeights('EQUAL', tier);
    const weaker = afterCheckWeights('WEAKER', tier);
    assert.deepEqual(equal, stronger, `档 ${tier}：EQUAL 与 STRONGER 必须逐位相同`);
    assert.deepEqual(weaker, stronger, `档 ${tier}：WEAKER 与 STRONGER 必须逐位相同`);
  }
});

/**
 * R3：有效对照 —— 两次输入必须真的不同。
 *
 * 旧审计里出现过「调用函数根本不接收底牌，却声称验证底牌独立性」的空测试。
 * 本测试先用**同一对手组合集合**、只换 Hero 底牌：
 *   ① 对手规则层对同一组合（同一公共牌档位／听牌／价格／画像）给出的
 *      弃/跟/加权重必须逐位相同 —— `versusHero` 不得进入规则；
 *   ② 但 Hero 视角的汇总范围必须真的变化 —— 底牌通过**合法死牌过滤**
 *      改变可达组合集合。若两次汇总完全相同，说明底牌根本没被消费，
 *      本测试就不能用来宣称任何独立性。
 */
test('R3：有效对照 —— 规则层逐组合不变，汇总范围因合法阻断真实变化', () => {
  const heroA = ['As', 'Ks'].map(parseCardStrict);
  const heroB = ['Qc', 'Qd'].map(parseCardStrict);

  // ① 规则层：同一对手组合，只用它对两个 Hero 的相对强弱标签作输入
  const hole = ['9d', '9h'].map(parseCardStrict) as [Card, Card];
  const tier = boardRelativeTierOf(hole, BOARD)!;
  const draw = drawProfileOf(hole, BOARD);
  const villainDraw = draw.flushDraw || draw.openEnded
    ? 'STRONG_DRAW' as const
    : draw.gutshot ? 'WEAK_DRAW' as const : 'NO_DRAW' as const;
  const versusOf = (hero: readonly Card[]) => {
    const cmp = compareHands(evaluateCards([...hole, ...BOARD]), evaluateCards([...hero, ...BOARD]));
    return cmp > 0 ? 'STRONGER' as const : cmp < 0 ? 'WEAKER' as const : 'EQUAL' as const;
  };
  const ruleInputOf = (hero: readonly Card[]) => ({
    hole, versusHero: versusOf(hero), tier, street: 'RIVER' as const, cardsToCome: 0,
    ratioToPot: 0.75, priceRequiredEquity: 0.3, spr: 3, opponentCount: 2,
    wetness: 0.3, tendencies, villainDraw, heroIsAllIn: false, villainIsAllInByCall: false,
  });
  assert.deepEqual(
    classifyResponse(ruleInputOf(heroB)).weights,
    classifyResponse(ruleInputOf(heroA)).weights,
    '同一对手组合的规则权重不得随 Hero 隐藏底牌变化',
  );

  // ② 汇总层：合法死牌过滤必须让 Hero 视角范围真的不同
  const rangeA = buildBettingRangeFacts({
    arrivalEntries: ARRIVAL, board: BOARD, heroHole: heroA,
    potChips: 53, betChips: 40, street: 'RIVER', tendencies,
  });
  const rangeB = buildBettingRangeFacts({
    arrivalEntries: ARRIVAL, board: BOARD, heroHole: heroB,
    potChips: 53, betChips: 40, street: 'RIVER', tendencies,
  });
  assert.notEqual(rangeA, null, 'Hero A 的下注范围必须可算');
  assert.notEqual(rangeB, null, 'Hero B 的下注范围必须可算');
  assert.notEqual(
    rangeA!.entries.length,
    rangeB!.entries.length,
    '合法阻断必须真实生效：换 Hero 底牌后可达组合数应不同（否则对照无效）',
  );
  assert.notEqual(
    rangeA!.arrivalMass,
    rangeB!.arrivalMass,
    '死牌过滤后，Hero 视角的到达质量必须真实不同',
  );
});
