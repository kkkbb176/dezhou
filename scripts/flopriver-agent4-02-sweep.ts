/**
 * Agent 9 · 探针 2：统计通道 / 画像衰减 / 披露措辞 / 河牌范围 / 大样本扫掠（只读）
 * 覆盖 M5 M6 M12 M13 M14 M16
 */
import {
  A_, BASE, MANIAC, detailOf, guard, line, kv, rule, n, pct, J, type Rec,
} from './flopriver-agent4-lib.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const H = (over: Record<string, unknown>): ManualHandInput => ({ ...BASE, ...over } as unknown as ManualHandInput);
const section = (t: string): void => { line(''); line(rule()); line(` ${t}`); line(rule()); };

const PRE = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];
/** 转牌无人下注 ⇒ Hero 可下注（非 facingBet 节点，betDecision 有值） */
const TURN_BET_NODE = [...PRE, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN')];
/** 河牌：对手领打（Hero 面对下注）⇒ 有他的河牌下注范围构成 */
const RIVER_DONK = [...PRE, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'BET', 20, 'RIVER')];

const statsOf = (o: Partial<Record<string, number | null>>, hands: number): ManualVillain['observedStats'] => ({
  handsObserved: hands,
  vpip: o['vpip'] ?? 0.3, pfr: o['pfr'] ?? 0.2, threeBet: o['threeBet'] ?? 0.08, wtsd: o['wtsd'] ?? 0.28,
  foldToFlopCBet: o['foldToFlopCBet'] ?? null, foldToTurnCBet: o['foldToTurnCBet'] ?? null, foldToRiverBet: o['foldToRiverBet'] ?? null,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
}) as ManualVillain['observedStats'];

const V = (over: Partial<ManualVillain>): ManualVillain => ({ seatId: 'seat_BB', persistentPlayerId: 'player_001', quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100, ...over } as ManualVillain);

/* ============================================================
 * §1 M5：面对下注（响应层）与 Hero 下注（betDecision 层）的弃牌率
 * ============================================================ */
section('§1 M5/M6 · 无实测统计 vs 有分街统计（同一节点、只改 observedStats）');
const STAT_VARIANTS: ReadonlyArray<readonly [string, ManualVillain]> = [
  ['A 只有标签 NORMAL（无统计）', V({ quickProfile: 'NORMAL' })],
  ['B 统计中性 axes=0.5（n=800）', V({ quickProfile: 'NORMAL', observedStats: statsOf({ vpip: 0.35, pfr: 0.25, threeBet: 0.1, wtsd: 0.3, foldToTurnCBet: 0.5, foldToFlopCBet: 0.5, foldToRiverBet: 0.5 }, 800) })],
  ['C foldToTurnCBet=0.20（n=800）', V({ quickProfile: 'NORMAL', observedStats: statsOf({ vpip: 0.35, pfr: 0.25, threeBet: 0.1, wtsd: 0.3, foldToTurnCBet: 0.2, foldToFlopCBet: 0.5, foldToRiverBet: 0.5 }, 800) })],
  ['D foldToTurnCBet=0.75（n=800）', V({ quickProfile: 'NORMAL', observedStats: statsOf({ vpip: 0.35, pfr: 0.25, threeBet: 0.1, wtsd: 0.3, foldToTurnCBet: 0.75, foldToFlopCBet: 0.5, foldToRiverBet: 0.5 }, 800) })],
  ['E foldToTurnCBet=0.75（n=20）', V({ quickProfile: 'NORMAL', observedStats: statsOf({ vpip: 0.35, pfr: 0.25, threeBet: 0.1, wtsd: 0.3, foldToTurnCBet: 0.75, foldToFlopCBet: 0.5, foldToRiverBet: 0.5 }, 20) })],
  ['F foldToTurnCBet=0.75（n=6000）', V({ quickProfile: 'NORMAL', observedStats: statsOf({ vpip: 0.35, pfr: 0.25, threeBet: 0.1, wtsd: 0.3, foldToTurnCBet: 0.75, foldToFlopCBet: 0.5, foldToRiverBet: 0.5 }, 6000) })],
];
line('  【Hero 下注节点 · TURN】variant | conf | 融合维度 | tendenciesZh | sizes[0].foldLikelihood');
for (const [tag, villain] of STAT_VARIANTS) {
  const d = guard(H({ heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_BET_NODE, villain }), tag);
  if (!d.r.ok) continue;
  const pl = (d.dg['player'] ?? {}) as Rec;
  const bd = (d.pf['betDecision'] ?? null) as Rec | null;
  const s0 = bd === null ? null : (bd['sizes'] as Rec[])[0] ?? null;
  kv(`  ${tag}`, '');
  kv('    conf / label / handsObserved', `${n(pl['confidence'], 4)} ｜ ${String(pl['label'])} / ${String(pl['quickProfile'])} ｜ ${String(pl['handsObserved'])}`);
  kv('    adjustment.dimensions', J((pl['adjustment'] as Rec | undefined)?.['dimensions'], 260));
  kv('    tendenciesZh', J(bd?.['tendenciesZh'], 420));
  kv('    sizes[0].foldLikelihood / call / raise', `${n(s0?.['foldLikelihood'], 6)} ｜ ${n(s0?.['callLikelihood'], 6)} ｜ ${n(s0?.['raiseLikelihood'], 6)}`);
  kv('    betEV / deltaVsCheck', `${n(s0?.['betEV'], 4)} ｜ ${n(s0?.['deltaVsCheck'], 4)}`);
}
line('  【Hero 面对下注 · TURN（响应层：他面对我的加注）】');
for (const [tag, villain] of STAT_VARIANTS) {
  const d = guard(H({ heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: [...PRE, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'BET', 10, 'TURN')], villain }), tag);
  if (!d.r.ok) continue;
  const rr = (d.pf['raiseResponse'] ?? null) as Rec | null;
  kv(`  ${tag}`, `fold=${n(rr?.['foldLikelihood'], 6)} call=${n(rr?.['callLikelihood'], 6)} reRaise=${n(rr?.['reRaiseLikelihood'], 6)}`);
}

/* ============================================================
 * §2 M12：用户可见文字里是否把结构式估计说成「求解器验证」
 * ============================================================ */
section('§2 M12 · 用户可见措辞：结构式估计 vs 求解器/GTO');
for (const [tag, input] of [
  ['TURN 面对下注（启发式路径，无 gtoRanges）', H({ heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: [...PRE, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'BET', 10, 'TURN')], villain: MANIAC })],
  ['TURN 下注节点', H({ heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_BET_NODE, villain: MANIAC })],
] as ReadonlyArray<readonly [string, ManualHandInput]>) {
  const d = guard(input, tag);
  if (!d.r.ok) continue;
  const texts: string[] = [
    ...(d.r.warnings as readonly string[]),
    ...((d.decision['reasons'] as readonly Rec[]) ?? []).map((r) => String(r['textZh'])),
    String(d.vm['confidenceZh'] ?? ''), String(d.vm['classificationZh'] ?? ''), String(d.vm['actionZh'] ?? ''),
    ...(((d.vm['debug'] as Rec | undefined)?.['math'] as readonly Rec[] | undefined) ?? []).map((x) => `${String(x['label'])} = ${String(x['value'])}`),
  ];
  kv(tag, '');
  for (const kw of ['求解器', 'GTO', 'solver', 'Solver']) {
    const hits = texts.filter((t) => t.includes(kw));
    kv(`    含「${kw}」的句子`, hits.length === 0 ? '（无）' : `${hits.length} 条`);
    for (const h of hits.slice(0, 4)) line(`      · ${h.slice(0, 300)}`);
  }
  const evRows = (((d.vm['debug'] as Rec | undefined)?.['math'] as readonly Rec[] | undefined) ?? []).filter((x) => String(x['label']).includes('EV') || String(x['label']).includes('权益'));
  kv('    首屏 EV/权益行', J(evRows, 700));
  kv('    confidenceZh / classificationZh', `${String(d.vm['confidenceZh'])} ｜ ${String(d.vm['classificationZh'])}`);
}

/* ============================================================
 * §3 M14：河牌下注范围的类别质量（错失听牌是否计入、是否重复计票）
 * ============================================================ */
section('§3 M13/M14 · 河牌下注范围构成（错失听牌 / 价值 / 摊牌 / 空气）');
for (const [tag, cards, board] of [
  ['河牌对手领打（Hero AA 顶三条）', ['As', 'Ah'], ['Ad', '9c', '4h', '6s', '2d']],
  ['河牌对手领打（Hero AcJc 对 J）', ['Ac', 'Jc'], ['Jd', '8c', '4c', '6s', '2h']],
  ['河牌对手领打（Hero 错失同花 KsQs on 9s4s2c 7d 3h）', ['Ks', 'Qs'], ['9s', '4s', '2c', '7d', '3h']],
] as ReadonlyArray<readonly [string, readonly string[], readonly string[]]>) {
  const d = guard(H({ heroCards: cards, board, street: 'RIVER', actionHistory: RIVER_DONK, villain: MANIAC }), tag);
  if (!d.r.ok) continue;
  const br = (d.pf['bettingRangeFacts'] ?? null) as Rec | null;
  const cm = (br?.['classMasses'] ?? {}) as Rec;
  kv(tag, '');
  kv('    classMasses', J(cm, 620));
  kv('    质量恒等式 value+bluff+showdown', n((cm['valueMass'] ?? 0) + (cm['bluffMass'] ?? 0) + (cm['showdownMass'] ?? 0), 6));
  kv('    错失听牌合计 vs bluffMass', `${n((cm['missedFlushMass'] ?? 0) + (cm['missedStraightMass'] ?? 0) + (cm['missedComboMass'] ?? 0), 6)} vs ${n(cm['bluffMass'], 6)}`);
  kv('    （错失+纯空气）== bluffMass?', String(Math.abs(((cm['missedFlushMass'] ?? 0) + (cm['missedStraightMass'] ?? 0) + (cm['missedComboMass'] ?? 0) + (cm['pureAirMass'] ?? 0)) - (cm['bluffMass'] ?? 0)) < 1e-9));
  const rc = (d.pf['rangeCounts'] ?? {}) as Rec;
  kv('    weaker/stronger/valueBet/bluff候选', `${String(rc['weakerThanHeroCount'])} / ${String(rc['strongerThanHeroCount'])} / ${String(rc['valueBetCandidateCount'])} / ${String(rc['bluffCandidateCount'])}`);
  kv('    valueAssessment.worseHandsCanCall / worseCallDensity / weakerShare', `${String(((d.pf['valueAssessment'] ?? {}) as Rec)['worseHandsCanCall'])} / ${n(((d.pf['valueAssessment'] ?? {}) as Rec)['worseCallDensity'], 4)} / ${n(((d.pf['valueAssessment'] ?? {}) as Rec)['weakerShare'], 4)}`);
  kv('    betRangeArrival 是否捕获', String((d.pf['betRangeArrival'] ?? null) !== null));
}

/* ============================================================
 * §4 M16：公平扫掠（多节点 × 多街 × 多牌型 × 多画像）
 * ============================================================ */
section('§4 M16 · 公平扫掠：一致性/数学检查/EV-动作矛盾的全局统计');
type Node = readonly [string, ManualHandInput];
const faceTurn = (bet: number) => [...PRE, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'BET', bet, 'TURN')];
const faceRiver = (bet: number) => RIVER_DONK.map((x, i, arr) => (i === arr.length - 1 ? A_('BB', 'BET', bet, 'RIVER') : x));
const SWEEP: readonly Node[] = [
  ['FLOP face 6BB · 听花 AcJc', H({ heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c'], street: 'FLOP', actionHistory: [...PRE, A_('BB', 'BET', 6, 'FLOP')], villain: MANIAC })],
  ['FLOP face 6BB · 空气 AsKs', H({ heroCards: ['As', 'Ks'], board: ['Jd', '8c', '4c'], street: 'FLOP', actionHistory: [...PRE, A_('BB', 'BET', 6, 'FLOP')], villain: MANIAC })],
  ['FLOP face 6BB · 底对 4d5d', H({ heroCards: ['4d', '5d'], board: ['Jd', '8c', '4c'], street: 'FLOP', actionHistory: [...PRE, A_('BB', 'BET', 6, 'FLOP')], villain: MANIAC })],
  ['FLOP face 6BB · 三条 JJ', H({ heroCards: ['Jh', 'Jc'], board: ['Jd', '8c', '4c'], street: 'FLOP', actionHistory: [...PRE, A_('BB', 'BET', 6, 'FLOP')], villain: MANIAC })],
  ['TURN face 4BB · 99', H({ heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: faceTurn(4), villain: MANIAC })],
  ['TURN face 10BB · 99', H({ heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: faceTurn(10), villain: MANIAC })],
  ['TURN face 20BB · 99', H({ heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: faceTurn(20), villain: MANIAC })],
  ['TURN face 10BB · 听花 AcJc', H({ heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: faceTurn(10), villain: MANIAC })],
  ['TURN face 10BB · 顺听 T9s', H({ heroCards: ['Ts', '9s'], board: ['Jd', '8c', '7c', '2s'], street: 'TURN', actionHistory: faceTurn(10), villain: MANIAC })],
  ['TURN face 10BB · 干牌 A 高', H({ heroCards: ['Ad', 'Qh'], board: ['Kd', '8s', '3h', '2c'], street: 'TURN', actionHistory: faceTurn(10), villain: MANIAC })],
  ['TURN face 10BB · 坚果顺 QTs on 9d8c2h Js', H({ heroCards: ['Qs', 'Ts'], board: ['9d', '8c', '2h', 'Js'], street: 'TURN', actionHistory: faceTurn(10), villain: MANIAC })],
  ['RIVER face 20BB · AA 顶三条', H({ heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: faceRiver(20), villain: MANIAC })],
  ['RIVER face 20BB · 两对 KQ', H({ heroCards: ['Kd', 'Qc'], board: ['Kh', '8c', '4c', '6s', 'Qd'], street: 'RIVER', actionHistory: faceRiver(20), villain: MANIAC })],
  ['RIVER face 60BB（超池）· AA', H({ heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: faceRiver(60), villain: MANIAC })],
  ['RIVER face 4BB（小注）· AA', H({ heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: faceRiver(4), villain: MANIAC })],
  ['RIVER face 20BB · 错失听花 KsQs', H({ heroCards: ['Ks', 'Qs'], board: ['9s', '4s', '2c', '7d', '3h'], street: 'RIVER', actionHistory: faceRiver(20), villain: MANIAC })],
  ['RIVER face 20BB · 三条 9（同花面）', H({ heroCards: ['9h', '9d'], board: ['9s', 'Ks', '4s', '2s', '7h'], street: 'RIVER', actionHistory: faceRiver(20), villain: MANIAC })],
  ['TURN bet 节点 · AcJc', H({ heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_BET_NODE, villain: MANIAC })],
  ['TURN bet 节点 · 空气 AsKs', H({ heroCards: ['As', 'Ks'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: TURN_BET_NODE, villain: MANIAC })],
  ['FLOP bet 节点 · AcJc', H({ heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c'], street: 'FLOP', actionHistory: [...PRE, A_('BB', 'CHECK', undefined, 'FLOP')], villain: MANIAC })],
  ['TURN face 10BB · 99（NIT 画像）', H({ heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: faceTurn(10), villain: V({ quickProfile: 'VERY_TIGHT' }) })],
  ['TURN face 10BB · 99（跟注站）', H({ heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: faceTurn(10), villain: V({ quickProfile: 'CALLING_STATION' }) })],
  ['TURN face 10BB · 99（无画像）', H({ heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', actionHistory: faceTurn(10), villain: V({ quickProfile: undefined }) })],
  ['PREFLOP CO AA 面对 BB 3bet', H({ heroPosition: 'CO', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'RAISE', 3), A_('BTN', 'FOLD'), A_('SB', 'FOLD'), A_('BB', 'RAISE', 10)], villain: V({}) })],
  ['PREFLOP CO 72o 面对 BB 3bet', H({ heroPosition: 'CO', heroCards: ['7s', '2h'], board: [], street: 'PREFLOP', actionHistory: [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'RAISE', 3), A_('BTN', 'FOLD'), A_('SB', 'FOLD'), A_('BB', 'RAISE', 10)], villain: V({}) })],
];
line('  节点 | action | callEV | 一致 | 数学检查 | 分类 | 候选重复 | 矛盾告警');
let bad = 0; let violations = 0; let sanities = 0; let dups = 0; let calls = 0; let folds = 0;
for (const [tag, input] of SWEEP) {
  const d = guard(input, tag);
  if (!d.r.ok) { bad += 1; continue; }
  const cons = (d.dg['consistency'] ?? {}) as Rec;
  const viol = (cons['violations'] as readonly Rec[] | undefined) ?? [];
  violations += viol.length;
  sanities += d.sanity.length;
  const cands = (d.dg['candidates'] as readonly Rec[]) ?? [];
  const seen = new Set<string>(); let dup = 0;
  for (const c of cands) { const k = `${String(c['action'])}@${String(c['sizeChips'])}`; if (seen.has(k)) dup += 1; seen.add(k); }
  dups += dup;
  const action = String(d.decision['action']);
  if (action === 'CALL') calls += 1;
  if (action === 'FOLD') folds += 1;
  const callEV = d.math['callEV'] as number | null;
  const conflict = (action === 'FOLD' && callEV !== null && callEV > 0) || (action === 'CALL' && callEV !== null && callEV < 0);
  line(
    `  ${tag.padEnd(44)}| ${`${action} ${String(d.decision['sizeChips'] ?? '')}`.padEnd(12)}| ${n(callEV, 4).padStart(10)} | ` +
    `${String(viol.length === 0 ? 'ok' : viol.map((v) => String(v['code'])).join(',')).padEnd(18)}| ${String(d.sanity.length === 0 ? 'ok' : 'PROBLEM').padEnd(8)} | ` +
    `${String(d.decision['classification']).padEnd(9)} | ${String(dup).padEnd(5)} | ${conflict ? '⚠️ EV 与动作矛盾' : '—'}`,
  );
  if (conflict) for (const r of (d.decision['reasons'] as readonly Rec[]) ?? []) { if (String(r['code']).includes('CONTRADICT')) line(`        · ${String(r['code'])}: ${String(r['textZh']).slice(0, 200)}`); }
}
kv('扫掠合计', `节点 ${SWEEP.length}｜失败 ${bad}｜consistency 违规 ${violations}｜数学检查问题 ${sanities}｜候选重复 ${dups}｜CALL ${calls}｜FOLD ${folds}`);
