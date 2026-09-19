/**
 * M1 自审探针 #5（只读）—— **第一个观测**处的连续性（两种证据形态）
 *
 * 关心的是「0 手 → 1 手」这一步是否连续：
 *   D 形态（手选标签）：`hasObservedEvidence` 从 false → true ⇒ 从「标签 ×0.35」切到「标签 ×0.35×(1−w) + 实测 ×w」
 *   C 形态（动态提示，observation-only）：同一开关还会**换掉证据来源**（提示维度 → 实测维度）
 * 判据：响应刻度、betMass、RAISE EV 在 0/1/20/800 手上的走向。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A_ = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }),
});
function test16(villain: ManualVillain): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
      A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
      A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP'),
      A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN'),
      A_('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES', villain,
  } as unknown as ManualHandInput;
}

const S = (hands: number): Record<string, unknown> => ({
  handsObserved: hands, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
  foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
});
const base = { seatId: 'seat_BB', persistentPlayerId: 'p1', stackBB: 100 };
const n = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));

function row(tag: string, v: ManualVillain): string {
  const r = analyzeManualHand(test16(v), OPTIONS);
  if (!r.ok) return `  ${tag.padEnd(24)}失败：${r.stage}`;
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  const pf = (dg['postflop'] ?? {}) as Record<string, any>;
  const rr = pf['raiseResponse'] as Record<string, any>;
  const nm = String(rr?.['model']?.['noteZh'] ?? '');
  const g = (k: string): number => Number(new RegExp(`${k}\\s+([0-9.]+)`).exec(nm)?.[1] ?? NaN);
  return `  ${tag.padEnd(24)}${`${n(g('callScale'))}/${n(g('foldScale'))}/${n(g('raiseScale'))}`.padEnd(22)}${n(pf['bettingRangeFacts']?.['betMass'], 9).padStart(14)}${n(rr?.['raiseEV'], 4).padStart(12)}${n((dg['math'] ?? {})['callEV'], 4).padStart(12)}`;
}

console.log('\n=== M1 探针 #5：第一个观测处的连续性 ===');
console.log('  ' + '情形'.padEnd(22) + 'call/fold/raise'.padEnd(22) + 'betMass'.padStart(14) + 'RAISE EV'.padStart(12) + 'CALL EV'.padStart(12));
console.log('  D 形态（MANIAC 标签）：');
console.log(row('D · 0 手（纯标签）', { ...base, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN' }));
for (const h of [1, 20, 800]) {
  console.log(row(`D · ${h} 手`, { ...base, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', observedStats: S(h) as never }));
}
console.log('  C 形态（TILT_SIGNAL 动态提示，无标签）：');
console.log(row('C · 0 手（只有提示）', { ...base, dynamicHint: 'TILT_SIGNAL' }));
for (const h of [1, 20, 800]) {
  console.log(row(`C · ${h} 手`, { ...base, dynamicHint: 'TILT_SIGNAL', observedStats: S(h) as never }));
}
console.log('');
