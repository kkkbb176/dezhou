/**
 * Reviewer 5 · 反证探针 A —— 结构槽位 / 重复计票 / 几何平均 vs 乘积 vs max
 *
 * 参考手（与 `test/profileQuantificationGolden.test.ts` §十七 黄金手逐字一致）：
 *   9-max · Hero CO `Ac Jh`（等等：Hero 是 CO，底牌 A♣J♥）· 牌面 `Ad 8s 4s 2c Kd` · 河牌
 *   翻前 CO 开 2.5 / BB 跟 1.5（+SB 0.5 ⇒ 池 5.5）
 *   翻牌 BB check / CO bet 2 / BB call（池 9.5）
 *   转牌 BB check / CO check-back
 *   河牌 BB bet 7（⇒ betRatio = 7 / 9.5 = 0.7368… ⇒ LARGE 档）
 *   ⇒ 节点：RIVER / CO vs BB / SRP / 2 人 / previousStreetLine = TURN_CHECK_BACK /
 *      currentAction = BET / sizeBucket = LARGE / boardTexture = SEMI_WET
 *
 * 运行：node --experimental-strip-types scripts/v21-rev5-slots.ts
 */
import {
  ENVIRONMENT_BEHAVIOR_PRIOR,
  behaviorProfileOf,
  estimateUnifiedActionLikelihood,
  type BehaviorNodeContext,
  type RiverComboClass,
} from '../src/domain/player/behaviorProfile.ts';
import { likelihoodWeights, tierWeightOf } from '../src/app/manualInput/likelihoodModel.ts';

const node: BehaviorNodeContext = {
  street: 'RIVER',
  heroPosition: 'CO',
  villainPosition: 'BB',
  potType: 'SRP',
  playerCount: 2,
  previousStreetLine: 'TURN_CHECK_BACK',
  currentAction: 'BET',
  sizeBucket: 'LARGE',
  boardTexture: 'SEMI_WET',
};

const BET_RATIO = 7 / 9.5; // = 0.7368421052631579

const FOCUS: readonly (readonly [RiverComboClass, number])[] = [
  ['NUT_VALUE', 0],
  ['THIN_VALUE', 2],
  ['MISSED_FLUSH_DRAW', 5],
  ['PURE_AIR', 5],
];

const neutral = behaviorProfileOf({ playerId: 'neutral', archetype: null });
const cs = behaviorProfileOf({ playerId: 'BB', archetype: 'CALLING_STATION' });
const maniac = behaviorProfileOf({ playerId: 'BB', archetype: 'MANIAC' });

console.log(`参考手节点: street=${node.street} ${node.heroPosition} vs ${node.villainPosition} ` +
  `${node.potType} ${node.playerCount}人 line=${node.previousStreetLine} action=${node.currentAction} ` +
  `size=${node.sizeBucket} texture=${node.boardTexture}`);
console.log(`betRatio = 7 / 9.5 = ${BET_RATIO}  ⇒ BetSizeBucketOf = ` +
  `${BET_RATIO >= 1.25 ? 'OVERBET' : BET_RATIO >= 0.6 ? 'LARGE' : BET_RATIO >= 0.4 ? 'MEDIUM' : 'SMALL'}`);

/* ============================================================
 * 1. 逐类别 trace：到底施加了哪些条目、几条、槽位几条
 * ============================================================ */
console.log('\n========== 1. 逐类别 trace（MANIAC 画像，让每条 cond ≠ 1 才看得见）==========');
console.log('类别                    条目数 槽位K  几何平均     原始乘积      max      K推断  clamped');
for (const [cls, bucket] of FOCUS) {
  const u = estimateUnifiedActionLikelihood({
    semanticClass: cls,
    strengthBucket: bucket,
    betRatio: BET_RATIO,
    node,
    profile: maniac,
    action: 'BET',
    withTrace: true,
  });
  const product = u.sizeAdjustment * u.nodeAdjustment * u.profileAdjustment;
  const factors: number[] = [];
  for (const c of u.contributions) factors.push(c.multiplier);
  // 尺寸 / 节点因子从 trace 里取（contributions 只记类别段）
  for (const t of u.trace) {
    if (t.stage === 'SIZE' || t.stage === 'NODE') factors.push(t.factor);
  }
  const maxFactor = factors.length === 0 ? 1 : Math.max(...factors);
  const kInferred = u.combinedAdjustment === 1 ? 1 : Math.log(product) / Math.log(u.combinedAdjustment);
  console.log(
    `${cls.padEnd(22)} ${String(u.appliedTraitCount).padEnd(5)} ${String(kInferred.toFixed(6)).padEnd(7)} ` +
      `${u.combinedAdjustment.toFixed(6)}     ${product.toFixed(6)}   ${maxFactor.toFixed(6)}  ` +
      `${u.combinedAdjustment === product ? '1' : (Math.pow(u.combinedAdjustment, kInferred) === product ? `K=${kInferred}` : '—')}  ` +
      `${u.clamped ? '**YES**' : 'no'}`,
  );
  console.log(`   base=${u.baseLikelihood.toFixed(8)} raw=${u.rawLikelihood.toFixed(8)} like=${u.likelihood.toFixed(8)}`);
  for (const t of u.trace) {
    console.log(
      `   [${t.stage}] trait=${t.trait ?? '-'} factor=${t.factor.toFixed(6)}` +
        (t.rate === undefined ? '' : ` rate=${t.rate}`),
    );
  }
}

/* ============================================================
 * 2. 同一条倾向被数了几次？几何平均 / 乘积 / max 三者对比
 * ============================================================ */
console.log('\n========== 2. 「爱开火」这条倾向：几何平均 vs 乘积 vs max ==========');
const COMBOS: readonly { label: string; cls: RiverComboClass; bucket: number }[] = [
  { label: '(a) MISSED_FLUSH_DRAW', cls: 'MISSED_FLUSH_DRAW', bucket: 5 },
  { label: '(b) PURE_AIR', cls: 'PURE_AIR', bucket: 5 },
  { label: '(c) THIN_VALUE', cls: 'THIN_VALUE', bucket: 2 },
  { label: '(d) NUT_VALUE', cls: 'NUT_VALUE', bucket: 0 },
];
console.log('类别                   画像     条目   base       乘积       几何平均     max      最终(几何)  最终(乘积)  最终(max)');
for (const c of COMBOS) {
  for (const [tag, prof] of [['03A-CS', cs], ['03B-MANIAC', maniac]] as const) {
    const u = estimateUnifiedActionLikelihood({
      semanticClass: c.cls,
      strengthBucket: c.bucket,
      betRatio: BET_RATIO,
      node,
      profile: prof,
      action: 'BET',
      withTrace: true,
    });
    const product = u.sizeAdjustment * u.nodeAdjustment * u.profileAdjustment;
    const factors: number[] = [];
    for (const t of u.trace) if (t.stage === 'SIZE' || t.stage === 'NODE') factors.push(t.factor);
    for (const cc of u.contributions) factors.push(cc.multiplier);
    const maxFactor = factors.length === 0 ? 1 : Math.max(...factors);
    const slotK = u.combinedAdjustment === 1 ? 1 : Math.round(Math.log(product) / Math.log(u.combinedAdjustment));
    const asProduct = Math.min(1, u.baseLikelihood * product);
    const asMax = Math.min(1, u.baseLikelihood * maxFactor);
    console.log(
      `${c.label.padEnd(22)} ${tag.padEnd(10)} ${String(u.appliedTraitCount).padEnd(4)} ` +
        `${u.baseLikelihood.toFixed(6)}  ${product.toFixed(6)}  ${u.combinedAdjustment.toFixed(6)}  ` +
        `${maxFactor.toFixed(6)}  ${u.likelihood.toFixed(6)}    ${asProduct.toFixed(6)}    ${asMax.toFixed(6)}` +
        `  (K=${slotK})`,
    );
  }
}

/* ============================================================
 * 3. 三个条目的池先验与 03A/03B 生效值（证明它们同源）
 * ============================================================ */
console.log('\n========== 3. 三个「开火」条目的池先验 / 03A / 03B 生效值与几率比 ==========');
const actives = ['riverBluff', 'riverLargeBetBluff', 'missedDrawBluff', 'probeAfterTurnCheckBack', 'thinValueBet'] as const;
console.log('trait                       池先验   03A(CS)   03B(MANIAC)  cond03A     cond03B');
for (const k of actives) {
  const env = ENVIRONMENT_BEHAVIOR_PRIOR[k];
  const a = cs.traits[k].effectiveRate;
  const b = maniac.traits[k].effectiveRate;
  const odds = (r: number) => r / (1 - r);
  const ca = odds(Math.max(0.001, Math.min(0.999, a))) / odds(env);
  const cb = odds(Math.max(0.001, Math.min(0.999, b))) / odds(env);
  console.log(
    `${k.padEnd(28)} ${String(env).padEnd(8)} ${String(a).padEnd(9)} ${String(b).padEnd(11)} ` +
      `${ca.toFixed(6)}  ${cb.toFixed(6)}`,
  );
}
console.log('  callTooWide（被动条目，不参与主动似然）= ' +
  `池 ${ENVIRONMENT_BEHAVIOR_PRIOR.callTooWide} / 03A ${cs.traits.callTooWide.effectiveRate} / 03B ${maniac.traits.callTooWide.effectiveRate}`);

/* ============================================================
 * 4. 「单条目但 2 个槽位」是否把唯一因子开了平方根（结构性衰减）
 * ============================================================ */
console.log('\n========== 4. THIN_VALUE：唯一可条件化条目被开几次方 ==========');
const thinBase = tierWeightOf(likelihoodWeights('AGGRESSIVE', BET_RATIO), 2);
console.log(`THIN_VALUE base（中性校准层） = ${thinBase.toFixed(8)}`);
for (const tendency of ['VERY_LOW', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'] as const) {
  const p = behaviorProfileOf({ playerId: 'BB', archetype: null, manual: { thinValueBet: tendency } });
  const rate = p.traits.thinValueBet.effectiveRate;
  const odds = (r: number) => r / (1 - r);
  const cond = odds(Math.max(0.001, Math.min(0.999, rate))) / odds(ENVIRONMENT_BEHAVIOR_PRIOR.thinValueBet);
  const u = estimateUnifiedActionLikelihood({
    semanticClass: 'THIN_VALUE', strengthBucket: 2, betRatio: BET_RATIO, node,
    profile: p, action: 'BET', withTrace: true,
  });
  const impliedExponent = u.combinedAdjustment === 1 ? 0 : Math.log(u.combinedAdjustment) / Math.log(cond);
  console.log(
    `  manual=thinValueBet:${tendency.padEnd(9)} rate=${String(rate).padEnd(6)} cond=${cond.toFixed(6)} ` +
      `⇒ 实测倍率 ${u.combinedAdjustment.toFixed(6)}  隐含指数 1/${(1 / impliedExponent).toFixed(4)}  ` +
      `条目数=${u.appliedTraitCount}  like=${u.likelihood.toFixed(6)}`,
  );
}

/* ============================================================
 * 5. 极端 manual thinValueBet 是否把 THIN_VALUE 抬到 STRONG_VALUE 之上
 * ============================================================ */
console.log('\n========== 5. 极端 manual thinValueBet ⇒ THIN_VALUE 是否越过 STRONG_VALUE ==========');
const strictBase = tierWeightOf(likelihoodWeights('AGGRESSIVE', BET_RATIO), 1);
console.log(`STRONG_VALUE base = ${strictBase.toFixed(8)}（结构性基线 THIN < STRONG 见 behaviorProfile.ts:979）`);
const extreme = behaviorProfileOf({ playerId: 'BB', archetype: null, manual: { thinValueBet: 'VERY_HIGH' } });
const thinHi = estimateUnifiedActionLikelihood({
  semanticClass: 'THIN_VALUE', strengthBucket: 2, betRatio: BET_RATIO, node,
  profile: extreme, action: 'BET', withTrace: true,
});
console.log(`  STRONG_VALUE（无画像调整，价值端恒 1.000） = ${strictBase.toFixed(8)}`);
console.log(`  THIN_VALUE  （manual VERY_HIGH）           = ${thinHi.likelihood.toFixed(8)}`);
console.log(`  ⇒ THIN > STRONG ? ${thinHi.likelihood > strictBase ? '**是（序关系被翻转）**' : '否'}`);
