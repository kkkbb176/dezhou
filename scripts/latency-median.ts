import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
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
const times: number[] = []; const rr: number[] = [];
let hits = 0, misses = 0;
const origGet = Map.prototype.get;
const origSet = Map.prototype.set;
(Map.prototype as any).get = function (k: any) { if (typeof k === 'string' && k.includes(':')) { const v = origGet.call(this, k); if (v === undefined) misses++; else hits++; } return origGet.call(this, k); };
for (let i = 0; i < 5; i++) {
  const t0 = Date.now();
  const built: any = buildDecisionContext({ state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1757000000000,
    quickProfile: 'VERY_TIGHT', observedStats: STATS, equitySeed: 20260913, budget: { softMs: 60000, hardMs: 120000 } } as any);
  times.push(Date.now() - t0);
  rr.push(built.context.timings?.raiseResponse ?? 0);
}
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log('wall  5 次:', times.join(', '), '→ 中位', med(times) + 'ms');
console.log('raiseResponse 5 次:', rr.join(', '), '→ 中位', med(rr) + 'ms');

