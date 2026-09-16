/**
 * 测试辅助工具
 *
 * 原则：断言必须具体到「牌面 / 金额 / 序号」，禁止 toBeTruthy 式假绿。
 */

import { parseCardStrict } from '../src/domain/poker/cards.ts';
import {
  createGame,
  type ActionCommand,
  type CreateGameOptions,
  type GameState,
  type PlayerSeed,
} from '../src/domain/poker/gameState.ts';
import { applyAction, advanceStreet, type StateResult } from '../src/domain/poker/engine.ts';
import { Position, TableSize, type Card, type Position as PositionType } from '../src/domain/types.ts';

/** 解析多张牌："As Kd 7c" 或 "AsKd7c" 或 "As,Kd,7c" */
export function C(spec: string): Card[] {
  const tokens = spec
    .split(/[\s,，、/|]+/)
    .flatMap((token) => {
      if (token.length === 2) return [token];
      if (token.length % 2 !== 0) throw new Error(`C: 无法切分「${token}」`);
      const out: string[] = [];
      for (let i = 0; i < token.length; i += 2) out.push(token.slice(i, i + 2));
      return out;
    })
    .filter((x) => x.length > 0);
  return tokens.map(parseCardStrict);
}

/** 一张牌 */
export function c(spec: string): Card {
  return parseCardStrict(spec);
}

/** 六人桌与九人桌的座位顺序 */
export const POSITIONS_6: readonly PositionType[] = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
export const POSITIONS_9: readonly PositionType[] = [
  'UTG',
  'UTG1',
  'UTG2',
  'LJ',
  'HJ',
  'CO',
  'BTN',
  'SB',
  'BB',
];

export type TestGameOptions = {
  tableSize?: 6 | 9;
  smallBlind?: number;
  bigBlind?: number;
  ante?: number;
  /** 每人起始筹码，默认 100 个大盲 */
  stack?: number;
  /**
   * 各玩家起始筹码。
   * **按座位顺序**：6 人桌 = [UTG, HJ, CO, BTN, SB, BB]；
   * 9 人桌 = [UTG, UTG1, UTG2, LJ, HJ, CO, BTN, SB, BB]。
   */
  stacks?: readonly number[];
  /** 指定位置的玩家筹码，例如 { SB: 1000 }（优先于 stacks 与 stack） */
  stacksByPosition?: Partial<Record<PositionType, number>>;
  /** 我的位置，默认 BTN */
  userPosition?: PositionType;
  /** 我的手牌 */
  userCards?: string;
  /** 对手手牌：{ 位置: "AsKd" } */
  holeCards?: Partial<Record<PositionType, string>>;
  /** 公共牌，形如 { flop: "KhQs9s", turn: "Jc", river: "8d" } */
  board?: { flop?: string; turn?: string; river?: string };
  /** 庄家位，默认 BTN */
  dealerPosition?: PositionType;
  id?: string;
};

/** 构造一手标准测试牌局（按座位顺序自动填充玩家） */
export function makeGame(options: TestGameOptions = {}): GameState {
  const tableSize = options.tableSize ?? 6;
  const smallBlind = options.smallBlind ?? 1000;
  const bigBlind = options.bigBlind ?? 2000;
  const stack = options.stack ?? bigBlind * 100;
  const positions = tableSize === 6 ? POSITIONS_6 : POSITIONS_9;
  const userPosition = options.userPosition ?? 'BTN';

  const players: PlayerSeed[] = positions.map((position, index) => {
    const spec = position === userPosition ? options.userCards : options.holeCards?.[position];
    const explicit = options.stacksByPosition?.[position];
    const playerStack = explicit ?? (options.stacks ? (options.stacks[index] ?? stack) : stack);
    return {
      id: position.toLowerCase(),
      name: position,
      position,
      startingStack: playerStack,
      holeCards: spec ? C(spec) : null,
    };
  });

  const board: CreateGameOptions['board'] = {};
  if (options.board?.flop) board.flop = C(options.board.flop);
  if (options.board?.turn) board.turn = C(options.board.turn);
  if (options.board?.river) board.river = C(options.board.river);

  return createGame({
    id: options.id ?? 'test-hand',
    config: {
      tableSize: tableSize === 6 ? TableSize.SIX_MAX : TableSize.NINE_MAX,
      smallBlind,
      bigBlind,
      ante: options.ante ?? 0,
      dealerPosition: options.dealerPosition ?? 'BTN',
    },
    players,
    userPlayerId: userPosition.toLowerCase(),
    board,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

/** 连续执行多个动作；任何一步失败即抛错并给出可读原因 */
export function act(state: GameState, ...commands: ActionCommand[]): GameState {
  let current = state;
  for (const command of commands) {
    const result = applyAction(current, command);
    if (!result.ok) {
      throw new Error(
        `act: 动作 ${command.playerId}/${command.type} 失败：${result.issues
          .map((i) => `${i.code} ${JSON.stringify(i.params)}`)
          .join('；')}`,
      );
    }
    current = result.state;
  }
  return current;
}

/** 期望动作失败，返回失败问题码列表 */
export function expectActionFailure(state: GameState, command: ActionCommand): string[] {
  const result = applyAction(state, command);
  if (result.ok) {
    throw new Error(`expectActionFailure: 动作 ${command.playerId}/${command.type} 本应失败，却成功了`);
  }
  return result.issues.map((i) => i.code);
}

/** 推进街道（发牌） */
export function nextStreet(state: GameState, cards?: string): StateResult {
  return advanceStreet(state, cards ? { cards: C(cards) } : {});
}

/** 连续推进到指定街，自动发牌 */
export function runTo(state: GameState, street: 'FLOP' | 'TURN' | 'RIVER', cards: string): GameState {
  const result = advanceStreet(state, { cards: C(cards) });
  if (!result.ok) {
    throw new Error(`runTo: 推进失败 ${result.issues.map((i) => i.code).join(',')}`);
  }
  if (result.state.street !== street) {
    throw new Error(`runTo: 期望到达 ${street}，实际 ${result.state.street}`);
  }
  return result.state;
}

/** 取玩家 id 的简写 */
export function idOf(position: PositionType): string {
  return position.toLowerCase();
}

export { Position, TableSize };
