/**
 * 9 人桌位置映射一致性 · 只读审计探针
 * 对照：seatId / playerId / 引擎位置 / 顶部栏（handTopology）/ 牌桌标签 / 行动顺序
 */
import { createTable, seatOfPosition, seatIdOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import { tableStateToManualHandInput } from '../src/app/table/tableAdapter.ts';
import { handTopologySeats } from '../src/domain/poker/positions.ts';
import { positionsForTableOf } from '../src/domain/types.ts';
import { logicalSeatOrder } from '../src/app/table/tableState.ts';
import type { PokerTableState } from '../src/app/table/table.types.ts';
import type { Position } from '../src/domain/types.ts';

function must(r: ReturnType<typeof applyTableOp>, l: string): PokerTableState {
  if (!r.ok) throw new Error(`${l}: ${r.issues.map((i) => i.message).join(' / ')}`);
  return r.state;
}
let state = createTable({ tableSize: 9, heroPosition: 'CO' as Position, defaultStackBB: 100 });
for (const seat of state.seats) { if (seat.playerId !== null) continue; state = must(applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seat.seatId }), 'ADD'); }

console.log('=== ① state.seats（物理座位数组，索引 → seatId/playerId/logicalPosition）===');
state.seats.forEach((s, i) => console.log(`  [${i}] ${s.seatId} ｜ playerId=${String(s.playerId)} ｜ name=${String(s.playerName)} ｜ logicalPosition=${String(s.logicalPosition)}`));
console.log(`=== ② 权威排列表 ===`);
console.log(`  positionsForTableOf(9) = ${positionsForTableOf(9).join(' → ')}`);
console.log(`  logicalSeatOrder(9)    = ${logicalSeatOrder(9).join(' → ')}`);
console.log(`  座位数组顺序           = ${state.seats.map((s) => String(s.logicalPosition)).join(' → ')}`);
console.log(`  buttonSeatId（state）  = ${state.buttonSeatId} ｜ 其 logicalPosition = ${String(state.seats.find((s) => s.seatId === state.buttonSeatId)?.logicalPosition)}`);

state = must(applyTableOp(state, { kind: 'CLEAR_SEAT', seatId: 'seat_HJ', activeHandChoice: 'KEEP_PLAYING' } as never), 'CLEAR_SEAT');
const positions = state.seats.filter((s) => s.playerId !== null).map((s) => s.logicalPosition);
const buttonPosition = state.seats.find((s) => s.seatId === state.buttonSeatId)!.logicalPosition;
const topo = handTopologySeats(9, positions, buttonPosition);
const ring = logicalSeatOrder(9);
const seatIdAt = (i: number): string => seatIdOfPosition(ring[i]!);
console.log('=== ③ handTopologySeats（预览层用的拓扑）===');
console.log(`  buttonSeatIndex=${topo.buttonSeatIndex}（seatIdAt ⇒ ${seatIdAt(topo.buttonSeatIndex)}）`);
console.log(`  smallBlindSeatIndex=${topo.smallBlindSeatIndex}（seatIdAt ⇒ ${seatIdAt(topo.smallBlindSeatIndex)}）`);
console.log(`  bigBlindSeatIndex=${topo.bigBlindSeatIndex}（seatIdAt ⇒ ${seatIdAt(topo.bigBlindSeatIndex)}）`);
console.log(`  roleBySeatIndex = ${JSON.stringify(topo.roleBySeatIndex)}`);
console.log(`  ↳ 按 seatIdAt 展开 = ${JSON.stringify(Object.fromEntries(Object.entries(topo.roleBySeatIndex).map(([i, r]) => [seatIdAt(Number(i)), r])))}`);
console.log(`  ↳ 若下标其实指「参与者数组」= ${JSON.stringify(Object.fromEntries(Object.entries(topo.roleBySeatIndex).map(([i, r]) => [`participants[${i}]=${String(positions[Number(i)])}`, r])))}`);

const preview = buildTablePreview(state);
const ht = preview.handTopology as Record<string, any> | null;
console.log('=== ④ 顶部栏数据（preview.handTopology）===');
console.log(`  buttonSeatId=${String(ht?.['buttonSeatId'])} → 该座位真实位置=${String(state.seats.find((s) => s.seatId === ht?.['buttonSeatId'])?.logicalPosition)}`);
console.log(`  smallBlindSeatId=${String(ht?.['smallBlindSeatId'])} → ${String(state.seats.find((s) => s.seatId === ht?.['smallBlindSeatId'])?.logicalPosition)}`);
console.log(`  bigBlindSeatId=${String(ht?.['bigBlindSeatId'])} → ${String(state.seats.find((s) => s.seatId === ht?.['bigBlindSeatId'])?.logicalPosition)}`);
console.log(`  rolesBySeatId = ${JSON.stringify(ht?.['rolesBySeatId'])}`);

console.log('=== ⑤ 牌桌标签（preview.seats）===');
for (const s of preview.seats as readonly Record<string, any>[]) {
  console.log(`  ${String(s['seatId'])} ｜ 显示=${String(s['positionZh'])} ｜ isDealer=${String(s['isDealer'])} ｜ playerId=${String(s['playerId'])}`);
}

console.log('=== ⑥ 引擎/适配器 ===');
const adapted = tableStateToManualHandInput(state);
if (adapted.ok) {
  console.log(`  adapter.heroPosition=${String(adapted.input.heroPosition)} ｜ occupiedPositions=${JSON.stringify(adapted.input.occupiedPositions)} ｜ buttonPosition=${String(adapted.input.buttonPosition)}`);
  console.log(`  adapter.primaryOpponentPosition=${String(adapted.primaryOpponentPosition)}`);
}
console.log(`  engineViewOf(preview.currentActorPosition)=${String(preview.currentActorPosition)}（翻前第一个行动者）`);
console.log(`  preview.decision.reasonCode=${String(preview.decision.reasonCode)} state=${String(preview.decision.state)}`);
console.log('（只读探针结束）');
