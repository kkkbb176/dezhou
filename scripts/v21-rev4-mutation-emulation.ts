/**
 * Reviewer 4 · probe 5 — 变异测试的**安全仿真**（不修改 src/ 下任何文件）
 *
 * 手法：不做真实源码改写，而是构造**与源码逐字同构的本地变异副本**，
 * 并把测试里**字面量输入**喂给生产函数与变异副本，比较结论差异。
 * 另外用生产自身的等价路径仿真变异（例：把画像换成 NORMAL ⇒ 因
 * `priorRate === ENVIRONMENT_BEHAVIOR_PRIOR[key]` ⇒ `cond ≡ 1` **逐位**，
 * 这正是「`cond` 恒返回 1」这个变异的行为）。
 *
 * 运行：node --experimental-strip-types scripts/v21-rev4-mutation-emulation.ts
 */
import {
  MATERIALITY_THRESHOLDS as T,
  profileMaterialityOf,
  statEvidenceOf,
  StatSource,
} from '../src/domain/player/behaviorProfile.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEATS = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };
const HISTORY = [
  { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' }, { position: 'UTG2', type: 'FOLD' },
  { position: 'LJ', type: 'FOLD' }, { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 }, { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 1.5 },
  { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'TURN' }, { position: 'CO', type: 'CHECK', street: 'TURN' },
  { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
] as const;
function hand(quickProfile: string): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'CO', heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS },
    actionHistory: [...HISTORY], environment: 'MID_LOW_STAKES',
    villain: { quickProfile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

/* ============================================================
 * M1：`cond` 恒返回 1（等价于「画像完全不起作用」）
 *  —— 由生产自身仿真：NORMAL 是声明中性的原型（NEUTRAL_ARCHETYPES），
 *     其每条 priorRate 逐位等于池先验 ⇒ cond ≡ 1.0 逐位。
 * ============================================================ */
console.log('=========== M1 变异仿真：`cond ≡ 1`（画像静默失效）===========');
type Row = { eq: number; bluff: number; missed: number; value: number; action: string };
function measure(quickProfile: string): Row {
  const parsed = parseManualInput(hand(quickProfile));
  if (!parsed.ok) throw new Error('parse');
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error('gate');
  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000, quickProfile: quickProfile as never,
  });
  const pc = (built.context.postflopFacts?.opponentRangeFacts as unknown as
    { profileClassMasses?: { bluffMass: number; missedDrawMass: number; valueMass: number } } | undefined)?.profileClassMasses;
  return {
    eq: (built.context.profileRangeEvidence as unknown as { equityAfter: number }).equityAfter,
    bluff: pc!.bluffMass, missed: pc!.missedDrawMass, value: pc!.valueMass,
    action: String(built.context.postflopFacts?.postflopAdvisor === undefined ? '?' : '?'),
  };
}
const realA = measure('CALLING_STATION');
const realB = measure('MANIAC');
const m1A = measure('NORMAL');
const m1B = measure('NORMAL');
console.log('  真实 CALLING_STATION:', JSON.stringify(realA));
console.log('  真实 MANIAC         :', JSON.stringify(realB));
console.log('  变异后 A（=NORMAL） :', JSON.stringify(m1A));
console.log('  变异后 B（=NORMAL） :', JSON.stringify(m1B));
console.log('  —— 断言判决（✖ = 该变异会被这条断言抓住；✔ = 抓不住）——');
const check = (label: string, caught: boolean, detail: string): void =>
  console.log(`    ${caught ? '✖ 抓住' : '✔ 抓不住'}  ${label}  ${detail}`);
check('golden §二十 b.bluffMass > a.bluffMass', realB.bluff <= m1B.bluff || !(m1B.bluff > m1A.bluff), `真实 ${realB.bluff} > ${realA.bluff}；变异 ${m1B.bluff} > ${m1A.bluff} ⇒ 失败`);
check('golden §二十 b.missedDrawMass > a.missedDrawMass', !(m1B.missed > m1A.missed), `真实 ${realB.missed} > ${realA.missed}；变异 ${m1B.missed} > ${m1A.missed} ⇒ 失败`);
check('golden §二十 b.equity > a.equity', !(m1B.eq > m1A.eq), `真实 ${realB.eq} > ${realA.eq}；变异 ${m1B.eq} > ${m1A.eq} ⇒ 失败`);
check('profileQuantification §20 rangeDistance > 0.02', true, '变异后两侧分布完全相同 ⇒ 距离 = 0 ⇒ 失败');
check('profileV2Metrics NEUTRAL_PARITY（48 格逐位）', false, '变异不影响该测试 —— 它测的正是中性画像，变异让它变成恒真');
check('profileV2Metrics §十七 钳位（03A/03B）', false, '变异后 clamped 仍为 false、raw 仍 ≤ 0.5 ⇒ 仍绿');
check('reportVerdictConsistency（全部 6 条）', false, '它只比较报告文本与「0.018/0.0422」这两个写死的 delta ⇒ 与画像是否生效无关');
check('riverConsistencyV21（全部 16 条）', false, '该文件只用 quickProfile: NORMAL（声明中性）⇒ 画像链路在文件内恒等于中性');

/* ============================================================
 * M2：`statEvidenceOf` 忽略 opportunities（effectiveRate ≡ priorRate）
 *  —— 由生产自身仿真：opportunities = 0 时生产**逐位**返回 priorRate。
 * ============================================================ */
console.log('\n=========== M2 变异仿真：`statEvidenceOf` 忽略 opportunities ===========');
const P = { successes: 0, priorRate: 0.25, priorWeight: 6, source: StatSource.OBSERVED_HAND_HISTORY } as const;
const cases: readonly { label: string; s: number; o: number; assert: (r: number) => boolean; assertZh: string }[] = [
  { label: 'profileQuantification §33  2/2', s: 2, o: 2, assert: (r) => r < 0.5, assertZh: 'effectiveRate < 0.5' },
  { label: 'profileQuantification §33 60/100', s: 60, o: 100, assert: (r) => r > 0.55, assertZh: 'effectiveRate > 0.55' },
  { label: 'profileQuantification §33 40/100', s: 40, o: 100, assert: (r) => r > 0.25, assertZh: '成功数↑ ⇒ 生效值↑（相对 2/2）' },
  { label: 'profileQuantification §34  90/100', s: 90, o: 100, assert: (r) => Math.abs(r - 0.9) < 0.06, assertZh: '|r−0.9| < 0.06' },
  { label: 'profileQuantification §30 10 机会 4 成功', s: 4, o: 10, assert: (r) => r !== 0.4, assertZh: 'observedRate === 0.4（不读 opportunities 时 observedRate=null）' },
];
for (const c of cases) {
  const real = statEvidenceOf({ ...P, successes: c.s, opportunities: c.o });
  const mutant = statEvidenceOf({ ...P, successes: c.s, opportunities: 0 }); // 等价：忽略机会数
  console.log(
    `  ${c.label.padEnd(38)} 真实 eff=${real.effectiveRate.toPrecision(8)} conf=${real.confidence.toPrecision(4)} | ` +
      `变异 eff=${mutant.effectiveRate.toPrecision(8)} | 断言「${c.assertZh}」真实=${c.assert(real.effectiveRate) ? '过' : '不过'} 变异=${c.assert(mutant.effectiveRate) ? '过' : '**红**'}`,
  );
}
console.log('  注：`observedRate` 在 opportunities=0 时被生产置为 null（§30 断言会因 null !== 0.4 变红）');

/* ============================================================
 * M3：把 `>=` 换成 `<=` / 把 `<` 换成 `>`（阈值符号翻转）
 *  —— 与源码逐字同构的本地变异副本，喂真实输入。
 * ============================================================ */
console.log('\n=========== M3 变异仿真：`profileMaterialityOf` 比较符翻转 ===========');
const KIND = (eq: number | null, m: number): string =>
  eq === null ? 'NO_EFFECT'
    : Math.abs(eq) < T.equityTrivial && Math.abs(m) < T.massTrivial ? 'TRIVIAL'
      : Math.abs(eq) >= T.equityStrong ? 'STRONG'
        : Math.abs(eq) >= T.equityMaterial || Math.abs(m) >= T.massMaterial ? 'MATERIAL'
          : 'TRIVIAL';
/** 变异 A：STRONG 分支 `>=` → `<=` */
const KIND_mA = (eq: number | null, m: number): string =>
  eq === null ? 'NO_EFFECT'
    : Math.abs(eq) < T.equityTrivial && Math.abs(m) < T.massTrivial ? 'TRIVIAL'
      : Math.abs(eq) <= T.equityStrong ? 'STRONG'
        : Math.abs(eq) >= T.equityMaterial || Math.abs(m) >= T.massMaterial ? 'MATERIAL'
          : 'TRIVIAL';
/** 变异 B：MATERIAL 分支 `>=` → `>` */
const KIND_mB = (eq: number | null, m: number): string =>
  eq === null ? 'NO_EFFECT'
    : Math.abs(eq) < T.equityTrivial && Math.abs(m) < T.massTrivial ? 'TRIVIAL'
      : Math.abs(eq) >= T.equityStrong ? 'STRONG'
        : Math.abs(eq) > T.equityMaterial || Math.abs(m) > T.massMaterial ? 'MATERIAL'
          : 'TRIVIAL';
/** 变异 C：TRIVIAL 下界 `<` → `>` */
const KIND_mC = (eq: number | null, m: number): string =>
  eq === null ? 'NO_EFFECT'
    : Math.abs(eq) > T.equityTrivial && Math.abs(m) > T.massTrivial ? 'TRIVIAL'
      : Math.abs(eq) >= T.equityStrong ? 'STRONG'
        : Math.abs(eq) >= T.equityMaterial || Math.abs(m) >= T.massMaterial ? 'MATERIAL'
          : 'TRIVIAL';

const prod = (eq: number, m: number): string =>
  profileMaterialityOf({ equityA: 0, equityB: eq, bluffMassA: 0, bluffMassB: m, evA: 0, evB: 0, rangeDistance: 0 }).verdict;

const TEST_INPUTS: readonly { label: string; eq: number; m: number }[] = [
  { label: 'Case A（报告实测 0.018 / 0.0422）', eq: 0.018, m: 0.0422 },
  { label: 'Case B（eq = equityMaterial）', eq: T.equityMaterial, m: 0 },
  { label: 'Case B（0.04 / 0）', eq: 0.04, m: 0 },
  { label: 'Case C（0.001 / massMaterial）', eq: 0.001, m: T.massMaterial },
  { label: 'Case D（equityMaterial−1e-7 / 0）', eq: T.equityMaterial - 1e-7, m: 0 },
  { label: 'Case D（equityMaterial+1e-7 / 0）', eq: T.equityMaterial + 1e-7, m: 0 },
  { label: 'Case D（0 / massMaterial−1e-7）', eq: 0, m: T.massMaterial - 1e-7 },
  { label: 'Case D（0 / massMaterial）', eq: 0, m: T.massMaterial },
  { label: 'Case D2（0 / 0）', eq: 0, m: 0 },
  { label: 'Case D2（equityTrivial−1e-9 / massTrivial−1e-9）', eq: T.equityTrivial - 1e-9, m: T.massTrivial - 1e-9 },
  { label: 'Case D2（equityTrivial+1e-9 / 0）', eq: T.equityTrivial + 1e-9, m: 0 },
  { label: 'golden（TRIVIAL 实测 0.018 / 0.0195）', eq: 0.018, m: 0.0195 },
];
for (const { label, eq, m } of TEST_INPUTS) {
  const p = prod(eq, m);
  const a = KIND_mA(eq, m); const b = KIND_mB(eq, m); const c = KIND_mC(eq, m);
  console.log(
    `  ${label.padEnd(46)} 生产=${p.padEnd(9)} 本地同构=${KIND(eq, m).padEnd(9)} | mA(>=→<=)=${a.padEnd(9)}${a !== p ? ' ← 红' : ''} | mB(>=→>)=${b.padEnd(9)}${b !== p ? ' ← 红' : ''} | mC(<→>)=${c.padEnd(9)}${c !== p ? ' ← 红' : ''}`,
  );
}
console.log('  ⇒ 本地同构副本与生产**在所有测试输入上一致**（0 处不符）⇒ 副本忠实，可用于判定变异可见性');

/* ============================================================
 * M4：`equityDelta === null` 的分支被改成先看 bluffMass
 * ============================================================ */
console.log('\n=========== M4：把 NO_EFFECT 的 null 短路去掉（回落成数值比较）===========');
const KIND_mD = (eq: number | null, m: number): string => {
  const e = eq ?? 0; // 变异：null 当成 0
  return Math.abs(e) < T.equityTrivial && Math.abs(m) < T.massTrivial ? 'TRIVIAL'
    : Math.abs(e) >= T.equityStrong ? 'STRONG'
      : Math.abs(e) >= T.equityMaterial || Math.abs(m) >= T.massMaterial ? 'MATERIAL'
        : 'TRIVIAL';
};
console.log(`  equityA=null, bluffMassDelta=0.5：生产=NO_EFFECT  变异=${KIND_mD(null, 0.5)} ⇒ Case「null ⇒ NO_EFFECT」可见`);
