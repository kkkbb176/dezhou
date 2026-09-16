/**
 * 作者侧诊断探针：量化红队报的两个 HIT
 *
 * 1. `V27`：预览给出的按钮有多少会被后端拒绝（应当为 0）
 * 2. `V-MAL`：畸形 HTTP 载荷里有多少会产生 5xx（应当为 0）
 *
 * 用法：`node --experimental-strip-types scripts/table-probe-buttons.ts`
 */

import { Position } from '../src/domain/types.ts';
import { createTable, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import type { PokerTableState, TableActionButton, TableOp } from '../src/app/table/table.types.ts';
import { startAlphaServer } from '../src/app/webServer.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();

/* ============================================================
 * 1. 按钮合法性穷举
 * ============================================================ */

function must(result: ReturnType<typeof applyTableOp>): PokerTableState {
  if (!result.ok) throw new Error(`构造失败：${result.issues.map((i) => i.message).join(' / ')}`);
  return result.state;
}

function fullTable(hero: Position, stackBB: number): PokerTableState {
  let state = createTable({ tableSize: 6, heroPosition: hero, defaultStackBB: stackBB });
  for (const position of [
    Position.UTG,
    Position.HJ,
    Position.CO,
    Position.BTN,
    Position.SB,
    Position.BB,
  ]) {
    if (position === hero) continue;
    state = must(
      applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, position)!.seatId }),
    );
  }
  return state;
}

/** 一个确定性的伪随机（保证可复现） */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const BOARD_POOL = ['Kh', '7c', '2d', '3s', '9h', 'Ah', 'Qd', '8s', '2c', 'Td'];

type Rejection = { label: string; type: string; code: string; message: string };

const rejections: Rejection[] = [];
let triedButtons = 0;
let expandButtons = 0;

function tryAllButtons(state: PokerTableState, rng: () => number, collect: (s: PokerTableState) => void): void {
  const preview = buildTablePreview(state);
  if (preview.actionButtons.length === 0) return;

  for (const button of preview.actionButtons as readonly TableActionButton[]) {
    // ⚠️ `EXPAND` 组**不是动作**（契约见 `TableActionButton`）：
    //    它只用来展开尺寸行。因此「点下去后端必须接受」这条不适用于它 ——
    //    统计它、但不算作拒绝。
    if (button.group === 'EXPAND') {
      expandButtons += 1;
      continue;
    }
    triedButtons += 1;
    const result = applyTableOp(state, {
      kind: 'ACT',
      action: {
        type: button.type,
        ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
      },
    });
    if (!result.ok) {
      rejections.push({
        label: button.labelZh,
        type: `${button.type}/${button.group}`,
        code: result.issues[0]!.code,
        message: result.issues[0]!.message,
      });
      continue;
    }
    // 沿着这个分支继续走几步，扩大覆盖面
    collect(result.state);
    void rng;
  }
}

/** 随机走完一手牌，沿途把每个状态里的**每一个**按钮都点一遍 */
function playThrough(seed: number, hero: Position, stackBB: number): void {
  const rng = makeRng(seed);
  let state = fullTable(hero, stackBB);
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'As' }));
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Kd' }));

  const boardPool = [...BOARD_POOL];
  const pickBoard = (): string => {
    const index = Math.floor(rng() * boardPool.length);
    return boardPool.splice(index, 1)[0]!;
  };

  for (let step = 0; step < 24; step += 1) {
    const preview = buildTablePreview(state);
    if (preview.handComplete) break;

    // 每个状态都把**所有**按钮试一遍（只关心合法性，不关心选哪个）
    const clone = state;
    tryAllButtons(clone, rng, () => {
      /* 不继续递归，避免爆炸 */
    });

    // 真正推进：随机点一个按钮
    if (preview.actionButtons.length === 0) {
      // 下注轮结束 → 补公共牌推进街道
      const next = pickBoard();
      const slot = state.board.length;
      if (slot > 4) break;
      const advanced = applyTableOp(state, { kind: 'SET_BOARD_CARD', card: next, slot });
      if (!advanced.ok) break;
      state = advanced.state;
      continue;
    }
    const pick = preview.actionButtons.filter((b) => b.group === 'PRIMARY');
    const button = pick[Math.floor(rng() * pick.length)] ?? preview.actionButtons[0]!;
    const applied = applyTableOp(state, {
      kind: 'ACT',
      action: {
        type: button.type,
        ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
      },
    });
    if (!applied.ok) break;
    state = applied.state;
  }
}

console.log('=== V27：预览按钮的合法性穷举 ===');
let seeds = 0;
for (let seed = 1; seed <= 40; seed += 1) {
  for (const hero of [Position.UTG, Position.CO, Position.BTN, Position.SB, Position.BB]) {
    playThrough(seed * 100 + hero.length, hero, 100);
    seeds += 1;
  }
}
console.log(`  覆盖 ${seeds} 次走牌`);
console.log(`  可执行按钮（PRIMARY/SIZE）共试 ${triedButtons} 个；另有 ${expandButtons} 个展开按钮（非动作，按契约不计）`);

const byCode = new Map<string, number>();
const byType = new Map<string, number>();
const samples = new Map<string, string>();
for (const r of rejections) {
  byCode.set(r.code, (byCode.get(r.code) ?? 0) + 1);
  byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
  if (!samples.has(r.code)) samples.set(r.code, `${r.label} → ${r.message}`);
}
console.log(`  被拒绝 = ${rejections.length}（应当为 0）`);
for (const [code, count] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${code}: ${count}`);
  console.log(`      样例：${samples.get(code)}`);
}
for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    按钮类型 ${type}: ${count}`);
}

/* ============================================================
 * 2. 畸形载荷的 5xx 穷举
 * ============================================================ */

const MALFORMED: readonly unknown[] = [
  null,
  42,
  'string',
  [],
  {},
  { table: null },
  { table: 42 },
  { table: [] },
  { table: { seats: null } },
  { table: { seats: [] } },
  { table: { seats: [{}] } },
  { state: null, op: {} },
  { state: {}, op: {} },
  { state: [], op: {} },
  { state: { seats: [] }, op: { kind: 'ACT' } },
  { state: { seats: [] }, op: { kind: 'ACT', action: null } },
  { state: { seats: [] }, op: { kind: 'ACT', action: { type: 'ALL_IN', amountChips: 'x' } } },
  { state: { seats: [] }, op: { kind: 'SET_BOARD_CARD', card: null, slot: 'a' } },
  { state: { seats: [] }, op: { kind: 'SET_STACK', stackBB: {} } },
  { state: { seats: [] }, op: { kind: 'SET_PROFILE', quickProfile: 1 } },
  { state: { seats: [] }, op: { kind: '__proto__' } },
  { state: { seats: [] }, op: { kind: 'constructor' } },
  { state: { __proto__: { polluted: true } }, op: { kind: 'UNDO' } },
  { tableSize: 'six' },
  { tableSize: {} },
  { heroPosition: [] },
  { heroPosition: null },
  { table: { ...createTable({ tableSize: 6 }), undo: 'not-array' } },
  { table: { ...createTable({ tableSize: 6 }), seats: 'nope' } },
  { table: { ...createTable({ tableSize: 6 }), playersById: [] } },
  { table: { ...createTable({ tableSize: 6 }), actionHistory: [null] } },
  { table: { ...createTable({ tableSize: 6 }), actionHistory: [{ position: 'UTG' }] } },
  { table: { ...createTable({ tableSize: 6 }), heroCards: [1, 2] } },
  { table: { ...createTable({ tableSize: 6 }), board: [null, null, null] } },
  { table: { ...createTable({ tableSize: 6 }), revision: 1e308 } },
  { table: { ...createTable({ tableSize: 6 }), nextPlayerNumber: -1 } },
];

const server = await startAlphaServer({ port: 0, rules: RULES, logPath: null });
console.log('');
console.log('=== V-MAL：畸形载荷的 HTTP 状态码 ===');
let serverErrors = 0;
try {
  for (const [index, payload] of MALFORMED.entries()) {
    for (const path of ['/api/table', '/api/analyze']) {
      let status = 0;
      let text = '';
      try {
        const res = await fetch(`${server.url}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        status = res.status;
        text = await res.text();
      } catch (error) {
        console.log(`  [${index}] ${path} 传输层异常：${String(error)}`);
        serverErrors += 1;
        continue;
      }
      if (status >= 500) {
        serverErrors += 1;
        console.log(`  [${index}] ${path} → HTTP ${status}：${text.slice(0, 200)}`);
      } else if (!text.startsWith('{')) {
        serverErrors += 1;
        console.log(`  [${index}] ${path} → 非 JSON 响应：${text.slice(0, 120)}`);
      }
    }
  }
} finally {
  await server.close();
}
console.log(`  5xx / 非 JSON 响应 = ${serverErrors}（应当为 0）`);
console.log('');
console.log(`结论：按钮被拒 = ${rejections.length}，HTTP 异常 = ${serverErrors}`);
