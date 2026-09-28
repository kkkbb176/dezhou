import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const pre = (position: string, type: string, amountBB?: number, street?: string) => ({ position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }) });
const F = (p: string, t: string, a?: number) => pre(p, t, a, 'FLOP');
const base = { vpip: 0.3, pfr: 0.15, threeBet: 0.04, wtsd: 0.3, flopCheckRaise: 0.06 };
/** 对手下注 5BB，轮到我（可选择加注） */
function node(f: number | null) {
  return { tableSize: 9, heroPosition: 'BTN', heroCards: ['As','Qs'], board: ['Ks','7h','2c'], street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 100,
    seatStacksBB: { UTG:100,UTG1:100,UTG2:100,LJ:100,HJ:100,CO:100,BTN:100,SB:100,BB:100 },
    actionHistory: [pre('UTG','FOLD'),pre('UTG1','FOLD'),pre('UTG2','FOLD'),pre('LJ','FOLD'),pre('HJ','FOLD'),pre('CO','RAISE',3),pre('BTN','CALL',3),pre('SB','FOLD'),pre('BB','FOLD'),F('CO','BET',5)],
    environment: 'MID_LOW_STAKES',
    villain: { seatId: 'seat_CO', persistentPlayerId: 'p_v', stackBB: 100, quickProfile: 'NORMAL',
      observedStats: { handsObserved: 2000, ...base, ...(f === null ? {} : { foldToFlopCBet: f }) } } } as any;
}
console.log('他下注 5BB，轮到我（A♠Q♠）—— 加注分支的响应是否随 foldToFlopCBet 变？');
console.log('  foldToFlopCBet  | 加注档 弃/跟/再加注        | RAISE EV  | 我的动作');
for (const f of [null, 0.25, 0.5, 0.75, 0.9] as any[]) {
  const r = analyzeManualHand(node(f), { rules: RULES, writeLog: false, equitySeed: 20260913, budget: { softMs: 300000, hardMs: 600000 } });
  if (!r.ok) { console.log('  ', f, 'FAIL', r.stage); continue; }
  const pf: any = (r.decision.diagnostics as any).postflop ?? {};
  console.log('     tendencies街道刻度:', JSON.stringify({ streetBetScale: pf.raiseResponse?.tendencies?.streetBetScale, streetFoldScale: pf.raiseResponse?.tendencies?.streetFoldScale, callScale: pf.raiseResponse?.tendencies?.callScale }));
  const pr: any = pf.raiseResponse ?? null;
  const sizes: any[] = pr?.sizes ?? [];
  const last = sizes.length ? sizes[sizes.length - 1] : (pf.raiseResponse ?? {});
  const fl = last.foldLikelihood ?? last.fold ?? null;
  const cl = last.callLikelihood ?? last.call ?? null;
  const rr = last.reRaiseLikelihood ?? last.reraise ?? null;
  console.log('  ' + String(f === null ? '未观测' : (f*100)+'%').padEnd(15),
    '|', (`${fl === null ? '—' : (fl*100).toFixed(1)+'%'} / ${cl === null ? '—' : (cl*100).toFixed(1)+'%'} / ${rr === null ? '—' : (rr*100).toFixed(1)+'%'}`).padEnd(26),
    '|', String(last.raiseEV ?? '—').padEnd(9), '|', r.decision.action, r.decision.sizeBB ?? '—');
}

