/*
 * 阶段四端到端验证（生产函数级）：
 *   真实历史 JSONL → statsFromRecords → tableAdapter → analyzeManualHand
 * 比较三种 BB 绑定：无历史 / p3 / p4。
 *
 * ⚠️ 唯一被替换的环节是「座位绑定」（牌桌路径中途改绑被 NEEDS_LEAVE_DECISION 拦住，
 *    而 `applyUserOpWithHistory:828-854` 的注入逻辑已在源码层核实）。
 *    其余全部走真实生产函数。
 */
import { loadObservations, statsFromRecords, defaultHistoryDir } from '../../src/app/table/playerHistory.ts';
import { tableStateToManualHandInput } from '../../src/app/table/tableAdapter.ts';
import { analyzeManualHand } from '../../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const BASE = 'http://127.0.0.1:5173';
let seq = 0;

async function buildTable() {
  let state = null, preview = null;
  const op = async (kind, extra = {}) => {
    const id = `p4t-${Date.now().toString(36)}-${++seq}-${kind}`;
    const body = state === null
      ? { tableSize: 9, heroPosition: 'CO', requestId: id }
      : { state, op: { kind, ...extra }, requestId: id };
    const r = await fetch(BASE + '/api/table', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j?.ok) throw new Error(`${kind}: ${JSON.stringify(j?.issues ?? j).slice(0, 200)}`);
    state = j.state; preview = j.preview;
  };
  await op('NEW_TABLE');
  await op('FILL_EMPTY_SEATS');
  await op('SET_HERO_CARD', { card: 'Ks' });
  await op('SET_HERO_CARD', { card: 'Qs' });

  /*
   * 打到决策点：翻前弃到 CO，Hero 加注 2.5BB，BTN/SB 弃，BB 跟注；
   * 翻牌 BB 过牌 → Hero 下注 3.5BB → BB 加注到 14BB（= 目标决策节点）。
   * ⚠️ 行动的归属由**座位/位置**决定，与 BB 座位绑的是谁无关
   * ⇒ 先打完再改绑定，对比较是安全的。
   */
  const posOf = (seatId: string) => state.seats.find((s) => s.seatId === seatId)?.logicalPosition;
  const act = async (type: string, toChips?: number) => {
    const action: Record<string, unknown> = { position: posOf(preview.currentActorSeatId), type };
    if (toChips !== undefined) action.amountChips = toChips;
    await op('ACT', { action });
  };
  for (let i = 0; i < 5; i++) await act('FOLD');   // UTG..HJ
  await act('RAISE', 250);                          // CO (Hero) 2.5BB
  await act('FOLD');                                // BTN
  await act('FOLD');                                // SB
  await act('CALL', 150);                           // BB 跟注（增量 1.5BB）
  await act('CHECK');                               // BB 翻牌过牌
  await act('BET', 350);                            // CO 下注 3.5BB
  await act('RAISE', 1400);                         // BB 加注到 14BB
  console.log(`决策点：actionHistory=${state.actionHistory.length} 条，轮到我方=${preview?.isHeroTurn}`);
  return state;
}

const dir = defaultHistoryDir();
const loaded = loadObservations(dir);
if (!loaded.ok) throw new Error('history load failed');
const records = loaded.records;
console.log(`真实历史：${records.length} 条记录（${dir}）`);

const targets = ['p3', 'p4', 'p1'];
const derived = {};
for (const id of targets) {
  const s = statsFromRecords(records, id);
  derived[id] = s;
  console.log(`  ${id}: observedStats=${JSON.stringify(s.observedStats)}  (hands=${s.handsObserved})`);
}

const state = await buildTable();
const bbSeat = state.seats.find((s) => s.logicalPosition === 'BB');
console.log(`\nBB 座位 = ${bbSeat.seatId}，当前玩家 = ${bbSeat.playerId}`);

/** 把 BB 座位的 playerId 改成目标玩家，并按生产注入逻辑补上 observedStats */
function bound(binding) {
  const playersById = { ...state.playersById };
  const seats = state.seats.map((s) => (s.seatId === bbSeat.seatId ? { ...s, playerId: binding.id } : s));
  if (binding.id !== null) {
    const prev = playersById[bbSeat.playerId] ?? {};
    playersById[binding.id] = {
      ...prev, playerId: binding.id, displayName: binding.id,
      ...(derived[binding.id].observedStats === null ? {} : { observedStats: derived[binding.id].observedStats }),
    };
  }
  return { ...state, seats, playersById };
}

const cases = [
  ['C 无历史（BB 保持全新玩家）', null],
  ['A BB = p3', 'p3'],
  ['B BB = p4', 'p4'],
];

const out = [];
for (const [label, id] of cases) {
  const st = bound({ id });
  const adapted = tableStateToManualHandInput(st);
  if (!adapted.ok) { console.log(`\n### ${label}\n  适配失败: ${JSON.stringify(adapted.issues).slice(0, 200)}`); continue; }
  const inp = adapted.input;
  const r = analyzeManualHand(inp, { rules: RULES });
  if (!r.ok) { console.log(`\n### ${label}\n  分析失败: ${JSON.stringify(r.issues).slice(0, 200)}`); continue; }
  const md = r.decision.diagnostics.math;
  const g = (n) => { const x = md.find((y) => (y.label ?? '').includes(n)); return x ? String(x.value).split('｜')[0].trim() : '?'; };
  const pf = r.decision.diagnostics.postflopFacts ?? {};
  const rr = pf.raiseResponse ?? null;
  const row = {
    label,
    action: `${r.decision.action} ${(r.decision.sizeChips ?? 0) / 100}BB`,
    villainHasStats: inp.villain?.observedStats !== undefined && inp.villain?.observedStats !== null,
    eqBet: g('对手下注范围权益'),
    eqWhole: g('整体范围权益'),
    callEV: g('跟注 EV'),
    raiseEV: rr?.raiseEV ?? null,
    fold: rr?.foldLikelihood ?? null,
  };
  out.push(row);
  console.log(`\n### ${label}`);
  console.log(`  注入 observedStats：${row.villainHasStats ? '是' : '否'}`);
  console.log(`  决策=${row.action}`);
  console.log(`  对下注范围权益=${row.eqBet}｜整体范围权益=${row.eqWhole}｜CALL EV=${row.callEV}`);
  console.log(`  RAISE EV=${row.raiseEV === null ? '—' : row.raiseEV.toFixed(4)}｜P(弃)=${row.fold === null ? '—' : (row.fold * 100).toFixed(1) + '%'}`);
}

console.log('\n=== 判定 ===');
const c = out.find((r) => r.label.startsWith('C'));
const a = out.find((r) => r.label.startsWith('A'));
const b = out.find((r) => r.label.startsWith('B'));
const same = (x, y, k) => (x[k] === y[k] ? '相同' : `**不同**（${x[k]} vs ${y[k]}）`);
if (c && a) {
  console.log(`  C vs A（有无真实画像）：权益 ${same(c, a, 'eqWhole')}｜CALL EV ${same(c, a, 'callEV')}｜P(弃) ${same(c, a, 'fold')}`);
}
if (a && b) {
  console.log(`  A vs B（两个不同真实玩家）：权益 ${same(a, b, 'eqWhole')}｜CALL EV ${same(a, b, 'callEV')}｜P(弃) ${same(a, b, 'fold')}`);
}
