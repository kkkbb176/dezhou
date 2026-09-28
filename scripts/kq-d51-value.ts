import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
const RULES = loadKnowledgeBaseOrThrow().allRules();
const pre = (p: string, t: string, a?: number, s?: string) => ({ position: p, type: t, ...(a === undefined ? {} : { amountBB: a }), ...(s === undefined ? {} : { street: s }) });
const input = {
  tableSize: 9, heroPosition: 'CO', heroCards: ['Ks','Qs'], board: ['Qh','9s','5s'], street: 'FLOP',
  effectiveStackBB: 100, bigBlindBB: 100, potBB: 23, environment: 'LOW_STAKES_ONLINE',
  occupiedPositions: ['UTG','UTG1','UTG2','LJ','HJ','CO','BTN','SB','BB'], buttonPosition: 'BTN',
  actionHistory: [pre('UTG','FOLD',undefined,'PREFLOP'),pre('UTG1','FOLD',undefined,'PREFLOP'),pre('UTG2','FOLD',undefined,'PREFLOP'),
    pre('LJ','FOLD',undefined,'PREFLOP'),pre('HJ','FOLD',undefined,'PREFLOP'),pre('CO','RAISE',2.5,'PREFLOP'),
    pre('BTN','FOLD',undefined,'PREFLOP'),pre('SB','FOLD',undefined,'PREFLOP'),pre('BB','CALL',1.5,'PREFLOP'),
    pre('BB','CHECK',undefined,'FLOP'),pre('CO','BET',3.5,'FLOP'),pre('BB','RAISE',14,'FLOP')],
} as any;
const r = analyzeManualHand(input, { rules: RULES });
if (!r.ok) { console.log('FAIL', r.stage, JSON.stringify(r.issues).slice(0,200)); process.exit(1); }
const d: any = r.decision;
console.log('动作 =', d.action, d.sizeBB ?? '');
console.log('decisionMargin.noteZh =', String(d.diagnostics.decisionMargin?.noteZh ?? '').slice(0, 300));
const m = String(d.diagnostics.decisionMargin?.noteZh ?? '').match(/MODEL_EV EV = ([\d.]+)/);
console.log('⇒ 新钉值 =', m?.[1] ?? '（未匹配）');
