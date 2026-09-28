// 统计「面对下注」节点里到底跑了多少次权益计算、每次多少迭代
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import * as equityMod from '../src/domain/poker/equity.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const pre = (position: string, type: string, amountBB?: number, street?: string) => ({ position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }) });
const F = (p: string, t: string, a?: number) => pre(p, t, a, 'FLOP');
const STATS = { handsObserved: 2000, vpip: 0.11, pfr: 0.07, threeBet: 0.03, wtsd: 0.2, foldToFlopCBet: 0.72, foldToTurnCBet: 0.6, foldToRiverBet: 0.65, flopCheckRaise: 0.06, turnCheckRaise: 0.05, riverCheckRaise: 0.04 };
const input = { tableSize: 9, heroPosition: 'BTN', heroCards: ['Kh','Qh'], board: ['Qs','Js','8s'], street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 100,
  seatStacksBB: { UTG:100,UTG1:100,UTG2:100,LJ:100,HJ:100,CO:100,BTN:100,SB:100,BB:100 },
  actionHistory: [pre('UTG','FOLD'),pre('UTG1','FOLD'),pre('UTG2','FOLD'),pre('LJ','FOLD'),pre('HJ','FOLD'),pre('CO','RAISE',3),pre('BTN','CALL',3),pre('SB','FOLD'),pre('BB','FOLD'),F('CO','BET',5)],
  environment: 'MID_LOW_STAKES',
  villain: { seatId: 'seat_CO', persistentPlayerId: 'p_v', stackBB: 100, quickProfile: 'VERY_TIGHT', observedStats: STATS } } as any;
const parsed: any = parseManualInput(input);
const gate: any = buildAnalyzableState(parsed.value);
// 打桩：统计 computeEquity 调用
const orig = (equityMod as any).computeEquity;
let calls = 0, iters = 0; const perCall: { n: number; method: string }[] = [];
if (typeof orig === 'function') {
  (equityMod as any).computeEquity = (...args: any[]) => {
    calls += 1;
    const t0 = Date.now();
    const res = orig(...args);
    const ms = Date.now() - t0;
    const n = res?.value?.iterations ?? res?.iterations ?? 0;
    iters += n;
    perCall.push({ n: ms, method: String(res?.value?.method ?? res?.method ?? '?') });
    return res;
  };
}
const t0 = Date.now();
buildDecisionContext({ state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1757000000000,
  quickProfile: 'VERY_TIGHT', observedStats: STATS, equitySeed: 20260913, budget: { softMs: 60000, hardMs: 120000 } } as any);
const wall = Date.now() - t0;
console.log('computeEquity 调用次数 =', calls, ' 总迭代 =', iters, ' wall =', wall + 'ms');
const slow = perCall.map((c, i) => ({ i, ms: c.n, m: c.method })).sort((a, b) => b.ms - a.ms);
console.log('最慢的 8 次（序号, 耗时ms, 方法）:', JSON.stringify(slow.slice(0, 8)));
console.log('单次中位耗时 ≈', slow.length ? slow[Math.floor(slow.length/2)].ms + 'ms' : '—');
