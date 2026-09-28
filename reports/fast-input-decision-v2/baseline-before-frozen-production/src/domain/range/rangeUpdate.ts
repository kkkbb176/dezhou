/**
 * 贝叶斯范围更新（规范第二 / 二十一 / 二十三 / 二十四 / 四十九节）
 *
 * 核心公式：
 *   posterior_rawWeight = prior_probability × action_likelihood
 *   然后归一化
 *
 * ## 为什么用「先验概率」而不是「先验权重」相乘
 *
 * 规范第二十三节写的是 `posteriorRawWeight = priorProbability × actionLikelihood`。
 * 这是**唯一正确**的形式：
 * - 若用 rawWeight 相乘，则「AA 权重 1.0、KK 权重 1.0、QQ 权重 0.5」这种
 *   相对频率表达会在连乘中不断放大绝对尺度，使权重迅速溢出或下溢；
 * - 更严重的是，若上游把权重整体放大 10 倍，后验会跟着变，而**概率分布其实没变** ——
 *   这违反「先验等价则后验等价」的基本要求。
 * 用归一化后的 prior probability 相乘，则 prior 的绝对尺度不影响后验，只影响相对形状。
 *
 * ## 为什么 likelihood 必须落在 0..1
 *
 * likelihood 是条件概率 P(动作 | 手牌)，不是「分数」也不是「权重」。
 * 允许 >1 会让「某个动作的似然」失去概率含义，进而使 Σ P(动作) 无法校验（规范第二十五节）。
 * 因此越界一律拒绝，不静默截断。
 *
 * ## 方向性（规范第四十九节，高危 Bug 区）
 *
 * 若某手牌**很少**做这个动作（likelihood 低），它的后验概率**必须下降**。
 * 反向测试（Fold 之后 72o 概率上升）是必测项 —— 写反是整个引擎最危险的错误之一。
 */

import type { Range } from './range.types.ts';
import {
  RangeErrorCode,
  RangeSource,
  rangeFailure,
  type ActionLikelihood,
  type ActionModel,
  type RangeAdjustmentProvider,
  type RangeOutcome,
  type RangeUpdateContext,
  type RangeUpdateLog,
} from './range.types.ts';
import { EPSILON } from './range.types.ts';
import { freezeRangeFromPairs } from './range.ts';
import { forEachChunkAbortable, isBlocked, deadCardsFrom, RANGE_CHUNK_SIZE } from './rangeBlockers.ts';
import { normalizeWeights, validateUnitInterval } from './rangeNormalize.ts';
import { normalizeLogWeights } from './rangeLogSpace.ts';
import { diffRanges } from './rangeMetrics.ts';
import type { RangeClock } from './range.types.ts';
import { UNBOUNDED_CLOCK } from './range.types.ts';

/* ============================================================
 * 动作模型校验
 * ============================================================ */

export type ActionModelIssue = {
  comboId: string;
  problem: string;
};

/**
 * 统一容差直接使用 range.types.ts 的 EPSILON ——
 * 规范第九节要求「不要每个模块自己定义 epsilon」，
 * 因此这里既不重新定义也不重新导出，避免出现两个来源。
 */

/**
 * 校验动作模型。
 *
 * 检查项（规范第二十四 / 二十五 / 三十九节）：
 * - likelihood 必须 finite 且 0 ≤ likelihood ≤ 1
 * - confidence 必须 0..1
 * - comboId 必须存在于先验范围里（否则这个 likelihood 无处安放）
 * - 同一 combo 在同一节点上**不允许重复声明同一动作**
 */
export function validateActionModel(model: ActionModel, prior?: Range): ActionModelIssue[] {
  const issues: ActionModelIssue[] = [];
  const seen = new Set<string>();

  for (const item of model.likelihoods) {
    const likelihoodProblem = validateUnitInterval(item.likelihood, 'likelihood');
    if (likelihoodProblem) {
      issues.push({ comboId: item.comboId, problem: likelihoodProblem });
    }
    const confidenceProblem = validateUnitInterval(item.confidence, 'confidence');
    if (confidenceProblem) {
      issues.push({ comboId: item.comboId, problem: confidenceProblem });
    }
    const key = `${item.comboId}|${item.action}`;
    if (seen.has(key)) {
      issues.push({ comboId: item.comboId, problem: `同一 combo 重复声明动作 ${item.action}` });
    }
    seen.add(key);
    if (prior && !prior.indexById.has(item.comboId)) {
      issues.push({
        comboId: item.comboId,
        problem: '该组合不在先验范围内（可能是被阻断或拼写错误）',
      });
    }
  }

  return issues;
}

/**
 * 判断动作模型是否完整（规范第二十五节）。
 *
 * 完整 = 每个 combo 的 Σ P(动作) ≈ 1。
 * 不完整**必须显式标注** `PARTIAL_ACTION_MODEL`，不能假装完整。
 *
 * ⚠️ 本函数只看「已声明的 combo 内部是否自洽」。
 * 「是否覆盖了先验里的全部组合」由 `assessCoverage` 负责 —— 两者是不同的问题，
 * 红队审计发现旧版只做了前者，于是**只覆盖 3/18 个组合也会被报成 complete=true**。
 */
export function checkActionModelCompleteness(model: ActionModel, epsilon = EPSILON): {
  complete: boolean;
  incompleteCombos: Array<{ comboId: string; sum: number }>;
} {
  const sums = new Map<string, number>();
  for (const item of model.likelihoods) {
    sums.set(item.comboId, (sums.get(item.comboId) ?? 0) + item.likelihood);
  }
  const incompleteCombos: Array<{ comboId: string; sum: number }> = [];
  for (const [comboId, sum] of sums) {
    if (Math.abs(sum - 1) > epsilon) incompleteCombos.push({ comboId, sum });
  }
  return { complete: incompleteCombos.length === 0, incompleteCombos };
}

export type CoverageAssessment = {
  /** 先验中出现的组合总数 */
  priorSize: number;
  /** 模型显式声明了似然的组合数 */
  declaredCount: number;
  /** 先验里未被声明、因而被当作似然 0 的组合 */
  undeclaredCombos: string[];
  /** 未声明占比 */
  undeclaredRatio: number;
  /** 是否覆盖了全部先验组合 */
  fullyCovered: boolean;
};

/**
 * 评估动作模型对**先验范围**的覆盖度（红队审计 MAJOR-2 的修复）。
 *
 * 为什么必须有这个检查：未被声明的组合会被当作似然 0，
 * 于是后验里它们的概率归零、supportSize 可能骤降（例如 18 → 3），
 * 而旧版实现对此**完全静默**，还会把模型报成 `complete=true`。
 *
 * 这未必是错误（「对手不可能以此手牌做该动作」是合法的），
 * 但**必须是显式的**：调用方要么补全模型，要么接受 supportSize 收缩的后果。
 */
export function assessCoverage(model: ActionModel, prior: Range): CoverageAssessment {
  const declared = new Set<string>();
  for (const item of model.likelihoods) declared.add(item.comboId);

  const undeclaredCombos: string[] = [];
  for (const entry of prior.entries) {
    if (!declared.has(entry.combo.canonicalId)) undeclaredCombos.push(entry.combo.canonicalId);
  }

  const priorSize = prior.entries.length;
  return {
    priorSize,
    declaredCount: declared.size,
    undeclaredCombos,
    undeclaredRatio: priorSize === 0 ? 0 : undeclaredCombos.length / priorSize,
    fullyCovered: undeclaredCombos.length === 0,
  };
}

/* ============================================================
 * 更新
 * ============================================================ */

export type UpdateRangeOptions = {
  /** 时间预算（规范第三十三节）。未提供时视为无时间约束。 */
  clock?: RangeClock;
  /** 每个组合的预计处理成本（毫秒），用于分块中止判定 */
  estimatedComboCostMs?: number;
  /** 是否生成 diff 摘要（默认生成；大范围时可关闭以省时间） */
  withDiff?: boolean;
  /** diff 摘要中 top 列表的长度 */
  diffTopN?: number;
  /**
   * 本街新增的死牌（红队审计 MAJOR-3 的修复）。
   *
   * 规范第十一节规定的顺序是
   * 「Prior → 移除 Impossible Combos → 重新归一化 → 应用 likelihood → 归一化」。
   * 旧版 `updateRange` **没有死牌入口**，于是拿翻牌前先验做翻牌更新时，
   * 结果里会残留与翻牌冲突的组合（实测 144 个），却报告 `removedByBlockers = 0`。
   */
  deadCards?: unknown;
  /** 是否在模型未覆盖全部先验组合时报错（默认 false，仅在结果里如实标注） */
  requireFullCoverage?: boolean;
  /**
   * 外部范围调整提供者（规范第二十六节的接口，Step 6/6.5 首次真正接入）。
   *
   * 玩家画像与牌局环境都**只能**通过它影响 combo 权重与动作似然，
   * 绝不直接产生动作（规范第二十节的禁令）。
   *
   * ## 应用顺序（刻意）
   *
   * 1. **先施加似然调整**（`adjustActionLikelihood`）：
   *    我们**知道**对手做了这个动作，因此「他做这个动作时更可能是哪种牌」
   *    必须先被修正。
   * 2. **再施加权重调整**（`adjustComboWeight`）：
   *    这是与动作无关的**先验层**修正（例如「这个人整体偏松」）。
   *
   * 顺序反了不会改变乘法的最终数值（都是乘性因子），
   * 但会影响日志里「哪一步造成的收缩更大」的可读性 ——
   * 因此固定顺序并在日志中分别计数。
   */
  adjustmentProvider?: RangeAdjustmentProvider;
  /** 提供者的行为选项（未提供时用默认值） */
  providerOptions?: { ignoreZeroFactor?: boolean };
};

export type ProviderApplicationLog = {
  providerId: string;
  /** 被**实际改变**的动作似然条数（因子 ≠ 1 才计数） */
  likelihoodAdjustments: number;
  /** 被**实际改变**的 combo 权重条数（因子 ≠ 1 才计数） */
  weightAdjustments: number;
  /** 被调用过的动作似然条数（含因子为 1 的） */
  likelihoodCalls: number;
  /** 被调用过的 combo 权重条数（含因子为 1 的） */
  weightCalls: number;
  /** 因为因子为 0 而被移除的组合数（因似然调整导致） */
  removedByLikelihoodZero: number;
  /** 因为因子为 0 而被移除的组合数（因权重调整导致） */
  removedByWeightZero: number;
  /** 因子是否全部在合法范围（> 0 且有限） */
  factorsValid: boolean;
  /** 触犯非法因子的最小/最大示例（诊断用） */
  invalidSamples: Array<{ comboId: string; factor: number; stage: 'likelihood' | 'weight' }>;
};

export type UpdateRangeResult = {
  range: Range;
  log: RangeUpdateLog;
  /** 动作模型自身是否自洽（每个已声明 combo 的 Σ P(动作) ≈ 1） */
  modelCompleteness: { complete: boolean; incompleteCombos: Array<{ comboId: string; sum: number }> };
  /** 模型对先验范围的覆盖度（未覆盖的组合会被当作似然 0） */
  coverage: CoverageAssessment;
  /** 本次更新移除的冲突组合数（死牌 + 似然为零 分开计数） */
  removals: { byDeadCards: number; byZeroLikelihood: number };
  /** 外部调整提供者的应用情况（未提供时为 null） */
  provider: ProviderApplicationLog | null;
};

/**
 * 用动作模型更新范围。
 *
 * `prior` **绝不会被修改**（规范第四十一节）：返回全新的 Range 对象。
 *
 * 执行顺序严格遵守规范第十一节：
 *   1. 校验 likelihood
 *   2. 移除与本街死牌冲突的组合（若提供 deadCards）
 *   3. 计算 posterior_rawWeight = prior_probability × likelihood
 *   4. 归一化
 *
 * 失败情形：
 * - 时间预算耗尽 → `RANGE_DEADLINE_EXCEEDED`（**不返回部分范围**）
 * - 全部 likelihood 为 0（或全被死牌移除）→ `RANGE_COLLAPSE`
 * - likelihood 越界 → `RANGE_VALIDATION_FAILED`
 * - 模型未覆盖全部组合且要求全覆盖 → `RANGE_PARTIAL_ACTION_MODEL`
 */
export function updateRange(
  prior: Range,
  model: ActionModel,
  updateContext: RangeUpdateContext,
  options: UpdateRangeOptions = {},
): RangeOutcome<UpdateRangeResult> {
  const startedAt = Date.now();
  const clock = options.clock ?? UNBOUNDED_CLOCK;
  const estimatedCost = options.estimatedComboCostMs ?? 0.002;

  // ---- 1. 校验（越界一律拒绝，不静默截断）----
  const issues = validateActionModel(model, prior);
  if (issues.length > 0) {
    const first = issues[0]!;
    return rangeFailure(RangeErrorCode.RANGE_VALIDATION_FAILED, {
      comboId: first.comboId,
      problem: first.problem,
      issueCount: issues.length,
    });
  }

  // ---- 1b. 覆盖度检查（红队 MAJOR-2：未覆盖的组合会被静默当作似然 0）----
  const coverage = assessCoverage(model, prior);
  if (options.requireFullCoverage && !coverage.fullyCovered) {
    return rangeFailure(RangeErrorCode.RANGE_PARTIAL_ACTION_MODEL, {
      priorSize: coverage.priorSize,
      declaredCount: coverage.declaredCount,
      undeclaredCount: coverage.undeclaredCombos.length,
      sample: coverage.undeclaredCombos.slice(0, 5).join(','),
    });
  }

  // ---- 1c. 死牌（本街新出现的公共牌 / 已知对手牌）----
  const dead = options.deadCards === undefined ? new Set<number>() : deadCardsFrom(options.deadCards);

  // 从调用方 context 取出局部量（后面构造 provider 上下文时复用）
  const contextStreet = updateContext.street;
  const contextAction = updateContext.action;
  const contextActor = updateContext.actor;
  const contextActionIndex = updateContext.actionIndex;
  const contextActivePlayers = updateContext.activePlayerCount;
  const contextPotSize = updateContext.potSize;
  const contextBetSize = updateContext.betSize;
  /** 与调用方传入的 context 完全等价的规范副本（供 provider 使用） */
  const context: RangeUpdateContext = {
    street: contextStreet,
    action: contextAction,
    actor: contextActor,
    actionIndex: contextActionIndex,
    activePlayerCount: contextActivePlayers,
    ...(contextPotSize !== undefined ? { potSize: contextPotSize } : {}),
    ...(contextBetSize !== undefined ? { betSize: contextBetSize } : {}),
  };

  // ---- 2. 建立 likelihood 查找表 ----
  const likelihoodByCombo = new Map<string, number>();
  for (const item of model.likelihoods) {
    likelihoodByCombo.set(item.comboId, item.likelihood);
  }

  /* ---- 2b. 外部调整提供者（画像 / 环境）----------------------------
   *
   * 规范第二十节：画像与**环境**都绝不直接决策，只能通过
   * `RangeAdjustmentProvider` 改 combo 权重与动作似然。
   * 本节是这条禁令第一次真正落地。
   *
   * 三条纪律：
   * 1. `likelihood` 的 action 字段**必须**与本次动作一致 —— 否则我们在用
   *    「他过牌的概率」去更新「他加注」的后验，属于语义错误。
   * 2. 因子必须有限且 > 0。非有限 / 非正因子会被**跳过并计入日志**，
   *    绝不当成 0 静默剔除组合（那正是「静默修复坏数据」）。
   * 3. 因子为 0 是**显式**语义（「该组合不可能做这个动作」），
   *    与「似然为 0」合并计数，不混入 blocker 计数。
   * ------------------------------------------------------------------ */
  const provider = options.adjustmentProvider;
  const ignoreZeroFactor = options.providerOptions?.ignoreZeroFactor ?? false;
  const providerLog: ProviderApplicationLog | null = provider
    ? {
        providerId: provider.providerId,
        likelihoodAdjustments: 0,
        weightAdjustments: 0,
        likelihoodCalls: 0,
        weightCalls: 0,
        removedByLikelihoodZero: 0,
        removedByWeightZero: 0,
        factorsValid: true,
        invalidSamples: [],
      }
    : null;

  /** 求一个合法因子；非法时返回 null 并记入日志（绝不静默当成 0 或 1） */
  const resolveFactor = (
    raw: number,
    comboId: string,
    stage: 'likelihood' | 'weight',
  ): number | null => {
    if (!providerLog) return 1;
    if (Number.isFinite(raw) && raw > 0) return raw;
    // raw === 0 是合法的显式语义（不是「非法」）：调用方明确说该组合不可能
    if (raw === 0 && !ignoreZeroFactor) return 0;
    providerLog.factorsValid = false;
    if (providerLog.invalidSamples.length < 5) {
      providerLog.invalidSamples.push({ comboId, factor: raw, stage });
    }
    // 非法因子 → 不做调整（因子 1），并如实记录
    return ignoreZeroFactor ? 1 : null;
  };

  // ---- 3. 逐条计算 log(posterior) = log(prior_probability) + log(likelihood) ----
  //      分块处理以便被时间预算中断（规范第三十五节）。
  //      **全程保持对数域**，绝不 exp 回线性域（见下方说明）。
  const logWeights: Array<{ combo: Range['entries'][number]['combo']; logWeight: number }> = [];
  let byDeadCards = 0;
  let byZeroLikelihood = 0;

  const abort = forEachChunkAbortable(
    prior.entries,
    clock,
    estimatedCost * RANGE_CHUNK_SIZE,
    (entry) => {
      // ---- 3a. 先移除与本街死牌冲突的组合（规范第十一节的顺序）----
      if (dead.size > 0 && isBlocked(entry.combo, dead)) {
        byDeadCards++;
        return;
      }

      const baseLikelihood = likelihoodByCombo.get(entry.combo.canonicalId);
      // 未声明该 combo 的 likelihood → 视为 0（对手不可能以此手牌做该动作）。
      // 这不是「静默填 0」，而是贝叶斯更新的定义；但**必须分开计数**，
      // 否则 diff 摘要会把「似然为零」误报成「被 blocker 移除」
      // （红队审计 MAJOR-2 发现的 removedByBlockers 语义错误）。
      if (baseLikelihood === undefined || baseLikelihood === 0) {
        byZeroLikelihood++;
        return;
      }

      let likelihood = baseLikelihood;

      // ---- 3b. 动作似然调整（画像 + 环境）----
      if (provider?.adjustActionLikelihood && providerLog) {
        const factor = provider.adjustActionLikelihood(
          {
            comboId: entry.combo.canonicalId,
            action: context.action,
            likelihood: baseLikelihood,
            source: entry.source,
            confidence: entry.confidence,
          },
          context,
        );
        providerLog.likelihoodCalls++;
        const resolved = resolveFactor(factor, entry.combo.canonicalId, 'likelihood');
        if (resolved === null) {
          // 非法因子：不做调整，继续（绝不把组合静默剔除）
        } else if (resolved === 0) {
          providerLog.removedByLikelihoodZero++;
          return;
        } else {
          likelihood = baseLikelihood * resolved;
          // 只有**真的改变了**才计入「调整条数」——
          // 恒等因子记成「已调整」会让日志谎报影响范围。
          if (Math.abs(resolved - 1) > 1e-15) providerLog.likelihoodAdjustments++;
        }
      }

      // 调整后必须重新落在 0..1（似然是条件概率，规范第二十三节）
      if (!(likelihood > 0) || !Number.isFinite(likelihood)) {
        if (providerLog) providerLog.invalidSamples.push({
          comboId: entry.combo.canonicalId,
          factor: likelihood,
          stage: 'likelihood',
        });
        byZeroLikelihood++;
        return;
      }
      if (likelihood > 1) likelihood = 1;

      // ---- 3c. combo 权重调整（与动作无关的先验层修正）----
      let weightFactor = 1;
      if (provider?.adjustComboWeight && providerLog) {
        const factor = provider.adjustComboWeight(entry.combo, context);
        providerLog.weightCalls++;
        const resolved = resolveFactor(factor, entry.combo.canonicalId, 'weight');
        if (resolved === null) {
          // 非法因子：不做调整
        } else if (resolved === 0) {
          providerLog.removedByWeightZero++;
          return;
        } else {
          weightFactor = resolved;
          if (Math.abs(resolved - 1) > 1e-15) providerLog.weightAdjustments++;
        }
      }

      /**
       * 在**对数域**做乘法并**在对数域归一化**（规范第七节）。
       *
       * ## 为什么不能 exp 回线性域再归一化
       *
       * 旧版写法是 `Math.exp(log(prior) + log(likelihood))` 后再归一化，
       * 并声称「归一化是尺度不变的，所以 exp 是安全的」。
       * **这个断言是错的**（Step 5A.1 红队 MAJOR-1 用 BigInt 精确定点证明）：
       * 当 `p × likelihood < 2^-1075 ≈ 2.47e-324` 时 `Math.exp` 精确返回 0，
       * 组合被**静默剔除**，validateRange 依然返回 valid。
       * 复现：先验 {AA:1, KK:1e-24} + 均匀似然 1e-300
       *   → p(KK 类) 变成 0（真实值 1e-24，双精度完全可表示）。
       *
       * 也就是说：exp 之后「绝对尺度」再次变成致命因素，
       * 而它恰恰是这一版要消除的东西。
       *
       * ## 正确做法
       *
       * 全程保持对数域，由 `normalizeLogWeights`（Log-Sum-Exp / softmax）
       * 直接产出概率 —— 该路径对任意尺度的和都稳定，
       * 不存在「先下溢再归一化」的中间步骤。
       *
       * 这也是玩家模型 / 动态调整链接入的前提：
       * 那些调整同样是连乘因子，必须在同一对数域里相加。
       */
      logWeights.push({
        combo: entry.combo,
        logWeight:
          Math.log(entry.probability) + Math.log(likelihood) + Math.log(weightFactor),
      });
    },
  );

  if (abort !== null) {
    const snap = clock.snapshot();
    return rangeFailure(RangeErrorCode.RANGE_DEADLINE_EXCEEDED, {
      processedCombos: abort.processed,
      totalCombos: prior.entries.length,
      remainingMs: snap.remainingMs,
      elapsedMs: snap.elapsedMs,
      // 中止事件的审计信息（红队审计指出：旧版中止时根本不产生日志）
      action: context.action,
      actor: context.actor,
      street: context.street,
    });
  }

  // ---- 4. 归一化（**对数域** Log-Sum-Exp；全 -∞ 会触发 COLLAPSE）----
  const normalized = normalizeLogWeights(
    logWeights.map((p) => ({ comboId: p.combo.canonicalId, logWeight: p.logWeight })),
  );
  if (!normalized.ok) {
    if (normalized.code === RangeErrorCode.RANGE_COLLAPSE) {
      return rangeFailure(RangeErrorCode.RANGE_COLLAPSE, {
        ...normalized.params,
        action: context.action,
        actor: context.actor,
        street: context.street,
        note: '动作更新后所有组合权重归零 —— 该动作在当前范围下不可能发生',
      });
    }
    return normalized;
  }

  // ---- 5. 冻结出新范围 ----
  //
  // rawWeight 由「概率 × 原权重总和」还原，与旧行为保持一致（rawWeight 是
  // 相对权重、probability 是归一化概率，两者必须严格区分）。
  // 对数域路径不直接产出 weightSum，因此这里用概率的倒数关系还原：
  // 取一项概率反推会放大误差，故直接用 Σ=1 的关系保持 rawWeight 与
  // probability 同尺度 —— 即令 rawWeight = probability。
  // 这满足 rangeValidator 对两者的全部约束（rawWeight ≥ 0、有限、
  // probability 归一化），且不引入任何虚假数值。
  const finalPairs = logWeights.map((p, index) => ({
    combo: p.combo,
    rawWeight: normalized.value.probabilities[index]!,
  }));

  const built = freezeRangeFromPairs(finalPairs, model.provenance, {
    rangeIdPrefix: 'upd',
    previousRangeId: prior.rangeId,
    source: model.provenance.sourceType,
  });
  if (!built.ok) return built;

  // ---- 6. 生成可审计日志（规范第三十一 / 三十二节）----
  const completeness = checkActionModelCompleteness(model);
  const runtimeMs = Date.now() - startedAt;
  const baseSummary = {
    // 「被 blocker 移除」与「似然为零」必须分开报告（红队 MAJOR-2）
    removedByBlockers: byDeadCards,
    removedByZeroLikelihood: byZeroLikelihood,
    removedTotal: byDeadCards + byZeroLikelihood,
    supportSizeBefore: prior.metrics.supportSize,
    supportSizeAfter: built.value.metrics.supportSize,
    entropyBefore: prior.metrics.entropyBits,
    entropyAfter: built.value.metrics.entropyBits,
  };
  const diff =
    options.withDiff === false
      ? { topIncreases: [], topDecreases: [], ...baseSummary }
      : {
          ...diffRanges(prior, built.value, options.diffTopN ?? 5, { byDeadCards, byZeroLikelihood }),
          ...baseSummary,
        };

  const log: RangeUpdateLog = {
    previousRangeId: prior.rangeId,
    newRangeId: built.value.rangeId,
    street: context.street,
    action: context.action,
    actor: context.actor,
    context,
    beforeMetrics: prior.metrics,
    afterMetrics: built.value.metrics,
    source: model.provenance.sourceType,
    confidence: model.provenance.confidence,
    runtimeMs,
    summary: diff,
    aborted: false,
    abortReason: null,
  };

  return {
    ok: true,
    value: {
      range: built.value,
      log,
      modelCompleteness: completeness,
      coverage,
      removals: { byDeadCards, byZeroLikelihood },
      provider: providerLog,
    },
  };
}

/* ============================================================
 * 便捷构造：从「comboId → likelihood」建动作模型
 * ============================================================ */

export function makeActionModel(
  action: ActionLikelihood['action'],
  likelihoods: ReadonlyMap<string, number>,
  provenance: ActionModel['provenance'],
  options: { confidence?: number; source?: RangeSource; completenessNote?: string } = {},
): ActionModel {
  const list: ActionLikelihood[] = [];
  for (const [comboId, likelihood] of likelihoods) {
    list.push({
      comboId,
      action,
      likelihood,
      source: options.source ?? provenance.sourceType,
      confidence: options.confidence ?? provenance.confidence,
    });
  }
  const partial: ActionModel = {
    likelihoods: list,
    complete: true,
    provenance,
  };
  const completeness = checkActionModelCompleteness(partial);
  return {
    likelihoods: list,
    complete: completeness.complete,
    ...(options.completenessNote !== undefined
      ? { completenessNote: options.completenessNote }
      : !completeness.complete
        ? {
            completenessNote:
              `PARTIAL_ACTION_MODEL：${completeness.incompleteCombos.length} 个组合的动作频率之和 ≠ 1，` +
              '这是部分动作模型，不能当作完整策略使用',
          }
        : {}),
    provenance,
  };
}

export { EPSILON };
