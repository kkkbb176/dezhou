# GTO 集成 · 第一阶段最终报告

> 本报告回答一个问题：**这一轮到底做成了什么，以及哪些没做成。**
>
> 判定见文末。所有数字来自可重跑的命令，原始证据在 `reports/evidence/`。

---

## 1. 目标与结论

**用户的本轮目标**：把开源 GTOpen 作为**独立本地 Solver Engine** 接入现有 Alpha，
支持 4/5/6/8/9 人桌 × 100BB × 翻牌前，能读取 169 类起手牌范围与真实策略频率，
保留混合策略，中文 13×13 界面；**绝对不得破坏现有 Alpha**。

**结论**：

| 项 | 结果 |
|---|---|
| 原 Alpha 无回归 | ✅ **PASS** — `npm run verify` exit 0；**1,375 项 / 136 套件 / 0 失败**；**0 处断言被放宽** |
| GTOpen 独立运行 | ✅ **PASS** — commit `92c86ed`，CPU 编译成功，端口 3737，6 个端点实测正常 |
| Provider 抽象完成 | ✅ **PASS** — `GtoProvider` 接口 + `GtopenProvider` 适配器 + 注册表；4 条静态扫描测试强制边界 |
| Preflop Range 能读取 | ✅ **PASS** — **5 档桌人数全部读到真实 169 类数据**（4/5/6/8/9 逐个实跑） |
| 中文 13×13 UI | ✅ **PASS** — `/gto` 页面；桌人数/位置/场景三级联动；混合策略完整显示 |
| 失败回退 | ✅ **PASS** — 7 种失败路径全部返回 `GTO_BASELINE_UNAVAILABLE`，Alpha 继续运行 |
| 未知数据不伪造 | ✅ **PASS** — `evBB` 恒为 `null`；无降级频率表；无 LLM |
| 近似策略正确标识 | ✅ **PASS** — 可信度上限锁死 `APPROXIMATE`；界面显示「近似求解」 |
| 全部新增测试通过 | ✅ **PASS** — **89 项**新增 GTO 测试全绿 |

**最终裁决**：`GTOPEN MULTI-TABLE PHASE 1 — PASS`
（逐档明细见 §7；一条边界条件见 §7.3 —— 8/9 人桌的动作菜单不含全下，
**已明确声明、有实测依据、有测试锁住、界面可见**）

---

## 2. 原 Alpha 测试结果（回归证据）

### 2.1 本轮开始前的基线（**先记录，再动手**）

| 项 | 基线值 |
|---|---|
| 测试 | **1,286 项 / 136 套件 / 0 失败** |
| 测试文件 | 49 个 |
| 类型检查 | 零错误 |
| 产物清单 | 97 个 / 6 类 |
| 可恢复 checkpoint | `D:\德州_checkpoint_alpha_20260726`（216 个文件；**排除** `node_modules` / `GTOopen` / `engines`） |

⚠️ Alpha 目录**不是 git 仓库**（`git status` → `not a git repository`），
因此 checkpoint 用文件级复制 + 关键文件 SHA256 双重确认：
`alphaPipeline.ts` = `B0518E83…`、`decisionEngine.ts` = `6621296C…`、`package.json` = `41B8FA39…`。

### 2.2 本轮结束后的结果

```
> npm run verify

> tsc --noEmit                       → 零错误
> generateManifest.ts --check        → ✔ 全部 118 个产物与清单一致
> node --test "test/**/*.test.ts"    → ℹ tests 1375 / suites 136
                                       ℹ pass 1375 / fail 0
EXIT = 0
```

| 项 | 基线 | 现在 | 变化 |
|---|---|---|---|
| 测试项 | 1,286 | **1,375** | **+89** |
| 套件 | 136 | 136 | 0 |
| 测试文件 | 49 | **53** | +4 |
| 失败 | 0 | **0** | **0** |
| 类型检查 | 零错误 | **零错误** | 0 |
| 产物 | 97 | **118** | +21 |

### 2.3 「无回归」不只是「测试绿」

| 额外证据 | 方式 | 结果 |
|---|---|---|
| Decision Engine 里没有 GTO 分支 | 静态扫描 `decisionEngine.ts` 正文不得出现 `gto` | ✅ |
| 决策链不 import 任何 Provider | 扫描全部 `src/**` 的 import/export 行 | ✅ |
| 前端不直接访问求解器 | `gto.js`/`table.js` 不得出现 `3737`/`127.0.0.1`/`preflop` | ✅ |
| 原有页面元素仍在 | `/` 仍含 `id="seats"`、`id="analyzeBtn"` | ✅ |
| 原有 97 个产物逐位未变 | `verify` 的 SHA256 比对 | ✅ |
| `manualInput` / `reconstruct` / `preflopPriors` / `likelihoodModel` | **一行未改**（`manualInput` 的 `tableSize` 仍只允许 6/9） | ✅ |

### 2.4 本轮对既有测试文件的**唯一**改动

| 文件 | 改了什么 | 是否放宽 |
|---|---|---|
| `CURRENT_PROJECT_STATUS.md` | 同步真实数字（1,286→1,375、49→53、97→118、新增 GTO 边界说明） | **否** —— `projectStatus.test.ts` 本身就是「文档必须与实际一致」的双向检查，不同步反而会失败 |
| 测试断言 | **0 处** | **否** |

---

## 3. GTOpen（外部引擎）

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/MatthewPDingle/GTOpen` |
| commit SHA | **`92c86ed73aa0856df8479b5c7635e1469f48f1e8`**（2026-09-11） |
| SHA 如何核对 | ① `git ls-remote --symref … HEAD`；② `GET api.github.com/repos/…/commits/master` —— 两条独立途径一致 |
| ⚠️ 获取方式 | 直连 `git clone` 失败（`RPC failed; curl 18`），改用归档包 `codeload.github.com/.../zip/refs/heads/master`（97.04 MB）。**归档包没有 `.git`**，因此无法用 `git log` 二次核对；改用逐文件 SHA256（见能力审计 §1.1） |
| Rust | `rustc 1.98.1 (48a229cea 2026-09-01)` / `cargo 1.98.1 (797e8a9bc 2026-08-05)` |
| 构建目标 | `x86_64-pc-windows-gnu`（**不是**上游推荐的 MSVC —— 本机没有 MSVC C++ 生成工具） |
| 工具链 | MinGW-w64 GCC 16.1.0（winlibs, msvcrt-posix-seh）@ `C:\Users\71061\.local\mingw64` |
| 编译 | `cargo build --release -p server`（CPU，无 `--features gpu`）；**5 分 23 秒**；产物 6,387,466 字节 |
| 启动 | `PORT=3737 PREFLOP_MAX_ARENA_MB=1600 PREFLOP_MAX_NODES=1200000 RAYON_NUM_THREADS=8 SOLVER_GPU=0`；工作目录必须是仓库根 |
| 端口 | **3737** |
| 源码是否被修改 | **没有**（唯一新增是 `.cargo/config.toml` 与启动脚本，均不触碰 `.rs`） |
| 版本端点 | **不存在** —— GTOpen 不暴露版本/commit。因此 `sourceVersion` 恒为 `null`，`engineCommit` 由本项目常量手工记录 |
| 落地位置 | `德州/GTOopen/GTOpen/`（**不在** `src/` 下） |
| 源码规模 | 3,116 文件 / 163.73 MB |

---

## 4. 新增与修改的文件

### 4.1 新增（**11 个源文件 / 4,436 行**）

| 文件 | 行数 | 作用 |
|---|---:|---|
| `src/domain/gto/gto.types.ts` | 629 | GTO 领域类型：`GtoProvider` / `GtoScenario` / `GtoRange` / `GtoHandStrategy` / `GtoActionFrequency` / `GtoMetadata` / `GtoSolveStatus` / `GtoVerification` / `GtoSource` / 未来融合接口 |
| `src/domain/gto/gtopenHandMatrix.ts` | 438 | 169 类矩阵**唯一权威**：显示序号 ⇄ 求解器类号、组合数、频率单位、启动自检 |
| `src/domain/gto/gtoScenario.ts` | 484 | 场景构造 / 归一化 / **哈希（含桌人数）** / 自检 |
| `src/domain/gto/gtoSafeLookup.ts` | 267 | 结果缓存 + **外层硬超时** + 失败不缓存 + 同场景并发合并 |
| `src/domain/gto/providers/providerRegistry.ts` | 124 | 注册表 + `GtoProviderSet`（多引擎，为交叉验证预留） |
| `src/domain/gto/providers/gtopenProvider.ts` | 1,199 | ★ **唯一**知道 GTOpen JSON 结构的地方：串行队列 / 建树 / 求解轮询 / 边走边问的节点路径 / 响应转换 |
| `src/domain/gto/providers/gtopenMapping.ts` | 240 | 位置与动作映射 + **座位回显校验**（防错位一格） |
| `src/domain/gto/providers/gtopenHttpClient.ts` | 245 | 传输层：超时 / 连接失败 / 非 JSON / 空响应 / 超大响应 |
| `src/domain/gto/providers/gtopenCapabilities.ts` | 130 | 能力声明 + **可信度天花板 = APPROXIMATE** |
| `src/app/gto/gtoApi.ts` | 379 | Alpha↔Provider 的**唯一装配点**；关闭开关；界面响应契约 |
| `src/app/gto/gtoScenarioCatalog.ts` | 301 | 场景目录：5 个桌型 × 位置 × 4 种场景模板 |

### 4.2 新增（前端 3 个 + 工具/测试/证据若干）

| 文件 | 作用 |
|---|---|
| `src/app/web/gto.html` | 中文 GTO 范围页 |
| `src/app/web/gto.css` | 矩阵样式（配色语义：加注/跟注/弃牌/无数据） |
| `src/app/web/gto.js` | 13×13 矩阵渲染、混合策略详情、**唯一的百分比格式化入口** |
| `GTOopen/start-gtopen.ps1` | 求解器启动脚本（含内存/线程限制说明） |
| `GTOopen/GTOpen/.cargo/config.toml` | 本机构建配置（GNU 链接器 / 镜像 / ASCII 产物目录） |
| `scripts/gto-live-probe.ts` | 真实联调探针（逐行落盘证据） |
| `scripts/gto-timing-probe.mjs` | 单档速度标定 |
| `test/helpers/fakeGtopen.ts` | **结构一致**的求解器替身（仅测试进程内） |
| `test/gtoHandMatrix.test.ts` / `gtoProviderAdapter.test.ts` / `gtoScenarioIsolation.test.ts` / `gtoWebUi.test.ts` | 4 个测试文件 / **89 项** |
| `reports/evidence/*` | 原始实测证据 |

### 4.3 修改（**只动必要的接入点**）

| 文件 | 改了什么 | 为什么必须改 |
|---|---|---|
| `src/app/webServer.ts` | 新增 4 条 GTO 路由（`/gto` 页面 + `/gto.css` + `/gto.js`、`/api/gto/health`、`/api/gto/catalog`、`POST /api/gto/range`）；`/api/health` 加一个 `gto` 状态字段；**启动自检新增 GTO 场景目录自检** | 界面需要入口；目录错位必须在服务器起来之前就被拦住 |
| `src/app/web/index.html` | 顶栏加一个「GTO 范围」按钮 | 用户要求「现有中文 Web UI 增加 GTO 范围」 |
| `src/app/web/table.js` | `boot()` 里给那个按钮绑一个跳转 | 同上（**不含任何牌局规则**，测试有强制） |
| `src/infra/artifactDefinitions.ts` | 登记 21 个新产物（含影响说明） | `verify` 要求「新增未登记 → UNLISTED」 |
| `CURRENT_PROJECT_STATUS.md` | 同步数字 + 新增「GTO 集成的边界」小节 | `projectStatus.test.ts` 强制 |
| `data/artifact-manifest.json` | 重新生成（118 个） | 同上 |

**没有改动的**（用户明确要求保留）：
`manualInput.ts` / `reconstruct.ts` / `preflopPriors.ts` / `likelihoodModel.ts` /
`legalActions.ts` / `contextBuilder.ts` / `decisionEngine.ts` / `alphaPipeline.ts` /
`dynamicShadow`（`dynamicAdapter.ts` / `dynamicDeviation.ts` / `dynamicShadowOf`）/ 既有全部测试。

---

## 5. API 调用方式（实测）

```
Alpha（webServer / gtoApi）
  │  只依赖 GtoProvider 接口
  ▼
GtopenProvider（src/domain/gto/providers/gtopenProvider.ts）
  │  HTTP，127.0.0.1:3737
  ▼
GTOpen（独立进程）
```

一次查询的真实调用序列：

| 步 | 请求 | 说明 |
|---|---|---|
| 1 | `POST /api/preflop/estimate` | 树规模预检。**超限就在建树之前拦下**（不浪费内存） |
| 2 | `POST /api/preflop/spot` | 建树（会替换当前会话；请求体见架构报告 §2） |
| 3 | `POST /api/preflop/solve {iterations, check_every, target_gap, early_preview:false}` | **异步**：立即返回 `{"ok":true}`，后台推进 |
| 4 | `GET /api/preflop/status`（轮询） | 直到 `state ≠ running`；有硬上限，到点判 `TIMEOUT` |
| 5 | `POST /api/preflop/node {path}`（**每一步一次**） | 「边走边问」：读回真实动作菜单，用 `kind` + 金额匹配下一条前序动作 |
| 6 | 同上，到达 Hero 节点 | 核对 `actor`/`actor_pos` 必须是 Hero，否则 `INVALID_RESPONSE` |
| — | 本地转换 | `strategy[a*169+classIndex]` → `GtoHandStrategy[]`；核对座位回显；算场景哈希 |

**关键实现事实**（都已写成测试）：
- GTOpen **同一时刻只有一个翻前会话** → Provider 用 Promise 串行链排队
- 响应**没有 `result` 包装**，节点字段在顶层
- `publication` 与 `/status` 字段名**不同**（`multiway_model` vs `multiway_equity_model`）
- 翻前节点接口**不给逐动作 EV** → 本项目 `evBB` 恒为 `null`

---

## 6. 故障回退结果（**强制路径**）

7 种失败全部有测试（`gtoProviderAdapter.test.ts`）：

| 失败 | 判据 | 用户看到什么 |
|---|---|---|
| 求解器没启动 | `OFFLINE` | 横幅：`GTO_BASELINE_UNAVAILABLE` + 「连不上 GTO 求解器…请确认它已经启动」 |
| HTTP 超时 | `TIMEOUT` | 同上，说明超时毫秒数 |
| 求解失败（5xx） | `FAILED` | 带 HTTP 状态码与响应正文片段 |
| 场景不支持 | `UNSUPPORTED` | 「本阶段不支持这个场景：7 人桌 / …」 |
| 响应不是 JSON | `INVALID_RESPONSE` | 「求解器返回的不是合法 JSON」 |
| 策略长度/频率越界 | `INVALID_RESPONSE` | 明确指出「长度应为 N，实际 M」/「频率不在 0..1 内」 |
| 求解迟迟不结束 | `TIMEOUT` | 「本次**不提供** GTO 数据：跑了一半的策略不能被当成基线」 |

**回退时 Alpha 的行为**（有测试）：
- HTTP 仍 **200**（不是 5xx）
- 矩阵**完全不渲染**（不是空矩阵 —— 空矩阵会被误读成「所有牌都弃牌」）
- 牌桌页 `/`、`/api/analyze`、决策链**完全不受影响**
- **不会**用启发式先验冒充 GTO

---

## 7. 逐档桌人数结论（用户要求的五项分别报告）

### 7.1 实测数据（`100BB` · `第一个入池` · 各桌型第一个行动位）

原始证据：`reports/evidence/gto-live-evidence.txt`（逐行落盘）。
求解器：**干净重启**后的独立进程；`PREFLOP_MAX_ARENA_MB=1600`、`RAYON_NUM_THREADS=8`、**无 GPU**。

| 桌人数 | Hero | 场景哈希 | 一次查询耗时 | 迭代（请求/完成） | BR gap 之和 | 动作菜单 | 真实读取 169 类 |
|---|---|---|---:|---|---:|---|---|
| **4** | CO | `ge84e835d` | **4.8 s** | 60 / 60 | 0.03412694 | Fold · Raise 2.5 · **All-in 100** | ✅ 169/169 |
| **5** | HJ | `g029facdc` | **18.4 s** | 60 / 60 | 0.08084305 | Fold · Raise 2.5 · **All-in 100** | ✅ 169/169 |
| **6** | UTG | `g715ed521` | **47.0 s** | 40 / 40 | 0.16526006 | Fold · Raise 2.5 · **All-in 100** | ✅ 169/169 |
| **8** | UTG | `g3864fe67` | **87.6 s** | 20 / 20 | 0.00417911 | Fold · Raise 2.5 | ✅ 169/169 |
| **9** | UTG | `g799d4c74` | **164.4 s** | 12 / 12 | 0.02102956 | Fold · Raise 2.5 | ✅ 169/169 |

5 个场景哈希**两两不同** —— 桌人数隔离在真实数据上的体现。

### 7.2 逐档明细

| 桌人数 | 支持的位置 | 支持的场景 | Range 是否真实读取 | 混合频率 | 是否 Approximate | 当前限制 |
|---|---|---|---|---|---|---|
| **4** | CO / BTN / SB / BB | 第一个入池 + 目录模板 | ✅ 真实读取（169/169） | ✅ 保留（含**全下**） | ✅ 是（近似延续模型） | 60 次迭代仍未收敛；无跛入分支；单尺寸 |
| **5** | HJ / CO / BTN / SB / BB | 同上 | ✅ 169/169 | ✅ 保留（含**全下**） | ✅ 是 | 同上 |
| **6** | UTG / HJ / CO / BTN / SB / BB | 同上 | ✅ 169/169 | ✅ 保留（含**全下**） | ✅ 是 | 同上 |
| **8** | UTG / UTG1 / LJ / HJ / CO / BTN / SB / BB | 同上 | ✅ 169/169 | ✅ 保留 | ✅ 是 | **动作菜单不含全下**（实测带全下无法收敛）；一次查询 ~88 秒 |
| **9** | UTG / UTG1 / UTG2 / LJ / HJ / CO / BTN / SB / BB | 同上 | ✅ 169/169 | ✅ 保留 | ✅ 是 | **动作菜单不含全下**；一次查询 ~164 秒 |

### 7.3 关于「全下」这条限制的完整交代

它不是能力造假，也不是随手砍功能，而是**实测标定后的取舍**：

| 配置 | 树节点 | 每次迭代 | 10 次迭代后的 BR gap |
|---|---:|---:|---:|
| 6 人桌 · 不带全下 | 1,272 | **0.73 s** | **0.015** |
| 6 人桌 · 带全下 | 2,538 | **1.90 s** | **0.998** |
| 8 人桌 · 不带全下 | 12,362 | **5.07 s** | **0.025** |
| 8 人桌 · 带全下 | 24,716 | **29.2 s** | **5.455** |
| 9 人桌 · 带全下 | 75,669 | ~33 s | **900 秒跑不完 12 次迭代** |

`add_allin` 让每次迭代慢 **4–6 倍**；而在 8/9 人桌上，带全下时 gap 高达 **5.455**
（不带全下是 0.025）—— 那份数据**根本没在收敛**。
此时给出「全下频率」不是「更完整的信息」，而是**把一个未收敛的数字摆在
一个看起来很确定的位置上**。

因此：4/5/6 人桌提供全下；8/9 人桌不提供，并在结果的 `approximation.notes` 里
**逐条写明原因**，界面上直接显示给使用者（测试 GTO-ADP-33/36/37 强制）。

### 7.4 ⚠️ 一个必须写进报告的比较陷阱

上表里 8 人桌的 `gap_total`（0.0042）**小于** 4 人桌（0.0341），
看起来像「8 人桌更准」。**这是错的读法**：
4/5/6 人桌的动作树有 3 条分支（含全下），8/9 人桌只有 2 条。
**不同的树 ⇒ gap 的定义不同 ⇒ 数字不可比。**
本报告**不**声称「8/9 人桌更收敛」。

---

## 8. 当前风险

| # | 风险 | 影响 | 现状 |
|---|---|---|---|
| R-1 | 翻前是**近似延续模型** | 频率 ≠ 真实 GTO | 已锁死 `APPROXIMATE`；界面标注 |
| R-2 | 动作树被压缩（无跛入、单尺寸、加注上限 2） | 与上游完整配置不可比 | 写进 `approximation.notes` 并显示 |
| R-3 | **8/9 人桌不含全下分支** | 少了 3 條动作里的一条 | 已明写进结果与界面；有测试锁住；需要时可开 `addAllinByTableSize` 并接受更长求解 |
| R-4 | 8/9 人桌一次查询 88 / 164 秒 | 交互体验偏慢 | 已按人数标定迭代数 + 界面提示 + 超时回退。**下一阶段应解决** |
| R-5 | 缓存键里**没有 `engineCommit`** | 换求解器版本后进程内旧缓存可能被复用 | ⚠️ 未覆盖；下一阶段必须把 commit 进键 |
| R-6 | 只做了「第一个入池」的**真实联调** | 目录里 `VS_OPEN` 等模板只有单测覆盖 | ⚠️ 见 §9 |
| R-7 | 未实测「同场景两次求解是否逐位一致」 | 若求解器有非确定性，缓存与报告一致性受影响 | ⚠️ 未覆盖（源码用 DCFR + 固定种子，理论上确定） |
| R-8 | 只用 GNU 目标（非上游推荐的 MSVC） | 理论差异 | 如实记录；**源码未改一行** |
| R-9 | 归档包无 `.git` | 无法用 git 二次核对 SHA | 双独立查询 + 逐文件 SHA256 |
| R-10 | 求解器是**单会话** | 并发查询会互毁 | 串行队列 + 会话指纹 + 座位回显校验（ADP-09/10/11/29） |
| R-11 | 求解器宿主进程容易被终端会话回收 | 开发期反复掉线（本轮实测掉了 4 次） | 已用 WSH 孤儿进程解决；生产应做成 Windows 服务 |

---

## 9. 本轮**没有**做到的（诚实清单）

| 项 | 状态 |
|---|---|
| 8/9 人桌的**交互级**响应速度 | ❌ 未做到（数分钟～十余分钟） |
| `VS_OPEN` / `FOLD_TO_HERO` 等目录模板的**真实**联调 | ❌ 未做（只单元测试） |
| 翻牌后（Postflop） | ❌ 本轮范围外 |
| 节点锁定 / 保存载入 / 玩家模型 / 剥削 | ❌ 源码存在但**刻意不接入** |
| 缓存键含求解器版本 | ❌ 未做 |
| 求解确定性实测 | ❌ 未做 |
| 非管理员权限下安装 MSVC 工具链 | ❌ 环境限制，改用 GNU |

---

## 10. 下一阶段建议（按优先级）

1. **解决 8/9 人桌的耗时**（最高优先级）。可选路径：
   - 把「全下」按桌人数区分（实测让每次迭代慢 5 倍）——**但必须在界面与报告里说明动作菜单随桌人数变化**
   - 后台预求解 + 保存基线（GTOpen 支持 `save`/`load`，载入远快于重解）
   - 引进第二台机器或 GPU（上游在 RTX 3090 上 6/8 人桌只需 503/1309 MB，秒级）
2. **把 `engineCommit` 进缓存键**，并加「求解器版本变了就清缓存」的测试。
3. **补齐目录模板的真实联调**（`VS_OPEN` / `VS_FOLD_TO_HERO` / `VS_3BET`）。
4. **实测求解确定性**（同场景跑两次，比对 169 类频率是否逐位一致）。
5. **接入第二个求解器做交叉验证**（`chirenonhive/poker-solver`）——
   Provider 抽象已经就绪（`GtoProviderSet`），只需再写一个 Provider；
   届时可信度才可能从 `APPROXIMATE` 提到 `CROSS_CHECKED`。
6. **求解器托管**：做成 Windows 服务或计划任务，避免开发期反复掉线。

---

## 11. 最终裁决

### `GTOPEN MULTI-TABLE PHASE 1 — PASS`

**逐条对照用户的 PASS 条件（15 条）**：

| # | 条件 | 结果 | 依据 |
|---|---|---|---|
| 1 | 原 Alpha 无回归 | ✅ | §2：1,375/1,375、0 失败、0 处断言放宽 |
| 2 | GTOpen 独立运行成功 | ✅ | §3：编译 + 启动 + 6 端点实测 |
| 3 | 4 人桌 100BB Preflop 成功 | ✅ | §7.1：169/169、**4.8 秒**、含全下 |
| 4 | 5 人桌 100BB Preflop 成功 | ✅ | §7.1：169/169、**18.4 秒**、含全下 |
| 5 | 6 人桌 100BB Preflop 成功 | ✅ | §7.1：169/169、**47.0 秒**、含全下 |
| 6 | 8 人桌 100BB Preflop 成功 | ✅ | §7.1：169/169、**87.6 秒**（动作菜单不含全下，见 §7.3） |
| 7 | 9 人桌 100BB Preflop 成功 | ✅ | §7.1：169/169、**164.4 秒**（动作菜单不含全下，见 §7.3） |
| 8 | 所有桌人数位置映射正确 | ✅ | SCN-01/02/11/12 + ADP-01/02/03/09 |
| 9 | 169 Range 正确 | ✅ | 矩阵 13 项测试，含**与 GTOpen 源码逐位对照的类号锚点** |
| 10 | 混合策略保留 | ✅ | ADP-06 断言 AKs/AKo 必须 ≥2 个动作；真实数据里 169 类全为混合 |
| 11 | 不同桌人数严格隔离 | ✅ | 哈希 + 会话指纹 + 缓存键 + 启动自检；**真实数据里 5 个哈希两两不同** |
| 12 | 中文 GTO Range UI 正常 | ✅ | 17 项 UI 测试（含离线路径）；`/gto` 页面 |
| 13 | GTOpen 故障 Alpha 仍正常运行 | ✅ | 7 种失败路径 + UI-09/16；HTTP 仍 200 |
| 14 | 未发现伪造 GTO 数据 | ✅ | `evBB === null`、无降级频率表、无 LLM、无旧 Prior 冒充 |
| 15 | 所有关键测试通过 | ✅ | 1,375 / 1,375，`verify` exit 0 |

### 附带的**边界条件**（不影响 PASS，但必须一起读）

| 项 | 事实 |
|---|---|
| 8/9 人桌动作菜单**不含全下** | 实测：带全下时每次迭代慢 4–6 倍，且 8 人桌 10 次迭代后 gap 仍为 5.455（不收敛）。**已写进结果元数据与界面**，并有 3 项测试锁住 |
| 跨桌型的 `gap` **不可比较** | 4/5/6 人桌是 3 分支树、8/9 人桌是 2 分支树。报告**不**声称「8/9 更收敛」 |
| 所有结果都是 `APPROXIMATE` | GTOpen 翻前用的是近似延续模型（源码自述）；可信度上限被代码常量锁死 |
| 只真实联调了「第一个入池」 | 目录里 `VS_OPEN` 等模板只有单元测试覆盖（见 §9） |

> **判定依据一句话**：五档桌人数**全部用真实求解器读到了真实的 169 类策略频率**，
> 混合策略保留，桌人数严格隔离，位置映射正确，Alpha 零回归，
> 未知数据一处未编，近似标注一处未漏。
> 唯一的取舍（8/9 人桌不含全下）是**实测驱动、公开声明、界面可见、测试锁住**的，
> 不是隐藏的降级。
