/**
 * P1-2b 事实包探针（只读）：打印被再加注分支的全部字段。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';
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

function node(opts: { btn: number; bb: number; riverBet: number; profile?: string; heroCards?: [string, string] }): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: opts.heroCards ?? ['As', 'Ks'],
    board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
    effectiveStackBB: Math.min(opts.btn, opts.bb), bigBlindBB: 2,
    seatStacksBB: { UTG: opts.btn, HJ: opts.btn, CO: opts.btn, BTN: opts.btn, SB: opts.btn, BB: opts.bb },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', opts.riverBet, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: opts.profile ?? 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: opts.bb },
  } as unknown as ManualHandInput;
}

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));

const cases: [string, ManualHandInput][] = [
  ['深筹码 200/200 河20（CS）', node({ btn: 200, bb: 200, riverBet: 20 })],
  ['深筹码 200/200 河20（MANIAC）', node({ btn: 200, bb: 200, riverBet: 20, profile: 'MANIAC' })],
  ['小注 200/200 河2（MANIAC）', node({ btn: 200, bb: 200, riverBet: 2, profile: 'MANIAC' })],
  ['小注 200/200 河2（CS）', node({ btn: 200, bb: 200, riverBet: 2 })],
  ['小注 200/200 河2（MANIAC, 99）', node({ btn: 200, bb: 200, riverBet: 2, profile: 'MANIAC', heroCards: ['9s', '9h'] })],
  ['KQ 100/100 河10（CS）', node({ btn: 100, bb: 100, riverBet: 10, heroCards: ['Ks', 'Qs'] })],
  ['P0-7 100/30 河10（CS）', node({ btn: 100, bb: 30, riverBet: 10 })],
  ['Hero 全下 60/100 河20', node({ btn: 60, bb: 100, riverBet: 20 })],
];

line('节点                              R     rr      combos  他的再加注至 全下? 我需再投 后续终池  EqVsReraise 分支类型                    分支值     弃牌分支   跟注分支   RAISE EV');
for (const [tag, input] of cases) {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { line(`${tag}：分析失败`); continue; }
  const dg = ((r.decision as unknown as Record<string, unknown>)['diagnostics'] as Record<string, any>);
  const f = ((dg['postflop'] ?? {})['raiseResponse'] ?? null) as Record<string, any> | null;
  if (f === null) { line(`${tag}：无加注事实`); continue; }
  line(
    tag.padEnd(32) +
    String(f['sizeChips']).padStart(5) +
    n(f['reRaiseLikelihood'], 4).padStart(8) +
    String(f['reRaiseCombos'] ?? '—').padStart(8) +
    String(f['reRaiseTo'] ?? '—').padStart(12) +
    String(f['villainReRaiseIsAllIn'] ?? '—').padStart(7) +
    String(f['heroAdditionalCallVsReRaise'] ?? '—').padStart(9) +
    String(f['finalPotAfterCallVsReRaise'] ?? '—').padStart(9) +
    n(f['heroEquityVsReraiseRange'], 4).padStart(12) +
    String(f['reraiseBranchKind'] ?? '—').padStart(28) +
    n(f['reraiseBranchEV'], 2).padStart(8) +
    n(f['reraiseFoldBranchEV'], 2).padStart(10) +
    n(f['reraiseCallBranchEV'], 2).padStart(10) +
    n(f['raiseEV'], 2).padStart(10),
  );
  if (tag.startsWith('P0-7')) {
    line(`    ↳ 逐位精确值：P(弃)=${f['foldLikelihood']}｜P(跟)=${f['callLikelihood']}｜P(再加)=${f['reRaiseLikelihood']}｜RAISE EV=${f['raiseEV']}`);
  }
}
