/**
 * 隔离实验：**只改对手的 foldToFlopCBet 实测统计**，其余（VPIP/PFR/3Bet/WTSD）完全不变，
 * 看引擎的「EqVs下注范围」「范围压缩」「动作」怎么变。
 *
 * 问题：一个「很紧、但面对 c-bet 弃得很多」的对手，
 *       引擎给我们的权益应该更低（他下注/继续的范围更强）还是更高？
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 600_000, hardMs: 1_200_000 },
} as const;

const A = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});
const W = (s: string): number => [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - W(s)));
const pct = (v: unknown, d = 1): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—';

const SEATS9 = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

function postflop(hero: readonly [string, string], foldToFlopCBet: number | null, profile: string): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BTN', heroCards: hero, board: ['Ks', '7h', '2c'], street: 'FLOP',
    effectiveStackBB: 100, bigBlindBB: 100, seatStacksBB: SEATS9,
    actionHistory: [
      A('UTG', 'RAISE', 3), A('UTG1', 'FOLD'), A('UTG2', 'FOLD'), A('LJ', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
      A('BTN', 'CALL', 3), A('SB', 'FOLD'), A('BB', 'FOLD'), A('UTG', 'BET', 5, 'FLOP'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: {
      playerId: 'seat_UTG', seatId: 'seat_UTG', stackBB: 100, quickProfile: profile,
      observedStats: {
        handsObserved: 2000, vpip: 0.12, pfr: 0.09, threeBet: 0.03, wtsd: 0.24,
        foldToFlopCBet, foldToTurnCBet: 0.55, foldToRiverBet: 0.6,
        flopCheckRaise: 0.1, turnCheckRaise: 0.07, riverCheckRaise: 0.08,
      },
    },
  } as unknown as ManualHandInput;
}

console.log('对手固定：VPIP 12% / PFR 9% / 3Bet 3% / WTSD 24%（很紧）');
console.log('唯一变量：foldToFlopCBet（面对翻牌 c-bet 的弃牌率，2000 手实测）');
console.log('局面：Hero BTN 跟注 UTG 开池 → K♠7♥2♣，UTG 下注 5BB（2/3 池）\n');
console.log(
  pad('Hero 手牌', 12) + pad('foldToCbet', 13) + pad('EqVs下注范围', 14) + pad('动作', 9) +
  pad('尺寸BB', 9) + pad('strengthFloor', 15) + pad('nutDensity', 12) + 'CALL_EV',
);
console.log('-'.repeat(110));

for (const hero of [['Kh', 'Qh'], ['As', 'Qh'], ['Js', 'Jh']] as const) {
  for (const f of [null, 0.35, 0.5, 0.6, 0.72, 0.85] as const) {
    const r = analyzeManualHand(postflop(hero, f, 'VERY_TIGHT'), OPTIONS);
    if (!r.ok) {
      console.log(pad(`${hero[0]}${hero[1]}`, 12) + `FAIL ${r.stage}`);
      continue;
    }
    const d = r.decision;
    const m = d.diagnostics.math;
    const pf = d.diagnostics.postflop as unknown as Record<string, any> | undefined;
    const comp = (pf?.['rangeCompression'] ?? {}) as Record<string, number>;
    console.log(
      pad(`${hero[0]}${hero[1]}`, 12) + pad(f === null ? '未观测(null)' : `${(f * 100).toFixed(0)}%`, 13) +
      pad(pct(m.heroEquityVsBetRange), 14) + pad(String(d.action), 9) +
      pad(d.sizeBB === undefined ? '—' : d.sizeBB.toFixed(2), 9) +
      pad((comp['strengthFloor'] ?? NaN).toFixed(4), 15) +
      pad((comp['nutDensity'] ?? NaN).toFixed(4), 12) +
      (m.callEV === null ? '—' : m.callEV.toFixed(1)),
    );
  }
  console.log('');
}
