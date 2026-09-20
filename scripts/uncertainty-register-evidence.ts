/**
 * 不确定登记表 —— 证据采集（只读）
 *
 * 为 `reports/UNCERTAINTY_REGISTER.md` 提供当前实测值：
 *  · 各关键节点**当前**动作与依据
 *  · 三个条件权益的当前数值
 *  · 全下保护 / 未评估动作的当前状态
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { akInput } from './rrda-lib.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: 20_261_014, budget: { softMs: 120_000, hardMs: 240_000 } } as const;
const line = (s = ''): void => console.log(s);
const num = (v: unknown, d = 6): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const pad = (s: string, n: number): string => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};
const A = (position: string, type: string, amountBB?: number, street?: string) => ({
  position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }),
});
const F = (p: string) => A(p, 'FOLD');

/** TEST 4 节点：9 人桌 HJ AA，面对 CO 冷四注后的转牌下注 */
const test4: ManualHandInput = {
  tableSize: 9, heroPosition: 'HJ', heroCards: ['Ac', 'Ad'], board: ['Ks', '8d', '4c', 'Jc'], street: 'TURN',
  effectiveStackBB: 200, seatStacksBB: { UTG: 200, HJ: 200, CO: 200 },
  actionHistory: [
    A('UTG', 'RAISE', 3), F('UTG1'), F('UTG2'), F('LJ'),
    A('HJ', 'RAISE', 10), A('CO', 'RAISE', 26), F('BTN'), F('SB'), F('BB'),
    A('UTG', 'FOLD'), A('HJ', 'CALL', 16),
    A('HJ', 'CHECK', undefined, 'FLOP'), A('CO', 'BET', 40, 'FLOP'), A('HJ', 'CALL', 40, 'FLOP'),
    A('HJ', 'CHECK', undefined, 'TURN'), A('CO', 'BET', 60, 'TURN'),
  ],
  environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
} as unknown as ManualHandInput;

/** AA 面对 3bet（翻前） */
const aaVs3bet: ManualHandInput = {
  tableSize: 6, heroPosition: 'CO', heroCards: ['Ah', 'Ad'], board: [], street: 'PREFLOP',
  effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  actionHistory: [F('UTG'), F('HJ'), A('CO', 'RAISE', 3), F('BTN'), F('SB'), A('BB', 'RAISE', 10)],
  environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 },
} as unknown as ManualHandInput;

const deep99: ManualHandInput = {
  ...(akInput(20, 'CALLING_STATION', ['9s', '9h']) as unknown as Record<string, unknown>),
  effectiveStackBB: 400,
  seatStacksBB: { UTG: 400, HJ: 400, CO: 400, BTN: 400, SB: 400, BB: 400 },
} as unknown as ManualHandInput;

const cases: Array<[string, ManualHandInput]> = [
  ['AK 河牌（一对，100BB，CALLING_STATION）', akInput(20, 'CALLING_STATION')],
  ['AK 河牌（NORMAL）', akInput(20, 'NORMAL')],
  ['AK 河牌（MANIAC）', akInput(20, 'MANIAC')],
  ['99 河牌（暗三条，100BB）', akInput(20, 'CALLING_STATION', ['9s', '9h'])],
  ['99 河牌（暗三条，400BB）', deep99],
  ['TEST 4：AA 转牌（一对，低 SPR 冷四注）', test4],
  ['AA 面对 3bet（翻前）', aaVs3bet],
];

line('='.repeat(126));
line(' 各关键节点的**当前**动作（RIVER RAISE DECISION V2 之后）');
line('='.repeat(126));
line(pad('节点', 40) + pad('动作', 10) + pad('size', 10) + pad('CALL EV', 12) + pad('EqVsBetRange', 14) +
  pad('到达权益', 12) + pad('全下保护', 10) + pad('来源', 26) + '打光?');
for (const [tag, input] of cases) {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { line(`${pad(tag, 40)}FAIL ${r.stage}`); continue; }
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  const m = dg['math'] as Record<string, any>;
  const cond = dg['conditionalEquities'] as Record<string, any>;
  line(pad(tag, 40) + pad(String(d['action']), 10) + pad(num(d['sizeChips'], 2), 10) + pad(num(m['callEV'], 2), 12) +
    pad(num(cond?.['betRange'], 4), 14) + pad(num(cond?.['arrivalRange'], 4), 12) +
    pad(String(dg['allInGuard']?.['onePairAllInBlocked']), 10) + pad(String(dg['decisionSource']?.['kind']), 26) +
    String(dg['actionShape']?.['consumesStack']));
}
line('');
line('='.repeat(126));
line(' 未评估动作的规模（每节点）');
line('='.repeat(126));
for (const [tag, input] of cases.slice(0, 6)) {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) continue;
  const dg = (r.decision as unknown as Record<string, any>)['diagnostics'] as Record<string, any>;
  const un = (dg['unevaluatedActions'] ?? []) as any[];
  const raiseUn = un.filter((u) => u['reasonCode'] === 'RAISE_EV_NOT_IMPLEMENTED');
  line(`  ${pad(tag, 40)} 未评估 ${un.length} 项（其中加注/全下 ${raiseUn.length} 项）：` +
    raiseUn.map((u) => num(u['sizeChips'], 0)).join(' / '));
}
