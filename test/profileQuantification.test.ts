/**
 * PLAYER PROFILE QUANTIFICATION V1 回归测试（§三十三–§三十八 + §二十）
 *
 * 只测**结构性质与单调性**：不写死「03A 必须 FOLD / 03B 必须 CALL」（§二十）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BehaviorTraitKey,
  BetSizeBucketOf,
  ENVIRONMENT_BEHAVIOR_PRIOR,
  ProfileMateriality,
  behaviorProfileOf,
  estimateUnifiedActionLikelihood,
  manualReadEvidence,
  profileMaterialityOf,
  reweightCombos,
  statEvidenceOf,
  StatSource,
  type BehaviorNodeContext,
  type RiverComboClass,
} from '../src/domain/player/behaviorProfile.ts';

const riverNode = (sizeBucket: 'SMALL' | 'LARGE' = 'LARGE', line: 'TURN_CHECK_BACK' | 'TURN_BET_CALL' = 'TURN_CHECK_BACK'): BehaviorNodeContext => ({
  street: 'RIVER',
  heroPosition: 'CO',
  villainPosition: 'BB',
  potType: 'SRP',
  playerCount: 2,
  previousStreetLine: line,
  currentAction: 'BET',
  sizeBucket,
  boardTexture: 'SEMI_WET',
});

const passive = () => behaviorProfileOf({ playerId: 'BB', archetype: 'CALLING_STATION' });
const overbluffer = () => behaviorProfileOf({ playerId: 'BB', archetype: 'MANIAC' });

/* §三十三：小样本收缩 —— 2/2 不得胜过 60/100 */
test('§33 小样本收缩：2/2 的 effectiveRate 必须低于 60/100', () => {
  const small = statEvidenceOf({ successes: 2, opportunities: 2, priorRate: 0.25, priorWeight: 6, source: StatSource.OBSERVED_HAND_HISTORY });
  const large = statEvidenceOf({ successes: 60, opportunities: 100, priorRate: 0.25, priorWeight: 6, source: StatSource.OBSERVED_HAND_HISTORY });
  assert.ok(small.observedRate === 1, '2/2 的实测比率确实是 100%');
  assert.ok(
    small.effectiveRate < large.effectiveRate,
    `样本 2 的生效值必须低于样本 100：${small.effectiveRate} vs ${large.effectiveRate}`,
  );
  assert.ok(small.effectiveRate < 0.5, `2/2 必须被明显收缩（先验 0.25），实际 ${small.effectiveRate}`);
  assert.ok(large.effectiveRate > 0.55, `100 次机会必须逐渐由个人数据主导，实际 ${large.effectiveRate}`);
  // 单调性：成功数增加 ⇒ 生效值上升
  const more = statEvidenceOf({ successes: 3, opportunities: 4, priorRate: 0.25, priorWeight: 6, source: StatSource.OBSERVED_HAND_HISTORY });
  assert.ok(more.effectiveRate > small.effectiveRate, '成功数增加必须单调提高生效值');
});

/* §三十四：大样本覆盖先验 */
test('§34 大样本覆盖先验：机会数 ≫ 先验权重时趋于实测', () => {
  const ev = statEvidenceOf({ successes: 90, opportunities: 100, priorRate: 0.2, priorWeight: 6, source: StatSource.OBSERVED_HAND_HISTORY });
  assert.ok(Math.abs(ev.effectiveRate - 0.9) < 0.06, `生效值必须靠拢实测 0.90，实际 ${ev.effectiveRate}`);
  assert.ok(ev.confidence > 0.9, `置信度必须随之上升，实际 ${ev.confidence}`);
});

/* §三十：未知结果不得当成失败 */
test('§30 未知结果必须单独记录，不计入分母', () => {
  const ev = statEvidenceOf({
    successes: 4,
    opportunities: 10,
    priorRate: 0.3,
    priorWeight: 6,
    source: StatSource.OBSERVED_HAND_HISTORY,
    unknownOutcomeOpportunities: 7,
  });
  assert.equal(ev.unknownOutcomeOpportunities, 7);
  assert.ok(ev.noteZh.includes('未知结果 7 次'), '说明里必须写明未知结果次数');
  assert.ok(ev.observedRate === 0.4, '分母只能是 10（不能把 7 次未知当成失败）');
});

/* §三十五：主动 / 被动隔离 */
test('§35 主动被动隔离：跟注站只提高 callTooWide，不自动提高薄价值/诈唬', () => {
  const cs = passive();
  assert.ok(cs.traits.callTooWide.effectiveRate > 0.6, '跟注站的被动条目必须高');
  /*
   * 🔴 **V2 修正：改与「池先验」比较，而不是与字面量 0.35 比较。**
   *
   * 旧断言是 `thinValueBet.effectiveRate < 0.35`。它**一直是靠浮点巧合通过的**：
   * `statEvidenceOf` 在零机会时算的是 `(priorRate × priorWeight) / priorWeight`，
   * 而 `(0.35 × 6) / 6 = 0.3499999999999999` —— 恰好比 0.35 低 1 ULP，
   * 于是严格小于成立。V2 把零机会改成**逐位返回先验**（NEUTRAL_PARITY 的前提）
   * 之后它变成精确的 `0.35`，`0.35 < 0.35` 立刻为假。
   *
   * 断言的真实契约不是「小于某个魔数」，而是：
   * **被动原型不得把薄价值倾向抬到池先验之上**（V1 的 D4 已从所有原型先验里
   * 移除 `thinValueBet` 声明 ⇒ 它必须**恰好等于**池先验）。
   * 因此改为与池先验比较；这**不是放宽**，而是把依赖浮点尾差的条件换成真实的语义条件。
   */
  assert.ok(
    cs.traits.thinValueBet.effectiveRate <= ENVIRONMENT_BEHAVIOR_PRIOR.thinValueBet,
    `被动原型不得抬高薄价值倾向（须 ≤ 池先验 ${ENVIRONMENT_BEHAVIOR_PRIOR.thinValueBet}）：` +
      `实际 ${cs.traits.thinValueBet.effectiveRate}`,
  );
  assert.ok(
    cs.traits.missedDrawBluff.effectiveRate < ENVIRONMENT_BEHAVIOR_PRIOR.missedDrawBluff,
    '被动原型必须**压低**诈唬倾向（低于池先验）',
  );
  const maniac = overbluffer();
  assert.ok(maniac.traits.missedDrawBluff.effectiveRate > cs.traits.missedDrawBluff.effectiveRate);
});

/* §三十六：节点隔离 —— flop 进攻不得污染 river 诈唬 */
test('§36 节点隔离：标签只经「各条目自己的先验」进入，条目之间不互相推导', () => {
  const cs = passive();
  // 只改 riverBluff 的实测，不得改变 missedDrawBluff
  const withHistory = behaviorProfileOf({
    playerId: 'BB',
    archetype: 'CALLING_STATION',
    observed: { riverBluff: { successes: 18, opportunities: 20 } },
  });
  assert.ok(withHistory.traits.riverBluff.effectiveRate > cs.traits.riverBluff.effectiveRate);
  assert.equal(
    withHistory.traits.missedDrawBluff.effectiveRate,
    cs.traits.missedDrawBluff.effectiveRate,
    '一个条目的实测不得改变另一个条目（无跨条目推导）',
  );
});

/* §三十七：尺寸隔离 */
test('§37 尺寸隔离：同一玩家在 SMALL 与 LARGE 上的错过听牌下注似然必须不同', () => {
  const p = passive();
  // 错过听牌 = 诈唬候选 ⇒ 既有档位是 5（最弱档）；`betRatio` 反映实际下注尺寸
  const small = estimateUnifiedActionLikelihood({
    semanticClass: 'MISSED_FLUSH_DRAW',
    strengthBucket: 5,
    betRatio: 0.25,
    node: riverNode('SMALL'),
    profile: p,
    action: 'BET',
  });
  const large = estimateUnifiedActionLikelihood({
    semanticClass: 'MISSED_FLUSH_DRAW',
    strengthBucket: 5,
    betRatio: 0.75,
    node: riverNode('LARGE'),
    profile: p,
    action: 'BET',
  });
  assert.notEqual(small.likelihood, large.likelihood, '尺寸必须进入模型（被动玩家大注诈唬更低）');
  assert.ok(large.likelihood < small.likelihood, `被动玩家的大注诈唬必须更低：${large.likelihood} vs ${small.likelihood}`);
  assert.equal(BetSizeBucketOf(0.75), 'LARGE');
  assert.equal(BetSizeBucketOf(0.25), 'SMALL');
});

/* §三十八：line-specific */
test('§38 line-specific：turn check-back 后开火与「跟注后 donk」必须不同', () => {
  const node = riverNode('LARGE', 'TURN_CHECK_BACK');
  const other = riverNode('LARGE', 'TURN_BET_CALL');
  const a = estimateUnifiedActionLikelihood({
    semanticClass: 'MISSED_FLUSH_DRAW',
    strengthBucket: 5,
    betRatio: 0.75,
    node,
    profile: overbluffer(),
    action: 'BET',
    // 审计路径：trace 默认关闭（热路径不付它的分配成本），本断言要看 trace 故显式打开
    withTrace: true,
  });
  const b = estimateUnifiedActionLikelihood({
    semanticClass: 'MISSED_FLUSH_DRAW',
    strengthBucket: 5,
    betRatio: 0.75,
    node: other,
    profile: overbluffer(),
    action: 'BET',
    withTrace: true,
  });
  assert.ok(
    a.likelihood > b.likelihood,
    `松凶玩家在我 check-back 后的开火似然必须更高：${a.likelihood.toFixed(6)} vs ${b.likelihood.toFixed(6)}`,
  );
  assert.ok(
    // V2：**节点**条目记录在 `trace`（`contributions` 只记**类别**条目）
    a.trace.some((x) => x.trait === BehaviorTraitKey.PROBE_AFTER_TURN_CHECK_BACK),
    '必须记录「我过牌后他开火」这一条参与运算',
  );
});

/* §二十一 + §二十：03A/03B 单调性与物性（**不写死动作**） */
test('§20/§21 03A vs 03B：范围组成、权益与 EV 的单调性 + Materiality', () => {
  // `strengthBucket` = **既有档位**（0 最强 … 5 最弱），与 `riverComboClassOf` 同源
  const combos: {
    combo: string;
    priorWeight: number;
    comboClass: RiverComboClass;
    strengthBucket: number;
  }[] = [
    { combo: 'A8s', priorWeight: 0.01, comboClass: 'STRONG_VALUE', strengthBucket: 1 },
    { combo: 'A4s', priorWeight: 0.01, comboClass: 'STRONG_VALUE', strengthBucket: 1 },
    // ⚠️ 原为 `'MEDIUM_VALUE'`（V2 起该枚举成员已删除 —— 生产永不可达）
    { combo: 'K8s', priorWeight: 0.01, comboClass: 'STRONG_VALUE', strengthBucket: 1 },
    { combo: 'Ax', priorWeight: 0.03, comboClass: 'THIN_VALUE', strengthBucket: 2 },
    { combo: '8x', priorWeight: 0.03, comboClass: 'SHOWDOWN_VALUE', strengthBucket: 3 },
    { combo: 'QhJh', priorWeight: 0.02, comboClass: 'PURE_AIR', strengthBucket: 5 },
    { combo: '5s6s', priorWeight: 0.02, comboClass: 'MISSED_FLUSH_DRAW', strengthBucket: 5 },
    { combo: 'Th9h', priorWeight: 0.02, comboClass: 'MISSED_STRAIGHT_DRAW', strengthBucket: 5 },
  ];
  const node = riverNode('LARGE', 'TURN_CHECK_BACK');
  const a = reweightCombos({ combos, node, profile: passive() });
  const b = reweightCombos({ combos, node, profile: overbluffer() });
  const classMass = (r: typeof a, cls: RiverComboClass) =>
    r.combos.reduce(
      (acc, x, i) => acc + (combos[i]!.comboClass === cls ? x.posteriorWeight : 0),
      0,
    );
  const bluffMass = (r: typeof a) =>
    classMass(r, 'MISSED_FLUSH_DRAW') + classMass(r, 'MISSED_STRAIGHT_DRAW') + classMass(r, 'PURE_AIR');

  // §20 必须成立的四条单调性
  assert.ok(bluffMass(b) > bluffMass(a), `03B 的诈唬质量必须高于 03A：${bluffMass(b)} vs ${bluffMass(a)}`);
  assert.ok(
    classMass(b, 'MISSED_FLUSH_DRAW') > classMass(a, 'MISSED_FLUSH_DRAW'),
    '?错听牌转诈唬质量必须更高',
  );
  const rangeDistance = a.combos.reduce(
    (acc, x, i) => acc + Math.abs(x.posteriorWeight - b.combos[i]!.posteriorWeight) / 2,
    0,
  );
  assert.ok(rangeDistance > 0.02, `两个极端画像的范围分布必须有实质距离，实际 ${rangeDistance}`);

  // 物性检测（实验性阈值）
  const materiality = profileMaterialityOf({
    equityA: 0.563,
    equityB: 0.64,
    bluffMassA: bluffMass(a),
    bluffMassB: bluffMass(b),
    evA: 12.47,
    evB: 18.2,
    rangeDistance,
  });
  assert.notEqual(materiality.verdict, ProfileMateriality.NO_EFFECT);
  assert.ok(materiality.bluffMassDelta > 0);
  assert.ok(materiality.noteZh.includes('画像物性'));
});

/* §二十七/§二十八：人工画像不得冒充实测 */
test('§27/§28 人工画像必须标 MANUAL_USER_INPUT，且置信度受上限约束', () => {
  const manual = manualReadEvidence({ tendency: 'HIGH', environmentPrior: 0.3 });
  assert.equal(manual.source, StatSource.MANUAL_USER_INPUT);
  assert.equal(manual.opportunities, 0, '人工画像没有实测机会数');
  assert.ok(manual.noteZh.includes('人工画像'), '必须明确来源是人工判断');
  const profile = behaviorProfileOf({
    playerId: 'BB',
    archetype: null,
    manual: { missedDrawBluff: 'HIGH' },
  });
  assert.equal(profile.traits.missedDrawBluff.source, StatSource.MANUAL_USER_INPUT);
  assert.ok(
    profile.traits.riverBluff.source === StatSource.ENVIRONMENT_PRIOR,
    '没给人工判断的条目必须回落到池先验（不是 0.5 拍脑袋）',
  );
  assert.ok(profile.isUnknownPlayer, '没有标签 ⇒ 必须标成未知玩家');
});
