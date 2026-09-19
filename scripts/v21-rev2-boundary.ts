/**
 * REV2 探针 ⑦：权威下注比例（action.amount / action.potBefore）+ 三个尺寸阈值的真实作用
 *
 * 用法：node --experimental-strip-types scripts/v21-rev2-boundary.ts
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

type Out = { ratio: number; potBefore: number; amount: number; bucket: string; eq: number; bluff: number; missed: number };
function measure(archetype: string, riverBet: number): Out | null {
  const input = handOf(archetype, riverBet);
  const parsed = parseManualInput(input);
  if (!parsed.ok) return null;
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) return null;
  const riverBetRec = gate.state.actions.filter((a) => a.street === 'RIVER' && a.amount > 0).at(-1);
  if (riverBetRec === undefined) return null;
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
  const r = analyzeManualHand(input, OPTIONS);
  return {
    ratio: riverBetRec.amount / riverBetRec.potBefore,
    potBefore: riverBetRec.potBefore, amount: riverBetRec.amount, bucket,
    eq: r.ok ? (r.decision.diagnostics.math.heroEquity ?? 0) : 0,
    bluff: m?.['bluffMass'] ?? 0, missed: m?.['missedDrawMass'] ?? 0,
  };
}

console.log('################ 0. 权威比例：state.actions 的 (amount, potBefore) ################');
for (const bb of [3.42, 5.68, 7, 7.6, 11.38, 14.63]) {
  const o = measure('UNKNOWN', bb);
  if (o === null) { console.log(`  amountBB=${bb} ⇒ 无河牌下注记录`); continue; }
  console.log(
    `  amountBB=${String(bb).padEnd(7)} state.amount=${String(o.amount).padEnd(8)} potBefore=${String(o.potBefore).padEnd(8)} ` +
      `⇒ 权威比例=${o.ratio.toFixed(6)} ⇒ 源码档=${BetSizeBucketOf(o.ratio).padEnd(8)} 引擎 trace 档=${o.bucket}`,
  );
}
const ref = measure('UNKNOWN', 7)!;
console.log(`\n  ⇒ 参考手（BB bet 7）的**权威比例 = ${ref.ratio.toFixed(6)}**（= ${(ref.ratio * 100).toFixed(2)}% 池）⇒ ${BetSizeBucketOf(ref.ratio)}`);
console.log(`  ⇒ 若按「7 进 19.5」算会得 ${(7 / 19.5).toFixed(6)}（36%），与引擎实际口径**不符**。`);

console.log('\n################ 1. 三个阈值在似然模型里是否真的起作用（MANIAC / CALLING_STATION）################');
console.log('目标比例   源档      权益(MANIAC)  权益(CS)   Δ(pp)    MANIAC 诈唬   missed      trace档');
for (const ratio of [0.30, 0.3995, 0.401, 0.5995, 0.601, 1.2484, 1.25, 2.0]) {
  const amountBB = ratio * ref.potBefore;
  const m = measure('MANIAC', amountBB);
  const c = measure('CALLING_STATION', amountBB);
  if (m === null || c === null) { console.log(`  ${ratio} ⇒ 失败`); continue; }
  console.log(
    `${String(ratio).padEnd(11)}${BetSizeBucketOf(m.ratio).padEnd(10)}${(m.eq * 100).toFixed(6).padEnd(14)}${(c.eq * 100).toFixed(6).padEnd(10)}` +
      `${((m.eq - c.eq) * 100).toFixed(6).padEnd(9)}${(m.bluff * 100).toFixed(4).padEnd(14)}${(m.missed * 100).toFixed(4).padEnd(12)}${m.bucket}`,
  );
}
