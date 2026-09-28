/**
 * 权益引擎 —— 蒙特卡洛（自适应、可复现、可中止）
 *
 * 职责唯一：**抽样逼近真实权益。**
 * 禁止在本文件加入玩家模型、范围推理、决策逻辑；选型与停止判定在 equityPolicy.ts。
 *
 * 五项硬要求（规范第 10 节）：
 * 1. seed 可注入 → 复盘时同一 seed 必然同一结果
 * 2. 可复现
 * 3. 样本统计（胜 / 平 / 负 / 总次数）
 * 4. 95% 置信区间
 * 5. **运行时间 + 中止能力**（受 DecisionDeadline 约束）
 *
 * 自适应策略（规范第 13 节）：
 *   起始样本 → 逐级翻倍（50k → 100k → 250k → 500k → 1M）
 *   每一级结束都做三重检查：门槛 CI、时间预算、收益递减。
 *   一旦可以定论就立即返回，**绝不为了用满时间而继续算**。
 *
 * 性能要点（都是踩过的坑）：
 * - 冲突判断全部在「0..51 整数索引」上做，不在热路径拼接字符串 key
 * - 整副牌只分配一次，每轮用 swap 把已用牌挤到尾部并收缩长度
 * - 抽样失败（对手组合互相冲突）时计入 abortedRuns，**不污染分母**
 *   （参考项目 luckyone18/Poker 正是在这里出错：用总 sims 作分母，
 *     被跳过的模拟不计入分子，导致权益被系统性低估）
 */

import { ALL_CARDS, type Card } from '../types.ts';
import { IssueCode, IssueSeverity } from '../domainCodes.ts';
import { cardIndex } from './cards.ts';
import { evaluateSeven } from './fastEval.ts';
import { mulberry32, randomInt, type Rng } from '../../infra/rng.ts';
import {
  DEFAULT_CONFIDENCE,
  confidenceHalfWidth,
  evaluateMonteCarloStop,
} from './equityPolicy.ts';
import type { DecisionDeadline } from '../../app/decisionDeadline.ts';
import {
  EquityPolicyReason,
  EquityStopReason,
  type EquityIssue,
  type EquityResult,
  type EquityStopReason as StopReason,
} from './equity.types.ts';

export type MonteCarloInput = {
  heroHole: readonly Card[];
  board: readonly Card[];
  /** 每位对手**已过滤**的组合（整数索引形式） */
  perOpponentPairs: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  /**
   * 每位对手每个组合的**抽样权重**（可选）。
   *
   * ## 为什么需要它（Alpha 端到端接入时的真实缺陷）
   *
   * 修复前抽样是**均匀**的（`randomInt(rng, pairs.length)`），
   * 于是 Range 引擎辛苦做出来的贝叶斯后验**完全不参与权益计算** ——
   * 「对手加注过 → 他的范围偏强」这一信息在最后一步被丢掉，
   * 权益与「随机一手牌」无异。那让整条 Range → Equity 链形同虚设。
   *
   * ## 语义
   *
   * - 省略时**完全等价于**均匀抽样（向后兼容，既有调用方零改动）
   * - 提供时长度必须与 `perOpponentPairs[i]` 一致；
   *   权重不必归一化，内部按累积分布抽样（CDF）
   * - 权重必须有限且 ≥ 0；某位对手总权重为 0 时**抛错**
   *   （静默退化成均匀会把「范围已经空了」伪装成正常结果）
   */
  perOpponentWeights?: ReadonlyArray<ReadonlyArray<number>>;
  opponentCount: number;
  /** 起始样本量 */
  startIterations: number;
  /** 样本上限（自适应逐级翻倍不会超过它） */
  maxIterations: number;
  /** 随机种子 */
  seed: number;
  /**
   * 是否启用自适应采样。
   * false 时**恰好**跑 startIterations 次，不做任何升级（尊重调用方的显式指定）。
   */
  adaptive: boolean;
  /** 低于该样本量时给出「精度不足」警告 */
  minRecommendedIterations: number;
  /** 决策门槛；提供后启用 CI 提前停止 */
  decisionThreshold?: number;
  /** 收益递减阈值（百分点） */
  diminishingReturnsThreshold: number;
  /** 时间预算；未提供则不受时间约束（离线/验证用） */
  deadline?: DecisionDeadline;
};

/** 逐级翻倍用的阶段梯度 */
const STAGE_LADDER: readonly number[] = [50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000, 4_000_000];

/** 生成不小于 startIterations 的阶段序列，末级不超过 maxIterations */
export function buildStages(startIterations: number, maxIterations: number): number[] {
  const stages: number[] = [];
  let target = Math.max(1, Math.floor(startIterations));
  // 先放入起始样本
  stages.push(Math.min(target, maxIterations));
  for (const ladder of STAGE_LADDER) {
    if (ladder <= target) continue;
    if (ladder > maxIterations) break;
    stages.push(ladder);
    target = ladder;
  }
  if (stages[stages.length - 1]! < maxIterations) stages.push(maxIterations);
  return stages;
}

export function simulateMonteCarlo(input: MonteCarloInput): EquityResult {
  const {
    heroHole,
    board,
    perOpponentPairs,
    opponentCount,
    maxIterations,
    seed,
    minRecommendedIterations,
    diminishingReturnsThreshold,
    deadline,
  } = input;

  if (perOpponentPairs.length !== opponentCount) {
    throw new Error(
      `simulateMonteCarlo: opponentCount(${opponentCount}) 与组合数组长度(${perOpponentPairs.length}) 不一致`,
    );
  }

  // ---- 抽样权重的累积分布（CDF）----
  //
  // 省略权重时返回 null，抽样路径与修复前**逐位一致**（保持向后兼容与可复现）。
  const cdfs: (readonly number[] | null)[] = perOpponentPairs.map((pairs, i) => {
    const weights = input.perOpponentWeights?.[i];
    if (weights === undefined) return null;
    if (weights.length !== pairs.length) {
      throw new Error(
        `simulateMonteCarlo: 第 ${i} 位对手的权重数(${weights.length})与组合数(${pairs.length})不一致`,
      );
    }
    const cdf: number[] = [];
    let acc = 0;
    for (const w of weights) {
      if (!Number.isFinite(w) || w < 0) {
        throw new Error(`simulateMonteCarlo: 第 ${i} 位对手出现非法权重（${String(w)}）`);
      }
      acc += w;
      cdf.push(acc);
    }
    if (!(acc > 0)) {
      throw new Error(
        `simulateMonteCarlo: 第 ${i} 位对手的全部权重为 0 —— 范围已空，不得静默退化为均匀抽样`,
      );
    }
    // 归一化到最后一项为 1，便于用 [0,1) 的随机数二分
    for (let k = 0; k < cdf.length; k++) cdf[k] = cdf[k]! / acc;
    return Object.freeze(cdf);
  });

  /** 按 CDF 抽取下标；CDF 为 null 时退化为均匀（与修复前一致） */
  const pickIndex = (rng: () => number, count: number, cdf: readonly number[] | null): number => {
    if (cdf === null) return randomInt(rng, count);
    const target = rng();
    // 二分查找第一个 cdf[k] > target
    let lo = 0;
    let hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid]! > target) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };

  const rng: Rng = mulberry32(seed);
  const cardsToCome = 5 - board.length;
  const heroBuffer: Card[] = [heroHole[0]!, heroHole[1]!, ...board];
  const placeholder: Card = { rank: 2, suit: 's' };
  const opponentBuffers: Card[][] = perOpponentPairs.map(() => [placeholder, placeholder, ...board]);

  const heroAndBoardIndices = new Set<number>();
  for (const card of [...heroHole, ...board]) heroAndBoardIndices.add(cardIndex(card));

  const opponentUsedIndices = new Set<number>();
  const deck: Card[] = ALL_CARDS.slice();
  let deckSize = 0;

  /** 重置牌堆：把已知牌与本轮对手牌挤到尾部并收缩有效长度 */
  const resetDeck = (): void => {
    let write = 0;
    for (let read = 0; read < 52; read++) {
      const card = deck[read]!;
      const index = cardIndex(card);
      const index2 = index;
      void index2;
      if (heroAndBoardIndices.has(index) || opponentUsedIndices.has(index)) continue;
      const target = deck[write]!;
      deck[write] = card;
      deck[read] = target;
      write++;
    }
    deckSize = write;
  };

  let wins = 0;
  let ties = 0;
  let losses = 0;
  let equitySum = 0;
  /** 实际完成的模拟次数（因冲突而放弃的抽样不计入） */
  let completedRuns = 0;
  /** 因对手组合互相冲突而放弃的抽样次数（诚实记录，不参与统计） */
  let abortedRuns = 0;

  const runOneBatch = (batchSize: number): void => {
    for (let run = 0; run < batchSize; run++) {
      // ---- 1) 为每位对手抽取一个互不冲突的组合 ----
      opponentUsedIndices.clear();
      let aborted = false;

      for (let i = 0; i < opponentCount; i++) {
        const pairs = perOpponentPairs[i]!;
        const cdf = cdfs[i]!;
        /*
         * ⚠️ **已知的近似（2026-09 审查 B 记录，未修）**：这是**逐家顺序抽样**
         * ——后一家在自己的范围内抽样时，隐含地以「前一家已占的牌」为条件
         *（因为冲突会被重抽掉），因此实际抽到的联合分布是
         *
         * ```text
         * w1(c1) · w2(c2) / N(c1)        ← 实现
         * w1(c1) · w2(c2)                ← 对称口径（正解）
         * ```
         *
         * 差额是每家的归一化因子。实测影响很小（一手 2.1% 量级的权益上
         * 偏 +0.036 个百分点，相对 +1.7%；对称口径 2.0933% vs 顺序口径 2.1391%），
         * 但它是**系统性偏差**而不是抽样噪声，也不会随迭代数消失。
         *
         * 正解是「每家独立按权重抽、整批冲突则整批重抽」——那会改变所有
         * 现有蒙特卡洛数值（黄金局面/指纹），因此本轮**只记录不修改**。
         */
        let picked = false;
        // 最多尝试 200 次；仍然冲突则放弃本次抽样（防止死循环）
        for (let attempt = 0; attempt < 200; attempt++) {
          const pair = pairs[pickIndex(rng, pairs.length, cdf)]!;
          if (heroAndBoardIndices.has(pair[0]) || heroAndBoardIndices.has(pair[1])) continue;
          if (opponentUsedIndices.has(pair[0]) || opponentUsedIndices.has(pair[1])) continue;
          picked = true;
          opponentUsedIndices.add(pair[0]);
          opponentUsedIndices.add(pair[1]);
          const buffer = opponentBuffers[i]!;
          buffer[0] = ALL_CARDS[pair[0]]!;
          buffer[1] = ALL_CARDS[pair[1]]!;
          break;
        }
        if (!picked) {
          aborted = true;
          break;
        }
      }

      if (aborted) {
        abortedRuns++;
        continue;
      }

      // ---- 2) 从「整副牌去掉所有已知牌」后的牌堆中无放回抽取剩余公共牌 ----
      resetDeck();
      if (deckSize < cardsToCome) {
        abortedRuns++;
        continue;
      }
      for (let i = 0; i < cardsToCome; i++) {
        const pick = randomInt(rng, deckSize);
        const card = deck[pick]!;
        deck[pick] = deck[deckSize - 1]!;
        deck[deckSize - 1] = card;
        deckSize -= 1;
        heroBuffer.push(card);
        for (const buffer of opponentBuffers) buffer.push(card);
      }

      // ---- 3) 比较 ----
      const heroValue = evaluateSeven(heroBuffer);
      let bestOpponentValue = -1;
      let tieCount = 0;
      for (let i = 0; i < opponentCount; i++) {
        const value = evaluateSeven(opponentBuffers[i]!);
        if (value > bestOpponentValue) {
          bestOpponentValue = value;
          tieCount = 1;
        } else if (value === bestOpponentValue) {
          tieCount++;
        }
      }

      if (heroValue > bestOpponentValue) {
        wins++;
        equitySum += 1;
      } else if (heroValue === bestOpponentValue) {
        ties++;
        equitySum += 1 / (tieCount + 1);
      } else {
        losses++;
      }
      completedRuns++;

      // ---- 4) 还原本轮状态 ----
      heroBuffer.length = 2 + board.length;
      for (const buffer of opponentBuffers) buffer.length = 2 + board.length;
    }
  };

  // ---- 阶段循环 ----
  // adaptive = false 时只有一级，跑满 startIterations 就结束，绝不升级。
  const stages = input.adaptive
    ? buildStages(input.startIterations, maxIterations)
    : [Math.min(Math.max(1, Math.floor(input.startIterations)), maxIterations)];
  let stoppedEarly = false;
  let stopReason: StopReason | null = null;
  let stopParams: Readonly<Record<string, string | number>> = {};
  const startedAt = deadline ? deadline.elapsedMs() : 0;

  for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
    const stageTarget = stages[stageIndex]!;
    const remaining = stageTarget - completedRuns;
    if (remaining <= 0) continue;

    // 开始本阶段前的检查：时间够不够
    if (deadline && !deadline.canStartRound(0)) {
      stoppedEarly = true;
      stopReason = EquityStopReason.DEADLINE_REACHED;
      stopParams = {
        elapsedMs: Math.round(deadline.elapsedMs()),
        remainingMs: Math.round(deadline.remainingMs()),
        completedRuns,
      };
      break;
    }

    runOneBatch(remaining);

    // 非自适应模式：跑满即止，不做任何「聪明」的额外判断
    if (!input.adaptive) break;

    // 本阶段结束后做三重检查
    const equityNow = completedRuns === 0 ? 0 : equitySum / completedRuns;
    const nextStage = stages[stageIndex + 1];
    const decision = evaluateMonteCarloStop({
      equity: equityNow,
      total: completedRuns,
      nextIterations: nextStage ?? completedRuns,
      ...(input.decisionThreshold !== undefined ? { decisionThreshold: input.decisionThreshold } : {}),
      diminishingReturnsThreshold,
      ...(deadline ? { deadline } : {}),
      confidence: DEFAULT_CONFIDENCE,
    });

    if (decision.shouldStop) {
      stoppedEarly = true;
      stopReason = decision.reason;
      stopParams = decision.params;
      break;
    }

    if (nextStage === undefined) {
      stoppedEarly = true;
      stopReason = EquityStopReason.MAX_ITERATIONS;
      stopParams = { maxIterations };
      break;
    }
  }

  const total = completedRuns;
  const equity = total === 0 ? 0 : equitySum / total;
  const halfWidth = total === 0 ? Number.POSITIVE_INFINITY : confidenceHalfWidth(equity, total, DEFAULT_CONFIDENCE);

  const issues: EquityIssue[] = [];
  if (total === 0) {
    issues.push({
      code: IssueCode.EQUITY_NOT_COMPUTABLE,
      severity: IssueSeverity.BLOCKER,
      params: { reason: '蒙特卡洛抽样全部因对手范围互相冲突而失败', abortedRuns },
    });
  } else if (total < minRecommendedIterations) {
    issues.push({
      code: IssueCode.SIMULATION_TOO_FEW,
      severity: IssueSeverity.WARNING,
      params: { iterations: total, recommended: minRecommendedIterations, abortedRuns },
    });
  }

  return {
    equity,
    wins,
    ties,
    losses,
    total,
    method: 'MONTE_CARLO',
    iterations: total,
    matchups: total,
    seed,
    confidenceInterval95: Number.isFinite(halfWidth) ? halfWidth : Number.NaN,
    opponentCount,
    combosPerOpponent: perOpponentPairs.map((pairs) => pairs.length),
    elapsedMs: deadline ? deadline.elapsedMs() - startedAt : 0,
    stoppedEarly,
    stopReason,
    stopParams,
    abortedRuns,
    // 引擎本身不关心选型；门面会用真实策略覆盖这两个字段
    methodReason: EquityPolicyReason.TOO_MANY_MATCHUPS,
    downgradedFrom: null,
    issues,
  };
}
