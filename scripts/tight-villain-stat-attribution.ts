/**
 * 实测统计（observedStats）**逐项归因**实验
 *
 * 目的：回答「紧手实测 VPIP12/PFR9 把 EqVs下注范围 从 38.0% 抬到 46.6%，
 *       到底是哪一个统计项干的？」以及「单项统计能不能单独改变引擎输出？」
 *
 * 做法：固定标签 VERY_TIGHT，加 **一项** 2000 手实测统计，其余保持未观测（null）。
 *       每个格子都是同一局面（K♠7♥2♣，UTG 开池 → Hero BTN 跟注 → UTG 下注 5BB）。
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
const SEATS9 = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

function facingBet(hero: readonly [string, string], observedStats: Record<string, unknown> | null): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BTN', heroCards: hero, board: ['Ks', '7h', '2c'], street: 'FLOP',
    effectiveStackBB: 100, bigBlindBB: 100, seatStacksBB: SEATS9,
    actionHistory: [
      A('UTG', 'RAISE', 3), A('UTG1', 'FOLD'), A('UTG2', 'FOLD'), A('LJ', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
      A('BTN', 'CALL', 3), A('SB', 'FOLD'), A('BB', 'FOLD'), A('UTG', 'BET', 5, 'FLOP'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: {
      persistentPlayerId: 'p_tight_utg', seatId: 'seat_UTG', stackBB: 100, quickProfile: 'VERY_TIGHT',
      ...(observedStats === null ? {} : { observedStats: { handsObserved: 2000, ...observedStats } }),
    },
  } as unknown as ManualHandInput;
}

type Cell = {
  eq: string;
  action: string;
  size: string;
  floor: string;
  nut: string;
  air: string;
  callEV: string;
  used: number;
  note: string;
};

function read(hero: readonly [string, string], stats: Record<string, unknown> | null): Cell {
  const r = analyzeManualHand(facingBet(hero, stats), OPTIONS);
  if (!r.ok) return { eq: 'FAIL', action: r.stage, size: '-', floor: '-', nut: '-', air: '-', callEV: '-', used: 0, note: '' };
  const d: any = r.decision;
  const pf: any = d.diagnostics.postflop ?? {};
  const comp: any = pf.rangeCompression ?? {};
  const used = ((d.diagnostics.player?.measuredStats?.usedStatKeys ?? []) as readonly string[]).length;
  return {
    eq: `${(d.diagnostics.math.heroEquityVsBetRange * 100).toFixed(1)}%`,
    action: String(d.action),
    size: d.sizeBB === undefined ? '—' : d.sizeBB.toFixed(2),
    floor: (comp.strengthFloor ?? NaN).toFixed(4),
    nut: (comp.nutDensity ?? NaN).toFixed(4),
    air: (comp.airDensity ?? NaN).toFixed(4),
    callEV: d.diagnostics.math.callEV === null ? '—' : Number(d.diagnostics.math.callEV).toFixed(1),
    used,
    note: String(pf.rangeCompression === undefined ? '' : ''),
  };
}

const FULL = {
  vpip: 0.12, pfr: 0.09, threeBet: 0.03, wtsd: 0.24,
  foldToFlopCBet: 0.72, foldToTurnCBet: 0.55, foldToRiverBet: 0.6,
  flopCheckRaise: 0.1, turnCheckRaise: 0.07, riverCheckRaise: 0.08,
} as const;

const ROWS: readonly { label: string; stats: Record<string, unknown> | null }[] = [
  { label: '无实测（只有标签）', stats: null },
  { label: '全部 10 项（紧手实测）', stats: { ...FULL } },
  { label: '只加 vpip=12%', stats: { vpip: 0.12 } },
  { label: '只加 pfr=9%', stats: { pfr: 0.09 } },
  { label: '只加 threeBet=3%', stats: { threeBet: 0.03 } },
  { label: '只加 wtsd=24%', stats: { wtsd: 0.24 } },
  { label: '只加 foldToFlopCBet=72%', stats: { foldToFlopCBet: 0.72 } },
  { label: '只加 flopCheckRaise=10%', stats: { flopCheckRaise: 0.1 } },
  { label: '只加 vpip+pfr', stats: { vpip: 0.12, pfr: 0.09 } },
  { label: '只加 pfr+threeBet', stats: { pfr: 0.09, threeBet: 0.03 } },
  { label: '只加 pfr+flopCheckRaise', stats: { pfr: 0.09, flopCheckRaise: 0.1 } },
  { label: '全部但 pfr=22%（常态）', stats: { ...FULL, pfr: 0.22 } },
  { label: '全部但 vpip=12%, pfr=22%', stats: { ...FULL, pfr: 0.22 } },
];

const HANDS: readonly (readonly [string, string])[] = [
  ['As', 'Qh'], ['Kh', 'Qh'], ['Js', 'Jh'], ['As', '5s'],
];

for (const hero of HANDS) {
  console.log(`\n=== Hero ${hero[0]}${hero[1]}（K♠7♥2♣ 面对紧手 5BB 下注）`);
  console.log(
    pad('对手画像', 26) + pad('EqVs下注', 10) + pad('动作', 9) + pad('尺寸', 8) +
    pad('strengthFloor', 15) + pad('nutDensity', 12) + pad('airDensity', 12) + pad('CALL_EV', 9) + '接入项数',
  );
  console.log('-'.repeat(112));
  for (const row of ROWS) {
    const c = read(hero, row.stats);
    console.log(
      pad(row.label, 26) + pad(c.eq, 10) + pad(c.action, 9) + pad(c.size, 8) +
      pad(c.floor, 15) + pad(c.nut, 12) + pad(c.air, 12) + pad(c.callEV, 9) + String(c.used),
    );
  }
}
