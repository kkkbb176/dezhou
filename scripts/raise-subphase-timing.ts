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
const r: number[] = [];
for (let i = 0; i < 3; i++) {
  const built: any = buildDecisionContext({ state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1757000000000,
    quickProfile: 'VERY_TIGHT', observedStats: STATS, equitySeed: 20260913, budget: { softMs: 60000, hardMs: 120000 } } as any);
  const t: any = built.context.timings;
  r.push(t.raiseResponse ?? 0);
  if (i === 2) {
    console.log('raiseResponse 总 =', t.raiseResponse + 'ms');
    console.log('  ├ 组合分类 raiseComboClassify =', t.raiseComboClassify + 'ms');
    console.log('  ├ 桶权益   raiseBucketEquity  =', t.raiseBucketEquity + 'ms');
    console.log('  └ 其余     raiseBookkeeping   =', (t.raiseResponse - (t.raiseComboClassify ?? 0) - (t.raiseBucketEquity ?? 0)) + 'ms');
    console.log('其它阶段：equity=' + t.equity + ' range=' + t.range + ' bettingRange=' + t.bettingRange + ' total=' + t.total);
  }
}
console.log('raiseResponse 三次:', r.join(', '));
