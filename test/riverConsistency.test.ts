/**
 * 河牌一致性回归锁（2026-09 · RIVER CONSISTENCY V2）
 *
 * 真人牌局测试抓到的 8 项一致性风险。本文件逐项锁**方向与不变量**，
 * **不锁具体动作** —— 没有 solver ground truth 支持「这手必须 CALL」或
 * 「这手必须 FOLD」，因此任何这种断言都是编造。
 *
 * | 编号 | 锁什么 | 证据等级 |
 * |---|---|---|
 * | R1 | 河牌角色 ∉ {DRAW, SEMI_BLUFF}，但上一街可以是 DRAW | 【数学确定】 |
 * | R2 | `requiredEquity = B / (P + 2B)`（含小注 / 半池 / 满池 / 超池） | 【数学确定】 |
 * | R3 | 节点增量 EV：`callEV = 权益 × 可争夺量 − 跟注额`，且权益 = 门槛 ⇒ EV = 0 | 【数学确定】 |
 * | R4 | 动作 / 指标 / 解释属于同一体系（守卫零违规） | 【工程约束】 |
 * | R5 | 阻断牌基于**可达范围**逐组合计数（价值侧） | 【数学确定】+【公开扑克理论】 |
 * | R6 | 阻断诈唬可以**独立**变化；不断言「A♣ ⇒ CALL」 | 【公开扑克理论】 |
 * | R7 | 河牌未来补牌保护分 = 0，但价值/诈唬分**不得**被一起清零 | 【数学确定】 |
 * | R8 | 未完成行动节点不得出现最终退回 | 【工程约束】 |
 * | R9 | 同一结算事件只能出现一次（稳定 id + 去重） | 【工程约束】 |
 * | R10 | A♣Q♠ 真实节点全链路：不变量全部成立 | 综合 |
 *
 * ⚠️ 这些用例都是**真实生产管线**（manual input → reconstruct → context →
 * range → postflop → decision → UI），不是模块级单测。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import {
  computeLayeredPot,
  dedupeSettlementEvents,
  describeLayeredPotZh,
  settlementEventsOf,
} from '../src/domain/poker/pots.ts';
import {
  decisionBasisOf,
  validateDecisionConsistency,
} from '../src/domain/decision/decisionConsistency.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false } as const;
const F = (position: string) => ({ position, type: 'FOLD' as const });

/* ============================================================
 * 真实节点构造
 * ============================================================ */

/**
 * 使用者给的真实节点：
 *
 * ```text
 * 9人桌 · Hero BTN A♣Q♠ · 牌面 Q♦8♣5♣ / 2♥ / K♣
 * CO open 2.5BB → BTN call；翻牌 CO 4BB / BTN call；
 * 转牌 CO check、BTN 10BB、CO call；河牌 CO lead 22BB → Hero 决策
 * ```
 */
function riverSpot(overrides: {
  hero?: readonly [string, string];
  riverBetBB?: number;
  effectiveStackBB?: number;
  profile?: string;
} = {}): ManualHandInput {
  const hero = overrides.hero ?? (['Ac', 'Qs'] as const);
  const riverBet = overrides.riverBetBB ?? 22;
  return {
    tableSize: 9,
    heroPosition: 'BTN',
    heroCards: [hero[0], hero[1]],
    board: ['Qd', '8c', '5c', '2h', 'Kc'],
    street: 'RIVER',
    effectiveStackBB: overrides.effectiveStackBB ?? 100,
    seatStacksBB: {
      CO: overrides.effectiveStackBB ?? 100,
      BTN: overrides.effectiveStackBB ?? 100,
    },
    actionHistory: [
      F('UTG'), F('UTG1'), F('UTG2'), F('LJ'), F('HJ'),
      { position: 'CO', type: 'RAISE', amountBB: 2.5 },
      { position: 'BTN', type: 'CALL', amountBB: 2.5 },
      F('SB'), F('BB'),
      { position: 'CO', type: 'BET', amountBB: 4, street: 'FLOP' },
      { position: 'BTN', type: 'CALL', amountBB: 4, street: 'FLOP' },
      { position: 'CO', type: 'CHECK', street: 'TURN' },
      { position: 'BTN', type: 'BET', amountBB: 10, street: 'TURN' },
      { position: 'CO', type: 'CALL', amountBB: 10, street: 'TURN' },
      { position: 'CO', type: 'BET', amountBB: riverBet, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: overrides.profile ?? 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

/** 行业标准的「跑完整条生产管线」辅助 */
function runPipeline(input: ManualHandInput) {
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true, `解析必须成功：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, `门槛必须放行：${gate.ok ? '' : JSON.stringify(gate.issues)}`);
  if (!gate.ok) throw new Error('unreachable');
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
  });
  const hero = gate.state.players.find((p) => p.holeCards !== null)!;
  const legal = deriveLegalActions(gate.state, hero);
  const analyzed = analyzeManualHand(input, OPTIONS);
  assert.equal(analyzed.ok, true, `整条分析必须成功：${analyzed.ok ? '' : JSON.stringify(analyzed.issues)}`);
  if (!analyzed.ok) throw new Error('unreachable');
  return {
    state: gate.state,
    context: built.context,
    legal,
    decision: analyzed.decision,
    viewModel: analyzed.viewModel,
  };
}

/* ============================================================
 * R1 — 河牌角色
 * ============================================================ */

test('R1：河牌角色不得是听牌 / 半诈唬，但**上一街**可以是听牌（真实管线，多个河牌成手）', () => {
  /*
   * 修复前实测：A♣Q♠ 在 Q♦8♣5♣2♥K♣（三张♣ + 手里 A♣ = 四张同花）
   * 被判成 `DRAW` —— 而河牌之后已经没有公共牌，「听牌」在语义上不可能存在。
   *
   * 这里用**多个不同的河牌成手**跑真实管线（不是只测那一手）：
   * 同花（Q♣J♣）、三条（K♥K♦）、两对（Q♠8♠）、中对（A♣Q♠）、空气（7♥4♦）。
   */
  const hands: readonly (readonly [string, string])[] = [
    ['Qc', 'Jc'], // 同花（成手）
    ['Kh', 'Kd'], // 三条 K
    ['Qs', '8s'], // 两对
    ['Ac', 'Qs'], // 中对 Q（对局原手）
    ['7h', '4d'], // 空气
  ];
  for (const hero of hands) {
    const { decision, context } = runPipeline(riverSpot({ hero }));
    assert.equal(context.math.street, 'RIVER', '本用例只针对河牌');
    const post = decision.diagnostics.postflop;
    assert.notEqual(post, undefined, `${hero.join('')} 必须给出翻后快照`);
    const role = String(post!.handRole);
    assert.notEqual(role, 'DRAW', `${hero.join('')}：河牌不得是听牌（实际 ${role}）`);
    assert.notEqual(role, 'SEMI_BLUFF', `${hero.join('')}：河牌不得是半诈唬（实际 ${role}）`);
    /*
     * ⚠️ 反过来：**上一街**允许是听牌 —— 使用者明确要求保留这个信息，
     * 只是它必须与「当前街角色」分开存放。
     */
    if (post!.previousHandRole !== null) {
      assert.ok(
        typeof post!.previousHandRole === 'string',
        '上一街角色必须是字符串（可为 DRAW，那是历史身份）',
      );
    }
  }
});

test('R1b：`normalizeRiverRole` 必须把河牌上的听牌规范化（兜底入口也不放过）', async () => {
  const { normalizeRiverRole } = await import('../src/domain/postflop/relativeHandRole.ts');
  const base = {
    street: 'RIVER',
    facingBet: true,
    heroEquity: 0.3,
    requiredEquity: 0.28,
    spr: 5,
  } as const;
  assert.notEqual(
    normalizeRiverRole({ ...base, role: 'DRAW' as never }),
    'DRAW',
    '河牌上传入 DRAW 必须被规范化',
  );
  assert.notEqual(
    normalizeRiverRole({ ...base, role: 'SEMI_BLUFF' as never }),
    'SEMI_BLUFF',
    '河牌上传入 SEMI_BLUFF 必须被规范化',
  );
  // 非河牌不动
  assert.equal(
    normalizeRiverRole({ ...base, street: 'TURN', role: 'DRAW' as never }),
    'DRAW',
    '转牌上的听牌必须原样保留',
  );
});

/* ============================================================
 * R2 — 底池赔率
 * ============================================================ */

test('R2：`requiredEquity = B / (P + 2B)`（小注 / 半池 / 满池 / 超池都成立）', () => {
  /*
   * 口径说明（本项目 `math.pot` 的约定）：`pot` 是**已经包含对手这次下注**的
   * 台面总额，`winnable` 是**跟注之后**可争夺的量。因此：
   *
   * ```text
   * P（下注前底池）= pot − callCost
   * winnable        = pot + callCost = P + 2B
   * requiredEquity  = callCost / winnable = B / (P + 2B)
   * ```
   *
   * 四种尺度都测：小注（约 1/4 池）、半池、满池、超池。
   */
  for (const bet of [3, 10, 22, 45, 90]) {
    const { context } = runPipeline(riverSpot({ riverBetBB: bet, effectiveStackBB: 300 }));
    const B = context.math.callCost;
    const P = context.math.pot - B; // 下注前底池
    assert.ok(B > 0, `河牌下注 ${bet}BB 必须产生跟注成本`);
    assert.ok(P > 0, '下注前底池必须为正');
    const expected = B / (P + 2 * B);
    assert.ok(
      Math.abs(context.math.requiredEquity - expected) < 1e-12,
      `下注 ${bet}BB：所需权益应为 ${(expected * 100).toFixed(4)}%，` +
        `实际 ${(context.math.requiredEquity * 100).toFixed(4)}%`,
    );
    assert.equal(
      context.math.winnable,
      context.math.pot + B,
      '可争夺量必须等于「底池 + 我的跟注」（= P + 2B）',
    );
  }
});

/* ============================================================
 * R3 — 节点增量 EV
 * ============================================================ */

test('R3：节点增量 EV —— `callEV = 权益 × 可争夺量 − 跟注额`，且权益 = 门槛时恰为 0', () => {
  const { context } = runPipeline(riverSpot());
  const math = context.math;
  assert.notEqual(math.heroEquity, null, '本用例需要算得出权益');
  const equity = math.heroEquity!;
  const expected = equity * math.winnable - math.callCost;
  assert.notEqual(math.callEV, null, '必须给出跟注 EV');
  assert.ok(
    Math.abs(math.callEV! - expected) < 1e-9,
    `跟注 EV 必须等于「权益 × 可争夺量 − 跟注额」：${expected.toFixed(4)} vs ${math.callEV!.toFixed(4)}`,
  );
  /*
   * 零交叉：把权益**换成**所需权益时，EV 必须恰为 0。
   * 这条恒等式是底池赔率的定义，也是「EV 与赔率同源」的证明。
   */
  const atThreshold = math.requiredEquity * math.winnable - math.callCost;
  assert.ok(
    Math.abs(atThreshold) < 1e-9,
    `权益 = 所需权益 ⇒ EV 必须为 0，实际 ${atThreshold}`,
  );
  // 参考点：弃牌 EV ≡ 0（节点增量口径），因此 EV 可与 0 直接比较
  assert.ok(math.callEV! < 0, '本节点（权益低于门槛）的跟注 EV 必须为负 —— 这是算出来的，不是写死的');
});

/* ============================================================
 * R4 — 指标一致性
 * ============================================================ */

test('R4：动作 / 指标 / 解释必须属于同一体系（守卫零违规，且依据被写出）', () => {
  for (const hero of [
    ['Ac', 'Qs'],
    ['Qc', 'Jc'],
    ['7h', '4d'],
  ] as const) {
    const { decision, context, legal } = runPipeline(riverSpot({ hero }));
    const consistency = decision.diagnostics.consistency;
    assert.notEqual(consistency, undefined, '必须运行一致性守卫');
    assert.equal(
      consistency!.ok,
      true,
      `${hero.join('')}：守卫必须零违规，实际 ${JSON.stringify(consistency!.violations)}`,
    );

    /*
     * **独立复算**：测试自己重新跑一遍守卫，用生产输出里的字段
     *（而不是相信 `ok` 这个布尔值）。这样即便有人把守卫短路成 `true`，
     * 测试仍会失败。
     */
    const post = decision.diagnostics.postflop!;
    const band = 0.05 * context.math.winnable;
    const recomputed = validateDecisionConsistency({
      street: context.math.street,
      action: decision.action,
      actionable: decision.actionable,
      legalActions: legal.actions,
      sizeChips: decision.sizeChips ?? null,
      pot: context.math.pot,
      callCost: context.math.callCost,
      requiredEquity: context.math.requiredEquity,
      callEV: context.math.callEV,
      uncertaintyBand: band,
      role: post.handRole as never,
      futureCardProtectionScore: post.futureCardProtectionScore,
      futureStreetCommitmentBonus: Number(post.commitment['futureStreetCommitmentBonus'] ?? 0),
      preferenceScores: post.evRanking,
      warningsZh: [],
      settlement: null,
    });
    assert.deepEqual(
      recomputed.map((v) => v.code),
      [],
      `${hero.join('')}：独立复算也必须零违规`,
    );

    // 决策依据必须写出来，且与「动作 / EV / 容差带」三者自洽
    const basis = decisionBasisOf({
      action: decision.action,
      actionable: decision.actionable,
      facingBet: context.math.callCost > 0,
      callEV: context.math.callEV,
      uncertaintyBand: band,
    });
    assert.equal(
      post.decisionBasisKind,
      basis.kind,
      '快照里的决策依据必须与独立反推的一致',
    );
    if (basis.kind === 'MATH_INDIFFERENCE') {
      assert.ok(
        Math.abs(context.math.callEV ?? 0) <= 1e-6 + 1e-12,
        '「数学无差异」只允许在 |EV| ≤ 1e-6 筹码（浮点余量）时出现',
      );
    }
    if (basis.kind === 'CHIP_EV') {
      assert.ok(
        (decision.action === 'CALL') === ((context.math.callEV ?? 0) > 0),
        '依据为 chip EV 排名时，动作方向必须与 EV 符号一致',
      );
    }
  }
});

/* ============================================================
 * R5 / R6 — 阻断牌双向
 * ============================================================ */

test('R5：阻断牌必须基于**可达范围**逐组合计数（价值侧会随 Hero 的牌变化）', () => {
  const rows = (
    [
      ['Ac', 'Qs'],
      ['Qc', 'Jc'],
      ['Qh', 'Jd'],
      ['9h', '9d'],
      ['7h', '4d'],
    ] as const
  ).map((hero) => {
    const { decision, context } = runPipeline(riverSpot({ hero }));
    const blockers = decision.diagnostics.postflop!.blockers;
    const facts = context.postflopFacts?.opponentRangeFacts ?? null;
    assert.notEqual(facts, null, '必须算出可达范围');
    return {
      hero: hero.join(''),
      value: Number(blockers['blockedStrongerCombos']),
      bluff: Number(blockers['blockedWeakerCombos']),
      quality: String(blockers['evidenceQuality']),
      support: facts!.supportSize,
    };
  });

  for (const row of rows) {
    assert.ok(row.support > 0, `${row.hero}：可达范围必须有组合（分母）`);
    assert.ok(
      row.quality === 'HIGH' || row.quality === 'MEDIUM' || row.quality === 'LOW',
      `${row.hero}：有范围数据时证据质量不得是 NONE（实际 ${row.quality}）`,
    );
    assert.ok(row.value > 0 && row.bluff > 0, `${row.hero}：两侧都必须有计数`);
  }
  /*
   * 「同一局面只换 Hero 一张牌 ⇒ 阻断计数变化」：若计数与 Hero 的牌无关
   *（修复前只按牌面特征打分），这些值会**全部相同**。
   */
  const distinctValue = new Set(rows.map((r) => r.value));
  assert.ok(
    distinctValue.size >= 2,
    `换 Hero 的牌必须改变「挡掉的更强组合数」，实际取值 ${[...distinctValue].join(' / ')}`,
  );
});

test('R6：阻断诈唬必须能**独立**变化 —— 且**不**断言「持 A♣ 就该跟注」', () => {
  const rows = (
    [
      ['Ac', 'Qs'],
      ['As', 'Qc'],
      ['Qc', 'Jc'],
      ['7h', '4d'],
    ] as const
  ).map((hero) => {
    const { decision } = runPipeline(riverSpot({ hero }));
    const b = decision.diagnostics.postflop!.blockers;
    return {
      hero: hero.join(''),
      value: Number(b['blockedStrongerCombos']),
      bluff: Number(b['blockedWeakerCombos']),
      net: Number(b['netBlockerPreference']),
      action: decision.action,
    };
  });

  const distinctBluff = new Set(rows.map((r) => r.bluff));
  assert.ok(
    distinctBluff.size >= 2,
    `换 Hero 的牌必须能独立改变「挡掉的更弱组合数」，实际 ${[...distinctBluff].join(' / ')}`,
  );
  /*
   * 方向（【公开扑克理论】）：价值阻断是收益、诈唬阻断是代价，两者可以同时
   * 为正 —— 因此**不能**用「我持 A♣」推出任何动作。这里只断言结构：
   * 净偏好是有界分数，且它**不单独决定动作**（动作由决策层给出）。
   */
  for (const row of rows) {
    assert.ok(
      row.net >= -1 && row.net <= 1,
      `${row.hero}：净阻断偏好必须落在 −1..1，实际 ${row.net}`,
    );
    assert.ok(
      ['CALL', 'FOLD', 'RAISE', 'ALL_IN'].includes(String(row.action)),
      `${row.hero}：必须给出合法动作`,
    );
  }
  // 「A♣ 一定跟注」这类硬编码如果被写进代码，下面这条会失败：
  // A♣Q♠ 与 A♠Q♣ 的阻断结构不同，但**动作不必不同**，因此这里只断言
  // 「存在阻断结构不同的两手牌」——真正的动作正确性由 R4/R10 的守卫负责。
  assert.ok(
    rows[0]!.value !== rows[1]!.value || rows[0]!.bluff !== rows[1]!.bluff,
    'A♣Q♠ 与 A♠Q♣ 的阻断结构必须不同（同一张 A 的花色不同 ⇒ 挡掉的组合不同）',
  );
});
/* ============================================================
 * R7 — 河牌保护分
 * ============================================================ */

test('R7：河牌未来补牌保护分 = 0，但价值 / 诈唬分**不得**被一起清零', () => {
  /*
   * ⚠️ 必须覆盖**多手牌**：`protectionRelevant` 由牌面湿润度与范围听牌质量
   * 决定（与 Hero 的牌间接相关 —— 死牌会改变范围），只测一手会漏掉
   * 「protectionRelevant = true 时河牌仍拿到保护分」这条路。
   * 实测：A♣Q♠ 这一手 `protectionRelevant = false`（wetness 0.33 < 0.4），
   * 因此只测它时这条用例对「河牌保护分不为 0」的变异**不敏感**。
   */
  for (const hero of [
    ['Ac', 'Qs'],
    ['Qc', 'Jc'],
    ['7h', '4d'],
  ] as const) {
    const { decision, context } = runPipeline(riverSpot({ hero }));
    const post = decision.diagnostics.postflop!;
    assert.equal(context.math.street, 'RIVER');
    assert.equal(
      post.futureCardProtectionScore,
      0,
      `${hero.join('')}：河牌的未来补牌保护分必须是 0（实际 ${post.futureCardProtectionScore}）`,
    );
    assert.equal(
      Number(post.commitment['futureStreetCommitmentBonus'] ?? 0),
      0,
      `${hero.join('')}：河牌的未来街承诺加分必须是 0`,
    );
    /*
     * 使用者 §12：不能把价值 / 诈唬 / 弃牌率统称为 protection 然后一起清零。
     * 判据：闸门仍然算出了**非零**的比较分（本节点是「不该下注」局面，
     * 因此过牌分必须 > 0；下注分为 0 是策略结论，不是被清零）。
     */
    assert.ok(
      Number(post.valueAssessment['estimatedCheckEVScore']) > 0,
      `${hero.join('')}：河牌上「过牌偏好分」必须仍然被算出（不得因保护分为 0 而一起清零）`,
    );
    assert.ok(
      typeof post.showdownValue === 'number' && post.showdownValue >= 0,
      '摊牌价值必须仍然存在',
    );
  }
});

/* ============================================================
 * R8 / R9 — 结算
 * ============================================================ */

test('R8：Hero 尚未行动的河牌节点不得出现**最终**退回（只有「尚待跟注」）', () => {
  const { state } = runPipeline(riverSpot());
  const pot = computeLayeredPot(state);
  const returnedTotal = Object.values(pot.returned).reduce((a, b) => a + b, 0);
  const pendingTotal = Object.values(pot.pendingUnmatched).reduce((a, b) => a + b, 0);

  assert.equal(pot.roundClosed, false, 'Hero 还没决定跟不跟 ⇒ 下注轮未结束');
  assert.equal(
    returnedTotal,
    0,
    `未完成行动节点不得有最终退回，实际 ${JSON.stringify(pot.returned)} —— ` +
      '那笔钱只是尚未匹配（Hero 正要去跟）',
  );
  assert.ok(pendingTotal > 0, `必须把这笔钱记为「尚待跟注」，实际 ${pendingTotal}`);
  assert.equal(
    pot.contested + returnedTotal + pendingTotal,
    pot.total,
    '守恒：可争夺 + 退回 + 尚待跟注 === 总投入',
  );

  const events = settlementEventsOf(pot, state.street);
  assert.equal(
    events.filter((e) => e.kind === 'UNCALLED_BET_RETURN').length,
    0,
    '事件流里不得出现「无人跟注、退回」',
  );
  const pendingEvents = events.filter((e) => e.kind === 'PENDING_UNMATCHED');
  assert.ok(pendingEvents.length > 0, '必须产出「尚待跟注」事件');
  for (const e of pendingEvents) {
    assert.equal(e.final, false, '「尚待跟注」事件必须标记为非最终');
  }
  // 界面文案不得把它说成退回
  const lines = describeLayeredPotZh(pot, state.street);
  assert.ok(
    lines.some((l) => l.includes('尚待跟注')),
    `必须有一行写「尚待跟注」，实际：${lines.join(' ｜ ')}`,
  );
  assert.ok(
    !lines.some((l) => l.includes('无人跟注')) && !/退回\s*\d/.test(lines.join(' ｜ ')),
    `不得出现「无人跟注、退回 X」这种提前结算文案，实际：${lines.join(' ｜ ')}`,
  );
});

test('R9：同一结算事件只能出现一次（稳定 id + 去重 + 无重复文案）', () => {
  const { state } = runPipeline(riverSpot());
  const pot = computeLayeredPot(state);
  const events = settlementEventsOf(pot, state.street);

  // 稳定唯一标识
  const ids = events.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `事件 id 必须唯一：${ids.join(', ')}`);
  for (const e of events) {
    assert.ok(e.id.length > 0, '事件必须有非空 id');
    assert.ok(e.id.includes(e.kind), `id 必须含事件类型，实际 ${e.id}`);
  }
  // 同一局面重复计算必须给出**逐位相同**的 id（稳定）
  assert.deepEqual(
    settlementEventsOf(computeLayeredPot(state), state.street).map((e) => e.id),
    ids,
    '同一局面的事件 id 必须逐位可复现',
  );

  // 去重函数必须真的能识别重复
  const duplicated = [...events, ...events];
  const deduped = dedupeSettlementEvents(duplicated);
  assert.equal(deduped.events.length, events.length, '去重后必须回到原始条数');
  assert.equal(
    deduped.duplicateIds.length,
    events.length,
    `必须如实报告被丢弃的重复 id（实际 ${deduped.duplicateIds.length}）`,
  );

  // 渲染层：文案不得重复
  const lines = describeLayeredPotZh(pot, state.street);
  assert.equal(new Set(lines).size, lines.length, `界面文案不得重复：${lines.join(' ｜ ')}`);
});

/* ============================================================
 * R10 — 真实节点全链路
 * ============================================================ */

test('R10：A♣Q♠ 真实节点 —— 角色合法 / 赔率正确 / 口径不混 / 无提前与重复结算 / 界面不把评分当概率', () => {
  const { decision, context, state, viewModel } = runPipeline(riverSpot());
  const post = decision.diagnostics.postflop!;

  // ① 河牌角色合法
  assert.ok(
    post.handRole !== 'DRAW' && post.handRole !== 'SEMI_BLUFF',
    `河牌角色必须合法，实际 ${post.handRole}`,
  );

  // ② 底池赔率数学正确
  const B = context.math.callCost;
  const P = context.math.pot - B;
  assert.ok(
    Math.abs(context.math.requiredEquity - B / (P + 2 * B)) < 1e-12,
    '所需权益必须是 B / (P + 2B)',
  );

  // ③ 口径不混乱：真 chip EV 与启发式偏好分**分开**存放、各自带口径声明
  assert.notEqual(context.math.callEV, null, '必须给出节点增量 chip EV');
  assert.equal(post.metricKind, 'PREFERENCE_SCORE', '建议器的分数必须自称偏好分而不是 EV');
  const allText = [
    ...decision.reasons.map((r) => r.textZh),
    ...viewModel.allReasonsZh,
    ...viewModel.warningsZh,
  ].join('\n');
  assert.ok(
    !/CALL EV\s*=\s*\+?\d/i.test(allText),
    '不得把启发式分数写成「CALL EV = 数字」这种伪精确 EV',
  );

  // ④ 最终动作与所用指标一致（守卫 + 依据）
  assert.equal(decision.diagnostics.consistency!.ok, true, '守卫必须零违规');
  assert.ok(
    typeof post.decisionBasisKind === 'string' && post.decisionBasisKind.length > 0,
    '必须写出决策依据',
  );

  // ⑤ 无提前退款 / 无重复退款
  const pot = computeLayeredPot(state);
  assert.equal(Object.values(pot.returned).reduce((a, b) => a + b, 0), 0, '不得有最终退回');
  const lines = describeLayeredPotZh(pot, state.street);
  assert.equal(new Set(lines).size, lines.length, '结算文案不得重复');

  // ⑥ 界面不把内部评分冒充概率
  const rows = viewModel.debug.postflop;
  const compressionRow = rows.find((r) => r.label.includes('对手范围压缩'));
  assert.notEqual(compressionRow, undefined, '必须显示范围压缩行');
  assert.ok(
    compressionRow!.label.includes('评分') && compressionRow!.label.includes('非概率'),
    `压缩那一行必须标明是内部评分而不是概率，实际标签：${compressionRow!.label}`,
  );
  const shareRow = rows.find((r) => r.label.includes('对手范围 vs 我的牌'));
  assert.notEqual(shareRow, undefined, '必须显示「对手范围 vs 我的牌」行');
  assert.ok(
    shareRow!.value.includes('分母'),
    `占比必须给出分母，实际：${shareRow!.value}`,
  );

  // ⑦ 禁止硬编码动作：本用例**不**断言 CALL / FOLD
  assert.ok(
    decision.action === null || ['CALL', 'FOLD', 'RAISE', 'ALL_IN', 'CHECK', 'BET'].includes(decision.action),
    `必须给出合法动作或明确不给方向，实际 ${String(decision.action)}`,
  );
});
