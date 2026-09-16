/**
 * REAL-HAND HOTFIX 001 —— 分叉定位探针
 *
 * ## 目的
 *
 * 现场失败信息：
 *
 * > 「内部一致性检查失败：应用后的状态与重新重放出来的状态不一致。」
 *
 * `applyTableAction` 内部比较的是：
 *
 * ```
 * A = 增量侧的规范状态 = settleCanonicalStreet(applyAction(旧引擎状态, 这一条动作).state, 公共牌)
 * B = 重放侧的规范状态 = engineViewOf(新牌桌状态).engine
 * assert fingerprint(A) === fingerprint(B)
 * ```
 *
 * 🔴 **A 侧的规范结算（`settleCanonicalStreet`）是 HOTFIX 001 的 D 修复加上的**：
 * 修复前增量侧从不推进街道，而重放侧只要牌够就推 —— 这正是分叉的成因。
 * 探针必须跟着走同一步，否则它比较的是**修复前**的增量路径，
 * 会把一个已经修好的产品报成「仍然分叉」（假红）。
 *
 * 本探针**逐步**走同一场景，每一步同时算出 A 与 B 并做**逐字段差分**，
 * 找出**第一次发生分叉的那一条动作**（而不是只比较最终状态）。
 *
 * ## 用法
 *
 * ```
 * node.exe --experimental-strip-types scripts/rt-hotfix001-diverge.ts
 * ```
 */

import { Position } from '../src/domain/types.ts';
import { createTable, seatOfPosition } from '../src/app/table/tableState.ts';
import {
  applyTableAction,
  applyTableOp,
  engineViewOf,
} from '../src/app/table/tableOps.ts';
import type { PokerTableState, TableIssue, TableOp } from '../src/app/table/table.types.ts';
import type { ActionCommand, GameState } from '../src/domain/poker/gameState.ts';
import { computePot, minRaiseTo, playerById } from '../src/domain/poker/gameState.ts';
import { actorOnTurn, applyAction } from '../src/domain/poker/engine.ts';
import { ActionType } from '../src/domain/types.ts';
import type { ManualActionType } from '../src/app/manualInput/manualInput.ts';
import { settleCanonicalStreet } from '../src/app/manualInput/reconstruct.ts';

const BIG_BLIND_CHIPS = 100;

const line = (t = ''): void => {
  process.stdout.write(`${t}\n`);
};
const head = (t: string): void => {
  line('');
  line('='.repeat(80));
  line(t);
  line('='.repeat(80));
};

const RING_9: readonly Position[] = [
  Position.UTG,
  Position.UTG1,
  Position.UTG2,
  Position.LJ,
  Position.HJ,
  Position.CO,
  Position.BTN,
  Position.SB,
  Position.BB,
];

/* ============================================================
 * 差分工具
 * ============================================================ */

/**
 * 逐字段状态快照。
 *
 * ⚠️ 只规范化**表示形式**（数组排序、对象键顺序），
 * **不删除任何有策略意义的字段**。
 */
function snapshot(s: GameState): Record<string, string> {
  const players: Record<string, string> = {};
  for (const p of [...s.players].sort((a, b) => (a.position < b.position ? -1 : 1))) {
    players[`P.${p.position}.stack`] = String(p.remainingStack);
    players[`P.${p.position}.c.PRE`] = String(p.committedByStreet.PREFLOP);
    players[`P.${p.position}.c.FLOP`] = String(p.committedByStreet.FLOP);
    players[`P.${p.position}.c.TURN`] = String(p.committedByStreet.TURN);
    players[`P.${p.position}.c.RIVER`] = String(p.committedByStreet.RIVER);
    players[`P.${p.position}.folded`] = String(p.folded);
    players[`P.${p.position}.allIn`] = String(p.allIn);
  }
  return {
    'S.street': String(s.street),
    'S.phase': String(s.phase),
    'S.currentActor': String(actorOnTurn(s)),
    'S.currentBet': String(s.currentBet),
    'S.lastRaiseSize': String(s.lastRaiseSize),
    'S.minRaiseTo': String(minRaiseTo(s)),
    'S.bettingRoundComplete': String(s.bettingRoundComplete),
    'S.pot': String(computePot(s)),
    'S.lastAggressorId': String(s.lastAggressorId),
    'S.raiseClosedFor': JSON.stringify([...s.raiseClosedFor].sort()),
    'S.actedSinceLastAggression': JSON.stringify([...s.actedSinceLastAggression].sort()),
    'S.pendingQueue': JSON.stringify(s.pendingQueue),
    'S.board.flop': JSON.stringify(s.board.flop.map((c) => `${c.rank}${c.suit}`)),
    'S.board.turn': JSON.stringify(s.board.turn.map((c) => `${c.rank}${c.suit}`)),
    'S.board.river': JSON.stringify(s.board.river.map((c) => `${c.rank}${c.suit}`)),
    'S.actions.length': String(s.actions.length),
    ...players,
  };
}

type FieldDiff = { key: string; a: string; b: string };

function diffOf(a: Record<string, string>, b: Record<string, string>): FieldDiff[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const rows: FieldDiff[] = [];
  for (const k of [...keys].sort()) {
    if (a[k] !== b[k]) rows.push({ key: k, a: String(a[k]), b: String(b[k]) });
  }
  return rows;
}

/* ============================================================
 * 场景（截图重建）
 * ============================================================ */

type Step = { position: Position; type: ManualActionType; amountBB?: number };

/**
 * 截图里的 Action History。
 *
 * ## 两条重要的重建说明（都影响结论）
 *
 * 1. **截图只显示了部分行动**。9 座桌翻牌前顺序是
 *    `UTG → UTG1 → UTG2 → LJ → HJ → CO → BTN → SB → BB`，
 *    因此「HJ 大盲」意味着 UTG1 / UTG2 / LJ **在此之前已经弃牌**。
 *
 * 2. **`HJ` 与 `CO` 的金额在截图里各出现两次，语义不同**：
 *    `HJ POST_BB 100` 与 `HJ CALL 275` 是同一个人的**两条不同记录**；
 *    `CO RAISE 200` 与 `CO CALL 175` 同理。**这是设计如此**
 *    （`ManualAction.amountBB` 对 CALL 是「本次投入」）。
 *
 * 金额口径：`CALL` = 本次投入；`BET`/`RAISE` = **加注到**（本街总额）；`ALL_IN` = 不填。
 */
const SCENARIO: readonly Step[] = [
  { position: Position.UTG, type: 'FOLD' },
  { position: Position.UTG1, type: 'FOLD' },
  { position: Position.UTG2, type: 'FOLD' },
  { position: Position.LJ, type: 'FOLD' },
  { position: Position.HJ, type: 'FOLD' }, // 截图只标了「POST_BB 100」，动作本身被裁掉
  { position: Position.CO, type: 'RAISE', amountBB: 2 }, // 开池到 200
  { position: Position.BTN, type: 'CALL', amountBB: 2 }, // 跟 200（本次投入 2BB）
  { position: Position.SB, type: 'CALL', amountBB: 1.5 }, // 补齐到 200（本次投入 1.5BB）
  { position: Position.BB, type: 'RAISE', amountBB: 3.75 }, // 加注到 375
  { position: Position.CO, type: 'CALL', amountBB: 1.75 }, // 375-200
  { position: Position.BTN, type: 'CALL', amountBB: 1.75 }, // 375-200
  { position: Position.SB, type: 'CALL', amountBB: 1.75 }, // 375-200
  { position: Position.BB, type: 'ALL_IN' }, // BB 身后还有 CO/BTN/SB
  { position: Position.CO, type: 'ALL_IN' }, // CO 本轮已投入 375，是 short all-in
  { position: Position.BTN, type: 'ALL_IN' }, // 之上还有 SB 全下 → 递归
  { position: Position.SB, type: 'ALL_IN' }, // 最后一条：本街下注轮结束
];

const BOARD: readonly string[] = ['Ah', '7c', '2d'];

/**
 * 三种公共牌状态 —— 关键对照。
 *
 * | 场景 | 期望 |
 * |---|---|
 * | 未录入（0 张） | 分歧路径**不**推进街道（记完最后一条动作后停在 PREFLOP） |
 * | 刚好够翻牌（3 张） | 分歧：增量停在 PREFLOP，重放推到 FLOP |
 * | 录满 5 张 | 分歧更远：重放一路推到 RIVER / SHOWDOWN |
 */
const BOARD_VARIANTS: readonly { label: string; cards: readonly string[] }[] = [
  { label: '未录入（0 张）', cards: [] },
  { label: '刚好够翻牌（3 张）', cards: ['Ah', '7c', '2d'] },
  { label: '录满（5 张）', cards: ['Ah', '7c', '2d', 'Ks', '9h'] },
];

const TYPE_MAP: Readonly<Record<ManualActionType, ActionType>> = Object.freeze({
  FOLD: ActionType.FOLD,
  CHECK: ActionType.CHECK,
  CALL: ActionType.CALL,
  BET: ActionType.BET,
  RAISE: ActionType.RAISE,
  ALL_IN: ActionType.ALL_IN,
});

/* ============================================================
 * 建桌
 * ============================================================ */

function must(state: PokerTableState, op: TableOp): PokerTableState {
  const r = applyTableOp(state, op);
  if (!r.ok) {
    throw new Error(
      `op ${op.kind} 失败：${r.issues.map((i: TableIssue) => i.message).join(' / ')}`,
    );
  }
  return r.state;
}

function build(stackBB: number, board: readonly string[]): PokerTableState {
  let state = createTable({ tableSize: 9, heroPosition: Position.SB, defaultStackBB: stackBB });
  for (const p of RING_9) {
    if (p === Position.SB) continue;
    state = must(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, p)!.seatId });
  }
  state = must(state, { kind: 'SET_HERO_CARD', card: 'As' });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Kd' });
  for (const [i, card] of board.entries()) {
    state = must(state, { kind: 'SET_BOARD_CARD', card, slot: i });
  }
  return state;
}

/* ============================================================
 * 主流程
 * ============================================================ */

head('REAL-HAND HOTFIX 001 —— 分叉定位');
line('A 侧 = applyAction(旧引擎, 动作).state（增量）');
line('B 侧 = engineViewOf(新牌桌状态).engine（完整重放）');

const summary: { label: string; first: number; note: string }[] = [];

for (const variant of BOARD_VARIANTS) {
  head(`场景：Hero 在 SB，9 座满桌，100BB｜公共牌 ${variant.label}`);

  let table = build(100, variant.cards);
  let firstDivergence = -1;
  const details: { ordinal: number; step: Step; rows: FieldDiff[] }[] = [];

  for (const [i, step] of SCENARIO.entries()) {
    const ordinal = i + 1;

    // ---- 取动作前的引擎状态 ----
    const pre = engineViewOf(table);
    if (!pre.ok) {
      line(`${String(ordinal).padStart(2)}. ❌ 动作前状态无法重放：${pre.issues.map((x) => x.message).join(' / ')}`);
      break;
    }
    const preEngine = pre.engine;
    const actorId = actorOnTurn(preEngine);
    const actor = actorId !== null ? playerById(preEngine, actorId) : undefined;

    const label =
      `${String(ordinal).padStart(2)}. 期望 ${step.position.padEnd(4)} ${step.type.padEnd(7)}` +
      `${String(step.amountBB ?? '').padEnd(7)} 行动者=${String(actor?.position ?? '—')}`;

    if (actor === undefined) {
      line(
        `${label}　ℹ 本街下注轮已结束、且没有可行动的人 —— ` +
          '必须先录入公共牌才能继续（**停住不是分叉**）',
      );
      break;
    }
    if (actor.position !== step.position) {
      line(
        `${label}　ℹ 行动者已因**街道推进**而改变 —— ` +
          '本场景余下步骤属于翻牌前，无法再录（**不是分叉**）',
      );
      break;
    }

    // ---- A 侧：增量（在旧引擎状态上直接 apply）----
    const command: ActionCommand = {
      playerId: actorId!,
      type: TYPE_MAP[step.type],
      ...(step.amountBB !== undefined
        ? { amount: Math.round(step.amountBB * BIG_BLIND_CHIPS) }
        : {}),
      manuallyEntered: true,
    };
    const aResult = applyAction(preEngine, command);
    if (!aResult.ok) {
      line(`${label}　❌ 引擎拒绝增量：${aResult.issues.map((x) => String(x.code)).join('；')}`);
      break;
    }
    // 增量侧也必须走规范状态那一步（与产品路径、重放路径共用同一个实现）
    const canonical = settleCanonicalStreet(aResult.state, pre.boardCards).state;

    // ---- 走真实的产品路径（含它自己的自检）----
    const applied = applyTableAction(table, {
      type: step.type,
      ...(step.amountBB !== undefined
        ? { amountChips: Math.round(step.amountBB * BIG_BLIND_CHIPS) }
        : {}),
    });
    if (!applied.ok) {
      line(`${label}　❌ applyTableAction 被拒绝：`);
      for (const issue of applied.issues) {
        line(`      ${issue.message.split('\n').join('\n      ')}`);
      }
      break;
    }
    table = applied.state;

    // ---- B 侧：重放 ----
    const bView = engineViewOf(table);
    if (!bView.ok) {
      line(`${label}　❌ 新状态无法重放：${bView.issues.map((x) => x.message).join(' / ')}`);
      break;
    }

    const snapA = snapshot(canonical);
    const snapB = snapshot(bView.engine);
    const rows = diffOf(snapA, snapB);

    const brief = (s: Record<string, string>): string =>
      `${s['S.street']}/${s['S.phase']}/bet=${s['S.currentBet']}/minRaiseTo=${s['S.minRaiseTo']}/` +
      `brc=${s['S.bettingRoundComplete']}/board=${s['S.board.flop']}`;

    line(`${label}`);
    line(`      A(增量+规范结算) ${brief(snapA)}`);
    line(`      B(重放)         ${brief(snapB)}`);

    if (rows.length > 0) {
      if (firstDivergence < 0) firstDivergence = ordinal;
      details.push({ ordinal, step, rows });
      line(`      ⚠️ 分叉 ${rows.length} 个字段：`);
      for (const r of rows.slice(0, 16)) {
        line(`         ${r.key.padEnd(32)} A=${r.a.padEnd(20)} B=${r.b}`);
      }
      if (rows.length > 16) line(`         …（另有 ${rows.length - 16} 个）`);
    } else {
      line('      ✓ 一致');
    }
  }

  line('');
  if (firstDivergence < 0) {
    line(`结论（${variant.label}）：**没有**任何一步发生分叉。`);
    summary.push({ label: variant.label, first: -1, note: '无分叉' });
  } else {
    const d = details[0]!;
    line(
      `DIVERGENCE_FIRST_OCCURS_AT = ${firstDivergence}  ` +
        `（第 ${firstDivergence} 条动作：${d.step.position} ${d.step.type}）`,
    );
    summary.push({
      label: variant.label,
      first: firstDivergence,
      note: `${d.step.position} ${d.step.type}；首个不同字段=${d.rows[0]!.key}`,
    });
  }
}

head('汇总');
for (const s of summary) {
  line(`  ${s.label.padEnd(20)} → ${s.note}`);
}
