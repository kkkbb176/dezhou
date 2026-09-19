/**
 * ============================================================================
 * P1 · 99 中对决策一致性定向审计（**只读**）
 * ============================================================================
 *
 * 复现节点：**原始牌局**（取自 `scripts/test18-amount-matrix.ts` 的 99 用例，
 * 与 `reports/evidence/test18-amount-matrix.txt` 的原始输出一致 —— 未另造牌局）：
 *
 *   6 人桌 · 盲注 1/2 · 双方 100BB（200 筹码）
 *   Hero BTN 9♥9♣ ｜ 公共牌 J♦8♣4♣6♠（转牌）
 *   翻前：UTG/HJ/CO 弃 → BTN 加注至 6 → SB 弃 → BB 跟注 6
 *   翻牌：BB 过牌 → BTN 下注 8 → BB 跟注
 *   转牌：BB 主动下注 20（Hero 面对下注）
 *   对手：阿豪（seat_BB / player_001 / MANIAC / 800 手 VPIP48 PFR35 3Bet16 WTSD36，其余 null）
 *
 * 输出：§二 输入核对、§三 EV 与权益口径、§四 逐层追踪（数学 → 候选 → 边际 → 证据优先级 →
 *       战略守门 → 最终动作 → 最终检查 → 用户可见理由）、§五 墨菲 A–F 对照。
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
const HISTORY = [
  A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
  A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
  A_('BB', 'BET', 10, 'TURN'),
];
const maniac: ManualVillain = {
  seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
  observedStats: { handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null },
};
/** 原始节点（99，MANIAC 阿豪） */
const originalInput = { ...base, heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: HISTORY, villain: maniac } as unknown as ManualHandInput;

const n = (v: unknown, d = 6): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const pct = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : String(v));
const line = (s = ''): void => console.log(s);
const kv = (k: string, v: unknown, w = 42): void => line(`  ${k.padEnd(w)}${String(v)}`);
const rule = (w = 104): string => '─'.repeat(w);

type Detail = {
  readonly decision: Record<string, any>;
  readonly dg: Record<string, any>;
  readonly math: Record<string, any>;
  readonly pf: Record<string, any>;
  readonly rr: Record<string, any> | null;
  readonly br: Record<string, any> | null;
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
    rr: (((dg['postflop'] ?? {}) as Record<string, any>)['raiseResponse'] ?? null) as Record<string, any> | null,
    br: (((dg['postflop'] ?? {}) as Record<string, any>)['bettingRangeFacts'] ?? null) as Record<string, any> | null,
    legal: built.legal as unknown as Record<string, any>,
    built: built as unknown as Record<string, any>,
    warnings: r.warnings as readonly string[],
    vm: r.viewModel as unknown as Record<string, any>,
    sanity: finalMathSanityCheck(decision as never, built.legal as never),
  };
}

const D = detailOf(originalInput);

/* ============================================================
 * §二 输入核对
 * ============================================================ */
line(rule());
line(' §二 · 原始节点输入核对（生产入口 analyzeManualHand）');
line(rule());
kv('Hero 位置 / 手牌 / 公共牌', 'BTN ｜ 9♥9♣ ｜ J♦ 8♣ 4♣ 6♠（转牌）');
kv('盲注 / 有效起始筹码', '1/2 ｜ 200 筹码 = 100BB（双方）');
kv('行动历史', JSON.stringify(HISTORY.map((h) => `${String(h['position'])} ${String(h['type'])}${h['amountBB'] === undefined ? '' : ` ${String(h['amountBB'])}BB`}${h['street'] === undefined ? '' : `@${String(h['street'])}`}`)));
kv('对手画像', `阿豪 ｜ seat_BB ｜ player_001 ｜ MANIAC ｜ 800 手 VPIP 48% / PFR 35% / 3Bet 16% / WTSD 36%；其余统计 null`);
kv('当前街 / 底池 / 跟注', `${String(D.math['street'])} ｜ ${n(D.math['pot'], 2)} ｜ ${n(D.math['callCost'], 2)}`);
kv('我的剩余 / 有效筹码 / SPR', `${n(D.math['myRemainingStack'], 2)} ｜ ${n(D.math['effectiveStack'], 2)} ｜ ${n(D.math['spr'], 3)}`);
kv('所需权益 / 可争夺量', `${pct(D.math['requiredEquity'])} ｜ ${n(D.math['winnable'], 2)}（requiredEquityApplies=${String(D.math['requiredEquityApplies'])}）`);
kv('牌力（引擎）', `${String(D.math['handRankZh'])} ｜ 成手 ${String(D.pf['madeHandZh'])} ｜ 角色 ${String(D.pf['handRoleZh'])}（${n(D.pf['roleStrength'], 3)}）`);
kv('合法动作', `${JSON.stringify(D.legal['actions'])} ｜ minRaiseTo ${n(D.legal['minRaiseToAmount'], 2)} ｜ allInTo ${n(D.legal['allInToAmount'], 2)} ｜ currentBet ${n(D.legal['currentBet'], 2)}`);

/* ============================================================
 * §三 第一性原理：EV 与权益口径
 * ============================================================ */
line('');
line(rule());
line(' §三 · EV / 权益口径（独立复算）');
line(rule());
const callCand = (D.dg['candidates'] as readonly Record<string, any>[]).find((c) => c['action'] === 'CALL');
const foldCand = (D.dg['candidates'] as readonly Record<string, any>[]).find((c) => c['action'] === 'FOLD');
kv('FOLD EV', `${n(foldCand?.['ev'], 6)}（节点增量零点）`);
kv('CALL EV（生产）', n(D.math['callEV'], 12));
kv('CALL 候选 sizeChips / ev', `${n(callCand?.['sizeChips'], 2)} ｜ ${n(callCand?.['ev'], 6)}`);
kv('RAISE EV（被选中尺寸）', D.rr === null ? '—' : `${n(D.rr['raiseEV'], 12)}（尺寸 ${String(D.rr['sizeChips'])}）`);
kv('CALL 所需权益', pct(D.math['requiredEquity'], 6));
kv('Hero Equity vs **Bet Range**', pct(D.math['heroEquityVsBetRange'], 12));
kv('Hero Equity 整体/到达范围', pct(D.math['heroEquity'], 12));
kv('CALL EV 的实际权益来源', D.math['heroEquityVsBetRange'] !== null ? 'EqVsBetRange（下注范围权益）' : 'FALLBACK_WHOLE_RANGE');
kv('权益估计类型', `${JSON.stringify(D.math['equitySource'])}`);
kv('抽水 / 未来街', `rakeModel=${String(D.math['rakeModel'])} ｜ 权益已枚举河牌（${String(D.math['equitySource']?.['iterations'])} 局）`);
const recomputed = D.math['heroEquityVsBetRange'] * D.math['winnable'] - D.math['callCost'];
kv('复算 EqVsBetRange × winnable − callCost', `${n(recomputed, 12)} ⇒ 与生产差 ${n(Math.abs(recomputed - D.math['callEV']), 15)}`);
const arrivalRecompute = D.math['heroEquity'] * D.math['winnable'] - D.math['callCost'];
kv('（反证）用整体范围权益复算', `${n(arrivalRecompute, 12)} ⇒ 与生产差 ${n(Math.abs(arrivalRecompute - D.math['callEV']), 6)}`);
const band = 0.05 * D.math['winnable'];
kv('模型容差带 ±5%（MARGINAL_EV_GAP_RATIO × winnable）', `${n(band, 6)} 筹码`);
kv('CALL EV 是否在容差带内', `${String(Math.abs(D.math['callEV']) <= band)}（|CALL EV| = ${n(Math.abs(D.math['callEV']), 6)}）`);
kv('CALL EV 的估计类型（候选）', `${String(callCand?.['estimateType'] ?? '（见 alternativeActions）')}`);

/* ============================================================
 * §四 逐层追踪
 * ============================================================ */
line('');
line(rule());
line(' §四 · 逐层追踪（数学 → 候选 → 边际 → 证据优先级 → 守门 → 动作 → 最终检查 → 理由）');
line(rule());
kv('① 数学层 verdictEdge / evEdge', `（见下：evEdge = callEV；verdictEdge = layeredEdge ?? edge）`);
kv('  edge（整体范围口径）', n((D.math['heroEquity'] - D.math['requiredEquity']) * 100, 4) + ' 个百分点');
kv('  evEdge（= callEV）', n(D.math['callEV'], 6));
kv('  MARGINAL_EV_GAP_RATIO / MATH_EV_EPSILON', '0.05 / 1e-6（decisionEngine.ts 常量）');
kv('② 候选构建', JSON.stringify((D.dg['candidates'] as readonly Record<string, any>[]).map((c) => ({ a: c['action'], s: c['sizeChips'], ev: c['ev'] }))));
kv('  alternativeActions', JSON.stringify((D.dg['alternativeActions'] as readonly Record<string, any>[]).map((a) => ({ a: a['action'], t: a['estimateType'], ev: a['ev'], st: a['statusZh'] }))));
kv('③ 决策边际 / 容差带', JSON.stringify(D.dg['decisionMargin'] ?? null));
kv('④ 证据优先级', JSON.stringify(D.dg['decisionSource'] ?? null));
kv('   actionEvidence（逐条）', '');
for (const e of (D.dg['actionEvidence'] as readonly Record<string, any>[]) ?? []) {
  line(`     · ${JSON.stringify(e)}`);
}
kv('⑤ 战略守门器 / 角色', `role=${String(D.pf['handRoleZh'])}（${n(D.pf['roleStrength'], 3)}）｜ showdownValue=${n(D.pf['showdownValue'], 4)} ｜ protection=${n(D.pf['protectionValue'], 4)} ｜ bluffPotential=${n(D.pf['bluffPotential'], 4)}`);
kv('   allInGuard / actionShape', `${JSON.stringify(D.dg['allInGuard'] ?? null).slice(0, 200)} ｜ ${JSON.stringify(D.dg['actionShape'] ?? null).slice(0, 160)}`);
kv('   commitment', JSON.stringify(D.pf['commitment'] ?? null).slice(0, 240));
kv('   evRanking', JSON.stringify(D.pf['evRanking'] ?? null).slice(0, 400));
kv('   trueEvRanking', JSON.stringify(D.pf['trueEvRanking'] ?? null).slice(0, 300));
kv('⑥ 最终动作', `**${String(D.decision['action'])}${D.decision['sizeChips'] === undefined ? '' : ` ${String(D.decision['sizeChips'])}`}** ｜ confidence ${n(D.decision['confidence'], 4)} ｜ band ${String(D.decision['band'])} ｜ ${String(D.decision['classification'])} ｜ actionable ${String(D.decision['actionable'])}`);
kv('⑦ finalMathSanityCheck 结果', D.sanity.length === 0 ? '无问题' : JSON.stringify(D.sanity));
kv('⑧ 一致性检查（consistency）', JSON.stringify(D.dg['consistency'] ?? null));
kv('   用户可见 warnings', JSON.stringify(D.warnings));
line('   用户可见理由：');
for (const [i, reason] of ((D.decision['reasons'] as readonly Record<string, any>[]) ?? []).entries()) {
  line(`     ${i + 1}. [${String(reason['code'])}] ${String(reason['textZh']).slice(0, 220)}`);
}
kv('   界面（首屏）', `${String(D.vm['actionZh'])} ${String(D.vm['sizeZh'] ?? '')} · ${String(D.vm['confidenceZh'])} · ${String(D.vm['classificationZh'])}`);

line('');
line(rule());
line(' §五 · 墨菲对照（A–F）：仅改对手条件范围/画像，赔率与合法动作不变');
line(rule());
const variants: ReadonlyArray<readonly [string, ManualVillain]> = [
  ['A 原始（MANIAC 阿豪，800 手）', maniac],
  ['B 紧弱型（VERY_TIGHT，无统计）', { seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'VERY_TIGHT', dynamicHint: 'UNKNOWN', stackBB: 100 }],
  ['B2 跟注站（CALLING_STATION，无统计）', { seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 100 }],
  ['C 极松凶（MANIAC + 高诈唬统计）', { seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: { handsObserved: 800, vpip: 0.72, pfr: 0.55, threeBet: 0.28, wtsd: 0.2, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null } }],
  ['D 中性（NORMAL，无统计）', { seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 }],
  ['E 无画像（UNKNOWN，无统计）', { seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', dynamicHint: 'UNKNOWN', stackBB: 100 }],
  ['F 只有分街统计（无四轴证据）', { seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: { handsObserved: 800, vpip: null, pfr: null, threeBet: null, wtsd: null, foldToFlopCBet: null, foldToTurnCBet: 0.55, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: 0.12, riverCheckRaise: null } }],
];
line('  变体                              | 动作        | CALL EV      | 所需权益 | EqVsBet | 容差带 | 在带内 | 分类      | 一致性告警');
for (const [tag, villain] of variants) {
  const input = { ...base, heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: HISTORY, villain } as unknown as ManualHandInput;
  const d = detailOf(input);
  const b = 0.05 * d.math['winnable'];
  const cons = (d.dg['consistency'] as Record<string, any> | undefined);
  const viol = (cons?.['violations'] as readonly Record<string, any>[] | undefined) ?? [];
  line(
    `  ${tag.padEnd(34)}| ${`${String(d.decision['action'])}${d.decision['sizeChips'] === undefined ? '' : ` ${String(d.decision['sizeChips'])}`}`.padEnd(12)}` +
    `| ${n(d.math['callEV'], 6).padStart(12)} | ${pct(d.math['requiredEquity'], 2).padStart(9)} | ${pct(d.math['heroEquityVsBetRange'], 2).padStart(8)} | ${n(b, 2).padStart(6)} | ${String(Math.abs(d.math['callEV']) <= b).padStart(6)} | ${String(d.decision['classification']).padEnd(9)} | ${viol.length === 0 ? '无' : viol.map((v) => String(v['code'])).join(',')}`,
  );
}
line(rule());
