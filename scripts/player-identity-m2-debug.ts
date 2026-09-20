/** M2 调试（一次性，只读） */
import { Position } from '../src/domain/types.ts';
import { createTable, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import { parseTableState } from '../src/app/table/tableApi.ts';
import { tableStateToManualHandInput, primaryOpponentPosition } from '../src/app/table/tableAdapter.ts';
import { SeatStatus, type PokerTableState, type TableOp } from '../src/app/table/table.types.ts';

const must = (r: ReturnType<typeof applyTableOp>): PokerTableState => {
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join(' / '));
  return r.state;
};
const dump = (tag: string, s: PokerTableState): void => {
  console.log(`--- ${tag} (rev ${s.revision}) ---`);
  for (const seat of s.seats) {
    console.log(`  ${seat.seatId.padEnd(8)} pos=${String(seat.logicalPosition).padEnd(3)} player=${String(seat.playerId).padEnd(5)} status=${seat.status}`);
  }
  const adapted = tableStateToManualHandInput(s);
  console.log(`  primary=${String(primaryOpponentPosition(s))} adapt=${adapted.ok ? JSON.stringify(adapted.input.villain) : JSON.stringify(adapted.issues)}`);
};

let state = createTable({ tableSize: 6, heroPosition: Position.BTN, defaultStackBB: 100, bigBlindBB: 2 });
for (const p of [Position.UTG, Position.HJ, Position.CO, Position.SB, Position.BB]) {
  state = must(applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, p)!.seatId }));
}
dump('0 建桌', state);

const ops: TableOp[] = [
  { kind: 'SET_HERO_CARD', card: 'As' }, { kind: 'SET_HERO_CARD', card: 'Ah' },
  { kind: 'ACT', action: { type: 'FOLD' } }, { kind: 'ACT', action: { type: 'FOLD' } },
  { kind: 'ACT', action: { type: 'CALL', amountChips: 2 } },
  { kind: 'ACT', action: { type: 'RAISE', amountChips: 6 } },
  { kind: 'ACT', action: { type: 'FOLD' } }, { kind: 'ACT', action: { type: 'FOLD' } },
  { kind: 'ACT', action: { type: 'CALL', amountChips: 4 } },
  { kind: 'SET_BOARD_CARD', card: 'Ad', slot: 0 }, { kind: 'SET_BOARD_CARD', card: '9c', slot: 1 },
  { kind: 'SET_BOARD_CARD', card: '4h', slot: 2 },
  { kind: 'ACT', action: { type: 'CHECK' } }, { kind: 'ACT', action: { type: 'BET', amountChips: 5 } },
  { kind: 'ACT', action: { type: 'CALL', amountChips: 5 } },
  { kind: 'SET_BOARD_CARD', card: '6s', slot: 3 },
  { kind: 'ACT', action: { type: 'CHECK' } }, { kind: 'ACT', action: { type: 'BET', amountChips: 15 } },
  { kind: 'ACT', action: { type: 'CALL', amountChips: 15 } },
  { kind: 'SET_BOARD_CARD', card: '2d', slot: 4 },
  { kind: 'ACT', action: { type: 'BET', amountChips: 20 } },
];
for (const op of ops) state = must(applyTableOp(state, op));
dump('1 第一手（caller=CO）', state);

/* ---- M2 序列：NEXT_HAND → 腾空 CO → 把 BB 的玩家搬到 CO → BB 补陌生人 → 重放同一线（caller=CO） ---- */
const bbSeatId = seatOfPosition(state, Position.BB)!.seatId;
const coSeatId = seatOfPosition(state, Position.CO)!.seatId;
let next = must(applyTableOp(state, { kind: 'NEXT_HAND' }));
dump('2 NEXT_HAND', next);
next = must(applyTableOp(next, { kind: 'CLEAR_SEAT', seatId: coSeatId }));
dump('3 清空 CO', next);

const from = next.seats.find((s) => s.seatId === bbSeatId)!;
const movedPlayerId = from.playerId!;
const seats = next.seats.map((s) => {
  if (s.seatId === bbSeatId) return { ...s, playerId: null, status: SeatStatus.EMPTY };
  if (s.seatId === coSeatId) return { ...s, playerId: movedPlayerId, status: SeatStatus.SEATED_ACTIVE, stackBB: from.stackBB };
  return { ...s };
});
const movedRaw = { ...next, seats: Object.freeze(seats), notices: Object.freeze([]) };
const parsedMoved = parseTableState({ ...movedRaw });
console.log('parseTableState(moved).ok =', parsedMoved.ok, parsedMoved.ok ? '' : JSON.stringify(parsedMoved.issues));
const moved = parsedMoved.ok ? parsedMoved.state : (movedRaw as PokerTableState);
dump('4 阿豪 → CO', moved);
next = must(applyTableOp(moved, { kind: 'ADD_PLAYER', seatId: bbSeatId }));
dump('5 BB 补陌生人', next);

const ops2: TableOp[] = [
  { kind: 'SET_HERO_CARD', card: 'As' }, { kind: 'SET_HERO_CARD', card: 'Ah' },
  { kind: 'ACT', action: { type: 'FOLD' } }, { kind: 'ACT', action: { type: 'FOLD' } },
  { kind: 'ACT', action: { type: 'CALL', amountChips: 2 } },
  { kind: 'ACT', action: { type: 'RAISE', amountChips: 6 } },
  { kind: 'ACT', action: { type: 'FOLD' } }, { kind: 'ACT', action: { type: 'FOLD' } },
  { kind: 'ACT', action: { type: 'CALL', amountChips: 4 } },
  { kind: 'SET_BOARD_CARD', card: 'Ad', slot: 0 }, { kind: 'SET_BOARD_CARD', card: '9c', slot: 1 },
  { kind: 'SET_BOARD_CARD', card: '4h', slot: 2 },
  { kind: 'ACT', action: { type: 'CHECK' } }, { kind: 'ACT', action: { type: 'BET', amountChips: 5 } },
  { kind: 'ACT', action: { type: 'CALL', amountChips: 5 } },
  { kind: 'SET_BOARD_CARD', card: '6s', slot: 3 },
  { kind: 'ACT', action: { type: 'CHECK' } }, { kind: 'ACT', action: { type: 'BET', amountChips: 15 } },
  { kind: 'ACT', action: { type: 'CALL', amountChips: 15 } },
  { kind: 'SET_BOARD_CARD', card: '2d', slot: 4 },
  { kind: 'ACT', action: { type: 'BET', amountChips: 20 } },
];
for (const op of ops2) next = must(applyTableOp(next, op));
dump('6 第二手（caller=CO，阿豪在 CO）', next);
