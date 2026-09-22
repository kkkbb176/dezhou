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
      /** 求解器自己设的收敛目标（准入判据的分母）；未报告为 null */
      targetGap: number | null;
      /** 🔴 准入结论（一句话中文），会原样进 provenance 供页面展示 */
      admitVerdictZh: string;
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

/* ============================================================
 * 🔴 准入闸（2026-09-22 修复）：未收敛 / 质量未知的快照**不得进入建议**
 * ============================================================ */

/**
 * 一份求解器快照的**准入裁决**。
 *
 * - `ADMITTED`：可以驱动对手范围
 * - `REJECTED`：**保留在缓存里用于诊断，但绝不进入决策**
 */
export type SolverRangeAdmission =
  | {
      readonly admitted: true;
      /** 准入结论的一句话（中文），会原样进 provenance 供页面展示 */
      readonly verdictZh: string;
    }
  | {
      readonly admitted: false;
      /** 机器可判的原因分类（界面/日志用，不解析中文） */
      readonly kind: 'NOT_CONVERGED' | 'QUALITY_UNKNOWN' | 'SOLVER_NOT_DONE';
      readonly reasonZh: string;
    };

/**
 * 判断一份**已取得的**求解快照是否有资格驱动决策。
 *
 * ## 被修掉的缺陷（实测）
 *
 * 修复前，`priorFromCachedBaseline` 只校验**结构**（节点可达、行动者是本人、
 * 频率非空），**完全不看收敛**。于是任何进了缓存的快照都会被当成求解器的
 * 结论使用 —— 而缓存里确实躺着这样一条：
 *
 * ```text
 * cacheKey c067cd8cb  =「6MAX / 1000000BB / UTG / RFI」
 *   targetGap  0.2        ← 求解器自己设的目标
 *   brGapTotal 129.1475   ← 实测 gap，比目标大 645 倍
 *   stopReason ""         ← 没给原因
 *   solverState "running" ← 快照是在**还在跑**的时候抓的
 *   approximation.notConverged = true
 *   quality LOW_CONVERGENCE，qualityZh 自己写着「频率是未收敛快照，不可当作均衡」
 * ```
 *
 * 它会一路走到 `contextBuilder.buildBaseRange`，把 169 类权重换成这份快照，
 * 而**权益、底价、Call EV、动作排名全都跟着变**。使用者看到的是
 * 「命中已缓存的 GTO 策略」，看不出它其实没收敛。
 *
 * ## 为什么不能只靠 `quality` 字段
 *
 * 本仓库有三档质量等级（`LOW_CONVERGENCE` < `APPROXIMATE` < `USABLE`），
 * 而**所有**已落盘条目都是 `LOW_CONVERGENCE`（缺失稳定性证据会恒压到这一档）。
 * 用它当闸门等于没有闸门。因此本函数直接看**收敛事实本身**：
 * `brGapTotal` vs `targetGap`。
 *
 * ## 判据（全部必要，缺一即拒）
 *
 * | 编号 | 判据 | 拒绝时说明什么 |
 * |---|---|---|
 * | G1 | `approximation.notConverged !== true` | 求解器自己标了「未收敛」 |
 * | G2 | `reportedGap` 与 `targetGap` 都必须是**有限正数** | 没测过 / 没设目标 ⇒ 质量未知，不敢用 |
 * | G3 | `reportedGap < targetGap` | 没到目标 |
 * | G4 | `stopReason` 不得是 `iteration_limit` | 被迭代上限截断（比 G3 更早的旁证） |
 * | G5 | solverState 不得是 `running` / `queued` | 快照是在求解**还没结束**时抓的 |
 *
 * ⚠️ **刻意不做**「给 `effectiveStackBB` 加一个大数上限」：
 * 筹码深度**已经**进场景哈希与缓存键（实测 100 / 1000 / 1000000BB 三把键
 * 互不相同），所以「百万 BB 读到百 BB 的策略」在结构上不会发生。
 * 真正的漏洞是「百万 BB 那条**自己**没收敛，却照样被用」——
 * 那是 G1~G4 的职责。凭空加一个 200BB 上限只会砍掉合法数据
 *（缓存里 1000BB 那条的 gap 是 0.0467，**是达标的**）。
 *
 * @param baseline 已取得的结果（冷求解或缓存命中**共用**本函数）
 */
export function admitSolverBaseline(baseline: GtoBaseline): SolverRangeAdmission {
  const settings = baseline.metadata.solveSettings;
  const approx = baseline.metadata.approximation;

  /* G1：求解器自己标了「未收敛」 */
  if (approx.notConverged === true) {
    return {
      admitted: false,
      kind: 'NOT_CONVERGED',
      reasonZh:
        '求解器把本次结果标为**未收敛**（approximation.notConverged = true）—— ' +
        '频率是中途快照，不是均衡，不能用来算对手范围',
    };
  }

  /* G5：快照是在求解还没结束时抓的 */
  const raw = settings.raw as Record<string, unknown>;
  const solverState = typeof raw['solverState'] === 'string' ? raw['solverState'] : null;
  if (solverState === 'running' || solverState === 'queued' || solverState === 'pending') {
    return {
      admitted: false,
      kind: 'SOLVER_NOT_DONE',
      reasonZh:
        `这份快照是在求解**尚未结束**时抓的（solverState = ${solverState}）—— ` +
        '它描述的是一个还在变化的中间状态',
    };
  }

  /* G2：两个指标必须都拿到，否则「质量未知」不等于「质量合格」 */
  const gap = settings.reportedGap;
  const target = settings.targetGap;
  if (gap === null || !Number.isFinite(gap)) {
    return {
      admitted: false,
      kind: 'QUALITY_UNKNOWN',
      reasonZh: '求解器**没有报告**收敛指标（BR gap）—— 没有证据就不能当合格结果用',
    };
  }
  if (target === null || !Number.isFinite(target) || target <= 0) {
    return {
      admitted: false,
      kind: 'QUALITY_UNKNOWN',
      reasonZh:
        '这份结果**没有设定收敛目标**（targetGap = ' +
        `${target === null ? '未报告' : String(target)}）—— ` +
        '求解器跑满迭代数即停，无法判断是否收敛',
    };
  }

  /* G4：被迭代上限截断 */
  const stopReason = typeof raw['stopReason'] === 'string' ? (raw['stopReason'] as string) : '';
  if (stopReason === 'iteration_limit') {
    return {
      admitted: false,
      kind: 'NOT_CONVERGED',
      reasonZh:
        `求解器被**迭代上限截断**（停止原因 iteration_limit），` +
        `BR gap ${gap.toFixed(6)} ≥ 目标 ${target}`,
    };
  }

  /* G3：gap 必须真的低于目标 */
  if (!(gap < target)) {
    return {
      admitted: false,
      kind: 'NOT_CONVERGED',
      reasonZh:
        `**未达到收敛目标**：BR gap 之和 ${gap.toFixed(6)} ≥ 目标 ${target}` +
        `${stopReason === '' ? '（求解器未给停止原因）' : `（停止原因 ${stopReason}）`} —— ` +
        '频率是未收敛快照，不能当作均衡使用',
    };
  }

  return {
    admitted: true,
    verdictZh:
      `已通过准入：BR gap ${gap.toFixed(6)} < 目标 ${target}` +
      `${stopReason === '' ? '（求解器未给停止原因，但 gap 已达标）' : `（停止原因 ${stopReason}）`}`,
  };
}

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
 *
 * 🔴 **2026-09-22 补上的那道闸**：上面那些校验全是**结构性**的
 * （「这份数据说的是不是这个节点」），**没有一条**问「它收敛了吗」。
 * 于是没收敛的快照与收敛的结果走同一条路进决策。
 * 现在两者都先过 `admitSolverBaseline`（冷求解与缓存**共用同一个函数**，
 * 不新建第二条入口）。
 */
export function priorFromCachedBaseline(
  action: OpponentPreflopAction,
  baseline: GtoBaseline,
): SolverRangePrior {
  const range = baseline.range;

  /* ---- 准入门槛：未收敛 / 质量未知一律不得驱动范围 ---- */
  const admission = admitSolverBaseline(baseline);
  if (!admission.admitted) {
    return {
      ok: false,
      reasonZh:
        `求解器数据未通过**准入**（${admission.kind}）：${admission.reasonZh}。` +
        '该快照仍保留在缓存中供诊断查看，但**不参与本次建议**，本次回落启发式先验',
    };
  }

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
    /* 🔴 准入结论与目标一起带上 —— 页面才能说明「这个 gap 算不算达标」 */
    targetGap: baseline.metadata.solveSettings.targetGap,
    admitVerdictZh: admission.verdictZh,
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
