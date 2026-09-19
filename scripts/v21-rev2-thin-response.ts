/**
 * REV2 探针 ④：THIN_VALUE 的 manual 通道攻击（item 4）
 *              + 真实下注比例与尺寸档（item 6）
 *              + 响应模型对尺寸的单调性（item 6，需要 Hero 有下注权的节点）
 *
 * 用法：node --experimental-strip-types scripts/v21-rev2-thin-response.ts
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { BetSizeBucketOf, behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { betRatioOf } from '../src/app/manualInput/likelihoodModel.ts';
import { computePot } from '../src/domain/poker/gameState.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;
const SEATS = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };

type Manual = Record<string, 'VERY_LOW' | 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH'>;
type Case = {
  label: string;
  archetype: string | null;
  manual?: Manual;
  riverAction: { position: string; type: string; amountBB?: number };
};

function handOf(c: Case): ManualHandInput {
  const h: Record<string, unknown>[] = [
    { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' }, { position: 'UTG2', type: 'FOLD' },
    { position: 'LJ', type: 'FOLD' }, { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'RAISE', amountBB: 2.5 },
    { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
    { position: 'BB', type: 'CALL', amountBB: 1.5 },
    { position: 'BB', type: 'CHECK', street: 'FLOP' },
    { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
    { position: 'BB', type: 'CHECK', street: 'TURN' },
    { position: 'CO', type: 'CHECK', street: 'TURN' },
    { ...c.riverAction, street: 'RIVER' },
  ];
  const villain: Record<string, unknown> = { stackBB: 100 };
  if (c.archetype !== null) villain['quickProfile'] = c.archetype;
  if (c.manual !== undefined) {
    villain['behaviorProfile'] = behaviorProfileOf({
      playerId: 'BB',
      archetype: (c.archetype ?? null) as never,
      manual: c.manual,
    });
  }
  return {
    tableSize: 9, heroPosition: 'CO', heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS },
    actionHistory: h, environment: 'MID_LOW_STAKES', villain,
  } as unknown as ManualHandInput;
}

type Row = Record<string, unknown>;
const pct = (v: unknown, d = 2): string => (typeof v === 'number' ? `${(v * 100).toFixed(d)}%` : '—');
const num = (v: unknown, d = 3): string => (typeof v === 'number' ? v.toFixed(d) : '—');

function run(c: Case): { row: Row; masses: Row | null; node: string; profileApplied: boolean | null; ratio: number | null; pot: number | null } {
  const input = handOf(c);
  const out = analyzeManualHand(input, OPTIONS);
  const row: Row = { label: c.label, ok: out.ok };
  if (!out.ok) { row['issues'] = JSON.stringify(out.issues); return { row, masses: null, node: '', profileApplied: null, ratio: null, pot: null }; }
  const m = out.decision.diagnostics.math;
  row['action'] = out.decision.action; row['equity'] = m.heroEquity;
  row['requiredEquity'] = m.requiredEquity; row['callEV'] = m.callEV;
  const post = out.decision.diagnostics.postflop as unknown as Row;
  const bd = (post?.['betDecision'] ?? null) as Row | null;
  row['sizes'] = bd === null ? null : (bd['sizes'] as Row[]);

  let masses: Row | null = null; let node = ''; let profileApplied: boolean | null = null;
  let ratio: number | null = null; let pot: number | null = null;
  const parsed = parseManualInput(input);
  if (parsed.ok) {
    const gate = buildAnalyzableState(parsed.value);
    if (gate.ok) {
      const riverAction = gate.state.actions.filter((a) => a.street === 'RIVER' && a.amount > 0).at(-1);
      if (riverAction !== undefined) {
        const totalPot = computePot(gate.state);
        pot = totalPot - riverAction.amount;
        ratio = betRatioOf(riverAction.amount, pot) ?? null;
      }
      const built = buildDecisionContext({
        state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
        asOf: 1_757_000_000_000, budget: { softMs: 120_000, hardMs: 240_000 }, equitySeed: 20260913,
        ...(c.archetype === null ? {} : { quickProfile: c.archetype as never }),
        ...(c.manual === undefined ? {} : { behaviorProfile: behaviorProfileOf({ playerId: 'BB', archetype: (c.archetype ?? null) as never, manual: c.manual }) }),
      });
      const facts = built.context.postflopFacts?.opponentRangeFacts as unknown as Row | null;
      masses = (facts?.['profileClassMasses'] as Row | undefined) ?? null;
      node = String((built.context.range?.updateTrace ?? []).filter((t) => (t as Row)['street'] === 'RIVER').map((t) => (t as Row)['noteZh']).join(' '));
      profileApplied = (built.context.profileRangeEvidence as unknown as Row | undefined)?.['provider'] !== undefined
        ? ((built.context.profileRangeEvidence as unknown as Row)['provider'] as Row)['applied'] === true
        : null;
    }
  }
  return { row, masses, node, profileApplied, ratio, pot };
}

console.log('################ A. 真实下注比例与尺寸档（item 6）################');
for (const amount of [3.42, 7, 7.125, 14.63, 30]) {
  const r = run({ label: `BB bet ${amount}`, archetype: null, riverAction: { position: 'BB', type: 'BET', amountBB: amount } });
  const bucket = r.ratio === null ? '—' : BetSizeBucketOf(r.ratio);
  const traceBucket = /(TURN_CHECK_BACK|TURN_BET_CALL)\/(SMALL|MEDIUM|LARGE|OVERBET)/.exec(r.node)?.[2] ?? '?';
  console.log(
    `  amountBB=${String(amount).padEnd(6)} potBefore=${num(r.pot, 3)} 比例=${num(r.ratio, 6)} ⇒ BetSizeBucketOf=${bucket.padEnd(8)}` +
      ` 引擎 trace 档=${traceBucket} 权益=${pct(r.row['equity'])} 所需=${pct(r.row['requiredEquity'])} callEV=${num(r.row['callEV'], 3)}`,
  );
}
console.log('  ⇒ 参考手（BB bet 7）的真实比例约为 0.737 ⇒ **LARGE**，不是 36%。');

console.log('\n################ B. THIN_VALUE：manual thinValueBet 攻击（item 4）################');
console.log('标签              手动thin  动作   权益      所需      callEV    thin质量  价值质量  strong  showdown 空air  mF/mS/mC      画像进范围');
const cases: Case[] = [
  { label: 'neutral', archetype: null, riverAction: { position: 'BB', type: 'BET', amountBB: 7 } },
  { label: 'neutral+thinLOW', archetype: null, manual: { thinValueBet: 'VERY_LOW' }, riverAction: { position: 'BB', type: 'BET', amountBB: 7 } },
  { label: 'neutral+thinHIGH', archetype: null, manual: { thinValueBet: 'VERY_HIGH' }, riverAction: { position: 'BB', type: 'BET', amountBB: 7 } },
  { label: 'CS', archetype: 'CALLING_STATION', riverAction: { position: 'BB', type: 'BET', amountBB: 7 } },
  { label: 'CS+thinLOW', archetype: 'CALLING_STATION', manual: { thinValueBet: 'VERY_LOW' }, riverAction: { position: 'BB', type: 'BET', amountBB: 7 } },
  { label: 'CS+thinHIGH', archetype: 'CALLING_STATION', manual: { thinValueBet: 'VERY_HIGH' }, riverAction: { position: 'BB', type: 'BET', amountBB: 7 } },
  { label: 'MANIAC', archetype: 'MANIAC', riverAction: { position: 'BB', type: 'BET', amountBB: 7 } },
  { label: 'MANIAC+thinLOW', archetype: 'MANIAC', manual: { thinValueBet: 'VERY_LOW' }, riverAction: { position: 'BB', type: 'BET', amountBB: 7 } },
  { label: 'MANIAC+thinHIGH', archetype: 'MANIAC', manual: { thinValueBet: 'VERY_HIGH' }, riverAction: { position: 'BB', type: 'BET', amountBB: 7 } },
];
const store = new Map<string, { eq: number; thin: number; bluff: number; ev: number; value: number }>();
for (const c of cases) {
  const r = run(c);
  const m = r.masses ?? {};
  console.log(
    `${c.label.padEnd(18)}${String(c.manual?.['thinValueBet'] ?? '—').padEnd(10)}${String(r.row['action']).padEnd(7)}` +
      `${pct(r.row['equity'], 4).padEnd(10)}${pct(r.row['requiredEquity'], 2).padEnd(9)}${num(r.row['callEV'], 4).padEnd(9)}` +
      `${pct(m['thinValueMass'], 4).padEnd(10)}${pct(m['valueMass'], 4).padEnd(10)}${pct(m['strongValueMass']).padEnd(8)}` +
      `${pct(m['showdownMass']).padEnd(10)}${pct(m['pureAirMass']).padEnd(6)}` +
      `${`${pct(m['missedFlushMass'], 3)}/${pct(m['missedStraightMass'], 3)}/${pct(m['missedComboMass'], 3)}`.padEnd(15)}${r.profileApplied}`,
  );
  store.set(c.label, {
    eq: r.row['equity'] as number, thin: m['thinValueMass'] as number,
    bluff: m['bluffMass'] as number, ev: r.row['callEV'] as number, value: m['valueMass'] as number,
  });
}
const ratio = (a: string, b: string, k: 'eq' | 'thin' | 'bluff' | 'ev' | 'value'): string => {
  const x = store.get(a)!; const y = store.get(b)!;
  return `${x[k].toFixed(5)} → ${y[k].toFixed(5)}（×${(y[k] / x[k]).toFixed(4)}）`;
};
console.log('\n  --- item 4 的关系 ---');
for (const base of ['neutral', 'CS', 'MANIAC'] as const) {
  const low = `${base}+thinLOW`; const high = `${base}+thinHIGH`;
  console.log(`  ${base}: thin质量 ${ratio(low, high, 'thin')}`);
  console.log(`  ${base}: 权益    ${ratio(low, high, 'eq')}`);
  console.log(`  ${base}: callEV  ${ratio(low, high, 'ev')}`);
  console.log(`  ${base}: 价值质量 ${ratio(low, high, 'value')}`);
}
console.log('\n  --- 诈唬轴（CS vs MANIAC）在固定 thin 设定下是否仍单调（MANIAC 权益 > CS 权益）---');
for (const [low, high, tag] of [['CS', 'MANIAC', '无 thin 设定'], ['CS+thinLOW', 'MANIAC+thinLOW', 'thin=VERY_LOW'], ['CS+thinHIGH', 'MANIAC+thinHIGH', 'thin=VERY_HIGH']] as const) {
  const a = store.get(low)!; const b = store.get(high)!;
  console.log(
    `  ${tag.padEnd(14)} 权益 ${pct(a.eq, 4)} → ${pct(b.eq, 4)}（Δ ${((b.eq - a.eq) * 100).toFixed(3)}pp）` +
      ` callEV ${num(a.ev, 4)} → ${num(b.ev, 4)}（Δ ${(b.ev - a.ev).toFixed(4)}）` +
      ` thin质量 ${pct(a.thin, 4)} → ${pct(b.thin, 4)} ⇒ 单调=${b.eq > a.eq ? 'YES' : '**NO**'}`,
  );
}

console.log('\n################ C. 响应模型对尺寸的单调性（item 6：Hero 有下注权的节点）################');
const heroActs = run({ label: 'BB checks river', archetype: null, riverAction: { position: 'BB', type: 'CHECK' } });
console.log(`  动作=${String(heroActs.row['action'])} 权益=${pct(heroActs.row['equity'], 4)} 所需=${pct(heroActs.row['requiredEquity'])} callEV=${num(heroActs.row['callEV'], 3)}`);
const sizes = (heroActs.row['sizes'] ?? null) as Row[] | null;
if (sizes === null || sizes.length === 0) {
  console.log('  **没有 betDecision.sizes（响应模型未产出）**');
} else {
  console.log('  尺寸                    比例    金额     对手弃牌   对手跟注   对手加注  权益(对跟注范围)  我方EV');
  for (const s of sizes) {
    console.log(
      `  ${String(s['labelZh']).padEnd(22)}${num(s['ratioToPot'], 4).padEnd(8)}${num(s['betAmount'], 2).padEnd(9)}` +
        `${num(s['foldLikelihood'], 4).padEnd(11)}${num(s['callLikelihood'], 4).padEnd(11)}${num(s['raiseLikelihood'], 4).padEnd(11)}` +
        `${(s['equity'] === null ? '—' : pct(s['equity'], 4)).padEnd(17)}${num(s['ev'], 3)}`,
    );
  }
  const eqs = sizes.map((s) => s['equity']).filter((v): v is number => typeof v === 'number');
  const folds = sizes.map((s) => s['foldLikelihood']).filter((v): v is number => typeof v === 'number');
  const calls = sizes.map((s) => s['callLikelihood']).filter((v): v is number => typeof v === 'number');
  const raises = sizes.map((s) => s['raiseLikelihood']).filter((v): v is number => typeof v === 'number');
  const dec = (a: number[]): boolean => a.every((v, i) => i === 0 || v <= a[i - 1]! + 1e-12);
  const inc = (a: number[]): boolean => a.every((v, i) => i === 0 || v >= a[i - 1]! - 1e-12);
  console.log(`  ⇒ 权益随尺寸递减（大注⇒更强的跟注范围）: ${dec(eqs) ? 'YES' : '**NO**'}  [${eqs.map((v) => (v * 100).toFixed(3) + '%').join(' → ')}]`);
  console.log(`  ⇒ 弃牌率随尺寸递增: ${inc(folds) ? 'YES' : '**NO**'}  [${folds.map((v) => v.toFixed(4)).join(' → ')}]`);
  console.log(`  ⇒ 跟注率随尺寸递减: ${dec(calls) ? 'YES' : '**NO**'}  [${calls.map((v) => v.toFixed(4)).join(' → ')}]`);
  console.log(`  ⇒ 加注率随尺寸递增: ${inc(raises) ? 'YES' : '**NO**'}  [${raises.map((v) => v.toFixed(4)).join(' → ')}]`);
  const evs = sizes.map((s) => s['ev']).filter((v): v is number => typeof v === 'number');
  console.log(`  ⇒ EV 随尺寸单调递减: ${dec(evs) ? 'YES' : 'NO'}  [${evs.map((v) => v.toFixed(3)).join(' → ')}]；最佳 = ${String(heroActs.row['sizes'] === null ? '—' : '')}`);
}
console.log(`\n  checkTree 存在？${String((heroActs.row['sizes'] === null ? 'n/a' : 'n/a'))}`);
