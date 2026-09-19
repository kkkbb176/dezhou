/**
 * V2.1 语料调试：逐个场景打印解析后的行动序列与被拒原因。
 *
 * 用法：`node --experimental-strip-types scripts/v21-corpus-debug.ts [场景ID]`
 */
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  budget: { softMs: 120_000, hardMs: 240_000 }, equitySeed: 20260913,
} as const;

const SEATS9 = {
  UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
  CO: 100, BTN: 100, SB: 100, BB: 100,
} as const;
const SEATS6 = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

const which = process.argv[2] ?? 'all';

const S2 = [
  { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
  { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 },
  { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 1.5 },
  { position: 'BB', type: 'CHECK', street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'TURN' },
  { position: 'CO', type: 'BET', amountBB: 5.5, street: 'TURN' },
  { position: 'BB', type: 'CALL', amountBB: 5.5, street: 'TURN' },
  { position: 'BB', type: 'CHECK', street: 'RIVER' },
  { position: 'CO', type: 'BET', amountBB: 7.5, street: 'RIVER' },
] as const;

const S5 = [
  { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
  { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 },
  { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 1.5 },
  { position: 'BB', type: 'CHECK', street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'TURN' },
  { position: 'CO', type: 'CHECK', street: 'TURN' },
  { position: 'BB', type: 'CHECK', street: 'RIVER' },
  { position: 'CO', type: 'BET', amountBB: 30, street: 'RIVER' },
] as const;

const S6 = [
  { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
  { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 },
  { position: 'BTN', type: 'RAISE', amountBB: 9 },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 8 },
  { position: 'CO', type: 'FOLD' },
  { position: 'BB', type: 'CHECK', street: 'FLOP' },
  { position: 'BTN', type: 'BET', amountBB: 13.5, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 13.5, street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'TURN' },
  { position: 'BTN', type: 'BET', amountBB: 20, street: 'TURN' },
] as const;

const S7 = [
  { position: 'UTG', type: 'CALL', amountBB: 1 },
  { position: 'CO', type: 'CALL', amountBB: 1 },
  { position: 'BTN', type: 'FOLD' },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CHECK' },
  { position: 'UTG', type: 'CHECK', street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'UTG', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'UTG', type: 'CHECK', street: 'TURN' },
  { position: 'BB', type: 'CHECK', street: 'TURN' },
  { position: 'CO', type: 'BET', amountBB: 4, street: 'TURN' },
  { position: 'UTG', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 4, street: 'TURN' },
  { position: 'BB', type: 'CHECK', street: 'RIVER' },
  { position: 'CO', type: 'BET', amountBB: 6, street: 'RIVER' },
] as const;

function make(
  id: string, tableSize: 6 | 9, heroPosition: string, heroCards: string[],
  board: string[], street: string, seats: Record<string, number>,
  history: readonly Record<string, unknown>[],
): ManualHandInput {
  return {
    tableSize, heroPosition, heroCards, board, street,
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...seats },
    actionHistory: history.map((h) => ({ ...h })),
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

const CASES: readonly { id: string; input: () => ManualHandInput }[] = [
  { id: 'S2', input: () => make('S2', 9, 'BB', ['Kh', 'Qh'], ['Kc', '9s', '5d', '2h', '7c'], 'RIVER', SEATS9, S2) },
  { id: 'S7', input: () => make('S7', 6, 'BB', ['9h', '9c'], ['Qs', '8d', '3c', '6s', 'Ks'], 'RIVER', SEATS6, S7) },
];

for (const c of CASES) {
  if (which !== 'all' && which !== c.id) continue;
  const input = c.input();
  console.log(`\n======== ${c.id} ========`);
  const parsed = parseManualInput(input);
  if (!parsed.ok) {
    console.log('parse FAIL: ' + JSON.stringify(parsed.issues, null, 1));
    continue;
  }
  console.log('parse OK');
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) {
    console.log('gate FAIL: ' + JSON.stringify(gate.issues, null, 1));
    continue;
  }
  console.log(`gate OK。state.street=${gate.state.street} 行动条数=${gate.state.actions.length}`);
  for (const [i, a] of gate.state.actions.entries()) {
    console.log(
      `  #${String(i).padStart(2)} ${String(a.playerId).padEnd(8)} ${String(a.type).padEnd(6)} ` +
        `street=${String(a.street).padEnd(6)} amount=${a.amount} potBefore=${a.potBefore}`,
    );
  }
  const r = analyzeManualHand(input, OPTIONS);
  console.log(r.ok ? `analyze OK: action=${r.decision.action} sizing=${JSON.stringify(r.decision.sizing)}` : `analyze FAIL: ${JSON.stringify(r.issues)}`);
}
