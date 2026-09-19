/**
 * V2.1：为何画像不影响权益？—— 最小对照（只改画像，其余逐位相同）
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { behaviorProfileOf, BehaviorTraitKey } from '../src/domain/player/behaviorProfile.ts';
import type { PlayerBehaviorProfile } from '../src/domain/player/behaviorProfile.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  budget: { softMs: 120_000, hardMs: 240_000 }, equitySeed: 20260913,
} as const;

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

function make(quickProfile: string, bp: PlayerBehaviorProfile | undefined): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'CO', heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS9 },
    actionHistory: HISTORY.map((h) => ({ ...h })),
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile, dynamicHint: 'UNKNOWN', stackBB: 100, ...(bp === undefined ? {} : { behaviorProfile: bp }) },
  } as unknown as ManualHandInput;
}

const CASES: readonly { id: string; quickProfile: string; bp: PlayerBehaviorProfile | undefined }[] = [
  { id: 'A_UNKNOWN_noProfile', quickProfile: 'UNKNOWN', bp: undefined },
  { id: 'B_NORMAL_tagDerived', quickProfile: 'NORMAL', bp: undefined },
  { id: 'C_CALLING_STATION_tagDerived', quickProfile: 'CALLING_STATION', bp: undefined },
  { id: 'D_MANIAC_tagDerived', quickProfile: 'MANIAC', bp: undefined },
  {
    id: 'E_MANIAC_explicitProfile',
    quickProfile: 'MANIAC',
    bp: behaviorProfileOf({ playerId: 'v', archetype: 'MANIAC' as never }),
  },
  {
    id: 'F_MANIAC_observed45of50',
    quickProfile: 'MANIAC',
    bp: behaviorProfileOf({
      playerId: 'v', archetype: 'MANIAC' as never,
      observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 45, opportunities: 50 } } as never,
    }),
  },
  {
    id: 'G_NORMAL_observed45of50',
    quickProfile: 'NORMAL',
    bp: behaviorProfileOf({
      playerId: 'v', archetype: 'NORMAL' as never,
      observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 45, opportunities: 50 } } as never,
    }),
  },
];

console.log(
  '  id'.padEnd(32) + '动作'.padEnd(7) + '权益'.padEnd(10) + '所需'.padEnd(9) +
  '跟注EV'.padEnd(11) + '诈唬质量'.padEnd(11) + '组合前→后'.padEnd(14) + 'equityBefore→After',
);
for (const c of CASES) {
  const input = make(c.quickProfile, c.bp);
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { console.log(`  ${c.id} FAIL ${JSON.stringify(r.issues)}`); continue; }
  const m = r.decision.diagnostics.math;

  const parsed = parseManualInput(input);
  let bluff = '—', combos = '—', ev = '';
  if (parsed.ok) {
    console.log(`      [parsed villain keys] ${Object.keys(parsed.value.villain).join(',')}`);
    const gate = buildAnalyzableState(parsed.value);
    if (gate.ok) {
      const built = buildDecisionContext({
        state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
        budget: { softMs: 120_000, hardMs: 240_000 }, equitySeed: 20260913,
        quickProfile: c.quickProfile as never,
        ...(c.bp === undefined ? {} : { behaviorProfile: c.bp }),
      });
      const pc = (built.context.postflopFacts?.opponentRangeFacts as unknown as {
        profileClassMasses?: { bluffMass: number } | null;
      } | undefined)?.profileClassMasses ?? null;
      bluff = pc === null ? '—' : (pc.bluffMass * 100).toFixed(2) + '%';
      const pe = built.context.profileRangeEvidence;
      combos = pe === undefined ? '—' : `${pe.combosBefore}→${pe.combosAfter}`;
      if (pe !== undefined) {
        ev = `${pe.equityBefore === null ? '—' : (pe.equityBefore * 100).toFixed(2) + '%'}→` +
          `${pe.equityAfter === null ? '—' : (pe.equityAfter * 100).toFixed(2) + '%'}`;
      }
    }
  }
  console.log(
    `  ${c.id.padEnd(30)}${String(r.decision.action).padEnd(7)}` +
    `${((m.heroEquity ?? 0) * 100).toFixed(3).padStart(6)}%   ` +
    `${(m.requiredEquity * 100).toFixed(2).padStart(5)}%  ` +
    `${(m.callEV ?? 0).toFixed(3).padStart(8)}  ` +
    `${bluff.padStart(7)}    ${combos.padEnd(12)}  ${ev}`,
  );
}
