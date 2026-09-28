/* 诊断：为什么真实牌局产不出决策点？逐条件打出来。 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parsePhh, seatPositionsOf, bigBlindChipsOf, parsePhhAction } from '../src/domain/realHands/phh.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { reconstructGameState, ReconstructMode } from '../src/app/manualInput/reconstruct.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { TableSize, type Position } from '../src/domain/types.ts';

const dir = join(process.cwd(), 'third_party', 'phh-dataset', '100');
const files = readdirSync(dir).filter((f) => f.endsWith('.phh')).slice(0, 3);

for (const f of files) {
  const raw = readFileSync(join(dir, f), 'utf8');
  const parsed = parsePhh(raw);
  console.log(`\n=== ${f} ===`);
  if (!parsed.ok) {
    console.log(`  解析失败 ${parsed.reason} ${parsed.detail}`);
    continue;
  }
  const hand = parsed.hand;
  console.log(`  players=${hand.players.length} blinds=${JSON.stringify(hand.blindsOrStraddles)} bb=${bigBlindChipsOf(hand)}`);
  const pos = seatPositionsOf(hand);
  console.log(`  位置映射 = ${pos === null ? 'null（拒绝）' : pos.join(',')}`);
  console.log(`  动作数 = ${hand.actions.length}`);

  /* 逐条重放，打印牌数与街道推进 */
  let boardCount = 0;
  const holes = new Map<number, string>();
  for (const a of hand.actions.slice(0, 40)) {
    if (a.kind === 'DEAL_HOLE') holes.set(a.playerIndex, a.cards.join(''));
    if (a.kind === 'DEAL_BOARD') {
      boardCount += a.cards.length;
      console.log(`   + 公共牌 ${a.cards.join(' ')} ⇒ 共 ${boardCount} 张`);
    }
  }
  console.log(`  底牌已知 = ${[...holes.entries()].map(([i, c]) => `p${i + 1}:${c}`).join(' ')}`);

  /* 试造一个 3 张公共牌的输入，看引擎能不能重建 */
  const firstHole = [...holes.entries()][0]!;
  const positions = pos ?? [];
  const heroPos = (positions[firstHole[0]] ?? 'BTN') as Position;
  const input = {
    tableSize: hand.players.length as TableSize,
    heroPosition: heroPos,
    heroCards: [firstHole[1].slice(0, 2), firstHole[1].slice(2, 4)] as readonly [string, string],
    board: ['7d', '5h', '9d'] as readonly string[],
    street: 'FLOP' as never,
    effectiveStackBB: 100,
    actionHistory: [] as never,
    environment: 'MID_LOW_STAKES' as never,
    bigBlindBB: bigBlindChipsOf(hand),
    seatStacksBB: {},
    buttonPosition: 'BTN' as Position,
  };
  const p = parseManualInput(input as never);
  console.log(`  parseManualInput.ok = ${p.ok}`);
  if (!p.ok) {
    for (const i of p.issues.slice(0, 5)) console.log(`     ✖ ${i.code}: ${i.message}`);
    continue;
  }
  const r = reconstructGameState(p.value, { mode: ReconstructMode.PREVIEW });
  console.log(`  reconstructGameState.ok = ${r.ok}`);
  if (!r.ok) {
    for (const i of r.issues.slice(0, 5)) console.log(`     ✖ ${i.code}: ${i.message}`);
    continue;
  }
  const id = actorOnTurn(r.state);
  console.log(`  行动者 = ${id}`);
  const actor = r.state.players.find((x) => x.id === id);
  if (actor !== undefined) {
    const l = deriveLegalActions(r.state, actor);
    console.log(`  合法: check=${l.canCheck} call=${l.callCost} canRaise=${l.canRaise} minTo=${l.minRaiseToAmount} allInTo=${l.allInToAmount}`);
  }
  void parsePhhAction;
}
