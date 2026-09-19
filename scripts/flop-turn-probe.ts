/** 临时探针：翻前结束后「轮到谁」在翻牌上是谁（排查 NOT_PLAYERS_TURN）。 */
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';

function build(withChecks: boolean) {
  const hand = {
    tableSize: 6,
    heroPosition: 'BTN',
    heroCards: ['Ks', 'Qs'],
    board: ['Jd', '8c', '4h'],
    street: 'FLOP',
    effectiveStackBB: 82,
    bigBlindBB: 2,
    seatStacksBB: { UTG: 90, HJ: 120, CO: 130, BTN: 150, SB: 95, BB: 110 },
    actionHistory: [
      { position: 'UTG', type: 'CALL', amountBB: 1 },
      { position: 'HJ', type: 'CALL', amountBB: 1 },
      { position: 'CO', type: 'CALL', amountBB: 1 },
      { position: 'BTN', type: 'RAISE', amountBB: 8 },
      { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'FOLD' },
      { position: 'UTG', type: 'CALL', amountBB: 7 },
      { position: 'HJ', type: 'FOLD' },
      { position: 'CO', type: 'CALL', amountBB: 7 },
      ...(withChecks
        ? [
            { position: 'UTG', type: 'CHECK' },
            { position: 'CO', type: 'CHECK' },
          ]
        : []),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 82 },
  } as unknown as ManualHandInput;
  const parsed = parseManualInput(hand);
  if (!parsed.ok) return { stage: 'parse', issues: parsed.issues };
  const g = buildAnalyzableState(parsed.value);
  if (!g.ok) return { stage: 'state', issues: g.issues };
  const s = g.state;
  return {
    stage: 'ok',
    street: s.street,
    currentBet: s.currentBet,
    pot: s.players.reduce(
      (acc, p) => acc + p.committedByStreet.PREFLOP + p.committedByStreet.FLOP + p.ante,
      0,
    ),
    pendingQueue: s.pendingQueue,
    players: s.players.map(
      (p) => `${p.position}:${p.id}:folded=${p.folded}:stack=${p.remainingStack}`,
    ),
  };
}

console.log('=== 不含翻牌 CHECK ===');
console.log(JSON.stringify(build(false), null, 1));
console.log('=== 含翻牌 CHECK ===');
console.log(JSON.stringify(build(true), null, 1));
