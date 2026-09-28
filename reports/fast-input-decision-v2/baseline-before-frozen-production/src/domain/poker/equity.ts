/**
 * 权益引擎 —— 公开 API（门面）
 *
 * 职责只有四件事：
 *   1. 输入校验（宁可不给数字，也不给错数字）
 *   2. 过滤与已知牌冲突的对手组合
 *   3. 交给 equityPolicy 选型
 *   4. 分派给 equityExact / equityMonteCarlo，统一结果格式
 *
 * **本文件不含任何枚举或抽样逻辑**，因此它很短，也很难出错。
 *
 * 三条铁律（不可动摇）：
 * 1. **语言模型绝不参与权益计算。** 本模块是权益数字的唯一来源。
 * 2. **算不了就说算不了。** 任何无法计算的情形返回 { ok: false }，绝不返回估计值。
 * 3. **可复现。** 蒙特卡洛随机源由外部注入种子，种子随牌局保存。
 *
 * 权益定义（扑克惯例）：
 *   权益 = 获胜次数 / 总次数 + Σ(平分时每位平分者分得的份额) / 总次数
 *   两人平分 → 各得 0.5；三人平分 → 各得 1/3。
 */

import { type Card } from '../types.ts';
import { IssueCode, type IssueCode as IssueCodeType } from '../domainCodes.ts';
import { cardIndex } from './cards.ts';
import { enumerateExact } from './equityExact.ts';
import { simulateMonteCarlo } from './equityMonteCarlo.ts';
import {
  DEFAULT_ITERATIONS,
  DEFAULT_MIN_RECOMMENDED_ITERATIONS,
  EquityComputeMode,
  EquityPolicyReason,
  resolveDiminishingReturns,
  toIndexPair,
  type EquityOptions,
  type EquityOutcome,
  type OpponentRange,
} from './equity.types.ts';
import {
  applyDeadlineToMethod,
  buildCapacity,
  defaultDeadlineForMode,
  exactEnumerationFitsDeadline,
} from './equityPolicy.ts';
import type { DecisionDeadline } from '../../app/decisionDeadline.ts';

export * from './equity.types.ts';
export {
  applyDeadlineToMethod,
  buildCapacity,
  confidenceHalfWidth,
  defaultDeadlineForMode,
  evaluateMonteCarloStop,
  exactEnumerationFitsDeadline,
} from './equityPolicy.ts';

function cannotCompute(
  code: IssueCodeType,
  params: Record<string, string | number> = {},
): EquityOutcome {
  return { ok: false, code, params };
}

/**
 * 计算「我的手牌 vs 一个或多个对手范围」的权益。
 *
 * @param heroHole 我的两张底牌
 * @param board 已知公共牌（0 / 3 / 4 / 5 张）
 * @param opponents 对手范围列表；长度 ≥ 1
 * @param options 计算选项（样本量、种子、时间预算、模式……）
 */
export function computeEquity(
  heroHole: readonly Card[],
  board: readonly Card[],
  opponents: readonly OpponentRange[],
  options: EquityOptions = {},
): EquityOutcome {
  // ---------- 1. 输入校验 ----------
  if (heroHole.length !== 2) {
    return cannotCompute(IssueCode.EQUITY_NOT_COMPUTABLE, {
      reason: `底牌必须是 2 张，当前 ${heroHole.length} 张`,
    });
  }
  if (board.length > 5) {
    return cannotCompute(IssueCode.EQUITY_NOT_COMPUTABLE, {
      reason: `公共牌不能超过 5 张，当前 ${board.length} 张`,
    });
  }
  if (board.length !== 0 && board.length !== 3 && board.length !== 4 && board.length !== 5) {
    return cannotCompute(IssueCode.EQUITY_NOT_COMPUTABLE, {
      reason: `公共牌张数只能是 0 / 3 / 4 / 5，当前 ${board.length} 张`,
    });
  }
  if (opponents.length === 0) {
    return cannotCompute(IssueCode.EQUITY_NOT_COMPUTABLE, { reason: '至少需要一个对手范围' });
  }

  // 重复牌检查（索引口径，与热路径一致）
  const knownIndices = new Set<number>();
  for (const card of [...heroHole, ...board]) knownIndices.add(cardIndex(card));
  if (knownIndices.size !== heroHole.length + board.length) {
    return cannotCompute(IssueCode.DUPLICATE_CARD, { card: '（重复牌）' });
  }

  // ---------- 2. 过滤与已知牌冲突的对手组合 ----------
  const perOpponentPairs: Array<Array<readonly [number, number]>> = [];
  /**
   * 与 `perOpponentPairs` **同步过滤**的权重。
   *
   * ⚠️ 必须与组合一起过滤：死牌会移除部分组合，
   * 若只过滤组合而保留原权重数组，权重与组合就会**错位** ——
   * 那会让权益用一个完全错误的分布计算，且不会报任何错。
   */
  const perOpponentWeights: Array<Array<number>> = [];
  const declaredWeights = options.opponentWeights;
  if (declaredWeights !== undefined && declaredWeights.length !== opponents.length) {
    return cannotCompute(IssueCode.EQUITY_NOT_COMPUTABLE, {
      reason: `opponentWeights 长度(${declaredWeights.length})与对手数量(${opponents.length})不一致`,
    });
  }

  for (const [opponentIndex, opponent] of opponents.entries()) {
    const valid: Array<readonly [number, number]> = [];
    const validWeights: number[] = [];
    const weights = declaredWeights?.[opponentIndex];
    if (weights !== undefined && weights.length !== opponent.combos.length) {
      return cannotCompute(IssueCode.EQUITY_NOT_COMPUTABLE, {
        reason: `对手「${opponent.label}」的权重数(${weights.length})与组合数(${opponent.combos.length})不一致`,
      });
    }
    for (const [comboIndex, combo] of opponent.combos.entries()) {
      const pair = toIndexPair(combo);
      if (pair[0] === pair[1]) continue;
      if (knownIndices.has(pair[0]) || knownIndices.has(pair[1])) continue;
      valid.push(pair);
      if (weights !== undefined) validWeights.push(weights[comboIndex]!);
    }
    if (valid.length === 0) {
      return cannotCompute(IssueCode.EQUITY_NOT_COMPUTABLE, {
        reason: `对手范围「${opponent.label}」在扣除已知牌后没有任何可用组合`,
      });
    }
    perOpponentPairs.push(valid);
    if (weights !== undefined) perOpponentWeights.push(validWeights);
  }

  const useWeights = declaredWeights !== undefined;

  // ---------- 3. 选型 ----------
  const mode = options.mode ?? EquityComputeMode.FAST;
  const deadline: DecisionDeadline | undefined =
    options.deadline ?? (mode === EquityComputeMode.FAST ? undefined : defaultDeadlineForMode(mode));

  const capacity = applyDeadlineToMethod(
    buildCapacity(
      {
        combosPerOpponent: perOpponentPairs.map((pairs) => pairs.length),
        knownCardCount: knownIndices.size,
        boardCount: board.length,
      },
      { ...options, mode },
    ),
    deadline,
  );

  /**
   * 调用方**显式**要求精确枚举（forceMethod / VERIFY 模式），但精确枚举内部
   * 是一段无让步的同步递归，**无法被时间预算打断**。
   *
   * 因此这是全项目唯一「不可中止」的计算路径，必须在启动前把关：
   * 规模放不下就**拒绝执行**，而不是静默换成蒙特卡洛
   * （规范第 59 条：算法降级必须显式，不能偷偷发生）。
   */
  const explicitlyRequestedExact =
    options.forceMethod === 'EXACT' || mode === EquityComputeMode.VERIFY;
  if (explicitlyRequestedExact) {
    const bound = buildCapacity(
      {
        combosPerOpponent: perOpponentPairs.map((pairs) => pairs.length),
        knownCardCount: knownIndices.size,
        boardCount: board.length,
      },
      { ...options, mode },
    ).exactMatchupsBound;
    if (deadline && !exactEnumerationFitsDeadline(bound, deadline)) {
      return cannotCompute(IssueCode.EQUITY_NOT_COMPUTABLE, {
        reason:
          `精确枚举需要处理约 ${bound.toLocaleString('en-US')} 局，` +
          `超出剩余时间预算（剩余 ${Math.max(0, Math.round(deadline.remainingMs()))} 毫秒），` +
          '已拒绝在交互路径上执行。请改用蒙特卡洛，或使用高精度/验证模式。',
      });
    }
  }

  // ---------- 4. 分派 ----------
  const opponentCount = perOpponentPairs.length;

  /**
   * 是否因时间预算从精确枚举降级为蒙特卡洛。
   * 降级本身是允许的（否则交互路径会被完整枚举拖死），
   * 但**必须写进结果**，不能静默（规范第 59 条）。
   */
  const downgradedFrom: 'EXACT' | null =
    capacity.methodReason === EquityPolicyReason.DOWNGRADED_BY_DEADLINE ? 'EXACT' : null;

  if (capacity.method === 'EXACT') {
    const exactResult = enumerateExact({
      heroHole,
      board,
      perOpponentPairs,
      /*
       * 🔴 **精确枚举也必须带范围后验权重**（2026-09 修正轮）。
       *
       * 修复前这里没有这一项，而 `perOpponentWeights` 只在蒙特卡洛分支传 ——
       * 于是**同一份输入会因为「选型」不同给出不同答案**：窄范围/单挑最容易
       * 落在 EXACT 路径（容量 ≤ `maxExactMatchups`），而那正是后验最要紧的局面。
       * 实测（对手范围 = {A♣Q♦ 权 99, 8♦8♣ 权 1}）：EXACT 给 6.8182%（等于 1:1），
       * 加权真值 13.6085%。这种错**不会报任何错**，只会静默给出错误权益。
       */
      ...(useWeights ? { perOpponentWeights } : {}),
      opponentCount,
    });
    return {
      ok: true,
      result: { ...exactResult, methodReason: capacity.methodReason, downgradedFrom: null },
    };
  }

  const iterations = Math.max(1, Math.floor(options.iterations ?? DEFAULT_ITERATIONS));
  const seed = options.seed ?? 20260101;
  const minRecommended = options.minRecommendedIterations ?? DEFAULT_MIN_RECOMMENDED_ITERATIONS;

  const mcResult = simulateMonteCarlo({
    heroHole,
    board,
    perOpponentPairs,
    // 只在调用方显式提供权重时传入 —— 省略时抽样路径与修复前逐位一致
    ...(useWeights ? { perOpponentWeights } : {}),
    opponentCount,
    startIterations: iterations,
    maxIterations: Math.max(iterations, capacity.maxIterations),
    seed,
    adaptive: options.adaptive ?? false,
    minRecommendedIterations: minRecommended,
    ...(options.decisionThreshold !== undefined
      ? { decisionThreshold: options.decisionThreshold }
      : {}),
    diminishingReturnsThreshold: resolveDiminishingReturns(options),
    ...(deadline ? { deadline } : {}),
  });

  return {
    ok: true,
    result: { ...mcResult, methodReason: capacity.methodReason, downgradedFrom },
  };
}
