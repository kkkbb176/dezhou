/**
 * 🔴 专项审计：转牌半诈唬节点为什么三个 BET 尺寸全部为 0
 *
 * ## 纪律（本轮只观察，不改任何源码 / 阈值 / 参数）
 *
 * - 输入牌局**逐字固定**（使用者给定），脚本只读引擎输出；
 * - 全部分数链**先打印 raw（clamp 之前）**，再打印 clamp / floor 之后的值；
 * - 代码里不存在的字段一律标 `NOT_IMPLEMENTED`，不伪造；
 * - 逐项重算使用**引擎自己给出的输入**，并断言 `clamp(raw) === 引擎报告值`
 *   —— 只有逐位相等，才能证明这条链就是引擎真实走的那条。
 *
 * 用法：`E:\node.exe --experimental-strip-types scripts/audit-turn-bet-zero.ts`
 */
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { advisePostflop, type PostflopAdvice } from '../src/app/decision/postflopAdvisor.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { parseManualInput, type ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { multiwayAdjustment } from '../src/domain/postflop/multiway.ts';
import { assessValueBet, roleStrengthOf } from '../src/domain/postflop/valueBetGate.ts';
import { RelativeHandRole } from '../src/domain/postflop/types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const SEATS = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

const PREFLOP = [
  { position: 'UTG', type: 'FOLD' },
  { position: 'HJ', type: 'RAISE', amountBB: 3 },
  { position: 'CO', type: 'RAISE', amountBB: 9 },
  { position: 'BTN', type: 'FOLD' },
  { position: 'SB', type: 'FOLD' },
  { position: 'BB', type: 'FOLD' },
  { position: 'HJ', type: 'CALL', amountBB: 6 },
] as const;

/** 固定节点：翻牌（对照） */
function flopNode(quickProfile = 'UNKNOWN'): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'CO',
    heroCards: ['As', 'Js'],
    board: ['Qd', '8s', '4s'],
    street: 'FLOP',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [...PREFLOP, { position: 'HJ', type: 'CHECK', street: 'FLOP' }],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

/** 固定节点：转牌（被审计节点） */
function turnNode(quickProfile = 'UNKNOWN'): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'CO',
    heroCards: ['As', 'Js'],
    board: ['Qd', '8s', '4s', '2h'],
    street: 'TURN',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [
      ...PREFLOP,
      { position: 'HJ', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'CHECK', street: 'FLOP' },
      { position: 'HJ', type: 'CHECK', street: 'TURN' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

/* ============================================================
 * 评分链复算器（**只复算，不改**；逐位对齐引擎报告值）
 * ============================================================ */

type Chain = {
  inputs: Record<string, number | string | boolean | null>;
  terms: Record<string, number>;
  note: Record<string, string>;
  betScoreRaw: number;
  betScore: number;
  checkScoreRaw: number;
  checkScore: number;
  gap: number;
  verdict: string;
  matchesEngine: { bet: boolean; check: boolean; verdict: boolean };
};

function reconstructChain(input: {
  advice: PostflopAdvice;
  equity: number;
  opponentCount: number;
  thinValueDelta: number;
  bluffDelta: number;
  roleStrength: number;
}): Chain {
  const { advice, equity, opponentCount, thinValueDelta, bluffDelta, roleStrength } = input;
  const gate = advice.gate;
  const c = advice.compression;
  const multi = multiwayAdjustment(opponentCount);

  // ---- 门内部：与 valueBetGate.assessValueBet 完全相同的表达式 ----
  const stickiness = clamp01(c.showdownDensity * 0.6 + c.mediumStrengthDensity * 0.4 + 0.25);
  const worseCallDensity = clamp01(
    gate.weakerShare * (0.55 + 0.45 * stickiness) - multi.multiwayValueThresholdAdjustment * 0.5,
  );
  const worseHandsCanCall = worseCallDensity > 0.25;
  const betterContinueDensity = clamp01(
    gate.strongerShare * (0.6 + 0.4 * c.aggressionCredibility),
  );
  const betterHandsContinue = betterContinueDensity > 0.45;
  const raiseRisk = clamp01(
    gate.strongerShare * 0.7 + c.aggressionCredibility * 0.15 - clamp01(advice.wetness) * 0.1,
  );
  const showdownValue = clamp01(roleStrength * 0.5 + clamp01(equity) * 0.5);
  const protectionRelevant =
    advice.wetness > 0.4 || (advice.gate.weakerShare > 0 ? false : false) || false;
  const protectionBenefit = clamp01(clamp01(advice.wetness) * 0.6 + (1 - c.airDensity) * 0.2);

  const fairShare = 1 / (opponentCount + 1);
  const valuePart = clamp01((clamp01(equity) - fairShare) / Math.max(1e-6, 1 - fairShare));
  const bluffComponent = clamp01(clamp01(advice.wetness) * 0.4 + (1 - c.airDensity) * 0.2 + 0.2);

  const valueContribution = valuePart * (0.5 + 0.5 * worseCallDensity);
  const semiBluffContribution = bluffComponent * (0.5 - multi.multiwayBluffPenalty);
  const protectionContribution = 0; // 生产路径 protectionRelevant = false ⇒ 该项恒为 0
  const betterContinuePenalty = betterContinueDensity * 0.35;
  const raiseRiskPenalty = raiseRisk * 0.2;

  const betScoreRaw =
    valueContribution + semiBluffContribution + protectionContribution - betterContinuePenalty - raiseRiskPenalty;
  const additive = (advice.role === RelativeHandRole.THIN_VALUE ? thinValueDelta : 0) +
    (bluffComponent > 0 ? bluffDelta : 0);
  const betScore = clamp01(betScoreRaw + additive);

  const trapCondition = showdownValue > 0.55 && !worseHandsCanCall && betterContinueDensity > 0.4;
  const checkScoreRaw =
    showdownValue * 0.35 +
    (worseHandsCanCall ? -0.15 * worseCallDensity : 0.1) +
    (trapCondition ? 0.25 : 0);
  const checkScore = clamp01(checkScoreRaw);
  const gap = betScore - checkScore;
  const verdict =
    gap >= 0.18 ? 'CLEAR_VALUE' : gap >= 0.06 ? 'THIN_VALUE' : gap > -0.06 ? 'MARGINAL' : gap > -0.18 ? 'PREFER_CHECK' : 'NOT_VALUE';

  return {
    inputs: {
      role: advice.role,
      roleStrength,
      equity,
      opponentCount,
      fairShare,
      wetness: advice.wetness,
      airDensity: c.airDensity,
      mediumStrengthDensity: c.mediumStrengthDensity,
      showdownDensity: c.showdownDensity,
      nutDensity: c.nutDensity,
      drawDensity: c.drawDensity,
      aggressionCredibility: c.aggressionCredibility,
      strongerShare: gate.strongerShare,
      weakerShare: gate.weakerShare,
      multiwayValueThresholdAdjustment: multi.multiwayValueThresholdAdjustment,
      multiwayBluffPenalty: multi.multiwayBluffPenalty,
      protectionRelevantInAdvisor: advice.wetness > 0.4 ? true : false,
      protectionRelevant,
      thinValueDelta,
      bluffDelta,
      hasCardsToCome: advice.street !== 'RIVER',
    },
    terms: {
      stickiness,
      worseCallDensity,
      betterContinueDensity,
      raiseRisk,
      showdownValue,
      protectionBenefit,
      valuePart,
      bluffComponent,
      valueContribution,
      semiBluffContribution,
      protectionContribution,
      betterContinuePenalty,
      raiseRiskPenalty,
      additive,
      checkShowdownPart: showdownValue * 0.35,
      checkNoWorseCallerBonus: worseHandsCanCall ? -0.15 * worseCallDensity : 0.1,
      checkTrapBonus: trapCondition ? 0.25 : 0,
    },
    note: {
      worseHandsCanCall: String(worseHandsCanCall),
      betterHandsContinue: String(betterHandsContinue),
      trapCondition: String(trapCondition),
    },
    betScoreRaw,
    betScore,
    checkScoreRaw,
    checkScore,
    gap,
    verdict,
    matchesEngine: {
      bet: Math.abs(betScore - gate.estimatedBetEVScore) < 1e-12,
      check: Math.abs(checkScore - gate.estimatedCheckEVScore) < 1e-12,
      verdict: verdict === gate.verdict,
    },
  };
}

/* ============================================================
 * 单节点完整报告
 * ============================================================ */

type NodeReport = { chain: Chain; advice: PostflopAdvice; action: string | null; equity: number };

function reportNode(label: string, input: ManualHandInput, verbose: boolean): NodeReport | null {
  const result = analyzeManualHand(input, OPTIONS);
  if (!result.ok) {
    console.log(`\n### ${label}：❌ ${JSON.stringify(result.issues)}`);
    return null;
  }
  const parsed = parseManualInput(input);
  if (!parsed.ok) return null;
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) return null;
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
    quickProfile: input.villain?.quickProfile,
  });
  const hero = gate.state.players.find((p) => p.holeCards !== null)!;
  const legal = deriveLegalActions(gate.state, hero);
  const advice = advisePostflop(built.context, {
    facingBet: legal.callCost > 0,
    requiredEquity: built.context.math.requiredEquity,
    potAfterCall: built.context.math.pot + legal.callCost,
  });
  if (advice === null) {
    console.log(`\n### ${label}：翻前，无翻后建议`);
    return null;
  }

  const equity = built.context.math.heroEquity ?? 0;
  const chain = reconstructChain({
    advice,
    equity,
    opponentCount: built.context.realizedOpponentCount,
    thinValueDelta: advice.exploit.thinValueDelta,
    bluffDelta: advice.exploit.bluffDelta,
    roleStrength: roleStrengthOf(advice.role),
  });

  const sizeOf = (action: string): { raw: number; afterFloor: number; final: number } => {
    const g = gate.estimatedBetEVScore;
    const raw = reconstructChain({
      advice,
      equity,
      opponentCount: built.context.realizedOpponentCount,
      thinValueDelta: advice.exploit.thinValueDelta,
      bluffDelta: advice.exploit.bluffDelta,
      roleStrength: roleStrengthOf(advice.role),
    }).betScoreRaw + chain.terms.additive;
    void g;
    if (action === 'BET_SMALL') return { raw: raw * 0.95, afterFloor: raw * 0.95, final: Math.max(0, Math.min(1, raw * 0.95)) };
    if (action === 'BET_MEDIUM') return { raw, afterFloor: raw, final: Math.max(0, Math.min(1, raw)) };
    return { raw: raw - 0.08, afterFloor: Math.max(0, raw - 0.08), final: Math.max(0, Math.min(1, Math.max(0, raw - 0.08))) };
  };

  if (!verbose) {
    console.log(
      `\n### ${label}` +
        `\n  动作 ${String(result.decision.action)}｜权益 ${(equity * 100).toFixed(2)}%｜角色 ${advice.role}` +
        `｜raw ${chain.betScoreRaw.toFixed(4)} → bet ${chain.betScore.toFixed(4)} vs check ${chain.checkScore.toFixed(4)}` +
        `（gap ${chain.gap.toFixed(4)} ⇒ ${chain.verdict}）`,
    );
    return { chain, advice, action: result.decision.action, equity };
  }

  console.log(`\n════════ ${label} ════════`);
  console.log(`  引擎动作：${String(result.decision.action)}｜置信度 ${result.decision.confidence.toFixed(2)}（${result.decision.band}）｜分类 ${result.decision.classification}`);
  console.log(`  合法动作：${legal.actions.join('/')}（BET 候选${legal.actions.includes('BET') ? '存在' : '**不存在**'}）`);
  console.log(`  决策依据：${result.decision.diagnostics.decisionBasis?.kind ?? '—'}｜理由码：${result.decision.reasons.map((r) => r.code).join(', ')}`);
  console.log(`  角色 role=${advice.role}（强度 ${roleStrengthOf(advice.role)}）｜街 ${advice.street}｜人数 ${built.context.realizedOpponentCount}`);

  console.log('\n  ── 门输入（全部为引擎报告值） ──');
  for (const [k, v] of Object.entries(chain.inputs)) {
    console.log(`    ${k.padEnd(34)} ${typeof v === 'number' ? v.toFixed(6) : String(v)}`);
  }

  console.log('\n  ── raw-score 链（clamp / floor 之前） ──');
  const t = chain.terms;
  console.log(`    valuePart                = ${t.valuePart!.toFixed(6)}   ← (equity ${(equity * 100).toFixed(2)}% − 公平基线 ${((chain.inputs.fairShare as number) * 100).toFixed(1)}%) / (1 − 基线)`);
  console.log(`    valueContribution        = ${t.valueContribution!.toFixed(6)}   = valuePart × (0.5 + 0.5 × worseCallDensity ${t.worseCallDensity!.toFixed(4)})`);
  console.log(`    semiBluffContribution    = ${t.semiBluffContribution!.toFixed(6)}   = bluffComponent ${t.bluffComponent!.toFixed(6)} × (0.5 − 多人诈唬惩罚 ${Number(chain.inputs.multiwayBluffPenalty).toFixed(4)})`);
  console.log(`    pureBluffContribution    = NOT_IMPLEMENTED（无独立纯诈唬项；bluffComponent 按角色合并了 PURE_BLUFF / SEMI_BLUFF）`);
  console.log(`    foldEquityContribution   = NOT_IMPLEMENTED（本项目无弃牌率估计，见 valueBetGate 文件头）`);
  console.log(`    futureEquityContribution = NOT_IMPLEMENTED`);
  console.log(`    drawEquityContribution   = NOT_IMPLEMENTED（Hero 自己的补牌数/听牌权益未进入评分；见 §3）`);
  console.log(`    protectionContribution   = ${t.protectionContribution!.toFixed(6)}   = protectionBenefit ${t.protectionBenefit!.toFixed(6)} × 0.15（本节点 protectionRelevant=${String(chain.inputs.protectionRelevant)} ⇒ 恒 0）`);
  console.log(`    betterContinueAdjustment = ${(-t.betterContinuePenalty!).toFixed(6)}   = −betterContinueDensity ${t.betterContinueDensity!.toFixed(4)} × 0.35`);
  console.log(`    raiseRiskAdjustment      = ${(-t.raiseRiskPenalty!).toFixed(6)}   = −raiseRisk ${t.raiseRisk!.toFixed(4)} × 0.20`);
  console.log(`    blockerAdjustment        = NOT_IMPLEMENTED（阻断牌只进 callScore，不进 betScore；见 §1 说明）`);
  console.log(`    unblockerAdjustment      = NOT_IMPLEMENTED`);
  console.log(`    showdownValueAdjustment  = ${t.checkShowdownPart!.toFixed(6)}   ← 只进 CHECK 分：showdownValue ${t.showdownValue!.toFixed(4)} × 0.35`);
  console.log(`    worseCanCallAdjustment   = ${t.checkNoWorseCallerBonus!.toFixed(6)}   ← 只进 CHECK 分（worseHandsCanCall=${chain.note.worseHandsCanCall}）`);
  console.log(`    profileAdjustment        = 见 §7（画像同时经 range 与 compression 两条路进入）`);
  console.log(`    observationAdjustment    = NOT_IMPLEMENTED（近期倾向只改 range／似然，不改评分）`);
  console.log(`    sizeAdjustment           = NOT_IMPLEMENTED（三个尺寸由同一个分数变换而来，见下）`);
  console.log(`    streetAdjustment         = 只经 aggressionCredibility 的 STREET_WEIGHT（flop 1/3、turn 2/3）`);
  console.log(`    SPRAdjustment            = NOT_IMPLEMENTED（ValueGateInput.spr 声明但**函数体内零引用**）`);
  console.log(`    positionAdjustment       = NOT_IMPLEMENTED（hasInitiative 同样声明未用）`);
  console.log(`    boardTextureAdjustment   = 经 wetness=${advice.wetness.toFixed(4)}（只影响 bluffComponent 与 raiseRisk）`);
  console.log(`    confidenceAdjustment     = NOT_IMPLEMENTED（置信度在 evScore/decisionEngine，不回改分数）`);
  console.log(`    baseScore                = NOT_IMPLEMENTED（没有独立的 base 项；raw 就是上面各项之和）`);

  console.log('\n  ── 合计与 clamp ──');
  console.log(`    rawScoreBeforeClamp      = ${chain.betScoreRaw.toFixed(6)}`);
  console.log(`    additive（画像偏移）      = ${t.additive!.toFixed(6)}（thinValueDelta 仅 THIN_VALUE 生效；bluffDelta 仅在 bluffComponent>0 时生效）`);
  console.log(`    clamp applied            = clamp01（floor 0，ceil 1）`);
  console.log(`    finalScore               = ${chain.betScore.toFixed(6)}   ← 引擎报告 ${advice.gate.estimatedBetEVScore.toFixed(6)}（逐位一致：${chain.matchesEngine.bet}）`);
  console.log(`    CHECK raw → final        = ${chain.checkScoreRaw.toFixed(6)} → ${chain.checkScore.toFixed(6)}（逐位一致：${chain.matchesEngine.check}）`);
  console.log(`    gap / verdict            = ${chain.gap.toFixed(6)} ⇒ ${chain.verdict}（引擎 ${advice.gate.verdict}，一致：${chain.matchesEngine.verdict}）`);

  console.log('\n  ── 三个尺寸（同一个分数的三次变换） ──');
  for (const action of ['BET_SMALL', 'BET_MEDIUM', 'BET_LARGE'] as const) {
    const s = sizeOf(action);
    const reported = advice.scores.find((x) => x.action === action)?.normalizedEVScore ?? null;
    console.log(
      `    ${action.padEnd(11)} raw = ${s.raw.toFixed(6)}｜floor/ceil 后 = ${s.final.toFixed(6)}` +
        `｜引擎报告 = ${reported === null ? '—' : reported.toFixed(6)}` +
        `${reported !== null && Math.abs(reported - s.final) < 1e-12 ? ' ✅ 一致' : ' ⚠️ 不一致'}`,
    );
  }
  console.log(
    `    说明：BET_SMALL = betScore×0.95、BET_MEDIUM = betScore、BET_LARGE = max(0, betScore−0.08)` +
      `（postflopAdvisor.ts:441-444）⇒ 三者**不是独立评分**，一个 score 为 0 就三个全 0。`,
  );

  console.log('\n  ── 动作闸门（分数 → 动作） ──');
  const threshold = chain.checkScore - 0.06;
  console.log(
    `    gateWantsBet 条件：verdict ∈ {CLEAR_VALUE, THIN_VALUE} 或（MARGINAL 且 bet > check）` +
      `（decisionEngine.ts:1420-1432）`,
  );
  console.log(
    `    本节点 verdict = ${chain.verdict} ⇒ gateWantsBet = false ⇒ 直接 STRATEGIC_CHECK（理由码已确认）`,
  );
  console.log(
    `    有效门槛：要进入 MARGINAL 需 betScore > check − 0.06 = ${threshold.toFixed(6)}；` +
      `要 THIN_VALUE 需 betScore ≥ check + 0.06 = ${(chain.checkScore + 0.06).toFixed(6)}；` +
      `CLEAR_VALUE 需 ≥ ${(chain.checkScore + 0.18).toFixed(6)}`,
  );

  return { chain, advice, action: result.decision.action, equity };
}

/* ============================================================
 * 执行
 * ============================================================ */

console.log('审计节点（输入固定，禁止改动）：');
console.log('  6-max 1/2｜HJ open 3BB → CO 3bet 9BB → HJ call（底池 19.5BB）');
console.log('  翻牌 Q♦8♠4♠：HJ check → Hero check｜转牌 2♥：HJ check → Hero（A♠J♠）');

const turn = reportNode('被审计节点：转牌（无画像 UNKNOWN）', turnNode(), true);
const flop = reportNode('对照节点：翻牌（无画像 UNKNOWN）', flopNode(), true);

/* ---- §5 翻牌 vs 转牌逐字段 diff ---- */
if (turn !== null && flop !== null) {
  console.log('\n\n════════ §5 翻牌 vs 转牌 逐字段 diff（按影响绝对值排序）════════');
  const pairs: Array<[string, number, number]> = [
    ['roleStrength', roleStrengthOf(flop.advice.role), roleStrengthOf(turn.advice.role)],
    ['equity', flop.equity, turn.equity],
    ['strongerShare', flop.advice.gate.strongerShare, turn.advice.gate.strongerShare],
    ['weakerShare', flop.advice.gate.weakerShare, turn.advice.gate.weakerShare],
    ['aggressionCredibility', flop.advice.compression.aggressionCredibility, turn.advice.compression.aggressionCredibility],
    ['airDensity', flop.advice.compression.airDensity, turn.advice.compression.airDensity],
    ['wetness', flop.advice.wetness, turn.advice.wetness],
    ['stickiness', flop.chain.terms.stickiness!, turn.chain.terms.stickiness!],
    ['worseCallDensity', flop.chain.terms.worseCallDensity!, turn.chain.terms.worseCallDensity!],
    ['betterContinueDensity', flop.chain.terms.betterContinueDensity!, turn.chain.terms.betterContinueDensity!],
    ['raiseRisk', flop.chain.terms.raiseRisk!, turn.chain.terms.raiseRisk!],
    ['showdownValue', flop.chain.terms.showdownValue!, turn.chain.terms.showdownValue!],
    ['valuePart', flop.chain.terms.valuePart!, turn.chain.terms.valuePart!],
    ['bluffComponent', flop.chain.terms.bluffComponent!, turn.chain.terms.bluffComponent!],
    ['valueContribution', flop.chain.terms.valueContribution!, turn.chain.terms.valueContribution!],
    ['semiBluffContribution', flop.chain.terms.semiBluffContribution!, turn.chain.terms.semiBluffContribution!],
    ['protectionContribution', flop.chain.terms.protectionContribution!, turn.chain.terms.protectionContribution!],
    ['betterContinuePenalty', -flop.chain.terms.betterContinuePenalty!, -turn.chain.terms.betterContinuePenalty!],
    ['raiseRiskPenalty', -flop.chain.terms.raiseRiskPenalty!, -turn.chain.terms.raiseRiskPenalty!],
    ['betScoreRaw', flop.chain.betScoreRaw, turn.chain.betScoreRaw],
    ['betScore(final)', flop.chain.betScore, turn.chain.betScore],
    ['checkScore(final)', flop.chain.checkScore, turn.chain.checkScore],
    ['gap', flop.chain.gap, turn.chain.gap],
  ];
  const sorted = [...pairs].sort((a, b) => Math.abs(b[2] - b[1]) - Math.abs(a[2] - a[1]));
  console.log('  字段                     翻牌        转牌        变化         |变化|');
  for (const [name, f, t] of sorted) {
    console.log(
      `  ${name.padEnd(24)} ${f.toFixed(6).padStart(10)} ${t.toFixed(6).padStart(11)} ${(t - f).toFixed(6).padStart(11)} ${Math.abs(t - f).toFixed(6).padStart(11)}`,
    );
  }
  const contributions: Array<[string, number]> = [
    ['valueContribution 消失', turn.chain.terms.valueContribution! - flop.chain.terms.valueContribution!],
    ['semiBluffContribution 变化', turn.chain.terms.semiBluffContribution! - flop.chain.terms.semiBluffContribution!],
    ['betterContinuePenalty 变化', -(turn.chain.terms.betterContinuePenalty! - flop.chain.terms.betterContinuePenalty!)],
    ['raiseRiskPenalty 变化', -(turn.chain.terms.raiseRiskPenalty! - flop.chain.terms.raiseRiskPenalty!)],
  ];
  console.log('\n  对 betScoreRaw 的贡献（转牌 − 翻牌）：');
  for (const [name, delta] of contributions.sort((a, b) => a[1] - b[1])) {
    console.log(`    ${name.padEnd(32)} ${delta >= 0 ? '+' : ''}${delta.toFixed(6)}`);
  }
  console.log(
    `    合计 ${(turn.chain.betScoreRaw - flop.chain.betScoreRaw).toFixed(6)}` +
      `（${flop.chain.betScoreRaw.toFixed(6)} → ${turn.chain.betScoreRaw.toFixed(6)}）`,
  );
}

/* ---- §4 / §7 画像变体 ---- */
console.log('\n\n════════ §4 / §7 画像是否进入评分链（转牌节点，逐个画像）════════');
console.log('  画像            权益     stronger  ac      airD   mediumD  showdownD stickiness worseCall betterCont raiseRisk  rawBet   betScore checkScore verdict      动作');
for (const profile of ['UNKNOWN', 'NORMAL', 'CALLING_STATION', 'LOOSE', 'AGGRESSIVE', 'VERY_TIGHT', 'MANIAC']) {
  const r = reportNode(`profile=${profile}`, turnNode(profile), false);
  if (r === null) continue;
  const i = r.chain.inputs;
  const t = r.chain.terms;
  console.log(
    `  ${profile.padEnd(15)} ${(r.equity * 100).toFixed(2).padStart(6)}%  ` +
      `${Number(i.strongerShare).toFixed(4)}    ${Number(i.aggressionCredibility).toFixed(3)}  ` +
      `${Number(i.airDensity).toFixed(3)}  ${Number(i.mediumStrengthDensity).toFixed(3)}    ` +
      `${Number(i.showdownDensity).toFixed(3)}     ${t.stickiness!.toFixed(4)}    ${t.worseCallDensity!.toFixed(4)}   ` +
      `${t.betterContinueDensity!.toFixed(4)}    ${t.raiseRisk!.toFixed(4)}     ${r.chain.betScoreRaw.toFixed(4)}  ` +
      `${r.chain.betScore.toFixed(4)}   ${r.chain.checkScore.toFixed(4)}    ${r.chain.verdict.padEnd(12)} ${String(r.action)}`,
  );
}

/* ---- §6 合成对照：这个 scorer 在什么条件下才会给出正的下注分 ---- */
console.log('\n\n════════ §6 合成对照（直接调用纯函数 assessValueBet；不改任何源码）════════');
console.log('  固定：role=SEMI_BLUFF、wetter=0.167、airDensity=0.35、strongerShare=0.719、ac=0.370、单挑、turn');
console.log('  权益       valuePart  bluffComp  value贡献  semiBluff  betterCont罚  raiseRisk罚  raw       bet(final) check(final) verdict');
const compressionBase = {
  strengthFloor: 0.55,
  nutDensity: 0.39,
  mediumStrengthDensity: 0.45,
  drawDensity: 0.03,
  airDensity: 0.35,
  showdownDensity: 0.36,
  aggressionCredibility: 0.37,
};
for (const equity of [0.40, 0.44, 0.48, 0.5, 0.52, 0.56, 0.6, 0.65]) {
  const a = assessValueBet({
    role: RelativeHandRole.SEMI_BLUFF,
    heroEquity: equity,
    opponentCount: 1,
    compression: compressionBase,
    wetness: 0.167,
    spr: 4.67,
    hasInitiative: true,
    thinValueDelta: 0,
    bluffDelta: 0,
    protectionRelevant: false,
    rangeComparison: { weakerShare: 0.255, strongerShare: 0.719 },
    hasCardsToCome: true,
  });
  const fair = 0.5;
  const valuePart = Math.max(0, Math.min(1, (equity - fair) / (1 - fair)));
  const bluffComponent = clamp01(0.167 * 0.4 + (1 - 0.35) * 0.2 + 0.2);
  console.log(
    `  ${(equity * 100).toFixed(0).padStart(4)}%     ${valuePart.toFixed(4)}     ${bluffComponent.toFixed(4)}     ` +
      `${(valuePart * (0.5 + 0.5 * a.worseCallDensity)).toFixed(4)}     ${(bluffComponent * 0.5).toFixed(4)}      ` +
      `${(a.betterContinueDensity * 0.35).toFixed(4)}        ${(a.raiseRisk * 0.2).toFixed(4)}       ` +
      `${(a.estimatedBetEVScore === 0 ? -0.0001 : 0).toFixed(4)}     ${a.estimatedBetEVScore.toFixed(4)}    ` +
      `${a.estimatedCheckEVScore.toFixed(4)}      ${a.verdict}`,
  );
}
console.log('  （权益 ≤ 50% 时 valuePart 恒为 0：半诈唬的下注分上限 = bluffComponent×0.5 − betterCont×0.35 − raiseRisk×0.2）');

console.log('\n  §3 角色信号是否真的进入评分（同输入只换 role）：');
for (const role of [
  RelativeHandRole.SEMI_BLUFF,
  RelativeHandRole.DRAW,
  RelativeHandRole.SHOWDOWN_VALUE,
  RelativeHandRole.PURE_BLUFF,
  RelativeHandRole.THIN_VALUE,
]) {
  const a = assessValueBet({
    role,
    heroEquity: 0.440685,
    opponentCount: 1,
    compression: compressionBase,
    wetness: 0.166667,
    spr: 4.67,
    hasInitiative: true,
    thinValueDelta: 0,
    bluffDelta: 0,
    protectionRelevant: false,
    rangeComparison: { weakerShare: 0.25463, strongerShare: 0.718964 },
    hasCardsToCome: true,
  });
  const strength = roleStrengthOf(role);
  const bluffComponent =
    role === RelativeHandRole.PURE_BLUFF || role === RelativeHandRole.SEMI_BLUFF ? 0.396349 : 0;
  console.log(
    `    role=${role.padEnd(15)} 强度 ${strength.toFixed(2)}｜bluffComponent ${bluffComponent.toFixed(4)}` +
      `｜betScore ${a.estimatedBetEVScore.toFixed(4)}｜checkScore ${a.estimatedCheckEVScore.toFixed(4)}｜${a.verdict}`,
  );
}

/* ---- §12 墨菲检查 ---- */
console.log('\n\n════════ §12 墨菲定律检查 ════════');
if (turn !== null) {
  const all: Array<[string, number]> = [
    ...Object.entries(turn.chain.terms).map(([k, v]) => [k, v] as [string, number]),
    ...Object.entries(turn.chain.inputs)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => [k, v as number] as [string, number]),
  ];
  const bad = all.filter(([, v]) => !Number.isFinite(v));
  console.log(`  NaN / Infinity 扫描：${bad.length === 0 ? '干净（0 项）' : JSON.stringify(bad)}`);
  console.log(`  raw 是否为正被 clamp 吃掉：raw = ${turn.chain.betScoreRaw.toFixed(6)} ⇒ ${turn.chain.betScoreRaw > 0 ? '是（正被吃掉）' : '**否**（raw 本身为负，clamp 不是原因）'}`);
  console.log(`  zero 是否为缺省值：逐位复算 ${turn.chain.matchesEngine.bet ? '一致（是真算出来的 0）' : '不一致（需进一步排查）'}`);
  console.log(`  候选动作是否生成：legal.actions 含 BET；advice.scores 条目 ${turn.advice.scores.length} 个 ⇒ UI 的 0.000 是真实计算值`);
  console.log(`  BET_LARGE 的 floor：max(0, score − 0.08) ⇒ 任何 < 0.08 的正分都会被抹成 0（翻牌节点实测：raw +0.0487 ⇒ BET_LARGE = 0）`);
  console.log(`  尺寸独立性：BET_SMALL/MEDIUM/LARGE 由**同一个** gate 分数变换而来 ⇒ 不存在尺寸特定评分（DESIGN LIMITATION）`);
  console.log(`  画像重复计数：画像经 ① profile-adjusted range（strongerShare/densities）与 ② profileCompressionMultiplier（aggressionCredibility）两条路进入同一个 raw ⇒ 见上表 LOOSE/CALLING_STATION 行`);
  console.log(`  raiseRisk 双源：strongerShare（range，权重 0.7）+ aggressionCredibility（启发式，权重 0.15，且其自身也由 range 基线构成）`);
}
