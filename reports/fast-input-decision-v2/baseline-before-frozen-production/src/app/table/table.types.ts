/**
 * 交互式牌桌录入 —— 数据模型
 *
 * ## 这个模块在端到端链中解决什么
 *
 * 在它之前，录入一手牌要填一个**表单**：位置、手牌、公共牌、行动历史全靠
 * 键盘敲。要在真实牌桌上连续记录 20～30 手，那个界面太慢，而且容易把
 * 「大盲位」写成「关煞位」这类错误一路带到决策里。
 *
 * 现在牌桌本身就是输入器：点座位、点牌、点行动。
 *
 * ## 🔴 本轮锁死的三条不变量（最高优先级）
 *
 * ```
 * # Fold ≠ Leave Table
 * # Seat ≠ Player
 * # 当前 Hand 的历史事实不能因为玩家离桌而被删除
 * ```
 *
 * 这三条不是口号，它们各自对应下面结构里的一个**结构性决定**：
 *
 * | 不变量 | 结构性决定 |
 * |---|---|
 * | Fold ≠ Leave | `SeatStatus` 里 `FOLDED_THIS_HAND` 与 `LEAVING_AFTER_HAND` 是**两个状态**，且没有任何代码路径能让 Fold 把座位清空 |
 * | Seat ≠ Player | `TableSeat.playerId` 是一个**引用**；画像/动态存在 `playersById` 里，**按 playerId 查**，绝不按位置查 |
 * | 历史事实不可删 | `PokerTableState.actionHistory` 只增不减；离桌只改 `SeatStatus`，不碰 `actionHistory` |
 *
 * ## 为什么 `playersById` 与 `seats` 分开存
 *
 * 因为同一个**人**可以在不同手坐不同座位，而同一个**座位**在不同时间坐不同人。
 * 把玩家资料直接塞进座位对象，就会在「换人」时不可避免地继承旧数据 ——
 * 那正是红队要攻击的头号目标（CRITICAL Regression：新玩家必须 UNKNOWN）。
 */

import type { Position, Street } from '../../domain/types.ts';
import type { GameEnvironmentId } from '../../domain/knowledge/knowledge.types.ts';
import type {
  DynamicHint,
  ManualAction,
  ManualActionType,
  QuickProfile,
} from '../manualInput/manualInput.ts';

/* ============================================================
 * 座位状态
 * ============================================================ */

/**
 * 座位状态。
 *
 * ## 🔴 `FOLDED_THIS_HAND` 与 `LEAVING_AFTER_HAND` 必须分开
 *
 * | 状态 | 含义 | 下一手 |
 * |---|---|---|
 * | `FOLDED_THIS_HAND` | 弃了这手牌，**人还在桌上** | 回到 `SEATED_ACTIVE` |
 * | `LEAVING_AFTER_HAND` | 人真的走了，但**本手的历史事实要保留** | 变成 `EMPTY`（解除绑定） |
 *
 * 把两者混成一个状态，就会产生两个方向的错误：
 * - 把 Fold 当离桌 → 一手牌弃牌后座位被清空，下一手人不见了
 * - 把离桌当 Fold → 当前手的底池与行动台账被删掉，筹码守恒被破坏
 *
 * `SITTING_OUT` 又是第三种：**人还绑在这个座位上**，只是下一手不参与发牌。
 * 它既不清空座位，也不改变当前手。
 */
export const SeatStatus = {
  /** 空座位：`playerId === null` */
  EMPTY: 'EMPTY',
  /** 有人、在座、参与本手 */
  SEATED_ACTIVE: 'SEATED_ACTIVE',
  /** 已弃牌（**只影响本手**） */
  FOLDED_THIS_HAND: 'FOLDED_THIS_HAND',
  /** 已全下 */
  ALL_IN: 'ALL_IN',
  /** 暂时离座：仍绑定该座位，下一手不参与发牌，画像保留 */
  SITTING_OUT: 'SITTING_OUT',
  /** 手后离桌：本手仍保留其全部历史事实，下一手才真正清空座位 */
  LEAVING_AFTER_HAND: 'LEAVING_AFTER_HAND',
} as const;
export type SeatStatus = (typeof SeatStatus)[keyof typeof SeatStatus];

export const SEAT_STATUS_ZH: Readonly<Record<SeatStatus, string>> = Object.freeze({
  EMPTY: '空座',
  SEATED_ACTIVE: '在座',
  FOLDED_THIS_HAND: '本手弃牌',
  ALL_IN: '全下',
  SITTING_OUT: '暂离',
  LEAVING_AFTER_HAND: '手后离桌',
});

/** 占用了座位（有人）的状态 */
export const OCCUPIED_STATUSES: readonly SeatStatus[] = Object.freeze([
  SeatStatus.SEATED_ACTIVE,
  SeatStatus.FOLDED_THIS_HAND,
  SeatStatus.ALL_IN,
  SeatStatus.SITTING_OUT,
  SeatStatus.LEAVING_AFTER_HAND,
]);

/**
 * **下一手会被发牌**的状态。
 *
 * `SITTING_OUT` 与 `LEAVING_AFTER_HAND` 都不在里面 —— 这正是
 * 「暂离」与「离桌」在生命周期上的区别。
 */
export const DEALT_IN_NEXT_HAND_STATUSES: readonly SeatStatus[] = Object.freeze([
  SeatStatus.SEATED_ACTIVE,
  SeatStatus.FOLDED_THIS_HAND,
  SeatStatus.ALL_IN,
]);

/** 本手已经参与过的状态（弃牌与全下都算参与过） */
export const IN_HAND_STATUSES: readonly SeatStatus[] = Object.freeze([
  SeatStatus.SEATED_ACTIVE,
  SeatStatus.FOLDED_THIS_HAND,
  SeatStatus.ALL_IN,
  SeatStatus.LEAVING_AFTER_HAND,
]);

/* ============================================================
 * 座位与玩家
 * ============================================================ */

/**
 * 一个**座位**（牌桌上的物理/逻辑位置）。
 *
 * ⚠️ 它**不持有**任何玩家资料 —— 只有一个 `playerId` 引用。
 * 这是「Seat ≠ Player」在类型层面的落地。
 */
export type TableSeat = {
  /** 稳定 id（= `seat_${position}`，与 Poker Core 的座位口径对齐） */
  seatId: string;
  /** **逻辑**位置：唯一参与计算的真相 */
  logicalPosition: Position;
  /**
   * **视觉**序号：只影响渲染。
   *
   * 🔴 它**绝不**参与任何计算。Hero 永远在视觉 0 号位（6 点钟），
   * 但 `logicalPosition` 仍然是真实的 CO / UTG / BB。
   * 把视觉位置当逻辑位置用，是本轮最危险的一类 Bug。
   */
  visualIndex: number;
  /** 绑定的玩家；`null` = 空座位 */
  playerId: string | null;
  status: SeatStatus;
  /**
   * **下一手**是否暂离。
   *
   * ## 为什么需要这个独立标记（红队命中 CRITICAL）
   *
   * 规范第 53 条：玩家还在本手时，「暂离」**只影响下一手**，当前手保持原状态。
   *
   * 而冻结的 Poker Core 要求「N 人桌恰好 N 位玩家」—— 一旦把座位标成
   * `SITTING_OUT`，牌桌就再也重建不出牌局，**这一手在界面上直接无法继续录入**。
   * 那等于让「暂离」毁掉了当前手，与第 53 条相反。
   *
   * 因此：本手进行中时 `SIT_OUT` 只设这个标记，`status` 保持
   * `SEATED_ACTIVE`（人还在这手牌里）；到 `NEXT_HAND` 才真正变成 `SITTING_OUT`。
   */
  sitOutNextHand: boolean;
  /** 该座位本手的起始筹码（BB） */
  stackBB: number;
};

/**
 * 一个**玩家**（真实身份）。
 *
 * 与座位完全解耦：玩家离开座位后对象仍可保留（历史），
 * 但不再影响任何座位，也不会被新玩家继承。
 */
export type TablePlayer = {
  /** 唯一 id（**不是**显示名 —— 显示名可以重复） */
  playerId: string;
  /** 显示名（可重复、可缺省） */
  displayName: string;
  /** 主观快速画像；新玩家一律 `UNKNOWN` */
  quickProfile: QuickProfile;
  /** 动态观察提示；新玩家一律 `UNKNOWN` */
  dynamicHint: DynamicHint;
  /** 该玩家在本次牌桌里坐过的手数（仅显示与追溯，不参与决策） */
  handsPlayed: number;
  /**
   * 🔴 **PLAYER PROFILE EXPLOIT V1：该玩家的实测统计**（来自真实历史记录）。
   *
   * 只在**真的读到历史**且**存在有效观测机会**时才出现；由
   * `playerHistory.applyUserOpWithHistory` 在（重新）落座时挂上，
   * 再由 `tableAdapter` 注入 `ManualVillain.observedStats` ⇒ 进入现有响应模型。
   *
   * ⚠️ 机会数为 0 的统计**不会**出现在这里（未观察到 ≠ 0%）。
   */
  observedStats?: import('../../domain/player/observedStats.ts').PlayerObservedStats;
  /** 实测统计的中文披露（样本量 / 机会数 / 哪几项真的接入了模型） */
  observedStatsNoteZh?: string;
  /** 是否为 Hero（Hero 也是 Player，只是座位视觉固定） */
  isHero: boolean;
};

/* ============================================================
 * 牌桌状态
 * ============================================================ */

/**
 * **本手拓扑快照**（规范第 10 / 11 条）—— 一手开始后**不可变**。
 *
 * ## 为什么必须冻结（而不是每次现算）
 *
 * 现算在数学上等价，但**证明不了**「中途的座位操作没有改变本手」。
 * 冻结之后，「当前手的事实不被座位生命周期修改」变成一条**可断言**的性质：
 * 比较快照即可，不需要逐条推理操作路径。
 *
 * 快照只装「一旦本手开始就不能变」的东西：参与者座位、Button 座位、
 * 由此推出的角色与盲注位。它**不装**筹码与行动 —— 那些活在
 * `PokerState` / `actionHistory` 里。
 */
export type HandTopologySnapshot = {
  /** 第几手（从 1 开始，仅用于显示与追溯） */
  handNumber: number;
  /** 座位容量 */
  tableCapacity: 6 | 9;
  /** 本手参与者的 seatId（**物理座位**，升序） */
  participantSeatIds: readonly string[];
  /** 本手人数（= participantSeatIds.length）—— **不是**容量 */
  handedness: number;
  /** Button 的 seatId */
  buttonSeatId: string;
  smallBlindSeatId: string;
  bigBlindSeatId: string;
  /** seatId → 本手位置角色 */
  rolesBySeatId: Readonly<Record<string, Position>>;
  /** 单挑时 Button 同时是小盲 */
  buttonAlsoPostsSmallBlind: boolean;
};

/** 不含撤销栈的牌桌核心状态（撤销快照就是它） */
export type TableCore = {
  /** 牌桌 id（服务端用它做 revision 水位线；同一次会话内稳定） */
  tableId: string;
  /** 版本号：每次变更 +1。用于**竞态保护**（旧状态不得覆盖新状态） */
  revision: number;
  /** **座位容量**（牌桌有几个物理座位）—— **不是**本手人数 */
  tableSize: 6 | 9;
  /**
   * **Button 的物理座位**（规范第 15 条：Button 是一等状态）。
   *
   * 🔴 不能由 Hero 位置反推：有空座位时「Button 的下一位是小盲」不成立，
   * 而且 Hero 的**位置角色**每手都在变。
   */
  buttonSeatId: string;
  /** 本手已冻结的拓扑快照；`null` = 本手还没开始 */
  handTopology: HandTopologySnapshot | null;
  /** 已完成的手数（快照的 handNumber 来源） */
  handsCompleted: number;
  /** Hero 的**逻辑**位置 */
  heroPosition: Position;
  /** Hero 的 playerId（Hero 也是玩家） */
  heroPlayerId: string;
  seats: readonly TableSeat[];
  playersById: Readonly<Record<string, TablePlayer>>;
  /** Hero 手牌（牌面代码，如 `As`）；未选满时长度 < 2 */
  heroCards: readonly string[];
  /** 公共牌（0～5 张）；1～2 张 = 「选择中」，此时禁止分析 */
  board: readonly string[];
  /** 行动历史（**只增不减**；离桌/暂离/换人都不得删改它） */
  actionHistory: readonly ManualAction[];
  environment: GameEnvironmentId;
  /** 大盲筹码面额（1BB = 多少筹码），只影响筹码口径显示 */
  bigBlindBB: number;
  /** 新玩家默认买入（BB） */
  defaultStackBB: number;
  /** 本手是否已经开始（有手牌 / 有公共牌 / 有行动） */
  handActive: boolean;
  /** 自增计数：新 playerId 与显示名的来源 */
  nextPlayerNumber: number;
  /** 上一手结束时的剩余筹码（仅作提示；`null` = 未知） */
  lastHandRemainingStacksBB: Readonly<Partial<Record<Position, number>>> | null;
  /** 一次性提示（例如「已按上一手剩余筹码更新座位筹码」），渲染后即弃 */
  notices: readonly string[];
  /** 上一手是否已经结束（用于「下一手」按钮的可用性） */
  lastHandComplete: boolean;
};

/**
 * 完整牌桌状态 = 核心状态 + 撤销栈。
 *
 * 撤销栈里放的是 `TableCore`（**不含**它自己的撤销栈），
 * 否则每撤销一步都会把整棵历史树复制一遍。
 */
export type PokerTableState = TableCore & {
  /** 撤销栈（最近的在前）；深度上限见 `MAX_UNDO_DEPTH` */
  undo: readonly TableCore[];
};

/** 撤销深度上限（一手牌约 20 步，留一倍余量） */
export const MAX_UNDO_DEPTH = 40;

export const TABLE_STATE_VERSION = '1.0.0';

/* ============================================================
 * 操作
 * ============================================================ */

/** 清空座位时，若该玩家已参与本手，必须由用户明确选择 */
export const ActiveHandLeaveChoice = {
  /** 本手视为弃牌并离桌（**仅当轮到他行动时**可选，否则会伪造一次行动） */
  FOLD_AND_LEAVE: 'FOLD_AND_LEAVE',
  /** 仅标记手后离桌（本手状态不变，历史事实全部保留） */
  LEAVE_AFTER_HAND: 'LEAVE_AFTER_HAND',
  /** 取消 */
  CANCEL: 'CANCEL',
} as const;
export type ActiveHandLeaveChoice =
  (typeof ActiveHandLeaveChoice)[keyof typeof ActiveHandLeaveChoice];

/** 牌桌上的一个动作请求（**由后端判定行动者是谁**，前端不许指定） */
export type TableActionRequest = {
  type: ManualActionType;
  /**
   * 金额，单位**筹码**（不是 BB）。
   *
   * ## 为什么用筹码而不是 BB
   *
   * `ManualAction.amountBB` 要经过 `round(amountBB × 面额)` 才能变回筹码。
   * 如果点一下按钮就在 BB 与筹码之间来回换算两次，浮点误差会让
   * 「刚应用的动作」与「重新重放出来的状态」**不一致** ——
   * 那正是本轮最危险的缺陷（牌桌显示 A、后端算出 B）。
   *
   * 因此：按钮携带**精确筹码数**，后端原样提交给 Poker Core，
   * 只在**落库**（写进 `ManualAction`）时换算一次 BB，且保留 6 位小数
   * 以保证往返无损。
   *
   * - `BET` / `RAISE` / `ALL_IN`：**本街总额（到多少）**
   * - `CALL`：本次投入
   * - `FOLD` / `CHECK`：不用填
   */
  amountChips?: number;
};

export type TableOp =
  | { kind: 'NEW_TABLE' }
  | { kind: 'NEXT_HAND' }
  | { kind: 'RESET_HAND' }
  /**
   * 加入玩家。
   *
   * 🔴 **PLAYER PROFILE EXPLOIT V1**：可选显式身份 ——
   * 传 `playerId` 就是「让**这位已保存的玩家**入座」（重新上桌 / 换座位），
   * 其历史统计由 `playerHistory` 按 `playerId` 读取后注入；
   * 不传则与既有行为**逐位一致**（自动 `p{n}` + 「玩家N」）。
   *
   * ⚠️ `displayName` **只用于显示与查找**，同名**绝不**自动合并历史；
   * 重名时由调用方用 `playerHistory.findPlayersByName` 取候选再显式选择。
   */
  | { kind: 'ADD_PLAYER'; seatId: string; playerId?: string; displayName?: string }
  /**
   * 🔴 **一键补齐空位**（2026-09）：在每一个空座位各加入一名新玩家。
   *
   * 与逐个 `ADD_PLAYER` 的区别只有**粒度**：一次操作 = 一次 `revision` +
   * 一条撤销记录（撤销一次即回到补齐前）。新玩家的形状完全由
   * `seatLifecycle` 的同一处定义决定。
   */
  | { kind: 'FILL_EMPTY_SEATS' }
  | { kind: 'CLEAR_SEAT'; seatId: string; activeHandChoice?: ActiveHandLeaveChoice }
  | { kind: 'REPLACE_PLAYER'; seatId: string }
  | { kind: 'SIT_OUT'; seatId: string }
  | { kind: 'SIT_IN'; seatId: string }
  | { kind: 'SET_STACK'; seatId: string; stackBB: number }
  | { kind: 'SET_PROFILE'; seatId: string; quickProfile: QuickProfile }
  | { kind: 'SET_DYNAMIC_HINT'; seatId: string; dynamicHint: DynamicHint }
  | { kind: 'CLEAR_ALL_VILLAINS' }
  | { kind: 'SET_ENVIRONMENT'; environment: GameEnvironmentId }
  | { kind: 'SET_TABLE_SIZE'; tableSize: 6 | 9 }
  | { kind: 'SET_HERO_POSITION'; position: Position }
  /**
   * **手动指定 Button 所在的座位**（§19 / §76）。
   *
   * ## 为什么必须能手设
   *
   * Button 不该由用户每手手点（`NEXT_HAND` 会自动按物理座位顺时针轮转），
   * 但**开局的第一手**必须能设：真实牌局里你走进一个牌桌时，
   * 筹码牌（button）已经在某个人面前了。若只能从 `BTN` 座位起步，
   * 那么「Hero 坐 BTN 而实际 Button 在 CO」这种最常见的到桌场景
   * 会被记录成一个**错的盲注归属**，之后每一手都跟着错。
   *
   * ⚠️ 只在本手**未开始**时允许 —— 本手进行中改 Button 会改变
   * 已发生事实的归属（盲注是谁下的、谁先行动），那是篡改历史。
   */
  | { kind: 'SET_BUTTON'; seatId: string }
  | { kind: 'SET_HERO_CARD'; card: string }
  | { kind: 'CLEAR_HERO_CARDS' }
  | { kind: 'SET_BOARD_CARD'; card: string; slot: number }
  | { kind: 'CLEAR_BOARD' }
  | { kind: 'ACT'; action: TableActionRequest }
  | { kind: 'UNDO' };

/** 阻断码（界面按码给文案，不靠字符串匹配） */
export type TableBlockCode =
  | 'SEAT_NOT_FOUND'
  | 'SEAT_EMPTY'
  | 'SEAT_OCCUPIED'
  | 'HAND_ACTIVE'
  | 'INVALID_STACK'
  | 'INVALID_CARD'
  | 'CARD_ALREADY_USED'
  | 'NO_ACTOR'
  | 'ILLEGAL_ACTION'
  | 'STALE_REVISION'
  | 'NOTHING_TO_UNDO'
  | 'NEEDS_LEAVE_DECISION'
  | 'HERO_SEAT_REQUIRED'
  | 'NOT_SITTING_OUT'
  | 'ALREADY_SITTING_OUT'
  | 'INTERNAL_ERROR';

export type TableIssue = {
  code: TableBlockCode;
  message: string;
};

/** 需要用户明确选择时的附加信息（§8：不许默认猜） */
export type LeaveDecision = {
  seatId: string;
  position: Position;
  displayName: string;
  /** 该玩家是否**仍需要行动**（决定 `FOLD_AND_LEAVE` 可不可选） */
  stillToAct: boolean;
  /** 可选动作（按顺序显示） */
  options: readonly ActiveHandLeaveChoice[];
  noteZh: string;
};

export type TableOpOutcome =
  | { ok: true; state: PokerTableState }
  | { ok: false; issues: readonly TableIssue[]; leaveDecision?: LeaveDecision };

/* ============================================================
 * 视图辅助（渲染用的派生结构，**后端算好**，前端不做逻辑）
 * ============================================================ */

export type SeatView = {
  seatId: string;
  logicalPosition: Position;
  positionZh: string;
  visualIndex: number;
  /** 渲染角度（度）：0 = 6 点钟方向，顺时针增大 */
  angleDeg: number;
  playerId: string | null;
  displayName: string | null;
  isHero: boolean;
  status: SeatStatus;
  statusZh: string;
  /**
   * 本手期间标记的「**下一手**暂离」。
   *
   * 🔴 必须暴露给界面（红队 RT-L4 后续命中）：只写进状态而不显示，
   * 使用者看不到自己刚做的暂离意图，下一手座位突然不发牌时会莫名其妙。
   */
  sitOutNextHand: boolean;
  /** 本手起始筹码（BB） */
  stackBB: number;
  /** 当前剩余筹码（BB）；无法重建时为 `null` */
  remainingStackBB: number | null;
  /** 本街已投入（BB）；无法重建时为 `null` */
  committedBB: number | null;
  quickProfileZh: string | null;
  dynamicHintZh: string | null;
  /** 是否为当前行动者 */
  isCurrentActor: boolean;
  /** 是否已经弃牌 */
  folded: boolean;
  /** 是否全下 */
  allIn: boolean;
  /** 是否庄家位（纯展示） */
  isDealer: boolean;
  /**
   * 本手**角色名**（由拓扑算出的唯一真相，如 `BTN` / `SB` / `BB` / `CO`）。
   *
   * 🔴 与 `logicalPosition` **不是一回事**（§142「Seat ≠ Position」）：
   * `logicalPosition` 是物理座位，`handRole` 是本手由 Button + 参与者
   * 重算出来的角色。有空座位时两者会不同（9 座桌 8 人时某些座位拿不到
   * 它「满桌时」的角色名）。
   *
   * 本手未开始或该座位不参与本手时为 `null`。
   */
  handRole: Position | null;
  /**
   * `handRole` 的中文名（界面**显示角色**用）。
   *
   * 🔴 界面上那个「位置」标签应该显示**角色**（本手他是小盲还是大盲），
   * 而不是物理座位名。修复前两者被当成同一个东西，于是空座位一出现，
   * 界面就在一个「本手其实是 UTG」的座位上写着「关煞位」。
   */
  handRoleZh: string | null;
  /**
   * 该座位是否参与**本手**（由拓扑决定）。
   *
   * 空座位 / 暂离 / 0 筹码 → `false`。界面据此把不参与的座位画淡。
   */
  isParticipant: boolean;
};

/**
 * 一个可点的动作按钮。
 *
 * 🔴 **契约（红队 V27 修复后）**：
 * - `group: 'PRIMARY' | 'SIZE'` 的按钮**一定是合法动作** —— 点下去后端必须接受
 * - `group: 'EXPAND'` 的按钮**不是动作**，它只用来展开尺寸行
 *
 * 修复前 BET / RAISE 的「（选尺寸）」按钮混在 `PRIMARY` 里，于是
 * 「预览给出的按钮」与「后端接受的动作」不是同一个集合 ——
 * 一个照单全收的客户端会点出 `ACTION_ZERO_AMOUNT`。
 */
export type TableActionButton = {
  type: ManualActionType;
  labelZh: string;
  /**
   * 提交给后端的**精确筹码数**。
   *
   * `undefined` 表示「这个动作不携带金额」—— 目前只有 `ALL_IN`：
   * 引擎的 `doAllIn` 要求 `amount` 等于**本次投入的剩余筹码**，
   * 而不是「本街总额」。带总额会被 `ALLIN_AMOUNT_MISMATCH` 拒绝
   *（红队 V-ALLIN 命中）。不传金额时由引擎自己算，永远正确。
   */
  amountChips?: number;
  /** 仅用于展示：本街总额（BB） */
  amountBB?: number;
  isAllIn: boolean;
  /** `PRIMARY` / `SIZE` = 合法动作；`EXPAND` = 只展开尺寸行 */
  group: 'PRIMARY' | 'EXPAND' | 'SIZE';
};

/* ============================================================
 * 自动分析闸门（Hero Decision Ready）
 * ============================================================ */

/**
 * 「现在是不是一个**可分析的 Hero 决策点**」—— 后端算好的**结论**。
 *
 * ## 为什么必须在后端算，而且必须结构化
 *
 * 前端**不允许**自己判断「该不该自动分析」。理由不是洁癖：
 * 判断这件事需要的条件（是否轮到 Hero、手牌够不够、牌面够不够、
 * 状态是否合法、是否还有前位没行动）**全部**来自引擎重建，
 * 而这些恰好在上一轮出过最危险的那类缺陷
 *（`tablePreview` 用「未弃牌人数」而引擎用「已实现对手数」——
 * 界面劝退一个其实可分析的决策点）。
 *
 * 因此这里返回的不是一个布尔值，而是：
 *
 * ```
 * ready      —— 能不能分析（8 个条件全部成立）
 * reasonCode —— 不能分析时的**机器可读**原因（前端按码给文案，不做字符串匹配）
 * state      —— 界面顶部状态条要显示的状态
 * conditions —— 逐条条件是否成立（诊断与红队用，界面可展开）
 * groups     —— 分组后的中文阻塞原因（分「决策就绪」与「分析可用性」两组）
 * ```
 *
 * ## `CanAnalyze` 为什么不能当触发条件
 *
 * 🔴 使用者录完 Hero 自己的动作后，`currentActor` 会变成下一个对手；
 * 若那个人已经弃牌，`currentActor` 会继续跳到再下一个。
 * 而在「Hero 是最后一个行动者」的牌局里，`canAnalyze` 会在 Hero 的
 * **旧节点**上短暂为真 —— 那正是「历史重建误触发」的形态。
 * 所以触发必须同时看 `isHeroTurn`（真的轮到 Hero），
 * 而不是只看「能分析」。
 */
export const DecisionReasonCode = Object.freeze({
  /** 可以分析 */
  READY: 'READY',
  /** 公共牌还在选（1~2 张）—— 翻牌要 3 张、转牌 4 张、河牌 5 张 */
  WAITING_BOARD: 'WAITING_BOARD',
  /** Hero 手牌还没选满 2 张 */
  WAITING_HERO_CARDS: 'WAITING_HERO_CARDS',
  /** 轮到别人 —— 还在等前位行动，**不要猜他们弃牌** */
  WAITING_OTHERS: 'WAITING_OTHERS',
  /** 本街下注轮已结束，等公共牌 */
  ROUND_COMPLETE: 'ROUND_COMPLETE',
  /** 本手已结束（只剩一人或已摊牌） */
  HAND_COMPLETE: 'HAND_COMPLETE',
  /** 牌局结构不合法（校验未通过） */
  STATE_INVALID: 'STATE_INVALID',
  /** 人员不足（本手可参与者 < 2 或 Hero 座位没人） */
  STAFFING: 'STAFFING',
} as const);
export type DecisionReasonCode = (typeof DecisionReasonCode)[keyof typeof DecisionReasonCode];

/** 顶部状态条要显示的 7 种状态 */
export const AutoAnalyzeState = Object.freeze({
  WAITING_CARDS: 'WAITING_CARDS',
  WAITING_OTHERS: 'WAITING_OTHERS',
  WAITING_BOARD: 'WAITING_BOARD',
  ANALYZING: 'ANALYZING',
  DONE: 'DONE',
  INSUFFICIENT: 'INSUFFICIENT',
  ERROR: 'ERROR',
} as const);
export type AutoAnalyzeState = (typeof AutoAnalyzeState)[keyof typeof AutoAnalyzeState];

export type DecisionReadiness = {
  /** 8 个条件是否全部成立 */
  ready: boolean;
  /** 机器可读原因（前端按码给文案） */
  reasonCode: DecisionReasonCode;
  /** 界面顶部状态条的机器可读状态 */
  state: AutoAnalyzeState;
  /** 逐条条件（诊断 / 红队 / 界面可展开） */
  conditions: Readonly<Record<string, boolean>>;
  /** 分组后的中文原因 */
  groups: readonly { zh: string; items: readonly string[] }[];
};

export type TablePreview = {
  ok: boolean;
  tableId: string;
  revision: number;
  /** 引擎重建出来的**实际**街道（不是用户声明的） */
  street: Street | null;
  streetZh: string;
  /** 公共牌选择中（1～2 张）—— 此时禁止分析 */
  boardSelectionInProgress: boolean;
  currentActorSeatId: string | null;
  currentActorPosition: Position | null;
  currentActorNameZh: string | null;
  isHeroTurn: boolean;
  /**
   * 本手**仍未弃牌**的对手数（含尚未行动的人）。
   *
   * ⚠️ 它**不**是「已进池的对手数」，也**不再**是任何门槛的依据
   *（曾经是 `MULTIWAY_REFUSE_THRESHOLD` 的判据，那条拒绝已删除 ——
   * 见下一条）。这里只作为「本手还剩几个人」的事实展示。
   */
  activeOpponentCount: number;
  /**
   * **已经真正进入**这一手的对手数（跟注 / 加注 / 全下）。
   *
   * 🔴 它决定**权益按几家算** —— 决策引擎用全部已实现对手一起算权益，
   * 与底池赔率**同口径**。
   *
   * ⚠️ 它**不再**是拒绝给建议的门槛。历史上它在 `>= 3` 时会让引擎返回
   * 「信息不足」，但那使工具在 9 人桌现金局里基本失效
   *（「一家开池、几家跟注」是常态）。现在 ≥3 家照常分析，
   * 由 `MULTIWAY_APPROXIMATION` 如实声明算了几家、还有几家没说话。
   */
  realizedOpponentCount: number;
  /** 还没轮到说话的对手数（用于如实提示，**不**用于拒绝） */
  playersYetToAct: number;
  /** 下注轮是否已结束（所有人都跟平/弃牌/全下） */
  bettingRoundComplete: boolean;
  handComplete: boolean;
  potBB: number;
  currentBetBB: number;
  callAmountBB: number;
  minBetBB: number | null;
  minRaiseToBB: number | null;
  allInToBB: number | null;
  /** 当前行动者的合法动作按钮（含尺寸展开项） */
  actionButtons: readonly TableActionButton[];
  legalActionTypes: readonly ManualActionType[];
  seats: readonly SeatView[];
  /**
   * **本手拓扑**（Table Topology Correction §61）。
   *
   * 前端要显示「9 座桌 · 本手 8 人」，而 `tableSize` 只回答「桌子有几个座位」。
   * 把拓扑**算好的结果**直接发给前端，是为了让前端不必（也不允许）自己
   * 由容量反推盲注与角色 —— 那段推导一旦出现在前端，就会与引擎分歧。
   *
   * 本手未开始时为 `null`（此时还没有「本手」可言）。
   */
  handTopology: HandTopologySnapshot | null;
  /** 每个座位的当前剩余筹码（BB） */
  remainingStacksBB: Readonly<Partial<Record<Position, number>>>;
  effectiveStackBB: number | null;
  canAnalyze: boolean;
  /**
   * **自动分析闸门**（AUTO ANALYZE）。
   *
   * 这是「现在该不该自动分析」的**唯一权威结论**，由后端算好。
   * 前端只读 `ready` 与 `state`，**不做任何规则判断** ——
   * 判断所需的每一条信息都来自引擎重建，前端自己判断必然与引擎分歧。
   */
  decision: DecisionReadiness;
  /** 不能分析时的中文原因（逐条） */
  analyzeBlockers: readonly string[];
  issues: readonly TableIssue[];
  warnings: readonly string[];
  /** 调试面板用：真正会送进 Alpha Pipeline 的结构（§81/§90） */
  manualHandInput: unknown | null;
  /** 引擎重建出的状态指纹（测试与红队用来比对「屏幕 vs 后端」） */
  stateFingerprint: string | null;
};

/** 从回合到回合保留的东西（`NEXT_HAND` 的语义表，写下来避免歧义） */
export const NEXT_HAND_KEEPS = Object.freeze([
  '座位与玩家绑定（除手后离桌者）',
  '玩家画像与动态提示',
  '环境',
  'Hero 逻辑位置',
  '牌桌 id 与下一个玩家编号',
]);

export const NEXT_HAND_CLEARS = Object.freeze([
  'Hero 手牌',
  '公共牌',
  '行动历史',
  '弃牌 / 全下状态',
  '本手是否已开始',
]);
