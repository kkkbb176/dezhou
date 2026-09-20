/**
 * 下一阶段候选修复 · **只读影响面估算**
 *
 * 目标：估算「跨动作 EV 差落在容差带内，却选了消耗筹码的加注/全下」这一模式
 *      （CB-1/CB-5 的最小修复对象）在现有节点集合上出现多少次。
 *
 * 判定：最终动作 ∈ {RAISE, ALL_IN} 且该动作消耗全部剩余筹码（actionShape.consumesStack
 *      或 allInGuard.consumesStack），且「该加注的证据 EV − 其他动作最高 EV」≤ 容差带
 *      （decisionMargin.bandChips）。同时打印反例（差 > 带）以证明不是普遍现象。
 *
 * 用法：node --experimental-strip-types scripts/next-phase-estimate.ts
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
  /* 翻牌/河牌：面对下注或加注的节点（跨动作竞争最活跃处） */
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
  /* 翻前：面对下注的节点（3bet 后的跨动作竞争） */
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

const num = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
let flagged = 0, stackCommitting = 0, total = 0;
const flaggedRows: string[] = [];
const contrast: string[] = [];
for (const [tag, base] of NODES) {
  for (const profile of PROFILES) {
    const input = { ...(base as unknown as Record<string, unknown>), villain: V(profile, 100) } as unknown as ManualHandInput;
    const r = analyzeManualHand(input, OPTIONS);
    if (!r.ok) continue;
    total++;
    const d = r.decision as unknown as Record<string, any>;
    const dg = (d['diagnostics'] ?? {}) as Record<string, any>;
    const ev = ((dg['actionEvidence'] ?? []) as Record<string, any>[]).filter((e) => e['ev'] !== null);
    const chosen = ev.find((e) => e['action'] === d['action']);
    const others = ev.filter((e) => e['action'] !== d['action']);
    const band = Number(((dg['decisionMargin'] ?? {})['bandChips'] ?? 0));
    const isRaise = d['action'] === 'RAISE' || d['action'] === 'ALL_IN';
    const commit = ((dg['allInGuard'] ?? {})['consumesStack'] === true) || ((dg['actionShape'] ?? {})['consumesStack'] === true);
    if (!(isRaise && commit)) { if (isRaise) contrast.push(`${tag}｜${profile}｜非全下加注（差 ${num((chosen?.ev ?? 0) - Math.max(...others.map((o) => Number(o['ev'])), 0))}）`); continue; }
    stackCommitting++;
    const bestOther = others.length === 0 ? 0 : Math.max(...others.map((o) => Number(o['ev'])));
    const gap = Number(chosen?.ev ?? 0) - bestOther;
    const row = `${tag}｜${profile}｜动作=${String(d['action'])}@${num(d['sizeChips'])}｜加注EV=${num(chosen?.ev)}｜最佳其他EV=${num(bestOther)}｜差=${num(gap)}｜带=±${num(band)}｜差≤带=${gap <= band}`;
    if (chosen !== undefined && gap <= band) { flagged++; flaggedRows.push(row); } else { contrast.push(row); }
  }
}
console.log('='.repeat(118));
console.log('下一阶段候选修复 · 影响面估算（只读）');
console.log('='.repeat(118));
console.log(`节点×画像总数 = ${total} ｜ 最终动作是「消耗全部筹码的加注/全下」= ${stackCommitting} ｜ 其中「EV 差 ≤ 容差带」= ${flagged}`);
console.log('');
console.log('【命中：消耗筹码 且 跨动作 EV 差在带内】');
for (const x of flaggedRows) console.log('  ' + x);
console.log('');
console.log('【对照：消耗筹码但 EV 差 > 带，或非全下加注（证明不是普遍现象）】');
for (const x of contrast.slice(0, 14)) console.log('  ' + x);
console.log(`  （对照共 ${contrast.length} 条，此处仅列前 14 条）`);
console.log('='.repeat(118));
