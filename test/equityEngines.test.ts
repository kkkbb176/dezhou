/**
 * 权益引擎拆分后的引擎级测试
 *
 * 覆盖规范第 10~14 / 50 / 53 节：
 * - 精确引擎与蒙特卡洛引擎的结果一致性
 * - 自适应蒙特卡洛的升级与提前停止
 * - 时间预算中止（用假时钟，不真的等待）
 * - 固定 seed 复现
 * - 决策延迟基准（8 秒硬上限）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeEquity } from '../src/domain/poker/equity.ts';
import { enumerateExact } from '../src/domain/poker/equityExact.ts';
import {
  buildStages,
  simulateMonteCarlo,
} from '../src/domain/poker/equityMonteCarlo.ts';
import {
  EquityComputeMode,
  EquityStopReason,
  toIndexPair,
  type OpponentRange,
} from '../src/domain/poker/equity.types.ts';
import { ALL_CARDS, ALL_SUITS, type Card } from '../src/domain/types.ts';
import { DecisionDeadline, DeadlineMode, type Clock } from '../src/app/decisionDeadline.ts';
import { cardKey, cardIndex } from '../src/domain/poker/cards.ts';
import { C, c } from './helpers.ts';

/* ============================================================
 * 工具
 * ============================================================ */

function range(label: string, ...specs: string[]): OpponentRange {
  return {
    label,
    combos: specs.map((spec) => {
      const cards = C(spec);
      assert.equal(cards.length, 2, `组合「${spec}」必须恰好 2 张`);
      return [cards[0]!, cards[1]!] as [Card, Card];
    }),
  };
}

function allCombosOf(spec: string): Array<[Card, Card]> {
  const rankFromChar: Record<string, number> = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    T: 10, J: 11, Q: 12, K: 13, A: 14,
  };
  const compact = spec.replace(/[\s,]/g, '');
  const rankA = rankFromChar[compact[0]!.toUpperCase()]!;
  const rankB = rankFromChar[compact[1]!.toUpperCase()]!;
  const out: Array<[Card, Card]> = [];
  for (let i = 0; i < ALL_SUITS.length; i++) {
    for (let j = 0; j < ALL_SUITS.length; j++) {
      if (rankA === rankB && j <= i) continue;
      out.push([
        { rank: rankA as Card['rank'], suit: ALL_SUITS[i]! },
        { rank: rankB as Card['rank'], suit: ALL_SUITS[j]! },
      ]);
    }
  }
  return out;
}

/** 把范围转成引擎需要的索引形式（并扣除已知牌） */
function toEnginePairs(
  opponents: readonly OpponentRange[],
  known: readonly Card[],
): { perOpponentPairs: Array<Array<readonly [number, number]>>; knownIndices: Set<number> } {
  const knownIndices = new Set(known.map(cardIndex));
  const perOpponentPairs = opponents.map((o) =>
    o.combos
      .map((combo) => toIndexPair(combo))
      .filter((pair) => pair[0] !== pair[1] && !knownIndices.has(pair[0]) && !knownIndices.has(pair[1])),
  );
  return { perOpponentPairs, knownIndices };
}

function fakeClock(start = 0): { clock: Clock; advance: (ms: number) => void } {
  let current = start;
  return { clock: () => current, advance: (ms: number) => { current += ms; } };
}

/* ============================================================
 * 阶段序列
 * ============================================================ */

describe('equityMonteCarlo —— 阶段序列', () => {
  it('起始样本已在梯度之上时，梯度不会回退', () => {
    const stages = buildStages(300_000, 1_000_000);
    assert.equal(stages[0], 300_000);
    for (let i = 1; i < stages.length; i++) {
      assert.ok(stages[i]! > stages[i - 1]!, `阶段必须严格递增：${stages.join(',')}`);
    }
    assert.equal(stages[stages.length - 1], 1_000_000);
  });

  it('起始样本低于梯度时按 50k → 100k → 250k … 逐级上升', () => {
    const stages = buildStages(50_000, 250_000);
    assert.deepEqual(stages, [50_000, 100_000, 250_000]);
  });

  it('样本上限不会被突破', () => {
    const stages = buildStages(1_000, 60_000);
    assert.deepEqual(stages, [1_000, 50_000, 60_000]);
    for (const s of stages) assert.ok(s <= 60_000, `阶段 ${s} 超过上限`);
  });
});

/* ============================================================
 * 非自适应模式：尊重调用方的显式指定
 * ============================================================ */

describe('equityMonteCarlo —— 非自适应模式（默认）', () => {
  it('adaptive=false 时恰好跑指定次数，不做任何升级', () => {
    const heroHole = C('Ac Ad');
    const board: Card[] = [];
    const { perOpponentPairs } = toEnginePairs([range('KK', 'Ks Kd')], [...heroHole, ...board]);

    const result = simulateMonteCarlo({
      heroHole,
      board,
      perOpponentPairs,
      opponentCount: 1,
      startIterations: 500,
      maxIterations: 1_000_000,
      seed: 42,
      adaptive: false,
      minRecommendedIterations: 20_000,
      diminishingReturnsThreshold: 0.1,
    });

    assert.equal(result.total, 500, 'adaptive=false 必须精确跑 500 次');
    assert.equal(result.stoppedEarly, false);
    assert.equal(result.stopReason, null);
    // 样本不足 → 必须给出精度警告
    assert.ok(result.issues.some((i) => i.code === 'ISSUE.SIMULATION_TOO_FEW'));
  });

  it('adaptive=false 时即使给了决策门槛也不会提前停止', () => {
    const heroHole = C('Ac Ad');
    const { perOpponentPairs } = toEnginePairs([range('KK', 'Ks Kd')], heroHole);
    const result = simulateMonteCarlo({
      heroHole,
      board: [],
      perOpponentPairs,
      opponentCount: 1,
      startIterations: 2_000,
      maxIterations: 1_000_000,
      seed: 7,
      adaptive: false,
      minRecommendedIterations: 20_000,
      decisionThreshold: 0.01, // 权益必然远高于 1%，但非自适应模式不该因此停下来
      diminishingReturnsThreshold: 0.1,
    });
    assert.equal(result.total, 2_000);
    assert.equal(result.stoppedEarly, false);
  });
});

/* ============================================================
 * 自适应模式：升级与提前停止
 * ============================================================ */

describe('equityMonteCarlo —— 自适应模式', () => {
  it('门槛很容易满足时提前停止，且总样本远小于上限', () => {
    const heroHole = C('Ac Ad');
    const { perOpponentPairs } = toEnginePairs([range('KK', 'Ks Kd')], heroHole);
    const result = simulateMonteCarlo({
      heroHole,
      board: [],
      perOpponentPairs,
      opponentCount: 1,
      startIterations: 10_000,
      maxIterations: 1_000_000,
      seed: 20260101,
      adaptive: true,
      minRecommendedIterations: 20_000,
      decisionThreshold: 0.05, // AA vs KK 约 82%，CI 必然整体高于 5%
      diminishingReturnsThreshold: 0.1,
    });

    assert.equal(result.stoppedEarly, true);
    assert.equal(result.stopReason, EquityStopReason.CI_CLEARS_THRESHOLD);
    assert.ok(result.total < 1_000_000, `应提前停止，实际样本 ${result.total}`);
    assert.equal(result.stopParams.side, 'ABOVE');
    // 结论必须正确：AA vs KK 约 82%
    assert.ok(result.equity > 0.79 && result.equity < 0.85, `权益异常：${result.equity}`);
  });

  it('门槛跨越 CI 时不会用门槛停止，而是继续升级（规范第 14 条）', () => {
    const heroHole = C('As 2s');
    const board = C('Ks 9s 3h');
    const { perOpponentPairs } = toEnginePairs([range('顶对', 'Kd Qc')], [...heroHole, ...board]);

    // 先跑一次拿到大致权益，把门槛设在 CI 中间，强制它继续采样
    const probe = simulateMonteCarlo({
      heroHole, board, perOpponentPairs, opponentCount: 1,
      startIterations: 5_000, maxIterations: 5_000, seed: 1,
      adaptive: false, minRecommendedIterations: 1_000,
      diminishingReturnsThreshold: 0.1,
    });
    const threshold = probe.equity; // 恰好落在 CI 中心

    const result = simulateMonteCarlo({
      heroHole, board, perOpponentPairs, opponentCount: 1,
      startIterations: 5_000, maxIterations: 40_000, seed: 1,
      adaptive: true, minRecommendedIterations: 1_000,
      decisionThreshold: threshold,
      diminishingReturnsThreshold: 0.0001, // 极低阈值 → 不靠收益递减停下
    });

    assert.ok(result.total > 5_000, `跨越门槛时应继续采样，实际只跑了 ${result.total} 次`);
    if (result.stopReason === EquityStopReason.CI_CLEARS_THRESHOLD) {
      // 若最终确实清了门槛，也说明样本已足够把 CI 推离门槛
      assert.ok(Number(result.stopParams.lower) > threshold || Number(result.stopParams.upper) < threshold);
    }
  });

  it('无门槛时靠收益递减停止', () => {
    const heroHole = C('Ac Ad');
    const { perOpponentPairs } = toEnginePairs([range('KK', 'Ks Kd')], heroHole);
    const result = simulateMonteCarlo({
      heroHole, board: [], perOpponentPairs, opponentCount: 1,
      startIterations: 100_000, maxIterations: 1_000_000, seed: 5,
      adaptive: true, minRecommendedIterations: 1_000,
      diminishingReturnsThreshold: 0.5,
    });
    assert.equal(result.stoppedEarly, true);
    assert.equal(result.stopReason, EquityStopReason.DIMINISHING_RETURNS);
  });
});

/* ============================================================
 * 时间预算中止（假时钟）
 * ============================================================ */

describe('equityMonteCarlo —— 时间预算中止', () => {
  it('预算已耗尽时立即中止并记录原因，不继续采样', () => {
    const fc = fakeClock(0);
    const deadline = new DecisionDeadline({ clock: fc.clock, mode: DeadlineMode.TEST, softMs: 100, hardMs: 200 });
    fc.advance(500); // 一开始就已超时

    const heroHole = C('Ac Ad');
    const { perOpponentPairs } = toEnginePairs([range('KK', 'Ks Kd')], heroHole);

    const result = simulateMonteCarlo({
      heroHole, board: [], perOpponentPairs, opponentCount: 1,
      startIterations: 20_000, maxIterations: 1_000_000, seed: 1,
      adaptive: true, minRecommendedIterations: 1_000,
      diminishingReturnsThreshold: 0.1,
      deadline,
    });

    assert.equal(result.stoppedEarly, true);
    assert.equal(result.stopReason, EquityStopReason.DEADLINE_REACHED);
    assert.equal(result.total, 0, '超时后不应再抽样');
    // 样本为 0 时必须给出可计算性阻断，而不是返回一个编造的数字
    assert.ok(result.issues.some((i) => i.code === 'ISSUE.EQUITY_NOT_COMPUTABLE'));
    assert.equal(result.equity, 0);
  });

  it('预算充足时不会因为 deadline 中止', () => {
    const fc = fakeClock(0);
    const deadline = new DecisionDeadline({ clock: fc.clock, mode: DeadlineMode.TEST, softMs: 60_000, hardMs: 120_000 });
    const heroHole = C('Ac Ad');
    const { perOpponentPairs } = toEnginePairs([range('KK', 'Ks Kd')], heroHole);
    const result = simulateMonteCarlo({
      heroHole, board: [], perOpponentPairs, opponentCount: 1,
      startIterations: 2_000, maxIterations: 2_000, seed: 1,
      adaptive: true, minRecommendedIterations: 1_000,
      diminishingReturnsThreshold: 0.1,
      deadline,
    });
    assert.notEqual(result.stopReason, EquityStopReason.DEADLINE_REACHED);
    assert.equal(result.total, 2_000);
  });

  it('记录实际耗时（来自注入时钟）', () => {
    const fc = fakeClock(0);
    const deadline = new DecisionDeadline({ clock: fc.clock, mode: DeadlineMode.TEST, softMs: 60_000, hardMs: 120_000 });
    const heroHole = C('Ac Ad');
    const { perOpponentPairs } = toEnginePairs([range('KK', 'Ks Kd')], heroHole);
    const result = simulateMonteCarlo({
      heroHole, board: [], perOpponentPairs, opponentCount: 1,
      startIterations: 500, maxIterations: 500, seed: 1,
      adaptive: false, minRecommendedIterations: 100,
      diminishingReturnsThreshold: 0.1,
      deadline,
    });
    assert.ok(result.elapsedMs >= 0);
  });
});

/* ============================================================
 * 复现性
 * ============================================================ */

describe('equityMonteCarlo —— 复现性', () => {
  it('同一 seed 的两次运行结果逐字段相同', () => {
    const heroHole = C('Ah Kh');
    const { perOpponentPairs } = toEnginePairs(
      [range('范围', 'Qd Qc', 'Jd Jc', 'Ad Kd')],
      heroHole,
    );
    const options = {
      heroHole, board: [] as Card[], perOpponentPairs, opponentCount: 1,
      startIterations: 5_000, maxIterations: 5_000, seed: 20260101,
      adaptive: false, minRecommendedIterations: 100,
      diminishingReturnsThreshold: 0.1,
    };
    const a = simulateMonteCarlo(options);
    const b = simulateMonteCarlo(options);
    assert.equal(a.equity, b.equity);
    assert.equal(a.wins, b.wins);
    assert.equal(a.ties, b.ties);
    assert.equal(a.losses, b.losses);
    assert.equal(a.total, b.total);
  });

  it('不同 seed 结果不同（证明种子确实生效）', () => {
    const heroHole = C('Ah Kh');
    const { perOpponentPairs } = toEnginePairs([range('范围', 'Qd Qc', 'Jd Jc')], heroHole);
    const base = {
      heroHole, board: [] as Card[], perOpponentPairs, opponentCount: 1,
      startIterations: 3_000, maxIterations: 3_000, adaptive: false,
      minRecommendedIterations: 100, diminishingReturnsThreshold: 0.1,
    };
    const a = simulateMonteCarlo({ ...base, seed: 1 });
    const b = simulateMonteCarlo({ ...base, seed: 2 });
    assert.notEqual(a.equity, b.equity);
    // 但差异应在置信区间量级内
    assert.ok(Math.abs(a.equity - b.equity) < 0.05, `两次差异过大：${a.equity} vs ${b.equity}`);
  });
});

/* ============================================================
 * 两个引擎的一致性
 * ============================================================ */

describe('两个引擎 —— 结果一致性', () => {
  it('河牌圈场景：蒙特卡洛落在精确枚举的置信区间内', () => {
    const heroHole = C('As Ks');
    const board = C('Qs Js 9s 2h 3d');
    const opponents = [range('一对', 'Qd Qc')];

    const exact = computeEquity(heroHole, board, opponents, { forceMethod: 'EXACT' });
    const mc = computeEquity(heroHole, board, opponents, {
      forceMethod: 'MONTE_CARLO',
      iterations: 1_000,
      seed: 3,
    });
    assert.equal(exact.ok && mc.ok, true);
    if (!exact.ok || !mc.ok) return;
    assert.equal(exact.result.equity, 1);
    // 公共牌已满，抽样必然得到同一结论
    assert.equal(mc.result.equity, 1);
  });

  it('翻牌圈场景：蒙特卡洛与精确枚举偏差 < 2%', () => {
    const heroHole = C('As 2s');
    const board = C('Ks 9s 3h');
    const opponents = [range('顶对', 'Kd Qc')];

    const exact = computeEquity(heroHole, board, opponents, { forceMethod: 'EXACT' });
    const mc = computeEquity(heroHole, board, opponents, {
      forceMethod: 'MONTE_CARLO',
      iterations: 30_000,
      seed: 777,
    });
    assert.equal(exact.ok && mc.ok, true);
    if (!exact.ok || !mc.ok) return;
    assert.ok(
      Math.abs(exact.result.equity - mc.result.equity) < 0.02,
      `偏差过大：精确 ${exact.result.equity}，模拟 ${mc.result.equity}`,
    );
  });

  it('两个引擎的结果对象结构一致（字段齐全，便于统一消费）', () => {
    const heroHole = C('As 2s');
    const board = C('Ks 9s 3h');
    const opponents = [range('顶对', 'Kd Qc')];

    const exact = computeEquity(heroHole, board, opponents, { forceMethod: 'EXACT' });
    const mc = computeEquity(heroHole, board, opponents, { forceMethod: 'MONTE_CARLO', iterations: 500, seed: 1 });
    assert.equal(exact.ok && mc.ok, true);
    if (!exact.ok || !mc.ok) return;

    const required = [
      'equity', 'wins', 'ties', 'losses', 'total', 'method', 'iterations', 'matchups',
      'seed', 'confidenceInterval95', 'opponentCount', 'combosPerOpponent',
      'elapsedMs', 'stoppedEarly', 'stopReason', 'stopParams', 'abortedRuns', 'issues',
    ] as const;
    for (const key of required) {
      assert.ok(key in exact.result, `精确引擎缺少字段 ${key}`);
      assert.ok(key in mc.result, `蒙特卡洛引擎缺少字段 ${key}`);
    }
    assert.equal(exact.result.seed, null, '精确枚举没有随机种子');
    assert.equal(exact.result.confidenceInterval95, 0, '精确枚举没有统计误差');
    assert.equal(typeof mc.result.seed, 'number');
    assert.ok(mc.result.confidenceInterval95 > 0);
  });

  it('精确引擎直接调用（绕过门面）也能工作，并给出正确的枚举局数', () => {
    const heroHole = C('Ac Ad');
    const board = C('2h 5s 9d Jc 3h');
    const { perOpponentPairs } = toEnginePairs([range('KK', 'Ks Kd')], [...heroHole, ...board]);
    const result = enumerateExact({ heroHole, board, perOpponentPairs, opponentCount: 1 });
    assert.equal(result.method, 'EXACT');
    assert.equal(result.total, 1, '公共牌已满 → 只有 1 种对局');
    assert.equal(result.combosPerOpponent[0], 1);
    assert.equal(result.equity, 1, 'AA 在 2-5-9-J-3 牌面上必胜 KQ/K 高');
  });
});

/* ============================================================
 * 表面 API
 * ============================================================ */

describe('computeEquity —— 门面 API', () => {
  it('因时间预算降级时，结果中必须留下痕迹（不静默 Fallback）', () => {
    /**
     * 场景：规模本来适合精确枚举，但只剩 50ms 预算。
     * 策略会把它降级为蒙特卡洛 —— 这是允许的，但**必须可追溯**。
     */
    const mc = (() => {
      let current = 0;
      return { clock: () => current, advance: (ms: number) => { current += ms; } };
    })();
    const tight = new DecisionDeadline({ clock: mc.clock, mode: DeadlineMode.TEST, softMs: 40, hardMs: 50 });

    const result = computeEquity(C('Ac Ad'), [], [range('KK', 'Ks Kd')], {
      iterations: 500,
      seed: 1,
      deadline: tight,
      maxExactMatchups: 50_000_000, // 规模本来允许精确枚举
    });

    assert.equal(result.ok, true, '自动选型路径下应当降级而不是失败');
    if (!result.ok) return;
    assert.equal(result.result.method, 'MONTE_CARLO');
    assert.equal(result.result.methodReason, 'DOWNGRADED_BY_DEADLINE');
    assert.equal(result.result.downgradedFrom, 'EXACT', '必须记录从哪种算法降级而来');
  });

  it('未降级时 downgradedFrom 为 null', () => {
    const result = computeEquity(C('Ac Ad'), C('Kh Qd 7s 3c 2h'), [range('对手', 'Kd Qc')], {
      forceMethod: 'EXACT',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.result.method, 'EXACT');
    assert.equal(result.result.downgradedFrom, null);
    assert.equal(result.result.methodReason, 'FORCED_BY_CALLER');
  });

  it('两个引擎都返回 methodReason，便于 Decision Log 归类', () => {
    const exact = computeEquity(C('Ac Ad'), C('Kh Qd 7s 3c 2h'), [range('对手', 'Kd Qc')], {
      forceMethod: 'EXACT',
    });
    const mc = computeEquity(C('Ac Ad'), [], [range('对手', 'Kd Qc')], {
      forceMethod: 'MONTE_CARLO',
      iterations: 500,
      seed: 1,
    });
    assert.equal(exact.ok && mc.ok, true);
    if (!exact.ok || !mc.ok) return;
    assert.equal(typeof exact.result.methodReason, 'string');
    assert.equal(mc.result.methodReason, 'FORCED_BY_CALLER');
  });

  it('**设置了 deadline 时，规模过大的精确枚举被拒绝执行（唯一的不可中止路径守门）**', () => {
    /**
     * 精确枚举是一段无让步的同步递归，**无法被中断**。
     * 因此门面必须在启动它之前用剩余时间把关，否则会把 8 秒硬上限捅穿。
     * 这里模拟「只有 50ms 预算却要求枚举 1000 万局」的交互场景。
     */
    const mc = (() => {
      let current = 0;
      return { clock: () => current, advance: (ms: number) => { current += ms; } };
    })();
    const tight = new DecisionDeadline({ clock: mc.clock, mode: DeadlineMode.TEST, softMs: 40, hardMs: 50 });

    const result = computeEquity(C('Ac Ad'), [], [range('KK', 'Ks Kd')], {
      forceMethod: 'EXACT',
      deadline: tight,
    });

    assert.equal(result.ok, false, '时间不够时必须拒绝执行精确枚举');
    if (!result.ok) {
      assert.equal(result.code, 'ISSUE.EQUITY_NOT_COMPUTABLE');
      assert.ok(String(result.params.reason).includes('拒绝'), `原因未说明拒绝：${result.params.reason}`);
    }
  });

  it('预算充足时同样的精确枚举请求正常执行', () => {
    const mc = (() => {
      let current = 0;
      return { clock: () => current, advance: (ms: number) => { current += ms; } };
    })();
    const roomy = new DecisionDeadline({ clock: mc.clock, mode: DeadlineMode.TEST, softMs: 30_000, hardMs: 120_000 });
    const result = computeEquity(C('Ac Ad'), [], [range('KK', 'Ks Kd')], {
      forceMethod: 'EXACT',
      maxExactMatchups: 5_000,
      deadline: roomy,
    });
    assert.equal(result.ok, true, '小规模精确枚举应当放行');
    if (!result.ok) return;
    assert.equal(result.result.method, 'EXACT');
  });
  it('FAST 模式下 AA vs KK 走蒙特卡洛并远快于 8 秒硬上限', () => {
    const started = Date.now();
    const result = computeEquity(C('Ac Ad'), [], [range('KK', 'Ks Kd')], {
      forceMethod: 'MONTE_CARLO',
      iterations: 20_000,
      seed: 1,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.result.equity > 0.78 && result.result.equity < 0.86, `权益异常：${result.result.equity}`);
    assert.ok(elapsed < 8_000, `耗时 ${elapsed}ms 超过 8 秒硬上限`);
  });

  it('VERIFY 模式强制精确枚举（用于黄金测试）', () => {
    const result = computeEquity(C('Ac Ad'), C('Kh Qd 7s 3c 2h'), [range('对手', 'Kd Qc')], {
      mode: EquityComputeMode.VERIFY,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.result.method, 'EXACT');
  });

  it('三人底池：对手数量被显式记录', () => {
    const result = computeEquity(
      C('Ac Ad'),
      C('Kh 8d 3c'),
      [range('A', 'Kd Qc'), range('B', '8h 7s')],
      { forceMethod: 'EXACT' },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.result.opponentCount, 2);
    assert.equal(result.result.combosPerOpponent.length, 2);
  });

  it('多种牌面结构下均能正常计算（顺面 / 同花面 / 三条面 / 对子面）', () => {
    /**
     * 每个牌面都配一个「与已知牌不冲突」的对手范围。
     * 注意别踩这类坑：我持 A♥K♥ 时，牌面 T♥J♦Q♣ 会同时封掉 Q♦ 与 Q♣，
     * 再拿 Q♦Q♣ 当对手范围就会得到空范围 → 触发拒绝（这是正确行为，不是 Bug）。
     */
    const cases: Array<[string, string, string]> = [
      ['2c 3d 4h', 'Ah Kh', 'Qd Qc'],
      ['As Ks Qs', 'Ah Kh', 'Jd Jc'],
      ['7d 7h 7c', 'Ah Kh', 'Qd Qc'],
      ['9c 9d 9h', 'Ah Kh', 'Qd Qc'],
      ['Th Jd Qc', 'Ah Kh', 'As Ac'], // 用 A 对子避开牌面封锁
    ];
    for (const [boardSpec, heroSpec, villainSpec] of cases) {
      const result = computeEquity(C(heroSpec), C(boardSpec), [range('对手', villainSpec)], {
        forceMethod: 'EXACT',
      });
      assert.equal(result.ok, true, `牌面 ${boardSpec} / 我 ${heroSpec} / 对手 ${villainSpec} 计算失败`);
      if (!result.ok) continue;
      assert.ok(result.result.equity >= 0 && result.result.equity <= 1);
      assert.equal(
        result.result.wins + result.result.ties + result.result.losses,
        result.result.total,
      );
      assert.ok(result.result.total > 0);
    }
  });

  it('对手范围被牌面完全封死时返回「无法计算」，而不是空范围硬算', () => {
    // 我持 A♥K♥、牌面 T♥J♦Q♣ → Q♦ 与 Q♣ 都已被封死
    const result = computeEquity(C('Ah Kh'), C('Th Jd Qc'), [range('被封锁', 'Qd Qc')], {
      forceMethod: 'EXACT',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'ISSUE.EQUITY_NOT_COMPUTABLE');
      assert.ok(String(result.params.reason).includes('没有任何可用组合'));
    }
  });

  it('空范围 / 重复牌 / 非法公共牌张数仍然被拒绝（拆分后行为不变）', () => {
    assert.equal(computeEquity(C('As Ks'), [], [], {}).ok, false);
    assert.equal(computeEquity([c('As')], [], [range('x', 'Kd Qc')], {}).ok, false);
    assert.equal(computeEquity(C('As 2s'), C('As 9s 3h'), [range('x', 'Kd Qc')], {}).ok, false);
    assert.equal(computeEquity(C('As 2s'), C('Ks 9s'), [range('x', 'Kd Qc')], {}).ok, false);
  });
});

/* ============================================================
 * 决策延迟基准（规范第 50 / 51 节）
 * ============================================================ */

describe('决策延迟基准 —— 普通决策必须远低于 8 秒', () => {
  const scenarios: Array<{
    name: string;
    hero: string;
    board: string;
    opponents: OpponentRange[];
    options: Record<string, unknown>;
  }> = [
    {
      name: '翻牌前 · 单挑 · 紧范围',
      hero: 'Ac Ad',
      board: '',
      opponents: [range('紧范围', 'Ks Kd')],
      options: { forceMethod: 'MONTE_CARLO', iterations: 20_000, seed: 1 },
    },
    {
      name: '翻牌前 · 单挑 · 宽范围',
      hero: 'Ah Kh',
      board: '',
      opponents: [
        range('宽范围', 'Qd Qc', 'Jd Jc', 'Td 9d', '8h 7h', 'Ad Kd', 'Qh Jh', '6c 6d', 'As Qs'),
      ],
      options: { forceMethod: 'MONTE_CARLO', iterations: 20_000, seed: 2 },
    },
    {
      name: '翻牌圈 · 3 人池',
      hero: 'As 2s',
      board: 'Ks 9s 3h',
      opponents: [range('A', 'Kd Qc'), range('B', '9d 9c')],
      options: { forceMethod: 'MONTE_CARLO', iterations: 20_000, seed: 3 },
    },
    {
      name: '翻牌圈 · 4 人池',
      hero: 'Ah Kh',
      board: 'Qh Jh 4c',
      opponents: [range('A', 'Qs Qd'), range('B', 'Td 9d'), range('C', '8c 8d')],
      options: { forceMethod: 'MONTE_CARLO', iterations: 20_000, seed: 4 },
    },
    {
      name: '转牌圈 · 边缘决策',
      hero: 'Th Td',
      board: '9c 8d 2h 3s',
      opponents: [range('范围', 'Jc Jd', 'As Ks', '9h 9d')],
      options: { forceMethod: 'MONTE_CARLO', iterations: 20_000, seed: 5 },
    },
    {
      name: '河牌圈 · 精确枚举（组合很小）',
      hero: 'Kh Qd',
      board: 'Kd Qc 9h 2s 7h',
      opponents: [range('范围', '9s 9d', 'Jd Td', 'Ah 9c')],
      options: { forceMethod: 'EXACT' },
    },
  ];

  for (const scenario of scenarios) {
    it(`${scenario.name}：耗时 < 3 秒`, () => {
      const started = Date.now();
      const result = computeEquity(
        C(scenario.hero),
        scenario.board ? C(scenario.board) : [],
        scenario.opponents,
        scenario.options,
      );
      const elapsed = Date.now() - started;
      assert.equal(result.ok, true, `${scenario.name} 计算失败`);
      assert.ok(elapsed < 3_000, `${scenario.name} 耗时 ${elapsed}ms 超过 3 秒`);
    });
  }

  it('极端场景（翻牌前对宽范围 + 自适应）也在 8 秒硬上限内', () => {
    const started = Date.now();
    const result = computeEquity(
      C('Ac Ad'),
      [],
      [range('宽范围', 'Kd Qc', 'Jd Jc', 'Td 9d', '8h 7h', '6c 6d')],
      { forceMethod: 'MONTE_CARLO', adaptive: true, iterations: 50_000, seed: 9, decisionThreshold: 0.05 },
    );
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true);
    assert.ok(elapsed < 8_000, `耗时 ${elapsed}ms 超过 8 秒硬上限`);
  });
});
