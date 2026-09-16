/**
 * 位置定义一致性测试
 *
 * 「桌型 → 位置集合」在 types.ts 与 positions.ts 各有一份定义：
 * - types.ts 提供零依赖的权威数据（供 i18n 与领域层共用）
 * - positions.ts 提供座位几何与行动顺序推导
 *
 * 两份定义必须完全一致，否则会出现「界面显示的顺序」与「引擎实际执行的顺序」
 * 不一致的隐蔽 Bug。本测试把这条约束固化下来。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TableSize, positionsForTableOf } from '../src/domain/types.ts';
import { POSITION_ORDER, positionsForTable, seatCount } from '../src/domain/poker/positions.ts';
import { positionMainLabel } from '../src/i18n/index.ts';

describe('位置定义 —— 两份定义必须一致', () => {
  it('6 人桌：types.ts 与 positions.ts 的顺序完全相同', () => {
    assert.deepEqual(positionsForTableOf(TableSize.SIX_MAX), positionsForTable(TableSize.SIX_MAX));
    assert.deepEqual(positionsForTableOf(TableSize.SIX_MAX), POSITION_ORDER[6]);
  });

  it('9 人桌：types.ts 与 positions.ts 的顺序完全相同', () => {
    assert.deepEqual(positionsForTableOf(TableSize.NINE_MAX), positionsForTable(TableSize.NINE_MAX));
    assert.deepEqual(positionsForTableOf(TableSize.NINE_MAX), POSITION_ORDER[9]);
  });

  it('位置数量与桌型匹配', () => {
    assert.equal(positionsForTableOf(TableSize.SIX_MAX).length, 6);
    assert.equal(positionsForTableOf(TableSize.NINE_MAX).length, 9);
    assert.equal(seatCount(TableSize.SIX_MAX), 6);
    assert.equal(seatCount(TableSize.NINE_MAX), 9);
  });

  it('同一桌型内位置不重复，且中文名称不重复', () => {
    for (const tableSize of [TableSize.SIX_MAX, TableSize.NINE_MAX] as const) {
      const positions = positionsForTableOf(tableSize);
      assert.equal(new Set(positions).size, positions.length);
      const labels = positions.map((p) => positionMainLabel(tableSize, p));
      assert.equal(new Set(labels).size, labels.length, `${tableSize} 人桌中文位置重名`);
    }
  });
});
