/**
 * rt7-probe4.ts —— 数值稳定性 / 确定性 / 不可变性 / 类型层隔离真实性
 *
 * 运行：node.exe --experimental-strip-types "scripts/rt7-probe4.ts"
 */

import { adaptAdjustments } from '../src/domain/dynamic/dynamicAdapter.ts';

import {
  AS_OF,
  PLAYER,
  T0,
  ev,
  fmt,
  makeBaseline,
  makeInput,
  mustOk,
  run,
  spread,
  table,
  walk,
} from './rt7-lib.ts';
import type { DynamicBehaviorSnapshot, ObservedPokerEvent, TableRow } from './rt7-lib.ts';

const RATES = { VPIP: 0.22, PFR: 0.17, THREE_BET: 0.06, CALL_OPEN: 0.14, RIVER_CALL: 0.38 };

function show(label: string, fn: () => unknown): void {
  try {
    const value = fn();
    console.log(`  ✔ ${label} → ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  } catch (error) {
    console.log(`  ✖ ${label} → 抛出 ${(error as Error).name}: ${(error as Error).message}`);
  }
}

console.log('='.repeat(96));
console.log('A. 数值稳定性：极端输入是否产生 NaN / Infinity / 越界 / 崩溃');
console.log('='.repeat(96));

const numericIssues: string[] = [];
function checkNumbers(snap: DynamicBehaviorSnapshot, label: string): void {
  walk(snap, 'snapshot', (path, v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) numericIssues.push(`${label} ${path} = ${v}`);
  });
  const checks: Array<[string, number, number, number]> = [
    ['deviationScore', snap.deviationScore, 0, 100],
    ['confidence', snap.confidence, 0, 1],
    ['tilt.probability', snap.tilt.probability, 0, 1],
    ['tilt.confidence', snap.tilt.confidence, 0, 1],
  ];
  for (const [name, value, lo, hi] of checks) {
    if (!(value >= lo && value <= hi)) numericIssues.push(`${label} ${name} 越界 = ${value}`);
  }
  for (const g of snap.groupScores) {
    if (!(g.score >= 0 && g.score <= 1)) numericIssues.push(`${label} group ${g.group} score = ${g.score}`);
    if (!(g.confidence >= 0 && g.confidence <= 1)) numericIssues.push(`${label} group ${g.group} conf = ${g.confidence}`);
  }
  for (const w of snap.windows) {
    for (const s of w.stats) {
      for (const key of ['rawRate', 'adjustedRate', 'baselineRate', 'deviation'] as const) {
        const value = s[key];
        if (value !== null && (!Number.isFinite(value) || value < -1 || value > 1)) {
          numericIssues.push(`${label} w${w.size}.${s.metric}.${key} = ${value}`);
        }
      }
      if (!(s.confidence >= 0 && s.confidence <= 1)) numericIssues.push(`${label} w${w.size}.${s.metric}.conf = ${s.confidence}`);
    }
  }
  for (const s of snap.signals) {
    if (!(s.probability >= 0 && s.probability <= 1)) numericIssues.push(`${label} signal ${s.state} p = ${s.probability}`);
  }
  for (const a of snap.adjustments) {
    if (!(a.confidence >= 0 && a.confidence <= 1)) numericIssues.push(`${label} adj ${a.target} conf = ${a.confidence}`);
    if ('multiplier' in (a as unknown as Record<string, unknown>)) numericIssues.push(`${label} adj ${a.target} 含 multiplier`);
  }
  for (const adapted of adaptAdjustments(snap)) {
    if (!Number.isFinite(adapted.multiplier) || adapted.multiplier <= 0) {
      numericIssues.push(`${label} adapted ${adapted.target} multiplier = ${adapted.multiplier}`);
    }
  }
}

const base = makeBaseline(RATES);
const normalEvents = spread(30, 8).map((v, i) => ev(i + 1, { VPIP: v, PFR: false, THREE_BET: false, CALL_OPEN: false, RIVER_CALL: false }));

const extremeCases: Array<[string, () => unknown]> = [
  ['asOf = NaN', () => run(makeInput(base, normalEvents, { asOf: NaN }))],
  ['asOf = Infinity', () => run(makeInput(base, normalEvents, { asOf: Infinity }))],
  ['asOf = -Infinity（全部事件成为未来事件）', () => run(makeInput(base, normalEvents, { asOf: -Infinity }))],
  ['asOf = 0', () => run(makeInput(base, normalEvents, { asOf: 0 }))],
  ['recentEvents = []', () => run(makeInput(base, []))],
  ['baseline.metrics = {}', () => run(makeInput(makeBaseline({}), normalEvents))],
  [
    '基线率恰为 0（VPIP=0）且近期 20/20',
    () =>
      run(
        makeInput(
          makeBaseline({ ...RATES, VPIP: 0 }),
          spread(20, 20).map((v, i) => ev(i + 1, { VPIP: v, PFR: true, THREE_BET: true, CALL_OPEN: true, RIVER_CALL: true })),
        ),
      ),
  ],
  [
    '基线率恰为 1（VPIP=1）且近期 0/20',
    () =>
      run(
        makeInput(
          makeBaseline({ ...RATES, VPIP: 1 }),
          spread(20, 0).map((v, i) => ev(i + 1, { VPIP: v, PFR: false, THREE_BET: false, CALL_OPEN: false, RIVER_CALL: false })),
        ),
      ),
  ],
  [
    '全部时间戳相同 + 全部 seq 相同',
    () =>
      run(
        makeInput(
          base,
          Array.from({ length: 30 }, (_, i) =>
            ev(i + 1, { VPIP: i % 2 === 0, PFR: false, THREE_BET: false, CALL_OPEN: false, RIVER_CALL: false }, {
              ts: T0,
              seq: 1,
            }),
          ),
        ),
      ),
  ],
  [
    'seq = Number.MAX_SAFE_INTEGER',
    () =>
      run(
        makeInput(
          base,
          Array.from({ length: 20 }, (_, i) =>
            ev(i + 1, { VPIP: i % 2 === 0, PFR: false, THREE_BET: false, CALL_OPEN: false, RIVER_CALL: false }, {
              seq: Number.MAX_SAFE_INTEGER - 19 + i,
            }),
          ),
        ),
      ),
  ],
  [
    'seq = 0 且为小数 seq = 1.5',
    () =>
      run(
        makeInput(base, [
          ev(1, { VPIP: true }, { seq: 0 }),
          ev(2, { VPIP: false }, { seq: 1.5 }),
          ev(3, { VPIP: true }, { seq: 2 }),
        ]),
      ),
  ],
  [
    '500 手事件（超大样本）',
    () =>
      run(
        makeInput(
          base,
          Array.from({ length: 500 }, (_, i) =>
            ev(i + 1, { VPIP: i % 4 === 0, PFR: i % 6 === 0, THREE_BET: i % 17 === 0, CALL_OPEN: false, RIVER_CALL: i % 3 === 0 }),
          ),
        ),
      ),
  ],
  [
    '所有指标全部极端（20 手全命中）',
    () =>
      run(
        makeInput(
          base,
          Array.from({ length: 20 }, (_, i) =>
            ev(i + 1, { VPIP: true, PFR: true, THREE_BET: true, CALL_OPEN: true, RIVER_CALL: true }),
          ),
        ),
      ),
  ],
  ['重复 eventId ×3（幂等）', () => run(makeInput(base, [...normalEvents, ...normalEvents, ...normalEvents]))],
  [
    '同一 eventId、不同内容、顺序相反 —— 是否依赖输入顺序',
    () => {
      const a = ev(1, { VPIP: true }, { eventId: 'dup' });
      const b = ev(1, { VPIP: false }, { eventId: 'dup' });
      const one = run(makeInput(base, [a, b]));
      const two = run(makeInput(base, [b, a]));
      return { 正序: JSON.stringify(one), 逆序: JSON.stringify(two), 逐位一致: JSON.stringify(one) === JSON.stringify(two) };
    },
  ],
];

for (const [label, fn] of extremeCases) {
  show(label, fn);
}

console.log('');
console.log('—— 全部极端用例的数值不变量检查 ——');
const labels = [
  'asOf=NaN',
  'asOf=Inf',
  'asOf=-Inf',
  'asOf=0',
  'empty',
  'noBaselineMetrics',
  'rate0',
  'rate1',
  'sameTsSeq',
  'maxSeq',
  'fracSeq',
  '500hands',
  'allExtreme',
];
let idx = 0;
for (const [label, fn] of extremeCases.slice(0, 13)) {
  try {
    const outcome = fn() as { ok: boolean; value?: DynamicBehaviorSnapshot; code?: string };
    if (outcome.ok && outcome.value) checkNumbers(outcome.value, labels[idx] ?? label);
    else console.log(`  · ${label}: 返回失败 ${outcome.code}（Fail Closed）`);
  } catch (error) {
    numericIssues.push(`${label} 崩溃：${(error as Error).message}`);
  }
  idx++;
}
console.log(numericIssues.length === 0 ? '  未发现 NaN / Infinity / 越界' : `  发现 ${numericIssues.length} 处问题：`);
for (const issue of numericIssues) console.log(`    - ${issue}`);

console.log('');
console.log('='.repeat(96));
console.log('B. 脏数据 / 结构非法：Fail Closed 还是静默接受 / 崩溃');
console.log('='.repeat(96));

const dirtyCases: Array<[string, () => unknown]> = [
  ['opportunities = {}（非数组、非可迭代）', () => run(makeInput(base, [ev(1, { VPIP: true }, { extra: { opportunities: {} } })]))],
  ['opportunities = 42', () => run(makeInput(base, [ev(1, { VPIP: true }, { extra: { opportunities: 42 } })]))],
  ['opportunities = null', () => run(makeInput(base, [ev(1, { VPIP: true }, { extra: { opportunities: null } })]))],
  ['opportunities = [null]', () => run(makeInput(base, [ev(1, { VPIP: true }, { extra: { opportunities: [null] } })]))],
  ['opportunities = [{}]（缺 metric 与 success）', () => run(makeInput(base, [ev(1, { VPIP: true }, { extra: { opportunities: [{}] } })]))],
  ['success 为字符串 "yes"', () => run(makeInput(base, [ev(1, {}, { extra: { opportunities: [{ metric: 'VPIP', success: 'yes' }] } })]))],
  ['success 缺失（{metric:"VPIP"}）', () => run(makeInput(base, [ev(1, {}, { extra: { opportunities: [{ metric: 'VPIP' }] } })]))],
  ['metric = "NOT_A_METRIC"', () => run(makeInput(base, [ev(1, {}, { extra: { opportunities: [{ metric: 'NOT_A_METRIC', success: true }] } })]))],
  ['betSizePotRatio = -1（字段本身不参与任何计算）', () => run(makeInput(base, [ev(1, { VPIP: true }, { extra: { betSizePotRatio: -1 } })]))],
  ['betSizePotRatio = NaN', () => run(makeInput(base, [ev(1, { VPIP: true }, { extra: { betSizePotRatio: NaN } })]))],
  ['timestamp 不可解析', () => run(makeInput(base, [ev(1, { VPIP: true }, { extra: { timestamp: 'not-a-date' } })]))],
  ['eventId 为空字符串', () => run(makeInput(base, [ev(1, { VPIP: true }, { extra: { eventId: '' } })]))],
  ['baseline.metrics 注入伪造指标键', () => {
    const b = makeBaseline(RATES) as unknown as { metrics: Record<string, unknown> };
    for (let i = 0; i < 20; i++) {
      b.metrics[`FAKE_${i}`] = { metric: `FAKE_${i}`, successes: 200, opportunities: 400, adjustedRate: 0.5, effectiveSampleSize: 400, confidence: 1 };
    }
    return run(makeInput(b as never, normalEvents));
  }],
];
for (const [label, fn] of dirtyCases) {
  try {
    const outcome = fn() as { ok: boolean; value?: DynamicBehaviorSnapshot; code?: string; params?: unknown };
    if (outcome.ok && outcome.value) {
      const v = outcome.value;
      console.log(
        `  · ${label} → ok 状态=${v.dominantState} 置信=${fmt(v.confidence, 4)} 分数=${v.deviationScore} 指标数(W20)=${v.windows.find((w) => w.size === 20)!.stats.length} ignored=${v.ignoredEvents.length}`,
      );
      checkNumbers(v, label);
    } else {
      console.log(`  · ${label} → Fail Closed ${outcome.code} ${JSON.stringify(outcome.params)}`);
    }
  } catch (error) {
    console.log(`  ✖ ${label} → 崩溃 ${(error as Error).name}: ${(error as Error).message}`);
  }
}

console.log('');
console.log('—— 关键：伪造指标键是否抬高了 confidence？ ——');
{
  const clean = mustOk(run(makeInput(makeBaseline(RATES), normalEvents)));
  const b = makeBaseline(RATES) as unknown as { metrics: Record<string, unknown> };
  for (let i = 0; i < 20; i++) {
    b.metrics[`FAKE_${i}`] = { metric: `FAKE_${i}`, successes: 200, opportunities: 400, adjustedRate: 0.5, effectiveSampleSize: 400, confidence: 1 };
  }
  const polluted = mustOk(run(makeInput(b as never, normalEvents)));
  console.log(`  干净基线 confidence = ${fmt(clean.confidence, 6)}；注入 20 个伪造指标后 = ${fmt(polluted.confidence, 6)}`);
}

console.log('');
console.log('='.repeat(96));
console.log('C. 确定性：逐位一致（JSON.stringify 比较）');
console.log('='.repeat(96));

const manyEvents = Array.from({ length: 40 }, (_, i) =>
  ev(i + 1, {
    VPIP: spread(40, 12)[i]!,
    PFR: spread(40, 6)[i]!,
    THREE_BET: spread(40, 2)[i]!,
    CALL_OPEN: spread(40, 5)[i]!,
    RIVER_CALL: spread(40, 15)[i]!,
  }),
);

function stringify(input: unknown): string {
  return JSON.stringify(run(makeInput(base, input as ObservedPokerEvent[])));
}
const runA = stringify(manyEvents);
const runB = stringify(manyEvents);
console.log(`  同一输入跑两次逐位一致：${runA === runB}`);

const shuffled = [...manyEvents].reverse();
console.log(`  正序 vs 逆序（无重复 id）逐位一致：${stringify(manyEvents) === stringify(shuffled)}`);

// 基线 metrics 键顺序不同
const baseAlt = makeBaseline(RATES);
const reordered = makeBaseline(
  Object.fromEntries(Object.entries(RATES).reverse()) as Record<string, number>,
);
const sameKeys = JSON.stringify(Object.keys(baseAlt.metrics)) === JSON.stringify(Object.keys(reordered.metrics));
console.log(`  基线 metrics 键顺序：相同=${sameKeys}`);
console.log(
  `  基线键顺序不同的两份基线（同数值）输出逐位一致：${
    JSON.stringify(run(makeInput(baseAlt, manyEvents))) === JSON.stringify(run(makeInput(reordered, manyEvents)))
  }`,
);

// 重复 id 的幂等性 + 冲突重复的顺序依赖
{
  const dupA = [ev(1, { VPIP: true }, { eventId: 'x' }), ...manyEvents];
  const dupB = [...manyEvents, ev(1, { VPIP: true }, { eventId: 'x' })];
  console.log(`  追加一条「已存在 id」的事件（内容相同）→ 逐位一致：${stringify(dupA) === stringify(dupB)}`);
}

console.log('');
console.log('='.repeat(96));
console.log('D. 不可变性：尝试改写嵌套元素（ESM 严格模式，写入冻结对象会抛错）');
console.log('='.repeat(96));

const snap = mustOk(run(makeInput(base, manyEvents)));
type Attempt = [string, () => void];
const attempts: Attempt[] = [
  ['snapshot.deviationScore = 0', () => { (snap as unknown as Record<string, number>).deviationScore = 0; }],
  ['groupScores[0].score = 0', () => { (snap.groupScores[0] as unknown as Record<string, number>).score = 0; }],
  ['groupScores.push(...)', () => { (snap.groupScores as unknown as unknown[]).push({}); }],
  ['windows[0].stats[0].confidence = 1', () => { (snap.windows[0]!.stats[0] as unknown as Record<string, number>).confidence = 1; }],
  ['windows[0].stats[0].metric = "X"', () => { (snap.windows[0]!.stats[0] as unknown as Record<string, string>).metric = 'X'; }],
  ['windows[0].eventIds[0] = "X"', () => { (snap.windows[0]!.eventIds as unknown as string[])[0] = 'X'; }],
  ['windows[0].eventIds.push("X")', () => { (snap.windows[0]!.eventIds as unknown as string[]).push('X'); }],
  ['tilt.evidence[0] = "X"', () => { (snap.tilt.evidence as unknown as string[])[0] = 'X'; }],
  ['tilt.probability = 1', () => { (snap.tilt as unknown as Record<string, number>).probability = 1; }],
  ['signals[0].drivers.push("X")', () => { (snap.signals[0]!.drivers as unknown as string[]).push('X'); }],
  ['adjustments[0].reasons[0] = "X"', () => { (snap.adjustments[0]!.reasons as unknown as string[])[0] = 'X'; }],
  ['adjustments[0].confidence = 0', () => { (snap.adjustments[0] as unknown as Record<string, number>).confidence = 0; }],
  ['ignoredEvents[0].reason = "X"', () => { (snap.ignoredEvents[0] as unknown as Record<string, string>).reason = 'X'; }],
  ['evidenceEventIds.push("X")', () => { (snap.evidenceEventIds as unknown as string[]).push('X'); }],
  ['conflicts.push("X")', () => { (snap.conflicts as unknown as string[]).push('X'); }],
  ['explanation.push("X")', () => { (snap.explanation as unknown as string[]).push('X'); }],
];
const immutabilityRows: TableRow[] = [];
for (const [label, attempt] of attempts) {
  let blocked = false;
  let note = '';
  try {
    attempt();
    note = '未抛错';
  } catch (error) {
    blocked = true;
    note = (error as Error).name;
  }
  // 二次确认：写入是否真的没生效
  const stillFrozen = Object.isFrozen(
    label.startsWith('groupScores') ? snap.groupScores[0]! : label.startsWith('windows[0].stats') ? snap.windows[0]!.stats[0]! : label.startsWith('tilt') ? snap.tilt : snap,
  );
  immutabilityRows.push({ 修改尝试: label, 被拒绝: blocked ? '是' : '否', 异常: note, 深层已冻结: stillFrozen ? '是' : '否' });
}
table(immutabilityRows);
{
  // 深度遍历确认：所有对象/数组都冻结
  const notFrozen: string[] = [];
  walk(snap, 'snapshot', (path, v) => {
    if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) notFrozen.push(path);
  });
  console.log(`  递归遍历发现未冻结对象：${notFrozen.length === 0 ? '无' : JSON.stringify(notFrozen)}`);
}

console.log('');
console.log('='.repeat(96));
console.log('E. 类型层隔离的真实性：强行注入下游字段 / 原型链');
console.log('='.repeat(96));

const cleanInput = makeInput(base, manyEvents);
const cleanJson = JSON.stringify(run(cleanInput));

const downstream = {
  adjustedRange: { width: 999 },
  inferredVillainRange: ['AA', 'KK'],
  finalAction: 'JAM',
  recommendation: 'CALL',
  decisionConfidence: 1,
  exploitOutput: { x: 1 },
  previousDynamicState: 'TILT_SIGNAL',
  previousTiltProbability: 0.99,
  tilt: { probability: 1 },
  showdownRange: ['AA'],
  finalProfitLoss: -100000,
  decision: { action: 'FOLD' },
  action: 'RAISE',
};

type InjectionCase = [string, () => unknown];
const injectionCases: InjectionCase[] = [
  ['多余属性直接挂在 input 上（as any）', () => run(Object.assign(makeInput(base, manyEvents), downstream) as never)],
  ['原型链注入（Object.setPrototypeOf）', () => {
    const input = makeInput(base, manyEvents);
    Object.setPrototypeOf(input, { ...downstream, __proto__: Object.getPrototypeOf(input) });
    return run(input);
  }],
  ['注入到 baseline 快照上', () => {
    const b = makeBaseline(RATES) as unknown as Record<string, unknown>;
    Object.assign(b, downstream);
    return run(makeInput(b as never, manyEvents));
  }],
  ['注入到每条事件上', () =>
    run(
      makeInput(
        base,
        manyEvents.map((e) => Object.assign({}, e, downstream)),
      ),
    )],
  ['注入到 baseline.metrics 的每一项上', () => {
    const b = makeBaseline(RATES) as unknown as { metrics: Record<string, Record<string, unknown>> };
    for (const key of Object.keys(b.metrics)) Object.assign(b.metrics[key]!, downstream);
    return run(makeInput(b as never, manyEvents));
  }],
];
for (const [label, fn] of injectionCases) {
  const json = JSON.stringify(fn());
  console.log(`  · ${label}：与干净输入逐位一致 = ${json === cleanJson}`);
}

// 用「输赢变化」直接对照：同一行为、不同结果上下文
console.log('');
console.log('  —— 结果隔离对照：同行为 + 不同 contextEvents（COOLER / LOST_BIG_POT）——');
{
  const events = manyEvents;
  const seq = events.map((e) => e.seq);
  const mid = seq[Math.floor(seq.length / 2)]!;
  const coolers = [
    { contextEventId: 'c1', handId: `h${mid}`, playerId: PLAYER, seq: mid, timestamp: new Date(T0 + mid * 60_000).toISOString(), kind: 'COOLER' },
    { contextEventId: 'c2', handId: `h${mid + 1}`, playerId: PLAYER, seq: mid + 1, timestamp: new Date(T0 + (mid + 1) * 60_000).toISOString(), kind: 'LOST_BIG_POT' },
  ];
  const a = JSON.stringify(run(makeInput(base, events)));
  const b = JSON.stringify(run(makeInput(base, events, { contextEvents: coolers as never })));
  console.log(`    无上下文 vs 两次重大损失上下文 → 逐位一致 = ${a === b}`);
  const won = coolers.map((c, i) => ({ ...c, contextEventId: `w${i}`, kind: i === 0 ? 'WON_BIG_POT' : 'SHOWDOWN' }));
  const c = JSON.stringify(run(makeInput(base, events, { contextEvents: won as never })));
  console.log(`    输的上下文 vs 赢的上下文（同 seq 锚点）→ 逐位一致 = ${b === c}`);
}
