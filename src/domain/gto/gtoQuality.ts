/**
 * 求解质量等级（**质量 ≠ API 成功**）
 *
 * ## 这个模块解决什么
 *
 * Phase 1 只有一个含混的「成功」概念：求解器回了数据就算成功。
 * 但「求解器回了数据」与「这份数据收敛到可以当基线用」是**两件不同的事**：
 * 同一个接口，既可能返回一份跑满迭代上限、BR gap 还很远的快照，
 * 也可能返回一份真正收敛的策略。
 *
 * 因此这里把「拿到数据」与「数据能用」拆成两个维度：
 *
 * ```
 * 能不能拿到        → GtoLookupResult（成功 / GTO_BASELINE_UNAVAILABLE）
 * 拿到的东西多可信   → GtoQuality（本模块）
 * ```
 *
 * ## 🔴 等级不看单一数值，而是看**一组可核查的事实**
 *
 * | 输入 | 来源 | 为什么需要它 |
 * |---|---|---|
 * | `brGapTotal` | 求解器自述 | 策略离均衡多远（**只在同一棵树内可比**，见下） |
 * | `iterations` | 求解器自述 | 迭代 3 次与迭代 600 次的「done」不是一回事 |
 * | `stopReason` | 求解器自述 | `target_reached` 与 `iteration_limit` 是两种结束 |
 * | `learningSeats` | 我们有几条路径在学（本阶段恒为全员） | 冻结座位的 gap 是**出血**、永不收敛；全员学习时 gap 才有收敛含义 |
 * | `approximation` | 我们自己的标记 | 近似模型的结果**不可能**高于 APPROXIMATE |
 * | `stability` | 重复求解实测 | 同一场景重跑漂移大 ⇒ 结果不可依赖 |
 * | `actionCount` | 节点菜单 | 树的大小会影响 gap 的可达下限 |
 *
 * ## 🔴 为什么**不**用「gap < 0.01 ⇒ 高质量」这种全局阈值
 *
 * 已经实测证实：**不同动作树的 gap 不可横向比较**。
 *
 * | 配置 | 动作节点 | 10 次迭代后的 gap 之和 |
 * |---|---|---:|
 * | 6 人桌 · 2 分支树（Fold/Raise） | 1,272 | 0.015 |
 * | 6 人桌 · 3 分支树（含全下） | 2,538 | **0.998** |
 *
 * 同一张桌子，只是多了一条全下分支，gap 就差 60 倍。
 * 因此一条全局阈值必然会在某类树上判错。
 *
 * 本模块的做法是：
 * 1. **收敛等级只在同一棵树内用 gap 判断**（`treeId` 相同）；
 * 2. 跨树一律通过「事件」而非「数值」来降级（未收敛 / 迭代过少 / 漂移 / 模型近似）；
 * 3. 如果拿不到足够证据，**选择更低的等级** —— 这正是「宁可使用
 *    LOW_CONVERGENCE / APPROXIMATE / USABLE，也不使用 VERIFIED」的落地。
 */

import { GtoVerification, type GtoApproximationFlags } from './gto.types.ts';

/* ============================================================
 * 等级定义
 * ============================================================ */

/**
 * 求解质量等级（**有序**，数值越大越可信）。
 *
 * 与 `GtoVerification` 的关系：
 * - `GtoVerification` 是 Phase 1 的「来源可信度」五档，保留不动（有测试依赖它）；
 * - `GtoQuality` 是 Phase 1.1 的**运行质量**七档，信息量更大；
 * - 两者通过 `verificationForQuality()` 单向桥接（质量 → 可信度**上限**）。
 */
export const GtoQuality = {
  /** 连数据都没拿到（离线 / 超时 / 拒绝 / 坏数据） */
  UNAVAILABLE: 'UNAVAILABLE',
  /** 拿到了请求但求解失败 */
  FAILED: 'FAILED',
  /** 拿到了策略，但收敛程度明显不足（gap 大 / 迭代太少 / 未达目标） */
  LOW_CONVERGENCE: 'LOW_CONVERGENCE',
  /** 模型本身是近似的（GTOpen 翻前恒为此）——**这是天花板** */
  APPROXIMATE: 'APPROXIMATE',
  /** 收敛达标 + 重复求解稳定，可以正常使用 */
  USABLE: 'USABLE',
  /** 高置信：迭代替代充足、gap 达到目标、重复求解高度一致 */
  HIGH_CONFIDENCE: 'HIGH_CONFIDENCE',
  /** 被**第二个独立求解器**交叉验证过（本阶段不可能达到） */
  CROSS_CHECKED: 'CROSS_CHECKED',
} as const;
export type GtoQuality = (typeof GtoQuality)[keyof typeof GtoQuality];

/** 强弱顺序（数值越大越可信） */
export const GTO_QUALITY_RANK: Readonly<Record<GtoQuality, number>> = Object.freeze({
  UNAVAILABLE: 0,
  FAILED: 1,
  LOW_CONVERGENCE: 2,
  APPROXIMATE: 3,
  USABLE: 4,
  HIGH_CONFIDENCE: 5,
  CROSS_CHECKED: 6,
});

/** 中文显示名 */
export const GTO_QUALITY_ZH: Readonly<Record<GtoQuality, string>> = Object.freeze({
  UNAVAILABLE: '不可用',
  FAILED: '求解失败',
  LOW_CONVERGENCE: '低收敛',
  APPROXIMATE: '近似策略',
  USABLE: '可用',
  HIGH_CONFIDENCE: '高置信',
  CROSS_CHECKED: '已交叉验证',
});

/** 取两个等级里更保守的那个（用于「上限」封顶） */
export function minQuality(a: GtoQuality, b: GtoQuality): GtoQuality {
  return GTO_QUALITY_RANK[a] <= GTO_QUALITY_RANK[b] ? a : b;
}

/* ============================================================
 * 🔴 证据对象：评级只看这里面的字段
 * ============================================================ */

/** 重复求解稳定性（由 `scripts/gto-stability-probe.ts` 实测得到） */
export type GtoStabilityEvidence = {
  /** 独立求解次数（**必须 ≥ 2** 才算实测过） */
  runs: number;
  /** 169 类频率的最大绝对差 */
  maxAbsFrequencyDelta: number;
  /** 169 类频率的平均绝对差 */
  meanAbsFrequencyDelta: number;
  /** 动作菜单是否两次都一致 */
  actionMenuStable: boolean;
  /** 实测环境说明（机器 / 迭代数 / 是否干净重启），便于复核 */
  note: string;
};

/**
 * 评级所需的**全部**证据。
 *
 * ⚠️ 这个类型刻意**不接受** `scenario` / `baseline` 之类的复合对象：
 * 评级只应该看下面这几项事实，避免「顺手多看了某个字段」而让规则漂移。
 */
export type GtoQualityEvidence = {
  /** 是否拿到策略数据 */
  hasStrategy: boolean;
  /** 求解器是否报告失败 */
  solverFailed: boolean;
  /** BR gap 之和（求解器自述）；拿不到为 `null` */
  brGapTotal: number | null;
  /** 求解器侧的停止原因（`target_reached` / `iteration_limit` / `stopped` / …） */
  stopReason: string | null;
  /** 实际完成的迭代数 */
  iterations: number | null;
  /** 本次请求的迭代上限 */
  iterationsRequested: number | null;
  /** 本次请求的 gap 目标（0 = 不设目标，跑满迭代数就停） */
  targetGap: number | null;
  /** 仍在学习的座位数（冻结座位的 gap 是出血，不参与收敛判断） */
  learningSeats: number;
  /** 总座位数 */
  totalSeats: number;
  /**
   * 桌人数（= 	otalSeats）。
   *
   * ⚠️ 单独列出来是因为「迭代够不够」的下限**按桌型不同**
   * （9 人桌的预算是 12 次，4 人桌是 60 次）—— 用一个绝对阈值会错判。
   */
  tableSize: number;
  /** 近似标记 */
  approximation: GtoApproximationFlags;
  /** 动作菜单长度（树的分支数） */
  actionCount: number;
  /**
   * 重复求解稳定性证据。
   *
   * 🔴 `null` = **本轮没有实测过这个场景**。这会**阻止**等级升到
   * `HIGH_CONFIDENCE` —— 没有证据就不给高分，这是本模块最重要的一条纪律。
   */
  stability: GtoStabilityEvidence | null;
  /**
   * 树指纹：**只有树指纹相同的两份结果才可以比 gap**。
   *
   * 由「桌人数 + 有效筹码 + 动作菜单 + 加注上限 + 盲注结构」构成。
   * 两条 gap 只有在 `treeId` 相同时才参与同一个目标的判定。
   */
  treeId: string;
};

/** 评级结果 */
export type GtoQualityVerdict = {
  quality: GtoQuality;
  /** 中文一句话结论（界面直接显示） */
  summaryZh: string;
  /** 逐条理由（**每一条都对应一个具体事实**，不是套话） */
  reasonsZh: readonly string[];
  /** 阻止等级继续上升的原因（空 = 没有被卡住） */
  blockersZh: readonly string[];
};

/* ============================================================
 * 评级规则
 * ============================================================ */

/**
 * 每个桌型的**最少迭代数**（低于它 ⇒ 视为早期快照）。
 *
 * ## 🔴 为什么这次改成了「按桌型标定」而不是一个绝对数
 *
 * 第一版用了一个绝对阈值（20 次）。它立刻与自己的配置打架：
 * 9 人桌按 `GTOPEN_SIZE_PROFILES` 只跑 **12 次**迭代，但**达到了收敛目标**
 *（`stop_reason = target_reached`，gap 0.021 < 目标 0.05），
 * 于是被判成「迭代过少 → 早期快照」，等级卡在 `LOW_CONVERGENCE`。
 *
 * 那显然是错的：**求解器自己说它到了**，而我们的规则说它没到。
 *
 * ## 正确的判据是什么
 *
 * 「迭代够不够」有两个**独立**的信息源：
 *
 * | 信号 | 含义 | 可靠性 |
 * |---|---|---|
 * | `stop_reason === 'target_reached'` | **求解器自己说达到了收敛目标** | 高（求解器掌握完整状态） |
 * | 迭代数 ≥ 该桌型的预算 | 我们给了足够的机会 | 中（预算是我们定的） |
 *
 * 两者取**或**：任一成立就不算「早期快照」。
 * 但「未达标」本身仍然是一条 blocker（见 `gradeGtoQuality`），
 * 因此这不会让未收敛的结果蒙混过关。
 *
 * 这里的数字与 `GTOPEN_SIZE_PROFILES.iterations` **一致** ——
 * 也就是说「跑满了配置给它的预算」。未知桌型取最保守的 12。
 */
export const GTO_MIN_ITERATIONS_BY_TABLE_SIZE: Readonly<Record<number, number>> = Object.freeze({
  4: 60,
  5: 60,
  6: 40,
  8: 20,
  9: 12,
});

/** 未知桌型的兜底（最保守） */
export const GTO_MIN_ITERATIONS_FALLBACK = 12;

/** 取某桌型的最少迭代数 */
export function minIterationsFor(tableSize: number): number {
  return GTO_MIN_ITERATIONS_BY_TABLE_SIZE[tableSize] ?? GTO_MIN_ITERATIONS_FALLBACK;
}

/**
 * 「迭代充裕」（用于 `HIGH_CONFIDENCE`）的判据。
 *
 * ⚠️ 注意这不是一个**绝对**次数 —— 那样又会重复「9 人桌永远达不到」的错误。
 * 它要求：达到收敛目标 **且** 迭代数不低于该桌型预算的 **一半**。
 *
 * 为什么是「一半」：本机实测中，各桌型达到目标所需的迭代数都不超过预算，
 * 因此「≥ 预算一半」是一个宽松但仍有意义的下限
 *（它排除的是「迭代 2 次就说自己达标了」这种可疑情况）。
 */
export const GTO_HIGH_CONFIDENCE_MIN_BUDGET_FRACTION = 0.5;

/**
 * 兼容常量：**「20 次」这个绝对阈值已被废除**。
 *
 * 保留这个名字只为让旧调用点编译失败时能被看见 —— 见
 * `GTO_MIN_ITERATIONS_BY_TABLE_SIZE` 的注释（9 人桌的反例）。
 * 新代码不得使用它。
 */
export const GTO_MIN_ITERATIONS_FOR_USABLE = GTO_MIN_ITERATIONS_FALLBACK;

/**
 * 判定质量等级。
 *
 * ## 规则顺序（**先降级，后升级** —— 顺序本身就是设计）
 *
 * ```
 * 1. 没有数据            → UNAVAILABLE
 * 2. 求解器报错          → FAILED
 * 3. 模型近似            → 天花板 APPROXIMATE（GTOpen 翻前**恒**命中这条）
 * 4. 未达标 / 迭代太少 / 冻座位 / 无稳定性证据 / 漂移大 → 降到 LOW_CONVERGENCE
 * 5. 达标但迭代不算充裕   → APPROXIMATE
 * 6. 达标 + 稳定 + 迭代充裕 → HIGH_CONFIDENCE
 * 7. CROSS_CHECKED       → **永远不由本函数给出**（需要第二个求解器）
 * ```
 *
 * 第 3 步是关键：**近似模型是所有等级的天花板**。
 * 即使某天 GTOpen 的 gap 收敛到 0 且重复求解逐位一致，
 * 翻前结果也不会超过 `APPROXIMATE` —— 因为收敛的是那个近似模型内部的均衡。
 */
export function gradeGtoQuality(evidence: GtoQualityEvidence): GtoQualityVerdict {
  const reasons: string[] = [];
  const blockers: string[] = [];

  /* ---- 1. 没有数据 ---- */
  if (!evidence.hasStrategy) {
    return {
      quality: GtoQuality.UNAVAILABLE,
      summaryZh: '没有拿到可用的策略数据。',
      reasonsZh: Object.freeze(['求解器没有返回策略，或查询在拿到数据之前就失败了。']),
      blockersZh: Object.freeze(['缺少策略数据']),
    };
  }

  /* ---- 2. 求解失败 ---- */
  if (evidence.solverFailed) {
    return {
      quality: GtoQuality.FAILED,
      summaryZh: '求解器报告求解失败。',
      reasonsZh: Object.freeze(['求解器自述 state = error/failed。']),
      blockersZh: Object.freeze(['求解过程报错']),
    };
  }

  reasons.push(
    `求解器返回了真实策略：${evidence.iterations ?? '未知'} 次迭代，` +
      `停止原因 ${evidence.stopReason ?? '未知'}。`,
  );

  /* ---- 收敛判定的三个事实 ---- */
  const targetGap = evidence.targetGap ?? 0;
  const hasTarget = targetGap > 0;
  const gapKnown = evidence.brGapTotal !== null;
  const reachedTarget = hasTarget && gapKnown && evidence.brGapTotal! < targetGap;
  const stoppedByLimit = evidence.stopReason === 'iteration_limit';
  const iterations = evidence.iterations ?? 0;
  const minIterations = minIterationsFor(evidence.tableSize);
  /*
   * 「迭代够不够」= **求解器说达标了** 或 **跑满了配置给它的预算**。
   * 见 `GTO_MIN_ITERATIONS_BY_TABLE_SIZE` 的注释（9 人桌的反例）。
   */
  const claimedConverged = evidence.stopReason === 'target_reached';
  const ranFullBudget = iterations >= minIterations;
  const iterationsSufficient = claimedConverged || ranFullBudget;
  const allSeatsLearning = evidence.learningSeats === evidence.totalSeats;

  if (!hasTarget) {
    blockers.push(
      '本次没有设置收敛目标（target_gap = 0），求解器跑满迭代数即停 —— ' +
        '因此无法声称「已收敛」。',
    );
  } else if (!reachedTarget) {
    blockers.push(
      `未达到收敛目标：BR gap 之和 ${gapKnown ? evidence.brGapTotal!.toFixed(8) : '未知'} ` +
        `≥ 目标 ${targetGap}（${stoppedByLimit ? '被迭代上限截断' : `停止原因 ${evidence.stopReason ?? '未知'}`}）。`,
    );
  } else {
    reasons.push(
      `达到本次设定的收敛目标：BR gap 之和 ${evidence.brGapTotal!.toFixed(8)} < ${targetGap}。` +
        '⚠️ 这个目标只对**同一棵树**有意义（跨桌型/跨动作树的 gap 不可比）。',
    );
  }

  if (!iterationsSufficient) {
    blockers.push(
      `迭代仅 ${iterations} 次（${evidence.tableSize} 人桌的预算下限是 ${minIterations} 次，` +
        '且求解器没有声称达标）—— 策略处于早期快照状态。',
    );
  } else if (ranFullBudget && !claimedConverged) {
    reasons.push(`迭代 ${iterations} 次，已达到 ${evidence.tableSize} 人桌的预算下限 ${minIterations} 次。`);
  } else if (claimedConverged && iterations < minIterations) {
    reasons.push(
      `求解器声称达到收敛目标（${iterations} 次迭代，少于该桌型预算 ${minIterations} 次）—— ` +
        '**这不矛盾**：它提前停下来了，因为已经达标。',
    );
  }
  if (!allSeatsLearning) {
    blockers.push(
      `只有 ${evidence.learningSeats}/${evidence.totalSeats} 个座位在学习：` +
        '被冻结座位的 gap 是它的**出血**，永不收敛，会污染整体 gap 的含义。',
    );
  }

  /* ---- 稳定性 ---- */
  const stability = evidence.stability;
  if (stability === null) {
    blockers.push(
      '**没有实测过该场景的重复求解稳定性** —— 没有证据就不给高等级（这是刻意的）。',
    );
  } else if (stability.runs < 2) {
    blockers.push(`稳定性证据只有 ${stability.runs} 次独立求解（需要 ≥ 2 次）。`);
  } else if (!stability.actionMenuStable) {
    blockers.push('两次独立求解的**动作菜单不一致** —— 树都不同，结果不可比。');
  }

  const driftTooLarge =
    stability !== null &&
    stability.runs >= 2 &&
    (stability.maxAbsFrequencyDelta > GTO_STABILITY_MAX_ABS_DELTA);
  if (driftTooLarge) {
    blockers.push(
      `重复求解漂移过大：169 类频率的**最大绝对差** ${stability!.maxAbsFrequencyDelta.toFixed(4)} ` +
        `> 阈值 ${GTO_STABILITY_MAX_ABS_DELTA}（平均绝对差 ${stability!.meanAbsFrequencyDelta.toFixed(4)}）。` +
        '漂移大的结果不得标为高置信。',
    );
  } else if (stability !== null && stability.runs >= 2 && stability.actionMenuStable) {
    reasons.push(
      `${stability.runs} 次独立求解一致：最大绝对差 ${stability.maxAbsFrequencyDelta.toFixed(4)}、` +
        `平均绝对差 ${stability.meanAbsFrequencyDelta.toFixed(4)}（阈值 ${GTO_STABILITY_MAX_ABS_DELTA}）。`,
    );
  }

  /* ---- 4. 先算「运行质量」（不含模型近似这个天花板） ---- */
  const iterationsPlentiful =
    iterations >= Math.ceil(minIterations * GTO_HIGH_CONFIDENCE_MIN_BUDGET_FRACTION) &&
    iterations > 2;
  const runtimeQuality: GtoQuality =
    blockers.length > 0
      ? GtoQuality.LOW_CONVERGENCE
      : iterationsPlentiful
        ? GtoQuality.HIGH_CONFIDENCE
        : GtoQuality.USABLE;

  /* ---- 5. 再套模型天花板 ---- */
  let quality: GtoQuality = runtimeQuality;
  if (evidence.approximation.approximateModel) {
    quality = minQuality(quality, GtoQuality.APPROXIMATE);
    reasons.push(
      '🔴 求解器使用**近似延续模型**：它收敛的是建模后的收益，不是真实扑克。' +
        '因此本结果的等级**上限是「近似策略」**，无论收敛多好都不会更高。',
    );
    if (runtimeQuality === GtoQuality.HIGH_CONFIDENCE) {
      blockers.push(
        '运行质量达到「高置信」，但被近似模型封顶为「近似策略」' +
          '（这是 GTOpen 翻前的固有性质，不是本次求解的问题）。',
      );
    }
  }
  if (evidence.approximation.notConverged && quality === GtoQuality.USABLE) {
    quality = GtoQuality.LOW_CONVERGENCE;
    blockers.push('近似标记里 `notConverged = true`，因此不能标为「可用」。');
  }
  /*
   * `CROSS_CHECKED` 只可能由「两个独立求解器比对」给出。
   * 本函数**永不**产生它 —— 下面这段是防御性代码：如果将来有人改了上面的
   * 规则让它漏出来，这里会把它压回去并记一条 blocker，
   * 而不是让一个没做过交叉验证的结果顶着「已交叉验证」的标签上线。
   */
  if ((quality as string) === GtoQuality.CROSS_CHECKED) {
    quality = GtoQuality.HIGH_CONFIDENCE;
    blockers.push('交叉验证需要第二个独立求解器，本阶段不提供。');
  }

  return {
    quality,
    summaryZh: qualitySummaryZh(quality, evidence),
    reasonsZh: Object.freeze(reasons),
    blockersZh: Object.freeze(blockers),
  };
}

/**
 * 稳定性阈值：169 类频率的**最大绝对差**。
 *
 * ## 阈值是怎么来的（**实测**，不是拍脑袋）
 *
 * `scripts/gto-stability-probe.ts` 对 4MAX / 6MAX / 9MAX 各做 2 次
 * **重新建树 + 从迭代 0 求解**的独立求解，实测结果：
 *
 * | 桌人数 | 菜单一致 | 最大绝对差 | 平均绝对差 | gap A → gap B |
 * |---|---|---:|---:|---|
 * | 4 | 是 | **0.0000** | 0.00000 | 0.03412694 → 0.03412694 |
 * | 6 | 是 | **0.0000** | 0.00000 | 0.16526006 → 0.16526006 |
 * | 9 | 是 | **0.0000** | 0.00000 | 0.02102956 → 0.02102956 |
 *
 * 也就是说：**GTOpen 的翻前求解在实践中是逐位确定的**（BR gap 连
 * 小数点后 8 位都一致），169 类频率无一类差异超过 1%。
 * 这与源码使用 DCFR + 固定种子的实现相符。
 *
 * ## 那为什么阈值不是 0
 *
 * 因为「实测为 0」与「保证为 0」是两件事：
 * - 不同 CPU 架构 / 不同线程数下，并行归约的求和顺序可能不同；
 * - 求解器版本升级后实现可能变化；
 * - 上游从未承诺确定性。
 *
 * 因此阈值定在 **0.01**（= 实测 0 的 100 倍余量）：
 * 它宽松到不会把浮点求和顺序的差异误判为「不稳定」，
 * 又严格到能抓住任何**有决策意义**的漂移
 *（1 个百分点的频率差足以改变边缘决策；30 个百分点则完全不同）。
 *
 * ⚠️ 阈值调宽必须同时更新本节与
 * `reports/GTO_PHASE1_1_CONVERGENCE_AUDIT.md` —— 不允许为了「让结果稳定」
 * 而把阈值改到比实测漂移还松。
 */
export const GTO_STABILITY_MAX_ABS_DELTA = 0.01;

/*
 * ⚠️ 已删除：`GTO_MIN_ITERATIONS_FOR_HIGH_CONFIDENCE = 40`。
 *
 * 它是**绝对**阈值，与「9 人桌预算只有 12 次」直接冲突 ——
 * 9 人桌将永远无法达到「高置信」，无论它是否真的收敛。
 * 现在改用 `GTO_HIGH_CONFIDENCE_MIN_BUDGET_FRACTION`（按桌型预算的比例）。
 */

function qualitySummaryZh(quality: GtoQuality, evidence: GtoQualityEvidence): string {
  const gapText =
    evidence.brGapTotal === null ? 'BR gap 未知' : `BR gap 之和 ${evidence.brGapTotal.toFixed(6)}`;
  switch (quality) {
    case GtoQuality.LOW_CONVERGENCE:
      return `低收敛：${gapText}，迭代 ${evidence.iterations ?? '未知'} 次。频率是**未收敛快照**，不可当作均衡。`;
    case GtoQuality.APPROXIMATE:
      return `近似策略：${gapText}，但翻前使用近似延续模型，结果不是真实 GTO。`;
    case GtoQuality.USABLE:
      return `可用：${gapText}，已达到本次收敛目标且重复求解稳定；仍受近似模型限制。`;
    case GtoQuality.HIGH_CONFIDENCE:
      return `高置信：${gapText}，迭代充裕、重复求解一致。`;
    case GtoQuality.CROSS_CHECKED:
      return '已交叉验证（需要第二个独立求解器，本阶段不提供）。';
    case GtoQuality.FAILED:
      return '求解失败。';
    default:
      return '不可用。';
  }
}

/* ============================================================
 * 与 GtoVerification 的桥接
 * ============================================================ */

/**
 * 质量 → 可信度**上限**。
 *
 * `GtoVerification` 是 Phase 1 的字段（界面与既有测试在用），
 * 保留它，但**由质量等级推导**，避免两套并行口径漂移。
 *
 * ⚠️ `USABLE` / `HIGH_CONFIDENCE` 都映射到 `APPROXIMATE`：
 * 因为 GTOpen 翻前是近似模型，运行质量再高也到不了 `SOLVED`。
 * 唯一能产生 `SOLVED` 的情形是「精确模型 + 达标收敛」，
 * 而本阶段不存在精确模型 —— 这个映射如实反映了这一点。
 */
export function verificationForQuality(
  quality: GtoQuality,
  approximation: GtoApproximationFlags,
): GtoVerification {
  switch (quality) {
    case GtoQuality.UNAVAILABLE:
    case GtoQuality.FAILED:
      return GtoVerification.UNVERIFIED;
    case GtoQuality.LOW_CONVERGENCE:
      return GtoVerification.APPROXIMATE;
    case GtoQuality.APPROXIMATE:
      return GtoVerification.APPROXIMATE;
    case GtoQuality.USABLE:
    case GtoQuality.HIGH_CONFIDENCE:
      // 精确模型 + 达标 ⇒ 才能到 SOLVED；近似模型一律封顶 APPROXIMATE
      return approximation.approximateModel
        ? GtoVerification.APPROXIMATE
        : GtoVerification.SOLVED;
    case GtoQuality.CROSS_CHECKED:
      return approximation.approximateModel
        ? GtoVerification.APPROXIMATE
        : GtoVerification.CROSS_CHECKED;
    default:
      return GtoVerification.UNVERIFIED;
  }
}

/** 该等级是否**允许**在界面上作为「可参考的策略」展示 */
export function qualityIsDisplayable(quality: GtoQuality): boolean {
  return (
    quality === GtoQuality.APPROXIMATE ||
    quality === GtoQuality.USABLE ||
    quality === GtoQuality.HIGH_CONFIDENCE ||
    quality === GtoQuality.CROSS_CHECKED
  );
}

/**
 * 该等级的界面措辞。
 *
 * 🔴 低等级**必须**用「近似 / 质量有限」这类词，
 * 禁止出现「精确 GTO」「绝对 GTO」「最优答案」。有测试扫描这些词。
 */
export function qualityDisclaimerZh(quality: GtoQuality): string {
  switch (quality) {
    case GtoQuality.LOW_CONVERGENCE:
      return '⚠️ 低收敛：当前求解质量有限，频率是未收敛快照，不应作为均衡策略使用。';
    case GtoQuality.APPROXIMATE:
      // ⚠️ 措辞纪律：这一段里**不得**出现「精确 GTO」「绝对 GTO」「最优答案」，
      //    即使是否定句也不行 —— 界面上的一句否定句很容易被读成肯定句。
      //    有测试逐字扫描这几个词。
      return 'ℹ️ 近似策略：翻前使用近似延续模型（求解的是建模后的延续收益，不是完整的翻牌后博弈），' +
        '因此它不是真实理论解，也不应被当作判据使用。';
    case GtoQuality.USABLE:
      return 'ℹ️ 可用：已达到本次设定的收敛目标，且重复求解一致；但仍受近似延续模型限制。';
    case GtoQuality.HIGH_CONFIDENCE:
      return 'ℹ️ 高置信：迭代充裕、重复求解一致；仍受近似延续模型限制。';
    case GtoQuality.CROSS_CHECKED:
      return 'ℹ️ 已交叉验证（本阶段不提供）。';
    default:
      return '⚠️ 该结果不可用。';
  }
}

/** 自检（启动时调用） */
export function selfCheckQualityLayer(): string[] {
  const problems: string[] = [];
  const order: GtoQuality[] = [
    'UNAVAILABLE',
    'FAILED',
    'LOW_CONVERGENCE',
    'APPROXIMATE',
    'USABLE',
    'HIGH_CONFIDENCE',
    'CROSS_CHECKED',
  ];
  for (let i = 1; i < order.length; i++) {
    if (GTO_QUALITY_RANK[order[i]!] <= GTO_QUALITY_RANK[order[i - 1]!]) {
      problems.push(`质量等级顺序不一致：${order[i - 1]} 应低于 ${order[i]}`);
    }
  }
  // 近似模型必须封顶
  const capped = gradeGtoQuality({
    hasStrategy: true,
    solverFailed: false,
    brGapTotal: 0.0001,
    stopReason: 'target_reached',
    iterations: 500,
    iterationsRequested: 500,
    targetGap: 0.01,
    learningSeats: 6,
    totalSeats: 6,
    tableSize: 6,
    approximation: {
      approximateModel: true,
      notConverged: false,
      multiwayContinuation: false,
      compressedPrecision: false,
      fromCache: false,
      notes: [],
    },
    actionCount: 3,
    stability: {
      runs: 3,
      maxAbsFrequencyDelta: 0.001,
      meanAbsFrequencyDelta: 0.0002,
      actionMenuStable: true,
      note: 'self-check',
    },
    treeId: 'self-check',
  });
  if (capped.quality !== 'APPROXIMATE') {
    problems.push(`近似模型的结果应被封顶为 APPROXIMATE，实际 ${capped.quality}`);
  }
  // 没有稳定性证据不得升到 USABLE 以上
  const noEvidence = gradeGtoQuality({
    hasStrategy: true,
    solverFailed: false,
    brGapTotal: 0.0001,
    stopReason: 'target_reached',
    iterations: 500,
    iterationsRequested: 500,
    targetGap: 0.01,
    learningSeats: 6,
    totalSeats: 6,
    tableSize: 6,
    approximation: {
      approximateModel: true,
      notConverged: false,
      multiwayContinuation: false,
      compressedPrecision: false,
      fromCache: false,
      notes: [],
    },
    actionCount: 3,
    stability: null,
    treeId: 'self-check',
  });
  if (noEvidence.quality !== 'LOW_CONVERGENCE') {
    problems.push(`没有稳定性证据时应为 LOW_CONVERGENCE，实际 ${noEvidence.quality}`);
  }
  return problems;
}
