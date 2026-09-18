/**
 * PLAYER PROFILE V3 —— 连续统计 + 样本置信度 + 标签先验
 *
 * ## 本文件守什么
 *
 * V3 在既有的
 * `Archetype → dimensions → responseTendenciesOf → Fold/Call/Raise`
 * 链路上加入了**第二个证据来源**（真实统计），同时必须**不破坏**第一条。
 *
 * ```text
 * 标签 Prior（quickProfile）  ← 用户的主观断言，不覆盖
 * 实测统计（observedStats）  ← 真正观察到的行为，带机会数
 * 样本量 → 可信度 n/(n+K)     ← 决定该相信实测到什么程度
 *         ↓
 *   resolved dimensions + 分街 factor
 *         ↓
 *   现有决策链（不改公式、不改 archetype 参数）
 * ```
 *
 * ## 断言纪律
 *
 * - **只断言方向与不变量**，不断言脆弱小数（除少数**结构性恒等**：
 *   无统计时必须**逐位**等于先验/1）。
 * - **测中间量**（resolved dimensions / street factors / confidence），
 *   不只测最终 action —— 最终动作相同不代表画像无效（§4.3）。
 * - 全部走真实生产入口，不硬编码这手牌的结果。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import {
  ALL_OBSERVED_STAT_KEYS,
  resolvePlayerProfile,
  normalizeObservedStats,
  streetFactorOf,
  STAT_EVIDENCE_SPECS,
  type PlayerObservedStats,
} from '../src/domain/player/observedStats.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_260_913;

const A = (p: string, t: string, a?: number, s?: string) => ({
  position: p, type: t,
  ...(a === undefined ? {} : { amountBB: a }),
  ...(s === undefined ? {} : { street: s }),
});
const HISTORY = [
  A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'),
  A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
  A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
  A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
  A('BB', 'CHECK', undefined, 'RIVER'),
];
const SEATS: Record<string, number> = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 };

/** 老周：310 手真实统计 */
const LAOZHOU: PlayerObservedStats = {
  handsObserved: 310,
  vpip: 0.52, pfr: 0.08, threeBet: 0.03, wtsd: 0.38,
  foldToFlopCBet: 0.24, foldToTurnCBet: 0.27, foldToRiverBet: 0.19,
};

type M = Record<string, any>;

function run(quickProfile: string, observedStats?: PlayerObservedStats | null): M {
  const input = {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['Ac', '5c'],
    board: ['Kc', '8d', '4c', '2s', 'Qd'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS },
    actionHistory: HISTORY.map((a) => ({ ...a })), environment: 'MID_LOW_STAKES',
    villain: {
      quickProfile, dynamicHint: 'UNKNOWN', stackBB: 100,
      ...(observedStats === undefined ? {} : { observedStats }),
    },
  } as unknown as ManualHandInput;

  const parsed = parseManualInput(input);
  if (!parsed.ok) throw new Error(`PARSE ${JSON.stringify(parsed.issues.slice(0, 2))}`);
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error(`STATE ${JSON.stringify(gate.issues.slice(0, 2))}`);

  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000, quickProfile: quickProfile as never,
    ...(observedStats == null ? {} : { observedStats }),
  });
  const ctx = built.context as unknown as M;

  const r = analyzeManualHand(input, {
    rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
    equitySeed: SEED, budget: { softMs: 120_000, hardMs: 240_000 },
  });
  if (!r.ok) throw new Error(`ANALYZE ${JSON.stringify(r.issues.slice(0, 2))}`);
  const d = r.decision as unknown as M;
  const bd = ((ctx['postflopFacts'] as M | undefined)?.['betDecision'] ??
    (d['diagnostics'] as M)['postflop']?.['betDecision']) as M | null;

  const byKind = new Map<string, M>();
  for (const s of ((bd?.['legalSizes'] ?? bd?.['sizes'] ?? []) as readonly M[])) {
    byKind.set(String(s['size'] ?? s['kind']), s);
  }
  const pick = (f: string): Record<string, number> =>
    Object.fromEntries([...byKind].map(([k, v]) => [k, Number(v[f])]));

  return {
    action: String(d['action']),
    fold: pick('foldLikelihood'),
    call: pick('callLikelihood'),
    raise: pick('raiseLikelihood'),
    score: pick('score'),
    streetFoldScale: bd?.['tendencies']?.['streetFoldScale'],
    streetCallScale: bd?.['tendencies']?.['streetCallScale'],
    profileV3: ctx['profileV3'] ?? null,
  };
}

const SIZES = ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE'] as const;

/* ============================================================
 * P1 —— 无统计数据 = V2 行为兼容
 * ============================================================ */

test('P1：无统计（null / 全缺失）必须与 V2 archetype-only 逐位一致', () => {
  const v2 = run('CALLING_STATION');
  const nullStats = run('CALLING_STATION', null);
  const zeroHands = run('CALLING_STATION', { handsObserved: 0 });

  for (const s of SIZES) {
    assert.equal(nullStats.fold[s], v2.fold[s], `${s} fold 必须逐位相同（null 统计）`);
    assert.equal(nullStats.call[s], v2.call[s], `${s} call 必须逐位相同（null 统计）`);
    assert.equal(nullStats.score[s], v2.score[s], `${s} score 必须逐位相同（null 统计）`);
    assert.equal(zeroHands.fold[s], v2.fold[s], `${s} fold 必须逐位相同（0 手）`);
  }
  assert.equal(nullStats.action, v2.action, '动作必须相同');
});

test('P1b：无统计时分街系数必须是**精确的 1**（恒等变换）', () => {
  const p = resolvePlayerProfile({ baseArchetype: 'CALLING_STATION', observedStats: null });
  for (const street of ['PREFLOP', 'FLOP', 'TURN', 'RIVER'] as const) {
    const f = p.resolved.street[street];
    assert.equal(f.foldScale, 1, `${street}.foldScale 必须精确为 1`);
    assert.equal(f.callScale, 1, `${street}.callScale 必须精确为 1`);
    assert.equal(f.checkRaiseScale, 1, `${street}.checkRaiseScale 必须精确为 1`);
  }
  for (const dim of ['tightness', 'aggression', 'bluffTendency', 'passivity'] as const) {
    assert.equal(p.resolved.dimensions[dim], 0.5, `${dim} 必须精确为 0.5（中立）`);
  }
});

/* ============================================================
 * P2 —— 老周案例：FoldToRiverBet 必须真的进入 river 计算
 * ============================================================ */

test('P2：老周 310 手 ⇒ FoldToRiverBet(19%) 必须进入 river 响应计算（有 trace）', () => {
  const base = run('CALLING_STATION');
  const withStats = run('CALLING_STATION', LAOZHOU);

  // ① 分街系数被真的算出来并应用（不再是恒等 1）
  assert.notEqual(
    withStats.streetFoldScale,
    undefined,
    'V3 分街系数必须出现在诊断里',
  );
  assert.notEqual(
    withStats.streetFoldScale,
    base.streetFoldScale,
    'riverFoldScale 必须因实测统计而变化（这是「真的进了 river 计算」的直接证据）',
  );

  // ② trace 必须能看到这条统计
  const trace = (withStats.profileV3?.trace ?? []) as readonly M[];
  const river = trace.find((x) => x['stat'] === 'foldToRiverBet');
  assert.ok(river !== undefined, 'trace 必须包含 foldToRiverBet 一条');
  assert.equal(river!['observedRate'], 0.19, 'trace 里的实测比率必须是 0.19');
  assert.ok(Number(river!['confidence']) > 0, '可信度必须 > 0');
  assert.equal(river!['streetTrait'], 'foldToRiverBet', '必须映射到 river 分街条目');
});

test('P2b：老周 19% 河牌弃牌（低于人群中心）⇒ river fold 倾向必须**低于**中性', () => {
  const withStats = run('CALLING_STATION', LAOZHOU);
  assert.ok(
    Number(withStats.streetFoldScale) < 1,
    `FoldToRiverBet 0.19 < 人群中心 ⇒ foldScale 必须 < 1，实际 ${String(withStats.streetFoldScale)}`,
  );
});

/* ============================================================
 * P3 / P4 —— 小样本强收缩 / 大样本更相信实测
 * ============================================================ */

test('P3：小样本（8 手）必须明显收缩到先验，不得被当成事实', () => {
  const p = resolvePlayerProfile({
    baseArchetype: 'CALLING_STATION',
    observedStats: { handsObserved: 8, foldToRiverBet: 0 },
  });
  const t = p.trace.find((x) => x.stat === 'foldToRiverBet')!;
  assert.ok(
    t.confidence < 0.05,
    `8 手的可信度必须极低，实际 ${t.confidence}`,
  );
  // 生效值必须贴近先验而不是 0
  assert.ok(
    Math.abs(t.effectiveRate - t.priorRate) < 0.02,
    `小样本生效值(${t.effectiveRate}) 必须贴近先验(${t.priorRate}) —— 「他永远不弃河牌」是禁止结论`,
  );
  assert.ok(t.effectiveRate > 0.3, `生效值不得被压到 0，实际 ${t.effectiveRate}`);
});

test('P4：大样本必须比小样本更接近 observed（单调收缩）', () => {
  const mk = (n: number) =>
    resolvePlayerProfile({
      baseArchetype: 'CALLING_STATION',
      observedStats: { handsObserved: n, foldToRiverBet: 0.10 },
    }).trace.find((x) => x.stat === 'foldToRiverBet')!;

  const d8 = Math.abs(mk(8).effectiveRate - 0.10);
  const d310 = Math.abs(mk(310).effectiveRate - 0.10);
  const d1000 = Math.abs(mk(1000).effectiveRate - 0.10);
  const d5000 = Math.abs(mk(5000).effectiveRate - 0.10);

  assert.ok(d1000 < d310, `1000 手必须比 310 手更接近 observed：${d1000} < ${d310}`);
  assert.ok(d310 < d8, `310 手必须比 8 手更接近 observed：${d310} < ${d8}`);
  assert.ok(d5000 < d1000, `5000 手必须比 1000 手更接近 observed：${d5000} < ${d1000}`);
});

test('P4b：可信度必须随机会数单调递增，且等于 n/(n+K)', () => {
  for (const n of [8, 100, 1000]) {
    const t = resolvePlayerProfile({
      baseArchetype: 'CALLING_STATION',
      observedStats: { handsObserved: n, foldToRiverBet: 0.2 },
    }).trace.find((x) => x.stat === 'foldToRiverBet')!;
    const expected = t.opportunities / (t.opportunities + t.priorWeight);
    assert.ok(
      Math.abs(t.confidence - expected) < 1e-12,
      `可信度必须 = n/(n+K)：实际 ${t.confidence}，期望 ${expected}`,
    );
  }
});

/* ============================================================
 * P5 —— 缺失字段 fallback
 * ============================================================ */

test('P5：缺失字段必须回落到先验，**绝不能当 0**', () => {
  const onlyPreflop = resolvePlayerProfile({
    baseArchetype: 'CALLING_STATION',
    observedStats: { handsObserved: 500, vpip: 0.52, pfr: 0.08 },
  });
  const missing = onlyPreflop.trace.filter((x) => x.observedRate === null);
  assert.ok(missing.length > 0, '未观测的字段必须被如实标为未观测');
  for (const m of missing) {
    assert.equal(m.confidence, 0, `未观测的「${m.stat}」可信度必须是 0`);
    assert.equal(
      m.effectiveRate, m.priorRate,
      `未观测的「${m.stat}」生效值必须**恰好等于先验**（不是 0）`,
    );
  }
  // 观测到的字段必须真的生效
  const vpip = onlyPreflop.trace.find((x) => x.stat === 'vpip')!;
  assert.ok(vpip.confidence > 0, '已观测的 vpip 必须可信度 > 0');
});

test('P5b：把缺失当 0 与真的观测到 0 必须产生**不同**结果', () => {
  const missing = resolvePlayerProfile({
    baseArchetype: 'CALLING_STATION', observedStats: { handsObserved: 500 },
  });
  const observedZero = resolvePlayerProfile({
    baseArchetype: 'CALLING_STATION',
    observedStats: { handsObserved: 500, foldToRiverBet: 0 },
  });
  const a = missing.trace.find((x) => x.stat === 'foldToRiverBet')!;
  const b = observedZero.trace.find((x) => x.stat === 'foldToRiverBet')!;
  assert.notEqual(a.effectiveRate, b.effectiveRate, '缺失与观测到 0 必须是不同结果');
  assert.equal(a.confidence, 0, '缺失 ⇒ 可信度 0');
  assert.ok(b.confidence > 0, '观测到 0 ⇒ 可信度 > 0（那是一条真实证据）');
});

/* ============================================================
 * P6 —— 极端数据防护
 * ============================================================ */

test('P6：极端 0/100% 数据不得崩溃、不得 NaN、概率必须归一', () => {
  const extremes: readonly PlayerObservedStats[] = [
    { handsObserved: 1000, vpip: 1, pfr: 0, threeBet: 1, wtsd: 1, foldToFlopCBet: 1, foldToTurnCBet: 1, foldToRiverBet: 1, flopCheckRaise: 1, turnCheckRaise: 1, riverCheckRaise: 1 },
    { handsObserved: 1000, vpip: 0, pfr: 1, threeBet: 0, wtsd: 0, foldToFlopCBet: 0, foldToTurnCBet: 0, foldToRiverBet: 0, flopCheckRaise: 0, turnCheckRaise: 0, riverCheckRaise: 0 },
  ];
  for (const stats of extremes) {
    const m = run('CALLING_STATION', stats);
    for (const s of SIZES) {
      const sum = (m.fold[s] as number) + (m.call[s] as number) + (m.raise[s] as number);
      assert.ok(Number.isFinite(sum), `${s} 的弃+跟+加必须是有限数`);
      assert.ok(
        Math.abs(sum - 1) < 1e-9,
        `${s} 的弃+跟+加必须 ≈ 1，实际 ${sum}`,
      );
      for (const f of ['fold', 'call', 'raise'] as const) {
        const v = m[f][s] as number;
        assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${f}[${s}] 必须 ∈ [0,1]，实际 ${v}`);
      }
    }
  }
});

test('P6b：极端数据下 resolved 维度仍必须落在 [0,1] 且有限', () => {
  const p = resolvePlayerProfile({
    baseArchetype: 'CALLING_STATION',
    observedStats: { handsObserved: 100000, vpip: 1, pfr: 1, wtsd: 1, foldToRiverBet: 1 },
  });
  for (const d of ['tightness', 'aggression', 'bluffTendency', 'passivity'] as const) {
    const v = p.resolved.dimensions[d];
    assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${d} 必须 ∈ [0,1] 且有限，实际 ${v}`);
  }
  for (const street of ['PREFLOP', 'FLOP', 'TURN', 'RIVER'] as const) {
    const f = p.resolved.street[street];
    for (const k of ['foldScale', 'callScale', 'checkRaiseScale'] as const) {
      assert.ok(Number.isFinite(f[k]) && f[k] > 0, `${street}.${k} 必须是正有限数，实际 ${f[k]}`);
    }
  }
});

/* ============================================================
 * P7 —— 非法输入保护
 * ============================================================ */

test('P7：非法输入必须被安全拒绝，绝不传播 NaN', () => {
  const cases: readonly { name: string; stats: Record<string, number | null>; hands: number }[] = [
    { name: 'NaN', stats: { vpip: Number.NaN }, hands: 100 },
    { name: 'Infinity', stats: { vpip: Number.POSITIVE_INFINITY }, hands: 100 },
    { name: '负数', stats: { vpip: -0.5 }, hands: 100 },
    { name: '百分数单位(52)', stats: { vpip: 52 }, hands: 100 },
    { name: '远超范围(9999)', stats: { foldToRiverBet: 9999 }, hands: 100 },
    { name: '负手数', stats: { vpip: 0.3 }, hands: -100 },
  ];
  for (const c of cases) {
    const r = normalizeObservedStats({
      handsObserved: c.hands,
      stats: c.stats as never,
    });
    for (const key of ALL_OBSERVED_STAT_KEYS) {
      const v = (r.stats as Record<string, number | null>)[key];
      if (v !== null && v !== undefined) {
        assert.ok(Number.isFinite(v), `「${c.name}」的 ${key} 不得是 NaN/Infinity`);
        assert.ok(v >= 0 && v <= 1, `「${c.name}」的 ${key} 必须 ∈ [0,1]，实际 ${v}`);
      }
    }
    assert.ok(Number.isFinite(r.stats.handsObserved) && r.stats.handsObserved >= 0,
      `「${c.name}」的 handsObserved 必须是非负有限数`);
    assert.ok(r.issues.length > 0, `「${c.name}」必须如实报出问题`);
  }
});

test('P7b：百分数（52）必须被**拒绝并提示**，不得静默除以 100', () => {
  const r = normalizeObservedStats({ handsObserved: 100, stats: { vpip: 52 } as never });
  assert.equal((r.stats as Record<string, number | null>)['vpip'], null, '52 必须被拒绝而不是换算');
  assert.ok(
    r.issues.some((i) => i.code === 'WRONG_UNIT_SUSPECTED'),
    '必须给出「单位可能写错」的诊断',
  );
});

test('P7c：极端/非法统计不得让决策产出 NaN', () => {
  const bad = run('CALLING_STATION', {
    handsObserved: 100,
    vpip: Number.NaN,
    foldToRiverBet: 52,
  } as PlayerObservedStats);
  for (const s of SIZES) {
    for (const f of ['fold', 'call', 'raise'] as const) {
      assert.ok(Number.isFinite(bad[f][s] as number), `${f}[${s}] 不得是 NaN`);
    }
  }
});

/* ============================================================
 * P8 —— 标签与实测矛盾时，实测随样本增长胜出
 * ============================================================ */

test('P8：CALLING_STATION 标签 + 1500 手 FoldRiver 61% ⇒ 实测必须纠正标签', () => {
  const contradiction: PlayerObservedStats = {
    handsObserved: 1500, vpip: 0.24, pfr: 0.18, wtsd: 0.22, foldToRiverBet: 0.61,
  };
  const p = resolvePlayerProfile({ baseArchetype: 'CALLING_STATION', observedStats: contradiction });
  const t = p.trace.find((x) => x.stat === 'foldToRiverBet')!;

  // 实测 61% > 标签先验 ⇒ 生效值必须被推向 61% 那一侧
  assert.ok(
    t.effectiveRate > t.priorRate,
    `实测 0.61 > 先验 ${t.priorRate} ⇒ 生效值必须更高，实际 ${t.effectiveRate}`,
  );
  // 维度也必须被推动（VPIP 24% 偏紧、WTSD 22% 偏低 ⇒ 不再像跟注站）
  assert.ok(
    p.resolved.dimensions.tightness > 0.5,
    `VPIP 24% 偏紧 ⇒ tightness 必须 > 0.5，实际 ${p.resolved.dimensions.tightness}`,
  );
  assert.ok(
    p.resolved.dimensions.passivity < 0.5,
    `WTSD 22% 偏低 ⇒ passivity 必须 < 0.5，实际 ${p.resolved.dimensions.passivity}`,
  );
});

test('P8b：样本越大，实测对维度的纠正越强（160 手 vs 1500 手）', () => {
  const dims = (n: number) =>
    resolvePlayerProfile({
      baseArchetype: 'CALLING_STATION',
      observedStats: { handsObserved: n, vpip: 0.24 },
    }).resolved.dimensions.tightness;
  assert.ok(
    dims(1500) > dims(160),
    `相同 VPIP 下，1500 手必须比 160 手把 tightness 推得更高：${dims(1500)} > ${dims(160)}`,
  );
});

/* ============================================================
 * P9 —— 分街隔离
 * ============================================================ */

test('P9：river 统计只影响 river，不得污染 flop / turn', () => {
  const p = resolvePlayerProfile({
    baseArchetype: 'CALLING_STATION',
    observedStats: { handsObserved: 1000, foldToRiverBet: 0.80 },
  });
  assert.notEqual(p.resolved.street.RIVER.foldScale, 1, 'river 必须被影响');
  assert.equal(p.resolved.street.FLOP.foldScale, 1, 'flop 必须**不受** river 统计影响');
  assert.equal(p.resolved.street.TURN.foldScale, 1, 'turn 必须**不受** river 统计影响');
});

test('P9b：flop 统计只影响 flop', () => {
  const p = resolvePlayerProfile({
    baseArchetype: 'CALLING_STATION',
    observedStats: { handsObserved: 1000, foldToFlopCBet: 0.85 },
  });
  assert.notEqual(p.resolved.street.FLOP.foldScale, 1, 'flop 必须被影响');
  assert.equal(p.resolved.street.RIVER.foldScale, 1, 'river 必须不受 flop 统计影响');
});

test('P9c：过牌-加注统计只影响自己那一街', () => {
  const p = resolvePlayerProfile({
    baseArchetype: 'CALLING_STATION',
    observedStats: { handsObserved: 1000, flopCheckRaise: 0.50 },
  });
  assert.notEqual(p.resolved.street.FLOP.checkRaiseScale, 1, 'flop XR 必须被影响');
  assert.equal(p.resolved.street.RIVER.checkRaiseScale, 1, 'river XR 必须不受 flop XR 影响');
  assert.equal(p.resolved.street.TURN.checkRaiseScale, 1, 'turn XR 必须不受 flop XR 影响');
});

test('P9d：**方向**——河牌弃牌率高 ⇒ 河牌 fold 因子 > 1；低 ⇒ < 1', () => {
  const high = resolvePlayerProfile({
    baseArchetype: 'CALLING_STATION',
    observedStats: { handsObserved: 2000, foldToRiverBet: 0.80 },
  });
  const low = resolvePlayerProfile({
    baseArchetype: 'CALLING_STATION',
    observedStats: { handsObserved: 2000, foldToRiverBet: 0.15 },
  });
  assert.ok(high.resolved.street.RIVER.foldScale > 1, '弃牌率高 ⇒ foldScale > 1');
  assert.ok(low.resolved.street.RIVER.foldScale < 1, '弃牌率低 ⇒ foldScale < 1');
});

/* ============================================================
 * P10 —— 持久化兼容（序列化 / 反序列化 / 迁移）
 * ============================================================ */

test('P10：连续统计必须可序列化/反序列化并产生**相同**结果', () => {
  const p1 = resolvePlayerProfile({ baseArchetype: 'CALLING_STATION', observedStats: LAOZHOU });
  const roundTripped = JSON.parse(JSON.stringify(p1.observedStats)) as PlayerObservedStats;
  const p2 = resolvePlayerProfile({ baseArchetype: 'CALLING_STATION', observedStats: roundTripped });

  assert.deepEqual(p2.resolved.dimensions, p1.resolved.dimensions, '维度必须逐位一致');
  assert.deepEqual(p2.resolved.street, p1.resolved.street, '分街因子必须逐位一致');
  assert.equal(p2.observedStatCount, p1.observedStatCount);
});

test('P10b：V2 旧档案（没有 observedStats 字段）必须能正常读取', () => {
  // 模拟从旧版本存储读出来的对象：**根本没有** observedStats 字段
  const legacyProfile = { playerId: 'laozhou', handsObserved: 310, metrics: {} };
  const stats = (legacyProfile as { observedStats?: PlayerObservedStats }).observedStats ?? null;
  const p = resolvePlayerProfile({ baseArchetype: 'CALLING_STATION', observedStats: stats });
  assert.equal(p.observedStatCount, 0, '旧档案必须被解析成「无统计」而不是报错');
  assert.equal(p.resolved.street.RIVER.foldScale, 1, '旧档案必须走 V2 恒等路径');
});

test('P10c：迁移必须保留标签，且默认 observedStats = null（不要求用户重建画像）', () => {
  const legacy = { playerId: 'p1', quickProfile: 'CALLING_STATION' };
  const migrated = {
    ...legacy,
    observedStats: (legacy as { observedStats?: PlayerObservedStats }).observedStats ?? null,
  };
  assert.equal(migrated.quickProfile, 'CALLING_STATION', '标签必须原样保留');
  assert.equal(migrated.observedStats, null, '迁移后默认无统计');
  const p = resolvePlayerProfile({
    baseArchetype: migrated.quickProfile as never,
    observedStats: migrated.observedStats,
  });
  assert.equal(p.baseArchetype, 'CALLING_STATION', 'baseArchetype 必须保留（§四 三层概念）');
});

/* ============================================================
 * P11 —— 概率守恒
 * ============================================================ */

test('P11：Fold + Call + Raise 必须 ≈ 1（含分街系数介入时）', () => {
  const variants: readonly (PlayerObservedStats | null)[] = [
    null, LAOZHOU,
    { handsObserved: 2000, foldToRiverBet: 0.9 },
    { handsObserved: 2000, foldToRiverBet: 0.02 },
    { handsObserved: 2000, foldToRiverBet: 0.5, riverCheckRaise: 0.6 },
  ];
  for (const [i, stats] of variants.entries()) {
    const m = run('CALLING_STATION', stats);
    for (const s of SIZES) {
      const sum = (m.fold[s] as number) + (m.call[s] as number) + (m.raise[s] as number);
      assert.ok(Math.abs(sum - 1) < 1e-9, `变体 ${i} 的 ${s} 合计必须 ≈ 1，实际 ${sum}`);
    }
  }
});

/* ============================================================
 * P12 —— 确定性
 * ============================================================ */

test('P12：相同输入 + 固定种子必须逐位可复现', () => {
  const a = run('CALLING_STATION', LAOZHOU);
  const b = run('CALLING_STATION', LAOZHOU);
  for (const s of SIZES) {
    assert.equal(a.fold[s], b.fold[s], `${s} fold 必须逐位一致`);
    assert.equal(a.call[s], b.call[s], `${s} call 必须逐位一致`);
    assert.equal(a.score[s], b.score[s], `${s} score 必须逐位一致`);
  }
  assert.equal(a.action, b.action);
  assert.equal(a.streetFoldScale, b.streetFoldScale);
});

test('P12b：`resolvePlayerProfile` 必须是纯函数（同输入同输出，且不冻结失败）', () => {
  const mk = () => resolvePlayerProfile({ baseArchetype: 'CALLING_STATION', observedStats: LAOZHOU });
  const a = mk();
  const b = mk();
  assert.deepEqual(a.resolved, b.resolved);
  assert.equal(Object.isFrozen(a.resolved.dimensions), true, '结果必须冻结');
  // 传入的 stats 对象不得被修改
  const stats: PlayerObservedStats = { ...LAOZHOU };
  const before = JSON.stringify(stats);
  resolvePlayerProfile({ baseArchetype: 'CALLING_STATION', observedStats: stats });
  assert.equal(JSON.stringify(stats), before, '入参不得被就地修改');
});

/* ============================================================
 * P13 —— 不破坏既有 PROFILE_AB_AUDIT 的结论
 * ============================================================ */

test('P13：V3 不得改变「无统计时 CALLING_STATION vs NORMAL」的既有方向', () => {
  const station = run('CALLING_STATION');
  const normal = run('NORMAL');
  for (const s of SIZES) {
    assert.ok(
      station.fold[s]! < normal.fold[s]!,
      `${s}：跟注站弃牌率仍必须低于普通玩家（V2 结论不得被 V3 破坏）`,
    );
    assert.ok(
      station.call[s]! > normal.call[s]!,
      `${s}：跟注站跟注率仍必须高于普通玩家`,
    );
  }
});

/* ============================================================
 * 结构性：K 分档与因子有界
 * ============================================================ */

test('结构性：统计必须按频次分为高/中/低三档，且 K 随档递增', () => {
  const kOf = (stat: keyof typeof STAT_EVIDENCE_SPECS): number =>
    STAT_EVIDENCE_SPECS[stat].priorWeight;
  assert.ok(kOf('vpip') < kOf('threeBet'), '高频 K 必须小于中频 K');
  assert.ok(kOf('threeBet') < kOf('foldToRiverBet'), '中频 K 必须小于低频 K');
  assert.equal(STAT_EVIDENCE_SPECS.vpip.frequencyTier, 'HIGH');
  assert.equal(STAT_EVIDENCE_SPECS.wtsd.frequencyTier, 'MEDIUM');
  assert.equal(STAT_EVIDENCE_SPECS.foldToRiverBet.frequencyTier, 'LOW');
});

test('结构性：分街因子必须有界（不得因极端统计而爆炸）', () => {
  assert.ok(Math.abs(streetFactorOf(1) - 1) <= 0.35 + 1e-12, '最极端值下因子必须 ≤ 1.35');
  assert.ok(Math.abs(streetFactorOf(0) - 1) <= 0.35 + 1e-12, '最极端值下因子必须 ≥ 0.65');
  assert.equal(streetFactorOf(0.5), 1, '中立值必须精确给出 1');
});
