/**
 * STREET STATE CONSISTENCY V2 · 街道状态一致性回归测试
 * ============================================================================
 *
 * 缺陷（用户报告）：「Hero 未完成转牌行动，却提前进入河牌」。
 *
 * 审计结论（`reports/STREET_STATE_CONSISTENCY_AUDIT_V1.md`）：
 *   引擎的权威街道**只由行动重放决定**（`advanceStreet` 是唯一改街道/发牌的地方，
 *   `SET_BOARD_CARD` 只是数据录入、**不推进任何阶段**）。缺陷的**活的一半**在于
 *   「预览在转牌行动未完成时仍宣布 `ready / READY`，而决策管线随即以
 *   `HISTORY_DOES_NOT_REACH_STREET`（RECONSTRUCT）拒绝」——即界面承诺了它给不出的东西。
 *
 * 本测试固定六项验收不变量：
 *   A 不提前推进街道（引擎权威）；B 先录牌后补行动（含 Hero 本人）能力保留；
 *   C 预览不得把未来街说成「正式可分析」；D 合法局面不得倒退为 RECONSTRUCT/ERROR；
 *   E 未来信息隔离（预录的第 5 张牌不得进入转牌计算、不得生成正式河牌 EV）；
 *   F 与既有契约不冲突（由既有 2072 项测试共同保证）。
 *
 * **导入零产品模块改动依赖**：全部断言都走公开入口（`applyTableOp` / `engineViewOf` /
 * `buildTablePreview` / `tableStateToManualHandInput` / `analyzeManualHand`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { createTable } from '../src/app/table/tableState.ts';
import { applyTableOp, engineViewOf } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import { tableStateToManualHandInput } from '../src/app/table/tableAdapter.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';
import { allBoardCards, computePot, playerById } from '../src/domain/poker/gameState.ts';
import { cardToString } from '../src/domain/poker/cards.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';
import type { Position } from '../src/domain/types.ts';

/* ============================================================
 * 公共装置
 * ============================================================ */

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(),
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: 20_260_913,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

/** 应用一个操作，失败即抛（测试中不允许静默失败） */
function must(result: ReturnType<typeof applyTableOp>, label: string): PokerTableState {
  if (!result.ok) {
    throw new Error(`${label}: ${result.issues.map((i) => i.message).join(' / ')}`);
  }
  return result.state;
}

const step = (s: PokerTableState, op: TableOp): PokerTableState => must(applyTableOp(s, op), op.kind);

function legalNow(s: PokerTableState): Record<string, unknown> {
  const view = engineViewOf(s);
  if (!view.ok) throw new Error('engineView 失败');
  const id = actorOnTurn(view.engine);
  const player = id === null ? undefined : playerById(view.engine, id);
  if (player === undefined) throw new Error('无行动者');
  return deriveLegalActions(view.engine, player) as unknown as Record<string, unknown>;
}

const callOp = (s: PokerTableState): TableOp => ({
  kind: 'ACT',
  action: { type: 'CALL', amountChips: Number(legalNow(s)['callCost']) },
});

const boardOf = (s: PokerTableState): readonly string[] => {
  const view = engineViewOf(s);
  if (!view.ok) throw new Error('engineView 失败');
  return allBoardCards(view.engine).map(cardToString);
};

const engineOf = (s: PokerTableState) => {
  const view = engineViewOf(s);
  if (!view.ok) throw new Error('engineView 失败');
  return view.engine;
};

/** 当前行动者的**位置**（`actorOnTurn` 返回的是 playerId，需要再解析） */
const actorPositionOf = (s: PokerTableState): Position | null => {
  const engine = engineOf(s);
  const id = actorOnTurn(engine);
  return id === null ? null : (playerById(engine, id)?.position ?? null);
};

/**
 * 9 人桌 · Hero = BTN · 翻前 BTN 加注 / 一家跟注 → 翻牌 3 张 + CHECK/BET/CALL
 * → 转牌 1 张 → BB 下注、**Hero 尚未行动**（正是用户报告的局面）。
 *
 * `riverCard` 非空时在该局面**额外录入第 5 张公共牌**（模拟「手滑/抢录河牌」）。
 */
function toTurnFacingBet(riverCard: string | null = null): PokerTableState {
  let s = createTable({ tableSize: 9, heroPosition: 'BTN' as Position, defaultStackBB: 100 });
  for (const seat of s.seats) {
    if (seat.playerId === null) s = step(s, { kind: 'ADD_PLAYER', seatId: seat.seatId });
  }
  s = step(s, { kind: 'SET_HERO_CARD', card: 'As' });
  s = step(s, { kind: 'SET_HERO_CARD', card: 'Ks' });
  for (let i = 0; i < 20; i++) {
    const engine = engineOf(s);
    const id = actorOnTurn(engine);
    const player = id === null ? undefined : playerById(engine, id);
    if (player?.position === 'BTN') break;
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
  if (riverCard !== null) s = step(s, { kind: 'SET_BOARD_CARD', card: riverCard, slot: 4 });
  return s;
}

/** 先录满 5 张公共牌，再补录全部历史行动（`§D-4` 式「先录牌后补行动」） */
function boardFirstThenActions(): PokerTableState {
  let s = createTable({ tableSize: 9, heroPosition: 'BTN' as Position, defaultStackBB: 100 });
  for (const seat of s.seats) {
    if (seat.playerId === null) s = step(s, { kind: 'ADD_PLAYER', seatId: seat.seatId });
  }
  s = step(s, { kind: 'SET_HERO_CARD', card: 'As' });
  s = step(s, { kind: 'SET_HERO_CARD', card: 'Ks' });
  for (const [i, card] of ['Kd', '9c', '4h', '6s', 'Qh'].entries()) {
    s = step(s, { kind: 'SET_BOARD_CARD', card, slot: i });
  }
  for (let i = 0; i < 20; i++) {
    const engine = engineOf(s);
    const id = actorOnTurn(engine);
    const player = id === null ? undefined : playerById(engine, id);
    if (player?.position === 'BTN') break;
    s = step(s, { kind: 'ACT', action: { type: 'FOLD' } });
  }
  s = step(s, { kind: 'ACT', action: { type: 'RAISE', amountChips: Number(legalNow(s)['minRaiseToAmount']) } });
  s = step(s, { kind: 'ACT', action: { type: 'FOLD' } });
  s = step(s, callOp(s));
  s = step(s, { kind: 'ACT', action: { type: 'CHECK' } });
  s = step(s, { kind: 'ACT', action: { type: 'BET', amountChips: Number(legalNow(s)['minBet']) * 5 } });
  s = step(s, callOp(s));
  s = step(s, { kind: 'ACT', action: { type: 'BET', amountChips: Number(legalNow(s)['minBet']) * 5 } });
  s = step(s, callOp(s));
  return s;
}

/** 决策管线输出的可比投影（只取数学与动作，避开计时/日志等噪声） */
function project(result: ReturnType<typeof analyzeManualHand>): Record<string, unknown> {
  if (!result.ok) return { ok: false, stage: result.stage };
  const dg = ((result.decision as unknown as Record<string, unknown>)['diagnostics'] ?? {}) as Record<string, unknown>;
  const math = (dg['math'] ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    street: math['street'],
    heroEquity: math['heroEquity'],
    callEV: math['callEV'],
    pot: math['pot'],
    winnable: math['winnable'],
    action: (result.decision as unknown as Record<string, unknown>)['action'],
  };
}

function manualInputOf(s: PokerTableState) {
  const adapted = tableStateToManualHandInput(s);
  if (!adapted.ok) throw new Error(`adapter 失败：${adapted.issues.map((i) => i.message).join(' / ')}`);
  return adapted.input;
}

/* ============================================================
 * §A 不提前推进街道（引擎权威）
 * ============================================================ */

test('§A-1 前置状态：转牌面对下注、Hero 未行动 —— 引擎街为 TURN 且本街未结算', () => {
  const s = toTurnFacingBet();
  const engine = engineOf(s);
  assert.equal(engine.street, 'TURN', '引擎街必须是 TURN（转牌）');
  assert.equal(engine.bettingRoundComplete, false, '转牌下注轮尚未结算');
  assert.equal(actorPositionOf(s), 'BTN', '当前轮到 BTN（Hero）行动');
  assert.deepEqual(boardOf(s), ['Kd', '9c', '4h', '6s'], '引擎牌面只有已发生的 4 张');
});

test('§A-2 录入第 5 张公共牌**不推进街道**，且只被记为数据（引擎牌面仍是 4 张）', () => {
  const before = toTurnFacingBet();
  const op = applyTableOp(before, { kind: 'SET_BOARD_CARD', card: 'Qh', slot: 4 });
  assert.equal(op.ok, true, '公共牌录入本身必须被接受（数据录入能力不得被闸门砍掉）');
  if (!op.ok) return;
  const after = op.state;

  const engineBefore = engineOf(before);
  const engineAfter = engineOf(after);

  assert.equal(engineAfter.street, 'TURN', '录牌后引擎街**仍必须是 TURN**：不得提前进入河牌');
  assert.equal(engineAfter.bettingRoundComplete, false, '不得自动结算转牌下注轮');
  assert.equal(actorPositionOf(op.state), 'BTN', '行动者不得被录牌改变');
  assert.deepEqual(boardOf(after), ['Kd', '9c', '4h', '6s'], '引擎权威牌面仍只有 4 张（未来牌不进引擎）');
  assert.equal(after.board.length, 5, '录入的牌仍作为桌面数据保留在第 5 格');
  assert.equal(engineAfter.actions.length, engineBefore.actions.length, '录牌不得自动补写任何行动');
});

test('§A-3 只有**完成转牌行动**才会推进到河牌（唯一合法路径），且绝不凭空发牌', () => {
  // 第 5 张牌已录入、转牌行动未完成 ⇒ 仍停在 TURN
  const pre = toTurnFacingBet('Qh');
  assert.equal(engineOf(pre).street, 'TURN', '未完成转牌行动前必须停在 TURN');

  // 补齐 Hero 的转牌行动 ⇒ 才推进到 RIVER
  const settled = step(pre, callOp(pre));
  assert.equal(engineOf(settled).street, 'RIVER', '转牌行动补齐后街道才推进到 RIVER');
  assert.deepEqual(boardOf(settled), ['Kd', '9c', '4h', '6s', 'Qh'], '牌面保持用户录入的 5 张');

  // 未录第 5 张时完成转牌行动：引擎**不得凭空补一张牌**（牌面只能来自用户录入）
  const onlyFour = toTurnFacingBet();
  const settledFour = step(onlyFour, callOp(onlyFour));
  const entered = ['Kd', '9c', '4h', '6s'];
  assert.deepEqual(
    boardOf(settledFour).filter((c) => !entered.includes(c)),
    [],
    '不得出现用户从未录入的牌（引擎不得凭空发河牌）',
  );
});

test('§A-4 录牌不改变任何玩家的投入 / 底池 / 行动数（不自动跟注、不自动结算）', () => {
  const before = toTurnFacingBet();
  const op = applyTableOp(before, { kind: 'SET_BOARD_CARD', card: 'Qh', slot: 4 });
  assert.equal(op.ok, true);
  if (!op.ok) return;

  const e0 = engineOf(before);
  const e1 = engineOf(op.state);
  const committed = (engine: typeof e0): number[] =>
    engine.players.map((p) =>
      Object.values(p.committedByStreet).reduce((acc, v) => acc + v, 0),
    );

  assert.equal(computePot(e1), computePot(e0), '底池不得因录牌而改变');
  assert.deepEqual(committed(e1), committed(e0), '各玩家投入不得因录牌而改变');
  assert.deepEqual(
    e1.actions.map((a) => `${a.street}:${a.position}:${a.type}`),
    e0.actions.map((a) => `${a.street}:${a.position}:${a.type}`),
    '行动序列不得被录牌篡改或补齐',
  );
});

/* ============================================================
 * §B 先录牌、后补行动（含 Hero 本人历史行动）能力保留
 * ============================================================ */

test('§B-1 「先录满 5 张公共牌 → 补录全部行动」仍然可达河牌（录牌不被拦截）', () => {
  const s = boardFirstThenActions();
  const engine = engineOf(s);
  assert.equal(engine.street, 'RIVER', '补齐行动后必须能够回放到 RIVER（先录牌后补行动契约保持）');
  assert.deepEqual(boardOf(s), ['Kd', '9c', '4h', '6s', 'Qh'], '引擎牌面应包含全部 5 张');
});

test('§B-2 Hero 本人的历史行动同样可以补录（不被拒绝、不变成 CHECK）', () => {
  const s = boardFirstThenActions();
  const engine = engineOf(s);
  const heroActs = engine.actions.filter((a) => a.position === 'BTN');
  assert.ok(heroActs.length >= 2, `Hero 本人的行动必须被记录（实际 ${heroActs.length} 条）`);
  assert.equal(heroActs[0]!.type, 'RAISE', 'Hero 翻前加注必须按真实动作记录为 RAISE');
  assert.equal(
    engine.actions.some((a) => a.type === 'CHECK' && a.street === 'PREFLOP'),
    false,
    '未录入的行动绝不能被当成 CHECK 补齐',
  );
});

/* ============================================================
 * §C 预览不得把未来街说成「正式可分析」
 * ============================================================ */

test('§C-1 转牌未完成时录入第 5 张：预览必须**不再声称就绪**，并说明缺什么', () => {
  const s = toTurnFacingBet('Qh');
  const preview = buildTablePreview(s);

  assert.equal(preview.decision.ready, false, '转牌行动未完成时预览不得 ready');
  assert.equal(preview.decision.state, 'ERROR', '状态必须如实标为不可分析');
  assert.equal(preview.decision.reasonCode, 'STATE_INVALID', '原因码必须指向状态非法');
  assert.equal(preview.canAnalyze, false, 'canAnalyze 必须为 false');
  assert.equal(preview.street, 'TURN', '预览街仍必须是引擎真实街（TURN），不得显示为河牌');
  assert.equal(s.board.length, 5, '已录入的公共牌必须原样保留（不得被清空/回退）');
  assert.equal(preview.boardSelectionInProgress, false, '5 张已录满，不得回退为「选择中」状态');

  const text = preview.analyzeBlockers.join('\n');
  assert.ok(text.includes('河牌'), '提示必须点明「已录入的是河牌」');
  assert.ok(text.includes('转牌'), '提示必须点明「缺的是转牌行动」');
  assert.ok(text.includes('尚未完成'), '提示必须说明当前街行动尚未完成');
  assert.ok(
    preview.analyzeBlockers.some((b) => b.includes('庄家位') || b.includes('Hero') || b.includes('BTN')),
    `提示必须指出是谁欠行动（实际：${text}）`,
  );
});

test('§C-2 预览与管线口径一致：同一局面下 analyzeManualHand 亦拒绝（不得有正式河牌策略/EV）', () => {
  const s = toTurnFacingBet('Qh');
  const result = analyzeManualHand(manualInputOf(s), OPTIONS);
  assert.equal(result.ok, false, '历史不可达时不得产出正式决策');
  if (result.ok) return;
  const why = result.issues.map((i) => i.message).join(' / ');
  assert.ok(
    ['RECONSTRUCT', 'PARSE'].includes(result.stage),
    `拒绝原因必须指向历史不可达（实际 stage=${result.stage}：${why}）`,
  );

  const preview = buildTablePreview(s);
  assert.equal(preview.decision.ready, false, '预览与管线必须同时拒绝，不得一个说可以一个说不行');
});

test('§C-3 闸门不得误伤正常流程：转牌正常决策点（4 张、Hero 待行动）仍然可分析', () => {
  const s = toTurnFacingBet();
  const preview = buildTablePreview(s);
  assert.equal(preview.decision.ready, true, '未录未来牌时，转牌决策点必须照常就绪');
  assert.equal(preview.decision.reasonCode, 'READY', '原因码应为 READY');
  assert.deepEqual([...preview.analyzeBlockers], [], '不得出现任何阻断提示');

  const result = analyzeManualHand(manualInputOf(s), OPTIONS);
  assert.equal(result.ok, true, '该局面必须能产出决策（不得倒退为 RECONSTRUCT）');
  if (!result.ok) return;
  assert.equal(project(result)['street'], 'TURN');
});

/* ============================================================
 * §E 未来信息隔离（V2 §四）
 * ============================================================ */

test('§E-1 预录的第 5 张牌不得进入引擎状态（引擎牌面 / 街 / 行动数均不受影响）', () => {
  const plain = toTurnFacingBet();
  const leaked = toTurnFacingBet('Qh');

  assert.deepEqual(boardOf(leaked), boardOf(plain), '引擎牌面必须与未录第 5 张时完全相同');
  assert.equal(engineOf(leaked).street, engineOf(plain).street, '引擎街必须完全相同');
  assert.deepEqual(
    engineOf(leaked).actions.map((a) => `${a.street}:${a.position}:${a.type}`),
    engineOf(plain).actions.map((a) => `${a.street}:${a.position}:${a.type}`),
    '行动序列必须完全相同',
  );
});

test('§E-2 隔离：转牌计算是引擎状态的纯函数 —— 预录第 5 张牌对转牌权益/EV **零影响**（逐位相同）', () => {
  const plain = toTurnFacingBet();
  const withQh = toTurnFacingBet('Qh');
  const with2c = toTurnFacingBet('2c');

  const engineBoard = boardOf(plain) as string[];

  // 用「引擎已回放到的状态」重建输入：牌面截到已发生的 4 张、街按引擎真实街声明
  const truncated = (s: PokerTableState) => ({ ...manualInputOf(s), board: engineBoard, street: 'TURN' as const });

  const base = project(analyzeManualHand(manualInputOf(plain), OPTIONS));
  const truncQh = project(analyzeManualHand(truncated(withQh) as never, OPTIONS));
  const trunc2c = project(analyzeManualHand(truncated(with2c) as never, OPTIONS));

  assert.equal(base['ok'], true, '基准转牌决策必须成立（否则本隔离测试无效）');
  assert.deepEqual(truncQh, base, '预录 Q♥（与 Hero 听牌相关）不得改变转牌任何数字');
  assert.deepEqual(trunc2c, base, '预录 2♣ 同样不得改变转牌任何数字');
});

test('§E-3 未能完成转牌行动时，**不存在**合法河牌决策节点（不得给出河牌策略/EV）', () => {
  const s = toTurnFacingBet('Qh');
  const input = manualInputOf(s);

  // 适配层会按「录入张数」把街声明为 RIVER —— 这正是必须被拦下的地方
  assert.equal(input.street, 'RIVER', '适配层按录入张数声明街（本测试固定该现状）');
  const result = analyzeManualHand(input, OPTIONS);
  assert.equal(result.ok, false, '历史不可达时不得构建河牌决策节点');
  if (!result.ok) {
    assert.notEqual(project(result)['street'], 'RIVER', '拒绝结果中不得夹带河牌数学');
  }

  const preview = buildTablePreview(s);
  assert.notEqual(preview.street, 'RIVER', '预览街不得显示为 RIVER');
});
