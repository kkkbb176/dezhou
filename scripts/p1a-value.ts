import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const A_ = (p: string, t: string, bb?: number, s?: string) => ({ position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }), ...(s === undefined ? {} : { street: s }) });
const HISTORY_TURN_BET = [A_('UTG','FOLD'),A_('HJ','FOLD'),A_('CO','FOLD'),A_('BTN','RAISE',3),A_('SB','FOLD'),A_('BB','CALL',2),
  A_('BB','CHECK',undefined,'FLOP'),A_('BTN','BET',4,'FLOP'),A_('BB','CALL',4,'FLOP'),A_('BB','BET',10,'TURN')];
const MANIAC_800 = { seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
  observedStats: { handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null } };
const input = { tableSize: 6, heroPosition: 'BTN', heroCards: ['9h','9c'], board: ['Jd','8c','4c','6s'], street: 'TURN', effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG:100,HJ:100,CO:100,BTN:100,SB:100,BB:100 }, environment: 'MID_LOW_STAKES', actionHistory: HISTORY_TURN_BET, villain: MANIAC_800 } as any;
const r = analyzeManualHand(input, { rules: RULES, asOf: 1757000000000, writeLog: false, equitySeed: 20260913, budget: { softMs: 120000, hardMs: 240000 } });
if (!r.ok) { console.log('FAIL', r.stage); process.exit(1); }
const m = r.decision.diagnostics.math;
console.log('callEV =', m.callEV);
console.log('eqBetRange =', m.heroEquityVsBetRange);
console.log('eqArrival =', m.heroEquity);
