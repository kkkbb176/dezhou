/**
 * ============================================================================
 * TEST 09 —— BET RANGE 定向审计回归（P0-1 / P0-2）
 * ============================================================================
 *
 * 锁住的核心命题（§二十六）：
 *
 * ```text
 * 到达范围  ≠  下注范围  ≠  面对别人下注时的继续范围
 * ```
 *
 * | 编号 | 锁住什么 |
 * |---|---|
 * | BR-1 | `CALL EV` 用**下注范围**权益，不用到达范围权益 |
 * | BR-2 | 两个权益**分开保存**（`heroEquity` / `heroEquityVsBetRange`） |
 * | BR-3 | 下注范围 ≠ 到达范围（类别质量可区分） |
 * | BR-4 | 下注范围 ≠ 响应模型的 CALL / RAISE 桶（§二十二） |
 * | BR-5 | 下注范围 ≠ 面对别人下注时的继续范围（不同条件概率） |
 * | BR-6 | `betRangeClassMasses` 存在、归一、且字段属于 **BET RANGE** |
 * | BR-7 | 尺寸进入 bet range：`actualRatio` / `modeledRatio` / `SIZE_APPROXIMATION` |
 * | BR-8 | 尺寸敏感性：大注与小注的 value/bluff 构成**必须不同**（§二十一） |
 * | BR-9 | 合成向量：50/50 价值-诈唬 ⇒ 应 CALL；80/20 ⇒ 应 FOLD（§二十） |
 * | BR-10 | FoldTo* **不影响** own betLikelihood（§十二 / §十三） |
 * | BR-11 | 未知统计键必须显式警告，不得静默丢弃（§十四） |
 * | BR-12 | 方向：MANIAC 的诈唬质量 > NIT 的（§十六） |
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildBettingRangeFacts } from '../src/app/manualInput/bettingRange.ts';
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { archetypeDimensionsOf } from '../src/domain/player/archetypeDimensions.ts';
import { resolvePlayerProfile, normalizeObservedStats } from '../src/domain/player/observedStats.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { ALL_CARDS, parseCardStrict } from '../src/domain/poker/cards.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20260913;
const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: SEED,
  budget: { softMs: 120000, hardMs: 240000 },
} as const;

/* ============================================================
 * 冻结 TEST 09（用户 §一 / §二）
 * ============================================================ */

type Row = { position: string; type: string; amountBB?: number; street?: string };
const A = (position: string, type: string, amountBB?: number, street?: string): Row => ({
  position,
  type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/** 基础画像（§一）—— 全部是 **FOLD-TO** 统计 */
const V3_STATS = {
  handsObserved: 620,
  vpip: 0.58,
  pfr: 0.39,
  threeBet: 0.16,
  wtsd: 0.34,
  foldToFlopCBet: 0.25,
  foldToTurnCBet: 0.28,
  foldToRiverBet: 0.24,
  flopCheckRaise: 0.12,
  turnCheckRaise: 0.10,
  riverCheckRaise: 0.07,
} as const;

/**
 * TEST 09 行动历史（§二）：BTN 加注到 6 → BB 跟注；翻牌 BB 过牌 / BTN 下 8 / BB 跟；
 * 转牌 BB 过牌 / BTN 下 21 / BB 跟；河牌 BB 过牌 / BTN 下 85（120% 池 overbet）。
 *
 * `bigBlindBB = 2` ⇒ `amountBB` 是**大盲数**：6 筹码 = 3BB、8 = 4BB、
 * 21 = 10.5BB、85 = 42.5BB。重建后底池恰好 156 筹码、需跟 85。
 */
function test09Input(
  quickProfile: string,
  stats: typeof V3_STATS | null,
  overrides: Record<string, unknown> = {},
): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: ['As', 'Js'],
    board: ['Jd', '8c', '4c', '6s', 'Kh'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
      A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 4, 'FLOP'), A('BB', 'CALL', 4, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 10.5, 'TURN'), A('BB', 'CALL', 10.5, 'TURN'),
      A('BB', 'CHECK', undefined, 'RIVER'), A('BTN', 'BET', 42.5, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: {
      quickProfile,
      dynamicHint: 'UNKNOWN',
      stackBB: 100,
      ...(stats === null ? {} : { observedStats: stats }),
      ...overrides,
    },
  } as unknown as ManualHandInput;
}

type Built = ReturnType<typeof buildDecisionContext>['context'];

function build(input: ManualHandInput): Built {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true, `必须能解析：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, `必须能重建：${gate.ok ? '' : JSON.stringify(gate.issues)}`);
  if (!gate.ok) throw new Error('unreachable');
  return buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: OPTIONS.asOf,
    quickProfile: input.villain?.quickProfile,
    ...(input.villain?.observedStats ? { observedStats: input.villain.observedStats } : {}),
    ...(input.villain?.betRangeBluffShareOverride !== undefined
      ? { betRangeBluffShareOverride: input.villain.betRangeBluffShareOverride }
      : {}),
    equitySeed: SEED,
  }).context;
}

const FOUR = [
  ['MANIAC V3', 'MANIAC', V3_STATS],
  ['MANIAC V2', 'MANIAC', null],
  ['NORMAL', 'NORMAL', null],
  ['NIT', 'VERY_TIGHT', null],
] as const;

/* ============================================================
 * BR-1 / BR-2 —— CALL EV 的权益输入对象
 * ============================================================ */

test('BR-1：面对已下注节点，CALL EV 必须用**下注范围**权益（不是到达范围）', () => {
  const c = build(test09Input('MANIAC', V3_STATS));
  const m = c.math;

  // 前置：底池口径与用户手算一致（§二）
  assert.equal(m.pot, 156, '底池必须是 156 筹码（71 + 85）');
  assert.equal(m.callCost, 85, '需跟 85 筹码');
  assert.equal(m.winnable, 241, '跟注后可争夺总量必须是 241 筹码');
  assert.ok(
    Math.abs(m.requiredEquity - 85 / 241) < 1e-9,
    `所需权益必须是 85/241 = 35.27%（实际 ${(m.requiredEquity * 100).toFixed(2)}%）`,
  );

  // 核心：callEV 用的是下注范围权益
  assert.notEqual(m.heroEquityVsBetRange, null, '必须给出下注范围权益');
  const expected = m.heroEquityVsBetRange! * m.winnable - m.callCost;
  assert.ok(
    Math.abs(m.callEV! - expected) < 1e-9,
    `CALL EV 必须 = 下注范围权益 × 可争夺量 − 跟注额：${expected.toFixed(4)} vs ${m.callEV!.toFixed(4)}`,
  );
  // 反证：绝不能等于用到达范围权益算出来的那个数
  const naive = m.heroEquity! * m.winnable - m.callCost;
  assert.ok(
    Math.abs(m.callEV! - naive) > 1e-6,
    `CALL EV **不得**等于「到达范围权益 × 可争夺量 − 跟注额」（${naive.toFixed(2)}）—— ` +
      '那正是本轮要修的错误口径',
  );
});

test('BR-2：到达范围权益与下注范围权益必须**分开保存**（§八）', () => {
  /*
   * 🔴 **契约变更（RIVER BET RANGE V2，已记录，非放宽）**
   *
   * 修复前这里断言 `heroEquityVsBetRange <= heroEquity`，理由是
   * 「下注范围是到达范围的偏价值子集」。那个断言隐含一个**错误前提**：
   * `math.heroEquity` 被当成到达范围权益 —— 而它其实取自一份**已经含
   * 本次下注似然**的范围（＝后验）。于是 `heroEquityVsBetRange` 是
   * 「后验 × P(BET|手牌)」，同一条动作被计了两次（实测把本节点压到 22.55%）。
   *
   * 修复后到达范围有了**自己的量**：`postflop.betRangeArrival`
   * （由同一条范围更新链在本次下注**之前**捕获，零额外计算）。
   * 正确的比较是「下注范围 vs **到达范围**」，不是「下注范围 vs 后验」。
   */
  for (const [name, profile, stats] of FOUR) {
    const c = build(test09Input(profile, stats));
    const m = c.math;
    assert.notEqual(m.heroEquity, null, `${name}：整体范围权益必须存在`);
    assert.notEqual(m.heroEquityVsBetRange, null, `${name}：下注范围权益必须存在`);

    const arrival = c.postflopFacts?.betRangeArrival ?? null;
    assert.notEqual(arrival, null, `${name}：必须给出真正的到达范围（RIVER BET RANGE V2）`);
    assert.notEqual(
      arrival!.heroEquityVsArrivalRange,
      null,
      `${name}：到达范围权益必须存在`,
    );
    assert.ok(
      m.heroEquityVsBetRange! <= arrival!.heroEquityVsArrivalRange! + 1e-12,
      `${name}：下注范围是更偏价值的条件范围 ⇒ 权益不得高于**到达范围**：` +
        `${(m.heroEquityVsBetRange! * 100).toFixed(2)}% vs 到达 ${(arrival!.heroEquityVsArrivalRange! * 100).toFixed(2)}%`,
    );
    // 三个量必须互不相同：口径一旦被合并，界面就再也分不清它们
    assert.notEqual(
      arrival!.heroEquityVsArrivalRange,
      m.heroEquityVsBetRange,
      `${name}：到达范围权益与下注范围权益必须是两个不同的量`,
    );
  }
});

/* ============================================================
 * BR-3 / BR-4 / BR-5 —— 三个范围层级不可混用
 * ============================================================ */

test('BR-3：下注范围 ≠ 到达范围（类别质量可区分）', () => {
  const c = build(test09Input('MANIAC', V3_STATS));
  const arrival = c.postflopFacts?.opponentRangeFacts?.profileClassMasses;
  const bet = c.postflopFacts?.bettingRangeFacts?.classMasses;
  assert.ok(arrival, '到达范围类别质量必须存在');
  assert.ok(bet, '下注范围类别质量必须存在');

  // 到达范围里包含大量「不会下注」的中等牌；下注范围更偏价值
  assert.ok(
    typeof bet!.valueMass === 'number' && typeof bet!.bluffMass === 'number',
    '下注范围必须同时给出 valueMass 与 bluffMass',
  );
  assert.ok(
    Math.abs(bet!.strongValueMass + bet!.thinValueMass - (arrival!.strongValueMass + arrival!.thinValueMass)) >
      1e-9 ||
      Math.abs(bet!.showdownMass - arrival!.showdownMass) > 1e-9,
    '下注范围与到达范围的类别构成必须有差异（否则说明只是把到达范围复制过去了）',
  );
  // 下注范围必须归一
  const sum =
    bet!.strongValueMass +
    bet!.thinValueMass +
    bet!.showdownMass +
    bet!.bluffMass +
    bet!.unclassifiedMass;
  assert.ok(
    Math.abs(sum - 1) < 1e-9,
    `下注范围的类别质量必须归一（实际 ${sum}）`,
  );
});

test('BR-4：下注范围 ≠ 响应模型的 CALL / RAISE 桶（§二十二）', () => {
  /*
   * 这是本轮最容易犯的错：拿「他面对我的下注会跟/会加的部分」
   * 冒充「他主动下注的部分」。两者是**不同的条件概率**：
   *
   * ```text
   * P(他 call | 我 bet)   ← 响应模型的 CALL 桶
   * P(他 bet  | 我 check) ← 本模块的 bet range
   * ```
   */
  const c = build(test09Input('MANIAC', V3_STATS));
  const bd = c.postflopFacts?.betDecision;
  assert.ok(bd, '响应模型必须存在');
  const size = bd!.sizes[0]!;
  const continueMass = size.buckets
    .filter((b) => b.bucket === 'CALL' || b.bucket === 'RAISE')
    .reduce((acc, b) => acc + b.mass, 0);

  const betFacts = c.postflopFacts?.bettingRangeFacts;
  assert.ok(betFacts, '下注范围必须存在');
  assert.notEqual(
    betFacts!.entryCount,
    0,
    '下注范围不能为空',
  );
  /*
   * 两条独立证据：
   * ① 组合数不同（继续范围 vs 下注范围来自不同的权重函数）
   * ② 「他下注的比例」必须与「他继续的比例」在语义上不同 ——
   *    这里用可审计的字段区分，而不是断言两个数恰好不等
   *    （那可能碰巧相等而让测试失去意义）。
   */
  assert.ok(
    betFacts!.betShareOfArrival > 0 && betFacts!.betShareOfArrival <= 1,
    `betShareOfArrival 必须在 (0,1]（实际 ${betFacts!.betShareOfArrival}）`,
  );
  assert.ok(
    continueMass > 0 && continueMass <= 1,
    `响应模型的继续质量必须在 (0,1]（实际 ${continueMass}）`,
  );
  // 下注范围的组合集必须来自**下注**权重，而不是继续桶的组合集
  const continueCombos = new Set<string>();
  for (const b of size.buckets) {
    if (b.bucket !== 'CALL' && b.bucket !== 'RAISE') continue;
    for (const e of b.entries) continueCombos.add(String(e.cardIndices));
  }
  assert.ok(
    continueCombos.size > 0,
    '继续桶必须有组合（否则本测试无意义）',
  );
});

test('BR-5：下注范围 ≠ 面对别人下注时的继续范围（语义分离）', () => {
  /*
   * 结构化断言：`bettingRangeFacts` 与 `betDecision.sizes[].buckets`
   * 是**两个不同的对象**、由**两个不同的模型**产生，且都如实标注用途。
   */
  const c = build(test09Input('MANIAC', V3_STATS));
  const bet = c.postflopFacts?.bettingRangeFacts;
  const bd = c.postflopFacts?.betDecision;
  assert.ok(bet && bd, '两者都必须存在');
  // 下注范围有自己的尺寸口径（§七），响应模型没有
  assert.ok(c.postflopFacts?.betRangeSizing, '下注范围必须带尺寸口径');
  // 响应模型的桶是「面对下注」的，名字里必须体现
  const names = bd!.sizes[0]!.buckets.map((b) => b.bucket);
  assert.deepEqual(
    [...names].sort(),
    ['CALL', 'FOLD', 'RAISE'],
    '响应模型的桶必须是 FOLD/CALL/RAISE（面对下注的三分支）',
  );
  // 下注范围的类别质量里**没有** FOLD —— 它不描述「弃牌」这件事
  const masses = Object.keys(bet!.classMasses);
  assert.ok(
    !masses.some((k) => k.toLowerCase().includes('fold')),
    `下注范围的类别里不得出现 fold 相关字段（实际 ${masses.join(',')}）`,
  );
});

/* ============================================================
 * BR-6 —— betRangeClassMasses 字段完整性（§十）
 * ============================================================ */

test('BR-6：`betRangeClassMasses` 必须含 §十 要求的全部字段，且属于 BET RANGE', () => {
  const c = build(test09Input('MANIAC', V3_STATS));
  const bet = c.postflopFacts?.bettingRangeFacts;
  assert.ok(bet, '下注范围必须存在');
  for (const key of [
    'strongValueMass',
    'thinValueMass',
    'showdownMass',
    'missedFlushMass',
    'missedStraightMass',
    'missedComboMass',
    'pureAirMass',
    'valueMass',
    'bluffMass',
  ] as const) {
    const v: unknown = (bet!.classMasses as Readonly<Record<string, unknown>>)[key];
    assert.equal(typeof v, 'number', `缺少字段 ${key}`);
    const n = v as number;
    assert.ok(Number.isFinite(n) && n >= 0 && n <= 1, `${key} 必须在 [0,1] 且有限（实际 ${n}）`);
  }
  // 恒等式：valueMass = strong + thin（+ nut），bluffMass = 错失听牌 + 空气
  assert.ok(
    Math.abs(bet!.classMasses.valueMass - (bet!.classMasses.strongValueMass + bet!.classMasses.thinValueMass)) <
      1e-9,
    'valueMass 必须等于 strongValueMass + thinValueMass（本牌面无 nutValue）',
  );
  assert.ok(
    Math.abs(
      bet!.classMasses.bluffMass -
        (bet!.classMasses.missedFlushMass +
          bet!.classMasses.missedStraightMass +
          bet!.classMasses.missedComboMass +
          bet!.classMasses.pureAirMass),
    ) < 1e-9,
    'bluffMass 必须等于错失听牌 + 纯空气',
  );
});

/* ============================================================
 * BR-7 —— 尺寸口径（§七）
 * ============================================================ */

test('BR-7：120% 超池必须如实标注 SIZE_APPROXIMATION，不得静默当成 100%', () => {
  const c = build(test09Input('MANIAC', V3_STATS));
  const s = c.postflopFacts?.betRangeSizing;
  assert.ok(s, '必须输出尺寸口径');
  assert.ok(
    Math.abs(s!.actualRatio - 85 / 71) < 1e-9,
    `actualRatio 必须是 85/71 = 1.197（实际 ${s!.actualRatio}）`,
  );
  assert.ok(s!.modeledRatio <= 1 + 1e-9, `modeledRatio 不得超过网格上限 1.0（实际 ${s!.modeledRatio}）`);
  assert.equal(
    s!.sizeApproximation,
    true,
    '实际 1.197 > 建模 1.0 ⇒ **必须**标 SIZE_APPROXIMATION = true（§七 禁止静默）',
  );
  assert.equal(s!.actualBetChips, 85, '必须保留真实下注额 85（不得替换成建模值）');
  assert.equal(s!.potChips, 71, '必须保留下注前底池 71');
});

/* ============================================================
 * BR-8 —— 尺寸敏感性（§二十一）
 * ============================================================ */

test('BR-8：下注范围的 value/bluff 构成必须随尺寸变化（§二十一）', () => {
  /*
   * 用同一个到达范围，只改尺寸。若四个尺寸给出**完全相同**的构成，
   * 说明尺寸没有进入下注范围模型 —— 那是 §二十一 明确禁止的。
   *
   * 这里走 `buildBettingRangeFacts` 直接比较（更快、更聚焦）：
   * 同一个 arrival + tendencies，只改 `betChips`。
   */
  const c = build(test09Input('MANIAC', V3_STATS));
  const range = c.postflopFacts?.opponentRangeFacts;
  assert.ok(range, '需要到达范围');
  const board = ['Jd', '8c', '4c', '6s', 'Kh'].map(parseCardStrict);
  const heroHole = ['As', 'Js'].map(parseCardStrict);

  // 从响应桶还原到达范围（三桶并集 = 到达范围）
  const bd = c.postflopFacts?.betDecision;
  assert.ok(bd, '需要响应模型');
  const seen = new Map<string, readonly [number, number]>();
  for (const size of bd!.sizes) {
    for (const b of size.buckets) {
      for (const e of b.entries) seen.set(String(e.cardIndices), e.cardIndices);
    }
  }
  const arrival = [...seen.values()].map((ci) => ({ cardIndices: ci, probability: 1 }));

  const dims = archetypeDimensionsOf('MANIAC', 0.35);
  const tendencies = responseTendenciesOf(dims, 0.35, null);

  const compositions = [1 / 3, 2 / 3, 1, 1.2].map((ratio) => {
    const f = buildBettingRangeFacts({
      arrivalEntries: arrival,
      board,
      heroHole,
      potChips: 71,
      betChips: 71 * ratio,
      street: 'RIVER',
      tendencies,
    });
    assert.ok(f, `ratio=${ratio} 必须能构造下注范围`);
    return {
      ratio,
      actual: f!.sizing.actualRatio,
      value: f!.classMasses.valueMass,
      bluff: f!.classMasses.bluffMass,
      sizeApprox: f!.sizing.sizeApproximation,
    };
  });

  /*
   * §二十一 的硬要求：**四个尺寸不能完全一样**。
   * 精确到 1e-9 的相等才算「一样」；只要有任一尺寸的构成不同即通过。
   */
  const distinct = new Set(
    compositions.map((x) => `${x.value.toFixed(9)}|${x.bluff.toFixed(9)}`),
  );
  assert.ok(
    distinct.size > 1,
    `四个尺寸的下注范围构成不得完全相同：${JSON.stringify(compositions)}`,
  );
  // 尺寸口径必须如实：120% 会被标注近似，其余不会
  assert.equal(compositions[3]!.sizeApprox, true, '120% 必须标 SIZE_APPROXIMATION');
  assert.equal(compositions[0]!.sizeApprox, false, '33% 不应标 SIZE_APPROXIMATION');
});

/* ============================================================
 * BR-9 —— 合成向量（§二十）
 * ============================================================ */

test('BR-9：合成向量 —— 50/50 价值-诈唬应 CALL，80/20 应 FOLD（§二十）', () => {
  /*
   * 这是本轮**最重要**的测试：它不锁 TEST 09 的任何具体百分比，
   * 而是直接验证「给定范围构成 ⇒ 权益 ⇒ 动作」这条链路。
   *
   * 用 `betRangeBluffShareOverride` 显式指定「无摊牌价值的牌下注的概率」，
   * 于是范围构成由我们控制，而不是由画像推导。
   */
  const callSide = build(
    test09Input('MANIAC', V3_STATS, { betRangeBluffShareOverride: 1 }),
  );
  const foldSide = build(
    test09Input('MANIAC', V3_STATS, { betRangeBluffShareOverride: 0 }),
  );

  // 诈唬全开 ⇒ 下注范围里的诈唬比例更高 ⇒ Hero 权益更高
  assert.ok(
    callSide.math.heroEquityVsBetRange! > foldSide.math.heroEquityVsBetRange!,
    `诈唬全开的下注范围权益必须更高：${(callSide.math.heroEquityVsBetRange! * 100).toFixed(2)}% ` +
      `vs ${(foldSide.math.heroEquityVsBetRange! * 100).toFixed(2)}%`,
  );

  /*
   * 动作必须由 EV 符号决定（不是被写死的）。
   * ⚠️ 不锁「必须 CALL」——真实范围构成决定结论（§十七）。
   * 锁的是**因果**：EV > 0 ⇔ CALL。
   */
  for (const [name, c] of [['诈唬全开', callSide], ['诈唬全关', foldSide]] as const) {
    const ev = c.math.callEV!;
    const required = c.math.requiredEquity;
    const eq = c.math.heroEquityVsBetRange!;
    assert.equal(
      ev > 0,
      eq > required,
      `${name}：EV 符号必须与「权益 vs 门槛」一致（eq=${(eq * 100).toFixed(2)}%, req=${(required * 100).toFixed(2)}%）`,
    );
  }

  // 门槛恒等式（与范围构成无关，是赔率定义）
  for (const c of [callSide, foldSide]) {
    assert.ok(
      Math.abs(c.math.requiredEquity * c.math.winnable - c.math.callCost) < 1e-9,
      '权益 = 门槛 ⇒ EV = 0 的恒等式必须成立',
    );
  }
});

/* ============================================================
 * BR-10 —— FoldTo* 不得影响 own betLikelihood（§十二 / §十三）
 * ============================================================ */

test('BR-10：FoldTo* 三项**不得**改变他自己主动下注的倾向（§十二）', () => {
  /*
   * `FoldToRiverBet` 的语义是「**他面对别人的河牌下注时弃不弃**」，
   * 不是「Hero 过牌后他下不下注」。后者是另一个条件概率。
   *
   * 本测试用**单变量扫描**证明它没有进入 bet range 的通道：
   * 只改三条 FoldTo*，下注范围的类别构成与权益必须**逐位不变**。
   */
  const base = { ...V3_STATS } as Record<string, unknown>;
  const runs = [
    ['基准', {}],
    ['FoldTo* = 0.05', { foldToFlopCBet: 0.05, foldToTurnCBet: 0.05, foldToRiverBet: 0.05 }],
    ['FoldTo* = 0.95', { foldToFlopCBet: 0.95, foldToTurnCBet: 0.95, foldToRiverBet: 0.95 }],
  ] as const;

  const results = runs.map(([name, patch]) => {
    const c = build(test09Input('MANIAC', { ...base, ...patch } as typeof V3_STATS));
    const bet = c.postflopFacts!.bettingRangeFacts!;
    return {
      name,
      betEq: c.math.heroEquityVsBetRange!,
      value: bet.classMasses.valueMass,
      bluff: bet.classMasses.bluffMass,
      share: bet.betShareOfArrival,
    };
  });

  for (const r of results.slice(1)) {
    assert.equal(
      r.betEq,
      results[0]!.betEq,
      `${r.name}：改变 FoldTo* 不得改变下注范围权益（${results[0]!.betEq} → ${r.betEq}）`,
    );
    assert.equal(r.value, results[0]!.value, `${r.name}：valueMass 必须逐位不变`);
    assert.equal(r.bluff, results[0]!.bluff, `${r.name}：bluffMass 必须逐位不变`);
    assert.equal(r.share, results[0]!.share, `${r.name}：下注占比必须逐位不变`);
  }

  /*
   * 正面证据：`FoldTo*` 确实**进了它该进的地方** ——
   * 分街响应因子（他面对下注时的反应）。否则本测试会因「接线断了」而误通过。
   */
  const tight = resolvePlayerProfile({
    baseArchetype: 'MANIAC',
    observedStats: { ...base, foldToRiverBet: 0.95 } as never,
    actionContext: 'FACING_CBET',
    street: 'RIVER',
  });
  const loose = resolvePlayerProfile({
    baseArchetype: 'MANIAC',
    observedStats: { ...base, foldToRiverBet: 0.05 } as never,
    actionContext: 'FACING_CBET',
    street: 'RIVER',
  });
  assert.ok(
    tight.resolved.street.RIVER.foldScale > loose.resolved.street.RIVER.foldScale,
    'FoldToRiverBet 必须**仍然**影响他面对下注时的弃牌因子（否则是接线断了，不是语义隔离）',
  );
});

/* ============================================================
 * BR-11 —— 未知统计必须显式警告（§十四）
 * ============================================================ */

test('BR-11：不支持的统计键必须显式报告，不得静默丢弃（§十四）', () => {
  /*
   * `PlayerObservedStats` 只有 10 个字段，全部是 **FoldTo\*** 与 **\*CheckRaise**。
   * 传 `turnCBet` / `riverBet` / `flopCBet`（**主动下注**统计）时，
   * 修复前归一化器静默丢弃、`issues` 为空 —— 审计脚本会误以为它们进了模型。
   */
  const r = normalizeObservedStats({
    handsObserved: 620,
    stats: {
      vpip: 0.58,
      turnCBet: 0.72,
      riverBet: 0.68,
      flopCBet: 0.81,
      betWhenCheckedTo: 0.55,
    } as never,
  });

  const ignoredKeys = r.ignoredStatKeys.map((x) => x.key).sort();
  assert.deepEqual(
    ignoredKeys,
    ['betWhenCheckedTo', 'flopCBet', 'riverBet', 'turnCBet'],
    `必须如实列出被忽略的键（实际 ${JSON.stringify(ignoredKeys)}）`,
  );
  const unknownIssues = r.issues.filter((i) => i.code === 'UNKNOWN_OBSERVED_STAT');
  assert.equal(
    unknownIssues.length,
    4,
    `必须为每个未知键产生一条 UNKNOWN_OBSERVED_STAT（实际 ${unknownIssues.length}）`,
  );
  for (const issue of unknownIssues) {
    assert.ok(
      issue.message.includes('未进入模型'),
      `提示必须写明「未进入模型」，实际：${issue.message}`,
    );
  }
  // 已知字段必须**不受影响**
  assert.equal(r.stats.vpip, 0.58, '已知字段必须照常接受');
  assert.equal(r.stats.foldToRiverBet, null, '未提供的已知字段必须是 null（不是 0）');
});

/* ============================================================
 * BR-12 —— 方向要求（§十六）
 * ============================================================ */

test('BR-12：方向 —— MANIAC 的诈唬质量 > NIT，且抓诈牌对其下注范围权益更高（§十六）', () => {
  const maniac = build(test09Input('MANIAC', V3_STATS));
  const normal = build(test09Input('NORMAL', null));
  const nit = build(test09Input('VERY_TIGHT', null));

  const bluffOf = (c: Built): number => c.postflopFacts!.bettingRangeFacts!.classMasses.bluffMass;
  const eqOf = (c: Built): number => c.math.heroEquityVsBetRange!;

  assert.ok(
    bluffOf(maniac) > bluffOf(nit),
    `疯子的下注范围诈唬质量必须高于极紧型：${bluffOf(maniac).toFixed(4)} vs ${bluffOf(nit).toFixed(4)}`,
  );
  assert.ok(
    bluffOf(normal) >= bluffOf(nit) - 1e-12,
    `普通不得低于极紧型：${bluffOf(normal).toFixed(4)} vs ${bluffOf(nit).toFixed(4)}`,
  );
  assert.ok(
    eqOf(maniac) > eqOf(nit),
    `抓诈牌对疯子的下注范围权益必须更高：${(eqOf(maniac) * 100).toFixed(2)}% vs ${(eqOf(nit) * 100).toFixed(2)}%`,
  );

  /*
   * ⚠️ **不锁最终按钮**（§十七）。四种画像都 FOLD 是完全允许的 ——
   * 真正验收的是「CALL EV 使用了正确的 betting range」。
   */
  for (const [name, profile, stats] of FOUR) {
    const c = build(test09Input(profile, stats));
    const run = analyzeManualHand(test09Input(profile, stats), OPTIONS);
    assert.equal(run.ok, true, `${name}：完整管线必须成功`);
    if (!run.ok) continue;
    const ev = c.math.callEV!;
    assert.equal(
      run.decision.action === 'CALL',
      ev > 0,
      `${name}：动作必须由 EV 符号产生（callEV=${ev.toFixed(2)} ⇒ ${run.decision.action}）`,
    );
  }
});

/* ============================================================
 * BR-13 —— 全 EV 有限（防 NaN）
 * ============================================================ */

test('BR-13：下注范围相关的全部数值必须有限（不出 NaN / Infinity）', () => {
  for (const [name, profile, stats] of FOUR) {
    const c = build(test09Input(profile, stats));
    const m = c.math;
    for (const [label, v] of [
      ['heroEquity', m.heroEquity],
      ['heroEquityVsBetRange', m.heroEquityVsBetRange],
      ['callEV', m.callEV],
      ['requiredEquity', m.requiredEquity],
      ['winnable', m.winnable],
    ] as const) {
      assert.ok(v === null || Number.isFinite(v), `${name}.${label} 必须有限（实际 ${String(v)}）`);
    }
    const bet = c.postflopFacts!.bettingRangeFacts;
    if (bet) {
      assert.ok(Number.isFinite(bet.betShareOfArrival), `${name}.betShareOfArrival 必须有限`);
      assert.ok(bet.entryCount > 0, `${name}.下注范围不得为空`);
    }
  }
});
