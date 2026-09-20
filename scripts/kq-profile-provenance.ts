/**
 * ============================================================================
 * Task C 单变量实验：**老周的 1200 手统计到底有没有进入生产决策？**
 * ============================================================================
 *
 * 只读。同一节点跑两遍：① 带 `villain.observedStats`（1200 手）② 不带（null）。
 * 若两遍在**所有决策相关输出**上逐位一致 ⇒ 统计没有进入决策链。
 *
 * 同时打印 `parseManualInput` 之后 `villain.observedStats` 是否还在，
 * 以及诊断里 `player` 块自述的 `handsObserved` / `sampleSize` / `tier`。
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES, asOf: 1_757_000_000_000, writeLog: false,
  equitySeed: 20_261_014, budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

const A = (position: string, type: string, amountBB?: number, street?: string) => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

const STATS = {
  handsObserved: 1200, vpip: 0.49, pfr: 0.09, threeBet: 0.03, wtsd: 0.42,
  foldToFlopCBet: 0.23, foldToTurnCBet: 0.19, foldToRiverBet: 0.16,
  flopCheckRaise: null, turnCheckRaise: null, riverCheckRaise: 0.02,
} as const;

function node(withStats: boolean): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['Ks', 'Qs'],
    board: ['Kd', '9c', '4h', '6s', '2d'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 10, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: {
      playerId: '老周', quickProfile: 'CALLING_STATION', dynamicHint: 'UNKNOWN', stackBB: 100,
      ...(withStats ? { observedStats: STATS } : { observedStats: null }),
    },
  } as unknown as ManualHandInput;
}

const line = (s = ''): void => console.log(s);
const n = (v: unknown, d = 6): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');

function snapshot(label: string, withStats: boolean) {
  const input = node(withStats);
  const parsed = parseManualInput(input);
  line(`【${label}】`);
  line(`  parseManualInput ok = ${parsed.ok}`);
  if (parsed.ok) {
    const os = (parsed.value.villain as Record<string, unknown>)['observedStats'];
    line(`  parse 之后 villain.observedStats = ${os === null || os === undefined ? String(os) : JSON.stringify(os).slice(0, 200)}`);
  } else {
    line(`  issues = ${JSON.stringify(parsed.issues)}`);
    return null;
  }
  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) { line(`  分析失败：${r.stage}`); return null; }
  const d = r.decision as unknown as Record<string, any>;
  const dg = d['diagnostics'] as Record<string, any>;
  const m = dg['math'] as Record<string, any>;
  const pf = (dg['postflop'] ?? {}) as Record<string, any>;
  const f = (pf['raiseResponse'] ?? null) as Record<string, any> | null;
  const player = (dg['player'] ?? {}) as Record<string, any>;
  line(`  player 自述：handsObserved=${String(player['handsObserved'])}｜dimensions.sampleSize=${String((player['dimensions'] ?? {})['sampleSize'])}｜tier=${String((player['dimensions'] ?? {})['tier'])}｜note=${String(player['note']).slice(0, 80)}`);
  line(`  动作 = ${String(d['action'])}${d['sizeChips'] == null ? '' : ` @ ${String(d['sizeChips'])}`}｜CALL EV = ${n(m['callEV'])}｜EqVsBetRange = ${n(m['heroEquityVsBetRange'])}`);
  line(`  RAISE@${f === null ? '—' : String(f['sizeChips'])} EV = ${f === null ? '—' : n(f['raiseEV'])}｜P(弃)/P(跟)/P(再加) = ${f === null ? '—' : `${n(f['foldLikelihood'], 4)}/${n(f['callLikelihood'], 4)}/${n(f['reRaiseLikelihood'], 4)}`}`);
  line(`  EqVsArrivalRange = ${n((dg['conditionalEquities'] ?? {})['arrivalRange'])}｜EqVsRaiseCallRange = ${n(f?.['heroEquityVsRaiseCallRange'])}`);
  return {
    action: String(d['action']),
    sizeChips: d['sizeChips'] ?? null,
    callEV: m['callEV'] as number,
    eqVsBetRange: m['heroEquityVsBetRange'] as number,
    eqVsArrival: (dg['conditionalEquities'] ?? {})['arrivalRange'] as number,
    raiseEV: f === null ? null : (f['raiseEV'] as number),
    fold: f === null ? null : (f['foldLikelihood'] as number),
    call: f === null ? null : (f['callLikelihood'] as number),
    rr: f === null ? null : (f['reRaiseLikelihood'] as number),
    eqVsRaiseCall: f === null ? null : (f['heroEquityVsRaiseCallRange'] as number),
    reasons: ((d['reasons'] ?? []) as Record<string, any>[]).map((x) => String(x['code'])).join(','),
  };
}

line('='.repeat(110));
line(' Task C 单变量实验：带 / 不带 1200 手统计');
line('='.repeat(110));
const withStats = snapshot('① 带 observedStats（1200 手）', true);
line('');
const withoutStats = snapshot('② 不带 observedStats（null）', false);
line('');
line('='.repeat(110));
if (withStats === null || withoutStats === null) { line('  有一侧失败，无法比较'); process.exit(1); }
const keys = Object.keys(withStats) as (keyof typeof withStats)[];
let same = 0;
line('  字段                              带统计              不带统计            一致?');
for (const k of keys) {
  const a = withStats[k];
  const b = withoutStats[k];
  const equal = typeof a === 'number' && typeof b === 'number'
    ? Math.abs(a - b) < 1e-12
    : JSON.stringify(a) === JSON.stringify(b);
  if (equal) same += 1;
  line(`  ${k.padEnd(30)}${String(a).slice(0, 20).padEnd(20)}${String(b).slice(0, 20).padEnd(20)}${equal ? '✔' : '✖ **不同**'}`);
}
line('');
line(same === keys.length
  ? '  ⇒ **全部字段逐位一致**：本输入形态下，1200 手统计**没有进入决策链**（单变量实验结论）。'
  : `  ⇒ ${keys.length - same} 个字段不同 ⇒ 统计确实进入了决策链（详见上表）。`);
line('');
line(`  诊断自述的 player.note 说明它走的是哪条通道：` +
  `「${String(((withStats as unknown as Record<string, unknown>)['reasons'] ?? ''))}」`);
line('');
line('='.repeat(110));
line(' 追加：**直接调用 V3 resolver**，看统计是否被解析（排除「诊断块只是展示字段」的可能）');
line('='.repeat(110));
const { resolvePlayerProfile } = await import('../src/domain/player/observedStats.ts');
for (const [label, stats] of [['带 1200 手统计', STATS], ['不带（null）', null]] as const) {
  const out = resolvePlayerProfile({
    baseArchetype: 'CALLING_STATION' as never,
    observedStats: stats as never,
    opportunities: undefined as never,
    actionContext: null as never,
    street: 'RIVER' as never,
  }) as Record<string, any>;
  const rs = out['resolved'] as Record<string, any>;
  line(`  【${label}】`);
  line(`    dimensions = ${JSON.stringify(rs['dimensions'] ?? rs)}`.slice(0, 260));
  line(`    street.RIVER = ${JSON.stringify(rs['street']?.['RIVER'] ?? rs['street'])}`);
  line(`    confidence = ${String(rs['confidence'])}｜tier = ${String(rs['tier'])}｜note = ${String(rs['noteZh'] ?? rs['note'] ?? '').slice(0, 120)}`);
  const trace = (out['trace'] ?? []) as Record<string, any>[];
  const river = trace.filter((t) => String(t['stat']) === 'foldToRiverBet');
  for (const t of river) {
    line(`    foldToRiverBet: observed=${String(t['observedRate'])}→effective=${String(t['effectiveRate'])}` +
      `｜opportunities=${String(t['opportunities'])}｜successes=${String(t['successes'])}` +
      `｜approximated=${String(t['approximated'])}｜priorWeight=${String(t['priorWeight'])}｜priorRate=${String(t['priorRate'])}` +
      `｜confidence=${String(t['confidence'])}｜streetTrait=${String(t['streetTrait'])}`);
  }
  if (river.length === 0) line(`    （trace 中没有 foldToRiverBet：trace 长度 ${trace.length}，键 ${trace.length > 0 ? Object.keys(trace[0]!).join(',') : '—'}）`);
}
line('');
line('='.repeat(110));
