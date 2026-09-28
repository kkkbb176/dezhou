/**
 * P0 diagnostic：加注分桶权益**实际用的是 EXACT 还是 MONTE_CARLO**、迭代数多少。
 *
 * 为什么要问：
 * 调用点显式给了 `iterations: RESPONSE_EQUITY_ITERATIONS = 6000`（注释也写着
 * 「响应模型一次要算 3 尺寸 × 2 桶 = 6 次」⇒ 显然是**抽样**预算），
 * 但实测每一次调用要 **66ms** —— 6000 次抽样不可能要 66ms。
 * 假设：权益门面在 `matchups <= DEFAULT_MAX_EXACT_MATCHUPS(500_000)` 时
 * **静默升级为精确枚举**，把调用方给的 6000 预算忽略了。
 */
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const pre = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});
const F = (p: string, t: string, a?: number): Record<string, unknown> => pre(p, t, a, 'FLOP');
const STATS = {
  handsObserved: 2000, vpip: 0.11, pfr: 0.07, threeBet: 0.03, wtsd: 0.2,
  foldToFlopCBet: 0.72, foldToTurnCBet: 0.6, foldToRiverBet: 0.65,
  flopCheckRaise: 0.06, turnCheckRaise: 0.05, riverCheckRaise: 0.04,
} as const;

const input = {
  tableSize: 9, heroPosition: 'BTN', heroCards: ['Kh', 'Qh'], board: ['Qs', 'Js', '8s'], street: 'FLOP',
  effectiveStackBB: 100, bigBlindBB: 100,
  seatStacksBB: { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  actionHistory: [
    pre('UTG', 'FOLD'), pre('UTG1', 'FOLD'), pre('UTG2', 'FOLD'), pre('LJ', 'FOLD'), pre('HJ', 'FOLD'),
    pre('CO', 'RAISE', 3), pre('BTN', 'CALL', 3), pre('SB', 'FOLD'), pre('BB', 'FOLD'), F('CO', 'BET', 5),
  ],
  environment: 'MID_LOW_STAKES',
  villain: {
    seatId: 'seat_CO', persistentPlayerId: 'p_v', stackBB: 100, quickProfile: 'VERY_TIGHT',
    observedStats: STATS,
  },
} as unknown as Parameters<typeof parseManualInput>[0];

const parsed = parseManualInput(input);
if (!parsed.ok) throw new Error('parse failed');
const gate = buildAnalyzableState(parsed.value);
if (!gate.ok) throw new Error('gate failed');
const built = buildDecisionContext({
  state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
  quickProfile: 'VERY_TIGHT', observedStats: STATS,
  equitySeed: 20_260_913, budget: { softMs: 60_000, hardMs: 120_000 },
} as never);
const pf = (built.context as unknown as Record<string, any>)['postflopFacts'] as Record<string, any>;
const all = (pf['raiseResponseAll'] ?? []) as readonly Record<string, any>[];

console.log(`raiseResponseAll 档位数 = ${all.length}`);
for (const s of all) {
  console.log(
    `  档 sizeChips=${String(s['sizeChips']).padEnd(6)}` +
    ` 方法=${String(s['equityMethod'] ?? '—').padEnd(11)}` +
    ` 迭代=${String(s['equityIterations'] ?? '—').padEnd(8)}` +
    ` 跟注桶权益=${s['heroEquityVsRaiseCallRange']?.value ?? '—'}  (方法 ${s['heroEquityRaiseCallRangeMethod'] ?? s['heroEquityVsRaiseCallRange']?.method ?? '—'})`,
  );
}
const t = (built.context as unknown as Record<string, any>)['timings'] as Record<string, number>;
console.log('');
console.log(`timings: raiseResponse=${t['raiseResponse']}ms raiseComboClassify=${t['raiseComboClassify']}ms raiseBucketEquity=${t['raiseBucketEquity']}ms`);
console.log(`         equity=${t['equity']}ms range=${t['range']}ms total=${t['total']}ms`);
