/**
 * V2.1：6-max 溜入底池（LIMPED）场景 — 逐步定位行动顺序。
 */
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';

const SEATS6 = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

const HEAD = [
  { position: 'UTG', type: 'CALL', amountBB: 1 },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'CALL', amountBB: 1 },
  { position: 'BTN', type: 'FOLD' },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CHECK' },
] as const;

const TAIL: readonly Record<string, unknown>[] = [
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
];

for (let n = 0; n <= TAIL.length; n += 1) {
  const history = [...HEAD, ...TAIL.slice(0, n)];
  const street = n === 0 ? 'PREFLOP' : (TAIL[n - 1]!['street'] as string);
  const input = {
    tableSize: 6, heroPosition: 'BB', heroCards: ['9h', '9c'],
    board: ['Qs', '8d', '3c', '6s', 'Ks'], street,
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS6 },
    actionHistory: history.map((h) => ({ ...h })),
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;

  const parsed = parseManualInput(input);
  if (!parsed.ok) { console.log(`n=${n} parse FAIL ${JSON.stringify(parsed.issues.map((i: {code:string})=>i.code))}`); continue; }
  const gate = buildAnalyzableState(parsed.value);
  const last = TAIL[n - 1];
  const desc = n === 0 ? '（只到翻前）' : `${last!['position']} ${last!['type']} ${last!['street']}`;
  console.log(
    `n=${String(n).padStart(2)} street=${String(street).padEnd(7)} 末条=${desc.padEnd(22)} ` +
      (gate.ok
        ? `OK  actions=${gate.state.actions.length} 待行动=${gate.state.pendingQueue.join(',') || '—'}`
        : `FAIL ${JSON.stringify(gate.issues.map((i: { code: string; message: string }) => `${i.code}:${i.message.slice(0, 60)}`))}`),
  );
}
