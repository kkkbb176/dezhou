/**
 * V2.1 `rangeDistance` 语义探针（Part B 证据）—— 类别级 vs 逐组合级
 *
 * 运行：
 * ```text
 * node --experimental-strip-types scripts/v21-chain-distance-probe.ts
 * ```
 *
 * ## 它证明什么
 *
 * 1. `profileRangeDistance(a, b)` 本身是**通用**的分布距离（对任意等长向量），
 *    但黄金测试（`test/profileQuantificationGolden.test.ts:287-294`）喂给它的
 *    是 **5 个类别质量**，不是 1326 / 逐组合的概率向量；
 * 2. 于是存在**整整一类差异它看不见**：只在**同一个类别内部**重新分配质量
 *    （把纯空气的质量从 A3 挪到 K7）⇒ 5 个类别分量相同 ⇒ 距离 ≈ 0，
 *    而逐组合后验向量之间的距离明显 > 0；
 * 3. 这不是距离函数写错了 —— 把质量在**类别之间**挪动，同一个函数立刻 > 0
 *    （正对照）；
 * 4. 黄金夹具 03A/03B 实际测到的类别级距离是多少（生产路径复现）。
 *
 * ## 两个变体（为什么有「精确 0」和「1 ULP」两种）
 *
 * 生产聚合器是**累加**出来的（`byClass[cat] += p`），累加顺序不同会差 1 ULP。
 * 因此本探针跑两个变体：
 * - **变体 1（二进制精确权重）**：所有权重都是 2 的幂组合（0.5 / 0.25 / 0.125 …），
 *   任何累加顺序都精确 ⇒ 类别级距离**恰好 0**；
 * - **变体 2（十进制不精确权重）**：`0.2 / 0.2 / 0.2` 对 `0.5 / 0.05 / 0.05`，
 *   类别级距离**不是**精确 0，而是 `2.8e-17`（= 1 ULP 量级）——
 *   对 §二十三 的阈值（`TV > 0.02`）当然仍然等同于 0，但报告必须写明这一点。
 *
 * ## 只用真实实现
 *
 * - 分类：`riverComboClassOf`（`domain/postflop/riverProfileClassify.ts`）
 * - 类别质量聚合：`opponentRangeFactsOf` → `profileClassMasses`（生产聚合器）
 * - 距离：`profileRangeDistance`（`domain/player/profileRangeMetrics.ts`）
 * - 范围对象：`buildRangeFromComboWeights`（真实 `Range` 构建入口，TEST_ONLY 来源）
 *
 * 探针不修改 `src/`。
 */

import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { opponentRangeFactsOf } from '../src/app/manualInput/rangeFacts.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { profileRangeDistance } from '../src/domain/player/profileRangeMetrics.ts';
import { riverComboClassOf } from '../src/domain/postflop/riverProfileClassify.ts';
import { ALL_COMBOS, comboIdOf } from '../src/domain/range/combo.ts';
import { buildRangeFromComboWeights } from '../src/domain/range/range.ts';
import { RangeSource } from '../src/domain/range/range.types.ts';
import { parseCardStrict } from '../src/domain/poker/cards.ts';
import { ALL_CARDS, type Card } from '../src/domain/types.ts';
import type { RiverComboClass } from '../src/domain/player/behaviorProfile.ts';
import type { Range, RangeProvenance } from '../src/domain/range/range.types.ts';
import type { OpponentRangeFacts } from '../src/domain/postflop/types.ts';

/* ============================================================
 * 0. 夹具：§十七 黄金手（牌面 / Hero 底牌逐字一致）
 * ============================================================ */

const BOARD: readonly Card[] = ['Ad', '8s', '4s', '2c', 'Kd'].map((t) => parseCardStrict(t));
const HERO: readonly Card[] = ['Ac', 'Jh'].map((t) => parseCardStrict(t));

const boardKeys = new Set(BOARD.map((c) => `${c.rank}${c.suit}`));
const heroKeys = new Set(HERO.map((c) => `${c.rank}${c.suit}`));

console.log('================ 0. 夹具 ================');
console.log(
  `board = ${BOARD.map((c) => `${c.rank}${c.suit}`).join(' ')}` +
    `   hero = ${HERO.map((c) => `${c.rank}${c.suit}`).join(' ')}`,
);

/* ============================================================
 * 1. 用真实分类器给「不与 Hero/公共牌重叠」的组合分类
 * ============================================================ */

type Candidate = { canonicalId: string; category: RiverComboClass };

const byCategory = new Map<RiverComboClass, Candidate[]>();
let overlapping = 0;
let unclassified = 0;

for (const combo of ALL_COMBOS) {
  const holes = [ALL_CARDS[combo.cardIndices[0]]!, ALL_CARDS[combo.cardIndices[1]]!] as const;
  if (holes.some((c) => boardKeys.has(`${c.rank}${c.suit}`) || heroKeys.has(`${c.rank}${c.suit}`))) {
    overlapping += 1;
    continue;
  }
  const cls = riverComboClassOf({ hole: holes, board: BOARD, heroHole: HERO });
  if (cls === null) {
    unclassified += 1;
    continue;
  }
  const list = byCategory.get(cls.category) ?? [];
  list.push({ canonicalId: combo.canonicalId, category: cls.category });
  byCategory.set(cls.category, list);
}

console.log('\n================ 1. 真实分类（riverComboClassOf） ================');
console.log(`ALL_COMBOS=${ALL_COMBOS.length}；与 Hero/公共牌重叠=${overlapping}；无法分类=${unclassified}`);
for (const [category, list] of [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${category.padEnd(22)} ${String(list.length).padStart(4)} 个组合`);
}

const ranked = [...byCategory.entries()]
  .filter(([, list]) => list.length >= 3)
  .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
if (ranked.length < 2) throw new Error('探针需要至少两个各含 ≥3 组合的类别');
const [entryA, entryB] = ranked as [[RiverComboClass, Candidate[]], [RiverComboClass, Candidate[]]];
const catA = entryA[0];
const catB = entryB[0];
const pickA = [...entryA[1]].sort((a, b) => (a.canonicalId < b.canonicalId ? -1 : 1)).slice(0, 3);
const pickB = [...entryB[1]].sort((a, b) => (a.canonicalId < b.canonicalId ? -1 : 1)).slice(0, 3);
console.log(
  `选中的两个类别：${catA}（取 ${pickA.map((c) => c.canonicalId).join('/')}）` +
    ` 与 ${catB}（取 ${pickB.map((c) => c.canonicalId).join('/')}）`,
);

const support: readonly Candidate[] = [...pickA, ...pickB];
const SUPPORT_IDS = support.map((c) => c.canonicalId);

/* ============================================================
 * 通用：真实 Range → 真实类别质量 → 黄金 5 分量 → 距离
 * ============================================================ */

const PROVENANCE: RangeProvenance = Object.freeze({
  sourceId: 'v21.probe.distance',
  sourceType: RangeSource.TEST_ONLY,
  version: 'v1',
  description: 'V2.1 rangeDistance 语义探针的合成范围（禁止进入生产建议）',
  verified: false,
  confidence: 0.1,
});

function buildRangeOf(weights: ReadonlyMap<string, number>, prefix: string): Range {
  const outcome = buildRangeFromComboWeights(new Map(weights), {
    provenance: PROVENANCE,
    rangeIdPrefix: prefix,
  });
  if (!outcome.ok) throw new Error(`探针范围必须可构建：${JSON.stringify(outcome)}`);
  return outcome.value;
}

function factsOf(range: Range): OpponentRangeFacts {
  const facts = opponentRangeFactsOf(range, BOARD, HERO);
  if (facts === null || facts.profileClassMasses === null) {
    throw new Error('探针范围必须能算出 opponentRangeFacts / profileClassMasses');
  }
  return facts;
}

/**
 * **黄金测试 §二十三 的向量构造**
 * （`test/profileQuantificationGolden.test.ts:287-293` 逐字复刻：
 *  value 已含 thin，必须减掉，否则同一个质量被数两次）。
 */
const goldenVector = (m: NonNullable<OpponentRangeFacts['profileClassMasses']>): number[] => [
  (m.valueMass ?? 0) - (m.thinValueMass ?? 0),
  m.thinValueMass ?? 0,
  m.showdownMass ?? 0,
  m.missedDrawMass ?? 0,
  m.pureAirMass ?? 0,
];

type Variant = {
  name: string;
  weightsA: Map<string, number>;
  weightsB: Map<string, number>;
  weightsC: Map<string, number>;
};

const MASS_FIELDS = [
  'totalMass', 'reachableRangeCount', 'nutValueMass', 'strongValueMass', 'thinValueMass',
  'showdownMass', 'missedFlushMass', 'missedStraightMass', 'missedComboMass', 'pureAirMass',
  'valueMass', 'missedDrawMass', 'bluffMass', 'rawSupportCombos', 'effectiveCombos',
  'posteriorMassCombos90', 'posteriorMassCombos95',
] as const;

function runVariant(variant: Variant): void {
  console.log(`\n================ 变体：${variant.name} ================`);
  const show = (label: string, weights: Map<string, number>): void => {
    const parts = SUPPORT_IDS.map((id) => {
      const cat = support.find((c) => c.canonicalId === id)!.category;
      return `${id}[${cat}]=${weights.get(id)}`;
    });
    console.log(`  ${label}：${parts.join('  ')}`);
  };
  show('逐组合原始权重 A', variant.weightsA);
  show('逐组合原始权重 B', variant.weightsB);
  for (const cat of [catA, catB]) {
    const sum = (w: Map<string, number>): number =>
      support.filter((c) => c.category === cat).reduce((acc, c) => acc + (w.get(c.canonicalId) ?? 0), 0);
    console.log(
      `  类别总权重 ${cat.padEnd(22)} A=${sum(variant.weightsA)}  B=${sum(variant.weightsB)}  C=${sum(variant.weightsC)}`,
    );
  }

  const rangeA = buildRangeOf(variant.weightsA, 'probeA');
  const rangeB = buildRangeOf(variant.weightsB, 'probeB');
  const rangeC = buildRangeOf(variant.weightsC, 'probeC');
  const factsA = factsOf(rangeA);
  const factsB = factsOf(rangeB);
  const factsC = factsOf(rangeC);
  const massesA = factsA.profileClassMasses!;
  const massesB = factsB.profileClassMasses!;
  const massesC = factsC.profileClassMasses!;

  console.log('  生产聚合器（profileClassMasses）逐字段比较：');
  for (const field of MASS_FIELDS) {
    const a = (massesA as unknown as Record<string, number>)[field];
    const b = (massesB as unknown as Record<string, number>)[field];
    console.log(
      `    ${field.padEnd(22)} A=${String(a).padEnd(22)} B=${String(b).padEnd(22)} ${a === b ? '==' : '!='}`,
    );
  }

  const gA = goldenVector(massesA);
  const gB = goldenVector(massesB);
  console.log('  黄金测试的 5 分量向量（坚果+强价值, 薄价值, 摊牌, 错过听牌, 纯空气）：');
  console.log(`    A = [${gA.map((x) => x.toFixed(14)).join(', ')}]`);
  console.log(`    B = [${gB.map((x) => x.toFixed(14)).join(', ')}]`);
  console.log(`    JSON 逐位相同 = ${JSON.stringify(gA) === JSON.stringify(gB)}`);

  const categoryDistance = profileRangeDistance(gA, gB);
  if (categoryDistance === null) throw new Error('类别级距离必须可算');
  console.log(
    `\n  (a) 类别级：profileRangeDistance(黄金5分量A, 黄金5分量B) = ` +
      `{ totalVariation: ${categoryDistance.totalVariation}, jsDivergence: ${categoryDistance.jsDivergence}, sharedSupport: ${categoryDistance.sharedSupport} }`,
  );

  const idsA = rangeA.entries.map((e) => e.combo.canonicalId);
  const idsB = rangeB.entries.map((e) => e.combo.canonicalId);
  const alignedA = rangeA.entries.map((e) => e.probability);
  const alignedB = rangeB.entries.map((e) => e.probability);
  console.log(`  entries 数：A=${alignedA.length} B=${alignedB.length}；canonicalId 序列逐位对齐=${idsA.join(',') === idsB.join(',')}`);
  console.log(`    逐组合后验 A = [${alignedA.map((x) => x.toFixed(14)).join(', ')}]`);
  console.log(`    逐组合后验 B = [${alignedB.map((x) => x.toFixed(14)).join(', ')}]`);
  const comboDistance = profileRangeDistance(alignedA, alignedB);
  if (comboDistance === null) throw new Error('逐组合距离必须可算');
  console.log(
    `  (b) 逐组合：profileRangeDistance(后验A, 后验B) = ` +
      `{ totalVariation: ${comboDistance.totalVariation}, jsDivergence: ${comboDistance.jsDivergence}, sharedSupport: ${comboDistance.sharedSupport} }`,
  );

  const gC = goldenVector(massesC);
  const positive = profileRangeDistance(gA, gC);
  if (positive === null) throw new Error('正对照距离必须可算');
  console.log(
    `\n  正对照（把质量挪到**另一个类别**）：C 的 5 分量 = [${gC.map((x) => x.toFixed(14)).join(', ')}]` +
      ` ⇒ totalVariation: ${positive.totalVariation}, jsDivergence: ${positive.jsDivergence}`,
  );
  console.log(
    `  ⇒ 同一函数：**跨类别** TV=${positive.totalVariation} vs **同类别内部** TV=${categoryDistance.totalVariation}` +
      `；逐组合口径 TV=${comboDistance.totalVariation}`,
  );
}

/* ============================================================
 * 2. 变体 1：二进制精确权重（类别级距离**恰好 0**）
 * ============================================================ */

const dyadicA = new Map<string, number>([
  [pickA[0]!.canonicalId, 0.5], [pickA[1]!.canonicalId, 0.25], [pickA[2]!.canonicalId, 0.25],
  [pickB[0]!.canonicalId, 0.5], [pickB[1]!.canonicalId, 0.25], [pickB[2]!.canonicalId, 0.25],
]);
const dyadicB = new Map<string, number>([
  [pickA[0]!.canonicalId, 0.875], [pickA[1]!.canonicalId, 0.0625], [pickA[2]!.canonicalId, 0.0625],
  [pickB[0]!.canonicalId, 0.0625], [pickB[1]!.canonicalId, 0.0625], [pickB[2]!.canonicalId, 0.875],
]);
/** 正对照：类别总量从 (0.5, 0.5) 挪到 (0.75, 0.25)（同样二进制精确） */
const dyadicC = new Map<string, number>([
  [pickA[0]!.canonicalId, 0.75], [pickA[1]!.canonicalId, 0.375], [pickA[2]!.canonicalId, 0.375],
  [pickB[0]!.canonicalId, 0.25], [pickB[1]!.canonicalId, 0.125], [pickB[2]!.canonicalId, 0.125],
]);

runVariant({
  name: '变体 1 · 二进制精确权重（每个类别内部重新分配质量）',
  weightsA: dyadicA,
  weightsB: dyadicB,
  weightsC: dyadicC,
});

/* ============================================================
 * 3. 变体 2：十进制不精确权重（暴露累加顺序的 1 ULP 噪声）
 * ============================================================ */

const decimalA = new Map<string, number>([
  [pickA[0]!.canonicalId, 0.2], [pickA[1]!.canonicalId, 0.2], [pickA[2]!.canonicalId, 0.2],
  [pickB[0]!.canonicalId, 0.4 / 3], [pickB[1]!.canonicalId, 0.4 / 3], [pickB[2]!.canonicalId, 0.4 / 3],
]);
const decimalB = new Map<string, number>([
  [pickA[0]!.canonicalId, 0.5], [pickA[1]!.canonicalId, 0.05], [pickA[2]!.canonicalId, 0.05],
  [pickB[0]!.canonicalId, 0.3], [pickB[1]!.canonicalId, 0.05], [pickB[2]!.canonicalId, 0.05],
]);
const decimalC = new Map<string, number>([
  [pickA[0]!.canonicalId, 0.8 / 3], [pickA[1]!.canonicalId, 0.8 / 3], [pickA[2]!.canonicalId, 0.8 / 3],
  [pickB[0]!.canonicalId, 0.2 / 3], [pickB[1]!.canonicalId, 0.2 / 3], [pickB[2]!.canonicalId, 0.2 / 3],
]);

runVariant({
  name: '变体 2 · 十进制权重（0.2/0.2/0.2 对 0.5/0.05/0.05）',
  weightsA: decimalA,
  weightsB: decimalB,
  weightsC: decimalC,
});

/* ============================================================
 * 4. 黄金夹具 03A/03B 的真实类别级距离（生产路径）
 * ============================================================ */

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEATS = {
  UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
  CO: 100, BTN: 100, SB: 100, BB: 100,
};
const HISTORY = [
  { position: 'UTG', type: 'FOLD' },
  { position: 'UTG1', type: 'FOLD' },
  { position: 'UTG2', type: 'FOLD' },
  { position: 'LJ', type: 'FOLD' },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 },
  { position: 'BTN', type: 'FOLD' },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 1.5 },
  { position: 'BB', type: 'CHECK', street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'TURN' },
  { position: 'CO', type: 'CHECK', street: 'TURN' },
  { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
] as const;

function goldenContextOf(quickProfile: 'CALLING_STATION' | 'MANIAC'): ReturnType<typeof buildDecisionContext> {
  const input = {
    tableSize: 9,
    heroPosition: 'CO',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [...HISTORY],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as never;
  const parsed = parseManualInput(input);
  if (!parsed.ok) throw new Error(`黄金夹具必须可解析：${JSON.stringify(parsed.issues)}`);
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error(`黄金夹具必须可重建：${JSON.stringify(gate.issues)}`);
  return buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    quickProfile,
  });
}

console.log('\n================ 4. 黄金夹具 03A(CALLING_STATION) vs 03B(MANIAC) 的真实距离 ================');
const contextA03 = goldenContextOf('CALLING_STATION');
const contextB03 = goldenContextOf('MANIAC');
const massA03 = contextA03.context.postflopFacts?.opponentRangeFacts?.profileClassMasses ?? null;
const massB03 = contextB03.context.postflopFacts?.opponentRangeFacts?.profileClassMasses ?? null;
if (massA03 === null || massB03 === null) throw new Error('黄金夹具必须给出 profileClassMasses');
const g03A = goldenVector(massA03);
const g03B = goldenVector(massB03);
console.log(`  03A 5 分量 = [${g03A.map((x) => x.toFixed(14)).join(', ')}]`);
console.log(`  03B 5 分量 = [${g03B.map((x) => x.toFixed(14)).join(', ')}]`);
const real = profileRangeDistance(g03A, g03B);
if (real === null) throw new Error('03A/03B 距离必须可算');
console.log(
  `  §二十三 实际断言的就是这个距离：` +
    `{ totalVariation: ${real.totalVariation}, jsDivergence: ${real.jsDivergence}, sharedSupport: ${real.sharedSupport} }`,
);
console.log(
  `  03A/03B 的类别质量（生产路径）：bluffMass ${massA03.bluffMass} → ${massB03.bluffMass}；` +
    `pureAirMass ${massA03.pureAirMass} → ${massB03.pureAirMass}；` +
    `rawSupportCombos ${massA03.rawSupportCombos} → ${massB03.rawSupportCombos}；` +
    `effectiveCombos ${massA03.effectiveCombos} → ${massB03.effectiveCombos}`,
);

/* ============================================================
 * 5. 逐组合后验向量在生产输出里能不能拿到
 * ============================================================ */

console.log('\n================ 5. 生产输出的可观测面 ================');
const context = contextB03.context;
const contextKeys = Object.keys(context as unknown as Record<string, unknown>).sort();
const rangeSnapshotKeys = Object.keys(
  (context.range ?? {}) as unknown as Record<string, unknown>,
).sort();
const factsKeys = Object.keys(
  (context.postflopFacts?.opponentRangeFacts ?? {}) as unknown as Record<string, unknown>,
).sort();
console.log(`  DecisionContext 的字段：${contextKeys.join(', ')}`);
console.log(`  RangeSnapshot 的字段：${rangeSnapshotKeys.join(', ')}`);
console.log(`  opponentRangeFacts 的字段：${factsKeys.join(', ')}`);
console.log(
  '  ⇒ 逐组合后验（cardIndices + probability）**不在**任何公开字段里：' +
    'Range.entries 只活在 contextBuilder 内部，公开面只有类别质量 / 分位数 / 标量指标。',
);
console.log(
  `  生产聚合里的逐组合中间量：effectiveCombos=${String(massB03.effectiveCombos)}、` +
    `posteriorMassCombos90=${String(massB03.posteriorMassCombos90)}、` +
    `posteriorMassCombos95=${String(massB03.posteriorMassCombos95)}（都是**标量**，不是向量）`,
);
console.log(
  `  范围熵（RangeSnapshot.metrics.entropyBits）= ${String(context.range?.metrics.entropyBits)}` +
    '（标量；熵相同不蕴含分布相同，更不可能反推逐组合后验）',
);
console.log(
  `  comboIdOf('Ad','Kd') = ${comboIdOf(parseCardStrict('Ad'), parseCardStrict('Kd'))}` +
    '（`comboIdOf` 只用于**构建**范围，不是读取出口）',
);
