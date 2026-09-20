/**
 * STREET STATE CONSISTENCY V2 · 证据探针（只读）
 *  ① 缺陷证据：牌面 5 张 + 转牌行动未结算 ⇒ 预览是否错误宣布「可分析」
 *  ② 未来信息隔离：转牌节点「预先录了第 5 张牌」与「只录 4 张」的权益/EV 是否完全相同
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { createTable } from '../src/app/table/tableState.ts';
import { applyTableOp, engineViewOf } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import { tableStateToManualHandInput } from '../src/app/table/tableAdapter.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';
import { playerById } from '../src/domain/poker/gameState.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';
import type { Position } from '../src/domain/types.ts';

const OPTIONS = { rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 } } as const;
const must = (r: ReturnType<typeof applyTableOp>, l: string): PokerTableState => {
  if (!r.ok) throw new Error(`${l}: ${r.issues.map((i) => i.message).join(' / ')}`);
  return r.state;
};
const legalNow = (s: PokerTableState): Record<string, unknown> => {
  const v = engineViewOf(s);
  if (!v.ok) throw new Error('engineView 失败');
  const id = actorOnTurn(v.engine);
  const p = id === null ? undefined : playerById(v.engine, id);
  if (p === undefined) throw new Error('无行动者');
  return deriveLegalActions(v.engine, p) as unknown as Record<string, unknown>;
};
const step = (s: PokerTableState, op: TableOp): PokerTableState => must(applyTableOp(s, op), op.kind);
const callOp = (s: PokerTableState): TableOp => ({ kind: 'ACT', action: { type: 'CALL', amountChips: Number(legalNow(s)['callCost']) } });

/** 9 人桌 · Hero BTN · 翻前 → 翻牌(3张+行动) → 转牌 1 张 → BB 下注，Hero **未行动** */
function toTurnFacingBet(): PokerTableState {
  let s = createTable({ tableSize: 9, heroPosition: 'BTN' as Position, defaultStackBB: 100 });
  for (const seat of s.seats) { if (seat.playerId === null) s = step(s, { kind: 'ADD_PLAYER', seatId: seat.seatId }); }
  s = step(s, { kind: 'SET_HERO_CARD', card: 'As' });
  s = step(s, { kind: 'SET_HERO_CARD', card: 'Ks' });
  for (let i = 0; i < 20; i++) {
    const v = engineViewOf(s); if (!v.ok) throw new Error('view');
    const id = actorOnTurn(v.engine); const p = id === null ? undefined : playerById(v.engine, id);
    if (p?.position === 'BTN') break;
    s = step(s, { kind: 'ACT', action: { type: 'FOLD' } });
  }
  s = step(s, { kind: 'ACT', action: { type: 'RAISE', amountChips: Number(legalNow(s)['minRaiseToAmount']) } });
  s = step(s, { kind: 'ACT', action: { type: 'FOLD' } });
  s = step(s, callOp(s));
  s = step(s, { kind: 'SET_BOARD_CARD', card: 'Kd', slot: 0 });
  s = step(s, { kind: 'SET_BOARD_CARD', card: '9c', slot: 1 });
  s = step(s, { kind: 'SET_BOARD_CARD', card: '4h', slot: 2 });
  s = step(s, { kind: 'ACT', action: { type: 'CHECK' } });
  s = step(s, { kind: 'ACT', action: { type: 'BET', amountChips: Number(legalNow(s)['minBet']) * 5 } });
  s = step(s, callOp(s));
  s = step(s, { kind: 'SET_BOARD_CARD', card: '6s', slot: 3 });
  s = step(s, { kind: 'ACT', action: { type: 'BET', amountChips: Number(legalNow(s)['minBet']) * 5 } });
  return s;
}

/* ① 缺陷证据 */
let state = toTurnFacingBet();
const before = buildTablePreview(state);
const viewBefore = engineViewOf(state);
console.log('=== ① 转牌面对下注、Hero 未行动（尚未录第 5 张）===');
console.log(`  引擎街=${viewBefore.ok ? viewBefore.engine.street : '—'} ｜ bettingRoundComplete=${viewBefore.ok ? String(viewBefore.engine.bettingRoundComplete) : '—'} ｜ 行动者=${before.currentActorPosition}`);
console.log(`  预览: ready=${String(before.decision.ready)} state=${String(before.decision.state)} reason=${String(before.decision.reasonCode)}｜blockers=${JSON.stringify(before.analyzeBlockers)}`);
const riverOp = applyTableOp(state, { kind: 'SET_BOARD_CARD', card: 'Qh', slot: 4 });
console.log(`  录入河牌 Q♥ 被接受 = ${String(riverOp.ok)}`);
if (riverOp.ok) {
  state = riverOp.state;
  const after = buildTablePreview(state);
  const adapted = tableStateToManualHandInput(state);
  const r = adapted.ok ? analyzeManualHand(adapted.input, OPTIONS) : null;
  console.log('=== ② 录入河牌之后（转牌行动仍未结算）===');
  console.log(`  引擎街=${String((engineViewOf(state) as { engine?: { street?: string } }).engine?.street)} ｜ 预览街=${String(after.street)}`);
  console.log(`  预览: ready=${String(after.decision.ready)} state=${String(after.decision.state)} reason=${String(after.decision.reasonCode)} canAnalyze=${String(after.canAnalyze)}`);
  console.log(`  blockers=${JSON.stringify(after.analyzeBlockers)}`);
  console.log(`  adapter.input.street=${adapted.ok ? String(adapted.input.street) : '—'} ｜ analyzeManualHand: ok=${String(r?.ok)} stage=${String(r?.ok === false ? r.stage : '—')}`);
}

/* ② 未来信息隔离：同一转牌局面，一份只录 4 张、一份预先录了第 5 张，比较权益/EV */
const PF = [
  { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' }, { position: 'UTG2', type: 'FOLD' },
  { position: 'LJ', type: 'FOLD' }, { position: 'HJ', type: 'FOLD' }, { position: 'CO', type: 'FOLD' },
  { position: 'BTN', type: 'RAISE', amountBB: 2 }, { position: 'SB', type: 'FOLD' }, { position: 'BB', type: 'CALL', amountBB: 1 },
];
const base = {
  tableSize: 9, heroPosition: 'BTN', heroCards: ['As', 'Ks'], street: 'TURN',
  effectiveStackBB: 100, bigBlindBB: 50,
  seatStacksBB: { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  actionHistory: [...PF, { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'BTN', type: 'BET', amountBB: 5, street: 'FLOP' }, { position: 'BB', type: 'CALL', amountBB: 5, street: 'FLOP' }, { position: 'BB', type: 'BET', amountBB: 5, street: 'TURN' }],
  environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 },
};
const four = analyzeManualHand({ ...base, board: ['Kd', '9c', '4h', '6s'] } as never, OPTIONS);
const five = analyzeManualHand({ ...base, board: ['Kd', '9c', '4h', '6s', 'Qh'] } as never, OPTIONS);
const pick = (r: typeof four): Record<string, unknown> => {
  if (!r.ok) return { ok: false, stage: r.stage };
  const dg = ((r.decision as unknown as Record<string, any>)['diagnostics'] ?? {}) as Record<string, any>;
  const m = (dg['math'] ?? {}) as Record<string, any>;
  return { ok: true, street: m['street'], heroEquity: m['heroEquity'], callEV: m['callEV'], pot: m['pot'], winnable: m['winnable'], action: (r.decision as unknown as Record<string, any>)['action'] };
};
console.log('=== ③ 未来信息隔离（转牌节点：只录 4 张 vs 预先录了第 5 张）===');
console.log(`  4 张: ${JSON.stringify(pick(four))}`);
console.log(`  5 张: ${JSON.stringify(pick(five))}`);
const a = pick(four); const b = pick(five);
console.log(`  权益/EV 完全相同 = ${String(a['heroEquity'] === b['heroEquity'] && a['callEV'] === b['callEV'] && a['pot'] === b['pot'])}`);
console.log('（探针结束）');
