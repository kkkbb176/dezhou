# 外部知识审计 —— Phase 4.5

> **审计对象**：4 个 GitHub 项目 + 6 本书
> **审计日期**：2026-09-13
> **审计方法**：GitHub REST API（metadata / commits / git tree）+ `raw.githubusercontent.com` 原始文件 + 官方出版页
> **本项目基线**：828 项测试全绿、类型检查零错误（审计开始时）→ **878 项**（新增知识层 50 项测试后）
>
> ⚠️ **本阶段只做只读审计 + 知识结构设计。未修改任何决策引擎代码。**

---

## 0. 审计方法说明（规范第 4 节）

规范明确禁止「通过 GitHub 搜索 HTML 判断项目是否存在」。本轮全程使用：

| 手段 | 用途 |
|---|---|
| `GET /repos/{owner}/{repo}` | 确认存在性、license 字段、语言、活跃度 |
| `GET /repos/{owner}/{repo}/commits?per_page=1` | 取得**精确 commit 哈希**（可复现性依赖它） |
| `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1` | 枚举**完整文件树**，用于确认「是否真的没有 LICENSE 文件」 |
| `GET /repos/{owner}/{repo}/contents/` | 取根目录清单与 LICENSE 文件字节数 |
| `raw.githubusercontent.com/{owner}/{repo}/HEAD/{path}` | 读取原始 README 与 docs |

**未使用**：`git clone`。原因是四个仓库体积合计约 **544 MiB**
（GTOpen 385,689 KB + Poker Lab 142,057 KB + poker_solver 29,307 KB + DCFR-SOLVER 192 KB ≈ 557,245 KB ≈ 544 MiB），
而本轮只需要文档与元数据；`raw` 端点已经给出可引用的原文，且能记录精确 commit。

### 0.1 引用可核查性

本报告中的每一条原文引用都在**自检阶段**用脚本回源核对过（`raw.githubusercontent.com` 逐字匹配）。
核对方式与结果记录在 §8。凡跨行引用的句子，本报告统一以**拼接后的完整句**呈现
（例如 Poker Lab 的 Fail-Closed 句在原文第 71–72 行被换行拆开）。

---

> 本报告与来源注册表的对应关系（便于交叉核对）：
>
> | 注册表 id | 报告章节 | 仓库 |
> |---|---|---|
> | `github.gtopen` | §1 | `https://github.com/MatthewPDingle/GTOpen` |
> | `github.poker-lab` | §2 | `https://github.com/davidvayn/pokersolver` |
> | `github.dcfr-solver` | §3 | `https://github.com/exinori/DCFR-SOLVER` |
> | `github.poker-solver` | §4 | `https://github.com/amaster97/poker_solver` |
>
> 六本书的来源 id 为 `book.modern-poker-theory` / `book.mastering-small-stakes` /
> `book.grinders-manual` / `book.small-stakes-cash-games` / `book.mental-game-of-poker` /
> `book.live-no-limit-cash-games`（见 §5.2）。

---

## 1. GTOpen

| 字段 | 内容 |
|---|---|
| Repository | `MatthewPDingle/GTOpen` |
| Commit | `92c86ed73aa0856df8479b5c7635e1469f48f1e8` |
| Latest commit date | 2026-09-11T03:06:25Z |
| License | **无**（GitHub API `license: null`） |
| License Gate | **RED** |
| Language | Rust（`crates/solver` + `crates/server`）+ 零构建浏览器 UI（`web`） |
| Repo size | 385,689 KB |
| Stars / Forks | 12 / 2 |
| Last activity | 2026-09-12T16:10:16Z（pushed_at） |
| Relevant Module | Player modelling / Exploit architecture / Preflop multiway modelling |
| Code Copy Allowed | **否** |
| Decision | **Concept only** |

### 1.1 许可证核实（关键）

「有没有许可证」直接决定门禁，因此本轮做了**三重复核**：

1. GitHub API `license` 字段 → `null`
2. 完整 git 树（3,242 项，`truncated: false`）中匹配 `license|licence|copying` → **零命中**
3. 根目录 `README.md` 全文搜 `licen[cs]e` → **零命中**；根 `Cargo.toml` 无 `license` 字段

结论：**无许可证 → RED → 只研究概念，禁止复制任何代码 / 文档 / 数据。**

> 附带发现：仓库根目录有 `AGENTS.md`，说明该项目也使用了 AI 代理协作开发。
> 这不影响许可证判断，但意味着「代码风格可借鉴」这一直觉在这里尤其不可靠。

### 1.2 它如何从理论策略转向针对特定玩家的策略？（规范第 2.1 节的核心问题）

GTOpen 的答案是 **node locking（节点锁定）+ 玩家模型 + 重新求解**，而不是「给策略打补丁」：

1. **Preflop Lab**：建 2–9 人局，给座位**分配玩家模型**，然后求解。
2. **Browse 标签页**：可以**锁定某个频率或锁定某个玩家模型**，然后**重新求解**研究响应。
   —— 即「把对手钉在特定策略上，求我方的最佳响应」。
3. **Reports**：可对 `Vs modeled villain` 选项应用一个可用玩家模型。
   文档诚实标注：它**不**复制 Browse 的手动锁定，也**不**锁定双方；当前选择在双方都有模型时**偏向 OOP**。

**对本项目的意义**：这条路径与本项目已实现的
`RangeAdjustmentProvider`（画像 → 调整范围权重与动作似然，**绝不直接产生动作**）方向一致，
但本项目的粒度更保守（只调概率，不做节点锁定重解）。
节点锁定是一个**未来可选项**，但它需要求解器，因此不在当前路线图上。

### 1.3 证据标签体系（最有价值的设计）

`docs/model_evidence.md` 定义了一套**区分「来源」而非「置信度」**的标签：

| 标签 | 含义 |
|---|---|
| History-backed | 存储的手牌概率匹配一份**提供的、平滑过的历史策略** |
| Extrapolated | 历史概率被**迁移到来源覆盖范围之外**（桌型 / 盲注 / 前注），且该迁移**未经验证** |
| Contextual estimate | 实验性预测器使用入池历史、加注深度与跟注价格；输出是**预测**而非该确切局面的直接观测 |
| Contextual fallback / Pooled fallback | 请求的上下文模型或尺寸策略不可用，显示的是存储的或池化的策略 |
| Stat-derived | 现生成的**从聚合倾向与参考排序推断**手牌构成 |
| Stored policy | 范围被保存 / 复制 / 修改过，其确切历史来源**无法核实** |
| Solver / Adaptive solver / Frozen strategy | 求解器策略适用，可能只在该画像的自适应阈值之上学到 |
| Point lock | 节点级锁定覆盖了玩家模型 |

文档中三条最关键的论述（**这三点与本项目的既有设计高度一致**）：

1. **「These labels describe provenance, not confidence.」**
   —— 标签描述来源，不是置信度。大池化样本不等于每一个价位与筹码深度下每一手牌的样本都大。
2. **「An edited range is checked against its supplied history probabilities rather than trusted
   simply because a dataset name remains attached.」**
   —— 被编辑过的范围必须**重新对照历史概率检查**，不能因为还挂着数据集名字就被信任。
   ⚠️ 这条**直接支持**本项目已做的决定：复制/编辑过的范围来源必须降级为 `FALLBACK`，不得沿用原可信度。
3. **「A big blind in an unopened pot has no decision; the editor continues to show
   `Not applicable` rather than a fictitious calling range.」**
   —— 没有决策点时显示「不适用」，**而不是编造一个跟注范围**。
   这是「Fail-Closed 到 UI 层」的范例。

### 1.4 玩家原型与实测统计（**RED 来源，本项目不复制其任何数值**）

`docs/player_types.md` 给出了 7 种原型（Nit / Tight-passive / TAG / Loose-passive fish / LAG /
Whale / Maniac）在 VPIP 分档与一条攻击性规则下的完整统计表，
数据来源自述为：**2009 年 25–50NL 线上现金，HandHQ 经多伦多大学 PHH 数据集**。

> ⚠️ **纪律说明（本报告初版在此处自相矛盾，已修正）**
>
> GTOpen 是 **RED** 门禁（无许可证）。因此本项目**不仅不复制其代码，
> 也不复制其数值**。本报告初版既写了「不得引用上表的任何数值」，
> 又把若干具体系数抄进了正文 —— 这是**违反本阶段自己定的 RED 纪律**，
> 已由独立红队发现（F-05）并全部清除。
>
> 正确的做法是：**只引用方向性结论，具体数值指向原文，让读者自己去查**。
> 下面表格即按此原则重写。

**其中最值得本项目注意的三条方法论结论**（只有方向，没有数值）：

| 结论（方向性） | 对本项目的意义 |
|---|---|
| **玩家统计是连续谱而非聚类**：无论 K-means 还是 GMM，都得不到清晰的类别数拐点 —— 「任何类别数量都是建模选择」 | 独立印证本项目已有的架构决定：**底层保存连续数据，标签只是摘要**，调整因子由连续维度计算而非由标签计算 |
| **VPIP/PFR 类型解释翻牌前行为，对翻牌后几乎无解释力**：翻牌前各指标的解释力显著高，而 fold-to-flop-bet、fold-to-turn-bet、c-bet、raise-vs-bet、fold-to-3-bet 的解释力都远低于翻牌前 | 支持本项目把翻牌前与翻牌后当作**独立维度**；**警告**不要把「翻牌前类型」直接外推到翻牌后 |
| **存在幸存者偏差**：长期样本玩家中松玩家占比远低于按发牌手数计的实际情况 | 提醒任何基于「长期样本玩家」的统计都会系统性低估松玩家比例 |

**具体数值请查阅其 `docs/player_types.md` 原文** —— 本报告**不复现**它们，
因为该来源无许可证。

**已知限制（其自身文档承认）**：
- 翻牌前使用**近似延续模型**，自述「不求解完整多路游戏到河牌，重叠紧范围仍可能暴露较大的去牌错误」
- 玩家模型混合观测与推断，「数据集标签不等于每一个显示的手牌频率都被观测过」
- cross-exploit 数值基于**单一类型满桌**与**不会自适应**的刚性画像，绝对值是上限值
- Postflop 仅单挑；无 ICM

---

## 2. Poker Lab（davidvayn/pokersolver）

| 字段 | 内容 |
|---|---|
| Repository | `davidvayn/pokersolver` |
| Commit | `687ce51938a92f002d7b71230a552a8af633b314` |
| Latest commit date | 2026-09-09T21:40:09Z |
| License | **MIT**（根目录 `LICENSE`，1,071 字节） |
| License Gate | **GREEN** |
| Language | TypeScript / Rust(WASM) / Next.js |
| Stars / Forks | 1 / 1 |
| Relevant Module | Fail-Closed 策略加载 / EV-loss 统计 / 练习引擎 / 校验门禁 |
| Code Copy Allowed | **是**（满足 MIT 条件，需保留版权声明） |
| Decision | **Adopt（机制）** |

### 2.1 哪些机制可以提升我们内部决策软件的可信度？（规范第 2.2 节的核心问题）

**这是本轮审计中价值最高的一个项目**，因为它把「可信度」做成了**架构约束**而不是文档承诺：

| 机制 | 其原文依据 | 本项目对应设计 |
|---|---|---|
| **Fail-Closed** | 「Practice **never substitutes fabricated strategy** when a model or shard is unavailable.」 | 知识库 `loadKnowledgeBaseOrThrow`：校验失败**抛错拒绝降级** |
| **双独立种子门禁** | 「full-hand outputs remain **advisory and hidden from Practice until two independent seeds pass every validation and storage gate**」 | 未来求解器接入的前置条件；已写入交叉验证方案 |
| **返回前校验组件哈希** | 「`/api/practice/resolve` **verifies every component hash** before returning a policy」 | 知识库带 `registryVersion` + 每个 GitHub 来源带 `commitHash` |
| **诚实披露抽象** | 浏览器求解器自述为「single-street all-in-equity model」并**公开报告 exploitability** | 本项目 `THEORY_REFERENCE` 说明中明确写出「非求解器输出，不得称为 GTO 最优」 |
| **EV-loss / confidence / costly-decision 分析** | Stats 标签页 | 未来复盘引擎的核心指标（`Expected EV Loss` 已列入测试矩阵） |
| **低置信度显式标注** | 「Called-action feedback carries the conservative Monte Carlo error bound and **graded as low confidence**」 | 本项目统一的 `confidence` 字段与样本分层 |

### 2.2 关于「模型/shard 不可用时拒绝伪造答案」

这是规范第 2.2 节特别要求重视的一条，其原文表述是：

> Practice **never substitutes fabricated strategy** when a model or shard is unavailable.

以及关于练习反馈的：

> It provides validated action frequencies plus deterministic, policy-consistent
> counterfactual action-EV estimates.

**落地到本项目的三条对应设计**：

1. 知识库 `buildKnowledgeIndex` 在任何校验失败时**抛错**，不返回部分索引。
2. 已存在的不变式：`normalizeWeights` 不再用绝对阈值判坍塌（否则会静默伪造「范围为空」）。
3. 已存在的不变式：`equityPolicy` 显式拒绝而非静默降级（红队验证过「MC 不得静默升格迭代数」）。

### 2.3 已知限制（其自身 README 承认）

- 浏览器求解器是**单街全下权益抽象**，不是完整多街求解（自述并给出可利用度）
- `preflop-solver/` 的 Rust blueprint trainer 是**抽象单挑**模型，输出自述为 advisory
- `npm run lint` 尚不适合无人值守验证（未提交 ESLint 配置）
- ⚠️ **本项目额外发现的限制**：其 `data/preflop/` 翻牌前图表的**上游来源未在本轮审计中确认**。
  即使 MIT 覆盖**代码**，**数据本身**的权利仍需单独核实。因此本项目的
  `derivableQuantitativeData` 对该来源为 `false`。

---

## 3. DCFR-SOLVER（exinori/DCFR-SOLVER）

| 字段 | 内容 |
|---|---|
| Repository | `exinori/DCFR-SOLVER` |
| Commit | `4ade6a9e15a841c41867afde1258b9d110cd6fb1` |
| Latest commit date | 2026-03-16T08:46:06Z（**唯一一次提交**） |
| License | **MIT**（根目录 `LICENSE`，1,066 字节） |
| License Gate | **GREEN** |
| Language | Rust |
| Repo size | 192 KB |
| Stars / Forks | 19 / 6 |
| Relevant Module | Solver 交叉验证 / 差分测试 / 均衡歧义 |
| Code Copy Allowed | 是（但仓库极不成熟，**本轮不建议复制**） |
| Decision | **Concept only**（数值未被本项目复现） |

### 3.1 如何判断两个 Solver 结果不同究竟是 Bug 还是不同有效均衡？（规范第 2.3 节的核心问题）

这是**本轮审计最重要的方法论收获**，而且有**两个相互独立的项目**给出同一答案。

**DCFR-SOLVER 的证据**（其 README「Phase 4: The Multiple Equilibria Problem」）：

> Our solver's exploitability was excellent (0.016%), but per-hand betting frequencies
> differed across solvers by ~12-15%. Was this a bug? **No. This is the Multiple Nash
> Equilibria problem.** When a hand is indifferent between actions (EV difference ≈ 0),
> any mixing ratio is valid. […]
> We proved this definitively: **241 of 499 hands had EV gaps under 0.1 chips.** These
> indifferent hands account for all the difference. **Pure strategies (100% bet or 100%
> check) match 100% across all solvers tested.**

**poker_solver 的独立证据**（见第 4.3 节）：一处 33 个百分点的差异最终归因为
「同一无差异流形上的不同点」而非 Bug，并给出仲裁结论「NOT A BUG」。

**→ 因此本项目采用以下判定协议**（写入 `reports/SOLVER_CROSS_VALIDATION_PLAN.md`）：

```
两个 Solver 结果不同
  ↓
① 先比 EV，不比频率
  ↓
EV gap 小（落在无差异流形内）  →  标记「策略混频不唯一」，不是 Bug
  ↓
EV gap 大，或纯策略方向相反    →  进入 CRITICAL REVIEW
```

**关键**：规范第 32 / 33 节给出的判据与此一致，且「纯策略方向相反 → CRITICAL」
这条是从 DCFR 的实测（纯策略 100% 一致）反推出来的必要条件 ——
**如果纯策略都不一致，那就无法用「多重均衡」解释**。

### 3.2 花色同构的排列方向缺陷（极隐蔽的一类）

> The root cause: `chance_utility` aggregation was applying the **forward permutation
> instead of the inverse**. For transpositions (swapping two suits), forward = inverse,
> so it worked. For **3-cycles in S3** (monotone boards with three equivalent suits),
> **forward != inverse**. The aggregation silently scattered utility values to wrong combos.

症状：配对与单调牌面的可利用度停在 0.65%–0.73%，而普通牌面收敛到 0.016%。

**对本项目的意义**：本项目**未实现**花色同构，因此该缺陷目前不适用。
但它是一条极有价值的**前置警告**：任何「利用对称性」的优化，都必须验证
**群元素的排列方向**，且对**非对合元素**（3-循环及以上）单独测试。
已登记为规则 `validation.suit-isomorphism-permutation-direction`（证据等级 SECONDARY，
因为**未在本项目内复现**）。

### 3.3 DCFR 参数与工程细节（可用于将来的参考实现）

- **DCFR（Discounted CFR）默认折扣**：α = 1.5（正后悔折扣）、β = 0（负后悔折扣）、γ = 2.0（策略折扣）
  —— 与 poker_solver 声明的 Brown & Sandholm 2019 默认值**一致**（两个独立项目交叉印证）
- 其他被其采纳的变体：CFR+（把负后悔截断为 0）、EGT（收敛到最大熵纳什）、QRE v2（唯一不动点）
- 工程优化：SoA 内存布局、range-aware compact combo mapping（跳过被阻断与零权重组合）、
  SIMD、Regret-Based Pruning
- ⚠️ 其自述 +163.8% 性能提升与 0.016% 可利用度**均未在本项目复现**

### 3.4 已知限制

- 仓库**仅一次提交**、192 KB、未经时间与社区检验 → 整体证据等级 `VERIFIED_SECONDARY`（而非 PRIMARY）
- 其翻牌前求解器为 **6-max** MCCFR，不适用于 9-max
- 本项目未运行它，所有数字均为其自述

---

## 4. poker_solver（amaster97/poker_solver）

| 字段 | 内容 |
|---|---|
| Repository | `amaster97/poker_solver` |
| Commit | `f78f1b2bc338dd8cbb5226ecb8398bbdb3635676` |
| Latest commit date | 2026-06-18T17:59:17Z |
| License | **MIT**（根目录 `LICENSE`，1,062 字节） |
| License Gate | **GREEN** |
| Language | Python + Rust（PyO3 / maturin） |
| Stars / Forks | 4 / 3 |
| Relevant Module | Reference-first / 许可证纪律 / oracle 验证 / 差分测试 |
| Code Copy Allowed | 是 |
| Decision | **Adopt（方法论）** |

### 4.1 Reference-first：每个重要算法结论指向原始依据（规范第 2.4 节的核心）

其 README 的 `References` 一节明确列出：

> **Algorithmic foundations**: DCFR (Brown & Sandholm 2019); CFR+ (Tammelin 2014);
> vanilla CFR (Zinkevich, Johanson, Bowling, Piccione 2007); Libratus (Brown & Sandholm 2017);
> Pluribus (Brown & Sandholm 2019).
> **Correctness oracles**: DeepMind's `open_spiel` (**Apache 2.0**) for Kuhn / Leduc,
> and Noam Brown's `noambrown/poker_solver` (**MIT**) for river spots and the vector-form CFR port.

以及一条**许可证纪律**的范例：

> The CFR / DCFR / HUNL literature and reference codebases used for study and correctness
> checks live under `references/` (**not redistributed here**).

—— 即：**参考实现只用于本地对照，不随仓库分发**。这是「借鉴思想但不污染许可证」的正确做法。

**本项目采纳的三条**：
1. 每个知识来源必须登记 `license` + `licenseGate` + `commitHash`（已落地为 `KnowledgeSource`）。
2. 门禁**由许可证推导**，不接受手写（已落地为 `licenseGateOf`，并有回归测试）。
3. 参考实现**不进入本仓库**（本项目未复制任何第三方源码）。

### 4.2 两层架构 + 差分测试门禁

> The Python package `poker_solver/` is the readable spec / ground truth; the Rust crate
> `crates/cfr_core/` […] is the workhorse. **Every algorithm lands in Python first, ports to
> Rust, and is gated by diff tests before the Rust tier is trusted.**

以及一组可复现性开关（**这是差分测试可执行的关键**）：

> Each of these can be force-disabled via an environment variable
> (`CFR_RAYON_CHANCE`, `CFR_SUIT_ISO`, `CFR_TERMINAL_IE`), in which case the solver falls
> back to a **bit-identical reference path** — the mechanism the diff tests rely on.

—— 即：**每个优化都必须有一个「关掉它」的开关，关掉后与参考路径逐位一致**。

**本项目可借鉴的形式**：本项目的 `equityExact`（精确枚举）与 `equityMonteCarlo` 已有
一致性对照测试；「优化可关闭 + 关掉后逐位一致」这条纪律值得在**未来的性能优化**中沿用。

### 4.3 聚合器 ≠ 真纳什（**必须记录的一课**）

其 `docs/aggregator_vs_true_nash_explainer.md` 精确区分了两个名字相似的函数：

| 函数 | 它实际回答的问题 |
|---|---|
| `solve_range_vs_range`（聚合器） | 「对每个（我方组合, 对方组合）对，完全信息纳什说什么？再按组合数池化。」 |
| `solve_range_vs_range_rust`（向量形式） | 「我方范围 vs 对方范围的**联合不完全信息**纳什均衡是什么？」 |

关键论断：

> It is **not** Nash for the range. Each subgame "sees" villain's exact hole cards, so hero
> plays the full-information best response — never bluff-catches off range composition,
> never produces range-driven bet-size polarization, never mixes to hide information.
> The aggregate looks like a mixed strategy but is really a **histogram** of "what fraction
> of villain representatives hero beats in the full-info subgame."

以及一个**极具警示性的示例**：某手牌在聚合器下弃牌 7.69%，
而该数字**恰好等于对方范围中某一手牌的占比（3/39）** —— 是确定性产物，不是混合频率。
真纳什应防御 100%。

**→ 对本项目的直接意义**：本项目**没有**求解器，但这条区分必须写进交叉验证方案：
将来若接入求解器，必须记录它求解的是**哪个数学对象**，并**拒绝**用聚合结果回答范围级问题
（诈唬抓取 / 极化下注）。已登记为规则 `range.aggregated-per-combo-not-range-nash`。

### 4.4 测试侧编码瑕疵（22–42 个百分点的假信号）

> PR 40 confirmed three test-side encoding artifacts that contributed to the original
> 22-42pp acceptance-test signal: **action-axis column ordering** (Brown emits
> `[c, f, r_low, r_med, r_jam]`; Rust emits `[f, c, r_low, r_med, A]` after sorting on
> action ID, so positional indexing mis-aligned the columns); **range-to-player-slot
> inversion** (Brown's P0 opens river, this engine's P1 opens river); and **hand-string
> suit-order normalization** (`cdhs` vs `shdc`).

修正包装层后原信号消失。**这是本项目最应该吸取的一条**：
任何跨实现差分测试，都必须**先锁定**坐标轴约定、玩家槽位约定与字符串规范化，
否则测的是**包装层**而不是**算法**。已登记为规则
`validation.beware-test-harness-encoding-artifacts`。

其最终采用的**四层验收门**：

```
① 结构性审查  +  ② 浅筹码严格逐格  +  ③ 深筹码 max-L1 ≤ 1.9  +  ④ top-action ≥ 60%
```

—— 这套「不再要求逐格严格相等」的改造，正是规范第 31 / 32 节要求的方向。

### 4.5 诚实的算力披露

> **What it can and can't do (honest capability):** River and turn subgames, and shallow /
> medium-depth flop spots, solve well and are practical to run interactively.
> **Deep-stack (e.g. 100BB) full-range flop solves are compute-intensive — expect minutes,
> not instant results** […] This is not an interactive "deep-flop in real time" solver.

**对本项目的意义**：本项目的硬指标是 1–3 秒（8 秒硬上限）。因此
**深筹码全范围翻牌求解与本项目的延迟目标不兼容** —— 这直接决定了
「实时求解」不是本项目的路线，只能走「预计算 + 查表 + 诚实标注」路线。

### 4.6 已知限制

- 仅支持**单挑（HUNL）**，**不适用于多路底池** —— 本项目是多路场景，需注意
- 其 `references/` 下的第三方参考实现**未随仓库分发**，本项目不得依赖
- 所有数值**未在本项目内独立复现**
- 其聚合器路径的输出**不得**用于诈唬抓取类结论（其自身文档已明确警告）

---

## 5. 书籍审计（规范第 7 / 46 节）

> ⚠️ **本节的核心结论是：六本书全部 `SOURCE_TEXT_NOT_AVAILABLE`。**
>
> 本项目**没有**任何一本书的正文、合法公开摘录或作者公开文章的可引用副本。
> 因此本轮**只登记书目信息与预定角色**，并建立**主题索引占位** ——
> **不写任何具体频率、章节结构或结论**。

### 5.1 来源幻觉与盗版风险（重要）

在核实书目时，web 搜索返回了若干**疑似盗版全文站点**（例如全文托管站与文档分享站）。
本项目**未读取、未引用、不会使用**此类来源，并已将其**登记为风险**。
知识库测试 `来源幻觉审计：知识库不得引用盗版站点` 会扫描 URL 与说明文字，
禁止出现此类域名（除非说明中同时写明「未读取 / 未使用」）。

### 5.2 逐本审计

| # | Title | Author | Available Source | Full Text | Relevant Topics | Applicable Environment | Evidence Type | Quantitative Data | Can Produce Numeric Rules |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Modern Poker Theory: Building an Unbeatable Strategy Based on GTO Principles | Michael Acevedo | 官方出版页（Simon & Schuster / D&B Poker），ISBN 9781909457898 | **NO** | GTO 思想 / Range vs Range / bluff-value balance / MDF 类思想 / blocker / polarization / indifference | `THEORY_REFERENCE`（预定） | SECONDARY（仅书目） | NO | **NO** |
| 2 | Mastering Small Stakes No-Limit Hold'em | Jonathan Little | 书店书目页，ISBN 9781909457775 | **NO** | recreational players / weak-player exploitation / value-heavy lines | ⚠️ 书名**同时覆盖锦标赛与现金** → 未区分前**禁止**用于 `LOW_STAKES_ONLINE` | SECONDARY（仅书目） | NO | **NO** |
| 3 | The Grinder's Manual: A Complete Course in Online No Limit Holdem 6-Max Cash Games | Peter Clarke | 书店书目页 | **NO** | Position / RFI / Blind defense / 3Bet / SRP / CBet / Turn / River | ⚠️ 仅 **6-max 现金** → 不得套用 9-max 或单挑 | SECONDARY（仅书目） | NO | **NO** |
| 4 | Strategies for Beating Small Stakes Poker Cash Games | Jonathan Little | 书店书目页（2015-10），ISBN 9781518655388 | **NO** | Player Type → Potential Adjustment | `LOW_STAKES_ONLINE`（预定） | SECONDARY（仅书目） | NO | **NO** |
| 5 | The Mental Game of Poker | Jared Tendler | Google Books 书目 | **NO** | Tilt / chasing losses / fear / confidence / outcome bias | 仅辅助 Dynamic Human Model | SECONDARY（仅书目） | NO | **NO** |
| 6 | Jonathan Little on Live No-Limit Cash Games: The Theory (Vol. 1) | Jonathan Little | 书店书目页，ISBN 9781909457232 | **NO** | 实盘案例 | ⚠️ 是 **Live** 现金，与项目当前线上环境不同 | SECONDARY（仅书目） | NO | **NO** |

**「Can Produce Numeric Rules」全部为 NO** —— 因为没有正文。
这是本阶段最重要的诚实结论之一：**六本书本轮提供零个可量化的策略参数。**

### 5.3 各书的预定角色与主题索引（仅占位，非内容）

| 书 | 预定角色 | 主题索引状态 |
|---|---|---|
| Modern Poker Theory | **理论锚点**（Theory Anchor） | ⬜ 待正文 |
| Mastering Small Stakes | **小级别 Exploit 参考** | ⬜ 待正文，且需先解决锦标赛/现金范围区分 |
| The Grinder's Manual | **线上 6-max 现金框架** | ⬜ 待正文（规范第 10 节明确：如无合法完整文本，**只登记为待补知识源**） |
| Strategies for Beating Small Stakes Poker Cash Games | **Exploit / 弱玩家适应** | ⬜ 待正文；且规范第 11 节要求「不能直接转成硬编码」 |
| The Mental Game of Poker | **行为与结果偏差参考** | ⬜ 待正文；硬限制：心理描述**不得成为数学真值** |
| Live No-Limit Cash Games | **案例素材（Case Study）** | ⬜ 待正文；案例入库必须标注 `gameType = LIVE_CASH` 且 Decision / Result 物理分离 |

### 5.4 书籍知识进入系统的正确路径（规范第 54 节）

```
Book / Source
  ↓
Concept
  ↓
Structured hypothesis        ← 本阶段建立的 StrategyKnowledge
  ↓
Evidence level               ← HEURISTIC（无正文时不得更高）
  ↓
Case testing
  ↓
Internal hand-history validation
  ↓
Parameter calibration        ← 只有到这里才允许出现 magnitude
```

**不是**：

```
书里说 X  →  代码写死 X
```

本项目当前**停在第二步之后**：建立了结构（schema）与登记（registry），
但**没有任何书籍参数进入系统**。

---

## 6. 与已有审计的关系（规范第 3 节）

历史审计过的项目（WizGTO / Poker Hand Review / CoronaPoker / luckyone18&Poker / Poker Game Analyzer）
已在 `reports/GITHUB_REFERENCE_AUDIT.md` 中记录，本轮**未重复从零开始**。
本轮为**差异补充**，新增内容：

1. 4 个新项目的 API 级审计（含精确 commit 与完整文件树核对）
2. 许可证门禁从「一次性判断」升级为**代码强制的推导 + 回归测试**
3. 新增「来源注册表」与「策略知识 schema」，使每条结论可追溯到来源
4. 新增 `derivableQuantitativeData`，把「来源里有数字」与「我们能拿它定参数」区分开

---

## 7. 本轮审计的诚实结论

### 7.1 我们实际得到了什么

> 下表的每一行都给出**报告内的定位**，便于独立复核「声称条数 = 实际条数」。

| 类别 | 结果 | 定位 |
|---|---|---|
| **可直接复制的代码** | **零行**（GTOpen 无许可证；其余三个 MIT 但本轮无需复制，且其中两个数字不可复现） | — |
| **可用的量化参数** | **零个**（`derivableQuantitativeData` 全为 false） | §8.4 |
| **可采纳的方法论** | **8 条** | §2.1（3 条：Fail-Closed / 双种子门禁 / 哈希校验）、§4.1（1 条：Reference-first）、§4.2（2 条：两层差分测试门禁 / 优化可关闭）、§3.1 + §4.3（2 条：EV 优先于频率 / 纯策略一致） |
| **可采纳的设计** | **3 条** | §1.3（证据标签区分来源与置信度 / 被编辑数据必须重新检查 / 无决策点时显示「不适用」） |
| **交叉印证了既有设计** | **3 条** | §1.4 第 1 条（连续谱 → 标签只是摘要）、§1.4 第 2 条（翻牌前与翻牌后应独立）、§4.3 + §1.3（环境不得改数学 / 被编辑数据降级） |
| **新增前置警告** | **2 条** | §3.2（花色同构的排列方向）、§4.4（测试包装层编码瑕疵） |
| **风险发现** | **2 条** | §1.1（无许可证项目的数据权利不明）、§5.1（web 搜索返回盗版全文站点） |

**方法论 8 条的逐条定位**（与上面一行对应）：

| # | 内容 | 出处 |
|---|---|---|
| 1 | Fail-Closed | §2.1 表第 1 行 |
| 2 | 双独立种子门禁 | §2.1 表第 2 行 |
| 3 | 返回前校验组件哈希 | §2.1 表第 3 行 |
| 4 | Reference-first | §4.1 |
| 5 | 两层架构 + 差分测试门禁 | §4.2 |
| 6 | 优化可关闭 + 关掉后逐位一致 | §4.2 |
| 7 | EV 优先于频率（多重纳什均衡） | §3.1 |
| 8 | 纯策略一致是可判定的必要条件 | §3.1 |

### 7.2 最重要的一句话

> **本轮审计最大的产出不是「找到了可以用的东西」，而是「确认了没有可以用的东西」，
> 并且把这个结论变成了可执行的约束。**

四个项目提供了优秀的方法论，但**没有一个**能提供本项目当前最缺的东西 ——
**可引用的低级别线上人口统计与可信的翻牌前范围数据**。
因此 **Step 5B 的阻塞状态不变**，且现在有了文献级的证据说明为什么它仍然是阻塞的。

### 7.3 下一阶段的建议（详见最终报告）

1. **立即采纳**：8 条方法论 + 3 条设计（不涉及任何数值）
2. **实验**：用真实牌局校准环境先验的方向（当前只有方向、无幅度）
3. **仅研究**：求解器交叉验证（需要先解决算力与许可证）
4. **拒绝**：任何来自无许可证项目的数据；任何没有正文的书籍参数；实时深筹码求解

> ⚠️ **关于「量化校准路径」的更正（Phase 4.5 首轮表述过于绝对）**
>
> 首轮结论曾写成「`derivableQuantitativeData` 转为 `true` 的**唯一**合法路径是真实牌局校准」。
> 这会**把未来的路自己堵死**。准确的表述是：
>
> > **在当前项目条件下，内部真实牌局数据是目前唯一*已经可执行*的量化校准路径；
> > 未来经过来源、许可证、复现与交叉验证的数据同样可以进入。**
>
> 已知的三条合法路径（内部牌局数据 / 可授权且场景匹配的统计数据集 /
> 可本地复现并交叉验证的求解器输出）与四条准入条件见
> `docs/KNOWLEDGE_POLICY.md` §3.2。
>
> 区别在于：前者是**可执行清单**，后者是**封闭断言** ——
> 封闭断言会在条件变化后变成错误的约束。

---

## 8. 自检记录（规范第 47 节）

本节记录自检的**方法与实测结果**，便于复核。

### 8.1 Source Hallucination Audit（来源幻觉）

| 检查 | 方法 | 结果 |
|---|---|---|
| 4 个仓库是否真实存在 | `GET /repos/{owner}/{repo}` | ✅ 4/4 存在，owner 与名称与报告一致 |
| 4 个 commit 是否真实存在于对应仓库 | `GET /repos/{owner}/{repo}/commits?per_page=1` 比对 | ✅ 4/4 `MATCH` |
| 内部来源声称的仓库文件是否存在 | `existsSync` + 测试 `来源幻觉审计：内部来源必须真的存在于仓库中` | ✅ 全部存在 |
| 外部 URL 是否 https | 测试 `来源幻觉审计：外部 URL 必须是 https` | ✅ 全部通过 |
| **原文引用是否逐字存在** | `raw.githubusercontent.com` 拉原文后 `.Contains(quote)` | ✅ 见 §8.2 |

### 8.2 引用逐字核对（实测）

| 引用 | 来源文件 | 结果 |
|---|---|---|
| `These labels describe **provenance, not confidence**` | GTOpen `docs/model_evidence.md` | ✅ VERIFIED |
| `Player stats are a continuum, not clusters` | GTOpen `docs/player_types.md` | ✅ VERIFIED |
| `241 of 499 hands had EV gaps under 0.1 chips` | DCFR-SOLVER `README.md` | ✅ VERIFIED |
| `Practice never` + `substitutes fabricated strategy when a model or shard is unavailable.` | Poker Lab `README.md` 第 71–72 行 | ✅ VERIFIED（跨行拼接） |
| `independent seeds pass every validation and storage gate` | Poker Lab `README.md` 第 70–71 行 | ✅ VERIFIED |
| `component hash before returning a policy` | Poker Lab `README.md` 第 77 行 | ✅ VERIFIED |
| `fail-closed full-hand model` | Poker Lab `README.md` 第 50 行 | ✅ VERIFIED |

> ⚠️ 首次核对时 Poker Lab 的 Fail-Closed 引用报 `NOT FOUND` ——
> 原因是该句在原文中被换行拆成两行（第 71 行末尾 `Practice never`，第 72 行开头 `substitutes ...`）。
> 这不是幻觉，而是**跨行引用**。本报告已将该句以拼接形式呈现，并在此记录核对过程。

### 8.3 License Audit（许可证）

| 检查 | 方法 | 结果 |
|---|---|---|
| API license 与报告判断是否一致 | `GET /repos` 的 `license.spdx_id` | ✅ 4/4 一致（3×MIT→GREEN，1×none→RED） |
| GTOpen 是否真的没有许可证 | ① API `license: null` ② 完整 git 树 3,242 项搜 `license\|licence\|copying` **零命中** ③ README 无 `licen[cs]e` ④ 根 `Cargo.toml` 无 `license` 字段 | ✅ 四路一致 |
| 门禁能否被手写绕过 | 测试 `回归：门禁由许可证推导，手写一个更宽松的门禁必须被拒绝` | ✅ 解析器**忽略** JSON 里的门禁字段，一律推导 |
| 边界许可证 | 测试覆盖 `CC-BY-SA` / `CC-BY-NC` / `CC-BY-ND` / SPDX `OR` / `AND` / `WITH` / 模糊 `BSD` / 大小写与空白 | ✅ 全部按 §5 的判定表处理并有测试 |
| 是否有 RED 来源被标为 CODE_REFERENCE | 测试 `非 GREEN 来源不得标记为 CODE_REFERENCE` + `copyRestrictions()` 覆盖检查 | ✅ 无 |

### 8.4 Strategy Hallucination Audit（策略幻觉）

| 检查 | 方法 | 结果 |
|---|---|---|
| 是否有规则带 `magnitude` | 遍历 `strategy-rules.json` | ✅ **0 条**（12 条全部无幅度） |
| 是否有来源可推导量化数据 | 遍历注册表 `derivableQuantitativeData` | ✅ **0 个** |
| 「有幅度必须有数据」是否真的被强制 | 测试 `**核心断言**：来源无量化数据时，规则带 magnitude 必须被拒绝` | ✅ 抛出 `MAGNITUDE_WITHOUT_DATA`，且消息点明「这是编造」 |
| 报告中的数字是否有出处 | 逐个人工核对 + §8.2 逐字比对 | ✅ 全部为**被审计项目的自述**，且报告已逐处标注「未在本项目复现」 |

### 8.5 Scope Audit（范围混淆）

| 风险 | 处置 | 测试 |
|---|---|---|
| 锦标赛策略用于现金 | `book.mastering-small-stakes` 的 `notes` 明确写出「书名同时覆盖锦标赛与现金」，并声明**在完成范围区分之前禁止用于 `LOW_STAKES_ONLINE`** | `范围审计：每本书必须登记其适用的桌型 / 游戏类型` + `必须有一本书显式标注锦标赛/现金范围混淆风险` |
| Live 现金用于线上 | `book.live-no-limit-cash-games` 的 `notes` 明确标注是 **Live**，并要求案例入库时标 `gameType = LIVE_CASH` | 同上 |
| HU 求解器结论用于多路 | 三个求解器来源的 `limitations` 全部写明「仅单挑 / 不适用于多路」 | 注册表 `limitations` 必填校验 |
| 6-max 结论用于 9-max | `book.grinders-manual` 的 `limitations` 写明「仅 6-max 现金，不得套用 9-max 或单挑」；DCFR 来源写明「翻牌前求解器为 6-max MCCFR」 | 同上 |
| 深筹码结论用于浅筹码 | `poker_solver` 与 `GTOpen` 的 `limitations` 写明筹码深度范围 | 同上 |

### 8.6 Stakes Audit（级别误用）

| 检查 | 结果 |
|---|---|
| 有没有把 solver / 理论策略机械套到低级别的规则 | ✅ 无。`env.low-stakes-online-directional-only` 与 `env.mid-low-stakes-not-simply-less-bluff` 的证据等级为 `HEURISTIC`、confidence 为 0.3–0.35、**无 magnitude** |
| `THEORY_REFERENCE` 是否被当作可用参数来源 | ✅ 否。规则 `theory.no-solver-output-available` 明确其只是结构性假设 |

### 8.7 Result Bias Audit（结果偏差）

| 检查 | 方法 | 结果 |
|---|---|---|
| 规则文本是否有结果导向表述 | 正则扫 `因为(赢\|输\|结果)` / `摊牌证明` 等 | ✅ 知识库零命中（命中的三处都在**禁止性描述**里：`MURPHY_RISK_REGISTER.md` 的 G1/G2 是「禁止因为赢了就说决策正确」） |
| `CASE_TAXONOMY.md` 是否真的做到「结果不能定义类别」 | 人工复核 §4.2 / §4.3 | ✅ 明确写出「❌ 输了大底池 → Cooler」为禁止推理，并给出必须的分析流程 |
| Bad Beat 需要结果这一张力是否被处理 | 复核 §4.3 | ✅ 已显式处理：「判定核心是投入关键筹码时的权益」，必须先算权益再与结果比对 |
| `data/knowledge/cases/` 是否存在 | 目录检查 | ✅ **不存在**（报告声称未创建，实测一致）；不存在则无 Decision/Result 混装风险 |

### 8.8 自检发现并修复的问题

| # | 问题 | 严重度 | 处置 |
|---|---|---|---|
| 1 | 解析器字段级错误全部用 `MISSING_LIMITATIONS`（误导性诊断） | MINOR | 新增 `SCHEMA_FIELD_INVALID` 并逐处改正 |
| 2 | `CC-BY-SA-4.0`（copyleft）被归 RED，语义不准 | MINOR | 改为 YELLOW（与 GPL 同类）；同时补 SPDX `OR`/`AND`/`WITH` 与模糊 `BSD` 的处理 |
| 3 | 测试断言「没有任何来源包含量化数据」（测试自身写错） | MINOR | 改为断言「没有**可推导**量化数据」，并额外断言「确实有 ≥4 个来源**包含**数据」以证明两个字段真的不同 |
| 4 | Fail-Closed 引用跨行导致自检脚本报 `NOT FOUND` | INFO | 非缺陷；已以拼接形式呈现并在此记录核对过程 |
