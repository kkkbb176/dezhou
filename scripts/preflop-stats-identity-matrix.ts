/**
 * 多手牌 × 多形态矩阵：**绑上身份之后，实测统计的效应会不会消失？**
 *
 * 形态：
 *   ① 无（对照） ② 只有 stats ③ stats + 标签 ④ stats + 身份 ⑤ stats + 标签 + 身份
 *   ⑥ 只有身份    ⑦ 身份 + 标签
 *
 * 判据（机器可读）：
 *   · **② 必须 ≠ ①**（统计单独也要生效）
 *   · **④ 必须 = ②**（加身份不得改变「统计 + 无标签」的行为）
 *   · **⑤ 必须 = ③**（加身份不得改变「统计 + 标签」的行为）
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
const rule = (w = 148): string => '='.repeat(w);
const S9 = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

const TIGHT_STATS = {
  handsObserved: 2000, vpip: 0.105, pfr: 0.071, threeBet: 0.03, wtsd: 0.24,
  foldToFlopCBet: 0.72, foldToTurnCBet: 0.6, foldToRiverBet: 0.6,
  flopCheckRaise: 0.06, turnCheckRaise: 0.05, riverCheckRaise: 0.04,
} as const;

const ID = { seatId: 'seat_BB', persistentPlayerId: 'p_bb', stackBB: 100 } as const;
const FORMS: readonly { short: string; name: string; villain: Record<string, unknown> }[] = [
  { short: '①无', name: '① 什么都没有', villain: {} },
  { short: '②stats', name: '② 只有 stats', villain: { observedStats: TIGHT_STATS } },
  { short: '③st+标', name: '③ stats + 标签', villain: { observedStats: TIGHT_STATS, quickProfile: 'VERY_TIGHT' } },
  { short: '④st+身', name: '④ stats + 身份', villain: { observedStats: TIGHT_STATS, ...ID } },
  { short: '⑤st+标+身', name: '⑤ stats + 标签 + 身份', villain: { observedStats: TIGHT_STATS, quickProfile: 'VERY_TIGHT', ...ID } },
  { short: '⑥身份', name: '⑥ 只有身份', villain: { ...ID } },
  { short: '⑦身+标', name: '⑦ 身份 + 标签', villain: { quickProfile: 'VERY_TIGHT', ...ID } },
];

function threeBet(villain: Record<string, unknown>, hero: readonly [string, string]): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BTN', heroCards: hero, board: [], street: 'PREFLOP',
    effectiveStackBB: 100, bigBlindBB: 100, seatStacksBB: S9,
    actionHistory: [
      A('UTG', 'FOLD'), A('UTG1', 'FOLD'), A('UTG2', 'FOLD'), A('LJ', 'FOLD'), A('HJ', 'FOLD'),
      A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'RAISE', 9),
    ],
    environment: 'MID_LOW_STAKES', villain,
  } as unknown as ManualHandInput;
}

const HANDS: readonly (readonly [string, string])[] = [
  ['As', 'Ah'], ['Ks', 'Kh'], ['Js', 'Jh'], ['Ts', 'Th'], ['9s', '9h'],
  ['As', 'Ks'], ['As', 'Qs'], ['As', 'Js'], ['Ks', 'Qs'], ['As', '5s'], ['7s', '6s'],
];

/** 一个形态在一次决策下的机器可读指纹 */
function fingerprintOf(hero: readonly [string, string], villain: Record<string, unknown>): string {
  const r = analyzeManualHand(threeBet(villain, hero), OPTIONS);
  if (!r.ok) return `FAIL/${r.stage}`;
  const d: any = r.decision;
  const pr: any = d.diagnostics.preflopRaise ?? null;
  const sizes: any[] = pr?.sizes ?? [];
  const ev = sizes.length === 0 ? null : sizes[sizes.length - 1].raiseEV;
  const fold = sizes.length === 0 ? null : sizes[sizes.length - 1].foldLikelihood;
  return `${String(d.action)}@${d.sizeBB === undefined ? '—' : Number(d.sizeBB).toFixed(2)}|raEV=${ev === null ? '—' : Number(ev).toFixed(2)}|fold=${fold === null ? '—' : (fold * 100).toFixed(1)}`;
}

console.log(rule());
console.log('翻前：Hero BTN 开池 3BB → BB 3Bet 到 9BB → Hero 决策（对手 = 很紧的 2000 手实测）');
console.log(rule());
console.log(pad('手牌', 8) + FORMS.map((f) => pad(f.short, 20)).join(''));
console.log('-'.repeat(148));
const fails: string[] = [];
for (const hero of HANDS) {
  const cells = FORMS.map((f) => fingerprintOf(hero, f.villain));
  console.log(pad(`${hero[0]}${hero[1]}`, 8) + cells.map((c) => pad(c, 20)).join(''));
  if (cells[1] === cells[0]) fails.push(`${hero[0]}${hero[1]}：② 与 ① 相同 ⇒ 统计单独不生效`);
  if (cells[3] !== cells[1]) fails.push(`${hero[0]}${hero[1]}：④ ≠ ② ⇒ 加身份改变了「统计+无标签」的行为`);
  if (cells[4] !== cells[2]) fails.push(`${hero[0]}${hero[1]}：⑤ ≠ ③ ⇒ 加身份改变了「统计+标签」的行为`);
}

console.log('');
console.log(rule());
console.log('判据结果');
console.log(rule());
if (fails.length === 0) {
  console.log('✅ 全部满足：② ≠ ①（统计生效）、④ = ②、⑤ = ③（身份不影响统计效应）');
} else {
  for (const f of fails) console.log('❌ ' + f);
}
