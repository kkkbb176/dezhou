/**
 * 牌桌操作分发（把「UI 意图」落到引擎上）
 *
 * ## 分工
 *
 * ```
 * seatLifecycle.ts   纯状态操作（座位、手牌、公共牌、撤销、换手）
 * tableOps.ts        需要**引擎**参与的操作（记录行动、下一手的剩余筹码）
 * tablePreview.ts    只读派生（渲染与合法动作）
 * ```
 *
 * ## 🔴 前端永不指定「谁在行动」
 *
 * `ACT` 请求里只有动作类型与金额，**没有位置**。行动者由后端从重放出来的
 * `GameState` 通过 `actorOnTurn` 得到 —— 前端连"现在轮到谁"都不需要知道，
 * 它只是把 `preview.currentActorPosition` 显示出来。
 *
 * 这样「前端算出轮到 UTG，后端认为是 CO」这类分歧在结构上不存在。
 *
 * ## 🔴 落库前必须**验证重放等价**
 *
 * 记一条行动时，本模块会在应用之后**重新重放一遍完整历史**，
 * 断言重放结果与刚算出的状态**逐位一致**。
 *
 * 不这么做的话，一个金额换算误差就会让「牌桌显示的状态」与
 * 「分析时重放出来的状态」分叉 —— 那正是本轮最危险的缺陷形态。
 * 这个检查是 O(行动数)，相对权益计算可以忽略。
 */

import { ActionType, Street, type Card, type Position } from '../../domain/types.ts';
import { applyAction, actorOnTurn, type Issue } from '../../domain/poker/engine.ts';
import { computePot, playerById, type ActionCommand, type GameState } from '../../domain/poker/gameState.ts';
import {
  parseManualInput,
  type ManualAction,
  type ManualActionType,
} from '../manualInput/manualInput.ts';
import {
  ReconstructMode,
  reconstructGameState,
  settleCanonicalStreet,
} from '../manualInput/reconstruct.ts';
import { tableStateToManualHandInput } from './tableAdapter.ts';
import { stateFingerprintOf } from './tablePreview.ts';
import {
  ActiveHandLeaveChoice,
  type PokerTableState,
  type TableActionRequest,
  type TableIssue,
  type TableOp,
  type TableOpOutcome,
} from './table.types.ts';
import {
  addPlayer,
  fillEmptySeats,
  appendAction,
  clearAllVillains,
  clearBoard,
  clearHeroCards,
  clearSeat,
  commit,
  fail,
  markLeavingAfterHand,
  newTable,
  nextHand,
  ok,
  replacePlayer,
  resetHand,
  setBoardCard,
  setDynamicHint,
  setEnvironment,
  setHeroCard,
  setHeroPosition,
  setButton,
  setProfile,
  setStack,
  setTableSize,
  sitIn,
  sitOut,
  undo,
} from './seatLifecycle.ts';

/* ============================================================
 * 与引擎对接的辅助
 * ============================================================ */

const ACTION_TYPE_MAP: Readonly<Record<ManualActionType, ActionType>> = Object.freeze({
  FOLD: ActionType.FOLD,
  CHECK: ActionType.CHECK,
  CALL: ActionType.CALL,
  BET: ActionType.BET,
  RAISE: ActionType.RAISE,
  ALL_IN: ActionType.ALL_IN,
});

/** BB → 筹码（**只在读路径**使用；写路径一律用精确筹码数） */
function chipsToBB(chips: number, bigBlindChips: number): number {
  // 6 位小数：往返 `round(bb × 面额)` 无损，同时避免 0.1+0.2 这类噪声
  return Math.round((chips / bigBlindChips) * 1e6) / 1e6;
}

type EngineView =
  | {
      ok: true;
      engine: GameState;
      bigBlindChips: number;
      /**
       * 用户已经录进来的公共牌（**按街切片**的原料）。
       *
       * 增量路径在结算下注轮之后必须能回答「公共牌够不够推进下一街」，
       * 而引擎状态里的 `board` 只有 `advanceStreet` 跑过之后才有牌 ——
       * 因此必须把原始牌面一起带出来，否则两条路径又会分歧。
       */
      boardCards: readonly Card[];
    }
  | { ok: false; issues: readonly TableIssue[] };

/** 从牌桌状态重放出引擎状态（PREVIEW 模式，不要求轮到 Hero） */
export function engineViewOf(state: PokerTableState): EngineView {
  const adapted = tableStateToManualHandInput(state);
  if (!adapted.ok) return { ok: false, issues: adapted.issues };
  const parsed = parseManualInput(adapted.input);
  if (!parsed.ok) {
    return {
      ok: false,
      issues: parsed.issues.map((i) => ({ code: 'INTERNAL_ERROR' as const, message: i.message })),
    };
  }
  const rebuilt = reconstructGameState(parsed.value, { mode: ReconstructMode.PREVIEW });
  if (!rebuilt.ok) {
    return {
      ok: false,
      issues: rebuilt.issues.map((i) => ({ code: 'ILLEGAL_ACTION' as const, message: i.message })),
    };
  }
  return {
    ok: true,
    engine: rebuilt.state,
    bigBlindChips: parsed.value.bigBlindBB,
    boardCards: parsed.value.board,
  };
}

function describeIssueList(issues: readonly Issue[]): string {
  return issues.map((i) => String(i.code)).join('；') || '未给出具体原因';
}

/* ============================================================
 * 记录一条行动
 * ============================================================ */

/**
 * 应用一条行动并把它写进行动历史。
 *
 * 步骤（顺序刻意固定）：
 * 1. 重放当前历史 → 引擎状态
 * 2. `actorOnTurn` 得到行动者（**前端不参与**）
 * 3. 组 `ActionCommand` 交给 `applyAction`（由 Poker Core 判定合法性）
 * 4. 把**实际发生的事**写进 `ManualAction`（金额用引擎算出来的值，不是请求里的值）
 * 5. 用新历史再重放一次，**断言与第 3 步的结果逐位一致**
 */
export function applyTableAction(
  state: PokerTableState,
  request: TableActionRequest,
): TableOpOutcome {
  const view = engineViewOf(state);
  if (!view.ok) return fail(view.issues);

  const { engine, bigBlindChips } = view;
  const actorId = actorOnTurn(engine);
  if (actorId === null) {
    return fail([
      {
        code: 'NO_ACTOR',
        message:
          engine.phase === 'COMPLETE'
            ? '本手已经结束，没有可以行动的人。'
            : '当前没有待行动的人（本街下注轮已结束）。请选择公共牌或点「下一手」。',
      },
    ]);
  }
  const actor = playerById(engine, actorId);
  if (actor === undefined) {
    return fail([{ code: 'INTERNAL_ERROR', message: `行动者 ${actorId} 不在牌局中（状态已损坏）` }]);
  }

  const command: ActionCommand = {
    playerId: actorId,
    type: ACTION_TYPE_MAP[request.type],
    ...(request.amountChips !== undefined ? { amount: request.amountChips } : {}),
    manuallyEntered: true,
  };

  const result = applyAction(engine, command);
  if (!result.ok) {
    return fail([
      {
        code: 'ILLEGAL_ACTION',
        message:
          `「${actor.name}」的这个动作被规则拒绝：${describeIssueList(result.issues)}。` +
          '界面上只显示合法动作，若出现这一条请把牌桌状态截图反馈（属于界面/引擎不同步）。',
      },
    ]);
  }

  /*
   * ---- 规范状态：应用动作之后**必须结算下注轮** ----
   *
   * `applyAction` 只标记「本街下注轮已结束」，从不动 `street`
   * （见 `streetAdvance.ts` 的职责边界）。而重放侧只要公共牌够就会推进街道。
   * 少了下面这一步，两条路径就会在「关掉本街下注轮的那一条动作」上分叉，
   * 自检随即拒绝一个**完全合法**的动作 —— 这就是 HOTFIX 001 的现场现象
   * （9 座桌 SB 的 `CALL 1.75`，即关掉翻牌前下注轮那一步）。
   *
   * 这里与重放侧**共用同一个实现**；公共牌不够时它只是停住，
   * 于是两边同样停在当前街 —— 一致。
   */
  const settled = settleCanonicalStreet(result.state, view.boardCards);

  const after = settled.state;
  const record = after.actions[after.actions.length - 1]!;
  const committed = actor.position === record.position
    ? playerById(after, actorId)!.committedByStreet[record.street]
    : 0;

  // `ManualAction.amountBB` 的语义：
  //   BET / RAISE → **加注到**的本街总额；CALL → 本次投入；
  //   ALL_IN → **不填**（引擎的 `doAllIn` 只接受「本次投入的剩余筹码」，
  //            写成总额会在已有投入时被 `ALLIN_AMOUNT_MISMATCH` 拒绝 ——
  //            红队 V-ALLIN 命中的就是这个）；
  //   CHECK / FOLD → 不填。
  let amountBB: number | undefined;
  if (request.type === 'CALL') {
    amountBB = chipsToBB(record.amount, bigBlindChips);
  } else if (request.type === 'BET' || request.type === 'RAISE') {
    amountBB = chipsToBB(committed, bigBlindChips);
  }

  const manualAction: ManualAction = {
    position: actor.position as Position,
    type: request.type,
    ...(amountBB !== undefined ? { amountBB } : {}),
    street: record.street,
  };

  const next = appendAction(state, manualAction, {
    folded: after.players.find((p) => p.id === actorId)!.folded,
    allIn: after.players.find((p) => p.id === actorId)!.allIn,
  });

  // ---- 重放等价自检（**落库后立刻验证**）----
  const verify = engineViewOf(next);
  if (!verify.ok) {
    return fail([
      {
        code: 'INTERNAL_ERROR',
        message:
          '内部一致性检查失败：刚记录的行动无法重放。' +
          `（${verify.issues.map((i) => i.message).join('；')}）这一步已被拒绝，牌桌状态未改变。`,
      },
    ]);
  }
  const before = stateFingerprintOf(after);
  const replayed = stateFingerprintOf(verify.engine);
  if (before !== replayed) {
    return fail([
      {
        code: 'INTERNAL_ERROR',
        message:
          '内部一致性检查失败：应用后的状态与重新重放出来的状态**不一致**。' +
          '这一步已被拒绝（宁可拒绝，也不能让牌桌显示与分析用的状态分叉）。' +
          `\n应用：${before}\n重放：${replayed}`,
      },
    ]);
  }

  return ok(next);
}

/* ============================================================
 * 清空座位（带本手选择）
 * ============================================================ */

function clearSeatWithChoice(
  state: PokerTableState,
  seatId: string,
  choice: ActiveHandLeaveChoice,
): TableOpOutcome {
  if (choice === ActiveHandLeaveChoice.CANCEL) {
    // 取消 = 什么都没发生。
    //
    // ⚠️ 刻意**不**走 `commit`：那样会平白往撤销栈里压一条「无操作」记录，
    // 使用者按一次撤销会看到界面毫无变化（却消耗了一次撤销机会）。
    return ok(state);
  }

  if (choice === ActiveHandLeaveChoice.FOLD_AND_LEAVE) {
    // 先走**引擎**记一次弃牌（绝不自己伪造行动），再标记离桌。
    // 若此时并没轮到他，`applyTableAction` 会拒绝 —— 那正是我们要的：
    // 不能替一个还没轮到的人弃牌。
    const view = engineViewOf(state);
    if (!view.ok) return fail(view.issues);
    const actorId = actorOnTurn(view.engine);
    const actor = actorId !== null ? playerById(view.engine, actorId) : undefined;
    const seat = state.seats.find((s) => s.seatId === seatId);

    if (seat === undefined) return fail([{ code: 'SEAT_NOT_FOUND', message: `找不到座位 ${seatId}` }]);
    if (actor?.position !== seat.logicalPosition) {
      return fail([
        {
          code: 'NEEDS_LEAVE_DECISION',
          message:
            '现在没有轮到他行动，因此不能「本手视为弃牌并离桌」—— ' +
            '替一个还没轮到的人弃牌会伪造一条行动记录。请改选「仅标记手后离桌」，' +
            '或先在牌桌上录到他的回合再弃牌。',
        },
      ]);
    }

    const folded = applyTableAction(state, { type: 'FOLD' });
    if (!folded.ok) return folded;
    return markLeavingAfterHand(folded.state, seatId);
  }

  return markLeavingAfterHand(state, seatId);
}

function stripUndo(state: PokerTableState): Omit<PokerTableState, 'undo'> {
  const { undo: _undo, ...core } = state;
  void _undo;
  return core;
}
void stripUndo;

/* ============================================================
 * 下一手：需要引擎给出「剩余筹码」
 * ============================================================ */

function remainingStacksOf(
  state: PokerTableState,
): Readonly<Partial<Record<Position, number>>> | null {
  const view = engineViewOf(state);
  if (!view.ok) return null;
  const out: Partial<Record<Position, number>> = {};
  for (const player of view.engine.players) {
    out[player.position] = Number((player.remainingStack / view.bigBlindChips).toFixed(4));
  }
  return Object.freeze(out);
}

/* ============================================================
 * 总入口
 * ============================================================ */

/**
 * 应用一个牌桌操作。
 *
 * **纯函数**：不读文件、不访问网络、不依赖时间。
 * 同一个 (state, op) 永远得到同一个结果 —— 这是差分的测试前提。
 */
export function applyTableOp(state: PokerTableState, op: TableOp): TableOpOutcome {
  switch (op.kind) {
    case 'NEW_TABLE':
      return newTable(state);
    case 'NEXT_HAND':
      return nextHand(state, state.handActive ? remainingStacksOf(state) : null);
    case 'RESET_HAND':
      return resetHand(state);
    case 'ADD_PLAYER':
      /*
       * 🔴 **PLAYER PROFILE EXPLOIT V1**：把可选身份透传给 `addPlayer`。
       *
       * 不传 ⇒ 与修复前**逐位一致**（自动 `p{n}` + 「玩家N」）；
       * 传 `playerId` ⇒ 让这位已保存的玩家入座（其历史统计由 `playerHistory` 注入）。
       */
      return addPlayer(state, op.seatId, {
        ...(op.playerId === undefined ? {} : { playerId: op.playerId }),
        ...(op.displayName === undefined ? {} : { displayName: op.displayName }),
      });
    case 'FILL_EMPTY_SEATS':
      return fillEmptySeats(state);
    case 'CLEAR_SEAT':
      if (op.activeHandChoice !== undefined) {
        return clearSeatWithChoice(state, op.seatId, op.activeHandChoice);
      }
      return clearSeat(state, op.seatId);
    case 'REPLACE_PLAYER':
      return replacePlayer(state, op.seatId);
    case 'SIT_OUT':
      return sitOut(state, op.seatId);
    case 'SIT_IN':
      return sitIn(state, op.seatId);
    case 'SET_STACK':
      return setStack(state, op.seatId, op.stackBB);
    case 'SET_PROFILE':
      return setProfile(state, op.seatId, op.quickProfile);
    case 'SET_DYNAMIC_HINT':
      return setDynamicHint(state, op.seatId, op.dynamicHint);
    case 'CLEAR_ALL_VILLAINS':
      return clearAllVillains(state);
    case 'SET_ENVIRONMENT':
      return setEnvironment(state, op.environment);
    case 'SET_TABLE_SIZE':
      return setTableSize(state, op.tableSize);
    case 'SET_HERO_POSITION':
      return setHeroPosition(state, op.position);
    case 'SET_BUTTON':
      return setButton(state, op.seatId);
    case 'SET_HERO_CARD':
      return setHeroCard(state, op.card);
    case 'CLEAR_HERO_CARDS':
      return clearHeroCards(state);
    case 'SET_BOARD_CARD':
      return setBoardCard(state, op.card, op.slot);
    case 'CLEAR_BOARD':
      return clearBoard(state);
    case 'ACT':
      return applyTableAction(state, op.action);
    case 'UNDO':
      return undo(state);
    default: {
      const exhaustive: never = op;
      return fail([
        { code: 'INTERNAL_ERROR', message: `未知操作：${JSON.stringify(exhaustive)}` },
      ]);
    }
  }
}

export { computePot, Street };
