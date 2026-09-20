/**
 * 只读调试：河牌「面对下注」记录为什么没被判成 facedBet（不改产品代码）
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTable, seatIdOfPosition } from '../src/app/table/tableState.ts';
import { engineViewOf, applyTableOp } from '../src/app/table/tableOps.ts';
import { applyUserOpWithHistory, deriveObservations, loadObservations } from '../src/app/table/playerHistory.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';
import { playerById } from '../src/domain/poker/gameState.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';
import type { Position } from '../src/domain/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'dsh-dbg2-'));
const apply = (s: PokerTableState, op: TableOp): PokerTableState => {
  /** ⚠️ 改为走**生产包装器**（与测试同一路径），以便复现记录缺失 */
  const r = applyUserOpWithHistory({ state: s, op, historyDir: dir });
  if (!r.outcome.ok) throw new Error(`${op.kind}: ${r.outcome.issues.map((i) => i.message).join(' / ')}`);
  if (r.historyIssues.length > 0) console.log(`  ⚠️ ${op.kind} 历史问题：${r.historyIssues.map((i) => i.code).join(',')}`);
  return r.outcome.state;
};
const info = (s: PokerTableState): string => {
  const v = engineViewOf(s);
  if (!v.ok) return `engineView FAILED: ${v.issues.map((i) => i.message).join(' / ')}`;
  const id = actorOnTurn(v.engine);
  const p = id === null ? undefined : playerById(v.engine, id);
  const cost = p === undefined ? null : deriveLegalActions(v.engine, p).callCost;
  return `street=${v.engine.street} actor=${String(p?.position)} callCost=${String(cost)} historyLen=${s.actionHistory.length}`;
};
const legalOf = (s: PokerTableState): Record<string, unknown> => {
  const v = engineViewOf(s);
  if (!v.ok) throw new Error('view');
  const id = actorOnTurn(v.engine);
  const p = id === null ? undefined : playerById(v.engine, id);
  if (p === undefined) throw new Error('no actor');
  return deriveLegalActions(v.engine, p) as unknown as Record<string, unknown>;
};
const actorPos = (s: PokerTableState): string => {
  const v = engineViewOf(s);
  if (!v.ok) throw new Error('view');
  const id = actorOnTurn(v.engine);
  const p = id === null ? undefined : playerById(v.engine, id);
  return String(p?.position);
};
const foldUntil = (s: PokerTableState, pos: string): PokerTableState => {
  let c = s;
  for (let i = 0; i < 14 && actorPos(c) !== pos; i += 1) c = apply(c, { kind: 'ACT', action: { type: 'FOLD' } });
  return c;
};

let s = createTable({ tableSize: 9, heroPosition: 'BTN' as Position, defaultStackBB: 100 });
for (const seat of [...s.seats]) {
  if (seat.playerId !== null) continue;
  s = apply(s, {
    kind: 'ADD_PLAYER',
    seatId: seat.seatId,
    ...(seat.seatId === seatIdOfPosition('CO' as Position) ? { playerId: 'player_001', displayName: '阿豪' } : {}),
  });
}
s = apply(s, { kind: 'SET_HERO_CARD', card: 'As' });
s = apply(s, { kind: 'SET_HERO_CARD', card: 'Ks' });
console.log('add players + hero cards:', info(s));

s = foldUntil(s, 'CO');
s = apply(s, { kind: 'ACT', action: { type: 'CALL', amountChips: Number(legalOf(s)['callCost']) } });
s = foldUntil(s, 'BTN');
s = apply(s, { kind: 'ACT', action: { type: 'RAISE', amountChips: Number(legalOf(s)['minRaiseToAmount']) } });
s = foldUntil(s, 'CO');
s = apply(s, { kind: 'ACT', action: { type: 'CALL', amountChips: Number(legalOf(s)['callCost']) } });
for (const [i, card] of ['Jh', '8s', 'Qs'].entries()) s = apply(s, { kind: 'SET_BOARD_CARD', card, slot: i });
s = foldUntil(s, 'CO');
s = apply(s, { kind: 'ACT', action: { type: 'CHECK' } });
s = foldUntil(s, 'BTN');
s = apply(s, { kind: 'ACT', action: { type: 'BET', amountChips: Number(legalOf(s)['minBet']) * 3 } });
s = foldUntil(s, 'CO');
s = apply(s, { kind: 'ACT', action: { type: 'CALL', amountChips: Number(legalOf(s)['callCost']) } });
s = apply(s, { kind: 'SET_BOARD_CARD', card: 'Kh', slot: 3 });
s = foldUntil(s, 'CO');
s = apply(s, { kind: 'ACT', action: { type: 'CHECK' } });
s = foldUntil(s, 'BTN');
s = apply(s, { kind: 'ACT', action: { type: 'BET', amountChips: Number(legalOf(s)['minBet']) * 3 } });
s = foldUntil(s, 'CO');
s = apply(s, { kind: 'ACT', action: { type: 'CALL', amountChips: Number(legalOf(s)['callCost']) } });
s = apply(s, { kind: 'SET_BOARD_CARD', card: 'Kd', slot: 4 });
s = foldUntil(s, 'CO');
s = apply(s, { kind: 'ACT', action: { type: 'CHECK' } });
console.log('河牌 CO 过牌后:', info(s));
console.log('  engineViewOf(before) 详情:', JSON.stringify(engineViewOf(s).ok ? 'ok' : engineViewOf(s)));

s = foldUntil(s, 'BTN');
const beforeBet = s;
s = apply(s, { kind: 'ACT', action: { type: 'BET', amountChips: Number(legalOf(s)['minBet']) * 4 } });
console.log('Hero 河牌下注后:', info(s));

const beforeFold = s;
console.log('  下注前 info:', info(beforeBet));
const derived = deriveObservations(beforeFold, beforeFold);
console.log('  deriveObservations(before,before) 长度（应为 0）=', derived.length);
const before = foldUntil(s, 'CO');
console.log('  轮到 CO 时 info:', info(before));
const after = apply(before, { kind: 'ACT', action: { type: 'FOLD' } });
const recs = deriveObservations(before, after);
console.log('  CO 弃牌后 deriveObservations =', JSON.stringify(recs, null, 1));
const loaded = loadObservations(dir);
/** 决定性检查：把**同一步操作**再走一次包装器，看它到底记了几条 */
{
  const probeDir = mkdtempSync(join(tmpdir(), 'dsh-dbg3-'));
  const direct = applyUserOpWithHistory({ state: before, op: { kind: 'ACT', action: { type: 'FOLD' } }, historyDir: probeDir });
  console.log('\n=== 决定性检查：同一步 FOLD 走包装器 ===');
  console.log('  outcome.ok=', direct.outcome.ok, ' recorded=', direct.recorded, ' skipped=', direct.skippedDuplicates,
    ' issues=', direct.historyIssues.map((i) => i.code).join(','));
  const p = loadObservations(probeDir);
  console.log('  落盘条数=', p.ok ? p.records.length : 'read fail');
  if (p.ok && p.records.length > 0) console.log('  落盘首条=', JSON.stringify(p.records[0]));
}
if (loaded.ok) {
  console.log('\n=== 包装器路径下的全部落盘记录 ===');
  for (const r of loaded.records) {
    console.log(`  ${r.street.padEnd(7)} ${r.actionType.padEnd(6)} ${r.playerId.padEnd(11)} facedBet=${String(r.facedBet)} toCall=${r.toCallBB} amount=${r.amountBB} hand=${r.handId}`);
  }
  console.log(`  合计 ${loaded.records.length} 条`);
  const mine = loaded.records.filter((r) => r.playerId === 'player_001' && r.street === 'RIVER' && r.facedBet);
  console.log(`  其中 player_001 在河牌面对下注 = ${mine.length} 条（期望 ≥1）`);
} else {
  console.log('  读取失败', loaded.issues);
}
