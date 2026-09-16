/**
 * Button（庄家按钮）座位不变量 —— 2026-09 修复
 *
 * ## 使用者报告的形态
 *
 * 「我选择我的位置后，点击筹码，确认筹码后，位置会变」
 *
 * 实际根因在**选位置**那一步：`buttonSeatId`（哪个座位是庄家）**没有任何东西
 * 保证那个座位还有人**。把 Hero 从 BTN 挪到 CO 会腾空旧座位 —— 而它正是 Button
 * 座位。下游在「Button 不在参与者里」时静默回落到 `positions[0]`（第一个参与者），
 * 于是屏幕上出现：
 *
 * ```text
 *   玩家2（UTG 座位） → 庄家位                  ← 被回落规则凭空接管
 *   空座位（BTN）     → 庄家位 · 本手不参与      ← 「庄家位」出现两次
 *   我（Hero，CO）    → 大盲位                   ← 与顶栏「Hero 在 CO」自相矛盾
 * ```
 *
 * 而使用者是在**改完筹码**（界面重新渲染）之后才看到这个错乱，所以先怀疑筹码。
 *
 * ## 修复方式与**为什么不是另一种**
 *
 * 试过「在写状态时立刻把 Button 挪到下一个合格座位」—— `test/tableTopology.test.ts`
 * 的 §4b 立刻变红：`NEXT_HAND` 会**二次轮转**，中间那位玩家永远拿不到 Button，
 * 盲注归属全错。因此最终只改**怎么读**：状态里的 `buttonSeatId` 不动
 * （轮转仍从它出发），显示与本手拓扑统一走 `effectiveButtonSeatId`
 *（= 从它顺时针找到的第一个合格座位，也就是 `NEXT_HAND` 将要轮到的那一个）。
 *
 * 本文件把这三件事都锁住：显示不重不漏、预览与冻结同源、状态不被偷改。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import { effectiveButtonSeatId } from '../src/app/table/tableState.ts';
import { POSITION_ZH } from '../src/app/manualInput/manualInput.ts';
import { Position } from '../src/domain/types.ts';
import { SeatStatus } from '../src/app/table/table.types.ts';
import type { PokerTableState } from '../src/app/table/table.types.ts';

function must(state: PokerTableState, op: Parameters<typeof applyTableOp>[1]): PokerTableState {
  const out = applyTableOp(state, op);
  assert.equal(out.ok, true, `${op.kind} 必须成功：${out.ok ? '' : JSON.stringify(out.issues)}`);
  if (!out.ok) throw new Error('unreachable');
  return out.state;
}

/** 满桌（Hero 在 BTN），并已把 Hero 挪到 `heroPosition` */
function fullTableAt(heroPosition: Position): PokerTableState {
  let s = createTable({ tableSize: 6, heroPosition: Position.BTN });
  s = must(s, { kind: 'FILL_EMPTY_SEATS' });
  if (heroPosition !== Position.BTN) {
    s = must(s, { kind: 'SET_HERO_POSITION', position: heroPosition });
  }
  return s;
}

/** 参与者座位的角色（中文）列表 */
function rolesOfParticipants(state: PokerTableState): string[] {
  return buildTablePreview(state)
    .seats.filter((seat) => seat.isParticipant)
    .map((seat) => POSITION_ZH[seat.handRole as Position] ?? String(seat.handRole));
}

function occupiedSeats(state: PokerTableState) {
  return state.seats.filter((s) => s.playerId !== null && s.status !== SeatStatus.EMPTY);
}

/* ============================================================
 * 一、显示必须不重不漏（使用者的报告）
 * ============================================================ */

test('BTN-01：🔴 庄家位必须落在「有效 Button」座位上，而不是回落到第一个参与者', () => {
  const state = fullTableAt(Position.CO);
  const preview = buildTablePreview(state);
  const roles = rolesOfParticipants(state);

  assert.equal(roles.length, occupiedSeats(state).length, '参与者数量与有人座位数必须一致');
  assert.equal(
    new Set(roles).size,
    roles.length,
    `角色不得重复：${roles.join(' / ')}`,
  );
  assert.equal(
    roles.filter((r) => r === POSITION_ZH[Position.BTN]).length,
    1,
    `必须恰好一个庄家位：${roles.join(' / ')}`,
  );

  // 「D」标记与角色的庄家位必须是同一个座位
  const dealers = preview.seats.filter((s) => s.isDealer);
  assert.equal(dealers.length, 1, '庄家标记（D）必须恰好一个');
  const roleSeat = preview.seats.find((s) => s.handRole === Position.BTN)!;
  assert.equal(dealers[0]!.seatId, roleSeat.seatId, '带 D 的座位必须就是拿到「庄家位」角色的那个座位');

  /*
   * 🔴 **判别性断言**（这条才是修复的锁）：
   * 庄家位必须落在 `effectiveButtonSeatId`（从失效的 Button 座位顺时针找到的第一个
   * 合格座位）上。修复前它会**回落到 `positions[0]`**（= 环上第一个参与者，本例是
   * UTG 座位）—— 那是一个凭空捏造的庄家，且与 `NEXT_HAND` 将要轮到的座位不一致。
   */
  assert.equal(
    roleSeat.seatId,
    effectiveButtonSeatId(state),
    '庄家位必须落在有效 Button 座位上（修复前会回落到第一个参与者 = 凭空捏造庄家）',
  );
  const utgSeat = state.seats.find((s) => s.logicalPosition === Position.UTG)!;
  assert.notEqual(
    roleSeat.seatId,
    utgSeat.seatId,
    '庄家位不得落在「第一个参与者」座位上（那正是修复前的错误答案）',
  );
});

test('BTN-02：Hero 在 CO 时的角色必须与有效 Button 推导一致（不得被回落规则顶成大盲位）', () => {
  const state = fullTableAt(Position.CO);
  const preview = buildTablePreview(state);
  const heroSeat = preview.seats.find((s) => s.isHero)!;

  /*
   * ⚠️ 不断言「角色名 == 位置名」—— 角色由 Button 决定，与物理位置名本就是两件事
   *（Hero 坐在 CO 座位上，角色可能是 BB）。要断言的是**由有效 Button 推导**：
   * 修复前 Hero 拿到的是「回落规则算出来的」角色，实测就是大盲位。
   */
  const staleButtonSeat = state.seats.find((s) => s.seatId === state.buttonSeatId)!;
  assert.equal(staleButtonSeat.playerId, null, '前置条件：Button 座位确实空了（本用例的前提）');

  assert.ok(heroSeat.handRole !== null, 'Hero 必须有角色');
  assert.equal(
    preview.seats.filter((s) => s.handRole === heroSeat.handRole).length,
    1,
    'Hero 的角色不得与别人重复',
  );
  assert.notEqual(
    heroSeat.handRole,
    Position.BB,
    'Hero 不得被回落规则顶成大盲位（修复前实测如此：Hero 在 CO，却显示大盲位）',
  );
});

/* ============================================================
 * 二、预览与「本手冻结」必须同源
 * ============================================================ */

test('BTN-03：🔴 预览显示的角色必须与**真正开一手**冻结出来的拓扑逐位相同', () => {
  let state = fullTableAt(Position.CO);
  const previewRoles = rolesOfParticipants(state);

  // 开一手（需要 ≥2 名参与者，满桌满足）
  state = must(state, { kind: 'SET_HERO_CARD', card: 'As' });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Kd' });
  assert.equal(state.handActive, true, '前置条件：本手已开始');
  assert.ok(state.handTopology !== null, '本手拓扑必须已冻结');

  const frozenRoles = state.seats
    .filter((s) => state.handTopology!.participantSeatIds.includes(s.seatId))
    .map((s) => POSITION_ZH[state.handTopology!.rolesBySeatId[s.seatId] as Position]);

  assert.deepEqual(
    frozenRoles,
    previewRoles,
    '预览（读路径）与冻结（开手路径）必须给出同一套角色 —— 两处不同源就是本 bug 的根因',
  );
});

/* ============================================================
 * 三、修法本身：状态不得被偷改（否则 NEXT_HAND 会二次轮转）
 * ============================================================ */

test('BTN-04：🔴 清空拿着 Button 的座位**不得**改动 buttonSeatId（轮转仍从旧座位出发）', () => {
  let state = fullTableAt(Position.BTN);
  // 把 Button 交给某个对手（SET_BUTTON 只接受有人且合格的座位）
  const villain = state.seats.find((s) => s.playerId !== null && s.logicalPosition !== Position.BTN)!;
  state = must(state, { kind: 'SET_BUTTON', seatId: villain.seatId });
  const buttonSeatId = state.buttonSeatId;

  const after = must(state, { kind: 'CLEAR_SEAT', seatId: buttonSeatId });
  assert.equal(
    after.buttonSeatId,
    buttonSeatId,
    '状态里的 buttonSeatId 必须保持不动 —— 提前挪动会让 NEXT_HAND 二次轮转，' +
      '中间那位玩家永远拿不到 Button（§4b 的教训）',
  );
  assert.equal(
    after.seats.find((s) => s.seatId === buttonSeatId)!.playerId,
    null,
    '前置条件：那个座位确实被清空了',
  );

  // 但**读**出来的有效 Button 必须已经是下一个合格座位
  assert.notEqual(effectiveButtonSeatId(after), buttonSeatId, '有效 Button 必须换到下一个合格座位');
  const roles = rolesOfParticipants(after).filter((r) => r !== undefined);
  assert.equal(
    new Set(roles).size,
    roles.length,
    `清空之后显示的角色仍不得重复：${roles.join(' / ')}`,
  );
});

test('BTN-05：换桌型把 Button 座位裁掉 ⇒ 不得崩溃，且有效 Button 仍落在合格座位上', () => {
  // 9 人桌：Button 交给 BB 座位，然后缩到 6 人桌（BB 仍在，但换成裁掉 BTN 的场景）
  let state = createTable({ tableSize: 9, heroPosition: Position.BTN });
  state = must(state, { kind: 'FILL_EMPTY_SEATS' });
  const nineSeats = state.seats.map((s) => s.seatId);
  assert.equal(nineSeats.length, 9);
  // 把 Button 放到一个 6 人桌里**不存在**的座位上（9 人桌独有的 UTG1/UTG2/LJ）
  const uniqueTo9 = state.seats.find((s) =>
    ['UTG1', 'UTG2', 'LJ'].includes(s.logicalPosition),
  )!;
  state = must(state, { kind: 'SET_BUTTON', seatId: uniqueTo9.seatId });

  const shrunk = must(state, { kind: 'SET_TABLE_SIZE', tableSize: 6 });
  assert.equal(shrunk.seats.length, 6, '前置条件：已缩到 6 人桌');
  /*
   * ⚠️ 这里**不断言**「状态里的 buttonSeatId 仍然存在」—— 实测它**会**指向一个
   * 已被裁掉的座位（换桌型不重映射它）。这正是必须走「有效 Button」读取的原因：
   * 状态里的 id 允许失效，而**读出来的**那个必须永远有效。
   */
  assert.ok(
    !shrunk.seats.some((s) => s.seatId === shrunk.buttonSeatId),
    '前置条件：Button 确实指向了一个已被裁掉的座位（本用例的前提）',
  );

  const effective = shrunk.seats.find((s) => s.seatId === effectiveButtonSeatId(shrunk));
  assert.ok(effective !== undefined, '有效 Button 必须指向一个真实存在的座位');
  assert.notEqual(effective!.playerId, null, '有效 Button 必须落在**有人**的座位上');

  const roles = rolesOfParticipants(shrunk);
  assert.equal(new Set(roles).size, roles.length, `角色不得重复：${roles.join(' / ')}`);
});
