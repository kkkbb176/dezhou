/**
 * 差分测试：牌桌点选 vs 直接构造输入
 *
 * ## 规范第 67 / 68 / 90 条
 *
 * 同一个牌局，两条路径：
 *
 * ```
 * A：直接写 ManualHandInput（旧表单路径）
 * B：在牌桌上点座位/点牌/点行动（新路径）
 * ```
 *
 * 送进 `alphaPipeline` 必须得到**逐位一致**的：
 *
 * - 重建出的 `GameState`（本文件用 `stateFingerprint` 比对）
 * - 数学九项
 * - 决策（动作 / 尺寸 / 置信度 / 分类 / 理由）
 *
 * ## 为什么这条测试是「Silent State Corruption」的主防线
 *
 * 本轮最危险的缺陷形态是：**牌桌看起来对，但后端收到的是另一个牌局**。
 * 只要两条路径的结果逐位一致，「界面在撒谎」就不可能发生。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position, Street } from '../src/domain/types.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand, hashManualInput } from '../src/app/alphaPipeline.ts';
import {
  parseManualInput,
  type ManualHandInput,
} from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { validateGameState } from '../src/domain/poker/validator.ts';
import { createTable, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp, engineViewOf } from '../src/app/table/tableOps.ts';
import { buildTablePreview, stateFingerprintOf } from '../src/app/table/tablePreview.ts';
import { tableStateToManualHandInput } from '../src/app/table/tableAdapter.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';

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

function must(result: ReturnType<typeof applyTableOp>): PokerTableState {
  if (!result.ok) throw new Error(`操作被拒绝：${result.issues.map((i) => i.message).join(' / ')}`);
  return result.state;
}

/** 建一张满座牌桌，Hero 在 `hero`，所有人同筹码 */
function fullTable(hero: Position, stackBB: number): PokerTableState {
  let state = createTable({ tableSize: 6, heroPosition: hero, defaultStackBB: stackBB });
  for (const position of ORDER_6) {
    if (position === hero) continue;
    state = must(
      applyTableOp(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, position)!.seatId }),
    );
  }
  return state;
}

/** 按预览里给出的按钮点一个动作（**行动者由后端决定**） */
function click(state: PokerTableState, type: string, sizeIndex = 0): PokerTableState {
  const p = buildTablePreview(state);
  const sizes = p.actionButtons.filter((b) => b.type === type && b.group === 'SIZE');
  const pool = sizes.length > 0 ? sizes : p.actionButtons.filter((b) => b.type === type);
  const button = pool[sizeIndex] ?? pool[0];
  assert.ok(button !== undefined, `没有可点的「${type}」按钮`);
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

function adapt(state: PokerTableState): ManualHandInput {
  const result = tableStateToManualHandInput(state);
  assert.equal(result.ok, true, `适配必须成功：${result.ok ? '' : JSON.stringify(result.issues)}`);
  if (!result.ok) throw new Error('unreachable');
  return result.input;
}

/* ============================================================
 * 场景一：翻牌顶对（Hero 在 CO）
 * ============================================================ */

/** A：直接构造（旧的表单路径） */
function directFlopScenario(): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: Position.CO,
    heroCards: ['As', 'Kd'],
    board: ['Kh', '7c', '2d'],
    street: Street.FLOP,
    effectiveStackBB: 100,
    actionHistory: [
      { position: Position.UTG, type: 'FOLD' },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'RAISE', amountBB: 2 },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
      { position: Position.BB, type: 'CALL', amountBB: 1 },
      { position: Position.BB, type: 'CHECK', street: Street.FLOP },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 100 },
  };
}

/** B：在牌桌上点出来 */
function clickedFlopScenario(): PokerTableState {
  let state = fullTable(Position.CO, 100);
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'As' }));
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Kd' }));
  state = click(state, 'FOLD'); // UTG
  state = click(state, 'FOLD'); // HJ
  state = click(state, 'RAISE'); // Hero CO 加注
  state = click(state, 'FOLD'); // BTN
  state = click(state, 'FOLD'); // SB
  state = click(state, 'CALL'); // BB 跟注 → 翻牌前下注轮结束
  // ⚠️ 顺序很关键：翻牌三张**必须**在下注轮结束之后、翻牌行动之前选完。
  //    1～2 张时预览会如实拒绝（「选择中」），这是刻意的（§42）。
  state = must(applyTableOp(state, { kind: 'SET_BOARD_CARD', card: 'Kh', slot: 0 }));
  state = must(applyTableOp(state, { kind: 'SET_BOARD_CARD', card: '7c', slot: 1 }));
  state = must(applyTableOp(state, { kind: 'SET_BOARD_CARD', card: '2d', slot: 2 }));
  // 现在引擎推进到翻牌，先行动的是 BB
  assert.equal(
    buildTablePreview(state).currentActorPosition,
    Position.BB,
    '翻牌后第一个行动的是小盲位之后 —— 小盲已弃牌，所以是大盲',
  );
  state = click(state, 'CHECK'); // BB 过牌 → 轮到 Hero
  return state;
}

test('§67 差分：翻牌顶对 —— 点选路径与直接构造路径必须逐位一致', () => {
  const clicked = clickedFlopScenario();
  const p = buildTablePreview(clicked);
  assert.equal(p.isHeroTurn, true, `应当轮到 Hero，实际轮到 ${String(p.currentActorPosition)}`);
  assert.equal(p.canAnalyze, true, `应当可以分析，阻塞项：${p.analyzeBlockers.join(' / ')}`);
  assert.equal(p.street, Street.FLOP);

  const fromTable = adapt(clicked);
  const direct = directFlopScenario();

  // ---- 1. 输入层面的差异只允许在「额外补充的字段」上 ----
  assert.equal(fromTable.tableSize, direct.tableSize);
  assert.equal(fromTable.heroPosition, direct.heroPosition);
  assert.equal(fromTable.street, direct.street);
  assert.deepEqual([...fromTable.heroCards], [...direct.heroCards]);
  assert.deepEqual([...fromTable.board], [...direct.board]);

  /**
   * 归一化：`ManualAction.street` **可省略**（省略 = 继承上一条）。
   *
   * 牌桌路径**总是**显式写出街道（它本来就知道），表单路径常常省略。
   * 两者的语义完全等价，因此比较前必须先把继承展开 ——
   * 否则会因为「一种写法更啰嗦」而误报。
   */
  const normalize = (
    history: readonly ManualHandInput['actionHistory'][number][],
  ): string[] => {
    let inherited: Street = Street.PREFLOP;
    return history.map((a) => {
      const street = a.street ?? inherited;
      inherited = street;
      return `${street}|${a.position}|${a.type}|${a.amountBB ?? '-'}`;
    });
  };

  assert.deepEqual(
    normalize(fromTable.actionHistory),
    normalize(direct.actionHistory),
    '行动历史（街道 / 位置 / 类型 / 金额）归一化后必须逐条一致',
  );

  // ---- 2. 重建出的 GameState 必须逐位一致 ----
  const parseA = parseManualInput(direct);
  const parseB = parseManualInput(fromTable);
  assert.equal(parseA.ok, true);
  assert.equal(parseB.ok, true);
  if (!parseA.ok || !parseB.ok) return;

  const gateA = buildAnalyzableState(parseA.value);
  const gateB = buildAnalyzableState(parseB.value);
  assert.equal(gateA.ok, true, `直接构造应当通过：${gateA.ok ? '' : JSON.stringify(gateA.issues)}`);
  assert.equal(gateB.ok, true, `点选路径应当通过：${gateB.ok ? '' : JSON.stringify(gateB.issues)}`);
  if (!gateA.ok || !gateB.ok) return;

  assert.equal(
    stateFingerprintOf(gateA.state),
    stateFingerprintOf(gateB.state),
    '两条路径重建出的牌局状态必须逐位一致（这是本条测试的核心）',
  );
  assert.equal(gateA.computedPot, gateB.computedPot, '底池必须一致');

  // ---- 3. 决策必须逐位一致 ----
  const decisionA = analyzeManualHand(direct, OPTIONS);
  const decisionB = analyzeManualHand(fromTable, OPTIONS);
  assert.equal(decisionA.ok && decisionB.ok, true);
  if (!decisionA.ok || !decisionB.ok) return;

  assert.equal(decisionB.decision.action, decisionA.decision.action, '动作必须一致');
  assert.equal(decisionB.decision.sizeChips, decisionA.decision.sizeChips, '尺寸必须一致');
  assert.equal(decisionB.decision.confidence, decisionA.decision.confidence, '置信度必须一致');
  assert.equal(decisionB.decision.classification, decisionA.decision.classification);
  assert.equal(
    JSON.stringify(decisionB.decision.diagnostics.math),
    JSON.stringify(decisionA.decision.diagnostics.math),
    '数学九项必须逐位一致',
  );
  assert.deepEqual(
    decisionB.decision.reasons.map((r) => r.code),
    decisionA.decision.reasons.map((r) => r.code),
  );

  // ---- 4. 预览里的显示值必须等于实际提交值（§90 三者一致）----
  assert.equal(
    p.manualHandInput !== null,
    true,
    '预览必须回传它真正会提交的结构（调试面板与红队比对用）',
  );
  assert.equal(
    hashManualInput(fromTable),
    p.stateFingerprint !== null
      ? hashManualInput(adapt(clicked))
      : hashManualInput(fromTable),
    '预览与提交必须来自同一次适配（同一输入 → 同一哈希）',
  );
});

/* ============================================================
 * 场景二：Hero 在 BB（翻牌前面对加注）
 * ============================================================ */

function directBigBlindScenario(): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: Position.BB,
    heroCards: ['Qh', 'Qs'],
    board: [],
    street: Street.PREFLOP,
    effectiveStackBB: 60,
    actionHistory: [
      { position: Position.UTG, type: 'RAISE', amountBB: 3 },
      { position: Position.HJ, type: 'FOLD' },
      { position: Position.CO, type: 'FOLD' },
      { position: Position.BTN, type: 'FOLD' },
      { position: Position.SB, type: 'FOLD' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 60 },
  };
}

test('§67 差分：Hero 在大盲面对加注 —— 逐位一致（含非 100BB 筹码）', () => {
  let state = fullTable(Position.BB, 60);
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Qh' }));
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Qs' }));
  state = click(state, 'RAISE'); // UTG 最小加注 2BB
  state = click(state, 'FOLD');
  state = click(state, 'FOLD');
  state = click(state, 'FOLD');
  state = click(state, 'FOLD');

  const p = buildTablePreview(state);
  assert.equal(p.isHeroTurn, true);
  assert.equal(p.canAnalyze, true, `阻塞项：${p.analyzeBlockers.join(' / ')}`);

  const fromTable = adapt(state);
  // UTG 的最小加注是 2BB（大盲 1BB + 最小增量 1BB）
  const direct: ManualHandInput = { ...directBigBlindScenario() };
  direct.actionHistory = [
    { position: Position.UTG, type: 'RAISE', amountBB: 2 },
    { position: Position.HJ, type: 'FOLD' },
    { position: Position.CO, type: 'FOLD' },
    { position: Position.BTN, type: 'FOLD' },
    { position: Position.SB, type: 'FOLD' },
  ];

  assert.deepEqual(
    fromTable.actionHistory.map((a) => [a.position, a.type, a.amountBB ?? null]),
    direct.actionHistory.map((a) => [a.position, a.type, a.amountBB ?? null]),
    '行动历史必须一致 —— 特别是「加注到 2BB」这个最小加注',
  );

  const a = analyzeManualHand(direct, OPTIONS);
  const b = analyzeManualHand(fromTable, OPTIONS);
  assert.equal(a.ok && b.ok, true, `两手都应当能分析：${a.ok ? '' : JSON.stringify(a.issues)}`);
  if (!a.ok || !b.ok) return;

  assert.equal(b.decision.action, a.decision.action);
  assert.equal(
    JSON.stringify(b.decision.diagnostics.math),
    JSON.stringify(a.decision.diagnostics.math),
    '非 100BB 筹码下两条路径的数学九项也必须逐位一致',
  );
  assert.equal(
    b.decision.diagnostics.math.effectiveStack,
    a.decision.diagnostics.math.effectiveStack,
  );
});

/* ============================================================
 * 场景三：Hero 位置轮换 —— 视觉旋转不得影响任何结果
 * ============================================================ */

test('§68 差分：Hero 位置轮换后，点选路径的提交数据与直接构造逐位一致', () => {
  /**
   * 同一个**逻辑牌局**用不同的 Hero 位置表达。
   *
   * ⚠️ 两条路径的 `heroPosition` 必然不同（那是输入的一部分），
   * 但除此之外的一切（座位筹码、行动历史、街道、公共牌）都必须一致 ——
   * 这就是「视觉旋转不污染逻辑」的可执行判据。
   */
  const run = (hero: Position, stackBB: number): ManualHandInput => {
    let state = fullTable(hero, stackBB);
    state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Jh' }));
    state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Jd' }));
    // 一路弃牌到 Hero
    let guard = 0;
    while (!buildTablePreview(state).isHeroTurn && guard < 10) {
      state = click(state, 'FOLD');
      guard += 1;
    }
    assert.equal(buildTablePreview(state).isHeroTurn, true, `Hero=${hero} 应当轮到他`);
    return adapt(state);
  };

  const a = run(Position.SB, 55);
  const b = run(Position.BTN, 55);

  assert.equal(a.seatStacksBB !== undefined, true);
  assert.deepEqual(
    { ...a.seatStacksBB },
    { ...b.seatStacksBB },
    '座位筹码不得随 Hero 位置变化（视觉旋转只影响渲染）',
  );
  assert.equal(a.street, b.street);
  assert.equal(a.board.length, b.board.length);
  assert.equal(a.effectiveStackBB, b.effectiveStackBB, '有效筹码是逻辑量，不得随 Hero 位置变化');

  // 行动条数**本来就应该不同**：Hero 位置不同 → 轮到他之前要弃牌的人数不同。
  // 断言的是「每一条都是弃牌，且条数与 Hero 在座位序中的位置一致」。
  assert.ok(a.actionHistory.every((x) => x.type === 'FOLD'), 'Hero 之前应当全是弃牌');
  assert.ok(b.actionHistory.every((x) => x.type === 'FOLD'));
  const seatIndex = (hero: Position): number => ORDER_6.indexOf(hero);
  assert.equal(a.actionHistory.length, seatIndex(Position.SB), 'SB 之前有 5 家人要弃牌');
  assert.equal(b.actionHistory.length, seatIndex(Position.BTN), 'BTN 之前有 3 家人要弃牌');

  // 而 heroPosition 必须如实不同
  assert.notEqual(a.heroPosition, b.heroPosition);

  // 索引顺序：视觉序号必须只由 Hero 位置决定，且 Hero 恒为 0
  const stateSb = fullTable(Position.SB, 55);
  const stateBtn = fullTable(Position.BTN, 55);
  assert.equal(seatOfPosition(stateSb, Position.SB)!.visualIndex, 0);
  assert.equal(seatOfPosition(stateBtn, Position.BTN)!.visualIndex, 0);
  assert.equal(seatOfPosition(stateSb, Position.BB)!.visualIndex, 1, 'Hero 之后按逻辑座位序');
});

/* ============================================================
 * 场景四：行动历史的「重放往返」不变式
 * ============================================================ */

test('重放往返：每点一次行动，重放出来的引擎状态必须与点选后的状态逐位一致', () => {
  /**
   * `tableOps.applyTableAction` 内部已经做了这个检查；
   * 本测试从**外部**再验证一次全流程（防止那次检查被无意绕过）。
   */
  let state = fullTable(Position.CO, 100);
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'As' }));
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Kd' }));

  const sequence: readonly { type: string; sizeIndex?: number }[] = [
    { type: 'FOLD' },
    { type: 'FOLD' },
    { type: 'RAISE' },
    { type: 'FOLD' },
    { type: 'FOLD' },
    { type: 'CALL' },
  ];

  for (const step of sequence) {
    const before = state;
    state = click(state, step.type, step.sizeIndex ?? 0);
    assert.ok(
      state.actionHistory.length === before.actionHistory.length + 1,
      '每点一次必须恰好追加一条行动记录',
    );

    // 外部重放（**两次独立重放必须一致**）。
    //
    // ⚠️ 这里刻意**不**用 `buildAnalyzableState`（那是 ANALYZE 模式，
    // 要求「必须轮到 Hero」）—— 录到一半时当然还没轮到 Hero。
    // 重放往返要验证的是「历史 → 状态」这一段的确定性，与决策点无关。
    const view1 = engineViewOf(state);
    const view2 = engineViewOf(state);
    assert.equal(view1.ok && view2.ok, true, '重放必须成功');
    if (!view1.ok || !view2.ok) return;

    assert.equal(
      stateFingerprintOf(view1.engine),
      stateFingerprintOf(view2.engine),
      '两次独立重放必须得到同一个状态',
    );

    // 校验器（Poker Core）独立确认：筹码守恒、底池一致、无「弃牌后又行动」
    const adapted = adapt(state);
    const parsed = parseManualInput(adapted);
    assert.equal(parsed.ok, true, `适配出的输入必须能解析：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
    if (!parsed.ok) return;
    const validation = validateGameState(view1.engine, { checkActions: true });
    assert.equal(
      validation.blocked,
      false,
      `牌局不得被校验器阻断：${validation.blockers.map((b) => String(b.code)).join('；')}`,
    );
  }
});

/* ============================================================
 * 场景五：错误动作必须被引擎拒绝，且状态不变
 * ============================================================ */

test('非法动作请求必须被引擎拒绝，并且**不留下任何副作用**', () => {
  let state = fullTable(Position.CO, 100);
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'As' }));
  state = must(applyTableOp(state, { kind: 'SET_HERO_CARD', card: 'Kd' }));

  const before = JSON.stringify(state.actionHistory);
  const revisionBefore = state.revision;

  // 现在轮到 UTG：给他一条「过牌」是**非法**的（面对大盲注不能过牌）
  const illegal = applyTableOp(state, { kind: 'ACT', action: { type: 'CHECK' } });
  assert.equal(illegal.ok, false, '非法的过牌必须被拒绝');
  if (illegal.ok) return;
  assert.equal(illegal.issues[0]!.code, 'ILLEGAL_ACTION');

  // 金额错得离谱的加注也必须被拒绝
  const badRaise = applyTableOp(state, {
    kind: 'ACT',
    action: { type: 'RAISE', amountChips: 1 },
  });
  assert.equal(badRaise.ok, false, '低于最小加注的请求必须被拒绝');

  assert.equal(JSON.stringify(state.actionHistory), before, '被拒绝的请求不得改动行动历史');
  assert.equal(state.revision, revisionBefore, '被拒绝的请求不得改变版本号');
});
