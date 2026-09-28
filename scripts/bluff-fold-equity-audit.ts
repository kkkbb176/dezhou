/**
 * 目标(2) 复核：引擎的「诈唬」决策到底受不受**对手弃牌率**支配？
 *
 * 为什么换到河牌大注：翻牌 1 池下注的风险回报比太小（弃 78% 就已印钱），
 * 任何合理模型都会让你下注。真正能分辨「引擎会不会停止诈唬」的地方是
 * **河牌、大尺寸、纯空气** —— 这里弃牌率必须把「被跟注的代价」挣回来。
 *
 * 逐画像扫描 + 逐尺寸列出：P(弃) / P(跟) / BetEV / CHECK EV / 最终动作。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 900_000, hardMs: 1_800_000 },
} as const;

const A = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});
const W = (s: string): number => [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - W(s)));
const rule = (w = 132): string => '='.repeat(w);
const pct = (v: unknown, d = 1): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—';
const num = (v: unknown, d = 1): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—';
const S9 = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

/**
 * 河牌：Hero BTN 开池、BB 跟注；三街过牌到河牌，Hero 持**纯空气**（A♠5♠，牌面全不中）
 * ⇒ 这是一个「只能靠弃牌率赢」的节点。
 */
function riverAir(villain: Record<string, unknown>): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BTN', heroCards: ['As', '5s'],
    board: ['Kd', 'Qh', '8c', '3s', '2d'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 100, seatStacksBB: S9,
    actionHistory: [
      A('UTG', 'FOLD'), A('UTG1', 'FOLD'), A('UTG2', 'FOLD'), A('LJ', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
      A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'CHECK', undefined, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'CHECK', undefined, 'TURN'),
      A('BB', 'CHECK', undefined, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain,
  } as unknown as ManualHandInput;
}

const S_STATION = {
  handsObserved: 2000, vpip: 0.55, pfr: 0.12, threeBet: 0.03, wtsd: 0.42,
  foldToFlopCBet: 0.3, foldToTurnCBet: 0.28, foldToRiverBet: 0.25,
  flopCheckRaise: 0.05, turnCheckRaise: 0.04, riverCheckRaise: 0.03,
} as const;
const S_FOLDER = {
  handsObserved: 2000, vpip: 0.22, pfr: 0.16, threeBet: 0.05, wtsd: 0.18,
  foldToFlopCBet: 0.7, foldToTurnCBet: 0.65, foldToRiverBet: 0.72,
  flopCheckRaise: 0.05, turnCheckRaise: 0.04, riverCheckRaise: 0.03,
} as const;

const CASES: readonly { name: string; villain: Record<string, unknown> }[] = [
  { name: '① 什么都没有（对照）', villain: {} },
  { name: '② 跟注站（弃河牌 25%）', villain: { observedStats: S_STATION, quickProfile: 'CALLING_STATION', seatId: 'seat_BB', persistentPlayerId: 'p_bb', stackBB: 100 } },
  { name: '③ 会弃型（弃河牌 72%）', villain: { observedStats: S_FOLDER, quickProfile: 'UNDERBLUFFER', seatId: 'seat_BB', persistentPlayerId: 'p_bb', stackBB: 100 } },
  { name: '④ 会弃型（标签 NORMAL）', villain: { observedStats: S_FOLDER, quickProfile: 'NORMAL', seatId: 'seat_BB', persistentPlayerId: 'p_bb', stackBB: 100 } },
];

console.log(rule());
console.log('河牌纯空气（A♠5♠ / K♦Q♥8♣3♠2♦，三街过牌后 BB 过牌给我）');
console.log('问题：引擎会不会因为「他跟注太少」而**停止诈唬**？');
console.log(rule());

for (const c of CASES) {
  const r = analyzeManualHand(riverAir(c.villain), OPTIONS);
  if (!r.ok) { console.log(pad(c.name, 30) + 'FAIL/' + r.stage); continue; }
  const d: any = r.decision;
  const dg: any = d.diagnostics;
  const pf: any = dg.postflop ?? {};
  const bd: any = pf.betDecision ?? {};
  const sizes: any[] = bd.sizes ?? [];
  console.log('');
  console.log(`【${c.name}】最终动作 = ${String(d.action)}${d.sizeBB === undefined ? '' : ' @ ' + Number(d.sizeBB).toFixed(2) + 'BB'}　CHECK EV = ${num(bd.checkEV)}　分类 ${String(d.classification)}`);
  console.log(
    '  ' + pad('尺寸档', 12) + pad('金额', 8) + pad('P(弃)', 9) + pad('P(跟)', 9) + pad('P(加)', 9) +
    pad('BetEV', 10) + pad('Δ vs CHECK', 12) + '被跟注时权益',
  );
  for (const s of sizes) {
    console.log(
      '  ' + pad(String(s.size), 12) + pad(String(s.betAmount), 8) + pad(pct(s.foldLikelihood), 9) +
      pad(pct(s.callLikelihood), 9) + pad(pct(s.raiseLikelihood), 9) + pad(num(s.betEV), 10) +
      pad(num(s.deltaVsCheck), 12) + pct(s.heroEquityVsCallRange),
    );
  }
}

/* ============================================================
 * 弃牌率扫描：同一手牌、同一尺寸档，只改「他弃多少」
 * ============================================================ */
console.log('');
console.log(rule());
console.log('弃牌率扫描：只改对手的 foldTo{Flop,Turn,River}Bet（2000 手，无标签），看动作何时翻面');
console.log(rule());
console.log(pad('对手弃牌率', 14) + pad('P(弃)最大档', 12) + pad('BetEV', 10) + pad('CHECK EV', 10) + pad('Δ', 10) + '动作');
console.log('-'.repeat(132));
for (const f of [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85] as const) {
  const stats = {
    handsObserved: 2000, vpip: 0.3, pfr: 0.12, threeBet: 0.04, wtsd: 0.3,
    foldToFlopCBet: f, foldToTurnCBet: f, foldToRiverBet: f,
    flopCheckRaise: 0.05, turnCheckRaise: 0.04, riverCheckRaise: 0.03,
  };
  const r = analyzeManualHand(
    riverAir({ observedStats: stats, seatId: 'seat_BB', persistentPlayerId: 'p_bb', stackBB: 100 }),
    OPTIONS,
  );
  if (!r.ok) { console.log(pad(`${(f * 100).toFixed(0)}%`, 14) + 'FAIL/' + r.stage); continue; }
  const d: any = r.decision;
  const pf: any = (d.diagnostics as any).postflop ?? {};
  const bd: any = pf.betDecision ?? {};
  const sizes: any[] = bd.sizes ?? [];
  const last = sizes.length === 0 ? null : sizes[sizes.length - 1];
  console.log(
    pad(`${(f * 100).toFixed(0)}%`, 14) + pad(pct(last?.foldLikelihood), 12) + pad(num(last?.betEV), 10) +
    pad(num(bd.checkEV), 10) + pad(num(last?.deltaVsCheck), 10) +
    `${String(d.action)}${d.sizeBB === undefined ? '' : ' @ ' + Number(d.sizeBB).toFixed(2)}`,
  );
}


