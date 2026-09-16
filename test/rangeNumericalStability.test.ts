/**
 * 数值稳定性测试（Step 5A.1，规范第六 / 七 / 八节）
 *
 * 目标：证明「合法的极小组合不会因为浮点问题静默消失」。
 *
 * 本文件同时固化了 Step 5A.1 发现的 **P1 缺陷**：
 * 旧版 `normalizeWeights` 用绝对阈值 `EPSILON = 1e-9` 判断坍塌，
 * 于是「所有似然都是 1e-12」这种完全合法的输入被判成 `RANGE_COLLAPSE`，
 * 且破坏尺度不变性（整体乘 1e-6 会让结果从正常变成坍塌）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DENORMAL_MIN,
  LOG_ZERO,
  fromLogWeight,
  isLogWeightValid,
  isStableNormalized,
  logSumExp,
  multiplyLogWeights,
  normalizeLogWeights,
  stableNormalize,
  toLogWeight,
} from '../src/domain/range/rangeLogSpace.ts';
import {
  RangeErrorCode,
  UNBOUNDED_CLOCK,
  type Range,
  type RangeUpdateContext,
} from '../src/domain/range/range.types.ts';
import { buildRangeFromRankClasses, probabilityByRankClass } from '../src/domain/range/range.ts';
import { makeActionModel, updateRange } from '../src/domain/range/rangeUpdate.ts';
import { testOnlyProvenance } from '../src/domain/range/rangeProvenance.ts';
import { validateRange } from '../src/domain/range/rangeValidator.ts';

const PROV = testOnlyProvenance('numstab.test', '数值稳定性测试');
const CONTEXT: RangeUpdateContext = {
  street: 'FLOP',
  action: 'BET',
  actor: 'BTN',
  actionIndex: 1,
  activePlayerCount: 2,
};

function build(weights: Record<string, number> = { AA: 1, KK: 1, QQ: 1, JJ: 1, TT: 1, AKs: 1, '72o': 1 }): Range {
  const result = buildRangeFromRankClasses(weights, { provenance: PROV, rangeIdPrefix: 'ns' });
  assert.equal(result.ok, true, `构建失败：${result.ok ? '' : JSON.stringify(result)}`);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

/* ============================================================
 * Log-Sum-Exp
 * ============================================================ */

describe('数值稳定性 —— Log-Sum-Exp', () => {
  it('基本正确性：log(Σe^x) = log(n)（等值输入）', () => {
    const lse = logSumExp([0, 0, 0, 0]);
    assert.ok(Math.abs(lse - Math.log(4)) < 1e-12, `实际 ${lse}`);
  });

  it('**极大值不溢出**：logSumExp([1000, 1000]) = 1000 + log 2', () => {
    const lse = logSumExp([1000, 1000]);
    assert.ok(Number.isFinite(lse), '溢出成了 Infinity');
    assert.ok(Math.abs(lse - (1000 + Math.log(2))) < 1e-9);
  });

  it('**极小值不丢失相对关系**：logSumExp([-1000, -999]) ≈ -999 + log(1+e^-1)', () => {
    const lse = logSumExp([-1000, -999]);
    const expected = -999 + Math.log(1 + Math.exp(-1));
    assert.ok(Math.abs(lse - expected) < 1e-9, `实际 ${lse}，期望 ${expected}`);
  });

  it('全为 -Infinity 返回 -Infinity（而不是 NaN）', () => {
    assert.equal(logSumExp([LOG_ZERO, LOG_ZERO]), LOG_ZERO);
  });

  it('含 +Infinity 返回 +Infinity', () => {
    assert.equal(logSumExp([LOG_ZERO, Number.POSITIVE_INFINITY]), Number.POSITIVE_INFINITY);
  });

  it('含 NaN 返回 NaN（不静默吞掉）', () => {
    assert.ok(Number.isNaN(logSumExp([0, Number.NaN])));
  });

  it('空数组返回 -Infinity', () => {
    assert.equal(logSumExp([]), LOG_ZERO);
  });

  it('**跨越 300 个数量级仍然稳定**', () => {
    const lse = logSumExp([700, -700, 0]);
    assert.ok(Number.isFinite(lse));
    assert.ok(Math.abs(lse - 700) < 1e-9, `大项应主导：${lse}`);
  });
});

/* ============================================================
 * 对数域工具
 * ============================================================ */

describe('数值稳定性 —— 对数域工具', () => {
  it('toLogWeight / fromLogWeight 互逆（正值）', () => {
    for (const w of [1, 0.5, 1e-12, 1e-300, 1e300]) {
      const round = fromLogWeight(toLogWeight(w));
      assert.ok(Math.abs(round - w) / w < 1e-12, `${w} → ${round}`);
    }
  });

  it('toLogWeight(0) 与负值都映射到 -Infinity（对数域的 0）', () => {
    assert.equal(toLogWeight(0), LOG_ZERO);
    assert.equal(toLogWeight(-1), LOG_ZERO);
    assert.equal(toLogWeight(Number.NaN), LOG_ZERO);
  });

  it('multiplyLogWeights 就是加法（连乘即相加）', () => {
    const product = multiplyLogWeights(toLogWeight(1e-200), toLogWeight(1e-200), toLogWeight(1e-200));
    // 1e-600 在双精度下溢出为 0，但对数域仍可表示
    assert.ok(Number.isFinite(product), '对数域不应溢出');
    assert.ok(Math.abs(product - 3 * Math.log(1e-200)) < 1e-9);
    // 线性域确实会变成 0 —— 这就是必须用对数域的原因
    assert.equal(1e-200 * 1e-200 * 1e-200, 0);
  });

  it('multiplyLogWeights 遇到 -Infinity（权重 0）返回 -Infinity', () => {
    assert.equal(multiplyLogWeights(toLogWeight(0.5), toLogWeight(0)), LOG_ZERO);
  });

  it('isLogWeightValid 拒绝 NaN 与 +Infinity', () => {
    assert.equal(isLogWeightValid(0), true);
    assert.equal(isLogWeightValid(LOG_ZERO), true);
    assert.equal(isLogWeightValid(Number.NaN), false);
    assert.equal(isLogWeightValid(Number.POSITIVE_INFINITY), false);
  });

  it('DENORMAL_MIN 是双精度最小正数', () => {
    assert.equal(DENORMAL_MIN, Number.MIN_VALUE);
    assert.ok(DENORMAL_MIN > 0);
    assert.equal(DENORMAL_MIN / 2, 0, '再小一半就会下溢为 0');
  });
});

/* ============================================================
 * 稳定归一化 + 尺度不变性（P1 回归）
 * ============================================================ */

describe('数值稳定性 —— 稳定归一化（P1 回归）', () => {
  it('**合法的极小权重不再被判成坍塌**（旧版在这里报 RANGE_COLLAPSE）', () => {
    // 旧版：Σ = 3e-12 < EPSILON(1e-9) → 误报坍塌
    const result = stableNormalize([
      { comboId: 'a', rawWeight: 1e-12 },
      { comboId: 'b', rawWeight: 1e-12 },
      { comboId: 'c', rawWeight: 1e-12 },
    ]);
    assert.equal(result.ok, true, `合法的极小权重被判成 ${result.ok ? '' : result.code}`);
    if (!result.ok) return;
    assert.equal(result.value.supportSize, 3);
    for (const p of result.value.probabilities) {
      assert.ok(Math.abs(p - 1 / 3) < 1e-12);
    }
  });

  it('**尺度不变性**：整体乘任意正数不改变概率', () => {
    const base = [
      { comboId: 'a', rawWeight: 1 },
      { comboId: 'b', rawWeight: 1 },
      { comboId: 'c', rawWeight: 0.5 },
    ];
    const reference = stableNormalize(base);
    assert.equal(reference.ok, true);
    if (!reference.ok) return;

    for (const scale of [1e-300, 1e-12, 1e-6, 1, 1e6, 1e12, 1e300]) {
      const scaled = base.map((x) => ({ ...x, rawWeight: x.rawWeight * scale }));
      const result = stableNormalize(scaled);
      assert.equal(result.ok, true, `缩放 ${scale} 后失败`);
      if (!result.ok) continue;
      for (let i = 0; i < reference.value.probabilities.length; i++) {
        assert.ok(
          Math.abs(result.value.probabilities[i]! - reference.value.probabilities[i]!) < 1e-12,
          `缩放 ${scale} 改变了概率：${result.value.probabilities[i]} vs ${reference.value.probabilities[i]}`,
        );
      }
    }
  });

  it('极小与极大混合时保留相对关系', () => {
    const result = stableNormalize([
      { comboId: 'big', rawWeight: 1 },
      { comboId: 'small', rawWeight: 1e-300 },
      { comboId: 'zero', rawWeight: 0 },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.supportSize, 2, 'zero 不计入支持集，small 必须保留');
    assert.ok(result.value.probabilities[0]! > 0.999);
    assert.ok(result.value.probabilities[1]! > 0, 'small 的概率必须 > 0，不能被下溢吃掉');
    assert.equal(result.value.probabilities[2], 0);
  });

  it('真正的全零仍然报 RANGE_COLLAPSE', () => {
    const result = stableNormalize([
      { comboId: 'a', rawWeight: 0 },
      { comboId: 'b', rawWeight: 0 },
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, RangeErrorCode.RANGE_COLLAPSE);
  });

  it('负权重 / NaN / Infinity 仍然被拒绝（不因稳定化而放松）', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = stableNormalize([
        { comboId: 'a', rawWeight: 1 },
        { comboId: 'b', rawWeight: bad },
      ]);
      assert.equal(result.ok, false, `${bad} 应被拒绝`);
    }
  });

  it('空输入报 RANGE_COLLAPSE', () => {
    const result = stableNormalize([]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, RangeErrorCode.RANGE_COLLAPSE);
  });

  it('归一化后总和恒为 1（各种极端组合，属性测试）', () => {
    const cases: number[][] = [
      [1],
      [1, 1],
      [1e-300, 1e-300],
      [1e300, 1e300],
      [1e300, 1e-300],
      [1, 1e-15, 1e-300, 0],
      [0.1, 0.2, 0.3, 0.4],
    ];
    for (const weights of cases) {
      const result = stableNormalize(weights.map((w, i) => ({ comboId: `c${i}`, rawWeight: w })));
      assert.equal(result.ok, true, `[${weights}] 失败`);
      if (!result.ok) continue;
      assert.ok(
        isStableNormalized(result.value.probabilitySum),
        `[${weights}] Σp = ${result.value.probabilitySum}`,
      );
    }
  });
});

/* ============================================================
 * 对数域归一化
 * ============================================================ */

describe('数值稳定性 —— 对数域归一化', () => {
  it('与线性域结果一致（常规取值）', () => {
    const weights = [1, 0.5, 0.25, 0.125];
    const linear = stableNormalize(weights.map((w, i) => ({ comboId: `c${i}`, rawWeight: w })));
    const log = normalizeLogWeights(weights.map((w, i) => ({ comboId: `c${i}`, logWeight: Math.log(w) })));
    assert.equal(linear.ok && log.ok, true);
    if (!linear.ok || !log.ok) return;
    for (let i = 0; i < weights.length; i++) {
      assert.ok(Math.abs(linear.value.probabilities[i]! - log.value.probabilities[i]!) < 1e-12);
    }
  });

  it('**连乘 1000 次后仍然可归一化**（线性域早已下溢为 0）', () => {
    const logWeights = [
      multiplyLogWeights(...new Array(1000).fill(Math.log(1e-3))),
      multiplyLogWeights(...new Array(1000).fill(Math.log(2e-3))),
    ];
    // 线性域：1e-3000 = 0
    assert.equal(1e-3 ** 1000, 0, '线性域确实下溢');
    const result = normalizeLogWeights([
      { comboId: 'a', logWeight: logWeights[0]! },
      { comboId: 'b', logWeight: logWeights[1]! },
    ]);
    assert.equal(result.ok, true, '对数域必须仍能归一化');
    if (!result.ok) return;
    // a 的似然是 b 的一半，1000 次连乘后比例是 2^1000 : 1 → a 的概率约为 0
    assert.ok(result.value.probabilities[0]! < 1e-100);
    assert.ok(Math.abs(result.value.probabilitySum - 1) < 1e-12);
  });

  it('保持排序关系（规范第八节要求）', () => {
    const result = normalizeLogWeights([
      { comboId: 'high', logWeight: Math.log(0.9) },
      { comboId: 'mid', logWeight: Math.log(0.5) },
      { comboId: 'low', logWeight: Math.log(0.1) },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.value.probabilities[0]! > result.value.probabilities[1]!);
    assert.ok(result.value.probabilities[1]! > result.value.probabilities[2]!);
  });

  it('全部 -Infinity → RANGE_COLLAPSE', () => {
    const result = normalizeLogWeights([
      { comboId: 'a', logWeight: LOG_ZERO },
      { comboId: 'b', logWeight: LOG_ZERO },
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, RangeErrorCode.RANGE_COLLAPSE);
  });

  it('NaN / +Infinity 对数权重被拒绝', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = normalizeLogWeights([
        { comboId: 'a', logWeight: 0 },
        { comboId: 'b', logWeight: bad },
      ]);
      assert.equal(result.ok, false, `${bad} 应被拒绝`);
    }
  });

  it('只有一项有效时概率为 1', () => {
    const result = normalizeLogWeights([
      { comboId: 'a', logWeight: -50 },
      { comboId: 'b', logWeight: LOG_ZERO },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.probabilities[0], 1);
    assert.equal(result.value.probabilities[1], 0);
  });
});

/* ============================================================
 * 端到端：连续更新（规范第八节要求的规模矩阵）
 * ============================================================ */

describe('数值稳定性 —— 端到端连续更新', () => {
  const likelihoods = [1e-2, 1e-4, 1e-8, 1e-12];
  const updateCounts = [10, 50, 100, 500];

  for (const likelihood of likelihoods) {
    for (const count of updateCounts) {
      it(`似然 ${likelihood} × ${count} 次更新：无 NaN / 无 Infinity / 不静默消失 / Σp≈1`, () => {
        let range = build();
        const initialSupport = range.metrics.supportSize;
        const initialSum = range.metrics.probabilitySum;

        const likelihoodsMap = new Map<string, number>();
        for (const entry of range.entries) likelihoodsMap.set(entry.combo.canonicalId, likelihood);
        const model = makeActionModel('BET', likelihoodsMap, PROV);

        for (let i = 1; i <= count; i++) {
          const result = updateRange(
            range,
            model,
            { ...CONTEXT, actionIndex: i },
            { clock: UNBOUNDED_CLOCK, withDiff: false },
          );
          assert.equal(
            result.ok,
            true,
            `第 ${i} 次更新失败：${result.ok ? '' : `${result.code} ${JSON.stringify(result.params)}`}`,
          );
          if (!result.ok) return;
          range = result.value.range;
        }

        // ---- 不变量 ----
        assert.ok(Number.isFinite(range.metrics.probabilitySum), 'Σp 不是有限数');
        assert.ok(isStableNormalized(range.metrics.probabilitySum), `Σp = ${range.metrics.probabilitySum}`);
        assert.ok(Number.isFinite(range.metrics.entropyBits));
        assert.ok(Number.isFinite(range.metrics.effectiveComboCount));

        for (const entry of range.entries) {
          assert.ok(Number.isFinite(entry.probability), `probability 非有限：${entry.combo.canonicalId}`);
          assert.ok(!Number.isNaN(entry.rawWeight), `rawWeight 是 NaN：${entry.combo.canonicalId}`);
          assert.ok(Number.isFinite(entry.rawWeight), `rawWeight 非有限：${entry.combo.canonicalId}`);
        }

        /**
         * **合法组合不得因数值问题静默消失**。
         *
         * 同一个似然作用于所有组合时，相对形状完全不变，
         * 因此支持集必须**严格保持**，Σp 也必须保持 ——
         * 唯一的差异只允许来自浮点舍入（远小于 EPSILON）。
         */
        assert.equal(
          range.metrics.supportSize,
          initialSupport,
          `支持集从 ${initialSupport} 静默变为 ${range.metrics.supportSize}（数值问题）`,
        );
        assert.ok(
          Math.abs(range.metrics.probabilitySum - initialSum) < 1e-12,
          `Σp 从 ${initialSum} 漂移到 ${range.metrics.probabilitySum}`,
        );

        // ---- 分布形状必须完全不变 ----
        const byClass = probabilityByRankClass(range);
        const initialRange = build();
        const initialByClass = probabilityByRankClass(initialRange);
        for (const [cls, p] of initialByClass) {
          assert.ok(
            Math.abs(byClass.get(cls)! - p) < 1e-12,
            `${cls} 的概率被改变了：${p} → ${byClass.get(cls)}`,
          );
        }

        // ---- 校验器仍然通过 ----
        assert.equal(validateRange(range).valid, true);
      });
    }
  }

  it('**Bayesian 方向在极端似然下依然正确**', () => {
    // 强牌似然 1e-2（极小但合法），弱牌似然 1e-12（更小）
    const range = build({ AA: 1, KK: 1, '72o': 1 });
    const before = probabilityByRankClass(range);

    const likelihoods = new Map<string, number>();
    for (const entry of range.entries) {
      likelihoods.set(entry.combo.canonicalId, entry.combo.rankClass === '72o' ? 1e-12 : 1e-2);
    }
    const result = updateRange(range, makeActionModel('BET', likelihoods, PROV), CONTEXT, {
      clock: UNBOUNDED_CLOCK,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const after = probabilityByRankClass(result.value.range);
    assert.ok(after.get('72o')! < before.get('72o')!, '弱牌概率必须下降');
    assert.ok(
      after.get('AA')! + after.get('KK')! > before.get('AA')! + before.get('KK')!,
      '强牌总概率必须上升',
    );
    assert.ok(after.get('AA')! > after.get('72o')!, '方向不得因极端数值而反转');
    assert.ok(isStableNormalized(result.value.range.metrics.probabilitySum));
  });

  it('似然跨越 1e-15 与 1e-1 的巨大差距仍然保持排序', () => {
    const range = build({ AA: 1, KK: 1, QQ: 1, '72o': 1 });
    const likelihoods = new Map<string, number>();
    for (const entry of range.entries) {
      const cls = entry.combo.rankClass;
      const value = cls === 'AA' ? 1e-1 : cls === 'KK' ? 1e-5 : cls === 'QQ' ? 1e-10 : 1e-15;
      likelihoods.set(entry.combo.canonicalId, value);
    }
    const result = updateRange(range, makeActionModel('BET', likelihoods, PROV), CONTEXT, {
      clock: UNBOUNDED_CLOCK,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const byClass = probabilityByRankClass(result.value.range);
    assert.ok(byClass.get('AA')! > byClass.get('KK')!, 'AA > KK');
    assert.ok(byClass.get('KK')! > byClass.get('QQ')!, 'KK > QQ');
    assert.ok(byClass.get('QQ')! > byClass.get('72o')!, 'QQ > 72o');
    // 最弱者也必须保留可表示的概率（不得被下溢吃掉）
    assert.ok(byClass.get('72o')! > 0, '72o 概率必须 > 0');
  });

  it('极小先验 × 极小似然：组合不被静默剔除', () => {
    // 先验里 AA 权重 1e-12，其余正常
    const range = build({ AA: 1e-12, KK: 1, QQ: 1 });
    const likelihoods = new Map<string, number>();
    for (const entry of range.entries) {
      likelihoods.set(entry.combo.canonicalId, entry.combo.rankClass === 'AA' ? 1e-12 : 1);
    }
    const result = updateRange(range, makeActionModel('BET', likelihoods, PROV), CONTEXT, {
      clock: UNBOUNDED_CLOCK,
    });
    assert.equal(result.ok, true, '合法的极小先验 × 极小似然不得报坍塌');
    if (!result.ok) return;

    const byClass = probabilityByRankClass(result.value.range);
    assert.ok(byClass.get('AA')! > 0, 'AA 的概率必须 > 0（不得被下溢成 0）');
    assert.ok(byClass.get('AA')! < byClass.get('KK')!, 'AA 的极小权重必须体现为低概率');
    assert.equal(result.value.range.metrics.supportSize, range.metrics.supportSize);
  });
});

/* ============================================================
 * 与既有行为的兼容性
 * ============================================================ */

describe('数值稳定性 —— 未破坏既有判定', () => {
  it('真正的坍塌（全零似然）仍然报 RANGE_COLLAPSE', () => {
    const range = build({ AA: 1, KK: 1 });
    const zero = new Map<string, number>();
    for (const entry of range.entries) zero.set(entry.combo.canonicalId, 0);
    const result = updateRange(range, makeActionModel('BET', zero, PROV), CONTEXT, {
      clock: UNBOUNDED_CLOCK,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, RangeErrorCode.RANGE_COLLAPSE);
  });

  it('常规似然的黄金答案不受影响（AA/KK/72o → 5.4/4.8/1.2）', () => {
    const range = build({ AA: 1, KK: 1, '72o': 1 });
    const likelihoods = new Map<string, number>();
    for (const entry of range.entries) {
      const cls = entry.combo.rankClass;
      likelihoods.set(entry.combo.canonicalId, cls === 'AA' ? 0.9 : cls === 'KK' ? 0.8 : 0.1);
    }
    const result = updateRange(range, makeActionModel('RAISE', likelihoods, PROV), {
      ...CONTEXT,
      action: 'RAISE',
    }, { clock: UNBOUNDED_CLOCK });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const byClass = probabilityByRankClass(result.value.range);
    assert.ok(Math.abs(byClass.get('AA')! - 5.4 / 11.4) < 1e-12);
    assert.ok(Math.abs(byClass.get('KK')! - 4.8 / 11.4) < 1e-12);
    assert.ok(Math.abs(byClass.get('72o')! - 1.2 / 11.4) < 1e-12);
  });
});
