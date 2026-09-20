/**
 * 只读调试探针：座位 ↔ 玩家 ↔ 记录 的绑定事实（用于定位测试夹具问题，不改产品代码）
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTable, seatIdOfPosition } from '../src/app/table/tableState.ts';
import { applyUserOpWithHistory, loadObservations } from '../src/app/table/playerHistory.ts';
import type { PokerTableState } from '../src/app/table/table.types.ts';
import type { Position } from '../src/domain/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'dsh-dbg-'));
console.log('positions of seatIdOfPosition:', ['UTG', 'CO', 'BTN', 'BB'].map((p) => `${p}=${seatIdOfPosition(p as Position)}`).join(' '));

let state: PokerTableState = createTable({ tableSize: 9, heroPosition: 'BTN' as Position, defaultStackBB: 100 });
console.log('\n=== createTable 后的座位 ===');
for (const s of state.seats) console.log(`  seatId=${s.seatId} logicalPosition=${String(s.logicalPosition)} playerId=${String(s.playerId)}`);

const coSeatId = seatIdOfPosition('CO' as Position);
console.log(`\n绑定目标 seatId = ${coSeatId}`);
for (const seat of [...state.seats]) {
  if (seat.playerId !== null) continue;
  const r = applyUserOpWithHistory({
    state,
    op: {
      kind: 'ADD_PLAYER',
      seatId: seat.seatId,
      ...(seat.seatId === coSeatId ? { playerId: 'player_001', displayName: '阿豪' } : {}),
    },
    historyDir: dir,
  });
  if (!r.outcome.ok) {
    console.log(`  ADD_PLAYER ${seat.seatId} 被拒：${r.outcome.issues.map((i) => i.message).join(' / ')}`);
    continue;
  }
  state = r.outcome.state;
}
console.log('\n=== 加人后的座位 ===');
for (const s of state.seats) console.log(`  seatId=${s.seatId} logicalPosition=${String(s.logicalPosition)} playerId=${String(s.playerId)}`);
console.log('\nplayersById =', Object.keys(state.playersById).join(', '));

/** 让 UTG 弃牌（产生一条记录），看记录挂在谁头上 */
const acted = applyUserOpWithHistory({ state, op: { kind: 'ACT', action: { type: 'FOLD' } }, historyDir: dir });
if (!acted.outcome.ok) console.log('ACT 被拒：', acted.outcome.issues.map((i) => i.message).join(' / '));
else {
  const loaded = loadObservations(dir);
  console.log('\n=== 记录（首条） ===');
  if (loaded.ok) console.log(JSON.stringify(loaded.records.slice(0, 3), null, 1));
  else console.log('读取失败', loaded.issues);
}
