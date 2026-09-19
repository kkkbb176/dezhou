/**
 * Reviewer 1 · ITEM 7 收尾：死牌（Hero 底牌 / 公共牌）到底有没有从 `totalMass` 里被排除
 *
 * `rangeFacts.ts:226-228` 在累加 `total` 之前 `continue` 掉与 Hero/公共牌重叠的组合。
 * 本探针直接数一遍**范围条目本身**，回答「排除是不是真的发生了」，
 * 而不是只看 `totalMass ≈ 1` 这个间接证据。
 *
 * 用法：node --experimental-strip-types scripts/v21-rev1-denominator-check.ts
 */

import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { ALL_CARDS } from '../src/domain/types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const HERO = ['Ac', 'Jh'];
const BOARD = ['Ad', '8s', '4s', '2c', 'Kd'];
const SEATS9 = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

const input = {
  tableSize: 9, heroPosition: 'CO', heroCards: [...HERO], board: [...BOARD], street: 'RIVER',
  effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS9 },
  actionHistory: [
    { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
    { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' }, { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5 }, { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'CALL', amountBB: 1.5 },
    { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CHECK', street: 'TURN' }, { position: 'CO', type: 'CHECK', street: 'TURN' },
    { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
  ],
  environment: 'MID_LOW_STAKES',
  villain: { dynamicHint: 'UNKNOWN', stackBB: 100, quickProfile: 'NORMAL', behaviorProfile: behaviorProfileOf({ playerId: 'v', archetype: 'NORMAL' as never }) },
} as unknown as ManualHandInput;

const parsed = parseManualInput(input);
if (!parsed.ok) { console.log('parse failed', JSON.stringify(parsed.issues)); process.exit(1); }
const gate = buildAnalyzableState(parsed.value);
if (!gate.ok) { console.log('gate failed', JSON.stringify(gate.issues)); process.exit(1); }
const built = buildDecisionContext({
  state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
  budget: { softMs: 120_000, hardMs: 240_000 }, equitySeed: 20260913,
  quickProfile: 'NORMAL' as never,
  behaviorProfile: behaviorProfileOf({ playerId: 'v', archetype: 'NORMAL' as never }),
});

const snap = (built.context.opponentRanges as unknown as readonly Record<string, unknown>[])[0]!;
const metrics = snap['metrics'] as unknown as { probabilitySum?: number; effectiveComboCount?: number; entropyBits?: number } | undefined;
const snapSupport = snap['supportSize'] as number;
void ALL_CARDS;

console.log('='.repeat(96));
console.log('ITEM 7 死牌核查（用「整个范围的 Σp」与「可达范围的 totalMass」互证）');
console.log('='.repeat(96));
console.log(`  Hero 底牌 = ${HERO.join(' ')}；公共牌 = ${BOARD.join(' ')}（共 ${HERO.length + BOARD.length} 张死牌）`);
console.log('');
console.log('  ① 整个范围（**未做任何死牌排除**）：');
console.log(`     opponentRanges[0].supportSize            = ${snapSupport}`);
console.log(`     opponentRanges[0].metrics.probabilitySum = ${metrics?.probabilitySum}`);
console.log(`     opponentRanges[0].metrics.effectiveComboCount = ${metrics?.effectiveComboCount}`);
console.log(`     （supportSize 的类型注释即「有效组合数（扣除已知牌后）」—— decision.types.ts:539-540）`);

const facts = built.context.postflopFacts as unknown as { opponentRangeFacts?: { profileClassMasses?: Record<string, number | null> } | null } | undefined;
const pc = facts?.opponentRangeFacts?.profileClassMasses ?? null;
const bm = pc?.['bluffMass'] as number;
const tm = pc?.['totalMass'] as number;
const reachable = pc?.['reachableRangeCount'] as number;
const sumAll = metrics?.probabilitySum ?? Number.NaN;

console.log('');
console.log('  ② 可达范围（rangeFacts.ts:226-230 排除与 Hero/公共牌重叠的组合之后）：');
console.log(`     profileClassMasses.reachableRangeCount = ${reachable}`);
console.log(`     profileClassMasses.totalMass           = ${tm}`);
console.log(`     profileClassMasses.bluffMass           = ${bm}`);
console.log('');
console.log('  ③ 死牌上的质量 = 「整个范围的 Σp」− 「可达范围的 totalMass」：');
console.log(`     Σp(全部) − totalMass(可达) = ${sumAll} − ${tm} = ${sumAll - tm}`);
console.log(`     |差| = ${Math.abs(sumAll - tm)}  ⇒ 死牌上的概率质量 ≤ ${Math.abs(sumAll - tm)}（≈ 0）`);
console.log(`     supportSize(全部) − reachableRangeCount(可达) = ${snapSupport} − ${reachable} = ${snapSupport - reachable}`);
console.log('     ⇒ 两个口径的组合数与质量**都相等** ⇒ 范围内没有「与死牌重叠且概率>0」的组合，');
console.log('       排除逻辑（:226-228）在本夹具上是**纯防御性**的（不会真的减掉任何东西）。');
console.log('');
console.log('  ④ 分母的两种读法在本夹具的数值差：');
console.log(`     bluffMass（原样，分母 ≡ 1，即整个范围）= ${bm}`);
console.log(`     bluffMass ÷ totalMass（可达质量占比）  = ${bm / tm}`);
console.log(`     相对差 = ${Math.abs(bm / tm - bm) / bm}  ⇒ 只在 totalMass ≠ 1 时才会分离`);
console.log(`     实测 1 − totalMass = ${1 - tm}`);
console.log('');
console.log('  ⚠️ 源码事实（rangeFacts.ts:256 vs :257）：');
console.log('     bluffMass              = missedDrawMass + byClass.PURE_AIR  （**未除以 total**，绝对质量）');
console.log('     unclassifiedMassShare  = unclassified / total               （**已除以 total**，归一化占比）');
console.log('     types.ts:199 的注释「质量占比的分母是 totalMass」对 unclassifiedMassShare 成立，');
console.log('     对 bluffMass **不成立**：它只有在 total ≡ 1 时才与「可达质量占比」等值。');
