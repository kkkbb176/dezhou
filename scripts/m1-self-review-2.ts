/**
 * M1 自审探针 #2（只读）—— 量化「下注范围层」的标签重标定
 *
 * 背景（自审发现 F1）：
 *   `betProbabilityByBand` 只读 `tendencies.effectiveDimensions`，**完全不读 `confidence`**
 *   （`bettingRange.ts:390`）；而 `effectiveDimensions` 是输入维度的**原样透传**
 *   （`betResponse.ts:432-437`）。
 *   ⇒ 修复前该层拿到的是**全强度**标签维度；修复后（有任何轴证据时）拿到的是
 *     「标签×0.35×(1−w) + 实测×w」⇒ **标签在这一层被重标定到 0.35**。
 *
 * 本探针要回答三个问题：
 *   Q1 阈值在哪：第一个观测出现时该层是否**跳变**（1 手 vs 0 手）？
 *   Q2 跳变幅度：bandRates / betMass / EqVsBetRange 变化多少？
 *   Q3 跳变归因：变化来自「实测证据」还是「标签被压到 0.35」？
 *      —— 判据：只给 VPIP（该层不消费 tightness）时，VPIP 取任何值结果都相同，
 *         且与「完全无统计」不同 ⇒ 变化 100% 来自标签重标定。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
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

const NO_AXIS = {
  handsObserved: 800, vpip: null, pfr: null, threeBet: null, wtsd: null,
  foldToFlopCBet: null, foldToTurnCBet: null, foldToRiverBet: null,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: null,
} as const;

const villain = (stats: Record<string, unknown> | null): ManualVillain => ({
  seatId: 'seat_BB', persistentPlayerId: 'p1', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100,
  ...(stats === null ? {} : { observedStats: stats as never }),
});

const line = (s = ''): void => console.log(s);
const rule = (w = 132): string => '='.repeat(w);
const n = (v: unknown, d = 6): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));

function factsOf(stats: Record<string, unknown> | null): Record<string, any> {
  const r = analyzeManualHand(test16(villain(stats)), OPTIONS);
  if (!r.ok) throw new Error(`分析失败：${r.stage}`);
  const dg = (r.decision as unknown as Record<string, any>)['diagnostics'] as Record<string, any>;
  const pf = (dg['postflop'] ?? {}) as Record<string, any>;
  const rr = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
  const note = String(rr?.['model']?.['noteZh'] ?? '');
  const g = (k: string): number => Number(new RegExp(`${k}\\s+([0-9.]+)`).exec(note)?.[1] ?? NaN);
  const br = pf['bettingRangeFacts'] as Record<string, any>;
  return {
    bandRates: br['bandRates'] as Record<string, number>,
    betMass: br['betMass'] as number,
    eqBet: (dg['math'] ?? {})['heroEquityVsBetRange'] as number,
    raiseEV: rr?.['raiseEV'] ?? null,
    foldScale: g('foldScale'), callScale: g('callScale'), raiseScale: g('raiseScale'),
  };
}

const BANDS = ['AIR', 'WEAK_PAIR', 'MIDDLE_PAIR', 'TOP_PAIR_WEAK', 'TOP_PAIR_GOOD', 'OVERPAIR', 'TWO_PAIR_PLUS', 'STRONG_MADE'];

/* ---------------- Q1/Q2：阈值与幅度 ---------------- */
line(rule());
line(' Q1/Q2 「下注范围层」在**第一个观测**出现时是否跳变（MANIAC 标签，只给 VPIP = 0.48）');
line(rule());
line('  ' + '样本'.padEnd(12) + 'betMass'.padStart(14) + 'EqVsBetRange'.padStart(18) + 'RAISE EV'.padStart(16) + '  foldScale');
const rows: Array<{ label: string; f: Record<string, any> }> = [];
rows.push({ label: '无统计（纯标签）', f: factsOf(null) });
for (const hands of [1, 2, 5, 20, 800, 5000]) {
  rows.push({ label: `VPIP·${hands} 手`, f: factsOf({ ...NO_AXIS, handsObserved: hands, vpip: 0.48 }) });
}
for (const r of rows) {
  line(`  ${r.label.padEnd(20)}${n(r.f.betMass, 12).padStart(14)}${n(r.f.eqBet, 16).padStart(18)}${n(r.f.raiseEV, 10).padStart(16)}${n(r.f.foldScale, 6).padStart(11)}`);
}
const labelOnly = rows[0]!.f;
const first = rows[1]!.f;
line('');
line(`  ⇒ 0 手 → 1 手：betMass ${n(labelOnly.betMass, 9)} → ${n(first.betMass, 9)}（Δ ${n(first.betMass - labelOnly.betMass, 9)}）`);
line(`     EqVsBetRange ${n(labelOnly.eqBet, 12)} → ${n(first.eqBet, 12)}（Δ ${n(first.eqBet - labelOnly.eqBet, 12)}）`);
line(`     1 手 → 800 手：betMass Δ ${n(rows[4]!.f.betMass - first.betMass, 12)}，1 手 → 5000 手：Δ ${n(rows[5]!.f.betMass - first.betMass, 12)}`);
const anyChangeFromFirst = rows.slice(2).some((r) => Math.abs(r.f.betMass - first.betMass) > 1e-12);
line(`  ⇒ 「1 手」到「5000 手」下注范围是否再变化：${anyChangeFromFirst ? '是（有实测敏感度）' : '**否（完全不变）** ⇒ 该层的全部变化发生在 0 → 1 手这一步'}`);

/* ---------------- Q3：归因 ---------------- */
line('');
line(rule());
line(' Q3 归因：只给 VPIP 时，改变 VPIP 值能否改变下注范围？（tightness 不被该层消费）');
line(rule());
const byVpip = [0.2, 0.35, 0.48, 0.9].map((v) => ({ v, f: factsOf({ ...NO_AXIS, handsObserved: 800, vpip: v }) }));
for (const r of byVpip) {
  line(`  VPIP ${r.v.toFixed(2)}：betMass ${n(r.f.betMass, 12)}｜EqVsBetRange ${n(r.f.eqBet, 16)}｜foldScale ${n(r.f.foldScale, 6)}（响应层**确实**变了）`);
}
const allSameBet = byVpip.every((r) => r.f.betMass === byVpip[0]!.f.betMass);
line(`  ⇒ 下注范围对 VPIP 取值是否敏感：${allSameBet ? '**完全不敏感**（四者逐位相同）' : '敏感'}`);
line(`  ⇒ 但相对纯标签：betMass ${n(labelOnly.betMass, 9)} → ${n(byVpip[0]!.f.betMass, 9)}（${((byVpip[0]!.f.betMass / labelOnly.betMass - 1) * 100).toFixed(1)}%）`);
line('');
line('  逐带对比（纯标签 vs VPIP=0.20 vs VPIP=0.90）：');
line('  ' + 'band'.padEnd(18) + '纯标签'.padStart(14) + 'VPIP 0.20'.padStart(14) + 'VPIP 0.90'.padStart(14));
for (const b of BANDS) {
  const a = labelOnly.bandRates[b]; const x = byVpip[0]!.f.bandRates[b]; const y = byVpip[3]!.f.bandRates[b];
  if (a === undefined && x === undefined) continue;
  line(`  ${b.padEnd(18)}${n(a, 9).padStart(14)}${n(x, 9).padStart(14)}${n(y, 9).padStart(14)}`);
}
line('');
line(rule());
line(' 结论（写进报告）：');
line('  ① `betProbabilityByBand` 不读 confidence ⇒ 「把 0.35 折进维度」在该层等价于把标签压到 0.35；');
line('  ② 跳变点 = 第一个观测（0 → 1 手），此后该层对实测**几乎不再敏感**（只经由四轴中被它消费的三轴）；');
line('  ③ 因此 M1 报告里「betMass 0.4724 → 0.3256 来自实测统计」的归因**只在响应层成立**，');
line('     下注范围层的变化主要来自标签重标定 —— 需人工裁决选项 A（该层改喂 resolvedDimensions）或选项 B（维持）。');
line(rule());
