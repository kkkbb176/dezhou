/*
 * P4 探针：牌局记录**能不能回放**？—— 修复前后对照。
 *
 * 只读生产码、只写临时目录。
 *
 * 输出两件事：
 * ① 真实牌桌操作（翻前 → 翻牌 → 转牌，含多街行动）写出的每条记录里
 *    有没有 `board` / `holeCards`，以及值是否正确；
 * ② 用记录 + 建桌参数**重建** `ManualHandInput`，与当时的真实输入**逐字段比对**
 *    —— 这才是「可回放」的定义，不是「字段非空」。
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyUserOpWithHistory, loadObservations } from '../src/app/table/playerHistory.ts';
import { createTable } from '../src/app/table/tableState.ts';
import { tableStateToManualHandInput } from '../src/app/table/tableAdapter.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';
import { engineViewOf } from '../src/app/table/tableOps.ts';
import { replayAllHands } from '../src/domain/handReplay/handReplay.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';

const dir = mkdtempSync(join(tmpdir(), 'p4-replay-'));
let state: PokerTableState = createTable({ tableSize: 6 });

const apply = (op: TableOp): PokerTableState => {
  const r = applyUserOpWithHistory({ state, op, historyDir: dir });
  if (!r.outcome.ok) {
    throw new Error(`op ${op.kind} 失败：${JSON.stringify((r.outcome.issues ?? []).map((i) => i.code))}`);
  }
  state = r.outcome.state;
  return state;
};

const engineIdOf = (s: PokerTableState): string | null => {
  const v = engineViewOf(s);
  return v.ok ? actorOnTurn(v.engine) : null;
};

const callCostOf = (s: PokerTableState, id: string): number => {
  const v = engineViewOf(s);
  if (!v.ok) return 0;
  const me = v.engine.players.find((p) => p.id === id);
  return me === undefined ? 0 : deriveLegalActions(v.engine, me).callCost;
};

const legalOf = (
  s: PokerTableState,
  id: string,
): { canCheck: boolean; canRaise: boolean; minRaiseToAmount: number; allInToAmount: number } => {
  const v = engineViewOf(s);
  const me = v.ok ? v.engine.players.find((p) => p.id === id) : undefined;
  if (!v.ok || me === undefined) return { canCheck: false, canRaise: false, minRaiseToAmount: 0, allInToAmount: 0 };
  const l = deriveLegalActions(v.engine, me);
  return {
    canCheck: l.canCheck,
    canRaise: l.canRaise,
    minRaiseToAmount: l.minRaiseToAmount,
    allInToAmount: l.allInToAmount,
  };
};

/** 按脚本在**当前行动者**身上施加动作（金额一律取自引擎的合法动作，不写死） */
const act = (choice: 'FOLD' | 'CHECK_CALL' | 'RAISE'): void => {
  const id = engineIdOf(state);
  if (id === null) throw new Error('没有行动者');
  const cc = callCostOf(state, id);
  const legal = legalOf(state, id);
  if (choice === 'FOLD') {
    apply({ kind: 'ACT', action: { type: 'FOLD' } });
    return;
  }
  if (choice === 'RAISE') {
    /*
     * 🔴 加注额必须落在 `[minRaiseToAmount, allInToAmount]`，且**本街累计到**口径
     *（`CALL` 是「本次补入」，两者不同 —— 见 `legalActions.ts:55-75`）。
     * 不合法就退化为跟注/过牌，绝不构造非法动作。
     */
    const to = legal.minRaiseToAmount;
    if (legal.canRaise && to > 0 && to <= legal.allInToAmount) {
      apply({ kind: 'ACT', action: { type: 'RAISE', amountChips: to } });
      return;
    }
    console.log(`   （加注不合法：canRaise=${legal.canRaise} minTo=${to} ⇒ 退化为 ${cc > 0 ? 'CALL' : 'CHECK'}）`);
  }
  if (cc > 0) apply({ kind: 'ACT', action: { type: 'CALL', amountChips: cc } });
  else apply({ kind: 'ACT', action: { type: 'CHECK' } });
};

const streetOf = (s: PokerTableState): string => {
  const v = engineViewOf(s);
  return v.ok ? String(v.engine.street) : '?';
};

/** 把「本街」打到结束：所有人 CHECK/CALL（不产生加注，避免构造非法动作） */
function playStreetToEnd(maxSteps = 12): void {
  for (let i = 0; i < maxSteps; i += 1) {
    const id = engineIdOf(state);
    if (id === null) return;
    act('CHECK_CALL');
  }
}

console.log('=== 建桌：6 人，Hero 在 BTN，手牌 As Ks ===');
apply({ kind: 'FILL_EMPTY_SEATS' });
apply({ kind: 'SET_HERO_CARD', card: 'As' });
apply({ kind: 'SET_HERO_CARD', card: 'Ks' });
console.log(`heroPosition=${state.heroPosition}；board=「${state.board.join(' ')}」`);

/*
 * 🔴 **街道推进的真实机制**：`applyAction` 只标记「本街下注轮已结束」，
 * 从不改 `street`；推进由 `settleCanonicalStreet(..., view.boardCards)` 完成，
 * 而它**需要公共牌** ⇒ **先录牌，街道才动**。
 */
console.log('\n=== 翻前：全部 CHECK/CALL 打到本街结束 ===');
playStreetToEnd();
console.log(`本街打完后 street = ${streetOf(state)}（仍是翻前：引擎在等公共牌）`);

console.log('\n=== 录入翻牌 Kh 7c 2d ⇒ 引擎重放并把街道推进到翻牌 ===');
apply({ kind: 'SET_BOARD_CARD', card: 'Kh', slot: 0 });
apply({ kind: 'SET_BOARD_CARD', card: '7c', slot: 1 });
apply({ kind: 'SET_BOARD_CARD', card: '2d', slot: 2 });
console.log(`录牌后 street = ${streetOf(state)}`);
playStreetToEnd();

console.log('\n=== 录入转牌 Qd ⇒ 推进到转牌 ===');
apply({ kind: 'SET_BOARD_CARD', card: 'Qd', slot: 3 });
console.log(`录牌后 street = ${streetOf(state)}`);
playStreetToEnd();

console.log('\n=== 记录 ===');
const loaded = loadObservations(dir);
if (!loaded.ok) throw new Error(`记录读取失败：${JSON.stringify(loaded.issues)}`);
for (const r of loaded.records) {
  console.log(
    `${r.street.padEnd(7)} ${r.seatId.padEnd(9)} ${r.actionType.padEnd(5)} ` +
      `board=[${(r.board ?? []).join(' ')}]`.padEnd(24) +
      ` holeCards=${r.holeCards === undefined ? '（未记录）' : `[${r.holeCards.join(' ')}]`}`,
  );
}

/* ============================================================
 * 回放：用**生产函数** `replayHand` 重建，与当时的真实输入逐字段比对
 * ============================================================ */

console.log('\n=== 回放校验（用生产函数 `replayHand`）===');
const truth = tableStateToManualHandInput(state);
if (!truth.ok) throw new Error(`真实输入构造失败：${JSON.stringify(truth.issues)}`);

const all = replayAllHands(loaded.records);
console.log(`记录共 ${loaded.records.length} 条 ⇒ 回放出 ${all.length} 手`);

let checked = 0;
for (const r of all) {
  if (!r.ok) {
    console.log(`❌ 回放失败：${r.issues.map((i) => `${i.code} ${i.message}`).join('；')}`);
    continue;
  }

  /*
   * 回放出的东西要能与**当时的真实输入**对齐：
   * - `board` / `heroCards` 必须与牌桌当时的取值一致；
   * - 行动序列的（位置 / 类型 / 街道）必须与引擎记录下来的行动历史一致。
   */
  const replayActions = r.actions.map((a) => `${a.position} ${a.street} ${a.actionType}`);
  const truthActions = truth.input.actionHistory.map((a) => `${a.position} ${a.street ?? 'PREFLOP'} ${a.type}`);

  console.log(`\n手 ${r.handId}：`);
  console.log(`  记录条数            = ${r.actions.length}（带公共牌 ${r.recordsWithBoard} 条 / 带底牌 ${r.recordsWithCards} 条）`);
  console.log(`  回放 board          = [${r.board.join(' ')}]   真实 = [${truth.input.board.join(' ')}]`);
  console.log(`  回放 heroCards      = [${(r.heroCards ?? []).join(' ')}]   真实 = [${truth.input.heroCards.join(' ')}]`);
  console.log(`  回放 行动条数       = ${replayActions.length}   真实 = ${truthActions.length}`);

  const boardOk = r.board.join(' ') === truth.input.board.join(' ');
  const holesOk = (r.heroCards ?? []).join(' ') === truth.input.heroCards.join(' ');
  const actionsOk =
    replayActions.length === truthActions.length && replayActions.every((x, i) => x === truthActions[i]);
  const streets = [...new Set(r.actions.map((a) => a.street))].sort();
  console.log(`  覆盖街道            = ${streets.join(' / ')}`);
  console.log(`  ⇒ board ${boardOk ? '✅' : '❌'} | heroCards ${holesOk ? '✅' : '❌'} | 行动序列 ${actionsOk ? '✅' : '❌'}`);
  if (!actionsOk) {
    console.log(`     回放：${replayActions.join(' ｜ ')}`);
    console.log(`     真实：${truthActions.join(' ｜ ')}`);
  }
  checked += 1;
}
console.log(`\n成功校验手数 = ${checked}`);

console.log('\n=== 旧记录（本次修复前写入的 1,036 条）的真实状态 ===');
const oldPath = join(process.cwd(), 'data', 'player-history.jsonl');
if (existsSync(oldPath)) {
  const old = loadObservations(join(process.cwd(), 'data'));
  if (old.ok) {
    const withBoard = old.records.filter((x) => x.board !== undefined).length;
    const withCards = old.records.filter((x) => x.holeCards !== undefined).length;
    console.log(`  条数 = ${old.records.length}`);
    console.log(`  带 board 的 = ${withBoard}；带 holeCards 的 = ${withCards}`);
    console.log(`  ⇒ 旧记录**不可回放**（当时没记牌面）。这是历史事实，不会被追溯补上。`);
  } else {
    console.log('  读取失败（不影响本次结论）');
  }
} else {
  console.log('  没有 data/player-history.jsonl');
}

rmSync(dir, { recursive: true, force: true });
