/* 直接测量：引擎把「筹码」按什么比例还原成 BB？ */
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { reconstructGameState, ReconstructMode } from '../src/app/manualInput/reconstruct.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';

function probe(label: string, bigBlindBB: number, seatStacksBB: Record<string, number>, effectiveStackBB: number): void {
  const input = {
    tableSize: 6 as const,
    heroPosition: 'BTN' as never,
    heroCards: ['As', 'Ks'] as readonly [string, string],
    board: [] as readonly string[],
    street: 'PREFLOP' as never,
    effectiveStackBB,
    actionHistory: [] as never,
    environment: 'MID_LOW_STAKES' as never,
    bigBlindBB,
    seatStacksBB,
    buttonPosition: 'BTN' as never,
  };
  const p = parseManualInput(input as never);
  if (!p.ok) {
    console.log(`${label}: parse 失败 ${p.issues[0]?.message.slice(0, 90)}`);
    return;
  }
  const r = reconstructGameState(p.value, { mode: ReconstructMode.PREVIEW });
  if (!r.ok) {
    console.log(`${label}: reconstruct 失败 ${r.issues[0]?.message.slice(0, 110)}`);
    return;
  }
  const st = r.state;
  const id = actorOnTurn(st);
  const actor = st.players.find((x) => x.id === id);
  const l = actor === undefined ? null : deriveLegalActions(st, actor);
  console.log(
    `${label}: bbChips(config)=${st.config.bigBlind} blinds=SB${st.config.smallBlind} ` +
      `actor=${id} callCost=${l?.callCost} canRaise=${l?.canRaise} minRaiseTo=${l?.minRaiseToAmount} allInTo=${l?.allInToAmount} ` +
      `stacks=${st.players.map((x) => `${x.position}:${x.remainingStack}`).join(' ')}`,
  );
}

console.log('--- 场景 A：项目默认口径（大盲 = 100 筹码，盲注 50/100 由引擎自己定）---');
probe('A bigBlindBB=100', 100, { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, 100);

console.log('\n--- 场景 B：把「1BB = 1 筹码」硬塞进去 ---');
probe('B bigBlindBB=2 (最小值)', 2, { UTG: 50, HJ: 50, CO: 50, BTN: 50, SB: 50, BB: 50 }, 50);

console.log('\n--- 场景 D（拟采用）：bigBlindBB=100，一切按「真实大盲 = B 筹码」换算 ---');
{
  const B = 100; // 真实大盲筹码数
  const bigBlindBB = 100;
  const toBB = (chips: number): number => chips / B;
  const input = {
    tableSize: 6 as const,
    heroPosition: 'BTN' as never,
    heroCards: ['As', 'Ks'] as readonly [string, string],
    board: [] as readonly string[],
    street: 'PREFLOP' as never,
    effectiveStackBB: toBB(10000),
    /* 真实：SB 50、BB 100、UTG 加到 210、SB 弃、BB 弃 */
    actionHistory: [
      { position: 'UTG', type: 'RAISE', amountBB: toBB(210), street: 'PREFLOP' },
      { position: 'SB', type: 'FOLD', street: 'PREFLOP' },
      { position: 'BB', type: 'FOLD', street: 'PREFLOP' },
    ] as never,
    environment: 'MID_LOW_STAKES' as never,
    bigBlindBB,
    seatStacksBB: { UTG: toBB(10000), HJ: toBB(10000), CO: toBB(10000), BTN: toBB(10000), SB: toBB(10000), BB: toBB(10000) } as never,
    buttonPosition: 'BTN' as never,
  };
  const p = parseManualInput(input as never);
  if (!p.ok) {
    console.log(`D: parse 失败 ${p.issues[0]?.message.slice(0, 120)}`);
  } else {
    const r = reconstructGameState(p.value, { mode: ReconstructMode.PREVIEW });
    if (!r.ok) {
      console.log(`D: reconstruct 失败 ${r.issues.map((i) => i.code).join(',')} ${r.issues[0]?.message.slice(0, 120)}`);
    } else {
      const st = r.state;
      const id = actorOnTurn(st);
      const actor = st.players.find((x) => x.id === id);
      const l = actor === undefined ? null : deriveLegalActions(st, actor);
      console.log(
        `D: actor=${id} callCost=${l?.callCost} minRaiseTo=${l?.minRaiseToAmount} allInTo=${l?.allInToAmount}\n` +
          `   stacks=${st.players.map((x) => `${x.position}:${x.remainingStack}`).join(' ')}\n` +
          `   本街投入=${st.players.map((x) => `${x.position}:${x.committedByStreet['PREFLOP']}`).join(' ')}`,
      );
      console.log(`   ⇒ callCost 期望 = 110（= 210 − 100），minRaiseTo 期望 = 320（= 210 + 110）`);
    }
  }
}
