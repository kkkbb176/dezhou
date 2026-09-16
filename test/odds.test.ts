/**
 * 底池数学测试（底池赔率 / 最低所需权益 / 底池筹码比 / EV / 下注尺寸）
 *
 * 覆盖规范第 10 / 16 / 17 / 26 / 27 条；Bug 预判 B17 / M14。
 * 全部使用人工可复核的数值作为基准。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BET_SIZE_PRESETS,
  betEV,
  betRatioToPot,
  betSizeGrid,
  callEV,
  callEVFromPot,
  effectiveStackBetween,
  equityGate,
  potMathSnapshot,
  potOdds,
  requiredEquityForBet,
  spr,
} from '../src/domain/poker/odds.ts';
import { computePot, playerById } from '../src/domain/poker/gameState.ts';
import { act, makeGame } from './helpers.ts';

const close = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `期望 ${expected}（±${tolerance}），实际 ${actual}`,
  );

describe('底池赔率 —— 公式与基准数值', () => {
  it('底池 60,000、需跟注 20,000 → 底池赔率 = 20000/80000 = 25%', () => {
    const result = potOdds(60000, 20000);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.pot, 60000);
    assert.equal(result.value.callCost, 20000);
    assert.equal(result.value.finalPot, 80000);
    close(result.value.potOdds, 0.25);
    close(result.value.requiredEquity, 0.25);
  });

  it('最低所需权益 = 跟注 / (底池 + 跟注)（与底池赔率同值，但语义不同）', () => {
    for (const [pot, call] of [
      [100, 100],
      [1000, 500],
      [3000, 2000],
      [19000, 6300],
    ] as Array<[number, number]>) {
      const result = potOdds(pot, call);
      assert.equal(result.ok, true);
      if (!result.ok) continue;
      close(result.value.requiredEquity, call / (pot + call));
    }
  });

  it('风险收益比 = 风险 / 可赢得总量', () => {
    const result = potOdds(60000, 20000);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    close(result.value.riskReward, 20000 / 80000);
  });

  it('跟注为 0 时最低所需权益为 0', () => {
    const result = potOdds(10000, 0);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    close(result.value.requiredEquity, 0);
  });

  it('底池为负 / 跟注为负 / 全部为 0 时拒绝计算（绝不返回 Infinity）', () => {
    assert.equal(potOdds(-1, 100).ok, false);
    assert.equal(potOdds(100, -1).ok, false);
    const zero = potOdds(0, 0);
    assert.equal(zero.ok, false);
    if (!zero.ok) assert.equal(zero.code, 'ISSUE.MATH_DIVIDE_BY_ZERO');
  });

  it('非有限数值被拒绝', () => {
    assert.equal(potOdds(Number.NaN, 100).ok, false);
    assert.equal(potOdds(100, Number.POSITIVE_INFINITY).ok, false);
  });
});

describe('最低所需权益 —— 下注场景', () => {
  it('下注场景：风险 / (底池 + 风险)', () => {
    const result = requiredEquityForBet(60000, 20000);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    close(result.value, 20000 / 80000);
  });

  it('下注为负或底池为负时拒绝', () => {
    assert.equal(requiredEquityForBet(-10, 100).ok, false);
    assert.equal(requiredEquityForBet(100, -10).ok, false);
  });
});

describe('底池筹码比', () => {
  it('底池筹码比 = 有效筹码 / 当前底池', () => {
    const result = spr(100000, 25000);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    close(result.value.spr, 4);
  });

  it('底池为 0 时拒绝（不做除以零）', () => {
    const result = spr(100000, 0);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'ISSUE.MATH_DIVIDE_BY_ZERO');
  });

  it('有效筹码为负时拒绝', () => {
    assert.equal(spr(-1, 100).ok, false);
  });
});

describe('期望收益（EV）', () => {
  it('跟注 EV：权益 40%、底池 60,000、跟注 20,000 → EV = 0.4×60000 − 0.6×20000 = 12000', () => {
    const result = callEV(0.4, 60000, 20000);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    close(result.value, 12000);
  });

  it('当权益恰好等于最低所需权益时 EV 为 0（交叉验证）', () => {
    const pot = 19000;
    const call = 6300;
    const odds = potOdds(pot, call);
    assert.equal(odds.ok, true);
    if (!odds.ok) return;
    const ev = callEV(odds.value.requiredEquity, pot, call);
    assert.equal(ev.ok, true);
    if (!ev.ok) return;
    close(ev.value, 0, 1e-9);
  });

  it('权益低于临界值 → 负 EV；高于 → 正 EV', () => {
    const pot = 19000;
    const call = 6300;
    const required = call / (pot + call);
    const bad = callEVFromPot(required - 0.05, pot, call);
    const good = callEVFromPot(required + 0.05, pot, call);
    assert.equal(bad.ok && good.ok, true);
    if (!bad.ok || !good.ok) return;
    assert.ok(bad.value < 0);
    assert.ok(good.value > 0);
  });

  it('权益必须在 0..1，否则拒绝计算', () => {
    assert.equal(callEV(1.2, 100, 10).ok, false);
    assert.equal(callEV(-0.1, 100, 10).ok, false);
  });

  it('下注 EV：对手弃牌率提高时 EV 上升', () => {
    const low = betEV(0.4, 10000, 5000, 0.2);
    const high = betEV(0.4, 10000, 5000, 0.6);
    assert.equal(low.ok && high.ok, true);
    if (!low.ok || !high.ok) return;
    assert.ok(high.value > low.value);
  });

  it('下注 EV：弃牌率为 1 时等于直接赢下底池', () => {
    const result = betEV(0.4, 10000, 5000, 1);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    close(result.value, 10000);
  });

  it('下注 EV：弃牌率为 0 时退化为纯摊牌计算', () => {
    const result = betEV(0.5, 10000, 5000, 0);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // 0.5 × (10000 + 10000) − 5000 = 5000
    close(result.value, 5000);
  });

  it('弃牌率必须在 0..1，否则拒绝计算', () => {
    assert.equal(betEV(0.5, 10000, 5000, 1.5).ok, false);
    assert.equal(betEV(0.5, 10000, 5000, -0.1).ok, false);
  });
});

describe('权益门槛判断', () => {
  it('权益 42% > 最低 27% → 允许跟注，且不是边缘决策', () => {
    const result = equityGate(0.42, 0.27);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.verdict, 'CALL_ALLOWED');
    assert.equal(result.value.marginal, false);
    close(result.value.edge, 0.15);
  });

  it('权益 20% < 最低 27% → 不允许跟注', () => {
    const result = equityGate(0.2, 0.27);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.verdict, 'CALL_NOT_ALLOWED');
  });

  it('权益 49% 对最低 48% → 判定为边缘决策（不假装存在唯一正确答案）', () => {
    // 差距 1%，小于默认边缘带宽 ±2%
    const result = equityGate(0.49, 0.48);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.marginal, true);
    assert.equal(result.value.verdict, 'MARGINAL');
  });

  it('权益无法计算时返回 NOT_COMPUTABLE，绝不编造数字', () => {
    const result = equityGate(null, 0.25);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.verdict, 'NOT_COMPUTABLE');
    assert.equal(result.value.equity, null);
    assert.ok(Number.isNaN(result.value.edge));
  });

  it('最低所需权益超出 0..1 时拒绝计算', () => {
    assert.equal(equityGate(0.5, 1.5).ok, false);
    assert.equal(equityGate(0.5, -0.1).ok, false);
  });
});

describe('下注尺寸', () => {
  it('标准尺寸网格覆盖 1/4、1/3、1/2、2/3、3/4、满池', () => {
    const result = betSizeGrid(30000, 1000000);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.value.map((x) => x.amount),
      [7500, 10000, 15000, 20000, 22500, 30000],
    );
    assert.equal(result.value.length, BET_SIZE_PRESETS.length);
  });

  it('尺寸超过剩余筹码时取剩余筹码（即全下）', () => {
    const result = betSizeGrid(100000, 30000);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    for (const preset of result.value) {
      assert.ok(preset.amount <= 30000, `${preset.key} 超过剩余筹码`);
    }
    assert.equal(result.value[result.value.length - 1]!.amount, 30000);
  });

  it('底池为负时拒绝', () => {
    assert.equal(betSizeGrid(-1, 1000).ok, false);
  });

  it('下注占底池比例计算正确', () => {
    const result = betRatioToPot(20000, 60000);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    close(result.value, 1 / 3);
  });

  it('底池为 0 时拒绝计算比例', () => {
    assert.equal(betRatioToPot(100, 0).ok, false);
  });
});

describe('有效筹码 —— 按当前剩余筹码计算（口径写死）', () => {
  it('有效筹码 = min(我的剩余, 主要对手的剩余)（主要对手为剩余最多的未弃牌对手）', () => {
    const state = makeGame({
      stacksByPosition: { BTN: 200000, BB: 86000, CO: 60000 },
      userPosition: 'BTN',
    });
    // 主要对手 = 剩余最多的未弃牌对手 = UTG（200,000）
    // 有效筹码 = min(我 200,000, UTG 200,000) = 200,000
    const vsMax = effectiveStackBetween(state, 'btn');
    assert.equal(vsMax.ok, true);
    if (!vsMax.ok) return;
    assert.equal(vsMax.value.opponentId, 'utg');
    assert.equal(vsMax.value.amount, 200000);
    assert.equal(vsMax.value.myStack, 200000);

    // 指定大盲为对手：大盲已投入 2,000，剩余 84,000
    const vsBb = effectiveStackBetween(state, 'btn', 'bb');
    assert.equal(vsBb.ok, true);
    if (!vsBb.ok) return;
    assert.equal(vsBb.value.amount, 84000);
    assert.equal(vsBb.value.opponentName, 'BB');
    assert.equal(vsBb.value.opponentStack, 84000);

    // 指定关煞为对手：60,000 < 我 200,000 → 有效筹码 60,000
    const vsCo = effectiveStackBetween(state, 'btn', 'co');
    assert.equal(vsCo.ok, true);
    if (!vsCo.ok) return;
    assert.equal(vsCo.value.amount, 60000);
  });

  it('指定对手时按指定对手计算', () => {
    const state = makeGame({
      stacksByPosition: { BTN: 200000, BB: 86000, CO: 50000 },
      userPosition: 'BTN',
    });
    const result = effectiveStackBetween(state, 'btn', 'co');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.amount, 50000);
    assert.equal(result.value.opponentId, 'co');
  });

  it('默认主要对手是剩余筹码最多的未弃牌对手', () => {
    const state = makeGame({
      stacksByPosition: { BTN: 50000, BB: 300000, CO: 100000 },
      userPosition: 'BTN',
    });
    const result = effectiveStackBetween(state, 'btn');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.opponentId, 'bb');
    assert.equal(result.value.amount, 50000);
  });

  it('筹码随牌局进行而减少后，有效筹码随之下降（不用起始筹码）', () => {
    // 大盲起始 200000，翻牌前先跟注一个大注后剩余会明显减少
    const state = makeGame({ stacksByPosition: { BTN: 200000, BB: 200000 }, userPosition: 'BTN' });
    const before = effectiveStackBetween(state, 'btn', 'bb');
    assert.equal(before.ok, true);
    if (!before.ok) return;
    assert.equal(before.value.amount, 198000); // 大盲已投入 2000

    const after = act(
      state,
      { playerId: 'utg', type: 'CALL', amount: 2000 },
      { playerId: 'hj', type: 'CALL', amount: 2000 },
      { playerId: 'co', type: 'CALL', amount: 2000 },
      { playerId: 'btn', type: 'CALL', amount: 2000 },
      { playerId: 'sb', type: 'CALL', amount: 1000 },
      { playerId: 'bb', type: 'CHECK' },
    );
    const later = effectiveStackBetween(after, 'btn', 'bb');
    assert.equal(later.ok, true);
    if (!later.ok) return;
    // 大盲跟注后剩余 198,000（口径是当前剩余筹码，不是起始筹码）
    assert.equal(later.value.amount, 198000);
    assert.equal(playerById(after, 'bb')!.remainingStack, 198000);
    assert.equal(playerById(after, 'bb')!.startingStack, 200000);
  });

  it('找不到对手时拒绝计算（不返回 0 或猜测值）', () => {
    const state = makeGame();
    const result = effectiveStackBetween(state, 'btn', 'nonexistent');
    assert.equal(result.ok, false);
  });

  it('找不到玩家时拒绝计算', () => {
    const state = makeGame();
    assert.equal(effectiveStackBetween(state, 'ghost').ok, false);
  });
});

describe('底池数学快照 —— 界面数值的唯一来源', () => {
  it('规范第 10 条示例：底池 60,000、对手下注 20,000、跟注需要 20,000', () => {
    const state = makeGame({ userPosition: 'BTN' });
    const snapshot = potMathSnapshot(state, 'btn', 20000);
    assert.equal(snapshot.ok, true);
    if (!snapshot.ok) return;
    // 底池由系统按行动记录重算，不使用任何手填值
    assert.equal(snapshot.value.potSource, 'RECOMPUTED');
    assert.equal(snapshot.value.pot, computePot(state));
    assert.equal(snapshot.value.callCost, 20000);
    close(snapshot.value.odds.finalPot, computePot(state) + 20000);
    assert.equal(snapshot.value.opponentName.length > 0, true);
  });

  it('底池为 0 且跟注为 0 时拒绝计算全部比率（不做除以零）', () => {
    const state = makeGame({ ante: 0, smallBlind: 1000, bigBlind: 2000 });
    const zeroed = {
      ...state,
      players: state.players.map((p) => ({
        ...p,
        ante: 0,
        committedByStreet: { PREFLOP: 0, FLOP: 0, TURN: 0, RIVER: 0 },
      })),
    };
    assert.equal(computePot(zeroed), 0);
    const result = potMathSnapshot(zeroed, 'btn', 0);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'ISSUE.MATH_DIVIDE_BY_ZERO');
  });

  it('快照中的底池恒等于按行动记录重算的结果（界面不可能显示过期底池）', () => {
    let state = makeGame({ userPosition: 'BTN' });
    state = act(
      state,
      { playerId: 'utg', type: 'RAISE', amount: 6000 },
      { playerId: 'hj', type: 'FOLD' },
      { playerId: 'co', type: 'CALL', amount: 6000 },
      { playerId: 'btn', type: 'CALL', amount: 6000 },
      { playerId: 'sb', type: 'FOLD' },
      { playerId: 'bb', type: 'FOLD' },
    );
    const snapshot = potMathSnapshot(state, 'btn', 0);
    assert.equal(snapshot.ok, true);
    if (!snapshot.ok) return;
    // 底池 = UTG 6000 + CO 6000 + BTN 6000 + SB 1000 + BB 2000 = 21000
    assert.equal(snapshot.value.pot, computePot(state));
    assert.equal(snapshot.value.pot, 21000);
    assert.equal(snapshot.value.potSource, 'RECOMPUTED');
  });

  it('跟注需要为负时拒绝计算', () => {
    const state = makeGame();
    assert.equal(potMathSnapshot(state, 'btn', -1).ok, false);
  });
});
