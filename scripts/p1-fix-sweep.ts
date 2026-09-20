/**
 * P1 修复 · 影响面扫描（只读）
 *
 * 输出每个局面的**紧凑指纹**：动作 + 尺寸 + 跟注 EV + 一致性是否通过 + 依据类型。
 * 在「修复前（检查点）」与「修复后（工作区）」各跑一次，逐行 diff 即可列出
 * **所有最终动作发生变化的已验证节点**（§八 要求）。
 *
 * 用法：node --experimental-strip-types scripts/p1-fix-sweep.ts
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
const BASE = {
  tableSize: 6, heroPosition: 'BTN', effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  environment: 'MID_LOW_STAKES',
} as const;

const n = (v: unknown, d = 6): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));

const STAT_SETS: ReadonlyArray<readonly [string, Record<string, unknown> | null]> = [
  ['无统计', null],
  ['四轴 800 手', { handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null }],
  ['仅 VPIP 800 手', { handsObserved: 800, vpip: 0.62, pfr: null, threeBet: null, wtsd: null, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null }],
  ['仅 PFR 低', { handsObserved: 800, vpip: null, pfr: 0.08, threeBet: null, wtsd: null, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null }],
  ['仅分街', { handsObserved: 800, vpip: null, pfr: null, threeBet: null, wtsd: null, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: 0.55, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: 0.1 }],
];
const PROFILES = ['MANIAC', 'CALLING_STATION', 'VERY_TIGHT', 'NORMAL', null] as const;

/** 节点形状：{tag, heroCards, board, street, history} —— 全部是**面对下注**或**无人下注**的真实节点 */
const SHAPES: ReadonlyArray<readonly [string, readonly [string, string], readonly string[], string, readonly Record<string, unknown>[]]> = [
  ['转牌·面对领打（99）', ['9h', '9c'], ['Jd', '8c', '4c', '6s'], 'TURN', [
    A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
    A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
    A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
    A_('BB', 'BET', 10, 'TURN'),
  ]],
  ['转牌·面对领打（A♣J♣）', ['Ac', 'Jc'], ['Jd', '8c', '4c', '6s'], 'TURN', [
    A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
    A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
    A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
    A_('BB', 'BET', 10, 'TURN'),
  ]],
  ['河牌·面对领打（A♠A♥）', ['As', 'Ah'], ['Ad', '9c', '4h', '6s', '2d'], 'RIVER', [
    A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
    A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
    A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP'),
    A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN'),
    A_('BB', 'BET', 10, 'RIVER'),
  ]],
  ['翻牌·面对领打（K♣Q♣）', ['Kc', 'Qc'], ['Kh', '9d', '4s'], 'FLOP', [
    A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
    A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
    A_('BB', 'BET', 4, 'FLOP'),
  ]],
  ['转牌·无人下注（99）', ['9h', '9c'], ['Jd', '8c', '4c', '6s'], 'TURN', [
    A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
    A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
    A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'),
    A_('BB', 'CHECK', undefined, 'TURN'),
  ]],
];

console.log('# tag\taction\tsize\tcallEV\tconsistency\tbasis');
let count = 0;
for (const [shapeTag, heroCards, board, street, history] of SHAPES) {
  for (const qp of PROFILES) {
    for (const [statTag, stats] of STAT_SETS) {
      const villain: ManualVillain = {
        seatId: 'seat_BB', persistentPlayerId: 'player_001', displayName: '阿豪', dynamicHint: 'UNKNOWN', stackBB: 100,
        ...(qp === null ? {} : { quickProfile: qp as never }),
        ...(stats === null ? {} : { observedStats: stats as never }),
      };
      const input = { ...BASE, heroCards, board, street, actionHistory: history, villain } as unknown as ManualHandInput;
      const r = analyzeManualHand(input, OPTIONS);
      const tag = `${shapeTag} × ${String(qp ?? 'NONE')} × ${statTag}`;
      if (!r.ok) { console.log(`${tag}\tFAIL:${r.stage}`); continue; }
      count += 1;
      const d = r.decision as unknown as Record<string, any>;
      const dg = d['diagnostics'] as Record<string, any>;
      const math = dg['math'] as Record<string, any>;
      const cons = dg['consistency'] as Record<string, any> | null;
      console.log([
        tag,
        String(d['action']),
        String(d['sizeChips'] ?? '-'),
        math['callEV'] === null ? 'null' : n(math['callEV'], 6),
        cons === null || cons['ok'] === true ? 'ok' : ((cons['violations'] as readonly Record<string, any>[]) ?? []).map((v) => String(v['code'])).join('+'),
        String(dg['decisionBasis']?.['kind'] ?? '—'),
      ].join('\t'));
    }
  }
}
console.log(`# 合计局面 = ${count}`);
