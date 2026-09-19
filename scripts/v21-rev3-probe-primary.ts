/** 小探针：无画像输入下 profileRangeEvidence 为何非 null（定位 primary 对手与 tendency） */
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { realizedOpponentIds } from '../src/domain/poker/gameState.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const F = (position: string) => ({ position, type: 'FOLD' as const });

function node(villainPlayerId: string | undefined, villain: unknown): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: ['Ah', '9h'],
    board: ['Kc', '9s', '5d', '2h', '7c'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      { position: 'UTG', type: 'CALL', amountBB: 1 },
      F('HJ'),
      { position: 'CO', type: 'CALL', amountBB: 1 },
      F('BTN'),
      F('SB'),
      { position: 'BB', type: 'CHECK' },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'UTG', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 1.5, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'FLOP' },
      { position: 'UTG', type: 'CALL', amountBB: 1.5, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'UTG', type: 'CHECK', street: 'TURN' },
      { position: 'CO', type: 'BET', amountBB: 4, street: 'TURN' },
      { position: 'BB', type: 'CALL', amountBB: 4, street: 'TURN' },
      { position: 'UTG', type: 'CALL', amountBB: 4, street: 'TURN' },
      { position: 'BB', type: 'CHECK', street: 'RIVER' },
      { position: 'UTG', type: 'CHECK', street: 'RIVER' },
      { position: 'CO', type: 'BET', amountBB: 12, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain,
    ...(villainPlayerId === undefined ? {} : { villainPlayerId }),
  } as unknown as ManualHandInput;
}

for (const [label, villainPlayerId, villain] of [
  ['villain={} ，无 villainPlayerId', undefined, {}],
  ['villain={} ，villainPlayerId=seat_CO', 'seat_CO', {}],
  ['villain={quickProfile:undefined}', undefined, { stackBB: 100 }],
  ['villain 缺省（字段不存在）', 'seat_CO', undefined],
] as const) {
  const parsed = parseManualInput(node(villainPlayerId, villain));
  if (!parsed.ok) {
    console.log(`${label}: parse 失败 ${JSON.stringify(parsed.issues)}`);
    continue;
  }
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) {
    console.log(`${label}: 门槛拒绝`);
    continue;
  }
  const hero = gate.state.players.find((p) => p.holeCards !== null)!;
  const realized = realizedOpponentIds(gate.state);
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    ...(parsed.value.villain.quickProfile === undefined
      ? {}
      : { quickProfile: parsed.value.villain.quickProfile }),
    ...(villainPlayerId === undefined ? {} : { villainPlayerId }),
  });
  const ev = built.context.profileRangeEvidence ?? null;
  console.log(
    `${label}\n` +
      `   hero=${hero.id} 玩家顺序=[${gate.state.players.map((p) => p.id).join(',')}] realized=[${[...realized].join(',')}]` +
      ` parsedVillain=${JSON.stringify(parsed.value.villain)}\n` +
      `   range(首要)=${built.context.range?.opponentId ?? 'null'} evidence=${ev === null ? 'null' : `applied=${ev.provider.applied} dim=${ev.dimensionTier}`}` +
      ` opponentRanges=[${built.context.opponentRanges.map((s) => s.opponentId).join(',')}]`,
  );
}
