/**
 * ============================================================================
 * RIVER BET RANGE V2 —— 第六阶段：墨菲定律对抗测试（M1–M10）
 * ============================================================================
 *
 * | 编号 | 断言 |
 * |---|---|
 * | M1 | 只改当前下注尺寸：**到达范围逐位不变**，下注范围合理变化 |
 * | M2 | 只改下注权重：`EqVsBetRange` 必须随之正确变化（且方向正确） |
 * | M3 | 被动玩家可以持弱顶对下注，但**不得**变成高频诈唬玩家 |
 * | M4 | MANIAC 的弱牌下注概率 > NIT（**不锁最终动作**） |
 * | M5 | 改 Hero 的确切底牌不得改变对手的下注概率（除合法阻断） |
 * | M6 | 当前下注似然只计一次（可证伪：到达范围与尺寸无关） |
 * | M7 | 修复后仍存在**正确的 FOLD** 节点（不得强制所有顶对 CALL） |
 * | M8 | 零权重 / 空范围 / 死牌冲突 / 非法下注金额都必须被正确处理 |
 * | M9 | 下注范围 / 权益 / EV / 动作来自同一次范围计算（无旧缓存复用） |
 * | M10 | 由全仓测试保证（见报告；本文件不重复） |
 *
 * ⚠️ 本文件**不锁任何最终按钮**，也不锁任何具体权益百分比。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import {
  PUBLIC_STRENGTH_BAND_ORDER,
  PublicStrengthBand,
  betProbabilityByBand,
  buildBettingRangeFacts,
  publicStrengthBandOf,
} from '../src/app/manualInput/bettingRange.ts';
import { responseTendenciesOf } from '../src/domain/postflop/betResponse.ts';
import { archetypeDimensionsOf } from '../src/domain/player/archetypeDimensions.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { ALL_CARDS, parseCardStrict } from '../src/domain/poker/cards.ts';
import { computeEquity, EquityComputeMode } from '../src/domain/poker/equity.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_014;
const BOARD = ['Kd', '9c', '4h', '6s', '2d'] as const;
const BOARD_CARDS = BOARD.map(parseCardStrict);

type Row = { position: string; type: string; amountBB?: number; street?: string };
const A = (position: string, type: string, amountBB?: number, street?: string): Row => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/** Hero BTN 持 `heroCards`；BB 河牌领打 `riverBetBB` 个大盲 */
function spot(heroCards: [string, string], riverBetBB = 20, profile = 'CALLING_STATION'): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards, board: [...BOARD], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', riverBetBB, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

function build(input: ManualHandInput) {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true, '必须能解析');
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, '必须能重建');
  if (!gate.ok) throw new Error('unreachable');
  return buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
    quickProfile: input.villain?.quickProfile, equitySeed: SEED,
  }).context;
}

const factsOf = (c: ReturnType<typeof build>) => c.postflopFacts!;
const ratesOf = (c: ReturnType<typeof build>) =>
  factsOf(c).bettingRangeFacts!.bandRates as unknown as Record<string, number>;

/** 合成到达范围：给定牌名列表，等权 */
function arrivalOf(pairs: readonly (readonly [string, string])[]): { cardIndices: readonly [number, number]; probability: number }[] {
  const idx = (s: string): number => {
    const card = parseCardStrict(s);
    return ALL_CARDS.findIndex((x) => x.rank === card.rank && x.suit === card.suit);
  };
  return pairs.map(([a, b]) => ({ cardIndices: [idx(a), idx(b)] as const, probability: 1 }));
}

function equityOf(
  hero: readonly string[],
  entries: readonly { cardIndices: readonly [number, number]; probability: number }[],
  board: readonly string[] = [...BOARD],
) {
  const out = computeEquity(
    hero.map(parseCardStrict),
    board.map(parseCardStrict),
    [{ label: 'R', combos: entries.map((e) => [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const) }],
    { mode: EquityComputeMode.FAST, seed: SEED, iterations: 20000, opponentWeights: [entries.map((e) => e.probability)] },
  );
  assert.equal(out.ok, true, '权益必须算得出来');
  if (!out.ok) throw new Error('unreachable');
  return out.result.equity;
}

const BANDS = PUBLIC_STRENGTH_BAND_ORDER;

/* ============================================================
 * M1 / M6 —— 尺寸：到达范围不变，下注范围变化
 * ============================================================ */

test('M1/M6：只改当前下注尺寸 ⇒ 到达范围逐位不变，下注范围随之变化', () => {
  const small = build(spot(['As', 'Ks'], 4));
  const big = build(spot(['As', 'Ks'], 20));

  const a1 = factsOf(small).betRangeArrival!;
  const a2 = factsOf(big).betRangeArrival!;
  assert.ok(a1 && a2, '两个节点都必须给出到达范围');

  // ① 到达范围与下注尺寸**无关**（它不知道他下了多少）—— 这是「似然只计一次」的可证伪证据
  assert.equal(
    a1.heroEquityVsArrivalRange,
    a2.heroEquityVsArrivalRange,
    `到达范围权益必须逐位相同（实际 ${a1.heroEquityVsArrivalRange} vs ${a2.heroEquityVsArrivalRange}）`,
  );
  for (const b of BANDS) {
    assert.equal(
      a1.bandMasses![b],
      a2.bandMasses![b],
      `到达范围「${b}」质量必须逐位相同（${a1.bandMasses![b]} vs ${a2.bandMasses![b]}）`,
    );
  }
  assert.equal(a1.supportCount, a2.supportCount, '到达范围支持集必须相同');

  // ② 下注范围**必须**随尺寸变化（§二十一）
  const b1 = factsOf(small).bettingRangeFacts!;
  const b2 = factsOf(big).bettingRangeFacts!;
  assert.notEqual(
    b1.betShareOfArrival,
    b2.betShareOfArrival,
    '下注范围必须随尺寸变化（否则尺寸没有进入模型）',
  );
  assert.equal(small.math.heroEquityVsBetRange !== big.math.heroEquityVsBetRange, true, '下注范围权益必须随尺寸变化');

  // ③ 尺寸口径如实（§七）
  assert.equal(factsOf(big).betRangeSizing!.sizeApproximation, false, '75% 池不需要标注近似');
  assert.equal(factsOf(big).betRangeSizing!.actualBetChips, 40, '必须保留真实下注额');
  assert.equal(factsOf(big).betRangeSizing!.potChips, 53, '必须保留下注前底池');
});

/* ============================================================
 * M2 —— 权重 ⇒ 权益
 * ============================================================ */

test('M2：只改下注权重 ⇒ EqVsBetRange 必须正确变化', () => {
  const hero = ['As', 'Ks'];
  const arrival = arrivalOf([
    ['Kc', 'Jd'], ['Kc', 'Td'], ['Kh', '8c'], ['9d', '9h'], ['4d', '4c'],
    ['Jc', 'Tc'], ['8d', '7d'], ['3c', '2c'],
  ]);
  const dims = archetypeDimensionsOf('CALLING_STATION', 0.35);
  const tendencies = responseTendenciesOf(dims, 0.35, null);

  const make = (override: number | null) =>
    buildBettingRangeFacts({
      arrivalEntries: arrival, board: BOARD_CARDS, heroHole: hero.map(parseCardStrict),
      potChips: 53, betChips: 40, street: 'RIVER', tendencies,
      ...(override === null ? {} : { bluffShareOverride: override }),
    })!;

  const noBluff = make(0);
  const allBluff = make(1);
  const eqNo = equityOf(hero, noBluff.entries);
  const eqAll = equityOf(hero, allBluff.entries);

  assert.ok(
    allBluff.classMasses.bluffMass > noBluff.classMasses.bluffMass,
    '诈唬全开的下注范围诈唬质量必须更高',
  );
  assert.ok(
    eqAll > eqNo,
    `下注权重必须真的传导致益：全诈唬 ${(eqAll * 100).toFixed(2)}% 必须高于 零诈唬 ${(eqNo * 100).toFixed(2)}%`,
  );
  // 归一化仍然正确
  for (const f of [noBluff, allBluff]) {
    const sum = f.entries.reduce((acc, e) => acc + e.probability, 0);
    assert.ok(Math.abs(sum - 1) < 1e-12, `下注范围必须归一（实际 ${sum}）`);
    assert.ok(f.betShareOfArrival > 0 && f.betShareOfArrival <= 1, '下注占比必须在 (0,1]');
  }
});

/* ============================================================
 * M3 / M4 —— 画像方向
 * ============================================================ */

test('M3：被动玩家可以持弱顶对下注，但不得成为高频诈唬玩家', () => {
  for (const profile of ['CALLING_STATION', 'VERY_TIGHT']) {
    const c = build(spot(['As', 'Ks'], 20, profile));
    const rates = ratesOf(c);
    const p = betProbabilityByBand({ tendencies: responseTendenciesOf(archetypeDimensionsOf(profile as never, 0.35), 0.35, null) });

    // ① 没有任何一档是 0（结构性非退化）
    for (const b of BANDS) {
      assert.ok(rates[b]! > 0, `${profile}：「${b}」的下注率必须 > 0（实际 ${rates[b]}）`);
    }
    // ② 弱顶对能下注（这就是「Hero 能击败的牌也会下注」）
    assert.ok(p.rates.TOP_PAIR_WEAK > 0, `${profile}：弱顶对必须能下注`);
    assert.ok(p.rates.MIDDLE_PAIR > 0, `${profile}：中对必须能下注`);
    // ③ 但诈唬率必须显著低于强价值率 —— 不是「被硬编码成高频诈唬玩家」
    assert.ok(
      rates['AIR']! < rates['STRONG_MADE']!,
      `${profile}：空气下注率必须低于强价值（${rates['AIR']} vs ${rates['STRONG_MADE']}）`,
    );
    assert.ok(
      rates['AIR']! <= rates['STRONG_MADE']! * 0.5,
      `${profile}：空气下注率必须不高于强价值的一半（${rates['AIR']} vs ${rates['STRONG_MADE']}）`,
    );
    const bf = factsOf(c).bettingRangeFacts!;
    assert.ok(bf.classMasses.bluffMass < bf.classMasses.valueMass, `${profile}：诈唬质量必须低于价值质量`);
  }
});

test('M4：MANIAC 的弱牌下注概率高于 NIT（不锁最终动作）', () => {
  const maniac = ratesOf(build(spot(['As', 'Ks'], 20, 'MANIAC')));
  const nit = ratesOf(build(spot(['As', 'Ks'], 20, 'VERY_TIGHT')));
  for (const b of ['TOP_PAIR_WEAK', 'MIDDLE_PAIR', 'WEAK_PAIR', 'AIR'] as const) {
    assert.ok(
      maniac[b]! > nit[b]!,
      `MANIAC 的「${b}」下注率必须高于 NIT（${maniac[b]} vs ${nit[b]}）`,
    );
  }
  // ⚠️ 刻意**不**断言最终动作：那是 EV 的结果，不是画像的目标
});

/* ============================================================
 * M5 —— 隐藏底牌
 * ============================================================ */

test('M5：换 Hero 底牌不得改变对手的下注概率（含逐带质量）', () => {
  const pool = ['Kc', 'Kh', 'Jc', 'Jd', 'Tc', 'Td', '8c', '8d', '7c', '7d', '5c', '5d', '3c', '3d', '2c', '2h'];
  const arrival = arrivalOf(pool.flatMap((a, i) => pool.slice(i + 1).map((b) => [a, b] as const)));
  const tendencies = responseTendenciesOf(archetypeDimensionsOf('CALLING_STATION', 0.35), 0.35, null);

  const under = (hero: string[]) =>
    buildBettingRangeFacts({
      arrivalEntries: arrival, board: BOARD_CARDS, heroHole: hero.map(parseCardStrict),
      potChips: 53, betChips: 40, street: 'RIVER', tendencies,
    })!;

  const x = under(['As', 'Ks']);
  const y = under(['Ah', 'Qh']);

  // 牌池与两副 Hero 底牌都不重叠 ⇒ 不存在任何阻断差异
  for (const b of BANDS) {
    assert.equal(
      x.bandMasses.bet[b],
      y.bandMasses.bet[b],
      `「${b}」的下注质量不得随 Hero 隐藏底牌变化（${x.bandMasses.bet[b]} vs ${y.bandMasses.bet[b]}）`,
    );
    assert.equal(x.bandRates[b], y.bandRates[b], `「${b}」的下注率不得随 Hero 隐藏底牌变化`);
  }
  assert.equal(x.betShareOfArrival, y.betShareOfArrival, '下注占比不得随 Hero 隐藏底牌变化');
  assert.equal(x.model.usesHeroHiddenCards, false, '模型必须自述「不读 Hero 隐藏底牌」');
});

/* ============================================================
 * M7 —— 仍然允许正确的 FOLD
 * ============================================================ */

test('M7：仍然存在「正确的 FOLD」节点（不得强制所有顶对 CALL）', () => {
  /*
   * Hero 换成一堆没有摊牌价值的牌（A 高），面对同一条线：
   * 下注范围权益应当低于所需权益 ⇒ EV < 0 ⇒ FOLD。
   * 断言的是**因果**（EV 符号 ⇔ 动作），不是某个百分比。
   */
  const weak = build(spot(['As', 'Js'], 20, 'MANIAC'));
  const eqBet = weak.math.heroEquityVsBetRange!;
  const callEV = weak.math.callEV!;
  const required = weak.math.requiredEquity;
  assert.ok(
    Math.abs(callEV - (eqBet * weak.math.winnable - weak.math.callCost)) < 1e-9,
    'CALL EV 必须来自下注范围权益',
  );
  assert.equal(callEV > 0, eqBet > required, 'EV 符号必须与「权益 vs 门槛」一致');
  assert.ok(
    callEV < 0,
    `该节点必须是数学上的 FOLD（callEV=${callEV.toFixed(2)}，权益 ${(eqBet * 100).toFixed(2)}% vs 门槛 ${(required * 100).toFixed(2)}%）` +
      ' —— 修复不得把所有顶对都变成 CALL',
  );
  const run = analyzeManualHand(spot(['As', 'Js'], 20, 'MANIAC'), {
    rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: SEED,
    budget: { softMs: 120_000, hardMs: 240_000 },
  });
  assert.equal(run.ok, true, '完整管线必须成功');
  if (run.ok) {
    assert.notEqual(run.decision.action, 'CALL', `EV 为负时不得建议 CALL（实际 ${run.decision.action}）`);
  }
});

/* ============================================================
 * M8 —— 边界
 * ============================================================ */

test('M8：零权重 / 空范围 / 死牌冲突 / 非法下注金额', () => {
  const tendencies = responseTendenciesOf(archetypeDimensionsOf('NORMAL', 0.35), 0.35, null);
  const hero = ['As', 'Ks'].map(parseCardStrict);
  const base = {
    board: BOARD_CARDS, heroHole: hero, potChips: 53, tendencies, street: 'RIVER' as const,
  };

  // ① 非法下注金额 ⇒ null（不编造）
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      buildBettingRangeFacts({ ...base, arrivalEntries: arrivalOf([['Kc', 'Jd']]), betChips: bad }),
      null,
      `下注额 ${String(bad)} 必须返回 null`,
    );
  }
  // ② 底池为 0 / 非法
  assert.equal(buildBettingRangeFacts({ ...base, potChips: 0, arrivalEntries: arrivalOf([['Kc', 'Jd']]), betChips: 10 }), null);
  // ③ 空到达范围
  assert.equal(buildBettingRangeFacts({ ...base, arrivalEntries: [], betChips: 40 }), null);
  // ④ 全是零权重
  assert.equal(
    buildBettingRangeFacts({
      ...base, betChips: 40,
      arrivalEntries: arrivalOf([['Kc', 'Jd'], ['Kh', 'Td']]).map((e) => ({ ...e, probability: 0 })),
    }),
    null,
  );
  // ⑤ 全部与 Hero / 公共牌冲突（死牌）⇒ 没有可用组合
  assert.equal(
    buildBettingRangeFacts({
      ...base, betChips: 40,
      arrivalEntries: arrivalOf([['As', 'Kd'], ['Ks', '9c'], ['4h', '6s']]),
    }),
    null,
  );
  // ⑥ 牌面不足 3 张 / Hero 底牌不为 2 张
  assert.equal(buildBettingRangeFacts({ ...base, board: [parseCardStrict('Kd')], arrivalEntries: arrivalOf([['Kc', 'Jd']]), betChips: 40 }), null);
  assert.equal(buildBettingRangeFacts({ ...base, heroHole: [parseCardStrict('As')], arrivalEntries: arrivalOf([['Kc', 'Jd']]), betChips: 40 }), null);
  // ⑦ 与 Hero 底牌冲突的组合被**合法阻断**（不计入任何一侧），其余照常
  const f = buildBettingRangeFacts({
    ...base, betChips: 40,
    arrivalEntries: arrivalOf([['As', 'Kd'], ['Kc', 'Jd'], ['Kh', 'Td']]),
  })!;
  assert.ok(f, '扣除死牌后仍有可用组合 ⇒ 必须能构造');
  assert.ok(f.entries.length === 2, `只剩 2 个合法组合（实际 ${f.entries.length}）`);
  assert.ok(Math.abs(f.entries.reduce((a, e) => a + e.probability, 0) - 1) < 1e-12, '归一化必须仍然正确');
});

test('M8b：极端画像下所有带都必须是有限的、严格正的、且满足强度阶梯', () => {
  const corners = [0, 0.5, 1];
  for (const aggression of corners) {
    for (const bluffTendency of corners) {
      for (const passivity of corners) {
        for (const tightness of corners) {
          const tendencies = responseTendenciesOf(
            { tightness, aggression, bluffTendency, passivity } as never, 1, null,
          );
          for (const ratio of [0, 1 / 3, 2 / 3, 1, 4, 50]) {
            const p = betProbabilityByBand({ tendencies, ratioToPot: ratio });
            for (const b of BANDS) {
              const r = p.rates[b];
              assert.ok(Number.isFinite(r), `rates.${b} 必须有限（aggro=${aggression}, bluff=${bluffTendency}, passive=${passivity}, ratio=${ratio}）`);
              assert.ok(r > 0 && r < 1, `rates.${b} 必须在 (0,1) 开区间（实际 ${r}）`);
            }
            // 强度阶梯（到诈唬端为止）
            const ladder = ['NUT', 'STRONG_MADE', 'TWO_PAIR', 'OVERPAIR', 'TOP_PAIR_GOOD', 'TOP_PAIR_WEAK', 'MIDDLE_PAIR', 'WEAK_PAIR'] as const;
            for (let i = 1; i < ladder.length; i += 1) {
              assert.ok(
                p.rates[ladder[i]!] <= p.rates[ladder[i - 1]!] + 1e-15,
                `阶梯必须非递增：${ladder[i - 1]}=${p.rates[ladder[i - 1]!]} 与 ${ladder[i]}=${p.rates[ladder[i]!]}`,
              );
            }
          }
        }
      }
    }
  }
});

test('M8c：公共强度带判定不得依赖 Hero 底牌，且非法输入返回 null', () => {
  const band = publicStrengthBandOf([parseCardStrict('Kc'), parseCardStrict('Jd')], BOARD_CARDS);
  assert.equal(band, 'TOP_PAIR_GOOD', `KJ 在 K 高牌面是「顶对·好踢脚」（实际 ${band}）`);
  assert.equal(publicStrengthBandOf([parseCardStrict('Kc'), parseCardStrict('8d')], BOARD_CARDS), 'TOP_PAIR_WEAK');
  /* 注意：`9d9h` 与 `4d4c` 在含 9♣/4♥ 的牌面上是**暗三条**，不是中对/底对 */
  assert.equal(publicStrengthBandOf([parseCardStrict('9d'), parseCardStrict('5c')], BOARD_CARDS), 'MIDDLE_PAIR');
  assert.equal(publicStrengthBandOf([parseCardStrict('4d'), parseCardStrict('3c')], BOARD_CARDS), 'WEAK_PAIR');
  assert.equal(publicStrengthBandOf([parseCardStrict('9d'), parseCardStrict('9h')], BOARD_CARDS), 'STRONG_MADE', '99 在含 9 的牌面上是暗三条');
  assert.equal(publicStrengthBandOf([parseCardStrict('Jc'), parseCardStrict('Tc')], BOARD_CARDS), 'AIR');
  assert.equal(publicStrengthBandOf([parseCardStrict('Kc'), parseCardStrict('9d')], BOARD_CARDS), 'TWO_PAIR');
  assert.equal(publicStrengthBandOf([parseCardStrict('Kd')], BOARD_CARDS), null, '底牌不足 2 张 ⇒ null');
  assert.equal(publicStrengthBandOf([parseCardStrict('Kc'), parseCardStrict('Jd')], [parseCardStrict('Kd')]), null, '牌面不足 3 张 ⇒ null');
  assert.equal(PublicStrengthBand.AIR, 'AIR');
});

/* ============================================================
 * M9 —— 同一次范围计算（无旧缓存复用）
 * ============================================================ */

test('M9：下注范围 / 权益 / EV / 动作同源，且跨节点不存在缓存污染', () => {
  const x1 = build(spot(['As', 'Ks'], 20, 'CALLING_STATION'));
  build(spot(['As', 'Ks'], 20, 'MANIAC')); // 中间插入一个不同画像的节点
  build(spot(['Ah', 'Qh'], 8, 'NORMAL'));
  const x2 = build(spot(['As', 'Ks'], 20, 'CALLING_STATION'));

  const pick = (c: ReturnType<typeof build>) => ({
    eqArr: c.math.heroEquity,
    eqBet: c.math.heroEquityVsBetRange,
    callEV: c.math.callEV,
    share: factsOf(c).bettingRangeFacts!.betShareOfArrival,
    arrival: factsOf(c).betRangeArrival!.heroEquityVsArrivalRange,
    bands: JSON.stringify(factsOf(c).bettingRangeFacts!.bandMasses),
    rates: JSON.stringify(factsOf(c).bettingRangeFacts!.bandRates),
  });
  assert.deepEqual(pick(x2), pick(x1), '同一节点两次运行必须逐位一致（无跨画像缓存污染）');

  // 一致性：CALL EV 用下注范围权益
  const m = x1.math;
  assert.ok(
    Math.abs(m.callEV! - (m.heroEquityVsBetRange! * m.winnable - m.callCost)) < 1e-12,
    'CALL EV 必须 = 下注范围权益 × 可争夺量 − 跟注额',
  );
  // 到达范围权益必须标注来源（被排除的动作）
  assert.ok(factsOf(x1).betRangeArrival!.excludedActionZh, '必须说明哪一条动作被排除出到达范围');
  // 三个权益必须是三个不同的量（口径没有被合并）
  const vals = new Set([
    factsOf(x1).betRangeArrival!.heroEquityVsArrivalRange,
    m.heroEquityVsBetRange,
    m.heroEquity,
  ]);
  assert.equal(vals.size, 3, `到达 / 下注 / 整体三个口径必须不同（实际 ${JSON.stringify([...vals])}）`);
});
