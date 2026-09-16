/**
 * GTOpen 适配层测试（Provider + 映射 + 失败回退 + 墨菲定律审计）
 *
 * ## 这份测试防的是什么
 *
 * 集成外部引擎最大的风险**不是**「功能没做」，而是「数据串了」：
 * 4 人桌的 BTN 读到 6 人桌的 BTN、AKs 读到 AKo 的频率、
 * 旧会话的结果被当成新场景的答案、求解器崩了把 Alpha 一起带崩。
 * 这些错误在界面上**完全看不出来** —— 所有名字都是对的。
 *
 * 因此这里用 `FakeGtopen`（结构上与真实求解器一致的内存替身）
 * 逐条攻击这些失败模式，**每条都断言具体的数字或状态码**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GtoScenarioKind,
  GtoSolveStatus,
  GtoVerification,
  gtoPositionsFor,
  type GtoScenario,
} from '../src/domain/gto/gto.types.ts';
import { buildGtoScenario, scenarioHashOf } from '../src/domain/gto/gtoScenario.ts';
import {
  GTOPEN_DEFAULT_BUDGET,
  GtopenProvider,
  buildEngineConfig,
  iterationsForTableSize,
  matchActionIndex,
  parseNodeView,
  parseStatus,
  profileForTableSize,
  sessionSignature,
} from '../src/domain/gto/providers/gtopenProvider.ts';
import { GtoHttpClient } from '../src/domain/gto/providers/gtopenHttpClient.ts';
import {
  buildEngineSeats,
  mapActionKind,
  selfCheckMappingLayer,
  toEngineActionKind,
  verifyPositionsEcho,
} from '../src/domain/gto/providers/gtopenMapping.ts';
import { GtoSafeLookup } from '../src/domain/gto/gtoSafeLookup.ts';
import { FakeGtopen } from './helpers/fakeGtopen.ts';

/* ============================================================
 * 测试脚手架
 * ============================================================ */

/** 构造一个用假求解器的 Provider（不等待真实时间） */
function makeProvider(
  fake: FakeGtopen,
  overrides: Partial<typeof GTOPEN_DEFAULT_BUDGET> = {},
): GtopenProvider {
  return new GtopenProvider({
    baseUrl: 'http://127.0.0.1:3737',
    client: new GtoHttpClient({ baseUrl: 'http://127.0.0.1:3737', fetchImpl: fake.fetch }),
    budget: { ...GTOPEN_DEFAULT_BUDGET, pollIntervalMs: 0, ...overrides },
    sleep: async () => undefined,
  });
}

/** 构造某桌型的「第一个行动位 RFI」场景 */
function firstInScenario(tableSize: 4 | 5 | 6 | 8 | 9, stackBB = 100): GtoScenario {
  const hero = gtoPositionsFor(tableSize)[0]!;
  const scenario = buildGtoScenario({
    kind: GtoScenarioKind.RFI,
    tableSize,
    effectiveStackBB: stackBB,
    heroPosition: hero,
    actionHistory: [],
  });
  assert.ok(scenario !== null, `${tableSize} 人桌 ${hero} RFI 场景必须可构造`);
  return scenario;
}

/* ============================================================
 * 一、位置映射（每个桌人数一份）
 * ============================================================ */

test('GTO-ADP-01：5 个桌人数的位置数组与权威顺序逐字一致，且末两位是 SB/BB', () => {
  for (const size of [4, 5, 6, 8, 9] as const) {
    const { positions, posts } = buildEngineSeats(size, { sbBB: 0.5, bbBB: 1 });
    assert.deepEqual(positions, [...gtoPositionsFor(size)], `${size} 人桌位置顺序`);
    assert.equal(positions.length, size);
    assert.equal(posts.length, size);
    assert.equal(positions[size - 2], 'SB');
    assert.equal(positions[size - 1], 'BB');
    assert.equal(posts[size - 2], 0.5);
    assert.equal(posts[size - 1], 1);
    for (let i = 0; i < size - 2; i++) assert.equal(posts[i], 0, `${size} 人桌第 ${i} 座不应有强制投入`);
  }
});

test('GTO-ADP-02：4 人桌没有 UTG，5 人桌没有 UTG，9 人桌有 UTG2（位置集合不得互相污染）', () => {
  assert.deepEqual([...gtoPositionsFor(4)], ['CO', 'BTN', 'SB', 'BB']);
  assert.deepEqual([...gtoPositionsFor(5)], ['HJ', 'CO', 'BTN', 'SB', 'BB']);
  assert.deepEqual([...gtoPositionsFor(6)], ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
  assert.deepEqual([...gtoPositionsFor(8)], ['UTG', 'UTG1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
  assert.deepEqual(
    [...gtoPositionsFor(9)],
    ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  );
  assert.ok(!gtoPositionsFor(4).includes('UTG'));
  assert.ok(!gtoPositionsFor(5).includes('UTG'));
  assert.ok(!gtoPositionsFor(8).includes('UTG2'));
});

test('GTO-ADP-03：座位回显校验能抓到 SB/BB 反转与任何一个座位的错位', () => {
  const requested = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
  assert.deepEqual(verifyPositionsEcho(requested, requested, 6), []);
  // SB/BB 反转
  const swapped = ['UTG', 'HJ', 'CO', 'BTN', 'BB', 'SB'];
  assert.ok(verifyPositionsEcho(requested, swapped, 6).length > 0);
  // 错一格（HJ 与 CO 互换）
  const shifted = ['UTG', 'CO', 'HJ', 'BTN', 'SB', 'BB'];
  assert.ok(verifyPositionsEcho(requested, shifted, 6).length > 0);
  // 长度不符
  assert.ok(verifyPositionsEcho(requested, ['UTG', 'HJ'], 6).length > 0);
  // 桌人数与座位数不符
  assert.ok(verifyPositionsEcho(requested, requested, 9).length > 0);
});

test('GTO-ADP-04：动作类别映射覆盖源码全部 kind，且未知 kind 返回 null（不猜）', () => {
  assert.equal(mapActionKind('fold'), 'FOLD');
  assert.equal(mapActionKind('check'), 'CHECK');
  assert.equal(mapActionKind('call'), 'CALL');
  assert.equal(mapActionKind('raise'), 'RAISE');
  assert.equal(mapActionKind('jam'), 'ALL_IN');
  assert.equal(mapActionKind('bet'), null, '翻前不应存在独立 bet');
  assert.equal(mapActionKind('4-bet'), null, '不得用标签文本判断类别');
  assert.equal(toEngineActionKind('ALL_IN'), 'jam');
  assert.equal(toEngineActionKind('BET'), null, '翻前无法表达下注 → 必须显式 null');
  assert.deepEqual(selfCheckMappingLayer(), []);
});

/* ============================================================
 * 二、动作匹配（路径走位不得靠猜下标）
 * ============================================================ */

test('GTO-ADP-05：动作匹配先语义后金额；金额不符时返回 null 而不是就近取一个', () => {
  const actions = [
    { label: 'Fold', kind: 'fold', to: 0, freq: 0.5 },
    { label: 'Call 2.5', kind: 'call', to: 2.5, freq: 0.2 },
    { label: '3-bet 7.5', kind: 'raise', to: 7.5, freq: 0.2 },
    { label: 'All-in 100', kind: 'jam', to: 100, freq: 0.1 },
  ];
  assert.equal(matchActionIndex(actions, 'FOLD', null), 0);
  assert.equal(matchActionIndex(actions, 'CALL', null), 1);
  assert.equal(matchActionIndex(actions, 'RAISE', 7.5), 2);
  assert.equal(matchActionIndex(actions, 'ALL_IN', 100), 3);
  // 3BB 与 7.5BB 差得很远 → 不得回退到「最接近的那个」
  assert.equal(matchActionIndex(actions, 'RAISE', 3), null);
  // 容差 0.01 只吸收浮点误差
  assert.equal(matchActionIndex(actions, 'RAISE', 7.505), 2);
  assert.equal(matchActionIndex(actions, 'RAISE', 7.2), null);
});

/* ============================================================
 * 三、端到端：真实结构 → 内部统一格式
 * ============================================================ */

test('GTO-ADP-06：一次成功查询产出完整的内部格式（含来源、哈希、近似标记、混合频率）', async () => {
  const fake = new FakeGtopen();
  const provider = makeProvider(fake);
  const scenario = firstInScenario(6);
  const result = await provider.lookupScenario(scenario);

  assert.ok(!('status' in result), '6 人桌 RFI 应当成功');
  assert.equal(result.scenarioHash, scenarioHashOf(scenario));
  assert.deepEqual(result.scenario, scenario);
  assert.equal(result.range.actorPosition, 'UTG');
  assert.equal(result.range.hands.length, 169);
  assert.equal(result.range.potBB, 1.5);
  assert.equal(result.range.reachable, true);

  // 元数据必须齐全（来源 / commit / 设置 / 时间 / 近似标记 / 可信度）
  const meta = result.metadata;
  assert.equal(meta.source.engine, 'gtopen');
  assert.equal(meta.source.kind, 'SOLVER');
  assert.ok(meta.source.engineCommit !== null && meta.source.engineCommit.length === 40);
  assert.equal(meta.scenarioHash, result.scenarioHash);
  /*
   * 🔴 Phase 1.1：迭代数不再写死 60，而是**按桌人数标定**
   *（6 人桌的预算是 40 次，见 `GTOPEN_SIZE_PROFILES`）。
   *
   * 更重要的是这条**一致性**：请求的迭代数（进缓存键）必须等于
   * 求解器报告的完成数 —— 否则缓存条目会自相矛盾，
   * 而那种条目会被缓存层正确拒绝（见 GTO-CACHE-22）。
   */
  assert.equal(meta.solveSettings.iterationsRequested, 40, '6 人桌的迭代预算应为 40');
  assert.equal(meta.solveSettings.iterationsCompleted, 40);
  assert.equal(
    meta.solveSettings.iterationsCompleted,
    meta.solveSettings.iterationsRequested,
    '请求数与完成数必须一致（假求解器按请求数汇报）',
  );
  assert.equal(meta.solveSettings.modelName, 'coupled_deck_v1');
  assert.ok(meta.timestamp.length > 0 && !Number.isNaN(Date.parse(meta.timestamp)));
  assert.ok(meta.latencyMs >= 0);
  // 🔴 翻前可信度上限是 APPROXIMATE，永远不能更高
  assert.equal(meta.verification, GtoVerification.APPROXIMATE);
  assert.equal(meta.approximation.approximateModel, true);
  assert.equal(meta.approximation.notConverged, true);
  assert.ok(meta.approximation.notes.length > 0);

  // 频率：全部 ∈ [0,1]，每手牌求和为 1，且**保留混合策略**
  for (const hand of result.range.hands) {
    const sum = hand.actions.reduce((acc, a) => acc + a.frequency, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${hand.hand} 频率之和应为 1，实际 ${sum}`);
    for (const action of hand.actions) {
      assert.ok(action.frequency >= 0 && action.frequency <= 1);
    }
  }
  // AA 纯加注 / 22 纯弃牌 / AKs 与 AKo 是混合
  const aa = result.range.hands.find((h) => h.hand === 'AA')!;
  assert.equal(aa.actions.length, 1);
  assert.equal(aa.actions[0].kind, 'RAISE');
  assert.equal(aa.actions[0].frequency, 1);
  const twoTwo = result.range.hands.find((h) => h.hand === '22')!;
  assert.equal(twoTwo.actions[0].kind, 'FOLD');
  assert.equal(twoTwo.actions[0].frequency, 1);
  const aks = result.range.hands.find((h) => h.hand === 'AKs')!;
  const ako = result.range.hands.find((h) => h.hand === 'AKo')!;
  assert.equal(aks.actions.length, 2, 'AKs 必须是混合策略（不得压成单一动作）');
  assert.equal(ako.actions.length, 2, 'AKo 必须是混合策略');
  assert.notDeepEqual(
    aks.actions.map((a) => a.frequency),
    ako.actions.map((a) => a.frequency),
    'AKs 与 AKo 不得读到同一份频率（同花/不同花互换）',
  );
  // EV：求解器没给 → 必须是 null（不得编造）
  for (const hand of result.range.hands) {
    for (const action of hand.actions) assert.equal(action.evBB, null);
  }
});

test('GTO-ADP-07：手牌 → 类号的取数方向正确（AA 取类号 168 而不是 0）', async () => {
  const fake = new FakeGtopen();
  const provider = makeProvider(fake);
  const result = await provider.lookupScenario(firstInScenario(6));
  assert.ok(!('status' in result));
  const aa = result.range.hands.find((h) => h.hand === 'AA')!;
  const twoTwo = result.range.hands.find((h) => h.hand === '22')!;
  // 假求解器让类号 168 = 纯加注、类号 0 = 纯弃牌
  assert.equal(aa.actions[0].kind, 'RAISE', 'AA 必须取到类号 168 的数据');
  assert.equal(twoTwo.actions[0].kind, 'FOLD', '22 必须取到类号 0 的数据');
});

test('GTO-ADP-08：5 个桌人数都能成功读到 169 类数据，且哈希两两不同', async () => {
  const hashes = new Set<string>();
  for (const size of [4, 5, 6, 8, 9] as const) {
    const fake = new FakeGtopen();
    const provider = makeProvider(fake);
    const scenario = firstInScenario(size);
    const result = await provider.lookupScenario(scenario);
    assert.ok(!('status' in result), `${size} 人桌必须成功`);
    assert.equal(result.range.hands.length, 169, `${size} 人桌必须给出 169 类`);
    hashes.add(result.scenarioHash);
  }
  assert.equal(hashes.size, 5, '5 个桌人数的场景哈希必须两两不同');
});

/* ============================================================
 * 四、场景隔离（桌人数是一级参数）
 * ============================================================ */

test('GTO-ADP-09：同名位置在不同桌人数下必须得到不同的场景哈希与不同的会话', async () => {
  const signatureSet = new Set<string>();
  for (const size of [4, 5, 6, 8, 9] as const) {
    const order = gtoPositionsFor(size);
    const heroIndex = order.indexOf('CO');
    const scenario = buildGtoScenario({
      kind: heroIndex === 0 ? GtoScenarioKind.RFI : GtoScenarioKind.VS_OPEN,
      tableSize: size,
      effectiveStackBB: 100,
      heroPosition: 'CO',
      actionHistory:
        heroIndex === 0
          ? []
          : [
              { position: order[0]!, kind: 'RAISE', sizeBB: 2.5 },
              ...order.slice(1, heroIndex).map((p) => ({
                position: p,
                kind: 'FOLD' as const,
                sizeBB: null,
              })),
            ],
    });
    assert.ok(scenario !== null, `${size} 人桌 CO 场景必须可构造`);
    signatureSet.add(scenarioHashOf(scenario));
    signatureSet.add(sessionSignature(scenario, GTOPEN_DEFAULT_BUDGET));
  }
  assert.equal(signatureSet.size, 10, '5 个场景哈希 + 5 个会话指纹都必须不同');
});

test('GTO-ADP-10：切换桌人数会**重建**求解器会话（不得复用上一棵树的策略）', async () => {
  const fake = new FakeGtopen();
  const provider = makeProvider(fake);
  const four = await provider.lookupScenario(firstInScenario(4));
  assert.ok(!('status' in four));
  const buildsAfterFour = fake.spotBuilds;
  const six = await provider.lookupScenario(firstInScenario(6));
  assert.ok(!('status' in six));
  assert.equal(fake.spotBuilds, buildsAfterFour + 1, '不同桌人数必须重新建树');
  assert.equal(six.range.actorPosition, 'UTG');
  assert.equal(four.range.actorPosition, 'CO');
  // 同一个场景再来一次：不得重复建树（会话还在）
  const again = await provider.lookupScenario(firstInScenario(6));
  assert.ok(!('status' in again));
  assert.equal(fake.spotBuilds, buildsAfterFour + 1, '同一场景不得重复建树');
});

test('GTO-ADP-11：求解器回显的座位表与请求不符 → INVALID_RESPONSE（绝不将就使用）', async () => {
  const fake = new FakeGtopen({ wrongSeats: true });
  const provider = makeProvider(fake);
  const result = await provider.lookupScenario(firstInScenario(6));
  assert.ok('status' in result, '座位表错位必须判为不可用');
  assert.equal(result.status, GtoSolveStatus.GTO_BASELINE_UNAVAILABLE);
  assert.equal(result.cause, GtoSolveStatus.INVALID_RESPONSE);
  assert.match(result.message, /座位/);
});

/* ============================================================
 * 五、值域与结构校验（数据不可信就拒收）
 * ============================================================ */

test('GTO-ADP-12：策略数组长度不符 → INVALID_RESPONSE', async () => {
  const fake = new FakeGtopen({ wrongStrategyLength: true });
  const provider = makeProvider(fake);
  const result = await provider.lookupScenario(firstInScenario(6));
  assert.ok('status' in result);
  assert.equal(result.cause, GtoSolveStatus.INVALID_RESPONSE);
  assert.match(result.message, /策略数组长度/);
});

test('GTO-ADP-13：频率用百分数（0..100）→ 拒收，绝不显示成 6500%', async () => {
  const fake = new FakeGtopen({ percentFrequencies: true });
  const provider = makeProvider(fake);
  const result = await provider.lookupScenario(firstInScenario(6));
  assert.ok('status' in result);
  assert.equal(result.cause, GtoSolveStatus.INVALID_RESPONSE);
  assert.match(result.message, /0\.\.1/);
});

test('GTO-ADP-14：缺字段的部分响应 → INVALID_RESPONSE（不得用默认值续下去）', async () => {
  const fake = new FakeGtopen({ partialResponse: true });
  const provider = makeProvider(fake);
  const result = await provider.lookupScenario(firstInScenario(6));
  assert.ok('status' in result);
  assert.match(result.message, /结构|预期/);
});

test('GTO-ADP-15：求解器没有给出策略 → FAILED，并把原始原因带出来', async () => {
  const fake = new FakeGtopen({ noStrategy: true });
  const provider = makeProvider(fake);
  const result = await provider.lookupScenario(firstInScenario(6));
  assert.ok('status' in result);
  assert.equal(result.cause, GtoSolveStatus.FAILED);
  assert.match(result.message, /strategy|策略/i);
});

/* ============================================================
 * 六、失败回退（Alpha 必须能继续跑）
 * ============================================================ */

test('GTO-ADP-16：求解器没启动（连接被拒）→ OFFLINE，且不抛异常', async () => {
  const fake = new FakeGtopen({ offline: true });
  const provider = makeProvider(fake);
  const result = await provider.lookupScenario(firstInScenario(6));
  assert.ok('status' in result);
  assert.equal(result.status, GtoSolveStatus.GTO_BASELINE_UNAVAILABLE);
  assert.equal(result.cause, GtoSolveStatus.OFFLINE);
  assert.match(result.message, /连不上/);
  // 元数据仍然必须齐全（界面要能显示「哪个场景没拿到」）
  assert.equal(result.scenarioHash, scenarioHashOf(firstInScenario(6)));
  assert.equal(result.metadata.verification, GtoVerification.UNVERIFIED);
});

test('GTO-ADP-17：HTTP 超时 → TIMEOUT（不是 OFFLINE，两者必须能区分）', async () => {
  const fake = new FakeGtopen({ hang: true });
  const provider = makeProvider(fake);
  const result = await provider.lookupScenario(firstInScenario(6));
  assert.ok('status' in result);
  assert.equal(result.cause, GtoSolveStatus.TIMEOUT);
});

test('GTO-ADP-18：响应不是 JSON → INVALID_RESPONSE', async () => {
  const fake = new FakeGtopen({ badJson: true });
  const provider = makeProvider(fake);
  const result = await provider.lookupScenario(firstInScenario(6));
  assert.ok('status' in result);
  assert.equal(result.cause, GtoSolveStatus.INVALID_RESPONSE);
  assert.match(result.message, /JSON/);
});

test('GTO-ADP-19：求解失败（HTTP 500）→ FAILED，带上状态码与正文片段', async () => {
  const fake = new FakeGtopen({ solveFails: true });
  const provider = makeProvider(fake);
  const result = await provider.lookupScenario(firstInScenario(6));
  assert.ok('status' in result);
  assert.equal(result.cause, GtoSolveStatus.FAILED);
  assert.match(result.message, /500/);
});

test('GTO-ADP-20：动作树超限 → UNSUPPORTED，并且**不伪造**任何范围', async () => {
  const fake = new FakeGtopen({ treeTooLarge: true });
  const provider = makeProvider(fake);
  const result = await provider.lookupScenario(firstInScenario(9));
  assert.ok('status' in result);
  assert.equal(result.cause, GtoSolveStatus.UNSUPPORTED);
  assert.match(result.message, /容量上限/);
  // 没有建树 = 没有半截结果
  assert.equal(fake.spotBuilds, 0);
});

test('GTO-ADP-21：求解迟迟不结束 → TIMEOUT，且**不使用**半途策略', async () => {
  const fake = new FakeGtopen({ neverFinishes: true });
  const provider = makeProvider(fake, { solveWaitMs: 30, pollIntervalMs: 5 });
  const result = await provider.lookupScenario(firstInScenario(6));
  assert.ok('status' in result);
  assert.equal(result.cause, GtoSolveStatus.TIMEOUT);
  assert.match(result.message, /不提供|不能被当成基线/);
});

test('GTO-ADP-22：不支持的桌人数（7 人桌）→ UNSUPPORTED，且不发任何请求', async () => {
  const fake = new FakeGtopen();
  const provider = makeProvider(fake);
  const seven = {
    ...firstInScenario(6),
    tableSize: 7 as 6,
  };
  const result = await provider.lookupScenario(seven);
  assert.ok('status' in result);
  assert.equal(result.cause, GtoSolveStatus.UNSUPPORTED);
  assert.equal(fake.requests.length, 0, '不支持的桌人数不得发出任何 HTTP 请求');
});

/* ============================================================
 * 七、缓存（必须含桌人数，且失败不缓存）
 * ============================================================ */

test('GTO-ADP-23：缓存按场景哈希隔离 —— 4MAX 的 BTN 不得命中 9MAX 的 BTN', async () => {
  const fake = new FakeGtopen();
  const lookup = new GtoSafeLookup(makeProvider(fake), { store: null });
  const four = firstInScenario(4);
  const nine = firstInScenario(9);
  await lookup.lookupWithStats(four);
  const second = await lookup.lookupWithStats(nine);
  assert.equal(second.stats.cacheHit, false, '不同桌人数必须是不同的缓存键');
  assert.equal(lookup.cacheSize(), 2);
});

test('GTO-ADP-24：同一场景第二次查询命中缓存，且打上 fromCache 标记', async () => {
  const fake = new FakeGtopen();
  const lookup = new GtoSafeLookup(makeProvider(fake), { store: null });
  const scenario = firstInScenario(6);
  const first = await lookup.lookupWithStats(scenario);
  assert.equal(first.stats.cacheHit, false);
  assert.ok(!('status' in first.result));
  assert.equal(first.result.metadata.approximation.fromCache, false);

  const buildsAfterFirst = fake.spotBuilds;
  const second = await lookup.lookupWithStats(scenario);
  assert.equal(second.stats.cacheHit, true);
  assert.ok(!('status' in second.result));
  assert.equal(second.result.metadata.approximation.fromCache, true, '缓存结果必须自我声明');
  assert.ok(second.result.metadata.approximation.notes.some((n) => n.includes('缓存')));
  assert.equal(fake.spotBuilds, buildsAfterFirst, '命中缓存不得再建树');
});

test('GTO-ADP-25：失败结果**不**缓存（否则求解器重启后界面仍显示旧的「离线」）', async () => {
  const fake = new FakeGtopen({ offline: true });
  const lookup = new GtoSafeLookup(makeProvider(fake), { store: null });
  const scenario = firstInScenario(6);
  const first = await lookup.lookupWithStats(scenario);
  assert.equal(first.stats.cacheHit, false);
  assert.equal(lookup.cacheSize(), 0);

  // 求解器起来了 → 同一个场景必须能拿到数据
  fake.setBehaviour({});
  const second = await lookup.lookupWithStats(scenario);
  assert.equal(second.stats.cacheHit, false);
  assert.ok(!('status' in second.result), '求解器恢复后必须能拿到数据');
});

test('GTO-ADP-26：外层硬超时兜底（Provider 卡住也不会让调用方无限等待）', async () => {
  // 构造一个永远不 resolve 的 Provider
  const stuck = {
    engine: 'stuck',
    displayName: '卡住的求解器',
    health: async () => ({
      reachable: true,
      engine: 'stuck',
      version: null,
      commit: null,
      endpoint: null,
      message: '',
    }),
    capabilities: async () => null,
    lookupScenario: () => new Promise<never>(() => undefined),
    /*
     * Phase 1.1：`solveKeyParts` 是**同步**调用（缓存键必须在发起求解前算好），
     * 它不能像 `lookupScenario` 那样返回永不 resolve 的 Promise。
     *
     * 因此这里返回一份**合法**的键，让流程能走到 `lookupScenario`
     * 并被外层硬超时兜住 —— 这正是本用例要测的东西。
     */
    solveKeyParts: () => ({
      engine: 'stuck',
      engineCommit: null,
      solverVersion: null,
      openSizesBB: [2.5],
      raiseMults: [3],
      maxRaises: 2,
      limp: false,
      addAllin: false,
      rakePct: 0,
      rakeCap: 0,
      realization: 'static',
      multiwayEquityModel: null,
      iterations: 10,
      targetGap: 0,
      checkEvery: 10,
      enginePositions: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
      posts: [0, 0, 0, 0, 0.5, 1],
      ante: 0,
    }),
  };
  const lookup = new GtoSafeLookup(stuck, { hardTimeoutMs: 25, store: null });
  const result = await lookup.lookupWithStats(firstInScenario(6));
  assert.ok('status' in result.result);
  assert.equal(result.result.cause, GtoSolveStatus.TIMEOUT);
  assert.equal(result.stats.timedOut, true);
  assert.match(result.result.message, /硬超时/);
});

/* ============================================================
 * 八、真人信息隔离（Tilt 等不得进入理论查询）
 * ============================================================ */

test('GTO-ADP-27：改变 Tilt / 画像 / 动态提示**不改变**同一理论场景的查询', async () => {
  const fake = new FakeGtopen();
  const provider = makeProvider(fake);
  const base = firstInScenario(6);

  // 「同一个理论场景」+ 大量真人信息（这些字段在类型上就进不去 GtoScenario）
  const withHumanContext = {
    ...base,
    tilt: 0.9,
    emotion: 'ANGRY',
    gamble: 0.8,
    playerLevel: 'FISH',
    recentResult: -500,
    quickProfile: 'MANIAC',
    dynamicHint: 'TILT_SIGNAL',
    bluffHistory: [true, true, false],
    habit: 'OVERBET_RIVER',
  } as unknown as GtoScenario;

  const hashA = scenarioHashOf(base);
  const hashB = scenarioHashOf(withHumanContext);
  assert.equal(hashA, hashB, '真人信息不得改变场景哈希');

  fake.requests.length = 0;
  const first = await provider.lookupScenario(base);
  const nodeRequestsA = JSON.stringify(
    fake.requests.filter((r) => r.path === '/api/preflop/node').map((r) => r.body),
  );
  fake.requests.length = 0;
  const second = await provider.lookupScenario(withHumanContext);
  const nodeRequestsB = JSON.stringify(
    fake.requests.filter((r) => r.path === '/api/preflop/node').map((r) => r.body),
  );

  assert.ok(!('status' in first) && !('status' in second));
  assert.equal(
    nodeRequestsA,
    nodeRequestsB,
    '节点查询请求必须逐字节一致（Tilt 不得进入请求体）',
  );
  assert.deepEqual(
    first.range.hands.map((h) => h.actions.map((a) => a.frequency)),
    second.range.hands.map((h) => h.actions.map((a) => a.frequency)),
    'GTO 基线必须逐位一致',
  );
  assert.equal(first.scenarioHash, second.scenarioHash);
  assert.deepEqual(
    first.metadata.solveSettings.raw['solveBudget'],
    second.metadata.solveSettings.raw['solveBudget'],
    '求解设置不得因真人信息而改变',
  );
});

test('GTO-ADP-28：发给求解器的请求体里不得出现任何真人字段名', async () => {
  const fake = new FakeGtopen();
  const provider = makeProvider(fake);
  await provider.lookupScenario(firstInScenario(6));
  const serialized = JSON.stringify(fake.requests.map((r) => r.body));
  for (const forbidden of [
    'tilt',
    'emotion',
    'gamble',
    'playerLevel',
    'recentResult',
    'quickProfile',
    'dynamicHint',
    'bluffHistory',
    'habit',
    'profile',
    'exploit',
  ]) {
    assert.ok(
      !serialized.toLowerCase().includes(forbidden.toLowerCase()),
      `请求体不得出现真人字段「${forbidden}」`,
    );
  }
});

/* ============================================================
 * 九、并发（GTOpen 只有一个会话）
 * ============================================================ */

test('GTO-ADP-29：并发查询被串行化，且各自拿到自己场景的结果', async () => {
  const fake = new FakeGtopen();
  const provider = makeProvider(fake);
  const sizes = [4, 5, 6] as const;
  const scenarios = sizes.map((s) => firstInScenario(s));
  const results = await Promise.all(scenarios.map((s) => provider.lookupScenario(s)));
  results.forEach((result, index) => {
    assert.ok(!('status' in result), `${sizes[index]} 人桌并发查询必须成功`);
    assert.equal(result.range.hands.length, 169);
    // 行动者必须是该桌型自己的第一个行动位
    assert.equal(result.range.actorPosition, gtoPositionsFor(sizes[index]!)[0]);
    assert.equal(result.scenarioHash, scenarioHashOf(scenarios[index]!));
  });
  // 三次不同场景 → 至少三次建树（不得因为并发而交叉使用同一棵树）
  assert.ok(fake.spotBuilds >= 3, `并发查询必须各建各的树，实际建树 ${fake.spotBuilds} 次`);
});

/* ============================================================
 * 十、解析函数的单元边界
 * ============================================================ */

test('GTO-ADP-30：parseNodeView 对非法结构一律返回 null（不猜、不补默认值）', () => {
  assert.equal(parseNodeView(null), null);
  assert.equal(parseNodeView('nope'), null);
  assert.equal(parseNodeView([]), null);
  assert.equal(parseNodeView({}), null);
  assert.equal(parseNodeView({ positions: ['UTG'] }), null, '缺 actions 必须拒绝');
  assert.equal(
    parseNodeView({ positions: [1, 2], actions: [] }),
    null,
    '位置必须是字符串',
  );
  assert.equal(
    parseNodeView({ positions: ['UTG'], actions: [{ label: 'Fold', kind: 'fold', to: 0 }] }),
    null,
    '动作缺 freq 必须拒绝',
  );
  assert.equal(
    parseNodeView({ positions: ['UTG'], actions: [{ label: 'X', kind: 'weird', to: 0, freq: 1 }] })?.actions[0].kind,
    'weird',
    '未知 kind 在这一层保留原样，由上层判 INVALID_RESPONSE',
  );
});

test('GTO-ADP-31：parseStatus 把 publication 与完整 status 都归一化，且不虚构 state', () => {
  const publication = parseStatus(
    { published_iteration: 60, gap_total: 0.06, target_gap: 0, converged: false, multiway_model: 'coupled_deck_v1' },
    true,
  );
  assert.ok(publication !== null);
  assert.equal(publication.publishedIteration, 60);
  assert.equal(publication.gapTotal, 0.06);
  assert.equal(publication.multiwayEquityModel, 'coupled_deck_v1');
  assert.equal(publication.state, 'running', '未收敛时不得声称 done');

  const full = parseStatus({ state: 'done', stop_reason: 'iteration_limit', iteration: 60, gap_total: 0.06 });
  assert.equal(full?.state, 'done');
  assert.equal(full?.stopReason, 'iteration_limit');
  assert.equal(parseStatus({}), null, '缺 state 必须返回 null');
  assert.equal(parseStatus(null), null);
});

test('GTO-ADP-32：HTTP 客户端对空响应与超大响应都要拒绝', async () => {
  const emptyClient = new GtoHttpClient({
    baseUrl: 'http://x',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '   ' }),
  });
  const empty = await emptyClient.getJson('/api/preflop/status');
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error.kind, 'INVALID_RESPONSE');

  const bigClient = new GtoHttpClient({
    baseUrl: 'http://x',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(17 * 1024 * 1024) }),
  });
  const big = await bigClient.getJson('/api/preflop/node');
  assert.equal(big.ok, false);
  if (!big.ok) assert.match(big.error.message, /过大/);
});

/* ============================================================
 * 十一、按桌人数的求解画像（实测标定的取舍必须被测试锁住）
 * ============================================================ */

test('GTO-ADP-33：8/9 人桌不提供全下，4/5/6 人桌提供（附实测依据）', () => {
  // 依据：本机实测 add_allin 让每次迭代慢约 5 倍
  //（6 人桌 0.73s → 1.90s；8 人桌 5.07s → 29.2s），且 8 人桌带全下时
  // 10 次迭代后 BR gap 之和仍是 5.455（不带全下是 0.025，即**根本没在收敛**）。
  for (const size of [4, 5, 6] as const) {
    assert.equal(profileForTableSize(size).addAllin, true, `${size} 人桌应提供全下`);
  }
  for (const size of [8, 9] as const) {
    assert.equal(profileForTableSize(size).addAllin, false, `${size} 人桌不应提供全下`);
  }
  // 未知桌人数 → 最保守（不给全下、迭代最少）
  assert.deepEqual(profileForTableSize(7), { addAllin: false, iterations: 12 });
  assert.deepEqual(profileForTableSize(2), { addAllin: false, iterations: 12 });
});

test('GTO-ADP-34：迭代数随桌人数递减，且 8/9 人桌必须比 4/5/6 少', () => {
  assert.equal(iterationsForTableSize(4), 60);
  assert.equal(iterationsForTableSize(5), 60);
  assert.equal(iterationsForTableSize(6), 40);
  assert.equal(iterationsForTableSize(8), 20);
  assert.equal(iterationsForTableSize(9), 12);
  assert.ok(
    iterationsForTableSize(9) < iterationsForTableSize(4),
    '9 人桌的迭代数必须少于 4 人桌（否则一次查询要十几分钟）',
  );
});

test('GTO-ADP-35：请求体里的 add_allin 按桌人数取值，且进会话指纹（换档必须重建树）', () => {
  const four = firstInScenario(4);
  const nine = firstInScenario(9);

  const cfg4 = buildEngineConfig(four, GTOPEN_DEFAULT_BUDGET, true);
  assert.equal(cfg4['add_allin'], true);
  assert.deepEqual(cfg4['positions'], ['CO', 'BTN', 'SB', 'BB']);

  const cfg9 = buildEngineConfig(nine, GTOPEN_DEFAULT_BUDGET, profileForTableSize(9).addAllin);
  assert.equal(cfg9['add_allin'], false);
  assert.equal(cfg9['max_raises'], 2);
  assert.equal(cfg9['limp'], false);

  // 会话指纹必须包含 addAllin：否则「同尺寸但全下开关不同」会被误判为同一个会话，
  // 于是拿到的策略属于另一棵树 —— 这正是「旧结果用于新场景」的形态。
  assert.notEqual(
    sessionSignature(nine, GTOPEN_DEFAULT_BUDGET, true),
    sessionSignature(nine, GTOPEN_DEFAULT_BUDGET, false),
    '全下开关必须进会话指纹',
  );
  assert.notEqual(
    sessionSignature(four, GTOPEN_DEFAULT_BUDGET, true),
    sessionSignature(nine, GTOPEN_DEFAULT_BUDGET, true),
    '桌人数必须进会话指纹',
  );
});

test('GTO-ADP-36：8/9 人桌的结果必须**明确写出**「本次不含全下」及原因', async () => {
  const nine = await makeProvider(new FakeGtopen()).lookupScenario(firstInScenario(9));
  assert.ok(!('status' in nine), '9 人桌查询必须成功');
  const notes = nine.metadata.approximation.notes;
  assert.ok(
    notes.some((n) => n.includes('不含全下')),
    `9 人桌的近似说明必须写明「不含全下」，实际：\n${notes.join('\n')}`,
  );
  assert.ok(
    notes.some((n) => n.includes('5 倍') || n.includes('收敛')),
    '必须给出「为什么不含全下」的依据',
  );

  // 4 人桌提供全下 → 不得出现那条说明
  const four = await makeProvider(new FakeGtopen()).lookupScenario(firstInScenario(4));
  assert.ok(!('status' in four));
  assert.ok(
    !four.metadata.approximation.notes.some((n) => n.includes('不含全下')),
    '4 人桌提供全下，不应出现「不含全下」的说明',
  );
});

test('GTO-ADP-37：实际请求的迭代数与 add_allin 都按桌人数取', async () => {
  const fake9 = new FakeGtopen();
  await makeProvider(fake9).lookupScenario(firstInScenario(9));
  const solve9 = fake9.requests.find((r) => r.path === '/api/preflop/solve');
  assert.ok(solve9 !== undefined);
  assert.equal(solve9.body?.['iterations'], 12, '9 人桌必须请求 12 次迭代');
  const spot9 = fake9.requests.find((r) => r.path === '/api/preflop/spot');
  assert.equal(spot9?.body?.['add_allin'], false, '9 人桌建树不得带全下');

  const fake4 = new FakeGtopen();
  await makeProvider(fake4).lookupScenario(firstInScenario(4));
  const solve4 = fake4.requests.find((r) => r.path === '/api/preflop/solve');
  assert.equal(solve4?.body?.['iterations'], 60, '4 人桌必须请求 60 次迭代');
  const spot4 = fake4.requests.find((r) => r.path === '/api/preflop/spot');
  assert.equal(spot4?.body?.['add_allin'], true, '4 人桌建树应带全下');
});
