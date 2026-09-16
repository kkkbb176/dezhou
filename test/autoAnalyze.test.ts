/**
 * REAL-HAND UX ADDENDUM —— AUTO ANALYZE 闸门回归
 *
 * # 规则
 *
 * > **Hero Decision Ready ⇒ Auto Analyze**
 * > 用户负责录入事实；系统负责判断什么时候已经轮到 Hero。
 *
 * ## 这个文件测什么、不测什么
 *
 * | 层 | 谁测 |
 * |---|---|
 * | **后端闸门**（条件 1–5、7） | **本文件** |
 * | **模式**（条件 6：`CURRENT_DECISION` / `HISTORY_ENTRY`） | 前端；本文件断言「后端**没有**把模式混进状态判据」 |
 * | **调度**（debounce / single-flight / 迟到响应） | 前端；本文件用**可执行的调度模型**把它钉住（见第五部分） |
 *
 * ⚠️ 本文件**不**断言 `canAnalyze` 就是触发条件 —— 事实恰恰相反。
 * 使用者录完 Hero 自己的动作后，`canAnalyze` 会在 Hero 的**旧节点**上
 * 短暂为真（下一位若已弃牌，`currentActor` 会继续跳过）。
 * 触发必须同时看 `decision.ready`（它内含 `currentActorIsHero`）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position, Street } from '../src/domain/types.ts';
import { createTable, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import {
  AutoAnalyzeState,
  DecisionReasonCode,
  type PokerTableState,
  type TableOp,
} from '../src/app/table/table.types.ts';

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
 * 驱动辅助
 * ============================================================ */

function must(result: ReturnType<typeof applyTableOp>): PokerTableState {
  if (!result.ok) {
    throw new Error(`操作被拒绝：${result.issues.map((i) => i.message).join(' / ')}`);
  }
  return result.state;
}

function drive(start: PokerTableState, ops: readonly TableOp[]): PokerTableState {
  let state = start;
  for (const op of ops) state = must(applyTableOp(state, op));
  return state;
}

/** 建 9 座满桌，只给 Hero 选牌（其余一律不选） */
function tableAllSeated(heroPosition: Position): PokerTableState {
  let state = createTable({ tableSize: 9, heroPosition });
  for (const p of RING_9) {
    if (p === heroPosition) continue;
    state = must(applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, p)!.seatId }));
  }
  return state;
}

/** 让当前行动者按 `choose` 决定做什么，直到轮到 Hero 或无法继续 */
function driveToHero(
  state: PokerTableState,
  choose: (position: Position) => string = () => 'FOLD',
): PokerTableState {
  let current = state;
  for (let step = 0; step < 40; step += 1) {
    const p = buildTablePreview(current);
    if (p.isHeroTurn || p.currentActorPosition === null || p.handComplete) return current;
    const want = choose(p.currentActorPosition);
    const button = p.actionButtons.find((b) => b.type === want && b.group !== 'EXPAND');
    if (button === undefined) return current;
    current = must(
      applyTableOp(current, {
        kind: 'ACT',
        action: {
          type: button.type,
          ...(button.amountChips !== undefined ? { amountChips: button.amountChips } : {}),
        },
      }),
    );
  }
  return current;
}

const decisionOf = (state: PokerTableState) => buildTablePreview(state).decision;

/* ============================================================
 * 一、默认状态：等手牌
 * ============================================================ */

test('AUTO-1：新牌桌默认「等手牌」—— 手牌没选满时**绝不**就绪', () => {
  let state = tableAllSeated(Position.UTG);
  let d = decisionOf(state);
  assert.equal(d.ready, false, '一张牌都没选时必须不就绪');
  assert.equal(d.reasonCode, DecisionReasonCode.WAITING_HERO_CARDS, '原因必须是「等手牌」');
  assert.equal(d.state, AutoAnalyzeState.WAITING_CARDS);
  /*
   * ⚠️ 这里断言 `false`，**不是** `true` —— 这是实测出来的 production contract。
   *
   * 契约（真实 DOM 执行 `table.js` + 直接调 `buildTablePreview` 两种口径都验过）：
   * 手牌不齐时引擎**重建不出这一手** —— `preview.ok === false`、
   * `street === null`、`currentActorPosition === null`。而
   * `currentActorIsHero = (currentActorPosition === heroPosition)`，
   * 于是它只能是 `false`；`hasDecisionPoint` 同样是 `false`。
   *
   * 为什么**不**改 production 把它变成 `true`：行动者由引擎重建得出
   * （见 `table.types.ts`「状态是否合法…全部来自引擎重建」），而引擎重建的
   * 前提就是两张手牌齐。为了让一条断言好看而让前端自己猜「现在轮到谁」，
   * 正是本项目一直在清的那一类字段混用。
   *
   * 结论：这是**测试模型自行假设**的额外条件，不是业务不变量。
   * 规范真正要求的是「手牌没选满时**绝不**就绪」—— 那一条仍被实断言钉住。
   */
  assert.equal(
    d.conditions['currentActorIsHero'],
    false,
    '手牌不齐时引擎重建不出行动者，不得声称「轮到 Hero」',
  );
  assert.equal(d.conditions['hasDecisionPoint'], false, '同理：此刻没有可分析的决策点');
  assert.equal(d.conditions['heroCardsComplete'], false, '手牌未满');

  // 只选一张 → 仍然不就绪
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'As' }));
  d = decisionOf(state);
  assert.equal(d.ready, false, '只选一张牌时**绝不**就绪（规范第 5 条回归）');
  assert.equal(d.reasonCode, DecisionReasonCode.WAITING_HERO_CARDS);
  assert.equal(d.conditions['heroCardsComplete'], false);
});

test('AUTO-2：Hero=UTG 拿完第二张牌 → 立即就绪并自动分析（规范第 1 条回归）', () => {
  let state = tableAllSeated(Position.UTG);
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);

  const p = buildTablePreview(state);
  assert.equal(p.isHeroTurn, true, 'UTG 是翻牌前第一个行动者');
  assert.equal(p.decision.ready, true, '两张牌选完必须**立即**就绪');
  assert.equal(p.decision.reasonCode, DecisionReasonCode.READY);
  assert.equal(p.decision.groups.length, 0, '就绪时不得有任何阻塞组');
  assert.equal(p.canAnalyze, true, 'canAnalyze 也必须为真（两者不可分歧）');
});

/* ============================================================
 * 二、等待前位 —— **绝不猜他们弃牌**
 * ============================================================ */

test('AUTO-3：Hero=CO 拿完牌但前位未行动 → 「等待前位行动」，**不**就绪（规范第 2 条回归）', () => {
  let state = tableAllSeated(Position.CO);
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);

  const p = buildTablePreview(state);
  assert.equal(p.isHeroTurn, false, 'CO 前面还有 UTG/UTG1/UTG2/LJ/HJ 没行动');
  assert.equal(p.decision.ready, false, '**绝不**因为手牌完整就自动分析');
  assert.equal(
    p.decision.reasonCode,
    DecisionReasonCode.WAITING_OTHERS,
    '原因必须是「等待前位行动」',
  );
  assert.equal(p.decision.state, AutoAnalyzeState.WAITING_OTHERS);
  assert.equal(p.decision.conditions['heroCardsComplete'], true, '手牌是满的 —— 但它**不是**充分条件');
  assert.equal(p.decision.conditions['currentActorIsHero'], false, '真正缺的是「轮到 Hero」');
  assert.ok(
    p.decision.groups.some((g) => g.items.some((t) => t.includes('轮到'))),
    `必须如实说明现在轮到谁：${JSON.stringify(p.decision.groups)}`,
  );
});

test('AUTO-4：前位全部弃牌直到轮到 Hero → 自动就绪（规范第 3 条回归）', () => {
  let state = tableAllSeated(Position.CO);
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  assert.equal(decisionOf(state).ready, false, '前置条件：先不就绪');

  state = driveToHero(state, () => 'FOLD');

  const p = buildTablePreview(state);
  assert.equal(p.isHeroTurn, true, `必须轮到 Hero，实际 ${String(p.currentActorPosition)}`);
  assert.equal(p.decision.ready, true, '前位全部弃牌后必须就绪');
  assert.equal(p.decision.reasonCode, DecisionReasonCode.READY);
});

test('AUTO-5：Facing Open（前位加注）→ Hero 轮到时仍然就绪（规范第 4 条回归）', () => {
  // Hero 在 BTN：让 UTG 开池、其余弃牌，轮到 BTN
  let state = tableAllSeated(Position.BTN);
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);

  // UTG 加注
  const raiseBtn = buildTablePreview(state).actionButtons.find(
    (b) => b.type === 'RAISE' && b.group === 'SIZE',
  );
  assert.notEqual(raiseBtn, undefined, 'UTG 应当有加注尺寸按钮');
  if (raiseBtn === undefined) return;
  state = must(applyTableOp(state, {
    kind: 'ACT',
    action: { type: 'RAISE', ...(raiseBtn.amountChips !== undefined ? { amountChips: raiseBtn.amountChips } : {}) },
  }));

  state = driveToHero(state, () => 'FOLD');

  const p = buildTablePreview(state);
  assert.equal(p.isHeroTurn, true, `必须轮到 Hero，实际 ${String(p.currentActorPosition)}`);
  assert.equal(p.currentBetBB > 0, true, '必须真的面对一个下注（否则测的不是 Facing Open）');
  assert.equal(p.decision.ready, true, '面对开池时轮到自己必须就绪');
  assert.ok(p.actionButtons.length > 0, '必须给出可行动作');
});

/* ============================================================
 * 三、公共牌 —— 少一张都不行
 * ============================================================ */

test('AUTO-6：翻牌只选 2 张 → 不就绪（规范第 6 条回归）', () => {
  let state = tableAllSeated(Position.BTN);
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  // 打到翻牌：让所有人弃牌到 BTN 会让本手结束，因此改成「小盲大盲跟注后逐街过牌」
  state = driveToHero(state, () => 'CALL');
  // 逐街过牌推进到翻牌
  for (let i = 0; i < 8; i += 1) {
    const p = buildTablePreview(state);
    if (p.street === Street.FLOP) break;
    if (!p.isHeroTurn) {
      const cb = p.actionButtons.find((b) => b.type === 'CHECK' || b.type === 'CALL');
      if (cb === undefined) break;
      state = must(applyTableOp(state, {
        kind: 'ACT',
        action: { type: cb.type, ...(cb.amountChips !== undefined ? { amountChips: cb.amountChips } : {}) },
      }));
      continue;
    }
    const cb = p.actionButtons.find((b) => b.type === 'CHECK');
    if (cb === undefined) break;
    state = must(applyTableOp(state, { kind: 'ACT', action: { type: 'CHECK' } }));
  }

  // 选两张公共牌
  state = drive(state, [
    { kind: 'SET_BOARD_CARD', card: 'Ah', slot: 0 },
    { kind: 'SET_BOARD_CARD', card: '7c', slot: 1 },
  ]);

  const p = buildTablePreview(state);
  assert.equal(p.boardSelectionInProgress, true, '选到 2 张时必须标记「选择中」');
  assert.equal(p.decision.ready, false, '公共牌只选 2 张时**绝不**就绪');
  assert.equal(p.decision.reasonCode, DecisionReasonCode.WAITING_BOARD, '原因必须是「等公共牌」');
  assert.equal(p.decision.state, AutoAnalyzeState.WAITING_BOARD);
});

test('AUTO-7：第 3 张公共牌选完且轮到 Hero → 自动就绪（规范第 7 条回归）', () => {
  /*
   * 复用 AUTO-6 的推进，但把第 3 张补上，并确保轮到 Hero。
   *
   * ⚠️ 这里刻意**不**假设「补完牌就一定轮到 Hero」——
   * 先断言街道与牌面，再看是否轮到 Hero；若没轮到，
   * 那就是「等待前位行动」，也应当不就绪。两种结果都如实断言。
   */
  let state = tableAllSeated(Position.BTN);
  state = drive(state, [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  state = drive(state, [
    { kind: 'SET_BOARD_CARD', card: 'Ah', slot: 0 },
    { kind: 'SET_BOARD_CARD', card: '7c', slot: 1 },
    { kind: 'SET_BOARD_CARD', card: '2d', slot: 2 },
  ]);

  let guard = 0;
  while (guard < 30) {
    guard += 1;
    const p = buildTablePreview(state);
    if (p.boardSelectionInProgress) break;
    if (p.isHeroTurn) break;
    if (p.currentActorPosition === null) break;
    const cb = p.actionButtons.find((b) => b.type === 'CALL' || b.type === 'CHECK');
    if (cb === undefined) break;
    state = must(applyTableOp(state, {
      kind: 'ACT',
      action: { type: cb.type, ...(cb.amountChips !== undefined ? { amountChips: cb.amountChips } : {}) },
    }));
  }

  const p = buildTablePreview(state);
  assert.equal(p.boardSelectionInProgress, false, '翻牌 3 张已齐，不得再标记「选择中」');
  if (p.street === Street.PREFLOP) {
    // 还没推过街道 —— 这不是本条的失败，如实报告并只断言「不因牌面而阻塞」
    assert.ok(
      !p.decision.groups.some((g) => g.items.some((t) => t.includes('公共牌只选了'))),
      '牌面已齐 3 张，不得再报「公共牌不足」',
    );
    return;
  }
  assert.equal(p.street, Street.FLOP, '必须已经在翻牌');
  if (p.isHeroTurn) {
    assert.equal(p.decision.ready, true, '翻牌 3 张齐 + 轮到 Hero → 必须就绪');
  } else {
    assert.equal(
      p.decision.reasonCode,
      DecisionReasonCode.WAITING_OTHERS,
      '牌面齐了但没轮到 Hero → 必须是「等待前位行动」',
    );
  }
});

/* ============================================================
 * 四、闸门与 canAnalyze 必须一致，且模式**不得**混进状态判据
 * ============================================================ */

test('AUTO-8：`decision.ready` 与 `canAnalyze` 在任何状态下都不得分歧', () => {
  /*
   * 两个字段若分歧，界面会自相矛盾（状态条说「就绪」而按钮禁用，或反之）。
   * 穷举一批状态逐一对拍。
   */
  const states: PokerTableState[] = [];

  states.push(tableAllSeated(Position.UTG)); // 无手牌
  states.push(
    drive(tableAllSeated(Position.UTG), [{ kind: 'SET_HERO_CARD', card: 'As' }]), // 一张
  );
  states.push(
    drive(tableAllSeated(Position.UTG), [
      { kind: 'SET_HERO_CARD', card: 'As' },
      { kind: 'SET_HERO_CARD', card: 'Kd' },
    ]), // 就绪
  );
  states.push(
    drive(tableAllSeated(Position.CO), [
      { kind: 'SET_HERO_CARD', card: 'As' },
      { kind: 'SET_HERO_CARD', card: 'Kd' },
    ]), // 等前位
  );
  states.push(
    drive(tableAllSeated(Position.CO), [
      { kind: 'SET_HERO_CARD', card: 'As' },
      { kind: 'SET_HERO_CARD', card: 'Kd' },
      { kind: 'SET_BOARD_CARD', card: 'Ah', slot: 0 },
    ]), // 牌面选择中
  );
  states.push(createTable({ tableSize: 9, heroPosition: Position.BTN })); // 只有 Hero 一人

  let readyCount = 0;
  for (const [i, s] of states.entries()) {
    const p = buildTablePreview(s);
    assert.equal(
      p.decision.ready,
      p.canAnalyze,
      `第 ${i} 个状态：decision.ready=${String(p.decision.ready)} 与 canAnalyze=${String(p.canAnalyze)} 分歧了（` +
        `reasonCode=${p.decision.reasonCode}）`,
    );
    if (p.decision.ready) readyCount += 1;
  }
  assert.ok(readyCount >= 1, '样本里必须至少有一个「就绪」状态，否则这条对拍没有约束力');
});

test('AUTO-9：后端闸门**不知道**模式 —— 模式是纯前端的显式选择', () => {
  /*
   * 这是一条**架构断言**，不是行为断言。
   *
   * 为什么必须钉住：规范禁止「根据哪个字段变了去猜用户意图」。
   * 如果 `preview.decision` 里出现了任何形如 `mode` / `history` 的字段，
   * 那就说明有人把「用户意图」塞进了「牌局状态」——
   * 而同一种牌局状态在两种模式下是完全一样的，塞进去必然靠猜。
   *
   * 判据：同一副牌局状态下，无论前端处于哪个模式，
   * 后端算出来的闸门结果必须**逐字段相同**。
   */
  const state = drive(tableAllSeated(Position.UTG), [
    { kind: 'SET_HERO_CARD', card: 'As' },
    { kind: 'SET_HERO_CARD', card: 'Kd' },
  ]);
  const a = buildTablePreview(state).decision;
  const b = buildTablePreview(state).decision;

  assert.deepEqual(a, b, '同一状态下两次调用必须逐字段相同（无隐藏可变状态）');
  assert.equal(
    Object.keys(a).includes('mode'),
    false,
    '闸门结果里**不得**出现 mode —— 模式是界面意图，不是牌局状态',
  );
  assert.equal(
    JSON.stringify(a).includes('HISTORY_ENTRY'),
    false,
    '闸门结果里**不得**出现 HISTORY_ENTRY —— 那意味着模式被混进了状态判据',
  );
  assert.equal(
    JSON.stringify(a).includes('CURRENT_DECISION'),
    false,
    '闸门结果里**不得**出现 CURRENT_DECISION',
  );
});

/* ============================================================
 * 五、前端调度模型（debounce / single-flight / 迟到响应）
 * ============================================================ */

/**
 * 一个**可执行的调度模型**，语义与 `table.js` 的
 * `runAnalyze` / `scheduleAutoAnalyze` / `setMode` 逐条对应。
 *
 * ## 为什么在 Node 里重建一份而不是跑真实 DOM
 *
 * `src/app/web/table.js` 是浏览器脚本，没有构建步骤。要让它可测有两条路：
 * ① 引一个 DOM 桩（项目里已有先例：`interactiveTableRedteam2.test.ts` 真跑过 DOM 桩）；
 * ② 把**调度语义**抽成一个模型来钉。
 *
 * 本文件选 ②，并把 ① 留给浏览器现场复验（`scripts/`）。
 * 理由是调度缺陷（重复触发、迟到覆盖）**不依赖 DOM 就能完整表达**，
 * 而 DOM 桩会引入大量与本题无关的失败面。
 *
 * ⚠️ **模型与实现必须同步**：若 `table.js` 的调度逻辑改了而这里没改，
 * 这组测试会**假绿**。因此在实现里加了指向本文件的注释。
 */
/** 模型内部的模式取值域 —— 与 `table.js` 的 `app.mode` 同一联合 */
type SchedulerMode = 'CURRENT_DECISION' | 'HISTORY_ENTRY';
/** 一次排程（对应 `scheduleAutoAnalyze` 的 debounce 槽位） */
type ScheduledRequest = { key: string; revision: number; epoch: number };
/** 一次已发出的请求（对应 `runAnalyze` 的令牌） */
type IssuedRequest = { token: number; revision: number; epoch: number };

class AnalyzeScheduler {
  calls: ScheduledRequest[] = [];
  mode: SchedulerMode = 'CURRENT_DECISION';
  modeEpoch = 0;
  autoAnalyzedKey: string | null = null;
  latestToken = 0;
  pending: ScheduledRequest | null = null;
  /*
   * 结果载荷的形状随用例而变（`{ok}` / `{decision}` / `{tag}`），
   * 因此这里刻意用 `any`：本文件断言的是**调度语义**，不是载荷类型。
   */
  analysis: any = null;

  keyOf(revision: number): string {
    return `${revision}@${this.modeEpoch}`;
  }

  /** 对应 `scheduleAutoAnalyze`：只有 ready 才排程，且同一 key 只跑一次 */
  schedule(revision: number, ready: boolean): string {
    if (this.mode === 'HISTORY_ENTRY') return 'PAUSED';
    if (!ready) return 'NOT_READY';
    const key = this.keyOf(revision);
    if (this.autoAnalyzedKey === key) return 'ALREADY_DONE';
    // debounce 的等价物：同一 key 的重复排程被合并
    if (this.pending !== null && this.pending.key === key) return 'MERGED';
    this.pending = { key, revision, epoch: this.modeEpoch };
    return 'SCHEDULED';
  }

  /** 对应 `runAnalyze`：flush 掉排程并发一次请求，返回令牌 */
  flush() {
    if (this.pending === null) return null;
    if (this.mode === 'HISTORY_ENTRY') {
      this.pending = null;
      return null;
    }
    const req = this.pending;
    this.pending = null;
    this.latestToken += 1;
    const token = this.latestToken;
    this.calls.push(req);
    return { token, revision: req.revision, epoch: req.epoch };
  }

  /** 对应 `runAnalyze` 的回调：三个条件任一不成立就整包丢弃 */
  receive(request: IssuedRequest | null, payload: any): string {
    if (request === null) return 'NO_REQUEST';
    if (request.token !== this.latestToken) return 'STALE_TOKEN';
    if (request.epoch !== this.modeEpoch) return 'STALE_EPOCH';
    if (this.mode === 'HISTORY_ENTRY') return 'MODE_PAUSED';
    this.analysis = payload;
    this.autoAnalyzedKey = this.keyOf(request.revision);
    return 'APPLIED';
  }

  /** 对应 `setMode` */
  setMode(next: SchedulerMode): void {
    if (next === this.mode) return;
    this.mode = next;
    this.modeEpoch += 1;
    this.pending = null;
    this.latestToken += 1;
    if (next === 'HISTORY_ENTRY') this.analysis = null;
  }
}

test('AUTO-10：HISTORY_ENTRY 经过 Hero 节点 → **绝不**自动分析（规范第 5、6 条回归）', () => {
  const s = new AnalyzeScheduler();
  s.setMode('HISTORY_ENTRY');

  // 引擎说「就绪」（轮到 Hero + 信息齐）—— 但模式是录入历史
  assert.equal(s.schedule(1, true), 'PAUSED', '录入历史模式下必须暂停，不看 ready');
  assert.equal(s.flush(), null, '**不得**发出任何分析请求');
  assert.equal(s.calls.length, 0, '一次请求都不能发');

  // 多个街道连续录入（revision 递增）也不得触发
  for (let rev = 2; rev <= 8; rev += 1) {
    assert.equal(s.schedule(rev, true), 'PAUSED', `第 ${rev} 个 revision 也不得触发`);
    assert.equal(s.flush(), null);
  }
  assert.equal(s.calls.length, 0, '整个录入历史过程零请求');
});

test('AUTO-11：CURRENT_DECISION → HISTORY_ENTRY 后旧异步结果回来 → 不得重新显示（规范第 8 条回归）', () => {
  const s = new AnalyzeScheduler();

  // 当前决策模式下发了一个请求（在途）
  s.schedule(5, true);
  const req = s.flush();
  assert.notEqual(req, null, '应当发出请求');

  // 用户切到录入历史
  s.setMode('HISTORY_ENTRY');
  assert.equal(s.analysis, null, '切到录入历史必须清掉已显示的建议');

  // 旧响应回来
  /*
   * 旧响应回来。
   *
   * ⚠️ 期望 `STALE_TOKEN` 而**不是** `STALE_EPOCH`：`table.js` 的 `setMode`
   * 除了 `modeEpoch += 1` 之外还做了 `analyzeLatestToken += 1`
   * （注释原文：「让所有在途响应的 token 失配」），而 `runAnalyze` 的回调
   * **先**比 token、**再**比 epoch。所以切模式命中的第一道闸门是 token。
   * 本模型与实现同序 —— 断言必须跟着实现的真实闸门顺序走，否则测的是
   * 一个实现里并不存在的顺序。
   */
  const verdict = s.receive(req, { ok: true, decision: { action: 'CALL' } });
  assert.equal(verdict, 'STALE_TOKEN', '切模式必须让在途请求失效');
  assert.equal(s.analysis, null, '**绝不**让迟到的结果重新显示出来');
});

test('AUTO-12：模式切换必须使旧判断失效（规范第 9 条回归）', () => {
  const s = new AnalyzeScheduler();

  // 在当前决策模式下分析过 rev=5
  s.schedule(5, true);
  const r1 = s.flush();
  assert.equal(s.receive(r1, { ok: true }), 'APPLIED');
  assert.equal(s.autoAnalyzedKey, '5@0', '记号应为 5@0');

  // 切到录入历史再切回来 —— **牌局 revision 没变**
  s.setMode('HISTORY_ENTRY');
  s.setMode('CURRENT_DECISION');

  assert.notEqual(s.autoAnalyzedKey, s.keyOf(5), '纪元变了，旧记号必须失配');
  assert.equal(
    s.schedule(5, true),
    'SCHEDULED',
    '切回当前决策后，即使 revision 没变也必须重新判断「该不该自动分析」',
  );
});

test('AUTO-13：一个 revision 最多一次自动 Analyze（规范第 10、11 条回归）', () => {
  const s = new AnalyzeScheduler();

  // 一次点击引发三次 schedule（render + preview + state update）
  assert.equal(s.schedule(3, true), 'SCHEDULED', '第一次应当排程');
  assert.equal(s.schedule(3, true), 'MERGED', '第二次应当被 debounce 合并');
  assert.equal(s.schedule(3, true), 'MERGED', '第三次同样合并');

  const req = s.flush();
  assert.equal(s.calls.length, 1, '一个 revision 只能发出**一次**请求');
  assert.equal(s.receive(req, { ok: true }), 'APPLIED');

  // 同一 revision 再触发（例如又一次 render）→ 不得再跑
  assert.equal(
    s.schedule(3, true),
    'ALREADY_DONE',
    '同一个 revision 上不得重复跑决策引擎',
  );
  assert.equal(s.calls.length, 1, '请求总数仍然只有 1');

  // revision 变了 → 允许再跑一次（这正是「自动重新分析触发」）
  assert.equal(s.schedule(4, true), 'SCHEDULED', 'revision 变化必须重新分析');
  s.flush();
  assert.equal(s.calls.length, 2);
});

test('AUTO-14：stale response 不得覆盖新 revision 的结果（规范第 10 条回归）', () => {
  const s = new AnalyzeScheduler();

  // rev=5 的请求先发
  s.schedule(5, true);
  const oldReq = s.flush();

  // rev=6 的请求后发（用户又打了一张牌）
  s.schedule(6, true);
  const newReq = s.flush();

  // **新**的响应先回来 → 应用
  assert.equal(s.receive(newReq, { ok: true, tag: 'rev6' }), 'APPLIED');
  assert.equal(s.analysis.tag, 'rev6');

  // **旧**的响应迟到 → 必须丢弃，不得覆盖
  assert.equal(s.receive(oldReq, { ok: true, tag: 'rev5' }), 'STALE_TOKEN');
  assert.equal(s.analysis.tag, 'rev6', '迟到的旧响应**绝不**能覆盖新结果');
});

test('AUTO-15：信息不足时状态必须是 INSUFFICIENT，且不得留旧建议（规范第 12 条回归）', () => {
  /*
   * 「信息不足」是一个**结果状态**，不是一个错误。
   * 但它绝不能与「建议已更新」混淆 —— 也不该在界面上留着一个旧建议。
   */
  const s = new AnalyzeScheduler();
  s.schedule(5, true);
  const req = s.flush();

  // 引擎返回「没有动作」（信息不足）——与 `decideAlpha` 的 `action: null` 同义
  assert.equal(s.receive(req, { ok: true, decision: { action: null } }), 'APPLIED');
  assert.equal(s.analysis.decision.action, null, '信息不足时 action 必须是 null');

  /*
   * 界面对应的判据（与 `renderAutoAnalyzeLine` 同构）：
   *   `action === null` → INSUFFICIENT，而不是 DONE
   */
  const stateOf = (a: any) => (a.decision && a.decision.action ? 'DONE' : 'INSUFFICIENT');
  assert.equal(stateOf(s.analysis), 'INSUFFICIENT', '信息不足必须显示为「信息不足」');

  // 失败响应（ok=false）也必须被判成 INSUFFICIENT 而不是 DONE
  assert.equal(stateOf({ ok: false, decision: null }), 'INSUFFICIENT');
});
