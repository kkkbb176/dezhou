# 玩家档案系统 · 阶段一现状审计与根因定位

> **本轮范围**：只做审计与根因定位（用户明确要求「先完成现状审计与根因定位，再按最小改动分阶段实现」）。
> **本轮未修改任何生产代码**：未改 UI、未改 op、未改存储、未改决策链。
> 未破坏既有玩家历史、求解器缓存与未提交代码。

生成日期：2026-09-24（Asia/Shanghai）

---

## 一、版本保护（已核对）

| 项 | 值 |
|---|---|
| 分支 | `codex/fast-input-decision-v2`（**未切换**） |
| HEAD | `514a6eac5bde5c66a7164ff8c11032390d81727a`（**未移动**） |
| `git stash list` | 空 |
| `data/player-history.jsonl` | 与基线备份 **SHA-256 逐位相同**（967 条记录，未被覆盖/虚构） |
| `data/gto-cache/index.json` | 与基线备份 **SHA-256 逐位相同**（未被覆盖） |
| 未提交改动 | 全部保留（KQ 阶段一/二 的代码、测试、报告 23 项） |

---

## 二、已有能力盘点（**必须复用，不得重复造轮子**）

| 能力 | 位置 | 状态 |
|---|---|---|
| 稳定身份 `playerId` | `table.types.ts` 的 `ADD_PLAYER{playerId?}`；座位 `playerId` 字段 | ✅ 已实现，且**不以名称为主键** |
| 同名不合并 | `listKnownPlayers` 的 `duplicateName` 标记（`playerHistory.ts:523-547`） | ✅ 已实现 |
| 按名称/身份搜索 | `GET /api/table/players?q=`（`webServer.ts:473`） | ✅ 已实现 |
| 选人弹窗 | `table.js:2151 openPlayerPicker(seat)`（含搜索框 + 「新玩家名称」输入框） | ⚠️ 存在但**只在空座位可达** |
| 玩家历史持久化 | `playerHistory.ts`：`appendObservations` / `revertObservations` / `loadObservations`（原子写 `renameSync`） | ✅ 已实现且可靠 |
| 统计推导 | `statsFromRecords`（逐项 successes/opportunities） | ✅ 已实现 |
| 撤销/修正 | `revertObservations` + `historyLength` 回退判据 | ✅ 已实现 |
| 重复提交去重 | `applyUserOpWithHistory` + 牌桌 `revision` 契约 | ✅ 已实现 |
| 画像 → 范围/响应层 | `facingBetProfile.ts`、`resolvePlayerProfile`、`observedStats.ts` | ✅ 已实现（本轮前序已审计） |
| 画像参与决策 | 实测：VPIP/PFR 经维度通道、`flopCheckRaise` 经分街条目通道进入响应层 | ✅ 已接通（见前序报告 §六） |

**结论：底座相当完整。本轮**不需要**引入新组件。**

---

## 三、根因定位：**为什么玩家名称无法正常输入**

### 根因 1（主因）：**占用座位后，头像面板里根本没有名称输入框**

`table.js:2290-2367` 的「已占用座位」面板按顺序渲染：

1. `realBox` —— 真实历史画像（只读）
2. `快速画像` 按钮行（`SET_PROFILE`）
3. `近期观察` 按钮行（`SET_DYNAMIC_HINT`）
4. `appendStackEditor`（筹码）
5. Hero ⇒ `return`
6. `座位管理`（设为庄家 / 清空座位 / 更换玩家 等）

**全程没有任何 `input`，没有任何 `RENAME` 动作。** 也就是说：用户点击某位玩家的头像时，
**在结构上不可能输入或修改他的名字**。这正是「人物画像已经有了，但名称无法输入」的直接原因。

### 根因 2：**全系统不存在任何改名能力**

| 检查项 | 结果 |
|---|---|
| `TableOp` 的 23 种操作 | `ACT / ADD_PLAYER / CLEAR_ALL_VILLAINS / CLEAR_BOARD / CLEAR_HERO_CARDS / CLEAR_SEAT / FILL_EMPTY_SEATS / NEW_TABLE / NEXT_HAND / REPLACE_PLAYER / RESET_HAND / SET_BOARD_CARD / SET_BUTTON / SET_DYNAMIC_HINT / SET_ENVIRONMENT / SET_HERO_CARD / SET_HERO_POSITION / SET_PROFILE / SET_STACK / SET_TABLE_SIZE / SIT_IN / SIT_OUT / UNDO` —— **没有任何 RENAME / 别名 操作** |
| `playerHistory.ts` 的导出 | `loadObservations / appendObservations / revertObservations / statsFromRecords / statsNoteByZh / findPlayersByName / listKnownPlayers / handIdOf / deriveObservations / applyUserOpWithHistory` —— **没有改名函数** |

`displayName` 只在 `ADD_PLAYER` 那一刻写入一次，**此后永久冻结**。

### 根因 3：**空座位的新建路径也不提示名称**

`table.js:2261-2270`（空座位面板）：

- 「加入玩家」→ `sendOp({ kind: 'ADD_PLAYER', seatId })` —— **不带 `displayName`**，
  于是玩家以默认名（后端生成「玩家N」）入座，**用户没有任何机会输入名称**；
- 只有点「选择历史玩家…」才进入带名称输入框的 picker。

⇒ 最常见路径（点空位 → 加入玩家）**绕过了唯一的名称输入框**。

### 根因 4（设计层，决定了修法）：**名称是从「行动事件流」派生的，不能靠追加事件改名**

`playerHistory.ts:494-496`：

```ts
const displayName =
  [...records].reverse().find((r) => r.playerId === playerId && typeof r.displayName === 'string')?.displayName
  ?? playerId;
```

即：**显示名 = 该 playerId 最新一条观察记录里的 `displayName`**，兜底为 `playerId`。

而 `statsFromRecords(records, playerId)` 用**同一批记录**推出 `handsObserved` /
`successes` / `opportunities`。⇒ **往事件流里追加一条「只为改名」的记录会污染统计**
（例如把改名记录计进手数/机会数）。

**因此改名绝不能走「追加一条记录」这条路。** 这是一条硬约束，直接决定了最小改动的形状。

---

## 四、最小必要改动方案（阶段二实施蓝图）

### 4.1 新增独立「档案层」，与行动事件流**物理分离**

新增 `data/player-profiles.jsonl`（或等价的最小存储），**按 `playerId` 为键**，只存身份元数据：

```ts
{ playerId, displayName, aliases: string[], noteZh, updatedAt, mode: 'REAL' }
```

- **身份仍是 `playerId`**（不可变，符合要求）；
- **行动事件流一字不动** ⇒ 统计不可能被改名污染（解决根因 4）；
- 显示名解析优先级：**档案层 `displayName` > 事件流派生名 > `playerId`**；
- 搜索命中范围：`displayName` **或任意 `aliases`** ⇒ 满足「曾用名也能搜到」；
- 改名时把**旧名压入 `aliases`**（去重）⇒ 满足「原名称作为历史别名保存」。

### 4.2 新增最小 op 与 API

| 新增 | 内容 |
|---|---|
| `SET_PLAYER_NAME` op | `{ kind, seatId, displayName }` —— 只改档案层，**不触碰事件流、不触发重复计数** |
| `SET_PLAYER_NOTE` op（可选） | `{ kind, seatId, noteZh }` |
| `GET /api/table/players` | 返回增加 `aliases` 与 `noteZh`（向后兼容，纯新增字段） |

### 4.3 UI 最小改动（不重做 UI）

1. **已占用座位面板**顶部加一行：`名称输入框 + 「保存名称」按钮`（走 `SET_PLAYER_NAME`）；
2. **空座位面板**的「加入玩家」改为**先弹名称输入**（或直接把 picker 的名称框前置），
   确保最常见的入座路径能输入名称；
3. 保存失败必须显示**明确错误**（现有 `sendOp` 的 issues 通道已具备，复用它，不得假报成功）。

### 4.4 训练模式隔离（新增强制要求）—— 审计结论

要求「训练模式不得写入正式玩家历史」。**现有代码没有 mode 概念**：

| 检查 | 结果 |
|---|---|
| `ObservationRecord` 有 `mode` 字段吗 | **没有**（`playerHistory.ts:52-93` 只有 `source: 'USER_INPUT'`） |
| `ObservationRecord` 有 `sessionId` / 事件唯一 id 吗 | **没有** `sessionId`；有 `seq` / `baseRevision` / `historyLength` |
| 写入前有 mode 校验吗 | **没有**（`appendObservations` 不做 mode 判定） |

⇒ 强制要求列出的事项需要**新增**：`mode`（`REAL`/`TRAINING`）+ `sessionId` + 事件唯一 id，
并在**持久化服务与画像统计入口各做一次**写入校验（要求三.3 明确「禁止仅依靠前端隐藏按钮」）。

**这是本轮审计能给出的最重要结论之一：隔离必须落在写入端，而写入端现在完全没有这个概念。**

---

## 五、待确认/风险（不得当作已完成）

1. **`/api/table/players` 返回的 `vpip` / `pfr` 目前为空**（前序实测 9 名玩家该两字段皆空），
   即这两个统计**尚未接通**到真实历史读取 —— 属于「画像接入」的既有缺口，本轮未处理。
2. **真实玩家库最大仅 57 手**，且题目设定的「150 手 BB 画像」在库中**不存在**。
3. 训练模式隔离需要改动 `ObservationRecord` 形状 ⇒ **旧记录迁移**问题
   （要求四.7「旧版本档案须迁移兼容；迁移前备份」）。迁移方案本轮未设计完成。
4. 名称输入涉及**中文输入法组合态**：现有 `fast-input.js` 有 `compositionstart/end` 处理，
   新的名称输入框**必须复用同一处理**，否则中文名会「输不进去/半截提交」——
   这很可能也是用户所述「无法正常输入」的**叠加原因**，需在实施时用真实浏览器验证。

---

## 六、本轮结论

| 问题 | 结论 |
|---|---|
| 名称无法输入的真实原因 | **① 占用座位面板没有任何名称输入框；② 全系统无改名 op/函数；③ 空座位「加入玩家」不带名称绕过输入框；④ 名称派生自事件流派生值，不能靠追加事件改名** |
| 是否已有可靠实现可复用 | **是**：`playerId` 身份、同名不合并、搜索、持久化（原子写）、撤销/去重、画像→范围→EV 链路**全部已存在** |
| 是否需要新组件 | **不需要**。只需新增一个**极小的档案层**（按 playerId 存 displayName/aliases/note）+ 一个 op + UI 两处 |
| 最大风险 | 训练模式隔离需要 `mode`/`sessionId`/事件 id ⇒ 触碰 `ObservationRecord` 形状，涉及旧数据迁移 |
| 本轮是否实现了修复 | **没有**。本轮只做审计与根因定位（用户要求的第一步），**未改任何代码** |

---

## 七、下一步（阶段二最小改动，按序）

1. 新增档案层存储 + `SET_PLAYER_NAME` op + API 字段（纯新增，向后兼容）；
2. 显示名解析改为「档案层 > 事件流派生 > playerId」，搜索覆盖 `aliases`；
3. 已占用座位面板加名称输入框（含 IME 组合态处理）；空座位入座路径加名称输入；
4. 失败必须显式报错（复用 `sendOp` 的 issues 通道）；
5. 补测试：建档 → 记 10 手 → 改名 → 断言 `playerId` 不变、10 手历史保留、统计不变 → 重启后新旧名都能搜到；
6. 再做训练模式隔离（`mode`/`sessionId`/事件 id + 双端写入校验 + 旧数据迁移备份）。
