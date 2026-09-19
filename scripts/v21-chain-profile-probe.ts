/**
 * V2.1 生产链路探针（Part A 证据）—— 画像 → 决策的真实链路，逐位核对
 *
 * 运行：
 * ```text
 * node --experimental-strip-types scripts/v21-chain-profile-probe.ts
 * ```
 *
 * ## 它回答什么（每一条都必须是**可复现的数字**，不是文案）
 *
 * 1. `quickProfile: 'UNKNOWN'` 是否真的**没有**画像注入（对照 `'NORMAL'` 与「完全不给」）；
 * 2. `'NORMAL'` 是否**构造了**画像却给出**逐位相同**的范围/权益/动作；
 * 3. `'MANIAC'` 是否真的改变范围（类别质量 / 熵 / 权益），
 *    以及 `context.profileRangeEvidence` 里 `provider.applied` 的真实取值；
 * 4. 画像的「第二次计费」闸门（`postflopAdvisor` 的 `rangeLayerApplied` /
 *    `rangeProfileApplied`）在生产夹具里到底是开还是关；
 * 5. `villain.behaviorProfile`（显式传入、无 `quickProfile`）能否在
 *    `profileRangeEvidence` **缺席**的情况下改变范围 —— 即证据与行为是否一致；
 * 6. `dynamicHint` 的「近期倾向」通道在河牌进攻动作上是否被统一似然**顺带抑制**
 *    （`observationMultiplier.calls === 0` 的含义）。
 *
 * ## 纪律
 *
 * - 只读生产函数，不改 `src/`；所有比较都是**逐位**（sha256 of canonical JSON）。
 * - 夹具与 `test/profileQuantificationGolden.test.ts` 的 §十七 黄金手逐字一致，
 *   只有画像参数不同。
 */

import { createHash } from 'node:crypto';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext, NO_DATA_NEUTRAL } from '../src/app/manualInput/contextBuilder.ts';
import { advisePostflop } from '../src/app/decision/postflopAdvisor.ts';
import {
  ALL_QUICK_PROFILES,
  parseManualInput,
  QUICK_PROFILE_CONFIDENCE,
} from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { behaviorProfileOf } from '../src/domain/player/behaviorProfile.ts';
import { profileCompressionMultiplier } from '../src/domain/postflop/rangeCompression.ts';
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

/** §十七 黄金手（与黄金测试逐字一致） */
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

type CaseSpec = {
  label: string;
  quickProfile?: string;
  dynamicHint?: string;
  behaviorProfile?: boolean;
};

function hand(spec: CaseSpec): ManualHandInput {
  const villain: Record<string, unknown> = { stackBB: 100 };
  if (spec.quickProfile !== undefined) villain['quickProfile'] = spec.quickProfile;
  if (spec.dynamicHint !== undefined) villain['dynamicHint'] = spec.dynamicHint;
  if (spec.behaviorProfile === true) {
    villain['behaviorProfile'] = behaviorProfileOf({ playerId: 'BB', archetype: 'MANIAC' as never });
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

/* ============================================================
 * 逐位比较工具
 * ============================================================ */

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
  createHash('sha256').update(JSON.stringify(canon(value))).digest('hex').slice(0, 16);

const show = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(canon(value));
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
};

function diffPaths(a: unknown, b: unknown, path = '', out: string[] = []): string[] {
  if (out.length >= 24) return out;
  const ca = canon(a);
  const cb = canon(b);
  const sa = JSON.stringify(ca);
  const sb = JSON.stringify(cb);
  if (sa === sb) return out;
  const bothObjects =
    ca !== null && cb !== null && typeof ca === 'object' && typeof cb === 'object' &&
    !Array.isArray(ca) && !Array.isArray(cb);
  if (bothObjects) {
    const oa = ca as Record<string, unknown>;
    const ob = cb as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(oa), ...Object.keys(ob)])].sort()) {
      diffPaths(oa[key], ob[key], path === '' ? key : `${path}.${key}`, out);
      if (out.length >= 24) return out;
    }
    return out;
  }
  if (Array.isArray(ca) && Array.isArray(cb) && ca.length === cb.length) {
    for (let i = 0; i < ca.length; i += 1) {
      diffPaths(ca[i], cb[i], `${path}[${i}]`, out);
      if (out.length >= 24) return out;
    }
    return out;
  }
  out.push(`${path}: ${show(ca)} !== ${show(cb)}`);
  return out;
}

/* ============================================================
 * 逐案例测量
 * ============================================================ */

type Measured = {
  label: string;
  evidenceAbsent: boolean;
  playerQuickProfile: string;
  playerConfidence: number;
  playerNeutralized: boolean;
  evidenceApplied: boolean | null;
  dimensionTier: string | null;
  providerCalls: number | null;
  profileEffective: string | null;
  observationCalls: number | null;
  equityBefore: number | null;
  equityAfter: number | null;
  equityDeltaPct: number | null;
  combosBefore: number | null;
  combosAfter: number | null;
  rangeEntropyBits: number | null;
  rangeEffectiveCombos: number | null;
  rangeTopProbability: number | null;
  supportSize: number | null;
  bluffMass: number | null;
  missedDrawMass: number | null;
  pureAirMass: number | null;
  valueMass: number | null;
  effectiveCombos: number | null;
  posteriorMassCombos90: number | null;
  equity: number | null;
  callEV: number | null;
  action: string;
  riverNote: string;
  rangeDigest: string;
  mathDigest: string;
  factsDigest: string;
  playerDigest: string;
  dynamicDigest: string;
  decisionDigest: string;
  dynamicApplied: boolean;
  dynamicState: string;
  dynamicAdaptedCount: number;
  dynamicNoteZh: readonly string[];
  dedup: Record<string, unknown> | null;
  rawContext: unknown;
  rawRangeChain: unknown;
  rawMath: unknown;
  rawPlayer: unknown;
  rawDynamic: unknown;
};

function runCase(spec: CaseSpec): Measured {
  const input = hand(spec);
  const parsed = parseManualInput(input);
  if (!parsed.ok) throw new Error(`夹具必须可解析（${spec.label}）：${JSON.stringify(parsed.issues)}`);
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error(`夹具必须可重建（${spec.label}）：${JSON.stringify(gate.issues)}`);

  /*
   * ⚠️ `analyzeManualHand` **不返回** `context`，因此要看到范围层的数字必须
   * 自己再组一次 `ContextBuildInput`。这里逐字复刻 `alphaPipeline.ts:1029–1073`
   * 的字段拼装（同一个 `gate.state`、同一个 `environment`、同样的可选字段），
   * 只额外暴露出来读数 —— 不新增任何输入。
   */
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    ...(parsed.value.villain.quickProfile !== undefined
      ? { quickProfile: parsed.value.villain.quickProfile }
      : {}),
    ...(parsed.value.villain.dynamicHint !== undefined
      ? { dynamicHint: parsed.value.villain.dynamicHint }
      : {}),
    ...(parsed.value.villain.playerId !== undefined
      ? { villainPlayerId: parsed.value.villain.playerId }
      : {}),
    ...(parsed.value.villain.behaviorProfile !== undefined
      ? { behaviorProfile: parsed.value.villain.behaviorProfile }
      : {}),
  });

  const result = analyzeManualHand(input, OPTIONS);
  if (!result.ok) throw new Error(`夹具必须可分析（${spec.label}）：${JSON.stringify(result.issues)}`);

  const context = built.context as unknown as Record<string, any>;
  const evidence = context['profileRangeEvidence'] as Record<string, any> | undefined;
  const facts = context['postflopFacts']?.['opponentRangeFacts'] as Record<string, any> | null;
  const masses = facts?.['profileClassMasses'] as Record<string, any> | null;
  const range = context['range'] as Record<string, any> | null;
  const math = context['math'] as Record<string, any>;
  const player = context['player'] as Record<string, any> | null;
  const decision = result.decision as unknown as Record<string, any>;

  const riverTrace = (range?.['updateTrace'] ?? []).filter(
    (t: Record<string, any>) => t['street'] === 'RIVER',
  );
  const riverNote = String(riverTrace[0]?.['noteZh'] ?? '（无河牌更新条目）');

  const rangeChain = {
    range: range === null ? null : {
      metrics: range['metrics'], supportSize: range['supportSize'], updateTrace: range['updateTrace'],
    },
    facts,
  };
  const decisionView = {
    action: decision['action'],
    math: decision['diagnostics']?.['math'],
    dedup: decision['diagnostics']?.['postflop']?.['betDecision']?.['profileEvidence'] ?? null,
  };

  return {
    label: spec.label,
    evidenceAbsent: evidence === undefined,
    playerQuickProfile: String(player?.['quickProfile']),
    playerConfidence: Number(player?.['confidence']),
    playerNeutralized: player?.['neutralized'] === true,
    evidenceApplied: evidence === undefined ? null : evidence['provider']?.['applied'] === true,
    dimensionTier: evidence === undefined ? null : String(evidence['dimensionTier']),
    providerCalls: evidence === undefined ? null : Number(evidence['provider']?.['finalMultiplier']?.['calls']),
    profileEffective:
      evidence === undefined
        ? null
        : `${evidence['provider']?.['profileMultiplier']?.['effective']}/${evidence['provider']?.['profileMultiplier']?.['calls']}`,
    observationCalls:
      evidence === undefined ? null : Number(evidence['provider']?.['observationMultiplier']?.['calls']),
    equityBefore: evidence === undefined ? null : (evidence['equityBefore'] as number | null),
    equityAfter: evidence === undefined ? null : (evidence['equityAfter'] as number | null),
    equityDeltaPct: evidence === undefined ? null : (evidence['equityDeltaPct'] as number | null),
    combosBefore: evidence === undefined ? null : (evidence['combosBefore'] as number),
    combosAfter: evidence === undefined ? null : (evidence['combosAfter'] as number),
    rangeEntropyBits: range === null ? null : Number(range['metrics']?.['entropyBits']),
    rangeEffectiveCombos: range === null ? null : Number(range['metrics']?.['effectiveComboCount']),
    rangeTopProbability: range === null ? null : Number(range['metrics']?.['topProbability']),
    supportSize: range === null ? null : Number(range['supportSize']),
    bluffMass: masses === null || masses === undefined ? null : Number(masses['bluffMass']),
    missedDrawMass: masses === null || masses === undefined ? null : Number(masses['missedDrawMass']),
    pureAirMass: masses === null || masses === undefined ? null : Number(masses['pureAirMass']),
    valueMass: masses === null || masses === undefined ? null : Number(masses['valueMass']),
    effectiveCombos: masses === null || masses === undefined ? null : Number(masses['effectiveCombos']),
    posteriorMassCombos90:
      masses === null || masses === undefined ? null : Number(masses['posteriorMassCombos90']),
    equity: math['heroEquity'] === null ? null : Number(math['heroEquity']),
    callEV: math['callEV'] === null ? null : Number(math['callEV']),
    action: String(decision['action']),
    riverNote,
    rangeDigest: sha(rangeChain),
    mathDigest: sha(math),
    factsDigest: sha(facts),
    playerDigest: sha(player),
    dynamicDigest: sha(context['dynamic']),
    decisionDigest: sha(decisionView),
    dynamicApplied: (context['dynamic'] as Record<string, any>)?.['applied'] === true,
    dynamicState: String((context['dynamic'] as Record<string, any>)?.['state']),
    dynamicAdaptedCount: Number(
      ((context['dynamic'] as Record<string, any>)?.['adapted'] ?? []).length,
    ),
    dynamicNoteZh: ((context['dynamic'] as Record<string, any>)?.['explanation'] ?? []) as readonly string[],
    dedup: (decisionView['dedup'] as Record<string, unknown> | null) ?? null,
    rawContext: context,
    rawRangeChain: rangeChain,
    rawMath: math,
    rawPlayer: player,
    rawDynamic: context['dynamic'],
  };
}

/* ============================================================
 * 输出
 * ============================================================ */

const CASES: CaseSpec[] = [
  { label: 'A0 完全不给画像', dynamicHint: 'UNKNOWN' },
  { label: 'A1 quickProfile=UNKNOWN', quickProfile: 'UNKNOWN', dynamicHint: 'UNKNOWN' },
  { label: 'A2 quickProfile=NORMAL', quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  { label: 'A3 quickProfile=MANIAC', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN' },
  { label: 'A3b MANIAC + 显式 behaviorProfile(MANIAC)', quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', behaviorProfile: true },
  { label: 'A4 只给显式 behaviorProfile(MANIAC)', dynamicHint: 'UNKNOWN', behaviorProfile: true },
  { label: 'A5 不给画像 + dynamicHint=AGGRESSION_UP', dynamicHint: 'AGGRESSION_UP' },
  { label: 'A6 UNKNOWN + dynamicHint=AGGRESSION_UP', quickProfile: 'UNKNOWN', dynamicHint: 'AGGRESSION_UP' },
];

console.log('================ 0. 环境 ================');
console.log(`ALL_QUICK_PROFILES = ${ALL_QUICK_PROFILES.join(' / ')}`);
console.log(`QUICK_PROFILE_CONFIDENCE = ${QUICK_PROFILE_CONFIDENCE}；NO_DATA_NEUTRAL = ${NO_DATA_NEUTRAL}`);

const results: Measured[] = [];
for (const spec of CASES) {
  const t0 = Date.now();
  const m = runCase(spec);
  results.push(m);
  console.log(`\n================ ${m.label} （${Date.now() - t0} ms） ================`);
  console.log(
    `player.quickProfile=${m.playerQuickProfile}  confidence=${m.playerConfidence}` +
      `  neutralized=${m.playerNeutralized}`,
  );
  console.log(
    `profileRangeEvidence：${m.evidenceAbsent ? '字段**不存在**（没有任何画像/倾向证据）' : `存在；applied=${String(m.evidenceApplied)}；tier=${String(m.dimensionTier)}`}`,
  );
  if (!m.evidenceAbsent) {
    console.log(
      `  provider.finalMultiplier.calls=${String(m.providerCalls)}  profile effective/calls=${String(m.profileEffective)}` +
        `  observation.calls=${String(m.observationCalls)}`,
    );
    console.log(
      `  equityBefore=${String(m.equityBefore)} → equityAfter=${String(m.equityAfter)}` +
        `（Δ=${m.equityDeltaPct === null ? '—' : m.equityDeltaPct.toFixed(4)}pp）` +
        `  combos ${String(m.combosBefore)} → ${String(m.combosAfter)}`,
    );
  }
  console.log(
    `范围：supportSize=${String(m.supportSize)}  entropyBits=${m.rangeEntropyBits?.toFixed(9)}` +
      `  effectiveComboCount=${m.rangeEffectiveCombos?.toFixed(6)}  topProbability=${m.rangeTopProbability?.toFixed(9)}`,
  );
  console.log(
    `profileClassMasses：bluff=${m.bluffMass?.toFixed(9)} missedDraw=${m.missedDrawMass?.toFixed(9)}` +
      ` pureAir=${m.pureAirMass?.toFixed(9)} value=${m.valueMass?.toFixed(9)}` +
      ` effectiveCombos=${m.effectiveCombos?.toFixed(6)} mass90=${String(m.posteriorMassCombos90)}`,
  );
  console.log(
    `决策：equity=${m.equity === null ? '—' : (m.equity * 100).toFixed(4) + '%'}` +
      `  callEV=${m.callEV === null ? '—' : m.callEV.toFixed(6)}  action=${m.action}`,
  );
  console.log(`digests：range=${m.rangeDigest} math=${m.mathDigest} facts=${m.factsDigest} player=${m.playerDigest} dynamic=${m.dynamicDigest} decision=${m.decisionDigest}`);
  console.log(
    `动态层：applied=${m.dynamicApplied} state=${m.dynamicState} adapted=${m.dynamicAdaptedCount}` +
      `  explanation=${JSON.stringify(canon(m.dynamicNoteZh))}`,
  );
  console.log(`河牌 trace noteZh：${m.riverNote}`);
  console.log(`去重闸门（diagnostics.postflop.betDecision.profileEvidence）：${JSON.stringify(canon(m.dedup))}`);
}

/* ============================================================
 * 1. 逐位比较
 * ============================================================ */

console.log('\n================ 1. 逐位比较（sha256 of canonical JSON，前 16 hex） ================');
const byLabel = new Map(results.map((r) => [r.label, r]));
const pick = (label: string): Measured => {
  const found = byLabel.get(label);
  if (found === undefined) throw new Error(`缺少案例 ${label}`);
  return found;
};

type Comparison = {
  title: string;
  a: Measured;
  b: Measured;
};

const COMPARISONS: Comparison[] = [
  { title: 'A1(UNKNOWN) vs A0(完全不给)', a: pick('A1 quickProfile=UNKNOWN'), b: pick('A0 完全不给画像') },
  { title: 'A2(NORMAL) vs A1(UNKNOWN)', a: pick('A2 quickProfile=NORMAL'), b: pick('A1 quickProfile=UNKNOWN') },
  { title: 'A2(NORMAL) vs A0(完全不给)', a: pick('A2 quickProfile=NORMAL'), b: pick('A0 完全不给画像') },
  { title: 'A3(MANIAC) vs A1(UNKNOWN)', a: pick('A3 quickProfile=MANIAC'), b: pick('A1 quickProfile=UNKNOWN') },
  { title: 'A3b(MANIAC+显式) vs A3(MANIAC)', a: pick('A3b MANIAC + 显式 behaviorProfile(MANIAC)'), b: pick('A3 quickProfile=MANIAC') },
  { title: 'A4(只给显式 behaviorProfile) vs A0(完全不给)', a: pick('A4 只给显式 behaviorProfile(MANIAC)'), b: pick('A0 完全不给画像') },
  { title: 'A5(不给画像+AGGRESSION_UP) vs A0', a: pick('A5 不给画像 + dynamicHint=AGGRESSION_UP'), b: pick('A0 完全不给画像') },
  { title: 'A6(UNKNOWN+AGGRESSION_UP) vs A1(UNKNOWN)', a: pick('A6 UNKNOWN + dynamicHint=AGGRESSION_UP'), b: pick('A1 quickProfile=UNKNOWN') },
];

const FIELDS: readonly (keyof Measured)[] = [
  'rangeDigest', 'mathDigest', 'factsDigest', 'playerDigest', 'dynamicDigest', 'decisionDigest',
];

for (const c of COMPARISONS) {
  console.log(`\n--- ${c.title} ---`);
  for (const field of FIELDS) {
    const av = c.a[field];
    const bv = c.b[field];
    console.log(`  ${String(field).padEnd(15)} ${String(av)} ${av === bv ? '==' : '!='} ${String(bv)}`);
  }
  const contextDiffs = diffPaths(c.a.rawContext, c.b.rawContext);
  console.log(`  完整 context 的差异路径（最多列 24 条，共 ${contextDiffs.length} 条被列出）：`);
  if (contextDiffs.length === 0) console.log('    （无 —— 整个 context 逐位相同）');
  for (const line of contextDiffs) console.log(`    ${line}`);
  const chainDiffs = diffPaths(c.a.rawRangeChain, c.b.rawRangeChain);
  console.log(`  **范围链路**（range.metrics + updateTrace + opponentRangeFacts）差异：${chainDiffs.length === 0 ? '0 条（逐位相同）' : chainDiffs.length + ' 条'}`);
  for (const line of chainDiffs.slice(0, 6)) console.log(`    ${line}`);
}

/* ============================================================
 * 2. 去重闸门：每个案例的真实取值 + 受控反事实
 * ============================================================ */

console.log('\n================ 2. 去重闸门（postflopAdvisor 的 rangeLayerApplied / rangeProfileApplied） ================');

const asAdvice = (ctx: unknown): Record<string, any> => {
  const math = (ctx as Record<string, any>)['math'] as Record<string, any>;
  const advice = advisePostflop(ctx as never, {
    facingBet: Number(math['callCost']) > 0,
    requiredEquity: Number(math['requiredEquity']),
    potAfterCall: Number(math['pot']) + Number(math['callCost']),
  });
  if (advice === null) throw new Error('河牌节点必须给出翻后建议');
  return advice as unknown as Record<string, any>;
};

const adviceView = (advice: Record<string, any>): Record<string, unknown> => ({
  'compression.aggressionCredibility(=压缩因子)': advice['compression']?.['aggressionCredibility'],
  'exploit.applied': advice['exploit']?.['applied'],
  'exploit.bluffCatchDelta': advice['exploit']?.['bluffCatchDelta'],
  'exploit.thinValueDelta': advice['exploit']?.['thinValueDelta'],
  'exploit.bluffDelta': advice['exploit']?.['bluffDelta'],
  'exploit.sizingMultiplier': advice['exploit']?.['sizingMultiplier'],
  'exploit.deDuplicated': advice['exploit']?.['deDuplicated'],
  'gate.estimatedBetEVScore': advice['gate']?.['estimatedBetEVScore'],
  'gate.estimatedCheckEVScore': advice['gate']?.['estimatedCheckEVScore'],
  'gate.verdict': advice['gate']?.['verdict'],
  'betDecision': advice['betDecision'] === null ? null : '（面对下注 ⇒ betDecision=null）',
});

console.log(
  `参考：profileCompressionMultiplier('MANIAC', 0.35)=` +
    `${profileCompressionMultiplier('MANIAC' as never, 0.35).toFixed(6)}` +
    `（闸门开启时会乘上去） vs ('MANIAC', 0)=` +
    `${profileCompressionMultiplier('MANIAC' as never, 0).toFixed(6)}（闸门关闭 = 恒等）`,
);

for (const label of [
  'A0 完全不给画像',
  'A2 quickProfile=NORMAL',
  'A3 quickProfile=MANIAC',
  'A4 只给显式 behaviorProfile(MANIAC)',
]) {
  const m = pick(label);
  const advice = asAdvice(m.rawContext);
  console.log(`\n--- ${label} ---`);
  console.log(
    `  profileRangeEvidence=${m.evidenceAbsent ? '缺席' : `存在(applied=${String(m.evidenceApplied)})`}` +
      ` ⇒ 闸门 rangeLayerApplied=${m.evidenceAbsent ? false : m.evidenceApplied === true}`,
  );
  console.log(`  ${JSON.stringify(canon(adviceView(advice)))}`);
}

console.log('\n--- A3(MANIAC) 的受控反事实：把 profileRangeEvidence 拿掉（模拟「画像已改范围但证据缺失」） ---');
{
  const context = pick('A3 quickProfile=MANIAC').rawContext as Record<string, any>;
  const withEvidence = asAdvice(context);
  const stripped = { ...(context as object) } as Record<string, unknown>;
  delete stripped['profileRangeEvidence'];
  const withoutEvidence = asAdvice(stripped);
  console.log(`有 profileRangeEvidence（生产路径）：\n  ${JSON.stringify(canon(adviceView(withEvidence)))}`);
  console.log(`拿掉 profileRangeEvidence：\n  ${JSON.stringify(canon(adviceView(withoutEvidence)))}`);
  const diffs = diffPaths(adviceView(withEvidence), adviceView(withoutEvidence));
  console.log(`差异 ${diffs.length} 条：`);
  for (const line of diffs) console.log(`  ${line}`);
}

/* ============================================================
 * 3. 显式 behaviorProfile（无 quickProfile）时，证据与行为是否一致
 * ============================================================ */

console.log('\n================ 3. 证据与行为是否一致（A4：显式 behaviorProfile、无 quickProfile） ================');
const explicitOnly = pick('A4 只给显式 behaviorProfile(MANIAC)');
const baseline = pick('A0 完全不给画像');
{
  const factsA = explicitOnly.rawRangeChain as Record<string, any>;
  const factsB = baseline.rawRangeChain as Record<string, any>;
  console.log(
    `A4 profileRangeEvidence 缺席 = ${explicitOnly.evidenceAbsent}；` +
      `但范围链路 digest ${explicitOnly.rangeDigest} vs 基线 ${baseline.rangeDigest}` +
      ` ⇒ ${explicitOnly.rangeDigest === baseline.rangeDigest ? '范围**逐位相同**' : '范围**已改变**'}`,
  );
  console.log(
    `A4 熵 ${Number(factsA['range']?.['metrics']?.['entropyBits']).toFixed(9)} vs 基线 ` +
      `${Number(factsB['range']?.['metrics']?.['entropyBits']).toFixed(9)}；` +
      `A4 诈唬质量 ${explicitOnly.bluffMass?.toFixed(9)} vs 基线 ${baseline.bluffMass?.toFixed(9)}`,
  );
  const chainDiffs = diffPaths(explicitOnly.rawRangeChain, baseline.rawRangeChain);
  console.log(`范围链路差异 ${chainDiffs.length} 条（列前 8 条）：`);
  for (const line of chainDiffs.slice(0, 8)) console.log(`  ${line}`);
}
