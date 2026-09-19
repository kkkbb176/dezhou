/**
 * REV2 探针 ⑥：尺寸档阈值在**生产链路上**的真实作用（item 6）
 *              + 「刻意中性」标签是否真的中性（item 1/2）
 *
 * 用法：node --experimental-strip-types scripts/v21-rev2-sizecount.ts
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { BetSizeBucketOf } from '../src/domain/player/behaviorProfile.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, budget: { softMs: 120_000, hardMs: 240_000 } } as const;
const SEATS = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };
const POT = 19;

function handOf(archetype: string, riverBet: number): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'CO', heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' }, { position: 'UTG2', type: 'FOLD' },
      { position: 'LJ', type: 'FOLD' }, { position: 'HJ', type: 'FOLD' },
      { position: 'CO', type: 'RAISE', amountBB: 2.5 },
      { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'CALL', amountBB: 1.5 },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'CO', type: 'CHECK', street: 'TURN' },
      { position: 'BB', type: 'BET', amountBB: riverBet, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { stackBB: 100, quickProfile: archetype },
  } as unknown as ManualHandInput;
}

type Out = { eq: number; bluff: number; air: number; missed: number; value: number; bucket: string; providerApplied: boolean | null };
function measure(archetype: string, riverBet: number): Out | null {
  const input = handOf(archetype, riverBet);
  const parsed = parseManualInput(input);
  if (!parsed.ok) return null;
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) return null;
  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
    budget: { softMs: 120_000, hardMs: 240_000 }, equitySeed: 20260913,
    ...(archetype === 'UNKNOWN' ? {} : { quickProfile: archetype as never }),
  });
  const facts = built.context.postflopFacts?.opponentRangeFacts as unknown as Record<string, any> | null;
  const m = facts?.['profileClassMasses'] as Record<string, number> | undefined;
  const trace = (built.context.range?.updateTrace ?? []).filter((t) => (t as unknown as Record<string, unknown>)['street'] === 'RIVER');
  const note = String((trace[0] as unknown as Record<string, unknown> | undefined)?.['noteZh'] ?? '');
  const bucket = /(SMALL|MEDIUM|LARGE|OVERBET)\//.exec(note)?.[1] ?? '?';
  const ev = built.context.profileRangeEvidence as unknown as Record<string, any> | undefined;
  const r = analyzeManualHand(input, OPTIONS);
  const eq = r.ok ? (r.decision.diagnostics.math.heroEquity ?? 0) : 0;
  return {
    eq, bluff: m?.['bluffMass'] ?? 0, air: m?.['pureAirMass'] ?? 0,
    missed: m?.['missedDrawMass'] ?? 0, value: m?.['valueMass'] ?? 0,
    bucket, providerApplied: ev === undefined ? null : ev['provider']?.['applied'] === true,
  };
}

console.log('################ 1. 0.4 / 0.6 / 1.25 三个阈值在生产链路上的作用 ################');
console.log('（参考手，MANIAC 与 CALLING_STATION；底池 19，只改 BB 的河牌下注额）');
console.log('金额     比例     源码档    权益       诈唬质量   pureAir    missedDraw  价值质量');
for (const amount of [5.68, 7.6, 11.38, 11.42, 19, 23.7, 23.75, 40]) {
  const ratio = amount / POT;
  const srcBucket = BetSizeBucketOf(ratio);
  const rows = ['MANIAC', 'CALLING_STATION'].map((a) => [`${a}`, measure(a, amount)] as const);
  const m = rows[0]![1]!;
  const c = rows[1]![1]!;
  console.log(
    `${String(amount).padEnd(9)}${ratio.toFixed(4).padEnd(9)}${srcBucket.padEnd(10)}` +
      `M:${(m.eq * 100).toFixed(4)}% C:${(c.eq * 100).toFixed(4)}%  Δ=${((m.eq - c.eq) * 100).toFixed(4)}pp  ` +
      `| M 诈唬=${(m.bluff * 100).toFixed(3)}% air=${(m.air * 100).toFixed(3)}% missed=${(m.missed * 100).toFixed(3)}% 价值=${(m.value * 100).toFixed(3)}%` +
      ` trace档=${m.bucket}`,
  );
  if (m.bucket !== c.bucket) console.log(`  ⚠️ 两画像的 trace 档不一致：${m.bucket} vs ${c.bucket}`);
}

console.log('\n--- 1b. 跨 0.4 阈值（SMALL↔MEDIUM）：0.399 vs 0.401 ---');
const a1 = measure('MANIAC', 0.399 * POT);
const a2 = measure('MANIAC', 0.401 * POT);
console.log(`  M 0.399 ⇒ 档=${a1!.bucket} 权益=${(a1!.eq * 100).toFixed(6)}% 诈唬=${(a1!.bluff * 100).toFixed(4)}%`);
console.log(`  M 0.401 ⇒ 档=${a2!.bucket} 权益=${(a2!.eq * 100).toFixed(6)}% 诈唬=${(a2!.bluff * 100).toFixed(4)}%`);
console.log(`  ⇒ 逐位相同？权益 ${a1!.eq === a2!.eq}｜诈唬质量 ${a1!.bluff === a2!.bluff}`);

console.log('\n--- 1c. 跨 0.6 阈值（MEDIUM↔LARGE）：0.599 vs 0.601 ---');
const b1 = measure('MANIAC', 0.599 * POT);
const b2 = measure('MANIAC', 0.601 * POT);
console.log(`  M 0.599 ⇒ 档=${b1!.bucket} 权益=${(b1!.eq * 100).toFixed(6)}% 诈唬=${(b1!.bluff * 100).toFixed(4)}% missed=${(b1!.missed * 100).toFixed(4)}%`);
console.log(`  M 0.601 ⇒ 档=${b2!.bucket} 权益=${(b2!.eq * 100).toFixed(6)}% 诈唬=${(b2!.bluff * 100).toFixed(4)}% missed=${(b2!.missed * 100).toFixed(4)}%`);
console.log(`  ⇒ 权益跳变 ${((b2!.eq - b1!.eq) * 100).toFixed(4)}pp；诈唬质量 ${(b1!.bluff * 100).toFixed(4)}% → ${(b2!.bluff * 100).toFixed(4)}%（×${(b2!.bluff / b1!.bluff).toFixed(4)}）`);

console.log('\n--- 1d. 跨 1.25 阈值（LARGE↔OVERBET）：1.2474 vs 1.25 ---');
const c1 = measure('MANIAC', 1.2474 * POT);
const c2 = measure('MANIAC', 1.25 * POT);
console.log(`  M 1.2474 ⇒ 档=${c1!.bucket} 权益=${(c1!.eq * 100).toFixed(6)}% 诈唬=${(c1!.bluff * 100).toFixed(4)}%`);
console.log(`  M 1.25   ⇒ 档=${c2!.bucket} 权益=${(c2!.eq * 100).toFixed(6)}% 诈唬=${(c2!.bluff * 100).toFixed(4)}%`);
console.log(`  ⇒ 逐位相同？权益 ${c1!.eq === c2!.eq}｜诈唬质量 ${c1!.bluff === c2!.bluff}（` +
  `${c1!.bluff === c2!.bluff ? '**1.25 阈值在似然模型里是死边界**' : '有作用'}）`);

console.log('\n################ 2. 「刻意中性」标签是否真的中性 ################');
console.log('标签            权益         vs UNKNOWN(pp)   provider.applied   全部 4 个诈唬条目的乘数');
for (const a of ['UNKNOWN', 'NORMAL', 'TIGHT', 'VERY_LOOSE', 'AGGRESSIVE']) {
  const m = measure(a, 7);
  const base = measure('UNKNOWN', 7)!;
  console.log(
    `${a.padEnd(16)}${(m!.eq * 100).toFixed(6)}%  ${((m!.eq - base.eq) * 100).toFixed(6).padStart(10)}      ` +
      `${String(m!.providerApplied).padEnd(18)}${m!.bluff === base.bluff ? '与 UNKNOWN 相同' : `诈唬 ${(m!.bluff * 100).toFixed(4)}% vs ${(base.bluff * 100).toFixed(4)}%`}`,
  );
}
