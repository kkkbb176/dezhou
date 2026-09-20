/**
 * FLOP & RIVER AUDIT V1 · 焦点探针 ④（只读）
 *  A. 历史敏感性（Agent 2 / M3：对手的行动是否进入条件范围）
 *  B. 底牌泄漏（M4：Hero 底牌是否进入对手行动概率模型）
 *  C. 组合数单调性（M2：同一下注是否被重复计入）
 *  D. M13/M14：更弱牌是否跟注、错失听牌是否进入诈唬范围
 *  E. M18：候选是否有重复 (action, size)
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
const S100 = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };
const PF = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];
const V = (profile = 'NORMAL'): ManualVillain => ({ quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 }) as ManualVillain;
const N = (h: [string, string], board: string[], street: string, hist: Record<string, unknown>[], pos = 'BTN', profile = 'NORMAL'): ManualHandInput =>
  ({ tableSize: 6, heroPosition: pos, heroCards: h, board, street, effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: S100, actionHistory: hist, environment: 'MID_LOW_STAKES', villain: V(profile) }) as unknown as ManualHandInput;
const j = (v: unknown, cap = 400): string => { const s = JSON.stringify(v) ?? 'undefined'; return s.length > cap ? `${s.slice(0, cap)}…` : s; };
const num = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));

function probe(tag: string, input: ManualHandInput): Record<string, any> | null {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { console.log(`  ${tag} ✖ ${String(r.stage)}`); return null; }
  const d = r.decision as unknown as Record<string, any>;
  const dg = (d['diagnostics'] ?? {}) as Record<string, any>;
  const pf = (dg['postflop'] ?? {}) as Record<string, any>;
  const m = (dg['math'] ?? {}) as Record<string, any>;
  const br = (pf['betDecision'] ?? null) as Record<string, any> | null;
  const rr = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
  const facts = (pf['bettingRangeFacts'] ?? null) as Record<string, any> | null;
  const arrival = (pf['betRangeArrival'] ?? null) as Record<string, any> | null;
  const rc = (pf['rangeCompression'] ?? null) as Record<string, any> | null;
  const out = {
    action: `${String(d['action'])}${d['sizeChips'] === undefined ? '' : `@${num(d['sizeChips'], 1)}`}`,
    heroEq: m['heroEquity'], eqBetRange: m['heroEquityVsBetRange'],
    reachable: pf['reachableComboCount'],
    rangeCounts: pf['rangeCounts'],
    arrivalMass: arrival === null ? null : { ids: arrival['opponentIds'], support: arrival['supportSize'] ?? arrival['combos'] ?? null },
    factsText: facts === null ? null : { strengthFloor: facts['strengthFloor'] ?? facts['minStrength'] ?? null, nut: facts['nutDensity'] ?? null, air: facts['airDensity'] ?? null, note: String(facts['noteZh'] ?? '').slice(0, 120) },
    compression: rc === null ? null : { floor: rc['strengthFloor'], nut: rc['nutDensity'], air: rc['airDensity'] },
    betModel: br === null ? null : { best: br['bestSize'], checkEV: br['checkEV'], sizes: (br['sizes'] ?? []).map((s: Record<string, any>) => `${String(s['size'])}@${num(s['betAmount'], 1)} ev=${num(s['betEV'], 2)} f=${num(s['foldLikelihood'], 3)} c=${num(s['callLikelihood'], 3)} eqVsCall=${num(s['heroEquityVsCallRange'], 3)} callCombos=${String(s['callComboCount'])}`) },
    raiseModel: rr === null ? null : { sz: rr['sizeChips'], ev: rr['raiseEV'], f: rr['foldLikelihood'], c: rr['callLikelihood'], r: rr['reRaiseLikelihood'], eqCall: rr['heroEquityVsRaiseCallRange'], callCombos: rr['callCombos'], reachable: rr['reachableCombos'] },
    dupCandidates: (() => {
      const seen = new Set<string>(); const dup: string[] = [];
      for (const c of ((dg['candidates'] ?? []) as Record<string, any>[])) {
        const k = `${String(c['action'])}@${String(c['sizeChips'])}`;
        if (seen.has(k)) dup.push(k); seen.add(k);
      }
      return dup;
    })(),
  };
  console.log(`  ${tag}`);
  console.log(`     action=${out.action} ｜ heroEq=${num(out.heroEq, 3)} eqBetRange=${num(out.eqBetRange, 3)} ｜ reachable=${String(out.reachable)} ｜ rangeCounts=${j(out.rangeCounts, 200)}`);
  console.log(`     compression=${j(out.compression, 200)} ｜ arrival=${j(out.arrivalMass, 160)} ｜ dupCandidates=${j(out.dupCandidates, 100)}`);
  console.log(`     betModel=${j(out.betModel, 700)}`);
  console.log(`     raiseModel=${j(out.raiseModel, 500)}`);
  return out;
}

/* ================= A. 历史敏感性 ================= */
console.log('='.repeat(118));
console.log('A. 历史敏感性（同一河牌节点，只改前面两街的行动；对手 NORMAL）');
console.log('='.repeat(118));
const RIVER_BOARD = ['Kd', '9c', '4h', '6s', '2d'];
const HISTS: ReadonlyArray<readonly [string, Record<string, unknown>[]]> = [
  ['H1 BTN 下注翻牌+转牌、BB 两次跟注（三枪线）', [...PF, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'CHECK', undefined, 'RIVER')]],
  ['H2 翻牌跟注后**转牌过牌-过牌**、BB 河牌过牌', [...PF, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'CHECK', undefined, 'TURN'), A_('BB', 'CHECK', undefined, 'RIVER')]],
  ['H3 BB **领打**翻牌与转牌、BTN 跟注、BB 河牌过牌', [...PF, A_('BB', 'BET', 4, 'FLOP'), A_('BTN', 'CALL', 4, 'FLOP'), A_('BB', 'BET', 10, 'TURN'), A_('BTN', 'CALL', 10, 'TURN'), A_('BB', 'CHECK', undefined, 'RIVER')]],
  ['H4 BB **过牌加注**翻牌、BTN 跟注；转牌过牌-过牌；BB 河牌过牌', [...PF, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'RAISE', 14, 'FLOP'), A_('BTN', 'CALL', 10, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'CHECK', undefined, 'TURN'), A_('BB', 'CHECK', undefined, 'RIVER')]],
];
for (const [tag, hist] of HISTS) probe(tag, N(['As', 'Ks'], RIVER_BOARD, 'RIVER', hist));

/* ================= B. 底牌泄漏 ================= */
console.log('');
console.log('='.repeat(118));
console.log('B. 底牌泄漏测试（同一节点：只改 Hero 底牌；对手与行动完全不变）');
console.log('='.repeat(118));
const F01_HIST = [...PF, A_('BB', 'BET', 4, 'FLOP')];
for (const [tag, cards] of [['Hero A♠K♠（顶对）', ['As', 'Ks']], ['Hero A♠Q♦（A 高）', ['As', 'Qd']], ['Hero 7♠2♦（空气）', ['7s', '2d']], ['Hero 4♠4♦（底对）', ['4s', '4d']]] as ReadonlyArray<readonly [string, [string, string]]>) {
  probe(`${tag} ｜ F-01 翻牌面对领打`, N(cards, ['Kd', '9c', '4h'], 'FLOP', F01_HIST));
}

/* ================= D. M13 / M14 ================= */
console.log('');
console.log('='.repeat(118));
console.log('D. M13（更弱牌是否跟注）/ M14（错失听牌是否进入诈唬范围）');
console.log('='.repeat(118));
{
  /* D1：河牌暗三条、对手过牌 ⇒ 他的跟注范围权益应当明显 < 1（说明有更弱的牌会跟） */
  probe('D1 河牌暗三条（对手过牌，价值下注）', N(['9s', '9h'], RIVER_BOARD, 'RIVER', [...PF, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'CHECK', undefined, 'RIVER')]));
  /* D2：同一条线，河牌**错失同花听牌**的牌面（三张草花在转牌已成、河牌空白） vs 干燥面 */
  const MISSED = ['Kd', '9c', '4h', '6c', '2d'];      // 转牌第二张草花 → 河牌未完成同花（错失）
  const DRY = ['Kd', '9c', '4h', '6s', '2d'];
  const H = [...PF, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'BET', 20, 'RIVER')];
  probe('D2a 河牌面对下注 ｜ 干燥面 K♦9♣4♥6♠2♦', N(['As', 'Kh'], DRY, 'RIVER', H));
  probe('D2b 河牌面对下注 ｜ 错失同花面 K♦9♣4♥6♣2♦', N(['As', 'Kh'], MISSED, 'RIVER', H));
}
console.log('');
console.log('（焦点探针 ④ 结束，只读）');
