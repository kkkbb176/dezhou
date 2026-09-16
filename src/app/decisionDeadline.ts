/**
 * 决策时间预算（DecisionDeadline）
 *
 * 规范第 7~9 节：决策速度是硬性系统指标。
 *
 *   最佳      1~2 秒
 *   正常      1~3 秒
 *   较复杂    3~5 秒
 *   极端边缘  5~8 秒
 *   Hard      8 秒 —— 绝对上限
 *
 * 设计要点：
 * 1. **8 秒不是目标时间，是绝对上限。** 任何模块不得独自跑到 10~20 秒。
 * 2. 所有计算模块都能读到「还剩多少时间」，据此选择算法与样本量。
 * 3. 时间来源可注入（`now`），因此**测试里可以用假时钟**验证中止行为，
 *    不需要真的等待 8 秒。
 * 4. 预算耗尽时返回「当前最可靠结论」，而不是继续等待。
 */

/** 时间来源：返回自某个固定起点的毫秒数（默认 performance.now / Date.now） */
export type Clock = () => number;

export const defaultClock: Clock = (() => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return () => performance.now();
  }
  return () => Date.now();
})();

/** 计算模式：影响软/硬预算的默认值 */
export const DeadlineMode = {
  /** 交互式：软 3 秒、硬 8 秒（规范默认） */
  INTERACTIVE: 'INTERACTIVE',
  /** 高精度离线：软 30 秒、硬 120 秒 */
  PRECISION: 'PRECISION',
  /** 验证 / 黄金测试：不受时间限制（仍提供接口，但建议显式传入极大值） */
  VERIFY: 'VERIFY',
  /** 测试：允许极小预算以验证中止路径 */
  TEST: 'TEST',
} as const;
export type DeadlineMode = (typeof DeadlineMode)[keyof typeof DeadlineMode];

export type DeadlineModeDefaults = {
  softMs: number;
  hardMs: number;
};

export const DEADLINE_DEFAULTS: Readonly<Record<DeadlineMode, DeadlineModeDefaults>> = {
  INTERACTIVE: { softMs: 3_000, hardMs: 8_000 },
  PRECISION: { softMs: 30_000, hardMs: 120_000 },
  VERIFY: { softMs: 600_000, hardMs: 900_000 },
  TEST: { softMs: 3_000, hardMs: 8_000 },
};

export type DecisionDeadlineOptions = {
  mode?: DeadlineMode;
  softMs?: number;
  hardMs?: number;
  clock?: Clock;
};

/**
 * 统一时间预算对象。
 *
 * 所有计算模块的签名都可以接受它；模块内部用 `remainingMs()` /
 * `shouldYield()` 决定「还能不能再算一轮」。
 */
export class DecisionDeadline {
  readonly mode: DeadlineMode;
  readonly softMs: number;
  readonly hardMs: number;
  /** 预算起点（毫秒，来自注入的时钟） */
  readonly startTime: number;
  /**
   * 本预算使用的时钟。
   *
   * 暴露出来是为了让**同一个时钟**贯穿整条管线：
   * 管线阶段用假时钟时，PhaseTimer 必须用同一个假时钟，
   * 否则计时结果与预算判断会来自两个不同的时间源（本项目实际踩过这个坑）。
   */
  readonly clock: Clock;

  /** 已被调用方显式标记的「结果已稳定」 */
  private settled = false;

  constructor(options: DecisionDeadlineOptions = {}) {
    this.mode = options.mode ?? DeadlineMode.INTERACTIVE;
    const defaults = DEADLINE_DEFAULTS[this.mode];
    this.softMs = options.softMs ?? defaults.softMs;
    this.hardMs = options.hardMs ?? defaults.hardMs;
    if (this.softMs <= 0) throw new Error(`DecisionDeadline: softMs 必须为正（收到 ${this.softMs}）`);
    if (this.hardMs < this.softMs) {
      throw new Error(
        `DecisionDeadline: hardMs 不得小于 softMs（soft=${this.softMs} hard=${this.hardMs}）`,
      );
    }
    this.clock = options.clock ?? defaultClock;
    this.startTime = this.clock();
  }

  /** 已耗时（毫秒） */
  elapsedMs(): number {
    return this.clock() - this.startTime;
  }

  /** 距离硬上限还剩多少毫秒（可能为负，表示已超时） */
  remainingMs(): number {
    return this.hardMs - this.elapsedMs();
  }

  /** 距离软上限还剩多少毫秒 */
  remainingSoftMs(): number {
    return this.softMs - this.elapsedMs();
  }

  /** 是否已超过软上限（应停止扩大计算规模，开始收敛结论） */
  softExpired(): boolean {
    return this.elapsedMs() >= this.softMs;
  }

  /** 是否已超过硬上限（必须立即结束） */
  hardExpired(): boolean {
    return this.elapsedMs() >= this.hardMs;
  }

  /**
   * 是否可以再启动一轮增量计算。
   *
   * @param estimatedCostMs 预计这一轮要花的毫秒数
   */
  canStartRound(estimatedCostMs = 0): boolean {
    if (this.settled) return false;
    if (this.hardExpired()) return false;
    return this.remainingMs() >= estimatedCostMs;
  }

  /**
   * 判定「本次决策已稳定」。
   * 一旦标记，后续所有 canStartRound 都返回 false —— 阻止为了用满时间而继续算。
   */
  markSettled(): void {
    this.settled = true;
  }

  isSettled(): boolean {
    return this.settled;
  }

  /** 供日志与 Decision Log 使用 */
  snapshot(): {
    mode: DeadlineMode;
    startTime: number;
    softMs: number;
    hardMs: number;
    elapsedMs: number;
    remainingMs: number;
    settled: boolean;
  } {
    return {
      mode: this.mode,
      startTime: this.startTime,
      softMs: this.softMs,
      hardMs: this.hardMs,
      elapsedMs: this.elapsedMs(),
      remainingMs: this.remainingMs(),
      settled: this.settled,
    };
  }
}

/** 便捷构造：交互式默认预算（软 3 秒 / 硬 8 秒） */
export function interactiveDeadline(options: Omit<DecisionDeadlineOptions, 'mode'> = {}): DecisionDeadline {
  return new DecisionDeadline({ ...options, mode: DeadlineMode.INTERACTIVE });
}

/* ============================================================
 * 分阶段耗时记录（规范第 51 条要求记录各模块耗时）
 * ============================================================ */

export type PhaseTimings = {
  validator: number;
  math: number;
  range: number;
  equity: number;
  playerModel: number;
  agents: number;
  total: number;
};

export function emptyPhaseTimings(): PhaseTimings {
  return { validator: 0, math: 0, range: 0, equity: 0, playerModel: 0, agents: 0, total: 0 };
}

/**
 * 简单的分段计时器。
 *
 * 用法：
 *   const timings = new PhaseTimer(deadline.clock);   // 与预算共用同一个时钟
 *   timings.measure('math', () => computePotOdds(...));
 *   timings.finish();
 *   timings.value.total
 *
 * **务必传入与 DecisionDeadline 相同的时钟**，否则预算判断与耗时记录会来自
 * 两个不同的时间源（本项目实际踩过这个坑：管线用假时钟驱动，PhaseTimer 却读真实时钟，
 * 导致阶段耗时全部记成 0）。
 */
export class PhaseTimer {
  private readonly timings: PhaseTimings = emptyPhaseTimings();
  private readonly now: Clock;
  private readonly startedAt: number;

  constructor(clock: Clock = defaultClock) {
    this.now = clock;
    this.startedAt = this.now();
  }

  measure<T>(phase: Exclude<keyof PhaseTimings, 'total'>, fn: () => T): T {
    const begin = this.now();
    try {
      return fn();
    } finally {
      this.timings[phase] += this.now() - begin;
    }
  }

  /** 记录一个已知耗时（例如子模块内部已测过） */
  add(phase: Exclude<keyof PhaseTimings, 'total'>, ms: number): void {
    this.timings[phase] += ms;
  }

  value(): PhaseTimings {
    return { ...this.timings, total: this.timings.total };
  }

  finish(): PhaseTimings {
    this.timings.total = this.now() - this.startedAt;
    return this.value();
  }
}
