/** U1 定向排查：F-01 节点（翻牌 K72，Hero KK 三条面对下注 6BB） */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: 20_261_014, budget: { softMs: 120_000, hardMs: 240_000 } } as const;
const line = (s = ''): void => console.log(s);
const num = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));

const A = (position: string, type: string, amountBB?: number, street?: string) => ({
  position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }),
});
const spot: ManualHandInput = {
  tableSize: 6, heroPosition: 'BTN', heroCards: ['Kd', 'Kc'], board: ['Kh', '7c', '2d'], street: 'FLOP',
  effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  actionHistory: [
    A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
    A('BB', 'BET', 6, 'FLOP'),
  ],
  environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 },
} as unknown as ManualHandInput;

const r = analyzeManualHand(spot, OPTIONS);
if (!r.ok) throw new Error(`${r.stage} ${JSON.stringify(r.issues)}`);
const d = r.decision as unknown as Record<string, any>;
const dg = d['diagnostics'] as Record<string, any>;
line(`动作 = ${String(d['action'])} ${num(d['sizeChips'], 0)}｜来源 = ${String(dg['decisionSource']?.['kind'])}`);
line(`pot=${num(dg['math']['pot'], 0)}｜callCost=${num(dg['math']['callCost'], 0)}｜winnable=${num(dg['math']['winnable'], 0)}｜requiredEquity=${num(dg['math']['requiredEquity'])}`);
line(`CALL EV = ${num(dg['math']['callEV'], 2)}｜EqVsBetRange = ${num(dg['math']['heroEquityVsBetRange'])}｜到达 = ${num(dg['math']['heroEquity'])}`);
line('');
const rf = dg['postflop']?.['raiseResponse'] as Record<string, any> | null;
if (rf === null || rf === undefined) { line('无加注响应事实'); } else {
  line('【U1 面对加注的响应】');
  line(`  加注到 ${num(rf['sizeChips'], 0)}（增量 ${num(rf['raiseIncrement'], 0)}）｜他需跟 ${num(rf['raiseIncrement'], 0)}`);
  line(`  P(弃) = ${num(rf['foldLikelihood'])}｜P(跟) = ${num(rf['callLikelihood'])}｜P(再加注) = ${num(rf['reRaiseLikelihood'])}`);
  line(`  EqVsRaiseCallRange = ${num(rf['heroEquityVsRaiseCallRange'])}｜方法 ${String(rf['equityMethod'])}（${String(rf['equityIterations'])}）`);
  line(`  RAISE EV = ${num(rf['raiseEV'], 2)}（${String(rf['evKind'])}）`);
  line(`  keys: ${Object.keys(rf).join(', ')}`);
  line(`  note: ${String(rf['noteZh']).slice(0, 400)}`);
}
line('');
line('【候选】');
for (const c of (dg['candidates'] ?? []) as any[]) {
  line(`  ${String(c['action']).padEnd(8)} size=${num(c['sizeChips'], 0).padStart(8)} ev=${num(c['ev'], 2).padStart(10)}`);
}
line('');
line('【证据表】');
for (const e of (dg['actionEvidence'] ?? []) as any[]) {
  line(`  ${String(e['action']).padEnd(8)} ${String(e['estimateType']).padEnd(30)} ev=${num(e['ev'], 2).padStart(10)} commitsStack=${String(e['commitsStack'])}`);
}
line('');
line('【未评估】');
for (const u of (dg['unevaluatedActions'] ?? []) as any[]) line(`  ${String(u['action'])} ${num(u['sizeChips'], 0)} ${String(u['reasonCode'])}`);
