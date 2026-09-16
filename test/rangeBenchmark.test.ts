/**
 * 范围引擎性能基准（规范第三十四 / 五十三 / 五十四节）
 *
 * ⚠️ 设计原则（规范第五十四条）：**禁止用脆弱的时间断言制造假失败**。
 * CI 机器速度差异极大，因此：
 * - 性能断言使用**宽裕上限**（真实耗时通常低 1~2 个数量级）
 * - 精度报告（P50 / P95 / Max）在测试中输出，供人工审阅
 * - 真正严格的是「Deadline 逻辑」的单元测试（见 range.test.ts），那是确定性的
 *
 * 软目标（规范第三十四节）：
 *   范围初始化 < 50ms ｜ 一次动作更新 < 50ms ｜ 复杂多人 < 150ms
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_COMBOS,
  ALL_RANK_CLASSES,
} from '../src/domain/range/combo.ts';
import { UNBOUNDED_CLOCK, RangeSource } from '../src/domain/range/range.types.ts';
import type { Range, RangeProvenance, RangeUpdateContext } from '../src/domain/range/range.types.ts';
import {
  buildRangeFromRankClasses,
  uniformRange,
} from '../src/domain/range/range.ts';
import { makeActionModel, updateRange } from '../src/domain/range/rangeUpdate.ts';
import { deadCardsFrom, removeBlockedCombos } from '../src/domain/range/rangeBlockers.ts';
import { probabilityMetrics } from '../src/domain/range/rangeNormalize.ts';
import { diffRanges } from '../src/domain/range/rangeMetrics.ts';
import {
  buildRangeCacheKey,
  createCachedResolver,
  createRangeCache,
} from '../src/domain/range/rangeCache.ts';
import { testOnlyProvenance } from '../src/domain/range/rangeProvenance.ts';
import { mulberry32 } from '../src/infra/rng.ts';
import { C } from './helpers.ts';

/* ============================================================
 * 基准工具
 * ============================================================ */

const TEST_PROV = testOnlyProvenance('bench.range', '性能基准用');

type Stats = {
  name: string;
  samples: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
};

function measure(name: string, runs: number, fn: () => void): Stats {
  const samples: number[] = [];
  // 预热一次，避免 JIT 与首次分配影响
  fn();
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const pick = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]!;
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  return {
    name,
    samples: runs,
    p50: pick(0.5),
    p95: pick(0.95),
    max: samples[samples.length - 1]!,
    mean,
  };
}

function report(stats: Stats, softTargetMs: number): void {
  const flag = stats.p95 <= softTargetMs ? '✅' : '⚠️';
  console.log(
    `  ${flag} ${stats.name.padEnd(34)} ` +
      `P50 ${stats.p50.toFixed(3)}ms  P95 ${stats.p95.toFixed(3)}ms  ` +
      `Max ${stats.max.toFixed(3)}ms  （软目标 ${softTargetMs}ms）`,
  );
}

/* ============================================================
 * 夹具
 * ============================================================ */

const BIG_RANGE_CLASSES: Record<string, number> = (() => {
  // 一个接近真实的宽范围：约 25% 的起手牌
  const out: Record<string, number> = {};
  for (const cls of ALL_RANK_CLASSES) {
    // 用确定性规则挑一批类别，避免硬编码一长串
    const pair = cls.length === 2;
    const high = cls[0]!;
    if (pair && ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5'].includes(high)) out[cls] = 1;
    else if (!pair && ['A', 'K', 'Q'].includes(high)) out[cls] = 1;
    else if (!pair && high === 'J' && cls[1] === 'T') out[cls] = 1;
    else if (!pair && high === '9' && cls[1] === '8') out[cls] = 1;
  }
  return out;
})();

function buildBigRange(dead: readonly ReturnType<typeof C>[number][] = []): Range {
  const result = buildRangeFromRankClasses(BIG_RANGE_CLASSES, {
    provenance: TEST_PROV,
    deadCards: dead,
    rangeIdPrefix: 'bench',
  });
  if (!result.ok) throw new Error(`基准范围构建失败：${JSON.stringify(result)}`);
  return result.value;
}

const CONTEXT: RangeUpdateContext = {
  street: 'FLOP',
  action: 'BET',
  actor: 'BTN',
  actionIndex: 1,
  activePlayerCount: 2,
};

function makeModel(range: Range, seed = 1) {
  const rng = mulberry32(seed);
  const likelihoods = new Map<string, number>();
  for (const entry of range.entries) likelihoods.set(entry.combo.canonicalId, rng());
  return makeActionModel('BET', likelihoods, TEST_PROV);
}

/* ============================================================
 * 基准
 * ============================================================ */

describe('范围引擎性能基准（软目标，非脆弱断言）', () => {
  it('1326 组合初始化 + 各操作耗时（P50/P95/Max）', () => {
    console.log('\n=== 范围引擎性能（本机实测） ===');

    const fullRange = (() => {
      const r = uniformRange(TEST_PROV);
      if (!r.ok) throw new Error('uniformRange 失败');
      return r.value;
    })();

    const results: Stats[] = [];

    results.push(
      measure('遍历 1326 组合（universe scan）', 200, () => {
        let sum = 0;
        for (const combo of ALL_COMBOS) sum += combo.cardIndices[0];
        if (sum < 0) throw new Error('unreachable');
      }),
    );

    results.push(
      measure('全范围构建（1326 组合归一化）', 100, () => {
        uniformRange(TEST_PROV);
      }),
    );

    results.push(
      measure('Hero blocker 过滤（1225 剩）', 200, () => {
        removeBlockedCombos(ALL_COMBOS, deadCardsFrom(C('As Kd')));
      }),
    );

    results.push(
      measure('Flop blocker 过滤（1081 剩）', 200, () => {
        removeBlockedCombos(ALL_COMBOS, deadCardsFrom(C('As Kd Qh 9s 4c')));
      }),
    );

    const bigRange = buildBigRange();
    results.push(
      measure('宽范围构建（约 25% 起手牌）', 100, () => {
        buildBigRange();
      }),
    );

    const model = makeModel(bigRange);
    results.push(
      measure('一次贝叶斯更新（单挑上下文）', 200, () => {
        const r = updateRange(bigRange, model, CONTEXT, { clock: UNBOUNDED_CLOCK, withDiff: false });
        if (!r.ok) throw new Error('更新失败');
      }),
    );

    results.push(
      measure('一次贝叶斯更新（含 diff 摘要）', 200, () => {
        const r = updateRange(bigRange, model, CONTEXT, { clock: UNBOUNDED_CLOCK, withDiff: true });
        if (!r.ok) throw new Error('更新失败');
      }),
    );

    results.push(
      measure('4-way 上下文更新', 200, () => {
        const r = updateRange(
          bigRange,
          model,
          { ...CONTEXT, activePlayerCount: 4 },
          { clock: UNBOUNDED_CLOCK, withDiff: false },
        );
        if (!r.ok) throw new Error('更新失败');
      }),
    );

    results.push(
      measure('范围度量（熵 / 有效组合数）', 500, () => {
        probabilityMetrics(fullRange.entries.map((e) => e.probability));
      }),
    );

    // 缓存命中 / 未命中
    const cache = createRangeCache();
    const keyInput = {
      rangeDataVersion: '1.0.0',
      tableSize: 6,
      position: 'BTN',
      stackBucket: '80-150BB',
      actionHistorySignature: 'RFI',
      betSizeBucket: 'STANDARD',
      deadCards: ['As', 'Kd'],
    };
    const resolver = createCachedResolver(cache, () => bigRange);
    resolver.resolve(keyInput); // 预热缓存

    results.push(
      measure('缓存命中', 5000, () => {
        resolver.resolve(keyInput);
      }),
    );

    const missCache = createRangeCache({ maxEntries: 1 });
    let counter = 0;
    const missResolver = createCachedResolver(missCache, () => {
      counter++;
      return bigRange;
    });
    results.push(
      measure('缓存未命中（含工厂调用）', 500, () => {
        missResolver.resolve({ ...keyInput, position: `P${counter}` });
      }),
    );

    results.push(
      measure('缓存 Key 构造', 5000, () => {
        buildRangeCacheKey(keyInput);
      }),
    );

    const updated = updateRange(bigRange, model, CONTEXT, { clock: UNBOUNDED_CLOCK });
    if (updated.ok) {
      results.push(
        measure('变更摘要（diff）', 500, () => {
          diffRanges(bigRange, updated.value.range, 5);
        }),
      );
    }

    console.log('');
    for (const stats of results) report(stats, 50);

    // ---- 宽裕上限断言（规范第五十四条：不用脆弱的时间断言）----
    const find = (name: string): Stats => {
      const found = results.find((r) => r.name === name);
      assert.ok(found, `未找到基准项 ${name}`);
      return found!;
    };

    // 这些上限比实测值宽裕约 1~2 个数量级，只用于捕捉「数量级级别」的退化
    assert.ok(find('全范围构建（1326 组合归一化）').p95 < 1_000, '全范围构建 P95 超过 1 秒');
    assert.ok(find('Hero blocker 过滤（1225 剩）').p95 < 500, 'blocker 过滤 P95 超过 500ms');
    assert.ok(find('一次贝叶斯更新（单挑上下文）').p95 < 1_000, '贝叶斯更新 P95 超过 1 秒');
    assert.ok(find('一次贝叶斯更新（含 diff 摘要）').p95 < 1_500, '含 diff 更新 P95 超过 1.5 秒');
    assert.ok(find('4-way 上下文更新').p95 < 1_000, '4-way 更新 P95 超过 1 秒');
    assert.ok(find('缓存命中').p95 < 10, '缓存命中 P95 超过 10ms');
    assert.ok(find('范围度量（熵 / 有效组合数）').p95 < 200, '度量 P95 超过 200ms');
    assert.ok(find('变更摘要（diff）').p95 < 500, 'diff P95 超过 500ms');

    // 记录实际值供人工审阅（不参与断言）
    const softTargetMisses = results.filter((r) => r.p95 > 50);
    if (softTargetMisses.length > 0) {
      console.log(
        `\n  提示：以下项 P95 超过 50ms 软目标（不视为失败）：${softTargetMisses
          .map((r) => `${r.name}=${r.p95.toFixed(1)}ms`)
          .join('，')}`,
      );
    }
    console.log('');
  });

  it('缓存必须真正避免重复计算（确定性断言，不依赖计时）', () => {
    /**
     * 为什么不用「命中比未命中快 N 倍」来断言：
     * 那会把「缓存实现是否正确」与「本机计时抖动」绑在一起，
     * 而且当工厂函数本身极快时，两者的时间差会被测量噪声淹没 ——
     * 属于规范第五十四条明确反对的脆弱时间断言。
     *
     * 真正该断言的是**工厂被调用的次数**：这才是缓存的语义。
     */
    const cache = createRangeCache();
    const range = buildBigRange();
    const keyInput = {
      rangeDataVersion: '1.0.0',
      tableSize: 6,
      position: 'BTN',
      stackBucket: '80-150BB',
      actionHistorySignature: 'RFI',
      betSizeBucket: 'STANDARD',
      deadCards: [] as string[],
    };

    let factoryCalls = 0;
    const resolver = createCachedResolver(cache, () => {
      factoryCalls++;
      return range;
    });

    const first = resolver.resolve(keyInput);
    assert.equal(first.hit, false, '首次解析应为未命中');
    assert.equal(first.range, range);
    assert.equal(factoryCalls, 1);

    // 后续 100 次同 key 解析都不应再触发工厂
    for (let i = 0; i < 100; i++) {
      const again = resolver.resolve(keyInput);
      assert.equal(again.hit, true, `第 ${i + 2} 次解析应为命中`);
      assert.equal(again.range, range);
    }
    assert.equal(factoryCalls, 1, `工厂被调用了 ${factoryCalls} 次，缓存未生效`);

    // 换一个维度 → 未命中 → 工厂再被调用
    resolver.resolve({ ...keyInput, position: 'CO' });
    assert.equal(factoryCalls, 2, '不同 key 必须重新计算');
  });

  it('范围引擎的耗时与组合规模成正比（1326 全范围 vs 小范围）', () => {
    const small = (() => {
      const r = buildRangeFromRankClasses({ AA: 1, KK: 1 }, { provenance: TEST_PROV });
      if (!r.ok) throw new Error('构建失败');
      return r.value;
    })();
    const big = buildBigRange();

    const smallStats = measure('small', 300, () => {
      const r = updateRange(small, makeModel(small), CONTEXT, { clock: UNBOUNDED_CLOCK, withDiff: false });
      if (!r.ok) throw new Error('fail');
    });
    const bigStats = measure('big', 300, () => {
      const r = updateRange(big, makeModel(big), CONTEXT, { clock: UNBOUNDED_CLOCK, withDiff: false });
      if (!r.ok) throw new Error('fail');
    });

    // 大范围组合数远多于小范围，耗时应当更高（允许测量噪声，用 1.2 倍宽松阈值）
    assert.ok(
      bigStats.p50 > smallStats.p50 * 1.2,
      `大范围耗时应高于小范围：big=${bigStats.p50.toFixed(4)}ms，small=${smallStats.p50.toFixed(4)}ms`,
    );
  });
});

// RangeSource 在基准里作为类型标签保留，避免「导入未使用」告警
void RangeSource;
