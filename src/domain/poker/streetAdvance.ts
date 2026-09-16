/**
 * 街道推进与发牌（从 engine.ts 拆出，保持单文件规模可控）
 *
 * 职责边界（很重要，本项目实际踩过坑）：
 * - **只有这里**会切换 `street` 并发公共牌。
 * - `applyAction` 只负责标记「本街下注轮已结束」（`bettingRoundComplete = true`），
 *   绝不动 `street`。否则会出现「街已切到翻牌、但翻牌还没发」的错位状态，
 *   进而让 advanceStreet 把牌发到错误的街上。
 *
 * 公共牌必须由调用方显式提供 —— 领域层不做随机发牌，保证结果可复现
 * （随机源统一走 infra/rng.ts，并随牌局保存种子）。
 *
 * 规范第 14 条硬要求：
 * - 下注轮未结束 → 拒绝推进，并说明谁还需要跟注多少
 * - 翻牌必须恰好 3 张、转牌 1 张、河牌 1 张，且与已知牌不重复
 */

import { Street, type Card } from '../types.ts';
import { IssueCode } from '../domainCodes.ts';
import { cardKey } from './cards.ts';
import {
  HandPhase,
  allBoardCards,
  cloneState,
  playerById,
  requiredCallAmount,
  type GameState,
} from './gameState.ts';
import {
  blocker,
  fail,
  nextStreet,
  resetStreetState,
  type Issue,
  type StateResult,
} from './engine.ts';

export type AdvanceOptions = {
  /** 本街要发的牌（留空则取用公共牌字段里已预先填好的牌） */
  cards?: readonly Card[];
};

/**
 * 推进到下一街（发牌）。
 *
 * 调用时机：当前街的下注轮已经结束（`bettingRoundComplete === true`）。
 */
export function advanceStreet(state: GameState, options: AdvanceOptions = {}): StateResult {
  if (state.phase === HandPhase.COMPLETE) {
    return fail(state, [blocker(IssueCode.ACTION_AFTER_HAND_OVER)]);
  }
  if (state.street === Street.RIVER) {
    return fail(state, [blocker(IssueCode.STREET_ALREADY_RIVER)]);
  }
  // 本街下注轮必须已经结束
  if (state.phase === HandPhase.BETTING && !state.bettingRoundComplete) {
    const nextId = state.pendingQueue[0];
    const nextPlayer = nextId ? playerById(state, nextId) : undefined;
    return fail(state, [
      blocker(IssueCode.STREET_NOT_COMPLETE, {
        player: nextPlayer ? nextPlayer.name : '（无人可行动）',
        amount: nextId ? requiredCallAmount(state, nextId) : 0,
      }),
    ]);
  }

  const next = cloneState(state);
  const target = nextStreet(next.street);
  const provided = options.cards ? [...options.cards] : takePreFilledCards(next, target);

  const expected = target === Street.FLOP ? 3 : 1;
  const issues = checkNewBoardCards(next, target, provided, expected);
  if (issues.length > 0) return fail(state, issues);

  if (target === Street.FLOP) next.board.flop = provided;
  else if (target === Street.TURN) next.board.turn = provided;
  else next.board.river = provided;

  next.street = target;
  resetStreetState(next);

  /*
   * 无人可行动（全员全下）时：**本街下注轮确实结束了**，但这**不等于**
   * 「已经进入摊牌」。
   *
   * 🔴 修复前这里无条件 `next.phase = HandPhase.SHOWDOWN`。后果：全员全下时
   * 一推进到翻牌，状态就变成「SHOWDOWN + 公共牌只有 3 张」。而摊牌的定义
   * 要求 5 张公共牌全部发出 —— 转牌 / 河牌不但没发，也**没有人会去发**：
   * 下游「按牌面能推多远推多远」的循环只在 `phase === BETTING` 时继续。
   * 这正是规范第 9 条明令禁止的「All-In 不等于可以凭空发牌」：
   * 「下注阶段结束」被当成了「跳过剩余发牌」的许可证。
   *
   * 正确语义：无人可行动 ⇒ 本街结束（`bettingRoundComplete = true`），
   * 但**只有公共牌已经发到河牌**时才算进入摊牌；否则留在 BETTING，
   * 让「按牌面推进」的那一步继续把转牌 / 河牌**如实**发出来。
   * 公共牌不够时推进会被拒绝 —— 停住并如实报告，绝不凭空补牌。
   */
  if (next.pendingQueue.length === 0) {
    next.bettingRoundComplete = true;
    if (next.street === Street.RIVER) next.phase = HandPhase.SHOWDOWN;
  }

  return { ok: true, state: next, issues: [] };
}

/** 若用户在录入界面已预先填好公共牌，则直接取用 */
function takePreFilledCards(state: GameState, target: Street): Card[] {
  if (target === Street.FLOP) return state.board.flop.map((c) => ({ ...c }));
  if (target === Street.TURN) return state.board.turn.map((c) => ({ ...c }));
  return state.board.river.map((c) => ({ ...c }));
}

function checkNewBoardCards(
  state: GameState,
  target: Street,
  cards: readonly Card[],
  expected: number,
): Issue[] {
  const issues: Issue[] = [];
  if (cards.length !== expected) {
    issues.push(
      blocker(IssueCode.BOARD_FLOP_INCOMPLETE, {
        count: cards.length,
        detail: `（${target}需要 ${expected} 张）`,
      }),
    );
    return issues;
  }
  const known = allBoardCards(state);
  const keys = new Set(known.map(cardKey));
  for (const card of cards) {
    if (keys.has(cardKey(card))) {
      issues.push(blocker(IssueCode.DUPLICATE_CARD, { card: `${card.rank}${card.suit}` }));
    }
    keys.add(cardKey(card));
  }
  return issues;
}
