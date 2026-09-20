/**
 * Agent 9 · 探针 1：权益口径 / 范围构成 / 响应概率（只读）
 *
 * 覆盖 M1 M2 M3 M4 M5 M8 M10 M14 M15 M17 M18
 * 全部走生产入口 `analyzeManualHand`，不单独调用数学函数。
 */
import {
  A_, BASE, MANIAC, NORMAL, detailOf, guard, line, kv, rule, n, pct, J, type Rec,
} from './flopriver-agent4-lib.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const H = (over: Record<string, unknown>): ManualHandInput => ({ ...BASE, ...over } as unknown as ManualHandInput);

/* 基准节点：BTN 99，转牌面对 BB 领打 10BB（仓库既有节点） */
const TURN_FACE_10 = [
  A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
  A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
  A_('BB', 'BET', 10, 'TURN'),
];
const TURN_FACE = (bet: number) => [
  A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
  A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
  A_('BB', 'BET', bet, 'TURN'),
];
const FLOP_FACE = [
  A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
  A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
  A_('BB', 'BET', 6, 'FLOP'),
];
const RIVER_FACE = [
  A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
  A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
  A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'),
  A_('BB', 'BET', 20, 'RIVER'),
];
/* 无人下注的 CHECK/BET 节点（我在后位，前面都过牌） */
const FLOP_CHECKED_TO_HERO = [
  A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
  A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
  A_('BB', 'CHECK', undefined, 'FLOP'),
];
const TURN_CHECKED_TO_HERO = [
  A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
  A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
  A_('BB', 'CHECK', undefined, 'TURN'),
];

function section(title: string): void {
  line('');
  line(rule());
  line(` ${title}`);
  line(rule());
}

/* ============================================================
 * §1 M1 / M17：权益口径与裁决标尺
 * ============================================================ */
section('§1 M1/M17 · 权益口径与裁决标尺（单层恒等式 verdictEdge == callEV / winnable）');
line('  节点                                  | action        | EqWhole | EqVsBet | reqEq   | callEV    | callEV/winnable | 一致? | 分类');
const m1Nodes: ReadonlyArray<readonly [string, ManualHandInput]> = [
  ['TURN 99 面对 10BB', H({ heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_FACE_10, villain: MANIAC })],
  ['TURN AK 面对 10BB', H({ heroCards: ['As', 'Ks'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_FACE_10, villain: MANIAC })],
  ['TURN AA 面对 20BB', H({ heroCards: ['As', 'Ah'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_FACE(20), villain: MANIAC })],
  ['RIVER AA 面对 20BB', H({ heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: RIVER_FACE, villain: MANIAC })],
  ['FLOP 听花 AcJc 面对 6BB', H({ heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c'], street: 'FLOP', actionHistory: FLOP_FACE, villain: MANIAC })],
  ['FLOP 空气 AsKs 面对 6BB', H({ heroCards: ['As', 'Ks'], board: ['Jd', '8c', '4c'], street: 'FLOP', actionHistory: FLOP_FACE, villain: MANIAC })],
];
const m1Details: Rec[] = [];
for (const [tag, input] of m1Nodes) {
  const d = guard(input, tag);
  m1Details.push(d as unknown as Rec);
  if (!d.r.ok) continue;
  const m = d.math;
  const ratio = m['callEV'] === null || !(m['winnable'] > 0) ? null : m['callEV'] / m['winnable'];
  kv(tag, '', 40);
  kv('  action / callEV / winnable', `${String(d.decision['action'])} ${String(d.decision['sizeChips'] ?? '')} ｜ ${n(m['callEV'], 6)} ｜ ${n(m['winnable'], 4)}`);
  kv('  EqWhole / EqVsBet / reqEq', `${pct(m['heroEquity'], 4)} ｜ ${pct(m['heroEquityVsBetRange'], 4)} ｜ ${pct(m['requiredEquity'], 4)}`);
  kv('  callEV/winnable vs (EqWhole-reqEq)', `${ratio === null ? '—' : pct(ratio, 4)} ｜ ${pct((m['heroEquity'] ?? 0) - m['requiredEquity'], 4)}`);
  kv('  requiredEquityApplies', String(m['requiredEquityApplies']));
  kv('  classification / source', `${String(d.decision['classification'])} ｜ ${J(d.dg['decisionSource'], 150)}`);
  kv('  consistency.violations', J((d.dg['consistency'] as Rec | undefined)?.['violations'] ?? [], 300));
  kv('  sanity', J(d.sanity, 300));
}
void m1Details;

/* ============================================================
 * §2 M3：对手「实际动作」是否进入条件范围（改变同一街的下注额）
 * ============================================================ */
section('§2 M3 · 同一街不同下注额 ⇒ 条件范围/权益必须变化（否则实际动作未进入）');
line('  下注额 | EqVsBetRange | EqWhole | arrivalMass | betMass | betShare | actualRatio | sizeApprox');
for (const bet of [4, 10, 20, 40]) {
  const d = guard(H({ heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_FACE(bet), villain: MANIAC }), `TURN bet ${bet}`);
  if (!d.r.ok) continue;
  const br = (d.pf['bettingRangeFacts'] ?? null) as Rec | null;
  const arr = (d.pf['betRangeArrival'] ?? null) as Rec | null;
  const sizing = (br?.['sizing'] ?? br?.['model'] ?? {}) as Rec;
  kv(`  ${String(bet).padStart(2)}BB `, '', 10);
  line(
    `        EqVsBet=${pct(d.math['heroEquityVsBetRange'], 4)}  EqWhole=${pct(d.math['heroEquity'], 4)}  ` +
    `arrivalMass=${n(br?.['arrivalMass'], 3)}  betMass=${n(br?.['betMass'], 3)}  betShare=${n(br?.['betShareOfArrival'], 4)}  ` +
    `model=${J(br?.['model'], 220)}`,
  );
  if (bet === 10) {
    kv('  betRangeArrival.excludedActionZh', J(arr?.['excludedActionZh'], 300));
    kv('  betRangeArrival.noteZh', J(arr?.['noteZh'], 400));
    kv('  bettingRangeFacts.noteZh', J(br?.['noteZh'], 300));
    kv('  warnings', J(d.r.warnings, 500));
  }
}

/* ============================================================
 * §3 M2：下注动作是否被计入两次（捕捉 rangeBeforeAction 是否成功）
 * ============================================================ */
section('§3 M2 · 重复计票：betRangeArrival 是否成功捕获「当前下注之前」的范围');
for (const [tag, input] of [
  ['TURN 面对 bet（MANIAC）', H({ heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_FACE_10, villain: MANIAC })],
  ['TURN 面对 bet（NORMAL）', H({ heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_FACE_10, villain: NORMAL })],
  ['RIVER 面对 bet（MANIAC）', H({ heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: RIVER_FACE, villain: MANIAC })],
  ['FLOP 面对 bet（MANIAC）', H({ heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c'], street: 'FLOP', actionHistory: FLOP_FACE, villain: MANIAC })],
] as ReadonlyArray<readonly [string, ManualHandInput]>) {
  const d = guard(input, tag);
  if (!d.r.ok) continue;
  const arr = (d.pf['betRangeArrival'] ?? null) as Rec | null;
  const warn = (d.r.warnings as readonly string[]).filter((w) => w.includes('重复') || w.includes('下注范围'));
  kv(tag, `arrival=${arr === null ? 'null' : 'present'}｜heroEqVsArrival=${pct(arr?.['heroEquityVsArrivalRange'], 4)}｜EqVsBet=${pct(d.math['heroEquityVsBetRange'], 4)}`);
  kv('  重复计票告警', warn.length === 0 ? '（无）' : J(warn, 400));
}

/* ============================================================
 * §4 M4：Hero 底牌是否泄漏进对手的动作概率模型
 * ============================================================ */
section('§4 M4 · Hero 底牌泄漏：固定对手/牌面/行动，只换 Hero 底牌 ⇒ 对手 bandRates 必须逐位相同');
line('  Hero 底牌 | bandRates 哈希 | bandRates(NUT/STRONG/TPG/MID/WEAK/AIR) | EqVsBet');
const heroVariants: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['9h9c', ['9h', '9c']],
  ['AsKs', ['As', 'Ks']],
  ['2h3d', ['2h', '3d']],
  ['AcJc', ['Ac', 'Jc']],
];
const bandRateStrings: string[] = [];
for (const [tag, cards] of heroVariants) {
  const d = guard(H({ heroCards: cards, board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_FACE_10, villain: MANIAC }), tag);
  if (!d.r.ok) continue;
  const br = (d.pf['bettingRangeFacts'] ?? null) as Rec | null;
  const rates = (br?.['bandRates'] ?? {}) as Rec;
  const keys = ['NUT', 'STRONG_MADE', 'TOP_PAIR_GOOD', 'MIDDLE_PAIR', 'WEAK_PAIR', 'AIR'];
  const vals = keys.map((k) => n(rates[k], 6)).join(' ');
  bandRateStrings.push(vals);
  const raised = ((d.pf['raiseResponse'] ?? null) as Rec | null)?.['model'] as Rec | undefined;
  kv(`${tag}`, `${vals} ｜ EqVsBet=${pct(d.math['heroEquityVsBetRange'], 4)}`);
  kv('  raiseResponse.model.usesHeroHiddenCards', String(raised?.['usesHeroHiddenCards']));
  kv('  raiseResponse.fold/call/reRaise', `${n(((d.pf['raiseResponse'] ?? null) as Rec | null)?.['foldLikelihood'], 6)} / ${n(((d.pf['raiseResponse'] ?? null) as Rec | null)?.['callLikelihood'], 6)} / ${n(((d.pf['raiseResponse'] ?? null) as Rec | null)?.['reRaiseLikelihood'], 6)}`);
}
kv('bandRates 全部相同?', String(new Set(bandRateStrings).size === 1));

/* ============================================================
 * §5 M5：无实测统计时是否仍产出「每街弃牌频率」，以及统计是否真的改变它
 * ============================================================ */
section('§5 M5 · 没有 observedStats 时的弃牌/跟注/再加注频率 + 有统计时是否改变');
const noStats: ManualVillain = { seatId: 'seat_BB', persistentPlayerId: 'player_001', quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 };
const withStats = (foldTurn: number | null, hands: number): ManualVillain => ({
  ...noStats, observedStats: {
    handsObserved: hands, vpip: 0.3, pfr: 0.2, threeBet: 0.08, wtsd: 0.28,
    foldToFlopCBet: null, foldToTurnCBet: foldTurn, foldToRiverBet: null,
    flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
  },
} as ManualVillain);
const m5Variants: ReadonlyArray<readonly [string, ManualVillain]> = [
  ['无 observedStats', noStats],
  ['800 手 foldToTurnCBet=0.20', withStats(0.2, 800)],
  ['800 手 foldToTurnCBet=0.75', withStats(0.75, 800)],
  ['20 手 foldToTurnCBet=0.75', withStats(0.75, 20)],
];
line('  画像                              | fold | call | reRaise | tendenciesZh');
for (const [tag, villain] of m5Variants) {
  const d = guard(H({ heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_FACE_10, villain }), tag);
  if (!d.r.ok) continue;
  const rr = (d.pf['raiseResponse'] ?? null) as Rec | null;
  kv(`  ${tag}`, `${n(rr?.['foldLikelihood'], 6)} | ${n(rr?.['callLikelihood'], 6)} | ${n(rr?.['reRaiseLikelihood'], 6)}`);
  kv('    model.noteZh', J(rr?.['model']?.['noteZh'], 260));
  kv('    model.evidence', String(rr?.['model']?.['evidence']));
}

/* ============================================================
 * §6 M8：CHECK EV 是否把翻牌/转牌当摊牌终止
 * ============================================================ */
section('§6 M8 · CHECK EV 的 kind（SHOWDOWN_TERMINAL vs HEURISTIC_ONE_STREET）');
for (const [tag, input] of [
  ['FLOP 都过牌到我（BTN 听花）', H({ heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c'], street: 'FLOP', actionHistory: FLOP_CHECKED_TO_HERO, villain: MANIAC })],
  ['TURN 都过牌到我（BTN 听花）', H({ heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_CHECKED_TO_HERO, villain: MANIAC })],
] as ReadonlyArray<readonly [string, ManualHandInput]>) {
  const d = guard(input, tag);
  if (!d.r.ok) continue;
  const bd = (d.pf['betDecision'] ?? null) as Rec | null;
  const ct = (bd?.['checkTree'] ?? null) as Rec | null;
  kv(tag, '');
  kv('  action', `${String(d.decision['action'])} ${String(d.decision['sizeChips'] ?? '')}`);
  kv('  checkTree.kind / checkEV / evShowdown', `${String(ct?.['kind'])} ｜ ${n(ct?.['checkEV'], 4)} ｜ ${n(ct?.['evShowdown'], 4)}`);
  kv('  checkRealizationFactor / betLikelihood', `${n(bd?.['checkRealizationFactor'], 4)} ｜ ${n(ct?.['betLikelihood'], 4)}`);
  kv('  checkTree.noteZh', J(ct?.['noteZh'], 320));
}

/* ============================================================
 * §7 M10：全下金额口径（本街累计 vs 剩余筹码）
 * ============================================================ */
section('§7 M10 · allInToAmount == 本街已投入 + 剩余筹码 ?');
for (const [tag, input] of [
  ['TURN 面对加注到 40BB（TEST18）', H({
    heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN',
    actionHistory: [
      A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
      A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
      A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'RAISE', 40, 'TURN'),
    ], villain: MANIAC,
  })],
  ['RIVER AA 面对 20BB', H({ heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: RIVER_FACE, villain: MANIAC })],
] as ReadonlyArray<readonly [string, ManualHandInput]>) {
  const d = guard(input, tag);
  if (!d.r.ok) continue;
  const L = d.legal;
  kv(tag, '');
  kv('  allInToAmount / myRemainingStack', `${n(L['allInToAmount'], 4)} ｜ ${n(L['myRemainingStack'], 4)}`);
  kv('  math.myCommittedThisStreet / math.pot', `${n(d.math['myCommittedThisStreet'], 4)} ｜ ${n(d.math['pot'], 4)}`);
  kv('  恒等式 allIn == committed + remaining', String(Math.abs((L['allInToAmount'] as number) - ((d.math['myCommittedThisStreet'] as number) + (L['myRemainingStack'] as number))) < 1e-6));
  kv('  vm.sizeZh', J(d.vm['sizeZh'], 200));
}

/* ============================================================
 * §8 M14/M13：河牌范围类别（错失听牌是否计入诈唬；弱牌是否被过滤光）
 * ============================================================ */
section('§8 M13/M14 · 河牌范围构成：weakerThanHeroCount / 价值/诈唬候选 / 错失听牌类');
for (const [tag, cards, board] of [
  ['RIVER AA（顶三条）', ['As', 'Ah'], ['Ad', '9c', '4h', '6s', '2d']],
  ['RIVER 顶对 K', ['Kd', 'Qc'], ['Kh', '8c', '4c', '6s', '9d']],
  ['RIVER 错失听花（AcJc）', ['Ac', 'Jc'], ['Jd', '8c', '4c', '6s', '2h']],
] as ReadonlyArray<readonly [string, readonly string[], readonly string[]]>) {
  const d = guard(H({ heroCards: cards, board, street: 'RIVER', actionHistory: RIVER_FACE, villain: MANIAC }), tag);
  if (!d.r.ok) continue;
  const rc = (d.pf['rangeCounts'] ?? {}) as Rec;
  kv(tag, '');
  kv('  reachableRangeCount / weaker / stronger', `${String(rc['reachableRangeCount'])} ｜ ${String(rc['weakerThanHeroCount'])} ｜ ${String(rc['strongerThanHeroCount'])}`);
  kv('  clearValue / thinValue / valueBetCandidate / bluffCandidate', `${String(rc['clearValueCount'])} ｜ ${String(rc['thinValueCount'])} ｜ ${String(rc['valueBetCandidateCount'])} ｜ ${String(rc['bluffCandidateCount'])}`);
  kv('  showdownCount / uncertainCount', `${String(rc['showdownCount'])} ｜ ${String(rc['uncertainCount'])}`);
  kv('  valueAssessment.worseHandsCanCall / worseCallDensity', `${String(((d.pf['valueAssessment'] ?? {}) as Rec)['worseHandsCanCall'])} ｜ ${n(((d.pf['valueAssessment'] ?? {}) as Rec)['worseCallDensity'], 4)}`);
}
/* 下注范围类别质量（含 MISSED_* 类） */
{
  const d = guard(H({ heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_FACE_10, villain: MANIAC }), 'TURN 99');
  if (d.r.ok) {
    const br = (d.pf['bettingRangeFacts'] ?? null) as Rec | null;
    kv('TURN 99 · betRange classMasses', J(br?.['classMasses'], 500));
    kv('TURN 99 · betRange bandMasses.bet', J(br?.['bandMasses'], 400));
  }
}

/* ============================================================
 * §9 M15：翻牌听牌的 CALL EV 是否用「完全实现」权益，而 CHECK/BET 用折减权益
 * ============================================================ */
section('§9 M15 · 翻牌/转牌上 CALL EV 与 CHECK/BET 的权益实现口径是否一致');
for (const [tag, input] of [
  ['FLOP 听花 AcJc 面对 6BB', H({ heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c'], street: 'FLOP', actionHistory: FLOP_FACE, villain: MANIAC })],
  ['TURN 听花 AcJc 面对 10BB', H({ heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_FACE_10, villain: MANIAC })],
] as ReadonlyArray<readonly [string, ManualHandInput]>) {
  const d = guard(input, tag);
  if (!d.r.ok) continue;
  const bd = (d.pf['betDecision'] ?? null) as Rec | null;
  const real = (bd?.['realization'] ?? null) as Rec | null;
  const ct = (bd?.['checkTree'] ?? null) as Rec | null;
  const eqVsBet = d.math['heroEquityVsBetRange'] as number | null;
  const winnable = d.math['winnable'] as number;
  const callCost = d.math['callCost'] as number;
  const factor = real?.['factor'] as number | undefined;
  kv(tag, '');
  kv('  action / callEV', `${String(d.decision['action'])} ${String(d.decision['sizeChips'] ?? '')} ｜ ${n(d.math['callEV'], 4)}`);
  kv('  EqVsBet（原样） / realizationFactor', `${pct(eqVsBet, 4)} ｜ ${n(factor, 4)}`);
  kv('  CALL EV 若乘实现因子', `${n((eqVsBet ?? 0) * (factor ?? 1) * winnable - callCost, 4)}（生产值 ${n(d.math['callEV'], 4)}）`);
  kv('  checkEV（已乘因子?） / evShowdown', `${n(ct?.['checkEV'], 4)} ｜ ${n(ct?.['evShowdown'], 4)}`);
  kv('  realization.noteZh', J(real?.['noteZh'], 260));
  kv('  callEV != 乘因子后的值?', String(Math.abs(((eqVsBet ?? 0) * (factor ?? 1) * winnable - callCost) - (d.math['callEV'] as number)) > 1e-6));
}

/* ============================================================
 * §10 M18：候选表里同一动作/同一金额是否重复
 * ============================================================ */
section('§10 M18 · 候选 (action, sizeChips) 重复检查');
{
  let dupTotal = 0;
  for (const [tag, input] of [
    ...m1Nodes,
    ['TURN 无人下注（BET 节点）', H({ heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_CHECKED_TO_HERO, villain: MANIAC })],
    ['FLOP 无人下注（BET 节点）', H({ heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c'], street: 'FLOP', actionHistory: FLOP_CHECKED_TO_HERO, villain: MANIAC })],
  ] as ReadonlyArray<readonly [string, ManualHandInput]>) {
    const d = guard(input, tag);
    if (!d.r.ok) continue;
    const cands = (d.dg['candidates'] as readonly Rec[]) ?? [];
    const seen = new Map<string, number>();
    const dups: string[] = [];
    for (const c of cands) {
      const key = `${String(c['action'])}@${String(c['sizeChips'])}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [k, v] of seen) if (v > 1) dups.push(`${k}×${v}`);
    dupTotal += dups.length;
    const allIn = d.legal['allInToAmount'] as number;
    const atAllIn = cands.filter((c) => typeof c['sizeChips'] === 'number' && Math.abs((c['sizeChips'] as number) - allIn) < 1e-9);
    kv(tag, `${cands.length} 个候选｜重复=${dups.length === 0 ? '无' : dups.join(',')}｜全下额候选=${atAllIn.map((c) => String(c['action'])).join('/') || '无'}`);
  }
  kv('重复总计', dupTotal);
}

/* ============================================================
 * §11 M11：未被评估的加注尺寸是否被描述成「EV 更低」
 * ============================================================ */
section('§11 M11 · unevaluatedActions 的措辞与实际 EV');
for (const [tag, input] of m1Nodes.slice(0, 3)) {
  const d = guard(input, tag);
  if (!d.r.ok) continue;
  kv(tag, '');
  kv('  unevaluatedActions', J(d.dg['unevaluatedActions'], 700));
  const texts = ((d.decision['reasons'] as readonly Rec[]) ?? []).map((r) => String(r['textZh']));
  const hits = texts.filter((t) => t.includes('更低') || t.includes('EV 低') || t.includes('未评估'));
  kv('  理由含「更低/未评估」', hits.length === 0 ? '（无）' : J(hits, 600));
  kv('  alternativeActions', J(d.dg['alternativeActions'], 600));
}
