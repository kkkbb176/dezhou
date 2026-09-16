# 交互式牌桌录入 —— 最终报告

> 判定见文末。本报告的所有数字都来自**可重跑的确定性命令**。
> 策略层一行未改（冻结模块清单见 §2）。

---

## 1. 新增文件

| 文件 | 行数 | 作用 |
|---|---:|---|
| `src/app/table/table.types.ts` | 322 | 座位状态 / 座位 / 玩家 / 牌桌状态 / 操作 / 预览结构 |
| `src/app/table/tableState.ts` | 268 | 建桌、**视觉旋转**、人员齐备判据、按 playerId 的画像查询 |
| `src/app/table/seatLifecycle.ts` | 1,246 | 座位生命周期 + 手牌公共牌 + 撤销 + 下一手 + 新牌桌 |
| `src/app/table/tableOps.ts` | 383 | 需要引擎参与的操作；`applyTableAction` 带**重放等价自检** |
| `src/app/table/tableAdapter.ts` | 253 | 牌桌状态 → `ManualHandInput` 的**唯一转换点** |
| `src/app/table/tablePreview.ts` | 486 | 后端权威预览（复用 reconstruct + legalActions + Poker Core 校验器） |
| `src/app/table/tableApi.ts` | 674 | 请求校验（Fail-Closed）+ **版本水位线** + 元数据 + 结果自校验 |
| `src/app/web/table.js` | 1,100 | 客户端（**零牌局规则**，纯渲染 + 转发意图） |
| `src/app/web/table.css` | 470 | 深色中性色牌桌样式（无动画 / 无音效 / 无头像） |
| `test/interactiveTable.test.ts` | 1,150 | 座位生命周期与三条铁律（22 项） |
| `test/interactiveTableDifferential.test.ts` | 470 | 差分：点选 vs 直接构造（5 项） |
| `test/interactiveTableApi.test.ts` | 400 | API / HTTP / 竞态 / 双击（14 项） |
| `test/interactiveTableRedteam.test.ts` | 520 | 红队第一轮永久回归（11 项） |
| `test/interactiveTableRedteam2.test.ts` | 590 | 红队第二轮永久回归（13 项） |
| `scripts/table-walkthrough.ts` | 420 | 现场走查 A–J（点击次数与服务端耗时证据） |
| `scripts/table-probe-buttons.ts` | 250 | 按钮合法性穷举 + 畸形载荷 HTTP 穷举 |
| `docs/TABLE_INPUT_USAGE.md` | 190 | 牌桌录入使用说明 |

> 行数为 `ReadAllLines` 计数的近似值（含注释与空行）。

---

## 2. 修改文件（**冻结模块一行未改**）

| 文件 | 改了什么 |
|---|---|
| `src/app/manualInput/manualInput.ts` | 新增可选 `seatStacksBB`（逐座位筹码）；**新增 `quickProfile` / `dynamicHint` 的枚举校验**（见 §16-T5） |
| `src/app/manualInput/reconstruct.ts` | 新增 `ReconstructMode.PREVIEW`（不要求轮到 Hero、自行定位街道）；逐座位筹码优先 |
| `src/app/alphaPipeline.ts` | `hashManualInput` 补齐 `seatStacksBB`（按位置排序后再序列化，消除键序不确定性） |
| `src/app/webServer.ts` | 新增 `GET /api/table/meta`、`POST /api/table`、静态资源；`/api/analyze` 接受 `{table}`；请求体上限 128KB → 1MB 且超限返回可读 413 |
| `src/app/web/index.html` | 由「键盘表单」改为牌桌骨架（容器 + 调试面板） |
| `docs/ALPHA_USAGE.md` | §2 标注界面已改为牌桌点选；保留**输入语义**说明（API 的 `{input}` 入口仍在使用） |
| `CURRENT_PROJECT_STATUS.md` / `reports/TEST_MATRIX.md` / `reports/STEP_REPORTS.md` | 数字同步与阶段记录 |
| `data/artifact-manifest.json` | 重新生成（77 个产物） |

**未修改**（按规范第 2 条禁止）：Poker Core（`engine.ts` / `gameState.ts` / `validator.ts` /
`odds.ts` / `positions.ts` / `handEval.ts` / `cards.ts` / `streetAdvance.ts`）、
Math、Equity、Range、Player Profile 算法、Dynamic 算法、Environment 策略、
Decision Engine 策略逻辑、Confidence 算法、Alpha Smoke 策略预期。

> 唯一对冻结层新增的**引用**是 `import { MULTIWAY_REFUSE_THRESHOLD } from decisionEngine`
> 与 `import { effectiveStackBetween } from odds` —— 都是**读**既有导出，
> 用来把后端已经判定的口径提前显示给使用者，不是重新实现策略。

---

## 3. Interactive Table 数据模型

```ts
TableSeat   { seatId, logicalPosition, visualIndex, playerId, status, sitOutNextHand, stackBB }
TablePlayer { playerId, displayName, quickProfile, dynamicHint, handsPlayed, isHero }
TableCore   { tableId, revision, tableSize, heroPosition, heroPlayerId, seats, playersById,
              heroCards, board, actionHistory, environment, bigBlindBB, defaultStackBB,
              handActive, nextPlayerNumber, lastHandRemainingStacksBB, notices, lastHandComplete }
PokerTableState = TableCore & { undo: readonly TableCore[] }   // 撤销快照不含它自己的撤销栈
```

- **座位状态 6 值**：`EMPTY` / `SEATED_ACTIVE` / `FOLDED_THIS_HAND` / `ALL_IN` / `SITTING_OUT` / `LEAVING_AFTER_HAND`
- **操作 21 种**：新建/下一手/重置本手、加入/清空/换人/暂离/入座/改筹码/改画像/改动态、
  清空其他玩家、改环境/桌型/Hero 位置、改手牌/公共牌、`ACT`、`UNDO`
- **单一状态源**：客户端只持有服务端返回的最后一个 `PokerTableState`；DOM 完全由它渲染
  （不存在 hidden input 里的第二份状态）

---

## 4. Seat 与 Player 如何分离

| 关注点 | 做法 |
|---|---|
| 存储 | `seats[]`（物理位置）与 `playersById`（真实身份）**分开存**，座位只持有 `playerId` 引用 |
| 画像查询 | **只有** `profileOfPlayer(state, playerId)`；刻意**不提供** `getProfile(position)` |
| 换人 | 必须新建 `playerId`；新玩家一律 `quickProfile='UNKNOWN'`、`dynamicHint='UNKNOWN'`、`handsPlayed=0` |
| 离桌后 | 玩家对象**保留在 `playersById` 里**（历史可追溯），但没有任何座位引用它 |
| 管线侧 id | 见 §16-T1：画像按牌桌 `playerId` 查，**传给管线的 id 用引擎口径 `seat_<位置>`** |

**CRITICAL 回归（§10 / §69）**：座位 4 上 A 是「跟注站 + 近期更激进」→ A 离开 → B 坐进来。
测试断言 B 的分析输入与「从未设置过画像的全新牌桌」**逐字节相同**（含 `inputHash`）。

---

## 5. Visual Position 与 Logical Position 如何分离

- 后端同时返回 `logicalPosition` 与 `visualIndex` / `angleDeg`；**前端不做任何换算**
  （它在结构上没有「视觉 → 逻辑」的代码）
- `visualSeatOrder = rotateAroundHero(logicalSeatOrder, heroPosition)` —— 纯函数，只被渲染使用
- `angleDeg`：**0° = 6 点钟（正下方）**，沿行动方向（屏幕上逆时针）增大
- 视觉序号在每次 Hero 换位/换桌型时统一重算（`reseatVisuals`）
- `parseTableState` **整体校验**视觉序号（不只是 Hero 那一格）

**§17 CRITICAL 回归**：Hero 在 UTG/CO/BTN/SB/BB 五种位置下，
`visualIndex === 0` 且 `logicalPosition` 逐位正确；翻牌前第一个行动的永远是 UTG。

---

## 6. Seat Lifecycle

| 操作 | 本手未开始 | 本手进行中 |
|---|---|---|
| 加入玩家 | 立即落座（新 id / 默认筹码 / UNKNOWN） | **拒绝**（`HAND_ACTIVE`）—— 不能中途进入当前手 |
| 清空座位 | 立即解绑（`playerId=null`，并清掉座位上的暂离标记） | **要求明确选择**（见 §7） |
| 更换玩家 | 新 id + UNKNOWN | **拒绝** |
| 暂时离座 | 立即 `SITTING_OUT` | **只设 `sitOutNextHand` 标记**，当前手完全不变 |
| 重新入座 | 恢复 `SEATED_ACTIVE` | 同左（也用于**取消**「下一手暂离」） |
| 编辑筹码 | 允许 | **拒绝**（会破坏筹码守恒）→ 请先「重置本手」 |
| 清空其他玩家 | 允许 | **拒绝** |
| 下一手 | 清手牌/公共牌/行动/弃牌全下状态；保留座位、画像、环境、Hero 位置 | 同左 |
| 新牌桌 | 清空所有非 Hero 座位与全部 Villain 画像/动态；Hero 设置、环境、默认筹码保留（**筹码全部重置为默认，包括 Hero，notice 明写**） | 同左 |
| 撤销 | 恢复**完整核心状态**（含座位绑定与玩家画像），不只是界面 | 同左 |

---

## 7. Mid-hand leave 处理

```
点「清空座位」（本手进行中）
  → 后端**拒绝**并回传 leaveDecision
  → 界面弹出选择（选项由后端决定，标签由后端元数据提供）：
       · 本手视为弃牌并离桌   ← 仅当**正轮到他行动**时提供
       · 仅标记手后离桌
       · 取消
```

- 选「仅标记手后离桌」→ `status = LEAVING_AFTER_HAND`，**保留绑定**；
  本手的底池、逐人投入、行动台账**逐位不变**
- 选「本手视为弃牌并离桌」→ 先由 `ACT` 走 Poker Core 记一次弃牌，再标记离桌
  （**绝不代替一个还没轮到的人弃牌** —— 那会伪造一条行动记录）
- 只有 `NEXT_HAND`（或 `RESET_HAND`）才真正把座位清空
- 处于 `LEAVING_AFTER_HAND` 的玩家**仍然要正常行动**（他还在这手牌里）

---

## 8. Replace Player 处理

`REPLACE_PLAYER` **必须**新建 `playerId`，并把新玩家的画像与动态一律置为 `UNKNOWN`。
旧玩家对象仍留在 `playersById` 里（可追溯），但**没有任何座位引用它**。
本手进行中禁止换人。

---

## 9. Sitting Out 处理

| 情形 | 行为 |
|---|---|
| 本手未开始 | 立即 `SITTING_OUT`：不参与发牌，画像保留；**该状态无法分析**（见 §24） |
| 本手进行中 | 只设 `sitOutNextHand`，座位仍是 `SEATED_ACTIVE`，当前行动者/合法动作/引擎指纹**全不变**；到 `NEXT_HAND` 才真正暂离 |

座位视图会显示「在座（下一手暂离）」，菜单提供「取消「下一手暂离」」。

---

## 10. Action Preview

`POST /api/table` 每次返回 `state` + `preview`。`preview` 由后端复用**同一条链**算出：

```
牌桌状态 → tableStateToManualHandInput()  →  parseManualInput()
        → reconstructGameState(PREVIEW)   →  deriveLegalActions()
        → validateGameState()             →  预览结构
```

字段：`street` / `currentActorPosition` / `isHeroTurn` / `actionButtons` /
`potBB` / `currentBetBB` / `callAmountBB` / `minRaiseToBB` / `remainingStacksBB` /
`effectiveStackBB` / `activeOpponentCount` / `canAnalyze` / `analyzeBlockers` /
`manualHandInput` / `stateFingerprint` / `seats`（含 `visualIndex` / `angleDeg` / `statusZh`）。

**契约**：`group` 为 `PRIMARY` 或 `SIZE` 的按钮**一定是合法动作**；
`EXPAND` 只是展开尺寸行。实测穷举 6,469 个可执行按钮，**0 个被后端拒绝**。

---

## 11. Card Picker

- Hero 手牌与公共牌共用**一个** 4×13 牌矩阵；落点由 `app.target` 决定（Hero 或某个槽位）
- 一张牌一次点击；选完自动跳到下一个落点；再点已选的牌 = 取消
- 已用牌在矩阵里 `disabled`（置灰 + 删除线）；后端校验器仍然保留（前端只是方便）
- 公共牌**必须按顺序填**（跳着填会被拒绝并说明先填第几张）；只能取消最后一张
- 1～2 张公共牌 = 「选择中」：预览如实标记 `boardSelectionInProgress` 并**禁止分析**

---

## 12. Undo

- 每次变更把**旧核心状态**压入撤销栈（深度上限 40）
- `UNDO` 恢复整个核心状态：座位绑定、玩家画像、筹码、手牌、公共牌、行动历史、
  `handActive`、`notices` —— 全部回到快照
- 撤销后 `revision` 仍**单调递增**（不会回到旧版本号，否则竞态保护会失效）
- **空操作不推进 revision、不占撤销栈**（`commit` 里逐字段比较）

---

## 13. Race Protection

| 层 | 机制 |
|---|---|
| 服务端 | `RevisionGuard` 版本水位线：`revision < 已发出最大值` 的请求一律拒绝（`STALE_REVISION`），并明确告知「界面不会被回退」 |
| 客户端 | 单一在途请求（`app.inflight` 期间禁用全部控件）+ **丢弃 `revision <= 已应用` 的响应** |
| 例外 | `leaveDecision` **先于**版本判断处理 —— 它是同版本的失败响应，否则会被整包丢弃 |

实测：两个并发的同版本请求，**恰好一个被应用**；迟到的旧请求被拒绝且界面不回退。

---

## 14. Differential Tests

| 差分 | 断言 |
|---|---|
| 点选 vs 直接构造（§67） | 重建出的 `GameState` 指纹、底池、数学九项、动作、尺寸、置信度、分类、理由**逐位一致** |
| Hero 视觉旋转（§68） | 六种 Hero 位置下，提交数据的**归一化结果只有一种**；`logicalPosition` 逐位正确 |
| 行动回放往返 | 每点一次行动，两次独立重放必须得到同一指纹；校验器不得阻断 |
| 牌桌入口 vs 表单入口 | `/api/analyze {table}` 与 `{input}` 的**决策逐位一致** |
| 屏幕 vs 提交 vs 后端（§90） | 屏幕调试区显示的 `ManualHandInput` 与提交载荷归一化后逐字相同；屏幕指纹 = 后端重放指纹 |
| 换人回归（§69） | 换人后输入与全新牌桌**逐字节相同** |

---

## 15. 独立红队（两轮 + **最终快照增量复验**，均由**未参与实现**的审计员执行）

| 轮次 | 报告 | 判定 | 结果 |
|---|---|---|---|
| 座位生命周期 / 玩家身份 / 手牌历史 | `reports/TABLE_INTERACTIVE_REDTEAM_LIFECYCLE.md` | **PASS** | 1 CRITICAL + 5 MAJOR + MINOR 全部修复并复验 |
| 适配器 / 卡牌映射 / 竞态 / 前端诚实性 | `reports/TABLE_INTERACTIVE_REDTEAM_ADAPTER.md` | **PASS** | 2 CRITICAL + 3 MAJOR + MINOR 全部修复并复验 |
| **最终快照增量复验** | 同上报告 §「增量复验（最终快照）」 | **PASS** | RT-L6/L7/L8/L9 四项**行为级**通过；增量未破坏任何既有结论 |

两份主报告都写明**被测文件的 SHA256 前缀**；原始证据在
`scripts/rt-table-lifecycle-evidence*.txt` 与 `scripts/rt-table-adapter-evidence.txt`。

**交付依据 = 最终快照（12 个文件的 SHA256 前缀）+ 增量复验 PASS。**
审计员对增量复验的原话：四项「全部通过，且都是**行为级**验证（DOM 桩点击真实客户端、
真实 HTTP、文案与状态双向核对），不是读码判断」；「本轮增量**未发现新的
CRITICAL / MAJOR / MINOR**」。

**红队确认干净且有证明**的向量（摘录，均为冻结版本上的实测）：

- 卡牌映射：从源码抽出的 52 个牌面代码全部被原样接受；`As` = 黑桃 A；重复牌双向拒绝；同一点两次 = 取消
- 视觉 vs 逻辑：六种 Hero 位置下提交数据归一化后**只有一种**；`visualIndex` 不参与任何逻辑
- 陈旧响应：水位线 + `revision <= 已应用` 丢弃判据；`UNDO` 后 revision 仍单调递增
- 双击 / 并发：真实客户端连点两次只发 **1** 个请求；并发同版本**恰好 1** 个被应用
- 跨手泄漏：`NEXT_HAND` 清理矩阵全清、画像保留、筹码按上一手剩余
- `NEW_TABLE`：只剩 Hero 一个玩家对象、5 个 Villain 座位全空
- **§90 三方一致**：屏幕调试区文本 = 提交载荷 = 后端重放指纹（`V90 三方比对不一致项 0 条`）
- **§27/§29**：`table.js` 无任何规则函数；**11,201 次按钮点击 0 次被后端拒绝**
- `applyTableAction` 往返：最小加注 / 全下 / 短全下 / 分数筹码 / `bigBlindBB=3` / 多街 /
  逐座位不同筹码 → **0 次指纹不一致**
- 性能：`POST /api/table` 最慢 28.1 ms（安静轮 p50 15.8–22.5 ms），远低于 100 ms 目标

---

## 16. 真实 Bug（本轮发现并修复）

| # | 级别 | 缺陷 | 后果 | 修正 |
|---|---|---|---|---|
| T1 | **CRITICAL** | 适配器把**牌桌 playerId** 传给管线 | 动态层按 `record.playerId === villainId` 过滤本手事件 → 两边永不匹配 → `computed:false`：**动态层被静默关闭**而界面一切正常 | 画像按牌桌 playerId 查，传给管线的 id 用引擎口径 `seat_<位置>` |
| T2 | **CRITICAL**（红队） | 适配器同时传 `villain`（首要对手）与 `villains`（全部对手，座位序） | `parseManualInput` 取 `villains[0]` → **已弃牌的第一个对手**的画像被送进决策，范围却按另一个对手算：**用甲的性格给乙做决策** | 只传 `villain`（= `primaryOpponentPosition`），不传 `villains` |
| T3 | **CRITICAL**（红队） | `table.js` 一行调试残骸 `box.appendChild(... ? box : box)` | 真实 DOM 抛 `HierarchyRequestError`：**建议永远显示不出来**，且 `render()` 后半段全部跳过 → 连离桌选择弹层都打不开（界面半冻结） | 删除该行；新增「DOM 桩真实执行渲染」回归测试 |
| T4 | **CRITICAL**（红队） | 后端把展开按钮 group 改成 `EXPAND`，前端仍只认 `PRIMARY` | **下注/加注及全部合法尺寸从屏幕上消失**，用户只剩弃牌/过牌/全下 —— 屏幕不提供后端已判定的合法动作 | 前端同时接受 `EXPAND`；契约写进类型文档 |
| T5 | MAJOR | `parseManualInput` 完全不校验 `quickProfile` / `dynamicHint` | 一个拼错的字符串让动态层 `dominantState` 变成 `undefined`（不在枚举里的值），决策照常给出 | 未知取值一律阻断（Fail-Closed）并列出合法取值 |
| T6 | MAJOR（红队） | `ALL_IN` 按钮携带「本街总额」而引擎要「本次投入的剩余筹码」 | **只要本街已投入过筹码**（SB/BB、平跟后面对加注）点全下必被拒；11201 次穷举中 1545 次被拒且全是全下 | ALL_IN 不带金额，由引擎自己算 `need`；落库也不写金额 |
| T7 | MAJOR（红队） | 屏幕「有效筹码」用自己的口径，与引擎不一致 | 屏幕 19BB vs 引擎 99BB；面对全下时屏幕 99BB vs 引擎 0BB —— 同一个名字两个值 | 改用引擎的 `effectiveStackBetween(state, hero, 首要对手)` |
| T8 | MAJOR（红队） | 本手进行中「暂时离座」直接把座位标成 `SITTING_OUT` | 冻结的 Poker Core 要求 N 人桌恰好 N 位玩家 → 牌局无法重建 → 行动者变 null、按钮全消失：**这一手再也录不下去**（与 §53 相反） | 新增 `sitOutNextHand`：本手只标记，`NEXT_HAND` 才生效 |
| T9 | MAJOR（红队） | 离桌选择弹窗永远不出现 | ① `leaveDecision` 的处理写在版本保护之后（同版本失败响应被丢弃）② 座位菜单 7 处 `.then(closeModal)` 立刻关掉刚打开的弹层 | 先处理 `leaveDecision`；新增 `closeUnlessPending()` |
| T10 | MAJOR（红队） | `SET_HERO_POSITION` / `SET_TABLE_SIZE` 把目标座位的筹码当成 Hero 的 | 实测 210BB → 33BB / 123BB → 77BB，被顶掉的玩家无声消失，notice 只字未提 | Hero 的筹码跟着人走；notice 点名被顶掉的玩家 |
| T11 | MAJOR（红队） | 座位上的 `sitOutNextHand` 会被**下一个坐进来的人**继承 | 新玩家莫名暂离 → 整张牌桌无法分析（违反 Seat ≠ Player） | `CLEAR_SEAT` / `CLEAR_ALL_VILLAINS` / 落座点全部归零；`parseTableState` 拒绝「空座位带标记」 |
| T12 | MAJOR（红队） | 新建牌桌分支不校验 `heroPosition` 是否存在于该桌型 | `{tableSize:6, heroPosition:"UTG1"}` 返回 `ok:true` 却造出「Hero 不在任何座位」的死牌桌，此后每个操作都被拒 | 校验位置存在性 + 对结果跑**自校验** |
| T13 | MAJOR（红队） | 请求体上限 128KB vs 客户端自持状态 | 一手 24 条行动 + 36 层撤销栈 = 87.7KB，第 14 次操作即超限 → 服务端销毁连接 → 客户端只看到 `fetch failed` 且**一直重发**，只能刷新丢桌 | 上限提到 1MB + 返回可读 413；撤销深度 60 → 40 |
| T14 | MINOR | `parseTableState` 用 `Object.values(STREET_ZH)` 校验街道 | 那是**中文标签**，于是每条带街道的行动都被判非法 → 牌桌在 HTTP 层完全不可用（而纯函数层测试全绿） | 改用枚举值；补一条 HTTP 层测试 |
| T15 | MINOR | `setBoardCard` 允许「跳着填」 | 直接点第 3 个槽位时刚选的牌被**静默丢弃** | 拒绝跳着填并说明先填第几张；只能取消最后一张 |
| T16 | MINOR | `{op:{kind:'ACT'}}` / `action:null` → HTTP 500 | 违反「本模块不抛异常」的契约 | `parseOp` 校验 `ACT` 载荷；畸形载荷 37 例 × 2 端点 **0×5xx** |
| T17 | MINOR | `RESET_HAND` 保留 `LEAVING_AFTER_HAND` | 座位卡在「既不能加人、也不阻塞分析」的状态，界面无任何提示 | 重置本手时把「手后离桌」真正落定为 `EMPTY` |
| T18 | MINOR | 「取消」离桌决策走 `commit` | 平白压一条「无操作」记录，撤销一次界面毫无变化 | 取消 = 原状态返回 |
| T19 | MINOR | 空操作（环境/画像值未变）推进 revision 并占撤销 | 浪费撤销机会，给竞态判断引入噪声 | `commit` 里做逐字段比较，空操作不推进 |
| T20 | MINOR | 椭圆布局 180° 反向 | Hero 被画在**正上方**，整张桌子与角度约定相反 | `(angleDeg - 90)` → `(angleDeg + 90)` |
| T21 | MINOR | `NEW_TABLE` 重置 Hero 筹码而提示语说「Hero 设置保持不变」 | 提示不实 | 提示明写「所有座位筹码重置为默认 X BB（包括 Hero）」 |

---

## 17. Regression Tests

**59 项**新增测试，分四个文件：

| 文件 | 项数 | 覆盖 |
|---|---:|---|
| `test/interactiveTable.test.ts` | 22 | 三条铁律、§10 换人、§17 视觉≠逻辑、§48 新牌桌、§71/72/73 弃牌·暂离·中途加入、§74/§75 守恒、§37/§38 撤销、作者自查 A–D |
| `test/interactiveTableDifferential.test.ts` | 5 | §67 / §68 / §90 差分、行动回放往返、非法动作零副作用 |
| `test/interactiveTableApi.test.ts` | 14 | 元数据、静态资源、前端无规则函数、16 类畸形状态、§76 竞态、§77/78 双击、两入口一致、坏 JSON、监听范围 |
| `test/interactiveTableRedteam.test.ts` | 11 | RT-L1…L5 永久回归、结果自校验、11 类伪造状态、空操作 |
| `test/interactiveTableRedteam2.test.ts` | 13 | F-01/F-02、按钮穷举、ALL_IN、有效筹码、座位属性继承、视觉序号整体校验、0×5xx、413、载荷上限 |

**既有 1,119 项测试全部继续通过，无一次放宽断言。**

唯一被修正的既有测试：`test/alphaWebServer.test.ts` 的「首页返回中文表单」——
界面已改为牌桌，断言随之改为牌桌结构 + 「客户端脚本不得含牌局规则」；
`test/interactiveTable.test.ts` 的「自查 C」中 `ALL_IN` 的金额语义随契约修正而更新。
两处都在注释里写明了原因。

---

## 18. 现场 Spot（A–J，`scripts/table-walkthrough.ts`）

| Spot | 场景 | 本手点击 | 服务端耗时 | 结果 |
|---|---|---:|---:|---|
| A | 9-max · Hero UTG（翻牌决策） | 16 | 494 ms | 建议：下注 2.25BB |
| A2 | 翻牌前**提前提示**多人池限制 | 2 | 141 ms | 预览已提示 8 名活跃对手 |
| B | Hero 小盲 · 面对开池 | 7 | 222 ms | 建议：加注 3.50BB |
| C | Hero 大盲 · 小盲补齐 | 8 | 236 ms | 建议：过牌 |
| D | 玩家中途弃牌 | 7 | 230 ms | 建议：加注 3.50BB |
| E | 玩家离桌（手后离桌） | 9 | 250 ms | 建议：加注 3.50BB |
| F | 换新玩家（不得继承画像） | 9 | 241 ms | 画像 = UNKNOWN（正确） |
| G | 暂离再回来 | 3 | 120 ms | 画像保留（正确） |
| H | 150BB 深筹码 | 19 | 373 ms | 建议：下注 2.25BB |
| I | 河牌决策 | 19 | 356 ms | 建议：跟注 1.00BB |
| J | 下一手继续同桌 | 28（两手） | 573 ms | 座位与画像保留，两手都给建议 |

**11 / 11 通过。**

---

## 19. 输入时间 Median / Max

| 项 | 值 |
|---|---|
| 服务端耗时（每手） | **中位 ~283 ms**，最慢 573 ms（两手连续） |
| HTTP 单次 `POST /api/table` | p50 ≈ 16 ms，最深状态 28.1 ms |
| 完整 Analyze | 与 Alpha 一致（P95 ≤ 76 ms） |
| **人类输入耗时** | ⚠️ **未测** —— 必须由使用者亲自点一遍才有意义 |

> 脚本给出的是**下界**：点击次数 × 单次反应时间 + 服务端耗时。
> 以每手 9 次点击、每次点击 1 秒计，普通 Spot 约 **9 秒**，接近但未超出 §86 的 10 秒目标。
> **这一项需要你的现场实测来确认。**

---

## 20. Click Count

| 项 | 值 |
|---|---|
| **每手**点击（中位） | **9** |
| 每手点击（最小 / 最大） | 2 / 28（最大那个是「两手连录」） |
| 一次性布置（建桌 + 坐满座位） | 9 次（6 人桌）/ 15 次（9 人桌）—— **开一次牌桌只做一次** |
| 键盘输入 | **0 次**（牌面全部点选） |

---

## 21. `npm run verify`

```
> tsc --noEmit                          → 零错误
> generateManifest.ts --check           → ✔ 全部 84 个产物与清单一致
> node --test "test/**/*.test.ts"       → ℹ tests 1185 / suites 136
                                           ℹ pass 1185 / fail 0
EXIT = 0
```

---

## 22. TypeScript

`npx.cmd tsc --noEmit` → **零错误**。
（本机 `npx.ps1` 被执行策略拦截，必须用 `npx.cmd`；`erasableSyntaxOnly` 生效，
因此不能使用 TS 参数属性 —— 实测踩到并在 `scripts/table-walkthrough.ts` 里改掉了。）

---

## 23. Manifest

| 项 | 值 |
|---|---|
| 产物总数 | **84**（本轮 +21） |
| 类别 | KNOWLEDGE 6 / RANGE 16 / ENVIRONMENT 2 / PLAYER_MODEL 9 / DECISION 36 / REPORT 15 |
| 校验 | `sha256` + 字节数，`npm run verify` 强制通过 |
| 新增登记 | 7 个 table 源文件 + table.js/css + 5 个测试文件 + 2 个脚本 + 2 份红队报告 + 用法文档 + 最终报告 |

---

## 24. 已知限制

| 限制 | 说明 |
|---|---|
| **暂离 / 空座位无法分析** | 冻结的 Poker Core 要求「N 人桌恰好 N 位玩家」，本项目**不做**把暂离玩家排除在牌局之外的建模。界面明确说明并要求先处理 |
| **翻牌前前位决策常返回「信息不足」** | 引擎门槛是「≥3 名未弃牌对手即拒绝」。Hero 在 UTG/CO/BTN 开池时后面的人还没弃牌 → 活跃对手 ≥3。牌桌会**提前**在阻塞原因里写出来（预览里显示活跃对手数） |
| **下一手不分配底池** | 本项目不建模牌局结果（结果不得进入决策链），因此按「剩余筹码」更新座位筹码，并显式提示「赢家请手动改回」 |
| **快速画像多数情况下不改变最终置信度** | 最终置信度取各分量**最小值**，而范围可信度 0.3 已是最小分量。已用测试把这条限制钉住 |
| **人类输入耗时未测** | 必须由使用者现场实测（§19） |
| **红队口径** | 两轮完整红队 PASS + **最终快照增量复验 PASS**；增量复验只覆盖最后一轮改动，不重跑全部攻击面 |
| 单标签页假设 | 客户端自持状态；两个标签页同时操作同一张牌桌会互相覆盖（版本水位线会拒绝迟到者并提示刷新） |
| 锦标赛 / 短牌 / Rake | 刻意未做 |

---

## 23.5 CORRECTION / ERRATA（由后续一轮修正，**不改动本文其它历史结论**）

> 本节由 **Table Topology Correction** 轮追加。
> 原则：**历史报告里被证伪的陈述必须留下更正记录，而不是被静默改写。**
> 本文其余章节（含两个红队的判定与缺陷编号）**保持原样**，它们是当时的真实记录。

### E-1 本文 §24 的两条「已知限制」**已被证伪**，不是限制，是缺陷

| 原文 | 更正 |
|---|---|
| 「**暂离 / 空座位无法分析**：冻结的 Poker Core 要求「N 人桌恰好 N 位玩家」，本项目**不做**把暂离玩家排除在牌局之外的建模。」 | ❌ **不成立。** 域层 `createGame` 只要求 `2 ≤ 本手人数 ≤ 座位容量`；暂离座位由 `participantSeatsOf` 直接排除在本手之外（不发牌、不占盲注）。「9 座桌 8 人」现在**可以**正常分析。**已修复**，见 `test/tableTopology.test.ts` §1。 |
| 「**翻牌前前位决策常返回「信息不足」**：引擎门槛是「≥3 名未弃牌对手即拒绝」。……牌桌会**提前**在阻塞原因里写出来」 | ❌ **不成立，且这条「提前告知」正是缺陷本身。** 那 3 名对手当时**还没轮到说话**，他们既没有投入也没有范围。把「未行动」当成「已参战」，导致 9 座桌 Hero 在 UTG 时开池 **100% 被拒**，而界面还在劝退一个其实完全可分析的决策点。**已修复**：门槛改用 `realizedOpponentCount`（已跟注/加注/全下），未行动者只作为提示。见 `test/tableTopology.test.ts` §7。 |

**根因是同一个**：全项目把 `tableSize`（**座位容量**）与「本手人数」当成同一个数字。
一份独立审计（`reports/TABLE_SIZE_SEMANTICS_AUDIT.md`）在 185 处引用里
分出了 11 处真混用，本节两条即其中的产品可见后果。

### E-2 数字更正（§20 / §21 的计数口径）

本文 §20 写「1119 → 1185（Δ66）」，而同一份文档的「新增 59 项」与小计 65 对不上。

- **Δ66 是对的**（1185 − 1119 = 66）；
- 「新增 59 项」是**错的**，正确数字是 **66 项**（其中 5 个新测试文件贡献 65 项，
  另有 1 项是既有文件的迁移用例）。

⚠️ 本次更正**只动数字口径**：本文所引用的两个红队报告里的结论与缺陷编号
（RT-Lx / F-xx / V-xx）**一律不改**，它们是各自快照上的真实记录。

---

# INTERACTIVE TABLE INPUT — PASS

**判定依据**

1. Hero 固定在视觉底部，而逻辑位置逐位正确（五种 Hero 位置、两种桌型都测过）
2. 玩家可以快速进出座位：加入 / 清空 / 换人 / 暂离 / 重新入座 / 手后离桌 / 下一手 / 新牌桌 / 撤销
3. 新玩家**绝不**继承旧玩家的画像与动态（换人后输入与全新牌桌逐字节相同）
4. Fold / Leave / Sit Out 三者严格区分，各有独立状态与回归测试
5. 当前手的底池与行动台账**不会**因为座位变化被破坏（引擎指纹逐位不变）
6. 主要牌局可以靠点选快速完成：**每手中位 9 次点击、0 次键盘输入**
7. 进入 Alpha Pipeline 的数据与屏幕看到的牌局完全一致（§90 三方一致有测试锁定）

`npm run verify` exit 0；1,185 项测试 / 136 套件 / 0 失败；`tsc` 零错误；84 个产物与清单一致。
两个独立红队（座位生命周期 / 适配器与竞态）**判定均为 PASS**，
其报出的 1 + 2 CRITICAL 与 8 MAJOR 全部修复并有永久回归测试。

> ⚠️ 上面这行数字是**当时快照**的真实记录（本文写于 2026-09-13）。
> 该快照之后，项目又经历了一轮 **Table Topology Correction**，
> 当前基线是 1,228 项 / 136 套件 / 88 个产物，判定不变。
> 本轮同时证伪了本文 §24 的两条「已知限制」—— 见上方 **§23.5 CORRECTION / ERRATA**。

**按规范第 101 条：停止继续开发 UI。下一步是拿牌桌界面测试 20～30 手真实牌局，
每发现一个误导性建议就定位到 INPUT / VALIDATOR / MATH / RANGE / PROFILE /
ENVIRONMENT / DYNAMIC / DECISION / SIZE / CONFIDENCE，修掉并补一条回归测试。
不开启新的大 Phase。**
