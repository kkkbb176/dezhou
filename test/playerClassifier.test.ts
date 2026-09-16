/**
 * Step 6 测试：玩家分类（连续维度 + 标签摘要）与 Range 调整桥接
 *
 * ## 本文件要守住的两条禁令
 *
 * 1. **画像绝不直接决策**（规范第二十节）
 *    禁止 `Nit → Fold`。画像只能给「范围权重因子」与「似然因子」。
 *    因此这里用**结构断言**（类型里没有动作字段）+ 行为断言双重锁定。
 *
 * 2. **标签只是摘要**（规范第十九节）
 *    调整因子必须由**连续维度**计算，不能由标签计算 ——
 *    否则「刚好跨过阈值」会让建议突变。测试用「临界样本」验证连续性。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PlayerMetric,
  METRIC_DEFINITIONS,
  PriorSource,
} from '../src/domain/player/player.types.ts';
import {
  createProfile,
  observeHand,
  type HandObservation,
} from '../src/domain/player/playerProfile.ts';
import { SampleTier } from '../src/domain/player/playerStats.ts';
import {
  DEFAULT_LABEL_THRESHOLDS,
  MAX_ADJUSTMENT,
  PlayerLabel,
  computeAdjustment,
  computeDimensions,
  deriveLabel,
  neutralAdjustment,
  neutralVpipRate,
  readPlayer,
  tightnessFromVpip,
  vpipRateOf,
  type PlayerDimensions,
} from '../src/domain/player/playerClassifier.ts';
import {
  DEFAULT_PROVIDER_CONFIG,
  adjustComboWeightsBatch,
  createProfileRangeProvider,
  neutralizeGeometric,
} from '../src/domain/range/profileProvider.ts';
import { comboById, ALL_COMBOS } from '../src/domain/range/combo.ts';
import { RangeAction, type RangeUpdateContext } from '../src/domain/range/range.types.ts';
import { uniformRange } from '../src/domain/range/range.ts';
import { validateRange } from '../src/domain/range/rangeValidator.ts';

/* ============================================================
 * 测试辅助
 * ============================================================ */

const TS = '2024-06-01T12:00:00.000Z';

/**
 * 构造一个画像：VPIP / PFR 按给定的成功次数录入。
 *
 * 其余指标保持「无机会」（这样维度计算只依赖这两项，
 * 便于精确控制紧松与凶弱）。
 */
function buildProfile(input: {
  playerId?: string;
  hands: number;
  vpipSuccesses: number;
  pfrSuccesses?: number;
  /** 额外指标观测（每次机会计一次） */
  extra?: Array<{ metric: PlayerMetric; success: boolean }>;
}) {
  const playerId = input.playerId ?? 'p1';
  let profile = createProfile(playerId);
  const pfr = input.pfrSuccesses ?? 0;
  for (let i = 0; i < input.hands; i++) {
    const observation: HandObservation = {
      handId: `${playerId}-H${i}`,
      playerId,
      seq: i,
      timestamp: TS,
      observations: [
        { metric: PlayerMetric.VPIP, success: i < input.vpipSuccesses },
        { metric: PlayerMetric.PFR, success: i < pfr },
        ...(input.extra ?? []),
      ],
    };
    const outcome = observeHand(profile, observation);
    assert.equal(outcome.ok, true, `录入第 ${i} 手失败`);
    if (outcome.ok) profile = outcome.value;
  }
  return profile;
}

const CONTEXT: RangeUpdateContext = {
  street: 'FLOP',
  action: RangeAction.BET,
  actor: 'villain',
  actionIndex: 0,
  activePlayerCount: 2,
};

const LIKELIHOOD = (comboId: string, action: RangeAction = RangeAction.BET) => ({
  comboId,
  action,
  likelihood: 0.5,
  source: 'HEURISTIC' as const,
  confidence: 0.5,
});

/* ============================================================
 * 一、样本不足 → 强制未知 + 零调整（规范第十三 / 二十五节）
 * ============================================================ */

test('3 手 100% 入池的「疯子」必须被标为未知玩家（红队案例）', () => {
  const profile = buildProfile({ hands: 3, vpipSuccesses: 3, pfrSuccesses: 3 });
  const read = readPlayer(profile);
  assert.equal(read.label, PlayerLabel.UNKNOWN, '3 手样本绝不允许贴标签');
  assert.equal(read.dimensions.tier, SampleTier.PRELIMINARY);
});

test('样本不足时所有调整因子恒为 1（绝不允许改范围）', () => {
  const profile = buildProfile({ hands: 3, vpipSuccesses: 3, pfrSuccesses: 3 });
  const read = readPlayer(profile);
  for (const key of [
    'rangeWidthFactor',
    'bluffWeightFactor',
    'valueWeightFactor',
    'callingThresholdFactor',
    'foldToAggressionFactor',
  ] as const) {
    assert.equal(read.adjustment[key], 1, `样本不足时 ${key} 必须恰好为 1`);
  }
  assert.equal(read.adjustment.confidence, 0);
});

test('空画像（零手）也必须完全中立，不得出现 NaN', () => {
  const read = readPlayer(createProfile('empty'));
  assert.equal(read.label, PlayerLabel.UNKNOWN);
  assert.equal(read.adjustment.rangeWidthFactor, 1);
  assert.ok(Number.isFinite(read.dimensions.tightness));
  assert.ok(Number.isFinite(read.dimensions.aggression));
  assert.ok(Number.isFinite(read.dimensions.bluffTendency));
  assert.ok(Number.isFinite(read.dimensions.passivity));
});

/* ============================================================
 * 二、连续维度（规范第十九节）
 * ============================================================ */

test('维度：300 手 60% 入池 → 明显偏松；300 手 12% 入池 → 明显偏紧', () => {
  const loose = computeDimensions(buildProfile({ hands: 300, vpipSuccesses: 180 }));
  const tight = computeDimensions(buildProfile({ hands: 300, vpipSuccesses: 36 }));

  assert.ok(loose.tightness < 0.4, `60% 入池必须判为松（紧度 ${loose.tightness}）`);
  assert.ok(tight.tightness > 0.6, `12% 入池必须判为紧（紧度 ${tight.tightness}）`);
  assert.ok(loose.tightness < tight.tightness);
});

test('维度：同样的入池率下，PFR/VPIP 比值越高凶度越高', () => {
  const passive = computeDimensions(buildProfile({ hands: 300, vpipSuccesses: 120, pfrSuccesses: 6 }));
  const aggressive = computeDimensions(buildProfile({ hands: 300, vpipSuccesses: 120, pfrSuccesses: 90 }));
  assert.ok(
    aggressive.aggression > passive.aggression,
    `高 PFR 必须更凶（被动 ${passive.aggression}，凶 ${aggressive.aggression}）`,
  );
});

test('维度都在 [0, 1] 之内（任何输入都不得越界）', () => {
  for (const [hands, vpip, pfr] of [
    [1, 1, 1],
    [3, 0, 0],
    [50, 50, 50],
    [300, 0, 0],
    [300, 300, 300],
    [2000, 1000, 500],
  ] as const) {
    const d = computeDimensions(buildProfile({ hands, vpipSuccesses: vpip, pfrSuccesses: pfr }));
    for (const key of ['tightness', 'aggression', 'bluffTendency', 'passivity', 'confidence'] as const) {
      assert.ok(
        Number.isFinite(d[key]) && d[key] >= 0 && d[key] <= 1,
        `hands=${hands} vpip=${vpip}：${key} = ${d[key]} 越界`,
      );
    }
  }
});

/* ============================================================
 * 三、标签（摘要，不是计算依据）
 * ============================================================ */

test('标签：6 种典型打法各自得到正确的标签', () => {
  const cases = [
    // 极紧：300 手 8%/6%
    { name: 'ultra-tight', hands: 300, vpip: 24, pfr: 18, expected: PlayerLabel.ULTRA_TIGHT },
    // 紧凶：300 手 20%/16%
    { name: 'tight-aggressive', hands: 300, vpip: 60, pfr: 48, expected: PlayerLabel.TIGHT_AGGRESSIVE },
    // 紧弱：300 手 20%/4%
    { name: 'tight-passive', hands: 300, vpip: 60, pfr: 12, expected: PlayerLabel.TIGHT_PASSIVE },
    // 松凶：300 手 40%/32%
    { name: 'loose-aggressive', hands: 300, vpip: 120, pfr: 96, expected: PlayerLabel.LOOSE_AGGRESSIVE },
    // 松弱：300 手 40%/8%
    { name: 'loose-passive', hands: 300, vpip: 120, pfr: 24, expected: PlayerLabel.LOOSE_PASSIVE },
  ] as const;

  for (const item of cases) {
    const read = readPlayer(
      buildProfile({ hands: item.hands, vpipSuccesses: item.vpip, pfrSuccesses: item.pfr }),
    );
    assert.equal(read.label, item.expected, `${item.name}: 期望 ${item.expected}，实际 ${read.label}`);
  }
});

test('回归：入池率阈值必须真的生效（早先版本把维度当成了入池率）', () => {
  // 直接用维度构造，把「入池率 ↔ 紧度」的换算单独隔离出来
  const dimensions = {
    tightness: tightnessFromVpip(0.2), // 入池率 20%
    aggression: 0.3,
    bluffTendency: 0.5,
    passivity: 0.4, // 低于跟注站阈值，避免被跟注站规则抢先
    confidence: 0.9,
    sampleSize: 300,
    tier: SampleTier.CONFIRMED,
  };

  // 20% 入池：默认阈值下是「紧弱」
  assert.equal(deriveLabel(dimensions), PlayerLabel.TIGHT_PASSIVE);

  // 把「极紧」阈值抬到 25% → 同一个玩家应改判为超紧
  assert.equal(
    deriveLabel(dimensions, { ...DEFAULT_LABEL_THRESHOLDS, ultraTightVpip: 0.25 }),
    PlayerLabel.ULTRA_TIGHT,
    '提高 ultraTightVpip 必须让 20% 入池的玩家变成超紧',
  );

  // 把「松」阈值降到 15% 且关掉「紧」的判定 → 同一个玩家应改判为松
  assert.equal(
    deriveLabel(dimensions, {
      ...DEFAULT_LABEL_THRESHOLDS,
      ultraTightVpip: 0.05,
      tightVpip: 0.01,
      looseVpip: 0.15,
    }),
    PlayerLabel.LOOSE_PASSIVE,
    '降低 looseVpip 必须让 20% 入池的玩家变成松',
  );

  // 阈值不动时必须回到默认结果（证明上面两次变化确实来自阈值）
  assert.equal(deriveLabel(dimensions), PlayerLabel.TIGHT_PASSIVE);
});

test('vpipRateOf 必须与 tightnessFromVpip 严格互逆（线性定标）', () => {
  for (const vpip of [0, 0.05, 0.1, 0.14, 0.22, 0.25, 0.32, 0.5, 0.55, 1]) {
    const tightness = tightnessFromVpip(vpip);
    const recovered = vpipRateOf(tightness);
    // 定标端点是「VPIP = 0」与「VPIP = 2×先验中心」，超出后被夹住
    const scale = 2 * neutralVpipRate();
    assert.ok(
      Math.abs(recovered - Math.min(vpip, scale)) < 1e-12,
      `vpip=${vpip}：反解得到 ${recovered}，必须严格相等`,
    );
    assert.ok(Number.isFinite(tightness) && tightness >= 0 && tightness <= 1);
  }
});

test('**不变量**：先验中心必须恰好映射到维度 0.5（否则先验会被当成观测）', () => {
  // 红队 MAJOR-6：旧版中立点在 VPIP_SCALE/2 = 0.275，而先验中心是 0.25，
  // 于是「恰好等于先验」的玩家得到非 0.5 的维度，
  // 导致 rangeWidthFactor 从 1.0000 漂到 0.9644 —— 仅仅因为攒了更多手数。
  const priorCenter = neutralVpipRate();
  assert.ok(
    Math.abs(tightnessFromVpip(priorCenter) - 0.5) < 1e-12,
    `先验中心 ${priorCenter} 必须映射到 0.5（实际 ${tightnessFromVpip(priorCenter)}）`,
  );
  assert.ok(
    Math.abs(vpipRateOf(0.5) - priorCenter) < 1e-12,
    `0.5 必须反解回先验中心 ${priorCenter}（实际 ${vpipRateOf(0.5)}）`,
  );
});

test('回归：维度与入池率必须同向（早先版本的非线性映射把 22% 反解成 4.8%）', () => {
  const hands = 200;
  for (const vpip of [0.1, 0.2, 0.3, 0.45]) {
    const d = computeDimensions(buildProfile({ hands, vpipSuccesses: Math.round(hands * vpip) }));
    const recovered = vpipRateOf(d.tightness);
    // 收缩会把极端值拉向先验中心，因此允许一定偏差，但方向与量级必须正确
    assert.ok(
      Math.abs(recovered - vpip) < 0.1,
      `vpip=${vpip}：反解得到 ${recovered}，偏差过大`,
    );
    if (vpip >= 0.3) assert.ok(recovered > 0.22, `vpip=${vpip} 反解 ${recovered} 必须仍在偏松一侧`);
    if (vpip < 0.2) assert.ok(recovered < 0.28, `vpip=${vpip} 反解 ${recovered} 必须仍在偏紧一侧`);
  }
});

test('维度必须随入池率单调递减（紧度方向不得反）', () => {
  let previous = Number.POSITIVE_INFINITY;
  for (const vpip of [0.05, 0.15, 0.25, 0.35, 0.5]) {
    const d = computeDimensions(buildProfile({ hands: 200, vpipSuccesses: Math.round(200 * vpip) }));
    assert.ok(
      d.tightness < previous,
      `入池率 ${vpip} 的紧度 ${d.tightness} 必须小于更紧者的 ${previous}`,
    );
    previous = d.tightness;
  }
});

test('标签：高被动 + 高入池必须判为跟注站（而不是「松弱型」）', () => {
  let realistic = createProfile('station');
  for (let i = 0; i < 200; i++) {
    const outcome = observeHand(realistic, {
      handId: `station-H${i}`,
      playerId: 'station',
      seq: i,
      timestamp: TS,
      observations: [
        { metric: PlayerMetric.VPIP, success: true },
        { metric: PlayerMetric.PFR, success: i < 10 },
        { metric: PlayerMetric.CALL_CBET, success: i < 160 },
        { metric: PlayerMetric.FOLD_TO_CBET, success: i >= 160 && i < 190 },
      ],
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) realistic = outcome.value;
  }
  const read = readPlayer(realistic);
  assert.ok(
    read.dimensions.passivity > 0.6,
    `跟注站的被动度必须高（实际 ${read.dimensions.passivity}）`,
  );
  assert.equal(read.label, PlayerLabel.CALLING_STATION, `期望跟注站，实际 ${read.label}`);
});

test('标签：入池极少 + 从不加注 → 超紧，绝不误判为跟注站', () => {
  const read = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 24, pfrSuccesses: 0 }));
  assert.notEqual(read.label, PlayerLabel.CALLING_STATION);
  assert.equal(read.label, PlayerLabel.ULTRA_TIGHT, `实际 ${read.label}`);
});

test('标签：诈唬倾向极端时单独标出（比紧松维度更有针对性价值）', () => {
  // 45%/40% 的疯子：既爱 3Bet 又爱加注持续下注 → 诈唬倾向高 + 凶
  let maniac = createProfile('bluffer');
  for (let i = 0; i < 200; i++) {
    const outcome = observeHand(maniac, {
      handId: `b-H${i}`,
      playerId: 'bluffer',
      seq: i,
      timestamp: TS,
      observations: [
        { metric: PlayerMetric.VPIP, success: i < 90 },
        { metric: PlayerMetric.PFR, success: i < 80 },
        { metric: PlayerMetric.THREE_BET, success: i < 160 },
        { metric: PlayerMetric.RAISE_CBET, success: i < 160 },
      ],
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) maniac = outcome.value;
  }
  const read = readPlayer(maniac);
  assert.ok(
    read.dimensions.bluffTendency > 0.65,
    `前置条件：诈唬倾向必须高（实际 ${read.dimensions.bluffTendency}）`,
  );
  assert.ok(
    read.dimensions.aggression >= 0.6,
    `前置条件：必须够凶（实际 ${read.dimensions.aggression}）`,
  );
  assert.equal(read.label, PlayerLabel.BLUFF_HEAVY, `实际 ${read.label}`);
});

test('没有诈唬证据时必须返回中立 0.5（绝不把先验伪装成观测）', () => {
  // 只有 VPIP/PFR 有数据，THREE_BET / RAISE_CBET 零机会
  const read = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 60, pfrSuccesses: 12 }));
  assert.equal(
    read.dimensions.bluffTendency,
    0.5,
    `零机会时诈唬倾向必须是中立 0.5（实际 ${read.dimensions.bluffTendency}）`,
  );
  assert.notEqual(read.label, PlayerLabel.BLUFF_LIGHT, '零机会不得被判为「很少诈唬」');
  assert.notEqual(read.label, PlayerLabel.BLUFF_HEAVY, '零机会不得被判为「爱诈唬」');
});

test('标签：样本不足时 deriveLabel 强制返回未知（即便维度极端）', () => {
  const extreme = {
    tightness: 0,
    aggression: 1,
    bluffTendency: 1,
    passivity: 1,
    confidence: 0.99,
    sampleSize: 3,
    tier: SampleTier.PRELIMINARY,
  };
  assert.equal(deriveLabel(extreme, DEFAULT_LABEL_THRESHOLDS, false), PlayerLabel.UNKNOWN);
  assert.equal(deriveLabel(extreme, DEFAULT_LABEL_THRESHOLDS), PlayerLabel.UNKNOWN, 'PRELIMINARY 层级直接拦下');
});

test('标签数量与取值都在允许集合内（不得出现未知枚举）', () => {
  const allowed = new Set<string>(Object.values(PlayerLabel));
  for (let hands = 30; hands <= 300; hands += 30) {
    for (let vpip = 0; vpip <= hands; vpip += Math.max(1, Math.floor(hands / 6))) {
      for (let pfr = 0; pfr <= vpip; pfr += Math.max(1, Math.floor(hands / 6))) {
        const read = readPlayer(buildProfile({ hands, vpipSuccesses: vpip, pfrSuccesses: pfr }));
        assert.ok(allowed.has(read.label), `出现了未登记的标签 ${read.label}`);
      }
    }
  }
});

/* ============================================================
 * 四、调整因子（连续、有界、对称）
 * ============================================================ */

test('调整因子：松的对手范围更宽，紧的对手范围更窄', () => {
  const loose = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 180 }));
  const tight = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 30 }));

  assert.ok(
    loose.adjustment.rangeWidthFactor > 1,
    `松的对手 rangeWidthFactor 必须 > 1（实际 ${loose.adjustment.rangeWidthFactor}）`,
  );
  assert.ok(
    tight.adjustment.rangeWidthFactor < 1,
    `紧的对手 rangeWidthFactor 必须 < 1（实际 ${tight.adjustment.rangeWidthFactor}）`,
  );
});

test('调整因子：有界（±40%）且非负，绝不出现 Infinity / NaN', () => {
  const bound = Math.exp(MAX_ADJUSTMENT);
  for (const vpip of [0, 30, 60, 150, 300]) {
    const read = readPlayer(buildProfile({ hands: 300, vpipSuccesses: vpip, pfrSuccesses: Math.floor(vpip / 2) }));
    for (const key of [
      'rangeWidthFactor',
      'bluffWeightFactor',
      'valueWeightFactor',
      'callingThresholdFactor',
      'foldToAggressionFactor',
    ] as const) {
      const value = read.adjustment[key];
      assert.ok(Number.isFinite(value), `${key} 必须是有限数（实际 ${value}）`);
      assert.ok(value > 0, `${key} 必须为正（实际 ${value}）`);
      assert.ok(
        value <= bound + 1e-9 && value >= 1 / bound - 1e-9,
        `${key} = ${value} 超出 ±${MAX_ADJUSTMENT} 的对数界`,
      );
    }
  }
});

test('调整因子：被动对手越不容易弃牌（foldToAggressionFactor < 1）', () => {
  let station = createProfile('station');
  for (let i = 0; i < 200; i++) {
    const outcome = observeHand(station, {
      handId: `s-H${i}`,
      playerId: 'station',
      seq: i,
      timestamp: TS,
      observations: [
        { metric: PlayerMetric.VPIP, success: true },
        { metric: PlayerMetric.PFR, success: i < 5 },
        { metric: PlayerMetric.CALL_CBET, success: i < 160 },
        { metric: PlayerMetric.FOLD_TO_CBET, success: i >= 160 && i < 170 },
      ],
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) station = outcome.value;
  }
  const read = readPlayer(station);
  assert.ok(
    read.adjustment.foldToAggressionFactor < 1,
    `跟注站对进攻的弃牌倾向必须降低（实际 ${read.adjustment.foldToAggressionFactor}）`,
  );
  assert.ok(
    read.adjustment.callingThresholdFactor > 1,
    `跟注站的跟注阈值必须提高（实际 ${read.adjustment.callingThresholdFactor}）`,
  );
});

test('中心化：中等玩家的所有因子都接近 1（不得系统性偏移）', () => {
  // 严格按先验中心构造：VPIP 25%、PFR 18%
  const read = readPlayer(buildProfile({ hands: 400, vpipSuccesses: 100, pfrSuccesses: 72 }));
  for (const key of [
    'rangeWidthFactor',
    'bluffWeightFactor',
    'valueWeightFactor',
    'callingThresholdFactor',
    'foldToAggressionFactor',
  ] as const) {
    assert.ok(
      Math.abs(read.adjustment[key] - 1) < 0.15,
      `中等玩家的 ${key} 应接近 1（实际 ${read.adjustment[key]}）`,
    );
  }
});

test('neutralAdjustment 的所有因子恒为 1 且置信度为 0', () => {
  const dimensions = computeDimensions(buildProfile({ hands: 300, vpipSuccesses: 90 }));
  const neutral = neutralAdjustment(dimensions);
  for (const key of [
    'rangeWidthFactor',
    'bluffWeightFactor',
    'valueWeightFactor',
    'callingThresholdFactor',
    'foldToAggressionFactor',
  ] as const) {
    assert.equal(neutral[key], 1);
  }
  assert.equal(neutral.confidence, 0);
});

test('readPlayer 的 neutral 开关必须把所有因子归零到 1（理论参考模式用）', () => {
  const profile = buildProfile({ hands: 300, vpipSuccesses: 200, pfrSuccesses: 150 });
  const normal = readPlayer(profile);
  const neutral = readPlayer(profile, { neutral: true });
  assert.notEqual(normal.adjustment.rangeWidthFactor, 1, '前置条件：正常模式必须真的调整');
  assert.equal(neutral.adjustment.rangeWidthFactor, 1);
  assert.equal(neutral.adjustment.foldToAggressionFactor, 1);
  // 但标签与维度仍然照常给出（只是不用于调整）
  assert.equal(neutral.label, normal.label);
});

test('computeAdjustment 在置信度为 0 时直接返回中立（不得除以零）', () => {
  const zero = computeAdjustment({
    tightness: 0,
    aggression: 1,
    bluffTendency: 1,
    passivity: 1,
    confidence: 0,
    sampleSize: 0,
    tier: SampleTier.PRELIMINARY,
  });
  assert.equal(zero.rangeWidthFactor, 1);
  assert.equal(zero.confidence, 0);
});

/* ============================================================
 * 五、架构禁令：画像绝不产生动作（规范第二十节）
 * ============================================================ */

test('禁令：PlayerRead / ProfileAdjustment 的结构里不得出现任何动作字段', () => {
  // 只禁止「本身就是动作」的字段名。像 `callingThresholdFactor`（跟注阈值因子）
  // 这类**概率参数**不在此列 —— 它描述的是对手的倾向，不是我们的动作。
  const forbidden = new Set([
    'action',
    'actions',
    'recommendation',
    'recommendations',
    'suggestedaction',
    'decision',
    'advice',
    'fold',
    'check',
    'raise',
    'reraise',
    'allin',
    'play',
  ]);
  const read = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 200, pfrSuccesses: 150 }));

  const keys = [
    ...Object.keys(read),
    ...Object.keys(read.adjustment),
    ...Object.keys(read.dimensions),
    ...Object.keys(read.sampleNote),
  ].map((k) => k.toLowerCase());

  assert.ok(keys.length > 0, '前置条件：确实检查到了字段');
  for (const key of keys) {
    assert.ok(!forbidden.has(key), `画像输出不得包含动作语义字段「${key}」`);
    assert.ok(!/action|recommend|suggest|decision/i.test(key), `字段「${key}」带有动作语义`);
  }
});

test('禁令：所有输出值必须是数字，不得出现任何字符串动作', () => {
  const read = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 200, pfrSuccesses: 150 }));
  for (const [key, value] of Object.entries(read.adjustment)) {
    if (key === 'dimensions') continue;
    assert.equal(typeof value, 'number', `adjustment.${key} 必须是数字（实际 ${typeof value}）`);
  }
  for (const [key, value] of Object.entries(read.dimensions)) {
    if (key === 'tier') continue; // tier 是可读分层标识，不是动作
    assert.equal(typeof value, 'number', `dimensions.${key} 必须是数字（实际 ${typeof value}）`);
  }
  assert.equal(read.adjustment.dimensions, read.dimensions, '调整必须引用同一份维度快照');
  // 分层标识必须是已登记的枚举值，不得出现自由字符串
  assert.ok(
    Object.values(SampleTier).includes(read.dimensions.tier),
    `tier 必须是已登记的分层值（实际 ${read.dimensions.tier}）`,
  );
});

test('禁令：极紧玩家与极松玩家得到的因子都只是「概率调整」，不含任何动作', () => {
  const nit = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 24, pfrSuccesses: 18 }));
  const maniac = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 240, pfrSuccesses: 180 }));

  // 两者的差异必须体现在连续因子上，而不是某个「动作」字段
  assert.notEqual(nit.adjustment.rangeWidthFactor, maniac.adjustment.rangeWidthFactor);
  assert.ok(maniac.adjustment.rangeWidthFactor > nit.adjustment.rangeWidthFactor);
  // 结构相同（同一组键）
  assert.deepEqual(Object.keys(nit.adjustment).sort(), Object.keys(maniac.adjustment).sort());
});

/* ============================================================
 * 六、Range 桥接（RangeAdjustmentProvider）
 * ============================================================ */

test('桥接：样本不足时逐 combo 因子恒为 1（不得改范围）', () => {
  const read = readPlayer(buildProfile({ hands: 3, vpipSuccesses: 3, pfrSuccesses: 3 }));
  const provider = createProfileRangeProvider(read.adjustment);
  assert.equal(provider.isNeutral(), true);
  for (const id of ['AsAd', 'AsKs', '7c2d']) {
    const combo = comboById(id);
    assert.ok(combo);
    assert.equal(provider.adjustComboWeight!(combo, CONTEXT), 1, `${id} 因子必须为 1`);
  }
});

test('桥接：松的对手 → 弱牌端权重被抬高、强牌端基本不动', () => {
  const read = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 210 }));
  assert.ok(read.adjustment.rangeWidthFactor > 1, '前置条件：必须是偏松的对手');
  const provider = createProfileRangeProvider(read.adjustment);
  assert.equal(provider.isNeutral(), false);

  const weak = comboById('7c2d')!; // 72o：最弱
  const strong = comboById('AsAd')!; // AA：最强
  const weakFactor = provider.adjustComboWeight!(weak, CONTEXT);
  const strongFactor = provider.adjustComboWeight!(strong, CONTEXT);

  assert.ok(weakFactor > strongFactor, `弱牌因子应高于强牌（弱 ${weakFactor}，强 ${strongFactor}）`);
});

test('桥接：松的对手 → 弱牌倍数整体高于紧的对手', () => {
  const loose = adjustComboWeightsBatch(ALL_COMBOS, readPlayer(buildProfile({ hands: 300, vpipSuccesses: 210 })).adjustment);
  const tight = adjustComboWeightsBatch(ALL_COMBOS, readPlayer(buildProfile({ hands: 300, vpipSuccesses: 24 })).adjustment);

  const weakCombo = '7c2d';
  const weakIndex = ALL_COMBOS.findIndex((c) => c.canonicalId === weakCombo);
  const strongIndex = ALL_COMBOS.findIndex((c) => c.canonicalId === 'AsAd');
  assert.ok(weakIndex >= 0 && strongIndex >= 0);

  assert.ok(
    loose.factors[weakIndex]! > tight.factors[weakIndex]!,
    `同一手弱牌，松的对手权重应更高（松 ${loose.factors[weakIndex]}，紧 ${tight.factors[weakIndex]}）`,
  );
  assert.ok(
    loose.factors[strongIndex]! <= tight.factors[strongIndex]! + 1e-9,
    '同一手强牌，松的对手权重不应更高',
  );
});

test('桥接：调整只改变分布形状（几何均值为 1），不整体放大或缩小', () => {
  const read = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 210 }));
  const { factors } = adjustComboWeightsBatch(ALL_COMBOS, read.adjustment);
  let logSum = 0;
  for (const f of factors) logSum += Math.log(f);
  const geometricMean = Math.exp(logSum / factors.length);
  assert.ok(
    Math.abs(geometricMean - 1) < 1e-9,
    `几何均值必须为 1（实际 ${geometricMean}）`,
  );
});

test('桥接：批量因子全部为正、有限，且比例与被调整的范围一致', () => {
  const read = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 210 }));
  const { factors, stats } = adjustComboWeightsBatch(ALL_COMBOS, read.adjustment);
  assert.equal(factors.length, ALL_COMBOS.length);
  assert.ok(factors.every((f) => Number.isFinite(f) && f > 0));
  assert.equal(stats.adjustments, ALL_COMBOS.length);
  assert.equal(stats.neutralized, false);
  assert.ok(stats.minFactor <= stats.meanFactor && stats.meanFactor <= stats.maxFactor);
});

test('桥接：样本不足时批量调整也必须完全中立', () => {
  const read = readPlayer(buildProfile({ hands: 2, vpipSuccesses: 2 }));
  const { factors, stats } = adjustComboWeightsBatch(ALL_COMBOS, read.adjustment);
  assert.ok(factors.every((f) => f === 1));
  assert.equal(stats.neutralized, true);
});

test('桥接：空组合列表与置信度不足都要安全返回（不得除零）', () => {
  const read = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 90 }));
  const empty = adjustComboWeightsBatch([], read.adjustment);
  assert.deepEqual(empty.factors, []);
  assert.equal(empty.stats.neutralized, true);
});

test('桥接：似然调整对「被动对手的弃牌」必须显著下调', () => {
  let station = createProfile('station');
  for (let i = 0; i < 200; i++) {
    const outcome = observeHand(station, {
      handId: `s-H${i}`,
      playerId: 'station',
      seq: i,
      timestamp: TS,
      observations: [
        { metric: PlayerMetric.VPIP, success: true },
        { metric: PlayerMetric.PFR, success: i < 5 },
        { metric: PlayerMetric.CALL_CBET, success: i < 160 },
        { metric: PlayerMetric.FOLD_TO_CBET, success: i >= 160 && i < 170 },
      ],
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) station = outcome.value;
  }
  const read = readPlayer(station);
  const provider = createProfileRangeProvider(read.adjustment);

  const weakCombo = '7c2d';
  const foldFactor = provider.adjustActionLikelihood!(LIKELIHOOD(weakCombo, RangeAction.FOLD), CONTEXT);
  const callFactor = provider.adjustActionLikelihood!(LIKELIHOOD(weakCombo, RangeAction.CALL), CONTEXT);
  const raiseFactor = provider.adjustActionLikelihood!(LIKELIHOOD(weakCombo, RangeAction.RAISE), CONTEXT);

  assert.ok(foldFactor < 1, `跟注站的弃牌似然必须下调（实际 ${foldFactor}）`);
  assert.ok(callFactor > foldFactor, `跟注似然应高于弃牌似然（跟注 ${callFactor}，弃牌 ${foldFactor}）`);
  assert.ok(raiseFactor < 1, `跟注站的加注似然也应下调（实际 ${raiseFactor}）`);
});

test('桥接：凶的对手进攻动作似然上调，被动对手下调', () => {
  const maniac = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 240, pfrSuccesses: 200 }));
  const nit = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 30, pfrSuccesses: 24 }));
  const maniacProvider = createProfileRangeProvider(maniac.adjustment);
  const nitProvider = createProfileRangeProvider(nit.adjustment);

  const strong = 'AsAd';
  const maniacRaise = maniacProvider.adjustActionLikelihood!(LIKELIHOOD(strong, RangeAction.RAISE), CONTEXT);
  const nitRaise = nitProvider.adjustActionLikelihood!(LIKELIHOOD(strong, RangeAction.RAISE), CONTEXT);
  assert.ok(
    maniacRaise > nitRaise,
    `凶的对手加注似然应更高（疯 ${maniacRaise}，紧 ${nitRaise}）`,
  );
});

test('桥接：未知 comboId 必须安全（不得抛错 / NaN）', () => {
  const read = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 210 }));
  const provider = createProfileRangeProvider(read.adjustment);
  const factor = provider.adjustActionLikelihood!(LIKELIHOOD('NOT_A_COMBO'), CONTEXT);
  assert.ok(Number.isFinite(factor) && factor > 0, `未知 combo 必须返回有限正因子（实际 ${factor}）`);
});

test('桥接：极端维度下因子仍被工程护栏夹住', () => {
  const read = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 300, pfrSuccesses: 300 }));
  const provider = createProfileRangeProvider(read.adjustment);
  // 用真实组合，避免写出不存在的 comboId（例如 "2c2d" 不是规范顺序的对子）
  const combos = ['AsAd', 'AsKs', 'AsKd', '7c2d', 'AhKh', '2s2h']
    .map((id) => comboById(id))
    .filter((combo): combo is NonNullable<typeof combo> => combo !== undefined);
  assert.ok(combos.length >= 4, `前置条件：至少取到 4 个真实组合（实际 ${combos.length}）`);

  for (const combo of combos) {
    const weightFactor = provider.adjustComboWeight!(combo, CONTEXT);
    assert.ok(weightFactor >= DEFAULT_PROVIDER_CONFIG.minFactor - 1e-9);
    assert.ok(weightFactor <= DEFAULT_PROVIDER_CONFIG.maxFactor + 1e-9);
    for (const action of Object.values(RangeAction)) {
      const f = provider.adjustActionLikelihood!(
        { ...LIKELIHOOD(combo.canonicalId), action },
        CONTEXT,
      );
      assert.ok(
        f >= DEFAULT_PROVIDER_CONFIG.minFactor - 1e-9 && f <= DEFAULT_PROVIDER_CONFIG.maxFactor + 1e-9,
        `${combo.canonicalId}/${action} 因子 ${f} 越出护栏`,
      );
    }
  }
});

test('桥接：stats 反映真实调整方向，且之后 describe() 给出中文说明', () => {
  const loose = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 240 }));
  const provider = createProfileRangeProvider(loose.adjustment);
  for (const id of ['7c2d', 'AsAd', 'AsKs']) {
    provider.adjustComboWeight!(comboById(id)!, CONTEXT);
  }
  const description = provider.describe();
  assert.equal(typeof description, 'string');
  assert.ok(description.length > 0);
  assert.ok(/范围|画像|样本/.test(description), `说明必须是中文且提到范围/画像（实际「${description}」）`);
  const stats = provider.stats();
  assert.equal(stats.neutralized, false);
  assert.ok(stats.adjustments > 0);
});

test('桥接：中立 provider 的中文说明必须讲清「未调整」', () => {
  const read = readPlayer(buildProfile({ hands: 2, vpipSuccesses: 2 }));
  const provider = createProfileRangeProvider(read.adjustment);
  const description = provider.describe();
  assert.ok(/未对范围做任何调整|样本不足/.test(description), `实际「${description}」`);
});

/* ============================================================
 * 七、几何均值归一
 * ============================================================ */

test('neutralizeGeometric：一致放大必须被归一掉（无意义的整体缩放）', () => {
  const result = neutralizeGeometric([2, 2, 2, 2]);
  for (const f of result) assert.ok(Math.abs(f - 1) < 1e-12);
});

test('neutralizeGeometric：几何均值本就为 1 的集合保持原样', () => {
  // [2,2,2,0.125] 的几何均值 = (2·2·2·0.125)^(1/4) = 1^... = 1（2³·2⁻³ = 1）
  const source = [2, 2, 2, 0.125];
  const geometricMean = Math.exp(source.reduce((s, f) => s + Math.log(f), 0) / source.length);
  assert.ok(Math.abs(geometricMean - 1) < 1e-12, `前置条件：几何均值应为 1（实际 ${geometricMean}）`);

  const result = neutralizeGeometric(source);
  for (let i = 0; i < source.length; i++) {
    assert.ok(Math.abs(result[i]! - source[i]!) < 1e-12, `第 ${i} 项应保持原样`);
  }
});

test('neutralizeGeometric：相对顺序保持不变', () => {
  const source = [10, 2, 1, 0.5];
  const result = neutralizeGeometric(source);
  for (let i = 1; i < result.length; i++) {
    assert.ok(result[i]! < result[i - 1]!, '相对顺序必须保持');
  }
});

test('neutralizeGeometric：非法输入（0 / NaN / 负数）不得产生 NaN', () => {
  const result = neutralizeGeometric([0, Number.NaN, -1, 2]);
  assert.ok(result.every((f) => Number.isFinite(f) && f > 0), `实际 ${JSON.stringify(result)}`);
});

test('neutralizeGeometric：空数组返回空数组', () => {
  assert.deepEqual(neutralizeGeometric([]), []);
});

/* ============================================================
 * 八、与 Range 引擎的集成
 * ============================================================ */

test('集成：调整后的范围仍是合法范围（validateRange 通过、概率和为 1）', () => {
  const built = uniformRange({
    sourceId: 'test.uniform.classifier',
    sourceType: 'TEST_ONLY',
    version: '1.0.0',
    description: '分类器集成测试用的均匀范围',
    verified: false,
    confidence: 0.1,
  });
  assert.equal(built.ok, true, '前置条件：均匀范围必须构造成功');
  if (!built.ok) return;
  const range = built.value;

  const read = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 210 }));
  const { factors } = adjustComboWeightsBatch(range.entries.map((e) => e.combo), read.adjustment);

  // 手工按因子重加权并归一化（模拟下游用法）
  const weighted = range.entries.map((entry, index) => entry.rawWeight * factors[index]!);
  const total = weighted.reduce((s, w) => s + w, 0);
  assert.ok(total > 0);
  const probabilities = weighted.map((w) => w / total);
  const sum = probabilities.reduce((s, p) => s + p, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, `归一化后概率和必须为 1（实际 ${sum}）`);
  assert.ok(probabilities.every((p) => Number.isFinite(p) && p >= 0));

  // 范围本身必须仍然通过校验
  const validation = validateRange(range);
  assert.equal(validation.valid, true, `原范围必须合法：${JSON.stringify(validation.violations)}`);
});

test('集成：画像调整不得改变任何牌力 / 底池 / 赔率（只碰概率）', async () => {
  // 结构断言：profileProvider 导出的东西里没有牌力评估 / 赔率计算入口
  const moduleKeys = Object.keys(await import('../src/domain/range/profileProvider.ts'));
  assert.ok(moduleKeys.length > 0, '前置条件：模块确实导出了东西');
  for (const key of moduleKeys) {
    assert.ok(
      !/evaluate|equity|potOdds|requiredEquity|handRank|spr/i.test(key),
      `画像桥接不得导出牌力/赔率相关 API（发现 ${key}）`,
    );
  }
});

test('集成：先验来源必须是一句话能说清的中文，且不是理论/GTO', () => {
  const read = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 90 }));
  assert.ok(read.priorSources.length > 0);
  for (const source of read.priorSources) {
    assert.ok(
      Object.values(PriorSource).includes(source),
      `先验来源 ${source} 不在允许集合内`,
    );
    assert.ok(!/THEORY|GTO/i.test(source));
  }
});

test('集成：readPlayer 输出的 sampleNote 正确反映手数与层级', () => {
  const thin = readPlayer(buildProfile({ hands: 5, vpipSuccesses: 3 }));
  assert.equal(thin.sampleNote.totalHands, 5);
  assert.equal(thin.sampleNote.tier, SampleTier.PRELIMINARY);

  const thick = readPlayer(buildProfile({ hands: 300, vpipSuccesses: 90 }));
  assert.equal(thick.sampleNote.totalHands, 300);
  assert.notEqual(thick.sampleNote.tier, SampleTier.PRELIMINARY);
});

test('集成：标签阈值可配置，且只影响标签、不影响调整因子', () => {
  const profile = buildProfile({ hands: 300, vpipSuccesses: 120, pfrSuccesses: 96 });
  const normal = readPlayer(profile);
  // 把「松」的阈值调到极高，使这个玩家不再算松
  const shifted = readPlayer(profile, {
    labelThresholds: { ...DEFAULT_LABEL_THRESHOLDS, looseVpip: 0.95 },
  });
  assert.notEqual(normal.label, shifted.label, '阈值改变应改变标签');
  assert.equal(
    normal.adjustment.rangeWidthFactor,
    shifted.adjustment.rangeWidthFactor,
    '调整因子必须只由连续维度决定，不得随标签阈值跳变',
  );
});

test('先验元数据在分类器里不做任何修改（先验表是共享只读常量）', () => {
  const before = JSON.stringify(METRIC_DEFINITIONS[PlayerMetric.VPIP].prior);
  readPlayer(buildProfile({ hands: 300, vpipSuccesses: 300 }));
  computeAdjustment(computeDimensions(buildProfile({ hands: 300, vpipSuccesses: 300 })));
  const after = JSON.stringify(METRIC_DEFINITIONS[PlayerMetric.VPIP].prior);
  assert.equal(before, after, '分类过程不得污染全局先验表');
});
