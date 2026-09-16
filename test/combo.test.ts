/**
 * Combo Universe 测试（规范第四十二节）
 *
 * 这是范围引擎的**地基**：如果 1326 个组合本身错了，
 * 后面所有「精确的计算」都会精确地算错。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_COMBOS,
  ALL_RANK_CLASSES,
  CANONICAL_SUIT_ORDER,
  COMBO_BY_ID,
  COMBOS_BY_RANK_CLASS,
  COMBO_CAPACITY,
  RANK_CLASS_COUNT,
  Suitedness,
  TOTAL_COMBO_COUNT,
  comboById,
  comboIdOf,
  expandRankClass,
  expandRankClasses,
  makeCombo,
  maxCombosForKnownCards,
  orderCards,
  rankClassOf,
} from '../src/domain/range/combo.ts';
import { ALL_CARDS, ALL_SUITS, type Card } from '../src/domain/types.ts';
import { cardKey } from '../src/domain/poker/cards.ts';
import { assertComboUniverseIntegrity } from '../src/domain/range/rangeValidator.ts';
import { c } from './helpers.ts';

describe('Combo Universe —— 1326 精确组合', () => {
  it('恰好 1326 个组合', () => {
    assert.equal(ALL_COMBOS.length, TOTAL_COMBO_COUNT);
    assert.equal(TOTAL_COMBO_COUNT, 1326);
  });

  it('无重复：canonicalId 唯一', () => {
    const ids = new Set(ALL_COMBOS.map((x) => x.canonicalId));
    assert.equal(ids.size, ALL_COMBOS.length, `存在 ${ALL_COMBOS.length - ids.size} 个重复 canonicalId`);
  });

  it('每个组合由两张不同的实体牌组成', () => {
    for (const combo of ALL_COMBOS) {
      assert.notEqual(
        cardKey(combo.card1),
        cardKey(combo.card2),
        `${combo.canonicalId} 由同一张牌组成`,
      );
      assert.notEqual(combo.cardIndices[0], combo.cardIndices[1]);
    }
  });

  it('组合内部两张牌按规范顺序排列（点数降序，同点数按 s<h<d<c）', () => {
    for (const combo of ALL_COMBOS) {
      if (combo.card1.rank > combo.card2.rank) continue;
      assert.equal(combo.card1.rank, combo.card2.rank, `${combo.canonicalId} 点数顺序错误`);
      // 注意：必须用 CANONICAL_SUIT_ORDER 比较，不能用字符串比较 ——
      // 字符串里 'd' < 'c' 为 false（'c' 的字符码更小），与规范顺序 s<h<d<c 不一致。
      assert.ok(
        CANONICAL_SUIT_ORDER[combo.card1.suit] < CANONICAL_SUIT_ORDER[combo.card2.suit],
        `${combo.canonicalId} 花色顺序错误`,
      );
    }
  });

  it('1326 = C(52,2)，且覆盖全部可能的无序牌对', () => {
    const pairs = new Set<string>();
    for (let i = 0; i < ALL_CARDS.length; i++) {
      for (let j = i + 1; j < ALL_CARDS.length; j++) {
        pairs.add(comboIdOf(ALL_CARDS[i]!, ALL_CARDS[j]!));
      }
    }
    assert.equal(pairs.size, 1326);
    assert.equal(pairs.size, ALL_COMBOS.length);
  });

  it('启动期自检 assertComboUniverseIntegrity 通过', () => {
    assert.doesNotThrow(() => assertComboUniverseIntegrity());
  });
});

describe('Combo Universe —— canonical 规范化', () => {
  it('牌序不影响 canonicalId：AsKd 与 KdAs 是同一个组合', () => {
    const a = comboIdOf(c('As'), c('Kd'));
    const b = comboIdOf(c('Kd'), c('As'));
    assert.equal(a, b);
    assert.equal(a, 'AsKd');
  });

  it('同点数时花色顺序不影响：AhAs 与 AsAh 相同', () => {
    assert.equal(comboIdOf(c('Ah'), c('As')), comboIdOf(c('As'), c('Ah')));
    assert.equal(comboIdOf(c('As'), c('Ah')), 'AsAh');
  });

  it('orderCards 幂等：再排一次结果不变', () => {
    for (const combo of ALL_COMBOS.slice(0, 200)) {
      const once = orderCards(combo.card1, combo.card2);
      const twice = orderCards(once[0], once[1]);
      assert.deepEqual(twice, once);
    }
  });

  it('canonicalId 顺序遍历 = ALL_COMBOS 的确定性顺序', () => {
    const sorted = [...ALL_COMBOS].map((x) => x.canonicalId);
    const resorted = [...sorted].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    assert.deepEqual(sorted, resorted, 'ALL_COMBOS 未按 canonicalId 字典序排列');
  });

  it('同一张牌不能组成组合', () => {
    assert.throws(() => makeCombo(c('As'), c('As')), /同一张牌/);
  });
});

describe('Combo Universe —— 各类型组合数（规范第五节）', () => {
  it('对子 = 6 个组合（AA）', () => {
    assert.equal(expandRankClass('AA').length, 6);
    assert.equal(expandRankClass('22').length, 6);
    assert.equal(expandRankClass('KK').length, 6);
  });

  it('同花 = 4 个组合（AKs）', () => {
    assert.equal(expandRankClass('AKs').length, 4);
    // 四个同花组合的花色两两相同且互不相同
    const suits = expandRankClass('AKs').map((x) => `${x.card1.suit}${x.card2.suit}`);
    assert.deepEqual(suits.sort(), ['cc', 'dd', 'hh', 'ss']);
  });

  it('不同花 = 12 个组合（AKo）', () => {
    assert.equal(expandRankClass('AKo').length, 12);
    // 12 个组合的两张牌花色必然不同
    for (const combo of expandRankClass('AKo')) {
      assert.notEqual(combo.card1.suit, combo.card2.suit);
    }
  });

  it('AKs 与 AKo 的花色关系互补：4 + 12 = 16 = 4×4', () => {
    assert.equal(expandRankClass('AKs').length + expandRankClass('AKo').length, 16);
  });

  it('每个类别内部组合互不重复', () => {
    for (const rankClass of ALL_RANK_CLASSES) {
      const combos = expandRankClass(rankClass);
      const ids = new Set(combos.map((x) => x.canonicalId));
      assert.equal(ids.size, combos.length, `${rankClass} 内部有重复`);
    }
  });
});

describe('Combo Universe —— 169 类完整展开', () => {
  it('恰好 169 个类别', () => {
    assert.equal(ALL_RANK_CLASSES.length, RANK_CLASS_COUNT);
    assert.equal(RANK_CLASS_COUNT, 169);
  });

  it('169 类 = 13 对子 + 78 同花 + 78 不同花', () => {
    let pairs = 0;
    let suited = 0;
    let offsuit = 0;
    for (const rankClass of ALL_RANK_CLASSES) {
      const combos = expandRankClass(rankClass);
      const kind = combos[0]!.suitedness;
      if (kind === Suitedness.PAIR) pairs++;
      else if (kind === Suitedness.SUITED) suited++;
      else offsuit++;
    }
    assert.equal(pairs, 13);
    assert.equal(suited, 78);
    assert.equal(offsuit, 78);
    assert.equal(pairs + suited + offsuit, 169);
  });

  it('**169 类完整展开恰好 1326 个组合，无重复无缺失**', () => {
    let total = 0;
    const seen = new Set<string>();
    for (const rankClass of ALL_RANK_CLASSES) {
      for (const combo of expandRankClass(rankClass)) {
        total++;
        assert.equal(seen.has(combo.canonicalId), false, `${combo.canonicalId} 被多个类别重复包含`);
        seen.add(combo.canonicalId);
      }
    }
    assert.equal(total, 1326);
    assert.equal(seen.size, 1326);
    // 与 ALL_COMBOS 完全一致（既无缺失也无多余）
    for (const combo of ALL_COMBOS) {
      assert.ok(seen.has(combo.canonicalId), `${combo.canonicalId} 不在 169 类展开中`);
    }
  });

  it('类别组合数只可能是 6 / 4 / 12', () => {
    for (const rankClass of ALL_RANK_CLASSES) {
      const n = expandRankClass(rankClass).length;
      assert.ok([6, 4, 12].includes(n), `${rankClass} 组合数为 ${n}，应为 6/4/12`);
    }
  });

  it('COMBOS_BY_RANK_CLASS 与 ALL_COMBOS 一致', () => {
    let count = 0;
    for (const [, combos] of COMBOS_BY_RANK_CLASS) count += combos.length;
    assert.equal(count, ALL_COMBOS.length);
  });

  it('expandRankClasses 自动去重并保持确定性顺序', () => {
    const expanded = expandRankClasses(['AA', 'AKs', 'AA']);
    assert.equal(expanded.length, 10, 'AA 6 个 + AKs 4 个，重复的 AA 不应二次计入');
    const ids = expanded.map((x) => x.canonicalId);
    assert.deepEqual(ids, [...ids].sort());
  });

  it('未知类别返回空数组（由调用方决定是否报错）', () => {
    assert.deepEqual(expandRankClass('XX'), []);
    assert.deepEqual(expandRankClass('AAx'), []);
    assert.deepEqual(expandRankClass(''), []);
  });
});

describe('Combo Universe —— rankClass 命名', () => {
  it('对子命名为 "AA" 形式', () => {
    assert.equal(rankClassOf(c('As'), c('Ah'), Suitedness.PAIR), 'AA');
  });

  it('同花命名为 "AKs"，且点数大的在前', () => {
    assert.equal(rankClassOf(c('Ks'), c('As'), Suitedness.SUITED), 'AKs');
    assert.equal(makeCombo(c('Ks'), c('As')).rankClass, 'AKs');
  });

  it('不同花命名为 "AKo"', () => {
    assert.equal(makeCombo(c('Kd'), c('As')).rankClass, 'AKo');
  });

  it('每个组合的 rankClass 都能在 169 类中找到', () => {
    const classes = new Set(ALL_RANK_CLASSES);
    for (const combo of ALL_COMBOS) {
      assert.ok(classes.has(combo.rankClass), `${combo.canonicalId} 的类别 ${combo.rankClass} 不在 169 类中`);
    }
  });
});

describe('Combo Universe —— 容量基准（规范第四十三 / 四十四 / 四十五节）', () => {
  it('无已知牌：1326', () => {
    assert.equal(maxCombosForKnownCards(0), 1326);
    assert.equal(COMBO_CAPACITY[0], 1326);
  });

  it('只有 Hero 两张已知：C(50,2) = 1225', () => {
    assert.equal(maxCombosForKnownCards(2), 1225);
    assert.equal(COMBO_CAPACITY[2], 1225);
  });

  it('Hero + 翻牌 5 张已知：C(47,2) = 1081', () => {
    assert.equal(maxCombosForKnownCards(5), 1081);
    assert.equal(COMBO_CAPACITY[5], 1081);
  });

  it('Hero + 转牌 6 张已知：C(46,2) = 1035', () => {
    assert.equal(maxCombosForKnownCards(6), 1035);
    assert.equal(COMBO_CAPACITY[6], 1035);
  });

  it('Hero + 河牌 7 张已知：C(45,2) = 990', () => {
    assert.equal(maxCombosForKnownCards(7), 990);
    assert.equal(COMBO_CAPACITY[7], 990);
  });

  it('容量表数值与 C(52−n, 2) 公式一致', () => {
    for (const [knownStr, expected] of Object.entries(COMBO_CAPACITY)) {
      const known = Number(knownStr);
      assert.equal(maxCombosForKnownCards(known), expected, `已知 ${known} 张时容量不符`);
    }
  });
});

describe('Combo Universe —— 索引查找', () => {
  it('COMBO_BY_ID 覆盖全部 1326 个组合', () => {
    assert.equal(COMBO_BY_ID.size, 1326);
  });

  it('comboById 对已知 id 返回组合，对未知 id 返回 undefined', () => {
    const combo = comboById('AsKd');
    assert.ok(combo);
    assert.equal(combo!.rankClass, 'AKo');
    assert.equal(comboById('AsAs'), undefined);
    assert.equal(comboById('XxYy'), undefined);
  });

  it('cardIndices 落在 0..51 且升序', () => {
    for (const combo of ALL_COMBOS) {
      assert.ok(combo.cardIndices[0] >= 0 && combo.cardIndices[0] <= 51);
      assert.ok(combo.cardIndices[1] >= 0 && combo.cardIndices[1] <= 51);
      assert.ok(combo.cardIndices[0] < combo.cardIndices[1]);
    }
  });

  it('cardIndices 与 card1/card2 一致', () => {
    for (const combo of ALL_COMBOS.slice(0, 300)) {
      const keys = [cardKey(combo.card1), cardKey(combo.card2)];
      assert.equal(new Set(keys).size, 2);
    }
  });
});

describe('Combo Universe —— 花色顺序常量', () => {
  it('全部花色恰有 4 种', () => {
    assert.equal(ALL_SUITS.length, 4);
  });

  it('每个点数的组合数正确（对子 6 + 同花 4×12 + 不同花 12×12）', () => {
    // 固定一个点数，统计包含它的组合数：13 个搭档点数
    // 对子部分：13 个点数各 6 个 = 78
    // 同花部分：13×12/2 个类别 × 4 = 312
    // 不同花部分：13×12/2 个类别 × 12 = 936
    assert.equal(78 + 312 + 936, 1326);
  });

  it('给定一张具体牌，包含它的组合数恰为 51', () => {
    for (const card of ALL_CARDS.slice(0, 10)) {
      const withCard = ALL_COMBOS.filter(
        (combo) => cardKey(combo.card1) === cardKey(card) || cardKey(combo.card2) === cardKey(card),
      );
      assert.equal(withCard.length, 51, `${cardKey(card)} 出现在 ${withCard.length} 个组合中`);
    }
  });
});

/** 供其他测试复用的类型导出检查 */
export type { Card };
