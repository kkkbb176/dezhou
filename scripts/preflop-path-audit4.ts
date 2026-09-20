/**
 * 翻前决策路径 · 只读核查探针 ④（对手范围来源与可信度）
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parseManualInput, type ManualHandInput, type ManualVillain } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const A_ = (p: string, t: string, bb?: number): Record<string, unknown> => ({ position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }) });
const base = {
  tableSize: 6, heroPosition: 'BTN', effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  environment: 'MID_LOW_STAKES',
};
const V = (bb = 100): ManualVillain => ({ quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: bb }) as ManualVillain;

const SCENARIOS: ReadonlyArray<readonly [string, ManualHandInput]> = [
  ['① BTN 无人入池（AA）', { ...base, heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD')], villain: V() } as unknown as ManualHandInput],
  ['③ BB 面对 BTN 开池（AKo）', { ...base, heroPosition: 'BB', heroCards: ['As', 'Kd'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD')], villain: V() } as unknown as ManualHandInput],
  ['④ BTN 面对 3bet 至 10BB（AA）', { ...base, heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'RAISE', 10)], villain: V() } as unknown as ManualHandInput],
  ['⑤ 跛入池 BTN（AKo，1 limper）', { ...base, heroCards: ['As', 'Kd'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'CALL', 1), A_('CO', 'FOLD')], villain: V() } as unknown as ManualHandInput],
  ['⑥ 跛入池 BB（AKo，2 limper）', { ...base, heroPosition: 'BB', heroCards: ['As', 'Kd'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'CALL', 1), A_('CO', 'CALL', 1), A_('BTN', 'FOLD'), A_('SB', 'FOLD')], villain: V() } as unknown as ManualHandInput],
];

const j = (v: unknown): string => JSON.stringify(v) ?? 'undefined';
const pickRange = (r: Record<string, any> | null): unknown =>
  r === null ? null : {
    id: r['opponentId'], pos: r['opponentPositionZh'], kind: r['sourceKind'], desc: r['sourceDescription'],
    conf: r['confidence'], support: r['supportSize'], share: r['supportShare'], collapsed: r['collapsed'],
  };

for (const [tag, input] of SCENARIOS) {
  console.log('='.repeat(100));
  console.log(`## ${tag}`);
  const p = parseManualInput(input);
  if (!p.ok) { console.log('  ✖ 解析失败'); continue; }
  const g = buildAnalyzableState(p.value);
  if (!g.ok) { console.log('  ✖ 状态失败'); continue; }
  const built = buildDecisionContext({
    state: g.state, rules: OPTIONS.rules, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
    quickProfile: p.value.villain.quickProfile, dynamicHint: p.value.villain.dynamicHint,
    equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
  } as never) as unknown as Record<string, any>;
  const ctx = built['context'] as Record<string, any>;
  console.log(`  展示用 context.range = ${j(pickRange(ctx['range'] ?? null))}`);
  console.log(`  权益用 context.opponentRanges（${(ctx['opponentRanges'] as readonly unknown[]).length} 条）= ${j((ctx['opponentRanges'] as readonly Record<string, any>[]).map(pickRange))}`);
  console.log(`  realizedOpponentCount=${String(ctx['realizedOpponentCount'])}  activeOpponentCount=${String(ctx['activeOpponentCount'])}`);
  const r = analyzeManualHand(input, OPTIONS);
  if (r.ok) {
    const dg = (r.decision as unknown as Record<string, any>)['diagnostics'] as Record<string, any>;
    const math = dg['math'] as Record<string, any>;
    console.log(`  heroEquity=${math['heroEquity'] === null ? 'null' : (math['heroEquity'] as number).toFixed(6)}  confidence=${String((r.decision as unknown as Record<string, any>)['confidence'])}  classification=${String((r.decision as unknown as Record<string, any>)['classification'])}  action=${String((r.decision as unknown as Record<string, any>)['action'])}`);
  }
}
console.log('='.repeat(100));
console.log('探针 ④ 结束（只读）');
