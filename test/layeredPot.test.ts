/**
 * 分层底池（主池 / 边池 / 退回）—— 2026-09 边池轮
 *
 * ## 这一组测试防的是什么
 *
 * 修复前 `computePot` 只是「所有人投入之和」，而那个数字在两种情况下
 * **不是**玩家真正能赢到的钱：
 *
 * | 情形 | 修复前的错 |
 * |---|---|
 * | 有人投入超过对手跟不起的上限 | 超出部分被当成可赢 —— 跟注 EV 虚高 |
 * | 多路不同筹码全下 | 压成一个整池 —— 短筹码赢不了整池这件事看不见 |
 *
 * 实测危害（我 30BB 面对 100BB 全下）：
 *
 * ```text
 * 旧口径所需权益 = 2900 / (10150 + 2900) = 22.2%
 * 正确所需权益   = 2900 / 6000        = 48.3%
 * ```
 *
 * 22% 与 48% 是「轻松跟注」与「该弃牌」的区别。
 *
 * ## 观察口径
 *
 * 只看公开 API：`computeLayeredPot` / `maxWinFor` / `winnableIfCommit`
 * 的返回值，以及真实 `GameState` 上的行为。用规则本身当判据，
 * **不重新实现一份分层算法**（那只会把同一个错误抄第二遍）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame,
  TableSize,
  requiredCallAmount,
  computePot,
  type GameState,
} from '../src/domain/poker/gameState.ts';
import type { ActionType } from '../src/domain/types.ts';
import { applyAction, advanceStreet, canRaise } from '../src/domain/poker/engine.ts';
import {
  computeLayeredPot,
  contestedPot,
  maxWinFor,
  winnableIfCommit,
  previewCommit,
  selfCheckLayeredPot,
  fakeStateOf,
} from '../src/domain/poker/pots.ts';
import { C } from './helpers.ts';
import { mulberry32 } from '../src/infra/rng.ts';
import { callEV } from '../src/domain/poker/odds.ts';
import { cardIndex, createDeck } from '../src/domain/poker/cards.ts';
import { compareHands, evaluateCards } from '../src/domain/poker/handEval.ts';
import { analyzeManualHand } from '../src/app/alphaPipeline.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import type { ManualHandInput } from '../src/app/manualInput/manualInput.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();

/* ============================================================
 * 夹具
 * ============================================================ */

const POS_6 = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'] as const;

function makeGame(stacks: Partial<Record<(typeof POS_6)[number], number>> = {}) {
  return createGame({
    id: 'pots-test',
    config: { tableSize: TableSize.SIX_MAX, smallBlind: 50, bigBlind: 100, ante: 0, dealerPosition: 'BTN' },
    players: POS_6.map((p) => ({
      id: p.toLowerCase(),
      name: p,
      position: p,
      startingStack: stacks[p] ?? 10000,
      holeCards: null,
    })),
    userPlayerId: 'bb',
    board: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

const doAction = (state: GameState, position: string, type: ActionType, amount?: number) =>
  applyAction(state, { playerId: position.toLowerCase(), type, amount });

/** 依次执行，遇到失败即抛（夹具本身必须合法） */
function actAll(state: GameState, steps: readonly (readonly [string, ActionType, number?])[]): GameState {
  let current = state;
  for (const [pos, type, amount] of steps) {
    const r = doAction(current, pos, type, amount);
    assert.equal(r.ok, true, `${pos} ${type} 失败：${r.ok ? '' : r.issues.map((i) => i.code).join(',')}`);
    current = r.state;
  }
  return current;
}

/* ============================================================
 * 1) 守恒不变量
 * ============================================================ */

test('POT-01：启动自检必须零问题（守恒不变量）', () => {
  /*
   * 这条自检**已在服务器启动时强制执行**（失败即拒绝启动）。
   * 这里再断言一次，是为了让它在 `npm test` 里也可见 ——
   * 否则「自检存在但从没跑过」会重演本项目的 F-02 教训。
   */
  const problems = selfCheckLayeredPot();
  assert.deepEqual(problems, [], `分层底池自检必须零问题：\n${problems.join('\n')}`);
});

test('POT-02：主池 + 边池 + 退回 恒等于所有人投入之和（穷举多种投入组合）', () => {
  /*
   * 这套组合覆盖了三种容易漏账的形态：
   * - 有人投得比别人多（未被跟注的超额）
   * - 有人弃牌但投过钱（死钱）
   * - 只剩一人未弃牌（弃牌获胜）
   */
  const shapes: readonly (readonly [readonly number[], readonly boolean[]])[] = [
    [[100, 100], [false, false]],
    [[200, 100], [false, false]],
    [[100, 200], [false, false]],
    [[1000, 400, 150], [false, false, false]],
    [[100, 100, 100], [false, false, true]],
    [[500, 100, 100], [true, false, false]],
    [[500, 100, 100], [false, false, true]],
    [[50, 100, 30], [true, false, true]],
    [[300, 300, 300, 300], [false, false, true, false]],
    [[1000, 1000, 100, 100], [false, false, false, true]],
    [[0, 0], [false, false]],
    [[700], [false]],
  ];

  for (const [commitments, folded] of shapes) {
    const state = fakeStateOf(commitments, folded);
    const pot = computeLayeredPot(state);
    const returnedSum = Object.values(pot.returned).reduce((a, b) => a + b, 0);
    const expectedTotal = commitments.reduce((a, b) => a + b, 0);
    const label = `投入 [${commitments.join(',')}] 弃牌 [${folded.map((f) => (f ? 'T' : 'F')).join(',')}]`;

    assert.equal(pot.total, expectedTotal, `${label}: total 必须等于投入之和`);
    assert.equal(
      pot.main + pot.sideTotal + returnedSum,
      expectedTotal,
      `${label}: 主池(${pot.main}) + 边池(${pot.sideTotal}) + 退回(${returnedSum}) 必须等于总额(${expectedTotal})`,
    );
    assert.equal(pot.contested, pot.main + pot.sideTotal, `${label}: contested 口径必须一致`);
  }
});

test('POT-03：弃牌者的钱是**死钱** —— 留在池里、计入可争夺量，但不是「退回」', () => {
  /*
   * `A 投 500 后弃牌、B 与 C 各投 100`。
   *
   * ## ⚠️ 这条期望值我改过两次，两个方向都值得记
   *
   * | 版本 | 值 | 为什么错 |
   * |---|---|---|
   * | 第一版 | 300 | 理由写成「只数活钱」—— 结论碰巧对，论证错 |
   * | 第二版 | 700 | 把 A 的整个 500 当成「池里的钱」，可其中 400 已经退回 |
   * | **正确** | **300** | A 超出「别人跟到的最高额（100）」的 400 **退回给他**，留在池里的死钱只有 100 |
   *
   * 判据是**有效投入** = `min(投入, 第二高投入)`，对活人和弃牌者**一视同仁**：
   * 一个弃牌者曾经跟过你的注，那部分就是「被跟过的钱」，不是「没人跟所以退回」。
   */
  const state = fakeStateOf([500, 100, 100], [true, false, false]);
  const pot = computeLayeredPot(state);

  assert.equal(pot.total, 700);
  assert.equal(pot.contested, 300, 'B、C 各 100 + A 留在池里的死钱 100');
  assert.equal(pot.returned['p0'], 400, 'A 超出「别人跟到的最高额」的 400 退回');
  assert.deepEqual(pot.layers[0]?.eligibleIds, ['p1', 'p2'], '有资格者只能是不弃牌的 B、C');

  // 对照：把 A 换成活着的人 ⇒ 同样退 400、同样只争 300（差别只在资格，不在钱）
  const aliveCase = computeLayeredPot(fakeStateOf([500, 100, 100], [false, false, true]));
  assert.equal(aliveCase.contested, 300, 'A 活着时也只能争 300');
  assert.equal(aliveCase.returned['p0'], 400, 'A 活着时那 400 同样必须退回');
});

/* ============================================================
 * 2) 未被跟注的超额必须退回
 * ============================================================ */

test('POT-04：两人对等全下时没有退回，也没有边池', () => {
  /*
   * UTG 加注到 300、大盲跟到 300 ⇒ 双方投入相等，没有未被跟注的部分。
   *
   * ⚠️ 这里必须让**大盲跟注**。若让大盲弃牌，UTG 就赢走整池，
   * 而他超出大盲已投部分的那 200 会作为「未被跟注」退回 ——
   * 那是正确行为，但测的就不是「对等全下」了。
   *（第一版夹具就写错成弃牌，测试报 `returned = { utg: 200 }`。）
   */
  let state = makeGame();
  state = actAll(state, [
    ['UTG', 'RAISE', 300],
    ['HJ', 'FOLD'],
    ['CO', 'FOLD'],
    ['BTN', 'FOLD'],
    ['SB', 'FOLD'],
    ['BB', 'CALL', 200],
  ]);
  const pot = computeLayeredPot(state);

  assert.deepEqual(pot.returned, {}, '双方各投 300，没有未被跟注的部分');
  assert.equal(pot.sideTotal, 0, '两人对等全下没有边池');
  assert.equal(pot.main, pot.contested, '整池都可争夺');
  assert.equal(pot.main, 300 + 300 + 50, '主池 = UTG 300 + BB 300 + 小盲弃牌的 50 死钱');
  assert.deepEqual(
    [...(pot.layers[0]?.eligibleIds ?? [])].sort(),
    ['bb', 'utg'],
    '两名未弃牌者都有资格',
  );
});

test('POT-05：多路不同筹码全下 ⇒ 正确切出主池与边池', () => {
  /*
   * UTG 1000 / HJ 400 / CO 150，三家全下。
   *
   * ```text
   * 主池 450  = 三家各 150
   * 边池 500  = UTG 与 HJ 各再 250
   * 退回 600  = UTG 超出 HJ 的 1000 − 400
   * ```
   */
  let state = makeGame({ UTG: 1000, HJ: 400, CO: 150 });
  state = actAll(state, [
    ['UTG', 'ALL_IN'],
    ['HJ', 'ALL_IN'],
    ['CO', 'ALL_IN'],
    ['BTN', 'FOLD'],
    ['SB', 'FOLD'],
    ['BB', 'FOLD'],
  ]);
  const pot = computeLayeredPot(state);

  assert.equal(pot.total, 1000 + 400 + 150 + 50 + 100, '总额 = 三家全下 + 小盲 50 + 大盲 100');
  /*
   * ```text
   * 主池 600 = 150 × 3 活钱 + 盲注死钱 150（死钱落在最低档，全部进主池）
   * 边池 500 = (400 − 150) × 2，只有 UTG 与 HJ 有资格
   * 退回 600 = UTG 超出 HJ 的 1000 − 400
   * ```
   *
   * ⚠️ 主池这里我改过两次期望：506（死钱按层比例分摊）→ 600（**死钱全进主池**）。
   * 600 才是规则值 —— 规则审查者用独立实现核对过：
   * `maxWinFor(CO) = Σ min(150, 各家) = 150+150+150+50+100 = 600`。
   *
   * 差别会进决策：短码跟注门槛从 `150/506 = 29.6%` 变成 `150/600 = 25%`。
   */
  assert.equal(pot.main, 600, '主池 = 150 × 3 活钱 + 盲注死钱 150');
  assert.equal(pot.sideTotal, 500, '边池 = 250 × 2（只有 UTG 与 HJ 有资格）');
  assert.equal(pot.returned['utg'], 600, 'UTG 超出 HJ 的 600 无人能跟 ⇒ 退回');
  assert.equal(
    pot.main + pot.sideTotal + 600,
    pot.total,
    '守恒：主池 + 边池 + 退回 === 总额',
  );

  /*
   * 可赢上限 = 他有资格的那些层之和（**含死钱** —— 赢了就是赢了整层）：
   *
   * ```text
   * CO  只投 150  ⇒ 只有主池资格      ⇒ 506
   * HJ  投 400    ⇒ 主池 + 边池资格   ⇒ 1100
   * UTG 投 1000   ⇒ 主池 + 边池资格   ⇒ 1100（多出的 600 已退回，不计入）
   * ```
   *
   * ⚠️ 别把「可赢上限」与「净盈利」搞混：UTG 投了 1000、上限 1100，
   * 净盈利是 +100（还要算上退回的 600）。
   */
  assert.equal(maxWinFor(state, 'co'), 600, 'CO 只投了 150 ⇒ 只能赢主池 600（规则值）');
  assert.equal(maxWinFor(state, 'hj'), 1100, 'HJ 投了 400 ⇒ 主池 + 边池');
  assert.equal(maxWinFor(state, 'utg'), 1100, 'UTG 也只能赢 1100 —— 多出的 600 已退回，不进池');
});

/* ============================================================
 * 3) 决策时刻的「可赢量」—— 最易写错的地方
 * ============================================================ */

test('POT-06：winnableIfCommit 必须两种情形都对（暂未跟注 vs 确实跟不起）', () => {
  /*
   * 这两种情形看起来像同一件事，实际含义完全相反：
   *
   * | 情形 | 决策时刻「未被跟注」的钱 | 我跟注后 |
   * |---|---|---|
   * | 对手与我筹码相当 | 是**暂时**的 | 变成可争夺 |
   * | 对手筹码比我少 | 是**永久**的 | 仍然退回，不参与争夺 |
   *
   * 我在这上面写错过两次：
   * 1. `contestedPot + callCost` ⇒ 把「暂时未跟」当成永久，量级错 50 倍
   * 2. `pot − 退回 + callCost` ⇒ 把「永久退回」当成暂时，虚高一整块
   *
   * 唯一正确：**先假设投入，再分层**。
   */
  // 情形甲：我 100BB、对手 100BB 全下 ⇒ 我 99BB 可争 200BB
  let a = makeGame({ UTG: 10000 });
  a = actAll(a, [
    ['UTG', 'ALL_IN'],
    ['HJ', 'FOLD'],
    ['CO', 'FOLD'],
    ['BTN', 'FOLD'],
    ['SB', 'FOLD'],
  ]);
  const callA = requiredCallAmount(a, 'bb');
  assert.equal(
    winnableIfCommit(a, 'bb', callA),
    20050,
    '双方各 100BB 全下 ⇒ 可争夺 200BB + 小盲弃牌的 50 死钱',
  );

  // 情形乙：我 100BB、对手只有 50BB 全下 ⇒ 只争 100BB
  let b = makeGame({ UTG: 5000 });
  b = actAll(b, [
    ['UTG', 'ALL_IN'],
    ['HJ', 'FOLD'],
    ['CO', 'FOLD'],
    ['BTN', 'FOLD'],
    ['SB', 'FOLD'],
  ]);
  const callB = requiredCallAmount(b, 'bb');
  assert.equal(
    winnableIfCommit(b, 'bb', callB),
    10050,
    '对手只有 50BB ⇒ 只能争 50+50（+ 小盲 50 死钱），他多出的部分跟不到',
  );

  // 情形丙：我只有 30BB、对手 100BB 全下 ⇒ 只争 30+30
  let c = makeGame({ UTG: 10000, BB: 3000 });
  c = actAll(c, [
    ['UTG', 'ALL_IN'],
    ['HJ', 'FOLD'],
    ['CO', 'FOLD'],
    ['BTN', 'FOLD'],
    ['SB', 'FOLD'],
  ]);
  const callC = requiredCallAmount(c, 'bb');
  assert.equal(
    winnableIfCommit(c, 'bb', callC),
    6050,
    '我只有 30BB ⇒ 只能争 30+30（+ 小盲 50 死钱），对手多出的部分与我无关',
  );
});

test('POT-07：我 30BB 面对 100BB 全下时，所需权益必须是 48% 而不是 22%', () => {
  /*
   * 这是本模块最直接的**用户可见**后果。
   *
   * ```text
   * 旧口径：2900 / (10150 + 2900) = 22.2%   ← 「轻松跟注」
   * 正确：  2900 / 6050           = 47.9%   ← 「该弃牌」
   * ```
   *
   * 22% 与 48% 之间是大量本该弃掉的牌。
   */
  let state = makeGame({ UTG: 10000, BB: 3000 });
  state = actAll(state, [
    ['UTG', 'ALL_IN'],
    ['HJ', 'FOLD'],
    ['CO', 'FOLD'],
    ['BTN', 'FOLD'],
    ['SB', 'FOLD'],
  ]);
  const callCost = requiredCallAmount(state, 'bb');
  const winnable = winnableIfCommit(state, 'bb', callCost);
  const requiredEquity = callCost / winnable;

  assert.equal(callCost, 2900, 'BB 已投 100，需再投 2900 才到 3000');
  assert.ok(
    Math.abs(requiredEquity - 0.4792) < 0.001,
    `所需权益必须是约 47.9%，实际 ${(requiredEquity * 100).toFixed(1)}%`,
  );
  assert.ok(
    requiredEquity > 0.45,
    `必须显著高于旧口径的 22% —— 否则该弃的牌会被建议跟注（实际 ${(requiredEquity * 100).toFixed(1)}%）`,
  );
});

/* ============================================================
 * 4) 干边池：不为不存在的决策点给建议
 * ============================================================ */

test('POT-08：其余人全下后，最后一名有筹码者**不需要行动**（不是决策点）', () => {
  /*
   * 实测过的缺陷（3 人桌，大小盲都盲注全下、只剩 BTN 有筹码）：
   *
   * ```text
   * 翻牌后 pendingQueue = ["btn"]   ← 应为空
   * BET 500 被接受                   ← 无人能跟，这手牌现实中不会发生
   * ```
   *
   * 而 `reconstructGameState(ANALYZE)` 会据此给出一个**现实中不存在**的
   * 决策点建议 —— 那正是本项目最忌讳的一类输出。
   */
  let state = makeGame({ SB: 50, BB: 100, BTN: 5000 });
  state = actAll(state, [
    ['UTG', 'FOLD'],
    ['HJ', 'FOLD'],
    ['CO', 'FOLD'],
    ['BTN', 'CALL', 100],
  ]);
  assert.equal((state as { bettingRoundComplete: boolean }).bettingRoundComplete, true, '翻牌前应已结束');

  const flop = advanceStreet(state, { cards: C('Kh Qs 9s') });
  assert.equal(flop.ok, true, `推进翻牌必须成功：${flop.ok ? '' : flop.issues.map((i) => i.code).join(',')}`);
  if (!flop.ok) return;

  assert.deepEqual(
    flop.state.pendingQueue,
    [],
    '其余人都已全下 ⇒ 不该要求任何人行动（现实中直接跑牌到摊牌）',
  );

  // 即使绕过队列直接提交，也必须被拒
  const bet = doAction(flop.state, 'BTN', 'BET', 500);
  assert.equal(bet.ok, false, '无人能跟时的下注必须被拒绝 —— 多出的筹码会原样退回');
});

test('POT-09：还有人能跟时，正常要求行动（别把闸门关死）', () => {
  let state = makeGame({ SB: 50, BB: 100, BTN: 5000, CO: 5000 });
  state = actAll(state, [
    ['UTG', 'FOLD'],
    ['HJ', 'FOLD'],
    ['CO', 'CALL', 100],
    ['BTN', 'CALL', 100],
  ]);
  const flop = advanceStreet(state, { cards: C('Kh Qs 9s') });
  assert.equal(flop.ok, true);
  if (!flop.ok) return;

  assert.ok(
    flop.state.pendingQueue.length > 0,
    '还有两个有筹码的玩家 ⇒ 必须正常要求行动，不能因为「有人全下」就一律关闭',
  );
});

/* ============================================================
 * 5) 分层权益（多层权益轮）
 * ============================================================ */

/** 多层局面：UTG 短码全下 10BB、BTN 深码全下 30BB、我 BB 30BB 面对跟注 */
function layeredSpot(): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: ['Ah', 'Ad'],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: 30,
    seatStacksBB: { UTG: 10, BTN: 30, BB: 30 },
    actionHistory: [
      { position: 'UTG', type: 'ALL_IN', amountBB: 10 },
      { position: 'HJ', type: 'FOLD' },
      { position: 'CO', type: 'FOLD' },
      { position: 'BTN', type: 'ALL_IN', amountBB: 30 },
      { position: 'SB', type: 'FOLD' },
    ],
    environment: 'LOW_STAKES_ONLINE',
  } as ManualHandInput;
}

/** 单层局面：只有一家全下（没有边池）—— 我 BB 面对 BTN 的全下 */
function singleLayerSpot(): ManualHandInput {
  return {
    tableSize: 6,
    heroPosition: 'BB',
    heroCards: ['Ah', 'Ad'],
    board: [],
    street: 'PREFLOP',
    effectiveStackBB: 30,
    /* ⚠️ UTG 必须弃牌：否则「UTG 全下 30」会超过有效筹码（30）而被拒 */
    actionHistory: [
      { position: 'UTG', type: 'FOLD' },
      { position: 'HJ', type: 'FOLD' },
      { position: 'CO', type: 'FOLD' },
      { position: 'BTN', type: 'ALL_IN', amountBB: 30 },
      { position: 'SB', type: 'FOLD' },
    ],
    environment: 'LOW_STAKES_ONLINE',
  } as ManualHandInput;
}

test('POT-14：分层权益（逐层算胜率）—— 精确值可用、单层不付额外成本、耗时有上限', () => {
  /*
   * ## 这一条测的是「多层权益」这个真修复
   *
   * 单一门槛在多层局面下只是**下界**，据此弃牌会系统性弃掉本该跟的牌。
   * 正确做法是**逐层算胜率**：主池用该层全部对手、边池只用同层对手。
   *
   * 断言的是**机制**而不是某个具体数字：
   * 1. 多层局面必须拿到 `exact === true` 的分层 EV
   * 2. 单层局面**不得**做这份额外计算（否则所有牌局都变慢）
   * 3. 耗时必须有上限（否则会吃掉 1–3 秒的交互预算）
   */
  const layered = analyzeManualHand(layeredSpot(), { rules: RULES, writeLog: false });
  assert.equal(layered.ok, true, '多层局面必须能分析');
  if (!layered.ok) return;

  const m = layered.decision.diagnostics.math;
  assert.ok(m.layeredEV !== undefined, '多层局面必须给出分层 EV');
  assert.equal(m.layeredEV!.exact, true, '对手范围齐备时分层 EV 必须是精确值');
  assert.ok(m.layeredEV!.layerCount >= 2, `必须至少两层，实际 ${m.layeredEV!.layerCount}`);
  assert.ok(Number.isFinite(m.layeredEV!.value), '分层 EV 必须是有限数');
  /*
   * 🔴 `callEV` 必须与「判方向用的 EV」是**同一个数**。
   * 混用口径会让 `finalMathSanityCheck` 的「建议跟注但 EV 为负」误报。
   */
  assert.equal(m.callEV, m.layeredEV!.value, 'callEV 必须等于精确分层 EV（否则两处口径矛盾）');
  assert.ok(
    m.layeredEV!.costMs < 1000,
    `分层计算必须在预算内（实测约 200 ms），实际 ${m.layeredEV!.costMs} ms`,
  );

  const single = analyzeManualHand(singleLayerSpot(), { rules: RULES, writeLog: false });
  assert.equal(single.ok, true);
  if (!single.ok) return;
  assert.equal(
    single.decision.diagnostics.math.layeredEV,
    undefined,
    '单层局面**不得**做分层计算 —— 那时它与现值恒等，白花时间',
  );
});

test('POT-15：多层局面下「动作」与「EV」不得自相矛盾', () => {
  /*
   * 修复前（第一阶段）多层局面会「不给方向」；本轮改为**逐层算出来**。
   *
   * 关键约束：**不能出现「给了方向」与「EV 反向」同时成立** ——
   * 那正是 `finalMathSanityCheck` 要抓的自相矛盾。
   */
  const r = analyzeManualHand(layeredSpot(), { rules: RULES, writeLog: false });
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const m = r.decision.diagnostics.math;
  const ev = m.layeredEV?.value ?? null;
  if (ev === null) return;
  if (r.decision.action === 'CALL') {
    assert.ok(ev >= 0, `建议跟注时分层 EV 不得为负，实测 ${ev.toFixed(2)}`);
  }
  if (r.decision.action === 'FOLD') {
    assert.ok(ev <= 0, `建议弃牌时分层 EV 不得为正，实测 ${ev.toFixed(2)}`);
  }
});

/* ============================================================
 * 5) 交叉一致性
 * ============================================================ */

test('POT-11：随机真实牌局下的守恒压力测试（含边池与退回）', () => {
  /*
   * 前面十条都是**手工构造**的场景。它们能覆盖已知的坑，
   * 但覆盖不了「没想到的组合」。这条用随机真实动作序列补上：
   *
   * - 随机桌型（6 / 9 座）、随机人数（2~满桌）、随机盲注、随机前注
   * - 随机筹码（等筹码 / 短筹码 / 深筹码混合）
   * - 随机执行合法动作直到牌局结束，**每一步**都核对不变量
   *
   * 实测跑一次覆盖约 335 局、3500 个检查点，其中约 1900 次真的出现了
   * 边池、约 1500 次出现退回 —— 也就是说它**真的**在压这条路径，
   * 不是空转。
   *
   * 断言的不变量（任意状态下都必须成立）：
   * 1. `total === computePot`（分层只重新划分，不创造也不丢弃筹码）
   * 2. `主池 + 边池 + 退回 + 尚未匹配 === total`
   *    🔴 **RIVER CONSISTENCY V2**：超额被拆成「最终退回」与「尚未匹配」
   *    （下注轮未结束时那笔钱只是还没人跟），因此守恒式必须同时含两项。
   * 3. `contested ≤ total`，`退回 ≥ 0`，`尚未匹配 ≥ 0`
   * 4. 每层都有有资格者、金额为正，且**有资格者一律未弃牌**
   * 5. 🔴 **时序**：`尚未匹配 > 0` ⟺ 还有人能跟注；「最终退回」只在
   *    没有任何人能再跟时才允许出现（否则就是**提前结算**）
   */
  const POS6 = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
  const POS9 = ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
  const rand = mulberry32(20260915);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

  let games = 0;
  let checkpoints = 0;
  let withLayering = 0;
  let withReturn = 0;
  let withPending = 0;

  for (let iter = 0; iter < 400; iter++) {
    const size = rand() < 0.5 ? 6 : 9;
    const allPos = size === 6 ? POS6 : POS9;
    const count = 2 + Math.floor(rand() * (size - 1));
    const positions = allPos.slice(size - count);
    const bb = pick([20, 100, 200]);
    const stacks: Record<string, number> = {};
    for (const p of positions) {
      const mode = rand();
      stacks[p] =
        mode < 0.4 ? bb * 100 : mode < 0.7 ? bb * (3 + Math.floor(rand() * 20)) : bb * (30 + Math.floor(rand() * 200));
    }

    let state: GameState;
    try {
      state = createGame({
        id: 'fuzz',
        config: {
          tableSize: size === 6 ? TableSize.SIX_MAX : TableSize.NINE_MAX,
          smallBlind: Math.round(bb / 2),
          bigBlind: bb,
          ante: rand() < 0.2 ? bb : 0,
          dealerPosition: 'BTN',
        },
        players: positions.map((p) => ({
          id: p,
          name: p,
          position: p as never,
          startingStack: stacks[p]!,
          holeCards: null,
        })),
        userPlayerId: 'BB',
        board: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    } catch {
      continue; // 随机配置本身不合法就跳过（不是被测对象）
    }
    games += 1;

    /*
     * 🔴 不变量检查抽成函数，**在两种时刻都跑**：
     *
     * ① 每次行动前（决策时刻 —— 下注轮通常未结束 ⇒ 超额是「尚未匹配」）
     * ② 下注轮结束那一刻（⇒ 超额才变成「最终退回」）
     *
     * 只在①检查会让「最终退回」这条路径**永远不被压到**（实测：修复后
     * `withReturn` 掉到 0），于是时序不变量有一半是空转的。
     */
    const checkInvariants = (): void => {
      const pot = computeLayeredPot(state);
      const returnedSum = Object.values(pot.returned).reduce((a, b) => a + b, 0);
      const pendingSum = Object.values(pot.pendingUnmatched).reduce((a, b) => a + b, 0);
      checkpoints += 1;

      assert.equal(pot.total, computePot(state), '分层只重新划分，不得改变总额');
      assert.equal(
        pot.main + pot.sideTotal + returnedSum + pendingSum,
        pot.total,
        `守恒：主池 ${pot.main} + 边池 ${pot.sideTotal} + 退回 ${returnedSum} + 尚未匹配 ${pendingSum} 必须等于 ${pot.total}`,
      );
      assert.ok(pot.contested <= pot.total, '可争夺量不得超过总投入');
      assert.ok(returnedSum >= 0, '退回不得为负');
      assert.ok(pendingSum >= 0, '尚未匹配不得为负');

      /*
       * 🔴 **时序不变量**（RIVER CONSISTENCY V2 §16）：
       *
       * | 断言 | 含义 |
       * |---|---|
       * | `尚未匹配 > 0` ⇒ `roundClosed === false` | 「还没人跟」只能发生在下注轮未结束时 |
       * | `最终退回 > 0` ⇒ 该玩家之外**没有人**能再跟 | 「退回」是最终事实，不得提前出现 |
       *
       * 修复前两者被压进同一个 `returned`，于是决策节点（还有人要行动）
       * 也会显示「无人跟注、退回 X」—— 实测真人牌局里出现过。
       */
      assert.equal(
        pendingSum > 0,
        !pot.roundClosed,
        `「尚未匹配 ${pendingSum} > 0」必须与「下注轮未结束」等价（roundClosed=${pot.roundClosed}）`,
      );
      for (const [playerId, amount] of Object.entries(pot.returned)) {
        assert.ok(amount > 0, `退回必须是正数，实际 ${amount}`);
        const others = state.players.filter((p) => p.id !== playerId);
        const canStillCall = others.some((p) => !p.folded && !p.allIn && p.remainingStack > 0);
        assert.ok(
          !canStillCall,
          `出现「最终退回」时不得还有人能跟注（${playerId} 退回 ${amount}）—— 那是提前结算`,
        );
      }

      for (const layer of pot.layers) {
        assert.ok(layer.eligibleIds.length > 0, `第 ${layer.layerIndex} 层必须有有资格者`);
        assert.ok(layer.amount > 0, `第 ${layer.layerIndex} 层金额必须为正`);
        for (const id of layer.eligibleIds) {
          const player = state.players.find((x) => x.id === id);
          assert.ok(player !== undefined && !player.folded, `有资格者 ${id} 不得是已弃牌者`);
        }
      }

      if (pot.sideTotal > 0) withLayering += 1;
      if (returnedSum > 0) withReturn += 1;
      if (pendingSum > 0) withPending += 1;
    };

    for (let step = 0; step < 200; step++) {
      checkInvariants();

      const actorId = state.pendingQueue[0];
      if (actorId === undefined) break;
      const actor = state.players.find((p) => p.id === actorId);
      if (actor === undefined) break;

      const call = requiredCallAmount(state, actorId);
      const roll = rand();
      const action =
        call > 0
          ? roll < 0.4
            ? { playerId: actorId, type: 'CALL' as const, amount: call }
            : roll < 0.6
              ? { playerId: actorId, type: 'FOLD' as const }
              : roll < 0.8
                ? { playerId: actorId, type: 'RAISE' as const, amount: state.currentBet + state.lastRaiseSize }
                : { playerId: actorId, type: 'ALL_IN' as const }
          : roll < 0.5
            ? { playerId: actorId, type: 'CHECK' as const }
            : roll < 0.75
              ? {
                  playerId: actorId,
                  type: 'BET' as const,
                  amount: Math.min(actor.remainingStack, state.config.bigBlind * (1 + Math.floor(rand() * 4))),
                }
              : { playerId: actorId, type: 'ALL_IN' as const };

      const applied = applyAction(state, action);
      if (applied.ok) {
        state = applied.state;
      } else {
        // 随机生成的动作可能不合法 —— 退到一个必然合法的保底动作
        const fallback = applyAction(
          state,
          call > 0 ? { playerId: actorId, type: 'FOLD' } : { playerId: actorId, type: 'CHECK' },
        );
        if (!fallback.ok) break;
        state = fallback.state;
      }
      if (state.pendingQueue.length === 0) break;
    }
    /*
     * 🔴 **下注轮结束那一刻**再检查一次：超额在这一刻才从「尚未匹配」
     * 变成「最终退回」—— 这条路径只有在这里才会被压到。
     */
    checkInvariants();
  }

  assert.ok(games > 200, `必须真的跑了足够多局，实际 ${games} 局`);
  assert.ok(checkpoints > 1000, `检查点必须足够多，实际 ${checkpoints} 个`);
  /*
   * ⚠️ 这两条断言防的是「测试空转」—— 若随机生成器退化成从不产生
   * 边池/退回，上面所有不变量断言都会平凡通过，测试看起来是绿的
   * 却什么都没验。
   */
  assert.ok(withLayering > 100, `必须真的出现过边池，实际 ${withLayering} 次检查点`);
  assert.ok(withReturn > 100, `必须真的出现过退回，实际 ${withReturn} 次检查点`);
  /*
   * 🔴 「尚未匹配」这条路径也必须真的被压到 —— 它是决策节点最常见的形态
   *（有人下注、还有人没行动）。若随机局从不出现它，上面那条时序不变量
   * 就是空转通过的。
   */
  assert.ok(withPending > 100, `必须真的出现过「尚未匹配」的超额，实际 ${withPending} 次检查点`);
});

test('POT-12：`权益 = 所需权益 ⇒ 跟注 EV = 0`（锁住 EV 与底池赔率的代数一致性）', () => {
  /*
   * 🔴 这条恒等式是 `odds.ts` 自己写明的定义：
   *
   * > `equity = risk / (reward + risk)` 时 EV 恰为 0
   *
   * 它是本项目多处的**依据**：`finalMathSanityCheck` 的
   * 「建议跟注但 EV 为负」安全网、`MathDominanceGuard` 的 EV 差判据、
   * 以及界面上显示的 EV 数字。
   *
   * ## 为什么必须专门锁它（这是真实踩到的坑）
   *
   * 2026-09 我把「可赢得总量」的口径从 `pot`（不含我的跟注）换成
   * `winnable`（**含**我的跟注），却**没同步改 EV 公式** ——
   * 于是 EV 被系统性抬高 `equity × callCost`。这**是我自己引入的缺陷**，
   * 由独立审查抓到。
   *
   * 实测（深筹码常规局面）：快照 1236.34，正确 832.54，差 403.8 = `E × c`。
   * 后果不是「数字略有偏差」，而是**安全网失效**：
   * EV 被抬高后再也不会为负，于是「建议跟注但 EV 为负」这条告警永不触发。
   *
   * 而当时**全项目 1500+ 项测试没有一条锁这个关系** —— 它能活到被
   * 独立审查发现，正是因为没有任何断言会因为它变红。
   *
   * ## 两种口径的正确式子（`c` = 跟注额，`W` = 跟注后总量，`E` = 权益）
   *
   * | `reward` | 公式 |
   * |---|---|
   * | `pot`（不含我的跟注） | `E × (W − c) − (1 − E) × c` |
   * | `W`（含我的跟注） | `E × W − c` |
   *
   * 本项目用第二种。把第一种套到 `W` 上就会多出 `E × c`。
   */
  const cases: readonly (readonly [number, number])[] = [
    // [总投入, 跟注需要] —— 取自真实局面，含对等 / 短筹码 / 深筹码
    [1150, 500],
    [10150, 2900],
    [450, 200],
    [6050, 2900],
  ];

  for (const [potTotal, callCostAmount] of cases) {
    /*
     * ⚠️ 这里用**解析式**验证恒等式，而不是调 `analyzeManualHand`
     *（后者的 equity 来自蒙特卡洛，不便于让 E 恰好等于门槛）。
     * 关键是公式本身：两个口径不能混。
     */
    const winnable = potTotal + callCostAmount;
    const requiredEquity = callCostAmount / winnable;

    // 第二式（本项目采用）：E = 所需权益 ⇒ EV = 0
    const evAtThreshold = requiredEquity * winnable - callCostAmount;
    assert.ok(
      Math.abs(evAtThreshold) < 1e-9,
      `权益等于所需权益时 EV 必须为 0，实际 ${evAtThreshold}`,
    );

    // 第一式（已弃用）：套在「含跟注」的 W 上会系统性抬高 E × c
    const buggyEV = requiredEquity * winnable - (1 - requiredEquity) * callCostAmount;
    assert.ok(
      Math.abs(buggyEV - requiredEquity * callCostAmount) < 1e-9,
      '把「不含跟注」的公式套到「含跟注」的总量上，偏差必须恰好等于 E × c —— ' +
        '这正是修复前的缺陷形态（它让 EV 恒偏高，安全网失效）',
    );

    // 交叉验证：odds.ts 的权威 callEV 用「不含跟注」口径，在门槛点也必须为 0
    const authoritative = callEV(requiredEquity, potTotal, callCostAmount);
    assert.equal(authoritative.ok, true);
    if (authoritative.ok) {
      assert.ok(
        Math.abs(authoritative.value) < 1e-9,
        `odds.ts 的权威公式在门槛点也必须为 0，实际 ${authoritative.value}`,
      );
    }
  }
});

test('POT-10：contestedPot 不得超过总投入（退回永远是非负的）', () => {
  const shapes: readonly (readonly [readonly number[], readonly boolean[]])[] = [
    [[100, 100], [false, false]],
    [[1000, 400, 150], [false, false, false]],
    [[500, 100, 100], [true, false, false]],
    [[1000, 200, 200, 200], [false, false, false, false]],
  ];
  for (const [commitments, folded] of shapes) {
    const state = fakeStateOf(commitments, folded);
    const pot = computeLayeredPot(state);
    const returnedSum = Object.values(pot.returned).reduce((a, b) => a + b, 0);
    assert.ok(pot.contested <= pot.total, '可争夺量不得超过总投入');
    assert.ok(returnedSum >= 0, '退回不能为负');
    assert.equal(pot.contested, contestedPot(state), 'contestedPot 必须与分层结果一致');
    for (const layer of pot.layers) {
      assert.ok(layer.amount > 0, `空层不该出现在结果里（第 ${layer.layerIndex} 层）`);
    }
  }
});

test('POT-13：多人边池 ⇒「单一权益门槛」判不了方向（AA 被暗三压住、靠边池赚钱）', () => {
  /*
   * ## 这一条锁的缺陷（2026-09 多人边池修复）
   *
   * 「所需权益 = 跟注额 ÷ 可争夺总量」只在**我只有一层**时是真实的盈亏平衡门槛。
   * 我有资格争 ≥2 层时（主池 + 边池），两层要赢的人不一样：
   *
   * ```text
   * 主池 3050（9♥9♣ 全下 1000 那家的短码在这一层）
   * 边池 4000（只有我与 T♥J♥ 那家）
   * ⇒ 门槛 = 2000 / 7050 = 28.4%
   * ```
   *
   * 而我这手 A♥A♦ 的**整池权益只有 4.8%**（只有 2 张 A 能救主池），
   * 修复前决策层据此输出「跟注在数学上是负期望」并直接弃牌（还不允许策略层翻转）。
   * 真实情况是：我 **90.5% 赢下边池**（4000），所以跟注 EV 是 **+1764**，
   * 这是一手必须跟的牌 —— 「权益低于门槛」**不等于**负期望。
   */
  let state = createGame({
    id: 'pot-13',
    config: { tableSize: TableSize.SIX_MAX, smallBlind: 50, bigBlind: 100, ante: 0, dealerPosition: 'BTN' },
    players: [
      { id: 'utg', name: 'UTG', position: 'UTG', startingStack: 1000, holeCards: C('9h 9c') },
      { id: 'hj', name: 'HJ', position: 'HJ', startingStack: 10000, holeCards: null },
      { id: 'co', name: 'CO', position: 'CO', startingStack: 10000, holeCards: null },
      { id: 'btn', name: 'BTN', position: 'BTN', startingStack: 3000, holeCards: C('Th Jh') },
      { id: 'sb', name: 'SB', position: 'SB', startingStack: 10000, holeCards: null },
      { id: 'bb', name: 'BB', position: 'BB', startingStack: 3000, holeCards: C('Ah Ad') },
    ],
    userPlayerId: 'bb',
    board: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  state = actAll(state, [
    ['UTG', 'ALL_IN'],
    ['HJ', 'FOLD'],
    ['CO', 'FOLD'],
    // ⚠️ 这里只能 CALL 1000：BTN 若在翻前就全下 3000，BB 要跟的就是 2900，
    // 我想要的局面是「翻前三家各 1000、转牌 BTN 再全下 2000」。
    ['BTN', 'CALL', 1000],
    ['SB', 'FOLD'],
    ['BB', 'CALL', 900],
  ]);
  const flop = advanceStreet(state, { cards: C('Kh 9s 4d') });
  assert.equal(flop.ok, true, '翻牌必须推进成功');
  if (!flop.ok) return;
  const flopChecked = actAll(flop.state, [
    ['BB', 'CHECK'],
    ['BTN', 'CHECK'],
  ]);
  const turn = advanceStreet(flopChecked, { cards: C('2c') });
  assert.equal(turn.ok, true, '转牌必须推进成功');
  if (!turn.ok) return;
  const facing = actAll(turn.state, [
    ['BB', 'CHECK'],
    ['BTN', 'BET', 2000],
  ]);

  const callCost = requiredCallAmount(facing, 'bb');
  assert.equal(callCost, 2000, '我共投 1000，BTN 全下到 3000 ⇒ 需再投 2000');

  const preview = previewCommit(facing, 'bb', callCost);
  assert.equal(preview.winnable, 7050, '主池 3050（含小盲死钱 50）+ 边池 4000');
  assert.equal(
    preview.layersForPlayer.length,
    2,
    '我既争主池又争边池 ⇒ 单一权益门槛不适用（决策层必须据此关掉「负期望」硬判）',
  );
  assert.equal(
    preview.singleThresholdApplies,
    false,
    '边池的层界由**已全下**的短码冻结（结构性的）⇒ 单一门槛不适用',
  );
  const requiredEquity = callCost / preview.winnable;
  assert.ok(
    Math.abs(requiredEquity - 0.2837) < 0.001,
    `单一门槛应约为 28.4%，实际 ${(requiredEquity * 100).toFixed(2)}%`,
  );

  /* ---- 真实 EV：逐张河牌枚举（用项目自己的评估器，不引外部实现）---- */
  const hero = C('Ah Ad');
  const big = C('Th Jh');
  const small = C('9h 9c');
  const board = C('Kh 9s 4d 2c');
  const used = new Set([...hero, ...big, ...small, ...board].map((c) => cardIndex(c)));
  const deck = createDeck().filter((c) => !used.has(cardIndex(c)));
  const mainAmount = preview.layersForPlayer[0]!.amount;
  const sideAmount = preview.layersForPlayer[1]!.amount;

  let totalGain = 0;
  let wholePotShare = 0;
  for (const river of deck) {
    const full = [...board, river];
    const h = evaluateCards([...hero, ...full]);
    const b = evaluateCards([...big, ...full]);
    const s = evaluateCards([...small, ...full]);
    // 边池：只与 BTN 比
    const vsBig = compareHands(h, b);
    totalGain += vsBig > 0 ? sideAmount : vsBig === 0 ? sideAmount / 2 : 0;
    // 主池：三家比
    let top = h;
    if (compareHands(b, top) > 0) top = b;
    if (compareHands(s, top) > 0) top = s;
    const tied = [h, b, s].filter((x) => compareHands(x, top) === 0).length;
    const heroIsTop = compareHands(h, top) === 0;
    totalGain += heroIsTop ? mainAmount / tied : 0;
    wholePotShare += heroIsTop ? 1 / tied : 0;
  }
  const truthEV = totalGain / deck.length - callCost;
  const heroEquity = wholePotShare / deck.length;

  assert.ok(
    heroEquity < requiredEquity - 0.2,
    `本例整池权益（${(heroEquity * 100).toFixed(1)}%）必须远低于单一门槛（${(requiredEquity * 100).toFixed(1)}%）` +
      '—— 否则这条测试就锁不住「权益低于门槛 ≠ 负期望」',
  );
  assert.ok(
    truthEV > 1000,
    `真实跟注 EV 必须明显为正（实际 ${truthEV.toFixed(1)}）—— ` +
      '单一门槛的 EV 只是下界，按它弃牌会弃掉这手本该跟的牌',
  );
});
