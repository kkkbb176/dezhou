/**
 * 复验探针：**9 座桌 8 人**（本轮头号 Bug）在**产品路径**上是否真的可分析。
 *
 * 之所以要单独写这个探针：域层 `createGame` 放行 `2 ≤ 本手人数 ≤ 容量`
 * 不等于产品可用 —— 修复过程中「拦截点从域层搬到表层」正是本轮最隐蔽的
 * 缺陷形态（域层放行、`staffingProblems` 拦回、`canAnalyze=false`）。
 * 因此这里**只走产品入口**：`applyTableOp` → `buildTablePreview` → `handleTableRequest`。
 *
 * 用法：`node.exe --experimental-strip-types scripts/rt-topology-verify.ts`
 */

import { Position } from '../src/domain/types.ts';
import { createTable, participantSeatsOf, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import { handleTableRequest, RevisionGuard } from '../src/app/table/tableApi.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';

let failures = 0;
const line = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const head = (text: string): void => {
  line(`\n${'='.repeat(72)}\n${text}\n${'='.repeat(72)}`);
};
const ok = (text: string): void => line(`  PASS  ${text}`);
const bad = (text: string): void => {
  failures += 1;
  line(`  FAIL  ${text}`);
};

function must(state: PokerTableState, op: TableOp, where: string): PokerTableState {
  const result = applyTableOp(state, op);
  if (!result.ok) throw new Error(`${where}: ${JSON.stringify(result.issues)}`);
  return result.state;
}

/**
 * 建一张 9 座桌，把 `occupied` 里的座位坐满人（Hero 在 BTN）。
 *
 * ⚠️ 刻意**不给空座位补人** —— 这正是被测场景。
 */
function table9(occupied: readonly Position[], heroPosition: Position): PokerTableState {
  let state = createTable({ tableSize: 9, heroPosition });
  const heroSeat = seatOfPosition(state, heroPosition)!;
  for (const position of occupied) {
    if (position === heroPosition) continue;
    state = must(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, position)!.seatId }, `add ${position}`);
  }
  if (heroSeat.playerId === null) throw new Error('Hero 座位没有玩家');
  return state;
}

function heroCards(state: PokerTableState): PokerTableState {
  let out = must(state, { kind: 'SET_HERO_CARD', card: 'As' }, 'hero card 1');
  out = must(out, { kind: 'SET_HERO_CARD', card: 'Kd' }, 'hero card 2');
  return out;
}

/* ============================================================
 * §A 头号 Bug：9 座桌 8 人（空 UTG2）必须可分析
 * ============================================================ */

head('§A 头号 Bug：9 座桌 8 人 —— 一个空座位不得阻断分析');

{
  const all = [
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
  const occupied = all.filter((p) => p !== Position.UTG2); // UTG2 空
  const state = table9(occupied, Position.CO); // Hero 在 CO（不是 BTN，避免只测一种）

  const participants = participantSeatsOf(state).map((s) => s.logicalPosition);
  line(`  容量=9  参与者=${participants.length} 人  空座=${all.filter((p) => !participants.includes(p)).join('、')}`);
  if (participants.length === 8) ok('participantSeatsOf 给出 8 人');
  else bad(`participantSeatsOf 给出 ${participants.length} 人，期望 8 人`);

  const withCards = heroCards(state);
  const preview = buildTablePreview(withCards);
  line(`  buildTablePreview: ok=${String(preview.ok)} canAnalyze=${String(preview.canAnalyze)}`);
  line(`  阻塞项=${JSON.stringify(preview.analyzeBlockers)}`);

  if (preview.analyzeBlockers.some((b) => b.includes('空座位'))) {
    bad('「空座位」仍然出现在阻塞项里 —— 拦截点只是被搬了个位置');
  } else {
    ok('空座位不再是阻塞项');
  }
  if (preview.analyzeBlockers.some((b) => b.includes('每个座位都有人'))) {
    bad('旧的「要求每个座位都有人」措辞仍然存在');
  } else {
    ok('旧的「每个座位都有人」要求已消失');
  }

  // ---- 产品入口：走真实的 HTTP 请求体形状（`{ tableSize, heroPosition }`）----
  //
  // ⚠️ 探针第一版这里传了 `{ table: ... }`，那不是协议形状，于是拿到一个
  // 「1 个座位视图」的 6 座空桌 —— **探针自己的 Bug，不是产品 Bug**。
  // 现在按 `tableApi.ts` 的契约来：无 `state` → 新建；有 `state` + `op` → 应用操作。
  const guard = new RevisionGuard();
  const api = handleTableRequest(
    { tableSize: 9, heroPosition: Position.CO },
    { newTableId: () => 't1', guard },
  );
  if (!api.ok) {
    bad(`handleTableRequest 新建失败：${JSON.stringify(api.issues)}`);
  } else {
    const occupiedSeats = api.preview.seats.filter((s) => s.playerId !== null);
    line(
      `  API 新建预览: ${api.preview.seats.length} 个座位视图，其中 ${occupiedSeats.length} 个有人`,
    );
    if (api.preview.seats.length === 9) ok('新建的 9 座桌返回 9 个座位视图');
    else bad(`座位视图 ${api.preview.seats.length} 个，期望 9`);

    const t = api.preview.handTopology;
    if (t === null) {
      // 新建时桌上只有 Hero 一人 → 不足 2 人，拓扑预告如实为 null
      ok('新建时只有 Hero 一人 → 拓扑预告为 null（而不是编一个出来）');
    } else {
      line(`  ⚠️ 只有 1 人却给出了拓扑：容量=${t.tableCapacity} 本手=${t.handedness}`);
      bad('可参与者不足 2 人时不得给出拓扑');
    }
  }

  // ---- 8 人在座后再问一次：这才是「9 座桌 8 人」的真实预览 ----
  //
  // ⚠️ `handleTableRequest` 在给了 `state` 时**必须**同时给 `op`
  //（`parseOp` 会拒绝空 op）。探针第一版这里只给了 state，于是拿到
  // 「op 必须是对象」—— 那是探针用错了协议，不是产品缺陷。
  // 现在用一个**幂等的真实操作**（`SET_ENVIRONMENT` 设成同一个值 →
  // `seatLifecycle.commit` 判定为 no-op，revision 不变）来触发一次预览。
  const eightSeats = handleTableRequest(
    { state: withCards, op: { kind: 'SET_ENVIRONMENT', environment: withCards.environment } },
    { newTableId: () => 't2', guard },
  );
  if (!eightSeats.ok) {
    bad(`8 人牌桌请求失败：${JSON.stringify(eightSeats.issues)}`);
  } else {
    const occupiedSeats = eightSeats.preview.seats.filter((s) => s.playerId !== null);
    line(
      `  API 8 人预览: ${eightSeats.preview.seats.length} 个座位视图，其中 ${occupiedSeats.length} 个有人`,
    );
    if (occupiedSeats.length === 8) ok('API 返回 8 个有人的座位');
    else bad(`API 返回 ${occupiedSeats.length} 个有人的座位，期望 8`);

    const t = eightSeats.preview.handTopology;
    if (t === null) {
      bad('预览没有暴露 handTopology —— 前端无从显示「9 座桌 · 本手 8 人」');
    } else {
      line(
        `  handTopology: 容量=${t.tableCapacity} 本手=${t.handedness} ` +
          `Button=${t.buttonSeatId} 参与者=${t.participantSeatIds.length}`,
      );
      if (t.tableCapacity === 9 && t.handedness === 8) ok('预览同时给出容量 9 与本手人数 8');
      else bad(`预览拓扑 容量=${t.tableCapacity} 本手=${t.handedness}，期望 9 / 8`);

      // Button 标记必须来自 buttonSeatId，而不是「座位名叫 BTN」
      const dealerSeats = eightSeats.preview.seats.filter((s) => s.isDealer);
      if (dealerSeats.length === 1 && dealerSeats[0]!.seatId === t.buttonSeatId) {
        ok(`界面只有一个「D」标记，且落在 buttonSeatId（${t.buttonSeatId}）`);
      } else {
        bad(`「D」标记有 ${dealerSeats.length} 个：${dealerSeats.map((s) => s.seatId).join(',')}`);
      }

      // 不参与的座位必须被标出来（空座 UTG2）
      const utg2Seat = eightSeats.preview.seats.find(
        (s) => s.logicalPosition === Position.UTG2,
      )!;
      if (!utg2Seat.isParticipant && utg2Seat.handRole === null) {
        ok('空座 UTG2 标记为「不参与本手」且没有角色名');
      } else {
        bad(
          `空座 UTG2 isParticipant=${String(utg2Seat.isParticipant)} handRole=${String(utg2Seat.handRole)}`,
        );
      }
    }
  }

  // 引擎口径：直接看适配出来的 ManualHandInput
  const { tableStateToManualHandInput } = await import('../src/app/table/tableAdapter.ts');
  const adapted = tableStateToManualHandInput(withCards);
  if (!adapted.ok) {
    bad(`适配失败：${JSON.stringify(adapted.issues)}`);
  } else {
    const inp = adapted.input;
    line(
      `  适配：tableSize=${String(inp.tableSize)} occupiedPositions=${JSON.stringify(
        inp.occupiedPositions?.map((p) => p as string),
      )} buttonPosition=${String(inp.buttonPosition)}`,
    );
    if (inp.occupiedPositions?.length === 8) ok('occupiedPositions 已由适配器真正填上（8 个座位）');
    else bad(`occupiedPositions 长度 = ${String(inp.occupiedPositions?.length)}，期望 8`);

    const btnSeat = seatOfPosition(withCards, Position.BTN)!;
    const buttonSeatId = withCards.buttonSeatId;
    if (buttonSeatId === btnSeat.seatId) {
      if (inp.buttonPosition === Position.BTN) ok('buttonPosition 来自 buttonSeatId（= BTN）');
      else bad(`buttonPosition = ${String(inp.buttonPosition)}，期望 BTN`);
    } else {
      bad(`buttonSeatId = ${buttonSeatId}，期望 ${btnSeat.seatId}`);
    }
    if (inp.occupiedPositions?.includes(Position.UTG2 as never) === false) {
      ok('空座位 UTG2 不在 occupiedPositions 里');
    } else {
      bad('空座位 UTG2 混进了 occupiedPositions');
    }
  }
}

/* ============================================================
 * §B 空座位在**非连续**位置（HJ + CO 都空）
 * ============================================================ */

head('§B 9 座桌 7 人，空位不连续（HJ、CO 空）—— 盲注与行动顺序必须正确');

{
  const state = table9(
    [
      Position.UTG,
      Position.UTG1,
      Position.UTG2,
      Position.LJ,
      Position.BTN,
      Position.SB,
      Position.BB,
    ],
    Position.UTG,
  );
  const { reconstructGameState } = await import('../src/app/manualInput/reconstruct.ts');
  const { parseManualInput } = await import('../src/app/manualInput/manualInput.ts');
  const { tableStateToManualHandInput } = await import('../src/app/table/tableAdapter.ts');
  const { stateTopology } = await import('../src/domain/poker/gameState.ts');

  const withCards = heroCards(state);
  const adapted = tableStateToManualHandInput(withCards);
  if (!adapted.ok) {
    bad(`适配失败：${JSON.stringify(adapted.issues)}`);
  } else {
    const parsed = parseManualInput(adapted.input);
    if (!parsed.ok) {
      bad(`解析失败：${JSON.stringify(parsed.issues)}`);
    } else {
      line(`  解析：handedness=${parsed.value.handedness} capacity=${parsed.value.tableSize}`);
      if (parsed.value.handedness === 7) ok('handedness = 7（不是容量 9）');
      else bad(`handedness = ${parsed.value.handedness}，期望 7`);

      const rebuilt = reconstructGameState(parsed.value, { mode: 'PREVIEW' as never });
      if (!rebuilt.ok) {
        bad(`重建失败：${JSON.stringify(rebuilt.issues)}`);
      } else {
        const topo = stateTopology(rebuilt.state);
        const posOfIndex = (index: number): string =>
          ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'][index]!;
        line(
          `  拓扑：handedness=${topo.handedness} Button=${posOfIndex(topo.buttonSeatIndex)} ` +
            `SB=${posOfIndex(topo.smallBlindSeatIndex)} BB=${posOfIndex(topo.bigBlindSeatIndex)} ` +
            `先行动=${posOfIndex(topo.firstToActSeatIndex)}`,
        );
        if (topo.handedness === 7) ok('引擎拓扑 handedness = 7');
        else bad(`引擎拓扑 handedness = ${topo.handedness}`);
        if (posOfIndex(topo.smallBlindSeatIndex) === 'SB' && posOfIndex(topo.bigBlindSeatIndex) === 'BB') {
          ok('盲注落在真实的 SB / BB 座位（空座被跳过）');
        } else {
          bad(`盲注错位：SB=${posOfIndex(topo.smallBlindSeatIndex)} BB=${posOfIndex(topo.bigBlindSeatIndex)}`);
        }
        // 空座位绝不能拿到任何角色
        const rolesTaken = Object.keys(topo.roleBySeatIndex).map((k) => posOfIndex(Number(k)));
        if (!rolesTaken.includes('HJ') && !rolesTaken.includes('CO')) {
          ok('空座位 HJ / CO 没有拿到任何角色');
        } else {
          bad(`空座拿到了角色：${rolesTaken.join(',')}`);
        }
      }
    }
  }
}

/* ============================================================
 * §C 单挑（2 人）：本轮修好的三个缺陷
 * ============================================================ */

head('§C 单挑：位置名 BTN/BB、翻牌后先问大盲、重复 playerId 必须被拒');

{
  const { handTopologySeats, canonicalRolesOf } = await import('../src/domain/poker/positions.ts');
  const { createGame } = await import('../src/domain/poker/gameState.ts');
  const { Position: P } = await import('../src/domain/types.ts');

  const topo = handTopologySeats(6, [P.BTN, P.BB], P.BTN);
  const roles = Object.entries(topo.roleBySeatIndex).map(
    ([k, v]) => `${k}:${v as string}`,
  );
  line(`  单挑角色表 = ${JSON.stringify(roles)}  canonicalRolesOf(2)=${JSON.stringify(canonicalRolesOf(2))}`);
  const hasBtn = Object.values(topo.roleBySeatIndex).includes(P.BTN);
  if (hasBtn) ok('单挑的位置名里有 BTN（SB 不再覆盖 Button）');
  else bad('单挑的位置名里没有 BTN —— SB 覆盖了 Button');
  if (topo.smallBlindSeatIndex === topo.buttonSeatIndex && topo.buttonAlsoPostsSmallBlind) {
    ok('Button 本人下小盲（用座位下标表达，而不是占用位置名）');
  } else {
    bad('单挑的「Button 下小盲」表达有误');
  }

  /*
   * 单挑真的能录完一手吗 —— 必须走**完整的翻牌前 → 翻牌**，因为本轮修的是
   * 「单挑翻牌后从大盲开始」，只录一条动作测不到它。
   *
   * 标准单挑顺序：翻牌前 Button（= 小盲）先行动；翻牌后大盲先行动。
   */
  const { parseManualInput } = await import('../src/app/manualInput/manualInput.ts');
  const { reconstructGameState } = await import('../src/app/manualInput/reconstruct.ts');
  const { actorOnTurn } = await import('../src/domain/poker/engine.ts');

  const huInput = (actionHistory: readonly unknown[], board: readonly string[]): unknown => ({
    tableSize: 6,
    heroPosition: P.BTN,
    heroCards: ['As', 'Kd'],
    board,
    street: board.length >= 3 ? 'FLOP' : 'PREFLOP',
    effectiveStackBB: 100,
    actionHistory,
    environment: 'LOW_STAKES_ONLINE',
    occupiedPositions: [P.BTN, P.BB],
    buttonPosition: P.BTN,
  });

  // 单挑翻牌前：Button 先补 50（小盲 50 已下，本次投入 0.5BB）

  const hu = parseManualInput(huInput([], []) as never);
  if (!hu.ok) {
    bad(`单挑输入解析失败：${JSON.stringify(hu.issues)}`);
  } else {
    // ---- 翻牌前：Button(=小盲) CALL → 大盲 CHECK ----
    const pre = parseManualInput(
      huInput(
        [
          { position: P.BTN, type: 'CALL', amountBB: 0.5 },
          { position: P.BB, type: 'CHECK' },
        ],
        [],
      ) as never,
    );
    if (!pre.ok) {
      bad(`单挑翻牌前解析失败：${JSON.stringify(pre.issues)}`);
    } else {
      const preState = reconstructGameState(pre.value, { mode: 'PREVIEW' as never });
      if (!preState.ok) {
        bad(`单挑翻牌前录入失败：${JSON.stringify(preState.issues)}`);
      } else {
        ok('单挑翻牌前「Button CALL → 大盲 CHECK」被接受');
      }
    }

    // ---- 翻牌：大盲先行动 ----
    const flop = parseManualInput(
      huInput(
        [
          { position: P.BTN, type: 'CALL', amountBB: 0.5 },
          { position: P.BB, type: 'CHECK' },
          { position: P.BB, type: 'CHECK', street: 'FLOP' },
        ],
        ['Ah', '7c', '2d'],
      ) as never,
    );
    if (!flop.ok) {
      bad(`单挑翻牌解析失败：${JSON.stringify(flop.issues)}`);
    } else {
      const flopState = reconstructGameState(flop.value, { mode: 'PREVIEW' as never });
      if (!flopState.ok) {
        bad(`单挑翻牌「大盲先 CHECK」被拒绝：${JSON.stringify(flopState.issues)}`);
      } else {
        const actor = actorOnTurn(flopState.state);
        const actorPos = flopState.state.players.find((p) => p.id === actor)?.position ?? null;
        line(`  单挑翻牌：大盲 CHECK 之后轮到 ${String(actorPos)}`);
        ok('单挑翻牌后大盲先行动（Button 最后）');
        if (actorPos === P.BTN) ok('大盲行动后轮到 Button —— 顺序闭合');
        else bad(`大盲行动后应轮到 Button，实际 ${String(actorPos)}`);

        // 反证：翻牌后先问 Button 必须被拒
        const wrong = parseManualInput(
          huInput(
            [
              { position: P.BTN, type: 'CALL', amountBB: 0.5 },
              { position: P.BB, type: 'CHECK' },
              { position: P.BTN, type: 'CHECK', street: 'FLOP' },
            ],
            ['Ah', '7c', '2d'],
          ) as never,
        );
        if (wrong.ok) {
          const w = reconstructGameState(wrong.value, { mode: 'PREVIEW' as never });
          if (w.ok) bad('单挑翻牌后先录 Button 竟然被接受 —— 顺序判据没有约束力');
          else ok('反证成立：单挑翻牌后先录 Button 被拒绝（顺序真的有约束力）');
        } else {
          bad(`反证样本解析失败：${JSON.stringify(wrong.issues)}`);
        }
      }
    }
  }

  // 重复 playerId
  let threw = false;
  try {
    createGame({
      config: { tableSize: 6, smallBlind: 50, bigBlind: 100, ante: 0, dealerPosition: P.BTN },
      players: [
        { id: 'dup', name: 'A', position: P.BTN, startingStack: 10000 },
        { id: 'dup', name: 'B', position: P.BB, startingStack: 10000 },
      ],
      userPlayerId: 'dup',
    } as never);
  } catch {
    threw = true;
  }
  if (threw) ok('重复 playerId 被 createGame 拒绝');
  else bad('重复 playerId 仍然被 createGame 接受');
}

/* ============================================================
 * §D 容量 ≠ 本手人数：穷举 9 座 / 6 座的每一种人数
 * ============================================================ */

head('§D 穷举：9 座桌的每一种本手人数（2~9）都必须能建局并给出正确盲注');

{
  const { reconstructGameState } = await import('../src/app/manualInput/reconstruct.ts');
  const { parseManualInput } = await import('../src/app/manualInput/manualInput.ts');
  const { stateTopology } = await import('../src/domain/poker/gameState.ts');

  const ring9 = [
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
  let checked = 0;
  for (let n = 2; n <= 9; n += 1) {
    // 取座位环上的**最后 n 个**（含 BB，最像真实的「有人离桌」形态）
    const occupied = ring9.slice(9 - n);
    const buttonPosition = occupied[Math.max(0, occupied.length - 3)]!; // 靠后的一个座位当 Button
    const heroPosition = occupied[0]!;
    const input = {
      tableSize: 9,
      heroPosition,
      heroCards: ['As', 'Kd'],
      board: [],
      street: 'PREFLOP',
      effectiveStackBB: 100,
      actionHistory: [],
      environment: 'LOW_STAKES_ONLINE',
      occupiedPositions: occupied,
      buttonPosition,
    };
    const parsed = parseManualInput(input as never);
    if (!parsed.ok) {
      bad(`${n} 人：解析失败 ${JSON.stringify(parsed.issues)}`);
      continue;
    }
    const rebuilt = reconstructGameState(parsed.value, { mode: 'PREVIEW' as never });
    if (!rebuilt.ok) {
      bad(`${n} 人：建局失败 ${JSON.stringify(rebuilt.issues)}`);
      continue;
    }
    const topo = stateTopology(rebuilt.state);
    const sbPlayer = rebuilt.state.players.find(
      (p) => p.position === ring9[topo.smallBlindSeatIndex],
    );
    const bbPlayer = rebuilt.state.players.find(
      (p) => p.position === ring9[topo.bigBlindSeatIndex],
    );
    const sbPaid = sbPlayer?.committedByStreet.PREFLOP ?? 0;
    const bbPaid = bbPlayer?.committedByStreet.PREFLOP ?? 0;
    const expectedSb = n === 2 ? 50 : 50;
    const pass =
      topo.handedness === n &&
      sbPaid === expectedSb &&
      bbPaid === 100 &&
      rebuilt.state.players.length === n;
    line(
      `  ${n} 人（空 ${9 - n} 座）：handedness=${topo.handedness} 玩家数=${rebuilt.state.players.length} ` +
        `SB 投入=${sbPaid} BB 投入=${bbPaid} ${pass ? '✓' : '✗'}`,
    );
    if (pass) checked += 1;
    else bad(`${n} 人：不变量不成立`);
  }
  if (checked === 8) ok('9 座桌的 2~9 人全部正确（含单挑 Button 下小盲）');
  else bad(`只有 ${checked}/8 种人数正确`);
}

head(`结论：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
