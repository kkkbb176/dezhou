/**
 * V2.1 最小复现：9-max SRP，CO 开池 → BB 跟注 → 翻牌 BB 过/CO 下注/BB 跟 →
 * 转牌 BB 过/CO 下注/BB 跟 → 河牌 BB 过/CO 下注。逐步缩短，定位哪一条被拒。
 */
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';

const SEATS9 = {
  UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
  CO: 100, BTN: 100, SB: 100, BB: 100,
} as const;

const PRE = [
  { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
  { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 },
  { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 1.5 },
] as const;

const TAIL: readonly Record<string, unknown>[] = [
  { position: 'BB', type: 'CHECK', street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'TURN' },
  { position: 'CO', type: 'BET', amountBB: 5.5, street: 'TURN' },
  { position: 'BB', type: 'CALL', amountBB: 5.5, street: 'TURN' },
  { position: 'BB', type: 'CHECK', street: 'RIVER' },
  { position: 'CO', type: 'BET', amountBB: 7.5, street: 'RIVER' },
];

for (let n = 0; n <= TAIL.length; n += 1) {
  const history = [...PRE, ...TAIL.slice(0, n)];
  const street = n === 0 ? 'PREFLOP' : (TAIL[n - 1]!['street'] as string);
  const input = {
    tableSize: 9, heroPosition: 'BB', heroCards: ['Kh', 'Qh'],
    board: ['Kc', '9s', '5d', '2h', '7c'], street,
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS9 },
    actionHistory: history.map((h) => ({ ...h })),
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;

  const parsed = parseManualInput(input);
  if (!parsed.ok) { console.log(`n=${n} street=${street} parse FAIL ${JSON.stringify(parsed.issues)}`); continue; }
  const gate = buildAnalyzableState(parsed.value);
  const last = TAIL[n - 1];
  const desc = n === 0 ? '（只到翻前）' : `${last!['position']} ${last!['type']} ${last!['street']}`;
  console.log(
    `n=${String(n).padStart(2)} street=${String(street).padEnd(7)} 末条=${desc.padEnd(24)} ` +
      (gate.ok
        ? `OK  actions=${gate.state.actions.length} 下一行动=${gate.state.pendingQueue.join(',') || '—'}`
        : `FAIL ${JSON.stringify(gate.issues.map((i: { code: string }) => i.code))}`),
  );
}
