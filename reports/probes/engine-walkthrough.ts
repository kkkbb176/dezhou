/**
 * 实战走查：挑 14 个有代表性的局面，打印引擎的实际建议与关键数字，供人工判断。
 *
 * 与 `engine-field-test.ts`（537 局面 × 17 项不变量）互补：
 * 那个脚本证明「自洽 + 不违反常识」，这个脚本让**人**能直接看打法。
 *
 * ⚠️ 只读。
 *
 * ```powershell
 * node --experimental-strip-types reports/probes/engine-walkthrough.ts
 * ```
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
const F = (p: Position, s: Street = Street.PREFLOP): Action => ({ position: p, type: 'FOLD', street: s }) as Action;
const R = (p: Position, a: number, s = Street.PREFLOP): Action => ({ position: p, type: 'RAISE', amountBB: a, street: s }) as Action;
const C = (p: Position, a: number, s = Street.PREFLOP): Action => ({ position: p, type: 'CALL', amountBB: a, street: s }) as Action;
const CK = (p: Position, s: Street): Action => ({ position: p, type: 'CHECK', street: s }) as Action;
const B = (p: Position, a: number, s: Street): Action => ({ position: p, type: 'BET', amountBB: a, street: s }) as Action;
const i9 = (p: Position): number => O9.indexOf(p);
const foldsBefore = (p: Position): Action[] => O9.slice(0, i9(p)).map((x) => F(x));
const blind: Partial<Record<Position, number>> = { [Position.SB]: 0.5, [Position.BB]: 1 };

const mk = (o: Partial<ManualHandInput>): ManualHandInput => ({
  tableSize: 9, heroPosition: Position.BTN, heroCards: ['As', 'Kd'], board: [], street: Street.PREFLOP,
  effectiveStackBB: 100, bigBlindBB: 100, environment: GameEnvironment.LOW_STAKES_ONLINE,
  occupiedPositions: [...O9], buttonPosition: Position.BTN, actionHistory: [], ...o,
} as ManualHandInput);

const hu = (opener: Position, caller: Position): Action[] => {
  const h = [...foldsBefore(opener), R(opener, 3)];
  for (let i = i9(opener) + 1; i < i9(caller); i++) h.push(F(O9[i]!));
  h.push(C(caller, 3 - (blind[caller] ?? 0)));
  for (let i = i9(caller) + 1; i < O9.length; i++) h.push(F(O9[i]!));
  return h;
};

const spots: [string, ManualHandInput][] = [
  ['① 翻前 BTN ♠A♠K 面对 CO 开池 2.5BB（100BB）',
    mk({ heroPosition: Position.BTN, heroCards: ['As', 'Ks'], actionHistory: [...foldsBefore(Position.CO), R(Position.CO, 2.5)] })],
  ['② 翻前 BB ♠7♦2 面对 BTN 开池（100BB）',
    mk({ heroPosition: Position.BB, heroCards: ['7s', '2d'], actionHistory: [...foldsBefore(Position.BTN), R(Position.BTN, 2.5), F(Position.SB)] })],
  ['③ 翻前 CO ♠A♥A 开池后被 BB 3Bet 到 10BB（100BB）',
    mk({ heroPosition: Position.CO, heroCards: ['As', 'Ah'], actionHistory: [...foldsBefore(Position.CO), R(Position.CO, 2.5), F(Position.BTN), F(Position.SB), R(Position.BB, 10)] })],
  ['④ 翻前 BB ♠A♥A 面对 BTN 开池，15BB 短码',
    mk({ heroPosition: Position.BB, heroCards: ['As', 'Ah'], effectiveStackBB: 15, actionHistory: [...foldsBefore(Position.BTN), R(Position.BTN, 2.5), F(Position.SB)] })],
  ['⑤ 翻牌 K♥8♣3♦ BB ♠A♣K 面对 CO 1/2 池（OOP）',
    mk({ heroPosition: Position.BB, heroCards: ['As', 'Kc'], board: ['Kh', '8c', '3d'], street: Street.FLOP,
      actionHistory: [...hu(Position.CO, Position.BB), CK(Position.BB, Street.FLOP), B(Position.CO, 3.3, Street.FLOP)] })],
  ['⑥ 翻牌 K♥8♣3♦ BTN ♠A♣K 被过牌到（IP）',
    mk({ heroPosition: Position.BTN, heroCards: ['As', 'Kc'], board: ['Kh', '8c', '3d'], street: Street.FLOP,
      actionHistory: [...hu(Position.CO, Position.BTN), CK(Position.CO, Street.FLOP)] })],
  ['⑦ 翻牌 Q♥8♥4♣ BB ♥A♥T 同花听牌 面对满池（OOP）',
    mk({ heroPosition: Position.BB, heroCards: ['Ah', 'Th'], board: ['Qh', '8h', '4c'], street: Street.FLOP,
      actionHistory: [...hu(Position.CO, Position.BB), CK(Position.BB, Street.FLOP), B(Position.CO, 6.5, Street.FLOP)] })],
  ['⑧ 翻牌 9♥9♣2♦ BB ♦3♠2 空气 面对 1/3 池（OOP）',
    mk({ heroPosition: Position.BB, heroCards: ['3d', '2s'], board: ['9h', '9c', '2d'], street: Street.FLOP,
      actionHistory: [...hu(Position.CO, Position.BB), CK(Position.BB, Street.FLOP), B(Position.CO, 2.2, Street.FLOP)] })],
  ['⑨ 转牌 Q♥8♥4♣2♠ BTN ♥A♥T 同花听牌 面对 2/3 池（IP）',
    mk({ heroPosition: Position.BTN, heroCards: ['Ah', 'Th'], board: ['Qh', '8h', '4c', '2s'], street: Street.TURN,
      actionHistory: [...hu(Position.CO, Position.BTN), CK(Position.CO, Street.FLOP), CK(Position.BTN, Street.FLOP), B(Position.CO, 4.3, Street.TURN)] })],
  ['⑩ 河牌 K♥8♣3♦2♠7♥ BB ♠A♣K 面对满池（OOP）',
    mk({ heroPosition: Position.BB, heroCards: ['As', 'Kc'], board: ['Kh', '8c', '3d', '2s', '7h'], street: Street.RIVER,
      actionHistory: [...hu(Position.CO, Position.BB), CK(Position.BB, Street.FLOP), CK(Position.CO, Street.FLOP),
        CK(Position.BB, Street.TURN), CK(Position.CO, Street.TURN), CK(Position.BB, Street.RIVER), B(Position.CO, 10.8, Street.RIVER)] })],
  ['⑪ 河牌 Q♥8♥4♣2♠9♦ BB ♦3♠2 空气 面对满池（OOP）',
    mk({ heroPosition: Position.BB, heroCards: ['3d', '2c'], board: ['Qh', '8h', '4c', '2s', '9d'], street: Street.RIVER,
      actionHistory: [...hu(Position.CO, Position.BB), CK(Position.BB, Street.FLOP), CK(Position.CO, Street.FLOP),
        CK(Position.BB, Street.TURN), CK(Position.CO, Street.TURN), CK(Position.BB, Street.RIVER), B(Position.CO, 10.8, Street.RIVER)] })],
  ['⑫ 河牌 K♥8♣3♦2♠7♥ BTN ♠A♣K 被过牌到（IP，薄价值）',
    mk({ heroPosition: Position.BTN, heroCards: ['As', 'Kc'], board: ['Kh', '8c', '3d', '2s', '7h'], street: Street.RIVER,
      actionHistory: [...hu(Position.CO, Position.BTN), CK(Position.CO, Street.FLOP), CK(Position.BTN, Street.FLOP),
        CK(Position.CO, Street.TURN), CK(Position.BTN, Street.TURN), CK(Position.CO, Street.RIVER)] })],
  ['⑬ 翻牌 K♥8♣3♦ 三人池 BTN ♠A♣K 面对 CO 下注',
    mk({ heroPosition: Position.BTN, heroCards: ['As', 'Kc'], board: ['Kh', '8c', '3d'], street: Street.FLOP,
      actionHistory: [...foldsBefore(Position.HJ), R(Position.HJ, 3), C(Position.CO, 3), C(Position.BTN, 3),
        F(Position.SB), C(Position.BB, 2), CK(Position.BB, Street.FLOP), CK(Position.HJ, Street.FLOP), B(Position.CO, 5, Street.FLOP)] })],
  ['⑭ 翻牌 K♥8♣3♦ BB ♠8♥8 暗三条 面对 1/3 池（OOP）',
    mk({ heroPosition: Position.BB, heroCards: ['8h', '8d'], board: ['Kh', '8c', '3d'], street: Street.FLOP,
      actionHistory: [...hu(Position.CO, Position.BB), CK(Position.BB, Street.FLOP), B(Position.CO, 2.2, Street.FLOP)] })],
];

for (const [name, input] of spots) {
  const r = analyzeManualHand(input, { rules: RULES });
  console.log(`\n${name}`);
  if (!r.ok) { console.log(`   不可分析：${r.issues.map((i) => i.code).join(',')}`); continue; }
  if (r.decision.action === null) { console.log('   拒绝给建议（无人入池 ⇒ 无对手范围）'); continue; }
  const d = r.decision.diagnostics;
  const m = d.math;
  const shape = d.actionShape;
  const call = d.candidates.find((c) => c.action === 'CALL');
  const raise = d.candidates.filter((c) => (c.action === 'RAISE' || c.action === 'ALL_IN') && c.ev !== null)
    .sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0))[0];
  const best = d.candidates.filter((c) => c.ev !== null).sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0))[0];
  console.log(`   建议：${String(r.decision.action)}${shape?.sizeChips ? ` → ${(shape.sizeChips / 100).toFixed(1)}BB` : ''}` +
    `   ｜底池 ${(m.pot / 100).toFixed(2)}BB  需补 ${(m.callCost / 100).toFixed(2)}BB  门槛 ${m.requiredEquity === null ? '—' : (m.requiredEquity * 100).toFixed(1) + '%'}` +
    `   ｜SPR ${typeof m.spr === 'number' ? m.spr.toFixed(2) : '—'}  牌力 ${String(m.handRankZh ?? '—')}`);
  console.log(`   EV：跟注 ${call?.ev === null || call?.ev === undefined ? '—' : call.ev.toFixed(2)}` +
    `   最佳加注 ${raise?.ev === undefined ? '—' : `${(raise.sizeChips! / 100).toFixed(1)}BB=${raise.ev.toFixed(2)}`}` +
    `   全场最高 ${best === undefined ? '—' : `${String(best.action)}${best.sizeChips ? '@' + (best.sizeChips / 100).toFixed(1) + 'BB' : ''}=${(best.ev ?? 0).toFixed(2)}`}`);
}
