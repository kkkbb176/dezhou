import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const A = (p: string, t: string, a?: number, s?: string) => ({ position: p, type: t, ...(a === undefined ? {} : { amountBB: a }), ...(s === undefined ? {} : { street: s }) });
const S9 = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };
const S_STATION = { handsObserved: 2000, vpip: 0.55, pfr: 0.12, threeBet: 0.03, wtsd: 0.42, foldToFlopCBet: 0.3, foldToTurnCBet: 0.28, foldToRiverBet: 0.25, flopCheckRaise: 0.05, turnCheckRaise: 0.04, riverCheckRaise: 0.03 };
const S_FOLDER = { ...S_STATION, vpip: 0.22, pfr: 0.16, wtsd: 0.18, foldToFlopCBet: 0.7, foldToTurnCBet: 0.65, foldToRiverBet: 0.72 };
const mk = (villain: any) => ({ tableSize: 9, heroPosition: 'BTN', heroCards: ['As','5s'], board: ['Kd','Qh','8c','3s','2d'], street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 100, seatStacksBB: S9,
  actionHistory: [A('UTG','FOLD'),A('UTG1','FOLD'),A('UTG2','FOLD'),A('LJ','FOLD'),A('HJ','FOLD'),A('CO','FOLD'),A('BTN','RAISE',3),A('SB','FOLD'),A('BB','CALL',2),
    A('BB','CHECK',undefined,'FLOP'),A('BTN','CHECK',undefined,'FLOP'),A('BB','CHECK',undefined,'TURN'),A('BTN','CHECK',undefined,'TURN'),A('BB','CHECK',undefined,'RIVER')],
  environment: 'MID_LOW_STAKES', villain }) as any;
console.log('河牌纯空气：动作与**建议尺寸**是否随对手类型变？');
for (const [tag, v] of [
  ['① 无画像', {}],
  ['② 跟注站(wtsd42/vpip55)', { observedStats: S_STATION, seatId: 'seat_BB', persistentPlayerId: 'p_bb', stackBB: 100 }],
  ['③ 会弃型(wtsd18/vpip22)', { observedStats: S_FOLDER, seatId: 'seat_BB', persistentPlayerId: 'p_bb', stackBB: 100 }],
  ['④ 标签 CALLING_STATION', { quickProfile: 'CALLING_STATION' }],
  ['⑤ 标签 VERY_TIGHT', { quickProfile: 'VERY_TIGHT' }],
] as any[]) {
  const r = analyzeManualHand(mk(v), { rules: RULES, writeLog: false, equitySeed: 20260913, budget: { softMs: 300000, hardMs: 600000 } });
  if (!r.ok) { console.log(tag, 'FAIL', r.stage); continue; }
  const bd: any = (r.decision.diagnostics as any).postflop?.betDecision ?? {};
  const sizes: any[] = bd.sizes ?? [];
  const last = sizes[sizes.length - 1] ?? {};
  console.log(tag.padEnd(26), '动作=' + String(r.decision.action).padEnd(6), '尺寸=' + String(r.decision.sizeBB?.toFixed(2) ?? '—').padEnd(6),
    'P(弃)max=' + ((last.foldLikelihood ?? NaN)*100).toFixed(1) + '%', ' CHECK=' + Number(bd.checkEV ?? 0).toFixed(1), ' bestSize=' + String(bd.bestSize ?? '—'));
}
