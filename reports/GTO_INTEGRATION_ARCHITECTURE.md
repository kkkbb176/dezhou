# GTO 集成架构（Alpha × GTOpen）

> 本文件说明**新增的这部分代码是怎么组织的、为什么这么组织**，
> 以及**哪些边界是硬的**（有测试强制）。
>
> 前提（不可协商）：**GTOpen 是独立计算引擎，Alpha 是主应用，二者通过明确的
> Provider 接口连接。现有 Alpha 不被重写。**

---

## 1. 分层图

```
┌──────────────────────────────────────────────────────────────────────┐
│ 浏览器                                                                │
│   GET  /            牌桌录入页（原有，未改逻辑，仅加一个入口按钮）        │
│   GET  /gto         中文 GTO 范围页（新增）                            │
│   GET  /gto.js/.css 静态资源（新增）                                   │
│   POST /api/analyze 原有决策接口（**一行未改**）                        │
│   GET  /api/gto/*   新增 GTO 接口                                     │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ 只走 Alpha 自己的 HTTP（前端不碰 GTOpen）
┌───────────────────────────▼──────────────────────────────────────────┐
│ src/app/webServer.ts   （唯一改动：新增 3 条 GET + 1 条 POST 路由）      │
│   · /api/gto/health    · /api/gto/catalog    · POST /api/gto/range    │
│   · 启动自检新增一项：GTO 场景目录自检（Fail-Closed，**不依赖求解器在线**）│
└───────────────────────────┬──────────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────────┐
│ src/app/gto/          应用层（装配 + 目录 + 界面契约）                  │
│   gtoApi.ts               唯一装配点：Provider、缓存、关闭开关          │
│   gtoScenarioCatalog.ts   场景目录：4/5/6/8/9 人桌 × 位置 × 场景模板     │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ 只依赖 **接口**
┌───────────────────────────▼──────────────────────────────────────────┐
│ src/domain/gto/       领域层（纯类型 + 纯函数 + 安全查询）              │
│   gto.types.ts            GtoProvider / GtoScenario / GtoBaseline / …  │
│   gtopenHandMatrix.ts     169 类矩阵与类号换算（唯一权威）              │
│   gtoScenario.ts          场景构造 / 归一化 / 哈希 / 自检               │
│   gtoSafeLookup.ts        缓存 + 外层硬超时 + 失败不缓存               │
│   providers/                                                          │
│     providerRegistry.ts   注册表（**禁止 if engine === 'gtopen'**）    │
│     gtopenProvider.ts     ★ 唯一知道 GTOpen JSON 结构的地方            │
│     gtopenMapping.ts      位置 / 动作映射                              │
│     gtopenHttpClient.ts   传输层：超时 / 连接失败 / 坏响应 / 超大响应    │
│     gtopenCapabilities.ts 能力声明 + 可信度天花板（APPROXIMATE）        │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ 只依赖 HTTP
┌───────────────────────────▼──────────────────────────────────────────┐
│ GTOopen/GTOpen（外部开源项目，**未修改任何 .rs 源码**）                 │
│   gto-server.exe  ←  http://127.0.0.1:3737                            │
│   本地进程；与 Alpha **不同进程、不同生命周期**                          │
└──────────────────────────────────────────────────────────────────────┘
```

**关键性质**：GTOpen 崩溃 / 不启动 / 超时，只影响最底下一层。
上面的每一层在拿不到数据时都有明确的、可展示的降级路径。

---

## 2. 数据流（一次范围查询）

```
用户在 /gto 选择「6 人桌 / UTG / 第一个入池 / 100BB」
  │
  ├─ 前端 GET /api/gto/catalog         ← 纯本地计算，不需要求解器
  │      位置列表来自 GTO_POSITION_ORDER（唯一权威）
  │
  └─ 前端 POST /api/gto/range {tableSize, heroPosition, template, effectiveStackBB}
        │
        ├─ gtoApi.queryGtoCatalogEntry
        │     ├─ gtoTableSizeOf(6) → 6（不在 4/5/6/8/9 内即 UNAVAILABLE）
        │     ├─ 在**目录**里按 id 找条目（界面无法编造场景）
        │     └─ entry.scenario === null → UNAVAILABLE + 具体中文原因
        │
        ├─ gtoApi.queryGtoScenario
        │     └─ GtoSafeLookup.lookupWithStats
        │           ├─ 缓存命中？（键 = scenarioHash，**逐字段复核**）
        │           ├─ 同场景并发合并（共享 Promise）
        │           └─ Promise.race(provider.lookupScenario, 外层硬超时)
        │
        └─ GtopenProvider.lookupScenario（**串行队列**，因为 GTOpen 只有一个会话）
              ├─ 1. supportLevelFor(kind, tableSize) → 不支持则**不发请求**
              ├─ 2. POST /api/preflop/estimate   预检树规模（超限即在建树前拦截）
              ├─ 3. POST /api/preflop/spot       建树（替换当前会话）
              ├─ 4. POST /api/preflop/solve      **异步**：立即返回
              ├─ 5. 轮询 GET /api/preflop/status 直到 state ≠ running（有硬上限）
              ├─ 6. 边走边问：POST /api/preflop/node {path}
              │      每一步读回**真实动作菜单**，用 kind + 金额匹配下一条前序动作
              ├─ 7. 核对回显座位表（verifyPositionsEcho）
              └─ 8. 转换：strategy[a*169+classIndex] → GtoHandStrategy[]
```

### 2.1 为什么路径要「边走边问」而不是算出来

求解器一个节点的动作菜单取决于它内部状态：是否允许跛入、加注上限、
是否把大额加注变成全下、最小加注是否被夹取……用公式猜下标会在边界上
**静默错位一格**，而错位一格的含义是「读到了另一个位置的策略」——
界面上所有名字都还是对的。

因此第 6 步对每一步都：
1. 请求当前节点；
2. 读回它**真实存在**的 `actions[]`；
3. 用 `kind`（语义类别）**加** `to`（金额）匹配下一条前序动作；
4. 匹配不到 → `UNSUPPORTED`（`matchActionIndex` 返回 `null`，**不做最近邻匹配**）。

`test/gtoProviderAdapter.test.ts` 的 GTO-ADP-05 直接测这条：
`3-bet 7.5` 存在时，要 `RAISE 3` **必须**返回 `null`。

---

## 3. 领域模型（`src/domain/gto/gto.types.ts`）

```
GtoProvider（接口）
  ├─ engine / displayName
  ├─ health()      → GtoProviderHealth
  ├─ capabilities()→ GtoEngineCapabilities | null
  └─ lookupScenario(GtoScenario) → GtoLookupResult（**永不抛异常**）

GtoScenario（**理论场景，类型上不含任何真人字段**）
  kind · gameType · tableSize · effectiveStackBB · heroPosition
  villainPosition · actionHistory[] · raiseSizesBB[] · blinds

GtoScenarioAction  { position, kind, sizeBB }
GtoBlindStructure  { sbBB, bbBB, anteBB }

GtoLookupResult = GtoBaseline | GtoUnavailable

GtoBaseline
  ├─ scenario       （归一化后的场景）
  ├─ scenarioHash   （= scenarioHashOf(scenario)）
  ├─ range: GtoRange
  └─ metadata: GtoMetadata

GtoRange
  actorPosition · actionMenu[] · hands[169] · potBB · reachable · unavailableReason

GtoHandStrategy
  hand（`AA`/`AKs`/`AKo`）· combos · reach · actions[]

GtoActionFrequency
  kind（FOLD/CHECK/CALL/BET/RAISE/ALL_IN）· sizeBB · frequency(0..1) · evBB(**或 null**) · rawLabel

GtoMetadata
  source{kind,engine,sourceVersion,engineCommit,endpoint} · scenarioHash
  solveSettings{iterationsRequested,iterationsCompleted,targetGap,reportedGap,modelName,raw}
  solveStatus（8 值）· verification（5 档）· approximation（结构化标记）· timestamp · latencyMs
```

### 3.1 为什么 `tableSize` 是**一级**参数

| 概念 | 含义 | 取值 | 谁定义 |
|---|---|---|---|
| `TableSize`（Alpha 录入层） | 这张桌子有几个**物理座位** | 6 / 9 | `src/domain/types.ts`（**未改**） |
| `GtoTableSize`（求解场景） | 这个理论场景按**几人桌**求解 | 4 / 5 / 6 / 8 / 9 | `src/domain/gto/gto.types.ts`（新增） |

二者刻意**不合并**：合并等于「为了加一个 GTO 页面去改录入层的契约」，
会波及 `reconstruct` / `validator` / 全部桌型测试。桥接只在
`GTO_POSITION_ORDER` 这一处发生，且方向单一。

### 3.2 位置体系（权威定义 + 与外部引擎的关系）

| 人数 | 座位顺序（= 翻牌前行动顺序） |
|---|---|
| 4 | `CO BTN SB BB` |
| 5 | `HJ CO BTN SB BB` |
| 6 | `UTG HJ CO BTN SB BB` |
| 8 | `UTG UTG1 LJ HJ CO BTN SB BB` |
| 9 | `UTG UTG1 UTG2 LJ HJ CO BTN SB BB` |

**与 GTOpen 的关系（源码核对的事实）**：
`PreflopConfig.positions` 是一个 `Vec<String>`，求解器**只使用它的长度与下标**：

- `validate()` 只检查 `2..=9` 与 `posts.len() == positions.len()`；
- 树按**座位下标**推进（`next_seat`）；
- 盲注由 `posts` 给出，**不是**由名字推断；
- 位置名只出现在 `actor_pos` / `history[].actor_pos` / 错误信息里。

因此「映射」的真实含义是 **第 i 个座位 = 哪一种角色**，
而这个角色完全由「行动顺序 + 盲注位」决定 —— 正是 `GTO_POSITION_ORDER` 的定义。

⚠️ 上游参考数据里 8 座用的是 `MP` 而不是 `LJ`。我们**不跟随改名**：
本项目的位置名是一份对外契约（Alpha 的 `Position` 也是这套名字）。
如果将来某个求解器**要求**特定名字，只需要改 `POSITION_LABELS` 一处。

**并且我们不靠「猜了就信」**：响应回来后用 `verifyPositionsEcho()`
核对回显的座位表与请求**逐位一致**，以及最后两座必须是 SB/BB。
不一致即 `INVALID_RESPONSE` → 回退。

---

## 4. 硬边界（每条都有测试强制）

| # | 边界 | 强制方式 |
|---|---|---|
| B-1 | **只有适配层能碰 GTOpen 的端点** | `gtoScenarioIsolation.test.ts` GTO-SCN-13：扫描 `src/**/*.ts`，除 `providers/gtopen*.ts` 外出现端点片段即失败 |
| B-2 | **Decision Engine / contextBuilder / preflopPriors / likelihoodModel 不得 import Provider** | GTO-SCN-14：只检查 import/export 行，命中即失败 |
| B-3 | **Decision Engine 不出现任何 GTO 分支** | GTO-SCN-15：`decisionEngine.ts` 里不得出现 `gto`（含注释剥离后的正文） |
| B-4 | **前端不得硬编码求解器地址/端口** | GTO-SCN-16：`gto.js` / `table.js` 不得出现 `3737` / `127.0.0.1` / `preflop` |
| B-5 | **桌人数必须进哈希** | GTO-SCN-01/02 + `selfCheckScenarioLayer()`（服务器启动自检） |
| B-6 | **同名位置在不同人数下必须不同** | GTO-SCN-01：CO/BTN/SB/BB × 5 个桌型逐一比对 |
| B-7 | **7 人桌必须被拒绝** | GTO-SCN-05 + GTO-ADP-22（且**不发任何 HTTP 请求**） |
| B-8 | **翻前可信度上限 = APPROXIMATE** | GTO-SCN-17 + GTO-ADP-06（断言 `verification === 'APPROXIMATE'`） |
| B-9 | **真人信息不得进入查询** | GTO-ADP-27/28：改 Tilt/画像/动态提示后，节点请求体**逐字节一致**、结果**逐位一致**；且请求体不得出现任何真人字段名 |
| B-10 | **求解器离线不得让 Alpha 崩溃/白屏** | GTO-ADP-16 + GTO-UI-09（HTTP 仍 200，返回 `UNAVAILABLE` + 中文原因） |
| B-11 | **不得无限等待** | GTO-ADP-21（求解不结束 → TIMEOUT）+ GTO-ADP-26（Provider 卡死 → 外层硬超时） |
| B-12 | **坏数据一律拒收** | GTO-ADP-12/13/14/18（长度不符 / 百分数频率 / 缺字段 / 非 JSON） |
| B-13 | **失败不缓存** | GTO-ADP-25（离线结果不写缓存，求解器恢复后同场景能拿到数据） |
| B-14 | **混合策略不得被压成单一动作** | GTO-ADP-06（AKs/AKo 必须 `actions.length >= 2`）+ GTO-UI-14 |
| B-15 | **EV 拿不到就是 null** | GTO-ADP-06（遍历 169 类断言 `evBB === null`） |
| B-16 | **界面不得宣称「绝对 GTO」** | GTO-UI-01（`<b>绝对 GTO</b>` 与 `状态：绝对` 均不得出现） |
| B-17 | **拿不到数据不得渲染矩阵** | GTO-UI-05（失败分支必须清空矩阵 DOM） |
| B-18 | **169 类矩阵方向正确** | `gtoHandMatrix.test.ts` 13 项，含类号锚点 AA=168 / AKo=155 / A5s=159 |

---

## 5. 失败回退（**强制路径**，不是兜底逻辑）

```
GTOpen 没启动 / 连不上         → OFFLINE
HTTP 超时                      → TIMEOUT
求解失败（5xx）                → FAILED
场景不支持（人数/动作树超限）  → UNSUPPORTED
响应不合法（JSON/结构/长度）   → INVALID_RESPONSE
回显座位表不一致               → INVALID_RESPONSE
求解迟迟不结束                 → TIMEOUT（**不使用半途策略**）
频率越界（0..1 之外）          → INVALID_RESPONSE
                 └──────────────┬──────────────┘
                                ▼
                    GTO_BASELINE_UNAVAILABLE
                                │
        ┌───────────────────────┴────────────────────────┐
        ▼                                                ▼
  界面：显示中文原因，**不渲染矩阵**            Alpha：继续走原有链路
  （不会用启发式先验冒充 GTO）                 （牌桌录入 / 建议 / 数学九项全部正常）
```

**严禁的四件事**（本轮明确禁止，且都有对应测试或结构保证）：
1. crash（→ 所有失败都返回结构化对象，`lookupScenario` 声明为永不抛）
2. 假数据（→ 没有降级频率表、没有默认频率）
3. LLM 猜 GTO（→ 整条 GTO 链路是纯确定性代码，无任何 LLM 调用）
4. 偷偷用旧 Prior 冒充 GTO（→ `preflopPriors` 的输出走的是 Alpha 原有的
   `range.sourceKind = HEURISTIC` 通道，界面标注「启发式先验，不是求解器输出」；
   GTO 页面的数据**只**来自 `GtoProvider`，两者在类型与界面上都不相交）

---

## 6. 数据来源与可信度（`GtoMetadata` 的九个字段）

| 字段 | 来源 | 拿不到时 |
|---|---|---|
| `source.kind` | 固定 `SOLVER` | — |
| `source.engine` | Provider 自述（`gtopen`） | — |
| `source.sourceVersion` | 求解器自述版本 | **`null`**（GTOpen 没有版本端点） |
| `source.engineCommit` | 本项目手工记录并在报告里给出文件 hash | **`null`** |
| `source.endpoint` | Provider 配置 | `null` |
| `scenarioHash` | `scenarioHashOf()`（含桌人数） | — |
| `solveSettings` | 请求参数 + 求解器自述的迭代/gap/模型名 | 单项为 `null` |
| `solveStatus` | 求解器自述的 state / stop_reason | `GTO_BASELINE_UNAVAILABLE` |
| `verification` | **本项目判定**（见下） | `UNVERIFIED` |
| `approximation` | 结构化标记 + 逐条中文说明 | 全部 `false` |
| `timestamp` / `latencyMs` | 注入的时钟 | — |

### 6.1 可信度判定的**唯一实现**

| 情形 | 等级 |
|---|---|
| 求解器用了近似模型（**GTOpen 的翻前恒为此**） | 最高 `APPROXIMATE` |
| 有数据但未收敛 | `APPROXIMATE`（并带 `notConverged: true`） |
| 收敛且模型为精确模型 | `SOLVED` |
| 被**第二个独立求解器**交叉验证过 | `CROSS_CHECKED` |
| 人工复核 + 双求解器一致 + 精确模型 | `VERIFIED` |
| 任何失败 | `UNVERIFIED` |

🔴 **本阶段 GTOpen 的翻前结果永远落在第一行**，因为源码自述其翻前是
「modeled continuation payoffs, not a full postflop game」。
代码里由常量 `GTOPEN_PREFLOP_MAX_VERIFICATION = 'APPROXIMATE'` 实现，
测试 GTO-SCN-17 与 GTO-ADP-06 双重锁死。

---

## 7. 为未来预留的接口（本轮只立结构，**不接入**）

```ts
GtoProvider          ← 接口（已有）
  ├─ GtopenProvider        ← 已实现（本地 GTOpen）
  ├─ OtherSolverProvider   ← 预留（chirenonhive/poker-solver 交叉验证）
  └─ OurSolverProvider     ← 预留（自研）
GtoProviderSet       ← 已实现（多引擎集合，对外表现得像一个 Provider）

OpponentEstimate     ← 已定义（来自现有 Alpha 的 preflopPriors / 范围链）
ExploitAdjustment    ← 已定义（`magnitude: number | null`，无依据时必须为 null）
FinalStrategy        ← 已定义（GTO 基线 + 对手估计 + 剥削调整）
GtoDistance          ← 已定义，**本阶段恒为 `null`**
```

### 7.1 为什么 `GtoDistance` 恒为 `null`

「距离」需要一个频率空间上的度量，而本轮：
- 没有对手的真实频率（Alpha 的范围是启发式先验，不是实测）；
- 没有第二个求解器做交叉验证。

因此**无法严谨计算**。按本项目一贯纪律（与知识层的 `magnitude` 同一条）：
**返回 `null`，不编数字。**

### 7.2 为什么必须有 `GtoProviderSet`

下一阶段要接第二个求解器做交叉验证。届时唯一应该发生的事情是：

```ts
const set = new GtoProviderSet([createGtopenProvider(), createOtherSolverProvider()]);
```

**而不是**在 Decision Engine / UI / 缓存 / 日志里各写一遍
`if (engine === 'gtopen')`。后者每加一个求解器就要改五六处，
漏掉任何一处都会静默走错分支。B-1…B-4 四条静态扫描测试就是为此立的。

---

## 8. 缓存策略

| 项 | 值 |
|---|---|
| 缓存键 | `scenarioHashOf(scenario)`（**含** `tableSize` / 筹码 / 位置 / 动作历史 / 尺寸 / 盲注） |
| 额外校验 | `scenariosEquivalent()` **逐字段复核**。只比哈希会在「哈希漏了一个字段」时静默命中错误缓存 |
| 哈希相同但场景不同 | **不信缓存**，并删掉该条 |
| TTL | 30 分钟（内存缓存，进程内） |
| 容量 | 64 条，LRU 淘汰 |
| 失败结果 | **不缓存**（否则求解器重启后界面仍显示旧的「离线」） |
| 缓存命中 | 结果带 `approximation.fromCache = true` + 一条中文说明；界面显示「本次来自缓存，未重新求解」 |
| 求解器版本变化 | 换求解器 / 重建后调 `clearCache()`（本阶段靠 `ALPHA_GTO` 与重启；下一阶段加 `engineCommit` 进键） |

---

## 9. 关闭开关

| 方式 | 效果 |
|---|---|
| `ALPHA_GTO=off`（或 `0` / `false` / `no`） | 所有 GTO 查询立即返回「已关闭」，**一个字节的网络请求都不发** |
| `setGtoEnabled(false)`（代码） | 同上 |
| `GTOPEN_URL=http://…` | 换求解器地址（默认 `http://127.0.0.1:3737`） |

关闭状态下的保证（有测试 GTO-UI-16/17）：
- 界面**仍然完全可用**，包括场景目录与位置下拉框；
- 不会出现转圈或白屏；
- 明确告诉使用者「GTO 已关闭」，并说明「不会用近似先验冒充 GTO 基线」。

---

## 10. 明确不做的事（本轮）

| 不做 | 理由 |
|---|---|
| 重写现有 Alpha | 用户明确禁止；且 1370 项测试的基线不应被一次集成打断 |
| 自行实现 CFR / 求解器 | 用户明确禁止；本轮目标是**接入**而不是**重造** |
| 把 GTO 接进 Decision Engine | 用户明确要求「先只把 GTO 数据成功读进来」；且要先证明数据可信 |
| 复制任何商业 GTO 数据库 | 用户明确禁止 |
| 线上客户端自动识别 / 自动点击 / 自动控制 | 用户明确禁止（本工具只做手动输入后的参考） |
| 为测试伪造真实 GTO 数据 | 测试替身（`FakeGtopen`）只存在于测试进程内，且**结构上与真实响应一致**；生产路径只连真实求解器 |
| 大规模求解所有 Postflop | 本轮范围外 |
| 修改现有 Alpha 的验收标准 | 本轮**加强**了约束（新增 4 条静态扫描 + 桌人数隔离），没有放宽任何一条 |
