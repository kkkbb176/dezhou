/**
 * 翻后升级 · P4：六个回归用例（2026-09）
 *
 * ## 这一组锁什么
 *
 * 使用者点名的六个实战局面。**不锁具体数值**（那会把启发式标尺固化成答案），
 * 而是锁**方向与机制**：
 *
 * | 用例 | 要防止的错误 |
 * |---|---|
 * | TEST 1 | 危险河牌上把一对 J 当成标准 50% 底池价值下注 |
 * | TEST 2 | 对手连跟两街后，河牌仍无理由开第三枪 |
 * | TEST 3 | 三人池转牌高张、面对下注时不肯弃牌 |
 * | TEST 4 | **过度保守**：低 SPR 下用一对机械控池，不敢全下 |
 * | TEST 5 | 守门器把**所有**薄价值都 check 掉（跟注站面前不敢取值） |
 * | TEST 6 | 永久 overfold：面对过度诈唬的对手不敢跟注 |
 *
 * ⚠️ 每个用例都对照「同一局面下的另一种输入」来断言**相对**行为 ——
 * 这样即便以后调参，只要方向还对，测试仍然有效。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { advisePostflop } from '../src/app/decision/postflopAdvisor.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const F = (position: string) => ({ position, type: 'FOLD' as const });

/** 跑真实管线并取出建议器的输出 */
function analyze(input: ManualHandInput) {
  const result = analyzeManualHand(input, OPTIONS);
  assert.equal(result.ok, true, `必须能分析：${result.ok ? '' : JSON.stringify(result.issues)}`);
  if (!result.ok) throw new Error('unreachable');

  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, `门槛必须放行：${gate.ok ? '' : JSON.stringify(gate.issues)}`);
  if (!gate.ok) throw new Error('unreachable');
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    ...(input.villain?.quickProfile === undefined ? {} : { quickProfile: input.villain.quickProfile }),
  });
  const hero = gate.state.players.find((p) => p.holeCards !== null)!;
  const legal = deriveLegalActions(gate.state, hero);
  const advice = advisePostflop(built.context, {
    facingBet: legal.callCost > 0,
    requiredEquity: built.context.math.requiredEquity,
    potAfterCall: built.context.math.pot + legal.callCost,
  });
  return { decision: result.decision, math: built.context.math, advice };
}

const codesOf = (r: { reasons: readonly { code: string }[] }) => r.reasons.map((x) => x.code);

/* ============================================================
 * TEST 1：河牌三梅花，一对 J —— 不得无理由价值下注
 * ============================================================ */

function test1(): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'CO', heroCards: ['As', 'Js'],
    board: ['Jd', '9c', '6c', '2s', 'Tc'], street: 'RIVER',
    effectiveStackBB: 100, seatStacksBB: { UTG: 100, CO: 100, BB: 100 },
    actionHistory: [
      { position: 'UTG', type: 'CALL', amountBB: 1 }, F('UTG1'), F('UTG2'), F('LJ'), F('HJ'),
      { position: 'CO', type: 'CALL', amountBB: 1 }, F('BTN'), F('SB'), { position: 'BB', type: 'CHECK' },
      { position: 'BB', type: 'BET', amountBB: 3, street: 'FLOP' }, { position: 'UTG', type: 'FOLD', street: 'FLOP' },
      { position: 'CO', type: 'CALL', amountBB: 3, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' }, { position: 'CO', type: 'BET', amountBB: 8, street: 'TURN' },
      { position: 'BB', type: 'CALL', amountBB: 8, street: 'TURN' }, { position: 'BB', type: 'CHECK', street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

test('TEST 1：河牌同花面上一对 J —— 必须倾向过牌，且明确说明为何不是价值下注', () => {
  const { decision, advice } = analyze(test1());
  assert.notEqual(advice, null, '翻后必须有建议器输出');
  const a = advice!;

  // 角色必须降级（不是强价值），且牌面变化必须被识别
  assert.ok(
    a.role === 'THIN_VALUE' || a.role === 'SHOWDOWN_VALUE' || a.role === 'BLUFF_CATCHER',
    `一对 J 在该牌面上不得被判成强价值，实际 ${a.role}`,
  );
  assert.equal(a.boardDelta?.flushCompleted, true, '必须识别「这张牌让同花成为可能」');

  // 守门器必须给出「不推荐下注」，且**过牌分高于下注分**
  assert.ok(
    a.gate.estimatedCheckEVScore > a.gate.estimatedBetEVScore,
    `过牌分必须更高：check ${a.gate.estimatedCheckEVScore.toFixed(3)} vs bet ${a.gate.estimatedBetEVScore.toFixed(3)}`,
  );
  assert.ok(
    a.gate.verdict === 'NOT_VALUE' || a.gate.verdict === 'PREFER_CHECK' || a.gate.verdict === 'MARGINAL',
    `verdict 必须是「不推荐下注」一侧，实际 ${a.gate.verdict}`,
  );

  // 动作层：不得是 BET；且理由里必须出现牌面变化
  assert.notEqual(decision.action, 'BET', `危险河牌上不得价值下注，实际 ${String(decision.action)}`);
  assert.ok(
    a.reasonsZh.some((t) => t.includes('同花成为可能')),
    '理由必须点明牌面变化',
  );
});

/* ============================================================
 * TEST 2：3bet 池，对手连跟两街 —— 河牌不得开第三枪
 * ============================================================ */

function test2(): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'SB', heroCards: ['Kd', 'Qd'],
    board: ['Qc', '7s', '4d', 'Ac', '8h'], street: 'RIVER',
    effectiveStackBB: 100, seatStacksBB: { UTG: 100, SB: 100, BB: 100 },
    actionHistory: [
      { position: 'UTG', type: 'RAISE', amountBB: 3 }, F('UTG1'), F('UTG2'), F('LJ'), F('HJ'), F('CO'), F('BTN'),
      { position: 'SB', type: 'RAISE', amountBB: 10 }, F('BB'), { position: 'UTG', type: 'CALL', amountBB: 7 },
      { position: 'SB', type: 'BET', amountBB: 12, street: 'FLOP' },
      { position: 'UTG', type: 'CALL', amountBB: 12, street: 'FLOP' },
      { position: 'SB', type: 'BET', amountBB: 28, street: 'TURN' },
      { position: 'UTG', type: 'CALL', amountBB: 28, street: 'TURN' },
    ],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

test('TEST 2：对手连跟两街 ⇒ 河牌 KQ 必须降级、且不得无理由开第三枪', () => {
  const { decision, math, advice } = analyze(test2());
  const a = advice!;

  // 对手连跟两街之后范围必须被压缩（权益显著低于「宽范围」的乐观值）
  assert.ok(
    math.heroEquity !== null && math.heroEquity < 0.5,
    `对手连跟两街后我方权益必须明显下降，实际 ${math.heroEquity === null ? '—' : (math.heroEquity * 100).toFixed(1) + '%'}`,
  );
  assert.ok(
    a.role === 'SHOWDOWN_VALUE' || a.role === 'THIN_VALUE' || a.role === 'BLUFF_CATCHER' || a.role === 'AIR',
    `KQ 必须从强价值降级，实际 ${a.role}`,
  );

  // 空白河牌**不得**把角色恢复成强价值（使用者点名的禁令）
  assert.ok(
    a.reasonsZh.some((t) => t.includes('不因此恢复牌力')),
    '空白河牌的理由里必须写明「不因此恢复牌力」',
  );
  assert.notEqual(decision.action, 'BET', `不得开第三枪，实际 ${String(decision.action)}`);
});

/* ============================================================
 * TEST 3：三人 3bet 池，TT 面对转牌 A 的下注 —— 弃牌必须是合理高权重动作
 * ============================================================ */

function test3(): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BB', heroCards: ['Ts', 'Td'],
    board: ['9c', '6d', '3s', 'Ah'], street: 'TURN',
    effectiveStackBB: 100, seatStacksBB: { UTG: 100, CO: 100, BB: 100 },
    actionHistory: [
      { position: 'UTG', type: 'RAISE', amountBB: 3 }, F('UTG1'), F('UTG2'), F('LJ'), F('HJ'),
      { position: 'CO', type: 'RAISE', amountBB: 9 }, F('BTN'), F('SB'),
      { position: 'BB', type: 'CALL', amountBB: 8 }, { position: 'UTG', type: 'CALL', amountBB: 6 },
      { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'UTG', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 12, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 12, street: 'FLOP' },
      { position: 'UTG', type: 'CALL', amountBB: 12, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' }, { position: 'UTG', type: 'CHECK', street: 'TURN' },
      { position: 'CO', type: 'BET', amountBB: 20, street: 'TURN' },
    ],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

test('TEST 3：三人池 + 转牌高张 + 面对下注 ⇒ 弃牌必须是最高分动作，且多人惩罚生效', () => {
  const { decision, advice } = analyze(test3());
  const a = advice!;

  assert.ok(a.multiway.multiwayStrengthPenalty > 0, '三人池必须有强度惩罚');
  assert.ok(
    a.multiway.multiwayBluffPenalty > a.multiway.multiwayStrengthPenalty,
    '诈唬惩罚必须比强度惩罚更陡',
  );

  const sorted = [...a.scores].sort((x, y) => y.normalizedEVScore - x.normalizedEVScore);
  assert.equal(sorted[0]!.action, 'FOLD', `弃牌必须是最高分动作，实际 ${sorted[0]!.action}`);
  assert.equal(decision.action, 'FOLD', `引擎必须判弃牌，实际 ${String(decision.action)}`);
  assert.ok(
    codesOf(decision).includes('MATH_FOLD_DOMINANT'),
    '必须是明确的负期望弃牌（而不是靠边缘判断）',
  );
});

/* ============================================================
 * TEST 4：低 SPR 的 AA —— 不得机械控池，全下必须可达
 * ============================================================ */

function test4(): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'HJ', heroCards: ['Ac', 'Ad'],
    board: ['Ks', '8d', '4c', 'Jc'], street: 'TURN',
    effectiveStackBB: 200, seatStacksBB: { UTG: 200, HJ: 200, CO: 200 },
    actionHistory: [
      { position: 'UTG', type: 'RAISE', amountBB: 3 }, F('UTG1'), F('UTG2'), F('LJ'),
      { position: 'HJ', type: 'RAISE', amountBB: 10 }, { position: 'CO', type: 'RAISE', amountBB: 26 },
      F('BTN'), F('SB'), F('BB'), { position: 'UTG', type: 'FOLD' },
      { position: 'HJ', type: 'CALL', amountBB: 16 },
      { position: 'HJ', type: 'CHECK', street: 'FLOP' }, { position: 'CO', type: 'BET', amountBB: 40, street: 'FLOP' },
      { position: 'HJ', type: 'CALL', amountBB: 40, street: 'FLOP' },
      { position: 'HJ', type: 'CHECK', street: 'TURN' }, { position: 'CO', type: 'BET', amountBB: 60, street: 'TURN' },
    ],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

test('TEST 4：🔴 低 SPR 下 AA 必须能全下（防止本轮改动导致过度保守）', () => {
  const { decision, math, advice } = analyze(test4());
  const a = advice!;

  assert.ok(math.spr !== null && math.spr < 1, `前置条件：SPR 必须很低，实际 ${String(math.spr)}`);
  assert.equal(a.commitment.stackOffAllowed, true, '低 SPR 下必须允许承诺');
  assert.ok(
    a.commitment.band === 'COMMITTED' || a.commitment.band === 'LOW',
    `SPR 分档必须在可承诺一侧，实际 ${a.commitment.band}`,
  );

  /*
   * 核心断言：**不得**只判跟注。允许 RAISE / ALL_IN / CALL 里任一，
   * 但必须至少存在一个「把筹码打进去」的动作 —— 且尺寸接近全下。
   */
  assert.ok(
    decision.action === 'RAISE' || decision.action === 'ALL_IN' || decision.action === 'CALL',
    `不得出现控池式的弃牌，实际 ${String(decision.action)}`,
  );
  assert.ok(
    codesOf(decision).includes('STRATEGIC_RAISE_FOR_VALUE') || decision.action === 'ALL_IN',
    `低 SPR 下必须能加注/全下（修复前一对牌永远不能加注），实际动作 ${String(decision.action)}，` +
      `理由 ${codesOf(decision).join(',')}`,
  );
  assert.ok(
    (decision.sizeChips ?? 0) >= math.myRemainingStack * 0.9,
    `尺寸必须接近全下（把筹码打进去），实际 ${String(decision.sizeChips)} / 剩余 ${math.myRemainingStack}`,
  );
});

/* ============================================================
 * TEST 5：跟注站 —— 薄价值必须被保留（不得被守门器全部 check 掉）
 * ============================================================ */

function stationSpot(profile: string): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BTN', heroCards: ['Kd', 'Th'],
    board: ['Ts', '7c', '3h'], street: 'FLOP',
    effectiveStackBB: 100, seatStacksBB: { UTG: 100, BTN: 100, BB: 100 },
    actionHistory: [
      { position: 'UTG', type: 'CALL', amountBB: 1 }, F('UTG1'), F('UTG2'), F('LJ'), F('HJ'), F('CO'),
      { position: 'BTN', type: 'CALL', amountBB: 1 }, F('SB'), { position: 'BB', type: 'CHECK' },
      { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'UTG', type: 'CHECK', street: 'FLOP' },
    ],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: profile, dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

test('TEST 5：🔴 跟注站面前薄价值必须提高（下注分上升 + 尺寸放大），紧手面前收紧', () => {
  const station = analyze(stationSpot('CALLING_STATION'));
  const nit = analyze(stationSpot('VERY_TIGHT'));
  const s = station.advice!;
  const n = nit.advice!;

  // 薄价值必须真的能下注（原规则靠 equity>0.55；守门器不得把它 check 掉）
  assert.ok(
    s.gate.estimatedBetEVScore > s.gate.estimatedCheckEVScore,
    `跟注站局面下下注分必须高于过牌分：bet ${s.gate.estimatedBetEVScore.toFixed(3)} vs check ${s.gate.estimatedCheckEVScore.toFixed(3)}`,
  );
  assert.equal(station.decision.action, 'BET', `跟注站局面必须取值下注，实际 ${String(station.decision.action)}`);

  // 画像必须**真的**影响分数与尺寸（修复前两者逐位相同）
  assert.ok(
    s.gate.estimatedBetEVScore > n.gate.estimatedBetEVScore,
    `跟注站的下注分必须高于紧手：${s.gate.estimatedBetEVScore.toFixed(3)} vs ${n.gate.estimatedBetEVScore.toFixed(3)}`,
  );
  assert.ok(
    (station.decision.sizeChips ?? 0) >= (nit.decision.sizeChips ?? 0),
    `跟注站的价值尺寸不得小于紧手：${String(station.decision.sizeChips)} vs ${String(nit.decision.sizeChips)}`,
  );
  assert.ok(
    s.reasonsZh.some((t) => t.includes('跟注站')),
    '理由里必须写明画像来源',
  );
});

/* ============================================================
 * TEST 6：过度诈唬 —— 抓诈唬跟注必须提高（防止永久 overfold）
 * ============================================================ */

/** 河牌：Hero 一对 9（抓诈唬），面对 40% 池的下注 —— 权益恰在门槛附近的边缘局面 */
function bluffCatchSpot(profile: string): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BB', heroCards: ['Ah', '9h'],
    board: ['Kc', '9s', '5d', '2h', '7c'], street: 'RIVER',
    effectiveStackBB: 100, seatStacksBB: { UTG: 100, BB: 100 },
    actionHistory: [
      { position: 'UTG', type: 'RAISE', amountBB: 3 }, F('UTG1'), F('UTG2'), F('LJ'), F('HJ'), F('CO'), F('BTN'), F('SB'),
      { position: 'BB', type: 'CALL', amountBB: 2 },
      { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'UTG', type: 'BET', amountBB: 5, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 5, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' }, { position: 'UTG', type: 'CHECK', street: 'TURN' },
      { position: 'BB', type: 'CHECK', street: 'RIVER' }, { position: 'UTG', type: 'BET', amountBB: 8, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: profile, dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

test('TEST 6：🔴 面对过度诈唬的对手，抓诈唬跟注必须提高（且不诈唬型必须更低）', () => {
  const bluffer = analyze(bluffCatchSpot('BLUFF_HEAVY'));
  const honest = analyze(bluffCatchSpot('UNDERBLUFFER'));
  const b = bluffer.advice!;
  const h = honest.advice!;

  const callScoreOf = (scores: readonly { action: string; normalizedEVScore: number }[]): number =>
    scores.find((s) => s.action === 'CALL')?.normalizedEVScore ?? 0;

  assert.ok(
    callScoreOf(b.scores) > callScoreOf(h.scores),
    `过度诈唬的跟注分必须更高：${callScoreOf(b.scores).toFixed(3)} vs ${callScoreOf(h.scores).toFixed(3)}`,
  );
  assert.ok(
    b.exploit.bluffCatchDelta > 0,
    `过度诈唬的抓诈唬偏移必须为正，实际 ${b.exploit.bluffCatchDelta}`,
  );
  assert.ok(
    h.exploit.bluffCatchDelta < 0,
    `不诈唬型的抓诈唬偏移必须为负，实际 ${h.exploit.bluffCatchDelta}`,
  );
  // 偏移必须受上限约束（不能翻盘硬数学）
  for (const delta of [b.exploit.bluffCatchDelta, h.exploit.bluffCatchDelta, b.exploit.thinValueDelta]) {
    assert.ok(Math.abs(delta) <= 0.12 + 1e-9, `画像偏移必须受限，实际 ${delta}`);
  }
});
