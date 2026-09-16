/**
 * 牌局状态与账本测试
 *
 * 覆盖规范第 6 / 9 / 10 / 11 / 14 / 15 条；Bug 预判 B10 / B11 / B16 / B17 / B20。
 * 这里验证的核心命题是：**底池不会算错，筹码不会算错**。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HandPhase,
  activePlayers,
  allBoardCards,
  cloneState,
  computePot,
  createGame,
  isBettingRoundComplete,
  minRaiseTo,
  playerById,
  requiredCallAmount,
  streetFromBoard,
  streetOrder,
  totalCommitted,
} from '../src/domain/poker/gameState.ts';
import { applyAction } from '../src/domain/poker/engine.ts';
import { mulberry32 } from '../src/infra/rng.ts';
import type { Position } from '../src/domain/types.ts';
import { C, makeGame } from './helpers.ts';

describe('牌局初始化 —— 桌型与人数', () => {
  it('6 人桌创建成功且玩家按座位顺序排列', () => {
    const state = makeGame({ tableSize: 6 });
    assert.equal(state.players.length, 6);
    assert.deepEqual(
      state.players.map((p) => p.position),
      ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    );
  });

  it('9 人桌创建成功且玩家按座位顺序排列', () => {
    const state = makeGame({ tableSize: 9 });
    assert.equal(state.players.length, 9);
    assert.deepEqual(
      state.players.map((p) => p.position),
      ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
    );
  });

  /**
   * ⚠️ **这条断言被正当地改写过（Table Topology Correction，规范第 80 条）**
   *
   * 原文是「6 人桌必须恰好 6 位玩家」。那条**旧需求本身是错的**：
   * 它把「牌桌有几个物理座位」（tableCapacity）与
   * 「本手发牌给几个人」（handedness）当成同一个数字，
   * 于是 9 座桌只要有人离开，整张桌子就再也发不出牌。
   *
   * 这里**不是删除**旧断言，而是替换成正确的新不变量：
   * 人数必须在 `2 ~ 容量` 之间。
   */
  it('本手人数必须在 2 ~ 座位容量之间（容量 ≠ 本手人数）', () => {
    const seats = (positions: readonly Position[]) =>
      positions.map((position: Position, i) => ({
        id: `p${i}`,
        name: String(position),
        position,
        startingStack: 100000,
      }));
    const config = {
      tableSize: 6,
      smallBlind: 1000,
      bigBlind: 2000,
      ante: 0,
      dealerPosition: 'BTN',
    } as const;

    // 6 座桌塞 7 个人 → 超过容量
    assert.throws(
      () =>
        createGame({
          config,
          players: seats(['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']).concat([
            { id: 'x', name: 'X', position: 'UTG', startingStack: 100000 },
          ]),
          userPlayerId: 'p0',
        }),
      /本手人数必须在 2~6 之间/,
    );

    // 只有 1 个人 → 少于 2
    assert.throws(
      () => createGame({ config, players: seats(['BTN']), userPlayerId: 'p0' }),
      /本手人数必须在 2~6 之间/,
    );

    // ✅ 6 座桌 2 人（短桌）现在是**合法**的
    const shortHanded = createGame({
      config,
      players: seats(['BTN', 'BB']),
      userPlayerId: 'p0',
    });
    assert.equal(shortHanded.players.length, 2, '6 座桌可以有 2 人的本手');
    assert.equal(shortHanded.config.tableSize, 6, '容量仍然是 6');

    // ✅ 6 座桌 5 人（非连续空位）也合法
    const fiveHanded = createGame({
      config,
      players: seats(['UTG', 'CO', 'BTN', 'SB', 'BB']),
      userPlayerId: 'p0',
    });
    assert.equal(fiveHanded.players.length, 5);
    assert.equal(fiveHanded.config.tableSize, 6);
  });
});

describe('牌局初始化 —— 盲注与前注', () => {
  it('小盲与大盲被正确扣除', () => {
    const state = makeGame({ smallBlind: 1000, bigBlind: 2000, stack: 200000 });
    const sb = playerById(state, 'sb')!;
    const bb = playerById(state, 'bb')!;
    assert.equal(sb.committedByStreet.PREFLOP, 1000);
    assert.equal(bb.committedByStreet.PREFLOP, 2000);
    assert.equal(sb.remainingStack, 199000);
    assert.equal(bb.remainingStack, 198000);
    assert.equal(state.currentBet, 2000);
    assert.equal(state.lastRaiseSize, 2000);
  });

  it('开局底池 = 小盲 + 大盲', () => {
    const state = makeGame({ smallBlind: 1000, bigBlind: 2000 });
    assert.equal(computePot(state), 3000);
  });

  it('前注独立记账，不与街内投入混算', () => {
    const state = makeGame({ ante: 200, smallBlind: 1000, bigBlind: 2000, tableSize: 6 });
    const utg = playerById(state, 'utg')!;
    assert.equal(utg.ante, 200);
    assert.equal(utg.committedByStreet.PREFLOP, 0);
    // 底池 = 6 × 200 前注 + 1000 + 2000
    assert.equal(computePot(state), 6 * 200 + 3000);
  });

  it('盲注不合法时抛错（大盲必须大于小盲）', () => {
    assert.throws(
      () => makeGame({ smallBlind: 2000, bigBlind: 1000 }),
      /盲注不合法/,
    );
    assert.throws(() => makeGame({ smallBlind: 0, bigBlind: 0 }), /盲注不合法/);
  });

  it('前注为负时抛错', () => {
    assert.throws(() => makeGame({ ante: -1 }), /前注不能为负/);
  });

  it('筹码不足一个大盲时盲注即为全下', () => {
    const state = makeGame({
      smallBlind: 1000,
      bigBlind: 2000,
      stacks: [100000, 100000, 100000, 100000, 500, 100000],
    });
    const sb = playerById(state, 'sb')!;
    assert.equal(sb.remainingStack, 0);
    assert.equal(sb.committedByStreet.PREFLOP, 500);
    assert.equal(sb.allIn, true);
  });

  it('🔴 短大盲不改变入池代价：其他人仍须跟满一个大盲', () => {
    /*
     * 2026-09 修复。修复前 `currentBet = max(小盲投入, 大盲投入)` ——
     * 而大盲不足额全下时**只投入了他剩下的那点筹码**，于是入池代价被
     * 拉到大盲**以下**。
     *
     * 实测（盲注 1000/2000、大盲只剩 600）：
     *
     * ```text
     * currentBet = 1000        ← 应为 2000
     * UTG 需跟 1000            ← 应为 2000
     * UTG CALL 2000 → 被拒     ← 规则上这才是正确的跟注额
     * UTG CALL 1000 → 被接受   ← 等于半价入池
     * ```
     *
     * 规则：大盲不足额全下不改变入池代价 —— 其他人仍须跟满一个大盲，
     * 最小加注仍到大盲的两倍。
     */
    const state = makeGame({
      smallBlind: 1000,
      bigBlind: 2000,
      stacks: [100000, 100000, 100000, 100000, 100000, 600],
    });
    const bb = playerById(state, 'bb')!;
    assert.equal(bb.committedByStreet.PREFLOP, 600, '大盲只能投入他剩下的 600');
    assert.equal(bb.allIn, true);

    assert.equal(
      state.currentBet,
      2000,
      '入池代价仍是一个完整大盲 —— 不能因为大盲投不满就降到 600（更不是小盲的 1000）',
    );
    assert.equal(
      requiredCallAmount(state, 'utg'),
      2000,
      '其他人必须跟满一个大盲，不能半价入池',
    );
    assert.equal(minRaiseTo(state), 4000, '最小加注仍到大盲的两倍');

    // 跟满一个大盲必须被接受，跟半个必须被拒
    const full = applyAction(state, { playerId: 'utg', type: 'CALL', amount: 2000 });
    assert.equal(full.ok, true, `跟满一个大盲必须合法：${full.ok ? '' : full.issues[0]!.code}`);
    const half = applyAction(state, { playerId: 'utg', type: 'CALL', amount: 1000 });
    assert.equal(half.ok, false, '跟半个大盲（半价入池）必须被拒绝');
  });
});

describe('底池重算 —— 唯一权威公式', () => {
  it('底池恒等于所有玩家所有街投入之和（含前注）', () => {
    const state = makeGame({ ante: 100, board: { flop: 'Kh Qs 9s' } });
    let pot = 0;
    for (const player of state.players) {
      pot += player.ante;
      pot += player.committedByStreet.PREFLOP;
      pot += player.committedByStreet.FLOP;
      pot += player.committedByStreet.TURN;
      pot += player.committedByStreet.RIVER;
    }
    assert.equal(computePot(state), pot);
  });

  it('totalCommitted 包含前注', () => {
    const state = makeGame({ ante: 300 });
    const bb = playerById(state, 'bb')!;
    assert.equal(totalCommitted(state, 'bb'), 300 + 2000);
  });
});

describe('筹码守恒 —— 属性测试（随机 300 局）', () => {
  it('任意随机牌局的「起始筹码合计」恒等于「剩余 + 已投入」合计', () => {
    const rng = mulberry32(20260101);
    for (let round = 0; round < 300; round++) {
      const tableSize = rng() < 0.5 ? 6 : 9;
      const bigBlind = 2000;
      const ante = rng() < 0.3 ? 200 : 0;
      const stacks = Array.from({ length: tableSize }, () =>
        Math.floor(20 + rng() * 180) * 1000,
      );
      const state = makeGame({ tableSize: tableSize as 6 | 9, stacks, bigBlind, ante });

      let startingTotal = 0;
      let currentTotal = 0;
      for (const player of state.players) {
        startingTotal += player.startingStack;
        currentTotal +=
          player.remainingStack +
          player.ante +
          player.committedByStreet.PREFLOP +
          player.committedByStreet.FLOP +
          player.committedByStreet.TURN +
          player.committedByStreet.RIVER;
      }
      assert.equal(currentTotal, startingTotal, `第 ${round} 局筹码不守恒`);

      // 底池不可能超过总筹码
      assert.ok(computePot(state) <= startingTotal);
      assert.ok(computePot(state) >= 0);
      // 任何玩家剩余筹码不为负
      for (const player of state.players) {
        assert.ok(player.remainingStack >= 0, `${player.name} 剩余筹码为负`);
        assert.ok(player.committedByStreet.PREFLOP >= 0);
      }
    }
  });
});

describe('牌局状态 —— 行动顺序与待行动队列', () => {
  it('翻牌前队列从枪口位开始、大盲位最后（9 人桌）', () => {
    const state = makeGame({ tableSize: 9 });
    assert.deepEqual(state.pendingQueue, [
      'utg',
      'utg1',
      'utg2',
      'lj',
      'hj',
      'co',
      'btn',
      'sb',
      'bb',
    ]);
  });

  it('翻牌后队列从小盲位开始、庄家最后', () => {
    const state = makeGame({ board: { flop: 'Kh Qs 9s' } });
    const order = streetOrder({ ...state, street: 'FLOP' });
    assert.deepEqual(
      order.map((p) => p.position),
      ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'],
    );
  });

  it('大小盲筹码不足时盲注即为全下，队列中不再包含他们', () => {
    const state = makeGame({
      stacksByPosition: { SB: 1000, BB: 2000 },
    });
    const sb = playerById(state, 'sb')!;
    const bb = playerById(state, 'bb')!;
    assert.equal(sb.allIn, true);
    assert.equal(bb.allIn, true);
    assert.equal(sb.remainingStack, 0);
    assert.equal(bb.remainingStack, 0);
    assert.equal(state.pendingQueue.includes('sb'), false);
    assert.equal(state.pendingQueue.includes('bb'), false);
    assert.equal(state.pendingQueue.length, 4);
  });
});

describe('牌局状态 —— 查询辅助', () => {
  it('requiredCallAmount 对大盲开局为 0（已跟平）', () => {
    const state = makeGame();
    assert.equal(requiredCallAmount(state, 'bb'), 0);
  });

  it('requiredCallAmount 对枪口位为一个完整大盲', () => {
    const state = makeGame();
    assert.equal(requiredCallAmount(state, 'utg'), 2000);
  });

  it('requiredCallAmount 受剩余筹码限制（不足时为剩余筹码）', () => {
    const state = makeGame({ stacksByPosition: { UTG: 1500 } });
    // 枪口位只有 1500，跟注大盲需要 2000，只能全下 1500
    assert.equal(requiredCallAmount(state, 'utg'), 1500);
  });

  it('minRaiseTo = 当前注额 + 上次加注增量', () => {
    const state = makeGame();
    assert.equal(minRaiseTo(state), 2000 + 2000);
  });

  it('isBettingRoundComplete 在大盲开局时为 false（大盲还有选择权）', () => {
    const state = makeGame();
    assert.equal(isBettingRoundComplete(state), false);
  });

  it('cloneState 产生完全独立的副本（修改副本不影响原状态）', () => {
    const state = makeGame();
    // 初始化会写入两条盲注动作记录
    const initialActionCount = state.actions.length;
    assert.equal(initialActionCount, 2);
    assert.deepEqual(
      state.actions.map((a) => a.type),
      ['POST_SB', 'POST_BB'],
    );

    const copy = cloneState(state);
    copy.players[0]!.remainingStack = 1;
    copy.players[0]!.committedByStreet.FLOP = 999;
    copy.board.flop.push(C('As')[0]!);
    copy.pendingQueue.push('ghost');
    copy.actions.push({
      index: 99,
      street: 'PREFLOP',
      playerId: 'x',
      position: 'UTG',
      type: 'FOLD',
      amount: 0,
      toAmount: 0,
      isAllIn: false,
      potBefore: 0,
      potAfter: 0,
    });

    assert.notEqual(state.players[0]!.remainingStack, 1);
    assert.equal(state.players[0]!.committedByStreet.FLOP, 0);
    assert.equal(state.board.flop.length, 0);
    assert.equal(state.pendingQueue.includes('ghost'), false);
    assert.equal(state.actions.length, initialActionCount);
    // 副本自身确实被改动了（证明 clone 是深拷贝而不是只读快照）
    assert.equal(copy.actions.length, initialActionCount + 1);
    assert.equal(copy.players[0]!.remainingStack, 1);
  });

  it('streetFromBoard 由公共牌张数推出街', () => {
    assert.equal(streetFromBoard({ flop: [], turn: [], river: [] }), 'PREFLOP');
    assert.equal(streetFromBoard({ flop: C('Kh Qs 9s'), turn: [], river: [] }), 'FLOP');
    assert.equal(streetFromBoard({ flop: C('Kh Qs 9s'), turn: C('Jc'), river: [] }), 'TURN');
    assert.equal(streetFromBoard({ flop: C('Kh Qs 9s'), turn: C('Jc'), river: C('8d') }), 'RIVER');
  });

  it('allBoardCards 顺序固定为 翻牌 → 转牌 → 河牌', () => {
    const state = makeGame({
      board: { flop: 'Kh Qs 9s', turn: 'Jc', river: '8d' },
    });
    assert.equal(allBoardCards(state).length, 5);
    assert.deepEqual(
      allBoardCards(state).map((card) => `${card.rank}${card.suit}`),
      ['13h', '12s', '9s', '11c', '8d'],
    );
    // 录入牌面不会自动改变「当前街」——街只由 advanceStreet 推进，
    // 这样用户可以一次性录入整手牌而不被状态推断干扰
    assert.equal(state.street, 'PREFLOP');
  });

  it('activePlayers 排除已弃牌玩家', () => {
    const state = makeGame();
    state.players[0]!.folded = true;
    assert.equal(activePlayers(state).length, 5);
  });

  it('初始阶段为下注阶段', () => {
    const state = makeGame();
    assert.equal(state.phase, HandPhase.BETTING);
    assert.equal(state.street, 'PREFLOP');
  });
});
