/**
 * TEST 18 · 只读复核：**各动作的金额表达**（界面文案 + 金额口径三行）
 *
 * 覆盖：河牌加注（TEST 16）、转牌加注（TEST 17）、转牌面对加注并全下（TEST 18）、
 * 翻前面对 3bet、转牌无人下注（BET 节点）、以及一个真正的 CALL 节点。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const A_ = (p: string, t: string, bb?: number, s?: string): Record<string, unknown> => ({
  position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }), ...(s === undefined ? {} : { street: s }),
});
const maniac: ManualVillain = {
  seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
  observedStats: { handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null },
};
const base = { tableSize: 6, heroPosition: 'BTN', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, environment: 'MID_LOW_STAKES' };

const cases: ReadonlyArray<readonly [string, ManualHandInput]> = [
  ['TEST 16 河牌面对 10BB 领打（AA）', { ...base, heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2), A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN'), A_('BB', 'BET', 10, 'RIVER')], villain: maniac } as unknown as ManualHandInput],
  ['TEST 17 转牌面对 10BB 领打（A♣J♣）', { ...base, heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2), A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'BET', 10, 'TURN')], villain: maniac } as unknown as ManualHandInput],
  ['TEST 18 转牌面对加注到 40BB', { ...base, heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2), A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'RAISE', 40, 'TURN')], villain: maniac } as unknown as ManualHandInput],
  ['转牌无人下注（BET 节点）', { ...base, heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2), A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN')], villain: maniac } as unknown as ManualHandInput],
  ['翻前面对 3bet（AA，本街已投入 3BB）', { ...base, heroPosition: 'CO', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'RAISE', 3), A_('BTN', 'FOLD'), A_('SB', 'FOLD'), A_('BB', 'RAISE', 10)], villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain } as unknown as ManualHandInput],
  /* 需要至少一个**最终动作为 CALL** 的节点（覆盖「本次补入 / 跟注后的本街总额」两支） */
  ['转牌面对 10BB 领打（99 = 中对）', { ...base, heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2), A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'BET', 10, 'TURN')], villain: maniac } as unknown as ManualHandInput],
  ['转牌面对 10BB 领打（A♠K♠ = 空气）', { ...base, heroCards: ['As', 'Ks'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2), A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'BET', 10, 'TURN')], villain: maniac } as unknown as ManualHandInput],
];

console.log('情形 | actionZh | sizeZh | 金额三行 | warnings');
for (const [tag, input] of cases) {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { console.log(`${tag} → 失败：${r.stage}`); continue; }
  const vm = r.viewModel as unknown as Record<string, any>;
  const rows = (vm['debug']?.['math'] ?? []) as readonly { label: string; value: string }[];
  const pick = (l: string): string => rows.find((x) => x.label === l)?.value ?? '—';
  console.log(`\n【${tag}】`);
  console.log(`  actionZh = ${String(vm['actionZh'])}`);
  console.log(`  sizeZh   = ${String(vm['sizeZh'] ?? '（无）')}`);
  console.log(`  本街已投入 = ${pick('本街已投入')}`);
  console.log(`  本次再投入 = ${pick('本次再投入')} ｜ 本次下注 = ${pick('本次下注')} ｜ 本次补入 = ${pick('本次补入')}`);
  console.log(`  加注后的本街总额 = ${pick('加注后的本街总额')} ｜ 下注后 = ${pick('下注后的本街总额')} ｜ 跟注后 = ${pick('跟注后的本街总额')}`);
  console.log(`  我的剩余筹码 = ${pick('我的剩余筹码')}`);
  console.log(`  warnings = ${JSON.stringify((vm['warningsZh'] as readonly string[]) ?? [])}`);
}
