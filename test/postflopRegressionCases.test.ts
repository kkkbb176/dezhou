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

test('TEST 4：🔴 低 SPR 下 AA 面对**压制它的窄范围**必须弃牌（防止用到达范围高估赔率）', () => {
  const { decision, math } = analyze(test4());

  assert.ok(math.spr !== null && math.spr < 1, `前置条件：SPR 必须很低，实际 ${String(math.spr)}`);

  /*
   * 🔴 **契约变更（TEST 09 P0-1，已记录，不是放宽）**
   *
   * # 修复前
   *
   * 本测试断言「低 SPR 下 AA 不得控池式弃牌」，走的是 RAISE / ALL_IN / CALL。
   * 那个结论建立在 `callEV` 用**到达范围**权益之上。
   *
   * # 修复后
   *
   * `callEV` 改用**下注范围**权益。本节点实测：
   *
   * | 量 | 值 |
   * |---|---|
   * | 到达范围权益（**按后验权重**的 EXACT 复算 = 引擎逐位一致） | 37.68% |
   * | 下注范围权益 | 15.37% |
   * | 所需权益（赔率） | 23.39% |
   *
   * ⇒ AA 对自己的**跟注成本**而言是负期望，**弃牌是数学正确**。
   *
   * # 这个结论被独立复核过，不是模型假信号
   *
   * CO 在这里是**冷四注**（UTG 开池 3 → HJ 3bet 10 → CO 4bet 26），
   * 范围极窄（46 组合），且权重集中在压制 AA 的牌上：
   *
   * ```text
   * 打得过 AA 的只有 6 个组合（JJ×3、KK×3），但它们吃掉了主要后验质量
   * ⇒ 等权 EXACT = 81.18%，按后验权重 EXACT = 37.68%
   * ```
   *
   * 「等权算 81%」是**陷阱**：范围不是一个集合，是一份**概率分布**。
   * 本测试因此改为锁**数学正确性**，而不再锁某个固定按钮（用户 §十七）。
   */
  assert.notEqual(
    math.heroEquityVsBetRange,
    null,
    '面对已下注节点必须给出下注范围权益（TEST 09 P0-1）',
  );
  assert.ok(
    math.heroEquityVsBetRange! < math.heroEquity!,
    `下注范围是到达范围的偏价值子集 ⇒ 权益必须更低：` +
      `${(math.heroEquityVsBetRange! * 100).toFixed(2)}% vs ${(math.heroEquity! * 100).toFixed(2)}%`,
  );
  assert.ok(
    math.heroEquityVsBetRange! < math.requiredEquity,
    `本节点的前提：下注范围权益必须**低于**赔率门槛（${(math.heroEquityVsBetRange! * 100).toFixed(2)}% ` +
      `vs ${(math.requiredEquity * 100).toFixed(2)}%）`,
  );
  // 权益低于门槛 ⇒ 动作必须由 EV 排名产生 FOLD，并给出可审计的依据
  assert.equal(decision.action, 'FOLD', `权益低于门槛 ⇒ 必须弃牌，实际 ${String(decision.action)}`);
  assert.ok(
    codesOf(decision).includes('MATH_FOLD_DOMINANT') || codesOf(decision).includes('STRATEGIC_FOLD'),
    `弃牌必须有数学依据，实际理由 ${codesOf(decision).join(',')}`,
  );
  assert.ok(
    (math.callEV ?? 0) < 0,
    `跟注 EV 必须为负（实际 ${math.callEV}）—— 它不是弃牌 EV（≡0）的对手`,
  );
});

test('TEST 4b：🔴 低 SPR 且**权益高于门槛**时，全下必须可达（防止过度保守）', () => {
  /*
   * 这条是 TEST 4 的**正向对照**：把 Hero 换成确实压制该窄范围的手牌
   *（88 = 暗三条，牌面 K-8-4-J 上 CO 的范围里只有 JJ/KK 打得过它），
   * 其余完全不变。此时引擎**必须**能把筹码打进去 —— 否则就真的过度保守了。
   *
   * 这样 TEST 4 / 4b 一起覆盖两个方向：
   * 「权益不够 ⇒ 弃牌」与「权益够 ⇒ 打得进去」，而不是把某一个按钮写死。
   */
  const input = test4() as unknown as Record<string, unknown>;
  const withSet = {
    ...input,
    /* ⚠️ 牌面有 8d ⇒ 只能用 8h/8s/8c 里的两张 */
    heroCards: ['8h', '8s'],
  } as unknown as ManualHandInput;
  const { decision, math, advice } = analyze(withSet);
  const a = advice!;

  assert.ok(math.spr !== null && math.spr < 1, `前置条件：SPR 必须很低，实际 ${String(math.spr)}`);
  assert.equal(a.commitment.stackOffAllowed, true, '低 SPR 下必须允许承诺');
  assert.ok(
    a.commitment.band === 'COMMITTED' || a.commitment.band === 'LOW',
    `SPR 分档必须在可承诺一侧，实际 ${a.commitment.band}`,
  );
  assert.ok(
    math.heroEquityVsBetRange! > math.requiredEquity,
    `对照前提：暗三条的下注范围权益必须高于门槛（${(math.heroEquityVsBetRange! * 100).toFixed(2)}% ` +
      `vs ${(math.requiredEquity * 100).toFixed(2)}%）`,
  );
  assert.ok(
    decision.action === 'RAISE' || decision.action === 'ALL_IN' || decision.action === 'CALL',
    `权益高于门槛时不得控池式弃牌，实际 ${String(decision.action)}`,
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
  /*
   * 🔴 MULTIWAY 阶段修正（**真实冲突，如实记录**）：
   *
   * 旧断言是「跟注站的价值尺寸 ≥ 紧手」。它在**硬切分类**下成立，
   * 但那不是一条稳健的模型性质：分类改为连续混频后，两个尺寸的
   * BetEV 差只有 ~0.4%（268.7 vs 267.6 筹码，同一量级上的平坦面），
   * 谁大谁小由两位小数决定。继续断言方向等于断言噪声。
   *
   * 因此保留**可稳健检验**的两条：
   * ① 画像必须真的改变尺寸（两者不得逐位相同）；
   * ② 面对跟注站时「被跟注后的权益」必须更高（他用的是一手更差的牌跟）——
   *    这条才是「跟注站 ⇒ 更愿意下大注取值」背后的机制。
   * 方向性结论（哪个尺寸更大）留给报告与后续的 EV 面审计，不在测试里假装确定。
   */
  assert.notEqual(
    station.decision.sizeChips,
    nit.decision.sizeChips,
    `画像必须真的改变尺寸选择：${String(station.decision.sizeChips)} vs ${String(nit.decision.sizeChips)}`,
  );
  const eqCallOf = (run: (typeof station)): number | null =>
    (run.advice!.betDecision?.sizes.find((x) => x.kind === 'BET_MEDIUM')?.heroEquityVsCallRange ?? null);
  const eqStation = eqCallOf(station);
  const eqNit = eqCallOf(nit);
  assert.notEqual(eqStation, null);
  assert.notEqual(eqNit, null);
  assert.ok(
    (eqStation as number) > (eqNit as number),
    `跟注站的跟注范围更弱 ⇒ 被跟注时我的权益必须更高：${String(eqStation)} vs ${String(eqNit)}`,
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

  /*
   * 🔴 **契约升级（P0 架构修复，2026-09）—— 不是放宽断言，而是换到更强的那条链上。**
   *
   * 旧版这里断言 `exploit.bluffCatchDelta > 0` / `< 0`：
   * 画像**只能**通过剥削层的偏好分表达「他爱不爱诈唬」。
   *
   * 修复后画像**先进入范围**（`posterior ∝ prior × likelihood × profile`），
   * 于是「他的下注范围里有多少空气」已经由 **范围 → 权益 → Call EV** 表达。
   * 若再调 `bluffCatchDelta`，同一份证据就被计了两遍 ——
   * 使用者明确禁止（no double counting），因此该偏移被**显式记 0 并标注**。
   *
   * 新断言比旧断言更强：它要求的不是「某个中间量动了」，
   * 而是「**权益本身**按画像方向移动了」，并且去重是可见的。
   */
  const bEvidence = bluffer.decision.diagnostics.profileRange ?? null;
  const hEvidence = honest.decision.diagnostics.profileRange ?? null;

  assert.ok(bEvidence !== null && hEvidence !== null, '画像证据必须存在（画像已进入范围）');
  assert.equal(bEvidence!.provider.applied, true, '过度诈唬画像必须真的改变范围形状');
  assert.equal(hEvidence!.provider.applied, true, '不诈唬型画像必须真的改变范围形状');

  const bDelta = bEvidence!.equityAfter! - bEvidence!.equityBefore!;
  const hDelta = hEvidence!.equityAfter! - hEvidence!.equityBefore!;
  assert.ok(bDelta > 0, `过度诈唬必须**抬高** Hero 权益（空气占比上升），实际 Δ${bDelta.toFixed(4)}`);
  assert.ok(hDelta < 0, `不诈唬型必须**压低** Hero 权益（空气占比下降），实际 Δ${hDelta.toFixed(4)}`);

  // 去重必须显式可见：偏移记 0，且理由里写明原因（绝不静默）
  assert.equal(b.exploit.bluffCatchDelta, 0, '画像已进入范围 ⇒ 抓诈唬偏移必须记 0（不重复计票）');
  assert.equal(h.exploit.bluffCatchDelta, 0, '同上');
  assert.equal(b.exploit.deDuplicated, true, '去重必须标出来');
  assert.ok(
    b.reasonsZh.some((t) => t.includes('去重')),
    '理由里必须说明「抓诈唬偏移已去重」',
  );

  // 偏移必须受上限约束（不能翻盘硬数学）；去重后的 0 也满足这条
  for (const delta of [b.exploit.bluffCatchDelta, h.exploit.bluffCatchDelta, b.exploit.thinValueDelta]) {
    assert.ok(Math.abs(delta) <= 0.12 + 1e-9, `画像偏移必须受限，实际 ${delta}`);
  }
});
