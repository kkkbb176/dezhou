/**
 * 决策管线测试（Step 3-lite）
 *
 * 覆盖规范第 8 / 9 / 17 / 51 / 59 节：
 * - DecisionContext 语义（remainingMs / budgetFor / canAfford / outputOf）
 * - 阶段预算接口
 * - Abort 沿管线传播（上游中止 → 后续全部标记跳过，绝不假装跑过）
 * - 七项耗时记录
 * - **8 秒 Hard Deadline 端到端集成测试**（假时钟，不真的等待）
 * - 不静默降级 / 不伪造完整结果
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AbortReason,
  PIPELINE_TIMING_KEYS,
  PipelineStage,
  STAGE_BUDGETS,
  assertStageRespectsDeadline,
  describeStage,
  hasTimeFor,
  isStageAbort,
  runPipeline,
  stageAbort,
  type DecisionContext,
  type PipelineResult,
} from '../src/app/decisionPipeline.ts';
import { DecisionDeadline, DeadlineMode, type Clock } from '../src/app/decisionDeadline.ts';

/** 每读一次时钟就前进 `stepMs` 的假时钟 */
function steppingClock(stepMs: number): { clock: Clock; reads: () => number } {
  let current = 0;
  let reads = 0;
  return {
    clock: () => {
      reads++;
      current += stepMs;
      return current;
    },
    reads: () => reads,
  };
}

/** 简单的手动时钟 */
function manualClock(): { clock: Clock; advance: (ms: number) => void } {
  let current = 0;
  return { clock: () => current, advance: (ms) => { current += ms; } };
}

/** 构造一个「各阶段都成功」的最小管线定义 */
function healthyPipeline(marker: Record<string, unknown> = {}) {
  return {
    validator: (ctx: DecisionContext) => {
      marker.validator = true;
      return { ok: true };
    },
    math: () => {
      marker.math = true;
      return { potOdds: 0.25 };
    },
    range: () => {
      marker.range = true;
      return { combos: 12 };
    },
    playerModel: () => {
      marker.playerModel = true;
      return { hands: 300 };
    },
    equity: () => {
      marker.equity = true;
      return { equity: 0.42 };
    },
    agents: () => {
      marker.agents = true;
      return { findings: [] };
    },
  };
}

describe('decisionPipeline —— 阶段定义与预算接口', () => {
  it('七项耗时键与规范第 51 节一致（六阶段 + total）', () => {
    assert.deepEqual([...PIPELINE_TIMING_KEYS], [
      'validator',
      'math',
      'range',
      'playerModel',
      'equity',
      'agents',
    ]);
    assert.equal(PIPELINE_TIMING_KEYS.length, 6, '六个阶段 + total 共七项');
  });

  it('每个阶段都有正的预算与中文标签', () => {
    for (const stage of PIPELINE_TIMING_KEYS) {
      const d = describeStage(stage);
      assert.ok(d.budgetMs > 0, `${stage} 预算必须为正`);
      assert.ok(d.labelKey.startsWith('STAGE.'), `${stage} 缺少中文标签`);
    }
  });

  it('阶段预算总和与交互式软预算（3 秒）一致', () => {
    const total = PIPELINE_TIMING_KEYS.reduce((sum, s) => sum + STAGE_BUDGETS[s], 0);
    assert.equal(total, 5_000, '预算总和应等于各阶段之和');
    // 校验 + 数学 + 范围 + 画像 属于「快速路径」，应能在 2 秒内跑完
    const fastPath =
      STAGE_BUDGETS.validator +
      STAGE_BUDGETS.math +
      STAGE_BUDGETS.range +
      STAGE_BUDGETS.playerModel;
    assert.ok(fastPath <= 2_000, `快速路径预算 ${fastPath}ms 应 ≤ 2000ms（规范第 9 节）`);
  });

  it('validator 与 math 是必需阶段', () => {
    assert.equal(describeStage(PipelineStage.VALIDATOR).required, true);
    assert.equal(describeStage(PipelineStage.MATH).required, true);
    assert.equal(describeStage(PipelineStage.RANGE).required, false);
    assert.equal(describeStage(PipelineStage.EQUITY).required, false);
  });
});

describe('decisionPipeline —— DecisionContext', () => {
  it('remainingMs / isExpired / budgetFor 反映时间预算', () => {
    const mc = manualClock();
    const deadline = new DecisionDeadline({ clock: mc.clock, softMs: 3_000, hardMs: 8_000 });
    let captured: DecisionContext | null = null;

    runPipeline(
      {
        validator: (ctx) => {
          captured = ctx;
          return { ok: true };
        },
      },
      { deadline, order: [PipelineStage.VALIDATOR] },
    );

    assert.ok(captured !== null);
    assert.ok(captured !== null, '阶段未收到上下文');
    const ctx: DecisionContext = captured;
    assert.equal(ctx.remainingMs(), 8_000);
    assert.equal(ctx.isExpired(), false);
    // budgetFor 取「阶段预算」与「剩余时间」的较小值
    assert.equal(ctx.budgetFor(PipelineStage.VALIDATOR), 300);
    mc.advance(7_900);
    assert.equal(ctx.budgetFor(PipelineStage.VALIDATOR), 100);
    mc.advance(200);
    assert.equal(ctx.isExpired(), true);
    assert.equal(ctx.budgetFor(PipelineStage.VALIDATOR), 0, '超时后可用预算必须为 0，不得为负');
  });

  it('canAfford / hasTimeFor 在预算不足时返回 false', () => {
    const mc = manualClock();
    const deadline = new DecisionDeadline({ clock: mc.clock, softMs: 3_000, hardMs: 8_000 });
    let captured: DecisionContext | null = null;
    runPipeline(
      { validator: (ctx) => { captured = ctx; return 1; } },
      { deadline, order: [PipelineStage.VALIDATOR] },
    );
    assert.ok(captured !== null, '阶段未收到上下文');
    const ctx: DecisionContext = captured;
    assert.equal(ctx.canAfford(7_000), true);
    assert.equal(ctx.canAfford(9_000), false);
    assert.equal(hasTimeFor(ctx, 9_000), false);
    mc.advance(7_500);
    assert.equal(hasTimeFor(ctx, 600), false);
    assert.equal(hasTimeFor(ctx, 400), true);
  });

  it('outputOf 能取回已记录的各阶段产出', () => {
    let captured: DecisionContext | null = null;
    runPipeline(
      {
        validator: () => ({ blocked: false }),
        math: (ctx) => {
          captured = ctx;
          return { potOdds: 0.25 };
        },
      },
      { order: [PipelineStage.VALIDATOR, PipelineStage.MATH] },
    );
    assert.ok(captured !== null, '阶段未收到上下文');
    const ctx: DecisionContext = captured;
    assert.deepEqual(ctx.outputOf<{ blocked: boolean }>(PipelineStage.VALIDATOR), { blocked: false });
    assert.equal(ctx.outputOf(PipelineStage.RANGE), undefined, '未执行的阶段必须返回 undefined');
  });

  it('decisionId 可注入，便于 Decision Log 追踪', () => {
    const result = runPipeline(healthyPipeline(), { decisionId: 'hand-42-river' });
    assert.equal(result.log.decisionId, 'hand-42-river');
  });
});

describe('decisionPipeline —— 正常路径', () => {
  it('全部阶段完成时 complete=true 且 degraded=false', () => {
    const marker: Record<string, unknown> = {};
    const result = runPipeline(healthyPipeline(marker));

    assert.equal(result.complete, true);
    assert.equal(result.degraded, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.aborts.length, 0);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.completed.length, 6);
    for (const key of Object.keys(marker)) {
      assert.equal(marker[key], true, `阶段 ${key} 未执行`);
    }
  });

  it('阶段产出可从结果中按阶段取回', () => {
    const result = runPipeline(healthyPipeline());
    assert.deepEqual(result.outputs.get(PipelineStage.MATH), { potOdds: 0.25 });
    assert.deepEqual(result.outputs.get(PipelineStage.EQUITY), { equity: 0.42 });
  });

  it('七项耗时全部存在且非负', () => {
    const result = runPipeline(healthyPipeline());
    const t = result.timings;
    for (const key of [
      'validator', 'math', 'range', 'playerModel', 'equity', 'agents', 'total',
    ] as const) {
      assert.ok(key in t, `耗时缺少字段 ${key}`);
      assert.equal(typeof t[key], 'number');
      assert.ok(t[key] >= 0, `耗时 ${key} 为负`);
    }
  });

  it('执行顺序可自定义', () => {
    const order: PipelineStage[] = [];
    runPipeline(
      {
        math: () => { order.push(PipelineStage.MATH); return 1; },
        validator: () => { order.push(PipelineStage.VALIDATOR); return 1; },
      },
      { order: [PipelineStage.MATH, PipelineStage.VALIDATOR] },
    );
    assert.deepEqual(order, [PipelineStage.MATH, PipelineStage.VALIDATOR]);
  });
});

describe('decisionPipeline —— Abort 传播（不静默降级）', () => {
  it('阶段主动中止后，后续阶段全部标记为「上游已中止」且不执行', () => {
    const executed: string[] = [];
    const result = runPipeline({
      validator: () => { executed.push('validator'); return { ok: true }; },
      math: () => { executed.push('math'); return { potOdds: 0.25 }; },
      range: () => {
        executed.push('range');
        return stageAbort(PipelineStage.RANGE, AbortReason.STAGE_BLOCKED, { note: '范围坍塌' });
      },
      playerModel: () => { executed.push('playerModel'); return 1; },
      equity: () => { executed.push('equity'); return 1; },
      agents: () => { executed.push('agents'); return 1; },
    });

    assert.deepEqual(executed, ['validator', 'math', 'range'], '中止后不得再执行任何阶段');
    assert.equal(result.complete, false);
    assert.equal(result.degraded, true);
    assert.equal(result.aborts.length, 1);
    assert.equal(result.aborts[0]!.reason, AbortReason.STAGE_BLOCKED);

    // 后续三个阶段必须被显式标记为跳过
    assert.equal(result.skipped.length, 3);
    for (const record of result.skipped) {
      assert.equal(record.reason, AbortReason.UPSTREAM_ABORTED);
      assert.equal(record.params.upstream, PipelineStage.RANGE);
    }
    assert.deepEqual(
      result.skipped.map((s) => s.stage),
      [PipelineStage.PLAYER_MODEL, PipelineStage.EQUITY, PipelineStage.AGENTS],
    );
  });

  it('阶段抛错时被捕获，管线仍返回结构完整的结果（不崩溃）', () => {
    const result = runPipeline({
      validator: () => ({ ok: true }),
      math: () => {
        throw new Error('模拟内部失败：除以零');
      },
      range: () => 1,
    });

    assert.equal(result.complete, false);
    assert.equal(result.degraded, true);
    const abort = result.aborts.find((a) => a.stage === PipelineStage.MATH);
    assert.ok(abort, '未记录 math 阶段的异常');
    assert.equal(abort!.reason, AbortReason.STAGE_ERROR);
    assert.ok(String(abort!.params.message).includes('除以零'));
    // 抛错后 range 必须被标记为跳过
    assert.ok(result.skipped.some((s) => s.stage === PipelineStage.RANGE && s.reason === AbortReason.UPSTREAM_ABORTED));
  });

  it('必需阶段缺失时 complete=false（不允许缺校验就出结论）', () => {
    const result = runPipeline({ range: () => 1 }, { order: [PipelineStage.VALIDATOR, PipelineStage.RANGE] });
    assert.equal(result.complete, false);
    assert.equal(result.degraded, true);
    const missing = result.skipped.find((s) => s.stage === PipelineStage.VALIDATOR);
    assert.ok(missing);
    assert.equal(missing!.reason, AbortReason.PREREQUISITE_MISSING);
  });

  it('非必需阶段缺失只记录不阻断（仍可 complete）', () => {
    const result = runPipeline(
      { validator: () => 1, math: () => 1 },
      { order: [PipelineStage.VALIDATOR, PipelineStage.MATH, PipelineStage.RANGE] },
    );
    assert.equal(result.complete, true, '非必需阶段缺失不应阻断');
    assert.equal(result.aborts.length, 0);
    assert.ok(result.skipped.some((s) => s.stage === PipelineStage.RANGE));
    assert.equal(result.degraded, true, '但有跳过就必须标记为 degraded（不静默）');
  });

  it('阶段返回 undefined 视为「无产出」而非失败', () => {
    const result = runPipeline(
      { validator: () => 1, math: () => 1, range: () => undefined },
      { order: [PipelineStage.VALIDATOR, PipelineStage.MATH, PipelineStage.RANGE] },
    );
    assert.equal(result.complete, true);
    assert.equal(result.aborts.length, 0);
    assert.ok(result.skipped.some((s) => s.stage === PipelineStage.RANGE));
  });
});

describe('decisionPipeline —— 8 秒 Hard Deadline 端到端', () => {
  it('预算耗尽时中止，返回 timedOut 且如实列出未执行阶段', () => {
    const mc = manualClock();
    // 软 3 秒 / 硬 8 秒，与本 Step 的默认交互预算一致
    const deadline = new DecisionDeadline({ clock: mc.clock, softMs: 3_000, hardMs: 8_000 });

    const executed: PipelineStage[] = [];
    const result = runPipeline(
      {
        validator: () => { executed.push(PipelineStage.VALIDATOR); mc.advance(100); return 1; },
        math: () => { executed.push(PipelineStage.MATH); mc.advance(200); return 2; },
        // 一个「跑得比预算还久」的阶段：它自己不看表，因此把预算耗尽到正好 8000ms
        range: () => { executed.push(PipelineStage.RANGE); mc.advance(7_700); return 3; },
        playerModel: () => { executed.push(PipelineStage.PLAYER_MODEL); return 4; },
        equity: () => { executed.push(PipelineStage.EQUITY); return 5; },
        agents: () => { executed.push(PipelineStage.AGENTS); return 6; },
      },
      { deadline },
    );

    assert.equal(deadline.elapsedMs(), 8_000, '场景应恰好把预算耗尽到硬上限');
    assert.equal(result.timedOut, true, '预算耗尽后必须标记 timedOut');
    assert.equal(result.complete, false);
    assert.equal(result.degraded, true);
    assert.deepEqual(
      executed,
      [PipelineStage.VALIDATOR, PipelineStage.MATH, PipelineStage.RANGE],
      '预算耗尽后不得再执行任何阶段',
    );

    const deadlineAbort = result.aborts.find((a) => a.reason === AbortReason.DEADLINE);
    assert.ok(deadlineAbort, '未记录 DEADLINE 中止');
    assert.equal(deadlineAbort!.stage, PipelineStage.PLAYER_MODEL);
    // 未执行的三个阶段必须都在册
    assert.deepEqual(
      result.skipped.map((s) => s.stage),
      [PipelineStage.PLAYER_MODEL, PipelineStage.EQUITY, PipelineStage.AGENTS],
    );
    assert.equal(Number(deadlineAbort!.params.remainingMs), 0);
  });

  it('在预算内跑完时不标记 timedOut（不把「差点超时」谎报为超时）', () => {
    const mc = manualClock();
    const deadline = new DecisionDeadline({ clock: mc.clock, softMs: 3_000, hardMs: 8_000 });

    const result = runPipeline(
      {
        validator: () => { mc.advance(100); return 1; },
        math: () => { mc.advance(200); return 2; },
        // 用掉 7700ms，但仍在硬上限之内（剩余 100ms）
        range: () => { mc.advance(7_600); return 3; },
        playerModel: () => 4,
        equity: () => 5,
        agents: () => 6,
      },
      { deadline },
    );

    assert.equal(deadline.elapsedMs(), 7_900);
    assert.equal(result.timedOut, false, '仍在预算内，不得标记超时');
    assert.equal(result.complete, true);
    assert.equal(result.aborts.length, 0);
    assert.equal(result.skipped.length, 0);
  });

  it('**端到端：8 秒硬上限内必定返回，且不伪造完整结果**', () => {
    /**
     * 假时钟：每读一次前进 40ms，但**硬性封顶在 8000ms**。
     *
     * 为什么必须封顶：规范第 7 节的「8 秒」是**绝对上限**。真实系统里，
     * 一个超过 8 秒的决策本身就意味着实现违规，不应该发生；
     * 而一个「每读必进、永不封顶」的假时钟会让任何断言都变得不可判定
     * （读取时钟这个动作本身就会把时间推过上限）。
     * 因此这里用「封顶时钟」精确表达规范的语义：
     * **无论怎么读，都不允许越过 8 秒。**
     */
    const HARD = 8_000;
    let current = 0;
    const clock: Clock = () => {
      current = Math.min(current + 40, HARD);
      return current;
    };
    const deadline = new DecisionDeadline({ clock, mode: DeadlineMode.INTERACTIVE });

    /** 一个「可被中止」的慢阶段：分批处理，每批之前检查预算 */
    const abortableBatchStage = (totalBatches: number, costPerBatchMs: number) => {
      return (ctx: DecisionContext) => {
        let processed = 0;
        for (let batch = 0; batch < totalBatches; batch++) {
          if (!hasTimeFor(ctx, costPerBatchMs)) {
            return stageAbort(PipelineStage.AGENTS, AbortReason.DEADLINE, {
              processedBatches: processed,
              totalBatches,
              remainingMs: Math.round(ctx.remainingMs()),
            });
          }
          processed++;
        }
        return { processed };
      };
    };

    const result = runPipeline(
      {
        validator: () => ({ ok: true }),
        math: () => ({ potOdds: 0.25 }),
        // 故意给一个远超预算的工作量
        agents: abortableBatchStage(10_000, 250),
      },
      { deadline },
    );

    const elapsed = deadline.elapsedMs();
    assert.ok(elapsed <= 8_000, `端到端耗时 ${elapsed}ms 超过 8 秒硬上限`);
    assert.equal(result.complete, false, '未完成的管线不得报告 complete');
    assert.equal(result.degraded, true);
    assert.equal(result.timedOut, true);
    // 被中止的阶段必须如实记录处理进度，而不是假装跑完
    const abort = result.aborts.find((a) => a.stage === PipelineStage.AGENTS)!;
    assert.ok(Number(abort.params.processedBatches) < 10_000, '不应跑完全部批次');
    assert.equal(Number(abort.params.totalBatches), 10_000);
  });

  it('时间充裕时同一个慢阶段能跑完（证明上面的中止确实来自时间预算）', () => {
    const mc = manualClock();
    const deadline = new DecisionDeadline({ clock: mc.clock, softMs: 600_000, hardMs: 900_000 });
    const result = runPipeline(
      {
        validator: () => 1,
        math: () => 1,
        agents: (ctx) => {
          let processed = 0;
          for (let batch = 0; batch < 20; batch++) {
            if (!hasTimeFor(ctx, 250)) {
              return stageAbort(PipelineStage.AGENTS, AbortReason.DEADLINE, { processed });
            }
            processed++;
          }
          return { processed };
        },
      },
      { deadline },
    );
    assert.equal(result.complete, true);
    assert.deepEqual(result.outputs.get(PipelineStage.AGENTS), { processed: 20 });
  });
});

describe('decisionPipeline —— 可中止性契约自检', () => {
  it('assertStageRespectsDeadline：超时预算下阶段必须主动中止', () => {
    const mc = manualClock();
    const deadline = new DecisionDeadline({ clock: mc.clock, softMs: 10, hardMs: 20 });
    mc.advance(50); // 一开始就已超时

    const probe = assertStageRespectsDeadline(
      (ctx) => {
        if (!hasTimeFor(ctx, 1)) {
          return stageAbort(PipelineStage.RANGE, AbortReason.DEADLINE, {});
        }
        return { done: true };
      },
      { deadline, expectAbort: AbortReason.DEADLINE },
    );
    assert.equal(probe.aborted, true);
    assert.equal(probe.abort!.reason, AbortReason.DEADLINE);
  });

  it('assertStageRespectsDeadline：中止原因不符时抛错（防止契约被偷偷改掉）', () => {
    const mc = manualClock();
    const deadline = new DecisionDeadline({ clock: mc.clock, softMs: 3_000, hardMs: 8_000 });
    assert.throws(
      () =>
        assertStageRespectsDeadline(
          () => stageAbort(PipelineStage.RANGE, AbortReason.STAGE_BLOCKED, {}),
          { deadline, expectAbort: AbortReason.DEADLINE },
        ),
      /期望中止原因/,
    );
  });

  it('assertStageRespectsDeadline：阶段跑完时报告未中止', () => {
    const mc = manualClock();
    const deadline = new DecisionDeadline({ clock: mc.clock, softMs: 3_000, hardMs: 8_000 });
    const probe = assertStageRespectsDeadline(() => ({ done: true }), {
      deadline,
      expectAbort: AbortReason.DEADLINE,
    });
    assert.equal(probe.aborted, false);
    assert.equal(probe.abort, null);
  });

  it('isStageAbort 能正确识别中止对象与普通返回值', () => {
    assert.equal(isStageAbort(stageAbort(PipelineStage.MATH, AbortReason.DEADLINE, {})), true);
    assert.equal(isStageAbort({ ok: true }), false);
    assert.equal(isStageAbort(undefined), false);
    assert.equal(isStageAbort(42), false);
    assert.equal(isStageAbort(null), false);
  });
});

describe('decisionPipeline —— 管线级延迟（真实时钟）', () => {
  it('全阶段为轻量计算时，管线总耗时远低于 8 秒', () => {
    const started = Date.now();
    const result: PipelineResult = runPipeline(healthyPipeline());
    const elapsed = Date.now() - started;
    assert.equal(result.complete, true);
    assert.ok(elapsed < 1_000, `轻量管线耗时 ${elapsed}ms，应远低于 1 秒`);
    assert.ok(result.timings.total < 1_000);
  });

  it('真实时钟下 deadline 与 timings 自洽（timings.total ≤ elapsed）', () => {
    const deadline = new DecisionDeadline();
    const result = runPipeline(healthyPipeline(), { deadline });
    assert.ok(result.timings.total >= 0);
    assert.ok(
      result.timings.total <= deadline.elapsedMs() + 5,
      `timings.total(${result.timings.total}) 不应超过实际耗时(${deadline.elapsedMs()})`,
    );
  });
});

describe('decisionPipeline —— 默认预算与模式', () => {
  it('未提供 deadline 时使用交互式默认（软 3 秒 / 硬 8 秒）', () => {
    const result = runPipeline(healthyPipeline());
    assert.equal(result.log.deadline.softMs, 3_000);
    assert.equal(result.log.deadline.hardMs, 8_000);
    assert.equal(result.log.deadline.mode, DeadlineMode.INTERACTIVE);
  });

  it('结果中带有阶段预算快照，便于 Decision Log 审计', () => {
    const result = runPipeline(healthyPipeline());
    assert.equal(result.log.stageBudgets.validator, STAGE_BUDGETS.validator);
    assert.equal(result.log.stageBudgets.equity, STAGE_BUDGETS.equity);
  });

  it('阶段耗时被分别计入对应字段（不混在一起）', () => {
    const mc = manualClock();
    const deadline = new DecisionDeadline({ clock: mc.clock, softMs: 60_000, hardMs: 120_000 });
    const result = runPipeline(
      {
        validator: () => { mc.advance(7); return 1; },
        math: () => { mc.advance(11); return 1; },
        range: () => { mc.advance(13); return 1; },
        playerModel: () => { mc.advance(17); return 1; },
        equity: () => { mc.advance(19); return 1; },
        agents: () => { mc.advance(23); return 1; },
      },
      { deadline },
    );
    assert.equal(result.timings.validator, 7);
    assert.equal(result.timings.math, 11);
    assert.equal(result.timings.range, 13);
    assert.equal(result.timings.playerModel, 17);
    assert.equal(result.timings.equity, 19);
    assert.equal(result.timings.agents, 23);
    assert.ok(result.timings.total >= 90, `total 应覆盖全部阶段：${result.timings.total}`);
  });
});
