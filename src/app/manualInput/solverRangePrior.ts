/**
 * 翻前范围先验的**求解器版本**（Phase 1.2）
 *
 * ## 这个模块做什么
 *
 * 把 GTOpen 的翻前频率，转换成 `contextBuilder` 能直接用的**范围权重**。
 * 换句话说：把「对手范围」从**猜的**换成**算的**（在算得出来的地方）。
 *
 * ## 🔴 三条不可动摇的纪律
 *
 * ### 1. 只在**严格匹配**时使用，不匹配就回落
 *
 * GTO 的数据带一整套前提：桌人数 / 筹码 / 开池尺寸 / 3Bet 尺寸 / 加注上限。
 * 任何一项对不上，那份数据描述的就是**另一个牌局**。
 * 本模块的做法是**逐项核对**，对不上就返回 `null` 让调用方回落启发式 ——
 * 而不是「差不多就用」。
 *
 * ### 2. 转换必须**按牌名**对齐，绝不按序号
 *
 * 项目里有**两套** 169 类顺序（见 `test/handClassOrdering.test.ts`）：
 *
 * ```text
 * GTO 显示顺序: AA AKs AQs AJs … A2s AKo KK …     （13×13 逐行）
 * 先验权重顺序: AA AKs AKo AQs AQo AJs AJo …     （逐高牌，先同花后不同花）
 * ```
 *
 * 实测只有 **5/169** 个位置相同。按序号直接对接会把约 164 个牌型的频率
 * 灌到**别的牌**上，而且长度对得上、类型对得上、**没有任何报错**。
 * 因此这里一律走**牌名匹配**（`GtoHandStrategy.hand` 就是牌名，天然安全）。
 *
 * ### 3. 频率 → 权重的语义必须说清楚
 *
 * 对手「选择加注」这件事本身**信息量极大**：它把他范围里所有不加注的牌
 * 全部排除了。因此给定「对手加注」时，他的范围就是**加注频率**本身
 *（不是「先验 × 加注频率」）。
 *
 * | 对手的动作 | 用的频率 |
 * |---|---|
 * | 第一个加注（开池） | 该节点上的 `RAISE` 频率 |
 * | 面对一个加注选择跟注 | `CALL` 频率 |
 * | 面对一个加注选择 3Bet | `RAISE` / `ALL_IN` 频率之和 |
 *
 * ⚠️ 频率为 0 的牌**不进范围**（权重 0 会被下游归一化剔掉）——
 * 这正是「他没用这手牌做这个动作」的表达。
 */

import { GtoActionKind, type GtoPosition, type GtoTableSize } from '../../domain/gto/gto.types.ts';
import type { GtoBaseline, GtoLookupResult, GtoProvider, GtoRange } from '../../domain/gto/gto.types.ts';
import { GtoSolveStatus } from '../../domain/gto/gto.types.ts';
import type { GtoSolveKeyParts } from '../../domain/gto/gtoScenario.ts';

/* ============================================================
 * 类型
 * ============================================================ */

/** 169 类权重（牌名 → 0..1）。与 `preflopPriors` 的 `RankClassWeights` 结构相同。 */
export type RankClassWeights = Readonly<Record<string, number>>;

/** 一次 GTO 范围查询的结果（成功或**带原因的失败**） */
export type SolverRangePrior =
  | {
      ok: true;
      /** 169 类权重，**按牌名**索引 */
      weights: RankClassWeights;
      /** 求解器侧的可信度与出处（用于 provenance） */
      engineCommit: string | null;
      /** 该节点上被取用的动作 */
      usedActions: readonly string[];
      /** 该次求解的收敛信息（如实带上，不美化） */
      reportedGap: number | null;
      iterationsCompleted: number | null;
    }
  | {
      ok: false;
      /** 为什么用不了（**必须能展示给使用者看**） */
      reasonZh: string;
    };

/* ============================================================
 * 覆盖判定
 * ============================================================ */

/**
 * 求解设置与**实际牌局**是否逐项匹配。
 *
 * 🔴 任何一项对不上都必须拒绝 —— 这是本模块最重要的一道闸。
 *
 * | 项 | 为什么必须匹配 |
 * |---|---|
 * | 开池尺寸 | 2.5BB 开池的范围 ≠ 3BB 开池的范围（后者要给更多钱，范围更紧） |
 * | 3Bet 尺寸 | 7.5BB 与 12BB 的 3Bet 范围完全不同 |
 * | 加注上限 | 上限决定了节点上**有没有 4Bet**，菜单不同则策略不同 |
 *
 * ⚠️ **有效筹码不在这个函数里核对** —— 它在**场景构造**时就钉死了：
 * 调用方用实际筹码构造 `GtoScenario`，而筹码会进场景哈希与缓存键，
 * 因此「40BB 的牌局读到 100BB 的缓存」在结构上不可能发生。
 * 放两份核对只会制造「两处判断、改一处」的缺陷面。
 */
export function solveSettingsMatch(input: {
  solve: GtoSolveKeyParts;
  /** 实际发生的开池尺寸（BB）；`null` = 本手没有开池 */
  observedOpenSizeBB: number | null;
  /** 实际发生的 3Bet 尺寸（BB）；`null` = 本手没有 3Bet */
  observedThreeBetSizeBB: number | null;
}): { ok: true } | { ok: false; reasonZh: string } {
  const { solve } = input;

  if (solve.openSizesBB.length !== 1) {
    return {
      ok: false,
      reasonZh: `求解器配置了 ${solve.openSizesBB.length} 个开池尺寸，无法确定实际用的是哪一个`,
    };
  }
  const configuredOpen = solve.openSizesBB[0]!;
  if (
    input.observedOpenSizeBB !== null &&
    Math.abs(input.observedOpenSizeBB - configuredOpen) > 1e-6
  ) {
    return {
      ok: false,
      reasonZh:
        `实际开池 ${input.observedOpenSizeBB}BB，而求解配置是 ${configuredOpen}BB —— ` +
        '不同开池尺寸对应完全不同的范围，不能用这份数据顶替',
    };
  }

  if (solve.raiseMults.length !== 1) {
    return {
      ok: false,
      reasonZh: `求解器配置了 ${solve.raiseMults.length} 个再加注倍数，无法确定实际用的是哪一个`,
    };
  }
  if (input.observedThreeBetSizeBB !== null && input.observedOpenSizeBB !== null) {
    const expected = input.observedOpenSizeBB * solve.raiseMults[0]!;
    if (Math.abs(input.observedThreeBetSizeBB - expected) > 1e-6) {
      return {
        ok: false,
        reasonZh:
          `实际 3Bet 到 ${input.observedThreeBetSizeBB}BB，而求解配置是开池的 ` +
          `${solve.raiseMults[0]} 倍（= ${expected}BB）—— 3Bet 尺寸不同，范围不同`,
      };
    }
  }

  return { ok: true };
}

/* ============================================================
 * 频率 → 权重
 * ============================================================ */

/**
 * 从求解器节点里取出指定动作的**频率**，作为 169 类权重。
 *
 * @param kinds 要合并的动作类型（例如 3Bet = `RAISE` + `ALL_IN`）
 */
export function weightsFromRange(
  range: GtoRange,
  kinds: readonly GtoActionKind[],
): RankClassWeights | null {
  if (!range.reachable) return null;
  const out: Record<string, number> = {};
  let anyPositive = false;

  for (const hand of range.hands) {
    let weight = 0;
    for (const action of hand.actions) {
      if (kinds.includes(action.kind)) weight += action.frequency;
    }
    // 频率可能因浮点累加略超 1；夹到 [0,1] 保持下游不变量
    const clamped = Math.min(1, Math.max(0, weight));
    out[hand.hand] = clamped;
    if (clamped > 0) anyPositive = true;
  }

  // 一手牌都不做这个动作 ⇒ 这个范围无法表达（宁可回落，也不给空范围）
  return anyPositive ? Object.freeze(out) : null;
}

/* ============================================================
 * 从一份已取得的基线构造 prior（Phase 1.3）
 * ============================================================ */

/**
 * 把一份**已经拿到的** `GtoBaseline` 变成范围 prior。
 *
 * ## 为什么需要单独一条路径
 *
 * Phase 1.3 起前台请求**只读缓存、绝不求解**。缓存命中的结果是
 * 「场景等价、但可能来自不同于本次请求的键」的那一份数据。
 * 它必须经过与冷求解**完全同一套**校验（节点可达、行动者身份、频率非空），
 * 否则就出现两条质量不同的入口 —— 而其中一条会成为漏洞。
 *
 * 因此本函数与 `lookupPreflopRangePrior` 共用 `weightsFromRange`
 * 和同一组校验，**不重复实现**。区别只有一处：数据从哪来。
 */
export function priorFromCachedBaseline(
  action: OpponentPreflopAction,
  baseline: GtoBaseline,
): SolverRangePrior {
  const range = baseline.range;

  if (!range.reachable) {
    return {
      ok: false,
      reasonZh:
        `求解器报告该节点**不可达**（${range.unavailableReason ?? '未给原因'}）—— ` +
        '不可达节点的频率表没有策略含义',
    };
  }

  // 节点上的行动者必须是我们要建模的那个对手（防止读到别人的策略）
  if (range.actorPosition !== action.position) {
    return {
      ok: false,
      reasonZh:
        `求解器返回的节点行动者是 ${range.actorPosition}，而我们要建模的是 ` +
        `${action.position} —— 为避免把别人的策略当成他的，拒绝使用`,
    };
  }

  const kinds = kindsForAction(action);
  const weights = weightsFromRange(range, kinds);
  if (weights === null) {
    return {
      ok: false,
      reasonZh:
        `求解器在 ${action.position} 的这个节点上**没有任何牌**选择` +
        `${action.action === 'CALL_VS_OPEN' ? '跟注' : '加注'} —— ` +
        '无法用频率表构造范围，回落启发式先验',
    };
  }

  return {
    ok: true,
    weights,
    engineCommit: baseline.metadata.source.engineCommit,
    usedActions: [...kinds],
    reportedGap: baseline.metadata.solveSettings.reportedGap,
    iterationsCompleted: baseline.metadata.solveSettings.iterationsCompleted,
  };
}

/** 这个对手动作要合并哪些求解器动作类型 */
function kindsForAction(action: OpponentPreflopAction): readonly GtoActionKind[] {
  return action.action === 'CALL_VS_OPEN'
    ? [GtoActionKind.CALL]
    : [GtoActionKind.RAISE, GtoActionKind.ALL_IN];
}

/* ============================================================
 * 查询
 * ============================================================ */

/** 呼叫方要描述「这个对手在翻前做了什么」 */
export type OpponentPreflopAction = {
  tableSize: GtoTableSize;
  /** 这个对手的位置 */
  position: GtoPosition;
  effectiveStackBB: number;
  /** 本手实际的开池尺寸（BB）；用于覆盖判定 */
  observedOpenSizeBB: number | null;
  observedThreeBetSizeBB: number | null;
  /**
   * 这个对手的动作类型：
   * - `OPEN`  他是**第一个**加注的人
   * - `CALL_VS_OPEN` 他面对**一个**加注选择跟注
   * - `THREE_BET_VS_OPEN` 他面对**一个**加注选择再加注
   */
  action: 'OPEN' | 'CALL_VS_OPEN' | 'THREE_BET_VS_OPEN';
  /** 开池者的位置（`OPEN` 时为自己） */
  openerPosition: GtoPosition;
};

/**
 * 向求解器要一份翻前范围权重。
 *
 * 返回 `{ ok: false, reasonZh }` 时调用方**必须**回落启发式先验 ——
 * 不得把 `reasonZh` 当成「大概能用」的信号。
 */
export async function lookupPreflopRangePrior(
  provider: GtoProvider,
  action: OpponentPreflopAction,
  /** 用于缓存/日志的场景哈希（由调用方构造，这里不重复实现） */
  scenarioOf: (input: OpponentPreflopAction) => Parameters<GtoProvider['lookupScenario']>[0] | null,
): Promise<SolverRangePrior> {
  const scenario = scenarioOf(action);
  if (scenario === null) {
    return {
      ok: false,
      reasonZh:
        '这个前序动作在本项目的求解场景模型里表达不出来（例如多轮加注后的节点）—— ' +
        '回落启发式先验',
    };
  }

  const solve = provider.solveKeyParts(scenario);
  const match = solveSettingsMatch({
    solve,
    observedOpenSizeBB: action.observedOpenSizeBB,
    observedThreeBetSizeBB: action.observedThreeBetSizeBB,
  });
  if (!match.ok) return { ok: false, reasonZh: match.reasonZh };

  let result: GtoLookupResult;
  try {
    result = await provider.lookupScenario(scenario);
  } catch (error) {
    return { ok: false, reasonZh: `查询求解器时抛错：${String((error as Error).message)}` };
  }

  if ('status' in result && result.status === GtoSolveStatus.GTO_BASELINE_UNAVAILABLE) {
    return {
      ok: false,
      reasonZh: `求解器不可用（${result.cause}）：${result.message}`,
    };
  }

  /*
   * ⚠️ 校验与取权重**全部复用** `priorFromCachedBaseline` ——
   * 缓存的基线与刚算出来的基线没有区别，**绝不能**有两套质量不同的入口
   * （其中一套迟早会漏掉某条校验，而漏掉的那条会成为漏洞）。
   */
  return priorFromCachedBaseline(action, result as GtoBaseline);
}
