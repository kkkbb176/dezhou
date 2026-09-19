/**
 * REV2 探针 ②：RiverComboClass 可达性 + 每类每画像的乘数分解（执行得出）
 *
 * 用法：node --experimental-strip-types scripts/v21-rev2-likelihood.ts
 */
import { ALL_CARDS, type Card } from '../src/domain/types.ts';
import { riverComboClassOf } from '../src/domain/postflop/riverProfileClassify.ts';
import {
  BetSizeBucketOf,
  ENVIRONMENT_BEHAVIOR_PRIOR,
  behaviorProfileOf,
  estimateUnifiedActionLikelihood,
  type BehaviorNodeContext,
  type RiverComboClass,
} from '../src/domain/player/behaviorProfile.ts';
import { ALL_QUICK_PROFILES } from '../src/app/manualInput/manualInput.ts';
import { likelihoodWeights, tierWeightOf } from '../src/app/manualInput/likelihoodModel.ts';

const CLASSES: readonly RiverComboClass[] = [
  'NUT_VALUE',
  'STRONG_VALUE',
  'THIN_VALUE',
  'SHOWDOWN_VALUE',
  'MISSED_FLUSH_DRAW',
  'MISSED_STRAIGHT_DRAW',
  'MISSED_COMBO_DRAW',
  'PURE_AIR',
];

const parse = (s: string): Card => {
  const found = ALL_CARDS.find((c) => `${c.rank}${c.suit}` === s || rankLetter(c) + suitLetter(c) === s);
  if (found === undefined) throw new Error(`bad card ${s}`);
  return found;
};
const rankLetter = (c: Card): string =>
  ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' } as Record<number, string>)[c.rank] ??
  String(c.rank);
const suitLetter = (c: Card): string => ({ s: 's', h: 'h', d: 'd', c: 'c' } as Record<string, string>)[c.suit] ?? '?';

const REF_BOARD = ['Ad', '8s', '4s', '2c', 'Kd'].map(parse);
const REF_HERO = ['Ac', 'Jh'].map(parse);

console.log('================ 1. 尺寸档阈值（源码逐字核对 + 执行）================');
for (const r of [0.3, 0.359, 0.399, 0.4, 0.599, 0.6, 0.75, 1.249, 1.25, 1.54]) {
  console.log(`  ratio=${r.toFixed(3)} ⇒ ${BetSizeBucketOf(r)}`);
}

console.log('\n================ 2. 8 个 RiverComboClass 的真实可达性（穷举 45 选 2 = 990 组合）================');
type Stat = { count: number; buckets: Set<number>; examples: string[] };
const stat = new Map<RiverComboClass, Stat>(CLASSES.map((c) => [c, { count: 0, buckets: new Set(), examples: [] }]));
let nullCount = 0;
const ref = [...REF_BOARD, ...REF_HERO].map((c) => `${c.rank}${c.suit}`);
const deck = ALL_CARDS.filter((c) => !ref.includes(`${c.rank}${c.suit}`));
for (let i = 0; i < deck.length; i += 1) {
  for (let j = i + 1; j < deck.length; j += 1) {
    const hole = [deck[i]!, deck[j]!] as const;
    const cls = riverComboClassOf({ hole, board: REF_BOARD, heroHole: REF_HERO });
    if (cls === null) {
      nullCount += 1;
      continue;
    }
    const s = stat.get(cls.category)!;
    s.count += 1;
    s.buckets.add(cls.strengthBucket);
    if (s.examples.length < 4) s.examples.push(`${rankLetter(hole[0])}${suitLetter(hole[0])}${rankLetter(hole[1])}${suitLetter(hole[1])}@t${cls.strengthBucket}`);
  }
}
console.log('参考牌面 A♦8♠4♠2♣K♦，Hero A♣J♥：');
for (const c of CLASSES) {
  const s = stat.get(c)!;
  console.log(
    `  ${c.padEnd(22)} combos=${String(s.count).padStart(3)}  ${s.count === 0 ? '**不可达**' : `档位={${[...s.buckets].sort().join(',')}} 例: ${s.examples.join(' ')}`}`,
  );
}
console.log(`  分类失败(null)=${nullCount}（应为 0：无与 Hero/公共牌重叠的组合）`);

console.log('\n================ 3. 逐类 × 逐标签：乘数分解（LARGE 尺寸 + TURN_CHECK_BACK）================');
const nodeOf = (line: BehaviorNodeContext['previousStreetLine'], size: BehaviorNodeContext['sizeBucket']): BehaviorNodeContext => ({
  street: 'RIVER', heroPosition: 'CO', villainPosition: 'BB', potType: 'SRP', playerCount: 2,
  previousStreetLine: line, currentAction: 'BET', sizeBucket: size, boardTexture: 'SEMI_WET',
});
const REP_BUCKET: Record<RiverComboClass, number> = {
  NUT_VALUE: 0, STRONG_VALUE: 1, THIN_VALUE: 2, SHOWDOWN_VALUE: 3,
  MISSED_FLUSH_DRAW: 5, MISSED_STRAIGHT_DRAW: 5, MISSED_COMBO_DRAW: 5, PURE_AIR: 5,
};
for (const [line, size, ratio] of [
  ['TURN_CHECK_BACK', 'LARGE', 0.75],
  ['TURN_BET_CALL', 'LARGE', 0.75],
  ['TURN_BET_CALL', 'SMALL', 0.359],
] as const) {
  console.log(`\n--- 前序线=${line} 尺寸=${size} (ratio=${ratio}) ---`);
  console.log(
    '类别'.padEnd(20) + 'K  ' + '中性'.padEnd(10) + ALL_QUICK_PROFILES.map((a) => a.slice(0, 9).padEnd(10)).join(''),
  );
  for (const cls of CLASSES) {
    const cells: string[] = [];
    let slotK = 1;
    for (const a of ALL_QUICK_PROFILES) {
      const u = estimateUnifiedActionLikelihood({
        semanticClass: cls, strengthBucket: REP_BUCKET[cls], betRatio: ratio,
        node: nodeOf(line, size), profile: behaviorProfileOf({ playerId: 'x', archetype: a }), action: 'BET',
      });
      slotK = u.appliedTraitCount === 0 ? 1 : Math.round(Math.log(u.rawLikelihood / u.baseLikelihood) / Math.log(u.combinedAdjustment));
      cells.push(u.combinedAdjustment.toFixed(4).padEnd(10));
    }
    const neutralU = estimateUnifiedActionLikelihood({
      semanticClass: cls, strengthBucket: REP_BUCKET[cls], betRatio: ratio,
      node: nodeOf(line, size), profile: behaviorProfileOf({ playerId: 'x', archetype: 'UNKNOWN' }), action: 'BET',
    });
    const allSame = cells.every((c) => c === cells[0]);
    console.log(
      `${cls.padEnd(20)}${String(slotK).padEnd(3)}${neutralU.combinedAdjustment.toFixed(4).padEnd(10)}${cells.join('')}${allSame ? '  ← 画像不可见' : ''}`,
    );
  }
}

console.log('\n================ 4. 画像不可见的类别（所有 11 个标签下 likelihood 逐位相同）================');
const invisible: RiverComboClass[] = [];
for (const cls of CLASSES) {
  const vals = new Set(
    ALL_QUICK_PROFILES.map((a) =>
      estimateUnifiedActionLikelihood({
        semanticClass: cls, strengthBucket: REP_BUCKET[cls], betRatio: 0.75,
        node: nodeOf('TURN_CHECK_BACK', 'LARGE'), profile: behaviorProfileOf({ playerId: 'x', archetype: a }), action: 'BET',
      }).likelihood,
    ),
  );
  if (vals.size === 1) invisible.push(cls);
}
console.log(`  不可见类别 (${invisible.length}/8)：${invisible.join(', ')}`);
console.log(`  可见类别   (${8 - invisible.length}/8)：${CLASSES.filter((c) => !invisible.includes(c)).join(', ')}`);

console.log('\n================ 5. 尺寸槽语义：SMALL 下「大注诈唬」条目不施加 ⇒ 乘数被 K 稀释 ================');
for (const size of ['SMALL', 'MEDIUM', 'LARGE', 'OVERBET'] as const) {
  for (const a of ['MANIAC', 'CALLING_STATION'] as const) {
    const u = estimateUnifiedActionLikelihood({
      semanticClass: 'PURE_AIR', strengthBucket: 5, betRatio: 0.75,
      node: nodeOf('TURN_BET_CALL', size), profile: behaviorProfileOf({ playerId: 'x', archetype: a }), action: 'BET',
    });
    console.log(
      `  ${size.padEnd(8)} ${a.padEnd(16)} likelihood=${u.likelihood.toFixed(6)} base=${u.baseLikelihood.toFixed(6)} appliedConds=${u.appliedTraitCount} combined=${u.combinedAdjustment.toFixed(6)}`,
    );
  }
}

console.log('\n================ 6. 「施加更多 >1 因子必抬高调整值」的单调性检查 ================');
/*
 * 由于分母 K 是**结构槽位**（bluff 类恒为 3），当实际施加的 cond 少时
 * 乘数被开三次方稀释。检验：从 SMALL/TURN_BET_CALL（1 条 cond）
 * 到 LARGE/TURN_CHECK_BACK（3 条 cond），乘数是否单调上升。
 */
for (const a of ['MANIAC', 'BLUFF_HEAVY', 'CALLING_STATION', 'UNDERBLUFFER', 'VERY_TIGHT'] as const) {
  const cases = [
    ['SMALL', 'TURN_BET_CALL'],
    ['LARGE', 'TURN_BET_CALL'],
    ['LARGE', 'TURN_CHECK_BACK'],
  ] as const;
  const vals = cases.map(([size, line]) =>
    estimateUnifiedActionLikelihood({
      semanticClass: 'PURE_AIR', strengthBucket: 5, betRatio: 0.75,
      node: nodeOf(line, size as BehaviorNodeContext['sizeBucket']),
      profile: behaviorProfileOf({ playerId: 'x', archetype: a }), action: 'BET',
    }),
  );
  const mono = vals[0]!.combinedAdjustment <= vals[1]!.combinedAdjustment && vals[1]!.combinedAdjustment <= vals[2]!.combinedAdjustment;
  console.log(
    `  ${a.padEnd(16)} SMALL/BET_CALL=${vals[0]!.combinedAdjustment.toFixed(4)} → LARGE/BET_CALL=${vals[1]!.combinedAdjustment.toFixed(4)}` +
      ` → LARGE/CHECK_BACK=${vals[2]!.combinedAdjustment.toFixed(4)}  单调=${mono ? 'YES' : '**NO**'}`,
  );
}

console.log('\n================ 7. 与既有档位权重的关系（中性校准层核对）================');
for (const r of [0.359, 0.75, 1.54]) {
  const w = likelihoodWeights('AGGRESSIVE', r);
  console.log(`  ratio=${r} 档位权重 = [${w.map((x) => x.toFixed(4)).join(', ')}]  tiers 0..5 = ${w.map((_, i) => tierWeightOf(w, i).toFixed(4)).join(' ')}`);
}
