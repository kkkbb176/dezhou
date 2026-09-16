/**
 * 翻前 GTO 范围接入（Phase 1.2）
 *
 * ## 这一组测试防的是什么
 *
 * 把「对手范围」从**猜的**（启发式先验，可信度 0.3）换成**算的**
 *（GTOpen 频率），是本轮的目标。而这条路上有**三类**会静默出错的缺陷：
 *
 * | # | 缺陷 | 后果 |
 * |---|---|---|
 * | 1 | 按**序号**对接 169 类（两套顺序只有 5/169 相同） | 约 164 个牌型的频率灌到别的牌上，**没有任何报错** |
 * | 2 | 尺寸 / 筹码对不上却照用 | 读到的是**另一个牌局**的策略，数字看起来正常 |
 * | 3 | 对求解器范围**再乘一次似然** | 重复计票，范围被收缩两次，窄到不真实 |
 *
 * 因此本文件的断言全部指向这三件事。
 *
 * ## 观察口径
 *
 * 只看**外部可观察的东西**：
 * - `prefetchSolverRanges` 的返回值（用结构一致的假求解器）
 * - `analyzeManualHand` 产出的 `opponentRanges[].sourceKind` / `confidence`
 * - 范围的 `supportSize`（权重分布的投影）
 *
 * 🚫 不读内部字段、不重新实现一份转换逻辑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position, Street } from '../src/domain/types.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import {
  prefetchSolverRanges,
  prefetchSolverRangesForInput,
  analyzeManualHand,
} from '../src/app/alphaPipeline.ts';
import { lookupPreflopRangePrior, solveSettingsMatch, weightsFromRange } from '../src/app/manualInput/solverRangePrior.ts';
import { preflopShapeOf, scenarioForOpponent } from '../src/app/manualInput/solverScenarioForOpponent.ts';
import { GtoActionKind, GtoScenarioKind, GtoSolveStatus, type GtoProvider } from '../src/domain/gto/gto.types.ts';
import { allRankClassKeys } from '../src/app/manualInput/preflopPriors.ts';
import { GTOPEN_CAPABILITY_TABLE } from '../src/domain/gto/providers/gtopenCapabilities.ts';

/* ============================================================
 * 假查询器（Phase 1.3：前台的「只读缓存」入口）
 * ============================================================ */

/**
 * 假缓存查询器：**只做两件事** —— 读缓存、入队后台。
 *
 * 🔴 它刻意**不包含任何求解逻辑**，因为这一组测试要证明的正是
 * 「前台路径不会去求解」。如果这里偷偷算了一下，那些测试就全部失去意义。
 */
function makeFakeLookup(
  provider: GtoProvider,
  opts: { cacheEmpty?: boolean; source?: 'memory' | 'persistent' } = {},
): {
  lookupCachedOnly: (s: never) => Promise<unknown>;
  lookupWithStats: (s: never) => Promise<{ result: unknown }>;
} {
  const cached = async (scenario: never): Promise<unknown> =>
    opts.cacheEmpty === true
      ? null
      : {
          result: await (provider.lookupScenario as (s: never) => Promise<unknown>)(scenario),
          stats: { source: opts.source ?? 'persistent' },
        };
  return {
    lookupCachedOnly: cached,
    // 后台队列才用它；这一组测试不触发后台求解
    lookupWithStats: async (scenario: never) => ({
      result: await (provider.lookupScenario as (s: never) => Promise<unknown>)(scenario),
    }),
  } as never;
}

/* ============================================================
 * 假求解器（**只声明它给了什么，不重新实现求解逻辑**）
 * ============================================================ */

type FakeOptions = {
  /** 每个位置的开池频率：手牌 → 频率。缺省 = 该手牌频率 0 */
  raiseWeights?: Readonly<Record<string, number>>;
  callWeights?: Readonly<Record<string, number>>;
  reachable?: boolean;
  /** 覆盖 provider 报告的求解设置 */
  solveOverrides?: Record<string, unknown>;
  actorPosition?: string;
};

function makeFakeProvider(opts: FakeOptions = {}): GtoProvider {
  const raiseWeights = opts.raiseWeights ?? {};
  const callWeights = opts.callWeights ?? {};

  return {
    engine: 'fake',
    solveKeyParts: () =>
      ({
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
        enginePositions: [],
        posts: [],
        ante: 0,
        ...(opts.solveOverrides ?? {}),
      }) as never,
    lookupScenario: async (scenario: never) =>
      ({
        scenario,
        scenarioHash: 'g00000000',
        range: {
          actorPosition: opts.actorPosition ?? (scenario as { heroPosition: string }).heroPosition,
          actionMenu: [
            { kind: GtoActionKind.FOLD, sizeBB: null, rawLabel: 'Fold' },
            { kind: GtoActionKind.CALL, sizeBB: 2.5, rawLabel: 'Call 2.5' },
            { kind: GtoActionKind.RAISE, sizeBB: 7.5, rawLabel: '3-bet 7.5' },
          ],
          // 按 169 类给出策略；这里只关心被显式赋值的那些
          hands: allRankClassKeys().map((hand) => ({
            hand,
            combos: 6,
            reach: null,
            actions: [
              { kind: GtoActionKind.FOLD, sizeBB: null, frequency: 0, evBB: null, rawLabel: 'Fold' },
              {
                kind: GtoActionKind.CALL,
                sizeBB: 2.5,
                frequency: callWeights[hand] ?? 0,
                evBB: null,
                rawLabel: 'Call 2.5',
              },
              {
                kind: GtoActionKind.RAISE,
                sizeBB: 7.5,
                frequency: raiseWeights[hand] ?? 0,
                evBB: null,
                rawLabel: '3-bet 7.5',
              },
            ],
          })),
          potBB: 4,
          reachable: opts.reachable ?? true,
          unavailableReason: opts.reachable === false ? '该路径不可达' : null,
        },
        metadata: {
          source: { kind: 'SOLVER', engine: 'fake', sourceVersion: null, engineCommit: 'deadbeefcafe', endpoint: null },
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
      }) as never,
    health: async () => ({ reachable: true, engine: 'fake', version: null, commit: null, endpoint: null, message: '' }),
    capabilities: async () => null,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    close: async () => undefined,
  } as unknown as GtoProvider;
}

/* ============================================================
 * 场景构造
 * ============================================================ */

/** 6 人桌翻牌前：UTG 开池 2.5BB，其余弃牌 → Hero 在 BB 面对开池 */
function bbFacingUtgOpen(): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards: ['Ah', 'Kh'],
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'RAISE', amountBB: 2.5 },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'FOLD' },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL' },
  };
}

function gameStateOf(input: ManualHandInput) {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true, `解析必须成功：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, `重建必须成功：${gate.ok ? '' : JSON.stringify(gate.issues)}`);
  if (!gate.ok) throw new Error('unreachable');
  return gate.state;
}

/* ============================================================
 * 一、映射：对手动作 → 求解节点
 * ============================================================ */

/**
 * 从 `GameState` 读出加注骨架。
 *
 * ⚠️ **单位**：`state.actions[].toAmount` 是**筹码**，而 GTO 场景用 **BB**。
 * 测试里也必须照生产代码那样换算（用 `toAmount` 而不是 `amount` ——
 * 后者是「本次投入的增量」，与「到多少」是两个口径）。
 */
function shapeOf(state: ReturnType<typeof gameStateOf>, tableSize: 6 | 9 = 6) {
  const bigBlind = state.config.bigBlind;
  const history = state.actions
    .filter((a) => a.street === Street.PREFLOP)
    .map((a) => ({
      position: a.position,
      kind: a.type as never,
      sizeBB: a.toAmount > 0 ? Math.round((a.toAmount / bigBlind) * 1e6) / 1e6 : null,
    }));
  return preflopShapeOf(tableSize, history);
}

test('SOLVERPRIOR-01：对手开池 → 映射到 RFI 节点', () => {
  const state = gameStateOf(bbFacingUtgOpen());
  const shape = shapeOf(state);
  assert.equal(shape.raiseCount, 1);
  assert.equal(shape.opener, Position.UTG);
  assert.equal(shape.openSizeBB, 2.5);

  const mapped = scenarioForOpponent(6, 100, shape, Position.UTG);
  assert.ok(mapped !== null, 'UTG 开池必须能映射');
  assert.equal(mapped!.scenario.kind, GtoScenarioKind.RFI);
  assert.equal(mapped!.action.action, 'OPEN');
});

test('SOLVERPRIOR-02：面对一个开池 → 映射到 VS_OPEN 节点（hero = 面对者）', () => {
  const state = gameStateOf(bbFacingUtgOpen());
  const shape = shapeOf(state);

  const mapped = scenarioForOpponent(6, 100, shape, Position.BB);
  assert.ok(mapped !== null, 'BB 面对 UTG 开池必须能映射');
  assert.equal(mapped!.scenario.kind, GtoScenarioKind.VS_OPEN);
  assert.equal(mapped!.scenario.heroPosition, Position.BB, 'hero 必须是**面对者**（要建模的那个对手）');
  assert.equal(mapped!.scenario.villainPosition, Position.UTG, 'villain 必须是开池者');
});

test('SOLVERPRIOR-03：**多轮加注**必须拒绝映射（不得用相近节点顶替）', () => {
  const history = [
    { position: Position.UTG, kind: GtoActionKind.RAISE, sizeBB: 2.5 },
    { position: Position.BB, kind: GtoActionKind.RAISE, sizeBB: 7.5 },
  ] as never;
  const shape = preflopShapeOf(6, history);
  assert.equal(shape.raiseCount, 2);
  // 3Bet 之后的节点需要 max_raises >= 3，生产配置是 2 ⇒ 结构上不支持
  assert.equal(scenarioForOpponent(6, 100, shape, Position.UTG), null);
  assert.equal(scenarioForOpponent(6, 100, shape, Position.BB), null);
});

test('SOLVERPRIOR-04：跛入池（无人加注）必须拒绝映射', () => {
  const history = [{ position: Position.UTG, kind: GtoActionKind.CALL, sizeBB: 1 }] as never;
  const shape = preflopShapeOf(6, history);
  assert.equal(shape.raiseCount, 0);
  assert.equal(scenarioForOpponent(6, 100, shape, Position.UTG), null);
});

/* ============================================================
 * 二、覆盖判定：配置对不上必须**拒绝**，不得「差不多就用」
 * ============================================================ */

test('SOLVERPRIOR-05：实际开池 3BB ≠ 求解配置 2.5BB ⇒ 必须拒绝', () => {
  const solve = makeFakeProvider().solveKeyParts({} as never);
  const r = solveSettingsMatch({
    solve,
    observedOpenSizeBB: 3,
    observedThreeBetSizeBB: null,
  });
  assert.equal(r.ok, false);
  assert.match((r as { reasonZh: string }).reasonZh, /3BB|2\.5BB/);
});

test('SOLVERPRIOR-06：实际开池 2.5BB == 求解配置 ⇒ 放行', () => {
  const solve = makeFakeProvider().solveKeyParts({} as never);
  const r = solveSettingsMatch({
    solve,
    observedOpenSizeBB: 2.5,
    observedThreeBetSizeBB: null,
  });
  assert.equal(r.ok, true);
});

test('SOLVERPRIOR-07：3Bet 尺寸不是配置倍数 ⇒ 必须拒绝', () => {
  const solve = makeFakeProvider().solveKeyParts({} as never);
  const r = solveSettingsMatch({
    solve,
    observedOpenSizeBB: 2.5,
    observedThreeBetSizeBB: 10, // 配置是 2.5 × 3 = 7.5
  });
  assert.equal(r.ok, false);
  assert.match((r as { reasonZh: string }).reasonZh, /7\.5|倍数/);
});

/* ============================================================
 * 三、频率 → 权重：按**牌名**对齐
 * ============================================================ */

test('SOLVERPRIOR-08：权重必须按牌名落到正确的牌上（不是按序号）', () => {
  const fake = makeFakeProvider({
    raiseWeights: { AA: 1, AKs: 1, AKo: 0.4, '72o': 0 },
    callWeights: { '22': 0.8 },
  });
  const lookup = { reachable: true } as const;
  void lookup;

  const range = {
    actorPosition: 'UTG',
    actionMenu: [],
    hands: allRankClassKeys().map((hand) => ({
      hand,
      combos: 6,
      reach: null,
      actions: [
        { kind: GtoActionKind.RAISE, sizeBB: 2.5, frequency: 0, evBB: null, rawLabel: 'R' },
        { kind: GtoActionKind.CALL, sizeBB: null, frequency: 0, evBB: null, rawLabel: 'C' },
      ],
    })),
    potBB: 4,
    reachable: true,
    unavailableReason: null,
  };
  // 把假 provider 的权重搬进这份 range（保持测试聚焦在转换上）
  for (const h of range.hands) {
    for (const a of h.actions) {
      if (a.kind === GtoActionKind.RAISE) a.frequency = ({ AA: 1, AKs: 1, AKo: 0.4, '72o': 0 } as Record<string, number>)[h.hand] ?? 0;
      if (a.kind === GtoActionKind.CALL) a.frequency = ({ '22': 0.8 } as Record<string, number>)[h.hand] ?? 0;
    }
  }

  const weights = weightsFromRange(range as never, [GtoActionKind.RAISE]);
  assert.ok(weights !== null);
  assert.equal(weights!['AA'], 1);
  assert.equal(weights!['AKs'], 1);
  assert.equal(weights!['AKo'], 0.4, 'AKo 的频率必须落在 AKo 上');
  assert.equal(weights!['72o'], 0);
  assert.equal(weights!['AQs'] ?? 0, 0, 'AQs 不该拿到 AKs 的频率');

  void fake;
});

test('SOLVERPRIOR-09：一手牌都不做该动作 ⇒ 返回 null（不给空范围）', () => {
  const range = {
    actorPosition: 'UTG',
    actionMenu: [],
    hands: allRankClassKeys().map((hand) => ({
      hand,
      combos: 6,
      reach: null,
      actions: [{ kind: GtoActionKind.RAISE, sizeBB: 2.5, frequency: 0, evBB: null, rawLabel: 'R' }],
    })),
    potBB: 4,
    reachable: true,
    unavailableReason: null,
  };
  assert.equal(weightsFromRange(range as never, [GtoActionKind.RAISE]), null);
});

/* ============================================================
 * 四、端到端：分析结果里必须能看到来源换成了求解器
 * ============================================================ */

test('SOLVERPRIOR-10：有 GTO 数据时，对手范围的来源必须是求解器而不是启发式', async () => {
  const input = bbFacingUtgOpen();
  const state = gameStateOf(input);
  const fake = makeFakeProvider({
    raiseWeights: { AA: 1, KK: 1, QQ: 1, AKs: 1, AKo: 1, JJ: 0.6 },
    callWeights: {},
  });

  const prefetched = await prefetchSolverRanges(state, {
    gtoProvider: fake,
    // Phase 1.3：前台只读缓存 ⇒ 这份数据本身就当作「缓存里已经有」
    gtoLookup: makeFakeLookup(fake, { source: 'persistent' }) as never,
  });
  assert.deepEqual(prefetched.warnings, [], `预取不该有警告：${prefetched.warnings.join(' / ')}`);
  assert.equal(Object.keys(prefetched.ranges).length, 1, 'UTG 应当拿到一份求解器范围');

  const result = analyzeManualHand(input, { rules: [], writeLog: false, gtoRanges: prefetched.ranges });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const ranges = result.decision.diagnostics.opponentRanges;
  assert.ok(ranges.length > 0, '必须有对手范围');
  const utg = ranges[0]!;
  assert.notEqual(utg.sourceKind, 'HEURISTIC', '来源必须不再是启发式');
  assert.ok(
    utg.confidence > 0.35,
    `求解器范围的可信度必须明显高于启发式先验的 0.3，实际 ${utg.confidence}`,
  );
  assert.match(utg.sourceDescription, /求解器/, '来源说明必须写明是求解器');
});

test('SOLVERPRIOR-11：求解器不可用时**必须回落**启发式（不是拒绝给建议）', async () => {
  const input = bbFacingUtgOpen();
  const state = gameStateOf(input);
  const fake = makeFakeProvider({ reachable: false });

  const prefetched = await prefetchSolverRanges(state, {
    gtoProvider: fake,
    gtoLookup: makeFakeLookup(fake, { cacheEmpty: true }) as never,
  });
  assert.equal(Object.keys(prefetched.ranges).length, 0, '不可达节点不得产出范围');
  assert.ok(prefetched.warnings.length > 0, '必须留下可展示的中文原因');

  const result = analyzeManualHand(input, { rules: [], writeLog: false, gtoRanges: prefetched.ranges });
  assert.equal(result.ok, true, '回落之后仍然必须能给出建议');
  if (!result.ok) return;
  assert.equal(
    result.decision.diagnostics.opponentRanges[0]!.sourceKind,
    'HEURISTIC',
    '回落时来源必须是启发式（如实）',
  );
});

test('SOLVERPRIOR-12：不传 provider ⇒ 一行都不变（既有行为逐位一致）', async () => {
  const input = bbFacingUtgOpen();
  const a = analyzeManualHand(input, { rules: [], writeLog: false });
  const b = analyzeManualHand(input, { rules: [], writeLog: false, gtoRanges: {} });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.decision.action, b.decision.action);
  assert.equal(a.decision.diagnostics.math.heroEquity, b.decision.diagnostics.math.heroEquity);
  assert.equal(a.decision.diagnostics.opponentRanges[0]!.sourceKind, 'HEURISTIC');
});

test('SOLVERPRIOR-13：求解器范围**不得**再施加似然更新（避免重复计票）', async () => {
  const input = bbFacingUtgOpen();
  const state = gameStateOf(input);
  const fake = makeFakeProvider({
    raiseWeights: { AA: 1, KK: 1, QQ: 1, AKs: 1, AKo: 1, JJ: 0.6 },
  });
  const prefetched = await prefetchSolverRanges(state, { gtoProvider: fake });
  const result = analyzeManualHand(input, { rules: [], writeLog: false, gtoRanges: prefetched.ranges });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const utg = result.decision.diagnostics.opponentRanges[0]!;
  assert.deepEqual(
    [...utg.updateTrace],
    [],
    '求解器范围已经包含了这次行动的全部信息，再乘一次似然就是重复计票（范围会被收缩两次）',
  );
});

/* ============================================================
 * 五、能力表与实现必须一致
 * ============================================================ */

test('SOLVERPRIOR-14：只对能力表声明 SUPPORTED 的场景做映射', () => {
  const supported = GTOPEN_CAPABILITY_TABLE.scenarioSupport;
  assert.equal(supported[GtoScenarioKind.RFI], 'SUPPORTED');
  assert.equal(supported[GtoScenarioKind.VS_OPEN], 'SUPPORTED');
  // 映射层**只**产出这两种；其余一律 null（见 SOLVERPRIOR-03/04）
  assert.equal(supported[GtoScenarioKind.VS_3BET], 'UNSUPPORTED');
  assert.equal(supported[GtoScenarioKind.VS_4BET], 'UNSUPPORTED');
  assert.equal(supported[GtoScenarioKind.LIMPED], 'UNSUPPORTED');
});

test('SOLVERPRIOR-15：翻后**不得**使用翻前求解器范围（GTOpen 只解翻前）', async () => {
  const input: ManualHandInput = {
    ...bbFacingUtgOpen(),
    board: ['Kh', '7c', '2d'],
    street: Street.FLOP,
    actionHistory: [
      { position: Position.UTG, type: 'RAISE', amountBB: 2.5 },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'FOLD' },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'CALL', amountBB: 1.5 },
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
      { position: Position.UTG, type: 'CHECK', street: Street.FLOP },
    ],
  };
  const fake = makeFakeProvider({ raiseWeights: { AA: 1 } });
  const prefetched = await prefetchSolverRangesForInput(input, {
    gtoProvider: fake,
    gtoLookup: makeFakeLookup(fake) as never,
  });
  assert.deepEqual(
    Object.keys(prefetched.ranges),
    [],
    '翻后不得用翻前频率 —— 翻前的范围到了翻后已经被行动改变了，用它描述翻后范围会丢掉全部翻后信息',
  );
});

test('SOLVERPRIOR-16：缓存未命中 ⇒ 回落启发式 + 留下可展示的原因（不再阻塞求解）', async () => {
  const input = bbFacingUtgOpen();
  const state = gameStateOf(input);
  /*
   * Phase 1.3：预算这个参数**被删掉了**，因为它不成立 ——
   * 超时检查在循环体之前，第一个对手永远无条件求解然后等到底
   *（实测预算 1500 ms、9 人桌实际 195 312 ms）。
   *
   * 现在前台**根本不求解**，于是这条测试改为断言：
   * 缓存空 ⇒ 立刻回落，并且**如实说明原因**（不再是静默的）。
   */
  const provider = makeFakeProvider({ raiseWeights: { AA: 1 } });
  const prefetched = await prefetchSolverRanges(state, {
    gtoProvider: provider,
    gtoLookup: makeFakeLookup(provider, { cacheEmpty: true }) as never,
  });
  assert.equal(Object.keys(prefetched.ranges).length, 0, '缓存空时不得凭空造出范围');
  assert.ok(
    prefetched.warnings.some((w) => w.includes('GTO')),
    `必须留下可展示的中文说明（而不是静默回落）：${prefetched.warnings.join(' / ')}`,
  );
  assert.equal(prefetched.outcomes.length, 1, '必须逐家给出结局，供界面分层渲染');
  assert.equal(prefetched.outcomes[0]!.fromSolver, false);
});

test('SOLVERPRIOR-16b：命中缓存 ⇒ 用上求解器范围，且来源如实标注', async () => {
  const input = bbFacingUtgOpen();
  const state = gameStateOf(input);
  const provider = makeFakeProvider({ raiseWeights: { AA: 1, AKs: 0.5 } });
  const prefetched = await prefetchSolverRanges(state, {
    gtoProvider: provider,
    gtoLookup: makeFakeLookup(provider, { source: 'persistent' }) as never,
  });
  assert.equal(Object.keys(prefetched.ranges).length, 1, '命中缓存必须用上求解器范围');
  assert.equal(prefetched.outcomes[0]!.fromSolver, true);
  assert.equal(prefetched.outcomes[0]!.cacheSource, 'persistent', '必须如实标注来源是缓存');
});

test('SOLVERPRIOR-17：lookupPreflopRangePrior 对「行动者不匹配」必须拒绝', async () => {
  /*
   * 防的是「把别人的策略当成他的」：求解器返回的节点行动者若不是
   * 我们要建模的那个对手，那份频率描述的是**另一个人的决策**。
   */
  const fake = makeFakeProvider({ raiseWeights: { AA: 1 }, actorPosition: 'HJ' });
  const r = await lookupPreflopRangePrior(
    fake,
    {
      tableSize: 6,
      position: 'UTG',
      effectiveStackBB: 100,
      observedOpenSizeBB: 2.5,
      observedThreeBetSizeBB: null,
      action: 'OPEN',
      openerPosition: 'UTG',
    },
    (a) =>
      ({
        kind: GtoScenarioKind.RFI,
        gameType: 'CASH',
        tableSize: a.tableSize,
        effectiveStackBB: a.effectiveStackBB,
        heroPosition: a.position,
        villainPosition: null,
        actionHistory: [],
        raiseSizesBB: [],
        blinds: { sbBB: 0.5, bbBB: 1, anteBB: 0 },
        heroAlreadyActed: false,
      }) as never,
  );
  assert.equal(r.ok, false);
  assert.match((r as { reasonZh: string }).reasonZh, /行动者/);
});
