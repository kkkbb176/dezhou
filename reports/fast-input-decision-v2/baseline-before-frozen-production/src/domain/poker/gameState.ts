/**
 * 牌局状态：类型、初始化、盲注与前注、行动队列
 *
 * 规范第 6 / 9 / 10 / 11 / 14 / 15 / 43 / 44 条。
 *
 * 账本的第一性原理：
 *   **底池只有一个数据源 —— 每位玩家在每条街的已投入之和。**
 *   绝不允许「底池」与「已投入」各自累加（Bug 预判 B10 / B11）。
 *
 * 筹码守恒不变量（全流程必须恒成立）：
 *   Σ(剩余筹码) + Σ(前注) + Σ(各街已投入) == Σ(起始筹码)
 */

import {
  ActionType,
  Position,
  Street,
  TableSize,
  type Card,
} from '../types.ts';
import {
  POSITION_ORDER,
  handTopologySeats,
  seatIndexOfPosition,
  type HandTopologySeats,
  type TableSizeType,
} from './positions.ts';
import { cardKey } from './cards.ts';

/* ============================================================
 * 类型定义
 * ============================================================ */

export type GameConfig = {
  /** 桌型：6 人桌或 9 人桌 */
  tableSize: TableSizeType;
  /** 小盲 */
  smallBlind: number;
  /** 大盲 */
  bigBlind: number;
  /** 前注（每人每手，0 表示没有前注） */
  ante: number;
  /**
   * 庄家位。
   * V1 手牌录入固定为庄家位（BTN），但把它显式放进配置里，
   * 使「行动顺序 / 盲注位 / 谁是庄家」全部由配置推导，
   * 而不是在代码各处硬编码 BTN —— 否则将来支持换庄时必然出现
   * 显示顺序与实际行动顺序不一致的隐蔽 Bug。
   */
  dealerPosition: Position;
};

export type PlayerState = {
  id: string;
  name: string;
  seat: number;
  position: Position;
  startingStack: number;
  remainingStack: number;
  /** 已投入的前注（独立字段，绝不与街内投入混算） */
  ante: number;
  /** 各街已投入 */
  committedByStreet: Record<Street, number>;
  folded: boolean;
  allIn: boolean;
  /** 已知底牌（用户必填；对手可选填） */
  holeCards: Card[] | null;
};

export type Board = {
  flop: Card[];
  turn: Card[];
  river: Card[];
};

/**
 * 牌局阶段。
 * - BETTING：正常下注轮，street 表示当前街
 * - SHOWDOWN：河牌下注轮结束，等待摊牌
 * - COMPLETE：牌局结束（仅剩一人，或摊牌结果已记录）
 */
export const HandPhase = {
  BETTING: 'BETTING',
  SHOWDOWN: 'SHOWDOWN',
  COMPLETE: 'COMPLETE',
} as const;
export type HandPhase = (typeof HandPhase)[keyof typeof HandPhase];

export type ActionCommand = {
  playerId: string;
  type: ActionType;
  /**
   * 金额语义（内部统一，避免「加注到」与「加注多少」混淆）：
   * - BET / RAISE / RERAISE / ALL_IN：**加注到**的总额（本街口径）
   * - CALL：本次需要投入的金额
   * - POST_*：投入金额
   * - FOLD / CHECK：忽略该字段
   */
  amount?: number;
  /** 是否由用户手动录入（区别于系统补录） */
  manuallyEntered?: boolean;
  /** 备注 */
  note?: string;
};

export type ActionRecord = {
  index: number;
  street: Street;
  playerId: string;
  position: Position;
  type: ActionType;
  /** 本次实际投入的筹码 */
  amount: number;
  /** 动作执行后的本街总投入（跟注/下注/加注时有效） */
  toAmount: number;
  isAllIn: boolean;
  /** 动作前后底池（便于复盘逐街展示） */
  potBefore: number;
  potAfter: number;
  note?: string;
};

export type GameState = {
  id: string;
  config: GameConfig;
  /** 玩家数组，一手牌内顺序与长度不可变（用 id 索引而不是下标重排） */
  players: PlayerState[];
  board: Board;
  actions: ActionRecord[];
  /** 用户（我）的玩家 id */
  userPlayerId: string | null;
  /** 牌局阶段 */
  phase: HandPhase;
  street: Street;
  /** 本街当前注额（「跟注到」的口径） */
  currentBet: number;
  /** 上一次加注的增量，决定最小加注；翻牌前初始为 1 个大盲 */
  lastRaiseSize: number;
  /** 最近一次主动下注/加注的玩家 */
  lastAggressorId: string | null;
  /** 待行动队列（队首即当前应行动玩家）；队列为空即代表本街下注轮结束 */
  pendingQueue: string[];
  /**
   * 本街下注轮是否已经结束。
   * 与 pendingQueue 的区别：队列为空也可能是因为「全员全下」，
   * 而街道切换必须以本字段为准，避免出现「街已切换但牌未发」的错位。
   */
  bettingRoundComplete: boolean;
  /**
   * 因「全下加注不足最小加注」而失去再加注权的玩家。
   * 对应 TDA 规则：短全下不重开加注，只能跟注或弃牌。
   */
  raiseClosedFor: string[];
  /**
   * **自上一次主动下注/加注以来已经表过态**的玩家。
   *
   * 语义：一旦出现新的下注或加注，所有人的旧表态立即失效，
   * 因为当前注额变了，他们必须重新表态。因此这个列表在每次加注后
   * 会被重置为「只剩加注者本人」。
   *
   * 为什么不能只用「投入额 < 当前注额」判断是否需要行动：
   * 翻牌前大家都溜入时，大盲投入额恰好等于当前注额，
   * 但他仍然有权加注或过牌（大盲的选择权）。这是本项目实际踩到过的坑。
   */
  actedSinceLastAggression: string[];
  /** 抽水（单独字段，不参与筹码守恒校验的口径混淆） */
  rake: number;
  /** 用户手填的底池（用于与系统重算结果对照，可选） */
  claimedPot?: number;
  /** 胜出者（牌局结束后填写） */
  winners?: string[];
  notes?: string;
  createdAt: string;
};

export type PlayerSeed = {
  id: string;
  name: string;
  position: Position;
  startingStack: number;
  holeCards?: readonly Card[] | null;
};

export type CreateGameOptions = {
  id?: string;
  config: GameConfig;
  players: readonly PlayerSeed[];
  /** 用户（我）的玩家 id */
  userPlayerId: string;
  /** 直接填写全部公共牌（可选；留空则逐街推进时录入） */
  board?: Partial<Board>;
  createdAt?: string;
};

/* ============================================================
 * 工具
 * ============================================================ */

export function playerById(state: GameState, playerId: string): PlayerState | undefined {
  return state.players.find((p) => p.id === playerId);
}

export function requirePlayer(state: GameState, playerId: string): PlayerState {
  const player = playerById(state, playerId);
  if (!player) throw new Error(`requirePlayer: 找不到玩家 ${playerId}`);
  return player;
}

export function buttonOf(state: GameState): Position {
  return Position.BTN;
}

/** 庄家位的座位下标（0 起） */
export function buttonSeatIndex(state: GameState): number {
  return state.players.findIndex((p) => p.position === Position.BTN);
}

export function activePlayers(state: GameState): PlayerState[] {
  return state.players.filter((p) => !p.folded);
}

export function playersWhoCanAct(state: GameState): PlayerState[] {
  return state.players.filter((p) => !p.folded && !p.allIn && p.remainingStack > 0);
}

/** 某玩家本街已投入 */
export function committedThisStreet(state: GameState, playerId: string): number {
  return requirePlayer(state, playerId).committedByStreet[state.street];
}

/** 某玩家全部已投入（含前注） */
export function totalCommitted(state: GameState, playerId: string): number {
  const player = requirePlayer(state, playerId);
  return (
    player.ante +
    player.committedByStreet.PREFLOP +
    player.committedByStreet.FLOP +
    player.committedByStreet.TURN +
    player.committedByStreet.RIVER
  );
}

/**
 * 底池重算：底池 == 所有人所有街投入之和 + 前注。
 * 这是底池的**唯一权威公式**（规范第 15 条）。
 */
export function computePot(state: GameState): number {
  let pot = 0;
  for (const player of state.players) {
    pot += player.ante;
    pot += player.committedByStreet.PREFLOP;
    pot += player.committedByStreet.FLOP;
    pot += player.committedByStreet.TURN;
    pot += player.committedByStreet.RIVER;
  }
  return pot;
}

/** 还需要投入多少才能跟注（0 表示不需要跟注） */
export function requiredCallAmount(state: GameState, playerId: string): number {
  const player = requirePlayer(state, playerId);
  const already = player.committedByStreet[state.street];
  const need = state.currentBet - already;
  if (need <= 0) return 0;
  return Math.min(need, player.remainingStack);
}

/* ============================================================
 * 「已实现」对手 —— 唯一权威判据
 * ============================================================ */

/**
 * **已经真正投入过这一手**的玩家 id（Table Topology Correction）。
 *
 * ## 为什么这是一条领域判据，而不是界面/上下文的本地判断
 *
 * 「已实现对手数」被两个地方同时需要：
 *
 * | 消费者 | 用途 |
 * |---|---|
 * | `contextBuilder` | 填 `DecisionContext.realizedOpponentCount` |
 * | `tablePreview` | 提前告知「点分析会不会返回信息不足」 |
 *
 * 两处若各写一份判据，必然有一天分歧 —— 而分歧的表现形式是
 * **界面说「可以分析」、引擎说「信息不足」**，也就是最让使用者
 * 失去信任的那类不一致（红队 V-EFF 命中过完全相同的形态）。
 * 因此把判据放在领域层，**全项目只有一个实现**。
 *
 * ## 判据（三条，缺一不可）
 *
 * 1. **盲注与前注不算** —— 那是**强制**投入，不代表「他决定打这一手」。
 *    把大盲算作已实现，9 人桌的开池就会凭空变成 2 人池。
 * 2. **曾经行动过就算**（含 `CHECK`）—— 翻牌后对手过牌，他仍在池里、
 *    仍会影响权益。`folded` 的玩家由调用方过滤（本函数不重复判断）。
 * 3. **全下一定算** —— 无论是否主动（例如盲注被强制全下），
 *    筹码已经在池里，他**一定**会影响权益。
 *
 * ⚠️ 返回的是**未过滤弃牌**的集合：弃牌判定属于调用方的口径
 *（`contextBuilder` 用 `!folded`，而某些路径还要按 Hero 排除）。
 */
export function realizedOpponentIds(state: GameState): ReadonlySet<string> {
  const forced = new Set<ActionType>([ActionType.POST_SB, ActionType.POST_BB, ActionType.POST_ANTE]);
  const acted = new Set(
    state.actions.filter((a) => !forced.has(a.type)).map((a) => a.playerId),
  );
  const out = new Set<string>();
  for (const player of state.players) {
    if (player.folded) continue;
    if (player.allIn || player.committedByStreet.PREFLOP > state.config.bigBlind || acted.has(player.id)) {
      out.add(player.id);
    }
  }
  return out;
}

/**
 * **还没轮到说话、且还能行动**的玩家 id。
 *
 * 他们没有投入、没有范围、不进权益 —— 只用于如实提示
 * 「后面还有人可能跟进来，实际权益可能更低」。
 *
 * ⚠️ 与前注/盲注无关：本街还没行动的玩家都算（含大盲）。
 */
export function yetToActIds(state: GameState): ReadonlySet<string> {
  const forced = new Set<ActionType>([ActionType.POST_SB, ActionType.POST_BB, ActionType.POST_ANTE]);
  const acted = new Set(
    state.actions.filter((a) => !forced.has(a.type)).map((a) => a.playerId),
  );
  const out = new Set<string>();
  for (const player of state.players) {
    if (player.folded || player.allIn || player.remainingStack <= 0) continue;
    if (!acted.has(player.id)) out.add(player.id);
  }
  return out;
}

/** 最小加注到的总额 */
export function minRaiseTo(state: GameState): number {
  return state.currentBet + state.lastRaiseSize;
}

/**
 * 本街是否已经结束（可以推进到下一街）。
 *
 * ## 🔴 「一个人没法跟自己下注」（2026-09 边池轮）
 *
 * 除了「所有人已跟平」之外，还有一条同样重要的结束条件：
 *
 * > 若**能行动的玩家不超过一人**，且他不欠跟注 ⇒ 本街结束。
 *
 * 其余人都全下（或弃牌）时，最后那名有筹码的玩家无论下注多少都不会有人跟，
 * 多出的部分按规则直接退回 —— 现实中这时直接跑牌到摊牌。
 * 修复前这里没有这条判据，于是系统会为**现实中不存在的决策点**输出建议。
 *
 * ⚠️ 它必须与 `engine.ts` 的 `needsToAct` **同源**：
 * 一处说「该他行动」、另一处说「本街已结束」会互相打架 ——
 * 而那种打架的表现形式是队列里挂着一个永远不会结束的玩家（实测踩到过：
 * 显式下注已被拒，`pendingQueue` 却仍是 `["btn"]`）。
 */
export function isBettingRoundComplete(state: GameState): boolean {
  let canActCount = 0;
  let owesCall = false;

  for (const player of state.players) {
    if (player.folded || player.allIn) continue;
    if (player.remainingStack === 0) continue;
    canActCount += 1;
    if (player.committedByStreet[state.street] < state.currentBet) owesCall = true;
  }

  /* 一个人都没法行动 ⇒ 本街自然结束（全部全下 / 只剩一人） */
  if (canActCount === 0) return true;

  /*
   * 只剩一个人能行动：
   * - 他**欠跟注** ⇒ 他仍要行动（跟注或弃牌），本街未结束
   * - 他不欠 ⇒ 没人是他的对手，本街结束（跑牌到摊牌）
   */
  if (canActCount === 1) return !owesCall;

  /* 多人能行动 ⇒ 所有人都必须已跟平 */
  return !owesCall;
}

/**
 * 本街行动顺序（按**座位环绕**，已过滤弃牌/全下）。
 *
 * 🔴 Table Topology Correction：修复前它按「满桌位置顺序」推导，
 * 于是空座位会占据顺序里的位置（后续被 filter 掉，看似无害），
 * 但**盲注位与第一个行动者**是按满桌算的 —— 有空座位时就错位。
 *
 * 现在按拓扑快照的座位下标排序：从本街第一个行动者开始，
 * 沿物理座位顺时针环绕，跳过不在本手的人。
 */
export function streetOrder(state: GameState): PlayerState[] {
  const topology = stateTopology(state);
  const ring = POSITION_ORDER[state.config.tableSize];
  const bySeatIndex = new Map(
    state.players.map((p) => [seatIndexOfPosition(state.config.tableSize, p.position), p]),
  );

  /*
   * 🔴 翻牌后的起点是**小盲**，但**单挑例外**（Table Topology Correction 缺陷修复）：
   * 单挑时小盲 = Button，而翻牌后 Button **最后**行动 —— 所以起点必须是大盲。
   * 修复前统一取 `smallBlindSeatIndex`，于是单挑翻牌后先问 Button，
   * 连带把翻牌前的待行动队列也算错（实测 BTN CALL 被拒 `CALL_AMOUNT_ILLEGAL`、
   * BB CHECK 被拒 `NOT_PLAYERS_TURN`，单挑根本录不进去）。
   */
  const startIndex =
    state.street === Street.PREFLOP
      ? topology.firstToActSeatIndex
      : topology.handedness === 2
        ? topology.bigBlindSeatIndex
        : topology.smallBlindSeatIndex; // 翻牌后从小盲开始，跳过已弃牌/全下

  const out: PlayerState[] = [];
  for (let step = 0; step < ring.length; step += 1) {
    const index = (startIndex + step) % ring.length;
    const player = bySeatIndex.get(index);
    if (player !== undefined) out.push(player);
  }
  return out;
}

/**
 * 从 `GameState` 复原本手的座位拓扑。
 *
 * ⚠️ 刻意**重算**而不是把拓扑塞进 `GameState`：
 * `GameState` 是 Poker Core 的结构，而拓扑完全由
 * 「容量 + 参与者座位 + Button 座位」决定 —— 存两份必然有一天不一致。
 */
export function stateTopology(state: GameState): HandTopologySeats {
  return handTopologySeats(
    state.config.tableSize,
    state.players.map((p) => p.position),
    state.config.dealerPosition,
  );
}

/** 全部公共牌（翻牌 → 转牌 → 河牌，顺序固定） */
export function allBoardCards(state: GameState): Card[] {
  return [...state.board.flop, ...state.board.turn, ...state.board.river];
}

/**
 * 街道与公共牌的一致性检查：
 * 公共牌张数决定实际处于哪条街（防止「已发河牌却停在翻牌前」的分析错位）。
 */
export function streetFromBoard(board: Board): Street {
  if (board.river.length > 0) return Street.RIVER;
  if (board.turn.length > 0) return Street.TURN;
  if (board.flop.length > 0) return Street.FLOP;
  return Street.PREFLOP;
}

/* ============================================================
 * 初始化
 * ============================================================ */

function emptyStreetRecord(): Record<Street, number> {
  return { PREFLOP: 0, FLOP: 0, TURN: 0, RIVER: 0 };
}

/**
 * 创建一手牌。
 *
 * 抛错场合（配置级错误，必须在进入分析前拦住）：
 * - 不支持的桌型
 * - 玩家数量与桌型不匹配
 * - 位置与桌型不匹配 / 位置重复
 * - 盲注不合法、前注为负
 * - 起始筹码为负
 */
export function createGame(options: CreateGameOptions): GameState {
  const { config, players: seeds, userPlayerId } = options;

  if (config.tableSize !== TableSize.SIX_MAX && config.tableSize !== TableSize.NINE_MAX) {
    throw new Error(`createGame: 不支持的桌型 ${config.tableSize}`);
  }
  /*
   * 🔴 **Table Capacity ≠ Handedness**（Table Topology Correction）
   *
   * 修复前这里要求 `seeds.length === config.tableSize`：
   * 9 座桌只要有一个人离开，整张桌子**再也发不出牌**。
   * 那是把「牌桌有几个座位」与「本手几个人」当成同一个数字 ——
   * 真实现金局里这两个数字每天都在变。
   *
   * 现在：`2 ≤ 本手人数 ≤ 座位容量`。空座位**不参与本手**，
   * 但物理座位环不变（盲注与行动顺序按座位环绕，跳过空座）。
   */
  if (seeds.length < 2 || seeds.length > config.tableSize) {
    throw new Error(
      `createGame: ${config.tableSize} 座桌的本手人数必须在 2~${config.tableSize} 之间，收到 ${seeds.length} 位`,
    );
  }
  if (!Number.isInteger(config.smallBlind) || !Number.isInteger(config.bigBlind) || config.smallBlind <= 0 || config.bigBlind <= config.smallBlind) {
    throw new Error(
      `createGame: 盲注不合法（小盲 ${config.smallBlind}、大盲 ${config.bigBlind}）`,
    );
  }
  if (config.ante < 0) {
    throw new Error(`createGame: 前注不能为负（${config.ante}）`);
  }

  const seenPositions = new Set<Position>();
  /*
   * 🔴 **重复 playerId 必须当场拒绝**（Table Topology Correction 缺陷修复）。
   *
   * 修复前只查位置重复，两个座位挂同一个 `id` 会被照单全收：
   * `pendingQueue` 变成 `['dup','dup']`，`playersById` 之类的按 id 索引
   * 只能留下后一个，于是「同一个 id 的两个座位」在后面各处被当成一个人，
   * 而行动顺序、筹码、弃牌状态又按座位算 —— 结果无法收敛。
   *
   * 位置是**座位**的标识，`playerId` 是**人**的标识（§142「Seat ≠ Player」）：
   * 一个人不能同时坐两个座位，两个座位也不能共用一个人的画像。
   */
  const seenPlayerIds = new Set<string>();
  for (const seed of seeds) {
    if (seed.id.trim() === '') {
      throw new Error(`createGame: 玩家 id 不能为空（座位 ${seed.position}）`);
    }
    if (seenPlayerIds.has(seed.id)) {
      throw new Error(`createGame: 玩家 id 重复（${seed.id}）—— 同一玩家不能同时占两个座位`);
    }
    seenPlayerIds.add(seed.id);
    if (seenPositions.has(seed.position)) {
      throw new Error(`createGame: 位置重复 ${seed.position}`);
    }
    seenPositions.add(seed.position);
    seatIndexOfPosition(config.tableSize, seed.position); // 桌型不匹配时抛错
    if (seed.startingStack < 0) {
      throw new Error(`createGame: ${seed.name} 的起始筹码为负（${seed.startingStack}）`);
    }
  }
  if (!seeds.some((s) => s.id === userPlayerId)) {
    throw new Error(`createGame: 用户玩家 ${userPlayerId} 不在玩家列表中`);
  }

  const sortedSeeds = [...seeds].sort(
    (a, b) => seatIndexOfPosition(config.tableSize, a.position) - seatIndexOfPosition(config.tableSize, b.position),
  );

  const players: PlayerState[] = sortedSeeds.map((seed, index) => ({
    id: seed.id,
    name: seed.name,
    seat: index,
    position: seed.position,
    startingStack: seed.startingStack,
    remainingStack: seed.startingStack,
    ante: 0,
    committedByStreet: emptyStreetRecord(),
    folded: false,
    allIn: false,
    holeCards: seed.holeCards ? seed.holeCards.map((c) => ({ rank: c.rank, suit: c.suit })) : null,
  }));

  const board: Board = {
    flop: options.board?.flop ? options.board.flop.map((c) => ({ ...c })) : [],
    turn: options.board?.turn ? options.board.turn.map((c) => ({ ...c })) : [],
    river: options.board?.river ? options.board.river.map((c) => ({ ...c })) : [],
  };

  const state: GameState = {
    id: options.id ?? `hand-${Date.now()}`,
    config: { ...config, dealerPosition: config.dealerPosition ?? Position.BTN },
    players,
    board,
    actions: [],
    userPlayerId,
    phase: HandPhase.BETTING,
    street: Street.PREFLOP,
    currentBet: 0,
    lastRaiseSize: config.bigBlind,
    lastAggressorId: null,
    pendingQueue: [],
    bettingRoundComplete: false,
    raiseClosedFor: [],
    actedSinceLastAggression: [],
    rake: 0,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };

  // ---- 前注 ----
  if (config.ante > 0) {
    for (const player of state.players) {
      const potBefore = computePot(state);
      const pay = Math.min(config.ante, player.remainingStack);
      player.remainingStack -= pay;
      player.ante += pay;
      if (player.remainingStack === 0) player.allIn = true;
      state.actions.push(
        makeRecord(state, player, ActionType.POST_ANTE, pay, player.ante, player.allIn, { potBefore }),
      );
      finalizeRecord(state);
    }
  }

  // ---- 盲注 ----
  //
  // 🔴 盲注必须按**本手参与者**的座位环绕来定，不能再用「Button 的下一位」——
  //    那会在有空座位时把盲注派给一个不在本手的人。
  //    单挑时 Button **本人**是小盲（规范第 33 条）。
  const topology = handTopologySeats(
    config.tableSize,
    sortedSeeds.map((s) => s.position),
    config.dealerPosition,
  );
  const sbPlayer = players.find(
    (p) => seatIndexOfPosition(config.tableSize, p.position) === topology.smallBlindSeatIndex,
  )!;
  const bbPlayer = players.find(
    (p) => seatIndexOfPosition(config.tableSize, p.position) === topology.bigBlindSeatIndex,
  )!;

  postBlind(state, sbPlayer, config.smallBlind, ActionType.POST_SB);
  postBlind(state, bbPlayer, config.bigBlind, ActionType.POST_BB);

  /*
   * 🔴 **翻牌前的入池代价是「一个大盲」，不是「大盲实际投进去的钱」。**
   *
   * 大盲不足额全下（短码）时 `postBlind` 只投入了他剩下的那点筹码，
   * 于是 `bbPlayer.committed` 会**小于** `config.bigBlind`。
   * 若直接用 `max(sb, bb)`，入池代价就被拉到**大盲以下** ——
   * 实测（BB 起始 30 筹码、盲注 50/100）：
   *
   * ```text
   * state.currentBet      = 50   ← 应为 100
   * UTG requiredCallAmount = 50   ← 应为 100
   * UTG CALL 100 → 被拒 CALL_AMOUNT_ILLEGAL{required:50}
   * UTG CALL  50 → 被接受（等于**半价入池**）
   * ```
   *
   * 规则依据：大盲不足额全下**不改变**入池代价 ——
   * 其他人仍须跟满一个大盲，最小加注仍到大盲的两倍。
   * （SB=20 / BB=30 的双短盲更极端：旧写法让全场跟 30 就能看翻牌。）
   *
   * 因此下界取 `config.bigBlind`。取 `max` 而不是直接赋值，
   * 是因为小盲理论上也可能投超（例如前注/特殊结构），
   * 那时 `currentBet` 不该被调小。
   */
  state.currentBet = Math.max(
    config.bigBlind,
    sbPlayer.committedByStreet.PREFLOP,
    bbPlayer.committedByStreet.PREFLOP,
  );
  state.lastRaiseSize = config.bigBlind;

  /*
   * ---- 翻牌前待行动队列：枪口位开始，大盲最后 ----
   *
   * 🔴 **必须与本项目另外两处建队点用同一套判据**（2026-09 修复）。
   *
   * 这个项目有**三个**地方会建待行动队列：
   *
   * | 建队点 | 位置 |
   * |---|---|
   * | 建局 | 本处（`createGame`） |
   * | 每次动作之后 | `engine.rebuildPendingQueue` |
   * | 每街开始 | `engine.resetStreetState` |
   *
   * 前两轮修复只改了后两处，**漏了建局这一处** —— 独立审查实测出两个后果：
   *
   * ```text
   * ① 单挑 SB 盲注全下 50、BB 深筹码：queue=[bb]，BB 被要求行动 ——
   *    而其余人已全下、他也不欠跟注，现实中直接跑牌。
   *    于是系统为一个**不存在的决策点**给出建议。
   * ② 全员盲注/前注全下：queue=[] 且 bettingRoundComplete=false ——
   *    无人可行动、无法推进、无法行动 = **死局**（15000 局随机对局里 62 次）。
   * ```
   *
   * ⚠️ 判据在这里**内联**而不是从 `engine.ts` import：`gameState.ts` 是
   * 更底层模块，反向依赖会形成循环（`engine` 已经 import 了本文件）。
   * 这是一个**刻意的重复**，用下面的注释把它钉住 —— 谁改 `engine.needsToAct`
   * 就必须同步这里。
   *
   * 📌 判据（与 `engine.needsToAct` 逐条对应）：
   * 1. 已弃牌 / 已全下 / 没筹码 ⇒ 不行动
   * 2. **欠跟注 ⇒ 必须行动**（即使其他人都全下 —— 跟注/弃牌由他决定）
   * 3. 其余人都跟不了、且自己不欠 ⇒ **不行动**（无人能跟他的下注）
   * 4. 本街未表态 ⇒ 行动（覆盖大盲的选择权）
   * 5. 已表态但注额被超过 ⇒ 行动
   */
  const owesCall = (p: PlayerState): boolean =>
    p.committedByStreet[Street.PREFLOP] < state.currentBet;
  const canBeCalledBySomeone = (p: PlayerState): boolean =>
    state.players.some(
      (other) =>
        other.id !== p.id && !other.folded && !other.allIn && other.remainingStack > 0,
    );
  const mustAct = (p: PlayerState): boolean => {
    if (p.folded || p.allIn || p.remainingStack <= 0) return false;
    if (owesCall(p)) return true;
    return canBeCalledBySomeone(p);
  };

  state.pendingQueue = streetOrder(state)
    .filter((p) => mustAct(p))
    .map((p) => p.id);

  /*
   * ✅ **队列为空 ⇒ 本街已完成** —— 保持「`queue` 空 ⟺ 本街完成」这条不变量。
   *
   * 不写这一句会让「全员盲注全下」这种局面停在
   * 「无人可行动 + 未标记完成」的中间态：`advanceStreet` 报
   * `STREET_NOT_COMPLETE`、又没有任何合法动作可做 ⇒ **死局**。
   *
   * ⚠️ 这里直接置标志而**不**调用 `onBettingRoundComplete`：
   * 那个函数会设 `phase = SHOWDOWN`，而 `phase` 属于引擎的阶段机，
   * 建局阶段不该替它决定（调用方——`reconstruct` / 牌桌——会自己推进）。
   * 置 `bettingRoundComplete` 是安全的：它是**纯状态描述**，可从状态推出。
   */
  if (state.pendingQueue.length === 0) {
    state.bettingRoundComplete = true;
  }

  return state;
}

function postBlind(state: GameState, player: PlayerState, blind: number, type: ActionType): void {
  const potBefore = computePot(state);
  const pay = Math.min(blind, player.remainingStack);
  player.remainingStack -= pay;
  player.committedByStreet[Street.PREFLOP] += pay;
  if (player.remainingStack === 0) player.allIn = true;
  state.actions.push(
    makeRecord(state, player, type, pay, player.committedByStreet[Street.PREFLOP], player.allIn, {
      potBefore,
    }),
  );
  finalizeRecord(state);
}

type RecordOptions = {
  potBefore?: number;
  note?: string;
};

function makeRecord(
  state: GameState,
  player: PlayerState,
  type: ActionType,
  amount: number,
  toAmount: number,
  isAllIn: boolean,
  options: RecordOptions = {},
): ActionRecord {
  const potBefore = options.potBefore ?? computePot(state);
  return {
    index: state.actions.length,
    street: state.street,
    playerId: player.id,
    position: player.position,
    type,
    amount,
    toAmount,
    isAllIn,
    potBefore,
    /** 先给一个保守估计，由 finalizeRecord 用系统重算结果覆盖 */
    potAfter: potBefore + amount,
    ...(options.note !== undefined ? { note: options.note } : {}),
  };
}

/** 动作落账后同步 potAfter，保证 potAfter 恒等于系统重算的底池 */
function finalizeRecord(state: GameState): void {
  const last = state.actions[state.actions.length - 1];
  if (last) last.potAfter = computePot(state);
}

/* ============================================================
 * 结构化克隆（动作不可变；撤销走全量重放，不做增量修补）
 * ============================================================ */

export function cloneState(state: GameState): GameState {
  return {
    ...state,
    config: { ...state.config },
    players: state.players.map((p) => ({
      ...p,
      committedByStreet: { ...p.committedByStreet },
      holeCards: p.holeCards ? p.holeCards.map((c) => ({ rank: c.rank, suit: c.suit })) : null,
    })),
    board: {
      flop: state.board.flop.map((c) => ({ ...c })),
      turn: state.board.turn.map((c) => ({ ...c })),
      river: state.board.river.map((c) => ({ ...c })),
    },
    actions: state.actions.map((a) => ({ ...a })),
    pendingQueue: [...state.pendingQueue],
    raiseClosedFor: [...state.raiseClosedFor],
    actedSinceLastAggression: [...state.actedSinceLastAggression],
    ...(state.winners !== undefined ? { winners: [...state.winners] } : {}),
  };
}

/** 已发公共牌张数 */
export function boardCardCount(state: GameState): number {
  return state.board.flop.length + state.board.turn.length + state.board.river.length;
}

export { Street, ActionType, TableSize, Position, cardKey };
