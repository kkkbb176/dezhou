/**
 * 牌桌状态 → `ManualHandInput` 的**纯转换**
 *
 * ## 这个模块存在的唯一理由
 *
 * 让「用户在牌桌上点出来的东西」与「Alpha Pipeline 收到的东西」
 * 之间**只有一个**转换点。这样红队要验证「屏幕显示 = 实际提交 = 后端状态」
 * 时，只需要审这一个函数。
 *
 * 🔴 **本文件不许有任何策略判断。** 它不做「该不该弃牌」「这个范围合不合理」
 * 之类的事 —— 那些属于 Decision Engine。它只做结构映射。
 *
 * ## 两个必须说清楚的地方
 *
 * ### 1. 首要对手（primary opponent）必须**按 playerId** 解析
 *
 * `contextBuilder` 只用**一个**对手的范围建权（座位序里第一个未弃牌的非 Hero 玩家）。
 * 因此传进去的 `villain.quickProfile` 必须是**那个人的**画像。
 * 传错人就等于「用甲的性格给乙做决策」—— 红队清单第 4 条要打的就是它。
 *
 * 本函数复刻同一个判据（座位序 + 未弃牌），因此不会错位；
 * 并且额外传 `villainPlayerId`，让动态层也绑定到同一个 playerId。
 *
 * ### 2. `logicalPosition` 是唯一真相
 *
 * 本函数**只读** `logicalPosition`，从不读 `visualIndex`。
 * 视觉旋转对它是不可见的 —— 这正是「Hero 固定底部」不会污染逻辑的原因。
 */

import { Position, positionsForTableOf, Street } from '../../domain/types.ts';
import type { ManualAction, ManualHandInput, ManualVillain } from '../manualInput/manualInput.ts';
import { BOARD_COUNT_BY_STREET } from '../manualInput/manualInput.ts';
import { playerIdOfPosition } from '../manualInput/reconstruct.ts';
import type { PokerTableState, TableIssue } from './table.types.ts';
import { SeatStatus } from './table.types.ts';
import { positionFolded, seatOfPosition } from './seatLifecycle.ts';
import { staffingProblems } from './tableState.ts';
import { participantSeatsOf, seatById } from './tableState.ts';

/**
 * 公共牌张数 → 声明的街道（1~2 张为「选择中」，没有合法街道）。
 *
 * 🔴 **不在这里重写 0/3/4/5**（Table Topology Correction 之后的纪律延续）：
 * 本函数是 `BOARD_COUNT_BY_STREET` 的**反查**，从唯一权威表里找匹配项。
 *
 * 从前这里写死了四个 `if`。它与解析器里的 `BOARD_COUNT_BY_STREET`
 * 是同一件事的两份副本 —— 一旦有人给某一街加减牌数（例如加「短牌」变体），
 * 两份就会漂移，而漂移的表现形式是「适配器声明翻牌、解析器认为该是转牌」，
 * 诊断成本极高。现在改了权威表，本函数自动跟随。
 *
 * ⚠️ 张数不在表里（1~2 张 = 用户正在选牌）时返回 `null`，
 * 由调用方给出可显示的中文原因。
 */
export function declaredStreetOfBoard(boardCount: number): ManualHandInput['street'] | null {
  for (const street of STREETS_BY_BOARD_COUNT) {
    if (BOARD_COUNT_BY_STREET[street] === boardCount) return street;
  }
  return null; // 1~2 张：选择中
}

/**
 * 街道的**唯一**枚举顺序（翻牌前 → 河牌），供反查用。
 *
 * 与 `BOARD_COUNT_BY_STREET` 配合：前者给顺序，后者给张数，
 * 于是「张数 → 街道」是一次纯查表，不含任何魔法数字。
 */
const STREETS_BY_BOARD_COUNT: readonly Street[] = Object.freeze([
  Street.PREFLOP,
  Street.FLOP,
  Street.TURN,
  Street.RIVER,
]);

/**
 * 首要对手：**座位序里第一个未弃牌的非 Hero 位置**。
 *
 * ⚠️ 判据必须与 `contextBuilder` 内部的 `opponents[0]` 完全一致，
 * 否则画像会被挂到别人身上。因此这里按 `positionsForTableOf` 的顺序扫描，
 * 并用「该位置最后一条动作是不是 FOLD」判定弃牌 ——
 * 引擎的 `folded` 标志就是由这条规则产生的（弃牌后不允许再行动）。
 */
export function primaryOpponentPosition(state: PokerTableState): Position | null {
  const order = positionsForTableOf(state.tableSize);
  for (const position of order) {
    if (position === state.heroPosition) continue;
    const seat = seatOfPosition(state, position);
    if (seat === undefined || seat.playerId === null) continue;
    if (positionFolded(state, position)) continue;
    return position;
  }
  return null;
}

export type AdapterResult =
  | { ok: true; input: ManualHandInput; primaryOpponentPosition: Position | null }
  | { ok: false; issues: readonly TableIssue[] };

/**
 * 牌桌状态 → `ManualHandInput`。
 *
 * 失败时返回**可显示的中文原因**，不抛异常 —— 牌桌 UI 每一帧都会调用它，
 * 抛异常会让一次误点把整个界面打断。
 */
export function tableStateToManualHandInput(state: PokerTableState): AdapterResult {
  const issues: TableIssue[] = [];

  // ---- 1. 人员：**只有两条真阻断**（空座位 / 暂离都不再阻断，见 `staffingProblems`）----
  for (const problem of staffingProblems(state)) {
    issues.push({ code: 'SEAT_EMPTY', message: problem });
  }

  // ---- 1b. 本手拓扑：容量 ≠ 本手人数（Table Topology Correction）----
  //
  // 🔴 **契约里有字段、却没有人填 = 空转**。修复前
  // `input.occupiedPositions` / `input.buttonPosition` 只有「解析器 + 哈希」
  // 两个使用者，生产者根本不存在：`reconstruct` 于是总是退回
  // 「容量 = 本手人数、Button = BTN」，9 座桌 8 人依旧发不出正确的牌。
  //
  // 这里把两个字段真正接上。取值规则只有一条：
  //
  // | 情形 | 参与者 | Button |
  // |---|---|---|
  // | 本手进行中 | 冻结快照 `handTopology.participantSeatIds` | 冻结快照 `buttonSeatId` |
  // | 本手未开始 | `participantSeatsOf(state)`（可参与下一手的人） | `state.buttonSeatId` |
  //
  // ⚠️ **本手进行中必须读冻结快照，不能重算**：本手里有人暂离或被清空，
  // 重算就会得到另一个参与者集合，而 `actionHistory` 是按**发牌时**的
  // 集合录的 —— 两边一旦不同，重放必然对不上（§142「已发生的 Current Hand
  // 事实不可被座位生命周期修改」）。
  const participantPositions: readonly Position[] =
    state.handActive && state.handTopology !== null
      ? state.handTopology.participantSeatIds
          .map((seatId) => seatById(state, seatId)?.logicalPosition)
          .filter((p): p is Position => p !== undefined)
      : participantSeatsOf(state).map((s) => s.logicalPosition);

  if (participantPositions.length < 2) {
    issues.push({
      code: 'SEAT_EMPTY',
      message:
        `本手可参与的座位只有 ${participantPositions.length} 个 —— 至少要 2 个人才能成局。` +
        '请点空座位「加入玩家」，或让暂离的人「重新入座」。',
    });
  }

  /*
   * Button 的物理座位。若当前 Button 恰好不在参与者里（例如他在本手进行中
   * 被清空），就交给 `handTopologySeats` 的既有兜底：取参与者中的第一个座位。
   * 这**不是**静默改数据 —— 那个座位本来就不该在牌局里，兜底只是为了让
   * 界面能继续渲染出「为什么不能分析」，而不是抛异常打断整帧。
   */
  const buttonSeatPosition = seatById(state, state.buttonSeatId)?.logicalPosition;
  const buttonPosition: Position =
    buttonSeatPosition !== undefined && participantPositions.includes(buttonSeatPosition)
      ? buttonSeatPosition
      : participantPositions[0]!;

  // ---- 2. Hero 手牌 ----
  if (state.heroCards.length !== 2) {
    issues.push({
      code: 'HERO_SEAT_REQUIRED',
      message: `Hero 手牌还没选满（已选 ${state.heroCards.length} / 2 张）`,
    });
  }

  // ---- 3. 公共牌张数 ----
  const street = declaredStreetOfBoard(state.board.length);
  if (street === null) {
    issues.push({
      code: 'INVALID_CARD',
      message:
        `公共牌选了 ${state.board.length} 张 —— 翻牌需要 3 张、转牌 4 张、河牌 5 张。` +
        '请把这一街的公共牌选完。',
    });
  }

  // ---- 4. 筹码 ----
  const heroSeat = seatOfPosition(state, state.heroPosition);
  const effectiveStackBB = heroSeat?.stackBB ?? state.defaultStackBB;
  if (!Number.isFinite(effectiveStackBB) || effectiveStackBB <= 0) {
    issues.push({
      code: 'INVALID_STACK',
      message: `Hero 座位的筹码非法（${String(effectiveStackBB)}）`,
    });
  }

  if (issues.length > 0 || street === null) {
    return { ok: false, issues };
  }

  // ---- 5. 逐座位筹码 ----
  //
  // ⚠️ **必须全部座位都写进去**（而不是只写「与 Hero 不同的」）：
  // 少写一个就会退回 `villain.stackBB` / `effectiveStackBB`，
  // 而那个回退值与屏幕上显示的未必相同。宁可写满，也不留隐式回退。
  const seatStacksBB: Partial<Record<Position, number>> = {};
  for (const seat of state.seats) {
    if (seat.playerId === null) continue;
    seatStacksBB[seat.logicalPosition] = seat.stackBB;
  }

  // ---- 6. 对手画像：**按 playerId 解析** ----
  //
  // 🔴 **两套 id 各有分工，绝不能混用**（这是本轮实测踩到的真实缺陷）：
  //
  // | id | 作用域 | 谁用 |
  // |---|---|---|
  // | 牌桌 `playerId`（`p1`/`p2`…） | **跨手**的真实身份 | 画像 / 动态观察的绑定与查找 |
  // | 引擎 `playerId`（`seat_UTG`…） | **本手内**的座位身份 | `GameState.actions[].playerId`、动态层的事件匹配 |
  //
  // 代价实测：把牌桌 `playerId` 传给管线之后，动态层按
  // `record.playerId === villainId` 过滤本手事件，两边永远匹配不上，
  // 于是 `computed: false` —— **动态层被静默关闭**，而界面上一切正常。
  //
  // 🔴🔴 **只传首要对手，不传 `villains` 数组**（红队命中 CRITICAL）：
  //
  // `parseManualInput` 的 `villain` 取的是 `villainList[0]`，而
  // `villainList = input.villains ?? [input.villain]` —— 也就是说
  // **只要给了 `villains`，`input.villain` 就被完全忽略**。
  //
  // 修复前这里把「全部对手（按座位序）」塞进 `villains`，于是：
  // 座位序里第一个对手（可能**已经弃牌**）的画像被当成「对手画像」送进决策，
  // 而范围与权益其实是按另一个（真正未弃牌的首要对手）算的 ——
  // **用甲的性格给乙做决策**，正是本轮最危险的那类缺陷。
  //
  // 现在：只传 `villain`，它**就是** `contextBuilder` 会用的那一位。
  const primary = primaryOpponentPosition(state);
  const primarySeat = primary !== null ? seatOfPosition(state, primary) : undefined;
  const primaryPlayer =
    primarySeat?.playerId != null ? state.playersById[primarySeat.playerId] : undefined;

  const villain: ManualVillain =
    primaryPlayer !== undefined && primary !== null
      ? {
          /*
           * 🔴 **引擎口径 id**（`seat_<位置>`）：**保持不变**。
           *
           * 它用于行动记录匹配（动态层按 `state.actions[].playerId` 过滤，
           * 而记录里写的就是座位 id）。`test/interactiveTable.test.ts` 与
           * `test/interactiveTableRedteam.test.ts` 把这条契约钉住了。
           */
          playerId: playerIdOfPosition(primary),
          /*
           * 🔴 **PLAYER IDENTITY ROUTING V1**：把**玩家持久身份**也带出去。
           *
           * 修复前这里只有座位 id，于是「是谁」在适配器上就丢了 ——
           * 下游只能拿座位 id 当画像键。现在三件事分开：
           *
           * ```text
           * playerId            = seat_BB          ← 座位（引擎口径）
           * persistentPlayerId  = p2               ← 玩家（换座位不变）
           * displayName         = 阿豪              ← 只显示
           * seatId              = seat_BB          ← 画像目标座位（显式，不靠猜）
           * ```
           *
           * 坐在同一座位上的**另一个人**会得到另一个 `persistentPlayerId`
           * ⇒ 画像天然隔离，不需要任何缓存清理逻辑。
           */
          persistentPlayerId: primaryPlayer.playerId,
          seatId: playerIdOfPosition(primary),
          displayName: primaryPlayer.displayName,
          quickProfile: primaryPlayer.quickProfile,
          dynamicHint: primaryPlayer.dynamicHint,
          ...(primarySeat?.stackBB !== undefined ? { stackBB: primarySeat.stackBB } : {}),
        }
      : {};

  const input: ManualHandInput = {
    tableSize: state.tableSize,
    heroPosition: state.heroPosition,
    heroCards: state.heroCards as unknown as readonly [string, string],
    board: state.board,
    street,
    effectiveStackBB,
    actionHistory: state.actionHistory as readonly ManualAction[],
    environment: state.environment,
    bigBlindBB: state.bigBlindBB,
    villain,
    seatStacksBB,
    // 🔴 **容量 ≠ 本手人数**：这两个字段是「9 座桌 8 人」能算对的唯一来源
    occupiedPositions: participantPositions,
    buttonPosition,
  };

  return { ok: true, input, primaryOpponentPosition: primary };
}

/**
 * 不依赖引擎的「渲染就绪度」检查（牌桌每一帧都要用）。
 *
 * 与 `AdapterResult` 的区别：这里**不要求人员齐备** ——
 * 空座位上还是要显示「+ 加入玩家」，还是要高亮当前行动者。
 * 它是「能不能分析」的判据，不是「能不能渲染」的判据。
 */
export function renderableSeats(state: PokerTableState): readonly Position[] {
  return state.seats.filter((s) => s.playerId !== null).map((s) => s.logicalPosition);
}

/** 座位是否本手已经弃牌（渲染用） */
export function seatFolded(state: PokerTableState, position: Position): boolean {
  const seat = seatOfPosition(state, position);
  if (seat?.status === SeatStatus.FOLDED_THIS_HAND) return true;
  return positionFolded(state, position);
}
