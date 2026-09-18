/**
 * 🔴 **动作证据优先级与覆盖权限**（PREFLOP EVIDENCE PRIORITY FIX · T1–T6）
 *
 * 锁定：`CLEAR_CALL` + 已量化 proxy EV 的动作**不得**被 `EV NOT_AVAILABLE` 的
 * 战略启发式覆盖（旧版这里是 `SAFETY_RULE → force 3BET`）；
 * MARGINAL 时允许启发式打断但必须标注来源；硬约束（合法性）仍然最高；
 * 未来 3bet 若有完整 EV 可以自然获胜（**不是**硬编码「永远跟注」）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import {
  DecisionSourceKind,
  EstimateType,
  chooseByEvidencePriority,
  marginOf,
  type ActionEvidence,
} from '../src/domain/decision/evidencePriority.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const SEATS = { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 } as const;

/** 固定节点：6-max 1/2，Hero CO A♠J♠，HJ open 3BB */
function ajNode(profile = 'NORMAL'): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'CO',
    heroCards: ['As', 'Js'],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' },
      { position: 'HJ', type: 'RAISE', amountBB: 3 },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

const band = 0.75;
const callEvidence = (ev: number, type: EstimateType = EstimateType.PROXY_EV): ActionEvidence => ({
  action: 'CALL',
  estimateType: type,
  ev,
  decisionMargin: marginOf(ev, band),
  heuristicScore: 0,
  confidence: 0.95,
  assumptionsZh: ['测试构造'],
  upgradeNoteZh: null,
});
const foldEvidence = (): ActionEvidence => ({
  action: 'FOLD',
  estimateType: EstimateType.EXACT,
  ev: 0,
  decisionMargin: marginOf(0, band),
  heuristicScore: 0,
  confidence: 1,
  assumptionsZh: ['弃牌 EV ≡ 0'],
  upgradeNoteZh: null,
});
const heuristicRaise = (score: number, ev: number | null = null): ActionEvidence => ({
  action: 'RAISE',
  estimateType: ev === null ? EstimateType.HEURISTIC : EstimateType.MODEL_EV,
  ev,
  decisionMargin: ev === null ? null : marginOf(ev, band),
  heuristicScore: score,
  confidence: 0.5,
  assumptionsZh: ['战略启发式'],
  upgradeNoteZh: '若建立 3bet EV 模型可升级为 MODEL_EV',
});

/* ============================================================
 * T1：固定 A♠J♠ 节点必须 CALL，且来源不是 SAFETY_RULE
 * ============================================================ */

test('T1：固定节点 —— CLEAR_CALL + PROXY_EV 不得被 EV 不可得的三下注覆盖', () => {
  const r = analyzeManualHand(ajNode(), OPTIONS);
  assert.equal(r.ok, true, `必须能分析：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) return;

  const d = r.decision;
  assert.equal(d.action, 'CALL', `最终动作必须是 CALL，实际 ${String(d.action)}`);
  assert.notEqual(d.diagnostics.decisionBasis?.kind, 'SAFETY_RULE', '主动作来源不得是 SAFETY_RULE');

  const ds = d.diagnostics.decisionSource as Readonly<Record<string, unknown>> | null;
  assert.ok(ds !== null, '必须输出 decisionSource');
  assert.equal(ds!['kind'], DecisionSourceKind.SUPPORTED_ACTION_PRIORITY);
  assert.equal(ds!['canOverrideEvidence'], false, '受支持动作不允许被低质量证据覆盖');
  assert.equal(ds!['overrideAttempt'], 'RAISE_HEURISTIC', '被阻断的覆盖尝试必须可见');
  assert.equal(ds!['overrideBlockedReason'], 'CANNOT_OVERRIDE_CLEAR_SUPPORTED_CALL');
  assert.equal(ds!['evidenceScope'], 'CALL_PROXY_ONLY', '证据范围必须标成「只有 CALL 的代理 EV」');

  // CALL 的证据已量化且边际清晰；三下注只有启发式
  const evidence = (d.diagnostics.actionEvidence ?? []) as readonly Readonly<Record<string, unknown>>[];
  const call = evidence.find((e) => e['action'] === 'CALL');
  const raise = evidence.find((e) => e['action'] === 'RAISE');
  assert.equal(call?.['estimateType'], 'PROXY_EV');
  assert.equal(call?.['decisionMargin'], 'CLEAR_CALL_OVER_FOLD');
  assert.ok((call?.['ev'] as number) > 0, 'CALL 的 proxy EV 必须为正');
  assert.equal(raise?.['estimateType'], 'HEURISTIC');
  assert.equal(raise?.['ev'], null, 'RAISE 的 EV 必须如实为 null（UNKNOWN ≠ 0）');

  // 三下注仍是合法候选（保留混合策略信息）
  const alternatives = (d.diagnostics.alternativeActions ?? []) as readonly Readonly<Record<string, unknown>>[];
  assert.ok(
    alternatives.some((a) => a['action'] === 'RAISE'),
    'RAISE 必须保留在备选动作里，不得被删除',
  );
  assert.equal(d.diagnostics.primaryAction, 'CALL');
});

/* ============================================================
 * T2：启发式不得覆盖清晰 CALL
 * ============================================================ */

test('T2：CALL proxy 明显为正 + RAISE 启发式极高但 EV 不可得 ⇒ 仍必须 CALL', () => {
  const decision = chooseByEvidencePriority({
    candidates: [foldEvidence(), callEvidence(5), heuristicRaise(1)],
  });
  assert.equal(decision.action, 'CALL');
  assert.equal(decision.source, DecisionSourceKind.SUPPORTED_ACTION_PRIORITY);
  assert.equal(decision.canOverrideEvidence, false);
  assert.equal(decision.overrideBlockedReason, 'CANNOT_OVERRIDE_CLEAR_SUPPORTED_CALL');
});

/* ============================================================
 * T3：MARGINAL 时允许启发式打断，但必须标注来源
 * ============================================================ */

test('T3：量化证据只到 MARGINAL 时，允许启发式打断且来源标成 HEURISTIC_TIEBREAK', () => {
  const decision = chooseByEvidencePriority({
    candidates: [foldEvidence(), callEvidence(0.3), heuristicRaise(0.9)],
  });
  assert.equal(decision.action, 'RAISE');
  assert.equal(decision.source, DecisionSourceKind.HEURISTIC_TIEBREAK);
  assert.notEqual(decision.source, DecisionSourceKind.SUPPORTED_ACTION_PRIORITY);
  assert.ok(
    decision.reasonZh.some((t) => t.includes('HEURISTIC_TIEBREAK')),
    '必须如实说明这是启发式打断，不是 EV 优胜',
  );
});

/* ============================================================
 * T4：硬约束可以覆盖
 * ============================================================ */

test('T4：CALL 证据清晰但不合法 ⇒ 硬约束覆盖（来源 HARD_CONSTRAINT）', () => {
  const decision = chooseByEvidencePriority({
    candidates: [foldEvidence(), heuristicRaise(0.9)],
    hardConstraint: { action: 'RAISE', reasonZh: 'CALL 候选不存在（不合法）' },
  });
  assert.equal(decision.action, 'RAISE');
  assert.equal(decision.source, DecisionSourceKind.HARD_CONSTRAINT);
  assert.equal(decision.canOverrideEvidence, true);
});

/* ============================================================
 * T5：完整 3bet EV 以后必须能自然超过 CALL（证明不是硬编码）
 * ============================================================ */

test('T5：若 RAISE 有 MODEL_EV 且高于 CALL ⇒ 必须选 RAISE（CLEAR_CALL 不是永久跟注）', () => {
  const decision = chooseByEvidencePriority({
    candidates: [foldEvidence(), callEvidence(2), heuristicRaise(1, 5)],
  });
  assert.equal(decision.action, 'RAISE', '完整 EV 更高时必须选 RAISE');
  assert.equal(decision.source, DecisionSourceKind.SUPPORTED_ACTION_PRIORITY);
  assert.equal(decision.estimateType, EstimateType.MODEL_EV);
});

/* ============================================================
 * T6：完全没有证据 ⇒ FALLBACK
 * ============================================================ */

test('T6：所有候选都没有可用证据 ⇒ FALLBACK（且如实标注）', () => {
  const unknown = (action: string): ActionEvidence => ({
    action,
    estimateType: EstimateType.UNKNOWN,
    ev: null,
    decisionMargin: null,
    heuristicScore: 0,
    confidence: 0,
    assumptionsZh: ['数据不足'],
    upgradeNoteZh: null,
  });
  const decision = chooseByEvidencePriority({
    candidates: [unknown('CALL'), unknown('RAISE'), foldEvidence()],
  });
  // FOLD 带 EXACT EV≡0 ⇒ 那仍是量化证据；这里单独验证「全部 UNKNOWN」的情形
  const allUnknown = chooseByEvidencePriority({
    candidates: [unknown('CALL'), unknown('RAISE'), unknown('FOLD')],
  });
  assert.equal(allUnknown.source, DecisionSourceKind.FALLBACK);
  assert.equal(allUnknown.evidenceScope, 'NONE');
  assert.ok(allUnknown.reasonZh.some((t) => t.includes('FALLBACK')));
  // 有 EXACT 的弃牌证据时不得走 FALLBACK（不能因为有证据就兜底）
  assert.equal(decision.source, DecisionSourceKind.SUPPORTED_ACTION_PRIORITY);
});

/* ============================================================
 * T7（§17/§19.8）：解释层与来源必须一致 —— 战略加注不得再叫 SAFETY_RULE
 * ============================================================ */

test('T7：动作是加注时，决策依据必须等于声明的来源，且不得是 SAFETY_RULE', () => {
  /*
   * 为什么需要这条：M6 变异（让 `decisionBasisOf` 忽略 `evidenceSource`、
   * 一律返回 SAFETY_RULE）**不会**被「独立反推再比对」的测试抓到 ——
   * 因为两侧调用的是同一个被改坏的函数。因此必须**直接比较两个字段**：
   * `decisionSource.kind`（真实来源） vs `decisionBasisKind`（对外解释）。
   */
  const aa = {
    tableSize: 6,
    heroPosition: 'CO',
    heroCards: ['Ah', 'Ad'],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: 100,
    bigBlindBB: 2,
    seatStacksBB: { ...SEATS },
    actionHistory: [
      { position: 'UTG', type: 'FOLD' },
      { position: 'HJ', type: 'FOLD' },
      { position: 'CO', type: 'RAISE', amountBB: 3 },
      { position: 'BTN', type: 'FOLD' },
      { position: 'SB', type: 'FOLD' },
      { position: 'BB', type: 'RAISE', amountBB: 10 },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
  const r = analyzeManualHand(aa, OPTIONS);
  assert.equal(r.ok, true, `必须能分析：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) return;
  assert.equal(r.decision.action, 'RAISE', 'AA 面对 3bet 必须加注（价值加注必须仍然可达）');

  const ds = r.decision.diagnostics.decisionSource as Readonly<Record<string, unknown>> | null;
  assert.ok(ds !== null, '加注必须声明动作来源');
  assert.notEqual(ds!['kind'], 'HARD_CONSTRAINT', '这不是合法性约束，不得声称硬约束');
  assert.equal(
    r.decision.diagnostics.decisionBasis?.kind,
    ds!['kind'],
    '决策依据必须与真实来源一致（解释层不得与行为层不同来源）',
  );
  assert.notEqual(
    r.decision.diagnostics.decisionBasis?.kind,
    'SAFETY_RULE',
    '战略加注不得再叫 SAFETY_RULE（§17：Safety 只留给合法性/输入保护）',
  );
});


/* ============================================================
 * 墨菲检查（廉价但关键的四条）
 * ============================================================ */

test('墨菲：UNKNOWN EV 不得被当成 0 而输给 +2.73；proxy EV 不得伪装成 EXACT', () => {
  // ① UNKNOWN 不参与比较：即使 CALL 只有 +0.1（MARGINAL），也不因「看起来更大」而自动胜出
  const decision = chooseByEvidencePriority({
    candidates: [callEvidence(0.1), heuristicRaise(0.8)],
  });
  assert.equal(decision.source, DecisionSourceKind.HEURISTIC_TIEBREAK, 'MARGINAL 时才允许打断');
  // ② 全 UNKNOWN + 一个启发式 ⇒ STRATEGIC_HEURISTIC（不是 EV 优胜）
  const strat = chooseByEvidencePriority({ candidates: [heuristicRaise(0.7)] });
  assert.equal(strat.source, DecisionSourceKind.STRATEGIC_HEURISTIC);
  assert.notEqual(strat.source, DecisionSourceKind.SUPPORTED_ACTION_PRIORITY);
  // ③ margin 分类只有一把尺子
  assert.equal(marginOf(1, 0.75), 'CLEAR_CALL_OVER_FOLD');
  assert.equal(marginOf(0.5, 0.75), 'MARGINAL');
  assert.equal(marginOf(-1, 0.75), 'CLEAR_FOLD');
  assert.equal(marginOf(null, 0.75), null);
});
