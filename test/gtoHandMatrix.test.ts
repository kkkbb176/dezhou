/**
 * 169 类起手牌矩阵测试
 *
 * ## 这份测试防的是什么
 *
 * 「169 类」听起来简单，实际有**三种顺序**同时在用（显示顺序 / 求解器类号 /
 * 文本标签），混淆它们会产生一类极难发现的错误：**AKs 与 AKo 互换**、
 * **同花与不同花互换**，而所有名字看上去都还是对的。
 *
 * 因此这里既测「数量对」，也测**具体锚点的类号**
 *（用 GTOpen 源码 `class_index()` 逐位算出来的值）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GTO_HAND_CLASSES,
  GTO_HAND_CLASSES_BY_CLASS_INDEX,
  GTO_MATRIX_AXIS,
  TOTAL_COMBOS,
  classIndexToDisplayIndex,
  classIndexOfCode,
  displayIndexToClassIndex,
  displayRankToSolverRank,
  formatFrequencyPercent,
  gtoHandMatrix,
  handClassByCode,
  isFrequency01,
  selfCheckHandMatrix,
  solverClassIndexOf,
  solverClassParts,
} from '../src/domain/gto/gtopenHandMatrix.ts';

/* ============================================================
 * 数量与唯一性
 * ============================================================ */

test('GTO-169-01：恰好 169 类手牌，标签与类号都是双射', () => {
  assert.equal(GTO_HAND_CLASSES.length, 169);
  assert.equal(new Set(GTO_HAND_CLASSES.map((h) => h.code)).size, 169);
  assert.equal(new Set(GTO_HAND_CLASSES.map((h) => h.classIndex)).size, 169);
  // 类号必须恰好覆盖 0..168
  const sorted = GTO_HAND_CLASSES.map((h) => h.classIndex).sort((a, b) => a - b);
  assert.deepEqual(sorted, Array.from({ length: 169 }, (_, i) => i));
});

test('GTO-169-02：对子 13 / 同花 78 / 不同花 78，组合总数 1326', () => {
  assert.equal(GTO_HAND_CLASSES.filter((h) => h.kind === 'PAIR').length, 13);
  assert.equal(GTO_HAND_CLASSES.filter((h) => h.kind === 'SUITED').length, 78);
  assert.equal(GTO_HAND_CLASSES.filter((h) => h.kind === 'OFFSUIT').length, 78);
  assert.equal(
    GTO_HAND_CLASSES.reduce((sum, h) => sum + h.combos, 0),
    TOTAL_COMBOS,
  );
  // 对子 6 / 同花 4 / 不同花 12
  assert.equal(handClassByCode('AA')?.combos, 6);
  assert.equal(handClassByCode('AKs')?.combos, 4);
  assert.equal(handClassByCode('AKo')?.combos, 12);
});

/* ============================================================
 * 🔴 同花 / 不同花不得互换
 * ============================================================ */

test('GTO-169-03：AKs 与 AKo 是两个不同的类，且一个是同花一个不是', () => {
  const aks = handClassByCode('AKs');
  const ako = handClassByCode('AKo');
  assert.ok(aks !== null && ako !== null);
  assert.notEqual(aks.classIndex, ako.classIndex);
  assert.equal(aks.kind, 'SUITED');
  assert.equal(ako.kind, 'OFFSUIT');
  assert.equal(aks.combos, 4);
  assert.equal(ako.combos, 12);
});

test('GTO-169-04：A5s/A5o 与 QJs/QJo 同样不得互换（逐一验证，不只看 AK）', () => {
  for (const [suited, offsuit] of [
    ['A5s', 'A5o'],
    ['QJs', 'QJo'],
    ['KQs', 'KQo'],
    ['32s', '32o'],
    ['T9s', 'T9o'],
  ] as const) {
    const s = handClassByCode(suited);
    const o = handClassByCode(offsuit);
    assert.ok(s !== null, `${suited} 必须存在`);
    assert.ok(o !== null, `${offsuit} 必须存在`);
    assert.equal(s.kind, 'SUITED', `${suited} 必须是同花`);
    assert.equal(o.kind, 'OFFSUIT', `${offsuit} 必须是不同花`);
    assert.notEqual(s.classIndex, o.classIndex, `${suited} 与 ${offsuit} 不得同类`);
  }
});

test('GTO-169-05：显示矩阵的行列含义正确（行号小 = 高牌；右上 = 同花，左下 = 不同花）', () => {
  const matrix = gtoHandMatrix();
  assert.equal(matrix.length, 13);
  assert.equal(matrix[0].length, 13);
  assert.equal(matrix[0][0].code, 'AA');
  assert.equal(matrix[12][12].code, '22');
  // 第一行：AA AKs AQs ... A2s
  assert.equal(matrix[0][1].code, 'AKs');
  assert.equal(matrix[0][12].code, 'A2s');
  // 第一列：AA AKo AQo ... A2o
  assert.equal(matrix[1][0].code, 'AKo');
  assert.equal(matrix[12][0].code, 'A2o');
  // 对子都在对角线上
  for (let i = 0; i < 13; i++) {
    assert.equal(matrix[i][i].kind, 'PAIR');
  }
  // 右上全是同花，左下全是不同花
  for (let r = 0; r < 13; r++) {
    for (let c = 0; c < 13; c++) {
      if (r < c) assert.equal(matrix[r][c].kind, 'SUITED');
      if (r > c) assert.equal(matrix[r][c].kind, 'OFFSUIT');
    }
  }
});

test('GTO-169-06：矩阵轴是从 A 到 2（与求解器的 2→A 相反，因此必须显式声明）', () => {
  assert.deepEqual([...GTO_MATRIX_AXIS], ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2']);
  // 显示轴 0 = A → 求解器下标 12
  assert.equal(displayRankToSolverRank(0), 12);
  assert.equal(displayRankToSolverRank(12), 0);
});

/* ============================================================
 * 🔴 类号锚点（与 GTOpen 源码 class_index() 逐位对照）
 * ============================================================ */

test('GTO-169-07：类号锚点与 GTOpen 源码一致（AA=168、22=0、AKs=167、AKo=155）', () => {
  // 这些数字**反直觉**：求解器的点数下标是 0=2 … 12=A，
  // 因此类号越大反而牌力越强（这是巧合，代码不得依赖它）
  assert.equal(classIndexOfCode('AA'), 168);
  assert.equal(classIndexOfCode('22'), 0);
  assert.equal(classIndexOfCode('AKs'), 167);
  assert.equal(classIndexOfCode('AKo'), 155);
  assert.equal(classIndexOfCode('A5s'), 159);
  assert.equal(classIndexOfCode('A5o'), 51);
  assert.equal(classIndexOfCode('32s'), 13);
  assert.equal(classIndexOfCode('32o'), 1);
  assert.equal(classIndexOfCode('72o'), 5);
});

test('GTO-169-08：solverClassIndexOf 与 solverClassParts 互为逆运算（169 项逐一验证）', () => {
  for (let classIndex = 0; classIndex < 169; classIndex++) {
    const parts = solverClassParts(classIndex);
    const recomputed = solverClassIndexOf(parts.a, parts.b, parts.suited);
    assert.equal(recomputed, classIndex, `类号 ${classIndex} 往返失败`);
  }
});

test('GTO-169-09：显示序号与类号在两个方向上互为逆运算（169 项 × 2）', () => {
  for (let i = 0; i < 169; i++) {
    assert.equal(displayIndexToClassIndex(classIndexToDisplayIndex(i)), i);
    assert.equal(classIndexToDisplayIndex(displayIndexToClassIndex(i)), i);
  }
  // 不得出现未初始化的 -1
  for (let i = 0; i < 169; i++) {
    assert.notEqual(classIndexToDisplayIndex(i), -1);
    assert.notEqual(displayIndexToClassIndex(i), -1);
  }
});

test('GTO-169-10：按类号索引的表与按显示顺序的表描述同一批手牌', () => {
  for (const hand of GTO_HAND_CLASSES) {
    const byClass = GTO_HAND_CLASSES_BY_CLASS_INDEX[hand.classIndex];
    assert.equal(byClass.code, hand.code);
    assert.equal(byClass.displayIndex, hand.displayIndex);
  }
  // 显示序号必须恰好覆盖 0..168
  assert.deepEqual(
    GTO_HAND_CLASSES.map((h) => h.displayIndex).sort((a, b) => a - b),
    Array.from({ length: 169 }, (_, i) => i),
  );
});

/* ============================================================
 * 频率单位（0..1 与 0..100 混淆）
 * ============================================================ */

test('GTO-169-11：isFrequency01 拒绝百分数（65 不是合法频率，0.65 才是）', () => {
  assert.equal(isFrequency01(0), true);
  assert.equal(isFrequency01(0.65), true);
  assert.equal(isFrequency01(1), true);
  assert.equal(isFrequency01(1.0000001), false);
  assert.equal(isFrequency01(65), false);
  assert.equal(isFrequency01(-0.01), false);
  assert.equal(isFrequency01(Number.NaN), false);
  assert.equal(isFrequency01(Number.POSITIVE_INFINITY), false);
  assert.equal(isFrequency01('0.5'), false);
  assert.equal(isFrequency01(null), false);
});

test('GTO-169-12：格式化百分比只有一处 ×100（0.6532 → 65.3%）', () => {
  assert.equal(formatFrequencyPercent(0.6532), '65.3%');
  assert.equal(formatFrequencyPercent(0.6532, 0), '65%');
  assert.equal(formatFrequencyPercent(1), '100.0%');
  assert.equal(formatFrequencyPercent(0), '0.0%');
  // 🔴 墨菲定律：0.65 不得显示成 0.65%，65 也不得显示成 6500%
  assert.notEqual(formatFrequencyPercent(0.65), '0.65%');
  assert.equal(formatFrequencyPercent(0.65), '65.0%');
  assert.equal(formatFrequencyPercent(Number.NaN), '—');
});

/* ============================================================
 * 自检
 * ============================================================ */

test('GTO-169-13：矩阵自检必须通过（并且真的会抓到错误）', () => {
  assert.deepEqual(selfCheckHandMatrix(), []);
  // 自检不得只依赖数组首尾（历史缺陷 F-02 的同族问题）
  const source = selfCheckHandMatrix.toString();
  assert.ok(!/KEYS\[0\]/.test(source), '自检不得用 KEYS[0] 当「最好」');
});
