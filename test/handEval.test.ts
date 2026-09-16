/**
 * 牌力评估引擎测试
 *
 * 覆盖规范第 19 / 20 / 45 条；Bug 预判 B4 / B5 / B6 / B7 / B8 / B9。
 * 每一类牌型都给出人工可复核的基准用例。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  bestFiveOf,
  boardIsBestFive,
  compareHands,
  evaluateCards,
  showdown,
  straightHigh,
  usesHoleCards,
} from '../src/domain/poker/handEval.ts';
import { HandCategory } from '../src/domain/types.ts';
import { C } from './helpers.ts';

function evaluate(spec: string) {
  return evaluateCards(C(spec));
}

describe('牌力 —— 九种牌型全部识别', () => {
  it('高牌', () => {
    const hand = evaluate('As Kd 9h 7c 3s');
    assert.equal(hand.category, HandCategory.HIGH_CARD);
    assert.deepEqual(hand.ranks, [14, 13, 9, 7, 3]);
  });

  it('一对', () => {
    const hand = evaluate('As Ad 9h 7c 3s');
    assert.equal(hand.category, HandCategory.ONE_PAIR);
    assert.deepEqual(hand.ranks, [14, 9, 7, 3]);
  });

  it('两对', () => {
    const hand = evaluate('As Ad 9h 9c 3s');
    assert.equal(hand.category, HandCategory.TWO_PAIR);
    assert.deepEqual(hand.ranks, [14, 9, 3]);
  });

  it('三条', () => {
    const hand = evaluate('As Ad Ah 9c 3s');
    assert.equal(hand.category, HandCategory.THREE_OF_A_KIND);
    assert.deepEqual(hand.ranks, [14, 9, 3]);
  });

  it('顺子', () => {
    const hand = evaluate('9s 8d 7h 6c 5s');
    assert.equal(hand.category, HandCategory.STRAIGHT);
    assert.deepEqual(hand.ranks, [9]);
  });

  it('同花', () => {
    const hand = evaluate('As Ks 9s 7s 3s');
    assert.equal(hand.category, HandCategory.FLUSH);
    assert.deepEqual(hand.ranks, [14, 13, 9, 7, 3]);
  });

  it('葫芦', () => {
    const hand = evaluate('As Ad Ah 9c 9s');
    assert.equal(hand.category, HandCategory.FULL_HOUSE);
    assert.deepEqual(hand.ranks, [14, 9]);
  });

  it('四条', () => {
    const hand = evaluate('As Ad Ah Ac 9s');
    assert.equal(hand.category, HandCategory.FOUR_OF_A_KIND);
    assert.deepEqual(hand.ranks, [14, 9]);
  });

  it('同花顺', () => {
    const hand = evaluate('9s 8s 7s 6s 5s');
    assert.equal(hand.category, HandCategory.STRAIGHT_FLUSH);
    assert.deepEqual(hand.ranks, [9]);
  });

  it('皇家顺子结构 = A 高同花顺', () => {
    const royal = evaluate('As Ks Qs Js Ts');
    assert.equal(royal.category, HandCategory.STRAIGHT_FLUSH);
    assert.deepEqual(royal.ranks, [14]);
    // 皇家同花顺强于任何四条
    const quads = evaluate('As Ad Ah Ac Ks');
    assert.equal(compareHands(royal, quads), 1);
  });
});

describe('牌力 —— A2345 小顺（轮子）', () => {
  it('五张轮子被识别为 5 高顺子而不是 A 高', () => {
    const hand = evaluate('As 2d 3h 4c 5s');
    assert.equal(hand.category, HandCategory.STRAIGHT);
    assert.deepEqual(hand.ranks, [5]);
  });

  it('七张中也能认出轮子', () => {
    const hand = evaluate('As 2d 3h 4c 5s Kd Qh');
    assert.equal(hand.category, HandCategory.STRAIGHT);
    assert.deepEqual(hand.ranks, [5]);
  });

  it('轮子弱于 6 高顺子', () => {
    const wheel = evaluate('As 2d 3h 4c 5s');
    const six = evaluate('2s 3d 4h 5c 6s');
    assert.equal(compareHands(wheel, six), -1);
  });

  it('A2345 同花被识别为同花顺（5 高）', () => {
    const hand = evaluate('As 2s 3s 4s 5s');
    assert.equal(hand.category, HandCategory.STRAIGHT_FLUSH);
    assert.deepEqual(hand.ranks, [5]);
  });

  it('A 只能在 A2345 或 AKQJT 中充当顺子端点', () => {
    // Q K A 2 3 不是顺子
    assert.equal(evaluate('Qs Kd Ah 2c 3s').category, HandCategory.HIGH_CARD);
    // K A 2 3 4 不是顺子
    assert.equal(evaluate('Ks Ad 2h 3c 4s').category, HandCategory.HIGH_CARD);
  });

  it('straightHigh 查表覆盖所有边界', () => {
    const mask = (ranks: number[]) => ranks.reduce((acc, r) => acc | (1 << (r - 2)), 0);
    assert.equal(straightHigh(mask([14, 2, 3, 4, 5])), 5); // 轮子
    assert.equal(straightHigh(mask([10, 11, 12, 13, 14])), 14); // 皇家
    assert.equal(straightHigh(mask([9, 10, 11, 12, 13])), 13);
    assert.equal(straightHigh(mask([2, 3, 4, 5])), 0); // 只有 4 张
    assert.equal(straightHigh(mask([13, 14, 2, 3, 4])), 0); // K-A-2-3-4 不是顺子
    assert.equal(straightHigh(mask([12, 13, 14, 2, 3])), 0); // Q-K-A-2-3 不是顺子
  });
});

describe('牌力 —— 踢脚', () => {
  it('同为一对时比较踢脚', () => {
    const acesKingKicker = evaluate('As Ad Kh 7c 3s');
    const acesQueenKicker = evaluate('As Ad Qh 7c 3s');
    assert.equal(compareHands(acesKingKicker, acesQueenKicker), 1);
  });

  it('两对时先比大对，再比小对，最后比踢脚', () => {
    const ak9 = evaluate('As Ad 9h 9c 3s');
    const aq9 = evaluate('As Ad 9h 9c 3s'.replace('As', 'Ah').replace('Ad', 'Ac'));
    assert.equal(compareHands(ak9, aq9), 0); // 完全相同即为平局

    const acesKingsNine = evaluate('As Ad Kh Kc 9s');
    const acesQueensNine = evaluate('As Ad Qh Qc 9s');
    assert.equal(compareHands(acesKingsNine, acesQueensNine), 1);

    const withJack = evaluate('As Ad 9h 9c Js');
    const withEight = evaluate('As Ad 9h 9c 8s');
    assert.equal(compareHands(withJack, withEight), 1);
  });

  it('三条比较踢脚，且踢脚绝不含三条自身点数', () => {
    const jacksQueenKicker = evaluate('Js Jd Jh Qc 3s');
    const jacksTenKicker = evaluate('Js Jd Jh Tc 3s');
    assert.equal(jacksQueenKicker.category, HandCategory.THREE_OF_A_KIND);
    assert.deepEqual(jacksQueenKicker.ranks, [11, 12, 3]);
    assert.equal(compareHands(jacksQueenKicker, jacksTenKicker), 1);
  });

  it('四条比较踢脚，且踢脚排除四条自身的点数', () => {
    const quadsAceKing = evaluate('7s 7d 7h 7c As');
    assert.equal(quadsAceKing.category, HandCategory.FOUR_OF_A_KIND);
    assert.deepEqual(quadsAceKing.ranks, [7, 14]);
    const quadsAceKing2 = evaluate('7s 7d 7h 7c Ks');
    assert.equal(compareHands(quadsAceKing, quadsAceKing2), 1);
  });

  it('葫芦先比三条再比对子（顺序绝不能反）', () => {
    const kingsFullOfTwos = evaluate('Ks Kd Kh 2c 2s');
    const queensFullOfAces = evaluate('Qs Qd Qh Ac As');
    assert.deepEqual(kingsFullOfTwos.ranks, [13, 2]);
    assert.deepEqual(queensFullOfAces.ranks, [12, 14]);
    // 三条大的赢，哪怕对子小
    assert.equal(compareHands(kingsFullOfTwos, queensFullOfAces), 1);
  });

  it('同花逐张比较，第一张不同即分出胜负', () => {
    const aceHigh = evaluate('As Ks 9s 7s 3s');
    const kingHigh = evaluate('Ks Qs 9s 7s 3s');
    assert.equal(compareHands(aceHigh, kingHigh), 1);
    // 前四张相同、第五张不同
    const five = evaluate('As Ks 9s 7s 5s');
    const four = evaluate('As Ks 9s 7s 4s');
    assert.equal(compareHands(five, four), 1);
  });
});

describe('牌力 —— 7 张取最优五张', () => {
  it('不会只取「出现次数最多的牌型」而漏掉同花', () => {
    // 手上形成两对，同时五张黑桃成同花：必须识别为同花
    const hand = evaluate('As Ks Qh Qd 9s 7s 2s');
    assert.equal(hand.category, HandCategory.FLUSH);
    assert.deepEqual(hand.ranks, [14, 13, 9, 7, 2]);
  });

  it('同时存在顺子与同花时取同花', () => {
    // 黑桃：A 9 8 7 2 共 5 张 → 同花；同时 9-8-7-6-5 成顺子 → 取同花
    const hand = evaluate('As 9s 8s 7s 6h 5c 2s');
    assert.equal(hand.category, HandCategory.FLUSH);
    assert.deepEqual(hand.ranks, [14, 9, 8, 7, 2]);
  });

  it('同时存在同花与葫芦时取葫芦（但同花顺压过葫芦）', () => {
    const fullHouse = evaluate('As Ad Ah Ks Kd 5s 3s');
    assert.equal(fullHouse.category, HandCategory.FULL_HOUSE);
    assert.deepEqual(fullHouse.ranks, [14, 13]);

    const straightFlush = evaluate('9s 8s 7s 6s 5s Ad Ah');
    assert.equal(straightFlush.category, HandCategory.STRAIGHT_FLUSH);
  });

  it('能识别出「用公共牌配对 + 底牌踢脚」的组合', () => {
    const hand = evaluate('Kh Qd Qs Qc 2h 3d 4s');
    assert.equal(hand.category, HandCategory.THREE_OF_A_KIND);
    assert.deepEqual(hand.ranks, [12, 13, 4]);
  });

  it('bestFiveOf 返回的 5 张牌与评估结果一致', () => {
    const cards = C('As Ks Qs Js Ts 2h 3d');
    const best = bestFiveOf(cards);
    assert.equal(best.length, 5);
    assert.equal(evaluateCards(best).value, evaluateCards(cards).value);
    assert.equal(evaluateCards(best).category, HandCategory.STRAIGHT_FLUSH);
  });

  it('只接受 5~7 张牌', () => {
    assert.throws(() => evaluateCards(C('As Kd 9h 7c')), /只支持 5~7 张牌/);
    assert.throws(() => evaluateCards(C('As Kd 9h 7c 3s 2d 4h 5s')), /只支持 5~7 张牌/);
    assert.throws(() => bestFiveOf(C('As Kd 9h 7c')), /只支持 5~7 张牌/);
  });

  it('五张与七张对同一组牌的判断一致（多余的牌不改变结论）', () => {
    const five = evaluate('9s 8s 7s 6s 5s');
    const seven = evaluate('9s 8s 7s 6s 5s 2h 3d');
    assert.equal(five.value, seven.value);
  });
});

describe('牌力 —— 公共牌成牌与打公共牌', () => {
  it('公共牌本身就是最佳五张（双方都打公共牌 → 平分）', () => {
    const board = C('As Ks Qs Js Ts');
    const me = C('2h 3d');
    const opponent = C('4h 5d');
    assert.equal(boardIsBestFive(me, board), true);
    assert.equal(boardIsBestFive(opponent, board), true);
    assert.equal(usesHoleCards(me, board), false);

    const result = showdown(
      [
        { id: 'me', holeCards: me },
        { id: 'opponent', holeCards: opponent },
      ],
      board,
    );
    assert.equal(result.isSplit, true);
    assert.deepEqual(result.winners, ['me', 'opponent']);
  });

  it('公共牌成顺：底牌接不上顺子就只能打牌面', () => {
    const board = C('9h 8d 7c 6s 5h');
    assert.equal(boardIsBestFive(C('As Kd'), board), true); // A 高不成顺
    // T 能组成 10 高顺子
    assert.equal(boardIsBestFive(C('Ts 2d'), board), false);
    assert.equal(usesHoleCards(C('Ts 2d'), board), true);
  });

  it('公共牌成同花：需要更大的同花才能用到底牌', () => {
    const board = C('9s 7s 5s 3s 2s');
    assert.equal(boardIsBestFive(C('Kh Qd'), board), true);
    // 手上有更大的黑桃，成 A 高同花
    assert.equal(boardIsBestFive(C('As Kd'), board), false);
    const me = evaluateCards([...C('As Kd'), ...board]);
    assert.equal(me.category, HandCategory.FLUSH);
    assert.equal(me.ranks[0], 14);
  });

  it('两对公共牌 + 踢脚决定胜负', () => {
    const board = C('Ks Kd 9h 9c 2s');
    const withAce = evaluateCards([...C('As 3d'), ...board]);
    const withQueen = evaluateCards([...C('Qh 3c'), ...board]);
    assert.equal(withAce.category, HandCategory.TWO_PAIR);
    assert.deepEqual(withAce.ranks, [13, 9, 14]);
    assert.equal(compareHands(withAce, withQueen), 1);
  });

  it('公共牌是三条时，有更大踢脚或用口袋对子成葫芦', () => {
    const board = C('7s 7d 7h Kc 2s');
    const tripsKingKicker = evaluateCards([...C('As 3d'), ...board]);
    const tripsTwoKicker = evaluateCards([...C('Qh 3c'), ...board]);
    assert.equal(tripsKingKicker.category, HandCategory.THREE_OF_A_KIND);
    assert.deepEqual(tripsKingKicker.ranks, [7, 14, 13]);
    assert.equal(compareHands(tripsKingKicker, tripsTwoKicker), 1);

    const fullHouse = evaluateCards([...C('Ks 2d'), ...board]);
    assert.equal(fullHouse.category, HandCategory.FULL_HOUSE);
    assert.deepEqual(fullHouse.ranks, [7, 13]);
  });
});

describe('牌力 —— 平分底池', () => {
  it('完全相同的五张牌平分', () => {
    const board = C('As Kd Qh Jc Ts');
    const result = showdown(
      [
        { id: 'a', holeCards: C('2h 3d') },
        { id: 'b', holeCards: C('4h 5d') },
      ],
      board,
    );
    assert.equal(result.isSplit, true);
    assert.equal(result.winners.length, 2);
    assert.equal(result.bestValue, evaluateCards([...C('2h 3d'), ...board]).value);
  });

  it('三人平分也能正确识别', () => {
    const board = C('As Kd Qh Jc Ts');
    const result = showdown(
      [
        { id: 'a', holeCards: C('2h 3d') },
        { id: 'b', holeCards: C('4h 5d') },
        { id: 'c', holeCards: C('6h 7d') },
      ],
      board,
    );
    assert.equal(result.winners.length, 3);
  });

  it('用公共牌配对时双方踢脚相同时平分', () => {
    const board = C('Ks 9d 7h 3c 2s');
    const result = showdown(
      [
        { id: 'a', holeCards: C('Kd Qh') },
        { id: 'b', holeCards: C('Kc Qs') },
      ],
      board,
    );
    assert.equal(result.isSplit, true);
  });
});

describe('牌力 —— 反超与被反超', () => {
  it('翻牌领先的一方在河牌被反超', () => {
    const me = C('Ah Ad');
    const opponent = C('Kh Kd');
    const flop = C('2c 7d 9s');
    const turn = C('3h');
    const river = C('Kc');

    const onFlop = showdown([{ id: 'me', holeCards: me }, { id: 'o', holeCards: opponent }], flop);
    assert.deepEqual(onFlop.winners, ['me']);

    const onTurn = showdown(
      [{ id: 'me', holeCards: me }, { id: 'o', holeCards: opponent }],
      [...flop, ...turn],
    );
    assert.deepEqual(onTurn.winners, ['me']);

    const onRiver = showdown(
      [{ id: 'me', holeCards: me }, { id: 'o', holeCards: opponent }],
      [...flop, ...turn, ...river],
    );
    assert.deepEqual(onRiver.winners, ['o']);
  });
});

describe('牌力 —— 强度编码的单调性（属性测试）', () => {
  it('任意两手牌的比较结果只可能是 -1 / 0 / 1，且大者恒大于小者', () => {
    const hands = [
      evaluate('As Kd 9h 7c 3s'),
      evaluate('As Ad 9h 7c 3s'),
      evaluate('As Ad 9h 9c 3s'),
      evaluate('As Ad Ah 9c 3s'),
      evaluate('9s 8d 7h 6c 5s'),
      evaluate('As Ks 9s 7s 3s'),
      evaluate('As Ad Ah 9c 9s'),
      evaluate('As Ad Ah Ac 9s'),
      evaluate('9s 8s 7s 6s 5s'),
    ];
    for (let i = 0; i < hands.length; i++) {
      for (let j = 0; j < hands.length; j++) {
        const result = compareHands(hands[i]!, hands[j]!);
        if (i === j) assert.equal(result, 0);
        else if (i > j) assert.equal(result, 1, `${i} 应强于 ${j}`);
        else assert.equal(result, -1, `${i} 应弱于 ${j}`);
      }
    }
  });

  it('强度编码不超过 JS 安全整数上界（不会因溢出而比较失真）', () => {
    const strongest = evaluate('As Ks Qs Js Ts');
    assert.equal(strongest.category, HandCategory.STRAIGHT_FLUSH);
    assert.ok(strongest.value < Number.MAX_SAFE_INTEGER, `编码过大：${strongest.value}`);
    // 跨牌型必须严格有序：最弱同花顺 > 最强四条 > 最强葫芦
    assert.ok(evaluate('5s 4s 3s 2s As').value > evaluate('As Ad Ah Ac Kd').value);
    assert.ok(evaluate('As Ad Ah Ac Kd').value > evaluate('As Ad Ah Kc Kd').value);
    // 踢脚差异不能被浮点舍入吃掉
    const kickerAce = evaluate('Js Jd Jh Ac 2s');
    const kickerKing = evaluate('Js Jd Jh Kc 2s');
    assert.notEqual(kickerAce.value, kickerKing.value);
    assert.ok(kickerAce.value > kickerKing.value);
  });
});
