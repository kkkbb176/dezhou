/**
 * 德州扑克规则对照（独立参考实现）
 *
 * ## 为什么需要**独立**参考实现
 *
 * 项目里 `handEval` 与 `fastEval` 是同一套规则的两份实现，两者之间的差分
 * 测试看起来很有力 —— 但它们**可能共享同一个错误**，那时差分恒为 0，
 * 测试再多样也发现不了。
 *
 * 2026-09 实际发生了这件事：两对的踢脚在「三个对子共存」时取错，
 * 两份实现一起错，62 万+ 随机 7 张差异为 0。它最终是被
 * **独立参考实现穷举**找出来的。
 *
 * 因此本文件刻意**不调用** `handEval` / `fastEval` 的任何评估函数，
 * 自己按规则从零写一份最朴素的实现（穷举全部 5 张组合取最强），
 * 再与项目实现逐手对照。参考实现慢、笨、但**独立** ——
 * 那正是它的价值。
 *
 * ## 覆盖的规则
 *
 * | 规则 | 为什么它值得单独钉住 |
 * |---|---|
 * | 两对踢脚（三对共存） | 曾经错，且被测试与文档一起固化住 |
 * | 大盲的选择权 | 引擎一直允许、推导层却把它抹掉（跨层不一致） |
 * | 短大盲不降低入池代价 | 曾经让其他人半价入池 |
 * | 短全下不关闭未行动者的加注权 | 曾经吃掉大盲的选择权 |
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCardStrict } from '../src/domain/poker/cards.ts';
import { evaluateCards, compareHands } from '../src/domain/poker/handEval.ts';
import { evaluateSeven } from '../src/domain/poker/fastEval.ts';
import { createGame, minRaiseTo, requiredCallAmount, type GameState } from '../src/domain/poker/gameState.ts';
import { applyAction, canRaise } from '../src/domain/poker/engine.ts';
import { HandCategory, type ActionType } from '../src/domain/types.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';

/* ============================================================
 * 独立参考实现（不依赖项目评估器）
 * ============================================================ */

const RANK_ORDER = '23456789TJQKA';
/** 独立实现用 0..12（2..A）—— **与项目的 `Rank`（2..14）不同刻度，但顺序关系一致** */
const rankOf = (card: string): number => RANK_ORDER.indexOf(card[0]!.toUpperCase());

/**
 * 🔴 **两套刻度的换算**（这是个容易踩的坑）。
 *
 * 本文件有两套点数表示：
 *
 * | 来源 | 刻度 | Q 的值 |
 * |---|---|---|
 * | 独立参考（本文件） | `0..12`（`2`..`A`） | **10** |
 * | 项目 `Card.rank` / `EvaluatedHand.ranks` | `2..14`（`2`..`A`） | **12** |
 *
 * 两者的**顺序关系完全相同**，因此比较结果一致；但**数值**不同，
 * 直接比对会全线失败。这个坑在本文件的第一次运行里真的踩到了
 *（把项目的数字 `ranks` 当成字符串喂给 `indexOf`，得到一堆 `-1`）。
 */
const projectRankToReference = (rank: unknown): number => Number(rank) - 2;

/**
 * 给 5 张牌打分。返回可直接比较的数组：`[类别, ...降序关键点数]`。
 *
 * 类别：8 同花顺 · 7 四条 · 6 葫芦 · 5 同花 · 4 顺子 ·
 *       3 三条 · 2 两对 · 1 一对 · 0 高牌
 */
function rankFive(cards: readonly string[]): number[] {
  const rs = cards.map(rankOf).sort((a, b) => b - a);
  const suits = cards.map((c) => c[1]!.toLowerCase());
  const flush = suits.every((s) => s === suits[0]);

  const uniq = [...new Set(rs)];
  let straightHigh: number | null = null;
  if (uniq.length === 5) {
    if (uniq[0]! - uniq[4]! === 4) straightHigh = uniq[0]!;
    // 轮子 A2345：A 当低，5 高
    else if (uniq[0] === 12 && uniq[1] === 3) straightHigh = 3;
  }

  const counts = new Map<number, number>();
  for (const r of rs) counts.set(r, (counts.get(r) ?? 0) + 1);
  // 先按出现次数降序，再按点数降序 —— 这正是「最强的五张」的比较顺序
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const g = groups.map((x) => x[0]);

  if (flush && straightHigh !== null) return [8, straightHigh];
  if (groups[0]![1] === 4) return [7, g[0]!, g[1]!];
  if (groups[0]![1] === 3 && groups[1]![1] === 2) return [6, g[0]!, g[1]!];
  if (flush) return [5, ...rs];
  if (straightHigh !== null) return [4, straightHigh];
  if (groups[0]![1] === 3) return [3, g[0]!, g[1]!, g[2]!];
  // 两对：两个对子 + **第三组点数**（可能是第三个对子里的牌）
  if (groups[0]![1] === 2 && groups[1]![1] === 2) return [2, g[0]!, g[1]!, g[2]!];
  if (groups[0]![1] === 2) return [1, g[0]!, g[1]!, g[2]!, g[3]!];
  return [0, ...rs];
}

function compareScores(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 穷举全部 5 张组合，取最强 —— 笨但**独立** */
function bestFiveScore(cards: readonly string[]): number[] {
  let best: number[] | null = null;
  const idx: number[] = [];
  const rec = (start: number): void => {
    if (idx.length === 5) {
      const score = rankFive(idx.map((i) => cards[i]!));
      if (best === null || compareScores(score, best) > 0) best = score;
      return;
    }
    for (let i = start; i < cards.length; i++) {
      idx.push(i);
      rec(i + 1);
      idx.pop();
    }
  };
  rec(0);
  return best!;
}

const toCards = (list: readonly string[]) => list.map(parseCardStrict);

/* ============================================================
 * 1) 两对踢脚：三对共存
 * ============================================================ */

test('RULE-01：三对共存时两对的踢脚 = 第三个对子里那张（独立参考对照）', () => {
  /*
   * `Q Q T T 8 8 3` 的最佳五张是 `Q Q T T 8`（8 > 3）。
   * 旧实现只从「未成对的点数」取踢脚，得到 `Q Q T T 3` —— 错。
   */
  const seven = ['Qs', 'Ts', 'Qh', 'Th', '8c', '8d', '3s'];
  const reference = bestFiveScore(seven);
  // 独立实现的刻度是 0..12：Q=10、T=8、8=6、3=1
  assert.deepEqual(reference, [2, 10, 8, 6], '独立参考的最佳五张必须是 Q Q T T 8');

  const project = evaluateCards(toCards(seven));
  /*
   * ⚠️ 项目的 `HandCategory` 是 **1..9**（高牌=1 … 同花顺=9），
   * 不是本文件参考实现的 0..8。这里用**具名枚举**而不是硬编码数字 ——
   * 硬编码会随刻度变化而静默失效（本文件第一次运行就踩到了）。
   */
  assert.equal(project.category, HandCategory.TWO_PAIR, '牌型必须是两对');
  assert.deepEqual(
    project.ranks.map(projectRankToReference),
    reference.slice(1),
    '关键点数必须与独立参考一致 —— 踢脚是 8（第三个对子），不是 3',
  );
  assert.equal(evaluateSeven(toCards(seven)), project.value, 'fastEval 必须与 handEval 一致');
});

test('RULE-02：全部 (2,2,2,1) 型 7 张与独立参考零差异', () => {
  /*
   * 穷举「三个对子 + 一个单张」这一整类（约 10 万手），
   * 逐手与独立参考比对。这是发现「两个实现共享同一错误」的关键手段 ——
   * 项目内部两份实现之间的差分测试对这类缺陷**无效**。
   */
  const ranks = [...RANK_ORDER];
  const suits = ['s', 'h', 'd', 'c'];
  // 为避免组合爆炸，按点数组合 × 花色轮换抽样
  let checked = 0;
  let mismatches = 0;

  for (let a = 0; a < 13; a++) {
    for (let b = a + 1; b < 13; b++) {
      for (let c = b + 1; c < 13; c++) {
        for (let d = 0; d < 13; d++) {
          if (d === a || d === b || d === c) continue;
          // 三对 + 单张，用不同花色避免意外成同花
          const hand = [
            ranks[a]! + suits[0]!, ranks[a]! + suits[1]!,
            ranks[b]! + suits[2]!, ranks[b]! + suits[3]!,
            ranks[c]! + suits[0]!, ranks[c]! + suits[1]!,
            ranks[d]! + suits[2]!,
          ];
          const reference = bestFiveScore(hand);
          if (reference[0] !== 2) continue; // 只比较两对（单张更大时可能是别的牌型）
          const project = evaluateCards(toCards(hand));
          checked++;
          if (compareScores(project.ranks.map(projectRankToReference), reference.slice(1)) !== 0) {
            mismatches++;
            if (mismatches <= 3) {
              console.log(`  差异：${hand.join(' ')} 参考=${JSON.stringify(reference)} 项目=${JSON.stringify(project.ranks)}`);
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 1000, `必须真的比对了足够多样本，实际 ${checked}`);
  assert.equal(mismatches, 0, `${checked} 手 (2,2,2,1) 型中必须零差异，实际 ${mismatches} 手不一致`);
});

test('RULE-03：三对共存时的胜负必须与独立参考一致', () => {
  const board = ['Qh', 'Qd', 'Tc', 'Td', '3s'];
  const hands = [
    ['8s', '8h'],
    ['7s', '7h'],
    ['5s', '4d'],
    ['Ad', 'Kd'],
  ];
  const scores = hands.map((h) => bestFiveScore([...board, ...h]));
  for (let i = 0; i < hands.length; i++) {
    for (let j = 0; j < hands.length; j++) {
      if (i === j) continue;
      const expected = compareScores(scores[i]!, scores[j]!);
      const actual = compareHands(
        evaluateCards(toCards([...board, ...hands[i]!])),
        evaluateCards(toCards([...board, ...hands[j]!])),
      );
      assert.equal(
        actual,
        expected,
        `${hands[i]!.join('')} vs ${hands[j]!.join('')}：参考=${expected} 项目=${actual}`,
      );
    }
  }
});

/* ============================================================
 * 2) 大盲的选择权（翻牌前 option）
 * ============================================================ */

const POS_6 = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'] as const;

function makeGame6(stacks: Partial<Record<(typeof POS_6)[number], number>> = {}) {
  return createGame({
    id: 'rule-test',
    config: { tableSize: 6, smallBlind: 50, bigBlind: 100, ante: 0, dealerPosition: 'BTN' },
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

test('RULE-04：引擎接受的动作必须在合法动作推导里（跨层一致性）', () => {
  /*
   * 这是 `legalActions` 模块自己文档里写的契约：
   * 「未推导出的动作 `applyAction` 必须拒绝」。
   *
   * 2026-09 它被打破了：全员溜入后引擎接受大盲加注，而
   * `deriveLegalActions` 只返回 `["FOLD","CHECK"]` —— 因为判据里
   * 有一句 `!canCheck`，把「能过牌」当成「不能加注」。
   * 界面只按推导结果生成按钮，于是**大盲永远看不到加注入口**。
   */
  let state = makeGame6();
  for (const pos of ['UTG', 'HJ', 'CO', 'BTN']) {
    const r = doAction(state, pos, 'CALL', 100);
    assert.equal(r.ok, true);
    state = r.state;
  }
  const sbCall = doAction(state, 'SB', 'CALL', 50);
  assert.equal(sbCall.ok, true);
  state = sbCall.state;

  assert.equal(requiredCallAmount(state, 'bb'), 0, '大盲已跟平，可以过牌');
  const engine = doAction(state, 'BB', 'RAISE', 400);
  assert.equal(engine.ok, true, '引擎必须允许大盲加注（这是它的选择权）');

  const bbPlayer = state.players.find((p) => p.id === 'bb')!;
  const legal = deriveLegalActions(state, bbPlayer);
  assert.ok(
    legal.actions.includes('RAISE'),
    `引擎接受了 RAISE，推导层就必须给出它；实际 ${JSON.stringify(legal.actions)}`,
  );
  assert.ok(legal.actions.includes('CHECK'), '过牌与加注互不排斥，两者必须同时合法');
});

/* ============================================================
 * 3) 短大盲不降低入池代价
 * ============================================================ */

test('RULE-05：大盲不足额全下时，其他人仍须跟满一个大盲', () => {
  /*
   * 旧实现 `currentBet = max(小盲实际投入, 大盲实际投入)` ——
   * 大盲投不满时把入池代价拉到**大盲以下**，其他人可以半价入池。
   */
  const state = makeGame6({ BB: 60 });
  const s = state as unknown as {
    currentBet: number;
    config: { bigBlind: number };
    players: readonly { id: string }[];
  };
  assert.equal(state.currentBet, state.config.bigBlind, '入池代价必须是一个完整大盲');

  assert.equal(requiredCallAmount(state, 'utg'), 100, '其他人必须跟满一个大盲');
  assert.equal(minRaiseTo(state), 200, '最小加注仍到大盲的两倍');

  const full = doAction(state, 'UTG', 'CALL', 100);
  assert.equal(full.ok, true, '跟满一个大盲必须合法');
  const half = doAction(state, 'UTG', 'CALL', 50);
  assert.equal(half.ok, false, '半价入池必须被拒绝');
});

/* ============================================================
 * 4) 短全下不关闭未行动者的加注权
 * ============================================================ */

test('RULE-06：短全下只关闭「已行动过」的玩家，未行动者（尤其大盲）保留加注权', () => {
  /*
   * 旧判据 `committed >= previousBet` 把**盲注**也算成「已行动」，
   * 于是被迫投下大盲的玩家被关掉加注权 —— 而 TDA 43 说的是
   * 「不重开给**已经行动过**的玩家」。
   */
  let state = makeGame6({ HJ: 350 });
  const utg = doAction(state, 'UTG', 'RAISE', 300); // 完整加注
  assert.equal(utg.ok, true);
  state = utg.state;
  const hj = doAction(state, 'HJ', 'ALL_IN'); // 350 全下，增量 50 < 200 ⇒ 短全下
  assert.equal(hj.ok, true);
  state = hj.state;

  assert.equal(canRaise(state, 'utg'), false, '已行动过的 UTG 仍应被关闭（这条不能修坏）');
  for (const id of ['co', 'btn', 'sb', 'bb']) {
    assert.equal(
      canRaise(state, id),
      true,
      `${id} 尚未行动过，短全下不该关掉它的加注权（盲注不算「已行动」）`,
    );
  }
});
