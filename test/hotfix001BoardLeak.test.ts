/**
 * REAL-HAND HOTFIX 001 ADDENDUM —— 决策时刻可见性不变量
 *
 * # 不变量
 *
 * > `DecisionContext` 只能包含该决策时**已经公开**的信息。
 *
 * ## 为什么这条要独立钉住
 *
 * `DecisionContext` 是决策链的**唯一**信息入口：权益、牌力、范围、
 * 底池赔率全部从这里读。更晚的公共牌一旦混进来，后果不是精度问题，
 * 而是**信息泄漏** —— 系统会在「还不知道转牌是什么」的时候，
 * 用已知未来的牌面算权益，然后给出一个自信的建议。使用者看不出来。
 *
 * ## 两类测试（规范原文 §6 / §7）
 *
 * | 类 | 做法 | 目的 |
 * |---|---|---|
 * | **一：合法入口** | 沿 `parseManualInput` → `buildAnalyzableState` → `buildDecisionContext` 正常驱动 | 证明正常路径恰好满足 |
 * | **二：绕过 Parser 直接攻击 ContextBuilder** | 人为构造内部非法 `GameState` | **即使未来有人放宽 Parser，DecisionContext 仍不能泄漏** |
 * | **三：反方向（少了）** | `FLOP + 0` / `TURN + 3` / `RIVER + 4` | 可见性是 **exact**，不是 **at-most** |
 *
 * 第二、三类是本文件的**主要价值**：第一类只是确认现状没坏，
 * 第二、三类才是「上游被改坏之后仍然安全」的保证。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position, Street, type Card } from '../src/domain/types.ts';
import { cardToString, parseCardStrict } from '../src/domain/poker/cards.ts';
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
import {
  buildAnalyzableState,
  reconstructGameState,
  ReconstructMode,
} from '../src/app/manualInput/reconstruct.ts';
import {
  BOARD_COUNT_BY_STREET,
  parseManualInput,
  type ManualHandInput,
} from '../src/app/manualInput/manualInput.ts';
import { buildDecisionContext } from '../src/app/manualInput/contextBuilder.ts';
import { allBoardCards, createGame, type GameState } from '../src/domain/poker/gameState.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';
import { declaredStreetOfBoard } from '../src/app/table/tableAdapter.ts';

const RULES = loadKnowledgeBaseOrThrow().allRules();
const OPTIONS = {
  rules: RULES,
  asOf: 1_757_000_000_000,
  writeLog: false,
  environment: 'LOW_STAKES_ONLINE',
} as const;

const RING_9: readonly Position[] = [
  Position.UTG,
  Position.UTG1,
  Position.UTG2,
  Position.LJ,
  Position.HJ,
  Position.CO,
  Position.BTN,
  Position.SB,
  Position.BB,
];

/** 五张公共牌（顺序即「公开顺序」） */
const FULL_BOARD = ['Ah', '7c', '2d', 'Ks', '9h'] as const;

const VIOLATION = 'DECISION_BOARD_VISIBILITY_VIOLATION';

/* ============================================================
 * 第一部分：合法入口
 * ============================================================ */

/**
 * 造一手「Hero 在 BTN，行动记录刚好停在 `decisionStreet` 的决策点」的输入。
 *
 * ## 为什么由引擎驱动而不是手写行动序列
 *
 * 手写序列必须自己算「下一位该谁」，而本项目的行动顺序是**按物理座位环绕**、
 * 且受弃牌/全下影响 —— 手写几乎必然写错（实测第一版就写错了两次：
 * ① 9 座桌 Hero 在 BTN，翻牌前他**先于** SB/BB 行动；
 * ② 让所有人弃牌会让本手**因弃牌直接结束**，根本走不到翻牌）。
 *
 * 这里改成：**每一步都问引擎「现在轮到谁、要跟多少」**，然后照做。
 * 于是顺序永远正确，也不依赖任何硬编码的座位表。
 *
 * 策略：**所有人都跟注**（翻牌后无人下注则过牌）。当引擎说
 * 「轮到 Hero」且已经在目标街时，**停手** —— 那就是决策点。
 */
function legalInput(decisionStreet: Street): ManualHandInput {
  type Step = {
    position: Position;
    type: 'CALL' | 'CHECK';
    amountBB?: number;
    street: Street;
  };

  const base = {
    tableSize: 9,
    heroPosition: Position.BTN,
    heroCards: ['As', 'Kd'],
    board: FULL_BOARD.slice(0, BOARD_COUNT_BY_STREET[decisionStreet]),
    street: decisionStreet,
    effectiveStackBB: 100,
    environment: 'LOW_STAKES_ONLINE',
    occupiedPositions: RING_9,
    buttonPosition: Position.BTN,
  };

  const history: Step[] = [];
  for (let guard = 0; guard < 80; guard += 1) {
    const probe = parseManualInput({ ...base, actionHistory: history } as unknown as ManualHandInput);
    if (!probe.ok) {
      throw new Error(
        `驱动失败（第 ${history.length + 1} 步解析被拒）：${JSON.stringify(probe.issues)}`,
      );
    }
    const replayed = reconstructGameState(probe.value, { mode: ReconstructMode.PREVIEW });
    if (!replayed.ok) {
      throw new Error(
        `驱动失败（第 ${history.length + 1} 步重放被拒）：${JSON.stringify(replayed.issues)}`,
      );
    }
    const st = replayed.state;

    if (STREET_RANK[st.street]! > STREET_RANK[decisionStreet]!) {
      throw new Error(`驱动失败：已经推进到 ${st.street}，越过了目标 ${decisionStreet}`);
    }

    const actorId = actorOnTurn(st);
    if (actorId === null) {
      throw new Error(
        `驱动失败：第 ${history.length + 1} 步时无人可行动（street=${st.street} phase=${st.phase}）`,
      );
    }
    const actor = st.players.find((p) => p.id === actorId)!;

    // ---- 到达决策点：轮到 Hero，且已经在目标街 ----
    if (st.street === decisionStreet && actor.position === Position.BTN) {
      return { ...base, actionHistory: history } as unknown as ManualHandInput;
    }

    /*
     * 跟注所需金额 = `currentBet - 本街已投入`。
     *
     * ⚠️ 必须**由引擎口径算**，不能猜：`ManualAction.amountBB` 对 CALL 的语义是
     * 「本次投入（BB）」，猜错就会被 `CALL_AMOUNT_ILLEGAL` 拒。
     */
    const need = st.currentBet - actor.committedByStreet[st.street];
    history.push(
      need > 0
        ? {
            position: actor.position,
            type: 'CALL',
            amountBB: need / 100, // 1BB = 100 筹码
            street: st.street,
          }
        : { position: actor.position, type: 'CHECK', street: st.street },
    );
  }
  throw new Error('驱动失败：步数超限');
}

const STREET_RANK: Readonly<Record<string, number>> = {
  PREFLOP: 0,
  FLOP: 1,
  TURN: 2,
  RIVER: 3,
};

/** 跑完整条 Analyze 路径，返回 `DecisionContext.board` */
function analyzeBoardOf(street: Street): readonly Card[] {
  const parsed = parseManualInput(legalInput(street));
  assert.equal(parsed.ok, true, parsed.ok ? '' : JSON.stringify(parsed.issues));
  if (!parsed.ok) throw new Error('unreachable');
  const gate = buildAnalyzableState(parsed.value);
  assert.equal(gate.ok, true, gate.ok ? '' : JSON.stringify(gate.issues));
  if (!gate.ok) throw new Error('unreachable');
  assert.equal(gate.state.street, street, '决策点街道必须与声明一致');
  const ctx = buildDecisionContext({ ...OPTIONS, state: gate.state });
  return ctx.context.board;
}

test('§ADD-LEGAL-1：翻牌前决策 → DecisionContext.board 恰好 0 张', () => {
  const board = analyzeBoardOf(Street.PREFLOP);
  assert.equal(board.length, 0, `翻牌前必须看不到任何公共牌，实际 ${board.length} 张`);
});

test('§ADD-LEGAL-2：翻牌决策 → DecisionContext.board 恰好 3 张', () => {
  const board = analyzeBoardOf(Street.FLOP);
  assert.equal(board.length, 3, `翻牌必须恰好 3 张，实际 ${board.length} 张`);
  assert.deepEqual(
    board.map(cardToString),
    FULL_BOARD.slice(0, 3),
    '必须是前 3 张，且顺序一致',
  );
});

test('§ADD-LEGAL-3：转牌决策 → DecisionContext.board 恰好 4 张', () => {
  const board = analyzeBoardOf(Street.TURN);
  assert.equal(board.length, 4, `转牌必须恰好 4 张，实际 ${board.length} 张`);
  const shown = board.map(cardToString);
  assert.deepEqual(shown, FULL_BOARD.slice(0, 4), '必须是前 4 张');
  assert.ok(!shown.includes('9h'), '河牌的 9h 不得出现在转牌决策里');
});

test('§ADD-LEGAL-4：河牌决策 → DecisionContext.board 恰好 5 张', () => {
  const board = analyzeBoardOf(Street.RIVER);
  assert.equal(board.length, 5, `河牌必须恰好 5 张，实际 ${board.length} 张`);
  assert.deepEqual(board.map(cardToString), [...FULL_BOARD], '五张必须逐张一致');
});

/* ============================================================
 * 第二部分：绕过 Parser，直接攻击 ContextBuilder（规范 §6 第二类）
 * ============================================================ */

/**
 * 直接构造一个「街道与公共牌张数不一致」的 `GameState`，绕过解析器。
 *
 * 这是**攻击**，不是正常用法：它模拟「未来有人放宽了 Parser」
 * 之后会发生什么。护栏必须自己挡住。
 */
function forgedState(street: Street, boardCards: readonly string[], handedness = 9): GameState {
  const positions = RING_9.slice(0, handedness);
  const game = createGame({
    config: {
      tableSize: 9,
      smallBlind: 50,
      bigBlind: 100,
      ante: 0,
      dealerPosition: Position.BTN,
    },
    players: positions.map((position) => ({
      id: `seat_${position}`,
      name: position,
      position,
      startingStack: 10000,
      ...(position === Position.BTN ? { holeCards: ['As', 'Kd'].map(parseCardStrict) } : {}),
    })),
    userPlayerId: 'seat_BTN',
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  const cards = boardCards.map(parseCardStrict);
  return {
    ...game,
    street,
    board: {
      flop: cards.slice(0, 3),
      turn: cards.slice(3, 4),
      river: cards.slice(4, 5),
    },
  };
}

/** 攻击用例：`[街道, 公共牌张数]` */
const TOO_MANY: readonly [Street, number][] = [
  [Street.PREFLOP, 1],
  [Street.PREFLOP, 3],
  [Street.FLOP, 4],
  [Street.FLOP, 5],
  [Street.TURN, 5],
];

test('§ADD-ATTACK-1【未来牌泄漏】：街道与公共牌不一致时 ContextBuilder 必须 Fail Closed', () => {
  /*
   * 🔴 这是本文件的**核心**：即使 Parser 被放宽，
   * `DecisionContext` 也绝不能看到未来的牌。
   *
   * 期望行为是**抛错**，不是「悄悄 slice 掉多余的牌继续算」。
   */
  for (const [street, count] of TOO_MANY) {
    const expected = BOARD_COUNT_BY_STREET[street];
    assert.ok(
      count > expected,
      `攻击样本必须真的「多了」：${street} 期望 ${expected}，样本 ${count}`,
    );

    const forged = forgedState(street, FULL_BOARD.slice(0, count));
    assert.equal(
      allBoardCards(forged).length,
      count,
      '伪造状态必须真的带上了那些未来的牌（否则这条测试没有约束力）',
    );

    assert.throws(
      () => buildDecisionContext({ ...OPTIONS, state: forged }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(
          message.includes(VIOLATION),
          `${street} + ${count} 张必须报 ${VIOLATION}，实际：${message}`,
        );
        assert.ok(
          message.includes(`${expected} 张`) && message.includes(`实际 ${count} 张`),
          `错误信息必须写明「应有 ${expected} 张、实际 ${count} 张」：${message}`,
        );
        assert.ok(
          message.includes('信息泄漏'),
          `「多了」的情形必须明确指出这是信息泄漏：${message}`,
        );
        return true;
      },
      `${street} 有 ${count} 张公共牌时，ContextBuilder 必须拒绝而不是继续分析`,
    );
  }
});

test('§ADD-ATTACK-2【不得静默修正】：护栏必须拒绝，而**不是** slice 掉多余的牌', () => {
  /*
   * 反证：证明上面那条 `throws` 真的有约束力。
   *
   * 若实现改成 `board.slice(0, expected)`，`buildDecisionContext` 会
   * **成功返回**，于是上面那条 `assert.throws` 变红。本条把这件事
   * 说得更直白：伪造状态的返回**绝对不能是一个正常的 context**。
   */
  const forged = forgedState(Street.PREFLOP, FULL_BOARD.slice(0, 3));
  let returned: unknown = null;
  let threw = false;
  try {
    returned = buildDecisionContext({ ...OPTIONS, state: forged });
  } catch {
    threw = true;
  }
  assert.equal(threw, true, '必须抛错');
  assert.equal(
    returned,
    null,
    '**不得**返回一个「已经悄悄删掉未来牌」的 context —— 那会让使用者拿到一份基于被改过的输入算出来的建议',
  );
});

test('§ADD-ATTACK-3【不得自动改街道】：护栏只验证，不得用牌面反推 street', () => {
  /*
   * 反证：若实现里写了 `street = streetFromBoard(board)`，
   * 那 `PREFLOP + 3 张` 会被「修正」成 FLOP 然后照常分析。
   *
   * 本条的判据：伪造 `PREFLOP + 3 张` 必须报错，
   * 且错误信息里的街道必须仍然是**翻牌前**（声明值），
   * 而不是被改成翻牌。
   */
  const forged = forgedState(Street.PREFLOP, FULL_BOARD.slice(0, 3));
  assert.throws(
    () => buildDecisionContext({ ...OPTIONS, state: forged }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(
        message.includes('翻牌前'),
        `错误信息必须保留**声明**的街道（翻牌前）：${message}`,
      );
      assert.ok(
        !message.includes('当前街道「翻牌」'),
        `不得把街道自动改成由牌面反推的值：${message}`,
      );
      return true;
    },
  );
});

test('§ADD-ATTACK-4：伪造状态在 `validateGameState` 之外也必须被拦（护栏不依赖校验器）', () => {
  /*
   * 本护栏必须是 `buildDecisionContext` **自己**的检查，
   * 而不是「因为上游校验器已经拦了所以安全」。
   *
   * 判据：直接拿伪造状态调 `buildDecisionContext`（不经过任何校验器），
   * 仍然必须抛错。
   */
  const forged = forgedState(Street.FLOP, FULL_BOARD.slice(0, 5));
  assert.throws(
    () => buildDecisionContext({ ...OPTIONS, state: forged }),
    (error: unknown) =>
      (error instanceof Error ? error.message : '').includes(VIOLATION),
  );
});

/* ============================================================
 * 第三部分：反方向 —— 可见性是 exact，不是 at-most（规范 §7）
 * ============================================================ */

/** 攻击用例：`[街道, 公共牌张数]`，**少了** */
const TOO_FEW: readonly [Street, number][] = [
  [Street.FLOP, 0],
  [Street.FLOP, 2],
  [Street.TURN, 3],
  [Street.TURN, 0],
  [Street.RIVER, 4],
  [Street.RIVER, 3],
];

test('§ADD-EXACT-1【少了也要拒】：街道需要 N 张却只有 M<N 张时必须 Fail Closed', () => {
  /*
   * 少了同样危险：`FLOP + 0 张` 会让决策层以为「翻牌还没发」，
   * 于是牌力评估、权益、底池赔率全部基于一个错误的局面。
   *
   * 「至少」不是不变量，「恰好」才是。
   */
  for (const [street, count] of TOO_FEW) {
    const expected = BOARD_COUNT_BY_STREET[street];
    assert.ok(
      count < expected,
      `攻击样本必须真的「少了」：${street} 期望 ${expected}，样本 ${count}`,
    );

    const forged = forgedState(street, FULL_BOARD.slice(0, count));
    assert.equal(allBoardCards(forged).length, count, '伪造状态必须真的只有这么多张');

    assert.throws(
      () => buildDecisionContext({ ...OPTIONS, state: forged }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(
          message.includes(VIOLATION),
          `${street} + ${count} 张（少了）必须报 ${VIOLATION}，实际：${message}`,
        );
        assert.ok(
          message.includes(`实际 ${count} 张`),
          `错误信息必须写明实际张数：${message}`,
        );
        return true;
      },
      `${street} 只有 ${count} 张公共牌时（应有 ${expected} 张），ContextBuilder 必须拒绝`,
    );
  }
});

test('§ADD-EXACT-2【穷举 exact】：四街 × 0~5 张全部组合，恰好相等才放行', () => {
  /*
   * 穷举，避免「只测了几个我想到的组合」。
   *
   * 期望：`count === BOARD_COUNT_BY_STREET[street]` 时放行，其余一律抛错。
   * 这里只断言**护栏这一层**的行为，因此捕获异常即视为「被拒」，
   * 不断言放行后的分析是否成功（那是第一部分的事）。
   */
  let allowed = 0;
  let rejected = 0;
  for (const street of [Street.PREFLOP, Street.FLOP, Street.TURN, Street.RIVER]) {
    const expected = BOARD_COUNT_BY_STREET[street];
    for (let count = 0; count <= 5; count += 1) {
      const forged = forgedState(street, FULL_BOARD.slice(0, count));
      let threw = false;
      let message = '';
      try {
        buildDecisionContext({ ...OPTIONS, state: forged });
      } catch (error) {
        threw = true;
        message = error instanceof Error ? error.message : String(error);
      }

      if (count === expected) {
        /*
         * 张数正确 → 护栏**不得**因为可见性而拒绝。
         *
         * ⚠️ 分析本身可能因为别的合法原因失败（本手没有决策点等），
         * 但**绝不能**是可见性违规 —— 后者说明护栏的实现写错了。
         */
        assert.ok(
          !message.includes(VIOLATION),
          `${street} + ${count} 张（恰好）不得被判为可见性违规：${message}`,
        );
        allowed += 1;
      } else {
        assert.equal(
          threw,
          true,
          `${street} + ${count} 张（应为 ${expected} 张）必须被拒，却放行了`,
        );
        assert.ok(
          message.includes(VIOLATION),
          `${street} + ${count} 张的拒绝理由必须是 ${VIOLATION}，实际：${message}`,
        );
        rejected += 1;
      }
    }
  }
  assert.equal(allowed, 4, `恰好相等的组合应当有 4 个（每街一个），实际 ${allowed}`);
  assert.equal(rejected, 20, `不一致的组合应当有 20 个，实际 ${rejected}`);
});

/* ============================================================
 * 第四部分：唯一权威表 + 反证
 * ============================================================ */

test('§ADD-TABLE-1：`BOARD_COUNT_BY_STREET` 是唯一权威，反查函数必须与它一致', () => {
  /*
   * §5：不许在 manualInput / tableAdapter / contextBuilder 各写一份 0/3/4/5。
   *
   * 本条的判据：对**每一个**街道，用权威表的张数去反查，必须回到同一个街道。
   * 若适配器里还留着写死的 `if (boardCount === 3) return 'FLOP'`，
   * 一旦权威表改变（例如加短牌变体），这条就会失败。
   */
  for (const street of [Street.PREFLOP, Street.FLOP, Street.TURN, Street.RIVER]) {
    const count = BOARD_COUNT_BY_STREET[street];
    assert.equal(
      declaredStreetOfBoard(count),
      street,
      `权威表说 ${street} 是 ${count} 张，反查却给出 ${String(declaredStreetOfBoard(count))}`,
    );
  }
  // 选择中的张数没有合法街道
  assert.equal(declaredStreetOfBoard(1), null, '1 张 = 选牌中，没有合法街道');
  assert.equal(declaredStreetOfBoard(2), null, '2 张 = 选牌中，没有合法街道');
});

test('§ADD-TABLE-2：权威表本身必须是 0/3/4/5 且冻结（防止被人顺手改坏）', () => {
  assert.deepEqual(
    { ...BOARD_COUNT_BY_STREET },
    { PREFLOP: 0, FLOP: 3, TURN: 4, RIVER: 5 },
    '四个街道的张数必须是 0/3/4/5',
  );
  assert.equal(Object.isFrozen(BOARD_COUNT_BY_STREET), true, '权威表必须冻结');
});

test('§ADD-TABLE-3【反证】：护栏的判据对「多一张」与「少一张」都敏感', () => {
  /*
   * 反证「护栏真的在比较」，而不是碰巧因为别的原因抛错。
   *
   * 做法：对每一个街道，取正确的张数（应当放行）与 ±1 张（必须被拒），
   * 断言三者的**判据结果**两两不同。
   */
  for (const street of [Street.PREFLOP, Street.FLOP, Street.TURN, Street.RIVER]) {
    const expected = BOARD_COUNT_BY_STREET[street];
    const verdict = (count: number): boolean => {
      try {
        buildDecisionContext({ ...OPTIONS, state: forgedState(street, FULL_BOARD.slice(0, count)) });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        return !message.includes(VIOLATION); // 非可见性原因的失败仍算「护栏放行」
      }
    };

    assert.equal(verdict(expected), true, `${street} + ${expected} 张必须被护栏放行`);
    for (const delta of [-1, 1]) {
      const wrong = expected + delta;
      if (wrong < 0 || wrong > 5) continue;
      assert.equal(
        verdict(wrong),
        false,
        `${street} + ${wrong} 张（应 ${expected} 张）必须被护栏拒绝`,
      );
    }
  }
});

/* ============================================================
 * 第五部分：重放侧 —— 全局牌面仍然必须被完整恢复
 * ============================================================ */

test('§ADD-REPLAY：PREVIEW 重放不得因为护栏而失去「停在哪一街就只发到哪一街」', () => {
  /*
   * 与上面四条**不矛盾**，而是另一半：
   *
   * - **Analyze（决策快照）**：只能看到该时刻公开的牌
   * - **Preview（牌桌最终状态）**：街道与牌面必须一一对应
   *
   * 两者共同的底线：**停在哪一街，就只发到哪一街**（§9：
   * All-In 也不代表可以凭空发牌）。
   */
  const parsed = parseManualInput(legalInput(Street.PREFLOP));
  assert.equal(parsed.ok, true, parsed.ok ? '' : JSON.stringify(parsed.issues));
  if (!parsed.ok) return;

  const preview = reconstructGameState(parsed.value, { mode: ReconstructMode.PREVIEW });
  assert.equal(preview.ok, true, preview.ok ? '' : JSON.stringify(preview.issues));
  if (!preview.ok) return;

  assert.equal(
    allBoardCards(preview.state).length,
    BOARD_COUNT_BY_STREET[preview.state.street],
    '重放结果的「街道」与「公共牌张数」必须一一对应 —— 这正是护栏在要求的不变量',
  );
});
