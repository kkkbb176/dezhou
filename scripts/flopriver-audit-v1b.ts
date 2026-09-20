/**
 * FLOP & RIVER AUDIT V1 · 焦点探针（**只读**）：把关键字段**完整**打印，不做截断。
 * 覆盖：合法动作 / 决策依据 / 基线与调整后决策 / 下注与加注响应模型 / 证据表 / 候选。
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
const FLOP_CB_CALL = [A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP')];
const TURN_CB_CALL = [A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN')];
const EQ = (h: [string, string], b: string[], s: string, hist: Record<string, unknown>[], position = 'BTN'): ManualHandInput =>
  ({ tableSize: 6, heroPosition: position, heroCards: h, board: b, street: s, effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: S100, actionHistory: hist, environment: 'MID_LOW_STAKES' }) as unknown as ManualHandInput;
const OPP = (profile: string): ManualVillain => ({ quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 }) as ManualVillain;

const NODES: ReadonlyArray<readonly [string, ManualHandInput]> = [
  ['F-01 顶对·对手领打', EQ(['As', 'Ks'], ['Kd', '9c', '4h'], 'FLOP', [...PF, A_('BB', 'BET', 4, 'FLOP')])],
  ['F-02 暗三条·对手过牌', EQ(['9h', '9c'], ['9d', 'Kc', '4c'], 'FLOP', [...PF, A_('BB', 'CHECK', undefined, 'FLOP')])],
  ['F-05 纯空气·对手过牌', EQ(['7s', '2d'], ['Kd', '9c', '4h'], 'FLOP', [...PF, A_('BB', 'CHECK', undefined, 'FLOP')])],
  ['R-01 顶对·对手过牌', EQ(['As', 'Ks'], ['Kd', '9c', '4h', '6s', '2d'], 'RIVER', [...PF, ...FLOP_CB_CALL, ...TURN_CB_CALL, A_('BB', 'CHECK', undefined, 'RIVER')])],
  ['R-03 中对·对手下注（P1 节点）', EQ(['9h', '9c'], ['Jd', '8c', '4c', '6s'], 'TURN', [...PF, ...FLOP_CB_CALL, A_('BB', 'BET', 10, 'TURN')])],
  ['R-05 顶对·对手 120% 池', EQ(['As', 'Ks'], ['Kd', '9c', '4h', '6s', '2d'], 'RIVER', [...PF, ...FLOP_CB_CALL, ...TURN_CB_CALL, A_('BB', 'BET', 41.5, 'RIVER')])],
  ['R-06 暗三条面对河牌加注', EQ(['9h', '9s'], ['Jd', '9c', '4c', '6s', '2h'], 'RIVER', [...PF, ...FLOP_CB_CALL, ...TURN_CB_CALL, A_('BB', 'BET', 20, 'RIVER'), A_('BTN', 'RAISE', 60, 'RIVER')], 'BB')],
];
const j = (v: unknown): string => JSON.stringify(v) ?? 'undefined';
const EVLIST = (rows: readonly Record<string, any>[]): string =>
  j(rows.map((r) => `${String(r['action'])}@${r['sizeChips'] === undefined ? '-' : String(r['sizeChips'])}:${r['ev'] === null ? 'null' : String(r['ev'])}`));

for (const [tag, base] of NODES) {
  for (const profile of ['NORMAL', 'CALLING_STATION'] as const) {
    const input = { ...(base as unknown as Record<string, unknown>), villain: OPP(profile) } as unknown as ManualHandInput;
    const r = analyzeManualHand(input, OPTIONS);
    console.log('='.repeat(118));
    console.log(`## ${tag} ｜ ${profile}`);
    if (!r.ok) { console.log(`   ✖ 失败 ${String(r.stage)}`); continue; }
    const d = r.decision as unknown as Record<string, any>;
    const dg = (d['diagnostics'] ?? {}) as Record<string, any>;
    const pf = (dg['postflop'] ?? {}) as Record<string, any>;
    const tail = (obj: unknown, cap = 1500): string => { const s = j(obj); return s.length > cap ? `${s.slice(0, cap)}…(共${s.length})` : s; };
    console.log(`  【合法动作】${tail(dg['legalActions'], 700)}`);
    console.log(`  【决策依据】kind=${String((dg['decisionBasis'] ?? {})['kind'])} ｜ note=${tail((dg['decisionBasis'] ?? {})['noteZh'], 400)}`);
    console.log(`  【依据(翻后)】kind=${String(pf['decisionBasisKind'])} ｜ note=${tail(pf['decisionBasisNoteZh'], 400)}`);
    console.log(`  【基线/最终】base=${tail(dg['baseDecision'], 300)} ｜ adjusted=${tail(dg['adjustedDecision'], 300)} ｜ primary=${tail(dg['primaryAction'], 200)}`);
    console.log(`  【最终动作】${String(d['action'])}${d['sizeChips'] === undefined ? '' : ` @${String(d['sizeChips'])}`} ｜ basisKind=${String((dg['decisionBasis'] ?? {})['kind'])}`);
    console.log(`  【证据表】${tail((dg['actionEvidence'] ?? []).map((e: Record<string, any>) => ({ a: e['action'], t: e['estimateType'], ev: e['ev'] === null ? null : Number(Number(e['ev']).toFixed(3)), margin: e['decisionMargin'], cs: e['commitsStack'] ?? null, hs: e['heuristicScore'] })), 1400)}`);
    console.log(`  【候选】${EVLIST((dg['candidates'] ?? []) as Record<string, any>[])}`);
    console.log(`  【未评估】${tail((dg['unevaluatedActions'] ?? []).map((u: Record<string, any>) => `${String(u['action'])}@${String(u['sizeChips'])}:${String(u['reasonCode'])}`), 500)}`);
    console.log(`  【下注模型 betDecision】${tail(pf['betDecision'], 1600)}`);
    console.log(`  【下注尺寸事实 betRangeSizing】${tail(pf['betRangeSizing'], 900)}`);
    console.log(`  【加注响应 raiseResponse】${tail(pf['raiseResponse'], 1400)}`);
    console.log(`  【多路下注 multiwayBetDecision】${tail(dg['multiwayBetDecision'], 500)}`);
  }
}
console.log('='.repeat(118));
console.log('（焦点探针结束，只读）');
