/**
 * 交互式牌桌录入 —— 座位生命周期与状态正确性
 *
 * ## 本文件针对的缺陷类别
 *
 * 本轮最危险的不是界面崩溃，而是：
 *
 * > 牌桌**看起来**对，但后端收到的是：错误位置 / 错误玩家 / 错误筹码 /
 * > 错误底池 / 错误画像。
 *
 * 也就是 **Silent State Corruption**。因此这里的断言全部落在
 * 「引擎真正会看到的东西」上，而不是界面文本：
 *
 * ```
 * 屏幕显示值  ==  实际提交的 ManualHandInput  ==  后端重放出的状态
 * ```
 *
 * ## 三条最高优先级不变量（规范第 100 条）
 *
 * ```
 * # Fold ≠ Leave Table
 * # Seat ≠ Player
 * # 当前 Hand 的历史事实不能因为玩家离桌而被删除
 * ```
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position, Street } from '../src/domain/types.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import {
  parseManualInput,
  type ManualHandInput,
} from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import {
  createTable,
  participantSeatsOf,
  seatOfPosition,
  staffingNotices,
  staffingProblems,
} from '../src/app/table/tableState.ts';
import { applyTableOp, engineViewOf } from '../src/app/table/tableOps.ts';
import { buildTablePreview, stateFingerprintOf } from '../src/app/table/tablePreview.ts';
import {
  primaryOpponentPosition,
  tableStateToManualHandInput,
} from '../src/app/table/tableAdapter.ts';
import {
  ActiveHandLeaveChoice,
  SeatStatus,
  type PokerTableState,
  type TableOp,
} from '../src/app/table/table.types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;

/* ============================================================
 * 驱动辅助（模拟界面点击 → 后端操作）
 * ============================================================ */

function must(result: ReturnType<typeof applyTableOp>): PokerTableState {
  if (!result.ok) {
    throw new Error(`操作被拒绝：${result.issues.map((i) => i.message).join(' / ')}`);
  }
  return result.state;
}

function drive(start: PokerTableState, ops: readonly TableOp[]): PokerTableState {
  let state = start;
  for (const op of ops) state = must(applyTableOp(state, op));
  return state;
}

const ALL_POSITIONS_6: readonly Position[] = [
  Position.UTG,
  Position.HJ,
  Position.CO,
  Position.BTN,
  Position.SB,
  Position.BB,
];

/** 建一张 6 人桌，Hero 在 `hero`，其余座位全部加入玩家 */
function fullTable(hero: Position = Position.CO, stackBB = 100): PokerTableState {
  let state = createTable({ tableSize: 6, heroPosition: hero, defaultStackBB: stackBB });
  for (const position of ALL_POSITIONS_6) {
    if (position === hero) continue;
    const seat = seatOfPosition(state, position)!;
    state = must(applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seat.seatId }));
  }
  return state;
}

const preview = (state: PokerTableState) => buildTablePreview(state);

/** 点一个动作按钮（按类型 + 可选序号），走**后端判定**的行动者 */
function clickAction(
  state: PokerTableState,
  type: string,
  sizeIndex = 0,
): PokerTableState {
  const p = preview(state);
  const buttons = p.actionButtons.filter((b) => b.type === type && b.group === (sizeIndex < 0 ? 'PRIMARY' : 'SIZE'));
  const pool = buttons.length > 0 ? buttons : p.actionButtons.filter((b) => b.type === type);
  const button = sizeIndex >= 0 ? (pool[sizeIndex] ?? pool[0]) : pool[0];
  assert.ok(
    button !== undefined,
    `预览里应当有「${type}」按钮，实际：${p.actionButtons.map((b) => b.labelZh).join(' / ') || '（无）'}`,
  );
  return must(
    applyTableOp(state, {
      kind: 'ACT',
      action: {
        type: button.type,
        ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
      },
    }),
  );
}

/** 一直弃牌到轮到 Hero（模拟连续点「弃牌」） */
function foldUntilHero(state: PokerTableState, maxSteps = 12): PokerTableState {
  let current = state;
  for (let i = 0; i < maxSteps; i += 1) {
    const p = preview(current);
    if (p.currentActorPosition === null) return current;
    if (p.isHeroTurn) return current;
    current = clickAction(current, 'FOLD', -1);
  }
  return current;
}

/* ============================================================
 * 不变量 A：FOLD 只影响当前手
 * ============================================================ */

test('不变量 A：弃牌只影响当前手 —— 下一手玩家仍在原座位', () => {
  let state = fullTable(Position.CO);
  const utgSeat = seatOfPosition(state, Position.UTG)!;
  const utgPlayerId = utgSeat.playerId!;

  // Hero 先选牌（后端要求手牌齐备才能重放）
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);

  // UTG 弃牌
  assert.equal(preview(state).currentActorPosition, Position.UTG, '翻牌前第一个行动的是 UTG');
  state = clickAction(state, 'FOLD', -1);

  const utgAfterFold = seatOfPosition(state, Position.UTG)!;
  assert.equal(utgAfterFold.status, SeatStatus.FOLDED_THIS_HAND, '弃牌后状态必须是 FOLDED_THIS_HAND');
  assert.equal(utgAfterFold.playerId, utgPlayerId, '弃牌**不得**解除座位绑定');
  assert.equal(
    state.actionHistory.filter((a) => a.position === Position.UTG).length,
    1,
    '行动历史里必须有那次弃牌',
  );

  // 下一手
  state = must(applyTableOp(state, { kind: 'NEXT_HAND' }));
  const utgNextHand = seatOfPosition(state, Position.UTG)!;
  assert.equal(utgNextHand.status, SeatStatus.SEATED_ACTIVE, '下一手必须回到 SEATED_ACTIVE');
  assert.notEqual(utgNextHand.status, SeatStatus.EMPTY, '弃牌**绝不能**导致座位被清空');
  assert.equal(utgNextHand.playerId, utgPlayerId, '同一手之后人还在原座位');
  assert.equal(state.actionHistory.length, 0, '下一手清空行动历史');
});

/* ============================================================
 * 不变量 B：CLEAR SEAT 必须解除绑定（不只是隐藏 UI）
 * ============================================================ */

test('不变量 B：清空座位必须真正解除 seat → playerId 绑定', () => {
  const state0 = fullTable(Position.CO);
  const hjSeat = seatOfPosition(state0, Position.HJ)!;
  const hjPlayerId = hjSeat.playerId!;
  assert.notEqual(hjPlayerId, null);

  const state1 = must(applyTableOp(state0, { kind: 'CLEAR_SEAT', seatId: hjSeat.seatId }));
  const hjAfter = seatOfPosition(state1, Position.HJ)!;

  assert.equal(hjAfter.playerId, null, '清空座位后 playerId 必须是 null');
  assert.equal(hjAfter.status, SeatStatus.EMPTY, '状态必须是 EMPTY');
  /*
   * 🔴 **Table Topology Correction 改变了这里的语义，断言随之加强。**
   *
   * 旧断言：有空座位 → `staffingProblems` 非空（因为 Poker Core 要求
   * 「N 人桌恰好 N 位玩家」）。那个前提已经不成立：`createGame` 现在
   * 接受 `2 ≤ 本手人数 ≤ 座位容量`，空座位只是「本手不发牌」。
   *
   * 新断言同时钉住**两头**，比旧断言更强：
   *   1. 6 座桌剩 5 人 → **仍然是可分析的局面**，不得被误判为阻断；
   *   2. 同时必须**如实告知**「5 人参与、1 个座位不发牌」。
   * 只钉 1 会漏掉「默默少发牌却不告诉使用者」，只钉 2 会漏掉
   * 「拦截点从域层搬到表层」（本轮的头号缺陷形态）。
   */
  assert.equal(
    staffingProblems(state1).length,
    0,
    '6 座桌 5 人必须可分析 —— 空座位不再阻断（容量 ≠ 本手人数）',
  );
  assert.ok(
    staffingNotices(state1).some((n) => n.includes('本手 5 人参与') && n.includes('劫持位')),
    `必须如实告知本手人数与不发牌的座位：${staffingNotices(state1).join(' / ')}`,
  );

  // 坐进一个新玩家 → 适配器给出的对手里**不得**出现旧玩家
  const state2 = must(applyTableOp(state1, { kind: 'ADD_PLAYER', seatId: hjSeat.seatId }));

  // 让 HJ 成为**首要对手**（把 UTG 弃掉），这样适配器一定会去读这个座位 ——
  // 于是「绑定是否真的解除了」才是可观测的
  let withAction = drive(state2, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  withAction = must(
    applyTableOp(withAction, {
      kind: 'SET_PROFILE',
      seatId: seatOfPosition(withAction, Position.HJ)!.seatId,
      quickProfile: 'MANIAC',
    }),
  );
  withAction = clickAction(withAction, 'FOLD', -1); // UTG 弃牌 → 首要对手变成 HJ

  const adapted = tableStateToManualHandInput(withAction);
  assert.equal(adapted.ok, true);
  if (!adapted.ok) return;
  assert.equal(adapted.primaryOpponentPosition, Position.HJ, 'UTG 弃牌后首要对手必须是 HJ');
  assert.equal(
    adapted.input.villain!.playerId,
    `seat_${Position.HJ}`,
    '传给管线的 villain 必须是 HJ 座位上的那个人（引擎口径 id）',
  );
  assert.equal(adapted.input.villain!.quickProfile, 'MANIAC', 'HJ 的画像必须如实传进去');
  assert.notEqual(
    seatOfPosition(withAction, Position.HJ)!.playerId,
    hjPlayerId,
    'HJ 座位上必须是**新玩家**，不是离桌的那一位',
  );
  // ⚠️ 只传一个对手：把「全部对手」列出来会让 `villains[0]` 的语义依赖顺序，
  //    而那正是红队命中的「画像挂到已弃牌的 UTG 身上」这个 CRITICAL 缺陷的根因。
  assert.equal(
    adapted.input.villains,
    undefined,
    '适配器只传 `villain`（首要对手），不得传 `villains` 数组',
  );

  // 玩家对象仍可追溯（§62），但不再占用座位
  assert.ok(
    state2.playersById[hjPlayerId] !== undefined,
    '玩家对象可以保留在历史里（用于追溯）',
  );
  assert.ok(
    !state2.seats.some((s) => s.playerId === hjPlayerId),
    '旧玩家不得被任何座位引用',
  );
});

/* ============================================================
 * 不变量 C：当前手的历史事实不能因为离桌被删除
 * ============================================================ */

test('不变量 C：本手进行中离桌 —— 底池与行动台账必须完整保留', () => {
  let state = fullTable(Position.CO);
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);

  // UTG 跟注 3BB 前先让 UTG 加注到 3BB，这样他有 3BB 的投入
  let acted = clickAction(state, 'RAISE', 0); // 尺寸展开的第一项
  // 若 RAISE 尺寸池为空则退回最小值
  const utgCommitted = (() => {
    const view = engineViewOf(acted);
    if (!view.ok) return 0;
    const p = view.engine.players.find((x) => x.position === Position.UTG);
    return Object.values(p!.committedByStreet).reduce((a, b) => a + b, 0);
  })();
  assert.ok(utgCommitted > 0, 'UTG 应当已经投入筹码');

  const potBefore = preview(acted).potBB;
  const historyBefore = acted.actionHistory.length;

  // 用户点「清空座位」→ 后端要求明确选择（不许默认猜）
  const decision = applyTableOp(acted, {
    kind: 'CLEAR_SEAT',
    seatId: seatOfPosition(acted, Position.UTG)!.seatId,
  });
  assert.equal(decision.ok, false, '本手进行中直接清空座位必须被拒绝');
  if (decision.ok) return;
  assert.ok(decision.leaveDecision !== undefined, '必须给出「离桌选择」而不是静默处理');
  assert.ok(
    decision.leaveDecision!.options.includes(ActiveHandLeaveChoice.LEAVE_AFTER_HAND),
    '必须提供「仅标记手后离桌」',
  );
  assert.ok(
    decision.leaveDecision!.options.includes(ActiveHandLeaveChoice.CANCEL),
    '必须提供「取消」',
  );

  // 选择「仅标记手后离桌」
  acted = must(
    applyTableOp(acted, {
      kind: 'CLEAR_SEAT',
      seatId: seatOfPosition(acted, Position.UTG)!.seatId,
      activeHandChoice: ActiveHandLeaveChoice.LEAVE_AFTER_HAND,
    }),
  );

  const utgSeat = seatOfPosition(acted, Position.UTG)!;
  assert.equal(utgSeat.status, SeatStatus.LEAVING_AFTER_HAND, '必须标为手后离桌');
  assert.notEqual(utgSeat.playerId, null, '本手期间**保留**绑定（否则历史事实就没了）');
  assert.equal(acted.actionHistory.length, historyBefore, '行动台账不得被删改');
  assert.equal(preview(acted).potBB, potBefore, '底池不得变化');

  const view = engineViewOf(acted);
  assert.equal(view.ok, true);
  if (!view.ok) return;
  const utg = view.engine.players.find((p) => p.position === Position.UTG)!;
  assert.equal(
    Object.values(utg.committedByStreet).reduce((a, b) => a + b, 0),
    utgCommitted,
    '已投入的筹码必须仍在牌局里',
  );

  // 下一手：这时才真正清空
  const next = must(applyTableOp(acted, { kind: 'NEXT_HAND' }));
  const utgNext = seatOfPosition(next, Position.UTG)!;
  assert.equal(utgNext.status, SeatStatus.EMPTY, '下一手才真正清空座位');
  assert.equal(utgNext.playerId, null);
});

/* ============================================================
 * §10 CRITICAL：换人绝不继承旧画像
 * ============================================================ */

test('§10 CRITICAL：座位 4 换人后，新玩家绝不继承旧玩家的画像与动态', () => {
  let state = fullTable(Position.CO);
  const target = Position.HJ;
  const seat = seatOfPosition(state, target)!;

  // A：跟注站 + 近期更激进
  state = drive(state, [
    { kind: 'SET_PROFILE', seatId: seat.seatId, quickProfile: 'CALLING_STATION' },
    { kind: 'SET_DYNAMIC_HINT', seatId: seat.seatId, dynamicHint: 'AGGRESSION_UP' },
  ]);
  const oldPlayerId = seatOfPosition(state, target)!.playerId!;
  assert.equal(state.playersById[oldPlayerId]!.quickProfile, 'CALLING_STATION');

  // A 离开 → B 坐进同一个座位
  state = must(applyTableOp(state, { kind: 'CLEAR_SEAT', seatId: seat.seatId }));
  state = must(applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seat.seatId }));

  const newSeat = seatOfPosition(state, target)!;
  const newPlayerId = newSeat.playerId!;
  assert.notEqual(newPlayerId, oldPlayerId, '更换玩家**必须**生成新的 playerId');

  const newPlayer = state.playersById[newPlayerId]!;
  assert.equal(newPlayer.quickProfile, 'UNKNOWN', '新玩家的快速画像必须是 UNKNOWN');
  assert.equal(newPlayer.dynamicHint, 'UNKNOWN', '新玩家的动态观察必须是 UNKNOWN');
  assert.equal(newPlayer.handsPlayed, 0, '新玩家没有历史手数');

  // 旧玩家对象仍可追溯，但**没有任何座位引用它**
  assert.ok(state.playersById[oldPlayerId] !== undefined, '旧玩家对象保留在历史里');
  assert.ok(
    !state.seats.some((s) => s.playerId === oldPlayerId),
    '旧玩家不得再被任何座位引用',
  );
});

test('§69 CRITICAL：A 在 UTG 是跟注站、离开后 B 坐进来 —— 分析不得再读到 A 的画像', () => {
  /**
   * 构造：Hero 在大盲，UTG 开池 3BB，其余人弃牌 → Hero 面对加注。
   * 此时**首要对手就是 UTG**（座位序里第一个未弃牌的非 Hero 玩家），
   * 因此 UTG 的画像会真正进入决策。
   */
  const buildWithActions = (): PokerTableState => {
    let state = fullTable(Position.BB, 100);
    state = drive(state, [
      { kind: 'SET_HERO_CARD', card: 'As' },
      { kind: 'SET_HERO_CARD', card: 'Kd' },
    ]);
    const acts: TableOp[] = [];
    void acts;
    // UTG 加注 → HJ/CO/BTN/SB 弃牌 → 轮到 Hero
    let guard = 0;
    state = clickAction(state, 'RAISE');
    while (!preview(state).isHeroTurn && guard < 8) {
      state = clickAction(state, 'FOLD', -1);
      guard += 1;
    }
    return state;
  };

  const adapt = (s: PokerTableState): ManualHandInput => {
    const a = tableStateToManualHandInput(s);
    assert.equal(a.ok, true, `适配必须成功：${a.ok ? '' : JSON.stringify(a.issues)}`);
    if (!a.ok) throw new Error('unreachable');
    return a.input;
  };

  // ---- 参照：全新牌桌（UTG 从未被设置过画像） ----
  const pristine = buildWithActions();

  // ---- 情形 A：UTG 被标为「跟注站」 ----
  const utgSeat = seatOfPosition(buildWithActions(), Position.UTG)!;
  let profiled = buildWithActions();
  profiled = must(
    applyTableOp(profiled, {
      kind: 'SET_PROFILE',
      seatId: utgSeat.seatId,
      quickProfile: 'CALLING_STATION',
    }),
  );

  // ---- 情形 B：UTG 曾是跟注站，然后**换了一个新玩家** ----
  let replaced = buildWithActions();
  replaced = must(
    applyTableOp(replaced, {
      kind: 'SET_PROFILE',
      seatId: utgSeat.seatId,
      quickProfile: 'CALLING_STATION',
    }),
  );
  // 换人必须在本手之前做 —— 本手已经进行，所以先重置本手再换人，然后重新录
  replaced = must(applyTableOp(replaced, { kind: 'RESET_HAND' }));
  replaced = must(applyTableOp(replaced, { kind: 'CLEAR_SEAT', seatId: utgSeat.seatId }));
  replaced = must(applyTableOp(replaced, { kind: 'ADD_PLAYER', seatId: utgSeat.seatId }));
  // 重新录同样的行动
  replaced = drive(replaced, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  replaced = clickAction(replaced, 'RAISE');
  {
    let guard = 0;
    while (!preview(replaced).isHeroTurn && guard < 8) {
      replaced = clickAction(replaced, 'FOLD', -1);
      guard += 1;
    }
  }

  // ---- 情形 C（反向对照）：把**首要对手**的动态观察改成「疑似上头」 ----
  //
  // 用途：证明「对手区块确实进入了管线，且能被观测到差异」。
  // 没有这条对照，上面的「换人后一致」可能只是因为整块对手信息都被忽略 —— 假阳性。
  let hinted = buildWithActions();
  hinted = must(
    applyTableOp(hinted, {
      kind: 'SET_DYNAMIC_HINT',
      seatId: utgSeat.seatId,
      dynamicHint: 'TILT_SIGNAL',
    }),
  );

  // 首要对手必须是 UTG
  assert.equal(primaryOpponentPosition(pristine), Position.UTG);
  assert.equal(primaryOpponentPosition(profiled), Position.UTG);
  assert.equal(primaryOpponentPosition(replaced), Position.UTG);

  // ---- 适配器层面：画像必须挂在**正确的人**身上 ----
  const pristineInput = adapt(pristine);
  const profiledInput = adapt(profiled);
  const replacedInput = adapt(replaced);
  assert.equal(
    pristineInput.villain!.playerId,
    `seat_${Position.UTG}`,
    '传给管线的 villain.playerId 必须是**引擎口径**（seat_UTG）—— ' +
      '用牌桌 playerId 会让动态层的事件匹配永远失败（实测踩到）',
  );
  assert.equal(
    profiledInput.villain!.quickProfile,
    'CALLING_STATION',
    'UTG 的画像必须如实传进去',
  );
  assert.equal(
    replacedInput.villain!.quickProfile,
    'UNKNOWN',
    '换人后传给管线的必须是「未知」',
  );
  // 换人后**牌桌层**的 playerId 必须是新玩家
  assert.notEqual(
    seatOfPosition(replaced, Position.UTG)!.playerId,
    seatOfPosition(profiled, Position.UTG)!.playerId,
    '换人后座位绑定的必须是新玩家',
  );

  const p0 = analyzeManualHand(pristineInput, OPTIONS);
  const p1 = analyzeManualHand(replacedInput, OPTIONS);
  const p2 = analyzeManualHand(profiledInput, OPTIONS);
  const p3 = analyzeManualHand(adapt(hinted), OPTIONS);
  assert.equal(p0.ok && p1.ok && p2.ok && p3.ok, true, '四手都应当能分析');
  if (!p0.ok || !p1.ok || !p2.ok || !p3.ok) return;

  // (1) 换人之后的结果必须与**从未设置过画像**逐位一致 —— 旧画像彻底消失
  assert.equal(
    JSON.stringify(p1.decision.diagnostics.math),
    JSON.stringify(p0.decision.diagnostics.math),
    '换人后的数学快照必须与全新牌桌完全一致',
  );
  assert.equal(p1.decision.confidence, p0.decision.confidence, '换人后置信度不得受旧画像影响');
  assert.equal(p1.decision.action, p0.decision.action);
  assert.deepEqual(
    p1.decision.reasons.map((r) => r.code),
    p0.decision.reasons.map((r) => r.code),
    '换人后的理由构成必须与全新牌桌一致',
  );

  // ⭐ 最强的一条：换人之后，**除身份字段外**与全新牌桌逐字节相同 ——
  //    A 的任何痕迹（画像、动态、持久 id、显示名）都不得留在送进管线的数据里。
  //
  // 🔴 **PLAYER IDENTITY ROUTING V1 修正**：修复前这里断言「整包逐字节相等」，
  //    而那是**因为输入里根本不携带玩家身份**（只有座位 id）才成立的。
  //    现在 `villain.persistentPlayerId` / `displayName` 必须进输入
  //    （否则无法按人取画像、也无法把两个不同玩家区分开），
  //    而 B 是新玩家 ⇒ 这两个字段**本来就应该不同**。
  //    真正要守的性质没有变，而且这里守得更准：
  //    ① 除身份字段外逐字段一致；② A 的持久 id 与显示名**不得出现**在输入里。
  const oldUtgPlayerId = seatOfPosition(profiled, Position.UTG)!.playerId!;
  const oldUtgName = profiled.playersById[oldUtgPlayerId]!.displayName;
  const withoutIdentity = (input: ManualHandInput): string => {
    const { persistentPlayerId: _p, displayName: _d, ...restVillain } = input.villain ?? {};
    return JSON.stringify({ ...input, villain: restVillain });
  };
  assert.equal(
    withoutIdentity(replacedInput),
    withoutIdentity(pristineInput),
    '除身份字段外，换人后的 ManualHandInput 必须与全新牌桌逐字段一致',
  );
  const replacedJson = JSON.stringify(replacedInput);
  assert.ok(
    !replacedJson.includes(oldUtgPlayerId),
    `A 的持久 playerId（${oldUtgPlayerId}）不得出现在送进管线的输入里`,
  );
  assert.ok(
    !replacedJson.includes(oldUtgName),
    `A 的显示名（${oldUtgName}）不得出现在送进管线的输入里`,
  );

  // (2) 反向对照：对手区块**确实**能被观测到差异 → 上面的「一致」不是假阳性
  assert.notEqual(
    p3.decision.confidence,
    p0.decision.confidence,
    '把首要对手标为「疑似上头」必须改变置信度 —— ' +
      '否则说明对手区块根本没进入管线，「换人后一致」就变成了空断言',
  );
  assert.notEqual(
    p2.log.inputHash,
    p0.log.inputHash,
    '画像不同 → 输入必须不同',
  );
});

test('§69 已知限制（如实记录）：快速画像多数情况下**不改变最终置信度**', () => {
  // 这不是本轮引入的缺陷，而是既有 Confidence 算法的**取最小值**语义：
  // 范围可信度 0.3 已经是最小分量，玩家层的 0.5 → 0.35 变化被它盖住。
  //
  // 本测试的作用是**把这条限制钉住**：如果将来有人改了取最小的语义，
  // 这里会失败，提醒他同步更新「快速画像有效果」这一说法。
  let state = fullTable(Position.BB, 100);
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  state = clickAction(state, 'RAISE');
  let guard = 0;
  while (!preview(state).isHeroTurn && guard < 8) {
    state = clickAction(state, 'FOLD', -1);
    guard += 1;
  }

  const adapt = (s: PokerTableState): ManualHandInput => {
    const a = tableStateToManualHandInput(s);
    assert.equal(a.ok, true);
    if (!a.ok) throw new Error('unreachable');
    return a.input;
  };

  const utgSeat = seatOfPosition(state, Position.UTG)!;
  const maniac = must(
    applyTableOp(state, { kind: 'SET_PROFILE', seatId: utgSeat.seatId, quickProfile: 'MANIAC' }),
  );

  const a = analyzeManualHand(adapt(state), OPTIONS);
  const b = analyzeManualHand(adapt(maniac), OPTIONS);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;

  assert.equal(
    b.decision.confidence,
    a.decision.confidence,
    '当前算法下快速画像不改变最终置信度（范围可信度 0.3 已是最小分量）—— ' +
      '若这条失败，说明置信度语义变了，请同步更新文档',
  );
  // 但画像**必须**出现在玩家快照的诊断里（否则它连「被记录」都没做到）
  assert.ok(
    b.decision.diagnostics.player !== null &&
      b.decision.diagnostics.player.note.includes('MANIAC'),
    `玩家快照必须记录手选画像，实际：${b.decision.diagnostics.player?.note ?? '（null）'}`,
  );
});

/* ============================================================
 * §71 弃牌回归 / §72 暂离回归 / §73 中途加入回归
 * ============================================================ */

test('§71 Fold 回归：弃牌者下一手回到在座，绝不变成 EMPTY', () => {
  let state = fullTable(Position.CO);
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  state = clickAction(state, 'FOLD', -1); // UTG 弃牌
  state = must(applyTableOp(state, { kind: 'NEXT_HAND' }));

  for (const position of ALL_POSITIONS_6) {
    const seat = seatOfPosition(state, position)!;
    assert.notEqual(seat.status, SeatStatus.EMPTY, `${position} 不得因为上一手弃牌而变成空座`);
    assert.notEqual(seat.playerId, null, `${position} 必须仍绑定玩家`);
  }
});

test('§72 暂离回归：当前手不变、画像保留、重新入座后状态正确', () => {
  let state = fullTable(Position.CO);
  const seat = seatOfPosition(state, Position.BB)!;
  state = must(
    applyTableOp(state, { kind: 'SET_PROFILE', seatId: seat.seatId, quickProfile: 'MANIAC' }),
  );
  const playerId = seatOfPosition(state, Position.BB)!.playerId!;

  state = must(applyTableOp(state, { kind: 'SIT_OUT', seatId: seat.seatId }));
  const out = seatOfPosition(state, Position.BB)!;
  assert.equal(out.status, SeatStatus.SITTING_OUT);
  assert.equal(out.playerId, playerId, '暂离**必须**保留绑定');
  assert.equal(
    state.playersById[playerId]!.quickProfile,
    'MANIAC',
    '暂离**必须**保留画像',
  );

  /*
   * 🔴 **暂离不再是阻断项**（Table Topology Correction）。
   *
   * 旧断言要求暂离产生「无法分析」，理由是「引擎无法把暂离玩家排除在
   * 牌局之外」。现在引擎**能**了：`participantSeatsOf` 直接把暂离座位
   * 排除在本手之外（不发牌、不占盲注），因此 6 座桌 5 人照常可分析。
   *
   * 新断言钉住实质：暂离座位**确实被排除在本手参与者之外**，
   * 并且这件事被如实告知 —— 而不是「能算」却偷偷把暂离的人算进去。
   */
  assert.ok(
    !participantSeatsOf(state).some((s) => s.logicalPosition === Position.BB),
    '暂离座位必须被排除在本手参与者之外（不参与、不发牌、不占盲注）',
  );
  assert.equal(
    staffingProblems(state).length,
    0,
    '暂离只是「本手少一个人」，不再阻断分析',
  );
  assert.ok(
    staffingNotices(state).some((n) => n.includes('暂离中的座位')),
    `暂离必须被如实告知：${staffingNotices(state).join(' / ')}`,
  );

  state = must(applyTableOp(state, { kind: 'SIT_IN', seatId: seat.seatId }));
  const back = seatOfPosition(state, Position.BB)!;
  assert.equal(back.status, SeatStatus.SEATED_ACTIVE, '重新入座后回到 SEATED_ACTIVE');
  assert.equal(back.playerId, playerId, '重新入座后是**同一个**玩家');
  assert.equal(state.playersById[playerId]!.quickProfile, 'MANIAC', '画像保留');
  assert.equal(staffingProblems(state).length, 0);
});

test('§73 中途加入回归：本手进行中，加入玩家必须被拒绝，且不得进入当前手', () => {
  let state = fullTable(Position.CO);
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  assert.equal(state.handActive, true);

  // 人为造出一个「本手进行中 + 空座位」的状态。
  //
  // ⚠️ 正常流程下走不到这里：本手一旦开始，`CLEAR_SEAT` 只会把座位标成
  // `LEAVING_AFTER_HAND`（绑定保留），因此**不会**出现空座位。
  // 但状态可能来自持久化或手工构造的请求，守卫必须在。
  const hjSeatId = seatOfPosition(state, Position.HJ)!.seatId;
  const crafted: PokerTableState = Object.freeze({
    ...state,
    seats: Object.freeze(
      state.seats.map((s) =>
        s.seatId === hjSeatId
          ? Object.freeze({ ...s, playerId: null, status: SeatStatus.EMPTY })
          : s,
      ),
    ),
  });

  const added = applyTableOp(crafted, { kind: 'ADD_PLAYER', seatId: hjSeatId });
  assert.equal(added.ok, false, '本手进行中不能加入玩家');
  if (added.ok) return;
  assert.equal(added.issues[0]!.code, 'HAND_ACTIVE');

  // 关键：拒绝之后，行动队列里绝不能出现新玩家
  const view = engineViewOf({ ...crafted, seats: state.seats });
  assert.equal(view.ok, true);
  if (!view.ok) return;
  assert.equal(view.engine.players.length, 6, '牌局里仍然只有原来的 6 个人');
  assert.ok(
    view.engine.players.every((p) => p.position !== undefined),
    '每个玩家都必须有明确位置',
  );
});

test('§73 补充：正常流程下，本手进行中离桌的座位**不是**空座位（因此无法中途加入）', () => {
  let state = fullTable(Position.CO);
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  const seatId = seatOfPosition(state, Position.HJ)!.seatId;
  const after = must(
    applyTableOp(state, {
      kind: 'CLEAR_SEAT',
      seatId,
      activeHandChoice: ActiveHandLeaveChoice.LEAVE_AFTER_HAND,
    }),
  );
  const seat = seatOfPosition(after, Position.HJ)!;
  assert.notEqual(seat.playerId, null, '手后离桌期间绑定必须保留 —— 因此不存在「中途空座位」');
  const attempt = applyTableOp(after, { kind: 'ADD_PLAYER', seatId });
  assert.equal(attempt.ok, false, '座位仍被占用，加入必须被拒绝');
});

/* ============================================================
 * §74 / §75 筹码与底池守恒
 * ============================================================ */

test('§74/§75：弃牌 / 离桌 / 暂离 / 换人都不改变已进入底池的投入', () => {
  let state = fullTable(Position.CO);
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  state = clickAction(state, 'RAISE'); // UTG 加注

  /** 从**引擎**读出底池与各座位的投入（这是唯一算数的口径） */
  const engineSnapshot = (s: PokerTableState) => {
    const view = engineViewOf(s);
    assert.equal(view.ok, true, `引擎重放必须成功：${view.ok ? '' : JSON.stringify(view.issues)}`);
    if (!view.ok) throw new Error('unreachable');
    return {
      pot: view.engine.players.reduce(
        (sum, p) => sum + Object.values(p.committedByStreet).reduce((a, b) => a + b, 0) + p.ante,
        0,
      ),
      commits: JSON.stringify(
        view.engine.players
          .map((p) => [
            p.position,
            Object.values(p.committedByStreet).reduce((a, b) => a + b, 0),
          ])
          .sort(),
      ),
      historyLength: view.engine.actions.length,
    };
  };

  /** 不看引擎也能验证的部分：行动历史与座位筹码（结构不变性） */
  const structuralSnapshot = (s: PokerTableState) =>
    JSON.stringify([s.actionHistory, s.seats.map((x) => [x.logicalPosition, x.stackBB])]);

  const before = engineSnapshot(state);
  const structBefore = structuralSnapshot(state);

  // ---- 手后离桌 ----
  let s2 = must(
    applyTableOp(state, {
      kind: 'CLEAR_SEAT',
      seatId: seatOfPosition(state, Position.UTG)!.seatId,
      activeHandChoice: ActiveHandLeaveChoice.LEAVE_AFTER_HAND,
    }),
  );
  assert.deepEqual(engineSnapshot(s2), before, '手后离桌不得改变底池与投入（引擎口径）');

  // ---- 暂离（本手进行中）：**只标记下一手**，当前手与引擎状态完全不变 ----
  //
  // 🔴 红队命中过这里：修复前无论本手是否进行都直接标 `SITTING_OUT`，
  // 而冻结的 Poker Core 要求「N 人桌恰好 N 位玩家」→ 牌局无法重建 →
  // 当前行动者变 null、行动按钮消失，**这一手在界面上再也录不下去**。
  // 那与「暂离只影响下一手」正好相反（规范第 53 条）。
  const sbSeatId = seatOfPosition(s2, Position.SB)!.seatId;
  const s3 = must(applyTableOp(s2, { kind: 'SIT_OUT', seatId: sbSeatId }));
  assert.equal(
    engineViewOf(s3).ok,
    true,
    '本手进行中暂离**不得**让牌局无法重建（否则当前手就录不下去了）',
  );
  assert.deepEqual(engineSnapshot(s3), before, '暂离不得改变底池与投入');
  assert.equal(
    seatOfPosition(s3, Position.SB)!.sitOutNextHand,
    true,
    '暂离必须记在「下一手」标记上',
  );
  assert.equal(
    seatOfPosition(s3, Position.SB)!.status,
    SeatStatus.SEATED_ACTIVE,
    '本手期间座位状态必须保持「在座」—— 人还在这手牌里',
  );
  assert.equal(
    staffingProblems(s3).length,
    0,
    '「下一手暂离」不得让当前手变成无法分析',
  );

  // 下一手：这时才真正暂离
  const s4 = must(applyTableOp(s3, { kind: 'NEXT_HAND' }));
  assert.equal(
    seatOfPosition(s4, Position.SB)!.status,
    SeatStatus.SITTING_OUT,
    '下一手开始时暂离才真正生效',
  );
  assert.equal(engineViewOf(s4).ok, false, '暂离生效后必须拒绝重建（否则会把他当成在场玩家）');

  // 重新入座 → 暂离相关的阻塞必须消失
  const s5 = must(applyTableOp(s4, { kind: 'SIT_IN', seatId: sbSeatId }));
  assert.ok(
    !staffingProblems(s5).some((p) => p.includes('暂离')),
    `重新入座后不得再有「暂离」阻塞：${staffingProblems(s5).join(' / ')}`,
  );
  assert.equal(seatOfPosition(s5, Position.SB)!.sitOutNextHand, false);
  /*
   * ⚠️ 此时 UTG 仍是空座（本手期间他标了「手后离桌」，NEXT_HAND 已把他清空）。
   *
   * 🔴 旧断言要求它「必须阻断分析」。**Table Topology Correction 之后不再阻断** ——
   * 6 座桌剩 5 人正是本轮要支持的常态。断言改为钉住实质：
   * 空座确实被排除在本手之外，且被如实告知（而不是既不发牌又不吭声）。
   */
  assert.ok(
    !participantSeatsOf(s5).some((s) => s.logicalPosition === Position.UTG),
    'UTG 手后离桌后必须被排除在本手参与者之外',
  );
  assert.equal(
    staffingProblems(s5).length,
    0,
    'UTG 空座不得阻断分析（5 人参与即可成局）',
  );
  assert.ok(
    staffingNotices(s5).some((n) => n.includes('枪口位')),
    `空座必须被如实告知：${staffingNotices(s5).join(' / ')}`,
  );

  // ---- 本手进行中禁止改筹码（否则筹码守恒会被破坏） ----
  const setStackResult = applyTableOp(s2, {
    kind: 'SET_STACK',
    seatId: seatOfPosition(s2, Position.BB)!.seatId,
    stackBB: 50,
  });
  assert.equal(setStackResult.ok, false, '本手进行中改筹码必须被拒绝');
  assert.deepEqual(engineSnapshot(s2), before, '被拒绝的操作不得留下任何副作用');
});

/* ============================================================
 * Undo（§37 / §38）
 * ============================================================ */

test('§37/§38：撤销必须恢复座位绑定与玩家状态，而不只是界面', () => {
  let state = fullTable(Position.CO);
  const seat = seatOfPosition(state, Position.HJ)!;
  state = must(
    applyTableOp(state, { kind: 'SET_PROFILE', seatId: seat.seatId, quickProfile: 'MANIAC' }),
  );
  const playerId = seatOfPosition(state, Position.HJ)!.playerId!;

  // 清空座位（人走了）
  state = must(applyTableOp(state, { kind: 'CLEAR_SEAT', seatId: seat.seatId }));
  assert.equal(seatOfPosition(state, Position.HJ)!.playerId, null);

  // 撤销 → 绑定与画像都要回来
  state = must(applyTableOp(state, { kind: 'UNDO' }));
  const restored = seatOfPosition(state, Position.HJ)!;
  assert.equal(restored.playerId, playerId, '撤销必须恢复 seat → playerId 绑定');
  assert.equal(restored.status, SeatStatus.SEATED_ACTIVE);
  assert.equal(
    state.playersById[playerId]!.quickProfile,
    'MANIAC',
    '撤销必须恢复玩家画像',
  );
});

test('§38：撤销「玩家离桌」必须同时恢复绑定与本手状态', () => {
  let state = fullTable(Position.CO);
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  state = clickAction(state, 'RAISE');
  const seatId = seatOfPosition(state, Position.UTG)!.seatId;
  const playerId = seatOfPosition(state, Position.UTG)!.playerId!;
  const historyLength = state.actionHistory.length;
  const potBefore = preview(state).potBB;

  state = must(
    applyTableOp(state, {
      kind: 'CLEAR_SEAT',
      seatId,
      activeHandChoice: ActiveHandLeaveChoice.LEAVE_AFTER_HAND,
    }),
  );
  assert.equal(seatOfPosition(state, Position.UTG)!.status, SeatStatus.LEAVING_AFTER_HAND);

  state = must(applyTableOp(state, { kind: 'UNDO' }));
  const restored = seatOfPosition(state, Position.UTG)!;
  assert.equal(restored.status, SeatStatus.SEATED_ACTIVE, '撤销后离桌标记必须消失');
  assert.equal(restored.playerId, playerId, '撤销后玩家必须回到座位');
  assert.equal(state.actionHistory.length, historyLength, '撤销离桌不得影响行动历史');
  assert.equal(preview(state).potBB, potBefore, '撤销离桌不得影响底池');
});

test('撤销栈深度有限，且撤销到底后如实报错（不静默）', () => {
  let state = fullTable(Position.CO);
  // 一路撤回英雄座位加入之前
  let guard = 0;
  while (state.undo.length > 0 && guard < 500) {
    const result = applyTableOp(state, { kind: 'UNDO' });
    if (!result.ok) break;
    state = result.state;
    guard += 1;
  }
  const nothing = applyTableOp(state, { kind: 'UNDO' });
  assert.equal(nothing.ok, false);
  if (nothing.ok) return;
  assert.equal(nothing.issues[0]!.code, 'NOTHING_TO_UNDO');
});

/* ============================================================
 * 新牌桌（§48）
 * ============================================================ */

test('§48 新牌桌必须清干净：其他座位、Villain 画像、动态、历史', () => {
  let state = fullTable(Position.CO);
  for (const position of [Position.UTG, Position.HJ, Position.BB]) {
    const seat = seatOfPosition(state, position)!;
    state = drive(state, [
      { kind: 'SET_PROFILE', seatId: seat.seatId, quickProfile: 'CALLING_STATION' },
      { kind: 'SET_DYNAMIC_HINT', seatId: seat.seatId, dynamicHint: 'TILT_SIGNAL' },
    ]);
  }
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  state = clickAction(state, 'FOLD', -1);

  const heroPlayerId = state.heroPlayerId;
  state = must(applyTableOp(state, { kind: 'NEW_TABLE' }));

  assert.equal(state.actionHistory.length, 0, '行动历史必须清空');
  assert.equal(state.board.length, 0, '公共牌必须清空');
  assert.equal(state.heroCards.length, 0, '手牌必须清空');
  assert.equal(state.handActive, false);

  for (const position of ALL_POSITIONS_6) {
    const seat = seatOfPosition(state, position)!;
    if (position === Position.CO) {
      assert.equal(seat.playerId, heroPlayerId, 'Hero 必须保留');
      continue;
    }
    assert.equal(seat.status, SeatStatus.EMPTY, `${position} 必须变成空座`);
    assert.equal(seat.playerId, null);
  }
  // 非 Hero 的玩家对象必须被清掉（否则画像会以另一种方式泄漏）
  const others = Object.keys(state.playersById).filter((id) => id !== heroPlayerId);
  assert.deepEqual(others, [], '非 Hero 的玩家对象必须一并清空');
});

/* ============================================================
 * 视觉旋转 ≠ 逻辑位置（§16 / §17 / §18 / §68）
 * ============================================================ */

test('§17 CRITICAL：Hero 视觉固定在底部时，逻辑位置逐位正确', () => {
  const expectedActor: Partial<Record<Position, Position>> = {
    [Position.UTG]: Position.UTG,
    [Position.CO]: Position.UTG,
    [Position.BTN]: Position.UTG,
    [Position.SB]: Position.UTG,
    [Position.BB]: Position.UTG,
  };

  for (const hero of [Position.UTG, Position.CO, Position.BTN, Position.SB, Position.BB]) {
    let state = fullTable(hero);
    state = drive(state, [
      { kind: 'SET_HERO_CARD', card: 'As' },
      { kind: 'SET_HERO_CARD', card: 'Kd' },
    ]);

    const heroSeat = seatOfPosition(state, hero)!;
    assert.equal(heroSeat.visualIndex, 0, `Hero=${hero} 必须固定在视觉 0 号位（6 点钟）`);
    assert.equal(heroSeat.logicalPosition, hero, `Hero=${hero} 的逻辑位置必须是 ${hero}`);

    // 视觉顺序：Hero 在 0 号位，其余按逻辑座位序跟随
    const visual = [...state.seats].sort((a, b) => a.visualIndex - b.visualIndex);
    assert.equal(visual[0]!.logicalPosition, hero, '视觉 0 号位必须是 Hero 的逻辑位置');
    assert.equal(new Set(visual.map((s) => s.visualIndex)).size, 6, '视觉序号必须唯一');

    // 翻牌前第一个行动的永远是 UTG（与 Hero 是谁无关）
    const p = preview(state);
    assert.equal(
      p.currentActorPosition,
      expectedActor[hero],
      `Hero=${hero} 时翻牌前第一个行动的必须是 UTG`,
    );

    // 逻辑位置没有被旋转污染
    const adapted = tableStateToManualHandInput({ ...state, heroCards: ['As', 'Kd'] });
    assert.equal(adapted.ok, true);
    if (!adapted.ok) continue;
    assert.equal(adapted.input.heroPosition, hero, '提交给管线的 heroPosition 必须是逻辑位置');
    assert.equal(adapted.input.tableSize, 6);
  }
});

test('§68 视觉旋转差分：旋转前后送进管线的数据逐位一致', () => {  const build = (hero: Position): ManualHandInput => {
    const state = fullTable(hero);
    const adapted = tableStateToManualHandInput({ ...state, heroCards: ['As', 'Kd'] });
    assert.equal(adapted.ok, true);
    if (!adapted.ok) throw new Error('适配失败');
    return adapted.input;
  };

  // 同一个「逻辑牌局」在不同 Hero 位置下，除了 heroPosition 以外必须完全一致
  const a = build(Position.CO);
  const b = build(Position.BTN);

  assert.equal(a.tableSize, b.tableSize);
  assert.equal(a.street, b.street);
  assert.equal(a.board.length, b.board.length);
  assert.equal(a.actionHistory.length, b.actionHistory.length);
  assert.deepEqual(
    { ...a.seatStacksBB },
    { ...b.seatStacksBB },
    '座位的逻辑筹码不得随 Hero 位置变化',
  );

  // 而 heroPosition 必须如实不同（这才证明旋转没把逻辑位置抹平）
  assert.notEqual(a.heroPosition, b.heroPosition);
});

/* ============================================================
 * 作者自查发现的两个缺陷（永久回归）
 * ============================================================ */

test('自查 A：公共牌必须按顺序填 —— 跳着填不得**静默丢牌**', () => {
  let state = fullTable(Position.CO);
  const before = state.board.length;

  // 直接点第 3 个槽位（跳过前两张）
  const jumped = applyTableOp(state, { kind: 'SET_BOARD_CARD', card: '2d', slot: 2 });
  assert.equal(jumped.ok, false, '跳过前两张直接填第 3 张必须被拒绝');
  if (jumped.ok) return;
  assert.equal(jumped.issues[0]!.code, 'INVALID_CARD');
  assert.ok(
    jumped.issues[0]!.message.includes('按顺序'),
    `必须说清楚要按顺序填：${jumped.issues[0]!.message}`,
  );
  // 关键：**状态不能变**（修复前会把那张牌静默丢掉）
  assert.equal(state.board.length, before, '被拒绝的操作不得改动公共牌');

  // 顺序填是可以的
  state = must(applyTableOp(state, { kind: 'SET_BOARD_CARD', card: 'Kh', slot: 0 }));
  state = must(applyTableOp(state, { kind: 'SET_BOARD_CARD', card: '7c', slot: 1 }));
  state = must(applyTableOp(state, { kind: 'SET_BOARD_CARD', card: '2d', slot: 2 }));
  assert.deepEqual([...state.board], ['Kh', '7c', '2d']);

  // 只能取消最后一张（否则中间会出现空洞）
  const middleCancel = applyTableOp(state, { kind: 'SET_BOARD_CARD', card: '7c', slot: 1 });
  assert.equal(middleCancel.ok, false, '取消中间那张必须被拒绝（会在中间留空洞）');
  const lastCancel = applyTableOp(state, { kind: 'SET_BOARD_CARD', card: '2d', slot: 2 });
  assert.equal(lastCancel.ok, true);
  if (!lastCancel.ok) return;
  assert.deepEqual([...lastCancel.state.board], ['Kh', '7c'], '取消最后一张后应当只剩两张');
});

test('自查 B：「取消」离桌决策不得消耗一次撤销机会', () => {
  let state = fullTable(Position.CO);
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  state = clickAction(state, 'RAISE');
  const seatId = seatOfPosition(state, Position.UTG)!.seatId;

  const undoDepth = state.undo.length;
  const revision = state.revision;

  const cancelled = applyTableOp(state, {
    kind: 'CLEAR_SEAT',
    seatId,
    activeHandChoice: ActiveHandLeaveChoice.CANCEL,
  });
  assert.equal(cancelled.ok, true);
  if (!cancelled.ok) return;

  assert.equal(cancelled.state.undo.length, undoDepth, '取消不得往撤销栈里压记录');
  assert.equal(cancelled.state.revision, revision, '取消不得改变版本号');
  assert.equal(
    JSON.stringify(cancelled.state.seats),
    JSON.stringify(state.seats),
    '取消不得改动任何座位',
  );
});

test('自查 C：全下必须能无损往返（金额换算经过引擎与重放两次）', () => {
  let state = fullTable(Position.CO, 37); // 非整百筹码，专挑换算边界
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);

  // UTG 全下
  const view = engineViewOf(state);
  assert.equal(view.ok, true);
  if (!view.ok) return;
  const utg = view.engine.players.find((p) => p.position === Position.UTG)!;
  const allIn = applyTableOp(state, {
    kind: 'ACT',
    action: { type: 'ALL_IN', amountChips: utg.remainingStack },
  });
  assert.equal(allIn.ok, true, `全下必须被接受：${allIn.ok ? '' : JSON.stringify(allIn.issues)}`);
  if (!allIn.ok) return;
  state = allIn.state;

  // 重放必须与磁盘上的历史一致 —— 逐位
  const replay = engineViewOf(state);
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  const replayed = replay.engine.players.find((p) => p.position === Position.UTG)!;
  assert.equal(replayed.allIn, true, '重放后仍然是全下');
  assert.equal(replayed.remainingStack, 0, '重放后剩余筹码必须是 0');
  assert.equal(
    replayed.committedByStreet.PREFLOP,
    utg.remainingStack,
    '重放后的投入必须等于当时投入的全部筹码',
  );

  // 记录下来的动作：ALL_IN **刻意不带金额**。
  //
  // 🔴 红队 V-ALLIN 命中过这里：`doAllIn` 要求 `amount` 等于**本次投入的
  //    剩余筹码**，而 `ManualAction` 的文档曾写「加注到的本街总额」。
  //    对已经投入过筹码的玩家（小盲、跟注后再加注的人），两者不等，
  //    于是「点全下」会被 `ALLIN_AMOUNT_MISMATCH` 拒绝。
  //    不带金额时由引擎自己算 `need`，任何情况下都正确。
  const recorded = state.actionHistory[state.actionHistory.length - 1]!;
  assert.equal(recorded.type, 'ALL_IN');
  assert.equal(
    recorded.amountBB,
    undefined,
    'ALL_IN 不得记录金额 —— 引擎只接受「本次投入的剩余筹码」，写成本街总额会算错',
  );

  // 从外部再验一次重放等价（不依赖 tableOps 内部的自检）
  const replayAgain = engineViewOf(state);
  assert.equal(replayAgain.ok, true);
  if (!replayAgain.ok) return;
  assert.equal(
    stateFingerprintOf(replayAgain.engine),
    stateFingerprintOf(replay.engine),
    '两次独立重放必须逐位一致',
  );
});
test('自查 D：重置本手必须把「手后离桌」真正落定（不留卡死的座位）', () => {
  let state = fullTable(Position.CO);
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  const seatId = seatOfPosition(state, Position.HJ)!.seatId;
  state = must(
    applyTableOp(state, {
      kind: 'CLEAR_SEAT',
      seatId,
      activeHandChoice: ActiveHandLeaveChoice.LEAVE_AFTER_HAND,
    }),
  );
  assert.equal(seatOfPosition(state, Position.HJ)!.status, SeatStatus.LEAVING_AFTER_HAND);

  const reset = must(applyTableOp(state, { kind: 'RESET_HAND' }));
  const hj = seatOfPosition(reset, Position.HJ)!;

  assert.equal(hj.status, SeatStatus.EMPTY, '重置本手后「手后离桌」必须落定');
  assert.equal(hj.playerId, null, '座位必须真正解除绑定');
  assert.equal(reset.handActive, false);
  assert.equal(reset.actionHistory.length, 0);
  assert.ok(
    reset.notices.some((n) => n.includes('手后离桌')),
    '必须提示使用者座位被一并清空',
  );

  // 落定之后这个座位可以正常加入新玩家（不再卡死）
  const added = applyTableOp(reset, { kind: 'ADD_PLAYER', seatId });
  assert.equal(added.ok, true, '落定后应当可以加入新玩家');
});

test('自查 D2：重置本手**不得**影响暂离（那是跨手意图，与本手录错无关）', () => {
  let state = fullTable(Position.CO);
  const seatId = seatOfPosition(state, Position.BB)!.seatId;
  const playerId = seatOfPosition(state, Position.BB)!.playerId!;
  state = must(applyTableOp(state, { kind: 'SIT_OUT', seatId }));
  state = must(applyTableOp(state, { kind: 'RESET_HAND' }));

  const bb = seatOfPosition(state, Position.BB)!;
  assert.equal(bb.status, SeatStatus.SITTING_OUT, '暂离必须保持不变');
  assert.equal(bb.playerId, playerId, '暂离的绑定必须保留');
});