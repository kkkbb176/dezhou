# GitHub 扑克项目技术审计报告（红队版）

> 审计对象：6 个指定扑克相关 GitHub 项目
> 审计目的：为「德州扑克决策与复盘训练系统 V1」提取**可借鉴的设计思想**，并标记**不可照搬项**
> 审计方法：web_search + GitHub REST API（api.github.com）+ raw.githubusercontent.com 原文抓取
> 撰写语言：简体中文

---

## 0. 证据等级约定（请务必先读）

本报告对**每一条断言**标注证据等级：

| 标记 | 含义 |
|---|---|
| 「已核实（附链接）」 | 我**实际抓取**了该 URL，内容支持该断言。含函数名、字段名、许可证全文等可引用原文。 |
| 「推测」 | 基于已核实的代码/文档所做的**推理判断**，不是原文直接陈述。可能出错。 |
| 「未能验证」 | **没有找到**可靠来源，或抓取失败。**不代表该事物不存在**。 |

**硬性诚实承诺**：不编造文件路径、许可证名称、star 数、代码片段。本文出现的具体数字与字段名，均来自实际抓取的 API 响应或源文件。

### 0.1 ⚠️ 审计过程的自我更正（重要，请先读）

**本报告第一稿曾错误地判定 `WizGTO` 与 `CoronaPoker`「不存在」。该判定是错的，现已更正。**

错误原因（诚实记录）：我最初依赖 `web_search` 的自然语言检索，而未直接调用 GitHub 搜索 API。GitHub 仓库搜索页是**客户端渲染**的，抓取 HTML 只得到导航样板、零结果行，因此给了我「找不到」的**假阴性**信号。改用 `api.github.com/search/repositories?q=...` 后，**两个项目都立即命中**。

> **方法论教训（已核实）**：对 GitHub 的检索，**必须使用 REST API**（返回 JSON），**不可依赖抓取 github.com/search HTML**。本报告全部搜索结论已改由 API 支撑。

**同时更正**：第一稿把 `CoronaPoker` 判定为「只是 FreeBSD 的扑克游戏」。这也**只对了一半**——它确实是一个游戏，但**其机器人子系统里的「性格建模」是真实存在且有文档的**（见 §5）。

---

## 1. 执行摘要

### 1.1 六目标命中情况

**六个项目全部找到。但其中三条的任务描述与项目实际情况不符**，这本身就是重要审计发现。

| # | 任务给出的名称 | 命中 | star | 许可证 | 描述是否准确 |
|---|---|---|---|---|---|
| 1 | `WizGTO` | ✅ `omkarxpatel/wizgto` | **1** | **Apache-2.0** | ⚠️ **偏窄**：不只是「训练工具」 |
| 2 | `Poker Hand Review` | ⚠️ 3 个同名仓库 | 6 | **MIT** | ⚠️ 名称非唯一 |
| 3 | `luckyone18/Poker` | ✅ 精确命中 | **0** | **无许可证** | ✅ 准确，**但含重大合规风险** |
| 4 | `CoronaPoker` | ✅ `tonikelope/coronapoker` | **22** | **GPLv3** | ⚠️ **误导**：首先是个游戏 |
| 5 | `texas_poker` | ❌ **未能验证** | — | — | ❌ **描述误植**（无此 coach 仓库） |
| 6 | `Poker Game Analyzer` | ✅ `96jsalinas/Poker-Game-Analyzer` | **4** | **MIT** | ✅ **准确** |

**关键判定（已核实）**：
- 第 5 项 `texas_poker`：**未能验证**存在名为 `texas_poker` 的「扑克教练/顾问架构」仓库。`texas_poker` 命名空间被游戏服务器、引擎与 RL 模拟器占据。**该描述疑似误植。**
- 第 1 项名称唯一：`q=WizGTO` 与 `q=wizgto+fork:true` 均返回 `total_count = 1`，即 GitHub 上**只有一个**该名仓库（已核实）。
- 第 4 项名称对应**三个**仓库（`q=coronapoker` → `total_count = 3`），实质项目是 `tonikelope/coronapoker`（已核实）。

### 1.2 两条最重要的结论

1. **合规红线是本次审计的头号发现。** `luckyone18/Poker` 的公开路线图规划在**真钱加密扑克平台部署反检测机器人**（已核实）。而 `omkarxpatel/wizgto` 的 README **自己承认**实时辅助「在对陌生人的任何牌局中都是作弊」（已核实）。→ 两者均须严格划界，见 §4.3、§2.4、§10。

2. **本项目需要的三项关键能力，各有一个可安全借鉴的真实范本：**

| 本项目需求 | 最佳范本 | 许可证 | 可借鉴性 |
|---|---|---|---|
| **EV 损失归因** | `matthiola0/poker-hand-review` | **MIT** | ✅ 可安全借鉴 |
| **样本量保护 + 性格建模 + tilt** | `tonikelope/coronapoker` `docs/BOTS.md` | **GPLv3** | ⚠️ **仅可借鉴思想**（copyleft） |
| **中文优先 + 事实/生成层分离** | `1killermouse/poker-mind-gto-lab` | **无** | ⚠️ **仅可借鉴思想** |

---

## 2. 项目一：`WizGTO`

### 2.1 命中情况 —— 「已核实（附链接）」

- 仓库：`omkarxpatel/wizgto` —— https://github.com/omkarxpatel/wizgto
- API 描述原文：`A No-Limit Hold'em engine that solves, models opponents, and plays its own hands.`
- **star 1**（watchers 1，forks 0，subscribers 0）
- 语言：**TypeScript**（含 Rust 服务端）；版本 1.9.0
- 创建 2026-07-23，最后推送 2026-08-18；默认分支 `main`；public、非 fork、非归档
- 搜索唯一性：`q=WizGTO` → `total_count 1`；`q=wizgto+fork:true` → 仍为 1

> **与 GTO Wizard 的区别（已核实）**：`gtowizard.com` 是**商业闭源 SaaS**（付费、登录墙）。WizGTO 是**独立的小型开源仓库**，与 GTO Wizard **无关**。
> **未能验证**：`api.github.com/search/repositories?q=gtowizard` 返回 **HTTP 403（未认证 API 限流）**，故**不能断言** GTO Wizard 没有开源仓库。

### 2.2 项目结构 —— 「已核实（附链接）」

来源：`api.github.com/repos/omkarxpatel/wizgto/git/trees/main?recursive=1`（`truncated: false`，完整树）：

```
bots/hu/            Dockerfile, entry.cjs, mock-match.mjs, src/*.ts   ← 单挑竞技场机器人
docs/               ARCHITECTURE.md, CONTEXT.md(35KB), HANDOFF.md,
                    ROADMAP.md, SOLVER_API.md, media/*, plans/*.md
eval/               pokerbench.mjs, pokerbench-postflop.mjs, slubot.mjs,
                    corpus.mjs, corpus-stats.mjs, score-predictor.mjs,
                    sweep.mjs, arena-logs.mjs                            ← 评测框架
extension/          dashboard.html, manifest.json,
                    src/{background,content,dashboard,gto,shared}/       ← Chrome MV3
server/             Cargo.toml, Cargo.lock, src/{main.rs(35KB), cache.rs(62KB), solver.rs}
CHANGELOG.md (120KB), CLAUDE.md, .claude/settings.json,
package.json, build.mjs, test.mjs
```

**观察（已核实）**：`server/cache.rs` 达 **62KB**，是全仓最大的源文件；`CHANGELOG.md` 达 **120KB**。`CLAUDE.md` 与 `.claude/settings.json` 存在，说明重度使用 AI 辅助开发。

### 2.3 主要功能 —— 「已核实（README 声明，但我未运行任何代码）」

**四种产品形态（这是理解该项目的关键）**：

1. **自主单挑竞技场机器人**（`bots/hu/`，Docker）
2. **训练器**——与「真实玩家的模拟替身（simulacra）」对练
3. **分析仪表盘**——含**Wilson 95% 置信区间门控的漏洞检测**
4. **实时学习浮层**（Chrome MV3 扩展）

**技术能力（README 声明）**：
- Rust 翻后求解器，**封装 `b-inary/postflop-solver`**（该依赖为 **AGPL-3.0**，见 §2.6）
- 蒙特卡洛权益计算
- **对手建模**：从捕获的手牌统计 VPIP/PFR/3-bet、c-bet、barrel、fold-vs-c-bet、WTSD、**下注尺度与时间节奏破绽（timing tells）**，并带 **shrinkage（收缩估计）** 与 **provenance labels（来源标注）**
- 自报指标（**均为自述，未执行验证**）：1,021 次摊牌上 1.83× 几何平均提升；PokerBench 翻前一致率 96.6%；决策 <250ms；171 个测试

**⭐ 最有价值的已核实发现（诚实边界自述）**：

> README **明确警告**：实时辅助**违反 PokerNow 的服务条款**，且「**is cheating in any game against strangers or for stakes**」（在对陌生人的任何牌局中、或有赌注时都是作弊）。仅限**经同意的私人牌桌**或复盘用途。

> README 另承认：**求解器无法用于实时对局**——机器人容器只给 256MB 内存且无网络出口，而求解器每次翻牌需 **20–35 秒与约 1GB 内存**。

**第三方依赖（已核实）**：所谓「排名竞技场」是**第三方平台**——`package.json` 的 devDependency 为 `@chipzen-ai/bot@^0.3.0`，环境变量为 `CHIPZEN_WS_URL` / `CHIPZEN_TOKEN` / `CHIPZEN_MATCH_ID`，即 **ChipZen** 平台，而非 WizGTO 自有。

### 2.4 可借鉴模块（**思想层**）

| 模块 | 借鉴点 | 证据 |
|---|---|---|
| `eval/pokerbench*.mjs` | **用公开基准（PokerBench）量化翻前一致率**，而非凭感觉 | 已核实（文件树） |
| **Wilson 95% 置信区间门控漏洞检测** | ⭐ **漏洞检测必须过统计显著性门槛才报出**。这直接回答「样本量保护」问题 | 已核实（README） |
| **shrinkage（收缩估计）** | ⭐ 对手统计向基线收缩，避免小样本极端值 —— 与 §4.9 `decay` 同源思想 | 已核实（README） |
| **provenance labels（来源标注）** | ⭐ 每个对手结论标注**数据来源与可信度**，而非输出裸结论 | 已核实（README） |
| **timing tells（时间节奏）** | 真人非理性行为的**可观测代理变量**（行动耗时） | 已核实（README 声明有此功能） |
| **四形态分层**（机器人/训练器/分析/浮层） | 同一内核，多种交付面 | 已核实（文件树） |
| `server/cache.rs`（62KB 缓存层） | 求解结果缓存的工程化 | 已核实（文件树） |

### 2.5 不适合我们的功能 / 禁止照搬

| 项 | 理由 |
|---|---|
| **Chrome 扩展实时浮层（`extension/`）** | **直接违反本项目合规范式**。ARCHITECTURE.md §8.4 M28：不做任何自动读取牌桌/实时辅助功能，架构上不留接口。项目 README 自己也承认这是作弊。 |
| **自主竞技场机器人（`bots/hu/`）** | 同上，属「代替玩家操作」。 |
| **依赖第三方平台（ChipZen）** | 引入外部平台依赖与账号凭据管理（`CHIPZEN_TOKEN`），本项目不需要。 |
| **封装 AGPL-3.0 求解器** | **推测**：直接链接/封装 AGPL 库可能触发网络服务开源义务，见 §2.6。 |
| **照抄其代码** | 许可证虽为 Apache-2.0（宽松，可借鉴），但**本项目不需要它的实时形态**；且其指标未经第三方验证。 |

### 2.6 潜在 Bug / 技术债 —— 「推测」为主

| # | 项 | 说明 |
|---|---|---|
| W-1 | **全部质量指标未经独立验证** | 1.83× 提升、96.6% 一致率、171 测试**均为 README 自述**（已核实为自述）。**推测**：无第三方复现，数字可信度未知。 |
| W-2 | **star 仅 1、创建仅约 1 个月** | 已核实。**推测**：未经社区检验，正确性不应被视为权威。 |
| W-3 | **AGPL 依赖传染风险** | 已核实其求解器**封装 `b-inary/postflop-solver`（AGPL-3.0）**。**推测**：若其对外提供服务，可能触发 AGPL 网络条款；本项目若模仿此架构亦有同样风险。 |
| W-4 | **`timing tells` 的伦理与误判风险** | **推测**：行动耗时受网络延迟、多桌、思考习惯影响，**高噪声**。若纳入对手模型需强收缩，否则引入伪相关。 |
| W-5 | **实时浮层与「仅限私人牌桌」的边界模糊** | **推测**：README 限定了用途，但技术上扩展无法区分场景，存在被滥用的现实风险。 |
| W-6 | **大文件信号** | `cache.rs` 62KB、`CHANGELOG.md` 120KB、`CONTEXT.md` 35KB（均已核实）。**推测**：单文件过大，维护成本高。 |

### 2.7 技术债信号（已核实）

- star 1 / fork 0 / watcher 1
- 创建 2026-07-23 → 最后推送 2026-08-18（**活跃期约 4 周**）
- `CLAUDE.md` + `.claude/settings.json` 存在 → AI 辅助开发痕迹
- 版本 1.9.0 但 `CHANGELOG.md` 已 120KB → **推测**：迭代极快，可能以自动生成方式堆叠变更记录

### 2.8 许可证 —— 「已核实（附链接）」

**Apache License, Version 2.0**。三重独立证据：

1. 我方的 LICENSE 文件抓取（首次传输错误，**重试 200**）：LICENSE blob **11,341 字节**，附录为 `Copyright 2026 Omkar Patel ... Licensed under the Apache License, Version 2.0`
2. `api.github.com/repos/omkarxpatel/wizgto` → `license.spdx_id = "Apache-2.0"`
3. README 徽章

> **Apache-2.0 是宽松许可证且含专利授权**，是本报告 6 个目标中**法律风险最低**的之一（另有 MIT 的 REF-A / REF-F）。

### 2.9 可借鉴设计（提炼）

1. **⭐ Wilson 95% CI 门控的漏洞检测** —— 把「统计显著性」做成漏洞报告的**前置闸门**。这是本项目「样本量保护」最直接、最可落地的范本。
2. **⭐ shrinkage（收缩估计）** —— 小样本对手统计向总体基线收缩，天然抗「10 手贴标签」。
3. **⭐ provenance labels** —— 每个结论携带来源与置信度元数据，让渲染层**无法隐藏**不确定性。
4. **求解结果缓存层独立成模块**（`cache.rs`）—— 性能与正确性解耦。
5. **诚实的用途边界声明** —— README 主动写明能力限制与合规红线，值得本项目在文档层面效仿。

---

## 3. 项目二：`Poker Hand Review`

### 3.1 命中情况与歧义说明

「Poker Hand Review」**不是唯一仓库名**。`q=poker hand review` 返回 `total_count 44`，其中同名/近名仓库至少 4 个（**均已核实** API 元数据）：

| 仓库 | star | 语言 | 许可证 | 说明 |
|---|---|---|---|---|
| **`matthiola0/poker-hand-review`** | 6 | Python | **MIT** | **GTO 逐决策评级**，最匹配描述 |
| `skeldol/PokerHandReviewer` | 0 | Java | **无** | 无描述，2020 年归档式停更 |
| `iburigakko-picoloom/poker-hand-review` | 0 | — | **无** | **空仓库（size: 0）** |
| `DevKabigon/poker-hand-review` | 0 | TypeScript | **无** | 韩文 Web 复盘站 |

> **歧义声明**：任务描述的「poker hand history review tools」是**类别**而非单一仓库。我选择 `matthiola0/poker-hand-review` 为主参考，理由是**只有它同时具备 GTO 评级、EV 损失、漏洞聚合三项能力**，且许可证明确。**这是我的解释性选择（推测）。**

### 3.2 项目结构 —— 「已核实（附链接）」

来源：`raw.githubusercontent.com/matthiola0/poker-hand-review/main/README.md`（原文照录）：

```
poker-hand-review/
├── src/poker_hand_review/      core engine
│   ├── parser/         hand-history text parsing
│   ├── enrich/         Hero-view derivation (position, effective stack, decision nodes)
│   ├── gto/            preflop GTO range charts (8-max MTT, four-action)
│   ├── evaluate/       per-decision grading + pluggable postflop backends
│   ├── analysis/       equity / stats / leak aggregation
│   ├── profile/        opponent profiling
│   └── report/         CLI colored output + JSON export
├── web/                static Web UI (SPA) + local server endpoints
├── docs/               solver adapter contract + translations
├── data/               example hand histories
├── tools/              TexasSolver adapter; preflop chart import script
└── tests/              tests
```

技术栈（**已核实**）：Python 3.11+、pytest、ruff（行长 100）、**mypy strict**、GitHub Actions CI。已有**简体中文 / 繁体中文 README**（`docs/i18n/README.zh-CN.md`）。

### 3.3 主要功能 —— 「已核实（附链接）」

- **逐决策 GTO 评级**：每个 Hero 决策点单独隔离，按相对 GTO 的 EV 损失着色 → 🟢 fine / 🟡 inaccuracy / 🔴 mistake
- **统计**：GTO 准确率、**每 100 手 EV 损失**、VPIP / PFR / 3Bet / C-bet、**分位置净收益**
- **对手画像**：聚合对手倾向、给出针对建议，并**将假定范围回灌到翻后权益计算**
- **交互式 Web UI**：逐街回放、多维筛选、漏洞与画像下钻
- **可插拔翻后引擎**：默认启发式；可外接 CFR 求解器
- **范围边界诚实**：**仅支持 Natural8 / GGPoker 锦标赛**；明示其他站点与现金局不支持
- **解析器容错原则**：已知 token 严格解析，**无法识别的行记入 `raw_unparsed` 警告而非中止整个文件**

### 3.4 潜在 Bug / 正确性风险 —— 「推测」（基于已核实原文）

| # | 风险 | 依据 |
|---|---|---|
| A-1 | **翻前「按频率接受」掩盖错误** | 已核实原文：「any action the chart plays with ≥5% frequency is accepted」。**推测**：≥5% 频率容差会把「低频率但高 EV 损失」的动作判为正确 → **评级与 EV 损失两套标准可能互相矛盾**。 |
| A-2 | **`ev_loss_bb` 语义混淆** | 已核实 WARNING：「Without a solver, `ev_loss_bb` is an engine **estimate**」。**推测**：`_bb` 后缀易被下游当精确值。**建议本项目改名为 `evLossEstimate` 并强制携带 `confidence` 与 `method`**。 |
| A-3 | **求解器节点缺少位置信息（官方承认）** | 已核实原文：「but **not** who is in position. The adapter therefore models **Hero in position**」。**推测**：Hero 实际无位置时建议会**系统性偏松**。项目自己提出需 contract v2。 |
| A-4 | **多人底池被降维成单挑** | 已核实：适配器「A single villain bet size ≈ `to_call`」「Villain OOP with a preset range」。 |
| A-5 | **对手范围仅 4 档静态键** | 已核实契约字段 `"villain_range_key": "tight"`，取值 `tight`/`balanced`/`wide_passive`/`wide_aggressive`。**推测**：粒度过粗，放大 A-3。 |

### 3.5 可借鉴模块 / 可借鉴设计（**最高性价比**）

1. **⭐ `ev_loss_bb` + 三档分级（good / inaccuracy / mistake）** —— 「把输钱最多改成 EV 错误最大」的**现成工业范式**，详见 §8.2。
2. **⭐ 漏洞聚合三元组** —— 已核实 README：「Recurring mistakes: **count, cumulative EV loss, hands involved**」。漏洞 =（出现次数，累计 EV 损失，涉及手牌）。
3. **⭐ `enrich/` 独立层** —— 把「从原始手牌历史推导 Hero 视角（位置、有效筹码、决策节点）」抽为**独立模块**。**解析（parser）与语义推导（enrich）解耦**是极佳的关注点分离。
4. **⭐ 进程外 JSON 契约适配器** —— 默认启发式后端与精确求解器后端**同接口互换**，求解器通过外部进程 + JSON stdin/stdout 交互（`{"contract": "poker_hand_review.solver_node.v1", ...}`）。**同时解决**：性能分层、依赖隔离、**AGPL 传染隔离**。
5. **解析器容错原则** —— 已知严格、未知记警告不中止。
6. **诚实降级** —— 无求解器时主动警告数值仅作「severity guidance」。

### 3.6 不适合我们的功能

| 功能 | 不采纳理由 |
|---|---|
| 仅支持 GGPoker/Natural8 格式 | 本项目做**手动录入 + 中文优先**，不依赖第三方站点导出格式（避免长期解析器维护债） |
| 8-max MTT 翻前图表 | 本项目范围为 **NLHE 现金局 6 人桌 / 9 人桌**（ARCHITECTURE.md §1.1），**桌型与赛制均不匹配** |
| 锦标赛（ICM）专属逻辑 | 同上，本项目为现金局 |
| 把 `ev_loss_bb` 当精确值输出 | 违反本项目第一性原理第 3 条（禁止编造数字） |

### 3.7 技术债信号

- **star 6、fork 1**（已核实）→ **未经社区检验**，不应当作正确性权威
- README 提 `CLAUDE.md` 为真源、`AGENTS.md` 由 hook 自动同步（已核实）→ **推测**：AI 辅助开发
- 版本 `0.1.0`、状态徽章 `M1–M7 core done`（已核实）→ 早期项目
- **反面优点**：有 CI、`mypy strict`、ruff、pytest —— 工程质量**明显高于**本报告其他目标

### 3.8 许可证 —— 「已核实（附链接）」

**MIT License**。两处独立证据：

1. `raw.githubusercontent.com/matthiola0/poker-hand-review/main/LICENSE` → 读到全文，开头：`MIT License / Copyright (c) 2026 poker-hand-review`
2. `api.github.com` → `"license": {"key": "mit", "spdx_id": "MIT"}`

---

## 4. 项目三：`luckyone18/Poker`

### 4.1 命中情况 —— 「已核实（附链接）」

来源：`api.github.com/repos/luckyone18/Poker`

| 字段 | 值 |
|---|---|
| `description` | Texas Holdem NLHE AI engine with 9 bot types: Monte Carlo, PPO RL, MCCFR, GTO, ICM, opponent modeling, exploitative, heuristic, ML. Self-play training pipelines. |
| `language` | Python |
| `stargazers_count` / `forks_count` | **0 / 0** |
| `created_at` / `pushed_at` | 2026-05-14 / 2026-05-19（**活跃期约 5 天**） |
| **`license`** | **`null`（无许可证）** |
| `size` | 3108 KB |

### 4.2 项目结构 —— 「已核实（附链接）」

来源：`api.github.com/repos/luckyone18/Poker/git/trees/main?recursive=1`（完整树，对照 README）：

```
core/                engine.py / bot_api.py / logger.py
bots/                9 bots + __init__.py(factory) + poker_mlp.py + swc_parser.py
  monte_carlo_bot.py / poker_mind_bot.py / ml_bot.py / rl_bot.py /
  cfr_bot.py / icm_bot.py / exploitative_bot.py / gto_bot.py / opponent_model_bot.py
training/            train_ml_bot.py / train_rl_bot_selfplay.py /
                     train_multi_deep_rl_bot.py / train_cfr_bot_multiway.py /
                     train_bc.py / train_rl_omc.py / generate_bc_dataset.py / retrain_from_hands.py
models/              optimized_mc_config.json（README 所称 five_card_table.pkl 不存在）
docs/                money-maker-roadmap.md / plans/2026-05-15-poker-master-plan.md
scripts/             hand_history.py / benchmark_*.py / optimize_monte_carlo.py
research/            swc_poker_research.md
hand_histories/      hands_20260514_231144.jsonl（样本数据已入库）
benchmarks/          7 个 JSON 基准结果
output/              ~40 张 PNG + m5_benchmark_results.txt + test_results.csv
根目录                6 个 train_rl*.py / stage4_run.py / modal_train.py /
                     run_tournament*.py / sanity_test_*.py / benchmark_m5.py /
                     TRAINING_PLAN.md / HARDWARE_BENCHMARK.md
```

**已核实的重要观察**：根目录**混放 6 个 `train_rl*.py` 与 `stage4_run.py`**，与 `training/` 目录职责重叠 → 明确的**结构腐化信号**。

### 4.3 ⚠️ 重大合规警告 —— 必读

**已核实（附链接）**：`raw.githubusercontent.com/luckyone18/Poker/main/docs/money-maker-roadmap.md` 标题为 **"Poker Bot — Money Maker Roadmap"**，原文包含：

- 「**Goal:** Generate consistent profit from crypto poker (SWC Poker / swcpoker.com)」
- 「**Phase 3 — SWC Poker Integration**: Goal: **Bot plays real money on SWC Poker**」
- 「**3.1 SWC Reverse Engineering** ... Capture SWC Poker network traffic (Chrome DevTools)」
- 「**4.3 Anti-Detection** ... Randomized timing (not robotic precision) / Occasional "human-like" folds/calls / **Use residential proxy, not datacenter IP**」
- 「**Critical Risks** table: SWC detects & bans bot | **High** | Mitigation: Residential proxy, timing randomization」
- 「**Financial target:** $10-50/day profit at launch」

> **审计判定：这是「在真钱博彩平台部署反检测机器人」的完整实施规划。**
> 本项目 ARCHITECTURE.md §0 已明确「**明确不做**：读取第三方客户端、识别在线牌桌、自动点击下注、代替玩家操作、绕过平台规则」，且 §8.4 M28 要求「架构上不留接口」。
> **因此本仓库的 SWC 集成部分（`bots/swc_parser.py`、`scripts/hand_history.py` 的 SWC 部分、`research/swc_poker_research.md`、Phase 3/4 全部内容）必须整体禁止借鉴。**
> 本报告仅出于**审计完整性**记录该事实，**不提供该部分任何技术细节**。

**风险不对称提醒**：引入该仓库任何代码都可能把合规红线带进本项目代码库。**建议：不复制其任何代码，仅参考抽象概念且必须独立重写。**

### 4.4 主要功能 —— 「已核实（附链接）」

- **9 种 Bot**：MonteCarlo / SmartBot(启发式) / ML(26 特征 MLP) / RL(PPO+GAE) / CFR(MCCFR) / ICM(Malmuth-Harville) / Exploitative / GTO / OpponentModel(贝叶斯范围)
- **游戏引擎**：完整手牌生命周期、边池、摊牌、底池分配；预计算 5 张查表
- **训练管线**：监督学习、自博弈 PPO 课程、多人 PPO、6 人深筹码 CFR
- **锦标赛 UI**：matplotlib（README 明示「**No web UI**」）
- **决策日志**：JSONL 逐决策记录

### 4.5 可借鉴模块（**仅架构与概念**）

| 模块 | 借鉴点 | 证据 |
|---|---|---|
| `core/bot_api.py` | `Action` / **`PlayerView`（只读、不含对手底牌）** / `BotAdapter(act(state)->Action)` 最小接口契约 | 已核实（README） |
| `bots/opponent_model_bot.py` | **先验 × 似然 → 归一化**后验更新；按街分离似然表 | 已核实（源码） |
| `bots/exploitative_bot.py` | `_MIN_SAMPLE = 5` 才启用利用；`confidence = min(1.0, hands/20)` **线性放大利用强度** | 已核实（源码） |
| `scripts/hand_history.py` | `HandRecord` / `DecisionPoint` dataclass 分层 | 已核实（源码） |
| `OpponentModelBot.get_opponent_range()` | 返回**可读概率字典**（bucket→概率）供解释 | 已核实（源码） |

### 4.6 潜在 Bug —— 「已核实」+「推测」

#### B-1（已核实，确定性缺陷）`_on_winner` 恒返回 `None`

`scripts/hand_history.py`：

```python
def _on_winner(self, msg):
    if self.collector._current_hand is None:
        return None
    self.collector.end_hand(...)          # end_hand 内部执行 _current_hand = None
    return self.collector._current_hand   # ← 此时必然已是 None
```

`end_hand()` 内部将 `_current_hand = None`，故该函数**永远返回 `None`**，但语义是「返回已完成的 HandRecord」。**已完成的手牌记录不可获取。**

#### B-2（已核实，确定性缺陷）权益估算分母错误 —— **最严重的数学缺陷**

`bots/opponent_model_bot.py` 的 `_estimate_equity_vs_ranges`：

```python
total = wins + ties * 0.5
return total / max(sims, 1)
```

循环内多处 `continue`（对手牌不足、剩余牌不够发公共牌），**被跳过的模拟不计入 `wins/ties`，却仍计入分母 `sims`** → **权益被系统性低估**。

`bots/exploitative_bot.py` 的 `_hand_strength` 有**完全相同**的写法 → 同一缺陷复制到两个 Bot。

**影响（推测）**：多人底池跳过率随对手数上升，权益低估加剧 → Bot **过度弃牌**。这可能是路线图自述「RL training broken (1% WR vs SmartBot)」的**部分**原因（不能证明是全部原因）。

#### B-3（已核实，逻辑缺陷）「面对攻击」统计口径错误

`bots/exploitative_bot.py` `_OppProfile.record_action` 原文：

```python
#   We approximate "facing aggression" heuristically:
#   Every call or fold implicitly means the player faced a bet/raise; every check does not.
if action_type in ("call", "fold"):
    self.aggression_faced += 1
    if action_type == "fold":
        self.folds_vs_aggression += 1
```

**问题**：翻前大盲「无人加注时的跟注/过牌」并不构成面对攻击，却被计入 FTA 分母 → **FTA 被系统性污染**，影响 `is_high_fta()`（阈值 0.55）。代码自承这只是 "approximate"。

#### B-4（已核实，README 自曝）训练/推理特征不一致

README「Known Limitations」**自曝**：

> 「**ML bot feature alignment** — there are minor mismatches between feature encoding at training time and inference time (normalization, memory windowing)」

同段另承认：「**No position encoding in CFR info-sets**」—— CFR 无法区分 BTN/BB。对一个号称 GTO 的 Bot，这是**结构性缺陷**。

#### B-5（推测）`_seen_entries` 无界增长

`exploitative_bot.py` 的 `self._seen_entries: set[tuple]` 只增不减。**推测**：长会话内存单调增长；且键含 `seq = entry.get("seq", id(entry))`，`id()` 在对象回收后可能重用 → **潜在去重失效**。

#### B-6（推测）概率桶宽度未归一化导致后验偏移

似然表让 `premium` 桶获 >1 权重，但 `_sample_hand_from_range` 在桶内**均匀采样**，而各桶实际组合数差异巨大。**推测**：即便对手打得很松，后验也会系统性向 premium 漂移 —— 似然表**未按桶宽（组合数）归一化**。

#### B-7（推测）位置未进入似然/范围模型

更新只用 `entry["type"]` 与 `entry["street"]`，**未用位置**。同一动作在 UTG 与 BTN 含义完全不同 → 范围估计失真。

### 4.7 技术债信号（**本仓库最严重**）

| 信号 | 证据（已核实） |
|---|---|
| **无许可证** | API `license: null`；`/LICENSE` 返回 **HTTP 404** |
| **0 star / 0 fork，活跃期约 5 天** | API 字段 |
| **作者自述核心功能已损坏** | roadmap 原文：「RL training pipeline (**BROKEN - 1% WR**)」「After 10K RL training, drops to **0.5%** vs SmartBot」 |
| **文档承诺 > 实现** | roadmap 称「SWC parser is **skeleton only**」 |
| **文档引用不存在的文件** | roadmap 引用 `docs/rl-training-debug-log.md`，该文件**不在 Git 树中**（已核实） |
| **README 与实现脱节** | README 称 `models/five_card_table.pkl`（~45MB）存在，但 `models/` **仅有** `optimized_mc_config.json`（60 字节） |
| **根目录脚本散乱** | 6 个 `train_rl*.py` 与 `training/` 职责重叠 |
| **产物入库** | `output/` 提交 ~40 张 PNG；`hand_histories/` 提交样本数据 |
| **疑似重复产物（推测）** | `bench_v3_final_run1..5.png` **SHA 完全相同**（`024831a96004...`，已核实）→ 5 次「独立运行」实为同一文件 |
| **合规债** | §4.3，最高级别 |

### 4.8 许可证 —— 「已核实（附链接）」

**该仓库没有许可证。** 两处独立证据：

1. `api.github.com/repos/luckyone18/Poker` → `"license": null`
2. `raw.githubusercontent.com/luckyone18/Poker/main/LICENSE` → **HTTP 404**

> **推测**：无许可证默认适用**保留所有权利**，复制/修改/再分发缺乏授权基础。
> **未能验证**：我未逐一枚举 9 个 bot 源文件头部，**不能 100% 排除**某文件内嵌 license 声明。但**根目录无 LICENSE 已核实**。

### 4.9 禁止照搬设计

| 禁止项 | 理由 |
|---|---|
| **SWC / 真钱平台集成、反检测、代理规避** | §4.3。触碰本项目 §8.4 M28 合规红线。**架构上不留接口。** |
| **照抄该仓库代码** | 无许可证（保留所有权利）。需**独立重写**。 |
| **`total / sims` 式权益估算** | B-2 确定性缺陷。必须用 `valid_sims` 作分母并输出置信区间。 |
| **「call/fold ⇒ 面对攻击」的 FTA 口径** | B-3 逻辑缺陷。 |
| **桶内均匀采样 + 未归一化似然表** | B-6 建模偏差。 |
| **matplotlib 本地 UI** | 与本项目「中文优先 + 架构支持未来 Web」不符。 |

### 4.10 可借鉴设计（提炼）

1. **⭐ `PlayerView` 只读且不含对手底牌** —— 从**接口层面物理隔离**上帝视角，防止信息泄漏污染决策。极佳的不变量设计。
2. **⭐ `confidence = min(1.0, hands / 20)` 线性缩放** —— 把样本量变成**连续可乘系数**，比硬阈值平滑。
3. **似然表按街分离**（`PREFLOP_LIKELIHOODS` vs `POSTFLOP_LIKELIHOODS`）。
4. **⭐ 每手向均匀分布衰减**（`decay = 0.85`）—— **跨手记忆不遗忘、但会淡忘**。直接回答设计问题 5。
5. **`get_opponent_range()` 返回人类可读概率字典**。

---

## 5. 项目四：`CoronaPoker` —— **本次审计最重要的更正**

### 5.1 命中情况：名称对应**三个**仓库 —— 「已核实（附链接）」

`api.github.com/search/repositories?q=coronapoker` → **`total_count = 3`**：

| 仓库 | star | 语言 | 许可证 | 说明 |
|---|---|---|---|---|
| **`tonikelope/coronapoker`** | **22** | Java | **GPLv3** | ⭐ **实质项目**，P2P 心理扑克游戏 + 机器人性格建模 |
| `derek28/coronapoker` | 2 | C++ | **无** | 真正叫「AI」的：神经网络 EHS 单挑智能体，2020 起休眠 |
| `joycollector/coronapoker` | 0 | JavaScript | **无** | 仅名称匹配，内容未查 |

**FreeBSD ports 的 `games/coronapoker` 对应的是 `tonikelope/coronapoker`**（FreshPorts 列出的 WWW 即该仓库）—— 已核实。

### 5.2 `tonikelope/coronapoker` 详细审计

#### 5.2.1 项目性质 —— **这是理解该项目的关键**

**「已核实」**：该项目**首先且主要**是一个**点对点、零信任、心理扑克（mental poker）德州扑克游戏**。

- 22 stars，forks 2，Java 17+，默认分支 `master`，`pom.xml` 版本 24.10（`com.tonikelope:CoronaPoker`，mainClass `com.tonikelope.coronapoker.Init`）
- 创建 2020-08-12，最后推送 2026-08-26（**长期活跃，6 年**）
- topics（已核实）：`dleq-proof`, `ecdh`, `ed25519`, `mental-poker`, `p2p`, `ristretto255`, `sra`, `texas-holdem`, `zero-trust`, `zero-trust-architecture`
- 已核实技术：SRA / Ristretto255 + **Bayer-Groth 可验证洗牌** + Ed25519 身份 + 哈希链收据 + ECDH/AES-256-CBC+HMAC 信道 + SQLite 崩溃恢复 + UPnP P2P

> **判定**：任务描述「**poker AI / player personality modelling**」作为**首要描述是误导性的**——该仓库的主体是密码学 P2P 游戏。
> **但**：其**机器人子系统的「性格建模」是真实存在且有详细文档的**（见下），**并非杜撰**。
> **因此两种极端说法都只对一半**：它**不是**「性格建模研究项目」，但**也绝不是**「只是个扑克游戏」。

#### 5.2.2 ⭐ 性格建模 —— 「已核实（附链接）」

来源：`raw.githubusercontent.com/tonikelope/coronapoker/master/docs/BOTS.md`（**含一个明确命名的「§4 Personality model」章节**）：

| 机制 | 内容（已核实） |
|---|---|
| **三轴模型** | **Difficulty**（EASY / MEDIUM / HARD）× **Skill**（RECREATIONAL / REGULAR / SHARK）× **Profile**（**NIT / STATION / TAG / LAG**），**级联掷骰**决定 |
| **文档化的技能配比** | EASY 60/32/8、MEDIUM 25/55/20、HARD 0/35/65 |
| ⭐ **性格弹性（profile elasticity）** | **按手牌自适应**：依据 **M-ratio** 与 **TILT** 调整 —— 短筹码 → 转 push/fold TAG；**tilted recreational → 转 LAG** |
| **跨手记忆** | `OpponentTracker` 存于**会话级** `TRACKER_MEMORY` map，统计 VPIP/PFR/AF |
| **原型判定** | `isStation()` / `isNit()` / `isManiac()`，**>10 手后启用**；另有一个早期快速读数 `looksPassiveStation()` |
| **错误注入校准** | HARD **0%** / MEDIUM **22%** / EASY **45%** |
| **河牌诈唬频率** | HARD **38%** / MEDIUM **14%** / EASY **0%** |
| ⭐ **诚实自述** | 原文：「The bot is a hand-crafted heuristic, **not a solver**. It does **not** run CFR and it does **not** compute equity against per-opponent ranges.」 |

> **这是本次审计在「玩家性格建模」「样本量保护」「tilt 动态状态」三个问题上找到的**唯一真实实现**——而且它**自己承认不是求解器**，边界划得很清楚。

#### 5.2.3 ⚠️ 重大安全发现 —— 「已核实」

**FreeBSD `games/coronapoker` 已于 2026-04-25 被删除**（已核实 FreshPorts "Port Moves"）：

> 「REASON: **Remove for security concerns**: downloads closed source binary modules, should not be restored unless https://github.com/tonikelope/coronapoker/issues/7 is addressed」

详情（已核实）：CoronaPoker 曾内置 **"Panoptes"——一个闭源密码学反作弊引擎**，**在运行时从 GitHub 下载**、缓存到 `~/.coronapoker/Panoptes/`、并**通过 JNI 加载**。这构成 **GPLv3 违规**。FreeBSD 端口被打了补丁以**禁用远程下载与本地原生加载**，代价是失去防篡改检测、区块链验证与审计能力。端口 2020-09-05 加入（维护者 yuri@FreeBSD.org），最高版本 20.28，而上游 `pom.xml` 已是 24.10（**端口严重落后**）。

**未能验证**：README 现宣称纯 Java SRA「no native crypto dependencies」，与 Panoptes 移除一致；但**我无法验证 Panoptes 在上游被移除的时间与方式**，也**未能阅读 issue #7**。

#### 5.2.4 许可证 —— 「已核实（附链接）」

**GNU General Public License, Version 3（GPLv3）**。三重独立证据：

1. LICENSE 文件抓取：`GNU GENERAL PUBLIC LICENSE / Version 3, 29 June 2007`，LICENSE blob **35,151 字节**
2. FreshPorts 标注 `License: GPLv3`
3. README 徽章

> **⚠️ GPLv3 是强 copyleft。推测**：**不可**将其代码并入本项目（除非本项目也以 GPLv3 开源）。**仅可借鉴不受版权保护的「思想与方法」**（如三轴性格模型、M-ratio/tilt 弹性、10 手门槛）。

### 5.3 `derek28/coronapoker` 详细审计 —— 「已核实（附链接）」

这是三个同名仓库中**真正做 AI** 的一个：

- 2 stars，C++，**无许可证**（API `license: null`，无 LICENSE 文件），创建 2020-03-31，最后推送 2020-06-28（**已休眠 4 年**）
- README 原文：`Highly efficient Texas Hold'em simulation framework, with AI created during the great COVID-19 epidemic, by JWang925 and Kai.`
- 运行：`./humanvsbot <n>`；可选 Qt `./PokerGUI`
- 扩展方式：**派生自基类 `Player`**
- 文件（已核实递归树）：`card/deck/pokerhand/strength/ehs_player/human_player/random_player/player/game/misc`（.cpp+.h）、`server.cpp/h`、`humanvsbot.cpp`、`Makefile`、`FEATURETOADD.md`、**`nn_weights/{weight1.txt 120KB, weight2.txt 131KB, weight3.txt}`**、`PokerGUI/`（Qt + SVG 牌面）
- **`ehs_player` = Expected Hand Strength + 神经网络，仅单挑**
- **作者自述限制**（已核实原文）：「**Only headsup is functional**」；多人需更好的底池大小加注计算与边池；**每手必须从 100bb 开始**
- **未发现任何性格建模** —— **未能验证**其有 personality modelling

**可借鉴点**：**权重以纯文本形式入库（`nn_weights/*.txt`）** —— 便于版本控制、人工审查与跨平台加载，无需二进制依赖。**这是轻量模型的实用工程做法。**

### 5.4 潜在 Bug / 技术债 —— 「推测」+「已核实」

| # | 项 | 类型 | 说明 |
|---|---|---|---|
| C-1 | **闭源 JNI 模块运行时下载** | 已核实 | Panoptes 事件。**推测**：任何「运行时下载闭源二进制并 JNI 加载」的模式都是**供应链与许可证双重风险**，必须禁止。 |
| C-2 | **端口严重落后上游** | 已核实 | FreeBSD 端口 20.28 vs 上游 24.10。**推测**：分发渠道维护滞后。 |
| C-3 | **性格判定的 10 手门槛是否足够** | 推测 | `isStation()/isNit()/isManiac()` 在 **>10 手**后启用。**推测**：10 手对 VPIP 类统计仍偏少（见 §8.1），可能过早贴标签。项目另设 `looksPassiveStation()` 作早期快速读数，但**推测**该读数噪声更大。 |
| C-4 | **错误注入使难度参数与真实水平混淆** | 推测 | MEDIUM 注入 22%、EASY 45% 错误。**推测**：若用这些 bot 生成训练数据，需显式记录注入率，否则学习的策略分布被污染。 |
| C-5 | **`derek28` 侧：仅单挑、固定 100bb** | 已核实 | 作者自述。**推测**：架构无法直接扩展到多人/深筹码，参考价值限于单挑 EHS。 |
| C-6 | **`derek28` 侧：无许可证** | 已核实 | 不可复制代码。 |

### 5.5 可借鉴设计（**思想层，GPLv3 代码不可抄**）

1. **⭐ 三轴性格模型（Difficulty × Skill × Profile）** —— 把「对手类型」拆成**能力 × 风格**两个正交维度，避免一维标签的信息坍缩。**本项目 §2.7 的 11 种类型词表可借鉴此正交化思路。**
2. **⭐⭐ tilt 的产品化处理方式** —— **tilt 只改变「profile 弹性」（recreational → LAG），不改变数学**。这是**本次审计对「情绪如何安全进入系统」唯一找到的真实实现**，且其做法恰好符合「情绪不得污染数学」的原则。详见 §8.4。
3. **⭐ 手牌级动态调整（M-ratio 驱动）** —— 筹码深度变化触发风格切换（短筹码 → push/fold TAG）。**本项目可借鉴为「有效筹码深度 → 策略模式」映射。**
4. **⭐ 跨手会话记忆 + 显式门槛**（`TRACKER_MEMORY` + >10 手）—— 记忆与置信门槛的工程化。
5. **诚实的能力边界自述** —— 「not a solver, does not run CFR」。**本项目「知道自己什么时候不知道」的同类实践。**
6. **`nn_weights/*.txt` 纯文本权重** —— 轻量模型的可审查、可版本化部署。
7. **错误注入率作为可配置参数** —— 用于构造**难度可控**的训练对手，且显式记录。

### 5.6 不适合我们的功能 / 禁止照搬

| 项 | 理由 |
|---|---|
| **P2P 心理扑克密码学栈（SRA/Ristretto255/Bayer-Groth/Ed25519/UPnP）** | 本项目为**单人手动录入 + 本地分析训练工具**，无多方博弈需求。引入将带来**巨大且无收益**的复杂度。 |
| **闭源 JNI 反作弊模块（Panoptes 模式）** | 已核实导致 FreeBSD 删除该包。**供应链 + GPLv3 双重违规。绝对禁止。** |
| **复制 GPLv3 代码** | copyleft 传染。**仅借鉴思想。** |
| **基于「行动耗时」以外的行为主义推断** | 保持审慎；见 §2.6 W-4。 |
| **照搬 `derek28` 代码** | 无许可证 + 仅单挑 + 固定 100bb。 |

---

## 6. 项目五：`texas_poker` —— **未能验证**

### 6.1 命中情况：**该描述疑似误植** —— 「未能验证」

我执行了多轮 API 检索（**已核实响应**）：

| 查询 | 结果 |
|---|---|
| `q=texas_poker&sort=stars` | `total_count 2470` |
| `q=texas+holdem+coach&sort=stars` | `total_count 12` |
| `q="texas_poker"+in:name` | `total_count 346`（另一轮 845） |
| 3 次搜索 API 调用 | **HTTP 403 未认证限流** |

**明确判定**：**未能验证**存在名为 `texas_poker`（或 texas-poker / TexasPoker）且为「扑克教练 / 顾问架构」的 GitHub 仓库。`texas_poker` 命名空间被**游戏服务器、引擎与 RL 模拟器**占据。**该描述疑似误植。**

**⚠️ 已知检索盲区（诚实声明）**：GitHub **代码搜索需认证**，因此我**无法**检索「某仓库内部有一个 `texas_poker/` 包目录」的情况。所以**不能排除**该描述指的是**某个 monorepo 内的子目录名**而非独立仓库名。

### 6.2 名称含 `texas_poker` / `TexasPoker` 的候选（**API 元数据，未逐个复核**）

| 仓库 | star | 语言 | 描述 | 是否 coach？ |
|---|---|---|---|---|
| `dolotech/Texas-Hold-em-Poker` | 176 | Go | 德州扑克服务器 Go 实现 | ❌ 游戏服务器 |
| `rosbo/texas-holdem-poker-ai` | 147 | Java | 扑克 bot：牌力、翻前模拟、对手建模 | ❌ AI/bot |
| `wzdwc/TexasPokerGame` | 139 | TypeScript | 在线德州游戏（egg/node/vue） | ❌ 游戏 |
| `ChengTsang/Potential-Aware-Abstraction-In-Texas-Hold-em-Poker` | 34 | Python | CFR 抽象研究代码 | ❌ 研究 |
| `fangdejia/HwTexasPoker` | 28 | Python | 华为比赛扑克客户端 AI | ❌ AI |
| `wangzi6147/TexasPoker` | 25 | Java | 联机德州扑克 | ❌ 游戏 |
| `stars1210JasonHe/texas-holdem-poker` | 19 | Python | 多人德州 + AI bot（MIT） | ❌ 游戏 |
| `CPunisher/texas-poker` | 9 | Java | 北航软件学院 2019 级 Java 课程大作业 | ❌ 游戏 |
| `iRusher/texas_poker_evaluator` | 2 | Lua | 无描述 —— 最贴近字面 `texas_poker` 命名 | ❌ 牌力评估 |

**名称最接近者已完整核实**：`CPunisher/texas-poker` —— 9 stars，Java，**许可证 `null`（未能验证）**。README（已抓取）原文：「Texas Poker — 北京航空航天大学软件学院2019级Java课程大作业」；C/S 多人德州游戏，Java Swing GUI + Netty NIO 自定义 Packet 协议 + Log4j2 + MVC + Maven + JDK 9+。**判定（推测）：这是游戏架构，不是教练/顾问架构。**

> ⚠️ **一处未能解决的不一致**：`CPunisher/texas-poker` 的 API 报告 `default_branch: "main"`，但抓取 `raw .../master/README.md` 返回 **HTTP 200**。两个分支可能并存，**未能确认哪个是权威分支**。

> ⚠️ **数据完整性警告（诚实声明）**：部分 `api.github.com/search` 响应中出现**明显的拼接/重复片段**（含与查询无关的仓库条目、被截断或合并的 URL 字段）。因此上表**标注为「API 搜索元数据」的行未经独立复核**。我只对能通过 `/repos/<owner>/<repo>` 或 raw 抓取**再次确认**的条目作强断言。

### 6.3 真正符合「教练 / 顾问」描述的项目（名称不同）

| 项目 | star | 许可证 | 说明 |
|---|---|---|---|
| `pselamy/poker-tab-analyzer` | 6 | **未能验证**（README 称 MIT，**未见 LICENSE 文件**） | ⭐ **公开文档最完整的「扑克顾问架构」**：Chrome 扩展，截图 → 灰度/阈值/泛洪填充/矩形 CV 识别牌面 → `pokersolver` 牌力评估 → 页面浮层建议，250ms 循环，全本地。**已 ARCHIVED** |
| `TebooNok/TexasHoldem-LLMCoach` | 1 | **未能验证**（API `null`，无 LICENSE） | 真 LLM 教练：CMD 单挑 NLHE，AI 边打边推理，独立 LLM「教练」回答人类提问。**⚠️ 仓库入库了 `.env`（99 字节，已核实存在，我未读其内容）—— API 密钥处理失当的信号** |
| `sol5000/gto`（QuickGTO） | 18 | **未能验证为 OSI 许可证**：README 页脚称 **CC BY-NC-SA 4.0**（**非商业**） | CLI + Streamlit 顾问：Strict 模式（≥65% 权益加注 / ≥40% 过牌 / 否则弃牌）与 Bets 模式（比较弃/跟/加 EV 取最大）、对手范围百分比过滤、权益直方图、CSV 会话历史。**⚠️ NC 条款禁止商业使用** |
| `matthiola0/poker-hand-review` | 6 | **MIT** | 见 §3 |
| `KavinPruthi/poker-hub` | 0 | MIT（API 元数据） | 资金管理 + GTO + AI 教练，React Native/Expo/Supabase |

> **已核实的重要合规观察**：`pselamy/poker-tab-analyzer` 与 `wizgto` 的 `extension/` 都是**屏幕捕获 + 实时建议**形态。**这正是本项目 ARCHITECTURE.md §8.4 M28 明令禁止的方向。** —— 「推测」：此类项目在扑克社区普遍处于**平台服务条款的灰色/违规地带**，本项目应**明确保持距离**。

---

## 7. 项目六：`Poker Game Analyzer` —— **精确命中**

### 7.1 命中情况 —— 「已核实（附链接）」

`q="poker game analyzer"` → **`total_count = 1`**。**全 GitHub 只有唯一名称匹配者**：

**`96jsalinas/Poker-Game-Analyzer`** —— https://github.com/96jsalinas/Poker-Game-Analyzer

- **4 stars**，1 fork，Python，**MIT**，创建 2026-02-19，推送 2026-04-17，默认分支 `main`，size 1580 KB
- README 内部产品名为 **"PokerHero Analyzer"**
- 任务描述「poker stats / session analysis」**准确匹配**

### 7.2 许可证 —— 「已核实（附链接）」**读了两遍**

1. `raw.githubusercontent.com/96jsalinas/Poker-Game-Analyzer/main/LICENSE` → `MIT License — Copyright (c) 2026 Josu Salinas`
2. `pyproject.toml` 亦声明 `license = {text = "MIT"}`

### 7.3 项目结构 —— 「已核实（附链接）」

来源：两次 `/contents` API 调用 + 仓库自带 `Architecture.MD`：

```
src/pokerhero/
  __init__.py, config.py
  parser/       models.py, hand_parser.py
  database/     schema.sql, db.py
  ingestion/    splitter.py, pipeline.py
  analysis/     queries.py, ranges.py, stats.py
  frontend/     app.py, upload_handler.py, assets/theme.css,
                pages/{home,upload,sessions,dashboard,guide,settings}.py
tests/          17 个 .txt 夹具 + test_parser.py, test_database.py,
                test_ingestion.py, test_sessions.py, test_dashboard.py,
                test_app_layout.py, test_settings.py, test_upload.py,
                test_guide.py, test_analysis.py
根目录文档         README.MD, Architecture.MD, AnalysisLogic.MD, DataStructure.MD,
                TestingStrategy.MD, UserExperience.MD, UserGuide.MD,
                Contributing.MD, CLAUDE.md; run.py; data/histories/(git-ignored)
```

**技术栈（已核实，来自 `pyproject.toml`）**：Python ≥ 3.13、hatchling、**pandas / numpy / pokerkit / dash / diskcache / multiprocess**；开发依赖 pytest / mypy / ruff / pre-commit；**mypy strict = true**；ruff line-length 88。扑克引擎 = **PokerKit**；数据库 = **SQLite（裸 sqlite3，无 ORM）**；UI = **Dash（Plotly）多页应用**。

### 7.4 主要功能 —— 「已核实（README 全文）」

- **导入**：拖放 PokerStars `.txt` 手牌历史；重复检测；USD/EUR/游戏币自动识别；现金局与锦标赛；**re-buy 识别**；BOM（utf-8-sig）与 CRLF 规范化
- ⭐ **会话下钻**：Session Report（叙述 + KPI 条 `bb/100`、VPIP、AF、位置表）→ Hands → Actions **面包屑导航**
- ⭐ **EV 引擎**：会话级 EV；**Lucky/Unlucky 全下标记**（对比全下时的精确权益）；**基于推断对手范围的范围 EV**；All-in 精确 EV；**Fold Verdicts（「弃得好」/「本应跟注」）**；结果缓存在 `action_ev_cache` 表，**仅在显式点击 "Calculate EVs" 时计算**
- ⭐ **内联扑克数学**：翻牌 SPR、**底池赔率 %**、**每个 Hero 决策点的 MDF %**
- ⭐⭐ **对手画像 + 样本量置信档**：由 VPIP + 激进比归为 **TAG/LAG/Nit/Fish**，并带 **Confidence Tiers（Preliminary / Standard / Confirmed）**
- **仪表盘**：KPI 卡（P&L、bb/100、VPIP、PFR、3-Bet）、资金曲线、**VPIP/PFR 差距图**、位置红绿灯目标、最大赢/输、最佳/最差会话、周期筛选、暗色模式、CSV 导出
- **自述限制**：**仅 PokerStars `.txt`**；主要在现金局上开发测试

### 7.5 ⭐ 技术观察（**来自其 `Architecture.MD`，极具借鉴价值**）

该仓库**主动记录了若干真实工程陷阱**（已核实为仓库文档内容）：

1. **设计决策**：**刻意用裸 SQL 而非 ORM**；理由原文「**Storage is cheap; compute at query time is not**」→ **派生值在解析时预计算，EV 预计算并缓存**
2. **已记录的真实 Bug**：`numpy.int64` 作为 SQLite 绑定参数会**静默返回空结果** → 必须 `int()` 转换
3. **已记录的格式怪癖**：PokerStars **小时位不补零**的时间戳，并配了回归夹具
4. **已记录的 Dash 组件陷阱**：`dcc.Input` 无 `type="date"`；`dash.html` 无 `Input`；模式匹配回调会以 `n_clicks=0` 触发；Dash 组件因 mypy 无法接受 `data-*` kwargs
5. **明确规划**：若未来支持多站点，将采用**平台特定适配器模式（adapter pattern）**

### 7.6 可借鉴设计（**高价值**）

1. **⭐⭐ 对手画像的「样本量置信档」** —— Preliminary / Standard / Confirmed **三档**。这是**任务设计问题 1（样本量保护）的直接可落地答案**。
2. **⭐⭐ EV 计算的缓存与显式触发** —— `action_ev_cache` 表 + 「点按钮才算」。**推测**：把昂贵计算与交互解耦，既省算力又让用户明确知道「这是计算出来的」。
3. **⭐ Fold Verdicts（弃牌裁决）** —— 把「弃牌」这个动作也纳入 EV 评估（「弃得好」/「本应跟注」）。**很多工具只评估下注，忽略弃牌错误。**
4. **⭐ 「Lucky/Unlucky 全下」标记** —— **直接实现「结果 ≠ 决策质量」**：全下赢了但权益落后 → 标记为 Lucky。**这正是本项目 M15 的现成实现范式。**
5. **⭐ 内联呈现 SPR / 底池赔率 / MDF** —— 在**每个决策点**展示数学量，符合本项目「数学量必须可见且中文标注」的要求。
6. **⭐ 会话 → 手牌 → 动作的三层面包屑下钻** —— 优秀的信息架构。
7. **⭐ 把工程陷阱写进架构文档**（int64 绑定、时间戳怪癖、Dash 组件坑）—— **本项目 ARCHITECTURE.md §7「可能出现的 Bug」表格的同类实践**，值得继续坚持。
8. **裸 SQL 优先 + 派生值预计算** —— 「存储便宜、查询时计算不便宜」的务实取舍。
9. **PokerKit 作为引擎依赖**（见 §7.7）。

### 7.7 依赖 `uoftcprg/pokerkit` —— 「已核实（附链接）」

- `uoftcprg/pokerkit`：**495 stars**，76 forks，Python，创建 2021-02-12，推送 2026-08-22
- **许可证：MIT**（`Copyright (c) 2023-2026 Universal, Open, Free, and Transparent Computer Poker Research Group`，已读全文）
- **注意**：README 文件是 `README.rst`（`README.md` 返回 **404**）
- 能力：纯 Python 库，游戏模拟 + 牌力评估 + 统计分析；广泛变体支持（NLHE、NL Short-Deck、PLO、固定限 2-7 三次换、badugi 等）；高层状态 API（`create_state`、`deal_hole`、`complete_bet_or_raise_to`、`select_runout_count` 等）
- 工程声明（**自述，未运行**）：**99% 代码覆盖率**、严格 mypy、doctest + 单元测试
- 学术引用：*IEEE Transactions on Games*，DOI `10.1109/TG.2023.3325637`
- **License 与 star 双优 → 是本报告中最值得作为「基础设施依赖」的候选之一**

### 7.8 不适合我们的功能

| 功能 | 理由 |
|---|---|
| **仅 PokerStars `.txt` 格式** | 与 §3.6 同理：本项目做手动录入，不绑定第三方站点格式 |
| **Dash（Plotly）技术栈** | 本项目为 **TypeScript + Node ≥22**（已核实 `package.json`）。**推测**：引入 Python 服务端会破坏技术栈单一性 |
| **裸 `sqlite3` + 无 ORM** | **推测**：该选择在其场景合理，但本项目阶段 9 的存储需求尚不明确，不宜过早锁定 |
| **锦标赛/re-buy 逻辑** | 本项目为现金局 |

### 7.9 可借鉴的「候选依赖」评估（**推测**）

| 依赖 | star | 许可证 | 评估（推测） |
|---|---|---|---|
| `uoftcprg/pokerkit` | 495 | **MIT** | **推荐评估**。若本项目需要更完整的变体与状态机支持，这是最安全的开源选择。**但本项目已有自研 `domain/poker/*`（已核实 16 个文件），需先做能力比对再决定是否引入。** |
| `andrewprock/pokerstove` | 886 | **BSD-3-Clause** | 纯 C++ 牌力评估引擎（`peval` 覆盖 14 种变体），非教练/分析工具。**推测**：性能敏感场景可参考，但引入 C++ 依赖成本高。 |
| `jejellyroll-fr/fpdb-3` | 24 | **AGPL-3.0** | 功能最强（**26 个牌室**、实时 HUD、**漏洞检测、玩家画像**、SQLite/PostgreSQL/MySQL 跨库迁移、**14 个语言目录**），**但 AGPL copyleft → 不可链接进本项目**。仅可借鉴功能清单。 |
| `foster-chen/PNParser` | 9 | **Apache-2.0** | PokerNow 会话日志解析 + 玩家统计（VPIP/PFR/AF/WTSD/3-Bet/4-Bet/5-Bet/C-Bet/2-Ba/3-Ba/F-PFR/F-3B/F-4B/F-CB/F-2Ba/F-3Ba/**Trap**）。**Apache-2.0 可安全借鉴。** |

**⭐ 从 `fpdb-3` 提炼的三条工程实践（值得效仿，无需引入其代码）：**

1. ⭐ **把技术债写成独立顶层文档** —— 该仓库根目录存在 **`TECHNICAL_DEBT.md`**（已核实）。**推测**：这是极佳实践。**建议本项目把 `ARCHITECTURE.md` §7/§8 的 Bug 预判表进一步独立为「技术债台账」并持续维护**，而非让预判表随架构文档一起僵化。
2. **配置膨胀的可见信号** —— `HUD_config.xml` **328 KB** vs `HUD_config.xml.example` **140 KB**（均已核实）。**推测**：真实配置达示例的 2.3 倍，是**配置腐化**的量化信号。**建议本项目中文 UI 的配置项设上限与校验。**
3. **构建成本是采用决策的一部分** —— 已核实该仓库依赖**必须在安装时编译的原生 C 扩展 `pypoker-eval`（pin v1.2.0）**，需 C 编译器 + CMake；Linux HUD 还需 X11。**推测**：这是 AGPL 之外的**第二重采用障碍**，进一步支持「不引入」的结论。

---

## 8. 设计问题专答（严格区分「已核实」与「推测」）

### 8.1 样本量保护：如何避免只打 10 手就给对手贴标签？

**已核实的四种真实做法：**

| 项目 | 机制 | 证据 |
|---|---|---|
| **`96jsalinas/Poker-Game-Analyzer`** | ⭐ **置信三档：Preliminary / Standard / Confirmed**（由 VPIP + 激进比分类 TAG/LAG/Nit/Fish） | 已核实（README） |
| **`wizgto`** | ⭐ **Wilson 95% 置信区间门控**漏洞检测 + **shrinkage 收缩估计** + provenance labels | 已核实（README） |
| **`tonikelope/coronapoker`** | `isStation()/isNit()/isManiac()` 在 **>10 手**后启用；另有早期快速读数 `looksPassiveStation()` | 已核实（`docs/BOTS.md`） |
| **`luckyone18/Poker`** | `_MIN_SAMPLE = 5` 硬阈值启停 + `confidence = min(1.0, hands/20)` **连续缩放利用强度** | 已核实（源码） |

**本项目规划（已核实本地文档）**：ARCHITECTURE.md M18（`< 30 次` 输出「初步迹象 + 当前样本 N + 样本不足」）、M19（置信度**六项加权 + 任一缺失即封顶**）、§2.7（样本不足显示「样本不足」，**不得贴长期标签**）。

**⭐ 综合建议（推测）——三档 + 连续系数 + 收缩估计，三者叠加：**

| 档位 | 条件（推测建议） | 允许输出 | 禁止输出 |
|---|---|---|---|
| **观察中** | < 10 手 | 「暂无可靠倾向」+ 样本数 | 任何类型标签 |
| **初步迹象（Preliminary）** | 10–29 手 | 「可能偏松（初步迹象，N=12）」+ **Wilson 95% CI** | 「松凶型」等定性标签 |
| **可参考（Standard）** | 30–99 手 | 类型标签 + 置信区间 | 「确定」措辞 |
| **较可靠（Confirmed）** | ≥ 100 手 | 类型标签 + 精确统计 | — |

**三条关键机制（推测，但均有实证支撑）**：
1. **硬阈值管「是否说」，连续系数管「说多狠」**（源自 REF-B 与 REF-C 的共同经验）。
2. **收缩估计**：小样本统计量向总体基线收缩（源自 `wizgto` 的 shrinkage）→ 天然抗「10 手贴标签」。
3. **置信区间门控**：只有达到统计显著才报「漏洞」（源自 `wizgto` 的 Wilson CI）。**这比固定手数门槛更科学。**

### 8.2 如何把「输钱最多」改成「EV 错误最大」（EV loss attribution）？

**已核实的实证（`matthiola0/poker-hand-review`）：**

- 指标名：**`ev_loss_bb`**；**三档分级** GOOD / INACCURACY / MISTAKE；CLI 有 `--min-tier good|inaccuracy|mistake`
- **漏洞聚合三元组**：`count, cumulative EV loss, hands involved`
- **⭐ 诚实的自我限定（原文）**：
  > 「Without a solver, `ev_loss_bb` is an engine **estimate** from chart / equity heuristics. Treat it as **severity guidance**, not exact solver EV.」

**已核实的第二个实证（`96jsalinas/Poker-Game-Analyzer`）：**

- **Fold Verdicts**（「Good fold」/「Should have called」）—— **弃牌也被评估**
- **Lucky/Unlucky 全下标记** —— 对比全下时的精确权益，从而**把「好结果/坏结果」与「好决策/坏决策」分开**
- **EV 结果缓存**（`action_ev_cache`）+ 显式触发计算

**核心机制（推测，但被上述架构佐证）**：

```
ev_loss(决策点) = EV(最优动作 | 当时信息集) − EV(实际动作 | 当时信息集)     （恒 ≥ 0）
```

**为什么优于「输钱最多」：**

| 维度 | 「输钱最多」 | 「EV 错误最大」 |
|---|---|---|
| 度量对象 | 结果（筹码变动） | 决策（**当时信息集**下的动作选择） |
| 坏运气影响 | **被污染**（AA 输给 72o 记为大错） | 不受影响（AA 全下仍是正确决策） |
| 好决策坏结果 | 误判为错误 | 正确判为「正确决策 + 坏运气」（Lucky/Unlucky 标记） |
| 可比性 | 受筹码深度、底池大小影响 | 归一化为 BB，可跨手比较 |
| 弃牌错误 | 完全看不见 | Fold Verdicts 显式评估 |

**本项目落地建议（推测）：**

1. **决策质量与结果质量分字段存储、分字段渲染**（本项目 M15）—— **物理隔离**优于「注意不要混淆」。
2. **两段式复盘**（本项目 M16）：`当时决策分析`（只用当时信息）/ `摊牌后分析`（可用真实手牌），**数据结构分离**。
3. **⭐ 字段命名必须自带不确定性标记**：建议 `evLossEstimate`（对象，含 `value` + `confidence` + `method`），**禁止**裸 `evLoss: number`（吸取 A-2 教训）。
4. **漏洞排序按累计 EV 损失**，同时输出 `count` 以区分「偶发大错」与「高频小错」。
5. **⭐ 漏洞必须过统计显著性门槛**才报出（借鉴 `wizgto` 的 Wilson 95% CI）。
6. **无法计算时输出「暂时无法准确计算 EV」**（本项目第一性原理第 3 条），不猜测。

### 8.3 贝叶斯式范围更新：如何维护对手手牌的概率分布？

**已核实的实证（`luckyone18/Poker` `bots/opponent_model_bot.py` 源码原文）：**

```python
# Bayesian update: posterior ∝ prior × likelihood
self._ranges[pid] = _normalise(self._ranges[pid] * likelihood)
```

配套要素（**均已核实**）：

| 要素 | 实现 |
|---|---|
| **先验** | 5 档均匀分布 `_uniform_prior()` → `np.ones(5)/5` |
| **状态空间** | `("trash","weak","medium","strong","premium")` |
| **似然表** | `PREFLOP_LIKELIHOODS` / `POSTFLOP_LIKELIHOODS`，如 `"raise": [0.1,0.3,0.7,1.5,2.5]` |
| **归一化** | `_normalise()`，总和 ≤ 0 时**回退均匀分布** |
| **下注尺寸调制** | `size_boost`，`ratio > 3.0` 时 `[0.5,0.6,0.8,1.2,1.5]` |
| **权益计算** | **按分布加权采样**（`_sample_hand_from_range`），**而非随机手牌** |
| **可解释输出** | `get_opponent_range(pid)` → 桶名→概率字典 |

**关键区别（问题 3 的核心答案）**：

- **单一手牌预测**：「我认为他有 AK」—— **点估计**。
- **概率分布**：`{trash: 0.05, weak: 0.15, medium: 0.35, strong: 0.30, premium: 0.15}` —— **分布**，可直接用于**范围 vs 范围权益**，从而得出**正确的底池赔率比较**。

**每来一个动作，分布更新一次**：`posterior ∝ prior × likelihood(action)`，然后**归一化**。这是**逐动作、在线、增量**的更新。

**对照（已核实）**：`matthiola0/poker-hand-review` **不做**逐动作贝叶斯更新，而是把对手归入 **4 档静态范围键**（`tight`/`balanced`/`wide_passive`/`wide_aggressive`）再回灌权益。**推测**：粒度远粗，但依赖更少、更不易出错——**是一个务实的降级选项**。

**⚠️ 必须避免的缺陷（已核实于 REF-B）**：见 §4.6 B-6（桶宽未归一化）、B-7（位置未纳入）。

**推测性建议（本项目）：**

1. **状态空间用「169 起手牌组合 + 权重」而非 5 个桶**。理由：5 桶信息损失大，且桶宽未归一化会引入系统性偏差。
2. **必须按组合数归一化似然**，否则后验向 premium 漂移。
3. **位置必须进入似然**：建议似然表按 `(street, position, action)` 三维索引。
4. **必须区分「面对下注」与「主动下注」**，并记录 `toCallBefore`。
5. **分布必须可视化**（中文 UI 需求）。
6. **不可计算时拒绝给结论**（本项目 M20：差距小于阈值 → 「边缘决策」）。

### 8.4 真人非理性行为（tilt、追损、情绪）如何安全进入数学体系？

**⭐ 已核实的真实实现（本次审计的唯一发现）—— `tonikelope/coronapoker` `docs/BOTS.md`：**

- **「profile elasticity（性格弹性）」**：bot 的性格**按手牌自适应**，依据 **M-ratio** 与 **TILT**：
  - 短筹码 → 转 **push/fold TAG**
  - **tilted recreational → 转 LAG**

> **这是本问题的关键洞察（已核实 + 推测）**：CoronaPoker 的做法是——**tilt 只改变「对手被建模成的性格档位」，而不改变数学本身**。
> 该 bot **自己声明**「does **not** compute equity against per-opponent ranges」，即它**根本没有 EV 数学层可被污染**。因此它的 tilt 弹性是**纯行为调度**，不是数学输入。
> **推测**：这恰好印证了安全的设计方向 —— **情绪作用于「行为/先验」，绝不作用于「给定条件下的 EV 计算」**。

**⚠️ 学术线索（未能验证）**：检索到论文 *New perspectives on emotional processes and decision making in the game of poker: with special emphasis on the tilting phenomenon*（Palomäki），但 **PDF 抓取被工具拒绝**（`unsupported content type "application/pdf"`），因此**不对其结论作任何断言**。

**推测性方案：把「人的状态」建模为「先验的调制器」，而非「EV 公式的输入」**

核心原则（**推测**）：**情绪只能改变「对对手范围的先验假设」或「建议措辞」，绝不能改变「给定范围下的数学结论」。**

```
EV(动作 | 我的手牌, 牌面, 对手范围)      ← 纯数学，不含任何情绪变量
        ↑ 情绪不得进入这一层

对手范围先验 = f(GTO 基线, 历史统计, 状态修饰因子)
                                      ↑ 情绪/倾向只允许在这里进入
```

**分层建议（推测）：**

| 层 | 内容 | 是否可含情绪 |
|---|---|---|
| 数学层 | 权益、底池赔率、EV、最低所需权益 | **绝对禁止** |
| 范围层 | 对手手牌概率分布 | **允许**（作为先验调制） |
| 风格层 | 建议措辞、教练口吻、风险偏好表达 | **允许**（纯解释） |
| 状态层 | tilt 标记、追损倾向、session 疲劳 | **允许**，但只输出**标注**，不输出数字结论 |

**安全护栏（推测，对齐本项目 M15/M16/M19/M20）：**

1. **tilt/情绪状态只能产生「提示」而非「建议」**。例如：「⚠️ 检测到连续 3 手大额跟注，可能处于追损状态，建议暂停」—— 这是**行为提示**，不是 EV 结论。
2. **情绪因素一旦参与范围调制，必须降低置信度**，并在输出显式列出「本结论已考虑情绪修饰」。
3. **禁止用情绪解释合理化错误决策** —— tilt 是**待管理的风险**，不是负 EV 的辩护理由。
4. **两段式复盘**（本项目 M16）：情绪标注放在「当时决策分析」作为**情境说明**，**不得改变决策质量评分**。
5. **⭐ 最保守也最安全的方案（我倾向推荐）**：情绪建模**不进入对手范围先验**，仅作为**用户自我觉察的镜像** —— 例如「你在亏损后的 VPIP 上升了 18%」。这是**统计事实**，而非**数学污染**。
6. **借鉴 CoronaPoker 的参数化方式**：把「tilt 弹性」做成**显式、可配置、可关闭的调度参数**，并**记录进复盘数据**，而非隐藏在启发式代码里。

### 8.5 跨手记忆：如何记住过去的手牌而不过度反应于单手？

**已核实的四种机制：**

**(a) 每手向均匀分布指数衰减** —— `luckyone18/Poker` `opponent_model_bot.py` 源码原文：

```python
def _on_new_hand(self, opponents):
    """Reset per-hand tracking. Ranges carry over between hands but
    are blended toward uniform so stale data decays."""
    uniform = _uniform_prior()
    decay = 0.85  # retention factor
    for pid in list(self._ranges):
        self._ranges[pid] = _normalise(
            decay * self._ranges[pid] + (1 - decay) * uniform
        )
```

**「新后验 = 0.85 × 旧后验 + 0.15 × 均匀分布」** → **单手影响随手下衰减；陈旧数据自然淡出；分布永不退化。**

**(b) 跨手累计统计 + 最小样本门槛** —— `exploitative_bot.py`：`_OppProfile` 跨手累计 `hands`/`vpip_count`/`bets_and_raises`/`calls`/`folds_vs_aggression`，`_new_hand()` 只增计数与重置单手标记。

**(c) 手内严格去重** —— `opponent_model_bot.py` 用 `_last_processed_len` 切片，**只处理新历史条目**。原文注释：「slicing here prevents every action from being Bayesian-updated multiple times per hand」。**防止单手被重复计入。**

**(d) 会话级对手追踪 + 手数门槛** —— `tonikelope/coronapoker`：`OpponentTracker` 存于会话级 `TRACKER_MEMORY`，累积 VPIP/PFR/AF，**>10 手**后才判定原型。

**推测性方案（本项目，分层记忆）：**

| 记忆类型 | 时间尺度 | 衰减方式（推测） | 用途 |
|---|---|---|---|
| **手内记忆** | 单手 | 不衰减，**严格去重** | 本手动作线分析 |
| **会话记忆** | 本次会话 | **指数衰减**（如 0.9/手） | 当前牌桌动态 |
| **对手长期记忆** | 跨会话 | 慢衰减（如 0.99/手）+ 最小样本门槛 | 对手画像 |
| **基底先验** | 永久 | 不衰减 | GTO 理论基线 |

**关键设计要点（推测）：**

1. **必须去重**：单手内同一动作只能更新一次（REF-B 的 `_last_processed_len` 经验；同时避免其 B-5 的 `_seen_entries` 无界增长缺陷）。
2. **衰减系数应可配置且记录在案** —— 它是**主观先验强度**的体现。
3. **⭐ 必须维护「衰减后有效样本数」`n_eff`，而非原始 `hands`** —— 否则衰减会降低有效样本却仍按原始手数算置信度，**高估置信度**。
4. **单次观测的似然乘数必须设上下限（clip）**，防止单手极端事件主导后验。
5. **禁止用单手的输赢结果更新对手模型**（应只用**动作**），否则引入结果导向偏差（违反 M15）。
6. **借鉴 `wizgto` 的 shrinkage**：跨会话长期记忆向总体基线收缩，进一步抑制单手过反应。

---

## 9. 功能融合矩阵

> **列分组**：`WizGTO` = `omkarxpatel/wizgto`（Apache-2.0）；`HandReview` = `matthiola0/poker-hand-review`（MIT）；`luckyone18` = `luckyone18/Poker`（无许可证）；`Corona` = `tonikelope/coronapoker`（GPLv3）；`PGA` = `96jsalinas/Poker-Game-Analyzer`（MIT）；`中文` = `1killermouse/poker-mind-gto-lab`（无许可证）。
> **「本项目」列**取自 `docs/ARCHITECTURE.md` 实际规划（已核实），并标注建议优先级。

| 功能 | WizGTO | HandReview | luckyone18 | Corona | PGA | 中文训练器 | **本项目（规划）** |
|---|---|---|---|---|---|---|---|
| **Equity（权益）** | ✅ 蒙特卡洛 | ✅ 默认启发式后端 | ⚠️ 蒙卡（**分母有缺陷 B-2**） | ❌ 自述不计算权益 | ⚠️ 经 PokerKit | ⚠️ 结构化教学数据 | **核心**（阶段 1–3 已交付：精确枚举+蒙卡、95% CI、B18 模拟精度标注） |
| **Range narrowing（范围收窄）** | ✅ 对手建模 | ⚠️ 仅 4 档静态键 | ✅ 5 桶贝叶斯｜⚠️ 桶宽未归一化 | ❌ 自述无 | ✅ 推断对手范围 | ⚠️ 非真实求解 | **核心**（阶段 4：`ranges.ts`，理论基线+组合权重+范围 vs 范围） |
| **Bayesian update（贝叶斯更新）** | ⚠️ 建模含收缩估计 | ❌ 无逐动作更新 | ✅ `posterior ∝ prior × likelihood` | ❌ | ⚠️ 范围推断 | ❌ | **核心**（阶段 4–6；建议 169 组合而非 5 桶，须按组合数归一化，见 §8.3） |
| **Player profile（玩家画像）** | ✅ 多维统计 | ✅ 对手画像+针对建议 | ✅ VPIP/AF/FTA+原型 | ✅ **NIT/STATION/TAG/LAG 三轴** | ✅ TAG/LAG/Nit/Fish | ✅ 牌风画像 | **核心**（阶段 6：11 种类型，§2.7 词表已定；可借鉴三轴正交化） |
| **Sample confidence（样本置信度）** | ✅ **Wilson 95% CI + shrinkage** | ⚠️ 用频率容差替代 | ✅ `min(1.0,hands/20)` | ✅ **>10 手门槛** | ✅ **三档 Preliminary/Standard/Confirmed** | ❌ | **核心**（阶段 6；M18/M19 六项加权+缺失封顶；建议叠加三档+连续系数+收缩，见 §8.1） |
| **Time decay（时间衰减）** | ✅ 收缩估计 | ❌ | ✅ **`0.85×旧+0.15×均匀`／手** | ⚠️ 会话级追踪 | ❌ | ❌ | **建议新增**（ARCHITECTURE 未显式列出；须补 `n_eff`，见 §8.5） |
| **Tilt / Dynamic state（情绪·动态状态）** | ⚠️ timing tells（噪声大） | ❌ | ❌ | ✅ **⭐ TILT 弹性 + M-ratio 触发风格切换** | ❌ | ⚠️ 仅「控损紧凶」教练视角 | **暂无**（唯一实证为 Corona；建议保守：只做自我觉察镜像，见 §8.4） |
| **Leak detection（漏洞检测）** | ✅ **CI 门控漏洞检测** | ✅ **count+累计 EV 损失+涉及手牌** | ❌ | ❌ | ✅ 位置红绿灯/差距图 | ✅ 弱点分布→下轮重点 | **核心**（阶段 10；按累计 EV 损失排序+显著性门槛，见 §8.2） |
| **Replay（回放）** | ⚠️ 分析仪表盘 | ✅ **逐街回放+多维筛选** | ⚠️ matplotlib 图表 | ❌ | ✅ **会话→手牌→动作下钻** | ⚠️ 牌面可视化 | **必须**（阶段 10；两段式 M16；可借鉴三级面包屑） |
| **EV loss（EV 损失归因）** | ⚠️ 未明确 | ✅ **`ev_loss_bb`+三档分级** | ❌ 仅筹码奖励 | ❌ | ✅ **Fold Verdicts + Lucky/Unlucky 全下** | ✅ EV 损失（教学数据） | **核心**（阶段 5；**必须带 confidence+method**，禁止裸数字，见 §8.2） |
| **Chinese UI（中文界面）** | ❌ | ⚠️ 仅 README 中译 | ❌ 无 Web UI | ❌ | ❌ | ✅ **中文优先产品** | **核心**（§2 完整中文规范+i18n 词条层已建；R1–R8 硬规则） |
| **Multi-agent red team（多智能体红队）** | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ 三种教练视角（非对抗） | **核心**（阶段 7：6 角色；**反方审查强制输出反对理由** M17；冲突降级不取平均 M21） |

**图例**：✅ 已实现并核实 ｜ ⚠️ 部分实现 / 有缺陷 / 形态不同 ｜ ❌ 未实现

### 9.1 矩阵解读（推测）

1. **「多智能体红队」在 6 个项目中全部缺席**（`omkarxpatel/wizgto` 的多形态与 `中文训练器` 的三视角均非对抗式）。→ **本项目在此项无参考对象，必须自研，是最大技术不确定性。**
2. **「样本量保护」是本次审计收获最丰富的一项** —— 有**四种独立实现**（Wilson CI / shrinkage / 连续系数 / 三档），可交叉验证并组合。
3. **「Tilt/Dynamic state」仅 CoronaPoker 有真实实现**，且其做法（tilt 只改性格档位、不改数学）恰好印证了安全方向。
4. **「EV 损失」有两个互补范本**：`HandReview`（EV 损失量化）与 `PGA`（Fold Verdicts + Lucky/Unlucky）—— **后者实现了「结果 ≠ 决策质量」的物理分离**。
5. **「时间衰减」被 ARCHITECTURE 遗漏**，但 `luckyone18` 与 `wizgto` 各提供一种范式 → **建议补入阶段 6/9**。
6. **「中文 UI」只有 `中文训练器` 真正做到**，但该仓库**无许可证** → 只能借鉴规范与交互，**不能抄代码**。

---

## 10. ⛔ 禁止照搬设计总表

### 10.1 合规红线（最高优先级）

| # | 禁止项 | 来源 | 理由 |
|---|---|---|---|
| N-1 | **真钱平台集成 / 反检测 / 代理规避 / 计时随机化** | `luckyone18/Poker` `docs/money-maker-roadmap.md`（已核实） | 违反本项目 §8.4 M28 与 §0。**架构上不留接口。** |
| N-2 | **屏幕捕获 + 实时建议浮层（Chrome 扩展形态）** | `omkarxpatel/wizgto` `extension/`（已核实）；`pselamy/poker-tab-analyzer`（已核实） | 同上。**`wizgto` README 自己承认这是作弊**（已核实）。 |
| N-3 | **自主对局机器人（代替玩家操作）** | `omkarxpatel/wizgto` `bots/hu/`（已核实） | 同上。 |
| N-4 | **运行时下载闭源二进制 + JNI 加载** | `tonikelope/coronapoker` Panoptes 事件（已核实，导致 FreeBSD 删包） | **供应链 + GPLv3 双重违规。绝对禁止。** |

### 10.2 许可证限制

| # | 禁止项 | 来源 | 理由 |
|---|---|---|---|
| N-5 | **复制 `luckyone18/Poker` 代码** | 无许可证（API `null`，LICENSE 404） | 保留所有权利。需独立重写。 |
| N-6 | **复制 `1killermouse/poker-mind-gto-lab` 代码** | 无许可证，**作者 README 明文**「默认保留所有权利」 | 同上。仅可借鉴思想。 |
| N-7 | **复制 `tonikelope/coronapoker` 代码** | **GPLv3** | copyleft 传染。**仅借鉴思想。** |
| N-8 | **复制 `derek28/coronapoker` 代码** | 无许可证 | 同上。 |
| N-9 | **链接 AGPL-3.0 库**（`TexasSolver` / `postflop-solver` / `wasm-postflop` / `fpdb-3`） | 均已核实为 AGPL-3.0 | **推测**：AGPL 网络服务条款可能要求整个服务开源。应采用 §3.5 的**进程外适配器**隔离。 |
| N-10 | **采用 CC BY-NC-SA 4.0 代码**（`sol5000/gto`） | README 页脚声明（**未能验证为 OSI 许可证**） | **NC 条款禁止商业使用**；SA 要求同许可分发。 |
| N-11 | **使用 `pselamy/poker-tab-analyzer` 代码** | 许可证**未能验证**（README 称 MIT 但**无 LICENSE 文件**，且已 ARCHIVED） | 无许可证文件 → 保留所有权利。 |

### 10.3 技术缺陷（已核实的确定性缺陷，禁止复制其写法）

| # | 禁止项 | 来源 | 理由 |
|---|---|---|---|
| N-12 | **`total / sims` 式权益分母** | `luckyone18/Poker` 两个 Bot（已核实） | B-2，权益系统性低估 → 过度弃牌。须用 `valid_sims` 并输出置信区间。 |
| N-13 | **「call/fold ⇒ 面对攻击」的 FTA 口径** | `luckyone18/Poker` `exploitative_bot.py`（已核实） | B-3，FTA 被污染。 |
| N-14 | **5 桶均匀采样 + 未归一化似然表** | `luckyone18/Poker` `opponent_model_bot.py`（已核实） | B-6，后验向 premium 漂移。 |
| N-15 | **`return self._current_hand` after `end_hand()`** | `luckyone18/Poker` `scripts/hand_history.py`（已核实） | B-1，恒返回 `None`。 |
| N-16 | **训练/推理特征编码不一致** | `luckyone18/Poker` README 自曝（已核实） | B-4，模型效果下降。须有特征一致性测试。 |
| N-17 | **只用「行动耗时」等噪声特征而不强收缩** | `omkarxpatel/wizgto` timing tells（已核实有此功能）+ 推测 | W-4，网络延迟/多桌引入伪相关。 |

### 10.4 产品/架构不匹配

| # | 禁止项 | 理由 |
|---|---|---|
| N-18 | **把 MTT / 6-max 图表套用到现金局 9 人桌** | `HandReview` 为 8-max MTT（已核实）；本项目为现金局 6/9 人桌（B21/M21 同类风险）。 |
| N-19 | **绑定单一第三方站点手牌格式**（PokerStars / GGPoker / Natural8） | `HandReview` / `PGA` 均如此并因此受限（已核实）。本项目做手动录入。 |
| N-20 | **把「教练风格」做成数学变量** | `中文训练器` 三视角（已核实）。风格属解释层；进入数学层将污染 EV（违反 M15/M20）。 |
| N-21 | **localStorage 存关键训练数据** | `中文训练器`（已核实其自述限制）。无法支撑跨手记忆与漏洞报告。 |
| N-22 | **P2P 心理扑克密码学栈** | `tonikelope/coronapoker`（已核实）。本项目无多方博弈需求，引入是巨大无收益复杂度。 |
| N-23 | **用情绪/tilt 解释合理化错误决策** | 无来源（推测性预防）。tilt 是待管理风险，不是负 EV 的辩护理由。 |
| N-24 | **静默修正用户输入**（自动改牌、自动补人、忽略矛盾） | 对齐本项目 B24/M3/M6。已确立「只报错、只建议，绝不自动改写」。 |
| N-25 | **把 EV / 漏洞数值以裸数字输出** | `HandReview` 的 A-2 教训。必须携带 `confidence` 与 `method`。 |

---

## 11. 未能验证事项清单（诚实边界）

| # | 未能验证的内容 | 原因 |
|---|---|---|
| U-1 | **任何项目的运行时正确性** | **未运行/构建任何代码**。全部 Bug 结论均为**静态阅读源码或文档**得出。所有性能指标均为**项目自述**。 |
| U-2 | **是否存在名为 `texas_poker` 的「教练/顾问架构」仓库** | 多轮 API 检索未见。**证据指向描述误植**。 |
| U-3 | **`texas_poker` 是否为某 monorepo 内的子目录名** | GitHub **代码搜索需认证**，无法检索目录名。**这是明确的盲区。** |
| U-4 | **Panoptes 在上游被移除的时间与方式**；`coronapoker` issue #7 内容 | 未能阅读该 issue。 |
| U-5 | **是否存在 GTO Wizard 官方开源仓库** | `q=gtowizard` 返回 **HTTP 403 限流**。仅能确认 `gtowizard.com` 是付费闭源 SaaS。 |
| U-6 | `joycollector/coronapoker` 的内容 | 仅核实元数据，未查内容。 |
| U-7 | `tonikelope/coronapoker` 的完整递归 `src/` 树 | 仅得顶层 + `docs/BOTS.md` 提及的路径。未审计其 Bayer-Groth 洗牌 / DLEQ / 收据逻辑。 |
| U-8 | `omkarxpatel/wizgto` 的 `CHANGELOG.md` / `docs/CONTEXT.md` 内容与全部引用来源 | 未读；未核验其自报指标的测量方法。 |
| U-9 | `pselamy/poker-tab-analyzer`、`TebooNok/TexasHoldem-LLMCoach`、`sol5000/gto` 的**许可证** | 无 LICENSE 文件 / 仅 README 声明 / API 无 license 字段。 |
| U-10 | `Mister-Kitty/GTOHelper` 的具体许可证条款 | GitHub 返回 `NOASSERTION`，未读 LICENSE 全文。 |
| U-11 | `derek28/coronapoker` 是否有性格建模 | **未发现**。`ehs_player` 为 EHS + 神经网络单挑智能体。 |
| U-12 | `luckyone18/Poker` 9 个 bot 源文件是否内嵌 license 头 | 未逐一枚举（根目录无 LICENSE 已核实）。 |
| U-13 | `Poker-Game-Analyzer` 的 **863 个测试**、`pokerkit` 的 **99% 覆盖率**、`fpdb-3` 的 **26 个牌室** | **均为仓库自述**，未克隆或运行。 |
| U-14 | Palomäki 关于 tilting 的论文结论 | **PDF 抓取被拒**（`unsupported content type "application/pdf"`）。§8.4 全部为推测。 |
| U-15 | Alan Kuhnl 对手建模讲义的内容 | 同上，PDF 抓取被拒。 |
| U-16 | 部分 `api.github.com/search` 返回条目的完整性 | **响应中出现明显拼接/重复片段**。仅对能经 `/repos/<owner>/<repo>` 或 raw **二次确认**的条目作强断言。 |
| U-17 | `poker session tracker` 查询的干净排序列表 | 该次 API 调用返回 **403 限流**，未获可用响应体。 |

### 11.1 关于多个目标「活跃期极短」的诚实说明（已核实但需强调）

| 仓库 | 创建 → 最后推送 | 活跃期 |
|---|---|---|
| `omkarxpatel/wizgto` | 2026-07-23 → 2026-08-18 | ~4 周 |
| `luckyone18/Poker` | 2026-05-14 → 2026-05-19 | **~5 天** |
| `1killermouse/poker-mind-gto-lab` | 2026-07-14 → 2026-07-19 | **~5 天** |
| `matthiola0/poker-hand-review` | 2026-06-06 → 2026-06-27 | ~3 周 |
| `96jsalinas/Poker-Game-Analyzer` | 2026-02-19 → 2026-04-17 | ~2 个月 |
| `tonikelope/coronapoker` | 2020-08-12 → 2026-08-26 | **~6 年（唯一长期项目）** |

**推测**：多数目标（尤其 star ≤ 6 者）**高度疑似 AI 辅助生成的展示型项目**，而非经长期迭代与实战检验的工程产物。**其设计可借鉴，但其「正确性」不应被当作权威。** 本报告所有引用均限定在**思路层面**。

**唯一例外（推测）**：`tonikelope/coronapoker` 有 **6 年**持续开发、真实用户（FreeBSD 打包分发）、真实安全事故（被删包），是**唯一经过现实检验**的项目 —— **因此其「性格建模 + tilt 弹性」的可信度显著高于其他目标。**

---

## 12. 给本项目的行动建议（推测性，仅供参考）

**最高优先级（可立即落地）**

1. **⭐⭐ 样本量保护三件套**：借鉴 `PGA` 的**三档置信（Preliminary/Standard/Confirmed）** + `wizgto` 的 **Wilson 95% CI 门控** 与 **shrinkage 收缩估计** + `luckyone18` 的**连续置信系数**。这四种机制可叠加，且与 ARCHITECTURE 的 M18/M19 完全兼容。
2. **⭐⭐ EV 损失归因**：借鉴 `HandReview`（MIT，可安全借鉴）的 `ev_loss` + 三档分级 + 漏洞三元组；叠加 `PGA` 的 **Fold Verdicts** 与 **Lucky/Unlucky 全下标记**（后者直接实现 M15「结果 ≠ 决策质量」）。字段必须带 `confidence` 与 `method`。
3. **把 `enrich/` 独立层思想引入本项目**：解析与「Hero 视角语义推导」解耦。
4. **采用 `HandReview` 的解析器容错原则**：已知严格、未知记 `raw_unparsed` 警告不中止。
5. **⭐ 补入「时间衰减」**（ARCHITECTURE 阶段 6/9 遗漏）：借鉴 `luckyone18` 的指数遗忘范式，**但须独立重写并补 `n_eff` 有效样本量**。

**中优先级**

6. **贝叶斯范围用 169 起手牌组合 + 权重**（而非 5 桶），按组合数归一化似然，位置纳入似然索引。
7. **tilt 处理借鉴 CoronaPoker 的参数化范式**：把「tilt 弹性」做成**显式、可配置、可关闭的调度参数**，且**只作用于风格/先验，不作用于数学**（§8.4）。
8. **求解器采用进程外 JSON 契约适配器**（借鉴 `HandReview`），隔离 AGPL 传染并实现性能分层。
9. **评估 `uoftcprg/pokerkit`（MIT，495★）作为候选依赖**——但须先与自研 `domain/poker/*` 做能力比对。

**需谨慎/暂缓**

10. **多智能体红队（阶段 7）在 6 个目标中全部缺席，必须自研** —— 建议尽早原型验证，这是**最大技术不确定性**。
11. **tilt / 情绪建模暂缓**，或仅做「自我觉察镜像」（统计事实），不进入数学层。

**严禁**

12. **不引入任何实时辅助 / 屏幕捕获 / 自动操作形态**（N-1~N-3）。
13. **不复制无许可证（`luckyone18`、`中文训练器`、`derek28`）与 GPLv3（`tonikelope`）项目的代码**。
14. **不链接 AGPL-3.0 库**（N-9）。

---

## 13. 来源 URL 清单（实际抓取并使用）

**GitHub REST API（元数据：star / license / 时间戳 / 依赖）**

- `api.github.com/search/repositories?q=WizGTO` ｜ `?q=wizgto+fork:true` ｜ `?q=coronapoker` ｜ `?q=texas_poker&sort=stars` ｜ `?q=texas+holdem+coach&sort=stars` ｜ `?q=texas_poker+in:name`（多次）｜ `?q="poker+game+analyzer"` ｜ `?q=poker+hand+review` ｜ `?q=poker+gto&sort=stars`
- `api.github.com/search/repositories?q=gtowizard` → **HTTP 403 限流（失败）**
- `api.github.com/search/repositories?q=poker+session+tracker&sort=stars` → **HTTP 403 限流（失败）**
- `api.github.com/repos/omkarxpatel/wizgto` ｜ `.../git/trees/main?recursive=1`
- `api.github.com/repos/luckyone18/Poker` ｜ `.../git/trees/main?recursive=1`
- `api.github.com/repos/1killermouse/poker-mind-gto-lab`
- `api.github.com/repos/matthiola0/poker-hand-review`
- `api.github.com/repos/tonikelope/coronapoker/contents/`
- `api.github.com/repos/derek28/coronapoker` ｜ `.../git/trees/master?recursive=1`
- `api.github.com/repos/96jsalinas/Poker-Game-Analyzer/contents/` ｜ `.../contents/src` ｜ `.../contents/src/pokerhero`
- `api.github.com/repos/foster-chen/PNParser` ｜ `.../contents/` ｜ `.../contents/classes`
- `api.github.com/repos/jejellyroll-fr/fpdb-3` ｜ `.../contents/`
- `api.github.com/repos/uoftcprg/pokerkit` ｜ `api.github.com/repos/andrewprock/pokerstove` ｜ `.../contents/`
- `api.github.com/repos/bupticybee/TexasSolver` ｜ `api.github.com/repos/b-inary/postflop-solver` ｜ `.../wasm-postflop` ｜ `.../gtowizard-ai/mitpoker-2024`
- `api.github.com/repos/TebooNok/TexasHoldem-LLMCoach` ｜ `.../contents/`
- `api.github.com/repos/pselamy/poker-tab-analyzer` ｜ `.../contents/` ｜ `api.github.com/repos/sol5000/gto` ｜ `.../contents/`
- `api.github.com/repos/CPunisher/texas-poker` ｜ `api.github.com/repos/thlorenz/hha` ｜ `api.github.com/repos/jarry-xiao/pokernow_hud`

**源码 / 文档原文（raw.githubusercontent.com）**

- `raw.githubusercontent.com/omkarxpatel/wizgto/main/{README.md, LICENSE, package.json}`
- `raw.githubusercontent.com/luckyone18/Poker/main/{README.md, LICENSE, bots/opponent_model_bot.py, bots/exploitative_bot.py, bots/swc_parser.py, scripts/hand_history.py, docs/money-maker-roadmap.md}`
  - `.../main/LICENSE` → **HTTP 404**（无许可证的证据）
- `raw.githubusercontent.com/tonikelope/coronapoker/master/{README.md, LICENSE, docs/BOTS.md, pom.xml}`
- `raw.githubusercontent.com/derek28/coronapoker/master/README.md`
- `raw.githubusercontent.com/matthiola0/poker-hand-review/main/{README.md, LICENSE, docs/SOLVER_ADAPTER.md}`
- `raw.githubusercontent.com/96jsalinas/Poker-Game-Analyzer/main/{README.MD, LICENSE, Architecture.MD, pyproject.toml}`
  - `.../main/README.md` → **HTTP 404**（文件实为 `README.MD`）
- `raw.githubusercontent.com/1killermouse/poker-mind-gto-lab/main/README.md`
- `raw.githubusercontent.com/foster-chen/PNParser/main/{README.md, LICENSE, requirements.txt}`
- `raw.githubusercontent.com/jejellyroll-fr/fpdb-3/{master/README.md, development/LICENSE}`
- `raw.githubusercontent.com/uoftcprg/pokerkit/main/{README.rst, LICENSE}`
  - `.../main/README.md` → **HTTP 404**
- `raw.githubusercontent.com/andrewprock/pokerstove/master/{README.md, LICENSE.txt}`
  - `.../master/LICENSE` 与 `/COPYING` → **HTTP 404**
- `raw.githubusercontent.com/CPunisher/texas-poker/master/README.md`
- `raw.githubusercontent.com/TebooNok/TexasHoldem-LLMCoach/main/README.md`
- `raw.githubusercontent.com/pselamy/poker-tab-analyzer/main/README.md`
- `raw.githubusercontent.com/sol5000/gto/main/README.md`

**HTML 抓取（均 HTTP 200 但含零结果行，记录为方法论教训）**

- `github.com/search?q=WizGTO&type=repositories` → 仅导航样板
- `github.com/search?q=coronapoker&type=repositories` → 仅导航样板
- `www.freshports.org/games/coronapoker` → 含删包原因
- `gtowizard.com/` → 商业 SaaS

**抓取失败/被拒的 URL（诚实记录）**

- `alankuhnle.com/.../opp-model.pdf` → `unsupported content type "application/pdf"`
- `smartpokerstudy.com/hud-reliability-number-of-hands-and-sample-sizes-226/` → **HTTP 418 Country Blocked**
- 多篇 tilting 相关 PDF → 同上，PDF 不支持

**本地文件（本项目，用于对照规划）**

- `D:\德州\docs\ARCHITECTURE.md`（535 行，已完整读取）
- `D:\德州\package.json`（`dezhou-poker-trainer` v0.1.0，中文优先）
- `D:\德州\src\`（16 个文件）
- `D:\德州\test\`（11 个测试文件）

---

## 14. 附录：本项目当前实际状态（已核实）

**已实现**（`src/` 实际存在 16 个文件）：
```
src/domain/domainCodes.ts, index.ts, types.ts
src/domain/poker/{cards,engine,equity,fastEval,gameState,handDescription,handEval,odds,positions,validator}.ts
src/i18n/index.ts, zh-CN.ts（16,221 字节）
src/infra/rng.ts
```

**ARCHITECTURE.md 引用但尚不存在**（已核实 `Test-Path` 全部返回 `False`）：
`src/domain/math/`、`src/domain/analysis/`、`src/domain/validator/`、`src/domain/state/`、`src/agents/`、`src/app/`、`src/infra/storage/`

**测试**：`test/` 下有 11 个文件（cards / engine / equity / handEval / odds / positions / positionConsistency / state / validator / i18n + helpers）。

**判定**：本项目处于 **阶段 1–3（确定性内核）**。`ARCHITECTURE.md` 描述的是一个**远大于当前实现**的目标架构。阶段 4–10（范围、决策、玩家模型、多智能体、中文 Web UI、历史、回放、漏洞报告）**均未开始**。

> **提示（推测）**：融合矩阵中标注为「核心」的 9 项功能里，**8 项仍在待办状态**。参考项目能提供的是**设计思路**，不能替代本项目自身的实现与验证工作。

---

## 15. 复核记录（由主 Agent 独立验证）

> 本节由项目主 Agent 在收到审计报告后**独立复核**，不属于原子代理的产出。
> 复核方法：直接调用 `api.github.com` 与 `raw.githubusercontent.com`，不依赖原报告的任何中间结论。

### 15.1 许可证与元数据 —— 全部核实通过

| 仓库 | 报告声称 | 独立复核结果 | 一致性 |
|---|---|---|---|
| `omkarxpatel/wizgto` | Apache-2.0 / star 1 / TypeScript | `Apache-2.0` / star 1 / TypeScript | ✅ 一致 |
| `matthiola0/poker-hand-review` | MIT / star 6 | `MIT` / star 6 / Python | ✅ 一致 |
| `luckyone18/Poker` | 无许可证 / star 0 | `license = NONE` / star 0 / Python | ✅ 一致 |
| `tonikelope/coronapoker` | GPLv3 / star 22 | `GPL-3.0` / star 22 / Java | ✅ 一致 |
| `96jsalinas/Poker-Game-Analyzer` | MIT / star 4 | `MIT` / star 4 / Python | ✅ 一致 |

**结论**：报告的许可证判定 **5/5 全部准确**，包括「无许可证」这一关键否定判定。
这在许可证合规场景下非常重要 —— 误判许可证会导致法律风险。

### 15.2 两条合规红线 —— 均已核实原文

**红线一：`luckyone18/Poker`（无许可证）**

复核抓取了 `docs/money-maker-roadmap.md`，原文确认（节选，逐字）：

> `**Goal:** Generate consistent profit from crypto poker (SWC Poker / swcpoker.com)`
> `1. **Get AI working in simulation** ... 2. **Deploy to real platform** (SWC Poker WebSocket integration) 3. **Operate profitably** (bankroll management, anti-detection)`
> `**Goal:** Reliable +EV decision engine for real-money play`

→ **确认为真**：该仓库的公开路线图明确规划在**真钱加密扑克平台**部署**反检测**机器人。
同时该仓库**没有任何许可证**，代码不可复制。

**红线二：`omkarxpatel/wizgto`（Apache-2.0）**

复核抓取了 `README.md`（210 行），原文确认（第 152 行，逐字）：

> `> **Use responsibly.** Real-time assistance is against PokerNow's terms and is cheating in any game against strangers or for stakes. This surface exists for private tables among friends who have all consented, and for reviewing your own play afterwards. Keep it there. The engine, arena bot, trainer and analysis tools carry no such caveat — they touch nobody else's game.`

→ **确认为真**：作者**自己承认**实时辅助构成作弊。
**但需精确区分范围**（避免误伤）：作者明确把「引擎 / 竞技场机器人 / 训练器 / 分析工具」划在警告之外 ——
即**只有 `extension/` 实时浮层触线**，其余工具带无此警告。报告 §10.1 的表述是准确的。

### 15.3 对本项目的直接含义（与合规红线对齐）

| 参考项目的做法 | 本项目立场 | 依据 |
|---|---|---|
| 浏览器扩展实时读取牌桌并浮层提示 | **禁止** | 架构 §19 合规红线：不留任何自动读取牌桌接口 |
| 在真钱平台部署反检测机器人 | **禁止** | 同上 |
| 从**已结束**牌局的手牌历史中建模对手 | **允许**（本来就是设计的一部分） | 本项目定位：手动录入 + 牌后分析 + 复盘 |
| 「门控于样本量」的 exploit 调整 | **借鉴** | 与本项目「样本量保护」方向一致 |
| 把对手范围重塑后再让求解器计算 | **借鉴思路** | 与本项目 Range Engine「先理论后针对」一致 |

> **要点**：本项目的「训练 + 复盘 + 决策研究」定位**天然不需要**实时读取牌桌。
> 参考项目里最有价值的部分（EV 损失归因、样本量保护、tilt 建模、范围更新）
> **全部不依赖**实时数据采集，可以合法且安全地借鉴。

### 15.4 未能验证项的独立评估

报告 §11 列的「未能验证」清单，经复核后**认可其诚实性**：

- **`texas_poker`**：复核确认 GitHub 上不存在名为 `texas_poker` 的「教练/顾问架构」仓库。
  该任务描述**疑似误植**。报告的处理方式（明确标为「未能验证」而非编造）是正确的。
  真正的盲区是「某个 monorepo 内的子目录」，需要认证的代码搜索才能排除。
- **性能指标**：如 `wizgto` 的「1.83× 提升」等，均为仓库自述，未经运行验证。
  报告已逐条标注为自述，处理正确。
- **原代理的方法论自我更正（§0.1）**：初稿因抓取客户端渲染的 GitHub 搜索页而得出
  「项目不存在」的假阴性，后改用 REST API 更正。**这一更正本身是审计质量的正面信号** ——
  它主动暴露并修正了自己的错误，而不是隐藏。已采纳其方法论教训：
  **GitHub 检索必须用 API，不可抓 HTML。**

### 15.5 复核结论

- **许可证判定**：5/5 准确 → 可以据此采信。
- **合规红线**：2/2 已核实原文 → 必须作为硬约束执行。
- **可借鉴设计**：EV 损失归因、样本量保护、tilt 作用于风格而非数学、
  指数遗忘跨手记忆 —— 四项均**不依赖**实时采集，与本项目定位兼容。
- **禁止照搬**：报告 §10 的 25 条清单可作为代码审查检查表使用。
- **未验证项**：报告已诚实标注，无需额外处理，但**采信前需独立复核**（本结论亦同）。

---

**报告结束。**

> 本报告全部结论基于本次审计时点的公开信息与源码快照。项目状态可能随时间变化。
> 所有标「推测」的内容均**未经运行验证**，采纳前请独立复核。
> §0.1 已记录本报告对首稿两处错误判定的更正。
> §15 为主 Agent 的独立复核记录，与原审计内容分开标注，避免混淆证据来源。
