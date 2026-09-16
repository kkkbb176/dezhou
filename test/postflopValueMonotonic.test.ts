/**
 * 翻后价值判断的**单调性 / 口径**回归锁（2026-09 翻后升级 · P4）
 *
 * 这一组锁的是第二轮对抗性审计（Murphy，只读探针）在**真实管线**上抓到的
 * 两个 CRITICAL 与两个 MAJOR。它们的共同根因不是「参数不好」，
 * 而是**口径错了** —— 用「对手范围整体有多强」冒充了「相对于我这手牌」的问题。
 *
 * | 编号 | 审计发现 | 修复前实测 | 本文件 |
 * |---|---|---|---|
 * | **F-1** | 坚果级牌力拒不下注 | 坚果同花（权益 94.7%）⇒ bet 0.2300 vs check 0.6125、`NOT_VALUE`、引擎过牌 | NUT-1 / NUT-2 |
 * | **F-2** | 下注分对牌力**非单调** | bet(最小同花 0.8800) = 0.2806 > bet(坚果同花 0.9471) = 0.2300；三条 K（0.8297）也更高 | NUT-1 / NUT-3 / GATE-MONO-1/2 |
 * | **F-4** | 换街（含空白河牌）价值无理由下降 | 转牌 bet 0.3092 `CLEAR_VALUE` ⇒ 白板河牌 0.0273 `NOT_VALUE` | RIVER-1 |
 * | **F-5** | 河牌仍能拿到保护分 | 湿面保护分可翻转薄价值判定（与 0.06 判定阈值同量级） | RIVER-2 |
 *
 * ⚠️ 断言的是**方向与单调性**（谁必须比谁高 / 什么必须为 0），不是某个魔法数字。
 * 因此它们不会把当前的启发式数值固化成「正确答案」，但能在口径再次错位时立刻失败。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { assessValueBet } from '../src/domain/postflop/valueBetGate.ts';
import { advisePostflop } from '../src/app/decision/postflopAdvisor.ts';
import { compressionStateOf } from '../src/domain/postflop/rangeCompression.ts';
import { chooseSizing, SIZING_GRID } from '../src/domain/postflop/sizing.ts';
import { RelativeHandRole } from '../src/domain/postflop/types.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import type { OpponentRangeFacts } from '../src/domain/postflop/types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const F = (position: string) => ({ position, type: 'FOLD' as const });

/* ============================================================
 * 一、真实管线：成对 + 成花牌面，对手三条街全过牌
 * ============================================================ */

const CLAIM_BOARD = ['Ks', 'Kd', '6c', '2c', '9c'] as const;

/**
 * Hero BTN，UTG 翻前加注后**三条街全过牌**（最典型的「他示弱」线路）。
 * 这是审计实测出 F-1 / F-2 的**原始局面**，原样复现。
 */
function checkdownSpot(hero: readonly [string, string]): ManualHandInput {
  return {
    tableSize: 9,
    heroPosition: 'BTN',
    heroCards: [hero[0], hero[1]],
    board: [...CLAIM_BOARD],
    street: 'RIVER',
    effectiveStackBB: 100,
    seatStacksBB: { UTG: 100, BTN: 100 },
    actionHistory: [
      { position: 'UTG', type: 'RAISE', amountBB: 3 },
      F('UTG1'), F('UTG2'), F('LJ'), F('HJ'), F('CO'),
      { position: 'BTN', type: 'CALL', amountBB: 3 },
      F('SB'), F('BB'),
      { position: 'UTG', type: 'CHECK', street: 'FLOP' },
      { position: 'BTN', type: 'CHECK', street: 'FLOP' },
      { position: 'UTG', type: 'CHECK', street: 'TURN' },
      { position: 'BTN', type: 'CHECK', street: 'TURN' },
      { position: 'UTG', type: 'CHECK', street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

type SpotRow = {
  label: string;
  equity: number;
  facts: OpponentRangeFacts;
  betScore: number;
  checkScore: number;
  verdict: string;
  gridRatio: number;
  action: string | null;
  /** 引擎最终给出的下注尺寸（筹码）与该时刻底池 —— 用于验证「坚果不被压到最小尺寸」 */
  sizeChips: number | null;
  pot: number;
};

function measure(hero: readonly [string, string], label: string): SpotRow {
  const input = checkdownSpot(hero);
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true, `解析必须成功：${label}`);
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, `门槛必须放行：${label}`);
  if (!gate.ok) throw new Error('unreachable');
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
  });
  const advice = built.context.postflopFacts;
  const facts = advice?.opponentRangeFacts ?? null;
  assert.notEqual(facts, null, `必须算出对手范围事实：${label}`);
  const equity = built.context.math.heroEquity;
  assert.notEqual(equity, null, `必须算出权益：${label}`);
  if (facts === null || equity === null) throw new Error('unreachable');

  const compression = compressionStateOf(
    {
      betRatioToPot: 0.5,
      street: 'RIVER',
      opponentCount: 1,
      quickProfile: 'NORMAL',
      wetness: 0.5,
      aggressive: false,
      profileConfidence: 0,
    },
    {
      strongShare: facts.strongShare,
      drawShare: facts.drawShare,
      meanTier: facts.meanTier,
      weakShare: (facts.tierHistogram[4] ?? 0) + (facts.tierHistogram[5] ?? 0),
    },
  );
  const g = assessValueBet({
    role: RelativeHandRole.NUT_VALUE,
    heroEquity: equity,
    opponentCount: 1,
    compression,
    wetness: 0.5,
    spr: built.context.math.spr,
    hasInitiative: true,
    thinValueDelta: 0,
    bluffDelta: 0,
    protectionRelevant: false,
    rangeComparison: { weakerShare: facts.weakerShare, strongerShare: facts.strongerShare },
    hasCardsToCome: false,
  });
  const sizing = chooseSizing({
    nutAdvantage: Math.max(0, Math.min(1, 1 - facts.strongerShare)),
    rangeAdvantage: Math.max(0, equity - facts.strongerShare),
    wetness: 0.5,
    valueThickness: 1,
    bluffShare: 0.15,
    spr: built.context.math.spr,
    opponentCount: 1,
    elasticity: 0.5,
    sizingCap: 0.75,
    exploitMultiplier: 1,
    protectionWeight: g.protectionBenefit,
  });

  const result = analyzeManualHand(input, OPTIONS);
  assert.equal(result.ok, true, `整条分析必须成功：${label}`);
  const action = result.ok ? result.decision.action : null;

  return {
    label,
    equity,
    facts,
    betScore: g.estimatedBetEVScore,
    checkScore: g.estimatedCheckEVScore,
    verdict: g.verdict,
    gridRatio: sizing.gridRatio,
    action,
    sizeChips: result.ok ? (result.decision.sizeChips ?? null) : null,
    pot: built.context.math.pot,
  };
}

/* ============================================================
 * F-1 / F-2：坚果必须下注，且下注分必须随牌力单调
 * ============================================================ */

test('NUT-1：成对+成花牌面上，坚果级牌力必须「下注分 > 过牌分」，且下注分随牌力单调递增', () => {
  /*
   * 修复前（审计实测，同一局面只换底牌）：
   * ```text
   * 9♥9♦ 第二坚果葫芦 权益 0.9942 ⇒ bet 0.2787
   * A♣Q♣ 坚果同花     权益 0.9471 ⇒ bet 0.2300  ← 最小同花/三条反而更高
   * 4♣5♣ 最小同花     权益 0.8800 ⇒ bet 0.2806
   * K♥Q♥ 三条 K       权益 0.8297 ⇒ bet 0.2489
   * ```
   * 全部 `NOT_VALUE` + 引擎过牌 —— 这是本轮最大的方向性错误。
   */
  const rows = [
    measure(['9h', '9d'], '9♥9♦ 第二坚果葫芦'),
    measure(['Ac', 'Qc'], 'A♣Q♣ 坚果同花'),
    measure(['Qc', 'Jc'], 'Q♣J♣ 第三坚果同花'),
    measure(['4c', '5c'], '4♣5♣ 最小同花'),
    measure(['Kh', 'Qh'], 'K♥Q♥ 三条 K'),
    measure(['As', 'Ah'], 'A♠A♥ 两对 AA'),
  ];

  for (const row of rows) {
    assert.ok(
      row.betScore > row.checkScore,
      `${row.label}（权益 ${row.equity.toFixed(4)}）必须下注分 > 过牌分，` +
        `实际 bet ${row.betScore.toFixed(4)} vs check ${row.checkScore.toFixed(4)}（${row.verdict}）`,
    );
  }

  /*
   * 单调性：**权益更高的牌，下注分不得更低**。
   * 修复前这里三条独立反例（最小同花 / 第三坚果同花 / 三条 K 全部高于坚果同花）。
   */
  const sorted = [...rows].sort((a, b) => b.equity - a.equity);
  for (let i = 1; i < sorted.length; i += 1) {
    const hi = sorted[i - 1]!;
    const lo = sorted[i]!;
    assert.ok(
      hi.betScore >= lo.betScore - 1e-9,
      `下注分必须对牌力单调：${hi.label}（权益 ${hi.equity.toFixed(4)}）bet ${hi.betScore.toFixed(4)} ` +
        `不得低于 ${lo.label}（权益 ${lo.equity.toFixed(4)}）bet ${lo.betScore.toFixed(4)}`,
    );
  }

  // 最强的那手必须是 CLEAR_VALUE，并且引擎真的下注（不是「分数对但动作不跟」）
  const best = sorted[0]!;
  assert.equal(best.verdict, 'CLEAR_VALUE', `${best.label} 必须是明确价值`);
  assert.equal(best.action, 'BET', `${best.label} 的引擎动作必须是下注，实际 ${best.action}`);
});

test('NUT-2：坚果同花的**建议尺寸**必须至少半个底池（修复前被压到最小尺寸）', () => {
  const nut = measure(['Ac', 'Qc'], 'A♣Q♣ 坚果同花');
  assert.ok(
    SIZING_GRID.includes(nut.gridRatio),
    `尺寸必须落在网格上，实际 ${nut.gridRatio}`,
  );
  /*
   * 🔴 直接锁**建议器自己**给出的尺寸（`advisePostflop`），而不是只看引擎最终值：
   * 修复前 `nutAdvantage = 角色强度 − strongShare`，而成花成对面上
   * `strongShare = 1.0000` ⇒ 坚果优势 = 0（审计实测尺寸 0）。
   * 现在坚果优势来自「比我更好的牌」（≈0）⇒ 尺寸必须显著。
   */
  const parsed = parseManualInput(checkdownSpot(['Ac', 'Qc']));
  assert.equal(parsed.ok, true, '解析必须成功');
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, '门槛必须放行');
  if (!gate.ok) throw new Error('unreachable');
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
  });
  const advice = advisePostflop(built.context, {
    facingBet: false,
    requiredEquity: built.context.math.requiredEquity,
    potAfterCall: built.context.math.pot,
  });
  assert.notEqual(advice, null, '翻后建议器必须给出建议');
  /*
   * 判据是**方向**而不是某个具体网格值：几乎没有更好的牌（`strongerShare` 很小）
   * 且我持有有效坚果 ⇒ 尺寸必须是**大尺寸**，不得缩到中等或最小。
   * （修复前 `nutAdvantage = 1 − strongShare = 1 − 1 = 0` ⇒ 尺寸掉到 50% 以下。）
   */
  assert.ok(
    advice!.sizing.gridRatio >= 2 / 3,
    `坚果同花的建议尺寸必须是大尺寸（≥2/3 底池），实际 ${(advice!.sizing.gridRatio * 100).toFixed(0)}%`,
  );
  // 引擎最终采纳的尺寸同样不得缩到最小
  assert.notEqual(nut.sizeChips, null, '下注动作必须给出尺寸');
  const ratio = (nut.sizeChips ?? 0) / nut.pot;
  assert.ok(
    ratio >= 2 / 3,
    `坚果同花的实下尺寸必须是大尺寸（${nut.sizeChips} / 底池 ${nut.pot} = ${(ratio * 100).toFixed(0)}%）`,
  );
});

test('NUT-3：「更差的牌能跟」必须由**相对于我这手牌**的比较给出，不得被强牌占比抹掉', () => {
  /*
   * 修复前：`strongShare` 在成对牌面上饱和到 1.0000（每手都是「一对 K」），
   * 于是「更差的牌会跟」≈ 0 —— 拿坚果和拿空气得到同一个答案，
   * 与同一份输出里 94.7% 的权益直接矛盾。
   *
   * 现在：更差/更好两个占比来自 `compareHands` 逐组合精确比较，
   * 坚果手必然拿到「绝大多数都比我差」。
   */
  const nut = measure(['Ac', 'Qc'], 'A♣Q♣ 坚果同花');
  const trash = measure(['7h', '4s'], '7♥4♠ 空气');

  assert.ok(
    nut.facts.strongShare > 0.9,
    `成对牌面上 strongShare 本来就会饱和（这是事实），实际 ${nut.facts.strongShare.toFixed(4)}`,
  );
  assert.ok(
    nut.facts.weakerShare > 0.8,
    `坚果同花面对的范围里绝大多数必须「比我差」，实际 ${nut.facts.weakerShare.toFixed(4)}`,
  );
  assert.ok(
    nut.facts.strongerShare < 0.15,
    `坚果同花几乎没有更好的牌，实际 ${nut.facts.strongerShare.toFixed(4)}`,
  );
  assert.ok(
    trash.facts.strongerShare > nut.facts.strongerShare,
    `空气牌「比我好的牌」必须多于坚果手：空气 ${trash.facts.strongerShare.toFixed(4)} vs 坚果 ${nut.facts.strongerShare.toFixed(4)}`,
  );
  for (const row of [nut, trash]) {
    const sum = row.facts.weakerShare + row.facts.equalShare + row.facts.strongerShare;
    assert.ok(
      Math.abs(sum - 1) < 1e-9,
      `${row.label} 的三个占比必须构成完整分割，实际和 ${sum}`,
    );
  }
});

/* ============================================================
 * 纯函数：单调性与口径
 * ============================================================ */

function gateOf(equity: number, strongerShare: number, hasCardsToCome = false) {
  const compression = compressionStateOf(
    {
      betRatioToPot: 0.6,
      street: hasCardsToCome ? 'FLOP' : 'RIVER',
      opponentCount: 1,
      quickProfile: 'NORMAL',
      wetness: 0.6,
      aggressive: false,
      profileConfidence: 0,
    },
    { strongShare: 0.4, drawShare: 0.2, meanTier: 2.6, weakShare: 0.2 },
  );
  return assessValueBet({
    role: RelativeHandRole.STRONG_VALUE,
    heroEquity: equity,
    opponentCount: 1,
    compression,
    wetness: 0.6,
    spr: 5,
    hasInitiative: true,
    thinValueDelta: 0,
    bluffDelta: 0,
    protectionRelevant: true,
    rangeComparison: { weakerShare: Math.max(0, 1 - strongerShare), strongerShare },
    hasCardsToCome,
  });
}

test('GATE-MONO-1：固定角色与固定对手范围时，下注分必须随权益单调递增（正区间内严格递增）', () => {
  /*
   * 修复前 `valuePart = (权益 − 0.5) / 0.35` 在权益 ≥0.85 处**整段饱和到 1**
   * ⇒ 权益从 0.85 涨到 0.99，下注分完全不动（审计实测正是如此）。
   *
   * 断言分两层，避免把「分数下界被 clamp 到 0」误判成缺陷：
   * ① 全局**非减**；② 只要上一个分数已经离开 0 下界，就必须**严格上升**。
   */
  const equities = [0.25, 0.45, 0.55, 0.65, 0.75, 0.85, 0.92, 0.99];
  const scores = equities.map((e) => gateOf(e, 0.1).estimatedBetEVScore);
  for (let i = 1; i < scores.length; i += 1) {
    const prev = scores[i - 1]!;
    const next = scores[i]!;
    assert.ok(
      next >= prev - 1e-9,
      `权益 ${equities[i - 1]} → ${equities[i]} 时下注分不得下降：${prev.toFixed(4)} → ${next.toFixed(4)}`,
    );
    if (prev > 1e-9 && prev < 1 - 1e-9) {
      assert.ok(
        next > prev,
        `权益 ${equities[i - 1]} → ${equities[i]} 时下注分必须严格上升：${prev.toFixed(4)} → ${next.toFixed(4)}`,
      );
    }
  }
  // 高权益段必须真的涨（修复前这一段是平的）
  const high = equities.filter((e) => e >= 0.85).map((e) => gateOf(e, 0.1).estimatedBetEVScore);
  assert.ok(
    high[high.length - 1]! > high[0]! + 1e-6,
    `权益 0.85 → 0.99 的下注分必须上升，实际 ${high[0]!.toFixed(4)} → ${high[high.length - 1]!.toFixed(4)}`,
  );
});

test('GATE-MONO-2：固定权益时，「比我更好的牌越多」下注分必须单调下降', () => {
  const stronger = [0, 0.1, 0.25, 0.4, 0.6];
  const scores = stronger.map((s) => gateOf(0.7, s).estimatedBetEVScore);
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(
      scores[i]! <= scores[i - 1]! + 1e-9,
      `「更好的牌占比」${stronger[i - 1]} → ${stronger[i]} 时下注分不得上升：` +
        `${scores[i - 1]!.toFixed(4)} → ${scores[i]!.toFixed(4)}`,
    );
  }
});

test('RIVER-2：保护收益在河牌必须恒为 0（没有补牌就没有「让听牌弃牌」）', () => {
  const river = gateOf(0.7, 0.1, false);
  const flop = gateOf(0.7, 0.1, true);
  assert.equal(river.protectionBenefit, 0, '河牌的保护收益必须是 0');
  assert.ok(flop.protectionBenefit > 0, '湿翻牌上保护收益必须存在');
  assert.ok(
    flop.estimatedBetEVScore > river.estimatedBetEVScore,
    '同权益同范围下，有补牌的街保护分更高是合理的；河牌不得凭空拿到保护分',
  );
});

/* ============================================================
 * F-4：空白河牌不得无理由抹掉已有价值
 * ============================================================ */

/** 同一条线路推进到指定街：前面的街双方都过牌，**当前街只让 UTG 过牌**（保持轮到 Hero） */
function streetSpot(
  hero: readonly [string, string],
  board: readonly string[],
): ManualHandInput {
  const streets = ['FLOP', 'TURN', 'RIVER'] as const;
  const history: Array<Record<string, unknown>> = [
    { position: 'UTG', type: 'RAISE', amountBB: 3 },
    F('UTG1'), F('UTG2'), F('LJ'), F('HJ'), F('CO'),
    { position: 'BTN', type: 'CALL', amountBB: 3 },
    F('SB'), F('BB'),
  ];
  const current = board.length - 3; // 0=翻牌 1=转牌 2=河牌
  for (let i = 0; i < current; i += 1) {
    history.push({ position: 'UTG', type: 'CHECK', street: streets[i] });
    history.push({ position: 'BTN', type: 'CHECK', street: streets[i] });
  }
  history.push({ position: 'UTG', type: 'CHECK', street: streets[current] });
  return {
    tableSize: 9,
    heroPosition: 'BTN',
    heroCards: [hero[0], hero[1]],
    board: [...board],
    street: streets[board.length - 3],
    effectiveStackBB: 100,
    seatStacksBB: { UTG: 100, BTN: 100 },
    actionHistory: history,
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

function adviceOf(input: ManualHandInput) {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true, '解析必须成功');
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, '门槛必须放行');
  if (!gate.ok) throw new Error('unreachable');
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
  });
  const result = analyzeManualHand(input, OPTIONS);
  assert.equal(result.ok, true, '整条分析必须成功');
  return {
    context: built.context,
    diagnostics: built.context.postflopFacts ?? null,
    math: built.context.math,
    action: result.ok ? result.decision.action : null,
  };
}

test('RIVER-1：空白河牌上仍有优势的牌必须保留下注意愿（审计实测修复前降到 0.03 / 0.00）', () => {
  /*
   * 审计实测（同手牌、同对手线路，只把街从转牌推到河牌）：
   * ```text
   * K♦K♥ 超对：转牌 bet 0.3092 CLEAR_VALUE ⇒ 白板河牌 2♦ bet 0.0273 NOT_VALUE
   * Q♥Q♦ 超对：转牌 bet 0.2901 CLEAR_VALUE ⇒ 白板河牌 2♦ bet 0.0000 NOT_VALUE
   * ```
   * 河牌比转牌**更贵**（同样的钱代表更多），但「白板」这张牌本身没有让对手
   * 范围变强 —— 价值不该因此消失。判据用**方向**：权益仍占优 ⇒ 下注分必须
   * 仍高于过牌分，且引擎动作仍是下注。
   */
  for (const [label, hero] of [
    ['K♦K♥ 超对', ['Kd', 'Kh']],
    ['Q♥Q♦ 超对', ['Qh', 'Qd']],
  ] as Array<[string, readonly [string, string]]>) {
    const turnBoard = ['Qs', 'Jd', 'Tc', '2h'];
    const riverBoard = [...turnBoard, '2d']; // 空白河牌（只重复了转牌的点数）
    const turn = adviceOf(streetSpot(hero, turnBoard));
    const river = adviceOf(streetSpot(hero, riverBoard));
    const eq = river.math.heroEquity;
    assert.notEqual(eq, null, `${label} 必须算出河牌权益`);
    if (eq === null) continue;
    assert.ok(
      eq > 0.5,
      `${label} 在空白河牌上权益仍应占优（实际 ${eq.toFixed(4)}）—— 否则本用例的前提不成立`,
    );
    assert.ok(
      river.diagnostics !== null && river.diagnostics.opponentRangeFacts !== null,
      `${label} 必须算出河牌范围事实`,
    );
    const facts = river.diagnostics!.opponentRangeFacts!;
    assert.ok(
      facts.weakerShare > facts.strongerShare,
      `${label} 在空白河牌上「更差的牌」必须多于「更好的牌」：` +
        `更差 ${facts.weakerShare.toFixed(3)} vs 更好 ${facts.strongerShare.toFixed(3)}`,
    );
    assert.equal(
      river.action,
      'BET',
      `${label} 在空白河牌上必须仍然下注（转牌动作 ${turn.action}），实际 ${river.action}`,
    );
  }
});

test('GATE-NAN-1：非有限入参不得产出 NaN 分数（审计指出的未守卫入口）', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const g = assessValueBet({
      role: RelativeHandRole.MEDIUM_VALUE,
      heroEquity: bad,
      opponentCount: 1,
      compression: compressionStateOf(
        {
          betRatioToPot: 0.5,
          street: 'TURN',
          opponentCount: 1,
          quickProfile: 'NORMAL',
          wetness: bad,
          aggressive: false,
        },
        { strongShare: 0.3, drawShare: 0.2, meanTier: 2.8 },
      ),
      wetness: bad,
      spr: 5,
      hasInitiative: true,
      thinValueDelta: 0,
      bluffDelta: 0,
      protectionRelevant: true,
      rangeComparison: { weakerShare: bad, strongerShare: bad },
      hasCardsToCome: true,
    });
    for (const key of [
      'worseCallDensity',
      'betterContinueDensity',
      'raiseRisk',
      'showdownValue',
      'protectionBenefit',
      'estimatedBetEVScore',
      'estimatedCheckEVScore',
    ] as const) {
      assert.ok(
        Number.isFinite(g[key]),
        `入参为 ${bad} 时 ${key} 必须仍是有限数，实际 ${g[key]}`,
      );
      assert.ok(g[key] >= 0 && g[key] <= 1, `${key} 必须落在 0..1，实际 ${g[key]}`);
    }
    assert.ok(typeof g.verdict === 'string' && g.verdict.length > 0, '必须仍然给出判定');
  }

  const sizing = chooseSizing({
    nutAdvantage: NaN,
    rangeAdvantage: Infinity,
    wetness: NaN,
    valueThickness: NaN,
    bluffShare: 0.15,
    spr: NaN,
    opponentCount: NaN,
    elasticity: NaN,
    sizingCap: 0.75,
    exploitMultiplier: 1,
    protectionWeight: NaN,
  });
  assert.ok(Number.isFinite(sizing.targetRatio), `尺寸目标必须是有限数，实际 ${sizing.targetRatio}`);
  assert.ok(SIZING_GRID.includes(sizing.gridRatio), '尺寸必须落在网格上');
});
