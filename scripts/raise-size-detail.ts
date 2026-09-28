import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
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
const t0 = Date.now();
const r = analyzeManualHand(input, { rules: RULES, writeLog: false, equitySeed: 20260913, budget: { softMs: 300000, hardMs: 600000 } });
const wall = Date.now() - t0;
if (!r.ok) { console.log('FAIL', r.stage); process.exit(1); }
const pf: any = (r.decision.diagnostics as any).postflop ?? {};
const pr: any = pf.raiseResponse ?? {};
console.log('wall =', wall + 'ms');
console.log('raiseResponse 档位数 =', (pr.sizes ?? []).length);
for (const s of (pr.sizes ?? [])) {
  console.log('  档', String(s.sizeBB ?? s.sizeChips).padEnd(8),
    'sizeChips=', String(s.sizeChips).padEnd(6),
    '弃/跟/再加注=', `${(s.foldLikelihood*100).toFixed(1)}/${(s.callLikelihood*100).toFixed(1)}/${(s.reRaiseLikelihood*100).toFixed(1)}`,
    '| 跟注桶权益=', s.heroEquityVsRaiseCallRange?.value ?? '—',
    '| 方法=', s.heroEquityVsRaiseCallRange?.method ?? '—',
    '| 迭代=', s.heroEquityVsRaiseCallRange?.iterations ?? '—');
}
console.log('');
console.log('equity 计时 =', ((r.timings as any).equity ?? '—'), 'ms  raiseResponse =', ((r.timings as any).raiseResponse ?? '—'), 'ms');
