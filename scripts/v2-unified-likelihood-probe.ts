/**
 * V2 统一动作似然 —— 测量探针
 *
 * 1. **NEUTRAL_PARITY 网格**（父代理/规范要求）：
 *    River 25% / 75% / 125% × value / showdown / missed-draw / pure-air
 *    （并把 8 个类别全跑）—— 中性画像的 unified 结果必须与**既有档位权重**
 *    逐位相等。
 * 2. **03A / 03B 的 `钳位前` 值**（父代理硬门槛 ②）：逐类别给出
 *    base / 几何平均调整 / **rawLikelihood** / likelihood / clamped，
 *    使饱和可见而不是被静默吸收。
 * 3. §三十八 方向：TURN_CHECK_BACK vs TURN_BET_CALL。
 *
 * 用法：node --experimental-strip-types scripts/v2-unified-likelihood-probe.ts
 */
import {
  ENVIRONMENT_BEHAVIOR_PRIOR,
  behaviorProfileOf,
  estimateUnifiedActionLikelihood,
  type BehaviorNodeContext,
  type RiverComboClass,
} from '../src/domain/player/behaviorProfile.ts';
import { likelihoodWeights, tierWeightOf } from '../src/app/manualInput/likelihoodModel.ts';

const neutral = behaviorProfileOf({ playerId: 'neutral', archetype: null });
const cs = behaviorProfileOf({ playerId: 'bb', archetype: 'CALLING_STATION' });
const maniac = behaviorProfileOf({ playerId: 'bb', archetype: 'MANIAC' });

/** 生产里 `riverComboClassOf` 给出的类别 → 既有档位（代表值） */
const CLASS_BUCKET: readonly (readonly [RiverComboClass, number])[] = [
  ['NUT_VALUE', 0],
  ['STRONG_VALUE', 1],
  ['THIN_VALUE', 2],
  ['SHOWDOWN_VALUE', 3],
  ['MISSED_FLUSH_DRAW', 5],
  ['MISSED_STRAIGHT_DRAW', 5],
  ['MISSED_COMBO_DRAW', 5],
  ['PURE_AIR', 5],
];

const node = (line: BehaviorNodeContext['previousStreetLine']): BehaviorNodeContext => ({
  street: 'RIVER',
  heroPosition: 'CO',
  villainPosition: 'BB',
  potType: 'SRP',
  playerCount: 2,
  previousStreetLine: line,
  currentAction: 'BET',
  sizeBucket: 'LARGE',
  boardTexture: 'SEMI_WET',
});

console.log('================ 1. NEUTRAL_PARITY 网格（中性画像 vs 既有档位权重）================');
const grid = [
  { label: '25%', ratio: 0.25 },
  { label: '75%', ratio: 0.75 },
  { label: '125%', ratio: 1.25 },
];
let parityFail = 0;
let cells = 0;
let maxAbsDiff = 0;
console.log('size  类别                      legacy        unified       diff        equal?');
for (const g of grid) {
  for (const [cls, bucket] of CLASS_BUCKET) {
    for (const line of ['TURN_CHECK_BACK', 'TURN_BET_CALL'] as const) {
      const legacy = tierWeightOf(likelihoodWeights('AGGRESSIVE', g.ratio), bucket);
      const u = estimateUnifiedActionLikelihood({
        semanticClass: cls,
        strengthBucket: bucket,
        betRatio: g.ratio,
        node: node(line),
        profile: neutral,
        action: 'BET',
      });
      const diff = Math.abs(u.likelihood - legacy);
      maxAbsDiff = Math.max(maxAbsDiff, diff);
      cells += 1;
      if (diff !== 0) parityFail += 1;
      if (line === 'TURN_CHECK_BACK') {
        console.log(
          `${g.label.padEnd(5)} ${cls.padEnd(22)} ${legacy.toFixed(8)}  ${u.likelihood.toFixed(8)}  ` +
            `${diff === 0 ? '0（逐位）' : diff.toExponential(2)}  ${diff === 0 ? 'YES' : '**NO**'}`,
        );
      }
    }
  }
}
console.log(`\n  ⇒ 网格单元数 ${cells}（3 尺寸 × 8 类别 × 2 前序线）`);
console.log(`  ⇒ 最大绝对差 ${maxAbsDiff}`);
console.log(`  ⇒ NEUTRAL_PARITY = ${parityFail === 0 ? 'PASS（逐位相等，无需容差）' : `FAIL（${parityFail} 个单元不等）`}`);

console.log('\n================ 2. 03A / 03B 逐类别：钳位前的值 ================');
console.log('类别                     03A/03B | base       ×调整      = raw        最终       clamp  条目数');
for (const [cls, bucket] of CLASS_BUCKET) {
  for (const [tag, prof] of [['03A', cs], ['03B', maniac]] as const) {
    const u = estimateUnifiedActionLikelihood({
      semanticClass: cls,
      strengthBucket: bucket,
      betRatio: 0.75,
      node: node('TURN_CHECK_BACK'),
      profile: prof,
      action: 'BET',
    });
    console.log(
      `${cls.padEnd(22)} ${tag}     | ${u.baseLikelihood.toFixed(6)}  ${u.combinedAdjustment.toFixed(6)}  ` +
        `${u.rawLikelihood.toFixed(6)}  ${u.likelihood.toFixed(6)}  ${u.clamped ? '**YES**' : 'no  '}  ${u.appliedTraitCount}`,
    );
  }
}
const saturating = CLASS_BUCKET.flatMap(([cls, bucket]) =>
  (['03A', '03B'] as const).flatMap((tag) => {
    const prof = tag === '03A' ? cs : maniac;
    const u = estimateUnifiedActionLikelihood({
      semanticClass: cls, strengthBucket: bucket, betRatio: 0.75,
      node: node('TURN_CHECK_BACK'), profile: prof, action: 'BET',
    });
    return u.clamped ? [`${cls}/${tag}`] : [];
  }),
);
console.log(`\n  ⇒ 发生钳位的 (类别, 画像)：${saturating.length === 0 ? '无（0 个）' : saturating.join(', ')}`);

console.log('\n================ 3. §三十八 方向（MANIAC · 错过听牌 · LARGE）================');
for (const line of ['TURN_CHECK_BACK', 'TURN_BET_CALL'] as const) {
  const u = estimateUnifiedActionLikelihood({
    semanticClass: 'MISSED_FLUSH_DRAW', strengthBucket: 5, betRatio: 0.75,
    node: node(line), profile: maniac, action: 'BET',
  });
  console.log(`  ${line.padEnd(18)} likelihood=${u.likelihood.toFixed(6)}  raw=${u.rawLikelihood.toFixed(6)}  条目数=${u.appliedTraitCount}`);
}

console.log('\n================ 4. 池先验自检（cond 必须恰为 1）================');
for (const key of Object.keys(ENVIRONMENT_BEHAVIOR_PRIOR) as (keyof typeof ENVIRONMENT_BEHAVIOR_PRIOR)[]) {
  const rate = neutral.traits[key].effectiveRate;
  const env = ENVIRONMENT_BEHAVIOR_PRIOR[key];
  console.log(`  ${String(key).padEnd(26)} rate=${rate} env=${env} ${rate === env ? '逐位相等 ⇒ cond=1' : '**不等**'}`);
}
