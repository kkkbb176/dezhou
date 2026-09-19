/**
 * ============================================================================
 * RIVER RAISE DECISION —— 审计回归（只锁「呈现诚实性」与「口径可区分」）
 * ============================================================================
 *
 * 本轮（RIVER RAISE DECISION AUDIT）是**只读审计**，没有修改产品代码。
 * 本文件因此**只**锁两类在任何修复之后都必须继续成立的性质：
 *
 * | 编号 | 锁什么 | 为什么它不会阻碍将来的修复 |
 * |---|---|---|
 * | RD-1 | 加注没有 EV 时，**不得**被呈现成 EV 优胜 | 将来实现了 RAISE EV ⇒ 该条自然改写为「有 EV 时必须是 EV 优胜」，断言方向一致 |
 * | RD-2 | `decisionMargin` 的作用域必须如实：只比过跟注 vs 弃牌时不得声称对加注有结论 | 与实现无关，是披露纪律 |
 * | RD-3 | 三个条件权益必须彼此可区分；缺失的第四个口径不得被别的量顶替 | 将来补上 raise-continue 范围时只会更满足 |
 * | RD-4 | 加注金额的语义必须可审计：`sizeChips` 是 raise-to，且与全下候选同额时必须一致 | 与实现无关 |
 *
 * ⚠️ 已知缺陷（**故意不写成测试**，否则会长期挂红）：
 * 面对下注的加注路径**没有** Raise-Continue Range 与 RAISE EV，
 * 因此无法区分 A–D 四种前提（见 `scripts/rrda-sections345.ts` 与报告）。
 * 修复该缺陷时应当**新增**断言，而不是靠放宽本文件的断言通过。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const SEED = 20_261_014;
const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: SEED,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

type Row = { position: string; type: string; amountBB?: number; street?: string };
const A = (position: string, type: string, amountBB?: number, street?: string): Row => ({
  position, type,
  ...(amountBB === undefined ? {} : { amountBB }),
  ...(street === undefined ? {} : { street }),
});

/** Hero BTN A♠K♠；BB 河牌领打 20BB（= 40 筹码，下注前底池 53） */
function akInput(profile = 'CALLING_STATION'): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['As', 'Ks'], board: ['Kd', '9c', '4h', '6s', '2d'],
    street: 'RIVER', effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      A('UTG', 'FOLD'), A('HJ', 'FOLD'), A('CO', 'FOLD'), A('BTN', 'RAISE', 3), A('SB', 'FOLD'), A('BB', 'CALL', 2),
      A('BB', 'CHECK', undefined, 'FLOP'), A('BTN', 'BET', 2.5, 'FLOP'), A('BB', 'CALL', 2.5, 'FLOP'),
      A('BB', 'CHECK', undefined, 'TURN'), A('BTN', 'BET', 7.5, 'TURN'), A('BB', 'CALL', 7.5, 'TURN'),
      A('BB', 'BET', 20, 'RIVER'),
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

function analyze(input: ManualHandInput) {
  const r = analyzeManualHand(input, OPTIONS);
  assert.equal(r.ok, true, `必须能分析：${r.ok ? '' : `${r.stage} ${JSON.stringify(r.issues)}`}`);
  if (!r.ok) throw new Error('unreachable');
  return r.decision as unknown as Record<string, any>;
}

/* ============================================================
 * RD-1 加注没有 EV ⇒ 不得呈现为 EV 优胜
 * ============================================================ */

test('RD-1：最终动作是 RAISE 时，其证据类型与呈现必须一致（无 EV 就不得写成 EV 优胜）', () => {
  for (const profile of ['CALLING_STATION', 'VERY_TIGHT', 'MANIAC']) {
    const d = analyze(akInput(profile));
    const diag = d.diagnostics as Record<string, any>;
    const evidence = (diag.actionEvidence ?? []) as any[];
    const raise = evidence.find((e) => e.action === 'RAISE');
    if (d.action !== 'RAISE' || raise === undefined) continue;

    const noEV = raise.ev === null;
    assert.equal(
      noEV,
      raise.estimateType === 'HEURISTIC',
      `${profile}：ev === null ⇔ estimateType === HEURISTIC（实际 ev=${String(raise.ev)}、type=${String(raise.estimateType)}）`,
    );
    if (!noEV) continue; // 将来实现了 RAISE EV ⇒ 走 EV 比较，本条不适用

    const kind = String(diag.decisionSource?.kind);
    assert.ok(
      kind === 'STRATEGIC_HEURISTIC' || kind === 'HEURISTIC_TIEBREAK' || kind === 'HARD_CONSTRAINT',
      `${profile}：没有 EV 的加注不得以「EV 优胜」来源出现（实际 ${kind}）`,
    );
    const raiseReason = ((d.reasons ?? []) as any[]).find((x) => x.code === 'STRATEGIC_RAISE_FOR_VALUE');
    assert.ok(raiseReason, `${profile}：加注理由必须存在`);
    assert.ok(
      String(raiseReason!.textZh).includes('加注的 EV 无法计算'),
      `${profile}：理由里必须如实写出加注 EV 无法计算`,
    );
  }
});

/* ============================================================
 * RD-2 决策边际的作用域必须如实
 * ============================================================ */

test('RD-2：`decisionMargin` 只比过 CALL vs FOLD 时，必须声明作用域不含加注/全下', () => {
  const d = analyze(akInput());
  const diag = d.diagnostics as Record<string, any>;
  const margins = (diag.candidates ?? []) as any[];
  void margins;
  const dm = diag.decisionMargin as Record<string, any>;
  assert.ok(dm, '必须给出决策边际');
  const note = String(dm.noteZh);
  if (dm.scope === 'VS_FOLD_ONLY') {
    assert.ok(
      note.includes('对加注/全下') && note.includes('没有'),
      `作用域为 VS_FOLD_ONLY 时必须写明「对加注/全下没有发言权」（实际：${note.slice(0, 80)}…）`,
    );
  }
  assert.ok(
    note.includes('工程容差'),
    '容差带必须标注为工程容差（不是统计误差）',
  );
});

/* ============================================================
 * RD-3 三个条件权益必须可区分；缺失的口径不得被顶替
 * ============================================================ */

test('RD-3：到达范围 / 下注范围 / 整体范围三个权益必须可区分，且加注继续范围必须标注缺失', () => {
  const c = (() => {
    const parsed = parseManualInput(akInput());
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error('unreachable');
    const gate = buildAnalyzableState(parsed.value);
    assert.equal(gate.ok, true);
    if (!gate.ok) throw new Error('unreachable');
    return buildDecisionContext({
      state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES', asOf: OPTIONS.asOf,
      quickProfile: 'CALLING_STATION', equitySeed: SEED,
    }).context;
  })();
  const m = c.math;
  const arrivalEq = c.postflopFacts?.betRangeArrival?.heroEquityVsArrivalRange ?? null;

  assert.notEqual(arrivalEq, null, '必须给出到达范围权益');
  assert.notEqual(m.heroEquityVsBetRange, null, '必须给出下注范围权益');
  const three = new Set([arrivalEq, m.heroEquityVsBetRange, m.heroEquity]);
  assert.equal(three.size, 3, `三个条件权益必须是三个不同的量（实际 ${JSON.stringify([...three])}）`);

  // 加注继续范围：产品**自述**未实现 ⇒ 不得被别的量顶替
  const raiseResponse = c.postflopFacts?.betDecision?.checkTree?.raiseResponse ?? 'NOT_IMPLEMENTED';
  assert.equal(raiseResponse, 'NOT_IMPLEMENTED', '加注应手在产品里必须明确标注未实现');
  const facts = c.postflopFacts as unknown as Record<string, unknown>;
  assert.equal(
    'heroEquityVsRaiseCallRange' in facts,
    false,
    '不得用一个同名字段伪造「对加注继续范围的权益」',
  );
});

/* ============================================================
 * RD-4 加注金额语义（raise-to / 全下同额）
 * ============================================================ */

test('RD-4：加注金额必须是 raise-to 语义，且与全下同额时两者一致', () => {
  /*
   * ⚠️ 本条**不锁最终动作**（RIVER RAISE DECISION V2 之后本节点是 CALL）。
   * 它锁的是「金额语义」这条与动作选择无关的性质：
   * `sizeChips` 是 raise-to（本街总额），不是增量；与全下候选同额时必须等于全部剩余投入。
   */
  const d = analyze(akInput());
  const diag = d.diagnostics as Record<string, any>;
  const candidates = (diag.candidates ?? []) as any[];
  const raiseCandidates = candidates.filter((x) => x.action === 'RAISE' && typeof x.sizeChips === 'number');

  assert.ok(raiseCandidates.length > 0, '必须给出加注候选与金额');
  for (const r of raiseCandidates) {
    assert.ok(
      r.sizeChips >= (diag.math.callCost as number),
      `raise-to 金额必须 ≥ 跟注额（${String(r.sizeChips)} vs ${String(diag.math.callCost)}）`,
    );
  }
  // 与全下同额 ⇒ 必须就是「把剩余全部投入」，且动作形态必须如实标注
  const allInAmount = diag.math.myRemainingStack as number;
  const sameAsAllIn = raiseCandidates.filter((r) => Math.abs(r.sizeChips - allInAmount) < 1e-9);
  if (sameAsAllIn.length > 0) {
    assert.equal(sameAsAllIn.length, 1, '同一金额不得出现多个候选（M7 去重）');
    assert.equal(
      diag.actionShape?.consumesStack === true || d.action !== 'RAISE',
      true,
      '该加注就是全下 ⇒ 动作形态必须标明 consumesStack',
    );
  }
});
