/**
 * Reviewer 5 · 反证探针 B —— NEUTRAL_PARITY 的**全链路**独立复核
 *
 * V2 报告只在 `estimateUnifiedActionLikelihood` 层声明 NEUTRAL_PARITY = PASS（48 格）。
 * 本探针不复用那个网格，改为走**生产总入口** `analyzeManualHand`：
 *
 *   U  = `villain.quickProfile = 'UNKNOWN'`（不派生画像，走中性画像）
 *   N  = `villain.quickProfile = 'NORMAL'` （派生画像，但 NORMAL 在
 *        `NEUTRAL_ARCHETYPES` 里被显式声明为刻意中性 ⇒ 每条 cond 恰为 1.0）
 *   NO = 完全不给 `quickProfile`
 *   P  = 显式传入中性 `behaviorProfile`（`archetype: null`，池先验）
 *
 * 断言（逐位，不是容差）：U / N / NO / P 四者的**完整结果对象**
 * （含权益、动作、范围更新日志、画像证据）sha256 必须两两相等。
 *
 * 运行：node --experimental-strip-types scripts/v21-rev5-parity.ts
 */
import { createHash } from 'node:crypto';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const SEATS = {
  UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
  CO: 100, BTN: 100, SB: 100, BB: 100,
};

const HISTORY = [
  { position: 'UTG', type: 'FOLD' },
  { position: 'UTG1', type: 'FOLD' },
  { position: 'UTG2', type: 'FOLD' },
  { position: 'LJ', type: 'FOLD' },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 },
  { position: 'BTN', type: 'FOLD' },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 1.5 },
  { position: 'BB', type: 'CHECK', street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'TURN' },
  { position: 'CO', type: 'CHECK', street: 'TURN' },
  { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
] as const;

type Variant = 'U_unknown' | 'N_normal' | 'NO_none' | 'P_explicitNeutral' | 'M_maniac';

function hand(variant: Variant): ManualHandInput {
  const villain: Record<string, unknown> = { stackBB: 100, dynamicHint: 'UNKNOWN' };
  if (variant === 'U_unknown') villain['quickProfile'] = 'UNKNOWN';
  if (variant === 'N_normal') villain['quickProfile'] = 'NORMAL';
  if (variant === 'M_maniac') villain['quickProfile'] = 'MANIAC';
  if (variant === 'P_explicitNeutral') {
    villain['behaviorProfile'] = behaviorProfileOf({ playerId: 'seat_BB', archetype: null });
  }
  return {
    tableSize: 9,
    heroPosition: 'CO',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [...HISTORY],
    environment: 'MID_LOW_STAKES',
    villain,
  } as unknown as ManualHandInput;
}

function canon(value: unknown): unknown {
  if (value === undefined) return '__UNDEFINED__';
  if (value === null) return null;
  const t = typeof value;
  if (t === 'function') return '__FUNCTION__';
  if (t !== 'object') return value;
  if (Array.isArray(value)) return value.map(canon);
  if (value instanceof Map) return [...value.entries()].map(([k, v]) => [String(k), canon(v)]);
  if (value instanceof Set) return [...value.values()].map(canon);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) out[key] = canon(src[key]);
  return out;
}

const sha = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(canon(value))).digest('hex');

console.log('================ 全链路 UNKNOWN / NORMAL / 无画像 / 显式中性 逐位比较 ================');
console.log('（生产总入口 analyzeManualHand；参考手 9-max CO Ac Jh｜Ad 8s 4s 2c Kd｜BB 河牌 bet 7）');

/** 逐路径 diff：找出「整个结果对象不同」到底差在哪几片叶子上 */
function diffPaths(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length > 400) return;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) {
    out.push(`${path}: 类型不同 ${ta} vs ${tb}`);
    return;
  }
  if (ta === 'array') {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) {
      out.push(`${path}: 数组长度 ${aa.length} vs ${bb.length}`);
      return;
    }
    for (let i = 0; i < aa.length; i += 1) diffPaths(aa[i], bb[i], `${path}[${i}]`, out);
    return;
  }
  if (ta === 'object') {
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(oa), ...Object.keys(ob)])].sort();
    for (const k of keys) diffPaths(oa[k], ob[k], `${path}.${k}`, out);
    return;
  }
  if (!Object.is(a, b)) {
    const fmt = (x: unknown): string =>
      typeof x === 'string' && (x as string).length > 150 ? `${(x as string).slice(0, 150)}…` : String(x);
    out.push(`${path}: ${fmt(a)}  ⇒  ${fmt(b)}`);
  }
}

const shots = new Map<Variant, { full: string; decision: string; trace: string; equity: number; action: string; profile: string | null; raw: unknown }>();
for (const v of ['U_unknown', 'N_normal', 'NO_none', 'P_explicitNeutral', 'M_maniac'] as Variant[]) {
  const t0 = Date.now();
  const r = analyzeManualHand(hand(v), OPTIONS);
  const ms = Date.now() - t0;
  if (!r.ok) {
    console.log(`  ${v.padEnd(20)} **分析失败** stage=${r.stage} ${JSON.stringify(r.issues)}`);
    continue;
  }
  const trace = (r.decision.diagnostics as unknown as { range?: { updateTrace?: unknown } })?.range?.updateTrace ?? null;
  const decision = (r.decision as unknown as { diagnostics: { math: { heroEquity?: number } } });
  const profileEvidence =
    (r.context?.postflopFacts as unknown as { opponentRangeFacts?: { profileRangeEvidence?: unknown } })
      ?.opponentRangeFacts?.profileRangeEvidence ?? null;
  shots.set(v, {
    full: sha(r),
    decision: sha(r.decision),
    trace: sha(trace),
    equity: decision.diagnostics.math.heroEquity ?? NaN,
    action: String(r.decision.action),
    profile: profileEvidence === null ? null : sha(profileEvidence),
    raw: canon(r),
  });
  console.log(
    `  ${v.padEnd(20)} ok (${ms}ms)  权益=${(decision.diagnostics.math.heroEquity ?? NaN).toFixed(10)}  ` +
      `动作=${String(r.decision.action).slice(0, 60)}`,
  );
}

console.log('\n  ---- sha256（full = 整个结果对象）----');
for (const [k, v] of shots) {
  console.log(
    `  ${k.padEnd(20)} full=${v.full.slice(0, 16)} decision=${v.decision.slice(0, 16)} ` +
      `trace=${v.trace.slice(0, 16)} profileEvidence=${v.profile === null ? 'null' : v.profile.slice(0, 16)}`,
  );
}

const pair = (a: Variant, b: Variant): void => {
  const x = shots.get(a);
  const y = shots.get(b);
  if (x === undefined || y === undefined) {
    console.log(`  ${a} vs ${b}: NOT_TESTED（有分析失败）`);
    return;
  }
  const same = x.full === y.full;
  console.log(
    `  ${a} vs ${b}: 整个结果对象=${same ? '**逐位相同**' : '**不同**'}  ` +
      `decision=${x.decision === y.decision ? '逐位相同' : '不同'}  ` +
      `权益 ${x.equity.toFixed(12)} vs ${y.equity.toFixed(12)} ` +
      `(Δ=${Math.abs(x.equity - y.equity).toExponential(3)})  ` +
      `profileEvidence=${x.profile === y.profile ? '相同' : '不同'}`,
  );
};

console.log('\n  ---- 成对判定 ----');
pair('U_unknown', 'N_normal');
pair('U_unknown', 'NO_none');
pair('N_normal', 'NO_none');
pair('U_unknown', 'P_explicitNeutral');
pair('U_unknown', 'M_maniac');

const u = shots.get('U_unknown');
const n = shots.get('N_normal');
console.log(
  `\n  ⇒ NEUTRAL_PARITY（全链路 UNKNOWN == NORMAL）= ` +
    `${u !== undefined && n !== undefined && u.full === n.full ? 'PASS（整个结果对象逐位相同）' : '**FAIL**'}`,
);

/* ============================================================
 * 差异定位：整个对象不同到底差在哪些叶子
 * ============================================================ */
console.log('\n================ 差异叶子逐路径定位 ================');
const uu = shots.get('U_unknown');
const nn = shots.get('N_normal');
if (uu !== undefined && nn !== undefined) {
  const out: string[] = [];
  diffPaths(uu.raw, nn.raw, '$', out);
  console.log(`  UNKNOWN vs NORMAL：不同叶子 ${out.length} 处`);
  for (const line of out) console.log(`    ${line}`);
}
const non = shots.get('NO_none');
if (uu !== undefined && non !== undefined) {
  const out: string[] = [];
  diffPaths(uu.raw, non.raw, '$', out);
  console.log(`\n  UNKNOWN vs 完全不给 quickProfile：不同叶子 ${out.length} 处`);
  for (const line of out) console.log(`    ${line}`);
}
const pn = shots.get('P_explicitNeutral');
if (uu !== undefined && pn !== undefined) {
  const out: string[] = [];
  diffPaths(uu.raw, pn.raw, '$', out);
  console.log(`\n  UNKNOWN vs 显式中性 behaviorProfile：不同叶子 ${out.length} 处`);
  for (const line of out) console.log(`    ${line}`);
}
