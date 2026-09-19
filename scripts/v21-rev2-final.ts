/**
 * REV2 探针 ⑤：11 标签全扫 + 响应模型（正确字段名）+ 决策可翻转性（item 3/6）
 *
 * 用法：node --experimental-strip-types scripts/v21-rev2-final.ts
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, budget: { softMs: 120_000, hardMs: 240_000 } } as const;
const SEATS = { UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };

function handOf(archetype: string, riverBet: number | null, hero: [string, string] = ['Ac', 'Jh']): ManualHandInput {
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
    riverBet === null
      ? { position: 'BB', type: 'CHECK', street: 'RIVER' }
      : { position: 'BB', type: 'BET', amountBB: riverBet, street: 'RIVER' },
  ];
  return {
    tableSize: 9, heroPosition: 'CO', heroCards: hero,
    board: ['Ad', '8s', '4s', '2c', 'Kd'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS },
    actionHistory: h, environment: 'MID_LOW_STAKES',
    villain: { stackBB: 100, quickProfile: archetype },
  } as unknown as ManualHandInput;
}
type Row = Record<string, unknown>;
const pct = (v: unknown, d = 4): string => (typeof v === 'number' ? `${(v * 100).toFixed(d)}%` : '—');
const num = (v: unknown, d = 3): string => (typeof v === 'number' ? v.toFixed(d) : '—');

function run(archetype: string, riverBet: number | null, hero?: [string, string]): Row {
  const r = analyzeManualHand(handOf(archetype, riverBet, hero), OPTIONS);
  if (!r.ok) return { ok: false, issues: JSON.stringify(r.issues) };
  const m = r.decision.diagnostics.math;
  const post = r.decision.diagnostics.postflop as unknown as Row;
  return {
    ok: true, action: r.decision.action, confidence: (r.decision as unknown as Row)['confidence'],
    equity: m.heroEquity, requiredEquity: m.requiredEquity, callEV: m.callEV,
    betDecision: (post?.['betDecision'] ?? null) as Row | null,
  };
}

console.log('################ 1. 参考手（BB bet 7 = 73.7% 池）逐标签全扫 ################');
const ALL = ['UNKNOWN', 'VERY_TIGHT', 'TIGHT', 'NORMAL', 'LOOSE', 'VERY_LOOSE', 'CALLING_STATION', 'AGGRESSIVE', 'BLUFF_HEAVY', 'UNDERBLUFFER', 'MANIAC'];
console.log('标签              动作   置信度   权益        所需权益   callEV     Δvs中性(pp)');
const eqs = new Map<string, number>();
let neutralEq = 0;
for (const a of ALL) {
  const r = run(a, 7);
  const eq = r['equity'] as number;
  if (a === 'UNKNOWN') neutralEq = eq;
  eqs.set(a, eq);
  console.log(
    `${a.padEnd(17)}${String(r['action']).padEnd(8)}${String(r['confidence']).padEnd(9)}${pct(eq).padEnd(12)}${pct(r['requiredEquity'], 2).padEnd(10)}` +
      `${num(r['callEV'], 4).padEnd(10)}${((eq - neutralEq) * 100).toFixed(3)}`,
  );
}
const groups = new Map<string, string[]>();
for (const a of ALL) {
  const k = (eqs.get(a) as number).toFixed(10);
  groups.set(k, [...(groups.get(k) ?? []), a]);
}
console.log(`\n  ⇒ 权益取值互异组数 = ${groups.size}/11：${[...groups.values()].map((g) => `{${g.join(',')}}`).join(' ')}`);
const vals = ALL.map((a) => eqs.get(a) as number);
console.log(`  ⇒ 全部 11 个标签的权益极差 = ${((Math.max(...vals) - Math.min(...vals)) * 100).toFixed(3)}pp；动作集合 = {${[...new Set(ALL.map((a) => String(run(a, 7)['action'])))].join(',')}}`);

console.log('\n################ 2. 响应模型（Hero 有下注权的节点：BB 河牌 check）################');
const heroRow = run('UNKNOWN', null);
console.log(`  Hero 动作=${String(heroRow['action'])} 权益=${pct(heroRow['equity'])} betDecision.pot=${num((heroRow['betDecision'] as Row | null)?.['pot'], 2)}`);
const bd = heroRow['betDecision'] as Row | null;
if (bd === null) {
  console.log('  **betDecision 为 null**');
} else {
  const sizes = bd['sizes'] as Row[];
  console.log('  尺寸         比例     金额    弃牌     跟注     加注     权益(对跟注)  权益(对加注)  EV       评分');
  for (const s of sizes) {
    console.log(
      `  ${String(s['size']).padEnd(12)}${num(s['ratioToPot'], 4).padEnd(9)}${num(s['betAmount'], 2).padEnd(8)}` +
        `${num(s['foldLikelihood'], 4).padEnd(9)}${num(s['callLikelihood'], 4).padEnd(9)}${num(s['raiseLikelihood'], 4).padEnd(9)}` +
        `${pct(s['heroEquityVsCallRange'], 4).padEnd(15)}${pct(s['heroEquityVsRaiseRange'], 3).padEnd(13)}${num(s['betEV'], 3).padEnd(10)}${num(s['score'], 4)}`,
    );
  }
  const g = (k: string): number[] => sizes.map((s) => s[k]).filter((v): v is number => typeof v === 'number');
  const mono = (a: number[], dir: 1 | -1): boolean => a.every((v, i) => i === 0 || (dir === 1 ? v >= a[i - 1]! - 1e-12 : v <= a[i - 1]! + 1e-12));
  console.log(`  ⇒ 弃牌率随尺寸↑: ${mono(g('foldLikelihood'), 1) ? 'YES' : 'NO'} [${g('foldLikelihood').map((v) => v.toFixed(4)).join(' → ')}]`);
  console.log(`  ⇒ 跟注率随尺寸↓: ${mono(g('callLikelihood'), -1) ? 'YES' : 'NO'} [${g('callLikelihood').map((v) => v.toFixed(4)).join(' → ')}]`);
  console.log(`  ⇒ 加注率随尺寸↓: ${mono(g('raiseLikelihood'), -1) ? 'YES' : 'NO'} [${g('raiseLikelihood').map((v) => v.toFixed(4)).join(' → ')}]`);
  console.log(`  ⇒ 权益(对跟注范围)随尺寸↓: ${mono(g('heroEquityVsCallRange'), -1) ? 'YES' : '**NO**'} [${g('heroEquityVsCallRange').map((v) => (v * 100).toFixed(3) + '%').join(' → ')}]`);
  console.log(`  ⇒ 权益(对加注范围)随尺寸↓: ${mono(g('heroEquityVsRaiseRange'), -1) ? 'YES' : '**NO**'} [${g('heroEquityVsRaiseRange').map((v) => (v * 100).toFixed(3) + '%').join(' → ')}]`);
  console.log(`  ⇒ betEV 随尺寸↓: ${mono(g('betEV'), -1) ? 'YES' : 'NO'} [${g('betEV').map((v) => v.toFixed(3)).join(' → ')}]；bestSize=${String(bd['bestSize'])}`);
  console.log(`  ⇒ 尺寸档语义（源码阈值 0.4/0.6/1.25）：比例 ${g('ratioToPot').map((v) => v.toFixed(4)).join(' / ')} ⇒ 档位 ${g('ratioToPot').map((v) => (v >= 1.25 ? 'OVERBET' : v >= 0.6 ? 'LARGE' : v >= 0.4 ? 'MEDIUM' : 'SMALL')).join(' / ')}`);
}

console.log('\n################ 3. 画像能否翻转动作？—— 找边际手牌 ################');
console.log('Hero 底牌   权益(UNKNOWN)  所需权益   动作');
const HEROES: [string, string][] = [['Ks', 'Qs'], ['Js', 'Jh'], ['9c', '9h'], ['7h', '7c'], ['5s', '5d'], ['Ts', 'Th']];
let best: { hero: [string, string]; eq: number } | null = null;
for (const h of HEROES) {
  const r = run('UNKNOWN', 7, h);
  const eq = r['equity'] as number;
  console.log(`  ${h.join('').padEnd(11)}${pct(eq).padEnd(14)}${pct(r['requiredEquity'], 2).padEnd(10)}${String(r['action'])}`);
  if (typeof eq === 'number' && (best === null || Math.abs(eq - 0.2979) < Math.abs(best.eq - 0.2979))) best = { hero: h, eq };
}
if (best !== null) {
  console.log(`\n  最接近所需权益的手牌 = ${best.hero.join('')}（权益 ${pct(best.eq)}，所需 29.79%）`);
  console.log('  该手牌 × 11 标签：');
  for (const a of ALL) {
    const r = run(a, 7, best.hero);
    console.log(
      `    ${a.padEnd(17)}动作=${String(r['action']).padEnd(7)}权益=${pct(r['equity'])} 所需=${pct(r['requiredEquity'], 2)} callEV=${num(r['callEV'], 4)} 置信度=${String(r['confidence'])}`,
    );
  }
}
