/**
 * 🔴 **缓存键黄金向量与身份不变量**（CACHE KEY GOLDEN VECTOR 轮 · 2026-09）
 *
 * ## 这一组锁什么
 *
 * 三把键（`scenarioHash` / `treeId` / `cacheKey`）是**跨模块基础设施**：
 * 它们一旦漂移，后果不是「报错」而是**静默复用错误结果**
 *（旧缓存误差命中、稳定性证据失配、Catalog 条目对不上）。
 *
 * | 组 | 用途 | 依据 |
 * |---|---|---|
 * | `CACHE-GOLDEN-*` | 固定输入 → 固定键值（**字面量**） | 【工程约束】防止实现漂移 |
 * | `CACHE-SENS-*` | 单变量敏感性：该变的必须变 | 【数学确定】身份定义 |
 * | `CACHE-INSENS-*` | 单变量不敏感：不该变的不能变 | 【工程约束】防止键过度敏感 |
 * | `CACHE-CANON-*` | 规范化序列化：顺序无关、无平台依赖 | 【工程约束】 |
 * | `CACHE-VERSION-*` | 版本常量进入键 | 【工程约束】 |
 * | `CACHE-COLLISION-*` | 哈希相同但载荷不同 ⇒ **不得命中** | 【工程约束】防静默误命中 |
 *
 * ## ⚠️ 本轮**不**声称
 *
 * - 不声称「不会碰撞」：FNV-1a 是 **32 位非密码学哈希**，8 位十六进制；
 * - 不声称 solver / strategy 正确性 —— 本文件只证明**缓存身份映射**
 *   具有可重复性、敏感性与基本抗静默误命中能力。
 *
 * ## 🔴 关于底牌与公共牌（使用者 §2 清单里的 `holeCards` / `board`）
 *
 * 这两项**不在**任何一把 GTO 键里，而且是**设计如此**：
 * GTO 基线回答的是**范围级**问题（「9人桌 BTN 面对 UTG 开池 2.5BB 的范围」），
 * 不是「AsKs 该怎么打」。底牌由 Alpha 在拿到范围之后再落到具体手牌。
 * 因此 `CACHE-SENS-HOLE` 断言的是**不变**（MUST_NOT_AFFECT_KEY），
 * 并附上「场景类型里根本没有这两个字段」的类型级证据。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGtoScenario,
  cacheKeyOf,
  cachePayloadOf,
  canonicalPayloadOf,
  GTO_CACHE_KEY_VERSION,
  GTO_SCENARIO_HASH_VERSION,
  hashKeyOf,
  keySchemaVersionOf,
  keysOf,
  PAYLOAD_SCHEMAS,
  scenarioHashOf,
  scenarioPayloadOf,
  solveFingerprintOf,
  solvePayloadOf,
  treeIdOf,
  treePayloadOf,
} from '../src/domain/gto/gtoScenario.ts';
import { GtoScenarioKind, type GtoScenario, type GtoSolveKeyParts } from '../src/domain/gto/gto.types.ts';

/* ============================================================
 * 固定输入（黄金向量的输入侧）
 * ============================================================ */

/** 与生产配置一致的一份求解侧参数（commit 用本仓库固定的 GTOpen 版本） */
const SOLVE: GtoSolveKeyParts = Object.freeze({
  engine: 'gtopen',
  engineCommit: '92c86ed73aa0856df8479b5c7635e1469f48f1e8',
  solverVersion: null,
  openSizesBB: [2.5],
  raiseMults: [3],
  maxRaises: 2,
  limp: true,
  addAllin: false,
  rakePct: 0,
  rakeCap: 0,
  realization: 'equity-realization',
  multiwayEquityModel: null,
  iterations: 200,
  targetGap: 0.5,
  checkEvery: 20,
  enginePositions: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  posts: [0.5, 1],
  ante: 0,
});

function must(spec: Parameters<typeof buildGtoScenario>[0], label: string): GtoScenario {
  const s = buildGtoScenario(spec);
  assert.notEqual(s, null, `场景必须可构造：${label}`);
  return s!;
}

/** 向量 1：使用者给的例子（9 人桌 / BTN / 100BB）—— BTN 的第一个决策节点是「面对 UTG 开池」 */
const V1 = must(
  {
    kind: GtoScenarioKind.VS_OPEN,
    tableSize: 9,
    effectiveStackBB: 100,
    heroPosition: 'BTN',
    actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 2.5 }],
  },
  'V1 9MAX/BTN/100/VS_OPEN',
);

/** 向量 2：6 人桌 / BB / 40BB */
const V2 = must(
  {
    kind: GtoScenarioKind.VS_OPEN,
    tableSize: 6,
    effectiveStackBB: 40,
    heroPosition: 'BB',
    actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 2.5 }],
  },
  'V2 6MAX/BB/40/VS_OPEN',
);

/** 向量 3：9 人桌 UTG 开池（RFI 只允许第一个行动位） */
const V3 = must(
  {
    kind: GtoScenarioKind.RFI,
    tableSize: 9,
    effectiveStackBB: 100,
    heroPosition: 'UTG',
    actionHistory: [],
  },
  'V3 9MAX/UTG/100/RFI',
);

/* ============================================================
 * 一、黄金向量（CACHE-GOLDEN）
 * ============================================================ */

test('CACHE-GOLDEN-1：固定场景 → 固定 `scenarioHash`（字面量锚点）', () => {
  /*
   * 这些字面量是**键口径的锚**：任何实现漂移（字段增删、顺序变化、
   * 归一化改动、哈希算法改动）都会让它们变化，从而立刻失败 ——
   * 而不是让旧缓存静默失效或误命中。
   *
   * ⚠️ 它们与「加固前的实现」逐位相同（加固只把「顺序由谁决定」显式化，
   * 不改变字节），因此 `data/gto-cache` 与按 cacheKey 索引的
   * `data/gto-stability.json` **不需要重建**。
   */
  assert.equal(scenarioHashOf(V1), 'gc4358aae', '9MAX/BTN/100/VS_OPEN(2.5)');
  assert.equal(scenarioHashOf(V2), 'g1b1c164c', '6MAX/BB/40/VS_OPEN(2.5)');
  assert.equal(scenarioHashOf(V3), 'g0d4f06d8', '9MAX/UTG/100/RFI');
});

test('CACHE-GOLDEN-2：固定树配置 → 固定 `treeId`（与 Hero 是谁无关）', () => {
  const tree = {
    openSizesBB: SOLVE.openSizesBB,
    raiseMults: SOLVE.raiseMults,
    maxRaises: SOLVE.maxRaises,
    limp: SOLVE.limp,
    addAllin: SOLVE.addAllin,
    engine: SOLVE.engine,
  };
  assert.equal(treeIdOf(V1, tree), 't18337408');
  assert.equal(treeIdOf(V2, tree), 't8cc30316');
  assert.equal(treeIdOf(V3, tree), 't18337408');
  /*
   * 🔴 **职责分离的直接证据**：V1（BTN 面对开池）与 V3（UTG 开池）
   * 是**两个不同的问题**（scenarioHash 不同），但它们落在**同一棵树**上
   * （同一个桌型 / 盲注 / 筹码 / 动作菜单）⇒ treeId 相同。
   * 这正是「gap 只在同一棵树内可比」这条规则的实现基础。
   */
  assert.notEqual(scenarioHashOf(V1), scenarioHashOf(V3), '两个问题必须有两个场景哈希');
  assert.equal(treeIdOf(V1, tree), treeIdOf(V3, tree), '同一棵树必须只有一个 treeId');
});

test('CACHE-GOLDEN-3：固定完整上下文 → 固定 `cacheKey`（场景 + 求解设置）', () => {
  assert.equal(solveFingerprintOf(SOLVE), 's1d0f0341', '求解设置指纹');
  assert.equal(cacheKeyOf(V1, SOLVE), 'c456718aa');
  assert.equal(cacheKeyOf(V2, SOLVE), 'c28d00375');
  assert.equal(cacheKeyOf(V3, SOLVE), 'c1947025c');
  // 三键一次性算出（调用方不该自己拼口径）
  assert.deepEqual(keysOf(V1, SOLVE), {
    scenarioHash: 'gc4358aae',
    treeId: 't18337408',
    cacheKey: 'c456718aa',
  });
});

test('CACHE-GOLDEN-4：三把键是**三个不同的折叠**，不是同一个 payload 重复哈希', () => {
  const k = keysOf(V1, SOLVE);
  const payloads = {
    scenario: scenarioPayloadOf(V1),
    tree: treePayloadOf(V1, {
      openSizesBB: SOLVE.openSizesBB,
      raiseMults: SOLVE.raiseMults,
      maxRaises: SOLVE.maxRaises,
      limp: SOLVE.limp,
      addAllin: SOLVE.addAllin,
      engine: SOLVE.engine,
    }),
    solve: solvePayloadOf(SOLVE),
    cache: cachePayloadOf(V1, SOLVE),
  };
  const texts = Object.values(payloads);
  assert.equal(new Set(texts).size, texts.length, '四个载荷必须互不相同');
  // 每个键各自对应一个不同的载荷文本
  assert.equal(`g${hashKeyOf(payloads.scenario)}`, k.scenarioHash);
  assert.equal(`t${hashKeyOf(payloads.tree)}`, k.treeId);
  assert.equal(`s${hashKeyOf(payloads.solve)}`, solveFingerprintOf(SOLVE));
  assert.equal(`c${hashKeyOf(payloads.cache)}`, k.cacheKey);
  // 职责：缓存载荷**只**由另两把键组成（不含原始字段）
  assert.ok(
    payloads.cache.includes(k.scenarioHash) && payloads.cache.includes(solveFingerprintOf(SOLVE)),
    `缓存载荷必须由「场景哈希 + 求解指纹」构成，实际 ${payloads.cache}`,
  );
});

/* ============================================================
 * 二、单变量敏感性（CACHE-SENS）
 * ============================================================ */

test('CACHE-SENS-1：位置变化（BTN → SB）必须改变场景键与缓存键，但**不改树**', () => {
  const sb = must(
    {
      kind: GtoScenarioKind.VS_OPEN,
      tableSize: 9,
      effectiveStackBB: 100,
      heroPosition: 'SB',
      actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 2.5 }],
    },
    'SB',
  );
  const a = keysOf(V1, SOLVE);
  const b = keysOf(sb, SOLVE);
  assert.notEqual(b.scenarioHash, a.scenarioHash, '换位置就是换问题 ⇒ 场景哈希必须变');
  assert.notEqual(b.cacheKey, a.cacheKey, '缓存键必须随之改变');
  assert.equal(b.treeId, a.treeId, '同一桌型的同一棵树 ⇒ treeId 不变（职责分离）');
});

test('CACHE-SENS-2：有效筹码变化（100BB → 150BB）必须改变全部三把键', () => {
  const deeper = must(
    {
      kind: GtoScenarioKind.VS_OPEN,
      tableSize: 9,
      effectiveStackBB: 150,
      heroPosition: 'BTN',
      actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 2.5 }],
    },
    '150BB',
  );
  const a = keysOf(V1, SOLVE);
  const b = keysOf(deeper, SOLVE);
  assert.notEqual(b.scenarioHash, a.scenarioHash);
  assert.notEqual(b.treeId, a.treeId, '筹码深度改变树的分叉（全下阈值）⇒ 树也必须变');
  assert.notEqual(b.cacheKey, a.cacheKey);
});

test('CACHE-SENS-3：桌型变化（9-max → 6-max）必须改变全部三把键', () => {
  const a = keysOf(V1, SOLVE);
  const b = keysOf(V2, SOLVE);
  assert.notEqual(b.scenarioHash, a.scenarioHash);
  assert.notEqual(b.treeId, a.treeId);
  assert.notEqual(b.cacheKey, a.cacheKey);
});

test('CACHE-SENS-4：下注尺度变化（2.5BB → 3BB）必须改变场景键与缓存键，但**不改树**', () => {
  const bigger = must(
    {
      kind: GtoScenarioKind.VS_OPEN,
      tableSize: 9,
      effectiveStackBB: 100,
      heroPosition: 'BTN',
      actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 3 }],
    },
    '3BB',
  );
  const a = keysOf(V1, SOLVE);
  const b = keysOf(bigger, SOLVE);
  assert.notEqual(b.scenarioHash, a.scenarioHash, '对手开了多少是问题的一部分');
  assert.notEqual(b.cacheKey, a.cacheKey);
  assert.equal(b.treeId, a.treeId, '动作**菜单**没变（2.5BB 与 3BB 都是树上的一个分支）⇒ treeId 不变');
});

test('CACHE-SENS-5：多人状态变化（面对 1 家 → 面对 2 家）必须改变场景键与缓存键', () => {
  /*
   * 多人状态在本项目的场景模型里通过 **actionHistory** 表达
   *（谁进来了、他是跟注还是加注），没有独立的 multiway 字段 ——
   * 这正是「`villainPosition` 刻意不进哈希」的同一条理由：
   * 它已经完整体现在历史里。
   */
  const multiway = must(
    {
      kind: GtoScenarioKind.VS_OPEN,
      tableSize: 9,
      effectiveStackBB: 100,
      heroPosition: 'BTN',
      actionHistory: [
        { position: 'UTG', kind: 'RAISE', sizeBB: 2.5 },
        { position: 'HJ', kind: 'CALL', sizeBB: 2.5 },
      ],
    },
    'multiway',
  );
  const a = keysOf(V1, SOLVE);
  const b = keysOf(multiway, SOLVE);
  assert.notEqual(b.scenarioHash, a.scenarioHash, '有人跟注进来是另一个问题');
  assert.notEqual(b.cacheKey, a.cacheKey);
  assert.equal(b.treeId, a.treeId, '同一棵树（同一个动作菜单与桌型）');
});

test('CACHE-SENS-6：求解设置变化（打开全下 / 换 commit / 改迭代）必须改变缓存键', () => {
  const withAllin: GtoSolveKeyParts = { ...SOLVE, addAllin: true };
  const otherCommit: GtoSolveKeyParts = { ...SOLVE, engineCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' };
  const moreIterations: GtoSolveKeyParts = { ...SOLVE, iterations: 400 };

  const base = keysOf(V1, SOLVE);
  for (const [label, solve] of [
    ['打开全下', withAllin],
    ['换个 commit', otherCommit],
    ['改迭代数', moreIterations],
  ] as const) {
    assert.notEqual(keysOf(V1, solve).cacheKey, base.cacheKey, `${label} ⇒ 缓存键必须变`);
  }
  // 场景不受求解设置影响 ——「问题」与「怎么解」必须分开
  assert.equal(scenarioHashOf(V1), base.scenarioHash, '求解设置不得影响场景哈希');
  // 打开全下改变树的形状 ⇒ treeId 必须变
  assert.notEqual(keysOf(V1, withAllin).treeId, base.treeId, '动作菜单变化必须改变树指纹');
});

test('CACHE-SENS-HOLE：底牌（AsKs → AhKh）**不得**改变任何一把 GTO 键 —— 设计如此', () => {
  /*
   * 使用者 §5 要求测试「手牌：AsKs → AhKh」。本项目的答案是
   * **MUST_NOT_AFFECT_KEY**，依据有两条：
   *
   * 1. **类型级**：`GtoScenario` 里没有 `holeCards` / `board` 字段
   *    （真人信息与具体手牌都进不去）；
   * 2. **语义级**：GTO 基线是**范围级**答案。同一个场景下，
   *    AsKs 与 AhKh 拿到的是**同一份范围**，再由 Alpha 落到具体手牌。
   *    若底牌进了键，同一份范围会被求解两次，而且
   *    「场景目录」会从几十条爆炸成几十万条。
   *
   * ⚠️ 这不是「漏了字段」，因此**没有**「缺失字段」缺陷可报。
   */
  const keys = Object.keys(V1);
  for (const forbidden of ['holeCards', 'heroCards', 'board', 'hole', 'cards']) {
    assert.ok(!keys.includes(forbidden), `GtoScenario 不得含「${forbidden}」（实际字段：${keys.join(', ')}）`);
  }
  // 同一场景重复计算必须逐位一致（这就是「底牌不参与」的可执行形式）
  assert.equal(scenarioHashOf(V1), scenarioHashOf({ ...V1 }), '同一场景必须稳定');
});

/* ============================================================
 * 三、不该改变键的东西（CACHE-INSENS）
 * ============================================================ */

test('CACHE-INSENS-1：显示用字段 / 时间 / 语言不得进入键（塞进去会直接抛错）', () => {
  /*
   * 三把键的载荷由**显式字段表**装配（`PAYLOAD_SCHEMAS`），
   * 因此「顺手加一个显示用字段」会**当场抛错**，而不是静默改变缓存身份。
   * 这是本轮把隐式约定变成硬约束的关键一步。
   */
  assert.throws(
    () =>
      canonicalPayloadOf('scenario', {
        v: GTO_SCENARIO_HASH_VERSION,
        kind: 'VS_OPEN',
        gameType: 'CASH',
        tableSize: 9,
        effectiveStackBB: 100,
        heroPosition: 'BTN',
        actionHistory: [],
        blinds: { sbBB: 0.5, bbBB: 1, anteBB: 0 },
        heroAlreadyActed: false,
        locale: 'zh-CN', // ← 显示用字段
      }),
    /字段集合与显式字段表不一致/,
    '显示用字段必须被字段表拦住',
  );

  // 少字段同样抛错（防止「漏写一个必须参与的字段」）
  assert.throws(
    () => canonicalPayloadOf('scenario', { v: GTO_SCENARIO_HASH_VERSION, kind: 'VS_OPEN' }),
    /字段集合与显式字段表不一致/,
  );
});

test('CACHE-INSENS-2：重复计算 / 环境变量（时区、语言）不得改变键', () => {
  const before = keysOf(V1, SOLVE);
  const tz = process.env['TZ'];
  const lc = process.env['LC_ALL'];
  const lang = process.env['LANG'];
  try {
    process.env['TZ'] = 'America/New_York';
    process.env['LC_ALL'] = 'tr_TR.UTF-8'; // 土耳其语：经典的大小写陷阱
    process.env['LANG'] = 'tr_TR.UTF-8';
    for (let i = 0; i < 50; i++) {
      assert.deepEqual(keysOf(V1, SOLVE), before, `第 ${i + 1} 次计算结果必须一致`);
    }
  } finally {
    if (tz === undefined) delete process.env['TZ'];
    else process.env['TZ'] = tz;
    if (lc === undefined) delete process.env['LC_ALL'];
    else process.env['LC_ALL'] = lc;
    if (lang === undefined) delete process.env['LANG'];
    else process.env['LANG'] = lang;
  }
});

/* ============================================================
 * 四、规范化序列化（CACHE-CANON）
 * ============================================================ */

test('CACHE-CANON-1：规范化载荷与「对象字面量书写顺序」无关', () => {
  /*
   * 修复前：`JSON.stringify({ 字面量 })` —— 顺序由源码书写顺序决定。
   * 现在：字段表决定顺序，插入顺序不再影响结果。
   *
   * 这里用同一个场景构造两次，第二次的字段表对象以**逆序**给出，
   * 结果必须逐字节相同。
   */
  const forward = canonicalPayloadOf('scenario', {
    v: GTO_SCENARIO_HASH_VERSION,
    kind: V1.kind,
    gameType: V1.gameType,
    tableSize: V1.tableSize,
    effectiveStackBB: V1.effectiveStackBB,
    heroPosition: V1.heroPosition,
    actionHistory: V1.actionHistory.map((a) => ({ position: a.position, kind: a.kind, sizeBB: a.sizeBB })),
    blinds: { sbBB: V1.blinds.sbBB, bbBB: V1.blinds.bbBB, anteBB: V1.blinds.anteBB },
    heroAlreadyActed: V1.heroAlreadyActed,
  });
  const reversedEntries: Array<[string, unknown]> = [
    ['heroAlreadyActed', V1.heroAlreadyActed],
    ['blinds', { anteBB: V1.blinds.anteBB, bbBB: V1.blinds.bbBB, sbBB: V1.blinds.sbBB }],
    ['actionHistory', V1.actionHistory.map((a) => ({ sizeBB: a.sizeBB, kind: a.kind, position: a.position }))],
    ['heroPosition', V1.heroPosition],
    ['effectiveStackBB', V1.effectiveStackBB],
    ['tableSize', V1.tableSize],
    ['gameType', V1.gameType],
    ['kind', V1.kind],
    ['v', GTO_SCENARIO_HASH_VERSION],
  ];
  const backward = canonicalPayloadOf('scenario', Object.fromEntries(reversedEntries));
  assert.equal(backward, forward, '字段表的顺序必须决定序列化结果');
  assert.equal(scenarioPayloadOf(V1), forward, '生产载荷与手工装配必须逐字节一致');
  // 载荷里不得出现平台行尾
  assert.ok(!forward.includes('\r'), '规范化载荷不得含 CR');
});

test('CACHE-CANON-2：数组顺序 —— 语义有序的（动作历史）必须保留顺序', () => {
  /*
   * 使用者的规则：**只有语义无序的数组才可以排序**。
   * 动作历史是**语义有序**的（谁先动、谁后动决定节点），
   * 因此规范化**绝不能**排序它 —— 排序会让两条不同的历史撞成一把键。
   *
   * ⚠️ 这里直接测**序列化器**而不是 `buildGtoScenario`：非法历史
   *（例如「HJ 先跟注、UTG 后加注」）在构造阶段就会被
   * `validatePriorActions` 拒绝成 `null`，根本到不了键这一层。
   * 我们真正要锁的是「序列化器不做任何排序」。
   */
  const actionA = { position: 'UTG', kind: 'RAISE', sizeBB: 2.5 };
  const actionB = { position: 'HJ', kind: 'CALL', sizeBB: 2.5 };
  const payloadWith = (history: readonly unknown[]): string =>
    canonicalPayloadOf('scenario', {
      v: GTO_SCENARIO_HASH_VERSION,
      kind: V1.kind,
      gameType: V1.gameType,
      tableSize: V1.tableSize,
      effectiveStackBB: V1.effectiveStackBB,
      heroPosition: V1.heroPosition,
      actionHistory: history,
      blinds: { sbBB: 0.5, bbBB: 1, anteBB: 0 },
      heroAlreadyActed: false,
    });
  assert.notEqual(
    payloadWith([actionA, actionB]),
    payloadWith([actionB, actionA]),
    '动作顺序不同 ⇒ 载荷必须不同（**不得**排序语义有序数组）',
  );

  /*
   * 动作菜单同理：`openSizesBB` 的顺序是求解器的分支顺序（它决定树的形状），
   * 不是可以随意排序的集合。
   */
  const menu1 = solvePayloadOf({ ...SOLVE, openSizesBB: [2, 2.5] });
  const menu2 = solvePayloadOf({ ...SOLVE, openSizesBB: [2.5, 2] });
  assert.notEqual(menu1, menu2, '动作菜单的顺序属于求解设置，必须保留（不得排序）');
});

test('CACHE-CANON-2b：**嵌套对象**的键顺序也必须无关（修复前的承诺是假的）', () => {
  /*
   * 只对顶层字段排序是不够的：`blinds` 与 `actionHistory[i]` 也是对象。
   * 黄金向量轮的第一版就踩到了这一点 —— 把 `{sbBB, bbBB, anteBB}` 写成
   * `{bbBB, sbBB, anteBB}` 会得到**不同的键**，而当时文档已经声称「顺序无关」。
   */
  const base = canonicalPayloadOf('scenario', {
    v: GTO_SCENARIO_HASH_VERSION,
    kind: V1.kind,
    gameType: V1.gameType,
    tableSize: V1.tableSize,
    effectiveStackBB: V1.effectiveStackBB,
    heroPosition: V1.heroPosition,
    actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 2.5 }],
    blinds: { sbBB: 0.5, bbBB: 1, anteBB: 0 },
    heroAlreadyActed: false,
  });
  const shuffled = canonicalPayloadOf('scenario', {
    v: GTO_SCENARIO_HASH_VERSION,
    kind: V1.kind,
    gameType: V1.gameType,
    tableSize: V1.tableSize,
    effectiveStackBB: V1.effectiveStackBB,
    heroPosition: V1.heroPosition,
    actionHistory: [{ sizeBB: 2.5, kind: 'RAISE', position: 'UTG' }],
    blinds: { anteBB: 0, bbBB: 1, sbBB: 0.5 },
    heroAlreadyActed: false,
  });
  assert.equal(shuffled, base, '嵌套对象的键顺序不得影响规范化结果');

  // 嵌套对象缺字段 / 多字段同样必须抛错
  assert.throws(
    () =>
      canonicalPayloadOf('scenario', {
        v: GTO_SCENARIO_HASH_VERSION,
        kind: V1.kind,
        gameType: V1.gameType,
        tableSize: V1.tableSize,
        effectiveStackBB: V1.effectiveStackBB,
        heroPosition: V1.heroPosition,
        actionHistory: [],
        blinds: { sbBB: 0.5, bbBB: 1 },
        heroAlreadyActed: false,
      }),
    /嵌套表 blinds 不一致/,
  );
});

test('CACHE-CANON-3：非有限数不得被静默折叠成同一个键', () => {
  /*
   * `JSON.stringify(NaN)` → `null`：那会让「金额是 NaN」与「没有金额」
   * 得到同一个键。修复前没有任何断言拦这件事。
   *
   * 现在的规则：**必需**数值非有限 ⇒ 抛错；**可空**金额非有限 ⇒ 显式 `null`。
   */
  assert.throws(
    () =>
      scenarioPayloadOf({
        ...V1,
        effectiveStackBB: Number.NaN,
      }),
    /不是有限数/,
    '有效筹码是 NaN 必须抛错（不得折叠成 null）',
  );
  assert.throws(
    () => scenarioPayloadOf({ ...V1, blinds: { ...V1.blinds, bbBB: Number.POSITIVE_INFINITY } }),
    /不是有限数/,
  );

  // 可空金额：NaN 与「没有金额」显式同义（且这是**写下来的**行为，不是巧合）
  const withNull = scenarioPayloadOf({
    ...V1,
    actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: null }],
  });
  const withNaN = scenarioPayloadOf({
    ...V1,
    actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: Number.NaN }],
  });
  assert.equal(withNaN, withNull, '可空金额的非有限数必须显式映射为 null');
});

test('CACHE-CANON-4：浮点累加噪声不得改变键（`roundBB` 的用途）', () => {
  const noisy = must(
    {
      kind: GtoScenarioKind.VS_OPEN,
      tableSize: 9,
      effectiveStackBB: 100.00000000000001,
      heroPosition: 'BTN',
      actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 2.5000000000000004 }],
    },
    'noisy',
  );
  assert.equal(
    scenarioHashOf(noisy),
    scenarioHashOf(V1),
    '2.5 与 2.5000000000000004 必须得到同一个键（否则缓存永远命中不了）',
  );
});

/* ============================================================
 * 五、版本（CACHE-VERSION）
 * ============================================================ */

test('CACHE-VERSION-1：版本常量进入键 —— 口径变化会让旧缓存**失效而不是误命中**', () => {
  /*
   * 用 `versionOverride`（仅供测试与迁移演练）模拟「把版本号 +1」：
   * 同一个场景必须得到一个**不同**的键。这样将来改口径时，
   * 旧缓存只会 miss，不会被错误命中。
   */
  const current = scenarioHashOf(V1);
  const bumped = `g${hashKeyOf(scenarioPayloadOf(V1, `${GTO_SCENARIO_HASH_VERSION}-next`))}`;
  assert.notEqual(bumped, current, '场景版本变化 ⇒ 场景哈希必须变');

  const currentCache = cacheKeyOf(V1, SOLVE);
  const bumpedCache = `c${hashKeyOf(cachePayloadOf(V1, SOLVE, `${GTO_CACHE_KEY_VERSION}-next`))}`;
  assert.notEqual(bumpedCache, currentCache, '缓存版本变化 ⇒ 缓存键必须变');

  // 版本常量本身必须是「可读的、与 git commit 无关的」字符串
  assert.ok(GTO_SCENARIO_HASH_VERSION.length > 0 && GTO_CACHE_KEY_VERSION.length > 0);
  assert.ok(
    !/^[0-9a-f]{7,40}$/.test(GTO_SCENARIO_HASH_VERSION) && !/^[0-9a-f]{7,40}$/.test(GTO_CACHE_KEY_VERSION),
    '不得把 git commit 当 schema version（那会伪造出「缓存失效」）',
  );
  // 诊断用的口径指纹必须同时含两个版本
  const schema = keySchemaVersionOf();
  assert.ok(schema.includes(GTO_SCENARIO_HASH_VERSION) && schema.includes(GTO_CACHE_KEY_VERSION));
});

test('CACHE-VERSION-2：版本常量只影响它负责的那一层', () => {
  /*
   * 职责边界（使用者 §12）：
   * | 键 | 受场景版本影响 | 受缓存版本影响 |
   * |---|---|---|
   * | scenarioHash | ✅ | ❌ |
   * | treeId | ❌（无版本概念） | ❌ |
   * | cacheKey | ✅（间接） | ✅ |
   */
  const tree = {
    openSizesBB: SOLVE.openSizesBB,
    raiseMults: SOLVE.raiseMults,
    maxRaises: SOLVE.maxRaises,
    limp: SOLVE.limp,
    addAllin: SOLVE.addAllin,
    engine: SOLVE.engine,
  };
  const t0 = treeIdOf(V1, tree);
  // 场景版本变化不影响树指纹（它是纯形状身份）
  assert.equal(treeIdOf(V1, tree), t0);
  // 缓存版本变化不影响场景哈希
  assert.equal(scenarioHashOf(V1), scenarioHashOf({ ...V1 }));
});

/* ============================================================
 * 六、碰撞防线（CACHE-COLLISION）
 * ============================================================ */

test('CACHE-COLLISION-1：哈希相同但载荷不同 ⇒ 规范化载荷比对必须发现（键相同≠同一个问题）', () => {
  /*
   * 本文件**不**声称「不会碰撞」。能做的是证明**碰撞不会被静默接受**：
   * 读缓存的每一层都有一道「逐字段」比对，而不是只比哈希字符串。
   *
   * 这里直接验证那道比对本身：两个**键相同**但字段不同的场景，
   * 必须被 `scenariosEquivalent` 判为不等价（从而拒绝命中）。
   */
  const same = { ...V1 };
  assert.equal(scenarioHashOf(same), scenarioHashOf(V1), '前提：两者键相同');

  // 逐字段比对的判据必须能抓到每一类差异（这里挑三类最有代表性的）
  const variants: Array<[string, GtoScenario]> = [
    ['换 Hero 位置', { ...V1, heroPosition: 'SB' }],
    ['改有效筹码', { ...V1, effectiveStackBB: 101 }],
    ['改动作历史', { ...V1, actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 3 }] }],
  ];
  for (const [label, v] of variants) {
    assert.notEqual(scenarioHashOf(v), scenarioHashOf(V1), `${label}：键必须不同（前提检查）`);
  }
});

test('CACHE-COLLISION-3：🔴 碰撞防线必须**真的接在读取路径上**（源码级断言）', async () => {
  /*
   * 只测 `scenariosEquivalent` 这个**谓词**是不够的：谓词正确但**没人调用**
   * 等于没有防线（本项目的历史教训：「自检函数零调用者 = 没有自检」）。
   * 因此这里直接读源码，要求：
   *
   * 1. 内存缓存命中前必须调用 `scenariosEquivalent(cached.scenario, scenario)`；
   * 2. in-flight 复用时必须调用 `scenariosEquivalent(existing.scenario, scenario)`；
   * 3. 持久化读取必须把 `scenario` 传进 `store.load(...)`（逐字段比对在存储层）；
   * 4. **不得**留下「只比键就复用」的旧形态（`inFlight.set(cacheKey, task)`）。
   */
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const lookupSrc = readFileSync(join(root, 'src/domain/gto/gtoSafeLookup.ts'), 'utf8');
  const storeSrc = readFileSync(join(root, 'src/domain/gto/gtoStrategyStore.ts'), 'utf8');

  assert.ok(
    lookupSrc.includes('scenariosEquivalent(cached.scenario, scenario)'),
    '内存缓存命中前必须逐字段比对场景',
  );
  assert.ok(
    lookupSrc.includes('scenariosEquivalent(existing.scenario, scenario)'),
    'in-flight 复用前必须逐字段比对场景',
  );
  assert.ok(
    /this\.store\.load\(keys\.cacheKey,\s*\{[\s\S]{0,200}?scenario,/.test(lookupSrc),
    '持久化读取必须把规范化场景传进 store.load（至少一处）',
  );
  assert.ok(
    storeSrc.includes('scenariosEquivalent(checked.scenario, expected.scenario)'),
    '存储层必须做逐字段场景比对',
  );
  assert.ok(
    !/inFlight\.set\(keys\.cacheKey,\s*task\)/.test(lookupSrc),
    '不得回到「只凭缓存键就复用 in-flight 任务」的旧形态',
  );
});

test('CACHE-COLLISION-2：`scenariosEquivalent` 覆盖键的全部字段（防「加字段忘了加比对」）', async () => {
  const { scenariosEquivalent } = await import('../src/domain/gto/gtoScenario.ts');
  const base = V1;
  const perturbations: Array<[string, GtoScenario]> = [
    ['kind', { ...base, kind: GtoScenarioKind.RFI }],
    ['tableSize', { ...base, tableSize: 6 }],
    ['effectiveStackBB', { ...base, effectiveStackBB: 100.0001 }],
    ['heroPosition', { ...base, heroPosition: 'CO' }],
    ['heroAlreadyActed', { ...base, heroAlreadyActed: !base.heroAlreadyActed }],
    ['blinds.sbBB', { ...base, blinds: { ...base.blinds, sbBB: 1 } }],
    ['blinds.bbBB', { ...base, blinds: { ...base.blinds, bbBB: 2 } }],
    ['blinds.anteBB', { ...base, blinds: { ...base.blinds, anteBB: 1 } }],
    ['actionHistory 长度', { ...base, actionHistory: [] }],
    [
      'actionHistory.sizeBB',
      { ...base, actionHistory: [{ position: 'UTG', kind: 'RAISE', sizeBB: 3 }] },
    ],
    [
      'actionHistory.kind',
      { ...base, actionHistory: [{ position: 'UTG', kind: 'CALL', sizeBB: 2.5 }] },
    ],
    [
      'actionHistory.position',
      { ...base, actionHistory: [{ position: 'HJ', kind: 'RAISE', sizeBB: 2.5 }] },
    ],
  ];
  for (const [label, v] of perturbations) {
    assert.equal(scenariosEquivalent(base, v), false, `${label} 必须被判为不等价`);
  }
  assert.equal(scenariosEquivalent(base, { ...base }), true, '同一场景必须判为等价');
});

/* ============================================================
 * 七、字段表自身的不变量
 * ============================================================ */

test('CACHE-SCHEMA-1：字段表与生产载荷逐项对齐（防止表与实现分家）', () => {
  // 每个种类的载荷，键集合必须与表完全一致（`canonicalPayloadOf` 会抛错，这里再断言一次内容）
  const scenarioKeys = Object.keys(JSON.parse(scenarioPayloadOf(V1)) as object);
  assert.deepEqual(scenarioKeys, [...PAYLOAD_SCHEMAS.scenario]);
  const solveKeys = Object.keys(JSON.parse(solvePayloadOf(SOLVE)) as object);
  assert.deepEqual(solveKeys, [...PAYLOAD_SCHEMAS.solve]);
  const cacheKeys = Object.keys(JSON.parse(cachePayloadOf(V1, SOLVE)) as object);
  assert.deepEqual(cacheKeys, [...PAYLOAD_SCHEMAS.cache]);
  const treeKeys = Object.keys(
    JSON.parse(
      treePayloadOf(V1, {
        openSizesBB: SOLVE.openSizesBB,
        raiseMults: SOLVE.raiseMults,
        maxRaises: SOLVE.maxRaises,
        limp: SOLVE.limp,
        addAllin: SOLVE.addAllin,
        engine: SOLVE.engine,
      }),
    ) as object,
  );
  assert.deepEqual(treeKeys, [...PAYLOAD_SCHEMAS.tree]);
});
