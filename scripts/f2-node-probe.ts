/**
 * F2 修复用 · 节点与边界探针（只读）
 *
 * ① 多条街的「全下保护」现状（翻前 / 翻后多人池）
 * ② BB 面对开池的**有效筹码扫描**（3–25BB），映射「合法全下是否被拦」的边界
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

type Diag = Record<string, any>;
function run(input: ManualHandInput): { ok: boolean; stage?: string; issues?: unknown; d?: Diag; dg?: Diag; reasons?: Diag[] } {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) return { ok: false, stage: r.stage, issues: r.issues };
  const d = r.decision as unknown as Diag;
  return { ok: true, d, dg: d['diagnostics'] as Diag, reasons: (d['reasons'] ?? []) as Diag[] };
}
const n = (v: unknown, dg2 = 2): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(dg2) : String(v));
const j = (v: unknown, cap = 240): string => {
  const s = JSON.stringify(v) ?? 'undefined';
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
};

console.log('='.repeat(112));
console.log('① 后翻（多人池）河牌：一对牌 + 多路对手 ⇒ 加注响应模型不可用 ⇒ 全下保护是否触发');
console.log('='.repeat(112));
const MULTIWAY_RIVER: ManualHandInput = {
  tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s'],
  street: 'TURN', effectiveStackBB: 25, bigBlindBB: 2, seatStacksBB: stacks(25),
  actionHistory: [
    A_('UTG', 'CALL', 1), A_('HJ', 'FOLD'), A_('CO', 'CALL', 1), A_('BTN', 'RAISE', 5), A_('SB', 'FOLD'),
    A_('BB', 'CALL', 4), A_('UTG', 'CALL', 4), A_('CO', 'CALL', 4),
    A_('BB', 'CHECK', undefined, 'FLOP'), A_('UTG', 'CHECK', undefined, 'FLOP'), A_('CO', 'CHECK', undefined, 'FLOP'),
    A_('BTN', 'BET', 6, 'FLOP'), A_('BB', 'FOLD'), A_('UTG', 'CALL', 6, 'FLOP'), A_('CO', 'CALL', 6, 'FLOP'),
    A_('UTG', 'BET', 7, 'TURN'), A_('CO', 'CALL', 7, 'TURN'),
  ],
  environment: 'MID_LOW_STAKES', villain: V(25, 'CALLING_STATION'),
} as unknown as ManualHandInput;
{
  const r = run(MULTIWAY_RIVER);
  if (!r.ok) {
    console.log(`  ✖ 重构/分析失败：${String(r.stage)}`);
    console.log(`    issues = ${j(r.issues, 700)}`);
  } else {
    const m = (r.dg!['math'] ?? {}) as Diag;
    const g = (r.dg!['allInGuard'] ?? {}) as Diag;
    const sh = (r.dg!['actionShape'] ?? {}) as Diag;
    console.log(`  pot=${n(m['pot'])} callCost=${n(m['callCost'])} allInTo=${n(r.dg!['allInGuard'] ? (r.dg!['legal']?.['allInToAmount'] ?? '—') : '—')} myRemaining=${n(m['myRemainingStack'])} category=${String(m['handCategory'])}`);
    console.log(`  candidates=${j((r.dg!['candidates'] as Diag[])?.map((c) => `${String(c['action'])}@${n(c['sizeChips'])}`), 300)}`);
    console.log(`  guard=${j({ consumesStack: g['consumesStack'], hasOwnEV: g['hasOwnEV'], onePairAllInBlocked: g['onePairAllInBlocked'], raiseToPotRatio: g['raiseToPotRatio'], largeRaiseBlocked: g['largeRaiseBlocked'], commitmentException: g['commitmentException'], commitmentClause: g['commitmentClause'], roleStrength: g['roleStrength'], stackOffAllowed: g['stackOffAllowed'] }, 400)}`);
    console.log(`  noteZh=${j(g['noteZh'], 200)}`);
    console.log(`  raiseSizesWithOwnEV=${j(g['raiseSizesWithOwnEV'], 80)} raises=${j((r.dg!['candidates'] as Diag[])?.filter((c) => c['action'] === 'RAISE').map((c) => c['sizeChips']), 120)}`);
    console.log(`  evidence=${j((r.dg!['actionEvidence'] as Diag[])?.map((e) => ({ a: e['action'], t: e['estimateType'], ev: e['ev'], hs: e['heuristicScore'], cs: e['commitsStack'] })), 400)}`);
    console.log(`  roleStrength=${n(g['roleStrength'], 4)} spr=${n(g['spr'], 3)}｜action=${String(r.d!['action'])} ${n(r.d!['sizeChips'])}｜shape=${String(sh['kind'])}`);
    console.log(`  warnings=${j((r.d!['warnings'] as string[]) ?? [], 300)}`);
  }
}

console.log('');
console.log('='.repeat(112));
console.log('② BB 面对 BTN 开池 3BB —— 有效筹码扫描（AA / KK / AKs / 72o / 55 / JTs）');
console.log('='.repeat(112));
const HANDS: ReadonlyArray<readonly [string, [string, string]]> = [
  ['AA', ['As', 'Ah']], ['KK', ['Ks', 'Kh']], ['AKs', ['As', 'Ks']], ['QQ', ['Qs', 'Qh']],
  ['TT', ['Ts', 'Th']], ['88', ['8s', '8h']], ['55', ['5s', '5h']], ['JTs', ['Js', 'Ts']],
  ['A5s', ['As', '5s']], ['72o', ['7s', '2d']], ['AKo', ['As', 'Kd']],
];
console.log('深度  手牌   legal.actions        minRaiseTo allInTo  选中加注  候选含全下?  consumesStack  hasOwnEV  onePairAllInBlocked  largeRaiseBlocked  action');
for (const bb of [3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25]) {
  for (const [tag, cards] of HANDS) {
    const input = {
      tableSize: 6, heroPosition: 'BB', heroCards: cards, board: [], street: 'PREFLOP',
      effectiveStackBB: bb, bigBlindBB: 2, seatStacksBB: stacks(bb), actionHistory: OPEN3,
      environment: 'MID_LOW_STAKES', villain: V(bb),
    } as unknown as ManualHandInput;
    const r = run(input);
    if (!r.ok) { console.log(`${String(bb).padStart(4)}  ${tag.padEnd(5)} FAIL ${String(r.stage)}`); continue; }
    const m = (r.dg!['math'] ?? {}) as Diag;
    const g = (r.dg!['allInGuard'] ?? {}) as Diag;
    const cands = (r.dg!['candidates'] as Diag[]) ?? [];
    // 全下额：legalActions 快照不在 diagnostics 里 ⇒ 用候选里的最大 RAISE 尺寸近似 + math.myRemainingStack 复算
    const allInTo = (m['myCommittedThisStreet'] as number) + (m['myRemainingStack'] as number);
    const raiseCands = cands.filter((c) => c['action'] === 'RAISE');
    const hasAllInCand = raiseCands.some((c) => Math.abs((c['sizeChips'] as number) - allInTo) < 1e-9);
    const chosen = r.d!['action'] === 'RAISE' ? (r.d!['sizeChips'] as number) : null;
    console.log(
      `${String(bb).padStart(4)}  ${tag.padEnd(5)} ${j(r.dg!['candidates'] ? cands.map((c) => String(c['action'])[0]).join('') : '', 6).padEnd(6)}` +
      `  ${n(allInTo - (m['myRemainingStack'] as number)).padStart(6)}` +
      ` ${n(allInTo).padStart(8)}` +
      ` ${(chosen === null ? '—' : n(chosen)).padStart(9)}` +
      ` ${String(hasAllInCand).padEnd(12)}` +
      ` ${String(g['consumesStack']).padEnd(14)}` +
      ` ${String(g['hasOwnEV']).padEnd(9)}` +
      ` ${String(g['onePairAllInBlocked']).padEnd(20)}` +
      ` ${String(g['largeRaiseBlocked']).padEnd(18)}` +
      ` ${String(r.d!['action'])}${chosen === null ? '' : ` ${n(chosen)}`}`,
    );
  }
}
console.log('');
console.log('探针结束（只读）');
