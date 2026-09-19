/**
 * V2.1 缺陷修复的**前后证据**探针（三项）
 *
 * 用法：
 * ```text
 * node --experimental-strip-types scripts/v21-defect-evidence.ts before
 * node --experimental-strip-types scripts/v21-defect-evidence.ts after
 * ```
 *
 * 三项：
 * - **D-A** 非法数值穿透：`successes/opportunities/priorWeight` 无有限性守卫 ⇒
 *   `likelihood = NaN` ⇒ 整条河牌动作的贝叶斯更新被**静默丢弃**（权益反而变高）。
 * - **D-B** 残缺画像直接把整手牌打挂：`traits` 缺条目 ⇒ `CONTEXT_BUILD_FAILED`。
 * - **D-C** `profileMaterialityOf` 对 `NaN` / `Infinity` 无守卫 ⇒ 判定与展示自相矛盾。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import {
  behaviorProfileOf, BehaviorTraitKey, profileMaterialityOf,
  type PlayerBehaviorProfile,
} from '../src/domain/player/behaviorProfile.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  budget: { softMs: 120_000, hardMs: 240_000 }, equitySeed: 20260913,
} as const;
const MODE = process.argv[2] ?? 'before';
console.log(`########## MODE = ${MODE} ##########`);

const SEATS9 = {
  UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
  CO: 100, BTN: 100, SB: 100, BB: 100,
} as const;
const HISTORY = [
  { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
  { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 },
  { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 1.5 },
  { position: 'BB', type: 'CHECK', street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'TURN' },
  { position: 'CO', type: 'CHECK', street: 'TURN' },
  { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
] as const;

function make(bp: unknown): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'CO', heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS9 },
    actionHistory: HISTORY.map((h) => ({ ...h })),
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, behaviorProfile: bp },
  } as unknown as ManualHandInput;
}

const pct = (x: number | null | undefined, d = 4): string =>
  (x === null || x === undefined || !Number.isFinite(x) ? String(x) : (x * 100).toFixed(d));

function run(label: string, bp: unknown): void {
  const input = make(bp);
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) {
    console.log(`  ${label.padEnd(52)} ✖ ok=false stage=${r.stage} :: ${JSON.stringify(r.issues).slice(0, 200)}`);
    return;
  }
  const m = r.decision.diagnostics.math;
  const parsed = parseManualInput(input);
  let bluff = '—', trace = '';
  if (parsed.ok) {
    const gate = buildAnalyzableState(parsed.value);
    if (gate.ok) {
      const ctx = (gate as unknown as { state: unknown }).state;
      void ctx;
    }
  }
  console.log(
    `  ${label.padEnd(52)} ✔ 权益=${pct(m.heroEquity)}% 所需=${pct(m.requiredEquity, 2)}% ` +
    `callEV=${m.callEV?.toFixed(4) ?? '—'} 动作=${r.decision.action} ${bluff}${trace}`,
  );
}

/* ---------------- D-A：非法数值 ---------------- */
console.log('\n=== D-A 非法数值（observed / priorWeight）===');
run('A0 对照：observed 30/50（合法）', behaviorProfileOf({
  playerId: 'v', archetype: 'MANIAC' as never,
  observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 30, opportunities: 50 } } as never,
}));
run('A1 observed successes = NaN', behaviorProfileOf({
  playerId: 'v', archetype: 'MANIAC' as never,
  observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: Number.NaN, opportunities: 10 } } as never,
}));
run('A2 observed opportunities = NaN', behaviorProfileOf({
  playerId: 'v', archetype: 'MANIAC' as never,
  observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 3, opportunities: Number.NaN } } as never,
}));
run('A3 observed opportunities = Infinity', behaviorProfileOf({
  playerId: 'v', archetype: 'MANIAC' as never,
  observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 3, opportunities: Number.POSITIVE_INFINITY } } as never,
}));
run('A4 observed successes = -5（负数）', behaviorProfileOf({
  playerId: 'v', archetype: 'MANIAC' as never,
  observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: -5, opportunities: 10 } } as never,
}));

/* ---------------- D-B：残缺画像 ---------------- */
console.log('\n=== D-B 残缺画像（traits 缺条目）===');
{
  const full = behaviorProfileOf({ playerId: 'v', archetype: 'MANIAC' as never });
  const partialEmpty = { ...full, traits: {} } as unknown as PlayerBehaviorProfile;
  const partialOne = {
    ...full,
    traits: { [BehaviorTraitKey.RIVER_BLUFF]: full.traits[BehaviorTraitKey.RIVER_BLUFF] },
  } as unknown as PlayerBehaviorProfile;
  run('B0 对照：完整画像', full);
  run('B1 traits = {} （空对象）', partialEmpty);
  run('B2 traits 只有 riverBluff 一条', partialOne);
}

/* ---------------- D-C：materiality 边界 ---------------- */
console.log('\n=== D-C profileMaterialityOf 非有限输入 ===');
const cases: readonly { label: string; eq: [number, number] | [null, null]; mass: [number, number] }[] = [
  { label: 'C0 正常 TRIVIAL', eq: [0.5, 0.51], mass: [0.01, 0.02] },
  { label: 'C1 equityB = NaN', eq: [0.5, Number.NaN], mass: [0.01, 0.02] },
  { label: 'C2 equityB = Infinity', eq: [0.5, Number.POSITIVE_INFINITY], mass: [0.01, 0.02] },
  { label: 'C3 bluffMassB = NaN（权益大差）', eq: [0.5, 0.56], mass: [0.01, Number.NaN] },
  { label: 'C4 equityA = null 但 mass 差 0.5', eq: [null, null], mass: [0.0, 0.5] },
];
for (const c of cases) {
  const out = profileMaterialityOf({
    equityA: c.eq[0], equityB: c.eq[1], bluffMassA: c.mass[0], bluffMassB: c.mass[1],
    evA: 0, evB: 0, rangeDistance: 0,
  });
  console.log(`  ${c.label.padEnd(40)} ⇒ ${out.verdict.padEnd(10)} equityDelta=${String(out.equityDelta)} ${out.noteZh}`);
}
console.log('\n（以上输出即为本 MODE 的完整证据）');
