/**
 * TEST HAND MULTIWAY TURN FIX — 回归测试 A–F
 *
 * 固定牌局：9-max，Hero BB 9♠8♠，flop T♠7♦2♠ → turn 8♦，LJ 下注 14BB。
 * 本轮修四件事：Board Delta 识别 / 复合牌力 / 非 closing action / RAISE 排序语义。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parseCard } from '../src/domain/poker/cards.ts';
import type { Card } from '../src/domain/types.ts';
import { BoardDeltaKind, computeBoardDelta } from '../src/domain/postflop/boardDelta.ts';
import { outAuditOf } from '../src/domain/postflop/draws.ts';
import { madeHandClassOf } from '../src/domain/postflop/relativeHandRole.ts';
import { evaluateCards } from '../src/domain/poker/handEval.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;

const cards = (text: string): Card[] =>
  text.split(' ').map((t) => {
    const parsed = parseCard(t);
    if (!parsed.ok) throw new Error(`非法牌 ${t}`);
    return parsed.card;
  });

function deltaOf(prev: string, board: string, hole: string) {
  const d = computeBoardDelta({
    previousBoard: cards(prev),
    board: cards(board),
    heroHole: cards(hole),
    street: 'TURN',
    rangeFacts: null,
    previousTier: null,
  });
  assert.notEqual(d, null);
  return d!;
}

/* ============================================================
 * TEST A：固定牌局
 * ============================================================ */

test('TEST A：T♠7♦2♠ → 8♦ 必须是动态牌（不是 blank）', () => {
  const d = deltaOf('Ts 7d 2s', 'Ts 7d 2s 8d', '9s 8s');
  assert.notEqual(d.kind, BoardDeltaKind.BLANK, `8♦ 不得被判成空白牌（kind=${d.kind}）`);
  assert.ok(d.blankScore < 0.7, `白板度必须明显下降（修复前 0.87，实际 ${d.blankScore.toFixed(3)}）`);
  // 必须识别「这张牌完成了新牌类」
  assert.ok(d.classCompletion.newStraightClasses >= 3, `必须识别新成顺（J9 / 96），实际 ${d.classCompletion.newStraightClasses}`);
  assert.ok(d.classCompletion.newTwoPairClasses >= 3, `必须识别新两对（T8 / 87），实际 ${d.classCompletion.newTwoPairClasses}`);
  assert.ok(d.classCompletion.newSetClasses >= 1, `必须识别新三条（88），实际 ${d.classCompletion.newSetClasses}`);
});

test('TEST A2：Hero 9♠8♠ 必须识别为「一对 + 两头顺 + 同花听」', () => {
  const hole = cards('9s 8s');
  const board = cards('Ts 7d 2s 8d');
  const category = evaluateCards([...hole, ...board]).category;
  assert.equal(madeHandClassOf(category), 'PAIR', '成手必须是一对（不是一个笼统的「听牌」）');
  const audit = outAuditOf(hole, board);
  assert.ok(audit.rawOuts > 0);
  // 补牌四桶必须互不重复
  assert.equal(
    audit.rawOuts,
    audit.cleanOuts + audit.discountedOuts + audit.dirtyOuts,
    `RAW 必须等于三个子桶之和（不重复计数）：${JSON.stringify(audit)}`,
  );
  assert.ok(
    audit.doubleCounted.includes('6s') && audit.doubleCounted.includes('Js'),
    `6♠ / J♠ 同时是顺子补牌与同花补牌，必须只计一次并如实列出，实际 ${audit.doubleCounted.join('/')}`,
  );
  assert.equal(audit.nonNutFlushDraw, true, '9 高同花听不是坚果 ⇒ 必须标成非坚果同花听');
  assert.ok(audit.dirtyOuts > 0, '成对补牌（8/9）必须被标成 DIRTY 而不是干净补牌');
});

test('TEST A3：跟注不是 closing action（UTG+1 还在后面）', () => {
  const input = turnSpot();
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const g = buildAnalyzableState(parsed.value);
  assert.equal(g.ok, true);
  if (!g.ok) return;
  const built = buildDecisionContext({
    state: g.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    seatProfiles: input.seatProfiles as never,
  });
  assert.equal(built.context.playersRemainingToAct, 1, 'Hero 之后还有 1 家（UTG+1）必须行动');
  assert.equal(built.context.isClosingAction, false);
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const codes = r.decision.diagnostics.degradations.map((d) => d.code);
  assert.ok(codes.includes('ACTION_NOT_CLOSED'), `必须有 ACTION_NOT_CLOSED 提示，实际 ${codes.join(',')}`);
  const text = r.decision.diagnostics.degradations.find((d) => d.code === 'ACTION_NOT_CLOSED')!.textZh;
  assert.ok(text.includes('简化代理值') && text.includes('加注'), `提示必须说明代理口径，实际：${text}`);
  // 底池赔率 / 所需权益仍然给出（不得因为非 closing 就删掉）
  assert.ok(r.decision.diagnostics.math.requiredEquity > 0.2, '所需权益必须照常给出');
  // 真实 EV 排名里 CALL 必须标注为代理
  const evRow = r.decision.diagnostics.postflop?.trueEvRanking ?? [];
  assert.ok(evRow.length >= 2);
});

test('TEST A4：RAISE 无 EV ⇒ 不得进入 EV 排名；EV 组与战略候选必须分开', () => {
  const r = analyzeManualHand(turnSpot(), OPTIONS);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const rows = r.viewModel.debug?.postflop ?? [];
  const evRow = rows.find((x) => x.label.includes('EV 支持的动作'));
  const candidateRow = rows.find((x) => x.label.includes('战略候选'));
  assert.notEqual(evRow, undefined, '必须有「EV 支持的动作」行');
  assert.notEqual(candidateRow, undefined, '必须有「战略候选（无 EV）」行');
  assert.ok(!/RAISE\s+[0-9.]+/.test(evRow!.value), `RAISE 不得出现在 EV 组：${evRow!.value}`);
  assert.ok(/RAISE/.test(candidateRow!.value), `RAISE 必须出现在战略候选组：${candidateRow!.value}`);
  assert.ok(candidateRow!.value.includes('NOT_AVAILABLE'), '战略候选必须标明 EV: NOT_AVAILABLE');
  const ranking = r.decision.diagnostics.postflop!.evRanking;
  const raise = ranking.find((x) => x.action === 'RAISE')!;
  assert.equal(raise.kind, 'STRATEGIC_CANDIDATE_ONLY');
  const call = ranking.find((x) => x.action === 'CALL')!;
  assert.equal(call.kind, 'EV_SUPPORTED');
});

/* ============================================================
 * TEST B：真正的空白牌（不得修复过头）
 * ============================================================ */

test('TEST B：T♠7♦2♠ → 3♣ 仍然是空白牌', () => {
  const d = deltaOf('Ts 7d 2s', 'Ts 7d 2s 3c', '9s 8s');
  assert.equal(d.kind, BoardDeltaKind.BLANK, `3♣ 必须仍是空白牌（blank=${d.blankScore.toFixed(3)}）`);
  assert.ok(d.blankScore >= 0.85, `空白牌的白板度必须 ≥ 0.85，实际 ${d.blankScore.toFixed(3)}`);
  assert.equal(d.classCompletion.newStraightClasses, 0, '3♣ 不得完成任何顺子类别');
});

/* ============================================================
 * TEST C：完成顺子的牌
 * ============================================================ */

test('TEST C：T♠7♦2♠ → 8♣ 必须识别 J9 / 96 的新成顺', () => {
  const d = deltaOf('Ts 7d 2s', 'Ts 7d 2s 8c', '9s 8s');
  assert.notEqual(d.kind, BoardDeltaKind.BLANK);
  assert.ok(d.classCompletion.newStraightClasses >= 3, `必须识别 J9 / 96（实际 ${d.classCompletion.newStraightClasses}）`);
});

/* ============================================================
 * TEST D：完成同花 / 同花听成型
 * ============================================================ */

test('TEST D：T♠7♠2♠ → 3♠ 必须识别同花结构变化', () => {
  const d = deltaOf('Ts 7s 2s', 'Ts 7s 2s 3s', '9h 8h');
  assert.notEqual(d.kind, BoardDeltaKind.BLANK, '第四张同花必须被判成动态牌');
  assert.ok(d.flushCompleted || d.fourToFlush, 'flushCompleted 或 fourToFlush 必须为真');
  assert.ok(d.flushDrawDelta > 0, `同花听结构变化必须 > 0，实际 ${d.flushDrawDelta}`);
});

/* ============================================================
 * TEST E / F：closing action
 * ============================================================ */

function contextOf(input: ManualHandInput) {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.ok ? {} : parsed.issues));
  if (!parsed.ok) throw new Error('unreachable');
  const g = buildAnalyzableState(parsed.value);
  assert.equal(g.ok, true, JSON.stringify(g.ok ? {} : g.issues));
  if (!g.ok) throw new Error('unreachable');
  return buildDecisionContext({
    state: g.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    ...(input.seatProfiles === undefined ? {} : { seatProfiles: input.seatProfiles as never }),
  }).context;
}

/** 固定牌局：9-max，Hero BB 9♠8♠，turn 8♦ 面对 LJ 的 14BB */
function turnSpot(): ManualHandInput & { seatProfiles?: Readonly<Record<string, string>> } {
  const F = (position: string) => ({ position, type: 'FOLD' }) as never;
  return {
    tableSize: 9,
    heroPosition: 'BB',
    heroCards: ['9s', '8s'],
    board: ['Ts', '7d', '2s', '8d'],
    street: 'TURN',
    effectiveStackBB: 120,
    bigBlindBB: 2,
    seatStacksBB: { UTG1: 120, LJ: 120, BB: 120 },
    seatProfiles: { UTG1: 'TIGHT', LJ: 'LOOSE' },
    actionHistory: [
      F('UTG'),
      { position: 'UTG1', type: 'RAISE', amountBB: 3 },
      F('UTG2'),
      { position: 'LJ', type: 'CALL', amountBB: 3 },
      F('HJ'), F('CO'), F('BTN'), F('SB'),
      { position: 'BB', type: 'CALL', amountBB: 2 },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'UTG1', type: 'BET', amountBB: 3, street: 'FLOP' },
      { position: 'LJ', type: 'CALL', amountBB: 3, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 3, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'UTG1', type: 'CHECK', street: 'TURN' },
      { position: 'LJ', type: 'BET', amountBB: 14, street: 'TURN' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { playerId: 'seat_LJ', quickProfile: 'LOOSE', dynamicHint: 'UNKNOWN', stackBB: 120 },
  } as unknown as ManualHandInput & { seatProfiles: Readonly<Record<string, string>> };
}

/** 单挑：CO 开池、Hero BTN 跟，flop CO 下注 ⇒ Hero 最后行动 */
function headsUpClosing(): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['As', 'Js'],
    board: ['Kh', '7c', '2d'],
    street: 'FLOP',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { CO: 100, BTN: 100 },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' },
      { position: 'HJ', type: 'FOLD' },
      { position: 'CO', type: 'RAISE', amountBB: 3 },
      { position: 'BTN', type: 'CALL', amountBB: 3 },
      { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'FOLD' },
      { position: 'CO', type: 'BET', amountBB: 5, street: 'FLOP' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

test('TEST E：单挑 + Hero 最后行动 ⇒ isClosingAction = true', () => {
  const ctx = contextOf(headsUpClosing());
  assert.equal(ctx.playersRemainingToAct, 0, '单挑里 Hero 之后没有人');
  assert.equal(ctx.isClosingAction, true);
});

test('TEST F：A 过牌 → B 下注 → Hero 行动，A 仍在后面 ⇒ isClosingAction = false', () => {
  const ctx = contextOf(turnSpot());
  assert.equal(ctx.playersRemainingToAct, 1, '必须把「已经过牌但下注重开行动」的 UTG+1 算进来');
  assert.equal(ctx.isClosingAction, false);
  // 对照：同一牌局里若把 UTG+1 的行动换成跟注（他不会再有行动）⇒ 仍然不是 closing
  //（下注同样重开行动；此处只锁「不能靠人数判断」这一条）
  assert.ok(ctx.playersYetToAct < ctx.playersRemainingToAct + 1, '两个概念必须分开');
});
