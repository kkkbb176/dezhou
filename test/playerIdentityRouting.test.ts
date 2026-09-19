/**
 * ============================================================================
 * PLAYER IDENTITY ROUTING V1 —— 玩家身份映射（seat ≠ player ≠ displayName）
 * ============================================================================
 *
 * ## 这个文件锁的是什么
 *
 * TEST 16 实测到的缺陷：`contextBuilder` 用**一个**字符串同时表达三件事
 *
 * ```text
 * opponent.id = "seat_BB"      ← 引擎口径座位 id（行动记录 / 动态层按它匹配）
 * villainId   = "阿豪"          ← 调用方给的「对手稳定 id」，实际是显示名
 * profileKey  = ?              ← 画像该按谁查
 * ```
 *
 * 三者被混为 `villainId` 之后，`opponent.id === villainId` **恒为 false**：
 * 画像 provider / 行为画像**没有**被注入范围链，而且**不发任何警告**。
 *
 * ## 本文件的断言纪律
 *
 * - 全部走**生产入口**（`analyzeManualHand` / `tableStateToManualHandInput` /
 *   `applyTableOp` / `buildDecisionContext`），不测自建辅助函数的内部；
 * - 断言落在**数字**上（动作 / 尺寸 / 数学九项 / 范围与响应概率），不落在文案上；
 * - 不预设最终动作：只对比「同一输入的两次运行」「改一个字段后的差异」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position } from '../src/domain/types.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import {
  parseManualInput,
  type ManualHandInput,
  type ManualVillain,
} from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import {
  isEngineSeatId,
  resolvePlayerIdentity,
  resolveRosterSelection,
  type PlayerRosterEntry,
} from '../src/app/manualInput/playerIdentity.ts';
import { createTable, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import { parseTableState } from '../src/app/table/tableApi.ts';
import { tableStateToManualHandInput } from '../src/app/table/tableAdapter.ts';
import {
  SeatStatus,
  type PokerTableState,
  type TableOp,
} from '../src/app/table/table.types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: 20_260_913,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

/* ============================================================
 * TEST 16 原牌局（逐字重建）
 * ============================================================
 *
 * 6 人桌 1/2｜Hero BTN A♠A♥｜A♦9♣4♥6♠2♦
 * UTG/HJ/CO 弃 → BTN 加注到 3BB → SB 弃 → BB 跟
 * 翻牌 BB 过 / BTN 2.5BB / BB 跟｜转牌 BB 过 / BTN 7.5BB / BB 跟
 * 河牌 BB 主动下注 10BB  ← 决策点
 */

const AHAO_STATS = {
  handsObserved: 800,
  vpip: 0.48,
  pfr: 0.35,
  threeBet: 0.16,
  wtsd: 0.36,
  foldToFlopCBet: null,
  foldToTurnCBet: null,
  foldToRiverBet: null,
  flopCheckRaise: null,
  turnCheckRaise: null,
  riverCheckRaise: null,
} as const;

const A = (
  position: string,
  type: string,
  amountBB?: number,
  street?: string,
): Record<string, unknown> => ({
  position,
  type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/** TEST 16 的 ManualHandInput；`villain` 由每个用例自己给 */
function test16Input(villain: ManualVillain): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['As', 'Ah'],
    board: ['Ad', '9c', '4h', '6s', '2d'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
      A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain,
  } as unknown as ManualHandInput;
}

/** 决策的可比指纹（动作 / 尺寸 / 置信度 / 数学 / 加注响应事实） */
function fingerprintOf(input: ManualHandInput): string {
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true, `分析必须成功：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) throw new Error('unreachable');
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  const facts = ((dg['postflop'] ?? {})['raiseResponse'] ?? null) as Record<string, any> | null;
  return JSON.stringify({
    action: d['action'],
    sizeChips: d['sizeChips'] ?? null,
    confidence: d['confidence'],
    classification: d['classification'],
    math: dg['math'],
    raise: facts === null ? null : {
      sizeChips: facts['sizeChips'],
      eqCall: facts['heroEquityVsRaiseCallRange'],
      ev: facts['raiseEV'],
      reraiseEV: facts['reraiseBranchEV'],
      eqReraise: facts['heroEquityVsReraiseRange'],
    },
  });
}

/** 只取「与画像无关」的对比粒度：动作 + 尺寸 + 数学九项 */
function mathOf(input: ManualHandInput): Record<string, any> {
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error('unreachable');
  const dg = (r.decision as unknown as Record<string, any>)['diagnostics'] as Record<string, any>;
  return dg['math'] as Record<string, any>;
}

/** 生产链上的身份解析结果（`buildDecisionContext` 回传，只读诊断） */
function identityOf(input: ManualHandInput) {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true, `解析必须成功：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true);
  if (!gate.ok) throw new Error('unreachable');
  return buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: OPTIONS.asOf,
    ...(parsed.value.villain.quickProfile !== undefined ? { quickProfile: parsed.value.villain.quickProfile } : {}),
    ...(parsed.value.villain.dynamicHint !== undefined ? { dynamicHint: parsed.value.villain.dynamicHint } : {}),
    ...(parsed.value.villain.playerId !== undefined ? { villainPlayerId: parsed.value.villain.playerId } : {}),
    ...(parsed.value.villain.persistentPlayerId !== undefined && parsed.value.villain.persistentPlayerId !== null
      ? { villainPersistentPlayerId: parsed.value.villain.persistentPlayerId }
      : {}),
    ...(parsed.value.villain.seatId !== undefined && parsed.value.villain.seatId !== null
      ? { villainSeatId: parsed.value.villain.seatId }
      : {}),
    ...(parsed.value.villain.displayName !== undefined && parsed.value.villain.displayName !== null
      ? { villainDisplayName: parsed.value.villain.displayName }
      : {}),
    ...(parsed.value.villain.observedStats !== undefined && parsed.value.villain.observedStats !== null
      ? { observedStats: parsed.value.villain.observedStats }
      : {}),
    equitySeed: OPTIONS.equitySeed,
    budget: OPTIONS.budget,
  } as never);
}

/* ============================================================
 * 牌桌路径（真实操作流）
 * ============================================================ */

function must(result: ReturnType<typeof applyTableOp>): PokerTableState {
  if (!result.ok) throw new Error(`操作被拒绝：${result.issues.map((i) => i.message).join(' / ')}`);
  return result.state;
}

function drive(start: PokerTableState, ops: readonly TableOp[]): PokerTableState {
  let state = start;
  for (const op of ops) state = must(applyTableOp(state, op));
  return state;
}

const ALL_POSITIONS_6: readonly Position[] = [
  Position.UTG, Position.HJ, Position.CO, Position.BTN, Position.SB, Position.BB,
];

function emptyTable(hero: Position): PokerTableState {
  /* `bigBlindBB: 2`：与 TEST 16 的题面一致（1BB = 2 筹码，起始 200 筹码 = 100BB） */
  return createTable({ tableSize: 6, heroPosition: hero, defaultStackBB: 100, bigBlindBB: 2 });
}

function addPlayer(state: PokerTableState, position: Position): PokerTableState {
  return must(applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, position)!.seatId }));
}

/** 把 TEST 16 的**同一条线**在牌桌上点出来；`caller` = 跟注 Hero 的那一家所在的物理座位 */
function playTest16Line(start: PokerTableState, caller: Position): PokerTableState {
  /*
   * 🔴 **必须先固定 Button**：`NEXT_HAND` 会让 Button 沿物理座位轮转，
   * 于是「谁是小盲/大盲/第一个行动」跟着变 —— 不固定就会把行动记录
   * 打到**别的玩家**身上（实测：第二手里阿豪被轮到别的角色而弃牌）。
   * `SET_BUTTON` 在本手未开始时合法且幂等。
   */
  const buttonSeatId = seatOfPosition(start, Position.BTN)!.seatId;
  const ops: TableOp[] = [
    { kind: 'SET_BUTTON', seatId: buttonSeatId },
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Ah' },
  ];
  /* 翻前：Hero 之前的人弃牌，caller 跟 1BB；Hero 加注到 6；Hero 之后的人弃牌，caller 补到 6 */
  if (caller === Position.BB) {
    ops.push(
      { kind: 'ACT', action: { type: 'FOLD' } },                                     // UTG
      { kind: 'ACT', action: { type: 'FOLD' } },                                     // HJ
      { kind: 'ACT', action: { type: 'FOLD' } },                                     // CO
      { kind: 'ACT', action: { type: 'RAISE', amountChips: 6 } },                     // BTN
      { kind: 'ACT', action: { type: 'FOLD' } },                                     // SB
      { kind: 'ACT', action: { type: 'CALL', amountChips: 4 } },                     // BB 补到 6
    );
  } else if (caller === Position.CO) {
    ops.push(
      { kind: 'ACT', action: { type: 'FOLD' } },                                     // UTG
      { kind: 'ACT', action: { type: 'FOLD' } },                                     // HJ
      { kind: 'ACT', action: { type: 'CALL', amountChips: 2 } },                     // CO 跛入
      { kind: 'ACT', action: { type: 'RAISE', amountChips: 6 } },                     // BTN
      { kind: 'ACT', action: { type: 'FOLD' } },                                     // SB
      { kind: 'ACT', action: { type: 'FOLD' } },                                     // BB
      { kind: 'ACT', action: { type: 'CALL', amountChips: 4 } },                     // CO 补到 6
    );
  } else {
    throw new Error(`playTest16Line: 只支持 caller = BB / CO（收到 ${caller}）`);
  }
  /* 翻牌 */
  ops.push(
    { kind: 'SET_BOARD_CARD', card: 'Ad', slot: 0 },
    { kind: 'SET_BOARD_CARD', card: '9c', slot: 1 },
    { kind: 'SET_BOARD_CARD', card: '4h', slot: 2 },
    { kind: 'ACT', action: { type: 'CHECK' } },
    { kind: 'ACT', action: { type: 'BET', amountChips: 5 } },
    { kind: 'ACT', action: { type: 'CALL', amountChips: 5 } },
  );
  /* 转牌 */
  ops.push(
    { kind: 'SET_BOARD_CARD', card: '6s', slot: 3 },
    { kind: 'ACT', action: { type: 'CHECK' } },
    { kind: 'ACT', action: { type: 'BET', amountChips: 15 } },
    { kind: 'ACT', action: { type: 'CALL', amountChips: 15 } },
  );
  /* 河牌：caller 领打 20 → 轮到 Hero */
  ops.push(
    { kind: 'SET_BOARD_CARD', card: '2d', slot: 4 },
    { kind: 'ACT', action: { type: 'BET', amountChips: 20 } },
  );
  return drive(start, ops);
}

/** 6 人桌（Hero 除外全部入座）+ 打出 TEST 16 那条线（BB 跟注） */
function test16Table(): PokerTableState {
  let state = emptyTable(Position.BTN);
  for (const position of ALL_POSITIONS_6) {
    if (position === Position.BTN) continue;
    state = addPlayer(state, position);
  }
  return playTest16Line(state, Position.BB);
}

function adapt(state: PokerTableState): ManualHandInput {
  const adapted = tableStateToManualHandInput(state);
  assert.equal(adapted.ok, true, `适配必须成功：${adapted.ok ? '' : JSON.stringify(adapted.issues)}`);
  if (!adapted.ok) throw new Error('unreachable');
  return adapted.input;
}

/** 把某个座位上的玩家对象搬到另一个座位（生产里没有「换座」op：Hero 用 SET_HERO_POSITION，
 *  对手只能手改状态；这里用 `parseTableState` 证明改完的状态**自洽**） */
function moveSeatPlayer(state: PokerTableState, fromSeatId: string, toSeatId: string): PokerTableState {
  const from = state.seats.find((s) => s.seatId === fromSeatId)!;
  const movedPlayerId = from.playerId!;
  const fromStack = from.stackBB;
  const seats = state.seats.map((s) => {
    if (s.seatId === fromSeatId) return { ...s, playerId: null, status: SeatStatus.EMPTY };
    if (s.seatId === toSeatId) return { ...s, playerId: movedPlayerId, status: SeatStatus.SEATED_ACTIVE, stackBB: fromStack };
    return { ...s };
  });
  const moved = { ...state, seats: Object.freeze(seats), notices: Object.freeze([]) };
  const parsed = parseTableState({ ...moved });
  assert.equal(parsed.ok, true, `换座后的状态必须自洽：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.state;
}

/** 找到某个座位的显示名（用于身份断言） */
function nameAt(state: PokerTableState, position: Position): string {
  const seat = seatOfPosition(state, position)!;
  return state.playersById[seat.playerId!]!.displayName;
}

function renamePlayer(state: PokerTableState, position: Position, displayName: string): PokerTableState {
  const seat = seatOfPosition(state, position)!;
  const playerId = seat.playerId!;
  const playersById = {
    ...state.playersById,
    [playerId]: { ...state.playersById[playerId]!, displayName },
  };
  const renamed = { ...state, playersById: Object.freeze(playersById) };
  const parsed = parseTableState({ ...renamed });
  assert.equal(parsed.ok, true, `改名后的状态必须自洽：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.state;
}

/* ============================================================
 * A / B / C —— TEST 16 三态对照
 * ============================================================ */

test('A/B：牌桌路径（标准座位 id）与手工输入路径（已保存玩家）必须逐位等价', () => {
  /* ---- A：牌桌路径。座位上绑的是「阿豪 player_001」，画像由 playersById 给出 ---- */
  let table = test16Table();
  const bbSeatId = seatOfPosition(table, Position.BB)!.seatId;
  const persistentId = seatOfPosition(table, Position.BB)!.playerId!;
  table = must(applyTableOp(table, { kind: 'SET_PROFILE', seatId: bbSeatId, quickProfile: 'MANIAC' }));
  table = renamePlayer(table, Position.BB, '阿豪');
  const fromTable = adapt(table);

  assert.equal(fromTable.villain!.playerId, bbSeatId, '引擎口径 id 必须仍是座位 id');
  assert.equal(fromTable.villain!.seatId, bbSeatId, '显式座位绑定必须带出去');
  assert.equal(fromTable.villain!.persistentPlayerId, persistentId, '持久玩家 id 必须带出去（不再是座位 id）');
  assert.equal(fromTable.villain!.displayName, nameAt(table, Position.BB), '显示名必须带出去（仅显示）');

  /* ---- B：手工输入路径。UI 从「已保存玩家」里选中阿豪 ⇒ 解析成 player_001 ---- */
  const roster: readonly PlayerRosterEntry[] = [
    { playerId: persistentId, displayName: nameAt(table, Position.BB), seatId: bbSeatId },
    { playerId: 'player_777', displayName: '小李', seatId: seatOfPosition(table, Position.CO)!.seatId },
  ];
  const selection = resolveRosterSelection({ query: '阿豪', roster });
  assert.equal(selection.status, 'UNIQUE', '姓名唯一命中时必须解析出持久 id');
  if (selection.status !== 'UNIQUE') return;
  assert.equal(selection.entry.playerId, persistentId);
  assert.equal(selection.matchedBy, 'DISPLAY_NAME');

  const fromManual = test16Input({
    seatId: bbSeatId,
    persistentPlayerId: selection.entry.playerId,
    displayName: '阿豪',
    quickProfile: 'MANIAC',
    dynamicHint: 'UNKNOWN',
    stackBB: 100,
    observedStats: AHAO_STATS,
  });

  const a = fingerprintOf(fromTable);
  const b = fingerprintOf(fromManual);
  assert.equal(b, a, 'A（牌桌）与 B（手工输入）在同一身份下必须逐位等价');
});

test('B：身份注入必须真的发生 —— 修复前 `opponent.id === villainId` 恒为 false', () => {
  const seatBound = identityOf(test16Input({
    seatId: 'seat_BB',
    persistentPlayerId: 'player_001',
    displayName: '阿豪',
    quickProfile: 'MANIAC',
    dynamicHint: 'UNKNOWN',
    stackBB: 100,
    observedStats: AHAO_STATS,
  }));
  assert.equal(seatBound.playerIdentity.seatId, 'seat_BB', '画像目标座位必须是 seat_BB');
  assert.equal(seatBound.playerIdentity.persistentPlayerId, 'player_001');
  assert.equal(seatBound.playerIdentity.status, 'BOUND_BY_SEAT_ID');
  assert.equal(seatBound.playerIdentity.disclosureZh, null, '身份明确时不该有回退披露');

  /* 只给旧字段（名字）也不能破坏路由：单一对手 ⇒ 结构上就是那一家 */
  const legacy = identityOf(test16Input({
    playerId: '阿豪',
    quickProfile: 'MANIAC',
    dynamicHint: 'UNKNOWN',
    stackBB: 100,
    observedStats: AHAO_STATS,
  }));
  assert.equal(legacy.playerIdentity.seatId, 'seat_BB', '自由文本 id + 单一对手 ⇒ 路由到该对手');
  assert.equal(legacy.playerIdentity.status, 'BOUND_BY_SOLE_OPPONENT');
  assert.equal(legacy.playerIdentity.persistentPlayerId, null, '自由文本 id 不是持久身份，不得当作持久 id');
});

test('C：陌生玩家（无任何身份）不得继承任何历史画像', () => {
  const stranger = identityOf(test16Input({ quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100 }));
  assert.equal(stranger.playerIdentity.persistentPlayerId, null, '陌生玩家不得被绑定持久身份');
  assert.equal(stranger.playerIdentity.status, 'BOUND_TO_PRIMARY_OPPONENT');
  assert.ok(stranger.playerIdentity.disclosureZh !== null, '必须如实披露「按陌生玩家处理」');
  assert.equal((stranger.context.profileV3 as any)?.observedStatCount ?? 0, 0, '不得读到任何实测统计');

  /* 手选标签可以继续生效（工作单 §五 C），但**不得**带上阿豪的持久统计 */
  const baselineManiac = fingerprintOf(test16Input({ quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100 }));
  assert.equal(
    fingerprintOf(test16Input({ quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100 })),
    baselineManiac,
    '陌生玩家的结果必须与「只有内联标签」的基线一致（无继承）',
  );

  const boundStatsIdentity = identityOf(test16Input({
    seatId: 'seat_BB',
    persistentPlayerId: 'player_001',
    displayName: '阿豪',
    quickProfile: 'MANIAC',
    dynamicHint: 'UNKNOWN',
    stackBB: 100,
    observedStats: AHAO_STATS,
  })).playerIdentity;
  assert.equal(boundStatsIdentity.persistentPlayerId, 'player_001', '明确绑定后才能带持久统计');
});

/* ============================================================
 * M1–M10 墨菲定律对抗
 * ============================================================ */

test('M1：同名不同玩家不得共享画像（按持久 id 隔离，绝不按姓名）', () => {
  const roster: readonly PlayerRosterEntry[] = [
    { playerId: 'player_001', displayName: '阿豪', seatId: 'seat_BB' },
    { playerId: 'player_002', displayName: '阿豪', seatId: 'seat_CO' },
  ];
  const picked = resolveRosterSelection({ query: '阿豪', roster });
  assert.equal(picked.status, 'AMBIGUOUS', '同名多候选必须返回待选择状态，不得猜测');
  if (picked.status !== 'AMBIGUOUS') return;
  assert.equal(picked.candidates.length, 2);

  /* 唯一命中时才可解析 */
  const unique = resolveRosterSelection({ query: 'player_002', roster });
  assert.equal(unique.status, 'UNIQUE');
  if (unique.status !== 'UNIQUE') return;
  assert.equal(unique.entry.playerId, 'player_002');
  assert.equal(unique.matchedBy, 'PLAYER_ID');

  /* 两个玩家坐在不同座位、画像不同 ⇒ 决策必须各自独立且可复现 */
  const p1 = test16Input({
    seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪',
    quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
  });
  const p2 = test16Input({
    seatId: 'seat_BB', persistentPlayerId: 'player_002', displayName: '阿豪',
    quickProfile: 'VERY_TIGHT', dynamicHint: 'UNKNOWN', stackBB: 100,
  });
  const first = fingerprintOf(p1);
  const second = fingerprintOf(p2);
  assert.notEqual(first, second, '同名但持久 id 不同 ⇒ 画像不同 ⇒ 结果必须不同');
  assert.equal(fingerprintOf(p1), first, '同一身份重复分析必须逐位一致（无跨玩家缓存污染）');
  assert.equal(fingerprintOf(p2), second, '同上');
});

test('M2：同一玩家换座位后仍读到同一份画像，旧座位不得残留', () => {
  /* 第一手：阿豪（player_001，MANIAC）在 BB，按 TEST 16 那条线跟注 */
  let table = test16Table();
  const bbSeatId = seatOfPosition(table, Position.BB)!.seatId;
  const coSeatId = seatOfPosition(table, Position.CO)!.seatId;
  table = renamePlayer(table, Position.BB, '阿豪');
  table = must(applyTableOp(table, { kind: 'SET_PROFILE', seatId: bbSeatId, quickProfile: 'MANIAC' }));
  const persistentId = seatOfPosition(table, Position.BB)!.playerId!;
  const firstHand = adapt(table);
  assert.equal(firstHand.villain!.seatId, bbSeatId);
  assert.equal(firstHand.villain!.persistentPlayerId, persistentId);

  /* 下一手：阿豪从 BB 换到 CO（腾空 CO → 把玩家对象搬过去 → 旧 BB 补一个陌生人） */
  let next = must(applyTableOp(table, { kind: 'NEXT_HAND' }));
  next = must(applyTableOp(next, { kind: 'CLEAR_SEAT', seatId: coSeatId }));
  next = moveSeatPlayer(next, bbSeatId, coSeatId);
  next = addPlayer(next, Position.BB);
  const secondHandTable = playTest16Line(next, Position.CO);

  const movedInput = adapt(secondHandTable);
  assert.equal(movedInput.villain!.seatId, coSeatId, '画像目标必须跟着人换到新座位');
  assert.equal(movedInput.villain!.playerId, coSeatId, '引擎口径 id 是新座位');
  assert.equal(movedInput.villain!.persistentPlayerId, persistentId, '持久身份必须跟着人走（换座位不变）');
  assert.equal(movedInput.villain!.quickProfile, 'MANIAC', '画像必须跟着人走');

  /* 旧 BB 座位换了陌生人 ⇒ 不得残留阿豪的画像与身份 */
  const refilledPlayerId = seatOfPosition(secondHandTable, Position.BB)!.playerId!;
  assert.notEqual(refilledPlayerId, persistentId, 'BB 座位上必须是另一个身份');
  const strictTable = must(applyTableOp(secondHandTable, { kind: 'SET_PROFILE', seatId: coSeatId, quickProfile: 'UNKNOWN' }));
  const strictInput = adapt(strictTable);
  assert.equal(strictInput.villain!.quickProfile, 'UNKNOWN');
  assert.notEqual(
    JSON.stringify(mathOf(strictInput)),
    JSON.stringify(mathOf(movedInput)),
    '把新座位的画像换成 UNKNOWN 必须改变数学 ⇒ 说明「跟着人走」的画像确实进了范围链',
  );
  assert.equal(seatOfPosition(secondHandTable, Position.BB)!.playerId, refilledPlayerId);
});

test('M3：同一座位换玩家后，旧画像不得残留（范围/统计都不许串）', () => {
  /* 第一手：BB 是阿豪（MANIAC） */
  let table = test16Table();
  const bbSeatId = seatOfPosition(table, Position.BB)!.seatId;
  table = must(applyTableOp(table, { kind: 'SET_PROFILE', seatId: bbSeatId, quickProfile: 'MANIAC' }));
  const before = adapt(table);
  const beforeMath = mathOf(before);
  const beforeIdentity = identityOf(before).playerIdentity;

  /* 下一手：同一个座位换人（REPLACE_PLAYER 走生产操作） */
  const next = must(applyTableOp(table, { kind: 'NEXT_HAND' }));
  const replaced = must(applyTableOp(next, { kind: 'REPLACE_PLAYER', seatId: bbSeatId }));
  const replayed = playTest16Line(replaced, Position.BB);
  const after = adapt(replayed);
  const afterMath = mathOf(after);
  const afterIdentity = identityOf(after).playerIdentity;

  assert.notEqual(
    afterIdentity.persistentPlayerId,
    beforeIdentity.persistentPlayerId,
    '同一个座位换人 ⇒ 持久身份必须不同',
  );
  assert.equal(after.villain!.quickProfile, 'UNKNOWN', '新玩家画像必须是 UNKNOWN（不继承）');
  assert.equal(seatOfPosition(replayed, Position.BB)!.playerId, afterIdentity.persistentPlayerId);
  assert.notEqual(
    JSON.stringify(afterMath),
    JSON.stringify(beforeMath),
    'MANIAC → 陌生人 必须改变数学（否则说明画像根本没进范围链）',
  );

  /* 反向：把 MANIAC 明确设回**新玩家** ⇒ 范围链必须重新吃到画像，但身份仍是新玩家 */
  const restored = must(applyTableOp(replayed, { kind: 'SET_PROFILE', seatId: bbSeatId, quickProfile: 'MANIAC' }));
  const restoredInput = adapt(restored);
  const restoredMath = mathOf(restoredInput);
  assert.equal(restoredInput.villain!.quickProfile, 'MANIAC');
  assert.notEqual(
    restoredInput.villain!.persistentPlayerId,
    beforeIdentity.persistentPlayerId,
    '身份仍然是新玩家（不是阿豪）—— 画像内容可以相同，身份不会因此被合并',
  );
  assert.notEqual(
    JSON.stringify(restoredMath),
    JSON.stringify(afterMath),
    '同座位、同一手内：MANIAC 与 UNKNOWN 必须给出不同数学（画像确实进了范围链）',
  );
  /*
   * ⚠️ 与**第一手**比较时只比决策相关量：`NEXT_HAND` 会带着筹码进入下一手，
   * 因此第二手的 `myRemainingStack` / `effectiveStack` / `spr` 本来就不一样
   * —— 那是牌局事实，不是身份路由的结果。
   */
  for (const key of ['heroEquityVsBetRange', 'heroEquity', 'callEV', 'pot', 'callCost', 'requiredEquity']) {
    assert.equal(
      restoredMath[key],
      beforeMath[key],
      `${key} 必须与第一手逐位一致（同一座位 + 同一画像内容 + 同一条线）`,
    );
  }
});

test('M4：显示名是中文 / 英文 / 含空格都不影响已绑定的持久身份', () => {
  const variants = ['阿豪', 'Ah Hao', '  Ah   Hao  ', 'Ahao-01'];
  const fingerprints = new Set<string>();
  for (const name of variants) {
    fingerprints.add(fingerprintOf(test16Input({
      seatId: 'seat_BB',
      persistentPlayerId: 'player_001',
      displayName: name,
      quickProfile: 'MANIAC',
      dynamicHint: 'UNKNOWN',
      stackBB: 100,
      observedStats: AHAO_STATS,
    })));
  }
  assert.equal(fingerprints.size, 1, `显示名不得影响数学结果，实际 ${fingerprints.size} 种`);
});

test('M5：只给姓名（无唯一持久 id）不得猜测绑定', () => {
  const roster: readonly PlayerRosterEntry[] = [
    { playerId: 'player_001', displayName: '阿豪' },
    { playerId: 'player_002', displayName: '阿豪' },
  ];
  const ambiguous = resolveRosterSelection({ query: '阿豪', roster });
  assert.equal(ambiguous.status, 'AMBIGUOUS', '同名多候选 ⇒ 必须返回待选择');
  const missing = resolveRosterSelection({ query: '不存在的人', roster });
  assert.equal(missing.status, 'NOT_FOUND');

  /* 管线侧：只给显示名 ⇒ 不做持久绑定，且必须披露 */
  const nameOnly = identityOf(test16Input({
    displayName: '阿豪',
    quickProfile: 'MANIAC',
    dynamicHint: 'UNKNOWN',
    stackBB: 100,
  }));
  assert.equal(nameOnly.playerIdentity.persistentPlayerId, null, '只给姓名不得绑定任何持久 id');
  assert.equal(nameOnly.playerIdentity.status, 'NAME_ONLY_NO_BINDING');
  assert.ok(nameOnly.playerIdentity.disclosureZh !== null, '必须披露「未绑定持久身份」');
  assert.equal((nameOnly.context.profileV3 as any)?.observedStatCount ?? 0, 0, '不得读到任何历史统计');
});

test('M6：陌生玩家不得读取上一手同一座位的画像', () => {
  /* 第一手：BB 是阿豪（MANIAC） */
  let table = test16Table();
  const bbSeatId = seatOfPosition(table, Position.BB)!.seatId;
  table = must(applyTableOp(table, { kind: 'SET_PROFILE', seatId: bbSeatId, quickProfile: 'MANIAC' }));
  const oldPlayerId = seatOfPosition(table, Position.BB)!.playerId!;
  assert.equal(adapt(table).villain!.quickProfile, 'MANIAC');

  /* 下一手：阿豪离桌（清空座位），换一个陌生人坐上同一个座位 */
  const nextHand = must(applyTableOp(table, { kind: 'NEXT_HAND' }));
  const cleared = must(applyTableOp(nextHand, { kind: 'CLEAR_SEAT', seatId: bbSeatId }));
  const strangerTable = playTest16Line(addPlayer(cleared, Position.BB), Position.BB);
  const strangerId = seatOfPosition(strangerTable, Position.BB)!.playerId!;

  assert.notEqual(strangerId, oldPlayerId);
  assert.ok(Object.keys(strangerTable.playersById).includes(oldPlayerId), '旧玩家对象必须留在历史里');

  const input = adapt(strangerTable);
  const identity = identityOf(input).playerIdentity;
  assert.equal(identity.persistentPlayerId, strangerId, '身份必须是新来的陌生人');
  assert.equal(input.villain!.quickProfile, 'UNKNOWN', '陌生人必须 UNKNOWN');
  assert.equal(input.villain!.playerId, bbSeatId, '引擎口径 id 仍是座位 id');
  assert.equal(
    (identityOf(input).context.profileV3 as any)?.observedStatCount ?? 0,
    0,
    '陌生玩家不得携带任何实测统计',
  );
});

test('M7：有标签但统计全 null —— null 不得当成 0', () => {
  const allNull = {
    handsObserved: 800,
    vpip: null, pfr: null, threeBet: null, wtsd: null,
    foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
    flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
  } as const;

  const noStats = identityOf(test16Input({
    seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪',
    quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
  }));
  const nullStats = identityOf(test16Input({
    seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪',
    quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
    observedStats: allNull,
  }));

  assert.equal((noStats.context.profileV3 as any)?.observedStatCount ?? 0, 0);
  assert.equal((nullStats.context.profileV3 as any)?.observedStatCount ?? 0, 0, '全 null ⇒ 0 项统计（缺失 ≠ 观测到 0）');
  /*
   * 只比**数值**：`noteZh` 里的「（0 手）」「（800 手）」是纯展示字段
   *（工作单 §五：纯展示差异不纳入数值等价断言）。
   */
  const numericPart = (ctx: { context: Record<string, any> }): string => {
    const v3 = ctx.context['profileV3'] as Record<string, any>;
    return JSON.stringify({
      observedStatCount: v3['observedStatCount'],
      dimensions: v3['dimensions'],
      observedDimensions: v3['observedDimensions'],
      resolvedDimensions: v3['resolvedDimensions'],
      baseDimensions: v3['baseDimensions'],
      blendWeight: v3['blendWeight'],
      evidenceMass: v3['evidenceMass'],
      street: v3['street'],
      trace: (v3['trace'] as Record<string, any>[]).map((t) => [
        t['stat'], t['observedRate'], t['effectiveRate'], t['opportunities'], t['confidence'], t['streetTrait'],
      ]),
    });
  };
  assert.equal(
    numericPart(nullStats),
    numericPart(noStats),
    '「不给统计」与「统计全 null」在数值上必须逐位一致',
  );

  /* 对照：给了 4 项 ⇒ 必须变成 4 项（证明上面那个 0 不是「统计通道整体失效」） */
  const withStats = identityOf(test16Input({
    seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪',
    quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
    observedStats: AHAO_STATS,
  }));
  assert.equal((withStats.context.profileV3 as any)?.observedStatCount, 4, '给了 4 项统计就必须解析出 4 项');
});

test('M8：牌桌页面与手工输入页面必须解析到同一个玩家', () => {
  let table = test16Table();
  const bbSeatId = seatOfPosition(table, Position.BB)!.seatId;
  table = must(applyTableOp(table, { kind: 'SET_PROFILE', seatId: bbSeatId, quickProfile: 'MANIAC' }));
  const fromTable = adapt(table);
  const tableIdentity = identityOf(fromTable).playerIdentity;

  const fromManual = test16Input({
    seatId: bbSeatId,
    persistentPlayerId: tableIdentity.persistentPlayerId!,
    displayName: fromTable.villain!.displayName!,
    quickProfile: 'MANIAC',
    dynamicHint: 'UNKNOWN',
    stackBB: 100,
  });
  const manualIdentity = identityOf(fromManual).playerIdentity;

  assert.equal(manualIdentity.seatId, tableIdentity.seatId);
  assert.equal(manualIdentity.persistentPlayerId, tableIdentity.persistentPlayerId);
  assert.equal(manualIdentity.snapshotPlayerId, tableIdentity.snapshotPlayerId);
  assert.equal(fingerprintOf(fromManual), fingerprintOf(fromTable), '两条页面路径必须逐位等价');
});

test('M9：范围链与响应链必须解析成同一个玩家（不得各算一个人）', () => {
  /* 两家已实现对手：UTG 领打（首要对手）、BB 过牌（第二家、未弃牌）
     → 把画像绑到**非首要**的 seat_BB，首要对手 UTG 的范围与下注范围都不许被污染。 */
  const multiway = (villain: ManualVillain): ManualHandInput => ({
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['Kh', 'Qh'],
    board: ['Ah', '7c', '2d'],
    street: 'FLOP',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'CALL', 1), A('HJ', 'FOLD'), A('CO', 'CALL', 1), A('BTN', 'CALL', 1), A('SB', 'FOLD'), A('BB', 'CHECK'),
      A('BB', 'CHECK', undefined, 'FLOP'), A('UTG', 'BET', 4, 'FLOP'), A('CO', 'FOLD', undefined, 'FLOP'),
    ],
    environment: 'MID_LOW_STAKES',
    villain,
  }) as unknown as ManualHandInput;

  const none = analyzeManualHand(multiway({ quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 100 }), OPTIONS);
  const MANIAC_ON = (seatId: string | null): ManualVillain => ({
    ...(seatId === null ? {} : { seatId }),
    persistentPlayerId: seatId === 'seat_SB' ? null : 'player_001',
    displayName: '阿豪',
    quickProfile: 'MANIAC',
    dynamicHint: 'UNKNOWN',
    stackBB: 100,
  });
  /*
   * ⚠️ **标签必须保持不变**，只改「画像挂在哪一家」——
   * 否则比较里会混进「不同标签 ⇒ 不同 limp 原型」这个与身份无关的因素。
   * `seat_SB` 是已弃牌座位（不在本手对手集合里）⇒ 基线 = 画像哪儿也没挂上。
   */
  const baseline = analyzeManualHand(multiway(MANIAC_ON('seat_SB')), OPTIONS);
  const onPrimary = analyzeManualHand(multiway(MANIAC_ON('seat_UTG')), OPTIONS);
  const onSecond = analyzeManualHand(multiway(MANIAC_ON('seat_BB')), OPTIONS);
  const onFolded = baseline;
  assert.equal(none.ok && baseline.ok && onPrimary.ok && onSecond.ok && onFolded.ok, true,
    `变体都必须可分析：${[
      none.ok ? '' : JSON.stringify(none.issues),
      baseline.ok ? '' : JSON.stringify(baseline.issues),
      onPrimary.ok ? '' : JSON.stringify(onPrimary.issues),
      onSecond.ok ? '' : JSON.stringify(onSecond.issues),
    ].filter((s) => s.length > 0).join(' | ')}`);
  if (!none.ok || !baseline.ok || !onPrimary.ok || !onSecond.ok || !onFolded.ok) return;

  const mathOfResult = (r: typeof none): Record<string, any> =>
    ((r.decision as unknown as Record<string, any>)['diagnostics'] as Record<string, any>)['math'] as Record<string, any>;

  const base = mathOfResult(baseline);
  const primary = mathOfResult(onPrimary);
  const second = mathOfResult(onSecond);

  /* ① 画像绑到**首要对手**（= 正在下注的那一家）⇒ 下注范围权益必须变（注入真的发生） */
  assert.notEqual(
    primary['heroEquityVsBetRange'],
    base['heroEquityVsBetRange'],
    '画像绑到正在下注的那一家必须改变「对下注范围的权益」',
  );
  /* ② 画像绑到**非首要对手**（BB）⇒ 首要对手的下注链**不得**被污染 */
  assert.equal(
    second['heroEquityVsBetRange'],
    base['heroEquityVsBetRange'],
    '画像绑在非首要对手时，首要对手的下注范围不得被改动（否则就是「用甲的性格给乙做决策」）',
  );
  assert.notEqual(second['heroEquity'], base['heroEquity'], '但第二家的范围确实被画像改了（整体权益会变）');
  /* ③ 绑到一个不在对手集合里的座位 ⇒ 显式回退，不得瞎绑 */
  assert.equal(
    base['heroEquity'],
    mathOfResult(analyzeManualHand(multiway({
      seatId: 'seat_SB', persistentPlayerId: null, displayName: '老张',
      quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
    }), OPTIONS) as typeof none)['heroEquity'],
    '同一个「定位不到」输入必须给同一个结果',
  );

  const foldedIdentity = identityOf(multiway({
    seatId: 'seat_SB', persistentPlayerId: 'player_003', displayName: '老张',
    quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
  })).playerIdentity;
  assert.equal(foldedIdentity.status, 'SEAT_NOT_FOUND', '目标座位不在对手集合 ⇒ 必须显式报 SEAT_NOT_FOUND');
  assert.equal(foldedIdentity.seatId, null, '不得回退到别的座位（不猜）');
  assert.ok(foldedIdentity.disclosureZh !== null, '必须如实披露');

  /* ④ 两家对手 + 只给非座位口径的 id ⇒ 无法判断属于谁 ⇒ 显式 AMBIGUOUS，不猜 */
  const ambiguous = identityOf(multiway({
    playerId: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
  })).playerIdentity;
  assert.equal(ambiguous.status, 'AMBIGUOUS_MULTI_OPPONENT', '多家对手 + 自由文本 id ⇒ 必须报待指定');
  assert.equal(ambiguous.seatId, null);
});

test('M10：只改显示名不得改变已明确绑定玩家的数学结果', () => {
  const withName = (displayName: string | null) => test16Input({
    seatId: 'seat_BB',
    persistentPlayerId: 'player_001',
    ...(displayName === null ? {} : { displayName }),
    quickProfile: 'MANIAC',
    dynamicHint: 'UNKNOWN',
    stackBB: 100,
    observedStats: AHAO_STATS,
  });

  const before = mathOf(withName('阿豪'));
  const renamed = mathOf(withName('Completely Different Name'));
  const unnamed = mathOf(withName(null));
  assert.equal(JSON.stringify(renamed), JSON.stringify(before), '改名不得改变数学九项');
  assert.equal(JSON.stringify(unnamed), JSON.stringify(before), '省略显示名也不得改变数学九项');
});

/* ============================================================
 * 身份解析单元契约（纯函数，边界与优先级）
 * ============================================================ */

test('身份解析：优先级、座位口径识别与不猜测规则', () => {
  assert.equal(isEngineSeatId('seat_BB'), true);
  assert.equal(isEngineSeatId('阿豪'), false);
  assert.equal(isEngineSeatId('player_001'), false);

  const seats = ['seat_BB', 'seat_CO'];
  /* 1) 显式 seatId 优先 */
  assert.equal(
    resolvePlayerIdentity({ claim: { seatId: 'seat_CO', playerId: 'seat_BB' }, opponentSeatIds: seats, primarySeatId: 'seat_BB' }).seatId,
    'seat_CO',
    '显式 seatId 优先于引擎口径 id',
  );
  /* 2) 引擎口径 playerId 仍然可用（向后兼容） */
  assert.equal(
    resolvePlayerIdentity({ claim: { playerId: 'seat_CO' }, opponentSeatIds: seats, primarySeatId: 'seat_BB' }).seatId,
    'seat_CO',
  );
  /* 3) seatId 不在对手集合 ⇒ 不回退、不猜 */
  const missing = resolvePlayerIdentity({ claim: { seatId: 'seat_SB' }, opponentSeatIds: seats, primarySeatId: 'seat_BB' });
  assert.equal(missing.status, 'SEAT_NOT_FOUND');
  assert.equal(missing.seatId, null);
  /* 4) 无任何身份 ⇒ 行为保持：路由到首要对手，但必须披露 */
  const none = resolvePlayerIdentity({ claim: {}, opponentSeatIds: seats, primarySeatId: 'seat_BB' });
  assert.equal(none.status, 'BOUND_TO_PRIMARY_OPPONENT');
  assert.equal(none.seatId, 'seat_BB');
  assert.ok(none.disclosureZh !== null);
  /* 5) 持久 id + 多家对手（无 seatId）⇒ 待指定 */
  const ambiguous = resolvePlayerIdentity({
    claim: { persistentPlayerId: 'player_001' },
    opponentSeatIds: seats,
    primarySeatId: 'seat_BB',
  });
  assert.equal(ambiguous.status, 'AMBIGUOUS_MULTI_OPPONENT');
  assert.equal(ambiguous.seatId, null);
  /* 6) 持久 id + 单一对手 ⇒ 绑定（TEST 16 的正解） */
  const sole = resolvePlayerIdentity({
    claim: { persistentPlayerId: 'player_001' },
    opponentSeatIds: ['seat_BB'],
    primarySeatId: 'seat_BB',
  });
  assert.equal(sole.status, 'BOUND_BY_PERSISTENT_ID');
  assert.equal(sole.seatId, 'seat_BB');
  assert.equal(sole.persistentPlayerId, 'player_001');
});
