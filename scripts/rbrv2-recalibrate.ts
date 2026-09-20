/** RIVER BET RANGE V2 —— T2 / T13 回归节点重标定（只读） */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: 20260913, budget: { softMs: 120_000, hardMs: 240_000 } } as const;
const A = (position: string, type: string, amountBB?: number, street?: string) => ({
  position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }),
});
const F = (position: string) => A(position, 'FOLD');

/** 与 test/profileRangeAdjustment.test.ts 的 nodeB 逐字一致 */
function nodeB(profile: string, extra: Record<string, unknown> = {}): ManualHandInput {
  const flopBet = 1.5;
  const riverBet = 3;
  return {
    tableSize: 9,
    heroPosition: 'BB',
    heroCards: ['Ah', '9h'],
    board: ['Kc', '9s', '5d', '2h', '7c'],
    street: 'RIVER',
    effectiveStackBB: 100,
    seatStacksBB: { UTG: 100, CO: 100, BTN: 100, BB: 100 },
    actionHistory: [
      F('UTG'), F('UTG1'), F('UTG2'), F('LJ'), F('HJ'), F('CO'),
      A('BTN', 'RAISE', 3), F('SB'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', flopBet, 'FLOP'), A('BB', 'CALL', flopBet, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'CHECK', undefined, 'TURN'),
      A('BB', 'CHECK', undefined, 'RIVER'), A('BTN', 'BET', riverBet, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100, ...extra },
  } as unknown as ManualHandInput;
}

const line = (s = ''): void => console.log(s);
const pad = (s: string, n: number): string => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};
const p6 = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(6) : '—');

line('=== T2 节点：四个画像（nodeB） ===');
line(pad('画像', 16) + pad('到达权益', 14) + pad('下注范围权益', 16) + pad('整体权益', 14) + pad('所需', 10) + pad('CALL EV', 14) + pad('动作', 8) + '诈唬质量');
for (const profile of ['NORMAL', 'VERY_TIGHT', 'BLUFF_HEAVY', 'MANIAC']) {
  const r = analyzeManualHand(nodeB(profile), OPTIONS);
  if (!r.ok) { line(`${profile}: FAIL ${r.stage}`); continue; }
  const d = r.decision as unknown as Record<string, any>;
  const math = (d['diagnostics'] as any)['math'];
  const pf = (d['diagnostics'] as any)['postflop'];
  const arr = pf?.['betRangeArrival'];
  const bf = pf?.['bettingRangeFacts'];
  line(pad(profile, 16) + pad(p6(arr?.['heroEquityVsArrivalRange']), 14) + pad(p6(math['heroEquityVsBetRange']), 16) +
    pad(p6(math['heroEquity']), 14) + pad(p6(math['requiredEquity']), 10) + pad(p6(math['callEV']), 14) +
    pad(String(d['action']), 8) + p6(bf?.['classMasses']?.['bluffMass']));
}

line('');
line('=== 逐带构成（nodeB：NORMAL / BLUFF_HEAVY / MANIAC） ===');
{
  const { buildDecisionContext } = await import('../src/app/manualInput/contextBuilder.ts');
  const { parseManualInput } = await import('../src/app/manualInput/manualInput.ts');
  const { buildAnalyzableState } = await import('../src/app/manualInput/reconstruct.ts');
  const { PUBLIC_STRENGTH_BAND_ORDER, PUBLIC_STRENGTH_BAND_ZH } = await import('../src/app/manualInput/bettingRange.ts');
  for (const profile of ['NORMAL', 'BLUFF_HEAVY', 'MANIAC']) {
    const parsed = parseManualInput(nodeB(profile));
    if (!parsed.ok) continue;
    const gate = buildAnalyzableState(parsed.value);
    if (!gate.ok) continue;
    const ctx = buildDecisionContext({
      state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
      quickProfile: profile as never, equitySeed: 20260913,
    }).context as unknown as Record<string, any>;
    const bf = (ctx['postflopFacts'] as any)?.['bettingRangeFacts'];
    line(`  --- ${profile}（下注占比 ${p6(bf?.['betShareOfArrival'])}）---`);
    for (const b of PUBLIC_STRENGTH_BAND_ORDER) {
      line(`    ${pad(PUBLIC_STRENGTH_BAND_ZH[b], 24)}到达 ${p6(bf?.['bandMasses']?.['arrival']?.[b])}｜P(BET) ${p6(bf?.['bandRates']?.[b])}｜下注 ${p6(bf?.['bandMasses']?.['bet']?.[b])}`);
    }
  }
}

line('');
line('=== T13 边缘节点：搜索 betRangeBluffShareOverride（目标：|callEV| ≤ 容差带） ===');
line(pad('override', 12) + pad('CALL EV', 14) + pad('带', 12) + pad('margin', 24) + pad('动作', 8) + '置信度');
for (const override of [0, 0.2, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
  const r = analyzeManualHand(nodeB('NORMAL', { betRangeBluffShareOverride: override }), OPTIONS);
  if (!r.ok) { line(`${override}: FAIL`); continue; }
  const d = r.decision as unknown as Record<string, any>;
  const margin = (d['diagnostics'] as any)['decisionMargin'];
  const math = (d['diagnostics'] as any)['math'];
  line(pad(String(override), 12) + pad(p6(math['callEV']), 14) + pad(p6(margin?.['bandChips']), 12) +
    pad(String(margin?.['kind']), 24) + pad(String(d['action']), 8) + String((d['diagnostics'] as any)['postflop']?.['confidence']));
}

line('');
line('=== TEST 4 节点（HJ AA vs 冷四注转牌下注） ===');
{
  const r = analyzeManualHand({
    tableSize: 9, heroPosition: 'HJ', heroCards: ['Ac', 'Ad'],
    board: ['Ks', '8d', '4c', 'Jc'], street: 'TURN',
    effectiveStackBB: 200, seatStacksBB: { UTG: 200, HJ: 200, CO: 200 },
    actionHistory: [
      A('UTG', 'RAISE', 3), F('UTG1'), F('UTG2'), F('LJ'),
      A('HJ', 'RAISE', 10), A('CO', 'RAISE', 26), F('BTN'), F('SB'), F('BB'),
      A('UTG', 'FOLD'), A('HJ', 'CALL', 16),
      A('HJ', 'CHECK', undefined, 'FLOP'), A('CO', 'BET', 40, 'FLOP'), A('HJ', 'CALL', 40, 'FLOP'),
      A('HJ', 'CHECK', undefined, 'TURN'), A('CO', 'BET', 60, 'TURN'),
    ],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput, OPTIONS);
  if (r.ok) {
    const d = r.decision as unknown as Record<string, any>;
    const m = (d['diagnostics'] as any)['math'];
    const pf = (d['diagnostics'] as any)['postflop'];
    line(`  到达权益 ${p6(pf?.['betRangeArrival']?.['heroEquityVsArrivalRange'])}｜下注范围权益 ${p6(m['heroEquityVsBetRange'])}｜整体 ${p6(m['heroEquity'])}｜所需 ${p6(m['requiredEquity'])}｜CALL EV ${p6(m['callEV'])}｜动作 ${String(d['action'])}`);
    line(`  理由：${((d['reasons'] ?? []) as any[]).slice(0, 4).map((x) => x.code).join(', ')}`);
  } else line(`  FAIL ${r.stage}`);
}
