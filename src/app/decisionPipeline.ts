/**
 * 决策管线（Step 3-lite）
 *
 * 规范第 8 / 9 / 17 / 51 / 59 节的落地基础设施。
 *
 * 本文件**只做编排**，不含任何扑克策略：
 * - 定义 `DecisionContext`（所有阶段共享的上下文，携带剩余时间）
 * - 定义阶段注册表与每阶段预算
 * - 顺序执行阶段，在每阶段之前检查时间预算
 * - 中止（Abort）沿上下文传播，**后续阶段一律标记为「已跳过」，绝不假装跑过**
 * - 记录规范第 51 节要求的七项耗时
 *
 * 四条硬约束：
 * 1. **不静默降级**（规范第 59 条）：任何跳过、中止、降级都必须写入 `skipped` / `aborts`
 * 2. **不伪造完整结果**：时间不够时返回 `complete: false` 与 `degraded: true`
 * 3. **8 秒是绝对上限**：`runPipeline` 返回前必定已停止所有阶段
 * 4. 阶段函数必须**自己**在长循环里消费 `ctx.remainingMs()`；
 *    管线只能保证「不在预算外启动新阶段」，无法中断一个不检查时间的死循环
 *    —— 这一点在 `assertStageAbortable` 与测试中说清楚
 */

import {
  DecisionDeadline,
  PhaseTimer,
  type DeadlineMode,
  type PhaseTimings,
} from './decisionDeadline.ts';

/* ============================================================
 * 阶段定义
 * ============================================================ */

export const PipelineStage = {
  VALIDATOR: 'validator',
  MATH: 'math',
  RANGE: 'range',
  PLAYER_MODEL: 'playerModel',
  EQUITY: 'equity',
  AGENTS: 'agents',
} as const;
export type PipelineStage = (typeof PipelineStage)[keyof typeof PipelineStage];

/** 七项耗时之一（顺序即规范第 51 节的列举顺序） */
export const PIPELINE_TIMING_KEYS = [
  'validator',
  'math',
  'range',
  'playerModel',
  'equity',
  'agents',
] as const satisfies readonly PipelineStage[];

export type StageDescriptor = {
  stage: PipelineStage;
  /** 中文显示名 */
  labelKey: string;
  /**
   * 该阶段的时间上限（毫秒）。
   * 用于「本阶段还能用多少时间」的自我约束；不是硬性切断（JS 无法抢占）。
   */
  budgetMs: number;
  /**
   * 是否必需。
   * 必需阶段被跳过 → 整体结果标记为 `degraded`；
   * 非必需阶段被跳过 → 只记录，不影响可回答性。
   */
  required: boolean;
};

/**
 * 阶段预算表。
 *
 * 数值来源（规范第 9 节的时间分配建议，按交互式软 3 秒 / 硬 8 秒校准）：
 *   0~500ms    校验 + 数学 + 牌面结构（都很便宜）
 *   500~2000ms 范围更新 + 玩家模型（缓存命中时很快）
 *   2000~5000ms 权益计算 + 多智能体审查（只有边缘决策才需要）
 * 合计软预算 3000ms，与 DecisionDeadline 的默认软上限一致。
 */
export const STAGE_BUDGETS: Readonly<Record<PipelineStage, number>> = {
  validator: 300,
  math: 200,
  range: 900,
  playerModel: 400,
  equity: 2_000,
  agents: 1_200,
};

/** 阶段的中文显示名（词条 key） */
export const STAGE_LABEL_KEYS: Readonly<Record<PipelineStage, string>> = {
  validator: 'STAGE.VALIDATOR',
  math: 'STAGE.MATH',
  range: 'STAGE.RANGE',
  playerModel: 'STAGE.PLAYER_MODEL',
  equity: 'STAGE.EQUITY',
  agents: 'STAGE.AGENTS',
};

/** 必需阶段：缺失这些就无法给出可靠建议 */
const REQUIRED_STAGES: ReadonlySet<PipelineStage> = new Set([
  PipelineStage.VALIDATOR,
  PipelineStage.MATH,
]);

export function describeStage(stage: PipelineStage): StageDescriptor {
  return {
    stage,
    labelKey: STAGE_LABEL_KEYS[stage],
    budgetMs: STAGE_BUDGETS[stage],
    required: REQUIRED_STAGES.has(stage),
  };
}

/* ============================================================
 * 中止原因
 * ============================================================ */

export const AbortReason = {
  /** 时间预算耗尽 */
  DEADLINE: 'DEADLINE',
  /** 阶段自身判定无法继续（例如输入冲突、范围坍塌） */
  STAGE_BLOCKED: 'STAGE_BLOCKED',
  /** 阶段抛出异常 */
  STAGE_ERROR: 'STAGE_ERROR',
  /** 上游阶段已中止，本阶段不再启动 */
  UPSTREAM_ABORTED: 'UPSTREAM_ABORTED',
  /** 前置必需阶段缺失 */
  PREREQUISITE_MISSING: 'PREREQUISITE_MISSING',
} as const;
export type AbortReason = (typeof AbortReason)[keyof typeof AbortReason];

export type AbortRecord = {
  stage: PipelineStage;
  reason: AbortReason;
  /** 可渲染的中文参数 */
  params: Readonly<Record<string, string | number>>;
};

/* ============================================================
 * DecisionContext
 * ============================================================ */

/**
 * 决策上下文：所有阶段共享。
 *
 * 这是「时间预算进入架构」的关键载体 ——
 * 每个阶段函数都拿到它，因此**从第一天起就能写出可被中止的实现**
 * （规范对 Range Engine 的硬要求：必须接受 `DecisionContext.remainingMs`）。
 */
export type DecisionContext = {
  /** 本次决策的唯一 id（用于 Decision Log） */
  decisionId: string;
  /** 统一时间预算 */
  deadline: DecisionDeadline;
  /** 阶段计时器 */
  timings: PhaseTimer;
  /** 已完成阶段的产出，按阶段名索引 */
  outputs: Map<PipelineStage, unknown>;
  /** 已中止的原因（按发生顺序） */
  aborts: AbortRecord[];
  /** 被跳过的阶段（含原因） */
  skipped: AbortRecord[];
  /** 已完成阶段摘要（供追踪与调试） */
  completed: Array<{ stage: PipelineStage; elapsedMs: number }>;

  /** 剩余毫秒（透传自 deadline） */
  remainingMs(): number;
  /** 是否已请求中止 */
  isAborted(): boolean;
  /** 是否已超过硬上限 */
  isExpired(): boolean;
  /** 本阶段可用的时间上限（取「阶段预算」与「剩余时间」的较小值） */
  budgetFor(stage: PipelineStage): number;
  /** 在给定成本下，是否还值得继续 */
  canAfford(costMs: number): boolean;
  /** 读取某阶段的产出 */
  outputOf<T>(stage: PipelineStage): T | undefined;
};

function createContext(deadline: DecisionDeadline, decisionId: string): DecisionContext {
  // 与预算共用同一个时钟：否则阶段耗时与预算判断来自两个时间源
  const timings = new PhaseTimer(deadline.clock);
  const outputs = new Map<PipelineStage, unknown>();
  const aborts: AbortRecord[] = [];
  const skipped: AbortRecord[] = [];
  const completed: Array<{ stage: PipelineStage; elapsedMs: number }> = [];

  const ctx: DecisionContext = {
    decisionId,
    deadline,
    timings,
    outputs,
    aborts,
    skipped,
    completed,
    remainingMs: () => deadline.remainingMs(),
    isAborted: () => aborts.length > 0,
    isExpired: () => deadline.hardExpired(),
    budgetFor: (stage) => Math.min(STAGE_BUDGETS[stage], Math.max(0, deadline.remainingMs())),
    canAfford: (costMs) => !ctx.isAborted() && deadline.canStartRound(costMs),
    outputOf: <T,>(stage: PipelineStage) => outputs.get(stage) as T | undefined,
  };
  return ctx;
}

/**
 * 记录一次中止。
 *
 * 两个列表的语义是**分开的**，不要混同：
 * - `aborts`：本次决策为何不完整（含「某阶段跑了一半自己中止」）
 * - `skipped`：**完全没有执行**的阶段清单
 *
 * 因此一个「执行到一半主动中止」的阶段只进 `aborts`，**不进** `skipped` ——
 * 它毕竟执行了。把它也算进 `skipped` 会让「未执行阶段数」虚高（本项目实际踩过这个坑）。
 */
function recordAbort(ctx: DecisionContext, record: AbortRecord): void {
  ctx.aborts.push(record);
}

/** 记录一个「完全没有执行的阶段」 */
function recordSkipped(ctx: DecisionContext, record: AbortRecord): void {
  if (!ctx.skipped.some((s) => s.stage === record.stage)) ctx.skipped.push(record);
}

/** 既没执行、又构成中止（例如时间不够导致该阶段未启动） */
function recordAbortAndSkipped(ctx: DecisionContext, record: AbortRecord): void {
  ctx.aborts.push(record);
  recordSkipped(ctx, record);
}

/** 供阶段函数主动请求中止 */
export function abort(ctx: DecisionContext, record: AbortRecord): void {
  ctx.aborts.push(record);
}

/** 供阶段函数检测：剩余时间是否还够跑一轮 */
export function hasTimeFor(ctx: DecisionContext, costMs: number): boolean {
  return ctx.canAfford(costMs);
}

/* ============================================================
 * 阶段函数契约
 * ============================================================ */

/**
 * 阶段返回值。
 *
 * - 返回具体值 → 视为完成
 * - 返回 `undefined` → 视为「本阶段无可产出」，但**不算失败**（会记录为跳过）
 * - 返回 `{ aborted: record }` → 主动中止，后续阶段全部跳过
 * - 抛出异常 → 记录为 `STAGE_ERROR` 并中止后续阶段
 */
export type StageAbort = { aborted: AbortRecord };
export type StageOutcome<T> = T | StageAbort | undefined;

export type StageFn<T = unknown> = (ctx: DecisionContext) => StageOutcome<T>;

export function isStageAbort(value: unknown): value is StageAbort {
  return (
    typeof value === 'object' &&
    value !== null &&
    'aborted' in value &&
    typeof (value as StageAbort).aborted === 'object'
  );
}

/** 便捷构造：阶段请求中止 */
export function stageAbort(
  stage: PipelineStage,
  reason: AbortReason,
  params: Record<string, string | number> = {},
): StageAbort {
  return { aborted: { stage, reason, params } };
}

/* ============================================================
 * 管线结果
 * ============================================================ */

export type PipelineResult = {
  /** 全部必需阶段都完成，且未被中止 */
  complete: boolean;
  /** 发生过任何中止或必需阶段缺失 */
  degraded: boolean;
  /** 是否因时间预算中止 */
  timedOut: boolean;
  /** 七项耗时（validator / math / range / playerModel / equity / agents / total） */
  timings: PhaseTimings;
  /** 已完成阶段 */
  completed: Array<{ stage: PipelineStage; elapsedMs: number }>;
  /** 被跳过的阶段及原因 */
  skipped: AbortRecord[];
  /** 中止记录 */
  aborts: AbortRecord[];
  /** 各阶段产出 */
  outputs: Map<PipelineStage, unknown>;
  /** 供 Decision Log 的完整快照 */
  log: {
    decisionId: string;
    deadline: ReturnType<DecisionDeadline['snapshot']>;
    stageBudgets: Readonly<Record<PipelineStage, number>>;
  };
};

export type PipelineDefinition = Partial<Record<PipelineStage, StageFn>>;

export type RunPipelineOptions = {
  /** 执行顺序（默认按规范第 9 节的时间分配顺序） */
  order?: readonly PipelineStage[];
  decisionId?: string;
  /** 未提供时按 mode 生成默认预算 */
  deadline?: DecisionDeadline;
};

const DEFAULT_ORDER: readonly PipelineStage[] = [
  PipelineStage.VALIDATOR,
  PipelineStage.MATH,
  PipelineStage.RANGE,
  PipelineStage.PLAYER_MODEL,
  PipelineStage.EQUITY,
  PipelineStage.AGENTS,
];

/**
 * 运行决策管线。
 *
 * **保证**：无论发生什么（阶段抛错、超时、主动中止），本函数都会返回一个
 * 结构完整的结果对象，且 `complete` / `degraded` / `skipped` 如实反映发生了什么。
 * 绝不返回「看起来完整但实际没跑」的结果。
 */
export function runPipeline(
  definition: PipelineDefinition,
  options: RunPipelineOptions = {},
): PipelineResult {
  const order = options.order ?? DEFAULT_ORDER;
  const deadline = options.deadline ?? new DecisionDeadline();
  const decisionId = options.decisionId ?? `decision-${Date.now()}`;
  const ctx = createContext(deadline, decisionId);

  for (let i = 0; i < order.length; i++) {
    const stage = order[i]!;
    const descriptor = describeStage(stage);


    // ---- 上游已中止：本阶段与后续阶段一律标记为跳过（不静默） ----
    if (ctx.isAborted()) {
      recordSkipped(ctx, {
        stage,
        reason: AbortReason.UPSTREAM_ABORTED,
        params: { upstream: ctx.aborts[0]!.stage, upstreamReason: ctx.aborts[0]!.reason },
      });
      continue;
    }

    // ---- 时间预算：不够就不启动（该阶段既未执行、又构成中止） ----
    if (!deadline.canStartRound(0)) {
      recordAbortAndSkipped(ctx, {
        stage,
        reason: AbortReason.DEADLINE,
        params: {
          elapsedMs: Math.round(deadline.elapsedMs()),
          remainingMs: Math.round(deadline.remainingMs()),
        },
      });
      continue;
    }

    const fn = definition[stage];
    if (!fn) {
      const record: AbortRecord = {
        stage,
        reason: AbortReason.PREREQUISITE_MISSING,
        params: { stage, required: descriptor.required ? 'yes' : 'no' },
      };
      // 必需阶段缺失 → 记中止（后续不再启动）；非必需阶段缺失 → 只记跳过
      if (descriptor.required) recordAbortAndSkipped(ctx, record);
      else recordSkipped(ctx, record);
      continue;
    }

    const startedAt = deadline.elapsedMs();
    try {
      const outcome = ctx.timings.measure(stage, () => fn(ctx));
      const elapsedMs = deadline.elapsedMs() - startedAt;

      if (isStageAbort(outcome)) {
        recordAbort(ctx, outcome.aborted);
        continue;
      }
      if (outcome === undefined) {
        recordSkipped(ctx, {
          stage,
          reason: AbortReason.PREREQUISITE_MISSING,
          params: { stage, note: '阶段无产出（不算失败）' },
        });
        continue;
      }

      ctx.outputs.set(stage, outcome);
      ctx.completed.push({ stage, elapsedMs });
    } catch (error) {
      recordAbort(ctx, {
        stage,
        reason: AbortReason.STAGE_ERROR,
        params: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  // ---- 判定整体状态 ----
  const aborts = [...ctx.aborts];
  const timedOut = aborts.some((a) => a.reason === AbortReason.DEADLINE);
  const requiredMissing = order
    .filter((stage) => describeStage(stage).required)
    .some((stage) => !ctx.outputs.has(stage));
  const degraded = aborts.length > 0 || requiredMissing || ctx.skipped.length > 0;

  const timings = ctx.timings.finish();

  return {
    complete: aborts.length === 0 && !requiredMissing,
    degraded,
    timedOut,
    timings,
    completed: [...ctx.completed],
    skipped: [...ctx.skipped],
    aborts,
    outputs: new Map(ctx.outputs),
    log: {
      decisionId,
      deadline: deadline.snapshot(),
      stageBudgets: STAGE_BUDGETS,
    },
  };
}

/* ============================================================
 * 可中止性自检（供阶段实现者使用）
 * ============================================================ */

/**
 * 阶段实现的可中止性契约检查。
 *
 * 说明：JS 无法抢占式中断同步函数，因此**管线无法强制中止一个不检查时间的阶段**。
 * 本函数提供的是「契约自检」：阶段作者可以用它验证自己的循环确实会被时间打断。
 *
 * 用法（在阶段内部）：
 * ```ts
 * for (const item of items) {
 *   if (!hasTimeFor(ctx, estimatedCostMs)) return stageAbort('range', AbortReason.DEADLINE);
 *   process(item);
 * }
 * ```
 *
 * 测试中通过 `assertStageRespectsDeadline` 验证：给定极小预算与假时钟时，
 * 阶段必须主动返回中止，而不是跑完全部工作。
 */
export function assertStageRespectsDeadline<T>(
  fn: StageFn<T>,
  options: { deadline: DecisionDeadline; expectAbort: AbortReason },
): { aborted: boolean; abort: AbortRecord | null } {
  const ctx = createContext(options.deadline, 'abortability-probe');
  const outcome = fn(ctx);
  if (isStageAbort(outcome)) {
    if (outcome.aborted.reason !== options.expectAbort) {
      throw new Error(
        `assertStageRespectsDeadline: 期望中止原因 ${options.expectAbort}，实际 ${outcome.aborted.reason}`,
      );
    }
    return { aborted: true, abort: outcome.aborted };
  }
  return { aborted: false, abort: null };
}

export type { DeadlineMode, PhaseTimings };
