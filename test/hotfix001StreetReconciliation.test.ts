/**
 * REAL-HAND HOTFIX 001 —— **街道结算（D）与 All-In 发牌（E）永久回归**
 *
 * 对应报告：`reports/REAL_HAND_HOTFIX_001.md` 第 3、4、4.1、7 节。
 *
 * ## 现场症状
 *
 * 真实 Web 测试里出现：
 *
 * > 「内部一致性检查失败：应用后的状态与重新重放出来的状态不一致。这一块已被拒绝。」
 *
 * 现场感受是「只能点全下才走得下去」。
 *
 * ## 两个缺陷
 *
 * | 编号 | 缺陷 | 本文件怎么钉住 |
 * |---|---|---|
 * | **D** | 增量侧（`applyAction` 之后）**从不推进街道**，重放侧只要牌够就推 → 同一个动作结算出两个不同阶段的状态，自检把**合法动作**判成「内部不一致」并拒绝 | §D-1…§D-4 |
 * | **E** | `advanceStreet` 把「本街下注轮结束」当成「已经进入摊牌」：无人可行动时无条件 `phase = SHOWDOWN`，于是出现「SHOWDOWN + 公共牌只有 3 张 / 0 张」 | §E-1…§E-4 |
 *
 * ## 规范状态（第 7 节）
 *
 * > 一条动作之后的规范状态 =
 * > **应用动作** → **结算下注轮** → **只有在公共牌真的够时才推进街道**，
 * > 并且发出的必须是**真实存在的牌**（绝不凭空生成）。
 *
 * 因此本文件同时断言两件事：
 * 1. 两条路径必须收敛到**同一个**规范状态（不是「两边各修一半」）；
 * 2. 「停住」与「分叉」是两回事 —— 公共牌不够时两边**都**停住，那是一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ActionType, Position, Street } from '../src/domain/types.ts';
import { HandPhase, type ActionCommand, type GameState } from '../src/domain/poker/gameState.ts';
import { actorOnTurn, applyAction } from '../src/domain/poker/engine.ts';
import { createTable, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp, engineViewOf } from '../src/app/table/tableOps.ts';
import { stateFingerprintOf } from '../src/app/table/tablePreview.ts';
import { settleCanonicalStreet } from '../src/app/manualInput/reconstruct.ts';
import type { PokerTableState, TableIssue, TableOp } from '../src/app/table/table.types.ts';
import type { ManualActionType } from '../src/app/manualInput/manualInput.ts';

const BIG_BLIND_CHIPS = 100;

const RING_9: readonly Position[] = [
  Position.UTG,
  Position.UTG1,
  Position.UTG2,
  Position.LJ,
  Position.HJ,
  Position.CO,
  Position.BTN,
  Position.SB,
  Position.BB,
];

const RING_6: readonly Position[] = [
  Position.UTG,
  Position.HJ,
  Position.CO,
  Position.BTN,
  Position.SB,
  Position.BB,
];

function must(state: PokerTableState, op: TableOp): PokerTableState {
  const r = applyTableOp(state, op);
  if (!r.ok) {
    throw new Error(`op ${op.kind} 失败：${r.issues.map((i: TableIssue) => i.message).join(' / ')}`);
  }
  return r.state;
}

/* ============================================================
 * 现场分叉场景（报告第 2 / 3 节的最小复现）
 * ============================================================ */

type Step = { position: Position; type: ManualActionType; amountBB?: number };

/**
 * 9 座桌翻牌前顺序：`UTG → UTG1 → UTG2 → LJ → HJ → CO → BTN → SB → BB`。
 *
 * 第 **12** 条（`SB CALL 1.75`）就是**关掉翻牌前下注轮**的那一条 ——
 * 报告第 3 节的判据：只要「某条动作关掉了下注轮」且「公共牌已经够下一街」，
 * 修复前两条路径必然分叉。
 */
const SCENARIO: readonly Step[] = [
  { position: Position.UTG, type: 'FOLD' },
  { position: Position.UTG1, type: 'FOLD' },
  { position: Position.UTG2, type: 'FOLD' },
  { position: Position.LJ, type: 'FOLD' },
  { position: Position.HJ, type: 'FOLD' },
  { position: Position.CO, type: 'RAISE', amountBB: 2 },
  { position: Position.BTN, type: 'CALL', amountBB: 2 },
  { position: Position.SB, type: 'CALL', amountBB: 1.5 },
  { position: Position.BB, type: 'RAISE', amountBB: 3.75 },
  { position: Position.CO, type: 'CALL', amountBB: 1.75 },
  { position: Position.BTN, type: 'CALL', amountBB: 1.75 },
  { position: Position.SB, type: 'CALL', amountBB: 1.75 },
];

/** 关掉翻牌前下注轮的那一条动作的序号（1-based） */
const ROUND_CLOSING_ORDINAL = 12;

function buildDivergenceTable(boardCards: readonly string[]): PokerTableState {
  let state = createTable({ tableSize: 9, heroPosition: Position.SB, defaultStackBB: 100 });
  for (const p of RING_9) {
    if (p === Position.SB) continue;
    state = must(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, p)!.seatId });
  }
  state = must(state, { kind: 'SET_HERO_CARD', card: 'As' });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Kd' });
  for (const [i, card] of boardCards.entries()) {
    state = must(state, { kind: 'SET_BOARD_CARD', card, slot: i });
  }
  return state;
}

/**
 * 逐字段快照 —— **比指纹更严**。
 *
 * `stateFingerprintOf` 只覆盖一部分字段；这里刻意把
 * `actedSinceLastAggression` / `pendingQueue` / `raiseClosedFor` /
 * `lastAggressorId` 这些**决定「下注轮什么时候关」**的簿记也纳进来，
 * 因为「指纹相同但轮次簿记不同」会在**下一步**才炸出来。
 */
function snapshot(s: GameState): Record<string, string> {
  const out: Record<string, string> = {
    street: String(s.street),
    phase: String(s.phase),
    currentActor: String(actorOnTurn(s)),
    currentBet: String(s.currentBet),
    lastRaiseSize: String(s.lastRaiseSize),
    bettingRoundComplete: String(s.bettingRoundComplete),
    lastAggressorId: String(s.lastAggressorId),
    raiseClosedFor: JSON.stringify([...s.raiseClosedFor].sort()),
    actedSinceLastAggression: JSON.stringify([...s.actedSinceLastAggression].sort()),
    pendingQueue: JSON.stringify(s.pendingQueue),
    boardFlop: String(s.board.flop.length),
    boardTurn: String(s.board.turn.length),
    boardRiver: String(s.board.river.length),
    actionCount: String(s.actions.length),
  };
  for (const p of [...s.players].sort((a, b) => (a.position < b.position ? -1 : 1))) {
    out[`${p.position}.stack`] = String(p.remainingStack);
    out[`${p.position}.committed`] = JSON.stringify(p.committedByStreet);
    out[`${p.position}.folded`] = String(p.folded);
    out[`${p.position}.allIn`] = String(p.allIn);
  }
  return out;
}

function diffOf(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const rows: string[] = [];
  for (const k of [...keys].sort()) if (a[k] !== b[k]) rows.push(`${k}: 增量=${a[k]} 重放=${b[k]}`);
  return rows;
}

const TYPE_MAP: Readonly<Record<ManualActionType, ActionType>> = Object.freeze({
  FOLD: ActionType.FOLD,
  CHECK: ActionType.CHECK,
  CALL: ActionType.CALL,
  BET: ActionType.BET,
  RAISE: ActionType.RAISE,
  ALL_IN: ActionType.ALL_IN,
});

function commandFor(step: Step, playerId: string): ActionCommand {
  return {
    playerId,
    type: TYPE_MAP[step.type],
    ...(step.amountBB !== undefined
      ? { amount: Math.round(step.amountBB * BIG_BLIND_CHIPS) }
      : {}),
    manuallyEntered: true,
  };
}

function applyStep(state: PokerTableState, step: Step): PokerTableState {
  const r = applyTableOp(state, {
    kind: 'ACT',
    action: {
      type: step.type,
      ...(step.amountBB !== undefined
        ? { amountChips: Math.round(step.amountBB * BIG_BLIND_CHIPS) }
        : {}),
    },
  });
  if (!r.ok) {
    throw new Error(
      `第 ${SCENARIO.indexOf(step) + 1} 步「${step.position} ${step.type}」被拒绝：` +
        r.issues.map((i: TableIssue) => i.message).join(' / '),
    );
  }
  return r.state;
}

/* ============================================================
 * §D —— 增量与重放必须收敛到同一个规范状态
 * ============================================================ */

test('§D-1：现场场景 12 步全部必须被接受（修复前第 12 步以「内部一致性检查失败」被拒）', () => {
  let table = buildDivergenceTable(['Ah', '7c', '2d']);

  // `applyStep` 会在任一步被拒绝时抛出，并带上步号与后端给的原因
  for (const step of SCENARIO) table = applyStep(table, step);

  const view = engineViewOf(table);
  assert.equal(view.ok, true, '12 步之后必须仍然能重放');
  if (!view.ok) return;
  /*
   * 引擎的 `actions` 除我们录的 12 条之外，还有 2 条**强制盲注**
   * （`POST_SB` / `POST_BB`）—— 盲注也是真实发生过的行动，不是凭空生成。
   */
  assert.equal(
    view.engine.actions.length,
    SCENARIO.length + 2,
    `必须记满 ${SCENARIO.length} 条手动行动 + 2 条强制盲注`,
  );
  assert.equal(
    view.engine.street,
    Street.FLOP,
    `关掉翻牌前下注轮（第 ${ROUND_CLOSING_ORDINAL} 步）之后必须已经推进到翻牌`,
  );
});

test('§D-2：逐步对拍 —— 增量侧的规范状态与重放侧必须逐字段一致', () => {
  let table = buildDivergenceTable(['Ah', '7c', '2d']);
  const boardCards = engineViewOf(table);

  assert.equal(boardCards.ok, true);
  if (!boardCards.ok) return;
  const board = boardCards.boardCards;

  for (const [i, step] of SCENARIO.entries()) {
    const ordinal = i + 1;

    const before = engineViewOf(table);
    assert.equal(before.ok, true, `第 ${ordinal} 步前必须能重放`);
    if (!before.ok) return;

    const actorId = actorOnTurn(before.engine);
    assert.notEqual(actorId, null, `第 ${ordinal} 步必须有行动者`);
    if (actorId === null) return;
    assert.equal(
      before.engine.players.find((p) => p.id === actorId)!.position,
      step.position,
      `第 ${ordinal} 步行动者必须是 ${step.position}`,
    );

    // ---- 增量侧 + 规范步骤 ----
    const applied = applyAction(before.engine, commandFor(step, actorId));
    assert.equal(applied.ok, true, `第 ${ordinal} 步引擎必须接受`);
    if (!applied.ok) return;
    const canonical = settleCanonicalStreet(applied.state, board).state;

    // ---- 真实产品路径 ----
    table = applyStep(table, step);

    // ---- 重放侧 ----
    const after = engineViewOf(table);
    assert.equal(after.ok, true, `第 ${ordinal} 步后必须能重放`);
    if (!after.ok) return;

    assert.equal(
      stateFingerprintOf(canonical),
      stateFingerprintOf(after.engine),
      `第 ${ordinal} 步（${step.position} ${step.type}）指纹必须一致`,
    );
    const rows = diffOf(snapshot(canonical), snapshot(after.engine));
    assert.deepEqual(
      rows,
      [],
      `第 ${ordinal} 步（${step.position} ${step.type}）逐字段必须一致：\n  ${rows.join('\n  ')}`,
    );
  }
});

test('§D-3：公共牌不足时两边**都**停住（停住不是分叉）', () => {
  let table = buildDivergenceTable([]); // 一张公共牌都没录
  for (const step of SCENARIO) table = applyStep(table, step);

  const view = engineViewOf(table);
  assert.equal(view.ok, true);
  if (!view.ok) return;

  assert.equal(
    view.engine.actions.length,
    SCENARIO.length + 2,
    '12 条手动行动 + 2 条强制盲注都必须被接受',
  );
  assert.equal(view.engine.street, Street.PREFLOP, '公共牌为 0 张时**不得**推进街道');
  assert.equal(view.engine.bettingRoundComplete, true, '但下注轮确实已经结束');
  assert.equal(view.engine.board.flop.length, 0, '**绝不允许凭空发牌**');
  assert.equal(view.engine.phase, HandPhase.BETTING, '不得因此进入摊牌');
});

test('§D-4：公共牌给满时，关掉下注轮只推到翻牌 —— 不得越过新开启的下注轮一路发到河牌', () => {
  let table = buildDivergenceTable(['Ah', '7c', '2d', 'Ks', '9h']);
  for (const step of SCENARIO) table = applyStep(table, step);

  const view = engineViewOf(table);
  assert.equal(view.ok, true);
  if (!view.ok) return;

  assert.equal(view.engine.street, Street.FLOP, '关掉翻牌前下注轮 ⇒ 推进到翻牌');
  assert.equal(view.engine.board.flop.length, 3, '翻牌必须恰好 3 张');
  assert.equal(view.engine.board.turn.length, 0, '翻牌刚开，转牌**不得**提前发');
  assert.equal(view.engine.board.river.length, 0, '河牌**不得**提前发');
  assert.equal(view.engine.bettingRoundComplete, false, '翻牌是新的下注轮，必须重新打开');
});

/* ============================================================
 * §E —— All-In 不得凭空发牌、不得凭空白进摊牌
 * ============================================================ */

/** 6 座桌，Hero 在 UTG；所有人用 ALL_IN 一路推完 */
function allInRunout(boardCards: readonly string[]): {
  state: PokerTableState;
  engine: GameState | null;
  allInCount: number;
} {
  let state = createTable({ tableSize: 6, heroPosition: Position.UTG, defaultStackBB: 100 });
  for (const p of RING_6) {
    if (p === Position.UTG) continue;
    state = must(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, p)!.seatId });
  }
  state = must(state, { kind: 'SET_HERO_CARD', card: 'As' });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Kd' });
  for (const [i, card] of boardCards.entries()) {
    state = must(state, { kind: 'SET_BOARD_CARD', card, slot: i });
  }

  let allInCount = 0;
  for (let i = 0; i < RING_6.length; i += 1) {
    const view = engineViewOf(state);
    if (!view.ok || actorOnTurn(view.engine) === null) break;
    const r = applyTableOp(state, { kind: 'ACT', action: { type: 'ALL_IN' } });
    if (!r.ok) break;
    state = r.state;
    allInCount += 1;
  }

  const view = engineViewOf(state);
  return { state, engine: view.ok ? view.engine : null, allInCount };
}

test('§E-1：全员全下 + 公共牌 0 张 ⇒ 停在翻牌前，绝不进摊牌、绝不发牌', () => {
  const { engine, allInCount } = allInRunout([]);
  assert.equal(allInCount, RING_6.length, '6 个人都应当能全下');
  assert.notEqual(engine, null);
  if (engine === null) return;

  assert.equal(engine.street, Street.PREFLOP, '没有公共牌 ⇒ 停在翻牌前');
  assert.equal(engine.phase, HandPhase.BETTING, '**不得**凭空白进摊牌（E 的核心）');
  assert.equal(engine.board.flop.length + engine.board.turn.length + engine.board.river.length, 0);
});

test('§E-2：全员全下 + 公共牌 3 张 ⇒ 推进到翻牌，但 phase 仍是 BETTING（修复前是 SHOWDOWN）', () => {
  const { engine } = allInRunout(['Ah', '7c', '2d']);
  assert.notEqual(engine, null);
  if (engine === null) return;

  assert.equal(engine.street, Street.FLOP);
  assert.equal(engine.phase, HandPhase.BETTING, '「下注轮结束」不等于「已进入摊牌」');
  assert.equal(engine.board.flop.length, 3, '只发翻牌这 3 张');
  assert.equal(engine.board.turn.length, 0, '转牌不得凭空生成');
  assert.equal(engine.board.river.length, 0, '河牌不得凭空生成');
  assert.equal(engine.bettingRoundComplete, true, '无人可行动 ⇒ 本街确实已结束');
  assert.equal(engine.pendingQueue.length, 0);
});

test('§E-3：全员全下 + 公共牌 5 张 ⇒ 一路发到河牌**之后**才进摊牌', () => {
  const { engine } = allInRunout(['Ah', '7c', '2d', 'Ks', '9h']);
  assert.notEqual(engine, null);
  if (engine === null) return;

  assert.equal(engine.street, Street.RIVER);
  assert.equal(engine.phase, HandPhase.SHOWDOWN, '公共牌发满之后才允许摊牌');
  assert.equal(engine.board.flop.length, 3);
  assert.equal(engine.board.turn.length, 1);
  assert.equal(engine.board.river.length, 1, '5 张公共牌必须全部是**真实录入**的牌');
});

test('§E-4：反证 —— 公共牌只有 4 张时，河牌不得被发出来', () => {
  const { engine } = allInRunout(['Ah', '7c', '2d', 'Ks']);
  assert.notEqual(engine, null);
  if (engine === null) return;

  assert.equal(engine.street, Street.TURN, '只有 4 张 ⇒ 最多推进到转牌');
  assert.equal(engine.phase, HandPhase.BETTING, '不得进摊牌');
  assert.equal(engine.board.turn.length, 1);
  assert.equal(engine.board.river.length, 0, '河牌**不得**凭空生成（规范第 9 条）');
});
