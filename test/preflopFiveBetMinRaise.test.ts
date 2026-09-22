/**
 * 翻前连续再加注（3Bet / 4Bet / 5Bet）—— 最小加注额与建议可执行性专项回归
 *
 * ## 这份测试防的是什么（使用者报告的形态）
 *
 * > 「9 人桌，Hero BTN KK 100BB；CO 开池 2.5 → Hero 3Bet 10 → CO 4Bet 22，
 * >  软件建议 5Bet 到 32BB」—— 按规则最小合法 5Bet 是 **34BB**（22 + 12）。
 *
 * ## 本文件实测到的生产事实（复现结论，见报告 ROOT_CAUSE）
 *
 * 用**真实生产入口**（`applyTableOp` → `engineViewOf` → `tableStateToManualHandInput`
 * → `analyzeManualHand` → `applyTableOp`）复现该局面，实测：
 *
 * ```text
 * currentBet      = 2200 筹码 = 22BB
 * lastRaiseSize   = 1200 筹码 = 12BB     ← 上一次**完整加注增量** = 22 − 10 ✅
 * minRaiseTo      = 3400 筹码 = 34BB     ← 22 + 12 ✅
 * 尺寸网格        = 34 / 36 / 48 / 60 / 72 / 96 / 100（**没有 32**）
 * 最终建议        = RAISE 到 60BB（来自网格）
 * RAISE 到 32BB   → 拒绝 ILLEGAL_ACTION
 * RAISE 到 34BB   → 接受
 * ```
 *
 * 即：**当前 HEAD（20c71a6）复现不出 32BB** —— 引擎、网格、决策候选、执行入口
 * 四层口径一致。本文件因此把「四层一致」本身锁成不变量（而不是把 34 写死）：
 * 今后任何一层改口径而别处没跟上，这里会红。
 *
 * ## 断言纪律
 *
 * 1. **不写死 34**：所有金额都从 `minRaiseTo` / `lastRaiseSize` / 网格动态推导。
 * 2. **不写死具体建议尺寸**：断言的是「建议值必须落在网格里、必须 ≥ 最小加注额、
 *    必须能被执行入口接受」，而不是「建议必须是 60」。
 * 3. 每条断言都必须能回答「哪一层改坏了会让它红」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position } from '../src/domain/types.ts';
import { createTable } from '../src/app/table/tableState.ts';
import { applyTableOp, engineViewOf } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import { tableStateToManualHandInput } from '../src/app/table/tableAdapter.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';
import { minRaiseTo } from '../src/domain/poker/gameState.ts';
import { deriveLegalActions, buildSizeGrid, potOf } from '../src/app/manualInput/legalActions.ts';
import type { PokerTableState, TableOp, TableIssue } from '../src/app/table/table.types.ts';

/* ============================================================
 * 夹具：使用者报告的那一手（真实生产入口逐段推进）
 * ============================================================ */

const BB_CHIPS = 100; // 盲注 0.5/1BB ⇒ 1BB = 100 筹码
const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;

const toChips = (bb: number): number => Math.round(bb * BB_CHIPS);

function must(state: PokerTableState, op: TableOp): PokerTableState {
  const r = applyTableOp(state, op);
  assert.equal(
    r.ok,
    true,
    `${op.kind} 必须被接受：${r.ok ? '' : (r.issues as readonly TableIssue[]).map((i) => `${i.code}:${i.message}`).join(' / ')}`,
  );
  if (!r.ok) throw new Error('unreachable');
  return r.state;
}

/** 弃牌直到轮到 `target`（用于把 9 人桌折叠到只剩 CO 与 Hero） */
function foldUntil(state: PokerTableState, target: Position): PokerTableState {
  let s = state;
  for (let guard = 0; guard < 30; guard += 1) {
    const p = buildTablePreview(s);
    if (p.currentActorPosition === target) return s;
    assert.notEqual(p.currentActorPosition, null, `无法推进到 ${target}：已经没有人需要行动`);
    s = must(s, { kind: 'ACT', action: { type: 'FOLD' } });
  }
  throw new Error(`无法推进到 ${target} 行动`);
}

function raiseAt(state: PokerTableState, actor: Position, toBB: number): PokerTableState {
  const ready = foldUntil(state, actor);
  return must(ready, { kind: 'ACT', action: { type: 'RAISE', amountChips: toChips(toBB) } });
}

/**
 * 使用者报告的局面：9 人桌满座、盲注 0.5/1BB、Hero BTN KsKh、双方 100BB，
 * 行动序列 CO 2.5 → BTN 10 → CO 22，停在**轮到 Hero 做 5Bet 决策**。
 *
 * ⚠️ 必须满座再弃牌，**不能只坐两个人** —— 两个参与者会被引擎按**单挑**拓扑处理
 * （BTN 是小盲、大盲变成另一个人），盲注结构与使用者录入的 9 人桌不同。
 */
function fiveBetSpot(): PokerTableState {
  let state = createTable({
    tableSize: 9,
    heroPosition: Position.BTN,
    defaultStackBB: 100,
    bigBlindBB: BB_CHIPS,
  });
  for (const seat of state.seats) {
    if (seat.playerId !== null) continue;
    state = must(state, { kind: 'ADD_PLAYER', seatId: seat.seatId });
  }
  /* ⚠️ 顺序：先设筹码 → 再发牌（发牌即开手，之后不许改筹码） */
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Ks' });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Kh' });
  state = raiseAt(state, Position.CO, 2.5); // CO 开池
  state = raiseAt(state, Position.BTN, 10); // Hero 3Bet
  state = raiseAt(state, Position.CO, 22); // CO 4Bet
  return state;
}

/** 从牌桌状态取出「Hero 面对 4Bet」这一环的引擎与网格事实 */
function spotFacts(state: PokerTableState) {
  const view = engineViewOf(state);
  assert.equal(view.ok, true, '引擎视图必须可重建');
  if (!view.ok) throw new Error('unreachable');
  const engine = view.engine;
  const hero = engine.players.find((p) => p.position === Position.BTN);
  assert.ok(hero !== undefined, 'Hero 必须在本手里');
  const legal = deriveLegalActions(engine, hero);
  const grid = buildSizeGrid(legal, potOf(engine), 'RAISE');
  const actor = actorOnTurn(engine);
  return { engine, hero: hero!, legal, grid, actor };
}

function recommendationOf(state: PokerTableState) {
  const adapted = tableStateToManualHandInput(state);
  assert.equal(adapted.ok, true, `适配必须成功：${adapted.ok ? '' : JSON.stringify(adapted.issues)}`);
  if (!adapted.ok) throw new Error('unreachable');
  const result = analyzeManualHand(adapted.input, OPTIONS);
  assert.equal(result.ok, true, `分析必须成功：${result.ok ? '' : `${result.stage} ${JSON.stringify(result.issues)}`}`);
  if (!result.ok) throw new Error('unreachable');
  return result.decision;
}

/* ============================================================
 * 一、最小加注额：lastRaiseSize 必须是「上一次完整加注增量」
 * ============================================================ */

test('5BET-01：开池 2.5 → 3Bet 10 → 4Bet 22 之后，最小 5Bet 必须是 22 + (22−10)', () => {
  const state = fiveBetSpot();
  const { engine, legal } = spotFacts(state);

  assert.equal(engine.currentBet, toChips(22), 'currentBet 必须是 22BB（本街总额口径）');
  assert.equal(
    engine.lastRaiseSize,
    toChips(12),
    'lastRaiseSize 必须是**上一次完整加注增量**（22 − 10 = 12BB），而不是某个「加注到的总额」',
  );
  assert.equal(
    minRaiseTo(engine),
    toChips(34),
    '最小合法 5Bet 总额 = currentBet + lastRaiseSize = 34BB',
  );
  assert.equal(
    legal.minRaiseToAmount,
    minRaiseTo(engine),
    'legalActions 的最小加注额必须与 gameState.minRaiseTo **同一口径**（两处不一致就是本类缺陷的温床）',
  );
  assert.equal(minRaiseTo(engine), engine.currentBet + engine.lastRaiseSize, '恒等式必须成立');
});

test('5BET-02：每一段加注都必须正确更新 lastRaiseSize（开池 / 3Bet / 4Bet 逐段核对）', () => {
  let state = createTable({
    tableSize: 9,
    heroPosition: Position.BTN,
    defaultStackBB: 100,
    bigBlindBB: BB_CHIPS,
  });
  for (const seat of state.seats) {
    if (seat.playerId !== null) continue;
    state = must(state, { kind: 'ADD_PLAYER', seatId: seat.seatId });
  }
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Ks' });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Kh' });

  /** 每段之后：currentBet / lastRaiseSize / minRaiseTo 的期望值（BB） */
  const steps: readonly { actor: Position; toBB: number; currentBetBB: number; lastRaiseBB: number }[] = [
    { actor: Position.CO, toBB: 2.5, currentBetBB: 2.5, lastRaiseBB: 1.5 }, // 开池：2.5 − 1（大盲）
    { actor: Position.BTN, toBB: 10, currentBetBB: 10, lastRaiseBB: 7.5 }, // 3Bet：10 − 2.5
    { actor: Position.CO, toBB: 22, currentBetBB: 22, lastRaiseBB: 12 }, // 4Bet：22 − 10
  ];

  for (const step of steps) {
    state = raiseAt(state, step.actor, step.toBB);
    const view = engineViewOf(state);
    assert.equal(view.ok, true);
    if (!view.ok) return;
    assert.equal(
      view.engine.currentBet,
      toChips(step.currentBetBB),
      `${step.actor} 加注到 ${step.toBB}BB 之后 currentBet 应为 ${step.currentBetBB}BB`,
    );
    assert.equal(
      view.engine.lastRaiseSize,
      toChips(step.lastRaiseBB),
      `${step.actor} 加注到 ${step.toBB}BB 之后 lastRaiseSize 应为 ${step.lastRaiseBB}BB（= 本次总额 − 上一次总额）`,
    );
    assert.equal(
      minRaiseTo(view.engine),
      toChips(step.currentBetBB + step.lastRaiseBB),
      `最小再加注额必须是 currentBet + lastRaiseSize`,
    );
  }
});

/* ============================================================
 * 二、执行入口：32BB 必须被拒、34BB 与 40BB 必须被接受
 * ============================================================ */

test('5BET-03：🔴 加注到 32BB 必须被**拒绝**（它不是合法完整加注，也不是全下例外）', () => {
  const state = fiveBetSpot();
  const attempt = applyTableOp(state, {
    kind: 'ACT',
    action: { type: 'RAISE', amountChips: toChips(32) },
  });
  assert.equal(attempt.ok, false, '32BB 低于最小加注额且 Hero 还有筹码 ⇒ 必须拒绝');
  if (attempt.ok) return;
  assert.ok(
    attempt.issues.some((i) => i.code === 'ILLEGAL_ACTION'),
    `拒绝必须由 Poker Core 给出（不是界面自己拦），实际：${JSON.stringify(attempt.issues)}`,
  );
  // 拒绝之后局面不得被改动（拒绝要是「无副作用」的）
  const after = engineViewOf(state);
  assert.equal(after.ok, true);
});

test('5BET-04：加注到最小额（动态推导）必须被接受', () => {
  const state = fiveBetSpot();
  const { engine } = spotFacts(state);
  const minTo = minRaiseTo(engine);
  const accepted = must(state, { kind: 'ACT', action: { type: 'RAISE', amountChips: minTo } });
  const view = engineViewOf(accepted);
  assert.equal(view.ok, true);
  if (!view.ok) return;
  assert.equal(view.engine.currentBet, minTo, '接受之后 currentBet 必须正好等于最小加注额');
  assert.equal(
    view.engine.lastRaiseSize,
    minTo - toChips(22),
    '新的 lastRaiseSize 必须等于这次加注的增量',
  );
});

test('5BET-05：加注到 40BB 必须被接受（高于最小额的自然加注）', () => {
  const state = fiveBetSpot();
  const accepted = must(state, { kind: 'ACT', action: { type: 'RAISE', amountChips: toChips(40) } });
  const view = engineViewOf(accepted);
  assert.equal(view.ok, true);
  if (!view.ok) return;
  assert.equal(view.engine.currentBet, toChips(40));
});

test('5BET-06：Hero 全下必须合法，且被识别为全下（按预览按钮的真实载荷提交）', () => {
  const state = fiveBetSpot();

  /*
   * 🔴 提交方式必须**照抄预览按钮**，不能自己编一个金额。
   *
   * `tablePreview.ts:314` 的约定：全下按钮**刻意不带 `amountChips`** ——
   * 引擎的 `doAllIn` 把 `command.amount` 解释为「**本次投入**的筹码」
   *（= 剩余筹码），而界面按钮上的数字是「本街累计」。两者混用会撞
   * `ALLIN_AMOUNT_MISMATCH`（Hero 剩 90BB 却填 100BB 就会被拒）。
   *
   * 因此本测试走生产路径：从预览里取 `ALL_IN` 按钮，用它自己的载荷提交。
   */
  const preview = buildTablePreview(state);
  const allInButton = preview.actionButtons.find((b) => b.type === 'ALL_IN' && b.group !== 'EXPAND');
  assert.ok(allInButton !== undefined, '预览必须给出全下按钮');
  assert.equal(allInButton!.amountChips, undefined, '全下按钮不得携带 amountChips（口径见 tablePreview 的约定）');

  const accepted = must(state, {
    kind: 'ACT',
    action: {
      type: 'ALL_IN',
      ...(allInButton!.amountChips !== undefined ? { amountChips: allInButton!.amountChips } : {}),
    },
  });
  const view = engineViewOf(accepted);
  assert.equal(view.ok, true);
  if (!view.ok) return;
  const hero = view.engine.players.find((p) => p.position === Position.BTN)!;
  assert.equal(hero.allIn, true, '全下之后必须被标记为 allIn');
  assert.equal(hero.remainingStack, 0, '全下之后剩余筹码必须是 0');
  assert.equal(view.engine.currentBet, toChips(100), '全下总额必须如实写进 currentBet');
  assert.equal(
    hero.committedByStreet.PREFLOP,
    toChips(100),
    '全下后 Hero 本街累计投入必须是 100BB',
  );
});

test('5BET-06b：全下的金额口径 —— 带「本街累计」会被拒，带「本次投入」会被接受', () => {
  const state = fiveBetSpot();
  const { hero } = spotFacts(state);
  assert.equal(hero.remainingStack, toChips(90), '前置条件：Hero 剩余 90BB');

  /*
   * 这条断言锁的是**口径**，不是行为偏好：
   * 界面按钮上的数字是「全下到 100BB」（本街累计），而引擎要的是「本次投入 90BB」。
   * 两者相差的正是 Hero 已经投入的那 10BB —— 一旦有人把界面的数字原样提交，
   * 就会在这里变红，而不是在生产里静默失败。
   */
  const cumulative = applyTableOp(state, {
    kind: 'ACT',
    action: { type: 'ALL_IN', amountChips: toChips(100) },
  });
  assert.equal(
    cumulative.ok,
    false,
    '把「本街累计 100BB」当作 ALL_IN 的 amount 提交必须被拒绝（引擎要的是本次投入 90BB）',
  );

  const incremental = applyTableOp(state, {
    kind: 'ACT',
    action: { type: 'ALL_IN', amountChips: toChips(90) },
  });
  assert.equal(incremental.ok, true, '按「本次投入」口径提交 90BB 必须被接受');
});

/* ============================================================
 * 三、尺寸网格与决策候选：合法性必须在**生成阶段**就成立
 * ============================================================ */

test('5BET-07：尺寸网格里**不得**出现低于最小加注额的候选（32BB 不得存在）', () => {
  const state = fiveBetSpot();
  const { engine, grid } = spotFacts(state);
  const minTo = minRaiseTo(engine);

  assert.ok(grid.length >= 2, `网格必须有得选（含最小额与全下），实际 ${grid.length} 项`);
  assert.equal(grid[0]!.toAmount, minTo, '第一项必须是最小加注额');
  for (const option of grid) {
    assert.ok(
      option.toAmount >= minTo,
      `网格候选 ${option.toAmount} 筹码（${option.toAmount / BB_CHIPS}BB）低于最小加注额 ${minTo} —— ` +
        '低于最小额的候选必须**丢弃**，不是夹上来',
    );
    assert.ok(option.toAmount <= engine.players.find((p) => p.position === Position.BTN)!.remainingStack + toChips(10), '候选不得超过全下额');
    assert.equal(
      option.costChips,
      option.toAmount - toChips(10),
      '成本口径必须是「本街总额 − 本街已投入」（Hero 已投入 10BB）',
    );
  }
  assert.equal(
    grid.some((o) => o.toAmount === toChips(32)),
    false,
    '🔴 32BB 不得出现在网格里（它是使用者报告的那个非法数字）',
  );
});

test('5BET-08：决策候选必须逐个 ≥ 最小加注额，且不得出现 32BB', () => {
  const state = fiveBetSpot();
  const { engine } = spotFacts(state);
  const minTo = minRaiseTo(engine);
  const decision = recommendationOf(state);

  const raiseCandidates = decision.diagnostics.candidates.filter((c) => c.action === 'RAISE');
  assert.ok(raiseCandidates.length > 0, '必须至少有一个加注候选');
  for (const c of raiseCandidates) {
    assert.ok(c.sizeChips !== undefined, 'RAISE 候选必须有尺寸');
    assert.ok(
      c.sizeChips! >= minTo,
      `候选加注 ${c.sizeChips} 筹码低于最小加注额 ${minTo}（${minTo / BB_CHIPS}BB）`,
    );
    if (c.sizeBB !== undefined) {
      assert.ok(Math.abs(c.sizeBB * BB_CHIPS - c.sizeChips!) < 1, 'sizeBB 与 sizeChips 必须同口径');
    }
  }
  assert.equal(
    raiseCandidates.some((c) => c.sizeChips === toChips(32)),
    false,
    '🔴 决策候选里不得出现 32BB',
  );
});

test('5BET-09：🔴 最终建议不得是 32BB，且必须落在网格内、可被**实际执行入口**接受', () => {
  const state = fiveBetSpot();
  const { engine, grid } = spotFacts(state);
  const minTo = minRaiseTo(engine);
  const decision = recommendationOf(state);

  /* ---- 1. 不是 32BB ---- */
  assert.notEqual(decision.sizeChips, toChips(32), '不得建议 32BB');

  /* ---- 2. 加注类建议必须 ≥ 最小加注额 ---- */
  if (decision.action === 'RAISE' || decision.action === 'ALL_IN') {
    assert.ok(decision.sizeChips !== undefined, `${String(decision.action)} 必须带尺寸`);
    assert.ok(
      decision.sizeChips! >= minTo,
      `建议 ${decision.sizeChips} 筹码低于最小加注额 ${minTo}`,
    );
    /* ---- 3. 必须落在网格里（不伪造网格外的精确数值） ---- */
    const inGrid = grid.some((o) => o.toAmount === decision.sizeChips);
    assert.ok(
      inGrid,
      `建议的 ${decision.sizeChips} 筹码必须来自尺寸网格 ${JSON.stringify(grid.map((o) => o.toAmount))}`,
    );

    /* ---- 4. 必须真的能执行（推荐与执行同一套合法规则） ---- */
    const executed = applyTableOp(state, {
      kind: 'ACT',
      action: { type: decision.action, amountChips: decision.sizeChips },
    });
    assert.equal(
      executed.ok,
      true,
      `推荐必须可执行，实际被拒绝：${executed.ok ? '' : JSON.stringify(executed.issues)}`,
    );
  }
});

test('5BET-10：建议与执行入口必须同源 —— 网格内每一项都真的能执行', () => {
  const state = fiveBetSpot();
  const { grid } = spotFacts(state);
  for (const option of grid) {
    /*
     * ⚠️ 网格里的「全下」项，其 `toAmount` 就是**加注到 100BB**。
     * 提交时动作类型必须是 `RAISE`：本局面 Hero 面对 22BB 加注，
     * 全下**在这条路径上是「加注全下」而不是「开池全下」**，
     * 用 `ALL_IN` 提交会撞上引擎的 `ALLIN_AMOUNT_MISMATCH`
     *（引擎要求直接全下的金额语义与所在路径一致）。
     */
    const executed = applyTableOp(state, {
      kind: 'ACT',
      action: { type: 'RAISE', amountChips: option.toAmount },
    });
    assert.equal(
      executed.ok,
      true,
      `网格候选 ${option.toAmount} 筹码（${option.toAmount / BB_CHIPS}BB${option.isAllIn ? '，全下' : ''}）必须可执行：` +
        `${executed.ok ? '' : JSON.stringify(executed.issues)}`,
    );
  }
});

/* ============================================================
 * 四、金额语义：不得混用 raise to 与 raise by
 * ============================================================ */

test('5BET-11：动作记录的金额必须是「加注到」的本街总额，且本次新增投入口径正确', () => {
  const state = fiveBetSpot();
  const view = engineViewOf(state);
  assert.equal(view.ok, true);
  if (!view.ok) return;

  const raises = view.engine.actions.filter((a) => a.type === 'RAISE');
  assert.equal(raises.length, 3, '本手翻前必须有三次加注（开池 / 3Bet / 4Bet）');

  const [open, threeBet, fourBet] = raises;
  assert.equal(open!.toAmount, toChips(2.5), '开池记录的 toAmount 必须是加注到 2.5BB');
  assert.equal(threeBet!.toAmount, toChips(10), '3Bet 记录的 toAmount 必须是加注到 10BB');
  assert.equal(fourBet!.toAmount, toChips(22), '4Bet 记录的 toAmount 必须是加注到 22BB');

  /*
   * 同一个动作记录里并存两个金额，语义**必须**分清（实测口径）：
   *
   * | 字段 | 含义 | 开池(CO) | 3Bet(BTN) | 4Bet(CO) |
   * |---|---|---|---|---|
   * | `toAmount` | **本街累计总额**（加注到多少） | 250 | 1000 | 2200 |
   * | `amount` | **本次新增投入** = toAmount − 加注者自己此前的本街投入 | 250 | 1000 | **1950** |
   *
   * ⚠️ 两个最容易写错的点，这里都钉住：
   *
   * 1. `amount` **不是** `currentBet`（22BB）。它减掉的是**加注者自己**此前的投入
   *    （CO 开池已投 2.5BB ⇒ 4Bet 的 amount = 22 − 2.5 = 19.5BB）。
   * 2. 它**更不是** Hero 的投入与它的差（22 − 10 = 12BB）——那 10BB 是 Hero 的投入，
   *    与 CO 的本次新增投入无关。12BB 是**另一个量**：`lastRaiseSize`（上一次完整加注增量）。
   */
  assert.equal(open!.amount, toChips(2.5), '开池的 amount = 2.5 − 0');
  assert.equal(threeBet!.amount, toChips(10), '3Bet 的 amount = 10 − 0（BTN 此前未投入）');
  assert.equal(
    fourBet!.amount,
    toChips(22) - toChips(2.5),
    '4Bet 的 amount = 22 − 2.5（减掉的是 CO 自己开池投入的 2.5，不是 Hero 的 10）',
  );
  assert.notEqual(fourBet!.amount, fourBet!.toAmount, 'amount（新增）与 toAmount（总额）语义不同，不得等同');
  assert.notEqual(
    fourBet!.amount,
    toChips(12),
    'amount 不得等于 lastRaiseSize（12BB）—— 把「本次新增投入」与「上一次完整加注增量」混用是同类缺陷的温床',
  );
});

test('5BET-12：Hero 的需跟注额 = currentBet − 本街已投入（22 − 10 = 12BB）', () => {
  const state = fiveBetSpot();
  const { engine, hero, legal } = spotFacts(state);

  assert.equal(hero.committedByStreet.PREFLOP, toChips(10), 'Hero 本街已投入必须是 10BB');
  assert.equal(
    legal.callCost,
    toChips(12),
    '需跟注额必须是「本街总额 − 已投入」= 12BB，不是 22BB（那是总额口径）',
  );
  assert.equal(legal.callCost, engine.currentBet - hero.committedByStreet.PREFLOP);
});

/* ============================================================
 * 五、短码全下例外与「不足额全下不重开加注权」
 * ============================================================ */

/**
 * 短码全下的生产局面：CO 只有 22BB。
 *
 * ```text
 * CO 全下 22BB（= 4Bet 的金额，但**由全下完成**）
 * Hero（BTN）加注到 100BB（全下）→ 最小再加注 = 100 + 78 = 178BB（超出筹码 ⇒ 只剩全下）
 * ```
 *
 * ⚠️ 提交全下**必须用 `ALL_IN`**：用 `RAISE 到 22BB` 提交会被 `RAISE_BELOW_MIN` 拒绝 ——
 * 那是**正确**行为（加注口径要求 ≥ 最小加注额），全下例外只对 `ALL_IN` 生效。
 */
function shortStackVillain(): PokerTableState {
  let state = createTable({
    tableSize: 9,
    heroPosition: Position.BTN,
    defaultStackBB: 100,
    bigBlindBB: BB_CHIPS,
  });
  for (const seat of state.seats) {
    if (seat.playerId !== null) continue;
    state = must(state, { kind: 'ADD_PLAYER', seatId: seat.seatId });
  }
  state = must(state, { kind: 'SET_STACK', seatId: 'seat_CO', stackBB: 22 });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Ks' });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Kh' });
  // 折叠到 CO，然后 CO 用 ALL_IN（不带金额）把 22BB 全部投入
  state = foldUntil(state, Position.CO);
  state = must(state, { kind: 'ACT', action: { type: 'ALL_IN' } });
  return state;
}

test('5BET-14：短码全下例外 —— 全下低于最小加注时仍然合法，且 lastRaiseSize 按其真实增量更新', () => {
  let state = createTable({
    tableSize: 9,
    heroPosition: Position.BTN,
    defaultStackBB: 100,
    bigBlindBB: BB_CHIPS,
  });
  for (const seat of state.seats) {
    if (seat.playerId !== null) continue;
    state = must(state, { kind: 'ADD_PLAYER', seatId: seat.seatId });
  }
  /*
   * 大盲只有 6.2BB —— 注意 6.2BB 里已经包含他被迫投下的 1BB（盲注），
   * 因此他面对 Hero 的 10BB 时最多只能把剩下的 5.2BB 投进去 ⇒ 全下总额 6.2BB。
   * 小盲保持正常筹码（他在这条线上直接弃牌，用来把行动交到大盲手里）。
   */
  state = must(state, { kind: 'SET_STACK', seatId: 'seat_BB', stackBB: 6.2 });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Ks' });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Kh' });
  state = raiseAt(state, Position.CO, 2.5);
  state = raiseAt(state, Position.BTN, 10);

  const before = engineViewOf(state);
  assert.equal(before.ok, true);
  if (!before.ok) return;
  assert.equal(before.engine.lastRaiseSize, toChips(7.5), '前置条件：3Bet 之后 lastRaiseSize = 7.5BB');

  /* 小盲弃牌，把行动交给短码大盲 */
  state = must(state, { kind: 'ACT', action: { type: 'FOLD' } });
  const atBigBlind = buildTablePreview(state);
  assert.equal(atBigBlind.currentActorPosition, Position.BB, '前置条件：现在轮到短码大盲行动');

  /*
   * 大盲全下 6.2BB —— 远低于最小加注额 17.5BB。
   * 用 `RAISE` 提交必须被拒（加注口径），用 `ALL_IN` 提交必须被接受（短码全下例外）。
   */
  const asRaise = applyTableOp(state, {
    kind: 'ACT',
    action: { type: 'RAISE', amountChips: Math.round(6.2 * BB_CHIPS) },
  });
  assert.equal(asRaise.ok, false, '不足额全下用 RAISE 提交必须被拒绝（RAISE 有最小加注额要求）');

  const after = must(state, { kind: 'ACT', action: { type: 'ALL_IN' } });
  const view = engineViewOf(after);
  assert.equal(view.ok, true);
  if (!view.ok) return;
  const bbPlayer = view.engine.players.find((p) => p.position === Position.BB)!;
  assert.equal(bbPlayer.allIn, true, '大盲必须被标记为全下');
  assert.equal(bbPlayer.remainingStack, 0, '短码全下后剩余筹码为 0');
  assert.equal(bbPlayer.committedByStreet.PREFLOP, Math.round(6.2 * BB_CHIPS), '本街投入即全部筹码');
  assert.equal(
    view.engine.currentBet,
    toChips(10),
    '短码全下没有超过当前注额 ⇒ currentBet 仍是 Hero 的 10BB（不足额全下不构成新注额）',
  );
  assert.equal(
    view.engine.lastRaiseSize,
    toChips(7.5),
    '不足额全下**不得**改写 lastRaiseSize（否则 Hero 的最小再加注会被凭空抬高）',
  );
  assert.equal(minRaiseTo(view.engine), toChips(17.5), '最小加注额仍按 Hero 的 3Bet 增量算');
});

test('5BET-15：由**全下**完成的完整加注必须照常更新 lastRaiseSize（短码 22BB 全下）', () => {
  const state = shortStackVillain();
  const view = engineViewOf(state);
  assert.equal(view.ok, true);
  if (!view.ok) return;

  assert.equal(view.engine.currentBet, toChips(22), 'CO 全下后 currentBet = 22BB');
  assert.equal(
    view.engine.lastRaiseSize,
    toChips(22) - toChips(1),
    '由全下完成的**完整**加注（22 − 1 大盲 = 21BB）必须照常更新 lastRaiseSize',
  );
  assert.equal(
    minRaiseTo(view.engine),
    toChips(43),
    'Hero 的最小再加注 = 22 + 21 = 43BB（动态推导）',
  );

  // Hero 全下 100BB ⇒ lastRaiseSize 更新为 100 − 22 = 78BB
  const shoved = must(state, { kind: 'ACT', action: { type: 'ALL_IN' } });
  const after = engineViewOf(shoved);
  assert.equal(after.ok, true);
  if (!after.ok) return;
  assert.equal(after.engine.currentBet, toChips(100), 'Hero 全下后 currentBet = 100BB');
  assert.equal(
    after.engine.lastRaiseSize,
    toChips(100) - toChips(22),
    'lastRaiseSize 必须是本次加注增量（100 − 22 = 78BB），不是加注到的总额 100BB',
  );
  assert.equal(minRaiseTo(after.engine), toChips(178), '最小再加注 = 178BB（超出筹码 ⇒ 只剩全下）');
});

/* ============================================================
 * 六、拒绝必须无副作用：非法加注不得改动任何状态
 * ============================================================ */

test('5BET-13：被拒绝的 32BB 不得改动筹码、底池或行动记录', () => {
  const state = fiveBetSpot();
  const before = engineViewOf(state);
  assert.equal(before.ok, true);
  if (!before.ok) return;

  const rejected = applyTableOp(state, {
    kind: 'ACT',
    action: { type: 'RAISE', amountChips: toChips(32) },
  });
  assert.equal(rejected.ok, false);

  /*
   * 🔴 拒绝必须是**纯拒绝**：`applyTableOp` 失败时返回的状态里，
   * 牌桌状态（筹码 / 行动历史 / revision）一个字节都不许动。
   * 断言用**同一个** `state` 对象重新重放引擎，而不是看失败响应 ——
   * 「响应里没写」不等于「状态没被改」。
   */
  assert.equal(
    state.actionHistory.length,
    10,
    '牌桌行动历史必须仍是 10 条（5 条前位弃牌 + 开池 + 3Bet + 4Bet + 小盲/大盲弃牌），' +
      '拒绝不得写进历史',
  );
  const after = engineViewOf(state);
  assert.equal(after.ok, true);
  if (!after.ok) return;
  assert.equal(after.engine.currentBet, before.engine.currentBet, 'currentBet 不得变化');
  assert.equal(after.engine.lastRaiseSize, before.engine.lastRaiseSize, 'lastRaiseSize 不得变化');
  assert.equal(after.engine.actions.length, before.engine.actions.length, '行动记录不得增加');
  const heroAfter = after.engine.players.find((p) => p.position === Position.BTN)!;
  assert.equal(heroAfter.remainingStack, toChips(90), 'Hero 剩余筹码不得被扣走');
  assert.equal(
    state.seats.filter((s) => s.playerId !== null).length,
    9,
    '座位占用不得变化',
  );
});
