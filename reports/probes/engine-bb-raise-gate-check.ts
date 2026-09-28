/**
 * 验证假设：**只有"我之后无人行动"的节点才会构建翻前加注事实包**
 * ⇒ 只有那些节点会跑「弃牌率主导的加注 EV」⇒ 只有 BB 节点出现「任何两张都建议加注」。
 *
 * ⚠️ 只读。运行 < 10 秒（只跑 8 个局面）。
 */

import { Position, Street } from '../../src/domain/types.ts';
import { GameEnvironment } from '../../src/domain/range/gameEnvironment.ts';
import { loadKnowledgeBaseOrThrow } from '../../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../../src/app/manualInput/manualInput.ts';
import { analyzeManualHand } from '../../src/app/alphaPipeline.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const O9: readonly Position[] = [
  Position.UTG, Position.UTG1, Position.UTG2, Position.LJ, Position.HJ,
  Position.CO, Position.BTN, Position.SB, Position.BB,
];
type Action = ManualHandInput['actionHistory'][number];
const F = (p: Position): Action => ({ position: p, type: 'FOLD', street: Street.PREFLOP }) as Action;
const R = (p: Position, a: number): Action => ({ position: p, type: 'RAISE', amountBB: a, street: Street.PREFLOP }) as Action;
const i9 = (p: Position): number => O9.indexOf(p);

const spot = (hero: Position, opener: Position, cards: [string, string]): ManualHandInput => {
  const h: Action[] = O9.slice(0, i9(opener)).map((p) => F(p));
  h.push(R(opener, 2.5));
  for (let i = i9(opener) + 1; i < i9(hero); i++) h.push(F(O9[i]!));
  return {
    tableSize: 9, heroPosition: hero, heroCards: cards, board: [], street: Street.PREFLOP,
    effectiveStackBB: 100, bigBlindBB: 100, environment: GameEnvironment.LOW_STAKES_ONLINE,
    occupiedPositions: [...O9], buttonPosition: Position.BTN, actionHistory: h,
  } as ManualHandInput;
};

console.log('局面                    身后待行动  加注事实包  建议        加注EV');
console.log('─'.repeat(76));
for (const [label, hero, opener, cards] of [
  ['BB  vs BTN 开池 (72o)', Position.BB, Position.BTN, ['7s', '2d']],
  ['BB  vs BTN 开池 (AA)', Position.BB, Position.BTN, ['As', 'Ah']],
  ['SB  vs BTN 开池 (72o)', Position.SB, Position.BTN, ['7s', '2d']],
  ['BTN vs CO  开池 (72o)', Position.BTN, Position.CO, ['7s', '2d']],
  ['CO  vs HJ  开池 (72o)', Position.CO, Position.HJ, ['7s', '2d']],
  ['BB  vs CO  开池 (72o)', Position.BB, Position.CO, ['7s', '2d']],
  ['BB  vs UTG 开池 (72o)', Position.BB, Position.UTG, ['7s', '2d']],
  ['BB  vs UTG 开池 (AA)', Position.BB, Position.UTG, ['As', 'Ah']],
] as [string, Position, Position, [string, string]][]) {
  const r = analyzeManualHand(spot(hero, opener, cards), { rules: RULES });
  if (!r.ok) { console.log(`  ${label} 失败 ${r.issues.map((i) => i.code).join(',')}`); continue; }
  const d = r.decision.diagnostics;
  const pr = d.preflopRaise;
  const best = d.candidates
    .filter((c) => (c.action === 'RAISE' || c.action === 'ALL_IN') && c.ev !== null)
    .sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0))[0];
  console.log(
    `  ${label.padEnd(22)} ${String(d.playersRemainingToAct).padStart(6)}      ` +
      `${(pr === null || pr === undefined ? '无' : '有').padStart(6)}      ` +
      `${String(r.decision.action).padEnd(6)}  ` +
      `${best?.ev === undefined || best.ev === null ? '—' : `${(best.sizeChips! / 100).toFixed(1)}BB ${best.ev.toFixed(1)}`}`,
  );
}
