/**
 * PREFLOP F2 FINAL ACCEPTANCE + FLOP/TURN/RIVER REGRESSION（**只读**）
 *
 * §一 F2 验收节点 A–G（任务 §三）
 * §二 既有已登记牌局回归（任务 §四）：TEST 16 / TEST 17 / TEST 18 / 99 CALL EV /
 *     AK 河牌 / 99 暗三条河牌价值加注 / P0-7 短筹码 + 未匹配退回
 *
 * 用法：node --experimental-strip-types scripts/f2-acceptance-and-postflop-regression.ts
 * 在「F2 修复前检查点」与「当前工作区」各跑一次，逐行 diff ⇒ 修复前后真实生产结果。
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
const stacks = (bb: number): Record<string, number> => ({ UTG: bb, HJ: bb, CO: bb, BTN: bb, SB: bb, BB: bb });
const V = (profile: string, bb = 100, stats?: Record<string, unknown>): ManualVillain =>
  ({ quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: bb, ...(stats === undefined ? {} : { observedStats: stats }) }) as unknown as ManualVillain;
const MANIAC_STATS = { handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null };

/* ---------------- §一 F2 验收节点 A–G ---------------- */
const OPEN3 = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD')];
const bbVsOpen = (cards: [string, string], bb: number): ManualHandInput =>
  ({ tableSize: 6, heroPosition: 'BB', heroCards: cards, board: [], street: 'PREFLOP', effectiveStackBB: bb, bigBlindBB: 2, seatStacksBB: stacks(bb), actionHistory: [...OPEN3], environment: 'MID_LOW_STAKES', villain: V('NORMAL', bb) }) as unknown as ManualHandInput;

const PF = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];
const FLOP_25 = [A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP')];
const TURN_75 = [A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN')];
const FLOP_4 = [A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP')];
const TURN_10 = [A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN')];

const F2_NODES: ReadonlyArray<readonly [string, ManualHandInput]> = [
  ['A 5BB AA 面对开池', bbVsOpen(['As', 'Ah'], 5)],
  ['B 5BB KK 面对开池', bbVsOpen(['Ks', 'Kh'], 5)],
  ['C 5BB AKs 面对开池', bbVsOpen(['As', 'Ks'], 5)],
  ['D 10BB AA 面对开池', bbVsOpen(['As', 'Ah'], 10)],
  ['H 3BB AA 面对开池（under-raise 边界：minRaiseTo > allInTo）', bbVsOpen(['As', 'Ah'], 3)],
  ['I 4BB AA 面对开池（minRaiseTo > allInTo，但 ALL_IN 合法）', bbVsOpen(['As', 'Ah'], 4)],
  ['E 100BB AA 面对 3bet 至 10BB', { tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: [], street: 'PREFLOP', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...OPEN3, A_('BB', 'RAISE', 10)], environment: 'MID_LOW_STAKES', villain: V('NORMAL') } as unknown as ManualHandInput],
  ['F-a 翻后弱一对（99 中对）面对 20 筹码领打（转牌）', { tableSize: 6, heroPosition: 'BTN', heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...FLOP_4, A_('BB', 'BET', 10, 'TURN')], environment: 'MID_LOW_STAKES', villain: V('MANIAC', 100, MANIAC_STATS) } as unknown as ManualHandInput],
  ['F-b 翻后弱一对（多人池顶对）+ 唯一加注即全下（转牌）', { tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s'], street: 'TURN', effectiveStackBB: 25, bigBlindBB: 2, seatStacksBB: stacks(25), actionHistory: [A_('UTG', 'CALL', 1), A_('HJ', 'FOLD'), A_('CO', 'CALL', 1), A_('BTN', 'RAISE', 5), A_('SB', 'FOLD'), A_('BB', 'CALL', 4), A_('UTG', 'CALL', 4), A_('CO', 'CALL', 4), A_('BB', 'CHECK', undefined, 'FLOP'), A_('UTG', 'CHECK', undefined, 'FLOP'), A_('CO', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 6, 'FLOP'), A_('BB', 'FOLD'), A_('UTG', 'CALL', 6, 'FLOP'), A_('CO', 'CALL', 6, 'FLOP'), A_('UTG', 'BET', 7, 'TURN'), A_('CO', 'CALL', 7, 'TURN')], environment: 'MID_LOW_STAKES', villain: V('CALLING_STATION', 25) } as unknown as ManualHandInput],
  ['G-a 翻后暗三条（99 三条）河牌面对 20BB 领打', { tableSize: 6, heroPosition: 'BTN', heroCards: ['9s', '9h'], board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...FLOP_25, ...TURN_75, A_('BB', 'BET', 20, 'RIVER')], environment: 'MID_LOW_STAKES', villain: V('CALLING_STATION') } as unknown as ManualHandInput],
  ['G-b 翻后暗三条（99 三条）转牌面对加注至 40BB', { tableSize: 6, heroPosition: 'BTN', heroCards: ['9h', '9s'], board: ['Jd', '9c', '4c', '6s'], street: 'TURN', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...FLOP_4, A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'RAISE', 40, 'TURN')], environment: 'MID_LOW_STAKES', villain: V('MANIAC', 100, MANIAC_STATS) } as unknown as ManualHandInput],
];

/* ---------------- §二 既有已登记牌局 ---------------- */
const REG_NODES: ReadonlyArray<readonly [string, ManualHandInput]> = [
  ['R1 TEST 16 · 河牌三条 AA 面对 10BB 领打（阿豪/MANIAC 实测画像）', { tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...FLOP_25, ...TURN_75, A_('BB', 'BET', 10, 'RIVER')], environment: 'MID_LOW_STAKES', villain: { seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: MANIAC_STATS } as unknown as ManualVillain } as unknown as ManualHandInput],
  ['R2 TEST 17 · 转牌顶对 + 坚果同花听（A♣J♣）面对 10BB 领打', { tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...FLOP_4, A_('BB', 'BET', 10, 'TURN')], environment: 'MID_LOW_STAKES', villain: V('MANIAC', 100, MANIAC_STATS) } as unknown as ManualHandInput],
  ['R3 TEST 18 · 转牌（A♣J♣）面对加注至 40BB', { tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', 'Jc'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...FLOP_4, A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'RAISE', 40, 'TURN')], environment: 'MID_LOW_STAKES', villain: V('MANIAC', 100, MANIAC_STATS) } as unknown as ManualHandInput],
  ['R4 99 中对正 CALL EV 裁决（P1 原始节点，阿豪/MANIAC 实测）', { tableSize: 6, heroPosition: 'BTN', heroCards: ['9h', '9c'], board: ['Jd', '8c', '4c', '6s'], street: 'TURN', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...FLOP_4, A_('BB', 'BET', 10, 'TURN')], environment: 'MID_LOW_STAKES', villain: { seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: MANIAC_STATS } as unknown as ManualVillain } as unknown as ManualHandInput],
  ['R5 AK 河牌面对 20BB 领打（U1 / V2 黄金节点）', { tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...FLOP_25, ...TURN_75, A_('BB', 'BET', 20, 'RIVER')], environment: 'MID_LOW_STAKES', villain: V('CALLING_STATION') } as unknown as ManualHandInput],
  ['R6 99 暗三条河牌价值加注（V2 验收节点）', { tableSize: 6, heroPosition: 'BTN', heroCards: ['9s', '9h'], board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: stacks(100), actionHistory: [...PF, ...FLOP_25, ...TURN_75, A_('BB', 'BET', 20, 'RIVER')], environment: 'MID_LOW_STAKES', villain: V('CALLING_STATION') } as unknown as ManualHandInput],
  ['R7 P0-7 短筹码对手（30BB）+ 未匹配金额退回', { tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 30 }, actionHistory: [...PF, ...FLOP_25, ...TURN_75, A_('BB', 'BET', 10, 'RIVER')], environment: 'MID_LOW_STAKES', villain: V('CALLING_STATION', 30) } as unknown as ManualHandInput],
];

const num = (v: unknown, d = 3): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const pct = (v: unknown, d = 3): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const j = (v: unknown, cap = 400): string => { const s = JSON.stringify(v) ?? 'undefined'; return s.length > cap ? `${s.slice(0, cap)}…` : s; };

function fingerprint(tag: string, input: ManualHandInput): void {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { console.log(`${tag} ｜ ✖ 失败 ${String(r.stage)} ${j(r.issues, 200)}`); return; }
  const d = r.decision as unknown as Record<string, any>;
  const dg = (d['diagnostics'] ?? {}) as Record<string, any>;
  const m = (dg['math'] ?? {}) as Record<string, any>;
  const pf = (dg['postflop'] ?? {}) as Record<string, any>;
  const g = (dg['allInGuard'] ?? {}) as Record<string, any>;
  const eq = (dg['conditionalEquities'] ?? {}) as Record<string, any>;
  const src = (dg['decisionSource'] ?? {}) as Record<string, any>;
  const rr = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
  const ev = (a: string): string => { const e = ((dg['actionEvidence'] ?? []) as Record<string, any>[]).find((x) => x['action'] === a); return e === undefined ? '—' : `${e['ev'] === null ? 'null' : num(e['ev'], 2)}/${String(e['estimateType'])}`; };
  const cands = ((dg['candidates'] ?? []) as Record<string, any>[]).map((c) => `${String(c['action'])}@${c['sizeChips'] === undefined ? '-' : num(c['sizeChips'], 2)}`).join(',');
  console.log(
    `${tag}` +
    `\n  action=${String(d['action'])}${d['sizeChips'] === undefined ? '' : ` ${num(d['sizeChips'], 2)}`} ｜ 本街已投入=${num(m['myCommittedThisStreet'], 2)} 剩余=${num(m['myRemainingStack'], 2)} 有效=${num(m['effectiveStack'], 2)}` +
    `\n  EV: FOLD=${ev('FOLD')} CALL=${ev('CALL')} CHECK=${ev('CHECK')} BET=${ev('BET')} RAISE=${ev('RAISE')}` +
    `\n  guard: street=${String(g['street'] ?? '—')} handCategory=${String(g['handCategory'])} consumesStack=${String(g['consumesStack'])} hasOwnEV=${String(g['hasOwnEV'])} onePairAllInBlocked=${String(g['onePairAllInBlocked'])} largeRaiseBlocked=${String(g['largeRaiseBlocked'])}` +
    `\n  范围/权益: arrival=${pct(eq['arrivalRange'])} betRange=${pct(eq['betRange'])} heroEq=${pct(m['heroEquity'])} EqBetRange=${pct(m['heroEquityVsBetRange'])} req=${pct(m['requiredEquity'])} 门槛权益源=${String(eq['usedByRaiseThreshold'] ?? '—')}` +
    `\n  来源=${String(src['kind'])} ｜ 候选=[${cands}] ｜ 未评估=${j(((dg['unevaluatedActions'] ?? []) as Record<string, any>[]).map((u) => `${String(u['action'])}@${String(u['sizeChips'])}:${String(u['reasonCode'])}`), 260)}` +
    `\n  raiseFacts=${rr === null ? 'null' : j({ sz: rr['sizeChips'], ev: rr['raiseEV'], heroAdd: rr['heroAdd'], villainAdd: rr['villainAdd'], heroContestedAdd: rr['heroContestedAdd'], uncalledReturn: rr['uncalledReturn'], finalPot: rr['finalPot'], contract: rr['cashflowContract'], f: rr['foldLikelihood'], c: rr['callLikelihood'], r: rr['reRaiseLikelihood'] }, 420)}` +
    `\n  画像: ${j(dg['player'], 200)}`,
  );
}

console.log('='.repeat(120));
console.log('§一 F2 验收节点 A–G');
console.log('='.repeat(120));
for (const [tag, input] of F2_NODES) fingerprint(tag, input);
console.log('');
console.log('='.repeat(120));
console.log('§二 既有已登记牌局回归');
console.log('='.repeat(120));
for (const [tag, input] of REG_NODES) fingerprint(tag, input);
console.log('');
console.log('（只读探针结束）');
