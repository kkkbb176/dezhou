/**
 * CB-5 修复 · 影响面扫描（**只读**）
 *
 * 与 `scripts/next-phase-estimate.ts` **完全相同的 124 个「节点 × 画像」输入**
 * （同种子、同手牌、同公共牌、同行动历史、同身份画像、同有效筹码、同环境），
 * 输出每个节点的完整指纹：动作 / 尺寸 / 三条 EV / 条件权益 / 响应概率 / 决策来源 / 护栏诊断。
 *
 * 用法：node --experimental-strip-types scripts/cb5-impact-scan.ts
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
const stacks = (bb: number): Record<string, number> => ({ UTG: bb, HJ: bb, CO: bb, BTN: bb, SB: bb, BB: bb });
const V = (profile: string, bb = 100): ManualVillain => ({ quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: bb }) as ManualVillain;
const PF = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];
const F25 = [A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP')];
const T75 = [A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN')];
const F4 = [A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP')];
const T10 = [A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN')];
const B = (tag: string, input: ManualHandInput): readonly [string, ManualHandInput] => [tag, input];

const NODES: ReadonlyArray<readonly [string, ManualHandInput]> = [
  B('F-01 顶对领打', { tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h'], street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, A_('BB', 'BET', 4, 'FLOP')], environment: 'MID_LOW_STAKES' } as unknown as ManualHandInput),
  B('F-03 坚果同花听领打', { tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', 'Kc'], board: ['8c', '4c', '2d'], street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, A_('BB', 'BET', 4, 'FLOP')], environment: 'MID_LOW_STAKES' } as unknown as ManualHandInput),
  B('F-04 中対持续下注', { tableSize: 6, heroPosition: 'BB', heroCards: ['Ad', '8d'], board: ['Kd', '8c', '4h'], street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP')], environment: 'MID_LOW_STAKES' } as unknown as ManualHandInput),
  B('F-06 顶对面对过牌加注', { tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h'], street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'RAISE', 14, 'FLOP')], environment: 'MID_LOW_STAKES' } as unknown as ManualHandInput),
  B('R-03 中対面对领打（P1）', { tableSize: 6, heroPosition: 'BTN', heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...F4, A_('BB', 'BET', 10, 'TURN')], environment: 'MID_LOW_STAKES' } as unknown as ManualHandInput),
  B('R-05 顶对 vs 120% 池', { tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...F25, ...T75, A_('BB', 'BET', 41.5, 'RIVER')], environment: 'MID_LOW_STAKES' } as unknown as ManualHandInput),
  B('R-05b 顶对 vs 100% 池', { tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...F25, ...T75, A_('BB', 'BET', 34.5, 'RIVER')], environment: 'MID_LOW_STAKES' } as unknown as ManualHandInput),
  B('R-05c 顶对 vs 60% 池', { tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...F25, ...T75, A_('BB', 'BET', 20.7, 'RIVER')], environment: 'MID_LOW_STAKES' } as unknown as ManualHandInput),
  B('R-06 三条面对河牌加注', { tableSize: 6, heroPosition: 'BB', heroCards: ['9h', '9s'], board: ['Jd', '9c', '4c', '6s', '2h'], street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...F4, ...T10, A_('BB', 'BET', 20, 'RIVER'), A_('BTN', 'RAISE', 60, 'RIVER')], environment: 'MID_LOW_STAKES' } as unknown as ManualHandInput),
  B('R5 AK 河牌 20BB', { tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...F25, ...T75, A_('BB', 'BET', 20, 'RIVER')], environment: 'MID_LOW_STAKES' } as unknown as ManualHandInput),
  B('R6 99 三条河牌 20BB', { tableSize: 6, heroPosition: 'BTN', heroCards: ['9s', '9h'], board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...F25, ...T75, A_('BB', 'BET', 20, 'RIVER')], environment: 'MID_LOW_STAKES' } as unknown as ManualHandInput),
  B('R2 TEST17 转牌 A♣J♣ 领打', { tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...F4, A_('BB', 'BET', 10, 'TURN')], environment: 'MID_LOW_STAKES' } as unknown as ManualHandInput),
  B('R3 TEST18 转牌面对加注 40BB', { tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...F4, A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'RAISE', 40, 'TURN')], environment: 'MID_LOW_STAKES' } as unknown as ManualHandInput),
  ...[5, 6, 7, 8, 9, 10].flatMap((bb) =>
    ([['AA', ['As', 'Ah']], ['KK', ['Ks', 'Kh']], ['AKo', ['As', 'Kd']]] as ReadonlyArray<readonly [string, readonly [string, string]]>)
      .map(([tag, cards]) => B(`翻前 BB@${bb}BB vs 开池（${tag}）`, {
        tableSize: 6, heroPosition: 'BB', heroCards: cards, board: [], street: 'PREFLOP', effectiveStackBB: bb, bigBlindBB: 2,
        seatStacksBB: stacks(bb), actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD')],
        environment: 'MID_LOW_STAKES',
      } as unknown as ManualHandInput)),
  ),
  B('翻前 BTN vs 3bet 10BB（AA）', { tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, A_('BB', 'RAISE', 10)], environment: 'MID_LOW_STAKES' } as unknown as ManualHandInput),
];
const PROFILES = ['NORMAL', 'MANIAC', 'CALLING_STATION', 'VERY_TIGHT'] as const;

const n = (v: unknown, d = 3): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const evOf = (list: readonly Record<string, any>[], action: string): string => {
  const e = list.find((x) => x['action'] === action);
  return e === undefined ? '—' : `${String(e['estimateType'])}:${e['ev'] === null ? 'null' : n(e['ev'], 2)}`;
};
for (const [tag, base] of NODES) {
  for (const profile of PROFILES) {
    const input = { ...(base as unknown as Record<string, unknown>), villain: V(profile) } as unknown as ManualHandInput;
    const r = analyzeManualHand(input, OPTIONS);
    if (!r.ok) { console.log(`${tag}｜${profile}｜FAIL ${String(r.stage)}`); continue; }
    const d = r.decision as unknown as Record<string, any>;
    const dg = (d['diagnostics'] ?? {}) as Record<string, any>;
    const m = (dg['math'] ?? {}) as Record<string, any>;
    const pf = (dg['postflop'] ?? {}) as Record<string, any>;
    const eq = (dg['conditionalEquities'] ?? {}) as Record<string, any>;
    const src = (dg['decisionSource'] ?? {}) as Record<string, any>;
    const rr = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
    const list = (dg['actionEvidence'] ?? []) as readonly Record<string, any>[];
    const g = src['stackCommitmentGuard'] as Record<string, any> | undefined;
    console.log(
      `${tag}｜${profile}｜action=${String(d['action'])}@${d['sizeChips'] === undefined ? '-' : n(d['sizeChips'], 2)}` +
      `｜EV: FOLD=${evOf(list, 'FOLD')} CALL=${evOf(list, 'CALL')} RAISE=${evOf(list, 'RAISE')}` +
      `｜权益: arr=${n(eq['arrivalRange'])} bet=${n(eq['betRange'])} eq=${n(m['heroEquity'])} eqBet=${n(m['heroEquityVsBetRange'])} req=${n(m['requiredEquity'])} winnable=${n(m['winnable'], 2)}` +
      `｜响应: ${rr === null ? '—' : `f=${n(rr['foldLikelihood'], 4)} c=${n(rr['callLikelihood'], 4)} r=${n(rr['reRaiseLikelihood'], 4)} sz=${String(rr['sizeChips'])}`}` +
      `｜来源=${String(src['kind'])}/${String(src['evidenceScope'])}｜band=${n((dg['decisionMargin'] ?? {})['bandChips'], 2)}` +
      `｜guard=${g === undefined ? 'none' : `blocked=${String(g['blockedAction'])} alt=${String(g['alternativeAction'])} gap=${n(g['gapChips'], 3)} band=${n(g['bandChips'], 2)}`}` +
      `｜consumesStack=${String((dg['actionShape'] ?? {})['consumesStack'])}`,
    );
  }
}
console.log('（影响面扫描结束，只读）');
