/**
 * Reviewer 1（统计与有效样本量）独立复算探针 —— 模型层
 *
 * 只依赖 `src/domain/player/behaviorProfile.ts` 与 `src/app/manualInput/manualInput.ts`，
 * **不跑管线**，因此可在秒级完成、且不产生任何副作用文件。
 *
 * 用法：
 * ```text
 * node --experimental-strip-types scripts/v21-rev1-model-stats.ts
 * ```
 *
 * 复算的四件事：
 * 1. 7 个样本档 × 9 个原型 × 5 个偏离档的 `effectiveRate`（独立公式 vs 模型输出）；
 * 2. 「无观测」与「观测到 0 次」的逐位差别；
 * 3. `confidence = n/(n+6)` 的 7 档取值；
 * 4. 审计脚本 4 档「证据强度」在**有效画像**上的简并度数（1260 格 → 多少格真正不同）。
 */

import {
  ARCHETYPE_BEHAVIOR_PRIORS,
  BehaviorTraitKey,
  ENVIRONMENT_BEHAVIOR_PRIOR,
  ENVIRONMENT_PRIOR_WEIGHT,
  MANUAL_READ_PSEUDO_COUNT,
  behaviorProfileOf,
  statEvidenceOf,
  StatSource,
} from '../src/domain/player/behaviorProfile.ts';
import { ALL_QUICK_PROFILES } from '../src/app/manualInput/manualInput.ts';

const line = (s = ''): void => console.log(s);
const n = (x: number | null, d = 12): string => (x === null ? 'null' : x.toFixed(d));
const hex = (x: number): string => {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, x);
  return `0x${b.getBigUint64(0).toString(16).padStart(16, '0')}`;
};

/* 审计脚本 `scripts/v21-profile-sensitivity-audit.ts` 的三个轴（逐字复制自 :523-553） */
const SAMPLE_TIERS: readonly { name: string; opportunities: number }[] = [
  { name: 'N0_NO_OBSERVATION', opportunities: 0 },
  { name: 'N2_TINY', opportunities: 2 },
  { name: 'N5_VERY_SMALL', opportunities: 5 },
  { name: 'N20_PRELIMINARY', opportunities: 20 },
  { name: 'N50_STANDARD', opportunities: 50 },
  { name: 'N200_CONFIRMED_EDGE', opportunities: 200 },
  { name: 'N1000_LARGE', opportunities: 1000 },
];
/** 审计脚本 :534-544 的 9 个原型（顺序一致） */
const ARCHETYPES: readonly string[] = [
  'VERY_TIGHT', 'LOOSE', 'CALLING_STATION', 'UNDERBLUFFER', 'BLUFF_HEAVY',
  'UNKNOWN', 'NORMAL', 'TIGHT', 'AGGRESSIVE',
];
/** 审计脚本 :547-553 的 5 个偏离档；`rate` 是**审计脚本自己写的**成功数系数（:635） */
const DEVIATIONS: readonly { name: string; tendency: 'VERY_LOW' | 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH'; auditRate: number }[] = [
  { name: 'VERY_LOW_0.05', tendency: 'VERY_LOW', auditRate: 0.05 },
  { name: 'LOW_0.20', tendency: 'LOW', auditRate: 0.2 },
  { name: 'MEDIUM_0.45', tendency: 'MEDIUM', auditRate: 0.45 },
  { name: 'HIGH_0.65', tendency: 'HIGH', auditRate: 0.65 },
  { name: 'VERY_HIGH_0.95', tendency: 'VERY_HIGH', auditRate: 0.95 },
];
const EVIDENCE_STRENGTHS = [
  'E0_TAG_PRIOR_ONLY', 'E1_MANUAL_STRONG', 'E2_MANUAL_WEAK', 'E3_TAG_PRIOR_REASSERTED',
] as const;
type Strength = (typeof EVIDENCE_STRENGTHS)[number];

/** 审计脚本 `profileFor`（:571-594）的**逐字复刻** —— 用来测量它实际构造出的画像 */
function auditProfileFor(
  archetype: string,
  tier: { opportunities: number },
  successes: number,
  tendency: (typeof DEVIATIONS)[number]['tendency'],
  strength: Strength,
) {
  const key = BehaviorTraitKey.RIVER_BLUFF;
  const manual =
    strength === 'E1_MANUAL_STRONG'
      ? { [key]: tendency }
      : strength === 'E2_MANUAL_WEAK'
        ? { [key]: tendency === 'VERY_HIGH' ? 'LOW' : tendency === 'VERY_LOW' ? 'HIGH' : tendency }
        : undefined;
  const useObserved = strength === 'E3_TAG_PRIOR_REASSERTED';
  return behaviorProfileOf({
    playerId: 'v21-villain',
    archetype: archetype as never,
    ...(manual === undefined ? {} : { manual: manual as never }),
    ...(useObserved && tier.opportunities > 0
      ? { observed: { [key]: { successes, opportunities: tier.opportunities } } as never }
      : {}),
  });
}

/* ============================================================
 * 0. 常量核对
 * ============================================================ */
line('='.repeat(100));
line('ITEM 0 常量核对（直接从源码 import，不是抄来的）');
line('='.repeat(100));
line(`  ENVIRONMENT_PRIOR_WEIGHT = ${ENVIRONMENT_PRIOR_WEIGHT}`);
line(`  MANUAL_READ_PSEUDO_COUNT = ${MANUAL_READ_PSEUDO_COUNT}`);
line(`  ENVIRONMENT_BEHAVIOR_PRIOR.riverBluff = ${ENVIRONMENT_BEHAVIOR_PRIOR.riverBluff}`);
line(`  ALL_QUICK_PROFILES = ${JSON.stringify(ALL_QUICK_PROFILES)}`);
line('');
line('  manualReadEvidence 的 5 档 → effectiveRate（**实测**，机会数 0 ⇒ 逐位等于输入率）');
const TEND = ['VERY_LOW', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'] as const;
const manualRates: Record<string, number> = {};
for (const t of TEND) {
  // 经生产入口 behaviorProfileOf({manual}) 取，而不是直接调 manualReadEvidence，
  // 以保证测到的是**真正进入模型**的那个值
  const p = behaviorProfileOf({ playerId: 'x', manual: { [BehaviorTraitKey.RIVER_BLUFF]: t } as never });
  manualRates[t] = p.traits.riverBluff.effectiveRate;
  line(`    ${t.padEnd(10)} → effectiveRate = ${n(manualRates[t], 17)}  (priorWeight=${p.traits.riverBluff.priorWeight}, opp=${p.traits.riverBluff.opportunities})`);
}
line(`  ⚠️ 审计脚本文件头 :24 与档位名 :552 写的是 VERY_HIGH = 0.95；实测模型用的是 ${manualRates['VERY_HIGH']}`);
line(`  ⚠️ 审计脚本 :635 用 0.95 计算 successes（仅 E3 用）；E1/E2 用 ${manualRates['VERY_HIGH']} —— 同一「偏离档」两种含义`);

/* ============================================================
 * 1. 9 个原型的 riverBluff 先验 + 独立复算 effectiveRate
 * ============================================================ */
line('');
line('='.repeat(100));
line('ITEM 1 9 个原型的 riverBluff 先验率 / 先验权重');
line('='.repeat(100));
line('  archetype        hasPriorPrior  priorRate  priorWeight   source');
const priorOf = (a: string): { rate: number; weight: number; hasPrior: boolean } => {
  const ap = (ARCHETYPE_BEHAVIOR_PRIORS as Record<string, Record<string, { rate: number; weight: number }> | undefined>)[a]?.[
    BehaviorTraitKey.RIVER_BLUFF
  ];
  return ap !== undefined
    ? { rate: ap.rate, weight: ap.weight, hasPrior: true }
    : { rate: ENVIRONMENT_BEHAVIOR_PRIOR.riverBluff, weight: ENVIRONMENT_PRIOR_WEIGHT, hasPrior: false };
};
for (const a of ARCHETYPES) {
  const pr = priorOf(a);
  const p = behaviorProfileOf({ playerId: 'x', archetype: a as never });
  const ok = p.traits.riverBluff.effectiveRate === pr.rate;
  line(
    `  ${a.padEnd(16)} ${String(pr.hasPrior).padEnd(9)}${n(pr.rate, 3).padEnd(11)}${String(pr.weight).padEnd(12)} ` +
      `${p.traits.riverBluff.source.padEnd(20)} 未观测回落到先验=${ok}`,
  );
}
line(`  先验率的不同取值个数 = ${new Set(ARCHETYPES.map((a) => priorOf(a).rate)).size} / 9`);

/* ============================================================
 * 2. 7 档 × 9 原型 × 5 偏离：独立复算 vs 模型输出
 * ============================================================ */
line('');
line('='.repeat(100));
line('ITEM 1b E3（observed）档：独立公式 (prior*w + successes)/(w + n) vs 模型 effectiveRate');
line('='.repeat(100));
const independent = (priorRate: number, priorWeight: number, successes: number, opportunities: number): number =>
  opportunities === 0 ? priorRate : (priorRate * priorWeight + successes) / (priorWeight + opportunities);

let mismatches = 0;
let checked = 0;
line('  archetype        n     succ   prior  独立复算                 模型输出                 差（ULP=1）');
for (const a of ARCHETYPES) {
  const pr = priorOf(a);
  for (const tier of SAMPLE_TIERS) {
    for (const dev of DEVIATIONS) {
      const successes = Math.round(dev.auditRate * tier.opportunities);
      const mine = independent(pr.rate, pr.weight, successes, tier.opportunities);
      const prof = auditProfileFor(a, tier, successes, dev.tendency, 'E3_TAG_PRIOR_REASSERTED');
      const theirs = prof.traits.riverBluff.effectiveRate;
      checked += 1;
      const same = Object.is(mine, theirs);
      if (!same) mismatches += 1;
      // 只打印 n=2 与 n=1000 两个端点，其余聚合
      if ((tier.opportunities === 2 || tier.opportunities === 1000) && same) {
        line(
          `  ${a.padEnd(16)} ${String(tier.opportunities).padEnd(5)} ${String(successes).padEnd(6)} ` +
            `${n(pr.rate, 3).padEnd(7)} ${n(mine, 18)} ${n(theirs, 18)} ${same ? 'bit-同' : '**不同**'}`,
        );
      }
    }
  }
}
line(`  逐位比较：${checked} 格全部与独立公式一致？ mismatches = ${mismatches}`);

/* ---- 端点挤压：固定实测成功率时，effectiveRate 从 n=2 到 n=1000 走多远 ---- */
line('');
line('  「固定实测成功率」的收缩挤压（priorRate=0.15 CALLING_STATION，priorWeight=6）');
line('  successes/n 与 n 的取值：审计的成功数是 round(0.95n) —— 下面同时给出「恰好 95%」的版本');
line('  n          succ(95%)  eff(审计)   eff(恰好0.95)  |  与先验之差');
for (const tier of SAMPLE_TIERS) {
  if (tier.opportunities === 0) continue;
  const sAudit = Math.round(0.95 * tier.opportunities);
  const effAudit = independent(0.15, 6, sAudit, tier.opportunities);
  const effExact = independent(0.15, 6, 0.95 * tier.opportunities, tier.opportunities);
  line(
    `  ${String(tier.opportunities).padEnd(10)} ${String(sAudit).padEnd(10)} ${n(effAudit, 9).padEnd(12)} ${n(effExact, 9).padEnd(15)}  ${n(effAudit - 0.15, 6)}`,
  );
}

/* ============================================================
 * 3. 「无观测」vs「观测到 0 次」
 * ============================================================ */
line('');
line('='.repeat(100));
line('ITEM 2 无观测（opportunities=0）vs 观测到 0 次（successes=0, n=5）');
line('='.repeat(100));
const zeroObs = statEvidenceOf({
  successes: 0, opportunities: 0, priorRate: 0.15, priorWeight: ENVIRONMENT_PRIOR_WEIGHT,
  source: StatSource.OBSERVED_HAND_HISTORY,
});
const fiveZero = statEvidenceOf({
  successes: 0, opportunities: 5, priorRate: 0.15, priorWeight: ENVIRONMENT_PRIOR_WEIGHT,
  source: StatSource.OBSERVED_HAND_HISTORY,
});
line(`  n=0        observedRate=${String(zeroObs.observedRate)}  effectiveRate=${n(zeroObs.effectiveRate, 20)}`);
line(`             effectiveRate === priorRate ? ${zeroObs.effectiveRate === 0.15}  (Object.is=${Object.is(zeroObs.effectiveRate, 0.15)})`);
line(`             priorRate     的 IEEE 位 = ${hex(0.15)}`);
line(`             effectiveRate 的 IEEE 位 = ${hex(zeroObs.effectiveRate)}`);
line(`             (priorRate*6)/6 的 IEEE 位 = ${hex((0.15 * 6) / 6)}   ← 未修复前的旧式`);
line(`  n=5,s=0    observedRate=${String(fiveZero.observedRate)}  effectiveRate=${n(fiveZero.effectiveRate, 20)}`);
line(`             n=0 严格大于 n=5,s=0 ? ${zeroObs.effectiveRate > fiveZero.effectiveRate}  差 = ${n(zeroObs.effectiveRate - fiveZero.effectiveRate, 20)}`);
line(`  confidence n=0 → ${zeroObs.confidence} ; n=5 → ${fiveZero.confidence}`);
line('');
line('  逐位恒等扫描：所有 9 个原型先验率 × 4 个先验权重，n=0 是否都逐位等于先验');
let bitFail = 0; let bitTotal = 0;
for (const a of ARCHETYPES) {
  const pr = priorOf(a);
  for (const w of [0, 1, 3, 6, 12]) {
    for (const s of [0, 1, 7]) {
      const e = statEvidenceOf({ successes: s, opportunities: 0, priorRate: pr.rate, priorWeight: w, source: StatSource.OBSERVED_HAND_HISTORY });
      bitTotal += 1;
      if (!Object.is(e.effectiveRate, pr.rate)) { bitFail += 1; line(`    **不同**: ${a} w=${w} s=${s} ${n(e.effectiveRate, 20)} vs ${n(pr.rate, 20)}`); }
    }
  }
}
line(`    ${bitTotal} 例中逐位不同 = ${bitFail}`);
line('');
line('  对照：同一先验下 n>0、s=0 的收缩（这是「观测到 0」的真实代价）');
for (const tier of SAMPLE_TIERS) {
  if (tier.opportunities === 0) continue;
  const e = statEvidenceOf({ successes: 0, opportunities: tier.opportunities, priorRate: 0.15, priorWeight: 6, source: StatSource.OBSERVED_HAND_HISTORY });
  line(`    n=${String(tier.opportunities).padEnd(6)} s=0 → effectiveRate=${n(e.effectiveRate, 12)}  (先验 0.150 被拉到 ${n(e.effectiveRate, 6)})  confidence=${n(e.confidence, 6)}`);
}
line('');
line('  ⚠️ 边界：n=0 但 successes>0 时信息被静默丢弃');
for (const s of [0, 1, 5, 1000]) {
  const e = statEvidenceOf({ successes: s, opportunities: 0, priorRate: 0.15, priorWeight: 6, source: StatSource.OBSERVED_HAND_HISTORY });
  line(`    successes=${String(s).padEnd(5)} n=0 → successes=${e.successes} observedRate=${String(e.observedRate)} effectiveRate=${n(e.effectiveRate, 6)} (== 先验)`);
}

/* ============================================================
 * 4. confidence = n/(n+6)
 * ============================================================ */
line('');
line('='.repeat(100));
line('ITEM 3 confidence = n / (n + 6) 的 7 档取值 + 与阈值比较');
line('='.repeat(100));
line('  tier                n      confidence   1-confidence   n/(n+6) 复算      逐位一致');
for (const tier of SAMPLE_TIERS) {
  const e = statEvidenceOf({ successes: 0, opportunities: tier.opportunities, priorRate: 0.15, priorWeight: ENVIRONMENT_PRIOR_WEIGHT, source: StatSource.OBSERVED_HAND_HISTORY });
  const mine = tier.opportunities === 0 ? 0 : tier.opportunities / (tier.opportunities + ENVIRONMENT_PRIOR_WEIGHT);
  line(
    `  ${tier.name.padEnd(20)}${String(tier.opportunities).padEnd(7)}${n(e.confidence, 12).padEnd(14)}${n(1 - e.confidence, 12).padEnd(14)}${n(mine, 12).padEnd(18)}${Object.is(mine, e.confidence)}`,
  );
}
line(`  可达最大值（n→∞ 之前）：n=1000 → ${n(1000 / 1006, 12)}；MANUAL_READ_CONFIDENCE_CAP=0.35 对应 n=${(0.35 * 6) / 0.65} 次机会`);
line(`  MANUAL_READ_PSEUDO_COUNT=3 时 0.35 对应 n=${(0.35 * 3) / 0.65}`);
line(`  n/(n+6) ≥ 0.35 ⇔ n ≥ 6*0.35/0.65 = ${(6 * 0.35) / 0.65}`);
line('');
line('  人工画像路径（manual）的 confidence 恒为 0（因为走的 n=0 分支）：');
for (const t of TEND) {
  const p = behaviorProfileOf({ playerId: 'x', manual: { [BehaviorTraitKey.RIVER_BLUFF]: t } as never });
  line(`    ${t.padEnd(10)} confidence=${p.traits.riverBluff.confidence}  priorWeight=${p.traits.riverBluff.priorWeight}  opportunities=${p.traits.riverBluff.opportunities}`);
}

/* ============================================================
 * 5. 1260 格的有效独立数（简并度）
 * ============================================================ */
line('');
line('='.repeat(100));
line('ITEM 6 1260 格的简并度：真正不同的「riverBluff 有效画像」有多少个');
line('='.repeat(100));
const keyOf = (prof: ReturnType<typeof behaviorProfileOf>): string => {
  const t = prof.traits.riverBluff;
  return `${t.effectiveRate}|${t.priorRate}|${t.priorWeight}|${t.opportunities}|${t.successes}|${t.source}`;
};
/** 画像的完整指纹（6 个条目全部） —— 决定似然的真正输入 */
const fullKeyOf = (prof: ReturnType<typeof behaviorProfileOf>): string =>
  (Object.values(BehaviorTraitKey) as (keyof typeof prof.traits)[])
    .map((k) => {
      const t = prof.traits[k];
      return `${k}:${t.effectiveRate}/${t.priorWeight}`;
    })
    .join(';');

const perStrength = new Map<string, Set<string>>();
const globalFull = new Set<string>();
const perArchStrength = new Map<string, Set<string>>();
let cells = 0;
for (const a of ARCHETYPES) {
  for (const strength of EVIDENCE_STRENGTHS) {
    for (const dev of DEVIATIONS) {
      for (const tier of SAMPLE_TIERS) {
        cells += 1;
        const successes = Math.round(dev.auditRate * tier.opportunities);
        const prof = auditProfileFor(a, tier, successes, dev.tendency, strength);
        if (!perStrength.has(strength)) perStrength.set(strength, new Set());
        perStrength.get(strength)!.add(fullKeyOf(prof));
        globalFull.add(fullKeyOf(prof));
        const akey = `${a}|${strength}`;
        if (!perArchStrength.has(akey)) perArchStrength.set(akey, new Set());
        perArchStrength.get(akey)!.add(fullKeyOf(prof));
      }
    }
  }
}
line(`  总格数（复刻审计循环顺序 9×4×5×7）= ${cells}`);
line('  每个「证据强度」内部的不同画像数（9 原型 × 5 偏离 × 7 档 = 315 格）：');
for (const s of EVIDENCE_STRENGTHS) {
  line(`    ${s.padEnd(26)} 不同画像 ${String(perStrength.get(s)!.size).padStart(4)} / 315`);
}
line(`  四档合起来的不同画像数 = ${globalFull.size} / 1260`);
line('');
line('  每个 (原型, 强度) 组合内的不同画像数（5 偏离 × 7 档 = 35 格）：');
for (const a of ARCHETYPES) {
  const row = EVIDENCE_STRENGTHS.map((s) => String(perArchStrength.get(`${a}|${s}`)!.size).padStart(3)).join('  ');
  line(`    ${a.padEnd(16)} ${row}`);
}
line('    （列顺序：E0 / E1 / E2 / E3）');
line('');
/* E0 是否与 E3(n=0) 重合、E2 是否 E1 的子集 */
const e0 = new Set<string>();
const e1 = new Set<string>();
const e2 = new Set<string>();
const e3n0 = new Set<string>();
const e3nPos = new Set<string>();
for (const a of ARCHETYPES) {
  for (const dev of DEVIATIONS) {
    for (const tier of SAMPLE_TIERS) {
      const s = Math.round(dev.auditRate * tier.opportunities);
      e0.add(fullKeyOf(auditProfileFor(a, tier, s, dev.tendency, 'E0_TAG_PRIOR_ONLY')));
      e1.add(fullKeyOf(auditProfileFor(a, tier, s, dev.tendency, 'E1_MANUAL_STRONG')));
      e2.add(fullKeyOf(auditProfileFor(a, tier, s, dev.tendency, 'E2_MANUAL_WEAK')));
      (tier.opportunities === 0 ? e3n0 : e3nPos).add(fullKeyOf(auditProfileFor(a, tier, s, dev.tendency, 'E3_TAG_PRIOR_REASSERTED')));
    }
  }
}
const subset = (x: Set<string>, y: Set<string>): boolean => [...x].every((v) => y.has(v));
line(`  E0 集合大小=${e0.size}；E3(n=0) 集合大小=${e3n0.size}；E3(n=0) ⊆ E0 ? ${subset(e3n0, e0)}`);
line(`  E1 集合大小=${e1.size}；E2 集合大小=${e2.size}；E2 ⊆ E1 ? ${subset(e2, e1)}   ← E2 是否完全不带来新画像`);
line(`  E0 ⊆ E1 ? ${subset(e0, e1)}`);
line(`  E1 ∩ E0 交集大小 = ${[...e1].filter((v) => e0.has(v)).length}`);
line(`  E1 ∩ E3(n>0) 交集大小 = ${[...e1].filter((v) => e3nPos.has(v)).length}`);
line(`  全部不同画像（不含 quickProfile）= ${globalFull.size}`);
line(`  ⚠️ 注意：以上指纹**不含** quickProfile；加上 quickProfile 后不同调用数见 v21-rev1-matrix-distinct.ts（305）`);
line('');
line('  E1/E2 的 effectiveRate 实际取值（应当只有 5 / 3 个，且 E2 是 E1 的子集）：');
const e1rates = new Set<number>(); const e2rates = new Set<number>();
for (const dev of DEVIATIONS) {
  const p1 = auditProfileFor('NORMAL', { opportunities: 0 }, 0, dev.tendency, 'E1_MANUAL_STRONG');
  const p2 = auditProfileFor('NORMAL', { opportunities: 0 }, 0, dev.tendency, 'E2_MANUAL_WEAK');
  e1rates.add(p1.traits.riverBluff.effectiveRate);
  e2rates.add(p2.traits.riverBluff.effectiveRate);
  line(`    ${dev.name.padEnd(18)} E1=${n(p1.traits.riverBluff.effectiveRate, 4).padEnd(8)} E2=${n(p2.traits.riverBluff.effectiveRate, 4)}`);
}
line(`  E1 不同率 ${e1rates.size} 个 = ${JSON.stringify([...e1rates].sort((x, y) => x - y))}`);
line(`  E2 不同率 ${e2rates.size} 个 = ${JSON.stringify([...e2rates].sort((x, y) => x - y))}`);
line(`  E1 E2 无关（E1 不读 archetype，因为 manual 覆盖了先验）：`);
const cs = auditProfileFor('CALLING_STATION', { opportunities: 0 }, 0, 'VERY_HIGH', 'E1_MANUAL_STRONG');
const ma = auditProfileFor('BLUFF_HEAVY', { opportunities: 0 }, 0, 'VERY_HIGH', 'E1_MANUAL_STRONG');
line(`    E1 VERY_HIGH：CALLING_STATION rate=${cs.traits.riverBluff.effectiveRate} vs BLUFF_HEAVY rate=${ma.traits.riverBluff.effectiveRate} → 相等=${cs.traits.riverBluff.effectiveRate === ma.traits.riverBluff.effectiveRate}`);

/* ============================================================
 * 6. opportunities 是否还进入别的量
 * ============================================================ */
line('');
line('='.repeat(100));
line('ITEM 5 opportunities 在**模型层**还进入哪些量');
line('='.repeat(100));
const a2 = behaviorProfileOf({ playerId: 'x', archetype: 'MANIAC' as never, observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 45, opportunities: 50 } } as never });
const a3 = behaviorProfileOf({ playerId: 'x', archetype: 'MANIAC' as never, observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 900, opportunities: 1000 } } as never });
line('  同一成功率 0.9，n=50 vs n=1000：');
for (const [tag, p] of [['n=50 ', a2], ['n=1000', a3]] as const) {
  const t = p.traits.riverBluff;
  line(
    `    ${tag} observedRate=${n(t.observedRate, 6)} effectiveRate=${n(t.effectiveRate, 8)} confidence=${n(t.confidence, 6)} ` +
      `unknownOutcome=${t.unknownOutcomeOpportunities}`,
  );
}
line(`  traits 对象的字段全集 = ${JSON.stringify(Object.keys(a2.traits.riverBluff))}`);
line('  → 模型层里 opportunities 只进入 observedRate / effectiveRate / confidence 三个派生量，');
line('    没有任何「最小机会数」闸门：n=1 与 n=1000 在结构上没有区别（只有数值不同）。');
line('  唯一读 unknownOutcomeOpportunities 的地方：');
line(`    n=50 时 unknownOutcomeOpportunities 是否影响 effectiveRate：`);
const u1 = statEvidenceOf({ successes: 45, opportunities: 50, priorRate: 0.5, priorWeight: 6, source: StatSource.OBSERVED_HAND_HISTORY, unknownOutcomeOpportunities: 0 });
const u2 = statEvidenceOf({ successes: 45, opportunities: 50, priorRate: 0.5, priorWeight: 6, source: StatSource.OBSERVED_HAND_HISTORY, unknownOutcomeOpportunities: 900 });
line(`    unknown=0   → effectiveRate=${n(u1.effectiveRate, 12)} confidence=${n(u1.confidence, 12)}`);
line(`    unknown=900 → effectiveRate=${n(u2.effectiveRate, 12)} confidence=${n(u2.confidence, 12)}`);
line(`    逐位相同 = ${Object.is(u1.effectiveRate, u2.effectiveRate) && Object.is(u1.confidence, u2.confidence)} ← 900 次「未知结果」对模型零影响`);
line('');
line(`  自检：selfCheckArchetypePriors 未在本次探针调用（它需要调用方传入全部标签）；`);
line(`  ARCHETYPE_BEHAVIOR_PRIORS 的键 = ${JSON.stringify(Object.keys(ARCHETYPE_BEHAVIOR_PRIORS))}`);
line('');
