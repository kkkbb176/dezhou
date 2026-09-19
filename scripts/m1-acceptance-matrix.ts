/**
 * M1 · §八 验收矩阵（只读）：A–F + 两个**对照**，用来区分三种「没变化」
 *
 *  ① 已进入模型但数值未变化（标签通道是对照：改标签 → 数字必须动）
 *  ② 因牌局条件 / 牌力阻断导致不敏感（顶暗三条 ⇒ 条件权益天花板）
 *  ③ 统计根本没有进入模型（四项实测：刻度与数字都逐位相同）
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { parseManualInput, type ManualHandInput, type ManualVillain } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A_ = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }),
});
function test16(villain: ManualVillain): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
      A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
      A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP'),
      A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN'),
      A_('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES', villain,
  } as unknown as ManualHandInput;
}

const S = {
  handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
  foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
} as const;

const ID = { seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', dynamicHint: 'UNKNOWN', stackBB: 100 } as const;
const V = (extra: Record<string, unknown>): ManualVillain => ({ ...ID, quickProfile: 'MANIAC', ...extra } as ManualVillain);

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const pad = (s: string, w: number): string => {
  const len = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, w - len));
};

function measure(input: ManualHandInput): Record<string, any> {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) return { failed: `${r.stage}` };
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  const pf = (dg['postflop'] ?? {}) as Record<string, any>;
  const rr = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
  const br = (pf['bettingRangeFacts'] ?? null) as Record<string, any> | null;
  const arr = (pf['betRangeArrival'] ?? null) as Record<string, any> | null;
  const note = String(rr?.['model']?.['noteZh'] ?? '');
  const grab = (k: string): number => Number(new RegExp(`${k}\\s+([0-9.]+)`).exec(note)?.[1] ?? NaN);
  const p = parseManualInput(input);
  const g = p.ok ? buildAnalyzableState(p.value) : null;
  const ctx = g !== null && g.ok ? (buildDecisionContext({
    state: g.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
    ...(p.ok && p.value.villain.quickProfile !== undefined ? { quickProfile: p.value.villain.quickProfile } : {}),
    ...(p.ok && p.value.villain.dynamicHint !== undefined ? { dynamicHint: p.value.villain.dynamicHint } : {}),
    villainSeatId: 'seat_BB', villainPersistentPlayerId: 'player_001',
    ...(p.ok && p.value.villain.observedStats !== undefined && p.value.villain.observedStats !== null
      ? { observedStats: p.value.villain.observedStats } : {}),
    equitySeed: OPTIONS.equitySeed, budget: OPTIONS.budget,
  } as never).context as unknown as Record<string, any>) : null;
  const v3 = (ctx?.['profileV3'] ?? null) as Record<string, any> | null;
  return {
    dims: v3?.['resolvedDimensions'] ?? null,
    w: v3?.['blendWeight'] ?? null,
    scales: { call: grab('callScale'), fold: grab('foldScale'), raise: grab('raiseScale') },
    arrival: `${String(arr?.['supportCount'])}组 Eq ${n(arr?.['heroEquityVsArrivalRange'], 6)}`,
    bet: `${String(br?.['entryCount'])}组 质量 ${n(br?.['betMass'], 6)}`,
    eqVsBet: dg['math']?.['heroEquityVsBetRange'] ?? null,
    eqVsRaiseCall: rr?.['heroEquityVsRaiseCallRange'] ?? null,
    eqVsReraise: rr?.['heroEquityVsReraiseRange'] ?? null,
    probs: `${n(rr?.['foldLikelihood'], 4)}/${n(rr?.['callLikelihood'], 4)}/${n(rr?.['reRaiseLikelihood'], 4)}`,
    callEV: dg['math']?.['callEV'] ?? null,
    raiseEV: rr?.['raiseEV'] ?? null,
    action: `${String(d['action'])}${d['sizeChips'] === undefined ? '' : ` @ ${String(d['sizeChips'])}`}`,
  };
}

const CASES: [string, string, ManualVillain][] = [
  ['A', 'MANIAC 标签 · 无实测', V({})],
  ['B', 'MANIAC 标签 · 800 手四项', V({ observedStats: S })],
  ['C', '仅 VPIP 0.20', V({ observedStats: { ...S, vpip: 0.2 } })],
  ['C2', '仅 VPIP 0.62', V({ observedStats: { ...S, vpip: 0.62 } })],
  ['D', '仅 PFR 0.05', V({ observedStats: { ...S, pfr: 0.05 } })],
  ['D2', '仅 PFR 0.48', V({ observedStats: { ...S, pfr: 0.48 } })],
  ['E', '仅 3Bet 0.02', V({ observedStats: { ...S, threeBet: 0.02 } })],
  ['E2', '仅 3Bet 0.30', V({ observedStats: { ...S, threeBet: 0.3 } })],
  ['F', '仅 WTSD 0.15', V({ observedStats: { ...S, wtsd: 0.15 } })],
  ['F2', '仅 WTSD 0.60', V({ observedStats: { ...S, wtsd: 0.6 } })],
  /* 对照 1：改**标签**（同一通道有没有灵敏度） */
  ['X1', '对照·标签改 VERY_TIGHT（无统计）', { ...ID, quickProfile: 'VERY_TIGHT' } as ManualVillain],
  /* 对照 2：分街统计（已产生但本节点无消费方） */
  ['X2', '对照·riverCheckRaise 0.20', V({ observedStats: { ...S, riverCheckRaise: 0.2 } })],
  /* 对照 3：极端样本（0.9 / 5000 手）—— 仍应与 B 相同 */
  ['X3', '对照·VPIP 0.90 · 5000 手', V({ observedStats: { ...S, handsObserved: 5000, vpip: 0.9 } })],
];

line('='.repeat(200));
line(' §八 验收矩阵：A–F + 三个对照（TEST 16 原牌局；全部数据取自生产输出）');
line('='.repeat(200));
line('  ' + pad('组', 5) + pad('配置', 30) + pad('resolvedDimensions（融合后）', 42) + pad('响应刻度 跟/弃/加', 22) +
  pad('到达范围', 22) + pad('下注范围', 22) + pad('EqVsBetRange', 14) + pad('EqVsRaiseCall', 14) + pad('EqVsReraise', 13) +
  pad('P(弃/跟/再加)', 24) + pad('CALL EV', 10) + pad('RAISE EV', 10) + 'Final Action');
const rows: Record<string, Record<string, any>> = {};
for (const [tag, label, villain] of CASES) {
  const m = measure(test16(villain));
  rows[tag] = m;
  const d = m['dims'] as Record<string, number> | null;
  line('  ' + pad(tag, 5) + pad(label, 30) +
    pad(d === null ? '—' : `紧${n(d['tightness'], 3)} 凶${n(d['aggression'], 3)} 诈${n(d['bluffTendency'], 3)} 被${n(d['passivity'], 3)}`, 42) +
    pad(`${n(m['scales']?.['call'], 4)}/${n(m['scales']?.['fold'], 4)}/${n(m['scales']?.['raise'], 4)}`, 22) +
    pad(String(m['arrival']), 22) + pad(String(m['bet']), 22) + pad(n(m['eqVsBet'], 9), 14) +
    pad(n(m['eqVsRaiseCall'], 9), 14) + pad(n(m['eqVsReraise'], 9), 13) + pad(String(m['probs']), 24) +
    pad(n(m['callEV'], 4), 10) + pad(n(m['raiseEV'], 4), 10) + String(m['action']));
}

line('');
line('  ── 三类「没有变化」的判定 ──');
const FIELDS: [string, string][] = [
  ['响应刻度 跟/弃/加', 'scales'], ['到达范围', 'arrival'], ['下注范围', 'bet'],
  ['EqVsBetRange', 'eqVsBet'], ['EqVsRaiseCallRange', 'eqVsRaiseCall'], ['EqVsReraiseRange', 'eqVsReraise'],
  ['P(弃/跟/再加)', 'probs'], ['CALL EV', 'callEV'], ['RAISE EV', 'raiseEV'], ['Final Action', 'action'],
];
line('  ' + pad('字段', 24) + pad('B 的值', 26) + pad('C–F 有没有变（统计）', 24) + pad('X1 有没有变（换标签）', 24) + 'X2/X3 有没有变');
for (const [label, key] of FIELDS) {
  const b = rows['B']!;
  const stats = ['C', 'C2', 'D', 'D2', 'E', 'E2', 'F', 'F2'];
  const changedStats = stats.filter((t) => JSON.stringify(rows[t]![key]) !== JSON.stringify(b[key]));
  const x1 = JSON.stringify(rows['X1']![key]) !== JSON.stringify(b[key]);
  const x2 = JSON.stringify(rows['X2']![key]) !== JSON.stringify(b[key]);
  const x3 = JSON.stringify(rows['X3']![key]) !== JSON.stringify(b[key]);
  line('  ' + pad(label, 24) + pad(JSON.stringify(b[key])?.slice(0, 24) ?? 'null', 26) +
    pad(changedStats.length === 0 ? '0 / 8（没变）' : `${changedStats.length} / 8：${changedStats.join('、')}`, 24) +
    pad(x1 ? '**变了（通道有灵敏度）**' : '没变', 24) +
    `${x2 ? 'X2 变了' : 'X2 没变'} / ${x3 ? 'X3 变了' : 'X3 没变'}`);
}
line('');
line(' ① **统计根本没有进入模型**：C–F 八组与 B 逐位相同（连响应刻度 callScale/foldScale/raiseScale 都相同）');
line('    ⇒ 不是「进入后不敏感」，而是**来源没有接进去**。');
line(' ② **已进入模型但数值未变化**：X2（riverCheckRaise）—— 分街因子被正确算出（RIVER.checkRaiseScale ≠ 1），');
line('    但面对下注的三条链不消费它 ⇒ 数字不变。这是「已产生、本节点无消费方」。');
line(' ③ **因牌局条件 / 牌力阻断导致不敏感**：X1（把标签从 MANIAC 换成 VERY_TIGHT）**改变了**响应刻度与 EV，');
line('    证明三条链本身是活的；而本局 Hero 持顶暗三条，`EqVsRaiseCallRange ≈ 0.9994` 已接近天花板 ——');
line('    任何响应范围的变化都只能在这个天花板上产生极小位移，因此**后续修复的可见幅度会受牌力阻断限制**。');
line('='.repeat(200));
