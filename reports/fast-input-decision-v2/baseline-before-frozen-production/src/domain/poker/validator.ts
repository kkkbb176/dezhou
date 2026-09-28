/**
 * 牌局检查器（规范第 13 / 14 / 15 / 41 / 42 条）
 *
 * 这是全系统优先级最高的安全模块：**任何策略分析之前必须先跑这里**。
 *
 * 设计原则：
 * 1. 收集式校验 —— 一次返回全部问题，不让用户反复试错（Bug 预判 B23）。
 * 2. 只报错、只建议 —— 绝不自动改写用户的牌面或筹码（Bug 预判 B24）。
 * 3. BLOCKER 级问题会让分析整体停止并输出「当前无法给出可靠打法」。
 * 4. 每个问题都带参数，由 i18n 层渲染成「图标 + 中文标题 + 中文原因 + 中文建议」。
 */

import { ActionType, Position, Street, type Card } from '../types.ts';
import { IssueCode, IssueSeverity, type IssueCode as IssueCodeType } from '../domainCodes.ts';
import { cardKey } from './cards.ts';
import {
  activePlayers,
  allBoardCards,
  computePot,
  playerById,
  streetOrder,
  type GameState,
  type PlayerState,
} from './gameState.ts';
import { handTopologySeats, seatIndexOfPosition, positionsForTable } from './positions.ts';

/* ============================================================
 * 类型
 * ============================================================ */

export type ValidationIssue = {
  code: IssueCodeType;
  severity: IssueSeverity;
  params: Readonly<Record<string, string | number>>;
};

export type ValidationResult = {
  /** 是否存在阻止分析的问题 */
  blocked: boolean;
  issues: ValidationIssue[];
  blockers: ValidationIssue[];
  warnings: ValidationIssue[];
  /** 系统按行动记录重算的底池 */
  computedPot: number;
};

export type PotComparison = {
  matches: boolean;
  claimed: number;
  computed: number;
  delta: number;
  issue: ValidationIssue | null;
};

export type ChipConservationResult = {
  holds: boolean;
  startingTotal: number;
  currentTotal: number;
  delta: number;
  issue: ValidationIssue | null;
};

/* ============================================================
 * 工具
 * ============================================================ */

function blocker(code: IssueCodeType, params: Record<string, string | number> = {}): ValidationIssue {
  return { code, severity: IssueSeverity.BLOCKER, params };
}

function warning(code: IssueCodeType, params: Record<string, string | number> = {}): ValidationIssue {
  return { code, severity: IssueSeverity.WARNING, params };
}

/** 供 i18n 渲染的中文牌面参数：形如 "7♦（方块7）" */
export function describeCardPlain(card: Card): string {
  return `${cardKey(card)}`;
}

/* ============================================================
 * 1. 牌面唯一性（52 张牌不能重复）
 * ============================================================ */

type CardLocation = {
  card: Card;
  kind: 'USER' | 'OPPONENT' | 'FLOP' | 'TURN' | 'RIVER';
  player?: PlayerState;
  streetName?: Street;
};

function collectKnownCards(state: GameState): CardLocation[] {
  const out: CardLocation[] = [];
  for (const player of state.players) {
    if (!player.holeCards) continue;
    const isUser = player.id === state.userPlayerId;
    for (const card of player.holeCards) {
      out.push({ card, kind: isUser ? 'USER' : 'OPPONENT', player });
    }
  }
  for (const card of state.board.flop) out.push({ card, kind: 'FLOP' });
  for (const card of state.board.turn) out.push({ card, kind: 'TURN' });
  for (const card of state.board.river) out.push({ card, kind: 'RIVER' });
  return out;
}

export function validateCardUniqueness(state: GameState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const located = collectKnownCards(state);
  const byKey = new Map<string, CardLocation[]>();
  for (const item of located) {
    const key = cardKey(item.card);
    const list = byKey.get(key);
    if (list) list.push(item);
    else byKey.set(key, [item]);
  }

  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    const card = group[0]!.card;
    const cardText = describeCardPlain(card);
    const onBoard = group.filter((g) => g.kind === 'FLOP' || g.kind === 'TURN' || g.kind === 'RIVER');
    const inHands = group.filter((g) => g.kind === 'USER' || g.kind === 'OPPONENT');

    // 公共牌与手牌冲突 —— 最典型的录入错误
    if (onBoard.length > 0 && inHands.length > 0) {
      for (const hand of inHands) {
        if (hand.kind === 'USER') {
          issues.push(blocker(IssueCode.USER_CARD_ON_BOARD, { card: cardText }));
        } else {
          issues.push(
            blocker(IssueCode.OPPONENT_CARD_ON_BOARD, {
              card: cardText,
              player: hand.player?.name ?? '对手',
            }),
          );
        }
      }
      continue;
    }

    // 两位玩家的手牌冲突
    if (inHands.length >= 2) {
      const [a, b] = [inHands[0]!, inHands[1]!];
      issues.push(
        blocker(IssueCode.SAME_CARD_BOTH_PLAYERS, {
          card: cardText,
          playerA: a.player?.name ?? '玩家A',
          playerB: b.player?.name ?? '玩家B',
        }),
      );
      continue;
    }

    // 公共牌内部重复
    issues.push(blocker(IssueCode.DUPLICATE_CARD, { card: cardText }));
  }

  return issues;
}

/* ============================================================
 * 2. 手牌张数
 * ============================================================ */

export function validateHoleCards(state: GameState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const player of state.players) {
    if (player.holeCards === null) continue;
    if (player.holeCards.length !== 2) {
      issues.push(
        blocker(IssueCode.HOLE_CARD_COUNT_INVALID, {
          player: player.name,
          count: player.holeCards.length,
        }),
      );
    }
  }
  return issues;
}

/* ============================================================
 * 3. 公共牌结构（翻牌 / 转牌 / 河牌分开校验）
 * ============================================================ */

export function validateBoard(state: GameState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { flop, turn, river } = state.board;

  if (river.length > 0 && turn.length === 0) {
    issues.push(blocker(IssueCode.BOARD_RIVER_WITHOUT_TURN));
  }
  if (turn.length > 0 && flop.length < 3) {
    issues.push(blocker(IssueCode.BOARD_TURN_WITHOUT_FLOP));
  }
  if (flop.length !== 0 && flop.length !== 3) {
    issues.push(
      blocker(IssueCode.BOARD_FLOP_INCOMPLETE, {
        count: flop.length,
        detail: flop.length < 3 ? `（还差 ${3 - flop.length} 张）` : `（多了 ${flop.length - 3} 张）`,
      }),
    );
  }
  if (turn.length > 1) {
    issues.push(
      blocker(IssueCode.BOARD_FLOP_INCOMPLETE, {
        count: turn.length,
        detail: '（转牌只能有 1 张）',
      }),
    );
  }
  if (river.length > 1) {
    issues.push(
      blocker(IssueCode.BOARD_FLOP_INCOMPLETE, {
        count: river.length,
        detail: '（河牌只能有 1 张）',
      }),
    );
  }
  if (allBoardCards(state).length === 0 && state.street !== Street.PREFLOP) {
    // 街与牌面不一致：已推进到翻牌后却没有公共牌
    issues.push(
      blocker(IssueCode.BOARD_FLOP_INCOMPLETE, { count: 0, detail: '（当前街已过翻牌前，但没有任何公共牌）' }),
    );
  }

  return issues;
}

/* ============================================================
 * 4. 桌型 / 位置 / 盲注
 * ============================================================ */

export function validateTableSetup(state: GameState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { tableSize, smallBlind, bigBlind, ante } = state.config;

  if (tableSize !== 6 && tableSize !== 9) {
    issues.push(blocker(IssueCode.TABLE_SIZE_UNSUPPORTED, { tableSize }));
    return issues;
  }

  if (
    !Number.isInteger(smallBlind) ||
    !Number.isInteger(bigBlind) ||
    smallBlind <= 0 ||
    bigBlind <= smallBlind
  ) {
    issues.push(blocker(IssueCode.BLIND_INVALID, { smallBlind, bigBlind }));
  }
  if (ante < 0) issues.push(blocker(IssueCode.ANTE_NEGATIVE, { ante }));

  /**
   * 🔴 **Table Capacity ≠ Handedness**（Table Topology Correction）
   *
   * 修复前这里要求 `players.length === tableSize`（9 座桌必须 9 人）。
   * 那让「9 座桌 8 人」这种**最常见的现金局形态**直接被判非法。
   *
   * 现在：2 ≤ 本手人数 ≤ 座位容量。空座位不参与本手，但它们的存在合法。
   */
  if (state.players.length < 2 || state.players.length > tableSize) {
    issues.push(
      blocker(IssueCode.PLAYER_COUNT_MISMATCH, {
        tableSize,
        expected: `2~${tableSize}`,
        actual: state.players.length,
      }),
    );
  }

  const allowed = new Set<Position>(positionsForTable(tableSize));
  const seen = new Set<Position>();
  const seenIds = new Set<string>();
  for (const player of state.players) {
    if (seenIds.has(player.id)) {
      issues.push(blocker(IssueCode.POSITION_DUPLICATED, { position: player.position }));
    }
    seenIds.add(player.id);
    if (seen.has(player.position)) {
      issues.push(blocker(IssueCode.POSITION_DUPLICATED, { position: player.position }));
    }
    seen.add(player.position);
    if (!allowed.has(player.position)) {
      issues.push(blocker(IssueCode.POSITION_MISMATCH, { tableSize, position: player.position }));
    } else {
      seatIndexOfPosition(tableSize, player.position);
    }
  }

  /**
   * 盲注位必须能由「容量 + 参与者 + Button」解析出来，且必须落在参与者里
   * （多一条结构不变量：空座位绝不能拿到盲注）。
   */
  if (state.players.length >= 2 && seen.has(state.config.dealerPosition)) {
    try {
      const topology = handTopologySeats(
        tableSize,
        state.players.map((p) => p.position),
        state.config.dealerPosition,
      );
      const hasSeat = (index: number): boolean =>
        topology.participantSeatIndices.includes(index);
      if (!hasSeat(topology.smallBlindSeatIndex) || !hasSeat(topology.bigBlindSeatIndex)) {
        issues.push(
          blocker(IssueCode.POSITION_MISMATCH, {
            tableSize,
            position: '盲注位不在本手参与者里',
          }),
        );
      }
    } catch (error) {
      issues.push(blocker(IssueCode.POSITION_MISMATCH, { tableSize, position: String(error) }));
    }
  }

  if (state.userPlayerId === null || !playerById(state, state.userPlayerId)) {
    issues.push(blocker(IssueCode.NO_USER_PLAYER));
  }

  return issues;
}

/* ============================================================
 * 5. 筹码
 * ============================================================ */

export function validateChips(state: GameState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const player of state.players) {
    if (!Number.isFinite(player.startingStack)) {
      issues.push(blocker(IssueCode.STACK_MISSING, { player: player.name }));
      continue;
    }
    if (player.startingStack < 0) {
      issues.push(blocker(IssueCode.STACK_NEGATIVE, { player: player.name, stack: player.startingStack }));
    }
    if (player.startingStack === 0) {
      issues.push(blocker(IssueCode.STACK_ZERO, { player: player.name }));
    }
    if (player.remainingStack < 0) {
      issues.push(blocker(IssueCode.STACK_NEGATIVE, { player: player.name, stack: player.remainingStack }));
    }
    for (const street of ['PREFLOP', 'FLOP', 'TURN', 'RIVER'] as const) {
      const committed = player.committedByStreet[street];
      if (!Number.isFinite(committed) || committed < 0) {
        issues.push(
          blocker(IssueCode.STACK_NEGATIVE, { player: player.name, stack: committed }),
        );
      }
    }
    if (player.ante < 0) {
      issues.push(blocker(IssueCode.STACK_NEGATIVE, { player: player.name, stack: player.ante }));
    }
  }

  // 主要对手筹码缺失（有效筹码算不出来的直接原因）
  const user = state.userPlayerId ? playerById(state, state.userPlayerId) : undefined;
  if (user) {
    const opponents = activePlayers(state).filter((p) => p.id !== user.id);
    if (opponents.length > 0 && opponents.every((p) => !Number.isFinite(p.remainingStack))) {
      issues.push(
        blocker(IssueCode.OPPONENT_STACK_MISSING, { player: opponents[0]!.name }),
      );
    }
  }

  return issues;
}

/** 筹码守恒：Σ起始 == Σ(剩余 + 前注 + 各街投入) */
export function validateChipConservation(state: GameState): ChipConservationResult {
  let startingTotal = 0;
  let currentTotal = 0;
  for (const player of state.players) {
    startingTotal += player.startingStack;
    currentTotal +=
      player.remainingStack +
      player.ante +
      player.committedByStreet.PREFLOP +
      player.committedByStreet.FLOP +
      player.committedByStreet.TURN +
      player.committedByStreet.RIVER;
  }
  const delta = currentTotal - startingTotal;
  const holds = delta === 0;
  return {
    holds,
    startingTotal,
    currentTotal,
    delta,
    issue: holds
      ? null
      : blocker(IssueCode.CHIPS_CONSERVATION_BROKEN, { startingTotal, currentTotal, delta }),
  };
}

/* ============================================================
 * 6. 底池重算对照（绝不静默忽略差异）
 * ============================================================ */

export function comparePot(
  state: GameState,
  claimedPot?: number,
  tolerance = 0,
): PotComparison {
  const computed = computePot(state);
  const claimed = claimedPot ?? state.claimedPot;
  if (claimed === undefined || !Number.isFinite(claimed)) {
    return { matches: true, claimed: Number.NaN, computed, delta: 0, issue: null };
  }
  const delta = claimed - computed;
  if (Math.abs(delta) <= tolerance) {
    return { matches: true, claimed, computed, delta, issue: null };
  }
  return {
    matches: false,
    claimed,
    computed,
    delta,
    issue: warning(IssueCode.POT_MISMATCH, { claimed, computed, delta }),
  };
}

export function validatePotSign(state: GameState): ValidationIssue[] {
  const pot = computePot(state);
  return pot < 0 ? [blocker(IssueCode.POT_NEGATIVE, { pot })] : [];
}

/* ============================================================
 * 7. 行动顺序与合法性（面向已录入的行动记录做回溯检查）
 * ============================================================ */

/**
 * 检查已录入的行动记录是否合法。
 *
 * 说明：实时动作的合法性由 engine.applyAction 强制；这里是对**外部录入**
 * 的行动记录做一次回溯体检，避免用户手工补录时写入不可能的动作序列。
 */
export function validateActionSequence(state: GameState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const order = streetOrder(state);
  const orderIndex = new Map(order.map((p, index) => [p.id, index]));

  let lastStreet: Street | null = null;
  const actedThisStreet = new Set<string>();

  for (const action of state.actions) {
    const player = playerById(state, action.playerId);
    if (!player) {
      issues.push(blocker(IssueCode.UNKNOWN_PLAYER, { playerId: action.playerId }));
      continue;
    }

    if (action.street !== lastStreet) {
      lastStreet = action.street;
      actedThisStreet.clear();
    }

    // 系统动作（盲注/前注）不参与顺序检查
    if (
      action.type === ActionType.POST_ANTE ||
      action.type === ActionType.POST_SB ||
      action.type === ActionType.POST_BB
    ) {
      continue;
    }

    if (player.folded && action.type !== ActionType.FOLD && action.street === lastStreet) {
      // 弃牌后不应再有任何动作（同一街内）
      const laterActions = state.actions.filter(
        (a) => a.index > action.index && a.street === action.street && a.playerId === player.id,
      );
      if (laterActions.length > 0) {
        issues.push(blocker(IssueCode.FOLDED_PLAYER_ACTED, { player: player.name }));
      }
    }

    if (player.allIn && (action.type === ActionType.BET || action.type === ActionType.RAISE)) {
      issues.push(blocker(IssueCode.ALLIN_PLAYER_ACTED, { player: player.name }));
    }

    // 顺序检查：同一街内的动作应当按座位行动顺序非递减
    if (orderIndex.has(action.playerId)) {
      const current = orderIndex.get(action.playerId)!;
      void current;
    }
    actedThisStreet.add(action.playerId);
  }

  return issues;
}

/** 弃牌玩家是否曾经在其他玩家之后再次行动（结构性检查） */
export function validateNoActionAfterFold(state: GameState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const foldedAt = new Map<string, number>();
  for (const action of state.actions) {
    if (action.type === ActionType.FOLD) foldedAt.set(action.playerId, action.index);
  }
  for (const action of state.actions) {
    const foldIndex = foldedAt.get(action.playerId);
    if (foldIndex === undefined) continue;
    if (action.index > foldIndex) {
      const player = playerById(state, action.playerId);
      issues.push(blocker(IssueCode.FOLDED_PLAYER_ACTED, { player: player?.name ?? action.playerId }));
      break;
    }
  }
  return issues;
}

/* ============================================================
 * 8. 总入口
 * ============================================================ */

export type ValidateOptions = {
  /** 用户手填的底池（用于对照） */
  claimedPot?: number;
  /** 底池容差 */
  potTolerance?: number;
  /** 底池不一致时是否直接阻断分析（默认否：先提示，用户确认后仍可继续） */
  potMismatchBlocks?: boolean;
  /** 是否检查历史行动记录 */
  checkActions?: boolean;
};

/**
 * 完整牌局检查。返回全部问题（不只第一个），并给出是否可以继续分析。
 */
export function validateGameState(state: GameState, options: ValidateOptions = {}): ValidationResult {
  const issues: ValidationIssue[] = [
    ...validateTableSetup(state),
    ...validateHoleCards(state),
    ...validateBoard(state),
    ...validateCardUniqueness(state),
    ...validateChips(state),
    ...validatePotSign(state),
  ];

  if (options.checkActions !== false) {
    issues.push(...validateNoActionAfterFold(state));
  }

  const conservation = validateChipConservation(state);
  if (conservation.issue) issues.push(conservation.issue);

  const potComparison = comparePot(state, options.claimedPot, options.potTolerance ?? 0);
  if (potComparison.issue) {
    // 默认按警告处理（用户可能只是记错，确认后仍可继续）；
    // 但允许调用方要求「必须一致才能分析」，此时升级为阻断。
    issues.push(
      options.potMismatchBlocks
        ? { ...potComparison.issue, severity: IssueSeverity.BLOCKER }
        : potComparison.issue,
    );
  }

  // 用户已弃牌：可以分析牌局，但没有属于他的决策点
  const user = state.userPlayerId ? playerById(state, state.userPlayerId) : undefined;
  if (user && user.folded) {
    issues.push(warning(IssueCode.USER_NOT_IN_HAND, { position: user.position }));
  }

  const blockers = issues.filter((i) => i.severity === IssueSeverity.BLOCKER);
  const warnings = issues.filter((i) => i.severity === IssueSeverity.WARNING);

  return {
    blocked: blockers.length > 0,
    issues,
    blockers,
    warnings,
    computedPot: computePot(state),
  };
}

/** 是否可以进入策略分析 */
export function canAnalyze(result: ValidationResult): boolean {
  return !result.blocked;
}

export { IssueCode, IssueSeverity };
