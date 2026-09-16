/**
 * rt7-probe5.ts —— 契约一致性 / 可达性 / 隔离边界
 *
 * A. asOf 非有限值               B. 脏机会数组被静默接受
 * C. 死字段与数据丢失级联         D. SIZING 组与未登记指标 = 死代码
 * E. 上下文事件：playerId / 时间戳 / observedAfterEventIds 全部不校验
 * F. 人工 Hint：时间戳被忽略、静默丢弃、与 tilt.probability 自相矛盾
 * G. 适配层：direction 与 multiplier 自相矛盾
 * H. MAX_SINGLE_EVENT_SHARE 与 RecentBehaviorStat.effectiveSample 是死常量/死字段
 *
 * 运行：node.exe --experimental-strip-types "scripts/rt7-probe5.ts"
 */

import {
  adaptAdjustments,
  describeAdaptation,
  multiplierOf,
  UNVERIFIED_MAGNITUDE,
} from '../src/domain/dynamic/dynamicAdapter.ts';
import { evaluateDynamicBehavior, resolveUserHints } from '../src/domain/dynamic/dynamicBehavior.ts';

import {
  AS_OF,
  PLAYER,
  T0,
  ev,
  fmt,
  groupOf,
  makeBaseline,
  makeInput,
  mustOk,
  run,
  signalOf,
  spread,
  table,
} from './rt7-lib.ts';
import type { DynamicBehaviorSnapshot, ObservedPokerEvent, TableRow } from './rt7-lib.ts';

const RATES = { VPIP: 0.22, PFR: 0.17, THREE_BET: 0.06, CALL_OPEN: 0.14, RIVER_CALL: 0.38 };

function brief(snap: DynamicBehaviorSnapshot): string {
  return `状态=${snap.dominantState} 分数=${snap.deviationScore} 置信=${fmt(snap.confidence, 3)} tilt=${fmt(snap.tilt.probability, 3)} 信号=[${snap.signals
    .map((s) => `${s.state}:${fmt(s.probability, 2)}`)
    .join(',')}] 调整=[${snap.adjustments.map((a) => a.target).join(',')}] 冲突=${snap.conflicts.length}`;
}

console.log('='.repeat(96));
console.log('A. asOf = NaN / Infinity：未来事件过滤失效 + 快照字段被污染');
console.log('='.repeat(96));
{
  const base = makeBaseline(RATES);
  // 事件时间戳全部落在 asOf 之后 30 天（真正的未来事件）
  const future = Array.from({ length: 20 }, (_, i) =>
    ev(i + 1, { VPIP: i % 2 === 0, PFR: false, THREE_BET: false, CALL_OPEN: false, RIVER_CALL: false }, {
      ts: AS_OF + (i + 1) * 86_400_000,
    }),
  );
  const rows: TableRow[] = [];
  for (const asOf of [AS_OF, NaN, Infinity, -Infinity]) {
    const outcome = evaluateDynamicBehavior(makeInput(base, future, { asOf }));
    if (!outcome.ok) {
      rows.push({ asOf: String(asOf), 结果: `FAIL ${outcome.code}` });
      continue;
    }
    const v = outcome.value;
    const w20 = v.windows.find((w) => w.size === 20)!;
    rows.push({
      asOf: String(asOf),
      '快照 asOf': String(v.asOf),
      'JSON 后': JSON.stringify(v.asOf),
      未来事件被忽略数: v.ignoredEvents.length,
      'W20 机会数': w20.stats.reduce((s, x) => s + x.opportunities, 0),
      状态: v.dominantState,
      分数: v.deviationScore,
    });
  }
  table(rows);
  console.log('  说明：asOf=NaN / Infinity 时 `time > asOf` 恒为 false → **全部未来事件照常参与计算**。');
}

console.log('');
console.log('='.repeat(96));
console.log('B. 脏机会数组：Fail Closed 还是静默接受 / 崩溃');
console.log('='.repeat(96));
{
  const base = makeBaseline(RATES);
  const mk = (opportunities: unknown): ObservedPokerEvent =>
    ({ eventId: 'e1', handId: 'h1', playerId: PLAYER, seq: 1, timestamp: new Date(T0 + 60_000).toISOString(), opportunities }) as unknown as ObservedPokerEvent;
  const rows: TableRow[] = [];
  const cases: Array<[string, unknown]> = [
    ['opportunities = {}', {}],
    ['opportunities = 42', 42],
    ['opportunities = [null]', [null]],
    ['opportunities = [{}]（无 metric / 无 success）', [{}]],
    ['success = "yes"（字符串）', [{ metric: 'VPIP', success: 'yes' }]],
    ['success 缺失', [{ metric: 'VPIP' }]],
    ['metric = "NOT_A_METRIC"', [{ metric: 'NOT_A_METRIC', success: true }]],
    ['metric = null', [{ metric: null, success: true }]],
  ];
  for (const [label, opportunities] of cases) {
    try {
      const outcome = evaluateDynamicBehavior(makeInput(base, [mk(opportunities)]));
      if (!outcome.ok) {
        rows.push({ 输入: label, 结果: `Fail Closed ${outcome.code}`, 'W20 统计项': '-', 'ignored': '-' });
        continue;
      }
      const v = outcome.value;
      const stats = v.windows.find((w) => w.size === 20)!.stats;
      rows.push({
        输入: label,
        结果: 'ok（未拒绝）',
        'W20 统计项': stats.map((s) => `${String(s.metric)}:${s.successes}/${s.opportunities}`).join(' ') || '（空）',
        'ignored': v.ignoredEvents.length,
      });
    } catch (error) {
      rows.push({ 输入: label, 结果: `**崩溃** ${(error as Error).name}`, 'W20 统计项': '-', 'ignored': '-' });
    }
  }
  table(rows);

  // success 真值性：20 手、success:"yes" vs success:true vs success 缺失
  const variants: Array<[string, unknown]> = [
    ['success: true（20 手全命中）', (i: number) => ({ metric: 'VPIP', success: true, i })],
    ['success: "yes"（20 手全命中）', () => ({ metric: 'VPIP', success: 'yes' })],
    ['success: 1（20 手全命中）', () => ({ metric: 'VPIP', success: 1 })],
    ['success 缺失（20 手）', () => ({ metric: 'VPIP' })],
  ];
  for (const [label, make] of variants) {
    const events = Array.from({ length: 20 }, (_, i) =>
      ev(i + 1, {}, { extra: { opportunities: [(make as (i: number) => unknown)(i)] } }),
    );
    const v = mustOk(run(makeInput(base, events)));
    const stat = v.windows.find((w) => w.size === 20)!.stats[0];
  console.log(`  ${label} → successes=${stat?.successes} rawRate=${fmt(stat?.rawRate ?? null, 3)} 状态=${v.dominantState}`);
  }
}

console.log('');
console.log('='.repeat(96));
console.log('C. betSizePotRatio：一个**不参与任何计算**的字段，却能让整条事件被丢弃');
console.log('='.repeat(96));
{
  const base = makeBaseline(RATES);
  const flags = spread(8, 7); // 8 次机会 7 次命中 —— 远超基线，且刚好卡在门槛上
  const rows: TableRow[] = [];
  for (const [label, extra] of [
    ['无 betSizePotRatio', {}],
    ['betSizePotRatio = 0.75（合法）', { betSizePotRatio: 0.75 }],
    ['betSizePotRatio = -1（非法）', { betSizePotRatio: -1 }],
    ['betSizePotRatio = NaN', { betSizePotRatio: NaN }],
    ['isOverbet = true / isAllIn = true', { isOverbet: true, isAllIn: true }],
    ['isOverbet = "垃圾值"', { isOverbet: '垃圾值' }],
  ] as Array<[string, Record<string, unknown>]>) {
    const events = flags.map((f, i) => ev(i + 1, { VPIP: f }, { extra }));
    const v = mustOk(run(makeInput(base, events)));
    const w20 = v.windows.find((w) => w.size === 20)!;
    rows.push({
      场景: label,
      'W20 机会数': w20.stats.reduce((s, x) => s + x.opportunities, 0),
      被丢弃事件: v.ignoredEvents.length,
      状态: v.dominantState,
      分数: v.deviationScore,
      调整: v.adjustments.length,
    });
  }
  table(rows);
  console.log('  说明：betSizePotRatio 只被 validateEvent 校验，从未被任何计算读取；');
  console.log('  但一次非法值会让**整条事件的所有机会**被丢弃（Fail Closed 用错了对象）。');
}

console.log('');
console.log('='.repeat(96));
console.log('D. SIZING 组与「未登记进 METRIC_GROUP 的真实指标」= 死代码');
console.log('='.repeat(96));
{
  const base = makeBaseline({ ...RATES, RIVER_OVERBET: 0.08, CBET: 0.6, TURN_BARREL: 0.55 });
  const withSize = Array.from({ length: 20 }, (_, i) =>
    ev(i + 1, { VPIP: true, PFR: true, THREE_BET: true, CALL_OPEN: true, RIVER_CALL: true }, {
      extra: { betSizePotRatio: i % 3 === 0 ? 3.5 : 0.4, isOverbet: i % 3 === 0, isAllIn: i % 5 === 0 },
    }),
  );
  const withoutSize = Array.from({ length: 20 }, (_, i) =>
    ev(i + 1, { VPIP: true, PFR: true, THREE_BET: true, CALL_OPEN: true, RIVER_CALL: true }),
  );
  const a = mustOk(run(makeInput(base, withSize)));
  const b = mustOk(run(makeInput(base, withoutSize)));
  console.log(`  超池/全下/尺寸比全开 vs 完全不提供 → JSON 逐位一致 = ${JSON.stringify(a) === JSON.stringify(b)}`);
  console.log(`  SIZING 组：score=${groupOf(a, 'SIZING').score} direction=${groupOf(a, 'SIZING').direction} comparedMetrics=${groupOf(a, 'SIZING').comparedMetrics}`);
  console.log(`  是否出现过 SIZE_ANOMALY 信号：${a.signals.some((s) => s.state === 'SIZE_ANOMALY')}；状态=${a.dominantState}`);

  // 未登记指标：RIVER_OVERBET / CBET / TURN_BARREL 全命中 → 对偏差零贡献，但推高机会总数
  const rows: TableRow[] = [];
  for (const [label, metric] of [
    ['RIVER_OVERBET（未登记）', 'RIVER_OVERBET'],
    ['CBET（未登记）', 'CBET'],
    ['TURN_BARREL（未登记）', 'TURN_BARREL'],
    ['RIVER_CALL（已登记）', 'RIVER_CALL'],
  ] as Array<[string, string]>) {
    const events = Array.from({ length: 20 }, (_, i) => ev(i + 1, { [metric]: true }));
    const v = mustOk(run(makeInput(base, events)));
    const w20 = v.windows.find((w) => w.size === 20)!;
    rows.push({
      指标: label,
      'W20 机会总数': w20.stats.reduce((s, x) => s + x.opportunities, 0),
      状态: v.dominantState,
      分数: v.deviationScore,
      '该指标是否进入偏差计算': v.groupScores.some((g) => g.strongestMetric === metric) ? '是' : '否',
    });
  }
  table(rows);
  // 1 手牌塞满未登记指标 → 越过 MIN_RECENT_OPPORTUNITIES 门槛
  {
    const base2 = makeBaseline({ VPIP: 0.22, CBET: 0.6, TURN_BARREL: 0.55, RIVER_OVERBET: 0.08, FOLD_TO_CBET: 0.45, TURN_FOLD: 0.45, TURN_RAISE: 0.12, RIVER_SHOWDOWN: 0.5 });
    const one = [
      ev(1, { VPIP: true, CBET: true, TURN_BARREL: true, RIVER_OVERBET: true, FOLD_TO_CBET: true, TURN_FOLD: true, TURN_RAISE: true, RIVER_SHOWDOWN: true }),
    ];
    const v = mustOk(run(makeInput(base2, one)));
    console.log(`  1 手牌 / 8 个机会（7 个未登记指标）→ 状态=${v.dominantState} 置信=${fmt(v.confidence, 4)} explanation=${JSON.stringify(v.explanation)}`);
    console.log('  （MIN_RECENT_OPPORTUNITIES = 8：门槛被未登记指标的机会数凑满，因此不再是 UNKNOWN）');
  }
}

console.log('');
console.log('='.repeat(96));
console.log('E. 上下文事件：playerId / timestamp / observedAfterEventIds 全部不参与校验');
console.log('='.repeat(96));
{
  const base = makeBaseline({ VPIP: 0.15 });
  const flags = [...spread(20, 3), ...spread(20, 12)];
  const events = flags.map((f, i) => ev(i + 1, { VPIP: f }));
  const anchor = { contextEventId: 'c1', handId: 'h20', playerId: PLAYER, seq: 20, timestamp: new Date(T0 + 20 * 60_000).toISOString(), kind: 'LOST_BIG_POT' as const };
  const asOther = { ...anchor, playerId: 'somebody-else' };
  const asFuture = { ...anchor, timestamp: '2099-01-01T00:00:00.000Z' };
  const narrowed = { ...anchor, observedAfterEventIds: ['e21'] };
  const wrongHand = { ...anchor, handId: 'not-exist' };
  const noContext = JSON.stringify(run(makeInput(base, events)));
  const withContext = JSON.stringify(run(makeInput(base, events, { contextEvents: [anchor] })));
  const rows: TableRow[] = [
    { 变体: '无上下文事件', 与无上下文逐位一致: '—', tilt概率: fmt(mustOk(run(makeInput(base, events))).tilt.probability, 4) },
  ];
  for (const [label, ctx] of [
    ['正确 playerId', anchor],
    ['playerId = somebody-else（别人的损失）', asOther],
    ['timestamp = 2099（未来）', asFuture],
    ['observedAfterEventIds = ["e21"]（应只看 1 条）', narrowed],
    ['handId 不存在', wrongHand],
  ] as Array<[string, unknown]>) {
    const json = JSON.stringify(run(makeInput(base, events, { contextEvents: [ctx as never] })));
    const snap = mustOk(run(makeInput(base, events, { contextEvents: [ctx as never] })));
    rows.push({
      变体: label,
      与无上下文逐位一致: json === noContext ? '是' : '否',
      tilt概率: fmt(snap.tilt.probability, 4),
    });
  }
  table(rows);
  console.log(`  有上下文时 tilt.probability = ${fmt(mustOk(run(makeInput(base, events, { contextEvents: [anchor] }))).tilt.probability, 4)}（说明上下文确实生效）`);
  void withContext;
}

console.log('');
console.log('='.repeat(96));
console.log('F. 人工 Hint：时间戳被忽略 / 静默丢弃 / 与 tilt.probability 自相矛盾');
console.log('='.repeat(96));
{
  const base = makeBaseline(RATES);
  // 样本稀薄：8 手 × 1 机会 = 8 → confidence 低（< 0.5），Hint 可以覆盖状态
  const thin = Array.from({ length: 8 }, (_, i) => ev(i + 1, { VPIP: i < 4 }));
  const hintFuture = { kind: 'SUSPECT_TILT' as const, timestamp: '2099-01-01T00:00:00.000Z' };
  const hintPast = { kind: 'SUSPECT_TILT' as const, timestamp: '2020-01-01T00:00:00.000Z' };
  const noHint = mustOk(run(makeInput(base, thin)));
  const withFuture = mustOk(run(makeInput(base, thin, { userHints: [hintFuture] })));
  const withPast = mustOk(run(makeInput(base, thin, { userHints: [hintPast] })));
  console.log(`  无 Hint                ：${brief(noHint)}`);
  console.log(`  Hint 时间戳 = 2099（未来）：${brief(withFuture)}`);
  console.log(`  Hint 时间戳 = 2020（过去）：${brief(withPast)}`);
  console.log(`  未来 Hint 与过去 Hint 输出逐位一致 = ${JSON.stringify(withFuture) === JSON.stringify(withPast)}`);
  console.log(`  → 结果：dominantState=${withFuture.dominantState}，但 tilt.probability=${withFuture.tilt.probability}，signals=${JSON.stringify(withFuture.signals)}`);
  console.log(`     而调整：${JSON.stringify(adaptAdjustments(withFuture).map((x) => `${x.target} ${x.direction} ×${fmt(x.multiplier, 4)}`))}`);
  console.log(`  → 快照里**没有任何 provenance 字段**标明该状态来自人工观察而非真实数据。`);

  // 数组顺序 vs 时间戳
  const a = mustOk(run(makeInput(base, thin, { userHints: [{ kind: 'NORMAL', timestamp: '2026-05-01T00:00:00.000Z' }, { kind: 'SUSPECT_TILT', timestamp: '2020-01-01T00:00:00.000Z' }] })));
  const b = mustOk(run(makeInput(base, thin, { userHints: [{ kind: 'SUSPECT_TILT', timestamp: '2020-01-01T00:00:00.000Z' }, { kind: 'NORMAL', timestamp: '2026-05-01T00:00:00.000Z' }] })));
  console.log(`  [NORMAL(新), SUSPECT_TILT(旧)] → ${a.dominantState}；[SUSPECT_TILT(旧), NORMAL(新)] → ${b.dominantState}`);
  console.log(`  → 采用「数组最后一条」，而不是「时间戳最新的一条」；逐位一致 = ${JSON.stringify(a) === JSON.stringify(b)}`);

  // resolveUserHints 的 overridden 语义
  const solid = Array.from({ length: 40 }, (_, i) => ev(i + 1, { VPIP: true, PFR: true, THREE_BET: true, CALL_OPEN: true, RIVER_CALL: true }));
  const solidSnap = mustOk(run(makeInput(base, solid)));
  const hintOnSolid = mustOk(run(makeInput(base, solid, { userHints: [{ kind: 'TIGHTER_RECENTLY', timestamp: '2099-01-01T00:00:00.000Z' }] })));
  console.log(`  充足真实数据（opportunities=${solidSnap.windows.find((w) => w.size === 20)!.stats.reduce((s, x) => s + x.opportunities, 0)}, 置信=${fmt(solidSnap.confidence, 3)}）：`);
  console.log(`    无 Hint：${brief(solidSnap)}`);
  console.log(`    加一条 TIGHTER_RECENTLY Hint：${brief(hintOnSolid)}`);
  console.log(`    冲突记录变化：${JSON.stringify(solidSnap.conflicts)} → ${JSON.stringify(hintOnSolid.conflicts)}`);
  const resolved = resolveUserHints([{ kind: 'TIGHTER_RECENTLY', timestamp: '2099-01-01T00:00:00.000Z' }], {
    recentOpportunities: 12,
    confidence: 0.9,
    dominantState: 'NORMAL',
  });
  console.log(`    resolveUserHints(机会数=12, 置信=0.9) → ${JSON.stringify(resolved)}`);
  console.log('    → Hint 被**静默丢弃**：没有 conflict 记录，overridden 仍为 false（调用方无法察觉）。');
  void groupOf;
  void signalOf;
}

console.log('');
console.log('='.repeat(96));
console.log('G. 适配层：同一目标两个相反方向的调整相乘 → direction 与 multiplier 自相矛盾');
console.log('='.repeat(96));
{
  const base = makeBaseline({ VPIP: 0.15, PFR: 0.17, THREE_BET: 0.25 });
  const flags = [...spread(20, 3), ...spread(20, 12)];
  const events = flags.map((f, i) => ev(i + 1, { VPIP: f, PFR: false, THREE_BET: false }));
  const anchor = { contextEventId: 'c1', handId: 'h20', playerId: PLAYER, seq: 20, timestamp: new Date(T0 + 20 * 60_000).toISOString(), kind: 'BAD_BEAT' as const };
  const snap = mustOk(run(makeInput(base, events, { contextEvents: [anchor] })));
  console.log(`  快照：${brief(snap)}`);
  console.log(`  adjustments = ${JSON.stringify(snap.adjustments.map((a) => [a.target, a.direction, fmt(a.confidence, 3), a.reasons[0]]))}`);
  const adapted = adaptAdjustments(snap);
  for (const x of adapted) console.log(`    ${describeAdaptation(x)}  reasons=${JSON.stringify(x.reasons)}`);
  const contradiction = adapted.filter((x) => (x.direction === 'INCREASE' && x.multiplier < 1) || (x.direction === 'DECREASE' && x.multiplier > 1) || x.multiplier === 1);
  console.log(`  自相矛盾的输出条数 = ${contradiction.length}（direction 说调整，multiplier 说没调整或其反）`);
  console.log(`  multiplierOf 是导出 API：multiplierOf(INCREASE, 1) = ${fmt(multiplierOf('INCREASE' as never, 1), 6)}；UNVERIFIED_MAGNITUDE.maxMagnitude = ${UNVERIFIED_MAGNITUDE.maxMagnitude}`);
  console.log('  → 导出 API 可以直接拿到一个**没有任何 provenance 标注**的乘性因子。');
}

console.log('');
console.log('='.repeat(96));
console.log('H. MAX_SINGLE_EVENT_SHARE / RecentBehaviorStat.effectiveSample 是否为死代码');
console.log('='.repeat(96));
console.log('  源码事实（grep 结果）：');
console.log('    src/domain/dynamic/dynamicBehavior.ts:41  import { MAX_SINGLE_EVENT_SHARE }');
console.log('    src/domain/dynamic/dynamicBehavior.ts:874 export { MAX_SINGLE_EVENT_SHARE }  ← 仅转出，无任何计算使用');
console.log('    src/domain/dynamic/dynamicStats.ts:282    capSingleHandWeight(bucket.weights, DEFAULT_DECAY.maxSingleHandShare)');
console.log('    → 实际生效的是 Step 6 的 DEFAULT_DECAY.maxSingleHandShare（同为 0.05），');
console.log('      Dynamic 自己声明的 MAX_SINGLE_EVENT_SHARE 改不动任何输出。');
{
  const base = makeBaseline(RATES);
  const events = Array.from({ length: 20 }, (_, i) => ev(i + 1, { VPIP: i % 3 === 0, PFR: false, THREE_BET: false, CALL_OPEN: false, RIVER_CALL: false }));
  const snap = mustOk(run(makeInput(base, events)));
  const stats = snap.windows.find((w) => w.size === 20)!.stats;
  console.log('  RecentBehaviorStat.effectiveSample 的实际值（只有输出，无消费者）：');
  console.log(`    ${stats.map((s) => `${s.metric}=${fmt(s.effectiveSample, 3)}`).join('  ')}`);
  const groupConf = snap.groupScores.map((g) => `${g.group}:${fmt(g.confidence, 3)}`).join(' ');
  console.log(`  组置信度（来自 stat.confidence = 机会数映射，与 effectiveSample 无关）：${groupConf}`);
}
void AS_OF;
