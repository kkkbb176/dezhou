/* 诊断 2：`toValidatorSnapshots` 为什么产出 0？逐次 `makeSnapshot` 的返回值打出来。 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parsePhh, seatPositionsOf, bigBlindChipsOf } from '../src/domain/realHands/phh.ts';
import { toValidatorSnapshots, lastLegalFailure } from '../src/domain/realHands/phhToEngineInput.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { reconstructGameState, ReconstructMode } from '../src/app/manualInput/reconstruct.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';

const dir = join(process.cwd(), 'third_party', 'phh-dataset', '100');
const files = readdirSync(dir).filter((f) => f.endsWith('.phh')).slice(0, 2);

for (const f of files) {
  const raw = readFileSync(join(dir, f), 'utf8');
  const parsed = parsePhh(raw);
  console.log(`\n=== ${f} ===`);
  if (!parsed.ok) {
    console.log(`  解析失败 ${parsed.reason}`);
    continue;
  }
  const hand = parsed.hand;
  console.log(`  位置 = ${seatPositionsOf(hand)?.join(',')}  bb=${bigBlindChipsOf(hand)}`);
  const snaps = toValidatorSnapshots(hand);
  console.log(`  快照数 = ${snaps.length}`);
  console.log(`  最后失败原因 = ${lastLegalFailure === null ? '（无）' : `${lastLegalFailure.where} :: ${lastLegalFailure.ui.join(' ｜ ')}`}`);

  /* 手动重放，找出第一个「公共牌 ≥3 且底牌已知」的节点，看它为什么没产出 */
  let boardCount = 0;
  const holes = new Map<number, string>();
  for (const a of hand.actions) {
    if (a.kind === 'DEAL_HOLE') holes.set(a.playerIndex, a.cards.join(''));
    if (a.kind === 'DEAL_BOARD') boardCount += a.cards.length;
    if ((a.kind === 'FOLD' || a.kind === 'CHECK_OR_CALL' || a.kind === 'BET_OR_RAISE_TO') && boardCount >= 3) {
      const idx = a.playerIndex;
      const cards = holes.get(idx);
      console.log(`  节点 ${a.kind} p${idx + 1} 底牌=${cards ?? '未知'} 公共牌=${boardCount} 张`);
      if (cards !== undefined) {
        /* 单独试一次重建：用空行动历史，看引擎能不能接受这个局面 */
        const probe = {
          tableSize: 6 as const,
          heroPosition: 'BTN' as never,
          heroCards: [cards.slice(0, 2), cards.slice(2, 4)] as readonly [string, string],
          board: ['7d', '5h', '9d'] as readonly string[],
          street: 'FLOP' as never,
          effectiveStackBB: 100,
          actionHistory: [] as never,
          environment: 'MID_LOW_STAKES' as never,
          bigBlindBB: bigBlindChipsOf(hand),
          seatStacksBB: {},
          buttonPosition: 'BTN' as never,
        };
        const p = parseManualInput(probe as never);
        console.log(`     parse(空历史).ok=${p.ok}`);
        if (p.ok) {
          const r = reconstructGameState(p.value, { mode: ReconstructMode.PREVIEW });
          console.log(`     reconstruct.ok=${r.ok}`);
          if (r.ok) console.log(`     行动者=${actorOnTurn(r.state)}`);
          else for (const i of r.issues.slice(0, 3)) console.log(`       ✖ ${i.code}: ${i.message}`);
        } else for (const i of p.issues.slice(0, 3)) console.log(`       ✖ ${i.code}: ${i.message}`);
        break;
      }
    }
  }
}
