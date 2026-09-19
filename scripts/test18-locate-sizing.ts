/** 只读小工具：定位 §七 尺寸近似报告（sizing）在 context 里的位置 */
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const OPTIONS = { rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false, equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 } } as const;
const A_ = (p: string, t: string, bb?: number, s?: string): Record<string, unknown> => ({ position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }), ...(s === undefined ? {} : { street: s }) });
const input = {
  tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN',
  effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  actionHistory: [
    A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
    A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
    A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
    A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'RAISE', 40, 'TURN'),
  ],
  environment: 'MID_LOW_STAKES',
  villain: { seatId: 'seat_BB', persistentPlayerId: 'player_001', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
    observedStats: { handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null } },
} as unknown as ManualHandInput;

const p = parseManualInput(input);
if (!p.ok) throw new Error('parse failed');
const g = buildAnalyzableState(p.value);
if (!g.ok) throw new Error('gate failed');
const built = buildDecisionContext({ state: g.state, rules: OPTIONS.rules, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', villainSeatId: 'seat_BB', villainPersistentPlayerId: 'player_001', observedStats: input.villain!.observedStats as never, equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget } as never);
const ctx = built.context as unknown as Record<string, any>;
console.log('context 里的 postflop/facts 相关键:', Object.keys(ctx).filter((k) => /postflop|fact|sizing/i.test(k)));
const pf = ctx['postflopFacts'] as Record<string, any> | undefined;
console.log('postflopFacts 键:', pf === undefined ? '(无)' : Object.keys(pf).join(', '));
console.log('postflopFacts.betRangeSizing =', JSON.stringify(pf?.['betRangeSizing']));
console.log('postflopFacts.bettingRangeFacts.sizing =', JSON.stringify((pf?.['bettingRangeFacts'] as Record<string, any> | undefined)?.['sizing']));
console.log('legal =', JSON.stringify(built.legal));

/* ---- 用户实际看到什么（界面文案）---- */
const { analyzeManualHand } = await import('../src/app/alphaPipeline.ts');
const r = analyzeManualHand(input, OPTIONS);
if (!r.ok) throw new Error('analyze failed');
const vm = r.viewModel as unknown as Record<string, any>;
console.log('\n=== 界面（用户实际看到）===');
for (const k of ['actionZh', 'sizeZh', 'confidenceZh', 'classificationZh', 'actionable']) {
  console.log(`  ${k} = ${JSON.stringify(vm[k])}`);
}
console.log('  warningsZh =', JSON.stringify(vm['warningsZh']));
const rows = (vm['debug']?.['math'] ?? []) as readonly { label: string; value: string }[];
for (const row of rows) console.log(`  行「${row.label}」= ${row.value.slice(0, 150)}`);
