/**
 * 红队探针（本轮：座位生命周期 / 玩家身份 / 手牌历史完整性）
 *
 * 目标：不读注释，只用**执行**证明「屏幕 = 提交 = 后端」这条链在
 * 座位生命周期操作下是否仍然成立。
 *
 * 运行：
 *   node.exe --experimental-strip-types "scripts/rt-table-lifecycle-probe.ts"
 *
 * 输出：既打到 stdout，也由脚本自己用 fs.writeFileSync(..., 'utf8') 落盘，
 *       避免 Windows PowerShell 重定向把中文写坏。
 */

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Position } from '../src/domain/types.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { createTable, seatOfPosition, staffingProblems, visualSeatOrder } from '../src/app/table/tableState.ts';
import { applyTableOp, engineViewOf } from '../src/app/table/tableOps.ts';
import { buildTablePreview, stateFingerprintOf } from '../src/app/table/tablePreview.ts';
import {
  primaryOpponentPosition,
  tableStateToManualHandInput,
} from '../src/app/table/tableAdapter.ts';
import { buildTablePreview as _preview } from '../src/app/table/tablePreview.ts';
import { handleTableRequest, parseTableState, RevisionGuard } from '../src/app/table/tableApi.ts';
import {
  ActiveHandLeaveChoice,
  SeatStatus,
  type PokerTableState,
  type TableOp,
} from '../src/app/table/table.types.ts';

void _preview;

/* ============================================================
 * 输出收集
 * ============================================================ */

const OUT: string[] = [];
let HITS = 0;
let FAILS = 0;

function line(text = ''): void {
  OUT.push(text);
  console.log(text);
}
function head(title: string): void {
  line('');
  line('='.repeat(78));
  line(`== ${title}`);
  line('='.repeat(78));
}
function info(text: string): void {
  line(`   · ${text}`);
}
function ok(text: string): void {
  line(`   PASS  ${text}`);
}
function hit(text: string): void {
  HITS += 1;
  line(`   >>> HIT  ${text}`);
}
function fail(text: string): void {
  FAILS += 1;
  line(`   !!! FAIL ${text}`);
}
function expectEq<T>(label: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(`${label} = ${JSON.stringify(actual)}`);
  else fail(`${label} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function guard(label: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    fail(`${label} 抛出异常：${(error as Error).message}`);
  }
}

/* ============================================================
 * 驱动辅助
 * ============================================================ */

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;

const ORDER_6: readonly Position[] = [
  Position.UTG,
  Position.HJ,
  Position.CO,
  Position.BTN,
  Position.SB,
  Position.BB,
];
const ORDER_9: readonly Position[] = [
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

function must(result: ReturnType<typeof applyTableOp>): PokerTableState {
  if (!result.ok) {
    throw new Error(`操作被拒绝：${result.issues.map((i) => i.message).join(' / ')}`);
  }
  return result.state;
}

function run(start: PokerTableState, ops: readonly TableOp[]): PokerTableState {
  let state = start;
  for (const op of ops) state = must(applyTableOp(state, op));
  return state;
}

function fullTable(hero: Position, stackBB = 100, size: 6 | 9 = 6): PokerTableState {
  let state = createTable({ tableSize: size, heroPosition: hero, defaultStackBB: stackBB });
  for (const position of size === 6 ? ORDER_6 : ORDER_9) {
    if (position === hero) continue;
    state = must(applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, position)!.seatId }));
  }
  return state;
}

function click(state: PokerTableState, type: string, sizeIndex = 0): PokerTableState {
  const p = buildTablePreview(state);
  const sizes = p.actionButtons.filter((b) => b.type === type && b.group === 'SIZE');
  const pool = sizes.length > 0 ? sizes : p.actionButtons.filter((b) => b.type === type);
  const button = pool[sizeIndex] ?? pool[0];
  if (button === undefined) {
    throw new Error(
      `没有可点的「${type}」按钮；当前按钮：${p.actionButtons.map((b) => b.labelZh).join(' / ') || '（无）'}`,
    );
  }
  return must(
    applyTableOp(state, {
      kind: 'ACT',
      action: {
        type: button.type,
        ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
      },
    }),
  );
}

/** 引擎口径快照：底池（筹码）、逐位置投入、剩余、指纹 */
function engineSnapshot(state: PokerTableState): {
  ok: boolean;
  potChips: number;
  totalRemaining: number;
  totalCommitted: number;
  commits: string;
  fingerprint: string;
  historyLength: number;
  actor: string | null;
} {
  const view = engineViewOf(state);
  if (!view.ok) {
    return {
      ok: false,
      potChips: -1,
      totalRemaining: -1,
      totalCommitted: -1,
      commits: '',
      fingerprint: '（引擎重建失败）',
      historyLength: state.actionHistory.length,
      actor: null,
    };
  }
  const commits = view.engine.players
    .map((p) => [p.position, Object.values(p.committedByStreet).reduce((a, b) => a + b, 0)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    ok: true,
    potChips: commits.reduce((sum, [, c]) => sum + c, 0),
    totalRemaining: view.engine.players.reduce((sum, p) => sum + p.remainingStack, 0),
    totalCommitted: commits.reduce((sum, [, c]) => sum + c, 0),
    commits: JSON.stringify(commits),
    fingerprint: stateFingerprintOf(view.engine),
    historyLength: view.engine.actions.length,
    actor: null,
  };
}

function potBB(state: PokerTableState): number {
  return buildTablePreview(state).potBB;
}

function coreJson(state: PokerTableState): string {
  const { undo: _undo, revision: _revision, ...rest } = state;
  void _undo;
  void _revision;
  return JSON.stringify(rest);
}

function hashOf(rel: string): string {
  try {
    const abs = fileURLToPath(new URL(`../${rel}`, import.meta.url));
    return createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16);
  } catch {
    return '（读不到）';
  }
}

function mockDeps() {
  let n = 0;
  return { newTableId: () => `t${(n += 1)}`, guard: new RevisionGuard() };
}

/* ============================================================
 * §0 冻结被测版本
 * ============================================================ */

head('§0 被测版本（哈希，用来证明这次审计针对哪一份代码）');
for (const rel of [
  'src/app/table/table.types.ts',
  'src/app/table/tableState.ts',
  'src/app/table/seatLifecycle.ts',
  'src/app/table/tableOps.ts',
  'src/app/table/tableAdapter.ts',
  'src/app/table/tablePreview.ts',
  'src/app/table/tableApi.ts',
  'src/app/webServer.ts',
  'src/app/web/table.js',
]) {
  info(`${hashOf(rel)}  ${rel}`);
}

/* ============================================================
 * §1 Hero 视觉旋转 vs 逻辑位置
 * ============================================================ */

head('§1 Hero 视觉旋转不得污染逻辑位置（6 人桌 + 9 人桌，全部 Hero 位置）');

for (const [size, order] of [
  [6, ORDER_6],
  [9, ORDER_9],
] as const) {
  info(`---- ${size} 人桌 ----`);
  for (const hero of order) {
    guard(`§1 ${size}max Hero=${hero}`, () => {
      const state = fullTable(hero, 100, size);
      const heroSeat = seatOfPosition(state, hero)!;
      const visuals = [...state.seats].sort((a, b) => a.visualIndex - b.visualIndex);
      const angleByPosition = visuals
        .map((s) => `${s.logicalPosition}:v${s.visualIndex}/${Math.round((s.visualIndex * 360) / size)}°`)
        .join(' ');
      const problems: string[] = [];
      if (heroSeat.visualIndex !== 0) problems.push(`Hero visualIndex=${heroSeat.visualIndex}`);
      if (heroSeat.logicalPosition !== hero) problems.push('Hero logicalPosition 不匹配');
      if (new Set(state.seats.map((s) => s.visualIndex)).size !== size) problems.push('视觉序号有重复');
      if (visuals[0]!.logicalPosition !== hero) problems.push('视觉 0 号位不是 Hero');
      const expectedVisual = visualSeatOrder(size, hero);
      if (JSON.stringify(visuals.map((s) => s.logicalPosition)) !== JSON.stringify(expectedVisual)) {
        problems.push('视觉顺序 != rotateAroundHero');
      }
      // 提交给引擎的输入里 heroPosition 必须是逻辑位置，且不得出现任何视觉字段
      const withCards: PokerTableState = { ...state, heroCards: ['As', 'Kd'], handActive: true };
      const adapted = tableStateToManualHandInput(withCards);
      if (!adapted.ok) {
        problems.push(`适配失败：${adapted.issues.map((i) => i.message).join('；')}`);
      } else {
        if (adapted.input.heroPosition !== hero) problems.push('input.heroPosition != 逻辑位置');
        const payload = JSON.stringify(adapted.input);
        for (const leak of ['visualIndex', 'angleDeg']) {
          if (payload.includes(leak)) problems.push(`提交载荷里出现视觉字段 ${leak}`);
        }
      }
      // 引擎重建出的第一个行动者必须与 Hero 是谁无关（翻牌前 = UTG）
      const view = engineViewOf({ ...state, heroCards: ['As', 'Kd'], handActive: true });
      const actor = view.ok
        ? [...view.engine.players].sort((a, b) => a.seat - b.seat)[0]!.position
        : '（重建失败）';
      if (actor !== Position.UTG) problems.push(`引擎口径第一个座位=${actor}`);
      const engineFp = view.ok ? stateFingerprintOf(view.engine) : '（失败）';
      const actorOnTurnPos = buildTablePreview({ ...state, heroCards: ['As', 'Kd'], handActive: true })
        .currentActorPosition;

      if (problems.length === 0) {
        ok(`Hero=${hero.padEnd(4)} ${angleByPosition}`);
        info(`        引擎指纹=${engineFp.slice(0, 40)}… 行动者=${String(actorOnTurnPos)} u=${state.undo.length}`);
      } else {
        fail(`Hero=${hero} ${problems.join('；')}`);
      }
    });
  }
}

head('§1b 差分：同一个逻辑牌局，Hero 位置不同 → 引擎状态必须逐位一致（只有 heroPosition 变）');
guard('§1b', () => {
  const buildAt = (hero: Position): { input: unknown; fp: string } => {
    let state = fullTable(hero);
    state = run(state, [
      { kind: 'SET_HERO_CARD', card: 'As' },
      { kind: 'SET_HERO_CARD', card: 'Kd' },
    ]);
    const adapted = tableStateToManualHandInput(state);
    if (!adapted.ok) throw new Error(adapted.issues.map((i) => i.message).join('；'));
    const view = engineViewOf(state);
    if (!view.ok) throw new Error('引擎重建失败');
    return { input: adapted.input, fp: stateFingerprintOf(view.engine) };
  };
  const a = buildAt(Position.CO);
  const b = buildAt(Position.SB);
  if (a.fp === b.fp) ok(`Hero=CO 与 Hero=SB 的引擎指纹逐位一致：${a.fp.slice(0, 48)}…`);
  else fail('引擎指纹随 Hero 位置变化 —— 视觉旋转污染了逻辑');
  const ai = a.input as Record<string, unknown>;
  const bi = b.input as Record<string, unknown>;
  if (ai['heroPosition'] !== bi['heroPosition']) ok(`heroPosition 如实不同：${String(ai['heroPosition'])} vs ${String(bi['heroPosition'])}`);
  else fail('heroPosition 没有随 Hero 变化');
});

/* ============================================================
 * §2 Fold ≠ Leave Table
 * ============================================================ */

head('§2 Fold ≠ Leave Table');
guard('§2', () => {
  let state = fullTable(Position.CO);
  const utgId = seatOfPosition(state, Position.UTG)!.playerId!;
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  info(`翻牌前第一个行动者 = ${String(buildTablePreview(state).currentActorPosition)}`);
  const before = engineSnapshot(state);
  state = click(state, 'FOLD');
  const seat = seatOfPosition(state, Position.UTG)!;
  expectEq('弃牌后 status', seat.status, SeatStatus.FOLDED_THIS_HAND);
  expectEq('弃牌后 playerId 仍在', seat.playerId, utgId);
  expectEq('弃牌后行动历史长度', state.actionHistory.length, 1);
  const after = engineSnapshot(state);
  if (after.commits === before.commits) ok('弃牌不改变任何人的投入（筹码守恒）');
  else fail(`投入被改动：${before.commits} → ${after.commits}`);
  const next = must(applyTableOp(state, { kind: 'NEXT_HAND' }));
  expectEq('下一手 UTG 仍在原座位', seatOfPosition(next, Position.UTG)!.playerId, utgId);
  expectEq('下一手 UTG 状态', seatOfPosition(next, Position.UTG)!.status, SeatStatus.SEATED_ACTIVE);
  expectEq('下一手行动历史清空', next.actionHistory.length, 0);
  // 弃牌者绝不能被当成离桌：playersById 里必须仍有他，且座位仍引用他
  if (next.playersById[utgId] !== undefined) ok('弃牌者对象仍在 playersById（可追溯）');
  else fail('弃牌者对象消失');
});

head('§2b ClearSeat（离桌）在本手进行中必须要求用户明确选择');
guard('§2b', () => {
  let state = fullTable(Position.CO);
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  const seatId = seatOfPosition(state, Position.UTG)!.seatId;
  const rejected = applyTableOp(state, { kind: 'CLEAR_SEAT', seatId });
  expectEq('直接清空被拒绝', rejected.ok, false);
  if (!rejected.ok) {
    expectEq('拒绝码', rejected.issues[0]!.code, 'NEEDS_LEAVE_DECISION');
    info(`离桌选项：${(rejected.leaveDecision?.options ?? []).join(' / ')}`);
    info(`stillToAct=${String(rejected.leaveDecision?.stillToAct)}（当前行动者=${String(buildTablePreview(state).currentActorPosition)}）`);
    info(`拒绝响应里的 state.revision=${(rejected as unknown as { state?: { revision: number } }).state?.revision ?? '（无 state）'}`);
  }
  // 「本手视为弃牌并离桌」只有轮到他时才能选
  const notHisTurn = applyTableOp(state, {
    kind: 'CLEAR_SEAT',
    seatId: seatOfPosition(state, Position.SB)!.seatId,
    activeHandChoice: ActiveHandLeaveChoice.FOLD_AND_LEAVE,
  });
  expectEq('非行动者选 FOLD_AND_LEAVE 被拒绝', notHisTurn.ok, false);
  const hisTurn = applyTableOp(state, {
    kind: 'CLEAR_SEAT',
    seatId,
    activeHandChoice: ActiveHandLeaveChoice.FOLD_AND_LEAVE,
  });
  expectEq('行动者选 FOLD_AND_LEAVE 被接受', hisTurn.ok, true);
  if (hisTurn.ok) {
    const s = seatOfPosition(hisTurn.state, Position.UTG)!;
    expectEq('FOLD_AND_LEAVE 后 status', s.status, SeatStatus.LEAVING_AFTER_HAND);
    expectEq('FOLD_AND_LEAVE 后历史长度（必须真实记一条 FOLD）', hisTurn.state.actionHistory.length, 1);
    info(`历史：${JSON.stringify(hisTurn.state.actionHistory)}`);
  }
});

/* ============================================================
 * §3 Leave 不得删除底池 / 破坏筹码守恒
 * ============================================================ */

head('§3 Leave ≠ 删除历史：手后离桌期间底池、投入、台账必须逐位不变');
guard('§3', () => {
  let state = fullTable(Position.CO);
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  state = click(state, 'RAISE'); // UTG 加注到 2BB？
  const before = engineSnapshot(state);
  info(`加注后：底池=${before.potChips} 筹码，投入=${before.commits}`);
  info(`历史长度=${state.actionHistory.length}，底池(BB)=${potBB(state)}`);

  const left = must(
    applyTableOp(state, {
      kind: 'CLEAR_SEAT',
      seatId: seatOfPosition(state, Position.UTG)!.seatId,
      activeHandChoice: ActiveHandLeaveChoice.LEAVE_AFTER_HAND,
    }),
  );
  const afterLeave = engineSnapshot(left);
  expectEq('手后离桌：引擎指纹不变', afterLeave.fingerprint, before.fingerprint);
  expectEq('手后离桌：历史长度不变', left.actionHistory.length, state.actionHistory.length);
  expectEq('手后离桌：底池 BB 不变', potBB(left), potBB(state));
  expectEq('手后离桌：座位仍绑定', seatOfPosition(left, Position.UTG)!.playerId !== null, true);
  expectEq('手后离桌：状态标记', seatOfPosition(left, Position.UTG)!.status, SeatStatus.LEAVING_AFTER_HAND);

  // 手后离桌者仍必须出现在送进管线的对手列表里（他还在这一手里）
  const adapted = tableStateToManualHandInput(left);
  if (adapted.ok) {
    const ids = adapted.input.villains === undefined ? [] : adapted.input.villains.map((v) => v.playerId);
    info(`送进管线的对手列表：villain=${String(adapted.input.villain?.playerId)}；villains=${JSON.stringify(ids)}`);
    expectEq('送进管线的对手含 seat_UTG', ids.includes('seat_UTG') || adapted.input.villain?.playerId === 'seat_UTG', true);
  } else fail(`手后离桌后适配失败：${adapted.issues.map((i) => i.message).join('；')}`);

  // 下一手：这时才真正清空座位
  const next = must(applyTableOp(left, { kind: 'NEXT_HAND' }));
  expectEq('下一手：座位清空', seatOfPosition(next, Position.UTG)!.playerId, null);
  expectEq('下一手：状态 EMPTY', seatOfPosition(next, Position.UTG)!.status, SeatStatus.EMPTY);
  info(`下一手 notices：${JSON.stringify(next.notices)}`);
});

head('§3b NEXT_HAND 的筹码守恒（底池未分配是否为「显式」行为）');
guard('§3b', () => {
  let state = fullTable(Position.CO, 100);
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  state = click(state, 'RAISE');
  const before = engineSnapshot(state);
  const next = must(applyTableOp(state, { kind: 'NEXT_HAND' }));
  const afterChips = next.seats.reduce((sum, s) => sum + (s.playerId === null ? 0 : s.stackBB * 100), 0);
  info(`下一手前：剩余合计=${before.totalRemaining} 筹码，底池=${before.potChips} 筹码，合计=${before.totalRemaining + before.potChips}`);
  info(`下一手后：座位筹码合计=${afterChips} 筹码`);
  info(`差额（消失的筹码）= ${afterChips - (before.totalRemaining + before.potChips)}（若等于 -底池，说明底池确实没被分配）`);
  const noticeMentionsPot = next.notices.some((n) => n.includes('底池') && n.includes('未分配'));
  expectEq('NEXT_HAND 必须显式提示「底池未分配」', noticeMentionsPot, true);
  info(`上一手剩余筹码表 lastHandRemainingStacksBB = ${JSON.stringify(next.lastHandRemainingStacksBB)}`);
});

/* ============================================================
 * §4 玩家身份：画像/动态必须绑定到正确的人
 * ============================================================ */

head('§4a 换人不得继承旧画像（quickProfile / dynamicHint / handsPlayed）');
guard('§4a', () => {
  let state = fullTable(Position.CO);
  const seatId = seatOfPosition(state, Position.HJ)!.seatId;
  state = run(state, [
    { kind: 'SET_PROFILE', seatId, quickProfile: 'CALLING_STATION' },
    { kind: 'SET_DYNAMIC_HINT', seatId, dynamicHint: 'TILT_SIGNAL' },
  ]);
  state = must(applyTableOp(state, { kind: 'NEXT_HAND' })); // handsPlayed +1
  const oldId = seatOfPosition(state, Position.HJ)!.playerId!;
  info(`旧玩家 ${oldId}: profile=${state.playersById[oldId]!.quickProfile} dyn=${state.playersById[oldId]!.dynamicHint} hands=${state.playersById[oldId]!.handsPlayed}`);
  const replaced = must(applyTableOp(state, { kind: 'REPLACE_PLAYER', seatId }));
  const newId = seatOfPosition(replaced, Position.HJ)!.playerId!;
  const p = replaced.playersById[newId]!;
  expectEq('新 playerId 不同', newId !== oldId, true);
  expectEq('新玩家 quickProfile', p.quickProfile, 'UNKNOWN');
  expectEq('新玩家 dynamicHint', p.dynamicHint, 'UNKNOWN');
  expectEq('新玩家 handsPlayed', p.handsPlayed, 0);
  expectEq('旧玩家不再被任何座位引用', replaced.seats.some((s) => s.playerId === oldId), false);
  expectEq('新玩家筹码=默认', seatOfPosition(replaced, Position.HJ)!.stackBB, replaced.defaultStackBB);
});

head('§4b ⚠ 关键：送进决策引擎的 villain 画像/动态 到底属于谁');
guard('§4b', () => {
  /*
   * 场景：Hero 在 BB；UTG 弃牌；HJ 加注；CO/BTN/SB 弃牌 → 轮到 Hero。
   * 引擎口径的首要对手（决定范围与权益）应当是 **HJ**。
   * 探针检查：画像字段最终挂在谁身上。
   */
  const build = (): PokerTableState => {
    let state = fullTable(Position.BB);
    state = run(state, [
      { kind: 'SET_HERO_CARD', card: 'As' },
      { kind: 'SET_HERO_CARD', card: 'Kd' },
    ]);
    state = click(state, 'FOLD'); // UTG 弃牌
    state = click(state, 'RAISE'); // HJ 加注
    state = click(state, 'FOLD'); // CO
    state = click(state, 'FOLD'); // BTN
    state = click(state, 'FOLD'); // SB
    return state;
  };
  const base = build();
  info(`当前行动者 = ${String(buildTablePreview(base).currentActorPosition)}（应为 BB=Hero）`);
  const primary = primaryOpponentPosition(base);
  info(`适配器认定的首要对手 primaryOpponentPosition = ${String(primary)}`);

  const withUtgManiac = must(
    applyTableOp(base, {
      kind: 'SET_PROFILE',
      seatId: seatOfPosition(base, Position.UTG)!.seatId,
      quickProfile: 'MANIAC',
    }),
  );
  const withHjManiac = must(
    applyTableOp(base, {
      kind: 'SET_PROFILE',
      seatId: seatOfPosition(base, Position.HJ)!.seatId,
      quickProfile: 'MANIAC',
    }),
  );

  const adapt = (s: PokerTableState) => {
    const a = tableStateToManualHandInput(s);
    if (!a.ok) throw new Error(a.issues.map((i) => i.message).join('；'));
    return a.input;
  };
  const inA = adapt(withUtgManiac);
  const inB = adapt(withHjManiac);
  info(`适配器输出 villain.playerId            = ${String(inA.villain!.playerId)}（画像：${String(inA.villain!.quickProfile)}）`);
  info(`适配器是否输出 villains 数组           = ${String(inA.villains !== undefined)}`);

  const pA = parseManualInput(inA);
  const pB = parseManualInput(inB);
  if (!pA.ok || !pB.ok) {
    fail(`parseManualInput 失败`);
    return;
  }
  info(`解析后 villain.playerId（A：UTG=MANIAC） = ${String(pA.value.villain.playerId)}`);
  info(`解析后 villain.playerId（B：HJ=MANIAC）  = ${String(pB.value.villain.playerId)}`);
  const expectedVillainId = `seat_${String(primary)}`;
  if (pA.value.villain.playerId === expectedVillainId && pB.value.villain.playerId === expectedVillainId) {
    ok(`解析后的 villain 就是首要对手 ${expectedVillainId}（画像不会挂到已弃牌者身上）`);
  } else {
    hit(
      `解析后的 villain 是 ${String(pA.value.villain.playerId)} / ${String(pB.value.villain.playerId)}，` +
        `而真正的首要对手是 ${expectedVillainId} —— 画像/动态绑定到了**另一个人**`,
    );
  }
  if (inA.villains !== undefined) {
    hit('适配器仍然传了 villains 数组（只要传了，input.villain 就会被 parseManualInput 忽略）');
  } else {
    ok('适配器只传 villain，不传 villains 数组');
  }

  const dA = analyzeManualHand(inA, OPTIONS);
  const dB = analyzeManualHand(inB, OPTIONS);
  if (!dA.ok || !dB.ok) {
    fail(`分析失败：${dA.ok ? '' : JSON.stringify(dA.issues)}`);
    return;
  }
  const psA = dA.decision.diagnostics.player;
  const psB = dB.decision.diagnostics.player;
  info(`A（UTG=MANIAC）玩家快照：playerId=${String(psA?.playerId)} confidence=${String(psA?.confidence)}`);
  info(`      note=${String(psA?.note)}`);
  info(`B（HJ =MANIAC）玩家快照：playerId=${String(psB?.playerId)} confidence=${String(psB?.confidence)}`);
  info(`      note=${String(psB?.note)}`);
  if (psA?.playerId === expectedVillainId && psA.note.includes('MANIAC')) {
    hit('决策引擎收到的「玩家画像」属于**已经弃牌的 UTG**，而范围/权益是按 HJ 算的');
  } else if (psB?.playerId === expectedVillainId && psB.note.includes('MANIAC') && !String(psA?.note).includes('MANIAC')) {
    ok('画像确实只跟随**真正推动范围的那一位**（设在已弃牌者上不生效，设在首要对手上生效）');
  } else {
    info('（画像归属需要人工判读上面的 playerId / note）');
  }
  info(`A 动作=${dA.decision.action} 置信度=${dA.decision.confidence} / B 动作=${dB.decision.action} 置信度=${dB.decision.confidence}`);
  info(`A 动态快照=${JSON.stringify(dA.decision.diagnostics.dynamic)}`);
  info(`B 动态快照=${JSON.stringify(dB.decision.diagnostics.dynamic)}`);
});

head('§4c 动态观察（dynamicHint）是否也挂错人');
guard('§4c', () => {
  const build = (): PokerTableState => {
    let state = fullTable(Position.BB);
    state = run(state, [
      { kind: 'SET_HERO_CARD', card: 'As' },
      { kind: 'SET_HERO_CARD', card: 'Kd' },
    ]);
    state = click(state, 'FOLD');
    state = click(state, 'RAISE');
    state = click(state, 'FOLD');
    state = click(state, 'FOLD');
    state = click(state, 'FOLD');
    return state;
  };
  const withUtgHint = must(
    applyTableOp(build(), {
      kind: 'SET_DYNAMIC_HINT',
      seatId: seatOfPosition(build(), Position.UTG)!.seatId,
      dynamicHint: 'TILT_SIGNAL',
    }),
  );
  const withHjHint = must(
    applyTableOp(build(), {
      kind: 'SET_DYNAMIC_HINT',
      seatId: seatOfPosition(build(), Position.HJ)!.seatId,
      dynamicHint: 'TILT_SIGNAL',
    }),
  );
  const adapt = (s: PokerTableState) => {
    const a = tableStateToManualHandInput(s);
    if (!a.ok) throw new Error(a.issues.map((i) => i.message).join('；'));
    return a.input;
  };
  const a = analyzeManualHand(adapt(withUtgHint), OPTIONS);
  const b = analyzeManualHand(adapt(withHjHint), OPTIONS);
  if (!a.ok || !b.ok) {
    fail('分析失败');
    return;
  }
  info(`弃牌的 UTG 上设 TILT：playerId=${String(a.decision.diagnostics.player?.playerId)} dynamic.state=${String(a.decision.diagnostics.dynamic?.state)}`);
  info(`真正对手 HJ 上设 TILT：playerId=${String(b.decision.diagnostics.player?.playerId)} dynamic.state=${String(b.decision.diagnostics.dynamic?.state)}`);
  if (a.decision.diagnostics.player?.playerId === 'seat_HJ' && b.decision.diagnostics.player?.playerId === 'seat_HJ') {
    ok('两条情形下玩家层都绑定到 seat_HJ（首要对手），不再随「谁先入座」漂移');
  } else {
    hit(`玩家层绑定仍然漂移：${String(a.decision.diagnostics.player?.playerId)} / ${String(b.decision.diagnostics.player?.playerId)}`);
  }
});

/* ============================================================
 * §5 SIT_OUT
 * ============================================================ */

head('§4d 对照实验：同一条用户提示，作用效果取决于「座位序」而不是「谁是对手」');
guard('§4d', () => {
  /** 场景 P：UTG 加注，其余弃牌 → villains[0] 恰好就是首要对手 UTG */
  const scenarioP = (hintOn: Position | null): PokerTableState => {
    let state = fullTable(Position.BB);
    state = run(state, [
      { kind: 'SET_HERO_CARD', card: 'As' },
      { kind: 'SET_HERO_CARD', card: 'Kd' },
    ]);
    if (hintOn !== null) {
      state = must(
        applyTableOp(state, {
          kind: 'SET_DYNAMIC_HINT',
          seatId: seatOfPosition(state, hintOn)!.seatId,
          dynamicHint: 'TILT_SIGNAL',
        }),
      );
    }
    state = click(state, 'RAISE'); // UTG
    for (let i = 0; i < 4; i += 1) state = click(state, 'FOLD');
    return state;
  };
  /** 场景 Q：UTG 弃牌，HJ 加注，其余弃牌 → villains[0]=UTG（已弃牌），首要对手=HJ */
  const scenarioQ = (hintOn: Position | null): PokerTableState => {
    let state = fullTable(Position.BB);
    state = run(state, [
      { kind: 'SET_HERO_CARD', card: 'As' },
      { kind: 'SET_HERO_CARD', card: 'Kd' },
    ]);
    if (hintOn !== null) {
      state = must(
        applyTableOp(state, {
          kind: 'SET_DYNAMIC_HINT',
          seatId: seatOfPosition(state, hintOn)!.seatId,
          dynamicHint: 'TILT_SIGNAL',
        }),
      );
    }
    state = click(state, 'FOLD'); // UTG
    state = click(state, 'RAISE'); // HJ
    for (let i = 0; i < 3; i += 1) state = click(state, 'FOLD'); // CO/BTN/SB
    return state;
  };
  const report = (label: string, state: PokerTableState): void => {
    const adapted = tableStateToManualHandInput(state);
    if (!adapted.ok) {
      fail(`${label} 适配失败`);
      return;
    }
    const parsed = parseManualInput(adapted.input);
    const res = analyzeManualHand(adapted.input, OPTIONS);
    info(
      `${label}：primary=${String(primaryOpponentPosition(state))} input.villain=${String(adapted.input.villain?.playerId)} ` +
        `解析后 villain=${parsed.ok ? String(parsed.value.villain.playerId) : '解析失败'} ` +
        `动作=${res.ok ? res.decision.action : '失败'} 置信度=${res.ok ? res.decision.confidence : '-'} ` +
        `动态=${res.ok ? String(res.decision.diagnostics.dynamic?.state) : '-'}/applied=${res.ok ? String(res.decision.diagnostics.dynamic?.applied) : '-'} ` +
        `玩家层=${res.ok ? String(res.decision.diagnostics.player?.confidence) : '-'}`,
    );
  };
  info('---- 场景 P：UTG 加注（首要对手 = 座位序第一个对手）----');
  report('P 无提示      ', scenarioP(null));
  report('P 在 UTG 提示 ', scenarioP(Position.UTG));
  info('---- 场景 Q：UTG 弃牌、HJ 加注（首要对手 HJ，但 villains[0] 是弃牌的 UTG）----');
  report('Q 无提示      ', scenarioQ(null));
  report('Q 在 UTG 提示 ', scenarioQ(Position.UTG));
  report('Q 在 HJ  提示 ', scenarioQ(Position.HJ));
  const analyzeState = (state: PokerTableState) => {
    const adapted = tableStateToManualHandInput(state);
    if (!adapted.ok) return null;
    return analyzeManualHand(adapted.input, OPTIONS);
  };
  const qOnHj = analyzeState(scenarioQ(Position.HJ));
  const qBase = analyzeState(scenarioQ(null));
  const qOnUtg = analyzeState(scenarioQ(Position.UTG));
  const pOnUtg = analyzeState(scenarioP(Position.UTG));
  const pBase = analyzeState(scenarioP(null));
  if (qOnHj !== null && qBase !== null && qOnHj.ok && qBase.ok) {
    const same =
      qOnHj.decision.action === qBase.decision.action &&
      qOnHj.decision.confidence === qBase.decision.confidence &&
      JSON.stringify(qOnHj.decision.diagnostics.dynamic) === JSON.stringify(qBase.decision.diagnostics.dynamic);
    if (same) {
      hit('把「疑似上头」设在**真正在推动范围计算的对手** HJ 上，决策输入没有任何变化（提示被静默丢弃）');
    } else {
      ok('设在真正对手 HJ 身上的提示**生效了**（这正是修复要求的行为）');
    }
  }
  if (qOnUtg !== null && qBase !== null && qOnUtg.ok && qBase.ok) {
    const same =
      qOnUtg.decision.action === qBase.decision.action &&
      qOnUtg.decision.confidence === qBase.decision.confidence;
    if (same) {
      ok('设在**已弃牌**的 UTG 身上的提示不改变决策（不再张冠李戴）');
    } else {
      hit('设在已弃牌玩家身上的提示仍然改变了决策 —— 画像/动态还是挂错了人');
    }
  }
  if (pOnUtg !== null && pBase !== null && pOnUtg.ok && pBase.ok) {
    if (pOnUtg.decision.confidence !== pBase.decision.confidence) {
      ok(`对照组：首要对手=UTG 时，同一条提示确实改变置信度（${pBase.decision.confidence} → ${pOnUtg.decision.confidence}）`);
    } else {
      info('对照组：提示没有改变置信度（可能是该局面下动态层未 applied，不作为判定依据）');
    }
  }
});

head('§2c HTTP 层：离桌决策响应必须能被客户端处理（检查真实 table.js 的行序）');
guard('§2c', () => {
  const deps = mockDeps();
  const created = handleTableRequest({ tableSize: 6, heroPosition: 'BTN' }, deps);
  if (!created.ok) {
    fail('建桌失败');
    return;
  }
  let state = created.state;
  for (const position of ORDER_6) {
    if (position === Position.BTN) continue;
    const r = handleTableRequest(
      { state: JSON.parse(JSON.stringify(state)), op: { kind: 'ADD_PLAYER', seatId: `seat_${position}` } },
      deps,
    );
    if (r.ok) state = r.state;
  }
  for (const card of ['As', 'Kd']) {
    const r = handleTableRequest(
      { state: JSON.parse(JSON.stringify(state)), op: { kind: 'SET_HERO_CARD', card } },
      deps,
    );
    if (r.ok) state = r.state;
  }
  const response = handleTableRequest(
    { state: JSON.parse(JSON.stringify(state)), op: { kind: 'CLEAR_SEAT', seatId: 'seat_UTG' } },
    deps,
  );
  info(`CLEAR_SEAT 响应：ok=${String(response.ok)} revision=${String((response as { state?: { revision: number } }).state?.revision)}（请求 revision=${state.revision}）`);
  if (!response.ok) {
    info(`  leaveDecision.options=${JSON.stringify(response.leaveDecision?.options ?? null)}`);
  }
  // 直接读真实的客户端源码，确认 leaveDecision 的处理**早于**版本判断
  const js = readFileSync(fileURLToPath(new URL('../src/app/web/table.js', import.meta.url)), 'utf8');
  const lines = js.split(/\r?\n/);
  const leaveLine = lines.findIndex((l) => l.includes('app.pendingLeave = {'));
  const guardLine = lines.findIndex((l) => /revision\s*[<>]=?\s*app\.revision/.test(l));
  info(`table.js：pendingLeave 赋值在第 ${leaveLine + 1} 行，版本判断在第 ${guardLine + 1} 行`);
  if (leaveLine >= 0 && guardLine >= 0 && leaveLine < guardLine) {
    ok('leaveDecision 在版本判断之前处理（同版本失败响应不再被整包丢弃）');
  } else {
    hit('leaveDecision 的处理仍在版本判断之后 —— 离桌选择会被丢弃');
  }
  const closeUnlessPending = js.includes('function closeUnlessPending');
  if (closeUnlessPending) ok('座位菜单使用 closeUnlessPending（有待处理离桌决策时不关弹层）');
  else hit('座位菜单仍使用 closeModal —— 弹层会被立刻关掉');
});

head('§5 SIT_OUT（本手未开始）：不得清历史、不得改当前手');
guard('§5', () => {
  let state = fullTable(Position.CO);
  const seatId = seatOfPosition(state, Position.BB)!.seatId;
  const playerId = seatOfPosition(state, Position.BB)!.playerId!;
  state = must(applyTableOp(state, { kind: 'SET_PROFILE', seatId, quickProfile: 'MANIAC' }));
  const before = { history: state.actionHistory.length, players: JSON.stringify(state.playersById) };
  const out = must(applyTableOp(state, { kind: 'SIT_OUT', seatId }));
  expectEq('暂离后仍绑定同一玩家', seatOfPosition(out, Position.BB)!.playerId, playerId);
  expectEq('暂离后状态', seatOfPosition(out, Position.BB)!.status, SeatStatus.SITTING_OUT);
  expectEq('暂离后画像保留', out.playersById[playerId]!.quickProfile, 'MANIAC');
  expectEq('暂离不改行动历史', out.actionHistory.length, before.history);
  expectEq('暂离不改玩家表', JSON.stringify(out.playersById), before.players);
  expectEq('暂离必须如实报告「无法分析」', staffingProblems(out).some((p) => p.includes('暂离')), true);
  expectEq(
    '暂离时引擎重建必须失败（不许拿错牌局算）',
    engineViewOf({ ...out, heroCards: ['As', 'Kd'] }).ok,
    false,
  );
  const back = must(applyTableOp(out, { kind: 'SIT_IN', seatId }));
  expectEq('重新入座后状态', seatOfPosition(back, Position.BB)!.status, SeatStatus.SEATED_ACTIVE);
  expectEq('重新入座后引擎可重建', engineViewOf({ ...back, heroCards: ['As', 'Kd'] }).ok, true);
});

head('§5c 本手进行中点「暂时离座」：只应标记下一手，当前手必须完全不受影响');
guard('§5c', () => {
  let state = fullTable(Position.CO);
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  const before = buildTablePreview(state);
  const beforeFp = engineSnapshot(state).fingerprint;
  info(`暂离前：当前行动者=${String(before.currentActorPosition)}，按钮=${before.actionButtons.map((b) => b.labelZh).join(' / ')}`);
  const out = must(applyTableOp(state, { kind: 'SIT_OUT', seatId: seatOfPosition(state, Position.SB)!.seatId }));
  const after = buildTablePreview(out);
  const sb = seatOfPosition(out, Position.SB)!;
  info(`暂离标记后：SB.status=${sb.status} sitOutNextHand=${String((sb as unknown as { sitOutNextHand: boolean }).sitOutNextHand)}`);
  info(`             当前行动者=${String(after.currentActorPosition)} 按钮数=${after.actionButtons.length} 街=${after.streetZh}`);
  info(`             阻塞原因=${JSON.stringify(after.analyzeBlockers)}`);
  info(`             是否被算作 staffingProblem=${String(staffingProblems(out).some((p) => p.includes('暂离')))}`);
  if (after.currentActorPosition === before.currentActorPosition && after.actionButtons.length > 0) {
    ok('当前手完全不受影响（行动者与按钮都还在，这才是「暂离只影响下一手」）');
  } else {
    hit(`暂离标记后当前手不可用：行动者=${String(after.currentActorPosition)}，按钮数=${after.actionButtons.length}`);
  }
  if (engineSnapshot(out).fingerprint === beforeFp) ok('引擎口径逐位不变（底池/投入/行动顺序未被暂离影响）');
  else fail('暂离标记改变了引擎状态');
  const acted = click(out, 'FOLD'); // UTG 弃牌，证明暂离期间仍能继续录
  ok(`暂离标记后仍能记录行动（历史长度=${acted.actionHistory.length}）`);

  // 下一手才真正生效
  const next = must(applyTableOp(acted, { kind: 'NEXT_HAND' }));
  const sbNext = seatOfPosition(next, Position.SB)!;
  expectEq('下一手才真正变成 SITTING_OUT', sbNext.status, SeatStatus.SITTING_OUT);
  expectEq('下一手标记位复位', (sbNext as unknown as { sitOutNextHand: boolean }).sitOutNextHand, false);
  info(`下一手 notices=${JSON.stringify(next.notices)}`);
  const sitIn = applyTableOp(next, { kind: 'SIT_IN', seatId: sbNext.seatId });
  expectEq('下一手「重新入座」可用', sitIn.ok, true);
});

head('§5d 攻击：「下一手暂离」标记在界面/状态里可见吗？能不能取消？');
guard('§5d', () => {
  let state = fullTable(Position.CO);
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  const seatId = seatOfPosition(state, Position.BB)!.seatId;
  const flagged = must(applyTableOp(state, { kind: 'SIT_OUT', seatId }));
  const view = buildTablePreview(flagged);
  const seatView = view.seats.find((s) => s.logicalPosition === Position.BB)!;
  info(`标记后 SeatView：status=${seatView.status} statusZh=${seatView.statusZh}`);
  info(`SeatView 是否暴露 sitOutNextHand = ${String(Object.prototype.hasOwnProperty.call(seatView, 'sitOutNextHand'))}`);
  if (seatView.status === SeatStatus.SEATED_ACTIVE && !Object.prototype.hasOwnProperty.call(seatView, 'sitOutNextHand')) {
    hit('「下一手暂离」在预览/座位视图里完全不可见（座位仍显示「在座」）—— 使用者看不到自己刚做的暂离意图');
  } else {
    ok('暂离意图在座位上可见');
  }
  // 再点一次（模拟用户以为没生效、再点一次）
  const again = applyTableOp(flagged, { kind: 'SIT_OUT', seatId });
  expectEq('再次点「暂时离座」被拒绝', again.ok, false);
  if (!again.ok) info(`拒绝文案：${again.issues[0]!.message}`);
  // 撤销是唯一出路？
  const undone = must(applyTableOp(flagged, { kind: 'UNDO' }));
  expectEq('撤销可以取消标记', (seatOfPosition(undone, Position.BB) as unknown as { sitOutNextHand: boolean }).sitOutNextHand, false);
  info('（后端 SIT_IN 也能取消标记，但界面只在 status===SITTING_OUT 时才显示「重新入座」）');
});

head('§5e 攻击：暂离标记在各种生命周期操作下会不会串到别人身上 / 被静默丢弃');
guard('§5e', () => {
  let state = fullTable(Position.CO);
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  const bbSeatId = seatOfPosition(state, Position.BB)!.seatId;
  const flagged = must(applyTableOp(state, { kind: 'SIT_OUT', seatId: bbSeatId }));
  const flagOf = (s: PokerTableState, position: Position): boolean =>
    (seatOfPosition(s, position) as unknown as { sitOutNextHand: boolean }).sitOutNextHand;
  expectEq('标记后 BB.sitOutNextHand', flagOf(flagged, Position.BB), true);
  expectEq('标记不会污染别人（UTG）', flagOf(flagged, Position.UTG), false);
  expectEq('标记不会污染别人（SB）', flagOf(flagged, Position.SB), false);

  // RESET_HAND 是「本手当作没发生过」——暂离是跨手意图，必须保留
  const reset = must(applyTableOp(flagged, { kind: 'RESET_HAND' }));
  info(`RESET_HAND 后 BB.sitOutNextHand=${String(flagOf(reset, Position.BB))}（暂离是跨手意图，按设计应保留）`);
  info(`RESET_HAND 后 notices=${JSON.stringify(reset.notices)}`);

  // 手后离桌 + 重置本手：座位应当真正落定为 EMPTY
  let s2 = fullTable(Position.CO);
  s2 = run(s2, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
    { kind: 'ACT', action: { type: 'FOLD' } },
  ]);
  const utgSeatId = seatOfPosition(s2, Position.UTG)!.seatId;
  const leaving = must(
    applyTableOp(s2, { kind: 'CLEAR_SEAT', seatId: utgSeatId, activeHandChoice: ActiveHandLeaveChoice.LEAVE_AFTER_HAND }),
  );
  const afterReset = must(applyTableOp(leaving, { kind: 'RESET_HAND' }));
  const utgAfter = seatOfPosition(afterReset, Position.UTG)!;
  info(`「手后离桌」+「重置本手」后 UTG：playerId=${String(utgAfter.playerId)} status=${utgAfter.status} sitOutNextHand=${String((utgAfter as unknown as { sitOutNextHand: boolean }).sitOutNextHand)}`);
  expectEq('重置本手后手后离桌必须落定', utgAfter.playerId === null && utgAfter.status === SeatStatus.EMPTY, true);
  expectEq('落定后标记位必须清掉', (utgAfter as unknown as { sitOutNextHand: boolean }).sitOutNextHand, false);
  const addBack = applyTableOp(afterReset, { kind: 'ADD_PLAYER', seatId: utgSeatId });
  expectEq('落定后该座位可以重新加人', addBack.ok, true);
});

head('§5g 攻击：「下一手暂离」标记会不会被**下一个坐进来的人**继承（Seat ≠ Player）');
guard('§5g', () => {
  const flagOf = (s: PokerTableState, position: Position): boolean =>
    (seatOfPosition(s, position) as unknown as { sitOutNextHand: boolean }).sitOutNextHand;

  // 1) 本手进行中标记 UTG「下一手暂离」
  let state = fullTable(Position.CO);
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  const utgSeatId = seatOfPosition(state, Position.UTG)!.seatId;
  const oldPlayerId = seatOfPosition(state, Position.UTG)!.playerId!;
  const flagged = must(applyTableOp(state, { kind: 'SIT_OUT', seatId: utgSeatId }));
  expectEq('标记已设置', flagOf(flagged, Position.UTG), true);

  // 2) 重置本手 → 本手未开始，但「跨手意图」按设计保留
  const reset = must(applyTableOp(flagged, { kind: 'RESET_HAND' }));
  info(`RESET_HAND 后：handActive=${String(reset.handActive)}，UTG.sitOutNextHand=${String(flagOf(reset, Position.UTG))}`);

  // 3) 现在手未开始，可以直接清空座位
  const cleared = must(applyTableOp(reset, { kind: 'CLEAR_SEAT', seatId: utgSeatId }));
  const clearedSeat = seatOfPosition(cleared, Position.UTG)!;
  info(`清空座位后：playerId=${String(clearedSeat.playerId)} status=${clearedSeat.status} sitOutNextHand=${String(flagOf(cleared, Position.UTG))}`);
  if (clearedSeat.playerId === null && flagOf(cleared, Position.UTG)) {
    hit('空座位上仍挂着「下一手暂离」标记（座位已无人，标记却留着）');
  }

  // 4) 新人坐进来
  const added = must(applyTableOp(cleared, { kind: 'ADD_PLAYER', seatId: utgSeatId }));
  const newPlayerId = seatOfPosition(added, Position.UTG)!.playerId!;
  info(`新玩家 ${newPlayerId}（旧玩家 ${oldPlayerId}）坐进 UTG：sitOutNextHand=${String(flagOf(added, Position.UTG))}`);
  const next = must(applyTableOp(added, { kind: 'NEXT_HAND' }));
  const nextSeat = seatOfPosition(next, Position.UTG)!;
  info(`下一手：${newPlayerId} 的座位状态=${nextSeat.status}；staffingProblems=${JSON.stringify(staffingProblems(next)).slice(0, 90)}`);
  if (newPlayerId !== oldPlayerId && nextSeat.status === SeatStatus.SITTING_OUT) {
    hit(
      `**新玩家 ${newPlayerId} 继承了上一位玩家的「下一手暂离」意图**：他从未点过暂离，` +
        `但下一手直接被判为 SITTING_OUT，整张牌桌随即无法分析（只能靠「重新入座」救回来）`,
    );
  } else {
    ok('新玩家没有继承旧玩家的暂离标记');
  }

  // 5) 同样的路径：CLEAR_ALL_VILLAINS
  const allCleared = must(applyTableOp(reset, { kind: 'CLEAR_ALL_VILLAINS' }));
  const leftover = allCleared.seats.filter(
    (s) => s.playerId === null && (s as unknown as { sitOutNextHand: boolean }).sitOutNextHand,
  );
  info(`「清空其他玩家」后仍挂着暂离标记的空座位：${JSON.stringify(leftover.map((s) => s.logicalPosition))}`);
  if (leftover.length > 0) {
    hit('「清空其他玩家」不会清掉「下一手暂离」标记 —— 之后坐进来的人会继承它');
  }
});
head('§5f 攻击：LEAVING_AFTER_HAND 玩家在本手里的历史事实（不变量 #3）');
guard('§5f-impl', () => {
  let state = fullTable(Position.CO);
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  state = click(state, 'RAISE'); // UTG 加注
  const beforeFp = engineSnapshot(state).fingerprint;
  const beforeHistory = JSON.stringify(state.actionHistory);
  const seatId = seatOfPosition(state, Position.UTG)!.seatId;
  const left = must(
    applyTableOp(state, { kind: 'CLEAR_SEAT', seatId, activeHandChoice: ActiveHandLeaveChoice.LEAVE_AFTER_HAND }),
  );
  expectEq('离桌后引擎指纹不变', engineSnapshot(left).fingerprint, beforeFp);
  expectEq('离桌后行动台账不变', JSON.stringify(left.actionHistory), beforeHistory);
  // 离桌者仍然必须出现在送进管线的对手画像里（他还在这一手）
  const adapted = tableStateToManualHandInput(left);
  if (adapted.ok) {
    info(`离桌后送入管线的 villain=${String(adapted.input.villain?.playerId)}（首要对手=${String(primaryOpponentPosition(left))}）`);
    ok('离桌后仍能构成本手输入（历史事实完整）');
  } else {
    fail(`离桌后适配失败：${adapted.issues.map((i) => i.message).join('；')}`);
  }
  // 本手期间绝不能有人被删：所有 6 个座位仍然绑定
  expectEq('本手期间 6 个座位仍然全部绑定', left.seats.filter((s) => s.playerId !== null).length, 6);
});

head('§5b 本手进行中 SIT_OUT 之后，还能不能继续录入这一手');
guard('§5b', () => {
  let state = fullTable(Position.CO);
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  const seatId = seatOfPosition(state, Position.UTG)!.seatId;
  state = must(applyTableOp(state, { kind: 'SIT_OUT', seatId }));
  info(`标记后 UTG.status = ${seatOfPosition(state, Position.UTG)!.status}`);
  info(`标记后 notices = ${JSON.stringify(state.notices)}`);
  info(`标记后当前行动者 = ${String(buildTablePreview(state).currentActorPosition)}；可点按钮数 = ${buildTablePreview(state).actionButtons.length}`);
  const act = applyTableOp(state, { kind: 'ACT', action: { type: 'FOLD' } });
  info(`标记后尝试 ACT → ok=${String(act.ok)}（${act.ok ? '' : act.issues.map((i) => i.message).join('；').slice(0, 90)}）`);
  if (act.ok) {
    const statusAfter = seatOfPosition(act.state, Position.UTG)!.status;
    const flagAfter = (seatOfPosition(act.state, Position.UTG) as unknown as { sitOutNextHand: boolean }).sitOutNextHand;
    const next = must(applyTableOp(act.state, { kind: 'NEXT_HAND' }));
    info(`弃牌后 UTG.status=${statusAfter} sitOutNextHand=${String(flagAfter)}；下一手状态=${seatOfPosition(next, Position.UTG)!.status}`);
    if (flagAfter === true && seatOfPosition(next, Position.UTG)!.status === SeatStatus.SITTING_OUT) {
      ok('「下一手暂离」意图在本手行动后仍然保留，并在下一手生效');
    } else {
      hit('「下一手暂离」意图在本手内被 ACT/换手覆盖（下一手不会暂离）');
    }
  }
});

/* ============================================================
 * §6 本手进行中不得进新人
 * ============================================================ */

head('§6 本手进行中新增玩家必须被拒绝');
guard('§6', () => {
  let state = fullTable(Position.CO);
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
    { kind: 'ACT', action: { type: 'FOLD' } }, // UTG 已经弃牌 → 历史非空，本手确实在进行
  ]);
  info(`本手状态：handActive=${String(state.handActive)} 历史长度=${state.actionHistory.length} 手牌=${JSON.stringify([...state.heroCards])}`);
  // 人为造出「本手进行中 + 空座」（正常流程走不到；模拟被持久化/手工构造的请求）
  const hjSeatId = seatOfPosition(state, Position.HJ)!.seatId;
  const hjPlayer = seatOfPosition(state, Position.HJ)!.playerId!;
  const craftedEmpty: PokerTableState = Object.freeze({
    ...state,
    seats: Object.freeze(
      state.seats.map((s) =>
        s.seatId === hjSeatId ? Object.freeze({ ...s, playerId: null, status: SeatStatus.EMPTY }) : s,
      ),
    ),
  });
  const denied = applyTableOp(craftedEmpty, { kind: 'ADD_PLAYER', seatId: hjSeatId });
  expectEq('handActive=true 时中途加入被拒绝', denied.ok, false);
  if (!denied.ok) expectEq('拒绝码', denied.issues[0]!.code, 'HAND_ACTIVE');

  // 但如果客户端把 handActive 伪造成 false（形状校验是否拦得住？）
  const craftedHandActive: PokerTableState = Object.freeze({ ...craftedEmpty, handActive: false });
  const roundTripped = JSON.parse(JSON.stringify(craftedHandActive));
  const parsed = parseTableState(roundTripped);
  info(`伪造 handActive=false（历史长度=${craftedHandActive.actionHistory.length}，手牌=${JSON.stringify([...craftedHandActive.heroCards])}）经 parseTableState → ok=${String(parsed.ok)}`);
  if (parsed.ok) {
    hit('parseTableState 接受「handActive=false 但已有行动历史/已发手牌」的状态 —— 未校验字段自洽性');
    const added = applyTableOp(parsed.state, { kind: 'ADD_PLAYER', seatId: hjSeatId });
    expectEq('伪造状态下中途加入被接受（本应拒绝）', added.ok, true);
  } else {
    ok(`伪造状态被拒绝：${parsed.issues[0]!.message.slice(0, 80)}`);
    // 顺带确认：HTTP 层同样拒绝，且不产生副作用
    const deps = mockDeps();
    const resp = handleTableRequest(
      { state: roundTripped, op: { kind: 'ADD_PLAYER', seatId: hjSeatId } },
      deps,
    );
    expectEq('HTTP 层同样拒绝', resp.ok, false);
  }
});

/* ============================================================
 * §7 Undo
 * ============================================================ */

head('§7a Undo 必须逐位恢复（座位绑定 / 画像 / 本手状态）');
guard('§7a', () => {
  let state = fullTable(Position.CO);
  const snapshots: string[] = [coreJson(state)];
  const ops: TableOp[] = [
    { kind: 'SET_PROFILE', seatId: seatOfPosition(state, Position.HJ)!.seatId, quickProfile: 'MANIAC' },
    { kind: 'SET_DYNAMIC_HINT', seatId: seatOfPosition(state, Position.HJ)!.seatId, dynamicHint: 'TILT_SIGNAL' },
    { kind: 'SET_STACK', seatId: seatOfPosition(state, Position.HJ)!.seatId, stackBB: 42 },
    { kind: 'CLEAR_SEAT', seatId: seatOfPosition(state, Position.HJ)!.seatId },
    { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, Position.HJ)!.seatId },
    { kind: 'NEXT_HAND' },
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
    { kind: 'ACT', action: { type: 'FOLD' } },
    { kind: 'SET_HERO_POSITION', position: Position.BTN },
    { kind: 'NEW_TABLE' },
    { kind: 'SET_TABLE_SIZE', tableSize: 9 },
  ];
  for (const op of ops) {
    const before = coreJson(state);
    const result = applyTableOp(state, op);
    if (!result.ok) {
      info(`（跳过被拒绝的 op ${op.kind}：${result.issues.map((i) => i.message).join('；').slice(0, 80)}）`);
      expectEq(`被拒绝的 ${op.kind} 不得改动状态`, coreJson(state), before);
      continue;
    }
    state = result.state;
    // 空操作（状态逐位未变且未推进版本）不占撤销栈 —— 不能计入快照链
    if (coreJson(state) !== before) snapshots.push(coreJson(state));
    else info(`（${op.kind} 是空操作：状态未变、revision 未推进，不计入撤销链）`);
  }
  info(`共推进 ${snapshots.length - 1} 步，当前 undo 深度=${state.undo.length}`);
  // 逐步撤销，必须逐位回到历史快照
  let matched = 0;
  for (let i = snapshots.length - 2; i >= 0; i -= 1) {
    const undone = applyTableOp(state, { kind: 'UNDO' });
    if (!undone.ok) {
      fail(`第 ${i} 步撤销被拒绝`);
      break;
    }
    state = undone.state;
    if (coreJson(state) === snapshots[i]) matched += 1;
    else fail(`撤销第 ${i} 步后状态与历史快照不一致`);
  }
  expectEq('撤销链逐位回到每一历史快照的次数', matched, snapshots.length - 1);
});

head('§7b Undo after NEXT_HAND：底池 / 筹码 / 历史 / 玩家 必须完整回来');
guard('§7b', () => {
  let state = fullTable(Position.CO, 100);
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  state = click(state, 'RAISE');
  const beforeNext = state;
  const snapBefore = engineSnapshot(beforeNext);
  const nextHand = must(applyTableOp(beforeNext, { kind: 'NEXT_HAND' }));
  info(`下一手后：历史=${nextHand.actionHistory.length} 底池=${potBB(nextHand)} 指纹=${engineSnapshot(nextHand).fingerprint.slice(0, 40)}…`);
  const undone = must(applyTableOp(nextHand, { kind: 'UNDO' }));
  const snapAfter = engineSnapshot(undone);
  expectEq('撤销回下一手前：行动历史长度', undone.actionHistory.length, beforeNext.actionHistory.length);
  expectEq('撤销回下一手前：底池 BB', potBB(undone), potBB(beforeNext));
  expectEq('撤销回下一手前：引擎指纹', snapAfter.fingerprint, snapBefore.fingerprint);
  expectEq('撤销回下一手前：座位筹码', JSON.stringify(undone.seats.map((s) => [s.logicalPosition, s.stackBB])), JSON.stringify(beforeNext.seats.map((s) => [s.logicalPosition, s.stackBB])));
  expectEq('撤销回下一手前：handsPlayed', JSON.stringify(undone.playersById), JSON.stringify(beforeNext.playersById));
});

head('§7c Undo after NEW_TABLE：清掉的画像/历史必须能回来（且不产生错乱）');
guard('§7c', () => {
  let state = fullTable(Position.CO);
  state = must(applyTableOp(state, { kind: 'SET_PROFILE', seatId: seatOfPosition(state, Position.UTG)!.seatId, quickProfile: 'MANIAC' }));
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
    { kind: 'ACT', action: { type: 'FOLD' } },
  ]);
  const before = state;
  const fresh = must(applyTableOp(state, { kind: 'NEW_TABLE' }));
  info(`新牌桌：playersById=${JSON.stringify(Object.keys(fresh.playersById))} 历史=${fresh.actionHistory.length} 底池=${potBB(fresh)}`);
  expectEq('新牌桌玩家对象只剩 Hero', Object.keys(fresh.playersById).length, 1);
  const back = must(applyTableOp(fresh, { kind: 'UNDO' }));
  expectEq('撤销新牌桌：玩家表恢复', JSON.stringify(back.playersById), JSON.stringify(before.playersById));
  expectEq('撤销新牌桌：历史恢复', back.actionHistory.length, before.actionHistory.length);
  expectEq('撤销新牌桌：引擎指纹恢复', engineSnapshot(back).fingerprint, engineSnapshot(before).fingerprint);
});

/* ============================================================
 * §8/§9 被拒绝的操作不得改动底池 / 筹码 / 版本 / 撤销栈
 * ============================================================ */

head('§8/§9 被拒绝的操作必须零副作用（底池 / 筹码 / revision / undo 栈）');
guard('§8/§9', () => {
  let state = fullTable(Position.CO, 100);
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  state = click(state, 'RAISE');
  const rejectedOps: TableOp[] = [
    { kind: 'SET_STACK', seatId: seatOfPosition(state, Position.BB)!.seatId, stackBB: 7 },
    { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, Position.SB)!.seatId },
    { kind: 'CLEAR_ALL_VILLAINS' },
    { kind: 'SET_TABLE_SIZE', tableSize: 9 },
    { kind: 'SET_HERO_POSITION', position: Position.BTN },
    { kind: 'REPLACE_PLAYER', seatId: seatOfPosition(state, Position.SB)!.seatId },
    { kind: 'CLEAR_HERO_CARDS' },
    { kind: 'SET_BOARD_CARD', card: '2d', slot: 2 },
    { kind: 'ACT', action: { type: 'CALL', amountChips: 1 } },
  ];
  const baseJson = JSON.stringify(state);
  const baseFp = engineSnapshot(state).fingerprint;
  const basePot = potBB(state);
  for (const op of rejectedOps) {
    const result = applyTableOp(state, op);
    if (result.ok) {
      hit(`本应被拒绝的 ${op.kind} 被接受了`);
      continue;
    }
    const nowJson = JSON.stringify(state);
    const nowFp = engineSnapshot(state).fingerprint;
    if (nowJson !== baseJson || nowFp !== baseFp || potBB(state) !== basePot) {
      fail(`${op.kind} 被拒绝却改动了状态`);
    } else {
      ok(`${op.kind.padEnd(20)} 被拒绝（${result.issues[0]!.code}），状态逐字节不变，底池=${basePot}BB`);
    }
    if (result.issues[0]!.code === 'ILLEGAL_ACTION') info(`      引擎拒绝理由：${result.issues[0]!.message.slice(0, 120)}`);
  }
  // 被拒绝后撤销栈与版本号不变
  const beforeUndo = state.undo.length;
  const beforeRev = state.revision;
  applyTableOp(state, { kind: 'SET_STACK', seatId: seatOfPosition(state, Position.BB)!.seatId, stackBB: 7 });
  expectEq('被拒绝后 undo 深度不变', state.undo.length, beforeUndo);
  expectEq('被拒绝后 revision 不变', state.revision, beforeRev);
});

head('§9b 一次成功行动后的撤销必须精确恢复筹码（含 6 位小数往返）');
guard('§9b', () => {
  let state = fullTable(Position.CO, 37); // 非整百，专挑换算边界
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  const before = engineSnapshot(state);
  const acted = click(state, 'ALL_IN');
  const afterAct = engineSnapshot(acted);
  info(`全下后：底池 ${before.potChips} → ${afterAct.potChips}`);
  const back = must(applyTableOp(acted, { kind: 'UNDO' }));
  const afterUndo = engineSnapshot(back);
  expectEq('撤销后底池精确恢复', afterUndo.potChips, before.potChips);
  expectEq('撤销后指纹精确恢复', afterUndo.fingerprint, before.fingerprint);
  expectEq('撤销后座位筹码恢复', JSON.stringify(back.seats.map((s) => s.stackBB)), JSON.stringify(state.seats.map((s) => s.stackBB)));
});

/* ============================================================
 * §15 NEW_TABLE 清理
 * ============================================================ */

head('§15 NEW_TABLE 必须清干净（画像 / 动态 / 玩家 / 历史 / 公共牌 / 手牌）');
guard('§15', () => {
  let state = fullTable(Position.CO);
  for (const position of ORDER_6) {
    if (position === Position.CO) continue;
    state = run(state, [
      { kind: 'SET_PROFILE', seatId: seatOfPosition(state, position)!.seatId, quickProfile: 'MANIAC' },
      { kind: 'SET_DYNAMIC_HINT', seatId: seatOfPosition(state, position)!.seatId, dynamicHint: 'TILT_SIGNAL' },
    ]);
  }
  state = must(applyTableOp(state, { kind: 'SET_STACK', seatId: seatOfPosition(state, Position.CO)!.seatId, stackBB: 250 }));
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
    { kind: 'ACT', action: { type: 'FOLD' } },
  ]);
  const beforeHeroStack = seatOfPosition(state, Position.CO)!.stackBB;
  const fresh = must(applyTableOp(state, { kind: 'NEW_TABLE' }));
  expectEq('playersById 只剩 Hero', Object.keys(fresh.playersById).length, 1);
  expectEq('只剩 Hero 对象是 isHero', Object.values(fresh.playersById)[0]!.isHero, true);
  const nonHeroSeats = fresh.seats.filter((s) => s.logicalPosition !== Position.CO);
  expectEq('非 Hero 座位全部 EMPTY', nonHeroSeats.every((s) => s.status === SeatStatus.EMPTY && s.playerId === null), true);
  expectEq('actionHistory 清空', fresh.actionHistory.length, 0);
  expectEq('board 清空', fresh.board.length, 0);
  expectEq('heroCards 清空', fresh.heroCards.length, 0);
  expectEq('handActive=false', fresh.handActive, false);
  expectEq('nextPlayerNumber 复位', fresh.nextPlayerNumber, 2);
  expectEq('nextHand 的剩余筹码表清空', fresh.lastHandRemainingStacksBB, null);
  expectEq('Hero 画像保留', fresh.playersById[fresh.heroPlayerId]!.isHero, true);
  info(`Hero 筹码：新建前=${beforeHeroStack}BB，新建后=${seatOfPosition(fresh, Position.CO)!.stackBB}BB（默认 ${fresh.defaultStackBB}BB）`);
  if (seatOfPosition(fresh, Position.CO)!.stackBB !== beforeHeroStack) {
    hit(`NEW_TABLE 把 Hero 手改过的筹码 ${beforeHeroStack}BB 静默重置为 ${seatOfPosition(fresh, Position.CO)!.stackBB}BB（提示语却写着「Hero 设置保持不变」）`);
  }
  // 新建后再加人不得与 Hero 的 id 冲突
  const afterAdd = must(applyTableOp(fresh, { kind: 'ADD_PLAYER', seatId: seatOfPosition(fresh, Position.UTG)!.seatId }));
  const ids = Object.keys(afterAdd.playersById);
  expectEq('新建后加人 playerId 无重复', new Set(ids).size, ids.length);
  info(`新建后加人得到 ${JSON.stringify(ids)}`);
});

/* ============================================================
 * §10 setTableSize 6↔9
 * ============================================================ */

head('§10a SET_TABLE_SIZE 9→6（Hero 在 UTG1：位置在新桌型不存在）');
guard('§10a', () => {
  let state = fullTable(Position.UTG1, 100, 9);
  // 给每个座位不同的筹码与画像，便于追踪「谁被丢了、谁的筹码跑到 Hero 身上」
  for (const position of ORDER_9) {
    state = must(applyTableOp(state, { kind: 'SET_STACK', seatId: seatOfPosition(state, position)!.seatId, stackBB: 50 }));
  }
  const btnSeatBefore = seatOfPosition(state, Position.BTN)!;
  const btnPlayerBefore = btnSeatBefore.playerId!;
  state = must(applyTableOp(state, { kind: 'SET_STACK', seatId: btnSeatBefore.seatId, stackBB: 77 }));
  state = must(applyTableOp(state, { kind: 'SET_PROFILE', seatId: btnSeatBefore.seatId, quickProfile: 'MANIAC' }));
  state = must(applyTableOp(state, { kind: 'SET_STACK', seatId: seatOfPosition(state, Position.UTG1)!.seatId, stackBB: 123 }));
  const heroId = state.heroPlayerId;
  info(`切换前：Hero 位置=${state.heroPosition}，Hero 筹码=${seatOfPosition(state, Position.UTG1)!.stackBB}BB`);
  info(`切换前：BTN 上是 ${btnPlayerBefore}（画像 MANIAC，筹码 77BB）`);
  const playersBefore = Object.keys(state.playersById);

  const switched = must(applyTableOp(state, { kind: 'SET_TABLE_SIZE', tableSize: 6 }));
  const heroSeat = seatOfPosition(switched, switched.heroPosition)!;
  info(`切换后：heroPosition=${switched.heroPosition}，座位数=${switched.seats.length}`);
  info(`切换后：Hero 所在座位筹码=${heroSeat.stackBB}BB（切换前 Hero 是 123BB）`);
  info(`切换后 notices=${JSON.stringify(switched.notices)}`);
  const seatedNow = switched.seats.filter((s) => s.playerId !== null).map((s) => `${s.logicalPosition}:${s.playerId}`);
  info(`切换后仍占座的玩家：${JSON.stringify(seatedNow)}`);
  const dropped = playersBefore.filter((id) => !switched.seats.some((s) => s.playerId === id));
  info(`失去座位的 playerId：${JSON.stringify(dropped)}（对象仍在 playersById=${JSON.stringify(Object.keys(switched.playersById))}）`);
  if (heroSeat.stackBB === 123) {
    ok('Hero 筹码跟着人走（123BB 未被 BTN 上的 77BB 顶替）');
  } else {
    hit(`Hero 筹码变成了 ${heroSeat.stackBB}BB（切换前 123BB）—— 目标座位的筹码被当成了 Hero 的`);
  }
  if (dropped.includes(btnPlayerBefore)) {
    const mentioned = switched.notices.some((n) => n.includes(btnPlayerBefore) || n.includes(switched.heroPosition));
    if (mentioned) ok('notice 提到了被顶掉/被清空的座位');
    else hit(`BTN 上的 ${btnPlayerBefore} 被静默换掉（Hero 自动移到 BTN），notice 未提及`);
  }
  expectEq('新 heroPosition 存在座位', seatOfPosition(switched, switched.heroPosition) !== undefined, true);
  expectEq('每个座位都有 playerId 或 EMPTY', switched.seats.every((s) => (s.playerId === null) === (s.status === SeatStatus.EMPTY)), true);
  expectEq('视觉序号唯一', new Set(switched.seats.map((s) => s.visualIndex)).size, 6);
  const hid = switched.seats.filter((s) => s.playerId === heroId);
  expectEq('Hero 只占一个座位', hid.length, 1);
});

head('§10b SET_TABLE_SIZE 6→9（不得丢人 / 不得重复）');
guard('§10b', () => {
  let state = fullTable(Position.UTG, 100, 6);
  const before = state.seats.map((s) => `${s.logicalPosition}:${s.playerId}`).join(' ');
  state = must(applyTableOp(state, { kind: 'SET_PROFILE', seatId: seatOfPosition(state, Position.HJ)!.seatId, quickProfile: 'MANIAC' }));
  const wide = must(applyTableOp(state, { kind: 'SET_TABLE_SIZE', tableSize: 9 }));
  info(`6→9 前：${before}`);
  info(`6→9 后：${wide.seats.map((s) => `${s.logicalPosition}:${s.playerId ?? '空'}`).join(' ')}`);
  const keptPlayers = wide.seats.filter((s) => s.playerId !== null).map((s) => s.playerId!);
  expectEq('原有玩家一个不少', ORDER_6.every((p) => wide.seats.some((s) => s.logicalPosition === p && s.playerId !== null)), true);
  expectEq('无重复绑定', new Set(keptPlayers).size, keptPlayers.length);
  expectEq('画像随人保留', wide.playersById[wide.seats.find((s) => s.logicalPosition === Position.HJ)!.playerId!]!.quickProfile, 'MANIAC');
  const back = must(applyTableOp(wide, { kind: 'SET_TABLE_SIZE', tableSize: 6 }));
  expectEq('9→6 回来后仍 6 座', back.seats.length, 6);
  expectEq('9→6 回来后玩家还在', back.seats.filter((s) => s.playerId !== null).length, 6);
});

/* ============================================================
 * §11 setHeroPosition 目标座位有人
 * ============================================================ */

head('§11 SET_HERO_POSITION 到已被占用的座位（筹码必须跟着人走，且必须如实告知）');
guard('§11', () => {
  let state = fullTable(Position.CO, 100);
  const btn = seatOfPosition(state, Position.BTN)!;
  const btnPlayer = btn.playerId!;
  state = must(applyTableOp(state, { kind: 'SET_STACK', seatId: btn.seatId, stackBB: 33 }));
  state = must(applyTableOp(state, { kind: 'SET_STACK', seatId: seatOfPosition(state, Position.CO)!.seatId, stackBB: 210 }));
  state = must(applyTableOp(state, { kind: 'SET_PROFILE', seatId: btn.seatId, quickProfile: 'MANIAC' }));
  info(`换位前：Hero(CO) 筹码=${seatOfPosition(state, Position.CO)!.stackBB}BB；BTN=${btnPlayer}（MANIAC，${seatOfPosition(state, Position.BTN)!.stackBB}BB）`);

  const moved = must(applyTableOp(state, { kind: 'SET_HERO_POSITION', position: Position.BTN }));
  const heroNowSeat = seatOfPosition(moved, moved.heroPosition)!;
  info(`换位后：heroPosition=${moved.heroPosition}，Hero 筹码=${heroNowSeat.stackBB}BB`);
  info(`换位后：BTN 绑定=${String(heroNowSeat.playerId)}；CO 绑定=${String(seatOfPosition(moved, Position.CO)!.playerId)} 筹码=${seatOfPosition(moved, Position.CO)!.stackBB}BB`);
  info(`换位后 notices=${JSON.stringify(moved.notices)}`);
  if (heroNowSeat.stackBB === 210) {
    ok('Hero 的筹码跟着人走（210BB 未被目标座位上的 33BB 顶替）');
  } else {
    hit(`Hero 筹码被静默替换为 ${heroNowSeat.stackBB}BB（换位前 Hero 是 210BB）`);
  }
  const noticeMentionsEvicted = moved.notices.some((n) => n.includes(btnPlayer) || n.includes('解绑') || n.includes('原本'));
  if (noticeMentionsEvicted) ok('notice 如实说明了被顶掉的玩家');
  else hit('notice 没有提到目标座位上原本那位玩家被解绑');
  expectEq('被顶掉的玩家对象仍在 playersById', moved.playersById[btnPlayer] !== undefined, true);
  expectEq('被顶掉的玩家不再占座', moved.seats.some((s) => s.playerId === btnPlayer), false);
  expectEq('每个位置都有座位对象', new Set(moved.seats.map((s) => s.logicalPosition)).size, 6);
  expectEq('视觉序号唯一', new Set(moved.seats.map((s) => s.visualIndex)).size, 6);
  expectEq('Hero 只占一个座位', moved.seats.filter((s) => s.playerId === moved.heroPlayerId).length, 1);
});

/* ============================================================
 * §12 伪造/损坏状态：客户端能不能让引擎看到不同牌局
 * ============================================================ */

head('§12a 伪造状态：两个座位绑定同一个 playerId（修复后应被拒绝）');
guard('§12a', () => {
  const state = fullTable(Position.CO);
  const dup = Object.freeze({
    ...state,
    seats: Object.freeze(
      state.seats.map((s) =>
        s.logicalPosition === Position.SB ? Object.freeze({ ...s, playerId: seatOfPosition(state, Position.HJ)!.playerId }) : s,
      ),
    ),
  });
  const parsed = parseTableState(JSON.parse(JSON.stringify(dup)));
  info(`座位重复绑定同一 playerId 经 parseTableState → ok=${String(parsed.ok)}${parsed.ok ? '' : `（${parsed.issues.map((i) => i.message).join('；')}）`}`);
  if (parsed.ok) {
    hit('parseTableState 允许两个座位绑定同一个 playerId（未做唯一性检查）');
  } else {
    ok('重复绑定被拒绝');
  }
});

head('§12b 伪造状态：visualIndex 与 heroPosition 不一致（修复后 Hero 座位必须被拒）');
guard('§12b', () => {
  const state = fullTable(Position.CO);
  const rotated = Object.freeze({
    ...state,
    seats: Object.freeze(
      state.seats.map((s) => Object.freeze({ ...s, visualIndex: (s.visualIndex + 3) % 6 })),
    ),
  });
  const parsed = parseTableState(JSON.parse(JSON.stringify(rotated)));
  info(`整体 +3（含 Hero 座位）经 parseTableState → ok=${String(parsed.ok)}`);
  if (parsed.ok) hit('服务端接受 Hero 座位 visualIndex≠0 的状态');
  else ok('Hero 座位视觉序号不为 0 被拒绝');

  // 残余缺口：只交换两个**非 Hero** 座位的视觉序号
  const hjVisual = seatOfPosition(state, Position.HJ)!.visualIndex;
  const utgVisual = seatOfPosition(state, Position.UTG)!.visualIndex;
  const swapped = Object.freeze({
    ...state,
    seats: Object.freeze(
      state.seats.map((s) =>
        s.logicalPosition === Position.HJ
          ? Object.freeze({ ...s, visualIndex: utgVisual })
          : s.logicalPosition === Position.UTG
            ? Object.freeze({ ...s, visualIndex: hjVisual })
            : s,
      ),
    ),
  });
  const parsedSwapped = parseTableState(JSON.parse(JSON.stringify(swapped)));
  info(`只交换两个非 Hero 座位的 visualIndex → ok=${String(parsedSwapped.ok)}`);
  if (parsedSwapped.ok) {
    const preview = buildTablePreview(parsedSwapped.state);
    const utg = preview.seats.find((s) => s.logicalPosition === Position.UTG)!;
    const hj = preview.seats.find((s) => s.logicalPosition === Position.HJ)!;
    hit(
      `只校验 Hero 座位是不够的：交换非 Hero 座位视觉序号仍被接受 —— ` +
        `UTG 角度=${utg.angleDeg}°，HJ 角度=${hj.angleDeg}°（屏幕上两人互换了位置，位置标签仍是各自逻辑位置）`,
    );
  } else {
    ok('非 Hero 座位的视觉序号也被校验');
  }
});

head('§12c 服务器自己造出的状态能不能通过自己的校验器（tableSize + heroPosition 组合）');
guard('§12c', () => {
  const deps = mockDeps();
  const created = handleTableRequest({ tableSize: 6, heroPosition: 'UTG1' }, deps);
  expectEq('POST /api/table {tableSize:6, heroPosition:"UTG1"} 的 ok', created.ok, true);
  if (!created.ok) {
    info(`已被拒绝：${created.issues.map((i) => i.message).join('；')}`);
    return;
  }
  const st = created.state;
  info(`创建结果：heroPosition=${st.heroPosition} 座位数=${st.seats.length} 有人的座位=${st.seats.filter((s) => s.playerId !== null).length}`);
  info(`visualIndex 集合=${JSON.stringify(st.seats.map((s) => s.visualIndex))}`);
  info(`Hero 是否占座=${String(st.seats.some((s) => s.playerId === st.heroPlayerId))}`);
  const reparse = parseTableState(JSON.parse(JSON.stringify(st)));
  info(`把这个状态回传给 /api/table → parseTableState ok=${String(reparse.ok)}`);
  if (reparse.ok) ok('自产状态能通过自己的校验');
  else hit(`服务器自己创建的状态无法通过自己的校验器：${reparse.issues.map((i) => i.message).join('；')} —— 该牌桌此后每个操作都会被拒绝`);
  const follow = handleTableRequest({ state: JSON.parse(JSON.stringify(st)), op: { kind: 'ADD_PLAYER', seatId: 'seat_UTG' } }, deps);
  info(`后续 ADD_PLAYER → ok=${String(follow.ok)}；原因：${follow.ok ? '（无）' : follow.issues.map((i) => i.message).join('；').slice(0, 90)}`);
  const preview = buildTablePreview(st);
  info(`该状态的预览：canAnalyze=${String(preview.canAnalyze)} 阻塞=${JSON.stringify(preview.analyzeBlockers).slice(0, 160)}`);
});

head('§12d 伪造状态：跨字段自洽性（修复后应逐条被拒）');
guard('§12d', () => {
  const state = fullTable(Position.CO);
  const cases: readonly (readonly [string, unknown])[] = [
    ['handActive=false 但有行动历史', { ...state, actionHistory: [{ position: 'UTG', type: 'FOLD' }], handActive: false }],
    ['handActive=false 但已选满手牌', { ...state, heroCards: ['As', 'Kd'], handActive: false }],
    ['board 有 3 张但 handActive=false', { ...state, board: ['Kh', '7c', '2d'], handActive: false }],
    ['handActive=true 但一切皆空', { ...state, handActive: true }],
    ['lastHandComplete 缺失', (({ lastHandComplete: _x, ...rest }) => rest)(state)],
    ['notices 里有非字符串', { ...state, notices: [123] }],
    ['lastHandRemainingStacksBB 非法', { ...state, lastHandRemainingStacksBB: { MARS: 100 } }],
    ['heroCards 里是重复的牌', { ...state, heroCards: ['As', 'As'] }],
    ['heroCards 里是垃圾字符串', { ...state, heroCards: ['ZZ', 'As'] }],
    ['board 与 heroCards 重复', { ...state, heroCards: ['As', 'Kd'], board: ['As', '7c', '2d'] }],
    ['Hero 座位 visualIndex=1', { ...state, seats: state.seats.map((s) => (s.logicalPosition === Position.CO ? { ...s, visualIndex: 1 } : s)) }],
    ['sitOutNextHand 不是布尔', { ...state, seats: state.seats.map((s, i) => (i === 0 ? { ...s, sitOutNextHand: 'yes' } : s)) }],
  ];
  for (const [name, payload] of cases) {
    const parsed = parseTableState(payload);
    if (parsed.ok) hit(`parseTableState 接受「${name}」`);
    else info(`拒绝「${name}」：${parsed.issues[0]!.message.slice(0, 70)}`);
  }
});

/* ============================================================
 * §13 revision 单调性 / 不可变（no in-place mutation）
 * ============================================================ */

head('§13a revision 单调性与「无操作不推进版本」');
guard('§13a', () => {
  let state = fullTable(Position.CO);
  const checkpoints: string[] = [];
  const ops: TableOp[] = [
    { kind: 'SET_TABLE_SIZE', tableSize: 6 },
    { kind: 'SET_HERO_POSITION', position: Position.CO },
    { kind: 'SET_ENVIRONMENT', environment: 'MID_LOW_STAKES' },
    { kind: 'SET_PROFILE', seatId: seatOfPosition(state, Position.HJ)!.seatId, quickProfile: 'TIGHT' },
    { kind: 'CLEAR_SEAT', seatId: seatOfPosition(state, Position.HJ)!.seatId, activeHandChoice: ActiveHandLeaveChoice.CANCEL },
    { kind: 'SET_STACK', seatId: seatOfPosition(state, Position.HJ)!.seatId, stackBB: 55 },
    { kind: 'UNDO' },
    { kind: 'NEXT_HAND' },
    { kind: 'NEW_TABLE' },
    { kind: 'UNDO' },
  ];
  let prevRev = state.revision;
  for (const op of ops) {
    const result = applyTableOp(state, op);
    if (!result.ok) {
      expectEq(`${op.kind} 被拒绝后 revision 不变`, state.revision, prevRev);
      continue;
    }
    const delta = result.state.revision - state.revision;
    const noop =
      JSON.stringify({ ...result.state, undo: [], revision: 0 }) ===
      JSON.stringify({ ...state, undo: [], revision: 0 });
    checkpoints.push(`${op.kind}:Δrev=${delta}${noop ? '（状态等价）' : ''}`);
    if (delta !== 1 && delta !== 0) fail(`${op.kind} 的 revision 增量=${delta}（期望 0 或 1）`);
    if (noop && delta !== 0) hit(`${op.kind} 是空操作却推进了 revision（Δ=${delta}）并占用一次撤销`);
    if (!noop && delta !== 1) fail(`${op.kind} 改变了状态但 revision 增量=${delta}`);
    state = result.state;
    prevRev = state.revision;
  }
  info(checkpoints.join(' | '));
  ok('所有成功路径 revision 单调（改动 +1，空操作 0）');
});

head('§13b 任何操作都不得原地修改传入状态（immutability）');
guard('§13b', () => {
  let state = fullTable(Position.CO);
  const allOps: TableOp[] = [
    { kind: 'ADD_PLAYER', seatId: 'seat_UTG' },
    { kind: 'SET_PROFILE', seatId: seatOfPosition(state, Position.UTG)!.seatId, quickProfile: 'LOOSE' },
    { kind: 'SET_DYNAMIC_HINT', seatId: seatOfPosition(state, Position.UTG)!.seatId, dynamicHint: 'TILT_SIGNAL' },
    { kind: 'SET_STACK', seatId: seatOfPosition(state, Position.UTG)!.seatId, stackBB: 88 },
    { kind: 'SIT_OUT', seatId: seatOfPosition(state, Position.UTG)!.seatId },
    { kind: 'SIT_IN', seatId: seatOfPosition(state, Position.UTG)!.seatId },
    { kind: 'REPLACE_PLAYER', seatId: seatOfPosition(state, Position.UTG)!.seatId },
    { kind: 'CLEAR_SEAT', seatId: seatOfPosition(state, Position.UTG)!.seatId },
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
    { kind: 'ACT', action: { type: 'FOLD' } },
    { kind: 'SET_BOARD_CARD', card: 'Kh', slot: 0 },
    { kind: 'CLEAR_BOARD' },
    { kind: 'NEXT_HAND' },
    { kind: 'RESET_HAND' },
    { kind: 'CLEAR_ALL_VILLAINS' },
    { kind: 'NEW_TABLE' },
    { kind: 'UNDO' },
  ];
  let mutated = 0;
  for (const op of allOps) {
    const before = JSON.stringify(state);
    const result = applyTableOp(state, op);
    if (JSON.stringify(state) !== before) {
      mutated += 1;
      fail(`${op.kind} 原地修改了传入状态`);
    }
    if (result.ok) state = result.state;
  }
  expectEq('原地修改次数', mutated, 0);
});

/* ============================================================
 * §14 跨手泄漏
 * ============================================================ */

head('§14 跨手泄漏：上一手的什么东西会活到下一手');
guard('§14', () => {
  let state = fullTable(Position.CO);
  state = must(applyTableOp(state, { kind: 'SET_PROFILE', seatId: seatOfPosition(state, Position.HJ)!.seatId, quickProfile: 'MANIAC' }));
  state = run(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
    { kind: 'ACT', action: { type: 'FOLD' } },
  ]);
  const next = must(applyTableOp(state, { kind: 'NEXT_HAND' }));
  const leftovers: string[] = [];
  if (next.heroCards.length > 0) leftovers.push('heroCards');
  if (next.board.length > 0) leftovers.push('board');
  if (next.actionHistory.length > 0) leftovers.push('actionHistory');
  if (next.handActive) leftovers.push('handActive');
  if (next.lastHandRemainingStacksBB !== null) leftovers.push('lastHandRemainingStacksBB');
  expectEq('下一手残留字段', leftovers, ['lastHandRemainingStacksBB']);
  info(`下一手的承诺与实际：lastHandComplete=${String(next.lastHandComplete)}`);
  const handsPlayed = Object.values(next.playersById).map((p) => p.handsPlayed);
  info(`handsPlayed（含已离桌的玩家对象）：${JSON.stringify(handsPlayed)}`);
  // 弃牌/全下状态必须清掉
  expectEq('弃牌状态已清（所有人 SEATED_ACTIVE）', next.seats.filter((s) => s.playerId !== null).every((s) => s.status === SeatStatus.SEATED_ACTIVE), true);
  // 画像必须保留（这是「跨手」想要的）
  expectEq('画像跨手保留（Seat ≠ Player）', next.playersById[seatOfPosition(next, Position.HJ)!.playerId!]!.quickProfile, 'MANIAC');

  // NEXT_HAND 在未开始的一手上调用会怎样？
  const empty = createTable({ tableSize: 6, heroPosition: Position.CO });
  const emptyNext = applyTableOp(empty, { kind: 'NEXT_HAND' });
  if (emptyNext.ok) {
    info(`空牌桌直接点「下一手」：handsPlayed=${JSON.stringify(Object.values(emptyNext.state.playersById).map((p) => p.handsPlayed))} lastHandComplete=${String(emptyNext.state.lastHandComplete)} notices=${JSON.stringify(emptyNext.state.notices)}`);
    if (Object.values(emptyNext.state.playersById).some((p) => p.handsPlayed > 0)) {
      hit('未开始的一手也能通过 NEXT_HAND 把 handsPlayed +1（计数含义失真）');
    }
  }
});

/* ============================================================
 * §16 汇总
 * ============================================================ */

head('§16 探针汇总');
line(`HIT（发现可疑行为）= ${HITS}`);
line(`FAIL（不变量被破坏）= ${FAILS}`);

const evidencePath = fileURLToPath(new URL('./rt-table-lifecycle-evidence.txt', import.meta.url));
writeFileSync(evidencePath, OUT.join('\r\n') + '\r\n', 'utf8');
console.log(`\n证据已写入：${evidencePath}`);
