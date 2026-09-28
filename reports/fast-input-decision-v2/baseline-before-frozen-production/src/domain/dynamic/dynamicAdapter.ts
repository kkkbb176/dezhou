/**
 * Dynamic → Range 的**数值适配层**（Step 7，规范第 38 节）
 *
 * ## 为什么必须单独隔离
 *
 * Dynamic 的输出是**方向**（`INCREASE` / `DECREASE`）与**置信度**，
 * 而 `RangeAdjustmentProvider` 要求**数值因子**。
 *
 * 这个转换会引入一个**没有任何统计依据的幅度**。
 * 若把它混在 Dynamic 里，就会让人误以为「这个 1.37 倍是算出来的」。
 *
 * 因此本文件：
 * 1. **独立存在**，名字就叫 adapter —— 一眼能看出这是转换层
 * 2. 每个输出都显式标注 `UNVERIFIED_MAGNITUDE`
 * 3. 幅度上限刻意保守（与 `MAX_ADJUSTMENT` 同源的量级）
 * 4. 幅度**随置信度缩放**：不确定时不调整，而不是「按比例小幅调整」
 *
 * ## 与知识层的关系
 *
 * 幅度**不是**可校准参数（没有数据来源），因此：
 * - 它**不进入** `strategy-rules.json`（那里只允许方向）
 * - 它**不进入** `gameEnvironment.ts` 的 adjustment（那里已标 legacy-only）
 * - 它只出现在这里，且被标记为未验证
 *
 * 未来若真实牌局数据支持校准，替换的是本文件的常量，
 * 而不是让 Dynamic 自己去猜幅度。
 */

import {
  AdjustmentDirection,
  DynamicAdjustmentTarget,
  type DynamicBehaviorSnapshot,
  type DynamicRangeAdjustment,
} from './dynamic.types.ts';

/**
 * 方向的幅度语义。
 *
 * ⚠️ **`UNVERIFIED_MAGNITUDE`** —— 这些数字**没有任何统计数据支撑**。
 * 它们只表达「方向明确时，调整幅度大致在这个量级」，
 * 且被刻意压得很小（远小于「把握很大」时应有的调整）。
 */
export const UNVERIFIED_MAGNITUDE = {
  /** 方向明确时的最大相对调整 */
  maxMagnitude: 0.25,
  /** 标注（必须出现在任何面向人的输出里） */
  label: 'UNVERIFIED_MAGNITUDE',
} as const;

export type AdaptedAdjustment = {
  target: DynamicAdjustmentTarget;
  /** **乘性因子**（1 = 不调整） */
  multiplier: number;
  /**
   * 净效应方向。
   *
   * ⚠️ 当同一 target 上出现**方向相反**的调整时，这里给的是**净效应**方向
   * （见 `conflicting`），而不是「第一条」的方向。
   */
  direction: AdjustmentDirection;
  /** 来源置信度（取各组中的最大值，**不累加** —— 置信度不是可以相加的量） */
  confidence: number;
  /**
   * 幅度来源标注。**永远是 `UNVERIFIED_MAGNITUDE`** ——
   * 除非将来有可验证来源，否则不该出现别的值。
   */
  magnitudeProvenance: typeof UNVERIFIED_MAGNITUDE.label;
  /**
   * 该 target 上是否同时存在**相反方向**的调整。
   *
   * 为 `true` 时 `multiplier` 会向 1 收敛（可能恰好为 1）。
   * 调用方**必须**把它显示出来 —— 否则使用者会把「两股力抵消」
   * 误读成「方向明确但幅度很小」。
   */
  conflicting: boolean;
  reasons: readonly string[];
  evidenceEventIds: readonly string[];
};

/**
 * 把方向 + 置信度转成乘性因子。
 *
 * ## 为什么幅度随置信度缩放
 *
 * 置信度低意味着「我们不确定他是否真的变了」。
 * 此时正确的做法是**不调整**，而不是「小幅调整」——
 * 后者会把噪声注入范围，而且方向可能是错的。
 *
 * 采用**线性缩放**而不是「低置信度也给一个固定小幅度」：
 * `multiplier = exp(±maxMagnitude × confidence)`
 *
 * 置信度 0 → 因子恰好为 1（**零调整**）。
 */
export function multiplierOf(
  direction: AdjustmentDirection,
  confidence: number,
): number {
  const clamped = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
  const signed = direction === AdjustmentDirection.INCREASE ? 1 : -1;
  return Math.exp(signed * UNVERIFIED_MAGNITUDE.maxMagnitude * clamped);
}

/**
 * 判定「净效应为零」的容差（对数域）。
 *
 * 两条等幅反向的调整在对数域累加后不会**恰好**是 0
 * （实测 `8.33e-17`），于是 `direction` 会报 `DECREASE`
 * 而 `Math.exp(netLog) === 1` —— 机器读的字段仍自相矛盾（独立红队 F13）。
 *
 * 取 `1e-9`：对应的因子偏差是 `1 ± 1e-9`，远小于任何有意义的调整幅度
 * （最小有意义的调整是 `exp(0.25 × 0.04) ≈ 1.01`）。
 */
export const MERGE_ZERO_TOLERANCE = 1e-9;

/**
 * 把快照里的方向性调整转成乘性因子。
 *
 * ## 同一目标上的多条调整如何合并
 *
 * 在**对数域分别累加**，再取净效应：
 *
 * ```
 * logInc = Σ log(factorOf(INCREASE, conf))      // ≥ 0（INCREASE 因子恒 > 1）
 * logDec = Σ log(factorOf(DECREASE, conf))      // ≤ 0（DECREASE 因子恒 < 1）
 * netLog = logInc + logDec                      // ⚠️ 相加，不是相减
 * multiplier = exp(netLog)
 * direction  = netLog > 0 ? INCREASE : DECREASE   （netLog 为 0 时无法表达，取 DECREASE）
 * ```
 *
 * ⚠️ **`logDec` 自身已带负号**，所以是 `+`。
 * 写成 `logInc − logDec` 会把「抵消」算成「叠加」：
 * 一次 `+0.21` 与一次 `−0.21` 会得到 `exp(0.425) ≈ 1.53` 的**放大**，
 * 方向完全相反。（这是本修复过程中实际犯过的错，已固化为回归测试。）
 *
 * ⚠️ **不能**「保留第一条的 direction，乘数却净乘」（红队修复 v1.1.0）。
 * 原先的写法在方向相反时会产生一个**不存在的信号**：
 * 例如 `+0.25 × 0.85` 与 `−0.25 × 0.85` 两条调整合并后
 * 因子恰好是 **1.000**（完全没有调整），却仍标着 `INCREASE`。
 * 使用者会把它读成「明确要加宽范围」，而系统实际什么都没说。
 * 这与 `dynamicAdapter` 自己的立场冲突：**不确定就不调整**。
 *
 * 现在方向取净效应，并用 `conflicting` 显式标出「方向冲突已抵消」。
 */
export function adaptAdjustments(
  snapshot: DynamicBehaviorSnapshot,
): AdaptedAdjustment[] {
  type Accumulator = {
    logInc: number;
    logDec: number;
    confidence: number;
    conflicting: boolean;
    reasons: string[];
    evidenceEventIds: readonly string[];
  };
  const byTarget = new Map<DynamicAdjustmentTarget, Accumulator>();

  for (const adjustment of snapshot.adjustments) {
    const logFactor = Math.log(multiplierOf(adjustment.direction, adjustment.confidence));
    const isIncrease = adjustment.direction === AdjustmentDirection.INCREASE;

    const acc = byTarget.get(adjustment.target);
    if (acc === undefined) {
      byTarget.set(adjustment.target, {
        logInc: isIncrease ? logFactor : 0,
        logDec: isIncrease ? 0 : logFactor,
        confidence: adjustment.confidence,
        conflicting: false,
        reasons: [...adjustment.reasons],
        evidenceEventIds: adjustment.evidenceEventIds,
      });
      continue;
    }

    // 置信度取**最大值**，不累加 —— 置信度不是可加量
    acc.confidence = Math.max(acc.confidence, adjustment.confidence);
    acc.reasons.push(...adjustment.reasons);
    if (isIncrease ? acc.logDec !== 0 : acc.logInc !== 0) {
      acc.conflicting = true;
    }
    if (isIncrease) acc.logInc += logFactor;
    else acc.logDec += logFactor;
  }

  const adapted: AdaptedAdjustment[] = [];
  for (const [target, acc] of byTarget) {
    // `logDec` 自身已带负号 → 这里是**相加**
    const rawNetLog = acc.logInc + acc.logDec;
    // 浮点残留归零：否则会出现 `direction=DECREASE` 而 `multiplier === 1` 的矛盾字段
    const netLog = Math.abs(rawNetLog) <= MERGE_ZERO_TOLERANCE ? 0 : rawNetLog;
    adapted.push({
      target,
      // netLog 为 0 时**恰好**是 1（不是 0.9999999999999999）
      multiplier: netLog === 0 ? 1 : Math.exp(netLog),
      // `netLog === 0` 时两个方向都无法表达；取 DECREASE 是为了让
      // `multiplier`（恒为 1）成为唯一可信信息，而方向由 `conflicting` 提示不可用
      direction: netLog > 0 ? AdjustmentDirection.INCREASE : AdjustmentDirection.DECREASE,
      confidence: acc.confidence,
      magnitudeProvenance: UNVERIFIED_MAGNITUDE.label,
      conflicting: acc.conflicting,
      reasons: Object.freeze(acc.reasons),
      evidenceEventIds: acc.evidenceEventIds,
    });
  }

  // 稳定排序，保证输出确定性
  return adapted.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

/**
 * 检查一个适配结果是否**真的是**未验证幅度。
 *
 * 用途：测试与审计。若将来有人偷偷从「已验证来源」引入幅度，
 * 必须显式修改这个标注，而不是让它悄悄通过。
 */
export function isUnverifiedMagnitude(adjusted: AdaptedAdjustment): boolean {
  return adjusted.magnitudeProvenance === UNVERIFIED_MAGNITUDE.label;
}

/** 面向人的一行说明（必须交代幅度来源，以及方向是否已冲突抵消） */
export function describeAdaptation(adjusted: AdaptedAdjustment): string {
  const conflict = adjusted.conflicting ? '，方向冲突已抵消' : '';
  return `${adjusted.target} ${adjusted.direction}（因子 ${adjusted.multiplier.toFixed(3)}${conflict}，${adjusted.magnitudeProvenance}）`;
}
