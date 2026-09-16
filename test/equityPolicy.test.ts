/**
 * 权益选型策略测试（equityPolicy）与引擎拆分测试
 *
 * 覆盖规范第 10~14 节：算法选型、决策门槛提前停止、时间预算中止、收益递减。
 * 全部使用**假时钟**驱动，因此不需要真的等待若干秒。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NANOSECONDS_PER_MATCHUP,
  applyDeadlineToMethod,
  buildCapacity,
  confidenceHalfWidth,
  defaultDeadlineForMode,
  evaluateMonteCarloStop,
  exactEnumerationFitsDeadline,
} from '../src/domain/poker/equityPolicy.ts';
import {
  EquityComputeMode,
  EquityPolicyReason,
  EquityStopReason,
  combinationsCount,
} from '../src/domain/poker/equity.types.ts';
import { DecisionDeadline, DeadlineMode, type Clock } from '../src/app/decisionDeadline.ts';

function fakeClock(start = 0): { clock: Clock; advance: (ms: number) => void } {
  let current = start;
  return { clock: () => current, advance: (ms: number) => { current += ms; } };
}

describe('equityPolicy —— 算法选型', () => {
  it('河牌圈（公共牌已满）组合规模小 → 精确枚举', () => {
    const capacity = buildCapacity({
      combosPerOpponent: [1],
      knownCardCount: 8, // 我的 2 张 + 公共牌 5 张 + 对手 1 张（示例）
      boardCount: 5,
    });
    assert.equal(capacity.cardsToCome, 0);
    assert.equal(capacity.remainingDeckSize, 44);
    assert.equal(capacity.method, 'EXACT');
    assert.equal(capacity.methodReason, EquityPolicyReason.EXACT_WITHIN_BUDGET);
  });

  it('翻牌前对上一个宽范围 → 蒙特卡洛', () => {
    const capacity = buildCapacity({
      combosPerOpponent: [200],
      knownCardCount: 2,
      boardCount: 0,
    });
    assert.equal(capacity.method, 'MONTE_CARLO');
    assert.equal(capacity.methodReason, EquityPolicyReason.TOO_MANY_MATCHUPS);
    assert.ok(capacity.exactMatchupsBound > 100_000, `上界应远超预算：${capacity.exactMatchupsBound}`);
  });

  it('对局数上界 = 各对手组合数之积 × C(剩余牌数, 待发牌数)', () => {
    // 已知牌 5 张（我的 2 + 翻牌 3）→ 剩余 47 张；待发 2 张
    const capacity = buildCapacity({
      combosPerOpponent: [6, 4],
      knownCardCount: 5,
      boardCount: 3,
    });
    assert.equal(capacity.remainingDeckSize, 47);
    assert.equal(capacity.cardsToCome, 2);
    assert.equal(capacity.exactMatchupsBound, 6 * 4 * combinationsCount(47, 2));
  });

  it('forceMethod 优先级最高，并记录为「调用方强制」', () => {
    const capacity = buildCapacity(
      { combosPerOpponent: [200], knownCardCount: 2, boardCount: 0 },
      { forceMethod: 'EXACT' },
    );
    assert.equal(capacity.method, 'EXACT');
    assert.equal(capacity.methodReason, EquityPolicyReason.FORCED_BY_CALLER);
  });

  it('VERIFY 模式强制精确枚举（用于黄金测试与数学验证）', () => {
    const capacity = buildCapacity(
      { combosPerOpponent: [200], knownCardCount: 2, boardCount: 0 },
      { mode: EquityComputeMode.VERIFY },
    );
    assert.equal(capacity.method, 'EXACT');
    assert.equal(capacity.methodReason, EquityPolicyReason.VERIFY_MODE);
  });

  it('maxExactMatchups 可配置：调低后同样的输入改走蒙特卡洛', () => {
    const input = { combosPerOpponent: [6], knownCardCount: 5, boardCount: 3 };
    const generous = buildCapacity(input, { maxExactMatchups: 10_000_000 });
    const strict = buildCapacity(input, { maxExactMatchups: 10 });
    assert.equal(generous.method, 'EXACT');
    assert.equal(strict.method, 'MONTE_CARLO');
  });

  it('模式决定样本上限：高精度模式上限更高', () => {
    const input = { combosPerOpponent: [200], knownCardCount: 2, boardCount: 0 };
    const fast = buildCapacity(input, { mode: EquityComputeMode.FAST });
    const precision = buildCapacity(input, { mode: EquityComputeMode.PRECISION });
    assert.ok(precision.maxIterations > fast.maxIterations);
  });
});

describe('equityPolicy —— 时间预算对选型的影响', () => {
  it('精确枚举是否放得下：按剩余时间与单次成本估算', () => {
    const fc = fakeClock();
    const d = new DecisionDeadline({ clock: fc.clock, softMs: 3_000, hardMs: 8_000 });
    // 1,000,000 局 × 1.5 微秒 = 1500ms，放得下
    assert.equal(exactEnumerationFitsDeadline(1_000_000, d), true);
    // 10,000,000 局 × 1.5 微秒 = 15000ms，放不下
    assert.equal(exactEnumerationFitsDeadline(10_000_000, d), false);
    // 无 deadline 时不做限制（离线路径）
    assert.equal(exactEnumerationFitsDeadline(1e12, undefined), true);
  });

  it('AA vs KK 规模的枚举（约 1000 万局）在交互预算下会被降级为蒙特卡洛', () => {
    const fc = fakeClock();
    const d = new DecisionDeadline({ clock: fc.clock, softMs: 3_000, hardMs: 8_000 });
    const capacity = buildCapacity(
      { combosPerOpponent: [6], knownCardCount: 4, boardCount: 0 },
      { maxExactMatchups: Number.MAX_SAFE_INTEGER },
    );
    // 先确认容量判断确实选了精确枚举
    assert.equal(capacity.method, 'EXACT');
    assert.ok(capacity.exactMatchupsBound > 10_000_000);

    const adjusted = applyDeadlineToMethod(capacity, d);
    assert.equal(adjusted.method, 'MONTE_CARLO', '时间放不下时必须降级');
    // 必须是「因时间预算降级」而不是「规模本来就超预算」——两者原因不同，日志要能区分
    assert.equal(adjusted.methodReason, EquityPolicyReason.DOWNGRADED_BY_DEADLINE);
    // 降级不改变容量数据本身
    assert.equal(adjusted.exactMatchupsBound, capacity.exactMatchupsBound);
  });

  it('时间充裕时不会降级', () => {
    const fc = fakeClock();
    const d = new DecisionDeadline({ clock: fc.clock, softMs: 30_000, hardMs: 120_000 });
    const capacity = buildCapacity(
      { combosPerOpponent: [6], knownCardCount: 4, boardCount: 0 },
      { maxExactMatchups: Number.MAX_SAFE_INTEGER },
    );
    assert.equal(applyDeadlineToMethod(capacity, d).method, 'EXACT');
  });

  it('NANOSECONDS_PER_MATCHUP 必须是保守（偏大）的估计', () => {
    // 实测约 0.75 微秒/局（AA vs KK 翻牌前 10,273,824 局 ≈ 7.7 秒）；
    // 估计值应 ≥ 1 微秒，否则会乐观地选择精确枚举并可能超时。
    assert.ok(NANOSECONDS_PER_MATCHUP >= 1_000, `估计过小会低估耗时：${NANOSECONDS_PER_MATCHUP}`);
    assert.ok(NANOSECONDS_PER_MATCHUP <= 2_000, `估计过大会浪费预算：${NANOSECONDS_PER_MATCHUP}`);
  });
});

describe('equityPolicy —— 置信区间与收益递减', () => {
  it('95% 置信区间半宽 = 1.96 × √(p(1−p)/n)', () => {
    const half = confidenceHalfWidth(0.5, 10_000);
    const expected = 1.959963984540054 * Math.sqrt((0.5 * 0.5) / 10_000);
    assert.ok(Math.abs(half - expected) < 1e-12, `实际 ${half}，期望 ${expected}`);
  });

  it('样本为 0 时半宽为无穷大（不得据此下任何结论）', () => {
    assert.equal(confidenceHalfWidth(0.5, 0), Number.POSITIVE_INFINITY);
  });

  it('样本量越大半宽越小（单调）', () => {
    const a = confidenceHalfWidth(0.4, 1_000);
    const b = confidenceHalfWidth(0.4, 10_000);
    const c = confidenceHalfWidth(0.4, 100_000);
    assert.ok(a > b && b > c, `半宽未随样本下降：${a} / ${b} / ${c}`);
  });
});

describe('equityPolicy —— 三重提前停止检查', () => {
  const base = {
    equity: 0.42,
    total: 100_000,
    nextIterations: 250_000,
    diminishingReturnsThreshold: 0.1,
  };

  it('检查 1（门槛）：CI 完全在门槛之上 → 立即停止', () => {
    const decision = evaluateMonteCarloStop({ ...base, decisionThreshold: 0.27 });
    assert.equal(decision.shouldStop, true);
    assert.equal(decision.reason, EquityStopReason.CI_CLEARS_THRESHOLD);
    assert.equal(decision.params.side, 'ABOVE');
    assert.ok(Number(decision.params.lower) > 0.27);
  });

  it('检查 1（门槛）：CI 完全在门槛之下 → 立即停止（同样确定）', () => {
    const decision = evaluateMonteCarloStop({ ...base, decisionThreshold: 0.9 });
    assert.equal(decision.shouldStop, true);
    assert.equal(decision.reason, EquityStopReason.CI_CLEARS_THRESHOLD);
    assert.equal(decision.params.side, 'BELOW');
  });

  it('检查 1（门槛）：CI 跨越门槛 → 必须继续采样（规范第 14 条）', () => {
    // 权益 31% ± 约 1.6%，门槛 31% 落在区间中间
    const decision = evaluateMonteCarloStop({
      ...base,
      equity: 0.31,
      total: 5_000,
      nextIterations: 10_000,
      decisionThreshold: 0.31,
    });
    assert.equal(decision.shouldStop, false, '跨越门槛时不得停止');
    assert.equal(decision.reason, null);
  });

  it('检查 2（时间）：预算不足 → 停止并记录剩余毫秒', () => {
    const fc = fakeClock();
    const d = new DecisionDeadline({ clock: fc.clock, softMs: 3_000, hardMs: 8_000 });
    fc.advance(7_900);
    const decision = evaluateMonteCarloStop({
      ...base,
      decisionThreshold: undefined,
      deadline: d,
      estimatedNextRoundMs: 500,
    });
    assert.equal(decision.shouldStop, true);
    assert.equal(decision.reason, EquityStopReason.DEADLINE_REACHED);
    assert.ok(Number(decision.params.remainingMs) < 500);
  });

  it('检查 3（收益递减）：样本翻倍也动不了结论 → 停止', () => {
    // 权益 0.42、样本 250,000、下一级 500,000：
    // 半宽 ≈ 0.0019，翻倍后最多移动 0.0019 × (1 − 1/√2) ≈ 0.00057 ≈ 0.057 个百分点
    // 阈值设为 0.1 个百分点 → 应停止
    const decision = evaluateMonteCarloStop({
      equity: 0.42,
      total: 250_000,
      nextIterations: 500_000,
      diminishingReturnsThreshold: 0.1,
    });
    assert.equal(decision.shouldStop, true);
    assert.equal(decision.reason, EquityStopReason.DIMINISHING_RETURNS);
    assert.ok(Number(decision.params.maxMovementPct) < 0.1);
  });

  it('检查 3：样本还小、翻倍可能显著改变结论 → 不停', () => {
    const decision = evaluateMonteCarloStop({
      equity: 0.42,
      total: 1_000,
      nextIterations: 2_000,
      diminishingReturnsThreshold: 0.1,
    });
    assert.equal(decision.shouldStop, false);
  });

  it('无门槛、无 deadline、样本还小 → 继续采样', () => {
    const decision = evaluateMonteCarloStop({
      equity: 0.42,
      total: 1_000,
      nextIterations: 4_000,
      diminishingReturnsThreshold: 0.1,
    });
    assert.equal(decision.shouldStop, false);
    assert.equal(decision.reason, null);
  });

  it('检查顺序：门槛检查优先于时间检查（门槛更强也更便宜）', () => {
    const fc = fakeClock();
    const d = new DecisionDeadline({ clock: fc.clock, softMs: 1_000, hardMs: 2_000 });
    fc.advance(2_000); // 已超时
    const decision = evaluateMonteCarloStop({
      equity: 0.9,
      total: 100_000,
      nextIterations: 200_000,
      decisionThreshold: 0.2, // CI 远在门槛之上
      diminishingReturnsThreshold: 0.1,
      deadline: d,
    });
    assert.equal(decision.reason, EquityStopReason.CI_CLEARS_THRESHOLD);
  });
});

describe('equityPolicy —— 默认时间预算', () => {
  it('交互式模式得到软 3 秒 / 硬 8 秒', () => {
    const d = defaultDeadlineForMode(EquityComputeMode.FAST);
    assert.equal(d.mode, DeadlineMode.INTERACTIVE);
    assert.equal(d.softMs, 3_000);
    assert.equal(d.hardMs, 8_000);
  });

  it('高精度与验证模式得到更宽的预算', () => {
    assert.equal(defaultDeadlineForMode(EquityComputeMode.PRECISION).mode, DeadlineMode.PRECISION);
    assert.equal(defaultDeadlineForMode(EquityComputeMode.VERIFY).mode, DeadlineMode.VERIFY);
    assert.ok(
      defaultDeadlineForMode(EquityComputeMode.VERIFY).hardMs >
        defaultDeadlineForMode(EquityComputeMode.FAST).hardMs,
    );
  });

  it('可注入时钟，便于测试', () => {
    const fc = fakeClock(77);
    const d = defaultDeadlineForMode(EquityComputeMode.FAST, fc.clock);
    assert.equal(d.startTime, 77);
  });
});
