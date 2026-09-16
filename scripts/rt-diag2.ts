import { Position } from '../src/domain/types.ts';
import { createTable, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';

function must(r: ReturnType<typeof applyTableOp>): PokerTableState {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.state;
}
const ORDER_6: readonly Position[] = [
  Position.UTG,
  Position.HJ,
  Position.CO,
  Position.BTN,
  Position.SB,
  Position.BB,
];
function fullTable(hero: Position): PokerTableState {
  let state = createTable({ tableSize: 6, heroPosition: hero, defaultStackBB: 100 });
  for (const p of ORDER_6) {
    if (p === hero) continue;
    state = must(applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, p)!.seatId }));
  }
  return state;
}
const coreJson = (s: PokerTableState): string => {
  const { undo: _u, revision: _r, ...rest } = s;
  void _u;
  void _r;
  return JSON.stringify(rest);
};

let state = fullTable(Position.CO);
const snapshots: string[] = [coreJson(state)];
const ops: TableOp[] = [
  { kind: 'SET_PROFILE', seatId: seatOfPosition(state, Position.HJ)!.seatId, quickProfile: 'MANIAC' },
  { kind: 'SET_DYNAMIC_HINT', seatId: seatOfPosition(state, Position.HJ)!.seatId, dynamicHint: 'TILT_SIGNAL' },
  { kind: 'SET_STACK', seatId: seatOfPosition(state, Position.HJ)!.seatId, stackBB: 42 },
  { kind: 'CLEAR_SEAT', seatId: seatOfPosition(state, Position.HJ)!.seatId },
  { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, Position.HJ)!.seatId },
  { kind: 'NEXT_HAND' },
  { kind: 'SET_HERO_CARD', card: 'As' },
  { kind: 'SET_HERO_CARD', card: 'Kd' },
  { kind: 'ACT', action: { type: 'FOLD' } },
  { kind: 'SET_HERO_POSITION', position: Position.BTN },
  { kind: 'NEW_TABLE' },
  { kind: 'SET_TABLE_SIZE', tableSize: 9 },
];
for (const [i, op] of ops.entries()) {
  const before = coreJson(state);
  const undoBefore = state.undo.length;
  const r = applyTableOp(state, op);
  if (!r.ok) {
    console.log(`op${i} ${op.kind}: REJECTED ${r.issues[0]!.code}`);
    continue;
  }
  const changed = coreJson(r.state) !== before;
  console.log(
    `op${i} ${op.kind}: ok Δrev=${r.state.revision - state.revision} Δundo=${r.state.undo.length - undoBefore} changed=${changed}`,
  );
  state = r.state;
  snapshots.push(coreJson(state));
}
console.log('undo depth =', state.undo.length, 'snapshots =', snapshots.length);
for (let i = snapshots.length - 2; i >= 0; i -= 1) {
  const u = applyTableOp(state, { kind: 'UNDO' });
  if (!u.ok) {
    console.log(`undo #${i}: REJECTED`);
    break;
  }
  state = u.state;
  const match = coreJson(state) === snapshots[i];
  console.log(`undo #${i}: match=${match} depth=${state.undo.length}`);
  if (!match) {
    const a = coreJson(state);
    const b = snapshots[i]!;
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k += 1;
    console.log('   undone :', a.slice(Math.max(0, k - 90), k + 130));
    console.log('   snapshot:', b.slice(Math.max(0, k - 90), k + 130));
    break;
  }
}
