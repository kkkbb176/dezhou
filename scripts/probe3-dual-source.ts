/**
 * PROBE 3 / 3B / 3C —— OBSERVED-ONLY vs RESOLVED DUAL-SOURCE（只诊断，不改产品代码）
 *
 * 目标：验证「响应模型」与「betScale（开火倾向）」是否用了**不同的**人物理解。
 *
 * 追踪方式（不靠变量名猜）：
 *  - `responseTendenciesOf` 把**实际使用的维度**原样放在返回值里
 *    （`betResponse.ts:423 effectiveDimensions`），因此直接读它即可拿到真参数；
 *  - `betScale` 走的是「候选输入复现」双向测试：
 *    `calibratedBetScaleOf({baseArchetype, dimensions: X})` 与管线值**逐位相同**的
 *     那个 X 就是真实输入；另一个候选项必须**不**相同（否则判据无区分力）。
 *
 * 两个方向：
 *  - 方向 1：base = NIT(VERY_TIGHT) + 极端 MANIAC 实测
 *  - 方向 2：base = MANIAC        + 极端 NIT 实测
 *
 * 用法：node --experimental-strip-types scripts/probe3-dual-source.ts
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { calibratedBetScaleOf, type PlayerObservedStats } from '../src/domain/player/observedStats.ts';
import { ARCHETYPE_DIMENSIONS } from '../src/domain/player/archetypeDimensions.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_013;
const ASOF = 1_757_000_000_000;

type M = Record<string, any>;
type Axis = 'tightness' | 'aggression' | 'bluffTendency' | 'passivity';
const AXES: readonly Axis[] = ['tightness', 'aggression', 'bluffTendency', 'passivity'];
const d4 = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : '—');
const pad = (s: unknown, n: number): string => String(s).padEnd(n);
const line = (s = ''): void => console.log(s);

const H = (p: string, t: string, a?: number, s?: string) => ({
  position: p, type: t,
  ...(a === undefined ? {} : { amountBB: a }),
  ...(s === undefined ? {} : { street: s }),
});
const SEATS: Record<string, number> = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };

/** 河牌节点（Hero 下注 → 对手 Fold/Call/Raise）—— TEST 12 的手牌 */
const RIVER_HISTORY = [
  H('UTG', 'FOLD'), H('HJ', 'FOLD'), H('CO', 'FOLD'),
  H('BTN', 'RAISE', 3), H('SB', 'FOLD'), H('BB', 'CALL', 2),
  H('BB', 'CHECK', undefined, 'FLOP'), H('BTN', 'BET', 2.5, 'FLOP'), H('BB', 'CALL', 2.5, 'FLOP'),
  H('BB', 'CHECK', undefined, 'TURN'), H('BTN', 'BET', 7.5, 'TURN'), H('BB', 'CALL', 7.5, 'TURN'),
  H('BB', 'CHECK', undefined, 'RIVER'),
];
/** 转牌节点（Hero 可选择过牌 → CHECK 树；本手 Hero 有位置）—— TEST 10 的手牌 */
const TURN_HISTORY = [
  H('UTG', 'FOLD'), H('HJ', 'FOLD'),
  H('CO', 'RAISE', 3), H('BTN', 'FOLD'), H('SB', 'FOLD'), H('BB', 'CALL', 2),
  H('BB', 'CHECK', undefined, 'FLOP'), H('CO', 'BET', 2.5, 'FLOP'), H('BB', 'CALL', 2.5, 'FLOP'),
  H('BB', 'CHECK', undefined, 'TURN'),
];
/**
 * 🔴 **翻牌 OOP 过牌节点**（Hero = BB 先过牌 ⇒ 对手可下注）。
 *
 * 这是 `streetBetScale`（observed-only 来源）**真正被消费**的分支：
 * `betResponse.ts:1400` 的 `HEURISTIC_ONE_STREET` 只覆盖「非河牌 + Hero 有位置」，
 * OOP 会走 `afterCheck` 真分支。
 */
const FLOP_OOP_HISTORY = [
  H('UTG', 'FOLD'), H('HJ', 'FOLD'), H('CO', 'FOLD'),
  H('BTN', 'RAISE', 3), H('SB', 'FOLD'), H('BB', 'CALL', 2),
  H('BB', 'CHECK', undefined, 'FLOP'),
];

function inputFor(kind: 'RIVER' | 'TURN' | 'FLOP_OOP', base: string, stats: PlayerObservedStats): ManualHandInput {
  return (kind === 'RIVER'
    ? {
        tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s', '2c'],
        street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS },
        actionHistory: RIVER_HISTORY.map((a) => ({ ...a })), environment: 'MID_LOW_STAKES',
      }
    : kind === 'TURN'
      ? {
          tableSize: 6, heroPosition: 'CO', heroCards: ['Ah', '5h'], board: ['Kh', '7c', '3h', '4s'],
          street: 'TURN', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS },
          actionHistory: TURN_HISTORY.map((a) => ({ ...a })), environment: 'MID_LOW_STAKES',
        }
      : {
          tableSize: 6, heroPosition: 'BB', heroCards: ['7h', '6h'], board: ['Kd', '8c', '4h'],
          street: 'FLOP', effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS },
          actionHistory: FLOP_OOP_HISTORY.map((a) => ({ ...a })), environment: 'MID_LOW_STAKES',
        }) as unknown as ManualHandInput & {
    villain: M;
  };
}

type Out = {
  v3: M; tend: M; betScaleFrom: { observedMatch: boolean; resolvedMatch: boolean; pipeline: number; fromObserved: number; fromResolved: number };
  checkTree: M | null; sizes: M[]; action: string;
};

function run(kind: 'RIVER' | 'TURN' | 'FLOP_OOP', base: string, stats: PlayerObservedStats): Out {
  const input = inputFor(kind, base, stats) as unknown as M;
  input['villain'] = { quickProfile: base, dynamicHint: 'UNKNOWN', stackBB: 100, observedStats: stats };

  const parsed = parseManualInput(input as ManualHandInput);
  if (!parsed.ok) throw new Error(`PARSE ${JSON.stringify(parsed.issues.slice(0, 3))}`);
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error(`STATE ${JSON.stringify(gate).slice(0, 600)}`);

  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: ASOF,
    quickProfile: base as never, observedStats: stats, equitySeed: SEED,
  });
  const ctx = built.context as unknown as M;
  const v3 = (ctx['profileV3'] ?? {}) as M;
  const bdFacts = (ctx['postflopFacts'] as M | undefined)?.['betDecision'] as M | null;

  const r = analyzeManualHand(input as ManualHandInput, {
    rules: RULES, asOf: ASOF, writeLog: false, equitySeed: SEED,
    budget: { softMs: 120_000, hardMs: 240_000 },
  });
  if (!r.ok) throw new Error(`ANALYZE ${JSON.stringify(r.issues.slice(0, 3))}`);
  const d = r.decision as unknown as M;
  const bdDiag = (d['diagnostics'] as M)['postflop']?.['betDecision'] as M | null;

  const observed = (v3['observedDimensions'] ?? {}) as M;
  const resolved = (v3['resolvedDimensions'] ?? {}) as M;
  const pipelineBetScale = Number((v3['street']?.['RIVER']?.['betScale']) ?? 1);
  const fromObserved = calibratedBetScaleOf({
    baseArchetype: base as never,
    dimensions: {
      aggression: Number(observed['aggression']), bluffTendency: Number(observed['bluffTendency']),
      passivity: Number(observed['passivity']),
    },
  });
  const fromResolved = calibratedBetScaleOf({
    baseArchetype: base as never,
    dimensions: {
      aggression: Number(resolved['aggression']), bluffTendency: Number(resolved['bluffTendency']),
      passivity: Number(resolved['passivity']),
    },
  });

  return {
    v3,
    tend: (bdFacts?.['tendencies'] ?? {}) as M,
    betScaleFrom: {
      observedMatch: Math.abs(fromObserved - pipelineBetScale) < 1e-12,
      resolvedMatch: Math.abs(fromResolved - pipelineBetScale) < 1e-12,
      pipeline: pipelineBetScale, fromObserved, fromResolved,
    },
    checkTree: (bdFacts?.['checkTree'] ?? null) as M | null,
    sizes: ((bdDiag?.['sizes'] ?? []) as M[]).map((s) => ({ ...s })),
    action: String(d['action']),
  };
}

/* ---------------- 两个方向的观测向量 ---------------- */

const MANIAC_STATS = (hands: number): PlayerObservedStats => ({
  handsObserved: hands,
  vpip: 0.60, pfr: 0.45, threeBet: 0.18, wtsd: 0.35,
  foldToFlopCBet: 0.22, foldToTurnCBet: 0.20, foldToRiverBet: 0.18,
  flopCheckRaise: 0.18, turnCheckRaise: 0.15, riverCheckRaise: 0.12,
});
const NIT_STATS = (hands: number): PlayerObservedStats => ({
  handsObserved: hands,
  vpip: 0.17, pfr: 0.10, threeBet: 0.03, wtsd: 0.18,
  foldToFlopCBet: 0.60, foldToTurnCBet: 0.65, foldToRiverBet: 0.70,
  flopCheckRaise: 0.02, turnCheckRaise: 0.015, riverCheckRaise: 0.01,
});
const HANDS = [20, 50, 100, 500, 1500] as const;

line('='.repeat(126));
line(' PROBE 3 —— OBSERVED-ONLY vs RESOLVED DUAL-SOURCE ｜ 追踪响应模型与 betScale 的真实输入');
line('='.repeat(126));
line('');

function table(title: string, base: string, mk: (n: number) => PlayerObservedStats): void {
  line('─'.repeat(126));
  line(`【${title}】base = ${base}`);
  line('─'.repeat(126));
  line(pad('hands', 8) + pad('observed.agg', 13) + pad('resolved.agg', 13) + pad('Δagg', 10) +
    pad('observed.tight', 14) + pad('resolved.tight', 14) + pad('Δtight', 10) +
    pad('observed.pass', 14) + pad('resolved.pass', 14) + pad('Δpass', 10) + 'response-model dims（真实进入）');
  line('-'.repeat(150));
  for (const n of HANDS) {
    const o = run('RIVER', base, mk(n));
    const obs = (o.v3['observedDimensions'] ?? {}) as M;
    const res = (o.v3['resolvedDimensions'] ?? {}) as M;
    const eff = (o.tend['effectiveDimensions'] ?? {}) as M;
    line(pad(n, 8) +
      pad(d4(obs['aggression']), 13) + pad(d4(res['aggression']), 13) +
      pad(d4(Number(res['aggression']) - Number(obs['aggression'])), 10) +
      pad(d4(obs['tightness']), 14) + pad(d4(res['tightness']), 14) +
      pad(d4(Number(res['tightness']) - Number(obs['tightness'])), 10) +
      pad(d4(obs['passivity']), 14) + pad(d4(res['passivity']), 14) +
      pad(d4(Number(res['passivity']) - Number(obs['passivity'])), 10) +
      `{t ${d4(eff['tightness'])}, a ${d4(eff['aggression'])}, b ${d4(eff['bluffTendency'])}, p ${d4(eff['passivity'])}}`);
  }
  line('');

  line(pad('hands', 8) + pad('betScale(管线)', 15) + pad('由observed复现', 15) + pad('由resolved复现', 15) +
    pad('= observed?', 13) + pad('= resolved?', 13) +
    pad('riverBetScale(响应)', 20) + 'streetBetScale(响应)');
  line('-'.repeat(126));
  for (const n of HANDS) {
    const o = run('RIVER', base, mk(n));
    const b = o.betScaleFrom;
    line(pad(n, 8) + pad(d4(b.pipeline), 15) + pad(d4(b.fromObserved), 15) + pad(d4(b.fromResolved), 15) +
      pad(b.observedMatch ? 'YES' : 'no', 13) + pad(b.resolvedMatch ? 'YES' : 'no', 13) +
      pad(d4(o.tend['riverBetScale']), 20) + d4(o.tend['streetBetScale']));
  }
  line('');
}

table('方向 1：NIT 标签 + MANIAC 实测', 'VERY_TIGHT', MANIAC_STATS);
table('方向 2：MANIAC 标签 + NIT 实测', 'MANIAC', NIT_STATS);

/* ---------------- 3C：动作层 ---------------- */
line('─'.repeat(126));
line(' PROBE 3C —— 动作层（同一个玩家，两个模块的实际输出）');
line('─'.repeat(126));
line('');
for (const [title, base, mk] of [
  ['NIT 标签 + MANIAC 实测', 'VERY_TIGHT', MANIAC_STATS],
  ['MANIAC 标签 + NIT 实测', 'MANIAC', NIT_STATS],
] as const) {
  line(`【${title}】`);
  line(pad('hands', 8) + pad('riverBetScale', 15) + pad('streetBetScale', 16) +
    pad('CHECK树:他下注', 16) + pad('CHECK树:他过牌', 16) +
    pad('BET小:Fold', 12) + pad('BET小:Call', 12) + pad('BET小:Raise', 12) + 'Final');
  line('-'.repeat(124));
  for (const n of HANDS) {
    const o = run('RIVER', base, mk(n));
    const t = run('TURN', base, mk(n));
    const ct = (t.checkTree ?? {}) as M;
    const small = o.sizes.find((s) => String(s['size']) === 'BET_SMALL') ?? {};
    line(pad(n, 8) + pad(d4(o.tend['riverBetScale']), 15) + pad(d4(o.tend['streetBetScale']), 16) +
      pad(d4(ct['betLikelihood']), 16) + pad(d4(ct['checkBackLikelihood']), 16) +
      pad(d4(small['foldLikelihood']), 12) + pad(d4(small['callLikelihood']), 12) +
      pad(d4(small['raiseLikelihood']), 12) + o.action);
  }
  line('');
}
line('─'.repeat(126));
line(' PROBE 3C-b —— **OOP 过牌节点**（Hero BB 先过牌 ⇒ 对手可下注；streetBetScale 真正生效的分支）');
line('─'.repeat(126));
line('');
for (const [title, base, mk] of [
  ['NIT 标签 + MANIAC 实测', 'VERY_TIGHT', MANIAC_STATS],
  ['MANIAC 标签 + NIT 实测', 'MANIAC', NIT_STATS],
] as const) {
  line(`【${title}】`);
  line(pad('hands', 8) + pad('streetBetScale', 17) + pad('riverBetScale', 16) +
    pad('CHECK树 kind', 24) + pad('他下注 P', 12) + pad('他过牌 P', 12) + 'checkEV');
  line('-'.repeat(104));
  for (const n of HANDS) {
    try {
      const o = run('FLOP_OOP', base, mk(n));
      const ct = (o.checkTree ?? {}) as M;
      line(pad(n, 8) + pad(d4(o.tend['streetBetScale']), 17) + pad(d4(o.tend['riverBetScale']), 16) +
        pad(String(ct['kind'] ?? '—'), 24) + pad(d4(ct['betLikelihood']), 12) +
        pad(d4(ct['checkBackLikelihood']), 12) + d4(ct['checkEV']));
    } catch (error) {
      line(pad(n, 8) + `⚠️ 该节点**不是合法的 Hero 决策点**：` +
        `${String((error as Error).message).slice(0, 200)}`);
    }
  }
  line('');
}
line('  ⇒ 结论：Hero 在翻牌/转牌**先行动**时（OOP），BB 过牌之后轮到的是对手（BTN），');
line('     因此「Hero 过牌 ⇒ 对手可下注」在本引擎里**不是**决策点；它只能作为决策点内部的');
line('     CHECK 树出现。而 `betResponse.ts:1400` 对「非河牌 + Hero 有位置」直接返回');
line('     `HEURISTIC_ONE_STREET`（他下注 P 硬编码 0）⇒ **在 flop/turn 的 CHECK 树上，');
line('     streetBetScale 与 riverBetScale 都不参与**，PROBE 3 的分歧在那里是**潜伏的**。');
line('');
line('─'.repeat(126));
line(' PROBE 3 判定');
line('─'.repeat(126));
line('');
let observedMatched = 0; let resolvedMatched = 0; let totalRows = 0;
let maxGap = 0;
let splitDetected = false;
for (const [base, mk] of [['VERY_TIGHT', MANIAC_STATS], ['MANIAC', NIT_STATS]] as const) {
  for (const n of HANDS) {
    const o = run('RIVER', base, mk(n));
    totalRows += 1;
    if (o.betScaleFrom.observedMatch) observedMatched += 1;
    if (o.betScaleFrom.resolvedMatch) resolvedMatched += 1;
    const eff = (o.tend['effectiveDimensions'] ?? {}) as M;
    const res = (o.v3['resolvedDimensions'] ?? {}) as M;
    maxGap = Math.max(maxGap, ...AXES.map((a) => Math.abs(Number(res[a]) - Number(eff[a]))));
    // 分裂判据：betScale 与 riverBetScale 方向相反（一个 >1 一个 <1）
    const rb = Number(o.tend['riverBetScale']);
    const sb = Number(o.tend['streetBetScale']);
    if (rb !== 1 && sb !== 1 && (rb - 1) * (sb - 1) < 0) splitDetected = true;
  }
}
line(`  ① betScale 真实输入来源（${totalRows} 行）：复现自 observed-only ${observedMatched}/${totalRows} ｜ ` +
  `复现自 resolved ${resolvedMatched}/${totalRows}`);
line(`     ⇒ betScale 的输入 = ${observedMatched === totalRows ? '**observed-only 维度**' : '未确认（需进一步追踪）'}`);
line(`  ② 响应模型真实输入与 resolved 的最大逐轴差 = ${maxGap.toExponential(3)}` +
  `（${maxGap < 1e-12 ? '**逐位相同 ⇒ 响应模型用 resolved**' : '存在差异'}）`);
line(`  ③ 同一玩家同时出现「riverBetScale 与 streetBetScale 方向相反」= ${splitDetected ? '**出现**' : '未出现'}`);
line('');
line(`  DUAL_PROFILE_SOURCE = ${observedMatched === totalRows && maxGap < 1e-12
  ? (splitDetected ? 'FUNCTIONALLY_DANGEROUS' : 'DIVERGENT')
  : 'CONSISTENT'}`);
line('  （判据：betScale 输入 ≠ 响应模型输入 ⇒ 至少 DIVERGENT；两者对同一玩家给出相反方向 ⇒ FUNCTIONALLY_DANGEROUS）');
line('');
line('  代码位置（供复核，不是推断）：');
line('    · 响应模型维度输入：contextBuilder.ts → buildBetDecisionFacts 的 effectiveDimensions');
line('      （`{...input.dimensions, ...v3Dimensions}`，其中 v3Dimensions = resolvedDimensions）');
line('    · betScale 输入：observedStats.ts → factorsOf 里的 calibratedBetScaleOf({dimensions: dims})');
line('      而 `const dims: ResolvedDimensions = observedDimensions;`');
line('    · 响应侧两者的消费字段：betResponse.ts:413 riverBetScale（用 dimensions）、'
  + 'betResponse.ts:422 streetBetScale（用分街 factors.betScale）');
line('');
line(`  ARCTYPE 参考：VERY_TIGHT=${JSON.stringify(ARCHETYPE_DIMENSIONS.VERY_TIGHT)}`);
line(`               MANIAC=${JSON.stringify(ARCHETYPE_DIMENSIONS.MANIAC)}`);
line('');
