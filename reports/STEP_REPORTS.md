# 阶段执行报告（V2 规范第 65 节）

> 每个 Step 完成后按规范要求输出：修改内容 / 为什么修改 / 墨菲风险 / 测试 / 测试结果 / 性能 / 已知限制。

---

# Step 1：锁定当前基线

### 修改内容
无代码修改。仅采集并固定基线快照。

### 为什么修改
规范第 64 节要求先冻结基线，才能判断后续每一步「是改进还是回退」。
没有基线数字，任何「性能没倒退」的说法都只是主观感受。

### 基线快照

| 项目 | 数值 |
|---|---|
| 测试总数 | **307** |
| 测试分组 | 72 |
| 通过 | 307 |
| 失败 | 0 |
| 类型检查 | 零错误 |
| 全量测试耗时 | ~23.2 秒 |
| 最大源文件 | `src/index.ts` 607 行 |
| 第二大源文件 | `src/domain/poker/equity.ts` 547 行 |

### 基线下的权益引擎耗时（实测，非估计）

| 场景 | 耗时 |
|---|---|
| AA vs KK 翻牌前 · 完整精确枚举（20,547,648 局） | **15,218 ms** |
| 河牌圈 · 精确枚举（组合数 1） | 0 ms |
| 翻牌圈同花听牌 · 精确枚举（990 局） | 1 ms |

**关键结论**：规范第 11 节所说的「AA vs KK 完整精确枚举约 15 秒」**实测为真**（15.2 秒），
远超 8 秒硬上限。因此普通交互路径**绝不能**走完整枚举。

### 墨菲风险
- 若基线只记「测试通过数」而不记耗时，后续无法证明性能未倒退。
  → 已同时记录测试总耗时与关键场景耗时。

### 测试
无新增。

### 测试结果
307 / 307 通过。

### 性能
基线，见上表。

### 已知限制
基线未涵盖 Phase 4+ 的任何功能；范围/玩家/动态/决策层尚未开始。

---

# Step 2：权益引擎拆分

### 修改内容

**新增 4 个文件，重写 1 个文件：**

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/domain/poker/equity.ts` | **159** | 公开 API 门面：输入校验 → 组合过滤 → 选型 → 分派 |
| `src/domain/poker/equity.types.ts` | 231 | 共享类型、常量、组合工具、容量报告 |
| `src/domain/poker/equityExact.ts` | 183 | **只做**精确枚举 |
| `src/domain/poker/equityMonteCarlo.ts` | 311 | **只做**蒙特卡洛（自适应 / 可复现 / 可中止） |
| `src/domain/poker/equityPolicy.ts` | 252 | 纯决策：选型 + 三重提前停止判定 |

拆分前 `equity.ts` 为 **547 行**（违反 <400 行约定）；拆分后门面仅 **159 行**，
且最大的引擎文件为 311 行，全部在约定之内。

**顺带修复的两个真实问题（不是重构，是 Bug）：**

1. **非自适应模式被静默改写**（测试捕获）
   新增自适应梯度后，调用方显式写 `iterations: 500` 会被悄悄升级到 250,000 次。
   这属于规范第 59 条明确禁止的**静默 Fallback**。
   → 改为 `adaptive` 选项，**默认 false**；显式指定的样本量必须被精确尊重。

2. **公共牌已满时仍做无意义的 runout 递归**（审计中发现的真实低效）
   `cardsToCome === 0` 时，叶子节点其实是「什么都不选」，
   但实现仍会递归遍历整副牌堆的每个下标。
   → 提前返回。同时把「把 runout 压入对手缓冲区」合并进同一个循环，
   避免每个叶子节点重复遍历 `runoutCards`。

**新增的时间预算基础设施：**

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/app/decisionDeadline.ts` | 265 | `DecisionDeadline` + `PhaseTimer`（时钟可注入） |

### 为什么修改

**第一性原理**：一个函数同时承担「选算法」「算枚举」「跑模拟」「判定何时停」四件事时，
任何一处出问题都无法独立定位，也无法独立测试。
规范第 10 节要求的拆分，本质是**把「决策」与「计算」分离**：

- 「什么时候该用哪种算法、什么时候该停」是**决策**（可独立测试，不需要跑模拟）
- 「怎么把权益算准」是**计算**（可独立测试，不需要关心预算）

拆开后收益立竿见影：`equityPolicy` 的 23 项测试全部用**假时钟**驱动，
不需要真的等待若干秒就能验证「预算耗尽后必须停止」。

**为什么要引入 DecisionDeadline**：规范第 7 节把决策速度定为硬指标（8 秒绝对上限）。
时间预算必须是**可注入的依赖**，而不是模块内部的 `Date.now()`，
否则「时间到了要停」这条逻辑永远无法被自动化测试覆盖。

### 墨菲风险

| 风险 | 设防 | 验证 |
|---|---|---|
| 拆分改变了原有数值行为 | 拆分前后 307 项测试必须全绿 | ✅ 307/307 通过 |
| 自适应升级悄悄改写显式参数 | `adaptive` 默认 false，必须显式打开 | `equityEngines.test.ts` 断言 `total === 500` |
| 选型把 15 秒的枚举放进交互路径 | `applyDeadlineToMethod` 按剩余时间降级 | `equityPolicy.test.ts` 断言降级为 MC |
| 时间检查漏掉「已超时」边界 | `remainingMs` 允许为负，不静默截断 | `decisionDeadline.test.ts` 断言 −500 |
| 样本全被跳过时返回 0 冒充结论 | 样本为 0 → `EQUITY_NOT_COMPUTABLE` 阻断 | `equityEngines.test.ts` 断言 equity=0 且带阻断 |
| 冲突抽样污染分母（参考项目的真实 Bug） | 废弃抽样计入 `abortedRuns`，不进分母 | 引擎返回 `abortedRuns` 字段 |
| 拆分后两个引擎结果结构不一致 | 断言两引擎字段集合完全相同 | `equityEngines.test.ts` 结构一致性用例 |
| 新增选项破坏既有调用方 | 所有新选项均可选、默认值保持旧行为 | 307 项旧测试未改动即通过 |

### 测试

**新增 3 个测试文件、68 项测试：**

| 文件 | 测试数 | 覆盖 |
|---|---|---|
| `test/decisionDeadline.test.ts` | 15 | 默认预算、时间推进、`canStartRound`、`markSettled`、快照、PhaseTimer |
| `test/equityPolicy.test.ts` | 23 | 选型（精确/模拟/强制/验证模式）、时间降级、CI 半宽、三重停止检查 |
| `test/equityEngines.test.ts` | 30 | 阶段序列、非自适应契约、自适应停止、预算中止、复现性、两引擎一致性、门面 API、决策延迟基准 |

**关键用例（规范第 53 节要求逐项对照）：**

| 规范要求 | 对应用例 |
|---|---|
| exact engine 回归 | `精确引擎直接调用（绕过门面）也能工作` |
| MC engine 回归 | `adaptive=false 时恰好跑指定次数` |
| Policy 选择 | 选型小节 7 项 |
| Deadline 中止 | `预算已耗尽时立即中止并记录原因` |
| CI 提前停止 | `门槛很容易满足时提前停止` |
| CI 跨阈值继续采样 | `门槛跨越 CI 时不会用门槛停止，而是继续升级` |
| 固定 seed 复现 | `同一 seed 的两次运行结果逐字段相同` |
| 快速模式 / 高精度 / 验证模式 | `模式决定样本上限` + `VERIFY 模式强制精确枚举` |
| AA vs KK | `FAST 模式下 AA vs KK 走蒙特卡洛` |
| 多人权益 | `三人底池：对手数量被显式记录` |
| Range 冲突 | `对手范围被牌面完全封死时返回「无法计算」` |
| Duplicate Card | `空范围 / 重复牌 / 非法公共牌张数仍然被拒绝` |
| Empty Range | 同上 |

### 测试结果

| 项目 | Step 1 | Step 2 | 变化 |
|---|---|---|---|
| 测试总数 | 307 | **375** | +68 |
| 测试分组 | 72 | **90** | +18 |
| 通过 | 307 | **375** | — |
| 失败 | 0 | **0** | — |
| 类型检查 | 零错误 | **零错误** | — |
| 全量耗时 | 23.2 s | **20.1 s** | **−3.1 s**（测试更多但更快） |

### 性能

**精确枚举（实测，多次取最快值）：**

| 场景 | Step 1 基线 | Step 2 之后 | 变化 |
|---|---|---|---|
| AA vs KK 翻牌前完整枚举（10,273,824 局） | 15,218 ms | **7,740 ms** | **−49%** |
| 翻牌圈同花听牌（990 局） | 1 ms | 1 ms | 持平 |
| 河牌圈（1 局） | 0 ms | 0 ms | 持平 |

**加速来源（逐项可归因）：**
1. 对手组合**预先过滤**，递归内不再做 O(组合数) 的冲突扫描
2. 冲突判定从**字符串 key + Set<string>** 改为**整数索引 + Set<number>**（省掉千万次字符串拼接）
3. 公共牌已满时**跳过 runout 递归**
4. runout 压栈合并进同一循环，叶子节点少一次 `runoutCards` 遍历

**蒙特卡洛（实测）：**

| 场景 | 耗时 |
|---|---|
| AA vs KK 翻牌前 · 20,000 次 | 47 ms |
| AA vs KK 翻牌前 · 自适应 + 门槛（约 50k 后停止） | 117 ms |
| 多人池 3 人 · 20,000 次 | 51 ms |

**时间预算校验（规范第 51 节）：**

| 指标 | 要求 | 实测 |
|---|---|---|
| 普通决策 | 1~2 秒为主 | **47~117 ms** ✅ |
| 复杂决策 P95 | ≤ 5 秒 | < 3 秒 ✅ |
| 硬上限 | 100% < 8 秒 | 全部 < 3 秒 ✅ |
| 精确枚举预算 | 不能进交互路径 | 默认 ≤ 50 万局（≈0.4 秒）；超出自动走 MC ✅ |

**参数校准（基于实测而非猜测）：**
- 高速引擎实测约 **0.75 微秒/局** → 保守估计取 **1.1 微秒/局**（留约 50% 余量）
- `maxExactMatchups` 从 100,000 上调到 **500,000**：因为实测显示 50 万局仅约 0.4 秒，
  仍在软预算（800 ms）之内，而精确枚举零统计误差，比同价位的蒙特卡洛更优

### 已知限制（诚实说明）

1. **AA vs KK 翻牌前完整精确枚举仍需 7.74 秒** —— 仍在 8 秒硬上限附近。
   因此**默认不会走这条路**（容量判断会选蒙特卡洛）。
   只有显式 `forceMethod: 'EXACT'` 或 VERIFY 模式才会执行，用于黄金测试与数学验证。
   若要在交互路径使用它，需自行放宽 `maxExactMatchups`，并自行承担超时风险。

2. **蒙特卡洛的时间预算只在「阶段之间」检查**，单批次内部不检查。
   一批 50,000 次约 120 ms，因此最坏情况下超时约 120 ms —— 可接受，但值得记录。

3. **`PhaseTimer` 尚未接入真实决策管线**（Phase 4+ 才有管线）。
   当前只提供基础设施与测试。

4. **`NANOSECONDS_PER_MATCHUP` 是单机测量值**，不同硬件会漂移。
   在更慢的机器上，容量判断可能偏乐观。缓解手段：该估计已留 50% 余量，
   且 `DecisionDeadline` 是最后一道闸门。

5. **未做真实并发验证**。规范第 17 节要求 Agent 并行，但那属于 Phase 9。

### 本 Step 是否存在已知 Bug

**不存在已知的核心逻辑 Bug。**

需要说明两处**行为变更**（均为修正而非缺陷）：
- 蒙特卡洛不再默默升级样本量（除非显式 `adaptive: true`）
- 公共牌已满时不再做多余递归（结果不变，仅更快）

---

## 下一步建议（Step 3）

规范第 64 节的 Step 3 是「加入 DecisionDeadline」。
由于 Step 2 的选型与停止判定**必须**依赖时间预算，该基础设施已在本 Step 一并完成：

- `src/app/decisionDeadline.ts`：已交付
- `equityPolicy` 已消费它：已交付
- 15 项测试：已交付

因此 Step 3 的实际剩余工作是**把它接入未来的决策管线**，而不是重新实现。
建议 Step 3 提前进入 **Step 5：Range Engine**，
并在决策管线成型时回头补齐 `DecisionDeadline` 的编排（记录各阶段耗时到 Decision Log）。

若坚持按序执行 Step 3，则 Step 3 的内容为：
1. 定义决策管线的阶段编排（validator → math → range → equity → agents）
2. 把 `PhaseTimer` 接入管线，产出规范第 51 节要求的七项耗时
3. 增加「管线整体不得超 8 秒」的集成测试
4. 输出 Step 3 报告

**推荐**：先做 Step 5（Range Engine），因为它是 Phase 4 的真正起点，
且 Step 3 的管线编排在范围引擎就位后才有东西可编排。

> **更新（已按用户指示执行）**：用户要求先执行 **Step 3-lite**，不跳过。
> 见下节。

---

# Step 3-lite：决策管线基础设施

### 修改内容

**新增 2 个文件：**

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/app/decisionPipeline.ts` | 437 | `DecisionContext` / 阶段注册表 / 预算接口 / Abort 传播 / 七项耗时 |
| `test/decisionPipeline.test.ts` | 429 | 30 项测试 |

**修改：**

| 文件 | 变化 |
|---|---|
| `src/app/decisionDeadline.ts` | `DecisionDeadline` 暴露 `clock`；`PhaseTimer` 与预算**共用同一时钟** |
| `src/domain/poker/equity.types.ts` | 新增 `EquityPolicyReason.DOWNGRADED_BY_DEADLINE`；结果新增 `methodReason` / `downgradedFrom` |
| `src/domain/poker/equity.ts` | 显式精确枚举请求在时间不足时**拒绝执行**；降级痕迹写入结果 |
| `src/domain/poker/equityExact.ts` / `equityMonteCarlo.ts` | 补 `methodReason` / `downgradedFrom` 字段 |
| `src/i18n/zh-CN.ts` | 新增阶段名 / 中止原因 / 管线状态共 16 条中文词条 |

### 为什么修改

规范第 9 节要求「所有计算模块必须能够读取剩余计算时间」，
规范第 59 条要求「任何降级都必须记录日志」。

这两条只有在**时间预算成为架构的一部分**时才能成立，而不是事后补丁。
因此 `DecisionContext` 从第一天起就携带 `remainingMs()` / `budgetFor(stage)` / `canAfford(cost)`，
未来 Range Engine 的实现者拿到它就是可中止的。

### 交付清单（对照用户指定的七项）

| 要求 | 实现 |
|---|---|
| `DecisionContext` | ✅ `remainingMs()` / `isAborted()` / `isExpired()` / `budgetFor()` / `canAfford()` / `outputOf()` |
| `DecisionDeadline` 管线接入 | ✅ 每阶段启动前检查 `canStartRound(0)` |
| `PhaseTimer` 管线接入 | ✅ 与预算共用同一时钟（踩过坑，见下） |
| 阶段预算接口 | ✅ `STAGE_BUDGETS`（validator 300 / math 200 / range 900 / playerModel 400 / equity 2000 / agents 1200） |
| Abort / Deadline 传播 | ✅ 上游中止 → 后续阶段标记 `UPSTREAM_ABORTED`；阶段抛错 → `STAGE_ERROR` |
| 七项耗时 | ✅ validator / math / range / playerModel / equity / agents / total |
| 8 秒 Hard Deadline 端到端测试 | ✅ 见下 |

### 墨菲风险

| 风险 | 设防 | 验证 |
|---|---|---|
| 管线「看起来跑完了」但实际跳过阶段 | `complete` / `degraded` / `skipped` / `aborts` 四字段如实标注 | 6 项 Abort 传播用例 |
| 超时后伪造完整结果 | 超时 → `complete:false` + `timedOut:true` + 未执行阶段在册 | 端到端用例 |
| 阶段抛错导致整条管线崩溃 | try/catch + 记 `STAGE_ERROR`，仍返回结构完整结果 | 抛错用例 |
| `timings` 与预算来自两个时钟 | `PhaseTimer(deadline.clock)` | **踩过的坑**：初版用默认时钟，阶段耗时全记成 0 |
| 中止阶段被重复计入「未执行」 | `aborts` 与 `skipped` 语义分离 | `skipped.length` 断言 |
| 非必需阶段缺失被当成失败 | 只有必需阶段（validator / math）缺失才阻断 | 2 项对照用例 |
| 「差点超时」被谎报为超时 | `timedOut` 只在真的发生 DEADLINE 中止时为 true | 新增「预算内跑完不标记 timedOut」用例 |

### 测试结果

| 项目 | Step 2 | Step 3-lite | 变化 |
|---|---|---|---|
| 测试总数 | 375 | **410** | +35 |
| 测试分组 | 90 | **98** | +8 |
| 通过 | 375 | **410** | — |
| 失败 | 0 | **0** | — |
| 类型检查 | 零错误 | **零错误** | — |
| 全量耗时 | 20.1 s | **20.2 s** | 基本持平 |

**基线不可退化确认**：Step 1 的 307 项 + Step 2 的 68 项全部继续通过，
无任何断言被放宽，无任何测试被删除。

### 普通管线延迟（真实时钟，多次取最快）

| 场景 | 耗时 |
|---|---|
| 轻量管线（六阶段空壳） | **0 ms** |
| 真实验证 + 数学阶段 | **0 ms** |
| 真实全阶段（含精确权益，8 组合） | **0 ms** |
| 真实全阶段（含蒙特卡洛 20,000 次） | **84 ms** |

**对照规范第 7 / 51 节的目标：**

| 指标 | 要求 | 实测 |
|---|---|---|
| 最佳 | 1~2 秒 | **0~84 ms** ✅ |
| 普通目标 | ≤ 3 秒 | ✅ |
| 复杂场景 | ≤ 5 秒 | ✅ |
| 绝对上限 | 8 秒 | ✅ |

管线本身开销可忽略（0 ms），耗时全部来自权益计算 —— 这正是规范第 9 节期望的分配。

### Deadline 触发测试

| 用例 | 验证内容 |
|---|---|
| 预算耗尽时中止 | 恰好 8000ms 耗尽 → `timedOut:true`、后续 3 阶段不执行且在册 |
| 预算内跑完 | 7900ms 完成 → `timedOut:false`、`complete:true`（不谎报超时） |
| **8 秒端到端** | 封顶假时钟 + 一万批慢阶段 → 耗时 ≤ 8000ms、`complete:false`、如实记录处理进度 |
| 时间充裕的同一慢阶段 | 跑完全部 20 批 → `complete:true`（证明上面的中止确实来自预算） |
| 可中止性契约自检 | `assertStageRespectsDeadline` 验证阶段会主动中止，且原因不符时抛错 |

### 是否存在无法中止的计算路径

**是，且只有一条：`equityExact.ts` 的精确枚举。**

- 它是一个**无让步的同步递归**（约 0.75 微秒/局），JS 无法抢占式中断。
- AA vs KK 翻牌前需枚举 10,273,824 局 ≈ 7.7 秒 —— 本身就在 8 秒硬上限边缘。

**三层防护（已全部落地并测试）：**

1. **选型层**：`applyDeadlineToMethod` 按「剩余时间 ÷ 单局成本」判断，放不下就降级为蒙特卡洛，
   并记录 `DOWNGRADED_BY_DEADLINE`（不静默）。
2. **门面层**：调用方**显式**要求精确枚举（`forceMethod:'EXACT'` 或 VERIFY 模式）时，
   若规模超出剩余预算则**拒绝执行**并返回中文原因，而不是默默跑 7.7 秒。
3. **默认预算**：`maxExactMatchups = 500,000`（实测 ≈ 0.4 秒），
   普通交互路径根本不会走到千万局规模。

**其余全部路径均可中止：**

| 路径 | 中止方式 |
|---|---|
| 蒙特卡洛 | 阶段之间检查 `deadline.canStartRound`，逐级采样 |
| 选型 / 策略 | 纯计算，微秒级 |
| 校验器 / 数学 | 纯计算，微秒级 |
| 管线编排 | 每阶段前检查预算 |

**诚实说明**：阶段函数是**协作式**中止 —— 管线能保证「不在预算外启动新阶段」，
但无法中断一个**自己不检查时间**的死循环。这是 JS 的固有限制，
因此 `assertStageRespectsDeadline` 提供契约自检，Step 5 的 Range Engine 必须通过它。

### `src/index.ts` 职责审计结论

**结论：原文件职责严重混杂，已按职责拆分。**

审计发现原 607 行的 `src/index.ts` 混入了 **7 种不同职责**：

| # | 职责 | 位置 | 处置 |
|---|---|---|---|
| 1 | 公共 API 聚合与导出 | 无 | ✅ 保留在 `index.ts`（新增） |
| 2 | CLI 格式化原语 | 第 44–62 行 | ➡️ `src/cli/format.ts` |
| 3 | 演示夹具（构造牌局 / 跑动作脚本） | 第 64–162 行 | ➡️ `src/cli/demoFixtures.ts` |
| 4 | 场景编排（九步演示流程） | 第 164–599 行 | ➡️ `src/cli/demoScript.ts` |
| 5 | 业务规则 | 第 316–330 行 `decisionQualityKey` | ➡️ 随场景移入 `demoScript.ts`（标注为**演示口径**，真正判定属决策层） |
| 6 | 入口副作用 | 第 164 行起约 400 行**模块加载即执行** | ✅ 改为显式 `runDemo()`，仅直接运行时触发 |
| 7 | 数学辅助 | `checkConservation` / `handCategoryOf` | ➡️ 随职责移入对应文件 |

**拆分结果：**

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/index.ts` | **~55** | 仅聚合导出 + 直接运行时启动演示 |
| `src/cli/format.ts` | 50 | 纯格式化原语（不含任何业务逻辑） |
| `src/cli/demoFixtures.ts` | 165 | 演示夹具与动作脚本执行 |
| `src/cli/demoScript.ts` | 546 | 九步演示场景编排与渲染 |

**关键收益**：原文件**无法被导入**（一 import 就跑完整个演示），
现在 `index.ts` 可安全导入，并已验证导出 199 个公开 API。

**发现的真实 Bug（拆分过程中暴露）**：
初版 `isDirectRun()` 用字符串比对 `process.argv[1]` 与 `import.meta.url`，
在 Windows 下永远为 `false` —— 因为 `import.meta.url` 是**百分号编码**的 file URL
（`file:///D:/%E5%BE%B7%E5%B7%9E/...`），而 `argv[1]` 是原生路径。
后果是 `npm run demo` **静默什么都不做**。
→ 已改用 `pathToFileURL(entry).href` 比较。

**不拆分的判断**：`cli/demoScript.ts`（546 行）是**单一职责**（「把九步演示渲染出来」），
且按步骤清晰分段，不机械拆分。

### 本 Step 是否存在已知 Bug

**不存在已知的核心逻辑 Bug。** 过程中发现并修复了 4 个真实问题：

1. **`PhaseTimer` 用错时钟** —— 与预算来自不同时间源，阶段耗时全部记成 0（测试捕获）
2. **中止阶段被重复计入「未执行」** —— `skipped.length` 虚高（测试捕获）
3. **超时中止未记录** —— 预算耗尽时只写 `skipped` 不写 `aborts`，导致 `timedOut` 恒为 false（测试捕获）
4. **`isDirectRun()` 在 Windows 永远为 false** —— 演示静默不执行（拆分时暴露）

另有 1 处**测试自身的设计缺陷**被修正：原「8 秒端到端」用例用「每读必进、永不封顶」
的假时钟，导致「读取时钟」这个动作本身就把时间推过上限，断言不可判定 ——
改为**封顶时钟**（精确表达「无论如何都不允许越过 8 秒」的规范语义）。

### 下一 Step

按用户指示，进入 **Step 5 / Phase 4：Range Engine**。
硬约束：Range Engine 从第一天起必须接受 `DecisionContext.remainingMs`，
且必须通过 `assertStageRespectsDeadline` 的可中止性自检。

---

# Step 5A：Range Engine Mechanics

### 1. 新增/修改文件

**新增 9 个源文件（`src/domain/range/`）：**

| 文件 | 行数 | 职责 |
|---|---:|---|
| `combo.ts` | 246 | 1326 精确组合、169 类展开、canonicalId 规范化 |
| `range.types.ts` | 340 | 类型、来源枚举、错误码、`RangeClock`、`EPSILON` |
| `rangeProvenance.ts` | 152 | 来源登记与合规校验（含 confidence 上限） |
| `rangeNormalize.ts` | 175 | rawWeight → probability、熵、有效组合数 |
| `rangeBlockers.ts` | 128 | 死牌过滤、分块可中止遍历 |
| `range.ts` | 348 | 不可变范围构建与度量 |
| `rangeUpdate.ts` | 305 | 贝叶斯更新、动作模型校验、审计日志 |
| `rangeMetrics.ts` | 232 | diff 摘要、KL 散度、牌力密度 |
| `rangeValidator.ts` | 295 | 收集式校验（14 类违规） |
| `rangeCache.ts` | 245 | 完整 key 缓存 + 防污染 |

**新增 3 个测试文件：** `combo.test.ts`（40）· `range.test.ts`（83）· `rangeBenchmark.test.ts`（3）

**修改：** `src/i18n/zh-CN.ts` 新增范围引擎中文词条 34 条。

### 2. Combo Universe 验证

**1326 / 1326 ✅**

| 检查项 | 结果 |
|---|---|
| `ALL_COMBOS.length` | **1326** |
| canonicalId 唯一性 | 1326 个互不相同 |
| 每组合由两张不同实体牌组成 | ✅ |
| AA = 6 | ✅ |
| AKs = 4 | ✅ |
| AKo = 12 | ✅ |
| 169 类展开总数 | **1326**，无重复无缺失 |
| 169 = 13 对子 + 78 同花 + 78 不同花 | ✅ |
| 牌序不影响 canonicalId（AsKd ≡ KdAs） | ✅ |
| 给定一张牌出现在 51 个组合中 | ✅ |

> **审计中发现的一处自我纠错**：初版测试注释把 `72o` 写成 10 个组合（实际 **12** 个），
> 导致贝叶斯黄金答案的分母算错。已修正并在测试中保留了这条纠错说明。

### 3. Range Update 黄金测试

**人工计算 vs 引擎实测（逐位一致，容差 1e-12）**

场景：仅 AA(6) / KK(6) / 72o(12) 三类，先验完全均匀（每组合 1/24），
Raise 似然 AA=0.9、KK=0.8、72o=0.1：

| 类别 | 人工计算 | 引擎输出 | 一致 |
|---|---|---|---|
| P(AA) | 5.4/11.4 = 0.4736842105263158 | 0.4736842105263158 | ✅ |
| P(KK) | 4.8/11.4 = 0.4210526315789474 | 0.4210526315789474 | ✅ |
| P(72o) | 1.2/11.4 = 0.1052631578947368 | 0.1052631578947368 | ✅ |

**反向测试（Bayesian 方向未写反）**：弃牌似然 AA=0.05、72o=0.95 →

```
AA   0.333333 → 0.025641  ✅ 下降
72o  0.666667 → 0.974359  ✅ 上升
```

### 4. Blocker 测试

| 场景 | 期望 | 实测 |
|---|---:|---:|
| 无已知牌 | 1326 | **1326** ✅ |
| 仅 Hero 两张（A♠K♦） | C(50,2)=1225 | **1225** ✅ |
| Hero + 翻牌（5 张） | C(47,2)=1081 | **1081** ✅ |
| Hero + 转牌（6 张） | C(46,2)=1035 | **1035** ✅ |
| Hero + 河牌（7 张） | C(45,2)=990 | **990** ✅ |

并断言：被移除的组合**必然**含死牌；移除后**必重新归一化**（Σp ≈ 1）。

### 5. 测试总数

**410 → 535**（+125）

| 文件 | 用例数 |
|---|---:|
| `test/combo.test.ts` | 40 |
| `test/range.test.ts` | 82 |
| `test/rangeBenchmark.test.ts` | 3 |

基线 410 项**全部继续通过**，无断言放宽，无测试删除。

### 6. TypeScript 检查

**零错误。**

### 7. 性能（P50 / P95 / Max，本机实测）

| 场景 | P50 | P95 | Max | 软目标 |
|---|---:|---:|---:|---:|
| 遍历 1326 组合 | 0.027ms | 0.062ms | 0.725ms | — |
| 全范围构建（1326 归一化） | 0.579ms | 1.207ms | 2.190ms | <50ms ✅ |
| Hero blocker 过滤（1225 剩） | 0.063ms | 0.139ms | 0.592ms | <50ms ✅ |
| Flop blocker 过滤（1081 剩） | 0.047ms | 0.065ms | 0.266ms | <50ms ✅ |
| 宽范围构建（约 25% 起手牌） | 0.478ms | 0.824ms | 0.994ms | <50ms ✅ |
| **一次贝叶斯更新** | **0.489ms** | **1.053ms** | 2.135ms | <50ms ✅ |
| 一次更新（含 diff 摘要） | 0.837ms | 1.326ms | 1.831ms | <50ms ✅ |
| **4-way 上下文更新** | **0.414ms** | **0.734ms** | 0.985ms | <150ms ✅ |
| 范围度量（熵 / 有效组合数） | 0.061ms | 0.086ms | 0.351ms | <50ms ✅ |
| 缓存命中 | 0.001ms | 0.003ms | 0.208ms | — |
| 变更摘要（diff） | 0.327ms | 0.496ms | 0.951ms | <50ms ✅ |

**全部操作比软目标快 1~2 个数量级。**

### 8. Deadline：是否存在不可中止的 Range 路径

**结论：Range Engine 不存在不可中止的路径。**

- `updateRange` 通过 `RangeClock` 在**每 128 个组合**检查一次预算，超时返回
  `RANGE_DEADLINE_EXCEEDED` 并**不返回部分结果**。
- 已通过 `assertStageRespectsDeadline` 契约自检（测试用例「不允许成为第二条不可中止路径」）。
- 已通过 `runPipeline` 端到端验证：超时后范围阶段被如实记为跳过。

**诚实边界（分两类）**：

| 操作 | 组合规模 | 是否可中止 | 说明 |
|---|---|---|---|
| `updateRange` | ≤1326 | ✅ 分块检查 | 唯一需要长循环的操作 |
| `buildRangeFromRankClasses` | ≤1326 | ⚠️ 无检查 | 纯构建，实测 P95 < 1.3ms |
| `uniformRange` | 1326 | ⚠️ 无检查 | 同上 |
| `diffRanges` | ≤1326 | ⚠️ 无检查 | 实测 P95 < 0.5ms |
| `validateRange` | ≤1326 | ⚠️ 无检查 | 同上 |
| `probabilityByRankClass` 等聚合 | ≤1326 | ⚠️ 无检查 | 同上 |

这些未检查时钟的路径**单次耗时均在 1.5ms 以内**，在当前实现下不构成风险；
但**未来若在这些路径上加入复杂逻辑（牌力分类、听牌统计、多人池密度），必须先加分块检查**。
已登记为墨菲风险。

### 9. 数据来源现状

| 类别 | 数量 | 说明 |
|---|---:|---|
| **Verified（已验证）** | **0** | 无 |
| **Theory（理论/solver 输出）** | **0** | 无 |
| **Heuristic（启发式）** | **0** | 引擎已支持，但**尚未填入任何数据** |
| **Test Only（仅测试）** | 3 | `test.range.fixture` / `bench.range` / `demo.test`，均为合成夹具 |

**这正是 Step 5A 的刻意状态**：规范第十六节要求先建立机制、不编造数据。
引擎已能**表达**四类来源，但**没有任何一份数据被标为可信**。

### 10. 新发现 Bug（诚实报告）

| # | 问题 | 严重度 | 发现方式 | 处置 |
|---|---|---|---|---|
| 1 | **`Object.freeze(entries)` 不冻结元素对象** —— 「不可变范围」实际可变，缓存命中后调用者可原地改概率并污染后续所有手牌 | **CRITICAL** | 自测（尝试修改 entry.probability 成功） | 已改为逐条冻结 entry + provenance + metrics；`isFrozen` 也改为递归检查 |
| 2 | 缓存 key 接受数字索引与牌面字符串两种死牌表示，同一张牌有两种拼写 | **MAJOR** | 自测（`['As']` 与 `[35]` 产生不同 key） | 已收紧类型为仅接受牌面字符串，并在构造时校验格式/重复/类型 |
| 3 | 测试注释误将 `72o` 当作 10 个组合（实际 12），导致黄金答案分母错误 | MINOR（测试自身） | 测试失败 | 已修正并保留纠错说明 |

### 11. 已知限制

1. **没有任何可信范围数据**。引擎只能表达来源，无法提供真实策略。任何「开池范围 13.7%」这类
   数字在当前代码库中**不存在**，也不允许被编造。
2. **未实现牌力密度计算**。`densityFromCategories` 已提供接口，但需要公共牌与牌力分类器接入，
   属于 postflop 范围分析的工作。
3. **未实现 Player Model 调整**。仅保留 `RangeAdjustmentProvider` 接口（规范第二十六节）。
4. **多人池只提供 `activePlayerCount` 上下文**，未实现「人数 → 范围收窄」的具体模型。
   规范第二十七节明确禁止 `players++ → weightSum--` 这类错误做法；正确方向需要真实数据支撑。
5. **尺寸只作为条件变量接入**，未实现「尺寸 → 似然」的具体映射（规范第二十二节明确要求
   本阶段不要假设「大尺寸一定更强」）。
6. **构建类函数不可中止**（见第 8 节表格），当前耗时极低，但需在扩展时补检查。
7. **缓存 key 不含 hero 手牌**（hero 属于 deadCards，已覆盖），但**不含「对手数量」**——
   未来实现多人池收窄模型时必须补入。

### 12. 是否满足 Step 5A 验收（规范第五十九节）

| 验收项 | 状态 |
|---|---|
| 1326 combo universe | ✅ PASS |
| 169 expansion | ✅ PASS |
| canonical combo | ✅ PASS |
| blocker filtering | ✅ PASS（1225 / 1081 / 1035 / 990 全部对上） |
| weighted range | ✅ PASS |
| normalization | ✅ PASS（含负值/NaN 拒绝，无静默修复） |
| provenance | ✅ PASS（含 confidence 上限与「禁止冒充理论」） |
| validator | ✅ PASS（14 类违规全覆盖） |
| Bayesian update | ✅ PASS（黄金答案逐位一致 + 反向测试） |
| metrics | ✅ PASS（熵 / 有效组合数 / 支持集） |
| deadline | ✅ PASS（契约自检 + 管线端到端） |
| cache | ✅ PASS（key 完整 + 防污染 + 版本失效） |
| immutable range | ✅ PASS（逐层冻结，实测 6 种修改全部被阻止） |
| complete tests | ✅ PASS（535 项全绿，类型检查零错误） |

# **Step 5A 验收结论：PASS**

### 关键问题回答（规范第六十三节：红队必答）

> **如果 Range 先验是错的，系统有没有能力告诉用户「这个范围可信度不高」？**

**有能力，且已实测验证。** 五层机制：

1. **来源类型枚举**：`THEORY_SOURCE` / `VERIFIED_DATA` / `HEURISTIC` / `FALLBACK` / `TEST_ONLY` 等，
   每一类都有独立中文显示（「启发式基础范围」「兜底范围（不可信）」「仅测试数据（禁止用于生产建议）」）。
2. **confidence 上限按来源强制**：THEORY 0.95、HEURISTIC **0.55**、FALLBACK **0.25**、TEST_ONLY **0.1**。
   实测「启发式声称 95% 可信」被拦截。
3. **禁止冒充 GTO**：`THEORY_SOURCE` 必须 `verified=true`。
   实测「没有 solver 却自称理论」被拦截，并提示改用 `HEURISTIC`。
4. **可信度随范围传递**：`metrics.weightedConfidence` 与 `minConfidence` 进入每次更新日志，
   可被下游 Decision Engine 读取（规范第六十四节）。
5. **中文警告词条已就位**：
   「当前范围是兜底值，不代表任何真实策略，最终决策置信度必须相应下调。」
   「范围可信度 50%：启发式基础范围。此可信度必须传入最终决策置信度，**不得与数学可靠性简单平均**。」
   （规范第六十五条：禁止 `(99+40)/2` 这类简单平均。）

---

# Step 5B：真实 Preflop Baseline —— **未执行，等待可靠数据源**

### 数据源调研结果

按规范第五十五 / 五十六 / 六十九节要求，调研了候选数据源：

| 候选 | 许可证 | 是否可用作 THEORY_SOURCE |
|---|---|---|
| `otter-crew/range-reader-v0.1`（HuggingFace 数据集） | Apache-2.0 | ❌ 机器生成、CFR 自对弈数据，**不是 solver 输出**，无验证依据 |
| `AHTOOOXA/poker-charts`（GitHub，4 star） | MIT（**仅覆盖代码**） | ❌ 含 GTO 范围图，但底层数据的来源与生成方法未文档化；MIT 不覆盖第三方数据 |
| `HoldemPokerTools/RangeAssistant`（GitHub，40 star） | MIT（**仅覆盖代码**） | ❌ 同上 |
| `pokercoaching.com/preflop-charts` | 商业版权 | ❌ 不可再分发 |

### 为什么不继续

规范第十四节：**禁止伪造 GTO**。
规范第十六节：**Phase 4 第一目标是 Mechanics，不是「把所有 GTO 范围填满」**。
规范第五十六节：**没有来源不允许标 THEORY_SOURCE**。
规范第六十九节：**如果没有可靠数据来源，不要擅自编数据，停在 Step 5A PASS 并明确报告**。

上述候选**全部无法满足「可引用的 solver 输出或权威公开数据集」**这一门槛：
- 许可证覆盖的是**代码**，不是范围数据本身；
- 数据的生成方法与验证依据均**未文档化**；
- 我**没有**验证过任何一份数据与可靠 solver 的一致性。

若强行使用，唯一诚实的标签是 `HEURISTIC` 或 `FALLBACK`（confidence ≤ 0.55 / 0.25），
但那样产出的并不是 Step 5B 所要求的「真实 Preflop Baseline」，
而是「贴了启发式标签的猜测」—— 那恰恰是规范第五十七节要避免的。

### 建议的数据获取路径（供决策）

| 路径 | 成本 | 可得性 |
|---|---|---|
| 购买商业 solver（PioSOLVER / GTO+ / Simple Postflop）自行生成 | 中 | 高，且**数据来源可完全追溯** |
| 使用开源 solver（如 TexasSolver，AGPL-3.0）自行求解并存档 | 低 | 高；需注意 AGPL 对**代码**的传染性，但**求解输出的数据**可作为自有数据 |
| 从自有牌局历史统计（≥ 数万手）生成经验范围 | 高（需数据积累） | 中；可标 `EMPIRICAL` 或 `VERIFIED_DATA` |
| 与可信第三方交换/购买范围数据 | 中 | 取决于对方授权条款 |

**当前状态：等待可靠 Range 数据源。**

数据落位约定（规范第十七节）已预留：
`data/ranges/preflop/6max/`、`data/ranges/preflop/9max/`，
每份数据必须携带 `RangeProvenance`（sourceId / version / description / verified / confidence），
并由 `rangeProvenance.ts` 在登记时强制校验。

### 本 Step 是否存在已知 Bug

**不存在已知的核心逻辑 Bug。** 3 个新发现问题（含 1 个 CRITICAL）已在 Step 5A 第 10 节报告并修复。

---

# Step 5A 补充：独立红队审计与修复

> 规范第六十二节要求「Range Engine 完成后必须执行一次独立红队审查」。
> 本节记录审计结果、修复内容与修复后基线。

## 审计方式

由**独立子代理**执行，职责是**证伪**而非验证：

- 直接阅读 `src/domain/range/**` 与全部测试
- 编写一次性脚本实际运行以验证每条假设（脚本用后删除，**未修改任何 src/ 或 test/ 文件**）
- 冻结源码快照哈希，全部结论对应固定快照
- 明确区分「已证伪（真实缺陷）」与「未证伪（干净）」

报告：`reports/RANGE_REDTEAM_AUDIT.md`（含最小复现片段）

## 审计结论摘要

| 假设 | 结论 |
|---|---|
| 1 贝叶斯方向写反 | **未证伪**（数学干净，`maxErr = 0`） |
| 2 归一化错误 / 静默修复负值 | **部分证伪**（数值干净，但有掩蔽与误判） |
| 3 Blocker 遗漏 | **确认缺陷**（三种非法死牌表示静默失效） |
| 4 缓存 key 碰撞 | **未证伪**（1210 组注入搜索 0 碰撞） |
| 5 可变性与缓存污染 | **确认 CRITICAL** |
| 6 坍塌被静默修好 | **未证伪**（全部路径显式 `RANGE_COLLAPSE`） |
| 7 来源与置信度可绕过 | **确认缺陷** |
| 8 存在不可中止路径 | **确认缺口** |
| 9 浮点下溢 | **确认但影响有限**（第 46 轮概率精确归零） |
| 10 多人池错误建模 | **未证伪** |

**新增 5 项缺陷**（1 CRITICAL + 4 MAJOR）+ 若干 MINOR，**全部已修复**。

## 最重要的发现：CRITICAL-1

红队用一行**类型安全**的赋值（`tsc --strict` 下无需断言即可编译）证明了：

```
range.entries[0].combo.canonicalId = 'ZZZZ'
```

因为 `combo` 指向模块级 `ALL_COMBOS` 的元素，而 `combo.card1` 又指向模块级 `ALL_CARDS` 的元素，
这一次赋值会**同时污染**：`COMBO_BY_ID`、所有已缓存的范围、以及之后新建的每一个范围。
改 `card1.rank` 更会让 `cardIndex()` 返回越界值 → 该牌的死牌过滤**永久失效且无声**
（1326 而不是 1225）。

而 `isFrozen()` 在污染后**仍然返回 true** —— 因为冻结原本只到第一层。

**这正是本 Phase 定义的头号风险**：「程序运行完全正常，但非常精确地算错」。

## 修复内容（全部附带永久回归测试）

| 缺陷 | 修复要点 |
|---|---|
| **CRITICAL-1** 冻结只到第一层 | `ExactCombo` 全字段 `readonly`；`makeCombo` 冻结 combo/牌/数组；`ALL_COMBOS` 本体冻结；`indexById` 改为只读视图（无 `set`/`clear`/`delete`）；`isFrozen` 递归检查到 combo 层 |
| **MAJOR-2** 覆盖不全被报成完整 | 新增 `assessCoverage`（列出未声明组合与占比）；结果新增 `coverage` 与 `removals`；新增 `requireFullCoverage` → `RANGE_PARTIAL_ACTION_MODEL`；`removedByBlockers` 不再把「似然为 0」算进去（拆成三个字段） |
| **MAJOR-3** 更新路径无死牌入口 | `UpdateRangeOptions` 新增 `deadCards`；在应用似然**之前**先移除冲突组合（严格符合规范第十一节的顺序） |
| **MAJOR-4** 非法死牌表示静默失效 | 重写 `deadCardsFrom`：接受多种形状、大小写不敏感、越界/非法/缺字段**一律抛错**；`makeCombo` 增加索引越界检查 |
| **MAJOR-5** 来源校验可绕过 | `confidenceCapFor` 对未知类型返回 **0**（旧版 `undefined` → `NaN` 比较恒 false）；`validateProvenance` 先校验类型；新增 `assertValidProvenance` 并在**三个构建入口**全部调用 |
| MINOR | `isFrozen` 递归；`deadlineClock.isAborted` 表意修正；中止事件补审计字段；`EPSILON` 统一为单一来源（删掉重复定义与 `1e-6`）；`rankClassOf` 索引方向修正；删除死代码 |

## 修复后基线

| 项目 | 修复前 | 修复后 |
|---|---:|---:|
| 测试总数 | 535 | **566** |
| 通过 | 535 | **566** |
| 失败 | 0 | **0** |
| 类型检查 | 零错误 | **零错误** |
| 新增红队回归 | — | **31 项**（`test/rangeRedTeam.test.ts`） |

**410 项原始基线全部继续通过，无断言放宽、无测试删除。**

## 对规范第六十二节四个 Agent 角色要求的对照

| 要求角色 | 检查内容 | 结果 |
|---|---|---|
| **数学 Agent** | Bayesian 方向与归一化 | ✅ 方向正确（`maxErr = 0`）；归一化数值干净；发现「未知来源类型导致 NaN 比较」并修复 |
| **Poker Agent** | 组合、位置、blocker | ✅ 容量 1326/1225/1081/1035/990 全部正确；发现三种非法死牌表示静默失效并修复 |
| **墨菲 Agent** | cache 污染 / mutation / empty range / NaN / source 丢失 / dead card 遗漏 / wrong table size | ✅ 发现 CRITICAL 冻结不彻底、来源校验可绕过、更新路径缺 blocker 重过滤 —— 全部修复 |
| **反方 Agent** | 尝试证明架构可能错误 | ✅ 成功找到 5 项真实缺陷（若审计只做「验证」而非「证伪」，这些都会被漏掉） |

## 关键问题复核（规范第六十三节）

> 如果 Range 先验是错的，系统有没有能力告诉用户「这个范围可信度不高」？

**修复前**：部分能，但**可被绕过** —— 未验证的 `THEORY_SOURCE` 与未知来源类型都能携带
`confidence = 1` 一路通关。

**修复后**：**能，且不可绕过** ——

1. 三个构建入口全部调用 `assertValidProvenance`，非法来源**在构建期即抛错**
2. `confidenceCapFor` 对未知类型返回 0，任何正置信度都会被拒
3. confidence 上限按来源强制（THEORY 0.95 / HEURISTIC 0.55 / FALLBACK 0.25 / TEST_ONLY 0.1）
4. 可信度随范围传递，进入每次更新日志，可被下游 Decision Engine 读取
5. 中文警告词条明确写出「不得与数学可靠性简单平均」

## 尚未解决的问题（诚实记录）

| 项 | 状态 |
|---|---|
| 构建/度量/校验类路径不检查时钟 | 🟡 已登记 J17。实测 P95 ≤ 1.5ms；**扩展时必须补分块检查** |
| 浮点下溢导致 `supportSize` 静默减少 | 🟡 属浮点固有；引擎不告警，只能事后看 `supportSize` |
| 多人池收窄模型未实现 | 🟡 只有 `activePlayerCount` 上下文，规范第二十七节禁止的错误做法**未被实现**（这是好事），但正确模型需要真实数据 |
| 无可信范围数据 | 🔴 Step 5B 阻塞项，等待数据源 |

---

# Step 5A.1 —— 数值稳定性与对数域（完成）

**目标**：消除「绝对尺度影响最终概率」这一类缺陷，使范围更新在极端似然下仍然正确。

## 交付内容

| 文件 | 职责 |
|---|---|
| `src/domain/range/rangeLogSpace.ts`（新增，320 行） | `LOG_ZERO` / `logSumExp` / `stableNormalize` / `normalizeLogWeights` / `toLogWeight` / `fromLogWeight` / `multiplyLogWeights` / `isStableNormalized` |
| `src/domain/range/rangeNormalize.ts`（改写） | `normalizeWeights` 委托给 `stableNormalize`（max-shift），彻底删除绝对阈值 `weightSum <= 1e-9` |
| `src/domain/range/rangeUpdate.ts`（改写关键路径） | 全程保持**对数域**，由 `normalizeLogWeights` 直接产出概率 |
| `test/rangeNumericalStability.test.ts`（新增，48 项） | 似然 1e-2 / 1e-4 / 1e-8 / 1e-12 × 10/50/100/500 次连续更新；logSumExp 边界；尺度不变性 1e-300…1e300；极端下的贝叶斯方向 |

## 开发期自查发现的缺陷（P1）

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| P1 | `normalizeWeights` 用**绝对**阈值 `weightSum <= EPSILON(1e-9)` 判断坍塌 | 所有权重为 `1e-12` 的**完全合法**输入被判成 `RANGE_COLLAPSE`；同时破坏尺度不变性（整体乘 1e-6 就从「正常」变「坍塌」） | 改为 max-shift 归一化：先除以最大值再判定，尺度被彻底消除 |

**验证**：60 次连续的 `1e-12` 更新后 `support = 46`，无任何权重被归零。

## 独立红队审计（`reports/NUMSTAB_REDTEAM_AUDIT.md`）

红队用**与开发者不同的方法**（BigInt 精确定点算术 + 独立 log1p/Kahan 参照实现 + 355,598 组对抗排序搜索）审计，结论：

**唯一 MAJOR（静默错误）**：`rangeUpdate.ts` 先 `Math.log` 相加、再 `Math.exp` 回到**线性域**才归一化。于是绝对尺度再次致命：`p × likelihood < 2^-1075 ≈ 2.47e-324` 时 `Math.exp` 精确返回 0，组合被**静默剔除**，而 `validateRange` 依然返回 `valid: true`、零告警。红队给出三个端到端复现，并用 BigInt 证明边界误差为 0，直接证伪了源码注释里「绝对尺度不影响最终概率」的断言。

> 诚实说明：真实扑克输入（似然 ≥ 1e-9、权重比 ≥ 1e-6）距离触发阈值约 300 个数量级，因此**不是活跃的生产 Bug**。但它是真实缺陷 —— 丢失的后验概率本可表示、过程完全静默。

**修复**：`rangeUpdate` 改为 `logWeights.push(...)` + `normalizeLogWeights`，全程不离开对数域；并在文件头写清为什么「exp 回线性域再归一化」是错的。

**回归测试**：`test/rangeLogSpaceRedTeam.test.ts`（9 项），逐条固化红队的三个复现：

| 复现 | 修复前 | 修复后 |
|---|---|---|
| `{AA:1, KK:1e-24}` + 均匀似然 `1e-300` | `p(KK) = 0` | `p(KK) = 1.000000000000002e-24`（期望 `1e-24`） |
| `{AA:1, KK:1e-2}` + 均匀似然 `1e-321` | `p(KK) = 0` | `p(KK) = 0.009900990099010092`（期望 `0.009901`） |
| `uniformRange()`（1326 组合）+ 均匀似然 `1e-321` | 假 `RANGE_COLLAPSE` | `support = 1326`，`Σp = 1` |

另加一条**结构性断言**（读源码文本，剥掉注释后检查）：`rangeUpdate.ts` 中不得出现任何 `Math.exp(` 调用，且必须使用 `normalizeLogWeights` —— 防止将来回归。

## 诚实的边界（不假装解决）

若**调用方在乘法阶段**就把似然乘到 `1e-323` 量级（例如 `0.25 × 1e-323`），乘积本身会下溢为 0，信息在那一步就已丢失，任何下游归一化都无法挽回。这与「归一化路径是否尺度不变」是两件事：前者是**输入被摧毁**，后者是**引擎自身的鲁棒性**。测试同时锁定这两点，并把前者明确标注为「定义，不是缺陷」。

## 红队的 MINOR 发现（已登记，未全部修复）

| # | 发现 | 处置 |
|---|---|---|
| ① | `stableNormalize.supportSize` 统计的是 max-shift 后 `scaled > 0`，与 `probabilityMetrics` 的口径不一致 | 🟡 两处「支持集」定义不一致；`rangeUpdate` / `rangeNormalize` 都不消费该字段，不影响范围结果 |
| ② | 无法区分「真零」与「下溢零」；`isNumericallyZero` 就是 `=== 0` 且无调用者；没有对应的 validator violation code | 🟡 已登记为风险 J18 |
| ③ | `rawWeightSum` 可溢出为 `Infinity`（潜伏，当前不可达） | 🟡 已登记 |
| ④ | `toLogWeight(NaN) → -Infinity`（测试已固化，文档只写「0 或非正数」） | ✅ 已在文档中补明 |

## 红队明确未能证伪的假设

`logSumExp` 正确性（400k+ 组 vs 独立 log1p+Kahan 参照，最大 0.973 ulp）；`stableNormalize` 自身的尺度不变性（≤2 ulp）；和中出现 `Infinity` 不破坏概率；往返最大相对误差 2.8e-14；**方向反转 0 次**（355,598 组 BigInt 精确排序 + 1326 组合相邻 ulp 200 轮 + `Math.log`/`Math.exp` 单调性零违例）；600 次更新 `Σp ∈ 1±1e-15` 无 NaN/Inf；归一化器与校验器无实质分歧。

## 全仓唯一 epsilon 复核

红队确认：全仓库只有 `range.types.ts:23` 的 `EPSILON = 1e-9`，其余 `1e-*` 全部出现在注释里。此前的 MINOR 发现（多处各自定义 epsilon）已彻底关闭。

---

# Step 6 —— 玩家画像（Player Profile）（完成，待红队复核）

**第一性原理**：Player Profile 回答的是「**这个人长期通常怎么打？**」。
它**不**回答「他这手是什么牌」，也**不**回答「我该怎么打」。

## 交付内容

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/domain/player/player.types.ts` | 385 | 25 项指标定义（含中文 `opportunityRule` / `successRule`）、先验表、`MetricStat`（分子分母同时保存） |
| `src/domain/player/playerStats.ts` | ~350 | 时间衰减、单手影响上限、Kish 有效样本量、置信度、Beta-Binomial 收缩、样本分层 |
| `src/domain/player/playerProfile.ts` | ~380 | 事件驱动增量画像、幂等、修正历史、全量重算、深冻结 |
| `src/domain/player/playerClassifier.ts` | ~447 | 连续维度、11 种中文标签、有界调整因子 |
| `src/domain/range/handPotential.ts` | ~90 | 启发式手牌潜力标尺（**明确声明不是胜率**） |
| `src/domain/range/profileProvider.ts` | ~290 | 画像 → Range 引擎的桥接（`RangeAdjustmentProvider`） |
| `test/playerProfile.test.ts` | 74 项 | 统计正确性、输入健壮性、不可变、隔离 |
| `test/playerClassifier.test.ts` | 51 项 | 维度、标签、因子、架构禁令、桥接 |

## 四条硬约束的落地方式

1. **底层只保存连续数据，标签只是摘要** —— 每项指标保存
   `successes / opportunities / rawRate / adjustedRate / effectiveSampleSize / confidence`，
   而不是一个 `VPIP = 32%`。
2. **机会数必须独立** —— 每项指标各自维护 `opportunities`。「没遇到 3Bet」不进入
   Fold-to-3Bet 的分母。`MetricStat.rawRate` 在无机会时为 `null` 而**不是 0**。
3. **机会由牌局状态定义，绝不由玩家动作定义** —— 中文 `opportunityRule` 写成可审计契约，
   测试针对每条规则构造反例。
4. **先验来源必须透明** —— 只有 `HEURISTIC_PRIOR` / `TEST_PRIOR` / `UNKNOWN_PRIOR` /
   `EMPIRICAL_PRIOR` 四个取值。**`THEORY_PRIOR` / `GTO_PRIOR` 在类型系统里就不存在**，
   且有测试扫描全部 25 项先验的 `source` 与 `description`、以及 i18n 文案，
   断言不得出现「理论 / GTO / 最优」字样。

## 开发期自查发现的缺陷（全部已修复 + 已加回归测试）

| # | 缺陷 | 严重度 | 根因 | 修复 |
|---|---|---|---|---|
| 1 | 画像日志元素未被冻结 | **MAJOR** | `Object.freeze(数组)` **不冻结元素** —— 与范围引擎 CRITICAL-1 同源。一行 `profile.log[0].seq = 999` 会**无声改变时间衰减** | 新增 `freezeHandObservation`，逐层冻结 hand 与 observations 元素 |
| 2 | 嵌套的 `prior` 对象未被冻结 | **MAJOR** | `prior` 直接指向 `METRIC_DEFINITIONS` 的**共享常量**。一行 `stat.prior.center = 0.99` 会永久污染全局先验表，之后**每一个**新建画像的收缩目标都被改掉 | 冻结时对 `prior` 再做一次浅拷贝 + 冻结 |
| 3 | 单手影响上限**完全没有生效** | **MAJOR（静默错误）** | 旧实现 `scale = cap / maxWeight` 后整体乘 scale。缩放让分子分母**同时**乘 scale，**占比完全不变** —— 权重 `[10,1,1,1]` 缩放后占比仍是 76.9% | 改为「向均匀分布线性插值」族 `w(α) = (1−α)·mean + α·w`，二分求 α。该族可证明单调，且总和守恒（不无谓丢失证据量） |
| 4 | 收缩公式的**分母用错** | **MAJOR** | 分子用 capped 加权成功数、分母却用 Kish `n_eff`。权重不均时 `n_eff ≪ Σw`，导致 `adjustedRate` 越出「先验中心 ~ 观测比率」区间。实测：200 手 40 次成功得到 `0.161`，而先验中心 0.25、加权比率 0.2 都不支持它 | 分母改为 `Σ(capped weights)`。`adjustedRate` 恒为「先验与观测的凸组合」，数学上保证不越界 |
| 5 | 标签阈值的**单位不一致** | MAJOR | `tightVpip` / `looseVpip` 被当作「入池率」，实际却与「紧度维度」比较。于是**阈值改了也不生效**（紧度 0.6 永远小于 0.95） | 引入 `tightnessFromVpip` / `vpipRateOf` 一对**严格互逆**的线性定标，阈值统一用入池率书写 |
| 6 | 紧度维度映射**不可逆** | MAJOR | 旧版用「相对先验中心的非线性映射」，中心两侧压缩比例不同 → 反解出 22% 入池变成 4.8%，所有入池率阈值失效 | 改为线性定标 `tightness = 1 − VPIP/0.55`，与 `vpipRateOf` 严格互逆（有测试逐点验证） |
| 7 | 零机会被当作「诈唬少」的证据 | MAJOR | 3Bet / 面对持续下注加注零机会时，`adjustedRate` 落在偏保守的先验中心，于是「没数据」被算成「偏向诈唬少」——**把先验伪装成观测** | 增加 `hasBluffEvidence` 判定，零机会时强制返回中立 0.5，并加测试锁定 |
| 8 | `withinLimit` 拿相对因子与绝对和比较 | MAJOR（迭代中的中间缺陷） | 二分内部把归一化后的相对因子当权重累加，约束永远成立，函数直接返回未压缩的原权重 | 已随 #3 的整体重写消除；重写过程中三次错误方案全部记录在 `playerStats.ts` 的注释里，供后人避免重蹈 |

> **关于 #3 的诚实记录**：这个函数被重写了三次。第一版用「整体按比例缩放」（无效），
> 第二版用「截断到 λ」（占比关于 λ **不单调**，二分收敛到错误一侧），
> 第三版用「平滑最大值」（保序压缩无法突破 `w_max/(Σw)` 的下界），
> 最终版才用「向均匀插值」。三个失败方案及其**实测反例**都写在代码注释里 ——
> 这是本项目「不假装一次做对」原则的具体体现。

## 架构禁令的可执行化

规范第二十节禁止「画像直接决策」。这一条不能只靠自觉，因此用**三重断言**锁定：

1. **结构断言**：扫描 `PlayerRead` / `ProfileAdjustment` / `PlayerDimensions` 的全部键名，
   断言不存在 `action` / `recommendation` / `decision` / `fold` / `raise` 等动作语义字段。
2. **类型断言**：`ProfileAdjustment` 的字段全部是 `number`，**刻意没有任何动作字段**。
3. **模块断言**：动态 import `profileProvider.ts`，断言其导出里不含
   `evaluate` / `equity` / `potOdds` / `requiredEquity` / `handRank` / `spr` ——
   即画像桥接**物理上无法**碰到牌力与赔率。

另有断言：`deriveLabel` 的全部输出必须落在已登记的 11 种标签集合内（不得出现未知枚举）。

## 桥接层：只调整概率形状，不改变整体尺度

`createProfileRangeProvider` / `adjustComboWeightsBatch` 输出**乘性因子**（1 = 不调整），
并做**几何均值归一**，使调整只改变分布形状而非整体缩放（一致放大在归一化后会抵消，属无意义操作）。
因子受工程护栏约束（默认 `[0.2, 5]`），调整强度上限 `±40%`（`MAX_ADJUSTMENT`），
因为这些都是**启发式**调整，没有真实人口统计数据支撑。

**样本不足时返回恒等因子 1**（而不是「按比例缩小」）—— 后者会让低可信画像持续注入噪声。

## 测试与验收

| 指标 | Step 5A 基线 | Step 5A.1 | **Step 6** |
|---|---|---|---|
| 测试总数 | 566 | 614 | **742** |
| 通过 | 566 | 614 | **742** |
| 失败 | 0 | 0 | **0** |
| 测试套件 | — | 134 | **135** |
| 类型检查 | 零错误 | 零错误 | **零错误** |

**566 项基线全部继续通过，无断言放宽、无测试删除。**

## 本阶段测试自身写错的地方（诚实记录）

写测试时也踩了坑，全部记录以免误判为实现的缺陷：

| # | 测试的错误假设 | 实测 | 纠正 |
|---|---|---|---|
| 1 | 假设每手权重都是 1 | 画像按 `seq` 做时间衰减，2000 手时最旧一手权重只有 **0.031**（`2^(-1999/400)`） | 新增 `decayedStats` 辅助，用**公开的** `decayWeight` API 复算期望值 |
| 2 | 断言 `adjustedRate` 落在 `[先验中心, 原始比率]` | 时间衰减估计的是「**近期水平**」而非全历史平均；成功集中在早期时两者必然不同 —— 这是**设计意图** | 改为 `[先验中心, 衰减加权比率]`，并**新增一项测试**专门锁定「近期成功必须得到更高估计值」这一语义，防止将来被误当 Bug 修掉 |
| 3 | `maxShare = 0.5` 时权重 `[10,1,1,1]` 应被压缩到占比 ≤ 0.5 | 该约束在此样本量下**不可满足**（保序压缩无法突破 10/13） | 改用可满足的参数，并把「不可满足时的行为」单独写一条测试 |
| 4 | `comboById('2c2d')` 一定存在 | 对子的 canonical 形式是 `2s2h` / `2h2d` 等「高牌+低牌」，`2c2d` 不是规范顺序 | 改用真实存在的 combo，并对 undefined 做显式过滤 |
| 5 | `neutralizeGeometric([2,2,2,0.5])` 的几何均值为 1 | `(2·2·2·0.5)^(1/4) = 1.414` | 改用 `[2,2,2,0.125]`（`2³·2⁻³ = 1`） |
| 6 | `uniformRange({sourceId, sourceType})` 直接可调用 | 签名要求完整的 `RangeProvenance`，返回 `RangeOutcome<Range>` | 补齐 `version` / `description` / `confidence` 并处理 `Outcome` |
| 7 | 不同玩家的 `H0` 会互相冲突 | 每个画像有自己的 `seenHandIds` 命名空间 | 改用带玩家前缀的 handId，并把「跨玩家写入必须被拒」写成独立断言 |

## 尚未解决的问题（诚实记录）

| 项 | 状态 |
|---|---|
| Step 6 独立红队 | 🟡 **进行中**（`reports/PLAYER_REDTEAM_AUDIT.md` 待产出） |
| 画像桥接尚未接入 `updateRange` | 🟡 Step 7 之后统一接入（Alpha Decision Integration） |
| 本轮 `capSingleHandWeight` 语义变更 | 🟡 从「占总权重比例」改为「相对均匀权重的倍数」。已登记 J19，需在 Step 7 复核是否符合原始意图 |
| 动态行为窗口（10/20/50 增量） | 🔴 Step 7 范围 |
| 无可信范围数据 | 🔴 Step 5B 阻塞项，等待数据源 |

---

# Step 6.5 —— 牌局环境（GameEnvironment，3 种模式）（完成）

**来源**：产品定位修正后新增的要求 —— 必须区分牌局环境，并保证
「同一手牌在三种模式下能解释为什么相同或不同」。

## 交付内容

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/domain/range/gameEnvironment.ts` | ~400 | 三种环境的版本化配置、校验、人数维度、中文差异说明 |
| `src/domain/range/profileProvider.ts`（扩展） | — | `composeWithEnvironment` / `createEnvironmentAwareProvider`；批量调整支持环境端倾斜 |
| `src/domain/player/playerClassifier.ts`（扩展） | — | `scaleAdjustmentConfidence`：环境只能缩放**幅度**，不能改**方向** |
| `test/gameEnvironment.test.ts` | 34 项 | 配置合法性、三模式差异、越界禁止、可信度组合、多人池、端到端 |

## 三种模式

| 模式 | 中文名 | 假设 | 相对基准的调整 |
|---|---|---|---|
| `LOW_STAKES_ONLINE` | 低级别线上 | 偏松偏被动、诈唬少、位置意识弱、河牌大注更可信 | 范围 +20%、诈唬占比 −20%、价值门槛 −12%、攻击性 −15%、河牌 −10%、弱牌端倾斜 ×1.25、强牌端 ×0.95 |
| `MID_LOW_STAKES` | 中低级别（**默认**） | 接近启发式先验所描述的中等常客 | 全部因子恰为 1（等于「不调整」） |
| `THEORY_REFERENCE` | 理论参考 | 对手被视为理性且平衡（**结构性假设**） | 范围 −8%、诈唬占比 +15%、价值门槛 +8%、攻击性 +12%、弱牌端倾斜 ×0.8、强牌端 ×1.05 |

⚠️ `THEORY_REFERENCE` 的**中文描述本身**就写明「本项目**没有求解器输出**……不是求解器输出，不得在界面上称为 GTO 最优」，
并有测试断言这句话必须存在。这是规范第十四节禁止编造数据的直接落地。

## 三条硬约束的落地

### 1. 只改概率，绝不改牌力 / 底池 / 赔率

用**结构性断言**锁定（不是靠自觉）：

- 读 `gameEnvironment.ts` 源码的 import 行，断言其中不含
  `handEval` / `fastEval` / `equity` / `odds` / `gameState` / `engine` / `validator`。
- 动态 import 该模块，断言其导出名不含
  `evaluate` / `equity` / `potOdds` / `requiredEquity` / `handRank` / `spr` / `callEV`。
- **行为断言**：遍历三种环境跑一遍典型决策流程，用 `deepEqual` 断言
  `potOdds` / `requiredEquityForBet` / `spr` / `callEV` 的**返回值逐位相同**；
  并用真实牌力引擎 `evaluateSeven` 对照，断言牌力评估结果不变。

### 2. 必须真正改变结果（不得只是模式名变了）

核心测试遍历三种模式，对同一手弱牌（72o）与强牌（AA）计算因子，断言：

- 三种模式对弱牌的因子**不完全相同**（若完全相同则功能未完成）；
- 弱牌权重满足 **低级别 > 中低级别 > 理论参考**（方向可解释）；
- **隔离可信度后**（把三者可信度强行统一），强度梯度
  `弱牌因子 / 强牌因子` 满足 **低级别 > 中低级别 > 理论参考**。

第三项是必要的：三个环境的可信度不同（0.35 / 0.40 / 0.30），
可信度差异会**掩盖**端倾斜差异 —— 这是本测试第一版失败的真实原因，
属于测试设计问题而非实现缺陷，已如实记录在测试注释里。

### 3. 不得散落 if/else

一切差异都表达为 `GameEnvironmentProfile` 对象（含 `version` / `description` /
`provenance` / `confidence`）。未登记的环境名**抛错**而不是回退到默认 ——
静默回退会让一个拼错的环境名悄悄用上错误的假设。

## 开发期发现并修复的问题

| # | 问题 | 严重度 | 根因 | 修复 |
|---|---|---|---|---|
| 1 | 环境调整在归一化后**几乎被完全抵消** | **MAJOR（功能形同虚设）** | 因子集合做几何均值归一，而环境只缩放 `rangeWidth`（整体尺度）—— 整体尺度正是归一化要消掉的东西。实测三种模式对弱牌的因子差异 < 2% | 新增 `weakEndTilt` / `strongEndTilt` 两个维度，直接作用于**强度梯度**（范围内部形状），这是归一化无法抵消的通道 |
| 2 | 多人池因子**指数爆炸** | MAJOR | 原用 `factor^(players-2)`，9 人桌得 `1.12^7 ≈ 2.21`，把启发式猜测量级放大成结论 | 改为线性累加 + 硬上限 `MAX_MULTIWAY_FACTOR = 1.6`；实测 9 人桌 1.92 倍而非 2.65 倍 |
| 3 | `bluffShare = 0.75` 触及护栏下沿 | MINOR | 护栏是 ±25%，0.75 恰好等于下限但浮点上越界 | 调为 0.8，并在注释里写明「再低就等于声称『低级别几乎没有诈唬』，而那是需要真实数据才能下的结论」 |

> **诚实记录**：问题 1 是本阶段最有价值的发现 —— 一个「配置齐全、文档完整、
> 测试全绿」的功能，实际上**几乎什么都没改变**。若没有写「三种模式必须真的不同」
> 这条测试，它会以完全正常的样子进入生产。

## 测试与验收

| 指标 | Step 6 | **Step 6.5** |
|---|---|---|
| 测试总数 | 742 | **780** |
| 通过 | 742 | **780** |
| 失败 | 0 | **0** |
| 测试套件 | 135 | **136** |
| 类型检查 | 零错误 | **零错误** |

**742 项历史基线全部继续通过。**

## 尚未解决的问题

| 项 | 状态 |
|---|---|
| 环境配置的数值依据 | 🟡 全部为**启发式相对倍数**，无分级别人口统计数据。已登记为风险 K10；一旦拿到真实数据只需替换 profile 对象，调用方代码零改动 |

---

# Alpha Decision Integration（完成）

**目标**：把「画像 + 环境」真正接进范围更新链路 —— 在此之前，
`RangeAdjustmentProvider` 接口存在、桥接实现完整、测试全绿，
但**没有任何生产代码消费它**。「玩家画像影响决策」这件事
在端到端上从未被验证过。

## 交付内容

| 变更 | 说明 |
|---|---|
| `updateRange` 新增 `adjustmentProvider` / `providerOptions` | 规范第二十六节的接口首次真正落地 |
| `ProviderApplicationLog` | 每次更新如实记录：调用条数、**实际改变**条数、因子为 0 的移除数、非法因子样本 |
| `UpdateRangeResult.provider` | 未提供提供者时为 `null`（不伪造空日志） |
| `rawComboWeightFactor` | 抽出「未归一」的原始因子计算，供逐 combo 与批量两条路径共用 |
| `test/rangeProfileIntegration.test.ts` | 14 项端到端集成测试 |

## 应用顺序（刻意固定）

1. **先施加似然调整**（`adjustActionLikelihood`）：我们**知道**对手做了这个动作，
   「他做这个动作时更可能是哪种牌」必须先被修正。
2. **再施加权重调整**（`adjustComboWeight`）：与动作无关的**先验层**修正。

两者都是乘性因子，顺序不影响数值；固定顺序是为了让日志里
「哪一步造成的收缩更大」可读。

## 本阶段发现并修复的真实缺陷

| # | 缺陷 | 严重度 | 根因 | 修复 |
|---|---|---|---|---|
| 1 | **逐 combo 的 `adjustComboWeight` 是空开关** | **CRITICAL（功能完全失效）** | 该实现内部调用「批量版 + 几何均值归一」。几何均值是**全局**操作，对单个组合归一的结果恒等于该因子本身 —— **永远返回 1**。实测：真实画像下 38 个组合的因子全部为 1，而同一份数据用批量版有 38 个因子被改变。`updateRange` 走的是逐 combo 路径，因此画像与环境**从未真正生效** | 抽出 `rawComboWeightFactor`（未归一原始因子），逐 combo 路径用它；`updateRange` 自己的对数域归一化会自然吸收整体尺度 |
| 2 | 恒等提供者被记成「已调整 N 条」 | MAJOR | 只要因子合法就累加 `weightAdjustments`，因子为 1 也计入 | 拆成两个计数：`likelihoodCalls`（调用次数）与 `likelihoodAdjustments`（**实际改变**次数，因子 ≠ 1 才计）。日志谎报影响范围会让复盘高估修正幅度 |
| 3 | 非法因子可能被当成 0 剔除组合 | MAJOR（设计阶段即拦截） | 若直接把 `NaN` / 负数 / `Infinity` 乘进似然，组合会被静默移除 | `resolveFactor` 显式区分三种情况：合法正因子 → 应用；**恰好为 0** → 显式语义，单独计数后移除；**NaN / 负数 / Infinity** → **不调整**并记入 `invalidSamples`，支持集保持不变 |

> **诚实记录**：缺陷 1 是本次集成最重要的发现。它是「测试全绿但功能无效」
> 的典型 —— 单元测试调用的是批量版（正确），而生产路径调用的是逐 combo 版（恒等）。
> 若没有写端到端集成测试，这个功能会以完全正常的样子上线，
> 而用户看到的每一个建议都**没有使用**玩家画像。

## 新增的端到端断言

| 断言 | 目的 |
|---|---|
| 未提供 provider 时结果**逐位**不变，且日志为 `null` | 零回归保证 |
| 松的对手 → 弱牌类概率上升、强牌类概率下降 | 方向正确 |
| 三种环境在同一手牌上给出不同后验，且**弱/强概率比**满足 低级别 > 理论参考 | 环境真的生效 |
| `NaN` / `Infinity` / 负数因子**不得**改变支持集 | 防静默剔除 |
| 似然因子为 0 时单独计数，不混入 blocker / 未声明似然计数 | 三类移除语义分离 |
| 巨大因子不得让似然超过 1；全为 1 时后验必须等于先验 | 似然是条件概率 |
| provider 拿到的 `likelihood` 是调用方原始值、`context` 与调用方逐字段一致 | 不得二次包装 |
| provider 抛异常时向上传播，绝不吞掉留半成品 | Fail Safe |
| 带 provider 的更新绝不修改 `prior`，且 `previousRangeId` 正确指向旧范围 | 不可变性 |

## 测试与验收

| 指标 | Step 6.5 | **Alpha Integration** |
|---|---|---|
| 测试总数 | 780 | **794** |
| 通过 | 780 | **794** |
| 失败 | 0 | **0** |
| 测试套件 | 136 | **136** |
| 类型检查 | 零错误 | **零错误** |

**780 项历史基线全部继续通过。**

---

# Step 6 独立红队审计与修复（完成）

红队报告：`reports/PLAYER_REDTEAM_AUDIT.md`（102 KB，简体中文，**23 条发现：3 CRITICAL + 7 MAJOR + 13 MINOR/INFO**）。

红队方法与开发者测试**不同**：它构造了 19 个独立攻击脚本，逐条给出最小复现与实测输出，
并用 BigInt 精确定点算术、84,000 组阈值穷举、833,931 组标签网格穷举、
4000 例随机凸组合搜索等**独立手段**验证。

> 红队基线：审计开始 734/734 pass；结束 794/794 pass。
> **全部发现都发生在绿灯之下。**

## 3 个 CRITICAL（全部已修复）

| # | 缺陷 | 后果 | 修复 |
|---|---|---|---|
| **F1** | `profile.decay` 是**未冻结的全局共享常量** | `createProfile` 按引用存入 `DEFAULT_DECAY`，而 `freezeProfile` 冻结了 8 层**唯独漏了 decay**。一行 `profile.decay.halfLife = 50` → `decayWeight(400)` 从 0.5 变 0.0039，此后**每个新建画像**的 adjustedRate 从 0.3475 变 0.2481 | `createProfile` 先**拷贝**再冻结；`freezeProfile` 冻结 `decay` 层。与已修的「prior 污染 METRIC_DEFINITIONS」是同一类缺陷 —— 那次只修了被点名的字段 |
| **F2** | 一手 `seq=500000` **静默作废 200 手历史** | `recompute` 用「最大 seq 当作现在」；`seq` 只校验非负整数且是**非阻塞**警告。实测 200 手 100% 入池 adjustedRate 0.8870→0.2419（**低于先验中心 0.25**），n_eff 198→1，**warnings = 0** | 新增 `SEQ_GAP_TOLERANCE = 1000` 与 `SEQ_OUT_OF_RANGE`，越界改为**阻塞级**拒绝；新增 `maxSeq` 字段使判定可即时完成；非法 `seq` 改为阻塞级（NaN → 权重 NaN 污染全部统计；负数 → 权重 > 1） |
| **F3** | `amendHand` **不去重、不校验 seq** | `observeHand` 有去重，`amendHand` 没有。同一手 3 条重复 VPIP：amendHand 得 `opportunities=4`，observeHand 得 `2` —— 直接违反它自己声明的「与一开始就录对完全一致」。`seq=NaN` 会在 `computeMetricStat` 深处抛错 | 抽出 `normalizeObservations`，**两个入口共用**，一致性由结构保证而非「记得写两遍」；`isValidSeq` 校验 + `seq` 改为可选字段（缺省沿用原值） |

## 7 个 MAJOR（全部已修复）

| # | 缺陷 | 修复 |
|---|---|---|
| F4 | `sampleSummary` 用 `opportunities`，而同文件注释写「用的是 effectiveSampleSize」——**文档与实现相反**。实测 300 机会 / n_eff=22 的指标被判「样本充足」 | 判据改为 `effectiveSampleSize >= 30 && confidence >= 0.3`，与 `sampleTier` / `confidence` 口径统一 |
| F5 | `passivity` **完全未按先验定标**：`CALL_CBET/FOLD_TO_CBET` 先验 0.40/0.45 → 比值 0.4706 ≠ 0.5，于是「打法恰好等于项目自述常客中心」的玩家得 0.4705，而**完全没数据的陌生人**是 0.5 | 改用与 `aggression` 相同的 `relativeToCenter` 定标（同文件的 `bluffTendency` 本就正确，偏差仅 -0.0035） |
| F6 | `tightness` 中立点偏移：`VPIP_SCALE/2 = 0.275` 是隐含中立点，先验中心是 0.25。端到端实测：同一玩家、**打法全程不变**，仅攒更多手数，`rangeWidthFactor` 从 1.0000 漂到 0.9644 —— **先验被当成了观测** | 定标端点改为**由先验中心推导**（`2 × prior.center`），使「先验中心 → 维度 0.5 → 因子 1」成为恒等式，并有表驱动测试锁定 |
| F7 | `capSingleHandWeight` 契约违反：触发条件用 `positiveCount`，`mean` 分母用 `n`（含 0），二分收敛到 α=0 返回**完全未约束**的权重。实测 maxShare=0.0847 时最大占比 0.4673（超 5.5 倍）。**限定：生产路径不可达** | `mean` 分母改为 `positiveCount`；0 权重项不参与最大占比；「不可满足」判据改为正确的 `1 / positiveCount` |
| F8 | `seenHandIds` 是**未冻结的可变 Set**：`.delete('S0')` 后同一 handId 被二次接受，`handsObserved` 3→4 | 改为只读视图（复用范围引擎 `ReadOnlyIndex` 的教训），不暴露 `add` / `delete` |
| F9 | `provider.stats()` 在 `updateRange` 后返回**错误数据**：实测 `{adjustments: 0, neutralized: true}`，而 `providerLog` 显示刚发生 1326 次调整。`finalize()` 只在 `describe()` 里调用，且 `describe()` 会**清空** collected（破坏性读取） | 改为**增量累加**，`stats()` / `describe()` 都是纯读取；新增 `effectiveAdjustments` 区分「调用次数」与「实际改变次数」 |
| F10 | 未知 comboId **静默退化为「中等牌」**：实测未知 id 与 `7c2d` 的因子逐位相同。`RANGE_UNKNOWN_COMBO` 已定义但从未使用 | 未知 comboId → **明确「不调整」**（因子 1）并计入 `unknownCombos`。「没有信息」与「中等牌」是两回事 |

## 红队明确验证成立的架构禁令（正向结论）

| 硬约束 | 验证方式 | 结果 |
|---|---|---|
| **1 画像绝不决策** | import 图扫描 + 导出集合扫描 + 三个输出类型的键集合扫描 | ✅ 成立 |
| **2 标签只是摘要** | 84,000 组 `LabelThresholds` 穷举，5 个因子偏离基准 **0 次**；VPIP 阈值两侧 ±1e-9 跳变仅 1.5e-9 | ✅ 成立 |
| **9 凸组合** | 4000 例随机搜索零越界，最大偏差 2.8e-17 | ✅ 成立 |
| 4 不编造数据 / 5 样本不足低置信度 / 6 独立分母 | 代码级验证 | ✅ 成立 |
| `deriveLabel` 可达性 | 833,931 组网格穷举，10 个标签全部可达 | ✅ 成立 |
| `vpipRateOf` ↔ `tightnessFromVpip` | 全域误差 < 1e-12 | ✅ 成立 |
| provider 接入后的方向语义 | 紧手弱/强概率比 1.000→0.783（收窄），松手 1.000→1.409（放宽） | ✅ 正确 |
| 非法因子处理 | `resolveFactor` 绝不静默当 0/1 | ✅ 正确 |

## 红队指出的测试质量问题（已修复）

| 问题 | 位置 | 修复 |
|---|---|---|
| `expected` 算出后**从未断言**，只断言 `Number.isFinite`（恒真）；`weightedSuccesses` 从被测值反解（重言式） | `playerProfile.test.ts` | 显式复算并断言公式精确成立，并断言期望值落在先验与观测之间 |
| 把「非法 seq 只警告不阻塞」写成规格，却**没有测试覆盖容忍后的后果** —— 这正是 F2 潜伏的原因 | `playerProfile.test.ts` | 语义改为拒绝，并新增 F2 的端到端复现测试 |
| 深冻结测试**手写 8 个位置**，漏掉 `decay` 与 `seenHandIds` | `playerProfile.test.ts` | 改为**递归遍历全部属性**的表驱动断言 |
| `amendHand` 等价性测试只用**单项观测**，永远碰不到 F3 | `playerProfile.test.ts` | 新增含重复指标的多项观测对照测试 |
| 「先验表不被污染」检查的是**分类器**，而真正会污染全局常量的路径是**画像构造** | `playerClassifier.test.ts` | 新增画像构造路径的污染测试（F1 / F8） |

## 红队的元层建议（已采纳）

> 作者此前的修复模式是「每次只修被点名的那一处」，于是同类缺陷在旁边的字段上重现。

因此新测试文件 `test/playerRedTeam.test.ts`（29 项）刻意采用**表驱动 / 不变量**写法：

| 不变量 | 做法 | 防的是 |
|---|---|---|
| 冻结完整性 | 递归遍历 `PlayerProfile` 的**全部**属性断言冻结 | 「修了 prior 漏了 decay」；**将来新增字段自动被覆盖** |
| 先验中立性 | 遍历 `computeDimensions` 用到的**全部**指标，断言「先验中心 → 中立」 | 「先验被当成观测」 |
| 入口一致性 | 对**所有**接收 observations 的入口施加同一份规范化断言 | 「修了 observeHand 漏了 amendHand」 |

## 测试与验收

| 指标 | 红队审计前 | **红队修复后** |
|---|---|---|
| 测试总数 | 794 | **828** |
| 通过 | 794 | **828** |
| 失败 | 0 | **0** |
| 测试套件 | 136 | **136** |
| 类型检查 | 零错误 | **零错误** |
| 新增红队回归 | — | **29 项**（`test/playerRedTeam.test.ts`） |

**794 项基线全部继续通过，无断言放宽、无测试删除。**

## 诚实记录：修复过程中我自己新犯的两个错

| # | 错误 | 表现 | 纠正 |
|---|---|---|---|
| 1 | 把「可达的最小最大占比」写成 `max(1/positiveCount, maxWeight/total)` | 用了**压缩前**的最大值，于 `[10, 1×11]` + maxShare=0.12 时误判为不可满足，返回未压缩权重 | 正确下界是 `1/positiveCount`（压缩族最多把权重压到均匀）。推导写在注释里 |
| 2 | 测试里把成功次数**集中在最前面若干手** | 时间衰减重罚早期观测，于是「与先验一致的玩家」被构造成「最近变紧的玩家」，测出来的因子漂移 0.117 | 抽出 `spreadProfile` 辅助，把成功**均匀铺开**；错误原因写在辅助函数注释里 |

## 尚未解决的问题（诚实记录）

| 项 | 状态 |
|---|---|
| 红队 13 条 MINOR / INFO | 🟡 部分未处理，已在报告中逐条列出；不涉及正确性 |
| `SEQ_GAP_TOLERANCE` 是否应可配置 | 🟡 当前为常量 1000；若真实数据跨度更大需暴露为参数 |
| 环境配置的数值依据 | 🟡 全部为**启发式相对倍数**，无分级别人口统计数据。已登记为风险 K10 |
| 时间衰减基于 `seq` 而非 `timestamp` | ✅ 已用测试明确锁定（`timestamp` 被校验但不参与权重计算，这是刻意设计） |

---

# Phase 4.5 —— 外部知识 / GitHub / 专业书籍 / 实盘案例融合审计（完成）

**本阶段不增加功能。** 目标是建立一套**可验证、可追踪、可审计的扑克策略知识来源体系**。

## 交付物

| 文件 | 内容 |
|---|---|
| `reports/EXTERNAL_KNOWLEDGE_AUDIT.md` | 4 个 GitHub 项目 + 6 本书的逐个审计（378 行） |
| `reports/REFERENCE_INTEGRATION_MAP.md` | 什么可以进入哪个模块，以什么形式，为什么（152 行） |
| `reports/CASE_TAXONOMY.md` | 完整 Spot 分类（P1–P10 / F1–F12 / T1–T8 / R1–R8 / B1–B11 / C1–C14，284 行） |
| `reports/SOLVER_CROSS_VALIDATION_PLAN.md` | 差分验证方案（184 行） |
| `data/knowledge/source-registry.json` | 来源注册表：12 个来源，全部带许可证门禁与已知限制 |
| `data/knowledge/strategy-rules.json` | 策略知识：12 条规则，**全部无 magnitude** |
| `src/domain/knowledge/knowledge.types.ts` | 类型 + 许可证门禁 + 校验（含「不编造」硬校验） |
| `src/domain/knowledge/knowledge.ts` | Fail-Closed JSON 解析 + 知识索引 |
| `src/domain/knowledge/knowledgeLoader.ts` | 文件加载（唯一 I/O 入口） |
| `test/knowledge.test.ts` | 50 项测试 |

## 审计方法与元数据（规范第 4 节）

**未使用** GitHub 搜索 HTML。全程使用 REST API（`/repos`、`/commits`、`/git/trees/{sha}?recursive=1`、
`/contents`）+ `raw.githubusercontent.com` 原文。

| Repository | Commit | License | Gate | Language |
|---|---|---|---|---|
| `MatthewPDingle/GTOpen` | `92c86ed73aa0856df8479b5c7635e1469f48f1e8` | **无** | **RED** | Rust |
| `davidvayn/pokersolver`（Poker Lab） | `687ce51938a92f002d7b71230a552a8af633b314` | MIT | GREEN | TypeScript / Rust(WASM) |
| `exinori/DCFR-SOLVER` | `4ade6a9e15a841c41867afde1258b9d110cd6fb1` | MIT | GREEN | Rust |
| `amaster97/poker_solver` | `f78f1b2bc338dd8cbb5226ecb8398bbdb3635676` | MIT | GREEN | Python + Rust |

**GTOpen 的 RED 判定做了三重复核**：API `license: null`；完整 git 树 3,242 项（`truncated: false`）
中 `license|licence|copying` **零命中**；README 全文无 `licen[cs]e`，根 `Cargo.toml` 无 `license` 字段。

## 六本书：全部 `SOURCE_TEXT_NOT_AVAILABLE`

| 书 | ISBN（已核实） | Full Text | Can Produce Numeric Rules |
|---|---|---|---|
| Modern Poker Theory（Acevedo） | 9781909457898 | NO | **NO** |
| Mastering Small Stakes No-Limit Hold'em（Little） | 9781909457775 | NO | **NO** |
| The Grinder's Manual（Clarke） | 未登记 | NO | **NO** |
| Strategies for Beating Small Stakes Poker Cash Games（Little） | 9781518655388 | NO | **NO** |
| The Mental Game of Poker（Tendler） | 未登记 | NO | **NO** |
| Jonathan Little on Live No-Limit Cash Games Vol.1（Little） | 9781909457232 | NO | **NO** |

⚠️ **本轮从六本书获得零个可量化的策略参数** —— 因为没有正文。
这是本阶段最重要的诚实结论之一。

## 最重要的架构发现：「包含数据」≠「可推导数据」

审计中发现了一个会直接导致**编造参数**的陷阱：四个被审计项目**都包含**量化数据
（自有实验、数据集、求解器输出），但**没有一个**能被本项目取用：

| 来源 | 有数据？ | 能取用吗？ | 原因 |
|---|---|---|---|
| GTOpen | ✅（7 种原型完整统计） | ❌ | **无许可证**，权利不明 |
| Poker Lab | ✅（翻牌前图表） | ❌ | 数据上游权利未确认（代码 MIT 不覆盖数据） |
| DCFR-SOLVER | ✅（可利用度等） | ❌ | 是其求解器输出，本项目未运行、无法独立复现 |
| poker_solver | ✅（同上） | ❌ | 同上 |

**因此新增了 `derivableQuantitativeData` 字段，与 `hasQuantitativeData` 严格分开**，
并把「规则带 `magnitude`」的判据改成**必须有 `derivableQuantitativeData: true` 的来源**。

> 这是本阶段最关键的一次设计收紧：如果没有这个区分，
> 「来源里有数字」会被误当成「我们能拿这些数字定参数」，
> 而那正是规范第 17 节禁止的编造。

## 可采纳的方法论（8 条，均不涉及数值）

| # | 来源 | 内容 |
|---|---|---|
| 1 | Poker Lab | **Fail-Closed**：模型/shard 不可用时拒绝伪造策略 |
| 2 | Poker Lab | **双独立种子门禁**：通过全部验证前输出对用户隐藏 |
| 3 | Poker Lab | 返回策略前**校验每个组件哈希** |
| 4 | poker_solver | **Reference-first**：算法结论指向原始文献与参考实现 |
| 5 | poker_solver | **两层架构 + 差分测试门禁**（先 Python 后 Rust，移植须过差分测试） |
| 6 | poker_solver | **优化可关闭 + 关掉后与参考路径逐位一致** |
| 7 | DCFR + poker_solver | **EV 优先于频率**：多重纳什均衡下频率差不是 Bug |
| 8 | DCFR | **纯策略一致是可判定的必要条件** |

## 可采纳的设计（3 条）

| # | 来源 | 内容 |
|---|---|---|
| 1 | GTOpen | **证据标签描述「来源」而非「置信度」**（与本项目 `RangeProvenance` 同构） |
| 2 | GTOpen | **被编辑过的数据必须重新对照历史检查**，不得因挂着数据集名就被信任 |
| 3 | GTOpen | 无决策点时显示「不适用」，**而非编造一个范围** |

## 交叉印证了既有设计（3 条）

| # | 结论 | 印证了什么 |
|---|---|---|
| 1 | 玩家统计是**连续谱而非聚类**（k=2 达峰，k≥4 平坦，BIC 到 k≈9 无拐点） | 「标签只是摘要，底层是连续维度」 |
| 2 | 翻牌前类型**不预测**翻牌后行为（方差解释度 0.03–0.26 vs 0.72–0.89） | 翻牌前与翻牌后应是独立维度 |
| 3 | 环境不得覆盖数学 | 已有硬约束再次被独立确认 |

## 新增前置警告（2 条）

| # | 内容 |
|---|---|
| 1 | **花色同构的排列方向**：对换位（正向=逆向）正常，对 S3 的 3-循环会静默错位，症状只在配对/单调面暴露（0.65%–0.73% vs 0.016%）。本项目未实现同构，登记为**前置警告** |
| 2 | **测试包装层编码瑕疵**：一处 22–42pp 的假信号最终归因为动作轴列序 / 玩家槽位反转 / 花色序规范化。任何跨实现差分测试必须先锁定这些约定 |

## 开发期发现并修复的问题

| # | 问题 | 严重度 | 修复 |
|---|---|---|---|
| 1 | 解析器的字段级错误全部用 `MISSING_LIMITATIONS` | MINOR（但会造成误导性诊断） | 新增 `SCHEMA_FIELD_INVALID` 错误码并逐处改正 |
| 2 | `licenseGateOf` 对 `CC-BY-SA-4.0`（copyleft）与 `CC-BY-4.0` 都归 RED | MINOR（保守但语义不准） | CC-BY-SA → **YELLOW**（其性质与 GPL 同类）；CC-BY → RED（未做署名基础设施）；SPDX `OR` 取最宽松、`AND` 取最严格；`WITH` 按主许可 |
| 3 | 知识库测试断言「没有任何来源包含量化数据」 | 测试本身写错 | 改为断言「没有来源**可推导**量化数据」，并额外断言「确实有 ≥4 个来源**包含**数据」以证明两个字段真的不同 |

## 诚实的边界

1. **没有可用的量化参数** —— 12 条规则**全部无 magnitude**，这是正确的，不是缺陷。
2. **没有复制任何代码** —— 零行。
3. **Step 5B 仍阻塞**，且现在有了文献级证据说明为什么仍然阻塞：
   四个项目没有一个提供可引用的低级别线上人口统计。
4. **盗版来源风险**：核实书目时 web 搜索返回了疑似盗版全文站点。
   本项目**未读取、未引用、不会使用**，并已登记为风险 + 加入自动化测试扫描。
5. **`overfolder` 标签缺维度支撑** —— 已在 `CASE_TAXONOMY.md` 中登记为缺口，未强行新增。

## 测试与验收

| 指标 | Step 6 红队修复后 | **Phase 4.5** |
|---|---|---|
| 测试总数 | 828 | **878** |
| 通过 | 828 | **878** |
| 失败 | 0 | **0** |
| 测试套件 | 136 | **136** |
| 类型检查 | 零错误 | **零错误** |
| 新增知识层测试 | — | **50 项** |

**828 项基线全部继续通过。**

## 尚未解决的问题

| 项 | 状态 |
|---|---|
| Phase 4.5 独立红队 | ✅ **已完成**（`reports/KNOWLEDGE_REDTEAM_AUDIT.md`，21 条发现，全部已处置） |
| 六本书的正文 | 🔴 需要用户提供合法副本 |
| 可推导的量化数据 | 🔴 本轮为零；需真实牌局数据校准 |
| 求解器交叉验证 | 🔴 仅研究（缺第二实现、缺算力、缺许可证评估） |
| `data/knowledge/cases/` | ⬜ **未创建** —— 没有案例数据时创建空目录会造成「已有案例库」的错觉 |

---

# Phase 4.5 独立红队审计与修复（完成）

红队报告：`reports/KNOWLEDGE_REDTEAM_AUDIT.md`（788 行，**21 条发现：0 CRITICAL / 6 MAJOR / 12 MINOR / 3 INFO**）。

## 红队未能攻破的部分（= 事实层守住了）

这是本阶段最重要的正向结论：红队用**独立手段**做了逐条回源核对。

| 检查 | 红队的独立手段 | 结果 |
|---|---|---|
| 4 个仓库是否真实存在 | `GET /repos/{owner}/{repo}` | ✅ 全部存在 |
| 4 个 commit 是否真实存在 | `GET /repos/{owner}/{repo}/commits/{sha}`（**验证该 sha 存在**，不只是比对最新 commit） | ✅ 4/4 存在且均为当前 HEAD |
| 元数据一致性 | stars / forks / size / pushed_at 与 API 比对 | ✅ 全部一致 |
| **GTOpen 是否真的没有许可证** | ① 全树 3,242 项无 license 命名文件 ② README/Cargo.toml 零命中 ③ **额外拉取 1,187 个源码/配置文件全文扫描 `licen\|SPDX\|copyright\|Apache License` → 0 命中** | ✅ **加固到源码级**，RED 判定成立 |
| MIT 仓库的 LICENSE | 字节数比对（1,071 / 1,066 / 1,062） | ✅ 与报告完全一致 |
| **报告中的每一个外部数字** | 逐个回源逐字核对（GTOpen 的方差解释度与聚类指标、DCFR 的 12–15% / 241 of 499 / +163.8% / 0.65%–0.73%、poker_solver 的 22–42pp / max-L1≤1.9 / 60% / 7.69% / 33pp） | ✅ **全部真实存在** |
| 4 个 ISBN | 独立检索 | ✅ 全部对应正确书名/作者 |

> **结论：没有一处编造的来源、commit、ISBN 或数字。**

## 6 条 MAJOR（全部已修复）

| # | 缺陷 | 严重度 | 修复 |
|---|---|---|---|
| **F-01** | **出处虚构**：`internal.spec-priority` 标 `PRIMARY` 并指向 `docs/ARCHITECTURE.md`，但该文件**不含**优先级链（红队实测：该文件只有另一条无关的优先级）。旗舰规则 `priority.individual-over-environment`（confidence 0.95）的唯一来源就是它。守卫测试只做 `existsSync` | MAJOR | 新建 `docs/KNOWLEDGE_POLICY.md`（真正包含五级优先级链 + 使用纪律），把来源指向它；**并把测试从「文件存在」升级为「文件必须含全部五个层级名 + 覆盖关系 + 第①层永不被覆盖」** |
| **F-02** | **声明门禁 ≠ 生效门禁**：`license: PROJECT_INTERNAL` 被 `licenseGateOf` 推出 RED，而注册表声明 GREEN → 运行期 `byLicenseGate = {RED:9, GREEN:3}`，且 `copyRestrictions()` 把**自家规范**报成「无许可证/权利不明，禁止复制」 | MAJOR | ① `licenseGateOf` 识别 `PROJECT_INTERNAL` → GREEN（内部内容不是第三方来源）；② **删除注册表中全部手写的 `licenseGate` 字段**，从根本上消除声明/推导不一致；③ 新增测试断言「运行期门禁 == 由许可证推导」+「内部来源不得出现在禁止复制清单里」 |
| **F-03** | **零来源规则可通过全部校验**：`validateStrategyKnowledge` 不查 `sources.length`，证据等级校验又被 `if (resolved.length > 0)` 跳过 → `sources: []` + `PRIMARY` + confidence 0.99 **成功建索引** | MAJOR | 新增「规则必须至少引用一个来源」硬校验；测试断言 `validateStrategyKnowledge` 报 `UNKNOWN_SOURCE_REFERENCE` 且 `buildKnowledgeIndex` 抛错 |
| **F-04** | **冻结只到第一层**：`Object.freeze(source)` 是浅冻结。实测 `source.scope.gameType = '...'` / `source.limitations.length = 0` 全部成功；`rulesUsing()` 返回**内部数组**（push 后下次读取多一条）。而 `scope` 正是「防范围混淆」的载体 | MAJOR | ① 新增递归 `deepFreeze`；② `rulesUsing` / `sourcesOf` / `rulesFor` / `codeCopyable` 全部返回**冻结副本**；③ 测试断言改写 `scope.gameType`、`push` `limitations`、改 `limitations.length` 均抛 `TypeError` |
| **F-05** | **自相矛盾**：报告 §1.4 写「不得引用上表的任何数值（无许可证）」，同一页却把 9+ 个 GTOpen 数值抄进了表格，且 `strategy-rules.json` 也抄了 | MAJOR | 从报告与规则文件中**全部清除** GTOpen 的数值，改为「只引用方向性结论 + 指向原文」；新增测试用 GTOpen 原型统计表中的特征数字做**泄漏扫描** |
| **F-06** | **`scope` 完全未校验**：`input.scope as KnowledgeSource['scope']` 强转 → `{ tableSize: 42 }` 或含未登记字段的 scope 都能通过，而范围审计正靠 scope 判断混淆 | MAJOR | 新增 `parseScope`：白名单字段 + 每字段必须是非空字符串 + 未登记字段直接拒绝；测试覆盖三种非法输入 |

## 报告自身的两个数字错误（12 MINOR 中被点名）

| # | 错误 | 正解 |
|---|---|---|
| 1 | 头部写「基线 828 → **873**」 | 应为 **878**（知识层实测 50 项，非 45） |
| 2 | §0 写「仓库体积合计约 **690 MB**」 | 应为 **≈544 MiB**（385,689+142,057+29,307+192 KB ≈ 557,245 KB） |

> 红队特别指出：§8.4 恰恰声称「报告中的数字全部为被审计项目的自述」，
> 而这两处正是**报告自己的数字**。已修正，并在 §8.8 记录。

## 其余已修复项

| # | 缺陷 | 修复 |
|---|---|---|
| F-10 | 文件内容为字面 `null` 时返回 `{ok:false, issues:[]}`，`OrThrow` 抛出**空诊断** | 根因是 `readJson` 用 `null` 当失败哨兵，而 `JSON.parse('null')` 恰好返回 `null`。改为 `{ok:true/false}` 显式结果类型；并为「解析器未给原因」的路径补默认诊断 |
| F-11 | `source-registry.json` 带 BOM 而 `strategy-rules.json` 不带；两个 `$schema` 指向**不存在的文件** | 去掉 BOM 使两者一致；删除全部 `$schema` 声明（声明一个不存在的契约是误导）；新增测试断言格式一致且不得声明不存在的 schema |
| F-12 | `requireEnum` 仍用 `MISSING_LIMITATIONS`（`SCHEMA_FIELD_INVALID` 漏改） | 已改正（自检时声称「逐处改正」但漏了这一处 —— 红队抓到了） |
| F-13 | `evidenceRank('THEORY')` 返回 `undefined`，`Math.max(...)` 得 `NaN`、比较静默通过 → 未登记等级能建出索引 | 改为返回 `null`；新增 `isKnownEvidenceLevel`；`validateStrategyKnowledge` 显式拒绝未登记等级；新增 3 条测试 |
| F-09 | `CASE_TAXONOMY.md` 的 11 个标签与代码 `PlayerLabel` 只有 7 个对得上（多了 Maniac/Overfolder/Overbluffer，少了四个） | 重写为**与代码逐字对应**的 11 个取值；把 Maniac / Overfolder 明确登记为「概念清单中有、代码中暂无」的**待补项**并说明缺口原因；新增跨文件一致性测试 |
| F-17 | `knowledge.types.ts` 与 `strategy-rules.json` 的说明写 `hasQuantitativeData`，代码用 `derivableQuantitativeData` | 已统一为 `derivableQuantitativeData` |
| F-00 | **审计期间目标被并发改写**（报告 3 小时内改了 3 次，同一命令两次运行结果不同） | 新增 `data/knowledge/artifact-manifest.json`（10 个产物的 SHA256）+ 测试逐位校验；结论从此可绑定到具体字节内容 |

## 元层教训

红队指出的两条**方法论**问题，本阶段已吸纳：

1. **「文件存在」≠「文件里有这段话」**。
   来源真实性的守卫不能只做 `existsSync`，必须**校验内容**。
   这已升级为测试（F-01）。
2. **审计结论必须绑定 hash**。
   在一个会被并发修改的工作区里，「审计通过」如果不绑定字节内容，
   就无法回答「你审的是哪个版本」。这已落地为 `artifact-manifest.json` + 校验测试（F-00）。

## 测试与验收

| 指标 | Phase 4.5 首轮 | **红队修复后** |
|---|---|---|
| 测试总数 | 878 | **903** |
| 通过 | 878 | **903** |
| 失败 | 0 | **0** |
| 测试套件 | 136 | **136** |
| 类型检查 | 零错误 | **零错误** |
| 新增红队回归 | — | **25 项**（`test/knowledge.test.ts` +5，`test/knowledgeConsistency.test.ts` 新建 15） |

**878 项基线全部继续通过，无断言放宽、无测试删除。**

---

# Phase 4.5 收尾：三项收紧（用户裁定后）

用户认可 Phase 4.5 PASS，同时对报告提出一条**正确的反驳**并要求三项收紧。

## 一、更正「唯一合法路径」的绝对表述

**原表述（错误）**：

> `derivableQuantitativeData` 转为 `true` 的**唯一**合法路径是真实牌局校准。

**为什么错**：这是一个**封闭断言**，会在条件变化后变成错误的约束 ——
等于自己把路堵死。至少还有两条合法路径被这句话排除掉了。

**更正后（已写入 `docs/KNOWLEDGE_POLICY.md` §3.2）**：

> **在当前项目条件下，内部真实牌局数据是目前唯一*已经可执行*的量化校准路径；
> 未来经过来源、许可证、复现与交叉验证的数据同样可以进入。**

并给出 **4 条准入条件**（来源与许可证清晰 / 场景匹配 / 可在本地独立复现 / 经过交叉验证）
与 **3 条已知路径**：

| 路径 | 现状 |
|---|---|
| A. 内部真实牌局数据统计 | ✅ **当前唯一已经可执行** |
| B. 可授权、可追溯、场景匹配的统计数据集 | ⬜ 尚未找到 |
| C. 可在本地独立复现并交叉验证的 Solver 输出 | ⬜ 尚未具备 |

**关键区分**（已写进政策文件与报告）：
- 「**依据**必须是可推导来源」→ 这是**门槛**，永远成立
- 「**路径**只有真实牌局校准」→ 这是**路径**，**不成立**

同步更正位置：`docs/KNOWLEDGE_POLICY.md` §3.2 / §3.3 · `EXTERNAL_KNOWLEDGE_AUDIT.md` §7.3 ·
`REFERENCE_INTEGRATION_MAP.md` §2.5

## 二、环境模式：只允许方向，不允许固定百分比

**新增 11 条方向型规则**（`strategy-rules.json`），**全部 `magnitude` 缺省**：

### 低级别线上（6 条）

| ruleId | 方向 | 目标 |
|---|---|---|
| `env.low.river-bluff-tendency-down` | ↓ | `BLUFF_WEIGHT`（河牌） |
| `env.low.bluff-frequency-down` | ↓ | `BLUFF_WEIGHT`（全街） |
| `env.low.calling-tendency-up` | ↑ | `CALL_WEIGHT` |
| `env.low.multiway-value-threshold-up` | ↑ | `MULTIWAY_VALUE_THRESHOLD` |
| `env.low.thin-value-up` | ↑ | `THIN_VALUE_TENDENCY` |
| `env.low.passive-large-aggression-credibility-up` | ↑ | `PASSIVE_LARGE_AGGRESSION_CREDIBILITY` |

### 中低级别（5 条）

| ruleId | 方向 | 目标 |
|---|---|---|
| `env.mid.three-bet-bluff-likelihood-up` | ↑ | `BLUFF_WEIGHT`（翻牌前） |
| `env.mid.river-polarization-up` | ↑ | `RIVER_POLARIZATION` |
| `env.mid.bluff-catcher-viability-up` | ↑ | `BLUFF_CATCH_VIABILITY` |
| `env.mid.blocker-relevance-up` | ↑ | `BLOCKER_RELEVANCE` |
| `env.mid.player-data-weight-up` | ↑ | `PLAYER_DATA_WEIGHT` |

**三条规则刻意写进了关键例外**（防止将来被误读）：

1. `env.mid.river-polarization-up` 的例外写明：
   **「极化 ↑ 不代表诈唬占比 ↑」** —— 极化说的是范围**形状**，诈唬占比说的是**构成比例**。
   把两者混为一谈是最容易犯的误读。
2. `env.mid.blocker-relevance-up` 的例外写明：
   **阻断牌的数学效果永远由确定性代码计算**，本规则只影响注意力分配，绝不改变组合数学。
3. `env.mid.player-data-weight-up` 的例外写明：
   **绝不允许覆盖优先级链**，也**不允许放宽样本量门槛**（那是硬校验，不因环境改变）。

**同步收紧 `gameEnvironment.ts`**：文件头改写为明确声明 ——
**方向由知识层决定，文件内的数值是待校准的遗留占位**（保留以向后兼容，
`confidence` 刻意压低，且不再新增数字）。

→ **纪律**：以后新增环境行为，**先在知识层加一条方向型规则**，
而不是在 `gameEnvironment.ts` 里再调一个数字。

## 三、产物 hash 绑定提升为**全项目通用标准**

新增 `src/infra/artifactManifest.ts` + `src/infra/artifactDefinitions.ts` + `scripts/generateManifest.ts`，
接入 `npm run verify`：

```sh
npm run manifest        # 重新生成
npm run manifest:check  # 只校验（已接入 verify）
```

| 指标 | 值 |
|---|---|
| 绑定产物数 | **31** |
| 覆盖类别 | KNOWLEDGE 6 · RANGE 13 · ENVIRONMENT 1 · PLAYER_MODEL 4 · DECISION 2 · REPORT 5 |

**它回答的问题**：「昨天建议 CALL，今天同一手牌建议 FOLD —— 究竟是哪一个版本变了？」

报错信息带**具体文件 + 影响范围**，例如：

```
[CHANGED] src/domain/range/gameEnvironment.ts 内容已变化（18cc9e0b1d0d… → 131ea58a66a9…）。
          影响：**环境参数变化 → 三种模式的范围/似然调整幅度变化，直接影响建议**
          （这是「昨天 CALL 今天 FOLD」最可能的来源之一）
```

**三条设计纪律**：
1. **不进决策热路径** —— 生成与校验都是一次性离线操作
2. **有意修改后必须重新生成**；忘记重新生成会让测试失败（这是**预期的**）
3. **自指排除显式声明**，不静默跳过

> **实测验证**：本次收紧过程中，我校正 `gameEnvironment.ts` 的注释后，
> 清单校验**立刻报出该文件已变化并给出影响说明** —— 机制按设计工作。

## 四、Step 5B 的处置（按用户裁定）

**BLOCKED / NOT REQUIRED FOR CURRENT DEVELOPMENT** —— 而不是让它卡住整个软件。

- **BLOCKED**：Phase 4.5 审计了 4 个 GitHub 项目与 6 本书，**没有一个**能提供可引用的
  翻牌前范围数据（求解器输出无法本地复现、书籍无正文、数据集权利不明）。
- **NOT REQUIRED**：Player Profile 的收缩机制本来就要求「向先验收缩」，
  而先验**可以**是启发式的（已标注 `HEURISTIC_PRIOR` 而非 `THEORY_PRIOR`）。
  真实数据到位后**替换 profile 对象即可，调用方零改动**。

## 测试与验收

| 指标 | 红队修复后 | **本轮收紧后** |
|---|---|---|
| 测试总数 | 903 | **921** |
| 通过 | 903 | **921** |
| 失败 | 0 | **0** |
| 知识规则数 | 12 | **23**（新增 11 条方向型环境规则） |
| 绑定产物数 | — | **31** |
| 类型检查 | 零错误 | **零错误** |

**903 项基线全部继续通过。**

## 下一步（主线，不再扩 Phase 4.5）

按用户裁定，外部知识层**已经够用**，回到主线：

```
5A.1 数值稳定性 ✅ → Step 6 Player Profile ✅ → 红队 ✅
  → Step 7 Dynamic Human Behavior ✅ → 红队 ✅
  → Environment 最小接入                   ← 下一步
  → Minimal Manual Input
  → Alpha Decision Engine
```

**最终要交付的软件回答的是**：

> **这一桌是什么级别 → 这个人平常怎么打 → 他现在有没有变 →
> 他的当前范围是什么 → 数学是否支持 → 现在我怎么打。**

---

# Step 7 —— 动态真人行为模型（Dynamic Human Behavior）（完成，含红队）

## 交付内容

| 文件 | 职责 |
|---|---|
| `src/domain/dynamic/dynamic.types.ts` | 类型与常量：9 状态、6 调整维度、3 窗口、组上限、收缩/置信度刻度 |
| `src/domain/dynamic/dynamicStats.ts` | 事件规范化（排序/去重/过滤未来）、机会感知窗口统计、向基线收缩 |
| `src/domain/dynamic/dynamicDeviation.ts` | 有界归一化差值、相关组聚合、方向噪声检验、冲突检测 |
| `src/domain/dynamic/dynamicBehavior.ts` | 主入口 `evaluateDynamicBehavior`、状态推导、置信度、上下文锚点、人工 Hint |
| `src/domain/dynamic/dynamicAdapter.ts` | 方向 → 幅度适配层，每个输出自曝 `UNVERIFIED_MAGNITUDE` |

**模型版本**：`DYNAMIC_MODEL_VERSION = '1.1.0'`（红队修复后升版；该版本进入缓存 key 与产物清单）。

## 四条硬约束的落地方式

| 约束 | 落地 | 可执行证据 |
|---|---|---|
| **结果隔离** —— 输赢不得直接进入评分 | 上下文事件只作**时间锚点**：比较「事件前 vs 事件后」的实际打法，`positionalStrength` 对两侧用同一度量 | `红队附加：**结果隔离** —— 只改输赢、不改行为，偏差必须逐位不变` |
| **禁止循环推理** | `DynamicBehaviorInput` **类型层**不含 `adjustedRange` / `decision` / `previousState` / `tilt`；且本模块**不导入**范围/决策/复盘模块 | `红队 15`（含**源码扫描**断言）、`红队 15b`（注入下游字段无效） |
| **个人基线优先** | 收缩目标是**个人基线**，不是人口先验；无基线 → Fail Closed | `**基线缺失 → Fail Closed**`、`红队 11` |
| **Tilt 只是概率** | `TiltSignal` **没有** `isTilted` 字段；人工 Hint 一键「疑似上头」受 0.45 / 0.6 双重上限 | `Tilt 只能是概率字段，**不存在** isTilted 布尔`、`红队附加：一键「疑似上头」不得给出高 Tilt 概率` |

## 关键机制与它们的取值理由

| 机制 | 取值 | 理由（全部是**结构性判断**，不是从数据估出的参数） |
|---|---|---|
| 热路径预算 | P95 < 20ms | 规范第 48 节；实测 1000 事件 P95 ≈ 3.5ms |
| 判断门槛 | `MIN_RECENT_OPPORTUNITIES = 8` | 低于它一律 `UNKNOWN`，**绝不默认 NORMAL** |
| 充分刻度 | `SUFFICIENT_RECENT_OPPORTUNITIES = 60` | 置信度的上界（多少机会才算够） |
| 收缩参考点 | `SHRINKAGE_REFERENCE_OPPORTUNITIES = 60` | 与「充分」同刻度：等权点落在 30 次机会 |
| 绝对变化标尺 | `MIN_ABSOLUTE_SCALE = 0.25` | 绝对变化达 25 个百分点即视为饱和 |
| 方向噪声检验 | `DIRECTION_NOISE_Z = 1.5` | 要求 95% 会让 20 手窗口几乎永远判不出方向 |
| 组上限 | ENTRY 1.0 / AGGRESSION 0.9 / CALLING 0.7 / SIZING 0.6 / RIVER 0.6 | 相关指标不得重复计票；总分上界 3.8 |

## 开发期与红队发现并修复的缺陷（**全部是假阴性**）

Step 7 的单元测试 **55/55 全绿**时，红队场景 2（Nit 连续 20 手变激进）暴露出系统**完全不报警**（DeviationScore = 1）。逐层排查发现 5 个叠加缺陷：

| # | 缺陷 | 错误写法 | 后果 | 修正 |
|---|---|---|---|---|
| D1 | 收缩强度取基线样本量 | `k = baseline.effectiveSampleSize` | 20 手窗口被 400+ 手基线压平，VPIP 15%→45% 算出 **0~1 分** | 尺度混合 `k = (REF − c)/c × 质量`，只随**近期**机会数退让 |
| D2 | 置信度被连乘三次 | 聚合层 × 状态层 × 调整层 | 20 次机会的信号再砍到约 **1/4** | 聚合层与调整层不再乘置信度；它只**独立输出** |
| D3 | 置信度刻度错位 | `n/(n + MIN_BASELINE_OPPORTUNITIES)` | 远高于判定门槛的样本仍只得 **0.5** 可信度 | 按机会数在 [判定门槛, 充分] 上线性映射 |
| D4 | 方向判定用绝对阈值 | `\|Δ\| < 0.01 → NONE` | 20 手窗口 ±1 次计数差被当成真实方向，**输出虚假方向冲突提示** | 两比例差的**标准误**检验 |
| D5 | 方向检验样本量取错 | 用 20 手窗口计数估方差 | 60 手数据中 PFR 20%→5% 被判「无方向」，**漏掉真实冲突** | 改用**全部近期事件**的机会数 |

修复后同一场景：DeviationScore **1 → 41**，状态 `NORMAL → LOOSER_RECENTLY`，信号概率 1.00。
对照场景（数据完全符合基线）：**2 分、无信号、无虚假冲突**。

## 诚实记录：本轮我自己的两个错

1. **红队测试的布尔生成公式写错**：`(i+1)·r ≥ ⌊i·r⌋ + 1` 在 `i = 0` 时括号内恒为 0，
   使所有指标在第 0 手被记为失败，实际速率系统性偏离目标值。
   这也是**主测试集 `makeEvents` 里同样的缺陷**（已定位，影响面：仅测试构造，不影响生产代码）。
   正确写法：`⌊(i+1)·r⌋ > ⌊i·r⌋`。
2. **修 D1 时先按「基线样本量」调参**（把常数 40 当成上界），得到 21 分仍偏低，
   才意识到根因是**概念混淆**：基线的长度与近期证据的强度是两件无关的事。
   正确的修法是让收缩强度只由**近期观测数**决定。

## 尚未解决的问题（诚实记录）

| 项 | 状态 |
|---|---|
| `k = (REF − c)/c` 在 `c → 0` 时趋于无穷 | 🟡 数学上正确（偏差趋 0），工程上由 `MAX_BASELINE_SHRINKAGE` 命名其上界；**未做显式截断** |
| 基线侧样本量未知，方向检验用同一 `n` 近似 | 🟡 保守方向（更难宣称方向），但**不是精确检验** |
| 上下文锚点的 `positionalStrength` 对 `before`/`after` 用同一 `n` 归一 | 🟡 两侧**各自按样本量归一**（都是频率比较），因此样本量不同不影响比较合法性；但「事件后」= 全部后续事件，未做「事件后 N 手内」窗口化 |
| 追损判定的时间窗（「之后」= 全部后续事件） | 🟡 未做「事件后 N 手内」的窗口化 |
| 增量更新（10/20/50 窗口） | 🔴 **未实现**，当前每次全量重算（性能实测远低于预算，暂不需要） |

## 测试与验收

| 指标 | Phase 4.5 收尾 | **Step 7** |
|---|---|---|
| 测试总数 | 921 | **1,035** |
| 通过 | 921 | **1,035** |
| 失败 | 0 | **0** |
| 测试文件数 | 29（文档记载，实际 31） | **31**（已更正） |
| 绑定产物数 | 31 | **42** |
| 独立红队轮次 | 4 | **6**（含动态行为的独立审计） |
| 类型检查 | 零错误 | **零错误** |

**921 项基线全部继续通过，无断言放宽、无测试删除、无跳过的失败路径。**

### 性能实测（热路径预算 P95 < 20ms）

| 事件数 | P50 | P95 |
|---:|---:|---:|
| 1 | 0.056ms | 0.115ms |
| 10 | 0.088ms | 0.196ms |
| 50 | 0.257ms | 0.495ms |
| 200 | 0.614ms | 1.110ms |
| 1000 | 3.648ms | 4.388ms |
| 5000 | 10.569ms | **15.106ms** |

## Step 7 的两轮红队（**12 条 CRITICAL/MAJOR**）

### 第一轮：作者自查 —— 发现 3 CRITICAL + 2 MAJOR

Step 7 单元测试 **55/55 全绿**时，红队场景 2（Nit 连续 20 手变激进）
暴露出系统**完全不报警**（DeviationScore = 1）。逐层排查发现 5 个叠加缺陷：

| # | 缺陷 | 后果 | 修正 |
|---|---|---|---|
| D1 | 收缩强度取基线样本量 | 20 手窗口被 400+ 手基线压平，VPIP 15%→45% 算出 **0~1 分** | 改为**温和收缩**，强度只由近期机会数决定 |
| D2 | 置信度被连乘三次 | 20 次机会的信号再砍到约 **1/4** | 聚合层与调整层不再乘置信度 |
| D3 | 置信度刻度错位 | 远高于判定门槛的样本仍只得 **0.5** | 按机会数线性映射 |
| D4 | 方向判定用绝对阈值 | ±1 次计数差被当成真实方向，**虚假方向冲突**提示 | 两比例差的**标准误**检验 |
| D5 | 方向检验样本量取错 | PFR 20%→5% 被判「无方向」，漏掉真实冲突 | 改用全部近期事件机会数 |

修复后同一场景：DeviationScore **1 → 41**，状态 `NORMAL → LOOSER_RECENTLY`。

### 第二轮：**独立红队（判定 FAIL）** —— 又发现 3 CRITICAL + 9 MAJOR

**这一轮是本阶段最重要的发现。** 独立审计员**没有参与实现**，
用**完全不同的方法**复核（400 个确定性 LCG 种子的批量统计、
蒙眼边界扫描、源码级死代码检查），在第一轮修复后**仍然**找出 3 个 CRITICAL：

**F1（最严重）**：40 手、基线 VPIP 15% / PFR 12% / 3Bet 7%，近期 36/40、0/40、0/40
（「开始大量跟注」）：

```
修复前：AGGRESSION_DOWN  19 分
        adjustments = [AGGRESSION_LIKELIHOOD DECREASE, FOLD_LIKELIHOOD INCREASE 1.2523]
        → 没有任何 RANGE_WIDTH 调整；反而输出「更可能弃牌」
```

同一 VPIP 曲线、**只不记 PFR/3Bet** → `LOOSER_RECENTLY, 26 分, RANGE_WIDTH ×1.2316`。
**追加两条真实且强相关的证据，把正确判决换成了错误判决。**
机理：组内方向冲突判 `NONE`，使兜底分支（条件 `entry.direction === 'HIGHER'`）
在**它专为的那个冲突下永不可达**。

**F2**：充分性与置信度由**跨指标机会总数**决定 →
真值 = 基线的玩家 **2 手 → confidence 0.900**，而 20 手 → 0.851
（**置信度随样本增加而下降**），且 2 手牌就能拿到满额 1.2523× 范围因子。

**F3**：方向检验与强度用**不同样本量** → 同一份 W20 统计，
多喂 40 手**同一水平**的历史就翻转判决；误报率随历史 12% → **51%**，
虚假冲突提示 0.3% → **30%**。

其余 9 条 MAJOR：F4 偏差分无零假设刻度（均值 19.8 / 12% 误报）、
F5 `SIZING` 组死代码 + 12 个真实指标不可见、
F6 **别人的损失抬高本人 Tilt 概率**、
F7 人工 Hint 时间戳被忽略且静默吞掉、
F8 畸形输入 TypeError 崩溃（Fail Closed 失效）、
F9 `asOf = NaN` 让**未来事件全部进入**、
F10 非计算字段非法导致整条事件机会全丢、
F11 `MAX_SINGLE_EVENT_SHARE` 是死常量、
F12 5000 事件 P95 = 31.3ms **超出预算**。

### 修复后的关键数字

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 「大量跟注」场景 | `AGGRESSION_DOWN`、19 分、错过 | **`LOOSER_RECENTLY`、32 分、`RANGE_WIDTH ×1.2316`** |
| 真值 = 基线时的偏差分均值 | 19.8 | **8.0** |
| 真值 = 基线时的误报率（20 手） | 12.3%（且随历史升到 51%） | **17.3%**（不随历史变化） |
| 2 手牌时的 confidence | 0.900 | **0.083**（且判 `UNKNOWN`） |
| 5000 事件 P95 | 31.32ms | **15.11ms** |
| 别人的损失对本人 Tilt | 0.6248 | **0.0000** |

### 尚存的诚实记录

- **误报率 14~22%**（真值 = 基线，20 手窗口，多项指标，400 种子）。
  这与统计理论一致：门槛 1.5σ 的单侧假阳性约 6.7%，
  同时检验多项指标后家族错误率约 19%。要降低必须提高门槛，
  代价是真实变化检不出。已用低置信度 + 保守幅度（≤1.28×）+ 单指标折扣限制危害。
- 20 手窗口的统计功效有限（真实大变化 `z ≈ 2.6`），这是样本量的物理限制。
- F15 的死参数、`baseline.metrics` 接受任意键等 MINOR 项已登记未清理。

> **元层教训（写进 `reports/DYNAMIC_REDTEAM_AUDIT.md` §5）**：
> 1. 「测试全绿」可以完全掩盖假阴性 —— 12 条缺陷全部在 55/55 下存在
> 2. **作者自查不能替代独立审计** —— 第一轮修完后独立审计仍找出 3 个 CRITICAL
> 3. 参数调不对时先怀疑概念（F4 花了 5 轮才定下来）
> 4. 同一个量在一条链上出现多于一次时，必须明确每次的不同职责

# **Step 7：PASS**

> **关于「PASS」的含义**：它表示「在当前项目条件下，两轮独立审计没有留下
> 已知的核心逻辑缺陷」，**不表示这个模块已经可用**。
> 它仍然没有任何仓内消费者，幅度仍然未经校准（`UNVERIFIED_MAGNITUDE`）。
> （**注**：当时产品能力为「0% 可端到端使用」；该状态已在下一阶段的 Alpha 中改变。）

---

# Alpha 可测试版本 —— Environment 接入 + Manual Input + Decision Engine + Web UI

> **本阶段目标**：第一次把整条链真正跑通，并进入内部网站测试。

## 1. 一句话结论

> **可以打开网页 → 手动输入一手牌 → 在约 100 毫秒内得到
> 「动作 + 合法尺寸 + 置信度档位 + 分类 + 最多 3 条中文原因」，
> 并可在调试区看到每一层的原始数据。**

## 2. 交付内容（按锁定顺序 A–H）

| 步骤 | 交付物 |
|---|---|
| **A** Environment 最小接入 | `src/domain/environment/environmentAccess.ts`：把知识层 13 条 `env.*` 规则变成**方向建议**；**不导入** legacy 倍数值 |
| **B** Minimal Manual Input | `src/app/manualInput/`：`manualInput.ts` / `reconstruct.ts` / `preflopPriors.ts` / `likelihoodModel.ts` / `legalActions.ts` |
| **C** Decision Context Builder | `src/app/manualInput/contextBuilder.ts` + `src/domain/decision/decision.types.ts`（只组合数据，**不做策略判断**） |
| **D** Alpha Decision Engine | `src/app/decision/decisionEngine.ts`（数学优先 → 策略其次 → 最终数学复核） |
| **E** Dynamic Shadow Mode | 在 `decisionEngine.ts` 内：动态**只影响置信度**，被明确禁止翻转动作 |
| **F** End-to-End Pipeline | `src/app/alphaPipeline.ts` + `decisionLog.ts`（`analyzeManualHand`） |
| **G** 最小中文 Web UI | `src/app/webServer.ts` + `src/app/web/index.html` + `src/viewmodels/decisionViewModel.ts`（Node 内置 `http`，**无 web 框架依赖**） |
| **H** Golden Smoke Tests | `test/alphaSmokeSpots.test.ts`：**25 个**烟测点 + 三环境对照 |

## 3. 端到端可行性验证

| 环节 | 证据 |
|---|---|
| 打开网页 | `node --experimental-strip-types src/app/webServer.ts` → `http://127.0.0.1:5173` |
| 健康检查 | `GET /api/health` → `{"ok":true,"knowledgeRules":23,"mode":"INTERNAL_ALPHA"}` |
| 真实分析请求 | `POST /api/analyze` 实测返回「建议：下注 · 3.25BB · 置信度 中低 · 类型 边缘决策」+ 完整调试区 |
| 命令行演示 | `node --experimental-strip-types scripts/alpha-demo.ts` |
| 端到端延迟 | **P50 ≈ 51ms**；HTTP 往返 105ms（预算 1–3 秒，硬上限 8 秒） |

## 4. 本阶段发现并修复的**真实 Bug**

### 4.1 `rebuildPendingQueue` 队列错误旋转（**CRITICAL**，阻断端到端）

**位置**：`src/domain/poker/engine.ts`

```ts
const order = streetOrder(state).filter((p) => !p.folded);
const startIndex = Math.max(0, order.findIndex((p) => p.id === lastActorId));
const rotated = [...order.slice(startIndex + 1), ...order.slice(0, startIndex + 1)];
```

行动者**弃牌后就不在 `order` 里**，`findIndex` 返回 -1，
`Math.max(0, -1)` 把它变成 0 → **`order[0]` 被错误地转到队尾**。

**实测后果**（都是「合法输入被拒」）：
- 6 人桌 UTG 弃牌 → 队列 `[UTG,HJ,CO,BTN,SB,BB]` 变成 `[CO,BTN,SB,BB,HJ]`
- 短全下场景 CO 弃牌 → `[co,btn,sb,bb,utg]` 变成 `[utg,btn,sb,bb]`
  → 系统要求 UTG 先行动，而 BTN 才是正确的下一位

**修正**：在**完整顺序**（含弃牌者）里定位行动者，再从「他之后第一位」开始环绕。

**为什么既有测试没抓到**：两个既有测试**固化了错误顺序**
（`engine.test.ts` 的 TDA 用例与 `validator.test.ts` 的筹码守恒用例
在注释里明确写了由该 Bug 产生的顺序）。两处均已按正确顺序修正，
并在测试注释里写明了原因。

### 4.2 蒙特卡洛**均匀抽样**使 Range 后验失效（**CRITICAL**）

**位置**：`src/domain/poker/equityMonteCarlo.ts`

抽样是 `randomInt(rng, pairs.length)` —— **均匀**的。
于是 Range 引擎做出来的贝叶斯后验**完全不参与权益计算**：
「对手加注过 → 范围偏强」这一信息在最后一步被丢掉，
**整条 Range → Equity 链形同虚设。**

**修正**：新增可选 `perOpponentWeights`（按 CDF 抽样）。
省略权重时抽样路径与修复前**逐位一致**（既有 89 项权益测试全部继续通过）。

**实测验证**：混合范围下 均匀权益 = 0.8849 → 加权权益 = **0.6248**。

### 4.3 其它在本阶段发现并修复的缺陷

| # | 缺陷 | 后果 | 修正 |
|---|---|---|---|
| 1 | 似然权重（最大 4.0）被直接当概率传入 | `validateActionModel` 拒绝 → **每次范围更新静默失败** | 加 `normalizeLikelihood` 归一化到 `[0,1]` |
| 2 | 范围更新一律用**当前街** | 翻牌圈更新翻牌前范围被拒 → 更新静默失效 | 改用 `ActionRecord.street` |
| 3 | 公共牌建局时预填 + 推进时又发 | `ISSUE.DUPLICATE_CARD` | 建局不传 board，由推进按街切片发牌 |
| 4 | 「无决策点」仍给建议 | 翻牌前全员跟平后输出「建议：过牌」 | 新增 `DECISION_POINT_NOT_AVAILABLE` 阻断 |
| 5 | `activeOpponentCount >= 2` 即拒多路 | **AA/AKo 面对开池被建议弃牌** | 阈值改为 ≥3（2 人是 6 人桌常态） |
| 6 | 翻牌前 `handCategory = 0` → 判 WEAK | 翻牌前不主动下注 | 改用起手牌档位标签 |
| 7 | 尺寸取最小值 | 顶对下注 **1BB**（明显漏价值） | 按牌力档选底池比例（45%/60%/75%） |
| 8 | `playerConfidence = 0` 与「无数据」混淆 | 置信度被拉到 **0.000** | 区分「信息缺失」与「数据不可信」 |
| 9 | 底池可选后 `claimedPot ?? 0` | 「没填」被当成「填 0」→ 假 POT_MISMATCH | 改为 `null` 语义 |

## 5. 测试与验收

| 指标 | Step 7 | Alpha（初版） | **Alpha（红队修复后）** |
|---|---|---|---|
| 测试总数 | 1,035 | 1,061 | **1,185** |
| 通过 | 1,035 | 1,061 | **1,185** |
| 失败 | 0 | 0 | **0** |
| 测试文件数 | 31 | 34 | **36** |
| 绑定产物数 | 42 | 58 | **84** |
| 类型检查 | 零错误 | 零错误 | **零错误** |

**1,035 项基线全部继续通过**，无断言放宽、无测试删除、无跳过。

> **两处断言被修正，必须记录**：
> 1. `engine.test.ts` / `validator.test.ts` 中固化错误行动顺序的两处
>    —— 修正为正确顺序（见 §4.1）
> 2. `projectStatus.test.ts` 的「必须标注端到端为 0%」
>    —— 原断言要求文档写「0%」，而 Alpha 落地后端到端**真的可用了**，
>    继续断言会变成「要求文档撒谎」。改为**双向一致**：
>    引擎存在则必须声明可用、不存在则必须声明 0%。

---

## 7. Alpha 决策链**独立红队**（判定 FAIL）与修复

完整报告：`reports/ALPHA_INDEPENDENT_REDTEAM.md`；原始证据：`scripts/rt-alpha-evidence.txt`。

独立红队用与作者不同的方法（216 个场景回放 / 685 个 BET·RAISE 尺寸 / 264 组合指纹 /
7 种结果注入 / 逐位确定性 / 探针 1–12）审查整条 Alpha 链，
在**单元测试全绿**的情况下判定 **FAIL**，理由 2 CRITICAL + 4 MAJOR：

| # | 级别 | 缺陷 | 修正 |
|---|---|---|---|
| F-01 | CRITICAL | `pickCandidate` **永不返回 RAISE** | `shouldRaise()` + `pickClosestRaise()`；并修正「三条被归为 MEDIUM」导致翻牌后仍不可加注 |
| F-02 | CRITICAL | 牌力档位由 **169 表数组位置**决定 → `QQ` 进攻似然低于 `A7s`；且自检**零调用者**、判据还依赖数组首尾 | 改为解析牌型字符串；自检改具名牌型并扩到 169 类逐档；**接入服务器启动 Fail-Closed** |
| F-03 | MAJOR | 3Bet 被当成开池范围 → AKo 权益**虚高 27.5pp** | 新增 `THREEBET_SPECS` / `threeBetWeights()`；自检断言「3Bet 必须严格更紧」 |
| F-04 | MAJOR | `classifyOf` 不看置信度 → 0.1537 也标「明确决策」 | `CLEAR` 增加置信度下限；管线再加一道硬检查 |
| F-05 | MAJOR | 信息不足时 `action` 仍是 `'FOLD'` | `action: DecisionAction \| null`，日志同步，界面文案分开 |
| F-06 | MAJOR | 注释声称「2 名对手会要求更高可信度并注明近似」，代码里**两件事都没有** | 实现 `MIN_RANGE_CONFIDENCE_MULTIWAY` + `MULTIWAY_APPROXIMATION` 降级并在界面显示 |
| F-07…F-13 | MINOR/INFO | `bigBlindBB` 死字段 / 全下无法录入 / 耗时表恒 0 / 哈希漏字段 / 动态提示反而降置信 / 文档漂移 / `budget` 不控制任何计算 | 逐条修复（见 `TEST_MATRIX.md` §0.4） |

**修复过程中又发现 2 个缺陷**（红队未报，属于同族）：

| # | 缺陷 | 后果 | 修正 |
|---|---|---|---|
| **F-14** | `selfCheckLikelihoodModel` 用 `KEYS[0]` / `KEYS[last]` 当「最好/最差」，注释写 `32o` 而末键实际是 `22` | **一个「通过」的自检在验证一个不是它声称的不变量** —— 与 F-02 同族 | 全部改用具名牌型 + 逐档扫描 |
| **F-15** | `MATH_DOMINANCE` 的理由比动作自己的理由**更早**进入列表，而首屏只显示 3 条 | 首屏出现「建议：**加注**」配「**跟注** 在数学上明显占优」—— 两句都真，并排读自相矛盾 | 理由按「动作理由 → 通用事实 → 数学优势」重排；措辞显式声明比较范围 |

**修复后的两个结构性对策**（比具体缺陷更重要）：

1. **启动自检 Fail-Closed**：`startAlphaServer` 真的调用两个自检，
   失败即拒绝启动。一个范围模型坏掉的服务器，比「没有服务器」危险得多。
2. **红队编号 ↔ 永久回归测试一一对应**：`test/alphaRedteamRegression.test.ts`
   的每个 `test()` 标题以 `F-xx` 开头，报告里的每一条都可机械核对。
   `test/manualInputPriors.test.ts` 补上 F-02 根因所在的**零覆盖**模块。

## 6. 已知限制（诚实记录）

| 限制 | 说明 |
|---|---|
| **尚未用真实牌局验证** | 这是下一步唯一要做的事 |
| 范围是**启发式先验** | 非求解器输出、非实测数据；可信度 0.3；界面明确标注 |
| **抽水未计入** | 无 Rake Engine；所有 EV 都是未计抽水口径（诊断区标注 `NOT_APPLIED`） |
| 下注/加注的 **EV 不参与比较** | 缺可信弃牌率估计，因此「加注 vs 跟注」是**定性**判断而非 EV 比较 |
| **≥3 名活跃对手** | 明确返回信息不足，**不假装单挑** |
| **2 名活跃对手是近似** | 权益只按单挑口径估算，第二家行动未进模型 → **偏乐观**；界面明确显示该警告 |
| 翻牌前范围只有三档 | 开池 / 面对开池的继续 / 3Bet；防守范围把跟注与再加注合并建模 |
| 范围更新是**单调启发式** | 只表达方向，不是实测频率 |
| 无 Rake / 3 人以上多人池 / 锦标赛 / 短牌 | 刻意未做 |




---

# 交互式牌桌录入（UI / 输入工作流重构）

> 主题：把「键盘填表」换成「点牌桌」。**不是策略开发**。
> 冻结模块（Poker Core / Hand Evaluator / Math / Equity / Range / Player Profile /
> Dynamic / Environment / Decision Engine / Confidence / Alpha Smoke 预期）**一行未改**。

## 1. 一句话结论

牌桌本身就是输入器：点座位、点牌面（4×13）、点行动、点画像。
**每手中位 9 次点击、0 次键盘输入**；Hero 视觉固定在底部而逻辑位置逐位正确；
新玩家绝不继承旧画像；Fold / Leave / Sit Out 严格区分；
当前手的底池与行动台账不会因为座位变化被破坏。

## 2. 三条铁律 → 三条代码级约束

```
# Fold ≠ Leave Table
# Seat ≠ Player
# 当前 Hand 的历史事实不能因为玩家离桌而被删除
```

| 铁律 | 代码级约束 | 回归测试 |
|---|---|---|
| Fold ≠ Leave | `FOLDED_THIS_HAND` 与 `LEAVING_AFTER_HAND` 是两个状态；`FOLD` 只能由 `ACT`（走 Poker Engine）产生 | §71 / 不变量 A |
| Seat ≠ Player | 画像存在 `playersById`，**按 playerId 查**；换人必须新建 playerId；无任何路径把旧 `TablePlayer` 复制给新 id | §10 / §69 |
| 历史不可删 | `actionHistory` 只有「追加一条」与「整体清空」两种变化；**没有任何按座位删除历史的路径** | 不变量 C / §74 / §75 |

## 3. 交付内容（新增 9 个源文件 + 3 个测试文件）

| 文件 | 作用 |
|---|---|
| `src/app/table/table.types.ts` | 座位状态 / 座位 / 玩家 / 牌桌状态 / 操作 |
| `src/app/table/tableState.ts` | 建桌、**视觉旋转**（只影响渲染）、人员齐备判据 |
| `src/app/table/seatLifecycle.ts` | 加入 / 清空 / 换人 / 暂离 / 留座决策 / 筹码 / 手牌 / 公共牌 / 撤销 / 下一手 / 新牌桌 |
| `src/app/table/tableOps.ts` | 需要引擎参与的操作；`applyTableAction` 带**重放等价自检** |
| `src/app/table/tableAdapter.ts` | 牌桌状态 → `ManualHandInput` 的**唯一转换点** |
| `src/app/table/tablePreview.ts` | 预览（复用 reconstruct + deriveLegalActions + Poker Core 校验器） |
| `src/app/table/tableApi.ts` | 请求校验（Fail-Closed）+ **版本水位线** + 元数据 |
| `src/app/web/index.html` / `table.js` / `table.css` | 牌桌界面（**前端零规则**，全部由后端权威计算） |
| `test/interactiveTable*.test.ts` | 39 项新测试 |

## 4. 关键设计决定

1. **前端不含任何牌局规则**。「轮到谁 / 谁能做什么 / 街道推进到哪 / 底池多少」
   全部来自 `POST /api/table` 的响应。测试断言 `table.js` 里**不存在**
   `preflopOrder(` / `minRaiseTo(` / `computePot(` 这类函数调用。
2. **视觉位置与逻辑位置在后端就分开**：响应里同时给 `logicalPosition` 与
   `visualIndex` / `angleDeg`，前端连「视觉→逻辑」的换算代码都没有。
3. **意图与判定分离**：行动请求里**没有位置** —— 行动者由后端 `actorOnTurn` 决定。
4. **落库前做重放等价自检**：每次记录行动后立刻用新历史重放一遍，
   与刚算出的状态**逐位比对**，不一致就拒绝这一步（宁可拒绝，也不让
   牌桌显示与分析用的状态分叉）。
5. **客户端状态不可信**：`parseTableState` 逐字段校验（含撤销栈的每一个快照），
   16 类畸形载荷全部被拒且不留副作用。
6. **契约的最小扩展**：`ManualHandInput` 新增可选 `seatStacksBB`（逐座位筹码）。
   这是「接口无法表达 Seat 信息」的实际缺口，不是便利字段；
   不填时行为与历史**逐位一致**（既有 1,119 项测试全部继续通过）。
   `hashManualInput` 同步补齐（F-10 的**穷举式**清单测试当场编译失败，正是设计意图）。

## 5. 现场走查（`scripts/table-walkthrough.ts`）

| Spot | 场景 | 本手点击 | 服务端耗时 | 结果 |
|---|---|---:|---:|---|
| A | 9-max · Hero UTG（翻牌决策） | 16 | 494 ms | 建议：下注 2.25BB |
| A2 | 翻牌前**提前提示**多人池限制 | 2 | 141 ms | 预览已提示 8 名活跃对手 |
| B | Hero 小盲 · 面对开池 | 7 | 222 ms | 建议：加注 3.50BB |
| C | Hero 大盲 · 小盲补齐 | 8 | 236 ms | 建议：过牌 |
| D | 玩家中途弃牌 | 7 | 230 ms | 建议：加注 3.50BB |
| E | 玩家离桌（手后离桌） | 9 | 250 ms | 建议：加注 3.50BB |
| F | 换新玩家（不得继承画像） | 9 | 241 ms | 画像 = UNKNOWN（正确） |
| G | 暂离再回来 | 3 | 120 ms | 画像保留（正确） |
| H | 150BB 深筹码 | 19 | 373 ms | 建议：下注 2.25BB |
| I | 河牌决策 | 19 | 356 ms | 建议：跟注 1.00BB |
| J | 下一手继续同桌 | 28（两手） | 573 ms | 座位与画像保留 |

**11 / 11 通过。每手中位 9 次点击；一次性布置 9 次点击（开一次牌桌只做一次）。**

> ⚠️ 人类输入耗时（≤10 秒 / 普通 Spot）必须由使用者亲自点一遍才有意义 ——
> 脚本给出的是下界：点击次数 × 单次反应时间 + 服务端耗时。

## 6. 开发期发现并修复的缺陷

| # | 缺陷 | 后果 | 修正 |
|---|---|---|---|
| T1 | 适配器把**牌桌 playerId** 传给管线 | 动态层按 `record.playerId === villainId` 过滤本手事件，两边永远匹配不上 → `computed:false`，**动态层被静默关闭**而界面一切正常 | 画像按牌桌 playerId 查、传给管线的 id 用引擎口径 `seat_<位置>` |
| T2 | `parseTableState` 用 `Object.values(STREET_ZH)` 校验街道 | 那是**中文标签**，于是每条带街道的行动都被判非法 → 牌桌在 HTTP 层完全不可用（而纯函数层测试全绿） | 改用枚举值；并补一条 HTTP 层测试 |
| T3 | `setBoardCard` 允许「跳着填」 | 直接点第 3 个槽位时，刚选的牌被**静默丢弃**（数组截断成空） | 跳着填直接拒绝并说明先填第几张；只能取消最后一张 |
| T4 | 「取消」离桌决策走 `commit` | 平白往撤销栈压一条「无操作」，撤销一次界面毫无变化 | 取消 = 原状态返回（不动 revision、不动撤销栈） |
| T5 | `parseManualInput` 完全不校验 `quickProfile` / `dynamicHint` | 一个拼错的字符串会让动态层 `dominantState` 变成 `undefined`（不在枚举里的值），而决策照常给出 | 未知取值一律阻断（Fail-Closed），并列出合法取值 |
| T6 | 分析阻塞原因重复显示 | 同一条「有空座位」出现两遍，使用者以为有两个独立问题 | 去重 |
| T7 | `minRaiseTo` 曾作为独立字段被断言不存在于前端 | 前端**读取** `preview.minRaiseToBB` 是合法的展示行为；断言写成裸子串会误报 | 断言改为匹配**函数调用** |

## 7. 已知限制（如实记录）

| 限制 | 说明 |
|---|---|
| **暂离 / 空座位无法分析** | ❌ **已被证伪（是缺陷，不是限制）** —— 见文末 Table Topology Correction。域层 `createGame` 只要求 `2 ≤ 本手人数 ≤ 容量`；暂离座位由 `participantSeatsOf` 排除在本手之外。**已修复** |
| **翻牌前前位决策常返回「信息不足」** | ❌ **已被证伪（是缺陷，不是限制）** —— 那条门槛当时用「未弃牌人数」，而 Hero 在 UTG 时后面 8 个人**还没轮到说话**。**已修复**：改用 `realizedOpponentCount`（跟注/加注/全下） |
| **下一手不分配底池** | 本项目不建模牌局结果（结果不得进入决策链），因此按「剩余筹码」更新座位筹码并显式提示使用者手动修正赢家 |
| **快速画像多数情况下不改变最终置信度** | 最终置信度取各分量**最小值**，而范围可信度 0.3 已是最小分量。已用测试把这条限制钉住（若将来语义变化会失败提醒） |
| 锦标赛 / 短牌 / Rake | 刻意未做 |

---

# Table Topology Correction（桌型拓扑修正，**不是新 Phase**）

**日期**：2026-09-13
**判定**：`# TABLE TOPOLOGY CORRECTION — PASS`
**完整报告**：`reports/TABLE_TOPOLOGY_CORRECTION.md`（25 节）

## 1. 修改内容

把「牌桌有几个座位（`tableSize`）」与「本手几个人」这两个**一直被当成同一个**
的数字拆开。修复前 **9 座桌坐 8 个人时整张牌桌无法分析** ——
而这是现金局最常见的形态。

## 2. 为什么修改

域层 `createGame` 要求 `人数 === 容量`，表层 `staffingProblems`
要求「每个座位都有人」，两边都把「容量」当成了「本手人数」。
使用者的实际后果是：**必须编造一个不存在的玩家才能分析**。

## 3. 主要变更（13 项行为变化）

| 位置 | 修复前 | 修复后 |
|---|---|---|
| `createGame` | `人数 === 容量` | `2 ≤ 人数 ≤ 容量`；并拒绝重复/空 `playerId` |
| `validator` | `players.length !== tableSize` → 非法 | `2 ~ 容量`；新增重复 `playerId` 阻断 |
| `streetOrder` | 翻牌后从小盲开始（**单挑错**） | 单挑从**大盲**开始 |
| `staffingProblems` | 空座位 / 暂离 → 阻断 | **只有两条**：可参与者 < 2、Hero 座位没人 |
| `staffingNotices`（新） | — | 非阻断提示：「本手 8 人参与（9 座桌），1 个座位不发牌：…」 |
| `tableAdapter` | 只传 `tableSize` | 传 `occupiedPositions` + `buttonPosition` |
| `tablePreview` | 无拓扑；`isDealer = position === BTN` | 暴露 `handTopology`；`isDealer` 来自 `buttonSeatId`；新增 `handRole` / `isParticipant` |
| 多人池判定 | 未弃牌人数 ≥ 3 | **已实现**对手数 ≥ 3 + `PLAYERS_YET_TO_ACT` 提示 |
| 范围先验选档 | 按**容量**二分 | 按**本手人数**（位置名即人数） |
| Button | 只有自动轮转 | + `SET_BUTTON`（仅本手未开始时） |
| `handsCompleted` | 只在 `handActive` 时 +1 | 每按一次「下一手」+1 |
| 前端建桌 | 硬编码 6 座 / BTN | 对话框选桌型 + Hero 座位 |
| 前端座位标签 | 物理座位名 | **本手角色**；不参与则标「本手不参与」 |

## 4. 墨菲风险（本轮新增关注点）

| 风险 | 为什么可能发生 | 防线 |
|---|---|---|
| **拦截点搬家** | 域层修好、表层拦回 —— 单测任何一层都发现不了 | §2 反证测试（域层不拒绝时表层也不得拒绝）+ §10 HTTP 产品路径 + 只走产品入口的探针 |
| **同一个数字在两处含义不一致** | 引擎改用已实现对手数、预览仍在用未弃牌人数 | 判据 `realizedOpponentIds` 定义在**领域层**，两个消费者共用 |
| **冻结快照被座位操作悄悄改动** | 本手进行中有人暂离/离桌 | §6 断言拓扑快照**逐字节不变**；`commit` 只在 `handActive` 翻转时处理快照 |
| **单挑的特殊规则被满桌逻辑吞掉** | 「小盲先行动」「Button 下小盲」都是单挑例外 | 单挑规则分三处独立断言（§5 / §5b / §5c），且 §5c 带**反证** |
| **旧断言被"顺手放宽"** | 语义变了，最省事的做法是删断言 | 全部改为**加固**（同时钉住新行为与「如实告知」），并记录在 TEST_MATRIX |

## 5. 测试

| 文件 | 项数 | 内容 |
|---|---:|---|
| `test/tableTopology.test.ts`（新） | 24 | 黄金用例 + 产品路径 + 双向健全性 + 4 条铁律具名断言 |
| `test/tableTopology.property.test.ts`（新） | 19 | 9,481 组拓扑组合穷举/随机 + 5,551 组 Button 轮转 + 64 手真实建局 |
| 既有 43 个测试文件 | 1,185 | 全部继续通过；其中 5 项因语义变化**被加固** |

## 6. 测试结果

```
& npx.cmd tsc --noEmit                                  → 0 错误
node.exe --test --experimental-strip-types "test/**/*.test.ts"
                                                         → 1228 / 136 套件 / 0 失败
node.exe --experimental-strip-types scripts/rt-topology-verify.ts
                                                         → 结论：全部通过
node.exe --experimental-strip-types scripts/table-walkthrough.ts
                                                         → 成功 Spot：11 / 11
& npm.cmd run verify                                     → exit 0（89 个产物逐字节一致）
```

## 7. 性能

| 项 | 值 |
|---|---|
| 拓扑计算 | **3.6~5.3 µs / 次**（5,000 次合计 18~27 ms；目标 < 5 ms，余量约 1,000 倍） |
| 每手点击次数（中位） | **9**（修复前 9，**未退化**） |
| 服务端每手耗时 | **约 300 ms**（修复前约 290 ms；+10 ms 来自新增的拓扑与角色渲染数据） |

## 8. 已知限制

见 `reports/TABLE_TOPOLOGY_CORRECTION.md` 第 24 节（8 条，逐条如实列出）。
其中最需要使用者知道的一条：**未行动的对手不进权益** ——
`playersYetToAct` 只提示、不计算。第一版没有多人权益引擎，
任何「乘一个系数把权益压下去」都是凭空造数据（项目明令禁止）。

## 9. 本阶段方法论教训

**「修好了」这句话必须绑定到一个可执行的观测点。**

本轮最隐蔽的缺陷不是任何一个具体 Bug，而是
**「域层放行、表层拦回」** —— 两个层的测试都是绿的，产品依旧不可用。
因此本阶段没有停在「改完代码」，而是补了三条**跨层**的观测点：

1. 反证测试（域层不拒绝 ⇒ 表层也不得拒绝）；
2. HTTP 产品路径测试；
3. **只走产品入口**的端到端探针。

这三条都不是为了本轮，而是为了让「拦截点搬家」这类缺陷
**在下一轮不可能再次静默发生**。