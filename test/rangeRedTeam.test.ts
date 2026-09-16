/**
 * 范围引擎红队回归测试
 *
 * 本文件专门固化**独立红队审计发现并已修复的真实缺陷**。
 * 每一条都对应一次「运行完全正常但精确地算错」的事故，
 * 因此这些断言**永久不得放宽**。
 *
 * 报告：`reports/RANGE_REDTEAM_AUDIT.md`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_COMBOS, makeCombo, expandRankClass } from '../src/domain/range/combo.ts';
import { ALL_CARDS } from '../src/domain/types.ts';
import { cardIndex } from '../src/domain/poker/cards.ts';
import {
  RangeErrorCode,
  RangeSource,
  UNBOUNDED_CLOCK,
  type Range,
  type RangeProvenance,
  type RangeUpdateContext,
} from '../src/domain/range/range.types.ts';
import {
  buildRangeFromComboWeights,
  buildRangeFromRankClasses,
  entryOf,
  uniformRange,
} from '../src/domain/range/range.ts';
import {
  assessCoverage,
  makeActionModel,
  updateRange,
} from '../src/domain/range/rangeUpdate.ts';
import { deadCardsFrom } from '../src/domain/range/rangeBlockers.ts';
import { isFrozen, cloneRange, createRangeCache, buildRangeCacheKey } from '../src/domain/range/rangeCache.ts';
import {
  assertValidProvenance,
  confidenceCapFor,
  isKnownRangeSource,
  testOnlyProvenance,
  validateProvenance,
} from '../src/domain/range/rangeProvenance.ts';
import { assertValidRange, validateRange } from '../src/domain/range/rangeValidator.ts';
import { c, C } from './helpers.ts';

const TEST_PROV = testOnlyProvenance('redteam.range', '红队回归测试专用');

function build(classWeights: Record<string, number>, dead?: unknown): Range {
  const result = buildRangeFromRankClasses(classWeights, {
    provenance: TEST_PROV,
    ...(dead !== undefined ? { deadCards: dead } : {}),
    rangeIdPrefix: 'rt',
  });
  assert.equal(result.ok, true, `构建失败：${result.ok ? '' : JSON.stringify(result)}`);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

const CONTEXT: RangeUpdateContext = {
  street: 'FLOP',
  action: 'BET',
  actor: 'BTN',
  actionIndex: 1,
  activePlayerCount: 2,
};

/* ============================================================
 * CRITICAL-1：冻结必须覆盖全部层级
 * ============================================================ */

describe('红队 CRITICAL-1 —— 深冻结（combo 是模块级共享对象）', () => {
  it('组合宇宙中的组合与牌对象必须被冻结', () => {
    assert.equal(Object.isFrozen(ALL_COMBOS), true, 'ALL_COMBOS 数组未冻结');
    assert.equal(Object.isFrozen(ALL_COMBOS[0]), true, '组合对象未冻结');
    assert.equal(Object.isFrozen(ALL_COMBOS[0]!.card1), true, '组合引用的牌未冻结');
    assert.equal(Object.isFrozen(ALL_CARDS[0]), true, 'ALL_CARDS 的牌未冻结');
    assert.equal(Object.isFrozen(ALL_COMBOS[0]!.cardIndices), true, 'cardIndices 未冻结');
    assert.equal(Object.isFrozen(ALL_COMBOS[0]!.ranks), true, 'ranks 未冻结');
  });

  it('**一行类型安全的赋值不再能污染全局组合宇宙**', () => {
    const combo = ALL_COMBOS[0]!;
    // 红队原文：`range.entries[0].combo.canonicalId = 'ZZZZ'` 在 tsc --strict 下无需断言即可编译并成功
    assert.throws(() => {
      (combo as { canonicalId: string }).canonicalId = 'ZZZZ';
    }, TypeError, '改 canonicalId 竟然成功了 —— 全局组合宇宙被污染');

    // 改牌的点数会让 cardIndex 返回越界，该牌的死牌过滤永久失效
    assert.throws(() => {
      (combo.card1 as { rank: number }).rank = 99;
    }, TypeError);

    assert.throws(() => {
      (ALL_COMBOS as unknown as unknown[])[0] = combo;
    }, TypeError);
  });

  it('范围条目的 combo 也被冻结（改它等于污染所有已建范围）', () => {
    const range = build({ AA: 1 });
    const combo = range.entries[0]!.combo;
    assert.equal(Object.isFrozen(combo), true);
    assert.throws(() => {
      (combo as { canonicalId: string }).canonicalId = 'ZZZZ';
    }, TypeError);
  });

  it('isFrozen 必须检查到 combo 层（旧版只查到 entry 就返回 true）', () => {
    const range = build({ AA: 1 });
    assert.equal(isFrozen(range), true);
    // 构造一个「entry 冻结但 combo 未冻结」的对象，isFrozen 必须识破
    const fakeCombo = { ...range.entries[0]!.combo };
    const fakeRange = {
      ...range,
      entries: Object.freeze([Object.freeze({ ...range.entries[0]!, combo: fakeCombo })]),
    } as unknown as Range;
    assert.equal(isFrozen(fakeRange), false, 'isFrozen 未检查 combo 层');
  });

  it('indexById 必须是只读视图（运行时无 set/clear 可用）', () => {
    const range = build({ AA: 1 });
    const index = range.indexById as unknown as Record<string, unknown>;
    assert.equal(typeof index.get, 'function');
    assert.equal(typeof index.has, 'function');
    assert.equal(index.set, undefined, 'indexById 暴露了 set —— 可被静默改写');
    assert.equal(index.clear, undefined, 'indexById 暴露了 clear');
    assert.equal(index.delete, undefined, 'indexById 暴露了 delete');
    // AsAh 的字典序位置：AsAc < AsAd < AsAh → 下标 2（不是 0，entries 按 canonicalId 排序）
    const aaIndex = range.indexById.get('AsAh');
    assert.equal(typeof aaIndex, 'number');
    assert.equal(range.entries[aaIndex!]!.combo.canonicalId, 'AsAh');
    assert.equal(range.indexById.has('不存在'), false);
  });

  it('cloneRange 得到的副本可修改，且不影响原范围', () => {
    const range = build({ AA: 1, KK: 1 });
    const copy = cloneRange(range);
    (copy.entries[0] as { probability: number }).probability = 0.99;
    assert.notEqual(copy.entries[0]!.probability, range.entries[0]!.probability);
    assert.equal(copy.indexById.get(range.entries[0]!.combo.canonicalId), 0);
  });
});

/* ============================================================
 * MAJOR-2：部分动作模型不得被报成完整
 * ============================================================ */

describe('红队 MAJOR-2 —— 覆盖度必须如实报告', () => {
  it('**只覆盖 3/18 个组合时必须标出未覆盖，而不是 complete=true**', () => {
    const prior = build({ AA: 1, KK: 1, QQ: 1 });
    assert.equal(prior.entries.length, 18, 'AA/KK/QQ 各 6 个 = 18');

    // 只给其中 3 个组合声明似然
    const partial = new Map<string, number>();
    for (const entry of prior.entries.slice(0, 3)) {
      partial.set(entry.combo.canonicalId, 1);
    }
    const model = makeActionModel('BET', partial, TEST_PROV);

    const coverage = assessCoverage(model, prior);
    assert.equal(coverage.priorSize, 18);
    assert.equal(coverage.declaredCount, 3);
    assert.equal(coverage.undeclaredCombos.length, 15, '必须指出 15 个未被声明的组合');
    assert.equal(coverage.fullyCovered, false);
    assert.ok(Math.abs(coverage.undeclaredRatio - 15 / 18) < 1e-12);

    // 更新本身允许发生（似然 0 是合法语义），但必须如实报告 support 收缩
    const result = updateRange(prior, model, CONTEXT, { clock: UNBOUNDED_CLOCK });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.coverage.fullyCovered, false);
    assert.equal(result.value.removals.byZeroLikelihood, 15);
    assert.equal(result.value.range.metrics.supportSize, 3, 'support 应从 18 收缩到 3');
    assert.equal(result.value.log.summary.supportSizeBefore, 18);
    assert.equal(result.value.log.summary.supportSizeAfter, 3);
  });

  it('requireFullCoverage=true 时未覆盖直接报 RANGE_PARTIAL_ACTION_MODEL', () => {
    const prior = build({ AA: 1, KK: 1 });
    const partial = new Map<string, number>();
    for (const entry of prior.entries.slice(0, 2)) partial.set(entry.combo.canonicalId, 1);
    const result = updateRange(prior, makeActionModel('BET', partial, TEST_PROV), CONTEXT, {
      clock: UNBOUNDED_CLOCK,
      requireFullCoverage: true,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, RangeErrorCode.RANGE_PARTIAL_ACTION_MODEL);
    assert.equal(result.params.declaredCount, 2);
    assert.equal(result.params.declaredCount, 2);
  });

  it('全覆盖时 fullyCovered = true 且不产生零似然移除', () => {
    const prior = build({ AA: 1, KK: 1 });
    const all = new Map<string, number>();
    for (const entry of prior.entries) all.set(entry.combo.canonicalId, 0.5);
    const result = updateRange(prior, makeActionModel('BET', all, TEST_PROV), CONTEXT, {
      clock: UNBOUNDED_CLOCK,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.coverage.fullyCovered, true);
    assert.equal(result.value.removals.byZeroLikelihood, 0);
    assert.equal(result.value.range.metrics.supportSize, prior.metrics.supportSize);
  });

  it('**removedByBlockers 不再把「似然为 0」算进去**', () => {
    const prior = build({ AA: 1, KK: 1, QQ: 1 });
    // 无死牌，但只声明 3 个组合 → 旧版会把 15 个「似然为 0」误报成 removedByBlockers=15
    const partial = new Map<string, number>();
    for (const entry of prior.entries.slice(0, 3)) partial.set(entry.combo.canonicalId, 1);
    const result = updateRange(prior, makeActionModel('BET', partial, TEST_PROV), CONTEXT, {
      clock: UNBOUNDED_CLOCK,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.log.summary.removedByBlockers, 0, '没有死牌就不该报 blocker 移除');
    assert.equal(result.value.log.summary.removedByZeroLikelihood, 15);
    assert.equal(result.value.log.summary.removedTotal, 15);
    assert.equal(result.value.removals.byDeadCards, 0);
  });
});

/* ============================================================
 * MAJOR-3：更新路径必须有死牌重过滤
 * ============================================================ */

describe('红队 MAJOR-3 —— updateRange 必须支持本街死牌', () => {
  it('**传入翻牌后不得残留与翻牌冲突的组合**', () => {
    const prior = build({ AA: 1, KK: 1, QQ: 1, AKs: 1, '72o': 1 });
    const flop = C('Qh 9s 4c');

    const all = new Map<string, number>();
    for (const entry of prior.entries) all.set(entry.combo.canonicalId, 0.5);

    const result = updateRange(prior, makeActionModel('BET', all, TEST_PROV), CONTEXT, {
      clock: UNBOUNDED_CLOCK,
      deadCards: flop,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // 结果中不得含任何与翻牌冲突的组合
    const dead = deadCardsFrom([...C('Qh 9s 4c')]);
    for (const entry of result.value.range.entries) {
      const [i1, i2] = entry.combo.cardIndices;
      assert.equal(dead.has(i1) || dead.has(i2), false, `残留冲突组合 ${entry.combo.canonicalId}`);
    }
    assert.ok(result.value.removals.byDeadCards > 0, '应报告被死牌移除的数量');
    assert.equal(
      result.value.log.summary.removedByBlockers,
      result.value.removals.byDeadCards,
      '日志与结果里的 blocker 移除数必须一致',
    );

    // 整范围校验必须通过（不得有 DEAD_CARD_COLLISION）
    const validation = validateRange(result.value.range, { deadCards: dead });
    assert.equal(validation.valid, true, JSON.stringify(validation.violations));
  });

  it('死牌移除后仍然归一化（顺序符合规范第十一节）', () => {
    const prior = build({ AA: 1, KK: 1, QQ: 1 });
    const all = new Map<string, number>();
    for (const entry of prior.entries) all.set(entry.combo.canonicalId, 0.5);
    const result = updateRange(prior, makeActionModel('BET', all, TEST_PROV), CONTEXT, {
      clock: UNBOUNDED_CLOCK,
      deadCards: C('Qh 9s 4c'),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(Math.abs(result.value.range.metrics.probabilitySum - 1) < 1e-9);
  });

  it('全部组合都被死牌封死 → RANGE_COLLAPSE（不是空范围）', () => {
    const prior = build({ AA: 1 });
    const all = new Map<string, number>();
    for (const entry of prior.entries) all.set(entry.combo.canonicalId, 0.5);
    // 用 AA 的全部 4 张 A 作死牌
    const result = updateRange(prior, makeActionModel('BET', all, TEST_PROV), CONTEXT, {
      clock: UNBOUNDED_CLOCK,
      deadCards: C('As Ah Ad Ac'),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, RangeErrorCode.RANGE_COLLAPSE);
  });
});

/* ============================================================
 * MAJOR-4：死牌表示必须严格校验
 * ============================================================ */

describe('红队 MAJOR-4 —— 非法死牌表示必须报错，不得静默失效', () => {
  it('**Set<string> 形式的死牌不再被静默忽略**', () => {
    // 旧版：new Set(['As','Kd']) 被当作「合法的索引集合」，于是死牌完全没生效（1326 而非 1225）
    const dead = deadCardsFrom(new Set(['As', 'Kd']));
    assert.equal(dead.size, 2);
    const range = build({ AA: 1, KK: 1 }, dead);
    // AA 里含 A♠ 的 3 个 + KK 里含 K♦ 的 3 个被移除
    assert.equal(range.entries.length, 6);
  });

  it('大小写不同的花色被规范化，而不是让 cardIndex 返回 -1', () => {
    // 旧版：{rank:14, suit:'S'} → cardIndex 返回 -1 → 死牌过滤静默失效
    const dead = deadCardsFrom([{ rank: 14, suit: 'S' }]);
    assert.equal(dead.size, 1, '大写花色必须被规范化');
    // 索引布局是「花色外层（s/h/d/c）、点数内层」，因此 A♠ = 0*13 + 12 = 12
    assert.equal(dead.has(12), true, 'A♠ 的索引应为 12');
    assert.equal(deadCardsFrom([0]).has(0), true, '索引 0 对应 2♠');
  });

  it('越界索引必须抛错', () => {
    assert.throws(() => deadCardsFrom(new Set([99])), /索引越界/);
    assert.throws(() => deadCardsFrom(new Set([-3])), /索引越界/);
  });

  it('非法牌面字符串必须抛错', () => {
    assert.throws(() => deadCardsFrom(new Set(['Zz'])), /无法解析死牌/);
    assert.throws(() => deadCardsFrom(['As', 'nope']), /无法解析死牌/);
  });

  it('对象缺字段必须抛错', () => {
    assert.throws(() => deadCardsFrom([{ rank: 14 }]), /必须含 rank 与 suit/);
    assert.throws(() => deadCardsFrom([{ rank: 99, suit: 's' }]), /点数必须是 2\.\.14/);
  });

  it('三种合法表示互相等价（索引 / 牌面字符串 / 牌对象）', () => {
    // 索引一律由 cardIndex 推导，绝不硬编码 —— 避免「测试写死了一个错的索引」
    const aceSpadesIndex = cardIndex(c('As'));
    const byIndex = deadCardsFrom([aceSpadesIndex]);
    const byToken = deadCardsFrom(['As']);
    const byObject = deadCardsFrom([c('As')]);
    assert.deepEqual([...byIndex], [aceSpadesIndex]);
    assert.deepEqual([...byToken], [aceSpadesIndex], '牌面字符串 "As" 必须与 cardIndex(A♠) 一致');
    assert.deepEqual([...byObject], [aceSpadesIndex]);
  });

  it('大小写与空白被规范化，同一张牌只有一种索引', () => {
    const expected = cardIndex(c('As'));
    for (const token of ['As', 'as', 'AS', 'a s'.replace(' ', '')]) {
      assert.deepEqual([...deadCardsFrom([token])], [expected], `「${token}」未规范化到同一索引`);
    }
  });

  it('容量仍然正确：Hero 两张 → 1225', () => {
    const range = uniformRange(TEST_PROV, C('As Kd'));
    assert.equal(range.ok, true);
    if (!range.ok) return;
    assert.equal(range.value.entries.length, 1225);
  });
});

/* ============================================================
 * MAJOR-5：来源与置信度不可绕过
 * ============================================================ */

describe('红队 MAJOR-5 —— 构建入口必须校验来源', () => {
  it('未验证的 THEORY_SOURCE 在构建时就被拒绝', () => {
    const fake: RangeProvenance = {
      sourceId: 'fake.theory',
      sourceType: RangeSource.THEORY_SOURCE,
      version: '1.0.0',
      description: '没有 solver 却自称理论来源',
      verified: false,
      confidence: 0.95,
    };
    assert.throws(
      () => buildRangeFromRankClasses({ AA: 1 }, { provenance: fake }),
      /THEORY_SOURCE 必须 verified=true/,
    );
    assert.throws(
      () => buildRangeFromComboWeights(new Map([['AsAh', 1]]), { provenance: fake }),
      /THEORY_SOURCE 必须 verified=true/,
    );
    assert.throws(() => assertValidProvenance(fake), /THEORY_SOURCE/);
  });

  it('启发式来源不得声称高可信（构建时即拒绝）', () => {
    const overconfident: RangeProvenance = {
      sourceId: 'heur.over',
      sourceType: RangeSource.HEURISTIC,
      version: '1.0.0',
      description: '启发式但声称 95% 可信',
      verified: false,
      confidence: 0.95,
    };
    assert.throws(() => buildRangeFromRankClasses({ AA: 1 }, { provenance: overconfident }), /上限/);
  });

  it('**未知来源类型不得绕过置信度上限**（旧版 NaN 比较恒 false）', () => {
    const bogus = {
      sourceId: 'bogus',
      sourceType: 'GTO_SOLVER' as unknown as RangeSource,
      version: '1.0.0',
      description: '未登记的来源类型',
      verified: false,
      confidence: 1,
    };
    const issues = validateProvenance(bogus);
    assert.ok(issues.length > 0, '未知来源类型必须报错');
    assert.ok(issues.some((i) => i.field === 'sourceType' && i.problem.includes('未知的来源类型')));
    assert.equal(isKnownRangeSource('GTO_SOLVER'), false);
    assert.equal(confidenceCapFor('GTO_SOLVER' as RangeSource), 0, '未知来源的上限必须是 0');
  });

  it('confidence 越界（> 1）必须被拒绝', () => {
    const issues = validateProvenance({
      sourceId: 'x',
      sourceType: RangeSource.TEST_ONLY,
      version: '1',
      description: 'd',
      verified: false,
      confidence: 2,
    });
    assert.ok(issues.some((i) => i.field === 'confidence'));
  });

  it('合法来源可以通过', () => {
    assert.doesNotThrow(() =>
      assertValidProvenance({
        sourceId: 'ok.heur',
        sourceType: RangeSource.HEURISTIC,
        version: '1.0.0',
        description: '启发式范围',
        verified: false,
        confidence: 0.5,
      }),
    );
  });
});

/* ============================================================
 * MINOR：中止必须留下审计痕迹
 * ============================================================ */

describe('红队 MINOR —— 中止事件必须有审计信息', () => {
  it('RANGE_DEADLINE_EXCEEDED 携带 action / actor / street', () => {
    const prior = build({ AA: 1, KK: 1 });
    const all = new Map<string, number>();
    for (const entry of prior.entries) all.set(entry.combo.canonicalId, 0.5);
    const exhausted = {
      remainingMs: () => 0,
      isAborted: () => false,
      isExpired: () => true,
      canAfford: () => false,
      snapshot: () => ({ elapsedMs: 8_000, remainingMs: 0 }),
    };
    const result = updateRange(prior, makeActionModel('BET', all, TEST_PROV), CONTEXT, {
      clock: exhausted,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, RangeErrorCode.RANGE_DEADLINE_EXCEEDED);
    assert.equal(result.params.action, 'BET');
    assert.equal(result.params.actor, 'BTN');
    assert.equal(result.params.street, 'FLOP');
  });
});

/* ============================================================
 * 综合：修复后仍保持原有正确性
 * ============================================================ */

describe('红队回归 —— 修复未破坏原有不变量', () => {
  it('正常路径：贝叶斯方向、归一化、不可变性全部保持', () => {
    const prior = build({ AA: 1, KK: 1, '72o': 1 });
    const foldModel = new Map<string, number>();
    for (const entry of prior.entries) {
      foldModel.set(entry.combo.canonicalId, entry.combo.rankClass === 'AA' ? 0.05 : 0.95);
    }
    const result = updateRange(prior, makeActionModel('FOLD', foldModel, TEST_PROV), {
      ...CONTEXT,
      action: 'FOLD',
    }, { clock: UNBOUNDED_CLOCK });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    let aa = 0;
    let trash = 0;
    for (const entry of result.value.range.entries) {
      if (entry.combo.rankClass === 'AA') aa += entry.probability;
      if (entry.combo.rankClass === '72o') trash += entry.probability;
    }
    assert.ok(trash > aa, '弃牌后弱牌概率必须高于强牌');
    assert.ok(Math.abs(result.value.range.metrics.probabilitySum - 1) < 1e-9);
    assert.equal(validateRange(result.value.range).valid, true);
    assert.equal(isFrozen(result.value.range), true);
    assert.doesNotThrow(() => assertValidRange(result.value.range));
  });

  it('缓存返回的范围仍是深冻结的', () => {
    const cache = createRangeCache();
    const range = build({ AA: 1, KK: 1 });
    const key = buildRangeCacheKey({
      rangeDataVersion: '1',
      tableSize: 6,
      position: 'BTN',
      stackBucket: 'a',
      actionHistorySignature: 'b',
      betSizeBucket: 'c',
      deadCards: [],
    });
    cache.set(key, range);
    const cached = cache.get(key)!;
    assert.equal(isFrozen(cached), true);
    assert.throws(() => {
      (cached.entries[0]!.combo as { canonicalId: string }).canonicalId = 'ZZZZ';
    }, TypeError);
  });

  it('makeCombo 拒绝非法牌（花色大写不再让索引变成 -1）', () => {
    assert.throws(
      () => makeCombo({ rank: 14, suit: 'S' as never }, { rank: 13, suit: 'd' }),
      /牌面不合法/,
    );
    assert.throws(
      () => makeCombo({ rank: 99 as never, suit: 's' }, { rank: 13, suit: 'd' }),
      /牌面不合法/,
    );
  });

  it('expandedRankClass 与 ALL_COMBOS 仍然一致（冻结未破坏构造）', () => {
    assert.equal(ALL_COMBOS.length, 1326);
    assert.equal(expandRankClass('AA').length, 6);
    const range = build({ AKs: 1 });
    assert.ok(entryOf(range, 'AsKs'));
  });
});
