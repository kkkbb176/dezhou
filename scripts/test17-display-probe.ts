/** 只读勘探：viewModel 行结构 + 「无下注范围」回落标注 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const OPTIONS = { rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false, equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 } } as const;
const A_ = (p: string, t: string, bb?: number, s?: string): Record<string, unknown> => ({ position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }), ...(s === undefined ? {} : { street: s }) });
const v = (qp: string | null): ManualVillain => ({ seatId: 'seat_BB', persistentPlayerId: 'p1', quickProfile: (qp ?? undefined) as never, dynamicHint: 'UNKNOWN', stackBB: 100 });

/* ① TEST 17 节点 */
const test17 = {
  tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN',
  effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  actionHistory: [
    A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
    A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
    A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
    A_('BB', 'BET', 10, 'TURN'),
  ],
  environment: 'MID_LOW_STAKES',
  villain: { ...v('MANIAC'), observedStats: { handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null } },
} as unknown as ManualHandInput;

/* ② 翻前面对 3bet（预期：没有下注范围 ⇒ 回落标注） */
const preflop3bet = {
  tableSize: 6, heroPosition: 'CO', heroCards: ['As', 'Ah'], street: 'PREFLOP',
  effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'RAISE', 3), A_('BTN', 'FOLD'), A_('SB', 'FOLD'), A_('BB', 'RAISE', 10)],
  environment: 'MID_LOW_STAKES', villain: v('NORMAL'),
} as unknown as ManualHandInput;

for (const [tag, input] of [['TEST17', test17], ['PREFLOP-3BET', preflop3bet]] as const) {
  const r = analyzeManualHand(input, OPTIONS);
  console.log(`\n=== ${tag} ok=${r.ok}`);
  if (!r.ok) continue;
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  const math = dg['math'] as Record<string, any>;
  console.log(`  action=${String(d['action'])} size=${String(d['sizeChips'])}｜heroEquity=${String(math['heroEquity'])}｜betRange=${String(math['heroEquityVsBetRange'])}｜callEV=${String(math['callEV'])}`);
  const vm = r.viewModel as unknown as Record<string, any>;
  console.log('  viewModel keys:', Object.keys(vm).join(', '));
  const rows = (vm['debug']?.['math'] ?? []) as readonly { label: string; value: string }[];
  console.log(`  debug.math 行数 = ${rows.length}`);
  for (const row of rows) {
    if (/权益|跟注 EV|所需/.test(row.label)) console.log(`   · ${row.label} = ${row.value.slice(0, 160)}`);
  }
  const call = ((dg['candidates'] ?? []) as readonly Record<string, any>[]).find((c) => c['action'] === 'CALL');
  console.log(`  CALL 候选 noteZh = ${String(call?.['noteZh'])}`);
}
