/**
 * FLOP & RIVER AUDIT V1 · 焦点探针 ③（只读）：对手**下注尺寸**事实（含超池是否被封顶）
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parseManualInput, type ManualHandInput, type ManualVillain } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const A_ = (p: string, t: string, bb?: number, s?: string): Record<string, unknown> => ({
  position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }), ...(s === undefined ? {} : { street: s }),
});
const S100 = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };
const PF = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];
const F = [A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP')];
const T = [A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN')];
const V: ManualVillain = { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain;
const j = (v: unknown): string => JSON.stringify(v) ?? 'undefined';

const CASES: ReadonlyArray<readonly [string, number]> = [
  ['河牌第 3 枪 50% 池（对照）', 17.25],   // 69 × 0.25 = 17.25 ⇒ bet 69×0.5=34.5? 用 34.5 表示 50% 池
  ['河牌第 3 枪 100% 池', 69],
  ['河牌第 3 枪 120% 池（R-05）', 41.5],
  ['河牌第 3 枪 200% 池（超池）', 69],
];
const REAL: ReadonlyArray<readonly [string, number]> = [
  ['对照：50% 池（34.5 筹码）', 17.25],
  ['对照：100% 池（69 筹码）', 34.5],
  ['R-05：120% 池（82.8→83 筹码）', 41.5],
  ['超池：200% 池（138 筹码）', 69],
];
for (const [tag, betBB] of REAL) {
  const input = {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: S100, villain: V, environment: 'MID_LOW_STAKES',
    actionHistory: [...PF, ...F, ...T, A_('BB', 'BET', betBB, 'RIVER')],
  } as unknown as ManualHandInput;
  const p = parseManualInput(input);
  if (!p.ok) { console.log(`${tag} ✖ 解析失败`); continue; }
  const g = buildAnalyzableState(p.value);
  if (!g.ok) { console.log(`${tag} ✖ 状态失败`); continue; }
  const built = buildDecisionContext({
    state: g.state, rules: OPTIONS.rules, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
    quickProfile: 'NORMAL' as never, equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
  } as never) as unknown as Record<string, any>;
  const ctx = built['context'] as Record<string, any>;
  const pot = ctx['math']['pot'] as number;
  const callCost = ctx['math']['callCost'] as number;
  const facts = (ctx['postflopFacts'] ?? {}) as Record<string, any>;
  console.log('='.repeat(112));
  console.log(`## ${tag}  ⇒ 实际下注额=${String(betBB * 2)} 筹码 ｜ 下注后底池 pot=${String(pot)} ｜ callCost=${String(callCost)} ｜ 实际下注/下注前底池=${(betBB * 2 / (pot - callCost)).toFixed(3)}`);
  console.log(`  betRangeArrival = ${j(facts['betRangeArrival'])}`);
  console.log(`  betRangeSizing  = ${j(facts['betRangeSizing'])}`);
  console.log(`  bettingRangeFacts = ${j(facts['bettingRangeFacts']).slice(0, 900)}`);
  console.log(`  opponentRangeFacts = ${j(facts['opponentRangeFacts']).slice(0, 600)}`);
}
console.log('='.repeat(112));
console.log('（焦点探针 ③ 结束，只读）');
