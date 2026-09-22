# 求解器接线审计 —— 现有连接用对了吗

- 审计对象：`D:\德州`（只读为主；本轮对**接线**只做了一处必要修补，见 §六）
- 方法：全部结论来自**真实生产函数**，不是重新实现。探针在 `D:\德州-audit-20260922\probes\SOLVER-*.ts`
- 前置更正：本报告**推翻了**我在上一轮报告 §2.6 里"生产环境里求解器范围一次都没被用上"的结论 —— 那是我的探针错误。详见 §七

---

## 一、捷径答案

| 问题 | 答案 |
|---|---|
| **接在哪个入口** | 只有 **1 个业务入口**：HTTP `POST /api/analyze`（`webServer.ts:812-837`）。另有 5 个**查询/诊断**入口 `/api/gto/*`。直接调 `analyzeManualHand` 的调用方**完全不走求解器** |
| **哪些局面能调用** | 结构上只有 **RFI**（第一个行动位开池，且观察到的开池尺寸 = 2.5BB）与 **VS_OPEN**（恰好 1 次加注后行动回到 Hero）。**生产配置 `maxRaises = 2` ⇒ VS_OPEN 实际不可达** |
| **什么结果会被接受** | 四道闸：① 结构（节点可达 / 行动者身份 / 频率非空）② 设置匹配（开池/3Bet 尺寸）③ **收敛准入**（本轮新增）④ 冻结座位会污染 gap ⇒ 降级）。缓存 18 条里 **15 条通过、3 条被拒** |
| **有没有影响页面建议** | **有，而且影响很大。** 实测同一输入注入求解器范围后，决策响应里 **225 个字段**发生变化：整体范围权益 83.0% → 84.7%、Call EV 306.36 → 315.81、他弃牌率 62.8% → 61.6%、RAISE EV 2568.69 → 2579.19、置信度 0.30 → 0.35、范围可信度 0.30 → 0.55，**连用户看到的中文理由文本都变了** |

**一句话**：接线是**通的、真实生效的**，但**覆盖面很窄**（多数局面结构上算不了或尺寸对不上），而且**通过率取决于缓存里恰好有哪些局面** —— 这正是"先把现有连接用对，再扩大数据"的意义所在。

---

## 二、入口

### 2.1 业务入口（唯一）

`src/app/webServer.ts:812-837`（`POST /api/analyze`）：

```ts
const gtoPrefetched = isGtoEnabled()
  ? await prefetchSolverRangesForInput(input, { gtoProvider: gtoProvider(), gtoLookup: gtoCachedLookup() })
  : { ranges: {}, warnings: [], outcomes: [], elapsedMs: 0 };

const background = isGtoEnabled() && options.gtoBackgroundSolve !== false
  ? queueBackgroundSolverRangesForInput(input, { gtoProvider: gtoProvider(), gtoLookup: gtoCachedLookup() })
  : [];

const gtoStatus = buildGtoStatusJson(gtoPrefetched, background);

const result = analyzeManualHand(input, {
  rules, asOf: Date.now(),
  ...(Object.keys(gtoPrefetched.ranges).length > 0 ? { gtoRanges: gtoPrefetched.ranges } : {}),
});
```

三条纪律（都已实测符合）：

| 纪律 | 实现 | 实测 |
|---|---|---|
| 前台**绝不求解** | 只调 `lookupCachedOnly`（`GtoCachedLookup` 接口刻意不含慢方法） | 预取耗时 **10 ms** |
| 未命中就**排后台**，不 await | `queueBackgroundSolverRangesForInput` 返回**入队状态**而非结果（类型上杜绝误等） | 20BB 局面 ⇒ `SOLVING`，前台不等 |
| 失败**不阻断不静默** | 原因一路带到响应 `gtoStatus.outcomes[].reasonZh` | 见 §四 |

### 2.2 直接调 `analyzeManualHand` 的入口**不走求解器**

`analyzeManualHand` 的 `AnalyzeOptions` 里 `gtoProvider` / `gtoLookup` 是**可选**的
（`alphaPipeline.ts:215-230` 注释：*"这个字段只是让 `prefetchSolverRanges()` 知道去哪问"*）。
`prefetchSolverRanges` 第一件事就是它们为空就返回空（`alphaPipeline.ts:534-536`）。

**实测**：我的探针里**同一个输入**跑两次 —— 不注入时 `rangeSource: "HEURISTIC"`、
`sourceId: "heuristic.preflop-rfi.v1"`；注入后才变 `"EMPIRICAL"` / `solver.preflop-range.<commit>`。
也就是说：**求解器只影响 web 路径**；任何直接调用（脚本、测试、其它入口）拿到的永远是启发式先验。

### 2.3 查询 / 诊断入口（`/api/gto/*`）

| 路由 | 作用 |
|---|---|
| `GET /api/gto/health` | 求解器健康（`gtoHealth()`） |
| `GET /api/gto/catalog` · `/api/gto/catalog/extended` | 场景目录（哪些局面**结构上**能算） |
| `POST /api/gto/range` · `/api/gto/range/extended` | 手动查一份范围（**会真的求解**，属诊断面板） |

这 5 个是**独立的查询面**，不参与 `/api/analyze` 的建议生成。

---

## 三、哪些局面能调用（逐条实测）

走真实 `prefetchSolverRangesForInput`，17 个局面：

| 局面 | 注入 | 对手 | fromSolver | 结局 / 理由 |
|---|---|---|---|---|
| 6MAX / 100BB / UTG 开池 2.5 / Hero=BB | **1** | UTG | ✅ SOLVED | — |
| 6MAX / 100BB / UTG 开池 2.5 / Hero=CO（尚未行动） | **1** | UTG | ✅ SOLVED | — |
| 6MAX / 40BB / UTG 开池 2.5 | **1** | UTG | ✅ SOLVED | — |
| 6MAX / 100BB / HJ 开池 2.5（非首位） | 0 | — | — | 劫持位是开池者，但 RFI 模板**只覆盖第一个行动位** —— 算不了，**等也不会变** |
| 6MAX / 100BB / CO 开池 2.5 | 0 | — | — | 同上（关煞位） |
| 6MAX / 100BB / BTN 开池 2.5 | 0 | — | — | 同上（庄家位） |
| 6MAX / 100BB / UTG 开池 **3.0** | 0 | UTG | ❌ NOT_APPLICABLE | 实际开池 3BB，求解配置 2.5BB ⇒ 描述的是**另一个牌局** |
| 6MAX / 100BB / UTG 开池 **2.0** | 0 | UTG | ❌ NOT_APPLICABLE | 同上 |
| 6MAX / **20BB** / UTG 开池 2.5 | 0 | UTG | ❌ **SOLVING** | 缓存里**真没有**这条（键 `c22ad40a9`）⇒ 已排后台 |
| **9MAX** / 100BB / UTG 开池 2.5 | 0 | UTG | ❌ **SOLVING** | 键 `c7348fc89`，缓存里**没有**（9MAX 只有 `cc3e8ffd7`，开池者是 UTG1） |
| 6MAX / **200BB** / UTG 开池 2.5 | 0 | UTG | ❌ **SOLVE_FAILED** | **准入拒绝**：gap 0.252987 ≥ 目标 0.2 |
| 6MAX / **1000000BB** / UTG 开池 2.5 | 0 | UTG | ❌ **SOLVE_FAILED** | **准入拒绝**：gap 129.147510 ≥ 目标 0.2 |
| 6MAX / 100BB / UTG 2.5 → **BTN 3Bet 7.5** | 0 | — | — | 本手 2 次加注，生产 `maxRaises = 2` ⇒ 算不了（**不是**"等一会儿就有"） |
| 6MAX / 100BB / 多次加注（→ 4Bet） | 0 | — | — | 无候选 |
| 6MAX / 100BB / 全跛入 | 0 | — | — | 无人加注，场景模型表达不了 |
| 6MAX / 100BB / 翻后（FLOP 节点） | 0 | — | — | 结构上不适用（GTOpen 只解翻前） |

**合计：9 个候选局面里只有 3 个真的用上求解器范围。**

### 3.1 覆盖面为什么这么窄

| 限制 | 位置 | 性质 |
|---|---|---|
| 只覆盖 **RFI 的第一个行动位** | `solverScenarioForOpponent.ts:120-128` | 场景模型的**已知上限**（不是"暂时不支持"） |
| 开池尺寸必须**恰好 2.5BB** | `solveSettingsMatch` | 求解器只解它配置的那棵树 |
| **VS_OPEN 虽已实现但不可达** | 生产 `maxRaises = 2` | ⚠️ **这是"接线用对"最值得先动的一处**：代码支持 3Bet 后的节点，但配置把加注上限卡在 2，于是 `raiseCount ≠ 1` 一律被挡 |
| 缓存里**只有 18 条**，且分布不均 | `data/gto-cache/` | 见 §四 |

### 3.2 缓存实际覆盖了什么（18 条全量）

| 桌型 | 条数 | 有效筹码档 |
|---|---|---|
| 4MAX | 3 | 50 / 100 |
| 5MAX | 1 | 100 |
| 6MAX | 13 | 2.5 / 3 / 5 / 10 / 20 / 40 / 50 / 100 / 200 / 1000 / 1000000 |
| 8MAX | 1 | 100 |
| **9MAX** | **0** | — |

**9MAX 一条都没有** —— 而项目定位是 9 人桌为主（`CURRENT_PROJECT_STATUS.md`）。这是"扩大数据"时最该先补的缺口。

---

## 四、什么结果会被接受（四道闸 + 实测通过率）

| # | 闸 | 判据 | 拒绝后的状态 |
|---|---|---|---|
| ① | **结构** | 节点 `reachable`；`range.actorPosition === 我们要建模的位置`；该动作上至少有一手牌频率 > 0 | `SOLVE_FAILED` |
| ② | **设置匹配** | 观察到的开池尺寸 = 求解配置（2.5BB）；3Bet 尺寸 = 开池 × `raiseMults` | `NOT_APPLICABLE`（"等也不会变"） |
| ③ | **收敛准入**（本轮新增） | `notConverged !== true`；`gap` 与 `target` 都是有限正数；`gap < target`；`stopReason ≠ iteration_limit`；`solverState ∉ {running, queued}` | `SOLVE_FAILED` + 中文原因 |
| ④ | **冻结座位** | 只有全部座位都在学习时 gap 才有意义 | 由 `gradeGtoQuality` 降级 |

### 4.1 18 条缓存的裁决（真链路 `lookupCachedOnly`）

**命中 18 · 未命中 0**；**准入 15 · 拒绝 3**：

| cacheKey | 场景 | gap | 目标 | 裁决 |
|---|---|---|---|---|
| `c067cd8cb` | 6MAX/**1000000BB**/UTG/RFI | **129.147510** | 0.2 | ❌ NOT_CONVERGED |
| `cb693226d` | 6MAX/**1000BB**/UTG/RFI | 1.007083 | 0.2 | ❌ NOT_CONVERGED |
| `c0b705399` | 6MAX/**200BB**/UTG/RFI | 0.252987 | 0.2 | ❌ NOT_CONVERGED |
| 其余 15 条 | 2.5 ~ 100BB | 全部 < 目标 | 0.05~0.2 | ✅ 准入 |

### 4.2 键的正确性（这是"用对"的前提）

- **18/18 条的缓存键可由生产口径逐位复算**（`keysOf(scenario, provider.solveKeyParts(scenario))`）；
- **无别名键**：我一度怀疑"40BB 与 50BB 共键"（`c50f1d8ac` 的 `scenarioZh` 写 40BB 而 `createdAt` 与 50BB 条目同分钟），实测**排除** —— 它 genuinely 是 40BB 那条；
- 逐维扰动实测：筹码深度、桌人数、开池尺寸（经 `solveSettingsMatch`）都能区分；**唯一不进键的是 RFI 的 `openSizeBB`**（因为 RFI 前序动作恒为空），这正是闸 ② 存在的理由。

### 4.3 未收敛的会被拒，但已收敛的**不会**被误杀

闸门只拒 3 条、放行 15 条 —— 两边都非空，说明它**有判别力**，不是"一律拒绝"。
这也回头印证了上一轮的判断：**不给 `effectiveStackBB` 加人为上限是对的**，
否则 40 / 50 / 100BB 这些**合法且已达标**的数据会被一起砍掉。

---

## 五、有没有影响页面建议（实测 225 个字段）

同一个输入跑两次 `analyzeManualHand`（不注入 vs 注入真实 `prefetchSolverRanges` 产出）：

### 5.1 变化的量（节选）

| 字段 | 不注入 | 注入 | 说明 |
|---|---|---|---|
| `decision.confidence` | 0.30 | **0.35** | 顶层置信度 |
| `decision.reasons[3].data.heroEquity` | 83.0% | **84.7%** | 对对手范围的权益 |
| `…reasons[1].data.callEV` | 306.36 | **315.81** | 跟注 EV |
| `…reasons[1].data.raiseEV` | 2568.69 | **2579.19** | 加注 EV |
| `…reasons[1].data.foldLikelihood` | 62.8% | **61.6%** | 他面对加注的弃牌率 |
| `decision.diagnostics.range.confidence` | 0.30 | **0.55** | 范围可信度 |
| `decision.diagnostics.range.supportSize` | 239 | **1225** | 范围组合数 |
| `decision.diagnostics.range.metrics.normalizedEntropy` | 0.9461 | **0.7054** | 范围集中度 |
| `decision.diagnostics.versions.rangeSource` | `HEURISTIC` | **`EMPIRICAL`** | 来源类别 |
| `decision.diagnostics.range.sourceId` | `heuristic.preflop-rfi.v1` | **`solver.preflop-range.92c86ed…`** | 来源标识 |
| `…reasons[0].textZh`（**用户看到的中文**） | "…83.0% 高于跟注所需 27.3%：跟注 EV = 306.36 筹码…" | "…**84.7%**…跟注 EV = **315.81** 筹码…" | 理由文本 |

**递归比对共 225 处不同。**

### 5.2 这个局面里动作没变，但**不能**据此说"求解器没影响"

本例 `recommendedAction` 都是 `RAISE`、尺寸都是 10000 —— 因为 AA 的决策余量很大。
但权益/EV/弃牌率/置信度**全都变了**，在边缘牌上这些量足以翻转动作。
所以正确说法是：**求解器确实驱动了页面数字与文案；本例的动作恰好未翻转。**

### 5.3 决定性案例：**脏数据此前真的会被采用**

`c067cd8cb`（6MAX/1000000BB）此前**没有**任何收敛检查，会被当成求解器结论换掉对手整个范围。
本轮加上准入闸后，同一局面实测：

```text
fromSolver = false
state      = SOLVE_FAILED
reasonZh   = 求解器数据未通过**准入**（NOT_CONVERGED）：求解器把本次结果标为**未收敛**
             （approximation.notConverged = true）—— 频率是中途快照，不是均衡，不能用来算对手范围。
             该快照仍保留在缓存中供诊断查看，但**不参与本次建议**，本次回落启发式先验
```

**这是本轮唯一改动的接线行为。**

---

## 六、本轮对"接线"做的一处修补：把准入结论显示出来

**问题**：页面此前只能看到一个**裸数字** `gap 0.16526005516619705`，
而"0.165 算不算达标"**无法从页面判断**（达标线是求解器自设的 `targetGap`，本例 0.2）。
既然这个覆盖会改动 225 个字段与用户看到的中文，使用者就该能判断它可不可信。

**改动**（`contextBuilder.ts` / `solverRangePrior.ts` / `alphaPipeline.ts`）：

- 准入闸通过时返回一句话结论 `verdictZh`；
- 经 `SolverRangePrior` → `SolverRangeOverride` 带到 provenance；
- 页面现在显示：

```text
枪口位 的**求解器**翻前范围（开池）。求解器 92c86ed73aa0856df8479b5c7635e1469f48f1e8，
取用动作 [RAISE/ALL_IN]，迭代 40，gap 0.16526005516619705（目标 0.2）。
✅ **已通过准入：BR gap 0.165260 < 目标 0.2（停止原因 target_gap）**。
⚠️ 翻前是**近似延续模型**，因此这不是完整 GTO，也**不是**已验证数据。
```

字段设为**必填**（不是可选带默认值）：默认值会让"未经准入的覆盖"冒领一句
"已通过准入"，那正是本项目最不能接受的一类缺陷。因此所有构造点（含 1 处测试夹具）
都必须显式给出结论，实测 `tsc` 抓到 1 处并已如实标注为"测试构造的范围覆盖"。

---

## 七、更正：上一轮报告 §2.6 的结论是错的

| | 内容 |
|---|---|
| **我上一轮说的** | "生产环境里求解器范围一次都没被用上"；理由是盲注动作 `POST_SB`/`POST_BB` 进了 RFI 前序历史 ⇒ `buildGtoScenario` 返回 `null` |
| **实际情况** | **接线是通的。** 生产走 `scenarioForOpponent`，它给 RFI 传的**本来就是** `actionHistory: []`，盲注动作根本不会进来 |
| **我错在哪** | 我绕过 `scenarioForOpponent` **直接**调 `buildGtoScenario({kind:'RFI', actionHistory: [...]})`，验的是一个**生产根本不会构造的输入**。我算出的 `c6458d2a5` 也不是任何真实缓存键 —— 真正的那把是 `c91e7b60a` |
| **正确的做法** | 用生产函数（`prefetchSolverRangesForInput`）跑，而不是复刻它的一环。改成这样之后同一局面立刻 `SOLVED / fromSolver=true / cacheSource=persistent / elapsedMs=10` |

**这条更正提高了上一轮修复的重要性**：准入闸拦的不是"理论风险"，
而是一条**可达的、会真实改动 225 个字段**的脏数据路径。

上一轮报告对应小节已就地标注为"已推翻"，并保留了原文以便追溯。

---

## 八、下一步建议（按"先把连接用对"排序）

| 优先级 | 事项 | 理由 |
|---|---|---|
| **P0** | **补 9MAX 缓存** | 项目定位是 9 人桌为主，而 9MAX 缓存**一条都没有** ⇒ 主战场完全用不上求解器 |
| **P0** | **把 `maxRaises` 从 2 放到 3** | 代码**已实现** VS_OPEN（"Hero 开池后被 3Bet"）这条最有价值的分支，但生产配置把它挡死了。这是"已经写好却没接上"的典型 |
| P1 | 清理 3 条未收敛缓存 | 它们已被准入闸挡住，留着只会让人误会"缓存里有 200/1000/1000000BB 的数据" |
| P1 | 补常见筹码档 | 缓存里 20BB 那档**键对不上**（`c22ad40a9` 不存在），而短码是最需要求解器的场景 |
| P2 | 把"某局面算不了"的原因做成可检索清单 | 已有 `describeWhyNoCandidatesZh` 逐条中文说明，可以汇总成"哪些局面本项目结构上算不了"的固定清单 |
| P2 | 记录并展示缓存的**新鲜度** | 现有条目是 2026-09-14/15 生成的；求解器 commit 变了以后旧条目会失效（键含 commit），届时会退化成"全部 SOLVING" |

---

## 九、未验证

- **后台补算真的求解并落盘**未在本轮实测：那会**永久新增一条缓存条目**（污染使用者数据），
  而该行为已有既有测试锁定。本轮只验到"未命中 ⇒ 排后台 ⇒ 状态 `SOLVING`"。
- **浏览器**上这 225 个字段**渲染出来是什么样**未验证（本会话无浏览器自动化工具）。
  我能证明的是响应里带了这些字段与那句准入结论，不能证明前端把它们都显示出来。
- **求解器在线时的冷求解路径**未跑（只走缓存；前台本就只读缓存）。
- `enginePositions` / `posts` 等求解侧参数变化是否会让现有 18 条**全部失配**未逐项验证。
