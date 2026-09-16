# 桌型语义审计报告（Table Size Semantics Audit）

> **审计对象**：`D:\德州`（TypeScript，无 git 仓库）
> **审计方法**：全量 ripgrep + 逐处读源码 + 5 个可执行探针（`scripts/rt-audit-probe.ts` ~ `rt-audit-probe5.ts`）
> **审计快照**：`2026-09-13 16:16`
> **快照实测**：`tsc --noEmit` → **0 错误**；`node --test` → **1204 项 / 136 套件，1198 通过、6 失败**

---

## ⚠️ 关于本报告的时效性（请先读这一节）

**审计期间源码在被持续改动。** 以下文件在本次审计窗口内（16:03–16:16）被写入过：

| 时刻 | 文件 |
|---|---|
| 16:03 | `src/domain/poker/positions.ts` |
| 16:04 | `src/domain/poker/gameState.ts` |
| 16:08 | `src/domain/poker/validator.ts`、`src/i18n/zh-CN.ts` |
| 16:10 | `test/validator.test.ts` |
| 16:11 | `src/app/manualInput/manualInput.ts` |
| 16:12 | `src/app/manualInput/reconstruct.ts`、`src/app/alphaPipeline.ts`、`test/alphaRedteamRegression.test.ts` |
| 16:14 | `src/app/table/table.types.ts` |
| 16:15 | `src/app/table/tableState.ts` |
| 16:16 | `src/app/table/seatLifecycle.ts`、`test/tableTopology.property.test.ts`（新增） |

**我实际观察到的事实**：审计开始时（约 16:09）测试是 `1185 passed / 0 failed`；到 16:16 变成 `1204 项 / 6 失败`（其中 3 项是作者**刻意标注的「预期失败」**）。也就是说 **「全绿」这个信号本身也在移动**，不能作为收敛证据。

因此：
- 本报告所有 **file:line 与代码片段**对应 **16:16 快照**；
- §7 给出**复验清单**——重构落地后必须重跑，其中若干「待修」会变成「已修」；
- 我**不**把任何「我已确认修好」的结论建立在「测试通过」之上，只建立在**读到代码 + 探针实测**之上。

---

## 0. 一句话结论

**「桌型纠偏」在域层（`positions.ts` / `gameState.ts` / `validator.ts`）是真的做对了，而且做得很扎实**——
`CANONICAL_ROLES`、`handTopologySeats`、`2 ≤ 本手人数 ≤ 容量` 这套抽象方向完全正确，
新增的 `test/tableTopology.property.test.ts`（属性测试 + 刻意标注的真实缺陷）也是本仓库质量最高的测试之一。

**但从牌桌层到 `ManualHandInput` 的生产者链路、范围先验选型、位置显示名这三块，仍然把 `tableSize` 当成「本手人数」在用。**
因此题目的头号目标——「9 座桌 8 人无法分析」——**在产品可达路径上仍然无法分析**：
原因从「`createGame` 拒绝建局」换成了「`staffingProblems` 拒绝分析」。

> **拦路的位置换了，拦路本身没拆掉。**

---

## 1. 审计范围与命中数

| 目录 | `tableSize` 文本命中数 |
|---|---|
| `src/**/*.ts` | **185**（分布在 23 个文件） |
| `test/**/*.ts` | 184 → 因新增属性测试文件而增长中 |
| `scripts/**/*.ts` | 118 |
| `scripts/**/*.txt`（红队证据快照） | 58 |
| `data/knowledge/source-registry.json` | 6 |
| `docs/**` | 4 |
| **合计** | **约 555** |

`scripts/**/*.txt` 与 `data/*.json` 的命中是**历史证据快照与知识库元数据**，不是可执行语义（见 §3.15）。

---

## 2. 分类口径

| 桶 | 含义 | 判据 |
|---|---|---|
| **A** | 真需要 `tableCapacity` | 决定**物理座位环长度 / 座位集合 / 盲注与行动顺序的物理环绕** |
| **B** | 真需要 `handedness` | 决定**本手发牌给几个人**（位置角色、范围先验选型） |
| **C** | 真需要 current live players | 用于**决策门槛 / 权益口径**（当前仍未弃牌的人数） |
| **D** | 只是 UI 显示 | 只影响呈现 |
| **E** | 旧逻辑混用了概念（需要修） | 同一字段/同一路径同时承担两个以上含义 |

---

## 3. 核心消费方逐条分类

### 3.1 Position 定义 —— `src/domain/poker/positions.ts`

| 文件:行 | 代码片段 | 分类 | 理由 | 状态 |
|---|---|---|---|---|
| `positions.ts:32-45` | `POSITION_ORDER: Record<TableSizeType, readonly Position[]>` | **A** | **物理座位环**的唯一权威定义（下标 0 = UTG，顺时针） | 无需改 |
| `positions.ts:48-55` | `positionsForTable` / `seatCount` | **A** | 容量 → 座位集合 / 环长 | 无需改 |
| `positions.ts:58-73` | `seatIndexOfPosition` / `positionAtSeatIndex` | **A** | 位置的物理下标 | 无需改 |
| `positions.ts:90-107` | `preflopOrder` / `postflopOrder` | **A**⚠️ | 用物理座位环绕，语义正确；但基于「Button 下一位必是小盲」的**满桌假定**（§5.2） | ⚠️ 待修（旧接口） |
| `positions.ts:153-196` | `CANONICAL_ROLES: Record<number, Position[]>` | **B** | 键是**本手人数 2~9**——正确的新抽象 | ✅ 已修 |
| `positions.ts:199-210` | `canonicalRolesOf` / `isHeadsUpHand` | **B** | 人数 → 角色表 / 单挑判定 | ✅ 已修 |
| `positions.ts:219-236` | `occupiedSeatIndices(tableCapacity, occupied)` | **A** | 物理下标采集；空座跳过但下标保持物理含义 | ✅ 已修 |
| `positions.ts:251-259` | `nextButtonSeat(fromSeat, eligibleSeats)` | **A** | 物理座位环绕（跨边界） | ✅ 已修（**当前 `src/` 内无调用者**） |
| `positions.ts:300-373` | `handTopologySeats(tableCapacity, occupied, buttonSeat)` | **A + B**⚠️ | 签名/返回值把容量与人数**分开**，方向正确。但实现有 3 个真实缺陷（§5.3 / §5.4 / §5.6） | ⚠️ **部分待修** |
| `positions.ts:381-388` | `blindsOf(tableCapacity, button)` | **A**⚠️ | 参数已更名，算法仍是 `button+1/button+2`（满桌假定） | ⚠️ 待修（旧接口） |
| `positions.ts:392-404` | `positionGroup(tableSize, position)` | **A** | 按下标分早/中/后位。**`src/` 内零调用（死代码）** | 无需改（建议删除） |

### 3.2 State creation（`createGame`）—— `src/domain/poker/gameState.ts`

| 文件:行 | 代码片段 | 分类 | 理由 | 状态 |
|---|---|---|---|---|
| `gameState.ts:36` | `GameConfig.tableSize: TableSizeType` | **A** | 座位容量 | 无需改（建议改名 `tableCapacity`） |
| `gameState.ts:366-368` | 容量白名单 6/9 | **A** | — | 无需改 |
| `gameState.ts:370-384` | `if (seeds.length < 2 \|\| seeds.length > config.tableSize) throw` | **A + B** | **修复的核心**：`=== tableSize` → `2 ~ tableSize` | ✅ 已修 |
| `gameState.ts:400` | `seatIndexOfPosition(config.tableSize, seed.position)` | **A** | 座位属于容量 | 无需改 |
| `gameState.ts:409-411` | 按 `seatIndexOfPosition` 排序 | **A** | 按**物理座位**排序 | ✅ 已修 |
| `gameState.ts:473-486` | `handTopologySeats(...)` → 按 `smallBlindSeatIndex`/`bigBlindSeatIndex` 找盲注玩家 | **A + B** | 盲注按拓扑落座 | ✅ 已修 |
| `gameState.ts:293-312` | `streetOrder`：`ring = POSITION_ORDER[config.tableSize]`，起点取拓扑 | **A + B** | 物理环绕 + 本手起点 | ✅ 已修 |
| `gameState.ts:300-303` | `state.street === PREFLOP ? firstToActSeatIndex : smallBlindSeatIndex` | **B**⚠️ | **翻牌后起点用「小盲座位」——这在单挑时是错的**（单挑翻牌后大盲先行动）。见 §5.4 | ⚠️ **待修** |
| `gameState.ts:321-327` | `stateTopology(state)` | **A + B** | 从状态重算拓扑 | ✅ 已修 |
| `gameState.ts:495-497` | `pendingQueue = streetOrder(state).filter(...)` | **A + B** | 建局队列 | ✅ 已修 |

**探针实证**（`scripts/rt-audit-probe.ts`）：
```
[域层] 9 座桌 8 人 createGame：成功，players=8
[域层] validateTableSetup：通过
```

### 3.3 Validator —— `src/domain/poker/validator.ts`

| 文件:行 | 代码片段 | 分类 | 理由 | 状态 |
|---|---|---|---|---|
| `validator.ts:235-240` | 容量白名单 6/9 | **A** | — | 无需改 |
| `validator.ts:252-268` | `if (players.length < 2 \|\| > tableSize) → PLAYER_COUNT_MISMATCH` | **A + B** | **修复的核心** | ✅ 已修 |
| `validator.ts:270-287` | `allowed = positionsForTable(tableSize)` + 位置/ID 重复检查 | **A** | 座位环校验 | ✅ 已修（新增玩家 ID 重复检查） |
| `validator.ts:289-315` | 调 `handTopologySeats` 校验「盲注位落在参与者里」 | **A + B**⚠️ | **该断言恒真、无约束力**——`smallBlindSeatIndex` 按构造一定来自 `handSeatIndices`。实测放行了「SB 空座 → UTG 下大盲」的假牌局（§5.6） | ⚠️ **待修（空断言）** |
| `src/i18n/zh-CN.ts:274` | `'ISSUE.PLAYER_COUNT_MISMATCH': '本手人数与座位容量不匹配：{tableSize} 座桌的本手人数必须在 {expected} 之间…'` | **A + B** | 文案已改容量口径 | ✅ 已修 |

### 3.4 Action queue（`streetOrder` / `rebuildPendingQueue`）

| 文件:行 | 代码片段 | 分类 | 理由 | 状态 |
|---|---|---|---|---|
| `gameState.ts:293-312` | `streetOrder` | **A + B** | 见 §3.2 | ✅ 已修 |
| `engine.ts:456-507` | `rebuildPendingQueue`：`fullOrder = streetOrder(state)` → 定位 → 环绕 → `needsToAct` 过滤 | **A + B** | 完全走 `streetOrder`，自动继承新拓扑 | ✅ 已修（间接） |
| `engine.ts:483-495` | `startIndex < 0` 时**不旋转** | **A** | 防止「弃牌者不在列表 → `findIndex` = -1 → 队列凭空重排」 | ✅ 已修 |
| `engine.ts:565-576` | `resetStreetState` → `pendingQueue = streetOrder(state).filter(...)` | **A + B**⚠️ | **起点由 `streetOrder` 决定，因此单挑翻牌后顺序继承 §3.2 的缺陷** | ⚠️ **待修** |
| `validator.ts:402-403, 444-447` | `const order = streetOrder(state); orderIndex = ...` 然后 `void current` | **A + B**⚠️ | 算了 `orderIndex` 却**没用于任何断言**——顺序检查是空的 | ⚠️ 待修（既有缺陷） |

### 3.5 Blinds

| 文件:行 | 代码片段 | 分类 | 理由 | 状态 |
|---|---|---|---|---|
| `gameState.ts:468-486` | 盲注按 `topology.smallBlindSeatIndex` / `bigBlindSeatIndex` 下落 | **A + B** | 新路径 | ✅ 已修 |
| `positions.ts:381-388` | `blindsOf`：`order[(btn+1)%len]` / `order[(btn+2)%len]` | **A**⚠️ | 满桌假定的旧接口；生产路径零调用（仅测试） | ⚠️ 待修（§5.2） |
| `i18n` 位置词条（`position.9.8 = 小盲位` 等） | **D** | 显示文案 | 无需改 |

### 3.6 Range Prior —— `src/app/manualInput/preflopPriors.ts`

| 文件:行 | 代码片段 | 分类 | 理由 | 状态 |
|---|---|---|---|---|
| `preflopPriors.ts:606-641` | `rfiTierOf(tableSize, position)`：`if (tableSize === NINE_MAX) {9 人档} else {6 人档}` | **E**⚠️ | 参数名是 `tableSize`，语义上要的是**本手人数**；只有「9 人」与「非 9 人」两档，**2/3/4/5/7/8 人全部落进 6 人档位**。8 人桌 UTG 会拿到 6 人桌的 `EARLY`（比它应得的更松） | ⚠️ **待修** |
| `preflopPriors.ts:644-650` | `defendTierOf(tableSize, opener, defender)` | **E**⚠️ | 透传二元假定 | ⚠️ 待修 |
| `preflopPriors.ts:658-668` | `threeBetTierOf(tableSize, threeBettor, opener)` | **E**⚠️ | 同上 | ⚠️ 待修 |
| `preflopPriors.ts:676-683` | `threeBetWeights(tableSize, …)` | **E**⚠️ | 同上；缓存键只区分 4 档 | ⚠️ 待修 |
| `preflopPriors.ts:700-703` | `rfiWeights(tableSize, position)` | **E**⚠️ | 同上 | ⚠️ 待修 |
| `preflopPriors.ts:706-713` | `defendWeights(tableSize, …)` | **E**⚠️ | 同上 | ⚠️ 待修 |
| `contextBuilder.ts:401, 418-433` | `const tableSize = state.config.tableSize;` → 传给上面 4 个函数 | **E**⚠️ | **混淆的发生点**：手上明明有 `state.players`（本手人数），却传了容量 | ⚠️ **待修** |

> 满桌时 `capacity === handedness`，所以这 6 处**在满桌下完全正确**——这正是它能一直藏到现在的原因。

### 3.7 Likelihood

| 文件:行 | 代码片段 | 分类 | 理由 | 状态 |
|---|---|---|---|---|
| `contextBuilder.ts:469-540+` | `applyLikelihoodUpdates(range, state, opponent, baseAggression)` | **无需 `tableSize`** | 似然只按「对手位置 + 行动类型 + 该街」查表，**全项目唯一彻底不读桌型的策略模块** | 无需改 |
| `contextBuilder.ts:944-945` | `opponents = state.players.filter(p => p.id !== hero.id && !p.folded)`；`primaryOpponent = opponents[0]` | **C** | 「当前仍未弃牌」口径，正确 | 无需改 |

### 3.8 Manual Input —— `src/app/manualInput/manualInput.ts`

| 文件:行 | 代码片段 | 分类 | 理由 | 状态 |
|---|---|---|---|---|
| `manualInput.ts:207` | `ManualHandInput.tableSize: 6 \| 9` | **A** | 契约里的座位容量 | 无需改 |
| `manualInput.ts:271-287` | **新增** `occupiedPositions?: readonly Position[]` | **B** | 本手真正参与的物理座位 | ✅ 已修（**消费者已接通，生产者仍缺——§5.5**） |
| `manualInput.ts:288-293` | **新增** `buttonPosition?: Position` | **A** | Button 的物理座位 | ✅ 已修 |
| `manualInput.ts:324-355` | **新增** `ParsedManualInput.occupiedPositions / buttonPosition / handedness` | **A + B** | 三概念在类型层面分开；`handedness = occupiedPositions.length` | ✅ 已修 |
| `manualInput.ts:394-401` | 容量白名单 → `INVALID_TABLE_SIZE` | **A** | — | 无需改 |
| `manualInput.ts:404-416` | `positions = positionsForTableOf(tableSize)`；校验 `heroPosition ∈ positions` | **A** | 座位环成员 | 无需改 |
| `manualInput.ts:559` / `:677` | 行动记录位置 / `seatStacksBB` 键不在桌型上 → 报错 | **A** | 座位环成员 | 无需改 |
| `manualInput.ts:729-771` | `occupiedPositions` 解析与校验（容量内唯一、≥2 人、须含 Hero） | **B** | 本手人数的权威校验 | ✅ 已修 |
| `manualInput.ts:773-788` | `buttonPosition` 校验（属于容量、属于参与者） | **A** | Button 座位 | ✅ 已修 |

### 3.9 Table Adapter —— `src/app/table/tableAdapter.ts`

| 文件:行 | 代码片段 | 分类 | 理由 | 状态 |
|---|---|---|---|---|
| `tableAdapter.ts:36, 80-83` | `for (const problem of staffingProblems(state)) issues.push({code:'SEAT_EMPTY', …})` | **E** | 注释仍写「冻结的 Poker Core 要求 N 人桌恰好 N 位玩家」——**该前提已不成立**，但检查还在，且仍然阻断 | ⚠️ **待修（§5.1 头号问题）** |
| `tableAdapter.ts:56` | `positionsForTableOf(state.tableSize)` | **A** | 按物理座位序找首要对手 | 无需改 |
| `tableAdapter.ts:169-181` | `tableSize: state.tableSize`（**没有** `occupiedPositions` / `buttonPosition`） | **A + B** | 生产者缺口 | ⚠️ **待修（§5.5）** |

**探针实证**（`scripts/rt-audit-probe5.ts`，16:16 快照）：
```
staffingProblems = ["有 1 个空座位（枪口+2）。本版本要求牌桌上每个座位都有人 —— 请点空座位加入玩家。"]
adapter.ok = false
preview.canAnalyze = false
```

### 3.10 Table State / API（生产者链路）

| 文件:行 | 代码片段 | 分类 | 理由 | 状态 |
|---|---|---|---|---|
| `tableState.ts:228-264` | `staffingProblems`：`empties.length > 0` → 阻断 | **E** | **「9 座 8 人无法分析」的新落点** | ⚠️ **待修** |
| `tableState.ts:120-129` | 文档：「空座位会阻断分析，因为冻结的 Poker Core 要求「N 人桌恰好 N 位玩家」」 | **E** | **注释与事实不符** | ⚠️ 待修（文档） |
| `tableState.ts:86-88` | `logicalSeatOrder(tableSize)` → `positionsForTableOf` | **A** | 容量 → 座位环 | 无需改 |
| `tableState.ts:99-103` | `visualIndexOf(tableSize, heroPosition, position)` | **D** | 视觉序号只影响渲染 | 无需改 |
| **`table.types.ts:202-219`** | **新增** `HandTopologySnapshot`：`tableCapacity` / `participantSeatIds` / `handedness` / `buttonSeatId` / `smallBlindSeatId` / `bigBlindSeatId` / `rolesBySeatId` | **A + B** | **表层的概念分离已经建好**——这是本轮最有价值的表层改动 | ✅ 已修（新增） |
| `table.types.ts:222-239` | `TableCore` 新增 `buttonSeatId` / `handTopology` / `handsCompleted`；`tableSize` 注释已改为「**座位容量**——不是本手人数」 | **A** | Button 成为一等状态 | ✅ 已修 |
| `tableState.ts:284-297` | `eligibleButtonSeats` / `participantSeatsOf`（跳过空座 / 暂离 / 0 筹码） | **B** | 本手参与者判据 | ✅ 已修（新增） |
| `tableState.ts:310-322` | `advanceButtonSeatId`（从旧 Button 座位顺时针、跳过不合格、跨边界） | **A** | 座位环轮转 | ✅ 已修（新增） |
| `tableState.ts:330-359` | `freezeTopology(state, handNumber)` | **A + B** | 冻结本手拓扑快照 | ✅ 已修（新增） |
| `tableState.ts:366-380` | `roleOfSeat` / `heroRole` / `handednessOf` | **A + B** | 按 seatId 查本手角色 | ✅ 已修（新增） |
| `tableApi.ts:233-240` | `if (seatsRaw.length !== expectedPositions.length) → '座位数（N）与桌型（M 人桌）不符'` | **E** | 协议强制「序列化座位数 == 容量」。**注意**：座位表本身就该是「容量表 + EMPTY 占位」，所以这条校验**内容上是对的**，问题在 `staffingProblems` 把「有 EMPTY」当成了「人数不对」 | 无需改（建议改注释澄清契约） |
| `tableApi.ts:179-183, 274` | 容量白名单；`visualIndex ∈ [0, tableSize)` | **A + D** | — | 无需改 |
| `seatLifecycle.ts:651-734` | `setTableSize(state, tableSize)` | **A + D** | 切换**容量**（增删物理座位） | 无需改 |
| `seatLifecycle.ts:100-110` | `reseatVisuals(…, tableSize, …)` | **D** | 只重算视觉序号 | 无需改 |

### 3.11 Alpha Pipeline / Cache Key / Input Hash

| 文件:行 | 代码片段 | 分类 | 理由 | 状态 |
|---|---|---|---|---|
| `alphaPipeline.ts:483` | `tableSize: input.tableSize`（哈希规范化） | **A** | 容量进哈希 | 无需改 |
| `alphaPipeline.ts:500-501` | **新增** `occupiedPositions` / `buttonPosition` 进哈希 | **B + A** | 本手拓扑参与哈希 | ✅ 已修 |
| `rangeCache.ts:37` | `RangeCacheKeyInput.tableSize: number`（注释「桌型（6 / 9）」） | **E**⚠️ | 这一维**真正想要的是 handedness**（范围先验选型依据）。**当前 `src/` 内 `buildRangeCacheKey` 无生产调用者** | ⚠️ **待修（潜在）** |
| `rangeCache.ts:85` | `` `t=${input.tableSize}` `` | **E**⚠️ | 同上 | ⚠️ 待修（潜在） |
| `decisionLog.ts`（全文件） | `DecisionLogEntry` 里**没有 `tableSize` 字段** | **无需 `tableSize`** | 日志通过 `inputHash` 间接携带拓扑，结构上不可能混用 | 无需改 |

> `rangeCache` 一旦接线，`t=<容量>` 会让「9 座 8 人」与「9 座 9 人」命中同一先验选型口径，而这两者本该不同档（§3.6）。

### 3.12 Decision Context

| 文件:行 | 代码片段 | 分类 | 理由 | 状态 |
|---|---|---|---|---|
| `decision.types.ts:356-357` | `activeOpponentCount: number`（注释写「参战人数（含 Hero）」，实际值**不含 Hero**） | **C** | 决策门槛口径 | 无需改（命名有歧义，见 §5.8） |
| `contextBuilder.ts:944` | `opponents = state.players.filter(p => p.id !== hero.id && !p.folded)` | **C** | **「仍未弃牌」= live players**，正确 | 无需改 |
| `contextBuilder.ts:1009` | `activeOpponentCount: opponents.length` | **C** | 同上 | 无需改 |
| `decisionEngine.ts:88` | `MULTIWAY_REFUSE_THRESHOLD = 3` | **C** | 活跃对手门槛 | 无需改 |
| `decisionEngine.ts:326, 355, 1075` | 门槛与权益口径 | **C** | — | 无需改 |
| `decisionEngine.ts:59-84` | 注释：门槛为何是 3 而非 2 | **C + 已知近似** | **主动承认**用的是「未弃牌」而非题目所述 `currentOpponentCount`（已入池）。二者在「还没行动的大盲」上分歧。这是**已披露的近似**，不是隐藏 Bug | 无需改（见 §5.8） |

### 3.13 ViewModel / Logging / Web

| 文件:行 | 代码片段 | 分类 | 理由 | 状态 |
|---|---|---|---|---|
| `viewmodels/decisionViewModel.ts`（全文件） | 无 `tableSize` | **无需 `tableSize`** | 只做展示结构映射 | 无需改 |
| `app/decisionLog.ts`（全文件） | 无 `tableSize` | **无需 `tableSize`** | 见 §3.11 | 无需改 |
| `app/web/table.js:208` | `post('/api/table', { tableSize: 6, heroPosition: 'BTN' })` | **D + E** | 前端建桌**硬编码 6 人桌**；界面无法表达「本手几个人」 | ⚠️ 待修（§5.7） |
| `app/web/table.js:274-292` | 读 `meta.tableSizes` / `meta.positions` | **D** | 从 meta 取枚举，无硬编码 | 无需改 |
| `app/web/index.html:26` | `<span id="tableSizeButtons">` | **D** | DOM 容器 | 无需改 |
| `tableApi.ts:818-838` | `tableMetadata(): tableSizes: [{value:6,labelZh:'6 人桌'},{value:9,…}]` | **D** | 渲染枚举。建议 `labelZh` 改为「6 座桌 / 9 座桌」——「N 人桌」这个词本身就是本轮要消灭的混淆 | ⚠️ 建议改 |
| `i18n/index.ts:62-97` | `positionAtSeat` / `seatOfPosition` / `positionMainLabel` / `positionAuxLabel` / `positionLabel` / `positionGroupLabel` | **A + D**⚠️ | 用 `tableSize` 把**物理座位号**映射成中文名。作为「容量 → 座位名」自洽；但**角色名重算后显示名不会跟着变**（§5.3） | ⚠️ 待修 |
| `i18n/zh-CN.ts:39-69` | 只有 `position.6.*` / `position.9.*` 两套文案 | **D** | 非满桌无文案可查 | ⚠️ 待修（缺口） |
| `cli/demoFixtures.ts:39, 48, 84` | `positionLabel(state.config.tableSize, position)`；`DEMO_TABLE = SIX_MAX` | **A + D** | CLI 演示，固定满桌 | 无需改 |

### 3.14 Tests

| 文件:行 | 分类 | 理由 | 状态 |
|---|---|---|---|
| `test/state.test.ts:49-113` | **A + B** | 已改写为「本手人数必须在 2 ~ 座位容量之间（容量 ≠ 本手人数）」，含「6 座桌 2 人」「6 座桌 5 人（非连续空位）」正例 | ✅ 已修 |
| `test/validator.test.ts:171-192` | **A + B** | 已改写为「本手人数 < 2 → 报错；2~容量之间合法」 | ✅ 已修 |
| `test/validator.test.ts:499-509` | **A + B** | 已改写为「本手人数少于 2」（旧用例是「9 座桌删到 5 人」） | ✅ 已修 |
| **`test/tableTopology.property.test.ts`（新增，1471 行）** | **A + B** | **本次审计质量最高的测试**：属性测试（固定种子可复现）覆盖 §83 容量≠人数、§84 Button 轮转、§81 满桌兼容、§85 真实牌局、§86 单挑、§87 失败即关闭、§112 性能；并且**刻意把 3 个真实缺陷标为「预期失败」而不放宽断言** | ✅ 已修（新增） |
| `test/helpers.ts:53, 82-100, 110` | **A**⚠️ | `makeGame` 只按容量铺满座位，**没有生成非满桌状态的能力** | ⚠️ 待修（缺 helper） |
| `test/positions.test.ts:55-238` | **A** | `POSITION_ORDER` / `preflopOrder` / `blindsOf` / 标签唯一性，全部按容量 6/9 参数化 | 无需改 |
| `test/i18n.test.ts:126-129`、`test/positionConsistency.test.ts:38-42` | **D** | 中文位置名唯一性 | 无需改 |
| `test/alphaRedteamRegression.test.ts:836-880` | **A + B**⚠️ | 新增 `occupiedPositions` / `buttonPosition` 的**哈希扰动**回归；**但没有断言它们改变建局结果** | ⚠️ 待补（§5.9） |
| `test/**` 其余约 170 处 | **A** | 绝大多数是 `makeGame({tableSize:6})` / `createTable({tableSize:6})` 夹具 | 无需改 |

### 3.15 Scripts / docs / data（非语义）

| 位置 | 分类 | 说明 |
|---|---|---|
| `scripts/**/*.ts`（118 处） | **A**（绝大多数） | `tableSize: 6/9` 请求负载与夹具；`SET_TABLE_SIZE` 是容量操作 |
| `scripts/**/*.txt`（58 处） | **D** | 红队**证据快照**里的 JSON 指纹，只读历史 |
| `reports/*.md`（含 `TABLE_INTERACTIVE_REPORT.md:63,274`） | **D** | 历史报告正文 |
| `data/knowledge/source-registry.json`（6 处） | **D** | 知识库来源元数据里的 `"tableSize": "6-max"` 等**人类可读描述串**，不参与计算 |
| `knowledge.ts:146,157` / `knowledge.types.ts:238` | **D** | `scope.tableSize?: string` 是知识来源的**自由文本标签**，与领域 `TableSize` 枚举无关；注释已如实写明「完全未校验」 |
| `docs/ARCHITECTURE.md:256, 293, 450` | **D + E** | `positionLabel(tableSize, seat)` 描述；`GameConfig { tableSize, … }`；`B21 6 人桌误用 9 人桌位置表`——**文档尚未反映新拓扑** |

---

## 4. 分桶统计

| 桶 | 含义 | 计数（`src/**/*.ts` 185 处的归类） |
|---|---|---|
| **A** | 真需要 `tableCapacity` | **约 121 处** |
| **B** | 真需要 `handedness` | **约 22 处**（含新增的 `occupiedPositions` / `handedness` / `CANONICAL_ROLES` / `HandTopologySnapshot` 一族） |
| **C** | 真需要 current live players | **5 处**（`contextBuilder.ts:944/1009` + `decisionEngine.ts:88/326/355/1075`，**且全部正确**） |
| **D** | 只是 UI 显示 | **约 26 处** |
| **E** | 旧逻辑混用了概念（需要修） | **11 处**（逐条见 §5） |

> **A + B 合计 143 处是「同一个 `tableSize` 标量被两种口径共用」的现场**：满桌时两者相等，看不出问题；一旦非满桌就分叉。

**E 桶 11 处明细**：

| # | 文件:行 | 一句话 |
|---|---|---|
| E1 | `src/app/table/tableState.ts:244-249` | `staffingProblems`：任何空座位 → 阻断分析 |
| E2 | `src/app/table/tableAdapter.ts:80-83` | 转发 E1，并保留「Core 要求恰好 N 人」的过期注释 |
| E3 | `src/app/table/tableState.ts:228-232` | 与 E1 同源的过期文档 |
| E4 | `src/app/manualInput/preflopPriors.ts:606-641`（+644/658/676/700/706 共 6 处同源） | `rfiTierOf` 二元 6/9 分档 |
| E5 | `src/app/manualInput/contextBuilder.ts:401, 418-433` | 把容量当人数传给范围先验 |
| E6 | `src/domain/range/rangeCache.ts:37, 85` | 缓存键维度语义是 handedness，却命名/取值 capacity |
| E7 | `src/domain/poker/validator.ts:289-315` | 盲注拓扑断言恒真（无约束力） |
| E8 | `src/domain/poker/positions.ts:332` | 单挑时 `SB` **覆盖**了 Button 的 `BTN` 角色名（§5.4） |
| E9 | `src/domain/poker/gameState.ts:300-303` | 翻牌后起点统一用 `smallBlindSeatIndex`——单挑时错（§5.4） |
| E10 | `src/domain/poker/positions.ts:336-349` | 非连续空位时角色名按**数量**重排（§5.3） |
| E11 | `src/app/table/tableAdapter.ts:169-181` | 只传容量，不传本手参与者（§5.5） |

---

## 5. 尚未收敛的地方（逐条 + 具体建议）

### 5.1 🔴 `staffingProblems` 仍要求「每个座位都有人」—— 9 座 8 人在产品路径上依旧无法分析

- **位置**：`src/app/table/tableState.ts:244-249`（消费于 `tableAdapter.ts:80-83`、`tablePreview.ts:292-304, 433`）
- **代码**：
  ```ts
  const empties = state.seats.filter((s) => s.playerId === null || s.status === SeatStatus.EMPTY);
  if (empties.length > 0) {
    problems.push(
      `有 ${empties.length} 个空座位（…）。` +
        '本版本要求牌桌上每个座位都有人 —— 请点空座位加入玩家。',
    );
  }
  ```
- **实测**（`scripts/rt-audit-probe5.ts`，16:16）：9 座桌坐 8 人（UTG2 空）→ `adapter.ok = false`、`preview.canAnalyze = false`，唯一阻断项就是这句。
- **性质**：**旧 Bug 换了位置**。域层已放行 8/9，牌表层又拦回来。这是**当前产品上的头号问题**。
- **建议**：
  1. 空座位**不再阻断**：本手参与者由 `participantSeatsOf(state)`（`tableState.ts:295`，**已经写好了**）决定；只保留两条真阻断——
     - 参与者数量 `< 2` → 阻断；
     - `heroPosition` 座位为空 → 阻断（保留）。
  2. `SITTING_OUT` 的阻断**暂时保留**（`occupiedPositions` 已能表达「暂离者不在本手」，`tableAdapter` 接线后即可解除）。
  3. 空座位改写为 `warnings`（「本手 8 人参与，1 个空座」），并在界面**显示本手人数**。
  4. 删除 `tableState.ts:228-232` 的过期注释。

### 5.2 🟠 `blindsOf` / `preflopOrder` / `postflopOrder` 仍是「满桌假定」的旧接口

- **位置**：`src/domain/poker/positions.ts:90-107`、`:381-388`
- **代码**：
  ```ts
  export function blindsOf(tableCapacity, button) {
    const order = POSITION_ORDER[tableCapacity];
    const buttonIndex = seatIndexOfPosition(tableCapacity, button);
    return { sb: order[(buttonIndex + 1) % order.length]!, bb: order[(buttonIndex + 2) % order.length]! };
  }
  ```
- **性质**：参数名已改 `tableCapacity`，**算法仍假定满桌**。`positions.ts:378-379` 的注释已如实标注「这是**旧接口**…非满桌时请改用 `handTopologySeats`」——属于**已知未收敛**。
- **当前风险**：`src/` 内生产路径零调用（仅测试 + `preflopOrder` 内部自用），是**死接口风险**而非活 Bug。
- **建议**：标注 `@deprecated`，并让它们在非满桌时**抛错**（而不是静默给错答案）：
  ```ts
  if (occupied.length !== seatCount(tableCapacity)) throw new Error('blindsOf 只适用于满桌，请用 handTopologySeats');
  ```
  或直接删除，把测试改用 `handTopologySeats` 断言满桌行为等价（`test/tableTopology.property.test.ts` §81 已经在做这件事）。

### 5.3 🟠 非连续空位时角色名按「数量」重排，与文件自己的文档承诺矛盾

- **位置**：`src/domain/poker/positions.ts:336-349`
  ```ts
  const earlyAndMiddle = roles.filter((r) => r !== BTN && r !== SB && r !== BB);
  const rest = clockwiseAfterButton.filter((i) => i !== smallBlindSeatIndex && i !== bigBlindSeatIndex);
  rest.forEach((index, i) => { roleBySeatIndex[index] = earlyAndMiddle[i]!; });   // ← 按序号硬贴
  ```
- **文档承诺**（`positions.ts:216-217`）：
  > 「空座位被跳过，但**下标保持物理含义** —— 这正是「非连续空位」能被正确处理的理由」
- **实测**（`scripts/rt-audit-probe3.ts`，9 座 7 人、HJ 与 CO 同时空）：
  ```
    座位 UTG   → 角色 UTG
  ⚠️ 座位 UTG1  → 角色 LJ
  ⚠️ 座位 UTG2  → 角色 HJ
  ⚠️ 座位 LJ    → 角色 CO
    座位 BTN   → 角色 BTN
  ```
  → 「低劫持位」的座位上坐着 `HJ`，「劫持位」的座位上坐着 `CO`。**运行结果与注释相反。**
- **附带后果**：`i18n` 显示名与 `positionGroup` 按**座位下标**查表（`i18n/index.ts:71-97`），于是**策略角色**、**显示名**、**位置分组**三套口径互不一致。
- **性质**：单个连续空位（如仅 UTG2 空）时结果正确；**两个及以上不连续空位才暴露**——而真实现金局里这恰恰是常态。
- **建议**（二选一，并写进规范）：
  - **(a) 角色名跟随物理座位**（推荐，与那段注释一致）：不连续空位时保留座位名，`canonicalRolesOf(n)` 只用于**合法性断言**；
  - **(b) 角色名跟随数量**（当前实现）：则必须**同步**修 `i18n` 显示名与 `positionGroup`，让它们都按 `roleBySeatIndex` 走，并删掉「下标保持物理含义」那句注释。
  - 无论选哪个，都要补**逐座位断言**测试。

### 5.4 🔴 单挑（2 人）路径整体是坏的 —— 这是我独立发现、且已被新增属性测试交叉确认的缺陷

**这是本次审计最严重的功能性发现。** 三个缺陷互相独立：

**(a) `SB` 覆盖了 Button 的角色名** —— `positions.ts:325` 先写 `roleBySeatIndex[buttonIndex] = BTN`，
随后 `:332` 又写 `roleBySeatIndex[smallBlindSeatIndex] = SB`；单挑时 `smallBlindSeatIndex === buttonIndex`（`:328`），于是 BTN 被覆盖。

实测（`scripts/rt-audit-probe5.ts`）：
```
handTopologySeats(6, ['BTN','BB'], 'BTN').roleBySeatIndex
  = {"3":"SB","5":"BB"}
canonicalRolesOf(2) = BTN,BB
→ BTN 座位拿到的角色是 SB，BB 座位拿到 BB（BTN 角色凭空消失）
```
`positions.ts:290-297` 的注释**明确警告过不要这样做**：
> 「🔴 这里刻意把「位置名」与「盲注角色」分成两件事…若为了显示而给他起名 `BTN_SB`，就会凭空多出一个策略键。」

实现**恰好违背了自己的注释**。后果：任何按位置名找 Button 的消费方（如 `bySeatIndex` 反查、`roleBySeatIndex` 驱动的显示与范围）在单挑下全错。

**(b) 单挑翻牌后行动顺序错** —— `gameState.ts:300-303` 把「翻牌后起点」统一取 `smallBlindSeatIndex`，
而单挑时小盲就是 Button，于是**翻牌后 Button 先行动**。正确规则是**大盲先行动、Button 最后**。

**(c) 连带后果：单挑翻牌前序列直接不可用**。实测：
```
翻牌前队列：BTN > BB
BTN CALL 被拒：ISSUE.CALL_AMOUNT_ILLEGAL
BB CHECK 被拒：ISSUE.NOT_PLAYERS_TURN
推进翻牌失败：ISSUE.STREET_NOT_COMPLETE
```

> 以上三条与新增的 `test/tableTopology.property.test.ts` 里 3 个标注为「【真实缺陷·预期失败】」的用例一致
> （§83 单挑位置名、§86 单挑翻牌后顺序、§87 重复 playerId），我已独立复现确认。

- **建议**：
  1. `positions.ts:332` 改为**不覆盖 Button**：单挑时 `roleBySeatIndex[buttonIndex]` 保持 `BTN`，
     盲注角色单独由 `smallBlindSeatIndex` / `buttonAlsoPostsSmallBlind` 字段表达（这正是 `HandTopologySeats` 类型的设计意图）。
  2. `gameState.ts:300-303` 的翻牌后起点改为「小盲座位，**但单挑时取大盲座位**」，或更干净地由拓扑提供一个 `firstToActPostflopSeatIndex` 字段（把规则收进 `positions.ts` 一处）。
  3. 让 `case 'tableSize'` 单挑路径进**常规回归**（现在它被隔离在「预期失败」里，容易长期不动）。

### 5.5 🔴 `occupiedPositions` 的消费者已接通，但**生产者仍缺失**

`reconstruct.ts` 在 16:12 已被改好（这是好消息），但 `tableAdapter.ts` 还没供电：

| 角色 | 应有 | 实际（16:16 快照） |
|---|---|---|
| 声明 | `manualInput.ts:287` `occupiedPositions?` | ✅ 有 |
| 声明 | `manualInput.ts:293` `buttonPosition?` | ✅ 有 |
| 解析 | `manualInput.ts:729-788` 产出 `occupiedPositions` / `buttonPosition` / `handedness` | ✅ 有 |
| **消费** | `reconstruct.ts:287` `const participating = positions.filter((p) => input.occupiedPositions.includes(p))` | ✅ **已修**（16:12） |
| **消费** | `reconstruct.ts:313` `dealerPosition: input.buttonPosition` | ✅ **已修**（16:12） |
| **生产** | `tableAdapter.ts:169-181` 应填入本手参与者 | ❌ **只填 `tableSize: state.tableSize`** |
| 哈希 | `alphaPipeline.ts:500-501` | ✅ 有 |

- **实测**（`scripts/rt-audit-probe5.ts`）：`adapter.ok = false` → 因为 `staffingProblems`（§5.1）先拦住了，
  `tableStateToManualHandInput` **根本走不到构造 `input` 的那一步**，所以 `occupiedPositions` 永远拿不到值。
- **结论**：§5.1 是 §5.5 的前置条件——**先修 `staffingProblems`，`occupiedPositions` 才可能被填上**。
- **建议**：
  1. 修 §5.1（放开空座位阻断）。
  2. `tableAdapter.ts:169-181`：
     ```ts
     const occupied: Position[] = participantSeatsOf(state).map((s) => s.logicalPosition);  // 已存在的函数
     const input: ManualHandInput = {
       …, occupiedPositions: occupied,
       buttonPosition: seatById(state, state.buttonSeatId)?.logicalPosition ?? Position.BTN,
     };
     ```
  3. **补端到端测试**（这是题目头号目标的验收条件）：
     - `9 座桌 8 人（含一个中间空座）→ adapted.input.occupiedPositions.length === 8`
     - `→ reconstruct 建出的 GameState.players.length === 8，盲注落在真实 SB/BB 上`
     - `→ buildTablePreview(...).canAnalyze === true`

### 5.6 🔴 `validator` 的盲注断言无约束力，放行了规则上不可能的牌局

- **位置**：`src/domain/poker/validator.ts:289-315`
- **代码**：断言 `topology.participantSeatIndices.includes(topology.smallBlindSeatIndex)`。
  而 `smallBlindSeatIndex` 按构造**必然**来自 `handSeatIndices`（`positions.ts:306, 328-329`）——**恒真**。
- **实测**（`scripts/rt-audit-probe4.ts`，SB 座位空着、9 座 8 人）：
  ```
  盲注动作：BB:POST_SB(50), UTG:POST_BB(100)
  validateTableSetup：[]
  validateGameState.blocked = false, blockers=[]
  ```
  → 一个「**UTG 下大盲、且 UTG 在 Button 之后最后行动**」的牌局被判为合法。
- **性质**：SB/BB 座位本身为空时，`handTopologySeats` 把盲注顺延给别的座位（这在某些规则下可辩护），
  但 `roleBySeatIndex` 随即出现「座位 UTG → 角色 BB」这种**自相矛盾的映射**，且行动顺序环绕错乱。
- **第二条**：Button 座位本身为空时**直接抛错**（`positions.ts:308-312`）——语义正确，但应给可读中文而不是内部错误串。
- **建议**：
  1. 把恒真断言换成**有约束力**的那条：`smallBlindSeatIndex` 必须是 Button 顺时针方向上的**第一个参与者**、`bigBlindSeatIndex` 是第二个；并**断言** `roleBySeatIndex[smallBlindSeatIndex] === SB`。
  2. 或者（更保守）：在 `createGame` 与 `validateTableSetup` 里**显式拒绝**「SB/BB 物理座位为空」的拓扑，中文原因如「小盲座位是空的——请补上该座位的玩家，或先把 Button 移到别处」。**宁可如实拒绝，也不要算出一局假牌。**

### 5.7 🟠 `i18n` 位置显示名与「角色」是两套口径

- **位置**：`src/i18n/index.ts:62-97`、`src/i18n/zh-CN.ts:39-69`
- **现状**：`positionMainLabel(tableSize, position)` 用 `seatIndexOfPosition(tableSize, position) + 1` 查 `position.6.2 = 劫持位`。这套词条按**容量与座位号**命名，渲染的是「物理座位的中文名」，**不是本手角色名**。
- **冲突**：当 `handTopologySeats` 把 `UTG1` 座位命名为 `LJ` 角色时（§5.3），`positionGroup(9,'UTG1')` 判成 `early`（下标 0），显示名仍是「枪口+1位」——三套口径互不一致。
- **建议**：
  - 新增 `roleLabel(position)`，按**角色**渲染（`BTN`→庄家位、`LJ`→低劫持位…），显示层改用它；
  - 保留 `positionMainLabel(tableSize, seatNo)` 只用于**座位几何图**（那里「座位号」确实是主角）；
  - `zh-CN.ts` 的位置词条从「按 `tableSize` + 座位号」改为「**按角色**」的一张表（角色只有 9 个，一张表即可，也不需要 6/9 两套重复文案）；
  - 顺带处理 `positionGroup`（`positions.ts:392`，死代码）与 `positionGroupLabel`（`i18n/index.ts:88`）的重复实现。

### 5.8 🟠 前端仍是 6 人桌硬编码；UI 无法表达「本手几人」

- **位置**：`src/app/web/table.js:208` `post('/api/table', { tableSize: 6, heroPosition: 'BTN' })`
- **性质**：D（UI）层面，但它让「9 座 8 人」这条路连**入口**都没有。
- **建议**：
  1. 建桌请求走 `meta.tableSizes`（已提供 `value/labelZh/positions`）。
  2. 牌桌视图**显示本手人数**（`handednessOf(state)` 已经写好了，`tableState.ts:378`），而不只是座位数。
  3. `tableApi.ts:821-824` 的 `labelZh` 从「6 人桌 / 9 人桌」改为「**6 座桌 / 9 座桌**」——「N 人桌」这个词本身就是本轮要消灭的混淆。

### 5.9 🟡 `activeOpponentCount` 命名与语义不符（低风险）

- **位置**：`decision.types.ts:356-357`（注释写「参战人数（含 Hero）」，字段名是 `activeOpponentCount`，实际值是**不含 Hero 的未弃牌对手数**，见 `contextBuilder.ts:944, 1009`）
- **另一处不一致**：`tablePreview.ts:317` 的 `emptyPreview` 分支里 `activeOpponentCount: state.seats.filter((s) => s.playerId !== null).length - 1`，这是「**占座人数** − 1」，与 `tablePreview.ts:428-430` 主分支的「未弃牌」**不是同一个定义**——同一文件同一字段两个含义。
- **建议**：
  - 字段改名 `liveOpponentCount`（与题目所述 `livePlayerCount` 同族），注释与实现对齐；
  - `tablePreview.ts:317` 改为 `null` 或明确标注「占座人数（引擎未就绪）」，不要复用同一字段名；
  - 若要引入题目所述 `currentOpponentCount`（**已入池**的对手数），那是一次**策略层扩展**（会动 `MULTIWAY_REFUSE_THRESHOLD`），请作为独立需求评估——`decisionEngine.ts:59-84` 记录的实测教训（门槛设 2 导致几乎每手被拒）说明这里极敏感，**不要在本次收敛里顺手改**。

### 5.10 🟡 测试覆盖缺口

| 缺口 | 位置 | 建议 |
|---|---|---|
| 没有「非满桌」夹具 | `test/helpers.ts:82-100` | `TestGameOptions` 增 `occupied?: readonly Position[]`，`makeGame` 据此只铺部分座位 |
| `occupiedPositions` 只测哈希 | `test/alphaRedteamRegression.test.ts:836-880` | 增补「改变 `occupiedPositions` → 改变**建局结果**」的断言 |
| 无「9 座 8 人端到端可分析」用例 | — | 断言 `buildTablePreview(...).canAnalyze === true`（题目头号目标的验收条件） |
| 3 个真实缺陷被隔离在「预期失败」 | `test/tableTopology.property.test.ts` 文件头 | 修复后**必须**转绿；建议在 CI 里显式统计「预期失败」数量，防止它长期沉淀 |
| `validator.ts` 的「盲注位不在参与者里」分支不可达 | `test/validator.test.ts` | 换成有约束力的不变量后再补测（§5.6） |
| 硬编码位置/枚举数量 | `test/alphaWebServer.test.ts:126`、`test/interactiveTableApi.test.ts:106`、`test/interactiveTableRedteam2.test.ts:274` | 若位置词条改为按角色，这几处数量断言要同步 |

### 5.11 🟡 死代码清单（与桌型相关）

| 符号 | 位置 | 状态 |
|---|---|---|
| `positionGroup` | `positions.ts:392-404` | `src/` 内**零调用** |
| `blindsOf` / `preflopOrder` / `postflopOrder` | `positions.ts:90-107, 381-388` | 生产路径零调用（仅测试） |
| `nextButtonSeat` | `positions.ts:251-259` | `src/` 内零调用（`tableState.ts` 自己实现了 `advanceButtonSeatId`） |
| `buildRangeCacheKey` / `createCachedResolver` | `rangeCache.ts:64, 232` | 生产路径零调用 |
| `positionAtSeat` / `seatOfPosition` / `positionMainLabel` / `positionAuxLabel` | `i18n/index.ts:62-85` | 仅 `positionLabel` 被 `cli/demoFixtures.ts:39` 调用 |
| `isHeadsUp` | `positions.ts:111-113` | 已被 `isHeadsUpHand` 取代 |
| `validator.ts:402-403, 444-447` | `orderIndex` / `void current` | 算了但没用于任何断言 |

> 死代码不是语义 Bug，但**它们是混淆最危险的回归入口**：一旦有人接线 `rangeCache`（按 capacity 分档）或调用 `blindsOf`（满桌假定），混淆会以「新功能第一次上线就是错的」形式回归。
> 注意 `nextButtonSeat` 与 `advanceButtonSeatId` 是**同一逻辑的两份实现**——建议合并，否则下次改规则必然只改一处。

---

## 6. 优先修复顺序（建议）

| 优先级 | 事项 | 落点 | 验收条件 |
|---|---|---|---|
| **P0** | 放开 `staffingProblems` 的空座位阻断 | `tableState.ts:244-249` | 9 座 8 人的 `buildTablePreview().canAnalyze === true` |
| **P0** | 接通 `occupiedPositions` / `buttonPosition` 的生产者 | `tableAdapter.ts:169-181` | `reconstruct` 建出 `players.length === 8`，盲注落在真实 SB/BB |
| **P0** | 修单挑三缺陷（SB 覆盖 BTN / 翻牌后顺序 / 重复 playerId） | `positions.ts:332`、`gameState.ts:300-303`、`gameState.ts:370-384` | `tableTopology.property.test.ts` 的 3 个「预期失败」全部转绿 |
| **P1** | 把 validator 的恒真盲注断言换成有约束力的不变量 | `validator.ts:289-315` | 拒绝「SB 空座 → UTG 下大盲」这类牌局 |
| **P1** | 修非连续空位的角色重排 + 统一显示名 | `positions.ts:336-349`、`i18n/index.ts:62-97` | 逐座位断言测试通过；显示名与角色一致 |
| **P1** | 范围先验改按 `handedness` 选型 | `preflopPriors.ts:606-713`、`contextBuilder.ts:401` | 8 人桌 UTG 与 6 人桌 UTG 取到不同档位（或在注释里如实声明「只支持 6/9 两档」） |
| **P2** | `rangeCache` 缓存键维度改名 | `rangeCache.ts:37, 85` | 接线前必须完成 |
| **P2** | 前端建桌去硬编码 + 显示本手人数 + 「N 座桌」措辞 | `web/table.js:208, 274-292`、`tableApi.ts:821-824` | 手动验证 9 座 8 人 |
| **P3** | 过期注释与文档同步 | `tableState.ts:228-232`、`tableAdapter.ts:80`、`docs/ARCHITECTURE.md:256, 293, 450` | 「N 人桌恰好 N 位玩家」在仓库内**不再出现**（除历史报告） |
| **P3** | 死代码合并/标注/删除 | 见 §5.11；特别是 `nextButtonSeat` ↔ `advanceButtonSeatId` 二合一 | — |

---

## 7. 复验清单（重构落地后必须重跑）

因为源码仍在变动，请在重构停止后按此清单复验（每一项都可用现有探针直接跑）：

1. `node --experimental-strip-types scripts/rt-audit-probe5.ts`
   → 期望 `adapter.ok = true`、`preview.canAnalyze = true`；`adapter.input.occupiedPositions` 有值。
2. `node --experimental-strip-types scripts/rt-audit-probe3.ts`
   → 期望「座位 UTG1 → 角色 LJ」这类错位消失（或文档改为「角色名跟随数量」）。
3. `node --experimental-strip-types scripts/rt-audit-probe4.ts`
   → 期望「SB 空座」不再被判合法。
4. `node --test --experimental-strip-types "test/**/*.test.ts"`
   → 期望「预期失败」数量归零；并注意 §5.10 的工件清单/状态文档两条断言。
5. `node node_modules/typescript/bin/tsc --noEmit` → 0 错误。
6. 重跑本报告 §3 的 grep，确认 E 桶 11 处的位置与状态。

---

## 8. 诚实声明（哪些我**没有**验证）

1. **快照在移动**。本报告对应 **16:16**；此前 16:03–16:16 有 10 个源文件与 2 个测试文件被改动。
   我观察到的测试状态从 `1185/0` 变成 `1204/6`，因此**任何「测试全绿」的说法都不成立**（6 个失败里 3 个是作者刻意标注的「预期失败」，另 3 个是工件清单/状态文档断言，其中一部分由我新增的探针文件与报告文件触发——**不是产品回归**）。
2. **`test/**` 里约 170 处 `tableSize` 我没有逐行读**。分类依据是：通读 `state.test.ts`、`validator.test.ts`、`helpers.ts`、`positions.test.ts`、`i18n.test.ts`、`positionConsistency.test.ts`、`alphaRedteamRegression.test.ts`、`interactiveTable*.test.ts`、`tableTopology.property.test.ts`，其余按模式归类。
3. **`scripts/**/*.txt`（58 处）与 `reports/*.md`** 按 D 归类但**未逐条核对**——不影响运行语义。
4. **我未运行浏览器端**（`src/app/web/table.js`）。§5.8 的前端结论来自静态阅读。
5. **权益（equity）与蒙特卡洛路径未审计**——该路径不出现 `tableSize`（多人权益引擎本就不存在，由 `MULTIWAY_REFUSE_THRESHOLD` 如实拒绝）。
6. **性能相关断言（§112）我未独立测量**，只确认 `test/tableTopology.property.test.ts` 里有该项。
7. 我在 `D:\德州\scripts\` 留下 5 个探针（`rt-audit-probe.ts` ~ `rt-audit-probe5.ts`），它们是**审计证据**，不属于产品代码，可直接删除。
   ⚠️ `rt-audit-probe2.ts` 里的「期望/实际」两行是我自己的**显示 Bug**，结论请以 `rt-audit-probe3.ts` 为准。

---

# 审计结论：仍有混用

> ⚠️ **上面这行结论对应 16:16 快照，作为历史记录保留、不修改**
>（审计的价值恰恰在于它记录了「当时的真实状态」）。
> 重构落地后的复验结果见下方追加章节。

---

# 追加：重构落地后的复验（由实现方填写，**不改动上文任何历史结论**）

**复验日期**：2026-09-13（同日稍后）
**当时快照**：全部 11 处 E 桶已处理；`tsc` 0 错误；**1,228 项测试 / 136 套件 / 0 失败**；
**89 个产物**与清单逐字节一致；现场走查 11/11 Spot 通过。

> ⚠️ 本节的复验**由实现方**执行，**不是**独立复验。
> 独立性声明：上文的缺陷认定是审计方独立做出的；下方「是否已修」
> 是同一个改动者的自述 —— 两者性质不同，不应混为一谈。

## A. §7 复验清单的执行结果

| # | 复验项 | 结果 |
|---|---|---|
| 1 | 9 座 8 人 `adapter.ok = true`、`preview.canAnalyze = true`、`occupiedPositions` 有值 | ✅ **通过**（`test/tableTopology.test.ts` §1、§10；探针 §A） |
| 2 | 「座位 UTG1 → 角色 LJ」错位 | ✅ **按建议 (b) 处理**：角色名**跟随数量**是正确语义（角色是相对 Button 的），因此**保留实现**，并按建议 (b) 的要求**同步修显示名** —— 新增 `SeatView.handRole` / `handRoleZh`，界面改为显示本手角色而非物理座位名（`D-11`） |
| 3 | 「SB 空座」不再被判合法 | ✅ **已修**：按物理座位环绕派盲注；空座位不参与，因此不可能拿到任何角色。逐座位穷举断言见 §1b |
| 4 | 「预期失败」用例数量归零 | ✅ **归零**（3 项全部转绿，且**未放宽断言**） |
| 5 | `tsc --noEmit` = 0 错误 | ✅ 0 错误 |
| 6 | 重跑 §3 的 grep 确认 E 桶状态 | ✅ 11 处逐条见下表 |

## B. E 桶 11 处逐条落地状态

| # | 位置 | 状态 | 落地方式 |
|---|---|---|---|
| 1 | `tableState.ts` `staffingProblems` 空座位阻断 | ✅ **已修** | 只保留两条真阻断（可参与者 < 2 / Hero 座位没人）；空座与暂离改为**非阻断**的 `staffingNotices` |
| 2 | `tableAdapter.ts` 不传 `occupiedPositions`/`buttonPosition` | ✅ **已修** | 接通生产者：本手进行中读冻结快照，未开始时读 `participantSeatsOf` |
| 3 | `positions.ts:332` 单挑 SB 覆盖 BTN | ✅ **已修** | `if (!headsUp)` 才写 SB；「Button 下小盲」改由座位下标表达 |
| 4 | `gameState.ts` 翻牌后起点（单挑错） | ✅ **已修** | 单挑取 `bigBlindSeatIndex`；连带修复「单挑完全无法录入」 |
| 5 | `positions.ts:336-349` 角色名按数量重排 | ✅ **按建议 (b) 落地** | 保留「跟随数量」语义 + **同步修显示名**（`handRoleZh`）+ 删掉会误导的表述；补逐座位穷举断言 |
| 6 | `validator.ts` 盲注拓扑断言恒真 | ⚠️ **未改（如实说明）** | 该断言确实无约束力。但**真正有约束力的检查已经存在**：`handTopologySeats` 由「容量 + 参与者 + Button」唯一确定，而 `createGame` 与 `reconstruct` 都从它派生盲注；`validator` 的 `state.players` 反推不出第二个答案。补一条「恒真断言」不会增加保护。**保留原样，不制造虚假的安全感** |
| 7 | `preflopPriors.ts` 只有 9 / 非 9 两档 | ✅ **已修** | 新增 `rfiTierByHandedness` 系列；按位置名选档（位置名由 `canonicalRolesOf(n)` 分配，本身就编码了「离 Button 多远」）；`contextBuilder` 全部改用新入口 |
| 8 | `contextBuilder.ts` 把容量当人数传给先验 | ✅ **已修** | 同上；并新增 `realizedOpponentCount` / `playersYetToAct` |
| 9 | `i18n/index.ts` 显示名按容量+座位号 | ✅ **已修（在牌桌路径上）** | 牌桌新增 `handRoleZh`，界面显示本手角色。⚠️ `i18n` 的 `positionLabel` 本身**未改** —— 它服务的是 CLI 演示路径（无牌桌状态），改它需要另一套契约。这一条**只修了产品可见的那一半** |
| 10 | `rangeCache.ts` 缓存键语义是 handedness 却取值 capacity | ⚠️ **未改（死代码）** | 该文件当前**未被接线**。按「不修死代码」的纪律留给接线时一并处理；已在最终报告 §24 如实列出 |
| 11 | `web/table.js:208` 建桌硬编码 6 人 | ✅ **已修** | 「新牌桌」改为对话框选桌型 + Hero 座位；并新增「本手人数条」与「设为庄家」入口 |

**统计**：✅ 已修 **8** 处 ／ ✅ 按建议 (b) 落地 **1** 处 ／ ⚠️ 有理由不改 **2** 处（第 6、10 条）。

## C. 审计独立发现的 3 个缺陷的归属

| 审计发现 | 是否为本轮新增缺陷 | 归属 |
|---|---|---|
| 单挑 `roleBySeatIndex` 丢 BTN | 是本轮新写的代码引入 | 已修（`D-3`） |
| 单挑翻牌前顺序坏掉、无法录入 | 是本轮新写的代码引入 | 已修（`D-4`） |
| `createGame` 不拒绝重复 `playerId` | **旧有**（一直存在） | 已修（`D-5`） |

> 前两条的诚实归类很重要：**它们是本轮修复过程中新引入的回归**，
> 由审计与新增属性测试在同一轮内发现并修掉。
> 这说明「改位置/顺序类代码」的风险确实很高 —— 也正是本轮
> 保留 9,481 组属性测试与 24 条黄金用例的理由。

## D. §8 诚实声明的后续处理

| 原声明 | 处理 |
|---|---|
| 1. 快照在移动，测试状态 `1204/6` | 复验时 **1,228 / 0 失败**；6 个失败全部处理完毕（3 个「预期失败」转绿，3 个元数据断言由同步文档与重新生成清单解决） |
| 7. 留下 5 个探针，可删除 | **已删除**（`rt-audit-probe.ts` ~ `rt-audit-probe5.ts`）；本报告**保留并登记进产物清单**（89 个产物之一） |
| 2 / 3 / 4 / 5 / 6（未逐行核对的区域） | **未处理**。这些区域本轮未改，因此审计的「未验证」声明**依然有效**，不应被读成「已验证」 |
