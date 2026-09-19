/**
 * M1 修复 · 影响面扫描（只读）
 *
 * 目的：回答「这次修复到底改变了哪些局面、改了多少、有没有把动作改掉」。
 *
 * 用法：
 *   主仓库          ⇒ 修复后（融合维度）
 *   副本 M1_BAND_MODE=facing ⇒ 修复前（折 0.35 的维度）
 * 两侧输出同一格式，逐行 diff。
 *
 * 扫描维度：5 种画像 × 5 种统计形态 × 3 组牌面/底牌 = 75 个局面。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(), asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A_ = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }),
});
const HISTORY = (riverBettor: string): readonly Record<string, unknown>[] => [
  A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
  A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
  A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP'),
  A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN'),
  A_(riverBettor, 'BET', 10, 'RIVER'),
];

const BOARDS: ReadonlyArray<readonly [string, readonly [string, string], readonly string[]]> = [
  ['AA/Ad9c4h6s2d', ['As', 'Ah'], ['Ad', '9c', '4h', '6s', '2d']],
  ['KK/Kd8s3c2d7h', ['Ks', 'Kh'], ['Kd', '8s', '3c', '2d', '7h']],
  ['76s/8s7d2cJh3s', ['7s', '6s'], ['8s', '7d', '2c', 'Jh', '3s']],
];

const LABELS = ['MANIAC', 'CALLING_STATION', 'VERY_TIGHT', 'NORMAL', null] as const;
const STAT_SETS: ReadonlyArray<readonly [string, Record<string, unknown> | null]> = [
  ['无统计', null],
  ['四轴 800 手', { handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null }],
  ['仅 VPIP 800 手', { handsObserved: 800, vpip: 0.62, pfr: null, threeBet: null, wtsd: null, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null }],
  ['仅 PFR 低 800 手', { handsObserved: 800, vpip: null, pfr: 0.08, threeBet: null, wtsd: null, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null }],
  ['仅分街 800 手', { handsObserved: 800, vpip: null, pfr: null, threeBet: null, wtsd: null, foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: 0.55, flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: 0.1 }],
];

const n = (v: unknown, d = 9): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : 'n/a');

console.log(`# M1 影响面扫描（M1_BAND_MODE=${String(process.env['M1_BAND_MODE'] ?? 'default')}）`);
console.log('# scenario\tlabel\tstats\tboard\taction\tbetMass\tcallEV\traiseEV\teqVsBet\tpFold\tpCall\tpRaise');

for (const [boardTag, heroCards, board] of BOARDS) {
  for (const label of LABELS) {
    for (const [statTag, stats] of STAT_SETS) {
      const villain: ManualVillain = {
        seatId: 'seat_BB', persistentPlayerId: 'p1', stackBB: 100, dynamicHint: 'UNKNOWN',
        ...(label === null ? {} : { quickProfile: label as never }),
        ...(stats === null ? {} : { observedStats: stats as never }),
      };
      const input = {
        tableSize: 6, heroPosition: 'BTN', heroCards, board,
        street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
        seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
        actionHistory: [...HISTORY('BB')],
        environment: 'MID_LOW_STAKES', villain,
      } as unknown as ManualHandInput;
      const r = analyzeManualHand(input, OPTIONS);
      const scenario = `${String(label ?? 'NONE').padEnd(15)} ${statTag.padEnd(16)} ${boardTag}`;
      if (!r.ok) { console.log(`${scenario}\tFAIL:${r.stage}`); continue; }
      const d = r.decision as unknown as Record<string, any>;
      const dg = d['diagnostics'] as Record<string, any>;
      const pf = (dg['postflop'] ?? {}) as Record<string, any>;
      const br = (pf['bettingRangeFacts'] ?? null) as Record<string, any> | null;
      const rr = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
      console.log([
        scenario,
        `${String(d['action'])}@${String(d['sizeChips'] ?? '-')}`,
        n(br?.['betMass'], 12),
        n((dg['math'] ?? {})['callEV'], 6),
        n(rr?.['raiseEV'], 6),
        n((dg['math'] ?? {})['heroEquityVsBetRange'], 12),
        n(rr?.['foldLikelihood'], 6),
        n(rr?.['callLikelihood'], 6),
        n(rr?.['reRaiseLikelihood'], 6),
      ].join('\t'));
    }
  }
}
