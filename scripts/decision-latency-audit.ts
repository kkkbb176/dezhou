import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const pre = (position: string, type: string, amountBB?: number, street?: string) => ({ position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }) });
const F = (p: string, t: string, a?: number) => pre(p, t, a, 'FLOP');
const T = (p: string, t: string, a?: number) => pre(p, t, a, 'TURN');
const R = (p: string, t: string, a?: number) => pre(p, t, a, 'RIVER');
const STATS = { handsObserved: 2000, vpip: 0.11, pfr: 0.07, threeBet: 0.03, wtsd: 0.2, foldToFlopCBet: 0.72, foldToTurnCBet: 0.6, foldToRiverBet: 0.65, flopCheckRaise: 0.06, turnCheckRaise: 0.05, riverCheckRaise: 0.04 };
const S9 = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };
const CASES: any[] = [
  ['翻前·面对开池', { tableSize: 9, heroPosition: 'BTN', heroCards: ['As','Qs'], board: [], street: 'PREFLOP',
    actionHistory: [pre('UTG','RAISE',3),pre('UTG1','FOLD'),pre('UTG2','FOLD'),pre('LJ','FOLD'),pre('HJ','FOLD'),pre('CO','FOLD')] }],
  ['翻牌·面对下注', { tableSize: 9, heroPosition: 'BTN', heroCards: ['Kh','Qh'], board: ['Qs','Js','8s'], street: 'FLOP',
    actionHistory: [pre('UTG','RAISE',3),pre('UTG1','FOLD'),pre('UTG2','FOLD'),pre('LJ','FOLD'),pre('HJ','FOLD'),pre('CO','FOLD'),pre('BTN','CALL',3),pre('SB','FOLD'),pre('BB','FOLD'),F('UTG','BET',5)] }],
  ['翻牌·他过牌给我', { tableSize: 9, heroPosition: 'BTN', heroCards: ['As','5s'], board: ['Ks','7h','2c'], street: 'FLOP',
    actionHistory: [pre('UTG','RAISE',3),pre('UTG1','FOLD'),pre('UTG2','FOLD'),pre('LJ','FOLD'),pre('HJ','FOLD'),pre('CO','FOLD'),pre('BTN','CALL',3),pre('SB','FOLD'),pre('BB','FOLD'),F('UTG','CHECK')] }],
  ['河牌·面对大注', { tableSize: 9, heroPosition: 'BTN', heroCards: ['Ah','Ad'], board: ['Ad','9c','4h','6s','2d'], street: 'RIVER',
    actionHistory: [pre('UTG','RAISE',3),pre('UTG1','FOLD'),pre('UTG2','FOLD'),pre('LJ','FOLD'),pre('HJ','FOLD'),pre('CO','FOLD'),pre('BTN','CALL',3),pre('SB','FOLD'),pre('BB','FOLD'),
      F('UTG','BET',5),F('BTN','CALL',5),T('UTG','BET',12),T('BTN','CALL',12),R('UTG','BET',30)] }],
];
for (const [tag, base] of CASES as any[]) {
  const input = { ...base, effectiveStackBB: 100, bigBlindBB: 100, seatStacksBB: S9, environment: 'MID_LOW_STAKES',
    villain: { seatId: 'seat_UTG', persistentPlayerId: 'p_v', stackBB: 100, quickProfile: 'VERY_TIGHT', observedStats: STATS } } as any;
  const t0 = Date.now();
  const r = analyzeManualHand(input, { rules: RULES, writeLog: false, equitySeed: 20260913, budget: { softMs: 300000, hardMs: 600000 } });
  const wall = Date.now() - t0;
  if (!r.ok) { console.log(tag.padEnd(18), 'FAIL', r.stage); continue; }
  const tm: any = r.timings;
  const inner = Object.entries(tm).filter(([k]) => !['parse','validate','context','decide','viewmodel','total'].includes(k))
    .sort((a: any, b: any) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(tag.padEnd(18), 'wall=' + String(wall).padStart(5) + 'ms', '| context=' + String(tm.context).padStart(5), '| 内层:', inner);
}
