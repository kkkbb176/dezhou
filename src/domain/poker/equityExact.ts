/**
 * 权益引擎 —— 精确枚举
 *
 * 职责唯一：**把每一种可能的「对手组合 × 剩余公共牌」都算一遍。**
 * 禁止在本文件加入玩家模型、范围推理、决策逻辑。
 *
 * 为什么必须保留精确枚举（规范第 11 节）：
 * 它是黄金测试、回归测试、数学验证与引擎基准的**真值来源**。
 * 蒙特卡洛只能逼近它，不能替代它。
 *
 * 性能约束（规范第 11 节）：
 * AA vs KK 翻牌前完整枚举约 1000 万局、约 15 秒 —— 这对交互式决策不可接受。
 * 因此本函数**不受时间预算约束**（它不接收 deadline），
 * 是否调用它由 equityPolicy 决定。普通交互路径不会走到 15 秒的枚举。
 *
 * 正确性要点（都是踩过的坑）：
 * 1. 剩余牌堆必须同时扣除：我的底牌、公共牌、**当前分支里已分配给对手的底牌**。
 *    早期版本漏掉第三项，导致同一张牌既在对手手里又发到公共牌上，
 *    AA vs KK 的权益从 82% 被算成 69%。
 * 2. 整个枚举只构建一次牌堆，靠 push/pop 维护分支占用，避免在千万次叶子节点上分配数组。
 */

import { ALL_CARDS, type Card } from '../types.ts';
import { IssueCode, IssueSeverity, type IssueCode as IssueCodeType } from '../domainCodes.ts';
import { cardIndex } from './cards.ts';
import { evaluateSeven } from './fastEval.ts';
import { EquityPolicyReason, type EquityIssue, type EquityResult } from './equity.types.ts';

export type ExactEnumerationInput = {
  heroHole: readonly Card[];
  board: readonly Card[];
  /** 每位对手**已经过滤掉与已知牌冲突**的组合（索引形式） */
  perOpponentPairs: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  /**
   * 🔴 **与 `perOpponentPairs` 逐位对齐的权重**（2026-09 修正轮）。
   *
   * ⚠️ 省略时每一位按 1 计 —— 此时结果与修复前**逐位一致**。
   *
   * ## 为什么必须有它（这是一个静默错答的修复）
   *
   * 修复前本函数**完全忽略**范围后验权重：`equitySum / matchups` 是均匀计权。
   * 而门面 `equity.ts` 只在蒙特卡洛分支传 `perOpponentWeights`，
   * 于是**同一份输入会因为「选型」不同而给出不同答案**：
   *
   * ```text
   * 单挑，对手范围 = { A♣Q♦ 权 99, 8♦8♣ 权 1 }，牌面 K♥9♠4♦2♣，我 7♣6♣
   *   EXACT 路径（默认选型，88 个对局）→ 6.8182%（权重被丢掉，等于 1:1）
   *   加权真值（蒙特卡洛 20 万次）    → 13.6085%
   * ```
   *
   * 偏偏**窄范围/单挑**最容易落在 EXACT 路径上（容量 ≤ `maxExactMatchups`），
   * 而那正是后验权重最要紧的局面。
   */
  perOpponentWeights?: ReadonlyArray<ReadonlyArray<number>>;
  /** 对手数量（= perOpponentPairs.length，显式传入以便自检） */
  opponentCount: number;
};

/**
 * 执行完整的精确枚举。
 *
 * 调用方必须保证：底牌 2 张、公共牌 0/3/4/5 张、组合已过滤、无重复牌。
 */
export function enumerateExact(input: ExactEnumerationInput): EquityResult {
  const { heroHole, board, perOpponentPairs, opponentCount, perOpponentWeights } = input;
  if (perOpponentPairs.length !== opponentCount) {
    throw new Error(
      `enumerateExact: opponentCount(${opponentCount}) 与组合数组长度(${perOpponentPairs.length}) 不一致`,
    );
  }
  /*
   * 🔴 权重必须与组合**逐位对齐**（长度、顺序）。
   * 不对齐的权重会让权益用一个完全错误的分布算出来，而且不会报错 ——
   * 因此这里宁可抛错也不静默降级成均匀（见 `perOpponentWeights` 的说明）。
   */
  if (perOpponentWeights !== undefined) {
    if (perOpponentWeights.length !== opponentCount) {
      throw new Error(
        `enumerateExact: perOpponentWeights 长度(${perOpponentWeights.length}) 与对手数(${opponentCount}) 不一致`,
      );
    }
    for (let i = 0; i < opponentCount; i++) {
      if (perOpponentWeights[i]!.length !== perOpponentPairs[i]!.length) {
        throw new Error(
          `enumerateExact: 第 ${i} 位对手的权重数(${perOpponentWeights[i]!.length}) 与组合数(${perOpponentPairs[i]!.length}) 不一致`,
        );
      }
    }
  }
  const weighted = perOpponentWeights !== undefined;

  const cardsToCome = 5 - board.length;
  const heroBuffer: Card[] = [heroHole[0]!, heroHole[1]!, ...board];
  const placeholder: Card = { rank: 2, suit: 's' };
  const opponentBuffers: Card[][] = perOpponentPairs.map(() => [placeholder, placeholder, ...board]);

  /** 分支占用（整数索引），用于跳过已分配给对手的牌 */
  const usedIndices = new Set<number>();
  for (const card of [...heroHole, ...board]) usedIndices.add(cardIndex(card));

  /** 整副牌只构建一次；分支占用靠 push/pop 维护 */
  const deck: Card[] = ALL_CARDS.filter((card) => !usedIndices.has(cardIndex(card)));
  const branchUsed: number[] = [];

  let wins = 0;
  let ties = 0;
  let losses = 0;
  let matchups = 0;
  /** 权益累加：赢 1 分；与 k 人平分得 1/(k+1) 分（**按权重加权**） */
  let equitySum = 0;
  /**
   * 权重之和（无权重时恒等于 `matchups` ⇒ 与修复前逐位一致）。
   *
   * ⚠️ 分母必须用它而不是 `matchups` —— 权重不是均匀的，
   * 用对局数当分母正是修复前那个静默错答的来源。
   */
  let weightSum = 0;

  const runoutIndices: number[] = [];
  const runoutCards: Card[] = [];
  const selection: number[] = new Array(opponentCount).fill(0);

  /**
   * 当前这个对局的权重 = Π_i 该对手所选组合的权重。
   *
   * 无权重时返回 1（因此 `weightSum === matchups`，结果与修复前逐位一致）。
   * `selection[i]` 在 `walkOpponents` 里已经写好，是**过滤后**的数组下标 ——
   * 与 `perOpponentWeights[i]` 同源同序，不会错位。
   */
  const currentWeight = (): number => {
    if (!weighted) return 1;
    let w = 1;
    for (let i = 0; i < opponentCount; i++) w *= perOpponentWeights![i]![selection[i]!]!;
    return w;
  };

  /**
   * 对局核心：给定当前的对手组合与（已压入缓冲区的）公共牌，比较一次胜负。
   */
  const playOneMatchup = (): void => {
    matchups++;
    const w = currentWeight();
    weightSum += w;
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
      equitySum += w;
    } else if (heroValue === bestOpponentValue) {
      ties++;
      equitySum += w / (tieCount + 1);
    } else {
      losses++;
    }
  };

  const walkRunout = (start: number): void => {
    if (runoutIndices.length === cardsToCome) {
      /**
       * 公共牌已满（cardsToCome === 0）时**不存在 runout**：
       * 此时每种对手组合恰好对应一局，直接比较即可。
       *
       * 早期实现在这种情况下仍会递归遍历整副牌堆的每个下标（叶子节点其实是
       * 「什么都不选」），白白产生 C(deck, 0) 次多余递归。把这条路径提前返回，
       * 河牌圈的精确枚举从「与牌堆规模成正比」降到「与组合数成正比」。
       */
      if (cardsToCome > 0) {
        for (const index of runoutIndices) {
          const card = deck[index]!;
          runoutCards.push(card);
          heroBuffer.push(card);
          for (const buffer of opponentBuffers) buffer.push(card);
        }
      }

      playOneMatchup();

      if (cardsToCome > 0) {
        heroBuffer.length = 2 + board.length;
        for (const buffer of opponentBuffers) buffer.length = 2 + board.length;
        runoutCards.length = 0;
      }
      return;
    }

    for (let i = start; i < deck.length; i++) {
      const card = deck[i]!;
      const index = cardIndex(card);
      // 跳过当前递归分支里已经分配给对手的牌 —— 否则同一张牌会既在对手手里又在公共牌上
      if (usedIndices.has(index)) continue;
      runoutIndices.push(i);
      walkRunout(i + 1);
      runoutIndices.pop();
    }
  };

  const walkOpponents = (index: number): void => {
    if (index === opponentCount) {
      walkRunout(0);
      return;
    }
    const pairs = perOpponentPairs[index]!;
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i]!;
      if (usedIndices.has(pair[0]) || usedIndices.has(pair[1])) continue;
      selection[index] = i;
      const buffer = opponentBuffers[index]!;
      buffer[0] = ALL_CARDS[pair[0]]!;
      buffer[1] = ALL_CARDS[pair[1]]!;
      usedIndices.add(pair[0]);
      usedIndices.add(pair[1]);
      branchUsed.push(pair[0], pair[1]);
      walkOpponents(index + 1);
      branchUsed.pop();
      branchUsed.pop();
      usedIndices.delete(pair[0]);
      usedIndices.delete(pair[1]);
    }
  };

  walkOpponents(0);

  const issues: EquityIssue[] =
    matchups === 0
      ? [
          {
            code: IssueCode.EQUITY_NOT_COMPUTABLE as IssueCodeType,
            severity: IssueSeverity.BLOCKER,
            params: { reason: '枚举到的有效对局数为 0' },
          },
        ]
      : weighted && weightSum === 0
        ? [
            {
              code: IssueCode.EQUITY_NOT_COMPUTABLE as IssueCodeType,
              severity: IssueSeverity.BLOCKER,
              params: {
                reason:
                  '所有枚举到的组合权重都是 0（范围已塌缩）—— 不能报一个「均匀计权」的权益',
              },
            },
          ]
        : [];

  return {
    // ⚠️ 分母是**权重之和**（无权重时 === matchups，与修复前逐位一致）
    equity: weightSum === 0 ? 0 : equitySum / weightSum,
    /*
     * ⚠️ `wins/ties/losses` 是**未加权的原始计数**（`wins+ties+losses === matchups`），
     * 因此`wins / matchups` **不等于** `equity`（后者按权重算）。
     * 保留计数口径是为了不破坏「计数」这个语义；判权益只能用 `equity`。
     */
    wins,
    ties,
    losses,
    total: matchups,
    method: 'EXACT',
    iterations: matchups,
    matchups,
    seed: null,
    confidenceInterval95: 0,
    opponentCount,
    combosPerOpponent: perOpponentPairs.map((pairs) => pairs.length),
    elapsedMs: 0,
    stoppedEarly: false,
    stopReason: null,
    stopParams: {},
    abortedRuns: 0,
    // 引擎本身不关心选型；门面会用真实策略覆盖这两个字段
    methodReason: EquityPolicyReason.FORCED_BY_CALLER,
    downgradedFrom: null,
    issues,
  };
}
