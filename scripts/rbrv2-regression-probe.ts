/** RIVER BET RANGE V2 —— 回归节点的口径诊断（只读） */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { PUBLIC_STRENGTH_BAND_ZH, PUBLIC_STRENGTH_BAND_ORDER } from '../src/app/manualInput/bettingRange.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const line = (s = ''): void => console.log(s);
const pct = (v: unknown, d = 2): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const p6 = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(6) : '—');
const pad = (s: string, n: number): string => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};

function run(input: ManualHandInput, seed: number, tag: string) {
  const parsed = parseManualInput(input);
  if (!parsed.ok) { line(`${tag}: PARSE FAIL ${JSON.stringify(parsed.issues[0])}`); return; }
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) { line(`${tag}: GATE FAIL ${JSON.stringify(gate.issues[0])}`); return; }
  const ctx = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: 1_757_000_000_000,
    quickProfile: input.villain?.quickProfile, equitySeed: seed,
  }).context as unknown as Record<string, any>;
  const ana = analyzeManualHand(input, { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: seed, budget: { softMs: 120_000, hardMs: 240_000 } });
  const m = ctx['math'] as Record<string, any>;
  const facts = ctx['postflopFacts'] as Record<string, any>;
  const bf = facts['bettingRangeFacts'];
  const arr = facts['betRangeArrival'];
  const orf = facts['opponentRangeFacts'];

  line(`==== ${tag} ====`);
  line(`  street=${ctx['board'].length} 张公共牌｜pot=${m['pot']}｜callCost=${m['callCost']}｜requiredEquity=${p6(m['requiredEquity'])}`);
  line(`  到达范围权益（V2 新口径）EqVsArrivalRange = ${p6(arr?.['heroEquityVsArrivalRange'])}（support ${arr?.['supportCount']}）`);
  line(`  下注范围权益              EqVsBetRange = ${p6(m['heroEquityVsBetRange'])}`);
  line(`  整体范围权益（链条含本街全部动作）heroEquity = ${p6(m['heroEquity'])}`);
  line(`  CALL EV = ${p6(m['callEV'])}｜动作=${String((ana.ok ? ana.decision : null)?.['action'])}`);
  if (bf) {
    line(`  下注占比 ${pct(bf['betShareOfArrival'], 3)}｜有效组合数 ${p6(bf['effectiveComboCount'])}｜尺寸比 ${p6(facts['betRangeSizing']?.['actualRatio'])}`);
    line(`  与 Hero 的关系（仅解释）：价值 ${pct(bf['classMasses']['valueMass'], 2)}｜摊牌 ${pct(bf['classMasses']['showdownMass'], 2)}｜诈唬 ${pct(bf['classMasses']['bluffMass'], 2)}`);
    line(`  ${pad('公共强度带', 26)}${pad('到达', 10)}${pad('P(BET)', 10)}${pad('下注', 10)}`);
    for (const b of PUBLIC_STRENGTH_BAND_ORDER) {
      line(`  ${pad(PUBLIC_STRENGTH_BAND_ZH[b], 26)}${pad(pct(bf['bandMasses']['arrival'][b], 2), 10)}${pad(p6(bf['bandRates'][b]), 10)}${pad(pct(bf['bandMasses']['bet'][b], 2), 10)}`);
    }
  } else {
    line('  （本节点没有下注范围）');
  }
  if (orf) {
    line(`  opponentRangeFacts（链条整体范围）：stronger ${pct(orf['strongerShare'], 2)}｜weaker ${pct(orf['weakerShare'], 2)}｜equal ${pct(orf['equalShare'], 2)}`);
  }
  line('');
}

/* TEST 4：9 人桌 HJ AA，面对 CO 冷四注后的转牌下注 */
run({
  tableSize: 9, heroPosition: 'HJ', heroCards: ['Ac', 'Ad'],
  board: ['Ks', '8d', '4c', 'Jc'], street: 'TURN',
  effectiveStackBB: 200, seatStacksBB: { UTG: 200, HJ: 200, CO: 200 },
  actionHistory: [
    { position: 'UTG', type: 'RAISE', amountBB: 3 }, { position: 'UTG1', type: 'FOLD' },
    { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
    { position: 'HJ', type: 'RAISE', amountBB: 10 }, { position: 'CO', type: 'RAISE', amountBB: 26 },
    { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' }, { position: 'BB', type: 'FOLD' },
    { position: 'UTG', type: 'FOLD' }, { position: 'HJ', type: 'CALL', amountBB: 16 },
    { position: 'HJ', type: 'CHECK', street: 'FLOP' }, { position: 'CO', type: 'BET', amountBB: 40, street: 'FLOP' },
    { position: 'HJ', type: 'CALL', amountBB: 40, street: 'FLOP' },
    { position: 'HJ', type: 'CHECK', street: 'TURN' }, { position: 'CO', type: 'BET', amountBB: 60, street: 'TURN' },
  ],
  environment: 'MID_LOW_STAKES', villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
} as unknown as ManualHandInput, 20260913, 'TEST 4（低 SPR AA vs 冷四注的转牌下注）');

/* TEST 09：Hero BB A♠J♠，BTN 河牌 120% 超池 */
const A = (position: string, type: string, amountBB?: number, street?: string) => ({
  position, type, ...(amountBB === undefined ? {} : { amountBB }), ...(street === undefined ? {} : { street }),
});
run({
  tableSize: 6, heroPosition: 'BB', heroCards: ['As', 'Js'],
  board: ['Jd', '8c', '4c', '6s', 'Kh'], street: 'RIVER',
  effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  actionHistory: [
    A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
    A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 4, 'FLOP'), A('BB', 'CALL', 4, 'FLOP'),
    A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 10.5, 'TURN'), A('BB', 'CALL', 10.5, 'TURN'),
    A('BB', 'CHECK', undefined, 'RIVER'), A('BTN', 'BET', 42.5, 'RIVER'),
  ],
  environment: 'MID_LOW_STAKES', villain: { quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN' },
} as unknown as ManualHandInput, 20260913, 'TEST 09 BR-2（Hero BB AJ，BTN 河牌超池）');

for (const profile of ['MANIAC', 'NORMAL', 'VERY_TIGHT']) {
  run({
    tableSize: 6, heroPosition: 'BB', heroCards: ['As', 'Js'],
    board: ['Jd', '8c', '4c', '6s', 'Kh'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 4, 'FLOP'), A('BB', 'CALL', 4, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 10.5, 'TURN'), A('BB', 'CALL', 10.5, 'TURN'),
      A('BB', 'CHECK', undefined, 'RIVER'), A('BTN', 'BET', 42.5, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES', villain: { quickProfile: profile, dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput, 20260913, `TEST 09 BR-2（画像 ${profile}）`);
}
