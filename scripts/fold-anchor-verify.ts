import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const pre = (position: string, type: string, amountBB?: number, street?: string) => ({ position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }) });
const F = (p: string, t: string, a?: number) => pre(p, t, a, 'FLOP');
const T = (p: string, t: string, a?: number) => pre(p, t, a, 'TURN');
const R = (p: string, t: string, a?: number) => pre(p, t, a, 'RIVER');
const base = { vpip: 0.11, pfr: 0.07, threeBet: 0.03, wtsd: 0.2, foldToFlopCBet: 0.72, foldToTurnCBet: 0.6, flopCheckRaise: 0.06, turnCheckRaise: 0.05, riverCheckRaise: 0.04 };
function node(frb: number | null, hands: number) {
  return { tableSize: 6, heroPosition: 'BTN', heroCards: ['As','5s'], board: ['Ks','7h','2c','4d','Jh'], street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 100,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [pre('UTG','FOLD'),pre('HJ','FOLD'),pre('CO','FOLD'),pre('BTN','RAISE',2.5),pre('SB','FOLD'),pre('BB','CALL',1.5),
      F('BB','CHECK'),F('BTN','BET',2),F('BB','CALL',2),T('BB','CHECK'),T('BTN','BET',4),T('BB','CALL',4),R('BB','CHECK')],
    environment: 'MID_LOW_STAKES',
    villain: { seatId: 'seat_BB', persistentPlayerId: 'p_villain', stackBB: 100, quickProfile: 'VERY_TIGHT',
      observedStats: { handsObserved: hands, ...base, ...(frb === null ? {} : { foldToRiverBet: frb }) } } } as any;
}
function read(frb: number | null, hands: number): string {
  const r = analyzeManualHand(node(frb, hands), { rules: RULES, writeLog: false, equitySeed: 20260913, budget: { softMs: 300000, hardMs: 600000 } });
  if (!r.ok) return 'FAIL/' + r.stage;
  const bd: any = (r.decision.diagnostics as any).postflop?.betDecision ?? {};
  const sizes: any[] = bd.sizes ?? [];
  const last = sizes[sizes.length - 1] ?? {};
  const fa: any = last.foldAnchor ?? null;
  const anchorZh =
    fa === null
      ? '锚定[字段缺失]'
      : fa.measured === null
        ? `锚定[未启用 模型${(fa.modeled * 100).toFixed(1)}%]`
        : `锚定[实测${(fa.measured * 100).toFixed(0)}% 模型${(fa.modeled * 100).toFixed(1)}%→${(fa.applied * 100).toFixed(1)}% ${fa.clamped ? '**已夹**' : '未夹'}]`;
  return `P(弃)=${((last.foldLikelihood ?? NaN) * 100).toFixed(1)}% ΔEV=${Number(last.deltaVsCheck ?? 0).toFixed(1)} ${r.decision.action} ${anchorZh}`;
}
const lines: string[] = [];
lines.push('样本量 × foldToRiverBet（河牌纯空气 A5s，最大档 = 满池 17.5BB）');
for (const h of [2, 30, 200, 2000, 8000] as const) {
  lines.push(`hands=${String(h).padEnd(5)} 25%→${read(0.25, h).padEnd(76)} 65%→${read(0.65, h).padEnd(76)} 85%→${read(0.85, h)}`);
}
lines.push(`无该统计(2000手)      ${read(null, 2000)}`);
console.log(lines.join('\n'));


