/**
 * 演示用牌局夹具（fixtures）
 *
 * 职责：构造可用于演示/测试的**具体牌局**，以及执行动作脚本的小工具。
 *
 * 注意：这里的 `runScript` 会打印动作过程，属于**演示辅助**，
 * 真正的批量静默执行请用 `test/helpers.ts` 的 `act`。
 * 之所以不共用：测试辅助不应该依赖 CLI 输出。
 */

import type { Card, Position, TableSize as TableSizeType } from '../domain/types.ts';
import { TableSize } from '../domain/types.ts';
import { parseCardStrict } from '../domain/poker/cards.ts';
import {
  computePot,
  createGame,
  playerById,
  type GameState,
} from '../domain/poker/gameState.ts';
import { applyAction } from '../domain/poker/engine.ts';
import { actionMainLabel, chips, positionLabel, t } from '../i18n/index.ts';

/** 解析 "Kd Qc 9h" 这类空格分隔的牌面 */
export function parseCards(spec: string): Card[] {
  return spec.split(/\s+/).filter(Boolean).map(parseCardStrict);
}

/** 把范围规格转成引擎所需的组合数组 */
export function toCombos(specs: string[]): Array<[Card, Card]> {
  return specs.map((spec) => {
    const cards = parseCards(spec);
    if (cards.length !== 2) throw new Error(`toCombos: 「${spec}」必须是 2 张牌`);
    return [cards[0]!, cards[1]!] as [Card, Card];
  });
}

/** 位置的完整中文显示（含英文辅助小字） */
export function positionText(state: GameState, position: Position): string {
  return positionLabel(state.config.tableSize, position);
}

/** 当前全部公共牌（翻牌 → 转牌 → 河牌） */
export function boardOf(state: GameState): Card[] {
  return [...state.board.flop, ...state.board.turn, ...state.board.river];
}

/** 演示使用的桌型与起始筹码 */
export const DEMO_TABLE: TableSizeType = TableSize.SIX_MAX;
export const DEMO_STACK = 200_000;

type SeatSeed = { id: string; position: Position; holeCards?: string };

/** 六人桌固定座位：我用庄家位，主要对手用关煞位 */
function buildSeats(userCards: string, villainCards: string): SeatSeed[] {
  return [
    { id: 'utg', position: 'UTG' },
    { id: 'hj', position: 'HJ' },
    { id: 'co', position: 'CO', holeCards: villainCards },
    { id: 'btn', position: 'BTN', holeCards: userCards },
    { id: 'sb', position: 'SB' },
    { id: 'bb', position: 'BB' },
  ];
}

export type DemoGameOptions = {
  userCards?: string;
  villainCards?: string;
  stack?: number;
  board?: { flop?: string; turn?: string; river?: string };
};

/** 构造一手演示牌局（默认：我持 K♥Q♦，关煞位持 9♠9♦） */
export function newDemoGame(options: DemoGameOptions = {}): GameState {
  const {
    userCards = 'Kh Qd',
    villainCards = '9s 9d',
    stack = DEMO_STACK,
    board,
  } = options;

  return createGame({
    id: 'demo-0001',
    config: {
      tableSize: DEMO_TABLE,
      smallBlind: 1_000,
      bigBlind: 2_000,
      ante: 0,
      dealerPosition: 'BTN',
    },
    players: buildSeats(userCards, villainCards).map((seat) => ({
      id: seat.id,
      name: seat.position,
      position: seat.position,
      startingStack: stack,
      holeCards: seat.holeCards ? parseCards(seat.holeCards) : null,
    })),
    userPlayerId: 'btn',
    board: {
      flop: board?.flop ? parseCards(board.flop) : [],
      turn: board?.turn ? parseCards(board.turn) : [],
      river: board?.river ? parseCards(board.river) : [],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

export type ScriptStep = {
  playerId: string;
  type: 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE';
  amount?: number;
};

export type RunScriptOptions = {
  /** 静默执行（不打印逐条动作） */
  quiet?: boolean;
  /** 每一步的回调，便于演示层自行渲染 */
  onStep?: (info: {
    step: ScriptStep;
    pot: number;
    remainingStack: number;
    position: Position;
  }) => void;
};

/**
 * 按脚本执行一串动作。
 *
 * 任何一步被状态机拒绝都会打印中文原因并**停止**（不静默跳过），
 * 因为演示的目的正是展示「非法动作会被拦住」。
 */
export function runScript(
  state: GameState,
  script: readonly ScriptStep[],
  options: RunScriptOptions = {},
): GameState {
  let current = state;
  for (const step of script) {
    const result = applyAction(
      current,
      step.amount === undefined
        ? { playerId: step.playerId, type: step.type }
        : { playerId: step.playerId, type: step.type, amount: step.amount },
    );
    if (!result.ok) {
      console.log(
        `  ✖ ${step.playerId} ${step.type} 被拒绝：` +
          result.issues.map((i) => t(i.code, i.params)).join('；'),
      );
      return current;
    }
    current = result.state;
    const actor = playerById(current, step.playerId)!;
    if (options.quiet) continue;

    const label = positionText(current, actor.position);
    const amountText = step.amount === undefined ? '' : ` ${chips(step.amount)}`;
    const left = `${label} ${actionMainLabel(step.type)}${amountText}`;
    console.log(
      `  ${left.padEnd(30)}底池 ${chips(computePot(current)).padStart(9)}    剩余 ${chips(
        actor.remainingStack,
      ).padStart(9)}`,
    );
    options.onStep?.({
      step,
      pot: computePot(current),
      remainingStack: actor.remainingStack,
      position: actor.position,
    });
  }
  return current;
}
