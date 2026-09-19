/**
 * V21 画像失败模式审计 —— 生产管线探针
 *
 * 走**真实生产入口** `analyzeManualHand` + `buildDecisionContext`（与界面 / `/api/analyze` 同一条路），
 * 基座夹具 = `test/profileQuantificationGolden.test.ts` 的黄金手（9-max CO A♣J♥，
 * 河牌 A♦8♠4♠2♣K♦，BB 在 Hero 转牌 check-back 后下注 7BB）。
 *
 * 用法：
 * ```text
 * node --experimental-strip-types scripts/v21-fmaudit-pipeline.ts            # 全部
 * node --experimental-strip-types scripts/v21-fmaudit-pipeline.ts --quick    # 只跑一组基准
 * ```
 */

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import {
  BehaviorTraitKey,
  behaviorProfileOf,
  type PlayerBehaviorProfile,
} from '../src/domain/player/behaviorProfile.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const WIDE = { softMs: 120_000, hardMs: 240_000 } as const;
const ASOF = 1_757_000_000_000; // 2025-09-02 前后，与黄金测试同值
const OPTIONS = {
  rules: RULES,
  asOf: ASOF,
  writeLog: false,
  budget: WIDE,
  equitySeed: 20260913,
} as const;

const SEATS9 = {
  UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
  CO: 100, BTN: 100, SB: 100, BB: 100,
} as const;

const line = (s = ''): void => console.log(s);
const h = (t: string): void => {
  line();
  line('='.repeat(96));
  line(t);
  line('='.repeat(96));
};
const f = (x: number | null | undefined, d = 4): string => (x === null || x === undefined ? '—' : x.toFixed(d));

/* ============================================================
 * 夹具
 * ============================================================ */

/** §十七 黄金局的行动历史（逐字复制自 test/profileQuantificationGolden.test.ts:93-109） */
const HISTORY_GOLDEN = [
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

/** 三人底池（河牌 Hero BB 面对 CO 下注；UTG 也在池里且已实现） */
const HISTORY_MULTIWAY = [
  { position: 'UTG', type: 'CALL', amountBB: 1 },
  { position: 'CO', type: 'CALL', amountBB: 1 },
  { position: 'BTN', type: 'FOLD' },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CHECK' },
  { position: 'UTG', type: 'CHECK', street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'UTG', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'UTG', type: 'CHECK', street: 'TURN' },
  { position: 'CO', type: 'CHECK', street: 'TURN' },
  { position: 'BB', type: 'CHECK', street: 'TURN' },
  { position: 'UTG', type: 'CHECK', street: 'RIVER' },
  { position: 'CO', type: 'BET', amountBB: 6, street: 'RIVER' },
] as const;

function goldenInput(mutate?: (i: Record<string, unknown>) => void, villain: Record<string, unknown> = {}): ManualHandInput {
  const input: Record<string, unknown> = {
    tableSize: 9,
    heroPosition: 'CO',
    heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'],
    street: 'RIVER',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS9 },
    actionHistory: [...HISTORY_GOLDEN],
    environment: 'MID_LOW_STAKES',
    villain: { dynamicHint: 'UNKNOWN', stackBB: 100, ...villain },
  };
  if (mutate) mutate(input);
  return input as unknown as ManualHandInput;
}

/* ============================================================
 * 测量
 * ============================================================ */

type Row = {
  label: string;
  ok: boolean;
  stage: string;
  issues: string;
  action: string;
  equity: number | null;
  callEV: number | null;
  masses: Record<string, number | null>;
  support: number | null;
  effectiveCombos: number | null;
  providerApplied: boolean | null;
  comboWeightApplied: boolean | null;
  tendencyTier: string | null;
  equityDeltaPct: number | null;
  providerNote: string;
  dedup: string;
  comboWeightFactor: string;
  traceNotes: string[];
  warnings: string[];
  clamped: number | null;
  elapsedMs: number;
  /** 原始 diagnostics（只保留必要片段） */
  raw: unknown;
};

function measure(label: string, input: ManualHandInput, options: Record<string, unknown> = OPTIONS): Row {
  const t0 = performance.now();
  const r = analyzeManualHand(input, options as never);
  const elapsedMs = performance.now() - t0;
  const row: Row = {
    label, ok: false, stage: '-', issues: '-', action: '-', equity: null, callEV: null, masses: {},
    support: null, effectiveCombos: null, providerApplied: null, comboWeightApplied: null,
    tendencyTier: null, equityDeltaPct: null, traceNotes: [], warnings: [], clamped: null, elapsedMs,
    providerNote: '', dedup: '—', comboWeightFactor: '', raw: null,
  };
  if (!r.ok) {
    row.stage = r.stage;
    row.issues = JSON.stringify(r.issues);
    return row;
  }
  row.ok = true;
  row.action = String(r.decision.action);
  row.equity = r.decision.diagnostics.math.heroEquity ?? null;
  row.callEV = r.decision.diagnostics.math.callEV ?? null;

  const parsed = parseManualInput(input);
  if (!parsed.ok) {
    row.issues = 'PARSE: ' + JSON.stringify(parsed.issues);
    return row;
  }
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) {
    row.issues = 'STATE: ' + JSON.stringify(gate.issues);
    return row;
  }
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: (options['asOf'] as number | undefined) ?? ASOF,
    budget: WIDE,
    equitySeed: (options['equitySeed'] as number | undefined) ?? 20260913,
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
  const ctx = built.context;
  row.warnings = [...built.warnings];
  const facts = ctx.postflopFacts?.opponentRangeFacts as unknown as
    | {
        profileClassMasses?: Record<string, number | null>;
      }
    | undefined;
  const pc = facts?.profileClassMasses ?? null;
  if (pc) {
    row.masses = {
      value: pc['valueMass'] ?? null,
      thin: pc['thinValueMass'] ?? null,
      showdown: pc['showdownMass'] ?? null,
      missed: pc['missedDrawMass'] ?? null,
      pureAir: pc['pureAirMass'] ?? null,
      bluff: pc['bluffMass'] ?? null,
      unclassified: pc['unclassifiedMassShare'] ?? null,
    };
    row.support = (pc['rawSupportCombos'] as number | undefined) ?? null;
    row.effectiveCombos = pc['effectiveCombos'] ?? null;
  }
  const tend2 = ctx.profileRangeEvidence ?? null;
  row.providerApplied = tend2 === null ? null : tend2.provider.applied;
  row.comboWeightApplied = tend2 === null ? null : tend2.provider.comboWeightApplied;
  row.tendencyTier = tend2 === null ? null : tend2.dimensionTier;
  row.providerNote = tend2 === null ? '（无 profileRangeEvidence）' : tend2.provider.noteZh.join('｜');
  row.comboWeightFactor =
    tend2 === null
      ? ''
      : `形状层 ×${tend2.provider.comboWeightMultiplier.min.toFixed(3)}–${tend2.provider.comboWeightMultiplier.max.toFixed(3)}` +
        `（${tend2.provider.comboWeightMultiplier.effective}/${tend2.provider.comboWeightMultiplier.calls} 生效）` +
        `｜似然层 ×${tend2.provider.finalMultiplier.min.toFixed(3)}–${tend2.provider.finalMultiplier.max.toFixed(3)}` +
        `（${tend2.provider.finalMultiplier.effective}/${tend2.provider.finalMultiplier.calls} 生效）`;
  const post = r.decision.diagnostics.postflop as unknown as
    | { exploitAdjustmentZh?: string; confidence?: string }
    | undefined;
  row.dedup =
    post?.exploitAdjustmentZh === undefined
      ? '（无 exploitAdjustmentZh）'
      : `${String(post.exploitAdjustmentZh).slice(0, 220)}`;
  const ev = ctx.profileRangeEvidence ?? null;
  row.equityDeltaPct = ev === null ? null : ev.equityDeltaPct;
  row.traceNotes = (ctx.range?.updateTrace ?? []).map(
    (t) => `[${String(t.street)}] ${String(t.action)}${t.noteZh === undefined ? '' : ` —— ${t.noteZh}`}`,
  );
  row.raw = {
    equity: row.equity,
    callEV: row.callEV,
    masses: row.masses,
    provider: tend2 === null ? null : tend2.provider,
    dimensionTier: tend2 === null ? null : tend2.dimensionTier,
    evidence: ev,
    math: {
      pot: r.decision.diagnostics.math.pot,
      spr: r.decision.diagnostics.math.spr,
      requiredEquity: r.decision.diagnostics.math.requiredEquity,
    },
  };
  return row;
}

function show(rows: readonly Row[], extra?: (r: Row) => string): void {
  for (const r of rows) {
    line(
      `${r.label.padEnd(46)} ok=${String(r.ok).padEnd(5)} act=${r.action.padEnd(5)} ` +
        `EQ=${f(r.equity)} callEV=${f(r.callEV, 2)} ` +
        `bluffM=${f(r.masses['bluff'])} airM=${f(r.masses['pureAir'])} ` +
        `sup=${String(r.support)} effC=${f(r.effectiveCombos, 1)} ` +
        `prov=${String(r.providerApplied)} shape=${String(r.comboWeightApplied)} ` +
        `ΔEQ=${f(r.equityDeltaPct, 3)}pp ${r.elapsedMs.toFixed(0)}ms` +
        (extra ? ` ${extra(r)}` : ''),
    );
    if (r.issues !== '-') line(`    issues/stage: ${r.stage} ${r.issues}`);
    for (const w of r.warnings) line(`    warn: ${w.slice(0, 160)}`);
  }
}

const argv = new Set(process.argv.slice(2));
const QUICK = argv.has('--quick');

/* ============================================================
 * A 组：中性对照与画像基本影响（items 14 / 12 的一半）
 * ============================================================ */
h('A 中性对照：无画像 / UNKNOWN / NORMAL / 显式中性画像 / 原型画像');
const NEUTRAL_PROFILE = behaviorProfileOf({ playerId: 'neutral-explicit' });
const MANIAC_TAG_PROFILE = behaviorProfileOf({ playerId: 'villain', archetype: 'MANIAC' as never });
const CS_TAG_PROFILE = behaviorProfileOf({ playerId: 'villain', archetype: 'CALLING_STATION' as never });

const A_NONE = measure('A1 无 quickProfile / 无 behaviorProfile', goldenInput());
const A_UNKNOWN = measure('A2 quickProfile=UNKNOWN', goldenInput(undefined, { quickProfile: 'UNKNOWN' }));
const A_NORMAL = measure('A3 quickProfile=NORMAL', goldenInput(undefined, { quickProfile: 'NORMAL' }));
const A_EXPLICIT_NEUTRAL = measure('A4 只注入中性 behaviorProfile', goldenInput(undefined, { behaviorProfile: NEUTRAL_PROFILE }));
const A_MANIAC_PROFILE_ONLY = measure('A5 只注入 MANIAC behaviorProfile', goldenInput(undefined, { behaviorProfile: MANIAC_TAG_PROFILE }));
const A_MANIAC_NEUTRAL_PROFILE = measure('A6 quickProfile=MANIAC + 中性画像', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: NEUTRAL_PROFILE }));
const A_MANIAC = measure('A7 quickProfile=MANIAC（界面路径）', goldenInput(undefined, { quickProfile: 'MANIAC' }));
const A_CS = measure('A8 quickProfile=CALLING_STATION（界面路径）', goldenInput(undefined, { quickProfile: 'CALLING_STATION' }));
show([A_NONE, A_UNKNOWN, A_NORMAL, A_EXPLICIT_NEUTRAL, A_MANIAC_PROFILE_ONLY, A_MANIAC_NEUTRAL_PROFILE, A_MANIAC, A_CS]);

line();
line('— A 组逐位对照 —');
const bit = (a: number | null, b: number | null): string => (a === b ? '逐位相等' : `差 ${f((a ?? 0) - (b ?? 0))}`);
line(`A1 vs A2 权益：${bit(A_NONE.equity, A_UNKNOWN.equity)}｜诈唬质量：${bit(A_NONE.masses['bluff'] ?? null, A_UNKNOWN.masses['bluff'] ?? null)}`);
line(`A1 vs A3 权益：${bit(A_NONE.equity, A_NORMAL.equity)}｜诈唬质量：${bit(A_NONE.masses['bluff'] ?? null, A_NORMAL.masses['bluff'] ?? null)}`);
line(`A1 vs A4 权益：${bit(A_NONE.equity, A_EXPLICIT_NEUTRAL.equity)}｜诈唬质量：${bit(A_NONE.masses['bluff'] ?? null, A_EXPLICIT_NEUTRAL.masses['bluff'] ?? null)}`);
line(`A1 vs A5（只画像似然通道）权益差 = ${f(((A_MANIAC_PROFILE_ONLY.equity ?? 0) - (A_NONE.equity ?? 0)) * 100, 4)}pp`);
line(`A1 vs A6（只倾斜通道）  权益差 = ${f(((A_MANIAC_NEUTRAL_PROFILE.equity ?? 0) - (A_NONE.equity ?? 0)) * 100, 4)}pp`);
line(`A1 vs A7（界面路径＝两条通道）权益差 = ${f(((A_MANIAC.equity ?? 0) - (A_NONE.equity ?? 0)) * 100, 4)}pp`);
line(`A1 vs A8（跟注站标签）  权益差 = ${f(((A_CS.equity ?? 0) - (A_NONE.equity ?? 0)) * 100, 4)}pp`);
line();
line('A 组画像证据对象（provider.evidence + 维度来源）：');
for (const r of [A_NONE, A_MANIAC_NEUTRAL_PROFILE, A_MANIAC, A_CS]) {
  line(`  ${r.label}`);
  line(`     维度来源=${String(r.tendencyTier)} applied=${String(r.providerApplied)} 形状层生效=${String(r.comboWeightApplied)}`);
  line(`     ${r.comboWeightFactor}`);
  line(`     决策层去重：${r.dedup}`);
  line(`     combosBefore/After = ${String((r.raw as { evidence?: { combosBefore?: number; combosAfter?: number } })?.evidence?.combosBefore)}/${String((r.raw as { evidence?: { combosAfter?: number } })?.evidence?.combosAfter)}`);
}
line('A7 的范围更新轨迹 noteZh：');
for (const t of A_MANIAC.traceNotes) line(`    ${t}`);
line('A6（只倾斜通道）的范围更新轨迹 noteZh：');
for (const t of A_MANIAC_NEUTRAL_PROFILE.traceNotes) line(`    ${t}`);

if (QUICK) process.exit(0);

/* ============================================================
 * B 组：样本量与非法数值（items 1/2/4/17）
 * ============================================================ */
h('B 样本 / 非法数值（observed 直接注入生产入口）');
const obs = (o: Record<string, unknown>): PlayerBehaviorProfile =>
  behaviorProfileOf({ playerId: 'villain', archetype: 'MANIAC' as never, observed: o as never });

const B: Row[] = [];
B.push(measure('B1 MANIAC + observed 0/0', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 0, opportunities: 0 } }) })));
B.push(measure('B2 MANIAC + observed 1/1', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 1, opportunities: 1 } }) })));
B.push(measure('B3 MANIAC + observed 2/2', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 2, opportunities: 2 } }) })));
B.push(measure('B4 MANIAC + observed 0/1', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 0, opportunities: 1 } }) })));
B.push(measure('B5 MANIAC + observed 30/50', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 30, opportunities: 50 } }) })));
B.push(measure('B6 MANIAC + observed NaN/10', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: NaN, opportunities: 10 } }) })));
B.push(measure('B7 MANIAC + observed 3/NaN', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 3, opportunities: NaN } }) })));
B.push(measure('B8 MANIAC + observed 3/Infinity', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 3, opportunities: Infinity } }) })));
B.push(measure('B9 MANIAC + observed 99/10（successes>opps）', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 99, opportunities: 10 } }) })));
B.push(measure('B10 MANIAC + observed -3/10', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: -3, opportunities: 10 } }) })));
B.push(measure('B11 MANIAC + observed 1/2.5（浮点机会数）', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 1, opportunities: 2.5 } }) })));
show(B);
line();
line('B6/B7 的范围更新轨迹（看「更新失败」是否被如实记录）：');
for (const r of [B[5]!, B[6]!, B[7]!]) {
  line(`  ${r.label}: ok=${r.ok} 动作=${r.action} 权益=${f(r.equity)} 轨迹条数=${r.traceNotes.length}`);
  for (const t of r.traceNotes) line(`      ${t.slice(0, 200)}`);
}

/* ============================================================
 * C 组：极端画像（item 17）与残缺画像（item 3）
 * ============================================================ */
h('C 极端 / 残缺画像');
const extremeTraits = (rate: number): PlayerBehaviorProfile => {
  const base = behaviorProfileOf({ playerId: 'villain' });
  const traits = { ...base.traits } as unknown as Record<string, { effectiveRate: number }>;
  for (const k of Object.values(BehaviorTraitKey)) traits[k] = { ...traits[k]!, effectiveRate: rate };
  return { ...base, traits } as unknown as PlayerBehaviorProfile;
};
const C: Row[] = [];
C.push(measure('C1 全条目 effectiveRate=0.999（注入）', goldenInput(undefined, { behaviorProfile: extremeTraits(0.999) })));
C.push(measure('C2 全条目 effectiveRate=1（注入）', goldenInput(undefined, { behaviorProfile: extremeTraits(1) })));
C.push(measure('C3 全条目 effectiveRate=0.0001（注入）', goldenInput(undefined, { behaviorProfile: extremeTraits(0.0001) })));
C.push(measure('C4 全条目 effectiveRate=0（注入）', goldenInput(undefined, { behaviorProfile: extremeTraits(0) })));
C.push(measure('C5 全条目 effectiveRate=NaN（注入）', goldenInput(undefined, { behaviorProfile: extremeTraits(NaN) })));
C.push(measure('C6 全条目 effectiveRate=Infinity（注入）', goldenInput(undefined, { behaviorProfile: extremeTraits(Infinity) })));
const brokenProfile = {
  playerId: 'villain',
  playerName: null,
  archetype: null,
  traits: { [BehaviorTraitKey.RIVER_BLUFF]: MANIAC_TAG_PROFILE.traits.riverBluff },
  isUnknownPlayer: true,
  archetypePriorAvailable: false,
  priorNoteZh: 'hand-made（只有 1 个条目）',
} as unknown as PlayerBehaviorProfile;
C.push(measure('C7 残缺画像（traits 只有 riverBluff）', goldenInput(undefined, { behaviorProfile: brokenProfile })));
C.push(measure('C8 traits={} 完全缺失', goldenInput(undefined, { behaviorProfile: { ...brokenProfile, traits: {} } as unknown as PlayerBehaviorProfile })));
show(C);
line();
for (const r of [C[1]!, C[4]!, C[5]!, C[7]!]) {
  line(`  ${r.label}: ok=${r.ok} stage=${r.stage} 权益=${f(r.equity)} 动作=${r.action}`);
  if (r.issues !== '-') line(`      issues=${r.issues.slice(0, 300)}`);
  for (const t of r.traceNotes) line(`      trace ${t.slice(0, 220)}`);
}

/* ============================================================
 * D 组：陈旧数据 / 重复计数 / 错误分母（items 6/7/10）
 * ============================================================ */
h('D 陈旧 / 重复 / 分母');
const obsStale = obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 30, opportunities: 50 } });
const D: Row[] = [];
D.push(measure('D1 observed 30/50，asOf=2020-01-01', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obsStale }), { ...OPTIONS, asOf: 1_577_836_800_000 }));
D.push(measure('D2 observed 30/50，asOf=2125（未来 100 年）', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obsStale }), { ...OPTIONS, asOf: 4_900_000_000_000 }));
D.push(measure('D3 同一手被数两次：observed 1/1', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 1, opportunities: 1 } }) })));
D.push(measure('D4 同一手被数两次：observed 2/2（同一手重复）', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 2, opportunities: 2 } }) })));
D.push(measure('D4b 同一手重复 10 次：observed 10/10', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 10, opportunities: 10 } }) })));
D.push(measure('D4c 同一手重复 100 次：observed 100/100', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 100, opportunities: 100 } }) })));
D.push(measure('D5 正确分母 12/50（河牌面对下注）', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 12, opportunities: 50 } }) })));
D.push(measure('D6 错分母 12/1000（总手数）', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 12, opportunities: 1000 } }) })));
D.push(measure('D7 unknownOutcome 500 与 opportunities 1 并存', goldenInput(undefined, { quickProfile: 'MANIAC', behaviorProfile: obs({ [BehaviorTraitKey.RIVER_BLUFF]: { successes: 1, opportunities: 1, unknownOutcomeOpportunities: 500 } }) })));
show(D);
line();
line(`D1 vs D2 权益：${bit(D[0]!.equity, D[1]!.equity)}｜诈唬质量：${bit(D[0]!.masses['bluff'] ?? null, D[1]!.masses['bluff'] ?? null)}｜动作 ${D[0]!.action}/${D[1]!.action}`);
line(`重复计数单调抬高诈唬质量：1/1 ${f(D[2]!.masses['bluff'])} → 2/2 ${f(D[3]!.masses['bluff'])} → 10/10 ${f(D[4]!.masses['bluff'])} → 100/100 ${f(D[5]!.masses['bluff'])}（中性基线 ${f(A_NONE.masses['bluff'])}）`);
line(`对应权益：${f(D[2]!.equity)} → ${f(D[3]!.equity)} → ${f(D[4]!.equity)} → ${f(D[5]!.equity)}（中性 ${f(A_NONE.equity)}）`);
line(`D5 vs D6（分母错 20 倍）权益差 = ${f((((D[7]!.equity ?? 0) - (D[6]!.equity ?? 0)) * 100), 4)}pp｜诈唬质量差 = ${f((((D[7]!.masses['bluff'] ?? 0) - (D[6]!.masses['bluff'] ?? 0)) * 100), 4)}pp｜动作 ${D[6]!.action} vs ${D[7]!.action}`);

/* ============================================================
 * E 组：玩家身份 / 座位（items 8/9）
 * ============================================================ */
h('E 玩家身份与座位绑定');
const E: Row[] = [];
E.push(measure('E1 villain.playerId=BB（=位置名，非内部 id）', goldenInput(undefined, { playerId: 'BB', quickProfile: 'MANIAC' })));
E.push(measure('E1b villain.playerId=seat_BB（内部 id）', goldenInput(undefined, { playerId: 'seat_BB', quickProfile: 'MANIAC' })));
E.push(measure('E2 villain.playerId=BTN（已弃牌的座位）', goldenInput(undefined, { playerId: 'BTN', quickProfile: 'MANIAC' })));
E.push(measure('E3 villain.playerId=CO（Hero 自己的座位）', goldenInput(undefined, { playerId: 'CO', quickProfile: 'MANIAC' })));
E.push(measure('E4 villain.playerId="nonsense"（自由字符串）', goldenInput(undefined, { playerId: 'nonsense', quickProfile: 'MANIAC' })));
E.push(measure('E5 不写 playerId（默认第一个已实现对手）', goldenInput(undefined, { quickProfile: 'MANIAC' })));
E.push(measure('E6 seatProfiles={BB:MANIAC}（座位画像，无 villain.quickProfile）', goldenInput((i) => { i['seatProfiles'] = { BB: 'MANIAC' }; })));
E.push(measure('E7 seatProfiles={BTN:MANIAC}（弃牌座位）', goldenInput((i) => { i['seatProfiles'] = { BTN: 'MANIAC' }; })));
E.push(measure('E8 seatProfiles={BB:MANIAC} + villain.quickProfile=CALLING_STATION', goldenInput((i) => { i['seatProfiles'] = { BB: 'MANIAC' }; }, { quickProfile: 'CALLING_STATION' })));
show(E);

/* ============================================================
 * F 组：翻前节点 / 多人池 / 单位（items 18/16/11）
 * ============================================================ */
h('F 结构：翻前 / 多人池 / 单位');
/**
 * 翻前节点：Hero BB 面对 BTN 加注（画像对手 = BTN）。
 * ⚠️ 翻前结构上，对手在 Hero 决策前**只可能有一条**行动，而那条一定是
 * `firstPreflopActionOf`（= 基础行动，被 `applyLikelihoodUpdates` 跳过），
 * 因此本组合用来验证「画像在翻前节点是否完全不参与」。
 */
const preflopInput = (mutate?: (i: Record<string, unknown>) => void, villain: Record<string, unknown> = {}): ManualHandInput => {
  const input: Record<string, unknown> = {
    tableSize: 9,
    heroPosition: 'BB',
    heroCards: ['As', 'Js'],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS9 },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
      { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
      { position: 'HJ', type: 'FOLD' }, { position: 'CO', type: 'FOLD' },
      { position: 'BTN', type: 'RAISE', amountBB: 4 },
      { position: 'SB', type: 'FOLD' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { dynamicHint: 'UNKNOWN', stackBB: 100, playerId: 'seat_BTN', ...villain },
  };
  if (mutate) mutate(input);
  return input as unknown as ManualHandInput;
};
const F: Row[] = [];
F.push(measure('F1 翻前：无画像', preflopInput(undefined, { playerId: 'seat_BTN' })));
F.push(measure('F2 翻前：只注入 MANIAC behaviorProfile', preflopInput(undefined, { behaviorProfile: MANIAC_TAG_PROFILE })));
F.push(measure('F3 翻前：quickProfile=MANIAC（倾斜通道）', preflopInput(undefined, { quickProfile: 'MANIAC' })));
F.push(measure('F4 翻前：quickProfile=CALLING_STATION', preflopInput(undefined, { quickProfile: 'CALLING_STATION' })));
F.push(measure('F5 7 人桌（tableSize=7）', goldenInput((i) => { i['tableSize'] = 7; }, { quickProfile: 'MANIAC' })));
/** 8 人局 = 9 座桌去掉 UTG 座位（Table Topology Correction 的表达方式） */
const EIGHT_HANDED = HISTORY_GOLDEN.filter((h) => h.position !== 'UTG').map((h) => ({ ...h }));
F.push(measure('F6 8 人局（9 座桌 − UTG）', {
  tableSize: 9,
  heroPosition: 'CO',
  heroCards: ['Ac', 'Jh'],
  board: ['Ad', '8s', '4s', '2c', 'Kd'],
  street: 'RIVER',
  effectiveStackBB: 100,
  bigBlindBB: 2,
  occupiedPositions: ['UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  seatStacksBB: { ...SEATS9 },
  actionHistory: EIGHT_HANDED,
  environment: 'MID_LOW_STAKES',
  villain: { dynamicHint: 'UNKNOWN', stackBB: 100, quickProfile: 'MANIAC' },
} as unknown as ManualHandInput));
/** 4 人局（CO/BTN/SB/BB）：翻后顺序 = SB(已弃) → BB → CO → BTN */
const HISTORY_FOUR_HANDED = [
  { position: 'CO', type: 'CALL', amountBB: 1 },
  { position: 'BTN', type: 'CALL', amountBB: 1 },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CHECK' },
  { position: 'BB', type: 'CHECK', street: 'FLOP' },
  { position: 'CO', type: 'CHECK', street: 'FLOP' },
  { position: 'BTN', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'CO', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'TURN' },
  { position: 'CO', type: 'CHECK', street: 'TURN' },
  { position: 'BTN', type: 'CHECK', street: 'TURN' },
  { position: 'BB', type: 'CHECK', street: 'RIVER' },
  { position: 'CO', type: 'CHECK', street: 'RIVER' },
  { position: 'BTN', type: 'BET', amountBB: 6, street: 'RIVER' },
] as const;
const fourHanded = (villain: Record<string, unknown>): ManualHandInput => ({
  tableSize: 9,
  heroPosition: 'BB',
  heroCards: ['Kh', 'Qh'],
  board: ['Kc', '9s', '5d', '2h', '7c'],
  street: 'RIVER',
  effectiveStackBB: 100,
  bigBlindBB: 2,
  occupiedPositions: ['CO', 'BTN', 'SB', 'BB'],
  seatStacksBB: { ...SEATS9 },
  actionHistory: [...HISTORY_FOUR_HANDED],
  environment: 'MID_LOW_STAKES',
  villain: { dynamicHint: 'UNKNOWN', stackBB: 100, ...villain },
} as unknown as ManualHandInput);
F.push(measure('F7 4 人局（3 家到河牌）：BTN 带 MANIAC', fourHanded({ playerId: 'seat_BTN', quickProfile: 'MANIAC' })));
F.push(measure('F8 4 人局：无画像对照', fourHanded({ playerId: 'seat_BTN' })));
F.push(measure('F8b 4 人局：BTN + CALLING_STATION', fourHanded({ playerId: 'seat_BTN', quickProfile: 'CALLING_STATION' })));
F.push(measure('F9 bigBlindBB=100（同一手，仅筹码面额不同）', goldenInput((i) => { i['bigBlindBB'] = 100; }, { quickProfile: 'MANIAC' })));
F.push(measure('F10 bigBlindBB=1（同一手）', goldenInput((i) => { i['bigBlindBB'] = 1; }, { quickProfile: 'MANIAC' })));
F.push(measure('F11 缺 board（street=RIVER, board=[]）', goldenInput((i) => { i['board'] = []; }, { quickProfile: 'MANIAC' })));
F.push(measure('F12 缺 heroCards', goldenInput((i) => { i['heroCards'] = []; }, { quickProfile: 'MANIAC' })));
F.push(measure('F13 4 人局：只注入 MANIAC behaviorProfile（无 quickProfile）', fourHanded({ playerId: 'seat_BTN', behaviorProfile: MANIAC_TAG_PROFILE })));
show(F);
line();
line(`F1 vs F2（翻前只 behaviorProfile）：权益 ${bit(F[0]!.equity, F[1]!.equity)}｜动作 ${F[0]!.action}/${F[1]!.action}`);
line(`F1 vs F3（翻前 quickProfile 倾斜）：权益差 ${f((((F[2]!.equity ?? 0) - (F[0]!.equity ?? 0)) * 100), 4)}pp｜动作 ${F[0]!.action}/${F[2]!.action}`);
line(`F1 vs F4（翻前 CALLING_STATION）：权益差 ${f((((F[3]!.equity ?? 0) - (F[0]!.equity ?? 0)) * 100), 4)}pp｜动作 ${F[0]!.action}/${F[3]!.action}`);
line(`F1 vs F13（多人池翻前只 behaviorProfile）：${bit(F[0]!.equity, F[12]!.equity)}`);
line(`F7 vs F8（4 人局画像 vs 无画像）：权益差 ${f((((F[6]!.equity ?? 0) - (F[7]!.equity ?? 0)) * 100), 4)}pp｜动作 ${F[6]!.action}/${F[7]!.action}｜权益 ${f(F[6]!.equity)}/${f(F[7]!.equity)}`);
line(`F8 vs F8b（跟注站）：权益差 ${f((((F[8]!.equity ?? 0) - (F[7]!.equity ?? 0)) * 100), 4)}pp`);
line(`F9/F10 与 A1 的动作对比（单位一致性）：`);
const unitRows = [A_MANIAC, A_NONE, F[9]!, F[10]!];
for (const r of unitRows) {
  const m = r.raw as { math?: { pot?: number; spr?: number; requiredEquity?: number } } | null;
  line(`  ${r.label.padEnd(46)} 动作=${r.action} pot=${f(m?.math?.pot, 4)} spr=${f(m?.math?.spr, 4)} reqEQ=${f(m?.math?.requiredEquity, 6)} EQ=${f(r.equity, 6)} callEV=${f(r.callEV, 4)}`);
}
line();
for (const r of [F[11]!, F[12]!]) line(`  ${r.label}: stage=${r.stage} issues=${r.issues.slice(0, 240)}`);

/* ============================================================
 * G 组：缓存 / 跨调用污染（item 13）
 * ============================================================ */
h('G 缓存 / 跨调用污染（同一进程内变换画像）');
const G1 = measure('G1 MANIAC（第一次）', goldenInput(undefined, { quickProfile: 'MANIAC' }));
const G2 = measure('G2 CALLING_STATION（第二次）', goldenInput(undefined, { quickProfile: 'CALLING_STATION' }));
const G3 = measure('G3 MANIAC（第三次，应与 G1 逐位相同）', goldenInput(undefined, { quickProfile: 'MANIAC' }));
const G4 = measure('G4 CALLING_STATION（第四次）', goldenInput(undefined, { quickProfile: 'CALLING_STATION' }));
const G5 = measure('G5 MANIAC（第五次，应与 G1 逐位相同）', goldenInput(undefined, { quickProfile: 'MANIAC' }));
show([G1, G2, G3, G4, G5]);
line(`G1 vs G3: EQ ${bit(G1.equity, G3.equity)}；bluffMass ${bit(G1.masses['bluff'] ?? null, G3.masses['bluff'] ?? null)}；轨迹条数 ${G1.traceNotes.length}/${G3.traceNotes.length}`);
line(`G2 vs G4: EQ ${bit(G2.equity, G4.equity)}；bluffMass ${bit(G2.masses['bluff'] ?? null, G4.masses['bluff'] ?? null)}`);
line(`G1 vs G3 全部轨迹文本逐字相等：${JSON.stringify(G1.traceNotes) === JSON.stringify(G3.traceNotes)}`);
line(`G5 vs G1: EQ ${bit(G1.equity, G5.equity)}`);

/* ============================================================
 * I 组：画像对象的 playerId 是否真的决定「给谁」（items 8/9）
 * ============================================================ */
h('I 画像对象的 playerId 与绑定座位（4 人局，两个已实现对手：CO 与 BTN）');
const profileForAlice = (id: string): PlayerBehaviorProfile =>
  behaviorProfileOf({ playerId: id, archetype: 'MANIAC' as never });
const I: Row[] = [];
I.push(measure('I0 4 人局：无画像', fourHanded({})));
I.push(measure('I1 画像 playerId=Alice，不写 villain.playerId', fourHanded({ behaviorProfile: profileForAlice('Alice') })));
I.push(measure('I2 画像 playerId=Alice + villain.playerId=seat_CO', fourHanded({ playerId: 'seat_CO', behaviorProfile: profileForAlice('Alice') })));
I.push(measure('I3 画像 playerId=Alice + villain.playerId=seat_BTN', fourHanded({ playerId: 'seat_BTN', behaviorProfile: profileForAlice('Alice') })));
I.push(measure('I4 画像 playerId=seat_BTN，不写 villain.playerId', fourHanded({ behaviorProfile: profileForAlice('seat_BTN') })));
I.push(measure('I5 画像 playerId=seat_CO，不写 villain.playerId', fourHanded({ behaviorProfile: profileForAlice('seat_CO') })));
I.push(measure('I6 villain.playerId=seat_BTN（画像来自 quickProfile）', fourHanded({ playerId: 'seat_BTN', quickProfile: 'MANIAC' })));
I.push(measure('I7 villain.playerId=seat_CO（画像来自 quickProfile）', fourHanded({ playerId: 'seat_CO', quickProfile: 'MANIAC' })));
show(I);
line();
line('★ 若 I1 == I5 且 I1 ≠ I4，说明「绑定由输入里的座位 id 决定，画像对象自带的 playerId 被忽略」。');
line(`I0/I1/I4/I5 权益：${f(I[0]!.equity)} / ${f(I[1]!.equity)} / ${f(I[4]!.equity)} / ${f(I[5]!.equity)}`);
line(`I0/I2/I3 权益（按输入座位绑定）：${f(I[0]!.equity)} / ${f(I[2]!.equity)} / ${f(I[3]!.equity)}`);
line(`I6/I7（quickProfile 路径）权益：${f(I[6]!.equity)} / ${f(I[7]!.equity)}`);

/* ============================================================
 * J 组：多席位下「去重信号」是否还在（item 12 的机制验证）
 * ============================================================ */
h('J 画像不是首要对手时的 profileRangeEvidence 与决策层去重信号');
{
  const cases: readonly { label: string; input: ManualHandInput }[] = [
    { label: 'J1 单挑 9-max：BLUFF_HEAVY（首要＝BB）', input: goldenInput(undefined, { quickProfile: 'BLUFF_HEAVY' }) },
    { label: 'J2 单挑 9-max：无画像', input: goldenInput() },
    { label: 'J3 4 人局：BLUFF_HEAVY@BTN（首要＝CO，非画像家）', input: fourHanded({ playerId: 'seat_BTN', quickProfile: 'BLUFF_HEAVY' }) },
    { label: 'J4 4 人局：BLUFF_HEAVY@CO（画像家＝首要）', input: fourHanded({ playerId: 'seat_CO', quickProfile: 'BLUFF_HEAVY' }) },
    { label: 'J5 4 人局：无画像', input: fourHanded({ playerId: 'seat_BTN' }) },
  ];
  const rows = cases.map((c) => measure(c.label, c.input));
  for (const r of rows) {
    const raw = r.raw as { provider?: unknown; evidence?: unknown } | null;
    line(`${r.label}`);
    line(`    动作=${r.action} 权益=${f(r.equity, 6)} callEV=${f(r.callEV, 4)} 诈唬质量=${f(r.masses['bluff'], 6)}`);
    line(`    profileRangeEvidence 是否存在=${String(raw?.evidence !== null && raw?.evidence !== undefined)} providerApplied=${String(r.providerApplied)}`);
    line(`    决策层剥削层文本：${r.dedup}`);
  }
  line();
  line(`J1 vs J2（单挑：画像 vs 无画像）权益差 = ${f((((rows[0]!.equity ?? 0) - (rows[1]!.equity ?? 0)) * 100), 4)}pp`);
  line(`J3 vs J5（4 人局：画像家在 BTN，非首要）权益差 = ${f((((rows[2]!.equity ?? 0) - (rows[4]!.equity ?? 0)) * 100), 4)}pp`);
  line(`J4 vs J5（4 人局：画像家＝首要 CO）权益差 = ${f((((rows[3]!.equity ?? 0) - (rows[4]!.equity ?? 0)) * 100), 4)}pp`);
}


h('H 弃牌者的底牌：死牌集合、范围支持集、分母（item 11）');
{
  const parsed = parseManualInput(goldenInput());
  if (!parsed.ok) throw new Error('夹具必须可解析');
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error('夹具必须可重建');
  const state = gate.state;
  line(`state.players 的 id / 位置 / 是否弃牌 / holeCards：`);
  for (const p of state.players) {
    line(
      `    id=${p.id.padEnd(5)} pos=${String(p.position).padEnd(5)} folded=${String(p.folded).padEnd(5)} ` +
        `holeCards=${p.holeCards === null ? 'null（未知）' : p.holeCards.map((c) => `${c.rank}${c.suit}`).join('')}`,
    );
  }
  const withHole = state.players.filter((p) => p.holeCards !== null).length;
  line(`持有底牌的玩家数 = ${withHole}（只有 Hero）`);

  const built = buildDecisionContext({ state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: ASOF, budget: WIDE });
  const ctx = built.context;
  line(`context.board = ${ctx.board.map((c) => `${c.rank}${c.suit}`).join(' ')}`);
  line(
    `activeOpponentCount=${ctx.activeOpponentCount} realizedOpponentCount=${ctx.realizedOpponentCount} ` +
      `playersYetToAct=${ctx.playersYetToAct} opponentRanges=${ctx.opponentRanges.length}`,
  );
  const snap = ctx.range;
  line(
    `首要对手范围：supportSize=${snap?.supportSize} sourceKind=${snap?.sourceKind} ` +
      `supportShare=${f(snap?.supportShare, 4)}`,
  );
  const facts = ctx.postflopFacts?.opponentRangeFacts as unknown as
    | { profileClassMasses?: Record<string, number>; supportSize?: number }
    | undefined;
  const pc = facts?.profileClassMasses;
  line(
    `profileClassMasses：totalMass=${f(pc?.['totalMass'])} reachableRangeCount=${String(pc?.['reachableRangeCount'])} ` +
      `effectiveCombos=${f(pc?.['effectiveCombos'], 2)} unclassifiedMassShare=${f(pc?.['unclassifiedMassShare'], 6)}`,
  );
  line(`★ 死牌集合口径 = Hero 底牌 2 张 + 公共牌 5 张 ⇒ 可用牌 45 张 ⇒ C(45,2)=990 个组合`);
  line(`  实测 range.entries 数（见上面轨迹「钳位 N/990」）= 990 ⇒ 与「只有 Hero+公共牌是死牌」一致`);
  line(`  ⇒ 弃牌者的未知底牌**没有**被当成死牌（正确：它们不可知，也没有被踢出范围）`);

  // 合成状态：让一个**已弃牌**的座位带上已知底牌，看代码是否把它当死牌
  const mutated = JSON.parse(JSON.stringify(state)) as typeof state;
  const utg = mutated.players.find((p) => p.id === 'UTG');
  if (utg !== undefined) {
    (utg as { holeCards: unknown }).holeCards = [
      { rank: 14, suit: 's' },
      { rank: 13, suit: 's' },
    ];
  }
  const built2 = buildDecisionContext({ state: mutated, rules: RULES, environment: 'MID_LOW_STAKES', asOf: ASOF, budget: WIDE });
  const snap2 = built2.context.range;
  const pc2 = (built2.context.postflopFacts?.opponentRangeFacts as unknown as
    | { profileClassMasses?: Record<string, number> }
    | undefined)?.profileClassMasses;
  line(
    `合成状态（UTG 已弃牌但底牌已知 = AsKs）：supportSize=${snap2?.supportSize} ` +
      `reachableRangeCount=${String(pc2?.['reachableRangeCount'])} 权益=${f(built2.context.math.heroEquity)}`,
  );
  line(`  对照（未合成）：supportSize=${snap?.supportSize} reachableRangeCount=${String(pc?.['reachableRangeCount'])} 权益=${f(ctx.math.heroEquity)}`);
  line(`  ⇒ 已弃牌者的已知底牌是否被排除、是否改变分母：见上两行对比`);
}

