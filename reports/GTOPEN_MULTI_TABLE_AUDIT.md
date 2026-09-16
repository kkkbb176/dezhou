# GTOpen 能力审计（多桌人数 · 翻前）

> 本报告的目标只有一个：**说清楚 GTOpen 到底能做什么、不能做什么**，
> 以及我们**凭什么**这么判断。
>
> 🔴 **纪律：不得根据 README 直接标 IMPLEMENTED。**
> 下表里每一个判定都必须在「源码」或「实际运行」两列里有对应证据。
> 没有证据的项目一律标 `UNVERIFIED`，而不是「大概是吧」。

---

## 0. 结论摘要（先读这一段）

| 问题 | 答案 |
|---|---|
| GTOpen 能算多人（2–9）翻前吗？ | **能，但是近似的**。它求解的是一个「延续收益模型」下的动作树，不是完整的翻牌后博弈 |
| 4 / 5 / 6 / 8 / 9 人桌都能跑吗？ | **能**（实测逐档跑过，见 §4） |
| 位置名有语义吗？ | **没有**。`positions` 只是标签，求解器只用**数组顺序**。角色由「顺序 + `posts`」决定 |
| 169 类手牌怎么取？ | `strategy[a * 169 + classIndex]`，类号公式见 §3（**与直觉相反**，务必按源码算） |
| 混合策略保留吗？ | **保留**。每个动作每个类一个频率 |
| 有 EV 吗？ | **翻前节点接口不给逐动作 EV**。全局有一组每座位的 `evs`（bb/hand），但那是**每座位一个数**，不是逐手牌 EV |
| 能算 Equity 吗？ | **不能直接查**。有内部权益表（`EquityTable`）用于求解，但没有「给我 AKo vs XX 的权益」这个接口 |
| 节点锁定（Node Lock）？ | **有**（`/api/preflop/lock`、`/api/preflop/table`、`/api/preflop/hero`）；本轮**未验证** |
| 保存 / 载入？ | **有**（`/api/preflop/save` / `load` / `saves`）；本轮**未验证** |
| 玩家模型 / 剥削？ | **有**（`generate` 从统计生成画像、`table` 冻结座位、`hero` 最优反应）；本轮**未验证**，且**明确不接入**（见 §6） |

---

## 1. 来源与可复现性（provenance）

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/MatthewPDingle/GTOpen` |
| 默认分支 | `master` |
| commit SHA | `92c86ed73aa0856df8479b5c7635e1469f48f1e8`（2026-09-11T03:06:25Z，"Complete four-hour preflop research and verify session-preserving deployment"） |
| **如何核对的 SHA** | ① `git ls-remote --symref … HEAD` → `refs/heads/master` = `92c86ed…`；② `GET https://api.github.com/repos/MatthewPDingle/GTOpen/commits/master` → `sha` = `92c86ed…`（两条**互相独立**的途径一致） |
| 获取方式 | 直连 `git clone` **失败**（`RPC failed; curl 18 transfer closed`，本机网络对 GitHub 的大包传输不稳定），改用 GitHub 归档压缩包：`https://codeload.github.com/MatthewPDingle/GTOpen/zip/refs/heads/master`（97.04 MB，35 秒） |
| ⚠️ 归档包没有 `.git` | 因此**无法**用 `git log` 二次核对。SHA 的可信度来自上面两条独立查询 + 下面逐个文件的 hash |
| 落地位置 | `德州/GTOopen/GTOpen/`（**不在** `src/` 下，与 Alpha 完全分离） |
| 源码快照规模 | 3,116 个文件 / 163.73 MB |

### 1.1 关键源文件的 SHA256（供独立复核）

| 文件 | SHA256 |
|---|---|
| `crates/solver/src/preflop/mod.rs` | `BE47A6C8E6187774B903FA5EBAF529584ED43F7862B17E51A4193BF78E4ED2FA` |
| `crates/solver/src/preflop/equity.rs` | `45CAF75D3D7DBF0A123ED602B5697381AC2AC3420223C25136191571DA2ACC3A` |
| `crates/server/src/main.rs` | `9DB1A10CC5E483C4E2951C6930162DD85B7D8172EB12CC29D1CD52665403256B` |
| `crates/solver/Cargo.toml` | `601F063C10FCC3B7179EFA7B55DDCF80C91AD4640E2F7470254E4A23FB7DC7F9` |
| `crates/server/Cargo.toml` | `39AB6768D3CF4F1B23D9F4A31EFC53029182DED3CF25D70F6D291936B3A89D3B` |
| `Cargo.lock` | `03C5654D741233C00F843BFED4146BC264CCCEDA5827944C2F585224C106C710` |
| `Cargo.toml`（workspace） | `7C4852F25AFCA57450C13DE5AB336C28BA70D9405C16CFC1BBCCEE361D10C0CA` |
| 归档包本身 | `D:\德州\GTOopen\gtopen-master.zip`（保留在本机，可重新解压比对） |

### 1.2 构建环境（**必须如实记录：这不是上游验证过的构建方式**）

| 项 | 值 |
|---|---|
| Rust | `rustc 1.98.1 (48a229cea 2026-09-01)` / `cargo 1.98.1 (797e8a9bc 2026-08-05)` |
| 目标平台 | `x86_64-pc-windows-gnu`（**不是**上游 README 推荐的 MSVC） |
| 链接器 | MinGW-w64 GCC 16.1.0（Brecht Sanders winlibs，`x86_64-msvcrt-posix-seh`），位于 `C:\Users\71061\.local\mingw64` |
| 为什么不用 MSVC | 本机**没有**安装 Visual Studio 的 C++ 生成工具（`link.exe` 不存在；`vswhere -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64` 无输出），且 `winget install --scope user` 需要管理员权限（本会话没有，审批也已禁用） |
| 构建命令 | `cargo build --release -p server`（CPU，**不带** `--features gpu`） |
| 构建耗时 | 5 分 23 秒（首次含依赖编译）；产物 `gto-server.exe` 6,387,466 字节 |
| 产物路径 | `D:\gtopen-build\target\x86_64-pc-windows-gnu\release\gto-server.exe` |
| 🔴 为什么产物在 `D:\gtopen-build` | **路径含中文会让 MinGW 的 `dlltool` 无法创建导入库**（实测报错 `dlltool.exe: Can't create .lib file: D:\????\…` → `windows-sys` 编译失败）。这是 MinGW 工具链的编码问题、不是 GTOpen 的缺陷，MSVC 构建不受影响。因此用 `target-dir` 把产物放到纯 ASCII 路径（配置见 `GTOopen/GTOpen/.cargo/config.toml`） |
| crates.io 来源 | 中科大镜像（`sparse+https://mirrors.ustc.edu.cn/crates.io-index/`）。直连 `static.crates.io` 实测约 3 MB / 17 分钟，完整依赖树要数小时。`Cargo.lock` 的版本与校验和仍然生效 |
| 上游源码是否被修改 | **没有**。唯一的改动是新增 `.cargo/config.toml`（本机构建配置）与 `GTOopen/start-gtopen.ps1`（启动脚本），两者都在 `GTOpen/` **之外**或 `.cargo/` 下，不触碰任何 `.rs` 文件 |
| 编译告警 | 2 条 dead-code 告警（`PfSolveRequest.early_preview` 字段与 `pf_preview_due` 函数在 CPU 构建下未使用）。**未修改** |

### 1.3 运行方式（实测）

```powershell
# 启动（前台；实际使用中作为后台任务运行）
cd D:\德州\GTOopen
.\start-gtopen.ps1            # 默认端口 3737

# 等价的直接命令（脚本内部就是这一条）
$env:PORT=3737; $env:PREFLOP_MAX_ARENA_MB=1600; $env:PREFLOP_MAX_NODES=1200000
$env:RAYON_NUM_THREADS=8; $env:SOLVER_GPU=0
cd D:\德州\GTOopen\GTOpen
& D:\gtopen-build\target\x86_64-pc-windows-gnu\release\gto-server.exe
```

| 项 | 值 |
|---|---|
| 端口 | **3737**（`PORT` 环境变量可改；上游默认也是 3737） |
| 工作目录 | 必须是仓库根 `GTOopen/GTOpen`（它要读 `web/` 与 `cache/`） |
| 内存上限 | `PREFLOP_MAX_ARENA_MB=1600`（本机 16 GB 内存、空闲约 4.8 GB；上游默认取空闲内存 40%，会随其他程序波动，固定住它才能让「能不能建树」成为可复现的事实） |
| 节点上限 | `PREFLOP_MAX_NODES=1200000` |
| 线程 | `RAYON_NUM_THREADS=8`（8 逻辑核） |
| GPU | `SOLVER_GPU=0`，且**编译时就没有 `gpu` feature** → 强制 CPU |
| 启动成功的证据 | `GET /` → 200（返回 GTOpen 网页）；`GET /api/preflop/status` → 200（空会话的默认状态）；`GET /api/preflop/capabilities` → 200 `{"early_preview_v1":true,"fresh_build_multiway_models":["coupled_deck_v1"],"model_evidence_sizing":true,"raise_multiples":true}` |

---

## 2. HTTP API 实测（只列本项目真正用到的）

| 方法 | 路径 | 用途 | 实测状态 | 关键行为 |
|---|---|---|---|---|
| GET | `/api/preflop/status` | 求解进度 | 200 | 无会话时返回**空 state**（不是 404）—— 因此它是合适的健康探针 |
| GET | `/api/preflop/capabilities` | 能力自述 | 200 | **只有 4 个布尔/数组字段**，不包含人数、模型近似性等信息 |
| GET | `/api/preflop/session` | 当前会话配置 | 200 / 400 | 无会话时 **400** |
| POST | `/api/preflop/estimate` | 树规模预检（不触碰会话） | 200 | 返回 `nodes` / `action_nodes` / `arena_mb` / `truncated` / `ok` / `limit_nodes` / `limit_arena_mb` |
| POST | `/api/preflop/spot` | 建树（**替换**当前会话） | 200 | 会先 stop 并 join 正在跑的求解；返回 `nodes` / `action_nodes` / `arena_mb` / `multiway_equity_model` |
| POST | `/api/preflop/solve` | 开始求解 | 200 / 409 | **异步**：立即返回 `{"ok":true}`，后台线程推进；已有求解在跑时 **409** |
| POST | `/api/preflop/node` | 读某节点策略 | 200 | 节点字段在**顶层**（无 `result` 包装）；另带一个 `publication` 对象 |
| POST | `/api/preflop/stop` | 停止求解 | 未使用 | — |
| POST | `/api/preflop/save` / `load` | 保存 / 载入 | **未验证** | 上游声称有 |
| POST | `/api/preflop/lock` / `unlock` / `table` / `hero` | 节点锁定 / 固定座位 / 最优反应 | **未验证** | 上游声称有 |
| POST | `/api/preflop/generate` | 由统计生成玩家画像 | **未验证** | 上游声称有 |

### 2.1 `/api/preflop/node` 的真实响应（实测抓取，逐字）

```json
{
  "model_evidence": {"kind":"solver","label":"Solver","summary":"…","details":[]},
  "strategy_note": null,
  "kind": "action",
  "actor": 0,
  "actor_pos": "CO",
  "positions": ["CO","BTN","SB","BB"],
  "pot": 1.5,
  "invested": [0,0,0,0],
  "live": [true,true,true,true],
  "actions": [
    {"label":"Fold","kind":"fold","to":0,"freq":0.74520296},
    {"label":"Limp 1","kind":"call","to":1,"freq":0.034903046},
    {"label":"Raise 2.5","kind":"raise","to":2.5,"freq":0.219894}
  ],
  "strategy": [ /* 动作数 × 169，动作优先展平 */ ],
  "reach": [ /* 169，每类还剩多少比例 */ ],
  "exportable": false,
  "history": [ { "strategy_note": null, "kind":"action", "actor_pos":"CO", "pot":1.5,
                 "actions":[…], "chosen": null } ],
  "reaches_all": [ … ],
  "publication": {"multiway_model":"coupled_deck_v1","published_iteration":50,
                  "accuracy_iteration":30,"gap_total":0.005080984726535332,
                  "target_gap":0,"converged":false}
}
```

⚠️ **两个与直觉不符、且已经踩过的点**（记录在案，避免下次重犯）：

1. **没有 `result` 包装**。节点字段直接在顶层。我们最初的解析器写成 `payload.result.*`，第一次联调就失败。
2. **`publication` 与 `/api/preflop/status` 字段名不同**：
   `publication.multiway_model` vs `status.multiway_equity_model`；
   `publication.published_iteration` vs `status.iteration`。
   两者都在 `gtopenProvider.ts` 里被归一化成同一个 `EngineStatus` 结构。

---

## 3. 169 类手牌的**权威**取数方式（源码核对）

`crates/solver/src/preflop/equity.rs` 第 15–44 行：

```rust
const RANK_CHARS: [char; 13] = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];

/// Class index for ranks `a >= b` (0..13, 12 = A): pair `a*13+a`,
/// suited `a*13+b`, offsuit `b*13+a`.
pub fn class_index(a: u8, b: u8, suited: bool) -> usize {
    let (hi, lo) = if a >= b { (a, b) } else { (b, a) };
    if hi == lo { (hi as usize) * 13 + hi as usize }
    else if suited { (hi as usize) * 13 + lo as usize }
    else { (lo as usize) * 13 + hi as usize }
}
```

### 3.1 三个必须记住的结论

1. **点数下标是从小到大**（0 = `2`，12 = `A`）。而界面上习惯的 13×13 轴是**从大到小**（0 = `A`）。两者**相反**。
   本项目在 `src/domain/gto/gtopenHandMatrix.ts` 里把两者都显式命名，
   并用**逐项构造的换算表**连接（而不是一条闭式公式 —— 闭式一旦方向写反，
   AKs 与 AKo 会静默互换，而名字看起来都对）。
2. **同花在类号矩阵的下三角（`r > c`）**，不同花在上三角 —— 与标准范围图的视觉约定**正好相反**。
3. 对子在主对角线。**`AA` = 类号 168（最大），`22` = 类号 0（最小）。**
   「类号大 = 牌强」是**巧合**（因为高牌的下标也大），代码不得依赖这个相关性。

### 3.2 锚点（已写成测试 `test/gtoHandMatrix.test.ts` 的 GTO-169-07）

| 手牌 | 类号 | 手牌 | 类号 |
|---|---|---|---|
| `AA` | 168 | `22` | 0 |
| `AKs` | 167 | `AKo` | 155 |
| `A5s` | 159 | `A5o` | 51 |
| `32s` | 13 | `32o` | 1 |
| `72o` | 5 | | |

⚠️ 上游 `AGENTS.md` 写的是「index `= hi*13+lo` for suited, `lo*13+hi` for offsuit, and `rank*14` for pairs」——
**对子的那一句与源码不符**（源码是 `hi*13+hi`，不是 `rank*14`）。
以源码为准。这也正是本报告开头那条纪律（不得只信文档）的一个真实例子。

---

## 4. 多桌人数能力（实测，逐档）

### 4.1 树规模（`POST /api/preflop/estimate`，本机实测）

配置：`stack=100`、`posts=[0,…,0,0.5,1.0]`、`open_raises=[2.5]`、`raise_mults=[3]`、`max_raises=2`

| 人数 | 允许跛入 | 提供全下 | 节点数 | 动作节点 | arena |
|---|---|---|---|---|---|
| 4 | 否 | 否 | 118 | — | 0.3 MB |
| 4 | 否 | 是 | 232 | 103 | 0.31 MB |
| 5 | 否 | 是 | ~900 | 364 | 1.06 MB |
| 6 | 否 | 否 | 1,272 | — | 1.7 MB |
| 6 | 否 | 是 | 2,538 | — | 3.4 MB |
| 8 | 否 | 是 | ~25,000 | — | — |
| 9 | 否 | 否 | 37,839 | 18,668 | 51.2 MB |
| 9 | 否 | **是** | **75,669** | — | **102.3 MB** |
| 9 | **是** | 否 | **913,096** | 447,090 | **1234.5 MB** |
| 6 | **是** | 否 | 11,566 | 5,466 | 15.6 MB |

### 4.2 单次迭代耗时（实测，10 次迭代的墙钟时间 ÷ 10）

| 人数 | 配置 | 毫秒/迭代 |
|---|---|---|
| 4 | limp=F allin=F | 46 |
| 5 | limp=F allin=F | 133 |
| 6 | limp=F allin=F | 488 |
| 8 | limp=F allin=F | 5,074 |
| 9 | limp=F allin=F | 17,264 |

### 4.2.1 五档桌人数的**真实一次查询耗时**（实测，干净重启的求解器）

| 桌人数 | 动作菜单 | 迭代数 | 一次查询耗时 | BR gap 之和 |
|---|---|---:|---:|---:|
| 4 | Fold · Raise 2.5 · All-in 100 | 60 | **4.8 s** | 0.03412694 |
| 5 | Fold · Raise 2.5 · All-in 100 | 60 | **18.4 s** | 0.08084305 |
| 6 | Fold · Raise 2.5 · All-in 100 | 40 | **47.0 s** | 0.16526006 |
| 8 | Fold · Raise 2.5 | 20 | **87.6 s** | 0.00417911 |
| 9 | Fold · Raise 2.5 | 12 | **164.4 s** | 0.02102956 |

⚠️ 跨桌型的 gap **不可直接比较**：4/5/6 人桌是 3 分支树（含全下），
8/9 人桌是 2 分支树。不同的树 ⇒ gap 定义不同。

### 4.3 本轮选定的预算与**代价**（明确声明，不隐藏）

| 取舍 | 内容 | 代价 |
|---|---|---|
| 关闭跛入 | `limp: false` | 动作菜单没有**跛入/补盲**分支。打开它会让 9 人桌的树从 7.6 万节点变成 91.3 万节点（**12 倍**），单次迭代从秒级变成 17 秒级 |
| 单个尺寸 | `open_raises=[2.5]`、`raise_mults=[3]` | 没有「同样加注但尺寸不同」的分支。上游参考配置用 2 个开池尺寸 + 3 个加倍倍数，在 6 人桌上就要 2119 MB（且那是有 CUDA 的机器） |
| 加注上限 2 | `max_raises=2`（开池 + 3Bet） | 没有 4Bet / 5Bet 分支 |
| 按人数缩减迭代 | 4/5 人桌 60 次、6 人桌 40 次、8 人桌 20 次、9 人桌 12 次 | 人越多离均衡越远。**这一点会进结果的 `approximation.notes` 并显示在界面上** |
| 无抽水 | `rake_pct=0` | 与 Alpha 自身的口径一致（本项目没有 Rake Engine） |

### 4.4 翻前模型是**近似**的（这一条决定了一切标注）

`crates/solver/src/preflop/mod.rs` 文件头（逐字引用）：

> Solves the configured 2..9-player action tree with **modeled continuation
> payoffs, not a full postflop game**. New 3+ player leaves use a fixed
> **coupled deck rank approximation** that divides one pot, net of rake.
> … The 169-class chance model **ignores joint card removal**. Coupled ranks
> improve broad-range equity but can still err substantially for overlapping
> narrow ranges. Multiway continuation is **showdown value, not learned
> postflop EV**. DCFR reports each seat's best-response gap against these
> model payoffs; a small gap **is not evidence of an accurate poker model or
> a Nash equilibrium**.

由此得到的**硬结论**（贯穿本项目全部 GTO 标注）：

> 即使求解器自述 `converged: true`，它收敛的也是**那个近似模型内部的均衡**，
> 不是真实扑克的均衡。因此翻前结果的可信度**上限是 `APPROXIMATE`**，
> 永远到不了 `SOLVED` / `CROSS_CHECKED` / `VERIFIED`。

这一条在代码里由 `GTOPEN_PREFLOP_MAX_VERIFICATION = 'APPROXIMATE'` 实现，
并由 `GTOPEN_CAPABILITY_TABLE.preflopApproximateModel = true` + 测试锁死。

---

## 5. 能力矩阵（逐项判定 + 证据）

**判定口径**

| 标记 | 含义 |
|---|---|
| `IMPLEMENTED` | 源码里有完整实现，且**本项目运行验证过** |
| `PARTIAL` | 只有一部分（例如只支持某些人数、某些动作） |
| `APPROXIMATE` | 有结果，但结果本身建立在建模/近似之上 |
| `MISSING` | 源码里没有 |
| `BROKEN` | 有实现，但实测不работ（本轮**没有**发现 BROKEN 项） |
| `UNVERIFIED` | 源码里有，但**本轮没有运行验证**（不得当成 IMPLEMENTED） |

| 能力 | 判定 | 证据 |
|---|---|---|
| 2–9 人 Preflop 求解 | `IMPLEMENTED` | 源码 `validate()` 校验 `2..=9`；实测 4/5/6/8/9 全部建成树并求解成功 |
| Stack（有效筹码） | `IMPLEMENTED` | `PreflopConfig.stack`；实测 `stack: 100` 生效，`validate()` 拒绝 `stack <= 最大盲注` |
| Blinds（盲注） | `IMPLEMENTED` | `PreflopConfig.posts`（**按座位对齐**）+ `ante`；实测 `posts=[0,…,0.5,1.0]` → 根节点 pot = 1.5 |
| Raise sizes（加注尺寸） | `IMPLEMENTED` | `open_raises`（首次加注「到多少」）+ `raise_mults`（再加注倍数）；实测菜单出现 `Raise 2.5` 与 `3-bet 7.5` |
| Limp（跛入） | `IMPLEMENTED` | `limp: true` 时菜单出现 `Limp 1`（kind = `call`，`to` = 1）；实测已抓到该菜单。**本轮生产配置关闭它**（树规模原因） |
| Multiway（多人池） | `PARTIAL` + `APPROXIMATE` | 树支持最多 9 名玩家；但 3 人以上的延续用 `coupled_deck_v1`（1024 个确定性潜在强度样本），源码自述「不是共享的物理发牌」，重叠窄范围仍有较大去牌误差 |
| 169 hand classes | `IMPLEMENTED` | `NUM_CLASSES = 169`；实测 `strategy.length == 动作数 × 169`，`reach.length == 169`；类号公式见 §3 并已写成锚点测试 |
| Strategy frequency（混合策略） | `IMPLEMENTED` | 每个动作每个类一个 f32；实测 AA = `Raise 98.0% / All-in 2.0%`、BB 面对开池 AKo = `3-bet 78.0% / All-in 21.6% / Call 0.4%` |
| Player models（玩家画像） | `UNVERIFIED` | 源码有 `generate_profile()` 与 `/api/preflop/generate`；本轮**没有**调用验证，且**明确不接入**（见 §6） |
| Exploit（最优反应 / 剥削） | `UNVERIFIED` | 源码有 `set_hero()` / `set_table()` 与 `/api/preflop/hero`、`/api/preflop/table`；本轮未验证、不接入 |
| HU Postflop（单挑翻牌后） | `UNVERIFIED`（本轮范围外） | 源码有完整实现（`crates/solver/src/cfr.rs` 等，上游称「Postflop is heads-up only」）；本轮**不涉及** |
| EV | `PARTIAL` | `/api/preflop/status` 给**每个座位**一个 `evs[i]`（bb/hand）；`/api/preflop/node` **不给逐动作、逐手牌的 EV**。本项目因此把 `GtoActionFrequency.evBB` 一律设为 `null`（**不编**） |
| Equity | `MISSING`（作为可查询能力） | 内部有 `EquityTable`（169×169 两两权益，蒙特卡洛 + 磁盘缓存 `cache/preflop_eq169.bin`）供求解使用，但**没有**「查询某两手牌权益」的 HTTP 端点。本项目不提供 GTO 权益——Alpha 自己的权益引擎继续负责这一项 |
| Node Lock（节点锁定） | `UNVERIFIED` | 源码有 `lock_point()` / `unlock_point()` 与 `/api/preflop/lock`、`/api/preflop/table`、`/api/preflop/hero`；本轮未验证、不接入 |
| Save / Load | `UNVERIFIED` | 源码有 `/api/preflop/save` / `load` / `saves` 与 `preflop/save.rs`；本轮未验证 |
| 收敛判据 | `IMPLEMENTED`（但语义有限） | `status.gap_total` = 各座位 best-response gap 之和；`stop_reason` 取值含 `iteration_limit` / `target_gap` / `stopped`。⚠️ 源码自述「gap 小**不是**模型准确或纳什均衡的证据」 |
| 版本信息 | `MISSING` | **没有任何版本或 commit 端点**。`/api/preflop/capabilities` 只返回 4 个能力布尔值。因此 `sourceVersion` 恒为 `null`，`engineCommit` 由本项目**手工记录**（`GTOPEN_ENGINE_COMMIT` 常量） |
| 单会话限制 | `IMPLEMENTED`（且是限制） | `/api/preflop/spot` 会 stop 并 join 后**替换**当前 session（源码 `pf_build`）。→ 同一时刻只有一个翻前会话，**并发查询会互相破坏**。本项目用串行队列 + 座位回显校验应对 |

---

## 6. 本轮**刻意不接入**的能力（附理由）

| 能力 | 为什么不接入 |
|---|---|
| Player models / Exploit | 本轮的产品目标是「理论 GTO Baseline」。把玩家模型一起接进来，会让「这条频率是理论的还是针对某个对手的」变得无法回答 —— 而那正是本轮第九阶段明令禁止的（真人信息不得污染理论基线） |
| Node Lock / Hero | 同上：锁定后的结果**不再是 GTO 基线**，而是「在某个约束下的最优反应」。它有价值，但要在**明确标注之后**才允许接入 |
| HU Postflop | 本轮范围外（用户明确要求「暂时不要大规模做 Postflop」） |
| Save / Load | 值得做（保存已求解的基线比重新求解快得多），但本轮先证明「能稳定读到真实数据」 |
| CUDA / GPU | 本机没有 NVIDIA GPU；CPU 优先是本轮明确要求 |
| 玩家模型的 `Evidence` 标签 | 只在 `node.model_evidence` 里出现；本项目保留了它但不做解释（界面显示求解器自述） |

---

## 7. 已知风险（与能力同等重要）

| # | 风险 | 后果 | 本项目的应对 |
|---|---|---|---|
| R-1 | 翻前是近似模型 | 频率**不等于**真实 GTO | 可信度上限锁死为 `APPROXIMATE`；界面显示「近似求解」+ 逐条说明；**永不**标 `SOLVED`/`VERIFIED` |
| R-2 | 树被压缩（无跛入、单尺寸、加注上限 2） | 与上游参考配置的频率不可直接比较 | 进 `approximation.notes` 并在界面显示 |
| R-3 | 迭代数少（9 人桌仅 12 次） | 离均衡很远 | 结果**必然**带 `notConverged: true` + 实际迭代数 + `gap_total` |
| R-4 | 单会话 | 并发查询会互相破坏 | Provider 内串行队列；读到结果后核对**座位回显**；不一致即判 `INVALID_RESPONSE` |
| R-5 | 没有版本端点 | 无法在运行时确认跑的是哪个 commit | 手工常量 `GTOPEN_ENGINE_COMMIT` + 报告记录文件 hash |
| R-6 | 用 GNU 目标而非上游推荐的 MSVC 构建 | 理论上可能与上游行为有差异 | 如实记录；**未修改任何源码**；功能实测正常 |
| R-7 | 归档包（无 `.git`） | 无法用 git 二次核对 SHA | 两条独立查询 + 逐文件 SHA256 |
| R-8 | `agents`/`README` 与源码在个别细节上不一致（如对子类号 `rank*14`） | 按文档写会算错 | **以源码为准**；写成锚点测试 |
| R-9 | 纯 CPU 的求解耗时随人数快速增长 | 9 人桌一次查询要 1–3 分钟 | 明确的等待上限 + 超时即回退（**不使用半途策略**）；界面提示可能需要 1–3 分钟 |
| R-10 | 9 人桌的 arena 需要 ~102 MB（带全下）；若再加跛入会到 1234 MB | 打开跛入可能触到内存上限 | 保持 `limp: false`；`estimate` 预检在**建树之前**就拦截超限配置 |

---

## 8. 判定

| 项 | 结论 |
|---|---|
| GTOpen 独立运行 | **PASS**（实测启动、6 个端点响应符合预期、5 个桌人数全部建成树并求解成功） |
| 2–9 人翻前能力 | `IMPLEMENTED`（1 项能力） + `APPROXIMATE`（结果语义） |
| 169 类与混合策略 | `IMPLEMENTED` |
| EV / Equity | `PARTIAL`（只有每座位的总 EV）/ `MISSING`（无可查询权益接口） |
| 玩家模型 / 剥削 / Node Lock / Save-Load | `UNVERIFIED`（源码存在，本轮未验证，且**刻意不接入**） |
| Postflop | 本轮范围外 |

> **一句话**：GTOpen 是一个**能用的多人翻前近似求解器**，
> 它的价值在于「给出一个可复现、有明确来源与模型声明的理论基线」，
> 而**不是**「给出真实 GTO」。本项目全程按这个定位使用它。
