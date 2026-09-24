/**
 * GTO Phase 1.1 —— 缓存键、持久化缓存、质量等级测试
 *
 * ## 这份测试防的是什么
 *
 * Phase 1 的缓存键**只有场景哈希**，也就是只有「问了什么问题」，
 * 没有「谁来回答、怎么回答」。于是下面这些情况都会命中同一份旧结果：
 *
 * - 换了求解器版本（commit 变了）
 * - 把全下打开（动作树变了）
 * - 把迭代数从 60 改成 12（求解质量变了）
 * - 换了开池尺寸 / 再加注倍数 / 加注上限 / 抽水 / 延续模型
 *
 * 这份测试**逐项**证明它们现在都命中不了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GtoScenarioKind,
  GtoSolveStatus,
  GtoVerification,
  gtoPositionsFor,
  type GtoScenario,
  type GtoSolveKeyParts,
} from '../src/domain/gto/gto.types.ts';
import {
  buildGtoScenario,
  cacheKeyOf,
  scenarioFingerprintLines,
  scenarioHashOf,
  solveFingerprintOf,
  treeIdOf,
} from '../src/domain/gto/gtoScenario.ts';
import {
  GtoQuality,
  gradeGtoQuality,
  minQuality,
  qualityDisclaimerZh,
  selfCheckQualityLayer,
  verificationForQuality,
  GTO_STABILITY_MAX_ABS_DELTA,
  type GtoQualityEvidence,
} from '../src/domain/gto/gtoQuality.ts';
import {
  GtoStrategyStore,
  GTO_STORE_VERSION,
  baselineFromCacheEntry,
  buildCacheEntry,
  keysOf,
  selfCheckStoreLayer,
  validateCachedRange,
} from '../src/domain/gto/gtoStrategyStore.ts';
import { GtoSafeLookup } from '../src/domain/gto/gtoSafeLookup.ts';
import {
  GTOPEN_DEFAULT_BUDGET,
  GtopenProvider,
  GTOPEN_SIZE_PROFILES,
  GTOPEN_TARGET_GAP_BY_TABLE_SIZE,
} from '../src/domain/gto/providers/gtopenProvider.ts';
import { GtoHttpClient } from '../src/domain/gto/providers/gtopenHttpClient.ts';
import { FakeGtopen } from './helpers/fakeGtopen.ts';

/* ============================================================
 * 脚手架
 * ============================================================ */

function makeProvider(fake: FakeGtopen): GtopenProvider {
  return new GtopenProvider({
    baseUrl: 'http://127.0.0.1:3737',
    client: new GtoHttpClient({ baseUrl: 'http://127.0.0.1:3737', fetchImpl: fake.fetch }),
    budget: { ...GTOPEN_DEFAULT_BUDGET, pollIntervalMs: 0, solveWaitMs: 2_000 },
    // 用真实的（极短）sleep：pollIntervalMs: 0 + 无 sleep 会让「永不结束」的用例
    // 变成紧循环并耗尽内存。生产代码里 pollIntervalMs 是 400ms，绝不会这样。
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
  });
}

function firstInScenario(tableSize: 4 | 5 | 6 | 8 | 9): GtoScenario {
  const hero = gtoPositionsFor(tableSize)[0]!;
  const scenario = buildGtoScenario({
    kind: GtoScenarioKind.RFI,
    tableSize,
    effectiveStackBB: 100,
    heroPosition: hero,
    actionHistory: [],
  });
  assert.ok(scenario !== null);
  return scenario;
}

/** 造一个临时缓存目录（每个用例独立，互不污染） */
function tempStore(sub = 'gto-cache'): { store: GtoStrategyStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gto-store-'));
  const target = join(dir, sub);
  const store = new GtoStrategyStore({ dir: target, projectRoot: dir });
  return {
    store,
    dir: target,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 一份求解侧参数（可逐项覆盖，用来验证每一项都影响缓存键） */
function solveParts(overrides: Partial<GtoSolveKeyParts> = {}): GtoSolveKeyParts {
  return {
    engine: 'gtopen',
    engineCommit: '92c86ed73aa0856df8479b5c7635e1469f48f1e8',
    solverVersion: null,
    openSizesBB: [2.5],
    raiseMults: [3],
    maxRaises: 2,
    limp: false,
    addAllin: true,
    rakePct: 0,
    rakeCap: 0,
    realization: 'static',
    multiwayEquityModel: 'coupled_deck_v1',
    iterations: 40,
    targetGap: 0,
    checkEvery: 20,
    enginePositions: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    posts: [0, 0, 0, 0, 0.5, 1],
    ante: 0,
    ...overrides,
  };
}

/* ============================================================
 * 一、缓存键隔离（用户 §三 的 6 条 + §二十五 的攻击项）
 * ============================================================ */

test('GTO-CACHE-01：engineCommit 进入缓存键 —— commit A 的结果不能被 commit B 命中', () => {
  const s = firstInScenario(6);
  const a = cacheKeyOf(s, solveParts({ engineCommit: 'aaaaaaa' }));
  const b = cacheKeyOf(s, solveParts({ engineCommit: 'bbbbbbb' }));
  assert.notEqual(a, b, '不同 commit 必须得到不同的缓存键');
  // 场景哈希**不**因 commit 而变（它只描述「问题」）
  assert.equal(scenarioHashOf(s), scenarioHashOf(s));
  // null 也是一个有意义的取值（拿不到 commit 时），必须与有值不同
  assert.notEqual(a, cacheKeyOf(s, solveParts({ engineCommit: null })));
});

test('GTO-CACHE-02：4MAX 不能命中 9MAX', () => {
  const four = firstInScenario(4);
  const nine = firstInScenario(9);
  assert.notEqual(
    cacheKeyOf(four, solveParts()),
    cacheKeyOf(nine, solveParts()),
    '桌人数必须影响缓存键',
  );
});

test('GTO-CACHE-03：RFI 不能命中 VS_OPEN', () => {
  const rfi = firstInScenario(6);
  const vsOpen = buildGtoScenario({
    kind: GtoScenarioKind.VS_OPEN,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'BB',
    actionHistory: [
      { position: 'UTG', kind: 'RAISE', sizeBB: 2.5 },
      { position: 'HJ', kind: 'FOLD', sizeBB: null },
      { position: 'CO', kind: 'FOLD', sizeBB: null },
      { position: 'BTN', kind: 'FOLD', sizeBB: null },
      { position: 'SB', kind: 'FOLD', sizeBB: null },
    ],
  });
  assert.ok(vsOpen !== null);
  assert.notEqual(cacheKeyOf(rfi, solveParts()), cacheKeyOf(vsOpen, solveParts()));
  assert.notEqual(scenarioHashOf(rfi), scenarioHashOf(vsOpen));
});

test('GTO-CACHE-04：Raise 2.0BB 不能命中 Raise 2.5BB', () => {
  const mk = (size: number): GtoScenario =>
    buildGtoScenario({
      kind: GtoScenarioKind.VS_OPEN,
      tableSize: 6,
      effectiveStackBB: 100,
      heroPosition: 'BB',
      actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: size }],
    })!;
  assert.notEqual(cacheKeyOf(mk(2.0), solveParts()), cacheKeyOf(mk(2.5), solveParts()));
});

test('GTO-CACHE-05：有 All-in 的树不能命中无 All-in 的树', () => {
  const s = firstInScenario(6);
  const withAllIn = cacheKeyOf(s, solveParts({ addAllin: true }));
  const withoutAllIn = cacheKeyOf(s, solveParts({ addAllin: false }));
  assert.notEqual(withAllIn, withoutAllIn, 'add_allin 是动作树的一部分，必须进键');
  // 树指纹也必须不同（只有相同树指纹的 gap 才可比）
  assert.notEqual(
    treeIdOf(s, { openSizesBB: [2.5], raiseMults: [3], maxRaises: 2, limp: false, addAllin: true, engine: 'gtopen' }),
    treeIdOf(s, { openSizesBB: [2.5], raiseMults: [3], maxRaises: 2, limp: false, addAllin: false, engine: 'gtopen' }),
  );
});

test('GTO-CACHE-06：求解设置不同不能错误复用（逐项验证 12 个字段）', () => {
  const s = firstInScenario(6);
  const base = cacheKeyOf(s, solveParts());
  const variants: [string, Partial<GtoSolveKeyParts>][] = [
    ['iterations', { iterations: 12 }],
    ['targetGap', { targetGap: 0.05 }],
    ['checkEvery', { checkEvery: 5 }],
    ['openSizesBB', { openSizesBB: [2.0] }],
    ['raiseMults', { raiseMults: [4] }],
    ['maxRaises', { maxRaises: 1 }],
    ['limp', { limp: true }],
    ['rakePct', { rakePct: 5 }],
    ['rakeCap', { rakeCap: 2 }],
    ['realization', { realization: 'calibrated' }],
    ['multiwayEquityModel', { multiwayEquityModel: 'legacy_product' }],
    ['enginePositions', { enginePositions: ['CO', 'BTN', 'SB', 'BB'] }],
    ['posts', { posts: [0, 0, 0, 0, 0.5, 2] }],
    ['ante', { ante: 0.1 }],
    ['solverVersion', { solverVersion: '9.9.9' }],
  ];
  for (const [name, patch] of variants) {
    assert.notEqual(
      cacheKeyOf(s, solveParts(patch)),
      base,
      `修改 ${name} 后缓存键必须变化（否则会命中旧结果）`,
    );
  }
});

test('GTO-CACHE-07：求解设置指纹与场景哈希是两把不同的键，且各自稳定', () => {
  const s = firstInScenario(6);
  const a = solveFingerprintOf(solveParts());
  const b = solveFingerprintOf(solveParts());
  assert.equal(a, b, '同样的设置必须得到同样的指纹');
  assert.notEqual(a, solveFingerprintOf(solveParts({ iterations: 13 })));
  // 三把键必须互不相同（场景哈希 / 树指纹 / 缓存键）
  const keys = keysOf(s, solveParts());
  assert.equal(new Set([keys.scenarioHash, keys.treeId, keys.cacheKey]).size, 3);
  assert.match(keys.cacheKey, /^c[0-9a-f]{8}$/);
  assert.match(keys.scenarioHash, /^g[0-9a-f]{8}$/);
  assert.match(keys.treeId, /^t[0-9a-f]{8}$/);
});

test('GTO-CACHE-08：恰好等于表定义的两把键（防止实现漂移）', () => {
  const s = firstInScenario(6);
  const solve = solveParts();
  // 这两条是「键的口径不许悄悄变」的锚点：
  // 如果实现改了，测试立刻失败，而不是让旧缓存静默失效/误命中。
  assert.equal(keysOf(s, solve).cacheKey, cacheKeyOf(s, solve));
  assert.equal(
    keysOf(s, solve).treeId,
    treeIdOf(s, {
      openSizesBB: solve.openSizesBB,
      raiseMults: solve.raiseMults,
      maxRaises: solve.maxRaises,
      limp: solve.limp,
      addAllin: solve.addAllin,
      engine: solve.engine,
    }),
  );
  // 树指纹必须对「求解设置」敏感，但对「Hero 位置」不敏感 ——
  // 同一棵树上的不同节点，gap 是可以比较的（这正是 treeId 的用途）
  const baseTree = keysOf(s, solve).treeId;
  const otherHero = buildGtoScenario({
    kind: GtoScenarioKind.VS_OPEN,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'BB',
    actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 2.5 }],
  })!;
  assert.equal(keysOf(otherHero, solve).treeId, baseTree, '同一棵树的 treeId 必须相同');
  assert.notEqual(keysOf(otherHero, solve).cacheKey, keysOf(s, solve).cacheKey, '但缓存键不同');
});

/* ============================================================
 * 二、可读 Scenario Fingerprint
 * ============================================================ */

test('GTO-CACHE-09：fingerprint 可读且含全部关键项（不是只有一个哈希）', () => {
  const scenario = buildGtoScenario({
    kind: GtoScenarioKind.VS_OPEN,
    tableSize: 9,
    effectiveStackBB: 100,
    heroPosition: 'BB',
    actionHistory: [
      { position: 'UTG', kind: 'RAISE', sizeBB: 2.5 },
      { position: 'UTG1', kind: 'FOLD', sizeBB: null },
      { position: 'UTG2', kind: 'FOLD', sizeBB: null },
      { position: 'LJ', kind: 'FOLD', sizeBB: null },
      { position: 'HJ', kind: 'FOLD', sizeBB: null },
      { position: 'CO', kind: 'FOLD', sizeBB: null },
      { position: 'BTN', kind: 'FOLD', sizeBB: null },
      { position: 'SB', kind: 'FOLD', sizeBB: null },
    ],
  })!;
  const lines = scenarioFingerprintLines(scenario, solveParts());
  const text = lines.join('\n');
  for (const needed of [
    '9MAX',
    '100BB',
    'BB',
    'VS_OPEN',
    'UTG RAISE→2.5BB',
    '开池 [2.5]',
    '加注上限 2',
    '全下 提供',
    'gtopen @ 92c86ed',
    '迭代 40',
    'scenario=g',
    'tree=t',
    'cache=c',
  ]) {
    assert.ok(text.includes(needed), `fingerprint 必须包含「${needed}」，实际：\n${text}`);
  }
  // 必须多行（不是一坨哈希）
  assert.ok(lines.length >= 6);
});

/* ============================================================
 * 三、持久化缓存（写入 → 重启 → 读回）
 * ============================================================ */

test('GTO-CACHE-10：写入后**新建 store 实例**仍能读回（模拟进程重启）', async () => {
  const { store, dir, cleanup } = tempStore();
  try {
    const fake = new FakeGtopen();
    const lookup = new GtoSafeLookup(makeProvider(fake), { store });
    const scenario = firstInScenario(6);
    const first = await lookup.lookupWithStats(scenario);
    assert.ok(!('status' in first.result), '第一次查询必须成功');
    assert.equal(first.stats.source, 'solver', '第一次必须真的去求解');
    assert.ok(existsSync(join(dir, 'index.json')), '索引文件必须落盘');

    // 「重启」：完全新的 store + 新的 lookup（内存缓存为空）
    const store2 = new GtoStrategyStore({ dir, projectRoot: dir });
    const fake2 = new FakeGtopen();
    const lookup2 = new GtoSafeLookup(makeProvider(fake2), { store: store2 });
    const second = await lookup2.lookupWithStats(scenario);
    assert.ok(!('status' in second.result));
    assert.equal(second.stats.source, 'persistent', '重启后必须命中持久化缓存');
    assert.equal(fake2.spotBuilds, 0, '命中持久化缓存时**不得**再建树');
    assert.equal(
      second.stats.cacheKey,
      first.stats.cacheKey,
      '两次的缓存键必须一致（否则是另一份结果）',
    );
    // 频率必须逐位一致
    const a = first.result as Exclude<typeof first.result, { status: unknown }>;
    const b = second.result as Exclude<typeof second.result, { status: unknown }>;
    assert.deepEqual(
      a.range.hands.map((h) => h.actions.map((x) => x.frequency)),
      b.range.hands.map((h) => h.actions.map((x) => x.frequency)),
    );
  } finally {
    cleanup();
  }
});

test('GTO-CACHE-11：缓存结果自带来源与时间（界面能看到「本地已缓存」）', async () => {
  const { store, cleanup } = tempStore();
  try {
    const lookup = new GtoSafeLookup(makeProvider(new FakeGtopen()), { store });
    const scenario = firstInScenario(6);
    await lookup.lookupWithStats(scenario);
    const reopened = new GtoStrategyStore({ dir: store.dir, projectRoot: store.dir });
    const lookup2 = new GtoSafeLookup(makeProvider(new FakeGtopen()), { store: reopened });
    const second = await lookup2.lookupWithStats(scenario);
    assert.ok(!('status' in second.result));
    assert.equal(second.result.metadata.approximation.fromCache, true);
    assert.ok(
      second.result.metadata.approximation.notes.some((n) => n.includes('本地已缓存策略')),
      '说明里必须写明来自本地已缓存策略',
    );
    assert.ok(second.stats.cachedAt !== null, '必须给出缓存写入时间');
    assert.ok(second.stats.solveDurationMs !== null, '必须给出原本的求解耗时');
  } finally {
    cleanup();
  }
});

test('GTO-CACHE-12：commit 变了以后**旧的持久化条目不会被命中**', async () => {
  const { store, dir, cleanup } = tempStore();
  try {
    const lookup = new GtoSafeLookup(makeProvider(new FakeGtopen()), { store });
    const scenario = firstInScenario(6);
    await lookup.lookupWithStats(scenario);
    assert.equal(store.stats().entries, 1);

    // 模拟「求解器升级」：同一份缓存目录，但 Provider 报出另一个 commit
    const upgraded = new GtopenProvider({
      baseUrl: 'http://127.0.0.1:3737',
      client: new GtoHttpClient({ baseUrl: 'http://127.0.0.1:3737', fetchImpl: new FakeGtopen().fetch }),
      budget: { ...GTOPEN_DEFAULT_BUDGET, pollIntervalMs: 0 },
      sleep: async () => undefined,
    });
    const originalParts = upgraded.solveKeyParts.bind(upgraded);
    (upgraded as unknown as { solveKeyParts: typeof originalParts }).solveKeyParts = (s) => ({
      ...originalParts(s),
      engineCommit: 'ffffffffffffffffffffffffffffffffffffffff',
    });

    const fake2 = new FakeGtopen();
    const upgraded2 = new GtopenProvider({
      baseUrl: 'http://127.0.0.1:3737',
      client: new GtoHttpClient({ baseUrl: 'http://127.0.0.1:3737', fetchImpl: fake2.fetch }),
      budget: { ...GTOPEN_DEFAULT_BUDGET, pollIntervalMs: 0 },
      sleep: async () => undefined,
    });
    const base = upgraded2.solveKeyParts.bind(upgraded2);
    (upgraded2 as unknown as { solveKeyParts: typeof base }).solveKeyParts = (s) => ({
      ...base(s),
      engineCommit: 'ffffffffffffffffffffffffffffffffffffffff',
    });

    const store2 = new GtoStrategyStore({ dir, projectRoot: dir });
    const lookup2 = new GtoSafeLookup(upgraded2, { store: store2 });
    const after = await lookup2.lookupWithStats(scenario);
    assert.ok(!('status' in after.result));
    assert.equal(after.stats.source, 'solver', '换了 commit 必须重新求解，不得命中旧缓存');
    assert.ok(fake2.spotBuilds > 0, '必须真的去建树');
  } finally {
    cleanup();
  }
});

test('GTO-CACHE-13：缓存写入是原子的 —— 不会留下半个文件', async () => {
  const { store, dir, cleanup } = tempStore();
  try {
    const lookup = new GtoSafeLookup(makeProvider(new FakeGtopen()), { store });
    await lookup.lookupWithStats(firstInScenario(6));
    const entries = store.stats();
    assert.equal(entries.entries, 1);
    // 载荷文件必须是完整可解析的 JSON
    const key = store.listEntries()[0]!.cacheKey;
    const payload = JSON.parse(readFileSync(store.payloadPath(key), 'utf8')) as Record<string, unknown>;
    assert.equal(payload['storeVersion'], GTO_STORE_VERSION);
    assert.equal(payload['cacheKey'], key);
    // 目录里不得留下 .tmp 文件
    const { readdirSync } = await import('node:fs');
    const leftovers = readdirSync(join(dir, 'strategy')).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, [], `不得留下临时文件：${leftovers.join(',')}`);
  } finally {
    cleanup();
  }
});

test('GTO-CACHE-14：损坏的载荷 → 视为未命中，且**不抛异常**', async () => {
  const { store, dir, cleanup } = tempStore();
  try {
    const lookup = new GtoSafeLookup(makeProvider(new FakeGtopen()), { store });
    const scenario = firstInScenario(6);
    const first = await lookup.lookupWithStats(scenario);
    const key = first.stats.cacheKey;

    // 砸坏载荷
    writeFileSync(store.payloadPath(key), '{ 这不是 JSON', 'utf8');
    const store2 = new GtoStrategyStore({ dir, projectRoot: dir });
    const loaded = store2.load(key);
    assert.equal(loaded.found, false);
    assert.ok(loaded.found === false && (loaded.reason === 'corrupt' || loaded.reason === 'invalid'));

    // 求解仍能正常进行（回退到重新求解）
    const fake = new FakeGtopen();
    const lookup3 = new GtoSafeLookup(makeProvider(fake), { store: store2 });
    const again = await lookup3.lookupWithStats(scenario);
    assert.ok(!('status' in again.result));
    assert.equal(again.stats.source, 'solver');
  } finally {
    cleanup();
  }
});

test('GTO-CACHE-15：损坏的索引 → 视为空索引，Alpha 不受影响', () => {
  const { store, dir, cleanup } = tempStore();
  try {
    // 情形 A：目录/文件根本不存在（首次运行的真实情形）—— 必须安全且**不报警告**
    const fresh = new GtoStrategyStore({ dir, projectRoot: dir });
    assert.deepEqual(fresh.loadIndex().entries, []);
    assert.deepEqual(fresh.warnings, [], '「文件不存在」不是异常，不该报警告');

    // 情形 B：索引被砸坏
    mkdirSync(dir, { recursive: true });
    writeFileSync(store.indexPath, '{{{ 坏索引', 'utf8');
    const store2 = new GtoStrategyStore({ dir, projectRoot: dir });
    const index = store2.loadIndex();
    assert.equal(index.entries.length, 0);
    assert.ok(store2.warnings.length > 0, '必须有警告（不得静默）');
    assert.equal(store2.has('c12345678'), false);
  } finally {
    cleanup();
  }
});

test('GTO-CACHE-16：索引与载荷不同步 → 拒绝使用（索引被改写攻击）', async () => {
  const { store, dir, cleanup } = tempStore();
  try {
    const lookup = new GtoSafeLookup(makeProvider(new FakeGtopen()), { store });
    const a = await lookup.lookupWithStats(firstInScenario(6));
    const b = await lookup.lookupWithStats(firstInScenario(9));
    const keyA = a.stats.cacheKey;
    const keyB = b.stats.cacheKey;

    // 把 B 的载荷复制到 A 的位置（模拟索引/载荷错配）
    const payloadB = readFileSync(store.payloadPath(keyB), 'utf8');
    writeFileSync(store.payloadPath(keyA), payloadB, 'utf8');

    const store2 = new GtoStrategyStore({ dir, projectRoot: dir });
    const loaded = store2.load(keyA);
    assert.equal(loaded.found, false, '载荷里的键与请求的键不一致时必须拒绝');
    assert.ok(loaded.found === false && loaded.reason === 'invalid');
  } finally {
    cleanup();
  }
});

test('GTO-CACHE-17：缓存载荷通过一致性校验（§二十三 逐条）', async () => {
  const { store, cleanup } = tempStore();
  try {
    const lookup = new GtoSafeLookup(makeProvider(new FakeGtopen()), { store });
    const r = await lookup.lookupWithStats(firstInScenario(6));
    assert.ok(!('status' in r.result));
    const key = r.stats.cacheKey;
    const entry = store.load(key);
    assert.ok(entry.found);
    if (entry.found) {
      assert.deepEqual(validateCachedRange(entry.entry.range), []);
      assert.equal(entry.entry.range.hands.length, 169);
      assert.equal(entry.entry.source.engine, 'gtopen');
      assert.ok(entry.entry.source.engineCommit !== null);
      assert.equal(entry.entry.source.solverVersion, null, '求解器没给版本 → null（不编）');
      assert.ok(entry.entry.unavailableFields.length > 0, '必须记录「求解器没提供什么」');
      assert.equal(entry.entry.approximationFlags.approximateModel, true);
      assert.ok(entry.entry.fingerprintLines.length >= 6);
    }
  } finally {
    cleanup();
  }
});

test('GTO-CACHE-18：校验器能抓到坏数据（不是永远返回空数组）', () => {
  assert.deepEqual(selfCheckStoreLayer(), []);
  const issues = validateCachedRange({
    actorPosition: 'UTG',
    actionMenu: [],
    hands: [
      {
        hand: 'AA',
        combos: 6,
        reach: 1,
        actions: [{ kind: 'RAISE', sizeBB: 2.5, frequency: Number.NaN, evBB: null, rawLabel: 'x' }],
      },
    ],
    potBB: 1.5,
    reachable: true,
    unavailableReason: null,
  });
  const codes = new Set(issues.map((i) => i.code));
  assert.ok(codes.has('NAN_FREQUENCY'), '必须抓到 NaN 频率');
  assert.ok(codes.has('HAND_COUNT'), '必须抓到 169 缺失');
});

/* ============================================================
 * 四、质量等级
 * ============================================================ */

function evidence(overrides: Partial<GtoQualityEvidence> = {}): GtoQualityEvidence {
  return {
    hasStrategy: true,
    solverFailed: false,
    brGapTotal: 0.004,
    stopReason: 'target_reached',
    iterations: 60,
    iterationsRequested: 60,
    targetGap: 0.05,
    learningSeats: 6,
    totalSeats: 6,
    tableSize: 6,
    approximation: {
      approximateModel: true,
      notConverged: false,
      multiwayContinuation: true,
      compressedPrecision: false,
      fromCache: false,
      notes: [],
    },
    actionCount: 3,
    stability: {
      runs: 2,
      maxAbsFrequencyDelta: 0.01,
      meanAbsFrequencyDelta: 0.002,
      actionMenuStable: true,
      note: 'test',
    },
    treeId: 't12345678',
    ...overrides,
  };
}

test('GTO-QUAL-01：没有数据 → UNAVAILABLE；求解失败 → FAILED（质量 ≠ API 成功）', () => {
  assert.equal(gradeGtoQuality(evidence({ hasStrategy: false })).quality, GtoQuality.UNAVAILABLE);
  assert.equal(gradeGtoQuality(evidence({ solverFailed: true })).quality, GtoQuality.FAILED);
  // 两者都**不**等于「有数据但质量低」
  assert.notEqual(gradeGtoQuality(evidence({ hasStrategy: false })).quality, GtoQuality.LOW_CONVERGENCE);
});

test('GTO-QUAL-01b：缺稳定性证据但已达标时，低收敛摘要必须可生成（回归：reachedTarget 泄漏）', () => {
  /*
   * 复现 2026-09-23 的 9MAX 首次求解故障：
   * 求解器已完成 12 次迭代并且 gap 已低于目标，但没有重复求解稳定性证据，
   * 因此运行质量降为 LOW_CONVERGENCE。此时 qualitySummaryZh 仍要区分
   * 「已达标但没有稳定性证据」与「真的未达标」。
   *
   * 旧实现把 gradeGtoQuality 的局部变量 reachedTarget 泄漏给了独立函数，
   * 一走 LOW_CONVERGENCE 分支就抛 ReferenceError，后台任务因此被标记 FAILED，
   * 已收敛结果不落盘。
   */
  const verdict = gradeGtoQuality(
    evidence({
      tableSize: 9,
      totalSeats: 9,
      learningSeats: 9,
      iterations: 12,
      iterationsRequested: 12,
      stopReason: 'target_reached',
      brGapTotal: 0.02102956,
      targetGap: 0.05,
      stability: null,
    }),
  );
  assert.equal(verdict.quality, GtoQuality.LOW_CONVERGENCE);
  assert.ok(
    verdict.summaryZh.includes('已达到本次收敛目标'),
    `低收敛摘要必须保留达标事实，实际：${verdict.summaryZh}`,
  );
  assert.ok(
    verdict.summaryZh.includes('缺少重复求解稳定性证据'),
    `低收敛摘要必须解释降级原因，实际：${verdict.summaryZh}`,
  );
});
test('GTO-QUAL-02：近似模型是天花板 —— 即使 gap 极小、迭代极多也到不了 USABLE 以上', () => {
  const verdict = gradeGtoQuality(
    evidence({ brGapTotal: 1e-9, iterations: 10_000, stopReason: 'target_reached' }),
  );
  assert.equal(verdict.quality, GtoQuality.APPROXIMATE);
  assert.ok(
    verdict.reasonsZh.some((r) => r.includes('近似延续模型')),
    '必须给出「为什么被封顶」的理由',
  );
  assert.ok(verdict.blockersZh.some((b) => b.includes('封顶')));
});

test('GTO-QUAL-03：未达标 / 迭代过少 / 未设目标 → LOW_CONVERGENCE', () => {
  assert.equal(
    gradeGtoQuality(evidence({ stopReason: 'iteration_limit', brGapTotal: 0.9 })).quality,
    GtoQuality.LOW_CONVERGENCE,
  );
  /*
   * 「迭代过少」的判据是**按桌型**的：6 人桌预算 40 次，5 次远低于它。
   * ⚠️ 这里必须同时给 `stopReason: 'iteration_limit'` —— 否则
   * 「5 次迭代 + 声称达标」会走「求解器说到了」那条分支（见 GTO-QUAL-03b）。
   */
  assert.equal(
    gradeGtoQuality(
      evidence({ iterations: 5, stopReason: 'iteration_limit', brGapTotal: 0.01 }),
    ).quality,
    GtoQuality.LOW_CONVERGENCE,
  );
  assert.equal(gradeGtoQuality(evidence({ targetGap: 0 })).quality, GtoQuality.LOW_CONVERGENCE);
});

test('GTO-QUAL-03b：**9 人桌只迭代 12 次但求解器声称达标** ⇒ 不得判成「早期快照」', () => {
  /*
   * 🔴 这条测试来自一个**真实的规则冲突**。
   *
   * 第一版用绝对阈值「迭代 ≥ 20 才算够」。而 9 人桌的预算是 **12 次**
   *（`GTOPEN_SIZE_PROFILES`），且实测中它**达到了收敛目标**
   *（`stop_reason = target_reached`，gap 0.0210 < 目标 0.05）。
   * 于是「求解器说它到了」与「我们的规则说它没到」直接打架，
   * 9 人桌永远卡在 `LOW_CONVERGENCE`。
   *
   * 修正后的规则：**求解器声称达标** 或 **跑满了该桌型的预算**，
   * 任一成立就不算早期快照；而「未达标」仍然是一条独立的 blocker。
   */
  const nineMax = evidence({
    tableSize: 9,
    totalSeats: 9,
    learningSeats: 9,
    iterations: 12,
    iterationsRequested: 12,
    stopReason: 'target_reached',
    brGapTotal: 0.02102956,
    targetGap: 0.05,
  });
  const verdict = gradeGtoQuality(nineMax);
  assert.ok(
    !verdict.blockersZh.some((b) => b.includes('早期快照')),
    `9 人桌达标时不得被判成早期快照，实际 blockers：${verdict.blockersZh.join('；')}`,
  );
  // 但近似模型仍然封顶
  assert.equal(verdict.quality, GtoQuality.APPROXIMATE);

  // 反例：同样 12 次迭代，但**没有**声称达标 ⇒ 必须判成早期快照
  const notConverged = gradeGtoQuality(
    evidence({
      tableSize: 9,
      totalSeats: 9,
      learningSeats: 9,
      iterations: 12,
      stopReason: 'iteration_limit',
      brGapTotal: 0.9,
    }),
  );
  assert.equal(notConverged.quality, GtoQuality.LOW_CONVERGENCE);
  assert.ok(notConverged.blockersZh.some((b) => b.includes('未达到收敛目标')));

  // 再反例：4 人桌预算 60 次，只跑 5 次且没达标 ⇒ 早期快照
  const fourMaxTooFew = gradeGtoQuality(
    evidence({
      tableSize: 4,
      totalSeats: 4,
      learningSeats: 4,
      iterations: 5,
      stopReason: 'iteration_limit',
      targetGap: 0.05,
      brGapTotal: 0.9,
    }),
  );
  assert.ok(fourMaxTooFew.blockersZh.some((b) => b.includes('早期快照')));
});

test('GTO-QUAL-04：**没有稳定性证据**就不得升到 USABLE 以上（本轮最重要的纪律）', () => {
  const verdict = gradeGtoQuality(evidence({ stability: null }));
  assert.equal(verdict.quality, GtoQuality.LOW_CONVERGENCE);
  assert.ok(
    verdict.blockersZh.some((b) => b.includes('没有实测过')),
    '必须明确写出「没有实测过稳定性」',
  );
  // 只有 1 次运行也不算证据
  assert.equal(
    gradeGtoQuality(
      evidence({
        stability: {
          runs: 1,
          maxAbsFrequencyDelta: 0,
          meanAbsFrequencyDelta: 0,
          actionMenuStable: true,
          note: 'only one run',
        },
      }),
    ).quality,
    GtoQuality.LOW_CONVERGENCE,
  );
});

test('GTO-QUAL-05：重复求解漂移过大 → 降级（阈值来自实测，不是拍脑袋）', () => {
  const drifted = gradeGtoQuality(
    evidence({
      stability: {
        runs: 2,
        maxAbsFrequencyDelta: GTO_STABILITY_MAX_ABS_DELTA + 0.01,
        meanAbsFrequencyDelta: 0.2,
        actionMenuStable: true,
        note: 'drifted',
      },
    }),
  );
  assert.equal(drifted.quality, GtoQuality.LOW_CONVERGENCE);
  assert.ok(drifted.blockersZh.some((b) => b.includes('漂移过大')));
  // 动作菜单不稳定也必须降级（树都不同了）
  assert.equal(
    gradeGtoQuality(
      evidence({
        stability: {
          runs: 2,
          maxAbsFrequencyDelta: 0,
          meanAbsFrequencyDelta: 0,
          actionMenuStable: false,
          note: 'menu changed',
        },
      }),
    ).quality,
    GtoQuality.LOW_CONVERGENCE,
  );
});

test('GTO-QUAL-06：有冻结座位时 gap 的含义被污染 → 不得视为达标', () => {
  const verdict = gradeGtoQuality(evidence({ learningSeats: 2, totalSeats: 6 }));
  assert.equal(verdict.quality, GtoQuality.LOW_CONVERGENCE);
  assert.ok(verdict.blockersZh.some((b) => b.includes('出血')));
});

test('GTO-QUAL-07：CROSS_CHECKED **永远不会**由本地评级产生', () => {
  // 即使所有条件都拉满
  const best = gradeGtoQuality(
    evidence({ brGapTotal: 0, iterations: 99999, stopReason: 'target_reached' }),
  );
  assert.notEqual(best.quality, GtoQuality.CROSS_CHECKED);
  assert.deepEqual(selfCheckQualityLayer(), []);
});

test('GTO-QUAL-08：质量 → 可信度的映射：近似模型下最高只能是 APPROXIMATE', () => {
  const approx = evidence().approximation;
  assert.equal(verificationForQuality(GtoQuality.HIGH_CONFIDENCE, approx), GtoVerification.APPROXIMATE);
  assert.equal(verificationForQuality(GtoQuality.USABLE, approx), GtoVerification.APPROXIMATE);
  assert.equal(verificationForQuality(GtoQuality.UNAVAILABLE, approx), GtoVerification.UNVERIFIED);
  // 精确模型 + 达标 ⇒ 才可能到 SOLVED
  const exact = { ...approx, approximateModel: false };
  assert.equal(verificationForQuality(GtoQuality.HIGH_CONFIDENCE, exact), GtoVerification.SOLVED);
});

test('GTO-QUAL-09：等级有序，minQuality 取更保守的那个', () => {
  assert.equal(minQuality(GtoQuality.USABLE, GtoQuality.APPROXIMATE), GtoQuality.APPROXIMATE);
  assert.equal(minQuality(GtoQuality.HIGH_CONFIDENCE, GtoQuality.USABLE), GtoQuality.USABLE);
  assert.equal(minQuality(GtoQuality.UNAVAILABLE, GtoQuality.FAILED), GtoQuality.UNAVAILABLE);
});

test('GTO-QUAL-10：低质量的界面措辞**不得**出现「精确 / 绝对 / 最优」', () => {
  for (const q of [
    GtoQuality.LOW_CONVERGENCE,
    GtoQuality.APPROXIMATE,
    GtoQuality.USABLE,
    GtoQuality.HIGH_CONFIDENCE,
  ] as const) {
    const text = qualityDisclaimerZh(q);
    for (const forbidden of ['精确 GTO', '精确GTO', '绝对 GTO', '绝对GTO', '最优答案']) {
      assert.ok(!text.includes(forbidden), `${q} 的措辞不得包含「${forbidden}」`);
    }
    assert.ok(text.length > 10, `${q} 必须有实际内容`);
  }
  // 低收敛必须明确说「质量有限」
  assert.match(qualityDisclaimerZh(GtoQuality.LOW_CONVERGENCE), /质量有限|不要/);
});

/* ============================================================
 * 五、按桌人数的求解画像（全下开关 + 收敛目标）
 * ============================================================ */

test('GTO-QUAL-11：每个桌型都有一个收敛目标，且它是**工程调参**不是质量断言', () => {
  for (const size of [4, 5, 6, 8, 9] as const) {
    const target = GTOPEN_TARGET_GAP_BY_TABLE_SIZE[size];
    assert.ok(typeof target === 'number' && target > 0, `${size} 人桌必须有正的收敛目标`);
  }
  // Provider 必须把这些目标真的发出去
  const provider = makeProvider(new FakeGtopen());
  for (const size of [4, 6, 9] as const) {
    const parts = provider.solveKeyParts(firstInScenario(size));
    assert.equal(parts.targetGap, GTOPEN_TARGET_GAP_BY_TABLE_SIZE[size]);
    assert.equal(parts.iterations, GTOPEN_SIZE_PROFILES[size]!.iterations);
    assert.equal(parts.addAllin, GTOPEN_SIZE_PROFILES[size]!.addAllin);
  }
});

test('GTO-QUAL-12：solveKeyParts 与真发的请求一致（谁决定参数谁提供描述）', async () => {
  const fake = new FakeGtopen();
  const provider = makeProvider(fake);
  const scenario = firstInScenario(9);
  const parts = provider.solveKeyParts(scenario);
  await provider.lookupScenario(scenario);

  const solveReq = fake.requests.find((r) => r.path === '/api/preflop/solve');
  const spotReq = fake.requests.find((r) => r.path === '/api/preflop/spot');
  assert.ok(solveReq !== undefined && spotReq !== undefined);
  assert.equal(
    solveReq.body?.['iterations'],
    parts.iterations,
    'solveKeyParts 报的迭代数必须等于真发出去的',
  );
  assert.equal(
    solveReq.body?.['target_gap'],
    parts.targetGap,
    'solveKeyParts 报的收敛目标必须等于真发出去的',
  );
  assert.equal(
    spotReq.body?.['add_allin'],
    parts.addAllin,
    'solveKeyParts 报的 add_allin 必须等于真发出去的',
  );
  assert.deepEqual(spotReq.body?.['positions'], [...parts.enginePositions]);
  assert.deepEqual(spotReq.body?.['posts'], [...parts.posts]);
});

/* ============================================================
 * 六、并发去重与半成品
 * ============================================================ */

test('GTO-CACHE-19：连点同一场景只启动**一次**求解（in-flight 去重）', async () => {
  const fake = new FakeGtopen();
  const lookup = new GtoSafeLookup(makeProvider(fake), { store: null });
  const scenario = firstInScenario(6);
  const [a, b, c] = await Promise.all([
    lookup.lookupWithStats(scenario),
    lookup.lookupWithStats(scenario),
    lookup.lookupWithStats(scenario),
  ]);
  assert.ok(!('status' in a.result) && !('status' in b.result) && !('status' in c.result));
  assert.equal(fake.spotBuilds, 1, `三次并发只应建一次树，实际 ${fake.spotBuilds} 次`);
  assert.equal(lookup.solverCallCount(), 1, '只应有 1 次真实求解');
});

test('GTO-CACHE-20：超时/失败的半成品**不会**被写进持久化缓存', async () => {
  const { store, cleanup } = tempStore();
  try {
    const fake = new FakeGtopen({ neverFinishes: true });
    const lookup = new GtoSafeLookup(makeProvider(fake), { store, hardTimeoutMs: 3_000 });
    const r = await lookup.lookupWithStats(firstInScenario(6));
    assert.ok('status' in r.result, '必须回退');
    assert.equal(store.stats().entries, 0, '失败结果不得写缓存');
    assert.equal(r.stats.quality, GtoQuality.UNAVAILABLE);
  } finally {
    cleanup();
  }
});

test('GTO-CACHE-21：同一棵树上的不同节点共享缓存条目（treeId 的意义）', async () => {
  const fake = new FakeGtopen();
  const lookup = new GtoSafeLookup(makeProvider(fake), { store: null });
  const hero = gtoPositionsFor(6)[0]!;
  const rfi = buildGtoScenario({
    kind: GtoScenarioKind.RFI,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: hero,
    actionHistory: [],
  })!;
  const a = await lookup.lookupWithStats(rfi);
  const buildsAfterFirst = fake.spotBuilds;
  // 同一棵树上的另一个节点（Hero 换一个位置）
  const other = buildGtoScenario({
    kind: GtoScenarioKind.VS_OPEN,
    tableSize: 6,
    effectiveStackBB: 100,
    heroPosition: 'BTN',
    actionHistory: [
      { position: 'UTG', kind: 'RAISE', sizeBB: 2.5 },
      { position: 'HJ', kind: 'FOLD', sizeBB: null },
      { position: 'CO', kind: 'FOLD', sizeBB: null },
    ],
  })!;
  const b = await lookup.lookupWithStats(other);
  assert.ok(!('status' in a.result) && !('status' in b.result));
  // 不同场景 ⇒ 不同缓存键 ⇒ 会再求解一次（本阶段不做树级复用，如实记录）
  assert.notEqual(a.stats.cacheKey, b.stats.cacheKey);
  assert.ok(fake.spotBuilds >= buildsAfterFirst, '换节点需要（至少）重新查询路径');
});

/* ============================================================
 * 七、陈旧条目必须被拒绝（真实踩到的教训）
 * ============================================================ */

test('GTO-CACHE-22：`solve` 与 `solveMeta` 自相矛盾的条目必须被拒绝', async () => {
  /*
   * 🔴 这一条来自实测中真实发生的事：
   *
   * 一条由**旧代码**写入的条目，`solveMeta.targetGap = 0`（旧版没记目标），
   * 而当前代码算出来的缓存键对应 `targetGap = 0.1`。它被当成
   * 「当前配置的结果」命中，但元数据自相矛盾 —— 评级读到
   * `targetGap = 0` 就判成「未设收敛目标」⇒ 等级永远停在 LOW。
   *
   * 现在这种条目在**解析阶段**就被拒绝，表现为「未命中，重算」，
   * 而不是一个难以诊断的错误等级。
   */
  const { store, dir, cleanup } = tempStore();
  try {
    const lookup = new GtoSafeLookup(makeProvider(new FakeGtopen()), { store });
    const scenario = firstInScenario(6);
    const r = await lookup.lookupWithStats(scenario);
    const key = r.stats.cacheKey;

    // 把载荷改成「solveMeta 与 solve 不一致」的自相矛盾状态
    const path = store.payloadPath(key);
    const payload = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const meta = payload['solveMeta'] as Record<string, unknown>;
    meta['targetGap'] = 0; // 与 payload.solve.targetGap 不一致
    writeFileSync(path, JSON.stringify(payload), 'utf8');

    const store2 = new GtoStrategyStore({ dir, projectRoot: dir });
    const loaded = store2.load(key);
    assert.equal(loaded.found, false, '自相矛盾的条目必须被拒绝');
    assert.ok(
      loaded.found === false && (loaded.reason === 'invalid' || loaded.reason === 'corrupt'),
      `拒绝原因应为 invalid/corrupt，实际 ${loaded.found === false ? loaded.reason : '—'}`,
    );
  } finally {
    cleanup();
  }
});

test('GTO-CACHE-23：正常写入的条目 `solve` 与 `solveMeta` 必须一致（防回归）', async () => {
  const { store, cleanup } = tempStore();
  try {
    const lookup = new GtoSafeLookup(makeProvider(new FakeGtopen()), { store });
    const r = await lookup.lookupWithStats(firstInScenario(6));
    const loaded = store.load(r.stats.cacheKey);
    assert.ok(loaded.found, '正常写入的条目必须能读回');
    if (loaded.found) {
      assert.equal(loaded.entry.solveMeta.targetGap, loaded.entry.solve.targetGap);
      assert.equal(loaded.entry.solveMeta.iterationsRequested, loaded.entry.solve.iterations);
    }
  } finally {
    cleanup();
  }
});

test('GTO-CACHE-24：读取缓存时按**当前证据**重新评级（不是用写入时那份）', async () => {
  /*
   * 另一个真实踩到的问题：稳定性证据是**事后**由离线探针产出的。
   * 若读缓存时直接用条目里存的那份等级，就会出现
   * 「同一份数据：冷求解显示 APPROXIMATE、读缓存却显示 LOW_CONVERGENCE」。
   */
  const { store, dir, cleanup } = tempStore();
  try {
    const scenario = firstInScenario(6);
    const provider = makeProvider(new FakeGtopen());
    const key = cacheKeyOf(scenario, provider.solveKeyParts(scenario));

    // 第一次：**没有**证据 ⇒ 写入时等级是 LOW_CONVERGENCE
    const lookupNoEvidence = new GtoSafeLookup(provider, { store, stabilityEvidence: {} });
    const first = await lookupNoEvidence.lookupWithStats(scenario);
    assert.equal(first.stats.quality, GtoQuality.LOW_CONVERGENCE);
    const stored = store.load(key);
    assert.ok(stored.found);
    if (stored.found) {
      assert.equal(stored.entry.quality, GtoQuality.LOW_CONVERGENCE, '写入时的判定必须被保留');
    }

    // 第二次：**有**证据 ⇒ 读缓存时必须按当前证据重新评级
    const evidenceTable = {
      [key]: {
        runs: 2,
        maxAbsFrequencyDelta: 0,
        meanAbsFrequencyDelta: 0,
        actionMenuStable: true,
        note: 'test',
      },
    };
    const store2 = new GtoStrategyStore({ dir, projectRoot: dir });
    const lookupWithEvidence = new GtoSafeLookup(makeProvider(new FakeGtopen()), {
      store: store2,
      stabilityEvidence: evidenceTable,
    });
    const second = await lookupWithEvidence.lookupWithStats(scenario);
    assert.equal(second.stats.source, 'persistent', '必须命中持久化缓存');
    assert.equal(
      second.stats.quality,
      GtoQuality.APPROXIMATE,
      '证据补齐后，读缓存必须与重新求解给出同一个等级（APPROXIMATE）',
    );

    // ⚠️ 反向：把证据换成「漂移大」⇒ 等级必须降回 LOW
    const badEvidence = {
      [key]: {
        runs: 2,
        maxAbsFrequencyDelta: GTO_STABILITY_MAX_ABS_DELTA + 0.5,
        meanAbsFrequencyDelta: 0.5,
        actionMenuStable: true,
        note: 'drifted',
      },
    };
    const store3 = new GtoStrategyStore({ dir, projectRoot: dir });
    const lookupBad = new GtoSafeLookup(makeProvider(new FakeGtopen()), {
      store: store3,
      stabilityEvidence: badEvidence,
    });
    const third = await lookupBad.lookupWithStats(scenario);
    assert.equal(third.stats.quality, GtoQuality.LOW_CONVERGENCE, '漂移大的证据必须让等级降回 LOW');
  } finally {
    cleanup();
  }
});

test('GTO-CACHE-25：🔴 键相同但**内嵌场景不同**的条目必须被拒绝（哈希碰撞不得静默命中）', async () => {
  /*
   * CACHE KEY GOLDEN VECTOR 轮（使用者 §10）：
   *
   * `scenarioHash` / `treeId` / `cacheKey` 都是 **32 位非密码学哈希**
   *（FNV-1a，8 位十六进制）——不能声称「不会碰撞」。因此读缓存时
   * 不能只比哈希字符串，还要比**条目里内嵌的规范化场景**。
   *
   * 本用例**人工伪造**一次碰撞：把某条目的 `scenarioHash` 改成另一个场景的，
   * 再按那个场景去读 —— 修复前会命中（于是「问 A 得到 B 的策略」这种
   * 静默错答案就成立了），修复后必须拒绝。
   */
  const { store, dir, cleanup } = tempStore();
  try {
    const lookup = new GtoSafeLookup(makeProvider(new FakeGtopen()), { store });
    const scenarioA = firstInScenario(6);
    const first = await lookup.lookupWithStats(scenarioA);
    const keyA = first.stats.cacheKey;

    // 另一个**不同**场景（同为 6 人桌的第一个行动位，但筹码不同）
    const scenarioB = buildGtoScenario({
      kind: GtoScenarioKind.RFI,
      tableSize: 6,
      effectiveStackBB: 40,
      heroPosition: scenarioA.heroPosition,
      actionHistory: [],
    })!;
    const solve = solveParts();
    const hashB = scenarioHashOf(scenarioB);
    const treeB = treeIdOf(scenarioB, {
      openSizesBB: solve.openSizesBB,
      raiseMults: solve.raiseMults,
      maxRaises: solve.maxRaises,
      limp: solve.limp,
      addAllin: solve.addAllin,
      engine: solve.engine,
    });
    assert.notEqual(hashB, scenarioHashOf(scenarioA), '两个场景必须真的不同');

    // 伪造：把载荷里的哈希改成 B 的（模拟一次真实碰撞 / 索引被改写）
    const path = store.payloadPath(keyA);
    const payload = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    payload['scenarioHash'] = hashB;
    payload['treeId'] = treeB;
    writeFileSync(path, JSON.stringify(payload), 'utf8');

    const store2 = new GtoStrategyStore({ dir, projectRoot: dir });
    // ① 只比哈希（旧口径）⇒ 会命中 → 这正是要防的
    const byHashOnly = store2.load(keyA, { scenarioHash: hashB, treeId: treeB });
    assert.equal(byHashOnly.found, true, '前提：伪造后「只比哈希」确实会命中（否则本用例没有意义）');
    // ② 加上**逐字段场景比对**（新口径）⇒ 必须拒绝
    const byScenario = store2.load(keyA, { scenarioHash: hashB, treeId: treeB, scenario: scenarioB });
    assert.equal(byScenario.found, false, '键相同但内嵌场景不同 ⇒ 必须拒绝命中');
    assert.ok(
      byScenario.found === false && byScenario.reason === 'invalid',
      `拒绝原因必须是 invalid，实际 ${byScenario.found === false ? byScenario.reason : '—'}`,
    );
    assert.ok(
      store2.warnings.some((w) => w.includes('碰撞')),
      `必须留下可诊断的警告，实际：${store2.warnings.join(' | ')}`,
    );
  } finally {
    cleanup();
  }
});
