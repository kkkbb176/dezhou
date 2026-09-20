/**
 * FLOP & RIVER THEORY + EXPLOIT AUDIT V1 · 主扫描（**只读**）
 *
 * §0 上下文键清单（一次性，确认诊断路径）
 * §1 矩阵指纹：F-01…F-06（翻牌）+ R-01…R-06（河牌）× {NORMAL, MANIAC, CALLING_STATION}
 * §2 四画像对照（Agent 4）：固定节点 × {NORMAL, CALLING_STATION, MANIAC, VERY_TIGHT}，
 *    标签基线 与 标签+实测统计 两组
 * §3 明细块（Part-6 模板）：用 --detail 选择（默认取前 6 个节点）
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
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
const stacks = (bb: number): Record<string, number> => ({ UTG: bb, HJ: bb, CO: bb, BTN: bb, SB: bb, BB: bb });
const S100 = stacks(100);

/** 翻前：UTG/HJ/CO 弃 → BTN 加注至 3BB → SB 弃 → BB 跟注（底池 13 筹码） */
const PF = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];
/** 翻牌：BB 过牌 → BTN 下注 4BB → BB 跟注（底池 45） */
const FLOP_CB_CALL = [A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP')];
/** 转牌：BB 过牌 → BTN 下注 10BB → BB 跟注（底池 85） */
const TURN_CB_CALL = [A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN')];

const EQ = (h: [string, string], b: string[], s: string, hist: Record<string, unknown>[], position = 'BTN'): ManualHandInput =>
  ({ tableSize: 6, heroPosition: position, heroCards: h, board: b, street: s, effectiveStackBB: 100, bigBlindBB: 2,
     seatStacksBB: S100, actionHistory: hist, environment: 'MID_LOW_STAKES' }) as unknown as ManualHandInput;

const OPP = (profile: string): ManualVillain => ({ quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 }) as ManualVillain;

type Case = readonly [string, string, ManualHandInput, string];
const NODES: readonly Case[] = [
  /* ---------------- 翻牌 ---------------- */
  ['F-01', '顶对强踢脚·对手领打', EQ(['As', 'Ks'], ['Kd', '9c', '4h'], 'FLOP', [...PF, A_('BB', 'BET', 4, 'FLOP')]), '跟注/加注 EV'],
  ['F-02', '暗三条·对手过牌', EQ(['9h', '9c'], ['9d', 'Kc', '4c'], 'FLOP', [...PF, A_('BB', 'CHECK', undefined, 'FLOP')]), '价值下注与尺寸'],
  ['F-03', '坚果同花听牌·对手领打', EQ(['Ac', 'Kc'], ['8c', '4c', '2d'], 'FLOP', [...PF, A_('BB', 'BET', 4, 'FLOP')]), '半诈唬及跟注'],
  ['F-04', '中对·对手持续下注', EQ(['Ad', '8d'], ['Kd', '8c', '4h'], 'FLOP', [...PF, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP')], 'BB'), '摊牌价值与防守'],
  ['F-05', '纯空气·对手过牌', EQ(['7s', '2d'], ['Kd', '9c', '4h'], 'FLOP', [...PF, A_('BB', 'CHECK', undefined, 'FLOP')]), '诈唬下注与弃牌率'],
  ['F-06', '顶对面对过牌加注', EQ(['As', 'Ks'], ['Kd', '9c', '4h'], 'FLOP', [...PF, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'RAISE', 14, 'FLOP')]), '条件范围与合法应对'],
  /* ---------------- 河牌 ---------------- */
  ['R-01', '顶对强踢脚·对手过牌', EQ(['As', 'Ks'], ['Kd', '9c', '4h', '6s', '2d'], 'RIVER', [...PF, ...FLOP_CB_CALL, ...TURN_CB_CALL, A_('BB', 'CHECK', undefined, 'RIVER')]), '薄价值下注'],
  ['R-02', '暗三条·对手过牌', EQ(['9s', '9h'], ['Kd', '9c', '4h', '6s', '2d'], 'RIVER', [...PF, ...FLOP_CB_CALL, ...TURN_CB_CALL, A_('BB', 'CHECK', undefined, 'RIVER')]), '价值下注及尺寸'],
  ['R-03', '中对·对手下注（P1 节点复现）', EQ(['9h', '9c'], ['Jd', '8c', '4c', '6s'], 'TURN', [...PF, ...FLOP_CB_CALL, A_('BB', 'BET', 10, 'TURN')]), '抓诈唬与赔率'],
  ['R-04', '纯空气·对手过牌', EQ(['As', 'Qs'], ['Kd', '9c', '4h', '6s', '2d'], 'RIVER', [...PF, ...FLOP_CB_CALL, ...TURN_CB_CALL, A_('BB', 'CHECK', undefined, 'RIVER')]), '诈唬 EV'],
  ['R-05', '顶对·对手 120% 池超池下注', EQ(['As', 'Ks'], ['Kd', '9c', '4h', '6s', '2d'], 'RIVER', [...PF, ...FLOP_CB_CALL, ...TURN_CB_CALL, A_('BB', 'BET', 41.5, 'RIVER')]), '条件下注范围/尺寸近似'],
  ['R-06', '暗三条面对河牌加注', EQ(['9h', '9s'], ['Jd', '9c', '4c', '6s', '2h'], 'RIVER', [...PF, ...FLOP_CB_CALL, ...TURN_CB_CALL, A_('BB', 'BET', 20, 'RIVER'), A_('BTN', 'RAISE', 60, 'RIVER')], 'BB'), 'CALL/RAISE/ALL-IN EV'],
];
const PROFILES = ['NORMAL', 'MANIAC', 'CALLING_STATION'] as const;

const num = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const pct = (v: unknown, d = 1): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const j = (v: unknown, cap = 300): string => { const s = JSON.stringify(v) ?? 'undefined'; return s.length > cap ? `${s.slice(0, cap)}…` : s; };

type Run = { readonly ok: boolean; readonly stage?: string; readonly d?: Record<string, any>; readonly dg?: Record<string, any>; readonly warnings?: readonly string[]; readonly vm?: Record<string, any> };
function runOf(input: ManualHandInput): Run {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) return { ok: false, stage: r.stage };
  const d = r.decision as unknown as Record<string, any>;
  return { ok: true, d, dg: (d['diagnostics'] ?? {}) as Record<string, any>, warnings: r.warnings as readonly string[], vm: r.viewModel as unknown as Record<string, any> };
}
function contextOf(input: ManualHandInput): Record<string, any> | null {
  const p = parseManualInput(input); if (!p.ok) return null;
  const g = buildAnalyzableState(p.value); if (!g.ok) return null;
  const v = p.value.villain;
  const built = buildDecisionContext({
    state: g.state, rules: OPTIONS.rules, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
    ...(v.quickProfile === undefined ? {} : { quickProfile: v.quickProfile }),
    ...(v.dynamicHint === undefined ? {} : { dynamicHint: v.dynamicHint }),
    ...(v.persistentPlayerId === undefined || v.persistentPlayerId === null ? {} : { villainPersistentPlayerId: v.persistentPlayerId }),
    ...(v.seatId === undefined || v.seatId === null ? {} : { villainSeatId: v.seatId }),
    ...(v.observedStats === undefined || v.observedStats === null ? {} : { observedStats: v.observedStats }),
    equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
  } as never) as unknown as Record<string, any>;
  return (built['context'] ?? null) as Record<string, any> | null;
}
const evidenceOf = (dg: Record<string, any>, action: string): Record<string, any> | undefined =>
  ((dg['actionEvidence'] ?? []) as Record<string, any>[]).find((e) => e['action'] === action);
const candsOf = (dg: Record<string, any>): Record<string, any>[] => (dg['candidates'] ?? []) as Record<string, any>[];

/* ============================================================
 * §0 诊断路径清单
 * ============================================================ */
console.log('='.repeat(120));
console.log('§0 诊断与上下文键清单（用于确认本审计读取的路径真实存在）');
console.log('='.repeat(120));
{
  const input = { ...(NODES[0]![2] as unknown as Record<string, unknown>), villain: OPP('NORMAL') } as unknown as ManualHandInput;
  const r = runOf(input);
  const ctx = contextOf(input);
  console.log(`  r.ok = ${String(r.ok)}${r.ok ? '' : `（${String(r.stage)}）`}`);
  if (r.ok) {
    console.log(`  decision 键 = ${j(Object.keys(r.d!).sort(), 400)}`);
    console.log(`  diagnostics 键 = ${j(Object.keys(r.dg!).sort(), 600)}`);
    console.log(`  diagnostics.postflop 键 = ${j(Object.keys((r.dg!['postflop'] ?? {}) as object).sort(), 600)}`);
    console.log(`  diagnostics.conditionalEquities = ${j(r.dg!['conditionalEquities'], 400)}`);
    console.log(`  首屏理由 = ${j(r.d!['reasons']?.[0]?.['textZh'], 200)}`);
  }
  if (ctx !== null) {
    console.log(`  context 键 = ${j(Object.keys(ctx).sort(), 500)}`);
    console.log(`  context.profileV3 键 = ${j(Object.keys((ctx['profileV3'] ?? {}) as object).sort(), 500)}`);
    console.log(`  context.postflopFacts 键 = ${j(Object.keys((ctx['postflopFacts'] ?? {}) as object).sort(), 500)}`);
  }
}

/* ============================================================
 * §1 矩阵指纹
 * ============================================================ */
console.log('');
console.log('='.repeat(120));
console.log('§1 矩阵指纹（每个节点 × 3 画像；同一节点除画像外全部输入固定）');
console.log('='.repeat(120));
const SWEEP: { tag: string; profile: string; line: string }[] = [];
for (const [tag, desc, base, focus] of NODES) {
  console.log('');
  console.log(`── ${tag} ${desc} ｜ 检测重点：${focus}`);
  for (const profile of PROFILES) {
    const input = { ...(base as unknown as Record<string, unknown>), villain: OPP(profile) } as unknown as ManualHandInput;
    const r = runOf(input);
    if (!r.ok) { console.log(`   ${profile.padEnd(16)} ✖ 分析失败：${String(r.stage)}`); continue; }
    const m = (r.dg!['math'] ?? {}) as Record<string, any>;
    const pf = (r.dg!['postflop'] ?? {}) as Record<string, any>;
    const src = (r.dg!['decisionSource'] ?? {}) as Record<string, any>;
    const basis = (r.dg!['decisionBasis'] ?? {}) as Record<string, any>;
    const gg = (r.dg!['allInGuard'] ?? {}) as Record<string, any>;
    const fold = evidenceOf(r.dg!, 'FOLD');
    const call = evidenceOf(r.dg!, 'CALL');
    const raise = evidenceOf(r.dg!, 'RAISE');
    const bet = evidenceOf(r.dg!, 'BET');
    const eq = (r.dg!['conditionalEquities'] ?? {}) as Record<string, any>;
    const rr = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
    const br = (pf['betDecision'] ?? null) as Record<string, any> | null;
    const raises = candsOf(r.dg!).filter((c) => c['action'] === 'RAISE');
    const line =
      `   ${profile.padEnd(16)} action=${String(r.d!['action'])}${r.d!['sizeChips'] === undefined ? '' : ` ${num(r.d!['sizeChips'])}`}` +
      ` ｜ pot=${num(m['pot'])} call=${num(m['callCost'])} allInTo=${num(Number(m['myCommittedThisStreet']) + Number(m['myRemainingStack']))}` +
      ` ｜ cat=${String(m['handCategory'])} role=${String(pf['handRoleZh'] ?? '—')}(${num(pf['roleStrength'], 2)})` +
      ` ｜ Eq=${pct(m['heroEquity'])} EqBet=${pct(m['heroEquityVsBetRange'])} arr=${pct(eq['arrivalRange'])} bet=${pct(eq['betRange'])} req=${pct(m['requiredEquity'])}` +
      ` ｜ EV[FOLD=${fold ? num(fold['ev'], 2) : '—'}(${String(fold?.['estimateType'] ?? '—')}) CALL=${call ? num(call['ev'], 2) : '—'}(${String(call?.['estimateType'] ?? '—')})` +
      ` BET=${bet ? num(bet['ev'], 2) : '—'}(${String(bet?.['estimateType'] ?? '—')}) RAISE=${raise ? num(raise['ev'], 2) : 'null'}(${String(raise?.['estimateType'] ?? '—')})]` +
      ` ｜ sizes=[${raises.map((c) => num(c['sizeChips'])).join(',')}]` +
      ` ｜ resp=${br === null ? '—' : j({ f: br['foldLikelihood'], c: br['callLikelihood'], r: br['reRaiseLikelihood'], sz: br['sizeChips'] }, 120)}/${rr === null ? '—' : j({ f: rr['foldLikelihood'], c: rr['callLikelihood'], r: rr['reRaiseLikelihood'], sz: rr['sizeChips'] }, 120)}` +
      ` ｜ src=${String(src['kind'])}${src['overrideBlockedReason'] === null || src['overrideBlockedReason'] === undefined ? '' : `(blocked=${String(src['overrideBlockedReason'])})`}` +
      ` ｜ basis=${String(basis['kind'] ?? '—')}` +
      ` ｜ margin=${String((r.dg!['decisionMargin'] ?? {})['kind'])} conf=${num(r.d!['confidence'], 2)} class=${String(r.d!['classification'])}` +
      ` ｜ guard=${String(gg['onePairAllInBlocked'])}/${String(gg['largeRaiseBlocked'])}` +
      ` ｜ viol=${j((r.dg!['consistency'] ?? {})['violations'], 120)}`;
    console.log(line);
    SWEEP.push({ tag, profile, line });
  }
}

/* ============================================================
 * §2 四画像对照（Agent 4）
 * ============================================================ */
console.log('');
console.log('='.repeat(120));
console.log('§2 四画像对照：固定节点（R-01 顶对·对手过牌 与 F-01 顶对·对手领打），只改画像输入');
console.log('='.repeat(120));
const STATS_STATION = { handsObserved: 800, vpip: 0.55, pfr: 0.05, threeBet: 0.02, wtsd: 0.42, foldToFlopCBet: 0.18, foldToTurnCBet: 0.22, foldToRiverBet: 0.25, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null };
const STATS_MANIAC = { handsObserved: 800, vpip: 0.62, pfr: 0.48, threeBet: 0.19, wtsd: 0.31, foldToFlopCBet: 0.62, foldToTurnCBet: 0.55, foldToRiverBet: 0.48, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null };
const PROFILE_CASES: ReadonlyArray<readonly [string, ManualVillain]> = [
  ['NORMAL（仅标签）', OPP('NORMAL')],
  ['CALLING_STATION（仅标签）', OPP('CALLING_STATION')],
  ['MANIAC（仅标签）', OPP('MANIAC')],
  ['VERY_TIGHT（仅标签）', OPP('VERY_TIGHT')],
  ['CALLING_STATION + 实测统计（VPIP55/PFR5/WTSD42）', { quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: STATS_STATION } as unknown as ManualVillain],
  ['MANIAC + 实测统计（VPIP62/PFR48/3Bet19）', { quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: STATS_MANIAC } as unknown as ManualVillain],
  ['NORMAL + 跟注站式实测统计（同一份统计，用于分离标签与数据）', { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: STATS_STATION } as unknown as ManualVillain],
];
for (const [label, nodeIdx, nodeTag] of [['R-01', 6, 'R-01 顶对·对手过牌'], ['F-01', 0, 'F-01 顶对·对手领打']] as const) {
  const base = NODES[nodeIdx]![2];
  console.log('');
  console.log(`── ${nodeTag}`);
  for (const [pLabel, villain] of PROFILE_CASES) {
    const input = { ...(base as unknown as Record<string, unknown>), villain } as unknown as ManualHandInput;
    const r = runOf(input);
    const ctx = contextOf(input);
    if (!r.ok) { console.log(`   ${pLabel} ✖ ${String(r.stage)}`); continue; }
    const m = (r.dg!['math'] ?? {}) as Record<string, any>;
    const pf = (r.dg!['postflop'] ?? {}) as Record<string, any>;
    const br = (pf['betResponse'] ?? null) as Record<string, any> | null;
    const rr = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
    const stats = ((ctx?.['profileV3'] ?? {}) as Record<string, any>);
    const dims = stats['resolvedDimensions'] ?? stats['dimensions'] ?? null;
    const range = (ctx?.['range'] ?? null) as Record<string, any> | null;
    console.log(
      `   ${pLabel}` +
      `\n      画像: base=${String(stats['baseArchetype'])} 统计项=${String(stats['observedStatCount'])} 可信=${String(stats['confidenceTierZh'])}` +
      ` ｜ resolvedDimensions=${j(dims, 240)}` +
      `\n      范围: primary[${String(range?.['opponentId'])} ${String(range?.['sourceKind'])} conf=${num(range?.['confidence'], 2)} support=${String(range?.['supportSize'])}] ｜ opponentRanges=${(ctx?.['opponentRanges'] as unknown[] | undefined)?.length ?? 0} ｜ profileAppliedToRange=${String(ctx?.['profileAppliedToRange'])}` +
      `\n      权益: heroEq=${pct(m['heroEquity'])} EqBetRange=${pct(m['heroEquityVsBetRange'])} arr=${pct((r.dg!['conditionalEquities'] ?? {})['arrivalRange'])} bet=${pct((r.dg!['conditionalEquities'] ?? {})['betRange'])} raiseCont=${j((r.dg!['conditionalEquities'] ?? {})['raiseContinueRange'], 60)}` +
      `\n      响应: bet=${br === null ? '—' : j({ f: br['foldLikelihood'], c: br['callLikelihood'], r: br['reRaiseLikelihood'] }, 100)} raise=${rr === null ? '—' : j({ f: rr['foldLikelihood'], c: rr['callLikelihood'], r: rr['reRaiseLikelihood'] }, 100)}` +
      `\n      决策: ${String(r.d!['action'])}${r.d!['sizeChips'] === undefined ? '' : ` ${num(r.d!['sizeChips'])}`} ｜ src=${String((r.dg!['decisionSource'] ?? {})['kind'])} ｜ conf=${num(r.d!['confidence'], 2)} ｜ EV[CHECK=${j(evidenceOf(r.dg!, 'CHECK')?.['ev'], 20)} BET=${j(evidenceOf(r.dg!, 'BET')?.['ev'], 20)} CALL=${j(evidenceOf(r.dg!, 'CALL')?.['ev'], 20)} RAISE=${j(evidenceOf(r.dg!, 'RAISE')?.['ev'], 20)}]`,
    );
  }
}

/* ============================================================
 * §3 明细块
 * ============================================================ */
const detailArg = process.argv.slice(2).filter((x) => !x.startsWith('--'));
const DETAIL = detailArg.length > 0 ? detailArg : ['F-01', 'F-05', 'R-01', 'R-03', 'R-05', 'R-06'];
console.log('');
console.log('='.repeat(120));
console.log(`§3 明细块（Part-6 模板）：${DETAIL.join(' / ')} × NORMAL / MANIAC`);
console.log('='.repeat(120));
for (const [tag, desc, base, focus] of NODES) {
  if (!DETAIL.includes(tag)) continue;
  for (const profile of ['NORMAL', 'MANIAC'] as const) {
    const input = { ...(base as unknown as Record<string, unknown>), villain: OPP(profile) } as unknown as ManualHandInput;
    const r = runOf(input);
    if (!r.ok) { console.log(`\n【${tag} · ${profile}】✖ ${String(r.stage)}`); continue; }
    const m = (r.dg!['math'] ?? {}) as Record<string, any>;
    const pf = (r.dg!['postflop'] ?? {}) as Record<string, any>;
    const lg = (r.dg!['legal'] ?? null) as Record<string, any> | null;
    const eq = (r.dg!['conditionalEquities'] ?? {}) as Record<string, any>;
    const br = (pf['betDecision'] ?? null) as Record<string, any> | null;
    const rr = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
    const sizing = (pf['betRangeSizing'] ?? null) as Record<string, any> | null;
    const src = (r.dg!['decisionSource'] ?? {}) as Record<string, any>;
    console.log('');
    console.log(`【${tag} · ${desc} · ${profile}】`);
    console.log(`  ① 局面: street=${String(m['street'])} pot=${num(m['pot'])} call=${num(m['callCost'])} 有效筹码=${num(m['effectiveStack'])} spr=${num(m['spr'], 2)} 我的剩余=${num(m['myRemainingStack'])}`);
    console.log(`  ② 牌力: ${String(m['handRankZh'])} ｜ 类别=${String(m['handCategory'])} ｜ 成手=${String(pf['madeHandZh'] ?? '—')} ｜ 角色=${String(pf['handRoleZh'] ?? '—')}(${num(pf['roleStrength'], 3)}) ｜ SD价值=${num(pf['showdownValue'], 3)} 保护=${num(pf['protectionValue'], 3)} 诈唬潜力=${num(pf['bluffPotential'], 3)}`);
    console.log(`  ③ 合法: actions=${j(r.dg!['actionEvidence'] ? (lg?.['actions'] ?? '—') : '—', 120)} ｜ 棋盘纹理=${j(pf['boardTextureZh'] ?? pf['texture'] ?? '—', 160)} ｜ 承诺=${j(pf['commitment'], 200)}`);
    console.log(`  ④ 范围: arrival=${j(eq['arrivalRange'], 40)} betRange=${j(eq['betRange'], 40)} wholeRange=${j(eq['wholeRange'], 40)} raiseContinue=${j(eq['raiseContinueRange'], 60)} 加注门槛用=${String(eq['usedByRaiseThreshold'])}`);
    console.log(`  ⑤ 权益: heroEq=${pct(m['heroEquity'], 3)} EqBetRange=${pct(m['heroEquityVsBetRange'], 3)} req=${pct(m['requiredEquity'], 3)} winnable=${num(m['winnable'])} equitySource=${j(m['equitySource'], 160)}`);
    console.log(`  ⑥ EV: ${j(candsOf(r.dg!).map((c) => `${String(c['action'])}@${c['sizeChips'] === undefined ? '-' : num(c['sizeChips'])}:${c['ev'] === null ? 'null' : num(c['ev'], 2)}`), 400)}`);
    console.log(`     证据表: ${j((r.dg!['actionEvidence'] ?? []).map((e) => ({ a: e['action'], t: e['estimateType'], ev: e['ev'] === null ? null : Number(Number(e['ev']).toFixed(2)), m: e['decisionMargin'], cs: e['commitsStack'] ?? null })), 700)}`);
    console.log(`     未评估: ${j((r.dg!['unevaluatedActions'] ?? []).map((u) => `${String(u['action'])}@${String(u['sizeChips'])}:${String(u['reasonCode'])}`), 400)}`);
    console.log(`  ⑦ 响应模型: bet=${br === null ? 'null' : j({ model: br['model'], sizes: (br['sizes'] ?? []).map((s: Record<string, any>) => `${String(s['kind'])}@${num(s['betAmount'])} ev=${s['betEV'] === null ? 'null' : num(s['betEV'], 1)}`), best: br['bestSize'], checkEV: br['checkEV'], approximation: br['sizeApproximation'] }, 500)} ｜ 尺寸事实=${j(sizing, 200)}`);
    console.log(`            raise=${rr === null ? 'null' : j({ sz: rr['sizeChips'], ev: rr['raiseEV'], f: rr['foldLikelihood'], c: rr['callLikelihood'], r: rr['reRaiseLikelihood'], approx: rr['sizeApproximation'], price: rr['model']?.['priceRequiredEquity'] }, 400)}`);
    console.log(`  ⑧ 决策: ${String(r.d!['action'])}${r.d!['sizeChips'] === undefined ? '' : ` ${num(r.d!['sizeChips'])}`} ｜ 来源=${j(src, 300)} ｜ 边际=${j(r.dg!['decisionMargin'], 240)} ｜ conf=${num(r.d!['confidence'], 3)} ｜ 分类=${String(r.d!['classification'])}`);
    console.log(`  ⑨ 一致性: violations=${j((r.dg!['consistency'] ?? {})['violations'], 200)} ｜ warnings=${j(r.warnings, 300)}`);
    console.log(`  ⑩ 首屏: ${j(r.vm?.['actionZh'], 60)} ${j(r.vm?.['sizeZh'], 120)} ｜ 理由=${j(((r.d!['reasons'] ?? []) as Record<string, any>[]).slice(0, 4).map((x) => String(x['code'])), 200)}`);
    for (const [i, reason] of ((r.d!['reasons'] ?? []) as Record<string, any>[]).slice(0, 4).entries()) {
      console.log(`      ${i + 1}. [${String(reason['code'])}] ${j(reason['textZh'], 240)}`);
    }
  }
}
console.log('');
console.log('（只读扫描结束）');
