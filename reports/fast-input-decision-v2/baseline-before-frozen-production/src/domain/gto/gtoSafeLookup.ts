/**
 * GTO 安全查询层 —— 缓存 + 硬超时 + 失败回退
 *
 * ## 这一层解决什么
 *
 * `GtoProvider` 已经保证「失败不抛异常」。但还差三件事才能让 Alpha
 * **真的**不会被拖垮：
 *
 * | 问题 | 本层的对策 |
 * |---|---|
 * | 求解一次要几十秒，界面点一次等不了 | **结果缓存**（按 `scenarioHash`） |
 * | Provider 自己卡住（DNS / 半开连接） | **外层硬超时**（`Promise.race`），到点即回退 |
 * | 上层要写一堆 `if (unavailable)` | 统一返回 `GtoLookupResult`，并提供**永不拒绝**的查询入口 |
 *
 * ## 🔴 缓存键必须包含桌人数
 *
 * 缓存键就是 `scenarioHashOf(scenario)`，而它按构造包含
 * `tableSize` / `effectiveStackBB` / 位置 / 动作历史 / 尺寸 / 盲注。
 * 本层**额外**做一次逐字段比对（`scenariosEquivalent`）：
 * 只比哈希的话，「实现哈希时漏了一个字段」会让 4 人桌的结果被 9 人桌命中，
 * 而这类缺陷在界面上的表现是「范围看起来很正常，只是错了」。
 *
 * ## 🔴 缓存里存的东西**必须**带着它的来源与时间
 *
 * 缓存条目含完整的 `GtoMetadata`（含 `approximationFlags.fromCache = true`），
 * 界面因此能明确显示「这是缓存结果」。绝不出现「看起来像刚算的」。
 */

import {
  GTO_NO_APPROXIMATION,
  GtoSolveStatus,
  type GtoBaseline,
  type GtoLookupResult,
  type GtoMetadata,
  type GtoProvider,
  type GtoScenario,
  type GtoSolveKeyParts,
  type GtoUnavailable,
} from './gto.types.ts';
import {
  scenariosEquivalent,
  scenarioHashOf,
  cacheKeyOf,
  keySchemaVersionOf,
  scenarioFingerprintLines,
} from './gtoScenario.ts';
import {
  GtoQuality,
  gradeGtoQuality,
  verificationForQuality,
  type GtoQualityVerdict,
  type GtoStabilityEvidence,
} from './gtoQuality.ts';
import {
  GtoStrategyStore,
  baselineFromCacheEntry,
  buildCacheEntry,
  keysOf,
  type GtoCacheEntry,
  type GtoStrategyStoreOptions,
} from './gtoStrategyStore.ts';

/** 内存缓存条目 */
type CacheEntry = {
  scenario: GtoScenario;
  /** 🔴 Phase 1.1：内存键从「场景哈希」升级为「缓存键」（含求解设置） */
  cacheKey: string;
  result: GtoLookupResult;
  quality: GtoQualityVerdict | null;
  storedAtMs: number;
};

export type GtoSafeLookupOptions = {
  /** 结果缓存的存活时间（毫秒）；`0` 表示不缓存 */
  cacheTtlMs?: number;
  /** 缓存容量上限（条）；超出时按最近最少使用淘汰 */
  cacheMaxEntries?: number;
  /**
   * **外层**硬超时（毫秒）。
   *
   * 与 Provider 内部的 HTTP 超时是两层：
   * - HTTP 超时管「一次请求」
   * - 外层超时管「整个 lookup（可能包含建树 + 求解 + 走路径多次请求）」
   *
   * 两层都需要：一次求解包含 **多次** HTTP 请求，每次都不超时也可能整体超时。
   */
  hardTimeoutMs?: number;
  /** 注入时钟 */
  now?: () => number;
  /**
   * 🔴 **Phase 1.1**：持久化缓存。
   *
   * `undefined` → 用默认目录（`data/gto-cache`）建一个；
   * `null` → **不启用**持久化（测试与「纯内存」模式）。
   */
  store?: GtoStrategyStore | null;
  /** 持久化存储选项（当 `store` 未给出时使用） */
  storeOptions?: GtoStrategyStoreOptions;
  /**
   * 重复求解稳定性证据（按缓存键索引）。
   *
   * 🔴 这是**外部注入的事实**，不是本类能自己算出来的：
   * 稳定性要靠「同一场景独立求解 ≥2 次并比对」，
   * 那是离线探针（`scripts/gto-stability-probe.ts`）的产物。
   * 没有证据时质量等级**不会**升到 `HIGH_CONFIDENCE`（见 `gtoQuality.ts`）。
   */
  stabilityEvidence?: Readonly<Record<string, GtoStabilityEvidence>>;
};

export const GTO_SAFE_LOOKUP_DEFAULTS = Object.freeze({
  cacheTtlMs: 30 * 60 * 1000,
  cacheMaxEntries: 64,
  hardTimeoutMs: 120_000,
});

/**
 * 一次查询的**统计**（供界面显示「这次的数据是新算的还是缓存」）。
 */
export type GtoLookupStats = {
  /** 是否命中内存缓存 */
  cacheHit: boolean;
  /**
   * 🔴 **Phase 1.1**：数据来自哪里。
   *
   * - `memory` —— 本进程内存缓存
   * - `persistent` —— **本地已缓存策略**（跨进程重启仍然有效）
   * - `solver` —— 本次真的调用了求解器
   * - `none` —— 没拿到数据
   */
  source: 'memory' | 'persistent' | 'solver' | 'none';
  /** 是否因为外层硬超时而回退 */
  timedOut: boolean;
  /** 实际耗时（毫秒）—— 缓存命中时应当远小于冷求解 */
  latencyMs: number;
  /** 内存缓存条目数 */
  cacheSize: number;
  /** 质量等级（拿不到数据时为 `UNAVAILABLE`） */
  quality: GtoQuality;
  /** 缓存键（界面与报告用；拿不到数据时可能为空串） */
  cacheKey: string;
  /**
   * 🔴 **场景哈希**（CACHE KEY GOLDEN VECTOR 轮 · 使用者 §13）。
   *
   * 与 `cacheKey` 的关系见 `gtoScenario.ts` 的三层职责说明：
   * `scenarioHash` = 「我在问哪个问题」，`cacheKey` = 「这份缓存还能用吗」。
   * 空串表示这条记录来自没有键口径的路径（例如求解失败早退）。
   */
  scenarioHash: string;
  /** 🔴 **树指纹** = 「这是同一棵动作树吗」（gap 只在同一棵树内可比） */
  treeId: string;
  /** 🔴 **键口径版本**（`scenario=…;cache=…`）—— 诊断用，不进任何键 */
  keySchemaVersion: string;
  /** 这份数据原本的**求解**耗时（毫秒）；缓存命中时为历史值，冷求解时等于 latencyMs */
  solveDurationMs: number | null;
  /** 缓存写入时间（ISO）；冷求解时为本次时间 */
  cachedAt: string | null;
};

export class GtoSafeLookup {
  private readonly provider: GtoProvider;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private readonly hardTimeoutMs: number;
  private readonly now: () => number;
  private readonly store: GtoStrategyStore | null;
  private readonly storeOptions: GtoStrategyStoreOptions | undefined;
  private readonly stabilityEvidence: Readonly<Record<string, GtoStabilityEvidence>>;
  private readonly cache = new Map<string, CacheEntry>();
  /**
   * 正在求解的任务。
   *
   * 🔴 **必须同时存场景**（CACHE KEY GOLDEN VECTOR 轮 · 使用者 §10）：
   * 键是 32 位非密码学哈希，理论上会碰撞。修复前这里只比键，
   * 于是一个碰撞会让**第二个场景拿到第一个场景的求解结果** —— 静默错答案。
   * 现在复用前先做 `scenariosEquivalent` 逐字段比对：不相等就各自求解。
   */
  private readonly inFlight = new Map<
    string,
    { scenario: GtoScenario; task: Promise<GtoLookupResult> }
  >();
  /** 本次进程内「真的调用了求解器」的次数（报告用） */
  private solverCalls = 0;

  constructor(provider: GtoProvider, options: GtoSafeLookupOptions = {}) {
    this.provider = provider;
    this.cacheTtlMs = options.cacheTtlMs ?? GTO_SAFE_LOOKUP_DEFAULTS.cacheTtlMs;
    this.cacheMaxEntries = options.cacheMaxEntries ?? GTO_SAFE_LOOKUP_DEFAULTS.cacheMaxEntries;
    this.hardTimeoutMs = options.hardTimeoutMs ?? GTO_SAFE_LOOKUP_DEFAULTS.hardTimeoutMs;
    this.now = options.now ?? (() => Date.now());
    this.storeOptions = options.storeOptions;
    this.store =
      options.store === null
        ? null
        : (options.store ?? new GtoStrategyStore(options.storeOptions ?? {}));
    this.stabilityEvidence = options.stabilityEvidence ?? {};
  }

  /** 持久化存储（供报告与预计算脚本使用）；未启用时为 `null` */
  persistentStore(): GtoStrategyStore | null {
    return this.store;
  }

  /**
   * 取某个场景的求解侧参数（供探针 / 报告 / 诊断使用）。
   *
   * ⚠️ 这是**只读**访问：它只转发给 Provider 的 solveKeyParts，
   * 不发起任何请求、不改变任何状态。
   */
  providerSolveKeyParts(scenario: GtoScenario): GtoSolveKeyParts {
    return this.provider.solveKeyParts(scenario);
  }

  /** 本进程内真正调用求解器的次数 */
  solverCallCount(): number {
    return this.solverCalls;
  }

  get engine(): string {
    return this.provider.engine;
  }

  get displayName(): string {
    return this.provider.displayName;
  }

  /** 清空缓存（切换求解器版本 / 手动刷新时调用） */
  clearCache(): void {
    this.cache.clear();
  }

  cacheSize(): number {
    return this.cache.size;
  }

  /**
   * 查询基线。**永不抛异常、永不无限等待。**
   *
   * 返回的统计信息通过 `statsOf()` 单独取（避免污染 `GtoLookupResult` 的形状）。
   */
  async lookup(scenario: GtoScenario): Promise<GtoLookupResult> {
    const result = await this.lookupWithStats(scenario);
    return result.result;
  }

  async lookupWithStats(
    scenario: GtoScenario,
  ): Promise<{ result: GtoLookupResult; stats: GtoLookupStats }> {
    const startedAt = this.now();

    /*
     * 🔴 Phase 1.1：键从「场景哈希」升级为「缓存键」。
     *
     * 求解侧参数由 **Provider** 给出（`solveKeyParts`），因为只有它知道
     * 本机按桌人数标定的迭代数、是否为这张桌子打开全下等。
     * 这样「缓存键描述的那次求解」与「真的发生的那次求解」永远一致。
     */
    let solve: GtoSolveKeyParts;
    try {
      solve = this.provider.solveKeyParts(scenario);
    } catch (error) {
      return {
        result: this.unavailable(
          scenario,
          scenarioHashOf(scenario),
          GtoSolveStatus.FAILED,
          `无法取得求解侧参数，缓存键不可信（已回退，不影响 Alpha）：${(error as Error).message}`,
        ),
        stats: this.emptyStats(startedAt),
      };
    }
    const keys = keysOf(scenario, solve);

    // ---- 1) 内存缓存（**逐字段复核**，不只信键） ----
    const cached = this.cache.get(keys.cacheKey);
    if (cached !== undefined && this.now() - cached.storedAtMs <= this.cacheTtlMs) {
      if (scenariosEquivalent(cached.scenario, scenario)) {
        return {
          result: withCacheFlag(cached.result, 'memory'),
          stats: this.stats({
            source: 'memory',
            timedOut: false,
            startedAt,
            quality: cached.quality?.quality ?? GtoQuality.APPROXIMATE,
            cacheKey: keys.cacheKey,
            solveDurationMs: solveDurationOf(cached.result),
            cachedAt: cachedAtOf(cached.result),
            keys,
          }),
        };
      }
      // 键相同但场景不同 = 键的实现有缺陷。**不信缓存**，并清掉这一条。
      this.cache.delete(keys.cacheKey);
    }

    // ---- 2) 🔴 持久化缓存（跨进程重启仍然有效） ----
    if (this.store !== null) {
      const loaded = this.store.load(keys.cacheKey, {
        scenarioHash: keys.scenarioHash,
        treeId: keys.treeId,
        scenario,
      });
      if (loaded.found) {
        const baseline = baselineFromCacheEntry(loaded.entry, this.now);
        /*
         * 🔴 **读取时按当前证据重新评级**，而不是直接用条目里存的那一份。
         *
         * ## 为什么（这是一个真实踩到的问题）
         *
         * 条目里存的 `quality` 是**写入那一刻**的判定。而稳定性证据是
         * 离线探针**事后**产出的 —— 于是会出现自相矛盾：
         * 「同一份数据，冷求解时显示 LOW_CONVERGENCE，
         *   有证据之后**重新求解**会显示 APPROXIMATE，
         *   但**读缓存**仍然显示 LOW_CONVERGENCE」。
         *
         * ## 为什么这样改是安全的（不会把低质量刷成高质量）
         *
         * `gradeGtoQuality` 是**纯函数**：输入全部来自条目自身已存的元数据
         *（gap / 迭代 / 停止原因 / 目标 / 座位数 / 近似标记）**加上当前的证据表**。
         * 证据表由**离线实测**产出（`data/gto-stability.json`），
         * 不是使用者能改的东西。因此重新评级只会：
         * - 证据补齐后**如实上调**（这正是我们要的）
         * - 证据缺失或漂移大时保持 LOW（安全方向）
         *
         * ⚠️ 条目里那份**原始判定保留不动**（`entry.quality` 及其理由），
         * 因此「写入时判成什么」永远可查 —— 我们只是不用它作为显示值。
         */
        const verdict = this.regradeEntry(loaded.entry);
        this.remember(keys.cacheKey, scenario, baseline, verdict);
        return {
          result: baseline,
          stats: this.stats({
            source: 'persistent',
            timedOut: false,
            startedAt,
            quality: verdict.quality,
            cacheKey: keys.cacheKey,
            solveDurationMs: loaded.entry.solveMeta.solveDurationMs,
            cachedAt: loaded.entry.createdAt,
          }),
        };
      }
    }

    // ---- 3) 合并同一场景的并发请求（in-flight 去重） ----
    //
    // 用户连点同一场景时，**只有一个**真的去求解，其余等同一个 Promise。
    // 键用缓存键：不同的求解设置是两次不同的求解，不应合并。
    const existing = this.inFlight.get(keys.cacheKey);
    if (existing !== undefined && scenariosEquivalent(existing.scenario, scenario)) {
      const shared = await existing.task;
      return {
        result: shared,
        stats: this.stats({
          source: 'none',
          timedOut: false,
          startedAt,
          quality: qualityOfResult(shared),
          cacheKey: keys.cacheKey,
          solveDurationMs: solveDurationOf(shared),
          cachedAt: cachedAtOf(shared),
          keys,
        }),
      };
    }

    // ---- 4) 真的去求解 ----
    this.solverCalls += 1;
    const task = this.runWithHardTimeout(scenario, keys.scenarioHash);
    this.inFlight.set(keys.cacheKey, { scenario, task });

    let result: GtoLookupResult;
    try {
      result = await task;
    } catch {
      // `runWithHardTimeout` 不抛；这里是最后一道保险
      result = this.unavailable(
        scenario,
        keys.scenarioHash,
        GtoSolveStatus.FAILED,
        'GTO 查询内部异常（已回退，不影响 Alpha）',
      );
    } finally {
      this.inFlight.delete(keys.cacheKey);
    }

    const timedOut = 'status' in result && result.cause === GtoSolveStatus.TIMEOUT;

    // ---- 5) 评级 + 写缓存（**失败结果不缓存**） ----
    if ('status' in result) {
      return {
        result,
        stats: this.stats({
          source: 'none',
          timedOut,
          startedAt,
          quality: GtoQuality.UNAVAILABLE,
          cacheKey: keys.cacheKey,
          solveDurationMs: null,
          cachedAt: null,
        }),
      };
    }

    const verdict = this.gradeResult(scenario, solve, result, keys.treeId);
    if (this.cacheTtlMs > 0) this.remember(keys.cacheKey, scenario, result, verdict);
    if (this.store !== null && this.cacheTtlMs > 0) {
      this.persist(scenario, solve, result, verdict, keys, startedAt);
    }

    return {
      result,
      stats: this.stats({
        source: 'solver',
        timedOut,
        startedAt,
        quality: verdict.quality,
        cacheKey: keys.cacheKey,
        solveDurationMs: this.now() - startedAt,
        cachedAt: new Date(this.now()).toISOString(),
        keys,
      }),
    };
  }

  /**
   * 🔴 **只读缓存，绝不求解**（Phase 1.3）。
   *
   * ## 存在的理由
   *
   * `lookupWithStats()` 在缓存未命中时会**一直等到求解结束**（实测 6 人桌
   * 59 秒、9 人桌 195 秒）。对后台任务那是对的，对**前台请求**是灾难：
   * 一次 HTTP 分析请求被拖住三分钟，而 Alpha 的核心指标是「1～3 秒给建议」。
   *
   * 于是把两种需求**从类型上分开**：
   *
   * | 方法 | 缓存未命中时 | 用途 |
   * |---|---|---|
   * | `lookupWithStats` | **去求解**（可能很慢） | 后台补算 / `/api/gto/*` 显式查询 |
   * | `lookupCachedOnly`（本方法） | **立刻返回 `null`** | 前台分析请求 |
   *
   * 「可能很慢」和「一定很快」不该靠调用方记得传预算来区分 ——
   * 那正是本轮修掉的缺陷（预算只卡了第二个对手，第一个照样等到底）。
   *
   * ## 语义
   *
   * 命中内存或持久化缓存 → 返回 `{ result, stats }`（`stats.source` 为
   * `memory` / `persistent`），并**顺带把持久化条目提进内存**（与
   * `lookupWithStats` 一致，避免下一次再读盘）。
   *
   * 未命中 → `null`。**不写缓存、不发请求、不改任何状态。**
   *
   * ⚠️ 返回 `null` 与「缓存里有但场景不等价」是同一种结果：
   * 对调用方而言都只是「现在拿不到」，不需要区分 ——
   * 但键实现有缺陷时（键相同场景不同）会**删掉那条坏缓存**，
   * 免得它继续污染后续查询。
   */
  async lookupCachedOnly(
    scenario: GtoScenario,
  ): Promise<{ result: GtoLookupResult; stats: GtoLookupStats } | null> {
    const startedAt = this.now();

    let solve: GtoSolveKeyParts;
    try {
      solve = this.provider.solveKeyParts(scenario);
    } catch {
      // 键不可信 ⇒ 不去猜缓存，直接当作未命中
      return null;
    }
    const keys = keysOf(scenario, solve);

    // ---- 1) 内存缓存（与 `lookupWithStats` 同一套逐字段复核） ----
    const cached = this.cache.get(keys.cacheKey);
    if (cached !== undefined && this.now() - cached.storedAtMs <= this.cacheTtlMs) {
      if (scenariosEquivalent(cached.scenario, scenario)) {
        return {
          result: withCacheFlag(cached.result, 'memory'),
          stats: this.stats({
            source: 'memory',
            timedOut: false,
            startedAt,
            quality: cached.quality?.quality ?? GtoQuality.APPROXIMATE,
            cacheKey: keys.cacheKey,
            solveDurationMs: solveDurationOf(cached.result),
            cachedAt: cachedAtOf(cached.result),
            keys,
          }),
        };
      }
      this.cache.delete(keys.cacheKey);
    }

    // ---- 2) 持久化缓存 ----
    if (this.store === null) return null;
    const loaded = this.store.load(keys.cacheKey, {
      scenarioHash: keys.scenarioHash,
      treeId: keys.treeId,
      scenario,
    });
    if (!loaded.found) return null;

    const baseline = baselineFromCacheEntry(loaded.entry, this.now);
    const verdict = this.regradeEntry(loaded.entry);
    this.remember(keys.cacheKey, scenario, baseline, verdict);
    return {
      result: baseline,
      stats: this.stats({
        source: 'persistent',
        timedOut: false,
        startedAt,
        quality: verdict.quality,
        cacheKey: keys.cacheKey,
        solveDurationMs: loaded.entry.solveMeta.solveDurationMs,
        cachedAt: loaded.entry.createdAt,
        keys,
      }),
    };
  }

  /** 评级：只看可核查的事实（规则在 `gtoQuality.ts`） */
  private gradeResult(    scenario: GtoScenario,
    solve: GtoSolveKeyParts,
    result: GtoBaseline,
    treeId: string,
  ): GtoQualityVerdict {
    const raw = result.metadata.solveSettings.raw;
    const seatGaps = Array.isArray(raw['gaps']) ? (raw['gaps'] as number[]) : [];
    return gradeGtoQuality({
      hasStrategy: true,
      solverFailed: result.metadata.solveStatus === GtoSolveStatus.FAILED,
      brGapTotal: result.metadata.solveSettings.reportedGap,
      stopReason: typeof raw['stopReason'] === 'string' ? (raw['stopReason'] as string) : null,
      iterations: result.metadata.solveSettings.iterationsCompleted,
      iterationsRequested: result.metadata.solveSettings.iterationsRequested,
      targetGap: result.metadata.solveSettings.targetGap,
      // 本阶段全部座位都在学习（没有冻结/锁定的座位）
      learningSeats: seatGaps.length > 0 ? seatGaps.length : scenario.tableSize,
      totalSeats: scenario.tableSize,
      tableSize: scenario.tableSize,
      approximation: result.metadata.approximation,
      actionCount: result.range.actionMenu.length,
      // 🔴 稳定性证据来自**外部实测**（离线探针），不是这里能自己算的
      stability: this.stabilityEvidence[cacheKeyOf(scenario, solve)] ?? null,
      treeId,
    });
  }

  /**
   * 按**当前证据**重新评定一个缓存条目的质量。
   *
   * 输入**只**来自条目本身已存的元数据 + 当前的证据表 ——
   * 不读求解器、不发请求、不看任何外部状态。因此它是纯函数，
   * 同一份条目在同一次会话里永远得到同一个结论。
   */
  private regradeEntry(entry: GtoCacheEntry): GtoQualityVerdict {
    const scenario = entry.scenario;
    return gradeGtoQuality({
      hasStrategy: true,
      solverFailed: entry.solveMeta.solverState === 'error' || entry.solveMeta.solverState === 'failed',
      brGapTotal: entry.solveMeta.brGapTotal,
      stopReason: entry.solveMeta.stopReason,
      iterations: entry.solveMeta.iterationsCompleted,
      iterationsRequested: entry.solveMeta.iterationsRequested,
      targetGap: entry.solveMeta.targetGap,
      // 缓存的条目里逐座位 gap 的条数 = 当时的座位数
      learningSeats:
        entry.solveMeta.seatGaps.length > 0 ? entry.solveMeta.seatGaps.length : scenario.tableSize,
      totalSeats: scenario.tableSize,
      tableSize: scenario.tableSize,
      approximation: {
        approximateModel: entry.approximationFlags.approximateModel,
        notConverged: entry.approximationFlags.notConverged,
        multiwayContinuation: entry.approximationFlags.multiwayContinuation,
        compressedPrecision: entry.approximationFlags.compressedPrecision,
        fromCache: true,
        notes: entry.approximationFlags.notes,
      },
      actionCount: entry.range.actionMenu.length,
      // 🔴 证据按**缓存键**取；没有就是 null ⇒ 等级停在 LOW_CONVERGENCE
      stability: this.stabilityEvidence[entry.cacheKey] ?? null,
      treeId: entry.treeId,
    });
  }

  /** 写持久化缓存（原子写入；失败只记警告，不影响返回） */
  private persist(
    scenario: GtoScenario,
    solve: GtoSolveKeyParts,
    result: GtoBaseline,
    verdict: GtoQualityVerdict,
    keys: ReturnType<typeof keysOf>,
    startedAt: number,
  ): void {
    if (this.store === null) return;
    const raw = result.metadata.solveSettings.raw;
    const unsolvedDuration = this.now() - startedAt;
    const entry = buildCacheEntry({
      cacheKey: keys.cacheKey,
      treeId: keys.treeId,
      scenario,
      solve,
      baseline: result,
      solveMeta: {
        brGapTotal: result.metadata.solveSettings.reportedGap,
        seatGaps: Array.isArray(raw['gaps']) ? (raw['gaps'] as number[]) : [],
        seatEvs: Array.isArray(raw['evs']) ? (raw['evs'] as number[]) : [],
        stopReason: typeof raw['stopReason'] === 'string' ? (raw['stopReason'] as string) : null,
        solverState: typeof raw['state'] === 'string' ? (raw['state'] as string) : null,
        iterationsCompleted: result.metadata.solveSettings.iterationsCompleted,
        iterationsRequested: result.metadata.solveSettings.iterationsRequested,
        targetGap: result.metadata.solveSettings.targetGap,
        solveDurationMs: unsolvedDuration,
        multiwayEquityModel: result.metadata.solveSettings.modelName,
        realizationNote:
          typeof raw['realizationNote'] === 'string' ? (raw['realizationNote'] as string) : null,
        gpu: raw['gpu'] === true,
      },
      quality: verdict.quality,
      qualitySummaryZh: verdict.summaryZh,
      qualityReasonsZh: verdict.reasonsZh,
      qualityBlockersZh: verdict.blockersZh,
      fingerprintLines: scenarioFingerprintLines(scenario, solve),
      endpoint: result.metadata.source.endpoint,
      unavailableFields: GTOPEN_UNAVAILABLE_FIELDS,
      now: this.now,
    });
    const written = this.store.save(entry);
    if (!written.ok) {
      // 写缓存失败**不影响**本次结果（缓存是加速手段，不是真相来源）
      this.store.warnings.push(`持久化写入失败（不影响本次结果）：${written.reason}`);
    }
  }

  private async runWithHardTimeout(
    scenario: GtoScenario,
    scenarioHash: string,
  ): Promise<GtoLookupResult> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<GtoLookupResult>((resolve) => {
      timer = setTimeout(() => {
        resolve(
          this.unavailable(
            scenario,
            scenarioHash,
            GtoSolveStatus.TIMEOUT,
            `GTO 查询超过外层硬超时 ${this.hardTimeoutMs} ms 已被放弃。` +
              '本次不使用 GTO 数据，Alpha 按原有逻辑继续。' +
              '（GTOpen 的翻前求解在纯 CPU 上可能需要更长时间；可提高 hardTimeoutMs 或减少加注层数。）',
          ),
        );
      }, this.hardTimeoutMs);
    });

    try {
      return await Promise.race([this.provider.lookupScenario(scenario), timeout]);
    } catch (error) {
      return this.unavailable(
        scenario,
        scenarioHash,
        GtoSolveStatus.FAILED,
        `GTO Provider 抛出异常（本层已捕获并回退）：${(error as Error).message}`,
      );
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private remember(
    cacheKey: string,
    scenario: GtoScenario,
    result: GtoLookupResult,
    quality: GtoQualityVerdict | null,
  ): void {
    if (this.cache.size >= this.cacheMaxEntries) {
      // 简单 LRU：删掉最早插入的那条（Map 保持插入顺序）
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(cacheKey, {
      scenario,
      cacheKey,
      result,
      quality,
      storedAtMs: this.now(),
    });
  }

  private emptyStats(startedAt: number): GtoLookupStats {
    return this.stats({
      source: 'none',
      timedOut: false,
      startedAt,
      quality: GtoQuality.UNAVAILABLE,
      cacheKey: '',
      solveDurationMs: null,
      cachedAt: null,
    });
  }

  private stats(input: {
    source: GtoLookupStats['source'];
    timedOut: boolean;
    startedAt: number;
    quality: GtoQuality;
    cacheKey: string;
    solveDurationMs: number | null;
    cachedAt: string | null;
    /**
     * 🔴 **缓存身份诊断**（CACHE KEY GOLDEN VECTOR 轮 · 使用者 §13）。
     *
     * 三把键 + 版本指纹一起暴露，供**开发/测试/报告**核对
     * 「这次为什么命中/为什么没命中」。普通实战界面不显示它们
     *（界面只读 `source` / `quality` / `cacheHit` / `latencyMs`）。
     */
    keys?: { scenarioHash: string; treeId: string; cacheKey: string };
  }): GtoLookupStats {
    return {
      cacheHit: input.source === 'memory' || input.source === 'persistent',
      source: input.source,
      timedOut: input.timedOut,
      latencyMs: this.now() - input.startedAt,
      cacheSize: this.cache.size,
      quality: input.quality,
      cacheKey: input.cacheKey,
      solveDurationMs: input.solveDurationMs,
      cachedAt: input.cachedAt,
      scenarioHash: input.keys?.scenarioHash ?? '',
      treeId: input.keys?.treeId ?? '',
      keySchemaVersion: keySchemaVersionOf(),
    };
  }

  private unavailable(
    scenario: GtoScenario,
    scenarioHash: string,
    cause: GtoSolveStatus,
    message: string,
  ): GtoUnavailable {
    const metadata: GtoMetadata = {
      source: {
        kind: 'SOLVER',
        engine: this.provider.engine,
        sourceVersion: null,
        engineCommit: null,
        endpoint: null,
      },
      scenarioHash,
      solveSettings: {
        iterationsRequested: null,
        iterationsCompleted: null,
        targetGap: null,
        reportedGap: null,
        modelName: null,
        raw: Object.freeze({}),
      },
      solveStatus: GtoSolveStatus.GTO_BASELINE_UNAVAILABLE,
      verification: 'UNVERIFIED',
      approximation: GTO_NO_APPROXIMATION,
      timestamp: new Date(this.now()).toISOString(),
      latencyMs: 0,
    };
    return Object.freeze({
      status: GtoSolveStatus.GTO_BASELINE_UNAVAILABLE,
      cause,
      message,
      scenario,
      scenarioHash,
      metadata,
    });
  }
}

/**
 * 给命中缓存的结果打上 `fromCache` 标记（**新建对象，不改缓存里的那份**）。
 *
 * `source` 决定说明措辞：内存缓存与持久缓存对使用者的含义不同
 *（「本次进程内已读过」vs「本地已缓存策略，可能是几天前算的」），
 * 界面必须能区分。
 */
function withCacheFlag(result: GtoLookupResult, source: 'memory' | 'persistent'): GtoLookupResult {
  if ('status' in result) return result;
  const note =
    source === 'persistent'
      ? '本结果来自**本地已缓存策略**（持久化缓存），不是本次重新求解。'
      : '本结果来自本进程内存缓存（同一次求解的输出），不是重新求解。';
  return {
    ...result,
    metadata: {
      ...result.metadata,
      approximation: {
        ...result.metadata.approximation,
        fromCache: true,
        notes: [...result.metadata.approximation.notes, note],
      },
    },
  };
}

/** 从结果里取「原本的求解耗时」（缓存命中时是历史值） */
function solveDurationOf(result: GtoLookupResult): number | null {
  if ('status' in result) return null;
  const raw = result.metadata.solveSettings.raw;
  return typeof raw['solveDurationMs'] === 'number' ? (raw['solveDurationMs'] as number) : null;
}

/** 从结果里取缓存写入时间 */
function cachedAtOf(result: GtoLookupResult): string | null {
  if ('status' in result) return null;
  const raw = result.metadata.solveSettings.raw;
  return typeof raw['createdAt'] === 'string' ? (raw['createdAt'] as string) : null;
}

/** 从结果里推断质量（用于并发合并的等待方；它拿不到 verdict 对象） */
function qualityOfResult(result: GtoLookupResult): GtoQuality {
  if ('status' in result) return GtoQuality.UNAVAILABLE;
  const raw = result.metadata.solveSettings.raw;
  return typeof raw['quality'] === 'string' ? (raw['quality'] as GtoQuality) : GtoQuality.APPROXIMATE;
}

/**
 * 求解器**没有提供**的字段清单（写进缓存，让「null」与「没给」区分开）。
 *
 * 这一条来自 Phase 1 的实测：GTOpen 的翻前节点接口不返回逐动作 EV，
 * 也没有版本端点。把这两件事写进缓存，是对「禁止编造」的另一种落实 ——
 * 将来有人看到 `evBB: null` 时，能立刻知道原因。
 */
const GTOPEN_UNAVAILABLE_FIELDS: readonly string[] = Object.freeze([
  'evBB（逐动作 EV）—— GTOpen 的翻前节点接口不返回逐手牌、逐动作的 EV；' +
    '只有状态接口给出逐座位总 EV',
  'sourceVersion（求解器版本）—— GTOpen 没有版本端点，能力接口只返回能力布尔值',
  'equity（权益）—— GTOpen 内部有权益表，但没有对外的权益查询接口',
]);


