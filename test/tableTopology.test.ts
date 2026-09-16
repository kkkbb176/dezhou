/**
 * Table Topology Correction —— 桌型拓扑回归测试
 *
 * ## 这个文件钉住的是什么
 *
 * **Table Capacity ≠ Handedness**：牌桌有几个座位（容量）与本手发几份牌
 * （人数）是两个独立的数字。修复前全项目把它们当成同一个，
 * 于是「9 座桌 8 个人」这种现金局最常见的形态**根本发不出牌**。
 *
 * 这个文件与 `tableTopology.property.test.ts` 的分工：
 *
 * | 文件 | 覆盖方式 |
 * |---|---|
 * | `tableTopology.property.test.ts` | **穷举 + 随机**（9,481 组拓扑组合、5,551 组 Button 轮转） |
 * | **本文件** | **黄金用例 + 产品路径**（界面点得出来吗、端到端能分析吗） |
 *
 * 两者缺一不可：属性测试证明「所有组合都成立」，黄金用例证明
 * 「真实使用路径走得通」。修复过程中出现过的**头号缺陷形态**是
 * 「域层修好了、表层把它拦回来」—— 只有走产品路径的测试能发现它。
 *
 * ## 六条铁律（§142）
 *
 * 1. Table Capacity ≠ Handedness
 * 2. Seat ≠ Player
 * 3. Seat ≠ Position
 * 4. Table State ≠ Hand State
 * 5. Unacted Player ≠ Realized Multiway Opponent
 * 6. 已发生的 Current Hand 事实不可被座位生命周期修改
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position, Street } from '../src/domain/types.ts';
import {
  CANONICAL_ROLES,
  canonicalRolesOf,
  handTopologySeats,
  occupiedSeatIndices,
} from '../src/domain/poker/positions.ts';
import { createGame, stateTopology, streetOrder } from '../src/domain/poker/gameState.ts';
import { validateGameState } from '../src/domain/poker/validator.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { decideAlpha } from '../src/app/decision/decisionEngine.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { playerById } from '../src/domain/poker/gameState.ts';
import {
  buildAnalyzableState,
  reconstructGameState,
  ReconstructMode,
} from '../src/app/manualInput/reconstruct.ts';
import {
  parseManualInput,
  type ManualHandInput,
} from '../src/app/manualInput/manualInput.ts';
import {
  advanceButtonSeatId,
  createTable,
  handTopologyOf,
  participantSeatsOf,
  seatById,
  seatOfPosition,
  staffingNotices,
  staffingProblems,
} from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import { tableStateToManualHandInput } from '../src/app/table/tableAdapter.ts';
import { handleTableRequest, RevisionGuard } from '../src/app/table/tableApi.ts';
import { SeatStatus, type PokerTableState, type TableOp } from '../src/app/table/table.types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
/**
 * 决策管线选项。
 *
 * ⚠️ `environment` 必须与牌桌状态里的取值一致 —— 它是**输入证据**的一部分
 * （`contextBuilder` 会把它记进 `EnvironmentSnapshot`）。
 * 本文件的牌桌一律用 `createTable` 的默认环境，因此这里显式写同一个值，
 * 避免「测试传 A、牌桌是 B」这种两边不一致的假绿。
 */
const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  environment: 'LOW_STAKES_ONLINE',
} as const;

const RING_9: readonly Position[] = [
  Position.UTG,
  Position.UTG1,
  Position.UTG2,
  Position.LJ,
  Position.HJ,
  Position.CO,
  Position.BTN,
  Position.SB,
  Position.BB,
];

const RING_6: readonly Position[] = [
  Position.UTG,
  Position.HJ,
  Position.CO,
  Position.BTN,
  Position.SB,
  Position.BB,
];

const ZH: Readonly<Record<string, string>> = Object.freeze({
  UTG: '枪口位',
  UTG1: '枪口+1',
  UTG2: '枪口+2',
  LJ: '低劫持',
  HJ: '劫持位',
  CO: '关煞位',
  BTN: '庄家位',
  SB: '小盲位',
  BB: '大盲位',
});

/* ============================================================
 * 驱动辅助
 * ============================================================ */

function must(result: ReturnType<typeof applyTableOp>): PokerTableState {
  if (!result.ok) {
    throw new Error(`操作被拒绝：${result.issues.map((i) => i.message).join(' / ')}`);
  }
  return result.state;
}

function drive(start: PokerTableState, ops: readonly TableOp[]): PokerTableState {
  let state = start;
  for (const op of ops) state = must(applyTableOp(state, op));
  return state;
}

const preview = (state: PokerTableState) => buildTablePreview(state);

/**
 * 建一张牌桌，**只**给 `occupied` 里的座位加入玩家。
 *
 * ⚠️ 刻意不提供「坐满」的默认值：本文件测的就是「不坐满」。
 */
function tableOf(
  capacity: 6 | 9,
  occupied: readonly Position[],
  heroPosition: Position,
): PokerTableState {
  let state = createTable({ tableSize: capacity, heroPosition });
  for (const position of occupied) {
    if (position === heroPosition) continue;
    state = must(applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, position)!.seatId }));
  }
  return state;
}

function heroCards(state: PokerTableState): PokerTableState {
  return drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
}

/** 一直录入当前行动者的动作，直到轮到 Hero（或无法继续） */
function driveToHeroTurn(
  state: PokerTableState,
  choose: (type: string) => string = () => 'FOLD',
): PokerTableState {
  let current = state;
  for (let step = 0; step < 40; step += 1) {
    const p = preview(current);
    if (p.isHeroTurn || p.currentActorPosition === null || p.handComplete) return current;
    const want = choose(p.currentActorPosition);
    const button = p.actionButtons.find((b) => b.type === want && b.group !== 'EXPAND');
    if (button === undefined) return current;
    current = must(
      applyTableOp(current, {
        kind: 'ACT',
        action: {
          type: button.type,
          ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
        },
      }),
    );
  }
  return current;
}

/** 点的按钮（用于「界面 → 后端」健全性检查） */
function clickAction(state: PokerTableState, type: string, sizeIndex = 0): PokerTableState {
  const p = preview(state);
  const sized = p.actionButtons.filter((b) => b.type === type && b.group === 'SIZE');
  const primary = p.actionButtons.filter((b) => b.type === type && b.group === 'PRIMARY');
  const pool = sized.length > 0 ? sized : primary;
  const button = pool[sizeIndex] ?? pool[0];
  assert.ok(
    button !== undefined,
    `预览里应当有「${type}」按钮，实际：${
      p.actionButtons.map((b) => `${b.type}/${b.group}`).join(' / ') || '（无）'
    }`,
  );
  return must(
    applyTableOp(state, {
      kind: 'ACT',
      action: {
        type: button.type,
        ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
      },
    }),
  );
}

/* ============================================================
 * §1 🔴 头号 Bug：9 座桌 8 人必须真的可分析
 * ============================================================ */

test('§1 9 座桌 8 人（空 UTG2）：空座位不得阻断分析，且必须如实告知本手人数', () => {
  const occupied = RING_9.filter((p) => p !== Position.UTG2);
  let state = tableOf(9, occupied, Position.CO);

  // ---- 参与者 = 8，空座 = UTG2 ----
  const participants = participantSeatsOf(state).map((s) => s.logicalPosition);
  assert.equal(participants.length, 8, `本手必须 8 人，实际 ${participants.length}`);
  assert.ok(!participants.includes(Position.UTG2), '空座位不得出现在参与者里');

  // ---- 人员判据：**空座位不是阻断项** ----
  assert.deepEqual(
    staffingProblems(state),
    [],
    '空座位不得产生任何阻断 —— 6 座以上的桌子少一个人是常态',
  );
  const notices = staffingNotices(state);
  assert.ok(
    notices.some((n) => n.includes('本手 8 人参与') && n.includes('枪口+2')),
    `必须如实告知「本手 8 人参与、枪口+2 不发牌」，实际：${notices.join(' / ')}`,
  );

  // ---- 走到 Hero 回合，然后必须**真的能分析** ----
  state = heroCards(state);
  state = driveToHeroTurn(state);
  const p = preview(state);
  assert.equal(p.isHeroTurn, true, `必须轮到 Hero，实际轮到 ${String(p.currentActorPosition)}`);
  assert.deepEqual(
    p.analyzeBlockers,
    [],
    `9 座桌 8 人轮到 Hero 时不得有任何阻塞，实际：${p.analyzeBlockers.join(' / ')}`,
  );
  assert.equal(p.canAnalyze, true, '9 座桌 8 人必须可分析');
  assert.equal(p.issues.length, 0, `不得有结构性 issue：${JSON.stringify(p.issues)}`);

  // ---- 拓扑：容量 9、本手 8（**两个数字都在**）----
  assert.notEqual(p.handTopology, null, '预览必须暴露 handTopology');
  const t = p.handTopology!;
  assert.equal(t.tableCapacity, 9, '拓扑必须记住座位容量');
  assert.equal(t.handedness, 8, '拓扑必须记住本手人数');
  assert.equal(t.participantSeatIds.length, 8, '拓扑参与者必须是 8 个座位');
  assert.ok(
    !t.participantSeatIds.includes('seat_UTG2'),
    '空座位不得出现在拓扑参与者里',
  );

  // ---- 适配器：occupiedPositions / buttonPosition 必须真的被填上 ----
  const adapted = tableStateToManualHandInput(state);
  assert.equal(adapted.ok, true, '适配必须成功');
  if (!adapted.ok) return;
  assert.equal(adapted.input.tableSize, 9, '容量必须是 9');
  assert.equal(adapted.input.occupiedPositions?.length, 8, 'occupiedPositions 必须是 8 个座位');
  assert.ok(
    !adapted.input.occupiedPositions?.includes(Position.UTG2),
    'occupiedPositions 不得包含空座位',
  );
  assert.equal(adapted.input.buttonPosition, Position.BTN, 'buttonPosition 必须来自状态');
});

test('§1b 9 座桌 8 人：空座位的**位置**不影响正确性（逐个座位扫一遍）', () => {
  for (const empty of RING_9) {
    const occupied = RING_9.filter((p) => p !== empty);
    // Hero 不能坐在空座位上
    const hero = occupied.includes(Position.CO) ? Position.CO : occupied[0]!;
    const state = heroCards(tableOf(9, occupied, hero));

    const p = preview(state);
    assert.equal(
      staffingProblems(state).length,
      0,
      `空座位 ${empty}（${ZH[empty]}）不得阻断分析`,
    );
    assert.equal(p.handTopology?.handedness, 8, `空 ${empty} 时本手人数必须是 8`);

    // 8 人桌上每个参与者都必须拿到角色，且角色不重复
    const roles = Object.values(p.handTopology!.rolesBySeatId);
    assert.equal(roles.length, 8, `空 ${empty} 时必须有 8 个角色，实际 ${roles.length}`);
    assert.equal(new Set(roles).size, 8, `空 ${empty} 时角色必须互不重复：${roles.join(',')}`);
    assert.deepEqual(
      [...roles].sort(),
      [...canonicalRolesOf(8)].sort(),
      `空 ${empty} 时的角色表必须等于 canonicalRolesOf(8)`,
    );
    assert.ok(
      roles.includes(Position.BTN) && roles.includes(Position.SB) && roles.includes(Position.BB),
      `空 ${empty} 时 BTN/SB/BB 必须都在`,
    );
  }
});

/* ============================================================
 * §2 头号 Bug 的**反证**：修复前它必须是被拦住的
 * ============================================================ */

test('§2 反证：域层与表层必须一致 —— 域层不拒绝时表层也不得拒绝', () => {
  /*
   * 这条测试存在的理由：本轮修复过程中出现过的头号缺陷形态是
   * 「域层放行了 8/9，表层 `staffingProblems` 又拦回来」。
   * 单测任何一层都发现不了它，必须**同时**断言两层。
   */
  const occupied = RING_9.filter((p) => p !== Position.UTG2);
  const state = heroCards(tableOf(9, occupied, Position.CO));

  const adapted = tableStateToManualHandInput(state);
  assert.equal(adapted.ok, true, '适配器不得拒绝（这是域层能否建局的前置）');
  if (!adapted.ok) return;
  const parsed = parseManualInput(adapted.input);
  assert.equal(parsed.ok, true, `解析不得拒绝：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
  if (!parsed.ok) return;
  const rebuilt = reconstructGameState(parsed.value, { mode: ReconstructMode.PREVIEW });
  assert.equal(
    rebuilt.ok,
    true,
    `域层必须能建出 8 人牌局：${rebuilt.ok ? '' : JSON.stringify(rebuilt.issues)}`,
  );
  if (!rebuilt.ok) return;
  assert.equal(rebuilt.state.players.length, 8, '引擎里必须正好 8 位玩家');
  assert.equal(
    validateGameState(rebuilt.state).blocked,
    false,
    '校验器不得判 8/9 为非法',
  );
});

/* ============================================================
 * §3 容量 × 本手人数：9 座与 6 座的每一个人数都能建局
 * ============================================================ */

test('§3 9 座桌 2~9 人、6 座桌 2~6 人：每一种本手人数都必须能建局并给出正确盲注', () => {
  const cases: readonly { capacity: 6 | 9; ring: readonly Position[] }[] = [
    { capacity: 9, ring: RING_9 },
    { capacity: 6, ring: RING_6 },
  ];

  for (const { capacity, ring } of cases) {
    for (let n = 2; n <= capacity; n += 1) {
      // 取座位环上的最后 n 个（含 BB，最像「前位有人离桌」的真实形态）
      const occupied = ring.slice(ring.length - n);
      const button = occupied[Math.max(0, occupied.length - 3)]!;
      const hero = occupied[0]!;

      const parsed = parseManualInput({
        tableSize: capacity,
        heroPosition: hero,
        heroCards: ['As', 'Kd'],
        board: [],
        street: 'PREFLOP',
        effectiveStackBB: 100,
        actionHistory: [],
        environment: 'LOW_STAKES_ONLINE',
        occupiedPositions: occupied,
        buttonPosition: button,
      });
      assert.equal(
        parsed.ok,
        true,
        `${capacity} 座 ${n} 人解析失败：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`,
      );
      if (!parsed.ok) continue;
      assert.equal(parsed.value.handedness, n, `${capacity} 座 ${n} 人：handedness 必须等于 ${n}`);

      const rebuilt = reconstructGameState(parsed.value, { mode: ReconstructMode.PREVIEW });
      assert.equal(
        rebuilt.ok,
        true,
        `${capacity} 座 ${n} 人建局失败：${rebuilt.ok ? '' : JSON.stringify(rebuilt.issues)}`,
      );
      if (!rebuilt.ok) continue;

      assert.equal(rebuilt.state.players.length, n, `${capacity} 座 ${n} 人：引擎玩家数必须是 ${n}`);
      const topo = stateTopology(rebuilt.state);
      assert.equal(topo.handedness, n, `拓扑 handedness 必须是 ${n}`);

      // 盲注必须落在真实的 SB / BB 座位上，且金额正确
      const indexOf = (position: Position): number => ring.indexOf(position);
      const sb = rebuilt.state.players.find(
        (p) => indexOf(p.position) === topo.smallBlindSeatIndex,
      );
      const bb = rebuilt.state.players.find(
        (p) => indexOf(p.position) === topo.bigBlindSeatIndex,
      );
      assert.ok(sb !== undefined, `${capacity} 座 ${n} 人：找不到小盲玩家`);
      assert.ok(bb !== undefined, `${capacity} 座 ${n} 人：找不到大盲玩家`);
      assert.equal(sb!.committedByStreet.PREFLOP, 50, `${capacity} 座 ${n} 人：小盲必须下 50`);
      assert.equal(bb!.committedByStreet.PREFLOP, 100, `${capacity} 座 ${n} 人：大盲必须下 100`);
      assert.equal(
        rebuilt.state.currentBet,
        100,
        `${capacity} 座 ${n} 人：currentBet 必须是大盲 100`,
      );
      // 单挑时 Button 本人就是小盲
      if (n === 2) {
        assert.equal(
          topo.smallBlindSeatIndex,
          topo.buttonSeatIndex,
          '单挑：Button 本人必须是小盲',
        );
        assert.equal(topo.buttonAlsoPostsSmallBlind, true, '单挑：必须标记 Button 下小盲');
      } else {
        assert.notEqual(
          topo.smallBlindSeatIndex,
          topo.buttonSeatIndex,
          `${n} 人：小盲不得等于 Button`,
        );
        assert.equal(topo.buttonAlsoPostsSmallBlind, false, `${n} 人：Button 不下小盲`);
      }
    }
  }
});

test('§3b 非连续空位：9 座桌 7 人、HJ 与 CO 都空 —— 盲注与角色仍然正确', () => {
  const occupied = RING_9.filter((p) => p !== Position.HJ && p !== Position.CO);
  const parsed = parseManualInput({
    tableSize: 9,
    heroPosition: Position.UTG,
    heroCards: ['As', 'Kd'],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: 100,
    actionHistory: [],
    environment: 'LOW_STAKES_ONLINE',
    occupiedPositions: occupied,
    buttonPosition: Position.BTN,
  });
  assert.equal(parsed.ok, true, `解析失败：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
  if (!parsed.ok) return;

  const rebuilt = reconstructGameState(parsed.value, { mode: ReconstructMode.PREVIEW });
  assert.equal(rebuilt.ok, true, `建局失败：${rebuilt.ok ? '' : JSON.stringify(rebuilt.issues)}`);
  if (!rebuilt.ok) return;

  const topo = stateTopology(rebuilt.state);
  assert.equal(topo.handedness, 7, '本手必须 7 人');
  assert.equal(RING_9[topo.smallBlindSeatIndex], Position.SB, '小盲必须落在真实的小盲座位');
  assert.equal(RING_9[topo.bigBlindSeatIndex], Position.BB, '大盲必须落在真实的大盲座位');
  assert.equal(RING_9[topo.buttonSeatIndex], Position.BTN, 'Button 必须落在真实的庄家座位');

  // 空座位绝不能拿到任何角色
  const rolePositions = Object.keys(topo.roleBySeatIndex).map((k) => RING_9[Number(k)]!);
  assert.ok(!rolePositions.includes(Position.HJ), '空座位 HJ 不得拿到角色');
  assert.ok(!rolePositions.includes(Position.CO), '空座位 CO 不得拿到角色');
  assert.equal(new Set(rolePositions).size, 7, '角色必须恰好 7 个且互不重复');
});

/* ============================================================
 * §4 Button 轮转（多手）
 * ============================================================ */

test('§4 Button 轮转 200 手：每一手都必须落在有人的座位上，且相邻两手不重复', () => {
  const occupied = RING_9.filter((p) => p !== Position.UTG2 && p !== Position.LJ);
  let state = tableOf(9, occupied, Position.CO);

  const seen: string[] = [];
  for (let hand = 0; hand < 200; hand += 1) {
    const eligible = participantSeatsOf(state).map((s) => s.seatId);
    const current = state.buttonSeatId;
    assert.ok(
      eligible.includes(current),
      `第 ${hand + 1} 手：Button 座位 ${current} 必须是有人的座位（合格座位：${eligible.join(',')}）`,
    );
    seen.push(current);

    state = must(applyTableOp(state, { kind: 'NEXT_HAND' }));
    if (hand > 0) {
      assert.notEqual(seen[hand], seen[hand - 1], '相邻两手的 Button 不得是同一个人');
    }
  }

  // 合格座位恰好 7 个 → 200 手必然绕满整数倍的轮次
  assert.equal(new Set(seen).size, 7, `Button 必须覆盖全部 7 个合格座位，实际 ${new Set(seen).size} 个`);
  assert.equal(state.handsCompleted, 200, '必须记满 200 手');
});

test('§4b 座位中途离桌：Button 轮转必须跳过空座位，且从**旧 Button 座位**继续', () => {
  const occupied = RING_9.filter((p) => p !== Position.UTG2);
  let state = tableOf(9, occupied, Position.CO);

  // 一手一手推进，在第 5 手把当下的 Button 本人清掉
  for (let i = 0; i < 5; i += 1) state = must(applyTableOp(state, { kind: 'NEXT_HAND' }));
  const buttonSeatId = state.buttonSeatId;
  const buttonPosition = seatById(state, buttonSeatId)!.logicalPosition;
  const ringIndex = RING_9.indexOf(buttonPosition);

  state = must(applyTableOp(state, { kind: 'CLEAR_SEAT', seatId: buttonSeatId }));
  assert.equal(seatById(state, buttonSeatId)!.playerId, null, 'Button 座位必须被清空');

  const before = state.buttonSeatId;
  state = must(applyTableOp(state, { kind: 'NEXT_HAND' }));

  // 下一个合格座位 = 从旧 Button 座位顺时针找到的第一个有人座位
  let expected: Position | null = null;
  for (let step = 1; step <= RING_9.length; step += 1) {
    const candidate = RING_9[(ringIndex + step) % RING_9.length]!;
    const seat = seatOfPosition(state, candidate);
    if (seat !== undefined && seat.playerId !== null) {
      expected = candidate;
      break;
    }
  }
  assert.notEqual(expected, null, '必须能找到一个合格的下一家');
  assert.equal(
    seatById(state, state.buttonSeatId)!.logicalPosition,
    expected,
    `Button 必须从旧座位 ${before} 继续顺时针轮到 ${String(expected)}`,
  );
});

test('§4c 合格座位不足 2 个：Button 不动，且人员判据如实报告', () => {
  // 9 座桌只坐 1 个人
  const alone = tableOf(9, [Position.BTN], Position.BTN);
  assert.equal(participantSeatsOf(alone).length, 1, '必须只有 1 个合格座位');
  assert.ok(
    staffingProblems(alone).some((p) => p.includes('至少要 2 个人')),
    `1 个人必须被如实拒绝：${staffingProblems(alone).join(' / ')}`,
  );
  assert.equal(
    advanceButtonSeatId(alone),
    alone.buttonSeatId,
    '没有其他合格座位时 Button 不得乱动',
  );
});

/* ============================================================
 * §5 单挑（2 人）
 * ============================================================ */

test('§5 单挑位置名必须是 BTN/BB —— SB 不得覆盖 Button（§83 缺陷 1 回归）', () => {
  for (const capacity of [6, 9] as const) {
    const ring = capacity === 6 ? RING_6 : RING_9;
    for (const button of ring) {
      // 单挑的另一个座位：Button 顺时针的下一位
      const buttonIndex = ring.indexOf(button);
      const other = ring[(buttonIndex + 1) % ring.length]!;
      const topo = handTopologySeats(capacity, [button, other], button);

      const roles = Object.values(topo.roleBySeatIndex);
      assert.equal(roles.length, 2, `${capacity} 座 Button=${button}：单挑必须恰好 2 个角色`);
      assert.deepEqual(
        [...roles].sort(),
        [...canonicalRolesOf(2)].sort(),
        `${capacity} 座 Button=${button}：角色表必须等于 canonicalRolesOf(2)=[BTN,BB]，实际 ${JSON.stringify(roles)}`,
      );
      assert.equal(
        topo.roleBySeatIndex[topo.buttonSeatIndex],
        Position.BTN,
        `Button 座位 ${button} 的角色名必须仍是 BTN（不得被 SB 覆盖）`,
      );
      assert.equal(
        topo.roleBySeatIndex[topo.bigBlindSeatIndex],
        Position.BB,
        '另一个座位的角色名必须是 BB',
      );
      // 「Button 下小盲」由座位下标表达，不占用位置名
      assert.equal(topo.smallBlindSeatIndex, topo.buttonSeatIndex, '单挑：小盲座位 = Button 座位');
      assert.equal(topo.buttonAlsoPostsSmallBlind, true, '单挑：必须标记');
    }
  }
});

test('§5b 单挑翻牌后必须**先问大盲**，Button 最后行动（§86 缺陷 2 回归）', () => {
  const state = createGame({
    config: {
      tableSize: 6,
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      dealerPosition: Position.BTN,
    },
    players: [
      { id: 'seat_BTN', name: 'BTN', position: Position.BTN, startingStack: 10000 },
      { id: 'seat_BB', name: 'BB', position: Position.BB, startingStack: 10000 },
    ],
    userPlayerId: 'seat_BTN',
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  // ---- 翻牌前：Button（= 小盲）先行动，大盲最后 ----
  const preflop = streetOrder(state).map((p) => p.position);
  assert.deepEqual(
    preflop,
    [Position.BTN, Position.BB],
    `单挑翻牌前顺序必须是 [BTN, BB]，实际 ${JSON.stringify(preflop)}`,
  );
  assert.equal(state.pendingQueue[0], 'seat_BTN', '翻牌前第一个行动的必须是 Button');

  // ---- 翻牌：大盲先行动 ----
  const flopState: typeof state = {
    ...state,
    street: Street.FLOP,
    board: { flop: [], turn: [], river: [] },
  };
  const postflop = streetOrder(flopState).map((p) => p.position);
  assert.deepEqual(
    postflop,
    [Position.BB, Position.BTN],
    `单挑翻牌后顺序必须是 [BB, BTN]（大盲先、Button 最后），实际 ${JSON.stringify(postflop)}`,
  );
});

test('§5c 单挑可以**完整录入**一手（修复前 BTN CALL / BB CHECK 全被拒）', () => {
  const huInput = (
    actionHistory: readonly unknown[],
    board: readonly string[],
  ): ManualHandInput => ({
    tableSize: 6,
    heroPosition: Position.BTN,
    heroCards: ['As', 'Kd'] as const,
    board: board as unknown as readonly never[],
    street: (board.length >= 3 ? 'FLOP' : 'PREFLOP') as ManualHandInput['street'],
    effectiveStackBB: 100,
    actionHistory: actionHistory as ManualHandInput['actionHistory'],
    environment: 'LOW_STAKES_ONLINE',
    occupiedPositions: [Position.BTN, Position.BB],
    buttonPosition: Position.BTN,
  });

  // 翻牌前：Button 补 0.5BB → 大盲过牌
  const pre = parseManualInput(
    huInput(
      [
        { position: Position.BTN, type: 'CALL', amountBB: 0.5 },
        { position: Position.BB, type: 'CHECK' },
      ],
      [],
    ),
  );
  assert.equal(pre.ok, true, `翻牌前解析失败：${pre.ok ? '' : JSON.stringify(pre.issues)}`);
  if (!pre.ok) return;
  const preState = reconstructGameState(pre.value, { mode: ReconstructMode.PREVIEW });
  assert.equal(
    preState.ok,
    true,
    `单挑翻牌前「Button 跟注 → 大盲过牌」必须被接受：${
      preState.ok ? '' : JSON.stringify(preState.issues)
    }`,
  );

  // 翻牌：大盲先过牌，然后轮到 Button
  const flop = parseManualInput(
    huInput(
      [
        { position: Position.BTN, type: 'CALL', amountBB: 0.5 },
        { position: Position.BB, type: 'CHECK' },
        { position: Position.BB, type: 'CHECK', street: 'FLOP' },
      ],
      ['Ah', '7c', '2d'],
    ),
  );
  assert.equal(flop.ok, true, `翻牌解析失败：${flop.ok ? '' : JSON.stringify(flop.issues)}`);
  if (!flop.ok) return;
  const flopState = reconstructGameState(flop.value, { mode: ReconstructMode.PREVIEW });
  assert.equal(
    flopState.ok,
    true,
    `单挑翻牌「大盲先过牌」必须被接受：${flopState.ok ? '' : JSON.stringify(flopState.issues)}`,
  );

  // 反证：翻牌后先录 Button 必须被拒（否则顺序判据没有约束力）
  const wrong = parseManualInput(
    huInput(
      [
        { position: Position.BTN, type: 'CALL', amountBB: 0.5 },
        { position: Position.BB, type: 'CHECK' },
        { position: Position.BTN, type: 'CHECK', street: 'FLOP' },
      ],
      ['Ah', '7c', '2d'],
    ),
  );
  assert.equal(wrong.ok, true, '反证样本应当能通过解析（校验在重放阶段）');
  if (!wrong.ok) return;
  const wrongState = reconstructGameState(wrong.value, { mode: ReconstructMode.PREVIEW });
  assert.equal(
    wrongState.ok,
    false,
    '单挑翻牌后先录 Button 必须被拒绝 —— 否则「大盲先行动」这条规则没有约束力',
  );
});

test('§5d 单挑的角色表与 CANONICAL_ROLES 一致（穷举 6 座 / 9 座的每一组单挑）', () => {
  assert.deepEqual(CANONICAL_ROLES[2], ['BTN', 'BB'], '单挑规范角色表必须是 [BTN, BB]');
  for (const capacity of [6, 9] as const) {
    const ring = capacity === 6 ? RING_6 : RING_9;
    for (let i = 0; i < ring.length; i += 1) {
      for (let j = 0; j < ring.length; j += 1) {
        if (i === j) continue;
        const topo = handTopologySeats(capacity, [ring[i]!, ring[j]!], ring[i]!);
        assert.deepEqual(
          Object.values(topo.roleBySeatIndex).sort(),
          ['BB', 'BTN'],
          `${capacity} 座 Button=${ring[i]} 对手=${ring[j]}：角色表必须是 BTN + BB`,
        );
      }
    }
  }
});

/* ============================================================
 * §6 已发生事实不可被座位生命周期修改
 * ============================================================ */

test('§6 本手进行中清座位 / 暂离 / 离桌：本手参与者与拓扑快照**不变**', () => {
  const occupied = RING_9.filter((p) => p !== Position.UTG2);
  let state = heroCards(tableOf(9, occupied, Position.CO));
  state = driveToHeroTurn(state);

  const snapshot = handTopologyOf(state);
  assert.notEqual(snapshot, null, '本手进行中必须有冻结的拓扑快照');
  const before = JSON.stringify(snapshot);

  // ---- 本手进行中标记「下一手暂离」----
  const sbSeat = seatOfPosition(state, Position.SB)!;
  const afterSitOut = must(applyTableOp(state, { kind: 'SIT_OUT', seatId: sbSeat.seatId }));
  assert.equal(
    JSON.stringify(handTopologyOf(afterSitOut)),
    before,
    '标记暂离不得改动本手拓扑快照（§142 第 6 条）',
  );
  assert.equal(
    seatOfPosition(afterSitOut, Position.SB)!.status,
    SeatStatus.SEATED_ACTIVE,
    '本手进行中「暂离」只标记，不改状态',
  );

  // ---- 本手进行中清座位：要求明确选择，且选「手后离桌」后快照不变 ----
  const leave = applyTableOp(state, { kind: 'CLEAR_SEAT', seatId: sbSeat.seatId });
  assert.equal(leave.ok, false, '本手进行中直接清空座位必须被拒绝（§8 不许默认猜）');
  if (leave.ok) return;
  assert.notEqual(leave.leaveDecision, undefined, '必须给出离桌选择');

  const marked = must(
    applyTableOp(state, {
      kind: 'CLEAR_SEAT',
      seatId: sbSeat.seatId,
      activeHandChoice: 'LEAVE_AFTER_HAND',
    }),
  );
  assert.equal(
    JSON.stringify(handTopologyOf(marked)),
    before,
    '「手后离桌」不得改动本手拓扑快照',
  );
  assert.notEqual(
    seatOfPosition(marked, Position.SB)!.playerId,
    null,
    '「手后离桌」期间绑定必须保留 —— 本手的事实不能被抹掉',
  );

  // 下一手才真正生效
  const next = must(applyTableOp(marked, { kind: 'NEXT_HAND' }));
  assert.equal(seatOfPosition(next, Position.SB)!.playerId, null, '下一手才真正清空');
  /*
   * ⚠️ 断言的是 **`state.handTopology`**（冻结快照字段），不是 `handTopologyOf()`。
   *
   * `handTopologyOf()` 在快照为空时**会按当前座位现算一个**（只读路径用），
   * 因此它永远不会返回 null。而「本手还没开始」这件事的可观测形式，
   * 恰恰是**快照字段为空**。
   */
  assert.equal(
    next.handTopology,
    null,
    '本手未开始时冻结快照必须为空（此时只有「预告」，不是事实）',
  );
  assert.equal(next.handActive, false, '本手未开始');
});

/* ============================================================
 * §7 决策门槛：未行动的对手 ≠ 已实现的对手（§142 第 5 条）
 * ============================================================ */

test('§7 9 座桌 Hero 在 UTG：后面 8 个人都没说话，**不得**因此拒绝给建议', () => {
  /*
   * 修复前：`activeOpponentCount >= 3` → 拒绝。
   * Hero 在 UTG 时后面的 UTG1/UTG2/LJ/HJ/CO/BTN/SB/BB **一个字都还没说**，
   * 系统却已经认定「多人池超出能力」→ 满桌开池 100% 被拒。
   */
  const occupied = RING_9;
  let state = tableOf(9, occupied, Position.UTG);
  state = heroCards(state);

  const p = preview(state);
  assert.equal(p.isHeroTurn, true, 'Hero 在 UTG，翻牌前第一个行动');
  assert.ok(
    !p.analyzeBlockers.some((b) => b.includes('信息不足') || b.includes('活跃对手')),
    `不得因为「后面还有人没说话」就提前劝退：${p.analyzeBlockers.join(' / ')}`,
  );
  assert.equal(
    p.canAnalyze,
    true,
    `满桌 UTG 开池必须可分析，实际阻塞：${p.analyzeBlockers.join(' / ')}`,
  );

  // 适配器 → 上下文：已实现对手必须是 0，未行动必须是 8
  const adapted = tableStateToManualHandInput(state);
  assert.equal(adapted.ok, true, '适配必须成功');
  if (!adapted.ok) return;
  const parsed = parseManualInput(adapted.input);
  assert.equal(parsed.ok, true, '解析必须成功');
  if (!parsed.ok) return;
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, `Analyze 门槛必须放行：${gate.ok ? '' : JSON.stringify(gate.issues)}`);
  if (!gate.ok) return;

  const ctx = buildDecisionContext({ ...OPTIONS, state: gate.state });
  assert.equal(ctx.context.realizedOpponentCount, 0, '还没有人进池 → 已实现对手必须是 0');
  assert.equal(ctx.context.activeOpponentCount, 8, '未弃牌对手是 8');
  assert.equal(ctx.context.playersYetToAct, 8, '还没说话的是 8 个人');

  const decision = decideAlpha(ctx.context, ctx.legal);
  /*
   * 🔴 这条断言在本轮**收窄了**，但守的仍是原来那件事。
   *
   * 原断言：`actionable === true`（满桌 UTG 开池必须给建议）。
   * 那条断言想防的是**把「未行动」当成「已参战」**而误拒。
   *
   * 本轮把权益改成多人口径之后暴露了另一件事：这个 Spot 里
   * **一个对手都还没进池** ⇒ **没有任何对手范围** ⇒ 权益根本算不出来。
   * 此时拒答是**对的**（理由是「没有范围」，不是「人多」）。
   *
   * 因此这里改为断言**它想防的那件事**：拒绝（如果有）**不得**
   * 是因为「对手太多」。同时钉住它必须如实提示「后面还有 8 个人没说话」。
   *
   * ⚠️ 「进池之后就能分析」由 §7b（2 家）与 §7c（3 家）覆盖 ——
   * 那两条现在都断言 actionable=true，本测试不需要再承担那个职责。
   */
  const multiwayRefusals = decision.reasons.filter(
    (r) => r.code === 'MULTIWAY_NOT_SUPPORTED' || r.textZh.includes('超出第一版的分析能力'),
  );
  assert.deepEqual(
    multiwayRefusals,
    [],
    '满桌 UTG 开池**不得**因为「人多」拒绝 —— 那是把未行动当成了已参战。理由：' +
      decision.reasons.map((r) => r.textZh).join(' / '),
  );
  if (!decision.actionable) {
    // 若拒绝，理由必须是「没有对手范围」，而不是「对手太多」
    assert.ok(
      decision.reasons.some((r) => r.code === 'EQUITY_NOT_COMPUTABLE'),
      '没人进池时若拒答，理由必须是「没有对手范围可算权益」：' +
        decision.reasons.map((r) => r.code).join(','),
    );
  } else {
    assert.notEqual(decision.action, null, '给了建议就必须有具体动作');
  }
  assert.ok(
    decision.diagnostics.degradations.some((d) => d.code === 'PLAYERS_YET_TO_ACT'),
    '必须如实提示「后面还有 8 个人没说话」',
  );
});

test('§7b 有 2 人跟注后再分析：已实现对手 = 2，仍然给建议但必须标注偏乐观', () => {
  let state = heroCards(tableOf(9, RING_9, Position.CO));
  // UTG 与 UTG1 都跟注
  state = clickAction(state, 'CALL');
  state = clickAction(state, 'CALL');
  state = driveToHeroTurn(state, () => 'FOLD');

  const p = preview(state);
  assert.equal(p.isHeroTurn, true, `必须轮到 Hero，实际 ${String(p.currentActorPosition)}`);

  const adapted = tableStateToManualHandInput(state);
  assert.equal(adapted.ok, true, '适配必须成功');
  if (!adapted.ok) return;
  const parsed = parseManualInput(adapted.input);
  assert.equal(parsed.ok, true, '解析必须成功');
  if (!parsed.ok) return;
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, `必须可分析：${gate.ok ? '' : JSON.stringify(gate.issues)}`);
  if (!gate.ok) return;

  const ctx = buildDecisionContext({ ...OPTIONS, state: gate.state });
  assert.equal(ctx.context.realizedOpponentCount, 2, '两个跟注者 → 已实现对手必须是 2');
  const decision = decideAlpha(ctx.context, ctx.legal);
  assert.equal(
    decision.actionable,
    true,
    '2 名已实现对手仍在第一版支持范围内，必须给建议。理由：' +
      decision.reasons.map((r) => r.textZh).join(' / '),
  );
  assert.ok(
    decision.diagnostics.degradations.some((d) => d.code === 'MULTIWAY_APPROXIMATION'),
    '2 名已实现对手时必须标注「权益按单挑口径、偏乐观」',
  );
});

test('§7c 有 3 人真正进池：**必须给出建议**（本轮修复），且预览不得再劝退', () => {
  /*
   * 9 座桌翻牌前顺序：UTG → UTG1 → UTG2 → **LJ** → HJ → … → BB
   * 因此让前三家都跟注之后，下一个说话的是 **LJ**，Hero 必须在 LJ。
   *
   * 🔴 **这条测试在本轮反转了**，理由必须写清楚。
   *
   * 原断言：「3 名已实现对手 ⇒ 必须明确拒绝、理由 MULTIWAY_NOT_SUPPORTED」。
   * 动机是对的 —— 当时权益只按**首要对手一家**算，与按 4 家算的底池赔率
   * 口径不一致，数字会系统性偏乐观。
   *
   * 但代价是把工具在 9 座桌现金局里废掉：「一家开池、几家跟注」是常态。
   * 现在权益按**全部已实现对手**一起算（多人口径，与底池一致），
   * 因此 3 家、6 家都能给出建议。
   *
   * ⚠️ 反转的是**期望**，不是**标准**。这条测试现在守的是新行为的正确性：
   * 1. 必须给建议（不再是拒绝）
   * 2. **预览不再劝退** —— 界面不得再写「点分析会返回信息不足」
   * 3. 权益口径必须可见 —— 声明权益按几家算
   * 4. 数学仍然必须算出来（底池 > 0）
   */
  let state = heroCards(tableOf(9, RING_9, Position.LJ));
  state = clickAction(state, 'CALL'); // UTG 跟注
  state = clickAction(state, 'CALL'); // UTG1 跟注
  state = clickAction(state, 'CALL'); // UTG2 跟注

  const p = preview(state);
  assert.equal(
    p.isHeroTurn,
    true,
    `必须轮到 Hero（LJ），实际轮到 ${String(p.currentActorPosition)}`,
  );
  assert.equal(p.realizedOpponentCount, 3, '预览里的已实现对手数必须是 3');
  assert.ok(
    !p.analyzeBlockers.some((b) => b.includes('真正进入')),
    '预览**不得**再劝退：3 家已进池现在能正常分析。' +
      `实际 blockers：${p.analyzeBlockers.join(' / ') || '（无）'}`,
  );

  const adapted = tableStateToManualHandInput(state);
  assert.equal(adapted.ok, true, '适配必须成功');
  if (!adapted.ok) return;
  const parsed = parseManualInput(adapted.input);
  assert.equal(parsed.ok, true, '解析必须成功');
  if (!parsed.ok) return;
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, '重放必须成功');
  if (!gate.ok) return;

  const ctx = buildDecisionContext({ ...OPTIONS, state: gate.state });
  assert.equal(ctx.context.realizedOpponentCount, 3, '三个跟注者 → 已实现对手必须是 3');
  const decision = decideAlpha(ctx.context, ctx.legal);
  assert.equal(
    decision.actionable,
    true,
    '3 名**真正进池**的对手现在必须给出建议（权益按 3 家算）。理由：' +
      decision.reasons.map((r) => r.textZh).join(' / '),
  );
  assert.notEqual(decision.action, null, '可分析时 action 不得为 null');
  assert.ok(
    decision.diagnostics.math.pot > 0,
    '无论是否给建议，数学都必须算出来（底池 > 0）',
  );
  const multiway = decision.diagnostics.degradations.find(
    (d) => d.code === 'MULTIWAY_APPROXIMATION',
  );
  assert.ok(multiway !== undefined, '多人池必须声明权益口径');
  assert.ok(
    multiway!.textZh.includes('权益已按') && multiway!.textZh.includes('3'),
    `口径声明必须写明「权益已按这 3 家一起算」：${multiway!.textZh.slice(0, 120)}`,
  );
});

test('§7d 大盲的强制投入不算「已实现」—— 他还没说话', () => {
  /*
   * 边界：大盲已经往池里放了 1BB，但那是**强制**的。
   * 若把它算成「已实现」，9 人桌的大盲就会让 Hero 的开池凭空变成 2 人池。
   */
  const state = heroCards(tableOf(9, RING_9, Position.UTG));
  const adapted = tableStateToManualHandInput(state);
  assert.equal(adapted.ok, true, '适配必须成功');
  if (!adapted.ok) return;
  const parsed = parseManualInput(adapted.input);
  assert.equal(parsed.ok, true, '解析必须成功');
  if (!parsed.ok) return;
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, '门槛必须放行');
  if (!gate.ok) return;
  const ctx = buildDecisionContext({ ...OPTIONS, state: gate.state });
  assert.equal(
    ctx.context.realizedOpponentCount,
    0,
    '大盲的强制投入**不得**算作「已实现」—— 盲注不是「他决定打这一手」',
  );
  assert.equal(ctx.context.playersYetToAct, 8, '大盲也在「还没说话」的 8 个人里');
});

/* ============================================================
 * §8 界面 → 后端健全性 + 后端 → 界面完备性（§78）
 * ============================================================ */

test('§8 8 人牌桌上：预览给出的每一个动作按钮都必须被后端接受', () => {
  /*
   * 「界面 → 后端」健全性：界面能点出来的东西，后端必须收得下。
   * 这条在 9 座桌 8 人下尤其重要 —— 行动顺序按物理座位环绕，
   * 引擎的排队逻辑与界面的次序必须一致，否则会出现「点了没反应」。
   */
  const occupied = RING_9.filter((p) => p !== Position.UTG2);
  let state = heroCards(tableOf(9, occupied, Position.CO));
  state = driveToHeroTurn(state);

  const p = preview(state);
  assert.equal(p.isHeroTurn, true, '必须轮到 Hero');
  assert.ok(p.actionButtons.length > 0, 'Hero 回合必须有动作按钮');

  // 每一个主按钮都必须能被后端接受（逐个从同一状态出发试）
  const primaries = p.actionButtons.filter((b) => b.group === 'PRIMARY');
  assert.ok(primaries.length > 0, '必须有 PRIMARY 按钮');
  for (const button of primaries) {
    const result = applyTableOp(state, {
      kind: 'ACT',
      action: {
        type: button.type,
        ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
      },
    });
    assert.equal(
      result.ok,
      true,
      `界面上的「${button.labelZh}」被后端拒绝：${
        result.ok ? '' : result.issues.map((i) => i.message).join(' / ')
      }`,
    );
  }

  // SIZE 按钮（下注/加注尺寸）也必须全部可接受
  for (const button of p.actionButtons.filter((b) => b.group === 'SIZE')) {
    const result = applyTableOp(state, {
      kind: 'ACT',
      action: {
        type: button.type,
        ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
      },
    });
    assert.equal(
      result.ok,
      true,
      `界面上的「${button.labelZh}」被后端拒绝：${
        result.ok ? '' : result.issues.map((i) => i.message).join(' / ')
      }`,
    );
  }
});

test('§8b 后端判定合法的每一种动作类型，界面都必须有入口（§78 完备性）', () => {
  /*
   * 反向检查：**后端 → 界面**。
   *
   * 只做「界面 → 后端」会漏掉一整类缺陷：后端支持某个动作、
   * 但界面上根本没有按钮 → 使用者永远点不到，而所有测试都是绿的。
   */
  const state = heroCards(tableOf(9, RING_9, Position.CO));
  const adapted = tableStateToManualHandInput(state);
  assert.equal(adapted.ok, true, '适配必须成功');
  if (!adapted.ok) return;
  const parsed = parseManualInput(adapted.input);
  assert.equal(parsed.ok, true, '解析必须成功');
  if (!parsed.ok) return;
  const rebuilt = reconstructGameState(parsed.value, { mode: ReconstructMode.PREVIEW });
  assert.equal(rebuilt.ok, true, '重建必须成功');
  if (!rebuilt.ok) return;

  const actorId = rebuilt.state.pendingQueue[0];
  assert.notEqual(actorId, undefined, '必须有当前行动者');
  const actor = playerById(rebuilt.state, actorId!);
  assert.notEqual(actor, undefined, '必须能找到行动者');
  if (actor === undefined) return;

  const legal = deriveLegalActions(rebuilt.state, actor);
  const p = preview(state);
  const uiTypes = new Set(p.actionButtons.map((b) => b.type));
  for (const action of legal.actions) {
    assert.ok(
      uiTypes.has(action as never),
      `后端判定「${action}」合法，但界面上没有对应按钮 —— 使用者点不到（界面动作：${[
        ...uiTypes,
      ].join(',')}）`,
    );
  }
});

/* ============================================================
 * §9 SET_BUTTON（手动指定庄家）
 * ============================================================ */

test('§9 SET_BUTTON：本手未开始时可以指定；本手进行中必须被拒绝', () => {
  let state = tableOf(9, RING_9, Position.CO);
  assert.equal(state.buttonSeatId, 'seat_BTN', '默认 Button 在 BTN 座位');

  // 指到 BB 座位 → 小盲必须随之变成 SB（物理环绕）
  const bbSeatId = seatOfPosition(state, Position.BB)!.seatId;
  state = must(applyTableOp(state, { kind: 'SET_BUTTON', seatId: bbSeatId }));
  assert.equal(state.buttonSeatId, bbSeatId, 'Button 必须落在指定座位');

  const adapted = tableStateToManualHandInput(heroCards(state));
  assert.equal(adapted.ok, true, '适配必须成功');
  if (!adapted.ok) return;
  assert.equal(adapted.input.buttonPosition, Position.BB, 'buttonPosition 必须跟随 SET_BUTTON');

  const parsed = parseManualInput(adapted.input);
  assert.equal(parsed.ok, true, `解析必须成功：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
  if (!parsed.ok) return;
  const rebuilt = reconstructGameState(parsed.value, { mode: ReconstructMode.PREVIEW });
  assert.equal(rebuilt.ok, true, `重建必须成功：${rebuilt.ok ? '' : JSON.stringify(rebuilt.issues)}`);
  if (!rebuilt.ok) return;
  const topo = stateTopology(rebuilt.state);
  assert.equal(RING_9[topo.buttonSeatIndex], Position.BB, 'Button 必须真的在 BB 座位');
  /*
   * 小盲 = **Button 顺时针的下一位参与者**，而不是「座位名叫 SB 的那个座位」。
   *
   * 🔴 这正是「Seat ≠ Position」的一个真实后果：把 Button 放在 BB 座位
   *（9 座环的下标 8）之后，顺时针的下一位环回到 **UTG**（下标 0）——
   * 于是**物理座位 UTG 承担了小盲的角色**。这不是缺陷，是现金局的常态：
   * 筹码牌在谁那儿，谁就下小盲，位置名只是**角色**。
   *
   * 反过来，如果实现里写死「小盲 = SB 座位」，这一刻就会静默算错。
   */
  const buttonIndex = 8; // BB 在 9 座环上的下标
  const expectedSbPosition = RING_9[(buttonIndex + 1) % RING_9.length]!;
  assert.equal(
    RING_9[topo.smallBlindSeatIndex],
    expectedSbPosition,
    `小盲必须是 Button 顺时针的下一位（${expectedSbPosition}），而不是座位名叫 SB 的那个`,
  );
  assert.equal(expectedSbPosition, Position.UTG, '本用例里它恰好是 UTG —— 下标 8 环绕到 0');
  assert.equal(topo.bigBlindSeatIndex, buttonIndex + 1 > RING_9.length - 1 ? 1 : buttonIndex + 2, '大盲在小盲之后');
  // 参与者 9 人 → 角色名仍然是满桌的规范角色表
  assert.deepEqual(
    Object.values(topo.roleBySeatIndex).sort(),
    [...canonicalRolesOf(9)].sort(),
    '满桌 9 人时角色表必须是 canonicalRolesOf(9)',
  );

  // ---- 幂等：再设一次同一个座位 → 无变化 ----
  const again = must(applyTableOp(state, { kind: 'SET_BUTTON', seatId: bbSeatId }));
  assert.equal(again.revision, state.revision, '设成同一个座位不得改变 revision');

  // ---- 拒绝：空座位 ----
  const emptySeatId = seatOfPosition(tableOf(9, RING_9.filter((p) => p !== Position.UTG2), Position.CO), Position.UTG2)!.seatId;
  const empty = applyTableOp(
    tableOf(9, RING_9.filter((p) => p !== Position.UTG2), Position.CO),
    { kind: 'SET_BUTTON', seatId: emptySeatId },
  );
  assert.equal(empty.ok, false, '空座位不能当 Button');

  // ---- 拒绝：本手进行中 ----
  const active = heroCards(tableOf(9, RING_9, Position.CO));
  assert.equal(active.handActive, true, '本手必须已经开始');
  const during = applyTableOp(active, {
    kind: 'SET_BUTTON',
    seatId: seatOfPosition(active, Position.BB)!.seatId,
  });
  assert.equal(
    during.ok,
    false,
    '本手进行中改 Button 必须被拒绝 —— 那会改变盲注与行动顺序的归属',
  );
});

/* ============================================================
 * §10 HTTP 产品路径：9 座桌 8 人从建桌到分析
 * ============================================================ */

test('§10 HTTP 产品路径：建 9 座桌 → 坐 8 人 → 预览给出容量与本手人数', () => {
  const guard = new RevisionGuard();
  let idSeq = 0;
  const deps = {
    newTableId: () => {
      idSeq += 1;
      return `t${idSeq}`;
    },
    guard,
  };

  const created = handleTableRequest({ tableSize: 9, heroPosition: Position.CO }, deps);
  assert.equal(created.ok, true, '建桌必须成功');
  if (!created.ok) return;
  assert.equal(created.preview.seats.length, 9, '9 座桌必须有 9 个座位视图');

  let state = created.state;
  for (const position of RING_9) {
    if (position === Position.CO || position === Position.UTG2) continue;
    const result = handleTableRequest(
      { state, op: { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, position)!.seatId } },
      deps,
    );
    assert.equal(
      result.ok,
      true,
      `加入 ${position} 失败：${result.ok ? '' : JSON.stringify(result.issues)}`,
    );
    if (!result.ok) return;
    state = result.state;
  }

  // 设置 Hero 手牌（走 HTTP）
  for (const card of ['As', 'Kd']) {
    const result = handleTableRequest({ state, op: { kind: 'SET_HERO_CARD', card } }, deps);
    assert.equal(result.ok, true, `设置手牌 ${card} 失败`);
    if (!result.ok) return;
    state = result.state;
  }

  const p = buildTablePreview(state);
  assert.equal(p.seats.filter((s) => s.playerId !== null).length, 8, '必须有 8 个有人的座位');
  assert.equal(p.seats.length, 9, '座位视图必须仍是 9 个（容量表 + EMPTY 占位）');

  const t = p.handTopology;
  assert.notEqual(t, null, '预览必须暴露本手拓扑');
  if (t === null) return;
  assert.equal(t.tableCapacity, 9, '拓扑容量必须是 9');
  assert.equal(t.handedness, 8, '拓扑本手人数必须是 8');
  assert.equal(t.participantSeatIds.length, 8, '拓扑参与者必须是 8 个座位');

  // ---- 「D」标记必须只有一个，且落在 buttonSeatId 上 ----
  const dealers = p.seats.filter((s) => s.isDealer);
  assert.equal(dealers.length, 1, `「D」标记必须有且只有一个，实际 ${dealers.length} 个`);
  assert.equal(dealers[0]!.seatId, t.buttonSeatId, '「D」必须标在真实的 Button 座位上');

  // ---- 空座位必须被标成「不参与本手」，且没有角色名 ----
  const utg2 = p.seats.find((s) => s.logicalPosition === Position.UTG2)!;
  assert.equal(utg2.isParticipant, false, '空座位不得标记为参与者');
  assert.equal(utg2.handRole, null, '空座位不得有本手角色名');
  assert.equal(utg2.handRoleZh, null, '空座位不得有角色中文名');

  // ---- 每个参与者的角色名都必须是中文可显示的 ----
  for (const seat of p.seats) {
    if (!seat.isParticipant) continue;
    assert.notEqual(seat.handRole, null, `参与者座位 ${seat.seatId} 必须有角色名`);
    assert.ok(
      seat.handRoleZh !== null && seat.handRoleZh.length > 0,
      `参与者座位 ${seat.seatId} 必须有角色中文名`,
    );
  }
});

/* ============================================================
 * §11 六条铁律的具名断言
 * ============================================================ */

test('§11 铁律 1：Table Capacity ≠ Handedness —— 拓扑同时记住两个数字', () => {
  const occupied = RING_9.filter((p) => p !== Position.UTG2 && p !== Position.LJ);
  const state = heroCards(tableOf(9, occupied, Position.CO));
  const t = preview(state).handTopology;
  assert.notEqual(t, null, '必须有拓扑');
  assert.equal(t!.tableCapacity, 9, '容量是 9');
  assert.equal(t!.handedness, 7, '本手是 7 人');
  assert.notEqual(t!.tableCapacity, t!.handedness, '两个数字必须能不同 —— 这正是本轮的题目');
});

test('§11 铁律 3：Seat ≠ Position —— 座位下标保持物理含义，角色按 Button 重算', () => {
  // 同一个物理座位，Button 不同 → 角色不同
  const buttonAtBtn = handTopologySeats(9, RING_9, Position.BTN);
  const buttonAtCo = handTopologySeats(9, RING_9, Position.CO);

  const utgIndex = 0; // UTG 座位（物理下标 0）在两手里都存在
  const roleInFirst = buttonAtBtn.roleBySeatIndex[utgIndex];
  const roleInSecond = buttonAtCo.roleBySeatIndex[utgIndex];
  assert.notEqual(
    roleInFirst,
    roleInSecond,
    '同一个物理座位在 Button 不同时必须是不同角色 —— Seat ≠ Position',
  );
  assert.equal(occupiedSeatIndices(9, RING_9).length, 9, '满桌时 9 个座位全部参与');

  // 空座位只影响参与者集合，不影响物理下标
  const withGap = RING_9.filter((p) => p !== Position.UTG2);
  const indices = occupiedSeatIndices(9, withGap);
  assert.deepEqual(
    indices,
    [0, 1, 3, 4, 5, 6, 7, 8],
    '空 UTG2 时下标必须是 [0,1,3,4,5,6,7,8] —— 空缺处**保留**，不重排',
  );
  assert.equal(
    occupiedSeatIndices(9, [...withGap].reverse()).length,
    8,
    'occupiedSeatIndices 与输入顺序无关',
  );
});

test('§11 铁律 4：Table State ≠ Hand State —— 座位状态不影响已冻结的本手', () => {
  let state = heroCards(tableOf(9, RING_9, Position.CO));
  state = driveToHeroTurn(state);
  const snapshotBefore = JSON.stringify(handTopologyOf(state));

  // 让一个**已经行动过**的玩家在本手进行中标记离桌
  const utgSeatId = seatOfPosition(state, Position.UTG)!.seatId;
  const marked = must(
    applyTableOp(state, {
      kind: 'CLEAR_SEAT',
      seatId: utgSeatId,
      activeHandChoice: 'LEAVE_AFTER_HAND',
    }),
  );
  assert.equal(
    JSON.stringify(handTopologyOf(marked)),
    snapshotBefore,
    '座位生命周期操作不得改动本手拓扑快照',
  );
  assert.equal(
    marked.handActive,
    true,
    '本手仍在进行 —— 座位状态（Table State）与本手状态（Hand State）是两件事',
  );

  // 本手可以继续录
  const continued = clickAction(marked, 'FOLD');
  assert.ok(
    continued.actionHistory.length > marked.actionHistory.length,
    '本手必须能继续录入',
  );
});
