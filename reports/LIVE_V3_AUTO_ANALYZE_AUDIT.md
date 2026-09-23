# LIVE V3 — 自动分析失败与实时决策性能专项审计报告

**日期**：2026-09-23　**分支**：`dev-computer-a`　**HEAD**：`3e602c5`（干净，与远程一致）
**审计方式**：只读。真实 HTTP 接口 + 真实浏览器 + Node CPU profile，不用模拟数据
**服务**：`http://127.0.0.1:5173`（`ALPHA_GTO` 未设置 = 启用），GTO 求解器 `127.0.0.1:3737` **未启动**

---

## 一、结论摘要

**自动分析的性能瓶颈不在 GTO 求解器，在后端自己的权益计算。**

| 场景 | 端到端 | 后端总计 | 其中 context | decide |
|---|---|---|---|---|
| 翻前 · 缓存命中 | 183–232 ms | 88–111 ms | **88–110 ms** | 0–1 ms |
| 翻前 · 求解尺寸不匹配 | 191–212 ms | 86–100 ms | **85–99 ms** | 0–1 ms |
| 翻前 · 全跛入 | 395–400 ms | 188–199 ms | **188–199 ms** | 0 ms |
| **翻牌圈** | **2797–3086 ms** | **1387–1562 ms** | **1385–1560 ms** | 1–2 ms |
| 转牌圈 | 1016–1032 ms | 521–525 ms | **518–522 ms** | 2–3 ms |
| 河牌圈 | 1007–1021 ms | 497–503 ms | **491–498 ms** | 4 ms |

**`decide`（决策引擎本身）只要 0.2–4 ms。全部时间花在 `buildDecisionContext` 上。**

CPU profile 把这段定位到**扑克权益枚举**：

```text
自身耗时 TOP（11.1 秒采样窗口）
  3075 ms  walkRunout          @ src/domain/poker/equityExact.ts:169   ← 精确枚举
  2877 ms  evaluateSeven       @ src/domain/poker/fastEval.ts:193      ← 7 张牌评估
  1224 ms  simulateMonteCarlo  @ src/domain/poker/equityMonteCarlo.ts:111
  2228 ms  runOneBatch         @ src/domain/poker/equityMonteCarlo.ts:214

按文件聚合
  3944 ms  equityMonteCarlo.ts
  3100 ms  equityExact.ts
  2886 ms  fastEval.ts
    55 ms  contextBuilder.ts    ← 上下文组装本身几乎不耗时
```

**最严重的一条**：这是一台**单线程 Node 服务**，上述计算**同步阻塞事件循环**。实测：

```text
/api/table 单独发送                        =    53.3 ms
/api/table 在慢 analyze 进行中发送          =  2791.4 ms   ← 被阻塞
  （同一时刻的 analyze：end-to-end 2824 ms，其中 context 1410 ms）
/api/table 在 analyze 结束之后发送          =    12.1 ms
```

也就是说：**一次翻牌分析会让整张牌桌约 2.8 秒不可操作**。
前端同时还有 `busy()` 串行锁，两件事叠加，使用者看到的就是「点了没反应」。

---

## 二、完整生产链路

```text
① 用户点动作（table.js）
   └─ sendOp(op) → POST /api/table { state, op }
       └─ tableApi.parseTableState → tableOps.applyTableOp → 引擎裁决
           └─ 200 { ok, state, preview }
               └─ applyTableResponse → app.state/app.preview 更新 → render()
                   └─ render() 最后一行调用 scheduleAutoAnalyze()

② 自动分析触发（table.js: scheduleAutoAnalyze）
   ├─ app.mode === 'HISTORY_ENTRY'  → 不分析
   ├─ preview.decision.ready !== true → 不分析（后端给的 8 条件闸门）
   ├─ key = (state.revision, modeEpoch)；已分析过 → 不分析
   └─ setTimeout(ANALYZE_DEBOUNCE_MS = 60ms) → runAnalyze('auto', key)
        ├─ 再查一次 ready 与 key 是否仍匹配（防过期排程）
        ├─ token/revision/epoch 三重保护（迟到响应整包丢弃）
        └─ POST /api/analyze { table: app.state }

③ 后端 /api/analyze（webServer.ts:715）
   ├─ 解析请求体 → parseTableState（牌桌路径）→ tableStateToManualHandInput
   ├─ await prefetchSolverRangesForInput(...)   ← 只读缓存，未命中立刻回落
   │    └─ parseManualInput → buildAnalyzableState → enumerateOpponentScenarios
   │         └─ 逐家 readOneOpponentRange（solveSettingsMatch 闸 → lookupCachedOnly）
   ├─ queueBackgroundSolverRangesForInput(...)  ← 刻意不 await，返回入队状态
   ├─ buildGtoStatusJson(prefetched, background)
   ├─ 再走一遍 parseManualInput + buildAnalyzableState（算分层底池）
   └─ analyzeManualHand(input, { rules, gtoRanges })
        ├─ mark('parse')     parseManualInput
        ├─ mark('validate')  buildAnalyzableState（8 条件闸门）
        ├─ mark('context')   buildDecisionContext   ← 🔴 全部耗时在这里
        ├─ mark('decide')    decideAlpha            ← 0.2–4 ms
        ├─ mark('viewmodel') toDecisionViewModel
        └─ 决策日志 appendDecisionLog

④ 前端渲染
   └─ runAnalyze 的 .then → 三重保护通过 → app.analysis = payload → render()
```

### GTO 求解器不在主线程

`GtopenProvider` 通过 `GtoHttpClient` 访问 `http://127.0.0.1:3737`（**独立进程**）。
因此求解本身**不会**阻塞 Node 事件循环。后台队列 `BackgroundSolveQueue`
默认 `concurrency = 1`，同 `cacheKey` 去重，`FAILED` 不重试（重启服务才重试）。

---

## 三、逐条审计结论（用户第二节的 9 条）

| # | 检查项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 自动分析是否只在 Hero 需要决策时触发 | ✅ **正确** | 浏览器实测：模拟对战 6 位对手、`decision.ready` 全程 `false`，**只发出 1 次** `/api/analyze`（revision=9，轮到 Hero 那一刻） |
| 2 | 是否重复发送相同决策节点请求 | ⚠️ **有隐患，未观测到实际重复** | 去重键是 `(revision, modeEpoch)`，**不是决策节点**。同一节点只要中间有人行动、revision 变了就会重算。翻前场景我构造了 "开池→跟注→轮到 Hero" 只发 1 次；但「Hero 跟注后，后面还有人加注，再轮回 Hero」会为**同一节点**发第二次。成本 = 一次完整 context（翻前约 100 ms，翻后约 1.4–1.7 s） |
| 3 | 上一请求未完成时下一请求是否被长期阻塞 | 🔴 **是** | 前端 `post()` 在 `busy()` 时**直接丢弃**（不排队）；后端同一时刻 `app.inflight ≥ 1`。实测慢 analyze 期间 `/api/table` 从 12 ms 涨到 **2791 ms** |
| 4 | 缓存命中时是否仍然启动完整求解 | ✅ **不会** | `readOneOpponentRange` 在 `lookupCachedOnly` 命中且通过准入后**立即返回**，不触碰队列。实测 `background` 状态恒为 `DONE`，无新求解 |
| 5 | 缓存键是否正确包含必要策略条件 | ✅ **正确，且尺寸另有闸门** | `keysOf(scenario, provider.solveKeyParts(scenario))`；另加 `solveSettingsMatch` 拦「实际开池 3BB vs 求解配置 2.5BB」——实测该场景**正确回落**并给出可读原因，未白等 |
| 6 | 是否存在同步计算阻塞事件循环 | 🔴 **是，且是本轮最大问题** | CPU profile：`walkRunout`/`evaluateSeven`/`simulateMonteCarlo`；实测 `/api/table` 被阻塞 2791 ms |
| 7 | 失败/超时/缓存缺失是否正确返回明确状态 | ✅ **基本正确** | 求解器离线 → `GTO_BASELINE_UNAVAILABLE` + 可读中文；硬超时 10 分钟；`GTO 结局` 逐家进 `gtoStatus.outcomes`。**缺口**：成功响应把 `timings` 放在 `meta.timings`，前端**没有读取它**，界面上看不到分段耗时 |
| 8 | 旧请求覆盖新结果的风险 | ✅ **已防住** | 前端三重保护：`token !== analyzeLatestToken` / `state.revision !== requestRevision` / `modeEpoch !== requestEpoch`，任一不成立整包丢弃；后端 `applyTableResponse` 有版本保护 |
| 9 | 后端返回有效数据但前端未展示 | ⚠️ **部分** | `gtoStatus` 已展示（warnings / 逐家结局）；但 `meta.timings` **完全没展示**，使用者无法判断「慢在哪一段」 |

---

## 四、根因（按严重度）

### 根因 1 🔴 权益计算没有预算闸门，同步阻塞事件循环

`buildDecisionContext` 在一次分析里要做**多次**权益计算：

- 响应模型：`responseModel.sizes.map(...)` 每个尺寸算 **2 次**（CALL 桶 / RAISE 桶）
  —— `contextBuilder.ts:2014–2015`，注释明确「每个尺寸/桶用**不同种子**，避免三个尺寸的抽样误差完全相关」
- 多人联合响应树：每个分支**各自**算权益（`contextBuilder.ts:2094 / 2110 / 2114 / 2153`）
- 翻后另有 `checkBackEquity` / `betEquity`（`2413 / 2419`）与 re-raise 分支（`4298 / 5005`）

每次调用都会走 `computeEquity` 的**选型**：

```text
buildCapacity: bound = Π(对手组合数) × C(剩余牌数, 还要发几张)
翻牌（board=3）：C(45,2) = 990；对手范围约 100–300 组合 ⇒ bound ≈ 10万–30万
bound ≤ DEFAULT_MAX_EXACT_MATCHUPS (500000)  ⇒  选 EXACT（精确枚举）
```

`DEFAULT_MAX_EXACT_MATCHUPS = 500_000` 的校准依据写在代码里：
**「0.75 微秒/局 ⇒ 50 万局 ≈ 0.4 秒，远在 800ms 的软预算之内」**。
这个校准对**单次**权益成立，但一次分析要算 6 次以上 ⇒ 0.4 s × 6 ≈ **2.4 秒**。

🔴 **而 `EquityComputeMode.FAST` 不传 deadline**：

```ts
// equity.ts:150-151
const deadline = options.deadline ?? (mode === FAST ? undefined : defaultDeadlineForMode(mode));
```

`exactEnumerationFitsDeadline` 只在 `forceMethod === 'EXACT' || mode === VERIFY` 时才检查
（`equity.ts:173-192`）。**FAST 模式下精确枚举没有任何时间守卫。**

已有的预算机制**只覆盖分层权益**（`shouldSpendOnLayeredEquity`，`contextBuilder.ts:2633`），
它按层数预留（2 层约 110–220 ms、7 层约 610–1030 ms）——
**响应模型那 6 次权益完全在预算之外**。

### 根因 2 🟠 单线程服务 + 前端串行锁 = 双重锁定

- 后端：同步计算占满唯一的事件循环（实测 `/api/table` 被阻塞 2791 ms）
- 前端：`post()` 在 `busy()` 时丢弃请求并禁用全部控件

两者叠加，使用者在 2.8 秒里既点不动、也发不出请求。

### 根因 3 🟡 去重键是 revision 而不是决策节点

同一决策节点在「中间有人行动」后会重算一次完整 context。
翻前代价小（约 100 ms），翻后代价大（约 1.4–1.7 s）。

### 根因 4 🟡 分段耗时没有暴露到界面

`meta.timings` 后端算了、也写进了决策日志，但前端从未读取。
使用者只能看到「正在分析…」，无法区分「缓存读取慢 / 上下文慢 / 求解在等」。

---

## 五、本轮**未**观测到的问题（避免误报）

| 说法 | 实测 |
|---|---|
| 「缓存未命中就会套用别的节点的策略」 | ❌ 不成立。`solveSettingsMatch` 闸门实测拦住了 3BB/2.5BB 尺寸不匹配，逐家给出中文原因 |
| 「缓存命中仍会重新求解」 | ❌ 不成立。命中即返回，`background` 状态 `DONE` |
| 「求解器长期阻塞牌桌」 | ❌ 不成立。求解器是独立进程（HTTP），不占 Node 事件循环 |
| 「翻前很慢」 | ❌ 不成立。翻前端到端 183–400 ms，其中 context 88–199 ms。**慢的是翻后** |
| 「决策引擎本身慢」 | ❌ 不成立。`decide` = 0.2–4 ms |
| 「旧分析结果覆盖新牌局」 | ❌ 不成立。前端三重保护 + 后端版本保护都在 |

---

## 六、需要用户确认后才能实施的核心改动

用户第九节明确：改动决策引擎 / 求解器接口 / 缓存格式 / 后端核心牌局规则
**必须先给出方案、兼容性分析与回归测试计划，等确认后再实施**。

下面三项都属于该范围。**本报告提交前我一项都没有实施。**

### 方案 A（推荐，零策略变化）：把 `buildDecisionContext` 移到 worker 线程

| 项 | 内容 |
|---|---|
| 改什么 | `webServer.ts` 的 `analyzeManualHand` 调用点：在 `Worker` 里跑 `analyzeManualHand`（或只跑 `buildDecisionContext`），主线程 `await` 结果 |
| 为什么零策略变化 | `buildDecisionContext` 与 `decideAlpha` 都是**纯函数**（同输入同输出，无 IO、无时间依赖）。搬到另一个线程不改变任何数值 |
| 为什么这一项能根治根因 1 | 事件循环不再被阻塞 ⇒ `/api/table` 恢复 12 ms 级响应 ⇒ 「录入被分析卡住」消失 |
| 兼容性 | 不改任何函数签名、不改缓存格式、不改求解器接口。`analyzeManualHand` 保持同步可用（测试与表单路径继续直接调用） |
| 代价 | worker 启动与结构化克隆的开销（`ManualHandInput` 很小，实测 state JSON 约 10–30 KB）。首次请求多约 50–100 ms 冷启动 |
| 风险 | worker 生命周期管理（复用 / 超时 / 崩溃重启）；需要保证 worker 与主线程**用同一份** `rules`（知识库只读，可安全传递） |
| 回归测试计划 | ① 同一输入在 worker 与主线程给出**逐位相同**的决策（含 EV、置信度、范围）；② 阻塞测试：慢 analyze 期间 `/api/table` < 200 ms；③ worker 崩溃 → 如实返回失败而不是 500；④ 超时 → `DEADLINE` 状态；⑤ 既有 2270 项全绿 |

### 方案 B（备选，会改变数值）：给响应模型的权益计算加预算与容量上限

| 项 | 内容 |
|---|---|
| 改什么 | ① `rangeEquityOf` 系列显式传 `deadline`（或 `maxExactMatchups`）；② 时间不够时**跳过**部分尺寸/桶的权益，如实标注 |
| 兼容性 | ⚠️ **会改变数值**：EXACT → MONTE_CARLO 会让权益出现约千分之几的抖动，EV 与建议可能随之变化 |
| 为什么仍然可选 | 代码里已有先例与纪律说明（`shouldSpendOnLayeredEquity` 的注释）：**预算只能决定「要不要继续算」，不能决定「算得多准」**。因此这条路要走得小心 —— 要么整段跳过并标注，要么不降精度 |
| 回归测试计划 | ① 现有全部权益/EV 断言（数值可能要重新基线化，**需用户确认**）；② 预算充足时结果与改动前逐位一致；③ 预算不足时如实标注 `equityMethod` 与跳过原因 |

### 方案 C（不推荐）：让多个尺寸共用一次权益

代码注释明确这是**刻意分开**的（不同种子避免抽样误差相关）。
合并会改变 EV 与建议 ⇒ 属于「改变策略」，不在本轮授权范围内。

---

## 七、用户确认前我可以先做的（不改核心策略）

按用户第九节「优先修复无需改变核心策略的请求管理、缓存消费、状态展示和性能问题」：

| # | 改动 | 触及范围 | 预期效果 |
|---|---|---|---|
| 1 | **界面显示分段耗时**：读 `meta.timings`，在「自动分析」状态条上显示 `上下文 88ms ｜ 决策 1ms ｜ 总计 89ms` | 仅 `table.js` + `live-ui.css` | 满足用户第三节「分段性能测量」；使用者一眼看到慢在哪 |
| 2 | **分析中显示实时已等待时间**（「正在分析… 2.4s」） | 仅前端 | 满足第七节「完整求解中：显示正在计算及已等待时间」 |
| 3 | **节点已变则立即释放锁**：`runAnalyze` 在发请求前记下 `(revision, epoch)`；`app.state.revision` 一变，前端**立即**清 `inflight` 标志并解锁控件（响应回来照样丢弃） | 仅前端 | 根因 2 的前端那一半。后端仍会阻塞，但界面不再额外锁 2.8 秒 |
| 4 | **超时/失败给可执行重试入口**：`DEADLINE` / `GTO TIMEOUT` / `CONTEXT_BUILD_FAILED` 分别给出对应文案与「重试」按钮 | 仅前端 | 满足第七节「分析失败：显示明确错误原因和可执行的重试入口」 |
| 5 | **去重键从 revision 换成决策节点指纹**：后端预览已给出节点标识（街道 + 行动历史摘要 + Hero 位置 + 有效筹码），用它代替 revision | 前端为主，可能需后端多给一个字段 | 根因 3。同一节点不重算；**需要后端暴露节点指纹**（小改动，需一并确认） |
| 6 | **状态机补齐**：把「等待中 / 缓存读取 / 快速决策 / 完整求解 / 完成 / 失败 / 超时 / 已取消」做成显式状态而不是 `app.autoState` 的几个字符串 | 仅前端 | 满足第六节的状态要求 |

---

## 八、性能预算建议（基于实测基线）

| 场景 | 实测 | 建议目标 | 达成手段 |
|---|---|---|---|
| 翻前缓存命中 | 183–232 ms（context 88–110 ms） | **≤ 300 ms** | 已达到 |
| 翻前缓存未命中（求解器离线） | 191–400 ms | ≤ 500 ms | 已达到 |
| 翻后（翻牌） | **2797–3086 ms** | **≤ 800 ms** | 需方案 A（worker）或方案 B（预算） |
| 翻后（转牌/河牌） | 1007–1032 ms | ≤ 600 ms | 同上 |
| 求解器**在线**且需冷求解 | 未测（求解器当前离线；历史实测 6 人桌 59 s / 9 人桌 195 s） | 不阻塞录入；界面如实显示进度 | 方案 A + 现有后台队列 |
| 牌局录入 | 正常 12–53 ms；分析期间 **2791 ms** | **≤ 200 ms（任何时刻）** | 方案 A |

**说明**：求解器当前**未启动**（`/api/gto/health` 返回 `reachable: false`），
因此本轮的「缓存未命中」实测的是**求解器离线**路径。
求解器在线时的冷求解耗时沿用历史实测值（6 人桌 59 s / 9 人桌 195 s），
**本轮没有重新测量** —— GTOpen 源码不在本仓库（`GTOopen/` 未纳入本项目），
启动它需要用户确认。

---

## 九、复现方式

```powershell
# 1. 启动服务（仓库根目录）
cd D:\德州
node --experimental-strip-types src\app\webServer.ts      # 127.0.0.1:5173

# 2. 分段耗时基线（真实 HTTP）
cd D:\德州-audit-20260922
node --experimental-strip-types probe-analyze-segments.ts

# 3. 事件循环阻塞证据
node --experimental-strip-types probe-blocking.ts

# 4. 前端请求计数（真实浏览器 + CDP）
node --experimental-strip-types probe-analyze-requests.ts

# 5. CPU profile（找出热点函数）
node --experimental-strip-types --cpu-prof --cpu-prof-dir=prof probe-cpuprofile.ts
node --experimental-strip-types probe-profile-read.ts
```

---

## 十、尚未解决的问题

1. **求解器在线时的冷求解耗时未在本轮复测** —— 需要用户确认是否启动 `GTOopen/`。
2. **单线程 Node 的架构限制** —— 方案 A 是根治手段，但属于核心改动，等确认。
3. **求解器硬超时后的「僵尸请求」**：`GtoSafeLookup.lookupScenarioOnce` 用
   `Promise.race([provider.lookupScenario(), timeout])`，超时后底层请求**无法取消**，
   仍会占着 Provider 内部的串行队列（`this.queue`）。这与用户第六节
   「过期任务取消」有关，但改动落在 GTO 接入层 ⇒ 需一并确认。
4. **`meta.timings` 用的是 `Date.now()`**（`alphaPipeline.ts:954/957`），
   用户第三节要求「单调时钟」。改成 `performance.now()` 属于低风险改动，
   但会动到 `analyzeManualHand` 内部 ⇒ 列入方案 A 一起做更合适。
