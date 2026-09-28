/**
 * 根因定位：为什么"任何两张牌都建议 3Bet"？
 *
 * 假设：加注 EV 的**主导项是弃牌率**，而弃牌率是**公共信息模型**（不读我的底牌）
 * ⇒ 该项对所有手牌**几乎相同** ⇒ 只要先验弃牌率足够高，**每一手**都变成「+EV 加注」。
 *
 * 本脚本验证该假设，并检查是否在**所有位置**都成立。
 *
 * ⚠️ 只读。
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

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const allKeys = (): string[] => {
  const out: string[] = [];
  for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
    if (i === j) out.push(RANKS[i]! + RANKS[j]!);
    else if (i < j) out.push(RANKS[i]! + RANKS[j]! + 's', RANKS[i]! + RANKS[j]! + 'o');
  }
  return out;
};
const cardsOf = (k: string): [string, string] =>
  k.length === 2 ? [`${k[0]}s`, `${k[1]}h`] : [k[0] + 's', k[1] + (k.endsWith('s') ? 's' : 'h')];

console.log('════════ 加注 EV 的分解（BB 面对 BTN 开池 2.5BB）════════\n');
for (const k of ['AA', 'AKs', 'QQ', 'KJo', 'T9s', '72o', '32o']) {
  const r = analyzeManualHand(spot(Position.BB, Position.BTN, cardsOf(k)), { rules: RULES });
  if (!r.ok || r.decision.action === null) { console.log(`  ${k}: 不可分析`); continue; }
  const cands = r.decision.diagnostics.candidates
    .filter((c) => (c.action === 'RAISE' || c.action === 'ALL_IN') && c.ev !== null && c.evBranches)
    .sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0));
  const best = cands[0]!;
  const b = best.evBranches!;
  const call = r.decision.diagnostics.candidates.find((c) => c.action === 'CALL');
  console.log(
    `  ${k.padEnd(4)} 建议=${String(r.decision.action).padEnd(5)}` +
      ` 加注 ${(best.sizeChips! / 100).toFixed(1)}BB EV=${best.ev!.toFixed(1)}` +
      ` ｜弃=${(b.fold * 100).toFixed(1)}% 跟=${(b.call * 100).toFixed(1)}% 再加=${(b.reRaise * 100).toFixed(1)}%` +
      ` ｜对跟注范围权益=${b.equity === null ? '—' : (b.equity * 100).toFixed(1)}%` +
      ` ｜跟注EV=${call?.ev === null || call?.ev === undefined ? '—' : call.ev.toFixed(1)}`,
  );
}

console.log('\n════════ 各位置是否都"任何两张都加注" ════════\n');
const combos: [string, Position, Position][] = [
  ['BB vs BTN 开池', Position.BB, Position.BTN],
  ['SB vs BTN 开池', Position.SB, Position.BTN],
  ['BTN vs CO 开池', Position.BTN, Position.CO],
  ['CO vs HJ 开池', Position.CO, Position.HJ],
];
const keys = allKeys();
for (const [label, hero, opener] of combos) {
  let raise = 0; let call = 0; let fold = 0; let none = 0;
  let minRaiseEV = Number.POSITIVE_INFINITY;
  for (const k of keys) {
    const r = analyzeManualHand(spot(hero, opener, cardsOf(k)), { rules: RULES });
    if (!r.ok || r.decision.action === null) { none++; continue; }
    const a = String(r.decision.action);
    if (a === 'RAISE' || a === 'ALL_IN') {
      raise++;
      const best = r.decision.diagnostics.candidates
        .filter((c) => (c.action === 'RAISE' || c.action === 'ALL_IN') && c.ev !== null)
        .sort((x, y) => (y.ev ?? 0) - (x.ev ?? 0))[0];
      if (best?.ev !== undefined && best.ev !== null) minRaiseEV = Math.min(minRaiseEV, best.ev);
    } else if (a === 'CALL') call++;
    else fold++;
  }
  console.log(
    `  ${label.padEnd(16)} 加注 ${String(raise).padStart(3)}/169 ｜跟注 ${String(call).padStart(3)} ｜弃牌 ${String(fold).padStart(3)}` +
      ` ｜无建议 ${none} ｜最低"最佳加注 EV"=${Number.isFinite(minRaiseEV) ? minRaiseEV.toFixed(1) : '—'}`,
  );
}

console.log('\n════════ 弃牌率是否随我的手牌变化（不该变）════════\n');
for (const k of ['AA', '72o']) {
  for (const [label, hero, opener] of combos) {
    const r = analyzeManualHand(spot(hero, opener, cardsOf(k)), { rules: RULES });
    if (!r.ok || r.decision.action === null) continue;
    const best = r.decision.diagnostics.candidates
      .filter((c) => (c.action === 'RAISE' || c.action === 'ALL_IN') && c.ev !== null && c.evBranches)
      .sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0))[0];
    if (best?.evBranches === undefined) continue;
    console.log(`  ${k.padEnd(4)} ${label.padEnd(16)} 弃=${(best.evBranches.fold * 100).toFixed(2)}%  EV=${best.ev!.toFixed(1)}`);
  }
}
