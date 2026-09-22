# 当前项目状态 —— 单一事实来源

> **本文件是项目阶段状态的唯一权威来源。**
> 其他文档（`V2_ARCHITECTURE.md` / `TEST_MATRIX.md` / `STEP_REPORTS.md`）描述设计与历史；
> **只有本文件描述「现在到底完成到什么程度」。**
>
> 有测试（`test/projectStatus.test.ts`）断言本文件与**实际代码**一致 ——
> 若代码已实现而本文件仍写「未实现」，测试会失败。
> 这是防止「文档说待办、代码已完成」这类状态漂移的机制。
>
> **最后审计日期**：2026-09-14 · **审计方式**：核对实际文件清单 + 全量测试运行

---

## 1. 一句话状态

> **端到端链路已打通**：可以打开网页、手动输入一手牌、
> 在约 100 毫秒内得到「动作 + 合法尺寸 + 置信度 + 分类 + 中文原因」。
>
> **「9 座桌 8 人」这个现金局最常见的形态已经可用**（Table Topology Correction）：
> 空座位与暂离只意味着「本手少几个人」，不再让整张牌桌无法分析。
>
> ⚠️ **但「能用」不等于「可信」**：范围是**启发式先验**（非求解器输出）、
> 抽水未计入、**尚未用真实牌局验证过**。下一步唯一要做的事就是拿真实牌来测。

---

## 1.0 最近一轮：V2.1 画像敏感度与决策影响审计（**不是新 Phase**）

> 判定：`V2.1 PROFILE SENSITIVITY & DECISION IMPACT — PASS_WITH_WARNINGS`
> 报告：`reports/PROFILE_V21_SENSITIVITY_AUDIT.md`（20 节）
> 风险登记：`reports/V21_RISK_REGISTER.md`（D1–D18）
> 独立审查：5 个视角，各自报告 `reports/V21_REVIEW_1..5_*.md`；生产链路独立核查
> `reports/V21_PRODUCTION_CHAIN_VERIFICATION.md`；18 项失败模式 `reports/V21_FAILURE_MODE_AUDIT.md`

**实测结论（1260 组合矩阵 + 8 场景语料 + 12 项决策影响指标）**：

```text
画像影响分类（本轮实测）  = TRIVIAL
max |equityDelta|         = 1.9761pp   （**同一行**的 max |bluffMassDelta| = 4.5242pp）
阈值（未改动）            = equityMaterial 0.02 / massMaterial 0.05
action flip               = 0 / 1260（0.00%）
sizing change             = 0（本夹具无下注决策点）
合理输入微扰下动作翻转    = 0 / 11 画像
Profile Dominance 违规    = 0 / 11
```

⚠️ **不要把这组数字读成「画像有用」或「画像没用」**：
1260 行其实只有 **305 次不同调用 / 267 个不同结果**（E2 整块被 E1 包含、
E3 的 N0 档与 E0 逐位相同），且**全部落在同一个固定牌局**上。
它是「描述性最大值」，不是推断统计。

**本轮修了 4 个真缺陷**（前后证据见 `reports/evidence/v21-defect-evidence-{before,after}.txt`）：

| # | 缺陷 | 修前实测 | 修后 |
|---|---|---|---|
| D6 | 画像去重闸门读**代理指标**（`provider.applied`），三处会误判为 false（河牌统一似然通道 / 跛入原型通道 / 画像挂在非首要对手） ⇒ 同一份范围证据被计两次 | `bluffCatchDelta` 0 → +0.035、`deDuplicated` true → false、`profileCompressionMultiplier` 1.0000 → 0.9020 | 新增事实字段 `profileAppliedToRange`，闸门改读它；证据对象改按 `villainId` 定位 |
| D7 | `successes`/`opportunities` 的 **NaN / Infinity 穿透**到似然 ⇒ 整条贝叶斯更新被**静默丢弃**，权益反而 **+11.25pp** | `successes: NaN` ⇒ 权益 67.5071%、callEV 17.728、**无 warning** | `PARSE` 阶段 `INVALID_NUMBER` 阻断，字段路径精确 |
| D8 | 残缺画像（`traits` 缺条目）**把整手牌打挂** | `CONTEXT_BUILD_FAILED`（不可分析） | 缺失条目**回落池先验**，可分析 |
| D-数值 | `profileMaterialityOf` 对 NaN/Infinity 无守卫 ⇒ 展示成正常档位 | `equityB=Infinity` ⇒ **STRONG**（"权益差 Infinitypp"）；`NaN` ⇒ TRIVIAL | 非有限输入 ⇒ `NO_EFFECT` + 「**无法判定**」（与「影响很小」分开） |

**未修但已登记**（本轮审计边界之外，全部带 `file:line` 与实测数字）：
`callTooWide` 是**死条目**（D14）、`THIN_VALUE` 的槽位数 K=2 但只有 1 个可填槽（D11）、
跛入池上「中性」不中性（`NORMAL` vs `UNKNOWN` Δ=2.695615e-4，D12）、
生产链**拿不到实测手牌历史**（D4）、人工读与标签先验之间**没有收缩**（D9）、
尺寸档 4 档里**只有 0.6 一个活边界**（D17）、
`riverConsistencyV21.test.ts` 全程只用中性标签 ⇒ **它不是画像回归锁**（D15）。

**未升 `ALPHA_DECISION_MODEL_VERSION`**（仍为 `1.0.5`）：本轮改动**不改变任何判定阈值**，
且在**合法输入上逐位不变**（已用前后证据证明）。

---


## 1.1 最近一轮：Table Topology Correction（**不是新 Phase**）

> 判定：`# TABLE TOPOLOGY CORRECTION — PASS`
> 报告：`reports/TABLE_TOPOLOGY_CORRECTION.md`（25 节）

**解决的问题**：全项目把「牌桌有几个座位（`tableSize`）」与「本手几个人」
当成同一个数字，导致 **9 座桌坐 8 个人时整张牌桌无法分析**。

| 项 | 修复前 | 修复后 |
|---|---|---|
| 9 座桌 8 人 | `canAnalyze === false`，要求「每个座位都有人」 | **可分析**；空座位只如实告知「本手 8 人参与」 |
| 暂离 | 阻断分析 | 暂离者不参与本手（不发牌、不占盲注），**不阻断** |
| 单挑 | **完全无法录入**（BTN CALL / BB CHECK 被拒） | 可完整录入；翻牌后先问大盲 |
| 满桌翻牌前开池 | **100% 被拒**（把未行动的 8 人当成已参战） | 按**已实现**对手数判定；未行动者只提示 |
| Button | 只有自动轮转 | 自动轮转 + 「设为庄家」（`SET_BUTTON`，仅本手未开始时） |
| 界面 | 「D」写死在座位 BTN 上（与实际相反） | 「D」来自后端拓扑的 `buttonSeatId` |
| 范围先验 | 按**容量**二分（8 人桌 UTG 偏松） | 按**本手人数**选档 |

**关键教训（比具体缺陷更重要）**：修复过程中出现过「域层放行了 8/9，
表层 `staffingProblems` 又拦回来」——**拦截点搬家**。
单测任何一层都发现不了它，因此留下一组永久防线：
`test/tableTopology.test.ts` §2「反证：域层不拒绝时表层也不得拒绝」、
§10「HTTP 产品路径」，以及只走产品入口的探针 `scripts/rt-topology-verify.ts`。

**独立审计**：`reports/TABLE_SIZE_SEMANTICS_AUDIT.md`
（185 处 `tableSize` 分桶 → 11 处真混用，结论行「仍有混用」，本轮逐条落地）。

**本轮未动**：数学 / Equity / Range 核心算法 / Player Profile / Dynamic /
Environment 策略 / Decision 策略 / Confidence —— **全部冻结未改**。
唯一解锁的是 Poker Core 的桌型处理。

---

## 1.2 最近一轮：PLAYER PROFILE V3 RESOLVER 定向修复（**不是新 Phase**）

> 判定：`PROFILE_RESOLVER_V3_FIX — PASS_WITH_WARNINGS`
> 回归锁：`test/profileResolverV3Fix.test.ts`（26 项：TEST VECTOR A–J + MURPHY 1–10 + 算术锁）

TEST 12 证明 resolver 的**维度映射**与扑克语义冲突：1500 手教科书级跟注站
（VPIP 52 / PFR 9 / WTSD 43 / FoldRiver 14）被解析成
`tightness 0.5377 / aggression 0.2277 / passivity 0.4700 / bluffTendency 0.5000`
—— 「比中性略紧、比中性略不被动」。三个根因逐条修复：

| # | 根因 | 修复 |
|---|---|---|
| P0-A | 所有统计共用 `center(rate) = (rate − 0.5) × 2` ⇒ 松的方向几乎不可见、WTSD 43% 反而把 passivity 往下推 | 逐统计 `neutralAnchor` + `scale`（VPIP 0.28/0.18、PFR 0.20/0.15、WTSD 0.27/0.15、FoldTo*CBet 0.45/0.22 等），归一化为 `(rate − anchor) / scale` |
| P0-B | 有实测时 resolved 维度**覆盖**标签维度（同一份实测 + CS/NIT 标签逐位相同） | `resolved = (1−w)·base + w·observed`，`w = evidenceMass/(evidenceMass + K_PROFILE_LABEL)`，`K_PROFILE_LABEL = 500` 次机会 |
| P0-C | `bluffTendency` 无观测通道 ⇒ 有实测时恒 0.5 | 无证据的轴**逐位保留标签**（`evidenceMass = 0 ⇒ resolved = base`） |

字段语义（**必须分清**）：`dimensions` = 只有实测说话（旧字段，语义未变）；
`observedOnlyDimensions` = 同上的显式别名；`resolvedDimensions` = **下游消费的融合值**；
`baseDimensions` / `evidenceMass` / `blendWeight` 供审计。

`ALPHA_DECISION_MODEL_VERSION` **1.0.6 → 1.0.7**（这次真的改判定，不是纯诊断字段）。
清单补登记：`src/domain/player/observedStats.ts` 此前**未**被 hash 绑定
（本轮核对：清单实际 154 个产物，而本节此前写 152 —— **文档数字已陈旧**；
补登记 1 个 → **155**）。

⚠️ **未修（有意保留，已登记）**：`OBSERVED_STATS_TO_RANGE = FUTURE_WORK` ——
实测统计仍不进入**到达范围**（范围先验按标签选档），本轮只修维度与响应层。

---

## 2. 项目定位（已锁死）
| 项 | 内容 |
|---|---|
| 使用者 | **仅供内部个人使用** |
| 核心目标 | **手动输入牌局后，在 1～3 秒内给出可靠的 Action + Size + Confidence** |
| 主场景 | 低级别线上现金局 |
| 次场景 | 中低级别线上现金局 |
| 锚点 | 理论参考（**非** GTO 最优，本项目无求解器输出） |
| **不是** | 商业产品 / 完整扑克平台 / 研究项目 / 架构演示 |

### 唯一重要的问题

> **这个功能是否直接提升「现在这手怎么打」的质量？**
>
> 答案若是「不能」→ 默认**延后**。

---

## 3. 热路径锁定

```
Manual Input
  ↓
Validator
  ↓
Poker Math
  ↓
Range
  ↓
Player Profile
  ↓
Game Environment
  ↓
Dynamic Behavior
  ↓
Exploit Adjustment
  ↓
Decision Engine
  ↓
Action + Size + Confidence
```

**不得随意增加新的热路径模块。**

---

## 4. 十二层实现状态（**据实际文件核对**）

| # | 层 | 状态 | 证据 |
|---|---|---|---|
| ① | Poker Core | ✅ **已实现** | `cards.ts` / `handEval.ts` / `fastEval.ts` / `handDescription.ts` |
| ② | 状态检查器 | ✅ **已实现** | `validator.ts` / `gameState.ts` / `engine.ts` / `streetAdvance.ts` |
| ③ | 数学引擎 | ✅ **已实现** | `odds.ts` / `equity.ts` / `equityExact.ts` / `equityMonteCarlo.ts` / `equityPolicy.ts` |
| ④ | 范围引擎 | ✅ **已实现**（Step 5A + 5A.1） | `range.ts` / `rangeUpdate.ts` / `rangeLogSpace.ts` / `rangeValidator.ts` / `rangeCache.ts` / `combo.ts` 等 13 文件 |
| ⑤ | 玩家模型 | ✅ **已实现**（Step 6） | `player.types.ts` / `playerStats.ts` / `playerProfile.ts` / `playerClassifier.ts` |
| ⑥ | 动态行为引擎 | ✅ **已实现**（Step 7，已红队） | `src/domain/dynamic/` 5 文件：`dynamic.types.ts` / `dynamicStats.ts` / `dynamicDeviation.ts` / `dynamicBehavior.ts` / `dynamicAdapter.ts` |
| ⑦ | Exploit 引擎 | ✅ **已实现（极简版）** | 环境/画像/动态的**方向**通过 `contextBuilder` 汇总进 Decision；无独立大模块（规范第 43 节：第一版不建新大模块）→ `src/domain/environment/environmentAccess.ts` |
| ⑧ | 决策引擎 | ✅ **已实现**（Alpha，已红队） | `src/domain/decision/decision.types.ts` + `src/app/decision/decisionEngine.ts` + `src/app/alphaPipeline.ts` |
| ⑨ | 多智能体对抗审查 | ⬜ **未实现**（**已降级**，见 §8） | 无 `src/agents/` |
| ⑩ | 复盘引擎 | ⬜ **未实现**（**已降级**，见 §8） | 无 `replay.ts` |
| ⑪ | 漏洞引擎 | ⬜ **未实现**（**已推迟**，见 §8） | 无 `leak.ts` |
| ⑫ | 中文 UI | ✅ **已实现**（Alpha 最小版） | `i18n/`（唯一文案出口）+ `src/app/web/index.html` + `src/viewmodels/decisionViewModel.ts` + `src/app/webServer.ts` |

> 上表的「层名」与 `test/projectStatus.test.ts` 的 `LAYER_EVIDENCE` 一一对应：
> 测试会用 `| <层名> |` 定位每一行并核对状态标记与代码事实是否一致。
> **若代码已实现而本表仍写「未实现」，测试会失败。**

### 4.1 已实现但架构文档未单列的模块（**漂移修正**）

| 模块 | 状态 | 说明 |
|---|---|---|
| `src/domain/knowledge/`（3 文件） | ✅ 已实现 | Phase 4.5 知识来源体系（来源注册表 / 许可证门禁 / 不编造硬校验） |
| `src/domain/range/gameEnvironment.ts` | 🟡 已实现但**数值已弃用** | 3 种模式；**只允许方向**，见 §6 |
| `src/domain/environment/environmentAccess.ts` | ✅ 已实现（Alpha） | 环境**方向**接入层；**不导入** legacy 倍数值，结构上读不到 |
| `src/app/manualInput/`（6 文件） | ✅ 已实现（Alpha） | 手动输入解析 / 牌局重建 / 启发式范围先验 / 似然模型 / 合法动作推导 / 上下文组装 |
| `src/app/decision/decisionEngine.ts` | ✅ 已实现（Alpha） | Alpha 决策引擎（数学优先 → 策略其次 → 最终数学复核） |
| `src/app/alphaPipeline.ts` | ✅ 已实现（Alpha） | 端到端入口 `analyzeManualHand` |
| `src/app/decisionLog.ts` | ✅ 已实现（Alpha） | 决策日志（JSONL：输入哈希 / 版本 / 抽成口径 / 耗时） |
| `src/app/webServer.ts` + `web/index.html` | ✅ 已实现（Alpha） | 最小中文 Web UI（Node 内置 `http`，无 web 框架依赖） |
| **`src/app/table/`（6 文件）** | ✅ **已实现（交互式牌桌录入）** | 牌桌状态模型 / 座位生命周期 / 视觉旋转 / 适配器 / 预览 / API（**前端零规则**） |
| **`src/app/web/table.js` + `table.css`** | ✅ **已实现** | 纯渲染客户端（不含任何牌局规则，全部由后端权威计算） |
| `src/viewmodels/decisionViewModel.ts` | ✅ 已实现（Alpha） | 界面唯一消费入口（全部中文经 `t()`，无策略逻辑） |
| `src/domain/range/profileProvider.ts` | ✅ 已实现 | 画像/环境 → 范围的唯一连接点（已接入 `updateRange`） |
| `src/domain/range/handPotential.ts` | ✅ 已实现 | 启发式手牌潜力标尺（声明「不是胜率」） |
| `src/app/decisionDeadline.ts` / `decisionPipeline.ts` | ✅ 已实现 | 时间预算 + 阶段管线 |
| `src/infra/artifactManifest.ts` + `artifactDefinitions.ts` | ✅ 已实现 | 产物 hash 绑定（129 个产物） |

---

## 5. 产品决策能力进度（**这不是测试进度**）

> 说明：测试数量代表**工程保障**，不代表产品完成度。
> 下表是**产品能力**的真实状态。

### 5.0 端到端（Alpha 阶段新增，**这是最重要的表**）

| 环节 | 状态 | 说明 |
|---|---|---|
| **打开网页** | ✅ **可用** | **双击 `scripts/start-alpha.cmd`**（会自动起服务、等就绪、开浏览器）；停止用 `scripts/stop-alpha.cmd`。手动方式：`node --experimental-strip-types src/app/webServer.ts` → `http://127.0.0.1:5173` |
| **牌桌快速输入** | ✅ **可用** | 点座位 / 点牌面（4×13）/ 点行动 / 点画像：**每手中位 9 次点击，0 次键盘输入** |
| **Seat lifecycle** | ✅ **可用** | 加入 / 清空 / 更换玩家 / 暂离 / 重新入座 / 手后离桌 / 下一手 / 新牌桌 / 撤销（含座位绑定与画像） |
| **手动输入一手牌（表单）** | ✅ **仍可用** | 旧表单路径保留（`POST /api/analyze` 的 `{input}` 入口），与牌桌路径**逐位一致** |
| **输入校验（阻断）** | ✅ **可用** | 重复牌 / 街道与公共牌不符 / 底池对不上 / 行动顺序错 / 加注额非法 全部阻断，中文说明 |
| **数学计算** | ✅ **可用** | 底池/赔率/所需权益/权益/EV 全部来自既有 Poker Core |
| **范围** | 🟢 **翻前用求解器 / 其余用启发式** | 翻前在**严格匹配**时用 GTOpen 频率（可信度 0.55，来源 `EMPIRICAL`）；翻后、以及尺寸/场景对不上的情形用 169 类启发式先验（可信度 0.3）。两者都**逐家如实标注**，界面直接显示算了几家、每家来源是什么。见 §5.0.1 |
| **玩家画像** | 🟡 **可用但受限于数据** | 有实测数据时优先；无数据时用用户手选画像（可信度上限 0.35）；都没有则不提供调整 |
| **环境** | ✅ **仅方向** | 13 条 `env.*` 方向规则；**0 条带幅度**；不修改任何数学输出 |
| **动态（Shadow 模式）** | ✅ **可用** | 只影响置信度；**被明确禁止**翻转动作（幅度未校准） |
| **最终建议** | ✅ **可用** | Action + Size（合法）+ 置信度档位 + 分类 + 最多 3 条中文原因 |
| **内部调试区** | ✅ **可用** | 数学/Range/Player/Environment/Dynamic/Math Dominance/Shadow/耗时/版本 |
| **决策日志** | ✅ **可用** | JSONL：输入哈希 / 各模块版本 / 耗时 / 抽水口径 |
| **真实牌局验证** | 🟡 **未完成** | 牌桌录入已就绪；**尚未**用它跑过真实牌局（这正是下一步，20～30 手） |

> **牌桌录入的三条硬不变量**（本轮锁死，各有永久回归测试）：
> ```
> # Fold ≠ Leave Table
> # Seat ≠ Player
> # 当前 Hand 的历史事实不能因为玩家离桌而被删除
> ```

> **能力边界（必须如实告知）**：
> - **支持任意数量的已进池对手**：权益按**全部已进池对手一起**算，与底池赔率同口径。
>   本轮修复前只按**首要对手一家**算（口径不一致），因此 ≥3 家时只能拒答 ——
>   那让工具在 9 座桌现金局里基本失效（「一家开池、几家跟注」是常态）。
>   实测同一手 AK 顶对：单挑口径 87% vs 6 家口径 37.9%，**差 33 个百分点**
> - ⚠️ 但对手越多，**范围误差**叠加越严重 ——
>   界面会写明「权益已按这 N 家一起算」，请当参考而非精确结论
> - ⚠️ **还没有任何人进池**时（例如翻牌前第一个行动）**没有对手范围**可算权益，
>   此时如实返回「信息不足」—— 等有人跟注/加注后再分析
> - 下注/加注的 EV **不参与**比较（缺可信弃牌率估计），因此「加注 vs 跟注」由牌力档决定而非 EV
> - 抽水**未计入**（无 Rake Engine），所有 EV 都是未计抽水口径
> - 范围是**启发式**，界面上明确标注「非求解器输出，不是 GTO 范围」

### 5.1 按街道

| 街 | 决策能力 | 说明 |
|---|---|---|
| Preflop | 🟡 **可用（启发式范围）** | 有启发式开池/防守范围；无 baseline 实测数据 |
| Flop | 🟡 **可用（启发式范围）** | 范围先验 + 行动似然更新；权益为蒙特卡洛估计 |
| Turn | 🟡 **可用（启发式范围）** | 同上 |
| River | 🟡 **可用（启发式范围）** | 同上 |

### 5.2 按人数

| 场景 | 决策能力 | 说明 |
|---|---|---|
| HU（单挑） | ✅ **可用** | 主场景 |
| 2 名对手 | ✅ **可用** | 权益按**这 2 家一起**算（本轮修复：此前按单挑口径，偏乐观） |
| Multiway（≥3 人） | ✅ **可用（误差随人数上升）** | 权益按**全部已进池对手一起**算，与底池赔率同口径。本轮修复前是「明确拒绝」。⚠️ 人多时启发式范围误差叠加，因此置信度与分类会自动保守 |
| 无人进池（翻牌前第一个行动） | ⬜ **明确拒绝** | 没有对手范围 ⇒ 权益算不出来。等有人跟注/加注后再分析（**不是**因为「人多」） |

### 5.3 按环境

| 环境 | 决策能力 | 说明 |
|---|---|---|
| `LOW_STAKES_ONLINE` | 🟡 **仅方向** | 7 条方向型规则；**无幅度** |
| `MID_LOW_STAKES` | 🟡 **仅方向** | 5 条方向型规则；**无幅度**，无决策引擎 |
| `THEORY_REFERENCE` | 🟡 **仅结构性假设** | 非求解器输出，不得称为 GTO |

### 5.4 端到端

| 环节 | 状态 |
|---|---|
| 结构性手动输入（人数/位置/Stack/Hero Cards/Board/Action History/环境/对手） | ✅ **可用** |
| 输入校验与阻断（中文说明） | ✅ **可用** |
| 输出 Action + Size + Confidence + Classification + Reason | ✅ **可用** |
| 内部调试区（数学/Range/Player/Environment/Dynamic/Shadow/版本） | ✅ **可用** |
| Decision 日志（JSONL：输入哈希 + 版本 + 耗时） | ✅ **可用** |
| 中文 Web 入口 | ✅ **可用**（`http://127.0.0.1:5173`） |
| i18n 输入别名（自然语言输入） | ⬜ **刻意未做**（规范第 10 节：先做结构化输入） |
| 完整 Replay / 逐手回看 | ⬜ **未做**（已推迟，见 §8） |

### 5.5 结论

> **产品能力 = 已可端到端使用（内部 Alpha）。**
>
> 可以做到：**打开网页 → 手动输入一手牌 → 在约 100 毫秒内得到
> 「动作 + 合法尺寸 + 置信度档位 + 分类 + 中文原因」，并可在调试区看到每一层的原始数据。**
> 使用说明见 `docs/ALPHA_USAGE.md`。
>
> ⚠️ **但「可用」不等于「可信」**：
> - 范围**翻前已接求解器**、其余仍是**启发式**，界面上**每一家分开标注**
>   （未标注 = 不会有假来源）。**没有**任何一处会把启发式说成 GTO 范围

### 5.0.1 范围来源（**本轮新增，必须与上面的数字一起读**）

范围是**决策的输入数据**，它的来源决定了建议能信到什么程度。
本轮把翻前那一环从「猜的」换成了「算的」：

| 情形 | 范围来源 | 可信度 | 界面上显示 |
|---|---|---|---|
| 翻前 · 单个开池 · 尺寸与筹码严格匹配 · 求解器在线 | **GTOpen 频率**（取该节点的 `RAISE` / `CALL` 频率作为权重） | **0.55** | `自建启发式先验` **不会**出现；显示求解器 commit / 迭代 / gap |
| 翻前 · 多轮加注 / 跛入 / 补盲 | 启发式先验 | 0.30 | 如实显示启发式 |
| 翻前 · 实际开池尺寸 ≠ 求解配置 | 启发式先验 + **中文原因** | 0.30 | 写明「实际 X BB ≠ 配置 Y BB」 |
| 翻后（任何情形） | 启发式先验 + 行动似然更新 | 0.30 | 如实显示启发式 |
| 求解器离线 / 超时 | 启发式先验 + 中文原因 | 0.30 | 如实显示启发式 |

🔴 **三条不许动摇的纪律**：

1. **只在严格匹配时使用**：尺寸对不上就**回落**，不做「差不多就用」——
   那会读到**另一个牌局**的策略，而数字看起来完全正常。
2. **翻后不用翻前频率**：GTOpen 只解翻前。拿翻前频率描述翻后范围
   会丢掉全部翻后信息（谁在翻牌弃牌、谁在转牌加注）。
3. **可信度不是 1**：GTOpen 翻前是**近似延续模型**（源码自述），
   因此 0.55 是「明显高于启发式、但远不到已验证」。

⚠️ **实测数值影响很小**（必须如实说）：同一手牌、同局面下，
把启发式换成求解器范围，权益移动约 **±1–2 个百分点**，**没有翻转任何决策**。
原因是启发式先验在主要档位上与求解器给出的形状接近。
真正的收益是**来源可信**（0.3 → 0.55，且带求解器出处），不是数值大幅变化。
> - 抽水**未计入**
> - 下注/加注的 EV 不参与比较（缺弃牌率估计）
> - **尚未用真实牌局验证过** —— 这正是下一步唯一要做的事

---

## 6. 环境模型的当前纪律

| 项 | 状态 |
|---|---|
| 允许的形式 | **只有方向**（`INCREASE` / `DECREASE` / `CONTEXT_DEPENDENT`） |
| `magnitude` | **全部缺省**（23 条规则中 0 条带幅度） |
| `gameEnvironment.ts` 内的倍数值 | 🔴 **`deprecated / legacy-only`** —— 保留以向后兼容，**禁止新的生产 Decision 路径依赖** |
| 权威来源 | 知识层 `data/knowledge/strategy-rules.json` 的 `env.*` 规则 |
| 新增环境行为的正确做法 | **先在知识层加一条方向型规则**，不在 `gameEnvironment.ts` 里调数字 |

---

## 7. Step 5B 状态

**`BLOCKED / NOT REQUIRED FOR CURRENT DEVELOPMENT`**

- **BLOCKED**：Phase 4.5 审计的 4 个 GitHub 项目与 6 本书，**没有一个**提供可引用的翻牌前范围数据
- **NOT REQUIRED**：`PlayerProfile` 的收缩机制本来就要求「向先验收缩」，
  而先验**可以**是启发式的（标注 `HEURISTIC_PRIOR`，**绝不允许**冒充 `THEORY_PRIOR`/`GTO_PRIOR`）
- 真实数据到位后**替换 profile 对象即可，调用方零改动**
- **不阻塞**任何后续 Step

---

## 8. 已降级 / 已推迟的模块（防止横向扩张）

| 模块 | 原规划 | **现状态** |
|---|---|---|
| 8-Agent 多智能体 | 热路径的一部分 | 🔽 **降级为开发期 / 复杂复盘 / 红队工具**。普通实时决策不要求运行；热路径以**确定性代码优先** |
| Replay | 完整回放 | 🔽 **降级**：Alpha 之前只保存 **Decision Snapshot**；Replay 只做**最小逐手回看** |
| Leak Dashboard | 漏洞统计面板 | ⏸ **推迟**到 Alpha 之后 |
| 复杂统计图 | — | ⏸ **推迟** |
| 精美 UI | — | ⏸ **推迟**：Alpha 只要「能快速输入 + 清晰显示建议/尺寸/置信度/一句话原因」 |

### 8.1 明确禁止新增（除非 Alpha 测试证明必要）

新 GitHub 审计 · 新书籍审计 · 新 Agent 框架 · 新许可证基础设施 ·
新 Hash 框架 · 新商业功能 · 云同步 · 账户系统 · 排行榜 · 社交功能 · 高级 Dashboard

### 8.2 Phase 4.5 停止扩展

Phase 4.5 已 **PASS**。**禁止**继续主动寻找新的 GitHub 项目 / Solver / 扑克书籍 /
案例网站 / 外部策略规则 —— **除非**当前 Decision Engine 暴露一个**明确的知识缺口**。

---

## 9. 数学层的绝对优先级（永不被覆盖）

下列**不得被** Environment / Player Profile / Dynamic / Exploit / LLM 修改：

`Pot` · `Stack` · `Effective Stack` · `Hand Rank` · `SPR` ·
`Pot Odds` · `Required Equity` · `Equity 算法` · `EV 算法`

**Profile / Dynamic / Environment 只能改变概率**：
`Range Weight` · `Action Likelihood` · `Bluff Weight` · `Value Weight` ·
`Range Width` · `Strategy Preference`

**不能**直接输出最终 Action。

---

## 10. 工程保障现状

| 项 | 值 |
|---|---|
| 源代码 | 125 个文件 / 59306 行（含 GTO 子域、翻后模块、画像→范围桥与下注响应/合法动作树、面对下注画像通道 `src/app/manualInput/facingBetProfile.ts`；`GTOopen/` 下的外部求解器源码**不计入**本项目。口径：`src/**/*.ts`，2026-09-19 实测） |
| 测试代码 | **117 个文件**（口径：`test/**/*.test.ts`，2026-09-22 实测；另有执行 harness `test/helpers/tableJsHarness.ts`、`test/helpers/fakeGtopen.ts` GTOpen 结构替身） |
| 测试 | **2,247 项 / 137 套件 / 120 个测试文件**（**TABLE DYNAMICS V1 正确性收尾（54 项 —— 纯逻辑契约 47：A 无数据/旧格式记录被排除并计数/1 手样本不得编造数字；B 机会数≠动作次数、从未主动入池仍在分母、三档下注尺寸分桶互不合并；B4 证据足够时方向出现；C 连续 3 次 3Bet 不得宣称「压力高」、系数永不越 ±15%；D 整桌偏松不得覆盖个体紧（**断言作用范围明确的 tightness 而不是标签**）、个体不足才有限参考整桌并如实标注；E 离桌玩家被排除并计数；F Hero 自排除、分层不跨层求和、逐维度各自带机会数与可信度；G 只读行动前状态、记录形状无摊牌字段；H 单挑与「身后无人」显式 NOT_APPLICABLE、五类独立生成；I 摘要随桌况变化且不含耗时；J 影子模式十一条契约（正式建议先算且不被覆盖 / OFF 不计算 / 桌况异常与重算异常均收敛 FAILED / 超时 TIMEOUT 仍给桌况**且如实标记未做真实隔离** / **提供 withBudget 时预算原样传入并标记 budgetInjected=true** / **注入预算后不由外层宣布超时** / 证据不足不调整 / 对比结构化 / 可重放）；K 调整层不产出动作与金额；L 领域层标签必须落在 QuickProfile 枚举内；**M 六条真实缺陷回归锁 —— ①逐玩家维度必须能看见「别人先加注」（否则再加注压力机会数恒为 0）②强证据必须能定出方向（不得把 delta 二次收缩到门槛以下）③被动与凶必须在**轴**与**作用范围明确的维度**上区分开 ④个体证据充分时无关座位不影响注入维度 ⑤**任何会改动 bluffTendency 的标签一律判定为不可注入（不得用翻前再加注频率断言翻后诈唬倾向）** ⑥桌况层登记的标签维度必须与生产原型表逐项一致（防复制漂移；该测试当场抓出 3 项手抄错误）**。端到端 7 项：真实牌桌操作写入桌况字段逐字段核对 / 桌况层真能读到记录并产出维度 / 重复提交不重复累计 / 撤销后无残留 / 模式解析 / 影子对比记录字段齐全且可逐条读回 / 桌况变化则摘要变化）**；**PREFLOP RAISE DECISION 阶段 A/B（32 项：A-01/A-01b 34BB 最小再加注与 4Bet 节点逐尺寸建模；B-00a/B-00b 强度阶梯四条序关系 + 锚点表与结构式逐位一致 + 组合索引↔类别键 169 类全覆盖；B-01/B-02 每个尺寸各有自己的响应概率与 EV；B-03/B-03b/B-03c 概率守恒 + 条件范围归一化 + 价格单调 + 再加注闸门与两个全下判据；B-04/B-04b/B-04c/B-04d 独立复算 + 与唯一现金流公式逐位一致 + 被再加注分支同一零点 + 再加注尺寸由真实行动状态推导；B-06 尺寸对不上不得借用别的尺寸的 EV；B-07 换 Hero 底牌响应逐位不变；B-08/B-08b 不等筹码退回不计入投入；B-09/B-09b 非单挑与身后有人必须拒绝；B-10 可复现；E2E-01…E2E-11 建议与 EV 一致 / 披露自洽 / 位置来自真实行动顺序 / 20·40·100·200BB / 多人拒绝 / 时间预算 / 诊断区逐尺寸证据 / 模型版本可追溯）**；**PREFLOP 5BET MINIMUM RAISE 连续再加注合法性审计（16 项：最小 5Bet = 22 + (22−10) 且 legalActions 与 gameState 同口径 / 开池·3Bet·4Bet 逐段核对 lastRaiseSize·currentBet·minRaiseTo / 🔴 加注到 32BB 必须被拒 / 加注到最小额被接受 / 加注到 40BB 被接受 / 全下按预览按钮真实载荷提交且被识别 / 全下的 amountChips 口径（本街累计被拒、本次投入被接受）/ 尺寸网格不得含低于最小额的候选 / 决策候选逐个 ≥ 最小加注额 / 🔴 最终建议不得是 32BB 且必须落在网格内并可被实际执行入口接受 / 网格内每一项都真的能执行 / 动作记录 amount(增量) 与 toAmount(本街累计) 口径分离 / 需跟注额 = currentBet − 本街已投入 / 短码全下例外且不改写 lastRaiseSize / 由全下完成的完整加注照常更新 lastRaiseSize / 被拒绝的 32BB 无副作用）**；**SEAT SWAP 座位对调语义（12 项：玩家数/空位数/筹码总数三者逐位不变 / Button 不因换位而浮到别人手里 / 角色不重不漏 / 对调双向且筹码跟着座位走 / 🔴 6 人桌设为 UTG 后座位标签必须是「枪口位」而不是「大盲位」/ 9 人桌同样成立 / 满座逐位遍历「角色=座位名」/ 目标座位空着时沿用旧语义且不凭空造人 / 空座位分支筹码跟着 Hero 走 / 对调后冻结拓扑与预览同源 / 对调可被一次撤销完整退回）**；**PLAYER PROFILE TABLE UI V1 人物画像前端接入与浏览器验收（9 项：名册搜索 / 同名不合并与 duplicateName / 无机会 ⇒ null（不得显示 0%）/ 已接通统计如实显示为「成功 / 机会」/ 新建玩家新身份且不继承 / 选历史玩家入座按 playerId 绑定（换座位不丢）/ HTTP `/api/table/players` 名册与损坏历史显式报错 / 前端资源含选人弹窗与悬停画像且不遮挡 / 画像数字全部来自接口、无硬编码）**；**PLAYER PROFILE EXPLOIT V1 真实历史持久化与决策链路（15 项：A 行动落盘（§三 字段齐全）/ B 关闭重开可读且统计一致 / M 不同牌局不互相覆盖 / N 撤销不改动已完成牌局 / E 重复提交不重复计数 / F 撤销后统计正确更新并可修正 / C 重新上桌绑定真实历史并注入决策 / D 换人（含同名）不继承统计 / K 无接通项时宁缺勿假 / G 真实记录来源可追踪且统计项确有响应通道 / H 只改统计项输出按公式单调变化 / I 样本不足强收缩（2 手 ≪ 10 万手）/ J 界面如实披露实测手数与来源 / L 读取失败不得伪装成功 / O·P 街道状态与 RDC V1 契约不变）**；**RIVER DECISION CONSISTENCY 河牌全下 / 下注动作一致性（10 项：§1 下注额=全部剩余筹码 55BB ⇒ 语义必须等同全下（界面须写「全下」）/ §2 BET 与 ALL_IN 同金额 ⇒ 必须视为同一实际动作、不得报一致性错误 / §3 尺寸不同必须保留区分且 EV 分别计算 / §4 最高分尺寸为 ALL_IN 时最终输出必须一致 / §5 未打光筹码的下注不得被提升为全下（深筹码变体）/ §6 形态识别是纯标注（底池·有效筹码·再投入口径自洽）/ §7 校验按实际动作语义比较（含反证：真小于全下额仍须报错）/ §8 真分歧保留报错 + 等价动作消除误报 / §9 违规必须显著提示「不要据此行动」且保留调试信息 / §10 V2 街道状态契约不受影响）**；**STREET STATE CONSISTENCY V2 街道状态一致性（12 项：§A-1~A-4 不提前推进街道 / 录牌不结算、不补行动、不改投入 / 完成转牌行动才推进且不凭空发牌；§B-1~B-2 先录满 5 张再补全部行动仍可达河牌、Hero 本人历史行动可补录且不被当成 CHECK；§C-1~C-3 未完成转牌行动时预览必须 ready=false + 说明缺谁的行动、与管线口径一致、且不误伤正常转牌决策点；§E-1~E-3 预录第 5 张牌不进引擎状态、转牌计算对其逐位无关、未完成转牌行动时不存在合法河牌决策节点）**；**CB-5 河牌「打光筹码」容差带护栏（10 项：CB5-01/02 A–E 五个节点不变量与护栏自洽 / CB5-03 黄金向量不变 / CB5-04 强牌全下保留 / CB5-05 H·I·J 差=0·=带·>带边界 / CB5-06 K·L EV=null 不得当 0 / CB5-07 M·N 负 EV 与非全下加注 / CB5-08 O 翻前 3Bet·4Bet / CB5-09 P 翻牌·转牌（含转牌真全下 186）/ CB5-10 M9 候选与证据保全）**；**PREFLOP P0 · F2 全下保护街道适用范围（11 项：F2-1 A–D 合法全下不被翻后保护拦下 / F2-2 全下**真的**进入证据表 / F2-3 M7·M8 无 EV 如实标 null / F2-4 不得绕过既有证据纪律 / M1 弱牌中等牌仍不能全下 / M5-1 翻后一对牌保护仍生效 / M5-2 翻后强牌不受限 / M6 最小加注 > 全下额边界 / M9 3–25BB 扫描 / M10 阈值与底池比例档未动 / 街道矩阵穷举）**；**P1 CALL/FOLD 裁决标尺（11 项：A 原始 99 节点 / B 负 EV / C·D 带内外 / E·F null 与非法数 / H·J 跨画像 / I 同源回归 / K 跨动作优先级 / L 资金流 / M 确定性 / N 理由与界面）**；**TEST 18 RAISE-TO AMOUNT CONSISTENCY（12 项：A 合法全下 / B 本街已投入 0 / C+J 非法金额仍被拦 / D CALL 增量口径 / E BET / F 非全下 RAISE / G 资金守恒 / H 无再加注分支 / §六 用户可见金额 / §八 数值回归）**；**TEST 17 决策展示与假设披露定向测试（11 项：D-1 权益口径 / D-2 同源纪律 / D-3 界面分行与回落标注 / D-4 文案完整性 / D-5 未来街披露 / D-6 去重 / D-7 公式可复算 / D-8 验收数值）**；PLAYER PROFILE V3 · FACING BET CHANNEL M1 定向测试（35 项：§五 修复语义 A-1~A-4、§六 墨菲 M-1~M-10、附录 1–4）；PLAYER IDENTITY ROUTING V1 身份路由 A/B/C + M1–M10；PLAYER PROFILE QUANTIFICATION V1 黄金测试 03A/03B；NODE DETERMINISM AUDIT 确定性回归 D1–D5；**V2 统一似然 + 范围指标**；**V2 收口 REPORT VERDICT CONSISTENCY GATE**；**画像 A/B + 策略评分命名 + 权益语义审计**；**PLAYER PROFILE V3 连续统计**；**TEST 08 P0 定向审计（P0-1…P0-10）；**TEST 09 BET RANGE 定向审计（BR-1…BR-13）**；**PLAYER PROFILE V3 RESOLVER 定向修复（逐统计锚点 + 标签融合）**；**U1 加注 EV（U1-1…U1-8；P0 资金口径 P0-1…P0-9 / M1–M4 / GATE；P1-2a/P1-4 合法分支 A–H / I1–I4 / P1-4-1…3；**下注金额一致性 T1–T4**）**） |
| 类型检查 | 零错误 |
| 产物 hash 绑定 | **180 个产物 / 6 类** |，已接入 `npm run verify`（本节此前写 152，实际为 154；补登记后 155；U1 轮 157；**U1 P0 修复轮补登记 `src/app/manualInput/raiseResponse.ts` → 158**；**PLAYER IDENTITY ROUTING V1 补登记 `src/app/manualInput/playerIdentity.ts` → 159**；**PLAYER PROFILE V3 · FACING BET CHANNEL M1 补登记 `src/app/manualInput/facingBetProfile.ts` → 160**；**M1 自审补登记 `reports/M1_FACING_BET_CHANNEL_SELF_REVIEW.md` → 161**；**M1 修复轮补登记 `reports/M1_BAND_LAYER_LABEL_SCALING_FIX.md` → 162**；**P1 审计补登记 `reports/P1_99_CALL_FOLD_CONSISTENCY_AUDIT.md` → 163**；**SEAT SWAP 补登记 `test/seatSwap.test.ts` → 164**；**PREFLOP 5BET 审计补登记 `test/preflopFiveBetMinRaise.test.ts` → 165**；**PREFLOP RAISE DECISION 阶段 A/B 补登记 `src/app/manualInput/preflopRaiseResponse.ts`、`src/app/manualInput/preflopRaiseFacts.ts` → 167**，再补登记 `reports/PREFLOP_RAISE_DECISION_V1.md`、`reports/evidence/preflop-raise-sensitivity.txt` **→ 169**；其余展示轮只刷新既有产物哈希，未新增登记项，数字以生成器输出为准） |
| Git 状态（PLAYER PROFILE EXPLOIT V1 实施后） | ⚠️ **不是干净基线**：`HEAD = bc56191`（= **已提交**的 CB-5 护栏；尚未推送 —— `git ls-remote` 连续失败，本地领先 `origin/main` 1 个提交）；**V2 / RDC V1 / 本轮画像历史修复均未提交、未推送**（等人工确认）：已修改 `src/app/table/tablePreview.ts`、`src/app/table/tableAdapter.ts`、`src/app/table/tableOps.ts`、`src/app/table/tableApi.ts`、`src/app/table/seatLifecycle.ts`、`src/app/table/table.types.ts`、`src/app/manualInput/contextBuilder.ts`、`src/app/manualInput/manualInput.ts`、`src/app/alphaPipeline.ts`、`src/domain/decision/decisionConsistency.ts`、`src/domain/decision/decision.types.ts`、`src/app/decision/decisionEngine.ts`、`src/viewmodels/decisionViewModel.ts`、`CURRENT_PROJECT_STATUS.md`、`data/artifact-manifest.json`；**新增** `src/app/table/playerHistory.ts`；新增未跟踪测试与报告 `test/playerProfileExploitV1.test.ts`、`test/streetStateConsistencyV2.test.ts`、`test/riverBetAllInConsistency.test.ts`、`reports/PLAYER_PROFILE_EXPLOIT_VALIDATION_V1.md`、`reports/RIVER_DECISION_CONSISTENCY_V1.md`、`reports/STREET_STATE_CONSISTENCY_V2.md` 及全部审计探针（**一律保留**）。检查点：`%TEMP%\dezhou-checkpoint-f2ac-20260920-131436` |
| 外部求解器 | **GTOpen**（commit `92c86ed`）作为独立计算引擎接入，本地 3737 端口；能力与限制见 `reports/GTOPEN_MULTI_TABLE_AUDIT.md` |
| 独立红队轮次 | **15 轮**（范围 / 数值稳定性 / 画像 / 知识 / 动态行为自查 / 动态行为独立审计 / **Alpha 独立审计** / **牌桌录入 ×2** / **桌型语义独立审计** / **翻后形态扫描（Murphy）** / **河牌一致性（真人牌局反馈）** / **河牌一致性 V2.1** / **缓存键黄金向量** / **画像→范围主链（P0 架构修复）**） |
| 历史基线回归 | 535 → … → **1,677** → **1,690** → **1,691** → **1,704** → **1,712**，无一次放宽断言（三次契约变更均已在报告里逐条说明：TEST 6 升级为「权益按画像方向移动 + 去重可见」；下注决策模型 13 项验收；**T9 的「三桶组合数之和」在混频下改为「并集 = 可达集合 + 质量守恒」**—— 旧断言在混频下是错的） |
| 版本控制 | **git** 已建立（`main`，基线 tag `v0.1-baseline`）；`GTOopen/` 与 `node_modules/` 不纳入跟踪 |

### 10.0.1 GTO 集成的**边界**（本轮新增，必须与上面的数字一起读）

| 项 | 事实 |
|---|---|
| GTO 是不是 Alpha 的一部分 | **不是**。它是**独立进程**（GTOpen，本地 3737），Alpha 通过 `GtoProvider` 接口调用它 |
| GTOpen 不在时 Alpha 能不能用 | **能**。所有查询返回 `GTO_BASELINE_UNAVAILABLE`，Alpha 走原有链路，界面显式说明原因 |
| 翻前 GTO 数据的可信度 | **上限是「近似求解（APPROXIMATE）」**。GTOpen 的翻前用的是近似延续模型（源码自述），因此**永远**不会标成「已求解 / 已验证」 |
| Decision Engine 有没有用 GTO | **没有**。本轮只把数据读进来并显示，`decisionEngine.ts` 里连「gto」这个词都不出现（有测试强制） |
| 7 人桌 | **不支持**。只支持 4 / 5 / 6 / 8 / 9，且**不允许**用相近人数顶替（有测试强制） |
| 翻前 GTO 范围什么时候生效 | **缓存命中时**。冷启动第一次查询会**秒回启发式范围**并如实标注「GTO 正在后台计算」，求解完成后自动落盘，**之后同样的局面自动改用 GTO 范围**（实测约 10 秒后翻转） |
| 哪些翻前局面**算不了**（等也不会变） | ① 开池者**不是第一个行动位**（如 CO/BTN 开池）——`gtoScenario.ts` 有刻意的语义不变量：`RFI` 只允许第一个行动位且前序动作为空；② **开池尺寸不是 2.5BB**（求解配置只有 2.5BB，而 `RFI` 场景的 `openSizeBB` 不进缓存键，见 10.0.3）；③ 多次加注（3Bet 之后，生产配置 `max_raises = 2`）；④ 有跛入；⑤ 翻后。这些一律回落启发式并**逐家给出中文原因** |

### 10.0.3 🔴 已修 CRITICAL：开池尺寸不进 `RFI` 缓存键

**2026-09 独立审计发现并修复。** 这是本项目最严重的那类缺陷：**读到另一个牌局的策略**。

`RFI` 场景的前序动作**恒为空**（`defaultActionHistoryFor` 对 RFI 直接返回 `[]`，
它不把开池尺寸写进去），因此 `openSizeBB` **不参与** `scenarioHash` / `cacheKey`：

```text
开池 2BB   → scenarioHash=gb2c2da23  cacheKey=c91e7b60a
开池 2.5BB → scenarioHash=gb2c2da23  cacheKey=c91e7b60a
开池 3BB   → scenarioHash=gb2c2da23  cacheKey=c91e7b60a   ← 同一把键！
```

于是「对手开池 3BB」会读到为 2.5BB 算的那份策略**并照用**，界面上还标成
「求解器翻前范围」——数字看起来完全正常。

唯一能拦住它的是 `solveSettingsMatch`，而它**在生产路径上一个调用者都没有**
（只被 `lookupPreflopRangePrior` 调用，而前台已改成只读缓存、不再走那条路）。
**校验写了却没人用，等于没有校验。**

修复：在 `readOneOpponentRange` 的**第 0 步**（先于「后台在算吗」）加上这道闸，
对不上就返回 `NOT_APPLICABLE` + 准确中文原因；同时 `queueBackgroundSolverRanges`
在入队前也核对一次（算出来也用不上，白烧几十秒 CPU）。
回归测试 `BG-SOLVE-16/17/18/19`，已验证「禁用修复则测试变红」。

**为什么是加闸而不是改缓存键**：改键能治本，但会让**已落盘数据全体失效**
（键变了 ⇒ 现有缓存一条都对不上）。两者不冲突 —— 这道闸无论如何都该有，
因为**任何**键实现都可能哪天出偏差。

### 10.0.4 🔴 已修：四条德州扑克**规则**错误（2026-09 规则审计）

这一轮不是查代码 bug，是拿**真实德州扑克规则**逐条对引擎。四条确认并修复：

| # | 规则错误 | 后果 | 修复位置 |
|---|---|---|---|
| **R1** | **两对踢脚在三对共存时取错**：`Q Q T T 8 8 3` 被算成 `Q Q T T 3` | 穷举 `(2,2,2,1)` 型 7 张 **25% 编码错误**（占全部 C(52,7) 的 0.462%）；20 万次真实摊牌 **82 次判错胜负**、71 次本应平分 | `handEval.ts` / `fastEval.ts` 两对分支 |
| **R2** | **大盲的选择权在合法动作推导里消失**：`!canCheck` 把「能过牌」当成「不能加注」 | 全体溜入后 `deriveLegalActions(BB)` 只给 `["FOLD","CHECK"]`，而引擎接受加注 —— 界面**永不给大盲加注按钮** | `legalActions.ts` 加注分支 |
| **R3** | **短大盲把入池代价拉到大盲以下**：`currentBet = max(实际投入)` | 大盲只剩 30 时全场跟 30 就能看翻牌（半价入池）；最小加注也跟着变小 | `gameState.ts` `createGame` |
| **R4** | **短全下关闭了「尚未行动」玩家的加注权**：判据用了 `committed >= previousBet`，而**盲注也算已投入** | 大盲面对短码全下时被误关加注权（那恰是该权利最值钱的场合）；同局面未行动的 CO 却可加注，**代码自相矛盾** | `engine.ts` 短全下分支 |

#### R1 为什么能活这么久（比缺陷本身更值得记）

`handEval` 与 `fastEval` 是同一套规则的**两份实现**，它们之间的差分测试看起来很有力
—— 但两者**共享同一个错误**时差分恒为 0。实测 62 万+ 随机 7 张差异为 0。

它最终是被「**独立参考实现穷举**」找出来的。因此新增 `test/pokerRules.test.ts`：
刻意**不调用**项目的评估函数，自己穷举全部 5 张组合写一份最朴素的参考实现，再逐手对照。

#### 写这组测试时又踩到两个刻度坑（已写进测试注释）

1. **两套点数刻度**：独立实现用 `0..12`，项目的 `Card.rank` 用 `2..14`。
   顺序关系相同、**数值不同**，直接比对会全线失败。
2. **`HandCategory` 是 `1..9`** 而不是 `0..8`。硬编码类别数字会静默失效 ——
   测试里改用具名枚举。

#### 错误曾被**测试与文档一起固化**

- `test/equity.test.ts` 旧断言 `ranks = [12,10,3]`，注释还写下了错误论证
- `test/tableTopology.property.test.ts` §85 旧断言 `currentBet = 1200`
- `docs/ARCHITECTURE.md` B6 行写成「踢脚只从不在成对点数中的最高牌取」

三处都已改正并**写明为什么原来的说法是错的** —— 否则下一个人会照着旧注释再改回去。

### 10.0.2 Phase 1.3：前台与求解**分离**（本轮修复的核心缺陷）

Phase 1.2 把「给建议」和「算 GTO」写在同一条路径上，用 `SOLVER_PREFETCH_BUDGET_MS = 1500`
当预算。实测证明那个预算**不成立**：

| 场景 | 实测 |
|---|---|
| 预算 1500 ms，6 人桌冷启动 | **109 ms 就回落启发式**（连试都没试） |
| 预算 1500 ms，9 人桌冷启动 | **195 312 ms** |
| 直接问求解器（6 人桌冷） | 58 868 ms |

同一个参数既拦不住慢的、又挡住了快的；而且失败原因是**静默**的
（`gtoPrefetched.warnings` 算出来就被丢掉，界面只有一个「启发式」标签）。

现在分成两件事：**前台只读缓存**（`GtoSafeLookup.lookupCachedOnly`，未命中立刻返回 `null`）、
**后台补算**（`BackgroundSolveQueue`，走出 `lookupWithStats` 因而会落盘）。
实测结果：前台回答 79–245 ms、取数 0–7 ms，冷启动第一次也**不再被拖住**。

**实测的三步过程**（真求解器 `92c86ed`，6 人桌 UTG 开池 2.5BB、英雄 BB `AhKh`）：

| 步骤 | 实测 |
|---|---|
| 第一次查询（缓存空） | 245 ms 回答，`state=BACKGROUND_SOLVING`，明确说「GTO 正在后台计算（1 个场景）…之后同样的局面会自动改用 GTO 范围」 |
| 等待期间反复查询 | 每次 100–200 ms，**没有一次**被拖住；取数 0–1 ms |
| 约 10 秒后 | `state=SOLVER_RANGE`，`fromSolver=true`、可信度 0.55、迭代 40、BR gap 0.165260 |
| 杀掉求解器进程再查 | 仍然 `fromSolver=true`、取数 1 ms ⇒ 证明是**从磁盘读**，不是求解器内存 |

**复现方式**：`node --experimental-strip-types scripts/gto-phase13-probe.ts`
（`--cold` 前先清空 `data/gto-cache/` 并重启求解器）。

### 10.0.5 🔴 已补：边池与「会被争夺的量」（2026-09 边池轮）

第 10.0.4 节列出的已知缺口里，前三条（边池未建模、未被跟注的超额不退、干边池仍要求行动）
这一轮做完了。核心是新增 `src/domain/poker/pots.ts`：

| 概念 | 含义 | 修复前 |
|---|---|---|
| **可争夺量** `contested` | 主池 + 边池 | 不存在这个概念，只有总投入 |
| **退回** `returned` | 超出「第二高未弃牌投入」的部分 —— 无人能跟，退还本人 | 被当成底池的一部分 |
| **死钱** | 弃牌者投入的钱 —— 留在池里、计入可争夺量，但**不退给他** | 未区分 |
| **可赢上限** `maxWinFor` | 某玩家有资格的那些层之和 | 不存在（短筹码赢不了整池这件事看不见） |

#### 用户可见的影响（实测）

| 场景 | 旧口径所需权益 | 正确 | 后果 |
|---|---|---|---|
| 我 30BB 面对 100BB 全下 | **22.2%** | **47.9%** | 22% 与 48% 之间是大量本该弃掉的牌 |
| 我 100BB 面对 100BB 全下 | 49.4% | 49.5% | 对等时几乎不变（符合预期） |
| 我 100BB 面对 50BB 全下 | 48.8% | 48.9% | 同上 |

也就是说：**只有筹码不对等时口径才变**，对等时保持原值。

#### 干边池：不再为不存在的决策点给建议

其余人全部全下后，最后一名有筹码的玩家**不再被要求行动**（现实中这时直接跑牌到摊牌）。
修复前实测：`pendingQueue = ["btn"]`，`BET 500` 被接受 ——
而 `reconstructGameState(ANALYZE)` 会据此给出一个**现实中不存在**的决策点建议。

#### 我在这轮里写错的四处（都被自检或断言抓到，如实记下）

1. `contestedPot + callCost` 当可赢量 —— 把「我还没跟注」造成的**暂时性**未跟注
   当成永久的，量级错约 50 倍
2. `pot − 退回 + callCost` —— 反向错误：把「对手确实跟不起」的永久退回当成暂时的
3. `cap = Math.max(...levels)` 用了**最高**投入而不是**第二高** —— 分摊与退回全错
4. 把「超出 cap 一律退回」套到**弃牌者**身上 —— 守恒被破坏（凭空多退 400）

**教训**：这一轮我自己写错的次数比前几轮加起来还多，而**每一次都是自检或断言先发现的**。
`selfCheckLayeredPot` 现在在服务器启动时强制执行（失败即拒绝启动），
不变量 `主池 + 边池 + 退回 === 总投入` 对任意合法状态成立。

#### 多 Agent 对抗性审查（5 个视角并行，各自独立复现）

| 审查者 | 手段 | 结论 |
|---|---|---|
| 边池数学 | 独立实现 + 13,309 个可达状态随机差分 | **找到 2 个高severity 反例** → 已修 |
| 引擎回归 | 15,000 局随机对局 / 137,296 步 | 四处引擎改动**未误伤**；找到 **2 个 MAJOR**（都在 `createGame`）→ 已修 |
| 规则符合性 | 逐条对规则 + 独立实现 | 找到死钱归属、加注守卫、越界声称 → 已修 |
| 集成契约 | 全项目 grep + 真实 UI 路径 | 找到 **callEV 代数不自洽**（`equity×winnable−(1−equity)×c` 应为 `equity×winnable−c`）→ 已修 |
| 证伪者 | 33 场景手算 + 4000 手随机 | 找到退回口径与「只剩一人」不退回 → 已修 |

**三个审查者独立收敛到同一套正确口径**：

```text
有效投入_i = min(投入_i, 第二高投入)        ← 含弃牌者
contested  = Σ 有效投入
退回_i     = 投入_i − 有效投入_i
层界       = 有效投入去重升序；层额 = 档差 × 有效投入达档人数（含弃牌者）
maxWinFor  = 该玩家有资格的那些层之和
```

① 未跟注超额退回（含弃牌者参与判定）② 死钱进主池 ③ 只剩一人也要退 ④ 无人能跟时禁 BET **且禁 RAISE**
⑤ `callEV = equity × winnable − callCost`（`equity = requiredEquity` 时 EV 恰为 0，有 POT-12 锁）
⑥ `createGame` 与另两处建队点同源（消除幻影决策点与建局死局）。

#### 🔴 我这一轮写错的次数（比前几轮加起来还多，全部被自检/测试/审查抓到）

1. `contestedPot + callCost` 当可赢量 —— 量级错约 50 倍
2. `pot − 退回 + callCost` —— 反向错误
3. `cap` 用**最高**投入而不是第二高
4. 「超出 cap 一律退回」套到**弃牌者**身上 —— 凭空多退
5. 改了 `winnable` 口径却**没同步 EV 公式** —— EV 系统性虚高 `E×c`，令安全网失效
6. **层界用了未封顶值** —— 超额同时进层与退回，守恒被破坏（79% 状态）
7. 封顶后**同资格相邻层没合并** —— 凭空造出虚假边池

**教训**：这一轮唯一可靠的发现机制是**独立复现**。自检写错也会误报（我犯过两次），
因此自检现在同时断言**守恒**与**规则级**性质（退回公式、`contested` 公式、层额可乘回、可赢上限不超可争夺量）。

#### ✅ 已补：分层权益（多层权益轮 → 修正轮）

上表第一条（多人活边池的口径）**这一轮做完了**，并在对抗性审查后**修正了一次 CRITICAL 口径错误**。

**做法**：`contextBuilder.computeLayeredEquity()` **逐层算胜率** —— 每层只用**该层有资格的对手**：

```text
预览 = previewCommit(state, 我, 跟注额)      ← 🔴 与 winnable 同源：先假设投入，再分层
若 预览.singleThresholdApplies ⇒ 不做任何计算（0 ms，行为逐位不变）
EV = Σ_j (胜率_j × 层额_j) − 跟注额           （恒等式：Σ层额 ≡ winnable）
```

**实测成本**：

| 项 | 实测 |
|---|---|
| 门槛仍适用（单层 / 层界非结构性） | **0 ms**（直接返回） |
| 结构性多层 / 2–3 层 | **90–300 ms** |
| 极端（7 层 / 7 对手） | 约 1.1 s（受下面的预算保护约束） |

**关键数字**（`POT-14`：UTG 短码全下 10BB、BTN 全下 30BB、我 BB 需跟 29BB）：

| 层 | 层额 | 该层对手 | 胜率 |
|---|---|---|---|
| 主池 | 3050 | UTG + BTN | 72.0%（= 整池权益） |
| 边池 | 4000 | **仅 BTN** | **84.2%**（反解自实测 EV） |

⇒ 分层不是「更准一点」，是**真的不同**：主池要赢两个人，边池只要赢一个。

⚠️ 本文件此前在这里写过「层 0 胜率 0.6875 / 层 1 胜率 0.7945」。审查复核发现
那两个数字**复现不出来**，而且当时的实现根本产生不了层间差异（它取的是决策时刻的层，
两层对手集合相同）—— 已按实测数字替换。

#### 🔴 修正轮：对抗性审查抓到的 CRITICAL 口径错误（已修）

第一阶段的分层用**决策时刻**的底池分层（`computeLayeredPot(state)`），
而同一函数里的 `winnable` 用的是**跟注之后**的预览（`previewCommit`）——
**顺序反了**，正是 `pots.ts` 420-455 行自己写明「两层顺序不能反」的那一步。
代数后果（实测吻合到蒙特卡洛噪声）：

```text
实现值   = E × contested(决策时刻) − 跟注额
项目下界 = E × winnable           − 跟注额   ⇒ 实现值比自己的下界还小 E×(winnable−contested)
```

`POT-14` 形态里跟注额（2900）**大于**决策时刻的可争夺量（2150），
于是 EV **被算术强制为负**，与权益无关 ⇒ `MATH_FOLD_DOMINANT`（规范第 27 节禁止翻转）：

| 局面 | 错误口径（修复前） | 正确口径（修复后） |
|---|---|---|
| `POT-14` 我 A♥A♦ 需跟 2900 | **−1352 ⇒ 弃牌** | **+2664 ⇒ 跟注** |
| 同一形态我 72o | −2555 ⇒ 弃牌 | −1558 ⇒ 弃牌（↔ 方向恰好一致） |
| 转牌旗舰形态（`POT-D3`）AA | 不算（`layers ≤ 1` ⇒ 不给方向） | **+3861 ⇒ 跟注** |
| 红队 `F-06`：BB 拿 AA vs 开池 + 跟注 | 333.31 ⇒ **CALL**（错） | 479.16 ⇒ **RAISE**（对） |

同一轮还修了三处**契约**问题：

1. 判据标尺由 `EV ÷ pot` 改成 `EV ÷ winnable` —— `pot` 含永远不会被争夺的筹码，
   与单层的 `edge = callEV ÷ winnable` **不同量纲**却共用同一个 5% 阈值；
2. 取消「精确分层 EV > 0 ⇒ 直接返回跟注」的短路 —— 它**绕过 `shouldRaise`**，
   造成「EV 越明显越不能加注、EV 只是略正反而可以加注」的反向激励（实测 14 例）；
3. 分层只在 `previewCommit(...).singleThresholdApplies === false` 时产出
   （与 `requiredEquityApplies` **同一个来源**）—— 此前用「决策时刻层数 > 1」判定，
   于是「我投过盲注/跟注而对手在我上方」的**暂时性层**改写了单层局面（`F-06` 那手 AA 由 RAISE 变 CALL）。

**回归锁**（四条在旧代码下**逐条变红**，已实测）：

| 测试 | 锁什么 |
|---|---|
| `POT-D6` | 分层 EV **必须 ≥** 门槛口径下界 —— 口径写反必然违反 |
| `POT-D7` | 暂时性层不得改变单层判定（`F-06`：必须仍为 RAISE） |
| `POT-D8` | 门槛适用的局面不得出现「单层门槛」与「逐层」并存的矛盾文案 |
| `POT-D3` / `POT-D5` | 算得出来 ⇒ 给方向；**算不出来 ⇒ 仍不给方向**（闸门没被拆掉） |

**影响面实测**（18 个结构性多层局面 = 3 种筹码形态 × 6 类起手牌；三种口径各自会给出的动作）：

| 口径 | 判弃牌 | 判跟注/加注 | 不给方向 |
|---|---|---|---|
| **A** 修复前（分层取自**决策时刻**） | **17** | 1 | 0 |
| **B** 保守规则（根本不做分层，只看可证明的下界） | 0 | 6 | 12 |
| **C** 修复后（精确分层，本状态） | 10 | **8** | 0 |

- **5 个真翻转**：A 判弃牌而 C 判跟注/加注（`AA`/`KK`）—— 其中第一形态里
  「跟注额 2900 > 决策时刻可争夺量 2150」让 A 的 EV **被算术强制为负**，与权益无关；
- **12 个新增方向**：B 因下界为负而拒绝表态，C 算出来并给了方向（其中 10 个确实是弃牌）；
- **0 个违反 `C ≥ B`** —— 逐层胜率恒 ≥「赢下所有人」的胜率、且 `Σ层额 ≡ winnable`，
  因此该不等式是**定理**而不是巧合（`POT-D6` 把它锁成断言）。
- 形态 2（BTN 全下 20BB < 我 30BB）里 `AA` 由 CALL 变成 **RAISE** —— 这正是「取消短路、
  让 `shouldRaise` 重新参与」的效果（修复前精确 EV > 0 会直接返回跟注）。

#### 🔴 修正轮 · 第二份审查（独立视角）追加修的 latent 缺陷（A1）

审查者在**修复后**复检时发现另一处仍在的缺口：`computeLayeredEquity` 里先「过滤掉
没有范围的对手」、再看剩几个 —— 于是

| 事实 | 旧实现 | 正确 |
|---|---|---|
| 该层**确实只有我一人**有资格（无人能争） | 胜率 = 1 | 胜率 = 1 ✅ |
| 该层的对手**全都没有范围**（数据缺失） | 胜率 = **1**、`exact = true` ❌ | 判「算不准」（`null`） |

实测同一响应里能同时出现 `heroEquity = null`（算不出来）与
`layeredEV = {exact: true, value: 5050}`（必胜）—— **把「不知道」写成了「必胜」**。
判据的顺序已改为：先判「有资格者里除我之外是否为空」，再判「其中是否有人没有范围」。
`POT-D9` 锁住它（旧顺序下实测红：`actual {exact:true, value:5050}` vs `expected undefined`）。

审查同时指出：修复让 `exact` 的**后果幅度**从「底池量级」变成「可争夺量量级」，
跨过 ±5% 带更容易 ⇒ `exact` 的可信度比修复前更关键（因此这条值得单独修+锁）。

另外把预算预留从**固定 600 ms** 改成**按层数**（`300 + 150×层数`）：
实测 7 层最坏 1.03 s，固定 600 ms 会让「7 层但只剩 800 ms」的局面照样开跑、
跑完再整条失败 —— 预留就失去意义（审查 A3）。

#### 🔴 第三份独立核查：权益引擎的**静默错答**（已修）

起因只是我怀疑「转牌 7♣6♣ 对两家权益只有 2.24%」偏低。独立核查的结论是：
**2.24% 是对的，我的怀疑错了** —— 7♣6♣ + K♥9♠4♦2♣ 只有 **3 张梅花**，
只剩一张河牌，**根本没有同花听牌**（枚举 46 张河牌验证：成花 0 张）。
精确穷举 2.0933% 落在蒙特卡洛的置信区间内。

但同一次核查发现了**另一个真缺陷**，与本轮无关、也不是 2.24% 的原因：

| | 内容 |
|---|---|
| **症状** | 同一份输入会因「**选型**」不同给出不同答案：精确枚举路径**完全忽略** `opponentWeights` |
| **位置** | `equity.ts` 的 `enumerateExact({...})` 调用**没传** `perOpponentWeights`（它只传给了蒙特卡洛分支）；`equityExact.ts` 用 `equitySum / matchups` 均匀计权 |
| **触发** | 容量 ≤ `maxExactMatchups`（默认 50 万）即静默走精确枚举 —— **单挑 / 窄范围最容易命中**，而那正是后验权重最要紧的局面 |
| **实测** | 对手范围 `{A♣Q♦ 权 99, 8♦8♣ 权 1}`：不传权重 6.8182%、**权 99:1 也 6.8182%（错）**、**权 1:99 同样 6.8182%（错）**；加权真值 **13.5000%**（蒙特卡洛 13.6085%） |
| **危害** | `contextBuilder.computeHeroEquity` **永远**传权重 ⇒ 凡落在精确路径的局面，报出的权益都丢了范围后验，且**不报任何错**；而 `equitySource.method = 'EXACT'` 在界面上被显示为「精确枚举（N 局）」 |
| **修复** | `enumerateExact` 新增 `perOpponentWeights`（与组合逐位对齐，长度不符即抛错），分母改为**权重之和**；省略权重时 `weightSum === matchups` ⇒ 无权重路径**逐位不变** |
| **回归锁** | `test/equity.test.ts` 新增 6 条（含「精确 vs 蒙特卡洛必须给同一个答案」）；关闭修复后实测 **4 条变红** |

⚠️ 副作用：现有 1534 个测试**全部照旧通过** —— 也就是说这个错答此前**没有任何测试覆盖**
（这正是它能长期静默存在的原因）。

#### 🔴 GTO 页「有效筹码」是**死控件**（已修）

用户在 GTO 页问「能调有效筹码吗」时发现的：

| | 事实 |
|---|---|
| 界面 | 顶栏有可编辑的「有效筹码」输入框（默认 100BB） |
| 前端 | `gto.js` **从不读它**（全文件搜 `stackInput` 零命中），查询只发 `{ entryId }` |
| 后端 | `/api/gto/range/extended` 只读 `entryId`；扩展目录与 `queryGtoExtendedEntry` **硬编码 100BB** |
| 后果 | 用户填 50BB、点读取，拿到的是 **100BB 的策略**，界面上**没有任何线索** |

而能力其实一直存在（**基础**端点支持 `effectiveStackBB`），实测差别很大：

| 有效筹码 | scenarioHash | 缓存键 | AA 加注频率（6 人桌 UTG 开池） |
|---|---|---|---|
| 100BB | `gb2c2da23` | `c91e7b60a` | 93.36% |
| 50BB | `gca129957` | `c6a73285a` | **97.39%** |
| 40BB | `gf41a440e` | `c50f1d8ac` | **86.45%** |
| 200BB | `gd995f472` | `c0b705399` | **75.11%** |

⚠️ 根因：Phase 1.1 把界面从「按字段查询」迁到「按目录条目查询」时，**把筹码字段一起丢掉了**
（条目 id 与 `labelZh` 都不含筹码）。

**修复**：筹码作为一级场景参数贯通整条链 ——
`gto.js` 读输入并随目录与查询发送 → 服务器解析查询串/请求体 → `gtoExtendedCatalog(…, effectiveStackBB)`
与 `queryGtoExtendedEntry(entryId, effectiveStackBB)` 用它重建场景。四条纪律：

1. **缺省仍是 100BB**（老调用方逐位不变）；
2. 非法值（0 / 负数 / NaN / >1000BB）**明确报错**，绝不静默退回 100BB 冒充这次查询；
3. 场景标签必须带筹码（`6 人桌 / 50BB · BB vs BTN 开池`）—— 否则用户分不清屏幕上是哪个筹码的数据；
4. **改筹码立刻作废屏幕上的旧结果**并提示重新读取（否则 100BB 的 13×13 会顶栏写着 50BB 留在屏幕上）。

**回归锁**：`GTO-UI-22`（目录按筹码生成 + 非法值拒绝，旧代码下实测红）、
`GTO-UI-23`（断言**发往求解器的请求体**必须带各自的 `"stack":50/100` —— 旧代码下红，
且失败形态正是「50BB 查询复用了 100BB 的结果、根本没发新请求」）、
`GTO-UI-24`（前端静态锁：必须引用 `stackInput`、发送 `effectiveStackBB`、改筹码清屏）。

**顺带确认的牌桌页口径**（不是缺陷，但用户容易迷惑）：
「有效筹码」在第 10 节的牌桌录入页**不是输入项**，而是派生值（我与对手中较小者）；
改它要**点座位** → 弹窗里的「编辑筹码（仅在本手未开始时可用）」。

#### 🔴 牌桌页 Hero 改不了筹码（已修）

使用者反馈「HERO 还是无法修改筹码数量」。根因是座位菜单里的一段**提前 return**：

```js
if (seat.isHero) {
  modal.appendChild(el('div', 'note', 'Hero 的座位不能清空或更换玩家…'));
  return;                    // ← 本意只是隐藏「清空座位 / 更换玩家」
}
// ---- 筹码 ----              ← 筹码编辑写在 return 之后 ⇒ Hero 永远拿不到
```

实测（真实执行 `table.js` 的 DOM harness）：修复前 Hero 的座位菜单里只有
「未知 / 未知 / 关闭」三个按钮，**没有筹码输入框、没有保存按钮**。

**修复**：把筹码编辑抽成 `appendStackEditor(modal, seat)` 并在那个 `return` **之前**调用
（顺序写进注释，避免以后又被挪回去），同时按使用者要求补上**常用筹码预设
100 / 150 / 200BB**（一键设置）+ 手动输入。

**门禁**：本手进行中 → 控件**禁用并写明原因**（而不是点了才被后端拒），
与后端 `SET_STACK` 的 `HAND_ACTIVE` 规则同源。

**⚠️ 顺带被已有红队测试抓到我自己的一个错**：我最初把回调写成 `.then(closeModal)`，
而 `RT-L2` 明确禁止座位菜单直接 `closeModal` —— 一旦后端回传 `leaveDecision`，
刚打开的离桌选择会被立刻关掉。已改用 `closeUnlessPending`（原代码靠换行恰好躲过了
那条正则，我改成单行后立刻被抓 —— 这条测试是有价值的）。

**回归锁**：`test/tableSeatStack.test.ts` 五条（真实执行 `table.js`，不是静态 grep）：
Hero 菜单必须有筹码编辑、三个预设都可用且**真的写进服务端状态**、手动输入可用、
对手座位同样有、本手进行中必须禁用。把顺序改回修复前 → **4 条变红**
（第 4 条「对手座位」仍绿，正好证明变异只打中 Hero 那一支）。

#### ✅ 新功能：一键加入玩家（2026-09）

牌桌页顶栏新增「**一键加入玩家（+N）**」，与既有的「清空其他玩家」并列。
它解决的是「9 人桌要点 8 次空位」的重复劳动。

**语义**：在**每一个空位**各加入一名新玩家（按座位顺序），但只算**一次操作**：

| 项 | 一键 | 逐个点 N 次 |
|---|---|---|
| `revision` | **+1** | +N |
| 撤销栈 | **1 条** | N 条 |
| 撤销一次 | 整张桌子回到补齐前 | 只退掉最后一个人 |

**关键设计**：新玩家的形状由 `seatLifecycle` 的**同一处**定义
（`freshPlayer` / `seatWithNewPlayer`）—— 逐个与一键共用，
杜绝「一键加进来的是 150BB、逐个加进来的是 100BB」这类分叉。
门禁也与 `addPlayer` 完全一致：本手进行中拒绝、没有空位明确拒绝（不是静默成功）。

**测试**（都验证过变异变红）：

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `test/fillEmptySeats.test.ts` | 11 | 与逐个 `ADD_PLAYER` **逐字段等价**、不动 Hero、不抢占已占座位、9 人桌、**1 次 revision / 1 条撤销**、撤销一次整桌复原、门禁两条、notice、幂等 |
| `test/fillSeatsUi.test.ts` | 7 | 真实执行 `table.js`：点得到、点一次填满、**只发 1 个请求**、满桌/本手进行中禁用并写明原因、与「清空其他玩家」可来回组合、补齐后自动分析仍工作、**旧结论必须作废** |

**⚠️ 影响面检查抓到的两处**（这正是「检查有无影响其他功能」的价值）：

1. `test/interactiveTableRedteam2.test.ts` 的 **F-01（CRITICAL）** 变红 ——
   那个极简 DOM 桩的 id 清单是 `tableJsHarness` 之外的**第二份拷贝**，
   少了新按钮 → `renderTopbar` 抛错 → 「渲染跑不到底」。已补齐两处清单。
2. harness 的 id 清单同样少一个 id（`$()` 返回 null → `onclick` 赋值抛错）。

两处都是**测试桩的清单不完整**，不是产品代码错 —— 但它证明了那条 CRITICAL
测试确实在守着「渲染函数必须跑到底」。

#### 🔴 已修：挪动 Hero 位置后，牌桌角色错乱（使用者报告）

使用者原话：「我选择我的位置后，点击筹码，确认筹码后，位置会变」。
**筹码是无辜的**（`SET_STACK` 一个字节都不碰 heroPosition，已用探针逐步验过）；
真正的原因在**选位置**那一步：

`buttonSeatId`（哪个座位是庄家）原先**没有任何东西保证那个座位还有人**。
把 Hero 从 BTN 挪到 CO 会腾空旧座位 —— 而它正是 Button 座位。下游
（`freezeTopology` / 预览）在「Button 不在参与者里」时**静默回落到 `positions[0]`**
（环上第一个参与者），于是使用者看到：

```text
Hero 从 BTN 挪到 CO 之后（修复前实测）：
  玩家2（UTG 座位） → 庄家位          ← 凭空捏造的庄家（回落到第一个参与者）
  我（Hero，CO）    → 大盲位           ← 与顶栏「Hero 在 CO」自相矛盾
```

⚠️ 我一开始把它描述成「两个座位同时显示庄家位」是**错的**：空座位上那个
「庄家位（BTN）· 本手不参与」是它的**物理位置名**（`seat.positionZh`），不是角色。
真正的症状是**角色被算错**，已按实测改写。

**修法（以及为什么不是另一种）**：先在写状态时立刻把 Button 挪走 ——
`test/tableTopology.test.ts` 的 **§4b 立刻变红**：`NEXT_HAND` 会**二次轮转**，
中间那位玩家永远拿不到 Button，盲注归属全错。因此最终**只改怎么读**：
状态里的 `buttonSeatId` 语义不变（轮转仍从它出发），显示与本手拓扑统一走
`effectiveButtonSeatId`（= 从它顺时针找到的第一个合格座位，**也就是 `NEXT_HAND`
将要轮到的那一个**）。两处同源，永远不会分歧。

**回归锁** `test/buttonSeatInvariant.test.ts`（5 条，旧规则下 **3 条变红**）：

| 测试 | 锁什么 |
|---|---|
| `BTN-01` | 庄家位必须落在有效 Button 座位上，**不得**落到 `positions[0]`（判别性断言） |
| `BTN-02` | Hero 的角色不得被回落规则顶成「大盲位」 |
| `BTN-03` | 预览（读路径）与开手冻结（写路径）必须给出**同一套角色** |
| `BTN-04` | 清空拿着 Button 的座位**不得**改动 `buttonSeatId`（防二次轮转，§4b 的教训） |
| `BTN-05` | 换桌型裁掉 Button 座位 ⇒ 不崩，有效 Button 仍落在有人座位上 |
另有两个可用性缺口**未修**：① 没有改「默认筹码」的入口（新玩家固定 100BB）；
② 点「新建牌桌」会把所有座位筹码重置回默认 100BB（包括 Hero），让人以为「改了没用」。

#### 预算保护（本轮补）

硬超时原先只在 `buildDecisionContext` **返回之后**检查，分层无条件跑完 ——
实测 `hardMs = 300` 时，新增的 100–300 ms 会把**本来能算完**的分析整条变成 `DEADLINE` 失败。
现在剩余时间不足 `LAYERED_BUDGET_RESERVE_MS = 600` 时跳过这项**可选**增强：

| 局面 | 默认预算 | `hardMs = 300` |
|---|---|---|
| 转牌 AA | CALL（+3860.97 精确分层） | CALL（+3319.58 可证明下界）← 方向一致 |
| 转牌 76s | FOLD（−1407.29 精确分层） | **不给方向**（`action = null`）← 更保守 |

即：跳过只可能让结论**更保守**，不可能给出错误方向（它要么与原结论同向，要么拒绝表态）。

#### 剩下的限制

| 限制 | 影响 | 为什么没修 |
|---|---|---|
| 退回不落账本 | `computePot` 仍含未被跟注部分 ⇒ 界面「当前底池」与 SPR 偏大 | 「退回时机」需要状态机支持（下注轮一结束即退回） |
| rake 未建模 | 真实牌局抽水会改变各层金额与门槛 | 一直如此，非本轮引入 |
| `deadMoney` 目前无消费者 | 界面只用 `layers`/`contested`/`returned` | 保留字段供显示「可赢上限」用 |
| `requiredEquity` / `potOdds` / `edge` 仍是**下界口径** | 多层下它们与 `callEV`（精确分层值）不是同一个数 | 数值被多处指纹/断言依赖；**判方向已改用精确分层 EV ÷ `winnable`**，因此不影响建议，只影响显示 |
| 逐层权益是**蒙特卡洛估计**（每层独立抽样） | 带抽样噪声（约 1 个百分点量级） | 与单层同源的处理：判方向用 ±`MARGINAL_EV_GAP_RATIO`（5%）带，不做「EV < 0 即硬判」 |
| 「跟注后是否只剩一层」按**当前已投入**判定 | 对手若再加注，层界会再变 | 属于「对手未来动作」建模，超出当前范围；决策时只用**已发生**的事实（规范 M16） |
| `exact = false` 时 `callEV` 与 `layeredEV.value` 是**两个不同的下界** | 同一响应里能看到两个「跟注 EV」（都不用于判方向） | 两者都是真值的下界、口径不同；取较大者更紧，但那会让指纹/断言大面积变动 |
| `layeredEV.exact` 只表示「每层都有范围」，**不表示计算方式** | 逐层可能一层精确枚举、一层蒙特卡洛 | 诊断区未逐层暴露方法；属于显示粒度为题 |
| 分层计算一旦开跑**不可中断** | 预留按层数算（`300 + 150×层数` ms），实测最坏 7 层 1.03 s < 预留 1.35 s | 不中断是**故意的**：中途按时间放弃会变成「算得多准由时间决定」，违反确定性纪律 |
| 🔴 **蒙特卡洛顺序抽样是系统性偏差**（审查 BUG B，未修） | 联合分布为 `w1·w2/N(c1)` 而非对称的 `w1·w2`：2.1% 量级的权益上偏 **+0.036pp**（相对 +1.7%），**不随迭代数消失** | 正解（每家独立抽、整批冲突整批重抽）会改变所有现有 MC 数值与黄金局面；本轮只记录不修改（已在 `equityMonteCarlo.ts` 抽样点写明） |

### 10.0.6 🔴 翻后升级 · P0：三个 CRITICAL 基础缺陷（2026-09，已修）

翻后升级前先做了**只读审计**（三份独立审计 + 我自己的实测探针）。审计结论指出：
翻后决策层缺相对牌力 / Board Delta / 范围压缩 / 价值守门器 / 多人惩罚 / SPR 承诺，
而**更底层**还有三个必须先修的东西 —— 否则上层逻辑建立在错范围上。

| 缺陷 | 修复前实测 | 修复 |
|---|---|---|
| **C1** 跛入池：翻后的下注被当成翻前开池 | BB 在翻牌下注 ⇒ `rfiWeightsByHandedness('BB')` **抛错** ⇒ 整条 `CONTEXT_BUILD_FAILED`；CO 下注 ⇒ 静默套上「CO 开池范围」（1081 组合 = 全部牌型的 **81.5%**） | `firstAggressionOf` → **`firstPreflopActionOf`**：只看 `street === PREFLOP`，`raiseOrdinal` 只数翻前加注 |
| **C2** 跟注与过牌在似然上完全同义 | 「翻/转都跟注」与「翻/转都过牌」范围**逐位相同**（熵 8.938576941805767 两边一模一样）；河牌顶级牌质量 7.5% vs 翻前先验 8.1% | 新增 `CALL_WEIGHTS`（空气 0.5 vs 过牌 1.0、中档 2.6 vs 1.5）+ 按跟注额调制的 `likelihoodWeights('CALL', ratio)` |
| **C3** 范围完全不随牌面变化 | 同花完成面上 38 个同花类 `p(♣♣)/p(其它花色)` 精确 = **1.000000000**；♣♣ 质量 5.64% 反而低于不可能有同花的板（7.08%） | 新增 `src/domain/poker/boardRelativeStrength.ts`（复用既有 `describeHand` 的**结构化形态**，不重复实现牌力判定）；范围更新改用**该行动当时的牌面**（翻牌 3 / 转牌 4 / 河牌 5 张前缀）逐组合选档 |

**实测效果**（同一手、同一行动，只换转牌 T♣ / T♥）：
我方权益 **19.23% → 23.39%**（同花完成使对手继续范围更强）；
范围随进攻逐街收窄（熵 9.06 → 8.68 → 7.95）。

**改造前后对比**（6 个回归场景，同一探针）：

| 场景 | 改造前 | 改造后 |
|---|---|---|
| TEST 1 跛入池 | ❌ **崩溃** | ✅ CHECK（权益 49.0%） |
| TEST 2 KQ，对手连跟两街 | CHECK，权益 **50.6%** | CHECK，权益 **15.0%** |
| TEST 3 TT 三人池转牌 A | FOLD，权益 4.5% | FOLD，权益 2.8% |
| TEST 4 AA 4bet 池 SPR 0.38 | CALL，权益 76.6% | CALL，权益 **37.7%**（SPR 承诺仍缺失 ⇒ P2） |
| TEST 5/6 画像对照 | 两组完全相同 | **仍完全相同** ⇒ exploit 层缺失（P2） |

**回归锁** `test/postflopRangeFoundation.test.ts`（8 条，逐条做过变异验证）：

| 测试 | 变异后 |
|---|---|
| `C1-A` 跛入池必须能分析 | ✅ 变红（退回旧顺序即 `CONTEXT_BUILD_FAILED`） |
| `C1-B` 跛入者范围必须比开池范围宽 | — |
| `C2-1` 跟注两街 ≠ 过牌两街 | ✅ 变红（且复现**逐位相同**的熵） |
| `C2-2` 跟注压缩随注额单调 | — |
| `C3-1` 🔴 同点数只差花色在完成同花面上必须不同档 | — |
| `C3-2` 形态→档位映射 + 翻前返回 null | — |
| `C3-3` 更新路径接线锁 | — |
| `C2-3` 三种动作权重互不相同且保序 | ✅ 变红 |

⚠️ **`C3-1` 我第一版写错并当场被变异测试抓住**：原来断言「权益随牌面变化」——
那条**不判别**（权益本来就随牌面变化，把范围模型退回不看牌面后它**仍然通过**）。
现在改成「同点数、只差花色的两手牌牌面档位必须不同」，这才是 C3 的判别性性质。
这条教训与项目既往的「自检也会写错」同一类：**判据必须针对要修的那个机制**。

### 10.0.7 🔴 翻后升级 · P1：新决策模块（2026-09，已建并单测）

在 P0 修好的范围地基上新建 `src/domain/postflop/`（**纯函数、无副作用、可单测**）：

| 模块 | 作用 | 关键纪律 |
|---|---|---|
| `types.ts` | 共享类型：`RelativeHandRole`（10 类，含中文标签）、`OpponentRangeFacts`、`DrawProfile`、`PostflopInputs` | 拿不到的信息给 `null`，**不返回编造的 0** |
| `relativeHandRole.ts` | 相对牌力角色 + 跨街迁移原因（中文） | 形状来自既有 `describeHand`；阈值是权益分档（0.85/0.70/0.58/0.45）+ 多人偏移 |
| `boardDelta.ts` | `BoardDelta` 12 字段（数值而非布尔） | **只输出分数，不判断动作**；对手范围改善需真实范围事实，否则 `null` |
| `draws.ts` | 听牌剖面（同花听/两头顺/卡顺 + 补牌数） | 补牌数**只用于排序**，不是胜率 |
| `rangeCompression.ts` | `RangeCompressionState`（7 字段）+ `compressionFactor = f(尺寸, 街, 人数, 画像, 纹理)` | 压缩因子方向：尺寸↑/街靠后/人少/紧手/干面 ⇒ 压缩更强 |
| `multiway.ts` | 强度/诈唬/价值门槛惩罚（单调、有界） | 诈唬惩罚比价值惩罚更陡（弃牌率连乘下降）；**不搞「人多就过牌」** |
| `commitment.ts` | SPR 分档 + `stackOffAllowed` + 尺寸上限 | 低 SPR 允许一对级承诺（TEST 4 的机制）；SPR 不可算时如实返回 |
| `valueBetGate.ts` | 五问 + `ValueBetAssessment` + `verdict` | 核心 +EV 规则**只调分数**（摊牌价值高 + 更差牌跟得少 + 更好牌继续多 ⇒ bet ↓ / check ↑） |
| `blockers.ts` | 阻断价值/阻断诈唬/未阻断诈唬 + 净修正 | **禁止 `A♣ = 自动跟注`**；修正有 ±0.12 上限 |
| `sizing.ts` | 独立的尺寸选择（第二步） | **禁止「BET → 默认 50%」**；永远给出解释（中性情形也要说明） |
| `evScore.ts` | 动作评分、`rankActions`、`preferenceZh`、置信度 | 置信度 = **首选比次选好多少**（与牌力无关）；附 `NOT_SOLVER_EV` 免责说明 |
| `exploit.ts` | 定性画像 → **受约束**偏移（±0.12 上限 + 可信度上限 0.35） | 两层分离：画像只做偏移，**永不覆盖硬数学**；「追听牌 ≠ 听牌没成就诈唬」 |

**测试** `test/postflopModules.test.ts`（26 条，只断言**结构与方向**，不锁数值）：

- 角色相对性：同一个「一对」在不同权益下必须是不同角色；转牌高张必须降级（TEST 2 机制）
- 听牌在有无主动权时分别是「半诈唬 / 听牌」
- Board Delta：跨街比较的「同花成为可能」语义（含**反例**：上一街已可能时不重复声称）
- 压缩因子的四个方向 + 画像修正 + 状态量
- 多人惩罚单调有界、1 家为 0、诈唬惩罚更陡
- SPR：0.38 允许一对承诺、20 不允许、上限收紧、不可算时如实返回
- 价值守门器：五问齐全、**陷阱条件让过牌分数反超**、跟注站提高薄价值、保护收益与价值分开
- 阻断牌：同花面持该花色算阻断价值、干面持 A 算阻断诈唬、修正有上限
- 尺寸：坚果优势/薄价值/SPR/人数四个方向 + 永远落在合法网格 + **永远有解释**
- 置信度只看分差；偏好文案稳定
- Exploit：未知画像零偏移、跟注站薄价值↑诈唬↓、不诈唬型面对大额进攻抓诈唬↓、疯子↑、全部偏移受上限约束、**「追听牌」不推出「必然诈唬」**

⚠️ **本轮我自己的模块被测试抓到两个真实缺陷**（已修，均记入模块注释）：
1. 顶对权益 42% 时被判成 `AIR` —— 一手顶对过牌到摊牌能赢不少底池，`AIR` 的含义是
   「什么都赢不了」。已改为：无人下注时**任何一对至少有摊牌价值**。
2. `roleChangeReasonZh` 直接输出枚举原文（`MEDIUM_VALUE`），违反「对外文案全中文」纪律 ——
   已改用 `RELATIVE_ROLE_ZH`。

### 10.0.8 🔴 翻后升级 · P2：接入决策链（2026-09，六个回归用例已通过）

**新增 `src/app/decision/postflopAdvisor.ts`**：把 P1 的十二个模块按使用者给定的
**13 步顺序**组装成一条可解释建议（角色 → 牌面变化 → 范围压缩 → 多人 → 价值守门器 →
阻断牌 → SPR 承诺 → 画像 → EV 分数 → 尺寸 → 置信度）。它**不做动作决定**，
只产出分数与理由；动作仍由既有 EV 判据产生。

**新增 `src/app/manualInput/rangeFacts.ts`**：把「对手范围」与「当前牌面」结合成
`OpponentRangeFacts`（强牌占比 / 平均档位 / 花色适配 / 听牌密度）——
这份数据只有范围层能算，因此经 `DecisionContext.postflopFacts` 上送。

**画像通道修复**：`PlayerSnapshot` 新增 `quickProfile`。修复前用户手选的画像
**根本没有传到决策层**（只影响 `confidence` 与 `note`），这是「跟注站 vs 极紧给出
逐位相同建议」的直接原因之一。

**决策引擎三处改动**（都保留翻前路径逐位不变）：

| 改动 | 修复前 | 修复后 |
|---|---|---|
| 下注资格（无人下注） | `equity > 0.55 && tier ≠ WEAK` | `valueBetGate` 五问判决（`CLEAR_VALUE`/`THIN_VALUE`/`MARGINAL` 且下注分>过牌分） |
| 下注尺寸 | `tier` 决定（0.75/0.6/0.45 底池） | `sizing.ts` 独立选择（坚果优势/价值厚度/湿度/人数/弹性/SPR/画像） |
| 加注资格 | `MONSTER`/`STRONG` 档才有资格 | 增加**低 SPR 承诺例外**：牌力够强，**或全下的直接底池赔率成立**（`权益 ≥ R/(P+c+R)`） |

**六个回归用例**（`test/postflopRegressionCases.test.ts`，全部通过）：

| 用例 | 结果 |
|---|---|
| TEST 1 河牌同花面一对 J | 角色 `THIN_VALUE`，`flushCompleted=true`，过牌分 > 下注分，动作 **CHECK**，理由点明「同花成为可能」 |
| TEST 2 对手连跟两街的 KQ | 权益 < 50%，角色降级为摊牌价值，理由含「**不因此恢复牌力**」，动作 **CHECK** |
| TEST 3 三人池 TT 转牌 A | 多人惩罚生效（诈唬惩罚 > 强度惩罚），FOLD 为最高分且 `MATH_FOLD_DOMINANT` |
| **TEST 4 低 SPR 的 AA** | `stackOffAllowed=true`，动作由 CALL 变为 **RAISE 134BB（全下）** —— 修复前一对牌**永远不能加注** |
| **TEST 5 跟注站** | 薄价值下注分 > 过牌分，动作 **BET**；紧跟手对照的下注分与**尺寸**都更低（修复前两者逐位相同） |
| **TEST 6 过度诈唬** | 抓诈唬跟注分显著高于不诈唬对照；偏移受 ±0.12 上限约束 |

**⚠️ 本轮被测试抓到的两个我自己的设计缺陷**（已修）：
1. **守门器把薄价值全 check 掉了**：第一版给摊牌价值 0.55 权重、对「更差牌会跟」
   只扣 0.1 ⇒ 跟注站局面下薄价值顶对被判过牌（bet 0.091 vs check 0.228）——
   正是使用者点名要防的情形。重标定后（摊牌 0.35 + 与跟注意愿成正比的惩罚）方向恢复正确。
2. **低 SPR 承诺例外只认牌力**：AA 在该局面被判成抓诈牌（强度 0.38）而拿不到承诺，
   于是又回到「跟 60BB、身后剩 14BB」。改为**全下底池赔率**判据后正确全下。

**回归面**：改动 `decisionEngine` 后全量 **1,612 项**里只有产物哈希需要重算 ——
25 个黄金局面、红队用例、双入口逐字段一致性**零行为回归**。

### 10.0.9 翻后升级 · P3：输出与界面（2026-09）

**内部完整数据**：`DecisionDiagnostics.postflop`（新类型 `PostflopDecisionSnapshot`）——
角色 / 角色迁移原因 / 牌面变化（数值）/ 范围压缩 / 价值评估 / 摊牌·保护·诈唬潜力 /
SPR 承诺 / 阻断牌 / 画像偏移 / **动作偏好顺序（启发式比较分）** / 置信度 / 口径说明。
翻前为 `undefined`（防止把翻后口径误用到翻前）。

**界面只显示五项**（使用者第二十三节）：推荐动作、推荐尺度、主要原因、风险、置信度。
诊断区新增 12 行（`decisionViewModel.ts`），标签为中文，且**显式标注
「启发式比较分不是 solver EV」**。

**置信度语义**：`postflop.confidence` 是「**首选比次选好多少**」（只由前两名分数差决定），
与既有的 `AlphaDecision.confidence`（由输入完整度/范围可信度等取最小值）**分开存放**——
后者会激活 `CLEAR ⇒ confidence ≥ 0.45` 那条休眠断言，因此不混用。

**面对下注也必须给角色**：新增 `POSTFLOP_ROLE` / `BOARD_DELTA` / `SPR_COMMITMENT`
三个理由码（此前这些信息只在「无人下注」一侧出现，使用者面对下注时看不到
「我这是什么角色」「这张牌改变了什么」）。

**测试** `test/postflopOutput.test.ts`（5 条）：快照完整性 + 翻前不出现该字段、
口径声明必须含「启发式/不是 solver EV」、置信度只由分差决定、
界面至少有 8 行且含关键标签、面对下注时三个理由码必须出现。

### 10.0.10 对抗性审计（P5，已完成）：两轮共修 10 项

按使用者第十九节派出对抗性 Agent。**Agent A（GTO 基线）+ Agent B/C（Exploit·EV）+
Agent E（Murphy，形态扫描 9 类）全部回收。** 审计确认的核心事实：

- ✅ **没有「牌面写死」**：`flushCompleted` / `straightCompleted` / `pairedBoard` 等
  只进理由文案与诊断快照，**没有任何 `if (同花完成) then check` 类动作分支**
- ✅ **没有偷偷收紧弃牌**：面对下注的跟/弃仍只有 `MATH_FOLD_DOMINANT` + 既有 ±5% 带
- ✅ **硬判不可被画像覆盖**：三画像在明显负期望局面全部 FOLD + `MATH_FOLD_DOMINANT`
- ✅ **没有伪精确 EV**：全项目未发现把启发式分数输出成货币 EV 的位置
- ✅ **多人惩罚单调**：`multiwayAdjustment` 在 k=0..9 全部单调非减，无跳变
- ✅ **干面不过度保护**：`wet ≤ 0.17` 时 `protectionBenefit` 恒为 0
- ✅ **小样本画像不放大**：≤30 手 ⇒ 可信度 0 ⇒ 偏移逐位为 0；主观画像被 0.35 上限夹住

#### 第一轮：6 项（每条都有审计给出的实测反例）

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | `sizing.ts` 的 `SPR≤3 ⇒ ratio≥1` 是**悬崖**：SPR 3.0 给 1.0、SPR 3.1 给 0.20（3% 深度变化 ⇒ 4 倍尺寸跳变） | 改为连续函数（SPR 1→1.4、2→0.9、3→0.4、>3.8→0），并加回归锁 |
| 2 | `SIZING_GRID` 含 1.25/1.5/2，而下注网格只有 ≤1 ⇒ 选中 >1 时引擎退化为「最大合法下注」，界面与实际不一致 | 网格与 `buildSizeGrid` 对齐（只留真实存在的档） |
| 3 | 我自造的**全下赔率公式** `R/(P+c+R)` 漏项，偏差在 `R≈c/3` 变号（实测：`P=100,c=100,R=100,E=35%` 放行了真实 EV −25 的全下；`P=500,c=200,R=800,E=50%` 拦住了 +250 的全下） | **删除自造公式**，改用已有的 `edge` + SPR 分档（都是被测试锁住的口径） |
| 4 | `relativeHandRole` 的坚果/强价值**只看形状不看权益** ⇒ 任意葫芦=强度 1.0、单色面底三条 22% 权益=强价值 0.82 | 形状给上限、**权益给确认**；权益不足时降级 |
| 5 | `valueBetGate` 把 0.5 当权益基线，而权益是**多人口径**（4 人池真实 40% 优势被判成弱） | 基线改为 `1/(人数+1)` |
| 6 | 🔴 **界面文案与行为相反**：画像经 `profileCompressionMultiplier` **未按可信度缩放** ⇒ 可信度 0 时画像仍改动作，而同屏打印「剥削偏移被缩放到 0（不做任何画像调整）」 | 压缩乘数按可信度线性缩放（可信度 0 ⇒ 恒为 1）；主观画像的可信度再被 `EXPLOIT_CONFIDENCE_CAP` 夹一次 |

另修一处审计发现的语义缺陷：**置信度按「动作族」比较**（第一版直接比前三名，
而 `BET_SMALL = 0.95 × BET_MEDIUM` ⇒ 只要下注最高就恒为 LOW，实测 CLEAR_VALUE 也是 LOW）。

#### 第二轮（Murphy · 9 类形态扫描）：4 项，其中 2 项 CRITICAL —— **口径错位，不是调参**

Agent E 在**真实管线**上扫描 9 类「翻后升级可能引入的形态」。结论：**防过度进攻方向成功**
（湿面/强范围/听牌完成面/明显落后牌全部正确收敛，形态 3/4/5/6/8/9 未发现问题），
但**反方向出现系统性反向漏洞**：

| # | 审计实测反例 | 修复 |
|---|---|---|
| **F-1** CRITICAL | 牌面 K♠K♦6♣2♣9♣、UTG 三条街全过牌、Hero BTN **A♣Q♣ 坚果同花**：权益 **94.7%**，同一份输出里 `worseCallDensity = 0.049` ⇒ 判定 `NOT_VALUE`、**引擎过牌**。两句话自相矛盾 | 问题 1/2 改用**相对于我这手牌**的精确比较（`handEval.compareHands` 逐组合） |
| **F-2** CRITICAL | 同牌面只换底牌：bet(4♣5♣ 最小同花 0.8800)=**0.2806** > bet(A♣Q♣ 坚果同花 0.9471)=**0.2300**；bet(K♥Q♥ 三条K 0.8297)=0.2489 也更高 ⇒ **下注分对牌力非单调** | ① `valuePart` 分母改为 `1 − 公平基线`（原来固定 0.35，权益 ≥0.85 整段饱和）；② 负项改用「比我更好的牌」占比 ⇒ 坚果自动得 0 罚分 |
| **F-4** MAJOR | 换街后价值无理由下降：K♦K♥ 超对 转牌 bet 0.3092 `CLEAR_VALUE` ⇒ 白板河牌 0.0273 `NOT_VALUE` | 由 F-1/F-2 同源修复；并加 `RIVER-1`（空白河牌必须保留下注意愿） |
| **F-5** MINOR | 河牌仍能拿到保护分（最高 0.15，与 0.06 判定阈值同量级 ⇒ 可翻转薄价值） | 保护收益加「后面还有没有牌发」前提，**河牌恒为 0**；另补 `Number.isFinite` 守卫（`valueBetGate` / `sizing` / `boardWetnessOf`）|

**根因一句话**：「有哪些**更差**的牌会跟 / 有哪些**更好**的牌会继续」这两个问题
**天生是相对于我这手牌**的，修复前却被「他的范围整体有多强」（`strongShare`）回答。
成对/成花牌面上 `strongShare` 必然饱和到 1.0000（成对面上每手都是「一对 K」），
于是**拿坚果与拿空气得到同一个答案**。

**修复后的口径**（数据全部来自既有引擎，没有新增任何猜测）：

| 量 | 来源 | 语义 |
|---|---|---|
| `weakerShare` | `compareHands(他的 7 张, 我的 7 张)` 逐组合 | 他的范围里**比我这手差**的概率质量 |
| `strongerShare` | 同上 | **比我这手好**的概率质量（坚果手下 ≈ 0） |
| `tierHistogram` | 逐组合相对档（既有 `boardRelativeTierOf`） | 档 0..5 的质量分布 —— 「强度下限」只从**弱尾**取 |
| `strengthFloor` | 弱尾 × 压缩因子 | 真正的**下限**语义（不再由饱和的占比派生） |

**新增回归锁** `test/postflopValueMonotonic.test.ts`（8 条）：`NUT-1`（坚果必须下注 +
下注分随牌力**单调**）/ `NUT-2`（坚果尺寸 ≥2/3 底池）/ `NUT-3`（`strongShare` 可以饱和到 1，
但「更差/更好」必须由相对比较给出）/ `GATE-MONO-1`（下注分对权益单调）/
`GATE-MONO-2`（「比我更好的牌」越多则下注分越低）/ `RIVER-1`（空白河牌保留下注意愿）/
`RIVER-2`（河牌保护收益恒为 0）/ `GATE-NAN-1`（非有限入参不产出 NaN）。
**每条都做过变异测试**：把对应修复改回旧口径后，`NUT-1` / `GATE-MONO-1` / `RIVER-1` /
`NUT-2` 会立刻失败（不通过的测试等于没写）。

**剩余风险（已知未修，如实记录）**：
- `bluffCatchDelta` 目前只改**分数与理由**，不改动作（「不诈唬型 → 抓诈唬↓」尚未能翻转跟注）
- `hasInitiative` 在建议器里硬编码为 `!facingBet`（字段语义被架空）
- `exploit.ts` 的 `drawCompleted` 参数与 `drawChaserNote` 暂无生产调用点
- 相对比较是**7 张牌的当前牌力**比较：它天然忽略补牌质量（听牌在「更差」一侧），
  这是与「更差的手会跟注」的语义一致的，但意味着**听牌面薄价值**仍需靠权益项承担

### 10.0.11 🔴 河牌一致性（RIVER CONSISTENCY V2 · 2026-09 · 真人牌局反馈）

**触发**：真人牌局测试（9人桌 Hero BTN A♣Q♠｜Q♦8♣5♣/2♥/K♣，CO 河牌 lead 22BB）
在生产输出里出现 8 类一致性风险。**本轮只修一致性与口径，不改扑克打法**。

**复现（修复前，真实管线）**：

```text
相对牌力角色：听牌（DRAW）          ← 河牌不可能有听牌（shape 其实是 MIDDLE_PAIR）
价值判断：NOT_VALUE / 偏好顺序 FOLD 0.58 > CALL 0.42
最终动作：CALL（MATH_MARGINAL：权益 24.0% vs 所需 28.0% 落在 ±5% 带内）
界面警告：⚠️ 建议跟注但跟注 EV 为负（−317.61 筹码）—— 数学上不成立的建议不应出现
结算：无人跟注、退回 2200            ← Hero 还没决定跟不跟，钱却被「退回」了
```

三句话互相打架：**角色说听牌、偏好分说弃牌、警告说数学不成立，动作却是跟注。**

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| 1 | 河牌被标成 DRAW | `classifyRelativeRole` 的听牌分支**不看街**：`flushDraw = true`（A♣ + 三张♣ = 四张同花）⇒ 河牌仍算「听牌」 | 听牌分支加「还有牌要发」前提；新增 `normalizeRiverRole` 在产出侧兜底；`RIVER_FORBIDDEN_ROLES` 常量 |
| 2 | 「EV 为负」却推荐该动作 | `MATH_MARGINAL` 只说明「相差很小」就返回跟注，而 `finalMathSanityCheck` 用另一个口径（`callEV < 0`）报警 | 无差别带口径**写进输出**（筹码单位）；`callEV < −带` 却跟注改为**硬错误**（与「明确决策+低置信度」同级抛错） |
| 3 | 启发式评分与真 EV 混用 | `estimatedBetEVScore` 与 `callEV` 在界面并列，措辞都像 EV | `metricKind`（本模块恒为 `PREFERENCE_SCORE`）+ 界面区分「跟注 EV（节点增量口径，弃牌 EV ≡ 0）」与「偏好分（内部评分）」 |
| 4 | 河牌过度用 SPR 作为跟注理由 | `commitment.noteZh` 说「筹码已基本入池 ⇒ 可以纳入 stack-off 考虑」 | 新增 `futureStreetCommitmentBonus`（**河牌恒为 0**）；河牌理由改成「SPR 只作背景信息」；河牌加注不再由承诺例外放行 |
| 5 | blocker 只算阻断价值 | V1 只有牌面特征打分（`我有没有 A`），**没有组合计数**，也没有基于可达范围 | `assessBlockers` 改为**基于可达范围逐组合计数**：`blockedValueCombos` / `blockedBluffCombos` / `valueBlockBenefit` / `bluffBlockCost` / `netBlockerPreference` / `evidenceQuality` |
| 6 | 内部评分显示得像概率 | 「坚果密度 0.76」没有分母、也没标「评分」 | 界面标签改为「内部评分，非概率」；占比类字段一律带**分母**（可达组合数 `supportSize`） |
| 7 | 结算提前 + 重复 | `computeLayeredPot` 把「下注轮未结束的超额」与「最终退回」压进同一个 `returned`；`linesZh` 与客户端**各自拼了一次**「无人跟注、退回 X」 | 拆分 `pendingUnmatched`（时序）+ `returned`（最终）；守恒式改为 `contested + returned + pending === total`；结算事件带**内容标识 id** + `dedupeSettlementEvents`；渲染层按 id 去重，并删除客户端那条重复文案 |
| 8 | UI 解释与生产动作可能不同口径 | 没有「本次动作由哪套指标选出」这个字段 | 新增 `decisionBasisOf`（`CHIP_EV` / `PREFERENCE_SCORE` / `INDIFFERENCE_BAND` / `SAFETY_RULE`）+ `diagnostics.decisionBasis`；偏好顺序行显式标注「本次动作不是由它选出的」 |

**新增守卫**：`src/domain/decision/decisionConsistency.ts` —— `validateDecisionConsistency` 逐项检查
使用者第十九节 A–K（河牌角色 / 合法动作 / 赔率范围 / 指标一致 / EV 警告一致 / 河牌两项加分 = 0 /
未完成节点不得最终退回 / 事件不得重复）。违规进入 `diagnostics.consistency`，
界面首屏显示 **`DECISION_CONSISTENCY_ERROR`**；**不静默**。

**新增测试** `test/riverConsistency.test.ts`（11 条：R1 / R1b / R2 / R3 / R4 / R5 / R6 / R7 / R8 / R9 / R10）
+ `POT-11` 的不变量升级（含「尚未匹配」与时序断言）。

**5 项变异测试**（每条都确认对应测试**立刻失败**，恢复后文件 hash 逐位一致）：

| 变异 | 失败用例 |
|---|---|
| 允许河牌出现听牌 | R1（`AcQs：河牌不得是听牌（实际 DRAW）`）、R1b、R4（守卫报 `RIVER_ROLE_DRAW`）、R10 |
| 把「无差别带」谎报成「由 chip EV 决定」 | R4、R10（守卫报 `ACTION_CONTRADICTS_CHIP_EV`） |
| 河牌未来补牌保护分 > 0 | R4（`RIVER_FUTURE_CARD_PROTECTION_NONZERO`）、R7 |
| 不区分「尚未匹配」与「最终退回」 | R8、R10 |
| 同一结算事件生成两次 | R9（id 必须唯一） |

**剩余风险（本轮未解决，如实记录）**：
- 无差别带内仍**取跟注**（代价最小方向）—— 这是**规则**，不是 EV 结论；若要改成「按偏好分选」，
  会系统性收紧边缘跟注（`foldScore = 1 − callScore` 在 0.5 处翻转），本轮**刻意不做**，需单独评估
- blocker 的**加权**仍是启发式：被挡组合按「可达范围的档位占比 ÷ 组合数」加权（不是逐组合后验），
  已在 `evidenceQuality` 里标注；逐组合后验需要把似然模型暴露成可复用函数
- `callEV` 只覆盖 CALL/FOLD：**加注 EV 仍不可算**（缺可信弃牌率），因此加注只能由安全规则选出
- 抽水未建模（`callEV` 是未计抽水口径，界面已声明）

### 10.0.12 🔴 河牌一致性 V2.1（定向复核 · 2026-09 · 4 项未关闭问题）

**触发**：V2 通过工程一致性测试后，最终复核仍发现 4 个问题。本轮**只修这四点**，
不动 preflop / GTOpen / legalActions / 画像 schema / range tables / 已通过的
Board Delta、Range Compression、Value Gate 与既有策略阈值。

| # | 问题 | 根因（实测） | 修复 |
|---|---|---|---|
| **P0-1** | 河牌明明有成交牌，却被归类为 `AIR` | `isOnePairShape` 分支里的 `equity >= requiredEquity * 0.9 ? BLUFF_CATCHER : AIR` —— 那个 0.9 回答的是「**能不能盈利地抓诈唬**」，却被拿去回答「**是不是空气**」。实测 A♣Q♠（中对，权益 24.0% / 门槛 28.0%）⇒ AIR | 新增 `MadeHandClass`（成交牌型）与 `RelativeHandRole` **分离**；一对/两对统一走 `madeHandRoleFacingBet`（权益够 ⇒ BLUFF_CATCHER；**有摊牌价值或不详** ⇒ SHOWDOWN_VALUE；确认毫无摊牌价值才 AIR）；新增域不变量 `madeHandRoleInvariantViolation`（河牌 `madeHand ≠ HIGH_CARD ⇒ role ≠ AIR`） |
| **P0-2** | 把「**负 EV 但差距不大**」说成「数学上无明显优劣」 | `MARGINAL_EV_GAP_RATIO (5%)` 被当成**数学无差异**：`FOLD EV 0 > CALL EV −317.61`，却因 `|−317.61| ≤ 5% × 7850 = 392.50` 判「边缘」并**跟注** | 5% 改名定性为**模型容差带**（`MODEL_UNCERTAINTY_RATIO`，公式 `5% × winnable`）；动作**只看真实 EV 排名**（仅留 `MATH_EV_EPSILON = 1e-6` 浮点余量）；「不确定性覆盖」改为**显式开关** `allowUncertaintyOverride`（**默认 false**），开启时依据标成 `MODEL_UNCERTAINTY_OVERRIDE` 并声明是工程启发式；`MATH_INDIFFERENCE` 仅保留给真正的浮点级相等 |
| **P1-1** | `value combos / bluff combos` 实际只是 stronger/weaker | V2 用「比 Hero 强/弱」冒充「会下注取值/会诈唬」，而弱牌里绝大多数是**摊牌牌**（实测 A♣Q♠ 节点：更弱 292 组合，其中诈唬候选只有 156） | 新增 `riverActionClass.ts`：`RiverActionClass = CLEAR_VALUE / THIN_VALUE / SHOWDOWN / BLUFF_CANDIDATE / UNCERTAIN`（输入：与 Hero 的强弱、相对档位；证据不足 ⇒ UNCERTAIN，不强行算成诈唬）。字段改名 `blockedStrongerCombos / blockedWeakerCombos`，只有分类后才产出 `valueBetCandidateCount / bluffCandidateCount`；`OpponentRangeFacts.counts` 暴露**整数组合数**（与概率质量占比分列，两者在真实后验下差异很大：组合 27% 更强 vs 质量 74% 更强） |
| **P1-2** | 简化未匹配退款公式冒充通用结算 | `退回 = 我投入 − 其他人最高投入` 直接放在 `computeLayeredPot` 里，没有限定作用域 | 新增 `SettlementScope`（`HEADS_UP_CLOSED_ROUND` / `LEDGER_LAYERED`）+ `settlementScopeOf`；抽出 `computeHeadsUpClosedRoundUnmatchedReturn` 并配 `assertHeadsUpUnmatchedScope`（**轮次已关闭 + 未弃牌者 ≤ 2**，违反即抛错）；`LayeredPot` 带 `scope`；单挑关闭轮次时**两处口径互相复算**，不一致即抛错 |

**新增测试** `test/riverConsistencyV21.test.ts`（16 条：ROLE-1..5 / BAND-1..4 / RANGE-1..3 / SETTLEMENT-1..4）；
`POT-D10` 语义升级（容差带内**跟随 EV 排名弃牌**，但只标 `MARGINAL` 且不得声称数学无差异）。

**5 项变异测试**（每条都确认对应测试**立刻失败**，恢复后 SHA-256 逐位一致）：

| 变异 | 失败用例 |
|---|---|
| 让「一对」可以回落到 AIR | ROLE-1、ROLE-2、ROLE-5 |
| 把 5% 工程容差重新标成「数学无差异」 | R4、R10、BAND-1、BAND-4（守卫报 `ACTION_CONTRADICTS_CHIP_EV`） |
| 令 weakerThanHero 直接等于 bluff | RANGE-1、RANGE-2、RANGE-3 |
| Hero 未行动时把 pending 直接转 returned | R8、R10、BAND-3、SETTLEMENT-1 |
| 让多人 side-pot 走简化退款路径 | SETTLEMENT-4 |

**剩余风险**：
- 容差带仍参与**分类与置信度**（`MARGINAL`），只是不再决定动作；若要彻底移除需先建立可信的模型误差估计
- 河牌动作分类是**结构性映射**（档位 + 相对强弱），不是下注频率模型；`UNCERTAIN` 是刻意保留的出口
- `valueBetCandidateCount` 在「坚果级 Hero」上会与 `strongerThanHeroCount` 相等（结构使然，非缺陷）：
  比坚果更强的牌必然是最强档

### 10.0.13 🔴 缓存键黄金向量（CACHE KEY GOLDEN VECTOR · 2026-09 · 定向加固）

**范围**：只审计并加固三把键 —— `scenarioHash` / `treeId` / `cacheKey`。
**不改任何扑克策略**（preflop / postflop 阈值 / 画像语义 / 决策引擎判据均未触碰）。

**审计结论（真实生产代码，逐字段追踪）**：

| 键 | 定义位置 | 输入字段 | 序列化 | 哈希 |
|---|---|---|---|---|
| `scenarioHash` | `gtoScenario.ts:scenarioHashOf` | `v`(版本) / `kind` / `gameType` / `tableSize` / `effectiveStackBB` / `heroPosition` / `actionHistory[{position,kind,sizeBB}]` / `blinds{sbBB,bbBB,anteBB}` / `heroAlreadyActed` | 规范化 JSON | FNV-1a **32 位**（8 hex），前缀 `g` |
| `treeId` | `gtoScenario.ts:treeIdOf` | `tableSize` / `blinds` / `stack` / `openSizesBB[]` / `raiseMults[]` / `maxRaises` / `limp` / `addAllin` / `engine`（**无版本字段**，设计如此） | 同上 | 同族，前缀 `t` |
| `cacheKey` | `gtoScenario.ts:cacheKeyOf` | `v`(缓存版本) + `scenarioHash` + `solveFingerprint`（后者含 19 项求解设置：engine / commit / solverVersion / 动作菜单 / rake / realization / iterations / targetGap / 座位 / 下注 …） | 同上 | 同族，前缀 `c` |

**发现的 4 处真实缺口（全部已修）**：

| # | 缺口 | 修复 |
|---|---|---|
| 1 | **顺序依赖**：`JSON.stringify({字面量})` ⇒ 键由**源码书写顺序**决定；且**嵌套对象**（`blinds` / `actionHistory[i]`）根本没被规范化 —— 把 `{sbBB,bbBB,anteBB}` 写成别的顺序会得到不同的键（文档当时却声称「顺序无关」） | 新增**显式字段表** `PAYLOAD_SCHEMAS` + `NESTED_SHAPES` + `canonicalPayloadOf`：顶层与嵌套都按表重排，字段集合多一个/少一个**直接抛错** |
| 2 | **非有限数静默折叠**：`JSON.stringify(NaN)` → `null` ⇒「金额是 NaN」与「没有金额」撞成同一个键 | 必需数值非有限 **抛错**；可空金额显式 `null`（`requiredBB` / `nullableBB`），并有专门测试 |
| 3 | **持久化读取只比哈希**：条目里明明存了完整 `scenario`，却只用 32 位哈希字符串核对 ⇒ 碰撞（或索引被改写）会静默命中别的场景 | `store.load()` 增加**逐字段场景比对**（`scenariosEquivalent`），不一致即拒绝 + 留可诊断警告 |
| 4 | **in-flight 复用只比键**：两个场景碰撞时会共享同一个求解 Promise ⇒ 静默拿到别人的结果 | `inFlight` 改为存 `{scenario, task}`，复用前逐字段比对（不相等则各自求解） |

**同时确认已经存在、本轮未改的防线**（审计要点，避免重复劳动）：
`cacheKey = 场景哈希 + 求解设置指纹`（不是同一个 payload 重复哈希）；内存缓存命中做逐字段比对并删除坏条目；
存储层三道校验（键 / 哈希 / 结构）；`solve` 与 `solveMeta` 一致性校验；`storeVersion`；
Catalog 构建时的 `scenarioHashOf(entry.scenario) === entry.scenarioHash` 自检。

**🔴 加固**必须**逐字节兼容**（这是本轮最重要的工程约束）：
键值一变，`data/gto-cache` 的条目与**按 cacheKey 索引**的 `data/gto-stability.json`
（离线稳定性证据）就会全部失配 ⇒ 质量评级静默降级。
因此字段表顺序 = 加固前字面量顺序，并用黄金向量锁定：加固前后三把键**逐位相同**
（`gc4358aae` / `t18337408` / `c456718aa` …）。

**新增测试**：`test/gtoCacheKeyGolden.test.ts`（24 条：GOLDEN 4 / SENS 7 / INSENS 2 / CANON 5 /
VERSION 2 / COLLISION 3 / SCHEMA 1）+ `GTO-CACHE-25`（存储层碰撞拒绝）= **25 条**。

**6 项变异测试**（每条都确认对应测试**立刻失败**，恢复后 SHA-256 逐位一致）：

| 变异 | 失败用例 |
|---|---|
| 把 `position` 移出键 | CACHE-GOLDEN-1 / -3、CACHE-CANON-1 |
| 把有效筹码移出键 | GOLDEN-1 / -3、SENS-2、CANON-3、COLLISION-1 |
| 把动作历史移出键（`board` 的类比替身，见下） | GOLDEN-1 / -3、SENS-4 / -5、CANON-1、COLLISION-1 |
| 把 schema 版本固定成常量 | GOLDEN-1 / -3、CANON-1、VERSION-1 |
| 序列化器改为依赖对象插入顺序 | CANON-1、CANON-2b |
| 短路碰撞防线（存储层 / in-flight） | GTO-CACHE-25、CACHE-COLLISION-3 |

**关于使用者清单里的 `holeCards` / `board`**：这两项**不在任何一把 GTO 键里**，且是**设计要求**——
GTO 基线是**范围级**答案（「9人桌 BTN 面对 UTG 开池 2.5BB 的范围」），不是「AsKs 该怎么打」；
底牌由 Alpha 在拿到范围后落到具体手牌。因此 `CACHE-SENS-HOLE` 断言的是**不变**
（MUST_NOT_AFFECT_KEY），并附类型级证据（`GtoScenario` 没有这两个字段）。
也因此「删除 board ⇒ 测试失败」这条变异**不适用**（board 从未在键里），
改用同角色的 `actionHistory` 代替，结论一致。

**关于花色同构（suit isomorphism）**：本项目**没有**、也**不引入**花色归一化。
三把键不含牌面信息；`hashManualInput`（决策日志用的另一把键，**本轮未改**）按原样序列化底牌与公共牌，
因此「同构花色被错误合并」这类风险在键层面不存在。相关审计观察另见
`reports/V21_PRODUCTION_CHAIN_VERIFICATION.md`（Part B：`rangeDistance` 的真实含义）。

**剩余风险**：
- FNV-1a 是 **32 位**非密码学哈希：不声称「不会碰撞」。现在的保证是「碰撞**不会被静默接受**」
  （三层逐字段比对）。若要更强的抗碰撞，需要换 64/128 位摘要 + 迁移版本号，属独立一轮
- `treeId` 无版本常量：由「字段表 + 敏感性测试」保证形状变化必然改变 id；若将来需要
  「形状语义变更但字段不变」的迁移，需要补一个版本字段（会作废全部旧 treeId，需评估）

### 10.0.14 🔴 画像决策小规模验证（PROFILE V2.1 第一轮 · 2026-09 · 只做验证，不改权重）

**范围**：12 个代表场景（跟注站 3 / 疯狂型 3 / 紧弱型 3 / 防护 3），
每个场景只改 `villain.quickProfile`，其余逐位相同。**未做** 1260 全量矩阵、
未做五 Agent 审查、未改 `MATERIALITY_THRESHOLDS` 或任何权重。

**报告**：`reports/PROFILE_V21_SMALL_SCALE_AUDIT.md`
**复现**：`scripts/v21-small-scale-scenarios.ts`、`scripts/v21-small-scale-supplement.ts`

**本轮实测（不是 V2 的旧值）**：

```text
action flip = 0        sizing change = 0
最大 |Δ权益|     = +1.35pp（B1 黄金夹具 MANIAC）
最大 |Δ诈唬质量| = 0.0316
materiality      = TRIVIAL（0.0135 < 0.02 且 0.0316 < 0.05）
中性兼容性       = 不给画像 == UNKNOWN == NORMAL == 零手实测画像（逐位相同）PASS
```

⚠️ **`equityDelta = 0.0180` / `bluffMassDelta = 0.0422` 是 V2 黄金夹具的旧值，
本轮未复现该数字**（本轮同一手实测 0.0135 / 0.0316）。两个数字**不得混用**。

**生产链路（已核实，逐点行号见报告 §2）**：

```text
analyzeManualHand → buildDecisionContext
  ① behaviorProfileOf(quickProfile)                 contextBuilder.ts:3168-3175
  ② 画像 → 范围（两条通道都真实生效）
     a) tendency provider（**所有街**）              contextBuilder.ts:1440-1447 → :1039
     b) 河牌进攻动作的似然覆盖（**仅河牌**）         contextBuilder.ts:1202 / :1280-1290
  ③ opponentRangeFactsOf（**只读观测**）             rangeFacts.ts:84
  ④ computeHeroEquity                               contextBuilder.ts:2169
  ⑤ buildBetDecisionFacts → Fold/Call/Raise         contextBuilder.ts:1567
  ⑥ postflopAdvisor betDecision → 动作与尺度         postflopAdvisor.ts:549-619
```

🔴 **`profileClassMasses` / `actionMasses` / `profileRangeDistance` 都不是决策输入**
（`src/` 内零消费者，只有 `test/` 与 `scripts/` 读）。画像影响决策的真实中介量是
②-a 的 `profileFactor`、②-b 的 `likelihoodOverride`、⑤ 的响应倾向。

**`rangeDistance` 口径标注（本轮落地，只加注释不做全仓重命名）**：
`src/domain/player/profileRangeMetrics.ts` 的 `profileRangeDistance` 已标注为
**`CATEGORY_LEVEL_RANGE_DISTANCE`（= `RANGE_DISTANCE_PROXY`）** ——
它度量的是 `profileClassMasses` 聚合出的 **5 个互不重叠类别**的分布差异，
**不是 1326 个具体组合的逐组合差异**，**同一类别内部的组合变化它看不见**。

**本轮未修复、留给下一轮的三个问题**：

| # | 问题 | 证据 |
|---|---|---|
| W-2 | **面对下注的节点上候选动作 EV 全部不可得**（9 个 RAISE 档 + ALL_IN 均 `ev: null`），`mathDominance` 只在 FOLD vs CALL 间比较 | 报告 §6.3 |
| R4 | 画像影响幅度只有**单点估计**，无可信区间；与 V2 的 0.0180 差异未完全归因 | 报告 §7 |
| W-3 | `BetSizeBucketOf` 使尺寸证据呈**阶梯状**（0.4 / 0.6 / 1.25），连续尺寸扰动**不可能**改变结论 | 2–30BB 扫描：NORMAL 恒定 56.26%，MANIAC 仅 2 个取值 |

**既有问题（非本轮引入，如实登记）**：`npm run verify` 实测
**1778 tests / 137 suites / pass 1774 / fail 4**（交接称 fail 0，**不属实**）。
4 个失败全是墙钟预算断言（`dynamicBehavior` P95、`layeredPot` POT-14、
`postflopOutput` P3-1、`postflopRegressionCases` TEST 5），
**单独运行 82/82 全绿** ⇒ 全套件并发 CPU 争用下的抖动。
**未放宽任何断言。**

⚠️ **并发写入披露**：本轮进行期间有**另一个会话**在同一工作区新增约 35 个
`scripts/v21-*.ts` 与多份 `reports/V21_*`。本节的数字全部来自本轮亲自运行的脚本；
那些并发产物**本轮未复核、未引用为证据**。因此本轮的一切哈希与「基线」**只对读取时刻成立**。

### 10.0.15 🔴 画像 A/B + 策略评分命名 + EXACT 权益语义（定向审计 · 2026-09）

**范围**：验证 `CALLING_STATION` 是否真的进入河牌决策链、修正「启发式评分被显示为 EV」、
查清 `EXACT × 990` 的真实语义。**未重写画像系统、未新建 HUD、未引入外部求解器、
未改动 GTO baseline、未调参让测试变绿。**

**冻结牌局**：6-max · SB1/BB2 · 100BB · Hero BTN `A♣5♣` vs BB ·
`K♣8♦4♣2♠Q♦` 河牌错过同花听牌 · 底池 53 · SPR 3.28。

**A/B 实测（唯一变量 = 画像）**：

```text
                        CALLING_STATION   NORMAL
Final Action            CHECK             CHECK
Recommended Size        BET_SMALL (8.83BB) 同
Fold%  S/M/L            0.94 / 6.81 / 10.61 %   3.15 / 9.63 / 13.48 %
Call%  S/M/L            92.03 / 87.42 / 84.72 % 89.77 / 84.55 / 81.77 %
BET 策略评分 S/M/L      0.324 / 0.201 / 0.079   0.339 / 0.224 / 0.108
CHECK 策略评分           0.500（两侧相同，见下）  0.500
Confidence / Class      0.300 / MARGINAL        0.300 / MARGINAL
Hero Equity             0.7250 %                0.6851 %
Equity                  EXACT × 990             EXACT × 990
```

**画像进入决策链的真实参数**（`archetypeDimensions.ts:120-124`）：

```text
CALLING_STATION 维度 = tightness 0.30 / aggression 0.30 / bluffTendency 0.35 / passivity 0.80
NORMAL          维度 = 全 0.5（刻意中性）
经 responseTendenciesOf（betResponse.ts:259-292，confidence 0.35）缩放后：
  callScale      1.0882   （NORMAL 1.0000）
  foldScale      0.9027   （NORMAL 1.0000）
  raiseScale     0.9580   （NORMAL 1.0000）
  bluffRaiseScale 0.9633  （NORMAL 1.0000）
  riverBetScale  0.8688   （NORMAL 1.0000）
```

⚠️ **`CHECK 策略评分` 两侧都是 0.500** —— 因为 `checkScore` 在
`postflopAdvisor.ts:640` **硬编码为常量 `0.5`**（它是评分基准，不是算出来的量）。
因此「CHECK 相对吸引力上升」**不体现为 checkScore 变大**，而体现为
**下注评分下降**（0.324 vs 0.339）。这是本期实测的口径事实，不是缺陷。

**`EXACT × 990` 的真实语义 = `RANGE_CONDITIONED_EQUITY`**（三条证据）：

1. 控制实验：把对手范围设为「A♦A♠ 权重 99 ｜ 7♠2♦ 权重 1」，
   引擎返回 **1.0000%**，与**按权重手算**逐位一致 ⇒ 权重生效；
2. 生产范围 `range.entries.length = 990`，其中**权重为 0 的有 515**、
   权重 > 0 的（`metrics.supportSize`）为 **475** ⇒ 分布**非均匀**；
   与 Hero/牌面死牌冲突的组合数为 **0** ⇒ 死牌过滤正确；
3. 若真是「任意两张未知牌」，A♣5♣ 对随机牌的权益约 **33.18%**（手算 990 局）；
   实测 **0.7250%** ⇒ 相差 45 倍，语义完全不同。

⚠️ **但 `EXACT × 990` 这个展示数字本身有误导性**：`enumerateExact` 的 `matchups`
按 **entries 数**计（`equityExact.ts:141`），因此 990 里含 515 个零权重槽位；
**有效支撑只有 475**。两个数字数值上偶然都容易与 `C(45,2)=990` 混淆。
⇒ 登记为**展示口径问题**，本轮未改数值（未擅自删除），新增测试把语义钉住。

**EV 命名修正（仅显示/文案，未改数值与决策）**：

| 位置 | 修改前 | 修改后 |
|---|---|---|
| `decisionViewModel.ts:734` | `CHECK EV 0.4` | `CHECK 策略评分 0.50（0–1 启发式偏好分，非筹码 EV）` |
| `decisionViewModel.ts:809` | `｜分 0.324` | `｜策略评分 0.324（0–1 启发式偏好分，非筹码 EV）` |
| `decisionEngine.ts:1922` | `CHECK 优于所有尺寸（CHECK EV 42.6…）` | `CHECK 策略评分 0.50…（不代表任何筹码盈亏）` |

**保留未动**：`checkTree.checkEV`（`composeCheckTreeEV` 概率加权，**是**真实筹码 EV）、
`betEV` / `deltaVsCheck` / `evFoldBranch` 等 —— 那是真筹码 EV，不得误伤。

**新增测试** `test/profileAbAndEvNaming.test.ts`（13 项，全部通过）：
Test A1–A5（画像方向与「真的改变模型」）、Test B1–B4（EV 命名 + 不误伤真 EV）、
Test C1–C4（990 语义 + 权重归一 + `supportSize ≠ iterations`）。

**遗留（本轮只登记）**：① VPIP/PFR/WTSD/Fold-to-CBet 等**连续统计**目前
**没有输入通道**，画像只能走 11 个手选标签；② `checkScore` 是常量 0.5，
不含画像影响；③ 项目**仍无真实 chip EV**（下注类动作的 EV 依赖弃牌率，
`evaluateCandidates` 刻意给 `null`）。

### 10.0.16 🔴 PLAYER PROFILE V3 —— 连续统计 + 样本置信度 + 标签先验（2026-09）

**目标**：让软件从「猜他是什么类型」逐渐变成「知道他实际上怎么打」，
**不推翻** 11 个手选标签，只在既有链路上加入第二个证据来源。

```text
标签 Prior（quickProfile）  ← 用户主观断言，**不被覆盖**
实测统计（observedStats）  ← 真实观察到的行为，带机会数
样本量 ⇒ 可信度 n/(n+K)     ← 决定该相信实测到什么程度
        ↓  resolvePlayerProfile
resolved dimensions + 分街 factor
        ↓
现有决策链（**公式未改**）
```

**新增文件**：`src/domain/player/observedStats.ts`、`test/playerProfileV3.test.ts`
**数据通道**：`villain.observedStats` → `alphaPipeline` → `ContextBuildInput.observedStats`
→ `resolvePlayerProfile` → ① `v3Dimensions`（覆盖标签维度）
② `v3Street`（分街系数）→ `responseTendenciesOf` → `classifyResponse`

**支持的 10 项统计**（全部 `0..1`，缺失用 `null`，**禁止用 0 冒充缺失**）：
`vpip` / `pfr` / `threeBet` / `wtsd` / `foldToFlopCBet` / `foldToTurnCBet` /
`foldToRiverBet` / `flopCheckRaise` / `turnCheckRaise` / `riverCheckRaise`。

**可信度模型**：`confidence = n_opp / (n_opp + K)`，
`effectiveRate = prior + (observed − prior) × confidence`。
K 按**统计频次**分三档（这是本轮的核心设计，不能统一）：

| 档 | 统计 | K | 机会频率 | 需要多少手 |
|---|---|---|---|---|
| 高频 | VPIP / PFR | **75** | 1.0 /手 | ≈75 手 |
| 中频 | 3Bet / WTSD / FoldTo{Flop,Turn}CBet | **150** | 0.25 / 0.30 / 0.35 / 0.18 | ≈300–830 手 |
| 低频 | FoldToRiverBet / \*CheckRaise | **200** | 0.10 / 0.15 | ≈1300–2000 手 |

**分街隔离**（§七 / §八 的硬约束）：`FoldTo*CBet` 与 `*CheckRaise`
**只进它自己那一街**（`riverBetScale` 类因子），并有测试锁定
「river 统计不得污染 flop」。

**🔴 本轮实测抓到的四个缺陷（都已修，留作记录）**：

1. **方向被弄反**：分街条目的先验恒设 0.5 ⇒ 「跟注站 FoldRiver 19%」被
   `0.5` 往上拉，引擎得出「他比普通人**更爱**弃」。⇒ 先验改为锚在
   **人群中心 0.45** 再按标签维度偏移（跟注站 0.380、极紧 0.498）。
2. **量纲错误**：拿 `statEvidenceOf`（**按离散次数**的 Beta-Binomial）去收缩
   一个**已经是聚合比率**的 HUD 值，`round(opportunities × rate)` 在小样本下
   把比率四舍五入没了 —— 实测 8 手 `FoldRiver = 0.10` 被算成 **0.000**
   （=「他从不弃河牌」，正是 §十二 明令禁止的结论）。⇒ 改为
   `prior + Δ × confidence` 的线性混合。
3. **维度饱和**：逐步长求和让 `passivity` / `aggression` 精确撞到 1.0 / 0.0；
   且「160 手」与「1500 手」给出**完全相同**的 tightness（都撞顶）。
   ⇒ 改为**加权平均 + 先验质量项** `Σ(p·c) / (priorMass + Σ|p|·c)`，
   现在样本量与纠正强度**严格单调**（P8b 锁定）。
4. **重复计票**：`FoldTo*CBet` 同时经「维度」与「分街因子」两条通道
   ⇒ 同一条统计被用两次。⇒ 每条统计**恰好**影响一个通道
   （VPIP/PFR/3Bet/WTSD 走维度；分街统统计走分街因子）。

**V2 兼容（§十一）**：`observedStats = null` 或全字段缺失时，
三个分街系数**恒为精确的 1**、四个维度**精确为 0.5** ⇒ 与 V2 archetype-only
**逐位一致**（P1 / P1b 用 `assert.equal` 锁定，非容差比较）。

**版本**：`ALPHA_DECISION_MODEL_VERSION` `1.0.5` → **`1.0.6`**
（`DecisionContext` 新增可选 `profileV3` 诊断字段；纪律要求该文件改动必须升版本）。
**全部判定阈值与数学层冻结**，`MATERIALITY_THRESHOLDS` 未动。

**遗留**：① 机会数在未传 `villainProfile` 时是「手数 × 频率」**近似**，
真实逐手机会数需从 `PlayerProfile.metrics[m].opportunities` 取；
② §十六 的「自动重分类建议」本轮**未实现**（标签原样保留）；
③ UI 展示本轮未做（trace 已在 `context.profileV3` 里可用）。

### 10.0.17 PLAYER PROFILE V3 · FACING BET CHANNEL M1 + 自审 + 修复（2026-09，**未提交**）

**要解决的问题**（审计结论）：实测统计（VPIP/PFR/3Bet/WTSD）此前**到不了面对下注决策**——
面对下注的两个消费者（响应刻度 `buildRaiseResponse`、他的下注范围 `betProbabilityByBand`）
只拿到手选标签；`resolvedDimensions` 的唯一消费者 `buildBetDecisionFacts` 在
`postflopAdvisor.ts:576` 被 `if (facingBet || betDecisionFacts === null) return null` 丢弃。

**实现（方案 D 字面）**：新增 `src/app/manualInput/facingBetProfile.ts`（已登记，清单 159 → **160**）；
`tendenciesForSeat`（**响应层**）在**有轴证据**时改喂「标签 ×0.35×(1−w) + 实测 ×w」
（`confidence = 1`），**无轴证据时逐位走旧实现**。
EV / 筹码口径 / 合法动作 / 冻结节权益（U1、P0、P1-2a/2b、P1-4）与一切冻结参数未动。

**自审发现（`reports/M1_FACING_BET_CHANNEL_SELF_REVIEW.md`）**：

1. **🟠 高危口径缺陷**：`betProbabilityByBand` **不读 `confidence`**
   （`bettingRange.ts:390`，`betResponse.ts:432-437` 维度原样透传）⇒ 折进 0.35 后，
   该层标签强度从 `1.0` 变成 `0.35×(1−w)`，**第一个观测即跳变**（`betMass` −38.1%），
   且对**无观测通道**的 `bluffTendency` 同样施压；该层又经
   `contextBuilder.ts → buildRaiseResponse` 回流进「弃/跟/再加注」桶划分。
2. **🟠 归因修正**：上轮 `RAISE EV +1.4197` 的分量 = P1 响应刻度 **+0.2817（19.8%）** +
   P2a 下注范围（融合维度）**+0.1454（10.2%）** + P2b 下注范围（标签被折 0.35）**+0.9925（69.9%）**；
   `CALL EV` 与 `betMass` 的变化 **100% 来自下注范围层**（P2b 占 90.4% / 81.1%）。
   上轮「由实测统计驱动」的表述**不成立**。
3. **🟠 覆盖面缺口（未修）**：「无标签 + 无动态提示 + 只有实测统计」时通道**完全关闭**
   （`playerBuilt.tendency === null` 提前返回中立；与完全无画像逐位相同）。
4. **🟡 潜伏隐患**：`playerBuilt.confidence` 非纯标签置信度（observation-only 时为 `NO_DATA_NEUTRAL`）；
   `baseDimensions` 与手选标签维度的逐位等价是「传两份维度」的前提，已加测试固定。
5. **⚪ 既有未修**：面对下注层（实测 ×1.0·w）与 Hero 主动下注层（融合 ×0.35）强度差 **2.86×**。

**✅ 修复（已授权执行，`reports/M1_BAND_LAYER_LABEL_SCALING_FIX.md`）**：
`contextBuilder.ts` 把两个消费者**分开取证** —— 响应层 `tendenciesForSeat` 保持 M1 语义不变；
下注范围层改用新增的 `betRangeTendenciesForSeat`，喂 V3 **融合维度** `resolvedDimensions`
（标签 `(1−w)`、实测 `w`、**不折 0.35**），无轴证据时仍吃原标签维度。

| 量（TEST 16，MANIAC+800 手） | 纯标签 | 修复前 | **修复后** |
|---|---|---|---|
| `betMass` | 0.472404449170 | 0.325557982074（−38.1% 跳变） | **0.444597607765** |
| `CALL EV` | 72.940211164 | 72.933737730 | **72.939592245** |
| `RAISE EV` | 146.064821986 | 147.484509709 | **146.491968643** |
| 最终动作 | RAISE @ 120 | RAISE @ 120 | **RAISE @ 120（未变）** |

- **EV 分解（受控实验 `M1_FREEZE_BAND`）**：P1 **+0.281740**（修复前后逐位不变 ⇒ 修复只动了下注范围层）
  + P2a **+0.145407**（保留：实测应当产生的影响）+ P2b **+0.992541 → 0**（缺陷归零）。
- **连续性**：0 → 1 手位移 0.000275（总位移的 **0.9%**；修复前一步吃掉 5776%），且 0/1/20/800/5000 手**单调**。
- **新性质（逐轴隔离）**：V3 融合是逐轴的、而该层不消费 `tightness` ⇒ **只给 VPIP 时该层与纯标签逐位相同**（修复前会掉 −38.1%）——与该层无关的证据不再泄漏进该层。
- **未改**：`bettingRange.ts` / `betResponse.ts` / `raiseResponse.ts` / `observedStats.ts` /
  `decisionEngine.ts` / `postflopAdvisor.ts` / `playerIdentity.ts` 与一切冻结参数。

**待裁决（仍未处理）**：U-F3（是否开放「只有实测统计」形态）、U1（逐统计锚点饱和，已用墨菲 M-7 钉住）、
U2（`streetBetScale` 的 `confidence`）、U-F6（跨分支统一）、以及**是否提交/推送**。

**新增测试**：`test/profileFacingBetChannel.test.ts` 17 → 21 → **35 项**
（§五 A-1~A-4 修复语义与反证；§六 墨菲 M-1~M-10 对抗测试；附录 1–4 接口语义/归因/覆盖缺口）。

### 10.0.18 TEST 17 · 决策展示与模型假设最小修复（2026-09，**未提交**）

**范围（严格限定为「解释已算出的决策」，不重算任何决策）**：只修 TEST 17 审计确认的三个**用户可见**问题。
检查点（开工前）：`%TEMP%\dezhou-checkpoint-test17-20260919-214542`（654 文件 + sha256 清单，逐位 0 差异）。

| # | 问题 | 修复位置 |
|---|---|---|
| 1 | CALL EV 的权益来源没有标注（`math.heroEquity` 68.22% 被读成 EV 的输入，实际输入是 `EqVsBetRange` 73.51%） | `decisionEngine.ts` 新增纯标注函数 `callEvEquityOf`；改**候选注记**、`MATH_CALL_SUPPORTED`、`MATH_FOLD_DOMINANT`（镜像）、`MATH_ESTIMATED_EQUITY`（澄清）、`SIDE_POT_LAYERED_EQUITY`（同类歧义）；`decisionViewModel.ts` 拆成「对手下注范围权益（本次跟注 EV 与加注门槛的输入）」与「整体范围权益（仅参考）」两行，并把权益输入写进「跟注 EV」行 |
| 2 | 中文决策说明损坏（恢复提交 `5ef4f2f` 引入，≥11 处用户可见） | `decisionEngine.ts` 逐条精确修复：`1785 / 1797 / 2276 / 2287-2288 / 2360-2364 / 3105 / 3178 / 3247-3249 / 3267-3271`（保留全部原因码、动作码、条件与数据字段） |
| 3 | 再加注分支的未来街终止近似未披露 + 假设清单重复 | `contextBuilder.ts` 的 `assumptionsZh` 去重（6 → **9 条**，0 重复）并新增：摊牌终止近似（已枚举未来公共牌、**未模拟**后续街行动）、「不是严格下界」的限定、4-bet 未实现的单独说明；`noteZh` 的 RAISE EV 公式改为打印**实际参与计算的分支值**（原先写死 `×(−heroContestedAdd)`，复算不出打印的 EV） |

**验收数值（逐位不变）**：`CALL EV = 30.719693642502683`；`RAISE 80 EV = 36.75849453937832`；
P1-2b `FOLD = −80`、`CALL = −67.732181090706945`（分支 `CALL`）；最终动作 `RAISE @ 80` 未变。

**未改**：`computeEquity` / CALL EV 公式 / 条件范围生成 / 再加注分支选择与 EV 公式 / 一切策略参数与阈值。
**新增测试**：`test/test17DisplayDisclosure.test.ts`（**11 项**，D-1~D-8）。

### 10.0.19 TEST 18 · RAISE-TO AMOUNT CONSISTENCY P1（加注金额口径一致性，2026-09，**未提交**）

**触发**：TEST 18 只读审计（转牌面对加注：本街已投入 20、剩余 166、合法全下累计 186）发现
`finalMathSanityCheck` 把**本街累计**金额与**剩余筹码**直接比大小，于是把**合法全下**误报成
「⚠️ 建议尺寸 186 超过剩余筹码 166 —— 已被最终数学检查拦截（不应发生，请报告）」。

**动作金额语义（§四，逐条核对实现 —— 不是假定所有动作同口径）**：

| 动作 | `sizeChips` 来源 | 口径 | 合法上限 |
|---|---|---|---|
| `FOLD` / `CHECK` | 无 | — | — |
| `CALL` | `legal.callCost` | **本次新增投入**（增量） | `myRemainingStack` |
| `BET` | 尺寸网格 `toAmount` | **本街累计**（首次下注 ⇒ 与增量恒等） | `allInToAmount` |
| `RAISE`（含加注到全下） | 尺寸网格 `toAmount` | **本街累计（raise-to）** | `allInToAmount` |
| `ALL_IN` | `legal.allInToAmount` | **本街累计** | `allInToAmount` |

**修复（2 个生产文件）**：
1. `src/app/alphaPipeline.ts`：`finalMathSanityCheck` 按动作分档选上限
   （BET/RAISE/ALL_IN → `legal.allInToAmount`；CALL → `legal.myRemainingStack`），
   参数新增 `allInToAmount`，浮点容差 `SIZE_SANITY_EPSILON = 1e-6`（远小于 0.02 筹码的最小粒度）；
   告警文案改为点明「本次动作的合法上限 N（本街累计口径 = 本街已投入 + 剩余筹码）」。
   **不做**最小加注额判据（短筹码 under-raise 全下在规则上合法；最小额由 `buildSizeGrid` 保证）。
2. `src/viewmodels/decisionViewModel.ts`：动作行改为「建议：全下」（`RAISE_TO_ALL_IN`/`DIRECT_ALL_IN`），
   尺寸行写明「加注至 186 筹码（93.0BB，本街累计；本注即全下）｜本次再投入 166 筹码（83.0BB）」，
   数学明细新增**金额口径三行**「本街已投入 / 本次再投入 / 加注后的本街总额」（BET 为「本次下注 / 下注后的本街总额」，
   CALL 为「本次补入 / 跟注后的本街总额」）。

**验收数值（逐位不变）**：`CALL EV = 75.18122987205047`；`RAISE 186 EV = 93.97844769482654`；
动作 `RAISE 186`；`heroAdd 166`；`villainAdd 106`；`finalPot 401`；`FOLD EV ≡ 0`。
**原有测试改动**：仅 `test/alphaRedteamRegression.test.ts` 的 `legal` 夹具**补上新字段** `allInToAmount`（断言未动）。

### 10.0.20 P1 · 99 中对 CALL/FOLD 一致性定向审计（2026-09，**只读，未修**）

**现象**：Hero 持 9♥9♣（转牌面对 BB 10BB 领打）时 `CALL EV = +2.71` 筹码，最终动作却是 **FOLD**，
并输出 `DECISION_CONSISTENCY_ERROR [ACTION_CONTRADICTS_CHIP_EV]`。

**结论（`reports/P1_99_CALL_FOLD_CONSISTENCY_AUDIT.md`）**：**确认缺陷**，属**决策层判据标尺不一致**：

- `callEV` 用**对手下注范围权益**（32.906%，`contextBuilder.ts:585`）；
- 而 FOLD 硬判的第二条件 `verdictEdge < -MARGINAL_EV_GAP_RATIO`（`decisionEngine.ts:1816`）
  用的是**整体/到达范围权益差**（`edge = 21.546% − 28.986% = −7.44pp`，`:1496` → `:1738`）；
- 代码在 `:1729` 声明的恒等式「单层时 `edge = callEV / winnable`」在本节点被打破 **11.36 个百分点**
  （`callEV/winnable = +3.92%` vs `edge = −7.44%`）⇒ **正值 CALL EV 被另一把尺子判成「数学明显不划算」**；
- 与加注门槛那处已修的口径缺陷（`:1507` 改成 `raiseEquityRaw = heroEquityVsBetRange ?? equity`）同类，**CALL/FOLD 硬判未同步**。

**边界**：缺陷位于**已推送基线 `3899189`** 内（用 `git archive HEAD` 导出的原样代码树逐位复现），
与未提交的 TEST 18 金额口径修复**无关**；TEST 17 的展示修复只是把它**暴露**成可见的自相矛盾文案。
**一致性告警是正确的**（依据分类器本身返回 `CHIP_EV`，其说明写着「CALL 更高」）。
**影响面**：扫描 75 局面中 **15 例**命中（全部为「中对 / 边缘摊牌价值」牌面），方向单向（只会弃掉本该跟的牌）。
**待授权**：最小修复 = 硬判标尺与 `callEV` 同源（保留 layeredEdge / layeredEquity 优先级与全部阈值）+
带内文案改说「无差别带内取代价最小方向」+ 新增 6 条失败测试（P1-1…P1-6）+ 全量 verify 与指定回归。

### 10.0.21 P1 · CALL/FOLD 裁决标尺最小修复（2026-09，**已实施，未提交**）

**授权**：§10.0.20 的缺陷修复（"本轮只修复 CALL/FOLD 决策依据不一致"）。
**检查点**：`%TEMP%\dezhou-checkpoint-p1fix-20260920-102512`（675 文件 + sha256，逐位 0 差异）。

**生产改动（1 个文件，1 处表达式 + 1 处文案）**：

- `src/app/decision/decisionEngine.ts` 新增 `singleLayerEdge`：**单层**（`layeredEV` 缺失且
  `requiredEquityApplies === true`）且 `callEV` 有限、`winnable` 有限为正时，
  `verdictEdge = callEV / winnable`（与 `edge` 的既有定义式同源，**不重复估计权益**）；
  否则保持原回退（`edge` / `layeredEquity ⇒ null`），**绝不用除法伪造裁决边际**。
  `MATH_EV_EPSILON` / `MARGINAL_EV_GAP_RATIO` / 容差带 / CALL EV 公式 / FOLD 零点 **均未改动**。
- 同分支文案：`MATH_FOLD_DOMINANT` 现在报**判据实际使用的标尺**（CALL EV 可得时 = 下注范围权益；
  不可得时 = 整体范围权益），消除「32.9% 低于 29.0%」这类自相矛盾句。

**原始 99 节点（修复后，生产链自选）**：`CALL EV = +2.705235410024` ｜ **最终动作 `CALL 20`**
（理由 `MATH_CALL_SUPPORTED`：「对手下注范围权益 32.9% 高于跟注所需 29.0% … 差距在模型容差带 ±3.45 内
⇒ 置信度偏低，但 EV 排名不变」）｜ `consistency.ok = true` ｜ 用户可见 warnings = 空 ｜ 分类仍是 `MARGINAL`。

**影响面（125 局面扫描，5 节点形状 × 5 画像 × 5 统计形态）**：动作变化 **15 例**，全部是
「转牌·面对领打（99）」这一节点，**FOLD → CALL 20**；`ACTION_CONTRADICTS_CHIP_EV` 由 **15 例降为 0 例**；
其余 **110 例逐位不变**（含 A♣J♣ 转牌、A♠A♥ 河牌、K♣Q♣ 翻牌、无人下注节点）。多人边池与分层 EV 路径未触碰。

**新增测试**：`test/callFoldVerdictRuler.test.ts`（**11 项**，A/B/C·D/E·F/H·J/I/K/L/M/N；修复前 4 项失败、
修复后 11/11）。

### 10.0.22 PREFLOP P0 · F2「一对牌全下」保护的街道适用范围（2026-09，**已实施，未提交**）

**授权**：§10.0.21 之后由使用者正式授权的 F2 修复（"翻前节点错误使用翻后牌型类别保护，导致 AA 等强牌的合法全下加注被拦截"）；**不得**改 F1 的开池范围构建、**不得**新增 Solver / 扩 GTO 范围表 / 调画像参数。
**检查点**：`%TEMP%\dezhou-checkpoint-preF2-20260920-121657`（689 文件 + `FILES.sha256.txt`，逐位校验 0 差异）。

**根因（审计 §四 F2）**：`shouldRaise` 与 `allInGuardVerdictOf` 的两条保护都以**成手牌类别**为判据
（`handCategory < MIN_CATEGORY_FOR_LARGE_RAISE = 3`），而翻前 `handCategory ≡ 0`
（`contextBuilder.ts` 是 `described?.category ?? 0`，翻前 `described === null`）——
于是「一对牌打光」的保护在翻前被无条件套用，**所有**翻前全下加注（短码推注 / 4bet 全下）被判违规。
实测：BB 5BB 持 A♠A♥ 面对开池 3BB，唯一加注 = 全下 10 ⇒ 被拦 ⇒ 只能 `CALL 4`（身后剩 2BB）。

**生产改动（2 个文件，均为**街道适用条件**，未删规则、未调阈值）**：

- `src/app/decision/decisionEngine.ts`：`allInGuardVerdictOf` 新增可选 `street`，`PREFLOP` ⇒
  该保护**按街道不适用**并给出如实说明；`shouldRaise` 的**保护①**（全下必须有自有 EV）加同一街道条件
  （`streetApplies = options.street === undefined || options.street !== Street.PREFLOP`）。
  **保护②（`MAX_RAISE_TO_POT_RATIO = 2.5` 底池比例档）对所有街道一字未动**；
  `qualifies`（起手牌档位 MONSTER/STRONG + 权益优势）、`RAISE_EDGE_*`、`MIN_CATEGORY_FOR_LARGE_RAISE`、
  `desiredTo`、尺寸网格倍数档、`isoRaiseSizeOf` **全部未动**。缺省 `street`（不传）保持既有语义 ⇒ 向后兼容。
- 两个调用点（决策 + 诊断）**传同一个 `math.street`**（M2：不得两处口径）；诊断 `allInGuard` 增加
  `street` 字段（`src/domain/decision/decision.types.ts` 的**类型**同步，纯类型、零行为）。

**修复前失败证据（先写测试，4 项失败 / 7 项通过）**：
`A·5BB AA：onePairAllInBlocked 期望 false 实际 true`、`A·5BB AA：heuristicScore 期望 >0 实际 0`、
`M9：3–25BB 扫描中 5–8BB 同样被拦`、`街道矩阵：PREFLOP 期望不适用实际 true`。

**影响面（133 节点指纹，修复前检查点 vs 工作区）**：**最终动作变化 = 0**；
97 节点仅多出新增的 `street` 字段、其余逐字一致；36 节点发生实质变化，**全部**集中在
`BB 5/6/7/8BB 面对 3BB 开池`这一族：
`blocked: true → false`，其中 24 例（AA/KK/AKs/AKo/QQ/TT × 4 深度）`heuristicScore 0 → >0`
并如实标注 `overrideAttempt = RAISE_HEURISTIC`、
`overrideBlockedReason = CANNOT_OVERRIDE_CLEAR_SUPPORTED_CALL_WITH_UNEVALUATED_ALL_IN`；
另 12 例（55/JTs/A5s）**只翻转保护判定、仍拿不到加注准入**（M1：保护没有被无条件取消）。
翻后节点（含**多人池一对牌 + 全下**这一真实触发点）除新字段外**逐字不变**（M5）。

**残留（须使用者决策，本轮未动）**：翻前全下仍**不会成为最终动作** —— 它没有自有 EV，
而既有证据纪律规定「打光筹码且没有 EV 的启发式加注不得覆盖清晰的 CALL 证据」
（`evidencePriority.ts:392-399`）。要让短码推注真正可达，需要为翻前全下建立**自有 EV 模型**（属新增模型，本轮明确禁止）。
另：保护②（底池比例档）以 `handCategory < 3` 为前提，翻前恒成立，因此**大额非全下加注**仍受该档约束 —— 同一根因的
第二处实例，需单独授权。

**新增测试**：`test/preflopAllInGuard.test.ts`（**11 项**，修复前 4 项失败 → 修复后 11/11）。
**审计报告**：`reports/PREFLOP_DECISION_PATH_AUDIT_V1.md`（F1–F8 + 墨菲 M1–M9）。

### 10.0.23 CB-5 · 河牌「打光筹码」容差带护栏（2026-09，**已实施，未提交**）

**授权**：`reports/FLOP_RIVER_THEORY_EXPLOIT_AUDIT_V1.md` §八 第①项（CB-1 + CB-5 同源，本轮只做 CB-5 的决策护栏；CB-1 的模型侧约束**未**实施）。
**检查点**：`%TEMP%\dezhou-checkpoint-f2ac-20260920-131436`（719 文件 + sha256，逐位 0 差异）。

**缺陷**：河牌面对下注时，**消耗 Hero 全部剩余筹码**的加注只要 EV 比最佳备选高一丁点就在跨动作比较中胜出 ——
实测（A♠K♠｜K♦9♣4♥6♠2♦，`analyzeManualHand`）：`RAISE(MODEL_EV) 48.48 vs CALL(PROXY_EV) 45.33`（差 3.15／带 ±10.95）、
`RAISE 42.956 vs CALL 42.924`（差 **0.03**／带 ±9.55）、AK 河牌黄金节点 NORMAL 画像（差 **0.09**／带 ±6.65）
—— 而引擎自己在 `decisionMargin.noteZh` 写着「容差带是**工程容差**……也不自动翻转动作」，却在这里授权了不可逆的全下。

**生产改动（2 个文件）**：

- `src/domain/decision/evidencePriority.ts`：`chooseByEvidencePriority` 新增可选输入 `stackCommitmentGuardApplies`
  与输出字段 `stackCommitmentGuard`；在**跨动作量化 EV 比较**路径中新增护栏：当
  `best.commitsStack === true`、存在**不消耗筹码**的次优候选、两条 EV 均有限、且 `0 ≤ EV_stack − EV_alternative ≤ 容差带`
  ⇒ 选该备选动作，并带上完整诊断（被拦截动作 / 备选 / 两条 EV / 差 / 带 / 两个估计类型 / 可读原因）。
  **`ev === null` 的候选不在 `quantified` 里 ⇒ 结构上不可能被当成 0 触发本护栏。**
- `src/app/decision/decisionEngine.ts`：调用点传 `stackCommitmentGuardApplies: math.street === Street.RIVER && callCandidate !== null`
  （判据只有一处）；`decisionSource` 如实带出护栏字段；CALL 胜出分支在护栏触发时改用新原因码
  **`STACK_COMMITMENT_MARGIN_GUARD`**，**不再**输出「跟注更高」这类与事实不符的文案。
- **未改**：任何 EV 公式、条件范围构造、下注响应概率、画像融合、策略参数与容差带常量
  （`MARGINAL_EV_GAP_RATIO` / `MODEL_UNCERTAINTY_RATIO` / `RAISE_EDGE_*` / `MAX_RAISE_TO_POT_RATIO` / `MIN_CATEGORY_FOR_LARGE_RAISE` 全部未动）；
  普通（非全下）加注规则与翻前 / 翻牌 / 转牌策略未动。

**验收**：新增 `test/riverStackCommitmentMarginGuard.test.ts`（10 项，修复前 **5 项失败** → 修复后 10/10）。
**影响面（同一 124 个「节点 × 画像」输入，修复前 vs 修复后逐行 diff）**：**恰好 5 个节点**变化，
全部是「一对牌面对大注／超池」的河牌节点，动作 `全下 → 跟注`（R-05 NORMAL/MANIAC、R-05b NORMAL/MANIAC、AK 河牌 NORMAL）；
且**只有** `action` / `evidenceScope` / `consumesStack` / 新增护栏字段四类变化 ——
**FOLD/CALL/RAISE 的 EV、条件权益、响应概率、容差带数值一律未变**。
133 节点指纹与 125 局面扫描：**0 差异**。既有测试（P1 / V2 / U1 / P0-7 / F2 / TEST 16·17·18）无一因本修复改变。

### 10.0.24 STREET STATE CONSISTENCY V2 · 街道状态一致性（2026-09，**已实施，未提交**）

**授权**：使用者报告「Hero 未完成转牌行动，却提前进入河牌」后的 V2 实施授权（含 §一~§七 全部补充约束）。
**检查点**：`%TEMP%\dezhou-checkpoint-f2ac-20260920-131436`（719 文件 + sha256，逐位 0 差异）。
**审计**：`reports/STREET_STATE_CONSISTENCY_AUDIT_V1.md`（§7.1 既有契约逐条复审 / §7.2 操作准入规则表 / §7.3 测试规格）。

**根因（与直觉相反，已用探针逐项证实）**：引擎的**权威街道只由行动重放决定** ——
`advanceStreet` 是唯一改写 `street` / 发牌的地方（`STREET_NOT_COMPLETE` 守卫），
`applyAction` 只置 `bettingRoundComplete`，`settleCanonicalStreet` 在行动补齐后按牌面能否推进决定是否换街；
而 `SET_BOARD_CARD` **只是数据录入，不推进任何阶段**。
因此「提前进入河牌」**不是**引擎被推进了，而是**预览与管线口径不一致**：
公共牌录到 5 张、转牌行动未完成时，`buildTablePreview` 仍报 `ready=true / READY`，
而 `analyzeManualHand` 随即以 `HISTORY_DOES_NOT_REACH_STREET`（`stage=RECONSTRUCT`）拒绝 ⇒
**界面承诺了它给不出的东西**（先录牌后补行动是**已锁定的契约**，`test/state.test.ts:395`「录牌不推进街道」）。

**生产改动（1 个文件，最小化）**：`src/app/table/tablePreview.ts` 新增**预览一致性闸门**（§7.2 规则 D）：
当 ① 已录公共牌所属街**晚于**引擎真实街 ② **轮到 Hero 本人**行动 ③ 当前街已有行动且**尚未结算** ④ 本手未结束
⇒ 预览 `decision.ready = false`、`state = ERROR`、`reasonCode = STATE_INVALID`、`canAnalyze = false`，
并给出中文提示（点明「河牌已录入、缺的是转牌行动、轮到谁、可撤销第 N 张」），**同时原样保留已录入的牌**。
- **未**在 `SET_BOARD_CARD` 上加任何准入门槛 ⇒ 「先录公共牌、后补录历史行动」（**含 Hero 本人行动**）能力完整保留；
  **未**新增操作类型（行动路径本已由引擎闸门推进街道，新增 `ADVANCE_STREET` 无必要性，已按要求先证必要性后放弃）；
  **未**用 `actorOnTurn` 反推用户意图（判据是「街 + 是否轮到 Hero + 是否已结算」的组合状态，不是单一动作字段）；
  **未**改 EV / 条件范围 / 牌型强度 / 画像 / 利用性调整 / 引擎与重建逻辑（`tableOps.ts` / `tableAdapter.ts` / `reconstruct.ts` **零改动**）。
- **V1 教训（已撤回并如实记录）**：上一轮曾在 `SET_BOARD_CARD` 上加闸门，导致 `§D-4` / `§E-3` / `§E-4` / `AUTO-3`
  四项既有契约失败 ⇒ 全量回滚（三个文件逐位还原为 `HEAD`、删除新增测试），本轮改为**只修预览口径**。

**验收（全部实测执行）**：新增 `test/streetStateConsistencyV2.test.ts`（12 项）——
**修复前失败 2 项（§C-1 / §C-2）→ 修复后 12/12 通过**（已保存修复前失败证据）；
全量回归 **2,084 项 / 2,084 通过 / 0 失败**（先前被 V1 打破的 `§D-4`/`§E-3`/`§E-4`/`AUTO-3` 均在内）。
A 不提前推进街道 ✔；B 先录牌后补行动（含 Hero）✔；C 预览不再把未来街说成可正式分析 ✔；
D 合法局面不倒退为 RECONSTRUCT/ERROR ✔；E 未来信息隔离（预录第 5 张牌对转牌权益/EV **逐位零影响**，
且未完成转牌行动时**不存在**合法河牌决策节点）✔；F 既有断言**未做任何修改或放宽** ✔。

### 10.0.25 RIVER DECISION CONSISTENCY · 河牌全下 / 下注动作一致性（2026-09，**已实施，未提交**）

**授权**：使用者报告「最终建议『下注 55BB』而内部最高 EV 是 ALL_IN，并出现
`DECISION_CONSISTENCY_ERROR` / `ACTION_CONTRADICTS_PREFERENCE`」后的专项审计与最小修复授权。

**根因（已用生产入口逐项复现）**：同一个**实际动作**在本项目有**两套命名** ——
候选尺寸表/偏好分表用**尺寸档位**（`BET_SMALL` / `ALL_IN`），最终动作用**动作类型**（`BET`）。
河牌 Hero 剩 55BB、下注 55BB（= 全部剩余筹码）时：`actionShape = { kind:'BET', sizeChips:2750,
allInToAmount:2750, consumesStack:true }`、`betDecision.bestSize = 'ALL_IN'`（0.62）——
**动作与候选是同一次下注**，但一致性校验按**名字**比较（`familyOf('BET') = 'BET' ≠ 'ALL_IN'`）
⇒ 误报 `ACTION_CONTRADICTS_PREFERENCE`；界面据 `actionShape.kind === 'BET'` 显示「建议下注」
（`isAllInRaise` 只认 `RAISE_TO_ALL_IN` / `DIRECT_ALL_IN`）⇒ 看起来与内部候选自相矛盾。

**生产改动（3 个文件，判据只有一处：既有 `consumesStackForAction`）**：
- `src/domain/decision/decisionConsistency.ts`：`ConsistencyInput` 新增可选
  `actionEffectiveFamily`（实际家族），偏好分分支改为 `input.actionEffectiveFamily ?? familyOf(action)`；
  **不传时判据逐位不变**（不放宽校验）。
- `src/app/decision/decisionEngine.ts`：调用点传 `actionEffectiveFamily: consumesStackForAction ? 'ALL_IN' : null`
  （`consumesStackForAction = |finalSizeChips − allInToAmount| < ALL_IN_COMPARE_EPSILON`，本轮**未新增**任何判据）。
- `src/viewmodels/decisionViewModel.ts`：`isAllInRaise` 增加「`BET` 且 `actionShape.consumesStack === true`」⇒
  文案写「建议全下 …（本注即全下）」。**动作类型、金额口径（BET = 本街累计）、底池、EV 一律未改。**
- **未改**：EV 公式、条件范围、尺寸网格、对手响应模型、GTO / 画像 / 剥削模型、
  台账候选表与证据表（`ACTION_CONTRADICTS_PREFERENCE` 的报错能力**保留**：真正小于全下额的下注仍报错）。

**验收**：新增 `test/riverBetAllInConsistency.test.ts`（10 项）——
**修复前失败 5 项（§1/§2/§4/§7/§8）→ 修复后 10/10 通过**（已保存修复前失败证据）。

### 10.0.26 DECISION BASIS CONSISTENCY V1 · EV 比较与偏好评分专项审计（2026-09，**只读，未修**）

**授权**：RIVER DECISION CONSISTENCY V1 之后，使用者要求确认 `ACTION_EV_COMPARISON` 与 `PREFERENCE_SCORE`
是否属于不同决策依据、是否可能对同一合法动作集合产生不一致排序（**只读审计优先，未经根因确认不得改生产代码**）。

**审计结论（两探针实跑：`scripts/audit-decision-basis-v1.ts` 45 节点 + 公式边界；`…-v2.ts` 24 栈深 + 30 组合搜索）**：
- **不存在动作选择冲突**：`normalizeEVScore = clamp01(0.5 + 0.5×(EV − checkEV)/pot)`（`betResponse.ts:2235`）是 EV 的
  **保序重标度**（过牌固定 0.5）⇒ 45/45 节点 `argmax(EV) == argmax(score)`；唯一例外是**钳位饱和**
  （`ΔEV ≥ pot ⇒ score=1`），实测最大 `ΔEV/pot = 0.281`（边界 1.0）⇒ **场景 B 在当前模型空间不可达**。
- **不存在重复计算 / EV 口径混用**：同额候选在比较前**按合法金额去重**（24 栈深中 13 次封顶去重，
  `droppedSizes` 留痕「封顶后与另一个候选金额相同（已去重）」）；45 节点 `evKinds` 全为单一 `SINGLE_OPPONENT_MODEL_EV`。
- **校验基准正确**：一致性校验用**同一份偏好分表**（`postflopAdvice.scores`，按家族取最大）作基准，非用标签名。
- **两项披露缺口（未修，等授权）**：① 同一决策两个依据名（引擎传 `byBetDecisionModel` ⇒ `ACTION_EV_COMPARISON`；
  校验未传 ⇒ 自算 `PREFERENCE_SCORE`）—— 一处事实、两处标注；② 弱牌局面 `bestSize = BET_SMALL` 而建议是 CHECK 时，
  文案仍写「最佳 = BET_SMALL」（指**下注族**最佳尺寸，易被读成最终建议）。
- **画像与剥削（F/G）**：画像经**响应概率**进入 EV（实测改变 0.3%～4%，排序未变），**不是**加在 EV 上的惩罚；
  无观测历史时 `player.confidence = 0.35 / samples = 0 / range.confidence = 0.3` ⇒ 基础范围 + 低置信度如实披露。

**本轮改动**：**无生产代码改动、无新增测试、未提交、未推送**；新增未跟踪探针 2 个与本报告
`reports/DECISION_BASIS_CONSISTENCY_V1.md`。建议方案 P1（统一依据名）/ P2（文案澄清）/ P3（钳位同分取更高 EV）
已写入报告 `PROPOSED_FIX_IF_NEEDED`，**待下一轮授权后实施**。

### 10.0.27 PLAYER PROFILE EXPLOIT VALIDATION V1 · 真实人物画像与决策链路（2026-09，**只读，未修**）

**授权**：DECISION BASIS CONSISTENCY V1 之后，验证「真实玩家历史行为能否改变对手模型并影响 Hero 决策」；
先只读审计 + 生产入口实测，**不得改生产代码、不得硬编码画像→动作、不得为制造差异篡改 EV**。

**固定牌局（16 场景逐位相同）**：9 人桌 · Hero BTN · A♠K♠ · `Jh 8s Qs Kh Kd` · 河牌 CO 过牌 ⇒
pot 4875（97.5BB）· Hero 剩 2750（55BB）· callCost 0。
**探针**：`scripts/audit-player-profile-exploit-v1.ts`（16 场景 + 10 项反证）、
`scripts/audit-player-profile-sensitivity-v1.ts`（22 个单变量变体）。

**结论（分类如实）**：
- **VERIFIED**：身份路由（改名不变 ✔、新玩家隔离 ✔、按持久 id 复现 ✔）；`villain.observedStats` 通道可直达响应模型
  （`manualInput.ts:283` → `alphaPipeline.ts:1079` → `contextBuilder.ts:3796`）；`foldToRiverBet ↑ ⇒ 弃牌率 ↑`、
  `riverCheckRaise ↑ ⇒ 加注率 ↑/跟注率 ↓`（方向正确）；**样本量收缩正确**（n=1 影响 0.0049 vs n=100000 影响 0.0611）；
  实测证据**覆盖**主观标签（标签 VERY_TIGHT 全下弃 0.1974 → 实测极松 0.0412）；EV 真实变化（ALL_IN EV 极差 452.5 筹码）；
  RDC V1 与一致性校验未受影响（16/16 `consumesStack=true`、`consistency.ok=true`）。
- **PARTIAL**：响应概率仅 **2/11** 项统计在本节点有效（`vpip/pfr/threeBet/wtsd/foldTo*Cbet/flop|turnCheckRaise` 零影响，
  与 `observedStats.ts:437-458` 自述一致：「主动下注频率没有输入通道」）；**实测统计不改变对手范围**
  （范围指纹 `HEURISTIC|sup=334|share=0.2519|metrics#31104` 在全部实测变体中逐位相同，只有标签路径变成 `#911528`）。
- **NOT_IMPLEMENTED**：应用层无「每手记录 → 画像持久化 → 重新上桌读取」——`src/app` 无任何画像写盘/读取
  （只有静态页读取、GTO 缓存、决策日志）；`src/app/table/*` 对 `observedStats` 零引用；
  `table.js` 仅有 `SET_PROFILE{quickProfile}`（无 observedStats/behaviorProfile/persistentPlayerId 入口）；
  `behaviorProfile`/`villainProfile`/`seatProfiles` 无生产调用者。
- **FAILED（可复现披露缺陷）**：实测统计被响应模型消费，但玩家快照仍报 `handsObserved=0 / confidence=0.5 /
  neutralized=true`、note 写「没有该玩家的实测数据」，界面「实测手数」显示 0（`decisionViewModel.ts:713`）。
- **动作差异**：16 场景最终动作签名**全部相同**（`BET@2750` = 全下）——经判定为**合理稳定结果**：
  全下 EV 比过牌高 900～1350 筹码，远超容差带 243.75 ⇒ 不在翻面区间（非「画像未进入决策」）。

**本轮改动**：**无生产代码改动、无新增测试、未提交、未推送**；新增未跟踪探针 2 个与本报告
`reports/PLAYER_PROFILE_EXPLOIT_VALIDATION_V1.md`。最小开发方案（记录持久化 / 注入 / 披露修复 / 回归）见报告，
**待下一轮授权**。

### 10.0.28 PLAYER PROFILE EXPLOIT V1 · 真实历史持久化与决策链路（2026-09，**已实施，未提交**）

**授权**：§10.0.27 只读审计的结论（模型侧已具备、产品侧断链）之后，实施原报告最小方案 ①②③⑥：
每手行为记录持久化 / 真实历史读取与注入 / 披露修复 / 完整回归。

**新增与改动（生产 8 个文件）**：
- **新增 `src/app/table/playerHistory.ts`**：`<historyDir>/player-history.jsonl` 只追加存储（默认 `data/`）；
  记录字段 = handId / playerId / seatId / 街 / 行动类型 / 金额 / `facedBet` / `toCallBB` / `seq` /
  `baseRevision` / **`historyLength`**（撤销回退判据）/ `source` / **`saved`** / `handComplete`；
  去重键 = `handId|playerId|baseRevision|street|actionType|amountBB`；**写入失败返回 `saved:false` + 显式错误**，
  文件损坏 ⇒ `HISTORY_CORRUPT` 并**拒绝使用**（不注入任何统计）。
  统计只产出模型**真正支持**的 2 项（`foldToRiverBet` / `riverCheckRaise`），**机会数为 0 的项不写出**（未观察 ≠ 0%）。
- `table.types.ts`：`TablePlayer.observedStats` / `observedStatsNoteZh`；`ADD_PLAYER` 增可选 `playerId` / `displayName`
  （**不传则与既有行为逐位一致**）。
- `seatLifecycle.addPlayer` 支持显式身份（复用同一 `playerId` ⇒ 重新上桌可继承历史；同名**不合并**）；
  `tableOps` 透传该身份；`tableApi` 作为**生产入口**接上 `applyUserOpWithHistory`（+ `historyDir` 依赖）
  并把历史层问题随成功响应返回。
- `tableAdapter.ts`：把该座位的真实统计注入 `ManualVillain.observedStats`。
- `contextBuilder.ts` + `decision.types.ts` + `decisionViewModel.ts`：**披露修复** —— 玩家快照带
  `measuredStats{handsObserved, usedStatKeys, noteZh}`，「实测手数」显示真实值并说明**哪几项真的进了模型**、
  哪些项**没有通道**（**不改任何数值**：confidence / adjustment / 决策数学一律未动）。

**实测结论（`test/playerProfileExploitV1.test.ts` 15 项全绿；全量 2,109 项）**：
真实行动 → 落盘 → 重开可读 → 按 `playerId` 重新上桌绑定 → 注入决策 → 响应概率随统计项按公式变化；
**样本不足被强收缩**（2 手影响 0.0054 vs 10 万手 0.0046 的对照组按 3× 门槛断言）；
**未接通项不得标记为有效**（K）；**读取失败不得伪装成功**（L）。
**尚未接通（如实）**：对手**范围**仍只由标签/行动历史决定（实测统计只进响应层）；
11 项统计中仅 2 项有输入通道；**浏览器端到端（页面点击）未验证**；前端仍无「选人入座」入口
（通道已就绪：`ADD_PLAYER{playerId}`）。

### 10.0.29 PLAYER PROFILE TABLE UI V1 · 人物画像前端接入与浏览器验收（2026-09，**已实施，未提交**）

**授权**：§10.0.28 完成后，让使用者**在牌桌页面上**选择历史玩家、查看画像、记录行动，并在之后牌局复用其历史资料。

**生产改动（复用现有组件，未新建页面）**：
- `webServer.ts`：新增只读端点 **`GET /api/table/players?q=`**（真实历史名册：名称 / 稳定 id / 手数 /
  两项统计的**成功数与有效机会数** / 已接通项 / 未接通项 / 实测可信度）；历史损坏 ⇒ `ok:false` + `HISTORY_CORRUPT`。
- `playerHistory.ts`：记录新增 `displayName`（仅供查找与展示，**身份只认 playerId**）；
  新增 `listKnownPlayers`（搜索、同名 `duplicateName` 标记、机会为 0 ⇒ `null`）与 `MEASURED_CONFIDENCE_K`；
  `defaultHistoryDir()` 支持 `DSH_PLAYER_HISTORY_DIR` 环境变量（浏览器验收隔离目录，**不污染 `data/`**）。
- `table.js`：座位点击菜单新增「**选择历史玩家…**」（搜索 / 按身份入座 / 新建玩家`displayName`）；
出租 `<空/占用>` 两分支；**悬停提示**（名称 / 标签先验 / 手数 / 置信度 / 两项统计的成功与机会数 /
已接通与未接通）；座位菜单内**真实历史抽屉**（明确区分真实观测 / 标签先验 / 未接通）；
座位元素暴露 `data-player-id` / `data-seat-id` 供验收断言；`index.html` + `table.css` 新增 `.seatTip`
（**`pointer-events:none` ⇒ 永不遮挡公共牌 / 底池 / 行动按钮**）。

**浏览器验收（真实 Chrome + DevTools Protocol，零新增依赖）**：`scripts/browser-e2e-player-picker.ts`
—— **16/16 全部通过**（页面加载 / 空位选人 / 打开弹窗 / 搜索到已保存玩家并显示 1/1 次机会（不显示 0%）/
已接通与未接通区分 / 重新选择并恢复绑定 / 新建同名玩家（新身份）/ 同名不混淆（页面标注 + 名册两条独立身份）/
**浏览器内点「弃牌」⇒ 真实行动落盘（名册新增 p1:1）** / 重启服务 + 刷新后历史仍在 / 换座位绑定不变 /
抽屉如实展示 / 实测数据披露 / **隔离目录未污染仓库 `data/`**）。
交互方式如实说明：通过 CDP 在页面内触发真实 DOM 事件（`element.click()`），页面代码、fetch 与服务端都是真的，
**不使用 OS 级鼠标合成**。

**未做 / 未验证**：前端「同名消歧的选择器 UI」目前是「列表并列 + 标注同名」（未做二次确认弹窗）；
对手范围层仍未接入实测统计；浏览器验收未覆盖多人池与跨街统计。

### 10.0.30 🔴 PREFLOP RAISE DECISION · 阶段 A + B（2026-09-21，**已实施，未提交**）

> 报告：`reports/PREFLOP_RAISE_DECISION_V1.md`（11 节）
> 证据：`reports/evidence/preflop-raise-sensitivity.txt`（由 `scripts/rr-sensitivity.ts` 生成）
> 基线探针：`scripts/rr-audit-baseline.ts`
> 测试：`test/preflopRaiseDecision.test.ts`（20 项）+ `test/preflopRaiseE2E.test.ts`（10 项）

**这一轮真正改变了什么**（一句话）：**翻前的加注第一次拥有了它自己的、
可独立复算的筹码 EV** —— 此前 `RAISE_EV_NOT_IMPLEMENTED` 覆盖**每一个**翻前加注金额。

| 项 | 改动前（基线 `20c71a6` 实测） | 改动后 |
|---|---|---|
| BB AA 面对 BTN 开池 2.5BB | 建议 `RAISE 7.5BB`（启发式 `STRATEGIC_RAISE_FOR_VALUE`），**7 个尺寸的 EV 全部为 `null`** | 建议 `RAISE`（模型 EV 最高者）；逐尺寸 EV：4BB +438.0 / 7.5BB +463.1 / 100BB **+955.2**（CALL +313.09） |
| `unevaluatedActions` | 列出**每一个**加注金额（`RAISE_EV_NOT_IMPLEMENTED`） | 只列**真的**没有 EV 的金额（本节点为空） |
| 加注的 `EstimateType` | `HEURISTIC` | `MODEL_EV`（参与跨动作 EV 比较） |
| 尺寸选择规则 | `pot + 2×跟注额` 最近者（**只算一个尺寸**） | **EV 最高**的合法尺寸（每个尺寸各有自己的响应概率与条件范围） |
| 76s / Q9o | `CALL`（启发式：MEDIUM 档不能加注） | `RAISE 7.5BB`（EV 真的更高：+316.2 / +329.5 vs CALL +72.5 / +100.5） |
| 全下 | 无概念 | 唯一新增保护：最高 EV 是全下、优势落在模型容差带内、**且存在非全下备选** ⇒ 改选非全下 + 显式 `PREFLOP_ALL_IN_UNCERTAINTY_PROTECTION` 披露 |

**新增模块**：`src/app/manualInput/preflopRaiseResponse.ts`（响应模型：强度阶梯 + 继续门槛 + 4Bet 桶）、
`src/app/manualInput/preflopRaiseFacts.ts`（逐尺寸事实包）。现金流**调用** U1 建立的
`raiseResponse.raiseEVOf`（全项目唯一加注 EV 公式），**没有**第二套。

**阶段 A 的结论**：使用者点名的 `2.5 → 10 → 22 ⇒ 最小再加注 34BB、32BB 非法`
在基线 HEAD 上**已经正确**（由 `test/preflopFiveBetMinRaise.test.ts` 16 项锁定），
阶段 A 未发现需要修的生产缺陷；期间修掉了**两处测试自身**的口径缺陷
（`alphaSmokeSpots` 拿 `sizeChips`（本街累计）与 `myRemainingStack`（增量）比大小；
「加注 ≤ 2.5 倍底池」检查未限街道）。

**明确不支持**（拒绝 + 说明原因，**绝不**静默按单挑算）：

| 场景 | 行为 |
|---|---|
| 多人池（活跃对手 > 1） | `NOT_HEADS_UP` + warnings |
| 身后还有人未行动 | `PLAYERS_BEHIND` + warnings |
| **Hero 的再加注（5Bet）** | **未展开**；被再加注分支只比较 FOLD / CALL，`heroFiveBetExpanded = false` 逐尺寸披露 |
| 翻后加注 / 再加注的有限树 | **未做**（阶段 C） |
| 抽水 | `rakeStatus = 'NOT_APPLIED'` |

**一条被测试发现的真实建模约束**：翻前行动顺序是 `UTG → HJ → CO → BTN → SB → BB`，
因此「单挑 + 身后无人未行动」的翻前节点**只可能出现在大盲位**。
`Hero SB 面对 BTN 开池` 时 BB 还没说话 ⇒ 本模型**拒绝**（`E2E-05` / `E2E-05b` 锁成测试）。

**分级结论**（**不同完成程度必须分开报告**）：

| 完成程度 | 状态 |
|---|---|
| 有一个合法按钮 | ✅ 是（网格每一项都能被真实引擎接受） |
| 有一条启发式建议 | ✅ 是，但**减少了** —— 翻前加注改走 EV |
| 有可比较的模型 EV | ✅ 是（同零点、同单位、可独立复算，`B-04` 逐项重算比对） |
| **经过校准** | ❌ **不是**（结构性先验，未校准；本项目没有翻前频率数据，也不编造） |
| **经过实战验证** | ❌ **不是**（从未用真实牌局核对） |

**三类误差必须分列**：① 权益采样误差（6,000 次 MC，可给 95% 半宽）；
② 响应概率的模型误差（**未知**，不给区间）；③ 未来街近似误差
（非全下分支按「后续街不再下注」计算；全下分支无误差）。
⚠️ 抽样置信区间**不能**代表整个策略模型的可靠性。

**契约变更**（5 个既有测试文件，逐条理由见报告 §5）：
`preflopAllInGuard`（F2-1 / F2-3 / M1 / M10 的断言理由原文写着「翻前没有 3bet/4bet 响应模型」，
该事实已被阶段 B 改变 ⇒ 改成锁**更强**的性质）、
`riverStackCommitmentMarginGuard`（CB5-08 由写死尺寸改为锁主题）、
`riverRaiseDecisionV2`（V2-5 增加 `RAISE_MODEL_EV` 路径的披露契约）、
`alphaSmokeSpots`（测试自身的口径缺陷）、
`gtoScenarioIsolation`（GTO-SCN-16 的 `/preflop/` 裸词判据误报 ——
改为「所有请求地址必须是同源相对路径」，比原判据**更强**且不再误伤标识符）。

**界面（诊断区）**：`decisionViewModel.debug.preflopRaise` 现在给出逐尺寸的
EV / 响应概率 / 条件权益 / 资金口径 / 被再加注分支 / 未支持项 / 模型假设，
并在牌桌页面的调试区显示（`table.js` 的 `debugDecision.preflopRaise`）。
`E2E-10` / `E2E-11` 把它锁成测试。

**全量验收**：`npm run verify` = 类型检查零错误 + `manifest:check` 169 个产物一致 +
**2,177 项测试全绿**（138 套件 / 115 个文件）。

### 10.1 测试基准的历史教训**测试数量不是产品进度。** 1,242 项测试不代表「软件完成 100%」。它代表的是：**已经写下的东西有保障**，而不是**该写的东西已经写完**。

本项目的七轮红队共发现 **50+ 项** CRITICAL/MAJOR 缺陷，全部发生在测试全绿的情况下 ——
**测试能防回归，但不能证明产品可用。**

### 10.1.1 Alpha 独立红队的两个结构性教训（比具体缺陷更重要）

**教训一：注释里的承诺不算承诺，只有代码里的行为算。**

`decisionEngine.ts` 的 `MULTIWAY_REFUSE_THRESHOLD` 注释写着
「有 2 个对手时 `checkSufficiency` 会要求范围可信度**更高**才给建议，
并在诊断里注明当前是近似处理」—— 而代码里**这两件事一件都没有**（红队 F-06）。
界面文案也照着这条注释写，于是使用者以为多人池会被拒绝，
实际却拿到了一个基于单挑权益、且忽略第二名对手行动的建议。

**教训二：自检函数没有调用者 = 没有自检。**

`selfCheckLikelihoodModel` 写得很完整，`tierOfRankClassIndex` 造成的牌力倒挂
（`QQ` 的进攻似然 0.5938 **低于** `A7s` 的 0.9500）在系统里活了很久 ——
因为那个自检**零调用者**，而且它自己的判据还依赖数组首尾位置，
声称在比较 `32o` 与 `AA`，实际比较的是 `22` 与 `AA`（红队 F-02）。

**现在的对策**（三条，都是可执行的）：
1. `startAlphaServer` 启动时**真的调用**两个自检，失败即**拒绝启动**（Fail-Closed）
2. 自检判据一律使用**具名牌型**，不再依赖数组顺序
3. 每个红队编号对应一条**永久回归测试**（`test/alphaRedteamRegression.test.ts`），
   报告编号与测试标题一一对应，可机械核对

### 10.2 Step 7 红队发现的核心缺陷（**12 条 CRITICAL/MAJOR**）

Step 7 的动态行为引擎在单元测试 **55/55 全绿**的情况下，
被**两轮**红队（作者自查 + 独立审计）证明是**失效**的。

**第一轮（作者自查）**：

| # | 缺陷 | 后果 | 修正 |
|---|---|---|---|
| D1 | 收缩强度 `k` 取基线的 `effectiveSampleSize`（400+） | 20 手窗口信号被完全压平，VPIP 15%→45% 算出 0~1 分 | 改为只由**近期**机会数决定的**温和收缩** |
| D2 | 同一 `confidence` 被连乘三次（聚合 / 状态 / 调整层） | 20 次机会的信号再被砍到约 1/4 | 聚合与调整层不再乘置信度 |
| D3 | `confidence` 刻度用 `n/(n+20)` | 远高于判定门槛的样本仍只得 0.5 可信度 | 改为按机会数线性映射 |
| D4 | 方向判定用绝对阈值 `\|Δ\| < 0.01` | 20 手窗口 ±1 次计数差被当成真实方向，产生**虚假方向冲突**提示 | 改为**标准误检验** |
| D5 | 方向检验的样本量误用 20 手窗口计数 | 60 手数据中 PFR 20%→5% 被判成「无方向」 | 改用全部近期事件的机会数 |
| D9 | 适配层方向冲突时保留「第一条」方向 | 两条相反调整抵消（因子 1.000）却标 `INCREASE` —— 输出**不存在的方向信号** | 对数域累加、净效应定方向 + `conflicting` 标记 |

**第二轮（独立红队判定 FAIL，本条最重要）**：

| # | 缺陷 | 后果 | 修正 |
|---|---|---|---|
| F1 | 组内方向冲突时判 `NONE`，导致兜底分支**永不可达** | **「开始大量跟注」被读成「更爱弃牌」**、19 分、无 `RANGE_WIDTH` 调整 | 组方向取**主导方向** + `directionContested` |
| F2 | 充分性与置信度由**跨指标机会总数**决定 | 2 手牌 → confidence **0.900** + 满额范围因子；20 手 → 0.851（**随样本增加而下降**） | 改为**每项指标自身**的机会数 |
| F3 | 方向检验与强度用**不同样本量** | 同一份 W20 统计，多喂 40 手同水平历史就翻转判决；误报率随历史 12%→**51%** | 样本量固定为窗口机会数 |
| F4 | `deviationScore` 无零假设刻度 | 真值 = 基线时均值 **19.8** 分、P95 35、12% 误报 | 引入 **z 检验门槛**；修复后均值 **8.0** |
| F5 | `SIZING` 组无指标映射 → 死代码；12 个真实指标不可见 | `SIZE_ANOMALY` 永不可达；翻后行为即使全命中也是 0 分 | 补齐 4 个有明确语义的指标 |
| F6 | 上下文事件不校验 `playerId` / `timestamp` | **别人的损失会抬高本人的 Tilt 概率**；未来事件影响当前判断 | 校验并记录忽略原因 |
| F7 | 人工 Hint 时间戳被忽略、静默吞掉、与 tilt 矛盾 | 状态 `TILT_SIGNAL` 而 Tilt 概率 = 0；无 provenance | 过滤未来、取时间戳最新、同步 Tilt、新增 `stateProvenance` |
| F8 | Fail Closed 失效 | 畸形 `opportunities` → **TypeError 崩溃**；非法 metric 被接纳 | 逐字段严格校验 |
| F9 | `asOf` 非有限值 | `NaN` 让**未来事件全部进入**计算，且污染快照字段 | 新增 `INVALID_AS_OF` |
| F10 | 非计算字段 `betSizePotRatio` 非法 | **整条事件的行为机会全丢**（26 分 → UNKNOWN 0 分） | 剥离非法字段、保留机会 |
| F11 | `MAX_SINGLE_EVENT_SHARE` 是死常量 | 改它不影响任何输出 | 真正接线 |
| F12 | 5000 事件 P95 突破预算（31.3ms） | 超出 20ms 热路径预算 | 排序前预解析时间戳；修复后 **15.1ms** |

> **教训**：12 条缺陷全部是「系统给出了误导性结论」，且**全部在 55 项单元测试下呈现绿色**
> —— 因为那些测试只断言「不该报警时别报警」，没有断言「该报警时必须报警」。
> 红队场景必须**成对**写：一个正常对照 + 一个真实异常。
>
> **更强的教训**：第一轮 5 项修复之后，**独立审计仍然找出 3 个 CRITICAL**。
> 作者自查与独立审计不可互相替代 —— 独立审计员用完全不同的方法
>（批量确定性种子统计、边界扫描、源码死代码检查）才看见方法盲区。
> 详见 `reports/DYNAMIC_REDTEAM_AUDIT.md` 与 `reports/DYNAMIC_INDEPENDENT_REDTEAM.md`。
>
> **未解决的诚实记录**：**误报率 14~22%**（真值 = 基线，20 手窗口，多项指标）。
> 这与统计理论一致（1.5σ 门槛 + 多重比较），要降低必须提高门槛、
> 代价是真实变化检不出。已用低置信度 + 保守幅度控制在 ≤1.28×。

---

## 11. 下一路线（已锁死，不再横向扩展）

```
Step 7 Dynamic Behavior          ← 已完成（含两轮红队）
  ↓
Step 7 独立红队                   ← 已完成（判定 FAIL → 全部修复 → PASS）
  ↓
Environment 最小接入              ← ✅ 已完成
  ↓
Minimal Manual Input             ← ✅ 已完成
  ↓
Alpha Decision Engine            ← ✅ 已完成
  ↓
最小中文 UI                       ← ✅ 已完成（`http://127.0.0.1:5173`）
  ↓
Golden Smoke Spots（25 个）        ← ✅ 已完成
  ↓
Alpha 独立红队                    ← 🔄 进行中
  ↓
Internal Alpha                   ← 19/20 项门槛已满足
  ↓
**网站内部真实牌局测试**            ← 下一步唯一要做的事
```

**禁止在 Internal Alpha 与真实牌局测试之间插入新的大 Phase。**

---

## 12. 状态漂移的修正记录

| 位置 | 修正前（漂移） | 修正后（事实） |
|---|---|---|
| `V2_ARCHITECTURE.md` §17 | Phase 4 Range Engine「待办」 | **已完成**（Step 5A + 5A.1） |
| `V2_ARCHITECTURE.md` §17 | Phase 5 Player Profile「待办」 | **已完成**（Step 6） |
| `V2_ARCHITECTURE.md` §17 | Phase 0 GitHub 审计「进行中」 | **已完成**（Phase 4.5 PASS） |
| `V2_ARCHITECTURE.md` §16 目录结构 | 未含 `knowledge/` / `infra/` / `scripts/` | 已补 |
| `V2_ARCHITECTURE.md` | 未记录环境模型与产物 hash 机制 | 已补 |
| `V2_ARCHITECTURE.md` §16 目录结构 | 是「V2 目标」设想结构，与实际大幅偏离 | 改为记录**实际结构** |
| `V2_ARCHITECTURE.md` §17 审计清单 | 缺少「状态同步」一项 | 已补第 6 项：更新本文件，否则 `test/projectStatus.test.ts` 会失败 |
| 本文件 §4（Alpha） | ⑦ 🟡 / ⑧ ⬜ / ⑫ 🟡 | ⑦ ✅ / ⑧ ✅ / ⑫ ✅（Alpha 层已落地，证据文件已更新到 `projectStatus.test.ts`） |
| 本文件 §1 / §5.5 | 「产品能力 = 0% 可端到端使用」 | **已可端到端使用（内部 Alpha）** —— 见 §5.5 |
| `test/projectStatus.test.ts` | 断言「必须标注端到端为 0%」 | 改为**双向一致**：引擎存在则必须声明可用、不存在则必须声明 0% |
| `test/engine.test.ts` / `test/validator.test.ts` | 两处测试**固化了错误行动顺序**（由 `rebuildPendingQueue` 的 Bug 产生） | 按正确顺序修正（见 §10.3） |
| `reports/TABLE_INTERACTIVE_REPORT.md` §24 | 两条「已知限制」：「暂离/空座位无法分析」「翻牌前前位决策常返回信息不足」 | **两条均被证伪（它们是缺陷，不是限制）**；已在原文追加 `§23.5 CORRECTION / ERRATA`，**不改动该报告其它历史结论** |
| 本文件 §10 | 「1,185 项 / 41 个测试文件 / 77 个产物」 | **1,242 项 / 44 个文件 / 91 个产物**（桌型拓扑修正后） |
| `docs/TABLE_INPUT_USAGE.md` §2 | 「本版本要求牌桌上每个座位都有人」 | 空座位**不需要**补满；新增「设为庄家」与「本手人数条」说明 |
| `scripts/table-walkthrough.ts` Spot A2 | 断言「翻牌前 UTG 应当提前提示多人池限制」—— 那**正是在断言缺陷本身** | 改为断言「满桌 UTG 不得劝退 + 必须给出建议 + 两个计数正确」 |

### 12.1 Alpha 阶段发现的两处 CRITICAL 引擎 Bug

| # | 缺陷 | 后果 | 修正 |
|---|---|---|---|
| **A1** | `rebuildPendingQueue`：行动者弃牌后 `findIndex` 返回 -1，`Math.max(0,-1)` 把 `order[0]` 转到队尾 | UTG 弃牌后队列 `[CO,BTN,SB,BB,HJ]` → **合法输入被拒，端到端完全跑不通** | 在**含弃牌者**的完整顺序里定位行动者，再从他之后环绕 |
| **A2** | 蒙特卡洛**均匀抽样**，Range 后验被丢弃 | 「对手加注过 → 范围偏强」对权益**毫无影响** → **Range → Equity 链形同虚设** | 新增按 CDF 的加权抽样（`perOpponentWeights`）；无权重时与修复前**逐位一致** |

> **方法论教训**：这两个 Bug 都是**第一次真正跑端到端**才暴露的。
> 单元测试全绿时它们是隐藏的 ——
> **「能不能跑通」本身是一种独立的测试维度**，不能靠单元测试替代。

> **漂移的根因**：架构文档在 Phase 1–3 期间写成，之后每个 Step 只更新了
> `STEP_REPORTS.md` / `TEST_MATRIX.md`，没有人回头更新架构文档的状态列。
> 本文件（`CURRENT_PROJECT_STATUS.md`）从此承担该职责，
> 并由 `test/projectStatus.test.ts` 强制与代码保持一致。


---

## 编码事故恢复记录（2026-09-19 11:33:25）

- **事故**：2026-09-19 16:56 一次 PowerShell 就地文本替换（CP936 控制台 + 无 BOM UTF-8）损坏 `src/app/decision/decisionEngine.ts` 与 `src/domain/decision/decision.types.ts`（乱码 + 吞换行，955 个语法错误）。
- **恢复方式**：在独立目录把损坏文件**逆向解码**（CP936 编码 → UTF-8 解码），以 github main `a914f9c` 为骨架逐字节拼接未改动区域，再按证据补全缺口；未从零重写。
- **恢复完成时间**：2026-09-19 11:33:25；**Git HEAD 仍为 `a914f9c`**（本轮不做任何 git 写操作）。
- **验证结果**：类型检查 **0 错误**；全量测试 **1,968 项执行 / 1,968 通过 / 0 失败 / 0 跳过**；产物清单 **158/158 一致**。
- **已恢复功能**：U1 加注 EV 与 P0 资金口径、P1-2a/P1-4 合法再加注分支、BET SIZE CONSISTENCY、P1-2b 再加注分支与 Hero FOLD/CALL、RIVER BET RANGE V2 到达范围、RIVER RAISE DECISION V2 披露层、画像与诊断透传。生产入口逐位复现 P0-7：`P(弃)=0.05296693816568434｜P(跟)=0.9470330618343152｜rr=0｜RAISE EV=33.315808978687605`（详见 reports/evidence）。
- **仍存在的缺口**：6 处**非确定性中文说明文字**缺口（无法逐字定字，已以「—」占位并登记为 UNKNOWN；不含任何原因码/字段名/比较用字符串，经全量测试证明不影响行为）。
- **尚未完成的模型校准问题**（事故前即存在，本次未改）：P1-1 画像统计未被决策消费、P1-3 标签维度与融合维度差异、P2-1 单一启发式尺寸、P2-2/P2-3 诊断计数与伪计数不一致、U9 sawtooth、D1 到达范围口径、D5 决策日志未记录响应模型版本。
