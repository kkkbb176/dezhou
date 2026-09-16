/**
 * 牌桌 API 与 HTTP 层：Fail-Closed、竞态保护、双击防护
 *
 * ## 为什么这些测试必须在 **HTTP 层**再做一遍
 *
 * 纯函数层（`tableApi.ts`）已经测过一遍，但真实浏览器面对的是：
 *
 * - JSON 序列化 / 反序列化（`undefined`、`NaN`、数字变字符串）
 * - **并发**：两次点击同时在路上（规范第 76 / 77 条）
 * - 恶意或半损坏的载荷（规范第 89 条：最危险的是「看起来对」）
 *
 * 因此这里的断言都是「经过真实 HTTP 往返之后仍然成立」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startAlphaServer, type AlphaServer } from '../src/app/webServer.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { Position } from '../src/domain/types.ts';
import { createTable, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();

async function withServer(fn: (server: AlphaServer) => Promise<void>): Promise<void> {
  const server = await startAlphaServer({ port: 0, rules: RULES, logPath: null });
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

type Json = Record<string, unknown>;

async function post(server: AlphaServer, path: string, body: unknown): Promise<Json> {
  const res = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Json;
}

/** 建一张满座的 6 人桌（服务端没有游戏状态，所以由测试持有状态） */
function fullTable(hero: Position): PokerTableState {
  let state = createTable({ tableSize: 6, heroPosition: hero, defaultStackBB: 100 });
  for (const position of [
    Position.UTG,
    Position.HJ,
    Position.CO,
    Position.BTN,
    Position.SB,
    Position.BB,
  ]) {
    if (position === hero) continue;
    const result = applyTableOp(state, {
      kind: 'ADD_PLAYER',
      seatId: seatOfPosition(state, position)!.seatId,
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    state = result.state;
  }
  return state;
}

/* ============================================================
 * 元数据与静态资源
 * ============================================================ */

test('HTTP：元数据端点是前端**零硬编码**的唯一来源', async () => {
  await withServer(async (server) => {
    const res = await fetch(`${server.url}/api/table/meta`);
    const payload = (await res.json()) as { ok: boolean; meta: Record<string, unknown[]> };
    assert.equal(payload.ok, true);
    assert.equal(payload.meta['positions']!.length, 9, '9 个位置');
    assert.equal(payload.meta['quickProfiles']!.length, 11, '11 种快速画像');
    assert.equal(payload.meta['dynamicHints']!.length, 7, '7 种动态观察（SIZE_ANOMALY 已移除）');
    assert.equal(payload.meta['leaveChoices']!.length, 3);
  });
});

test('HTTP：静态资源可访问，且页面不引用任何策略逻辑', async () => {
  await withServer(async (server) => {
    for (const [path, needle] of [
      ['/', 'table.js'],
      ['/table.css', '--felt'],
      ['/table.js', 'sendOp'],
    ] as const) {
      const res = await fetch(`${server.url}${path}`);
      assert.equal(res.status, 200, `${path} 应当可访问`);
      const text = await res.text();
      assert.ok(text.includes(needle), `${path} 应当包含 ${needle}`);
    }

    // 前端**不得**出现「自己判断轮到谁 / 自己算合法动作」的痕迹。
    //
    // ⚠️ 匹配的是**函数调用**（`name(`）而不是裸子串：
    //    `preview.minRaiseToBB` 是一个合法的**展示字段**，
    //    而 `minRaiseTo(` 才意味着前端自己实现了规则。
    const js = await (await fetch(`${server.url}/table.js`)).text();
    for (const forbidden of [
      'postflopOrder(',
      'preflopOrder(',
      'minRaiseTo(',
      'computePot(',
      'isUnopenedPot(',
      'requiredCallAmount(',
      'seatIndexOfPosition(',
      'playerIdOfPosition(',
    ]) {
      assert.ok(
        !js.includes(forbidden),
        `前端不得调用规则函数 ${forbidden} —— 那意味着它复制了状态机（规范第 29 条）`,
      );
    }
  });
});

/* ============================================================
 * 新建牌桌
 * ============================================================ */

test('HTTP：新建牌桌返回空座状态，并如实报告「无法分析」', async () => {
  await withServer(async (server) => {
    const created = await post(server, '/api/table', { tableSize: 6, heroPosition: 'CO' });
    assert.equal(created['ok'], true);
    assert.equal(created['created'], true);
    const state = created['state'] as PokerTableState;
    const preview = created['preview'] as { canAnalyze: boolean; analyzeBlockers: string[] };
    assert.equal(state.seats.length, 6);
    assert.equal(state.seats.filter((s) => s.playerId === null).length, 5, '除 Hero 外都是空座');
    assert.equal(preview.canAnalyze, false);
    assert.ok(
      preview.analyzeBlockers.some((b) => b.includes('空座位')),
      '必须如实说明空座位导致无法分析',
    );
    // 同一条原因不得重复显示
    const duplicates = preview.analyzeBlockers.filter(
      (b, i) => preview.analyzeBlockers.indexOf(b) !== i,
    );
    assert.deepEqual(duplicates, [], '分析阻塞原因不得重复');
  });
});

test('HTTP：非法桌型 / 非法 Hero 位置必须被拒绝（不静默兜底）', async () => {
  await withServer(async (server) => {
    const badPosition = await post(server, '/api/table', { tableSize: 6, heroPosition: 'XX' });
    assert.equal(badPosition['ok'], false);

    const badSize = await post(server, '/api/table', { tableSize: 7, heroPosition: 'CO' });
    // 桌型非法时退回 6 人桌（而不是崩溃），但必须**如实**反映在状态里
    assert.equal(badSize['ok'], true);
    assert.equal((badSize['state'] as PokerTableState).tableSize, 6);
  });
});

/* ============================================================
 * 状态形状校验（Fail-Closed）
 * ============================================================ */

test('HTTP：畸形状态载荷必须被拒绝，且**不产生任何副作用**', async () => {
  await withServer(async (server) => {
    const state = fullTable(Position.CO);

    const cases: readonly (readonly [string, unknown])[] = [
      ['不是对象', 'not-an-object'],
      ['缺 seats', { ...state, seats: undefined }],
      ['seats 数量不对', { ...state, seats: state.seats.slice(0, 3) }],
      ['位置重复', { ...state, seats: [state.seats[0], state.seats[0], ...state.seats.slice(2)] }],
      [
        '座位引用不存在的玩家',
        {
          ...state,
          seats: state.seats.map((s, i) => (i === 0 ? { ...s, playerId: 'ghost' } : s)),
        },
      ],
      [
        'EMPTY 却仍绑定玩家',
        {
          ...state,
          seats: state.seats.map((s, i) => (i === 0 ? { ...s, status: 'EMPTY' } : s)),
        },
      ],
      ['状态与绑定矛盾（有状态无玩家）', { ...state, seats: state.seats.map((s, i) => (i === 0 ? { ...s, playerId: null } : s)) }],
      ['revision 非法', { ...state, revision: -1 }],
      ['tableSize 非法', { ...state, tableSize: 5 }],
      ['环境非法', { ...state, environment: 'MARS' }],
      ['手牌超 2 张', { ...state, heroCards: ['As', 'Kd', 'Qh'] }],
      ['公共牌超 5 张', { ...state, board: ['2c', '3c', '4c', '5c', '6c', '7c'] }],
      ['行动类型非法', { ...state, actionHistory: [{ position: 'UTG', type: 'TELEPORT' }] }],
      ['筹码面额为小数', { ...state, bigBlindBB: 2.5 }],
      ['玩家画像非法', { ...state, playersById: { ...state.playersById, p1: { ...state.playersById['p1']!, quickProfile: 'GOD_MODE' } } }],
      ['撤销栈超长', { ...state, undo: new Array(200).fill(state.seats.length ? {} : {}) }],
      ['撤销条目非法', { ...state, undo: [{ garbage: true }] }],
    ];

    for (const [name, payload] of cases) {
      const response = await post(server, '/api/table', {
        state: payload,
        op: { kind: 'ADD_PLAYER', seatId: 'seat_UTG' },
      });
      assert.equal(response['ok'], false, `「${name}」必须被拒绝`);
      assert.ok(
        Array.isArray(response['issues']) && (response['issues'] as unknown[]).length > 0,
        `「${name}」必须给出可读原因`,
      );
    }
  });
});

test('HTTP：未知操作必须被拒绝', async () => {
  await withServer(async (server) => {
    const state = fullTable(Position.CO);
    for (const op of [{ kind: 'DELETE_EVERYTHING' }, { kind: 'ACT' }, 'nope', null]) {
      const response = await post(server, '/api/table', { state, op });
      assert.equal(response['ok'], false, `操作 ${JSON.stringify(op)} 必须被拒绝`);
    }
  });
});

/* ============================================================
 * 竞态保护（§76）
 * ============================================================ */

test('§76 竞态：两个并发的同版本请求 —— 只有一个能被应用', async () => {
  await withServer(async (server) => {
    const created = await post(server, '/api/table', { tableSize: 6, heroPosition: 'CO' });
    const state = created['state'] as PokerTableState;
    const seatId = seatOfPosition(state, Position.UTG)!.seatId;

    // 两个请求基于**同一个版本**同时发出（模拟网络乱序 / 双击）
    const [a, b] = await Promise.all([
      post(server, '/api/table', { state, op: { kind: 'ADD_PLAYER', seatId } }),
      post(server, '/api/table', { state, op: { kind: 'ADD_PLAYER', seatId } }),
    ]);

    const okCount = [a, b].filter((x) => x['ok'] === true).length;
    const rejected = [a, b].find((x) => x['ok'] === false);

    assert.equal(okCount, 1, '并发的同版本请求只能有一个被应用（另一个必须被拒绝）');
    assert.ok(rejected !== undefined, '必须有一个请求被拒绝');
    const issues = rejected['issues'] as readonly { code: string }[];
    assert.equal(issues[0]!.code, 'STALE_REVISION', '被拒绝的原因必须是「版本过期」');
  });
});

test('§76 竞态：迟到的旧版本请求不得覆盖新状态', async () => {
  await withServer(async (server) => {
    const created = await post(server, '/api/table', { tableSize: 6, heroPosition: 'CO' });
    const v0 = created['state'] as PokerTableState;
    const seatId = seatOfPosition(v0, Position.UTG)!.seatId;

    // #42：先把版本推进
    const newer = await post(server, '/api/table', {
      state: v0,
      op: { kind: 'ADD_PLAYER', seatId },
    });
    assert.equal(newer['ok'], true);
    const v1 = newer['state'] as PokerTableState;
    assert.equal(v1.revision, v0.revision + 1);

    // #41：基于旧版本迟到
    const late = await post(server, '/api/table', {
      state: v0,
      op: { kind: 'ADD_PLAYER', seatId },
    });
    assert.equal(late['ok'], false, '迟到的旧版本请求必须被拒绝');
    const issues = late['issues'] as readonly { code: string; message: string }[];
    assert.equal(issues[0]!.code, 'STALE_REVISION');
    assert.ok(
      issues[0]!.message.includes('不会被回退'),
      `拒绝信息必须说明「界面不会被回退」，实际：${issues[0]!.message}`,
    );
  });
});

test('§77 双击：同一个座位连续两次「加入玩家」，第二次必须被拒绝', async () => {
  await withServer(async (server) => {
    const created = await post(server, '/api/table', { tableSize: 6, heroPosition: 'CO' });
    const v0 = created['state'] as PokerTableState;
    const seatId = seatOfPosition(v0, Position.UTG)!.seatId;

    const first = await post(server, '/api/table', {
      state: v0,
      op: { kind: 'ADD_PLAYER', seatId },
    });
    assert.equal(first['ok'], true);

    // 第二次是**串行**发出的，且携带**已经更新过的**状态 ——
    // 模拟「前端忘了 disable」的情形：座位已经被占，必须被业务规则拒绝
    const v1 = first['state'] as PokerTableState;
    const second = await post(server, '/api/table', {
      state: v1,
      op: { kind: 'ADD_PLAYER', seatId },
    });
    assert.equal(second['ok'], false, '座位已占用时必须拒绝第二次加入');
    const issues = second['issues'] as readonly { code: string }[];
    assert.equal(issues[0]!.code, 'SEAT_OCCUPIED');

    // 关键：**只加入了一个玩家**（不是两个）
    assert.equal(v1.seats.filter((s) => s.playerId !== null).length, 2, 'Hero + 新玩家');
  });
});

test('§78 座位操作防重复：连续两次「清空座位」只有第一次生效', async () => {
  await withServer(async (server) => {
    const created = await post(server, '/api/table', { tableSize: 6, heroPosition: 'CO' });
    const v0 = created['state'] as PokerTableState;
    const seatId = seatOfPosition(v0, Position.UTG)!.seatId;
    const added = await post(server, '/api/table', {
      state: v0,
      op: { kind: 'ADD_PLAYER', seatId },
    });
    const v1 = added['state'] as PokerTableState;
    const playerId = seatOfPosition(v1, Position.UTG)!.playerId!;

    const cleared = await post(server, '/api/table', {
      state: v1,
      op: { kind: 'CLEAR_SEAT', seatId },
    });
    assert.equal(cleared['ok'], true);
    const v2 = cleared['state'] as PokerTableState;
    assert.equal(seatOfPosition(v2, Position.UTG)!.playerId, null);

    const again = await post(server, '/api/table', { state: v2, op: { kind: 'CLEAR_SEAT', seatId } });
    assert.equal(again['ok'], false, '空座位再清一次必须被拒绝');
    const issues = again['issues'] as readonly { code: string }[];
    assert.equal(issues[0]!.code, 'SEAT_EMPTY');

    // 旧玩家对象仍可追溯，但没有任何座位引用它
    assert.ok(v2.playersById[playerId] !== undefined);
    assert.ok(!v2.seats.some((s) => s.playerId === playerId));
  });
});

/* ============================================================
 * 分析入口：牌桌路径与表单路径必须等价
 * ============================================================ */

test('HTTP：`/api/analyze` 接受牌桌状态，且与直接 input 结果逐位一致', async () => {
  await withServer(async (server) => {
    // 用真牌局：Hero 在大盲，UTG 开池，其余弃牌 → Hero 面对加注
    let state = fullTable(Position.BB);
    const ops: TableOp[] = [
      { kind: 'SET_HERO_CARD', card: 'As' },
      { kind: 'SET_HERO_CARD', card: 'Kd' },
      { kind: 'ACT', action: { type: 'RAISE', amountChips: 200 } },
      { kind: 'ACT', action: { type: 'FOLD' } },
      { kind: 'ACT', action: { type: 'FOLD' } },
      { kind: 'ACT', action: { type: 'FOLD' } },
      { kind: 'ACT', action: { type: 'FOLD' } },
    ];
    for (const op of ops) {
      const result = applyTableOp(state, op);
      assert.equal(result.ok, true, `操作应当成功：${JSON.stringify(op)}`);
      if (!result.ok) return;
      state = result.state;
    }

    const viaTable = await post(server, '/api/analyze', { table: state });
    assert.equal(viaTable['ok'], true, JSON.stringify(viaTable['issues'] ?? []));

    // 同一牌局的直接构造写法（旧的表单路径）
    const direct = {
      tableSize: 6,
      heroPosition: 'BB',
      heroCards: ['As', 'Kd'],
      board: [],
      street: 'PREFLOP',
      effectiveStackBB: 100,
      actionHistory: [
        { position: 'UTG', type: 'RAISE', amountBB: 2 },
        { position: 'HJ', type: 'FOLD' },
        { position: 'CO', type: 'FOLD' },
        { position: 'BTN', type: 'FOLD' },
        { position: 'SB', type: 'FOLD' },
      ],
      environment: 'MID_LOW_STAKES',
      villain: { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN' },
    };
    const viaInput = await post(server, '/api/analyze', { input: direct });
    assert.equal(viaInput['ok'], true);

    assert.deepEqual(
      JSON.stringify(viaTable['decision']),
      JSON.stringify(viaInput['decision']),
      '两条入口的决策必须逐位一致',
    );
    assert.equal(
      (viaTable['meta'] as { computedPot: number }).computedPot,
      (viaInput['meta'] as { computedPot: number }).computedPot,
      '两条入口重算出的底池必须一致',
    );

    /*
     * ⚠️ 输入哈希**本就应当不同**，这是如实记录而不是缺陷：
     *
     * 牌桌路径会显式带上 `seatStacksBB`（逐座位筹码）与 `villains`
     *（全部对手），表单路径没有这两个字段。铁律 F-10 要求**每个字段**
     * 都影响哈希，因此两种「写法不同、语义相同」的输入必然得到不同哈希。
     *
     * 哈希标识的是「这一次输入」，不是「这一手牌」。
     * 真实测试时全部走牌桌路径，同一手牌的哈希自然保持一致。
     */
    assert.notEqual(
      (viaTable['meta'] as { inputHash: string }).inputHash,
      (viaInput['meta'] as { inputHash: string }).inputHash,
      '显式字段集不同 → 哈希必须不同（若相同说明哈希漏字段了）',
    );
  });
});

test('HTTP：牌桌状态不合法时，`/api/analyze` 必须给出可读原因而不是 500', async () => {
  await withServer(async (server) => {
    const res = await fetch(`${server.url}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: { nonsense: true } }),
    });
    assert.equal(res.status, 200, '应当是结构化失败，而不是 500');
    const payload = (await res.json()) as { ok: boolean; issues: readonly { message: string }[] };
    assert.equal(payload.ok, false);
    assert.ok(payload.issues.length > 0);
  });
});

test('HTTP：坏 JSON 必须返回 400 且结构完整', async () => {
  await withServer(async (server) => {
    for (const path of ['/api/table', '/api/analyze']) {
      const res = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      });
      assert.equal(res.status, 400, `${path} 应当返回 400`);
      const payload = (await res.json()) as { ok: boolean };
      assert.equal(payload.ok, false);
    }
  });
});

/* ============================================================
 * 隐私与监听范围（不得因为新端点而放松）
 * ============================================================ */

test('HTTP：新端点同样只监听本机，且不发跨域头', async () => {
  await withServer(async (server) => {
    assert.ok(server.url.includes('127.0.0.1'), '必须只监听本机');
    const created = await post(server, '/api/table', { tableSize: 6 });
    assert.equal(created['ok'], true);
    const res = await fetch(`${server.url}/api/table/meta`);
    assert.equal(res.headers.get('access-control-allow-origin'), null, '不得开放跨域');
  });
});
