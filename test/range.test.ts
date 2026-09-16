/**
 * 范围引擎测试（规范第四十二 ~ 五十四节）
 *
 * 本文件是整个 Phase 4 最重要的文件：范围引擎「运行完全正常但算错」时，
 * 没有任何运行时错误会提示你 —— 只有测试能发现。
 *
 * 覆盖：
 * - Combo universe 与 169 类展开（详见 combo.test.ts）
 * - Blocker 过滤与容量（1225 / 1081 / 1035 / 990）
 * - 归一化与不变量
 * - 贝叶斯更新（含**人工计算的黄金答案**与**方向性反向测试**）
 * - 不可变性（旧范围绝不改变）
 * - Range Collapse Fail Safe
 * - Deadline 中止
 * - 缓存（key 完整性 / 防污染）
 * - 来源与可信度（不把启发式冒充理论）
 * - 属性测试（1000 组，seeded RNG）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_COMBOS,
  ALL_RANK_CLASSES,
  COMBO_CAPACITY,
  expandRankClass,
  type ExactCombo,
} from '../src/domain/range/combo.ts';
import {
  RangeErrorCode,
  RangeSource,
  RangeState,
  UNBOUNDED_CLOCK,
  rangeFailure,
  type Range,
  type RangeProvenance,
  type RangeUpdateContext,
} from '../src/domain/range/range.types.ts';
import {
  buildRangeFromComboWeights,
  buildRangeFromRankClasses,
  entryOf,
  probabilityByRankClass,
  uniformRange,
} from '../src/domain/range/range.ts';
import { checkActionModelCompleteness, makeActionModel, updateRange, validateActionModel } from '../src/domain/range/rangeUpdate.ts';
import {
  deadCardsFrom,
  isBlocked,
  mergeDeadCards,
  removeBlockedCombos,
} from '../src/domain/range/rangeBlockers.ts';
import {
  isNormalized,
  normalizeWeights,
  probabilityMetrics,
  validateRawWeights,
} from '../src/domain/range/rangeNormalize.ts';
import { diffRanges, narrowingRatio, describeRangeMetrics } from '../src/domain/range/rangeMetrics.ts';
import { assertValidRange, validateRange, RangeViolationCode } from '../src/domain/range/rangeValidator.ts';
import {
  buildRangeCacheKey,
  cloneRange,
  createRangeCache,
  isFrozen,
} from '../src/domain/range/rangeCache.ts';
import { testOnlyProvenance, validateProvenance } from '../src/domain/range/rangeProvenance.ts';
import { DecisionDeadline, DeadlineMode, type Clock } from '../src/app/decisionDeadline.ts';
import { runPipeline, PipelineStage } from '../src/app/decisionPipeline.ts';
import { mulberry32 } from '../src/infra/rng.ts';
import type { RangeClock } from '../src/domain/range/range.types.ts';
import { ALL_SUITS, type Card } from '../src/domain/types.ts';
import { c, C } from './helpers.ts';

/* ============================================================
 * 测试夹具
 * ============================================================ */

const TEST_PROV = testOnlyProvenance('test.range.fixture', '仅用于单元测试的合成范围');

function buildRange(
  classWeights: Record<string, number>,
  dead: readonly Card[] = [],
): Range {
  const result = buildRangeFromRankClasses(classWeights, {
    provenance: TEST_PROV,
    deadCards: dead,
    rangeIdPrefix: 'test',
  });
  assert.equal(result.ok, true, `构建范围失败：${result.ok ? '' : JSON.stringify(result)}`);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

const PREFLOP_CONTEXT: RangeUpdateContext = {
  street: 'PREFLOP',
  action: 'RAISE',
  actor: 'UTG',
  actionIndex: 1,
  activePlayerCount: 6,
};

function fakeClock(start = 0): { clock: Clock; advance: (ms: number) => void } {
  let current = start;
  return { clock: () => current, advance: (ms: number) => { current += ms; } };
}

/* ============================================================
 * Blocker 过滤（规范第十 / 十一 / 四十三 / 四十四 / 四十五节）
 * ============================================================ */

describe('Blocker —— 死牌过滤与剩余容量', () => {
  it('Hero A♠K♦ → 所有含 A♠ 或 K♦ 的组合被移除，剩余恰好 1225', () => {
    const hero = C('As Kd');
    const dead = deadCardsFrom(hero);
    const { kept, removedCount } = removeBlockedCombos(ALL_COMBOS, dead);

    assert.equal(kept.length, 1225, `剩余应为 C(50,2)=1225，实际 ${kept.length}`);
    assert.equal(kept.length, COMBO_CAPACITY[2]);
    assert.equal(removedCount, 1326 - 1225);
    // 每一个被移除的组合都必须真的含 A♠ 或 K♦
    const blocked = ALL_COMBOS.filter((x) => isBlocked(x, dead));
    assert.equal(blocked.length, removedCount);
    for (const combo of blocked) {
      const hasAceSpade = combo.canonicalId.includes('As');
      const hasKingDiamond = combo.canonicalId.includes('Kd');
      assert.ok(hasAceSpade || hasKingDiamond, `${combo.canonicalId} 不该被移除`);
    }
    // 保留下来的组合绝不与死牌冲突
    for (const combo of kept) assert.equal(isBlocked(combo, dead), false);
  });

  it('Hero 2 张 + 翻牌 3 张 = 5 张已知 → 剩余恰好 1081', () => {
    const dead = deadCardsFrom(C('As Kd Qh 9s 4c'));
    assert.equal(dead.size, 5, '本用例应恰好有 5 张已知牌（Hero 2 张 + 翻牌 3 张）');
    const { kept } = removeBlockedCombos(ALL_COMBOS, dead);
    assert.equal(kept.length, 1081, `剩余应为 C(47,2)=1081，实际 ${kept.length}`);
    assert.equal(kept.length, COMBO_CAPACITY[5]);
  });

  it('Hero 2 张 + 转牌 6 张已知 → 剩余恰好 1035', () => {
    const dead = deadCardsFrom(C('As Kd Qh 7c 2s 9d'));
    const { kept } = removeBlockedCombos(ALL_COMBOS, dead);
    assert.equal(kept.length, 1035, `剩余应为 C(46,2)=1035，实际 ${kept.length}`);
    assert.equal(kept.length, COMBO_CAPACITY[6]);
  });

  it('Hero 2 张 + 河牌 7 张已知 → 剩余恰好 990', () => {
    const dead = deadCardsFrom(C('As Kd Qh 7c 2s 9d 3h'));
    const { kept } = removeBlockedCombos(ALL_COMBOS, dead);
    assert.equal(kept.length, 990, `剩余应为 C(45,2)=990，实际 ${kept.length}`);
    assert.equal(kept.length, COMBO_CAPACITY[7]);
  });

  it('构建范围时自动移除死牌组合', () => {
    const range = buildRange({ AA: 1, KK: 1 }, C('As Kd'));
    // AA 原本 6 个，含 A♠ 的 3 个被移除（AsAh, AsAd, AsAc）
    // KK 原本 6 个，含 K♦ 的 3 个被移除（KdKs, KdKh, KdKc）
    assert.equal(range.entries.length, 6, `实际保留 ${range.entries.length} 条`);
    for (const entry of range.entries) {
      assert.equal(entry.combo.canonicalId.includes('As'), false);
      assert.equal(entry.combo.canonicalId.includes('Kd'), false);
    }
  });

  it('**移除死牌后必须重新归一化**：Σprobability 仍 ≈ 1', () => {
    const range = buildRange({ AA: 1, KK: 1, QQ: 1 }, C('As Kd'));
    assert.ok(isNormalized(range.metrics.probabilitySum), `Σp = ${range.metrics.probabilitySum}`);
    let sum = 0;
    for (const entry of range.entries) sum += entry.probability;
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });

  it('mergeDeadCards 合并多个死牌集合', () => {
    const a = deadCardsFrom(C('As Kd'));
    const b = deadCardsFrom(C('Qh'));
    const merged = mergeDeadCards(a, b);
    assert.equal(merged.size, 3);
    assert.equal(isBlocked(ALL_COMBOS.find((x) => x.canonicalId === 'AsKs')!, merged), true);
    assert.equal(isBlocked(ALL_COMBOS.find((x) => x.canonicalId === 'QsQh')!, merged), true);
  });

  it('无死牌时容量为 1326（不减不增）', () => {
    const { kept, removedCount } = removeBlockedCombos(ALL_COMBOS, new Set<number>());
    assert.equal(kept.length, 1326);
    assert.equal(removedCount, 0);
  });
});

/* ============================================================
 * 归一化（规范第九 / 四十 / 四十六节）
 * ============================================================ */

describe('归一化 —— 不变量与错误处理', () => {
  it('均匀权重归一化后每个概率 = 1/n，总和 = 1', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ comboId: `c${i}`, rawWeight: 1 }));
    const result = normalizeWeights(items);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.probabilities.length, 10);
    for (const p of result.value.probabilities) assert.ok(Math.abs(p - 0.1) < 1e-12);
    assert.ok(isNormalized(result.value.probabilitySum));
  });

  it('相对权重被正确折叠成概率（1 : 1 : 0.5 → 0.4 : 0.4 : 0.2）', () => {
    const result = normalizeWeights([
      { comboId: 'a', rawWeight: 1 },
      { comboId: 'b', rawWeight: 1 },
      { comboId: 'c', rawWeight: 0.5 },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(Math.abs(result.value.probabilities[0]! - 0.4) < 1e-12);
    assert.ok(Math.abs(result.value.probabilities[1]! - 0.4) < 1e-12);
    assert.ok(Math.abs(result.value.probabilities[2]! - 0.2) < 1e-12);
  });

  it('**负权重必须报错，不得静默 Math.max(0, w)**', () => {
    const result = normalizeWeights([
      { comboId: 'a', rawWeight: 1 },
      { comboId: 'b', rawWeight: -0.5 },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, RangeErrorCode.RANGE_VALIDATION_FAILED);
    assert.equal(result.params.comboId, 'b');
    assert.ok(String(result.params.problem).includes('负'));
  });

  it('NaN / Infinity 权重必须报错', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = normalizeWeights([
        { comboId: 'a', rawWeight: 1 },
        { comboId: 'b', rawWeight: bad },
      ]);
      assert.equal(result.ok, false, `${bad} 应被拒绝`);
    }
  });

  it('validateRawWeights 一次返回全部问题（收集式）', () => {
    const issues = validateRawWeights([
      { comboId: 'a', rawWeight: -1 },
      { comboId: 'b', rawWeight: Number.NaN },
      { comboId: 'c', rawWeight: 1 },
      { comboId: 'd', rawWeight: -2 },
    ]);
    assert.equal(issues.length, 3);
    assert.deepEqual(issues.map((i) => i.comboId), ['a', 'b', 'd']);
  });

  it('全部权重为 0 → RANGE_COLLAPSE（不是返回均匀分布）', () => {
    const result = normalizeWeights([
      { comboId: 'a', rawWeight: 0 },
      { comboId: 'b', rawWeight: 0 },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, RangeErrorCode.RANGE_COLLAPSE);
  });

  it('空条目 → RANGE_COLLAPSE', () => {
    const result = normalizeWeights([]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, RangeErrorCode.RANGE_COLLAPSE);
  });

  it('属性：随机合法权重归一化后 Σp ≈ 1 且每个 p 落在 0..1', () => {
    const rng = mulberry32(20260101);
    for (let round = 0; round < 300; round++) {
      const n = 1 + Math.floor(rng() * 1326);
      const items = Array.from({ length: n }, (_, i) => ({
        comboId: `c${i}`,
        rawWeight: rng() * 100,
      }));
      const result = normalizeWeights(items);
      assert.equal(result.ok, true, `第 ${round} 轮归一化失败`);
      if (!result.ok) continue;
      assert.ok(Math.abs(result.value.probabilitySum - 1) < 1e-9, `第 ${round} 轮 Σp=${result.value.probabilitySum}`);
      for (const p of result.value.probabilities) {
        assert.ok(Number.isFinite(p));
        assert.ok(p >= 0 && p <= 1, `第 ${round} 轮出现越界概率 ${p}`);
      }
    }
  });
});

/* ============================================================
 * 度量（规范第二十八 / 二十九 / 三十节）
 * ============================================================ */

describe('范围度量 —— 熵与有效组合数', () => {
  it('均匀分布：effectiveComboCount = n，归一化熵 = 1', () => {
    const n = 100;
    const metrics = probabilityMetrics(new Array(n).fill(1 / n));
    assert.ok(Math.abs(metrics.effectiveComboCount - n) < 1e-6, `有效组合数 ${metrics.effectiveComboCount}`);
    assert.ok(Math.abs(metrics.normalizedEntropy - 1) < 1e-9);
    assert.ok(Math.abs(metrics.entropyBits - Math.log2(n)) < 1e-9);
  });

  it('单点分布：effectiveComboCount = 1，熵 = 0', () => {
    const metrics = probabilityMetrics([1]);
    assert.ok(Math.abs(metrics.effectiveComboCount - 1) < 1e-9);
    assert.ok(Math.abs(metrics.entropyBits) < 1e-12);
  });

  it('**组合数量相同但集中度不同，熵必须能区分**（规范第二十九节）', () => {
    const n = 100;
    const uniform = probabilityMetrics(new Array(n).fill(1 / n));
    // 同样 100 个组合，但 99 个几乎为 0，1 个占绝大部分
    const concentrated = probabilityMetrics([0.9, ...new Array(n - 1).fill(0.1 / (n - 1))]);
    assert.equal(uniform.supportSize, concentrated.supportSize, '两者有效组合数相同');
    assert.ok(
      concentrated.entropyBits < uniform.entropyBits,
      `集中分布的熵应更低：${concentrated.entropyBits} vs ${uniform.entropyBits}`,
    );
    assert.ok(concentrated.effectiveComboCount < uniform.effectiveComboCount);
  });

  it('effectiveComboCount = 1 / Σ(p²) 公式正确', () => {
    const p = [0.5, 0.25, 0.25];
    const expected = 1 / (0.25 + 0.0625 + 0.0625);
    const metrics = probabilityMetrics(p);
    assert.ok(Math.abs(metrics.effectiveComboCount - expected) < 1e-9);
  });

  it('空概率数组不产生 NaN', () => {
    const metrics = probabilityMetrics([]);
    assert.equal(metrics.effectiveComboCount, 0);
    assert.equal(metrics.entropyBits, 0);
    assert.equal(metrics.normalizedEntropy, 0);
  });

  it('全范围（1326 均匀）的熵 = log2(1326)', () => {
    const range = (() => {
      const result = uniformRange(TEST_PROV);
      assert.equal(result.ok, true);
      return result.ok ? result.value : null;
    })();
    assert.ok(range);
    assert.equal(range!.entries.length, 1326);
    assert.ok(Math.abs(range!.metrics.entropyBits - Math.log2(1326)) < 1e-9);
    assert.ok(Math.abs(range!.metrics.effectiveComboCount - 1326) < 1e-6);
  });
});

/* ============================================================
 * 贝叶斯更新（规范第四十八 / 四十九 / 五十 / 五十一节）
 * ============================================================ */

describe('贝叶斯更新 —— 人工计算的黄金答案', () => {
  /**
   * 场景：只有 AA（6）、KK（6）、72o（12）三类，先验完全均匀。
   * Raise 似然：AA = 0.9，KK = 0.8，72o = 0.1
   *
   * ⚠️ 注意 72o 是 **12** 个组合（4×3），不是 10 ——
   * 唯一只有 10 个组合的是「非对子的同点数组合」？并非如此：
   * 对子 6、同花 4、不同花 12，这是全部三种情况。
   * 因此总组合数 = 6 + 6 + 12 = 24。
   *
   * 手工计算（每条先验概率 = 1/24）：
   *   AA  后验 ∝ (6/24) × 0.9 = 5.4/24
   *   KK  后验 ∝ (6/24) × 0.8 = 4.8/24
   *   72o 后验 ∝ (12/24) × 0.1 = 1.2/24
   *   总和 = 11.4/24
   *   P(AA)  = 5.4/11.4  = 0.4736842105263158
   *   P(KK)  = 4.8/11.4  = 0.4210526315789474
   *   P(72o) = 1.2/11.4  = 0.1052631578947368
   */
  function buildThreeHandRange(): Range {
    return buildRange({ AA: 1, KK: 1, '72o': 1 });
  }

  function raiseModel(prior: Range) {
    const likelihoods = new Map<string, number>();
    for (const entry of prior.entries) {
      const cls = entry.combo.rankClass;
      const value = cls === 'AA' ? 0.9 : cls === 'KK' ? 0.8 : 0.1;
      likelihoods.set(entry.combo.canonicalId, value);
    }
    return makeActionModel('RAISE', likelihoods, TEST_PROV);
  }

  it('先验均匀时三类各占 6/24、6/24、12/24', () => {
    const prior = buildThreeHandRange();
    assert.equal(prior.entries.length, 24, 'AA 6 + KK 6 + 72o 12 = 24');
    const byClass = probabilityByRankClass(prior);
    assert.ok(Math.abs(byClass.get('AA')! - 6 / 24) < 1e-12, `P(AA)=${byClass.get('AA')}`);
    assert.ok(Math.abs(byClass.get('KK')! - 6 / 24) < 1e-12);
    assert.ok(Math.abs(byClass.get('72o')! - 12 / 24) < 1e-12);
  });

  it('**引擎结果与人工计算的黄金答案逐位一致**', () => {
    const prior = buildThreeHandRange();
    const updated = updateRange(prior, raiseModel(prior), PREFLOP_CONTEXT);
    assert.equal(updated.ok, true);
    if (!updated.ok) return;

    const byClass = probabilityByRankClass(updated.value.range);
    const expectedAA = 5.4 / 11.4;
    const expectedKK = 4.8 / 11.4;
    const expected72 = 1.2 / 11.4;

    assert.ok(Math.abs(byClass.get('AA')! - expectedAA) < 1e-12, `P(AA)=${byClass.get('AA')}，期望 ${expectedAA}`);
    assert.ok(Math.abs(byClass.get('KK')! - expectedKK) < 1e-12, `P(KK)=${byClass.get('KK')}，期望 ${expectedKK}`);
    assert.ok(Math.abs(byClass.get('72o')! - expected72) < 1e-12, `P(72o)=${byClass.get('72o')}，期望 ${expected72}`);
    assert.ok(isNormalized(updated.value.range.metrics.probabilitySum));
  });

  it('方向性：P(AA) > P(KK) > P(72o)', () => {
    const prior = buildThreeHandRange();
    const updated = updateRange(prior, raiseModel(prior), PREFLOP_CONTEXT);
    assert.equal(updated.ok, true);
    if (!updated.ok) return;
    const byClass = probabilityByRankClass(updated.value.range);
    assert.ok(byClass.get('AA')! > byClass.get('KK')!, 'AA 应比 KK 更可能');
    assert.ok(byClass.get('KK')! > byClass.get('72o')!, 'KK 应比 72o 更可能');
  });

  it('**反向测试：Fold 之后 72o 概率必须上升（Bayesian 方向未写反）**', () => {
    const prior = buildThreeHandRange();
    const priorByClass = probabilityByRankClass(prior);

    // Fold 似然：强牌很少弃，弱牌经常弃
    const likelihoods = new Map<string, number>();
    for (const entry of prior.entries) {
      const cls = entry.combo.rankClass;
      const value = cls === 'AA' ? 0.1 : cls === 'KK' ? 0.2 : 0.9;
      likelihoods.set(entry.combo.canonicalId, value);
    }
    const updated = updateRange(
      prior,
      makeActionModel('FOLD', likelihoods, TEST_PROV),
      { ...PREFLOP_CONTEXT, action: 'FOLD' },
    );
    assert.equal(updated.ok, true);
    if (!updated.ok) return;

    const afterByClass = probabilityRankClassMap(updated.value.range);
    assert.ok(
      afterByClass.get('72o')! > priorByClass.get('72o')!,
      `弃牌后 72o 概率应上升：${priorByClass.get('72o')} → ${afterByClass.get('72o')}`,
    );
    assert.ok(
      afterByClass.get('AA')! < priorByClass.get('AA')!,
      `弃牌后 AA 概率应下降：${priorByClass.get('AA')} → ${afterByClass.get('AA')}`,
    );
    assert.ok(afterByClass.get('72o')! > afterByClass.get('AA')!, '弃牌后 72o 应成为最可能的类别');
  });

  it('似然全为 1 → 后验等于先验（无信息动作）', () => {
    const prior = buildThreeHandRange();
    const likelihoods = new Map<string, number>();
    for (const entry of prior.entries) likelihoods.set(entry.combo.canonicalId, 1);
    const updated = updateRange(
      prior,
      makeActionModel('CHECK', likelihoods, TEST_PROV),
      { ...PREFLOP_CONTEXT, action: 'CHECK' },
    );
    assert.equal(updated.ok, true);
    if (!updated.ok) return;
    const before = probabilityByRankClass(prior);
    const after = probabilityRankClassMap(updated.value.range);
    for (const cls of ['AA', 'KK', '72o']) {
      assert.ok(
        Math.abs(before.get(cls)! - after.get(cls)!) < 1e-12,
        `${cls} 无信息动作后概率应不变：${before.get(cls)} vs ${after.get(cls)}`,
      );
    }
  });

  it('先验的**绝对尺度不影响后验**（这是用 probability 相乘而非 weight 相乘的意义）', () => {
    const scale1 = buildRange({ AA: 1, KK: 1, '72o': 1 });
    const scale2 = buildRange({ AA: 10, KK: 10, '72o': 10 });

    const updated1 = updateRange(scale1, raiseModel(scale1), PREFLOP_CONTEXT);
    const updated2 = updateRange(scale2, raiseModel(scale2), PREFLOP_CONTEXT);
    assert.equal(updated1.ok && updated2.ok, true);
    if (!updated1.ok || !updated2.ok) return;

    const a = probabilityRankClassMap(updated1.value.range);
    const b = probabilityRankClassMap(updated2.value.range);
    for (const cls of ['AA', 'KK', '72o']) {
      assert.ok(
        Math.abs(a.get(cls)! - b.get(cls)!) < 1e-12,
        `权重整体放大 10 倍不应改变后验：${a.get(cls)} vs ${b.get(cls)}`,
      );
    }
  });
});

/** 按类别汇总概率（测试内部使用，避免与实现耦合） */
function probabilityRankClassMap(range: Range): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of range.entries) {
    map.set(entry.combo.rankClass, (map.get(entry.combo.rankClass) ?? 0) + entry.probability);
  }
  return map;
}

/* ============================================================
 * 连续更新与不可变性（规范第五十节）
 * ============================================================ */

describe('范围更新 —— 连续更新与不可变性', () => {
  it('Prior → Flop Call → Turn Raise → River Bet，每一步生成新范围且旧范围不变', () => {
    const prior = buildRange({ AA: 1, KK: 1, QQ: 1, AKs: 1, '72o': 1 });
    const snapshot = JSON.stringify(prior.entries.map((e) => [e.combo.canonicalId, e.probability]));

    const steps: Array<{ street: RangeUpdateContext['street']; action: 'CALL' | 'RAISE' | 'BET' }> = [
      { street: 'FLOP', action: 'CALL' },
      { street: 'TURN', action: 'RAISE' },
      { street: 'RIVER', action: 'BET' },
    ];

    let current = prior;
    const history: Range[] = [prior];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const likelihoods = new Map<string, number>();
      for (const entry of current.entries) {
        // 让每一步都真实改变分布（强牌更可能继续进攻）
        const strong = entry.combo.rankClass.startsWith('A') || entry.combo.rankClass === 'KK';
        const base = step.action === 'CALL' ? (strong ? 0.7 : 0.3) : strong ? 0.85 : 0.15;
        likelihoods.set(entry.combo.canonicalId, base);
      }
      const result = updateRange(
        current,
        makeActionModel(step.action, likelihoods, TEST_PROV),
        {
          street: step.street,
          action: step.action,
          actor: 'BTN',
          actionIndex: i + 1,
          activePlayerCount: 2,
        },
      );
      assert.equal(result.ok, true, `第 ${i + 1} 步更新失败`);
      if (!result.ok) return;
      history.push(result.value.range);
      current = result.value.range;
    }

    // 旧范围完全不变
    assert.equal(
      JSON.stringify(prior.entries.map((e) => [e.combo.canonicalId, e.probability])),
      snapshot,
      '先验范围被污染了',
    );
    // 每一步都是不同的对象
    const ids = new Set(history.map((r) => r.rangeId));
    assert.equal(ids.size, history.length, '每步应产生新的 rangeId');
    // previousRangeId 形成链条
    for (let i = 1; i < history.length; i++) {
      assert.equal(history[i]!.previousRangeId, history[i - 1]!.rangeId, `第 ${i} 步的链断了`);
    }
    // 每一步的 Σp 都正确
    for (const range of history) {
      assert.ok(isNormalized(range.metrics.probabilitySum));
      assert.ok(validateRange(range).valid, `范围 ${range.rangeId} 校验失败`);
    }
  });

  it('范围对象是冻结的（防止调用者原地修改）', () => {
    const range = buildRange({ AA: 1, KK: 1 });
    assert.equal(isFrozen(range), true, '范围未被冻结');
    assert.equal(Object.isFrozen(range), true);
    assert.equal(Object.isFrozen(range.entries), true);
  });

  it('严格模式下修改冻结范围会抛错', () => {
    const range = buildRange({ AA: 1, KK: 1 });
    assert.throws(() => {
      // 故意原地改写概率
      (range.entries[0] as { probability: number }).probability = 0.99;
    }, TypeError);
  });

  it('updateRange 的日志完整可审计（规范第三十一节）', () => {
    const prior = buildRange({ AA: 1, '72o': 1 });
    const likelihoods = new Map<string, number>();
    for (const entry of prior.entries) {
      likelihoods.set(entry.combo.canonicalId, entry.combo.rankClass === 'AA' ? 0.9 : 0.1);
    }
    const result = updateRange(prior, makeActionModel('RAISE', likelihoods, TEST_PROV), PREFLOP_CONTEXT, {
      withDiff: true,
      diffTopN: 3,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const log = result.value.log;
    assert.equal(log.previousRangeId, prior.rangeId);
    assert.equal(log.newRangeId, result.value.range.rangeId);
    assert.equal(log.street, 'PREFLOP');
    assert.equal(log.action, 'RAISE');
    assert.equal(log.actor, 'UTG');
    assert.equal(log.context.activePlayerCount, 6);
    assert.equal(log.beforeMetrics.supportSize, prior.metrics.supportSize);
    assert.equal(log.afterMetrics.supportSize, result.value.range.metrics.supportSize);
    assert.equal(typeof log.runtimeMs, 'number');
    assert.equal(log.aborted, false);
    assert.ok(log.summary.topIncreases.length > 0, '应有概率上升的组合');
    assert.ok(log.summary.entropyBefore >= 0 && log.summary.entropyAfter >= 0);
  });

  it('变更摘要默认只取 top N，不保存全量 diff（规范第三十二节）', () => {
    const prior = buildRange({ AA: 1, KK: 1, QQ: 1, JJ: 1, TT: 1, '72o': 1 });
    const likelihoods = new Map<string, number>();
    for (const entry of prior.entries) likelihoods.set(entry.combo.canonicalId, 0.5);
    const result = updateRange(prior, makeActionModel('BET', likelihoods, TEST_PROV), PREFLOP_CONTEXT, {
      diffTopN: 2,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.value.log.summary.topIncreases.length <= 2);
    assert.ok(result.value.log.summary.topDecreases.length <= 2);
  });
});

/* ============================================================
 * Fail Safe（规范第十二 / 五十一节）
 * ============================================================ */

describe('Fail Safe —— Range Collapse 绝不被静默修复', () => {
  it('全部 likelihood = 0 → RANGE_COLLAPSE（不是 NaN，也不是均匀分布）', () => {
    const prior = buildRange({ AA: 1, KK: 1, '72o': 1 });
    const likelihoods = new Map<string, number>();
    for (const entry of prior.entries) likelihoods.set(entry.combo.canonicalId, 0);

    const result = updateRange(prior, makeActionModel('RAISE', likelihoods, TEST_PROV), PREFLOP_CONTEXT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, RangeErrorCode.RANGE_COLLAPSE);
    assert.equal(result.params.action, 'RAISE');
    assert.ok(String(result.params.note).includes('不可能发生'));
  });

  it('坍塌时**不返回任何范围对象**（不伪造结果）', () => {
    const prior = buildRange({ AA: 1 });
    const likelihoods = new Map<string, number>();
    for (const entry of prior.entries) likelihoods.set(entry.combo.canonicalId, 0);
    const result = updateRange(prior, makeActionModel('RAISE', likelihoods, TEST_PROV), PREFLOP_CONTEXT);
    assert.equal(result.ok, false);
    assert.equal('value' in result, false, '失败时不得携带范围结果');
  });

  it('坍塌时先验范围保持不变（不偷偷恢复）', () => {
    const prior = buildRange({ AA: 1, KK: 1 });
    const before = JSON.stringify(prior.entries.map((e) => e.probability));
    const likelihoods = new Map<string, number>();
    for (const entry of prior.entries) likelihoods.set(entry.combo.canonicalId, 0);
    const result = updateRange(prior, makeActionModel('RAISE', likelihoods, TEST_PROV), PREFLOP_CONTEXT);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(prior.entries.map((e) => e.probability)), before);
  });

  it('死牌移除后没有合法组合 → RANGE_COLLAPSE', () => {
    // 用 AA 与 KK 建范围，然后用大量死牌把它们全封死
    const dead = C('As Ah Ad Ac Ks Kh Kd Kc');
    const result = buildRangeFromRankClasses({ AA: 1, KK: 1 }, {
      provenance: TEST_PROV,
      deadCards: dead,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, RangeErrorCode.RANGE_COLLAPSE);
  });
});

/* ============================================================
 * Deadline（规范第三十三 / 三十五 / 三十六 / 五十二节）
 * ============================================================ */

describe('Deadline —— 范围引擎必须可中止', () => {
  it('时间预算耗尽时返回 RANGE_DEADLINE_EXCEEDED，且不返回部分范围', () => {
    const prior = uniformRange(TEST_PROV);
    assert.equal(prior.ok, true);
    if (!prior.ok) return;

    // 一开始就超时的时钟
    let current = 0;
    const exhausted: RangeClock = {
      remainingMs: () => 0,
      isAborted: () => false,
      isExpired: () => true,
      canAfford: () => false,
      snapshot: () => ({ elapsedMs: current, remainingMs: 0 }),
    };

    const likelihoods = new Map<string, number>();
    for (const entry of prior.value.entries) likelihoods.set(entry.combo.canonicalId, 0.5);

    const result = updateRange(
      prior.value,
      makeActionModel('BET', likelihoods, TEST_PROV),
      PREFLOP_CONTEXT,
      { clock: exhausted },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, RangeErrorCode.RANGE_DEADLINE_EXCEEDED);
    assert.equal(result.params.totalCombos, 1326);
    assert.equal('value' in result, false, '中止时不得返回部分范围');
  });

  it('时间充足时正常完成', () => {
    const prior = buildRange({ AA: 1, KK: 1 });
    const likelihoods = new Map<string, number>();
    for (const entry of prior.entries) likelihoods.set(entry.combo.canonicalId, 0.5);
    const result = updateRange(prior, makeActionModel('BET', likelihoods, TEST_PROV), PREFLOP_CONTEXT, {
      clock: UNBOUNDED_CLOCK,
    });
    assert.equal(result.ok, true);
  });

  it('**通过 assertStageRespectsDeadline 契约自检（不允许成为第二条不可中止路径）**', async () => {
    const { assertStageRespectsDeadline } = await import('../src/app/decisionPipeline.ts');
    const { AbortReason } = await import('../src/app/decisionPipeline.ts');

    const prior = uniformRange(TEST_PROV);
    assert.equal(prior.ok, true);
    if (!prior.ok) return;

    const mc = fakeClock();
    const deadline = new DecisionDeadline({ clock: mc.clock, mode: DeadlineMode.TEST, softMs: 10, hardMs: 20 });
    mc.advance(50); // 一开始就已超时

    const likelihoods = new Map<string, number>();
    for (const entry of prior.value.entries) likelihoods.set(entry.combo.canonicalId, 0.5);
    const model = makeActionModel('BET', likelihoods, TEST_PROV);

    const probe = assertStageRespectsDeadline(
      (ctx) => {
        // 阶段实现：把 ctx 转成 RangeClock，若预算不足则主动中止
        const clock: RangeClock = {
          remainingMs: () => ctx.remainingMs(),
          isAborted: () => ctx.isAborted(),
          isExpired: () => ctx.isExpired(),
          canAfford: (cost) => ctx.canAfford(cost),
          snapshot: () => ({ elapsedMs: Math.round(ctx.deadline.elapsedMs()), remainingMs: Math.round(ctx.remainingMs()) }),
        };
        const result = updateRange(prior.value, model, PREFLOP_CONTEXT, { clock });
        if (!result.ok && result.code === RangeErrorCode.RANGE_DEADLINE_EXCEEDED) {
          return { aborted: { stage: PipelineStage.RANGE, reason: AbortReason.DEADLINE, params: result.params } };
        }
        return { ok: true };
      },
      { deadline, expectAbort: AbortReason.DEADLINE },
    );

    assert.equal(probe.aborted, true, '范围阶段必须能在超时预算下主动中止');
    assert.equal(probe.abort!.reason, AbortReason.DEADLINE);
  });

  it('通过 runPipeline 接入时，超时会被如实标记为跳过', () => {
    const prior = buildRange({ AA: 1, KK: 1 });
    const likelihoods = new Map<string, number>();
    for (const entry of prior.entries) likelihoods.set(entry.combo.canonicalId, 0.5);
    const model = makeActionModel('BET', likelihoods, TEST_PROV);

    const mc = fakeClock();
    const deadline = new DecisionDeadline({ clock: mc.clock, softMs: 3_000, hardMs: 8_000 });

    const result = runPipeline(
      {
        validator: () => {
          // 把预算耗尽到硬上限：之后所有阶段都不应再启动
          mc.advance(8_000);
          return { ok: true };
        },
        math: () => ({ potOdds: 0.25 }),
        range: (ctx) => {
          const clock: RangeClock = {
            remainingMs: () => ctx.remainingMs(),
            isAborted: () => ctx.isAborted(),
            isExpired: () => ctx.isExpired(),
            canAfford: (cost) => ctx.canAfford(cost),
            snapshot: () => ({ elapsedMs: 0, remainingMs: Math.round(ctx.remainingMs()) }),
          };
          const updated = updateRange(prior, model, PREFLOP_CONTEXT, { clock });
          if (!updated.ok && updated.code === RangeErrorCode.RANGE_DEADLINE_EXCEEDED) return undefined;
          return updated.ok ? updated.value.range : undefined;
        },
      },
      { deadline },
    );

    assert.equal(result.timedOut, true);
    assert.equal(result.complete, false);
    assert.ok(
      result.skipped.some((s) => s.stage === PipelineStage.RANGE),
      '未执行的范围阶段必须被记录',
    );
  });
});

/* ============================================================
 * 缓存（规范第三十七 / 三十八节）
 * ============================================================ */

describe('缓存 —— Key 完整性与防污染', () => {
  const baseKey = {
    rangeDataVersion: '1.0.0',
    tableSize: 6,
    position: 'UTG',
    stackBucket: '80-150BB',
    actionHistorySignature: 'RFI',
    betSizeBucket: 'STANDARD',
    deadCards: ['As', 'Kd'],
  };

  it('key 与死牌顺序无关（排序后拼接）', () => {
    const a = buildRangeCacheKey({ ...baseKey, deadCards: ['As', 'Kd'] });
    const b = buildRangeCacheKey({ ...baseKey, deadCards: ['Kd', 'As'] });
    assert.equal(a, b);
  });

  it('**死牌不同 → key 不同**（绝不允许错误命中）', () => {
    const a = buildRangeCacheKey({ ...baseKey, deadCards: ['As', 'Kd'] });
    const b = buildRangeCacheKey({ ...baseKey, deadCards: ['As', 'Kh'] });
    assert.notEqual(a, b, '不同死牌产生了相同缓存 key');
  });

  it('任意维度变化都会改变 key', () => {
    const changes: Array<Partial<typeof baseKey>> = [
      { rangeDataVersion: '2.0.0' },
      { tableSize: 9 },
      { position: 'BTN' },
      { stackBucket: '20-40BB' },
      { actionHistorySignature: 'RFI>CALL' },
      { betSizeBucket: 'LARGE' },
      { deadCards: ['As', 'Kd', 'Qh'] },
    ];
    const original = buildRangeCacheKey(baseKey);
    for (const change of changes) {
      const changed = buildRangeCacheKey({ ...baseKey, ...change });
      assert.notEqual(changed, original, `维度 ${JSON.stringify(change)} 未影响 key`);
    }
  });

  it('**拒绝数字索引形式的死牌**（混用会导致错误命中或永久未命中）', () => {
    assert.throws(
      () => buildRangeCacheKey({ ...baseKey, deadCards: [35] as unknown as string[] }),
      /必须用牌面字符串/,
    );
  });

  it('拒绝非法死牌表示与重复死牌', () => {
    assert.throws(() => buildRangeCacheKey({ ...baseKey, deadCards: ['AsX'] }), /非法死牌表示/);
    assert.throws(() => buildRangeCacheKey({ ...baseKey, deadCards: ['as'] }), /非法死牌表示/);
    assert.throws(() => buildRangeCacheKey({ ...baseKey, deadCards: ['As', 'As'] }), /死牌重复/);
  });

  it('缓存命中/未命中统计正确', () => {
    const cache = createRangeCache();
    const range = buildRange({ AA: 1 });
    const key = buildRangeCacheKey(baseKey);
    assert.equal(cache.get(key), undefined);
    cache.set(key, range);
    assert.equal(cache.get(key), range);
    const stats = cache.stats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
    assert.equal(stats.size, 1);
  });

  it('**缓存结果防污染：原文被冻结，cloneRange 提供可变副本**', () => {
    const cache = createRangeCache();
    const range = buildRange({ AA: 1, KK: 1 });
    const key = buildRangeCacheKey(baseKey);
    cache.set(key, range);

    const cached = cache.get(key)!;
    assert.equal(isFrozen(cached), true);
    assert.throws(() => {
      (cached.entries[0] as { probability: number }).probability = 0.5;
    }, TypeError);

    // 需要修改时走 cloneRange，且不影响缓存
    const copy = cloneRange(cached);
    (copy.entries[0] as { probability: number }).probability = 0.5;
    assert.notEqual(copy.entries[0]!.probability, cached.entries[0]!.probability);
    assert.equal(cache.get(key)!.entries[0]!.probability, range.entries[0]!.probability);
  });

  it('版本变化后 invalidateAll 清空并记录失效次数', () => {
    const cache = createRangeCache();
    cache.set(buildRangeCacheKey(baseKey), buildRange({ AA: 1 }));
    cache.set(buildRangeCacheKey({ ...baseKey, position: 'BTN' }), buildRange({ KK: 1 }));
    assert.equal(cache.stats().size, 2);
    cache.invalidateAll();
    assert.equal(cache.stats().size, 0);
    assert.equal(cache.stats().invalidated, 2);
  });

  it('maxEntries 上限生效（FIFO 淘汰）', () => {
    const cache = createRangeCache({ maxEntries: 2 });
    cache.set('a', buildRange({ AA: 1 }));
    cache.set('b', buildRange({ KK: 1 }));
    cache.set('c', buildRange({ QQ: 1 }));
    assert.equal(cache.stats().size, 2);
    assert.equal(cache.has('a'), false, '最旧条目应被淘汰');
    assert.equal(cache.has('c'), true);
  });
});

/* ============================================================
 * 来源与可信度（规范第十三 / 十四 / 五十六 / 五十七节）
 * ============================================================ */

describe('来源 —— 不把启发式冒充理论', () => {
  it('THEORY_SOURCE 必须 verified=true，否则报错', () => {
    const fake: RangeProvenance = {
      sourceId: 'fake.theory',
      sourceType: RangeSource.THEORY_SOURCE,
      version: '1.0.0',
      description: '自称理论来源但没有验证依据',
      verified: false,
      confidence: 0.9,
    };
    const issues = validateProvenance(fake);
    assert.ok(issues.length > 0);
    assert.ok(issues.some((i) => i.field === 'sourceType' && i.problem.includes('HEURISTIC')));
  });

  it('confidence 超过来源类型上限时报错', () => {
    const overconfident: RangeProvenance = {
      sourceId: 'heur.too.confident',
      sourceType: RangeSource.HEURISTIC,
      version: '1.0.0',
      description: '启发式范围',
      verified: false,
      confidence: 0.95,
    };
    const issues = validateProvenance(overconfident);
    assert.ok(issues.some((i) => i.field === 'confidence' && i.problem.includes('上限')));
  });

  it('TEST_ONLY 的 confidence 上限极低（0.1）', () => {
    const issues = validateProvenance({
      sourceId: 'test.x',
      sourceType: RangeSource.TEST_ONLY,
      version: '1.0.0',
      description: 'x',
      verified: false,
      confidence: 0.5,
    });
    assert.ok(issues.some((i) => i.field === 'confidence'));
  });

  it('缺少 sourceId / version / description 都报错', () => {
    const bare = validateProvenance({
      sourceId: '',
      sourceType: RangeSource.HEURISTIC,
      version: '',
      description: '',
      verified: false,
      confidence: 0.5,
    });
    assert.equal(bare.length, 3);
  });

  it('范围条目携带来源与可信度，可见于度量', () => {
    const range = buildRange({ AA: 1, KK: 1 });
    for (const entry of range.entries) {
      assert.equal(entry.source, RangeSource.TEST_ONLY);
      assert.equal(entry.confidence, TEST_PROV.confidence);
    }
    assert.ok(Math.abs(range.metrics.weightedConfidence - TEST_PROV.confidence) < 1e-12);
    assert.equal(range.metrics.minConfidence, TEST_PROV.confidence);
  });

  it('来源类型与 confidence 上限对应关系正确', () => {
    assert.ok(validateProvenance({ sourceId: 'a', sourceType: RangeSource.THEORY_SOURCE, version: '1', description: 'd', verified: true, confidence: 0.95 }).length === 0);
    assert.ok(validateProvenance({ sourceId: 'a', sourceType: RangeSource.HEURISTIC, version: '1', description: 'd', verified: false, confidence: 0.55 }).length === 0);
    assert.ok(validateProvenance({ sourceId: 'a', sourceType: RangeSource.FALLBACK, version: '1', description: 'd', verified: false, confidence: 0.25 }).length === 0);
  });
});

/* ============================================================
 * 校验器（规范第三十九 / 四十节）
 * ============================================================ */

describe('校验器 —— 覆盖全部检查项', () => {
  it('合法范围通过校验', () => {
    const range = buildRange({ AA: 1, AKs: 1, '72o': 1 });
    const result = validateRange(range);
    assert.equal(result.valid, true, JSON.stringify(result.violations));
  });

  it('assertValidRange 对合法范围不抛错，对非法范围抛错', () => {
    assert.doesNotThrow(() => assertValidRange(buildRange({ AA: 1 })));
    const broken = buildRange({ AA: 1 });
    const tampered = { ...broken, entries: [] };
    assert.throws(() => assertValidRange(tampered as Range), /校验失败/);
  });

  it('检测到死牌冲突', () => {
    const range = buildRange({ AA: 1 });
    const result = validateRange(range, { deadCards: deadCardsFrom(C('As')) });
    assert.ok(result.violationCodes.includes(RangeViolationCode.DEAD_CARD_COLLISION));
  });

  it('检测到归一化错误', () => {
    const range = buildRange({ AA: 1 });
    const tampered: Range = {
      ...range,
      entries: range.entries.map((e) => ({ ...e, probability: e.probability * 2 })),
    };
    const result = validateRange(tampered);
    assert.ok(result.violationCodes.includes(RangeViolationCode.NORMALIZATION_ERROR));
  });

  it('检测到重复 canonicalId', () => {
    const range = buildRange({ AA: 1 });
    const tampered: Range = { ...range, entries: [range.entries[0]!, range.entries[0]!] };
    const result = validateRange(tampered, { allowUnnormalized: true });
    assert.ok(result.violationCodes.includes(RangeViolationCode.DUPLICATE_CANONICAL_ID));
  });

  it('检测到概率越界（>1）', () => {
    const range = buildRange({ AA: 1 });
    const tampered: Range = {
      ...range,
      entries: range.entries.map((e, i) => ({ ...e, probability: i === 0 ? 1.5 : e.probability })),
    };
    const result = validateRange(tampered);
    assert.ok(result.violationCodes.includes(RangeViolationCode.PROBABILITY_OUT_OF_RANGE));
  });

  it('检测到负权重', () => {
    const range = buildRange({ AA: 1 });
    const tampered: Range = {
      ...range,
      entries: range.entries.map((e, i) => ({ ...e, rawWeight: i === 0 ? -1 : e.rawWeight })),
    };
    const result = validateRange(tampered);
    assert.ok(result.violationCodes.includes(RangeViolationCode.NEGATIVE_WEIGHT));
  });

  it('检测到 NaN 权重', () => {
    const range = buildRange({ AA: 1 });
    const tampered: Range = {
      ...range,
      entries: range.entries.map((e, i) => ({ ...e, rawWeight: i === 0 ? Number.NaN : e.rawWeight })),
    };
    const result = validateRange(tampered);
    assert.ok(result.violationCodes.includes(RangeViolationCode.NOT_FINITE));
  });

  it('检测到可信度越界', () => {
    const range = buildRange({ AA: 1 });
    const tampered: Range = {
      ...range,
      entries: range.entries.map((e) => ({ ...e, confidence: 1.5 })),
    };
    const result = validateRange(tampered);
    assert.ok(result.violationCodes.includes(RangeViolationCode.CONFIDENCE_OUT_OF_RANGE));
  });

  it('检测到可信度超过来源上限', () => {
    const range = buildRange({ AA: 1 }); // TEST_ONLY，上限 0.1
    const tampered: Range = {
      ...range,
      entries: range.entries.map((e) => ({ ...e, confidence: 0.9 })),
    };
    const result = validateRange(tampered);
    assert.ok(result.violationCodes.includes(RangeViolationCode.CONFIDENCE_EXCEEDS_SOURCE_CAP));
  });

  it('检测到空范围与 metrics 不一致', () => {
    const range = buildRange({ AA: 1 });
    const empty: Range = { ...range, entries: [] };
    const result = validateRange(empty);
    assert.ok(result.violationCodes.includes(RangeViolationCode.EMPTY_RANGE));

    const mismatched: Range = {
      ...range,
      metrics: { ...range.metrics, supportSize: 999 },
    };
    const result2 = validateRange(mismatched);
    assert.ok(result2.violationCodes.includes(RangeViolationCode.COLLAPSED_RANGE));
  });

  it('检测到非法来源元数据', () => {
    const range = buildRange({ AA: 1 });
    const tampered: Range = {
      ...range,
      provenance: { ...range.provenance, sourceId: '' },
    };
    const result = validateRange(tampered);
    assert.ok(result.violationCodes.includes(RangeViolationCode.INVALID_PROVENANCE));
  });
});

/* ============================================================
 * 动作模型（规范第二十四 / 二十五节）
 * ============================================================ */

describe('动作模型 —— 校验与完整性', () => {
  it('likelihood > 1 被拒绝', () => {
    const prior = buildRange({ AA: 1 });
    const likelihoods = new Map<string, number>();
    for (const entry of prior.entries) likelihoods.set(entry.combo.canonicalId, 1.5);
    const result = updateRange(prior, makeActionModel('BET', likelihoods, TEST_PROV), PREFLOP_CONTEXT);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, RangeErrorCode.RANGE_VALIDATION_FAILED);
  });

  it('likelihood < 0 被拒绝', () => {
    const prior = buildRange({ AA: 1 });
    const likelihoods = new Map<string, number>();
    for (const entry of prior.entries) likelihoods.set(entry.combo.canonicalId, -0.1);
    const result = updateRange(prior, makeActionModel('BET', likelihoods, TEST_PROV), PREFLOP_CONTEXT);
    assert.equal(result.ok, false);
  });

  it('NaN likelihood 被拒绝', () => {
    const prior = buildRange({ AA: 1 });
    const likelihoods = new Map<string, number>();
    for (const entry of prior.entries) likelihoods.set(entry.combo.canonicalId, Number.NaN);
    const result = updateRange(prior, makeActionModel('BET', likelihoods, TEST_PROV), PREFLOP_CONTEXT);
    assert.equal(result.ok, false);
  });

  it('不在先验范围内的 comboId 被拒绝（避免似然无处安放）', () => {
    const prior = buildRange({ AA: 1 });
    const model = makeActionModel('BET', new Map([['KsKd', 0.5]]), TEST_PROV);
    const issues = validateActionModel(model, prior);
    assert.ok(issues.some((i) => i.problem.includes('不在先验范围内')));
  });

  it('动作频率总和 = 1 时判定为完整模型', () => {
    const model = makeActionModel('BET', new Map([['AsAh', 0.6]]), TEST_PROV);
    const twoActions = {
      ...model,
      likelihoods: [
        ...model.likelihoods,
        { comboId: 'AsAh', action: 'CHECK' as const, likelihood: 0.4, source: RangeSource.TEST_ONLY, confidence: 0.05 },
      ],
    };
    const completeness = checkActionModelCompleteness(twoActions);
    assert.equal(completeness.complete, true, JSON.stringify(completeness.incompleteCombos));
  });

  it('动作频率总和 ≠ 1 时标记 PARTIAL_ACTION_MODEL', () => {
    const model = makeActionModel('BET', new Map([['AsAh', 0.6]]), TEST_PROV);
    assert.equal(model.complete, false);
    assert.ok(model.completenessNote?.includes('PARTIAL_ACTION_MODEL'), model.completenessNote);
  });

  it('同一 combo 重复声明同一动作被拒绝', () => {
    const prior = buildRange({ AA: 1 });
    const model = {
      likelihoods: [
        { comboId: prior.entries[0]!.combo.canonicalId, action: 'BET' as const, likelihood: 0.5, source: RangeSource.TEST_ONLY, confidence: 0.05 },
        { comboId: prior.entries[0]!.combo.canonicalId, action: 'BET' as const, likelihood: 0.5, source: RangeSource.TEST_ONLY, confidence: 0.05 },
      ],
      complete: true,
      provenance: TEST_PROV,
    };
    const issues = validateActionModel(model, prior);
    assert.ok(issues.some((i) => i.problem.includes('重复声明')));
  });
});

/* ============================================================
 * 变更度量
 * ============================================================ */

describe('变更度量 —— 范围收窄程度', () => {
  it('分布未变时收窄程度为 0', () => {
    const range = buildRange({ AA: 1, KK: 1 });
    assert.ok(narrowingRatio(range, range) < 1e-9);
  });

  it('分布变化越大，收窄程度越高', () => {
    const prior = buildRange({ AA: 1, KK: 1, QQ: 1, '72o': 1 });

    const mild = (() => {
      const likelihoods = new Map<string, number>();
      for (const entry of prior.entries) likelihoods.set(entry.combo.canonicalId, 0.5);
      const result = updateRange(prior, makeActionModel('BET', likelihoods, TEST_PROV), PREFLOP_CONTEXT);
      assert.equal(result.ok, true);
      return result.ok ? result.value.range : prior;
    })();

    const strong = (() => {
      const likelihoods = new Map<string, number>();
      for (const entry of prior.entries) {
        likelihoods.set(entry.combo.canonicalId, entry.combo.rankClass === 'AA' ? 0.99 : 0.01);
      }
      const result = updateRange(prior, makeActionModel('BET', likelihoods, TEST_PROV), PREFLOP_CONTEXT);
      assert.equal(result.ok, true);
      return result.ok ? result.value.range : prior;
    })();

    assert.ok(narrowingRatio(prior, strong) > narrowingRatio(prior, mild));
  });

  it('diffRanges 摘要字段完整', () => {
    const prior = buildRange({ AA: 1, '72o': 1 });
    const likelihoods = new Map<string, number>();
    for (const entry of prior.entries) {
      likelihoods.set(entry.combo.canonicalId, entry.combo.rankClass === 'AA' ? 0.9 : 0.1);
    }
    const result = updateRange(prior, makeActionModel('RAISE', likelihoods, TEST_PROV), PREFLOP_CONTEXT);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const summary = diffRanges(prior, result.value.range, 5);
    assert.equal(summary.supportSizeBefore, prior.metrics.supportSize);
    assert.equal(summary.supportSizeAfter, result.value.range.metrics.supportSize);
    assert.ok(summary.topIncreases.length > 0);
    assert.ok(summary.topDecreases.length > 0);
    // 上升项的 delta 必须为正，下降项必须为负
    for (const e of summary.topIncreases) assert.ok(e.delta > 0);
    for (const e of summary.topDecreases) assert.ok(e.delta < 0);
  });

  it('describeRangeMetrics 输出中文摘要', () => {
    const text = describeRangeMetrics(buildRange({ AA: 1, KK: 1 }).metrics);
    assert.ok(text.includes('有效组合'));
    assert.ok(text.includes('熵'));
    assert.equal(/[A-Za-z]{3,}/.test(text.replace(/bit/g, '')), false, `含英文：${text}`);
  });
});

/* ============================================================
 * 属性测试（规范第四十七节）
 * ============================================================ */

describe('属性测试 —— 1000 组随机范围', () => {
  it('归一化 / blocker / update / 不可变性 全部保持不变量', () => {
    const rng = mulberry32(20260202);
    const classes = ALL_RANK_CLASSES;

    for (let round = 0; round < 1000; round++) {
      // ---- 随机选 3~20 个类别与权重 ----
      const count = 3 + Math.floor(rng() * 18);
      const weights: Record<string, number> = {};
      for (let i = 0; i < count; i++) {
        const cls = classes[Math.floor(rng() * classes.length)]!;
        weights[cls] = rng() * 2 + 0.01;
      }

      // ---- 随机死牌 0~5 张（可能互相重复，去重后判断） ----
      const deadCount = Math.floor(rng() * 6);
      const dead: Card[] = [];
      for (let i = 0; i < deadCount; i++) {
        const suit = ALL_SUITS[Math.floor(rng() * 4)]!;
        const rank = 2 + Math.floor(rng() * 13);
        const card: Card = { rank: rank as Card['rank'], suit };
        if (!dead.some((x) => x.rank === card.rank && x.suit === card.suit)) dead.push(card);
      }

      const built = buildRangeFromRankClasses(weights, {
        provenance: TEST_PROV,
        deadCards: dead,
        rangeIdPrefix: 'prop',
      });

      // 若全部组合都被死牌封死，构建应失败（不是静默返回空范围）
      if (!built.ok) {
        assert.equal(built.code, RangeErrorCode.RANGE_COLLAPSE, `第 ${round} 轮意外失败：${built.code}`);
        continue;
      }
      const range = built.value;

      // ---- 不变量 1：归一化 ----
      assert.ok(
        isNormalized(range.metrics.probabilitySum),
        `第 ${round} 轮 Σp=${range.metrics.probabilitySum}`,
      );
      // ---- 不变量 2：概率合法 ----
      for (const entry of range.entries) {
        assert.ok(Number.isFinite(entry.probability) && entry.probability >= 0 && entry.probability <= 1);
        assert.ok(Number.isFinite(entry.rawWeight) && entry.rawWeight >= 0);
      }
      // ---- 不变量 3：无死牌冲突 ----
      const deadSet = deadCardsFrom(dead);
      for (const entry of range.entries) {
        assert.equal(isBlocked(entry.combo, deadSet), false, `第 ${round} 轮含死牌组合`);
      }
      // ---- 不变量 4：校验器通过 ----
      const validation = validateRange(range, { deadCards: deadSet });
      assert.equal(validation.valid, true, `第 ${round} 轮校验失败：${JSON.stringify(validation.violations)}`);
      // ---- 不变量 5：不可变 ----
      assert.equal(isFrozen(range), true);

      // ---- 随机一次更新 ----
      const snapshot = JSON.stringify(range.entries.map((e) => e.probability));
      const likelihoods = new Map<string, number>();
      for (const entry of range.entries) likelihoods.set(entry.combo.canonicalId, rng());

      const updated = updateRange(
        range,
        makeActionModel('BET', likelihoods, TEST_PROV),
        PREFLOP_CONTEXT,
        { clock: UNBOUNDED_CLOCK, withDiff: false },
      );

      if (!updated.ok) {
        assert.ok(
          updated.code === RangeErrorCode.RANGE_COLLAPSE ||
            updated.code === RangeErrorCode.RANGE_VALIDATION_FAILED,
          `第 ${round} 轮更新意外失败：${updated.code}`,
        );
      } else {
        assert.ok(isNormalized(updated.value.range.metrics.probabilitySum));
        assert.equal(validateRange(updated.value.range).valid, true);
        assert.equal(updated.value.range.previousRangeId, range.rangeId);
      }

      // ---- 不变量 6：先验绝不被污染 ----
      assert.equal(
        JSON.stringify(range.entries.map((e) => e.probability)),
        snapshot,
        `第 ${round} 轮先验范围被修改`,
      );
    }
  });

  it('属性：均匀范围的熵恒为 log2(组合数)', () => {
    const rng = mulberry32(31337);
    for (let round = 0; round < 50; round++) {
      const cls = ALL_RANK_CLASSES[Math.floor(rng() * ALL_RANK_CLASSES.length)]!;
      const range = buildRange({ [cls]: 1 });
      const n = range.entries.length;
      assert.ok(
        Math.abs(range.metrics.entropyBits - Math.log2(n)) < 1e-9,
        `${cls} 熵应为 log2(${n})，实际 ${range.metrics.entropyBits}`,
      );
    }
  });
});

/* ============================================================
 * 与管线的集成
 * ============================================================ */

describe('与决策管线集成', () => {
  it('范围阶段可作为管线的一环，耗时被记录', () => {
    const prior = buildRange({ AA: 1, KK: 1, '72o': 1 });
    const likelihoods = new Map<string, number>();
    for (const entry of prior.entries) {
      likelihoods.set(entry.combo.canonicalId, entry.combo.rankClass === 'AA' ? 0.9 : 0.3);
    }
    const model = makeActionModel('RAISE', likelihoods, TEST_PROV);

    const result = runPipeline({
      validator: () => ({ blocked: false }),
      math: () => ({ potOdds: 0.25 }),
      range: (ctx) => {
        const clock: RangeClock = {
          remainingMs: () => ctx.remainingMs(),
          isAborted: () => ctx.isAborted(),
          isExpired: () => ctx.isExpired(),
          canAfford: (cost) => ctx.canAfford(cost),
          snapshot: () => ({ elapsedMs: 0, remainingMs: Math.round(ctx.remainingMs()) }),
        };
        const updated = updateRange(prior, model, PREFLOP_CONTEXT, { clock });
        return updated.ok ? updated.value : undefined;
      },
    });

    assert.equal(result.complete, true);
    assert.ok(result.outputs.has(PipelineStage.RANGE));
    assert.ok(result.timings.range >= 0);
    assert.ok(result.timings.total >= result.timings.range);
  });
});

/* ============================================================
 * 辅助
 * ============================================================ */


