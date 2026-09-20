/**
 * flriver-gent2-probe3 · READ-ONLY (Agent 3): user-visible surface + remaining checks
 *
 * 1) sweep failure identification (are all 32 failures my own card conflicts?)
 * 2) viewModel debug dump: what the user actually sees for
 *    (a) river value-bet node, (b) low-SPR ALL_IN-node, (c) 120% overbet node
 *    → search the rendered text for 'SIZE_APPROXIMATION', '建模', '尺寸 undefined'
 * 3) river overbet node WITH a raise candidate (raise-response model vs 120% pot)
 * 4) deep-stack river hero-bet node: the maximum pot ratio available in the candidate grid
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, ManualVillain } from '../src/app/manualInput/manualInput.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(),
  asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_260_913, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const A_ = (p: string, t: string, bb?: number, s?: string): Record<string, unknown> => ({
  position: p, type: t, ...(bb === undefined ? {} : { amountBB: bb }), ...(s === undefined ? {} : { street: s }),
});
const V_ = (q: string): ManualVillain => ({ quickProfile: q, dynamicHint: 'UNKNOWN', stackBB: 100 } as ManualVillain);
const num = (x: unknown, d = 3): string => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : String(x));
const J = (x: unknown): string => JSON.stringify(x, null, 1);
const base = {
  tableSize: 6, heroPosition: 'BTN', effectiveStackBB: 100, bigBlindBB: 2,
  seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
  environment: 'MID_LOW_STAKES',
} as const;
const base20 = { ...base, effectiveStackBB: 20, seatStacksBB: { UTG: 20, HJ: 20, CO: 20, BTN: 20, SB: 20, BB: 20 } } as const;
const PRE_BTN = [A_('UTG', 'FOLD'), A_('HJ', 'FOLD'), A_('CO', 'FOLD'), A_('BTN', 'RAISE', 3), A_('SB', 'FOLD'), A_('BB', 'CALL', 2)];

/* ============ 1) sweep failure identification ============ */
console.log('='.repeat(90));
console.log('=== 1) SWEEP CONFIG FAILURES ===');
console.log('='.repeat(90));
const BOARDS: readonly (readonly [string, readonly string[]])[] = [
  ['flopK94', ['Kd', '9c', '4h']], ['flopTs8s2h', ['Ts', '8s', '2h']], ['flopQcJd5d', ['Qc', 'Jd', '5d']],
  ['riverK94_6s2d', ['Kd', '9c', '4h', '6s', '2d']], ['riverTs8s2h_Jc3d', ['Ts', '8s', '2h', 'Jc', '3d']],
];
const HANDS: ReadonlyArray<readonly [string, readonly [string, string]]> = [
  ['AKs', ['As', 'Ks']], ['AA', ['As', 'Ah']], ['99', ['9h', '9c']], ['76s', ['7s', '6s']], ['QJs', ['Qs', 'Js']],
];
function hist(street: 'FLOP' | 'RIVER', mode: 'IP' | 'OOP' | 'FACE', betBB: number): Record<string, unknown>[] {
  const h: Record<string, unknown>[] = [...PRE_BTN];
  if (street === 'FLOP') {
    if (mode === 'FACE') h.push(A_('BB', 'BET', betBB, 'FLOP'));
    else if (mode === 'IP') h.push(A_('BB', 'CHECK', undefined, 'FLOP'));
    return h;
  }
  h.push(A_('BB', 'CHECK', undefined, 'FLOP'));
  if (mode !== 'OOP') h.push(A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'));
  if (mode === 'OOP') { h.push(A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'CHECK', undefined, 'TURN')); return h; }
  h.push(A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'));
  if (mode === 'FACE') h.push(A_('BB', 'BET', betBB, 'RIVER'));
  else h.push(A_('BB', 'CHECK', undefined, 'RIVER'));
  return h;
}
const failCodes = new Map<string, number>();
let nFail = 0;
for (const street of ['FLOP', 'RIVER'] as const) {
  for (const mode of ['IP', 'OOP', 'FACE'] as const) {
    for (const [hn, hc] of HANDS) {
      for (const [bn, bd] of BOARDS) {
        if (street === 'FLOP' && !bn.startsWith('flop')) continue;
        if (street === 'RIVER' && !bn.startsWith('river')) continue;
        for (const profile of mode === 'FACE' ? ['NORMAL', 'MANIAC'] : ['NORMAL']) {
          for (const betBB of mode === 'FACE' ? [5, 10, 44] : [0]) {
            const input = { ...base, heroCards: [...hc], board: [...bd], street, actionHistory: hist(street, mode, betBB), villain: V_(profile) } as unknown as ManualHandInput;
            const r = analyzeManualHand(input, OPTIONS);
            if (r.ok) continue;
            nFail++;
            const codes = (r.issues as readonly Record<string, unknown>[]).map((x) => String(x['code'])).join(',');
            failCodes.set(`${r.stage}:${codes}`, (failCodes.get(`${r.stage}:${codes}`) ?? 0) + 1);
          }
        }
      }
    }
  }
}
console.log(`failures = ${nFail}`);
for (const [k, v] of failCodes) console.log(`  ${k} = ${v}`);

/* ============ 3+4) overbet with raise candidate, and deep-stack bet grid ============ */
const cases: Array<readonly [string, ManualHandInput]> = [
  ['3) 河牌面对 120% 超池 + AA（有加注候选）',
    { ...base, heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [...PRE_BTN, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'BET', 44, 'RIVER')], villain: V_('NORMAL') } as unknown as ManualHandInput],
  ['4) 河牌后位无人下注 AK（深筹码 ⇒ 候选网格最大比例）',
    { ...base, heroCards: ['As', 'Ks'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [...PRE_BTN, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'CHECK', undefined, 'RIVER')], villain: V_('NORMAL') } as unknown as ManualHandInput],
];
for (const [tag, input] of cases) {
  console.log(`\n${'='.repeat(90)}\n### ${tag}\n${'='.repeat(90)}`);
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { console.log(`FAILED ${r.stage} ${J(r.issues)}`); continue; }
  const d = r.decision as unknown as Record<string, any>;
  const dx = d['diagnostics'] as Record<string, any>;
  const math = dx['math'] as Record<string, any>;
  console.log(`action=${String(d['action'])} size=${num(d['sizeChips'], 3)} | pot=${num(math['pot'])} callCost=${num(math['callCost'])}`);
  console.log('reasons:'); for (const rs of (d['reasons'] as readonly Record<string, any>[]) ?? []) console.log(`  [${String(rs['code'])}] ${String(rs['textZh'])}`);
  console.log(`betRangeArrival=${J(dx['postflop']?.['betRangeArrival'])}`);
  console.log(`bettingRangeFacts.noteZh=${String(dx['postflop']?.['bettingRangeFacts']?.['noteZh'] ?? '—')}`);
  console.log(`bettingRangeFacts.classMasses=${J(dx['postflop']?.['bettingRangeFacts']?.['classMasses'])}`);
  console.log(`raiseResponse.sizeChips=${num(dx['postflop']?.['raiseResponse']?.['sizeChips'])} model.ratioToPot=${num(dx['postflop']?.['raiseResponse']?.['model']?.['ratioToPot'])} raiseEV=${num(dx['postflop']?.['raiseResponse']?.['raiseEV'])}`);
  console.log(`raiseResponse.noteZh=${String(dx['postflop']?.['raiseResponse']?.['noteZh'] ?? '—')}`);
  console.log(`candidates (action/size/note):`);
  for (const c of (dx['candidates'] as readonly Record<string, any>[]) ?? []) {
    const ratio = typeof c['sizeChips'] === 'number' && math['pot'] > 0 ? (c['sizeChips'] as number) / (math['pot'] as number) : null;
    console.log(`   ${String(c['action'])} size=${num(c['sizeChips'], 3)} size/pot=${ratio === null ? '—' : num(ratio, 3)} note=${String(c['noteZh'])}`);
  }
}

/* ============ 2) viewModel user-visible dump ============ */
const vmCases: Array<readonly [string, ManualHandInput]> = [
  ['2a) 河牌后位对手过牌 AK（取值节点）',
    { ...base, heroCards: ['As', 'Ks'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [...PRE_BTN, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'CHECK', undefined, 'RIVER')], villain: V_('NORMAL') } as unknown as ManualHandInput],
  ['2b) 20BB 河牌后位对手过牌 AA（ALL_IN 异常节点）',
    { ...base20, heroCards: ['As', 'Ah'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [...PRE_BTN, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 2, 'FLOP'), A_('BB', 'CALL', 2, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 4, 'TURN'), A_('BB', 'CALL', 4, 'TURN'), A_('BB', 'CHECK', undefined, 'RIVER')], villain: V_('NORMAL') } as unknown as ManualHandInput],
  ['2c) 河牌面对 120% 超池 AK',
    { ...base, heroCards: ['As', 'Ks'], board: ['Ad', '9c', '4h', '6s', '2d'], street: 'RIVER', actionHistory: [...PRE_BTN, A_('BB', 'CHECK', undefined, 'FLOP'), A_('BTN', 'BET', 4, 'FLOP'), A_('BB', 'CALL', 4, 'FLOP'), A_('BB', 'CHECK', undefined, 'TURN'), A_('BTN', 'BET', 10, 'TURN'), A_('BB', 'CALL', 10, 'TURN'), A_('BB', 'BET', 44, 'RIVER')], villain: V_('NORMAL') } as unknown as ManualHandInput],
];
for (const [tag, input] of vmCases) {
  console.log(`\n${'='.repeat(90)}\n### VIEWMODEL ${tag}\n${'='.repeat(90)}`);
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { console.log(`FAILED ${r.stage}`); continue; }
  const vm = r.viewModel as unknown as Record<string, any>;
  const dbg = vm['debug'] as Record<string, any>;
  console.log(`actionZh=${String(vm['actionZh'])} sizeZh=${String(vm['sizeZh'])}`);
  console.log(`warnings=${J(vm['warningsZh'])}`);
  console.log(`debug groups=${Object.keys(dbg).join(', ')}`);
  for (const [g, rows] of Object.entries(dbg)) {
    if (Array.isArray(rows)) {
      console.log(`--- ${g} ---`);
      for (const row of rows as readonly Record<string, any>[]) console.log(`  [${String(row['label'])}] ${String(row['value'])}`);
    } else {
      console.log(`--- ${g} --- = ${J(rows)}`);
    }
  }
  const all = JSON.stringify(vm);
  console.log(`vm contains "SIZE_APPROXIMATION"? ${all.includes('SIZE_APPROXIMATION')}`);
  console.log(`vm contains "建模"? ${all.includes('建模')}`);
  console.log(`vm contains "尺寸 undefined"? ${all.includes('尺寸 undefined')}`);
  console.log(`vm contains "尺寸 BET_"? ${all.includes('尺寸 BET_')}`);
  console.log(`vm contains "全下（= 剩余筹码）"? ${all.includes('全下')}`);
}
console.log('\nDONE flriver-gent2-probe3');
