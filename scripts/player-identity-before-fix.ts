/**
 * PLAYER IDENTITY ROUTING V1 · **修复前复现**（只读、一次性证据脚本）
 *
 * 用**当前代码**回答三个问题：
 *  ① TEST 16 的 `playerId: '阿豪'`（名字）与 `'seat_BB'`（座位 id）是否给出不同结果？
 *  ② 差异是从哪一环产生的？（画像 provider 有没有进范围链）
 *  ③ 生产是否为这个回退发过任何 warning？
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A = (position: string, type: string, amountBB?: number, street?: string): Record<string, unknown> => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

const STATS = {
  handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
  foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
} as const;

function test16(villain: ManualVillain): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
      A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain,
  } as unknown as ManualHandInput;
}

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 9): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));

const CASES: [string, ManualVillain][] = [
  ['名字（TEST 16 原样）= 阿豪', { playerId: '阿豪', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: STATS }],
  ['座位 id = seat_BB', { playerId: 'seat_BB', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: STATS }],
  ['不给 id（只有画像）', { quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: STATS }],
  ['名字 + UNKNOWN 标签', { playerId: '阿豪', quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN', stackBB: 100 }],
];

line('='.repeat(120));
line(' ① 身份字符串如何影响生产输出（当前代码）');
line('='.repeat(120));
line('  ' + 'villain.playerId'.padEnd(26) + 'betMass'.padStart(12) + 'EqVsBetRange'.padStart(15) +
  'P(弃)/(跟)/(再加)'.padStart(28) + 'RAISE EV'.padStart(12) + 'profileRange 证据'.padStart(18));
for (const [tag, villain] of CASES) {
  const r = analyzeManualHand(test16(villain), OPTIONS);
  if (!r.ok) { line(`  ${tag}：分析失败 ${r.stage}`); continue; }
  const dg = (r.decision as unknown as Record<string, any>)['diagnostics'] as Record<string, any>;
  const pf = (dg['postflop'] ?? {}) as Record<string, any>;
  const br = (pf['bettingRangeFacts'] ?? null) as Record<string, any> | null;
  const rf = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
  const pr = (dg['profileRange'] ?? null) as Record<string, any> | null;
  line('  ' + tag.padEnd(26) + n(br?.['betMass'], 6).padStart(12) + n((dg['math'] ?? {})['heroEquityVsBetRange'], 9).padStart(15) +
    (rf === null ? '—' : `${n(rf['foldLikelihood'], 4)}/${n(rf['callLikelihood'], 4)}/${n(rf['reRaiseLikelihood'], 4)}`).padStart(28) +
    n(rf?.['raiseEV'], 4).padStart(12) +
    (pr === null ? '**null（画像未进范围）**' : `${String(pr['dimensionTier'])} Δ${n(pr['equityDeltaPct'], 4)}pp`).padStart(18) +
    `  warnings=${(r.warnings as readonly string[]).length}`);
}

line('');
line(' ② 生产是否为「身份字符串没匹配上座位」发过警告？');
for (const [tag, villain] of CASES) {
  const r = analyzeManualHand(test16(villain), OPTIONS);
  if (!r.ok) continue;
  line(`  · ${tag}：warnings = ${JSON.stringify(r.warnings)}`);
}
line('');
line(' 结论（当前代码）：`villainId` 既是「引擎口径座位 id」又是「画像稳定 id」，');
line('   调用方给名字时 `opponent.id === villainId` 恒为 false ⇒ 画像 provider 与行为画像**整体未注入范围链**，');
line('   且**没有任何 warning**。');
line('='.repeat(120));
