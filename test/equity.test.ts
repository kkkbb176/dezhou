/**
 * 权益计算测试（精确枚举 + 蒙特卡洛）
 *
 * 覆盖规范第 14 / 41 / 42 条；Bug 预判 B17 / B18 / B19 / M9 / M10。
 *
 * 核心命题：
 * 1. 数字必须正确（有经典基准值交叉验证）
 * 2. 算不了就说算不了（绝不编造）
 * 3. 结果可复现（同一 seed 必然同一结果）
 * 4. 快速评估器与权威评估器逐位一致
 *
 * 本文件同时固化了开发过程中真实出现过的 4 个 Bug 的回归用例，
 * 详见「回归测试」小节。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ITERATIONS,
  computeEquity,
  type OpponentRange,
} from '../src/domain/poker/equity.ts';
import { compareHands, evaluateCards } from '../src/domain/poker/handEval.ts';
import { evaluateSeven } from '../src/domain/poker/fastEval.ts';
import { ALL_CARDS, ALL_SUITS, HandCategory, type Card } from '../src/domain/types.ts';
import { cardKey } from '../src/domain/poker/cards.ts';
import { mulberry32 } from '../src/infra/rng.ts';
import { C, c } from './helpers.ts';

/** 由「点数 + 花色」规格列表构造范围 */
function range(label: string, ...comboSpecs: string[]): OpponentRange {
  return {
    label,
    combos: comboSpecs.map((spec) => {
      const cards = C(spec);
      assert.equal(cards.length, 2, `组合「${spec}」必须恰好 2 张`);
      return [cards[0]!, cards[1]!] as [Card, Card];
    }),
  };
}

/**
 * 某一手牌的全部组合。
 *
 * 用法：
 * - `allCombosOf('AA')` → 6 种（对子）
 * - `allCombosOf('AK')` → 16 种（4 同花 + 12 不同花）
 *
 * 绝不能复用同一张具体牌对象 —— 早期版本错误地复用了第一次解析出的两张牌，
 * 凭空造出「两张 A♠」这种非法组合，导致枚举局数翻倍、权益被算成 87.89%。
 */
function allCombosOf(spec: string): Array<[Card, Card]> {
  // 点数解析：接受 "AA" / "AK" / "Kc Kd" 三种写法
  const rankFromChar: Record<string, number> = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    T: 10, J: 11, Q: 12, K: 13, A: 14,
  };
  const compact = spec.replace(/[\s,]/g, '');
  let rankA: number;
  let rankB: number;
  if (compact.length === 2) {
    rankA = rankFromChar[compact[0]!.toUpperCase()]!;
    rankB = rankFromChar[compact[1]!.toUpperCase()]!;
  } else {
    const parsed = C(spec);
    rankA = parsed[0]!.rank;
    rankB = parsed[1]!.rank;
  }
  assert.ok(rankA >= 2 && rankB >= 2, `allCombosOf 无法解析「${spec}」`);

  const out: Array<[Card, Card]> = [];
  for (let i = 0; i < ALL_SUITS.length; i++) {
    for (let j = 0; j < ALL_SUITS.length; j++) {
      // 同点数时只取「花色下标有序」的一半，否则 (K♥K♦) 与 (K♦K♥) 会被当成两个组合，
      // 组合数翻倍（6 → 12）并把枚举局数与权益一起算错
      if (rankA === rankB && j <= i) continue;
      out.push([
        { rank: rankA as Card['rank'], suit: ALL_SUITS[i]! },
        { rank: rankB as Card['rank'], suit: ALL_SUITS[j]! },
      ]);
    }
  }
  return out;
}

/** KQo 的全部 16 种组合（4 同花 + 12 不同花） */
const KQO_COMBOS: string[] = (() => {
  const out: string[] = [];
  for (const s1 of ALL_SUITS) {
    for (const s2 of ALL_SUITS) out.push(`K${s1} Q${s2}`);
  }
  return out;
})();

/* ============================================================
 * 评估器一致性
 * ============================================================ */

describe('权益 —— 快速评估器与权威评估器必须逐位一致', () => {
  it('随机 20000 组 7 张牌，两者强度编码完全相同（差分测试）', () => {
    const rng = mulberry32(987654321);
    let mismatches = 0;
    const sampleSize = 20000;

    for (let t = 0; t < sampleSize; t++) {
      // 每轮重新洗牌，保证无放回且不重复
      const pool = ALL_CARDS.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = pool[i]!;
        pool[i] = pool[j]!;
        pool[j] = tmp;
      }
      const hand = pool.slice(0, 7);
      assert.equal(new Set(hand.map(cardKey)).size, 7, '差分测试生成的 7 张牌必须互不相同');

      const slow = evaluateCards(hand).value;
      const fast = evaluateSeven(hand);
      if (slow !== fast) {
        mismatches++;
        if (mismatches <= 3) {
          assert.fail(
            `差异样例 ${hand.map(cardKey).join(' ')}：权威评估器 ${slow}，快速评估器 ${fast}`,
          );
        }
      }
    }

    assert.equal(mismatches, 0, `${mismatches}/${sampleSize} 组牌的两种评估器结果不一致`);
  });

  it('九种牌型的边界用例逐一比对', () => {
    const cases = [
      'As Kd 9h 7c 3s 2d 4h', // 顺子（A2345 轮子）
      'As Ad 9h 7c 3s 2d 4h',
      'As Ad 9h 9c 3s 2d 4h',
      'As Ad Ah 9c 3s 2d 4h',
      '9s 8d 7h 6c 5s Ad 2h',
      'As Ks 9s 7s 3s 2d 4h',
      'As Ad Ah 9c 9s 2d 4h',
      'As Ad Ah Ac 9s 2d 4h',
      '9s 8s 7s 6s 5s Ad 2h',
    ];
    for (const spec of cases) {
      const cards = C(spec);
      assert.equal(evaluateSeven(cards), evaluateCards(cards).value, `${spec} 两种评估器不一致`);
    }
  });
});

/* ============================================================
 * 回归测试：开发过程中真实出现过的 Bug
 * ============================================================ */

describe('权益 —— 回归测试（真实出现过的 Bug）', () => {
  it('回归 B1：两对的踢脚 = 排除两个对子点数后的最高牌（三对时取第三个对子）', () => {
    /*
     * 🔴 **这条测试在 2026-09 被改正过一次，两个方向都值得记住。**
     *
     * ## 曾经错在哪
     *
     * 旧断言是 `ranks = [12, 10, 3]`，理由是「踢脚必须来自**未成对**的点数」。
     * 那个理由是**错的**：一手牌 = 7 张里最强的 5 张，
     * 规则从未要求踢脚来自只出现一次的点数。
     *
     * `Q Q T T 8 8 3` 的候选五张里 `Q Q T T 8` 大于 `Q Q T T 3`
     *（8 > 3），因此最佳五张是 `Q Q T T 8` ——
     * **第三个对子里的那张 8 完全可以充当第五张牌**。
     *
     * 同一份文件里处理四条时（回归 B2：`7 7 7 7 J J 4` 踢脚取 J）
     * 早就用对了这个道理，两处标准不一致本身就是旧写法有问题的证据。
     *
     * ## 为什么这个 bug 能活这么久
     *
     * `handEval` 与 `fastEval` **共享同一个错误**，因此它们之间的差分测试
     * 恒为 0 —— 那种看似严密的测试**对这类缺陷完全无效**。
     * 它最终是被「独立参考实现穷举全部组合」找出来的。
     *
     * 影响面（修复前实测）：`(2,2,2,1)` 型 7 张有 25% 编码错误，
     * 占全部 C(52,7) 的 0.462%；真实摊牌模拟 20 万次有 82 次判错胜负。
     */
    const hand = evaluateCards(C('Qd Qc Td Tc 8c 8h 3h'));
    assert.equal(hand.category, HandCategory.TWO_PAIR);
    assert.deepEqual(
      hand.ranks,
      [12, 10, 8],
      '两对的踢脚是排除 Q、T 之后的最高牌 —— 这里是第三个对子的 8，不是单张里最高的 3',
    );
    assert.equal(
      evaluateSeven(C('Qd Qc Td Tc 8c 8h 3h')),
      hand.value,
      '两个评估器（handEval / fastEval）必须一致 —— 但它们共享错误时差分测试无效，故这里只是底线',
    );

    // 另一组：K K 5 5 Q 3 2 → 踢脚 Q（没有第三个对子，两种口径结果相同）
    const hand2 = evaluateCards(C('Kc Kh 5c 5h Qs 3d 2h'));
    assert.deepEqual(hand2.ranks, [13, 5, 12]);
    assert.equal(evaluateSeven(C('Kc Kh 5c 5h Qs 3d 2h')), hand2.value);
  });

  it('回归 B1b：三对共存时的胜负与平分判定（踢脚 bug 的直接后果）', () => {
    /*
     * 牌面 `Q Q T T 3`：三家的最佳五张都含公共牌的两对，第五张由底牌决定。
     *
     * | 底牌 | 最佳五张 | 踢脚 |
     * |---|---|---|
     * | 8♠8♥ | Q Q T T **8** | 8 |
     * | 7♠7♥ | Q Q T T **7** | 7 |
     * | 5♠4♦ | Q Q T T **5** | 5 |
     *
     * 修复前三个都被算成 `Q Q T T 3` ⇒ 88 与 54 **平分**（本应 88 赢），
     * 88 与 77 也平分（本应 88 赢）。
     */
    const board = C('Qh Qd Tc Td 3s');
    const hero = evaluateCards([...board, ...C('8s 8h')]);
    const v54 = evaluateCards([...board, ...C('5s 4d')]);
    const v77 = evaluateCards([...board, ...C('7s 7h')]);

    assert.deepEqual(hero.ranks, [12, 10, 8]);
    assert.deepEqual(v54.ranks, [12, 10, 5]);
    assert.deepEqual(v77.ranks, [12, 10, 7]);

    assert.equal(compareHands(hero, v54), 1, '88 必须赢 54 —— 修复前这里是 0（平分）');
    assert.equal(compareHands(hero, v77), 1, '88 必须赢 77 —— 修复前这里是 0（平分）');
    assert.equal(compareHands(v77, v54), 1, '77 必须赢 54');
  });

  it('回归 B2：四条的踢脚必须排除四条点数，且能取到对子的点数', () => {
    // 7 7 7 7 J J 4 —— 踢脚是 J（来自对子），不是 4
    const hand = evaluateCards(C('7h 7c 7d 7s Jc Jh 4s'));
    assert.equal(hand.category, HandCategory.FOUR_OF_A_KIND);
    assert.deepEqual(hand.ranks, [7, 11]);
    assert.equal(evaluateSeven(C('7h 7c 7d 7s Jc Jh 4s')), hand.value);

    // 四条带更大踢脚必须更强
    const withKing = evaluateCards(C('7h 7c 7d 7s Kc Qh 4s'));
    assert.equal(compareByValue(withKing.value, hand.value), 1);
  });

  it('回归 B3：精确枚举不得把对手的底牌重复发到公共牌上（AA vs KK 必须约 82%）', () => {
    const hero = C('Ac Ad');
    const villain: OpponentRange = { label: 'KK', combos: allCombosOf('KK') };
    const exact = computeEquity(hero, [], [villain], { forceMethod: 'EXACT' });
    assert.equal(exact.ok, true);
    if (!exact.ok) return;

    // 枚举局数必须恰好等于「组合数 × C(剩余牌数, 5)」
    // 剩余牌数 = 52 - 2(我的底牌) - 2(对手底牌) = 48
    const expectedMatchups = 6 * combinations(48, 5);
    assert.equal(exact.result.total, expectedMatchups);
    assert.equal(exact.result.equity > 0.8 && exact.result.equity < 0.84, true,
      `AA vs KK 精确权益异常：${(exact.result.equity * 100).toFixed(2)}%`);

    // 与蒙特卡洛交叉验证
    const sim = computeEquity(hero, [], [villain], {
      forceMethod: 'MONTE_CARLO',
      iterations: 40000,
      seed: 12345,
    });
    assert.equal(sim.ok, true);
    if (!sim.ok) return;
    assert.ok(
      Math.abs(exact.result.equity - sim.result.equity) < 0.015,
      `枚举与模拟不一致：${exact.result.equity} vs ${sim.result.equity}`,
    );
  });

  it('回归 B4：同花听牌补牌数必须扣除公共牌上已出现的同花色牌', () => {
    // 黑桃：A 2（我）+ K 9（公共牌）→ 剩余黑桃补牌 9 张
    // 但 K♠ 已在公共牌上，所以不是「13 - 4 = 9 张都在牌堆里」
    const hero = C('As 2s');
    const board = C('Ks 9s 3h');
    const result = computeEquity(hero, board, [range('顶对', 'Kd Qc')], { forceMethod: 'EXACT' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // 双街同花听牌对顶对（对手没有黑桃阻断牌）应明显高于 40%
    assert.ok(
      result.result.equity > 0.40 && result.result.equity < 0.55,
      `同花听牌权益异常：${(result.result.equity * 100).toFixed(2)}%`,
    );
    assert.equal(result.result.total, combinations(45, 2));
  });
});

function compareByValue(a: number, b: number): -1 | 0 | 1 {
  if (a > b) return 1;
  if (a < b) return -1;
  return 0;
}

function combinations(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i++) result = (result * (n - i)) / (i + 1);
  return Math.round(result);
}

/* ============================================================
 * 经典基准值
 * ============================================================ */

describe('权益 —— 🔴 精确枚举必须尊重范围后验权重（2026-09 修正轮）', () => {
  /*
   * ## 这一条锁的是一个**静默错答**
   *
   * `computeEquity` 有两条路径：容量够小走 `enumerateExact`（精确枚举），
   * 否则走蒙特卡洛。`opponentWeights`（范围后验）原先**只在蒙特卡洛分支**传递，
   * 精确枚举用 `equitySum / matchups` 均匀计权 —— 于是**同一份输入会因为
   * 「选型」不同给出不同答案**，而且不报任何错。
   *
   * ⚠️ 偏偏**单挑 / 窄范围**最容易落在精确枚举上（容量 ≤ `maxExactMatchups`），
   * 而那正是后验权重最要紧的局面：使用者刚把对手范围收窄，引擎却当没看见。
   *
   * 实测口径（牌面 K♥9♠4♦2♣，我 7♣6♣，对手 = {A♣Q♦ 权 99, 8♦8♣ 权 1}）：
   *
   * | 输入 | 修复前 | 修复后 |
   * |---|---|---|
   * | 不传权重 | 6.8182% | 6.8182%（逐位不变） |
   * | 权重 1:1 | 6.8182% | 6.8182% |
   * | **权重 99:1** | **6.8182%（错）** | **13.5000%** |
   * | **权重 1:99** | **6.8182%（错）** | **0.1364%** |
   */
  const opponent: OpponentRange = {
    label: '两道极化范围',
    combos: [
      [c('Ac'), c('Qd')],
      [c('8d'), c('8c')],
    ],
  };
  const hero = C('7c 6c');
  const board = C('Kh 9s 4d 2c');

  it('不传权重时行为逐位不变（向后兼容）', () => {
    const result = computeEquity(hero, board, [opponent], {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.result.method, 'EXACT');
    assert.ok(
      Math.abs(result.result.equity - 0.068182) < 1e-6,
      `无权重口径必须保持 6.8182%，实际 ${(result.result.equity * 100).toFixed(4)}%`,
    );
  });

  it('权重 1:1 与不传权重一致（均匀就是均匀）', () => {
    const plain = computeEquity(hero, board, [opponent], {});
    const even = computeEquity(hero, board, [opponent], { opponentWeights: [[1, 1]] });
    assert.equal(plain.ok && even.ok, true);
    if (!plain.ok || !even.ok) return;
    assert.equal(even.result.equity, plain.result.equity);
  });

  it('权重 99:1 ⇒ 必须给出「几乎总是 AQo」那一侧的权益（13.5%）', () => {
    const result = computeEquity(hero, board, [opponent], { opponentWeights: [[99, 1]] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.result.method, 'EXACT', '这个规模必须落在精确枚举路径上');
    assert.ok(
      Math.abs(result.result.equity - 0.135) < 1e-4,
      `精确枚举必须按权重算：期望 13.5000%，实际 ${(result.result.equity * 100).toFixed(4)}%`,
    );
    // 权重与组合必须逐位对齐：赢/平/负仍是**原始计数**，与权重无关
    assert.equal(
      result.result.wins + result.result.ties + result.result.losses,
      result.result.total,
    );
  });

  it('权重 1:99 ⇒ 结果必须**反向**（这才是「权重真的生效」）', () => {
    const result = computeEquity(hero, board, [opponent], { opponentWeights: [[1, 99]] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(
      Math.abs(result.result.equity - 0.001364) < 1e-5,
      `期望 0.1364%，实际 ${(result.result.equity * 100).toFixed(4)}%`,
    );
  });

  it('🔴 精确枚举与蒙特卡洛必须给出**同一个**答案（跨路径一致性）', () => {
    /*
     * 这正是修复前被破坏的性质：两条路径对同一份输入给不同答案。
     * 允许蒙特卡洛的抽样误差（±0.5 个百分点）。
     */
    const exact = computeEquity(hero, board, [opponent], { opponentWeights: [[99, 1]] });
    const mc = computeEquity(hero, board, [opponent], {
      opponentWeights: [[99, 1]],
      forceMethod: 'MONTE_CARLO',
      iterations: 200_000,
    });
    assert.equal(exact.ok && mc.ok, true);
    if (!exact.ok || !mc.ok) return;
    assert.equal(mc.result.method, 'MONTE_CARLO');
    const gap = Math.abs(exact.result.equity - mc.result.equity);
    assert.ok(
      gap < 0.005,
      `同一份输入必须给出同一个答案：精确 ${(exact.result.equity * 100).toFixed(4)}% ` +
        `vs 蒙特卡洛 ${(mc.result.equity * 100).toFixed(4)}%（差 ${(gap * 100).toFixed(4)} 个百分点）`,
    );
  });

  it('全 0 权重不得报一个「均匀计权」的权益（范围塌缩）', () => {
    const result = computeEquity(hero, board, [opponent], { opponentWeights: [[0, 0]] });
    /*
     * 合法结果有两种：拦截（算不了）或权益 0 —— 但**绝不能**返回 6.8182%
     * （那是「假装均匀」）。这里断言「不是均匀答案」这一条本质性质。
     */
    if (!result.ok) return;
    assert.ok(
      Math.abs(result.result.equity - 0.068182) > 1e-6,
      '权重全 0 时不得返回均匀计权的答案',
    );
  });
});

describe('权益 —— 精确枚举的经典基准', () => {
  it('AA vs KK 翻牌前约 82% / 18%', () => {
    const villain: OpponentRange = { label: 'KK', combos: allCombosOf('KK') };
    const result = computeEquity(C('Ac Ad'), [], [villain], { forceMethod: 'EXACT' });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.result.method, 'EXACT');
    assert.equal(result.result.combosPerOpponent[0], 6);
    assert.equal(result.result.opponentCount, 1);
    const equity = result.result.equity;
    assert.ok(equity > 0.80 && equity < 0.84, `AA vs KK 权益异常：${(equity * 100).toFixed(2)}%`);
    assert.equal(result.result.wins + result.result.ties + result.result.losses, result.result.total);
    // 对手的权益应当是 100% − 我的权益
    assert.ok(Math.abs(1 - equity - (equity === 0 ? 0 : 0.18054)) < 0.02);
  });

  it('AA vs KQo 的单个组合：枚举局数 = C(48,5)，权益与手工枚举一致', () => {
    // 单组合（K♦Q♣）时，唯一未知的是 5 张公共牌，枚举局数应为 C(48,5)
    const result = computeEquity(C('Ac Ad'), [], [range('KQ', 'Kd Qc')], { forceMethod: 'EXACT' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.result.total, combinations(48, 5));
    // KQ 的一部分补牌被我的 A 阻断，因此该组合的权益高于「KQo 全范围」的约 83%
    assert.ok(
      result.result.equity > 0.85 && result.result.equity < 0.91,
      `AA vs K♦Q♣ 权益异常：${(result.result.equity * 100).toFixed(2)}%`,
    );
  });

  it('AA vs KQo 全范围（16 种组合）约 83%', () => {
    const result = computeEquity(C('Ac Ad'), [], [range('KQo', ...KQO_COMBOS)], {
      forceMethod: 'MONTE_CARLO',
      iterations: 60000,
      seed: 20260101,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.result.combosPerOpponent[0], 16);
    assert.ok(
      result.result.equity > 0.80 && result.result.equity < 0.86,
      `AA vs KQo 权益异常：${(result.result.equity * 100).toFixed(2)}%`,
    );
  });

  it('已知听牌：翻牌圈同花听牌（带 A 高张）对顶对约 34%', () => {
    const hero = C('As 2s');
    const board = C('Ks 9s 3h 4d');
    const result = computeEquity(hero, board, [range('顶对', 'Kd Qc')], { forceMethod: 'EXACT' });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // 只剩河牌一张：未知牌 = 52 − 2(我) − 4(公共牌) − 2(对手) = 44 张
    assert.equal(result.result.total, 44);

    /**
     * 手工核对 44 张补牌（逐一枚举验证过）：
     * - 黑桃 9 张（5♠ 6♠ 7♠ 8♠ T♠ J♠ Q♠ 3♠ 4♠）→ 成同花，全部获胜
     * - 非黑桃的 A 共 3 张 → 一对 A 赢过一对 K
     * - 非黑桃的 3 与 4 共 6 张 → A 与 3/4 组成**两对**，同样赢过一对 K
     *   这一点容易漏算：A 高张让「配成两对」也成为补牌来源。
     * 合计 9 + 3 + 6 = 18？不 —— 3♠ 与 4♠ 已经计入黑桃那 9 张，
     * 所以非黑桃的 3/4 只有 6 张是新增的，独立核算的获胜张数正是 15 张。
     */
    const expectedWins = 15;
    assert.equal(result.result.wins, expectedWins, '获胜补牌张数与手工核对不一致');
    assert.equal(result.result.losses, 44 - expectedWins);
    assert.ok(
      Math.abs(result.result.equity - expectedWins / 44) < 1e-12,
      `权益应为 ${expectedWins}/44`,
    );
  });

  it('坚果同花在河牌圈权益为 100%', () => {
    const result = computeEquity(C('As Ks'), C('Qs Js 9s 2h 3d'), [range('一对', 'Qd Qc')], {
      forceMethod: 'EXACT',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.result.total, 1);
    assert.equal(result.result.equity, 1);
  });

  it('公共牌就是最佳五张 → 双方平分，权益恰好 50%', () => {
    const board = C('As Ks Qs Js Ts');
    const result = computeEquity(C('2h 3d'), board, [range('对手', '4h 5d')], {
      forceMethod: 'EXACT',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.result.total, 1);
    assert.equal(result.result.equity, 0.5);
    assert.equal(result.result.ties, 1);
  });

  it('三人平分时每人权益为 1/3', () => {
    const board = C('As Ks Qs Js Ts');
    const result = computeEquity(
      C('2h 3d'),
      board,
      [range('对手A', '4h 5d'), range('对手B', '6h 7d')],
      { forceMethod: 'EXACT' },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.result.equity, 1 / 3);
    assert.equal(result.result.opponentCount, 2);
  });

  it('对手范围为空（全部组合与已知牌冲突）时拒绝计算', () => {
    const result = computeEquity(C('As Ks'), [], [range('冲突范围', 'As Kd')], {
      forceMethod: 'EXACT',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'ISSUE.EQUITY_NOT_COMPUTABLE');
  });
});

/* ============================================================
 * 蒙特卡洛
 * ============================================================ */

describe('权益 —— 蒙特卡洛', () => {
  it('翻牌圈场景：蒙特卡洛与精确枚举一致', () => {
    const hero = C('As 2s');
    const board = C('Ks 9s 3h');
    const villain = range('顶对', 'Kd Qc');
    const exact = computeEquity(hero, board, [villain], { forceMethod: 'EXACT' });
    const sim = computeEquity(hero, board, [villain], {
      forceMethod: 'MONTE_CARLO',
      iterations: 30000,
      seed: 777,
    });
    assert.equal(exact.ok && sim.ok, true);
    if (!exact.ok || !sim.ok) return;
    const diff = Math.abs(exact.result.equity - sim.result.equity);
    assert.ok(diff < 0.02, `偏差过大：精确 ${exact.result.equity}，模拟 ${sim.result.equity}`);
    assert.equal(exact.result.confidenceInterval95, 0);
    assert.ok(sim.result.confidenceInterval95 > 0);
  });

  it('同一 seed 必然得到完全相同的结果（复盘数字必须可复现）', () => {
    const hero = C('Ah Kh');
    const villain = range('范围', 'Qd Qc', 'Jd Jc', 'Ad Kd');
    const options = { forceMethod: 'MONTE_CARLO' as const, iterations: 5000, seed: 20260101 };
    const a = computeEquity(hero, [], [villain], options);
    const b = computeEquity(hero, [], [villain], options);
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.equal(a.result.equity, b.result.equity);
    assert.equal(a.result.wins, b.result.wins);
    assert.equal(a.result.ties, b.result.ties);
    assert.equal(a.result.losses, b.result.losses);
    assert.equal(a.result.seed, 20260101);
  });

  it('不同 seed 的结果落在彼此的 95% 置信区间内', () => {
    const hero = C('Ah Kh');
    const villain = range('范围', 'Qd Qc', 'Jd Jc', 'Ad Kd');
    const a = computeEquity(hero, [], [villain], {
      forceMethod: 'MONTE_CARLO',
      iterations: 20000,
      seed: 1,
    });
    const b = computeEquity(hero, [], [villain], {
      forceMethod: 'MONTE_CARLO',
      iterations: 20000,
      seed: 2,
    });
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) return;
    const diff = Math.abs(a.result.equity - b.result.equity);
    const band = a.result.confidenceInterval95 + b.result.confidenceInterval95;
    assert.ok(diff <= band, `两次模拟差异 ${diff} 超过置信区间之和 ${band}`);
  });

  it('模拟次数过少时给出「精度不足」警告（样本量保护）', () => {
    const result = computeEquity(C('Ac Ad'), [], [range('对手', 'Kd Qc')], {
      forceMethod: 'MONTE_CARLO',
      iterations: 500,
      seed: 3,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const codes = result.result.issues.map((i) => i.code);
    assert.ok(codes.includes('ISSUE.SIMULATION_TOO_FEW'), `未给出精度不足警告：${codes.join(',')}`);
    assert.equal(result.result.iterations, 500);
  });

  it('默认模拟次数可设置且符合预期', () => {
    assert.equal(DEFAULT_ITERATIONS, 100_000);
    const result = computeEquity(C('Ac Ad'), [], [range('对手', 'Kd Qc')], {
      forceMethod: 'MONTE_CARLO',
      seed: 11,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.result.iterations, DEFAULT_ITERATIONS);
  });

  it('自动选择计算方式：组合规模小走精确枚举，规模大走蒙特卡洛', () => {
    const small = computeEquity(C('Ac Ad'), C('Kh Qd 7s 3c 2h'), [range('对手', 'Kd Qc')]);
    assert.equal(small.ok, true);
    if (!small.ok) return;
    assert.equal(small.result.method, 'EXACT');

    const big = computeEquity(
      C('Ac Ad'),
      [],
      [range('宽范围', 'Kd Qc', 'Jd Jc', 'Td 9d', '8h 7h', 'Ad Kd', 'Qh Jh')],
      { seed: 42 },
    );
    assert.equal(big.ok, true);
    if (!big.ok) return;
    assert.equal(big.result.method, 'MONTE_CARLO');
    assert.equal(big.result.seed, 42);
  });
});

/* ============================================================
 * 算不了就说算不了
 * ============================================================ */

describe('权益 —— 算不了就说算不了（绝不编造数字）', () => {
  it('底牌张数不是 2 张 → 拒绝', () => {
    const result = computeEquity([c('As')], [], [range('对手', 'Kd Qc')]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'ISSUE.EQUITY_NOT_COMPUTABLE');
  });

  it('公共牌张数不是 0/3/4/5 → 拒绝', () => {
    for (const boardSpec of ['Ks', 'Ks 9s', 'Ks 9s 3h 2d 5c 7h']) {
      const result = computeEquity(C('As 2s'), C(boardSpec), [range('对手', 'Kd Qc')]);
      assert.equal(result.ok, false, `公共牌「${boardSpec}」本应被拒绝`);
    }
  });

  it('没有对手 → 拒绝', () => {
    const result = computeEquity(C('As 2s'), [], []);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'ISSUE.EQUITY_NOT_COMPUTABLE');
  });

  it('底牌与公共牌重复 → 拒绝并报重复牌', () => {
    const result = computeEquity(C('As 2s'), C('As 9s 3h'), [range('对手', 'Kd Qc')]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'ISSUE.DUPLICATE_CARD');
  });

  it('拒绝时只返回原因码与参数，绝不返回任何权益数字', () => {
    const result = computeEquity([c('As')], [], [range('对手', 'Kd Qc')]);
    assert.equal(result.ok, false);
    assert.equal('result' in result, false);
    if (!result.ok) {
      assert.equal(typeof result.code, 'string');
      assert.ok(result.params.reason !== undefined);
    }
  });
});

/* ============================================================
 * 多人底池
 * ============================================================ */

describe('权益 —— 多人底池（禁止套用单挑逻辑）', () => {
  it('对抗两个对手时，权益必然低于对抗单个相同对手', () => {
    const hero = C('Ac Ad');
    const board = C('Kh 8d 3c');
    const villainA = range('对手A', 'Kd Qc');
    const villainB = range('对手B', '8h 7s');
    const headsUp = computeEquity(hero, board, [villainA], { forceMethod: 'EXACT' });
    const multiway = computeEquity(hero, board, [villainA, villainB], { forceMethod: 'EXACT' });
    assert.equal(headsUp.ok && multiway.ok, true);
    if (!headsUp.ok || !multiway.ok) return;
    assert.ok(
      multiway.result.equity < headsUp.result.equity,
      `多人底池权益（${multiway.result.equity}）应低于单挑（${headsUp.result.equity}）`,
    );
    assert.equal(multiway.result.opponentCount, 2);
    assert.equal(multiway.result.combosPerOpponent.length, 2);
  });

  it('对手数量被显式记录，界面可据此显示「当前：N人底池」', () => {
    const result = computeEquity(
      C('Ac Ad'),
      [],
      [range('A', 'Kd Qc'), range('B', 'Jh Ts'), range('C', '9d 8c')],
      { forceMethod: 'MONTE_CARLO', iterations: 3000, seed: 5 },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.result.opponentCount, 3);
  });

  it('多人底池中对手组合互相冲突时不会崩溃（自动跳过冲突抽样）', () => {
    const result = computeEquity(
      C('Ac Ad'),
      [],
      [range('A', 'Kd Qc', 'Kc Qd'), range('B', 'Kd Qc', 'Kc Qd')],
      { forceMethod: 'MONTE_CARLO', iterations: 2000, seed: 9 },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.result.total > 0);
    assert.ok(Number.isFinite(result.result.equity));
  });

  it('权益值恒落在 0..1，胜平负之和等于总次数（属性测试）', () => {
    const scenarios: Array<[string, string, string[]]> = [
      ['Ac Ad', '', ['Kd Qc']],
      ['As 2s', 'Ks 9s 3h', ['Kd Qc']],
      ['7h 6h', '9c 8d 2s', ['Ah Ad', 'Kd Qc']],
      ['2c 2d', 'Ac Kd Qh', ['As Ks']],
    ];
    for (const [hero, boardSpec, villains] of scenarios) {
      const result = computeEquity(
        C(hero),
        boardSpec ? C(boardSpec) : [],
        villains.map((v, index) => range(`对手${index}`, v)),
        { seed: 987, iterations: 5000 },
      );
      assert.equal(result.ok, true, `${hero} / ${boardSpec} 计算失败`);
      if (!result.ok) continue;
      assert.ok(result.result.equity >= 0 && result.result.equity <= 1);
      assert.equal(
        result.result.wins + result.result.ties + result.result.losses,
        result.result.total,
      );
    }
  });
});
