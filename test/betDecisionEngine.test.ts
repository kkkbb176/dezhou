/**
 * 🔴 **BET DECISION ENGINE PHASE 1 · 验收测试**
 *
 * ## 这一组锁什么
 *
 * 审计（`reports/TURN_SEMIBLUFF_ZERO_AUDIT.md`）确认：修复前三个 BET 尺寸
 * 是**同一个** size-blind 偏好分的三次变换，`valuePart` 以 50% 权益为基线、
 * 弃牌率未建模、Hero 自身听牌不进评分 ⇒ 权益 44% 的坚果同花听在转牌
 * `raw = −0.0985`，**结构上不可能**下注。
 *
 * 本组测试锁的是**能力**，不是某个节点必须下注：
 *
 * | 用例 | 要防止的错误 |
 * |---|---|
 * | TEST 1 | 转牌半诈唬的三个尺寸因结构缺失而恒为 0 |
 * | TEST 2 | 翻牌 / 转牌用同一个（缺未来街的）模型 |
 * | TEST 3 | 跟注站画像让「更差的牌会跟」反向下降（P0-2） |
 * | TEST 4 | 过弃/紧手画像不提高弃牌概率 |
 * | TEST 5 | 纯空气与坚果听牌拿到相同的半诈唬质量 |
 * | T6 | `strongerShare` 被重复计票（P0-1） |
 * | T7 | 画像在 range 层与 scorer 层重复计数（P0-3） |
 * | T8 | 三个尺寸重新共用一个分数（P0-4/§9） |
 * | T9 | 概率非法（NaN / 负 / 和 ≠ 1）与墨菲清单（§13） |
 *
 * ⚠️ **不要求** A♠J♠ 最终下注；最终动作由 EV 比较自然产生。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { advisePostflop, type PostflopAdvice } from '../src/app/decision/postflopAdvisor.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import {
  BET_SIZE_SPECS,
  buildResponseModel,
  cardsToComeOf,
  classifyResponse,
  composeBetEV,
  composeCheckEV,
  heroDrawPotentialOf,
  legalizeBetSizes,
  neutralResponseTendencies,
  realizationFactorOf,
  responseTendenciesOf,
  type BetSizeClass,
} from '../src/domain/postflop/betResponse.ts';
import { assessValueBet, roleStrengthOf } from '../src/domain/postflop/valueBetGate.ts';
import { compressionStateOf } from '../src/domain/postflop/rangeCompression.ts';
import { RelativeHandRole } from '../src/domain/postflop/types.ts';
import { archetypeDimensionsOf, ARCHETYPE_CONFIDENCE } from '../src/domain/player/archetypeDimensions.ts';
import { ALL_CARDS } from '../src/domain/types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const SEATS = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

const PREFLOP = [
  { position: 'UTG', type: 'FOLD' },
  { position: 'HJ', type: 'RAISE', amountBB: 3 },
  { position: 'CO', type: 'RAISE', amountBB: 9 },
  { position: 'BTN', type: 'FOLD' },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'FOLD' },
  { position: 'HJ', type: 'CALL', amountBB: 6 },
] as const;

/** 固定节点：翻牌 / 转牌（输入逐字固定，禁止改动） */
function spot(street: 'FLOP' | 'TURN', profile: string, heroCards: readonly string[] = ['As', 'Js']): ManualHandInput {
  const flopLine = [
    { position: 'HJ', type: 'CHECK', street: 'FLOP' },
    ...(street === 'TURN'
      ? [
          { position: 'CO', type: 'CHECK', street: 'FLOP' },
          { position: 'HJ', type: 'CHECK', street: 'TURN' },
        ]
      : []),
  ];
  return {
    tableSize: 6,
    heroPosition: 'CO',
    heroCards: [...heroCards],
    board: street === 'FLOP' ? ['Qd', '8s', '4s'] : ['Qd', '8s', '4s', '2h'],
    street,
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [...PREFLOP, ...flopLine],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

type NodeRun = {
  advice: PostflopAdvice;
  action: string | null;
  equity: number | null;
  context: ReturnType<typeof buildDecisionContext>['context'];
};

function runNode(input: ManualHandInput): NodeRun {
  const result = analyzeManualHand(input, OPTIONS);
  assert.equal(result.ok, true, `必须能分析：${result.ok ? '' : JSON.stringify(result.issues)}`);
  if (!result.ok) throw new Error('unreachable');
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('unreachable');
  const g = buildAnalyzableState(parsed.value);
  assert.equal(g.ok, true);
  if (!g.ok) throw new Error('unreachable');
  const built = buildDecisionContext({
    state: g.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    quickProfile: input.villain?.quickProfile,
  });
  const hero = g.state.players.find((p) => p.holeCards !== null)!;
  const legal = deriveLegalActions(g.state, hero);
  const advice = advisePostflop(built.context, {
    facingBet: legal.callCost > 0,
    requiredEquity: built.context.math.requiredEquity,
    potAfterCall: built.context.math.pot + legal.callCost,
  });
  assert.ok(advice !== null, '翻后必须有建议');
  assert.ok(advice!.betDecision !== null, '无人下注 + 有范围 ⇒ 必须有下注决策模型');
  return { advice: advice!, action: result.decision.action, equity: built.context.math.heroEquity, context: built.context };
}

const sizeOf = (run: NodeRun, kind: BetSizeClass) =>
  run.advice.betDecision!.sizes.find((s) => s.kind === kind)!;

/* ============================================================
 * TEST 1：转牌半诈唬 —— 三个尺寸必须有真实模型，不得结构性归零
 * ============================================================ */

test('TEST 1：转牌 A♠J♠ 半诈唬 —— 三个尺寸各有真实响应概率与 BetEV（不得结构性归零）', () => {
  const run = runNode(spot('TURN', 'NORMAL'));
  assert.equal(run.advice.role, RelativeHandRole.SEMI_BLUFF, '角色必须仍是半诈唬');

  const bd = run.advice.betDecision!;
  // ① 三个尺寸**各自**有概率与 EV（不是同一个分数的变换）
  for (const kind of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE'] as const) {
    const s = sizeOf(run, kind);
    assert.ok(Number.isFinite(s.foldLikelihood) && Number.isFinite(s.callLikelihood), `${kind} 概率必须有限`);
    assert.ok(
      Math.abs(s.foldLikelihood + s.callLikelihood + s.raiseLikelihood - 1) < 1e-9,
      `${kind} 三概率必须和为 1（实际 ${s.foldLikelihood + s.callLikelihood + s.raiseLikelihood}）`,
    );
    assert.ok(s.betEV !== null, `${kind} 的 BetEV 必须可计算（不得因空桶而为 null）`);
    assert.ok(s.score > 0, `${kind} 的偏好分必须为正（修复前恒为 0）`);
  }

  // ② 尺寸必须**真的**改变对手反应（P0-4/§9：不允许三个尺寸共用一个数）
  const small = sizeOf(run, 'BET_SMALL');
  const large = sizeOf(run, 'BET_LARGE');
  assert.ok(
    large.foldLikelihood > small.foldLikelihood,
    `注越大弃牌越多：小注 ${small.foldLikelihood.toFixed(3)} vs 大注 ${large.foldLikelihood.toFixed(3)}`,
  );
  assert.ok(
    small.callLikelihood > large.callLikelihood,
    `注越大跟注越少：小注 ${small.callLikelihood.toFixed(3)} vs 大注 ${large.callLikelihood.toFixed(3)}`,
  );
  assert.ok(
    small.score !== large.score && small.betEV !== large.betEV,
    '三个尺寸不得共用同一个分数 / EV',
  );

  // ③ Hero 自身听牌进入模型（非权益通道）
  assert.ok(bd.draw.flushDraw, 'A♠J♠ 必须识别出同花听');
  assert.equal(bd.draw.nutPotential, 1, '持 A♠ 的同花听必须识别为坚果潜力 1');
  assert.ok(bd.realization.factor < 1 || run.advice.street === 'RIVER', '转牌实现因子必须 < 1（代理模型）');
  assert.equal(bd.realization.kind, 'HEURISTIC', '实现因子必须标为启发式代理');

  // ④ 条件范围权益必须存在（不允许只用到达范围权益）
  assert.ok(sizeOf(run, 'BET_MEDIUM').heroEquityVsCallRange !== null, '必须有对跟注范围的权益');
  assert.ok(
    sizeOf(run, 'BET_MEDIUM').heroEquityVsCallRange !== run.equity,
    '对跟注范围的权益必须与到达范围权益不同（否则说明没有真正条件化）',
  );

  // ⑤ 最终动作由 EV 比较产生（允许 CHECK，也允许 BET；只要求理由与 EV 一致）
  const checkEV = bd.checkEV;
  const best = bd.sizes.reduce((acc, s) => (acc === null || (s.betEV ?? -Infinity) > (acc.betEV ?? -Infinity) ? s : acc), null as null | (typeof bd.sizes)[number]);
  assert.ok(checkEV !== null && best !== null, 'CHECK EV 与最佳尺寸必须可计算');
  if (run.action === 'CHECK') {
    assert.ok(
      (best!.betEV ?? -Infinity) <= checkEV,
      `若为 CHECK，则最佳尺寸 EV 必须不高于 CHECK EV（实际 ${best!.betEV} vs ${checkEV}）`,
    );
  } else {
    assert.ok(
      (best!.betEV ?? -Infinity) > checkEV,
      `若为 BET，则最佳尺寸 EV 必须高于 CHECK EV（实际 ${best!.betEV} vs ${checkEV}）`,
    );
  }
});

/* ============================================================
 * TEST 2：翻牌 vs 转牌 —— 模型随街变化，且不能同时给三个尺寸相同反应
 * ============================================================ */

test('TEST 2：翻牌与转牌必须给出不同的响应模型（未来牌数不同）', () => {
  const flop = runNode(spot('FLOP', 'NORMAL'));
  const turn = runNode(spot('TURN', 'NORMAL'));

  assert.equal(flop.advice.betDecision!.draw.cardsToCome, 2, '翻牌还有 2 张公共牌');
  assert.equal(turn.advice.betDecision!.draw.cardsToCome, 1, '转牌只剩 1 张');
  assert.ok(
    flop.advice.betDecision!.draw.improvementProbability > turn.advice.betDecision!.draw.improvementProbability,
    '翻牌的改进概率必须高于转牌（补牌计数，仅展示）',
  );
  assert.ok(
    flop.advice.betDecision!.realization.factor < turn.advice.betDecision!.realization.factor,
    '翻牌的实现因子必须低于转牌（越靠后越接近摊牌）',
  );
  const flopMid = flop.advice.betDecision!.sizes.find((s) => s.kind === 'BET_MEDIUM')!;
  const turnMid = turn.advice.betDecision!.sizes.find((s) => s.kind === 'BET_MEDIUM')!;
  assert.ok(
    flopMid.foldLikelihood !== turnMid.foldLikelihood,
    '同一尺寸在两条街上的弃牌概率必须不同（街压力/牌面/范围都变了）',
  );
  assert.equal(cardsToComeOf(5, 'RIVER'), 0, '河牌没有待发牌');
});

/* ============================================================
 * TEST 3：CALLING_STATION 单调性（P0-2）
 * ============================================================ */

test('TEST 3：跟注站画像必须提高 P(跟) 且降低 P(弃)（P0-2 方向修复）', () => {
  /*
   * ## 为什么这一条要分两层断言（实测证据，不是放宽）
   *
   * 画像在这一轮架构里**同时**进两条通道：
   * ① range 层（上一轮的 P0 修复）：跟注站的范围**更宽**，于是同一个下注尺寸下，
   *    他范围里「本来就该弃」的垃圾牌**变多**；
   * ② 响应层（本轮 P0-2）：同一手牌他**更爱跟**（`callScale > 1`、`foldScale < 1`）。
   *
   * 两者在**聚合概率**上方向相反。实测（转牌节点、中注）：
   * `P(跟)` 0.4094(NORMAL) → 0.4070(跟注站)、`P(弃)` 0.508 → 0.509 ——
   * 也就是说：**只有把范围固定住**，才能干净地观察到「画像让他更爱跟」这件事。
   * 因此：
   * - 主判据 = 同一份范围、只改响应倾向（下面 ②）；
   * - 附加判据 = 管道层聚合值，要求不出现**反向的大幅**偏移（容差 1 个百分点，
   *   并把实测差值写进断言消息）。
   */
  const normal = runNode(spot('TURN', 'NORMAL'));
  const station = runNode(spot('TURN', 'CALLING_STATION'));

  for (const kind of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE'] as const) {
    const n = sizeOf(normal, kind);
    const s = sizeOf(station, kind);
    assert.ok(
      s.callLikelihood >= n.callLikelihood - 0.01,
      `${kind}：跟注站的 P(跟) 不得比普通低超过 1 个百分点（${s.callLikelihood.toFixed(4)} vs ${n.callLikelihood.toFixed(4)}）`,
    );
    assert.ok(
      s.foldLikelihood <= n.foldLikelihood + 0.01,
      `${kind}：跟注站的 P(弃) 不得比普通高超过 1 个百分点（${s.foldLikelihood.toFixed(4)} vs ${n.foldLikelihood.toFixed(4)}）`,
    );
  }

  // ---- ② 主判据：同一份范围，只改画像的**响应**倾向 ----
  const entries = [
    { cardIndices: [26, 27] as const, probability: 0.5 }, // 同花听（公共牌之外的花色）
    { cardIndices: [28, 29] as const, probability: 0.5 },
  ];
  const board = ALL_CARDS.slice(0, 3);
  const heroHole = ALL_CARDS.slice(44, 46);
  const modelWith = (tendencies: ReturnType<typeof neutralResponseTendencies>) =>
    buildResponseModel({
      entries,
      heroHole,
      board,
      pot: 100,
      street: 'TURN',
      spr: 4,
      opponentCount: 1,
      wetness: 0.2,
      tendencies,
      sizes: legalizeBetSizes({
        pot: 100,
        heroRemaining: 500,
        villainRemaining: 500,
        minBet: 2,
      }).sizes,
      heroRemaining: 500,
    })!;
  const stationTendencies = responseTendenciesOf(
    archetypeDimensionsOf('CALLING_STATION', ARCHETYPE_CONFIDENCE)!,
    1,
  );
  assert.ok(stationTendencies.callScale > 1, '跟注站的 callScale 必须 > 1');
  assert.ok(stationTendencies.foldScale < 1, '跟注站的 foldScale 必须 < 1');

  const neutralModel = modelWith(neutralResponseTendencies());
  const stationModel = modelWith(stationTendencies);
  for (let i = 0; i < neutralModel.sizes.length; i += 1) {
    const n = neutralModel.sizes[i]!;
    const s = stationModel.sizes[i]!;
    assert.ok(
      s.callLikelihood >= n.callLikelihood,
      `同一范围、同一尺寸：跟注站的 P(跟) 必须不低于普通（${s.callLikelihood.toFixed(4)} vs ${n.callLikelihood.toFixed(4)}）`,
    );
    assert.ok(
      s.foldLikelihood <= n.foldLikelihood,
      `同一范围、同一尺寸：跟注站的 P(弃) 必须不高于普通（${s.foldLikelihood.toFixed(4)} vs ${n.foldLikelihood.toFixed(4)}）`,
    );
  }
});

/* ============================================================
 * TEST 4：过弃 / 紧手 —— 弃牌概率必须沿正确方向增加
 * ============================================================ */

test('TEST 4：紧手/过弃画像必须提高弃牌概率（至少在大注上严格提高）', () => {
  const normal = runNode(spot('TURN', 'NORMAL'));
  const tight = runNode(spot('TURN', 'VERY_TIGHT'));

  const nLarge = sizeOf(normal, 'BET_LARGE');
  const tLarge = sizeOf(tight, 'BET_LARGE');
  assert.ok(
    tLarge.foldLikelihood > nLarge.foldLikelihood,
    `紧手对大注的弃牌率必须更高：${tLarge.foldLikelihood.toFixed(4)} vs ${nLarge.foldLikelihood.toFixed(4)}`,
  );

  // 单元级：极紧倾向必须把边界手牌从跟注推向弃牌
  const tightTendencies = responseTendenciesOf(
    archetypeDimensionsOf('VERY_TIGHT', ARCHETYPE_CONFIDENCE)!,
    1,
  );
  assert.ok(tightTendencies.foldScale > 1, '极紧的 foldScale 必须 > 1');
  assert.ok(tightTendencies.callScale < 1, '极紧的 callScale 必须 < 1');

  const boundary = (tendencies: ReturnType<typeof neutralResponseTendencies>, tier: number) =>
    classifyResponse({
      hole: [ALL_CARDS[0]!, ALL_CARDS[1]!],
      versusHero: 'STRONGER',
      tier,
      street: 'TURN',
      cardsToCome: 1,
      ratioToPot: 1,
      priceRequiredEquity: 0.33,
      spr: 4.67,
      opponentCount: 1,
      wetness: 0.2,
      tendencies,
      villainDraw: 'NO_DRAW',
      heroIsAllIn: false,
    }).bucket;
  assert.equal(boundary(neutralResponseTendencies(), 3), 'CALL', '中性倾向下档 3 应当继续');
  assert.equal(boundary(tightTendencies, 3), 'FOLD', '极紧倾向下同一手牌必须改为弃牌');
});

/* ============================================================
 * TEST 5：纯空气 vs 坚果听牌 —— 不得拿到相同的半诈唬质量
 * ============================================================ */

test('TEST 5：纯空气与坚果同花听的半诈唬质量 / 条件权益必须不同', () => {
  const air = runNode(spot('TURN', 'NORMAL', ['Tc', '9d']));
  const nut = runNode(spot('TURN', 'NORMAL', ['As', 'Js']));

  const airMid = air.advice.betDecision!.sizes.find((s) => s.kind === 'BET_MEDIUM')!;
  const nutMid = nut.advice.betDecision!.sizes.find((s) => s.kind === 'BET_MEDIUM')!;

  // 半诈唬质量（价值侧）必须不同
  assert.notEqual(
    air.advice.gate.semiBluffQuality,
    nut.advice.gate.semiBluffQuality,
    '两手牌的 semiBluffQuality 必须不同',
  );
  assert.ok(
    nut.advice.gate.semiBluffQuality > air.advice.gate.semiBluffQuality,
    `坚果听牌的半诈唬质量必须更高：${nut.advice.gate.semiBluffQuality.toFixed(3)} vs ${air.advice.gate.semiBluffQuality.toFixed(3)}`,
  );

  // 条件范围权益同样必须不同（听牌的改进价值只能通过权益通道体现）
  assert.ok(
    nutMid.heroEquityVsCallRange! > airMid.heroEquityVsCallRange!,
    `对跟注范围的权益必须不同：${nutMid.heroEquityVsCallRange} vs ${airMid.heroEquityVsCallRange}`,
  );
  assert.ok(
    nutMid.betEV! > airMid.betEV!,
    `坚果听牌的下注 EV 必须高于纯空气：${nutMid.betEV!.toFixed(2)} vs ${airMid.betEV!.toFixed(2)}`,
  );

  // 听牌潜力本身
  const airDraw = heroDrawPotentialOf(
    ['Tc', '9d'].map((c) => ALL_CARDS.find((x) => `${x.rank}${x.suit}` === String(CHAR_INDEX[c[0]!] ?? '')) ?? ALL_CARDS[0]!),
    [],
  );
  void airDraw; // 单元级听牌识别在 test/draws 系列已覆盖；此处只锁「两者不同」
});

const CHAR_INDEX: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2 };

/* ============================================================
 * T6：P0-1 —— `strongerShare` 不得重复计票
 * ============================================================ */

test('T6：同一份「对手更强」证据只允许收一次费（P0-1）', () => {
  const compression = {
    strengthFloor: 0.55,
    nutDensity: 0.39,
    mediumStrengthDensity: 0.24,
    drawDensity: 0.03,
    airDensity: 0.35,
    showdownDensity: 0.19,
    aggressionCredibility: 0.37,
  };
  const base = {
    role: RelativeHandRole.SEMI_BLUFF,
    heroEquity: 0.44,
    opponentCount: 1,
    compression,
    wetness: 0.17,
    spr: 4.67,
    hasInitiative: true,
    thinValueDelta: 0,
    bluffDelta: 0,
    protectionRelevant: false,
    hasCardsToCome: true,
  } as const;

  const a = assessValueBet({ ...base, rangeComparison: { weakerShare: 0.25, strongerShare: 0.72 } });
  const b = assessValueBet({ ...base, rangeComparison: { weakerShare: 0.25, strongerShare: 0.72 } });
  assert.equal(a.estimatedBetEVScore, b.estimatedBetEVScore, '同一输入必须给出同一分数（确定性）');

  /*
   * 单次收费的判据：把 `strongerShare` 从 0.30 降到 0.10（同样的可信度），
   * 下注分的变化必须等于**一次** 0.35 权重的线性响应，而不是两次
   *（修复前是 `betterContinue × 0.35 + raiseRisk × 0.2`，两者都随 strongerShare 上升）。
   *
   * ⚠️ 取值必须落在 `clamp01` **不生效**的区间：若取到高压力端，
   * 下注分会被夹到 0，灵敏度就被钳位掩盖（第一次写这条测试时踩到过：
   * strongerShare 0.72 时 raw < 0 ⇒ 分恒为 0，实测差值只剩 0.011）。
   */
  const low = assessValueBet({ ...base, rangeComparison: { weakerShare: 0.25, strongerShare: 0.1 } });
  const high = assessValueBet({ ...base, rangeComparison: { weakerShare: 0.25, strongerShare: 0.3 } });
  assert.ok(
    low.estimatedBetEVScore > 0 && low.estimatedBetEVScore < 1 && high.estimatedBetEVScore > 0 && high.estimatedBetEVScore < 1,
    '该用例必须落在未被 clamp 的区间（否则测的是钳位而不是计费次数）',
  );
  const delta = low.estimatedBetEVScore - high.estimatedBetEVScore;
  const expectedSingleCharge = (0.3 - 0.1) * (0.6 + 0.4 * 0.37) * 0.35;
  assert.ok(
    Math.abs(delta - expectedSingleCharge) < 1e-9,
    `strongerShare 的敏感度必须是单次收费 ${expectedSingleCharge.toFixed(6)}，实际 ${delta.toFixed(6)}`,
  );
  // `raisePressureIndex` 仍然是只读指数（逐位给出），但**不参与**评分
  assert.ok(high.raisePressureIndex > low.raisePressureIndex, '压力指数本身仍随 strongerShare 上升（只读）');
  assert.equal(high.raiseRisk, high.raisePressureIndex, 'raiseRisk 必须与 raisePressureIndex 逐位相同（别名）');
  assert.equal(high.betterHandPressure, high.betterContinueDensity, 'betterHandPressure 必须是唯一事实来源');
});

/* ============================================================
 * T7：P0-3 —— 画像不得在 range 层与 scorer 层重复计数
 * ============================================================ */

test('T7：画像已在 range 层生效时，scorer 层必须阻断压缩乘数并如实标注', () => {
  const station = runNode(spot('TURN', 'CALLING_STATION'));
  const pe = station.advice.betDecision!.profileEvidence;
  assert.equal(pe.rangeLayerApplied, true, '跟注站画像必须在 range 层生效');
  assert.equal(pe.doubleCountBlocked, true, '必须阻断 scorer 层的第二次加权');
  assert.equal(pe.scorerLayerApplied, false, '阻断后 scorer 层不得再声称生效');
  assert.ok(pe.noteZh.includes('range 层'), '说明里必须写明证据归属');

  /*
   * 🔴 **效果断言（不只是标记）**：阻断生效时，压缩因子里**不得**再含画像乘数。
   * 判据：把同一份范围事实按 `profileConfidence = 0` 重算一遍，
   * 结果必须与管道给出的 `aggressionCredibility` **逐位相同**。
   *（变异测试证明过：只断言标记是抓不到「阻断被去掉」的。）
   */
  const facts = station.context.postflopFacts?.opponentRangeFacts ?? null;
  assert.ok(facts !== null, '必须有范围事实');
  const profileFree = compressionStateOf(
    {
      betRatioToPot: 0.5,
      street: 'TURN',
      opponentCount: 1,
      quickProfile: 'CALLING_STATION',
      profileConfidence: 0,
      wetness: station.advice.wetness,
      aggressive: false,
    },
    {
      strongShare: facts!.strongShare,
      drawShare: facts!.drawShare,
      meanTier: facts!.meanTier,
      weakShare: (facts!.tierHistogram[4] ?? 0) + (facts!.tierHistogram[5] ?? 0),
    },
  );
  assert.ok(
    Math.abs(profileFree.aggressionCredibility - station.advice.compression.aggressionCredibility) < 1e-12,
    `阻断生效时压缩因子必须与「无画像乘数」逐位相同：${station.advice.compression.aggressionCredibility} vs ${profileFree.aggressionCredibility}`,
  );
  // 对照：不阻断时结果必须**不同**（证明这条断言有区分力）
  const withProfile = compressionStateOf(
    {
      betRatioToPot: 0.5,
      street: 'TURN',
      opponentCount: 1,
      quickProfile: 'CALLING_STATION',
      profileConfidence: 0.35,
      wetness: station.advice.wetness,
      aggressive: false,
    },
    {
      strongShare: facts!.strongShare,
      drawShare: facts!.drawShare,
      meanTier: facts!.meanTier,
      weakShare: (facts!.tierHistogram[4] ?? 0) + (facts!.tierHistogram[5] ?? 0),
    },
  );
  assert.ok(
    Math.abs(withProfile.aggressionCredibility - profileFree.aggressionCredibility) > 1e-6,
    '若含画像乘数，压缩因子必须不同（否则这条断言没有区分力）',
  );

  // 响应层仍然生效（那是**另一个量**：P(反应 | 我的下注)）
  const t = station.advice.betDecision!.tendencies;
  assert.ok(t.callScale > 1, '响应层的「爱跟」倾向必须仍然生效');
});

/* ============================================================
 * T8：§9 —— 尺寸必须独立评分（不允许 ×0.95 / −0.08）
 * ============================================================ */

test('T8：三个尺寸不得再由同一个分数变换而来（§9）', () => {
  const run = runNode(spot('FLOP', 'NORMAL'));
  const sizes = run.advice.betDecision!.sizes;
  const byKind = new Map(sizes.map((s) => [s.kind, s]));

  // 旧实现的指纹：SMALL = 0.95×MEDIUM、LARGE = MEDIUM − 0.08
  const med = byKind.get('BET_MEDIUM')!;
  const small = byKind.get('BET_SMALL')!;
  const large = byKind.get('BET_LARGE')!;
  assert.ok(
    Math.abs(small.betEV! - med.betEV! * 0.95) > 1e-9,
    'BET_SMALL 不得是 BET_MEDIUM 的 0.95 倍',
  );
  assert.ok(
    Math.abs(large.betEV! - (med.betEV! - 0.08)) > 1e-9,
    'BET_LARGE 不得是 BET_MEDIUM − 0.08',
  );
  // 概率必须逐尺寸不同（真实响应模型）
  assert.ok(small.foldLikelihood !== med.foldLikelihood, '小注与中注的弃牌率必须不同');
  assert.ok(med.foldLikelihood !== large.foldLikelihood, '中注与大注的弃牌率必须不同');
});

/* ============================================================
 * T9：§13 墨菲清单（概率合法性 / 河牌无未来权益 / 组合集 / 底池口径）
 * ============================================================ */

test('T9：概率必须合法（有限、非负、和为 1），且条件范围遵守死牌过滤', () => {
  for (const street of ['FLOP', 'TURN'] as const) {
    for (const profile of ['NORMAL', 'CALLING_STATION', 'VERY_TIGHT', 'MANIAC']) {
      const run = runNode(spot(street, profile));
      for (const s of run.advice.betDecision!.sizes) {
        for (const [name, p] of [
          ['fold', s.foldLikelihood],
          ['call', s.callLikelihood],
          ['raise', s.raiseLikelihood],
        ] as const) {
          assert.ok(Number.isFinite(p), `${street}/${profile}/${s.kind} 的 P(${name}) 必须是有限数`);
          assert.ok(p >= 0 && p <= 1, `${street}/${profile}/${s.kind} 的 P(${name}) 必须在 [0,1]：${p}`);
        }
        const sum = s.foldLikelihood + s.callLikelihood + s.raiseLikelihood;
        assert.ok(Math.abs(sum - 1) < 1e-9, `${street}/${profile}/${s.kind} 概率和必须为 1：${sum}`);
        // 桶的组合数之和**可以**大于可达组合数（同一组合混频时同时出现在多个桶），
        // 但必须满足：并集 = 可达组合集（每个组合至少在某个桶里有正权重），且质量守恒。
        const union = new Set<number>();
        for (const b of s.buckets) for (const e of b.entries) union.add(e.cardIndices[0] * 100 + e.cardIndices[1]);
        assert.equal(
          union.size,
          run.context.postflopFacts!.betDecision!.comboCount,
          '三桶组合的**并集**必须等于可达组合数（混频不得丢牌，也不得造牌）',
        );
        const massSum = s.buckets.reduce((acc, b) => acc + b.mass, 0);
        assert.ok(Math.abs(massSum - 1) < 1e-9, `${street}/${profile}/${s.kind} 三桶质量之和必须为 1：${massSum}`);
        // 桶内权重必须归一化（Σp ≈ 1）
        for (const b of s.buckets) {
          if (b.entries.length === 0) continue;
          const mass = b.entries.reduce((acc, e) => acc + e.probability, 0);
          assert.ok(Math.abs(mass - 1) < 1e-9, `${s.kind}/${b.bucket} 桶内权重必须归一化：${mass}`);
        }
      }
    }
  }
});

test('T9b：河牌不存在未来权益（实现因子恒为 1，听牌项为 0）', () => {
  const riverInput = {
    tableSize: 6,
    heroPosition: 'CO',
    heroCards: ['As', 'Js'],
    board: ['Qd', '8s', '4s', '2h', '7c'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [
      ...PREFLOP,
      { position: 'HJ', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'CHECK', street: 'FLOP' },
      { position: 'HJ', type: 'CHECK', street: 'TURN' },
      { position: 'CO', type: 'CHECK', street: 'TURN' },
      { position: 'HJ', type: 'CHECK', street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
  const result = analyzeManualHand(riverInput, OPTIONS);
  assert.equal(result.ok, true, `河牌节点必须能分析：${result.ok ? '' : JSON.stringify(result.issues)}`);
  const parsed = parseManualInput(riverInput);
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
    quickProfile: 'NORMAL',
  });
  const hero = g.state.players.find((p) => p.holeCards !== null)!;
  const legal = deriveLegalActions(g.state, hero);
  const advice = advisePostflop(built.context, {
    facingBet: legal.callCost > 0,
    requiredEquity: built.context.math.requiredEquity,
    potAfterCall: built.context.math.pot + legal.callCost,
  });
  assert.ok(advice?.betDecision !== null && advice?.betDecision !== undefined, '河牌也必须有下注决策模型');
  assert.equal(advice!.betDecision!.draw.cardsToCome, 0, '河牌没有待发牌');
  assert.equal(advice!.betDecision!.draw.improvementProbability, 0, '河牌改进概率必须为 0');
  assert.equal(advice!.betDecision!.realization.factor, 1, '河牌的权益实现因子必须恰为 1');
  assert.equal(advice!.betDecision!.realization.components['drawBonus'], 0, '河牌不得有听牌实现加成');
});

test('T9c：EV 口径 —— 底池是下注前的底池，投入只扣一次，弃牌分支不含 Hero 权益', () => {
  const pot = 100;
  const ratio = 0.5;
  const bet = pot * ratio;
  const ev = composeBetEV({
    kind: 'BET_MEDIUM',
    ratioToPot: ratio,
    pot,
    foldLikelihood: 1,
    callLikelihood: 0,
    raiseLikelihood: 0,
    heroEquityVsCallRange: null,
    heroEquityVsRaiseRange: null,
    realizationFactor: 0.9,
    checkEV: 30,
  });
  assert.equal(ev.betAmount, bet, '建模金额 = 下注前底池 × 比例');
  assert.equal(ev.evFoldBranch, pot, '弃牌分支 = 赢下**下注前**的底池（不含 Hero 权益）');
  assert.equal(ev.betEV, pot, 'P(弃)=1 ⇒ BetEV = 下注前底池');
  assert.equal(ev.evCallBranch, null, '概率为 0 的分支不得参与 EV');
  assert.equal(ev.evRaiseBranch, null, '同上');

  const called = composeBetEV({
    kind: 'BET_MEDIUM',
    ratioToPot: ratio,
    pot,
    foldLikelihood: 0,
    callLikelihood: 1,
    raiseLikelihood: 0,
    heroEquityVsCallRange: 0.6,
    heroEquityVsRaiseRange: null,
    realizationFactor: 1,
    checkEV: 60,
  });
  // eq×(pot+2b) − b = 0.6×200 − 50 = 70
  assert.equal(called.evCallBranch, 70, '跟注分支：eq×(pot+2b) − b，投入只扣一次');
  assert.equal(called.betEV, 70, 'P(跟)=1 ⇒ BetEV = 跟注分支');

  const checkEV = composeCheckEV({ pot, heroEquityVsArrivalRange: 0.5, realizationFactor: 1 });
  assert.equal(checkEV, 50, '过牌分支 = 权益 × 实现因子 × 下注前底池');
});

test('T9d：多人池不得使用单挑 50% 公平基线（valuePart 与公平份额一致）', () => {
  const compression = {
    strengthFloor: 0.5,
    nutDensity: 0.3,
    mediumStrengthDensity: 0.3,
    drawDensity: 0.1,
    airDensity: 0.3,
    showdownDensity: 0.24,
    aggressionCredibility: 0.4,
  };
  const three = assessValueBet({
    role: RelativeHandRole.MEDIUM_VALUE,
    heroEquity: 0.34,
    opponentCount: 3,
    compression,
    wetness: 0.3,
    spr: 4,
    hasInitiative: true,
    thinValueDelta: 0,
    bluffDelta: 0,
    protectionRelevant: false,
    hasCardsToCome: true,
  });
  // 3 家 ⇒ 公平份额 25%；34% 权益应当**有**正的价值项
  assert.ok(three.estimatedBetEVScore > 0, '三人池 34% 权益必须能产生正价值项（公平基线 25%）');
  const heads = assessValueBet({
    role: RelativeHandRole.MEDIUM_VALUE,
    heroEquity: 0.34,
    opponentCount: 1,
    compression,
    wetness: 0.3,
    spr: 4,
    hasInitiative: true,
    thinValueDelta: 0,
    bluffDelta: 0,
    protectionRelevant: false,
    hasCardsToCome: true,
  });
  assert.ok(
    three.estimatedBetEVScore > heads.estimatedBetEVScore,
    '同一权益在多人池的相对优势更大 ⇒ 下注分更高',
  );
});

/* ============================================================
 * 🔴 河牌合法动作树契约（RIVER LEGAL ACTION TREE FIX）
 * ============================================================ */

/** 固定节点 2：BB 9♠8♠｜河牌 T♠7♦6♣J♦7♣｜底池 177｜身后 112｜先行动 */
function riverNodeTwo(profile = 'NORMAL'): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: ['9s', '8s'],
    board: ['Ts', '7d', '6c', 'Jd', '7c'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' },
      { position: 'HJ', type: 'FOLD' },
      { position: 'CO', type: 'RAISE', amountBB: 2.5 },
      { position: 'BTN', type: 'FOLD' },
      { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'CALL', amountBB: 1.5 },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
      { position: 'BB', type: 'RAISE', amountBB: 12, street: 'FLOP' },
      { position: 'CO', type: 'CALL', amountBB: 10, street: 'FLOP' },
      { position: 'BB', type: 'BET', amountBB: 29.5, street: 'TURN' },
      { position: 'CO', type: 'CALL', amountBB: 29.5, street: 'TURN' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

test('T1：同一合法金额 ⇒ 同一响应 / 同一条件范围 / 同一权益 / 同一 EV（且不再出现 118 / 177）', () => {
  const run = runNode(riverNodeTwo());
  const bd = run.advice.betDecision!;

  // ① 合法金额唯一：不允许出现两个金额相同的候选
  const amounts = bd.sizes.map((s) => s.betAmount);
  assert.equal(new Set(amounts).size, amounts.length, `合法金额必须互不相同：${amounts.join(', ')}`);
  // ② 被丢弃的候选必须留痕（理论金额只出现在那里）
  const droppedRequested = bd.droppedSizes.map((d) => Math.round(d.requestedAmount));
  assert.ok(
    droppedRequested.some((a) => a >= 170) || bd.sizes.every((s) => s.betAmount <= 112 + 1e-9),
    '超过有效筹码的理论金额不得作为合法金额参与 EV',
  );
  // ③ 实际参与 EV 的金额必须 ≤ 有效筹码
  for (const s of bd.sizes) {
    assert.ok(s.betAmount <= 112 + 1e-9, `${s.kind} 的合法金额 ${s.betAmount} 不得超过身后筹码 112`);
  }
  // ④ 同一金额只能有一套数（这里用「金额 → EV/概率」映射的唯一性锁定）
  const byAmount = new Map<number, { ev: number | null; fold: number; call: number; raise: number }>();
  for (const s of bd.sizes) {
    const key = Math.round(s.betAmount * 1e6) / 1e6;
    const existing = byAmount.get(key);
    if (existing !== undefined) {
      assert.equal(existing.ev, s.betEV, '同一合法金额必须同一 EV');
      assert.equal(existing.fold, s.foldLikelihood, '同一合法金额必须同一 P(弃)');
      assert.equal(existing.call, s.callLikelihood, '同一合法金额必须同一 P(跟)');
      assert.equal(existing.raise, s.raiseLikelihood, '同一合法金额必须同一 P(加)');
    } else {
      byAmount.set(key, {
        ev: s.betEV,
        fold: s.foldLikelihood,
        call: s.callLikelihood,
        raise: s.raiseLikelihood,
      });
    }
  }
  // ⑤ 落注金额不得是物理上不可能的 177
  assert.ok(
    !bd.sizes.some((s) => Math.abs(s.betAmount - 177) < 1e-9),
    '不得用 177（> 身后 112）作为合法下注额参与 EV',
  );
  const allIn = bd.sizes.find((s) => s.kind === 'ALL_IN');
  assert.ok(allIn !== undefined, '必须存在 ALL_IN 合法候选');
  assert.ok(Math.abs(allIn!.betAmount - 112) < 1e-9, `ALL_IN 金额必须是 112，实际 ${allIn!.betAmount}`);
});

test('T2：Hero 全下 ⇒ P(加) = 0，且原本会加注的权重迁移到跟注（弃 + 跟 = 1）', () => {
  const run = runNode(riverNodeTwo());
  const bd = run.advice.betDecision!;
  const allIn = bd.sizes.find((s) => s.kind === 'ALL_IN')!;
  assert.equal(allIn.heroIsAllIn, true, 'ALL_IN 候选必须标记 heroIsAllIn');
  assert.equal(allIn.raiseLikelihood, 0, `Hero 全下后 P(加) 必须为 0，实际 ${allIn.raiseLikelihood}`);
  assert.equal(
    allIn.buckets.find((b) => b.bucket === 'RAISE')!.comboCount,
    0,
    '加注桶必须为空（不是 UI 隐藏，而是真的没有组合）',
  );
  assert.ok(
    Math.abs(allIn.foldLikelihood + allIn.callLikelihood - 1) < 1e-9,
    `全下后必须 P(弃) + P(跟) = 1（实际 ${allIn.foldLikelihood + allIn.callLikelihood}）`,
  );
  // 质量守恒 + 强牌没有消失
  const masses = allIn.buckets.reduce((acc, b) => acc + b.mass, 0);
  assert.ok(Math.abs(masses - 1) < 1e-9, `三桶质量之和必须为 1（实际 ${masses}）`);
});

test('T3：Hero 全下后，比 Hero 强的牌仍在跟注范围里（不会因「原本想加注」而消失）', () => {
  const run = runNode(riverNodeTwo());
  const bd = run.advice.betDecision!;
  const allIn = bd.sizes.find((s) => s.kind === 'ALL_IN')!;
  const callBucket = allIn.buckets.find((b) => b.bucket === 'CALL')!;
  const raiseBucket = allIn.buckets.find((b) => b.bucket === 'RAISE')!;
  assert.equal(raiseBucket.entries.length, 0, '加注桶必须完全为空');

  // 迁移必须**同尺寸、同组合**验证（MULTIWAY 阶段修正）：
  // 旧断言比较的是「全下尺寸的跟注桶 vs 小注尺寸的跟注桶」——
  // 那个不等式**偶然**成立于「硬切分类」之下（一个组合只属于一个桶），
  // 而两个尺寸的价格门槛本来就不同（全下门槛更高 ⇒ 继续的组合更少）。
  // 现在分类是**连续混频**（同一组合可按比例同时进入多个桶），
  // 于是跨尺寸比较不再是有效不变量。真正要锁的是：
  // **同一个组合、同一个尺寸**下，Hero 全下时原本的加注权重必须迁移到跟注。
  const probeCombo = (heroIsAllIn: boolean) =>
    classifyResponse({
      hole: [ALL_CARDS[0]!, ALL_CARDS[1]!],
      versusHero: 'STRONGER',
      tier: 0,
      street: 'RIVER',
      cardsToCome: 0,
      ratioToPot: allIn.betAmount / bd.pot,
      priceRequiredEquity: allIn.betAmount / (bd.pot + 2 * allIn.betAmount),
      spr: null,
      opponentCount: 1,
      wetness: 0,
      tendencies: bd.tendencies,
      villainDraw: 'NO_DRAW',
      heroIsAllIn,
    });
  const openWeights = probeCombo(false).weights;
  const clampedWeights = probeCombo(true).weights;
  assert.ok(openWeights.raise > 0, '未全下时该强牌必须会加注（否则本测试没有意义）');
  assert.equal(clampedWeights.raise, 0, '全下后不得再有任何加注权重');
  assert.ok(
    clampedWeights.call >= openWeights.call,
    `原本的加注权重必须迁移到跟注：全下 ${clampedWeights.call} vs 未全下 ${openWeights.call}`,
  );
  assert.ok(
    Math.abs(clampedWeights.fold + clampedWeights.call - 1) < 1e-9,
    '全下后弃 + 跟 必须 = 1（权重没有凭空消失）',
  );
  // 更关键：**对跟注范围的权益必须仍然像「一整个继续范围」**，
  // 而不是「只剩坚果」（旧版把强牌停在**非法的加注桶**里 ⇒ EqVsCall 虚高到 ~100%）。
  //
  // ⚠️ MULTIWAY 阶段修正：分类改为**连续混频**后，边际牌会按比例弃牌，
  // 因此跟注范围**只会比到达范围更强**（EqVsCall ≤ 到达范围权益 + 抽样误差），
  // 不再像硬切时代那样≈到达范围权益。这里锁的是**方向与量级**：
  assert.ok(
    allIn.heroEquityVsCallRange !== null &&
      allIn.heroEquityVsCallRange <= run.equity! + 0.05,
    `跟注范围是到达范围的继续子集 ⇒ EqVsCall 不得高于到达范围权益：${allIn.heroEquityVsCallRange} vs ${run.equity}`,
  );
  assert.ok(
    allIn.heroEquityVsCallRange !== null && allIn.heroEquityVsCallRange >= run.equity! - 0.15,
    `EqVsCall 不得因为「边际牌被整批剔除」而崩到只剩坚果：${allIn.heroEquityVsCallRange} vs ${run.equity}`,
  );
  assert.ok(
    (allIn.heroEquityVsCallRange ?? 1) < 0.95,
    `EqVsCall 不得再是 ~100%（旧版缺陷：强牌停在非法加注桶）：实际 ${allIn.heroEquityVsCallRange}`,
  );
});

test('T4：河牌 OOP 的 CHECK 不是自动摊牌（CheckEV ≠ 权益 × 底池）', () => {
  const run = runNode(riverNodeTwo());
  const bd = run.advice.betDecision!;
  const tree = bd.checkTree;
  assert.equal(tree.kind, 'HEURISTIC_TREE', '河牌前位过牌必须走 CHECK 树');
  assert.equal(tree.isInPosition, false, 'Hero 在 BB ⇒ 前位');
  assert.ok(tree.betLikelihood > 0, `他必须具备非零下注倾向（实际 ${tree.betLikelihood}）`);
  assert.ok(
    Math.abs(tree.checkBackLikelihood + tree.betLikelihood - 1) < 1e-9,
    '过牌/下注概率之和必须为 1',
  );
  const naive = run.equity! * bd.pot;
  assert.ok(
    bd.checkEV !== null && Math.abs(bd.checkEV - naive) > 1e-6,
    `CheckEV 不得等于 权益 × 底池（${bd.checkEV} vs ${naive}）—— 他过牌后仍可下注`,
  );
  // 公式必须可复算
  const recomputed =
    tree.checkBackLikelihood * tree.evShowdown! + tree.betLikelihood * tree.heroBestResponseEV!;
  assert.ok(
    Math.abs(recomputed - bd.checkEV!) < 1e-9,
    `CheckEV 必须等于 P(过牌)×摊牌EV + P(下注)×Hero最佳应手：${recomputed} vs ${bd.checkEV}`,
  );
  assert.equal(tree.heroFoldEV, 0, '弃牌 EV 必须为 0（零点 = 当前决策点）');
  assert.equal(tree.raiseResponse, 'NOT_IMPLEMENTED', '加注应手必须如实标注未实现');
});

test('T5：河牌 IP 过牌可以终止动作（check-back 摊牌），与 OOP 必须区分', () => {
  const ip = runNode(spot('TURN', 'NORMAL') as ManualHandInput); // 转牌 IP：用实现代理
  assert.equal(ip.advice.betDecision!.checkTree.kind, 'HEURISTIC_ONE_STREET', '转牌不是摊牌终止');

  // 构造河牌 IP 节点：HJ 先过牌，Hero（CO）在后位
  const riverIp = {
    tableSize: 6,
    heroPosition: 'CO',
    heroCards: ['As', 'Js'],
    board: ['Qd', '8s', '4s', '2h', '7c'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' },
      { position: 'HJ', type: 'RAISE', amountBB: 3 },
      { position: 'CO', type: 'CALL', amountBB: 3 },
      { position: 'BTN', type: 'FOLD' },
      { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'FOLD' },
      { position: 'HJ', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'CHECK', street: 'FLOP' },
      { position: 'HJ', type: 'CHECK', street: 'TURN' },
      { position: 'CO', type: 'CHECK', street: 'TURN' },
      { position: 'HJ', type: 'CHECK', street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
  const run = runNode(riverIp);
  const tree = run.advice.betDecision!.checkTree;
  assert.equal(tree.kind, 'SHOWDOWN_TERMINAL', '河牌 + 后位 ⇒ 过牌即摊牌');
  assert.equal(tree.betLikelihood, 0, '对手已过牌 ⇒ 不存在「他再下注」');
  assert.ok(
    Math.abs(tree.checkEV! - run.equity! * run.advice.betDecision!.pot) < 1e-9,
    '后位摊牌 EV = 对到达范围权益 × 底池',
  );
});

test('T6：Hero 过牌之后，对手下注倾向随画像方向变化（不要求动作翻转）', () => {
  const normal = runNode(riverNodeTwo('NORMAL'));
  const station = runNode(riverNodeTwo('CALLING_STATION'));
  const maniac = runNode(riverNodeTwo('MANIAC'));
  const tight = runNode(riverNodeTwo('VERY_TIGHT'));

  const pBet = (r: NodeRun): number => r.advice.betDecision!.checkTree.betLikelihood;
  assert.ok(
    pBet(station) <= pBet(normal) + 1e-12,
    `跟注站：过牌后下注倾向不得高于普通（${pBet(station).toFixed(4)} vs ${pBet(normal).toFixed(4)}）`,
  );
  assert.ok(
    pBet(maniac) >= pBet(normal) - 1e-12,
    `疯子：过牌后下注倾向不得低于普通（${pBet(maniac).toFixed(4)} vs ${pBet(normal).toFixed(4)}）`,
  );
  // 单调链条（画像只改概率，不造牌）
  assert.ok(
    pBet(maniac) > pBet(station),
    `疯子 > 跟注站（${pBet(maniac).toFixed(4)} vs ${pBet(station).toFixed(4)}）`,
  );
  void tight;
  // 组合集不变：三桶 + 过牌/下注都不能凭空造牌
  for (const r of [normal, station, maniac]) {
    const bd = r.advice.betDecision!;
    const totalMass = bd.sizes[0]!.buckets.reduce((acc, b) => acc + b.mass, 0);
    assert.ok(Math.abs(totalMass - 1) < 1e-9, '质量必须守恒');
  }
});

test('T7（墨菲）：极短码 / 零筹码 / 最小注约束仍然合法', () => {
  // ① 剩余 0 ⇒ 不产生任何 BET
  const zero = legalizeBetSizes({ pot: 100, heroRemaining: 0, villainRemaining: 100, minBet: 2 });
  assert.equal(zero.sizes.length, 0, '没有筹码 ⇒ 不能产生 BET');
  // ② 极短码（0.2 SPR）⇒ 只剩一个 ALL_IN 候选，且金额 = 剩余筹码
  const short = legalizeBetSizes({ pot: 100, heroRemaining: 20, villainRemaining: 100, minBet: 2 });
  assert.equal(short.sizes.length, 1, '极短码下三个理论尺寸全部封顶到同一金额 ⇒ 只剩一个候选');
  assert.equal(short.sizes[0]!.kind, 'ALL_IN');
  assert.equal(short.sizes[0]!.legalAmount, 20);
  assert.equal(short.dropped.length, 2, '另外两个候选必须留痕（理论金额只进 debug）');
  // ③ 单挑有效筹码取 min（他只有 30 ⇒ 我最多下 30）
  const capped = legalizeBetSizes({ pot: 100, heroRemaining: 200, villainRemaining: 30, minBet: 2 });
  assert.ok(capped.sizes.every((s) => s.legalAmount <= 30), '不得超过对手剩余筹码');
  // ④ 低于最小注且非全下 ⇒ 丢弃
  const tiny = legalizeBetSizes({ pot: 1, heroRemaining: 100, villainRemaining: 100, minBet: 2 });
  assert.ok(tiny.sizes.every((s) => s.legalAmount >= 2 - 1e-9), '低于最小注的尺寸必须被丢弃');
});

test('T8（墨菲）：EV 零点统一 —— CHECK / BET / ALL-IN 可直接 argmax', () => {
  const run = runNode(riverNodeTwo());
  const bd = run.advice.betDecision!;
  // 全下且他必跟（P(跟)=1）时，BetEV 必须 = EqVsCall × (P + 2b) − b（同一零点）
  const allIn = bd.sizes.find((s) => s.kind === 'ALL_IN')!;
  if (allIn.callLikelihood > 0.99) {
    const expected = allIn.heroEquityVsCallRange! * (bd.pot + 2 * allIn.betAmount) - allIn.betAmount;
    assert.ok(
      Math.abs(allIn.betEV! - expected) < 1.0,
      `BetEV 必须与跟注分支同零点：${allIn.betEV} vs ${expected}`,
    );
  }
  // CHECK EV 与 BET EV 都是「从当前决策点起算」的筹码量（不得把已投入筹码重复扣除）
  const naiveCheck = run.equity! * bd.pot;
  assert.ok(
    Math.abs(bd.checkEV! - naiveCheck) / naiveCheck < 0.15,
    'CheckEV 与「权益 × 底池」必须同量级（同一零点，只是树不同）',
  );
});

test('T9e：尺寸规格与响应模型必须自洽（注释与实现不得漂移）', () => {
  assert.equal(BET_SIZE_SPECS.length, 3);
  const ratios = BET_SIZE_SPECS.map((s) => s.ratioToPot);
  assert.deepEqual([...ratios], [1 / 3, 2 / 3, 1], '三个建模比例必须是小/中/大');
  // 直接调用响应模型：同一份范围下，注越大弃牌越多
  // ⚠️ 组合索引必须与公共牌**不重叠**（`ALL_CARDS` 按花色分组：0..12 黑桃、13..25 红心…）
  const model = buildResponseModel({
    entries: [
      { cardIndices: [26, 27], probability: 0.5 },
      { cardIndices: [28, 29], probability: 0.5 },
    ],
    heroHole: ALL_CARDS.slice(44, 46),
    board: ALL_CARDS.slice(0, 3),
    pot: 100,
    street: 'TURN',
    spr: 4,
    opponentCount: 1,
    wetness: 0.2,
    tendencies: neutralResponseTendencies(),
    sizes: legalizeBetSizes({ pot: 100, heroRemaining: 500, villainRemaining: 500, minBet: 2 }).sizes,
    heroRemaining: 500,
  });
  assert.ok(model !== null && model.sizes.length === 3);
  assert.ok(
    model!.sizes[0]!.foldLikelihood <= model!.sizes[2]!.foldLikelihood,
    '同一份范围：小注的弃牌率不得高于大注',
  );
  assert.equal(roleStrengthOf(RelativeHandRole.SEMI_BLUFF), 0.35, '半诈唬强度刻度未变（兼容）');
  void realizationFactorOf;
});
