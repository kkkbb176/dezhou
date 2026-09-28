/*
 * 🔴 **P4：牌局记录必须可回放。**
 *
 * ## 这个文件锁的是什么
 *
 * 本文件之前，`data/player-history.jsonl`（实测 1,036 条）里**一张牌都没有**，
 * 而 `data/decision-log.jsonl`（10,917 条）只存 `inputHash`
 * ⇒ 「真实牌局复盘 + 实战验证」这条线**根本不成立**，
 * 只能拿合成语料代替真实牌局。
 *
 * 修复：`ObservationRecord` 增加
 * - `board`：行动**之前**已发出的公共牌（按街切片）；
 * - `holeCards`：行动者自己的底牌（**只有 Hero 有**，对手缺省 ⇒ 不虚构）。
 *
 * 本文件把三件事钉住：
 * ① **真实牌桌操作**写出的记录里，这两个字段的值与当时局面逐字一致；
 * ② `replayHand` 只用记录就能还原公共牌 / 底牌 / 行动序列；
 * ③ **边界**：旧记录（无牌面）不被当成「有牌」；同手牌面矛盾时**显式失败**，不拼一个假牌局。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyUserOpWithHistory,
  loadObservations,
  type ObservationRecord,
} from '../src/app/table/playerHistory.ts';
import { createTable } from '../src/app/table/tableState.ts';
import { engineViewOf } from '../src/app/table/tableOps.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';
import { replayAllHands, replayHand } from '../src/domain/handReplay/handReplay.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';

/* ============================================================
 * 脚手架
 * ============================================================ */

function must<T extends { ok: boolean }>(r: T): T & { ok: true } {
  assert.equal(r.ok, true, `期望成功，实际失败：${JSON.stringify((r as { issues?: unknown }).issues)}`);
  return r as T & { ok: true };
}

type Harness = {
  dir: string;
  state: () => PokerTableState;
  apply: (op: TableOp) => PokerTableState;
  act: (choice: 'FOLD' | 'CHECK_CALL' | 'RAISE') => void;
  street: () => string;
};

function newHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'p4-replay-'));
  let state = createTable({ tableSize: 6 });

  const apply = (op: TableOp): PokerTableState => {
    const r = applyUserOpWithHistory({ state, op, historyDir: dir });
    /* `TableOpOutcome` 是判别联合：`issues` 只在失败分支上 ⇒ 必须先收窄再用 */
    assert.equal(
      r.outcome.ok,
      true,
      `op ${op.kind} 必须成功：${r.outcome.ok ? '' : JSON.stringify(r.outcome.issues.map((i) => i.code))}`,
    );
    state = (r.outcome as { ok: true; state: PokerTableState }).state;
    return state;
  };

  const engineIdOf = (): string | null => {
    const v = engineViewOf(state);
    return v.ok ? actorOnTurn(v.engine) : null;
  };

  const legalOf = (id: string): { callCost: number; canRaise: boolean; minRaiseToAmount: number; allInToAmount: number } => {
    const v = engineViewOf(state);
    const me = v.ok ? v.engine.players.find((p) => p.id === id) : undefined;
    if (!v.ok || me === undefined) return { callCost: 0, canRaise: false, minRaiseToAmount: 0, allInToAmount: 0 };
    const l = deriveLegalActions(v.engine, me);
    return {
      callCost: l.callCost,
      canRaise: l.canRaise,
      minRaiseToAmount: l.minRaiseToAmount,
      allInToAmount: l.allInToAmount,
    };
  };

  /*
   * 金额一律取自引擎的合法动作，不写死 —— 写死会构造出非法动作。
   * `CALL` 的口径是**本次补入**，`RAISE` 是**本街累计到**（两者不同，见 `legalActions.ts`）。
   */
  const act = (choice: 'FOLD' | 'CHECK_CALL' | 'RAISE'): void => {
    const id = engineIdOf();
    assert.ok(id !== null, '必须有行动者');
    const legal = legalOf(id);
    if (choice === 'FOLD') {
      apply({ kind: 'ACT', action: { type: 'FOLD' } });
      return;
    }
    if (
      choice === 'RAISE' &&
      legal.canRaise &&
      legal.minRaiseToAmount > 0 &&
      legal.minRaiseToAmount <= legal.allInToAmount
    ) {
      apply({ kind: 'ACT', action: { type: 'RAISE', amountChips: legal.minRaiseToAmount } });
      return;
    }
    if (legal.callCost > 0) apply({ kind: 'ACT', action: { type: 'CALL', amountChips: legal.callCost } });
    else apply({ kind: 'ACT', action: { type: 'CHECK' } });
  };

  const street = (): string => {
    const v = engineViewOf(state);
    return v.ok ? String(v.engine.street) : '?';
  };

  return { dir, state: () => state, apply, act, street };
}

/**
 * 打一手**真正多街**的牌局。
 *
 * ## 🔴 街道推进的真实机制（我在这里踩过一次，值得写下来）
 *
 * `applyAction` **只标记**「本街下注轮已结束」，**从不改 `street`**
 *（`tableOps.ts:207-218`）。把街道推进到下一街的是
 * `settleCanonicalStreet(..., view.boardCards)` —— 而它**需要公共牌**：
 *
 * > 下注轮结束 **且** 公共牌够 ⇒ 推进到下一街；
 * > 公共牌不够 ⇒ 停在当前街（两边一致，不是错误）。
 *
 * ⇒ **必须先录公共牌，街道才会动**。因此顺序只能是：
 * 1. 打完翻前 → 2. 录翻牌 3 张（此刻引擎重放并把街道推进到 FLOP）
 * → 3. 打翻牌 → 4. 录转牌 1 张 → 5. 打转牌 …
 *
 * 若反过来（先打完再录牌，或不录牌就想打翻牌），
 * 后续所有行动都会被**如实地**记成翻前行动 —— 不会报错，只会静默地少掉两街。
 */
function playThreeStreets(h: Harness): void {
  h.apply({ kind: 'FILL_EMPTY_SEATS' });
  h.apply({ kind: 'SET_HERO_CARD', card: 'As' });
  h.apply({ kind: 'SET_HERO_CARD', card: 'Ks' });

  /** 本街打到「没人还能行动」为止（全部 CHECK/CALL，不制造二次加注） */
  const playBettingRound = (): void => {
    for (let i = 0; i < 12; i += 1) {
      const v = engineViewOf(h.state());
      if (!v.ok || actorOnTurn(v.engine) === null) return;
      h.act('CHECK_CALL');
    }
    assert.fail('本街动作数超过上限，可能死循环');
  };

  /* ---- 翻前 ---- */
  playBettingRound();
  assert.equal(h.street(), 'PREFLOP', '翻前动作打完后，引擎仍停在翻前（等公共牌）');

  /* ---- 录翻牌 3 张 ⇒ 引擎重放并把街道推进到 FLOP ---- */
  h.apply({ kind: 'SET_BOARD_CARD', card: 'Kh', slot: 0 });
  h.apply({ kind: 'SET_BOARD_CARD', card: '7c', slot: 1 });
  h.apply({ kind: 'SET_BOARD_CARD', card: '2d', slot: 2 });
  assert.equal(h.street(), 'FLOP', '录满翻牌 3 张后必须推进到翻牌');
  playBettingRound();

  /* ---- 录转牌 1 张 ---- */
  h.apply({ kind: 'SET_BOARD_CARD', card: 'Qd', slot: 3 });
  assert.equal(h.street(), 'TURN', '录满转牌后必须推进到转牌');
  playBettingRound();
}

/* ============================================================
 * P4-1 记录形状：board / holeCards 真的写进了每一行
 * ============================================================ */

test('P4-1 每条记录都带「行动前」的公共牌，且按街道切片', () => {
  const h = newHarness();
  try {
    playThreeStreets(h);
    const records = must(loadObservations(h.dir)).records;
    assert.ok(records.length > 0, '必须写出记录');

    for (const r of records) {
      assert.ok(r.board !== undefined, `记录（${r.street}）必须带 board`);
      const expected =
        r.street === 'FLOP' ? ['Kh', '7c', '2d']
        : r.street === 'TURN' ? ['Kh', '7c', '2d', 'Qd']
        : [];
      assert.deepEqual([...r.board!], expected, `${r.street} 的公共牌切片必须与街道自洽`);
    }

    /* 翻前确实**没有**公共牌 —— 空数组，而不是「缺字段」 */
    const preflop = records.filter((r) => r.street === 'PREFLOP');
    assert.ok(preflop.length > 0);
    assert.ok(
      preflop.every((r) => r.board !== undefined && r.board.length === 0),
      '翻前的 board 必须是**空数组**（= 当时确实没有公共牌），不能是 undefined（= 未记录）',
    );
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('P4-2 底牌只写在「行动者就是 Hero」的记录上，对手的记录**缺字段**而不是空数组', () => {
  const h = newHarness();
  try {
    playThreeStreets(h);
    const records = must(loadObservations(h.dir)).records;
    const heroPlayerId = h.state().heroPlayerId;

    const heroRecords = records.filter((r) => r.playerId === heroPlayerId);
    const villainRecords = records.filter((r) => r.playerId !== heroPlayerId);
    assert.ok(heroRecords.length > 0, 'Hero 必须有记录');
    assert.ok(villainRecords.length > 0, '对手必须有记录');

    assert.ok(
      heroRecords.every((r) => r.holeCards !== undefined && r.holeCards.join(' ') === 'As Ks'),
      'Hero 的每条记录都必须带自己的底牌 As Ks',
    );
    assert.ok(
      villainRecords.every((r) => r.holeCards === undefined),
      '对手的底牌**没人知道** ⇒ 必须缺字段（绝不能编一个出来）',
    );
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

/* ============================================================
 * P4-3 回放：只用记录还原整手牌
 * ============================================================ */

test('P4-3 `replayHand` 只用记录就能还原公共牌 / 底牌 / 行动序列', () => {
  const h = newHarness();
  try {
    playThreeStreets(h);
    const records = must(loadObservations(h.dir)).records;
    const handId = records[0]!.handId;

    const replayed = must(replayHand(handId, records));
    assert.equal(replayed.handId, handId);
    assert.deepEqual([...replayed.board], ['Kh', '7c', '2d', 'Qd'], '还原出的公共牌');
    assert.deepEqual([...(replayed.heroCards ?? [])], ['As', 'Ks'], '还原出的底牌');
    assert.equal(replayed.actions.length, records.length, '行动条数必须与记录条数一致');
    assert.equal(replayed.recordsWithBoard, records.length, '每条都带了公共牌');
    assert.ok(replayed.recordsWithCards > 0 && replayed.recordsWithCards < records.length);

    /* 顺序必须确定：与记录的 historyLength/seq 排序一致 */
    const ordered = [...records].sort((a, b) => a.historyLength - b.historyLength || a.seq - b.seq);
    assert.deepEqual(
      replayed.actions.map((a) => `${a.position}|${a.street}|${a.actionType}|${a.amountBB}`),
      ordered.map((r) => `${r.seatId.replace('seat_', '')}|${r.street}|${r.actionType}|${r.amountBB}`),
    );

    /* 同输入 ⇒ 同输出（确定性） */
    assert.deepEqual(replayHand(handId, records), replayed);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('P4-4 回放能直接喂回「手动输入」的形状（位置 / 行动类型 / 街道）', () => {
  const h = newHarness();
  try {
    playThreeStreets(h);
    const records = must(loadObservations(h.dir)).records;
    const replayed = must(replayHand(records[0]!.handId, records));

    /* 三个街道都必须真的有行动 —— 否则这个测试会「绿得毫无意义」 */
    const streets = new Set(replayed.actions.map((a) => a.street));
    assert.deepEqual([...streets].sort(), ['FLOP', 'PREFLOP', 'TURN'], '必须真的记到三条街的行动');

    const CANONICAL = new Set(['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
    for (const a of replayed.actions) {
      assert.ok(CANONICAL.has(a.position), `位置必须还原成规范位置，实际「${a.position}」`);
      assert.ok(['FOLD', 'CHECK', 'CALL', 'BET', 'RAISE', 'ALL_IN'].includes(a.actionType));
      assert.ok(['PREFLOP', 'FLOP', 'TURN', 'RIVER'].includes(a.street));
      assert.equal(typeof a.amountBB, 'number');
    }

    /* 街序必须单调不回退 —— 回放出来的序列本身要自洽 */
    const order = ['PREFLOP', 'FLOP', 'TURN', 'RIVER'];
    let last = 0;
    for (const a of replayed.actions) {
      const at = order.indexOf(a.street);
      assert.ok(at >= last, `街道不得回退：${a.street} 出现在 ${order[last]} 之后`);
      last = at;
    }

    assert.equal(replayAllHands(records).length, 1, '这批记录只有一手牌');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

/* ============================================================
 * P4-5 边界：旧记录与矛盾记录
 * ============================================================ */

/** 旧格式记录（本字段存在之前写入的）：完全没有 board / holeCards */
const legacyRecord = (over: Partial<ObservationRecord> = {}): ObservationRecord => ({
  handId: 'legacy#H1',
  playerId: 'p1',
  seatId: 'seat_BTN',
  street: 'FLOP',
  actionType: 'CHECK',
  amountBB: 0,
  facedBet: false,
  toCallBB: 0,
  seq: 1,
  baseRevision: 1,
  historyLength: 1,
  source: 'USER_INPUT',
  saved: true,
  handComplete: false,
  ...over,
});

test('P4-5 旧记录（无牌面字段）照样能读、能分组，但**不得**被当成「有牌」', () => {
  const legacy = legacyRecord();
  assert.equal(legacy.board, undefined);
  assert.equal(legacy.holeCards, undefined);

  const replayed = must(replayHand('legacy#H1', [legacy]));
  assert.deepEqual([...replayed.board], [], '没有公共牌记录 ⇒ 空牌面');
  assert.equal(replayed.heroCards, undefined, '没有底牌记录 ⇒ 缺省（不是空数组）');
  assert.equal(replayed.recordsWithBoard, 0, '如实计数：0 条带牌');
  assert.equal(replayed.recordsWithCards, 0);
  assert.equal(replayed.actions.length, 1, '行动本身仍然还原得出来');
});

test('P4-6 同一手里出现**互不相同**的公共牌 ⇒ 显式失败，绝不拼一个假牌局', () => {
  const a = legacyRecord({ board: ['Kh', '7c', '2d'], historyLength: 1 });
  const b = legacyRecord({ board: ['Ah', 'Qs', '2c'], historyLength: 2, seq: 2 });

  const r = replayHand('legacy#H1', [a, b]);
  assert.equal(r.ok, false, '矛盾的牌面必须失败');
  if (r.ok) return;
  assert.ok(
    r.issues.some((i) => i.code === 'HAND_REPLAY_BOARD_CONFLICT'),
    `必须有 BOARD_CONFLICT，实际 ${JSON.stringify(r.issues.map((i) => i.code))}`,
  );
});

test('P4-7 同一手里出现**互不相同**的底牌 ⇒ 显式失败', () => {
  const a = legacyRecord({ holeCards: ['As', 'Ks'], historyLength: 1 });
  const b = legacyRecord({ holeCards: ['2c', '3d'], historyLength: 2, seq: 2 });

  const r = replayHand('legacy#H1', [a, b]);
  assert.equal(r.ok, false, '矛盾的底牌必须失败');
  if (r.ok) return;
  assert.ok(r.issues.some((i) => i.code === 'HAND_REPLAY_CARDS_CONFLICT'));
});

test('P4-8 座位还原不出位置 ⇒ 显式失败（不猜位置）', () => {
  const r = replayHand('legacy#H1', [legacyRecord({ seatId: 'seat_XYZ' })]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.issues.some((i) => i.code === 'HAND_REPLAY_BAD_SEAT'));
});

test('P4-9 没有该手的记录 ⇒ 显式失败（不是「回放出一手空牌局」）', () => {
  const r = replayHand('nope#H9', [legacyRecord()]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.issues[0]!.code, 'HAND_REPLAY_NO_RECORDS');
});

test('P4-10 前缀合并：翻牌记录 + 转牌记录 ⇒ 公共牌取最长前缀，同一副牌不冲突', () => {
  const flop = legacyRecord({ board: ['Kh', '7c', '2d'], street: 'FLOP', historyLength: 1 });
  const turn = legacyRecord({ board: ['Kh', '7c', '2d', 'Qd'], street: 'TURN', historyLength: 2, seq: 2 });

  const r = must(replayHand('legacy#H1', [flop, turn]));
  assert.deepEqual([...r.board], ['Kh', '7c', '2d', 'Qd'], '同手记录是前缀关系 ⇒ 取最长');
  assert.equal(r.recordsWithBoard, 2);
});
