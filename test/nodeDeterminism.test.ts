/**
 * NODE DETERMINISM / ORDER DEPENDENCY AUDIT —— 确定性回归测试（§十 D1–D5）
 *
 * ## 这一组测试守的是什么
 *
 * 症状（历史）：同一逻辑节点在**隔离运行**与**文件内运行**下给出不同结果
 * （实测 19.20% vs 40.88%）。无论历史成因为何，这里锁住的是**不变量本身**：
 *
 * ```text
 * 相同输入 + 相同模型版本 + 相同 seed  ⇒  相同输出
 * ```
 *
 * 而且必须证明：**前一手牌、前一个测试、前一个人物画像不会偷偷改变下一手牌的
 * 决策状态。**
 *
 * ## 🔴 断言纪律
 *
 * - 断言的是**逐位一致性**（canonical snapshot 相等），**不是**某个具体百分比。
 *   **禁止**为了让数字"对上"而把 nodeB 的期望值写死 —— 那样只会掩盖非确定性。
 * - 快照包含**可审计中间量**（权益 / 所需权益 / Call EV / 可争夺量 / 动作 / 边际 /
 *   更强占比 / 可达组合数 / 更新日志长度），不只最终百分比（§二）。
 * - ⚠️ 若某条变红：说明**存在顺序依赖或隐藏共享状态**。正确处理是找到并消除它
 *   （immutability / factory / deep freeze / pure function），
 *   **不是**放宽容差（§十一：19.20% vs 40.88% 不是浮点尾差）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput, QuickProfile } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const F = (position: string) => ({ position, type: 'FOLD' });

/* ------------------------------------------------------------------
 * 夹具（与 profileRangeAdjustment 的 nodeA / nodeB 同源；
 * 这里是**独立构造**，不共享任何对象引用 —— 见 §四.2 fixture mutation）
 * ------------------------------------------------------------------ */

function nodeA(profile: QuickProfile): ManualHandInput {
  return {
    tableSize: 6, heroPosition: 'BTN', heroCards: ['Ah', 'Qc'],
    board: ['Qs', '8d', '3c', '6s', 'Ks'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 },
    actionHistory: [
      F('UTG'), F('HJ'),
      { position: 'CO', type: 'RAISE', amountBB: 2.5 },
      { position: 'BTN', type: 'CALL', amountBB: 2.5 },
      F('SB'), F('BB'),
      { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
      { position: 'BTN', type: 'CALL', amountBB: 2, street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 7, street: 'TURN' },
      { position: 'BTN', type: 'CALL', amountBB: 7, street: 'TURN' },
      { position: 'CO', type: 'BET', amountBB: 20, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

function nodeB(profile: QuickProfile): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'BB', heroCards: ['Ah', '9h'],
    board: ['Kc', '9s', '5d', '2h', '7c'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: { UTG: 100, CO: 100, BTN: 100, BB: 100 },
    actionHistory: [
      F('UTG'), F('UTG1'), F('UTG2'), F('LJ'), F('HJ'), F('CO'),
      { position: 'BTN', type: 'RAISE', amountBB: 3 },
      F('SB'),
      { position: 'BB', type: 'CALL', amountBB: 2 },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'BTN', type: 'BET', amountBB: 1.5, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 1.5, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'BTN', type: 'CHECK', street: 'TURN' },
      { position: 'BB', type: 'CHECK', street: 'RIVER' },
      { position: 'BTN', type: 'BET', amountBB: 3, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

/** 03A/03B 黄金手（§十七 规格） */
function golden(profile: QuickProfile): ManualHandInput {
  return {
    tableSize: 9, heroPosition: 'CO', heroCards: ['Ac', 'Jh'],
    board: ['Ad', '8s', '4s', '2c', 'Kd'], street: 'RIVER',
    effectiveStackBB: 100, bigBlindBB: 2,
    seatStacksBB: {
      UTG: 100, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
      CO: 100, BTN: 100, SB: 100, BB: 100,
    },
    actionHistory: [
      F('UTG'), F('UTG1'), F('UTG2'), F('LJ'), F('HJ'),
      { position: 'CO', type: 'RAISE', amountBB: 2.5 },
      F('BTN'), F('SB'),
      { position: 'BB', type: 'CALL', amountBB: 1.5 },
      { position: 'BB', type: 'CHECK', street: 'FLOP' },
      { position: 'CO', type: 'BET', amountBB: 2, street: 'FLOP' },
      { position: 'BB', type: 'CALL', amountBB: 2, street: 'FLOP' },
      { position: 'BB', type: 'CHECK', street: 'TURN' },
      { position: 'CO', type: 'CHECK', street: 'TURN' },
      { position: 'BB', type: 'BET', amountBB: 7, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: profile, dynamicHint: 'UNKNOWN', stackBB: 100 },
  } as unknown as ManualHandInput;
}

/* ------------------------------------------------------------------
 * canonical snapshot：**可审计中间量**，不只最终百分比
 * ------------------------------------------------------------------ */

type Snap = {
  equity: number;
  required: number;
  callEV: number;
  winnable: number;
  action: string;
  margin: string | null;
  strongerShare: number | null;
  rangeSupport: number | null;
  traceLen: number;
};

function snap(mk: (p: QuickProfile) => ManualHandInput, profile: QuickProfile): Snap {
  const r = analyzeManualHand(mk(profile), OPTIONS);
  assert.equal(r.ok, true, `夹具必须可分析：${r.ok ? '' : JSON.stringify(r.issues)}`);
  if (!r.ok) throw new Error('unreachable');
  const m = r.decision.diagnostics.math;

  const parsed = parseManualInput(mk(profile));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true);
  if (!gate.ok) throw new Error('unreachable');
  const built = buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000, quickProfile: profile,
  });
  const facts = built.context.postflopFacts?.opponentRangeFacts as unknown as
    | { strongerShare?: number; supportSize?: number }
    | undefined;

  return {
    equity: m.heroEquity ?? Number.NaN,
    required: m.requiredEquity,
    callEV: m.callEV ?? Number.NaN,
    winnable: m.winnable,
    action: String(r.decision.action),
    margin: r.decision.diagnostics.decisionMargin?.kind ?? null,
    strongerShare: facts?.strongerShare ?? null,
    rangeSupport: facts?.supportSize ?? null,
    traceLen: built.context.range?.updateTrace.length ?? 0,
  };
}

/** 逐位比较（含 NaN 语义：两个 NaN 视为相同） */
const same = (a: Snap, b: Snap): boolean =>
  Object.keys(a).every((k) => {
    const x = (a as Record<string, unknown>)[k];
    const y = (b as Record<string, unknown>)[k];
    return typeof x === 'number' && typeof y === 'number' && Number.isNaN(x) && Number.isNaN(y)
      ? true
      : x === y;
  });

const show = (s: Snap): string =>
  `equity=${((s.equity ?? 0) * 100).toFixed(4)}% callEV=${s.callEV.toFixed(4)} ` +
  `action=${s.action} margin=${String(s.margin)} stronger=${((s.strongerShare ?? 0) * 100).toFixed(4)}% ` +
  `support=${String(s.rangeSupport)} trace=${s.traceLen}`;

/** 上下文构造（不含分析）——用于「只造上下文」的顺序测试 */
function contextOnly(mk: (p: QuickProfile) => ManualHandInput, profile: QuickProfile): void {
  const parsed = parseManualInput(mk(profile));
  if (!parsed.ok) throw new Error('parse');
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) throw new Error('gate');
  buildDecisionContext({
    state: gate.state, rules: RULES, environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000, quickProfile: profile,
  });
}

/** 会走**类别模型**的画像（有先验）—— 这些路径最可能藏着 key 不完整的缓存 */
const INFORMATIVE = ['VERY_TIGHT', 'UNDERBLUFFER', 'LOOSE', 'BLUFF_HEAVY', 'MANIAC'] as const;

/* ============================================================
 * D1：同一输入连续 20 次必须逐位一致
 * ============================================================ */

test('D1：nodeB 同一输入连续 20 次必须逐位一致（含类别模型路径）', () => {
  /*
   * 审计仪器：把 nodeB 的 canonical 快照**打印出来**，以便在三种执行模式下
   * （单独 / 本文件 / 完整套件）比对同一个数字。这是裁决要求的
   * NODE_B_ISOLATED / NODE_B_FILE_RUN / NODE_B_FULL_SUITE 三个值的来源。
   */
  console.log(`[determinism] NODE_B_CANONICAL ${show(snap(nodeB, 'NORMAL'))}`);

  for (const profile of ['NORMAL', 'MANIAC'] as const) {
    const first = snap(nodeB, profile);
    const runs = Array.from({ length: 20 }, () => snap(nodeB, profile));
    for (const [i, s] of runs.entries()) {
      assert.ok(same(first, s), `第 ${i + 2} 次与第 1 次不一致\n  1: ${show(first)}\n  ${i + 2}: ${show(s)}`);
    }
  }
});

/* ============================================================
 * D2：nodeA → nodeB 必须与单独 nodeB 相同
 * ============================================================ */

test('D2：先跑 nodeA（含全部有先验原型）不得改变 nodeB', () => {
  for (const target of ['NORMAL', 'MANIAC'] as const) {
    const baseline = snap(nodeB, target);
    for (const p of INFORMATIVE) {
      snap(nodeA, p);
      contextOnly(nodeA, p);
    }
    const after = snap(nodeB, target);
    assert.ok(
      same(baseline, after),
      `nodeA 污染了 nodeB(${target})\n  before: ${show(baseline)}\n  after : ${show(after)}`,
    );
  }
});

/* ============================================================
 * D3：03A → 03B → nodeB 结果不变
 * ============================================================ */

test('D3：03A→03B（黄金手）不得改变 nodeB', () => {
  const baseline = snap(nodeB, 'NORMAL');
  snap(golden, 'CALLING_STATION');
  snap(golden, 'MANIAC');
  contextOnly(golden, 'CALLING_STATION');
  const after = snap(nodeB, 'NORMAL');
  assert.ok(same(baseline, after), `03A/03B 污染了 nodeB\n  before: ${show(baseline)}\n  after : ${show(after)}`);
});

/* ============================================================
 * D4：反向顺序 —— nodeB → nodeA → nodeB，基线不变
 * ============================================================ */

test('D4：反向顺序（nodeB→nodeA→nodeB）基线不变', () => {
  const baseline = snap(nodeB, 'NORMAL');
  snap(nodeA, 'MANIAC');
  snap(nodeB, 'MANIAC');
  const after = snap(nodeB, 'NORMAL');
  assert.ok(same(baseline, after), `反向顺序改变了 nodeB\n  before: ${show(baseline)}\n  after : ${show(after)}`);
});

/* ============================================================
 * D5：固定 permutation 打乱执行顺序，结果必须一致
 * ============================================================ */

test('D5：固定 permutation 打乱顺序后 nodeB 仍逐位一致', () => {
  type Step = () => void;
  const steps: Record<string, Step> = {
    A: () => void snap(nodeA, 'MANIAC'),
    B: () => void snap(nodeB, 'NORMAL'),
    G: () => void snap(golden, 'MANIAC'),
    U: () => void snap(nodeA, 'UNDERBLUFFER'),
    C: () => contextOnly(nodeB, 'BLUFF_HEAVY'),
    T: () => void snap(golden, 'CALLING_STATION'),
  };
  // 多组**固定**排列（不是随机 —— 随机无法复现失败）
  const permutations: readonly (readonly string[])[] = [
    ['B'],
    ['A', 'B'],
    ['G', 'T', 'B'],
    ['A', 'G', 'U', 'C', 'T', 'B'],
    ['T', 'C', 'U', 'G', 'A', 'B'],
    ['C', 'A', 'T', 'U', 'G', 'B'],
  ];

  const results: Snap[] = [];
  for (const order of permutations) {
    for (const key of order) {
      if (key === 'B') continue; // nodeB 单独在下面取
      steps[key]!();
    }
    results.push(snap(nodeB, 'NORMAL'));
  }

  const first = results[0]!;
  for (const [i, s] of results.entries()) {
    assert.ok(
      same(first, s),
      `排列 #${i + 1}（${permutations[i]!.join('→')}）下 nodeB 与基准不同\n` +
        `  基准: ${show(first)}\n  本次: ${show(s)}`,
    );
  }
});

/* ============================================================
 * 附：模块级可变状态的存在性锁（§四.1）
 * ============================================================
 *
 * 审计发现 `range.ts` 用**模块级计数器**生成 rangeId（进程内单调递增），
 * 并提供 `__resetRangeIdCounter()`（**无任何调用者**）。
 * 只要没有任何判定依赖 rangeId，它就不构成顺序依赖；
 * 这条测试锁住「rangeId 不进任何决策输入」这一事实 —— 一旦有人开始用它做键，
 * 就必须把它变成显式参数（factory/依赖注入），而不是读全局计数器。
 */

test('附：rangeId 计数器不得成为决策输入（同输入两次的决策快照必须一致）', () => {
  const a = snap(nodeB, 'MANIAC');
  const b = snap(nodeB, 'MANIAC');
  assert.ok(
    same(a, b),
    `rangeId 全局计数器似乎进入了决策输入（两次结果不同）\n  ${show(a)}\n  ${show(b)}`,
  );
});
