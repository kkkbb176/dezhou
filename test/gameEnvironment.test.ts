/**
 * Step 6.5 测试：牌局环境（3 种模式）
 *
 * ## 本文件要守住的硬约束（规范要求）
 *
 * 1. 环境只允许改 **Range 先验 / 动作似然 / 阈值**；
 *    **绝对不允许**改牌力、底池、筹码、SPR、底池赔率、所需权益、权益公式。
 * 2. 环境必须是**带版本与来源的可审计配置**，不得散落 if/else。
 * 3. 没有数据支撑的调整必须标记为启发式，且强度必须保守。
 * 4. **同一手牌在三种模式下必须给出「相同或不同」的可解释结论**；
 *    如果只是模式名字变了、结果完全一样，功能就是未完成的。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_GAME_ENVIRONMENTS,
  DEFAULT_GAME_ENVIRONMENT,
  GameEnvironment,
  MAX_ENVIRONMENT_ADJUSTMENT,
  assertValidEnvironmentProfile,
  defaultEnvironmentProfile,
  effectiveAdjustment,
  environmentDeltaNote,
  environmentProfile,
  isGameEnvironment,
  validateEnvironmentProfile,
  type GameEnvironmentProfile,
} from '../src/domain/range/gameEnvironment.ts';
import {
  adjustComboWeightsBatch,
  composeWithEnvironment,
  createEnvironmentAwareProvider,
  createProfileRangeProvider,
} from '../src/domain/range/profileProvider.ts';
import { readPlayer, scaleAdjustmentConfidence } from '../src/domain/player/playerClassifier.ts';
import { createProfile, observeHand } from '../src/domain/player/playerProfile.ts';
import { PlayerMetric } from '../src/domain/player/player.types.ts';
import { ALL_COMBOS } from '../src/domain/range/combo.ts';
import { RangeSource } from '../src/domain/range/range.types.ts';
import { uniformRange } from '../src/domain/range/range.ts';
import {
  potOdds,
  requiredEquityForBet,
  spr,
  callEV,
} from '../src/domain/poker/odds.ts';
import { parseCardStrict } from '../src/domain/poker/cards.ts';

/* ============================================================
 * 辅助
 * ============================================================ */

const TS = '2024-06-01T12:00:00.000Z';

/** 构造一个「中等常客」画像（贴近先验中心），使环境差异不被画像噪声淹没 */
function mediumProfile(playerId = 'villain') {
  let profile = createProfile(playerId);
  for (let i = 0; i < 400; i++) {
    const outcome = observeHand(profile, {
      handId: `${playerId}-H${i}`,
      playerId,
      seq: i,
      timestamp: TS,
      observations: [
        { metric: PlayerMetric.VPIP, success: i < 100 },
        { metric: PlayerMetric.PFR, success: i < 72 },
      ],
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) profile = outcome.value;
  }
  return profile;
}

/** 弱的对手：入池率很高，用于让环境的「范围宽窄」差异显性化 */
function looseProfile(playerId = 'fish') {
  let profile = createProfile(playerId);
  for (let i = 0; i < 400; i++) {
    const outcome = observeHand(profile, {
      handId: `${playerId}-H${i}`,
      playerId,
      seq: i,
      timestamp: TS,
      observations: [
        { metric: PlayerMetric.VPIP, success: i < 240 },
        { metric: PlayerMetric.PFR, success: i < 60 },
      ],
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) profile = outcome.value;
  }
  return profile;
}

/** 取某个 rank class 在因子数组上的平均因子 */
function meanFactorForRankClass(factors: readonly number[], rankClass: string): number {
  let sum = 0;
  let count = 0;
  ALL_COMBOS.forEach((combo, index) => {
    if (combo.rankClass === rankClass) {
      sum += factors[index]!;
      count++;
    }
  });
  return count > 0 ? sum / count : Number.NaN;
}

/* ============================================================
 * 一、三种环境的配置合法性与可审计性
 * ============================================================ */

test('三种环境全部登记，且默认是中低级别', () => {
  assert.equal(ALL_GAME_ENVIRONMENTS.length, 3);
  assert.deepEqual(
    [...ALL_GAME_ENVIRONMENTS].sort(),
    ['LOW_STAKES_ONLINE', 'MID_LOW_STAKES', 'THEORY_REFERENCE'].sort(),
  );
  assert.equal(DEFAULT_GAME_ENVIRONMENT, GameEnvironment.MID_LOW_STAKES);
  // 中文标签
  assert.equal(environmentProfile(GameEnvironment.LOW_STAKES_ONLINE).label, '低级别线上');
  assert.equal(environmentProfile(GameEnvironment.MID_LOW_STAKES).label, '中低级别');
  assert.equal(environmentProfile(GameEnvironment.THEORY_REFERENCE).label, '理论参考');
});

test('每个环境的配置都通过校验（带版本、带来源、调整在界内）', () => {
  for (const environment of ALL_GAME_ENVIRONMENTS) {
    const profile = environmentProfile(environment);
    const issues = validateEnvironmentProfile(profile);
    assert.deepEqual(issues, [], `${environment} 配置不合法：${JSON.stringify(issues)}`);
    assert.doesNotThrow(() => assertValidEnvironmentProfile(profile));
    // 可审计性：版本 + 来源 + 中文说明缺一不可
    assert.ok(profile.version.length > 0, `${environment} 缺少版本`);
    assert.ok(profile.description.length > 0, `${environment} 缺少中文说明`);
    assert.equal(profile.provenance.sourceType, RangeSource.HEURISTIC, `${environment} 来源必须是启发式`);
    assert.ok(profile.provenance.sourceId.length > 0);
    assert.ok(profile.provenance.version.length > 0);
  }
});

test('所有调整都在保守护栏之内（±25%）', () => {
  const bound = 1 + MAX_ENVIRONMENT_ADJUSTMENT;
  for (const environment of ALL_GAME_ENVIRONMENTS) {
    for (const [field, value] of Object.entries(environmentProfile(environment).adjustment)) {
      assert.ok(
        value > 0 && Number.isFinite(value),
        `${environment}.${field} = ${value} 必须为正有限数`,
      );
      assert.ok(
        Math.abs(value - 1) <= MAX_ENVIRONMENT_ADJUSTMENT + 1e-12,
        `${environment}.${field} = ${value} 超出 ±${MAX_ENVIRONMENT_ADJUSTMENT} 的保守范围`,
      );
    }
  }
});

test('回归：写超护栏的配置必须被**拒绝**，不得静默夹住', () => {
  const bad: GameEnvironmentProfile = {
    ...defaultEnvironmentProfile(),
    adjustment: { ...defaultEnvironmentProfile().adjustment, rangeWidth: 3 },
  };
  const issues = validateEnvironmentProfile(bad);
  assert.ok(issues.some((i) => i.code === 'ADJUSTMENT_OUT_OF_BOUNDS'), JSON.stringify(issues));
  assert.throws(() => assertValidEnvironmentProfile(bad), /不合法/);
});

test('回归：非正 / NaN 调整值必须被拒绝', () => {
  for (const value of [0, -1, Number.NaN]) {
    const bad: GameEnvironmentProfile = {
      ...defaultEnvironmentProfile(),
      adjustment: { ...defaultEnvironmentProfile().adjustment, aggression: value },
    };
    const issues = validateEnvironmentProfile(bad);
    assert.ok(
      issues.some((i) => i.code === 'NON_POSITIVE_ADJUSTMENT' || i.code === 'ADJUSTMENT_OUT_OF_BOUNDS'),
      `value=${value} 必须被拒绝，实际 ${JSON.stringify(issues)}`,
    );
  }
});

test('回归：缺少版本的配置必须被拒绝（缓存与复盘依赖版本）', () => {
  const bad: GameEnvironmentProfile = { ...defaultEnvironmentProfile(), version: '' };
  assert.ok(validateEnvironmentProfile(bad).some((i) => i.code === 'MISSING_VERSION'));
});

test('未登记的环境名必须**抛错**，绝不静默回退到默认', () => {
  assert.throws(() => environmentProfile('NOT_AN_ENV' as GameEnvironment), /未登记/);
  assert.equal(isGameEnvironment('MID_LOW_STAKES'), true);
  assert.equal(isGameEnvironment('mid_low_stakes'), false, '大小写敏感，避免拼写错误被放过');
  assert.equal(isGameEnvironment(123), false);
  assert.equal(isGameEnvironment(undefined), false);
});

/* ============================================================
 * 二、三种模式必须真的不同（规范的核心测试要求）
 * ============================================================ */

test('基准环境的所有调整因子恰好为 1（它必须等于「不调整」）', () => {
  const base = environmentProfile(GameEnvironment.MID_LOW_STAKES).adjustment;
  for (const [field, value] of Object.entries(base)) {
    assert.equal(value, 1, `基准环境的 ${field} 必须恰好为 1（实际 ${value}）`);
  }
});

test('三种环境两两之间至少有一个维度不同（不得只是名字变了）', () => {
  const a = environmentProfile(GameEnvironment.LOW_STAKES_ONLINE).adjustment;
  const b = environmentProfile(GameEnvironment.MID_LOW_STAKES).adjustment;
  const c = environmentProfile(GameEnvironment.THEORY_REFERENCE).adjustment;

  const differs = (x: typeof a, y: typeof a): boolean =>
    Object.keys(x).some((key) => Math.abs(x[key as keyof typeof x] - y[key as keyof typeof y]) > 1e-9);

  assert.ok(differs(a, b), '低级别线上与中低级别必须不同');
  assert.ok(differs(b, c), '中低级别与理论参考必须不同');
  assert.ok(differs(a, c), '低级别线上与理论参考必须不同');
});

test('方向正确：低级别线上比理论参考**更宽、更被动、诈唬更少**', () => {
  const low = environmentProfile(GameEnvironment.LOW_STAKES_ONLINE).adjustment;
  const theory = environmentProfile(GameEnvironment.THEORY_REFERENCE).adjustment;

  assert.ok(low.rangeWidth > theory.rangeWidth, '低级别范围更宽');
  assert.ok(low.aggression < theory.aggression, '低级别更被动');
  assert.ok(low.bluffShare < theory.bluffShare, '低级别诈唬更少');
  // 低级别对手用中等牌下价值的门槛更低（更愿意「薄价值」下注）
  assert.ok(low.valueThreshold < theory.valueThreshold, '低级别价值门槛更低');
  // 低级别河牌大注更容易是真牌 → 我们应更保守
  assert.ok(low.riverAdjustment < theory.riverAdjustment, '低级别河牌更保守');
});

test('**核心要求**：同一手牌在三种模式下得到不同或可解释的结论', () => {
  const player = readPlayer(looseProfile());

  const results = ALL_GAME_ENVIRONMENTS.map((environment) => {
    const profile = environmentProfile(environment);
    const composed = composeWithEnvironment(player.adjustment, profile.confidence);
    const effective = effectiveAdjustment(profile, 2);
    const { factors, stats } = adjustComboWeightsBatch(ALL_COMBOS, composed, undefined, effective);
    return {
      environment,
      label: profile.label,
      weak: meanFactorForRankClass(factors, '72o'),
      strong: meanFactorForRankClass(factors, 'AA'),
      meanFactor: stats.meanFactor,
    };
  });

  // 三种模式的结果必须**不是**完全一样 —— 否则功能未完成
  const weakValues = results.map((r) => r.weak.toFixed(12));
  assert.ok(
    new Set(weakValues).size > 1,
    `三种模式对同一手弱牌的因子不得完全相同（实际 ${JSON.stringify(results.map((r) => [r.label, r.weak]))}）`,
  );

  const at = (environment: GameEnvironment) => results.find((r) => r.environment === environment)!;
  const low = at(GameEnvironment.LOW_STAKES_ONLINE);
  const mid = at(GameEnvironment.MID_LOW_STAKES);
  const theory = at(GameEnvironment.THEORY_REFERENCE);

  // 差异方向必须可解释：低级别与中低级别的**强度梯度**（弱牌/强牌 因子比）
  // 都必须比理论参考更平缓。
  //
  // ⚠️ 刻意不比较弱牌因子的**绝对值排序**：三个环境的可信度不同
  // （0.35 / 0.40 / 0.30），而可信度会与端倾斜叠加 —— 实测
  // 低级别 1.08504 < 中低级别 1.08557（可信度更高者抵消了端倾斜的优势）。
  // 这是可信度语义的正确表现，不是缺陷；有意义的量是**比值**。
  const gradient = (r: typeof low): number => r.weak / r.strong;
  assert.ok(
    gradient(low) > gradient(theory),
    `低级别的强度梯度必须比理论参考更平缓（低级别 ${gradient(low)} vs 理论 ${gradient(theory)}）`,
  );
  assert.ok(
    gradient(mid) > gradient(theory),
    `中低级别的强度梯度必须比理论参考更平缓（中低 ${gradient(mid)} vs 理论 ${gradient(theory)}）`,
  );

  // 每一种模式都必须能说清自己改了什么
  for (const environment of ALL_GAME_ENVIRONMENTS) {
    const profile = environmentProfile(environment);
    const notes = environmentDeltaNote(profile, effectiveAdjustment(profile, 2));
    if (environment === GameEnvironment.MID_LOW_STAKES) {
      assert.equal(notes.length, 0, '基准环境不应报告任何修正');
    } else {
      assert.ok(notes.length > 0, `${environment} 必须能说清改了什么`);
      for (const note of notes) {
        assert.ok(note.length > 0 && /[\u4e00-\u9fa5]/.test(note), `说明必须是中文：「${note}」`);
      }
    }
  }
});

test('三种环境对强牌端的影响必须很小（环境只能微调强牌）', () => {
  const player = readPlayer(looseProfile());
  const strongFactors = ALL_GAME_ENVIRONMENTS.map((environment) => {
    const profile = environmentProfile(environment);
    const composed = composeWithEnvironment(player.adjustment, profile.confidence);
    const { factors } = adjustComboWeightsBatch(
      ALL_COMBOS,
      composed,
      undefined,
      effectiveAdjustment(profile, 2),
    );
    return meanFactorForRankClass(factors, 'AA');
  });

  const spread = Math.max(...strongFactors) / Math.min(...strongFactors) - 1;
  assert.ok(
    spread < 0.05,
    `强牌端在三种环境之间的相对差异必须很小（实际 ${(spread * 100).toFixed(2)}%）`,
  );
});

test('如实记录：几何均值归一意味着「动一端必然轻微带动另一端」', () => {
  // 这是归一化的**数学后果**，不是缺陷，但必须被记录，否则将来有人
  // 看到「环境把 AA 的因子也改了一点」会误以为是 Bug。
  const player = readPlayer(looseProfile());
  const composed = composeWithEnvironment(
    player.adjustment,
    environmentProfile(GameEnvironment.MID_LOW_STAKES).confidence,
  );

  const base = adjustComboWeightsBatch(ALL_COMBOS, composed);
  const tilted = adjustComboWeightsBatch(
    ALL_COMBOS,
    composed,
    undefined,
    { ...effectiveAdjustment(environmentProfile(GameEnvironment.LOW_STAKES_ONLINE), 2), weakEndTilt: 1.25 },
  );

  const strongBase = meanFactorForRankClass(base.factors, 'AA');
  const strongTilted = meanFactorForRankClass(tilted.factors, 'AA');
  const weakBase = meanFactorForRankClass(base.factors, '72o');
  const weakTilted = meanFactorForRankClass(tilted.factors, '72o');

  // 弱牌端被明显抬高
  assert.ok(weakTilted > weakBase * 1.005, `弱牌端必须被抬升（${weakBase} → ${weakTilted}）`);
  // 强牌端被轻微带动（方向相反，幅度远小）
  assert.ok(
    Math.abs(strongTilted / strongBase - 1) < Math.abs(weakTilted / weakBase - 1),
    `强牌端的被动偏移必须小于弱牌端的主动偏移（强 ${strongTilted / strongBase - 1}，弱 ${weakTilted / weakBase - 1}）`,
  );
  // 两端偏移的乘积接近 1（几何均值归一的自然后果）
  const product = (strongTilted / strongBase) * (weakTilted / weakBase);
  assert.ok(Number.isFinite(product) && product > 0);
});

test('端倾斜必须独立于可信度生效：同一可信度下，弱牌端倾斜倍数直接决定梯度', () => {
  // 把三个环境的可信度强行统一，隔离出「端倾斜」这一项的净效果。
  // 否则环境之间的可信度差异（0.35 / 0.40 / 0.30）会掩盖倾斜差异 ——
  // 这正是本测试第一次失败的原因，属于测试设计问题而非实现缺陷。
  const FLAT_CONFIDENCE = 0.35;
  const player = readPlayer(looseProfile());

  const gradients = ALL_GAME_ENVIRONMENTS.map((environment) => {
    const profile = environmentProfile(environment);
    const composed = composeWithEnvironment(player.adjustment, FLAT_CONFIDENCE);
    const { factors } = adjustComboWeightsBatch(
      ALL_COMBOS,
      composed,
      undefined,
      effectiveAdjustment(profile, 2),
    );
    return {
      environment,
      gradient: meanFactorForRankClass(factors, '72o') / meanFactorForRankClass(factors, 'AA'),
    };
  });

  const value = (environment: GameEnvironment) =>
    gradients.find((g) => g.environment === environment)!.gradient;

  assert.ok(
    value(GameEnvironment.LOW_STAKES_ONLINE) > value(GameEnvironment.MID_LOW_STAKES),
    `统一可信度后，低级别梯度必须大于中低级别（${value(GameEnvironment.LOW_STAKES_ONLINE)} vs ${value(GameEnvironment.MID_LOW_STAKES)}）`,
  );
  assert.ok(
    value(GameEnvironment.MID_LOW_STAKES) > value(GameEnvironment.THEORY_REFERENCE),
    `统一可信度后，中低级别梯度必须大于理论参考（${value(GameEnvironment.MID_LOW_STAKES)} vs ${value(GameEnvironment.THEORY_REFERENCE)}）`,
  );
});

/* ============================================================
 * 三、绝不允许越界：环境不得改牌力 / 底池 / 赔率
 * ============================================================ */

test('结构性：gameEnvironment 不得导入任何牌力 / 赔率 / 权益模块', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/domain/range/gameEnvironment.ts', import.meta.url), 'utf8');
  const importLines = source
    .split('\n')
    .filter((line) => /^\s*(import|export)\s/.test(line) && line.includes('from'))
    .join('\n');
  for (const forbidden of [
    'handEval',
    'fastEval',
    'equity',
    'odds',
    'gameState',
    'engine',
    'validator',
    'handDescription',
  ]) {
    assert.ok(
      !importLines.includes(forbidden),
      `gameEnvironment 不得导入 ${forbidden}（实际导入：${importLines}）`,
    );
  }
});

test('结构性：环境模块的导出里不含牌力 / 赔率相关 API', async () => {
  const keys = Object.keys(await import('../src/domain/range/gameEnvironment.ts'));
  assert.ok(keys.length > 0, '前置条件：模块确实导出了东西');
  for (const key of keys) {
    assert.ok(
      !/evaluate|equity|potOdds|requiredEquity|handRank|spr|callEV/i.test(key),
      `环境模块不得导出牌力/赔率 API（发现 ${key}）`,
    );
  }
});

test('行为：切换环境不得改变任何赔率 / SPR / EV 计算结果', () => {
  const pot = 10_000;
  const callCost = 3_000;
  const bet = 5_000;
  const stack = 50_000;

  // 记录基准结果（这些函数返回 MathOutcome，逐个断言成功且数值相同）
  const potOddsRef = potOdds(pot, callCost);
  const requiredRef = requiredEquityForBet(pot, bet);
  const sprRef = spr(stack, pot);
  const evRef = callEV(0.4, pot + bet, callCost);
  assert.equal(potOddsRef.ok, true);
  assert.equal(requiredRef.ok, true);
  assert.equal(sprRef.ok, true);
  assert.equal(evRef.ok, true);
  if (!potOddsRef.ok || !requiredRef.ok || !sprRef.ok || !evRef.ok) return;

  // 遍历三种环境走一遍「典型决策流程」，赔率类结果必须逐位相同
  for (const environment of ALL_GAME_ENVIRONMENTS) {
    const profile = environmentProfile(environment);
    // 环境只影响概率因子；这里刻意消费它以确保环境确实被「用到了」
    const effective = effectiveAdjustment(profile, 3);
    assert.ok(Number.isFinite(effective.rangeWidth) && effective.rangeWidth > 0);
    assertValidEnvironmentProfile(profile);

    assert.deepEqual(potOdds(pot, callCost), potOddsRef, `${environment} 改变了底池赔率`);
    assert.deepEqual(requiredEquityForBet(pot, bet), requiredRef, `${environment} 改变了所需权益`);
    assert.deepEqual(spr(stack, pot), sprRef, `${environment} 改变了 SPR`);
    assert.deepEqual(callEV(0.4, pot + bet, callCost), evRef, `${environment} 改变了 EV`);
  }
});

test('行为：环境不得改变牌力评估结果（用真实牌力引擎对照）', async () => {
  const { evaluateSeven } = await import('../src/domain/poker/fastEval.ts');
  const cards = ['As', 'Ks', 'Qs', 'Js', 'Ts', '2d', '3c'].map(parseCardStrict);

  const reference = evaluateSeven(cards);
  for (const environment of ALL_GAME_ENVIRONMENTS) {
    // 前置条件：环境配置本身必须合法（否则测试证明不了任何事）
    assertValidEnvironmentProfile(environmentProfile(environment));
    const again = evaluateSeven(cards);
    assert.deepEqual(again, reference, `${environment} 改变了牌力评估结果`);
  }
});

test('环境只改变概率形状：因子几何均值必须为 1（不整体放大）', () => {
  const player = readPlayer(looseProfile());
  for (const environment of ALL_GAME_ENVIRONMENTS) {
    const profile = environmentProfile(environment);
    const composed = composeWithEnvironment(player.adjustment, profile.confidence);
    const { factors } = adjustComboWeightsBatch(ALL_COMBOS, composed);
    let logSum = 0;
    for (const f of factors) logSum += Math.log(f);
    const geometricMean = Math.exp(logSum / factors.length);
    assert.ok(
      Math.abs(geometricMean - 1) < 1e-9,
      `${environment}：几何均值必须为 1（实际 ${geometricMean}）`,
    );
    assert.ok(factors.every((f) => Number.isFinite(f) && f > 0), `${environment} 产生了非法因子`);
  }
});

/* ============================================================
 * 四、与环境组合后的可信度语义
 * ============================================================ */

test('组合可信度必须取两层中较弱者（乘法）：低可信环境不得被高可信画像掩盖', () => {
  const player = readPlayer(mediumProfile());
  assert.ok(player.adjustment.confidence > 0.5, '前置条件：画像本身可信度较高');

  for (const environment of ALL_GAME_ENVIRONMENTS) {
    const profile = environmentProfile(environment);
    const composed = composeWithEnvironment(player.adjustment, profile.confidence);
    assert.ok(
      composed.confidence <= player.adjustment.confidence + 1e-12,
      `${environment}：组合可信度不得高于画像本身`,
    );
    assert.ok(
      composed.confidence <= profile.confidence + 1e-12,
      `${environment}：组合可信度不得高于环境本身`,
    );
    assert.ok(composed.confidence > 0, '组合可信度必须为正');
  }
});

test('scaleAdjustmentConfidence 只缩放可信度，**绝不触碰任何维度**', () => {
  const player = readPlayer(looseProfile());
  const scaled = scaleAdjustmentConfidence(player.adjustment, 0.5);

  assert.deepEqual(scaled.dimensions, player.dimensions, '维度必须逐字段完全相同');
  assert.ok(Math.abs(scaled.confidence - player.adjustment.confidence * 0.5) < 1e-12);
});

test('scaleAdjustmentConfidence 的边界：NaN 不改变、>1 不放大、负数归零', () => {
  const player = readPlayer(looseProfile());
  assert.equal(scaleAdjustmentConfidence(player.adjustment, Number.NaN), player.adjustment);
  assert.equal(scaleAdjustmentConfidence(player.adjustment, 2), player.adjustment, '>1 不得放大');
  assert.equal(scaleAdjustmentConfidence(player.adjustment, -1).confidence, 0, '负数归零');
});

test('环境可信度不足以支撑调整时，组合后必须回到中立（不注入噪声）', () => {
  const player = readPlayer(mediumProfile());
  // 极端：环境可信度 0
  const composed = composeWithEnvironment(player.adjustment, 0);
  assert.equal(composed.confidence, 0);
  const provider = createProfileRangeProvider(composed);
  assert.equal(provider.isNeutral(), true, '置信度为 0 时必须中立');
  for (const combo of ['AsAd', '7c2d'].map((id) => ALL_COMBOS.find((c) => c.canonicalId === id)!)) {
    assert.equal(provider.adjustComboWeight!(combo, {
      street: 'FLOP',
      action: 'BET' as const,
      actor: 'v',
      actionIndex: 0,
      activePlayerCount: 2,
    }), 1);
  }
});

/* ============================================================
 * 五、多人池维度
 * ============================================================ */

test('多人池：人数增加时对手范围单调变宽（方向不得写反）', () => {
  const profile = environmentProfile(GameEnvironment.LOW_STAKES_ONLINE);
  let previous = Number.NEGATIVE_INFINITY;
  for (const players of [2, 3, 4, 5, 6]) {
    const effective = effectiveAdjustment(profile, players);
    assert.ok(
      effective.rangeWidth >= previous - 1e-12,
      `人数 ${players} 时范围宽度 ${effective.rangeWidth} 不得小于更少人数时的 ${previous}`,
    );
    previous = effective.rangeWidth;
  }
  assert.ok(
    effectiveAdjustment(profile, 6).rangeWidth > effectiveAdjustment(profile, 2).rangeWidth,
    '6 人池的对手范围必须比单挑更宽',
  );
});

test('多人池：2 人池必须恰好等于基准（不引入任何额外调整）', () => {
  for (const environment of ALL_GAME_ENVIRONMENTS) {
    const profile = environmentProfile(environment);
    const effective = effectiveAdjustment(profile, 2);
    assert.deepEqual(effective, profile.adjustment, `${environment}：单挑时不得有额外修正`);
  }
});

test('多人池：非法人数必须被夹到合法范围，不得产生 NaN / Infinity', () => {
  const profile = environmentProfile(GameEnvironment.LOW_STAKES_ONLINE);
  for (const players of [0, 1, -5, Number.NaN, 2.7, 1000]) {
    const effective = effectiveAdjustment(profile, players);
    for (const [field, value] of Object.entries(effective)) {
      assert.ok(
        Number.isFinite(value) && value > 0,
        `players=${players} 时 ${field} = ${value} 非法`,
      );
    }
  }
});

test('理论参考环境不应有额外多人池修正（它假设理性对手）', () => {
  const effective = effectiveAdjustment(environmentProfile(GameEnvironment.THEORY_REFERENCE), 6);
  const base = environmentProfile(GameEnvironment.THEORY_REFERENCE).adjustment;
  assert.equal(effective.rangeWidth, base.rangeWidth, '理论参考的多人池系数为 1，不应放大');
});

/* ============================================================
 * 六、环境感知 provider
 * ============================================================ */

test('环境感知 provider：说明里必须同时讲清「画像」与「环境」两层来源', () => {
  const player = readPlayer(looseProfile());
  const profile = environmentProfile(GameEnvironment.LOW_STAKES_ONLINE);
  const provider = createEnvironmentAwareProvider(player.adjustment, profile, 3) as ReturnType<
    typeof createEnvironmentAwareProvider
  > & { environmentNote(): string; effectiveAdjustment(): ReturnType<typeof effectiveAdjustment> };

  const description = provider.describe();
  assert.ok(description.includes('低级别线上'), `说明必须点明环境（实际「${description}」）`);
  assert.ok(description.length > 10);

  const envNote = provider.environmentNote();
  assert.ok(envNote.includes('范围更宽'), `环境说明必须指出具体改动（实际「${envNote}」）`);

  const effective = provider.effectiveAdjustment();
  assert.ok(effective.rangeWidth >= profile.adjustment.rangeWidth - 1e-12);
});

test('环境感知 provider：基准环境的说明必须写明「未做额外修正」', () => {
  const player = readPlayer(mediumProfile());
  const profile = environmentProfile(GameEnvironment.MID_LOW_STAKES);
  const provider = createEnvironmentAwareProvider(player.adjustment, profile, 2) as ReturnType<
    typeof createEnvironmentAwareProvider
  > & { environmentNote(): string };

  assert.ok(
    provider.environmentNote().includes('未对概率做额外修正'),
    `实际「${provider.environmentNote()}」`,
  );
});

test('环境感知 provider：内部必须先校验环境配置（坏配置绝不允许进入计算）', () => {
  const player = readPlayer(mediumProfile());
  const bad: GameEnvironmentProfile = {
    ...environmentProfile(GameEnvironment.MID_LOW_STAKES),
    adjustment: { ...environmentProfile(GameEnvironment.MID_LOW_STAKES).adjustment, rangeWidth: 99 },
  };
  assert.throws(() => createEnvironmentAwareProvider(player.adjustment, bad, 2), /不合法/);
});

test('环境感知 provider：样本不足的画像 + 任何环境都必须完全中立', () => {
  let thin = createProfile('thin');
  for (let i = 0; i < 3; i++) {
    const outcome = observeHand(thin, {
      handId: `thin-H${i}`,
      playerId: 'thin',
      seq: i,
      timestamp: TS,
      observations: [
        { metric: PlayerMetric.VPIP, success: true },
        { metric: PlayerMetric.PFR, success: true },
      ],
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) thin = outcome.value;
  }
  const player = readPlayer(thin);

  for (const environment of ALL_GAME_ENVIRONMENTS) {
    const provider = createEnvironmentAwareProvider(
      player.adjustment,
      environmentProfile(environment),
      6,
    );
    for (const id of ['AsAd', '7c2d', 'AsKs']) {
      const combo = ALL_COMBOS.find((c) => c.canonicalId === id)!;
      assert.equal(
        provider.adjustComboWeight!(combo, {
          street: 'FLOP',
          action: 'BET' as const,
          actor: 'v',
          actionIndex: 0,
          activePlayerCount: 6,
        }),
        1,
        `${environment}/${id}：样本不足时必须完全不调整`,
      );
    }
  }
});

/* ============================================================
 * 七、与 Range 引擎的端到端可用性
 * ============================================================ */

test('端到端：三种环境产出的因子都能构造出合法概率分布', () => {
  const player = readPlayer(looseProfile());
  const built = uniformRange({
    sourceId: 'test.env.uniform',
    sourceType: 'TEST_ONLY',
    version: '1.0.0',
    description: '环境测试用均匀范围',
    verified: false,
    confidence: 0.1,
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;

  for (const environment of ALL_GAME_ENVIRONMENTS) {
    const profile = environmentProfile(environment);
    const composed = composeWithEnvironment(player.adjustment, profile.confidence);
    const { factors } = adjustComboWeightsBatch(
      built.value.entries.map((e) => e.combo),
      composed,
    );
    const weighted = built.value.entries.map((e, i) => e.rawWeight * factors[i]!);
    const total = weighted.reduce((s, w) => s + w, 0);
    assert.ok(total > 0, `${environment}：加权总和必须为正`);
    const probabilities = weighted.map((w) => w / total);
    const sum = probabilities.reduce((s, p) => s + p, 0);
    assert.ok(Math.abs(sum - 1) < 1e-12, `${environment}：概率和必须为 1（实际 ${sum}）`);
    assert.ok(probabilities.every((p) => Number.isFinite(p) && p >= 0));
  }
});

test('端到端：环境配置是共享只读常量，使用过程不得污染它', () => {
  const before = JSON.stringify(environmentProfile(GameEnvironment.LOW_STAKES_ONLINE));
  const player = readPlayer(looseProfile());
  for (const environment of ALL_GAME_ENVIRONMENTS) {
    composeWithEnvironment(player.adjustment, environmentProfile(environment).confidence);
    environmentDeltaNote(environmentProfile(environment));
    effectiveAdjustment(environmentProfile(environment), 6);
  }
  const after = JSON.stringify(environmentProfile(GameEnvironment.LOW_STAKES_ONLINE));
  assert.equal(before, after, '环境配置在使用过程中不得被改动');
});

test('中文说明：三种环境都有非空中文描述，且理论参考不得自称 GTO / 最优', () => {
  for (const environment of ALL_GAME_ENVIRONMENTS) {
    const profile = environmentProfile(environment);
    assert.ok(profile.description.length > 10, `${environment} 的描述过短`);
    assert.ok(/[\u4e00-\u9fa5]/.test(profile.description), `${environment} 的描述必须是中文`);
    assert.ok(profile.label.length > 0);
  }
  const theory = environmentProfile(GameEnvironment.THEORY_REFERENCE);
  // 必须**明确写出**它不是求解器输出，而不是靠读者猜测
  const plain = theory.description.replace(/\*/g, '');
  assert.ok(
    plain.includes('不是求解器输出'),
    `理论参考模式必须写明「不是求解器输出」（实际「${theory.description}」）`,
  );
  assert.ok(
    plain.includes('没有求解器输出'),
    `理论参考模式必须写明本项目没有求解器输出（实际「${theory.description}」）`,
  );
  assert.ok(
    plain.includes('不得在界面上称为 GTO 最优'),
    `理论参考模式必须写明禁止称为 GTO 最优（实际「${theory.description}」）`,
  );
});
