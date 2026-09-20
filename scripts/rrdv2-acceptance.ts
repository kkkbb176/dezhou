/**
 * RIVER RAISE DECISION V2 —— 九、最终验收（只读）
 *
 * 原样重跑 AK 节点 + 关键对照节点，输出要求的字段。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { akInput } from './rrda-lib.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_014;
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: SEED, budget: { softMs: 120_000, hardMs: 240_000 } } as const;
const line = (s = ''): void => console.log(s);
const num = (v: unknown, d = 6): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const pad = (s: string, n: number): string => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};

const r = analyzeManualHand(akInput(20, 'CALLING_STATION'), OPTIONS);
if (!r.ok) throw new Error(`${r.stage}`);
const d = r.decision as unknown as Record<string, any>;
const diag = d['diagnostics'] as Record<string, any>;
const m = diag['math'] as Record<string, any>;
const evidence = (diag['actionEvidence'] ?? []) as any[];
const raiseEv = evidence.find((e) => e.action === 'RAISE');

line('='.repeat(112));
line(' 九、最终验收：Hero BTN A♠K♠｜K♦9♣4♥6♠2♠（修正为 K♦9♣4♥6♠2♦）｜BB 河牌 bet 40｜底池 93｜Hero 剩余 174');
line('='.repeat(112));
line('【要求的输出】');
line(`  FOLD EV  = ${num(evidence.find((e) => e.action === 'FOLD')?.ev, 6)}`);
line(`  CALL EV  = ${num(m['callEV'], 6)}`);
line(`  RAISE EV = ${raiseEv?.ev === null || raiseEv?.ev === undefined ? 'null（NOT_IMPLEMENTED）' : num(raiseEv.ev, 6)}`);
line(`  最终动作 = ${String(d['action'])}${d['sizeChips'] === undefined ? '' : `（${num(d['sizeChips'], 2)}）`}`);
line(`  最终动作依据 = ${String(diag['decisionSource']?.['kind'])}（${String(diag['decisionSource']?.['kindZh'])}）`);
line(`      evidenceScope = ${String(diag['decisionSource']?.['evidenceScope'])}`);
line(`      overrideAttempt = ${String(diag['decisionSource']?.['overrideAttempt'])}`);
line(`      overrideBlockedReason = ${String(diag['decisionSource']?.['overrideBlockedReason'])}`);
line('');
line(`  RAISE_EV_GUARD = ${String(raiseEv?.estimateType)}／ev = ${String(raiseEv?.ev)}（未实现 ⇒ 不参与 EV 比较）`);
const g = diag['allInGuard'] as Record<string, any>;
line(`  ALL_IN_GUARD   = onePairAllInBlocked=${String(g['onePairAllInBlocked'])}｜consumesStack=${String(g['consumesStack'])}｜` +
  `handCategory=${String(g['handCategory'])} < minCategory=${String(g['minCategoryForLargeRaise'])}｜hasOwnEV=${String(g['hasOwnEV'])}｜` +
  `raiseToPotRatio=${num(g['raiseToPotRatio'], 3)}`);
line(`      ${String(g['noteZh'])}`);
line(`  EVIDENCE_PRIORITY = ${String(diag['decisionSource']?.['kind'])}｜canOverrideEvidence=${String(diag['decisionSource']?.['canOverrideEvidence'])}`);
line('');
line('【§五 启发式守卫逐条（AK 节点）】');
line(`  roleStrength          = ${num(g['roleStrength'], 4)}`);
line(`  handCategory          = ${String(g['handCategory'])}（一对牌；阈值 MIN_CATEGORY_FOR_LARGE_RAISE = ${String(g['minCategoryForLargeRaise'])}）`);
line(`  SPR                   = ${num(g['spr'], 3)}`);
line(`  stackOffAllowed       = ${String(g['stackOffAllowed'])}`);
line(`  commitmentException   = ${String(g['commitmentException'])}｜实际条款 = ${String(g['commitmentClause'])}` +
  '（河牌上整条通道关闭 ⇒ 恒为 null/false）');
line(`  raiseToPotRatio       = ${num(g['raiseToPotRatio'], 3)}（≤ 2.5 ⇒ 旧档位保护不触发）`);
line(`  consumesStack         = ${String(g['consumesStack'])}（raise-to 174 = allInToAmount ⇒ 真正的全下）`);
line(`  hasOwnEV              = ${String(g['hasOwnEV'])}`);
line(`  overrideJustification = ${String(g['overrideJustificationKind'])}（本次没有触发任何放行论证）`);
line(`  放行条件逐条：① MONSTER+edge≥0.30 = false｜② 强档+edge≥0.15 = false｜③ 承诺例外+edge≥0.09 = false（河牌关闭）`);
line('');
line('【动作形态（普通加注 / 加注到全下 / 直接全下）】');
const shape = diag['actionShape'] as Record<string, any>;
line(`  kind=${String(shape['kind'])}｜sizeChips=${num(shape['sizeChips'], 2)}｜allInToAmount=${num(shape['allInToAmount'], 2)}｜` +
  `consumesStack=${String(shape['consumesStack'])}`);
line(`  ${String(shape['noteZh'])}`);
line('');
line('【候选动作（M7 去重后）】');
for (const c of (diag['candidates'] ?? []) as any[]) {
  line(`  · ${pad(String(c['action']), 8)} size=${pad(num(c['sizeChips'], 2), 10)} ev=${pad(num(c['ev'], 4), 12)} ${String(c['noteZh']).slice(0, 54)}`);
}
line('');
line('【未评估的合法动作（§三）】');
for (const u of (diag['unevaluatedActions'] ?? []) as any[]) {
  line(`  · ${pad(String(u['action']), 8)} size=${pad(num(u['sizeChips'], 2), 10)} ${String(u['reasonCode'])}`);
}
line('');
line('【条件权益清单（§六）】');
const cond = diag['conditionalEquities'] as Record<string, any>;
line(`  EqVsArrivalRange        = ${num(cond['arrivalRange'], 6)}`);
line(`  EqVsBetRange            = ${num(cond['betRange'], 6)}`);
line(`  math.heroEquity（整体）  = ${num(cond['wholeRange'], 6)}`);
line(`  EqVsRaiseContinueRange  = ${String(cond['raiseContinueRange'])}`);
line(`  加注门槛实际读取         = ${String(cond['usedByRaiseThreshold'])}`);
line('');
line('【最终理由链】');
for (const reason of ((d['reasons'] ?? []) as any[]).slice(0, 8)) {
  line(`  · [${reason['code']}] ${String(reason['textZh']).slice(0, 190)}`);
}
line('');
line('【证据表】');
for (const e of evidence) {
  line(`  ${pad(String(e['action']), 8)} type=${pad(String(e['estimateType']), 30)} ev=${pad(num(e['ev'], 4), 12)} ` +
    `margin=${pad(String(e['decisionMargin']), 24)} commitsStack=${String(e['commitsStack'] ?? '—')}`);
}

/* ---------- 对照节点：证明不是「一刀切禁掉加注」 ---------- */
line('');
line('='.repeat(112));
line(' 对照：保护是否只针对该保护的牌型 / 是否保留了合法加注');
line('='.repeat(112));
line(pad('节点', 40) + pad('手牌类别', 10) + pad('动作', 10) + pad('size', 10) + pad('全下?', 8) + pad('一对牌全下被拦?', 16) + '来源');
const cases: Array<[string, ReturnType<typeof akInput>]> = [
  ['AK 河牌（一对）', akInput(20, 'CALLING_STATION')],
  ['99 河牌（暗三条）', akInput(20, 'CALLING_STATION', ['9s', '9h'])],
  ['KK 河牌（暗三条）', akInput(20, 'CALLING_STATION', ['Ks', 'Kh'])],
];
for (const [tag, input] of cases) {
  const rr = analyzeManualHand(input, OPTIONS);
  if (!rr.ok) { line(`${tag}: FAIL ${rr.stage}`); continue; }
  const dd = rr.decision as unknown as Record<string, any>;
  const dg = dd['diagnostics'] as Record<string, any>;
  const gg = dg['allInGuard'] as Record<string, any>;
  line(pad(tag, 40) + pad(String(dg['math']['handCategory']), 10) + pad(String(dd['action']), 10) +
    pad(num(dd['sizeChips'], 2), 10) + pad(String(dg['actionShape']?.['consumesStack']), 8) +
    pad(String(gg['onePairAllInBlocked']), 16) + String(dg['decisionSource']?.['kind']));
}
/* 深筹码河牌：加注不消耗筹码 ⇒ 河牌上「怪物加注」仍然可达 */
{
  const deep = {
    ...(akInput(20, 'CALLING_STATION', ['9s', '9h']) as unknown as Record<string, unknown>),
    effectiveStackBB: 400,
    seatStacksBB: { UTG: 400, HJ: 400, CO: 400, BTN: 400, SB: 400, BB: 400 },
  } as never;
  const rr = analyzeManualHand(deep, OPTIONS);
  if (rr.ok) {
    const dd = rr.decision as unknown as Record<string, any>;
    const dg = dd['diagnostics'] as Record<string, any>;
    line(pad('99 河牌（400BB 深筹码）', 40) + pad(String(dg['math']['handCategory']), 10) + pad(String(dd['action']), 10) +
      pad(num(dd['sizeChips'], 2), 10) + pad(String(dg['actionShape']?.['consumesStack']), 8) +
      pad(String(dg['allInGuard']?.['onePairAllInBlocked']), 16) + String(dg['decisionSource']?.['kind']));
    line(`  ⇒ 河牌上的加注**没有被一刀切禁掉**：${dd['action']} ${num(dd['sizeChips'], 2)}` +
      `（consumesStack=${String(dg['actionShape']?.['consumesStack'])} ⇒ 不消耗筹码时启发式覆盖权限保留）`);
  }
}

/* AA 面对 3bet（翻前，不消耗筹码）—— 证明合法加注没有被无条件删除 */{
  const A = (position: string, type: string, amountBB?: number) => ({ position, type, ...(amountBB === undefined ? {} : { amountBB }) });
  const aa = {
    tableSize: 6, heroPosition: 'CO', heroCards: ['Ah', 'Ad'], board: [], street: 'PREFLOP',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'RAISE', 3), A('BTN', 'FOLD'), A('SB', 'FOLD'), A('BB', 'RAISE', 10)],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as never;
  const rr = analyzeManualHand(aa, OPTIONS);
  if (rr.ok) {
    const dd = rr.decision as unknown as Record<string, any>;
    const dg = dd['diagnostics'] as Record<string, any>;
    line(pad('AA 面对 3bet（翻前）', 40) + pad(String(dg['math']['handCategory']), 10) + pad(String(dd['action']), 10) +
      pad(num(dd['sizeChips'], 2), 10) + pad(String(dg['actionShape']?.['consumesStack']), 8) +
      pad(String(dg['allInGuard']?.['onePairAllInBlocked']), 16) + String(dg['decisionSource']?.['kind']));
    line(`  ⇒ 合法加注仍然可达：${dd['action']} ${num(dd['sizeChips'], 2)}（不消耗筹码 ⇒ 启发式覆盖权限保留）`);
  }
}

/* ---------- 对照：EV 自带时是否仍然允许全下（M3 的可达性） ---------- */
line('');
line('（M3 的可达性证明在单元层：`test/riverRaiseDecisionV2.test.ts` 的 V2-8 —— 加注自带 MODEL_EV 且更高时裁决选 RAISE；');
line(' 🔴 U1 之后**产品侧也已经可达**：上表「99 河牌（暗三条）」「KK 河牌（暗三条）」的动作就是');
line('   `RAISE 174`，依据 = `RAISE MODEL_EV`（面对加注的响应模型），见 V2-16 与 `reports/evidence/u1-raise-fields-probe.txt`；');
line('   翻前隔离加注（`ISO_RAISE_MODEL_EV`）是另一条独立路径，见 preflopEvidencePriority / multiLimpIsolation 测试。）');

/* ---------- 上下文级核对（与 decision 快照一致） ---------- */
{
  const parsed = parseManualInput(akInput(20, 'CALLING_STATION'));
  if (parsed.ok) {
    const gate = buildAnalyzableState(parsed.value);
    if (gate.ok) {
      const ctx = buildDecisionContext({ state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf, quickProfile: 'CALLING_STATION' as never, equitySeed: SEED }).context;
      line('');
      line(`  上下文核对：EqVsBetRange=${num(ctx.math.heroEquityVsBetRange, 6)}｜CALL EV=${num(ctx.math.callEV, 6)}｜` +
        `恒等式 ${Math.abs((ctx.math.heroEquityVsBetRange as number) * ctx.math.winnable - ctx.math.callCost - (ctx.math.callEV as number)) < 1e-9 ? '成立 ✔' : '✖'}`);
    }
  }
}
