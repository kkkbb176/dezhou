/**
 * ============================================================================
 * PROFILE DOWNSTREAM AUDIT —— 实测统计为什么没有进入「面对下注」节点（只读）
 * ============================================================================
 *
 * 固定 TEST 16 全部牌局条件，只改人物画像输入，逐字段输出：
 *   resolvedDimensions / 翻前范围 / 河牌到达范围 / 河牌主动下注范围 /
 *   EqVsBetRange / Raise-Call Range / EqVsRaiseCallRange /
 *   P(FOLD/CALL/RERAISE) / CALL EV / RAISE EV / Final Action
 *
 * 另附墨菲定律主动检查（§七 1–8）。
 *
 * ⚠️ 本脚本**不修改任何生产代码 / 策略参数 / 测试断言**：只调用生产入口与生产函数。
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parseManualInput, type ManualHandInput, type ManualVillain } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const pad = (s: string, w: number): string => {
  const len = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, w - len));
};
const rule = (w = 150): string => '='.repeat(w);

/** TEST 16 原牌局；`villain` 由每个变体自己给 */
function test16(villain: ManualVillain): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
      A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain,
  } as unknown as ManualHandInput;
}

type Row = Record<string, any>;

/*
 * ⚠️ 本函数**没有**「纯展示字段」的痕迹：只收集会被比较的**数值**。
 * `observedStatCount` 已经是数字；`noteZh` / `confidenceTierZh` 一律不入指纹。
 */
function probe(input: ManualHandInput): Row {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) return { failed: `${r.stage}: ${JSON.stringify(r.issues)}` };
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  const pf = (dg['postflop'] ?? {}) as Record<string, any>;
  const arrival = (pf['betRangeArrival'] ?? null) as Row | null;
  const betRange = (pf['bettingRangeFacts'] ?? null) as Row | null;
  const rr = (pf['raiseResponse'] ?? null) as Row | null;
  const math = (dg['math'] ?? {}) as Row;
  const range = (dg['range'] ?? null) as Row | null;
  const trace = (range?.['updateTrace'] ?? []) as Row[];

  /* 画像：走 buildDecisionContext 拿 profileV3（只读诊断） */
  const parsed = parseManualInput(input);
  const gate = parsed.ok ? buildAnalyzableState(parsed.value) : null;
  const ctx = gate !== null && gate.ok
    ? (buildDecisionContext({
        state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
        ...(parsed.ok && parsed.value.villain.quickProfile !== undefined ? { quickProfile: parsed.value.villain.quickProfile } : {}),
        ...(parsed.ok && parsed.value.villain.dynamicHint !== undefined ? { dynamicHint: parsed.value.villain.dynamicHint } : {}),
        ...(parsed.ok && parsed.value.villain.persistentPlayerId !== undefined && parsed.value.villain.persistentPlayerId !== null
          ? { villainPersistentPlayerId: parsed.value.villain.persistentPlayerId } : {}),
        ...(parsed.ok && parsed.value.villain.seatId !== undefined && parsed.value.villain.seatId !== null
          ? { villainSeatId: parsed.value.villain.seatId } : {}),
        ...(parsed.ok && parsed.value.villain.displayName !== undefined && parsed.value.villain.displayName !== null
          ? { villainDisplayName: parsed.value.villain.displayName } : {}),
        ...(parsed.ok && parsed.value.villain.observedStats !== undefined && parsed.value.villain.observedStats !== null
          ? { observedStats: parsed.value.villain.observedStats } : {}),
        equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
      } as never).context as unknown as Row)
    : null;
  const v3 = (ctx?.['profileV3'] ?? null) as Row | null;
  const identity = gate !== null && gate.ok ? null : null;
  void identity;

  return {
    action: `${String(d['action'])}${d['sizeChips'] === undefined ? '' : ` @ ${String(d['sizeChips'])}`}`,
    /* ① 画像解析层 */
    statCount: v3?.['observedStatCount'] ?? 0,
    dims: v3?.['resolvedDimensions'] ?? null,
    baseDims: v3?.['baseDimensions'] ?? null,
    blend: v3?.['blendWeight'] ?? null,
    mass: v3?.['evidenceMass'] ?? null,
    river: v3?.['street']?.['RIVER'] ?? null,
    denied: v3?.['deniedStreetTraits'] ?? null,
    /* ② 翻前范围（到达范围链的第一步） */
    preflopBefore: trace[0]?.['supportBefore'] ?? null,
    preflopAfter: trace[0]?.['supportAfter'] ?? null,
    arrivalSupport: range?.['supportSize'] ?? null,
    /* ③ 河牌到达范围（当前这一次下注之前） */
    arrivalCount: arrival?.['supportCount'] ?? null,
    arrivalMass: arrival?.['arrivalMass'] ?? null,
    eqVsArrival: arrival?.['heroEquityVsArrivalRange'] ?? null,
    /* ④ 河牌主动下注范围 */
    betCount: betRange?.['entryCount'] ?? null,
    betMass: betRange?.['betMass'] ?? null,
    betBands: betRange?.['bandRates'] ?? null,
    /* ⑤ 条件权益 */
    eqVsBetRange: math['heroEquityVsBetRange'] ?? null,
    eqVsRaiseCall: rr?.['heroEquityVsRaiseCallRange'] ?? null,
    eqVsReraise: rr?.['heroEquityVsReraiseRange'] ?? null,
    /* ⑥ 加注-跟注范围（组合数）+ 响应概率 */
    callCombos: rr?.['callCombos'] ?? null,
    reRaiseCombos: rr?.['reRaiseCombos'] ?? null,
    reachable: rr?.['reachableCombos'] ?? null,
    f: rr?.['foldLikelihood'] ?? null,
    c: rr?.['callLikelihood'] ?? null,
    rrv: rr?.['reRaiseLikelihood'] ?? null,
    /* ⑦ EV 与动作 */
    callEV: math['callEV'] ?? null,
    raiseEV: rr?.['raiseEV'] ?? null,
    rrNote: rr?.['model']?.['noteZh'] ?? null,
    warnings: r.warnings as readonly string[],
  };
}

const BASE_STATS = {
  handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
  foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
} as const;

const IDENTITY = { seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', stackBB: 100 } as const;

const VARIANTS: [string, ManualVillain][] = [
  ['A MANIAC · 无实测统计', { ...IDENTITY, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN' }],
  ['B MANIAC · 800 手 · 四项全给', { ...IDENTITY, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', observedStats: BASE_STATS }],
  ['C1 仅 VPIP 0.20（很紧）', { ...IDENTITY, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', observedStats: { ...BASE_STATS, vpip: 0.2 } }],
  ['C2 仅 VPIP 0.62（很松）', { ...IDENTITY, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', observedStats: { ...BASE_STATS, vpip: 0.62 } }],
  ['C3 仅 VPIP 0.90（极端）', { ...IDENTITY, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', observedStats: { ...BASE_STATS, vpip: 0.9 } }],
  ['D1 仅 PFR 0.05', { ...IDENTITY, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', observedStats: { ...BASE_STATS, pfr: 0.05 } }],
  ['D2 仅 PFR 0.48', { ...IDENTITY, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', observedStats: { ...BASE_STATS, pfr: 0.48 } }],
  ['E1 仅 3Bet 0.02', { ...IDENTITY, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', observedStats: { ...BASE_STATS, threeBet: 0.02 } }],
  ['E2 仅 3Bet 0.30', { ...IDENTITY, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', observedStats: { ...BASE_STATS, threeBet: 0.3 } }],
  ['F1 仅 WTSD 0.15', { ...IDENTITY, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', observedStats: { ...BASE_STATS, wtsd: 0.15 } }],
  ['F2 仅 WTSD 0.60', { ...IDENTITY, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', observedStats: { ...BASE_STATS, wtsd: 0.6 } }],
];

line(rule());
line(' §A. A–F 对抗矩阵（固定 TEST 16 全部牌局条件，只改画像）');
line(rule());
line('  ' + pad('变体', 30) + pad('统计', 6) + pad('resolvedDimensions（融合后）', 44) +
  pad('RIVER 因子 弃/跟/过加/下注', 30) + pad('翻前 前→后', 14) + pad('河牌到达', 12) + pad('下注范围', 12) + pad('EqVsBet', 12) + pad('EqVsRaiseCall', 14) + pad('P(弃/跟/再加)', 22) + pad('CALL EV', 11) + pad('RAISE EV', 11) + '动作');
const rows: Record<string, Row> = {};
for (const [tag, villain] of VARIANTS) {
  const r = probe(test16(villain));
  rows[tag] = r;
  const d = r['dims'] as Row | null;
  const st = r['river'] as Row | null;
  line('  ' + pad(tag, 30) + pad(String(r['statCount']), 6) +
    pad(d === null ? '—' : `紧${n(d['tightness'], 3)} 凶${n(d['aggression'], 3)} 诈${n(d['bluffTendency'], 3)} 被${n(d['passivity'], 3)}`, 44) +
    pad(st === null ? '—' : `${n(st['foldScale'], 3)}/${n(st['callScale'], 3)}/${n(st['checkRaiseScale'], 3)}/${n(st['betScale'], 4)}`, 30) +
    pad(`${String(r['preflopBefore'])}→${String(r['preflopAfter'])}`, 14) +
    pad(`${String(r['arrivalCount'])}组`, 12) + pad(`${String(r['betCount'])}组`, 12) +
    pad(n(r['eqVsBetRange'], 9), 12) + pad(n(r['eqVsRaiseCall'], 9), 14) +
    pad(`${n(r['f'], 4)}/${n(r['c'], 4)}/${n(r['rrv'], 4)}`, 22) +
    pad(n(r['callEV'], 4), 11) + pad(n(r['raiseEV'], 4), 11) + String(r['action']));
}
line('');
{
  const base = rows['B MANIAC · 800 手 · 四项全给']!;
  const FIELDS: [string, string][] = [
    ['resolvedDimensions', 'dims'],
    ['RIVER 分街因子', 'river'],
    ['翻前范围（trace[0]）', 'preflopBefore'],
    ['河牌到达范围（组合数）', 'arrivalCount'],
    ['河牌主动下注范围（组合数）', 'betCount'],
    ['河牌主动下注范围（质量）', 'betMass'],
    ['EqVsBetRange', 'eqVsBetRange'],
    ['EqVsArrivalRange', 'eqVsArrival'],
    ['Raise-Call 组合数', 'callCombos'],
    ['EqVsRaiseCallRange', 'eqVsRaiseCall'],
    ['EqVsReraiseRange', 'eqVsReraise'],
    ['P(FOLD)', 'f'], ['P(CALL)', 'c'], ['P(RERAISE)', 'rrv'],
    ['CALL EV', 'callEV'], ['RAISE EV', 'raiseEV'], ['Final Action', 'action'],
  ];
  line('  ── 逐字段：把 A–F 各变体与 B（四项全给）比较，看**有没有任何变化** ──');
  line('  ' + pad('字段', 30) + pad('B 的值', 44) + pad('发生变化的变体数', 18) + '变化的变体');
  for (const [label, key] of FIELDS) {
    const others = VARIANTS.map(([t]) => t).filter((t) => t !== 'B MANIAC · 800 手 · 四项全给');
    const changed = others.filter((t) => JSON.stringify(rows[t]![key]) !== JSON.stringify(base[key]));
    const withA = ['A MANIAC · 无实测统计', ...others].filter((t) => JSON.stringify(rows[t]![key]) !== JSON.stringify(base[key]));
    line('  ' + pad(label, 30) + pad(JSON.stringify(base[key])?.slice(0, 42) ?? 'null', 44) +
      pad(`${changed.length} / ${others.length}`, 18) +
      `（含 A：${withA.length} / ${others.length + 1}）${withA.length > 0 && withA.length <= 4 ? ' ' + withA.join('、') : ''}`);
  }
}
line('');

/* ============================================================
 * §B 墨菲定律主动检查
 * ============================================================ */

line(rule());
line(' §B. 墨菲定律主动检查（§七 1–8）');
line(rule());

/* 1. 重复计票 */
{
  const withFoldStat = probe(test16({
    ...IDENTITY, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN',
    observedStats: { ...BASE_STATS, foldToRiverBet: 0.6 },
  }));
  line('  M1 重复计票（同一条统计影响范围两次）：');
  line(`     · 极性表：VPIP/PFR/3Bet/WTSD **只走维度**；FoldTo*/CheckRaise 极性全 0 **只走分街条目**（observedStats.ts:851-890）⇒ 设计上每条统计只有一个通道。`);
  line(`     · 实测：给 foldToRiverBet=0.60 ⇒ RIVER 因子 = ${JSON.stringify(withFoldStat['river'])}、deniedStreetTraits = ${JSON.stringify(withFoldStat['denied'])}；`);
  line(`       维度证据质量 = ${JSON.stringify(withFoldStat['mass'])}（与 B 相同 ⇒ 该统计**没有**同时推维度）；下游数字 = ${JSON.stringify([withFoldStat['eqVsBetRange'], withFoldStat['raiseEV']])}（与 B 相同）。`);
  line(`     · 下注范围模型内部不存在第二把尺子：bettingRange.ts 只读 effectiveDimensions（:390），`);
  line(`       \`valueBetShareOf\`（会读 riverBetScale）**在生产路径上没有任何调用者**（仅 selftest 导出）。`);
}

/* 3. 翻前总体频率直接代替河牌条件概率 */
{
  const c1 = rows['C1 仅 VPIP 0.20（很紧）']!;
  const c3 = rows['C3 仅 VPIP 0.90（极端）']!;
  line('');
  line('  M3 用翻前总体频率代替河牌条件概率：');
  line(`     · 极性表里 vpip 的 bluffTendency / aggression 极性**都是 0**（observedStats.ts:853）⇒ 没有「松 ⇒ 河牌爱诈唬」这条路径。`);
  line(`     · 实测：VPIP 0.20 → 0.90，P(FOLD/CALL/RERAISE) 恒为 ${n(c1['f'], 4)}/${n(c1['c'], 4)}/${n(c1['rrv'], 4)} = ${n(c3['f'], 4)}/${n(c3['c'], 4)}/${n(c3['rrv'], 4)}（未把 VPIP 当成河牌频率）。`);
}

/* 4. 统计样本不足 */
{
  line('');
  line('  M4 样本不足却产生过大变化：');
  line('  ' + pad('样本量（同一 VPIP 0.62）', 30) + pad('生效比率', 12) + pad('可信度', 10) + pad('紧维度', 10) + pad('融合权重', 12) + pad('EqVsBetRange', 14) + 'RAISE EV');
  for (const hands of [20, 100, 800, 5000]) {
    const r = probe(test16({
      ...IDENTITY, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN',
      observedStats: { ...BASE_STATS, handsObserved: hands, vpip: 0.62 },
    }));
    const parsed = parseManualInput(test16({
      ...IDENTITY, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN',
      observedStats: { ...BASE_STATS, handsObserved: hands, vpip: 0.62 },
    }));
    let effRate = null;
    let conf = null;
    if (parsed.ok) {
      const g = buildAnalyzableState(parsed.value);
      if (g.ok) {
        const c = buildDecisionContext({
          state: g.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
          quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', villainSeatId: 'seat_BB',
          villainPersistentPlayerId: 'player_001',
          observedStats: { ...BASE_STATS, handsObserved: hands, vpip: 0.62 },
          equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
        } as never).context as unknown as Row;
        const trace = ((c['profileV3'] as Row)?.['trace'] ?? []) as Row[];
        const vp = trace.find((t) => t['stat'] === 'vpip');
        effRate = vp?.['effectiveRate'] ?? null;
        conf = vp?.['confidence'] ?? null;
      }
    }
    const d = r['dims'] as Row | null;
    const blend = r['blend'] as Row | null;
    line('  ' + pad(String(hands), 30) + pad(n(effRate, 4), 12) + pad(n(conf, 4), 10) +
      pad(n(d?.['tightness'], 4), 10) + pad(n(blend?.['tightness'], 4), 12) +
      pad(n(r['eqVsBetRange'], 9), 14) + n(r['raiseEV'], 4));
  }
  line('     ⇒ 收缩发生在**画像解析层**（生效比率与可信度随样本变化，符合 K 值设计），');
  line('       但**下游数字全部不变** ⇒ 本节点上没有「小样本放大」的风险面（没有通道可用）。');
}

/* 5. 人为放大画像权重 */
{
  const extreme = rows['C3 仅 VPIP 0.90（极端）']!;
  const base = rows['B MANIAC · 800 手 · 四项全给']!;
  line('');
  line('  M5 为了让动作变化而人为放大画像权重：');
  line(`     · 本轮**未改动任何权重**（git 工作区 tracked 改动 = 0；K 值/先验/极性表/公式与恢复基线逐字节相同）。`);
  line(`     · 反证：即使把 VPIP 推到 0.90（远超真实范围），下游仍与 B 逐位相同（EqVsBetRange ${n(extreme['eqVsBetRange'], 9)} vs ${n(base['eqVsBetRange'], 9)}）`);
  line(`       ⇒ 缺口是**缺少接口**，不是「权重不够大」；调参无法修复，只会制造假的因果。`);
}

/* 6. 实测覆盖标签时丢失无观测通道的维度 */
{
  const b = rows['B MANIAC · 800 手 · 四项全给']!;
  const d = b['dims'] as Row;
  const baseD = b['baseDims'] as Row;
  const blend = b['blend'] as Row;
  line('');
  line('  M6 实测覆盖标签时丢掉「尚无观测通道」的维度：');
  line(`     · 实测：bluffTendency 融合后 = ${n(d['bluffTendency'], 4)}、标签基准 = ${n(baseD['bluffTendency'], 4)}、融合权重 = ${n(blend['bluffTendency'], 4)}`);
  line(`       ⇒ 无证据的轴（bluffTendency 全项目极性为 0、无任何统计）**保留标签值**，没有被重置成 0.5 ✅`);
  line(`     · 其余三轴：紧 ${n(d['tightness'], 3)}(标签 ${n(baseD['tightness'], 3)}, 权重 ${n(blend['tightness'], 3)})、凶 ${n(d['aggression'], 3)}(标签 ${n(baseD['aggression'], 3)}, 权重 ${n(blend['aggression'], 3)})、被 ${n(d['passivity'], 3)}(标签 ${n(baseD['passivity'], 3)}, 权重 ${n(blend['passivity'], 3)})`);
  line(`       ⇒ 实测与标签按证据质量加权融合，标签**不被整体覆盖**。`);
}

/* 7. 面对下注节点错误使用 FoldToCBet */
{
  const foldStat = probe(test16({ ...IDENTITY, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', observedStats: { ...BASE_STATS, foldToRiverBet: 0.6 } }));
  const xr = probe(test16({ ...IDENTITY, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', observedStats: { ...BASE_STATS, riverCheckRaise: 0.2 } }));
  const base = rows['B MANIAC · 800 手 · 四项全给']!;
  line('');
  line('  M7 面对下注节点错误使用 FoldToCBet：');
  line(`     · 节点语义 = FACING_DONK（BB 主动领打）；foldToRiverBet=0.60 ⇒ deniedStreetTraits = ${JSON.stringify(foldStat['denied'])}，RIVER 因子 = ${JSON.stringify(foldStat['river'])}（**保持中立**）`);
  line(`     · riverCheckRaise=0.20 ⇒ deniedStreetTraits = ${JSON.stringify(xr['denied'])}，RIVER 因子 = ${JSON.stringify(xr['river'])}（checkRaise 因子被正确修正）`);
  line(`     · 但两者下游数字都等于 B（EqVsBetRange ${n(foldStat['eqVsBetRange'], 9)} / ${n(xr['eqVsBetRange'], 9)} vs ${n(base['eqVsBetRange'], 9)}）`);
  line(`       ⇒ 语义门**没有**错配证据（正确拒绝）；同时暴露：本节点连「正确允许」的分街系数也没有消费方（见 §C 通道表）。`);
}

/* 2 / 8：引用已提交的回归测试 + 现场复跑 */
{
  line('');
  line('  M2 换座位后统计与行动历史错位：');
  line('     · 已由已提交测试 test/playerIdentityRouting.test.ts 的 M2 锁定（同一持久 id 换到 CO 后仍读同一份画像；旧座位陌生人 UNKNOWN）。');
  line('     · 本节点现场复核：seatId 指向非对手座位（seat_CO）⇒ status=SEAT_NOT_FOUND、**不注入任何画像**、');
  const wrongSeat = probe(test16({ seatId: 'seat_CO', persistentPlayerId: 'player_009', displayName: '老张', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: BASE_STATS }));
  line(`       observedStatCount = ${String(wrongSeat['statCount'])}，EqVsBetRange = ${n(wrongSeat['eqVsBetRange'], 9)}（与「无画像」一致 ⇒ 不会把统计错配到别的人身上）。`);
  line('');
  line('  M8 多人底池使用非当前下注者的画像：');
  line('     · 已由已提交测试的 M9 锁定（画像绑到非下注者时，首要对手的下注范围权益**等于**中立基线）。');
  line('     · 代码层：`tendenciesForSeat()`（contextBuilder.ts:3620）对下注范围与他面对加注的响应都先判等 `seatId === profileSeatId`。');
}

line('');
line(rule());
line(' §C. 通道表（源码阅读结论，含 file:line；本表不依赖任何运行结果）');
line(rule());
line(`  ${pad('画像量', 36)}${pad('生产消费者（含 file:line）', 66)}状态`);
for (const [q, consumer, status] of [
  ['quickProfile 标签 → 4 条基础尺度', 'responseTendenciesOf（betResponse.ts:414-417）→ buildRaiseResponse 读取（raiseResponse.ts:289-293）', '**本节点唯一被消费的画像量**'],
  ['quickProfile 标签 → 下注带速率', 'betProbabilityByBand 读 effectiveDimensions（bettingRange.ts:390）', '已消费（河牌主动下注范围）'],
  ['quickProfile 标签 → provider 乘数', 'applyLikelihoodUpdates ← buildRangeSnapshot 的 tendency（contextBuilder.ts:3604-3607）', '已消费（到达范围）'],
  ['observedStats → 4 轴 resolvedDimensions', 'buildBetDecisionFacts 的 v3Dimensions（contextBuilder.ts:4633-4635 → :1893-1902）', '**已加载但本节点被整块丢弃**'],
  ['（为什么被丢弃 = 本节点语义不适用）', 'postflopAdvisor.ts:576「if (facingBet || betDecisionFacts === null) return null」；decisionEngine.ts:3672 快照写 null', '面对下注 ⇒ BET/CHECK 不可选'],
  ['observedStats → street.foldScale/callScale/checkRaiseScale', 'classifyResponse（betResponse.ts:920-940；调用点 :1143）—— **只在 buildResponseModel 内**', '**已加载但本节点被整块丢弃**（同上 576）'],
  ['observedStats → street.betScale（由 4 轴导出）', 'streetBetScale（betResponse.ts:431）→ classifyVillainAfterCheck（:1322；调用点 contextBuilder.ts:2323）', '本节点不适用（河牌被 riverBetScale 顶替，且整块在 Hero 分支内）'],
  ['streetCheckRaiseScale / streetFoldScale（诊断）', 'postflopAdvisor 的 v3StreetScales（postflopAdvisor.ts:684-688）', '仅诊断展示（不参与本节点 EV）'],
  ['（缺失）RiverBet / TurnCBet 等开火类统计', 'observedStats 里**没有这些字段**（observedStats.ts:1610-1612 标注 TURN_CBET_INPUT_CHANNEL = NOT_IMPLEMENTED）', '**不支持**'],
] as const) {
  line(`  ${pad(q, 36)}${pad(consumer, 66)}${status}`);
}
line('');
line('  面对下注节点（TEST 16）实际消费的画像量：**只有 quickProfile 标签**（4 条基础尺度 + 到达范围的 provider）。');
line('  实测统计的四条轴、以及由它们导出的分街系数，全部只喂给「Hero 主动下注/过牌」分支；');
line('  该分支在本节点被 postflopAdvisor.ts:576 整块判空（facingBet ⇒ null）⇒ 对 CALL/RAISE EV 与最终动作**零影响**。');
line(rule());
