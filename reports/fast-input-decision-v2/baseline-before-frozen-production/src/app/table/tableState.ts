/**
 * 牌桌状态：创建、视觉旋转、派生查询
 *
 * ## 这一层最重要的两个概念分离
 *
 * ### 1. `logicalPosition` ≠ `visualIndex`
 *
 * ```
 * logicalPosition  → 参与一切计算（行动顺序、盲注、范围、决策）
 * visualIndex      → 只参与渲染（Hero 固定 6 点钟）
 * ```
 *
 * 后端同时给出两者，**前端不做任何换算** —— 于是「因为 Hero 显示在底部
 * 就把他的位置当成 BB」这类错误在结构上不可能发生：前端根本没有
 * 把视觉位置翻译成逻辑位置的那段代码。
 *
 * ### 2. 座位顺序的两套排列
 *
 * - `logicalSeatOrder` = `positionsForTableOf(tableSize)`（UTG → … → BB）
 * - `visualSeatOrder`  = `rotateAroundHero(logicalSeatOrder, heroPosition)`
 *
 * 后者只被渲染使用；任何计算走前者。
 */

import { Position, positionsForTableOf, type TableSize } from '../../domain/types.ts';
import { handTopologySeats } from '../../domain/poker/positions.ts';
import { POSITION_ZH } from '../manualInput/manualInput.ts';
import {
  OCCUPIED_STATUSES,
  SeatStatus,
  SEAT_STATUS_ZH,
  TABLE_STATE_VERSION,
  type HandTopologySnapshot,
  type PokerTableState,
  type SeatView,
  type TableCore,
  type TablePlayer,
  type TableSeat,
} from './table.types.ts';

/* ============================================================
 * 视觉旋转（**纯渲染**）
 * ============================================================ */

/**
 * 把逻辑座位顺序旋转成「以 Hero 为 0 号位」的视觉顺序。
 *
 * ## 方向
 *
 * 视觉序号沿**行动方向**增大，在屏幕上表现为「从 6 点钟出发逆时针」
 * （下 → 左 → 上 → 右）。这样「轮到 Hero 之后的那一家」出现在
 * Hero 的左手边 —— 与真实牌桌上的观察一致。
 *
 * ## 🔴 这是纯函数，且**只被渲染使用**
 *
 * 它不读取也不修改任何逻辑字段。测试会断言：
 * 对同一个逻辑状态，任意 Hero 位置下 `logicalPosition` 逐位不变。
 */
export function rotateAroundHero(
  logicalSeatOrder: readonly Position[],
  heroPosition: Position,
): readonly Position[] {
  const index = logicalSeatOrder.indexOf(heroPosition);
  if (index < 0) return logicalSeatOrder.slice();
  return [...logicalSeatOrder.slice(index), ...logicalSeatOrder.slice(0, index)];
}

/**
 * 视觉序号 → 渲染角度（度）。
 *
 * `0°` = 6 点钟方向（正下方）；沿行动方向（屏幕上逆时针）增大。
 *
 * | 视觉序号 | 6 人桌角度 | 位置 |
 * |---|---|---|
 * | 0 | 0° | 正下方（Hero） |
 * | 1 | 60° | 左下 |
 * | 2 | 120° | 左上 |
 * | 3 | 180° | 正上方 |
 * | 4 | 240° | 右上 |
 * | 5 | 300° | 右下 |
 */
export function angleOfVisualIndex(visualIndex: number, seatCount: number): number {
  if (seatCount <= 0) return 0;
  return (visualIndex * 360) / seatCount;
}

/** 逻辑座位顺序（唯一真相来源，来自领域层） */
export function logicalSeatOrder(tableSize: TableSize): readonly Position[] {
  return positionsForTableOf(tableSize);
}

/** 视觉座位顺序（只影响渲染） */
export function visualSeatOrder(
  tableSize: TableSize,
  heroPosition: Position,
): readonly Position[] {
  return rotateAroundHero(logicalSeatOrder(tableSize), heroPosition);
}

/** 位置 → 视觉序号 */
export function visualIndexOf(tableSize: TableSize, heroPosition: Position, position: Position): number {
  const order = visualSeatOrder(tableSize, heroPosition);
  const index = order.indexOf(position);
  return index < 0 ? 0 : index;
}

/* ============================================================
 * 创建
 * ============================================================ */

export const seatIdOfPosition = (position: Position): string => `seat_${position}`;

export type CreateTableOptions = {
  tableSize?: 6 | 9;
  heroPosition?: Position;
  defaultStackBB?: number;
  environment?: TableCore['environment'];
  bigBlindBB?: number;
  tableId?: string;
};

/**
 * 新建牌桌。
 *
 * ## 只放 Hero 一个玩家
 *
 * 其余座位是 `EMPTY`（显示「+ 加入玩家」）。
 * **空座位不阻断分析**（Table Topology Correction）：它们只是「本手不发牌」，
 * 参与者由 `participantSeatsOf` 决定。界面用 `staffingNotices` 如实显示
 * 「N 座桌 · 本手 M 人」，而不是逼使用者先把每个座位填满。
 */
export function createTable(options: CreateTableOptions = {}): PokerTableState {
  const tableSize = options.tableSize ?? 6;
  const heroPosition = options.heroPosition ?? Position.BTN;
  const defaultStackBB = options.defaultStackBB ?? 100;
  const positions = logicalSeatOrder(tableSize);

  const heroPlayerId = 'p1';
  const hero: TablePlayer = Object.freeze({
    playerId: heroPlayerId,
    displayName: '我（Hero）',
    quickProfile: 'UNKNOWN',
    dynamicHint: 'UNKNOWN',
    handsPlayed: 0,
    isHero: true,
  });

  const seats: TableSeat[] = positions.map((position) =>
    Object.freeze({
      seatId: seatIdOfPosition(position),
      logicalPosition: position,
      // 视觉序号只在这里算一次；Hero 换位时由 `withHeroPosition` 统一重算
      visualIndex: visualIndexOf(tableSize, heroPosition, position),
      playerId: position === heroPosition ? heroPlayerId : null,
      status: position === heroPosition ? SeatStatus.SEATED_ACTIVE : SeatStatus.EMPTY,
      sitOutNextHand: false,
      stackBB: defaultStackBB,
    }),
  );

  const core: TableCore = Object.freeze({
    tableId: options.tableId ?? 'local',
    revision: 0,
    tableSize,
    // 🔴 Button 是一等状态（规范第 15 条），不从 Hero 位置反推。
    //    新牌桌默认 Button 在庄家位座位。
    buttonSeatId: seatIdOfPosition(Position.BTN),
    // 本手还没开始 → 没有冻结的拓扑
    handTopology: null,
    handsCompleted: 0,
    heroPosition,
    heroPlayerId,
    seats: Object.freeze(seats),
    playersById: Object.freeze({ [heroPlayerId]: hero }),
    heroCards: Object.freeze([]),
    board: Object.freeze([]),
    actionHistory: Object.freeze([]),
    environment: options.environment ?? 'MID_LOW_STAKES',
    bigBlindBB: options.bigBlindBB ?? 100,
    defaultStackBB,
    handActive: false,
    nextPlayerNumber: 2,
    lastHandRemainingStacksBB: null,
    notices: Object.freeze([]),
    lastHandComplete: false,
  });

  return Object.freeze({ ...core, undo: Object.freeze([]) });
}

/* ============================================================
 * 派生查询
 * ============================================================ */

export function seatOfPosition(state: TableCore, position: Position): TableSeat | undefined {
  return state.seats.find((s) => s.logicalPosition === position);
}

export function seatById(state: TableCore, seatId: string): TableSeat | undefined {
  return state.seats.find((s) => s.seatId === seatId);
}

export function playerAt(state: TableCore, position: Position): TablePlayer | null {
  const seat = seatOfPosition(state, position);
  if (seat?.playerId == null) return null;
  return state.playersById[seat.playerId] ?? null;
}

/**
 * 画像查表 —— **必须按 playerId**（规范第 63 条）。
 *
 * ⚠️ 刻意**不提供** `getProfile(position)` 这类接口。
 * 位置会被换人、会被 Hero 旋转影响；按位置查画像，
 * 就会在「A 走了、B 坐进来」之后把 A 的画像用在 B 身上。
 */
export function profileOfPlayer(state: TableCore, playerId: string): TablePlayer | null {
  return state.playersById[playerId] ?? null;
}

/** 当前是否还有空座位 */
export function emptySeats(state: TableCore): readonly TableSeat[] {
  return state.seats.filter((s) => s.status === SeatStatus.EMPTY || s.playerId === null);
}

/**
 * 人员是否足以**发出这一手**（唯一真阻断判据）。
 *
 * ## 🔴 空座位不是阻断项（Table Topology Correction）
 *
 * 修复前这里写着「只要有空座位就无法分析」，理由是「Poker Core 要求
 * N 人桌恰好 N 位玩家」。**那个前提已经不成立**：域层的 `createGame`
 * 现在接受 `2 ≤ 本手人数 ≤ 座位容量`，`handTopologySeats` 按物理座位
 * 环绕派盲注、跳过空座。9 座桌坐 8 人是现金局最常见的形态，
 * 因此空座位只是「本手少几个人」，不是「这局没法看」。
 *
 * 保留的那条，恰恰是本轮要消灭的形态：**只把拦截点挪了个位置**。
 * 域层放行了 8/9，表层却还在 `canAnalyze=false` —— 产品路径上
 * 「9 座桌 8 人无法分析」依然成立。现在它被拆掉了。
 *
 * ## 仍然是真阻断的两条
 *
 * 1. **本手可参与者 < 2** —— 少于两个人不成局（`createGame` 也会拒绝）。
 * 2. **Hero 座位没有人** —— 没有 Hero 就没有可分析的决策点。
 *
 * 至于「暂离」，它是**个人意愿**：暂离座位由 `participantSeatsOf` 直接
 * 排除在本手之外（不参与、不发牌、不占盲注），因此同样不阻断分析。
 * 它的后果是「本手人数减少」，而减少人数现在是引擎支持的常态。
 */
export function staffingProblems(state: TableCore): readonly string[] {
  const problems: string[] = [];
  const participants = participantSeatsOf(state);

  if (participants.length < 2) {
    problems.push(
      `本手可参与的座位只有 ${participants.length} 个 —— 至少要 2 个人才能成局。` +
        '请点空座位「加入玩家」，或让暂离的人「重新入座」。',
    );
  }

  const heroSeat = seatOfPosition(state, state.heroPosition);
  if (heroSeat === undefined || heroSeat.playerId === null) {
    problems.push('Hero 的座位上没有玩家 —— 请先在 Hero 位置加入玩家。');
  }
  return problems;
}

/**
 * 本手的**非阻断**人员提示（给界面显示，不参与 `canAnalyze`）。
 *
 * 与 `staffingProblems` 刻意分开：这里是「如实告知现状」，
 * 那里是「能不能算」。把两者混在一个数组里，就是修复前
 * 「空座位阻断分析」的成因 —— 一条提示被当成了判据。
 */
export function staffingNotices(state: TableCore): readonly string[] {
  const notices: string[] = [];
  const participantPositions = new Set(
    participantSeatsOf(state).map((s) => s.logicalPosition),
  );

  const empties = state.seats.filter((s) => !participantPositions.has(s.logicalPosition));
  if (empties.length > 0) {
    notices.push(
      `本手 ${participantPositions.size} 人参与（${state.tableSize} 座桌），` +
        `${empties.length} 个座位不发牌：` +
        `${empties.map((s) => POSITION_ZH[s.logicalPosition]).join('、')}。`,
    );
  }

  const sittingOut = state.seats.filter(
    (s) => s.playerId !== null && s.status === SeatStatus.SITTING_OUT,
  );
  if (sittingOut.length > 0) {
    notices.push(
      `暂离中的座位（本手不参与）：${sittingOut
        .map((s) => POSITION_ZH[s.logicalPosition])
        .join('、')}。`,
    );
  }

  // ⚠️ 只把**已经生效**的暂离算进来；`sitOutNextHand`（下一手才暂离）
  // 在本手里人还在牌局中（规范第 53 条）。
  const sittingOutNext = state.seats.filter(
    (s) => s.playerId !== null && s.sitOutNextHand && s.status !== SeatStatus.SITTING_OUT,
  );
  if (sittingOutNext.length > 0) {
    notices.push(
      `下一手将暂离：${sittingOutNext
        .map((s) => POSITION_ZH[s.logicalPosition])
        .join('、')}。`,
    );
  }

  return notices;
}

/** 占用了座位的玩家数 */
export function seatedCount(state: TableCore): number {
  return state.seats.filter((s) => s.playerId !== null).length;
}

/* ============================================================
 * 本手拓扑：容量 ≠ 本手人数（Table Topology Correction）
 * ============================================================ */

/**
 * **可以参加下一手的座位**（§16 / §47）。
 *
 * 不合格的一律跳过：空座位 / `SITTING_OUT` / **筹码为 0**（§47：
 * 0BB 玩家不得自动参与，需要补码或暂离）。
 *
 * ⚠️ `LEAVING_AFTER_HAND` **不在这里**被排除 —— 他在下一手开始前会被
 * `nextHand` 真正清空成 `EMPTY`，到那时自然不合格。
 */
export function eligibleButtonSeats(state: TableCore): readonly TableSeat[] {
  return state.seats.filter(
    (s) =>
      s.playerId !== null &&
      s.status !== SeatStatus.EMPTY &&
      s.status !== SeatStatus.SITTING_OUT &&
      s.stackBB > 0,
  );
}

/** 本手参与者（= 合格座位） */
export function participantSeatsOf(state: TableCore): readonly TableSeat[] {
  return eligibleButtonSeats(state);
}

/**
 * Button 轮转（§16–§18）：从**当前 Button 的物理座位**顺时针找下一个合格座位。
 *
 * 🔴 三个必须做对的地方：
 * 1. 从**旧 Button 座位**继续，不是重新从 0 号位算（§18）
 * 2. 跳过所有不合格座位（空 / 暂离 / 0 筹码）
 * 3. 跨数组边界环绕（§17）
 *
 * ⚠️ 顺序必须是**物理座位环**顺序，不能按 playerId、不能按视觉序号、
 * 不能按中文位置名排序（§37）。
 */
export function advanceButtonSeatId(state: TableCore): string {
  const order = logicalSeatOrder(state.tableSize);
  const eligible = new Set(eligibleButtonSeats(state).map((s) => s.logicalPosition));
  if (eligible.size === 0) return state.buttonSeatId; // 没有合格座位 → 不动，由人员判据报告
  const currentPosition = seatById(state, state.buttonSeatId)?.logicalPosition;
  const fromIndex = currentPosition !== undefined ? order.indexOf(currentPosition) : -1;

  for (let step = 1; step <= order.length; step += 1) {
    const position = order[(fromIndex + step + order.length) % order.length]!;
    if (eligible.has(position)) return seatIdOfPosition(position);
  }
  return state.buttonSeatId;
}

/**
 * 🔴 **有效的 Button 座位**（2026-09 修复）。
 *
 * ## 修的是什么
 *
 * `buttonSeatId` 是「哪个座位是庄家」，但它**可能指向一个已经不能坐的座位**：
 *
 * | 触发 | 场景 |
 * |---|---|
 * | 「把 Hero 放到别的位置」 | Hero 腾空了自己的旧座位 —— 若那正是 Button 座位，Button 就悬空了 |
 * | 「清空座位 / 清空其他玩家」 | 被清掉的人如果拿着 Button，同样悬空 |
 * | 「换桌型」 | 座位被裁掉时 Button 可能指向一个**已经不存在的座位** |
 *
 * 下游（`freezeTopology` 与预览）原先在「Button 不在参与者里」时
 * **静默回落到 `positions[0]`**（第一个参与者）。使用者实测能看到错乱：
 *
 * ```text
 * Hero 从 BTN 挪到 CO 之后（修复前）：
 *   玩家2（UTG 座位） → 庄家位                    ← 被 positions[0] 回落接管
 *   空座位（BTN）     → 庄家位 · 本手不参与        ← 同一个「庄家位」出现两次
 *   我（Hero，CO）    → 大盲位                     ← 与顶栏「Hero 在 CO」自相矛盾
 * ```
 *
 * ## 为什么不是「把 buttonSeatId 改掉」
 *
 * 试过在写状态时立刻把 Button 挪走 —— 结果 `NEXT_HAND` 会**二次轮转**
 * （先挪一次、开新手再轮一次），中间那个人永远拿不到 Button，盲注归属全错。
 * `test/tableTopology.test.ts` 的 §4b 正是抓这个的。
 *
 * 因此正确做法是**只改「怎么读」**：状态里的 `buttonSeatId` 语义保持不变
 * （轮转仍从它出发），而**显示与本手拓扑**用「从它顺时针找到的第一个合格座位」，
 * 也就是 `NEXT_HAND` 将要轮到的那一个 —— 两边用同一套算法，永远不会分歧。
 */
export function effectiveButtonSeatId(state: TableCore): string {
  const seat = seatById(state, state.buttonSeatId);
  const legal =
    seat !== undefined &&
    seat.playerId !== null &&
    seat.status !== SeatStatus.EMPTY &&
    seat.status !== SeatStatus.SITTING_OUT &&
    seat.stackBB > 0;
  return legal ? state.buttonSeatId : advanceButtonSeatId(state);
}

/**
 * 冻结本手拓扑快照（§10）。
 *
 * 输入**只有三样**：容量 + 参与者座位 + Button 座位。
 * 因此快照一旦生成，就不会被后续的座位生命周期操作改变（§11）。
 */
export function freezeTopology(state: TableCore, handNumber: number): HandTopologySnapshot {
  const participants = participantSeatsOf(state);
  const positions = participants.map((s) => s.logicalPosition);
  /*
   * 🔴 用**有效** Button（见 `effectiveButtonSeatId`）：Button 座位空了/被裁掉时
   * 顺时针找下一个合格座位，而不是回落到「第一个参与者」——后者会凭空造出
   * 一个不存在的庄家，并让两个座位同时显示「庄家位」。
   */
  const buttonSeat = seatById(state, effectiveButtonSeatId(state));
  const buttonPosition =
    buttonSeat !== undefined && positions.includes(buttonSeat.logicalPosition)
      ? buttonSeat.logicalPosition
      : positions[0]!;

  const topology = handTopologySeats(state.tableSize, positions, buttonPosition);
  const ring = logicalSeatOrder(state.tableSize);
  const seatIdAt = (index: number): string => seatIdOfPosition(ring[index]!);

  const rolesBySeatId: Record<string, Position> = {};
  for (const [indexText, role] of Object.entries(topology.roleBySeatIndex)) {
    rolesBySeatId[seatIdAt(Number(indexText))] = role as Position;
  }

  return Object.freeze({
    handNumber,
    tableCapacity: state.tableSize,
    participantSeatIds: Object.freeze([...topology.participantSeatIndices].map(seatIdAt)),
    handedness: topology.handedness,
    buttonSeatId: seatIdAt(topology.buttonSeatIndex),
    smallBlindSeatId: seatIdAt(topology.smallBlindSeatIndex),
    bigBlindSeatId: seatIdAt(topology.bigBlindSeatIndex),
    rolesBySeatId: Object.freeze(rolesBySeatId),
    buttonAlsoPostsSmallBlind: topology.buttonAlsoPostsSmallBlind,
  });
}

/** 本手拓扑：优先用已冻结的快照，没有就按当前座位现算（只读路径用） */
export function handTopologyOf(state: TableCore): HandTopologySnapshot {
  return state.handTopology ?? freezeTopology(state, state.handsCompleted + 1);
}

/** 某个座位的**本手位置角色**（不是座位的永久属性，§9） */
export function roleOfSeat(state: TableCore, seatId: string): Position | null {
  return handTopologyOf(state).rolesBySeatId[seatId] ?? null;
}

/** Hero 的**本手位置角色** */
export function heroRole(state: TableCore): Position | null {
  const seat = seatOfPosition(state, state.heroPosition);
  return seat === undefined ? null : roleOfSeat(state, seat.seatId);
}

/** 本手人数（**不是**容量） */
export function handednessOf(state: TableCore): number {
  return handTopologyOf(state).handedness;
}

/** 本手已经开始？ */
export function handStarted(state: TableCore): boolean {
  return state.handActive;
}

export { SeatStatus, SEAT_STATUS_ZH, OCCUPIED_STATUSES, TABLE_STATE_VERSION };
export type { HandTopologySnapshot, PokerTableState, SeatView, TableCore, TablePlayer, TableSeat };
