/**
 * 画像方向查证：同一手、同一街，只换对手画像 —— 动作与权益怎么变？
 *
 * 起因：100 手语料聚合里 `CALLING_STATION` 的弃牌次数（20）**高于** `NORMAL`（19），
 * 与「跟注站更爱跟、更少弃」的直觉相反。本探针把每一格并排打出来，
 * 判定它是**引擎缺陷**还是**口径问题**（例如：我的弃牌由「他对我的下注怎么反应」
 * 与「他的范围有多强」两条通道共同决定，而这两条方向可能相反）。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 900_000, hardMs: 1_800_000 },
} as const;

const pre = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }),
});
const F = (p: string, t: string, a?: number): Record<string, unknown> => pre(p, t, a, 'FLOP');
const T = (p: string, t: string, a?: number): Record<string, unknown> => pre(p, t, a, 'TURN');
const R = (p: string, t: string, a?: number): Record<string, unknown> => pre(p, t, a, 'RIVER');
const W = (s: string): number => [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - W(s)));
const pct = (v: unknown, d = 1): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—';
const num = (v: unknown, d = 1): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—';
const SEATS6 = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

const STATS: Readonly<Record<string, Record<string, number>>> = {
  NORMAL: { vpip: 0.2, pfr: 0.16, threeBet: 0.04, wtsd: 0.3, foldToFlopCBet: 0.5, foldToTurnCBet: 0.48, foldToRiverBet: 0.45 },
  VERY_TIGHT: { vpip: 0.11, pfr: 0.07, threeBet: 0.03, wtsd: 0.2, foldToFlopCBet: 0.72, foldToTurnCBet: 0.6, foldToRiverBet: 0.65 },
  CALLING_STATION: { vpip: 0.55, pfr: 0.12, threeBet: 0.03, wtsd: 0.42, foldToFlopCBet: 0.3, foldToTurnCBet: 0.28, foldToRiverBet: 0.25 },
  MANIAC: { vpip: 0.56, pfr: 0.37, threeBet: 0.13, wtsd: 0.3, foldToFlopCBet: 0.46, foldToTurnCBet: 0.45, foldToRiverBet: 0.45 },
  LOOSE: { vpip: 0.34, pfr: 0.1, threeBet: 0.04, wtsd: 0.3, foldToFlopCBet: 0.56, foldToTurnCBet: 0.5, foldToRiverBet: 0.45 },
};

function villain(profile: string): Record<string, unknown> {
  return {
    seatId: 'seat_BB', persistentPlayerId: 'p_villain', displayName: '对手', stackBB: 100,
    quickProfile: profile,
    observedStats: { handsObserved: 2000, flopCheckRaise: 0.06, turnCheckRaise: 0.05, riverCheckRaise: 0.04, ...STATS[profile]! },
  };
}

/** 线型①的决策点：BB 过牌 → 我（BTN）决定；BB 领打 → 我决定 */
function node(street: 'FLOP' | 'TURN' | 'RIVER', hero: readonly [string, string], board: readonly string[], profile: string): ManualHandInput {
  const hist: Record<string, unknown>[] = [
    pre('UTG', 'FOLD'), pre('HJ', 'FOLD'), pre('CO', 'FOLD'), pre('BTN', 'RAISE', 2.5), pre('SB', 'FOLD'), pre('BB', 'CALL', 1.5),
  ];
  if (street === 'FLOP') hist.push(F('BB', 'CHECK'));
  if (street === 'TURN') hist.push(F('BB', 'CHECK'), F('BTN', 'BET', 2), F('BB', 'CALL', 2), T('BB', 'CHECK'));
  if (street === 'RIVER') {
    hist.push(
      F('BB', 'CHECK'), F('BTN', 'BET', 2), F('BB', 'CALL', 2),
      T('BB', 'CHECK'), T('BTN', 'BET', 4), T('BB', 'CALL', 4), R('BB', 'CHECK'),
    );
  }
  const n = street === 'FLOP' ? 3 : street === 'TURN' ? 4 : 5;
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: hero, board: board.slice(0, n), street,
    effectiveStackBB: 100, bigBlindBB: 100, seatStacksBB: SEATS6,
    actionHistory: hist, environment: 'MID_LOW_STAKES', villain: villain(profile),
  } as unknown as ManualHandInput;
}

type Row = { action: string; size: string; eq: number | null; betEq: number | null; req: number | null; callEV: number | null; verdict: string; weak: number | null; strong: number | null };
function read(input: ManualHandInput): Row {
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) return { action: `FAIL/${r.stage}`, size: '-', eq: null, betEq: null, req: null, callEV: null, verdict: '-', weak: null, strong: null };
  const d: any = r.decision;
  const pf: any = d.diagnostics.postflop ?? {};
  const va: any = pf.valueAssessment ?? {};
  return {
    action: String(d.action),
    size: d.sizeBB === undefined ? '—' : Number(d.sizeBB).toFixed(2),
    eq: d.diagnostics.math.heroEquity,
    betEq: d.diagnostics.math.heroEquityVsBetRange,
    req: d.diagnostics.requiredEquity ?? d.diagnostics.math.requiredEquity,
    callEV: d.diagnostics.math.callEV,
    verdict: String(va.verdict ?? '-'),
    weak: typeof va.weakerShare === 'number' ? va.weakerShare : null,
    strong: typeof va.strongerShare === 'number' ? va.strongerShare : null,
  };
}

const CASES: readonly { tag: string; street: 'FLOP' | 'TURN' | 'RIVER'; hero: readonly [string, string]; board: readonly string[] }[] = [
  { tag: 'K72r · 中对 99（他过牌给我）', street: 'FLOP', hero: ['9s', '9h'], board: ['Ks', '7h', '2c', '4d', 'Jh'] },
  { tag: 'K72r · 空气 A5s（他过牌给我）', street: 'FLOP', hero: ['As', '5s'], board: ['Ks', '7h', '2c', '4d', 'Jh'] },
  { tag: 'QJs8ss · 顶对 KQ（他过牌给我）', street: 'FLOP', hero: ['Kh', 'Qh'], board: ['Qs', 'Js', '8s', '2h', '3d'] },
  { tag: 'K72r4d · 中对 99（转牌他过牌）', street: 'TURN', hero: ['9s', '9h'], board: ['Ks', '7h', '2c', '4d', 'Jh'] },
  { tag: 'K72r4dJh · 中对 99（河牌他过牌）', street: 'RIVER', hero: ['9s', '9h'], board: ['Ks', '7h', '2c', '4d', 'Jh'] },
  { tag: 'K72r4dJh · 空气 A5s（河牌他过牌）', street: 'RIVER', hero: ['As', '5s'], board: ['Ks', '7h', '2c', '4d', 'Jh'] },
];

for (const c of CASES) {
  console.log('');
  console.log('='.repeat(126));
  console.log(`${c.tag}　［${c.street}］`);
  console.log('='.repeat(126));
  console.log(
    pad('对手画像', 18) + pad('动作', 8) + pad('尺寸', 7) + pad('权益(到达)', 11) + pad('EqVs下注', 10) +
    pad('需权益', 8) + pad('CALL EV', 9) + pad('更弱/更强占比', 15) + '价值判定',
  );
  console.log('-'.repeat(126));
  for (const p of Object.keys(STATS)) {
    const r = read(node(c.street, c.hero, c.board, p));
    console.log(
      pad(p, 18) + pad(r.action, 8) + pad(r.size, 7) + pad(pct(r.eq), 11) + pad(pct(r.betEq), 10) +
      pad(pct(r.req), 8) + pad(num(r.callEV), 9) +
      pad(`${pct(r.weak)} / ${pct(r.strong)}`, 15) + r.verdict,
    );
  }
}
