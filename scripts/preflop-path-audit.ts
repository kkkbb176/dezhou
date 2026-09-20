/**
 * ============================================================================
 * 翻前决策路径 · 只读核查探针（PREFLOP DECISION PATH AUDIT · READ ONLY）
 * ============================================================================
 *
 * 目的：把**翻牌前**这一条决策链完整打印出来，供人工核对，并可与
 * 「P1 修复前的检查点源码树」跑同一份探针做**逐字节对照**。
 *
 * 覆盖节点（6 人桌 · 盲注 1/2 · bigBlindBB = 2）：
 *   ① BTN 无人入池（开池）        ② CO 无人入池（开池）
 *   ③ BB 面对 BTN 开池 3BB        ④ BTN 面对 BB 的 3bet 至 10BB
 *   ⑤ 跛入池 BTN（1 limper）      ⑥ 跛入池 BB（BB 已投满，callCost = 0）
 *   ⑦ 短码 BB 10BB 面对开池       ⑧ 短码 BTN 20BB 无人入池
 *   ⑨ BTN 同花连张（JTs）         ⑩ BTN A5s（A 带小脚同花）
 *   ⑪ BB 面对 CO 开池（AJo）      ⑫ BTN 面对 3bet（AA，100BB）
 *
 * 本脚本**只读**：只调用生产入口，不写任何文件、不改任何参数。
 */
import { analyzeManualHand, finalMathSanityCheck } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parseManualInput, type ManualHandInput, type ManualVillain } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const A_ = (p: string, t: string, bb?: number, s?: string): Record<string, unknown> => ({
  position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }), ...(s === undefined ? {} : { street: s }),
});
const base = {
  tableSize: 6, heroPosition: 'BTN', effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  environment: 'MID_LOW_STAKES',
};
const normal: ManualVillain = { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain;

const SCENARIOS: ReadonlyArray<readonly [string, ManualHandInput]> = [
  ['① BTN 无人入池（AA）', { ...base, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD')], villain: normal } as unknown as ManualHandInput],
  ['② CO 无人入池（KK）', { ...base, heroPosition: 'CO', heroCards: ['Ks', 'Kh'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD')], villain: normal } as unknown as ManualHandInput],
  ['③ BB 面对 BTN 开池 3BB（AKo）', { ...base, heroPosition: 'BB', heroCards: ['As', 'Kd'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD')], villain: normal } as unknown as ManualHandInput],
  ['④ BTN 面对 BB 3bet 至 10BB（AA）', { ...base, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'RAISE', 10)], villain: normal } as unknown as ManualHandInput],
  ['⑤ 跛入池 BTN（AKo，1 limper）', { ...base, heroPosition: 'BTN', heroCards: ['As', 'Kd'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'CALL', 1), A_('CO', 'FOLD')], villain: normal } as unknown as ManualHandInput],
  ['⑥ 跛入池 BB（AKo，2 limper，callCost=0）', { ...base, heroPosition: 'BB', heroCards: ['As', 'Kd'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'CALL', 1), A_('CO', 'CALL', 1), A_('BTN', 'FOLD'), A_('SB', 'FOLD')], villain: normal } as unknown as ManualHandInput],
  ['⑦ 短码 BB 10BB 面对 BTN 开池 3BB（AA）', { ...base, heroPosition: 'BB', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', effectiveStackBB: 10, seatStacksBB: { UTG: 10, HJ: 10, CO: 10, BTN: 10, SB: 10, BB: 10 }, actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD')], villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 10 } as ManualVillain } as unknown as ManualHandInput],
  ['⑧ 短码 BTN 20BB 无人入池（AA）', { ...base, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', effectiveStackBB: 20, seatStacksBB: { UTG: 20, HJ: 20, CO: 20, BTN: 20, SB: 20, BB: 20 }, actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD')], villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 20 } as ManualVillain } as unknown as ManualHandInput],
  ['⑨ BTN 无人入池（JTs 同花连张）', { ...base, heroPosition: 'BTN', heroCards: ['Js', 'Ts'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD')], villain: normal } as unknown as ManualHandInput],
  ['⑩ BTN 无人入池（A5s = A 带小脚同花）', { ...base, heroPosition: 'BTN', heroCards: ['As', '5s'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD')], villain: normal } as unknown as ManualHandInput],
  ['⑪ BB 面对 CO 开池 3BB（AJo = A 带大脚）', { ...base, heroPosition: 'BB', heroCards: ['As', 'Jd'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'RAISE', 3), A_('BTN', 'FOLD'), A_('SB', 'FOLD')], villain: normal } as unknown as ManualHandInput],
  ['⑫ BTN 面对 3bet（AA，跛入池变异：先有 limper）', { ...base, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'CALL', 1), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 4), A_('SB', 'FOLD'), A_('BB', 'RAISE', 12)], villain: normal } as unknown as ManualHandInput],
  /* ⑫ 的行动记录停在 BB 再加注，此时**仍轮到跛入的 HJ**（不是 Hero）——
     引擎如实报 `DECISION_POINT_NOT_AVAILABLE`，因此补一条 HJ 弃牌后的同型节点（⑬）。 */
  ['⑬ BTN 面对 3bet（AA，跛入者已弃牌）', { ...base, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'CALL', 1), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 4), A_('SB', 'FOLD'), A_('BB', 'RAISE', 12), A_('HJ', 'FOLD')], villain: normal } as unknown as ManualHandInput],
];

/** 数值稳定化：把浮点截到 12 位，便于跨源码树逐行对照。 */
function stable(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)) {
    return Number(value.toFixed(12));
  }
  return value;
}
const j = (v: unknown, cap = 460): string => {
  const s = JSON.stringify(v, stable) ?? 'undefined';
  return s.length > cap ? `${s.slice(0, cap)}…(${s.length})` : s;
};
const n = (v: unknown, d = 6): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const pct = (v: unknown, d = 6): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : String(v));

type Detail = {
  readonly decision: Record<string, any>;
  readonly dg: Record<string, any>;
  readonly math: Record<string, any>;
  readonly pf: Record<string, any>;
  readonly legal: Record<string, any>;
  readonly built: Record<string, any>;
  readonly warnings: readonly string[];
  readonly vm: Record<string, any>;
  readonly sanity: readonly string[];
};

function detailOf(input: ManualHandInput): Detail {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) throw new Error(`分析失败：${r.stage} ${JSON.stringify(r.issues)}`);
  const decision = r.decision as unknown as Record<string, any>;
  const dg = decision['diagnostics'] as Record<string, any>;
  const p = parseManualInput(input);
  if (!p.ok) throw new Error('解析失败');
  const g = buildAnalyzableState(p.value);
  if (!g.ok) throw new Error('状态失败');
  const built = buildDecisionContext({
    state: g.state, rules: OPTIONS.rules, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
    ...(p.value.villain.quickProfile === undefined ? {} : { quickProfile: p.value.villain.quickProfile }),
    ...(p.value.villain.dynamicHint === undefined ? {} : { dynamicHint: p.value.villain.dynamicHint }),
    ...(p.value.villain.persistentPlayerId === undefined || p.value.villain.persistentPlayerId === null ? {} : { villainPersistentPlayerId: p.value.villain.persistentPlayerId }),
    ...(p.value.villain.seatId === undefined || p.value.villain.seatId === null ? {} : { villainSeatId: p.value.villain.seatId }),
    ...(p.value.villain.observedStats === undefined || p.value.villain.observedStats === null ? {} : { observedStats: p.value.villain.observedStats }),
    equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
  } as never);
  return {
    decision, dg,
    math: dg['math'] as Record<string, any>,
    pf: (dg['postflop'] ?? {}) as Record<string, any>,
    legal: built.legal as unknown as Record<string, any>,
    built: built as unknown as Record<string, any>,
    warnings: r.warnings as readonly string[],
    vm: r.viewModel as unknown as Record<string, any>,
    sanity: finalMathSanityCheck(decision as never, built.legal as never),
  };
}

for (const [tag, input] of SCENARIOS) {
  console.log('='.repeat(112));
  console.log(`## ${tag}`);
  console.log('='.repeat(112));
  let D: Detail;
  try {
    D = detailOf(input);
  } catch (error) {
    console.log(`  ✖ 分析失败：${String(error)}`);
    continue;
  }
  const m = D.math;
  const lg = D.legal;
  const iso = D.built['preflopIso'] ?? null;
  const facts = (D.built['postflopFacts'] ?? null) as Record<string, any> | null;

  console.log('--- 输入/局面 ---');
  console.log(`  street=${String(m['street'])}  pot=${n(m['pot'], 2)}  callCost=${n(m['callCost'], 2)}  myCommittedThisStreet=${n(m['myCommittedThisStreet'], 2)}  myRemainingStack=${n(m['myRemainingStack'], 2)}  effectiveStack=${n(m['effectiveStack'], 2)}  spr=${n(m['spr'], 3)}`);
  console.log(`  requiredEquity=${pct(m['requiredEquity'], 6)} (applies=${String(m['requiredEquityApplies'])})  winnable=${n(m['winnable'], 2)}  potOdds=${pct(m['potOdds'], 3)}`);

  console.log('--- 牌力/权益 ---');
  console.log(`  handRankZh=${j(m['handRankZh'])}  handCategory=${String(m['handCategory'])}  bigBlind=${String(m['bigBlind'])}`);
  console.log(`  heroEquity=${pct(m['heroEquity'], 12)}  heroEquityVsBetRange=${m['heroEquityVsBetRange'] === null ? 'null' : pct(m['heroEquityVsBetRange'], 12)}  equitySource=${j(m['equitySource'])}`);
  console.log(`  callEV=${n(m['callEV'], 12)}  layeredEV=${j(m['layeredEV'] ?? null, 200)}`);
  const E = m['heroEquityVsBetRange'] ?? m['heroEquity'];
  const ident1 = E * m['winnable'] - m['callCost'];
  console.log(`  [恒等式①] E×winnable−callCost = ${n(ident1, 12)}  ⇒ 与 callEV 差 ${n(Math.abs(ident1 - m['callEV']), 15)}`);
  if (typeof m['callEV'] === 'number' && Number.isFinite(m['callEV']) && m['winnable'] > 0 && Number.isFinite(E)) {
    /*
     * ⚠️ 这里比较的是**两把标尺本身**（都是「每 1 可争夺筹码的 EV」，无量纲）：
     *   新标尺（P1，`singleLayerEdge`）= callEV / winnable
     *   旧标尺（`edge`）             = heroEquity − requiredEquity
     * 翻前 `heroEquityVsBetRange === null` ⇒ callEV 用的就是 heroEquity
     * ⇒ 两者**代数恒等**，只可能有浮点尾差。
     * （第一版探针在这里误写成 `callEV/winnable − requiredEquity`，等于把
     *   `requiredEquity` 减了两次 —— 那是探针自身的算术错误，已修正。）
     */
    const rulerNew = m['callEV'] / m['winnable'];
    const rulerOld = E - m['requiredEquity'];
    console.log(`  [标尺对照] 新（P1）callEV/winnable = ${n(rulerNew, 15)} ｜ 旧 edge = E−requiredEquity = ${n(rulerOld, 15)}  ⇒ 差 ${n(Math.abs(rulerNew - rulerOld), 18)}（翻前应恒等，仅浮点尾差）`);
  }

  console.log('--- 合法动作/尺寸 ---');
  console.log(`  actions=${j(lg['actions'], 200)}  callCost=${n(lg['callCost'], 2)}  minRaiseTo=${n(lg['minRaiseToAmount'], 2)}  allInTo=${n(lg['allInToAmount'], 2)}  currentBet=${n(lg['currentBet'], 2)}  maxTo=${n(lg['maxRaiseToAmount'], 2)}`);

  console.log('--- 隔离加注事实包（仅跛入池）---');
  console.log(`  preflopIso=${iso === null ? 'null' : j({ legalIsoSize: iso['isoSize']?.['legalIsoSize'], proxyEV: iso['isoEV']?.['proxyEV'], modelConfidence: iso['modelConfidence'], limpers: iso['limpers'], assumptions: iso['assumptionsZh'] }, 400)}`);
  console.log(`  postflopFacts=${facts === null ? 'null/undefined（翻前预期）' : `存在 · raiseResponse=${j(facts['raiseResponse'] ?? null, 200)}`}`);

  console.log('--- 候选与 EV ---');
  for (const c of (D.dg['candidates'] as readonly Record<string, any>[]) ?? []) {
    console.log(`  · ${String(c['action']).padEnd(6)} size=${n(c['sizeChips'], 2).padStart(8)}  ev=${n(c['ev'], 6).padStart(14)}  estimateType=${String(c['estimateType'] ?? '—')}  label=${j(c['labelZh'] ?? '—', 60)}`);
  }
  console.log(`  alternativeActions=${j((D.dg['alternativeActions'] as readonly Record<string, any>[])?.map((a) => ({ a: a['action'], ev: a['ev'], st: a['statusZh'], t: a['estimateType'] })) ?? null, 400)}`);

  console.log('--- 守门/边际/证据 ---');
  console.log(`  allInGuard=${j(D.dg['allInGuard'] ?? null, 500)}`);
  console.log(`  actionShape=${j(D.dg['actionShape'] ?? null, 400)}`);
  console.log(`  decisionMargin=${j(D.dg['decisionMargin'] ?? null, 300)}`);
  console.log(`  decisionSource=${j(D.dg['decisionSource'] ?? null, 200)}`);
  for (const e of (D.dg['actionEvidence'] as readonly Record<string, any>[]) ?? []) {
    console.log(`  evidence=${j(e, 300)}`);
  }
  console.log(`  consistency=${j(D.dg['consistency'] ?? null, 400)}`);

  console.log('--- 结论 ---');
  console.log(`  action=${String(D.decision['action'])}${D.decision['sizeChips'] === undefined ? '' : ` ${String(D.decision['sizeChips'])}`}  band=${String(D.decision['band'])}  classification=${String(D.decision['classification'])}  confidence=${n(D.decision['confidence'], 4)}  actionable=${String(D.decision['actionable'])}`);
  console.log(`  sanity=${D.sanity.length === 0 ? '无问题' : j(D.sanity, 400)}`);
  console.log(`  warnings=${j(D.warnings, 300)}`);
  console.log(`  reasons=${j((D.decision['reasons'] as readonly Record<string, any>[])?.map((x) => x['code']) ?? null, 400)}`);
  console.log(`  vm: actionZh=${j(D.vm['actionZh'], 80)} sizeZh=${j(D.vm['sizeZh'] ?? '（无）', 160)}`);
}
console.log('='.repeat(112));
console.log('探针结束（只读，未修改任何文件）');
