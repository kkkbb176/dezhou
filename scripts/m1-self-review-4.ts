/**
 * M1 自审探针 #4（只读）—— 「画像证据形态」× 「面对下注通道是否打开」矩阵
 *
 * 问题：`tendenciesForSeat` 的第一道门是 `playerBuilt.tendency === null ⇒ 中立`。
 * 那到底哪些证据形态能把实测统计送进面对下注层？
 *   A 完全无画像（无标签 / 无动态提示 / 无统计）
 *   B 只有实测统计（无标签、无动态提示）
 *   C 实测统计 + 有效动态提示（observation-only）
 *   D 实测统计 + 手选标签
 * 判据：生产自报的响应刻度（`raiseResponse.model.noteZh`）是否偏离 1.0000。
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
function test16(villain: ManualVillain): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'),
      A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2),
      A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2.5, 'FLOP'), A_('BB', 'CALL', 2.5, 'FLOP'),
      A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 7.5, 'TURN'), A_('BB', 'CALL', 7.5, 'TURN'),
      A_('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES', villain,
  } as unknown as ManualHandInput;
}

const STATS = {
  handsObserved: 800, vpip: 0.48, pfr: 0.35, threeBet: 0.16, wtsd: 0.36,
  foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
} as const;

const n = (v: unknown, d = 4): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));

function measure(v: ManualVillain): Record<string, any> {
  const r = analyzeManualHand(test16(v), OPTIONS);
  if (!r.ok) return { failed: r.stage, issues: r.issues } as never;
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  const pf = (dg['postflop'] ?? {}) as Record<string, any>;
  const rr = pf['raiseResponse'] as Record<string, any>;
  const nm = String(rr?.['model']?.['noteZh'] ?? '');
  const g = (k: string): number => Number(new RegExp(`${k}\\s+([0-9.]+)`).exec(nm)?.[1] ?? NaN);
  return {
    action: `${String(d['action'])} @ ${String(d['sizeChips'])}`,
    scales: `${n(g('callScale'))}/${n(g('foldScale'))}/${n(g('raiseScale'))}`,
    raw: [g('callScale'), g('foldScale'), g('raiseScale')],
    betMass: pf['bettingRangeFacts']?.['betMass'] ?? null,
    eqBet: (dg['math'] ?? {})['heroEquityVsBetRange'] ?? null,
    raiseEV: rr?.['raiseEV'] ?? null,
    callEV: (dg['math'] ?? {})['callEV'] ?? null,
    warnings: (r.warnings as readonly string[]).length,
  };
}

const base = { seatId: 'seat_BB', persistentPlayerId: 'p1', stackBB: 100 };
const cases: Array<[string, ManualVillain]> = [
  ['A 完全无画像', { ...base, dynamicHint: 'UNKNOWN' }],
  ['B 只有实测统计', { ...base, observedStats: STATS }],
  ['C 统计 + 动态提示', { ...base, dynamicHint: 'TILT_SIGNAL', observedStats: STATS }],
  ['D 统计 + 手选标签', { ...base, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', observedStats: STATS }],
  ['D0 只有手选标签', { ...base, quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN' }],
];

console.log('\n=== M1 探针 #4：证据形态 × 面对下注通道是否打开（响应刻度是否偏离 1.0000）===');
console.log('  ' + '情形'.padEnd(20) + '动作'.padEnd(12) + 'call/fold/raise 刻度'.padEnd(24) + 'betMass'.padStart(14) + 'EqVsBetRange'.padStart(18) + 'RAISE EV'.padStart(13));
for (const [label, v] of cases) {
  const m = measure(v);
  if ('failed' in m) { console.log(`  ${label.padEnd(20)}失败：${String(m['failed'])}`); continue; }
  console.log(`  ${label.padEnd(20)}${String(m['action']).padEnd(12)}${String(m['scales']).padEnd(24)}${n(m['betMass'], 9).padStart(14)}${n(m['eqBet'], 12).padStart(18)}${n(m['raiseEV'], 4).padStart(13)}`);
}
const a = measure(cases[0]![1]);
const b = measure(cases[1]![1]);
const c = measure(cases[2]![1]);
console.log('');
console.log(`  ⇒ B（只有统计）与 A（完全无画像）刻度是否相同：${JSON.stringify(b['raw']) === JSON.stringify(a['raw']) ? '**相同 ⇒ 通道未打开**' : '不同 ⇒ 通道已打开'}`);
console.log(`     B 的 betMass/RAISE EV：${n(b['betMass'], 9)} / ${n(b['raiseEV'], 4)}；A：${n(a['betMass'], 9)} / ${n(a['raiseEV'], 4)}`);
console.log(`  ⇒ C（统计 + 动态提示）刻度：${String(c['scales'])}（偏离 1.0000 ⇒ 通道已打开）`);
console.log(`  ⇒ 结论：**「无标签 + 无动态提示 + 只有实测统计」这一形态下，M1 通道完全关闭**（`+'`playerBuilt.tendency === null`'+` 提前返回中立）。`);
console.log('');
