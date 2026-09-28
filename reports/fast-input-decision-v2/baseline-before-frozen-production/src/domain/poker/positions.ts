/**
 * 位置：座位映射、行动顺序、盲注位
 *
 * 规范第 2 / 43 条；Bug 预判 B14 / B15 / B21。
 *
 * 关键设计：
 * - 位置顺序以「庄家位（BTN）右边第一位 = 小盲位」的座位方向定义为基准。
 * - 翻牌前由庄家的下一位（枪口位）开始，大盲最后行动。
 * - 翻牌后由小盲位开始，庄家最后行动。
 * - 6 人桌与 9 人桌使用**各自独立的**顺序表，绝不互相套用。
 */

import { Position, TableSize, type TableSize as TableSizeType } from '../types.ts';

/**
 * 位置顺序表（按座位排列，从枪口位到小盲位）。
 * 数组下标即「座位序号 - 1」。
 *
 * 座位几何（唯一权威定义）：
 *   座位是顺时针排列的。庄家位（BTN）的下一位是小盲位（SB），
 *   再下一位是大盲位（BB），再下一位是枪口位（UTG）。
 *   也就是说，顺时针方向上「枪口位 → … → 庄家位 → 小盲位 → 大盲位」。
 *
 * 本表按这个顺时针顺序排列，因此：
 *   下标 0                              = 枪口位
 *   下标 (庄家位下标 + 1) mod 人数      = 小盲位
 *   下标 (庄家位下标 + 2) mod 人数      = 大盲位
 *
 * 9 人桌：UTG(0) UTG1(1) UTG2(2) LJ(3) HJ(4) CO(5) BTN(6) SB(7) BB(8)
 * 6 人桌：UTG(0) HJ(1)   CO(2)   BTN(3) SB(4) BB(5)
 */
export const POSITION_ORDER: Readonly<Record<TableSizeType, readonly Position[]>> = {
  6: [Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB, Position.BB],
  9: [
    Position.UTG,
    Position.UTG1,
    Position.UTG2,
    Position.LJ,
    Position.HJ,
    Position.CO,
    Position.BTN,
    Position.SB,
    Position.BB,
  ],
};

/** 某桌型允许出现的全部位置 */
export function positionsForTable(tableSize: TableSizeType): readonly Position[] {
  return POSITION_ORDER[tableSize];
}

/** 某桌型的位置数量 */
export function seatCount(tableSize: TableSizeType): number {
  return POSITION_ORDER[tableSize].length;
}

/** 位置在该桌型下的座位下标（0 起） */
export function seatIndexOfPosition(tableSize: TableSizeType, position: Position): number {
  const index = POSITION_ORDER[tableSize].indexOf(position);
  if (index < 0) {
    throw new Error(`seatIndexOfPosition: ${tableSize} 人桌不存在位置 ${position}`);
  }
  return index;
}

/** 座位下标（0 起）对应的位置 */
export function positionAtSeatIndex(tableSize: TableSizeType, seatIndex: number): Position {
  const order = POSITION_ORDER[tableSize];
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= order.length) {
    throw new Error(`positionAtSeatIndex: ${tableSize} 人桌不存在座位下标 ${seatIndex}`);
  }
  return order[seatIndex]!;
}

/** 把数组旋转到以指定下标为第一个元素 */
function rotateTo<T>(items: readonly T[], index: number): T[] {
  if (index === 0) return items.slice();
  return [...items.slice(index), ...items.slice(0, index)];
}

/**
 * 翻牌前行动顺序：枪口位开始 → … → 庄家位 → 小盲位 → 大盲位（大盲最后）。
 *
 * 注意：这与「从枪口位出发的座位顺序」完全一致，
 * 因为座位几何恰好是「枪口位 … 庄家位 小盲位 大盲位」。
 *
 * 9 人桌示例：UTG, UTG1, UTG2, LJ, HJ, CO, BTN, SB, BB
 * 6 人桌示例：UTG, HJ, CO, BTN, SB, BB
 */
export function preflopOrder(tableSize: TableSizeType, button: Position): Position[] {
  const order = POSITION_ORDER[tableSize];
  const utgIndex = (seatIndexOfPosition(tableSize, button) + 3) % order.length;
  const { sb, bb } = blindsOf(tableSize, button);
  const withoutBlinds = rotateTo(order, utgIndex).filter((p) => p !== sb && p !== bb);
  return [...withoutBlinds, sb, bb];
}

/**
 * 翻牌后行动顺序：小盲位开始 → 大盲位 → 枪口位 → … → 庄家位（庄家最后）。
 *
 * 9 人桌示例：SB, BB, UTG, UTG1, UTG2, LJ, HJ, CO, BTN
 */
export function postflopOrder(tableSize: TableSizeType, button: Position): Position[] {
  const order = POSITION_ORDER[tableSize];
  const sbIndex = (seatIndexOfPosition(tableSize, button) + 1) % order.length;
  return rotateTo(order, sbIndex);
}


/** 是否单挑（只剩两人） */
export function isHeadsUp(activeCount: number): boolean {
  return activeCount === 2;
}

/* ============================================================
 * 本手拓扑：容量 ≠ 人数（Table Topology Correction）
 * ============================================================ */

/**
 * ## 🔴 三个数字必须分开
 *
 * | 概念 | 含义 | 谁决定 |
 * |---|---|---|
 * | **tableCapacity** | 牌桌有几个**物理座位** | 牌桌配置（6 或 9） |
 * | **handedness** | 本手**实际发牌给几个人** | 本手参与者数量 |
 * | **occupied** | 现在有几个座位有人 | 座位生命周期 |
 *
 * 修复前 `tableSize` 同时表达「9 座牌桌」与「本手 9 人」——
 * 于是 9 座桌只要有一个人离开，整张桌子就**无法分析**。
 * 那是错误的数据模型，不是限制。
 *
 * ## 位置的权威定义（§22 Canonical Position Mapping）
 *
 * 位置**不是座位的永久属性**，而是每一手根据
 * 「Button + 本手参与者」动态产生的**角色**。
 *
 * 本表按「离 Button 越远越靠前」定义，从枪口位到小盲位：
 *
 * | 人数 | 位置（从枪口位到小盲位） |
 * |---|---|
 * | 9 | UTG UTG1 UTG2 LJ HJ CO BTN SB BB |
 * | 8 | UTG UTG1 LJ HJ CO BTN SB BB |
 * | 7 | UTG LJ HJ CO BTN SB BB |
 * | 6 | UTG HJ CO BTN SB BB |
 * | 5 | HJ CO BTN SB BB |
 * | 4 | CO BTN SB BB |
 * | 3 | BTN SB BB |
 * | 2 | BTN BB（单挑：Button 同时是小盲） |
 *
 * ⚠️ 6 人与 9 人的两行**与既有 `POSITION_ORDER` 逐字一致** ——
 * 这是「新拓扑没有改变满桌行为」的可执行证据（§81）。
 */
export const CANONICAL_ROLES: Readonly<Record<number, readonly Position[]>> = Object.freeze({
  9: Object.freeze([
    Position.UTG,
    Position.UTG1,
    Position.UTG2,
    Position.LJ,
    Position.HJ,
    Position.CO,
    Position.BTN,
    Position.SB,
    Position.BB,
  ]),
  8: Object.freeze([
    Position.UTG,
    Position.UTG1,
    Position.LJ,
    Position.HJ,
    Position.CO,
    Position.BTN,
    Position.SB,
    Position.BB,
  ]),
  7: Object.freeze([
    Position.UTG,
    Position.LJ,
    Position.HJ,
    Position.CO,
    Position.BTN,
    Position.SB,
    Position.BB,
  ]),
  6: Object.freeze([
    Position.UTG,
    Position.HJ,
    Position.CO,
    Position.BTN,
    Position.SB,
    Position.BB,
  ]),
  5: Object.freeze([Position.HJ, Position.CO, Position.BTN, Position.SB, Position.BB]),
  4: Object.freeze([Position.CO, Position.BTN, Position.SB, Position.BB]),
  3: Object.freeze([Position.BTN, Position.SB, Position.BB]),
  2: Object.freeze([Position.BTN, Position.BB]),
});

/** 本手人数 → 该人数的位置角色表（从枪口位到小盲位） */
export function canonicalRolesOf(handedness: number): readonly Position[] {
  const roles = CANONICAL_ROLES[handedness];
  if (roles === undefined) {
    throw new Error(`canonicalRolesOf: 不支持的本手人数 ${handedness}（支持 2~9）`);
  }
  return roles;
}

/** 本手是否单挑（2 人） */
export function isHeadsUpHand(handedness: number): boolean {
  return handedness === 2;
}

/**
 * 按**物理座位顺序**排列的参与者。
 *
 * 容量 6/9 的座位环由 `POSITION_ORDER` 定义（下标 0 = 枪口位，顺时针递增）。
 * 空座位被跳过，但**下标保持物理含义** —— 这正是「非连续空位」能被正确
 * 处理的原因：行动顺序按物理座位环绕，而不是按数组下标重排。
 */
export function occupiedSeatIndices(
  tableCapacity: TableSizeType,
  occupied: readonly Position[],
): readonly number[] {
  const order = POSITION_ORDER[tableCapacity];
  const set = new Set(occupied);
  const indices: number[] = [];
  for (let i = 0; i < order.length; i += 1) {
    if (set.has(order[i]!)) indices.push(i);
  }
  const unknown = [...set].filter((p) => !order.includes(p));
  if (unknown.length > 0) {
    throw new Error(
      `occupiedSeatIndices: ${tableCapacity} 座桌上没有这些座位 ${unknown.join('、')}`,
    );
  }
  return indices;
}

/**
 * Button 轮转：从 `fromSeat` 顺时针找**下一个**合格座位。
 *
 * ## 语义（§16–§18）
 *
 * - 从**上一手的 Button 物理座位**继续顺时针找，**不是**重新从 0 号位算
 * - 跳过所有不合格座位（空座 / 暂离 / 手后离桌 / 等待下一手 / 筹码为 0）
 * - 跨数组边界（§17 wrap around）
 * - Button 本人离桌也照样从他那个座位继续往后找（§18）
 *
 * @param fromSeat 上一手 Button 的物理座位下标
 * @param eligibleSeats 本手合格座位的下标（升序）
 */
export function nextButtonSeat(fromSeat: number, eligibleSeats: readonly number[]): number {
  if (eligibleSeats.length === 0) {
    throw new Error('nextButtonSeat: 没有合格座位');
  }
  for (const seat of eligibleSeats) {
    if (seat > fromSeat) return seat;
  }
  return eligibleSeats[0]!; // 环绕
}

/**
 * 由「容量 + 参与者 + Button 座位」算出**本手的所有拓扑角色**。
 *
 * ## 算法（一句话）
 *
 * 从 Button 座位顺时针走一圈，遇到的第 1 个参与者是小盲、第 2 个是大盲，
 * 之后依次是枪口位 …… 关煞位（即 `canonicalRolesOf(n)` 从前往后）。
 *
 * ## 单挑特例（§33）
 *
 * 2 人时 **Button 就是小盲**：`blindRoleOf` 把小盲判给 Button 本人，
 * 另一个人是大盲。位置的**名字**仍然只有两个（BTN / BB）——
 * 不为了显示而发明第三个位置。
 *
 * @returns `roles` 形如 `{ positionsBySeatIndex, sbSeatIndex, bbSeatIndex, buttonSeatIndex, firstToActSeatIndex }`
 */
export type HandTopologySeats = {
  tableCapacity: TableSizeType;
  handedness: number;
  /** 参与者座位下标（升序） */
  participantSeatIndices: readonly number[];
  buttonSeatIndex: number;
  /** 小盲的座位下标（单挑时 = buttonSeatIndex） */
  smallBlindSeatIndex: number;
  bigBlindSeatIndex: number;
  /** 座位下标 → 本手位置角色；不在参与者里的座位没有条目 */
  roleBySeatIndex: Readonly<Record<number, Position>>;
  /** 翻牌前第一个行动的座位下标 */
  firstToActSeatIndex: number;
  /**
   * 盲注是否是**同一个人**（单挑）。
   *
   * 🔴 这里刻意把「位置名」与「盲注角色」分成两件事：
   * 单挑时 Button 的**位置名**仍是 `BTN`，但他的**盲注角色**是小盲。
   * 若为了显示而给他起名 `BTN_SB`，就会凭空多出一个策略键。
   */
  buttonAlsoPostsSmallBlind: boolean;
};

export function handTopologySeats(
  tableCapacity: TableSizeType,
  occupied: readonly Position[],
  buttonSeat: Position,
): HandTopologySeats {
  const order = POSITION_ORDER[tableCapacity];
  const handSeats = occupiedSeatIndices(tableCapacity, occupied);
  const buttonIndex = seatIndexOfPosition(tableCapacity, buttonSeat);
  if (!handSeats.includes(buttonIndex)) {
    throw new Error(
      `handTopologySeats: Button 座位 ${buttonSeat} 不在本手参与者里`,
    );
  }
  const n = handSeats.length;
  if (n < 2) throw new Error(`handTopologySeats: 本手至少需要 2 名参与者（收到 ${n}）`);

  // 顺时针（下标递增，环绕）从 Button 之后开始收集其余参与者
  const clockwiseAfterButton: number[] = [];
  for (let step = 1; step < order.length; step += 1) {
    const index = (buttonIndex + step) % order.length;
    if (handSeats.includes(index)) clockwiseAfterButton.push(index);
  }

  const roles = canonicalRolesOf(n);
  const roleBySeatIndex: Record<number, Position> = {};
  roleBySeatIndex[buttonIndex] = Position.BTN;

  const headsUp = n === 2;
  const smallBlindSeatIndex = headsUp ? buttonIndex : clockwiseAfterButton[0]!;
  const bigBlindSeatIndex = headsUp ? clockwiseAfterButton[0]! : clockwiseAfterButton[1]!;

  /*
   * 小盲 / 大盲的角色名。
   *
   * 🔴 **单挑时不能写 SB**（Table Topology Correction 缺陷修复）：
   * 单挑的 Button **本人**就是小盲（规范第 33 条），但「位置名」只有一个 ——
   * 那个座位叫 **BTN**，不叫 SB。`canonicalRolesOf(2)` 是 `['BTN', 'BB']`，
   * 若这里把 `smallBlindSeatIndex`（= Button 座位）写成 `SB`，
   * 就会把上面刚写好的 `BTN` **覆盖掉**，于是整手牌找不到 Button，
   * 位置名与 `canonicalRolesOf` 自相矛盾。
   *
   * 「谁下小盲」由 `buttonAlsoPostsSmallBlind` 与 `smallBlindSeatIndex` 表达，
   * 不需要也不允许占用位置名去表达。
   */
  if (!headsUp) roleBySeatIndex[smallBlindSeatIndex] = Position.SB;
  roleBySeatIndex[bigBlindSeatIndex] = Position.BB;

  // 其余座位依次是「枪口位 …… 关煞位」
  const earlyAndMiddle = roles.filter(
    (role) => role !== Position.BTN && role !== Position.SB && role !== Position.BB,
  );
  const rest = clockwiseAfterButton.filter(
    (index) => index !== smallBlindSeatIndex && index !== bigBlindSeatIndex,
  );
  if (rest.length !== earlyAndMiddle.length) {
    throw new Error(
      `handTopologySeats: 内部不一致 —— 待命名座位 ${rest.length} 个，角色 ${earlyAndMiddle.length} 个`,
    );
  }
  rest.forEach((index, i) => {
    roleBySeatIndex[index] = earlyAndMiddle[i]!;
  });

  // 翻牌前第一个行动的人：大盲之后的那一位（单挑时是 Button 本人）
  const firstToActSeatIndex = headsUp
    ? buttonIndex
    : (() => {
        for (let step = 1; step <= order.length; step += 1) {
          const index = (bigBlindSeatIndex + step) % order.length;
          if (handSeats.includes(index)) return index;
        }
        throw new Error('handTopologySeats: 找不到翻牌前第一个行动的人');
      })();

  return {
    tableCapacity,
    handedness: n,
    participantSeatIndices: Object.freeze([...handSeats].sort((a, b) => a - b)),
    buttonSeatIndex: buttonIndex,
    smallBlindSeatIndex,
    bigBlindSeatIndex,
    roleBySeatIndex: Object.freeze(roleBySeatIndex),
    firstToActSeatIndex,
    buttonAlsoPostsSmallBlind: headsUp,
  };
}

/**
 * 单挑盲注位（保留旧签名，语义与规范第 33 条一致）。
 *
 * ⚠️ 这是**旧接口**：它假定「Button 的下一位是小盲」。
 * 非满桌时请改用 `handTopologySeats`。保留它是为了不破坏既有调用与测试。
 */
export function blindsOf(tableCapacity: TableSizeType, button: Position): { sb: Position; bb: Position } {
  const order = POSITION_ORDER[tableCapacity];
  const buttonIndex = seatIndexOfPosition(tableCapacity, button);
  return {
    sb: order[(buttonIndex + 1) % order.length]!,
    bb: order[(buttonIndex + 2) % order.length]!,
  };
}


/** 位置分组：前位 / 中位 / 后位 / 盲注位 */
export function positionGroup(
  tableSize: TableSizeType,
  position: Position,
): 'early' | 'middle' | 'late' | 'blind' {
  if (position === Position.SB || position === Position.BB) return 'blind';
  if (position === Position.BTN || position === Position.CO) return 'late';
  if (position === Position.HJ || position === Position.LJ) return 'middle';
  // 6 人桌没有 LJ / UTG1 / UTG2，此处仅 9 人桌会走到 UTG/UTG1/UTG2，
  // 以及 6 人桌的 UTG
  const order = POSITION_ORDER[tableSize];
  const idx = seatIndexOfPosition(tableSize, position);
  return idx <= 1 ? 'early' : 'middle';
}

export { Position, TableSize };
export type { TableSizeType };
