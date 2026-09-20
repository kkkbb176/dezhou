/**
 * 翻前决策路径 · 只读核查探针 ③（全下保护的可审计判定 + 只能全下的节点）
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { allInGuardVerdictOf } from '../src/app/decision/decisionEngine.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parseManualInput, type ManualHandInput, type ManualVillain } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const A_ = (p: string, t: string, bb?: number): Record<string, unknown> => ({ position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }) });
const base = {
  tableSize: 6, heroPosition: 'BB', effectiveStackBB: 5, bigBlindBB: 2,
  seatStacksBB: { UTG: 5, HJ: 5, CO: 5, BTN: 5, SB: 5, BB: 5 },
  environment: 'MID_LOW_STAKES',
};
const V = (bb: number): ManualVillain => ({ quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: bb }) as ManualVillain;
const OPEN = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD')];

const SCENARIOS: ReadonlyArray<readonly [string, ManualHandInput]> = [
  ['B. 5BB：BB 面对开池（AA）', { ...base, heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', actionHistory: OPEN, villain: V(5) } as unknown as ManualHandInput],
  ['F. 3BB：BB 面对开池（AA）—— 加注不可行（minRaiseTo > allInTo）',
    { ...base, heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', effectiveStackBB: 3, seatStacksBB: { UTG: 3, HJ: 3, CO: 3, BTN: 3, SB: 3, BB: 3 }, actionHistory: OPEN, villain: V(3) } as unknown as ManualHandInput],
];

const stable = (_k: string, v: unknown): unknown =>
  typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v) ? Number(v.toFixed(12)) : v;
const j = (v: unknown, cap = 1200): string => {
  const s = JSON.stringify(v, stable) ?? 'undefined';
  return s.length > cap ? `${s.slice(0, cap)}…(共${s.length})` : s;
};

console.log('--- allInGuardVerdictOf 直接调用（纯函数，翻前输入）---');
for (const [cat, stack, own] of [[0, true, false], [0, true, true], [0, false, false], [3, true, false]] as const) {
  const v = allInGuardVerdictOf({ handCategory: cat, consumesStack: stack, hasOwnEV: own });
  console.log(`  handCategory=${cat} consumesStack=${String(stack)} hasOwnEV=${String(own)} ⇒ blocked=${String(v.onePairAllInBlocked)} ｜ ${v.reasonZh}`);
}

for (const [tag, input] of SCENARIOS) {
  console.log('='.repeat(112));
  console.log(`## ${tag}`);
  console.log('='.repeat(112));
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { console.log(`  ✖ 分析失败：${r.stage}`); continue; }
  const decision = r.decision as unknown as Record<string, any>;
  const dg = decision['diagnostics'] as Record<string, any>;
  const p = parseManualInput(input);
  if (!p.ok) { console.log('  ✖ 解析失败'); continue; }
  const g = buildAnalyzableState(p.value);
  if (!g.ok) { console.log('  ✖ 状态失败'); continue; }
  const built = buildDecisionContext({
    state: g.state, rules: OPTIONS.rules, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
    quickProfile: p.value.villain.quickProfile, dynamicHint: p.value.villain.dynamicHint,
    equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
  } as never) as unknown as Record<string, any>;
  console.log(`  legal = ${j({ actions: built['legal']['actions'], minRaiseTo: built['legal']['minRaiseToAmount'], allInTo: built['legal']['allInToAmount'], callCost: built['legal']['callCost'], currentBet: built['legal']['currentBet'], myRemaining: built['legal']['myRemainingStack'] }, 400)}`);
  console.log(`  candidates = ${j((dg['candidates'] as readonly Record<string, any>[])?.map((c) => ({ a: c['action'], s: c['sizeChips'], ev: c['ev'] })), 500)}`);
  console.log(`  action = ${String(decision['action'])}${decision['sizeChips'] === undefined ? '' : ` ${String(decision['sizeChips'])}`}`);
  console.log(`  allInGuard = ${j(dg['allInGuard'], 1200)}`);
  console.log(`  actionShape = ${j(dg['actionShape'], 700)}`);
  console.log(`  decisionSource = ${j(dg['decisionSource'], 900)}`);
  for (const [i, reason] of ((decision['reasons'] as readonly Record<string, any>[]) ?? []).entries()) {
    console.log(`   ${i + 1}. [${String(reason['code'])}] ${j(reason['textZh'], 320)}`);
  }
}
console.log('='.repeat(112));
console.log('探针 ③ 结束（只读）');
