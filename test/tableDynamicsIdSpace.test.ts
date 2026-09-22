/**
 * ============================================================================
 * 桌况链路 **ID 口径** 回归锁（2026-09-22 修复 P0）
 * ============================================================================
 *
 * ## 被修的缺陷：两套 id 长得像但绝不通用
 *
 * | 来源 | 形状 | 语义 |
 * |---|---|---|
 * | `table.seats[].seatId` | `seat_BTN` | 座位 |
 * | `table.seats[].playerId` | `p2` | **玩家（记录 / 统计 / 桌况都用它）** |
 * | `engine.players[].id` | `seat_BTN` | 引擎座位 |
 *
 * `computeTableDynamics` 的三个入参（`presentPlayerIds` / `heroPlayerId` /
 * `relevantPlayerIds`）都在**持久 id** 空间 —— 它们要和 `record.playerId`
 * 比较。而 `tableDynamicsServer` 修复前传的是：
 *
 * ```text
 * presentPlayerIds  = Object.values(seatIdByPlayerId)  → 座位 id ❌
 * relevantPlayerIds = realizedOpponentIds(engine)      → 座位 id ❌
 * heroPlayerId      = table.heroPlayerId               → 持久 id ✅（口径不一致）
 * ```
 *
 * 全部后果都是**静默**的（没有任何报错）：
 *
 * - `recordsUsed` 恒为 0（实测 6 条记录全被判「非在桌玩家」）
 *   ⇒ `tableConfidence` 恒 0 ⇒ 桌况永远「观察中」、调整永不生效；
 * - `relevantIds.filter((id) => present.has(id))` 恒为空 ⇒ 逐对手层建不出来；
 * - `r.playerId === heroPlayerId` 恒不成立 ⇒ **Hero 自己的行为会混进对手桌况**
 *   （正是那条注释要防的自我剥削）。
 *
 * 本文件锁两件事：**口径一致性** 与 **recordsUsed 必须真的 > 0**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/app/table/tableState.ts';
import { computeTableDynamics } from '../src/domain/tableDynamics/tableDynamics.ts';

/** 六条记录：p2 / p3 各 3 条，都在 t1#H1 这一手 */
function recordsOf(): any[] {
  const mk = (playerId: string, seatId: string, i: number): any => ({
    handId: 't1#H1',
    playerId,
    displayName: playerId,
    seatId,
    street: 'PREFLOP',
    actionType: i % 2 === 0 ? 'RAISE' : 'CALL',
    amountBB: 2.5,
    facedBet: i % 2 === 1,
    toCallBB: i % 2 === 1 ? 2.5 : 0,
    seq: i,
    baseRevision: i,
    historyLength: i + 1,
    source: 'USER_INPUT',
    saved: false,
    handComplete: true,
    /* 旧记录（缺 potBB）会被排除 —— 必须带上，否则测的是另一条路径 */
    potBB: 5.5 + i,
  });
  return [
    mk('p2', 'seat_UTG', 0), mk('p3', 'seat_HJ', 1), mk('p2', 'seat_UTG', 2),
    mk('p3', 'seat_HJ', 3), mk('p2', 'seat_UTG', 4), mk('p3', 'seat_HJ', 5),
  ];
}

const BASE = {
  records: recordsOf(),
  currentHandId: null,
  activeCount: 2,
  street: 'PREFLOP' as const,
  playersYetToAct: 1,
};

/* ============================================================
 * IDSPACE-1：座位 id 会让所有记录被排除（缺陷本体）
 * ============================================================ */

test('IDSPACE-1 传座位 id 时所有记录必须被判「非在桌」—— 这就是那个静默失效', () => {
  const d = computeTableDynamics({
    ...BASE,
    presentPlayerIds: ['seat_UTG', 'seat_HJ'],
    heroPlayerId: 'p1',
    relevantPlayerIds: ['seat_HJ'],
  });
  assert.equal(d.recordsUsed, 0, '座位口径下 recordsUsed 必须是 0');
  assert.equal(d.excluded.notPresent, 6, '6 条记录必须全被判「非在桌玩家」');
  assert.equal(d.tableConfidence, 0, '没有可用记录 ⇒ 可信度 0');
  assert.equal(d.observing, true, '⇒ 永远处于「观察中」');
});

/* ============================================================
 * IDSPACE-2：持久 id 必须真的统计进去
 * ============================================================ */

test('IDSPACE-2 传持久 playerId 时记录必须被真的使用（recordsUsed > 0）', () => {
  const d = computeTableDynamics({
    ...BASE,
    presentPlayerIds: ['p2', 'p3'],
    heroPlayerId: 'p1',
    relevantPlayerIds: ['p3'],
  });
  assert.equal(d.recordsUsed, 6, '6 条记录必须全部可用');
  assert.equal(d.excluded.notPresent, 0, '不得有「非在桌」排除');
  assert.equal(d.excluded.missingLegacyFields, 0, '测试夹具必须带齐 potBB 等字段');
  assert.equal(d.handsObserved, 1, '同一 handId 只算 1 手');
  assert.ok(d.tableConfidence > 0, `有记录 ⇒ 可信度必须 > 0，实测 ${d.tableConfidence}`);
});

/* ============================================================
 * IDSPACE-3：逐对手层必须按持久 id 建出来
 * ============================================================ */

test('IDSPACE-3 relevantPlayerIds 必须是持久 id，逐对手层才会建出来', () => {
  const seats = computeTableDynamics({ ...BASE, presentPlayerIds: ['seat_UTG', 'seat_HJ'], heroPlayerId: 'p1', relevantPlayerIds: ['seat_HJ'] });
  const players = computeTableDynamics({ ...BASE, presentPlayerIds: ['p2', 'p3'], heroPlayerId: 'p1', relevantPlayerIds: ['p3'] });
  assert.deepEqual(Object.keys(seats.layers.relevantByPlayer), ['seat_HJ'], '座位口径：层以座位 id 命名（非生产期望）');
  assert.deepEqual(Object.keys(players.layers.relevantByPlayer), ['p3'], '持久口径：层以 playerId 命名');
  /*
   * `relevantIds` 会被 `present` 过滤 —— 因此**两个入参必须同口径**。
   * 混用（present 用持久、relevant 用座位）会让逐对手层恒为空。
   */
  const mixed = computeTableDynamics({
    ...BASE, presentPlayerIds: ['p2', 'p3'], heroPlayerId: 'p1', relevantPlayerIds: ['seat_HJ'],
  });
  assert.deepEqual(Object.keys(mixed.layers.relevantByPlayer), [], '混用口径 ⇒ 逐对手层为空（这正是修复前的形态之一）');
});

/* ============================================================
 * IDSPACE-4：Hero 排除必须真的生效
 * ============================================================ */

test('IDSPACE-4 Hero 自己的记录必须被排除（heroPlayerId 与记录同口径）', () => {
  const withHero = [
    ...recordsOf(),
    { ...recordsOf()[0]!, playerId: 'p1', displayName: '我（Hero）', seatId: 'seat_BTN', seq: 9, baseRevision: 9 },
  ];
  const right = computeTableDynamics({
    ...BASE, records: withHero, presentPlayerIds: ['p1', 'p2', 'p3'], heroPlayerId: 'p1', relevantPlayerIds: ['p3'],
  });
  assert.equal(right.excluded.heroSelf, 1, 'Hero 的 1 条记录必须被排除');
  assert.equal(right.recordsUsed, 6, '只统计 6 条对手记录');

  /* 修复前的混用形态：heroPlayerId 给座位 id ⇒ 恒不匹配 ⇒ Hero 混进对手桌况 */
  const mixed = computeTableDynamics({
    ...BASE, records: withHero, presentPlayerIds: ['p1', 'p2', 'p3'], heroPlayerId: 'seat_BTN', relevantPlayerIds: ['p3'],
  });
  assert.equal(mixed.excluded.heroSelf, 0, '口径不一致 ⇒ Hero 排除恒不生效');
  assert.equal(mixed.recordsUsed, 7, '⇒ Hero 自己的 1 条被当成对手行为统计进去');
});

/* ============================================================
 * IDSPACE-5：真实牌桌上两套 id 确实不同（口径混淆的前提）
 * ============================================================ */

test('IDSPACE-5 真实牌桌上 seatId 与 playerId 必须是两种不同的字符串', () => {
  const table = createTable({ tableSize: 6, bigBlindBB: 1, defaultStackBB: 100 });
  const bound = table.seats.filter((s) => s.playerId !== null);
  assert.ok(bound.length > 0, '新桌至少绑定了 Hero');
  for (const s of bound) {
    assert.equal(s.seatId, `seat_${s.logicalPosition}`, 'seatId 是座位口径');
    assert.ok(!s.seatId!.startsWith('seat_p'), 'seatId 不含玩家编号');
    assert.match(s.playerId!, /^p\d+$/, 'playerId 是持久口径（p1 / p2 …）');
    assert.notEqual(s.seatId, s.playerId, '两者绝不相等 —— 这正是混淆会静默的原因');
  }
  /* Hero 的 playerId 是 p1，与它的 seatId 不同 */
  const heroSeat = table.seats.find((s) => s.playerId === table.heroPlayerId);
  assert.ok(heroSeat !== undefined);
  assert.equal(table.heroPlayerId, 'p1');
  assert.notEqual(heroSeat!.seatId, table.heroPlayerId);
});
