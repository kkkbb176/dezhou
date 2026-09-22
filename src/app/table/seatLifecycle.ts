/**
 * 座位生命周期与牌桌操作（**纯函数**）
 *
 * ## 这个模块在端到端链中解决什么
 *
 * 真实牌桌上人是会动的：弃牌、离桌、暂离、换人、下一手。这些动作**只应改变
 * 牌桌管理状态**，绝不能碰「当前这一手已经发生的历史事实」。
 *
 * 本模块把这条纪律写成一组纯函数：每个操作接收状态、返回**新的**状态，
 * 并且**只能**通过 `pushUndo` 记录历史。
 *
 * ## 🔴 三条硬不变量 → 三条代码级约束
 *
 * | 不变量 | 代码级约束 |
 * |---|---|
 * | Fold ≠ Leave Table | `FOLD` 只由 `ACT`（走 Poker Core）产生，且只把状态写成 `FOLDED_THIS_HAND`；`CLEAR_SEAT` 是唯一的「离桌」入口，写 `LEAVING_AFTER_HAND` |
 * | Seat ≠ Player | 换人**必须**新建 playerId；本文件里没有任何一处把旧 `TablePlayer` 复制给新 id |
 * | 历史事实不可删 | `actionHistory` 在本文件里只有两种变化：`ACT` 追加一条、`NEXT_HAND`/`NEW_TABLE`/`RESET_HAND` 整体清空。**没有任何一条路径按座位删除历史** |
 *
 * ## 为什么生命周期操作也经后端
 *
 * 因为「能不能清空」取决于当前手打到哪了（谁还需要行动、是否已投入筹码），
 * 那是**引擎状态**，不能让前端猜。前端只发意图，后端给结论。
 */

import { Position } from '../../domain/types.ts';
import { POSITION_ZH, type ManualAction, type ManualActionType } from '../manualInput/manualInput.ts';
import {
  ActiveHandLeaveChoice,
  MAX_UNDO_DEPTH,
  OCCUPIED_STATUSES,
  SeatStatus,
  type LeaveDecision,
  type PokerTableState,
  type TableCore,
  type TableIssue,
  type TableOp,
  type TableOpOutcome,
  type TablePlayer,
  type TableSeat,
} from './table.types.ts';
import {
  advanceButtonSeatId,
  angleOfVisualIndex,
  freezeTopology,
  logicalSeatOrder,
  participantSeatsOf,
  seatById,
  seatIdOfPosition,
  seatOfPosition,
  visualSeatOrder,
  visualIndexOf,
} from './tableState.ts';

/* ============================================================
 * 状态推进
 * ============================================================ */

/** 撤销栈里存 `TableCore`（不含它自己的撤销栈），避免历史树爆炸 */
function coreOf(state: PokerTableState): TableCore {
  const { undo: _undo, ...core } = state;
  void _undo;
  return core;
}

/**
 * 把新核心状态包装成完整状态，并把**旧**核心压入撤销栈。
 *
 * ⚠️ 所有变更都必须经过这里 —— 这是「撤销能恢复座位绑定与玩家状态」
 * （规范第 38 条）唯一的实现方式。绕过它就等于绕过了撤销。
 *
 * ## 🔴 空操作必须真的什么都不做（红队命中）
 *
 * 若新核心与旧核心**逐字段相同**，就不再推进 `revision`、不压撤销栈：
 * - 否则使用者按一次撤销会看到界面毫无变化（却消耗了一次撤销机会）
 * - 「版本变了但状态没变」会给竞态判断引入噪声
 *
 * 比较用 JSON 序列化。核心状态很小，且键序由构造顺序决定、稳定，
 * 因此这个比较是确定性的。
 */
export function commit(prev: PokerTableState, next: TableCore): PokerTableState {
  const snapshot = coreOf(prev);

  /*
   * 🔴 **本手拓扑的一致性由 `commit` 兜底**（Table Topology Correction，§10/§11）。
   *
   * 把「冻结 / 解冻」放在**唯一的写入口**，而不是散落在各个操作里：
   *
   * - `handActive === true` 且还没有快照 → **冻结**（一手开始的那一刻）
   * - `handActive === false` → 清空（下一手会重新冻结）
   *
   * 于是「本手开始后拓扑不再变化」成为一条**结构性**性质：
   * 任何操作路径都绕不过 `commit`，因此绕不过这条规则。
   */
  /*
   * 🔴 `handActive` 必须在这里**重算**，而不是只在「改牌面」的操作里算。
   *
   * 为什么：`handActive` 的判据包含「本手参与者 ≥ 2」，而参与者会因为
   * `ADD_PLAYER` / `CLEAR_SEAT` / `SIT_OUT` / `SET_TABLE_SIZE` 变化 ——
   * 那些操作路径里没人会去重算它。真实表现是：
   *
   * ```text
   * 新建牌桌（只有 Hero）→ 选好两张手牌（handActive=false，正确）
   * → 加入第二个人 → handActive 仍然是 false
   * ⇒ 引擎拿不到本手拓扑，轮到谁都不知道，界面停在「本手还没开始」
   * ```
   *
   * 把重算放在 `commit` —— **唯一的写入口** —— 之后，这条性质成为结构性的：
   * 任何操作路径都绕不过它，因此不可能出现「参与者够了但本手没开始」。
   * 这与 `handTopology` 的冻结/解冻是同一个理由（见上面那段注释）。
   */
  const recomputed: TableCore = { ...next, handActive: recomputeHandActive(next) };
  const normalized: TableCore =
    recomputed.handActive && recomputed.handTopology === null
      ? { ...recomputed, handTopology: freezeTopology(recomputed, recomputed.handsCompleted + 1) }
      : !recomputed.handActive && recomputed.handTopology !== null
        ? { ...recomputed, handTopology: null }
        : recomputed;

  if (JSON.stringify(snapshot) === JSON.stringify(normalized)) return prev;
  const undo = [snapshot, ...prev.undo].slice(0, MAX_UNDO_DEPTH);
  return Object.freeze({
    ...normalized,
    revision: prev.revision + 1,
    tableId: prev.tableId,
    undo: Object.freeze(undo),
  });
}

/** 只改核心字段（自动 +1 revision 并压撤销栈） */
function patch(
  state: PokerTableState,
  changes: Partial<Omit<TableCore, 'revision' | 'tableId'>>,
): PokerTableState {
  return commit(state, { ...coreOf(state), ...changes });
}

/** 把座位数组按新的 Hero 位置重算视觉序号（**只改视觉字段**） */
function reseatVisuals(
  seats: readonly TableSeat[],
  tableSize: 6 | 9,
  heroPosition: Position,
): readonly TableSeat[] {
  return Object.freeze(
    seats.map((seat) =>
      Object.freeze({
        ...seat,
        visualIndex: visualIndexOf(tableSize, heroPosition, seat.logicalPosition),
      }),
    ),
  );
}

export function ok(state: PokerTableState): TableOpOutcome {
  return { ok: true, state };
}

export function fail(issues: readonly TableIssue[], leaveDecision?: LeaveDecision): TableOpOutcome {
  return leaveDecision === undefined ? { ok: false, issues } : { ok: false, issues, leaveDecision };
}

function issue(code: TableIssue['code'], message: string): TableIssue {
  return { code, message };
}

/* ============================================================
 * 座位查询辅助
 * ============================================================ */

function requireOccupiedSeat(
  state: PokerTableState,
  seatId: string,
): { ok: true; seat: TableSeat; player: TablePlayer } | { ok: false; outcome: TableOpOutcome } {
  const seat = seatById(state, seatId);
  if (seat === undefined) {
    return {
      ok: false,
      outcome: fail([issue('SEAT_NOT_FOUND', `找不到座位 ${seatId}`)]),
    };
  }
  if (seat.playerId === null || seat.status === SeatStatus.EMPTY) {
    return {
      ok: false,
      outcome: fail([issue('SEAT_EMPTY', '该座位是空的，没有玩家可操作')]),
    };
  }
  const player = state.playersById[seat.playerId];
  if (player === undefined) {
    return {
      ok: false,
      outcome: fail([
        issue(
          'INTERNAL_ERROR',
          `座位 ${seatId} 绑定了不存在的 playerId ${seat.playerId} —— 状态已损坏`,
        ),
      ]),
    };
  }
  return { ok: true, seat, player };
}

/** 该位置是否在当前行动历史里出现过 */
export function positionHasActed(state: TableCore, position: Position): boolean {
  return state.actionHistory.some((a) => a.position === position);
}

/** 该位置的**最后一条**动作是不是弃牌 */
export function positionFolded(state: TableCore, position: Position): boolean {
  for (let i = state.actionHistory.length - 1; i >= 0; i -= 1) {
    const action = state.actionHistory[i]!;
    if (action.position === position) return action.type === 'FOLD';
  }
  return false;
}

/**
 * 本手是否已经「开始」。
 *
 * 判据刻意保守：只要有任何手牌、公共牌或行动记录，就认为本手已经开始。
 * 一旦开始，座位绑定就只能按「下一手才生效」的方式变更 ——
 * 因为冻结的 Poker Core 已经把这些人发进牌局了，中途改绑定会
 * 破坏底池与行动台账。
 */
/**
 * 本手是否已经开始（由**牌面状态**推导）。
 *
 * ## 🔴 为什么必须带「至少 2 名参与者」这个条件
 *
 * 修复前这里只看「有没有牌」：
 *
 * ```ts
 * return state.heroCards.length > 0 || state.board.length > 0 || state.actionHistory.length > 0;
 * ```
 *
 * 于是**新建牌桌后直接选 Hero 手牌会 500** —— 实测（`POST /api/table` 真实请求）：
 *
 * ```text
 * 建桌（只有 Hero 在座）→ SET_HERO_CARD As
 * → {"ok":false,"stage":"SERVER","issues":[{"code":"INTERNAL_ERROR",
 *     "message":"服务端异常：handTopologySeats: 本手至少需要 2 名参与者（收到 1）"}]}
 * ```
 *
 * 链路是：`handActive = true` ⇒ `commit()` 冻结本手拓扑（`freezeTopology`）
 * ⇒ `handTopologySeats` 对 n < 2 抛错 ⇒ 整个写请求 500。
 * 使用者看到的现象是「**手牌点了没反应**」，而且连点两次都一样。
 *
 * 为什么以前没被发现：所有既有测试都在**建桌后立刻把座位填满**
 *（`test/helpers/tableJsHarness.ts` 的 `seatAll()`），因此从来没测过
 * 「只有 Hero 在座时选牌」。这条是**真实浏览器验收**抓出来的。
 *
 * ## 修法为什么选在这里，而不是给 `handTopologySeats` 加 try/catch
 *
 * `handTopologySeats` 要求「≥ 2 人」本身是对的 —— 一个人不成局，
 * 让它静默返回一个假拓扑，下游会拿它算出假角色、假盲注，错得更远。
 * 真正错的是**判定条件**：「一张牌 + 一个座位」不构成一手牌。
 * 把条件补全，问题在源头消失，且 `handActive` 的语义变成
 * 「本手确实已经成为一局牌」。
 *
 * 牌仍然存在 `heroCards` 里，界面上照常显示 —— 只是本手还没开始，
 * 界面会如实显示「本手还没开始（先给至少 2 个座位加入玩家）」。
 */
function recomputeHandActive(state: TableCore): boolean {
  const hasCards = state.heroCards.length > 0 || state.board.length > 0 || state.actionHistory.length > 0;
  if (!hasCards) return false;
  /*
   * 参与者口径与 `tableAdapter` 的 `staffingProblems` / `participantSeatsOf`
   * 完全一致 —— 不另立一套「够不够人」的规则。
   */
  return participantSeatsOf(state).length >= 2;
}

/* ============================================================
 * 座位操作
 * ============================================================ */

/** 新玩家的默认筹码：牌桌默认买入 */
function nextPlayer(state: TableCore): { playerId: string; displayName: string; nextNumber: number } {
  const n = state.nextPlayerNumber;
  return { playerId: `p${n}`, displayName: `玩家${n}`, nextNumber: n + 1 };
}

/**
 * 新玩家的统一形状（§13）。
 *
 * 🔴 **「逐个加入」与「一键补齐」必须共用这一处** —— 两份实现迟早分叉，
 * 而分叉的表现形式是「一键加进来的玩家和逐个加进来的不一样」。
 */
function freshPlayer(playerId: string, displayName: string): TablePlayer {
  return Object.freeze({
    playerId,
    displayName,
    quickProfile: 'UNKNOWN',
    dynamicHint: 'UNKNOWN',
    handsPlayed: 0,
    isHero: false,
  });
}

/**
 * 把一个空位绑定到新玩家上（**落座点显式归零**：新玩家一律「全新」，
 * 与画像 UNKNOWN 是同一条纪律）。
 */
function seatWithNewPlayer(seat: TableSeat, playerId: string): TableSeat {
  return Object.freeze({
    ...seat,
    playerId,
    status: SeatStatus.SEATED_ACTIVE,
    sitOutNextHand: false,
  });
}

/** 空位判据（**与 `addPlayer` 的占用判据同源**，不要各写一份） */
function isEmptySeat(seat: TableSeat): boolean {
  return seat.playerId === null || seat.status === SeatStatus.EMPTY;
}

/**
 * 加入玩家（§13）。
 *
 * 新玩家一律：新 playerId、默认筹码、画像 `UNKNOWN`、动态 `UNKNOWN`。
 * **不要求输入姓名** —— 默认「玩家N」。
 *
 * 🔴 本手进行中**禁止加入**（§54）：冻结的 Poker Core 已经把当前手的人
 * 发进牌局了，中途加人不可能进入当前手；与其显示「将在下一手加入」
 * 这种半吊子状态，不如明确拒绝并要求先结束本手。
 */
export function addPlayer(
  state: PokerTableState,
  seatId: string,
  /**
   * 🔴 **PLAYER PROFILE EXPLOIT V1**：显式身份（可选）。
   *
   * - 传 `playerId` ⇒ 让**这位已保存的玩家**入座：若牌桌上已有他的记录，
   *   **复用**该 `TablePlayer`（`handsPlayed` 等随他走）；否则按其 id 新建。
   * - `displayName` 只用于显示，**同名不合并**（身份只认 `playerId`）。
   * - 不传 ⇒ 与既有行为逐位一致（自动 `p{n}` + 「玩家N」）。
   */
  identity?: { playerId?: string; displayName?: string },
): TableOpOutcome {
  const seat = seatById(state, seatId);
  if (seat === undefined) return fail([issue('SEAT_NOT_FOUND', `找不到座位 ${seatId}`)]);
  if (seat.playerId !== null && seat.status !== SeatStatus.EMPTY) {
    return fail([
      issue(
        'SEAT_OCCUPIED',
        `${seat.logicalPosition} 座位上已经有人了。请先「清空座位」或「更换玩家」。`,
      ),
    ]);
  }
  if (state.handActive) {
    return fail([
      issue(
        'HAND_ACTIVE',
        '本手正在进行中，无法加入玩家（本手已经发牌，中途加入无法进入当前牌局）。' +
          '请先点「下一手」或「重置本手」。',
      ),
    ]);
  }

  const requestedId = identity?.playerId?.trim();
  const existing =
    requestedId !== undefined && requestedId.length > 0 ? state.playersById[requestedId] : undefined;
  const requestedName = identity?.displayName?.trim();

  const fresh =
    requestedId !== undefined && requestedId.length > 0
      ? {
          playerId: requestedId,
          displayName:
            requestedName !== undefined && requestedName.length > 0
              ? requestedName
              : (existing?.displayName ?? requestedId),
          /** 显式身份**不消耗**自动编号（否则连续入座会跳号） */
          nextNumber: state.nextPlayerNumber,
        }
      : nextPlayer(state);

  return ok(
    patch(state, {
      seats: Object.freeze(
        state.seats.map((s) => (s.seatId === seatId ? seatWithNewPlayer(s, fresh.playerId) : s)),
      ),
      playersById: Object.freeze({
        ...state.playersById,
        [fresh.playerId]:
          existing !== undefined
            ? Object.freeze({
                ...existing,
                displayName: requestedName !== undefined && requestedName.length > 0 ? requestedName : existing.displayName,
              })
            : freshPlayer(fresh.playerId, fresh.displayName),
      }),
      nextPlayerNumber: fresh.nextNumber,
      notices: Object.freeze([]),
    }),
  );
}

/**
 * 🔴 **一键补齐空位**（2026-09 加入的「一键加入玩家」）。
 *
 * ## 语义
 *
 * 在**每一个空座位**上各加入一名新玩家（按座位顺序），等价于使用者
 * 挨个点空位 → 点「加入玩家」，但只算**一次操作**：
 *
 * | 项 | 一键补齐 | 逐个点 N 次 |
 * |---|---|---|
 * | `revision` | **+1** | +N |
 * | 撤销栈 | **1 条** | N 条 |
 * | 撤销一次的结果 | 整张桌子回到补齐前 | 只退掉最后一个人 |
 *
 * ## 为什么复用 `freshPlayer` / `seatWithNewPlayer`
 *
 * 「新玩家长什么样」只能有一处定义。若这里另写一份，迟早出现
 * 「一键加进来的是 150BB、逐个加进来的是 100BB」这类分叉。
 *
 * ## 门禁与 `addPlayer` **完全一致**
 *
 * - 本手进行中 ⇒ 拒绝（冻结的 Poker Core 已经把当前手的人发进牌局，
 *   中途加人不可能进入当前手）
 * - 没有空位 ⇒ 拒绝并说明（不是静默成功）
 *
 * ⚠️ 这里**不修改** Hero 的座位、不改桌型、不动本手拓扑：
 * `commit` 仍是唯一写入口，因此 `handActive === true` 时冻结拓扑那条规则
 * 也照旧生效（本函数在这种情况下已经被门禁挡掉了）。
 */
export function fillEmptySeats(state: PokerTableState): TableOpOutcome {
  if (state.handActive) {
    return fail([
      issue(
        'HAND_ACTIVE',
        '本手正在进行中，无法加入玩家（本手已经发牌，中途加入无法进入当前牌局）。' +
          '请先点「下一手」或「重置本手」。',
      ),
    ]);
  }

  const emptySeatIds = state.seats.filter(isEmptySeat).map((s) => s.seatId);
  if (emptySeatIds.length === 0) {
    return fail([issue('SEAT_OCCUPIED', '所有座位都已经有人了，无需加入。')]);
  }

  /*
   * 逐个套用与 `addPlayer` **同一套**规则，但只在最后 `commit` 一次：
   * 一次操作 = 一次撤销 = 一次 revision。
   */
  let seats: readonly TableSeat[] = state.seats;
  const playersById: Record<string, TablePlayer> = { ...state.playersById };
  let nextNumber = state.nextPlayerNumber;
  const addedNames: string[] = [];

  for (const seatId of emptySeatIds) {
    const fresh = nextPlayer({ ...state, nextPlayerNumber: nextNumber });
    nextNumber = fresh.nextNumber;
    addedNames.push(fresh.displayName);
    playersById[fresh.playerId] = freshPlayer(fresh.playerId, fresh.displayName);
    seats = Object.freeze(
      seats.map((s) => (s.seatId === seatId ? seatWithNewPlayer(s, fresh.playerId) : s)),
    );
  }

  return ok(
    commit(state, {
      ...coreOf(state),
      seats,
      playersById: Object.freeze(playersById),
      nextPlayerNumber: nextNumber,
      notices: Object.freeze([
        `已在 ${addedNames.length} 个空位加入新玩家（${addedNames.join('、')}）：` +
          '默认筹码、画像「未知」。这一步可以用「撤销」一次退回。',
      ]),
    }),
  );
}

/**
 * 清空座位（§6B / §7 / §8 / §50）。
 *
 * ## 三种情形，三种处理
 *
 * | 情形 | 处理 |
 * |---|---|
 * | 本手未开始 | **立即**解除绑定（`playerId = null`，`EMPTY`） |
 * | 本手进行中，用户未选择 | 返回 `leaveDecision`（**不许默认猜**） |
 * | 本手进行中，用户选了 `LEAVE_AFTER_HAND` | 只标 `LEAVING_AFTER_HAND`，**保留全部历史事实** |
 * | 本手进行中，用户选了 `FOLD_AND_LEAVE` 且轮到他 | 先由 `ACT` 记一次弃牌（走 Poker Core），再标 `LEAVING_AFTER_HAND` |
 *
 * 🔴 **禁止**在本手进行中把玩家从 `actionHistory` 或牌局里删除：
 * 底池、投入、行动台账都会因此损坏（§6C / §75）。
 */
export function clearSeat(state: PokerTableState, seatId: string): TableOpOutcome {
  const seat = seatById(state, seatId);
  if (seat === undefined) return fail([issue('SEAT_NOT_FOUND', `找不到座位 ${seatId}`)]);
  if (seat.playerId === null || seat.status === SeatStatus.EMPTY) {
    return fail([issue('SEAT_EMPTY', '该座位已经是空的')]);
  }
  if (seat.logicalPosition === state.heroPosition) {
    return fail([
      issue(
        'HERO_SEAT_REQUIRED',
        'Hero 的座位不能清空（本工具需要一位 Hero 才能分析）。' +
          '若要换 Hero 位置，请点顶部的位置按钮。',
      ),
    ]);
  }

  // ---- 本手未开始 → 立即解除绑定 ----
  if (!state.handActive) {
    const players = { ...state.playersById };
    // ⚠️ 玩家对象**保留在历史里**（§62）：只解除绑定，不删除对象。
    // 这样「刚刚那个人是谁」仍可追溯，而他不再影响这个座位。
    //
    // 🔴 **必须清掉 `sitOutNextHand`**（红队 RT-L5）：
    // 它是**玩家**的意图，不是**座位**的属性。留在空座位上会被下一个
    // 坐进来的人继承 —— 他从未点过暂离，却在下一手被判定为暂离，
    // 于是整张牌桌无法分析。这正是「Seat ≠ Player」被违反的形态。
    return ok(
      patch(state, {
        seats: Object.freeze(
          state.seats.map((s) =>
            s.seatId === seatId
              ? Object.freeze({
                  ...s,
                  playerId: null,
                  status: SeatStatus.EMPTY,
                  sitOutNextHand: false,
                  stackBB: state.defaultStackBB,
                })
              : s,
          ),
        ),
        playersById: Object.freeze(players),
        notices: Object.freeze([]),
      }),
    );
  }

  // ---- 本手进行中 → 必须由用户明确选择 ----
  return fail(
    [
      issue(
        'NEEDS_LEAVE_DECISION',
        '本手正在进行中。该玩家已经进入本手牌局（筹码与行动台账里都有他的记录），' +
          '因此不能直接从牌局中删除。请明确选择处理方式。',
      ),
    ],
    buildLeaveDecision(state, seat),
  );
}

/** 构造「离桌选择」（§8：不许默认猜） */
export function buildLeaveDecision(
  state: PokerTableState,
  seat: TableSeat,
  currentActorPosition: Position | null = null,
): LeaveDecision {
  const player = seat.playerId !== null ? state.playersById[seat.playerId] : undefined;
  const folded = positionFolded(state, seat.logicalPosition);
  const stillToAct = !folded && currentActorPosition === seat.logicalPosition;
  const options: ActiveHandLeaveChoice[] = [];
  if (stillToAct) options.push(ActiveHandLeaveChoice.FOLD_AND_LEAVE);
  options.push(ActiveHandLeaveChoice.LEAVE_AFTER_HAND, ActiveHandLeaveChoice.CANCEL);

  const noteZh = stillToAct
    ? '现在正轮到他行动，因此可以选择「本手视为弃牌并离桌」。'
    : folded
      ? '他本手已经弃牌，因此只有「仅标记手后离桌」可选 —— 已投入的筹码仍留在底池里。'
      : '现在没有轮到他行动；若要让他本手不再行动，请先在牌桌上录到他的回合再弃牌。' +
        '「仅标记手后离桌」只影响下一手，本手的行动记录保持不变。';

  return Object.freeze({
    seatId: seat.seatId,
    position: seat.logicalPosition,
    displayName: player?.displayName ?? '（未知玩家）',
    stillToAct,
    options: Object.freeze(options),
    noteZh,
  });
}

/**
 * 本手进行中的离桌落定（由 op 层在用户明确选择后调用）。
 *
 * `foldFirst` 为 true 时，调用方**已经**通过 `ACT` 记下了弃牌 ——
 * 本函数只负责改状态，**绝不自己伪造行动**。
 */
export function markLeavingAfterHand(state: PokerTableState, seatId: string): TableOpOutcome {
  const found = requireOccupiedSeat(state, seatId);
  if (!found.ok) return found.outcome;
  return ok(
    patch(state, {
      seats: Object.freeze(
        state.seats.map((s) =>
          s.seatId === seatId ? Object.freeze({ ...s, status: SeatStatus.LEAVING_AFTER_HAND }) : s,
        ),
      ),
      notices: Object.freeze([
        `${found.player.displayName} 已标记为「手后离桌」——` +
          '本手的筹码投入与行动记录全部保留，下一手才会真正清空该座位。',
      ]),
    }),
  );
}

/**
 * 更换玩家（§9 / §10）。
 *
 * 🔴 **必须生成新的 playerId**，且新玩家的画像与动态一律 `UNKNOWN`。
 * 绝不继承旧玩家的 `quickProfile` / `dynamicHint` ——
 * 那会让「A 是跟注站」这件事被算到 B 头上。
 */
export function replacePlayer(state: PokerTableState, seatId: string): TableOpOutcome {
  const seat = seatById(state, seatId);
  if (seat === undefined) return fail([issue('SEAT_NOT_FOUND', `找不到座位 ${seatId}`)]);
  if (state.handActive) {
    return fail([
      issue(
        'HAND_ACTIVE',
        '本手正在进行中，不能更换玩家（本手已经发牌）。请先点「下一手」或「重置本手」。',
      ),
    ]);
  }
  if (seat.logicalPosition === state.heroPosition) {
    return fail([issue('HERO_SEAT_REQUIRED', 'Hero 的座位不能更换玩家。')]);
  }

  const fresh = nextPlayer(state);
  const player: TablePlayer = Object.freeze({
    playerId: fresh.playerId,
    displayName: fresh.displayName,
    quickProfile: 'UNKNOWN',
    dynamicHint: 'UNKNOWN',
    handsPlayed: 0,
    isHero: false,
  });

  // ⚠️ 旧玩家对象**保留在 playersById 里**（历史可追溯），
  // 但已经**没有任何座位引用它** —— 它不再影响任何决策。
  return ok(
    patch(state, {
      seats: Object.freeze(
        state.seats.map((s) =>
          s.seatId === seatId
            ? Object.freeze({
                ...s,
                playerId: fresh.playerId,
                status: SeatStatus.SEATED_ACTIVE,
                sitOutNextHand: false,
                stackBB: state.defaultStackBB,
              })
            : s,
        ),
      ),
      playersById: Object.freeze({ ...state.playersById, [fresh.playerId]: player }),
      nextPlayerNumber: fresh.nextNumber,
      notices: Object.freeze([
        `${fresh.displayName} 已坐入 ${seat.logicalPosition} 座位；` +
          '新玩家的画像与动态观察均为「未知」（不会继承上一位玩家）。',
      ]),
    }),
  );
}

/**
 * 暂时离座（§11 / §53）。
 *
 * ## 语义（红队修复后）
 *
 * | 情形 | 行为 |
 * |---|---|
 * | 本手**未开始** | 立即 `SITTING_OUT`：下一手不参与发牌 |
 * | 本手**进行中** | 只设 `sitOutNextHand`，**当前手状态完全不变** |
 *
 * 🔴 修复前无论本手是否进行都直接标 `SITTING_OUT`，后果是：
 * 冻结的 Poker Core 要求「N 人桌恰好 N 位玩家」，暂离座位会让牌局
 * **无法重建** → 当前行动者变 `null`、行动按钮全部消失，
 * 这一手**在界面上再也录不下去**。那与「只影响下一手」正好相反。
 */
export function sitOut(state: PokerTableState, seatId: string): TableOpOutcome {
  const found = requireOccupiedSeat(state, seatId);
  if (!found.ok) return found.outcome;
  if (found.seat.status === SeatStatus.SITTING_OUT) {
    return fail([issue('ALREADY_SITTING_OUT', '该玩家已经处于暂离状态')]);
  }
  if (found.seat.sitOutNextHand) {
    return fail([issue('ALREADY_SITTING_OUT', '该玩家已经标记为「下一手暂离」')]);
  }

  // ---- 本手进行中 → 只标记，不动当前手 ----
  if (state.handActive) {
    return ok(
      patch(state, {
        seats: Object.freeze(
          state.seats.map((s) => (s.seatId === seatId ? Object.freeze({ ...s, sitOutNextHand: true }) : s)),
        ),
        notices: Object.freeze([
          `${found.player.displayName} 已标记为「下一手暂离」—— **当前手不受影响**` +
            '（他仍要行动、筹码仍在本手里）。下一手开始时他才不参与发牌。' +
            '画像与历史保留。',
        ]),
      }),
    );
  }

  return ok(
    patch(state, {
      seats: Object.freeze(
        state.seats.map((s) =>
          s.seatId === seatId
            ? Object.freeze({ ...s, status: SeatStatus.SITTING_OUT, sitOutNextHand: false })
            : s,
        ),
      ),
      notices: Object.freeze([
        `${found.player.displayName} 已暂离 —— 画像保留，不参与发牌。` +
          '注意：暂离状态**无法分析**（当前引擎不能把暂离玩家排除在牌局之外）。',
      ]),
    }),
  );
}

/** 重新入座（同时取消「下一手暂离」标记） */
export function sitIn(state: PokerTableState, seatId: string): TableOpOutcome {
  const found = requireOccupiedSeat(state, seatId);
  if (!found.ok) return found.outcome;
  if (found.seat.status !== SeatStatus.SITTING_OUT && !found.seat.sitOutNextHand) {
    return fail([issue('NOT_SITTING_OUT', '该玩家不在暂离状态')]);
  }
  return ok(
    patch(state, {
      seats: Object.freeze(
        state.seats.map((s) =>
          s.seatId === seatId
            ? Object.freeze({ ...s, status: SeatStatus.SEATED_ACTIVE, sitOutNextHand: false })
            : s,
        ),
      ),
      notices: Object.freeze([`${found.player.displayName} 已重新入座。`]),
    }),
  );
}

/**
 * 修改座位筹码（§55 / §56）。
 *
 * 本手进行中**禁止**修改已经参与本手的座位筹码 —— 那会破坏筹码守恒，
 * 而且当前手的 `createGame` 已经用了旧筹码，改它只会让「显示」与
 * 「实际计算」不一致。要做修正必须先「重置本手」（§55 给了两条出路）。
 */
export function setStack(state: PokerTableState, seatId: string, stackBB: number): TableOpOutcome {
  const seat = seatById(state, seatId);
  if (seat === undefined) return fail([issue('SEAT_NOT_FOUND', `找不到座位 ${seatId}`)]);
  if (!Number.isFinite(stackBB) || stackBB <= 0) {
    return fail([issue('INVALID_STACK', `筹码必须是正数（收到 ${String(stackBB)}）`)]);
  }
  if (state.handActive) {
    return fail([
      issue(
        'HAND_ACTIVE',
        '本手正在进行中，不能修改座位筹码（本手的筹码守恒基于开局时的筹码）。' +
          '请先点「重置本手」或「下一手」。',
      ),
    ]);
  }
  return ok(
    patch(state, {
      seats: Object.freeze(
        state.seats.map((s) => (s.seatId === seatId ? Object.freeze({ ...s, stackBB }) : s)),
      ),
      notices: Object.freeze([]),
    }),
  );
}

/**
 * 设置玩家画像 / 动态提示。
 *
 * ⚠️ 这里只写**输入证据**：它不会、也不能直接改变 Decision（§45）。
 * 真正的策略影响发生在 `contextBuilder` 里，且受可信度上限约束。
 */
export function setProfile(
  state: PokerTableState,
  seatId: string,
  quickProfile: TablePlayer['quickProfile'],
): TableOpOutcome {
  const found = requireOccupiedSeat(state, seatId);
  if (!found.ok) return found.outcome;
  if (found.player.quickProfile === quickProfile) return ok(state);
  return ok(
    patch(state, {
      playersById: Object.freeze({
        ...state.playersById,
        [found.player.playerId]: Object.freeze({ ...found.player, quickProfile }),
      }),
      notices: Object.freeze([]),
    }),
  );
}

export function setDynamicHint(
  state: PokerTableState,
  seatId: string,
  dynamicHint: TablePlayer['dynamicHint'],
): TableOpOutcome {
  const found = requireOccupiedSeat(state, seatId);
  if (!found.ok) return found.outcome;
  if (found.player.dynamicHint === dynamicHint) return ok(state);
  return ok(
    patch(state, {
      playersById: Object.freeze({
        ...state.playersById,
        [found.player.playerId]: Object.freeze({ ...found.player, dynamicHint }),
      }),
      notices: Object.freeze([]),
    }),
  );
}

/* ============================================================
 * 牌桌级操作
 * ============================================================ */

/** 清空其他玩家（§49）：本手进行中**禁止** */
export function clearAllVillains(state: PokerTableState): TableOpOutcome {
  if (state.handActive) {
    return fail([
      issue(
        'HAND_ACTIVE',
        '本手正在进行中，不能清空其他玩家（会破坏当前手的底池与行动台账）。' +
          '请先点「下一手」或「重置本手」。',
      ),
    ]);
  }
  return ok(
    patch(state, {
      seats: Object.freeze(
        state.seats.map((s) =>
          s.logicalPosition === state.heroPosition
            ? s
            : Object.freeze({
                ...s,
                playerId: null,
                status: SeatStatus.EMPTY,
                // 同上：座位属性归零，不得被下一个坐进来的人继承（RT-L5）
                sitOutNextHand: false,
                stackBB: state.defaultStackBB,
              }),
        ),
      ),
      notices: Object.freeze(['已清空其他玩家。Hero 的设置保持不变。']),
    }),
  );
}

export function setEnvironment(
  state: PokerTableState,
  environment: TableCore['environment'],
): TableOpOutcome {
  // 值没变就是**什么都没发生**：不推进 revision、不占撤销栈。
  // （红队报告：空操作也推进 revision 会浪费一次撤销机会，
  //   并让「版本变了但状态没变」这种噪声进入竞态判断。）
  if (state.environment === environment) return ok(state);
  return ok(patch(state, { environment, notices: Object.freeze([]) }));
}

export function setTableSize(state: PokerTableState, tableSize: 6 | 9): TableOpOutcome {
  if (state.handActive) {
    return fail([
      issue('HAND_ACTIVE', '本手正在进行中，不能改桌型。请先点「新牌桌」。'),
    ]);
  }
  if (state.tableSize === tableSize) return ok(state);

  const positions = logicalSeatOrder(tableSize);
  // Hero 位置在新桌型里必须存在（6 人桌没有 UTG1/UTG2/LJ）
  const heroPosition = positions.includes(state.heroPosition) ? state.heroPosition : Position.BTN;
  const oldByPosition = new Map(state.seats.map((s) => [s.logicalPosition, s]));
  // Hero 的筹码跟着人走（理由同 `setHeroPosition`）
  const heroStackBB = oldByPosition.get(state.heroPosition)?.stackBB ?? state.defaultStackBB;

  const seats: TableSeat[] = positions.map((position) => {
    const old = oldByPosition.get(position);
    const base: TableSeat = old ?? {
      seatId: seatIdOfPosition(position),
      logicalPosition: position,
      visualIndex: 0,
      playerId: null,
      status: SeatStatus.EMPTY,
      sitOutNextHand: false,
      stackBB: state.defaultStackBB,
    };
    return Object.freeze({
      ...base,
      seatId: seatIdOfPosition(position),
      visualIndex: visualIndexOf(tableSize, heroPosition, position),
    });
  });

  const droppedPositions = state.seats
    .map((s) => s.logicalPosition)
    .filter((p) => !positions.includes(p));

  // 保留下来的座位若与新 Hero 位置冲突（新 Hero 位置上原本是别人），
  // `fixedSeats` 会把那个人从该座位上换掉；他仍留在 `playersById` 历史里。
  const fixedSeats = seats.map((s) =>
    s.logicalPosition === heroPosition
      ? Object.freeze({
          ...s,
          playerId: state.heroPlayerId,
          status: SeatStatus.SEATED_ACTIVE,
          sitOutNextHand: false,
          stackBB: heroStackBB,
        })
      : s,
  );

  const notices = [`桌型已切换为 ${tableSize} 人桌。`];
  if (droppedPositions.length > 0) {
    notices.push(
      `${droppedPositions.join('、')} 这些位置在新桌型里不存在，对应座位已移除` +
        '（玩家对象仍保留在历史里，不再绑定任何座位）。',
    );
  }
  if (heroPosition !== state.heroPosition) {
    notices.push(`Hero 原位置 ${state.heroPosition} 在 ${tableSize} 人桌不存在，已自动改到庄家位。`);
  }
  // 新 Hero 位置上原本有人 → 必须**点名**（红队 RT-L8：以前只字未提）
  const displacedSeat = oldByPosition.get(heroPosition);
  const displacedName =
    displacedSeat?.playerId != null
      ? (state.playersById[displacedSeat.playerId]?.displayName ?? displacedSeat.playerId)
      : null;
  if (displacedName !== null && heroPosition !== state.heroPosition) {
    notices.push(
      `${POSITION_ZH[heroPosition]} 座位上原本是「${displacedName}」—— 该座位已交给 Hero，` +
        '他不再绑定任何座位（玩家对象仍保留在历史里）。',
    );
  }
  notices.push('座位筹码保持不变；Hero 的筹码跟着 Hero 走。');

  return ok(
    patch(state, {
      tableSize,
      heroPosition,
      seats: Object.freeze(fixedSeats),
      notices: Object.freeze(notices),
    }),
  );
}

/**
 * 设置 Hero 位置（§21）。
 *
 * ## 换位 = 两个人**对调座位**（2026-09 座位对调语义）
 *
 * ```text
 * 目标座位空着  → Hero 搬过去，自己原来的座位腾空（沿用旧语义）
 * 目标座位有人  → Hero 与那个人**交换座位**，没有任何座位变成空的
 * ```
 *
 * ## 为什么必须是「对调」而不是「把对方清掉」（使用者报告的形态）
 *
 * 旧实现把目标座位上的人解绑，并把 Hero 的原座位腾空。满座 6 人桌「Hero 从
 * BTN 挪到 UTG」于是产生三个可见后果：
 *
 * | 后果 | 实测 |
 * |---|---|
 * | 本手人数凭空少一个 | 6 人桌 → **5 人**本手（9 人桌 → 8 人） |
 * | 被顶掉的人从盘面上消失 | 只剩一条 notice，使用者以为「人丢了」 |
 * | Button 悬空 ⇒ 从 Hero 手里溜走 | 腾空的正是 Button 座位 ⇒ 有效 Button 顺时针浮到 SB ⇒ **Hero 在 UTG 座位上被标成「大盲位（BB）」**，与顶栏「Hero 在 UTG」当场矛盾 |
 *
 * 对调把这三条一起消掉：不产生空座位 ⇒ Button 不悬空 ⇒ 每个人本手角色
 * 就等于他坐的那个座位名（在 Button 不动的前提下）。
 *
 * ## 🔴 筹码规则：目标座位有人 = 物理换座；没人 = 筹码跟着 Hero 走
 *
 * | 情形 | 新座位上那份筹码来自哪 | 原因 |
 * |---|---|---|
 * | 目标座位**有人** | 该座位原有的那份（两份都留在座位上） | 物理换座：桌面这一堆筹码没动，只是换了个人看着它。**总数逐位不变** |
 * | 目标座位**空着** | Hero 自己带过去 | 没有第二个人 ⇒ 不存在归属歧义；拿默认值顶掉会把 Hero 的筹码静默改写成 100BB |
 *
 * ⚠️ 曾经的替代方案是「不管有没有人都让 Hero 带着自己的筹码搬过去」。它在
 * **有人**那一支会**凭空增减筹码**：目标座位是短码时 Hero 的筹码被改小
 * （红队 RT-L3 实测 250BB → 33BB），被换的那位则带着 250BB 坐到 Hero 的旧座位 ——
 * 桌上筹码总数变了，而且没有任何东西能解释差额去了哪。物理换座没有这个问题。
 *
 * 因此三条不变量是：**座位数不变、玩家数不变、桌上筹码总数不变** ——
 * 由 `test/seatSwap.test.ts` 锁住。
 *
 * **不修改任何已录入的手牌 / 公共牌 / 行动记录** —— 那些是本手的历史事实
 * （本手进行中整个操作会被拒绝）。
 */
export function setHeroPosition(state: PokerTableState, position: Position): TableOpOutcome {
  if (state.handActive) {
    return fail([
      issue(
        'HAND_ACTIVE',
        '本手正在进行中，不能更改 Hero 位置（会与已录入的行动顺序冲突）。请先点「下一手」。',
      ),
    ]);
  }
  if (seatOfPosition(state, position) === undefined) {
    return fail([
      issue('SEAT_NOT_FOUND', `${state.tableSize} 人桌上没有「${position}」这个位置`),
    ]);
  }
  if (position === state.heroPosition) return ok(state);

  const oldHeroPosition = state.heroPosition;
  const oldHeroSeat = seatOfPosition(state, oldHeroPosition);
  const targetSeat = seatOfPosition(state, position)!;
  /** 目标座位上原本的人（空座位时为 null）—— 他要换到 Hero 原来的座位上 */
  const displacedPlayerId = targetSeat.playerId;

  /**
   * 座位重建：**只换 `playerId` 与随之而来的在场状态**。
   *
   * `stackBB` 只在**目标座位空着**时被写一次（Hero 把自己的筹码带过去，
   * 见函数头「筹码规则」）；对调情形下两份筹码都留在各自座位上，刻意不赋值 ——
   * 少一处赋值就少一处「筹码被静默改写」的可能。
   */
  const heroStackBB = oldHeroSeat?.stackBB ?? state.defaultStackBB;
  const seats = state.seats.map((s) => {
    if (s.logicalPosition === position) {
      return Object.freeze({
        ...s,
        playerId: state.heroPlayerId,
        status: SeatStatus.SEATED_ACTIVE,
        sitOutNextHand: false,
        ...(displacedPlayerId === null ? { stackBB: heroStackBB } : {}),
      });
    }
    if (s.logicalPosition === oldHeroPosition) {
      return displacedPlayerId === null
        ? Object.freeze({
            ...s,
            playerId: null,
            status: SeatStatus.EMPTY,
            sitOutNextHand: false,
            stackBB: state.defaultStackBB,
          })
        : Object.freeze({
            ...s,
            playerId: displacedPlayerId,
            status: SeatStatus.SEATED_ACTIVE,
            sitOutNextHand: false,
          });
    }
    return s;
  });

  const displacedName =
    displacedPlayerId !== null
      ? (state.playersById[displacedPlayerId]?.displayName ?? displacedPlayerId)
      : null;
  const targetStackBB = targetSeat.stackBB;
  const notices = [`Hero 位置已改为 ${position}（牌桌视图已旋转，Hero 固定在底部）。`];
  if (displacedName !== null) {
    notices.push(
      `已与「${displacedName}」**对调座位**：他换到 ${oldHeroPosition} 座位` +
        `（${heroStackBB}BB），Hero 坐 ${position}（${targetStackBB}BB）。` +
        '筹码留在各自座位上 —— 本手人数与桌上筹码总数都不变。',
    );
  }

  return ok(
    patch(state, {
      heroPosition: position,
      seats: reseatVisuals(seats, state.tableSize, position),
      notices: Object.freeze(notices),
    }),
  );
}

/* ============================================================
 * Button（庄家位）—— 手动指定
 * ============================================================ */

/**
 * 手动指定 Button 的物理座位（§19 / §76）。
 *
 * ## 与 `NEXT_HAND` 的分工
 *
 * | 场景 | 谁负责 |
 * |---|---|
 * | 一手打完，Button 顺时针轮转 | `NEXT_HAND` **自动**做（§16–§18） |
 * | 开局第一手，Button 已经在别人面前 | **这里**手设 |
 *
 * ## 三条硬约束
 *
 * 1. **本手进行中不许改**：Button 决定「盲注是谁下的、谁先行动」，
 *    本手已经开始还去改它，就是在改**已发生事实**的归属（§142）。
 * 2. **必须是一个真实存在的座位**。
 * 3. **座位上必须有人且不是暂离** —— 空座位上不能放筹码牌。
 *    这条不是洁癖：`handTopologySeats` 要求 Button 在本手参与者里，
 *    放一个空座位进去会让整手牌建不出来（表现为「牌桌突然不能分析」，
 *    而使用者完全看不出原因）。
 */
export function setButton(state: PokerTableState, seatId: string): TableOpOutcome {
  if (state.handActive) {
    return fail([
      issue(
        'HAND_ACTIVE',
        '本手正在进行中，不能更改 Button —— 盲注归属与行动顺序已经按当前 Button 记录下来了。' +
          '请先点「下一手」，或在下一手开始前设置。',
      ),
    ]);
  }
  const seat = seatById(state, seatId);
  if (seat === undefined) {
    return fail([issue('SEAT_NOT_FOUND', `找不到座位「${seatId}」`)]);
  }
  if (seat.playerId === null || seat.status === SeatStatus.EMPTY) {
    return fail([
      issue(
        'SEAT_EMPTY',
        `${POSITION_ZH[seat.logicalPosition]} 座位上没有人 —— 不能把 Button 放在空座位上。` +
          '请先「加入玩家」。',
      ),
    ]);
  }
  if (seat.status === SeatStatus.SITTING_OUT) {
    return fail([
      issue(
        'SEAT_EMPTY',
        `${POSITION_ZH[seat.logicalPosition]} 座位上的人处于「暂离」—— 暂离者不参与本手，` +
          '不能当 Button。请先「重新入座」，或换一个座位。',
      ),
    ]);
  }
  if (seatId === state.buttonSeatId) return ok(state); // 幂等

  const position = seat.logicalPosition;
  const others = state.seats
    .filter((s) => s.seatId !== seatId && s.playerId !== null && s.status !== SeatStatus.SITTING_OUT)
    .map((s) => POSITION_ZH[s.logicalPosition]);
  const notices = [
    `Button 已设在「${POSITION_ZH[position]}」。` +
      (others.length > 0
        ? `小盲是它顺时针方向的下一位（本手参与者里的第一个）：${others.join('、')}。`
        : ''),
  ];

  return ok(patch(state, { buttonSeatId: seatId, notices: Object.freeze(notices) }));
}

/* ============================================================
 * 手牌 / 公共牌
 * ============================================================ */

function usedCards(state: TableCore): readonly string[] {
  return [...state.heroCards, ...state.board];
}

export function setHeroCard(state: PokerTableState, card: string): TableOpOutcome {
  const upper = card;
  if (state.heroCards.includes(upper)) {
    // 再点一次 = 取消选择
    return ok(patch(state, { heroCards: Object.freeze(state.heroCards.filter((c) => c !== upper)) }));
  }
  if (state.board.includes(upper)) {
    return fail([issue('CARD_ALREADY_USED', `${card} 已经在公共牌里了，同一张牌不能用两次`)]);
  }
  if (state.heroCards.length >= 2) {
    return fail([
      issue('CARD_ALREADY_USED', 'Hero 手牌已经有两张了。先点已选的牌取消，再选新的。'),
    ]);
  }
  const heroCards = Object.freeze([...state.heroCards, upper]);
  return ok(
    patch(state, {
      heroCards,
      handActive: recomputeHandActive({ ...state, heroCards }),
      notices: Object.freeze([]),
    }),
  );
}

export function clearHeroCards(state: PokerTableState): TableOpOutcome {
  if (state.actionHistory.length > 0) {
    return fail([
      issue(
        'HAND_ACTIVE',
        '已经录入行动记录，不能只清手牌（会让行动记录失去对应的牌局）。请点「重置本手」。',
      ),
    ]);
  }
  return ok(
    patch(state, {
      heroCards: Object.freeze([]),
      handActive: recomputeHandActive({ ...state, heroCards: [] }),
      notices: Object.freeze([]),
    }),
  );
}

/**
 * 设置公共牌。
 *
 * 牌桌中央是 5 个槽位（`slot` 0..4），点开就是 4×13 牌矩阵。
 * 一张牌只能出现一次（Hero 手牌与公共牌共用一份已用牌集合）。
 *
 * ## 🔴 必须**按顺序**填（实测踩到的静默丢牌）
 *
 * 修复前允许「跳着点」：实现里先把前面的槽位补成空串，再从数组头部
 * 截断到第一个空串 —— 于是「直接点第 3 个槽位」会让刚选的那张牌
 * **被静默丢弃**（数组变成 `['','','2d']`，截断后成了 `[]`）。
 * 界面看起来什么都没发生，而使用者以为自己已经选好了。
 *
 * 现在：跳着点**直接拒绝**，并说清楚先填第几张。
 */
export function setBoardCard(state: PokerTableState, card: string, slot: number): TableOpOutcome {
  if (!Number.isInteger(slot) || slot < 0 || slot > 4) {
    return fail([issue('INVALID_CARD', `公共牌槽位必须是 0~4（收到 ${String(slot)}）`)]);
  }
  // 只能填「下一张」或修改「已经填过的位置」
  const fillable = state.board.length;
  if (slot > fillable) {
    return fail([
      issue(
        'INVALID_CARD',
        `请按顺序选公共牌：现在应该选第 ${fillable + 1} 张` +
          `（第 ${slot + 1} 张还不能填 —— 跳着填会让中间的牌位置空着，` +
          '而那与「公共牌选择中」无法区分）',
      ),
    ]);
  }

  const board = [...state.board];
  const previous = board[slot];
  if (previous === card) {
    // 再点同一张 = 取消该槽位；取消必须从**末尾**开始，否则会出现空洞
    if (slot !== board.length - 1) {
      return fail([
        issue(
          'INVALID_CARD',
          `只能取消最后一张公共牌（第 ${board.length} 张）—— ` +
            '否则会在中间留下空洞',
        ),
      ]);
    }
    board.pop();
  } else {
    if (state.heroCards.includes(card)) {
      return fail([issue('CARD_ALREADY_USED', `${card} 已经是 Hero 的手牌了`)]);
    }
    const otherIndex = board.findIndex((c, i) => c === card && i !== slot);
    if (otherIndex >= 0) {
      return fail([issue('CARD_ALREADY_USED', `${card} 已经在公共牌第 ${otherIndex + 1} 张了`)]);
    }
    if (slot === board.length) board.push(card);
    else board[slot] = card;
  }

  const boardCards = Object.freeze(board);
  return ok(
    patch(state, {
      board: boardCards,
      handActive: recomputeHandActive({ ...state, board: boardCards }),
      notices: Object.freeze([]),
    }),
  );
}

export function clearBoard(state: PokerTableState): TableOpOutcome {
  return ok(
    patch(state, {
      board: Object.freeze([]),
      handActive: recomputeHandActive({ ...state, board: [] }),
      notices: Object.freeze([]),
    }),
  );
}

/* ============================================================
 * 行动 / 撤销 / 换手
 * ============================================================ */

/** 追加一条行动（**只由 `ACT` 在 Poker Core 接受之后调用**） */
export function appendAction(
  state: PokerTableState,
  action: ManualAction,
  outcome: { folded: boolean; allIn: boolean },
): PokerTableState {
  const nextStatus: SeatStatus = outcome.folded
    ? SeatStatus.FOLDED_THIS_HAND
    : outcome.allIn
      ? SeatStatus.ALL_IN
      : SeatStatus.SEATED_ACTIVE;

  const seats = state.seats.map((s) => {
    if (s.logicalPosition !== action.position) return s;
    // 已经标记「手后离桌」的座位**保持**该状态（弃牌不改变离桌意图）
    if (s.status === SeatStatus.LEAVING_AFTER_HAND) return s;
    return Object.freeze({ ...s, status: nextStatus });
  });

  return patch(state, {
    actionHistory: Object.freeze([...state.actionHistory, action]),
    seats: Object.freeze(seats),
    handActive: true,
    notices: Object.freeze([]),
  });
}

/** 撤销一步（§37 / §38：恢复**完整**状态，不只是 DOM） */
export function undo(state: PokerTableState): TableOpOutcome {
  if (state.undo.length === 0) {
    return fail([issue('NOTHING_TO_UNDO', '没有可撤销的操作')]);
  }
  const [previous, ...rest] = state.undo;
  return ok(
    Object.freeze({
      ...previous!,
      revision: state.revision + 1,
      tableId: state.tableId,
      undo: Object.freeze(rest),
    }),
  );
}

/**
 * 下一手（§47）。
 *
 * | 保留 | 清空 |
 * |---|---|
 * | 座位绑定（除手后离桌者） | Hero 手牌 / 公共牌 / 行动历史 |
 * | 玩家画像与动态提示 | 弃牌 / 全下状态 |
 * | 环境 / Hero 逻辑位置 | |
 * | 筹码（按上一手结束值，见 `remainingStacksBB`） | |
 *
 * 🔴 **手后离桌者在这里才真正清空座位**（§7）。当前手期间绝不删他。
 *
 * ⚠️ 筹码按「上一手结束时的剩余筹码」更新，但**底池不分配** ——
 * 本项目不建模牌局结果（结果不得进入决策链）。这会产生一条显式提示，
 * 提醒使用者手动修正赢家的筹码。
 */
export function nextHand(
  state: PokerTableState,
  remainingStacksBB: Readonly<Partial<Record<Position, number>>> | null,
): TableOpOutcome {
  const seats = state.seats.map((seat) => {
    // 手后离桌 → 真正清空
    if (seat.status === SeatStatus.LEAVING_AFTER_HAND) {
      return Object.freeze({
        ...seat,
        playerId: null,
        status: SeatStatus.EMPTY,
        sitOutNextHand: false,
        stackBB: state.defaultStackBB,
      });
    }
    if (seat.playerId === null) return seat;

    const remaining = remainingStacksBB?.[seat.logicalPosition];
    const stackBB =
      remaining !== undefined && Number.isFinite(remaining) && remaining > 0
        ? Number(remaining.toFixed(4))
        : seat.stackBB;

    // 「下一手暂离」在这里才真正生效（§53：本手期间只标记，不动当前手）
    const nextStatus: SeatStatus = seat.sitOutNextHand
      ? SeatStatus.SITTING_OUT
      : seat.status === SeatStatus.SITTING_OUT
        ? SeatStatus.SITTING_OUT
        : SeatStatus.SEATED_ACTIVE;

    return Object.freeze({
      ...seat,
      status: nextStatus,
      sitOutNextHand: false,
      stackBB,
    });
  });

  const playersById: Record<string, TablePlayer> = {};
  for (const [id, player] of Object.entries(state.playersById)) {
    playersById[id] = Object.freeze({
      ...player,
      // 只有**真的打过一手**才计入（红队：未开始的一手也让计数 +1 会让这个数字失真）
      handsPlayed: state.handActive ? player.handsPlayed + 1 : player.handsPlayed,
    });
  }
  // Hero 的画像/动态**不因下一手而改变**；其余玩家的画像同样保留。

  const notices: string[] = [];
  const leaving = state.seats.filter((s) => s.status === SeatStatus.LEAVING_AFTER_HAND);
  if (leaving.length > 0) {
    notices.push(
      `${leaving.map((s) => s.logicalPosition).join('、')} 的玩家已离桌，座位已清空。`,
    );
  }
  const newlySittingOut = state.seats.filter((s) => s.sitOutNextHand);
  if (newlySittingOut.length > 0) {
    notices.push(
      `${newlySittingOut.map((s) => s.logicalPosition).join('、')} 的玩家已暂离（从这一手开始不发牌）。` +
        '画像保留；「重新入座」可以恢复。',
    );
  }
  if (remainingStacksBB !== null) {
    notices.push(
      '座位筹码已按上一手结束时的剩余筹码更新。⚠️ 底池**未分配**（本项目不建模牌局结果），' +
        '赢家请用座位菜单的「编辑筹码」手动改回。',
    );
  }
  const sittingOut = seats.filter((s) => s.status === SeatStatus.SITTING_OUT);
  if (sittingOut.length > 0) {
    notices.push(
      `暂离中的座位：${sittingOut.map((s) => s.logicalPosition).join('、')}。` +
        '暂离状态无法分析，请重新入座或清空座位。',
    );
  }

  /*
   * 🔴 **Button 轮转**（§16–§18）：先把「手后离桌」的座位真正清空，
   * 再**从旧 Button 的物理座位**顺时针找下一个合格座位。
   * 不是重新从 0 号位算 —— 否则 Button 玩家离桌时整桌的位置会集体错位。
   */
  const afterCleanup: TableCore = { ...coreOf(state), seats: Object.freeze(seats) };
  const nextButtonSeatId = advanceButtonSeatId(afterCleanup);

  const advanced = seats.find((s) => s.seatId === nextButtonSeatId);
  if (advanced !== undefined && advanced.seatId !== state.buttonSeatId) {
    const role = advanced.logicalPosition;
    const player = advanced.playerId !== null ? state.playersById[advanced.playerId] : undefined;
    notices.push(
      `Button 已轮转到 ${POSITION_ZH[role]}` +
        (player !== undefined ? `（${player.displayName}）` : '') +
        '。位置与盲注已按本手参与者重算。',
    );
  }

  return ok(
    patch(state, {
      seats: Object.freeze(seats),
      playersById: Object.freeze(playersById),
      buttonSeatId: nextButtonSeatId,
      // 快照由 `commit` 统一处理：这里 handActive=false，因此会被清空
      /*
       * 🔴 **每按一次「下一手」都算一手**（Table Topology Correction 缺陷修复）。
       *
       * 修复前是 `state.handsCompleted + (state.handActive ? 1 : 0)` —— 只有
       * 「本手真的在进行」时才 +1。后果：连续按两次「下一手」（很常见：
       * 想先看看 Button 轮到谁，或开桌前过掉几手）**手数永远停在 0**。
       *
       * 这个数字不是装饰：它是界面上的手号、也是
       * `freezeTopology(state, handsCompleted + 1)` 的快照编号。
       * 恒为 0 意味着 200 手之后界面还写着「第 1 手」，
       * 而 Button 轮转测试也因此永远走不动。
       *
       * Button 轮转本身是按座位推进的（不依赖这个数字），所以修复前
       * 表面上「能轮转」，只是记账错了 —— 正是最难发现的那类缺陷。
       */
      handsCompleted: state.handsCompleted + 1,
      heroCards: Object.freeze([]),
      board: Object.freeze([]),
      actionHistory: Object.freeze([]),
      handActive: false,
      lastHandRemainingStacksBB: remainingStacksBB,
      lastHandComplete: state.handActive,
      notices: Object.freeze(notices),
    }),
  );
}
/**
 * 重置本手（§55 的「Reset Current Hand」）。
 *
 * 清掉手牌 / 公共牌 / 行动记录与弃牌、全下状态，**保留座位与画像**。
 * 用于「录错了，重来」。
 *
 * ## 为什么这里要把「手后离桌」真正落定
 *
 * 重置本手 = 这一手当作没发生过。那么「手后离桌」里的那个「手后」
 * **已经到了** —— 若继续保留 `LEAVING_AFTER_HAND`，座位会卡在一个
 * 既不是空座、也不能加入玩家、也不影响分析的状态里，
 * 使用者只能靠「下一手」才能解开，而界面上没有任何提示。
 *
 * 暂离（`SITTING_OUT`）**不**受影响：它是跨手的意图，与「本手录错了」无关。
 */
export function resetHand(state: PokerTableState): TableOpOutcome {
  const leaving = state.seats.filter((s) => s.status === SeatStatus.LEAVING_AFTER_HAND);
  const notices = ['本手已重置（座位与玩家画像保留）。'];
  if (leaving.length > 0) {
    notices.push(
      `${leaving.map((s) => s.logicalPosition).join('、')} 的玩家已「手后离桌」，` +
        '本手已重置 → 座位一并清空。',
    );
  }

  return ok(
    patch(state, {
      heroCards: Object.freeze([]),
      board: Object.freeze([]),
      actionHistory: Object.freeze([]),
      handActive: false,
      seats: Object.freeze(
        state.seats.map((s) => {
          if (s.playerId === null) return s;
          if (s.status === SeatStatus.LEAVING_AFTER_HAND) {
            return Object.freeze({
              ...s,
              playerId: null,
              status: SeatStatus.EMPTY,
              stackBB: state.defaultStackBB,
            });
          }
          if (s.status === SeatStatus.SITTING_OUT) return s;
          return Object.freeze({ ...s, status: SeatStatus.SEATED_ACTIVE });
        }),
      ),
      notices: Object.freeze(notices),
    }),
  );
}

/**
 * 新牌桌（§48）。
 *
 * 保留：Hero 设置（位置 + Hero 玩家）、环境、默认大盲、桌型。
 * 清空：**所有非 Hero 座位绑定**、所有 Villain 画像与动态、行动历史、公共牌、手牌。
 */
export function newTable(state: PokerTableState): TableOpOutcome {
  const fresh = createTableLike(state);
  return ok(
    Object.freeze({
      ...fresh,
      revision: state.revision + 1,
      tableId: state.tableId,
      undo: Object.freeze([coreOf(state), ...state.undo].slice(0, MAX_UNDO_DEPTH)),
      notices: Object.freeze([
        '已新建牌桌：其他座位与玩家画像、动态观察、行动历史全部清空。',
        `所有座位筹码重置为默认 ${state.defaultStackBB}BB（**包括 Hero**）—— ` +
          'Hero 的位置、环境、默认筹码设置保持不变。',
      ]),
    }),
  );
}

function createTableLike(state: PokerTableState): PokerTableState {
  const positions = logicalSeatOrder(state.tableSize);
  const hero: TablePlayer = Object.freeze({
    ...(state.playersById[state.heroPlayerId] ?? {
      playerId: state.heroPlayerId,
      displayName: '我（Hero）',
      quickProfile: 'UNKNOWN' as const,
      dynamicHint: 'UNKNOWN' as const,
      handsPlayed: 0,
      isHero: true,
    }),
    isHero: true,
  });

  const seats: TableSeat[] = positions.map((position) =>
    Object.freeze({
      seatId: seatIdOfPosition(position),
      logicalPosition: position,
      visualIndex: visualIndexOf(state.tableSize, state.heroPosition, position),
      playerId: position === state.heroPosition ? state.heroPlayerId : null,
      status: position === state.heroPosition ? SeatStatus.SEATED_ACTIVE : SeatStatus.EMPTY,
      sitOutNextHand: false,
      stackBB: state.defaultStackBB,
    }),
  );

  const core: TableCore = Object.freeze({
    tableId: state.tableId,
    revision: 0,
    tableSize: state.tableSize,
    // 新牌桌：Button 回到庄家位座位，本手未开始
    buttonSeatId: seatIdOfPosition(Position.BTN),
    handTopology: null,
    handsCompleted: state.handsCompleted,
    heroPosition: state.heroPosition,
    heroPlayerId: state.heroPlayerId,
    seats: Object.freeze(seats),
    // ⚠️ 只保留 Hero 一个玩家对象：其余玩家的画像**必须**被清掉（§48）
    playersById: Object.freeze({ [state.heroPlayerId]: hero }),
    heroCards: Object.freeze([]),
    board: Object.freeze([]),
    actionHistory: Object.freeze([]),
    environment: state.environment,
    bigBlindBB: state.bigBlindBB,
    defaultStackBB: state.defaultStackBB,
    handActive: false,
    nextPlayerNumber: 2,
    lastHandRemainingStacksBB: null,
    notices: Object.freeze([]),
    lastHandComplete: false,
  });

  return Object.freeze({ ...core, undo: Object.freeze([]) });
}

/* ============================================================
 * 总入口（op → 新状态）
 * ============================================================ */

/** 需要外部（引擎）参与的 op 由调用方处理；本函数只处理纯状态操作 */
export const PURE_OPS: readonly TableOp['kind'][] = Object.freeze([
  'NEW_TABLE',
  'NEXT_HAND',
  'RESET_HAND',
  'ADD_PLAYER',
  'FILL_EMPTY_SEATS',
  'CLEAR_SEAT',
  'REPLACE_PLAYER',
  'SIT_OUT',
  'SIT_IN',
  'SET_STACK',
  'SET_PROFILE',
  'SET_DYNAMIC_HINT',
  'CLEAR_ALL_VILLAINS',
  'SET_ENVIRONMENT',
  'SET_TABLE_SIZE',
  'SET_HERO_POSITION',
  'SET_HERO_CARD',
  'CLEAR_HERO_CARDS',
  'SET_BOARD_CARD',
  'CLEAR_BOARD',
  'UNDO',
]);

export {
  angleOfVisualIndex,
  logicalSeatOrder,
  seatById,
  seatIdOfPosition,
  seatOfPosition,
  visualSeatOrder,
  visualIndexOf,
  OCCUPIED_STATUSES,
};
