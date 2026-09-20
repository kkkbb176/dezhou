/**
 * F2 修复 · 影响面指纹（只读）
 *
 * 在「修复前检查点」与「修复后工作区」各跑一次，逐行 diff ⇒ 精确列出
 * **哪些节点的哪些字段发生了变化**。
 *
 * 指纹包含：动作 / 尺寸 / 候选构成 / allInGuard（含 street）/
 * RAISE 证据（heuristicScore、ev、commitsStack、overrideJustification）/
 * 决策来源（kind、evidenceScope、overrideAttempt、overrideBlockedReason）/ 理由码。
 *
 * 用法：node --experimental-strip-types scripts/f2-blast-radius.ts
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
const V = (bb: number, profile = 'NORMAL'): ManualVillain =>
  ({ quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: bb }) as ManualVillain;
const stacks = (bb: number): Record<string, number> => ({ UTG: bb, HJ: bb, CO: bb, BTN: bb, SB: bb, BB: bb });
const OPEN3 = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD')];

const BASE100 = {
  tableSize: 6, heroPosition: 'BTN', effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: stacks(100), environment: 'MID_LOW_STAKES',
};
/** 翻后节点（与 `scripts/p1-fix-sweep.ts` / TEST 16–18 同源） */
const TURN_99 = [
  A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
  A_('BB', 'BET', 10, 'TURN'),
];
const RIVER_AK = [
  A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP'),
  A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN'),
  A_('BB', 'BET', 20, 'RIVER'),
];

const NODES: ReadonlyArray<readonly [string, ManualHandInput]> = [
  /* ---- 翻前：BB 面对开池，全深度 × 手牌 ---- */
  ...[3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25].flatMap((bb) =>
    ([['AA', ['As', 'Ah']], ['KK', ['Ks', 'Kh']], ['AKs', ['As', 'Ks']], ['AKo', ['As', 'Kd']],
      ['QQ', ['Qs', 'Qh']], ['TT', ['Ts', 'Th']], ['55', ['5s', '5h']], ['JTs', ['Js', 'Ts']],
      ['A5s', ['As', '5s']], ['72o', ['7s', '2d']]] as ReadonlyArray<readonly [string, readonly [string, string]]>)
      .map(([tag, cards]) => [
        `翻前 BB@${bb}BB vs 开池 3BB（${tag}）`,
        { tableSize: 6, heroPosition: 'BB', heroCards: cards, board: [], street: 'PREFLOP', effectiveStackBB: bb, bigBlindBB: 2, seatStacksBB: stacks(bb), actionHistory: OPEN3, environment: 'MID_LOW_STAKES', villain: V(bb) } as unknown as ManualHandInput,
      ] as const),
  ),
  /* ---- 翻前：其它形态（100BB） ---- */
  ['翻前 BTN 无人入池（AA）', { ...BASE100, heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD')], villain: V(100) } as unknown as ManualHandInput],
  ['翻前 BTN 无人入池（JTs）', { ...BASE100, heroCards: ['Js', 'Ts'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD')], villain: V(100) } as unknown as ManualHandInput],
  ['翻前 BB vs BTN 开池（AKo，100BB）', { ...BASE100, heroPosition: 'BB', heroCards: ['As', 'Kd'], board: [], street: 'PREFLOP', actionHistory: OPEN3, villain: V(100) } as unknown as ManualHandInput],
  ['翻前 BTN vs 3bet 10BB（AA）', { ...BASE100, heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', actionHistory: [...OPEN3, A_('BB', 'RAISE', 10)], villain: V(100) } as unknown as ManualHandInput],
  ['翻前 BTN vs 3bet 10BB（AKo）', { ...BASE100, heroCards: ['As', 'Kd'], board: [], street: 'PREFLOP', actionHistory: [...OPEN3, A_('BB', 'RAISE', 10)], villain: V(100) } as unknown as ManualHandInput],
  ['翻前跛入池 BTN（AKo，1 limper）', { ...BASE100, heroCards: ['As', 'Kd'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'CALL', 1), A_('CO', 'FOLD')], villain: V(100) } as unknown as ManualHandInput],
  ['翻前跛入池 BTN（AA，1 limper）', { ...BASE100, heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'CALL', 1), A_('CO', 'FOLD')], villain: V(100) } as unknown as ManualHandInput],
  ['翻前跛入池 BB（AKo，2 limper）', { ...BASE100, heroPosition: 'BB', heroCards: ['As', 'Kd'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'CALL', 1), A_('CO', 'CALL', 1), A_('BTN', 'FOLD'), A_('SB', 'FOLD')], villain: V(100) } as unknown as ManualHandInput],
  ['翻前短码 5BB BTN 无人入池（AA）', { tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', effectiveStackBB: 5, bigBlindBB: 2, seatStacksBB: stacks(5), actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD')], environment: 'MID_LOW_STAKES', villain: V(5) } as unknown as ManualHandInput],
  /* ---- 翻后 ---- */
  ['翻后转牌面对领打（99）', { ...BASE100, heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_99, villain: V(100, 'MANIAC') } as unknown as ManualHandInput],
  ['翻后河牌面对 20BB 领打（AK 顶对）', { ...BASE100, heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: RIVER_AK, villain: V(100, 'CALLING_STATION') } as unknown as ManualHandInput],
  ['翻后河牌面对 20BB 领打（99 暗三条）', { ...BASE100, heroCards: ['9s', '9h'], board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: RIVER_AK, villain: V(100, 'CALLING_STATION') } as unknown as ManualHandInput],
  ['翻后多人池转牌面对下注（AK 顶对，一对牌+全下）', {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s'], street: 'TURN',
    effectiveStackBB: 25, bigBlindBB: 2, seatStacksBB: stacks(25),
    actionHistory: [
      A_('UTG', 'CALL', 1), A_('HJ', 'FOLD'), A_('CO', 'CALL', 1), A_('BTN', 'RAISE', 5), A_('SB', 'FOLD'),
      A_('BB', 'CALL', 4), A_('UTG', 'CALL', 4), A_('CO', 'CALL', 4),
      A_('BB', 'CHECK', undefined, 'FLOP'), A_('UTG', 'CHECK', undefined, 'FLOP'), A_('CO', 'CHECK', undefined, 'FLOP'),
      A_('BTN', 'BET', 6, 'FLOP'), A_('BB', 'FOLD'), A_('UTG', 'CALL', 6, 'FLOP'), A_('CO', 'CALL', 6, 'FLOP'),
      A_('UTG', 'BET', 7, 'TURN'), A_('CO', 'CALL', 7, 'TURN'),
    ],
    environment: 'MID_LOW_STAKES', villain: V(25, 'CALLING_STATION'),
  } as unknown as ManualHandInput],
];

const num = (v: unknown, d = 6): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const j = (v: unknown): string => JSON.stringify(v) ?? 'undefined';

for (const [tag, input] of NODES) {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { console.log(`${tag} ｜ FAIL ${String(r.stage)}`); continue; }
  const d = r.decision as unknown as Record<string, any>;
  const dg = (d['diagnostics'] ?? {}) as Record<string, any>;
  const g = (dg['allInGuard'] ?? {}) as Record<string, any>;
  const src = (dg['decisionSource'] ?? {}) as Record<string, any>;
  const raise = ((dg['actionEvidence'] ?? []) as Record<string, any>[]).find((e) => e['action'] === 'RAISE');
  const cands = ((dg['candidates'] ?? []) as Record<string, any>[])
    .map((c) => `${String(c['action'])}@${c['sizeChips'] === undefined ? '-' : num(c['sizeChips'], 2)}`)
    .join(',');
  console.log(
    `${tag} ｜ action=${String(d['action'])}${d['sizeChips'] === undefined ? '' : ` ${num(d['sizeChips'], 2)}`}` +
    ` ｜ cands=[${cands}]` +
    ` ｜ guard=${j({ street: g['street'] ?? null, cat: g['handCategory'], consumes: g['consumesStack'], ownEV: g['hasOwnEV'], blocked: g['onePairAllInBlocked'], large: g['largeRaiseBlocked'] })}` +
    ` ｜ raiseEv=${raise === undefined ? 'none' : j({ hs: raise['heuristicScore'], ev: raise['ev'], t: raise['estimateType'], cs: raise['commitsStack'] ?? null, oj: raise['overrideJustification'] === undefined || raise['overrideJustification'] === null ? null : raise['overrideJustification']['kind'] })}` +
    ` ｜ src=${j({ k: src['kind'] ?? null, scope: src['evidenceScope'] ?? null, attempt: src['overrideAttempt'] ?? null, blocked: src['overrideBlockedReason'] ?? null })}` +
    ` ｜ reasons=${j(((d['reasons'] ?? []) as Record<string, any>[]).map((x) => String(x['code'])))}`,
  );
}
console.log('（只读指纹结束）');
