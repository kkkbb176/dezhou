/**
 * 探针：Board Delta 分类（TEST A–D 的快速核对）。
 * 用法：E:\node.exe --experimental-strip-types scripts\board-delta-probe.ts
 */
import { parseCard } from '../src/domain/poker/cards.ts';
import type { Card } from '../src/domain/types.ts';
import { computeBoardDelta, BOARD_DELTA_KIND_ZH } from '../src/domain/postflop/boardDelta.ts';

const cards = (text: string): Card[] =>
  text
    .split(' ')
    .filter((t) => t.length > 0)
    .map((t) => {
      const parsed = parseCard(t);
      if (!parsed.ok) throw new Error(`非法牌 ${t}`);
      return parsed.card;
    });

const cases: readonly { label: string; prev: string; board: string; hole: string }[] = [
  { label: 'A 固定牌局 T♠7♦2♠ → 8♦', prev: 'Ts 7d 2s', board: 'Ts 7d 2s 8d', hole: '9s 8s' },
  { label: 'B 真空白   T♠7♦2♠ → 3♣', prev: 'Ts 7d 2s', board: 'Ts 7d 2s 3c', hole: '9s 8s' },
  { label: 'C 成顺牌   T♠7♦2♠ → 8♣', prev: 'Ts 7d 2s', board: 'Ts 7d 2s 8c', hole: '9s 8s' },
  { label: 'D 成花牌   T♠7♠2♠ → 3♠', prev: 'Ts 7s 2s', board: 'Ts 7s 2s 3s', hole: '9s 8s' },
  { label: 'D2 同花听成型 T♠7♦2♠ → 3♠', prev: 'Ts 7d 2s', board: 'Ts 7d 2s 3s', hole: '9h 8h' },
];

for (const c of cases) {
  const prev = cards(c.prev);
  const board = cards(c.board);
  const hole = cards(c.hole);
  const d = computeBoardDelta({
    previousBoard: prev,
    board,
    heroHole: hole,
    street: 'TURN',
    rangeFacts: null,
    previousTier: null,
  });
  if (d === null) {
    console.log(`${c.label}: null`);
    continue;
  }
  console.log(
    `${c.label}\n` +
      `   kind=${d.kind}（${BOARD_DELTA_KIND_ZH[d.kind]}）｜blank ${d.blankScore.toFixed(3)}｜dynamic ${d.dynamicScore.toFixed(3)}\n` +
      `   连张 Δ ${d.straightDrawDelta.toFixed(3)}｜同花听 Δ ${d.flushDrawDelta.toFixed(3)}｜新成顺 ${d.classCompletion.newStraightClasses}｜新三条 ${d.classCompletion.newSetClasses}｜新两对 ${d.classCompletion.newTwoPairClasses}\n` +
      `   我方档位变化 ${d.heroRelativeStrengthChange.toFixed(2)}｜坚果偏移 ${d.nutShift.toFixed(3)}｜${d.classCompletion.noteZh}`,
  );
}
