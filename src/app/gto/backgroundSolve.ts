/**
 * 后台求解队列（Phase 1.3）
 *
 * ## 这个模块解决什么问题
 *
 * 实测（2026-09，`92c86ed`）：
 *
 * | 桌人数 | 冷求解耗时 |
 * |---|---|
 * | 6 人桌 | ~59 秒 |
 * | 9 人桌 | ~195 秒 |
 *
 * 而 Alpha 的核心指标是「**1～3 秒给建议**」。这两个数字**不可能同时满足** ——
 * 因此唯一诚实的做法是把它们**分成两件事**：
 *
 * ```text
 * 给建议（同步、快）          算 GTO（异步、慢）
 *   ↓                            ↓
 * 立刻用启发式范围作答          后台求解并落盘
 * 并如实标注「GTO 正在计算」    完成后**自动**写进持久化缓存
 * ```
 *
 * 于是同一个场景：第一次查询用启发式 + 一句诚实的说明，
 * 第二次查询（几十秒后）**永久**命中 GTO 范围。使用者不需要做任何操作。
 *
 * ## 🔴 三条纪律
 *
 * ### 1. 后台任务**绝不**影响前台响应
 *
 * 这里入队的 Promise **不被任何请求 `await`**。调用方拿到的是一个
 * 「已入队」的状态对象，不是求解结果 —— 从类型上就杜绝了
 * 「不小心把它 await 了」这种把界面拖死 3 分钟的写法。
 *
 * ### 2. 同一场景**只算一次**
 *
 * 按 `cacheKey` 去重（复用 `GtoProvider.solveKeyParts`，
 * 因此「不同求解设置」= 两次不同求解，不会被错误合并）。
 * 连续点十次同一个场景，只会产生一次求解。
 *
 * ### 3. **失败也要如实记账**
 *
 * 失败结果**不进缓存**（那是 `GtoSafeLookup` 的既有纪律），
 * 但失败**原因**记在这里，供下一次响应如实显示 ——
 * 「为什么这条建议用的是启发式范围」必须能回答，
 * 而不是让使用者看到一个没有解释的「启发式」标签。
 */

import type { GtoProvider, GtoScenario } from '../../domain/gto/gto.types.ts';
import { GtoSolveStatus, GtoScenarioKind } from '../../domain/gto/gto.types.ts';
import { keysOf } from '../../domain/gto/gtoScenario.ts';
import { POSITION_ZH } from '../manualInput/manualInput.ts';
import type { GtoPosition } from '../../domain/gto/gto.types.ts';

/**
 * 后台求解**真正要调用的东西**。
 *
 * 🔴 为什么不是 `GtoProvider`：
 *
 * 求解完**必须落盘**，而下盘只发生在 `GtoSafeLookup.lookupWithStats()` 里
 *（第 5 步：`this.persist(...)`）。直接调 `provider.lookupScenario()`
 * 会「算完了，但没存」—— 那等于每次重启都要重算几十分钟，
 * 正是本模块要消灭的那个问题。
 *
 * 因此这里要求传入**带缓存的那一层**。类型只声明我们用到的那一个方法，
 * 于是测试可以注入一个轻量替身，而不必构造整个 `GtoSafeLookup`。
 */
export type BackgroundSolveLookup = {
  /** 只读缓存（命中则后台不用再算一遍）—— 可选，省略时每次都真算 */
  lookupCachedOnly?(scenario: GtoScenario): Promise<{
    result: import('../../domain/gto/gto.types.ts').GtoLookupResult;
  } | null>;
  /**
   * 🔴 **求解设置核对**（可选）。
   *
   * 与前台用的是**同一条闸** —— 前提对不上（例如观察到的开池尺寸
   * 与求解配置不一致）时，这份数据描述的是**另一个牌局**，
   * 前台不会用它，后台也就**不该**把它标成 `DONE`（标了会让该场景
   * 因去重而**永不重算**，一份坏数据被永久钉死）。
   */
  checkSettings?(scenario: GtoScenario): { ok: true } | { ok: false; reasonZh: string };
  lookupWithStats(scenario: GtoScenario): Promise<{
    result: import('../../domain/gto/gto.types.ts').GtoLookupResult;
  }>;
};

/* ============================================================
 * 类型
 * ============================================================ */

/** 一个后台求解任务的状态 */
export const BackgroundSolveState = {
  /** 已入队，还没轮到 */
  QUEUED: 'QUEUED',
  /** 正在求解 */
  RUNNING: 'RUNNING',
  /** 求解成功（**已落盘**，下次查询命中缓存） */
  DONE: 'DONE',
  /** 求解失败（原因在 `reasonZh`；失败结果不落盘） */
  FAILED: 'FAILED',
} as const;
export type BackgroundSolveState =
  (typeof BackgroundSolveState)[keyof typeof BackgroundSolveState];

export type BackgroundSolveRecord = {
  /** 缓存键 —— 与 `GtoStrategyStore` 落盘用的键**同一个**（不是另算一份） */
  cacheKey: string;
  scenarioHash: string;
  thingZh: string;
  state: BackgroundSolveState;
  /** 入队时刻（Unix 毫秒） */
  queuedAtMs: number;
  /** 开始求解时刻；未开始为 `null` */
  startedAtMs: number | null;
  /** 结束时刻；未结束为 `null` */
  finishedAtMs: number | null;
  /** 本次求解实际耗时；未结束为 `null` */
  durationMs: number | null;
  /** 迭代数（求解器如实报告的值） */
  iterationsCompleted: number | null;
  /** BR gap（求解器如实报告的值） */
  reportedGap: number | null;
  /** 失败原因（中文，可直接显示）；成功时为 `null` */
  reasonZh: string | null;
  /**
   * 失败类别（可选）。
   *
   * ⚠️ 存在理由：`SETTINGS_MISMATCH` 与「求解器坏了」对使用者意味着
   * **完全不同的事**（前者等也不会好、也**不该**提示去查求解器）。
   * 只靠中文文案区分会让界面被迫做字符串匹配，而那是踩过的坑。
   */
  reasonKind?: 'SETTINGS_MISMATCH' | 'SOLVER' | 'UNKEYABLE' | 'QUEUE_SUPERSEDED';
};

/**
 * 场景的**人类可读名字**（用于「正在计算：6 人桌 枪口位 开池」这样的提示）。
 *
 * ⚠️ 只用于**显示**，绝不参与任何判定 —— 判定一律走 `cacheKey`。
 */
export function describeScenarioThingZh(scenario: GtoScenario): string {
  const sizeZh = `${scenario.tableSize} 人桌`;
  const positionZh = POSITION_ZH[scenario.heroPosition as GtoPosition] ?? scenario.heroPosition;
  return `${sizeZh} ${positionZh} ${kindZh(scenario.kind)}`;
}

function kindZh(kind: GtoScenarioKind): string {
  switch (kind) {
    case GtoScenarioKind.RFI:
      return '开池';
    case GtoScenarioKind.VS_OPEN:
      return '面对开池';
    case GtoScenarioKind.THREE_BET:
      return '3Bet';
    case GtoScenarioKind.VS_3BET:
      return '面对 3Bet';
    case GtoScenarioKind.VS_4BET:
      return '面对 4Bet';
    case GtoScenarioKind.LIMPED:
      return '跛入池';
    default:
      return '场景';
  }
}

/* ============================================================
 * 队列
 * ============================================================ */

export type BackgroundSolveQueueOptions = {
  /**
   * 同时最多几个求解在跑。
   *
   * ⚠️ 默认 **1** —— 不是因为保守，而是因为**底层本来就是串行的**：
   * `GtopenProvider.enqueue()` 会把所有求解排成一条链
   *（求解器自己也在一个会话上迭代，并发提交没有意义，
   *  而且 409 会让后来者拿不到数据）。
   *
   * 因此这里设成 1 只是把「实际上串行」这个事实**写明**，
   * 顺带让队列长度成为可观测的量。
   */
  concurrency?: number;
  /** 正在运行的任务之外最多保留几个等待任务；满时由最新局面替换最旧等待项。 */
  maxPending?: number;
  /** 单个任务的硬上限；省略则用 `GtoSafeLookup` 自己的超时 */
  now?: () => number;
};

type QueueEntry = {
  cacheKey: string;
  run: () => void;
};

export class BackgroundSolveQueue {
  private readonly concurrency: number;
  private readonly maxPending: number;
  private readonly now: () => number;

  /** 待跑（含正在跑）的队列 */
  private readonly waiting: QueueEntry[] = [];
  private running = 0;

  /** cacheKey → 状态。**保留失败记录**，供后续响应如实解释 */
  private readonly records = new Map<string, BackgroundSolveRecord>();

  constructor(options: BackgroundSolveQueueOptions = {}) {
    const concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`后台求解并发数必须是 >= 1 的整数，收到 ${String(concurrency)}`);
    }
    const maxPending = options.maxPending ?? 8;
    if (!Number.isInteger(maxPending) || maxPending < 1) {
      throw new Error(`后台求解等待上限必须是 >= 1 的整数，收到 ${String(maxPending)}`);
    }
    this.concurrency = concurrency;
    this.maxPending = maxPending;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 入队一个求解。
   *
   * 🔴 **返回的是入队后的状态对象，不是求解结果** ——
   * 调用方无法（也不应该）等待它完成。
   *
   * 同一个 `cacheKey` 已在队列里（或已完成）时**不重复入队**。
   */
  submit(provider: GtoProvider, lookup: BackgroundSolveLookup, scenario: GtoScenario): BackgroundSolveRecord {
    let cacheKey: string;
    let scenarioHash: string;
    try {
      /*
       * ⚠️ 用 `keysOf`（一次算三把键的**权威**入口），不自己拼口径 ——
       * 这里只需要 `cacheKey` 与 `scenarioHash`，但口径必须与落盘那一份一致，
       * 否则会出现「后台算完了、却写在一个前台永远查不到的键上」。
       */
      const keys = keysOf(scenario, provider.solveKeyParts(scenario));
      cacheKey = keys.cacheKey;
      scenarioHash = keys.scenarioHash;
    } catch (error) {
      /*
       * 拿不到求解侧参数 = 缓存键不可信 ⇒ **不入队**。
       * 这与 `GtoSafeLookup` 的处理一致：键不可信时不去求解，
       * 因为算完也无法按正确的键落盘（那等于算了个寂寞）。
       */
      const failedKey = `unkeyable:${String((error as Error).message)}`;
      const record: BackgroundSolveRecord = {
        cacheKey: failedKey,
        scenarioHash: '',
        thingZh: describeScenarioThingZh(scenario),
        state: BackgroundSolveState.FAILED,
        queuedAtMs: this.now(),
        startedAtMs: null,
        finishedAtMs: this.now(),
        durationMs: 0,
        iterationsCompleted: null,
        reportedGap: null,
        reasonZh: `无法取得求解侧参数，缓存键不可信，已放弃后台求解：${(error as Error).message}`,
        reasonKind: 'UNKEYABLE',
      };
      this.records.set(failedKey, record);
      return record;
    }

    const existing = this.records.get(cacheKey);
    if (existing !== undefined) {
      /*
       * 已经有记录 —— 三件事都不做：
       * - `DONE`：已经有结果了（而且大概率已落盘），再算一次纯属浪费
       * - `QUEUED` / `RUNNING`：已经在算，重复入队只会让队列变长
       * - `FAILED`：**也不重试**。理由：失败大多是「求解器离线 / 超时」，
       *   那是环境问题，紧接着重试几乎必然再失败一次，
       *   而每失败一次就占着那条串行队列几十分钟。
       *   要重试，重启服务即可（记录在进程内存里）。
       */
      return existing;
    }

    const record: BackgroundSolveRecord = {
      cacheKey,
      scenarioHash,
      thingZh: describeScenarioThingZh(scenario),
      state: BackgroundSolveState.QUEUED,
      queuedAtMs: this.now(),
      startedAtMs: null,
      finishedAtMs: null,
      durationMs: null,
      iterationsCompleted: null,
      reportedGap: null,
      reasonZh: null,
    };
    this.records.set(cacheKey, record);

    if (this.waiting.length >= this.maxPending) {
      const superseded = this.waiting.shift();
      const old = superseded === undefined ? undefined : this.records.get(superseded.cacheKey);
      if (old !== undefined && old.state === BackgroundSolveState.QUEUED) {
        old.state = BackgroundSolveState.FAILED;
        old.reasonKind = 'QUEUE_SUPERSEDED';
        old.reasonZh = '等待队列已满，已由更新的牌桌局面取代；未启动本次后台求解。';
        old.finishedAtMs = this.now();
        old.durationMs = 0;
      }
    }
    this.waiting.push({
      cacheKey,
      run: () => {
        void this.execute(lookup, scenario, cacheKey);
      },
    });
    this.pump();
    return record;
  }

  /** 记录状态查询（不触发任何求解） */
  statusOf(cacheKey: string): BackgroundSolveRecord | null {
    return this.records.get(cacheKey) ?? null;
  }

  /** 全部记录快照（含失败），用于界面与诊断 */
  all(): readonly BackgroundSolveRecord[] {
    return [...this.records.values()];
  }

  /** 正在排队 / 正在跑的任务（用于「GTO 正在计算」这类提示） */
  active(): readonly BackgroundSolveRecord[] {
    return this.all().filter(
      (r) =>
        r.state === BackgroundSolveState.QUEUED || r.state === BackgroundSolveState.RUNNING,
    );
  }

  pendingCount(): number {
    return this.active().length;
  }

  /** 队列里还有几个没轮到 */
  queueDepth(): number {
    return this.waiting.length;
  }

  private pump(): void {
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const entry = this.waiting.shift()!;
      this.running += 1;
      try {
        entry.run();
      } catch {
        // `run` 内部已经兜住一切；这里是最后一道保险
        this.running -= 1;
      }
    }
  }

  /**
   * 真正跑一次求解。
   *
   * 🔴 **绝不抛异常**：任何失败都变成记录上的一条中文 `reasonZh`。
   * 后台任务抛出的异常没有人接，会变成 unhandled rejection 并**可能杀掉进程** ——
   * 那是「为了加速 GTO 反而把 Alpha 弄崩」，绝对不可接受。
   */
  private async execute(
    lookup: BackgroundSolveLookup,
    scenario: GtoScenario,
    cacheKey: string,
  ): Promise<void> {
    const record = this.records.get(cacheKey);
    if (record === undefined) {
      this.finishSlot();
      return;
    }

    record.state = BackgroundSolveState.RUNNING;
    record.startedAtMs = this.now();

    try {
      /*
       * 🔴 **先核对求解设置，再决定要不要算 —— 判据必须与前台一致。**
       *
       * 本队列的记录是**进程内存**，服务重启后就空了；而磁盘缓存是
       * **跨进程持久**的。于是重启后第一次请求会出现：前台明明命中了缓存
       * （`fromSolver=true`），后台却**又在算一遍同一个场景** ——
       * 白烧几十秒到几分钟 CPU，而且它占着那条串行队列，
       * 把后面真正需要的场景全堵住。
       *
       * ⚠️ 但「读到了」不等于「能用」：前台还有一道 `solveSettingsMatch`
       *（尺寸对不上就拒绝）。这道短路**必须用同一条闸** ——
       * 否则盘上那些「前台判定不可用」的条目会被这里标成 `DONE`，
       * 而 `DONE` 会让本场景**永不重算**，于是一份错数据被永久钉死。
       *
       * 调用方（`queueBackgroundSolverRanges`）已经先筛过一遍；
       * 这里再查一次是**防御性**的：将来多一个调用方忘了筛，
       * 也不会把不可用条目钉成 DONE。
       */
      const verdict = lookup.checkSettings?.(scenario);
      if (verdict !== undefined && !verdict.ok) {
        record.state = BackgroundSolveState.FAILED;
        record.reasonKind = 'SETTINGS_MISMATCH';
        record.reasonZh = verdict.reasonZh;
        return;
      }

      const cached = await lookup.lookupCachedOnly?.(scenario);
      if (cached !== null && cached !== undefined && !('status' in cached.result)) {
        record.state = BackgroundSolveState.DONE;
        record.iterationsCompleted = cached.result.metadata.solveSettings.iterationsCompleted;
        record.reportedGap = cached.result.metadata.solveSettings.reportedGap;
        record.reasonZh = null;
        return;
      }

      /*
       * ⚠️ 走 `lookupWithStats`（带缓存那一层），不是 `provider.lookupScenario`。
       * 前者会在成功时**落盘**，这正是「第二次查询秒回」的全部依据。
       */
      const { result } = await lookup.lookupWithStats(scenario);

      if ('status' in result) {
        record.state = BackgroundSolveState.FAILED;
        record.reasonKind = 'SOLVER';
        record.reasonZh =
          result.status === GtoSolveStatus.GTO_BASELINE_UNAVAILABLE
            ? `求解器不可用（${result.cause}）：${result.message}`
            : result.message;
      } else {
        record.state = BackgroundSolveState.DONE;
        record.iterationsCompleted = result.metadata.solveSettings.iterationsCompleted;
        record.reportedGap = result.metadata.solveSettings.reportedGap;
      }
    } catch (error) {
      record.state = BackgroundSolveState.FAILED;
      record.reasonKind = 'SOLVER';
      record.reasonZh = `后台求解抛错（已捕获，不影响 Alpha）：${String((error as Error).message)}`;
    } finally {
      record.finishedAtMs = this.now();
      record.durationMs =
        record.startedAtMs === null ? null : record.finishedAtMs - record.startedAtMs;
      this.finishSlot();
    }
  }

  private finishSlot(): void {
    this.running = Math.max(0, this.running - 1);
    this.pump();
  }

  /** 清空（测试用） */
  reset(): void {
    this.waiting.length = 0;
    this.running = 0;
    this.records.clear();
  }
}

/* ============================================================
 * 单例
 * ============================================================ */

let queue: BackgroundSolveQueue | null = null;

/** 取（或惰性创建）后台求解队列 */
export function backgroundSolveQueue(): BackgroundSolveQueue {
  if (queue === null) queue = new BackgroundSolveQueue();
  return queue;
}

/** 重置单例（测试用） */
export function resetBackgroundSolveQueueForTests(next?: BackgroundSolveQueue): void {
  queue = next ?? null;
}
