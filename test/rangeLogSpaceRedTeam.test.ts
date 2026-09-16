/**
 * 回归测试：对数域归一化修复（Step 5A.1 红队 MAJOR-1）
 *
 * ## 缺陷描述
 *
 * 旧版 `rangeUpdate` 在**线性域**归一化，并且做了一次
 * `Math.exp(log(prior) + log(likelihood))`。当
 * `prior × likelihood < 2^-1075 ≈ 2.47e-324` 时 `Math.exp` 精确返回 0，
 * 组合被**静默剔除** —— `validateRange` 依然返回 `valid: true`，
 * 日志里没有任何告警。
 *
 * 红队用 BigInt 精确定点算术证明了边界误差为 0，并给出三个端到端复现。
 * 本文件把三个复现固化为回归测试。
 *
 * ## 修复
 *
 * `rangeUpdate` 全程保持对数域，由 `normalizeLogWeights`（Log-Sum-Exp /
 * softmax）直接产出概率，不再有「先 exp 回线性域再归一化」的中间步骤。
 *
 * ## 一个诚实的边界（不假装解决）
 *
 * 若**调用方在乘法阶段**就把似然乘到 1e-323 量级（例如 `0.25 × 1e-323`），
 * 乘积本身会下溢为 0，信息在那一步就已经丢失，
 * 任何下游归一化都无法挽回。这与「归一化路径是否尺度不变」是两件事：
 * 前者是输入被摧毁，后者是引擎自身的鲁棒性。测试同时锁定这两点。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRangeFromRankClasses, uniformRange } from '../src/domain/range/range.ts';
import { makeActionModel, updateRange } from '../src/domain/range/rangeUpdate.ts';
import { ALL_COMBOS } from '../src/domain/range/combo.ts';
import { validateRange } from '../src/domain/range/rangeValidator.ts';
import {
  RangeAction,
  type ActionModel,
  type RangeProvenance,
} from '../src/domain/range/range.types.ts';
import type { Range } from '../src/domain/range/range.types.ts';

const PROVENANCE: RangeProvenance = {
  sourceId: 'test.lognorm.redteam',
  sourceType: 'TEST_ONLY',
  version: '1.0.0',
  description: '对数域归一化回归测试用来源',
  verified: false,
  confidence: 0.1,
};

const CONTEXT = {
  street: 'FLOP' as const,
  action: RangeAction.BET,
  actor: 'villain',
  actionIndex: 0,
  activePlayerCount: 2,
};

/* ============================================================
 * 辅助
 * ============================================================ */

/** 某个 169 类在当前范围中的总概率 */
function rankClassProbability(range: Range, rankClass: string): number {
  let sum = 0;
  for (const entry of range.entries) {
    if (entry.combo.rankClass === rankClass) sum += entry.probability;
  }
  return sum;
}

/** 只为先验范围内的组合声明 likelihood（否则会触发「不在先验范围内」校验） */
function likelihoodWithin(
  range: Range,
  valueFor: (rankClass: string) => number,
): ActionModel {
  const map = new Map<string, number>();
  for (const entry of range.entries) {
    map.set(entry.combo.canonicalId, valueFor(entry.combo.rankClass));
  }
  return makeActionModel(RangeAction.BET, map, PROVENANCE);
}

function buildPrior(classWeights: Record<string, number>): Range {
  const built = buildRangeFromRankClasses(classWeights, { provenance: PROVENANCE });
  assert.equal(built.ok, true, '前置条件：先验范围必须构造成功');
  if (!built.ok) throw new Error('unreachable');
  return built.value;
}

/* ============================================================
 * 红队复现 1：极小先验权重不得被静默归零
 * ============================================================ */

test('红队复现 1：{AA:1, KK:1e-24} + 均匀似然 1e-300 必须保留 p(KK)=1e-24', () => {
  const prior = buildPrior({ AA: 1, KK: 1e-24 });
  const result = updateRange(prior, likelihoodWithin(prior, () => 1e-300), CONTEXT, {});
  assert.equal(result.ok, true, '更新必须成功（旧版会成功但结果错误）');
  if (!result.ok) return;

  const pKK = rankClassProbability(result.value.range, 'KK');
  assert.ok(pKK > 0, `p(KK) 必须 > 0（旧版精确为 0）实际 ${pKK}`);
  assert.ok(
    Math.abs(pKK - 1e-24) / 1e-24 < 1e-9,
    `p(KK) 必须等于 1e-24（双精度完全可表示）实际 ${pKK}`,
  );
  // 支持集不得收缩：均匀似然不含任何信息
  assert.equal(result.value.range.metrics.supportSize, prior.metrics.supportSize);
  assert.equal(validateRange(result.value.range).valid, true);
});

test('红队复现 1 对照：似然 1e-2 时结果必须与 1e-300 完全一致（尺度无关）', () => {
  const prior = buildPrior({ AA: 1, KK: 1e-24 });
  const small = updateRange(prior, likelihoodWithin(prior, () => 1e-300), CONTEXT, {});
  const large = updateRange(prior, likelihoodWithin(prior, () => 1e-2), CONTEXT, {});
  assert.equal(small.ok, true);
  assert.equal(large.ok, true);
  if (!small.ok || !large.ok) return;

  const smallKK = rankClassProbability(small.value.range, 'KK');
  const largeKK = rankClassProbability(large.value.range, 'KK');
  assert.ok(
    Math.abs(smallKK - largeKK) / largeKK < 1e-9,
    `均匀似然只改变整体尺度，结果必须一致（1e-300 → ${smallKK}，1e-2 → ${largeKK}）`,
  );
});

/* ============================================================
 * 红队复现 2：均匀（无信息）似然不得仅因尺度就改变后验
 * ============================================================ */

test('红队复现 2：{AA:1, KK:1e-2} + 均匀似然 1e-321 必须得到 p(KK)≈0.009901', () => {
  const prior = buildPrior({ AA: 1, KK: 1e-2 });
  const result = updateRange(prior, likelihoodWithin(prior, () => 1e-321), CONTEXT, {});
  assert.equal(result.ok, true, '更新必须成功（旧版得到 p(KK)=0）');
  if (!result.ok) return;

  const pKK = rankClassProbability(result.value.range, 'KK');
  const expected = 0.01 / 1.01; // ≈ 0.00990099
  assert.ok(
    Math.abs(pKK - expected) < 1e-9,
    `p(KK) 必须为 ${expected}（旧版为 0）实际 ${pKK}`,
  );
});

test('红队复现 2 尺度扫描：1e-2 ~ 1e-320 的均匀似然必须给出同一个后验', () => {
  const prior = buildPrior({ AA: 1, KK: 1e-2 });
  const reference = (() => {
    const result = updateRange(prior, likelihoodWithin(prior, () => 1e-2), CONTEXT, {});
    assert.equal(result.ok, true);
    return result.ok ? rankClassProbability(result.value.range, 'KK') : Number.NaN;
  })();

  for (const value of [1e-12, 1e-100, 1e-300, 1e-320]) {
    const result = updateRange(prior, likelihoodWithin(prior, () => value), CONTEXT, {});
    assert.equal(result.ok, true, `似然 ${value} 必须成功`);
    if (!result.ok) continue;
    const pKK = rankClassProbability(result.value.range, 'KK');
    assert.ok(
      Math.abs(pKK - reference) / reference < 1e-9,
      `似然 ${value}：p(KK)=${pKK} 必须与参照值 ${reference} 一致`,
    );
    assert.ok(pKK > 0, `似然 ${value}：p(KK) 必须 > 0（旧版在下溢阈值处归零）`);
  }
});

/* ============================================================
 * 红队复现 3：均匀范围上的假坍塌
 * ============================================================ */

test('红队复现 3：uniformRange + 均匀似然 1e-321 不得误报 RANGE_COLLAPSE', () => {
  const built = uniformRange(PROVENANCE);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  // 旧版在 1e-321 处报 RANGE_COLLAPSE（1e-320 却正常），是纯粹的假坍塌
  for (const value of [1e-320, 1e-321, 1e-323]) {
    const map = new Map<string, number>();
    for (const combo of ALL_COMBOS) map.set(combo.canonicalId, value);
    const result = updateRange(
      built.value,
      makeActionModel(RangeAction.BET, map, PROVENANCE),
      CONTEXT,
      {},
    );
    assert.equal(result.ok, true, `似然 ${value} 不得报坍塌`);
    if (!result.ok) continue;
    assert.equal(result.value.range.metrics.supportSize, 1326, `似然 ${value} 支持集必须完整`);
    assert.ok(
      Math.abs(result.value.range.metrics.probabilitySum - 1) < 1e-9,
      `似然 ${value} 概率和必须为 1`,
    );
  }
});

/* ============================================================
 * 尺度不变性（真实非均匀似然）
 * ============================================================ */

test('尺度不变性：非均匀似然整体缩小 1e-300 后后验必须完全不变', () => {
  const prior = buildPrior({ AA: 1, KK: 0.5, QQ: 0.25 });
  const base: Readonly<Record<string, number>> = { AA: 1, KK: 0.5, QQ: 0.25 };

  let reference: number | null = null;
  for (const scale of [1, 1e-6, 1e-100, 1e-300, 1e-320]) {
    const result = updateRange(
      prior,
      likelihoodWithin(prior, (rankClass) => (base[rankClass] ?? 0.5) * scale),
      CONTEXT,
      {},
    );
    assert.equal(result.ok, true, `scale=${scale} 必须成功`);
    if (!result.ok) continue;
    const pAA = rankClassProbability(result.value.range, 'AA');
    if (reference === null) reference = pAA;
    else {
      assert.ok(
        Math.abs(pAA - reference) < 1e-12,
        `scale=${scale}：p(AA)=${pAA} 必须等于 ${reference}`,
      );
    }
  }
  assert.notEqual(reference, null);
});

test('诚实的边界：似然在乘法阶段就下溢为 0 时，引擎无法挽回（不是归一化的错）', () => {
  const prior = buildPrior({ AA: 1, KK: 0.5, QQ: 0.25 });
  const base: Readonly<Record<string, number>> = { AA: 1, KK: 0.5, QQ: 0.25 };

  // 0.25 × 1e-323 在双精度下精确为 0 —— 信息在**进入引擎之前**就没了。
  // 引擎此时看到的是「该组合似然为 0」，按贝叶斯定义理应剔除它。
  const scale = 1e-323;
  const destroyedCount = Object.values(base).filter((v) => v * scale === 0).length;
  assert.ok(destroyedCount > 0, '前置条件：该量级下确实有似然被乘成 0');

  const result = updateRange(
    prior,
    likelihoodWithin(prior, (rankClass) => (base[rankClass] ?? 0.5) * scale),
    CONTEXT,
    {},
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // 支持集收缩到只剩未被摧毁的那些 —— 这是输入问题的正确反映，不是静默错误
  assert.ok(
    result.value.range.metrics.supportSize < prior.metrics.supportSize,
    '下溢为 0 的似然对应的组合应被移除（这是定义，不是缺陷）',
  );
  // 被保留下来的部分仍必须归一化正确
  assert.ok(Math.abs(result.value.range.metrics.probabilitySum - 1) < 1e-9);
  assert.equal(validateRange(result.value.range).valid, true);
});

/* ============================================================
 * 结构性保证：rangeUpdate 不得再次引入线性域 exp
 * ============================================================ */

test('结构性：rangeUpdate 的源文件里不得出现 Math.exp（防止回归）', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/domain/range/rangeUpdate.ts', import.meta.url), 'utf8');
  // 去掉注释后检查，避免文档里提到 Math.exp 就误报
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(
    !/Math\.exp\s*\(/.test(withoutComments),
    'rangeUpdate 不得在代码里调用 Math.exp —— 那会把绝对尺度重新变成致命因素',
  );
  assert.ok(
    /normalizeLogWeights/.test(withoutComments),
    'rangeUpdate 必须使用对数域归一化 normalizeLogWeights',
  );
});

test('结构性：极小似然下不得产生任何校验失败或告警', () => {
  const prior = buildPrior({ AA: 1, KK: 1e-24 });
  const result = updateRange(prior, likelihoodWithin(prior, () => 1e-300), CONTEXT, {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const validation = validateRange(result.value.range);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.violations, [], '不得有任何违规项');
});
