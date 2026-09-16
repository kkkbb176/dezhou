/**
 * 牌对象测试：构造、严格解析、52 张唯一性
 *
 * 覆盖规范第 6 / 7 / 14 条；Bug 预判 B1 / B2 / B3。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_CARDS,
  cardIndex,
  cardKey,
  cardToString,
  containsCard,
  createDeck,
  deckIsUnique,
  findDuplicates,
  hasDuplicates,
  indexToCard,
  makeCard,
  parseCard,
  parseCardStrict,
  parseCardsLoose,
  removeUsedCards,
} from '../src/domain/poker/cards.ts';
import { CardParseCode } from '../src/domain/domainCodes.ts';
import { ALL_SUITS, type Card } from '../src/domain/types.ts';
import { C, c } from './helpers.ts';

describe('牌 —— 牌堆与唯一性', () => {
  it('一副牌恰好 52 张且互不重复', () => {
    const deck = createDeck();
    assert.equal(deck.length, 52);
    assert.equal(new Set(deck.map(cardKey)).size, 52);
    assert.ok(deckIsUnique(deck));
    assert.ok(deckIsUnique(ALL_CARDS));
  });

  it('每种花色恰好 13 张，每个点数恰好 4 张', () => {
    const deck = createDeck();
    for (const suit of ALL_SUITS) {
      assert.equal(deck.filter((x) => x.suit === suit).length, 13, `花色 ${suit} 应有 13 张`);
    }
    for (let rank = 2; rank <= 14; rank++) {
      assert.equal(deck.filter((x) => x.rank === rank).length, 4, `点数 ${rank} 应有 4 张`);
    }
  });

  it('牌 → 索引 → 牌 是双射且索引落在 0..51', () => {
    const seen = new Set<number>();
    for (const card of createDeck()) {
      const index = cardIndex(card);
      assert.ok(index >= 0 && index <= 51, `索引越界：${index}`);
      seen.add(index);
      assert.deepEqual(indexToCard(index), card);
    }
    assert.equal(seen.size, 52);
  });

  it('索引越界时抛错而不是返回 undefined', () => {
    assert.throws(() => indexToCard(-1), /索引必须在 0..51/);
    assert.throws(() => indexToCard(52), /索引必须在 0..51/);
    assert.throws(() => indexToCard(1.5), /索引必须在 0..51/);
  });
});

describe('牌 —— 构造校验', () => {
  it('合法点数与花色可以构造', () => {
    assert.deepEqual(makeCard(14, 'd'), { rank: 14, suit: 'd' });
    assert.deepEqual(makeCard(2, 'c'), { rank: 2, suit: 'c' });
  });

  it('非法点数抛错', () => {
    assert.throws(() => makeCard(1 as never, 's'), /点数必须是 2\.\.14/);
    assert.throws(() => makeCard(15 as never, 's'), /点数必须是 2\.\.14/);
    assert.throws(() => makeCard(10.5 as never, 's'), /点数必须是 2\.\.14/);
  });

  it('非法花色抛错', () => {
    assert.throws(() => makeCard(10, 'x' as never), /花色必须是 s\/h\/d\/c/);
  });
});

describe('牌 —— 严格解析（牌不会认错）', () => {
  it('标准两字符写法全部可解析', () => {
    const cases: Array<[string, number, string]> = [
      ['As', 14, 's'],
      ['Td', 10, 'd'],
      ['7c', 7, 'c'],
      ['2h', 2, 'h'],
      ['Kd', 13, 'd'],
      ['Qs', 12, 's'],
      ['Jh', 11, 'h'],
      ['9c', 9, 'c'],
    ];
    for (const [input, rank, suit] of cases) {
      const result = parseCard(input);
      assert.ok(result.ok, `${input} 应解析成功`);
      assert.equal(result.card.rank, rank);
      assert.equal(result.card.suit, suit);
    }
  });

  it('大小写不敏感（As / AS / aS 等价）', () => {
    const a = parseCardStrict('As');
    assert.deepEqual(parseCardStrict('AS'), a);
    assert.deepEqual(parseCardStrict('aS'), a);
    assert.deepEqual(parseCardStrict(' as '), a);
  });

  it('「10」必须报错并提示改用 T（不静默纠正）', () => {
    const result = parseCard('10s');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, CardParseCode.TEN_AS_10);
    assert.equal(result.params.input, '10s');
  });

  it('花色在前会被识别为顺序错误', () => {
    const result = parseCard('sA');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, CardParseCode.RANK_SUIT_ORDER);
  });

  it('无法识别的点数 / 花色分别给出精确错误码', () => {
    const badRank = parseCard('Xs');
    assert.equal(badRank.ok, false);
    if (!badRank.ok) assert.equal(badRank.code, CardParseCode.BAD_RANK);

    const badSuit = parseCard('Ax');
    assert.equal(badSuit.ok, false);
    if (!badSuit.ok) assert.equal(badSuit.code, CardParseCode.BAD_SUIT);
  });

  it('长度不正确会被拒绝', () => {
    for (const input of ['A', 'Ass', 'A s', '']) {
      const result = parseCard(input);
      if (input.trim() === '') {
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, CardParseCode.EMPTY);
      } else {
        assert.equal(result.ok, false, `「${input}」应被拒绝`);
      }
    }
  });

  it('非字符串输入被拒绝', () => {
    const result = parseCard(7);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, CardParseCode.NOT_A_STRING);
  });

  it('绝不猜测式纠正：7♦ 永远不会变成 7♣ / 7♥ / 7♠', () => {
    const seven = parseCardStrict('7d');
    assert.equal(seven.suit, 'd');
    assert.equal(seven.rank, 7);
    // 非法输入不会返回任何牌
    for (const bad of ['7 D', '7dd', 'se7en', 'd7', '7-', '≠7d']) {
      assert.equal(parseCard(bad).ok, false, `「${bad}」不应被解析成牌`);
    }
    // 首尾空白被容忍（语音/粘贴场景），但牌本身必须精确
    assert.deepEqual(parseCardStrict(' 7D '), seven);
  });

  it('cardToString 与解析互为逆运算（52 张全覆盖）', () => {
    for (const card of createDeck()) {
      assert.deepEqual(parseCardStrict(cardToString(card)), card);
    }
  });

  it('parseCardsLoose 支持空格 / 逗号 / 紧凑连写', () => {
    const expected = C('As Kd 7c');
    assert.deepEqual(parseCardsLoose('As Kd 7c'), expected);
    assert.deepEqual(parseCardsLoose('As,Kd,7c'), expected);
    assert.deepEqual(parseCardsLoose('AsKd7c'), expected);
    assert.deepEqual(parseCardsLoose('As、Kd，7c'), expected);
  });
});

describe('牌 —— 重复牌检查', () => {
  it('同点数同花色判定为重复', () => {
    const sevenD = c('7d');
    const groups = findDuplicates([
      { card: sevenD, holder: 'BOARD_FLOP' },
      { card: c('7d'), holder: 'OPPONENT_HOLE', playerId: 'co', playerName: '关煞位' },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(cardKey(groups[0]!.card), '7d');
    assert.deepEqual(groups[0]!.playerIds, ['co']);
    assert.equal(groups[0]!.occurrences.length, 2);
  });

  it('同点数不同花色不构成重复', () => {
    const cards: Card[] = [c('7d'), c('7c'), c('7h'), c('7s')];
    assert.equal(hasDuplicates(cards.map((card) => ({ card, holder: 'BOARD_FLOP' as const }))), false);
  });

  it('同一张牌出现 3 次只报一个分组（不产生信息噪音）', () => {
    const groups = findDuplicates([
      { card: c('As'), holder: 'USER_HOLE', playerId: 'btn' },
      { card: c('As'), holder: 'BOARD_FLOP' },
      { card: c('As'), holder: 'OPPONENT_HOLE', playerId: 'bb' },
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]!.playerIds, ['btn', 'bb']);
  });

  it('52 张全上桌不会互相冲突', () => {
    const located = createDeck().map((card) => ({ card, holder: 'BOARD_FLOP' as const }));
    assert.equal(findDuplicates(located).length, 0);
  });

  it('removeUsedCards 精确剔除指定牌', () => {
    const pool = removeUsedCards(createDeck(), C('As Kd 7c'));
    assert.equal(pool.length, 49);
    assert.equal(containsCard(pool, c('As')), false);
    assert.equal(containsCard(pool, c('Ah')), true);
  });
});
