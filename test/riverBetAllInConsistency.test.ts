/**
 * RIVER DECISION CONSISTENCY · 全下 / 下注动作一致性回归测试
 * ============================================================================
 *
 * 用户报告：河牌 Hero 剩余 55BB、底池 97.5BB、CO 过牌 ⇒「最终建议**下注 55BB**」，
 * 而内部候选表最高 EV 是 **ALL_IN**，一致性检查报
 * `DECISION_CONSISTENCY_ERROR` / `ACTION_CONTRADICTS_PREFERENCE`。
 *
 * 复现（本文件 §1–§4 的装置，`scripts/audit-river-decision-consistency-v1.ts` 同一输入）：
 * `action = 'BET'`、`actionShape = { kind:'BET', sizeChips:2750, allInToAmount:2750, consumesStack:true }`、
 * `betDecision.bestSize = 'ALL_IN'` ⇒ 校验把「同一实际动作」按**名字**比较（`BET` vs `ALL_IN`）⇒ 误报。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { validateDecisionConsistency } from '../src/domain/decision/decisionConsistency.ts';
import { toDecisionViewModel } from '../src/viewmodels/decisionViewModel.ts';
import { createTable } from '../src/app/table/tableState.ts';
import { applyTableOp, engineViewOf } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';
import type { Position } from '../src/domain/types.ts';

const OPTIONS = {
  rules: loadKnowledgeBaseOrThrow().allRules(),
  asOf: 1_757_000_000_000,
  writeLog: false,
  equitySeed: 20_260_913,
  budget: { softMs: 120_000, hardMs: 240_000 },
} as const;

/** 1BB = 50 筹码（沿用既有探针口径） */
const BB = 50;
/** 前三条街双方各投入 48BB ⇒ 底池 97.5BB；起始 103BB ⇒ 河牌双方各剩 55BB */
const INVESTED = 48;
const makeInput = (startStackBB: number): Record<string, unknown> => ({
  tableSize: 9,
  heroPosition: 'BTN',
  heroCards: ['As', 'Ks'],
  board: ['Jh', '8s', 'Qs', 'Kh', 'Kd'],
  street: 'RIVER',
  effectiveStackBB: startStackBB - INVESTED,
  bigBlindBB: BB,
  seatStacksBB: {
    UTG: startStackBB, UTG1: 100, UTG2: 100, LJ: 100, HJ: 100,
    CO: startStackBB, BTN: startStackBB, SB: 100, BB: 100,
  },
  actionHistory: [
    { position: 'UTG', type: 'FOLD' }, { position: 'UTG1', type: 'FOLD' }, { position: 'UTG2', type: 'FOLD' },
    { position: 'LJ', type: 'FOLD' }, { position: 'HJ', type: 'FOLD' },
    { position: 'CO', type: 'CALL', amountBB: 1 }, { position: 'BTN', type: 'RAISE', amountBB: 3 },
    { position: 'SB', type: 'FOLD' }, { position: 'BB', type: 'FOLD' }, { position: 'CO', type: 'CALL', amountBB: 2 },
    { position: 'CO', type: 'CHECK', street: 'FLOP' }, { position: 'BTN', type: 'BET', amountBB: 10, street: 'FLOP' },
    { position: 'CO', type: 'CALL', amountBB: 10, street: 'FLOP' },
    { position: 'CO', type: 'CHECK', street: 'TURN' }, { position: 'BTN', type: 'BET', amountBB: 35, street: 'TURN' },
    { position: 'CO', type: 'CALL', amountBB: 35, street: 'TURN' },
    { position: 'CO', type: 'CHECK', street: 'RIVER' },
  ],
  environment: 'MID_LOW_STAKES',
  villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN', stackBB: startStackBB - INVESTED },
});

type Diag = Record<string, any>;

function run(startStackBB = 103): { decision: Diag; diag: Diag; vm: ReturnType<typeof toDecisionViewModel> } {
  const result = analyzeManualHand(makeInput(startStackBB) as never, OPTIONS);
  assert.equal(result.ok, true, `牌局必须可分析（实际 ${result.ok ? '' : result.stage}）`);
  if (!result.ok) throw new Error('unreachable');
  const decision = result.decision as unknown as Diag;
  return {
    decision,
    diag: decision['diagnostics'] as Diag,
    vm: toDecisionViewModel(result.decision),
  };
}

const violationsOf = (diag: Diag): readonly Diag[] => (diag['consistency']?.['violations'] ?? []) as readonly Diag[];

/* ============================================================
 * §1 Hero 剩余 55BB，建议下注 55BB ⇒ 实际动作语义必须与全下一致
 * ============================================================ */

test('§1 河牌 55BB 剩余、下注额 = 全部剩余筹码 ⇒ 动作形态必须被识别为「本注即全下」', () => {
  const { decision, diag, vm } = run();
  const shape = diag['actionShape'] as Diag;
  const math = diag['math'] as Diag;

  assert.equal(math['myRemainingStack'], 55 * BB, 'Hero 剩余筹码应为 55BB');
  assert.equal(decision['action'], 'BET', '本次动作是下注（不是加注）');
  assert.equal(shape['allInToAmount'], 2750, '全下金额 = 本街已投入 + 剩余筹码');
  assert.equal(shape['sizeChips'], shape['allInToAmount'], '下注额等于全下金额');
  assert.equal(shape['consumesStack'], true, '这一注必须被标记为消耗全部筹码');

  assert.ok(String(vm.actionZh).includes('全下'), `界面建议文案必须写明全下（实际「${String(vm.actionZh)}」）`);
  assert.ok(
    violationsOf(diag).length === 0,
    `同一实际动作不得被判为自相矛盾（实际 ${JSON.stringify(violationsOf(diag).map((v) => v['code']))}）`,
  );
});

/* ============================================================
 * §2 BET 与 ALL_IN 金额相同、对手响应模型相同 ⇒ 不得产生不同决策结果
 * ============================================================ */

test('§2 金额相同 ⇒ 候选表与最终动作必须指向同一实际动作（同一响应模型、同一 EV 路径）', () => {
  const { decision, diag } = run();
  const bd = diag['betDecision'] as Diag;
  const shape = diag['actionShape'] as Diag;
  const allInSize = (bd['sizes'] as readonly Diag[]).find((s) => s['kind'] === 'ALL_IN');

  assert.notEqual(allInSize, undefined, '候选尺寸表必须含 ALL_IN');
  assert.equal(
    allInSize!['betAmount'],
    shape['sizeChips'],
    '最终下注额必须与 ALL_IN 候选的金额逐个相等（同一实际动作）',
  );
  assert.equal(bd['bestSize'], 'ALL_IN', '本局面最高偏好分尺寸是 ALL_IN（复现前提）');
  assert.equal(
    violationsOf(diag).length,
    0,
    '两者是同一实际动作 ⇒ 不得因命名不同而报一致性错误',
  );
  assert.equal(decision['action'], 'BET', '动作字符串保持 BET（金额口径不变）');
});

/* ============================================================
 * §3 金额不同 ⇒ 保留真实的动作区分
 * ============================================================ */

test('§3 尺寸不同（33% 池 vs 全下）⇒ 必须保留真实区分，绝不能混为一谈', () => {
  const { diag } = run();
  const bd = diag['betDecision'] as Diag;
  const sizes = bd['sizes'] as readonly Diag[];
  const small = sizes.find((s) => s['kind'] === 'BET_SMALL');
  const allIn = sizes.find((s) => s['kind'] === 'ALL_IN');

  assert.notEqual(small, undefined);
  assert.notEqual(allIn, undefined);
  assert.notEqual(small!['betAmount'], allIn!['betAmount'], '小注与全下必须是不同金额');
  assert.equal(small!['betAmount'], 1625, '33% 池 = 1625 筹码');
  assert.notEqual(small!['betEV'], allIn!['betEV'], '不同金额的 EV 必须分别计算（不得复用同一条分支）');
});

/* ============================================================
 * §4 ALL_IN 最高时，最终动作选择与输出必须一致
 * ============================================================ */

test('§4 最高偏好/EV 尺寸是 ALL_IN ⇒ 最终输出必须一致地表达「全下」（不得一边 ALL_IN 一边普通下注）', () => {
  const { diag, vm } = run();
  const bd = diag['betDecision'] as Diag;
  const shape = diag['actionShape'] as Diag;

  assert.equal(bd['bestSize'], 'ALL_IN', '最高分尺寸必须是 ALL_IN（否则本测试前提不成立）');
  const allInSize = (bd['sizes'] as readonly Diag[]).find((s) => s['kind'] === 'ALL_IN')!;
  const small = (bd['sizes'] as readonly Diag[]).find((s) => s['kind'] === 'BET_SMALL')!;
  assert.ok(Number(allInSize['betEV']) > Number(small['betEV']), 'ALL_IN 的 EV 必须高于小注');

  assert.equal(shape['sizeChips'], allInSize['betAmount'], '最终金额 = ALL_IN 候选金额');
  assert.equal(shape['consumesStack'], true);
  assert.ok(String(vm.actionZh).includes('全下'), `界面文案必须与内部一致（实际「${String(vm.actionZh)}」）`);
});

/* ============================================================
 * §5 普通 BET 最高时，不得错误转换为 ALL_IN
 * ============================================================ */

test('§5 未打光筹码的下注不得被提升为全下（深筹码变体）', () => {
  let checked = 0;
  for (const stackBB of [200, 400]) {
    const { diag, vm } = run(stackBB);
    const shape = diag['actionShape'] as Diag;
    const bd = diag['betDecision'] as Diag;
    if (shape['kind'] !== 'BET') continue;
    checked += 1;
    const consumes = shape['sizeChips'] === shape['allInToAmount'];
    assert.equal(
      shape['consumesStack'],
      consumes,
      `consumesStack 必须严格等价于「金额 = 全下金额」（stack=${stackBB}BB：size=${String(shape['sizeChips'])} allIn=${String(shape['allInToAmount'])}）`,
    );
    if (consumes === false) {
      assert.equal(bd['bestSize'] === 'ALL_IN', false, '未打光筹码时最高分尺寸不应是 ALL_IN');
      assert.equal(
        String(vm.actionZh).includes('全下'),
        false,
        `未打光筹码时界面不得写「全下」（实际「${String(vm.actionZh)}」）`,
      );
    }
  }
  assert.ok(checked > 0, '深筹码变体必须至少有一个 BET 形态用于检验（否则本测试无意义）');
});

/* ============================================================
 * §6 动作规范化前后不得改变实际投入、底池与有效筹码
 * ============================================================ */

test('§6 形态识别是纯标注：底池 / 有效筹码 / 本次再投入三项口径必须自洽', () => {
  const { decision, diag } = run();
  const shape = diag['actionShape'] as Diag;
  const math = diag['math'] as Diag;
  const bd = diag['betDecision'] as Diag;

  assert.equal(shape['allInToAmount'], (math['myCommittedThisStreet'] as number) + (math['myRemainingStack'] as number),
    '全下金额恒等于「本街已投入 + 剩余筹码」');
  assert.equal(shape['sizeChips'], math['myRemainingStack'], '打光筹码时下注额 = 剩余筹码（本次新增投入）');
  assert.equal(math['effectiveStack'], math['myRemainingStack'], '有效筹码不得因形态标注而改变');
  assert.equal(bd['pot'], math['pot'], '候选表与决策必须使用同一条底池口径');
  assert.equal((decision['diagnostics'] as Diag)['math']['pot'], 4875, '底池 = 97.5BB × 50 筹码');
  assert.equal(shape['sizeChips'], decision['sizeChips'] ?? shape['sizeChips'], '顶层金额字段（若有）必须与形态金额一致');
});

/* ============================================================
 * §7 一致性校验不得因名称不同而误报真实等价的动作
 * ============================================================ */

test('§7 校验必须按「实际动作语义」比较：BET(全下额) 与 ALL_IN 视为同一家族', () => {
  const { diag } = run();
  const consistency = diag['consistency'] as Diag;
  assert.equal(consistency['ok'], true, `不得误报（实际 ${JSON.stringify(violationsOf(diag))}）`);
  assert.deepEqual([...violationsOf(diag)], [], '违规列表必须为空');

  // 反证：同样的偏好表 + 真正更小的下注额 ⇒ 仍然必须报错（§8 详测）
  const realDivergence = validateDecisionConsistency({
    street: 'RIVER',
    action: 'BET',
    actionable: true,
    legalActions: ['CHECK', 'BET', 'ALL_IN'],
    sizeChips: 1625,
    pot: 4875,
    callCost: 0,
    requiredEquity: 0,
    callEV: null,
    uncertaintyBand: 100,
    allowUncertaintyOverride: false,
    overrodeByUncertainty: false,
    role: null,
    futureCardProtectionScore: 0,
    futureStreetCommitmentBonus: 0,
    preferenceScores: [
      { action: 'CHECK', score: 0.5 },
      { action: 'BET_SMALL', score: 0.596 },
      { action: 'ALL_IN', score: 0.619 },
    ],
    warningsZh: [],
    settlement: null,
  });
  assert.ok(
    realDivergence.some((v) => v.code === 'ACTION_CONTRADICTS_PREFERENCE'),
    '真正小于全下额的下注与「最高分是 ALL_IN」冲突 ⇒ 校验必须保留报错能力',
  );
});

/* ============================================================
 * §8 存在真实冲突时不得通过忽略一致性错误取得通过
 * ============================================================ */

test('§8 真实分歧必须保留报错；等价动作必须消除误报（同一校验函数两种输入）', () => {
  const base = {
    street: 'RIVER' as const,
    action: 'BET',
    actionable: true,
    legalActions: ['CHECK', 'BET', 'ALL_IN'],
    pot: 4875,
    callCost: 0,
    requiredEquity: 0,
    callEV: null,
    uncertaintyBand: 100,
    allowUncertaintyOverride: false,
    overrodeByUncertainty: false,
    role: null,
    futureCardProtectionScore: 0,
    futureStreetCommitmentBonus: 0,
    preferenceScores: [
      { action: 'CHECK', score: 0.5 },
      { action: 'BET_SMALL', score: 0.596 },
      { action: 'ALL_IN', score: 0.619 },
    ],
    warningsZh: [],
    settlement: null,
  };

  const equivalent = validateDecisionConsistency({
    ...base,
    sizeChips: 2750,
    actionEffectiveFamily: 'ALL_IN',
  } as never);
  assert.deepEqual(
    equivalent.map((v) => v.code),
    [],
    '打光筹码的 BET 与偏好表里的 ALL_IN 是同一实际动作 ⇒ 不得报错',
  );

  const conflicting = validateDecisionConsistency({ ...base, sizeChips: 2750 } as never);
  assert.ok(
    conflicting.some((v) => v.code === 'ACTION_CONTRADICTS_PREFERENCE'),
    '未声明实际动作家族时，校验保持原判据（不得把校验整体取消）',
  );
});

/* ============================================================
 * §9 错误状态下前端不得把冲突结果展示为正常推荐
 * ============================================================ */

test('§9 含一致性违规的决策：界面必须显著标注「不要据此行动」并保留调试信息', () => {
  const { decision } = run();
  const cloned = structuredClone(decision);
  const diag = cloned['diagnostics'] as Diag;
  diag['consistency'] = {
    ok: false,
    violations: [
      { code: 'ACTION_CONTRADICTS_PREFERENCE', textZh: '测试注入：动作与偏好分冲突' },
    ],
  };
  const vm = toDecisionViewModel(cloned as never);

  assert.ok(
    String(vm.warningsZh[0]).startsWith('DECISION_CONSISTENCY_ERROR'),
    `一致性错误必须出现在警告列表最前面（实际首条「${String(vm.warningsZh[0])}」）`,
  );
  assert.ok(String(vm.warningsZh[0]).includes('不要据此行动'), '必须显式提示不要据此行动');
  assert.ok(String(vm.warningsZh[0]).includes('ACTION_CONTRADICTS_PREFERENCE'), '必须保留违规代码供排查');
  assert.equal(diag['betDecision'] !== undefined, true, '候选动作与调试信息必须保留（不得为掩盖冲突而清空）');
});

/* ============================================================
 * §10 保留街道状态 / 历史补录 / 未来牌面隔离契约
 * ============================================================ */

test('§10 街道状态一致性 V2 契约未被本次修复影响（先录牌后补录 + 未完成不得声称就绪）', () => {
  const must = (r: ReturnType<typeof applyTableOp>, label: string): PokerTableState => {
    assert.equal(r.ok, true, `${label} 必须被接受`);
    if (!r.ok) throw new Error(label);
    return r.state;
  };
  const step = (s: PokerTableState, op: TableOp): PokerTableState => must(applyTableOp(s, op), op.kind);

  let s = createTable({ tableSize: 9, heroPosition: 'BTN' as Position, defaultStackBB: 100 });
  for (const seat of s.seats) {
    if (seat.playerId === null) s = step(s, { kind: 'ADD_PLAYER', seatId: seat.seatId });
  }
  s = step(s, { kind: 'SET_HERO_CARD', card: 'As' });
  s = step(s, { kind: 'SET_HERO_CARD', card: 'Ks' });
  for (const [i, card] of ['Jh', '8s', 'Qs', 'Kh', 'Kd'].entries()) {
    s = step(s, { kind: 'SET_BOARD_CARD', card, slot: i });
  }
  const view = engineViewOf(s);
  assert.equal(view.ok, true);
  if (!view.ok) return;
  assert.equal(view.engine.street, 'PREFLOP', '只录公共牌不得推进街道（录牌 ≠ 换街）');
  assert.equal(view.engine.board.flop.length + view.engine.board.turn.length + view.engine.board.river.length, 0,
    '未行动前引擎牌面为空（未来牌不得进入引擎状态）');

  const preview = buildTablePreview(s);
  assert.equal(preview.decision.ready, false, '历史不完整时不得声称可分析');
});
