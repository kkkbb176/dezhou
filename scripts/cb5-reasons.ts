/** CB-5 · 用户可见理由链核对（只读）：护栏触发后不得再宣称「全下 EV 最高」。 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const A_ = (p: string, t: string, bb?: number, s?: string): Record<string, unknown> => ({
  position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }), ...(s === undefined ? {} : { street: s }),
});
const S100 = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };
const PF = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];
const F25 = [A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP')];
const T75 = [A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN')];
const V = (p: string): ManualVillain => ({ quickProfile: p, dynamicHint: 'UNKNOWN', stackBB: 100 }) as ManualVillain;
const node = (betBB: number, profile: string): ManualHandInput =>
  ({ tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
     effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: S100, actionHistory: [...PF, ...F25, ...T75, A_('BB', 'BET', betBB, 'RIVER')],
     environment: 'MID_LOW_STAKES', villain: V(profile) }) as unknown as ManualHandInput;

for (const [tag, bet, profile] of [['R-05 120% 池 · NORMAL', 41.5, 'NORMAL'], ['AK 河牌 · NORMAL', 20, 'NORMAL']] as const) {
  const r = analyzeManualHand(node(bet, profile), OPTIONS);
  console.log('='.repeat(112));
  console.log(`## ${tag}`);
  if (!r.ok) { console.log(`  ✖ ${String(r.stage)}`); continue; }
  const d = r.decision as unknown as Record<string, any>;
  console.log(`  最终动作 = ${String(d['action'])}${d['sizeChips'] === undefined ? '' : ` @${String(d['sizeChips'])}`}`);
  console.log(`  首屏（slice 0..3）= ${JSON.stringify(((d['reasons'] ?? []) as Record<string, any>[]).slice(0, 3).map((x) => String(x['code'])))}`);
  for (const [i, reason] of ((d['reasons'] ?? []) as Record<string, any>[]).entries()) {
    console.log(`   ${i + 1}. [${String(reason['code'])}] ${String(reason['textZh'])}`);
  }
  const vm = r.viewModel as unknown as Record<string, any>;
  console.log(`  界面：${String(vm['actionZh'])} ｜ ${String(vm['sizeZh'] ?? '')}`);
}
console.log('='.repeat(112));
