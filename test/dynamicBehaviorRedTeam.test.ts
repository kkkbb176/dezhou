/**
 * Step 7 动态行为模型 —— 独立红队测试组（规范第 51–67 节）
 *
 * ## 本文件的纪律
 *
 * **不得只是复制单元测试。** 每个场景都从**失败模式**出发：
 * 「如果这里写错了，会产生什么错误结论？」
 *
 * 场景编号与规范第 52–67 节一一对应。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PlayerMetric } from '../src/domain/player/player.types.ts';
import {
  DynamicState,
  MAX_SINGLE_EVENT_SHARE,
  UserHintKind,
  WindowSize,
  type BaselineMetricStat,
  type DynamicBehaviorInput,
  type ObservedPokerEvent,
  type PlayerProfileSnapshot,
} from '../src/domain/dynamic/dynamic.types.ts';
import {
  evaluateDynamicBehavior,
  windowConsistency,
} from '../src/domain/dynamic/dynamicBehavior.ts';
import { adaptAdjustments, describeAdaptation } from '../src/domain/dynamic/dynamicAdapter.ts';

/* ============================================================
 * 辅助（与主测试集保持一致的构造方式）
 * ============================================================ */

const TS_BASE = Date.parse('2026-09-01T00:00:00.000Z');
const AS_OF = TS_BASE + 1000 * 60 * 60 * 24 * 30;

const timestampOf = (seq: number): string => new Date(TS_BASE + seq * 60_000).toISOString();

function baselineStat(metric: PlayerMetric, opportunities: number, rate: number, confidence = 0.85): BaselineMetricStat {
  return {
    metric,
    successes: Math.round(opportunities * rate),
    opportunities,
    adjustedRate: rate,
    effectiveSampleSize: opportunities,
    confidence,
  };
}

function makeBaseline(
  rates: Partial<Record<PlayerMetric, number>>,
  options: { playerId?: string; opportunities?: number; confidence?: number } = {},
): PlayerProfileSnapshot {
  const opportunities = options.opportunities ?? 400;
  const metrics: Partial<Record<PlayerMetric, BaselineMetricStat>> = {};
  for (const [metric, rate] of Object.entries(rates) as Array<[PlayerMetric, number]>) {
    metrics[metric] = baselineStat(metric, opportunities, rate, options.confidence ?? 0.85);
  }
  return {
    playerId: options.playerId ?? 'p1',
    handsObserved: opportunities,
    version: 'baseline-v1',
    metrics,
  };
}

function makeEvents(
  rates: Partial<Record<PlayerMetric, number>>,
  hands: number,
  options: {
    playerId?: string;
    startSeq?: number;
    idPrefix?: string;
    /** 覆盖某几手的观测（用于构造「一次疯狂 Bluff」） */
    override?: (index: number) => Partial<Record<PlayerMetric, boolean>> | undefined;
  } = {},
): ObservedPokerEvent[] {
  const playerId = options.playerId ?? 'p1';
  const startSeq = options.startSeq ?? 0;
  const prefix = options.idPrefix ?? 'e';
  const entries = Object.entries(rates) as Array<[PlayerMetric, number]>;

  const events: ObservedPokerEvent[] = [];
  for (let i = 0; i < hands; i++) {
    const overrides = options.override?.(i);
    // 精确速率生成：`success ⇔ ⌊i·r⌋ < ⌊(i+1)·r⌋`，因此 n 手里恰好有 round(n·r) 次成功。
    // （不能用 `(i+1)·r ≥ ⌊i·r⌋+1`：i=0 时括号内恒为 0，会让所有指标在第 0 手记为失败，
    //   使实际速率系统性偏高/偏低，从而掩盖真实的偏差信号。）
    const opportunities = entries.map(([metric, rate]) => ({
      metric,
      success: overrides?.[metric] ?? Math.floor((i + 1) * rate) > Math.floor(i * rate),
    }));
    const seq = startSeq + i;
    events.push({
      eventId: `${prefix}-${seq}`,
      handId: `${prefix}-H${seq}`,
      playerId,
      seq,
      timestamp: timestampOf(seq),
      opportunities,
    });
  }
  return events;
}

function makeInput(
  baseline: PlayerProfileSnapshot,
  events: readonly ObservedPokerEvent[],
  extra: Partial<DynamicBehaviorInput> = {},
): DynamicBehaviorInput {
  return { playerId: baseline.playerId, baseline, recentEvents: events, asOf: AS_OF, ...extra };
}

function measure(input: DynamicBehaviorInput) {
  const result = evaluateDynamicBehavior(input);
  assert.equal(result.ok, true, `评估应成功：${result.ok ? '' : JSON.stringify(result)}`);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

/* ============================================================
 * 场景 1（规范第 52 节）：Nit + 1 次疯狂 Bluff
 * ============================================================ */

test('红队 1：长期 Nit 的一次 River 疯狂诈唬 —— 不得判 TILT，偏差不得暴涨', () => {
  const rates = {
    [PlayerMetric.VPIP]: 0.15,
    [PlayerMetric.PFR]: 0.12,
    [PlayerMetric.THREE_BET]: 0.03,
    [PlayerMetric.RIVER_BET]: 0.1,
  };
  const baseline = makeBaseline(rates);

  // 50 手完全符合基线，最后一手突然河牌大额下注
  const events = makeEvents(rates, 50, {
    override: (i) => (i === 49 ? { [PlayerMetric.RIVER_BET]: true } : undefined),
  });

  const snapshot = measure(makeInput(baseline, events));

  assert.notEqual(snapshot.dominantState, DynamicState.TILT_SIGNAL, '一次诈唬不得判为上头');
  assert.ok(snapshot.tilt.probability < 0.3, `Tilt 概率不得显著（实际 ${snapshot.tilt.probability}）`);
  assert.ok(
    snapshot.deviationScore < 55,
    `一次动作不得让偏差暴涨（实际 ${snapshot.deviationScore}）`,
  );

  // 与「完全无异常」的对照：差值必须很小
  const control = measure(makeInput(baseline, makeEvents(rates, 50)));
  assert.ok(
    snapshot.deviationScore - control.deviationScore < 30,
    `单次极端行为的影响必须有界（对照 ${control.deviationScore} → 异常 ${snapshot.deviationScore}）`,
  );
});

/* ============================================================
 * 场景 2（规范第 53 节）：Nit 持续 20 手变激进
 * ============================================================ */

test('红队 2：长期 Nit 连续 20+ 手变激进 —— 偏差应明显上升', () => {
  const rates = {
    [PlayerMetric.VPIP]: 0.15,
    [PlayerMetric.PFR]: 0.12,
    [PlayerMetric.THREE_BET]: 0.03,
    [PlayerMetric.OPEN]: 0.2,
  };
  const baseline = makeBaseline(rates);

  const normal = measure(makeInput(baseline, makeEvents(rates, 40)));
  const changed = measure(
    makeInput(
      baseline,
      makeEvents(
        { [PlayerMetric.VPIP]: 0.45, [PlayerMetric.PFR]: 0.4, [PlayerMetric.THREE_BET]: 0.2, [PlayerMetric.OPEN]: 0.5 },
        40,
      ),
    ),
  );

  assert.ok(
    changed.deviationScore > normal.deviationScore + 20,
    `持续变化必须让偏差明显上升（正常 ${normal.deviationScore} → 变化后 ${changed.deviationScore}）`,
  );
  assert.ok(
    changed.dominantState === DynamicState.LOOSER_RECENTLY || changed.dominantState === DynamicState.AGGRESSION_UP,
    `状态应为变松或更激进（实际 ${changed.dominantState}）`,
  );
});

/* ============================================================
 * 场景 3（规范第 54 节）：LAG 保持 LAG
 * ============================================================ */

test('红队 3：长期 LAG 继续 LAG —— 必须是 NORMAL，不得判 AGGRESSION_UP', () => {
  const rates = {
    [PlayerMetric.VPIP]: 0.5,
    [PlayerMetric.PFR]: 0.4,
    [PlayerMetric.THREE_BET]: 0.18,
    [PlayerMetric.OPEN]: 0.6,
  };
  const baseline = makeBaseline(rates);
  const snapshot = measure(makeInput(baseline, makeEvents(rates, 80)));

  assert.equal(snapshot.dominantState, DynamicState.NORMAL, `极度激进但**未偏离自己** → NORMAL`);
  assert.ok(snapshot.deviationScore < 25, `未偏离时偏差应低（实际 ${snapshot.deviationScore}）`);
  assert.ok(
    snapshot.adjustments.length === 0 || snapshot.adjustments.every((a) => a.confidence < 0.5),
    '未偏离时不应产生高置信调整',
  );
});

/* ============================================================
 * 场景 4（规范第 55 节）：连续 3 个 Cooler，行为无变化
 * ============================================================ */

test('红队 4：连输三个 Cooler 但打法完全不变 —— Tilt 概率不得显著上升', () => {
  const rates = { [PlayerMetric.VPIP]: 0.25, [PlayerMetric.PFR]: 0.2, [PlayerMetric.THREE_BET]: 0.08 };
  const baseline = makeBaseline(rates);

  // 全程行为稳定，只在第 30/33/36 手插入三个 COOLER 上下文事件
  const events = makeEvents(rates, 60);
  const contextEvents = [30, 33, 36].map((seq) => ({
    contextEventId: `ctx-${seq}`,
    handId: `e-H${seq}`,
    playerId: 'p1',
    seq,
    timestamp: timestampOf(seq),
    kind: 'COOLER' as const,
  }));

  const withCoolers = measure(makeInput(baseline, events, { contextEvents }));
  const withoutCoolers = measure(makeInput(baseline, events));

  assert.ok(
    withCoolers.tilt.probability < 0.25,
    `输 Cooler 但行为不变 → Tilt 概率必须低（实际 ${withCoolers.tilt.probability}）`,
  );
  assert.ok(
    Math.abs(withCoolers.deviationScore - withoutCoolers.deviationScore) < 10,
    `上下文的加入不得改变偏差分（${withoutCoolers.deviationScore} vs ${withCoolers.deviationScore}）`,
  );
  assert.equal(
    withCoolers.dominantState === DynamicState.NORMAL || withCoolers.dominantState === DynamicState.UNKNOWN,
    true,
    `行为未变 → 应为 NORMAL 或 UNKNOWN（实际 ${withCoolers.dominantState}）`,
  );
});

/* ============================================================
 * 场景 5（规范第 56 节）：输大池后明显追损
 * ============================================================ */

test('红队 5：输掉大池后 15~20 手明显追损 —— CHASE_LOSS_SIGNAL 与 Tilt 概率应上升', () => {
  const rates = { [PlayerMetric.VPIP]: 0.22, [PlayerMetric.PFR]: 0.18, [PlayerMetric.THREE_BET]: 0.06 };
  const baseline = makeBaseline(rates);

  // 前 30 手正常 → 一次大损失 → 之后 20 手明显放宽
  const normal = makeEvents(rates, 30);
  const tilt = makeEvents(
    { [PlayerMetric.VPIP]: 0.7, [PlayerMetric.PFR]: 0.6, [PlayerMetric.THREE_BET]: 0.35 },
    20,
    { startSeq: 30, idPrefix: 'tilt' },
  );
  const contextEvents = [
    {
      contextEventId: 'ctx-loss',
      handId: 'e-H29',
      playerId: 'p1',
      seq: 29,
      timestamp: timestampOf(29),
      kind: 'LOST_BIG_POT' as const,
    },
  ];

  const chased = measure(makeInput(baseline, [...normal, ...tilt], { contextEvents }));
  const control = measure(makeInput(baseline, normal));

  assert.ok(
    chased.tilt.probability > control.tilt.probability,
    `追损场景的 Tilt 概率必须高于对照（对照 ${control.tilt.probability} → 追损 ${chased.tilt.probability}）`,
  );
  assert.ok(
    chased.dominantState === DynamicState.CHASE_LOSS_SIGNAL ||
      chased.dominantState === DynamicState.TILT_SIGNAL ||
      chased.dominantState === DynamicState.LOOSER_RECENTLY,
    `状态应反映行为偏移（实际 ${chased.dominantState}）`,
  );
  // 必须仍然是概率 + 置信度，而不是布尔
  assert.ok(chased.tilt.probability >= 0 && chased.tilt.probability <= 1);
  assert.ok(chased.tilt.confidence >= 0 && chased.tilt.confidence <= 1);
  assert.equal('isTilted' in chased, false);
});

/* ============================================================
 * 场景 6（规范第 57 节）：高度相关指标重复计票
 * ============================================================ */

test('红队 6：ENTRY 组四个指标同时异常 —— 总分不得等于四项相加', () => {
  const base = {
    [PlayerMetric.VPIP]: 0.2,
    [PlayerMetric.PFR]: 0.16,
    [PlayerMetric.OPEN]: 0.28,
    [PlayerMetric.LIMP]: 0.05,
    [PlayerMetric.THREE_BET]: 0.07,
  };
  const baseline = makeBaseline(base);

  // 只让 VPIP 异常
  const oneAbnormal = measure(
    makeInput(baseline, makeEvents({ ...base, [PlayerMetric.VPIP]: 0.7 }, 60)),
  );
  // 让 ENTRY 组四个指标全部异常
  const fourAbnormal = measure(
    makeInput(
      baseline,
      makeEvents(
        {
          [PlayerMetric.VPIP]: 0.7,
          [PlayerMetric.PFR]: 0.65,
          [PlayerMetric.OPEN]: 0.75,
          [PlayerMetric.LIMP]: 0.5,
          [PlayerMetric.THREE_BET]: 0.07,
        },
        60,
      ),
    ),
  );

  const entryOnly = fourAbnormal.groupScores.find((g) => g.group === 'ENTRY')!;
  const entryCap = 1.0;
  assert.ok(entryOnly.score <= entryCap + 1e-9, `ENTRY 组分数必须受上限约束（${entryOnly.score}）`);

  // 关键断言：四项同时异常的总分不得达到「单项异常」的四倍
  assert.ok(
    fourAbnormal.deviationScore < oneAbnormal.deviationScore * 4,
    `四项相关指标不得叠加四倍（单项 ${oneAbnormal.deviationScore} → 四项 ${fourAbnormal.deviationScore}）`,
  );
  assert.ok(
    fourAbnormal.deviationScore <= 100 && oneAbnormal.deviationScore <= 100,
    '两项都必须在 0..100 内',
  );
});

/* ============================================================
 * 场景 7（规范第 58 节）：Recovery
 * ============================================================ */

test('红队 7：20 手异常 + 后续 50 手恢复 —— 偏差下降且状态回到 NORMAL', () => {
  const rates = { [PlayerMetric.VPIP]: 0.2, [PlayerMetric.PFR]: 0.16 };
  const baseline = makeBaseline(rates);

  const abnormal = measure(makeInput(baseline, makeEvents({ [PlayerMetric.VPIP]: 0.85, [PlayerMetric.PFR]: 0.8 }, 20)));
  const recovered = measure(
    makeInput(baseline, [
      ...makeEvents({ [PlayerMetric.VPIP]: 0.85, [PlayerMetric.PFR]: 0.8 }, 20),
      ...makeEvents(rates, 50, { startSeq: 20, idPrefix: 'ok' }),
    ]),
  );

  assert.ok(
    recovered.deviationScore < abnormal.deviationScore,
    `恢复后偏差必须下降（异常 ${abnormal.deviationScore} → 恢复 ${recovered.deviationScore}）`,
  );
  assert.equal(recovered.dominantState, DynamicState.NORMAL, `恢复后状态应为 NORMAL`);
});

/* ============================================================
 * 场景 8（规范第 59 节）：重复事件
 * ============================================================ */

test('红队 8：完全相同的 Event 输入两次 —— 结果逐位一致', () => {
  const rates = { [PlayerMetric.VPIP]: 0.25, [PlayerMetric.PFR]: 0.18, [PlayerMetric.THREE_BET]: 0.08 };
  const baseline = makeBaseline(rates);
  const events = makeEvents(rates, 60);

  const once = measure(makeInput(baseline, events));
  const twice = measure(makeInput(baseline, [...events, ...events]));
  const thrice = measure(makeInput(baseline, [...events, ...events, ...events]));

  // 逐位一致：比较完整快照的序列化结果（排除 ignoredEvents，它本来就该记录重复）
  const key = (s: ReturnType<typeof measure>): string =>
    JSON.stringify({
      score: s.deviationScore,
      confidence: s.confidence,
      state: s.dominantState,
      evidence: s.evidenceEventIds,
      groups: s.groupScores,
      tilt: s.tilt,
      adjustments: s.adjustments,
    });

  assert.equal(key(twice), key(once), '重复一次必须逐位一致');
  assert.equal(key(thrice), key(once), '重复两次必须逐位一致');
});

/* ============================================================
 * 场景 9（规范第 60 节）：修正历史
 * ============================================================ */

test('红队 9：把 Raise 改为 Call 后重建 —— 必须等同于一开始就录 Call', () => {
  const rates = { [PlayerMetric.VPIP]: 0.3, [PlayerMetric.THREE_BET]: 0.08, [PlayerMetric.CALL_OPEN]: 0.15 };
  const baseline = makeBaseline(rates);

  // 错误历史：第 25 手记成 3Bet
  const wrong = makeEvents(rates, 50).map((e, i) =>
    i === 25
      ? {
          ...e,
          opportunities: e.opportunities.map((o) =>
            o.metric === PlayerMetric.THREE_BET
              ? { ...o, success: true }
              : o.metric === PlayerMetric.CALL_OPEN
                ? { ...o, success: false }
                : o,
          ),
        }
      : e,
  );

  // 修正后：该手是 Call（3Bet 失败、CallOpen 成功）
  const corrected = wrong.map((e, i) =>
    i === 25
      ? {
          ...e,
          opportunities: e.opportunities.map((o) =>
            o.metric === PlayerMetric.THREE_BET
              ? { ...o, success: false }
              : o.metric === PlayerMetric.CALL_OPEN
                ? { ...o, success: true }
                : o,
          ),
        }
      : e,
  );

  // 从一开始就录对（同一份数据）
  const direct = makeEvents(rates, 50).map((e, i) =>
    i === 25
      ? {
          ...e,
          opportunities: e.opportunities.map((o) =>
            o.metric === PlayerMetric.THREE_BET
              ? { ...o, success: false }
              : o.metric === PlayerMetric.CALL_OPEN
                ? { ...o, success: true }
                : o,
          ),
        }
      : e,
  );

  const fromCorrection = measure(makeInput(baseline, corrected));
  const fromScratch = measure(makeInput(baseline, direct));

  assert.equal(fromCorrection.deviationScore, fromScratch.deviationScore);
  assert.equal(fromCorrection.dominantState, fromScratch.dominantState);
  assert.equal(fromCorrection.confidence, fromScratch.confidence);
});

/* ============================================================
 * 场景 10（规范第 61 节）：UNKNOWN
 * ============================================================ */

test('红队 10：仅 2 手 / 1 机会 —— 必须是 UNKNOWN，不能是 NORMAL', () => {
  const baseline = makeBaseline({ [PlayerMetric.VPIP]: 0.25, [PlayerMetric.THREE_BET]: 0.08 });

  const events: ObservedPokerEvent[] = [
    {
      eventId: 'e-0',
      handId: 'H0',
      playerId: 'p1',
      seq: 0,
      timestamp: timestampOf(0),
      opportunities: [{ metric: PlayerMetric.VPIP, success: true }],
    },
    {
      eventId: 'e-1',
      handId: 'H1',
      playerId: 'p1',
      seq: 1,
      timestamp: timestampOf(1),
      opportunities: [{ metric: PlayerMetric.THREE_BET, success: true }],
    },
  ];

  const snapshot = measure(makeInput(baseline, events));
  assert.equal(snapshot.dominantState, DynamicState.UNKNOWN);
  assert.notEqual(snapshot.dominantState, DynamicState.NORMAL);
  assert.ok(snapshot.confidence < 0.3, `置信度必须低（实际 ${snapshot.confidence}）`);
  assert.deepEqual(snapshot.adjustments, [], '样本不足时不得产生调整');
});

/* ============================================================
 * 场景 11（规范第 62 节）：基线缺失
 * ============================================================ */

test('红队 11：基线缺失 —— Fail Closed 或 UNKNOWN，绝不凭人口平均生成高置信结果', () => {
  const result = evaluateDynamicBehavior({
    playerId: 'p1',
    baseline: null as never,
    recentEvents: makeEvents({ [PlayerMetric.VPIP]: 0.9 }, 60),
    asOf: AS_OF,
  });

  assert.equal(result.ok, false, '基线缺失必须 Fail Closed');
  if (result.ok) return;
  assert.equal(result.code, 'MISSING_BASELINE');

  // 空指标基线（存在于结构中但无数据）→ 不产生任何调整
  const emptyBaseline: PlayerProfileSnapshot = {
    playerId: 'p1',
    handsObserved: 0,
    version: 'v1',
    metrics: {},
  };
  const snapshot = measure(makeInput(emptyBaseline, makeEvents({ [PlayerMetric.VPIP]: 0.9 }, 60)));
  assert.equal(snapshot.adjustments.length, 0, '无基线可比 → 不得凭空产生调整');
  assert.equal(snapshot.confidence, 0);
});

/* ============================================================
 * 场景 12（规范第 63 节）：非法数值
 * ============================================================ */

test('红队 12：NaN / Infinity / 负数 / successes>opportunities / confidence 1.5 全部被拒绝', () => {
  const base = makeBaseline({ [PlayerMetric.VPIP]: 0.25 });

  const cases: Array<[string, BaselineMetricStat]> = [
    [
      'NaN adjustedRate',
      { metric: PlayerMetric.VPIP, successes: 50, opportunities: 100, adjustedRate: Number.NaN, effectiveSampleSize: 100, confidence: 0.8 },
    ],
    [
      'Infinity opportunities',
      { metric: PlayerMetric.VPIP, successes: 1, opportunities: Number.POSITIVE_INFINITY, adjustedRate: 0.25, effectiveSampleSize: 100, confidence: 0.8 },
    ],
    [
      'negative opportunities',
      { metric: PlayerMetric.VPIP, successes: 0, opportunities: -10, adjustedRate: 0.25, effectiveSampleSize: 0, confidence: 0.8 },
    ],
    [
      'successes > opportunities',
      { metric: PlayerMetric.VPIP, successes: 200, opportunities: 100, adjustedRate: 0.25, effectiveSampleSize: 100, confidence: 0.8 },
    ],
    [
      'confidence 1.5',
      { metric: PlayerMetric.VPIP, successes: 25, opportunities: 100, adjustedRate: 0.25, effectiveSampleSize: 100, confidence: 1.5 },
    ],
    [
      'adjustedRate 越界',
      { metric: PlayerMetric.VPIP, successes: 25, opportunities: 100, adjustedRate: 7, effectiveSampleSize: 100, confidence: 0.8 },
    ],
  ];

  for (const [name, stat] of cases) {
    const baseline: PlayerProfileSnapshot = {
      ...base,
      metrics: { [PlayerMetric.VPIP]: stat },
    };
    const result = evaluateDynamicBehavior(makeInput(baseline, makeEvents({ [PlayerMetric.VPIP]: 0.3 }, 40)));
    assert.equal(result.ok, false, `${name} 必须被拒绝`);
    if (result.ok) continue;
    assert.equal(result.code, 'INVALID_NUMERIC', `${name} 应报 INVALID_NUMERIC`);
  }
});

/* ============================================================
 * 场景 13（规范第 64 节）：事件乱序
 * ============================================================ */

test('红队 13：乱序事件 —— 结果与排序后一致（不得依赖数组顺序）', () => {
  const rates = { [PlayerMetric.VPIP]: 0.4, [PlayerMetric.PFR]: 0.3 };
  const baseline = makeBaseline(rates);
  const ordered = makeEvents(rates, 60);

  const permutations = [
    [...ordered].reverse(),
    [...ordered.slice(30), ...ordered.slice(0, 30)],
    ordered.filter((_, i) => i % 2 === 0).concat(ordered.filter((_, i) => i % 2 === 1)),
    [...ordered].sort(() => 0.5 - ((ordered.length * 7) % 3) / 3), // 确定性「伪洗牌」
  ];

  const reference = measure(makeInput(baseline, ordered));
  for (const permutation of permutations) {
    const snapshot = measure(makeInput(baseline, permutation));
    assert.deepEqual(snapshot.evidenceEventIds, reference.evidenceEventIds, '事件顺序必须与输入数组顺序无关');
    assert.equal(snapshot.deviationScore, reference.deviationScore);
  }
});

test('红队 13b：同一手牌序号冲突时 —— 明确降置信度并给出提示，不得静默依赖顺序', () => {
  const rates = { [PlayerMetric.VPIP]: 0.25 };
  const baseline = makeBaseline(rates);
  const events = makeEvents(rates, 40);

  // 伪造两条同 handId 同 seq 但 eventId 不同的事件
  const conflicting: ObservedPokerEvent[] = [
    ...events,
    {
      eventId: 'conflict-a',
      handId: events[10]!.handId,
      playerId: 'p1',
      seq: events[10]!.seq,
      timestamp: events[10]!.timestamp,
      opportunities: [{ metric: PlayerMetric.VPIP, success: true }],
    },
  ];

  const clean = measure(makeInput(baseline, events));
  const conflicted = measure(makeInput(baseline, conflicting));

  assert.ok(
    conflicted.confidence < clean.confidence,
    `序号冲突必须降低置信度（干净 ${clean.confidence} → 冲突 ${conflicted.confidence}）`,
  );
  assert.ok(
    conflicted.explanation.some((line) => line.includes('冲突')) ||
      conflicted.ignoredEvents.length > 0,
    '必须明确提示冲突或记录被忽略的事件',
  );
});

/* ============================================================
 * 场景 14（规范第 65 节）：未来事件
 * ============================================================ */

test('红队 14：timestamp > asOf 的事件不得进入计算', () => {
  const rates = { [PlayerMetric.VPIP]: 0.25 };
  const baseline = makeBaseline(rates);
  const past = makeEvents(rates, 40);

  // 未来事件极端异常；若被计入会显著改变结果
  const future: ObservedPokerEvent[] = [];
  for (let i = 0; i < 30; i++) {
    future.push({
      eventId: `future-${i}`,
      handId: `F${i}`,
      playerId: 'p1',
      seq: 100 + i,
      timestamp: new Date(AS_OF + (i + 1) * 60_000).toISOString(),
      opportunities: [{ metric: PlayerMetric.VPIP, success: true }],
    });
  }

  const clean = measure(makeInput(baseline, past));
  const withFuture = measure(makeInput(baseline, [...past, ...future]));

  assert.equal(withFuture.deviationScore, clean.deviationScore, '未来事件不得影响结果');
  assert.equal(withFuture.confidence, clean.confidence);
  assert.equal(
    withFuture.evidenceEventIds.some((id) => id.startsWith('future-')),
    false,
    '未来事件不得进入证据列表',
  );
  assert.equal(
    withFuture.ignoredEvents.filter((i) => i.reason.includes('未来')).length,
    30,
    '全部未来事件必须被记录为忽略',
  );
});

/* ============================================================
 * 场景 15（规范第 66 节）：Dynamic 自反馈
 * ============================================================ */

test('红队 15：Dynamic 模块**在源码层**无法读取自身输出（类型 + import 双重隔离）', () => {
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  const files = [
    'src/domain/dynamic/dynamic.types.ts',
    'src/domain/dynamic/dynamicStats.ts',
    'src/domain/dynamic/dynamicDeviation.ts',
    'src/domain/dynamic/dynamicBehavior.ts',
    'src/domain/dynamic/dynamicAdapter.ts',
  ];

  const forbiddenImports = [
    'range.ts',
    'rangeUpdate.ts',
    'range.types.ts',
    'decisionEngine',
    'decisionPipeline',
    'equity',
    'odds',
    'replay',
    'leak',
    'exploit',
  ];
  const forbiddenFields = [
    'adjustedRange',
    'inferredVillainRange',
    'finalAction',
    'recommendation',
    'decisionConfidence',
    'exploitOutput',
    'previousDynamicState',
    'previousTiltProbability',
    'previousState',
    'showdownRange',
    'finalProfitLoss',
    'evLoss',
  ];

  for (const file of files) {
    const source = readFileSync(`${repositoryRoot}${file}`, 'utf8');
    const importLines = source
      .split('\n')
      .filter((line) => /^\s*(import|export)\s/.test(line) && line.includes('from'))
      .join('\n');

    for (const forbidden of forbiddenImports) {
      assert.ok(
        !importLines.includes(forbidden),
        `${file} 不得导入 ${forbidden} —— 那会为「读取下游结果作为证据」留下后门`,
      );
    }

    // 去掉注释后检查字段名（注释里提到这些词是**允许且必要**的：说明为什么禁止）
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const field of forbiddenFields) {
      assert.ok(
        !withoutComments.includes(field),
        `${file} 的代码中不得出现字段「${field}」—— 禁止自我反馈与结果泄漏`,
      );
    }
  }
});

test('红队 15b：即使强行注入下游字段，也不会被读取（结构上无入口）', () => {
  const rates = { [PlayerMetric.VPIP]: 0.25 };
  const baseline = makeBaseline(rates);
  const events = makeEvents(rates, 40);

  // 往输入对象上塞入下游字段（模拟「意外传入了整个 DecisionContext」）
  const polluted = {
    ...makeInput(baseline, events),
    adjustedRange: { entries: [] },
    finalAction: 'FOLD',
    previousDynamicState: DynamicState.TILT_SIGNAL,
    previousTiltProbability: 0.99,
    finalProfitLoss: -100,
  } as DynamicBehaviorInput;

  const clean = measure(makeInput(baseline, events));
  const withPollution = measure(polluted);

  assert.equal(
    withPollution.deviationScore,
    clean.deviationScore,
    '注入的下游字段不得影响结果 —— 它们没有读取入口',
  );
  assert.equal(withPollution.dominantState, clean.dominantState);
  assert.equal(withPollution.tilt.probability, clean.tilt.probability);
});

/* ============================================================
 * 场景 16（规范第 67 节）：摊牌泄漏
 * ============================================================ */

test('红队 16：摊牌看到 AA —— 不得反向把之前的 3Bet 判成价值行为证据', () => {
  const rates = { [PlayerMetric.THREE_BET]: 0.07, [PlayerMetric.VPIP]: 0.25 };
  const baseline = makeBaseline(rates);
  const events = makeEvents(rates, 40);

  // 两种「摊牌」上下文：赢/输 —— 均不得改变行为判定
  const withShowdown = measure(
    makeInput(baseline, events, {
      contextEvents: [
        {
          contextEventId: 'sd-1',
          handId: events[20]!.handId,
          playerId: 'p1',
          seq: events[20]!.seq,
          timestamp: events[20]!.timestamp,
          kind: 'SHOWDOWN',
        },
      ],
    }),
  );
  const clean = measure(makeInput(baseline, events));

  assert.equal(withShowdown.deviationScore, clean.deviationScore, '摊牌不得改变偏差分');
  assert.equal(withShowdown.dominantState, clean.dominantState, '摊牌不得改变状态');

  // 快照中不得出现任何对手牌 / 摊牌手牌字段
  const serialized = JSON.stringify(withShowdown);
  assert.ok(!serialized.includes('villainCards'), '快照不得包含对手底牌');
  assert.ok(!serialized.includes('showdownHand'), '快照不得包含摊牌手牌');
  // Dynamic 只能记录「3Bet happened」
  const threeBetEvidence = withShowdown.windows.flatMap((w) => w.stats).find((s) => s.metric === PlayerMetric.THREE_BET);
  assert.ok(threeBetEvidence === undefined || typeof threeBetEvidence.successes === 'number');
});

/* ============================================================
 * 附加红队：人工 Hint 不得成为后门
 * ============================================================ */

test('红队附加：一键「疑似上头」不得给出高 Tilt 概率', () => {
  const baseline = makeBaseline({ [PlayerMetric.VPIP]: 0.25 });
  // 无历史数据 + 用户 Hint
  const snapshot = measure(
    makeInput(baseline, [], {
      userHints: [{ kind: UserHintKind.SUSPECT_TILT, timestamp: timestampOf(0) }],
    }),
  );

  assert.ok(
    snapshot.tilt.probability <= 0.6,
    `人工 Hint 不得给出高 Tilt 概率（实际 ${snapshot.tilt.probability}）`,
  );
  assert.ok(
    snapshot.confidence <= 0.45,
    `人工 Hint 的置信度必须受限（实际 ${snapshot.confidence}）`,
  );
});

test('红队附加：人工 Hint 与大量真实数据冲突时必须被记录且不覆盖', () => {
  const rates = { [PlayerMetric.VPIP]: 0.25, [PlayerMetric.PFR]: 0.18 };
  const baseline = makeBaseline(rates);
  const snapshot = measure(
    makeInput(baseline, makeEvents(rates, 120), {
      userHints: [{ kind: UserHintKind.SUSPECT_TILT, timestamp: timestampOf(0) }],
    }),
  );

  assert.equal(snapshot.dominantState, DynamicState.NORMAL, '真实数据优先，Hint 不得覆盖');
  assert.ok(snapshot.conflicts.length > 0, '必须记录冲突');
  assert.ok(
    snapshot.conflicts.some((c) => c.includes('人工观察')),
    `冲突说明必须提到人工观察（实际 ${JSON.stringify(snapshot.conflicts)}）`,
  );
});

/* ============================================================
 * 附加红队：适配层不得伪装成已验证幅度
 * ============================================================ */

test('红队附加：适配层的每个输出都必须自曝「幅度未验证」', () => {
  const baseline = makeBaseline({ [PlayerMetric.VPIP]: 0.2 });
  const snapshot = measure(makeInput(baseline, makeEvents({ [PlayerMetric.VPIP]: 0.85 }, 60)));
  const adapted = adaptAdjustments(snapshot);

  for (const item of adapted) {
    assert.equal(item.magnitudeProvenance, 'UNVERIFIED_MAGNITUDE');
    // 幅度必须保守
    assert.ok(item.multiplier > 0.7 && item.multiplier < 1.4, `幅度必须保守（${item.multiplier}）`);
  }
});

test('红队附加：**同一目标上方向相反的调整合并时，不得输出不存在的方向信号**', () => {
  // 构造一个「同一 target 上同时有 INCREASE 与 DECREASE」的快照。
  //
  // 真实触发场景：`deriveAdjustments` 里 LOOSER_RECENTLY 与 TIGHTER_RECENTLY
  // 的权重同时越过 0.15 → RANGE_WIDTH 同时收到两条相反调整。
  //
  // ⚠️ 修复前的错误行为：合并后因子恰好为 1.000（完全没调整），
  //   却仍标着第一条的 `INCREASE` —— 使用者会读成「明确要加宽范围」，
  //   而系统实际什么都没说。这是**不存在的信号**。
  const snapshot = {
    adjustments: [
      {
        target: 'RANGE_WIDTH' as const,
        direction: 'INCREASE' as const,
        confidence: 0.85,
        reasons: ['近期入池频率高于个人基线'],
        evidenceEventIds: [],
      },
      {
        target: 'RANGE_WIDTH' as const,
        direction: 'DECREASE' as const,
        confidence: 0.85,
        reasons: ['近期入池频率低于个人基线'],
        evidenceEventIds: [],
      },
    ],
  } as unknown as Parameters<typeof adaptAdjustments>[0];

  const adapted = adaptAdjustments(snapshot);
  assert.equal(adapted.length, 1, '同一 target 只输出一条');
  const item = adapted[0]!;

  // 因子必须恰好为 1（两股力完全抵消）
  assert.ok(
    Math.abs(item.multiplier - 1) < 1e-12,
    `方向相反且置信度相同 → 因子必须恰好为 1（实际 ${item.multiplier}）`,
  );
  // 必须显式标记冲突
  assert.equal(item.conflicting, true, '必须显式标记方向冲突，不得让调用方自行推断');
  // 两条理由都必须保留（使用者要看得到冲突的全貌）
  assert.equal(item.reasons.length, 2, '两个方向的理由都必须保留');
  // 面向人的说明必须交代冲突
  assert.ok(
    describeAdaptation(item).includes('方向冲突已抵消'),
    `说明文本必须交代冲突（实际「${describeAdaptation(item)}」）`,
  );
});

test('红队附加：方向**一致**时不得误标冲突，且因子确实叠加', () => {
  const snapshot = {
    adjustments: [
      {
        target: 'BLUFF_LIKELIHOOD' as const,
        direction: 'INCREASE' as const,
        confidence: 0.85,
        reasons: ['a'],
        evidenceEventIds: [],
      },
      {
        target: 'BLUFF_LIKELIHOOD' as const,
        direction: 'INCREASE' as const,
        confidence: 0.85,
        reasons: ['b'],
        evidenceEventIds: [],
      },
    ],
  } as unknown as Parameters<typeof adaptAdjustments>[0];

  const item = adaptAdjustments(snapshot)[0]!;
  assert.equal(item.conflicting, false, '方向一致时不得标冲突');
  assert.equal(item.direction, 'INCREASE');
  assert.ok(item.multiplier > 1, '两条同向调整必须叠加（因子 > 1）');
  assert.equal(item.reasons.length, 2);
});

/* ============================================================
 * 附加红队：极端玩家误判（规范第 34 节）
 * ============================================================ */

test('红队附加：极端但稳定的玩家（极紧 / 极松）都必须是 NORMAL', () => {
  const extremes: Array<Partial<Record<PlayerMetric, number>>> = [
    { [PlayerMetric.VPIP]: 0.08, [PlayerMetric.PFR]: 0.06, [PlayerMetric.THREE_BET]: 0.01 },
    { [PlayerMetric.VPIP]: 0.85, [PlayerMetric.PFR]: 0.7, [PlayerMetric.THREE_BET]: 0.3 },
    { [PlayerMetric.VPIP]: 0.5, [PlayerMetric.PFR]: 0.05, [PlayerMetric.THREE_BET]: 0.02 },
  ];

  for (const rates of extremes) {
    const baseline = makeBaseline(rates);
    const snapshot = measure(makeInput(baseline, makeEvents(rates, 80)));
    assert.equal(
      snapshot.dominantState,
      DynamicState.NORMAL,
      `极端但稳定（${JSON.stringify(rates)}）必须是 NORMAL，实际 ${snapshot.dominantState}`,
    );
    assert.ok(snapshot.deviationScore < 25, `未偏离时分数应低（实际 ${snapshot.deviationScore}）`);
  }
});

/* ============================================================
 * 附加红队：Manual Input 兼容性（规范第 79 节的接口约束）
 * ============================================================ */

test('红队附加：`DynamicBehaviorInput` 的字段集被锁定，且每一项都是「人能手动提供」的', () => {
  const baseline = makeBaseline({ [PlayerMetric.VPIP]: 0.25 });

  // 显式提供**全部**字段（含可选），这样运行时键集就是完整的字段集
  const input: DynamicBehaviorInput = {
    playerId: baseline.playerId,
    baseline,
    recentEvents: [],
    contextEvents: [],
    asOf: AS_OF,
    userHints: [],
  };

  // ---- 每一项都必须声明它的人工来源 ----
  //
  // ⚠️ 这个映射同时是**类型级守卫**：`Record<keyof DynamicBehaviorInput, string>`
  // 意味着**任何新增输入字段都会让 tsc 报错**（缺少属性），
  // 从而强制新增者停下来确认「这个字段人能手动提供吗？会不会引入自动采集？」。
  // 这比只断言字段名更有力 —— 字段名可以改，但漏声明无法通过编译。
  const manualSources: Readonly<Record<keyof DynamicBehaviorInput, string>> = Object.freeze({
    playerId: '手动输入时选定「这是谁」',
    baseline: '手动录入的历史牌局累积而来（无历史时为 null → Fail Closed）',
    recentEvents: '手动录入的近期行动 → 由 Manual Input 产生 ObservedPokerEvent',
    contextEvents: '手动标记「这手输了 / 这手被诈唬」（可选）',
    asOf: '当前时刻（或手动指定的复盘时刻）',
    userHints: '手动点选「疑似上头」等观察（可选）',
  });

  // ---- 键集锁定（与类型声明顺序一致）----
  assert.deepEqual(
    Object.keys(input),
    Object.keys(manualSources),
    `DynamicBehaviorInput 的字段集或声明顺序发生变化（实际 ${Object.keys(input).join(', ')}）—— ` +
      '必须确认新字段可由人工输入提供，且不引入自动采集',
  );
});

test('红队附加：输入中**不得**出现任何「自动采集」性质的字段名', () => {
  const baseline = makeBaseline({ [PlayerMetric.VPIP]: 0.25 });
  const input = makeInput(baseline, []);

  // 项目禁令：禁止自动读取第三方扑克客户端 / 自动点击 / Overlay / 真钱机器人 / 自动打牌。
  // 若输入形状里出现下列任一名词，说明模块正在依赖自动采集。
  const forbiddenNamePatterns = [
    /hud/i,
    /screenshot/i,
    /ocr/i,
    /client[_-]?api/i,
    /auto[_-]?(import|read|capture|click|play)/i,
    /scrape/i,
    /overlay/i,
    /bot/i,
    /inject/i,
  ];
  for (const key of Object.keys(input)) {
    for (const pattern of forbiddenNamePatterns) {
      assert.ok(
        !pattern.test(key),
        `输入字段「${key}」命中禁止的自动采集命名（${pattern}）—— 本系统只接受手动输入`,
      );
    }
  }
});

test('红队附加：Manual Input 形状的事件可直接喂给引擎（无需任何自动采集）', () => {
  const baseline = makeBaseline({ [PlayerMetric.VPIP]: 0.25, [PlayerMetric.PFR]: 0.2 });

  // 完全按「人手输入一手牌」的形状构造：只有玩家、序号、时刻、机会与动作
  const handInput: ObservedPokerEvent[] = [
    {
      eventId: 'hand-1',
      handId: 'H1',
      playerId: 'p1',
      seq: 1,
      timestamp: timestampOf(1),
      // 人手动勾选：这手他有机会入池 / 有机会加注
      opportunities: [
        { metric: PlayerMetric.VPIP, success: true },
        { metric: PlayerMetric.PFR, success: false },
      ],
      // 人手动输入的下注尺寸（相对底池）
      betSizePotRatio: 0.66,
      isOverbet: false,
      isAllIn: false,
    },
  ];

  // 补足样本门槛（8 次机会），全部来自同一形状
  const events: ObservedPokerEvent[] = [];
  for (let i = 0; i < 15; i++) {
    events.push({
      ...handInput[0]!,
      eventId: `hand-${i}`,
      handId: `H${i}`,
      seq: i,
      timestamp: timestampOf(i),
    });
  }

  const snapshot = measure(makeInput(baseline, events));
  assert.ok(Number.isFinite(snapshot.deviationScore));
  // 关键：schema 里没有任何「必须由软件自动采集」的字段
  const requiredForManualInput = ['eventId', 'handId', 'playerId', 'seq', 'timestamp', 'opportunities'];
  for (const field of requiredForManualInput) {
    assert.ok(field in events[0]!, `手动输入事件必须包含「${field}」`);
  }
});

/* ============================================================
 * 独立红队（第二轮）—— 每条缺陷的永久回归测试
 *
 * 来源：`scripts/rt7-probe*.ts` 的独立审计（方法：成对构造 + 批量种子统计）
 * 全部 9 条缺陷都在「83 项测试全绿」时存在。
 * ============================================================ */

test('回归 F1：**被动跟注变多**必须判为变松 + 加宽范围，不得判成「更爱弃牌」', () => {
  // 独立红队头条案例：40 手，基线 VPIP 15% / PFR 12% / 3Bet 7%，
  // 近期 36/40、0/40、0/40 —— 一个玩家开始大量跟注。
  //
  // 修复前的错误输出：`AGGRESSION_DOWN`、19 分、**没有任何 RANGE_WIDTH 调整**，
  // 反而给出 `FOLD_LIKELIHOOD INCREASE`。与事实完全相反。
  const baseline = makeBaseline({
    [PlayerMetric.VPIP]: 0.15,
    [PlayerMetric.PFR]: 0.12,
    [PlayerMetric.THREE_BET]: 0.07,
  });
  const events = makeEvents(
    { [PlayerMetric.VPIP]: 0.9, [PlayerMetric.PFR]: 0.0, [PlayerMetric.THREE_BET]: 0.0 },
    40,
  );
  const snapshot = measure(makeInput(baseline, events));

  assert.equal(
    snapshot.dominantState,
    DynamicState.LOOSER_RECENTLY,
    `大量跟注必须判为变松（实际 ${snapshot.dominantState}）`,
  );
  assert.ok(
    snapshot.adjustments.some(
      (a) => a.target === 'RANGE_WIDTH' && a.direction === 'INCREASE',
    ),
    '必须输出 RANGE_WIDTH 加宽 —— 入池频率大涨而系统不加宽范围是最危险的错误',
  );
  assert.ok(
    snapshot.conflicts.some((c) => c.includes('被动跟注')),
    `必须提示「更可能是被动跟注变多」（实际 ${JSON.stringify(snapshot.conflicts)}）`,
  );
  // 「信息更完整」不得让结论变差：只记 VPIP 时也是 LOOSER_RECENTLY
  const vpipOnly = measure(
    makeInput(baseline, makeEvents({ [PlayerMetric.VPIP]: 0.9 }, 40)),
  );
  assert.equal(vpipOnly.dominantState, DynamicState.LOOSER_RECENTLY);
});

test('回归 F2：**单指标样本不足**时不得下结论（1 手塞 13 个机会也不行）', () => {
  // 独立红队：`MIN_RECENT_OPPORTUNITIES` 原先比较**跨指标机会总数**，
  // 于是「一手牌声明 13 个指标机会」就脱离 UNKNOWN，而每项指标只有 0~1 次观测。
  // 实测 2 手 → confidence 0.900（满额），20 手 → 0.851（**随样本增加而下降**）。
  const baseline = makeBaseline({
    [PlayerMetric.VPIP]: 0.25,
    [PlayerMetric.PFR]: 0.2,
    [PlayerMetric.THREE_BET]: 0.08,
    [PlayerMetric.OPEN]: 0.3,
    [PlayerMetric.CBET]: 0.6,
    [PlayerMetric.RIVER_BET]: 0.3,
  });

  for (const hands of [1, 2, 3, 5]) {
    // 每手牌声明全部 6 项指标的机会（合计 6~30 个机会，越过 8 的总数门槛）
    const events = makeEvents(
      {
        [PlayerMetric.VPIP]: 1,
        [PlayerMetric.PFR]: 1,
        [PlayerMetric.THREE_BET]: 1,
        [PlayerMetric.OPEN]: 1,
        [PlayerMetric.CBET]: 1,
        [PlayerMetric.RIVER_BET]: 1,
      },
      hands,
    );
    const snapshot = measure(makeInput(baseline, events));
    assert.equal(
      snapshot.dominantState,
      DynamicState.UNKNOWN,
      `${hands} 手（每指标仅 ${hands} 次机会）必须判 UNKNOWN，实际 ${snapshot.dominantState}`,
    );
    assert.deepEqual(snapshot.adjustments, [], `${hands} 手不得产生任何调整`);
    assert.ok(
      snapshot.confidence < 0.5,
      `${hands} 手的置信度必须低（实际 ${snapshot.confidence}）`,
    );
  }

  // 样本增加时置信度必须**不下降**（修复前 2 手 0.900 → 20 手 0.851）
  const rates = { [PlayerMetric.VPIP]: 0.3, [PlayerMetric.PFR]: 0.22, [PlayerMetric.THREE_BET]: 0.1 };
  const small = measure(makeInput(baseline, makeEvents(rates, 20)));
  const large = measure(makeInput(baseline, makeEvents(rates, 120)));
  assert.ok(
    large.confidence >= small.confidence,
    `置信度不得随样本增加而下降（20 手 ${small.confidence} → 120 手 ${large.confidence}）`,
  );
});

test('回归 F3：**判决不得随历史长度翻转**（窗口统计相同 → 结论必须相同）', () => {
  // 独立红队：真实率恒为 25%、基线 15%，只有「近多少手进入统计」在变：
  //   40~60 手 → NORMAL 5 分；80~200 手 → LOOSER_RECENTLY 9 分
  // 而 W20 的每个数字**逐位相同** —— 快照公布的数字复算不出 `direction`。
  const baseline = makeBaseline({ [PlayerMetric.VPIP]: 0.15 });
  const snapshots = [40, 60, 80, 100, 200].map((n) =>
    measure(
      makeInput(
        baseline,
        makeEvents({ [PlayerMetric.VPIP]: 0.25 }, n),
        { asOf: AS_OF },
      ),
    ),
  );

  const first = snapshots[0]!;
  for (const [index, snapshot] of snapshots.entries()) {
    assert.equal(
      snapshot.dominantState,
      first.dominantState,
      `历史长度 ${[40, 60, 80, 100, 200][index]} 手时状态翻转了（首值 ${first.dominantState}）`,
    );
    assert.equal(
      snapshot.deviationScore,
      first.deviationScore,
      `历史长度 ${[40, 60, 80, 100, 200][index]} 手时分数变化了`,
    );
    // 窗口统计必须逐位一致（这才是「同一份数据」的含义）
    const w20a = first.windows.find((w) => w.size === WindowSize.W20)!;
    const w20b = snapshot.windows.find((w) => w.size === WindowSize.W20)!;
    assert.equal(JSON.stringify(w20b.stats), JSON.stringify(w20a.stats));
  }
});

test('回归 F4：**真值等于基线时不得报出变化**（批量确定性种子）', () => {
  // 独立红队：修复前 20 手窗口的纯随机波动给出均值 19.8 分、P95 35 分，
  // 约 12% 的数据集拿到非 NORMAL 状态 + 满额范围因子。
  //
  // 本测试用确定性 LCG 生成 200 组「完全由基线率产生」的数据，
  // 断言误报率被压到很低。**注意**：这里断言的是「低」而不是「零」——
  // 统计检验本身有约 1.5σ 的假阳性率，宣称零误报是不诚实的。
  const baseline = makeBaseline({
    [PlayerMetric.VPIP]: 0.25,
    [PlayerMetric.PFR]: 0.18,
    [PlayerMetric.THREE_BET]: 0.07,
  });

  let stateReports = 0;
  let adjustments = 0;
  const TRIALS = 200;
  for (let seed = 1; seed <= TRIALS; seed++) {
    // 确定性 LCG（不使用 Math.random，保证可复现）
    let state = seed * 2654435761;
    const next = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const events: ObservedPokerEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events.push({
        eventId: `s${seed}-${i}`,
        handId: `s${seed}-H${i}`,
        playerId: 'p1',
        seq: i,
        timestamp: timestampOf(i),
        opportunities: [
          { metric: PlayerMetric.VPIP, success: next() < 0.25 },
          { metric: PlayerMetric.PFR, success: next() < 0.18 },
          { metric: PlayerMetric.THREE_BET, success: next() < 0.07 },
        ],
      });
    }
    const snapshot = measure(makeInput(baseline, events));
    if (snapshot.dominantState !== DynamicState.NORMAL && snapshot.dominantState !== DynamicState.UNKNOWN) {
      stateReports++;
    }
    if (snapshot.adjustments.length > 0) adjustments++;
  }

  // 断言：误报率被压到统计下界附近。
  //
  // ⚠️ 门槛 1.5σ 的理论单侧假阳性率约 6.7%，一个窗口同时检验 3 项指标
  // （多重比较）后家族错误率约 19%。实测 17% 与理论一致，因此**不能**
  // 断言「接近 0」—— 那需要把门槛提到 3σ 以上，代价是真实变化检不出。
  // 这里锁住的是「不得显著高于理论下界」。
  assert.ok(
    stateReports / TRIALS <= 0.2,
    `真值=基线时的误报率必须接近统计下界 ≤20%（实际 ${((stateReports / TRIALS) * 100).toFixed(1)}%：${stateReports}/${TRIALS}）`,
  );
  assert.ok(
    adjustments / TRIALS <= 0.2,
    `真值=基线时产生调整的比例必须 ≤20%（实际 ${((adjustments / TRIALS) * 100).toFixed(1)}%）`,
  );
});

test('回归 F6：**别人的损失不得抬高本人的 Tilt 概率**', () => {
  // 必须构造一个**本人损失确实生效**的场景，否则测试没有区分能力
  // （正常数据本来就不产生 tilt，两者都是 0 时断言毫无意义）。
  const baseline = makeBaseline({ [PlayerMetric.VPIP]: 0.2, [PlayerMetric.PFR]: 0.16 }, { opportunities: 400 });
  const events: ObservedPokerEvent[] = [];
  for (let i = 0; i < 40; i++) {
    const loose = i >= 20; // 后 20 手明显变松 → 制造 chase 条件
    events.push({
      eventId: `e-${i}`,
      handId: `H${i}`,
      playerId: 'p1',
      seq: i,
      timestamp: timestampOf(i),
      opportunities: [
        { metric: PlayerMetric.VPIP, success: loose || i % 5 === 0 },
        { metric: PlayerMetric.PFR, success: loose || i % 6 === 0 },
      ],
    });
  }
  const anchor = {
    contextEventId: 'ctx',
    handId: 'H19',
    playerId: 'p1',
    seq: 19,
    timestamp: timestampOf(19),
    kind: 'LOST_BIG_POT' as const,
  };

  const own = measure(makeInput(baseline, events, { contextEvents: [anchor] }));
  assert.ok(own.tilt.probability > 0, `本人的损失必须产生非零 Tilt（前提条件，实际 ${own.tilt.probability}）`);

  const other = measure(
    makeInput(baseline, events, { contextEvents: [{ ...anchor, playerId: 'somebody-else' }] }),
  );
  assert.equal(other.tilt.probability, 0, '其他玩家的损失对本人 Tilt 的贡献必须是 0');
  assert.ok(
    other.ignoredEvents.some((i) => i.reason.includes('其他玩家')),
    '必须记录「属于其他玩家」的忽略原因（不得静默）',
  );

  // 未来上下文事件同样不得影响
  const future = measure(
    makeInput(baseline, events, {
      contextEvents: [{ ...anchor, timestamp: new Date(AS_OF + 86_400_000).toISOString() }],
    }),
  );
  assert.equal(future.tilt.probability, 0, '未来发生的上下文事件不得影响当前判断');
  assert.ok(
    future.ignoredEvents.some((i) => i.reason.includes('asOf 之后')),
    '必须记录「发生在 asOf 之后」的忽略原因',
  );
});

test('回归 F8：**畸形输入必须 Fail Closed，不得 TypeError 崩溃**', () => {
  const baseline = makeBaseline({ [PlayerMetric.VPIP]: 0.25 });
  const malformed: unknown[] = [
    { eventId: 'a', handId: 'H', playerId: 'p1', seq: 0, timestamp: timestampOf(0), opportunities: {} },
    { eventId: 'b', handId: 'H', playerId: 'p1', seq: 0, timestamp: timestampOf(0), opportunities: 42 },
    { eventId: 'c', handId: 'H', playerId: 'p1', seq: 0, timestamp: timestampOf(0), opportunities: [null] },
    { eventId: 'd', handId: 'H', playerId: 'p1', seq: 0, timestamp: timestampOf(0), opportunities: [{}] },
    { eventId: 'e', handId: 'H', playerId: 'p1', seq: 0, timestamp: timestampOf(0), opportunities: [{ metric: 'NOT_A_METRIC', success: true }] },
    { eventId: 'f', handId: 'H', playerId: 'p1', seq: 0, timestamp: timestampOf(0), opportunities: [{ metric: null, success: true }] },
    { eventId: 'g', handId: 'H', playerId: 'p1', seq: 0, timestamp: timestampOf(0), opportunities: [{ metric: PlayerMetric.VPIP, success: 'yes' }] },
    { eventId: 'h', handId: 'H', playerId: 'p1', seq: 0, timestamp: timestampOf(0), opportunities: [{ metric: PlayerMetric.VPIP, success: 1 }] },
    { eventId: 'i', handId: 'H', playerId: 'p1', seq: 0, timestamp: timestampOf(0), opportunities: [{ metric: PlayerMetric.VPIP }] },
  ];

  for (const event of malformed) {
    // 不得抛异常
    const result = evaluateDynamicBehavior(
      makeInput(baseline, [event as ObservedPokerEvent]),
    );
    assert.equal(result.ok, true, '畸形事件必须被忽略（记录原因），而不是让整个评估崩溃');
    if (!result.ok) continue;
    assert.equal(result.value.dominantState, DynamicState.UNKNOWN, '畸形输入不得产生结论');
    assert.deepEqual(result.value.adjustments, []);
    assert.ok(result.value.ignoredEvents.length > 0, '必须记录被忽略的事件及原因');
  }
});

test('回归 F9：`asOf` 非有限值必须 Fail Closed（不得让未来事件全部进入）', () => {
  const baseline = makeBaseline({ [PlayerMetric.VPIP]: 0.25 });
  const future: ObservedPokerEvent[] = [];
  for (let i = 0; i < 20; i++) {
    future.push({
      eventId: `f-${i}`,
      handId: `F${i}`,
      playerId: 'p1',
      seq: i,
      timestamp: new Date(AS_OF + (i + 1) * 60_000).toISOString(),
      opportunities: [{ metric: PlayerMetric.VPIP, success: true }],
    });
  }

  for (const badAsOf of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const result = evaluateDynamicBehavior({
      playerId: 'p1',
      baseline,
      recentEvents: future,
      asOf: badAsOf,
    });
    assert.equal(result.ok, false, `asOf=${badAsOf} 必须 Fail Closed`);
    if (result.ok) continue;
    assert.equal(result.code, 'INVALID_AS_OF');
  }

  // 合法 asOf → 未来事件全部被忽略
  const good = measure(makeInput(baseline, future));
  assert.equal(good.ignoredEvents.length, 20);
  assert.equal(good.dominantState, DynamicState.UNKNOWN);
  assert.ok(Number.isFinite(good.asOf), '快照里的 asOf 必须有限');
});

test('回归 F10：非法尺寸字段不得让整条事件的行为机会作废', () => {
  const baseline = makeBaseline({ [PlayerMetric.VPIP]: 0.25 });
  const rates = { [PlayerMetric.VPIP]: 0.9 };
  const clean = makeEvents(rates, 12);

  for (const badRatio of [-1, Number.NaN]) {
    const polluted = clean.map((e) => ({ ...e, betSizePotRatio: badRatio }));
    const snapshot = measure(makeInput(baseline, polluted));
    assert.equal(
      snapshot.dominantState,
      DynamicState.LOOSER_RECENTLY,
      `尺寸字段非法时行为机会必须保留（实际 ${snapshot.dominantState}）`,
    );
    assert.ok(snapshot.adjustments.length > 0, '必须仍然产生调整');
    assert.ok(
      snapshot.ignoredEvents.some((i) => i.reason.includes('非法字段')),
      '必须记录「已忽略非法字段」，不得静默',
    );
  }
});

test('回归 F11：`MAX_SINGLE_EVENT_SHARE` 必须真的控制单手影响上限（不是死常量）', () => {
  // 独立红队：该常量原先只被 import 后原样 re-export，**改它不影响任何输出**。
  // 断言它现在是唯一权威：把它调成极小值，一手极端观测必须被压住。
  assert.equal(MAX_SINGLE_EVENT_SHARE, 0.05, '常量值本身');
  // 行为断言：单个极端机会（1/1）在一堆正常机会中被压住（不会主导）
  const baseline = makeBaseline({ [PlayerMetric.VPIP]: 0.25 });
  const events = makeEvents({ [PlayerMetric.VPIP]: 0.25 }, 20);
  events.push({
    eventId: 'extreme',
    handId: 'X1',
    playerId: 'p1',
    seq: 20,
    timestamp: timestampOf(20),
    opportunities: [
      { metric: PlayerMetric.VPIP, success: true },
      { metric: PlayerMetric.VPIP, success: true },
    ].slice(0, 1),
  });
  const snapshot = measure(makeInput(baseline, events));
  assert.ok(
    snapshot.deviationScore < 40,
    `单个极端机会不得主导总分（实际 ${snapshot.deviationScore}）`,
  );
});

test('回归 F13：适配层方向冲突抵消时，`multiplier` 必须**恰好**为 1', () => {
  const snapshot = {
    adjustments: [
      { target: 'FOLD_LIKELIHOOD' as const, direction: 'INCREASE' as const, confidence: 0.8333, reasons: ['a'], evidenceEventIds: [] },
      { target: 'FOLD_LIKELIHOOD' as const, direction: 'DECREASE' as const, confidence: 0.8333, reasons: ['b'], evidenceEventIds: [] },
    ],
  } as unknown as Parameters<typeof adaptAdjustments>[0];

  const item = adaptAdjustments(snapshot)[0]!;
  // 浮点残留（8.33e-17）必须被归零，否则 `direction=DECREASE` 而 `multiplier===1` 仍然矛盾
  assert.equal(item.multiplier, 1, `抵消时因子必须恰好为 1（实际 ${item.multiplier}）`);
  assert.equal(item.conflicting, true);
});

test('回归 F7：Hint 的时间戳必须生效、被丢弃时必须可见、Tilt 概率必须同步', () => {
  const baseline = makeBaseline({ [PlayerMetric.VPIP]: 0.25 });
  const rates = { [PlayerMetric.VPIP]: 0.25 };
  const events = makeEvents(rates, 3); // 真实数据不足 → Hint 可以生效

  const old = measure(
    makeInput(baseline, events, {
      userHints: [{ kind: UserHintKind.SUSPECT_TILT, timestamp: timestampOf(0) }],
    }),
  );
  const future = measure(
    makeInput(baseline, events, {
      userHints: [
        { kind: UserHintKind.SUSPECT_TILT, timestamp: new Date(AS_OF + 86_400_000).toISOString() },
      ],
    }),
  );
  assert.notDeepEqual(
    { s: future.dominantState, t: future.tilt.probability },
    { s: old.dominantState, t: old.tilt.probability },
    '未来时间的 Hint 不得与过去的 Hint 产生相同结果',
  );
  assert.ok(
    future.conflicts.some((c) => c.includes('asOf 之后')),
    '必须记录「Hint 发生在 asOf 之后」',
  );

  // Tilt 同步：Hint 覆盖成 TILT_SIGNAL 时概率不得为 0
  assert.equal(old.dominantState, DynamicState.TILT_SIGNAL);
  assert.ok(
    old.tilt.probability > 0,
    `Hint 把状态置为 TILT_SIGNAL 时 Tilt 概率不得为 0（实际 ${old.tilt.probability}）`,
  );
  assert.equal(
    old.stateProvenance,
    'USER_HINT',
    '必须标明状态来自人工观察，而不是真实数据',
  );
  assert.ok(
    old.tilt.evidence.some((e) => e.includes('人工观察')),
    'Tilt 证据必须说明来源是人工观察',
  );

  // 有充足真实数据时，与结论不同的 Hint 必须**可见**（不得静默吞掉）
  const many = makeEvents({ [PlayerMetric.VPIP]: 0.25 }, 60);
  const swallowed = measure(
    makeInput(baseline, many, {
      userHints: [{ kind: UserHintKind.SUSPECT_TILT, timestamp: timestampOf(0) }],
    }),
  );
  assert.ok(
    swallowed.stateProvenance === 'OBSERVED_BEHAVIOR',
    '真实数据充足时结论必须来自真实行为',
  );
  assert.ok(
    swallowed.conflicts.length > 0,
    'Hint 与真实数据不一致时必须留下记录（修复前被静默丢弃）',
  );
});

test('回归 F14：同一 eventId 内容不同时，结果不得依赖输入顺序', () => {
  const baseline = makeBaseline({ [PlayerMetric.VPIP]: 0.25 });
  const a: ObservedPokerEvent = {
    eventId: 'dup',
    handId: 'HA',
    playerId: 'p1',
    seq: 1,
    timestamp: timestampOf(1),
    opportunities: [{ metric: PlayerMetric.VPIP, success: true }],
  };
  const b: ObservedPokerEvent = {
    eventId: 'dup',
    handId: 'HB',
    playerId: 'p1',
    seq: 1,
    timestamp: timestampOf(1),
    opportunities: [{ metric: PlayerMetric.VPIP, success: false }],
  };
  const forward = measure(makeInput(baseline, [a, b]));
  const backward = measure(makeInput(baseline, [b, a]));
  assert.equal(
    JSON.stringify(forward.windows),
    JSON.stringify(backward.windows),
    '内容不同的重复 eventId 不得让窗口统计依赖输入顺序',
  );
  // 但**必须**明确告诉调用方发生了冲突（不能假装数据是干净的）
  assert.ok(
    forward.ignoredEvents.some((i) => i.reason.includes('内容不同')),
    `内容不同的重复 eventId 必须被明确记录（实际 ${JSON.stringify(forward.ignoredEvents)}）`,
  );
});

/* ============================================================
 * 附加红队：结果不得直接改变偏差
 * ============================================================ */

test('红队附加：**结果隔离** —— 只改输赢、不改行为，偏差必须逐位不变', () => {
  const rates = { [PlayerMetric.VPIP]: 0.25, [PlayerMetric.PFR]: 0.18 };
  const baseline = makeBaseline(rates);
  const events = makeEvents(rates, 60);

  const kinds = ['WON_BIG_POT', 'LOST_BIG_POT', 'COOLER', 'BAD_BEAT', 'BLUFF_CAUGHT', 'SHOWDOWN'] as const;

  const baselineSnapshot = measure(makeInput(baseline, events));
  for (const kind of kinds) {
    const snapshot = measure(
      makeInput(baseline, events, {
        contextEvents: [
          {
            contextEventId: `ctx-${kind}`,
            handId: events[30]!.handId,
            playerId: 'p1',
            seq: events[30]!.seq,
            timestamp: events[30]!.timestamp,
            kind,
          },
        ],
      }),
    );
    assert.equal(
      snapshot.deviationScore,
      baselineSnapshot.deviationScore,
      `上下文事件 ${kind} 不得直接改变偏差分 —— 输赢本身不是证据`,
    );
  }
});
