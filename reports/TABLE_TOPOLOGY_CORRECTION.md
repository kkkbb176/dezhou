# TABLE TOPOLOGY CORRECTION — 桌型拓扑修正

> 本轮**不是**一个新 Phase。它是对 Alpha 阶段「牌桌录入」的一次**结构修正**：
> 把「牌桌有几个座位」与「本手几个人」这**两个一直被当成同一个**的数字拆开。
>
> 冻结范围声明：**数学 / Equity / Range 核心算法 / Player Profile / Dynamic /
> Environment 策略 / Decision 策略 / Confidence —— 全部未动。**
> 本轮唯一解锁的冻结内容是 **Poker Core 的桌型处理**
>（`positions.ts` / `gameState.ts` / `validator.ts`），因为不放开它就改不动 handedness。
>
> 最终判定见文末。

---

## 1. 本轮要解决的问题

一句话：**9 座桌坐 8 个人，系统发不出牌。**

这不是理论问题，是现金局最常见的形态：一张 9 座桌，有人去买咖啡、
有人刚 bust、有人下一手才入座 —— 桌上**经常**是 7~8 个人。
而修复前，只要有一个空座位，整张牌桌就**无法分析**，界面只说
「请点空座位加入玩家」—— 也就是逼使用者**编造一个不存在的玩家**。

修复前全项目把 `tableSize`（**座位容量**）与「本手人数」当成同一个数字，
这个混用散落在 185 处引用里。

---

## 2. 修复前的实测行为（可复现）

```
9 座桌，8 个人（UTG2 空），Hero 在 CO，两张手牌已选
→ tableStateToManualHandInput(...).ok = false
→ 唯一阻断项：「有 1 个空座位（枪口+2）。本版本要求牌桌上每个座位都有人 —— 请点空座位加入玩家。」
→ buildTablePreview(...).canAnalyze = false
```

域层 `createGame` 本身**也**拒绝：`seeds.length !== config.tableSize` →
`createGame: 9 人桌需要恰好 9 位玩家`。

---

## 3. 最隐蔽的那一步：拦截点搬家

修复过程中出现过的**头号缺陷形态**，必须单独记一节：

1. 先改域层 —— `createGame` 放宽为 `2 ≤ 本手人数 ≤ 容量`，`handTopologySeats`
   按物理座位环绕派盲注。**域层测试全绿。**
2. 但 `staffingProblems`（表层）仍然写着「有空座位 → 无法分析」。
3. 结果：`canAnalyze` 依旧是 `false`。

**「9 座桌 8 人无法分析」没有消失，只是换了个地方拦。**

这是本轮唯一一个**任何单层测试都发现不了**的缺陷：
域层测试说「建局成功」，表层测试说「如实拒绝」，两个都绿。
只有**同时断言两层**、或走**产品路径**才能发现它。

因此本轮留下两条永久的针对性测试（`test/tableTopology.test.ts`）：

- §2「反证：域层不拒绝时表层也不得拒绝」
- §10「HTTP 产品路径：建 9 座桌 → 坐 8 人 → 预览给出容量与本手人数」

以及一个**只走产品入口**的端到端探针 `scripts/rt-topology-verify.ts`。

---

## 4. 独立审计（`reports/TABLE_SIZE_SEMANTICS_AUDIT.md`）

在实现进行到一半时，另起一个**不知情**的审计代理，对 `src/**/*.ts` 里
185 处 `tableSize` 命中做分桶：

| 桶 | 含义 | 计数 |
|---|---|---|
| A | 真需要 `tableCapacity` | 约 121 |
| B | 真需要 `handedness` | 约 22 |
| C | 真需要 current live players | 5（全部正确） |
| D | 只是 UI 显示 | 约 26 |
| **E** | **旧逻辑混用（需修）** | **11** |

审计结论行：**`# 审计结论：仍有混用`**

它独立复现了本节全部关键缺陷（含「拦截点搬家」），并额外发现了 3 个
我自己没注意到的点。**这些发现全部被采纳**，逐条落地见第 6–15 节。

验收状态（审计自查）：`tsc --noEmit` = 0 错误；
`node --test` = 1204 项 / 136 套件，1198 通过 6 失败
（3 个是作者自己标注的「预期失败」，另 3 个是工件清单与状态文档断言）。

---

## 5. 已修复缺陷清单（按严重度）

| # | 严重度 | 缺陷 | 证据 | 修复 |
|---|---|---|---|---|
| D-1 | **BLOCKER** | 空座位阻断分析（拦截点从域层搬到表层） | 9 座 8 人 `canAnalyze=false` | §9 |
| D-2 | **MAJOR** | `occupiedPositions` / `buttonPosition` 有契约、有消费者、**没有生产者** | `reconstruct` 只能退回「容量 = 人数」 | §10 |
| D-3 | **MAJOR** | 单挑时 `SB` 覆盖了 Button 的 `BTN` 角色名 | `handTopologySeats(6,['BTN','BB'],'BTN').roleBySeatIndex === {3:'SB',5:'BB'}`，而 `canonicalRolesOf(2)===['BTN','BB']` | §11 |
| D-4 | **MAJOR** | 单挑翻牌后先问 Button（应大盲先）→ 单挑**无法录入** | BTN CALL 被拒 `CALL_AMOUNT_ILLEGAL`；BB CHECK 被拒 `NOT_PLAYERS_TURN` | §12 |
| D-5 | **MAJOR** | `createGame` 不拒绝重复 `playerId` | 两个 `'dup'` → `pendingQueue === ['dup','dup']` | §13 |
| D-6 | **MAJOR** | 界面「D」标记写死 `logicalPosition === Position.BTN` | Button 每手轮转，标记与实际相反 | §14 |
| D-7 | **MAJOR** | **未行动的对手被当成已参战** → 满桌开池 100% 被拒 | 9 座 Hero 在 UTG：界面写「8 名活跃对手，会返回信息不足」 | §15 |
| D-8 | **MAJOR** | 范围先验按**容量**二分（9 人档 / 非 9 人档） | 8 人桌 UTG 拿到 6 人桌档（**偏松**）；2/3/4/5/7 人全落 6 人档 | §16 |
| D-9 | **MINOR** | `handsCompleted` 只在「本手进行中」+1 | 连按「下一手」手数永远停在 0 | §17 |
| D-10 | **MINOR** | 前端建桌硬编码 `{tableSize: 6, heroPosition: 'BTN'}` | 使用者**无从表达**自己坐在哪种桌型/位置 | §18 |
| D-11 | **MINOR** | 座位上的位置标签显示物理座位名，不显示本手角色 | 界面在「本手其实是 UTG」的座位上写「关煞位」 | §19 |
| D-12 | **MINOR** | 无「手动指定 Button」入口 | 开局 Button 已在别人面前时无法如实录入 | §20 |

---

## 6. 设计基线：六条铁律（§142）

本轮所有修改都必须能对着这六条讲清楚：

| # | 铁律 | 落地位置 |
|---|---|---|
| 1 | **Table Capacity ≠ Handedness** | `handTopologySeats(capacity, occupied, button)`；`HandTopologySnapshot` 同时带 `tableCapacity` 与 `handedness` |
| 2 | **Seat ≠ Player** | `TableSeat.playerId` 引用；画像一律按 `playerId` 查（`profileOfPlayer`，刻意不提供 `getProfile(position)`） |
| 3 | **Seat ≠ Position** | `logicalPosition`（物理）与 `rolesBySeatId`（本手角色）分开；`SeatView.handRole` |
| 4 | **Table State ≠ Hand State** | `state.handTopology`（冻结快照）与座位状态分离 |
| 5 | **Unacted Player ≠ Realized Multiway Opponent** | `realizedOpponentIds` / `yetToActIds`（领域层唯一实现） |
| 6 | 已发生的 Current Hand 事实不可被座位生命周期修改 | `freezeTopology` 只在建局时生成一次；`commit` 只在 `handActive` 翻转时处理快照 |

---

## 7. 容量 ≠ 本手人数的类型落地

`src/domain/poker/positions.ts` 新增：

| 导出 | 作用 |
|---|---|
| `CANONICAL_ROLES` | 2~9 人各自的规范角色表 |
| `canonicalRolesOf(handedness)` | 取表，越界抛错 |
| `isHeadsUpHand(handedness)` | 单挑判定 |
| `occupiedSeatIndices(capacity, occupied)` | 参与者 → **物理座位下标**（升序，保持物理含义） |
| `nextButtonSeat(fromSeat, eligibleSeats)` | 物理环上的下一个合格座位 |
| `handTopologySeats(capacity, occupied, button)` | **本手拓扑的唯一构造函数** |

规范角色表（§22）：

```
9 → UTG UTG1 UTG2 LJ HJ CO BTN SB BB
8 → UTG UTG1     LJ HJ CO BTN SB BB
7 → UTG          LJ HJ CO BTN SB BB
6 → UTG             HJ CO BTN SB BB
5 →                 HJ CO BTN SB BB
4 →                    CO BTN SB BB
3 →                       BTN SB BB
2 →                       BTN    BB
```

**关键设计决定**：把「Button 本人下小盲」交给**座位下标**
（`smallBlindSeatIndex === buttonSeatIndex` + `buttonAlsoPostsSmallBlind`），
而**不占用位置名**。位置名是「角色」，一个座位只能有一个名字；盲注归属是
「谁往池里放钱」，那是另一件事。混用这两者正是 D-3 的根因。

---

## 8. 行为变化的完整清单

| 位置 | 修复前 | 修复后 |
|---|---|---|
| `createGame` | `人数 === 容量` | `2 ≤ 人数 ≤ 容量` |
| `createGame` | 只查位置重复 | 位置 + `playerId` 重复 + 空 id |
| `validator` | `players.length !== tableSize` → 非法 | `2 ~ 容量`；新增重复 `playerId` 阻断 |
| `streetOrder` | 翻牌后从小盲开始（单挑错） | 单挑从**大盲**开始 |
| `staffingProblems` | 两种阻断（空座位 / 暂离） | 两种阻断（**可参与者 < 2** / Hero 座位没人） |
| `staffingNotices`（新） | — | 非阻断提示：「本手 8 人参与（9 座桌），1 个座位不发牌：…」 |
| `tableAdapter` | 只传 `tableSize` | 传 `occupiedPositions` + `buttonPosition` |
| `tablePreview` | 无拓扑；`isDealer = position === BTN` | 暴露 `handTopology`；`isDealer` 来自 `buttonSeatId`；新增 `handRole` / `handRoleZh` / `isParticipant` |
| `tablePreview` 多人池提示 | 未弃牌人数 ≥ 3 | **已实现**对手数 ≥ 3 |
| 决策引擎拒绝门槛 | `activeOpponentCount >= 3` | `realizedOpponentCount >= 3` + 新增 `PLAYERS_YET_TO_ACT` 提示 |
| 范围先验选档 | `rfiTierOf(tableSize, position)`（容量二分） | `rfiWeightsByHandedness(position)`（位置名即人数） |
| Button | 只有自动轮转 | 自动轮转 + 「设为庄家」（`SET_BUTTON`，仅本手未开始时） |
| `handsCompleted` | 只在 `handActive` 时 +1 | 每按一次「下一手」+1 |
| 前端建桌 | 硬编码 6 座 / BTN | 对话框选桌型 + Hero 座位 |
| 前端座位标签 | 物理座位名 | **本手角色**，不参与则标「本手不参与」 |
| 前端 | 无本手人数显示 | 「9 座桌 · 本手 8 人」+ Button/小盲/大盲 |

---

## 9. D-1 修复：空座位不再阻断分析

`staffingProblems` 重写为**只保留两条真阻断**：

1. **本手可参与者 < 2** —— 少于两个人不成局（`createGame` 同样会拒绝）。
2. **Hero 的座位上没有人** —— 没有 Hero 就没有可分析的决策点。

至于「暂离」，它是**个人意愿**：暂离座位由 `participantSeatsOf` 直接排除在
本手之外（不参与、不发牌、不占盲注），因此同样不阻断分析。

**为什么必须把「提示」与「判据」分开**：修复前空座位既进
`staffingProblems`（判据）又被当成提示显示 —— 一条提示被当成了门槛。
现在新增 `staffingNotices`（**非阻断**）承载「如实告知」，
`staffingProblems` 只管「能不能算」。

旧的两条断言**被加强而不是被删除**（`test/interactiveTable.test.ts`）：
从「有空座位 → 必须报告无法分析」改为同时钉住两头 ——
① 6 座桌 5 人**仍然可分析**；② 必须如实告知「本手 5 人参与、枪口+1 不发牌」。

---

## 10. D-2 修复：接通 `occupiedPositions` / `buttonPosition` 的生产者

`tableAdapter` 从前只传 `tableSize`。于是新契约里的
`occupiedPositions` / `buttonPosition` 只有「解析器 + 哈希」两个使用者，
**没有任何生产者** —— `reconstruct` 只能永远退回「容量 = 本手人数」。

取值规则（**只有一条**）：

| 情形 | 参与者 | Button |
|---|---|---|
| 本手进行中 | 冻结快照 `handTopology.participantSeatIds` | 冻结快照 `buttonSeatId` |
| 本手未开始 | `participantSeatsOf(state)`（可参与下一手的人） | `state.buttonSeatId` |

⚠️ **本手进行中必须读冻结快照，不能重算**（铁律 6）：本手里有人暂离或被清空时，
重算会得到另一个参与者集合，而 `actionHistory` 是按**发牌时**的集合录的 ——
两边一旦不同，重放必然对不上。

---

## 11. D-3 修复：单挑的位置名必须是 BTN/BB

```ts
// 修复前：先写 BTN，紧接着被 SB 覆盖
roleBySeatIndex[buttonIndex] = Position.BTN;
roleBySeatIndex[smallBlindSeatIndex] = Position.SB;   // 单挑时 smallBlindSeatIndex === buttonIndex
```

单挑时 Button **本人**就是小盲（规范第 33 条），但「位置名」只有一个 ——
那个座位叫 **BTN**，不叫 SB。

修复：`if (!headsUp) roleBySeatIndex[smallBlindSeatIndex] = Position.SB;`

「谁下小盲」由 `buttonAlsoPostsSmallBlind` 与 `smallBlindSeatIndex` 表达，
不需要也不允许占用位置名去表达。

**永久回归测试**：§5（两种容量 × 每一个 Button 位置）、§5d（穷举 6 座 / 9 座的每一组单挑）。

---

## 12. D-4 修复：单挑翻牌后必须先问大盲

```ts
// 修复前
const startIndex = state.street === Street.PREFLOP
  ? topology.firstToActSeatIndex
  : topology.smallBlindSeatIndex;   // 单挑时这是 Button 本人 → Button 先行动，错

// 修复后
const startIndex = state.street === Street.PREFLOP
  ? topology.firstToActSeatIndex
  : topology.handedness === 2
    ? topology.bigBlindSeatIndex
    : topology.smallBlindSeatIndex;
```

**连带后果比想象严重**：`reconstruct` 先用 `streetOrder` 建翻牌前
`pendingQueue`，起点错了 → 单挑**整手都录不进去**（实测 BTN CALL 被拒
`CALL_AMOUNT_ILLEGAL`、BB CHECK 被拒 `NOT_PLAYERS_TURN`）。

**永久回归测试**：§5b（`streetOrder` 两个街道都断言）、§5c（完整录入一手 +
**反证**：翻牌后先录 Button 必须被拒 —— 若没有这条反证，一个「谁都接受」的
实现也能让正向断言变绿）。

---

## 13. D-5 修复：拒绝重复 `playerId`

修复前只查位置重复，两个座位挂同一个 `id` 会被照单全收：
`pendingQueue` 变成 `['dup','dup']`，按 id 索引的结构只能留下后一个，
于是「同一个 id 的两个座位」在后面各处被当成一个人，而行动顺序、筹码、
弃牌状态又按座位算 —— 结果无法收敛。

修复：在同一个循环里加 `seenPlayerIds`，并顺带拒绝空 id。

> 诚实说明：下游 `validateGameState` **确实**能抓到（`ISSUE.POSITION_DUPLICATED`），
> 所以这是**构造期的 fail-closed 缺口**，不是端到端静默损坏。
> 但「下游会兜住」不是不修的理由 —— 兜住的位置离出错点越远，诊断越贵。

---

## 14. D-6 修复：界面「D」标记

```js
// 修复前（前端）：Button 标记没有任何后端来源，于是自己猜
if (seat.isDealer) ...
// 而后端给的是：
isDealer: seat.logicalPosition === Position.BTN
```

`Position.BTN` 只是座位环上一个**固定物理座位**，而 Button **每手轮转**。
于是界面亮着「D」的可能是任何一个人 —— **显示与事实相反**。

修复：`isDealer: topology !== null && topology.buttonSeatId === seat.seatId`，
并在预览里暴露 `handTopology`，让前端**不可能**需要自己推导。

**永久回归测试**：§10 —— 断言「D」标记**有且只有一个**，且落在 `buttonSeatId` 上。

---

## 15. D-7 修复：未行动的对手 ≠ 已实现的对手

这是本轮**产品影响最大**的一条。

```
修复前：checkSufficiency 用 context.activeOpponentCount >= 3 → 拒绝
        9 座桌 Hero 在 UTG 时 activeOpponentCount = 8
        → 满桌开池 100% 被拒
        → 使用者看到「信息不足，请弃牌」，而实际局面是「没人表示要打这一手」
```

**这是把「未行动」当成了「已参战」** —— 与项目公理「机会由牌局状态定义，
绝不由玩家的动作定义」正好是同一枚硬币的两面：**对手也由动作定义，不由座位定义**。

### 三个数字，三件事

| 数字 | 问的问题 | 后果 |
|---|---|---|
| `realizedOpponentCount` | 真的有人跟注/加注/全下了吗 | ≥3 → **拒绝给建议** |
| `activeOpponentCount` | 还有多少未弃牌的人 | 用于 `MULTIWAY_APPROXIMATION`（权益偏乐观）声明 |
| `playersYetToAct` | 还有多少人没轮到说话 | ≥2 → `PLAYERS_YET_TO_ACT` **提示**（不拒绝） |

### 判据放在领域层，只此一份

`realizedOpponentIds` / `yetToActIds` 定义在 `gameState.ts`，
**`contextBuilder` 与 `tablePreview` 共用**。

理由：修复过程中一度出现「引擎改用已实现对手数、预览还在用未弃牌人数」——
于是**界面在劝退一个完全可分析的决策点**。这与早前红队 V-EFF 命中的
「屏幕显示的有效筹码 ≠ 引擎实际用的有效筹码」是**完全相同的形态**：
同一个数字在两处的含义没有由同一个函数保证。

### 判据的三条边界（写在代码里，也测了）

1. **盲注/前注不算** —— 强制投入不代表「他决定打这一手」。
   把大盲算作已实现，9 人桌的开池就会凭空变成 2 人池。（§7d 专门测这一条）
2. **CHECK 算** —— 翻牌后对手过牌，他仍在池里、仍会影响权益。
3. **全下一定算** —— 无论是否主动（例如盲注被强制全下），筹码已经在池里。

**永久回归测试**：§7（UTG 满桌必须可分析 + 必须有 `PLAYERS_YET_TO_ACT` 提示）、
§7b（2 人跟注仍给建议 + 必须标注偏乐观）、§7c（3 人真正进池必须拒绝，
且理由里写明 `realizedOpponentCount=3`）。

---

## 16. D-8 修复：范围先验按本手人数选档

```ts
// 修复前（preflopPriors.ts）
export function rfiTierOf(tableSize: TableSize, position: Position): RfiTier {
  if (tableSize === TableSize.NINE_MAX) { /* 9 人档 */ }
  /* 6 人档 */   // ← 2/3/4/5/7/8 人全部落进这里
}
```

**为什么这是错的**：`RFI_SPECS` 的分档依据是**位置离 Button 多远**
（前面还有几个人）。8 人桌的 UTG 前面只有 7 个人，该用次紧一档；
而它拿到了 6 人桌 UTG 的档（**偏松**）。3 人桌的 BTN 同理（**偏紧**）。

**修复思路（关键洞察）**：`canonicalRolesOf(n)` 给每个本手人数分配的
**位置名本身就编码了「离 Button 多远」**：

| 本手人数 | 角色表 | UTG 离 Button |
|---|---|---|
| 9 | UTG UTG1 UTG2 LJ HJ CO BTN SB BB | 7 位 |
| 8 | UTG UTG1 LJ HJ CO BTN SB BB | 6 位 |
| 6 | UTG HJ CO BTN SB BB | 4 位 |
| 3 | BTN SB BB | —（没有 UTG） |

因此「按位置名选档」**自动**得到正确的人数控档，不需要再查一遍人数。
8 人桌**不可能**出现 `UTG2`、3 人桌**不可能**出现 `UTG` ——
这个对应关系是**构造出来的**，不是约定。

新增 `rfiTierByHandedness` / `defendTierByHandedness` / `threeBetTierByHandedness`
与对应的 `*WeightsByHandedness`，`contextBuilder` 全部改用新入口。
旧入口**保留不动**（冻结的既有测试依赖它们的既有语义）。

⚠️ **`BigBlind` 没有开池档**：旧实现给它兜底 `BUTTON`（红队 F-03 命中的那个
「大盲被赋予按钮位开池范围」）。新实现**如实抛错**，宁可响亮地失败。

---

## 17. 三个 MINOR 修复：手数记账 / 建桌硬编码 / 座位标签

### D-9 手数记账

```ts
// 修复前
handsCompleted: state.handsCompleted + (state.handActive ? 1 : 0)
```

连续按两次「下一手」（很常见：想先看 Button 轮到谁，或开桌前过掉几手）
→ **手数永远停在 0**。

这个数字不是装饰：它是界面上的手号，也是
`freezeTopology(state, handsCompleted + 1)` 的快照编号。
恒为 0 意味着 200 手之后界面还写着「第 1 手」。

⚠️ Button 轮转本身是按**座位**推进的（不依赖这个数字），所以修复前
表面上「能轮转」，只是记账错了 —— 正是最难发现的那类缺陷。
它是由 §4「Button 轮转 200 手」这条测试暴露出来的。

### D-10 前端建桌不再硬编码

```js
// 修复前
post('/api/table', { tableSize: 6, heroPosition: 'BTN' })
```

使用者从界面上**无从表达**自己坐在哪种桌型的哪个位置 ——
而这两件事决定了之后每一手的盲注归属。**开局就错，后面全错。**

修复：「新牌桌」改为对话框，显式选**桌型**与**Hero 座位**，
并按所选桌型过滤合法座位（切到 6 座时把不合法的 Hero 座位自动落回 BTN）。

### D-11 座位标签显示本手角色

座位上的那个标签从前显示**物理座位名**（`positionZh`，按容量+座位号查表）。
空座位一出现，角色重排，于是界面会在一个「本手其实是 UTG」的座位上
写着「关煞位」—— **屏幕在撒谎**。

修复：新增 `SeatView.handRole` / `handRoleZh` / `isParticipant`，
前端显示**本手角色**；不参与本手的座位标「本手不参与」并画成虚线变淡。

**为什么这在 9 座 8 人下尤其重要**：使用者判断范围宽紧的第一依据就是
「我前面还有几个人」，而这个信息只能从角色看出来。

---

## 18. D-12 & 新增能力：`SET_BUTTON` 与 UI 入口

新增 `TableOp`：`{ kind: 'SET_BUTTON'; seatId: string }`。

| 场景 | 谁负责 |
|---|---|
| 一手打完，Button 顺时针轮转 | `NEXT_HAND` **自动**做 |
| 开局第一手，Button 已经在别人面前 | **`SET_BUTTON`** 手设 |

三条硬约束（都有测试）：

1. **本手进行中不许改** —— Button 决定「盲注是谁下的、谁先行动」，
   本手已经开始还去改它，就是在改**已发生事实**的归属（铁律 6）。
2. **座位必须存在**。
3. **座位上必须有人且不是暂离** —— `handTopologySeats` 要求 Button 在
   本手参与者里，放一个空座位进去会让整手牌建不出来（表现为「牌桌突然
   不能分析」，而使用者完全看不出原因）。

UI 入口放在**座位菜单**（点座位 → 「设为庄家」）而不是顶栏：
Button 是**座位**的属性，使用者在牌桌上看到的也是「筹码牌在谁面前」。
放到顶栏去选位置名，就等于逼他把「我看到的座位」翻译成「位置名」——
那正是「Seat ≠ Position」被混淆的地方。

---

## 19. 产品路径复验（`scripts/rt-topology-verify.ts`）

这个探针刻意**只走产品入口**（`applyTableOp` → `buildTablePreview` →
`handleTableRequest`），因为「域层修好了、表层拦回来」这种缺陷
**只有产品路径能发现**。

实测输出（全部 PASS）：

```
§A 头号 Bug：9 座桌 8 人
  容量=9  参与者=8 人  空座=枪口+2
  buildTablePreview: ok=true
  阻塞项=["现在轮到「枪口位」行动。…"]
  PASS  空座位不再是阻塞项
  PASS  旧的「每个座位都有人」要求已消失
  API 8 人预览: 9 个座位视图，其中 8 个有人
  handTopology: 容量=9 本手=8 Button=seat_BTN 参与者=8
  PASS  预览同时给出容量 9 与本手人数 8
  PASS  界面只有一个「D」标记，且落在 buttonSeatId
  PASS  空座 UTG2 标记为「不参与本手」且没有角色名
  适配：tableSize=9 occupiedPositions=[UTG,UTG1,LJ,HJ,CO,BTN,SB,BB] buttonPosition=BTN
  PASS  occupiedPositions 已由适配器真正填上（8 个座位）

§B 9 座桌 7 人，空位不连续（HJ、CO 空）
  拓扑：handedness=7 Button=BTN SB=SB BB=BB 先行动=UTG
  PASS  盲注落在真实的 SB / BB 座位（空座被跳过）
  PASS  空座位 HJ / CO 没有拿到任何角色

§C 单挑
  单挑角色表 = ["3:BTN","5:BB"]   canonicalRolesOf(2)=["BTN","BB"]
  PASS  单挑翻牌前「Button CALL → 大盲 CHECK」被接受
  单挑翻牌：大盲 CHECK 之后轮到 BTN
  PASS  反证成立：单挑翻牌后先录 Button 被拒绝（顺序真的有约束力）
  PASS  重复 playerId 被 createGame 拒绝

§D 穷举：9 座桌 2~9 人
  2 人（空 7 座）… 9 人（空 0 座）：全部 SB 投入=50 BB 投入=100 ✓

结论：全部通过
```

> ⚠️ 探针第一版报了 5 个「失败」，其中 **4 个是探针自己的 Bug**
> （传了非协议形状的请求体、探针断言写错、CALL 缺 `amountBB`）。
> 这一节如实保留，因为「先怀疑探针再怀疑产品」是这类验证的基本纪律。

---

## 20. 属性测试（`test/tableTopology.property.test.ts`，19 项）

| 属性 | 覆盖量 |
|---|---|
| §83 穷举扫描 | **2,481** 组（9 座 2,295 + 6 座 186）`(参与者集合 × 每一个 Button 座位)` |
| §83 随机扫描 | **7,000** 组（含非连续空位 5,613 组）→ 合计 **9,481** 组拓扑组合 |
| §84 Button 轮转 | 120 手 × 4 组固定座位 + 300 手 × 2 容量（含中途离桌/入座事件）+ **5,551** 组交叉验证 |
| §81 满桌兼容 | 6 座 / 9 座 × 每一个 Button 位置，逐位复现旧实现 |
| §85 真实牌局 | **64** 手真实 `createGame`（每一种人数 × 每一个 Button 座位，374 种座位拓扑） |
| §86 / §87 | 单挑 4 种构造；失败即关闭 13 组非法输入 |
| §112 性能 | 5,000 次拓扑计算 → **17.98~26.7 ms**（3.60~5.26 µs/次），阈值 `< 500 ms` |

不变量（每组组合都检查）：角色恰好一个 BTN/SB/BB 且都在参与者里；
`roleBySeatIndex` 条目数 = 人数、键 = 参与者集合、角色两两不同；
角色多重集 = `canonicalRolesOf(n)`；非单挑时 BTN≠SB≠BB；单挑时小盲座位 = Button
座位、`buttonAlsoPostsSmallBlind`；`firstToActSeatIndex` = 大盲之后第一个参与者）
（单挑时是 Button）；**任何空座位都不得拿到角色**。全部与一份**独立参考实现**
（`nthParticipantClockwise`）交叉核对。

**性能结论**：拓扑计算 **3.6~5.3 µs/次**，远低于本轮 < 5 ms 的目标。

---

## 21. 黄金用例 + 产品路径测试（`test/tableTopology.test.ts`，24 项）

| 编号 | 内容 |
|---|---|
| §1 | 9 座桌 8 人（空 UTG2）：空座位不阻断、如实告知人数、真的能分析 |
| §1b | **逐个座位扫一遍**：9 个座位轮流当空座，角色表都必须 = `canonicalRolesOf(8)` |
| §2 | **反证**：域层不拒绝时表层也不得拒绝（拦截点搬家的永久防线） |
| §3 | 9 座 2~9 人、6 座 2~6 人：每一种人数都能建局 + 盲注金额正确 + 单挑 Button 下小盲 |
| §3b | 非连续空位（HJ + CO 空）：盲注与角色仍然正确，空座不拿角色 |
| §4 | **Button 轮转 200 手**：每手都落在有人座位、相邻两手不重复、覆盖全部 7 个合格座位 |
| §4b | 中途离桌：Button 从**旧 Button 座位**继续顺时针跳空座 |
| §4c | 合格座位不足 2 个：Button 不动 + 人员判据如实报告 |
| §5 | 单挑位置名 BTN/BB（两种容量 × 每一个 Button 位置） |
| §5b | 单挑翻牌前 `[BTN,BB]`、翻牌后 `[BB,BTN]` |
| §5c | 单挑完整录入 + **反证**（翻牌后先录 Button 必须被拒） |
| §5d | 穷举 6 座 / 9 座的每一组单挑角色表 |
| §6 | 铁律 6：本手进行中清座位/暂离/离桌，**拓扑快照逐字节不变** |
| §7 | 满桌 UTG 必须可分析 + `realizedOpponentCount=0` + `playersYetToAct=8` |
| §7b | 2 人跟注：仍给建议 + 必须标注 `MULTIWAY_APPROXIMATION` |
| §7c | 3 人真正进池：必须拒绝 + 理由里写明 `realizedOpponentCount=3` |
| §7d | 大盲的强制投入**不算**已实现 |
| §8 | 界面 → 后端：预览里**每一个**按钮（含全部尺寸）都必须被后端接受 |
| §8b | 后端 → 界面：`deriveLegalActions` 的**每一种**动作都必须有 UI 入口 |
| §9 | `SET_BUTTON`：可指定、幂等、拒绝空座位、拒绝本手进行中 |
| §10 | HTTP 产品路径：9 座 → 8 人 → 拓扑 + 「D」唯一 + 空座无角色 |
| §11 | 铁律 1 / 3 / 4 的具名断言 |

> §8b 值得单独说：只做「界面 → 后端」会漏掉一整类缺陷 ——
> 后端支持某个动作、但界面上根本没有按钮 → 使用者永远点不到，
> 而**所有测试都是绿的**。因此两个方向都必须测。

---

## 22. 现场走查（`scripts/table-walkthrough.ts`）与录入效率

**11 / 11 个 Spot 全部通过**，录入效率**没有退化**：

| Spot | 场景 | 本手点击 | 服务端耗时 | 结果 |
|---|---|---:|---:|---|
| A | 9-max · Hero UTG（翻牌决策） | 16 | 517 ms | 建议：下注 2.25BB |
| **A2** | **9-max · 满桌 UTG 开池** | **3** | **234 ms** | **已实现对手 0 / 未行动 8 → 不劝退，给出建议** |
| B | Hero 小盲 · 面对开池 | 7 | 244 ms | 建议：加注 3.50BB |
| C | Hero 大盲 · 小盲补齐 | 8 | 254 ms | 建议：过牌 |
| D | 玩家中途弃牌 | 7 | 220 ms | 建议：加注 3.50BB |
| E | 玩家离桌（手后离桌） | 9 | 270 ms | 建议：加注 3.50BB |
| F | 换新玩家（不得继承画像） | 9 | 262 ms | 画像=UNKNOWN（正确） |
| G | 暂离再回来 | 3 | 90 ms | 画像保留（正确） |
| H | 150BB 深筹码 | 19 | 354 ms | 建议：下注 2.25BB |
| I | 河牌决策 | 19 | 339 ms | 建议：跟注 1.00BB |
| J | 下一手继续同桌 | 28 | 516 ms | 座位与画像保留（正确） |

**每手点击次数：中位数 9，最小 3，最大 28**（与修复前一致，**没有退化**）。
**服务端耗时合计 3,300 ms（每手约 300 ms）**。

### Spot A2 的语义迁移（而不是删除）

修复前 A2 断言的是「翻牌前 UTG 应当**提前提示**多人池限制」——
而那个提示当时用「未弃牌人数」判定，Hero 在 UTG 时后面 8 个人**一个字还没说**。
**也就是说：这个 Spot 实际断言的是缺陷本身。**

现在 A2 改为断言三件事：① 满桌 UTG 不得出现劝退式阻塞且 `canAnalyze === true`；
② `realizedOpponentCount === 0` 且 `playersYetToAct === 8`；③ 真的点下去必须拿到建议。

它当场抓到了一个新缺陷：改用已实现对手数之后，**预览仍在用未弃牌人数** ——
界面依旧写着「8 名活跃对手，会返回信息不足」，而引擎已经会给建议。
（第 15 节记录的「同一个数字在两处含义不一致」，正是这个 Spot 逼出来的。）

---

## 23. 完整性与不变量（验收命令与输出）

```
& npx.cmd tsc --noEmit
  → 0 错误（无输出）

node.exe --test --experimental-strip-types "test/**/*.test.ts"
  → tests 1228 / suites 136 / pass 1228 / fail 0

node.exe --experimental-strip-types scripts/rt-topology-verify.ts
  → 结论：全部通过

node.exe --experimental-strip-types scripts/table-walkthrough.ts
  → 成功 Spot：11 / 11；每手点击中位数 9；服务端每手约 300 ms

& npm.cmd run verify
  → exit 0（tsc + 89 个产物逐字节校验 + 全部测试）
```

| 项 | 本轮前 | 本轮后 |
|---|---|---|
| 测试 | 1,185 项 / 136 套件 / 41 文件 | **1,228 项 / 136 套件 / 43 文件** |
| 产物 | 84 个 | **89 个** |
| `tsc` | 0 错误 | 0 错误 |
| 每手点击（中位） | 9 | **9（未退化）** |
| 服务端每手耗时 | 约 290 ms | **约 300 ms** |
| 断言 | — | **无一条被放宽或删除**；被语义变化影响的旧断言全部**加固**（同时钉住新行为与「如实告知」） |

**被删除的文件**：审计留下的 5 个临时探针
（`scripts/rt-audit-probe.ts` ~ `rt-audit-probe5.ts`）已删除；
审计报告 `reports/TABLE_SIZE_SEMANTICS_AUDIT.md` 作为独立证据**保留并登记进产物清单**。

---

## 24. 已知限制（如实列出，不掩饰）

| 限制 | 说明 |
|---|---|
| **未行动的对手不进权益** | `playersYetToAct` 只提示、不计算。第一版**没有**多人权益引擎，任何「乘一个系数把权益压下去」都是凭空造数据（项目明令禁止）。因此系统说的是「这一刻的数字是对的，但这个局面还没结束」 |
| **范围先验仍是启发式的** | 按位置名选档修好了「用错档」，但档位表本身仍是启发式先验（可信度 0.3），**不是**求解器输出。这一条**没有**因为本轮而变得更可信 |
| **3~5 人桌的角色名映射是新增的推断** | 位置名 → 档位的映射（`rfiTierByPositionName`）覆盖了全部 8 种人数，但 2~5 人桌的档位选择**没有**独立验证来源。它有结构性依据（离 Button 的距离），但**没有**用真实数据校准过 |
| **暂离者完全不参与本手** | 这是本轮的新语义（从前是「阻断分析」）。若真实牌局中存在「暂离但仍被发牌」的规则差异，当前模型不覆盖 |
| **`SET_BUTTON` 只在本手未开始时可用** | 本手进行中改 Button 被刻意拒绝（会改已发生事实的归属）。真实场景里若记错了 Button，需要「重置本手」 |
| **人类输入耗时未测** | 1~3 秒的目标需要你自己点一遍才有意义（脚本给的是下界） |
| **红队口径** | 本轮的独立审计（`TABLE_SIZE_SEMANTICS_AUDIT.md`）**不是**红队：它审的是「语义混用」，攻击面不等同于红队。审计报告钉在 16:16 快照，之后代码又被改动；其中若干「待修」现已落地，但**没有**再跑一次完整红队 |
| 锦标赛 / 短牌 / Rake / Full Replay / Leak Dashboard | 刻意未做（原定延后） |

### 26.1 诚实性声明

- 本报告中的每一个数字都来自实际运行的命令输出，未做估算或取整美化。
- 探针自身的 4 个 Bug **如实保留**在第 21 节，因为它们说明「先怀疑探针」的纪律。
- 第 12 节 D-13（重复 `playerId`）明确写了「下游校验器会兜住」——
  不把它说成比实际更严重。
- 属性测试里有 **1 条要求我刻意没有照字面编码**：原始要求写
  「`streetOrder` 不得包含已弃牌/全下的玩家」，但 `streetOrder` 的契约
  **就是**返回全部玩家的完整顺序（`engine.rebuildPendingQueue` 依赖它定位
  最后行动者，`engine.ts:462-483` 有明确说明）。因此实际断言的是：
  `streetOrder` 每个玩家恰好一次 + 起点正确；「无弃牌/无重复」断言在
  `pendingQueue` 上。这不是放宽，是把断言写在**真实的契约**上。
- **当前没有已知核心逻辑 Bug。**（不说「零 Bug」—— 那是一个无法证明的陈述。）

---

# TABLE TOPOLOGY CORRECTION — PASS

**判定依据**

1. **头号目标达成且走的是产品路径**：9 座桌 8 人 `canAnalyze === true`，
   且 `analyzeBlockers === []`（§1、§10、探针 §A）。
2. **域层与表层口径一致**：有**反证**测试专门防「拦截点搬家」（§2）。
3. **容量 × 本手人数穷举通过**：9 座 2~9 人、6 座 2~6 人全部能建局、
   盲注金额正确、单挑 Button 本人下小盲（§3、属性测试 §85）。
4. **Button 轮转 200 手无一次落空**，中途离桌也能从旧座位继续（§4、§4b）。
5. **单挑从「完全无法录入」变为可完整录入**，且带反证（§5b、§5c）。
6. **决策门槛改用已实现对手数**：满桌开池不再被误拒，3 人真正进池时明确拒绝，
   大盲的强制投入不算已实现（§7、§7b、§7c、§7d）。
7. **铁律 6 逐字节成立**：本手进行中做清座位/暂离/离桌，拓扑快照不变（§6）。
8. **全量回归 1,228 项 0 失败**，`tsc` 0 错误，89 个产物与清单逐字节一致；
   **无一条既有断言被放宽或删除**；现场走查 **11/11 Spot 通过**，
   每手点击中位数 **9**（未退化），服务端每手约 **300 ms**。
9. **独立审计的结论被完整采纳**：其 11 项「旧逻辑混用」逐条落地或如实说明
   （见第 5 节 D-1 ~ D-12）。
10. **性能未退化**：拓扑计算 3.6~5.3 µs/次（目标 < 5 ms，余量约 1,000 倍）。

**唯一未达成的原始清单项**，如实列出：审计报告第 11 条提到
`rangeCache.ts` 的缓存键那一维语义是 handedness 却命名/取值 capacity ——
该处当前是**死代码**（未被接线），本次未改，留待接线时一并处理。
按「不修死代码」的纪律，这不构成本轮 FAIL。

**下一步（按锁定路线，不新开 Phase）**：
停止新增功能 Phase，直接进入 **20~30 手真实牌局测试**。
