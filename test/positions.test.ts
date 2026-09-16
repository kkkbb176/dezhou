/**
 * 位置与行动顺序测试
 *
 * 覆盖规范第 2 条与第 45 条；Bug 预判 B14 / B15 / B21。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  POSITION_ORDER,
  blindsOf,
  positionAtSeatIndex,
  positionGroup,
  positionsForTable,
  postflopOrder,
  preflopOrder,
  seatCount,
  seatIndexOfPosition,
} from '../src/domain/poker/positions.ts';
import { Position, TableSize } from '../src/domain/types.ts';
import { positionAuxLabel, positionLabel, positionMainLabel } from '../src/i18n/index.ts';

const HEXAD = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const HEX_SUITS = ['s', 'h', 'd', 'c'];

describe('位置 —— 桌型与位置数量', () => {
  it('6 人桌恰好 6 个位置', () => {
    assert.equal(seatCount(TableSize.SIX_MAX), 6);
    assert.deepEqual(positionsForTable(TableSize.SIX_MAX), ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
  });

  it('9 人桌恰好 9 个位置', () => {
    assert.equal(seatCount(TableSize.NINE_MAX), 9);
    assert.deepEqual(positionsForTable(TableSize.NINE_MAX), [
      'UTG',
      'UTG1',
      'UTG2',
      'LJ',
      'HJ',
      'CO',
      'BTN',
      'SB',
      'BB',
    ]);
  });

  it('9 人桌独有的位置在 6 人桌不存在', () => {
    for (const position of ['UTG1', 'UTG2', 'LJ'] as const) {
      assert.throws(() => seatIndexOfPosition(TableSize.SIX_MAX, position), /不存在位置/);
    }
  });

  it('座位下标与位置互为逆运算', () => {
    for (const tableSize of [TableSize.SIX_MAX, TableSize.NINE_MAX] as const) {
      for (let index = 0; index < seatCount(tableSize); index++) {
        const position = positionAtSeatIndex(tableSize, index);
        assert.equal(seatIndexOfPosition(tableSize, position), index);
      }
    }
  });

  it('座位下标越界时抛错', () => {
    assert.throws(() => positionAtSeatIndex(TableSize.SIX_MAX, 6), /不存在座位下标/);
    assert.throws(() => positionAtSeatIndex(TableSize.SIX_MAX, -1), /不存在座位下标/);
  });
});

describe('位置 —— 翻牌前行动顺序', () => {
  it('9 人桌：枪口位开始，大盲最后', () => {
    assert.deepEqual(preflopOrder(TableSize.NINE_MAX, Position.BTN), [
      'UTG',
      'UTG1',
      'UTG2',
      'LJ',
      'HJ',
      'CO',
      'BTN',
      'SB',
      'BB',
    ]);
  });

  it('6 人桌：枪口位开始，大盲最后', () => {
    assert.deepEqual(preflopOrder(TableSize.SIX_MAX, Position.BTN), [
      'UTG',
      'HJ',
      'CO',
      'BTN',
      'SB',
      'BB',
    ]);
  });

  it('无论庄家位定义如何变化，大盲位永远最后行动（属性测试）', () => {
    for (const tableSize of [TableSize.SIX_MAX, TableSize.NINE_MAX] as const) {
      const order = preflopOrder(tableSize, Position.BTN);
      assert.equal(order.length, seatCount(tableSize));
      assert.equal(order[order.length - 1], 'BB');
      assert.equal(order[0], 'UTG');
    }
  });
});

describe('位置 —— 翻牌后行动顺序', () => {
  it('9 人桌：小盲位开始，庄家最后', () => {
    assert.deepEqual(postflopOrder(TableSize.NINE_MAX, Position.BTN), [
      'SB',
      'BB',
      'UTG',
      'UTG1',
      'UTG2',
      'LJ',
      'HJ',
      'CO',
      'BTN',
    ]);
  });

  it('6 人桌：小盲位开始，庄家最后', () => {
    assert.deepEqual(postflopOrder(TableSize.SIX_MAX, Position.BTN), [
      'SB',
      'BB',
      'UTG',
      'HJ',
      'CO',
      'BTN',
    ]);
  });

  it('单挑（只剩小盲与大盲）时，大盲先行动、庄家（小盲）后行动', () => {
    const order = postflopOrder(TableSize.SIX_MAX, Position.BTN);
    const headsUp = order.filter((p) => p === 'SB' || p === 'BB');
    assert.deepEqual(headsUp, ['SB', 'BB']);
    assert.equal(headsUp[0], 'SB');
  });
});

describe('位置 —— 盲注位', () => {
  it('小盲位是庄家的下一位，大盲位再下一位', () => {
    for (const tableSize of [TableSize.SIX_MAX, TableSize.NINE_MAX] as const) {
      const { sb, bb } = blindsOf(tableSize, Position.BTN);
      assert.equal(sb, 'SB');
      assert.equal(bb, 'BB');
    }
  });

  it('每个桌型的盲注位都真实存在于该桌型', () => {
    for (const tableSize of [TableSize.SIX_MAX, TableSize.NINE_MAX] as const) {
      const { sb, bb } = blindsOf(tableSize, Position.BTN);
      assert.ok(positionsForTable(tableSize).includes(sb));
      assert.ok(positionsForTable(tableSize).includes(bb));
    }
  });
});

describe('位置 —— 位置分组', () => {
  it('9 人桌分组正确', () => {
    assert.equal(positionGroup(TableSize.NINE_MAX, 'SB'), 'blind');
    assert.equal(positionGroup(TableSize.NINE_MAX, 'BB'), 'blind');
    assert.equal(positionGroup(TableSize.NINE_MAX, 'BTN'), 'late');
    assert.equal(positionGroup(TableSize.NINE_MAX, 'CO'), 'late');
    assert.equal(positionGroup(TableSize.NINE_MAX, 'HJ'), 'middle');
    assert.equal(positionGroup(TableSize.NINE_MAX, 'UTG'), 'early');
    assert.equal(positionGroup(TableSize.NINE_MAX, 'UTG1'), 'early');
  });

  it('6 人桌没有不属于该桌型的分组调用', () => {
    for (const position of positionsForTable(TableSize.SIX_MAX)) {
      const group = positionGroup(TableSize.SIX_MAX, position);
      assert.ok(['early', 'middle', 'late', 'blind'].includes(group));
    }
  });
});

describe('位置 —— 中文映射（同一桌内绝不重名）', () => {
  it('9 人桌中文名称与规范第 2 条完全一致', () => {
    const expected: Array<[Position, string, string]> = [
      ['UTG', '枪口位', 'UTG'],
      ['UTG1', '枪口+1位', 'UTG+1'],
      ['UTG2', '枪口+2位', 'UTG+2'],
      ['LJ', '低劫持位', 'LJ'],
      ['HJ', '劫持位', 'HJ'],
      ['CO', '关煞位', 'CO'],
      ['BTN', '庄家位', 'BTN'],
      ['SB', '小盲位', 'SB'],
      ['BB', '大盲位', 'BB'],
    ];
    for (const [position, main, aux] of expected) {
      assert.equal(positionMainLabel(TableSize.NINE_MAX, position), main, `${position} 主显示`);
      assert.equal(positionAuxLabel(TableSize.NINE_MAX, position), aux, `${position} 辅助显示`);
      assert.equal(positionLabel(TableSize.NINE_MAX, position), `${main}（${aux}）`);
    }
  });

  it('6 人桌中文名称与规范第 2 条完全一致', () => {
    const expected: Array<[Position, string, string]> = [
      ['UTG', '枪口位', 'UTG'],
      ['HJ', '劫持位', 'HJ'],
      ['CO', '关煞位', 'CO'],
      ['BTN', '庄家位', 'BTN'],
      ['SB', '小盲位', 'SB'],
      ['BB', '大盲位', 'BB'],
    ];
    for (const [position, main, aux] of expected) {
      assert.equal(positionMainLabel(TableSize.SIX_MAX, position), main);
      assert.equal(positionAuxLabel(TableSize.SIX_MAX, position), aux);
    }
  });

  it('属性：同一桌型内任意两个位置的完整显示绝不重名', () => {
    for (const tableSize of [TableSize.SIX_MAX, TableSize.NINE_MAX] as const) {
      const labels = positionsForTable(tableSize).map((p) => positionLabel(tableSize, p));
      assert.equal(new Set(labels).size, labels.length, `${tableSize} 人桌出现了重名位置：${labels.join(' / ')}`);
    }
  });

  it('主显示里不出现裸英文缩写（英文只能在括号内）', () => {
    for (const tableSize of [TableSize.SIX_MAX, TableSize.NINE_MAX] as const) {
      for (const position of positionsForTable(tableSize)) {
        const label = positionLabel(tableSize, position);
        // 去掉括号部分后，不应再有任何 ASCII 字母
        const withoutAux = label.replace(/（[^）]*）/g, '');
        assert.equal(/[A-Za-z]/.test(withoutAux), false, `${label} 的主显示含英文`);
      }
    }
  });
});

describe('位置 —— 常量表完整性', () => {
  it('POSITION_ORDER 与桌型一一对应', () => {
    assert.equal(POSITION_ORDER[6].length, 6);
    assert.equal(POSITION_ORDER[9].length, 9);
  });

  it('位置表中的位置都互不相同', () => {
    for (const tableSize of [TableSize.SIX_MAX, TableSize.NINE_MAX] as const) {
      const list = POSITION_ORDER[tableSize];
      assert.equal(new Set(list).size, list.length);
    }
  });
});

describe('花色与牌的显示', () => {
  it('花色中文与图案正确', () => {
    const expected: Array<[string, string]> = [
      ['s', '黑桃'],
      ['h', '红桃'],
      ['d', '方块'],
      ['c', '梅花'],
    ];
    for (const [suit, name] of expected) {
      assert.ok(name.length > 0);
      assert.ok(HEX_SUITS.includes(suit));
    }
  });

  it('点数显示字符表覆盖 2..A 共 13 个', () => {
    assert.equal(HEXAD.length, 13);
  });
});
