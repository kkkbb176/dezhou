/*
 * P4 探针：牌局记录能不能回放？—— 先确认**数据源到底有什么**，不推断。
 *
 * 回答三个问题：
 * ① 每条行动发生「之前」，引擎状态里的公共牌是什么（`engine.board` 分街切片）？
 * ② `engineViewOf(...).boardCards`（用户已录入的公共牌）是否比 `engine.board` 更可靠？
 * ③ 每个玩家的 `holeCards` 在引擎里是什么形态、哪些人拿得到？
 *
 * 只读：不改任何生产文件、不写任何生产数据（历史目录是临时目录）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyUserOpWithHistory, loadObservations } from '../src/app/table/playerHistory.ts';
import { createTable } from '../src/app/table/tableState.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';
import { engineViewOf } from '../src/app/table/tableOps.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';

const dir = mkdtempSync(join(tmpdir(), 'p4-probe-'));
let state: PokerTableState = createTable({ tableSize: 6 });

const apply = (op: TableOp): PokerTableState => {
  const r = applyUserOpWithHistory({ state, op, historyDir: dir });
  if (!r.outcome.ok) {
    throw new Error(`op ${op.kind} 失败：${JSON.stringify((r.outcome.issues ?? []).map((i) => i.code))}`);
  }
  state = r.outcome.state;
  return state;
};

const engineIdOf = (s: PokerTableState): string | null => {
  const v = engineViewOf(s);
  return v.ok ? actorOnTurn(v.engine) : null;
};

const callCostOf = (s: PokerTableState, id: string): number => {
  const v = engineViewOf(s);
  if (!v.ok) return 0;
  const me = v.engine.players.find((p) => p.id === id);
  return me === undefined ? 0 : deriveLegalActions(v.engine, me).callCost;
};

const describe = (s: PokerTableState): string => {
  const v = engineViewOf(s);
  if (!v.ok) return `view 失败：${JSON.stringify(v.issues.map((i) => i.code))}`;
  const e = v.engine;
  const boardSliced = `${e.board.flop.length}/${e.board.turn.length}/${e.board.river.length}`;
  const boardChars = v.boardCards.map((c) => `${c.rank}${c.suit}`).join(' ') || '（空）';
  const holes = e.players
    .map((p) => `${p.id}:${p.holeCards === null ? 'null' : p.holeCards.map((c) => `${c.rank}${c.suit}`).join('')}`)
    .join(' ');
  return `street=${e.street} board切片[flop/turn/river]=${boardSliced} boardCards=「${boardChars}」\n              holes=[${holes}]`;
};

const act = (what: { type: 'FOLD' | 'CHECK' | 'CALL' | 'RAISE' }, label = ''): void => {
  const id = engineIdOf(state);
  if (id === null) throw new Error('没有行动者');
  const cc = callCostOf(state, id);
  console.log(`\n—— ${label}即将行动：${id}（需跟注 ${cc} 筹码）`);
  console.log(`   行动前：${describe(state)}`);
  /*
   * 🔴 `CALL` **必须显式给出金额**（引擎 `doCall` 在 `amount === undefined` 时直接
   * 抛 `CALL_AMOUNT_ILLEGAL`），且口径是「本次补入的筹码」，不是本街累计。
   */
  const action =
    what.type === 'CALL'
      ? { type: 'CALL' as const, amountChips: cc }
      : what.type === 'RAISE'
        ? { type: 'RAISE' as const, amountChips: 250 }
        : { type: what.type };
  apply({ kind: 'ACT', action } as TableOp);
  console.log(`   行动后：${describe(state)}`);
};

console.log('=== 建桌 ===');
apply({ kind: 'FILL_EMPTY_SEATS' });
apply({ kind: 'SET_HERO_CARD', card: 'As' });
apply({ kind: 'SET_HERO_CARD', card: 'Ks' });
console.log(`Hero 手牌 = ${state.heroCards.join(' ')}；heroPosition=${state.heroPosition}；heroPlayerId=${state.heroPlayerId}`);
console.log(`牌桌自己的 board（string[]）= ${state.board.join(' ') || '（空）'}`);

const heroEngineSeat = `seat_${state.heroPosition}`;
console.log(`\n=== 翻前：Hero（${heroEngineSeat}）之外的都弃牌 ⇒ 只剩 Hero，推进到翻牌 ===`);
let guard = 0;
for (;;) {
  if (++guard > 20) break;
  const id = engineIdOf(state);
  if (id === null) break;
  const cc = callCostOf(state, id);
  if (id === heroEngineSeat) {
    if (cc > 0) act({ type: 'CALL' }, '[hero] ');
    else act({ type: 'CHECK' }, '[hero] ');
  } else {
    act({ type: 'FOLD' }, '');
  }
  const v = engineViewOf(state);
  if (v.ok && (v.engine.street === 'FLOP' || v.engine.street === 'TURN' || v.engine.street === 'RIVER')) {
    console.log(`\n✅ 已推进到 ${v.engine.street}`);
    break;
  }
}

console.log('\n=== 录入翻牌 3 张后（此时 hero 与 villain 都还在）===');
apply({ kind: 'SET_BOARD_CARD', card: 'Kh', slot: 0 });
apply({ kind: 'SET_BOARD_CARD', card: '7c', slot: 1 });
apply({ kind: 'SET_BOARD_CARD', card: '2d', slot: 2 });
console.log(`牌桌 board = ${state.board.join(' ')}`);
console.log(describe(state));

console.log('\n=== 再录入转牌 ===');
apply({ kind: 'SET_BOARD_CARD', card: 'Qd', slot: 3 });
console.log(`牌桌 board = ${state.board.join(' ')}`);
console.log(describe(state));

console.log('\n=== 写出的记录（全部）===');
const loaded = loadObservations(dir);
if (loaded.ok) {
  for (const r of loaded.records) {
    console.log(
      JSON.stringify({
        handId: r.handId,
        playerId: r.playerId,
        seatId: r.seatId,
        street: r.street,
        actionType: r.actionType,
        potBB: r.potBB,
      }),
    );
  }
  console.log(`记录总数 = ${loaded.records.length}`);
} else {
  console.log('读取失败', loaded.issues);
}

rmSync(dir, { recursive: true, force: true });
