/**
 * FLOP & RIVER AUDIT V1 · 焦点探针 ②（只读）：合法金额与尺寸网格的可达性
 *
 * 具体问题：R-06（暗三条面对河牌加注）候选里**只有** ALL_IN@166，没有 RAISE@100…160。
 * 本探针打印真实 `legal` 对象与 `buildSizeGrid`（BET / RAISE 两种模式）的输出，
 * 判断是「网格为空」还是「候选被后续过滤」。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildSizeGrid } from '../src/app/manualInput/legalActions.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parseManualInput, type ManualHandInput, type ManualVillain } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const A_ = (p: string, t: string, bb?: number, s?: string): Record<string, unknown> => ({
  position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }), ...(s === undefined ? {} : { street: s }),
});
const S100 = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };
const PF = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];
const FLOP_CB_CALL = [A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP')];
const TURN_CB_CALL = [A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN')];
const V: ManualVillain = { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain;
const j = (v: unknown): string => JSON.stringify(v) ?? 'undefined';

const NODES: ReadonlyArray<readonly [string, ManualHandInput]> = [
  ['R-06 暗三条面对河牌加注（Hero=BB，面对 BTN RAISE 至 60BB）', {
    tableSize: 6, heroPosition: 'BB', heroCards: ['9h', '9s'], board: ['Jd', '9c', '4c', '6s', '2h'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: S100, villain: V, environment: 'MID_LOW_STAKES',
    actionHistory: [...PF, ...FLOP_CB_CALL, ...TURN_CB_CALL, A_('BB', 'BET', 20, 'RIVER'), A_('BTN', 'RAISE', 60, 'RIVER')],
  } as unknown as ManualHandInput],
  ['R-05 顶对面对 120% 池（Hero=BTN）', {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: S100, villain: V, environment: 'MID_LOW_STAKES',
    actionHistory: [...PF, ...FLOP_CB_CALL, ...TURN_CB_CALL, A_('BB', 'BET', 41.5, 'RIVER')],
  } as unknown as ManualHandInput],
  ['TEST18 转牌面对加注（Hero=BTN，A♣J♣，对照组：已知有多个加注档）', {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN',
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: S100, villain: V, environment: 'MID_LOW_STAKES',
    actionHistory: [...PF, ...FLOP_CB_CALL, A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'RAISE', 40, 'TURN')],
  } as unknown as ManualHandInput],
];

for (const [tag, input] of NODES) {
  console.log('='.repeat(112));
  console.log(`## ${tag}`);
  const p = parseManualInput(input);
  if (!p.ok) { console.log('  ✖ 解析失败'); continue; }
  const g = buildAnalyzableState(p.value);
  if (!g.ok) { console.log('  ✖ 状态失败'); continue; }
  const built = buildDecisionContext({
    state: g.state, rules: OPTIONS.rules, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
    quickProfile: 'NORMAL' as never, equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
  } as never) as unknown as Record<string, any>;
  const legal = built['legal'] as Record<string, any>;
  const pot = (built['context'] as Record<string, any>)['math']['pot'] as number;
  console.log(`  【legal 全字段】${j(legal)}`);
  console.log(`  【pot】${String(pot)}`);
  for (const mode of ['BET', 'RAISE'] as const) {
    const grid = buildSizeGrid(legal as never, pot, mode);
    console.log(`  【sizeGrid ${mode}】${j(grid.map((o: Record<string, any>) => ({ kind: o['kind'], to: o['toAmount'], cost: o['costChips'], allIn: o['isAllIn'] })))}`);
  }
  const r = analyzeManualHand(input, OPTIONS);
  if (r.ok) {
    const d = r.decision as unknown as Record<string, any>;
    const dg = (d['diagnostics'] ?? {}) as Record<string, any>;
    console.log(`  【最终动作】${String(d['action'])}${d['sizeChips'] === undefined ? '' : ` @${String(d['sizeChips'])}`}`);
    console.log(`  【候选 action@size】${j(((dg['candidates'] ?? []) as Record<string, any>[]).map((c) => `${String(c['action'])}@${String(c['sizeChips'])}`))}`);
    console.log(`  【actionShape】${j(dg['actionShape'])}`);
  } else {
    console.log(`  ✖ 分析失败：${String(r.stage)}`);
  }
}
console.log('='.repeat(112));
console.log('（焦点探针 ② 结束，只读）');
