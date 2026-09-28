import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { RAISE_COMBO_MEMO_STATS } from '../src/app/manualInput/raiseResponse.ts';
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
RAISE_COMBO_MEMO_STATS.hits = 0; RAISE_COMBO_MEMO_STATS.misses = 0;
const t0 = Date.now();
buildDecisionContext({ state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1757000000000,
  quickProfile: 'VERY_TIGHT', observedStats: STATS, equitySeed: 20260913, budget: { softMs: 60000, hardMs: 120000 } } as any);
console.log('wall =', Date.now() - t0, 'ms');
console.log('缓存 命中 =', RAISE_COMBO_MEMO_STATS.hits, ' 未命中(实算) =', RAISE_COMBO_MEMO_STATS.misses,
  ' ⇒ 去重率 =', ((RAISE_COMBO_MEMO_STATS.hits / Math.max(1, RAISE_COMBO_MEMO_STATS.hits + RAISE_COMBO_MEMO_STATS.misses)) * 100).toFixed(1) + '%');
