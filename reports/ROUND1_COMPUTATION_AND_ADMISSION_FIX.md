# 第一轮「计算正确性与数据准入修复」报告

- 范围：翻前加注 EV 资金流 · 求解器缓存准入 · 玩家记录误记风险 · 画像验收规范修正
- 仓库：`D:\德州`，分支 `feature/preflop-raise-audit`
- 本轮改动**全部未提交、未推送**；并行 worktree `D:\德州-worktrees\opportunity-model-v1` 未触碰
- 全量验证：`npm run verify` **exit 0** —— **2,247 项 / 137 套件 / 0 失败**，183 个产物与清单一致

---

## 管理摘要

四件事里，**三件查清了、一件必须承认查错了方向**。

**一、翻前加注 EV 资金流。** 我一开始判定生产公式算错，并"修"了它 —— **那个判断是错的**。用引擎分层台账 `computeLayeredPot` 对 54 个尺寸逐位裁定后：生产代码（暂存区那版）**54/54 全对**，我的"修复"反而引入新错（漏掉死钱，每个尺寸少 150）。已把"修复"撤销，并**新发现**：暂存区里真正错的是**另一个**公式（`contextBuilder.ts` 的翻后加注路径：把"他跟注要补的差价"当成"他投入的量"），它已按同一口径改正。真正的交付物是一张**真实节点的修复前后对照表**（34 个节点 / 251 个对照点）与一份**不再与生产共享公式**的回归锁 —— 原先那条测试断言的正是错误公式，所以"测试全绿"与"公式错误"同时成立过。

**二、求解器缓存准入。** 缺陷真实存在且已修：缓存里躺着三条**没收敛**的快照，其中 `c067cd8cb`（6MAX/1000000BB）的 BR gap 是 **129.1475** 而目标只有 **0.2**，`notConverged = true`，此前会被当成求解器结论**直接换掉对手的 169 类权重**（权益、底价、Call EV、动作排名全跟着变），界面却仍显示"命中已缓存的 GTO 策略"。已加**准入闸**：拒绝未收敛的 3 条、放行已收敛的 15 条（18 个真实缓存条目逐条实测）。同时**否掉了**"给 `effectiveStackBB` 加上限"这个直觉方案 —— 筹码深度本来就进缓存键（实测 100/1000/1000000BB 三把键互不相同），漏洞是"大筹码那条自己没收敛"，不是"读错了别人的数据"。

**三、一个更上游的发现（比上面两条都严重）。** 追查准入闸的作用范围时发现：**生产环境里求解器范围根本一次都没被用上**。原因是 `enumerateOpponentScenarios` 把盲注动作 `POST_SB`/`POST_BB` 放进了前序历史，而 `RFI` 场景的语义不变量要求前序历史**必须为空** ⇒ 场景构造返回 `null` ⇒ 候选对手枚举为空。这解释了实测中"`fromSolver` 恒为 false"。这是"功能看起来正常、实际从未生效"的典型形态，已定性但**本轮未修**（涉及领域层语义判断，需要专门一轮）。

**四、玩家记录。** 就"误记到某个人"而言**没有发生过**：`data/player-history.jsonl` 在本副本**不存在**，玩家记录 0 条；两个数据文件**从未进入任何本地或已 fetch 的远端分支**。但同一条链路上有 **4 处 id 口径混用**（座位 id ↔ 持久 playerId），后果是**静默失效**：桌况链路的 `recordsUsed` 恒为 0 ⇒ 桌况永远"观察中"、调整永不生效。已修 3 处（实测 `recordsUsed` 0 → 6、`excluded.notPresent` 6 → 0），并加了 5 项回归锁。另有若干需要专门设计的缺陷（跨牌桌 playerId 复用、丢弃本手不回退记录、UNDO 全文件重写会丢并发追加、OFF 模式仍落盘）**已定性、列入未修**。

**结论边界**：本轮只证明上述缺陷得到修复或已定性。**不宣称**整个软件已经完善，**不宣称**已具备稳定盈利能力。修复后桌况调整**仍未生效**（因为上游枚举问题），求解器范围**仍未进入建议**（同上）。

---

## 一、翻前加注 EV 资金流

### 1.1 我在这一项上先错了：把正确公式当成缺陷

事故过程完整记录如下，因为它暴露的是**验证方法**的问题，不是一行代码的问题。

| 版本 | `heroContestedAdd` | `finalPot` | 100BB 加注到 1550 | 60BB 加注到 10000 | 引擎台账裁定 |
|---|---|---|---|---|---|
| 第一轮 | `min(heroAdd, villainAdd)` | `pot0 + 该值 + villainAdd` | 2600 | — | ❌ **54/54 全错** |
| **第二轮（保留）** | `min(heroAdd, 他本街总额 − 我本街已投)` | `pot0 + 该值 + villainAdd` | **3250** | **12150** | ✅ **54/54 全对** |
| 第三轮（我本轮误加，已撤销） | 同上 | `pot0 + 2 × min(双方本街总额)` | — | 12000 | ❌ 漏掉死钱 150 |

第一轮错在把"他跟注要补的**差价**"当成"他投入的**量**" —— 他从 900 补齐到 1550，与我匹配的是 650，差价恰好也是 650，所以 100BB 下只丢 650。

第二轮**是正确的**。我之所以一度认为它也错，是因为用了错的判据：拿 `computePot`（引擎**未退回**口径）当"可争夺底池"。引擎台账实测（60BB、加注到 10000）：

```text
computeLayeredPot ⇒ { contested: 12150, deadMoney: 150, returned: { seat_CO: 4000 } }
关系：computePot = main + returned        16150 = 12150 + 4000
```

`finalPot` 必须等于 **`main`**（12150），**不是** `computePot`（16150）。两者只在退回为 0 时相等。我第三轮的"修复"用 `2 × min(双方本街总额)` 得 12000，恰好漏掉死钱那 150 —— 而 150 正是盲注（`deadMoney: 150`）。

**判据（唯一可信）**：引擎分层台账 `computeLayeredPot(state)` 的 `main` / `contested` / `returned`，在**真的走完**「Hero 加注到 X → 对手 CALL」之后读取。

### 1.2 真实错误在哪里：翻后那条同源公式

暂存区里 `contextBuilder.ts`（**翻后**加注路径）写的是第一轮那条错公式：

```ts
const heroContestedAdd = Math.max(0, Math.min(heroAdd, villainAdd));
const finalPot = currentPot + heroContestedAdd + villainAdd;
```

它已按与 `preflopRaiseFacts.ts` **完全相同**的口径改正，并把"为什么不能改写成 `2 × contested`"（会漏死钱）写进注释，防止下一个像我一样的人再去"修"它。

### 1.3 修复前后逐位对照（34 个节点 / 251 个对照点）

「修复前」由**暂存区旧代码本体**跑出（解到 `old-tree/` 直接运行），不是重新实现 —— 所以差异全部来自那一行公式。完整表格见 `out/F-10-before-after.md`。

| 指标 | 值 |
|---|---|
| 节点数 | 34 / 35 |
| 节点 × 尺寸 对照点 | 251 |
| 终池发生变化的对照点 | **251** |
| RAISE EV 发生变化的对照点 | **119**（上升 0 / 下降 119） |
| 最大终池差 | **+650** 筹码 |
| 最大 EV 差 | **−214.73** 筹码（JJ 尺寸 1550） |
| 推荐尺寸发生变化的节点 | 29 / 34 |

**Δ 恒为 +650 不是抽样巧合，是恒等式**（本夹具 `heroAdd > villainAdd` 恒成立）：

```text
Δ = 新终池 − 旧终池
  = [pot0 + hc + villainAdd] − [pot0 + min(heroAdd, villainAdd) + villainAdd]
  = hc − villainAdd
  = (他本街总额 − 我本街已投) − (raiseTo − 他本街已投) = 900 − 250 = 650
```

它在**被封顶的分支上同样出现**（BTN 20BB 尺寸 10000：前 1100/3500 → 后 1750/4150），正说明旧公式在**每一个**尺寸上都低估终池。

**EV 为何净下降**（两个方向相反，实测净效应向下）：

| 通道 | 旧公式的偏差 | 对 RAISE EV 的方向 |
|---|---|---|
| 跟注分支收益 `EqVsCall × finalPot` | 终池被低估 650 | 推**低** |
| 他继续的价格 `price = villainAdd / finalPot` | 分母偏小 ⇒ 价格被高估（1550 尺寸：0.2500 vs 真实 0.2000）⇒ 他显得更紧 ⇒ 弃牌率被高估（同一输入下旧代码给"他弃 75%"，新代码给"他弃 50%"） | 推**高** |

净效应：119 个点全部下降、0 个上升；下降到 0 的点都是"他已经必弃/必跟满"的尺寸。

### 1.4 回归锁：为什么必须换判据

原先的测试断言**正是那条错误公式**（`heroContestedAdd === villainAdd`、`finalPot === currentPot + contested + villainAdd`），所以"测试全绿"与"公式错误"同时成立。新锁 `test/preflopRaiseCashflow.test.ts` 反过来：**期望值一律由引擎给出**，事实包只提供"要测哪个尺寸"。

| 编号 | 锁什么 |
|---|---|
| CASH-1 | 每个尺寸的 `finalPot` 必须等于引擎台账 `main`；退回必须等于 `returned`；`computePot === main + returned` |
| CASH-2 | 独立手算恒等式（不与生产共享公式） |
| CASH-3 | 第一轮错公式必须在每个尺寸上都不同且更小 |
| CASH-3b | 第三轮错公式（我那版）必须与正确值差一块可解释的量 |
| CASH-4 | 对手 20BB：被跟注量 1750、终池 `pot0 + 2×2000` |
| CASH-5 | 60BB 加注到 10000：终池必须是 **12150**（第一轮给 10650、第三轮给 12000，都被排除） |

覆盖 6 组筹码配置 × 9 个尺寸 = **54 个对照点**。

**过程中修正的夹具错误（我自己的，非产品缺陷）**：盲注座位的 `startingStack` 必须**含**盲注（`createGame` 会立刻 `postBlind`）。原夹具给 SB/BB 各 100BB，于是终局底池凭空多出 100。已改为 100.5 / 101 并写明理由。

---

## 二、求解器缓存准入

### 2.1 缺陷复现（真实缓存条目，不是构造）

`data/gto-cache/strategy/` 里 18 条，逐条读 `solveMeta`：

| cacheKey | 场景 | targetGap | brGapTotal | stopReason | notConverged | 质量 |
|---|---|---|---|---|---|---|
| `c067cd8cb` | 6MAX/1000000BB/UTG/RFI | 0.2 | **129.147510** | `""` | **true** | LOW_CONVERGENCE |
| `cb693226d` | 6MAX/1000BB/UTG/RFI | 0.2 | 1.007083 | `""` | true | LOW_CONVERGENCE |
| `c0b705399` | 6MAX/200BB/UTG/RFI | 0.2 | 0.252987 | `""` | true | LOW_CONVERGENCE |
| 其余 15 条 | 2.5 ~ 100BB | 0.05 ~ 0.2 | 全部 < 目标 | `target_gap` | false | LOW_CONVERGENCE |

`c067cd8cb` 的 gap 是目标的 **645 倍**，`solverState` 还是 `running`（快照取自求解**还没结束**时），而 `qualityZh` 自己就写着「频率是**未收敛快照**，不可当作均衡」。

**修复前**：`priorFromCachedBaseline` 只校验**结构**（节点可达 / 行动者身份 / 频率非空），**完全不看收敛** ⇒ 这份快照会被 `contextBuilder.buildBaseRange` 当作求解器结论采用。

### 2.2 为什么不能改用 `quality` 字段当闸门

本仓库三档质量等级（`LOW_CONVERGENCE` < `APPROXIMATE` < `USABLE`）里，**所有**已落盘条目都是 `LOW_CONVERGENCE`（缺稳定性证据会恒压到这一档），也都满足 `GTO_CACHE_MIN_QUALITY_TO_STORE`。用它当闸门**等于没有闸门**。因此判据直接看收敛事实本身。

### 2.3 修法：五条判据，冷求解与缓存**共用**同一个函数

`admitSolverBaseline(baseline)`（`solverRangePrior.ts`）：

| 编号 | 判据 | 拒绝时说明 |
|---|---|---|
| G1 | `approximation.notConverged !== true` | 求解器自己标了"未收敛" |
| G2 | `reportedGap` 与 `targetGap` 都必须是**有限正数** | 没测过 / 没设目标 ⇒ **质量未知，不等于质量合格** |
| G3 | `reportedGap < targetGap`（严格小于） | 没到目标 |
| G4 | `stopReason !== 'iteration_limit'` | 被迭代上限截断 |
| G5 | `solverState` 不是 `running` / `queued` | 快照取自求解中途 |

**刻意不做**的事：给 `effectiveStackBB` 加人为上限。理由见 2.5。

### 2.4 判别力实测（18 条真实缓存，全部走 `lookupCachedOnly` 真链路）

```text
命中 18 · 未命中 0
准入 15 · 拒绝 3（全部 NOT_CONVERGED：c067cd8cb / cb693226d / c0b705399）
```

**两边都非空** ⇒ 闸门既不是"一律拒绝"也不是"一律放行"。拒绝后 `fromSolver = false`、`ranges` 为空、理由如实进 `outcomes.reasonZh`：

> 求解器数据未通过**准入**（NOT_CONVERGED）：求解器把本次结果标为**未收敛**…该快照仍保留在缓存中供诊断查看，但**不参与本次建议**，本次回落启发式先验

**未收敛的快照保留在缓存里**（可诊断），只是**不再影响建议**；回落路径本身已带"启发式先验"标记。

回归锁 `test/solverRangeAdmission.test.ts`（6 项）：ADMIT-1 已收敛必须通过 · ADMIT-2 拒绝理由必须归因"未收敛"而非"筹码太大" · ADMIT-3 1000000BB 必须被拒 · ADMIT-4 被拒时不得携带任何范围权重 · ADMIT-5 五条判据各自可触发（含 `gap == target` 不算达标）· ADMIT-6 全量真实缓存逐条可解释且两边非空。

### 2.5 为什么"给有效筹码加上限"是错的（实测否掉）

筹码深度**已经**进场景哈希与缓存键。逐维扰动实测：

| 扰动 | 场景 eff | cacheKey 与基准相同？ |
|---|---|---|
| 100 → 100.4 | 100.4 | 不同 |
| 100 → 40 | 40 | 不同 |
| 100 → 1000000 | 1000000 | **不同** |
| 100 → 1000 | 1000 | **不同** |
| openSizeBB 2.5 → 3 | 100 | **相同**（RFI 的 `defaultActionHistoryFor` 返回 `[]`，开池尺寸不进键） |
| tableSize 6 → 9 | 100 | 不同 |

所以「百万 BB 读到百 BB 的策略」**在结构上不会发生**；`c067cd8cb` 就是 1000000BB **自己**那条。真正的漏洞是「大筹码那条自己没收敛，却照样被用」。凭直觉加一个 200BB 上限会把缓存里**合法且已达标**的 40BB / 50BB / 100BB 数据一起砍掉。

### 2.6 ~~准入闸的作用范围：一个更上游的发现~~ —— **本节结论已被推翻，见 `reports/SOLVER_WIRING_AUDIT.md`**

⚠️ **我在本轮末尾给出的"生产环境里求解器范围一次都没被用上"是错的。** 那是我的探针错误：
我用 `buildGtoScenario({kind:'RFI', actionHistory: []})` 手工构造，
而生产走的是 `scenarioForOpponent(...)` —— 后者内部**本来就传 `actionHistory: []`**，
并把盲注动作挡在外面。实测生产口径下：

```text
6MAX/100BB/UTG/RFI  →  cacheKey c91e7b60a  →  缓存**有**（gap 0.165260 < 目标 0.2）→ ✅ 注入生效
```

因此 2.1 节那条"脏数据此前会被采用"的**可达性结论成立**（不是理论风险）。
完整接线审计见 `reports/SOLVER_WIRING_AUDIT.md`。下面保留原文以便追溯我错在哪。

<details>
<summary>（已推翻的原文）</summary>

`prefetchSolverRanges` → `enumerateOpponentScenarios(state)` 从 `state.actions` 构造前序历史，
而 `state.actions` **包含盲注动作**：

```text
eff=100BB actions = [SB:POST_SB:0.5, BB:POST_BB:1, UTG:RAISE:2.5, HJ:FOLD, CO:FOLD, BTN:FOLD, SB:FOLD:0.5]
```

而 `buildGtoScenario` 对 `RFI` 有一条语义不变量（`gtoScenario.ts:703-707`）：
`history.length !== 0` ⇒ 返回 `null`。实测：

| 输入 | 结果 |
|---|---|
| `RFI` + `actionHistory: []` | OK，cacheKey `c6458d2a5` |
| `RFI` + 含 `POST_SB`/`POST_BB` | **null（场景建不出来）** |

⇒ 候选对手枚举为空 ⇒ 求解器分支从不进入 ⇒ 实测 `fromSolver` 恒为 `false`。

**错在哪**：`RFI` 的 `scenarioForOpponent` 分支**不把** `state.actions` 直接交给
`buildGtoScenario`，而是传 `actionHistory: []`。我绕过了 `scenarioForOpponent` 直接调
`buildGtoScenario`，于是验的是"一个我手工拼出来的、生产根本不会构造的输入"。
`c6458d2a5` 也不是任何真实缓存键 —— 真正的那把是 `c91e7b60a`。

</details>

---

## 三、玩家记录是否会被误记

依据：`out/F-14-player-records-audit.md`（只读审计，独立探针）。

### 3.1 结论

| 问题 | 判定 | 依据 |
|---|---|---|
| 是否**可能**误记 | **是** | 两条机制已实测（见 3.3） |
| 是否**已经**误记 | **否**（就玩家记录而言） | 本副本 `data/player-history.jsonl` **不存在** ⇒ 玩家记录 0 条；`data/table-dynamics-log.jsonl` 有 9 行但**不含任何玩家身份字段**，承载不了"误记到某人" |
| 是否有过**泄漏**风险 | **是** | 两个文件从未进入任何本地或已 fetch 的远端分支（`git log --all` 空、`git rev-list --all --objects` 空、`check-ignore` 命中 `.gitignore:31/32`）；但分析路径**重复落盘**已实测 |

### 3.2 身份绑定（唯一构造处，实测正确）

| 写盘点 | 身份字段 | 判定 |
|---|---|---|
| `playerHistory.ts:289`（追加）/ `:331-332`（UNDO 重写） | `playerId` ← `seats.find(s => s.logicalPosition === action.position).playerId` | ✅ **持久 id**（`p2`） |
| `table-dynamics-log.jsonl` | 无玩家身份字段 | ⚠️ 落盘无门禁 |

换座安全：实测 `p2` 换座后 `playerId` 恒为 `p2`、`seatId` 由 `seat_UTG` → `seat_BTN` ⇒ **记录跟人不跟座位**。本手中 `SET_HERO_POSITION` / `REPLACE_PLAYER` 均被 `HAND_ACTIVE` 拒绝。

### 3.3 可能误记的两条机制（已实测，本轮未修）

**① 跨牌桌 `playerId` 复用**：`NEW_TABLE` 把 `nextPlayerNumber` 重置为 2，而 `player-history.jsonl` 是**全局**文件、键只有 `playerId`。实测：会话 1 的 `p2` 在河牌弃牌 ⇒ `foldToRiverBet: 1`；`NEW_TABLE` + 重新加人后**新的 `p2`**（另一个人）立刻拿到同一份 `observedStats`，并进入响应模型。

**② 丢弃/重录本手 ⇒ 记录残留 + `handId` 复用**：`revertObservations` 只被 UNDO 调用，`RESET_HAND` 不回退。实测 `RESET_HAND` 后 24 条记录仍在、重录得**同一 handId**、共 48 条同 handId ⇒ 河牌过牌-加注配对跨版本、机会翻倍而 `handsObserved=1`。

### 3.4 本轮修掉的 4 处 id 口径混用（静默失效）

链路里同时存在两套 id：`table.seats[].seatId` = `seat_BTN`、`table.seats[].playerId` = `p2`、`engine.players[].id` = `seat_BTN`。而 `computeTableDynamics` 的三个入参都在**持久 id** 空间（要和 `record.playerId` 比较）。

| # | 位置 | 修复前 | 后果 |
|---|---|---|---|
| 1 | `tableDynamicsServer.ts` `presentPlayerIds` | `Object.values(seatIdByPlayerId)` ⇒ 座位 id | `recordsUsed` 恒 0、所有记录被判"非在桌" ⇒ 桌况永远"观察中"、调整永不生效 |
| 2 | 同上 `relevantPlayerIds` | `realizedOpponentIds(engine)` ⇒ 座位 id | 逐对手层建不出来 |
| 3 | 同上 `heroPlayerId` | 与记录口径不一致 | `r.playerId === heroPlayerId` 恒不成立 ⇒ **Hero 自己的行为混进对手桌况**（正是那段注释要防的自我剥削） |
| 4 | `playerHistory.ts` `handComplete` | 只判 `COMPLETE` | 摊牌手 `phase === SHOWDOWN` ⇒ `handComplete` 恒 false，界面"已完成 N 手"恒 0 |

**实测修复效果**（同一批记录，两种口径对照）：

```text
修复前（座位 id）：recordsUsed 0 · excluded.notPresent 6 · tableConfidence 0      · 观察中
修复后（持久 id）：recordsUsed 6 · excluded.notPresent 0 · tableConfidence 0.1667 · 同上（证据确实不足）
```

`relevantByPlayer` 的键也从 `seat_HJ` 变成 `p3`。回归锁 `test/tableDynamicsIdSpace.test.ts`（5 项）同时锁住"口径一致性"与"混用会导致静默失效"。

### 3.5 已定性、本轮未修

| 风险 | 后果 | 建议 |
|---|---|---|
| 跨牌桌 `playerId` 复用 | 乙拿到甲的统计并进入响应模型 | `playerId` 全局唯一 / `NEW_TABLE` 不重置编号 / 记录加 `sessionId` |
| 丢弃本手不回退记录 + `handId` 复用 | 互斥版本合并成一"手" | `RESET_HAND` 也调 `revertObservations`；`handId` 永不复用 |
| UNDO 全文件重写丢并发追加 | 实测 8.7MB 种子 + 并发 400 行，窗口 861ms ⇒ **丢 24 行** | 改追加式 tombstone 或加锁重读 |
| OFF 模式仍落盘 | "已关闭"仍写数据 | `mode === OFF` 直接 return |
| 缺省目录 = `<cwd>/data` 且参数可选 | 分析数据写进使用者 `data/`（副本 9 行即此形态） | 参数必填或默认 tmp |
| 一行损坏 ⇒ 整文件不可用 | 好记录一并不可用 | 逐行容错 + 隔离坏行 |
| 无 schema / 无 `tableId` / 无轮转 | 431B/条 ≈ 592MB/年 | 加 `schemaVersion` / 分片轮转 |

---

## 四、画像验收规范修正

依据：`out/F-15-profile-acceptance-spec.md`（597 行，独立探针）。

### 4.1 被明确排除的表述

> ✗ 「改变 Hero 底牌必须让所有响应概率逐位不变」

**既非必要也非充分**：
- **不必要** —— Hero 的底牌是**公共信息**（他自己看得见），范围里与它冲突的组合**本就不该存在**，移除后重新归一化是**合法且必须**的。实测：同一份受控到达范围（9 个组合），`AsAh` ⇒ 保留 9、`7c2d` ⇒ 保留 7、`AhAd` ⇒ 保留 8。
- **不充分** —— 概率完全不变也排除不了"规则确实读了底牌、只是恰好没改变输出"。

### 4.2 替代判据（四条，逐条可执行）

| 编号 | 判据 | 状态 |
|---|---|---|
| **A1** | 固定「对手组合 / 公共牌 / 模型参数 / 被消费的画像参数」后，**产出概率的规则**不得读 Hero 底牌。操作化：声明输入无底牌字段 + 诱饵陷阱（读取即抛错）+ Proxy 间谍记录访问来源 | **部分通过** |
| **A2** | 换底牌后任何概率变化必须**完全由「移除被挡组合 + 重归一化」解释**，且可逐位复算 | **已通过**（最大偏差 `0.000e+0`） |
| **A3** | 不得使用未来信息：未来街行动 / 未揭示对手底牌 / 结果 | **已通过**（全部 fail-closed，含阳性对照） |
| **A4** | 有效性 = (i) 被消费参数**确实到达模型** + (ii) 收益**可复算**。**不要求动作改变** | **已通过** |
| **A5** | 设了但从未被任何概率/收益路径读取的画像值，必须报为 **NOT_CONSUMED** | **未通过** |

**A1 的不通过处（既存残余）**：`classifyVillainAfterCheck` 与 `classifyResponse` 的权重依赖 `versusHero`（由 `compareHands(他的组合, Hero底牌∪公共牌)` 派生）。实测只改 `versusHero`：`weights.bet 0.55 → 0`、`continueIndex 0.61 → 0.41`。作用面在「Hero 未下注 / 过牌后」分支。

**A5 的不通过处**：`villainDimensions.confidence` **没有任何消费点** —— `conf 0.05` 与 `0.99` 的可观测输出**逐位相同**，而 `hashManualInput` 却变了（`h5cebce99` → `h3c044f3a`）⇒ **看起来像生效**。当前没有任何字段或文案披露它未被消费。

**A4 的关键更正（按你的要求）**：动作不变**仍然判有效**。实测 `aggression = 0.9` 与 `0.1` 都给出 `RAISE@800`（无覆盖也是 `RAISE@800`），但 `reRaiseLikelihood` 与 `raiseEV` 均已变 ⇒ **判为有效**。

### 4.3 按新规范重写了那条错测试

`test/preflopRaiseDecision.test.ts` 原来的 **B-07** 断言的就是被排除的表述，而且它**根本没测到自己声称的东西**：`build()` 不接收 Hero 底牌（调用两次比的是它自己），两处 `facts` 用的是**同一个 state** ⇒ 从未换过 Hero 底牌，是一条零覆盖的空测试。

现在拆成两条：

| 编号 | 判据 |
|---|---|
| **B-07** | 规则层直调：`buildPreflopRaiseResponse` 的声明输入里**根本没有底牌字段** ⇒ 同一输入必然同一输出。附反证：换到达范围必须改变输出（否则证明不了任何事） |
| **B-07b** | 事实包换底牌后的变化必须由「死牌 → 移除 → 重归一化」**独立复算逐位重现**：期望值来自**独立复算的范围 + 同一个规则函数**，不是把生产输出再读一遍。并显式断言"底牌真的换了"（防夹具退化再次变成空测试） |

用 1e-12 容差而非逐位相等：两侧求和顺序不同（生产权重表顺序 vs 测试受控顺序），实测最大偏差 **3e-16**，是浮点求和顺序噪声；该容差比任何有决策意义的差异（≥1e-4）小 8 个数量级。

---

## 五、明确未修 / 未验证

### 5.1 已定性、本轮未修（建议下一轮）

| 项 | 后果 | 为什么本轮不修 |
|---|---|---|
| 跨牌桌 `playerId` 复用 | 甲的行为统计被注入成乙的 | 需要身份模型设计（`sessionId` / 全局唯一 id） |
| 丢弃本手不回退记录 + `handId` 复用 | 互斥版本合并 | 与上一条同源，一起做 |
| UNDO 全文件重写丢并发追加 | 实测丢 24 行 | 需要改成 tombstone 或加锁，属存储层重构 |
| 分析路径重复落盘 / OFF 仍落盘 / 缺省目录 = `<cwd>/data` | 数据无界增长 + 写进使用者目录 | 属准入与配置面，可与玩家记录一起做 |
| `classifyVillainAfterCheck` / `classifyResponse` 读 `versusHero` | 规则层读了 Hero 底牌（A1 未通过） | 需要判断该依赖是否有正当理由（"他相对我的强度"是否算公共信息） |
| `villainDimensions.confidence` 未消费且无披露 | 参数看起来生效、实际无效 | 需要定义"未消费"的披露口径 |
| `confidence` 硬上限 ≤ 0.4 ⇒ MEDIUM/CLEAR 不可达；`MATH_DOMINANCE` 文案自相矛盾；`betResponse.ts:778-780`；BB 首次加注 `CONTEXT_BUILD_FAILED`；死边池界面按钮；累计短全下不再开注；座位名≠角色范围档；决策日志只写不读；无重放/修订/导入导出；翻后超预算 | — | 均属既有审计的 P1/P2，未纳入本轮四项 |

### 5.2 未验证

- **浏览器验收未做**：本会话无浏览器自动化工具；桌况调整因 3.4 修复后**仍需上游枚举修复**才会真正生效，现在做浏览器验收只能验"界面不报错"，验不了"调整生效"。
- **5.2 / 15.7 的逐记录复算未产出**：仍待做。
- **准入闸的实机效果未验证**：因为 2.6 —— 生产路径本就不进入求解器分支，闸门虽已接在**共用**函数上（冷求解与缓存命中都过），但"在真实请求里拦下一条脏数据"这件事**无法在当前代码状态下演示**。我能证明的是：18 条真实缓存条目走真链路时的裁决逐条正确。
- **`effectiveStackBB` 的合法上界未定**：本轮只证明"凭直觉加上限会误杀合法数据"，没有给出正确上界的依据。
- **玩家记录侧的 `appliedChanges` 是否持久化玩家/座位 id 未观测到**（9 行全为 `[]`）。
- **`local#H1` 那 9 行的写入者未抓到 PID**，"Node 侧默认 id + 未传 historyDir"是推断。

---

## 六、结论边界

**本轮证明了**：
1. 翻前加注 EV 资金流在 54 个对照点上与引擎分层台账逐位一致；生产公式（第二轮那版）**本来就是对的**，我此前的"修复"是错的且已撤销；翻后那条同源错公式已改正；回归锁不再与生产共享公式。
2. 三条未收敛的求解器快照此前会被当成结论使用；现已被准入闸拦下（18 条实测：拒绝 3、放行 15），且该闸装在冷求解与缓存**共用**的函数上。
3. 玩家记录**没有**被误记（记录 0 条、文件从未进过任何分支）；但同链路 4 处 id 口径混用会导致桌况调整**静默失效**，已修 3 处 + `handComplete`，实测 `recordsUsed` 0 → 6。
4. 画像验收规范已按"不得要求换底牌后概率不变"重写为 A1–A5，并按新规范把一条**空测试**改成了两条真测试。

**本轮不宣称**：
- 不宣称整个软件已经完善；
- 不宣称已具备稳定盈利能力；
- 不宣称桌况动态适应已经生效 —— 上游枚举缺陷未修，调整仍不会真正发生；
- 不宣称求解器范围已进入建议 —— 同上；
- 不宣称 A1 / A5 已通过 —— 它们**未通过**，已如实列出。
