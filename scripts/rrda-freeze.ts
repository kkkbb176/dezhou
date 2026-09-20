/**
 * RIVER RAISE DECISION —— 只读审计探针
 *
 * 冻结 AK 节点，并把「最终动作」的全部证据打印出来：
 *   · 合法动作与加注金额语义（raise-to vs 增量、是否等于全下）
 *   · 有效剩余筹码 / 可争夺量 / SPR
 *   · 决策诊断里的证据表（FOLD / CALL / RAISE 各自的 estimateType 与 EV）
 *   · 三个条件权益
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_014;
const line = (s = ''): void => console.log(s);
const pad = (s: string, n: number): string => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};
const num = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));

type Row = { position: string; type: string; amountBB?: number; street?: string };
const A = (position: string, type: string, amountBB?: number, street?: string): Row => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

export function akInput(riverBetBB = 20, profile = 'CALLING_STATION'): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', riverBetBB, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

const input = akInput();
const parsed = parseManualInput(input);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues[0]));
const gate = buildAnalyzableState(parsed.value);
if (!gate.ok) throw new Error(JSON.stringify(gate.issues[0]));
const built = buildDecisionContext({
  state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
  quickProfile: 'CALLING_STATION' as never, equitySeed: SEED,
});
const ctx = built.context as unknown as Record<string, any>;
const legal = built.legal as unknown as Record<string, any>;
const m = ctx['math'] as Record<string, any>;
const facts = ctx['postflopFacts'] as Record<string, any>;

const run = analyzeManualHand(input, {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: SEED,
  budget: { softMs: 120_000, hardMs: 240_000 },
});
if (!run.ok) throw new Error(`${run.stage} ${JSON.stringify(run.issues)}`);
const d = run.decision as unknown as Record<string, any>;
const diag = d['diagnostics'] as Record<string, any>;

line('='.repeat(112));
line(' 一、冻结 AK 节点（Hero BTN A♠K♠｜K♦9♣4♥6♠2♦｜下注前底池 53｜BB 下注 40）');
line('='.repeat(112));
line(`  最终动作 = ${String(d['action'])}｜sizeChips = ${num(d['sizeChips'], 2)}｜sizeBB = ${num(d['sizeBB'], 2)}`);
line(`  置信度 = ${String(d['confidence'])}｜band = ${String(d['band'])}｜classification = ${String(d['classification'])}`);
line('');
line('  【筹码与赔率】');
line(`    pot = ${num(m['pot'], 2)}｜callCost = ${num(m['callCost'], 2)}｜winnable = ${num(m['winnable'], 2)}`);
line(`    我的剩余 myRemainingStack = ${num(m['myRemainingStack'], 2)}｜有效筹码 effectiveStack = ${num(m['effectiveStack'], 2)}｜SPR = ${num(m['spr'], 3)}`);
line(`    本街已投入 myCommittedThisStreet = ${num(m['myCommittedThisStreet'], 2)}｜requiredEquity = ${num(m['requiredEquity'], 6)}`);
line(`    跟注后我的剩余 = ${num((m['myRemainingStack'] as number) - (m['callCost'] as number), 2)}`);
line('');
line('  【三个条件权益】');
line(`    math.heroEquity（链条整体范围，含本街全部动作）      = ${num(m['heroEquity'], 6)}`);
line(`    EqVsArrivalRange（postflop.betRangeArrival）        = ${num(facts['betRangeArrival']?.['heroEquityVsArrivalRange'], 6)}`);
line(`    EqVsBetRange（math.heroEquityVsBetRange）           = ${num(m['heroEquityVsBetRange'], 6)}`);
line(`    heroEquityVsRaiseCallRange                          = ${'NOT_IMPLEMENTED（无该字段）'}`);
line('');
line('  【合法动作】（raise-to 语义：sizeChips 是本街总额目标，不是增量）');
line(pick('    动作', 16) + pick('金额', 12) + pick('增量', 12) + '说明');
for (const a of (legal['actions'] ?? []) as any[]) {
  const amount = a['amount'] ?? a['toAmount'] ?? null;
  line(pick(String(a['action'] ?? a['type']), 16) + pick(num(amount, 2), 12) +
    pick(amount === null ? '—' : num((amount as number) - (m['callCost'] as number), 2), 12) +
    (a['reasonZh'] ?? a['noteZh'] ?? ''));
}
line(`    minRaiseTo = ${num(legal['minRaiseTo'], 2)}｜maxRaiseTo = ${num(legal['maxRaiseTo'], 2)}｜canRaise = ${String(legal['canRaise'])}`);
line('');

line('='.repeat(112));
line(' 二、决策证据表（diagnostics.actionEvidence）');
line('='.repeat(112));
line(pick('动作', 10) + pick('证据类型', 30) + pick('EV', 14) + pick('决策边际', 24) + pick('启发式分', 12) + '置信度');
for (const e of (diag['actionEvidence'] ?? []) as any[]) {
  line(pick(String(e['action']), 10) + pick(String(e['estimateType']), 30) + pick(num(e['ev'], 4), 14) +
    pick(String(e['decisionMargin'] ?? '—'), 24) + pick(num(e['heuristicScore'], 4), 12) + num(e['confidence'], 2));
}
line('');
line('  证据裁决（diagnostics.evidenceDecision）：');
const ed = diag['evidenceDecision'] ?? {};
line(`    chosen = ${String(ed['action'])}｜source = ${String(ed['source'])}｜scope = ${String(ed['evidenceScope'])}`);
line(`    overrideAttempt = ${String(ed['overrideAttempt'])}｜overrideBlocked = ${String(ed['overrideBlockedReason'])}`);
line(`    noteZh = ${String(ed['noteZh'])}`);
line('');
line('  决策边际（diagnostics.decisionMargin）：');
const dm = diag['decisionMargin'] ?? {};
line(`    kind = ${String(dm['kind'])}｜evChips = ${num(dm['evChips'], 4)}｜bandChips = ${num(dm['bandChips'], 4)}`);
line(`    noteZh = ${String(dm['noteZh'])}`);
line('');
line('  候选动作与 EV（diagnostics.candidates）：');
for (const c of (diag['candidates'] ?? []) as any[]) {
  line(`    · ${pick(String(c['action']), 12)} size=${pick(num(c['sizeChips'], 2), 8)} ev=${pick(num(c['ev'], 4), 14)} mathFeasible=${String(c['mathFeasible'])} ${String(c['noteZh'] ?? '').slice(0, 60)}`);
}
line('');
line('  最终理由：');
for (const r of (d['reasons'] ?? []) as any[]) {
  line(`    · [${r['code']}] ${String(r['textZh']).slice(0, 200)}`);
}
line('');
line('  betDecision 事实包（面对下注时是否为 null）：', String(facts['betDecision'] === null ? 'null（面对下注不建 Hero 下注树）' : '存在'));

function pick(s: string, n: number): string {
  return pad(s, n);
}
