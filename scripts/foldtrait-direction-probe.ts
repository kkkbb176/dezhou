import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const pre = (position: string, type: string, amountBB?: number, street?: string) => ({ position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }) });
const F = (p: string, t: string, a?: number) => pre(p, t, a, 'FLOP');
const base = { vpip: 0.3, pfr: 0.15, threeBet: 0.04, wtsd: 0.3, flopCheckRaise: 0.06 };
function node(f: number | null) {
  return { tableSize: 9, heroPosition: 'BTN', heroCards: ['As','5s'], board: ['Ks','7h','2c'], street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 100,
    seatStacksBB: { UTG:100,UTG1:100,UTG2:100,LJ:100,HJ:100,CO:100,BTN:100,SB:100,BB:100 },
    actionHistory: [pre('UTG','FOLD'),pre('UTG1','FOLD'),pre('UTG2','FOLD'),pre('LJ','FOLD'),pre('HJ','FOLD'),pre('CO','RAISE',3),pre('BTN','CALL',3),pre('SB','FOLD'),pre('BB','FOLD'),F('CO','CHECK')],
    environment: 'MID_LOW_STAKES',
    villain: { seatId: 'seat_CO', persistentPlayerId: 'p_v', stackBB: 100, quickProfile: 'NORMAL',
      observedStats: { handsObserved: 2000, ...base, ...(f === null ? {} : { foldToFlopCBet: f }) } } } as any;
}
console.log('我下注（他过牌给我）→ 引擎算出的 P(他弃)、BetEV、我的动作');
for (const f of [null, 0.25, 0.5, 0.75, 0.9] as any[]) {
  const r = analyzeManualHand(node(f), { rules: RULES, writeLog: false, equitySeed: 20260913, budget: { softMs: 300000, hardMs: 600000 } });
  if (!r.ok) { console.log('f=', f, 'FAIL', r.stage); continue; }
  const bd: any = (r.decision.diagnostics as any).postflop?.betDecision ?? {};
  const sizes: any[] = bd.sizes ?? [];
  const last = sizes[sizes.length - 1] ?? {};
  console.log('  foldToFlopCBet=', String(f === null ? '未观测' : (f*100)+'%').padEnd(8),
    'P(他弃)=', ((last.foldLikelihood ?? NaN)*100).toFixed(1)+'%',
    ' BetEV=', Number(last.betEV ?? 0).toFixed(1),
    ' 我的动作=', r.decision.action, r.decision.sizeBB ?? '—');
}
