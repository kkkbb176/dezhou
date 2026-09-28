import { Worker } from 'node:worker_threads';
import type { AnalysisWork, AnalysisWorkResult } from './analysisWork.ts';

export class AnalysisSchedulingError extends Error {
  readonly code: 'ANALYSIS_CANCELLED' | 'ANALYSIS_BUSY';
  constructor(code: 'ANALYSIS_CANCELLED' | 'ANALYSIS_BUSY', message: string) {
    super(message);
    this.code = code;
  }
}

export type ScheduledAnalysis = {
  output: AnalysisWorkResult;
  timings: { queueMs: number; prepareMs: number; computeMs: number; workerMs: number };
};

type Job = {
  key: string;
  prepare: () => Promise<AnalysisWork>;
  resolve: (result: ScheduledAnalysis) => void;
  reject: (error: Error) => void;
  queuedAt: number;
  cancelled: boolean;
  worker?: Worker;
  computing?: boolean;
  detach: () => void;
};

/** One CPU worker and one replacement slot. Termination completes before reuse.
 * No CPU budgets, sample counts, ranges or model settings are changed here.
 * Cache/network preparation stays in the server's existing process/singletons.
 */
export class AnalysisScheduler {
  private active: Job | null = null;
  private pending: Job | null = null;
  private stopped = false;
  private cancellations = 0;
  private completed = 0;

  stats() {
    return { active: Number(this.active !== null), computing: Boolean(this.active?.computing), pending: Number(this.pending !== null),
      cancellations: this.cancellations, completed: this.completed, maxWorkers: 1, maxPending: 1 };
  }

  run(key: string, prepare: () => Promise<AnalysisWork>, signal: AbortSignal): Promise<ScheduledAnalysis> {
    if (signal.aborted || this.stopped) return Promise.reject(this.cancelError());
    this.cancel(key);
    // A different table cannot accumulate a backlog behind somebody else's replacement.
    if (this.pending !== null) return Promise.reject(new AnalysisSchedulingError('ANALYSIS_BUSY', '分析队列已满，请稍后重试'));
    return new Promise((resolve, reject) => {
      const job: Job = { key, prepare, resolve, reject, queuedAt: performance.now(), cancelled: false, detach: () => {} };
      const onAbort = () => this.cancelJob(job);
      signal.addEventListener('abort', onAbort, { once: true });
      job.detach = () => signal.removeEventListener('abort', onAbort);
      this.pending = job;
      this.pump();
    });
  }

  cancel(key: string): void {
    if (this.pending?.key === key) this.cancelJob(this.pending);
    if (this.active?.key === key) this.cancelJob(this.active);
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.pending) this.cancelJob(this.pending);
    const active = this.active;
    if (active) {
      this.cancelJob(active);
      if (active.worker) await active.worker.terminate();
    }
  }

  private cancelError() { return new AnalysisSchedulingError('ANALYSIS_CANCELLED', '本次分析已取消或被更新的牌桌状态取代'); }

  private cancelJob(job: Job) {
    if (job.cancelled) return;
    job.cancelled = true;
    this.cancellations += 1;
    job.detach();
    job.reject(this.cancelError());
    if (this.pending === job) this.pending = null;
    // Worker termination actually interrupts synchronous computation. Merely discarding
    // the HTTP response or aborting fetch cannot stop CPU work in the pipeline.
    if (job.worker) void job.worker.terminate();
  }

  private pump() {
    if (this.stopped || this.active || !this.pending) return;
    const job = this.pending;
    this.pending = null;
    this.active = job;
    void this.execute(job);
  }

  private async execute(job: Job) {
    const preparingAt = performance.now();
    try {
      const work = await job.prepare();
      if (job.cancelled || this.stopped) return;
      const started = performance.now();
      const queueMs = preparingAt - job.queuedAt;
      const prepareMs = started - preparingAt;
      // --input-type describes the parent's eval/stdin entry, not a file worker.
      // Preserve other runtime flags (notably TypeScript stripping).
      const worker = new Worker(new URL('./analysisWorker.ts', import.meta.url), {
        // A test runner can expand execArgv with main-process-only V8 flags;
        // eval launchers can add --input-type. Neither belongs in a file worker.
        // This TS worker needs only the project's existing strip-types runtime.
        workerData: work, execArgv: ['--experimental-strip-types'],
      });
      job.worker = worker;
      await new Promise<void>((resolve, reject) => {
        let received = false;
        worker.on('message', (message) => {
          if (message.kind === 'started') { job.computing = true; return; }
          received = true;
          if (job.cancelled) return;
          if (!message.ok) { job.reject(new Error(message.message)); return; }
          this.completed += 1;
          job.resolve({ output: message.output, timings: {
            queueMs, prepareMs, computeMs: message.computeMs, workerMs: performance.now() - started,
          } });
        });
        worker.once('error', reject);
        worker.once('exit', (code) => {
          if (!received && !job.cancelled) reject(new Error(`Analysis worker exited without output (${code})`));
          else resolve();
        });
      });
    } catch (error) {
      if (!job.cancelled) job.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      job.detach();
      // Even after a message, retain the slot until the worker has actually exited.
      if (this.active === job) this.active = null;
      this.pump();
    }
  }
}
