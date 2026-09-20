/**
 * 翻前决策路径 · 只读核查探针 ②（补充：短码全下可达性 / 开池信息充分性 / 范围来源）
 *
 * 与 `preflop-path-audit.ts` 相同的只读纪律：只调用生产入口，不写文件、不改参数。
 */
import { analyzeManualHand, finalMathSanityCheck } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
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
const base = {
  tableSize: 6, heroPosition: 'BTN', effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  environment: 'MID_LOW_STAKES',
};
const maniac: ManualVillain = {
  seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
  observedStats: { handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null },
};
const short = (bb: number): Record<string, number> => ({ UTG: bb, HJ: bb, CO: bb, BTN: bb, SB: bb, BB: bb });

const SCENARIOS: ReadonlyArray<readonly [string, ManualHandInput]> = [
  ['A. BTN 无人入池（AA）+ 对手带完整 MANIAC 统计（对照组：信息不足是否结构性）',
    { ...base, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD')], villain: maniac } as unknown as ManualHandInput],
  ['B. 短码 5BB：BB 面对 BTN 开池 3BB（AA）—— 唯一加注 = 全下',
    { ...base, heroPosition: 'BB', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', effectiveStackBB: 5, seatStacksBB: short(5), actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD')], villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 5 } as ManualVillain } as unknown as ManualHandInput],
  ['C. 短码 5BB：BB 面对 BTN 开池 3BB（72o）—— 对照组',
    { ...base, heroPosition: 'BB', heroCards: ['7s', '2d'], board: [], street: 'PREFLOP', effectiveStackBB: 5, seatStacksBB: short(5), actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD')], villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 5 } as ManualVillain } as unknown as ManualHandInput],
  ['D. 跛入池 BB（AKo，2 limper）—— 完整理由文本',
    { ...base, heroPosition: 'BB', heroCards: ['As', 'Kd'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'CALL', 1), A_('CO', 'CALL', 1), A_('BTN', 'FOLD'), A_('SB', 'FOLD')], villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain } as unknown as ManualHandInput],
  ['E. BTN 面对 3bet 至 10BB（AA）—— 完整理由文本',
    { ...base, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'RAISE', 10)], villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain } as unknown as ManualHandInput],
];

const stable = (_k: string, v: unknown): unknown =>
  typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v) ? Number(v.toFixed(12)) : v;
const j = (v: unknown, cap = 1400): string => {
  const s = JSON.stringify(v, stable) ?? 'undefined';
  return s.length > cap ? `${s.slice(0, cap)}…(共${s.length})` : s;
};
const n = (v: unknown, d = 6): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));

for (const [tag, input] of SCENARIOS) {
  console.log('='.repeat(112));
  console.log(`## ${tag}`);
  console.log('='.repeat(112));
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { console.log(`  ✖ 分析失败：${r.stage}`); continue; }
  const decision = r.decision as unknown as Record<string, any>;
  const dg = decision['diagnostics'] as Record<string, any>;
  const math = dg['math'] as Record<string, any>;
  const p = parseManualInput(input);
  if (!p.ok) { console.log('  ✖ 解析失败'); continue; }
  const g = buildAnalyzableState(p.value);
  if (!g.ok) { console.log('  ✖ 状态失败'); continue; }
  const built = buildDecisionContext({
    state: g.state, rules: OPTIONS.rules, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
    ...(p.value.villain.quickProfile === undefined ? {} : { quickProfile: p.value.villain.quickProfile }),
    ...(p.value.villain.dynamicHint === undefined ? {} : { dynamicHint: p.value.villain.dynamicHint }),
    ...(p.value.villain.persistentPlayerId === undefined || p.value.villain.persistentPlayerId === null ? {} : { villainPersistentPlayerId: p.value.villain.persistentPlayerId }),
    ...(p.value.villain.seatId === undefined || p.value.villain.seatId === null ? {} : { villainSeatId: p.value.villain.seatId }),
    ...(p.value.villain.observedStats === undefined || p.value.villain.observedStats === null ? {} : { observedStats: p.value.villain.observedStats }),
    equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
  } as never) as unknown as Record<string, any>;

  console.log(`  built 顶级键 = ${j(Object.keys(built), 900)}`);
  const ctx = (built['context'] ?? {}) as Record<string, any>;
  const range = ctx['range'] ?? null;
  console.log(`  context.range（正确路径）= ${range === null ? 'null（没有任何已实现的对手范围）' : j({ keys: Object.keys(range), source: range['source'], noteZh: range['noteZh'], supportSize: range['metrics']?.['supportSize'] }, 900)}`);
  console.log(`  context.opponentRanges 数量 = ${(ctx['opponentRanges'] as readonly unknown[] | undefined)?.length ?? 0} ｜ profileAppliedToRange=${String(ctx['profileAppliedToRange'])} ｜ preflopIso=${ctx['preflopIso'] === undefined ? 'undefined' : 'present'}`);
  console.log(`  context.warnings = ${j(ctx['warnings'], 500)}`);
  console.log(`  候选（候选表） = ${j((dg['candidates'] as readonly Record<string, any>[])?.map((c) => ({ a: c['action'], s: c['sizeChips'], ev: c['ev'], st: c['statusZh'] ?? null })), 700)}`);
  console.log(`  legal = ${j({ actions: built['legal']?.['actions'], minRaiseTo: built['legal']?.['minRaiseToAmount'], allInTo: built['legal']?.['allInToAmount'], callCost: built['legal']?.['callCost'] }, 260)}`);
  console.log(`  math: callEV=${n(math['callEV'], 12)}  heroEquity=${math['heroEquity'] === null ? 'null' : n(math['heroEquity'], 12)}  EqVsBetRange=${math['heroEquityVsBetRange'] === null ? 'null' : n(math['heroEquityVsBetRange'], 12)}  requiredEquity=${n(math['requiredEquity'], 6)}  winnable=${n(math['winnable'], 2)}  handCategory=${String(math['handCategory'])}`);
  console.log(`  action=${String(decision['action'])}${decision['sizeChips'] === undefined ? '' : ` ${String(decision['sizeChips'])}`}  band=${String(decision['band'])}  classification=${String(decision['classification'])}  confidence=${n(decision['confidence'], 4)}  actionable=${String(decision['actionable'])}`);
  console.log(`  sanity=${j(finalMathSanityCheck(decision as never, built['legal'] as never), 400)}`);
  console.log(`  warnings=${j(r.warnings, 700)}`);
  console.log(`  decisionSource=${j(dg['decisionSource'], 1400)}`);
  console.log('  reasons（完整文本）:');
  for (const [i, reason] of ((decision['reasons'] as readonly Record<string, any>[]) ?? []).entries()) {
    console.log(`   ${i + 1}. [${String(reason['code'])}] ${j(reason['textZh'], 700)}`);
  }
}
console.log('='.repeat(112));
console.log('探针 ② 结束（只读）');
