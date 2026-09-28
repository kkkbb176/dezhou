/* 诊断 P4 测试脚手架：为什么翻前没打完？逐条打印。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyUserOpWithHistory } from '../src/app/table/playerHistory.ts';
import { createTable } from '../src/app/table/tableState.ts';
import { engineViewOf } from '../src/app/table/tableOps.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';

const dir = mkdtempSync(join(tmpdir(), 'p4-diag-'));
let state: PokerTableState = createTable({ tableSize: 6 });
const apply = (op: TableOp): void => {
  const r = applyUserOpWithHistory({ state, op, historyDir: dir });
  assert.equal(r.outcome.ok, true, `${op.kind} 失败 ${JSON.stringify((r.outcome.issues ?? []).map((i) => i.code))}`);
  state = (r.outcome as { ok: true; state: PokerTableState }).state;
};

const view = (): { id: string | null; street: string; cc: number; canRaise: boolean; minTo: number; allInTo: number } => {
  const v = engineViewOf(state);
  if (!v.ok) return { id: null, street: '?', cc: 0, canRaise: false, minTo: 0, allInTo: 0 };
  const id = actorOnTurn(v.engine);
  const me = id === null ? undefined : v.engine.players.find((p) => p.id === id);
  const l = me === undefined ? null : deriveLegalActions(v.engine, me);
  return {
    id,
    street: String(v.engine.street),
    cc: l?.callCost ?? 0,
    canRaise: l?.canRaise ?? false,
    minTo: l?.minRaiseToAmount ?? 0,
    allInTo: l?.allInToAmount ?? 0,
  };
};

apply({ kind: 'FILL_EMPTY_SEATS' });
apply({ kind: 'SET_HERO_CARD', card: 'As' });
apply({ kind: 'SET_HERO_CARD', card: 'Ks' });
console.log(`heroPosition=${state.heroPosition} heroPlayerId=${state.heroPlayerId}`);
console.log(`heroSeat(engine id) 猜测 = seat_${state.heroPosition}`);
console.log(`引擎里的 hero 实际 id = ${view().id === null ? '无' : JSON.stringify(engineViewOf(state).ok ? (engineViewOf(state) as { ok: true; engine: { players: readonly { id: string; holeCards: unknown }[] } }).engine.players.filter((p) => p.holeCards !== null).map((p) => p.id) : [])}`);

for (let i = 0; i < 12; i += 1) {
  const s = view();
  console.log(
    `#${i} 行动者=${s.id} street=${s.street} 需跟注=${s.cc} canRaise=${s.canRaise} minTo=${s.minTo} allInTo=${s.allInTo}`,
  );
  if (s.id === null) {
    console.log('   ⇒ 没有行动者，停');
    break;
  }
  if (s.street !== 'PREFLOP') {
    console.log(`   ⇒ 已进入 ${s.street}，停`);
    break;
  }
  if (s.cc > 0) apply({ kind: 'ACT', action: { type: 'CALL', amountChips: s.cc } });
  else apply({ kind: 'ACT', action: { type: 'CHECK' } });
}
console.log(`最终 street=${view().street}`);

console.log('\n=== 录入翻牌 3 张后 ===');
apply({ kind: 'SET_BOARD_CARD', card: 'Kh', slot: 0 });
apply({ kind: 'SET_BOARD_CARD', card: '7c', slot: 1 });
apply({ kind: 'SET_BOARD_CARD', card: '2d', slot: 2 });
console.log(`牌桌 board = ${state.board.join(' ')}`);
const v = engineViewOf(state);
console.log(`engineViewOf.ok=${v.ok}`);
if (v.ok) {
  console.log(`  street=${String(v.engine.street)} bettingRoundComplete=${String(v.engine.bettingRoundComplete)}`);
  console.log(`  board切片=${v.engine.board.flop.length}/${v.engine.board.turn.length}/${v.engine.board.river.length}`);
  console.log(`  boardCards=${v.boardCards.length} 张`);
  console.log(`  行动者=${actorOnTurn(v.engine)}`);
} else {
  for (const i of v.issues) console.log(`  ✖ ${i.code}: ${i.message}`);
}
console.log(`牌桌 actionHistory 长度 = ${state.actionHistory.length}`);

rmSync(dir, { recursive: true, force: true });
