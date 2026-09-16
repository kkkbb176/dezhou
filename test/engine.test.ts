/**
 * 行动系统与状态机测试
 *
 * 覆盖规范第 11 / 14 / 15 / 42 条；Bug 预判 B10 / B11 / B12 / B13 / B14 / B15 / B20。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  actorOnTurn,
  advanceStreet,
  applyAction,
  canRaise,
  isUnopenedPot,
  minBetAmount,
} from '../src/domain/poker/engine.ts';
import {
  HandPhase,
  computePot,
  playerById,
  requiredCallAmount,
  totalCommitted,
} from '../src/domain/poker/gameState.ts';
import { IssueCode } from '../src/domain/domainCodes.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { act, C, expectActionFailure, makeGame } from './helpers.ts';

describe('行动 —— 弃牌', () => {
  it('弃牌后玩家不再出现在待行动队列中', () => {
    const state = makeGame();
    const next = act(state, { playerId: 'utg', type: 'FOLD' });
    const utg = playerById(next, 'utg')!;
    assert.equal(utg.folded, true);
    assert.equal(next.pendingQueue.includes('utg'), false);
    // 底池不变
    assert.equal(computePot(next), 3000);
  });

  it('已经弃牌的玩家不能重新行动', () => {
    const state = act(makeGame(), { playerId: 'utg', type: 'FOLD' });
    const codes = expectActionFailure(state, { playerId: 'utg', type: 'CALL', amount: 2000 });
    assert.ok(codes.includes(IssueCode.FOLDED_PLAYER_ACTED));
  });

  it('只剩一人未弃牌时牌局立即结束', () => {
    let state = makeGame({ tableSize: 6 });
    // UTG 加注，其余全部弃牌
    state = act(state, { playerId: 'utg', type: 'RAISE', amount: 6000 });
    state = act(state, { playerId: 'hj', type: 'FOLD' });
    state = act(state, { playerId: 'co', type: 'FOLD' });
    state = act(state, { playerId: 'btn', type: 'FOLD' });
    state = act(state, { playerId: 'sb', type: 'FOLD' });
    state = act(state, { playerId: 'bb', type: 'FOLD' });
    assert.equal(state.phase, HandPhase.COMPLETE);
    assert.deepEqual(state.winners, ['utg']);
    assert.equal(state.pendingQueue.length, 0);
  });
});

describe('行动 —— 过牌', () => {
  /** 翻牌前全员溜入，大盲过牌，进入翻牌并发出翻牌 */
  function toFlopAfterLimpedPot() {
    let state = act(
      makeGame(),
      { playerId: 'utg', type: 'CALL', amount: 2000 },
      { playerId: 'hj', type: 'CALL', amount: 2000 },
      { playerId: 'co', type: 'CALL', amount: 2000 },
      { playerId: 'btn', type: 'CALL', amount: 2000 },
      { playerId: 'sb', type: 'CALL', amount: 1000 },
      // 大盲的选择权：所有人都只是跟注时，大盲仍可以加注或过牌
      { playerId: 'bb', type: 'CHECK' },
    );
    // 翻牌前下注轮已结束（街仍是翻牌前，因为翻牌还没发）
    assert.equal(state.bettingRoundComplete, true);
    assert.equal(state.street, 'PREFLOP');
    assert.equal(state.pendingQueue.length, 0);
    assert.equal(computePot(state), 12000);

    const flop = advanceStreet(state, { cards: C('Kh Qs 9s') });
    if (!flop.ok) throw new Error(`推进翻牌失败：${flop.issues.map((i) => i.code).join(',')}`);
    return flop.state;
  }

  it('无人下注时可以过牌（翻牌后）', () => {
    const state = toFlopAfterLimpedPot();
    assert.equal(state.pendingQueue[0], 'sb');

    const checked = act(state, { playerId: 'sb', type: 'CHECK' });
    assert.equal(playerById(checked, 'sb')!.committedByStreet.FLOP, 0);
    assert.equal(actorOnTurn(checked), 'bb');
    assert.equal(checked.currentBet, 0);
  });

  it('已经有人下注时不能过牌', () => {
    const state = toFlopAfterLimpedPot();
    // 小盲过牌 → 大盲下注 → 枪口位不能再过牌
    let s = act(state, { playerId: 'sb', type: 'CHECK' }, { playerId: 'bb', type: 'BET', amount: 3000 });
    const codes = expectActionFailure(s, { playerId: 'utg', type: 'CHECK' });
    assert.ok(codes.includes(IssueCode.CHECK_FACING_BET));
  });

  it('过牌时提交非零金额会被拒绝', () => {
    const state = toFlopAfterLimpedPot();
    const codes = expectActionFailure(state, { playerId: 'sb', type: 'CHECK', amount: 1000 });
    assert.ok(codes.includes(IssueCode.CHECK_NOT_ALLOWED));
  });
});

describe('行动 —— 跟注', () => {
  it('跟注金额必须精确等于所需金额', () => {
    const state = makeGame();
    assert.equal(requiredCallAmount(state, 'utg'), 2000);
    const codes = expectActionFailure(state, { playerId: 'utg', type: 'CALL', amount: 1500 });
    assert.ok(codes.includes(IssueCode.CALL_AMOUNT_ILLEGAL));

    const ok = act(state, { playerId: 'utg', type: 'CALL', amount: 2000 });
    assert.equal(playerById(ok, 'utg')!.committedByStreet.PREFLOP, 2000);
    assert.equal(playerById(ok, 'utg')!.remainingStack, 198000);
  });

  it('筹码不足时以全部筹码跟注（全下跟注）', () => {
    const state = makeGame({ stacksByPosition: { UTG: 1500 } });
    const next = act(state, { playerId: 'utg', type: 'CALL', amount: 1500 });
    const utg = playerById(next, 'utg')!;
    assert.equal(utg.allIn, true);
    assert.equal(utg.remainingStack, 0);
    assert.equal(utg.committedByStreet.PREFLOP, 1500);
  });

  it('跟注金额超过持有筹码会被拒绝', () => {
    const state = makeGame({ stacksByPosition: { UTG: 1500 } });
    const codes = expectActionFailure(state, { playerId: 'utg', type: 'CALL', amount: 2000 });
    assert.ok(codes.includes(IssueCode.CALL_AMOUNT_ILLEGAL));
  });

  it('无人下注时不能跟注', () => {
    const state = makeGame();
    // 大盲面对无人加注的场面：跟注需要额为 0，不合法
    const codes = expectActionFailure({ ...state, pendingQueue: ['bb'] }, {
      playerId: 'bb',
      type: 'CALL',
      amount: 0,
    });
    assert.ok(codes.includes(IssueCode.CALL_AMOUNT_ILLEGAL));
  });

  it('跟注金额为负数会被拒绝', () => {
    const state = makeGame();
    const codes = expectActionFailure(state, { playerId: 'utg', type: 'CALL', amount: -1 });
    assert.ok(codes.includes(IssueCode.ACTION_NEGATIVE_AMOUNT));
  });
});

describe('行动 —— 下注', () => {
  /** 翻牌前全员溜入 → 翻牌 → 小盲与大盲都过牌，轮到枪口位 */
  function toFlop() {
    let state = makeGame();
    state = act(
      state,
      { playerId: 'utg', type: 'CALL', amount: 2000 },
      { playerId: 'hj', type: 'CALL', amount: 2000 },
      { playerId: 'co', type: 'CALL', amount: 2000 },
      { playerId: 'btn', type: 'CALL', amount: 2000 },
      { playerId: 'sb', type: 'CALL', amount: 1000 },
      { playerId: 'bb', type: 'CHECK' },
    );
    const flop = advanceStreet(state, { cards: C('Kh Qs 9s') });
    if (!flop.ok) throw new Error(`推进翻牌失败：${flop.issues.map((i) => i.code).join(',')}`);
    return act(flop.state, { playerId: 'sb', type: 'CHECK' }, { playerId: 'bb', type: 'CHECK' });
  }

  it('翻牌后无人下注时可以下注', () => {
    const state = toFlop();
    assert.equal(isUnopenedPot(state), true);
    assert.equal(actorOnTurn(state), 'utg');
    const next = act(state, { playerId: 'utg', type: 'BET', amount: 3000 });
    assert.equal(next.currentBet, 3000);
    assert.equal(next.lastRaiseSize, 3000);
    assert.equal(next.lastAggressorId, 'utg');
  });

  it('下注低于一个大盲会被拒绝', () => {
    const state = toFlop();
    assert.equal(minBetAmount(state, playerById(state, 'utg')!), 2000);
    const codes = expectActionFailure(state, { playerId: 'utg', type: 'BET', amount: 1000 });
    assert.ok(codes.includes(IssueCode.BET_BELOW_MIN));
  });

  it('下注不能超过持有筹码', () => {
    const state = toFlop();
    const codes = expectActionFailure(state, { playerId: 'utg', type: 'BET', amount: 999999 });
    assert.ok(codes.includes(IssueCode.BET_EXCEEDS_STACK));
  });

  it('下注金额为 0 会被拒绝', () => {
    const state = toFlop();
    const codes = expectActionFailure(state, { playerId: 'utg', type: 'BET', amount: 0 });
    assert.ok(codes.includes(IssueCode.ACTION_ZERO_AMOUNT));
  });

  it('翻牌前已有大盲时不能再「下注」（只能加注）', () => {
    const state = makeGame();
    const codes = expectActionFailure(state, { playerId: 'utg', type: 'BET', amount: 2000 });
    assert.ok(codes.includes(IssueCode.ACTION_NOT_LEGAL_NOW));
  });

  it('筹码少于一个大盲时允许全下式下注', () => {
    // 小盲起始 2500：翻牌前投入 2000，转牌时只剩 500（小于一个大盲 2000）
    const state = makeGame({ stacksByPosition: { SB: 2500 } });
    let s = act(
      state,
      { playerId: 'utg', type: 'CALL', amount: 2000 },
      { playerId: 'hj', type: 'CALL', amount: 2000 },
      { playerId: 'co', type: 'CALL', amount: 2000 },
      { playerId: 'btn', type: 'CALL', amount: 2000 },
      { playerId: 'sb', type: 'CALL', amount: 1000 },
      { playerId: 'bb', type: 'CHECK' },
    );
    const flop = advanceStreet(s, { cards: C('Kh Qs 9s') });
    assert.equal(flop.ok, true);
    if (!flop.ok) return;

    // 翻牌全部过牌（翻牌后小盲先行动）
    s = act(
      flop.state,
      { playerId: 'sb', type: 'CHECK' },
      { playerId: 'bb', type: 'CHECK' },
      { playerId: 'utg', type: 'CHECK' },
      { playerId: 'hj', type: 'CHECK' },
      { playerId: 'co', type: 'CHECK' },
      { playerId: 'btn', type: 'CHECK' },
    );
    assert.equal(s.bettingRoundComplete, true);
    assert.equal(actorOnTurn(s), null);
    assert.equal(playerById(s, 'sb')!.remainingStack, 500);

    // 进入转牌，开始新的下注轮：小盲先行动且底池未被下注
    const turn = advanceStreet(s, { cards: C('2d') });
    assert.equal(turn.ok, true);
    if (!turn.ok) return;
    const t = turn.state;
    assert.equal(t.street, 'TURN');
    assert.equal(actorOnTurn(t), 'sb');

    // 非全下的 1000 低于一个大盲 → 拒绝
    const codes = expectActionFailure(t, { playerId: 'sb', type: 'BET', amount: 300 });
    assert.ok(codes.includes(IssueCode.BET_BELOW_MIN));

    // 1500 虽然低于一个大盲，但属于全下，因此允许
    const next = act(t, { playerId: 'sb', type: 'BET', amount: 500 });
    assert.equal(playerById(next, 'sb')!.allIn, true);
    const betRecord = next.actions[next.actions.length - 1]!;
    assert.equal(betRecord.type, 'BET');
    assert.equal(betRecord.isAllIn, true);
    assert.equal(next.lastRaiseSize, 500);
  });
});

describe('行动 —— 加注', () => {
  it('最小加注 = 当前注额 + 上次加注增量', () => {
    const state = makeGame();
    // 大盲 2000，最小加注到 4000
    const codes = expectActionFailure(state, { playerId: 'utg', type: 'RAISE', amount: 3500 });
    assert.ok(codes.includes(IssueCode.RAISE_BELOW_MIN));

    const ok = act(state, { playerId: 'utg', type: 'RAISE', amount: 4000 });
    assert.equal(ok.currentBet, 4000);
    assert.equal(ok.lastRaiseSize, 2000);
  });

  it('加注到等于当前注额会被拒绝', () => {
    const state = makeGame();
    const codes = expectActionFailure(state, { playerId: 'utg', type: 'RAISE', amount: 2000 });
    assert.ok(codes.includes(IssueCode.RAISE_AMOUNT_ILLEGAL));
  });

  it('加注增量决定下一次最小加注', () => {
    // UTG 加注到 6000（增量 4000）→ 下一个人的最小加注到 10000
    let state = act(makeGame(), { playerId: 'utg', type: 'RAISE', amount: 6000 });
    assert.equal(state.currentBet, 6000);
    assert.equal(state.lastRaiseSize, 4000);

    const codes = expectActionFailure(state, { playerId: 'hj', type: 'RAISE', amount: 9000 });
    assert.ok(codes.includes(IssueCode.RAISE_BELOW_MIN));

    state = act(state, { playerId: 'hj', type: 'RAISE', amount: 10000 });
    assert.equal(state.currentBet, 10000);
    assert.equal(state.lastRaiseSize, 4000);
  });

  it('加注后所有未跟平玩家重新进入待行动队列', () => {
    let state = act(
      makeGame(),
      { playerId: 'utg', type: 'CALL', amount: 2000 },
      { playerId: 'hj', type: 'CALL', amount: 2000 },
    );
    assert.equal(state.pendingQueue.length, 4);
    state = act(state, { playerId: 'co', type: 'RAISE', amount: 8000 });
    // 已行动过的 utg / hj 需要重新行动；co 自己不在队列中
    assert.deepEqual(state.pendingQueue, ['btn', 'sb', 'bb', 'utg', 'hj']);
  });

  it('加注金额超过持有筹码会被拒绝', () => {
    const state = makeGame({ stacksByPosition: { UTG: 5000 } });
    const codes = expectActionFailure(state, { playerId: 'utg', type: 'RAISE', amount: 10000 });
    assert.ok(codes.includes(IssueCode.BET_EXCEEDS_STACK));
  });
});

describe('行动 —— 全下', () => {
  it('全下投入全部剩余筹码', () => {
    const state = makeGame({ stacksByPosition: { UTG: 50000 } });
    const next = act(state, { playerId: 'utg', type: 'ALL_IN' });
    const utg = playerById(next, 'utg')!;
    assert.equal(utg.remainingStack, 0);
    assert.equal(utg.allIn, true);
    assert.equal(utg.committedByStreet.PREFLOP, 50000);
    assert.equal(next.currentBet, 50000);
    assert.equal(next.lastRaiseSize, 48000);
  });

  it('已全下玩家不能再次行动', () => {
    const allInState = act(makeGame({ stacksByPosition: { UTG: 50000 } }), {
      playerId: 'utg',
      type: 'ALL_IN',
    });
    // 全下后轮到 HJ，此时 UTG 已经不在队列里；强行让他行动必须被拒绝
    assert.equal(actorOnTurn(allInState), 'hj');
    const codes = expectActionFailure(allInState, { playerId: 'utg', type: 'RAISE', amount: 60000 });
    assert.ok(codes.includes(IssueCode.ALLIN_PLAYER_ACTED));
  });

  it('全下金额必须等于剩余筹码', () => {
    const state = makeGame();
    const codes = expectActionFailure(state, { playerId: 'utg', type: 'ALL_IN', amount: 1000 });
    assert.ok(codes.includes(IssueCode.ALLIN_AMOUNT_MISMATCH));
  });

  it('全下跟注（不足跟注额）记为全下', () => {
    // 枪口位只有 1000，面对 2000 的大盲只能全下跟注
    const state = makeGame({ stacksByPosition: { UTG: 1000 } });
    const next = act(state, { playerId: 'utg', type: 'ALL_IN' });
    const record = next.actions[next.actions.length - 1]!;
    assert.equal(record.type, 'ALL_IN');
    assert.equal(record.amount, 1000);
    assert.equal(record.isAllIn, true);
    assert.equal(playerById(next, 'utg')!.allIn, true);
    // 注额没有变化（1000 < 2000），因此不构成加注
    assert.equal(next.currentBet, 2000);
    assert.equal(next.lastRaiseSize, 2000);
  });
});

describe('行动 —— 顺序与回合', () => {
  it('不是该玩家行动时会被拒绝并指出正确玩家', () => {
    const state = makeGame();
    const result = applyAction(state, { playerId: 'bb', type: 'FOLD' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    const issue = result.issues[0]!;
    assert.equal(issue.code, IssueCode.NOT_PLAYERS_TURN);
    assert.equal(issue.params.actual, 'BB');
    assert.equal(issue.params.expected, 'UTG');
  });

  it('找不到玩家时给出明确错误', () => {
    const state = makeGame();
    const codes = expectActionFailure(state, { playerId: 'ghost', type: 'FOLD' });
    assert.ok(codes.includes(IssueCode.UNKNOWN_PLAYER));
  });

  it('牌局结束后不能再执行动作', () => {
    let state = makeGame();
    state = act(
      state,
      { playerId: 'utg', type: 'RAISE', amount: 6000 },
      { playerId: 'hj', type: 'FOLD' },
      { playerId: 'co', type: 'FOLD' },
      { playerId: 'btn', type: 'FOLD' },
      { playerId: 'sb', type: 'FOLD' },
      { playerId: 'bb', type: 'FOLD' },
    );
    assert.equal(state.phase, HandPhase.COMPLETE);
    const codes = expectActionFailure(state, { playerId: 'utg', type: 'CHECK' });
    assert.ok(codes.includes(IssueCode.ACTION_AFTER_HAND_OVER));
  });
});

describe('行动 —— 大盲的选择权（翻牌前 option）', () => {
  it('全员溜入后大盲仍可加注或过牌', () => {
    let state = makeGame();
    state = act(
      state,
      { playerId: 'utg', type: 'CALL', amount: 2000 },
      { playerId: 'hj', type: 'CALL', amount: 2000 },
      { playerId: 'co', type: 'CALL', amount: 2000 },
      { playerId: 'btn', type: 'CALL', amount: 2000 },
      { playerId: 'sb', type: 'CALL', amount: 1000 },
    );
    // 大盲还有选择权，队列不应为空
    assert.equal(actorOnTurn(state), 'bb');
    assert.equal(state.pendingQueue.length, 1);

    const checked = act(state, { playerId: 'bb', type: 'CHECK' });
    assert.equal(checked.pendingQueue.length, 0);
    assert.equal(computePot(checked), 12000);
  });

  it('全员溜入后大盲的**加注**必须同时出现在「引擎接受」与「合法动作推导」两侧', () => {
    /*
     * 🔴 这条测试防的是一处**跨层不一致**（2026-09 修复）。
     *
     * 引擎一直允许大盲加注（上面那条测试就在用它），但
     * `deriveLegalActions` 的判据里有一句 `!canCheck && …` ——
     * 把「能过牌」当成「不能加注」。而大盲正是**既能过牌又能加注**的那个人。
     *
     * 后果不是「少一个按钮」这么轻：界面只按 `legal.actions` 生成按钮，
     * 于是**大盲永远看不到加注入口**，而这恰恰是最值钱的打法之一。
     * 同时该模块文档自定的契约（「未推导出的动作 `applyAction` 必须拒绝」）
     * 被打破 —— 引擎接受的动作不在推导结果里。
     *
     * ⚠️ 既有测试 `tableTopology` 的完备性检查只查了**一个方向**
     *（后端合法 ⇒ 界面有入口），查不到这个反方向，所以它没能抓住。
     */
    let state = makeGame();
    state = act(
      state,
      { playerId: 'utg', type: 'CALL', amount: 2000 },
      { playerId: 'hj', type: 'CALL', amount: 2000 },
      { playerId: 'co', type: 'CALL', amount: 2000 },
      { playerId: 'btn', type: 'CALL', amount: 2000 },
      { playerId: 'sb', type: 'CALL', amount: 1000 },
    );

    // 1) 引擎接受
    const engineAccepts = applyAction(state, { playerId: 'bb', type: 'RAISE', amount: 8000 });
    assert.equal(engineAccepts.ok, true, '引擎必须允许大盲加注（这是它的选择权）');

    // 2) 推导层也必须给出加注 —— 两侧必须一致
    const bb = playerById(state, 'bb')!;
    const legal = deriveLegalActions(state, bb);
    assert.ok(
      legal.actions.includes('RAISE'),
      `引擎接受了 RAISE，合法动作推导里就必须有它；实际 ${JSON.stringify(legal.actions)}`,
    );
    assert.equal(legal.canRaise, true);
    // 过牌与加注**同时**合法 —— 这两个动作互不排斥
    assert.ok(legal.actions.includes('CHECK'), '大盲当然也还能过牌');
  });
});

describe('行动 —— 短全下不重开加注权（TDA 规则）', () => {
  it('全下加注不足最小加注时，已跟平玩家只能跟注或弃牌', () => {
    // UTG 加注到 6000（增量 4000，最小加注到 10000）
    // HJ 只有 9000，全下 9000（增量 3000 < 4000）→ 短全下
    let state = makeGame({ stacksByPosition: { HJ: 9000 } });
    state = act(state, { playerId: 'utg', type: 'RAISE', amount: 6000 });
    state = act(state, { playerId: 'hj', type: 'ALL_IN' });

    assert.equal(state.currentBet, 9000);
    // 上次加注增量保持 4000（短全下不更新）
    assert.equal(state.lastRaiseSize, 4000);
    // UTG 的加注权被关闭
    assert.equal(canRaise(state, 'utg'), false);

    // CO 之前未行动过，仍然可以加注
    assert.equal(canRaise(state, 'co'), true);

    // ⚠️ 行动顺序（Alpha 端到端发现的 Bug 修复后）
    //
    // 旧版 `rebuildPendingQueue` 在「行动者弃牌后不在 order 里」时
    // 把 `order[0]` 转到队尾，于是 CO 弃牌后**直接轮到 UTG**，
    // 跳过了同样尚未行动的 BTN / SB / BB。那个错误顺序被本测试固化了。
    //
    // 正确顺序：HJ 全下之后是 CO → BTN → SB → BB → UTG（UTG 补注）。
    let s = act(
      state,
      { playerId: 'co', type: 'FOLD' },
      { playerId: 'btn', type: 'FOLD' },
      { playerId: 'sb', type: 'FOLD' },
      { playerId: 'bb', type: 'FOLD' },
    );
    assert.equal(actorOnTurn(s), 'utg');

    // UTG 轮到行动时不能加注（短全下未重开加注权）
    const codes = expectActionFailure(s, { playerId: 'utg', type: 'RAISE', amount: 20000 });
    assert.ok(codes.includes(IssueCode.RAISE_NOT_REOPENED_FOR_PLAYER));

    // 但可以跟注
    s = act(s, { playerId: 'utg', type: 'CALL', amount: 3000 });
    assert.equal(playerById(s, 'utg')!.committedByStreet.PREFLOP, 9000);
  });

  it('完整加注会重新打开所有人的加注权', () => {
    let state = makeGame({ stacksByPosition: { HJ: 9000 } });
    state = act(state, { playerId: 'utg', type: 'RAISE', amount: 6000 });
    state = act(state, { playerId: 'hj', type: 'ALL_IN' });
    assert.equal(canRaise(state, 'utg'), false);

    // CO 完整加注到 15000（增量 6000 ≥ 4000）→ 重新打开
    state = act(state, { playerId: 'co', type: 'RAISE', amount: 15000 });
    assert.equal(canRaise(state, 'utg'), true);
    assert.equal(state.currentBet, 15000);
    assert.equal(state.lastRaiseSize, 6000);
  });

  it('短全下**不得**关闭「尚未行动」玩家的加注权（大盲的选择权）', () => {
    /*
     * 🔴 TDA 43 的口径（2026-09 修复）：不足一个完整加注的全下，
     * 只对**已经行动过**的玩家不重开下注；**尚未行动**的玩家仍可加注。
     *
     * 旧判据是 `other.committedByStreet[street] >= previousBet` ——
     * 而**盲注也算「已投入」**，于是被迫投下大盲的玩家恒满足这个条件，
     * `raiseClosedFor` 里就有他。结果：
     *
     * ```text
     * UTG 短码全下 9000（增量 3000 < 4000）
     *   → raiseClosedFor = ["bb"]        ← 大盲根本还没行动过！
     *   → 大盲 RAISE 被拒 RAISE_NOT_REOPENED_FOR_PLAYER
     * 而同一局面 CO（同样未行动）canRaise = true   ← 代码自相矛盾
     * ```
     *
     * 「大盲面对短码全下」恰恰是大盲选择权最值钱的场合。
     */
    let state = makeGame({ stacksByPosition: { HJ: 9000 } });
    state = act(state, { playerId: 'utg', type: 'RAISE', amount: 6000 });
    state = act(state, { playerId: 'hj', type: 'ALL_IN' }); // 短全下 9000

    // 已行动过的 UTG 被关闭 —— 这是对的，必须保留
    assert.equal(canRaise(state, 'utg'), false, '已行动者仍应被关闭（这条不能被修坏）');

    // 尚未行动的 CO / BTN / SB / **BB** 都必须保留加注权
    for (const id of ['co', 'btn', 'sb', 'bb']) {
      assert.equal(
        canRaise(state, id),
        true,
        `${id} 尚未行动过，短全下不该关掉它的加注权（盲注不算「已行动」）`,
      );
    }
    assert.ok(
      !state.raiseClosedFor.includes('bb'),
      `大盲不该出现在 raiseClosedFor 里；实际 ${JSON.stringify(state.raiseClosedFor)}`,
    );

    // 走到大盲，确认它真的能加注（不只是 canRaise 说可以）
    const toBb = act(
      state,
      { playerId: 'co', type: 'FOLD' },
      { playerId: 'btn', type: 'FOLD' },
      { playerId: 'sb', type: 'FOLD' },
    );
    assert.equal(actorOnTurn(toBb), 'bb');
    // 最小加注到 = 9000 + 4000 = 13000
    const raised = applyAction(toBb, { playerId: 'bb', type: 'RAISE', amount: 13000 });
    assert.equal(
      raised.ok,
      true,
      `大盲必须能加注；实际被拒：${raised.ok ? '' : raised.issues.map((i) => i.code).join(',')}`,
    );
  });
});

describe('行动 —— 街道推进', () => {
  function limpedFlop() {
    let state = makeGame();
    state = act(
      state,
      { playerId: 'utg', type: 'CALL', amount: 2000 },
      { playerId: 'hj', type: 'CALL', amount: 2000 },
      { playerId: 'co', type: 'CALL', amount: 2000 },
      { playerId: 'btn', type: 'CALL', amount: 2000 },
      { playerId: 'sb', type: 'CALL', amount: 1000 },
      { playerId: 'bb', type: 'CHECK' },
    );
    return state;
  }

  it('下注轮未结束时拒绝推进并说明谁还需要跟注', () => {
    const state = makeGame();
    const result = advanceStreet(state, { cards: [] });
    assert.equal(result.ok, false);
    if (result.ok) return;
    const issue = result.issues[0]!;
    assert.equal(issue.code, IssueCode.STREET_NOT_COMPLETE);
    assert.equal(issue.params.player, 'UTG');
    assert.equal(issue.params.amount, 2000);
  });

  it('翻牌必须恰好 3 张，否则拒绝发牌', () => {
    const state = limpedFlop();
    const bad = advanceStreet(state, { cards: [] });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.issues[0]!.code, IssueCode.BOARD_FLOP_INCOMPLETE);
  });

  it('下注轮结束后可以逐街推进到河牌', () => {
    let state = limpedFlop();

    const flop = advanceStreet(state, { cards: undefined });
    assert.equal(flop.ok, false); // 未提供牌且公共牌为空

    state = { ...state, board: { flop: [], turn: [], river: [] } };
    const flopResult = advanceStreet(state, {
      cards: [
        { rank: 13, suit: 'h' },
        { rank: 12, suit: 's' },
        { rank: 9, suit: 's' },
      ],
    });
    assert.equal(flopResult.ok, true);
    if (!flopResult.ok) return;
    assert.equal(flopResult.state.street, 'FLOP');
    assert.equal(flopResult.state.board.flop.length, 3);
    assert.equal(flopResult.state.currentBet, 0);

    // 翻牌全部过牌
    let flopState = flopResult.state;
    flopState = act(
      flopState,
      { playerId: 'sb', type: 'CHECK' },
      { playerId: 'bb', type: 'CHECK' },
      { playerId: 'utg', type: 'CHECK' },
      { playerId: 'hj', type: 'CHECK' },
      { playerId: 'co', type: 'CHECK' },
      { playerId: 'btn', type: 'CHECK' },
    );
    assert.equal(flopState.pendingQueue.length, 0);

    const turnResult = advanceStreet(flopState, { cards: [{ rank: 11, suit: 'c' }] });
    assert.equal(turnResult.ok, true);
    if (!turnResult.ok) return;
    assert.equal(turnResult.state.street, 'TURN');
    assert.equal(turnResult.state.board.turn.length, 1);
  });

  it('公共牌与已知牌重复时拒绝发牌（不静默替换）', () => {
    const state = limpedFlop();
    // 先让公共牌占位为空
    const empty = { ...state, board: { flop: [], turn: [], river: [] } };
    const result = advanceStreet(empty, {
      cards: [
        { rank: 14, suit: 's' },
        { rank: 14, suit: 's' }, // 同一张牌出现两次
        { rank: 9, suit: 's' },
      ],
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.issues[0]!.code, IssueCode.DUPLICATE_CARD);
  });

  it('河牌之后不能再推进', () => {
    // 构造已到河牌的状态
    let state = limpedFlop();
    state = { ...state, street: 'RIVER' as const, board: { flop: [], turn: [], river: [] } };
    const result = advanceStreet(state, { cards: [] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.issues[0]!.code, IssueCode.STREET_ALREADY_RIVER);
  });
});

describe('底池与筹码 —— 完整牌局账本（规范第 11 条示例牌局）', () => {
  it('翻牌前 枪口加注3BB / 关煞跟注 / 庄家弃牌 / 小盲弃牌 / 大盲跟注', () => {
    let state = makeGame({ bigBlind: 2000, smallBlind: 1000 });
    const startTotal = state.players.reduce((sum, p) => sum + p.startingStack, 0);

    state = act(
      state,
      { playerId: 'utg', type: 'RAISE', amount: 6000 },
      { playerId: 'hj', type: 'FOLD' },
      { playerId: 'co', type: 'CALL', amount: 6000 },
      { playerId: 'btn', type: 'FOLD' },
      { playerId: 'sb', type: 'FOLD' },
      { playerId: 'bb', type: 'CALL', amount: 4000 },
    );

    // 底池 = 6000 + 6000 + 2000(大盲已投) + 4000 + 1000(小盲已投) = 19000
    assert.equal(computePot(state), 19000);
    assert.equal(state.pendingQueue.length, 0);

    // 筹码守恒
    const currentTotal = state.players.reduce(
      (sum, p) => sum + p.remainingStack + totalCommitted(state, p.id),
      0,
    );
    assert.equal(currentTotal, startTotal);

    // 行动记录可读性：记录顺序与动作一致
    assert.deepEqual(
      state.actions.map((a) => `${a.position}:${a.type}`),
      ['SB:POST_SB', 'BB:POST_BB', 'UTG:RAISE', 'HJ:FOLD', 'CO:CALL', 'BTN:FOLD', 'SB:FOLD', 'BB:CALL'],
    );

    // 逐条动作的 potBefore / potAfter 与系统重算一致
    for (const action of state.actions) {
      assert.equal(action.potAfter, action.potBefore + action.amount, `动作 ${action.index} 底池不连续`);
    }
    assert.equal(state.actions[state.actions.length - 1]!.potAfter, computePot(state));
  });

  it('翻牌 大盲过牌 / 枪口下注1/3池 / 关煞跟注 / 大盲弃牌', () => {
    let state = makeGame();
    state = act(
      state,
      { playerId: 'utg', type: 'RAISE', amount: 6000 },
      { playerId: 'hj', type: 'FOLD' },
      { playerId: 'co', type: 'CALL', amount: 6000 },
      { playerId: 'btn', type: 'FOLD' },
      { playerId: 'sb', type: 'FOLD' },
      { playerId: 'bb', type: 'CALL', amount: 4000 },
    );
    const potBeforeFlop = computePot(state);
    assert.equal(potBeforeFlop, 19000);

    const flop = advanceStreet(state, {
      cards: [
        { rank: 13, suit: 'h' },
        { rank: 12, suit: 's' },
        { rank: 9, suit: 's' },
      ],
    });
    assert.equal(flop.ok, true);
    if (!flop.ok) return;

    // 翻牌后顺序：大盲 → 枪口 → 关煞（小盲已弃牌）
    assert.equal(actorOnTurn(flop.state), 'bb');
    let s = act(flop.state, { playerId: 'bb', type: 'CHECK' });
    assert.equal(actorOnTurn(s), 'utg');

    // 下注 1/3 底池 ≈ 6333，取整为 6300
    s = act(s, { playerId: 'utg', type: 'BET', amount: 6300 });
    assert.equal(s.currentBet, 6300);
    s = act(s, { playerId: 'co', type: 'CALL', amount: 6300 });
    s = act(s, { playerId: 'bb', type: 'FOLD' });

    assert.equal(computePot(s), 19000 + 6300 + 6300);
    assert.equal(s.pendingQueue.length, 0);
  });
});

describe('行动 —— 多人底池（规范第 28 条，禁止套用单挑逻辑）', () => {
  it('4 人底池的下注轮会依次走完所有人', () => {
    let state = makeGame();
    state = act(
      state,
      { playerId: 'utg', type: 'CALL', amount: 2000 },
      { playerId: 'hj', type: 'FOLD' },
      { playerId: 'co', type: 'CALL', amount: 2000 },
      { playerId: 'btn', type: 'CALL', amount: 2000 },
      { playerId: 'sb', type: 'FOLD' },
      { playerId: 'bb', type: 'CHECK' },
    );
    const flop = advanceStreet(state, {
      cards: [
        { rank: 13, suit: 'h' },
        { rank: 12, suit: 's' },
        { rank: 9, suit: 's' },
      ],
    });
    assert.equal(flop.ok, true);
    if (!flop.ok) return;
    // 翻牌后行动顺序：小盲已弃牌 → 大盲 → 枪口 → 关煞 → 庄家
    assert.equal(flop.state.pendingQueue.length, 4);
    assert.deepEqual(flop.state.pendingQueue, ['bb', 'utg', 'co', 'btn']);

    // 有人下注后其余两人都要表态
    const s = act(flop.state, { playerId: 'bb', type: 'BET', amount: 4000 });
    assert.deepEqual(s.pendingQueue, ['utg', 'co', 'btn']);
  });

  it('多人底池中一人全下不影响其余人的继续行动', () => {
    let state = makeGame({ stacksByPosition: { BB: 5000 } });
    state = act(
      state,
      { playerId: 'utg', type: 'CALL', amount: 2000 },
      { playerId: 'hj', type: 'FOLD' },
      { playerId: 'co', type: 'CALL', amount: 2000 },
      { playerId: 'btn', type: 'CALL', amount: 2000 },
      { playerId: 'sb', type: 'FOLD' },
      { playerId: 'bb', type: 'ALL_IN' },
    );
    // 大盲全下 5000（增量 3000 ≥ 2000，属于完整加注）
    assert.equal(state.currentBet, 5000);
    assert.equal(playerById(state, 'bb')!.allIn, true);
    // 其余三位仍需跟注 3000
    assert.deepEqual(state.pendingQueue, ['utg', 'co', 'btn']);
  });
});

describe('行动 —— 随机属性测试（不变量永真）', () => {
  it('随机 200 手牌：底池恒等于账本合计、筹码守恒、剩余筹码非负', () => {
    const seed = 424242;
    let s = seed;
    const nextRandom = () => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return s / 4294967296;
    };

    for (let round = 0; round < 200; round++) {
      const tableSize = nextRandom() < 0.5 ? 6 : 9;
      let state = makeGame({ tableSize: tableSize as 6 | 9 });
      const startTotal = state.players.reduce((sum, p) => sum + p.startingStack, 0);

      // 随机行动若干步
      for (let step = 0; step < 40; step++) {
        if (state.phase !== HandPhase.BETTING) break;
        const actorId = actorOnTurn(state);
        if (actorId === null) break;
        const actor = playerById(state, actorId)!;
        const call = requiredCallAmount(state, actorId);
        const roll = nextRandom();

        let command;
        if (roll < 0.2) {
          command = { playerId: actorId, type: 'FOLD' as const };
        } else if (call > 0) {
          command = { playerId: actorId, type: 'CALL' as const, amount: call };
        } else {
          command = { playerId: actorId, type: 'CHECK' as const };
        }

        const result = applyAction(state, command);
        if (!result.ok) continue;
        state = result.state;

        // ---- 不变量 ----
        let ledger = 0;
        for (const player of state.players) {
          assert.ok(player.remainingStack >= 0, `第 ${round} 局 ${player.name} 剩余筹码为负`);
          ledger += totalCommitted(state, player.id);
        }
        assert.equal(computePot(state), ledger, `第 ${round} 局底池与账本不一致`);
        const currentTotal = state.players.reduce(
          (sum, p) => sum + p.remainingStack + totalCommitted(state, p.id),
          0,
        );
        assert.equal(currentTotal, startTotal, `第 ${round} 局筹码不守恒`);
      }
    }
  });
});
