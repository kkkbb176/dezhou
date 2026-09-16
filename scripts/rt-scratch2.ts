/** 临时排查：请求体超限后的行为（是否影响后续请求） */
import { createTable, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import type { PokerTableState } from '../src/app/table/table.types.ts';
import { startAlphaServer } from '../src/app/webServer.ts';
import { Position } from '../src/domain/types.ts';

const s = await startAlphaServer({ port: 0, logPath: null });
const post = async (body: unknown): Promise<string> => {
  try {
    const res = await fetch(`${s.url}/api/table`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json: any = await res.json();
    return `status=${res.status} ok=${String(json.ok)} code=${String(json.issues?.[0]?.code ?? '-')}`;
  } catch (error) {
    return `FETCH ERROR: ${(error as Error).message}`;
  }
};

const must = (r: ReturnType<typeof applyTableOp>): PokerTableState => {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.state;
};

let st = createTable({ tableSize: 6, heroPosition: Position.BTN });
for (const p of ['UTG', 'HJ', 'CO', 'SB', 'BB']) {
  st = must(applyTableOp(st, { kind: 'ADD_PLAYER', seatId: seatOfPosition(st, p as never)!.seatId }));
}
// 造一个很大的状态：把 actionHistory 灌长（用 SET_STACK 之类不改变牌局的 op 制造撤销栈）
for (let i = 0; i < 55; i += 1) {
  st = must(
    applyTableOp(st, {
      kind: 'SET_STACK',
      seatId: seatOfPosition(st, Position.UTG)!.seatId,
      stackBB: 100 + i,
    }),
  );
}
const size = (x: unknown): number => Buffer.byteLength(JSON.stringify(x), 'utf8');
console.log('normal state body =', (size({ state: st, op: { kind: 'SET_STACK', seatId: 'x', stackBB: 1 } }) / 1024).toFixed(1), 'KB');
console.log('1) 正常大小请求:', await post({ state: st, op: { kind: 'SET_STACK', seatId: 'seat_UTG', stackBB: 100 } }));

// 人为放大到 >128KB：塞入超长 notices
const huge = { ...st, notices: ['x'.repeat(140 * 1024)] };
console.log('huge state body =', (size({ state: huge, op: { kind: 'UNDO' } }) / 1024).toFixed(1), 'KB');
console.log('2) 超大请求:', await post({ state: huge, op: { kind: 'UNDO' } }));
console.log('3) 之后的小请求:', await post({ state: st, op: { kind: 'SET_STACK', seatId: 'seat_UTG', stackBB: 101 } }));
console.log('4) 再来一次:', await post({ state: st, op: { kind: 'SET_STACK', seatId: 'seat_UTG', stackBB: 102 } }));
await s.close();
