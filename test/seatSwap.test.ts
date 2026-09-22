/**
 * 座位对调语义 —— 使用者报告的永久回归测试
 *
 * ## 使用者报告的形态
 *
 * > 「6 人桌点击我的头像设置为 UTG，头像那却显示 BB」
 *
 * ## 根因（三层，缺一条都复现不出来）
 *
 * ```text
 * 1. setHeroPosition 把 Hero 的原座位**腾空**，并把目标座位上的人**解绑**
 *    ⇒ 满座 6 人桌「BTN → UTG」之后只剩 5 人本手
 * 2. 被腾空的座位正好是 Button 座位 ⇒ 有效 Button 顺时针浮到 SB 座
 * 3. 角色重算：Button 在 SB 座 ⇒ UTG 座的角色是**大盲位**
 *    ⇒ 头像标着「大盲位（BB）」，而顶栏写着「Hero 在 UTG」
 * ```
 *
 * 修法：**换位 = 两个人对调座位**（`setHeroPosition`），不产生空座位
 * ⇒ Button 不悬空 ⇒ 每个人的本手角色等于他坐的座位名。
 *
 * ## 本文件锁住的两组东西
 *
 * | 组 | 内容 |
 * |---|---|
 * | 语义 | 对调后：玩家数不变、空位数不变、桌上筹码总数不变、Button 不浮动、无角色重复 |
 * | 可见行为 | 与使用者报告逐字对应的界面标签（UTG 座位必须显示「枪口位」而不是「大盲位」） |
 *
 * ⚠️ 另一条容易搞反的语义：**筹码跟着座位走**（物理换座）。
 * 断言写的是「Hero 到新座位拿到**那个座位**的筹码」，与
 * `test/interactiveTableRedteam.test.ts` 的 RT-L3 一起构成完整口径。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position } from '../src/domain/types.ts';
import { createTable, effectiveButtonSeatId, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import { POSITION_ZH } from '../src/app/manualInput/manualInput.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';

function must(state: PokerTableState, op: TableOp): PokerTableState {
  const out = applyTableOp(state, op);
  assert.equal(out.ok, true, `${op.kind} 必须成功：${out.ok ? '' : JSON.stringify(out.issues)}`);
  if (!out.ok) throw new Error('unreachable');
  return out.state;
}

/** 满座桌（Hero 先坐 BTN，一键补齐，再换到 `heroPosition`） */
function fullTableAt(tableSize: 6 | 9, heroPosition: Position): PokerTableState {
  let s = createTable({ tableSize, heroPosition: Position.BTN });
  s = must(s, { kind: 'FILL_EMPTY_SEATS' });
  if (heroPosition !== Position.BTN) {
    s = must(s, { kind: 'SET_HERO_POSITION', position: heroPosition });
  }
  return s;
}

const occupiedSeats = (state: PokerTableState) =>
  state.seats.filter((s) => s.playerId !== null);
const emptySeatCount = (state: PokerTableState) =>
  state.seats.filter((s) => s.playerId === null).length;
const chipTotal = (state: PokerTableState) =>
  Number(state.seats.reduce((sum, s) => sum + s.stackBB, 0).toFixed(6));

/** 某座位上的人（null = 空座） */
const playerAtPosition = (state: PokerTableState, position: Position): string | null =>
  seatOfPosition(state, position)?.playerId ?? null;

/* ============================================================
 * 一、语义：对调之后三条不变量 + Button 不浮动
 * ============================================================ */

test('SWAP-01：满座换位必须**对调** —— 玩家数 / 空位数 / 筹码总数三者逐位不变', () => {
  const before = fullTableAt(6, Position.BTN);
  const after = must(before, { kind: 'SET_HERO_POSITION', position: Position.UTG });

  assert.equal(occupiedSeats(after).length, 6, '6 人桌满座对调后仍必须是 6 个座位上有人');
  assert.equal(emptySeatCount(after), 0, '对调不得产生空座位');
  assert.equal(
    chipTotal(after),
    chipTotal(before),
    '对调不得让桌上筹码总数变化（筹码跟着座位走，不跟着人走）',
  );
  assert.equal(
    Object.keys(after.playersById).length,
    Object.keys(before.playersById).length,
    '玩家对象数量不得变化（没有人被删除）',
  );
});

test('SWAP-02：🔴 Button 不得因为换位而「浮」到别人手里（旧实现的直接后果）', () => {
  const before = fullTableAt(6, Position.BTN);
  assert.equal(before.buttonSeatId, 'seat_BTN', '前置条件：Button 在 Hero 坐的 BTN 座位');

  const after = must(before, { kind: 'SET_HERO_POSITION', position: Position.UTG });

  assert.equal(
    effectiveButtonSeatId(after),
    'seat_BTN',
    'Button 座位必须仍有人拿着（对调把原来的 Hero 换成了另一位玩家）—— ' +
      '有效 Button 一旦浮动，Hero 的角色就不再等于他选的座位名',
  );
  assert.notEqual(
    playerAtPosition(after, Position.BTN),
    null,
    'Button 座位上必须仍有人（旧实现会把它腾空）',
  );
});

test('SWAP-03：无人拿两份角色 —— 对调后角色必须仍然「不重不漏」', () => {
  for (const tableSize of [6, 9] as const) {
    const state = fullTableAt(tableSize, Position.UTG);
    const preview = buildTablePreview(state);
    const roles = preview.seats
      .filter((s) => s.isParticipant)
      .map((s) => s.handRole);

    assert.equal(
      roles.length,
      occupiedSeats(state).length,
      `${tableSize} 人桌：参与者数量必须等于有人座位数`,
    );
    assert.equal(
      new Set(roles).size,
      roles.length,
      `${tableSize} 人桌：角色不得重复（${roles.join(' / ')}）`,
    );
    assert.equal(
      roles.filter((r) => r === Position.BTN).length,
      1,
      `${tableSize} 人桌：必须恰好一个庄家位`,
    );
  }
});

test('SWAP-04：对调是**双向**的 —— 被换的人坐到 Hero 原来的座位，带不走自己的筹码', () => {
  let state = fullTableAt(6, Position.BTN);
  // Hero(BTN)=250BB，UTG 座位上的人=33BB
  state = must(state, { kind: 'SET_STACK', seatId: 'seat_BTN', stackBB: 250 });
  state = must(state, { kind: 'SET_STACK', seatId: 'seat_UTG', stackBB: 33 });
  const displacedPlayerId = playerAtPosition(state, Position.UTG)!;
  assert.notEqual(displacedPlayerId, state.heroPlayerId);

  const moved = must(state, { kind: 'SET_HERO_POSITION', position: Position.UTG });

  assert.equal(playerAtPosition(moved, Position.UTG), moved.heroPlayerId, 'Hero 必须在 UTG 座位');
  assert.equal(
    playerAtPosition(moved, Position.BTN),
    displacedPlayerId,
    '被换的人必须坐到 Hero 原来的 BTN 座位（而不是被解绑消失）',
  );
  assert.equal(
    seatOfPosition(moved, Position.UTG)!.stackBB,
    33,
    '筹码跟着**座位**走：Hero 到 UTG 拿到的是该座位原有的 33BB（物理换座）',
  );
  assert.equal(
    seatOfPosition(moved, Position.BTN)!.stackBB,
    250,
    '被换的人到 BTN 拿到的是该座位原有的 250BB —— 筹码没有凭空增减',
  );
});

/* ============================================================
 * 二、可见行为：使用者报告的那一幕（逐字对应）
 * ============================================================ */

test('SWAP-05：🔴 6 人桌把 Hero 设为 UTG 后，UTG 座位的标签必须是「枪口位」而不是「大盲位」', () => {
  const state = fullTableAt(6, Position.BTN);
  const moved = must(state, { kind: 'SET_HERO_POSITION', position: Position.UTG });
  const preview = buildTablePreview(moved);

  const heroSeat = preview.seats.find((s) => s.isHero)!;
  assert.equal(heroSeat.logicalPosition, Position.UTG, '前置条件：Hero 坐在 UTG 座位');
  assert.equal(heroSeat.visualIndex, 0, 'Hero 必须固定在正下方（视觉序号 0）');

  assert.equal(
    heroSeat.handRole,
    Position.UTG,
    `使用者报告：Hero 在 UTG 座位却显示「${POSITION_ZH[heroSeat.handRole as Position] ?? String(heroSeat.handRole)}」。` +
      '对调修复后角色必须等于他坐的座位名',
  );
  assert.equal(heroSeat.handRoleZh, POSITION_ZH[Position.UTG]);

  // 界面画的整行标签（`table.js` 的 roleText）必须与之一致
  const roleText = heroSeat.handRoleZh + '（' + heroSeat.handRole + '）';
  assert.equal(roleText, '枪口位（UTG）', `头像那行必须显示「枪口位（UTG）」，实际「${roleText}」`);
});

test('SWAP-06：9 人桌同样成立（UTG / CO / BB 三个位置都验）', () => {
  for (const target of [Position.UTG, Position.CO, Position.BB] as const) {
    const state = fullTableAt(9, Position.BTN);
    const moved = must(state, { kind: 'SET_HERO_POSITION', position: target });
    const heroSeat = buildTablePreview(moved).seats.find((s) => s.isHero)!;

    assert.equal(
      heroSeat.handRole,
      target,
      `9 人桌：Hero 坐到 ${target} 座位后角色必须是 ${target}，实际 ${String(heroSeat.handRole)}`,
    );
    assert.equal(emptySeatCount(moved), 0, `9 人桌：换到 ${target} 后不得出现空座位`);
  }
});

test('SWAP-07：每个位置都必须「角色 = 座位名」（满座下逐位遍历，6/9 人桌）', () => {
  for (const tableSize of [6, 9] as const) {
    const positions = createTable({ tableSize }).seats.map((s) => s.logicalPosition);
    for (const target of positions) {
      const state = fullTableAt(tableSize, Position.BTN);
      if (target === Position.BTN) continue; // 没有换位动作
      const moved = must(state, { kind: 'SET_HERO_POSITION', position: target });
      const heroSeat = buildTablePreview(moved).seats.find((s) => s.isHero)!;
      assert.equal(
        heroSeat.handRole,
        target,
        `${tableSize} 人桌 / ${target}：角色必须是座位名（顶栏与头像不得打架）`,
      );
    }
  }
});

/* ============================================================
 * 三、空座位分支仍沿用旧语义（搬过去 + 自己原座位腾空）
 * ============================================================ */

test('SWAP-08：目标座位空着 ⇒ Hero 搬过去、原座位腾空，且不凭空造人', () => {
  // Hero 在 BTN、其余座位全空
  const lone = createTable({ tableSize: 6, heroPosition: Position.BTN });
  assert.equal(occupiedSeats(lone).length, 1);

  const moved = must(lone, { kind: 'SET_HERO_POSITION', position: Position.UTG });
  assert.equal(playerAtPosition(moved, Position.UTG), moved.heroPlayerId, 'Hero 必须搬到 UTG');
  assert.equal(playerAtPosition(moved, Position.BTN), null, '原 BTN 座位必须腾空');
  assert.equal(occupiedSeats(moved).length, 1, '不得凭空多出玩家');
  assert.equal(
    Object.keys(moved.playersById).length,
    1,
    '玩家对象数量不变（只有 Hero）',
  );
});

test('SWAP-09：空座位分支下 Hero 的筹码跟着他走（无对调对象时不存在归属歧义）', () => {
  let lone = createTable({ tableSize: 6, heroPosition: Position.BTN });
  lone = must(lone, { kind: 'SET_STACK', seatId: 'seat_BTN', stackBB: 210 });
  const moved = must(lone, { kind: 'SET_HERO_POSITION', position: Position.UTG });
  assert.equal(
    seatOfPosition(moved, Position.UTG)!.stackBB,
    210,
    '目标座位是空座时筹码不能被默认值顶掉（默认 100BB 是给「下一位新玩家」的）',
  );
});

/* ============================================================
 * 四、对调之后仍然自洽：能开手、能分析、能撤销
 * ============================================================ */

test('SWAP-10：对调后开一手，冻结拓扑与预览标签必须同源（不得两处各算一套）', () => {
  let state = fullTableAt(6, Position.BTN);
  state = must(state, { kind: 'SET_HERO_POSITION', position: Position.UTG });
  const previewRoles = buildTablePreview(state)
    .seats.filter((s) => s.handRole !== null)
    .map((s) => `${s.seatId}:${s.handRole}`);

  state = must(state, { kind: 'SET_HERO_CARD', card: 'As' });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Kd' });
  assert.equal(state.handActive, true, '前置条件：本手已开始');
  assert.ok(state.handTopology !== null, '本手拓扑必须已冻结');

  const frozenRoles = state.seats
    .filter((s) => state.handTopology!.participantSeatIds.includes(s.seatId))
    .map((s) => `${s.seatId}:${state.handTopology!.rolesBySeatId[s.seatId]}`);

  assert.deepEqual(frozenRoles, previewRoles, '预览（读）与冻结（开手）必须给出同一套角色');
});

test('SWAP-11：对调可被一次「撤销」完整退回（含玩家座位与筹码）', () => {
  let state = fullTableAt(6, Position.BTN);
  state = must(state, { kind: 'SET_STACK', seatId: 'seat_BTN', stackBB: 250 });
  state = must(state, { kind: 'SET_STACK', seatId: 'seat_UTG', stackBB: 33 });
  const before = state.seats.map((s) => `${s.logicalPosition}:${s.playerId ?? '-'}:${s.stackBB}`);

  state = must(state, { kind: 'SET_HERO_POSITION', position: Position.UTG });
  state = must(state, { kind: 'UNDO' });

  assert.equal(state.heroPosition, Position.BTN, '撤销后 Hero 必须回到 BTN');
  assert.deepEqual(
    state.seats.map((s) => `${s.logicalPosition}:${s.playerId ?? '-'}:${s.stackBB}`),
    before,
    '撤销必须逐位还原座位绑定与筹码',
  );
});
