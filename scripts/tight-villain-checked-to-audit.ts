/**
 * §D 复核：K♠7♥2♣，紧手 UTG **过牌**给 Hero（有位置）
 *
 * 问题：引擎对「很紧的对手」仍然 107% 池下注（含纯空气）——
 *       它到底有没有把「他很紧」翻译成弃牌率？还是压根没看对手类型？
 *
 * 做法：只改对手画像，逐项打印下注决策里的
 *       ① 逐尺寸响应概率（弃 / 跟 / 加）
 *       ② 对手范围压缩（他多强）
 *       ③ 各候选动作的分数与选择
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

function checkedTo(hero: readonly [string, string], villain: Record<string, unknown>): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BTN', heroCards: hero, board: ['Ks', '7h', '2c'], street: 'FLOP',
    effectiveStackBB: 100, bigBlindBB: 100, seatStacksBB: SEATS9,
    actionHistory: [
      A('UTG', 'RAISE', 3), A('UTG1', 'FOLD'), A('UTG2', 'FOLD'), A('LJ', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
      A('BTN', 'CALL', 3), A('SB', 'FOLD'), A('BB', 'FOLD'), A('UTG', 'CHECK', undefined, 'FLOP'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { playerId: 'seat_UTG', seatId: 'seat_UTG', stackDisplay: '紧手', stackBB: 100, ...villain },
  } as unknown as ManualHandInput;
}

const CASES: readonly { name: string; villain: Record<string, unknown> }[] = [
  { name: '画像未给（中立）', villain: {} },
  { name: 'NORMAL(标签)', villain: { quickProfile: 'NORMAL' } },
  { name: 'VERY_TIGHT(标签)', villain: { quickProfile: 'VERY_TIGHT' } },
  { name: 'CALLING_STATION(标签)', villain: { quickProfile: 'CALLING_STATION' } },
  { name: 'MANIAC(标签)', villain: { quickProfile: 'MANIAC' } },
  {
    name: '实测: VPIP12/PFR9/FoldCbet72',
    villain: {
      quickProfile: 'VERY_TIGHT',
      observedStats: {
        handsObserved: 2000, vpip: 0.12, pfr: 0.09, threeBet: 0.03, wtsd: 0.24,
        foldToFlopCBet: 0.72, foldToTurnCBet: 0.55, foldToRiverBet: 0.6,
        flopCheckRaise: 0.1, turnCheckRaise: 0.07, riverCheckRaise: 0.08,
      },
    },
  },
  {
    name: '实测: 只改 FoldCbet=0.9',
    villain: {
      quickProfile: 'VERY_TIGHT',
      observedStats: {
        handsObserved: 2000, vpip: 0.12, pfr: 0.09, threeBet: 0.03, wtsd: 0.24,
        foldToFlopCBet: 0.9, foldToTurnCBet: 0.55, foldToRiverBet: 0.6,
        flopCheckRaise: 0.1, turnCheckRaise: 0.07, riverCheckRaise: 0.08,
      },
    },
  },
];

console.log('局面：K♠7♥2♣（POT 6.5BB）｜UTG 开池 3BB → Hero BTN 跟注 → UTG **过牌** → Hero 决策\n');
console.log('Hero 手牌 A♠5♠（纯空气 / 后门坚果同花听牌）\n');
console.log(pad('对手画像', 30) + pad('动作', 8) + pad('尺寸BB', 9) + pad('池比', 8) + pad('对手范围: strengthFloor', 24) + pad('nutDensity', 12) + 'airDensity');
console.log('-'.repeat(118));
for (const c of CASES) {
  const r = analyzeManualHand(checkedTo(['As', '5s'], c.villain), OPTIONS);
  if (!r.ok) {
    console.log(pad(c.name, 30) + 'FAIL ' + r.stage);
    continue;
  }
  const d = r.decision;
  const pf = d.diagnostics.postflop as unknown as Record<string, any> | undefined;
  const comp = (pf?.['rangeCompression'] ?? {}) as Record<string, number>;
  const pot = d.diagnostics.math.pot;
  const sizeChips = d.sizeChips ?? 0;
  console.log(
    pad(c.name, 30) + pad(String(d.action), 8) +
    pad(d.sizeBB === undefined ? '—' : d.sizeBB.toFixed(2), 9) +
    pad(pot > 0 ? `${((sizeChips / pot) * 100).toFixed(0)}%` : '—', 8) +
    pad((comp['strengthFloor'] ?? NaN).toFixed(4), 24) +
    pad((comp['nutDensity'] ?? NaN).toFixed(4), 12) +
    (comp['airDensity'] ?? NaN).toFixed(4),
  );
}

console.log('\n\n逐尺寸响应概率（Hero 下注时，对手弃 / 跟 / 加）：');
console.log(pad('对手画像', 30) + pad('尺寸', 10) + pad('P(弃)', 9) + pad('P(跟)', 9) + pad('P(加)', 9) + 'BetEV');
console.log('-'.repeat(118));
for (const c of CASES) {
  const r = analyzeManualHand(checkedTo(['As', '5s'], c.villain), OPTIONS);
  if (!r.ok) continue;
  const pf = r.decision.diagnostics.postflop as unknown as Record<string, any> | undefined;
  const bd = (pf?.['betDecision'] ?? null) as Record<string, any> | null;
  if (bd === null) {
    console.log(pad(c.name, 30) + '（没有下注决策包）');
    continue;
  }
  const sizes = (bd['legalSizes'] ?? bd['sizes'] ?? []) as readonly Record<string, any>[];
  for (const s of sizes) {
    console.log(
      pad(c.name, 30) + pad(`${Number(s['betAmount'] ?? 0).toFixed(2)}`, 10) +
      pad(pct(s['foldLikelihood']), 9) + pad(pct(s['callLikelihood']), 9) + pad(pct(s['raiseLikelihood']), 9) +
      (s['betEV'] === null || s['betEV'] === undefined ? '—' : Number(s['betEV']).toFixed(1)),
    );
  }
  if (typeof bd['bestSize'] === 'string' || bd['bestSize'] === null) {
    console.log(`${''.padEnd(30)} ⇒ 引擎首选：${String(bd['bestSize'])}（amount ${String(bd['bestAmount'])}），过牌 EV=${String(bd['checkEV'] === null || bd['checkEV'] === undefined ? '—' : Number(bd['checkEV']).toFixed(1))}`);
  }
}
