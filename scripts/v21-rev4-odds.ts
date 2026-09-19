/**
 * Reviewer 4 · probe 2 — 几率比 `rateOdds` / `cond` 的数值
 *
 * 只读生产实现（`rateOdds` / `cond` 是模块私有 ⇒ 用**逐字同构**的本地副本，
 * 并同时通过与生产同源的 `estimateUnifiedActionLikelihood` 交叉验证）。
 * 运行：node --experimental-strip-types scripts/v21-rev4-odds.ts
 */
import {
  ARCHETYPE_BEHAVIOR_PRIORS,
  BEHAVIOR_TRAIT_ZH,
  BehaviorTraitKey,
  ENVIRONMENT_BEHAVIOR_PRIOR,
  NEUTRAL_ARCHETYPES,
  behaviorProfileOf,
  estimateUnifiedActionLikelihood,
  type BehaviorNodeContext,
} from '../src/domain/player/behaviorProfile.ts';
import { ALL_QUICK_PROFILES } from '../src/app/manualInput/manualInput.ts';

/** 与 behaviorProfile.ts:592-599 **逐字同构**的本地副本 */
const rateOddsLocal = (rate: number): number => {
  const p = Math.max(0.001, Math.min(0.999, rate));
  return p / (1 - p);
};
const condLocal = (key: BehaviorTraitKey, rate: number): number =>
  rateOddsLocal(rate) / rateOddsLocal(ENVIRONMENT_BEHAVIOR_PRIOR[key]);

const p20 = (x: number): string => (Number.isFinite(x) ? x.toPrecision(20) : String(x));
const p17 = (x: number): string => (Number.isFinite(x) ? x.toPrecision(17) : String(x));

console.log('=========== (a) rateOdds 钳位边界 ===========');
console.log('ENVIRONMENT_BEHAVIOR_PRIOR =', JSON.stringify(ENVIRONMENT_BEHAVIOR_PRIOR));
console.log('MANUAL_READ scale = {VERY_LOW:0.05, LOW:0.2, MEDIUM:0.45, HIGH:0.65, VERY_HIGH:0.8}');
for (const [label, r] of [
  ['0（下溢到 0）', 0],
  ['0.0001（< 0.001）', 0.0001],
  ['0.001（恰好下界）', 0.001],
  ['0.001 → p 逐位', 0.001],
  ['1（上溢）', 1],
  ['0.9999（> 0.999）', 0.9999],
  ['0.999（恰好上界）', 0.999],
  ['-1', -1],
  ['2', 2],
  ['NaN', Number.NaN],
  ['+Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
] as const) {
  console.log(`  rateOdds(${label}) = ${p20(rateOddsLocal(r))}`);
}
console.log(`  ⇒ 钳位区间实际为 [${p17(0.001)}, ${p17(0.999)}] ⇒ odds ∈ [${p17(rateOddsLocal(0.001))}, ${p17(rateOddsLocal(0.999))}]`);
console.log(`  ⇒ 0 → ${p17(rateOddsLocal(0))}（被钳到 0.001，不是 0）`);
console.log(`  ⇒ 1 → ${p17(rateOddsLocal(1))}（被钳到 0.999，不是 +∞）`);
console.log(`  ⇒ NaN → ${rateOddsLocal(Number.NaN)}（NaN 穿透 Math.max/min ⇒ odds=NaN，cond=NaN）`);
console.log(`  ⇒ -1 → ${p17(rateOddsLocal(-1))}；2 → ${p17(rateOddsLocal(2))}`);

console.log('\n=========== (b) rate === poolPrior ⇒ cond 是否**逐位** 1.0 ===========');
let total = 0;
let exact1 = 0;
const notOne: string[] = [];
/*
 * 三条真实进入 effectiveRate 的路径：
 *  P1 标签先验（`ARCHETYPE_BEHAVIOR_PRIORS[arch][key].rate`）
 *  P2 池先验（无先验标签 / 缺条目 ⇒ `ENVIRONMENT_BEHAVIOR_PRIOR[key]`）
 *  P3 人工读数（manualReadEvidence 的 5 档；**它忽略 environmentPrior**）
 *  P4 实测（statEvidenceOf 后验均值）
 */
for (const key of Object.values(BehaviorTraitKey)) {
  const env = ENVIRONMENT_BEHAVIOR_PRIOR[key];
  // P2：rate 逐位等于池先验
  total++;
  if (condLocal(key, env) === 1) exact1++;
  else notOne.push(`P2 ${key} rate=${p17(env)} ⇒ cond=${p20(condLocal(key, env))}`);
  // P1：每个原型的条目先验
  for (const arch of ALL_QUICK_PROFILES) {
    const pri = ARCHETYPE_BEHAVIOR_PRIORS[arch]?.[key];
    if (pri === undefined) continue;
    total++;
    if (condLocal(key, pri.rate) === 1) exact1++;
    else notOne.push(`P1 ${arch}/${key} rate=${p17(pri.rate)} ⇒ cond=${p20(condLocal(key, pri.rate))}`);
  }
  // P3：人工读数；environmentPrior 被忽略 ⇒ 只有恰好撞上池先验才对 1.0
  for (const r of [0.05, 0.2, 0.45, 0.65, 0.8]) {
    total++;
    if (condLocal(key, r) === 1) exact1++;
  }
}
console.log(`  逐位等于 1.0 的 (trait, rate) 组合：${exact1} / ${total}（其余为不等的合法组合）`);
console.log(`  不等样例（应用先验但 rate ≠ poolPrior）：${notOne.slice(0, 6).join(' | ') || '（无）'}`);

console.log('\n  —— 逐原型「中性画像」验证：UNKNOWN/NORMAL 等声明中性的标签，其 traits.effectiveRate 是否逐位等于池先验 ——');
for (const arch of ALL_QUICK_PROFILES) {
  const prof = behaviorProfileOf({ playerId: 'x', archetype: arch as never });
  const rows: string[] = [];
  let allExact = true;
  for (const key of Object.values(BehaviorTraitKey)) {
    const r = prof.traits[key].effectiveRate;
    const ok = r === ENVIRONMENT_BEHAVIOR_PRIOR[key];
    if (!ok) allExact = false;
    const c = condLocal(key, r);
    rows.push(`${key}:${ok ? '=' : '≠'}${c === 1 ? '1' : p17(c)}`);
  }
  console.log(`  ${arch.padEnd(14)} priorAvailable=${String(prof.archetypePriorAvailable).padEnd(5)} 逐位中性=${allExact ? 'Y' : 'N'}  ${rows.join(' ')}`);
}

console.log('\n  —— 每个 trait 的 cond 作用域（池先验 × 全部可达 rate）——');
const MANUAL = [0.05, 0.2, 0.45, 0.65, 0.8];
for (const key of Object.values(BehaviorTraitKey)) {
  const env = ENVIRONMENT_BEHAVIOR_PRIOR[key];
  const cands = new Set<number>([env, ...MANUAL]);
  for (const arch of ALL_QUICK_PROFILES) {
    const pri = ARCHETYPE_BEHAVIOR_PRIORS[arch]?.[key];
    if (pri !== undefined) cands.add(pri.rate);
  }
  const conds = [...cands].map((r) => condLocal(key, r));
  const lo = Math.min(...conds);
  const hi = Math.max(...conds);
  console.log(
    `  ${key.padEnd(26)} poolPrior=${String(env).padEnd(5)} cond ∈ [${p17(lo)}, ${p17(hi)}]  动态范围=${p17(hi / lo)}×  (${BEHAVIOR_TRAIT_ZH[key]})`,
  );
}

console.log('\n=========== (c) 可达 cond 的极值（含实测路径）===========');
let maxCond = -Infinity;
let maxWhere = '';
let minCond = Infinity;
let minWhere = '';
for (const key of Object.values(BehaviorTraitKey)) {
  const envOdds = rateOddsLocal(ENVIRONMENT_BEHAVIOR_PRIOR[key]);
  // 极端实测：机会数极大 + 全成功（upper）/ 全失败（lower）⇒ 被钳到 0.999 / 0.001
  for (const [label, rate] of [['rate→1（钳 0.999）', 0.999], ['rate→0（钳 0.001）', 0.001]] as const) {
    const c = rateOddsLocal(rate) / envOdds;
    if (c > maxCond) { maxCond = c; maxWhere = `${key} / ${label}`; }
    if (c < minCond) { minCond = c; minWhere = `${key} / ${label}`; }
  }
}
console.log(`  最大 cond = ${p17(maxCond)}  @ ${maxWhere}`);
console.log(`  最小 cond = ${p17(minCond)}  @ ${minWhere}`);
console.log(`  ⇒ 理论极值比 = ${p17(maxCond / minCond)}×`);
// 实际可达的最大/最小（只看被真正调用的 5 个主动 trait × 声明先验 + 人工档）
let rMax = -Infinity; let rMaxW = ''; let rMin = Infinity; let rMinW = '';
for (const key of Object.values(BehaviorTraitKey)) {
  const rates = new Set<number>([...MANUAL]);
  for (const arch of ALL_QUICK_PROFILES) {
    const pri = ARCHETYPE_BEHAVIOR_PRIORS[arch]?.[key];
    if (pri !== undefined) rates.add(pri.rate);
  }
  for (const r of rates) {
    const c = condLocal(key, r);
    if (c > rMax) { rMax = c; rMaxW = `${key} rate=${r}`; }
    if (c < rMin) { rMin = c; rMinW = `${key} rate=${r}`; }
  }
}
console.log(`  仅「声明先验 + 人工 5 档」时：最大 cond = ${p17(rMax)} @ ${rMaxW}；最小 cond = ${p17(rMin)} @ ${rMinW}；比值 = ${p17(rMax / rMin)}×`);

console.log('\n=========== (d) 几何平均 / 钳位 ===========');
const RIVER_CLASSES = ['NUT_VALUE','STRONG_VALUE','THIN_VALUE','SHOWDOWN_VALUE','MISSED_FLUSH_DRAW','MISSED_STRAIGHT_DRAW','MISSED_COMBO_DRAW','PURE_AIR'] as const;
const SIZES = ['SMALL','MEDIUM','LARGE','OVERBET'] as const;
const LINES = ['TURN_CHECK_BACK','TURN_BET_CALL','OTHER'] as const;
const node = (sizeBucket: string, previousStreetLine: string): BehaviorNodeContext => ({
  street: 'RIVER', heroPosition: 'CO', villainPosition: 'BB', potType: 'SRP', playerCount: 2,
  previousStreetLine: previousStreetLine as never, currentAction: 'BET', sizeBucket: sizeBucket as never,
  boardTexture: 'SEMI_WET',
});
let maxCombined = 0; let maxCombinedW = ''; let maxRaw = 0; let maxRawW = ''; let clampedCount = 0; let cells = 0;
const clampedCells: string[] = [];
for (const arch of ALL_QUICK_PROFILES) {
  const prof = behaviorProfileOf({ playerId: 'x', archetype: arch as never });
  for (const cls of RIVER_CLASSES) {
    for (const size of SIZES) {
      for (const line of LINES) {
        // strengthBucket：0 最强 … 5 最弱（与 riverComboClassOf 同域）
        for (let bucket = 0; bucket <= 5; bucket++) {
          const L = estimateUnifiedActionLikelihood({
            semanticClass: cls, strengthBucket: bucket, betRatio: 0.75, node: node(size, line),
            profile: prof, action: 'BET', withTrace: false,
          });
          cells++;
          if (L.combinedAdjustment > maxCombined) { maxCombined = L.combinedAdjustment; maxCombinedW = `${arch}/${cls}/${size}/${line}/b${bucket}`; }
          if (L.rawLikelihood > maxRaw) { maxRaw = L.rawLikelihood; maxRawW = `${arch}/${cls}/${size}/${line}/b${bucket}`; }
          if (L.clamped) { clampedCount++; if (clampedCells.length < 8) clampedCells.push(`${arch}/${cls}/${size}/${line}/b${bucket} raw=${p17(L.rawLikelihood)}`); }
        }
      }
    }
  }
}
console.log(`  网格 ${cells} 单元：clamped=${clampedCount}（${((clampedCount / cells) * 100).toFixed(2)}%）`);
console.log(`  最大 combinedAdjustment = ${p17(maxCombined)} @ ${maxCombinedW}`);
console.log(`  最大 rawLikelihood       = ${p17(maxRaw)} @ ${maxRawW}`);
console.log(`  钳位样例：\n    ${clampedCells.join('\n    ') || '（无）'}`);
console.log('  ⇒ `clamped` 只回答「likelihood !== rawLikelihood」；**没有**把 raw > 1 的幅度写进 trace 之外的任何汇总字段；');
console.log('    noteZh 在 clamped=true 时含「（**已钳到 …**）」字样（需 withTrace=true 才拼长文案）');
const sampleClamped = (() => {
  const prof = behaviorProfileOf({ playerId: 'x', archetype: 'MANIAC' as never });
  return estimateUnifiedActionLikelihood({ semanticClass: 'PURE_AIR', strengthBucket: 5, betRatio: 0.75,
    node: node('OVERBET', 'TURN_CHECK_BACK'), profile: prof, action: 'BET', withTrace: true });
})();
console.log(`  样例（MANIAC / PURE_AIR / OVERBET / TURN_CHECK_BACK / b5）：`);
console.log(`    base=${p17(sampleClamped.baseLikelihood)} combined=${p17(sampleClamped.combinedAdjustment)}`);
console.log(`    applieTraitCount=${sampleClamped.appliedTraitCount} sizeAdj=${p17(sampleClamped.sizeAdjustment)} nodeAdj=${p17(sampleClamped.nodeAdjustment)} profileAdj=${p17(sampleClamped.profileAdjustment)}`);
console.log(`    raw=${p17(sampleClamped.rawLikelihood)} likelihood=${p17(sampleClamped.likelihood)} clamped=${sampleClamped.clamped}`);
console.log(`    noteZh=${sampleClamped.noteZh}`);

console.log('\n=========== (d2) 几何平均能否 > 1 且被静默吃掉 ===========');
// 几何平均 > 1 的条件：product > 1。构造「全部因子 > 1」的最小情形
const maniac = behaviorProfileOf({ playerId: 'x', archetype: 'MANIAC' as never });
const und = behaviorProfileOf({ playerId: 'x', archetype: 'UNDERBLUFFER' as never });
for (const [label, prof] of [['MANIAC', maniac], ['UNDERBLUFFER', und]] as const) {
  for (const cls of ['PURE_AIR', 'MISSED_FLUSH_DRAW', 'THIN_VALUE', 'NUT_VALUE'] as const) {
    const L = estimateUnifiedActionLikelihood({ semanticClass: cls, strengthBucket: 5, betRatio: 1.5,
      node: node('OVERBET', 'TURN_CHECK_BACK'), profile: prof, action: 'BET', withTrace: false });
    console.log(
      `  ${label.padEnd(13)} ${cls.padEnd(20)} base=${p17(L.baseLikelihood)} slots(applied=${L.appliedTraitCount}) combined=${p17(L.combinedAdjustment)} raw=${p17(L.rawLikelihood)} clamped=${L.clamped}`,
    );
  }
}
console.log('\n  —— 机会数极大时的实测路径（successes/opportunities → 后验 clamp）——');
for (const [s, o] of [[0, 1], [1, 1], [0, 1000], [1000, 1000], [0, 1e9], [1e9, 1e9], [1, 3], [2, 3]] as const) {
  const prof = behaviorProfileOf({ playerId: 'x', archetype: 'NORMAL' as never, observed: { riverBluff: { successes: s, opportunities: o } } });
  const ev = prof.traits[BehaviorTraitKey.RIVER_BLUFF];
  const L = estimateUnifiedActionLikelihood({ semanticClass: 'PURE_AIR', strengthBucket: 5, betRatio: 1.5,
    node: node('OVERBET', 'OTHER'), profile: prof, action: 'BET', withTrace: false });
  console.log(
    `  ${String(s).padStart(10)}/${String(o).padEnd(10)} effectiveRate=${p17(ev.effectiveRate)} cond=${p17(condLocal(BehaviorTraitKey.RIVER_BLUFF, ev.effectiveRate))} raw=${p17(L.rawLikelihood)} clamped=${L.clamped}`,
  );
}
console.log('  ⇒ 实测 1e9/1e9 时 effectiveRate 被钳在 0.999 ⇒ cond=' + p17(condLocal(BehaviorTraitKey.RIVER_BLUFF, 0.999)) + '（不是 +∞）；0/1e9 时被钳在 0.001 ⇒ cond=' + p17(condLocal(BehaviorTraitKey.RIVER_BLUFF, 0.001)));

console.log('\n=========== (d3) 仅**真实可达**的 (类别, 档位) 组合上的钳位 ===========');
/*
 * 由 `classifyRiverAction` + `riverComboClassOf` 推出的可达配对：
 *   vs STRONGER: tier 0 ⇒ NUT_VALUE；tier 1 ⇒ STRONG_VALUE；tier 2 ⇒ THIN_VALUE；
 *                tier 3 ⇒ SHOWDOWN；tier ≥4 ⇒ UNCERTAIN ⇒ SHOWDOWN_VALUE
 *   vs EQUAL   : SHOWDOWN ⇒ SHOWDOWN_VALUE（任意档）
 *   vs WEAKER  : tier ≤3 ⇒ SHOWDOWN；tier 4 ⇒ UNCERTAIN ⇒ SHOWDOWN_VALUE；
 *                tier ≥5 ⇒ BLUFF_CANDIDATE ⇒ MISSED_* / PURE_AIR
 * 实测覆盖矩阵（见 probe 4）：NUT{0} STRONG{1} THIN{2} SHOWDOWN{1..5} MISSED_x/PURE_AIR{5}
 */
const REAL_PAIRS: readonly (readonly [string, number])[] = [
  ['NUT_VALUE', 0], ['STRONG_VALUE', 1], ['THIN_VALUE', 2],
  ['SHOWDOWN_VALUE', 3], ['SHOWDOWN_VALUE', 4], ['SHOWDOWN_VALUE', 5],
  ['MISSED_FLUSH_DRAW', 5], ['MISSED_STRAIGHT_DRAW', 5], ['MISSED_COMBO_DRAW', 5], ['PURE_AIR', 5],
];
console.log('  （a）betRatio = 0.75（黄金夹具的 LARGE 档）');
let realClamped = 0; let realCells = 0; const realClampedCells: string[] = []; let realMax = 0; let realMaxW = '';
for (const arch of ALL_QUICK_PROFILES) {
  const prof = behaviorProfileOf({ playerId: 'x', archetype: arch as never });
  for (const [cls, bucket] of REAL_PAIRS) {
    for (const size of SIZES) {
      for (const line of LINES) {
        const L = estimateUnifiedActionLikelihood({
          semanticClass: cls as never, strengthBucket: bucket, betRatio: 0.75,
          node: node(size, line), profile: prof, action: 'BET',
        });
        realCells++;
        if (L.rawLikelihood > realMax) { realMax = L.rawLikelihood; realMaxW = `${arch}/${cls}/b${bucket}/${size}/${line}`; }
        if (L.clamped) { realClamped++; if (realClampedCells.length < 6) realClampedCells.push(`${arch}/${cls}/b${bucket}/${size}/${line} raw=${p17(L.rawLikelihood)}`); }
      }
    }
  }
}
console.log(`      可达配对网格 ${realCells} 单元：clamped=${realClamped}（${((realClamped / realCells) * 100).toFixed(2)}%）`);
console.log(`      最大 rawLikelihood = ${p17(realMax)} @ ${realMaxW}`);
console.log(`      钳位样例：${realClampedCells.join(' | ') || '（无）'}`);
console.log('  （b）把 betRatio 推到 3.0（超池）后：');
let bigClamped = 0;
for (const arch of ALL_QUICK_PROFILES) {
  const prof = behaviorProfileOf({ playerId: 'x', archetype: arch as never });
  for (const [cls, bucket] of REAL_PAIRS) for (const line of LINES) {
    const L = estimateUnifiedActionLikelihood({ semanticClass: cls as never, strengthBucket: bucket, betRatio: 3.0, node: node('OVERBET', line), profile: prof, action: 'BET' });
    if (L.clamped) bigClamped++;
  }
}
console.log(`      clamped = ${bigClamped} / ${ALL_QUICK_PROFILES.length * REAL_PAIRS.length * LINES.length}`);
console.log('  ⇒ 在**真实可达配对**上，参考节点（LARGE/0.75）与超池节点都不出现钳位；');
console.log('    而 `noteZh` 的分母是 `unified.length`（全部 990 个 entry，含 prior=0 的 entry），');
console.log('    因此「钳位 N/990」里的 N 会把**后验必然为 0 的组合**也计进去 —— 计数与信息损失不等价。');

for (const [label, prior] of [['prior=0', 0], ['prior=1', 1], ['prior=0.999', 0.999], ['prior=0.001', 0.001]] as const) {
  const od = rateOddsLocal(prior);
  console.log(`  ${label}: rateOdds=${p17(od)}  cond(rate=poolPrior)=${p20(od / od)}`);
}
console.log('  NEUTRAL_ARCHETYPES 声明的中性标签：', Object.keys(NEUTRAL_ARCHETYPES).join(', '));
