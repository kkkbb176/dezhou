/**
 * 范围分布指标（V2 §二十三 / §二十七 / §二十八）
 *
 * ## 这个模块解决什么
 *
 * 「449 个原始组合」这句话**容易读成「449 手同等可信的牌」**，那是错的：
 * 后验范围是**加权的**，一个权重 0.001 的组合与权重 0.05 的组合在权益里的
 * 分量差 50 倍。本模块把「到底有多少手牌在真正起作用」变成**可计算的数**。
 *
 * ## 三个量的精确定义（报告必须照抄，不得含糊）
 *
 * ```text
 * rawSupportCombos     = 未与 Hero/公共牌重叠、且 prior > 0 的组合个数
 *                        （**原始支持集**，不含任何后验筛选）
 *
 * effectiveCombos      = (Σ p_i)² / Σ p_i²        ← 参与率 / 逆辛普森指数
 *                        p_i 为后验权重（已归一化）。等权时 = N；
 *                        一个组合独占时 → 1。它**不是**「组合数」，
 *                        而是「等权意义下等效起作用的组合数」。
 *
 * posteriorMassCombos(q) = 把组合按后验权重**降序**排列后，
 *                        累计质量首次 ≥ q 所需的最少组合数
 *                        （q = 0.90 / 0.95）。它回答「90% 的可能性集中在
 *                        多少手牌里」—— 这个数**远小于** rawSupportCombos
 *                        正是「不能把 449 当等权」的量化证据。
 * ```
 *
 * ## 纪律
 *
 * - 全部是**纯函数**：不读全局、不改入参、无随机（确定性审计的后继要求）。
 * - 输入为空或质量和非正时返回 `null`，**不编造 0**。
 */

/** 逆辛普森指数（参与率）：加权分布的「等效组合数」。 */
export function effectiveCombosOf(posteriorWeights: readonly number[]): number | null {
  let sum = 0;
  let sumSquares = 0;
  for (const w of posteriorWeights) {
    if (!(w > 0)) continue;
    sum += w;
    sumSquares += w * w;
  }
  if (!(sum > 0) || !(sumSquares > 0)) return null;
  // 先归一化（容忍调用方传进来的不是严格归一化的权重）
  return (sum * sum) / sumSquares;
}

/**
 * 达到给定后验质量所需的最少组合数（按权重降序累计）。
 *
 * @returns `null` 表示拿不到（无正权重或质量和非正）；否则为组合数（≥1）。
 */
export function posteriorMassCombosOf(
  posteriorWeights: readonly number[],
  targetMass: number,
): number | null {
  const positives = posteriorWeights.filter((w) => w > 0).slice().sort((a, b) => b - a);
  if (positives.length === 0) return null;
  const total = positives.reduce((acc, w) => acc + w, 0);
  if (!(total > 0)) return null;
  const target = Math.min(1, Math.max(0, targetMass)) * total;
  let acc = 0;
  for (let i = 0; i < positives.length; i += 1) {
    acc += positives[i]!;
    if (acc >= target) return i + 1;
  }
  return positives.length;
}

/** 两个后验分布之间的距离（要求按**同一顺序**对齐、且各自已归一化）。 */
export type RangeDistance = {
  /** 全变差距离 = ½ Σ|a_i − b_i|，0 = 完全相同，1 = 完全不重叠 */
  totalVariation: number;
  /** Jensen-Shannon 散度（log 底 2），∈ [0,1]，对称、有界、对 0 权重安全 */
  jsDivergence: number;
  /** 两侧都为正权重的组合数（重叠支持集大小） */
  sharedSupport: number;
};

const normalise = (w: readonly number[]): number[] => {
  const total = w.reduce((acc, x) => acc + (x > 0 ? x : 0), 0);
  if (!(total > 0)) return w.map(() => 0);
  return w.map((x) => (x > 0 ? x / total : 0));
};

const klBits = (p: readonly number[], q: readonly number[]): number => {
  let sum = 0;
  for (let i = 0; i < p.length; i += 1) {
    const pi = p[i]!;
    if (pi <= 0) continue;
    const qi = q[i]!;
    // q 为 0 而 p > 0 ⇒ 散度无穷；这里用极小下限保证有界且报告可用，
    // 并把这种情形留给 sharedSupport 去暴露（不静默）。
    sum += pi * Math.log2(pi / Math.max(qi, 1e-12));
  }
  return sum;
};

/**
 * §二十三 `profileRangeDistance`：两个画像下的后验范围有多不同。
 *
 * 🔴 返回的是**分布距离**，不是「某个数字抖了一下」：JS 散度 ∈ [0,1]，
 * 对称且有界，因此可以直接写进报告并与阈值比较（§二十二 允许记录、
 * 不要求达到某个幅度）。
 *
 * ## 🔴 口径标注：`CATEGORY_LEVEL_RANGE_DISTANCE`（= `RANGE_DISTANCE_PROXY`）
 *
 * 本函数对**任意对齐的向量**都成立，但**本仓库当前的唯一调用点**
 * （`test/profileQuantificationGolden.test.ts` 的 §二十三 断言）传进来的向量是
 * 由 `profileClassMasses` 聚合出的 **5 个互不重叠类别分量**：
 *
 * ```text
 * [ 坚果+强价值, 薄价值, 摊牌价值, 错过听牌, 纯空气 ]
 * ```
 *
 * ⇒ 因此它度量的是**类别级**分布差异，**不是** 1326 个具体组合的逐组合差异。
 * **同一类别内部的组合变化它看不见** —— 例如「错过同花听牌」与
 * 「错过卡顺」之间的重分配，只要类别总量不变，本函数输出**恒为 0**。
 *
 * ⚠️ V2 报告 §12 表格与 `profileMaterialityOf()` 的入参也叫 `rangeDistance`，
 * 但那是**装饰字段**（不参与判定），且黄金测试里传进去的其实是
 * `|ΔbluffMass|`、两个脚本传的是字面量 `0` —— **同名不同义，不得互相引用**。
 *
 * 逐组合距离需要把两侧 `Range.entries` 按 combo 对齐后再比；
 * 生产链路当前**没有**消费这个量（`src/` 内零消费者，只有测试用）。
 */
export function profileRangeDistance(
  a: readonly number[],
  b: readonly number[],
): RangeDistance | null {
  if (a.length !== b.length || a.length === 0) return null;
  const pa = normalise(a);
  const pb = normalise(b);
  let tv = 0;
  let shared = 0;
  for (let i = 0; i < pa.length; i += 1) {
    tv += Math.abs(pa[i]! - pb[i]!);
    if (pa[i]! > 0 && pb[i]! > 0) shared += 1;
  }
  const m = pa.map((x, i) => (x + pb[i]!) / 2);
  const jsd = 0.5 * klBits(pa, m) + 0.5 * klBits(pb, m);
  return Object.freeze({
    totalVariation: tv / 2,
    jsDivergence: jsd,
    sharedSupport: shared,
  });
}
