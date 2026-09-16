/**
 * DecisionDeadline 测试（规范第 7~9 节）
 *
 * 关键设计：时钟可注入 → **用假时钟验证中止行为，不需要真的等 8 秒**。
 * 这是让「时间预算」这类逻辑变得可测试的核心手段。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEADLINE_DEFAULTS,
  DeadlineMode,
  DecisionDeadline,
  PhaseTimer,
  interactiveDeadline,
  type Clock,
} from '../src/app/decisionDeadline.ts';

/** 可手动推进的假时钟 */
function fakeClock(start = 1000): { clock: Clock; advance: (ms: number) => void; now: () => number } {
  let current = start;
  return {
    clock: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    now: () => current,
  };
}

describe('DecisionDeadline —— 默认预算符合规范', () => {
  it('交互式默认：软 3 秒、硬 8 秒', () => {
    const d = new DecisionDeadline();
    assert.equal(d.mode, DeadlineMode.INTERACTIVE);
    assert.equal(d.softMs, 3_000);
    assert.equal(d.hardMs, 8_000);
  });

  it('DEADLINE_DEFAULTS 表本身符合规范第 7 节', () => {
    assert.equal(DEADLINE_DEFAULTS.INTERACTIVE.softMs, 3_000);
    assert.equal(DEADLINE_DEFAULTS.INTERACTIVE.hardMs, 8_000);
    // 高精度与验证模式必须更宽松，否则离线复盘无法用完整枚举
    assert.ok(DEADLINE_DEFAULTS.PRECISION.hardMs > DEADLINE_DEFAULTS.INTERACTIVE.hardMs);
    assert.ok(DEADLINE_DEFAULTS.VERIFY.hardMs >= DEADLINE_DEFAULTS.PRECISION.hardMs);
  });

  it('interactiveDeadline 便捷构造等价于默认', () => {
    const a = interactiveDeadline();
    assert.equal(a.softMs, 3_000);
    assert.equal(a.hardMs, 8_000);
  });

  it('softMs 必须为正、hardMs 不得小于 softMs', () => {
    assert.throws(() => new DecisionDeadline({ softMs: 0, hardMs: 8_000 }), /softMs 必须为正/);
    assert.throws(() => new DecisionDeadline({ softMs: 5_000, hardMs: 3_000 }), /hardMs 不得小于 softMs/);
  });
});

describe('DecisionDeadline —— 时间推进（假时钟）', () => {
  it('elapsedMs / remainingMs 随时间正确变化', () => {
    const fc = fakeClock(10_000);
    const d = new DecisionDeadline({ clock: fc.clock, softMs: 3_000, hardMs: 8_000 });
    assert.equal(d.elapsedMs(), 0);
    assert.equal(d.remainingMs(), 8_000);
    assert.equal(d.remainingSoftMs(), 3_000);

    fc.advance(2_500);
    assert.equal(d.elapsedMs(), 2_500);
    assert.equal(d.remainingMs(), 5_500);
    assert.equal(d.remainingSoftMs(), 500);
    assert.equal(d.softExpired(), false);
    assert.equal(d.hardExpired(), false);

    fc.advance(500);
    assert.equal(d.softExpired(), true, '到达软上限应标记为已过期');
    assert.equal(d.hardExpired(), false);

    fc.advance(5_000);
    assert.equal(d.elapsedMs(), 8_000);
    assert.equal(d.hardExpired(), true);
    assert.equal(d.remainingMs(), 0);
  });

  it('超过硬上限后 remainingMs 为负（明确表达已超时，而不是悄悄截断为 0）', () => {
    const fc = fakeClock();
    const d = new DecisionDeadline({ clock: fc.clock, softMs: 1_000, hardMs: 2_000 });
    fc.advance(2_500);
    assert.equal(d.remainingMs(), -500);
    assert.equal(d.hardExpired(), true);
  });
});

describe('DecisionDeadline —— canStartRound（是否还能再算一轮）', () => {
  it('时间充足时可以启动新的一轮', () => {
    const fc = fakeClock();
    const d = new DecisionDeadline({ clock: fc.clock, softMs: 3_000, hardMs: 8_000 });
    fc.advance(1_000);
    assert.equal(d.canStartRound(2_000), true);
  });

  it('预计成本超过剩余时间时不得启动', () => {
    const fc = fakeClock();
    const d = new DecisionDeadline({ clock: fc.clock, softMs: 3_000, hardMs: 8_000 });
    fc.advance(7_000);
    assert.equal(d.remainingMs(), 1_000);
    assert.equal(d.canStartRound(1_500), false, '成本 1500ms 超过剩余 1000ms');
    assert.equal(d.canStartRound(900), true);
  });

  it('到达硬上限后一律不得启动（即使成本为 0）', () => {
    const fc = fakeClock();
    const d = new DecisionDeadline({ clock: fc.clock, softMs: 1_000, hardMs: 2_000 });
    fc.advance(2_000);
    assert.equal(d.canStartRound(0), false);
  });

  it('markSettled 之后一律不得启动 —— 阻止为了用满时间而继续算', () => {
    const d = new DecisionDeadline({ clock: fakeClock().clock, softMs: 3_000, hardMs: 8_000 });
    assert.equal(d.canStartRound(0), true);
    d.markSettled();
    assert.equal(d.isSettled(), true);
    assert.equal(d.canStartRound(0), false);
    // 即使时间还很充裕也必须停止
    assert.ok(d.remainingMs() > 7_000);
  });
});

describe('DecisionDeadline —— snapshot 供 Decision Log 使用', () => {
  it('快照包含全部字段且数值正确', () => {
    const fc = fakeClock(50_000);
    const d = new DecisionDeadline({ clock: fc.clock, softMs: 3_000, hardMs: 8_000 });
    fc.advance(1_234);
    const snap = d.snapshot();
    assert.equal(snap.mode, DeadlineMode.INTERACTIVE);
    assert.equal(snap.startTime, 50_000);
    assert.equal(snap.softMs, 3_000);
    assert.equal(snap.hardMs, 8_000);
    assert.equal(snap.elapsedMs, 1_234);
    assert.equal(snap.remainingMs, 8_000 - 1_234);
    assert.equal(snap.settled, false);
  });
});

describe('PhaseTimer —— 分段耗时记录（规范第 51 条）', () => {
  it('能分别累计各阶段耗时', () => {
    const fc = fakeClock();
    const timer = new PhaseTimer(fc.clock);

    timer.measure('validator', () => fc.advance(10));
    timer.measure('math', () => fc.advance(20));
    timer.measure('equity', () => fc.advance(150));
    timer.measure('equity', () => fc.advance(50));
    timer.add('range', 7);

    const value = timer.finish();
    assert.equal(value.validator, 10);
    assert.equal(value.math, 20);
    assert.equal(value.equity, 200, '同一阶段应累加');
    assert.equal(value.range, 7);
    assert.equal(value.playerModel, 0);
    assert.equal(value.agents, 0);
    // 总耗时 = 各阶段实测耗时之和（validator 10 + math 20 + equity 200 + range 7 = 237），
    // 但 timer.add 之外的构造开销不推进假时钟，因此 total 以时钟差为准。
    // 这里断言 total 覆盖到最后一次计时点，并且不小于各阶段之和里由 measure 记录的部分。
    assert.ok(value.total >= 230, `total 过小：${value.total}`);
    assert.ok(value.total <= 237, `total 过大：${value.total}`);
  });

  it('即使被测量函数抛错也会记录耗时（finally 保证）', () => {
    const fc = fakeClock();
    const timer = new PhaseTimer(fc.clock);
    assert.throws(() => {
      timer.measure('math', () => {
        fc.advance(33);
        throw new Error('模拟内部失败');
      });
    }, /模拟内部失败/);
    assert.equal(timer.value().math, 33, '抛错路径也必须记录耗时');
  });
});
