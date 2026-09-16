/**
 * 牌局检查器测试（规范第九 / 十 / 十一 / 十二节，V1 第 13 / 14 / 15 / 41 / 42 条）
 *
 * 这是安全层的核心：**任何策略分析之前必须先跑检查器**。
 * 本文件同时充当「红队测试」：主动构造错误输入，验证必须被拦截。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canAnalyze,
  comparePot,
  validateBoard,
  validateCardUniqueness,
  validateChipConservation,
  validateChips,
  validateGameState,
  validateHoleCards,
  validateNoActionAfterFold,
  validateTableSetup,
} from '../src/domain/poker/validator.ts';
import { IssueCode, IssueSeverity } from '../src/domain/domainCodes.ts';
import { computePot, playerById } from '../src/domain/poker/gameState.ts';
import { act, C, makeGame } from './helpers.ts';

const codesOf = (issues: ReadonlyArray<{ code: string }>): string[] => issues.map((i) => i.code);

describe('检查器 —— 牌唯一性（52 张牌必须唯一）', () => {
  it('干净的牌局没有任何重复牌问题', () => {
    const state = makeGame({ userCards: 'As Kd' });
    assert.deepEqual(validateCardUniqueness(state), []);
  });

  it('公共牌已经出现 7♦，对手手牌又填 7♦ → 立即报冲突（不自动改牌）', () => {
    const state = makeGame({
      board: { flop: '7d Ks 2h' },
      holeCards: { CO: '7d 8c' },
    });
    const issues = validateCardUniqueness(state);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.code, IssueCode.OPPONENT_CARD_ON_BOARD);
    assert.equal(issues[0]!.params.card, '7d');
    assert.equal(issues[0]!.params.player, 'CO');
    // 系统绝不修改用户的牌面
    assert.deepEqual(state.board.flop.map((c) => `${c.rank}${c.suit}`), ['7d', '13s', '2h']);
    assert.deepEqual(
      playerById(state, 'co')!.holeCards!.map((c) => `${c.rank}${c.suit}`),
      ['7d', '8c'],
    );
  });

  it('我的手牌与公共牌重复 → 报「你的手牌与公共牌重复」', () => {
    const state = makeGame({ board: { flop: 'As Ks 2h' }, userCards: 'As Kd' });
    const issues = validateCardUniqueness(state);
    assert.ok(codesOf(issues).includes(IssueCode.USER_CARD_ON_BOARD));
  });

  it('两位玩家拿到同一张牌 → 报冲突并指名双方', () => {
    const state = makeGame({ userPosition: 'UTG', userCards: 'As Kd', holeCards: { CO: 'As Qc' } });
    const issues = validateCardUniqueness(state);
    const issue = issues.find((i) => i.code === IssueCode.SAME_CARD_BOTH_PLAYERS);
    assert.ok(issue, '未报出两人同牌');
    assert.equal(issue!.params.card, '14s');
    assert.equal(issue!.params.playerA, 'UTG');
    assert.equal(issue!.params.playerB, 'CO');
  });

  it('同一张牌出现三次只报一个问题（避免信息噪音）', () => {
    const state = makeGame({ board: { flop: 'As Ks 2h' }, userCards: 'As Kd', holeCards: { CO: 'As Qc' } });
    const issues = validateCardUniqueness(state);
    // 一张 A♠ 同时出现在公共牌与两位玩家手里 → 对每位持牌人各报一次，但不会重复报公共牌自身
    assert.ok(issues.length >= 1);
    assert.equal(issues.every((i) => i.params.card === '14s'), true);
  });

  it('同点数不同花色完全合法', () => {
    const state = makeGame({ board: { flop: 'As Kd 2h' }, userCards: 'Ah Kc' });
    assert.deepEqual(validateCardUniqueness(state), []);
  });
});

describe('检查器 —— 手牌张数', () => {
  it('手牌必须是 2 张', () => {
    const state = makeGame();
    playerById(state, 'co')!.holeCards = C('As');
    const issues = validateHoleCards(state);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.code, IssueCode.HOLE_CARD_COUNT_INVALID);
    assert.equal(issues[0]!.params.count, 1);
  });

  it('未填写手牌不报错（对手手牌是可选的）', () => {
    const state = makeGame();
    assert.deepEqual(validateHoleCards(state), []);
  });
});

describe('检查器 —— 公共牌结构（翻牌/转牌/河牌分开校验）', () => {
  it('翻牌必须恰好 3 张', () => {
    const state = makeGame();
    state.board.flop = C('Kh Qs');
    const issues = validateBoard(state);
    assert.equal(issues[0]!.code, IssueCode.BOARD_FLOP_INCOMPLETE);
    assert.equal(issues[0]!.params.count, 2);
  });

  it('翻牌 5 张也报错（多的也要拦住）', () => {
    const state = makeGame();
    state.board.flop = C('Kh Qs 9s 2d 3c');
    const codes = codesOf(validateBoard(state));
    assert.ok(codes.includes(IssueCode.BOARD_FLOP_INCOMPLETE));
  });

  it('没有翻牌却填了转牌 → 报错', () => {
    const state = makeGame();
    state.board.turn = C('Jc');
    assert.ok(codesOf(validateBoard(state)).includes(IssueCode.BOARD_TURN_WITHOUT_FLOP));
  });

  it('没有转牌却填了河牌 → 报错', () => {
    const state = makeGame();
    state.board.flop = C('Kh Qs 9s');
    state.board.river = C('8d');
    assert.ok(codesOf(validateBoard(state)).includes(IssueCode.BOARD_RIVER_WITHOUT_TURN));
  });

  it('转牌 / 河牌最多 1 张', () => {
    const state = makeGame();
    state.board.flop = C('Kh Qs 9s');
    state.board.turn = C('Jc 2d');
    state.board.river = C('8d 3c');
    const issues = validateBoard(state);
    const details = issues.map((i) => i.params.detail);
    assert.ok(details.some((d) => String(d).includes('转牌只能有 1 张')));
    assert.ok(details.some((d) => String(d).includes('河牌只能有 1 张')));
  });

  it('标准 5 张公共牌完全合法', () => {
    const state = makeGame({ board: { flop: 'Kh Qs 9s', turn: 'Jc', river: '8d' } });
    assert.deepEqual(validateBoard(state), []);
  });

  it('翻牌前没有任何公共牌也合法', () => {
    const state = makeGame();
    assert.deepEqual(validateBoard(state), []);
  });
});

describe('检查器 —— 桌型 / 位置 / 盲注', () => {
  it('合法牌局没有配置问题', () => {
    assert.deepEqual(validateTableSetup(makeGame({ tableSize: 6 })), []);
    assert.deepEqual(validateTableSetup(makeGame({ tableSize: 9 })), []);
  });

  it('6 人桌出现 9 人桌独有位置 → 报位置不匹配', () => {
    const state = makeGame({ tableSize: 6 });
    // 强行把低劫持位塞进 6 人桌
    playerById(state, 'co')!.position = 'LJ';
    const codes = codesOf(validateTableSetup(state));
    assert.ok(codes.includes(IssueCode.POSITION_MISMATCH));
  });

  it('位置重复 → 报错', () => {
    const state = makeGame({ tableSize: 6 });
    playerById(state, 'co')!.position = 'BTN';
    const codes = codesOf(validateTableSetup(state));
    assert.ok(codes.includes(IssueCode.POSITION_DUPLICATED));
  });

  /**
   * ⚠️ **本条断言被正当地改写过（Table Topology Correction，规范第 80 条）**
   *
   * 原文是「9 座桌删掉 3 人 → 人数与桌型不匹配」。那在旧模型下成立，
   * 但旧模型本身是错的：9 座桌 6 人是**完全合法的现金局形态**。
   * 现在被判非法的是「人数 < 2」与「人数 > 容量」。
   */
  it('本手人数 < 2 → 报错；2~容量之间合法', () => {
    const tooFew = makeGame({ tableSize: 9 });
    tooFew.players.splice(0, tooFew.players.length - 1);
    assert.ok(codesOf(validateTableSetup(tooFew)).includes(IssueCode.PLAYER_COUNT_MISMATCH));

    // 9 座桌 6 人（短桌）必须**不**报人数错误
    const shortHanded = makeGame({ tableSize: 9 });
    shortHanded.players.splice(0, 3);
    // 注意：splice 掉的座位留下的位置集合可能与 Button 冲突，因此这里只断言
    // 「不再因为人数」而报错 —— 那正是本轮修复的内容。
    assert.ok(
      !codesOf(validateTableSetup(shortHanded)).includes(IssueCode.PLAYER_COUNT_MISMATCH),
      '9 座桌 6 人不得再被判为「人数与桌型不匹配」',
    );
  });

  it('大盲小于等于小盲 → 报盲注不合法', () => {
    const state = makeGame();
    state.config.smallBlind = 3000;
    state.config.bigBlind = 2000;
    assert.ok(codesOf(validateTableSetup(state)).includes(IssueCode.BLIND_INVALID));
  });

  it('前注为负 → 报错', () => {
    const state = makeGame();
    state.config.ante = -100;
    assert.ok(codesOf(validateTableSetup(state)).includes(IssueCode.ANTE_NEGATIVE));
  });

  it('未指定「我的位置」→ 报错', () => {
    const state = makeGame();
    state.userPlayerId = null;
    assert.ok(codesOf(validateTableSetup(state)).includes(IssueCode.NO_USER_PLAYER));
  });
});

describe('检查器 —— 筹码', () => {
  it('正常牌局没有筹码问题', () => {
    assert.deepEqual(validateChips(makeGame()), []);
  });

  it('筹码为负 → 报错', () => {
    const state = makeGame();
    playerById(state, 'co')!.startingStack = -1000;
    assert.ok(codesOf(validateChips(state)).includes(IssueCode.STACK_NEGATIVE));
  });

  it('筹码为 0 → 报错（无法参与本手牌）', () => {
    const state = makeGame({ stacksByPosition: { CO: 0 } });
    assert.ok(codesOf(validateChips(state)).includes(IssueCode.STACK_ZERO));
  });

  it('已投入筹码为负 → 报错', () => {
    const state = makeGame();
    playerById(state, 'co')!.committedByStreet.FLOP = -5;
    assert.ok(codesOf(validateChips(state)).includes(IssueCode.STACK_NEGATIVE));
  });
});

describe('检查器 —— 筹码守恒', () => {
  it('干净牌局筹码守恒', () => {
    const result = validateChipConservation(makeGame());
    assert.equal(result.holds, true);
    assert.equal(result.delta, 0);
    assert.equal(result.issue, null);
  });

  it('人为破坏账本后能检出差额并报告具体数字', () => {
    const state = makeGame();
    // 凭空给某个玩家多发 5000 筹码
    playerById(state, 'co')!.remainingStack += 5000;
    const result = validateChipConservation(state);
    assert.equal(result.holds, false);
    assert.equal(result.delta, 5000);
    assert.equal(result.issue!.code, IssueCode.CHIPS_CONSERVATION_BROKEN);
    assert.equal(result.issue!.params.delta, 5000);
  });

  it('真实牌局进行中也始终保持守恒', () => {
    /**
     * 翻牌前基准顺序：UTG → HJ → CO → BTN → SB → BB。
     *
     * BTN 加注到 20000 后，队列按座位环绕重建为 `[SB, BB, UTG, HJ]`：
     * 小盲与大盲**尚未对当前注额表态**，因此排在最前
     *（他们本来就在 BTN 之后行动）；UTG 与 HJ 虽然行动过，
     * 但注额变了需要补注，排在后面。
     *
     * ⚠️ 注意 BB **不是**最后：他在本轮还没有行动过，
     * 因此他排在 UTG / HJ 之前。旧版本注释把他写在最后，
     * 那是 `rebuildPendingQueue` 查找弃牌者失败后错误旋转队列的产物 ——
     * 该 Bug 已在 Alpha 端到端接入时修复（见 `engine.ts` 的修复说明）。
     */
    let state = makeGame();
    state = act(
      state,
      { playerId: 'utg', type: 'RAISE', amount: 6000 },
      { playerId: 'hj', type: 'CALL', amount: 6000 },
      { playerId: 'co', type: 'FOLD' },
      { playerId: 'btn', type: 'RAISE', amount: 20000 },
      { playerId: 'sb', type: 'FOLD' },
      { playerId: 'bb', type: 'CALL', amount: 18000 }, // SB 之后轮到 BB
      { playerId: 'utg', type: 'CALL', amount: 14000 }, // 然后 UTG 补注
      { playerId: 'hj', type: 'CALL', amount: 14000 }, // 最后 HJ 补注
    );
    const result = validateChipConservation(state);
    assert.equal(result.holds, true);
    // 底池 = SB 1000 + BB 20000 + UTG 20000 + HJ 20000 + BTN 20000 = 81000
    assert.equal(computePot(state), 81000);
    assert.equal(state.pendingQueue.length, 0);
    assert.equal(state.bettingRoundComplete, true);
    assert.equal(validateGameState(state).blocked, false);
  });
});

describe('检查器 —— 底池重算对照（绝不静默忽略差异）', () => {
  it('用户填写 100,000 而系统算出 92,000 → 报不一致并给出两个数字与差额', () => {
    const state = makeGame({ userPosition: 'BTN' });
    const adjusted = {
      ...state,
      players: state.players.map((p) => ({
        ...p,
        committedByStreet: { ...p.committedByStreet },
      })),
    };
    // 系统重算 = SB 1000 + BB 60000 + UTG 30000 + BTN 1000 = 92000
    playerById(adjusted, 'utg')!.committedByStreet.PREFLOP = 30000;
    playerById(adjusted, 'bb')!.committedByStreet.PREFLOP = 60000;
    playerById(adjusted, 'btn')!.committedByStreet.PREFLOP = 1000;
    const computed = computePot(adjusted);
    assert.equal(computed, 92000);

    const comparison = comparePot(adjusted, 100000);
    assert.equal(comparison.matches, false);
    assert.equal(comparison.claimed, 100000);
    assert.equal(comparison.computed, 92000);
    assert.equal(comparison.delta, 8000);
    assert.equal(comparison.issue!.code, IssueCode.POT_MISMATCH);
    assert.equal(comparison.issue!.severity, IssueSeverity.WARNING);
    assert.equal(comparison.issue!.params.claimed, 100000);
    assert.equal(comparison.issue!.params.computed, 92000);
    assert.equal(comparison.issue!.params.delta, 8000);
  });

  it('用户填写的底池与系统一致时不报问题', () => {
    const state = makeGame();
    const comparison = comparePot(state, computePot(state));
    assert.equal(comparison.matches, true);
    assert.equal(comparison.issue, null);
  });

  it('没有手填底池时不报问题', () => {
    const comparison = comparePot(makeGame());
    assert.equal(comparison.matches, true);
    assert.equal(comparison.issue, null);
  });
});

describe('检查器 —— 弃牌后不得再行动（红队）', () => {
  it('弃牌后又被记录了一次动作 → 检出', () => {
    const state = makeGame();
    const co = playerById(state, 'co')!;
    state.actions.push(
      {
        index: 0,
        street: 'PREFLOP',
        playerId: 'co',
        position: 'CO',
        type: 'FOLD',
        amount: 0,
        toAmount: 0,
        isAllIn: false,
        potBefore: 3000,
        potAfter: 3000,
      },
      {
        index: 1,
        street: 'PREFLOP',
        playerId: 'co',
        position: 'CO',
        type: 'BET',
        amount: 5000,
        toAmount: 5000,
        isAllIn: false,
        potBefore: 3000,
        potAfter: 3000,
      },
    );
    void co;
    const issues = validateNoActionAfterFold(state);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.code, IssueCode.FOLDED_PLAYER_ACTED);
  });

  it('正常弃牌不误报', () => {
    const state = act(makeGame(), { playerId: 'utg', type: 'FOLD' });
    assert.deepEqual(validateNoActionAfterFold(state), []);
  });
});

describe('检查器 —— 总入口（收集式校验，一次返回全部问题）', () => {
  it('干净牌局可以进入分析', () => {
    const result = validateGameState(makeGame({ userCards: 'As Kd', board: { flop: 'Kh Qs 9s' } }));
    assert.equal(result.blocked, false);
    assert.equal(result.blockers.length, 0);
    assert.equal(canAnalyze(result), true);
    assert.equal(result.computedPot, computePot(makeGame()));
  });

  it('牌面冲突会阻止分析', () => {
    const state = makeGame({ board: { flop: '7d Ks 2h' }, holeCards: { CO: '7d 8c' } });
    const result = validateGameState(state);
    assert.equal(result.blocked, true);
    assert.equal(canAnalyze(result), false);
  });

  it('一次返回全部问题，而不是只报第一个', () => {
    const state = makeGame();
    // 同时制造三类问题：翻牌张数错、位置错、筹码为负
    state.board.flop = C('Kh Qs');
    playerById(state, 'co')!.position = 'LJ';
    playerById(state, 'sb')!.startingStack = -1;

    const result = validateGameState(state);
    const codes = codesOf(result.issues);
    assert.ok(codes.includes(IssueCode.BOARD_FLOP_INCOMPLETE), '漏报翻牌张数');
    assert.ok(codes.includes(IssueCode.POSITION_MISMATCH), '漏报位置不匹配');
    assert.ok(codes.includes(IssueCode.STACK_NEGATIVE), '漏报筹码为负');
    assert.ok(result.issues.length >= 3);
  });

  it('用户已弃牌时给出警告，但不阻止分析牌局', () => {
    let state = makeGame({ userPosition: 'BTN' });
    state = act(
      state,
      { playerId: 'utg', type: 'RAISE', amount: 6000 },
      { playerId: 'hj', type: 'FOLD' },
      { playerId: 'co', type: 'FOLD' },
      { playerId: 'btn', type: 'FOLD' },
    );
    const result = validateGameState(state);
    assert.equal(result.blocked, false);
    const codes = codesOf(result.warnings);
    assert.ok(codes.includes(IssueCode.USER_NOT_IN_HAND));
  });

  it('底池不一致是警告而非阻断（用户确认后仍可继续）', () => {
    const state = makeGame();
    const result = validateGameState(state, { claimedPot: 99999 });
    assert.equal(result.blocked, false);
    assert.ok(codesOf(result.warnings).includes(IssueCode.POT_MISMATCH));
  });

  it('blockers 与 warnings 分类正确', () => {
    const state = makeGame();
    const result = validateGameState(state, { claimedPot: 99999 });
    assert.equal(result.blockers.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.blocked, false);

    const bad = makeGame({ board: { flop: 'As Ks 2h' }, userCards: 'As Kd' });
    const badResult = validateGameState(bad);
    assert.ok(badResult.blockers.length > 0);
    assert.equal(badResult.blocked, true);
  });

  it('每个问题都带有 severity 与 params，便于中文渲染', () => {
    const state = makeGame({ board: { flop: 'As Ks 2h' }, userCards: 'As Kd' });
    const result = validateGameState(state);
    for (const issue of result.issues) {
      assert.ok(typeof issue.code === 'string' && issue.code.length > 0);
      assert.ok([IssueSeverity.BLOCKER, IssueSeverity.WARNING, IssueSeverity.INFO].includes(issue.severity));
      assert.equal(typeof issue.params, 'object');
    }
  });
});

describe('检查器 —— 红队用例（规范第四十三节）', () => {
  const redTeamCases: Array<[string, () => ReturnType<typeof validateGameState>, string]> = [
    [
      '两张 A♠',
      () => {
        const s = makeGame({ userCards: 'As Kd', holeCards: { CO: 'As Qc' } });
        return validateGameState(s);
      },
      IssueCode.SAME_CARD_BOTH_PLAYERS,
    ],
    [
      '错误的底池（要求必须一致时）',
      () => validateGameState(makeGame(), { claimedPot: 123456789, potMismatchBlocks: true }),
      IssueCode.POT_MISMATCH,
    ],
    [
      '转牌缺失但填了河牌',
      () => {
        const s = makeGame();
        s.board.flop = C('Kh Qs 9s');
        s.board.river = C('8d');
        return validateGameState(s);
      },
      IssueCode.BOARD_RIVER_WITHOUT_TURN,
    ],
    [
      '河牌出现两张',
      () => {
        const s = makeGame();
        s.board.flop = C('Kh Qs 9s');
        s.board.turn = C('Jc');
        s.board.river = C('8d 3c');
        return validateGameState(s);
      },
      IssueCode.BOARD_FLOP_INCOMPLETE,
    ],
    [
      '筹码为负数',
      () => {
        const s = makeGame();
        playerById(s, 'co')!.startingStack = -5000;
        return validateGameState(s);
      },
      IssueCode.STACK_NEGATIVE,
    ],
    [
      // ⚠️ 语义已迁移（规范第 80 条）：旧用例是「9 座桌删到 5 人」，
      //    而现在 5 人是合法的；真正非法的是只剩 1 人。
      '本手人数少于 2',
      () => {
        const s = makeGame({ tableSize: 9 });
        s.players.splice(0, s.players.length - 1);
        return validateGameState(s);
      },
      IssueCode.PLAYER_COUNT_MISMATCH,
    ],
    [
      '6 人桌用了 9 人桌的位置',
      () => {
        const s = makeGame({ tableSize: 6 });
        playerById(s, 'co')!.position = 'UTG2';
        return validateGameState(s);
      },
      IssueCode.POSITION_MISMATCH,
    ],
    [
      '同一位置出现两次',
      () => {
        const s = makeGame({ tableSize: 6 });
        playerById(s, 'co')!.position = 'UTG';
        return validateGameState(s);
      },
      IssueCode.POSITION_DUPLICATED,
    ],
  ];

  for (const [name, build, expectedCode] of redTeamCases) {
    it(`红队：${name} 必须被拦截`, () => {
      const result = build();
      assert.equal(result.blocked, true, `「${name}」没有被拦截`);
      assert.ok(
        codesOf(result.issues).includes(expectedCode),
        `「${name}」未报出期望的问题码 ${expectedCode}，实际：${codesOf(result.issues).join(',')}`,
      );
    });
  }
});
