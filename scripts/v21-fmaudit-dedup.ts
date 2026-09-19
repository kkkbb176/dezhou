/**
 * V21 画像审计 —— 决策层去重信号探针（item 12 的机制验证）
 *
 * 问题：`postflopAdvisor` 用 `context.profileRangeEvidence?.provider.applied` 作为
 * 「画像已进入范围 ⇒ 抓诈唬偏移记 0」的判据（`src/app/decision/postflopAdvisor.ts:468-475`）。
 * 若画像确实改了范围、却拿不到那个证据对象，就会**同一份画像计两遍**。
 *
 * 做法：直接调用生产函数 `advisePostflop(context, ...)`，打印
 * `exploit.bluffCatchDelta` / `exploit.deDuplicated`，并在单挑 / 多人（画像家是否首要对手）
 * 两种结构下对比。
 *
 * 用法：node --experimental-strip-types scripts/v21-fmaudit-dedup.ts
 */

import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { advisePostflop } from '../src/app/decision/postflopAdvisor.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEATS9 = {
  UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
  CO: 100, BTN: 100, SB: 100, BB: 100,
} as const;

const golden = (quickProfile?: string): ManualHandInput =>
  ({
    tableSize: 9,
    heroPosition: 'CO',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS9 },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
      { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
      { position: 'HJ', type: 'FOLD' }, { position: 'CO', type: 'RAISE', amountBB: 2.5 },
      { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'CALL', amountBB: 1.5 },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'CO', type: 'CHECK', street: 'TURN' },
      { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { dynamicHint: 'UNKNOWN', stackBB: 100, ...(quickProfile === undefined ? {} : { quickProfile }) },
  }) as unknown as ManualHandInput;

const fourHanded = (villain: Record<string, unknown>): ManualHandInput =>
  ({
    tableSize: 9,
    heroPosition: 'BB',
    heroCards: ['Kh', 'Qh'],
    board: ['Kc', '9s', '5d', '2h', '7c'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    occupiedPositions: ['CO', 'BTN', 'SB', 'BB'],
    seatStacksBB: { ...SEATS9 },
    actionHistory: [
      { position: 'CO', type: 'CALL', amountBB: 1 },
      { position: 'BTN', type: 'CALL', amountBB: 1 },
      { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'CHECK' },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'CHECK', street: 'FLOP' },
      { position: 'BTN', type: 'BET', amountBB: 2, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
      { position: 'CO', type: 'CALL', amountBB: 2, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'CO', type: 'CHECK', street: 'TURN' },
      { position: 'BTN', type: 'CHECK', street: 'TURN' },
      { position: 'BB', type: 'CHECK', street: 'RIVER' },
      { position: 'CO', type: 'CHECK', street: 'RIVER' },
      { position: 'BTN', type: 'BET', amountBB: 6, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { dynamicHint: 'UNKNOWN', stackBB: 100, ...villain },
  }) as unknown as ManualHandInput;

function probe(label: string, input: ManualHandInput): void {
  const parsed = parseManualInput(input);
  if (!parsed.ok) {
    console.log(`${label}: PARSE FAIL ${JSON.stringify(parsed.issues)}`);
    return;
  }
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) {
    console.log(`${label}: STATE FAIL ${JSON.stringify(gate.issues)}`);
    return;
  }
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    budget: { softMs: 120_000, hardMs: 240_000 },
    equitySeed: 20260913,
    ...(parsed.value.villain.quickProfile === undefined ? {} : { quickProfile: parsed.value.villain.quickProfile }),
    ...(parsed.value.villain.playerId === undefined ? {} : { villainPlayerId: parsed.value.villain.playerId }),
  });
  const ctx = built.context;
  const ev = ctx.profileRangeEvidence ?? null;
  const advice = advisePostflop(ctx, {
    facingBet: built.legal.callCost > 0,
    requiredEquity: ctx.math.requiredEquity,
    potAfterCall: ctx.math.pot + built.legal.callCost,
  });
  const ex = advice?.exploit as unknown as { bluffCatchDelta: number; deDuplicated: boolean; applied: boolean } | undefined;
  console.log(
    `${label.padEnd(58)} 权益=${(ctx.math.heroEquity ?? 0).toFixed(6)} ` +
      `首要对手=${ctx.range?.opponentId ?? '—'} realized=${ctx.realizedOpponentCount} ` +
      `evidence=${ev === null ? '无' : `有(applied=${String(ev.provider.applied)} before=${String(ev.equityBefore)} after=${String(ev.equityAfter)})`} ` +
      `| exploit: applied=${String(ex?.applied)} bluffCatchDelta=${ex === undefined ? '—' : ex.bluffCatchDelta.toFixed(6)} deDuplicated=${String(ex?.deDuplicated)}`,
  );
}

console.log('=== 决策层去重判据：context.profileRangeEvidence?.provider.applied ===');
probe('A 单挑 9-max：BLUFF_HEAVY（画像家＝首要 BB）', golden('BLUFF_HEAVY'));
probe('B 单挑 9-max：无画像', golden());
probe('C 4 人局：BLUFF_HEAVY@seat_BTN（画像家≠首要 CO）', fourHanded({ playerId: 'seat_BTN', quickProfile: 'BLUFF_HEAVY' }));
probe('D 4 人局：BLUFF_HEAVY@seat_CO（画像家＝首要 CO）', fourHanded({ playerId: 'seat_CO', quickProfile: 'BLUFF_HEAVY' }));
probe('E 4 人局：无画像', fourHanded({ playerId: 'seat_BTN' }));
