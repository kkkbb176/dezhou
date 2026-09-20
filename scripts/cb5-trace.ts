/**
 * CB-5 · 决策路径追踪（**只读**，修复前）
 *
 * 证明 5 个目标节点确实经过 `chooseByEvidencePriority` 的**跨动作量化 EV 比较**路径，
 * 且没有其他函数（baseDecision / adjustedDecision / primaryAction / shadow）提前定案。
 *
 * 用法：node --experimental-strip-types scripts/cb5-trace.ts
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
const F25 = [A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP')];
const T75 = [A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN')];
const F4 = [A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP')];
const T10 = [A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN')];
const V = (p: string): ManualVillain => ({ quickProfile: p, dynamicHint: 'UNKNOWN', stackBB: 100 }) as ManualVillain;
const river = (cards: [string, string], hist: Record<string, unknown>[], betBB: number): ManualHandInput =>
  ({ tableSize: 6, heroPosition: 'BTN', heroCards: cards, board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: S100, actionHistory: [...hist, A_('BB', 'BET', betBB, 'RIVER')], environment: 'MID_LOW_STAKES' }) as unknown as ManualHandInput;

type Node = readonly [string, ManualHandInput, string];
const NODES: readonly Node[] = [
  ['① R-05（120% 池）· NORMAL', river(['As', 'Ks'], [...PF, ...F25, ...T75], 41.5), 'NORMAL'],
  ['② R-05（120% 池）· MANIAC', river(['As', 'Ks'], [...PF, ...F25, ...T75], 41.5), 'MANIAC'],
  ['③ R-05b（100% 池）· NORMAL', river(['As', 'Ks'], [...PF, ...F25, ...T75], 34.5), 'NORMAL'],
  ['④ R-05b（100% 池）· MANIAC', river(['As', 'Ks'], [...PF, ...F25, ...T75], 34.5), 'MANIAC'],
  ['⑤ AK 河牌黄金节点（20BB）· NORMAL', river(['As', 'Ks'], [...PF, ...F25, ...T75], 20), 'NORMAL'],
  /* 对照 */
  ['C1 AK 河牌黄金节点 · CALLING_STATION（既有黄金向量）', river(['As', 'Ks'], [...PF, ...F25, ...T75], 20), 'CALLING_STATION'],
  ['C2 99 暗三条河牌（RAISE 174，优势显著）', river(['9s', '9h'], [...PF, ...F25, ...T75], 20), 'CALLING_STATION'],
  ['C3 审计原始 R-05 形态（翻牌 4BB / 转牌 10BB、120% 池）', river(['As', 'Ks'], [...PF, ...F4, ...T10], 41.5), 'NORMAL'],
  ['C4 翻牌面对领打（非河牌）', { tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h'], street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: S100, actionHistory: [...PF, A_('BB', 'BET', 4, 'FLOP')], environment: 'MID_LOW_STAKES' } as unknown as ManualHandInput, 'NORMAL'],
  ['C5 翻前 BB 面对开池（3Bet 决策）', { tableSize: 6, heroPosition: 'BB', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', effectiveStackBB: 25, bigBlindBB: 2, seatStacksBB: { UTG: 25, HJ: 25, CO: 25, BTN: 25, SB: 25, BB: 25 }, actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD')], environment: 'MID_LOW_STAKES' } as unknown as ManualHandInput, 'NORMAL'],
];

const num = (v: unknown, d = 3): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const j = (v: unknown, cap = 500): string => { const s = JSON.stringify(v) ?? 'undefined'; return s.length > cap ? `${s.slice(0, cap)}…` : s; };

for (const [tag, base, profile] of NODES) {
  const input = { ...(base as unknown as Record<string, unknown>), villain: V(profile) } as unknown as ManualHandInput;
  const r = analyzeManualHand(input, OPTIONS);
  console.log('='.repeat(116));
  console.log(`## ${tag}`);
  if (!r.ok) { console.log(`  ✖ 失败 ${String(r.stage)} ${j(r.issues, 200)}`); continue; }
  const d = r.decision as unknown as Record<string, any>;
  const dg = (d['diagnostics'] ?? {}) as Record<string, any>;
  const m = (dg['math'] ?? {}) as Record<string, any>;
  const ev = ((dg['actionEvidence'] ?? []) as Record<string, any>[]);
  const quantified = ev.filter((e) => e['ev'] !== null && e['estimateType'] !== 'HEURISTIC');
  const sorted = [...quantified].sort((a, b) => Number(b['ev']) - Number(a['ev']));
  const best = sorted[0] ?? null;
  const alt = (sorted.find((e) => e['action'] !== best?.['action'] && e['commitsStack'] !== true)) ?? null;
  const band = Number((dg['decisionMargin'] ?? {})['bandChips']);
  const src = (dg['decisionSource'] ?? {}) as Record<string, any>;
  const shape = (dg['actionShape'] ?? {}) as Record<string, any>;
  const guard = (dg['allInGuard'] ?? {}) as Record<string, any>;

  console.log(`  ① 局面: Hero ${String(input.heroPosition)} ${j(input.heroCards)} ｜ 公共牌 ${j(input.board)} ｜ street=${String(m['street'])}`);
  console.log(`     底池=${num(m['pot'], 2)} ｜ 对手下注（callCost）=${num(m['callCost'], 2)} ｜ Hero 剩余=${num(m['myRemainingStack'], 2)} ｜ 有效筹码=${num(m['effectiveStack'], 2)} ｜ winnable=${num(m['winnable'], 2)}`);
  console.log(`     画像=${profile} ｜ 范围来源=${j((dg['conditionalEquities'] ?? {})['noteZh'] ? '见下' : '—', 40)} arrival=${num((dg['conditionalEquities'] ?? {})['arrivalRange'])} betRange=${num((dg['conditionalEquities'] ?? {})['betRange'])} heroEq=${num(m['heroEquity'])}`);
  console.log(`  ② 合法性: ${j(dg['legalActions'], 200)}`);
  console.log(`  ③ 候选证据表: ${j(ev.map((e) => ({ a: e['action'], t: e['estimateType'], ev: e['ev'] === null ? null : Number(Number(e['ev']).toFixed(2)), margin: e['decisionMargin'], cs: e['commitsStack'] ?? null })), 700)}`);
  console.log(`     最佳（量化）= ${String(best?.['action'])} EV=${num(best?.['ev'])} ｜ 最佳**非全下**备选=${String(alt?.['action'])} EV=${num(alt?.['ev'])}`);
  console.log(`     EV_stack − EV_alternative = ${best !== null && alt !== null ? num(Number(best['ev']) - Number(alt['ev'])) : '—'} ｜ 容差带 ±${num(band)} ｜ 在带内=${best !== null && alt !== null ? (Number(best['ev']) - Number(alt['ev']) >= 0 && Number(best['ev']) - Number(alt['ev']) <= band) : '—'}`);
  console.log(`  ④ decisionMargin = ${j(dg['decisionMargin'], 320)}`);
  console.log(`  ⑤ evidencePriority = ${j({ kind: src['kind'], estimateType: src['estimateType'], scope: src['evidenceScope'], overrideAttempt: src['overrideAttempt'] ?? null, overrideBlockedReason: src['overrideBlockedReason'] ?? null, canOverride: src['canOverrideEvidence'] }, 300)}`);
  console.log(`  ⑥ actionShape = ${j(shape, 260)} ｜ allInGuard.consumesStack=${String(guard['consumesStack'])} onePairAllInBlocked=${String(guard['onePairAllInBlocked'])} largeRaiseBlocked=${String(guard['largeRaiseBlocked'])}`);
  console.log(`  ⑦ finalAction = ${String(d['action'])}${d['sizeChips'] === undefined ? '' : ` @${num(d['sizeChips'], 2)}`} ｜ decisionBasis=${String((dg['decisionBasis'] ?? {})['kind'])} ｜ confidence=${num(d['confidence'], 2)} ｜ classification=${String(d['classification'])}`);
  console.log(`  ⑧ 其他提前定案的路径: baseDecision=${j(dg['baseDecision'], 160)} ｜ adjustedDecision=${j(dg['adjustedDecision'], 160)} ｜ primaryAction=${j(dg['primaryAction'], 120)} ｜ shadow=${j(dg['shadow'], 100)}`);
  console.log(`  ⑨ EV 来源/限制: raiseResponse.evKind=${String((((dg['postflop'] ?? {}) as Record<string, any>)['raiseResponse'] ?? {})['evKind'] ?? '—')} ｜ assumptions=${j(((((dg['postflop'] ?? {}) as Record<string, any>)['raiseResponse'] ?? {})['assumptionsZh'] ?? []), 200)}`);
  console.log(`  ⑩ 首屏理由=${j(((d['reasons'] ?? []) as Record<string, any>[]).slice(0, 4).map((x) => String(x['code'])), 200)}`);
  /* 结构性证明：经过证据优先级跨动作路径 */
  const throughEvidencePriority = (src['kind'] === 'SUPPORTED_ACTION_PRIORITY' || src['kind'] === 'INDEPENDENT_STRATEGIC_EVIDENCE' || src['kind'] === 'HEURISTIC_TIEBREAK') && quantified.length >= 2;
  console.log(`  ⑪ 经过证据优先级跨动作比较路径 = ${String(throughEvidencePriority)}（量化候选 ${quantified.length} 个；来源 ${String(src['kind'])}/scope=${String(src['evidenceScope'])}）`);
}
console.log('='.repeat(116));
console.log('（追踪结束，只读，未修改任何文件）');
