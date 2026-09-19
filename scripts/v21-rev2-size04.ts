/**
 * REV2 探针 ⑧：0.4 阈值是否死边界（SMALL vs MEDIUM，MANIAC / CALLING_STATION）
 * 用法：node --experimental-strip-types scripts/v21-rev2-size04.ts
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
const handOf = (a: string, bet: number): ManualHandInput => ({
  tableSize: 9, heroPosition: 'CO', heroCards: ['Ac', 'Jh'],
  board: ['Ad', '8s', '4s', '2c', 'Kd'], street: 'RIVER',
  effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS },
  actionHistory: [
    { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' }, { position: 'UTG2', type: 'FOLD' },
    { position: 'LJ', type: 'FOLD' }, { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5 }, { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'CALL', amountBB: 1.5 },
    { position: 'BB', type: 'CHECK', street: 'FLOP' }, { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CHECK', street: 'TURN' }, { position: 'CO', type: 'CHECK', street: 'TURN' },
    { position: 'BB', type: 'BET', amountBB: bet, street: 'RIVER' },
  ],
  environment: 'MID_LOW_STAKES', villain: { stackBB: 100, quickProfile: a },
} as unknown as ManualHandInput);

for (const [bet, label] of [[3.42, 'SMALL 目标 0.3684'], [4.8, 'MEDIUM 目标 0.5053'], [5.68, 'MEDIUM 目标 0.5789']] as const) {
  const input = handOf('MANIAC', bet);
  const parsed = parseManualInput(input);
  if (!parsed.ok) continue;
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) continue;
  const rec = gate.state.actions.filter((a) => a.street === 'RIVER' && a.amount > 0).at(-1)!;
  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
    budget: { softMs: 120_000, hardMs: 240_000 }, equitySeed: 20260913, quickProfile: 'MANIAC' as never,
  });
  const note = String(((built.context.range?.updateTrace ?? []).filter((t) => (t as unknown as Record<string, unknown>)['street'] === 'RIVER')[0] as unknown as Record<string, unknown> | undefined)?.['noteZh'] ?? '');
  const bucket = /(SMALL|MEDIUM|LARGE|OVERBET)\//.exec(note)?.[1] ?? '?';
  const masses = (built.context.postflopFacts?.opponentRangeFacts as unknown as Record<string, any> | null)?.['profileClassMasses'] as Record<string, number> | undefined;
  const r = analyzeManualHand(input, OPTIONS);
  const eq = r.ok ? (r.decision.diagnostics.math.heroEquity ?? 0) : 0;
  const csBuilt = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
    budget: { softMs: 120_000, hardMs: 240_000 }, equitySeed: 20260913, quickProfile: 'CALLING_STATION' as never,
  });
  const csR = analyzeManualHand(handOf('CALLING_STATION', bet), OPTIONS);
  console.log(
    `${label.padEnd(22)} amount=${rec.amount} 比例=${(rec.amount / rec.potBefore).toFixed(6)} 源码档=${BetSizeBucketOf(rec.amount / rec.potBefore).padEnd(7)} trace档=${bucket.padEnd(7)}` +
      ` MANIAC权益=${(eq * 100).toFixed(6)}% 诈唬=${((masses?.['bluffMass'] ?? 0) * 100).toFixed(4)}%` +
      ` ｜ CS权益=${csR.ok ? ((csR.decision.diagnostics.math.heroEquity ?? 0) * 100).toFixed(6) : '—'}%`,
  );
  void csBuilt;
}
