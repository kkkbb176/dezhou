import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const pre = (position: string, type: string, amountBB?: number, street?: string) => ({ position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }) });
const F = (p: string, t: string, a?: number) => pre(p, t, a, 'FLOP');
const STATS = { handsObserved: 2000, vpip: 0.11, pfr: 0.07, threeBet: 0.03, wtsd: 0.2, foldToFlopCBet: 0.72, foldToTurnCBet: 0.6, foldToRiverBet: 0.65, flopCheckRaise: 0.06, turnCheckRaise: 0.05, riverCheckRaise: 0.04 };
const S9 = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };
const CASES: any[] = [
  ['翻牌·面对2/3池', { heroCards: ['Kh','Qh'], board: ['Qs','Js','8s'],
    actionHistory: [pre('UTG','FOLD'),pre('UTG1','FOLD'),pre('UTG2','FOLD'),pre('LJ','FOLD'),pre('HJ','FOLD'),pre('CO','RAISE',3),pre('BTN','CALL',3),pre('SB','FOLD'),pre('BB','FOLD'),F('CO','BET',5)] }],
  ['翻牌·他过牌给我', { heroCards: ['As','5s'], board: ['Ks','7h','2c'],
    actionHistory: [pre('UTG','FOLD'),pre('UTG1','FOLD'),pre('UTG2','FOLD'),pre('LJ','FOLD'),pre('HJ','FOLD'),pre('CO','RAISE',3),pre('BTN','CALL',3),pre('SB','FOLD'),pre('BB','FOLD'),F('CO','CHECK')] }],
  ['翻牌·面对2/3池(无画像)', { heroCards: ['Kh','Qh'], board: ['Qs','Js','8s'],
    actionHistory: [pre('UTG','FOLD'),pre('UTG1','FOLD'),pre('UTG2','FOLD'),pre('LJ','FOLD'),pre('HJ','FOLD'),pre('CO','RAISE',3),pre('BTN','CALL',3),pre('SB','FOLD'),pre('BB','FOLD'),F('CO','BET',5)], noProfile: true }],
];
for (const [tag, base] of CASES as any[]) {
  const { noProfile, ...rest } = base;
  const input = { tableSize: 9, heroPosition: 'BTN', street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 100, seatStacksBB: S9, environment: 'MID_LOW_STAKES', ...rest,
    villain: noProfile ? undefined : { seatId: 'seat_CO', persistentPlayerId: 'p_v', stackBB: 100, quickProfile: 'VERY_TIGHT', observedStats: STATS } } as any;
  const parsed: any = parseManualInput(input);
  if (!parsed.ok) { console.log(tag, 'PARSE FAIL'); continue; }
  const gate: any = buildAnalyzableState(parsed.value);
  if (!gate.ok) { console.log(tag, 'GATE FAIL', JSON.stringify(gate.issues).slice(0,110)); continue; }
  const t0 = Date.now();
  const built: any = buildDecisionContext({ state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1757000000000,
    ...(noProfile ? {} : { quickProfile: 'VERY_TIGHT', observedStats: STATS }), equitySeed: 20260913, budget: { softMs: 60000, hardMs: 120000 } } as any);
  const wall = Date.now() - t0;
  const tm: any = built.context.timings ?? {};
  const inner = Object.entries(tm).sort((a: any, b: any) => b[1]-a[1]).map(([k,v]) => `${k}=${v}`).join('  ');
  console.log(tag.padEnd(24), ('wall=' + wall + 'ms').padEnd(13), inner);
}
