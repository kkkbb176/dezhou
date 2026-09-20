/**
 * RIVER RAISE DECISION —— 证据裁决与合法性审计（只读）
 *
 * 二、三 部分：从 MATH_CALL_SUPPORTED 追到 STRATEGIC_RAISE_FOR_VALUE，
 * 并把加注金额的语义、有效筹码、合法性一次性打印清楚。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { akInput } from './rrda-lib.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_014;
const line = (s = ''): void => console.log(s);
const num = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const pad = (s: string, n: number): string => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};

const input = akInput(20, 'CALLING_STATION');
const parsed = parseManualInput(input);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues[0]));
const gate = buildAnalyzableState(parsed.value);
if (!gate.ok) throw new Error(JSON.stringify(gate.issues[0]));
const state = gate.state;

line('='.repeat(112));
line(' 一、加注金额的语义 / 有效筹码 / 合法性');
line('='.repeat(112));
{
  const built = buildDecisionContext({
    state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
    quickProfile: 'CALLING_STATION' as never, equitySeed: SEED,
  });
  const legal = built.legal as unknown as Record<string, any>;
  const m = (built.context as unknown as Record<string, any>)['math'] as Record<string, any>;
  const hero = state.players.find((p) => p.id === state.userPlayerId)!;
  const villain = state.players.find((p) => p.id === 'seat_BB')!;

  line(`  Hero  ：剩余 ${hero.remainingStack}｜本街已投入 ${hero.committedByStreet[state.street]}｜底牌 ${(hero.holeCards ?? []).length} 张`);
  line(`  Villain：剩余 ${villain.remainingStack}｜本街已投入 ${villain.committedByStreet[state.street]}（含本次下注 ${state.currentBet}）`);
  line(`  state.currentBet = ${state.currentBet}｜pot = ${m['pot']}｜我的剩余 = ${m['myRemainingStack']}`);
  line('');
  line('  合法动作（`deriveLegalActions`）：');
  line('    ' + JSON.stringify({
    canFold: legal['canFold'], canCheck: legal['canCheck'], canCall: legal['canCall'],
    canBet: legal['canBet'], canRaise: legal['canRaise'],
    callCost: legal['callCost'], minRaiseToAmount: legal['minRaiseToAmount'],
    allInToAmount: legal['allInToAmount'], minBet: legal['minBet'], myRemainingStack: legal['myRemainingStack'],
  }));
  const acts = (legal['actions'] ?? []) as unknown[];
  line('    actions = ' + JSON.stringify(acts));
  line(`    ⇒ 合法加注区间 = [${legal['minRaiseToAmount']}, ${legal['allInToAmount']}]（raise-to 口径）`);
  line(`      174 ∈ 该区间 ⇒ **合法**；且 174 = allInToAmount ⇒ **就是全下**`);
  line('');

  /* 加注金额语义：sizeChips = **本街总额目标（raise-to）**，不是增量 */
  const raiseTo = 174;
  line(`  「RAISE 174」的语义核对：`);
  line(`    · 这是 **raise-to**（本街总额目标），不是增量 ⇒ 增量 = 174 − ${state.currentBet} = ${raiseTo - state.currentBet}`);
  line(`    · Hero 本街已投入 0 ⇒ 需要从剩余里拿出 ${raiseTo}，剩余 ${hero.remainingStack} ⇒ ${raiseTo === hero.remainingStack ? '**正好是全下**' : raiseTo < hero.remainingStack ? '不是全下' : '**超出剩余（非法）**'}`);
  line(`    · 全下后 Hero 剩余 = ${hero.remainingStack - raiseTo}`);
  line(`    · 加注后底池（若 Villain 跟注）= ${m['pot']} + ${raiseTo - state.currentBet} + ${raiseTo - state.currentBet} = ${(m['pot'] as number) + 2 * (raiseTo - state.currentBet)}`);
  line(`    · Villain 需要再投入 ${raiseTo - state.currentBet} 才能跟注，他身后还有 ${villain.remainingStack} ⇒ ${villain.remainingStack >= raiseTo - state.currentBet ? '**可以跟注**' : '跟不起（超出部分会退回）'}`);
  line(`    · 有效筹码 effectiveStack = ${m['effectiveStack']}（= min(我的剩余 − 跟注额, 对手剩余) 口径）`);
  line(`    · RAISE 174 与 ALL_IN 174 是**同一个动作**：候选表里同时存在两条（RAISE「全下」与 ALL_IN）`);
  line('');
  line(`  「价值加注」的目标尺寸公式：desiredTo = pot + 2×callCost = ${m['pot']} + 2×${m['callCost']} = ${(m['pot'] as number) + 2 * (m['callCost'] as number)}`);
  line(`    ⇒ 落到最近的合法候选 = 174（全下）⇒ 本节点「价值加注」的默认尺寸就是**把 87BB 全部推入**`);
  line(`    量级保护 MAX_RAISE_TO_POT_RATIO = 2.5：174 / ${m['pot']} = ${(174 / (m['pot'] as number)).toFixed(3)} ≤ 2.5 ⇒ **保护未触发**`);
  line(`    牌力保护 MIN_CATEGORY_FOR_LARGE_RAISE = 3（两对及以上）：Hero handCategory = ${m['handCategory']} ⇒ 只有触发上面那条才会被拦`);
}

line('');
line('='.repeat(112));
line(' 二、证据裁决链（MATH_CALL_SUPPORTED → STRATEGIC_RAISE_FOR_VALUE）');
line('='.repeat(112));
{
  const run = analyzeManualHand(input, {
    rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: SEED,
    budget: { softMs: 120_000, hardMs: 240_000 },
  });
  if (!run.ok) throw new Error(run.stage);
  const d = run.decision as unknown as Record<string, any>;
  const diag = d['diagnostics'] as Record<string, any>;
  const src = diag['decisionSource'] as Record<string, any>;
  line(`  decisionSource.kind         = ${String(src['kind'])}（${String(src['kindZh'])}）`);
  line(`  decisionSource.estimateType = ${String(src['estimateType'])}`);
  line(`  decisionSource.evidenceScope= ${String(src['evidenceScope'])}`);
  line(`  decisionSource.priority     = ${String(src['priority'])}｜canOverrideEvidence = ${String(src['canOverrideEvidence'])}`);
  line(`  decisionSource.overrideAttempt = ${String(src['overrideAttempt'])}`);
  line(`  decisionSource.overrideBlocked = ${String(src['overrideBlockedReason'])}`);
  line('');
  line('  裁决说明（逐条）：');
  for (const s of String(src['noteZh']).split('；')) line(`    · ${s}`);
  line('');
  line('  decisionMargin = ' + JSON.stringify({
    kind: diag['decisionMargin']?.['kind'], evChips: diag['decisionMargin']?.['evChips'],
    bandChips: diag['decisionMargin']?.['bandChips'], scope: diag['decisionMargin']?.['scope'],
  }, null, 0));
  line(`    noteZh = ${String(diag['decisionMargin']?.['noteZh'])}`);
  line('');
  line('  最终动作 = ' + String(d['action']) + '｜sizeChips = ' + num(d['sizeChips'], 2));
  const raiseReason = ((d['reasons'] ?? []) as any[]).find((x) => x['code'] === 'STRATEGIC_RAISE_FOR_VALUE');
  line('  STRATEGIC_RAISE_FOR_VALUE 全文：');
  line('    ' + String(raiseReason?.['textZh']));
  line('    data = ' + JSON.stringify(raiseReason?.['data']));
  line('');
  line('  postflop.commitment = ' + JSON.stringify(diag['postflop']?.['commitment'] ?? null));
  line('  postflop.valueAssessment = ' + JSON.stringify(diag['postflop']?.['valueAssessment'] ?? null).slice(0, 400));
  line('');
  line('  加注是否有 EV：');
  for (const e of (diag['actionEvidence'] ?? []) as any[]) {
    line(`    ${pad(String(e['action']), 8)} estimateType=${pad(String(e['estimateType']), 12)} ev=${num(e['ev'], 4)}`);
    for (const a of (e['assumptionsZh'] ?? []) as string[]) line(`        - ${a}`);
    if (e['upgradeNoteZh']) line(`        ↑ ${String(e['upgradeNoteZh'])}`);
  }
}
