/**
 * 翻后升级 · P1 模块测试（2026-09）
 *
 * 覆盖：RelativeHandRole / BoardDelta / RangeCompression / ValueBetGate /
 * MultiwayPenalty / Blocker / SPR 承诺 / 独立 Bet Sizing / EV 评分与置信度 / Exploit 分层。
 *
 * ## 断言纪律
 *
 * - 只断言**结构与方向**（谁比谁大、谁必须变、哪个字段必须为 null），
 *   不锁任何具体数值 ⇒ 不会把启发式标尺固化成「正确答案」。
 * - 使用者禁令：不得针对具体牌面写死答案。因此测试里的牌面只是**夹具**，
 *   断言的是「同一个机制在不同输入下的**相对**行为」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { C } from './helpers.ts';
import { describeHand } from '../src/domain/poker/handDescription.ts';
import { boardRelativeTierOf } from '../src/domain/poker/boardRelativeStrength.ts';
import { RelativeHandRole } from '../src/domain/postflop/types.ts';
import { classifyRelativeRole, roleChangeReasonZh } from '../src/domain/postflop/relativeHandRole.ts';
import { roleStrengthOf } from '../src/domain/postflop/valueBetGate.ts';
import { computeBoardDelta, boardTextureOf } from '../src/domain/postflop/boardDelta.ts';
import { drawProfileOf } from '../src/domain/postflop/draws.ts';
import {
  compressionFactor,
  compressionStateOf,
  boardWetnessOf,
} from '../src/domain/postflop/rangeCompression.ts';
import { multiwayAdjustment, valueThresholdWithMultiway } from '../src/domain/postflop/multiway.ts';
import { assessCommitment, SprBand, realSprAfterCall } from '../src/domain/postflop/commitment.ts';
import { assessValueBet } from '../src/domain/postflop/valueBetGate.ts';
import { assessBlockers } from '../src/domain/postflop/blockers.ts';
import { chooseSizing, SIZING_GRID, elasticityOf } from '../src/domain/postflop/sizing.ts';
import { confidenceOf, rankActions, preferenceZh, type ActionScore } from '../src/domain/postflop/evScore.ts';
import { exploitAdjustmentOf, EXPLOIT_MAX_DELTA, drawChaserNote } from '../src/domain/postflop/exploit.ts';

/** 便捷：由底牌+牌面构造角色输入 */
function roleInput(options: {
  hole: string;
  board: string;
  equity: number | null;
  requiredEquity?: number;
  facingBet?: boolean;
  opponentCount?: number;
  spr?: number | null;
  hasInitiative?: boolean;
}) {
  const hole = C(options.hole);
  const board = C(options.board);
  const described = describeHand(hole, board);
  return {
    heroHole: hole,
    board,
    street: (board.length === 3 ? 'FLOP' : board.length === 4 ? 'TURN' : 'RIVER') as 'FLOP' | 'TURN' | 'RIVER',
    shape: described.shape,
    category: described.category,
    heroEquity: options.equity,
    requiredEquity: options.requiredEquity ?? 0.25,
    spr: options.spr ?? 4,
    opponentCount: options.opponentCount ?? 1,
    facingBet: options.facingBet ?? false,
    hasInitiative: options.hasInitiative ?? true,
    opponentRangeFacts: null,
    draws: drawProfileOf(hole, board),
  };
}

/* ============================================================
 * 一、RelativeHandRole
 * ============================================================ */

test('ROLE-1：同一个「一对」在不同牌面/权益下必须给出**不同**角色（相对性）', () => {
  // 顶对且权益领先 ⇒ 中等价值
  const strong = classifyRelativeRole(roleInput({ hole: 'Kd Qd', board: 'Qc 7s 4d', equity: 0.72 }));
  assert.equal(strong, RelativeHandRole.MEDIUM_VALUE, `顶对高权益应为中等价值，实际 ${strong}`);

  // 同一个顶对，但权益被压到门槛以下 ⇒ 摊牌价值（而不是仍然中等价值）
  const weak = classifyRelativeRole(roleInput({ hole: 'Kd Qd', board: 'Qc 7s 4d', equity: 0.42 }));
  assert.equal(weak, RelativeHandRole.SHOWDOWN_VALUE, `顶对低权益应为摊牌价值，实际 ${weak}`);
});

test('ROLE-2：转牌高张把强价值降级（TEST 2 的机制，不写死牌面）', () => {
  // 翻牌：顶对，权益高 ⇒ 价值
  const flop = classifyRelativeRole(roleInput({ hole: 'Kd Qd', board: 'Qc 7s 4d', equity: 0.72 }));
  assert.ok(
    flop === RelativeHandRole.MEDIUM_VALUE || flop === RelativeHandRole.STRONG_VALUE,
    `翻牌应为价值类，实际 ${flop}`,
  );
  // 转牌出现 A 之后，权益被对手范围压下来 ⇒ 必须降级
  const turn = classifyRelativeRole(roleInput({ hole: 'Kd Qd', board: 'Qc 7s 4d Ac', equity: 0.34 }));
  assert.ok(
    turn === RelativeHandRole.SHOWDOWN_VALUE ||
      turn === RelativeHandRole.BLUFF_CATCHER ||
      turn === RelativeHandRole.AIR,
    `转牌 A 之后必须降级，实际 ${turn}`,
  );
  assert.ok(roleStrengthOf(turn) < roleStrengthOf(flop), '降级后的强度刻度必须更低');
});

test('ROLE-3：坚果结构直接判坚果级；同花/顺子/三条直接判强价值', () => {
  assert.equal(
    classifyRelativeRole(roleInput({ hole: '7c 7d', board: '7h 7s 2c', equity: 0.9 })),
    RelativeHandRole.NUT_VALUE,
    '四条必须是坚果级',
  );
  assert.equal(
    classifyRelativeRole(roleInput({ hole: '9c 8c', board: 'Ts Jd Qh', equity: 0.8 })),
    RelativeHandRole.STRONG_VALUE,
    '顺子必须是强价值',
  );
});

test('ROLE-4：听牌在有无主动权时角色不同（半诈唬 vs 听牌）', () => {
  const withInitiative = classifyRelativeRole(
    roleInput({ hole: 'Ac Kc', board: 'Qc 7c 2h', equity: 0.42, hasInitiative: true }),
  );
  assert.equal(withInitiative, RelativeHandRole.SEMI_BLUFF, `有主动权应为半诈唬，实际 ${withInitiative}`);

  const facing = classifyRelativeRole(
    roleInput({ hole: 'Ac Kc', board: 'Qc 7c 2h', equity: 0.42, facingBet: true, hasInitiative: false }),
  );
  assert.equal(facing, RelativeHandRole.DRAW, `面对下注应为听牌，实际 ${facing}`);
});

test('ROLE-5：跨街迁移必须给出可读原因，且「牌面空白」不能自动升级角色', () => {
  const reason = roleChangeReasonZh({
    previous: RelativeHandRole.MEDIUM_VALUE,
    current: RelativeHandRole.SHOWDOWN_VALUE,
    delta: {
      blankScore: 0.2,
      overcardImpact: 0.5,
      flushCompleted: false,
      straightCompleted: false,
      heroRelativeStrengthChange: -2,
      villainRangeImprovement: 0.6,
    },
    equityBefore: 0.7,
    equityAfter: 0.34,
  });
  assert.match(reason, /中等价值/);
  assert.match(reason, /摊牌价值/);
  assert.ok(reason.length > 20, '原因必须可读，不能是一句话糊过去');

  // 空白牌 + 角色不变 ⇒ 明确说明「牌面接近空白，角色保持」
  const blank = roleChangeReasonZh({
    previous: RelativeHandRole.SHOWDOWN_VALUE,
    current: RelativeHandRole.SHOWDOWN_VALUE,
    delta: {
      blankScore: 0.9,
      overcardImpact: 0,
      flushCompleted: false,
      straightCompleted: false,
      heroRelativeStrengthChange: 0,
      villainRangeImprovement: 0.1,
    },
    equityBefore: 0.4,
    equityAfter: 0.4,
  });
  assert.match(blank, /保持/);
});

/* ============================================================
 * 二、Board Delta
 * ============================================================ */

test('DELTA-1：同花成为可能 / 四张同花 / 空白牌必须被识别为不同结构', () => {
  /*
   * 精确语义（见 `boardDelta.ts` 的说明）：
   * - 牌面**首次**出现 3 张同花色 ⇒ 这张牌让同花成为可能
   * - 牌面已有 4 张同花色 ⇒ 四张同花（听牌面成型）
   */
  const unchanged = computeBoardDelta({
    previousBoard: C('Jd 9c 6c 2s'),
    board: C('Jd 9c 6c 2s'),
    heroHole: C('Ac Kc'),
    street: 'TURN',
    rangeFacts: null,
    previousTier: null,
  })!;
  assert.equal(unchanged.overcardImpact, 0, '没有新牌 ⇒ 没有高张影响');
  assert.equal(unchanged.flushCompleted, false);
  assert.ok(unchanged.blankScore > 0.9, `没有新牌 ⇒ 接近完全空白，实际 ${unchanged.blankScore}`);

  const threeSuited = boardTextureOf(C('Jd 9c 6c Tc'))!;
  assert.equal(threeSuited.flushPossible, true, '三张同花色 ⇒ 同花成为可能');
  assert.equal(threeSuited.fourToFlush, false, '三张同花色不是「四张同花」');

  const fourSuited = boardTextureOf(C('Jd 9c 6c Tc 2c'))!;
  assert.equal(fourSuited.fourToFlush, true, '四张同花色必须被识别为四张同花');
  assert.equal(fourSuited.flushPossible, true);

  const dryBoard = boardTextureOf(C('Kh 7s 2d'))!;
  assert.equal(dryBoard.fourToFlush, false);
  assert.equal(dryBoard.flushPossible, false);
  assert.equal(dryBoard.maxSuitCount, 1);
  assert.equal(dryBoard.pairedBoard, false);
});

test('DELTA-1b：🔴 「这张牌让同花成为可能」必须在**跨街比较**里判定（而不是看绝对张数）', () => {
  const delta = computeBoardDelta({
    previousBoard: C('Jd 9c 6c 2s'),
    board: C('Jd 9c 6c 2s Tc'),
    heroHole: C('Ac Kc'),
    street: 'RIVER',
    rangeFacts: null,
    previousTier: boardRelativeTierOf(C('Ac Kc'), C('Jd 9c 6c 2s')),
  })!;
  assert.equal(delta.flushCompleted, true, '♣ 从 2 张变 3 张 ⇒ 同花成为可能');
  assert.equal(delta.fourToFlush, false, '3 张 ≠ 四张同花');

  // 反例：牌面本来就已成同花可能时，再来一张♣**不是**「这张牌让它成为可能」
  const already = computeBoardDelta({
    previousBoard: C('Jd 9c 6c Tc'),
    board: C('Jd 9c 6c Tc 2c'),
    heroHole: C('Ah Kh'),
    street: 'RIVER',
    rangeFacts: null,
    previousTier: boardRelativeTierOf(C('Ah Kh'), C('Jd 9c 6c Tc')),
  })!;
  assert.equal(already.flushCompleted, false, '上一街已经可能了 ⇒ 不重复声称「完成」');
  assert.equal(already.fourToFlush, true, '但这一张把牌面推到四张同花');
});

test('DELTA-2：新牌必须给出**数值**影响，而不是只给布尔', () => {
  const delta = computeBoardDelta({
    previousBoard: C('Qc 7s 4d'),
    board: C('Qc 7s 4d Ac'),
    heroHole: C('Kd Qd'),
    street: 'TURN',
    rangeFacts: null,
    previousTier: boardRelativeTierOf(C('Kd Qd'), C('Qc 7s 4d')),
  })!;
  assert.ok(delta.overcardImpact > 0, 'A 高于原牌面 ⇒ overcardImpact 必须为正');
  assert.ok(delta.blankScore < 0.9, '出现高张不算空白');
  assert.equal(
    delta.villainRangeImprovement,
    null,
    '没有对手范围事实时必须返回 null（**不返回编造的 0**）',
  );
});

test('DELTA-3：真正的空白牌 blankScore 必须高；且我们有该花色时 nutShift 偏向我们', () => {
  const blank = computeBoardDelta({
    previousBoard: C('Qc 7s 4d'),
    board: C('Qc 7s 4d 2h'),
    heroHole: C('Kd Qd'),
    street: 'TURN',
    rangeFacts: null,
    previousTier: boardRelativeTierOf(C('Kd Qd'), C('Qc 7s 4d')),
  })!;
  assert.ok(blank.blankScore > 0.4, `2♥ 接近空白，blankScore 应偏高，实际 ${blank.blankScore}`);

  const ours = computeBoardDelta({
    previousBoard: C('9c 7c 2d'),
    board: C('9c 7c 2d Tc'),
    heroHole: C('Ac Kc'),
    street: 'TURN',
    rangeFacts: null,
    previousTier: boardRelativeTierOf(C('Ac Kc'), C('9c 7c 2d')),
  })!;
  assert.ok(ours.heroRelativeStrengthChange > 0, '完成同花后我方相对档位必须提升');
  assert.ok(ours.nutShift < 0, `我方持有该花色 ⇒ nutShift 应偏我们（负），实际 ${ours.nutShift}`);
});

/* ============================================================
 * 三、Range Compression
 * ============================================================ */

const compressionBase = { street: 'TURN' as const, opponentCount: 1, quickProfile: 'NORMAL' as const, wetness: 0.3, aggressive: false };

test('COMP-1：压缩因子必须随尺寸、街、人数、牌面湿度方向正确地变化', () => {
  const small = compressionFactor({ ...compressionBase, betRatioToPot: 0.2 });
  const large = compressionFactor({ ...compressionBase, betRatioToPot: 1.5 });
  assert.ok(large > small, `大注压缩更强：${large} vs ${small}`);

  const flop = compressionFactor({ ...compressionBase, betRatioToPot: 0.75, street: 'FLOP' });
  const river = compressionFactor({ ...compressionBase, betRatioToPot: 0.75, street: 'RIVER' });
  assert.ok(river > flop, `同样的钱在河牌代表更多：${river} vs ${flop}`);

  const headsUp = compressionFactor({ ...compressionBase, betRatioToPot: 0.75 });
  const multiway = compressionFactor({ ...compressionBase, betRatioToPot: 0.75, opponentCount: 4 });
  assert.ok(multiway < headsUp, `多人池继续门槛更低：${multiway} vs ${headsUp}`);

  const dry = compressionFactor({ ...compressionBase, betRatioToPot: 0.75, wetness: 0.1 });
  const wet = compressionFactor({ ...compressionBase, betRatioToPot: 0.75, wetness: 0.9 });
  assert.ok(wet < dry, `湿面继续范围含更多听牌：${wet} vs ${dry}`);
});

test('COMP-2：跟注站/疯子的继续必须被判定为「信息量更低」', () => {
  const nit = compressionFactor({ ...compressionBase, betRatioToPot: 0.75, quickProfile: 'VERY_TIGHT' });
  const station = compressionFactor({ ...compressionBase, betRatioToPot: 0.75, quickProfile: 'CALLING_STATION' });
  const maniac = compressionFactor({ ...compressionBase, betRatioToPot: 0.75, quickProfile: 'MANIAC' });
  assert.ok(nit > station && nit > maniac, `紧手的继续可信度最高：${nit} vs ${station} / ${maniac}`);
});

test('COMP-3：压缩状态必须把质量从空气搬到强牌，且没有范围事实时如实标注基线', () => {
  const input = { ...compressionBase, betRatioToPot: 1.2, aggressive: true };
  const state = compressionStateOf(input, { strongShare: 0.3, drawShare: 0.2, meanTier: 2.6 });
  assert.ok(state.nutDensity > 0 && state.nutDensity <= 1);
  assert.ok(state.airDensity >= 0 && state.airDensity < 0.6, '强压缩之后空气密度必须低');
  assert.ok(state.aggressionCredibility > 0.5, '大额进攻的可信度应偏高');

  const wet = boardWetnessOf({ maxSuitCount: 3, maxRunLength: 4, pairedBoard: false });
  const dry = boardWetnessOf({ maxSuitCount: 1, maxRunLength: 2, pairedBoard: false });
  assert.ok(wet > dry, '湿面湿度必须更高');
});

/*
 * §十五（PLAYER PROFILE QUANTIFICATION V1）：`*Density` 是**特征分**，不是概率。
 *
 * 这条测试锁的不是某个数值，而是**「不得当概率用」这个语义**：
 * 五者相加既不等于 1、也**不保证 ≤ 1**（实测恒 > 1）。一旦有人把它们
 * 当归一化概率喂给下游，或把文档改回「占比」，就会得出「他有 68% 空气」
 * 这类**编造**结论 —— 而本项目的立场是「宁可没有数据，也不编造数据」。
 *
 * 机制（写死在实现里，两条都可在 `rangeCompression.ts` 核对）：
 * 1. `mediumStrengthDensity` 是**残差** `1 − air − nut − draw × 0.5`；
 * 2. `showdownDensity = mediumStrengthDensity × 0.8` ⇒ **摊牌那一块本就包含在
 *    中等成手质量里**，相加等于重复计入同一批 combo（两者**不互斥**）。
 *
 * ⚠️ 若这条变红：说明密度的**语义**变了。正确处理是**同步更新**
 * `rangeCompression.ts` 文件头的「不是概率」声明与 UI 措辞
 *（`decisionViewModel` / `postflopAdvisor` / `decisionEngine` 的「密度评分」），
 * 而**不是**删掉这条断言。
 */
test('COMP-4（§十五）：*Density 不是概率分割 —— 不得归一化、不得要求合计为 1', () => {
  const stateAt = (strongShare: number) =>
    compressionStateOf(
      { ...compressionBase, betRatioToPot: 1.2, aggressive: true },
      { strongShare, drawShare: 0.2, meanTier: 2.6 },
    );

  // 结构证据 1：摊牌质量由中等成手质量**派生** ⇒ 两者同时为正时不互斥，
  // 因此五项不可能构成概率分割（分割要求各部分互斥且合计为 1）。
  const s = stateAt(0.3);
  assert.ok(s.mediumStrengthDensity > 0, '夹具必须让中等成手特征分为正');
  assert.equal(
    s.showdownDensity,
    Math.min(1, s.mediumStrengthDensity * 0.8),
    '摊牌特征分必须是中等成手特征分的派生量（⇒ 相加即重复计入，非互斥）',
  );

  // 结构证据 2：扫过强牌占比，五者之和**从不等于 1**，且实测恒 > 1。
  const sums = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1].map((strongShare) => {
    const st = stateAt(strongShare);
    return (
      st.nutDensity + st.mediumStrengthDensity + st.drawDensity + st.airDensity + st.showdownDensity
    );
  });
  const shown = sums.map((x) => x.toFixed(3)).join(' / ');
  assert.ok(
    sums.every((x) => Math.abs(x - 1) > 0.02),
    `五者之和不得等于 1（它们不是分割）：${shown}`,
  );
  assert.ok(sums.every((x) => x > 1), `实测五者之和恒 > 1（重复计入摊牌质量）：${shown}`);
});

/* ============================================================
 * 四、Multiway Penalty
 * ============================================================ */

test('MW-1：多人惩罚必须单调递增、有界，且 1 家时为 0', () => {
  const single = multiwayAdjustment(1);
  assert.equal(single.multiwayStrengthPenalty, 0);
  assert.equal(single.multiwayBluffPenalty, 0);
  assert.equal(single.multiwayValueThresholdAdjustment, 0);

  const counts = [2, 3, 4, 5, 6];
  const strengths = counts.map((n) => multiwayAdjustment(n).multiwayStrengthPenalty);
  for (let i = 1; i < strengths.length; i += 1) {
    assert.ok(strengths[i]! > strengths[i - 1]!, `人数越多惩罚越大：${strengths.join(' / ')}`);
  }
  assert.ok(strengths[strengths.length - 1]! < 0.45, '惩罚必须有界（不能把人多的局面一刀切）');

  // 诈唬惩罚必须比价值惩罚更陡（弃牌率是连乘下降的）
  for (const n of counts) {
    const a = multiwayAdjustment(n);
    assert.ok(
      a.multiwayBluffPenalty > a.multiwayStrengthPenalty,
      `${n} 家：诈唬惩罚必须大于强度惩罚`,
    );
  }
  assert.ok(valueThresholdWithMultiway(0.58, 4) > 0.58, '多人池的价值门槛必须抬高');
});

/* ============================================================
 * 五、SPR / 承诺
 * ============================================================ */

test('SPR-1：低 SPR 允许一对级承诺，高 SPR 不允许（TEST 4 的机制）', () => {
  const low = assessCommitment({
    spr: 0.38,
    remainingAfterCall: 14,
    potAfterCall: 256,
    onePairOrBetter: true,
    roleStrength: roleStrengthOf(RelativeHandRole.MEDIUM_VALUE),
  });
  assert.ok(low.stackOffAllowed, `SPR 0.38 时一对级必须可以承诺，实际 ${low.band}`);

  const high = assessCommitment({
    spr: 20,
    remainingAfterCall: 900,
    potAfterCall: 45,
    onePairOrBetter: true,
    roleStrength: roleStrengthOf(RelativeHandRole.MEDIUM_VALUE),
  });
  assert.equal(high.stackOffAllowed, false, 'SPR 20 时一对级不得承诺');
  assert.ok(high.sizingCap < low.sizingCap, '高 SPR 的尺寸上限必须更紧');

  // 低 SPR 的尺寸上限必须足够大，让「全下」成为合法选项
  assert.ok(low.sizingCap >= 1, '低 SPR 下尺寸上限必须允许接近/达到全下');
});

test('SPR-2：SPR 不可计算时必须如实返回，不得猜一个承诺结论', () => {
  const unknown = assessCommitment({
    spr: null,
    remainingAfterCall: 100,
    potAfterCall: 0,
    onePairOrBetter: true,
    roleStrength: 0.6,
  });
  assert.equal(unknown.stackOffAllowed, false);
  assert.match(unknown.noteZh, /不可计算|不据此/);

  assert.ok(Math.abs(realSprAfterCall(100, 20, 60)! - 80 / 60) < 1e-9);
  assert.equal(realSprAfterCall(100, 20, 0), null, '底池为 0 ⇒ null（不是 Infinity）');
});

/* ============================================================
 * 六、Value Bet Gate
 * ============================================================ */

function gateInput(overrides: Partial<Parameters<typeof assessValueBet>[0]> = {}) {
  return {
    role: RelativeHandRole.MEDIUM_VALUE,
    heroEquity: 0.66,
    opponentCount: 1,
    compression: compressionStateOf(
      { betRatioToPot: 0.5, street: 'TURN', opponentCount: 1, quickProfile: 'NORMAL', wetness: 0.3, aggressive: true },
      { strongShare: 0.25, drawShare: 0.2, meanTier: 2.8 },
    ),
    wetness: 0.3,
    spr: 5,
    hasInitiative: true,
    thinValueDelta: 0,
    bluffDelta: 0,
    protectionRelevant: false,
    ...overrides,
  };
}

test('GATE-1：五个问题都必须有明确输出，且 EV 分在 0..1', () => {
  const a = assessValueBet(gateInput());
  for (const key of [
    'worseHandsCanCall',
    'worseCallDensity',
    'betterHandsContinue',
    'betterContinueDensity',
    'raiseRisk',
    'showdownValue',
    'protectionBenefit',
    'estimatedBetEVScore',
    'estimatedCheckEVScore',
  ] as const) {
    assert.ok(a[key] !== undefined, `必须给出 ${key}`);
  }
  assert.ok(a.estimatedBetEVScore >= 0 && a.estimatedBetEVScore <= 1);
  assert.ok(a.estimatedCheckEVScore >= 0 && a.estimatedCheckEVScore <= 1);
});

test('GATE-2：🔴 「摊牌价值高 + 更差牌跟得少 + 更好牌继续多」必须让过牌分数反超（只调 EV，不硬编码过牌）', () => {
  /*
   * 构造条件：对手范围很强 —— **且必须用「相对于我这手牌」的口径表达**
   *（`rangeComparison.strongerShare` 高 = 他手里大量牌比我这手更好）。
   *
   * ⚠️ 第二轮审计抓到：这一问修复前由 `strongShare`（他的范围整体多强）冒充，
   * 而那个量在成对/成花牌面上必然饱和到 1.0，于是拿坚果也得到同一个答案
   *（实测坚果同花权益 94.7% 被判 NOT_VALUE）。因此本用例现在**显式**
   * 传入相对比较，锁住「更好牌占比高 ⇒ 不该取值」这一条方向。
   */
  const strongRange = compressionStateOf(
    { betRatioToPot: 1.0, street: 'RIVER', opponentCount: 1, quickProfile: 'TIGHT', wetness: 0.2, aggressive: true },
    { strongShare: 0.75, drawShare: 0.05, meanTier: 1.2 },
  );
  const a = assessValueBet(
    gateInput({
      compression: strongRange,
      heroEquity: 0.52,
      role: RelativeHandRole.THIN_VALUE,
      rangeComparison: { weakerShare: 0.2, strongerShare: 0.8 },
    }),
  );
  assert.ok(
    a.estimatedCheckEVScore > a.estimatedBetEVScore,
    `该局面下过牌分数必须更高：bet ${a.estimatedBetEVScore.toFixed(3)} vs check ${a.estimatedCheckEVScore.toFixed(3)}`,
  );
  assert.ok(
    a.verdict === 'PREFER_CHECK' || a.verdict === 'NOT_VALUE' || a.verdict === 'MARGINAL',
    `verdict 必须是「不推荐下注」一侧，实际 ${a.verdict}`,
  );
  assert.ok(a.reasonsZh.length > 0, '必须给出可读原因');
});

test('GATE-3：跟注站画像必须能提高薄价值的分数（防止守门器把薄价值全部 check 掉）', () => {
  const looseStation = compressionStateOf(
    { betRatioToPot: 0.4, street: 'FLOP', opponentCount: 1, quickProfile: 'CALLING_STATION', wetness: 0.3, aggressive: false },
    { strongShare: 0.12, drawShare: 0.25, meanTier: 3.6 },
  );
  const without = assessValueBet(
    gateInput({ compression: looseStation, heroEquity: 0.6, role: RelativeHandRole.THIN_VALUE, thinValueDelta: 0 }),
  );
  const withExploit = assessValueBet(
    gateInput({ compression: looseStation, heroEquity: 0.6, role: RelativeHandRole.THIN_VALUE, thinValueDelta: 0.1 }),
  );
  assert.ok(
    withExploit.estimatedBetEVScore > without.estimatedBetEVScore,
    '跟注站画像必须提高薄价值下注分数',
  );
});

test('GATE-4：保护收益必须与价值分开记录，且只在相关牌面上出现', () => {
  const dry = assessValueBet(gateInput({ protectionRelevant: false, wetness: 0.1 }));
  const wet = assessValueBet(gateInput({ protectionRelevant: true, wetness: 0.8 }));
  assert.equal(dry.protectionBenefit, 0, '不相干的牌面上保护收益必须为 0');
  assert.ok(wet.protectionBenefit > 0, '有听牌/高张时必须记录保护收益');
});

/* ============================================================
 * 七、Blocker
 * ============================================================ */

test('BLK-1：同花面持有该花色必须算阻断价值；干面上持 A 高算阻断诈唬；修正有上限', () => {
  const onFlushBoard = assessBlockers({
    board: C('9c 7c 2d Ac'),
    heroHole: C('Kc Qd'),
    shape: 'HIGH_CARD',
    nutDensity: 0.5,
    airDensity: 0.2,
  });
  assert.ok(onFlushBoard.blocksValue > 0.3, `持有 ♣ 必须阻断同花价值，实际 ${onFlushBoard.blocksValue}`);

  const aceOnDry = assessBlockers({
    board: C('Kh 7s 2d'),
    heroHole: C('Ac Qd'),
    shape: 'HIGH_CARD',
    nutDensity: 0.2,
    airDensity: 0.4,
  });
  assert.ok(aceOnDry.blocksBluff > 0, '持 A 高必须阻断部分诈唬组合');

  for (const a of [onFlushBoard, aceOnDry]) {
    assert.ok(Math.abs(a.betDelta) <= EXPLOIT_MAX_DELTA + 1e-9, '阻断牌修正必须有上限');
    assert.ok(Math.abs(a.callDelta) <= EXPLOIT_MAX_DELTA + 1e-9);
    assert.ok(a.reasonsZh.length > 0);
  }
});

/* ============================================================
 * 八、独立 Bet Sizing
 * ============================================================ */

test('SIZE-1：尺寸必须随坚果优势/价值厚度/SPR/人数变化，且永远落在合法网格上', () => {
  const base = {
    nutAdvantage: 0.2,
    rangeAdvantage: 0.5,
    wetness: 0.3,
    valueThickness: 0.7,
    bluffShare: 0.2,
    spr: 6,
    opponentCount: 1,
    elasticity: 0.5,
    sizingCap: 1.5,
    exploitMultiplier: 1,
    protectionWeight: 0,
  };
  const normal = chooseSizing(base);
  const nutted = chooseSizing({ ...base, nutAdvantage: 0.9 });
  assert.ok(nutted.targetRatio > normal.targetRatio, '坚果优势更大 ⇒ 尺寸更大');

  const thin = chooseSizing({ ...base, valueThickness: 0.15 });
  assert.ok(thin.targetRatio < normal.targetRatio, '价值越薄 ⇒ 尺寸越小');

  const lowSpr = chooseSizing({ ...base, spr: 2 });
  assert.ok(lowSpr.targetRatio >= 0.8, '低 SPR ⇒ 尺寸被抬向承诺（至少接近一个底池）');

  /*
   * 🔴 审计抓到的 MAJOR 回归锁：**尺寸不得随 SPR 出现悬崖**。
   * 第一版是 `spr <= 3 ? max(ratio, 1) : ratio` ⇒ SPR 3.0 给 1.0、SPR 3.1 给 0.20,
   * 3% 的筹码深度变化造成 4 倍尺寸跳变。现在必须连续。
   */
  const at3 = chooseSizing({ ...base, spr: 3.0 });
  const at31 = chooseSizing({ ...base, spr: 3.1 });
  assert.ok(
    Math.abs(at3.targetRatio - at31.targetRatio) < 0.5,
    `SPR 3.0 与 3.1 的目标尺寸不得跳变：${at3.targetRatio} vs ${at31.targetRatio}`,
  );

  const multiway = chooseSizing({ ...base, opponentCount: 5 });
  assert.ok(multiway.targetRatio < normal.targetRatio, '多人池 ⇒ 尺寸收缩');

  for (const choice of [normal, nutted, thin, lowSpr, multiway]) {
    assert.ok(
      SIZING_GRID.includes(choice.gridRatio),
      `最终尺寸必须来自合法网格，实际 ${choice.gridRatio}`,
    );
    assert.ok(choice.reasonsZh.length > 0, '必须解释尺寸选择');
  }
});

test('SIZE-2：对手弹性必须由范围状态推出（越黏越高）', () => {
  const sticky = elasticityOf({ strengthFloor: 0.2, airDensity: 0.4, showdownDensity: 0.5 });
  const nitty = elasticityOf({ strengthFloor: 0.8, airDensity: 0.05, showdownDensity: 0.15 });
  assert.ok(sticky > nitty, `黏的对手弹性必须更高：${sticky} vs ${nitty}`);
});

/* ============================================================
 * 九、EV 评分与置信度
 * ============================================================ */

test('EV-1：置信度必须反映「首选比次选好多少」，与牌力无关', () => {
  const close: ActionScore[] = [
    { action: 'CHECK', normalizedEVScore: 0.6 },
    { action: 'BET_SMALL', normalizedEVScore: 0.58 },
  ];
  const far: ActionScore[] = [
    { action: 'CHECK', normalizedEVScore: 0.9 },
    { action: 'BET_SMALL', normalizedEVScore: 0.4 },
  ];
  assert.equal(confidenceOf(close).level, 'LOW', '分数接近 ⇒ 低置信度');
  assert.equal(confidenceOf(far).level, 'HIGH', '分数差距大 ⇒ 高置信度');
  assert.ok(confidenceOf(far).gap > confidenceOf(close).gap);

  assert.equal(confidenceOf([{ action: 'CHECK', normalizedEVScore: 1 }]).level, 'LOW', '没有可比对象 ⇒ 不声称确信');
});

test('EV-2：排序与偏好文案必须稳定（并明确不是 solver EV）', () => {
  const scores: ActionScore[] = [
    { action: 'BET_LARGE', normalizedEVScore: 0.4 },
    { action: 'CHECK', normalizedEVScore: 0.75 },
    { action: 'BET_SMALL', normalizedEVScore: 0.6 },
  ];
  assert.equal(preferenceZh(scores), 'CHECK > BET_SMALL > BET_LARGE');
  assert.deepEqual(
    rankActions(scores).map((s) => s.action),
    ['CHECK', 'BET_SMALL', 'BET_LARGE'],
  );
});

/* ============================================================
 * 十、Exploit 分层
 * ============================================================ */

test('EXPLOIT-1：画像只做**受约束**偏移，且未知画像不做任何偏移', () => {
  const unknown = exploitAdjustmentOf('UNKNOWN', { facingLargeAggression: true, drawCompleted: false });
  assert.equal(unknown.applied, false);
  assert.equal(unknown.thinValueDelta, 0);
  assert.equal(unknown.bluffCatchDelta, 0);

  const station = exploitAdjustmentOf('CALLING_STATION', { facingLargeAggression: false, drawCompleted: false });
  assert.ok(station.thinValueDelta > 0, '跟注站 ⇒ 薄价值提高');
  assert.ok(station.bluffDelta < 0, '跟注站 ⇒ 诈唬降低');
  assert.ok(station.sizingMultiplier > 1, '跟注站 ⇒ 价值尺寸放大');

  // 不诈唬型只在面对大额进攻时才显著降低抓诈唬
  const small = exploitAdjustmentOf('UNDERBLUFFER', { facingLargeAggression: false, drawCompleted: false });
  const large = exploitAdjustmentOf('UNDERBLUFFER', { facingLargeAggression: true, drawCompleted: false });
  assert.ok(large.bluffCatchDelta < small.bluffCatchDelta, '大额进攻下的抓诈唬意愿必须更低');

  const maniac = exploitAdjustmentOf('MANIAC', { facingLargeAggression: true, drawCompleted: false });
  assert.ok(maniac.bluffCatchDelta > 0, '过度诈唬 ⇒ 抓诈唬提高（防止永久 overfold）');

  // 全部画像的偏移都必须在硬上限内
  for (const profile of [
    'CALLING_STATION',
    'UNDERBLUFFER',
    'BLUFF_HEAVY',
    'MANIAC',
    'LOOSE',
    'VERY_LOOSE',
    'TIGHT',
    'VERY_TIGHT',
    'AGGRESSIVE',
  ] as const) {
    const a = exploitAdjustmentOf(profile, { facingLargeAggression: true, drawCompleted: true });
    for (const delta of [a.thinValueDelta, a.bluffCatchDelta, a.bluffDelta]) {
      assert.ok(Math.abs(delta) <= EXPLOIT_MAX_DELTA + 1e-9, `${profile} 的偏移必须受上限约束`);
    }
    assert.ok(a.applied, `${profile} 必须记录发生了偏移`);
    assert.ok(a.reasonsZh.length > 0, `${profile} 必须给出偏移理由`);
  }
});

test('EXPLOIT-2：🔴 「喜欢追听牌」不得自动等于「听牌没成就会诈唬」', () => {
  const completed = drawChaserNote({ street: 'RIVER', drawCompleted: true, aggressiveProfile: false });
  assert.match(String(completed), /价值密度上升/);

  const missedPassive = drawChaserNote({ street: 'RIVER', drawCompleted: false, aggressiveProfile: false });
  assert.match(String(missedPassive), /没有证据表明/);
  assert.ok(!/必然诈唬|一定诈唬|自动诈唬/.test(String(missedPassive)), '不得推出「必然诈唬」');

  const missedAggressive = drawChaserNote({ street: 'RIVER', drawCompleted: false, aggressiveProfile: true });
  assert.match(String(missedAggressive), /不因为「听牌没成」就假定他必然诈唬/);
});
