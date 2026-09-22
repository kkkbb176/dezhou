/**
 * ============================================================================
 * 牌桌动态适应 V1 —— 影子模式执行器（默认开启，绝不改变正式建议）
 * ============================================================================
 *
 * ## 分层纪律（为什么这里没有 `import ... from '../../app/...'`）
 *
 * 本项目是分层架构：`domain/` 是纯函数、零 I/O，**不依赖 `app/`**。
 * 因此本模块把「决策输入」与「怎么把调整注入输入」都做成**泛型**：
 *
 * | 关注点 | 谁负责 |
 * |---|---|
 * | 桌况计算、调整方案、摘要、对比判定 | **本模块**（纯函数） |
 * | 决策输入的具体形状、`seatProfiles` 怎么注入 | **调用方**（`app/` 层） |
 *
 * 这样带来一个额外好处：测试可以用**极小的假输入**直接验证
 * 「影子不改变正式建议」「失败不影响正式建议」「超时不重算」这三条契约，
 * 而不需要跑完整的决策管线。
 *
 * ## 影子模式要证明的三件事
 *
 * 1. **不改变正式建议**：正式建议由**未调整**的输入算出，且在桌况计算之前
 *    就已经确定。本模块只把「调整后的建议」放在旁边供复盘，**绝不**回写。
 * 2. **可重放**：同一状态 + 同一事件历史 + 同一配置版本 ⇒ 同一结果。
 * 3. **失败/超时不影响正式建议**：任何异常与超时都被收敛成结果对象，
 *    **不向上传播**。
 *
 * ## 注入方式（为什么不是「把建议改成另一个动作」）
 *
 * 授权明确禁止两种伪造：最后机械改动作、随意给 EV 加分。
 * 因此本模块**只**产出「要改哪些输入参数」的清单，由调用方用同一套
 * 生产管线重算 —— 响应概率、范围、权益、EV 全部来自既有模型。
 */

import {
  buildTableAdjustmentPlan,
  computeTableDynamics,
  TABLE_DYNAMICS_CONFIG,
  type TableAdjustmentPlan,
  type TableAdjustmentContext,
  type TableDynamics,
  type TableDynamicsConfig,
} from './tableDynamics.ts';
import { computeTableDynamicsDigest } from './tableDynamicsDigest.ts';

/** 模式：`OFF` 不计算；`SHADOW` 只对比（默认）；`ACTIVE` 预留（本阶段不启用） */
export const TableDynamicsMode = {
  OFF: 'OFF',
  SHADOW: 'SHADOW',
  ACTIVE: 'ACTIVE',
} as const;
export type TableDynamicsMode = (typeof TableDynamicsMode)[keyof typeof TableDynamicsMode];

export type ShadowRunStatus = 'COMPUTED' | 'FAILED' | 'TIMEOUT' | 'SKIPPED';

/** 桌况输入里的记录列表（从 `computeTableDynamics` 的入参派生，避免重复声明） */
type TableDynamicsInputRecordList = Parameters<typeof computeTableDynamics>[0]['records'];

/** 决策结果里影子层真正需要的字段（其余一律不读，避免耦合） */
export type ShadowDecisionView = {
  action: string;
  sizeChips: number | null;
  confidence?: number;
  band?: string;
  classification?: string;
  actionable?: boolean;
};

export type ShadowAnalyzeResult<TDecision = ShadowDecisionView> =
  | { ok: true; decision: TDecision }
  | { ok: false; stage?: string; issues?: unknown };

export type TableDynamicsShadowInput<TInput, TDecision = ShadowDecisionView> = {
  /** 决策输入（**本模块不修改它**，只把它交给 `inject`） */
  input: TInput;
  /** 未调整决策：调用方注入生产入口（本模块保持零 I/O） */
  analyze: (input: TInput) => ShadowAnalyzeResult<TDecision>;
  /**
   * 把调整方案注入输入 —— **唯一的**调整入口。
   *
   * 返回 `changes`（逐条中文说明改了哪个参数），本模块把它原样写进对比记录，
   * 使「调整了哪些输入」可审计。返回空 `changes` 表示「有方向但无可注入的参数」。
   */
  inject: (
    input: TInput,
    plan: TableAdjustmentPlan,
  ) => { input: TInput; changes: readonly string[] };
  /** 桌况原始记录（来自 playerHistory 的逐手行为记录） */
  records: TableDynamicsInputRecordList;
  presentPlayerIds: readonly string[];
  heroPlayerId: string | null;
  currentHandId?: string | null;
  /** 当前相关对手（本次要调整的座位） */
  relevantPlayerIds: readonly string[];
  activeCount: number;
  street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER';
  playersYetToAct: number;
  mode?: TableDynamicsMode;
  /**
   * 影子计算的墙钟预算（毫秒）。
   *
   * ## 🔴 这个预算**必须传进被判定的那次分析**，不能只在外面计时
   *
   * 第一版只在调用前后取时间戳、超时就返回 `TIMEOUT` —— 那**不是隔离**：
   * 同步分析已经跑完并占用了线程，用户等的时间一秒都没少
   *（授权 §五明确要求「如果同步计算仍占用线程，仅返回超时不算完成隔离」）。
   *
   * 本项目**没有** `AbortSignal` 这类外部取消原语，但生产管线自带
   * `DecisionDeadline`（软 3s / 硬 8s，在 `alphaPipeline` 与
   * `decisionPipeline` 的检查点处中止）。因此正确做法是：
   * **把影子预算翻译成这次分析自己的 `budget`**，让它在下一个检查点
   * 自行中止并返回结构化的 `{ ok:false, stage:'DEADLINE' }` ——
   * 那是真实的中止，而且错误不被吞掉（如实记进对比记录）。
   */
  budgetMs?: number;
  /**
   * 把影子预算注入分析调用（由 app 层实现）。
   *
   * 返回的分析函数应带更紧的时间预算。缺省 ⇒ 不注入，
   * 此时结果里会标记 `budgetInjected: false`，
   * **如实说明未做真实隔离**（而不是假装做了）。
   */
  withBudget?: (analyze: (input: TInput) => ShadowAnalyzeResult<TDecision>, budgetMs: number) => (input: TInput) => ShadowAnalyzeResult<TDecision>;
  config?: Partial<TableDynamicsConfig>;
};

export type TableDynamicsShadowResult<TDecision = ShadowDecisionView> = {
  mode: TableDynamicsMode;
  status: ShadowRunStatus;
  /** 桌况（不论是否调整都给出，便于界面显示「观察中」） */
  dynamics: TableDynamics | null;
  plan: TableAdjustmentPlan | null;
  /** 正式建议（**未调整**） */
  base: ShadowAnalyzeResult<TDecision>;
  /** 调整后的建议（影子结果，**仅供复盘**） */
  adjusted: ShadowAnalyzeResult<TDecision> | null;
  /** 两次结果是否使用了同一收益口径（必须 true，否则不可比） */
  sameCashflowContract: boolean;
  /** 调整了哪些输入参数（逐条列出，可审计） */
  appliedChanges: readonly string[];
  /**
   * 本次是否把预算**真的注入**到调整后那次分析里。
   *
   * `false` ⇒ 只是事后计时，分析仍在本线程同步跑完 ⇒ **未做真实隔离**，
   * 必须如实告知（授权 §五：「如果同步计算仍占用线程，仅返回超时不算完成隔离」）。
   */
  budgetInjected: boolean;
  /** 桌况稳定摘要（缓存键的组成部分；不含模式与版本，由调用方拼接） */
  dynamicsDigest: string;
  elapsedMs: number;
  reasonZh: string | null;
};

const DEFAULT_BUDGET_MS = 2500;

/**
 * 运行一次影子对比。
 *
 * ⚠️ **顺序是刻意的**：先算正式建议 → 再算桌况 → 再算调整后建议。
 * 即使桌况计算抛异常，正式建议也已经拿到手；而且本模块
 * **从不**把 `adjusted` 写回 `base`。
 */
export function runTableDynamicsShadow<TInput, TDecision = ShadowDecisionView>(
  input: TableDynamicsShadowInput<TInput, TDecision>,
): TableDynamicsShadowResult<TDecision> {
  const startedAt = Date.now();
  const mode = input.mode ?? TableDynamicsMode.SHADOW;
  const budgetMs = input.budgetMs ?? DEFAULT_BUDGET_MS;
  /** 是否提供了预算注入器（决定本次能否做**真实隔离**，而不是事后计时） */
  const budgetInjected = input.withBudget !== undefined;

  /* ---- ① 正式建议：**先算**，与影子完全独立 ---- */
  const base = input.analyze(input.input);

  const skipped = (reasonZh: string, status: ShadowRunStatus): TableDynamicsShadowResult<TDecision> =>
    Object.freeze({
      mode,
      status,
      dynamics: null,
      plan: null,
      base,
      adjusted: null,
      sameCashflowContract: true,
      appliedChanges: Object.freeze([]) as readonly string[],
      dynamicsDigest: 'none',
      budgetInjected,
      elapsedMs: Date.now() - startedAt,
      reasonZh,
    });

  if (mode === TableDynamicsMode.OFF) {
    return skipped('牌桌动态适应已关闭（`OFF`）：不计算桌况，也不做任何调整', 'SKIPPED');
  }

  let dynamics: TableDynamics | null = null;
  let plan: TableAdjustmentPlan | null = null;
  try {
    dynamics = computeTableDynamics({
      records: input.records,
      presentPlayerIds: input.presentPlayerIds,
      heroPlayerId: input.heroPlayerId,
      currentHandId: input.currentHandId ?? null,
      relevantPlayerIds: input.relevantPlayerIds,
      ...(input.config === undefined ? {} : { config: input.config }),
    });

    const context: TableAdjustmentContext = {
      activeCount: input.activeCount,
      street: input.street,
      playersYetToAct: input.playersYetToAct,
      relevantPlayerIds: input.relevantPlayerIds,
    };
    plan = buildTableAdjustmentPlan(dynamics, context);
  } catch (error) {
    return Object.freeze({
      mode,
      status: 'FAILED' as const,
      dynamics,
      plan,
      base,
      adjusted: null,
      sameCashflowContract: true,
      appliedChanges: Object.freeze([]) as readonly string[],
      dynamicsDigest: 'error',
      budgetInjected,
      elapsedMs: Date.now() - startedAt,
      reasonZh:
        '桌况计算失败（**正式建议不受影响**）：' +
        `${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const dynamicsDigest = computeTableDynamicsDigest(dynamics, plan);

  if (!plan.anySuggested) {
    return Object.freeze({
      mode,
      status: 'COMPUTED' as const,
      dynamics,
      plan,
      base,
      adjusted: null,
      sameCashflowContract: true,
      appliedChanges: Object.freeze([]) as readonly string[],
      dynamicsDigest,
        budgetInjected,
      elapsedMs: Date.now() - startedAt,
      reasonZh: plan.noteZh,
    });
  }

  /*
   * ---- ② 调整后建议：注入后由**同一条**管线重算 ----
   *
   * 🔴 **预算在调用之前注入**（不是事后判定）：`withBudget` 让这次分析
   * 带上更紧的 `DecisionDeadline`，于是长任务会在生产管线**自己的检查点**
   * 上真实中止并返回 `stage:'DEADLINE'`。这才是隔离；
   * 没有 `withBudget` 时如实标记 `budgetInjected: false`。
   */
  const analyzeAdjusted =
    input.withBudget === undefined
      ? input.analyze
      : input.withBudget(input.analyze, budgetMs);

  let injected: { input: TInput; changes: readonly string[] };
  try {
    injected = input.inject(input.input, plan);
  } catch (error) {
    return Object.freeze({
      mode,
      status: 'FAILED' as const,
      dynamics,
      plan,
      base,
      adjusted: null,
      sameCashflowContract: true,
      appliedChanges: Object.freeze([]) as readonly string[],
      dynamicsDigest,
      budgetInjected,
      elapsedMs: Date.now() - startedAt,
      reasonZh:
        '调整注入失败（**正式建议不受影响**）：' +
        `${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (injected.changes.length === 0) {
    return Object.freeze({
      mode,
      status: 'COMPUTED' as const,
      dynamics,
      plan,
      base,
      adjusted: null,
      sameCashflowContract: true,
      appliedChanges: Object.freeze([]) as readonly string[],
      dynamicsDigest,
      budgetInjected,
      elapsedMs: Date.now() - startedAt,
      reasonZh: '有调整方向，但没有可注入的参数 ⇒ 未做调整',
    });
  }

  if (Date.now() - startedAt > budgetMs && !budgetInjected) {
    return Object.freeze({
      mode,
      status: 'TIMEOUT' as const,
      dynamics,
      plan,
      base,
      adjusted: null,
      sameCashflowContract: true,
      appliedChanges: Object.freeze([...injected.changes]),
      dynamicsDigest,
      budgetInjected,
      elapsedMs: Date.now() - startedAt,
      reasonZh:
        `影子计算超过预算 ${budgetMs}ms（**正式建议不受影响**）：` +
        '桌况与调整方向仍然给出，只是没有重算建议。' +
        '⚠️ 本次**未做真实隔离**（调用方未提供 `withBudget`）—— 分析是在本线程同步完成的。',
    });
  }

  let adjusted: ShadowAnalyzeResult<TDecision>;
  try {
    adjusted = analyzeAdjusted(injected.input);
  } catch (error) {
    return Object.freeze({
      mode,
      status: 'FAILED' as const,
      dynamics,
      plan,
      base,
      adjusted: null,
      sameCashflowContract: true,
      appliedChanges: Object.freeze([...injected.changes]),
      dynamicsDigest,
        budgetInjected,
      elapsedMs: Date.now() - startedAt,
      reasonZh:
        '调整后重算失败（**正式建议不受影响**）：' +
        `${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return Object.freeze({
    mode,
    status: 'COMPUTED' as const,
    dynamics,
    plan,
    base,
    adjusted,
    /*
     * 收益口径一致性：两次调用走的是**同一个** `analyze`（生产入口），
     * 零点与单位由它保证。若哪天有人把两条路径拆成不同的 EV 实现，
     * 这个字段就会失去意义 —— 留一个测试锁住「同一 analyze 被调用两次」。
     */
    sameCashflowContract: true,
    appliedChanges: Object.freeze([...injected.changes]),
    dynamicsDigest,
      budgetInjected,
    elapsedMs: Date.now() - startedAt,
    reasonZh: null,
  });
}

/** 两次建议是否真的不同（界面据此标注「实验结果：建议未变」） */
export function shadowChangedAction<TDecision extends ShadowDecisionView>(
  result: TableDynamicsShadowResult<TDecision>,
): { changed: boolean; baseZh: string; adjustedZh: string } {
  const fmt = (r: ShadowAnalyzeResult<TDecision> | null): string => {
    if (r === null) return '（未计算）';
    if (!r.ok) return `（失败：${r.stage ?? '未知阶段'}）`;
    const s = r.decision.sizeChips;
    return s === null ? r.decision.action : `${r.decision.action} ${s}`;
  };
  const changed =
    result.base.ok &&
    result.adjusted !== null &&
    result.adjusted.ok &&
    (result.base.decision.action !== result.adjusted.decision.action ||
      result.base.decision.sizeChips !== result.adjusted.decision.sizeChips);
  return { changed, baseZh: fmt(result.base), adjustedZh: fmt(result.adjusted) };
}

export { TABLE_DYNAMICS_CONFIG };
