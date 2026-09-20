/**
 * 只读探针 0：复现「AK 面对河牌下注，EqVsBetRange = 0.54%」
 * 只打印结构与关键数字，不改产品代码。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const ASOF = 1_757_000_000_000;
const H = (p: string, t: string, a?: number, s?: string) => ({
  position: p, type: t, ...(a === undefined ? {} : { amountBB: a }), ...(s === undefined ? {} : { street: s }),
});

const FACING_BET = [
  H('UTG', 'FOLD'), H('HJ', 'FOLD'), H('CO', 'FOLD'), H('BTN', 'RAISE', 3), H('SB', 'FOLD'), H('BB', 'CALL', 2),
  H('BB', 'CHECK', undefined, 'FLOP'), H('BTN', 'BET', 2.5, 'FLOP'), H('BB', 'CALL', 2.5, 'FLOP'),
  H('BB', 'CHECK', undefined, 'TURN'), H('BTN', 'BET', 7.5, 'TURN'), H('BB', 'CALL', 7.5, 'TURN'),
  H('BB', 'BET', 20, 'RIVER'),
];

function mk(opts: {
  bb: number; history: readonly Record<string, unknown>[]; heroCards: [string, string];
  profile: string; stats: Record<string, number> | null; street?: string;
}) {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: opts.heroCards,
    board: ['Kd', '9c', '4h', '6s', '2d'], street: opts.street ?? 'RIVER',
    effectiveStackBB: 100, bigBlindBB: opts.bb,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: opts.history.map((x) => ({ ...x })), environment: 'MID_LOW_STAKES',
    villain: { quickProfile: opts.profile, dynamicHint: 'UNKNOWN', stackBB: 100, ...(opts.stats === null ? {} : { observedStats: opts.stats }) },
  } as unknown as ManualHandInput;
}

const input = mk({ bb: 2, history: FACING_BET, heroCards: ['As', 'Ks'], profile: 'CALLING_STATION', stats: null });
const parsed = parseManualInput(input);
if (!parsed.ok) { console.log('PARSE FAIL', JSON.stringify(parsed.issues, null, 2)); process.exit(1); }
const gate = buildAnalyzableState(parsed.value);
if (!gate.ok) { console.log('GATE FAIL', gate.stage, JSON.stringify(gate.issues, null, 2)); process.exit(1); }

console.log('=== state ===');
console.log('street', gate.state.street, 'pot', JSON.stringify(gate.state.actions[gate.state.actions.length - 1]));
console.log('actions:', gate.state.actions.map((a) => `${a.street}:${a.playerId}:${a.type}:${a.amount}(potBefore=${a.potBefore})`).join(' | '));

const built = buildDecisionContext({
  state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: ASOF,
  quickProfile: 'CALLING_STATION' as never, equitySeed: 20_261_014,
});
const ctx = built.context as unknown as Record<string, any>;
console.log('\n=== context.math ===');
console.log(JSON.stringify({
  pot: ctx['math'].pot, callCost: ctx['math'].callCost, winnable: ctx['math'].winnable,
  requiredEquity: ctx['math'].requiredEquity, heroEquity: ctx['math'].heroEquity,
  heroEquityVsBetRange: ctx['math'].heroEquityVsBetRange, callEV: ctx['math'].callEV,
}, null, 2));

console.log('\n=== context.range (snapshot) ===');
console.log(JSON.stringify(ctx['range'], null, 2).slice(0, 4000));

console.log('\n=== opponentRanges ===');
console.log(JSON.stringify((ctx['opponentRanges'] ?? []).map((r: any) => ({
  opponentId: r.opponentId, supportSize: r.supportSize, metrics: r.metrics, sourceId: r.sourceId,
  updateTrace: r.updateTrace,
})), null, 2).slice(0, 8000));

console.log('\n=== postflopFacts keys ===');
console.log(Object.keys(ctx['postflopFacts'] ?? {}));
console.log(JSON.stringify(ctx['postflopFacts']?.['opponentRangeFacts'] ?? null, null, 2).slice(0, 6000));

console.log('\n=== profileV3 ===');
console.log(JSON.stringify({
  baseArchetype: ctx['profileV3']?.baseArchetype,
  actionContext: ctx['profileV3']?.actionContext,
  denied: ctx['profileV3']?.deniedStreetTraits,
  dimensions: ctx['profileV3']?.dimensions,
  resolved: ctx['profileV3']?.resolvedDimensions,
  base: ctx['profileV3']?.baseDimensions,
}, null, 2));

const r = analyzeManualHand(input, { rules: RULES, asOf: ASOF, writeLog: false, equitySeed: 20_261_014, budget: { softMs: 120_000, hardMs: 240_000 } });
if (!r.ok) { console.log('ANALYZE FAIL', r.stage, JSON.stringify(r.issues)); process.exit(1); }
const d = r.decision as unknown as Record<string, any>;
console.log('\n=== decision ===');
console.log(JSON.stringify({ action: d['action'], sizeChips: d['sizeChips'], diagnosticsKeys: Object.keys(d['diagnostics'] ?? {}) }, null, 2));
const diag = d['diagnostics'] as Record<string, any>;
console.log('math:', JSON.stringify(diag['math'], null, 2).slice(0, 3000));
console.log('postflop keys:', Object.keys(diag['postflop'] ?? {}));
const bd = diag['postflop']?.['betDecision'];
console.log('betDecision keys:', bd ? Object.keys(bd) : null);
console.log('checkTree:', JSON.stringify(bd?.['checkTree'] ?? null, null, 2).slice(0, 3000));
