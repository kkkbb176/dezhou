/**
 * 一键加入玩家（`FILL_EMPTY_SEATS`）—— 2026-09 新增
 *
 * ## 这一组防的是什么
 *
 * 「一键补齐空位」本质上是「逐个 `ADD_PLAYER`」的**批量版**，
 * 因此它有两个必须锁死的性质：
 *
 * | 性质 | 为什么必须锁 |
 * |---|---|
 * | **等价性** | 一键加进来的玩家必须与逐个加进来的**逐字段相同**（身份、显示名、筹码、画像、座位状态）。两套实现一旦分叉，用户会看到「一键加的人不一样」。 |
 * | **粒度** | 一次操作 = **一次** `revision` + **一条**撤销记录。否则按一次撤销只退掉一个人，与「我按了一次按钮」的直觉不符（规范第 38 条：撤销要能恢复操作前的状态）。 |
 *
 * 另外锁门禁：本手进行中不许加（与 `addPlayer` 同一条 §54 规则）、没有空位要明确拒绝。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import { fillEmptySeats } from '../src/app/table/seatLifecycle.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import { Position } from '../src/domain/types.ts';
import { SeatStatus } from '../src/app/table/table.types.ts';
import type { PokerTableState } from '../src/app/table/table.types.ts';

/** 6 人桌：Hero 在 BTN，其余 5 个空位 */
function freshTable(tableSize: 6 | 9 = 6, heroPosition: Position = Position.BTN): PokerTableState {
  return createTable({ tableSize, heroPosition });
}

function must(state: PokerTableState, op: Parameters<typeof applyTableOp>[1]): PokerTableState {
  const out = applyTableOp(state, op);
  assert.equal(out.ok, true, `操作 ${op.kind} 必须成功：${out.ok ? '' : JSON.stringify(out.issues)}`);
  if (!out.ok) throw new Error('unreachable');
  return out.state;
}

function emptySeatIds(state: PokerTableState): string[] {
  return state.seats.filter((s) => s.playerId === null).map((s) => s.seatId);
}

/* ============================================================
 * 一、等价性：一键 = 逐个（逐字段）
 * ============================================================ */

test('FILL-01：🔴 一键补齐的结果必须与「逐个 ADD_PLAYER」**逐字段相同**', () => {
  const base = freshTable();
  const targets = emptySeatIds(base);
  assert.equal(targets.length, 5, '前置条件：6 人桌 Hero 在 BTN ⇒ 5 个空位');

  // 逐个加
  let step = base;
  for (const seatId of targets) step = must(step, { kind: 'ADD_PLAYER', seatId });

  // 一键加
  const oneShot = must(base, { kind: 'FILL_EMPTY_SEATS' });

  assert.deepEqual(oneShot.seats, step.seats, '座位（含 playerId / status / 视觉字段）必须逐字段相同');
  assert.deepEqual(oneShot.playersById, step.playersById, '玩家登记表必须逐字段相同');
  assert.equal(oneShot.nextPlayerNumber, step.nextPlayerNumber, '下一个玩家编号必须一致');

  // 新玩家的形状（§13）：新身份 / 默认筹码 / 画像 UNKNOWN / 动态 UNKNOWN
  for (const seat of oneShot.seats) {
    if (seat.playerId === null) continue;
    if (seat.logicalPosition === Position.BTN) continue; // Hero
    const player = oneShot.playersById[seat.playerId];
    assert.ok(player !== undefined, '座位上的玩家必须在登记表里');
    assert.equal(player!.quickProfile, 'UNKNOWN');
    assert.equal(player!.dynamicHint, 'UNKNOWN');
    assert.equal(player!.isHero, false);
    assert.equal(player!.handsPlayed, 0);
    assert.equal(seat.status, SeatStatus.SEATED_ACTIVE);
    assert.equal(seat.sitOutNextHand, false, '新玩家不得继承任何「下一手暂离」标记');
    assert.equal(seat.stackBB, oneShot.defaultStackBB, '新玩家必须拿牌桌默认筹码');
  }
});

test('FILL-02：一键补齐必须**不动 Hero**（座位绑定、位置、筹码都不变）', () => {
  const base = freshTable();
  const heroBefore = base.seats.find((s) => s.logicalPosition === base.heroPosition);
  const after = must(base, { kind: 'FILL_EMPTY_SEATS' });
  const heroAfter = after.seats.find((s) => s.logicalPosition === after.heroPosition);

  assert.deepEqual(heroAfter, heroBefore, 'Hero 的座位必须逐字段不变');
  assert.equal(after.heroPosition, base.heroPosition, 'Hero 的位置不得被改动');
  assert.equal(after.heroPlayerId, base.heroPlayerId, 'Hero 的身份不得被改动');
  assert.equal(after.tableSize, base.tableSize, '桌型不得被改动');
});

test('FILL-03：已有玩家的座位不得被抢占或改名（补齐只填空位）', () => {
  // 先在一个空位放人，再补齐
  const base = freshTable();
  const firstEmpty = emptySeatIds(base)[0]!;
  const seeded = must(base, { kind: 'ADD_PLAYER', seatId: firstEmpty });
  const seededSeat = seeded.seats.find((s) => s.seatId === firstEmpty)!;

  const after = must(seeded, { kind: 'FILL_EMPTY_SEATS' });
  const sameSeat = after.seats.find((s) => s.seatId === firstEmpty)!;

  assert.equal(sameSeat.playerId, seededSeat.playerId, '已占用的座位不得被换人');
  assert.equal(sameSeat.stackBB, seededSeat.stackBB, '已占用的座位不得被改筹码');
  assert.equal(
    emptySeatIds(after).length,
    0,
    '补齐后不得还有空位',
  );
});

test('FILL-04：9 人桌同样适用（桌型隔离：空位数按实际桌型算）', () => {
  const base = freshTable(9, Position.BTN);
  assert.equal(emptySeatIds(base).length, 8, '9 人桌 Hero 在 BTN ⇒ 8 个空位');
  const after = must(base, { kind: 'FILL_EMPTY_SEATS' });
  assert.equal(after.seats.length, 9);
  assert.equal(emptySeatIds(after).length, 0);
  // 每个新玩家身份唯一
  const ids = after.seats.map((s) => s.playerId).filter((id): id is string => id !== null);
  assert.equal(new Set(ids).size, ids.length, '玩家身份不得重复');
});

/* ============================================================
 * 二、粒度：一次操作 = 一次 revision = 一次撤销
 * ============================================================ */

test('FILL-05：🔴 一键补齐只推进 1 次 revision、只压 1 条撤销记录', () => {
  const base = freshTable();
  const after = must(base, { kind: 'FILL_EMPTY_SEATS' });

  assert.equal(after.revision, base.revision + 1, `revision 只能 +1（实际 ${after.revision - base.revision}）`);
  assert.equal(
    after.undo.length,
    base.undo.length + 1,
    `撤销栈只能 +1（实际 +${after.undo.length - base.undo.length}）`,
  );

  // 对照：逐个加会推进 5 次
  let step = base;
  for (const seatId of emptySeatIds(base)) step = must(step, { kind: 'ADD_PLAYER', seatId });
  assert.equal(step.revision, base.revision + 5, '对照：逐个加 5 人推进 5 次');
});

test('FILL-06：撤销一次必须**整张桌子**回到补齐前（不是只退一个人）', () => {
  const base = freshTable();
  const filled = must(base, { kind: 'FILL_EMPTY_SEATS' });
  const undone = must(filled, { kind: 'UNDO' });

  assert.deepEqual(undone.seats, base.seats, '撤销后座位必须与补齐前逐字段相同');
  assert.deepEqual(undone.playersById, base.playersById, '撤销后玩家登记表必须复原');
  assert.equal(undone.nextPlayerNumber, base.nextPlayerNumber, '玩家编号计数也必须回退');
  assert.equal(emptySeatIds(undone).length, 5, '撤销后必须重新有 5 个空位');
});

test('FILL-07：补齐后可以继续正常操作（拿得到行动队列、预览不炸）', () => {
  const filled = must(freshTable(), { kind: 'FILL_EMPTY_SEATS' });
  const preview = buildTablePreview(filled);
  assert.equal(preview.seats.length, 6);
  assert.equal(
    preview.seats.filter((s) => s.playerId !== null).length,
    6,
    '预览里 6 个座位都必须有人',
  );
  // 还能继续加/清：先清一个再补一个
  const someVillain = filled.seats.find((s) => s.playerId !== null && s.logicalPosition !== filled.heroPosition)!;
  const cleared = must(filled, { kind: 'CLEAR_SEAT', seatId: someVillain.seatId });
  const refilled = must(cleared, { kind: 'FILL_EMPTY_SEATS' });
  assert.equal(emptySeatIds(refilled).length, 0, '清空后再补齐必须重新满桌');
});

/* ============================================================
 * 三、门禁
 * ============================================================ */

test('FILL-08：本手进行中必须拒绝（与 ADD_PLAYER 同一条 §54 规则）', () => {
  let state = freshTable();
  /*
   * ⚠️ 必须先坐下**至少一名对手**才能开局：本手拓扑要求 ≥2 名参与者
   *（一个人没法打牌），因此「只有 Hero」时给底牌会被拓扑冻结拒绝。
   */
  state = must(state, { kind: 'ADD_PLAYER', seatId: emptySeatIds(state)[0]! });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'As' });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Kd' });
  assert.equal(state.handActive, true, '前置条件：本手已经开始');

  const out = applyTableOp(state, { kind: 'FILL_EMPTY_SEATS' });
  assert.equal(out.ok, false, '本手进行中不许加人');
  if (out.ok) return;
  assert.equal(out.issues[0]!.code, 'HAND_ACTIVE');
  assert.match(out.issues[0]!.message, /下一手|重置本手/);
});

test('FILL-09：没有空位必须明确拒绝（不是静默成功、也不是空操作）', () => {
  const filled = must(freshTable(), { kind: 'FILL_EMPTY_SEATS' });
  const out = applyTableOp(filled, { kind: 'FILL_EMPTY_SEATS' });
  assert.equal(out.ok, false, '满桌时补齐必须被拒绝');
  if (out.ok) return;
  assert.equal(out.issues[0]!.code, 'SEAT_OCCUPIED');
  assert.match(out.issues[0]!.message, /都已经有人/);
});

test('FILL-10：补齐必须留下可读的中文 notice（用户要知道刚才发生了什么）', () => {
  const after = must(freshTable(), { kind: 'FILL_EMPTY_SEATS' });
  assert.equal(after.notices.length, 1, '必须恰好一条 notice');
  assert.match(after.notices[0]!, /5 个空位/);
  assert.match(after.notices[0]!, /撤销/);
});

test('FILL-11：直接调用 fillEmptySeats 也必须走同一套门禁（不依赖 op 分发层）', () => {
  const state = freshTable();
  const out = fillEmptySeats(state);
  assert.equal(out.ok, true);
  // 幂等性：再调用一次必须被拒（而不是把桌子加爆）
  if (!out.ok) return;
  const again = fillEmptySeats(out.state);
  assert.equal(again.ok, false, '第二次补齐必须被拒绝');
});
