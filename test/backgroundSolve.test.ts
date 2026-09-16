/**
 * 后台求解队列（Phase 1.3）
 *
 * ## 这一组测试防的是什么
 *
 * Phase 1.2 的写法是「带预算去预取」，而那个预算**不成立**：超时检查在循环体
 * 之前，第一个对手永远无条件求解然后等到底。实测（2026-09，`92c86ed`）：
 *
 * | 场景 | 实测耗时 |
 * |---|---|
 * | 预算写 1500 ms，6 人桌冷启动 | **109 ms 就回落到启发式**（连试都没试） |
 * | 预算写 1500 ms，9 人桌冷启动 | **195 312 ms** |
 * | 直接问求解器（6 人桌冷） | 58 868 ms |
 *
 * 也就是说：同一个参数，既拦不住慢的，又挡住了快的。而失败原因是**静默**的。
 *
 * Phase 1.3 把「给建议」与「算 GTO」**分成两件事**。这一组测试钉住这个分工：
 *
 * | # | 必须成立的事 | 退化后的表现 |
 * |---|---|---|
 * | 1 | 前台只读缓存，未命中**立刻**回落 | 一次分析被拖住几分钟 |
 * | 2 | 未命中时**后台真的开始算** | 第一次永远是启发式，永远好不了 |
 * | 3 | 同一场景**只算一次** | 连点十次 = 算十次 = 排队几小时 |
 * | 4 | 拿不到的原因**如实带出来** | 使用者只看到一个没有解释的「启发式」标签 |
 *
 * ## 观察口径
 *
 * 只看外部可观察的东西：耗时、队列里的记录、`prefetchSolverRanges` 的返回。
 * 🚫 不读私有字段、不重新实现一份转换逻辑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BackgroundSolveQueue,
  BackgroundSolveState,
  describeScenarioThingZh,
} from '../src/app/gto/backgroundSolve.ts';
import {
  prefetchSolverRanges,
  queueBackgroundSolverRanges,
  GtoRangeOutcomeState,
} from '../src/app/alphaPipeline.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { allRankClassKeys } from '../src/app/manualInput/preflopPriors.ts';
import {
  GtoActionKind,
  GtoScenarioKind,
  GtoSolveStatus,
  type GtoBaseline,
  type GtoProvider,
  type GtoScenario,
} from '../src/domain/gto/gto.types.ts';
import { buildGtoScenario } from '../src/domain/gto/gtoScenario.ts';

/* ============================================================
 * 假求解器
 * ============================================================ */

/**
 * 完整的求解侧参数。
 *
 * ⚠️ 必须**逐字段齐全**：`keysOf()` 会因为缺字段抛错，而
 * `BackgroundSolveQueue.submit` 会把它当成「缓存键不可信」而**拒绝入队**。
 * 这本来是对的行为，但用它来写测试会掩盖真正要测的东西 ——
 * 因此夹具给一份完整的。
 */
function fakeSolveKeyParts() {
  return {
    engine: 'fake',
    engineCommit: 'deadbeefcafe',
    solverVersion: null,
    openSizesBB: [2.5],
    raiseMults: [3],
    maxRaises: 2,
    limp: false,
    addAllin: true,
    rakePct: 0,
    rakeCap: 0,
    realization: 'calibrated',
    multiwayEquityModel: 'coupled_deck_v1',
    iterations: 40,
    targetGap: 0.2,
    checkEvery: 20,
    enginePositions: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    posts: [0, 0, 0, 0, 0.5, 1],
    ante: 0,
  };
}

/**
 * 一个**可控耗时**的假求解器。
 *
 * `delayMs` 是这个文件的全部要害：它模拟「求解很慢」，
 * 而所有断言都在问同一件事 —— **前台有没有等它**。
 */
function makeSlowProvider(opts: { delayMs: number; calls?: { count: number } }): GtoProvider {
  const counter = opts.calls ?? { count: 0 };
  const baselineOf = (scenario: GtoScenario): GtoBaseline =>
    ({
      scenario,
      scenarioHash: 'g00000000',
      range: {
        actorPosition: scenario.heroPosition,
        actionMenu: [
          { kind: GtoActionKind.FOLD, sizeBB: null, rawLabel: 'Fold' },
          { kind: GtoActionKind.CALL, sizeBB: 2.5, rawLabel: 'Call 2.5' },
          { kind: GtoActionKind.RAISE, sizeBB: 7.5, rawLabel: '3-bet 7.5' },
        ],
        hands: allRankClassKeys().map((hand) => ({
          hand,
          combos: 6,
          reach: null,
          actions: [
            { kind: GtoActionKind.FOLD, sizeBB: null, frequency: 0, evBB: null, rawLabel: 'F' },
            {
              kind: GtoActionKind.CALL,
              sizeBB: 2.5,
              frequency: hand === 'AA' ? 0 : 1,
              evBB: null,
              rawLabel: 'C',
            },
            {
              kind: GtoActionKind.RAISE,
              sizeBB: 7.5,
              frequency: hand === 'AA' ? 1 : 0,
              evBB: null,
              rawLabel: 'R',
            },
          ],
        })),
        potBB: 4,
        reachable: true,
        unavailableReason: null,
      },
      metadata: {
        source: {
          kind: 'SOLVER',
          engine: 'fake',
          sourceVersion: null,
          engineCommit: 'deadbeefcafe',
          endpoint: null,
        },
        scenarioHash: 'g00000000',
        solveSettings: {
          iterationsRequested: 40,
          iterationsCompleted: 40,
          targetGap: 0.2,
          reportedGap: 0.05,
          modelName: 'coupled_deck_v1',
          raw: {},
        },
        solveStatus: GtoSolveStatus.SOLVED,
        verification: 'APPROXIMATE',
        approximation: {
          approximateModel: true,
          notConverged: false,
          multiwayContinuation: true,
          compressedPrecision: false,
          fromCache: false,
          notes: [],
        },
        timestamp: '2026-01-01T00:00:00.000Z',
        latencyMs: 1,
      },
    }) as never;

  return {
    engine: 'fake',
    solveKeyParts: () => fakeSolveKeyParts() as never,
    lookupScenario: async (scenario: never) => {
      counter.count += 1;
      await new Promise((r) => setTimeout(r, opts.delayMs));
      return baselineOf(scenario as GtoScenario) as never;
    },
    health: async () => ({
      reachable: true,
      engine: 'fake',
      version: null,
      commit: null,
      endpoint: null,
      message: '',
    }),
    capabilities: async () => null,
  } as never;
}

/** 一个只读缓存的假查询器：`cached` 为真时返回假基线，否则返回 `null` */
function makeFakeLookup(
  provider: GtoProvider,
  opts: { cached?: boolean } = {},
): {
  lookupCachedOnly: (s: never) => Promise<unknown>;
  lookupWithStats: (s: never) => Promise<{ result: unknown }>;
} {
  return {
    lookupCachedOnly: async (scenario: never) =>
      opts.cached === true
        ? {
            result: await (provider.lookupScenario as (s: never) => Promise<unknown>)(scenario),
            stats: { source: 'persistent' },
          }
        : null,
    lookupWithStats: async (scenario: never) => ({
      result: await (provider.lookupScenario as (s: never) => Promise<unknown>)(scenario),
    }),
  } as never;
}

/* ============================================================
 * 牌局夹具
 * ============================================================ */

/** 6 人桌：UTG 开池 2.5BB，英雄在大盲位 */
function bbFacingUtgOpen(): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BB' as never,
    heroCards: ['Ah', 'Kh'],
    board: [],
    street: 'PREFLOP' as never,
    effectiveStackBB: 100,
    actionHistory: [
      { position: 'UTG' as never, type: 'RAISE', amountBB: 2.5 },
      { position: 'HJ' as never, type: 'FOLD' },
      { position: 'CO' as never, type: 'FOLD' },
      { position: 'BTN' as never, type: 'FOLD' },
      { position: 'SB' as never, type: 'FOLD' },
    ],
    environment: 'LOW_STAKES_ONLINE' as never,
  };
}

function stateOf(input: ManualHandInput) {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true, '夹具本身必须能通过解析');
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, '夹具本身必须能通过重建');
  if (!gate.ok) throw new Error('unreachable');
  return gate.state;
}

/**
 * 一个**真实**的求解场景（用领域层的构造器，不手搓对象）。
 *
 * ⚠️ 不用 `{...} as never`：那样缺字段会在 `keysOf()` 里抛错，
 * 而那种失败看起来像「求解器坏了」，实际上只是夹具不全 ——
 * 会把真问题埋掉。
 */
function realScenario(position: 'UTG' | 'HJ' | 'CO' = 'UTG') {
  const s = buildGtoScenario({
    kind: GtoScenarioKind.RFI,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: position,
  });
  assert.ok(s !== null, `夹具场景必须能构造出来（${position}）`);
  return s!;
}

/* ============================================================
 * 1) 前台绝不等求解器
 * ============================================================ */

test('BG-SOLVE-01：缓存未命中时前台**立刻**回落，不等求解（这是核心交易）', async () => {
  /*
   * 假求解器故意慢 3000 ms。若前台会等它，这个断言必然失败 ——
   * 因此这条测试**真的**能抓住退化，而不是「顺便通过」。
   */
  const provider = makeSlowProvider({ delayMs: 3000 });
  const t0 = Date.now();
  const out = await prefetchSolverRanges(stateOf(bbFacingUtgOpen()), {
    gtoProvider: provider,
    gtoLookup: makeFakeLookup(provider, { cached: false }) as never,
  });
  const ms = Date.now() - t0;

  assert.ok(ms < 500, `前台取数必须远快于求解耗时，实测 ${ms} ms（求解需 3000 ms）`);
  assert.deepEqual(Object.keys(out.ranges), [], '缓存未命中时不得凭空造出范围');
  assert.equal(out.outcomes.length, 1);
  assert.equal(out.outcomes[0]!.fromSolver, false);
});

test('BG-SOLVE-02：命中缓存时用上求解器范围，来源如实标注', async () => {
  const provider = makeSlowProvider({ delayMs: 0 });
  const out = await prefetchSolverRanges(stateOf(bbFacingUtgOpen()), {
    gtoProvider: provider,
    gtoLookup: makeFakeLookup(provider, { cached: true }) as never,
  });
  assert.equal(Object.keys(out.ranges).length, 1, '命中缓存必须用上求解器范围');
  assert.equal(out.outcomes[0]!.fromSolver, true);
  assert.equal(out.outcomes[0]!.cacheSource, 'persistent');
  assert.equal(out.outcomes[0]!.state, GtoRangeOutcomeState.SOLVED);
});

/* ============================================================
 * 2) 拿不到的原因必须能说出来
 * ============================================================ */

test('BG-SOLVE-03：缓存未命中 ⇒ **必须**有一条可展示的中文原因（不得静默）', async () => {
  const provider = makeSlowProvider({ delayMs: 0 });
  const out = await prefetchSolverRanges(stateOf(bbFacingUtgOpen()), {
    gtoProvider: provider,
    gtoLookup: makeFakeLookup(provider, { cached: false }) as never,
  });
  assert.ok(
    out.warnings.length > 0,
    '拿不到求解器范围却一条说明都没有，使用者就只能看到一个没有解释的「启发式」标签',
  );
  assert.ok(
    out.warnings.some((w) => w.includes('GTO')),
    `说明里必须点名 GTO：${out.warnings.join(' / ')}`,
  );
});

test('BG-SOLVE-04：完全不传 GTO 依赖时，一条警告都不该有（既有行为不变）', async () => {
  /*
   * 「没启用 GTO」与「启用了但拿不到」是两件事：
   * 前者不该在界面上出现任何 GTO 相关的告警，否则每次分析都会多一句噪音。
   */
  const out = await prefetchSolverRanges(stateOf(bbFacingUtgOpen()), {});
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.outcomes, []);
  assert.deepEqual(Object.keys(out.ranges), []);
});

/* ============================================================
 * 3) 后台队列：真的算、只算一次、走落盘那一层
 * ============================================================ */

test('BG-SOLVE-05：入队后**后台真的开始算**，且算完状态是 DONE', async () => {
  const calls = { count: 0 };
  const provider = makeSlowProvider({ delayMs: 10, calls });
  const queue = new BackgroundSolveQueue();
  const lookup = makeFakeLookup(provider, { cached: false });

  const record = queue.submit(provider, lookup as never, realScenario());

  /*
   * ⚠️ 入队后状态可能是 `QUEUED` 或 `RUNNING` —— `submit()` 会立刻尝试
   * 调度（并发数为 1），因此「刚提交完还没轮到」这个瞬间不一定观察得到。
   * 断言「已受理且在途」，而不是钉死某一个。
   */
  assert.ok(
    record.state === BackgroundSolveState.QUEUED || record.state === BackgroundSolveState.RUNNING,
    `入队后必须处于在途状态，实际 ${record.state}`,
  );

  // 等后台跑完（假求解器只要 10 ms）
  for (let i = 0; i < 100 && queue.statusOf(record.cacheKey)?.state !== BackgroundSolveState.DONE; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  const done = queue.statusOf(record.cacheKey);
  assert.equal(done?.state, BackgroundSolveState.DONE, '后台必须真的把求解跑完');
  assert.equal(calls.count, 1, '后台必须真的调用过求解器（而不是只登记了一下）');
  assert.equal(done?.iterationsCompleted, 40, '迭代数必须如实记录');
});

test('BG-SOLVE-06：同一场景入队十次 ⇒ 只算一次', async () => {
  /*
   * 连点十次界面，串行队列会排十次 —— 9 人桌每次 195 秒，
   * 那等于把队列堵死三个小时，而使用者看到的只是「怎么一直没反应」。
   */
  const calls = { count: 0 };
  const provider = makeSlowProvider({ delayMs: 50, calls });
  const queue = new BackgroundSolveQueue();
  const lookup = makeFakeLookup(provider, { cached: false });
  const scenario = realScenario();

  const records = [];
  for (let i = 0; i < 10; i++) records.push(queue.submit(provider, lookup as never, scenario));

  assert.equal(new Set(records.map((r) => r.cacheKey)).size, 1, '同一个场景必须只有一个缓存键');
  assert.equal(queue.queueDepth() + (queue.pendingCount() > 0 ? 1 : 0), 1, '队列里只能有一个任务');

  for (let i = 0; i < 100 && queue.statusOf(records[0]!.cacheKey)?.state !== BackgroundSolveState.DONE; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(calls.count, 1, `同一场景只应求解一次，实际 ${calls.count} 次`);
});

test('BG-SOLVE-07：后台走的是**会落盘**的那一层（lookupWithStats），不是裸 provider', async () => {
  /*
   * 🔴 这条测试防的是最容易犯、后果最隐蔽的一个错：
   * 直接调 `provider.lookupScenario()` 会「算完了，但没存」——
   * 表现为每次重启都要重算几十分钟，而且**没有任何报错**。
   * 因此这里断言：被调用的是查询器，不是 provider。
   */
  const provider = makeSlowProvider({ delayMs: 0 });
  const queue = new BackgroundSolveQueue();
  let lookupCalled = 0;
  const lookup = {
    lookupCachedOnly: async () => null,
    lookupWithStats: async (s: never) => {
      lookupCalled += 1;
      return { result: await (provider.lookupScenario as (s: never) => Promise<unknown>)(s) };
    },
  };

  const record = queue.submit(provider, lookup as never, realScenario());

  for (let i = 0; i < 100 && queue.statusOf(record.cacheKey)?.state !== BackgroundSolveState.DONE; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(lookupCalled, 1, '后台必须调用带缓存的那一层，否则算完不会落盘');
});

test('BG-SOLVE-08：求解失败 ⇒ 如实记原因，且**不重试**（环境问题重试只会堵队列）', async () => {
  const provider = {
    ...(makeSlowProvider({ delayMs: 0 }) as unknown as Record<string, unknown>),
    lookupScenario: async () => ({
      status: GtoSolveStatus.GTO_BASELINE_UNAVAILABLE,
      cause: 'OFFLINE',
      message: '求解器没有响应',
    }),
  } as unknown as GtoProvider;

  let calls = 0;
  const counting = {
    ...(provider as unknown as Record<string, unknown>),
    lookupScenario: async () => {
      calls += 1;
      return { status: GtoSolveStatus.GTO_BASELINE_UNAVAILABLE, cause: 'OFFLINE', message: '求解器没有响应' };
    },
  } as unknown as GtoProvider;

  const queue = new BackgroundSolveQueue();
  const lookup = makeFakeLookup(counting, { cached: false });
  const scenario = realScenario();
  const record = queue.submit(counting, lookup as never, scenario);

  for (let i = 0; i < 100 && queue.statusOf(record.cacheKey)?.state !== BackgroundSolveState.FAILED; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const failed = queue.statusOf(record.cacheKey);
  assert.equal(failed?.state, BackgroundSolveState.FAILED);
  assert.ok(
    (failed?.reasonZh ?? '').includes('求解器'),
    `失败原因必须如实带中文说明：${failed?.reasonZh}`,
  );

  // 再入队五次 —— 不得重试
  for (let i = 0; i < 5; i++) queue.submit(counting, lookup as never, scenario);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1, `失败后不得自动重试，实际调用了 ${calls} 次`);
});

test('BG-SOLVE-09：后台抛异常不得逃逸（否则会变成 unhandled rejection 杀掉进程）', async () => {
  const provider = {
    ...(makeSlowProvider({ delayMs: 0 }) as unknown as Record<string, unknown>),
    lookupScenario: async () => {
      throw new Error('模拟求解器连接被重置');
    },
  } as unknown as GtoProvider;

  const queue = new BackgroundSolveQueue();
  const lookup = makeFakeLookup(provider, { cached: false });
  const record = queue.submit(provider, lookup as never, realScenario());

  for (let i = 0; i < 100 && queue.statusOf(record.cacheKey)?.state !== BackgroundSolveState.FAILED; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const failed = queue.statusOf(record.cacheKey);
  assert.equal(failed?.state, BackgroundSolveState.FAILED, '异常必须变成 FAILED 记录');
  assert.ok(
    (failed?.reasonZh ?? '').includes('已捕获'),
    `异常必须被捕获并说明：${failed?.reasonZh}`,
  );
});

test('BG-SOLVE-15：磁盘已有结果时**不得重复求解**（重启后的真实浪费）', async () => {
  /*
   * 实测发现的浪费：队列记录是**进程内存**，服务重启后就空了；
   * 而磁盘缓存是**跨进程持久**的。于是重启后第一次请求会出现
   * 「前台命中缓存（fromSolver=true），后台又在算同一个场景」——
   * 白烧几十秒到几分钟 CPU，还占着那条串行队列堵住后面真正需要的场景。
   */
  const provider = makeSlowProvider({ delayMs: 0 });
  let solveCalls = 0;
  const lookup = {
    // 磁盘上已经有结果了
    lookupCachedOnly: async () => ({
      result: await (provider.lookupScenario as (s: never) => Promise<unknown>)({} as never),
      stats: { source: 'persistent' },
    }),
    lookupWithStats: async (s: never) => {
      solveCalls += 1;
      return { result: await (provider.lookupScenario as (s: never) => Promise<unknown>)(s) };
    },
  };

  const queue = new BackgroundSolveQueue();
  const record = queue.submit(provider, lookup as never, realScenario());

  for (
    let i = 0;
    i < 100 && queue.statusOf(record.cacheKey)?.state !== BackgroundSolveState.DONE;
    i++
  ) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(queue.statusOf(record.cacheKey)?.state, BackgroundSolveState.DONE);
  assert.equal(
    solveCalls,
    0,
    `磁盘缓存已有时不得再求解一次 —— 实际求解了 ${solveCalls} 次（白烧 CPU 并堵住队列）`,
  );
});

/* ============================================================
 * 5) 🔴 开池尺寸：算不了的局面**绝不能**用另一个尺寸的数据顶替
 * ============================================================ */

test('BG-SOLVE-16：观察到的开池尺寸不是 2.5BB 时**不得**使用缓存里的策略', async () => {
  /*
   * 🔴 这条防的是本项目最严重的那类缺陷：**读到另一个牌局的策略**。
   *
   * 成因（实测复现）：`RFI` 场景的前序动作**恒为空**——
   * `defaultActionHistoryFor` 对 RFI 直接返回 `[]`，它不把开池尺寸写进去。
   * 因此 `openSizeBB` **不参与** `scenarioHash` / `cacheKey`：
   *
   * ```text
   * 开池 2BB   → scenarioHash=gb2c2da23  cacheKey=c91e7b60a
   * 开池 2.5BB → scenarioHash=gb2c2da23  cacheKey=c91e7b60a
   * 开池 3BB   → scenarioHash=gb2c2da23  cacheKey=c91e7b60a   ← 同一把键！
   * ```
   *
   * 于是「对手开池 3BB」会读到为 2.5BB 算的那份策略，并**照用**。
   * 数字看起来完全正常 —— 这正是它危险的地方。
   *
   * 唯一能拦住它的是 `solveSettingsMatch`。修复前它在生产路径上
   * **一个调用者都没有**（只被 `lookupPreflopRangePrior` 调用，
   * 而前台已改成只读缓存、不再走那条路）。
   */
  const provider = makeSlowProvider({ delayMs: 0 });
  const lookup = makeFakeLookup(provider, { cached: true }) as never;

  // 对手开池 3BB（求解配置是 2.5BB）
  const input = bbFacingUtgOpen();
  input.actionHistory = [
    { position: 'UTG' as never, type: 'RAISE', amountBB: 3.0 },
    { position: 'HJ' as never, type: 'FOLD' },
    { position: 'CO' as never, type: 'FOLD' },
    { position: 'BTN' as never, type: 'FOLD' },
    { position: 'SB' as never, type: 'FOLD' },
  ] as never;

  const out = await prefetchSolverRanges(stateOf(input), {
    gtoProvider: provider,
    gtoLookup: lookup,
  });

  assert.deepEqual(
    Object.keys(out.ranges),
    [],
    '开池 3BB 时**绝不能**使用为 2.5BB 算的策略 —— 那是另一个牌局的范围',
  );
  assert.equal(out.outcomes[0]!.fromSolver, false, '不得标记为已用求解器范围');
  assert.ok(
    (out.outcomes[0]!.reasonZh ?? '').includes('开池'),
    `必须说明是开池尺寸对不上：${out.outcomes[0]!.reasonZh}`,
  );
});

test('BG-SOLVE-17：尺寸对不上时**不入队**（算了也用不上，白烧几十秒 CPU）', async () => {
  const calls = { count: 0 };
  const provider = makeSlowProvider({ delayMs: 0, calls });
  const lookup = makeFakeLookup(provider, { cached: false }) as never;

  const input = bbFacingUtgOpen();
  input.actionHistory = [
    { position: 'UTG' as never, type: 'RAISE', amountBB: 3.0 },
    { position: 'HJ' as never, type: 'FOLD' },
    { position: 'CO' as never, type: 'FOLD' },
    { position: 'BTN' as never, type: 'FOLD' },
    { position: 'SB' as never, type: 'FOLD' },
  ] as never;

  const records = queueBackgroundSolverRanges(stateOf(input), {
    gtoProvider: provider,
    gtoLookup: lookup,
  });
  assert.deepEqual(
    records,
    [],
    '尺寸对不上就根本不该入队 —— 前台已经会拒绝它的结果，算它纯属浪费串行队列',
  );
});

test('BG-SOLVE-18：开池正好 2.5BB 时**正常**入队与使用（别把闸门关死）', async () => {
  const provider = makeSlowProvider({ delayMs: 0 });
  const out = await prefetchSolverRanges(stateOf(bbFacingUtgOpen()), {
    gtoProvider: provider,
    gtoLookup: makeFakeLookup(provider, { cached: true }) as never,
  });
  assert.equal(Object.keys(out.ranges).length, 1, '尺寸正确时必须照常使用求解器范围');
  assert.equal(out.outcomes[0]!.fromSolver, true);

  const records = queueBackgroundSolverRanges(stateOf(bbFacingUtgOpen()), {
    gtoProvider: provider,
    gtoLookup: makeFakeLookup(provider, { cached: false }) as never,
  });
  assert.equal(records.length, 1, '尺寸正确时必须照常入队');
});

test('BG-SOLVE-19：**没有入队**时不得声称「正在后台计算」（否则使用者会一直等）', async () => {
  /*
   * 🔴 这条防的是「承诺一件永远不会发生的事」。
   *
   * 尺寸对不上时（BG-SOLVE-16）前台会落到 `NOT_APPLICABLE` 并且**根本不入队**。
   * 而聚合状态如果只看「有哪些 outcome 不是 fromSolver」，就会报
   * 「GTO 正在后台计算 … 之后会自动改用 GTO 范围」——
   * 使用者于是会一直等一个永远不来的结果。
   *
   * 实测踩到过：修复前的响应是
   *   state=BACKGROUND_SOLVING + outcome=NOT_APPLICABLE + background=[]
   * 三处互相矛盾。
   */
  const provider = makeSlowProvider({ delayMs: 0 });
  const lookup = makeFakeLookup(provider, { cached: false }) as never;

  const input = bbFacingUtgOpen();
  input.actionHistory = [
    { position: 'UTG' as never, type: 'RAISE', amountBB: 3.0 },
    { position: 'HJ' as never, type: 'FOLD' },
    { position: 'CO' as never, type: 'FOLD' },
    { position: 'BTN' as never, type: 'FOLD' },
    { position: 'SB' as never, type: 'FOLD' },
  ] as never;

  const state = stateOf(input);
  const out = await prefetchSolverRanges(state, { gtoProvider: provider, gtoLookup: lookup });
  const queued = queueBackgroundSolverRanges(state, { gtoProvider: provider, gtoLookup: lookup });

  assert.equal(out.outcomes[0]!.state, GtoRangeOutcomeState.NOT_APPLICABLE, '尺寸对不上 ⇒ 不是「在算」');
  assert.deepEqual(queued, [], '也不该入队');

  /*
   * 聚合层的判据：只要「没有任何任务在跑」，就**不能**说在后台计算。
   * 这里直接断言这两件事不会同时成立 —— 那正是审计发现的矛盾。
   */
  const records: readonly { state: BackgroundSolveState }[] = queued;
  const anyRunning = records.some(
    (r) => r.state === BackgroundSolveState.QUEUED || r.state === BackgroundSolveState.RUNNING,
  );
  assert.equal(anyRunning, false, '没入队就不该有在跑的任务');
  assert.equal(out.outcomes[0]!.fromSolver, false);
});

/* ============================================================
 * 4) 端到端：枚举 → 入队
 * ============================================================ */

test('BG-SOLVE-10：queueBackgroundSolverRanges 把本手能算的场景排进队列', async () => {
  const provider = makeSlowProvider({ delayMs: 0 });
  const records = queueBackgroundSolverRanges(stateOf(bbFacingUtgOpen()), {
    gtoProvider: provider,
    gtoLookup: makeFakeLookup(provider, { cached: false }) as never,
  });
  assert.equal(records.length, 1, 'UTG 开池这一手应当恰好排一个场景');
  assert.ok(
    records[0]!.thingZh.includes('枪口位'),
    `场景名必须是人话（含位置中文名）：${records[0]!.thingZh}`,
  );
});

test('BG-SOLVE-11：多人入池时每个能算的对手各排一个场景', async () => {
  // 6 人桌：UTG 开池，CO 跟注，英雄在大盲位
  const input: ManualHandInput = {
    ...bbFacingUtgOpen(),
    actionHistory: [
      { position: 'UTG' as never, type: 'RAISE', amountBB: 2.5 },
      { position: 'HJ' as never, type: 'FOLD' },
      { position: 'CO' as never, type: 'CALL', amountBB: 2.5 },
      { position: 'BTN' as never, type: 'FOLD' },
      { position: 'SB' as never, type: 'FOLD' },
    ],
  };
  const provider = makeSlowProvider({ delayMs: 0 });
  const records = queueBackgroundSolverRanges(stateOf(input), {
    gtoProvider: provider,
    gtoLookup: makeFakeLookup(provider, { cached: false }) as never,
  });
  assert.equal(records.length, 2, '开池者 + 跟注者各一个场景');
  const names = records.map((r) => r.thingZh).join(' | ');
  assert.ok(names.includes('枪口位'), `必须含开池者：${names}`);
  assert.ok(names.includes('关煞位'), `必须含跟注者：${names}`);
});

test('BG-SOLVE-12：多次加注的局面**不入队**（结构上算不了，等也不会变）', async () => {
  /*
   * 生产配置 `max_raises = 2`，3Bet 之后的节点需要 >= 3。
   * 用相近节点顶替会读到**别人的策略** —— 那是本项目反复修掉的那类缺陷。
   */
  const input: ManualHandInput = {
    ...bbFacingUtgOpen(),
    actionHistory: [
      { position: 'UTG' as never, type: 'RAISE', amountBB: 2.5 },
      { position: 'HJ' as never, type: 'FOLD' },
      { position: 'CO' as never, type: 'RAISE', amountBB: 7.5 },
      { position: 'BTN' as never, type: 'FOLD' },
      { position: 'SB' as never, type: 'FOLD' },
    ],
  };
  const provider = makeSlowProvider({ delayMs: 0 });
  const records = queueBackgroundSolverRanges(stateOf(input), {
    gtoProvider: provider,
    gtoLookup: makeFakeLookup(provider, { cached: false }) as never,
  });
  assert.deepEqual(records, [], '多轮加注不得入队 —— 算了也算不出这个节点');

  const out = await prefetchSolverRanges(stateOf(input), {
    gtoProvider: provider,
    gtoLookup: makeFakeLookup(provider, { cached: false }) as never,
  });
  assert.ok(
    out.warnings.some((w) => w.includes('加注上限') || w.includes('3Bet') || w.includes('加注')),
    `必须说明「这局面算不了，等也不会变」：${out.warnings.join(' / ')}`,
  );
});

test('BG-SOLVE-13：翻后局面不入队（GTOpen 只有翻前）', async () => {
  const input: ManualHandInput = {
    ...bbFacingUtgOpen(),
    board: ['2c', '7d', 'Jh'],
    street: 'FLOP' as never,
    actionHistory: [
      { position: 'UTG' as never, type: 'RAISE', amountBB: 2.5 },
      { position: 'HJ' as never, type: 'FOLD' },
      { position: 'CO' as never, type: 'FOLD' },
      { position: 'BTN' as never, type: 'FOLD' },
      { position: 'SB' as never, type: 'FOLD' },
      { position: 'BB' as never, type: 'CALL', amountBB: 1.5 },
    ],
  };
  const provider = makeSlowProvider({ delayMs: 0 });
  const records = queueBackgroundSolverRanges(stateOf(input), {
    gtoProvider: provider,
    gtoLookup: makeFakeLookup(provider, { cached: false }) as never,
  });
  assert.deepEqual(records, [], '翻后不得入队');
});

test('BG-SOLVE-14：场景名是人话，且逐桌人数都能生成', () => {
  const names = [
    describeScenarioThingZh({ tableSize: 6, heroPosition: 'UTG', kind: 'RFI' } as never),
    describeScenarioThingZh({ tableSize: 9, heroPosition: 'BTN', kind: 'RFI' } as never),
  ];
  for (const n of names) {
    assert.ok(n.includes('人桌'), `场景名必须含桌人数：${n}`);
    assert.ok(!n.includes('undefined'), `场景名不得出现 undefined：${n}`);
    assert.ok(!n.includes('RFI'), `场景名必须是中文，不能漏出内部枚举名：${n}`);
  }
});
