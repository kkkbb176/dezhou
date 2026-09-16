# 交互式牌桌录入 · 座位生命周期 / 玩家身份 / 手牌历史完整性 —— 独立红队审计报告

- **审计对象**：本轮新增的交互式牌桌录入（`src/app/table/*`、`src/app/web/table.js`、`POST /api/table`）
- **审计范围**：座位生命周期、玩家身份绑定、当前手历史事实的完整性（不是策略/权益层）
- **审计方式**：不读注释下结论。全部结论来自**执行**：驱动 `applyTableOp` 序列 + 引擎重放指纹比对 +
  把**真实的** `table.js` 放进最小 DOM、用真实 HTTP 服务端驱动
- **红队身份**：独立第三方。本报告中的每一条都可由下面的命令原样复现

## 0. 被测版本（冻结口径）

开发者在审计期间持续改代码。按双方约定，红队以**最后一次观察到写入之后 120 秒无写入**为界自我冻结，
并对冻结版本**重跑全部探针**。本报告的全部结论对应下列 SHA256 前缀：

| 文件 | 最后写入 | SHA256(前 16) |
|---|---|---|
| `src/app/table/table.types.ts` | 13:18:56 | `0812DB7AD78C2E99` |
| `src/app/table/tableState.ts` | 13:06:32 | `2CBE1E96FD9FC402` |
| `src/app/table/seatLifecycle.ts` | 13:17:43 | `4023FC6EEFBFE6BE` |
| `src/app/table/tableOps.ts` | 13:16:21 | `87AA2D143FF32602` |
| `src/app/table/tableAdapter.ts` | 13:05:22 | `AC4EF748A39603EC` |
| `src/app/table/tablePreview.ts` | 13:17:22 | `4C0D51745055D866` |
| `src/app/table/tableApi.ts` | 13:18:44 | `BF37C85E31A021B5` |
| `src/app/webServer.ts` | 13:18:39 | `B52C3A79C72FF59A` |
| `src/app/web/table.js` | 13:18:21 | `0299C760578F15EE` |

（`& npx.cmd tsc --noEmit` 在冻结版本上退出码 0；`test/interactiveTable*.test.ts` 四个文件 52 项全部通过。）

## 1. 证据脚本（全部保留在 `scripts/`，可直接运行）

```powershell
cd D:\德州
# 主探针：状态层（13 个章节，驱动 applyTableOp + 引擎指纹 + 伪造状态 + Undo + 换桌型 + 换 Hero）
node.exe --experimental-strip-types "scripts/rt-table-lifecycle-probe.ts"
#   → 证据落盘 scripts/rt-table-lifecycle-evidence.txt

# 客户端探针：把真实 src/app/web/table.js 放进最小 DOM，用真实 HTTP 服务端驱动点击
node.exe --experimental-strip-types "scripts/rt-table-lifecycle-probe2.ts"
#   → 证据落盘 scripts/rt-table-lifecycle-evidence2.txt
```

两个脚本都**自己**用 `fs.writeFileSync(..., 'utf8')` 写证据文件（不经过 PowerShell 重定向，避免中文损坏）。

## 2. 发现清单

严重级别定义（本报告口径）：

- **CRITICAL**：静默产生错误决策，或静默腐化牌局状态（屏幕与后端分叉）
- **MAJOR**：使用者一定会撞到的错误/缺失行为（可见、可恢复，但会打断正常使用）
- **MINOR**：真实但影响面小
- **INFO**：非缺陷，或已文档化的限制

| # | 级别 | 一句话 | 状态 |
|---|---|---|---|
| RT-L1 | **CRITICAL** | 送进决策引擎的对手画像/动态属于**座位序第一个对手**（常常是**已弃牌**的那位），而范围与权益是按**另一个**（真正未弃牌的首要对手）算的 —— 「用甲的性格给乙做决策」 | 已修复，复验通过 |
| RT-L2 | **MAJOR** | 本手进行中「清空座位」的**离桌选择弹窗永远打不开**（同版本失败响应被客户端版本保护整包丢弃 + 处理函数 `then(closeModal)` 立刻关掉弹层） | 已修复，复验通过 |
| RT-L3 | **MAJOR** | `SET_HERO_POSITION` / `SET_TABLE_SIZE` 把**目标座位上那位玩家的筹码当成 Hero 的筹码**（实测 Hero 210BB→33BB、123BB→77BB），且原玩家被静默解绑 | 已修复（筹码跟人走 + notice 点名），复验通过 |
| RT-L4 | **MAJOR** | 本手进行中点一次「暂时离座」→ 引擎重建失败 → 当前行动者变 `null`、行动按钮全部消失，**这一手在界面上再也录不下去** | 已修复（`sitOutNextHand`），复验通过 |
| RT-L5 | **MAJOR** | 新增的 `sitOutNextHand` 被**下一个坐进来的人继承**（`CLEAR_SEAT` / `CLEAR_ALL_VILLAINS` 不清这个标记，而 `RESET_HAND` 会保留它）—— 新玩家从未点过暂离却直接暂离，牌桌随即无法分析 | 已修复，复验通过 |
| RT-L6 | **MAJOR** | 「下一手暂离」**没有取消入口**：座位菜单只在 `status === 'SITTING_OUT'` 时才给「重新入座」，标记状态下仍只给「暂时离座」，再点一次只会报错 | **未修复** |
| RT-L7 | **MAJOR** | `POST /api/table {tableSize:6, heroPosition:"UTG1"}` 返回 `ok:true`，却造出一张**连服务器自己的校验器都不接受**的牌桌（Hero 不在任何座位上），此后该牌桌**每一个操作都被拒绝**（仅 API 可达） | **未修复** |
| RT-L8 | MINOR | `SET_TABLE_SIZE` 9→6 时 BTN 上的人被 Hero 顶掉，notice 里**没有点名**是谁（`SET_HERO_POSITION` 有） | **未修复** |
| RT-L9 | MINOR | `NEW_TABLE` 把 Hero 手改过的筹码（250BB）**静默重置**为默认值（100BB），而提示语写着「Hero 设置保持不变」 | **未修复** |
| RT-L10 | MINOR | 客户端椭圆布局曾把 `0°` 渲染到**屏幕正上方**（与「0°=正下方、Hero 恒定在底部」的约定正好相差 180°，同时把逆时针镜像成顺时针） | 已修复，复验通过 |
| RT-L11 | MINOR | `parseTableState` 曾放过跨字段矛盾、垃圾牌面、重复 `playerId`、重复视觉序号 | 已修复，复验通过 |
| RT-L12 | MINOR | 空操作（环境/画像值未变）会推进 `revision` 并占用一次撤销栈 | 已修复，复验通过 |
| RT-L13 | MINOR | 一手都没打过时点「下一手」也会把 `handsPlayed + 1` | 已修复，复验通过 |
| RT-L14 | INFO | 底池不分配（`NEXT_HAND` 后座位筹码合计恰好减少一个底池）—— **已明示**且不在决策链里，属于已文档化限制 | 非缺陷 |

> 说明：RT-L1～L5、RT-L10～L13 是红队在本轮报出 → 开发者修复 → 红队**按冻结版本逐条复验**的闭环。
> RT-L6～L9 是冻结版本上仍然存在的项，级别与影响在下面逐条写清。

---

## 3. RT-L1（CRITICAL，已修复并复验）· 画像/动态挂到了别人身上

### 最小复现

场景：Hero 在 BB；**UTG 弃牌**、HJ 加注、CO/BTN/SB 弃牌 → 轮到 Hero。此时引擎口径的首要对手
（决定范围与权益）是 **HJ**。

```
scripts/rt-table-lifecycle-probe.ts §4b / §4c / §4d
```

### 修复前观测值

```
适配器输出 villain.playerId      = seat_HJ（画像：UNKNOWN）
适配器输出 villains[0].playerId  = seat_UTG（画像：MANIAC）
解析后 villain.playerId（A：UTG=MANIAC） = seat_UTG      ← 真正的对手是 HJ
玩家快照 playerId=seat_UTG confidence=0.35 note=…采用用户手选画像「MANIAC」…
把 MANIAC 设在**真正的首要对手 HJ** 上，决策引擎却看不到
```

对照实验（§4d，同一条用户提示，只换人）：

| 场景 | 提示设在谁身上 | 决策置信度 | 动态层状态 |
|---|---|---|---|
| P：UTG 加注（首要对手恰好排在第一位） | UTG | 0.3 → **0.28125** | TILT_SIGNAL |
| Q：UTG 弃牌、HJ 加注（首要对手是 HJ） | **HJ（真正的对手）** | 0.3 → **0.3**（无变化） | UNKNOWN |
| Q：同上 | UTG（**已弃牌**） | 0.3 → **0.28125** | TILT_SIGNAL |

### 根因与影响

`tableAdapter` 同时输出了 `villain`（首要对手）与 `villains`（全部有座位的对手，**含已弃牌者**）；
而 `manualInput.parseManualInput` 取的是 `villainList[0]`，且 `villainList = input.villains ?? …`
—— **只要给了 `villains`，`input.villain` 就被完全忽略**。于是：

- 范围/权益按 HJ 算，画像/动态按 UTG 算（跨人拼装）；
- 使用者**设在真正对手身上的观察提示被静默丢弃**，而设在已弃牌者身上的提示却生效；
- 决策诊断里 `diagnostics.player.playerId` 指向错误的人 —— 复盘时看到的是「甲的性格」。

### 复验结果（冻结版本）

```
解析后 villain.playerId（A：UTG=MANIAC） = seat_HJ
解析后 villain.playerId（B：HJ=MANIAC）  = seat_HJ
适配器是否输出 villains 数组            = false
PASS 解析后的 villain 就是首要对手 seat_HJ（画像不会挂到已弃牌者身上）
PASS 设在真正对手 HJ 身上的提示**生效了**
PASS 设在**已弃牌**的 UTG 身上的提示不改变决策（不再张冠李戴）
```

---

## 4. RT-L2（MAJOR，已修复并复验）· 离桌选择弹窗永远打不开

### 最小复现

把**真实的** `src/app/web/table.js` 放进最小 DOM，用真实 `startAlphaServer` 驱动点击：

```
scripts/rt-table-lifecycle-probe2.ts §C4
驱动：坐满 6 人 → 选 Hero 手牌（本手进行中）→ 点 UTG 座位 → 点「清空座位」
```

### 修复前观测值

```
点击后：overlay.className = ""                       ← 弹层没打开
点击后：toast = "本手正在进行中。…请明确选择处理方式。"
点击后：弹窗内容 = 仍是座位菜单（没有「仅标记手后离桌」按钮）
点击后座位状态：UTG:p2/SEATED_ACTIVE                  ← 状态没变（后端守住了不变量）
客户端版本保护判定：drop=true（整个响应被丢弃）
```

### 根因与影响

两个**互相独立**的原因：

1. `applyTableResponse` 先做版本判断、后赋 `pendingLeave`；而「本手进行中清空座位」是一个**失败**响应，
   它回传的 state 与请求**同版本** → 被「迟到响应」保护整包 `return false`，`leaveDecision` 永远读不到；
2. 座位菜单里「清空座位」的处理器写作 `sendOp(...).then(closeModal)` —— 即使弹层被打开也会立刻关掉。

影响：§8 要求「本手进行中的离桌不许默认猜、必须让用户明确选择」，而界面上**根本没有这条路径**。
后端不变量没被破坏（座位没被清空），但使用者点了没反应、只能反复点同一个按钮。

### 复验结果（冻结版本）

```
table.js：pendingLeave 赋值在第 155 行，版本判断在第 162 行  → leaveDecision 先处理
PASS leaveDecision 在版本判断之前处理（同版本失败响应不再被整包丢弃）
PASS 座位菜单使用 closeUnlessPending（有待处理离桌决策时不关弹层）
PASS 本手进行中点「清空座位」→ 弹出「离桌选择」，用户可以选择「仅标记手后离桌」
PASS 「仅标记手后离桌」已生效，且本手期间绑定与历史都保留（UTG status=LEAVING_AFTER_HAND，playerId 仍非 null）
```

---

## 5. RT-L3（MAJOR，已修复并复验）· 换 Hero 座位时筹码被顶替

### 最小复现与修复前观测值

```
scripts/rt-table-lifecycle-probe.ts §11 / §10a
换位前：Hero(CO) 筹码=210BB；BTN=p4（MANIAC，33BB）
换位后：BTN 绑定=p1 筹码=33BB          ← Hero 的 210BB 没了，变成了那位玩家的 33BB
换位后 notices=["Hero 位置已改为 BTN（牌桌视图已旋转，Hero 固定在底部）。"]   ← 只字未提筹码与被顶掉的人
```

`SET_TABLE_SIZE` 9→6（Hero 在 UTG1，新桌型没有 UTG1 → 自动改到 BTN）同理：
Hero 手改的 123BB 被 BTN 上那位玩家的 77BB 顶替，且 notice 只说「多出来的座位已清空 / Hero 自动改到庄家位」。

### 影响

**送进引擎的有效筹码（effectiveStack）会静默变成另一个人的筹码** —— 直接改变决策所依赖的
SPR / 有效筹码；同时那位玩家被无声移出座位。

### 复验结果（冻结版本）

```
PASS  Hero 的筹码跟着人走（210BB 未被目标座位上的 33BB 顶替）
PASS  notice 如实说明了被顶掉的玩家：「庄家位 座位上原本是「玩家4」—— 该座位已交给 Hero，他不再绑定任何座位…」
PASS  Hero 筹码跟着人走（123BB 未被 BTN 上的 77BB 顶替）
（9→6 的 notice 仍未点名被顶掉的人，见 RT-L8）
```

---

## 6. RT-L4（MAJOR，已修复并复验）· 本手进行中「暂时离座」毁掉当前手

### 最小复现与修复前观测值

```
scripts/rt-table-lifecycle-probe2.ts（修复前版本）§C4b
在 SB 暂离后：ok=false 当前行动者=null 按钮数=0 街=— 底池=0BB
             阻塞原因=["有 1 个座位处于「暂离」（小盲位）。当前引擎**无法**把暂离玩家排除在牌局之外…"]
```

一次点击就让**整张牌桌**的预览塌成空：行动者 `null`、按钮消失、底池显示 0 —— 与
「暂离只影响下一手」（规范第 53 条）完全相反。

### 复验结果（冻结版本，改为 `sitOutNextHand` 语义）

```
PASS 标记后 UTG.status = SEATED_ACTIVE（当前手不变）
PASS 引擎口径逐位不变（底池/投入/行动顺序未被暂离影响）
PASS 暂离标记后仍能记录行动
PASS 下一手才真正变成 SITTING_OUT；下一手「重新入座」可用
PASS 当前手不受影响（行动按钮仍在）
PASS 标记不会污染别人（UTG/SB）
PASS 新玩家没有继承旧玩家的暂离标记
```

---

## 7. RT-L5（MAJOR，已修复并复验）· 新玩家继承上一位玩家的「下一手暂离」

这是**修复 RT-L4 时新引入的**缺陷，由红队在修复后继续攻击发现，开发者已再次修复。

### 最小复现（修复前）

```
scripts/rt-table-lifecycle-probe.ts §5g
坐满 6 人 → 选 Hero 手牌 → UTG 点「暂时离座」（只标记）→ 点「重置本手」→ 打开 UTG 菜单点「清空座位」
→ 点同一空座「加入玩家」→ 点「下一手」
```

修复前观测：

```
清空座位后：playerId=null status=EMPTY sitOutNextHand=true      ← 空座位挂着标记
新玩家 p7（旧玩家 p2）坐进 UTG：sitOutNextHand=true              ← 新玩家继承了它
下一手：p7 的座位状态=SITTING_OUT；staffingProblems=["有 1 个座位处于「暂离」（枪口位）…"]
「清空其他玩家」后仍挂着暂离标记的空座位：["UTG"]
```

### 根因

`sitOutNextHand` 在 `REPLACE_PLAYER` / `SET_TABLE_SIZE` / `SET_HERO_POSITION` / `NEXT_HAND` 都清了，
**但 `CLEAR_SEAT`（本手未开始时的立即解绑分支）与 `CLEAR_ALL_VILLAINS` 没清**；而 `RESET_HAND`
按设计保留这个「跨手意图」并把 `handActive` 置 false —— 两者叠加就能让标记活过「清空座位」，
被下一位坐进来的人继承。这正是本轮锁死的 **# Seat ≠ Player**：新玩家继承了上一个占用者的状态。

### 复验结果（冻结版本）

```
清空座位后：playerId=null status=EMPTY sitOutNextHand=false
新玩家 p7（旧玩家 p2）坐进 UTG：sitOutNextHand=false
下一手：p7 的座位状态=SEATED_ACTIVE；staffingProblems=[]
PASS 空座位不再挂标记；PASS 新玩家没有继承暂离标记
PASS（DOM 端到端）新玩家没有继承暂离标记
```

---

## 8. RT-L6（MAJOR，**未修复**）· 「下一手暂离」在界面上没有取消入口

### 最小复现

```
scripts/rt-table-lifecycle-probe2.ts §C4b（真实 table.js + 真实服务端）
本手进行中 → SB 座位菜单 →「暂时离座」→ 再次打开该座位菜单
```

### 观测值

```
暂离标记后：SB 座位显示 = "玩家5 小盲位（SB） 99.5BB（本街已投 0.5BB） 在座（下一手暂离）"   ← 可见，好
再次打开座位菜单：有「重新入座」=false，有「暂时离座」=true
再次点「暂时离座」→ toast = "该玩家已经标记为「下一手暂离」"                                 ← 只能报错
```

状态层探针同样确认：

```
SeatView 是否暴露 sitOutNextHand = true
PASS 再次点「暂时离座」被拒绝
（后端 SIT_IN 可以取消标记，但界面只在 status===SITTING_OUT 时才显示「重新入座」）
```

### 影响

使用者在当前手里误点「暂时离座」后，**界面没有任何办法取消**（唯一出路是「撤销」这个语义无关的按钮）。
标记会一直生效到下一手：下一手该玩家被判 `SITTING_OUT`，而暂离状态会让**整张牌桌无法分析**
（引擎要求 N 人桌恰好 N 位玩家），必须再到座位菜单点「重新入座」才能恢复。
这是「可见但会打断使用」的缺陷，不产生静默错误决策，因此按 MAJOR 记录而不是 CRITICAL。

### 建议修法

座位菜单的按钮选择条件从 `seat.status === 'SITTING_OUT'` 改为
`seat.status === 'SITTING_OUT' || seat.sitOutNextHand`（后端 `SIT_IN` 已经同时支持取消标记）。

---

## 9. RT-L7（MAJOR，**未修复，仅 API 可达**）· 服务器造出自己校验器不接受的牌桌

### 最小复现

```
scripts/rt-table-lifecycle-probe.ts §12c
POST /api/table  {"tableSize":6,"heroPosition":"UTG1"}
```

### 观测值

```
POST /api/table {tableSize:6, heroPosition:"UTG1"} 的 ok = true       ← 成功
创建结果：heroPosition=UTG1 座位数=6 有人的座位=0                      ← Hero 根本不在座位上
visualIndex 集合=[0,1,2,3,4,5]
把这个状态回传给 /api/table → parseTableState ok=false
  原因：Hero 的座位必须存在且绑定 heroPlayerId
后续 ADD_PLAYER → ok=false；原因：Hero 的座位必须存在且绑定 heroPlayerId
```

### 分析

`handleTableRequest` 的新建分支只校验 `heroPosition` 是不是**合法枚举值**，没有校验它
**在该桌型里存在**（6 人桌没有 UTG1/UTG2/LJ：`positionsForTableOf(6)` 不含它们）。于是
`createTable` 里 `position === heroPosition` 永不成立 → Hero 谁也没绑定、6 个座位全空；
`visualIndexOf` 因为 `indexOf === -1` 退化成「谁都没旋转」。

新建分支**没有**接入本轮新加的「结果自校验」（那条自校验只覆盖 `applyTableOp` 之后的路径），
所以这张坏牌桌被如实返回，而之后每一个操作都会以一句难以理解的原因被拒绝。

**可达性说明（不夸大）**：随附的前端 `createTable()` 硬编码 `{tableSize:6, heroPosition:'BTN'}`，
Hero 位置按钮也按桌型过滤过，因此**随附 UI 走不到**；这条只有直接调用 HTTP 接口 /
脚本 / 未来的前端改动会撞到。影响是「一张彻底不可用且提示误导的牌桌」，不产生错误决策。

### 建议修法

新建分支里 `if (!logicalSeatOrder(tableSize).includes(heroPosition))` → 返回可读的中文拒绝
（或按 `setTableSize` 的做法回退到 BTN 并如实告知）；并把新建结果也送一遍 `parseTableState` 自校验。

---

## 10. MINOR 项

### RT-L8 · `SET_TABLE_SIZE` 9→6 顶掉 BTN 上的人但没点名（未修复）

```
切换后 notices=["桌型已切换为 6 人桌。",
  "UTG1、UTG2、LJ 这些位置在新桌型里不存在，对应座位已移除（玩家对象仍保留在历史里，不再绑定任何座位）。",
  "Hero 原位置 UTG1 在 6 人桌不存在，已自动改到庄家位。",
  "座位筹码保持不变；Hero 的筹码跟着 Hero 走。"]
失去座位的 playerId：["p3","p4","p7"]      ← p7 原本坐在 BTN，被 Hero 顶掉，notice 里没有他
```

前三条如实、第四条也如实，缺的只是「BTN 上原本是谁」这一条（`SET_HERO_POSITION` 已经这么做了）。
建议把 `setHeroPosition` 的那段逐人提示复用到 `setTableSize`。

### RT-L9 · `NEW_TABLE` 静默重置 Hero 的筹码（未修复）

```
Hero 筹码：新建前=250BB，新建后=100BB（默认 100BB）
notice："已新建牌桌：其他座位与玩家画像、动态观察、行动历史全部清空；Hero 设置、环境与默认筹码保持不变。"
```

`createTableLike` 把**所有**座位（含 Hero 座位）的 `stackBB` 设回 `defaultStackBB`。
函数头的保留清单里确实没有「Hero 筹码」，所以这**可能是**有意为之；但中文提示语
「Hero 设置保持不变」会被读成「我的筹码还在」。建议二选一：保留 Hero 筹码，或把提示语改成
「Hero 的筹码已恢复为默认买入」。

### RT-L10 · 椭圆布局曾是 180° 反向（已修复复验）

```
修复前：BTN v0/  0° 渲染于 (50%, 8%)    ← 屏幕正上方
        UTG v3/180° 渲染于 (50%, 88%)   ← 屏幕正下方
修复后：PASS Hero 固定在正下方 (50%, 88%)
```

`angleOfVisualIndex` 与 `table.js` 注释都写「0° = 正下方（6 点钟）、沿行动方向屏幕逆时针」，
而 `rad = (angleDeg - 90) * π/180` 把 0° 放到了正上方、并把逆时针镜像成顺时针。
没有污染任何逻辑（位置标签与行动顺序都来自后端），但「Hero 恒定在底部」这条本轮明确要求不成立。

### RT-L11 / RT-L12 / RT-L13（已修复复验）

```
拒绝「handActive=false 但有行动历史」/「handActive=true 但一切皆空」/「heroCards 里有非法牌面 ZZ」
    /「board 与 heroCards 重复」/「Hero 座位 visualIndex=1」/「sitOutNextHand 不是布尔」
    /「两个座位绑定同一个 playerId」/「交换两个非 Hero 座位的 visualIndex」
SET_TABLE_SIZE:Δrev=0（状态等价）| SET_HERO_POSITION:Δrev=0 | SET_ENVIRONMENT:Δrev=0
| NEXT_HAND:Δrev=0（状态等价）| 其余改动路径 Δrev=1
空牌桌直接点「下一手」：handsPlayed=[0] lastHandComplete=false
```

---

## 11. 逐向量结论（本轮要求的攻击清单）

| # | 攻击向量 | 结论 |
|---|---|---|
| 1 | Hero 视觉旋转导致逻辑位置错误（6/9 人桌全部 Hero 位置） | **clean**。18 组（Hero × 桌型）全部：Hero `visualIndex=0`、视觉序号唯一且等于 `rotateAroundHero`、提交载荷里没有任何 `visualIndex/angleDeg` 字段、引擎里翻牌前第一个行动者恒为 UTG、同一逻辑牌局在 Hero=CO 与 Hero=SB 下引擎指纹**逐位相同**。另有 1 条与渲染有关的缺陷（RT-L10，已修复）。 |
| 2 | Fold 误删玩家 | **clean**。弃牌只写 `FOLDED_THIS_HAND`，绑定保留、画像保留、台账追加一条真实 FOLD；下一手回到 `SEATED_ACTIVE`；弃牌不改变任何人的投入。 |
| 3 | Leave 误删底池 / 破坏筹码守恒 | **clean**。「手后离桌」后引擎指纹、底池、逐人投入、行动台账**逐位不变**，座位仍绑定；只有 `NEXT_HAND` 才真正清空，且离桌者的筹码随人离开（不在桌上）。 |
| 4 | 换人继承旧画像（quickProfile / dynamicHint / handsPlayed） | **clean**。新 `playerId`、`UNKNOWN`、`handsPlayed=0`、筹码回默认；旧玩家对象保留在 `playersById` 但不再被任何座位引用。**（RT-L1 是这条的另一个入口：不是换人，而是「首要对手解析」——已修复）** |
| 5 | Sitting Out 误清历史 / 误影响当前手 | **clean（修复后）**。画像与台账不动；本手进行中只设 `sitOutNextHand`，引擎口径逐位不变、仍可继续录。**修复过程中新引入的 RT-L5（被新玩家继承）与残留的 RT-L6（无法取消）另行记录**。 |
| 6 | 本手进行中进新人 | **clean**。`ADD_PLAYER` 被 `HAND_ACTIVE` 拒绝；把 `handActive` 伪造成 `false` 的注入（带手牌 + 带行动历史）现在被 `parseTableState` 拒绝，HTTP 层同样拒绝、零副作用。 |
| 7 | Undo 恢复错误绑定 / 恢复不存在的状态 | **clean**。11 步操作链逐步撤销，**每一步都逐位回到历史快照**（`coreJson` 全等）；撤销离桌恢复绑定 + 画像 + 本手状态；撤销 `NEXT_HAND` 恢复底池/筹码/历史/`handsPlayed`；撤销 `NEW_TABLE` 恢复被清掉的玩家对象与历史。 |
| 8 | 撤销后 / 被拒操作后底池未恢复 | **clean**。9 类被拒操作（改筹码、加人、清空其他人、改桌型、换 Hero 位置、换人、清手牌、跳着填公共牌、非法动作）状态**逐字节不变**、底池不变、`undo` 深度与 `revision` 都不变；撤销一次行动后底池与指纹精确恢复。 |
| 9 | 撤销后 / 被拒操作后筹码未恢复 | **clean**。非整百筹码（37BB）全下后撤销，座位筹码、底池、指纹都精确恢复（含 6 位小数往返）。 |
| 15 | `NEW_TABLE` 未清干净 | **clean**（除 RT-L9 的 Hero 筹码口径）。玩家对象只剩 Hero、其余座位 `EMPTY`、台账/公共牌/手牌/handActive/`lastHandRemainingStacksBB` 全部清空、`nextPlayerNumber` 复位且之后加人无 id 冲突。 |
| 附 | 按位置查画像（规范禁止 `getProfile(position)`） | **clean**。源码里没有按位置查画像的入口；适配器按 `seat → playerId → playersById` 解析，画像随人走。 |
| 附 | 跨手泄漏 | **clean**。下一手只留下 `lastHandRemainingStacksBB`（**没有任何消费者**，也进不了决策链），弃牌/全下状态清空，画像按设计保留。 |
| 附 | `nextHand` 是否静默丢筹码 | **不是静默，已明示**。下一手前 `剩余 59650 + 底池 350 = 60000`，下一手后 `59650` —— 差额恰好等于底池；`notices` 明确写「底池**未分配**…赢家请手动改回」。属已文档化限制。 |
| 附 | 伪造/损坏状态 | 除 RT-L7（服务器自产）外，**全部被拒**：重复 `playerId`、`visualIndex` 不一致、非法牌面、手牌与公共牌重复、`handActive` 矛盾、非法 `notices`/`lastHandRemainingStacksBB`/`lastHandComplete`、`sitOutNextHand` 非布尔。 |
| 附 | `undo` after `nextHand` / after `newTable` | **clean**（见向量 7）。 |
| 附 | `setTableSize` 6↔9 有人时是否丢人/重复 | **clean**。6→9 原有玩家一个不少、无重复绑定、画像随人；9→6 被移除位置上的玩家对象仍可追溯、Hero 只占一个座位（提示口径见 RT-L8）。 |
| 附 | `setHeroPosition` 目标座位有人 | **clean（修复后）**。Hero 筹码跟人走、被顶掉的玩家对象保留且不再占座、notice 点名（RT-L3 已复验）。 |
| 附 | 两个座位绑定同一 `playerId` | **clean**。`parseTableState` 明确拒绝并给出两个 seatId。 |
| 附 | `commit`/`patch`：`revision` 是否单调、是否原地改状态 | **clean**。改动路径 `Δrevision=+1`、空操作 `Δ=0`；18 个操作的`原地修改`检测次数为 **0**（全不可变）。 |
| 附 | 客户端 UI 流程（真实 DOM + 真实服务端） | RT-L2/L4/L10 修复后 **clean**；残留 RT-L6。 |

## 12. 明确声明「本轮未发现」的项（不夸大、不编造）

- 未发现任何路径能让**引擎看到与屏幕不同的位置/玩家/筹码/底池**（除 RT-L7 的「整张桌子不可用」，它不是分叉而是直接死掉）。
- 未发现 Fold / Leave / SIT_OUT / 换人 / 换桌型 / 换 Hero 位置会删改当前手的 `actionHistory`。
- 未发现两套 playerId（牌桌 `p1/p2…` 与引擎 `seat_UTG…`）在适配器里被混用（这正是 RT-L1 的教训，现已由源码 + 探针双重确认）。
- 未发现被拒绝的操作留下任何副作用。
- 未发现 `undo` 会恢复到「从未存在过的状态」。

## 13. 已文档化限制（**不算缺陷**，此处只做如实记录）

1. 冻结的 Poker Core 要求「N 人桌恰好 N 位玩家」：`EMPTY` 或 `SITTING_OUT` 座位使分析不可能，
   这一条在预览里如实显示为阻塞原因；
2. `NEXT_HAND` 不分配底池（本项目不建模牌局结果），提示语明确要求手动修正赢家筹码；
3. ≥3 名活跃对手返回「信息不足」；
4. 快速画像多数情况下不改变最终置信度（范围可信度 0.3 已是最小分量）；
5. `lastHandRemainingStacksBB` 只是显示用提示，没有任何消费者。

---

## 14. 结论

**判定口径（写清楚以便复核）**：本轮的三条锁死不变量
（`Fold ≠ Leave Table`、`Seat ≠ Player`、`当前 Hand 的历史事实不因离桌被删除`）是否成立；
以及是否存在**未修复的静默错误**（屏幕与后端分叉 / 错误的位置·玩家·筹码·底池·画像进入决策）。
可见的、有明确提示与恢复路径的缺陷按 MAJOR/MINOR 记录，不单独作为 FAIL 依据。

按此口径，在**冻结版本**上：

- 三条不变量全部成立（向量 2 / 3 / 4 / 5 的探针全部通过，且历史台账、底池、投入逐位不变）；
- 本轮最危险的一类缺陷（RT-L1：后端收到**错误玩家**的画像/动态）已被发现、修复并在冻结版本上复验通过；
- 其余红队报出的 CRITICAL/MAJOR（RT-L2/L3/L4/L5）同样修复并复验通过；
- **未修复项为 2 个 MAJOR + 2 个 MINOR**，全部是「可见、有提示、有恢复路径」的类型：
  RT-L6（暂离无法从界面取消，可用「撤销」绕）、RT-L7（仅 API 可达的死牌桌）、
  RT-L8/RTL9（提示语口径）。没有任何一条会静默产生错误决策或让后端与屏幕分叉。

因此本轮**通过**，但 RT-L6 / RT-L7 建议在下一轮开始前修掉（两者都是几十行内的确定性修复）。

### 若要判 FAIL，唯一的候选是

| 候选 | 为什么可能被要求判 FAIL | 我为什么仍判 PASS |
|---|---|---|
| RT-L7 | 「服务器返回 `ok:true`，却给出一副自己校验器都不接受的牌桌」在原则上是不可接受的（本轮专门为这类问题加了结果自校验，却漏了新建分支） | 随附 UI 不可达（前端硬编码 BTN + 位置按钮按桌型过滤），影响面限于直接调用 HTTP 接口；不产生错误决策 |

---

# 红队判定：PASS
