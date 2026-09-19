/**
 * NODE DETERMINISM / ORDER DEPENDENCY AUDIT —— nodeB 确定性探针（§五）
 *
 * 目的：在**同一进程内**验证
 *   1. `nodeB` × 10 是否逐位一致（D1）
 *   2. `nodeA → nodeB` 是否与 `nodeB` 相同（D2）
 *   3. `03A → 03B → nodeB` 是否仍相同（D3）
 *   4. 反向 `nodeB → nodeA` 后 nodeB 基线是否不变（D4）
 * 并打印每次的**可审计中间量**（不只最终百分比，§二）。
 *
 * 用法：node --experimental-strip-types scripts/node-b-determinism-probe.ts
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const F = (position: string) => ({ position, type: 'FOLD' });

/** nodeA：6-max BTN A♥Q♣（review-hand-03 / profileRangeAdjustment T1 夹具） */
function nodeA(profile: string): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['Ah', 'Qc'],
    board: ['Qs', '8d', '3c', '6s', 'Ks'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      F('UTG'), F('HJ'),
      { position: 'CO', type: 'RAISE', amountBB: 2.5 },
      { position: 'BTN', type: 'CALL', amountBB: 2.5 },
      F('SB'), F('BB'),
      { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
      { position: 'BTN', type: 'CALL', amountBB: 2, street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 7, street: 'TURN' },
      { position: 'BTN', type: 'CALL', amountBB: 7, street: 'TURN' },
      { position: 'CO', type: 'BET', amountBB: 20, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

/** nodeB：9-max BB A♥9♥（门槛邻近节点；T2 夹具） */
function nodeB(profile: string): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BB', heroCards: ['Ah', '9h'],
    board: ['Kc', '9s', '5d', '2h', '7c'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, CO: 100, BTN: 100, BB: 100 },
    actionHistory: [
      F('UTG'), F('UTG1'), F('UTG2'), F('LJ'), F('HJ'), F('CO'),
      { position: 'BTN', type: 'RAISE', amountBB: 3 },
      F('SB'),
      { position: 'BB', type: 'CALL', amountBB: 2 },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'BTN', type: 'BET', amountBB: 1.5, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'BTN', type: 'CHECK', street: 'TURN' },
      { position: 'BB', type: 'CHECK', street: 'RIVER' },
      { position: 'BTN', type: 'BET', amountBB: 3, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

/** 03A/03B 黄金手（§十七）：9-max CO A♣J♥，Hero 转牌 check-back */
function golden(profile: string): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'CO', heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      F('UTG'), F('UTG1'), F('UTG2'), F('LJ'), F('HJ'),
      { position: 'CO', type: 'RAISE', amountBB: 2.5 },
      F('BTN'), F('SB'),
      { position: 'BB', type: 'CALL', amountBB: 1.5 },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'CO', type: 'CHECK', street: 'TURN' },
      { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

type Snapshot = {
  equity: number;
  required: number;
  callEV: number;
  winnable: number;
  action: string;
  margin: string | null;
  strongerShare: number | null;
  rangeSupport: number | null;
  updateTraceLen: number;
  rangeId: string | null;
};

/** 取一份可审计快照（不止最终百分比） */
function snap(mk: (p: string) => ManualHandInput, profile: string): Snapshot {
  const input = mk(profile);
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) throw new Error(`分析失败：${JSON.stringify(r.issues)}`);
  const m = r.decision.diagnostics.math;

  const parsed = parseManualInput(mk(profile));
  let strongerShare: number | null = null;
  let rangeSupport: number | null = null;
  let updateTraceLen = 0;
  let rangeId: string | null = null;
  if (parsed.ok) {
    const gate = buildAnalyzableState(parsed.value);
    if (gate.ok) {
      const b = buildDecisionContext({
        state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
        asOf: 1_757_000_000_000, quickProfile: profile,
      });
      const facts = b.context.postflopFacts?.opponentRangeFacts as unknown as
        | { strongerShare?: number; supportSize?: number }
        | undefined;
      strongerShare = facts?.strongerShare ?? null;
      rangeSupport = facts?.supportSize ?? null;
      updateTraceLen = b.context.range?.updateTrace.length ?? 0;
      rangeId = (b.context.range as unknown as { rangeId?: string } | null)?.rangeId ?? null;
    }
  }
  return {
    equity: m.heroEquity ?? NaN,
    required: m.requiredEquity,
    callEV: m.callEV ?? NaN,
    winnable: m.winnable,
    action: String(r.decision.action),
    margin: r.decision.diagnostics.decisionMargin?.kind ?? null,
    strongerShare, rangeSupport, updateTraceLen, rangeId,
  };
}

const pct = (x: number | null) => (x === null ? '—' : (x * 100).toFixed(4) + '%');
const line = (tag: string, s: Snapshot) =>
  `  ${tag.padEnd(34)} equity=${pct(s.equity).padStart(10)} req=${pct(s.required)} ` +
  `callEV=${s.callEV.toFixed(4).padStart(10)} action=${s.action.padEnd(5)} margin=${String(s.margin).padEnd(12)} ` +
  `stronger=${pct(s.strongerShare)} support=${String(s.rangeSupport)} trace=${s.updateTraceLen} rangeId=${s.rangeId}`;

const eq = (a: Snapshot, b: Snapshot) => JSON.stringify(a) === JSON.stringify(b);

console.log('================ §五-1  nodeB × 10（每次重建输入）================');
const ten: Snapshot[] = [];
for (let i = 0; i < 10; i += 1) ten.push(snap(nodeB, 'NORMAL'));
for (const [i, s] of ten.entries()) console.log(line(`run#${i + 1}`, s));
const d1 = ten.every((s) => eq(s, ten[0]!));
console.log(`  ⇒ D1 同输入 10 次一致：${d1 ? 'PASS' : 'FAIL'}`);

console.log('\n================ §五-2  前序节点污染测试 ================');
const baseline = snap(nodeB, 'NORMAL');
console.log(line('baseline（先测）', baseline));

for (const profile of ['VERY_TIGHT', 'UNDERBLUFFER', 'LOOSE', 'BLUFF_HEAVY', 'MANIAC']) {
  snap(nodeA, profile);
}
const afterA = snap(nodeB, 'NORMAL');
console.log(line('nodeA×5 → nodeB', afterA));
console.log(`  ⇒ D2 nodeA→nodeB 与 nodeB 相同：${eq(baseline, afterA) ? 'PASS' : 'FAIL'}`);

snap(golden, 'CALLING_STATION');
snap(golden, 'MANIAC');
const afterGolden = snap(nodeB, 'NORMAL');
console.log(line('03A→03B → nodeB', afterGolden));
console.log(`  ⇒ D3 03A→03B→nodeB 相同：${eq(baseline, afterGolden) ? 'PASS' : 'FAIL'}`);

// D4 反向：nodeB 先跑，再跑 nodeA，再回 nodeB
snap(nodeB, 'NORMAL');
snap(nodeA, 'MANIAC');
const afterReverse = snap(nodeB, 'NORMAL');
console.log(line('nodeB→nodeA → nodeB', afterReverse));
console.log(`  ⇒ D4 反向顺序后基线不变：${eq(baseline, afterReverse) ? 'PASS' : 'FAIL'}`);

console.log('\n================ 汇总 ================');
console.log(`  NODE_B_ISOLATED  = ${pct(baseline.equity)}  (action=${baseline.action}, margin=${baseline.margin})`);
console.log(`  NODE_B_AFTER_A   = ${pct(afterA.equity)}`);
console.log(`  NODE_B_AFTER_03  = ${pct(afterGolden.equity)}`);
console.log(`  NODE_B_REVERSE   = ${pct(afterReverse.equity)}`);
console.log(`  ALL IDENTICAL    = ${d1 && eq(baseline, afterA) && eq(baseline, afterGolden) && eq(baseline, afterReverse)}`);
