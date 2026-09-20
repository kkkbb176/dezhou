/**
 * 跨阶段发牌与行动状态一致性 · 只读审计探针
 *
 * 复现用户报告：9 人桌 / Hero BTN / A♠K♠ / 转牌对手下注、Hero 未行动
 * ⇒ 录入河牌 Q♥ ⇒ 牌桌显示与重建状态是否一致？
 *
 * 全程使用**生产入口**：`createTable` / `applyTableOp` / `engineViewOf` /
 * `buildTablePreview` / `tableStateToManualHandInput` / `reconstructGameState` / `analyzeManualHand`。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { createTable, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp, engineViewOf } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import { tableStateToManualHandInput } from '../src/app/table/tableAdapter.ts';
import { reconstructGameState, ReconstructMode } from '../src/app/manualInput/reconstruct.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';
import { playerById } from '../src/domain/poker/gameState.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { STREET_ZH } from '../src/app/manualInput/manualInput.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';
import type { Position } from '../src/domain/types.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const n = (v: unknown): string => (typeof v === 'number' ? String(v) : String(v));
const j = (v: unknown, cap = 400): string => { const s = JSON.stringify(v) ?? 'undefined'; return s.length > cap ? `${s.slice(0, cap)}…` : s; };

function must(r: ReturnType<typeof applyTableOp>, label: string): PokerTableState {
  if (!r.ok) throw new Error(`${label} 被拒绝：${r.issues.map((i) => i.message).join(' / ')}`);
  return r.state;
}
function drive(start: PokerTableState, ops: readonly TableOp[]): PokerTableState {
  let s = start;
  for (const op of ops) s = must(applyTableOp(s, op), op.kind);
  return s;
}
/** 当前行动者所在的座位 id（由后端判定，不靠前端） */
function actorSeatId(state: PokerTableState): string | null {
  const view = engineViewOf(state);
  if (!view.ok) return null;
  const id = actorOnTurn(view.engine);
  return id;
}
function actorPosition(state: PokerTableState): string {
  const id = actorSeatId(state);
  if (id === null) return '（无人 / 解析失败）';
  const seat = state.seats.find((s) => s.playerId !== null && `seat_${s.logicalPosition}` === id);
  return seat !== undefined ? `${seat.logicalPosition}(${seat.playerName ?? seat.playerId})` : id;
}
/** 当前行动者的合法动作（由 Poker Core 给出，探针不猜金额） */
function legalNow(state: PokerTableState): Record<string, unknown> | null {
  const view = engineViewOf(state);
  if (!view.ok) return null;
  const id = actorOnTurn(view.engine);
  if (id === null) return null;
  const player = playerById(view.engine, id);
  if (player === undefined) return null;
  const legal = deriveLegalActions(view.engine, player) as unknown as Record<string, unknown>;
  return {
    actions: legal['actions'],
    callCost: legal['callCost'],
    minRaiseToAmount: legal['minRaiseToAmount'],
    minBet: legal['minBet'],
    allInToAmount: legal['allInToAmount'],
    currentBet: legal['currentBet'],
  };
}
/** 跟注请求（金额 = 引擎给的本次补入） */
function callAction(state: PokerTableState): TableOp {
  const legal = legalNow(state);
  return { kind: 'ACT', action: { type: 'CALL', amountChips: Number(legal === null ? 0 : legal['callCost']) } };
}
/** 一个「合法且非最小」的下注额（取最小下注额的 5 倍，夹在合法区间内） */
function betAmount(state: PokerTableState): number {
  const legal = legalNow(state);
  if (legal === null) return 2;
  const minBet = Number(legal['minBet']);
  const allIn = Number(legal['allInToAmount']);
  return Math.max(minBet, Math.min(allIn, minBet * 5));
}
function snapshot(tag: string, state: PokerTableState): void {
  const view = engineViewOf(state);
  const preview = buildTablePreview(state);
  const adapted = tableStateToManualHandInput(state);
  console.log(`\n──────── ${tag} ────────`);
  console.log(`  牌桌: board=[${state.board.join(' ')}] (${state.board.length} 张) ｜ actionHistory=${state.actionHistory.length} 条 ｜ handActive=${String(state.handActive)}`);
  console.log(`  牌桌最后 3 条行动: ${j(state.actionHistory.slice(-3).map((a) => `${String(a.street)} ${String(a.position)} ${String(a.type)}${a.amountBB === undefined ? '' : ` ${n(a.amountBB)}BB`}`), 240)}`);
  console.log(`  engineViewOf: ok=${String(view.ok)}${view.ok ? ` ｜ street=${String(view.engine.street)}(${STREET_ZH[view.engine.street]}) bettingRoundComplete=${String(view.engine.bettingRoundComplete)} 行动者=${actorPosition(state)}` : ` ｜ issues=${j(view.issues, 200)}`}`);
  console.log(`  preview: street=${String(preview.street)} streetZh=${String(preview.streetZh)} ｜ boardSelectionInProgress=${String(preview.boardSelectionInProgress)} ｜ handComplete=${String(preview.handComplete)} ｜ bettingRoundComplete=${String((preview.engine ?? {})['bettingRoundComplete'])}`);
  console.log(`  preview.blockers=${j(preview.analyzeBlockers, 300)}`);
  console.log(`  preview.notices=${j(preview.notices, 300)}`);
  if (!adapted.ok) {
    console.log(`  adapter: ✖ ${j(adapted.issues, 240)}`);
  } else {
    console.log(`  adapter: input.street=${String(adapted.input.street)} ｜ input.board=${adapted.input.board.length} 张 ｜ actionHistory=${adapted.input.actionHistory.length} 条`);
    const parsed = parseManualInput(adapted.input);
    if (!parsed.ok) {
      console.log(`  parseManualInput: ✖ ${j(parsed.issues, 200)}`);
    } else {
      const rp = reconstructGameState(parsed.value, { mode: ReconstructMode.PREVIEW });
      console.log(`  reconstruct(PREVIEW): ok=${String(rp.ok)}${rp.ok ? ` ｜ street=${String(rp.state.street)} bettingRoundComplete=${String(rp.state.bettingRoundComplete)}` : ` ｜ issues=${j(rp.issues, 300)}`}`);
      const rd = reconstructGameState(parsed.value, { mode: ReconstructMode.DECISION });
      console.log(`  reconstruct(DECISION): ok=${String(rd.ok)}${rd.ok ? ` ｜ street=${String(rd.state.street)}` : ` ｜ issues=${j(rd.issues, 300)}`}`);
    }
    const r = analyzeManualHand(adapted.input, OPTIONS);
    console.log(`  analyzeManualHand: ok=${String(r.ok)}${r.ok ? ` ｜ 动作=${String((r.decision as Record<string, unknown>)['action'])}` : ` ｜ stage=${String(r.stage)} issues=${j(r.issues, 320)}`}`);
  }
}

/* ============================================================
 * 建桌：9 人桌 · Hero BTN · A♠K♠
 * ============================================================ */
let state = createTable({ tableSize: 9, heroPosition: 'BTN' as Position, defaultStackBB: 100 });
for (const seat of state.seats) {
  if (seat.logicalPosition === ('BTN' as Position)) continue;
  state = must(applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seat.seatId }), 'ADD_PLAYER');
}
state = drive(state, [
  { kind: 'SET_HERO_CARD', card: 'As' },
  { kind: 'SET_HERO_CARD', card: 'Ks' },
]);
console.log('='.repeat(112));
console.log('§0 建桌完成');
console.log(`  本手位置顺序 = ${state.seats.filter((s) => s.playerId !== null).map((s) => String(s.logicalPosition)).join(' → ')}`);
console.log(`  Hero = ${String(state.heroPosition)} ｜ 行动者 = ${actorPosition(state)}`);

/* ---- 翻前：Hero 之前全部弃牌 → BTN 加注（金额取引擎给的最小加注额）→ SB 弃 → BB 跟注 ---- */
for (let i = 0; i < 20; i++) {
  if (actorPosition(state).startsWith('BTN')) break;
  state = must(applyTableOp(state, { kind: 'ACT', action: { type: 'FOLD' } }), 'FOLD');
}
{
  const legal = legalNow(state)!;
  console.log(`  BTN 的合法动作 = ${j(legal, 240)}`);
  state = must(applyTableOp(state, { kind: 'ACT', action: { type: 'RAISE', amountChips: Number(legal['minRaiseToAmount']) } }), 'BTN RAISE');
}
state = must(applyTableOp(state, { kind: 'ACT', action: { type: 'FOLD' } }), 'SB FOLD');
state = must(applyTableOp(state, callAction(state)), 'BB CALL');
console.log(`\n§1 翻前结束：board=${state.board.length} 张 ｜ 行动者=${actorPosition(state)} ｜ 最后 3 条=${j(state.actionHistory.slice(-3).map((a) => `${String(a.position)} ${String(a.type)}`), 120)}`);

/* ---- 录翻牌 3 张 → 翻牌行动（BB 过牌 / BTN 下注 8 / BB 跟注）---- */
state = drive(state, [
  { kind: 'SET_BOARD_CARD', card: 'Kd', slot: 0 },
  { kind: 'SET_BOARD_CARD', card: '9c', slot: 1 },
  { kind: 'SET_BOARD_CARD', card: '4h', slot: 2 },
]);
snapshot('§2 录入翻牌 3 张（尚未有任何翻牌行动）', state);
state = must(applyTableOp(state, { kind: 'ACT', action: { type: 'CHECK' } }), 'FLOP BB CHECK');
state = must(applyTableOp(state, { kind: 'ACT', action: { type: 'BET', amountChips: betAmount(state) } }), 'FLOP BTN BET');
state = must(applyTableOp(state, callAction(state)), 'FLOP BB CALL');
console.log(`\n§3 翻牌行动结束：行动者=${actorPosition(state)}`);

/* ---- 录转牌 1 张 → 转牌行动：对手下注 20，Hero **尚未行动** ---- */
state = drive(state, [{ kind: 'SET_BOARD_CARD', card: '6s', slot: 3 }]);
snapshot('§4 录入转牌 1 张（转牌行动尚未开始）', state);
state = must(applyTableOp(state, { kind: 'ACT', action: { type: 'BET', amountChips: betAmount(state) } }), 'TURN BET');
snapshot('§5 转牌：对手下注 20，Hero **尚未行动**（真实报告的场景）', state);

/* ---- 关键异常：此时录入河牌 Q♥ ---- */
const riverOp = applyTableOp(state, { kind: 'SET_BOARD_CARD', card: 'Qh', slot: 4 });
console.log(`\n§6 尝试录入河牌 Q♥：操作被接受 = ${String(riverOp.ok)}${riverOp.ok ? '' : ` ｜ 拒绝原因=${j(riverOp.issues, 240)}`}`);
if (riverOp.ok) {
  state = riverOp.state;
  snapshot('§7 已录入河牌 Q♥（转牌行动仍未结算）', state);
}

/* ---- 对照 A：先把转牌跟注补齐，再录河牌 ⇒ 应一致 ---- */
{
  let s2 = must(applyTableOp(state, { kind: 'UNDO' }), 'UNDO 河牌');          // 退回河牌那张
  s2 = must(applyTableOp(s2, callAction(state)), 'Hero 跟注 20');
  const r2 = applyTableOp(s2, { kind: 'SET_BOARD_CARD', card: 'Qh', slot: 4 });
  console.log(`\n§8 对照 A：先跟注结算（Hero CALL 20）再录河牌 ⇒ 录入被接受 = ${String(r2.ok)}`);
  if (r2.ok) snapshot('§9 对照 A（转牌已结算 + 河牌已录）', r2.state);
}

/* ---- 对照 B：转牌未结算时，Hero 弃牌后再录河牌 ---- */
{
  const s3 = must(applyTableOp(state, { kind: 'UNDO' }), 'UNDO 河牌');
  const s4 = must(applyTableOp(s3, { kind: 'ACT', action: { type: 'FOLD' } }), 'Hero FOLD');
  const r4 = applyTableOp(s4, { kind: 'SET_BOARD_CARD', card: 'Qh', slot: 4 });
  console.log(`\n§10 对照 B：Hero 在转牌弃牌后再录河牌 ⇒ 录入被接受 = ${String(r4.ok)}`);
  if (r4.ok) snapshot('§11 对照 B（Hero 已弃牌 + 河牌已录）', r4.state);
}

console.log('\n（审计探针结束；未修改任何文件）');
