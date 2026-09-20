/**
 * P1-2a 场景调试（只读）：打印每个场景的真实资金与分支，用于修正测试表的手算值。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { computePot, minRaiseTo } from '../src/domain/poker/gameState.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_261_014, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A = (position: string, type: string, amountBB?: number, street?: string) => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

function riverFacingBet(btn: number, bb: number, riverBet: number, heroCards: [string, string] = ['As', 'Ks']): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards,
    board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
    effectiveStackBB: Math.min(btn, bb), bigBlindBB: 2,
    seatStacksBB: { UTG: btn, HJ: btn, CO: btn, BTN: btn, SB: btn, BB: bb },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', riverBet, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: bb },
  } as unknown as ManualHandInput;
}

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 1): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');

const cases: [string, ManualHandInput][] = [
  ['A 100/200 river10', riverFacingBet(100, 200, 10)],
  ['B 60/100 river20', riverFacingBet(60, 100, 20)],
  ['C 100/30 river10 (P0-7)', riverFacingBet(100, 30, 10)],
  ['D 100/100 river10 (KQ)', riverFacingBet(100, 100, 10, ['Ks', 'Qs'])],
  ['E 200/200 river20', riverFacingBet(200, 200, 20)],
  ['F 100/40 river10', riverFacingBet(100, 40, 10)],
  ['G 100/73 river10', riverFacingBet(100, 73, 10)],
];

line('场景                        对手剩余  他要补raw  R     heroAdd  villainAdd  contested  退回  全下byCall  Hero全下  P(弃)/P(跟)/P(再加)');
for (const [tag, input] of cases) {
  const parsed = parseManualInput(input);
  if (!parsed.ok) { line(`${tag}  解析失败 ${JSON.stringify(parsed.issues)}`); continue; }
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) { line(`${tag}  重建失败 ${JSON.stringify(gate.issues?.[0])}`); continue; }
  const st = gate.state;
  const v = st.players.find((p) => p.id !== st.userPlayerId && !p.folded)!;
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { line(`${tag}  分析失败 ${r.stage}`); continue; }
  const dg = ((r.decision as unknown as Record<string, unknown>)['diagnostics'] as Record<string, any>);
  const f = ((dg['postflop'] ?? {})['raiseResponse'] ?? null) as Record<string, any> | null;
  if (f === null) {
    line(`${tag}  底池 ${n(computePot(st), 0)}｜对手剩余 ${n(v.remainingStack, 0)}｜最小加注到 ${n(minRaiseTo(st), 0)}｜**没有加注事实**`);
    continue;
  }
  line(
    tag.padEnd(26) +
    n(v.remainingStack, 0).padStart(8) +
    n(f['villainAddRaw'], 0).padStart(9) +
    n(f['sizeChips'], 0).padStart(6) +
    n(f['heroAdd'], 0).padStart(9) +
    n(f['villainAdd'], 0).padStart(11) +
    n(f['heroContestedAdd'], 0).padStart(10) +
    n(f['uncalledReturn'], 0).padStart(6) +
    String((f['model'] as Record<string, unknown>)['villainIsAllInByCall']).padStart(11) +
    String((f['model'] as Record<string, unknown>)['heroIsAllIn']).padStart(9) +
    `   ${n(f['foldLikelihood'], 4)}/${n(f['callLikelihood'], 4)}/${n(f['reRaiseLikelihood'], 4)}`,
  );
}
