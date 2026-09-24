/**
 * 行动状态机：合法性校验 → 落账 → 重建待行动队列 → 推进街道
 *
 * 规范第 11 / 14 / 15 / 42 / 43 条；Bug 预判 B10 / B11 / B12 / B13 / B14 / B15 / B20。
 *
 * 核心原则：
 * 1. 非法动作一律**拒绝并给出中文原因**，绝不静默纠正。
 * 2. 底池只由账本重算得出（computePot），不在动作里做增量累加。
 * 3. 待行动队列每次动作后**整体重建**：以行动顺序为基准，
 *    纳入所有「未弃牌、未全下、且本街投入低于当前注额」的玩家。
 *    这样天然解决多人底池的循环行动问题（不会无限循环，也不会漏人）。
 * 4. 短全下（加注额 < 最小加注）不重开加注权（TDA 规则）。
 */

import { ActionType, Street, type Card } from '../types.ts';
import { IssueCode, IssueSeverity, type IssueCode as IssueCodeType } from '../domainCodes.ts';
import { cardKey } from './cards.ts';
import {
  HandPhase,
  allBoardCards,
  cloneState,
  computePot,
  isBettingRoundComplete,
  minRaiseTo,
  playerById,
  requiredCallAmount,
  streetOrder,
  type ActionCommand,
  type ActionRecord,
  type GameState,
  type PlayerState,
} from './gameState.ts';

/* ============================================================
 * 问题与结果类型
 * ============================================================ */

export type Issue = {
  code: IssueCodeType;
  severity: IssueSeverity;
  params: Readonly<Record<string, string | number>>;
};

export type StateResult =
  | { ok: true; state: GameState; issues: Issue[] }
  | { ok: false; state: GameState; issues: Issue[] };

export function blocker(code: IssueCodeType, params: Record<string, string | number> = {}): Issue {
  return { code, severity: IssueSeverity.BLOCKER, params };
}

export function warning(code: IssueCodeType, params: Record<string, string | number> = {}): Issue {
  return { code, severity: IssueSeverity.WARNING, params };
}

export function fail(state: GameState, issues: Issue[]): StateResult {
  return { ok: false, state, issues };
}

/* ============================================================
 * 查询辅助
 * ============================================================ */

/** 当前应行动的玩家 id（无则为 null） */
export function actorOnTurn(state: GameState): string | null {
  return state.pendingQueue[0] ?? null;
}

/** 本街是否可以下注（当前无人下注） */
export function isUnopenedPot(state: GameState): boolean {
  return state.currentBet === 0;
}

/** 本街最小下注额（下注场景），受筹码限制 */
export function minBetAmount(state: GameState, player: PlayerState): number {
  const bb = state.config.bigBlind;
  return Math.min(bb, player.remainingStack);
}

/** 该玩家本次是否还能加注（短全下后可能被关闭） */
export function canRaise(state: GameState, playerId: string): boolean {
  return !state.raiseClosedFor.includes(playerId);
}

/* ============================================================
 * 主入口
 * ============================================================ */

/**
 * 执行一个动作。
 *
 * 顺序至关重要（本项目实际踩过坑）：
 *   1. 先在**原状态**上做只读校验（玩家存在、未弃牌、轮到谁、金额合法……）
 *   2. 校验全部通过后再 cloneState
 *   3. clone 之后必须重新用 playerById 从**副本**里取玩家对象
 *
 * 如果拿着原状态的玩家对象去改副本，就会「账本记了一笔、筹码却没动」，
 * 表现为底池与筹码守恒同时崩坏。这类错误极其隐蔽，务必保持此顺序。
 *
 * 返回新状态（原状态不被修改），失败时 issues 中给出中文可渲染的原因。
 */
export function applyAction(state: GameState, command: ActionCommand): StateResult {
  if (state.phase !== HandPhase.BETTING) {
    return fail(state, [blocker(IssueCode.ACTION_AFTER_HAND_OVER)]);
  }

  const subject = playerById(state, command.playerId);
  if (!subject) {
    return fail(state, [blocker(IssueCode.UNKNOWN_PLAYER, { playerId: command.playerId })]);
  }
  if (subject.folded) {
    return fail(state, [blocker(IssueCode.FOLDED_PLAYER_ACTED, { player: subject.name })]);
  }
  if (subject.allIn || subject.remainingStack === 0) {
    return fail(state, [blocker(IssueCode.ALLIN_PLAYER_ACTED, { player: subject.name })]);
  }
  const expected = actorOnTurn(state);
  if (expected !== subject.id) {
    const expectedPlayer = expected ? playerById(state, expected) : undefined;
    return fail(state, [
      blocker(IssueCode.NOT_PLAYERS_TURN, {
        expected: expectedPlayer ? expectedPlayer.name : '（无人可行动）',
        actual: subject.name,
      }),
    ]);
  }

  const next = cloneState(state);
  const player = playerById(next, command.playerId)!;

  switch (command.type) {
    case ActionType.FOLD:
      return doFold(next, player.id);

    case ActionType.CHECK:
      return doCheck(next, player, command);

    case ActionType.CALL:
      return doCall(next, player, command);

    case ActionType.BET:
      return doBet(next, player, command);

    case ActionType.RAISE:
    case ActionType.RERAISE:
      return doRaise(next, player, command);

    case ActionType.ALL_IN:
      return doAllIn(next, player, command);

    default:
      return fail(state, [
        blocker(IssueCode.ACTION_NOT_LEGAL_NOW, {
          street: state.street,
          action: command.type,
          player: subject.name,
        }),
      ]);
  }
}

/* ============================================================
 * 各动作实现
 * ============================================================ */

function doFold(state: GameState, playerId: string): StateResult {
  const player = playerById(state, playerId)!;
  const potBefore = computePot(state);
  player.folded = true;
  state.actions.push(record(state, player, ActionType.FOLD, 0, player.committedByStreet[state.street], false, potBefore));

  state.pendingQueue = state.pendingQueue.filter((id) => id !== playerId);

  if (countContenders(state) === 1) {
    finishByFold(state);
    return { ok: true, state, issues: [] };
  }
  syncAfterAction(state, player);
  return { ok: true, state, issues: [] };
}

function doCheck(state: GameState, player: PlayerState, command: ActionCommand): StateResult {
  const call = requiredCallAmount(state, player.id);
  if (call > 0 || state.currentBet > player.committedByStreet[state.street]) {
    return fail(state, [
      blocker(IssueCode.CHECK_FACING_BET, {
        amount: Math.max(call, state.currentBet - player.committedByStreet[state.street]),
      }),
    ]);
  }
  if (command.amount !== undefined && command.amount !== 0) {
    return fail(state, [blocker(IssueCode.CHECK_NOT_ALLOWED, { amount: command.amount })]);
  }
  const potBefore = computePot(state);
  state.actions.push(record(state, player, ActionType.CHECK, 0, player.committedByStreet[state.street], false, potBefore));
  state.pendingQueue = state.pendingQueue.filter((id) => id !== player.id);
  syncAfterAction(state, player);
  return { ok: true, state, issues: [] };
}

function doCall(state: GameState, player: PlayerState, command: ActionCommand): StateResult {
  const required = requiredCallAmount(state, player.id);
  const rawNeed = state.currentBet - player.committedByStreet[state.street];

  if (rawNeed <= 0) {
    return fail(state, [blocker(IssueCode.CALL_AMOUNT_ILLEGAL, { required: 0, provided: command.amount ?? 0 })]);
  }
  if (command.amount === undefined) {
    return fail(state, [blocker(IssueCode.CALL_AMOUNT_ILLEGAL, { required: required, provided: '未填写' })]);
  }
  if (command.amount < 0) {
    return fail(state, [blocker(IssueCode.ACTION_NEGATIVE_AMOUNT, { action: ActionType.CALL, amount: command.amount })]);
  }
  // 全下跟注：筹码不足时以全部筹码跟注
  const isAllInCall = player.remainingStack <= rawNeed;
  const expectedAmount = isAllInCall ? player.remainingStack : required;
  if (command.amount !== expectedAmount) {
    return fail(state, [
      blocker(IssueCode.CALL_AMOUNT_ILLEGAL, { required: expectedAmount, provided: command.amount }),
    ]);
  }

  const potBefore = computePot(state);
  player.remainingStack -= command.amount;
  player.committedByStreet[state.street] += command.amount;
  if (player.remainingStack === 0) player.allIn = true;
  state.actions.push(
    record(state, player, ActionType.CALL, command.amount, player.committedByStreet[state.street], player.allIn, potBefore),
  );
  state.pendingQueue = state.pendingQueue.filter((id) => id !== player.id);
  syncAfterAction(state, player);
  return { ok: true, state, issues: [] };
}

function doBet(state: GameState, player: PlayerState, command: ActionCommand): StateResult {
  if (state.street === Street.PREFLOP && !isUnopenedPot(state)) {
    return fail(state, [
      blocker(IssueCode.ACTION_NOT_LEGAL_NOW, {
        street: state.street,
        action: ActionType.BET,
        player: player.name,
      }),
    ]);
  }
  if (!isUnopenedPot(state)) {
    return fail(state, [
      blocker(IssueCode.ACTION_NOT_LEGAL_NOW, {
        street: state.street,
        action: ActionType.BET,
        player: player.name,
      }),
    ]);
  }
  const amount = command.amount;
  if (amount === undefined) {
    return fail(state, [blocker(IssueCode.ACTION_ZERO_AMOUNT, { action: ActionType.BET })]);
  }
  /*
   * 🔴 **无人能跟时不允许下注**（2026-09 边池轮）。
   *
   * 其余未弃牌玩家全部全下时，下注没有任何意义 —— 多出的部分按规则
   * 直接退回，现实中这时直接跑牌到摊牌。允许它会让系统产出一个
   * **现实中不存在的决策点**（实测：`BET 500` 被接受、底池 +500）。
   *
   * ⚠️ `needsToAct` 已经会把它排除出行动队列，这里是**第二道防线**：
   * 防止将来有人绕过队列（或直接调 `applyAction`）时又把它放进来。
   * 两道判据同源（都看「别人还能不能跟」），因此不会互相矛盾。
   */
  if (!canAnyoneElseCall(state, player.id)) {
    return fail(state, [
      blocker(IssueCode.BET_NOT_ALLOWED, {
        player: player.name,
        street: state.street,
        reason: '其余玩家都已全下或弃牌，没有人能跟注 —— 多出的筹码会原样退回，因此不存在下注',
      }),
    ]);
  }
  if (amount < 0) {
    return fail(state, [blocker(IssueCode.ACTION_NEGATIVE_AMOUNT, { action: ActionType.BET, amount })]);
  }
  if (amount === 0) {
    return fail(state, [blocker(IssueCode.ACTION_ZERO_AMOUNT, { action: ActionType.BET })]);
  }
  if (amount > player.remainingStack) {
    return fail(state, [
      blocker(IssueCode.BET_EXCEEDS_STACK, { player: player.name, amount, stack: player.remainingStack }),
    ]);
  }
  const minimum = minBetAmount(state, player);
  const isAllInBet = amount === player.remainingStack;
  if (amount < minimum && !isAllInBet) {
    return fail(state, [blocker(IssueCode.BET_BELOW_MIN, { minBet: minimum, provided: amount })]);
  }

  const potBefore = computePot(state);
  player.remainingStack -= amount;
  player.committedByStreet[state.street] += amount;
  if (player.remainingStack === 0) player.allIn = true;

  state.currentBet = player.committedByStreet[state.street];
  state.lastRaiseSize = amount;
  state.lastAggressorId = player.id;
  // 新的主动下注：所有玩家重新获得加注权
  state.raiseClosedFor = [];

  state.actions.push(
    record(state, player, ActionType.BET, amount, player.committedByStreet[state.street], player.allIn, potBefore),
  );
  markActed(state, player.id);
  rebuildPendingQueue(state, player.id);
  return { ok: true, state, issues: [] };
}

function doRaise(state: GameState, player: PlayerState, command: ActionCommand): StateResult {
  const amount = command.amount;
  if (amount === undefined) {
    return fail(state, [blocker(IssueCode.ACTION_ZERO_AMOUNT, { action: command.type })]);
  }
  if (amount < 0) {
    return fail(state, [blocker(IssueCode.ACTION_NEGATIVE_AMOUNT, { action: command.type, amount })]);
  }
  const already = player.committedByStreet[state.street];
  if (amount <= state.currentBet || amount <= already) {
    return fail(state, [
      blocker(IssueCode.RAISE_AMOUNT_ILLEGAL, { currentBet: state.currentBet, provided: amount }),
    ]);
  }
  const need = amount - already;
  if (need > player.remainingStack) {
    return fail(state, [
      blocker(IssueCode.BET_EXCEEDS_STACK, { player: player.name, amount: need, stack: player.remainingStack }),
    ]);
  }
  const isAllInRaise = need === player.remainingStack;
  if (!canRaise(state, player.id)) {
    return fail(state, [
      blocker(IssueCode.RAISE_NOT_REOPENED_FOR_PLAYER, { player: player.name, minTo: minRaiseTo(state) }),
    ]);
  }
  /*
   * 🔴 **无人能跟时不允许加注/全下**（2026-09 边池轮）。
   *
   * 与 `doBet` 里那条守卫**同源**（都看「别人还能不能跟」）。补这一条的原因：
   * 上了 `doBet` 的守卫却漏了这里，于是规则只做了一半 ——
   * 独立审查实测（其余人全下、BB 面对 2900 全下、BB 还剩 19900）：
   *
   * ```text
   * BB ALL_IN     → 被接受（多投的筹码事后退回）
   * BB RAISE 9900 → 被接受
   * ```
   *
   * 现实中荷官不会受理这笔加注 —— 桌上再没有任何人能跟，
   * 多余筹码只会原样退回。允许它等于**为现实中不存在的动作给出建议**，
   * 与本项目「不为不存在的决策点给建议」是同一条纪律。
   *
   * ⚠️ 注意这里**只关加注**：欠跟注的人仍然必须能跟注或弃牌
   *（那是真实决策 —— 他的跟注是真的要被比较的）。
   */
  if (!canAnyoneElseCall(state, player.id)) {
    return fail(state, [
      blocker(IssueCode.RAISE_NOT_REOPENED_FOR_PLAYER, {
        player: player.name,
        minTo: minRaiseTo(state),
        reason: '其余玩家都已全下或弃牌，没有人能跟注 —— 加注多出的筹码会原样退回，因此这个加注不存在',
      }),
    ]);
  }
  const minimumTo = minRaiseTo(state);
  const increment = amount - state.currentBet;
  if (amount < minimumTo && !isAllInRaise) {
    return fail(state, [blocker(IssueCode.RAISE_BELOW_MIN, { minTo: minimumTo, provided: amount })]);
  }

  const potBefore = computePot(state);
  player.remainingStack -= need;
  player.committedByStreet[state.street] += need;
  if (player.remainingStack === 0) player.allIn = true;

  const isFullRaise = increment >= state.lastRaiseSize || state.currentBet === 0;
  const previousBet = state.currentBet;

  /*
   * 🔴 **谁被「短全下不重开」关掉加注权** —— 判据是「**本街已对当前注额表过态**」，
   * 不是「已投入的筹码追平了上一注额」（2026-09 修复）。
   *
   * ## 旧写法错在哪
   *
   * 旧判据 `other.committedByStreet[street] >= previousBet` 会把
   * **尚未行动过**的玩家一起关掉 —— 因为**盲注也是「已投入」**。
   * 最典型的受害者正是大盲：他被迫投下一个大盲，于是「已投入 == previousBet」
   * 恒成立，`raiseClosedFor` 里就有他，**他的选择权被一个短码全下吃掉了**。
   *
   * 实测（单挑，BTN 是小盲，stacks BTN 150 / BB 10000，BTN ALL_IN 150）：
   *
   * ```text
   * raiseClosedFor   = ["bb"]      ← 大盲还没行动过，不该被关
   * BB RAISE 250     → 拒绝 RAISE_NOT_REOPENED_FOR_PLAYER
   * 同一局面 SB/CO（未行动者）canRaise = true   ← 代码自相矛盾
   * ```
   *
   * ## 规则依据
   *
   * TDA 43：不足一个完整加注的全下**只对「已经行动过」的玩家**不重开下注；
   * 尚未行动的玩家（尤其大盲）仍可加注。
   *
   * `actedSinceLastAggression` 的语义恰好就是「已经对**当前注额**表过态」
   *（见 `markActed` 的文档），因此直接用它 —— 不再自己拼一个近似判据。
   *
   * ⚠️ **必须在 `markActed` 之前读取**：那个函数会把列表重置为只剩加注者。
   */
  const actedBefore = new Set(state.actedSinceLastAggression);

  state.currentBet = player.committedByStreet[state.street];
  if (isFullRaise) {
    state.lastRaiseSize = increment;
    state.raiseClosedFor = [];
  } else {
    // 短全下加注：对**已经表过态**的玩家不重开加注权
    const closed = new Set(state.raiseClosedFor);
    for (const other of state.players) {
      if (other.id === player.id || other.folded || other.allIn) continue;
      if (actedBefore.has(other.id)) closed.add(other.id);
    }
    state.raiseClosedFor = [...closed];
  }
  state.lastAggressorId = player.id;

  state.actions.push(
    record(
      state,
      player,
      previousBet === 0 ? ActionType.BET : ActionType.RAISE,
      need,
      player.committedByStreet[state.street],
      player.allIn,
      potBefore,
    ),
  );
  markActed(state, player.id);
  rebuildPendingQueue(state, player.id);
  return { ok: true, state, issues: [] };
}

/**
 * 标记本街已行动。
 *
 * 语义：`actedSinceLastAggression` 表示「已经对**当前注额**表过态」。
 * 一旦出现新的主动下注/加注，其他人的旧标记随即失效（他们又要重新表态），
 * 因此这里直接把列表重置为只剩加注者本人。
 * 这样既保留了「尚未行动过」这一信息（用于大盲的选择权），
 * 又不会让已行动玩家被错误地跳过。
 */
function markActed(state: GameState, playerId: string): void {
  state.actedSinceLastAggression = [playerId];
}

function doAllIn(state: GameState, player: PlayerState, command: ActionCommand): StateResult {
  const need = player.remainingStack;
  if (need <= 0) {
    return fail(state, [blocker(IssueCode.ALLIN_PLAYER_ACTED, { player: player.name })]);
  }
  // 语义统一：ALL_IN 表示「把全部剩余筹码投入」，amount 若填写必须等于剩余筹码
  if (command.amount !== undefined && command.amount !== need) {
    return fail(state, [blocker(IssueCode.ALLIN_AMOUNT_MISMATCH, { expected: need, provided: command.amount })]);
  }

  const already = player.committedByStreet[state.street];
  const toAmount = already + need;

  // 属于「全下下注 / 全下加注」时，复用加注路径以保证最小加注与重开规则一致
  if (toAmount > state.currentBet) {
    return doRaise(state, player, { ...command, type: ActionType.RAISE, amount: toAmount });
  }

  const potBefore = computePot(state);
  player.remainingStack = 0;
  player.committedByStreet[state.street] += need;
  player.allIn = true;
  state.actions.push(
    record(state, player, ActionType.ALL_IN, need, player.committedByStreet[state.street], true, potBefore),
  );
  state.pendingQueue = state.pendingQueue.filter((id) => id !== player.id);
  syncAfterAction(state, player);
  return { ok: true, state, issues: [] };
}

/* ============================================================
 * 队列与推进
 * ============================================================ */

function countContenders(state: GameState): number {
  return state.players.filter((p) => !p.folded).length;
}

function record(
  state: GameState,
  player: PlayerState,
  type: ActionType,
  amount: number,
  toAmount: number,
  isAllIn: boolean,
  potBefore: number,
): ActionRecord {
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
    potAfter: computePot(state),
  };
}

/**
 * 该玩家本街是否还需要行动。
 *
 * ## 🔴 「干边池」必须关闭行动（2026-09 边池轮）
 *
 * 当**其余未弃牌玩家全部已全下**时，最后一名还有筹码的玩家**无事可做**：
 * 他无论下注多少都不会有人跟，多出的部分按规则直接退回。
 * 现实中这时直接跑牌到摊牌。
 *
 * 修复前这里没有这条判断，于是系统会为**现实中不存在的决策点**输出建议 ——
 * 实测（3 人桌，大小盲都盲注全下、只剩 BTN 有筹码）：
 *
 * ```text
 * 翻牌后 pendingQueue = ["btn"]     ← 应为空
 * applyAction(BTN BET 500) → ok     ← 无人能跟，这手牌现实中不会发生
 * ```
 *
 * 而 `reconstructGameState(ANALYZE)` 会据此**成功推进到翻牌并给出决策点** ——
 * 为不存在的决策点给建议，是本项目最忌讳的一类输出。
 *
 * ## 为什么判据是「别人还能不能跟」而不是「别人是否全下」
 *
 * 等价，但说「能不能跟」更贴近规则本身：
 *
 * - 别人**弃牌**了 → 跟不了
 * - 别人**全下**了 → 跟不了（筹码已空）
 * - 别人**筹码为 0** → 跟不了
 *
 * 只要还有**任意一个**别人能跟，本街就要继续。
 *
 * ⚠️ 我自己的**跟注**仍然要发生 —— 这条只关掉「主动下注/加注」，
 * 不关掉「面对别人的全下做跟注/弃牌决定」。因此当 `currentBet` 高于我已投时，
 * 我依然需要行动（那时 `needsToAct` 会因「未跟平」而返回 true）。
 */
function canAnyoneElseCall(state: GameState, playerId: string): boolean {
  for (const other of state.players) {
    if (other.id === playerId) continue;
    if (other.folded || other.allIn || other.remainingStack <= 0) continue;
    return true;
  }
  return false;
}

function needsToAct(state: GameState, player: PlayerState): boolean {
  if (player.folded || player.allIn || player.remainingStack === 0) return false;

  /*
   * 🔴 面对一个我还没跟平的下注时，我**必须**行动（跟注或弃牌）——
   * 即使其他人都已全下。这条要排在「干边池」判断**之前**。
   */
  const owesCall = player.committedByStreet[state.street] < state.currentBet;
  if (owesCall) return true;

  /*
   * 我已跟平、不欠跟注。若其余人都跟不了，那我能做的只有「过牌结束本街」——
   * 而下注/加注没有任何意义（无人能跟，多出的部分原样退回）。
   * 此时**不再要求行动**，直接跑牌到摊牌。
   */
  if (!canAnyoneElseCall(state, player.id)) return false;

  // 本街尚未行动过 —— 覆盖「翻牌前大盲的选择权」
  if (!state.actedSinceLastAggression.includes(player.id)) return true;
  // 已行动过，但后面有人加注，需要补注
  return player.committedByStreet[state.street] < state.currentBet;
}

/**
 * 重建待行动队列，并在本街结束时自动推进。
 *
 * 顺序规则：以 lastActor 的下一位为起点按行动顺序环绕；
 * 对于「尚未行动过」的玩家，从本街第一个应行动的位置开始（保证大盲的选择权落在最后）。
 *
 * 这是整个状态机的核心：每次动作后整体重建，而不是增量修补，
 * 因此不会漏人也不会无限循环（对应 Bug 预判 B11 / B14）。
 */
function rebuildPendingQueue(state: GameState, lastActorId: string): void {
  // 完整行动顺序（**含已弃牌者**）—— 必须用它定位行动者。
  // ⚠️ 不能先 `filter(p => !p.folded)`：那会把弃牌者从定位依据里删掉，
  // 于是 `findIndex` 找不到行动者，旋转起点错误（见下方修复说明）。
  const fullOrder = streetOrder(state);

  // ⚠️ 修复（Alpha 端到端发现，**真实 Bug**）
  //
  // 旧代码在**过滤掉弃牌者之后**的列表里定位 `lastActorId`：
  //
  // ```ts
  // const order = streetOrder(state).filter((p) => !p.folded);
  // const startIndex = Math.max(0, order.findIndex((p) => p.id === lastActorId));
  // const rotated = [...order.slice(startIndex + 1), ...order.slice(0, startIndex + 1)];
  // ```
  //
  // 行动者一旦弃牌就不在该列表里，`findIndex` 返回 -1，
  // `Math.max(0, -1)` 把它变成 0，于是 **`order[0]` 被转到队尾** ——
  // 凭空把本该先行动的玩家排到最后。
  //
  // 实测两处后果（都是「合法输入被拒」，直接阻断端到端）：
  // - 6 人桌 UTG 弃牌 → 队列 `[UTG,HJ,CO,BTN,SB,BB]` 变成 `[CO,BTN,SB,BB,HJ]`
  // - 短全下场景 CO 弃牌 → `[co,btn,sb,bb,utg]` 变成 `[utg,btn,sb,bb]`
  //   → 系统要求 UTG 先行动，而 BTN 才是正确的下一位
  //
  // 正确语义：**在完整顺序里定位行动者，再从「他之后第一位」开始环绕**；
  // 弃牌者由 `needsToAct` 筛掉，不参与定位的删除。
  const startIndex = fullOrder.findIndex((p) => p.id === lastActorId);

  /**
   * 从 `startIndex` 之后开始环绕。
   *
   * - `startIndex >= 0`：跳过行动者本人（他已表态），从下一位开始
   * - `startIndex < 0`：理论上不可达（`lastActorId` 来自 `streetOrder`）；
   *   真发生时按原顺序处理，**不旋转**，避免再次凭空重排
   */
  const rotated =
    startIndex < 0
      ? fullOrder
      : [...fullOrder.slice(startIndex + 1), ...fullOrder.slice(0, startIndex + 1)];

  const queue: string[] = [];
  for (const player of rotated) {
    if (needsToAct(state, player)) queue.push(player.id);
  }
  state.pendingQueue = queue;

  if (queue.length === 0 && isBettingRoundComplete(state)) {
    state.pendingQueue = [];
    onBettingRoundComplete(state);
  }
}

/** 一般动作（弃牌/跟注/过牌/全下跟注）之后的统一收尾 */
function syncAfterAction(state: GameState, actor: PlayerState): void {
  state.actedSinceLastAggression.push(actor.id);

  // 弃牌可能导致「当前注额」由已弃牌玩家保持，需要重新认定
  if (state.lastAggressorId !== null && playerById(state, state.lastAggressorId)?.folded) {
    let newBet = 0;
    for (const player of state.players) {
      if (player.folded) continue;
      newBet = Math.max(newBet, player.committedByStreet[state.street]);
    }
    state.currentBet = newBet;
  }

  rebuildPendingQueue(state, actor.id);
}

/**
 * 本街下注轮结束。
 *
 * 职责边界（很重要，本项目实际踩过坑）：
 * - 这里**只**标记「本街下注轮已结束」，**不**切换街道，也**不**发牌。
 *   因为发牌必须由调用方显式提供（领域层不做随机），
 *   而「街」与「已发的公共牌」必须始终一一对应。
 * - 街道切换与发牌统一由 advanceStreet 完成。
 *
 * 两种立即结束牌局的情形仍在这里处理：
 * - 河牌轮结束 → 进入摊牌阶段
 * - 只剩一人未弃牌 → 牌局直接结束
 */
function onBettingRoundComplete(state: GameState): void {
  state.bettingRoundComplete = true;
  state.pendingQueue = [];

  if (state.street === Street.RIVER) {
    state.phase = HandPhase.SHOWDOWN;
    state.currentBet = 0;
    state.lastRaiseSize = state.config.bigBlind;
    state.lastAggressorId = null;
    state.raiseClosedFor = [];
    state.actedSinceLastAggression = [];
    return;
  }

  // 只剩一名未弃牌玩家时直接结束（其他人都弃牌了）
  if (countContenders(state) <= 1) {
    finishByFold(state);
  }
}

/**
 * 重置为「新一街的下注轮开始」状态。
 *
 * 由 advanceStreet 在完成发牌后调用，因此需要导出（见 streetAdvance.ts）。
 * 注意：本函数不动 street 字段也不发牌 —— 那两件事只由 advanceStreet 负责。
 */
export function resetStreetState(state: GameState): void {
  state.phase = HandPhase.BETTING;
  state.bettingRoundComplete = false;
  state.currentBet = 0;
  state.lastRaiseSize = state.config.bigBlind;
  state.lastAggressorId = null;
  state.raiseClosedFor = [];
  state.actedSinceLastAggression = [];

  /*
   * 🔴 **用 `needsToAct` 过滤，而不是「未弃牌且未全下且还有筹码」。**
   *
   * 旧写法会把「其余人都已全下」时那名唯一的幸存者也放进队列 ——
   * 于是新一街一开，系统就要求一个**根本无事可做**的人行动，
   * `reconstructGameState(ANALYZE)` 据此给出一个现实中不存在的决策点。
   *
   * 实测（大小盲都盲注全下、只剩 BTN 有筹码）：翻牌后队列是 `["btn"]`，
   * 而那手牌现实中直接跑牌到摊牌。
   *
   * ⚠️ 过滤后如果队列为空，必须**接着判定本街是否已完成** ——
   * 否则状态会停在「没有待行动者、也未标记完成」的中间态，
   * 表现为牌局卡住无法推进。这与 `rebuildPendingQueue` 的处理保持一致。
   */
  const queue: string[] = [];
  for (const player of streetOrder(state)) {
    if (needsToAct(state, player)) queue.push(player.id);
  }
  state.pendingQueue = queue;

  if (queue.length === 0 && isBettingRoundComplete(state)) {
    onBettingRoundComplete(state);
  }
}

/** 下一街（河牌之后仍返回河牌，由调用方先行拦截） */
export function nextStreet(street: Street): Street {
  switch (street) {
    case Street.PREFLOP:
      return Street.FLOP;
    case Street.FLOP:
      return Street.TURN;
    case Street.TURN:
      return Street.RIVER;
    default:
      return Street.RIVER;
  }
}

/** 只剩一人未弃牌：底池归他，牌局结束 */
function finishByFold(state: GameState): void {
  const winner = state.players.find((p) => !p.folded);
  state.phase = HandPhase.COMPLETE;
  state.pendingQueue = [];
  state.currentBet = 0;
  state.winners = winner ? [winner.id] : [];
}

/* ============================================================
 * 门面导出
 *
 * advanceStreet 的实现已拆到 streetAdvance.ts（保持单文件规模可控），
 * 这里重新导出，使调用方继续从 engine.ts 取用，避免导入路径碎片化。
 * ============================================================ */

export { advanceStreet, type AdvanceOptions } from './streetAdvance.ts';