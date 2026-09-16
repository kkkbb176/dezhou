# 数值稳定性加固（Step 5A.1）红队审计报告

- **审计对象**：`src/domain/range/rangeLogSpace.ts`（新增）、`rangeNormalize.ts`、`rangeUpdate.ts`、`range.ts`、`rangeValidator.ts`、`range.types.ts`
- **审计立场**：证伪（falsify），不做背书
- **环境**：Node v24.19.0 / `node --experimental-strip-types`；TypeScript 通过 `node node_modules/typescript/bin/tsc --noEmit`
- **约束遵守**：未修改 `src/` 与 `test/` 下任何文件；全部实验脚本写在 `tmp-rt-num/` 并在审计结束后**已删除**

---

## 一、审计方法

1. **静态阅读**：逐行读 6 个目标文件（含 `range.types.ts` 全量、`rangeMetrics.ts`），记录真实行号；用 grep 全仓核对每个导出符号的调用方、以及是否有重复/竞争的 epsilon 定义。
2. **动态证伪**：编写 6 个一次性脚本（`a-logsumexp-scale` / `b-direction-metrics` / `c-endtoend` / `d-chains-boundary` / `e-boundary-reach` / `f-ref-fix`），从 `tmp-rt-num/` 以 `../src/...` 相对路径导入真实生产代码（非复制粘贴）。
3. **独立参照，避免"同式复算"**：
   - H1：用 `log1p` + Kahan 补偿求和的**独立**参照（并修正了参照自身对并列最大值的缺陷）复核 `logSumExp`；400k+ 随机 + 特例。
   - H7：用 `BigInt` 把 double 精确分解为 `m×2^e`，对 `prior×likelihood` 做**精确有理数比较**，再与引擎算术比较排序；配合 IEEE754 位级 `nextUp/nextDown` 构造相邻 ulp 的近似并列；另单独采样 400k 次检验 `Math.log` / `Math.exp` 的单调性。
   - H2/H3：用 `Number.MIN_VALUE`（5e-324）、`1e-320`、`1e308`、`Number.MAX_VALUE` 等边界因子扫描。
4. **端到端复现**：所有结论都在真实 `buildRangeFromRankClasses / buildRangeFromComboWeights / updateRange / validateRange` 路径上复现，而不是只调用内部函数。
5. **回归基线**（本次实测）：
   - `node --test --experimental-strip-types "test/**/*.test.ts"` → **tests 614 / suites 134 / pass 614 / fail 0**（≈21s）
   - `node node_modules/typescript/bin/tsc --noEmit` → **退出码 0，无输出（类型检查通过）**

---

## 二、逐项结论

### H1 `logSumExp` 正确性 —— **未能证伪（实现正确）**

- **假设**：`logSumExp` 在某些输入（单元素 / 全 -∞ / 全相等 / 量级悬殊 / NaN / +∞ / 空数组）下返回 NaN 或错误值。
- **结论**：**未能证伪**。所有测试输入均正确；与独立参照（`log1p`+Kahan）最大偏差 **0.973 ulp / 相对 2.16e-16**（400k+ 组）。
- **证据**（`rangeLogSpace.ts:60-77`）：
  - 空数组与全 -∞：`max` 保持 `-Infinity` → `:66` 返回 `LOG_ZERO`（不是 NaN）✔
  - 含 NaN：`:63` 立即返回 NaN（不静默吞掉）✔
  - 含 +∞：`:69` 返回 +∞（`[-Inf, +Inf] → +Inf`）；`[+Inf, NaN]` 返回 NaN —— 因为 `:63` 的 NaN 检查在同一循环内先命中，语义正确 ✔
  - 单元素 `[x]` → `x + log(1) = x` 精确 ✔
  - 全相等 n 项 → `max + log(n)`；`[0,0,0,0] → 1.3862943611198906 = log 4` 精确 ✔
  - 量级悬殊 `[700,-700,0] → 700`（次大项 `e^-1400` 正确并入舍入）✔
  - `[1e308,1e308] → 1e308`（真值 `1e308+0.693` 不可表示，属正确舍入）✔
  - `[-5e-324,-5e-324] → 0.6931471805599453` ✔
  - `sum += Math.exp(value - max)` 中 `sum ∈ [1,n]`，`:76` 的 `Math.log` 永不越界；`n ≤ 1326` 时不可能溢出。
- **最小复现**：`logSumExp([0, 0, 0, 0]) === Math.log(4)`；`logSumExp([]) === -Infinity`；`Number.isNaN(logSumExp([0, NaN]))`。
- **固有边界（非缺陷）**：当最大值与次大项在对数域相差 > 745 时，微小项在结果中彻底消失（`logSumExp([0,-745])` 返回 `0`，真值 `log(1+e^-745) ≈ 5e-324`）。误差是**绝对量级 1e-324**，对下游概率无任何可表示影响，属 IEEE754 固有。

### H2 `stableNormalize` 尺度不变性 —— **函数本身未能证伪；端到端路径被证伪（见 MAJOR-1）**

- **假设**：存在正缩放因子 c，使缩放后概率与未缩放不同（含 c = 5e-324 与 1e308）。
- **结论**：**对函数本身未能证伪**——凡缩放后输入仍是"同样的相对形状且非零"的 double，结果不变（偏差 ≤ 1~2 ulp）。所有观察到的"差异"都发生在**调用方乘法已经摧毁信息之后**，且失败是**显式报错**而非静默：
  - `[1,1,0.5]×5e-324` → 权重变成 `[5e-324, 5e-324, 0]`（第三项真值 2.5e-324 不可表示，乘法结果为**字面 0**）→ `sup=2/3, p=[.5,.5,0]`，即输入本身已不是原分布 → 属调用方固有下溢。
  - `[1e-12,1e-12,1e-12]×5e-324` / `×1e-320` → 三个权重都下溢为 0 → `RANGE_COLLAPSE`（输入确实全零，判定正确）。
  - `[3,1]×1e308` → `3e308 = Infinity` → `RANGE_VALIDATION_FAILED`（`rangeLogSpace.ts:122-128` 显式拒绝非有限权重，行为正确）。
  - `[1.5e-320,1e-320]×0.1` → 概率 `[0.6,0.4] → [0.6007905,0.3992095]`（相对形变 2e-3）：这是 **denormal 输入本身只有 ~3e-3 相对精度**造成的，不是归一化器的误差。
  - 正常量级：`×1e-300 … ×1e300` 全部 0 偏差；`[1,1e-2,1e-300]×1e-12` 相对偏差 1.5e-15。
- **代码依据**：`rangeLogSpace.ts:150-160` 先取 `shift = max` 再 `scaled = w/shift`；因 `w ≤ max`，`scaled ∈ [0,1]`，`total ∈ [1,n]`，所以"绝对尺度"在函数内部确实被彻底消掉。
- **真正被证伪的是更新链**：`rangeUpdate.ts:302-303` 在调用归一化**之前**做 `Math.exp(...)`，这一步决定了绝对尺度是否致命 → 见 **MAJOR-1**（同样"均匀似然"在 `1e-2` 与 `1e-321` 下给出完全不同的后验）。

### H3 `stableNormalize` 溢出 —— **部分确认（真实但潜伏）**

- **假设**：`rawWeightSum` 溢出为 Infinity 会破坏结果。
- **结论**：**确认溢出存在，但不会让概率算错**；它污染的是返回值中的诊断字段，并且在 `rangeUpdate.ts:341` 的写法下会放大成 Infinity（当前不可达）。归为 **MINOR-4**。
- **证据**：
  - `stableNormalize([{a:1.7e308},{b:1.7e308}])` → `ok=true, probabilities=[0.5,0.5], Σp=1`，但 **`rawWeightSum = Infinity`**（`:136` 直接累加，无溢出保护）。注释 `:87` 只声明"可能下溢为 0"，未声明可能上溢。
  - 概率计算不经过 `rawWeightSum`（`:156-177` 用 `shift`/`total`），因此概率正确。
  - **放大路径**：`rangeUpdate.ts:341` 的惯用式 `rawWeight: probabilities[index] * weightSum`，若 `weightSum = Infinity` 则得到 `rawWeight = Infinity`，随后 `freezeRangeFromPairs → stableNormalize` 会抛 `RANGE_VALIDATION_FAILED`。当前该路径**不可达**，因为更新链的 `posteriorRawWeight = p×L ≤ 1`（`:302-303`，`p ≤ 1`、`L ≤ 1`），`Σ ≤ n`。
  - 单个 `Infinity` 权重被显式拒绝（`:122-127`）。
- **最小复现**：`normalizeWeights([{comboId:'a',rawWeight:1.7e308},{comboId:'b',rawWeight:1.7e308}]).value.weightSum === Infinity`。

### H4 支持集：正权重是否可能得到概率 0 —— **确认（NEW-2 / NEW-3）**

- **假设**：严格正的权重可能概率恰为 0，且代码无法区分"真零"与"下溢零"。
- **结论**：**确认，两条机制都存在**；代码**不能**区分二者。这是**真实缺陷（MINOR）**，不是固有边界。
- **证据**：
  1. **报告的支持集 ≠ 实际非零概率个数**：`rangeLogSpace.ts:159` 的 `supportSize` 统计的是 `scaled > 0`，而概率是 `scaled/total`。
     `stableNormalize([1,1,5e-324])` → **`supportSize = 3`，但实际 `p>0` 只有 2 个**（`p=[0.5,0.5,0]`）；同一批数据 `probabilityMetrics(...).supportSize = 2` → 两个函数对同一输入给出**不同支持集**。
  2. **除法阶段直接丢失**：`stableNormalize([2, 5e-324])` → `scaled = 4.94e-324/2 = 2.47e-324 → 0`，`supportSize = 1`。此时输入 `rawWeight = 4.94e-324 > 0` 是**严格正**的，它是被 `w/shift` 这一除法吃掉、并**当作零项排除**的。
  3. **无法区分"真零/下溢零"**：`:310-312` 的 `isNumericallyZero` 实现就是 `probability === 0`，不含任何信息；`:315` 导出的 `DENORMAL_MIN` 在 `src/` 中**零引用**；`StableNormalizeResult`（`:83-93`）没有任何 underflow 标记。`:303-315` 的文档声称其用途是"报告支持集收缩时区分「真实的 0」与「浮点下溢的 0」"——**该能力未实现**，且 `isNumericallyZero` 在 `src/` 与 `test/` 中都没有调用者（死代码）。
- **最小复现**：见上两行；另见 H10(a) 的端到端版本（校验器同样不报错）。

### H5 `normalizeLogWeights` vs `stableNormalize` 等价性 —— **确认分歧；根因是"生产不用对数域"**

- **假设**：两者在远端尾部（-700 / -1000 / +700）会实质分歧。
- **结论**：**确认分歧确实存在**，且分歧方向上**对数域版本才是数学正确的那一方**；但分歧全部由"线性域输入已经下溢/上溢"造成，所以**不是两个函数谁算错了**，而是 **MAJOR-1 的根因**：更新链选了线性域那条路。
- **证据**（同一组对数权重，分别走两条路）：
  | 对数权重 | `normalizeLogWeights` | `stableNormalize(exp(·))` |
  |---|---|---|
  | `[-700,-1000]` | `p=[1, 5.148e-131]`，sup=2 | `p=[1, 0]`，**sup=1（丢支持）** |
  | `[-700,-1080]` | `p=[1, 9.292e-166]`，sup=2 | `p=[1, 0]`，sup=1 |
  | `[-700,-744]` | `p=[1, 7.781e-20]` | `p=[1, 1.002e-19]`（**相对差 29%**，因 `exp(-744)` 落在 denormal 区，相对精度只剩 ~0.5%~30%） |
  | `[700,1000]` | `p=[5.148e-131, 1]`，ok | **`RANGE_VALIDATION_FAILED`**（`exp(1000)=Infinity`） |
  | `[-3000,-2000]` | `p=[0,1]`，ok | **`RANGE_COLLAPSE`** |
- **关键补充**：`normalizeLogWeights / logSumExp / toLogWeight / fromLogWeight / multiplyLogWeights / isLogWeightValid / isNumericallyZero / DENORMAL_MIN` 在 `src/` 中**没有任何生产调用者**（grep 全仓：只有 `test/rangeNumericalStability.test.ts` 引用）。`rangeNormalize.ts:14` 只导入了 `stableNormalize`。也就是说：Step 5A.1 建好了正确的对数域工具，却没接到生产链路上。

### H6 `toLogWeight` / `fromLogWeight` 往返 —— **未能证伪**

- **假设**：存在正 double 无法在合理相对误差内往返（5e-324 / 1e-320 / 1e308 / MAX_VALUE）。
- **结论**：**未能证伪**。全部往返成功，最大相对误差 **2.8e-14**，且 `Number.MAX_VALUE` **不会**溢出成 Infinity。
- **证据**：
  - `5e-324 → log = -744.4400719213812 → 5e-324`（**误差 0**）；`1e-320`、`1e-310` 同样误差 0。
  - `2.2250738585072014e-308 → 误差 2.75e-14`；`1e-300 → 2.37e-14`；`1e-12 → 1.01e-15`；`1 → 0`。
  - `Number.MAX_VALUE → log = 709.782712893384 → 1.7976931348622732e308`（误差 2.365e-14，未溢出）。
- **固有边界**：往返相对误差 ≈ `ulp(log w)`，在 `w ~ 1e308` 时约 1.1e-13；且该量级下 `log` 不再单射（`MAX_VALUE` 与其下一个 double 映射到同一 log）。`rangeLogSpace.ts:279` 的注释只提"可能下溢为 0"，未提这一相对误差量级（文档小缺口）。

### H7 极端取值下的贝叶斯方向反转 —— **未能证伪**

- **假设**：纯粹因浮点误差，让更弱的手牌获得更高后验概率。
- **结论**：**未能证伪**。构造性搜索 0 次反转，且有单调性论证支撑。
- **证据**：
  - **精确参照搜索**：用 `BigInt` 精确定点比较 `p×L` 的真值排序，构造 `p2 ≤ p1` 且 `L2 ≤ L1`（至少一个严格更小）的 **355,598 组**样本（先验/似然跨 1e-300~1，含相邻 ulp 的近似并列）→ **方向反转 0 次**。
  - **1326 组合、相邻 ulp 先验**：200 轮 → 反转 0 次。
  - **libm 单调性**：`Math.log` 违例 0/200,006；`Math.exp` 违例 0/400,000（含 [-745,0] 的 denormal 边界区）。
  - **机理**：`rangeUpdate.ts:302-303` 的复合是 `log`（单调）→ 加法（单调）→ `exp`（单调）→ 再除以正的 `total`（单调），因而不可能把严格更小的真值翻到上面。能发生的只有"双方一起掉到 0"（信息丢失，即 MAJOR-1），不是反转。
- **注意区分**：这是"顺序不被反转"，**不等于**"数值无损"——MAJOR-1 证明的是取值会被静默归零。

### H8 更新链稳定性（500+ 次） —— **基本未能证伪；发现一个均匀似然的假坍塌**

- **假设**：500+ 次混合似然更新会出现 NaN/Infinity、静默支持集收缩、Σp 漂移、validator 失败。
- **结论**：
  - **无 NaN / 无 Infinity**；`Σp` 始终在 `1 ± 1e-15`（远小于文档容差 EPSILON = 1e-9，`:318-320`）；`validateRange` 全通过。
  - **均匀似然链（真·同一似然，600 次）**：`L ∈ {1e-2, 1e-8, 1e-12}` 支持集 **46→46 保持**，形状漂移 **0**，`Σp` 恒定 `0.9999999999999994`。**未证伪**。
  - **混合似然链**（AA=1e-2，其余=1e-300，600 次）：支持集在第 **2** 步从 46 掉到 6。经计算，该步弱组合的**真实**对数概率比已达 **-1372**，远低于双精度下限 `log(5e-324) = -744.4` → **真实概率在 double 中根本不可表示，属固有边界，不是缺陷**（`weak=1e-30` 时第 12 步收缩，真实 log 比 -773.7 < -744.4，同样吻合；`weak=1e-100` 第 4 步，-902.6）。
  - **唯一异常**：把**均匀**（=不含信息）似然整体压到 ≤ 3.28e-321 时出现**假坍塌**（全 1326 组合范围：`1e-320` 正常、`1e-321` → `RANGE_COLLAPSE`），后验本应恒等于先验 → 归入 **MAJOR-1(c)**。
- **复现要点**：`uniformRange()` + 每个 combo 同一似然，做 600 次 `updateRange`；同时打印 `metrics.supportSize / probabilitySum / validateRange().valid`。

### H9 熵 / 有效组合数 —— **引擎可达范围内未能证伪（1 处表象异常）**

- **假设**：`probabilityMetrics` 会返回 NaN / Infinity / 数学上错误的值（eff > support、负熵）。
- **结论**：
  - **引擎产生的概率向量上不出现 NaN / Infinity / 负熵**；`normalizedEntropy ∈ [0,1]`。
  - **函数确实可以对非法输入返回怪异值**，但该函数已在 `rangeNormalize.ts:125-131` 明确声明"纯数学函数，不做输入校验、遇到 NaN/负数跳过"，属**有意设计**，且这些输入无法由引擎产生：`[2] → H = -2`；`[1e200] → H = -6.6e202`；`[0.9] → eff = 1.2346 > sup = 1`；`[NaN,0.5] → eff = 4`。
  - **一处引擎可达的表象异常**：`uniformRange()`（1326 组合，`Σp = 0.9999999999999967 < 1`）→ `effectiveComboCount = 1326.0000000000093 > supportSize = 1326`。数学上 `Σp = 1` 时必有 `1/Σp² ≤ n`；这是舍入伪影，绝对偏差 **9.3e-12**（`|Σp-1| = 3.3e-15`）。唯一消费方是 `rangeMetrics.ts:211` 的显示格式化（`toFixed(1)`），无数值后果 → **NON-ISSUE（表象）**。
- **建议（可选）**：`effectiveComboCount` 用 `min(1/Σp², supportSize)` 或按 `Σp` 归一化后再算，避免展示层出现"有效组合数 > 组合数"。

### H10 校验器 vs 归一化器分歧 —— **未发现真实分歧；发现一处检测盲区**

- **假设**：存在 `stableNormalize` 接受但 `validateRange` 拒绝（或反之）且反映真实 bug 的范围。
- **结论**：**未证伪**。扫描 `[1,1] / [1e-300,1e-300] / [1,5e-324] / [MAX_VALUE,MAX_VALUE] / [1,0] / [1.7e308,1.7e308] / [1,-0]` 全部"归一化 ok ⇒ 校验 valid"。空范围差异（`stableNormalize([]) → RANGE_COLLAPSE` vs `validateRange(..., {allowEmpty:true}) → valid`）是**有意设计的严格度差异**，不是 bug。
- **真实盲区（MINOR-3b）**：`validateRange` **没有任何 violation code** 覆盖"`rawWeight > 0` 但 `probability === 0`"。
  实测：`freezeRangeFromPairs([{AA1:1},{AA2:1},{AA3: Number.MIN_VALUE}])` → 第 3 条 `rawWeight = 5e-324 > 0`、`probability = 0`，而 **`validateRange().valid === true`、`violations = []`**；`metrics.supportSize = 2 / totalEntries = 3`。也就是说 MAJOR-1 造成的静默归零，**校验器不可能发现**。
- 另：`-0` 权重被接受（`-0 < 0` 为 false），概率为 `-0` 且通过 `validateUnitInterval`（`rangeNormalize.ts:192-197`）——无害但未被显式归一。

---

## 三、新发现问题（按严重度）

### MAJOR-1（静默错误 / 违反代码自身声明）`rangeUpdate` 的 `Math.exp` 重新引入下溢，更新链**尺度不敏感**这一目标未达成

**位置**：`src/domain/range/rangeUpdate.ts:291-303`（尤其 `:302-303`）；对照 `rangeLogSpace.ts:207-260`（已实现却零调用）。

**问题**：`logPosterior = log(prior) + log(likelihood)` 之后立刻 `Math.exp(...)` 回到线性域，于是**绝对尺度重新变得致命**：当 `prior_probability × likelihood < 2^-1075 ≈ 2.47e-324` 时，`Math.exp` 精确返回 0，组合被静默剔除。`:296-299` 的注释断言"`log(prior) + log(likelihood)` 永不溢出/下溢……因此这里返回 `exp(和)` 是安全的 —— **绝对尺度不影响最终概率**"，该断言被以下实验直接证伪。

**实测（全部为真实引擎路径，`validateRange` 均通过，无任何告警）**：

1. **静默支持集丢失，且真实后验完全可表示**
   ```ts
   const prior = buildRangeFromRankClasses({ AA: 1, KK: 1e-24 }, { provenance: PROV }); // 每 KK 组合 p = 1.667e-25
   updateRange(prior, uniformModel(prior, 1e-300), ctx); // 每个 combo 同一似然（均匀 = 无信息）
   ```
   - 实际：`supportSize 12 → 6`，`p(KK 类) = 0`，6 条 `rawWeight === 0`；`entries` 仍为 12；`validateRange().valid === true`。
   - 期望：均匀似然不改变相对形状 → `p(KK 类) = 1e-24`（**双精度完全可表示**）。
   - 对照：同一先验改用似然 `1e-2` → `p(KK 类) = 1e-24`，`support = 12` 正常。

2. **大后验（~1%）被静默归零 —— 纯尺度效应**
   ```ts
   const prior = buildRangeFromRankClasses({ AA: 1, KK: 1e-2 }, { provenance: PROV }); // p(KK 类)=0.009901
   updateRange(prior, uniformModel(prior, 1e-321), ctx);
   ```
   - 实际：`p(KK 类) = 0`，`supportSize 12 → 6`，`validateRange().valid === true`。
   - 期望 / 对照：把**同一个均匀似然**换成 `1e-2`（或 `1e-12`、`1e-100`、`1e-300`、`1e-320`）→ `p(KK 类) = 0.009901`。**同一个先验 + 同一个"不含信息"的均匀似然，仅整体缩放就改变了后验分布**。

3. **真实规模下的假坍塌（P1 症状复现）**
   ```ts
   const prior = uniformRange(PROV); // 1326 组合，p = 7.54e-4
   updateRange(prior, uniformModel(prior, 1e-321), ctx); // → RANGE_COLLAPSE
   ```
   - `1e-320` → 正常（support 1326）；`1e-321` → `RANGE_COLLAPSE`。后验本应恒等于先验。

**触发边界（BigInt 精确定点验证，误差 0）**：`Math.exp(log p + log L) === 0` ⇔ 精确乘积 `p·L < 2^-1075 = 2.4703e-324`。实测 `p_KK = 1.65016501650165062e-3`：`L = 1.5e-321`（精确 `≥2^-1075`）→ `4.941e-324` 保留；`L = 1.4e-321`（精确 `<2^-1075`）→ `0` 归零。

**可达性（必须如实说明）**：触发需要 `先验权重比 × 似然 < 2.47e-324`，例如

| 先验权重比 | 需要的似然上限 |
|---|---|
| 1e-6 | < 2.47e-318 |
| 1e-12 | < 2.47e-312 |
| 1e-24 | < 2.47e-300 |
| 1e-300 | < 2.47e-24 |

均匀似然导致假坍塌需要 `L < 2.47e-324 × n`（n=2 → 4.94e-324；n=12 → 2.96e-323；n=86 → 2.12e-322；n=1326 → 3.28e-321，与实测 `1e-320` 通过 / `1e-321` 坍塌完全吻合）。**真实扑克输入（似然 ≥ 1e-9、权重比 ≥ 1e-6）距触发条件约 300 个数量级**，因此这不是一个活跃的生产 bug，而是"加固未覆盖的最后一环 + 文档断言错误"。

**但它是真实缺陷而非单纯固有边界**，理由有三：
1. 被丢失的**归一化后验概率是可表示的**（`1e-24`、`0.0099`），丢失并非不可避免；
2. 它是**静默的**：无报错、`validateRange` 通过、`supportSize` 变化被记为正常收缩（`rangeUpdate.ts:359-360` 只记录数字，不区分下溢）；
3. **修复代码已经在仓库里且已通过测试**——实测 `normalizeLogWeights` 对完全相同的 `prior×likelihood` 数据给出 `p(KK) = 1.000e-24, sup = 2`（对数域），而线代路径给出 `0 / sup=1`。它只是**零生产调用**。

**建议修复（最小改动）**：`rangeUpdate.ts:302-303` 不要 `Math.exp`，改为把 `logWeight = log(p) + log(L)` 收集后交给 `normalizeLogWeights`（`rangeLogSpace.ts:207`），并把 `logWeight` 一并存入条目以便后续在 log 域连乘；或至少在 `exp` 结果全为 0 而 `logPosterior` 并非全 -∞ 时报 `RANGE_NORMALIZE_FAILED` 而不是静默归零。同时修正 `:296-299` 的注释断言。

### MINOR-2 `stableNormalize.supportSize` 与实际 `p > 0` 的项数不一致

- **位置**：`rangeLogSpace.ts:85`（字段定义）、`:155-160`（统计 `scaled > 0`）。
- **证据**：`[1,1,5e-324]` → `supportSize = 3`，实际 `p>0` 只有 2；与 `probabilityMetrics.supportSize = 2` 对同一输入不一致。`[2,5e-324]` → `supportSize = 1`（`rawWeight = 5e-324 > 0` 被 `w/shift` 除法吞掉）。
- **影响**：`rangeNormalize.ts:85-94` 与 `rangeUpdate.ts:322-324` 都不消费该字段，故不影响范围结果；但对外 API 与"支持集收缩"诊断会失真。
- **建议**：统计 `p > 0`（或同时给出 `reportedSupport` / `effectiveSupport` 两个字段）。

### MINOR-3 "真零 vs 下溢零"无法区分 + 校验器无对应 violation

- **位置**：`rangeLogSpace.ts:303-315`（文档声称的能力）、`:310-312`（`isNumericallyZero` 实为 `=== 0`）、`:315`（`DENORMAL_MIN` 在 `src/` 零引用）；`rangeValidator.ts:19-33`（无相应 code）。
- **证据**：`isNumericallyZero` / `DENORMAL_MIN` 在 `src/` 无任何调用者；`validateRange` 对"`rawWeight>0` 且 `probability===0`"返回 `valid = true, violations = []`（H10(a) 实测）。
- **影响**：MAJOR-1 类下溢**不可能被现有不变量发现**；`isNumericallyZero` 是死代码 + 文档与实现不符。
- **建议**：要么实现真正的区分（在 `stableNormalize` 里记录 `underflowedCount`），要么删掉该函数与 `DENORMAL_MIN` 并修正 `:303-315` 的注释；`rangeValidator` 可增加 `SUPPORT_UNDERFLOW`（`rawWeight > 0 && probability === 0`）。

### MINOR-4 `rawWeightSum` 可溢出为 Infinity（潜伏）

- **位置**：`rangeLogSpace.ts:136`（无溢出保护）、`:87`（注释只提下溢）；放大点 `rangeUpdate.ts:341`。
- **证据**：`[1.7e308, 1.7e308] → rawWeightSum = Infinity`（概率仍正确）；`p × weightSum = Infinity`。
- **影响**：当前更新链因 `rawW ≤ 1` 不可达；但 `normalizeWeights` 是公开 API，返回非有限和在契约上说不通。
- **建议**：`rawWeightSum` 用 Kahan/缩放求和，或在溢出时返回 `Number.MAX_VALUE` 并加注释；或去掉 `rangeUpdate.ts:341` 的 `× weightSum` 回乘（该回乘本身在 denormal 区还可能再次下溢）。

### MINOR-5 `toLogWeight(NaN) → -Infinity`（测试已固化，文档未写）

- **位置**：`rangeLogSpace.ts:272-277`；测试断言 `test/rangeNumericalStability.test.ts:114`。
- **说明**：NaN 被静默映射为"权重 0"，与 `:269` 注释"0 或任何非正数"不符，且与 `isLogWeightValid`（`:47-49`）显式拒绝 NaN 的设计意图相左。若上游把 NaN 传进来，会得到"零权重"而不是错误。
- **建议**：注释补一句 NaN 的处理；或让 `toLogWeight` 对 NaN 返回 NaN，由 `normalizeLogWeights:217-223` 报错。

### NON-ISSUE（记录以免误判）

- `probabilityMetrics` 对非法输入返回负熵 / `eff > support`：已在 `rangeNormalize.ts:125-131` 显式声明不做校验；引擎产生的概率向量不会触发。
- `uniformRange()` 上 `effectiveComboCount = 1326.0000000000093 > supportSize`：9.3e-12 舍入伪影，仅显示层使用。
- `-0` 权重/概率被接受：数值上无害。
- 空范围在归一化器与校验器之间的判定差异：有意设计。

---

## 四、未能证伪的假设（明确声明）

| # | 假设 | 结论 | 关键量化 |
|---|---|---|---|
| H1 | `logSumExp` 会返回 NaN 或错值 | **未能证伪** | 400k+ 组 vs 独立参照：最大 **0.973 ulp / 2.16e-16 相对**；单元素/空/全 -∞/全等/悬殊/NaN/+∞/denormal 全部正确 |
| H2 | 存在缩放因子破坏 `stableNormalize` 尺度不变性 | **函数层面未能证伪**（端到端被证伪 → MAJOR-1） | 任何使缩放后输入仍可表示的因子（含 1e-300…1e300、1e308、5e-324）下概率一致（≤2 ulp）；差异仅出现在调用方乘法已把输入变成 0/Infinity 时，且均为显式报错 |
| H3 | 和里出现 Infinity 会导致错误概率 | **未证伪概率正确性**（字段溢出确认 → MINOR-4） | `[1.7e308,1.7e308] → [0.5,0.5], Σp=1`；单个 Infinity 权重被拒 |
| H6 | 存在无法往返的正 double | **未能证伪** | 最大相对误差 **2.8e-14**；`5e-324` 往返误差 0；`MAX_VALUE` 未溢出 |
| H7 | 浮点导致弱牌后验超过强牌（方向反转） | **未能证伪** | 精确排序搜索 **0/355,598** 反转；1326 组合相邻 ulp **0/200**；`Math.log` 单调性违例 **0/200,006**、`Math.exp` **0/400,000** |
| H8 | 500+ 次更新出现 NaN/Inf/Σp 漂移/校验失败 | **未能证伪**（均匀似然假坍塌除外 → MAJOR-1c） | 600 次：`Σp ∈ 1±1e-15`、无 NaN/Inf、`validateRange` 全通过；均匀似然链 support 与形状**零漂移**；混合链的收缩与真实概率跌破 `2^-1074` 同步（固有） |
| H9 | `probabilityMetrics` 返回 NaN/Inf/负熵 | **引擎可达范围内未能证伪** | 引擎概率向量全部有限、熵 ≥ 0；仅 9.3e-12 的 `eff>support` 表象异常 |
| H10 | 归一化器与校验器存在实质分歧 | **未能证伪** | 7 组边界输入全部"归一化 ok ⇒ 校验 valid"；唯一缺口是检测盲区（MINOR-3） |

---

## 五、其他核验项

- **全量测试（审计开始时的基线快照）**：`node --test --experimental-strip-types "test/**/*.test.ts"` → **tests 614 / suites 134 / pass 614 / fail 0 / cancelled 0 / skipped 0**（duration ≈ 21.0s）。
- **审计期间工作区被其他 agent 并发修改**（`src/domain/player/*`、`src/domain/range/profileProvider.ts`、`src/domain/range/handPotential.ts`、`test/playerProfile.test.ts` 等在审计过程中相继出现）。审计结束时复跑全量：
  **tests 670 / pass 661 / fail 9**，9 个失败**全部**集中在玩家画像/统计（`adjustedRate`、`单手影响上限`、`玩家物理隔离` 等）——**与 Range Engine 数值稳定性无关**，属其他 agent 的在途改动。
- **Range 相关测试单独复跑**：`test/range*.test.ts` → **164/164 通过（28 suites）**；其中 `test/rangeNumericalStability.test.ts` → **48/48 通过（6 suites）**。
- **类型检查**：`node node_modules/typescript/bin/tsc --noEmit` → **两次运行均退出码 0，无输出**。
- **重复 / 竞争的 epsilon 与魔数**：**未发现**。`EPSILON = 1e-9` 只在 `range.types.ts:23` 定义一次，`rangeNormalize.ts:11/177/188`、`rangeValidator.ts:11/67`、`rangeLogSpace.ts:40/319`、`rangeUpdate.ts:41/112`、`rangeBlockers.ts:13`、`rangeProvenance.ts:11/99` 全部引用同一常量；`src/domain/range/` 中其余 `1e-*` 字面量**只出现在注释里**（`rangeLogSpace.ts:10,19,23,24,26,100,108`、`rangeNormalize.ts:69-72,75`、`rangeUpdate.ts:294`）。审计末期新出现的 `profileProvider.ts` / `handPotential.ts` 也不含 epsilon 或数值阈值字面量（已复核）。
  - 遗留的"魔数"是两个**未使用/半使用**的常量：`DENORMAL_MIN`（`:315`，`src/` 零引用）与 `LOG_ZERO`（内部在用）；另有死函数 `isNumericallyZero`。
  - 版本号 `test/rangeNumericalStability.test.ts:38` 用 `testOnlyProvenance`，与生产 provenance 校验无冲突。
  - 小瑕疵：`rangeLogSpace.ts:40-41` 对同一模块写了两次 import；`rangeUpdate.ts:443` 重新导出 `EPSILON`（同一绑定，不构成第二个来源）。

---

## 六、已知限制（含浮点固有边界）

1. **绝对下溢不可消除，但可避免"绝对尺度敏感"**：`p·L < 2^-1075` 时线性概率必然为 0（IEEE754 固有）。正确做法是**在 log 域做 softmax**（`p = exp(logW - logSumExp)`），使结果只依赖相对形状——该工具已存在（`normalizeLogWeights`）但未接入。这是 MAJOR-1 的正解。
2. **线性概率表示的下限**：任何真实概率 < 5e-324（`2^-1074`）在本引擎的 `RangeEntry.probability` 中只能是 0。实测 600 次混合似然链的支持集收缩与此下限**精确同步**（弱类 `1e-30` 第 12 步、真实 log 比 -773.7 < -744.4），属固有，不应视为缺陷。
3. **Denormal 输入区（< 2.2e-308）相对精度骤降**：`1e-320` 附近相对间隔 ≈ 5e-4~1e-3，`1e-323` 附近可达 50%。实测 `[1.5e-320,1e-320]` 缩放后概率形变 2e-3、`exp(-744)` 主导的概率相对误差 29%，均由此产生，而非算法错误。
4. **向大尺度缩放会溢出**：`3×1e308 = Infinity` → 归一化器显式 `RANGE_VALIDATION_FAILED`（正确且非静默），但与"尺度不变"的语义在 double 表示边界处必然冲突。
5. **`logSumExp` 的绝对精度底**：最大值与次大项在对数域相差 > 745 时，微小项并入舍入而消失（绝对误差 ~1e-324）；对下游概率无可表示影响。
6. **`log`/`exp` 往返的相对误差 ≈ ulp(log w)**：`w ~ 1e308` 时约 1.1e-13；该量级 `log` 不单射（相邻两个 double 共享同一 log）。
7. **容差语义**：`isStableNormalized`（`rangeLogSpace.ts:318-320`）与 `validateRange`（`rangeValidator.ts:161`）都用绝对容差 `EPSILON = 1e-9`。实测最大漂移仅 ~1e-15（1326 项求和），余量约 6 个数量级，**当前安全**；但它对"项数 × 单 ulp"没有显式建模（1326 项的理论上界仍在 1e-13 量级），若未来条目数或计算深度大幅增长需重新评估。
8. **本轮审计未覆盖**：Player Model / Dynamic Adjustment 链（`RangeAdjustmentProvider`，`range.types.ts:338-348`）尚未实现，若其乘法因子接入线上域连乘，将**重现 MAJOR-1**（`rangeUpdate.ts:299-301` 自己也承认这是"未来接入的前提"）——建议在接入时同步切到 `logWeight` 累加。

---

## 七、结论摘要

Step 5A.1 的**核心修复是真实有效的**：`stableNormalize` 的 max-shift 彻底消除了旧的 `1e-9` 绝对阈值，权重整体缩放 `1e-300…1e300` 不再改变概率，原先被误报为 `RANGE_COLLAPSE` 的"全 1e-12 似然"现在正常工作，614 项测试与类型检查全绿。

但它**没有闭环**：`rangeUpdate.ts:302-303` 在归一化之前用 `Math.exp` 回到线性域，使"绝对尺度不影响后验"这一目标在 `p·L < 2.47e-324` 处重新失效——由此产生**静默支持集丢失（真实后验 1e-24 / 0.0099 被置 0）**、**均匀似然缩放改变后验**、以及**1326 组合下的假 `RANGE_COLLAPSE`**。三者在 `validateRange` 下全部通过、无任何告警。修复所需的 `normalizeLogWeights` 已经在同一 PR 中实现并测试，但**零生产调用**；同时 `:296-299` 的注释断言与事实相反。

其余为诊断层面的小缺陷（支持集定义不一致、无法区分真零/下溢零、`rawWeightSum` 可溢出、`toLogWeight(NaN)` 语义）。四条核心算法（`logSumExp`、往返、方向单调性、链式稳定性）**均未被证伪**。
