/**
 * V2.1 决策影响指标（6–12 项）· 画像支配（Profile Dominance）· 输入微扰稳定性
 *
 * 用法：
 * ```text
 * node --experimental-strip-types scripts/v21-decision-impact.ts
 * ```
 *
 * 产物：`reports/evidence/v21-decision-impact.json`
 *
 * ## 指标口径（**分母/单位/噪声处理必须与数字一起读**）
 *
 * | 指标 | 单位 | 分母 |
 * |---|---|---|
 * | `equityDelta` | 比例（报告 ×100 = pp） | 无（差值） |
 * | `bluffMassDelta` | 概率质量占比 | 该对手**可达组合的后验质量之和**（不含与 Hero/公共牌重叠者） |
 * | 类别级 `rangeDistance` | TV ∈ [0,1] / JS ∈ [0,1] | 5 个互不重叠类别分量（**CATEGORY_LEVEL**，非 1326 组合级） |
 * | 对手弃牌/跟注/加注概率 | 概率 | 响应模型：对该尺寸分类的可达组合**质量** |
 * | `EqVsCall` 变化 | 比例 | 同上（权益）；`requiredEquity` 只由价格决定、**不随画像变** |
 * | 候选动作 EV | 筹码（本项目 1BB = 2 筹码） | 各动作自己的模型 |
 * | `sizingChange` | BB 与 % 底池 | 下注前底池 |
 * | 决策稳定性 | 翻转率 / 最大位移 | 微扰集合 |
 *
 * ## 噪声处理
 *
 * 所有调用固定 `equitySeed = 20260913` 与宽裕预算（`equityPolicy` 不因负载换型）。
 * 同一输入的重复调用在 §"确定性自检" 里验证逐位相等；不相等则该行数据作废。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import {
  behaviorProfileOf, BehaviorTraitKey, type PlayerBehaviorProfile,
} from '../src/domain/player/behaviorProfile.ts';
import { profileRangeDistance } from '../src/domain/player/profileRangeMetrics.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const ASOF = 1_757_000_000_000;
const SEED = 20260913;
const OPTIONS = {
  rules: RULES, asOf: ASOF, writeLog: false,
  budget: { softMs: 120_000, hardMs: 240_000 }, equitySeed: SEED,
} as const;

const SEATS9 = {
  UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
  CO: 100, BTN: 100, SB: 100, BB: 100,
} as const;

/* ============================================================
 * 场景
 * ============================================================ */

const S1_HISTORY = [
  { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
  { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 },
  { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 1.5 },
  { position: 'BB', type: 'CHECK', street: 'FLOP' },
  { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'TURN' },
  { position: 'CO', type: 'CHECK', street: 'TURN' },
  { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
] as const;

function s1Input(riverBetBB = 7): ManualHandInput {
  const history = S1_HISTORY.map((h) =>
    h.street === 'RIVER' ? { ...h, amountBB: riverBetBB } : { ...h },
  );
  return {
    tableSize: 9, heroPosition: 'CO', heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS9 },
    actionHistory: history, environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

/* ============================================================
 * 测量：一次调用给出全部指标
 * ============================================================ */

/** 把画像注入输入的**唯一**位置（`analyzeManualHand` 与 `buildDecisionContext` 同源） */
function withProfile(input: ManualHandInput, profile: PlayerBehaviorProfile | undefined): ManualHandInput {
  if (profile === undefined) return input;
  return {
    ...input,
    villain: { ...(input.villain ?? {}), behaviorProfile: profile },
  } as unknown as ManualHandInput;
}

type Snapshot = {
  ok: boolean;
  action: string | null;
  sizingBB: number | null;
  sizingPotRatio: number | null;
  heroEquity: number | null;
  requiredEquity: number | null;
  callEV: number | null;
  foldEV: number | null;
  bluffMass: number | null;
  missedDrawMass: number | null;
  valueMass: number | null;
  classVector: number[] | null;
  rawSupportCombos: number | null;
  effectiveCombos: number | null;
  combosBefore: number | null;
  combosAfter: number | null;
  foldLikelihood: number | null;
  callLikelihood: number | null;
  raiseLikelihood: number | null;
  sizeTable: { label: string; amountBB: number; ratio: number; fold: number; call: number; raise: number; ev: number | null }[];
  bestSize: string | null;
  checkEV: number | null;
  candidateEVs: Record<string, number | null>;
  evGapBestSecond: number | null;
  confidence: string | null;
  clampedCount: number | null;
  clampedTotal: number | null;
  clampedUniverse: number | null;
  clampCheckAvailable: boolean;
  unifiedLikelihoodEngaged: boolean;
  traitCountRange: [number, number] | null;
  equitySource: string | null;
};

function snapshot(rawInput: ManualHandInput, profile: PlayerBehaviorProfile | undefined): Snapshot {
  const empty: Snapshot = {
    ok: false, action: null, sizingBB: null, sizingPotRatio: null,
    heroEquity: null, requiredEquity: null, callEV: null, foldEV: null,
    bluffMass: null, missedDrawMass: null, valueMass: null, classVector: null,
    rawSupportCombos: null, effectiveCombos: null, combosBefore: null, combosAfter: null,
    foldLikelihood: null, callLikelihood: null, raiseLikelihood: null,
    sizeTable: [], bestSize: null, checkEV: null, candidateEVs: {},
    evGapBestSecond: null, confidence: null, clampedCount: null,
    clampedTotal: null, clampedUniverse: null, clampCheckAvailable: false,
    unifiedLikelihoodEngaged: false,
    traitCountRange: null, equitySource: null,
  };

  /*
   * 🔴 **必须把画像注入被分析的那份输入**，不能只注入 `buildDecisionContext`。
   *
   * 本脚本第一版只把画像传给了 `buildDecisionContext`，而 `analyzeManualHand`
   * 收到的仍是只有 `quickProfile` 的输入 —— 于是**所有画像的权益完全相同**
   * （实测 11/11 行 equity=56.259%、callEV=12.442），而 `bluffMass` 却在变。
   * 那是典型的「静默无效测量」：数字看起来正常，其实测的是同一个局面。
   * 现在两处**同源**注入（`withProfile`），并且下面有断言把这种退化钉死。
   */
  const input = withProfile(rawInput, profile);

  const r = analyzeManualHand(input, OPTIONS);
  if (!r.ok) return empty;
  const m = r.decision.diagnostics.math;

  const out: Snapshot = {
    ...empty,
    ok: true,
    action: String(r.decision.action),
    heroEquity: m.heroEquity,
    requiredEquity: m.requiredEquity,
    callEV: m.callEV,
    equitySource: (m as unknown as { equitySource?: { method?: string } }).equitySource?.method ?? null,
  };

  const sizing = r.decision.sizing as unknown as Record<string, unknown> | null | undefined;
  if (sizing !== null && sizing !== undefined) {
    out.sizingBB = typeof sizing['amount'] === 'number' ? sizing['amount'] as number
      : typeof sizing['amountBB'] === 'number' ? sizing['amountBB'] as number : null;
    out.sizingPotRatio = typeof sizing['potRatio'] === 'number' ? sizing['potRatio'] as number : null;
  }

  const parsed = parseManualInput(input);
  if (!parsed.ok) return out;
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) return out;
  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
    asOf: ASOF, budget: { softMs: 120_000, hardMs: 240_000 }, equitySeed: SEED,
    /*
     * ⚠️ `quickProfile === 'UNKNOWN'` 时**不传** —— 与生产路径一致
     *（`contextBuilder` 对 `UNKNOWN` 刻意不派生画像：替陌生人套原型＝编造数据）。
     */
    ...(input.villain.quickProfile === undefined || input.villain.quickProfile === 'UNKNOWN'
      ? {}
      : { quickProfile: input.villain.quickProfile as never }),
    ...(profile === undefined ? {} : { behaviorProfile: profile }),
  });
  const facts = built.context.postflopFacts?.opponentRangeFacts as unknown as
    | {
        profileClassMasses?: {
          bluffMass: number; missedDrawMass: number; valueMass: number; thinValueMass: number;
          showdownMass: number; pureAirMass: number; nutValueMass: number; strongValueMass: number;
          rawSupportCombos: number; effectiveCombos: number | null;
        };
      }
    | undefined;
  const pc = facts?.profileClassMasses ?? null;
  if (pc !== null) {
    out.bluffMass = pc.bluffMass;
    out.missedDrawMass = pc.missedDrawMass;
    out.valueMass = pc.valueMass;
    out.rawSupportCombos = pc.rawSupportCombos;
    out.effectiveCombos = pc.effectiveCombos;
    out.classVector = [
      pc.nutValueMass + pc.strongValueMass, pc.thinValueMass, pc.showdownMass,
      pc.missedDrawMass, pc.pureAirMass,
    ];
  }
  const ev = built.context.profileRangeEvidence;
  if (ev !== undefined) { out.combosBefore = ev.combosBefore; out.combosAfter = ev.combosAfter; }

  const post = r.decision.diagnostics.postflop as unknown as
    | {
        confidence?: string;
        betDecision?: {
          bestSize?: string | null; checkEV?: number | null;
          sizes: readonly {
            labelZh: string; betAmount: number; ratioToPot: number;
            foldLikelihood: number; callLikelihood: number; raiseLikelihood: number;
            ev?: number | null;
          }[];
        } | null;
      }
    | undefined;
  out.confidence = post?.confidence ?? null;
  const bd = post?.betDecision ?? null;
  if (bd !== null && bd !== undefined) {
    out.bestSize = bd.bestSize ?? null;
    out.checkEV = bd.checkEV ?? null;
    out.sizeTable = bd.sizes.map((s) => ({
      label: s.labelZh, amountBB: s.betAmount, ratio: s.ratioToPot,
      fold: s.foldLikelihood, call: s.callLikelihood, raise: s.raiseLikelihood,
      ev: s.ev ?? null,
    }));
    const chosen = bd.sizes.find((s) => s.labelZh === bd.bestSize) ?? bd.sizes[0];
    if (chosen !== undefined) {
      out.foldLikelihood = chosen.foldLikelihood;
      out.callLikelihood = chosen.callLikelihood;
      out.raiseLikelihood = chosen.raiseLikelihood;
    }
    const evs: Record<string, number | null> = { CHECK: bd.checkEV ?? null };
    for (const s of bd.sizes) evs[`BET_${s.labelZh}`] = s.ev ?? null;
    out.candidateEVs = evs;
    /* 最优与次优的 EV 差距：只在两个候选都有可比 EV 时给 */
    const nums = Object.entries(evs).filter(([, v]) => v !== null) as [string, number][];
    nums.sort((a, b) => b[1] - a[1]);
    if (nums.length >= 2) out.evGapBestSecond = nums[0]![1] - nums[1]![1];
  }

  /*
   * 钳位可见性：从 `context.range.updateTrace` 里取（探针只读）。
   *
   * 🔴 **修复**（V2.1 数值审查 C1）：本脚本第一版读的是
   * `postflopFacts.opponentRangeFacts.updateTrace` —— **那个键不存在**
   * （trace 在 `context.range.updateTrace`，见 `decision.types.ts:553`）。
   * 于是 `clampedCount` 恒为 `null`，而 `null > 0` 恒为假 ⇒
   * 「似然钳位次数 = 0」这条检查**永远通过**，是一个 fail-open 的空检查。
   * 现在：读不到就标 `CLAMP_CHECK_UNAVAILABLE` 并**判违规**（fail-closed），
   * 绝不把「没查到」当成「没有」。
   */
  const trace = (built.context.range?.updateTrace ?? []) as readonly { noteZh?: string }[];
  const notes = trace.map((t) => t.noteZh ?? '').join('\n');
  const clampMatch = /钳位 (\d+)\/(\d+)/.exec(notes);
  const traitMatch = /条目数 (\d+)–(\d+)/.exec(notes);
  out.clampedTotal = clampMatch === null ? null : Number(clampMatch[1]);
  out.clampedUniverse = clampMatch === null ? null : Number(clampMatch[2]);
  out.clampCheckAvailable = clampMatch !== null;
  if (clampMatch !== null) out.clampedCount = Number(clampMatch[1]);
  if (traitMatch !== null) out.traitCountRange = [Number(traitMatch[1]), Number(traitMatch[2])];
  /* 未启用统一似然（无进攻动作 / 无画像）⇒ trace 里根本没有这一行：这是**合法的无钳位** */
  out.unifiedLikelihoodEngaged = notes.includes('统一动作似然 V2');

  return out;
}

/* ============================================================
 * §1 确定性自检（噪声处理的前提）
 * ============================================================ */

type Case = { id: string; archetype: string; profile: PlayerBehaviorProfile };

const CASES: readonly Case[] = [
  {
    id: 'REF_NEUTRAL_NORMAL', archetype: 'NORMAL',
    profile: behaviorProfileOf({ playerId: 'ref', archetype: 'NORMAL' as never }),
  },
  {
    id: 'NO_PROFILE_UNKNOWN', archetype: 'UNKNOWN',
    /*
     * ⚠️ **没有画像**必须用 `UNKNOWN`（不是 `NORMAL`）：
     * `contextBuilder` 对 `UNKNOWN` 刻意不派生画像；用 `NORMAL` 会派生一个
     * 「刻意中性」的画像 —— 两者在本路径上数值相同，但语义不同
     * （前者=「没有人告诉我」，后者=「我看了，他是常规玩家」）。
     */
    profile: undefined as unknown as PlayerBehaviorProfile,
  },
  {
    id: 'TAG_CALLING_STATION', archetype: 'CALLING_STATION',
    profile: behaviorProfileOf({ playerId: 'cs', archetype: 'CALLING_STATION' as never }),
  },
  {
    id: 'TAG_UNDERBLUFFER', archetype: 'UNDERBLUFFER',
    profile: behaviorProfileOf({ playerId: 'ub', archetype: 'UNDERBLUFFER' as never }),
  },
  {
    id: 'TAG_MANIAC', archetype: 'MANIAC',
    profile: behaviorProfileOf({ playerId: 'ma', archetype: 'MANIAC' as never }),
  },
  {
    id: 'OBS_MANIAC_50_45', archetype: 'MANIAC',
    profile: behaviorProfileOf({
      playerId: 'ma-obs', archetype: 'MANIAC' as never,
      observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 45, opportunities: 50 } } as never,
    }),
  },
  {
    id: 'OBS_STATION_50_5', archetype: 'CALLING_STATION',
    profile: behaviorProfileOf({
      playerId: 'cs-obs', archetype: 'CALLING_STATION' as never,
      observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 5, opportunities: 50 } } as never,
    }),
  },
  {
    id: 'OBS_ZERO_OPPORTUNITIES', archetype: 'MANIAC',
    profile: behaviorProfileOf({
      playerId: 'ma-zero', archetype: 'MANIAC' as never,
      observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 0, opportunities: 0 } } as never,
    }),
  },
  {
    id: 'TAG_THEN_HIGH_DEVIATION', archetype: 'VERY_TIGHT',
    profile: behaviorProfileOf({
      playerId: 'vt-dev', archetype: 'VERY_TIGHT' as never,
      manual: { [BehaviorTraitKey.RIVER_BLUFF]: 'VERY_HIGH' } as never,
    }),
  },
  {
    id: 'TAG_THEN_LOW_DEVIATION_AGGRESSIVE', archetype: 'MANIAC',
    profile: behaviorProfileOf({
      playerId: 'ma-dev', archetype: 'MANIAC' as never,
      manual: { [BehaviorTraitKey.RIVER_BLUFF]: 'VERY_LOW' } as never,
    }),
  },
  {
    id: 'EXTREME_ALL_VERY_HIGH', archetype: 'MANIAC',
    profile: behaviorProfileOf({
      playerId: 'ma-all', archetype: 'MANIAC' as never,
      manual: {
        [BehaviorTraitKey.RIVER_BLUFF]: 'VERY_HIGH',
        [BehaviorTraitKey.MISSED_DRAW_BLUFF]: 'VERY_HIGH',
        [BehaviorTraitKey.RIVER_LARGE_BET_BLUFF]: 'VERY_HIGH',
        [BehaviorTraitKey.PROBE_AFTER_TURN_CHECK_BACK]: 'VERY_HIGH',
        [BehaviorTraitKey.THIN_VALUE_BET]: 'VERY_HIGH',
      } as never,
    }),
  },
];

const report: Record<string, unknown> = {
  meta: {
    generatedAtUtc: new Date().toISOString(),
    nodeVersion: process.version,
    asOf: ASOF, equitySeed: SEED,
    scenario: {
      id: 'S1_RIVER_BLUFFCATCH_TURN_CHECKBACK',
      myPosition: 'CO', heroCards: 'Ac Jh', board: 'Ad 8s 4s 2c Kd',
      potBB: 19.5, effectiveStackBB: 100, structure: 'SRP',
      villainBetBB: 7, potRatio: 7 / 19.5,
      note: '与 V2 报告 §10 同一节点（TURN_CHECK_BACK + LARGE）',
    },
    units: {
      equity: '0..1 比例（×100 = 百分点）',
      bluffMass: '概率质量占比；分母 = 对手可达组合后验质量之和',
      ev: '筹码（本项目 1BB = 2 筹码 ⇒ EV ÷ 2 = BB）',
      foldCallRaise: '概率（响应模型对所选尺寸的三桶质量）',
      sizing: 'BB；potRatio = 金额 ÷ 下注前底池',
    },
  },
};

/* ---------- 确定性自检 ---------- */
const det = CASES.map((c) => {
  const a = snapshot(s1Input(), c.profile);
  const b = snapshot(s1Input(), c.profile);
  return {
    id: c.id,
    bitIdentical: JSON.stringify(a) === JSON.stringify(b),
    equity: a.heroEquity, bluffMass: a.bluffMass, action: a.action,
  };
});
report['determinismSelfCheck'] = det;
console.error(`[det] ${det.filter((d) => d.bitIdentical).length}/${det.length} 逐位相同`);

/*
 * 🔴 **退化自检**（本轮新增，因为第一版真的踩了）：
 * 若所有画像给出**完全相同**的权益，说明画像根本没进被分析的那份输入 ——
 * 那种情况下所有 Δ 都会是 0，而报告会「看起来很干净」。
 * 这里把它变成一条硬失败，而不是让人去肉眼发现。
 */
{
  const eqs = det.map((d) => d.equity).filter((x): x is number => x !== null);
  const masses = det.map((d) => d.bluffMass).filter((x): x is number => x !== null);
  const spread = eqs.length === 0 ? 0 : Math.max(...eqs) - Math.min(...eqs);
  const massSpread = masses.length === 0 ? 0 : Math.max(...masses) - Math.min(...masses);
  report['degeneracySelfCheck'] = { equitySpreadAcrossProfiles: spread, bluffMassSpreadAcrossProfiles: massSpread };
  if (!(spread > 0)) {
    throw new Error(
      `退化测量：全部 ${eqs.length} 个画像的权益完全相同（spread=${spread}）—— ` +
      '画像没有进入被分析的那份输入，本脚本的所有 Δ 都无意义',
    );
  }
  if (!(massSpread > 0)) {
    throw new Error(`退化测量：诈唬质量 spread=${massSpread} —— 画像没有生效`);
  }
  console.error(`[det] 非退化：权益极差 ${(spread * 100).toFixed(3)}pp、诈唬质量极差 ${(massSpread * 100).toFixed(3)}pp`);
}

/* ---------- 基线：UNKNOWN（**不带画像**，与 V2 报告口径一致） ---------- */
const baselineUnknown = snapshot(s1Input(), undefined);
const baselineNormal = snapshot(s1Input(), CASES[0]!.profile);
report['baselines'] = { UNKNOWN_noProfile: baselineUnknown, NORMAL_tag: baselineNormal };

/* ---------- 逐画像指标 ---------- */
const perCase = CASES.map((c) => {
  const s = snapshot(s1Input(), c.profile);
  const ref = baselineNormal;
  const dist = s.classVector !== null && ref.classVector !== null
    ? profileRangeDistance(s.classVector, ref.classVector)
    : null;
  return {
    id: c.id, archetype: c.archetype,
    snapshot: s,
    vsNeutralNormal: {
      equityDelta: s.heroEquity !== null && ref.heroEquity !== null ? s.heroEquity - ref.heroEquity : null,
      bluffMassDelta: s.bluffMass !== null && ref.bluffMass !== null ? s.bluffMass - ref.bluffMass : null,
      eqVsCall: s.heroEquity !== null && s.requiredEquity !== null ? s.heroEquity - s.requiredEquity : null,
      callEVDelta: s.callEV !== null && ref.callEV !== null ? s.callEV - ref.callEV : null,
      foldLikelihoodDelta:
        s.foldLikelihood !== null && ref.foldLikelihood !== null ? s.foldLikelihood - ref.foldLikelihood : null,
      callLikelihoodDelta:
        s.callLikelihood !== null && ref.callLikelihood !== null ? s.callLikelihood - ref.callLikelihood : null,
      raiseLikelihoodDelta:
        s.raiseLikelihood !== null && ref.raiseLikelihood !== null ? s.raiseLikelihood - ref.raiseLikelihood : null,
      equitySource: s.equitySource,
      actionFrom: ref.action, actionTo: s.action,
      flipped: ref.action !== s.action,
      sizingFromBB: ref.sizingBB, sizingToBB: s.sizingBB,
      categoryRangeDistance: dist,
    },
  };
});
report['perProfile'] = perCase;

/* ---------- §2 三项冲突场景 ---------- */

/* 冲突 1：历史偏跟注（CALLING_STATION 标签）但当前行动/尺度支持更强范围（超池下注） */
const conflict1 = {
  id: 'C1_HISTORY_PASSIVE_CURRENT_STRONG',
  description: '历史标签「跟注站」（被动、诈唬低）↔ 当前河牌**超池**下注（更强范围证据）',
  rows: [0.25, 0.5, 0.75, 1.0, 1.5].map((share) => {
    const bet = Number((19.5 * share).toFixed(2));
    const cs = snapshot(s1Input(bet), CASES[2]!.profile);
    const ma = snapshot(s1Input(bet), CASES[4]!.profile);
    const nu = snapshot(s1Input(bet), undefined);
    return {
      betShareOfPot: share, betBB: bet,
      neutral: { equity: nu.heroEquity, bluffMass: nu.bluffMass, action: nu.action, fold: nu.foldLikelihood },
      callingStation: { equity: cs.heroEquity, bluffMass: cs.bluffMass, action: cs.action, fold: cs.foldLikelihood },
      maniac: { equity: ma.heroEquity, bluffMass: ma.bluffMass, action: ma.action, fold: ma.foldLikelihood },
    };
  }),
};
report['conflict1_historyPassive_currentStrong'] = conflict1;

/* 冲突 2：历史激进（MANIAC）但当前牌面/行动线削弱诈唬解释（干燥面 + 小注 + 无听牌） */
const DRY_BOARD_HISTORY = [
  { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' },
  { position: 'UTG2', type: 'FOLD' }, { position: 'LJ', type: 'FOLD' },
  { position: 'HJ', type: 'FOLD' },
  { position: 'CO', type: 'RAISE', amountBB: 2.5 },
  { position: 'BTN', type: 'FOLD' }, { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'CALL', amountBB: 1.5 },
  { position: 'BB', type: 'CHECK', street: 'FLOP' },
  { position: 'CO', type: 'CHECK', street: 'FLOP' },
  { position: 'BB', type: 'CHECK', street: 'TURN' },
  { position: 'CO', type: 'CHECK', street: 'TURN' },
  { position: 'BB', type: 'CHECK', street: 'RIVER' },
  { position: 'CO', type: 'BET', amountBB: 2.5, street: 'RIVER' },
] as const;

function dryInput(): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BB', heroCards: ['Kh', 'Kc'],
    board: ['Kd', '7s', '2h', '4c', '9d'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2, seatStacksBB: { ...SEATS9 },
    actionHistory: DRY_BOARD_HISTORY.map((h) => ({ ...h })),
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'MANIAC', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}
const conflict2 = {
  id: 'C2_HISTORY_AGGRESSIVE_CURRENT_WEAK',
  description: '历史标签「疯子」（诈唬高）↔ 当前干燥面 + 三次过牌后 **小注 2.5BB（13% 池）**（削弱诈唬解释）',
  neutral: (() => { const s = snapshot(dryInput(), undefined); return { equity: s.heroEquity, bluffMass: s.bluffMass, action: s.action, fold: s.foldLikelihood }; })(),
  maniac: (() => { const s = snapshot(dryInput(), CASES[4]!.profile); return { equity: s.heroEquity, bluffMass: s.bluffMass, action: s.action, fold: s.foldLikelihood }; })(),
  station: (() => { const s = snapshot(dryInput(), CASES[2]!.profile); return { equity: s.heroEquity, bluffMass: s.bluffMass, action: s.action, fold: s.foldLikelihood }; })(),
};
report['conflict2_historyAggressive_currentWeak'] = conflict2;

/* 冲突 3：历史紧弱（VERY_TIGHT）但少量近期行为看似激进（人工读 / 小样本实测） */
const conflict3 = {
  id: 'C3_HISTORY_TIGHTWEAK_recentAggressive',
  description: '历史标签「极紧」（诈唬低）↔ 少量近期行为看似激进（人工读 VERY_HIGH / 2 手中 2 次开火）',
  tagOnly: (() => { const s = snapshot(s1Input(), behaviorProfileOf({ playerId: 'vt', archetype: 'VERY_TIGHT' as never })); return { equity: s.heroEquity, bluffMass: s.bluffMass, action: s.action, fold: s.foldLikelihood }; })(),
  manualVeryHigh: (() => { const s = snapshot(s1Input(), behaviorProfileOf({
    playerId: 'vt-m', archetype: 'VERY_TIGHT' as never,
    manual: { [BehaviorTraitKey.RIVER_BLUFF]: 'VERY_HIGH' } as never,
  })); return { equity: s.heroEquity, bluffMass: s.bluffMass, action: s.action, fold: s.foldLikelihood }; })(),
  observed2of2: (() => {
    const s = snapshot(s1Input(), behaviorProfileOf({
      playerId: 'vt-o2', archetype: 'VERY_TIGHT' as never,
      observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 2, opportunities: 2 } } as never,
    }));
    return {
      equity: s.heroEquity, bluffMass: s.bluffMass, action: s.action, fold: s.foldLikelihood,
      note: '2/2 = observedRate 1.0，但收缩后 effectiveRate = (0.12×6 + 2)/(6+2) = 0.34',
    };
  })(),
  observed30of30: (() => {
    const s = snapshot(s1Input(), behaviorProfileOf({
      playerId: 'vt-o30', archetype: 'VERY_TIGHT' as never,
      observed: { [BehaviorTraitKey.RIVER_BLUFF]: { successes: 30, opportunities: 30 } } as never,
    }));
    return { equity: s.heroEquity, bluffMass: s.bluffMass, action: s.action, fold: s.foldLikelihood };
  })(),
};
report['conflict3_historyTightWeak_recentAggressive'] = conflict3;

/* ---------- §3 Profile Dominance 防护（逐行客观断言） ---------- */

const PROFILE_ORDER = [...CASES];
const dominanceRows = PROFILE_ORDER.map((c) => {
  const s = snapshot(s1Input(), c.profile);
  const violations: string[] = [];
  const inUnit = (x: number | null): boolean => x === null || (Number.isFinite(x) && x >= -1e-12 && x <= 1 + 1e-12);
  if (!inUnit(s.heroEquity)) violations.push(`heroEquity 越界 ${s.heroEquity}`);
  if (!inUnit(s.requiredEquity)) violations.push(`requiredEquity 越界 ${s.requiredEquity}`);
  if (!inUnit(s.bluffMass)) violations.push(`bluffMass 越界 ${s.bluffMass}`);
  if (s.classVector !== null) {
    const sum = s.classVector.reduce((a, b) => a + b, 0);
    if (!(sum <= 1 + 1e-9)) violations.push(`类别质量之和 > 1：${sum}`);
    if (s.classVector.some((x) => x < -1e-12)) violations.push('类别质量为负');
  }
  if (s.combosBefore !== null && s.combosAfter !== null && s.combosBefore !== s.combosAfter) {
    violations.push(`组合集被改变：${s.combosBefore} → ${s.combosAfter}`);
  }
  /*
   * 🔴 **fail-closed**：拿不到钳位数据时判**违规**，不得判通过。
   * 修复前这里是 `clampedCount !== null && clampedCount > 0` —— 一个
   * **永远为假**的空检查（读取路径写错 ⇒ 恒 null ⇒ 恒不违规）。
   */
  if (!s.clampCheckAvailable) {
    if (s.unifiedLikelihoodEngaged) {
      violations.push('CLAMP_CHECK_UNAVAILABLE：统一似然已启用但 trace 里读不到钳位计数');
    }
  } else if ((s.clampedCount ?? 0) > 0) {
    violations.push(`似然被钳位 ${s.clampedCount}/${s.clampedUniverse} 个组合（类别区分被压平）`);
  }
  return {
    id: c.id,
    violated: violations.length > 0, violations,
    fp: {
      heroEquity: s.heroEquity, requiredEquity: s.requiredEquity,
      bluffMass: s.bluffMass, combosBefore: s.combosBefore, combosAfter: s.combosAfter,
      clampedCount: s.clampedCount, clampedUniverse: s.clampedUniverse,
      clampCheckAvailable: s.clampCheckAvailable,
      traitCountRange: s.traitCountRange,
      action: s.action, fold: s.foldLikelihood, call: s.callLikelihood, raise: s.raiseLikelihood,
    },
  };
});
report['profileDominance'] = {
  checks: [
    'heroEquity / requiredEquity / bluffMass ∈ [0,1] 且有限',
    '类别质量向量之和 ≤ 1 且无负分量',
    '可达组合集不变（combosBefore === combosAfter）',
    '似然钳位次数 = 0（否则类别区分被压平）',
    '（不变量）requiredEquity 只由价格决定 ⇒ 必须**不随画像变化**',
  ],
  rows: dominanceRows,
  requiredEquityInvariant: (() => {
    const values = new Set(dominanceRows.map((r) => r.fp.requiredEquity));
    return { distinctValues: [...values], holds: values.size === 1 };
  })(),
};

/* ---------- §4 输入微扰稳定性 ---------- */

/*
 * 合理输入边界（**必须有明确边界**，不得把非法极端当成果）：
 * - 下注额 ±5%（同一手牌被读成 6.65 / 7.00 / 7.35 BB —— 现实里的录入误差量级）；
 * - `asOf` ±1 天（知识库生效时刻的录入误差）；
 * - `equitySeed` 换种子（20260913 / 1 / 7）—— 只在回落到蒙特卡洛时才有影响。
 * **不**包含：改牌、改底池、改位置、改筹码 —— 那些是**不同的牌局**，不是微扰。
 */
type Perturbation = { kind: string; detail: string; input: ManualHandInput; options: typeof OPTIONS };

const baseBet = 7;
const perturbations: Perturbation[] = [];
for (const delta of [-0.05, 0, 0.05]) {
  perturbations.push({
    kind: 'BET_AMOUNT_PCT',
    detail: `${(delta * 100).toFixed(0)}%`,
    input: s1Input(Number((baseBet * (1 + delta)).toFixed(4))),
    options: OPTIONS,
  });
}
for (const day of [-1, 0, 1]) {
  perturbations.push({
    kind: 'ASOF_SHIFT_DAY',
    detail: `${day}d`,
    input: s1Input(baseBet),
    options: { ...OPTIONS, asOf: ASOF + day * 86_400_000 },
  });
}
for (const seed of [20260913, 1, 7]) {
  perturbations.push({
    kind: 'EQUITY_SEED',
    detail: String(seed),
    input: s1Input(baseBet),
    options: { ...OPTIONS, equitySeed: seed },
  });
}

const stability = PROFILE_ORDER.map((c) => {
  const rows = perturbations.map((p) => {
    const r = analyzeManualHand(p.input, p.options);
    const ok = r.ok;
    const m = ok ? r.decision.diagnostics.math : null;
    const sizing = ok ? (r.decision.sizing as unknown as Record<string, unknown> | null | undefined) : null;
    return {
      kind: p.kind, detail: p.detail, ok,
      action: ok ? String(r.decision.action) : null,
      equity: m?.heroEquity ?? null,
      sizingBB: sizing && typeof sizing['amount'] === 'number' ? sizing['amount'] as number
        : sizing && typeof sizing['amountBB'] === 'number' ? sizing['amountBB'] as number : null,
    };
  });
  const actions = [...new Set(rows.map((r) => r.action))];
  const equities = rows.map((r) => r.equity).filter((x): x is number => x !== null);
  const sizings = rows.map((r) => r.sizingBB).filter((x): x is number => x !== null);
  return {
    id: c.id,
    distinctActions: actions,
    actionFlipsUnderPerturbation: actions.length > 1,
    equityRange: equities.length === 0 ? null : [Math.min(...equities), Math.max(...equities)],
    equitySpread: equities.length === 0 ? null : Math.max(...equities) - Math.min(...equities),
    sizingRangeBB: sizings.length === 0 ? null : [Math.min(...sizings), Math.max(...sizings)],
    rows,
  };
});
report['inputPerturbationStability'] = {
  boundaryNote:
    '合理输入边界：下注额 ±5%、asOf ±1 天、权益种子取值。**不含**改牌/改底池/改位置/改筹码（那些是不同的牌局）。',
  rows: stability,
};

/* ---------- §5 候选动作 EV 差距 ---------- */
report['evGaps'] = PROFILE_ORDER.map((c) => {
  const s = snapshot(s1Input(), c.profile);
  return {
    id: c.id, action: s.action, candidateEVs: s.candidateEVs,
    bestSize: s.bestSize, checkEV: s.checkEV, evGapBestSecond: s.evGapBestSecond,
    note: 'BET/RAISE 的 ev 依赖弃牌率；本项目无可信弃牌率估计 ⇒ 多数候选 ev = null（RAISE EV = NOT_AVAILABLE 未改）',
  };
});

mkdirSync('reports/evidence', { recursive: true });
writeFileSync('reports/evidence/v21-decision-impact.json', JSON.stringify(report, null, 1), 'utf8');
console.error('[done] reports/evidence/v21-decision-impact.json');

/* ============================================================
 * 打印
 * ============================================================ */

const pct = (x: number | null, d = 2): string => (x === null ? '—' : (x * 100).toFixed(d) + '%');
const pp = (x: number | null, d = 2): string => (x === null ? '—' : (x * 100).toFixed(d) + 'pp');
const num = (x: number | null, d = 3): string => (x === null ? '—' : x.toFixed(d));

console.log('\n===== 指标 1–12：逐画像（基线 = NORMAL 标签 / 无观测，与 V2 §10 同节点）=====');
console.log(
  '  画像'.padEnd(34) + '动作'.padEnd(9) + '权益'.padEnd(10) + 'eqΔ'.padEnd(9) + '诈唬Δ'.padEnd(10) +
  'EqVsCallΔ'.padEnd(11) + '跟注EVΔ'.padEnd(11) + '弃牌%Δ'.padEnd(10) + '类别TV'.padEnd(10) + '尺寸BB',
);
for (const c of perCase) {
  const v = c.vsNeutralNormal;
  console.log(
    `  ${c.id.padEnd(32)}${String(v.actionTo).padEnd(9)}${pct(c.snapshot.heroEquity).padEnd(10)}` +
    `${pp(v.equityDelta).padEnd(9)}${pp(v.bluffMassDelta).padEnd(10)}` +
    `${pp(v.eqVsCall).padEnd(11)}${num(v.callEVDelta).padEnd(11)}` +
    `${pp(v.foldLikelihoodDelta).padEnd(10)}${num(v.categoryRangeDistance?.totalVariation ?? null, 4).padEnd(10)}` +
    `${num(c.snapshot.sizingBB)}`,
  );
}

console.log('\n===== 指标 4–6：对手弃牌/跟注/加注概率（按尺寸）=====');
for (const c of [perCase[0]!, perCase[2]!, perCase[4]!]) {
  console.log(`  ${c.id}：动作=${c.snapshot.action} 最佳尺寸=${c.snapshot.bestSize ?? '—'}`);
  for (const s of c.snapshot.sizeTable) {
    console.log(
      `    ${s.label.padEnd(10)} ${num(s.amountBB, 2).padStart(7)}BB (${pct(s.ratio, 0).padStart(5)}) ` +
      `弃 ${pct(s.fold)} 跟 ${pct(s.call)} 加 ${pct(s.raise)}  EV ${num(s.ev)}`,
    );
  }
}

console.log('\n===== 指标 9：最优 vs 次优 EV 差距 =====');
for (const g of report['evGaps'] as { id: string; evGapBestSecond: number | null; candidateEVs: Record<string, number | null> }[]) {
  console.log(`  ${g.id.padEnd(34)} gap=${num(g.evGapBestSecond)}  ${JSON.stringify(g.candidateEVs)}`);
}

console.log('\n===== §3 Profile Dominance 检查 =====');
const dr = report['profileDominance'] as { rows: { id: string; violated: boolean; violations: string[]; fp: Record<string, unknown> }[]; requiredEquityInvariant: { holds: boolean; distinctValues: unknown[] } };
console.log(`  违规行数：${dr.rows.filter((r) => r.violated).length} / ${dr.rows.length}`);
for (const r of dr.rows.filter((x) => x.violated)) console.log(`    ✖ ${r.id}: ${r.violations.join('；')}`);
console.log(`  requiredEquity 不随画像变化：${dr.requiredEquityInvariant.holds ? '✅ 成立' : `✖ 不成立（取值 ${JSON.stringify(dr.requiredEquityInvariant.distinctValues)}）`}`);

console.log('\n===== §4 输入微扰稳定性（±5% 下注额 / ±1 天 asOf / 3 个种子）=====');
const st = report['inputPerturbationStability'] as { rows: { id: string; actionFlipsUnderPerturbation: boolean; distinctActions: string[]; equitySpread: number | null; sizingRangeBB: number[] | null }[] };
for (const r of st.rows) {
  console.log(
    `  ${r.id.padEnd(34)} 动作集合=${JSON.stringify(r.distinctActions).padEnd(16)} ` +
    `翻转=${r.actionFlipsUnderPerturbation ? '★是' : '否'}  权益极差=${pp(r.equitySpread, 3)}  ` +
    `尺寸范围=${r.sizingRangeBB === null ? '—' : `[${r.sizingRangeBB.map((x) => x.toFixed(2)).join(', ')}] BB`}`,
  );
}

console.log('\n===== §2 冲突场景 =====');
console.log('冲突 1（历史被动 ↔ 当前超池）：');
for (const r of conflict1.rows) {
  console.log(
    `  ${pct(r.betShareOfPot, 0).padStart(5)} 池 (${String(r.betBB).padStart(6)}BB)  ` +
    `中性 权益${pct(r.neutral.equity)} 诈唬${pct(r.neutral.bluffMass)} ${r.neutral.action}  ` +
    `| 跟注站 权益${pct(r.callingStation.equity)} 诈唬${pct(r.callingStation.bluffMass)} ${r.callingStation.action}  ` +
    `| 疯子 权益${pct(r.maniac.equity)} 诈唬${pct(r.maniac.bluffMass)} ${r.maniac.action}`,
  );
}
console.log(`冲突 2（历史激进 ↔ 当前干燥面小注）：`);
console.log(`  中性 ${JSON.stringify(conflict2.neutral)}`);
console.log(`  疯子 ${JSON.stringify(conflict2.maniac)}`);
console.log(`  跟注站 ${JSON.stringify(conflict2.station)}`);
console.log(`冲突 3（历史极紧 ↔ 近期激进）：`);
console.log(`  只有标签     ${JSON.stringify(conflict3.tagOnly)}`);
console.log(`  人工 VERY_HIGH ${JSON.stringify(conflict3.manualVeryHigh)}`);
console.log(`  实测 2/2      ${JSON.stringify(conflict3.observed2of2)}`);
console.log(`  实测 30/30    ${JSON.stringify(conflict3.observed30of30)}`);
console.log(`  基线 UNKNOWN 权益 ${pct(baselineUnknown.heroEquity)} 诈唬 ${pct(baselineUnknown.bluffMass)} 动作 ${baselineUnknown.action}`);
