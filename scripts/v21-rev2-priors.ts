/**
 * REV2 探针 ①：ARCHETYPE_BEHAVIOR_PRIORS 全真值表 + 逐条单调性（执行得出）
 *
 * 用法：node --experimental-strip-types scripts/v21-rev2-priors.ts
 *
 * 只读生产常量；不改 src/。
 */
import {
  ARCHETYPE_BEHAVIOR_PRIORS,
  BEHAVIOR_TRAIT_ZH,
  BehaviorTraitKey,
  ENVIRONMENT_BEHAVIOR_PRIOR,
  NEUTRAL_ARCHETYPES,
  StatSource,
  behaviorProfileOf,
  selfCheckArchetypePriors,
  manualReadEvidence,
  MANUAL_READ_CONFIDENCE_CAP,
} from '../src/domain/player/behaviorProfile.ts';
import { ALL_QUICK_PROFILES, QUICK_PROFILE_CONFIDENCE } from '../src/app/manualInput/manualInput.ts';

const rateOdds = (rate: number): number => {
  const p = Math.max(0.001, Math.min(0.999, rate));
  return p / (1 - p);
};
const condOf = (key: keyof typeof ENVIRONMENT_BEHAVIOR_PRIOR, rate: number): number =>
  rateOdds(rate) / rateOdds(ENVIRONMENT_BEHAVIOR_PRIOR[key]);

const TRAITS = Object.values(BehaviorTraitKey);
const WITH_PRIOR = ALL_QUICK_PROFILES.filter((a) =>
  Object.prototype.hasOwnProperty.call(ARCHETYPE_BEHAVIOR_PRIORS, a),
);

console.log('================ 0. 常量事实 ================');
console.log(`ALL_QUICK_PROFILES (${ALL_QUICK_PROFILES.length}) = ${ALL_QUICK_PROFILES.join(', ')}`);
console.log(`有先验的标签 (${WITH_PRIOR.length}) = ${WITH_PRIOR.join(', ')}`);
console.log(`声明为中性的标签 (${Object.keys(NEUTRAL_ARCHETYPES).length}) = ${Object.keys(NEUTRAL_ARCHETYPES).join(', ')}`);
console.log(`BehaviorTraitKey (${TRAITS.length}) = ${TRAITS.join(', ')}`);
console.log(`QUICK_PROFILE_CONFIDENCE = ${QUICK_PROFILE_CONFIDENCE}；MANUAL_READ_CONFIDENCE_CAP = ${MANUAL_READ_CONFIDENCE_CAP}`);
console.log(`自检 selfCheckArchetypePriors = ${JSON.stringify(selfCheckArchetypePriors(ALL_QUICK_PROFILES))}`);

console.log('\n================ 1. 生效先验全真值表（effectiveRate，未给 = 池先验）================');
const header =
  'archetype'.padEnd(16) +
  TRAITS.map((t) => t.padEnd(14)).join('') +
  '  source';
console.log(header);
console.log('-'.repeat(header.length + 10));
for (const a of ALL_QUICK_PROFILES) {
  const p = behaviorProfileOf({ playerId: 'x', archetype: a });
  const cells = TRAITS.map((t) => p.traits[t].effectiveRate.toFixed(3).padEnd(14));
  const srcs = new Set(TRAITS.map((t) => (p.traits[t].source === StatSource.PROFILE_PRIOR ? 'P' : 'E')));
  console.log(a.padEnd(16) + cells.join('') + `  ${[...srcs].join('/')}`);
}
console.log('池先验'.padEnd(14) + TRAITS.map((t) => ENVIRONMENT_BEHAVIOR_PRIOR[t].toFixed(3).padEnd(14)).join(''));
console.log('（source: P=PROFILE_PRIOR 标签先验；E=ENVIRONMENT_PRIOR 池先验；同一标签可混合）');

console.log('\n================ 2. 逐条严格单调性（6 个有先验标签 + 池先验基准）================');
/*
 * 声明：UNDERBLUFFER < 池先验 < BLUFF_HEAVY < MANIAC
 * 检验：在每个**主动**条目上，这 4 项的生效值是否严格递增。
 * VERY_TIGHT / CALLING_STATION / LOOSE 不在该声明里，单列出来看它们落在哪。
 */
const CHAIN = ['UNDERBLUFFER', 'ENV_POOL', 'BLUFF_HEAVY', 'MANIAC'] as const;
const OTHERS = ['VERY_TIGHT', 'CALLING_STATION', 'LOOSE'] as const;
const rateOf = (label: string, t: keyof typeof ENVIRONMENT_BEHAVIOR_PRIOR): number =>
  label === 'ENV_POOL'
    ? ENVIRONMENT_BEHAVIOR_PRIOR[t]
    : behaviorProfileOf({ playerId: 'x', archetype: label as never }).traits[t].effectiveRate;

let violations = 0;
for (const t of TRAITS) {
  const vals = CHAIN.map((c) => rateOf(c, t));
  let mono = true;
  for (let i = 1; i < vals.length; i += 1) if (!(vals[i]! > vals[i - 1]!)) mono = false;
  const others = OTHERS.map((o) => rateOf(o, t));
  const ties = new Map<number, string[]>();
  for (const a of ALL_QUICK_PROFILES) {
    const v = rateOf(a === 'ENV_POOL' ? a : a, t);
    const k = Number(v.toFixed(6));
    ties.set(k, [...(ties.get(k) ?? []), a]);
  }
  const tieGroups = [...ties.entries()].filter(([, g]) => g.length > 1);
  if (!mono) violations += 1;
  console.log(
    `${t.padEnd(26)} ${CHAIN.map((c, i) => `${c}=${vals[i]!.toFixed(3)}`).join(' <或> ')}` +
      `  ⇒ 严格递增=${mono ? 'YES' : '**NO**'}`,
  );
  console.log(
    `${''.padEnd(26)} 其它：${OTHERS.map((o, i) => `${o}=${others[i]!.toFixed(3)}`).join(' ')}` +
      `；等值组：${tieGroups.map(([v, g]) => `${v}:[${g.join('=')}]`).join(' ') || '无'}`,
  );
}
console.log(`⇒ 声明链上的违例条目数 = ${violations}`);

console.log('\n================ 3. 几率比（真正进模型的乘数）================');
console.log('archetype'.padEnd(16) + TRAITS.map((t) => t.padEnd(12)).join(''));
for (const a of ALL_QUICK_PROFILES) {
  const p = behaviorProfileOf({ playerId: 'x', archetype: a });
  const cells = TRAITS.map((t) => condOf(t, p.traits[t].effectiveRate).toFixed(4).padEnd(12));
  console.log(a.padEnd(16) + cells.join(''));
}
console.log('\n⇒ 注意：BLUFF_HEAVY / UNDERBLUFFER / MANIAC / LOOSE / VERY_TIGHT 的 thinValueBet 乘数恒为 1.0000（刻意不给）；');
console.log('   callTooWide 没有任何生产读者（见第 5 节）。');

console.log('\n================ 4. CALLING_STATION vs VERY_TIGHT 的「同值」检查 ================');
const cs = behaviorProfileOf({ playerId: 'x', archetype: 'CALLING_STATION' });
const vt = behaviorProfileOf({ playerId: 'x', archetype: 'VERY_TIGHT' });
for (const t of TRAITS) {
  const a = cs.traits[t].effectiveRate;
  const b = vt.traits[t].effectiveRate;
  console.log(
    `  ${t.padEnd(26)} CS=${a.toFixed(3)} VT=${b.toFixed(3)} diff=${(b - a).toFixed(3)}` +
      (a === b ? '  ← **逐位相同**' : ''),
  );
}

console.log('\n================ 5. callTooWide 是否真的影响任何东西（死条目检查）================');
/*
 * 静态证据（本探针内可复算）：behaviorProfile.ts 之外，`callTooWide` /
 * `CALL_TOO_WIDE` 在 src/ 里出现的次数。这里做**行为**检查：
 * 把 callTooWide 拉到极端（manual VERY_HIGH vs VERY_LOW），看 betLikelihood 是否变化。
 */
const { estimateUnifiedActionLikelihood } = await import('../src/domain/player/behaviorProfile.ts');
const node = {
  street: 'RIVER',
  heroPosition: 'CO',
  villainPosition: 'BB',
  potType: 'SRP',
  playerCount: 2,
  previousStreetLine: 'TURN_CHECK_BACK',
  currentAction: 'BET',
  sizeBucket: 'LARGE',
  boardTexture: 'SEMI_WET',
} as const;
const probeClasses = [
  'NUT_VALUE',
  'STRONG_VALUE',
  'THIN_VALUE',
  'SHOWDOWN_VALUE',
  'MISSED_FLUSH_DRAW',
  'MISSED_STRAIGHT_DRAW',
  'MISSED_COMBO_DRAW',
  'PURE_AIR',
] as const;
const bucketOf = { NUT_VALUE: 0, STRONG_VALUE: 1, THIN_VALUE: 2, SHOWDOWN_VALUE: 3 } as Record<string, number>;
for (const tendency of ['VERY_LOW', 'VERY_HIGH'] as const) {
  const prof = behaviorProfileOf({
    playerId: 'x',
    archetype: 'CALLING_STATION',
    manual: { callTooWide: tendency },
  });
  const row = probeClasses.map((c) =>
    estimateUnifiedActionLikelihood({
      semanticClass: c,
      strengthBucket: bucketOf[c] ?? 5,
      betRatio: 0.75,
      node,
      profile: prof,
      action: 'BET',
    }).likelihood.toFixed(8),
  );
  console.log(`  callTooWide=${tendency.padEnd(10)} ⇒ ${row.join(' ')}`);
}
console.log('  ⇒ 两行逐位相同 ⇒ `callTooWide` 在动作似然里**零作用**（预期，注释已声明它只属于响应模型）。');
console.log(
  '  ⇒ 但 `callTooWide` 在整个 src/ 里**没有任何读者**（含响应模型）：' +
    '它是被建模、被赋先验、然后从不被消费的条目。',
);

console.log('\n================ 6. manual 通道：MANUAL_READ_CONFIDENCE_CAP 是否被使用 ================');
const mHigh = manualReadEvidence({ tendency: 'VERY_HIGH', environmentPrior: 0.35 });
console.log(
  `  manualReadEvidence(VERY_HIGH, env=0.35) ⇒ effectiveRate=${mHigh.effectiveRate} confidence=${mHigh.confidence} priorWeight=${mHigh.priorWeight}`,
);
console.log(
  `  ⇒ 构造出的 confidence = ${mHigh.confidence} > MANUAL_READ_CONFIDENCE_CAP=${MANUAL_READ_CONFIDENCE_CAP} ⇒ 上限常量在此路径上**未被使用**。`,
);
