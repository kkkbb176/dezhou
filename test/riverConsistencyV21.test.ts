/**
 * RIVER CONSISTENCY **V2.1** 回归锁（2026-09 · 定向修复）
 *
 * 这一组锁四个**具体**问题（不是策略调整）：
 *
 * | 编号 | 问题 | 证据等级 |
 * |---|---|---|
 * | **P0-1** | 河牌明明有成交牌，却被归类为 AIR | 【工程约束】+【数学确定】的域不变量 |
 * | **P0-2** | 把「负 EV 但差距不大」说成「数学上无明显优劣」 | 【数学确定】（EV 排名）+【工程约束】（容差带） |
 * | **P1-1** | 用 stronger/weaker 冒充 value/bluff | 【数学确定】（强弱）+【公开扑克理论】（分类） |
 * | **P1-2** | 简化未匹配退款公式冒充通用结算 | 【工程约束】（作用域断言） |
 *
 * ⚠️ 断言的都是**不变量与语义**，不断言「这手必须 CALL / FOLD」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { parseManualInput } from '../src/app/manualInput/manualInput.ts';
import { buildAnalyzableState } from '../src/app/manualInput/reconstruct.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { decideAlpha } from '../src/app/decision/decisionEngine.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import { applyAction } from '../src/domain/poker/engine.ts';
import {
  assertHeadsUpUnmatchedScope,
  computeHeadsUpClosedRoundUnmatchedReturn,
  computeLayeredPot,
  settlementEventsOf,
  settlementScopeOf,
  SettlementScope,
} from '../src/domain/poker/pots.ts';
import {
  classifyRiverAction,
  RiverActionClass,
  riverActionCountsOf,
} from '../src/domain/postflop/riverActionClass.ts';
import {
  madeHandClassOf,
  madeHandRoleInvariantViolation,
  MadeHandClass,
  MIN_SHOWDOWN_VALUE_SHARE,
} from '../src/domain/postflop/relativeHandRole.ts';
import { parseCardStrict } from '../src/domain/poker/cards.ts';
import { describeHand } from '../src/domain/poker/handDescription.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';
import type { Card } from '../src/domain/types.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
/*
 * 🔴 **TEST 09**：`equitySeed` 必须与 `runPipeline` 里 `buildDecisionContext`
 * 用的**同一个**。否则同一份输入在两条路径上各算一次权益：
 * `analyzeManualHand` 用这里的默认种子，`buildDecisionContext` 用另一个，
 * 于是一个中等牌力的抓诈节点会给出**两个 callEV**（实测 `Jh Th` 在
 * 1BB 下相差约 80 筹码 = 带内/带外的差别）。
 *
 * 这类「两处口径」在本项目已被反复禁止；本文件的容差带测试
 *（`inBandSpot` 自校准）对它有直接依赖。
 */
const EQUITY_SEED = 20260913;
const OPTIONS = { rules: RULES, asOf: 1_757_000_000_000, writeLog: false, equitySeed: EQUITY_SEED } as const;
const F = (position: string) => ({ position, type: 'FOLD' as const });

/* ============================================================
 * 真实节点（使用者给出的那一手）
 * ============================================================ */

const BOARD = ['Qd', '8c', '5c', '2h', 'Kc'] as const;

function riverSpot(
  hero: readonly [string, string],
  /**
   * 🔴 **TEST 09 P0-1**：河牌下注额（默认 22BB = 原用例）。
   *
   * 容差带测试需要 EV **落在带内**（±5% 可争夺量）。修复后 `callEV` 改用
   * **下注范围**权益，而该范围内价值牌占绝对多数 ⇒ 抓诈牌的权益与门槛
   * 差距被放大，原来那个 22BB 节点已经落在带外。
   *
   * 因此带内测试显式指定一个**小额下注**：门槛随之降到 2.74%，
   * 于是「权益略偏离门槛」的局面重新存在（实测 `callEV = −82.99`，
   * 带 ±182.5 ⇒ 带内）。这是**构造出来的前提**，不是放宽断言。
   */
  riverBetBB = 22,
): ManualHandInput {
  return {
    tableSize: 9,
    heroPosition: 'BTN',
    heroCards: [hero[0], hero[1]],
    board: [...BOARD],
    street: 'RIVER',
    effectiveStackBB: 100,
    seatStacksBB: { CO: 100, BTN: 100 },
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
      { position: 'CO', type: 'BET', amountBB: riverBetBB, street: 'RIVER' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
}

/**
 * 容差带测试的候选手牌空间。
 *
 * 选取理由：本牌面（`Qd 8c 5c 2h Kc`）上抓诈牌的「对下注范围权益」分布很宽，
 * 从 0.01%（7h4d）到 13.2%（Qs8s）都有，因此**需要多个手牌**才能覆盖
 * 「权益 ≈ 门槛」那一小段（单个手牌未必有合适的尺寸）。
 */
const BAND_HEROES = [
  ['Ac', 'Qs'],
  ['Qh', 'Jd'],
  ['Ah', 'Kd'],
  ['Qs', '8s'],
  ['Qc', 'Jc'],
  ['Jh', 'Th'],
  ['9h', '9d'],
  ['Th', 'Tc'],
  ['Ah', 'Jd'],
  ['Jh', '9h'],
] as const satisfies readonly (readonly [string, string])[];

/**
 * 🔴 **TEST 09 P0-1：自校准的「容差带内」节点构造器**。
 *
 * ## 为什么需要它（一次实测教训）
 *
 * 容差带测试要求 `|callEV| ≤ 5% × winnable`。修复 `callEV` 的权益口径后
 *（改用**下注范围**权益），原来那个 `Ac Qs + 22BB` 节点从带内掉到
 * `callEV = −2160.95`（带 ±392.5）—— **前提失效**。
 *
 * 手工换手牌 / 换尺寸去「找」一个带内节点是错的做法：**每改一次模型
 * 就得重扫一遍**（下注范围从「两分支分类」改成「按手牌类别」后，
 * 全部手工校准的数字一次作废）。
 *
 * ## 现在的做法：在候选空间里**挑最优**，而不是挑第一个碰上的
 *
 * `callEV` 的符号在某个尺寸处翻转，而该处的 `|callEV|` 与「换手牌带来的
 * 权益跳变」同阶 —— 本牌面上抓诈牌的权益会从 7.72% 直接掉到 0.50%，
 * 因此**单个手牌**未必有落在 ±5% 内的尺寸。
 *
 * 所以这里对「手牌 × 尺寸」的**整个候选空间**求 `|callEV| / band` 的最小值，
 * 取最接近门槛的那个组合。它对模型变化更稳健（不需要某个特定数字成立），
 * 且失败时会把整个候选空间如实打印出来，便于定位。
 *
 * @param wantSign 需要的 `callEV` 符号（`-1` 弃牌侧 / `+1` 跟注侧）
 */
function inBandSpot(
  heroes: readonly (readonly [string, string])[],
  wantSign: -1 | 1,
): { input: ManualHandInput; run: ReturnType<typeof runPipeline>; betBB: number; hero: readonly [string, string] } {
  /*
   * ⚠️ 候选下注额必须**合法**（规则层要求 ≥ 1 个大盲，`ISSUE.BET_BELOW_MIN`）。
   * 覆盖「EV 由正转负」的跨点：小注偏向跟注侧、大注偏向弃牌侧。
   */
  const candidates = [1, 1.5, 2, 3, 4, 5, 6];
  type Cand = {
    hero: readonly [string, string];
    betBB: number;
    input: ManualHandInput;
    run: ReturnType<typeof runPipeline>;
    ev: number;
    band: number;
    score: number;
  };
  const all: Cand[] = [];
  for (const hero of heroes) {
    for (const betBB of candidates) {
      const input = riverSpot(hero, betBB);
      const run = runPipeline(input);
      const ev = run.context.math.callEV;
      if (ev === null || !Number.isFinite(ev)) continue;
      const band = 0.05 * run.context.math.winnable;
      if (!(band > 0)) continue;
      all.push({ hero, betBB, input, run, ev, band, score: Math.abs(ev) / band });
    }
  }
  /* 先按「符号 + 带内」筛，再取最接近门槛的一个 */
  const eligible = all
    .filter((x) => Math.sign(x.ev) === wantSign && x.score <= 1)
    .sort((a, b) => a.score - b.score);
  if (eligible.length > 0) {
    const best = eligible[0]!;
    return { input: best.input, run: best.run, betBB: best.betBB, hero: best.hero };
  }
  /*
   * 没有任何组合落在带内 ⇒ 这是**夹具失效**，不是断言失败。
   * 把整个候选空间打印出来，便于定位是「模型变了」还是「候选不够」。
   */
  const dump = all
    .map(
      (x) =>
        `${x.hero.join('')}@${x.betBB}BB→ev=${x.ev.toFixed(2)}(±${x.band.toFixed(2)},score=${x.score.toFixed(2)})`,
    )
    .join('、');
  throw new Error(
    `无法构造「带内且符号 ${wantSign}」的节点 —— ` +
      `候选空间共 ${all.length} 个组合均不满足（best score=` +
      `${all.length > 0 ? Math.min(...all.map((x) => x.score)).toFixed(2) : 'n/a'}）。` +
      `实测：${dump}`,
  );
}

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
    /*
     * 🔴 **TEST 09**：必须传固定种子。
     *
     * 修复前这里没传 ⇒ `buildDecisionContext` 用它的内部默认种子，
     * 而 `analyzeManualHand` 用 `OPTIONS` —— 两条路径各自算一次权益。
     * 加了**下注范围**权益后这个差别变得可见：同为「Ac Qs + 1BB」，
     * 本函数给出 `callEV = +84.71`（下注范围权益 5.06%），
     * 而 `analyzeManualHand` 给出 `−82.99`（0.47%）—— 同一个决策点两个答案。
     *
     * 这本来就是本项目反复禁止的「两处口径」，只是以前没被触发。
     */
    equitySeed: EQUITY_SEED,
  });
  const hero = gate.state.players.find((p) => p.holeCards !== null)!;
  const legal = deriveLegalActions(gate.state, hero);
  const analyzed = analyzeManualHand(input, OPTIONS);
  assert.equal(analyzed.ok, true, `整条分析必须成功：${analyzed.ok ? '' : JSON.stringify(analyzed.issues)}`);
  if (!analyzed.ok) throw new Error('unreachable');
  return {
    state: gate.state,
    context: built.context,
    hero,
    legal,
    decision: analyzed.decision,
    viewModel: analyzed.viewModel,
  };
}

const cardsOf = (codes: readonly string[]): Card[] => codes.map((c) => parseCardStrict(c));

/* ============================================================
 * ROLE-1..5：角色语义
 * ============================================================ */

test('ROLE-1：河牌有成交牌（一对）时，不得仅因为「价值下注不成立」就变成 AIR', () => {
  /*
   * 修复前实测：A♣Q♠（中对 Q）在 Q♦8♣5♣2♥K♣ 面对 22BB ⇒ role = **AIR**，
   * 触发点是 `equity >= requiredEquity * 0.9 ? BLUFF_CATCHER : AIR`
   *（24.0% < 25.2%）—— 那个 0.9 系数回答的是「抓诈唬够不够」，
   * 却被拿去回答了「是不是空气」。
   */
  const { decision } = runPipeline(riverSpot(['Ac', 'Qs']));
  const post = decision.diagnostics.postflop!;
  assert.equal(post.madeHand, 'PAIR', `成交牌型必须是一对，实际 ${post.madeHand}`);
  assert.notEqual(post.handRole, 'AIR', '一对不得被判成空气');
  assert.ok(
    post.handRole === 'SHOWDOWN_VALUE' || post.handRole === 'BLUFF_CATCHER',
    `一对的合理角色是摊牌价值 / 抓诈牌，实际 ${post.handRole}`,
  );
  // 域不变量本身不得被触发
  assert.equal(
    madeHandRoleInvariantViolation({
      street: 'RIVER',
      madeHand: MadeHandClass.PAIR,
      role: post.handRole as never,
    }),
    null,
    '域不变量必须成立',
  );
});

test('ROLE-2：河牌两对不得变成 AIR；同花/三条/超对等更强牌型同样不得', () => {
  for (const [hero, expectedMade] of [
    [['Qs', '8s'], 'TWO_PAIR'],
    [['Qc', 'Jc'], 'FLUSH'],
    [['Kh', 'Kd'], 'TRIPS'],
    [['9h', '9d'], 'PAIR'], // 9♥9♦ 在 Q/K 牌面上是**小对子**（underpair），仍属成交牌型
  ] as Array<[readonly [string, string], string]>) {
    const { decision } = runPipeline(riverSpot(hero));
    const post = decision.diagnostics.postflop!;
    assert.equal(post.madeHand, expectedMade, `${hero.join('')} 的成交牌型应为 ${expectedMade}`);
    assert.notEqual(post.handRole, 'AIR', `${hero.join('')}（${expectedMade}）不得是空气`);
  }
  /*
   * 反向保护：**高牌**仍然可以是空气（不能把「不得为 AIR」放宽成
   * 「所有牌都不能是 AIR」）。
   */
  const highCard = runPipeline(riverSpot(['As', 'Js'])).decision.diagnostics.postflop!;
  assert.equal(highCard.madeHand, 'HIGH_CARD');
});

test('ROLE-3：河牌高牌且**对可达范围毫无摊牌价值**时，可以（且应该）是 AIR', () => {
  /*
   * 唯一的例外必须有数据支撑：对手的可达范围里确实没有任何比它差的组合。
   * 本节点用 A♠J♠（高牌 A）—— 实测权益 0.6%，`weakerShare + equalShare ≈ 0`。
   */
  const { decision, context } = runPipeline(riverSpot(['As', 'Js']));
  const post = decision.diagnostics.postflop!;
  const facts = context.postflopFacts?.opponentRangeFacts ?? null;
  assert.notEqual(facts, null, '必须有范围事实');
  assert.equal(post.madeHand, 'HIGH_CARD');
  assert.ok(
    facts!.weakerShare + facts!.equalShare < MIN_SHOWDOWN_VALUE_SHARE,
    `这一手的前提是「几乎没有更差的牌」，实际 ${(facts!.weakerShare + facts!.equalShare).toFixed(4)}`,
  );
  assert.equal(post.handRole, 'AIR', '确认没有摊牌价值时，高牌可以是空气');
});

test('ROLE-4：河牌一对**面对下注**时可以是抓诈牌（权益够门槛的情形）', () => {
  /*
   * 两对（权益 38.1% > 门槛 28.0%）⇒ 抓诈牌。
   * 这条锁的是「够跟就抓诈唬」这一支没有被 P0-1 的修改弄坏。
   */
  const { decision, context } = runPipeline(riverSpot(['Qs', '8s']));
  const post = decision.diagnostics.postflop!;
  assert.ok(
    (context.math.heroEquity ?? 0) >= context.math.requiredEquity,
    '本用例前提：权益高于门槛',
  );
  assert.equal(post.handRole, 'BLUFF_CATCHER', `权益够跟 ⇒ 抓诈牌，实际 ${post.handRole}`);
});

test('ROLE-5：上一街是听牌 + 河牌成对 ⇒ 当前角色必须重算（既不是听牌也不是空气）', () => {
  const { decision } = runPipeline(riverSpot(['Ac', 'Qs']));
  const post = decision.diagnostics.postflop!;
  assert.equal(post.previousHandRole, 'DRAW', '上一街（转牌）确实是听牌 —— 这个信息必须保留');
  assert.notEqual(post.handRole, 'DRAW', '当前街角色不得沿用上一街的听牌');
  assert.notEqual(post.handRole, 'AIR', '当前街角色也不得因为是「没成花」就判空气');
  assert.equal(
    madeHandRoleInvariantViolation({
      street: 'RIVER',
      madeHand: madeHandClassOf(2),
      role: post.handRole as never,
    }),
    null,
    '域不变量必须成立',
  );
});

/* ============================================================
 * BAND-1..4：EV 表达与容差
 * ============================================================ */

test('BAND-1：Fold EV = 0 > Call EV < 0 ⇒ 数学排序必须是 FOLD > CALL，且动作跟随它', () => {
  const { decision, context } = runPipeline(riverSpot(['Ac', 'Qs']));
  const math = context.math;
  assert.notEqual(math.callEV, null, '必须算出跟注 EV');
  assert.ok(math.callEV! < 0, `本用例前提：跟注 EV 为负（实际 ${math.callEV!.toFixed(2)}）`);

  const post = decision.diagnostics.postflop!;
  const fold = post.trueEvRanking.find((x) => x.action === 'FOLD');
  const call = post.trueEvRanking.find((x) => x.action === 'CALL');
  assert.notEqual(fold, undefined, '必须列出 FOLD 的 EV');
  assert.notEqual(call, undefined, '必须列出 CALL 的 EV');
  assert.equal(fold!.evChips, 0, '弃牌 EV ≡ 0（节点增量口径的定义）');
  assert.ok(
    (call!.evChips ?? 0) < (fold!.evChips ?? 0),
    `EV 排名必须是 FOLD > CALL，实际 ${JSON.stringify(post.trueEvRanking)}`,
  );

  // 默认（未开启不确定性覆盖）⇒ 动作必须跟随 EV 第一名
  assert.equal(decision.action, 'FOLD', `跟注 EV 为负 ⇒ 默认必须弃牌，实际 ${String(decision.action)}`);
  assert.equal(post.decisionBasisKind, 'CHIP_EV', '动作依据必须是真实 chip EV 排名');
  assert.equal(post.allowUncertaintyOverride, false, '不确定性覆盖默认必须关闭');
});

test('BAND-2：存在模型容差带时，不得再出现「数学无差异 / 没有明显优劣」的表述', () => {
  /*
   * 🔴 **TEST 09 P0-1 契约变更（已记录，非放宽）**
   *
   * 原来用默认 22BB 下注。修复后 `callEV` 改用**下注范围**权益，
   * 该节点 EV 变成 −2160.95（带 ±392.50）——**落在带外**，
   * 于是「带内不得写『没有明显优劣』」这条性质就测不到了。
   *
   * 现在用**自校准**的带内节点（`inBandSpot`）：让测试自己挑一个
   * 满足 `|callEV| ≤ 5% × winnable` 的尺寸，而不是靠一个碰巧成立的常数。
   */
  const { run } = inBandSpot(BAND_HEROES, -1);
  const { decision, context } = run;
  const math = context.math;
  const band = 0.05 * math.winnable;
  assert.ok(
    Math.abs(math.callEV ?? 0) <= band,
    `本用例前提：EV 落在容差带内（|${(math.callEV ?? 0).toFixed(2)}| ≤ ${band.toFixed(2)}）`,
  );
  const text = [
    ...decision.reasons.map((r) => r.textZh),
    ...(decision.diagnostics.postflop?.decisionBasisNoteZh ?? ''),
  ].join('\n');
  for (const forbidden of ['数学上没有明显优劣', '数学上**没有**明显更优', '数学无差异', '没有明显优劣']) {
    assert.ok(
      !text.includes(forbidden),
      `容差带内不得写出「${forbidden}」，实际文本：${text.slice(0, 400)}`,
    );
  }
  // 必须如实说明这是**工程容差**
  assert.ok(
    text.includes('工程容差') || text.includes('模型容差带'),
    `必须把 5% 说明成工程容差 / 模型容差带，实际：${text.slice(0, 400)}`,
  );
});

test('BAND-3：容差带**不改变 EV 排名** —— 动作必须由 `decisionBasisOf` 认可的依据产生', async () => {
  const { decision, context, legal, state } = runPipeline(riverSpot(['Ac', 'Qs']));
  const { decisionBasisOf } = await import('../src/domain/decision/decisionConsistency.ts');
  const band = 0.05 * context.math.winnable;
  const basis = decisionBasisOf({
    action: decision.action,
    actionable: decision.actionable,
    facingBet: legal.callCost > 0,
    callEV: context.math.callEV,
    uncertaintyBand: band,
  });
  assert.equal(
    decision.diagnostics.postflop!.decisionBasisKind,
    basis.kind,
    '快照里的依据必须与独立反推一致',
  );
  if (basis.kind === 'CHIP_EV' && context.math.callEV !== null) {
    assert.ok(
      (decision.action === 'CALL') === (context.math.callEV > 0),
      '依据为 CHIP_EV 时动作方向必须与 EV 符号一致',
    );
  }
  // 结算侧不受影响：Hero 未行动 ⇒ 仍然只有 pending
  const pot = computeLayeredPot(state);
  assert.equal(Object.values(pot.returned).reduce((a, b) => a + b, 0), 0);
});

test('BAND-4：显式开启 `allowUncertaintyOverride` 后，偏离 EV 排名必须被标成 MODEL_UNCERTAINTY_OVERRIDE', () => {
  /*
   * 🔴 **TEST 09 P0-1 契约变更（已记录，非放宽）**
   *
   * 原来用 `Ac Qs` + 22BB。修复后该节点 EV = −2160.95（带 ±392.50）——
   * 带外，`allowUncertaintyOverride` 不再适用（它**只在**带内才允许
   * 取代价最小的方向，这正是它的语义）。
   *
   * 现在两个形态都由 `inBandSpot` **自校准**构造：
   * 一个带内且 EV 为正（验证「跟随 EV 排名」），
   * 一个带内且 EV 为负（验证「覆盖 ⇒ 取代价最小方向」）。
   */
  const posSpot = inBandSpot(BAND_HEROES, 1);
  const { context, legal } = posSpot.run;
  const math = context.math;
  assert.ok((math.callEV ?? 0) > 0, '本用例前提：跟注 EV 为正');
  assert.ok(
    Math.abs(math.callEV!) <= 0.05 * math.winnable,
    `本用例前提：EV 落在容差带内（|${math.callEV!.toFixed(2)}| ≤ ${(0.05 * math.winnable).toFixed(2)}）`,
  );

  // ① 关闭（默认）：跟随 EV 排名 → CALL
  const strict = decideAlpha(context, legal);
  assert.equal(strict.action, 'CALL', '未开启覆盖时必须跟随 EV 排名');
  assert.equal(strict.diagnostics.decisionBasis?.kind, 'CHIP_EV');

  // ② 开启覆盖：只在「带内 + EV 为负」时才会取代价最小的方向
  const negSpot = inBandSpot(BAND_HEROES, -1);
  const neg = negSpot.run;
  assert.notEqual(neg.context.math.callEV, null, '覆盖用例必须算得出跟注 EV');
  assert.ok((neg.context.math.callEV ?? 0) < 0, '覆盖用例前提：跟注 EV 为负');
  const band = 0.05 * neg.context.math.winnable;
  assert.ok(Math.abs(neg.context.math.callEV!) <= band, '本节点确实落在容差带内');
  const overridden = decideAlpha(neg.context, neg.legal, { allowUncertaintyOverride: true });
  assert.equal(overridden.action, 'CALL', '开启覆盖后允许取代价最小的方向');
  assert.equal(
    overridden.diagnostics.decisionBasis?.kind,
    'MODEL_UNCERTAINTY_OVERRIDE',
    '偏离 EV 排名必须被标成 MODEL_UNCERTAINTY_OVERRIDE',
  );
  assert.ok(
    /工程启发式|不是数学结论/.test(overridden.diagnostics.decisionBasis!.noteZh),
    `覆盖说明必须写明它不是数学结论，实际：${overridden.diagnostics.decisionBasis!.noteZh}`,
  );
  assert.equal(overridden.diagnostics.consistency?.ok, true, '开启覆盖后守卫仍必须零违规');
});

/* ============================================================
 * RANGE-1..3：stronger/weaker 与 value/bluff 的分离
 * ============================================================ */

test('RANGE-1：weakerThanHero 组合**不得**自动等于诈唬候选；stronger 也不等于价值候选', () => {
  /*
   * 使用者第九/十节：`strongerThanHero === value` 与
   * `weakerThanHero === bluff` 都是**禁止的等价**。
   *
   * 两个方向要用**不同**的 Hero 才能同时看到严格不等（实测）：
   *
   * | Hero | 更强 | 价值候选 | 更弱 | 诈唬候选 |
   * |---|---|---|---|---|
   * | A♣Q♠（中对） | 112 | 112 | **292** | **156** |
   * | 9♥9♦（小对子） | **184** | **128** | 243 | 149 |
   *
   * - A♣Q♠ 的「更弱」远多于「诈唬候选」：弱牌里绝大多数是**摊牌牌**。
   * - 9♥9♦ 的「更强」远多于「价值候选」：比他强但只是中对/底对的牌
   *   不会下注取值（分类为摊牌牌或证据不足）。
   */
  const weakSide = runPipeline(riverSpot(['Ac', 'Qs']));
  const weakCounts = weakSide.context.postflopFacts?.opponentRangeFacts?.counts ?? null;
  assert.notEqual(weakCounts, null, '必须有逐组合分类计数');
  assert.ok(
    weakCounts!.bluffCandidateCount < weakCounts!.weakerThanHeroCount,
    `「更弱」不得自动等于「诈唬候选」：诈唬候选 ${weakCounts!.bluffCandidateCount} vs 更弱 ${weakCounts!.weakerThanHeroCount}`,
  );
  assert.ok(weakCounts!.showdownCount > 0, '必须存在「有摊牌价值 ⇒ 不诈唬」的那一类');

  const strongSide = runPipeline(riverSpot(['9h', '9d']));
  const strongCounts = strongSide.context.postflopFacts?.opponentRangeFacts?.counts ?? null;
  assert.notEqual(strongCounts, null, '必须有逐组合分类计数');
  assert.ok(
    strongCounts!.valueBetCandidateCount < strongCounts!.strongerThanHeroCount,
    `「更强」不得自动等于「价值下注候选」：价值候选 ${strongCounts!.valueBetCandidateCount} vs 更强 ${strongCounts!.strongerThanHeroCount}`,
  );

  // 快照里必须分别列出这两组数（不能是同一个字段）
  const snapshot = weakSide.decision.diagnostics.postflop!.rangeCounts;
  assert.notEqual(snapshot, null, '快照必须带上逐组合计数');
  assert.ok(
    Number(snapshot!['bluffCandidateCount']) < Number(snapshot!['weakerThanHeroCount']),
    '快照里的两个量必须分开存放',
  );
});

test('RANGE-2：有摊牌价值的弱牌必须归为 SHOWDOWN，而不是 BLUFF_CANDIDATE', () => {
  /*
   * 分类规则（【公开扑克理论】）：比 Hero 弱、但牌力不低（档 ≤3，例如第二对子）
   * ⇒ 过牌摊牌，**不会**诈唬。只有「比 Hero 弱**且**没有摊牌价值（档 5 纯空气）」
   * 才是有诈唬动机的一类。
   */
  assert.equal(
    classifyRiverAction({ versusHero: 'WEAKER', tier: 2 }),
    RiverActionClass.SHOWDOWN,
    '第二对子级（档 2）比 Hero 弱，但会摊牌而不是诈唬',
  );
  assert.equal(
    classifyRiverAction({ versusHero: 'WEAKER', tier: 3 }),
    RiverActionClass.SHOWDOWN,
    '中对级（档 3）同理',
  );
  assert.equal(
    classifyRiverAction({ versusHero: 'WEAKER', tier: 4 }),
    RiverActionClass.UNCERTAIN,
    '底对/小对子（档 4）证据不足 ⇒ UNCERTAIN，不强行算成诈唬',
  );
  assert.equal(
    classifyRiverAction({ versusHero: 'WEAKER', tier: 5 }),
    RiverActionClass.BLUFF_CANDIDATE,
    '纯空气（档 5）才是诈唬候选',
  );
  // 比 Hero 强但只是中对级 ⇒ 摊牌牌，**不是**价值下注候选
  assert.equal(
    classifyRiverAction({ versusHero: 'STRONGER', tier: 3 }),
    RiverActionClass.SHOWDOWN,
    '比 Hero 强但不够下注价值 ⇒ 摊牌牌',
  );
});

test('RANGE-3：只有 BLUFF_CANDIDATE 才能计入 bluffCandidateCount（逐组合重算必须一致）', () => {
  const { context } = runPipeline(riverSpot(['Ac', 'Qs']));
  const facts = context.postflopFacts?.opponentRangeFacts ?? null;
  assert.notEqual(facts, null, '必须有范围事实');
  const counts = facts!.counts;
  assert.notEqual(counts, null, '必须有计数');

  /* 用同一份可达范围**独立复算**一遍：只有分类为 BLUFF_CANDIDATE 的组合计数 */
  const parsed = parseManualInput(riverSpot(['Ac', 'Qs']));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true);
  if (!gate.ok) throw new Error('unreachable');
  const built = buildDecisionContext({
    state: gate.state,
    rules: RULES,
    environment: 'MID_LOW_STAKES',
    asOf: 1_757_000_000_000,
  });
  const range = built.context.range;
  assert.notEqual(range, null, '必须有范围快照');
  /*
   * ⚠️ 快照里没有逐组合列表（`RangeSnapshot` 只有聚合量），
   * 因此这里改用**等价的结构性断言**：分类计数必须自洽，且必须能与
   * 「更弱组合数」区分开；同时「摊牌 + 证据不足 + 诈唬 + 价值」的构成
   * 不得超过可达组合总数。
   */
  const sum =
    counts!.clearValueCount +
    counts!.thinValueCount +
    counts!.showdownCount +
    counts!.uncertainCount +
    counts!.bluffCandidateCount;
  assert.equal(sum, counts!.reachableRangeCount, `分类必须构成完整分割，实际 ${sum} vs ${counts!.reachableRangeCount}`);
  assert.equal(
    counts!.valueBetCandidateCount,
    counts!.clearValueCount + counts!.thinValueCount,
    '价值下注候选 = 明确取值 + 薄价值',
  );
  assert.ok(counts!.bluffCandidateCount > 0, '本节点确实存在纯空气 ⇒ 应有诈唬候选');
  assert.ok(
    counts!.bluffCandidateCount < counts!.weakerThanHeroCount,
    '诈唬候选必须少于「更弱」组合（否则就是把 weaker 当成了 bluff）',
  );
});

/* ============================================================
 * SETTLEMENT-1..4：pending / returned / 作用域
 * ============================================================ */

test('SETTLEMENT-1：Hero 尚未行动 ⇒ pending > 0 且 returned = 0', () => {
  const { state } = runPipeline(riverSpot(['Ac', 'Qs']));
  const pot = computeLayeredPot(state);
  const pending = Object.values(pot.pendingUnmatched).reduce((a, b) => a + b, 0);
  const returned = Object.values(pot.returned).reduce((a, b) => a + b, 0);
  assert.ok(pending > 0, `尚未匹配必须 > 0，实际 ${pending}`);
  assert.equal(returned, 0, `决策前不得有最终退回，实际 ${JSON.stringify(pot.returned)}`);
  assert.equal(pot.roundClosed, false, '下注轮仍开着');
  const kinds = settlementEventsOf(pot, state.street).map((e) => e.kind);
  assert.ok(!kinds.includes('UNCALLED_BET_RETURN'), '事件流里不得出现退回');
  assert.ok(kinds.includes('PENDING_UNMATCHED'), '必须出现「尚待跟注」事件');
});

test('SETTLEMENT-2：Hero 跟注后 ⇒ pending = 0 且 returned = 0', () => {
  const { state, hero, legal } = runPipeline(riverSpot(['Ac', 'Qs']));
  const applied = applyAction(state, { playerId: hero.id, type: 'CALL', amount: legal.callCost });
  assert.equal(applied.ok, true, '跟注必须是合法动作');
  if (!applied.ok) return;
  const pot = computeLayeredPot(applied.state);
  assert.equal(Object.values(pot.pendingUnmatched).reduce((a, b) => a + b, 0), 0, '跟平后不得再有未匹配');
  assert.equal(Object.values(pot.returned).reduce((a, b) => a + b, 0), 0, '跟平后不得有退回');
  assert.equal(pot.roundClosed, true, '跟平后下注轮关闭');
});

test('SETTLEMENT-3：Hero 弃牌且轮次关闭 ⇒ 合法产生一次退回（且只有一次）', () => {
  const { state, hero } = runPipeline(riverSpot(['Ac', 'Qs']));
  const applied = applyAction(state, { playerId: hero.id, type: 'FOLD' });
  assert.equal(applied.ok, true, '弃牌必须是合法动作');
  if (!applied.ok) return;
  const pot = computeLayeredPot(applied.state);
  const returned = Object.values(pot.returned).reduce((a, b) => a + b, 0);
  assert.ok(returned > 0, '弃牌后那笔无人匹配的下注才成为真正的退回');
  assert.equal(Object.values(pot.pendingUnmatched).reduce((a, b) => a + b, 0), 0, '轮次关闭后不得再有 pending');
  assert.equal(pot.roundClosed, true);

  const events = settlementEventsOf(pot, applied.state.street);
  const returns = events.filter((e) => e.kind === 'UNCALLED_BET_RETURN');
  assert.equal(returns.length, 1, `退回事件必须恰好一次，实际 ${returns.length}`);
  assert.equal(returns[0]!.final, true, '退回事件必须标记为最终');
  assert.ok(
    events.every((e) => e.amount > 0),
    '结算事件的金额必须为正',
  );
  // 作用域：单挑 + 轮次关闭 ⇒ 允许简化未匹配路径，且简化式必须给出同一个数
  assert.equal(pot.scope, SettlementScope.HEADS_UP_CLOSED_ROUND);
  assert.equal(
    computeHeadsUpClosedRoundUnmatchedReturn(applied.state, returns[0]!.playerId!),
    returned,
    '简化未匹配式与台账口径必须一致',
  );
});

test('SETTLEMENT-4：多人 / 边池局面**不得**走单挑简化路径（且调用即抛错）', () => {
  /*
   * 三人不同筹码全下：A 1000 / B 400 / C 150 ⇒ 主池 + 边池 + 退回。
   * 这种局面的退回由**层界**决定，绝不能用「我的投入 − 别人最高投入」近似。
   */
  const input: ManualHandInput = {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: ['As', 'Ad'],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: 100,
    seatStacksBB: { UTG: 10, CO: 4, BB: 30 },
    actionHistory: [
      { position: 'UTG', type: 'ALL_IN', amountBB: 10 },
      { position: 'HJ', type: 'FOLD' },
      { position: 'CO', type: 'ALL_IN', amountBB: 4 },
      { position: 'BTN', type: 'FOLD' },
      { position: 'SB', type: 'FOLD' },
    ],
    environment: 'MID_LOW_STAKES',
    villain: { quickProfile: 'NORMAL', dynamicHint: 'UNKNOWN' },
  } as unknown as ManualHandInput;
  const parsed = parseManualInput(input);
  assert.equal(parsed.ok, true, `解析必须成功：${parsed.ok ? '' : JSON.stringify(parsed.issues)}`);
  if (!parsed.ok) return;
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, `门槛必须放行：${gate.ok ? '' : JSON.stringify(gate.issues)}`);
  if (!gate.ok) return;

  const scope = settlementScopeOf(gate.state);
  assert.equal(scope, SettlementScope.LEDGER_LAYERED, '多人全下局面必须走投入台账分层路径');

  const pot = computeLayeredPot(gate.state);
  assert.equal(pot.scope, SettlementScope.LEDGER_LAYERED, '返回值必须如实标出作用域');
  // 简化路径在这种局面必须**拒绝执行**（抛错），而不是给一个近似数
  assert.throws(
    () => assertHeadsUpUnmatchedScope(gate.state),
    /单挑/,
    '多人局面调用单挑简化断言必须抛错',
  );
  assert.throws(
    () => computeHeadsUpClosedRoundUnmatchedReturn(gate.state, 'BB'),
    /单挑/,
    '多人局面调用单挑简化退款必须抛错',
  );
  // 台账口径的守恒仍然成立
  const returned = Object.values(pot.returned).reduce((a, b) => a + b, 0);
  const pending = Object.values(pot.pendingUnmatched).reduce((a, b) => a + b, 0);
  assert.equal(
    pot.contested + returned + pending,
    pot.total,
    '可争夺 + 退回 + 未匹配 === 总投入',
  );
});
