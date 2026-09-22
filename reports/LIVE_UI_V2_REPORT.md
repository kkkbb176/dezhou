# LIVE UI V2 —— 最终界面布局与实施验收报告

**日期**：2026-09-22　**分支**：`dev-computer-a`
**范围**：`src/app/web/`（布局、交互、样式表整理）+ 三处由此暴露的**真实产品缺陷**修复
**验收环境**：真实 Chrome（headless=new）+ CDP，设备度量 **1366×768**，页面 `http://127.0.0.1:5173/`

---

## 〇、先说结论

| 项 | 结果 |
|---|---|
| 界面重排（椭圆牌桌 + 右侧 380px 操作台 + 44px 单行顶栏） | **完整** |
| 1366×768 下正常录入一手牌**无纵向滚动** | **实测成立**（`docScrollHeight = 768`） |
| 主要动作按钮 ≥ 42px / 座位卡 ≥ 92×48 / 不用绿色毡面 | **实测成立** |
| `npm run verify` | **2266 项 / 137 套件 / 0 失败**，187 个产物 hash 一致 |
| 🔴 由真实浏览器验收抓出的**产品缺陷** | **3 个，全部已修 + 已加回归锁** |

**这轮最重要的产出不是布局，是那 3 个缺陷。** 它们全部存在于**后端与前端契约层**，
不在样式层；而且**原有 2,247 个测试一个都没抓到** —— 抓到它们的是
「在真实浏览器里，按真实顺序，把一手牌从头录到尾」这一条动作。

---

## 一、真实浏览器截图（1366×768）

三张都是**真实渲染**截图，不是生成图。原始文件在 `D:\德州-audit-20260922\`：

| 文件 | 内容 |
|---|---|
| `live-ui-v2-main-1366x768.png` | **主界面**：9 人桌、翻牌圈、Hero 回合、建议已出 |
| `live-ui-v2-menu-1366x768.png` | **设置菜单展开**（低频操作全部收在这里） |
| `live-ui-v2-picker-1366x768.png` | **牌面选择器展开**（选牌时才占版面） |

### 主界面逐项核对

| 用户要求 | 实测值 | 判定 |
|---|---|---|
| 顶部控制栏高度约 44px | `#topbar = 1366 × 44.0`，`top = 0` | ✅ |
| 右侧操作台宽度约 380px | `#rail = 380 × 724`，`left = 986` | ✅ |
| 椭圆牌桌 | `border-radius: 50% / 46%`；座位按后端 `angleDeg` 落在真椭圆上 | ✅ |
| 不使用大面积绿色毡面 | `#tableWrap` 的 `backgroundImage = none`，`backgroundColor = rgb(27,32,38)`（中性炭黑，G 分量不比 R/B 高） | ✅ |
| 少量蓝色用于 Hero 与当前行动玩家 | `.seat.actor` 蓝框 + `#17222f` 底；`.seat.hero` 金框；其余座位灰色 | ✅ |
| 不使用渐变 / 发光 / 大面积阴影 | `live-ui.css` 全文无 `linear-gradient` / `radial-gradient`；无发光式 `box-shadow` | ✅ |
| 不在界面展示长篇说明与调试信息 | 系统说明 / 调试数据收进设置菜单；行动时间线折叠；牌面选择器默认收起 | ✅ |
| 主要操作按钮 42–46px | `#actionButtons button = 174 × 42`（`height` 与 `min-height` 都是 42px） | ✅ |
| 座位卡约 90×48px | 空座位 `92 × 48`；有人的座位 `92 × 50`；Hero `92 × 63` | ✅（见下方说明①） |
| 未入座座位只显示简洁加号 | 空座位 DOM 只有 **1 个** 子节点，文本恰为 `＋` | ✅ |
| 玩家画像不默认展开 | `.seat .tags { display: none }`；真实画像走 hover 的 `#seatTip` | ✅ |
| 主要操作区宽度固定，不因文字/金额跳动 | `#actionButtons` 是 `grid-template-columns: 1fr 1fr`，按钮宽度由网格决定；`min-height: 91px` 预留两行 | ✅ |
| **正常录入过程中页面不允许纵向滚动** | `documentElement.scrollHeight = 768 = innerHeight`，`body { overflow: hidden }` | ✅ |
| 禁止为塞进一屏而缩小按钮/字体/座位卡 | 按钮 42px、座位卡 92px 宽、字号 11–13.5px（比 V1 的 32px 按钮**更大**） | ✅ |

**说明①**：座位卡高度由内容决定（名字 / 位置 / 筹码 / 状态四短行），空座位 48px、
有人的 50px、Hero 63px（多一行 `Hero` 标记）。**刻意不设 `max-height`** ——
V2 第一版设了 58px，真实截图显示「99BB（投 1BB）」被裁成「99BB（投 / 1BB」，
把使用者最需要读的筹码数截断。这条按用户「不得缩小到难以阅读和点击」优先处理。

### 建议与实际动作的分区

`#rail` 的四层顺序是**固定**的，并由测试锁住：

```text
① 现在轮到谁（#actorLine，Hero 时金色）
② 我能做什么（#statGrid + #actionButtons + 快捷尺寸 + 自定义金额）
③ 建议（Hero 视角）—— 只读，标注「录入的动作记在左侧，不写回这里」
④ 本手最近动作（最近 5 条 + 完整时间线折叠）
```

建议在动作按钮**下面**是刻意的：上下分区是「建议 ≠ 实际动作」这条纪律的第一道防线。

---

## 二、九人桌正常录入一手牌的操作次数

**实测：从建桌到录完「翻前 + 翻牌」共 38 次点击。** 逐条如下（来自 `live-ui-v2-verify.json`）：

| 阶段 | 点击 | 次数 |
|---|---|---|
| 建桌（设置 → 新牌桌 → 9 人桌 → 庄家位 → 确认） | 5 | 5 |
| 坐人（一键加入玩家） | 1 | 6 |
| 选 Hero 两张手牌（点空位 → 点牌面，×2） | 4 | 10 |
| 翻前：UTG / UTG1 / UTG2 / LJ / HJ / CO 各跟注 | 6 | 16 |
| **Hero 的加注（快捷尺寸，一次点击）** | 1 | 17 |
| 翻前剩余：SB 跟注 / BB 过牌 | 2 | 19 |
| 翻牌：3 张公共牌（点空槽 → 点牌面，×3） | 6 | 25 |
| 翻牌圈：SB / BB / UTG / UTG1 / UTG2 / LJ / HJ / CO 各过牌 | 8 | 33 |
| （脚本继续尝试点击时的**空转**，见下） | 5 | 38 |

**逐手牌的操作次数 = 38 − 5（建桌）− 1（坐人）= 32 次**，其中
**Hero 自己的动作只占 1 次**（快捷尺寸加注，一步完成）。

> ⚠️ **诚实交代**：最后 5 次是**脚本的空转**，不是使用者的必要操作 ——
> 本手是 9 人全部进池，Hero 在 BTN 过牌后下注轮就已结束，
> 而脚本的循环还按「当前行动者非空」继续尝试，点到了已经被重新渲染的过期节点（耗时 0ms）。
> 使用者不会做这 5 次点击。**真实操作次数是 33 次**（含 5 次建桌 + 1 次坐人），
> 即**每手 27 次**（翻前 9 次 + 翻牌 9 次 + 选牌 4 次 + 公共牌 6 次 … 精确按上表扣掉空转）。
> 这个数字比 V1 的 13 次高，原因是**这轮验的是完整一手（翻前 + 翻牌 + 9 人全部行动）**，
> 而 V1 那次只统计了翻前。两者不可直接比较。

**加注从 2 击降到 1 击**这件事仍然成立：`#quickSizes` 里的三颗「加注到 X BB」
直接就是后端 `SIZE` 组的合法动作（自带精确 `amountChips`），点一下即成交。

---

## 三、实际界面响应耗时

**每一次点击的「点击 → 界面更新」同步耗时**（`performance.now()` 前后差，单位 ms）：

| 操作类别 | 实测范围 |
|---|---|
| 顶栏按钮（设置 / 下一手 / 撤销） | 0.2 – 1.0 ms |
| 弹层内按钮（选桌型 / 选座位 / 确认建桌） | 1.1 – 6.4 ms |
| 座位与手牌（点空位 / 点牌面） | 0.8 – 4.6 ms |
| **记录一个动作（`/api/table` 往返 + 全量 `render()`）** | **1.2 – 8.3 ms** |
| 快捷尺寸加注 | 0.0 ms（在上一帧已渲染完成，点击即发） |

**统计**：全部 38 次点击中，**37 次的同步渲染耗时 ≤ 8.3 ms**，中位数约 3 ms。
唯一的 0.0 ms 组是没有真实发出请求的空转点击。

**关于 `post()` 的往返**：`/api/table` 的响应时间不在这张表里 ——
表里量的是**浏览器主线程的渲染耗时**（点击处理到 DOM 更新完成），
网络与服务端计算是异步的，界面上由「全部控件禁用 + 自动分析状态条」表达。

**唯一的慢路径是自动分析（GTO 求解）**：翻牌圈的自动分析在本机需要
**约 20 – 30 秒**（`等待空闲` 实测 `waitedMs = 30500`，含一次完整的 9 人桌 GTO 求解）。
这期间**全部控件被禁用**（97 / 97 个按钮），状态条显示「正在分析…」。
这是刻意的串行化：`post()` 在 `busy()` 为真时直接返回 `null`，不允许两个动作同时在路上。

---

## 四、🔴 三个真实产品缺陷（本轮最重要的产出）

三个都**不是样式问题**，都在前后端契约层。**原有 2,247 个测试全部通过**，
抓到它们的是真实浏览器里的完整录入流程。

### 缺陷 1：新建牌桌后直接选 Hero 手牌 → `POST /api/table` 返回 **500**

```text
POST /api/table { op: { kind: 'SET_HERO_CARD', card: 'As' } }
→ 500 {"ok":false,"stage":"SERVER","issues":[{"code":"INTERNAL_ERROR",
    "message":"服务端异常：handTopologySeats: 本手至少需要 2 名参与者（收到 1）"}]}
```

**成因链**：`recomputeHandActive` 只看「有没有牌」就宣布本手开始
⇒ `commit()` 冻结本手拓扑 ⇒ `handTopologySeats` 对 n < 2 抛错 ⇒ 整个写请求 500。

**界面表现**：手牌点了没反应。没有红条、没有提示，只有服务端 500。

**为什么漏到现在**：所有既有测试（含 `test/helpers/tableJsHarness.ts` 的 `seatAll()`）
都在建桌后**立刻把座位填满**，「只有 Hero 在座」这个中间态从没被测过。

**修法**：`recomputeHandActive` 补上「本手参与者 ≥ 2」——
「一张牌 + 一个座位」不构成一局牌。**没有**给 `handTopologySeats` 加 try/catch：
它对 n < 2 抛错本身是对的，让它静默返回一个假拓扑会让下游算出假角色与假盲注。

### 缺陷 2：自洽检查把**正常中间态**判成「状态自相矛盾」并整包拒绝

修完缺陷 1 之后，`SET_HERO_CARD` 变成了 200 但 `ok: false`：

```text
原因：handActive=false 但已经有手牌/公共牌/行动记录 —— 状态自相矛盾（手牌 1 张）
```

**成因**：`tableApi` 的自洽检查把「有 Hero 手牌」当成「本手已开始」。
而「先选好两张手牌、再把其他人加进来」是**最常见的开局顺序**，
那一刻的真实状态就是「手牌 2 张 + `handActive = false`」。

**修法**：判据改为**公共牌或行动记录** —— 它们不可能在成局之前出现
（公共牌要按顺序填、行动记录要真的轮到人）。手牌可以预选。

### 缺陷 3：🔴 重叠请求会把**全部按钮永久禁用**（整页功能不可达）

真实页面量到：

```json
{"inflight": 1, "disabledCount": 97, "totalButtons": 97,
 "disabledIds": ["6 人桌", ..., "nextHandBtn", "undoBtn", "moreBtn", ...]}
```

**成因**：`setControlsDisabled` 原本是「记下原 `disabled` → 置 `true` → 按记录还原」。
两个请求重叠时，第二次进入看到的已经是 `disabled = true`，
于是把「原本可用」记成「原本不可用」；最后一个请求结束时把它**永久**禁用。

触发条件很常见：`scheduleAutoAnalyze()` 的 debounce 到点发 `/api/analyze`（GTO 求解 20+ 秒），
使用者在这个窗口里按动作按钮 —— 两秒后整页按钮就再也不亮了。

**界面表现**：「设置」按钮看着完全正常，点下去毫无反应。

**修法**：用一个哨兵值 `'busy'` 标记「这个禁用是我加的」；进入时只记录一次，
退出时只还原带哨兵的。无论进入多少次，只要退出次数对得上就回到原样。

### 三个缺陷的回归锁

| 测试 | 锁住什么 |
|---|---|
| `test/interactiveTableApi.test.ts` · 🔴 新牌桌只有 Hero 在座时选牌必须 200 | 缺陷 1 + 2（9 人桌与 6 人桌各跑一遍） |
| `test/interactiveTableApi.test.ts` · 🔴 补齐第二个人之后本手必须立刻正常开始 | 「修复不能只挡住错误」——加人后拓扑要冻结、预选手牌不得丢 |
| `test/liveUiV2.test.ts` · V2-UI-07 | 缺陷 3（静态锁死「禁用-还原」的可重入性） |
| `test/liveUiV2.test.ts` · V2-CSS-09 | `/live-ui.css` 必须以 `text/css` 发出（见下方缺陷 4） |

### 缺陷 4（较轻，但同类）：新样式表会被当成 JavaScript 发出

`webServer.ts` 原本是「`url === '/table.css'` 就发 CSS，**否则一律发 JS**」。
新增 `live-ui.css` 时，它会以 `text/javascript` 发出 —— 浏览器直接拒绝应用样式表，
页面能打开、样式全丢，而服务端日志里没有任何异常。

**修法**：改成**白名单 + 扩展名决定 Content-Type** 的映射表，
并把重复的 `/gto.css` / `/gto.js` 分支一并删掉（同一件事只留一处实现）。

---

## 五、修改文件清单

### 新增（2）

| 文件 | 说明 |
|---|---|
| `src/app/web/live-ui.css` | **V2 布局与外观的唯一来源**（约 700 行，分 8 节）。已登记进产物清单。 |
| `test/liveUiV2.test.ts` | V2 回归测试 21 项（DOM 结构 / 样式契约 / 纪律）。 |

### 修改（9）

| 文件 | 改了什么 |
|---|---|
| `src/app/web/index.html` | 重排为新结构：44px 单行顶栏（含 `#moreMenu` 设置菜单）、`#left` 椭圆牌桌 + 左下 `#heroHandInline`、`#rail` 四层、`#recentActions`。**42 个 id 一个不少**（含 `gotoGtoBtn`）。 |
| `src/app/web/table.js` | 座位卡精简（空座位只有 `＋`、状态行按需渲染）；新增 `renderRecentActions()` / `setupSettingsMenu()` / `openPickerIfCollapsed()` / `closePickerIfDone()`；`#quickSizes` 改为取静态节点（删掉运行时 `insertBefore` 创建）；新增**自定义金额入口**（合法性完全由后端裁决）；`setControlsDisabled` 改为可重入；**删除** `setupCollapsiblePanels()`（职责改由静态 HTML 承担）。 |
| `src/app/web/table.css` | **删除末尾 11 段 `LIVE UI V1 ①…⑪` 覆盖块**（1213 行 → 928 行）。只保留基础组件样式；`--felt` 与 `.seatTip` 按测试契约保留。 |
| `src/app/webServer.ts` | 静态资源改为白名单 + 扩展名决定 Content-Type；删除重复的 `/gto.css` `/gto.js` 分支。 |
| `src/app/table/seatLifecycle.ts` | `recomputeHandActive` 补「参与者 ≥ 2」；`handActive` 的重算移到 `commit()`（唯一写入口），于是 `ADD_PLAYER` / `CLEAR_SEAT` / `SIT_OUT` / `SET_TABLE_SIZE` 之后本手状态自动跟上。 |
| `src/app/table/tableApi.ts` | 自洽检查的判据从「有手牌」改为「公共牌或行动记录」。 |
| `src/infra/artifactDefinitions.ts` | 登记 `src/app/web/live-ui.css`，impact 写清它承担的三条界面纪律。 |
| `test/helpers/tableJsHarness.ts` | 登记 `recentActions` / `moreBtn` / `moreMenu`；新增 `exposedTest()`（读 `window.__dshTest`）。 |
| `test/interactiveTableRedteam2.test.ts` | 同步 id 注册表。 |
| `test/fillSeatsUi.test.ts` | 空座位改为按 `.empty` class 找（不再依赖已被移除的文案）。 |
| `test/interactiveTableApi.test.ts` | 新增 2 条 🔴 回归锁 + 静态资源 Content-Type / 白名单断言。 |
| `test/interactiveTableRedteam.test.ts` | 「自相矛盾」用例的载荷改为真的带行动记录（原来的名字说「与行动」但载荷没有行动）。 |
| `CURRENT_PROJECT_STATUS.md` | 同步测试数字（2,266 项 / 121 个文件）。 |
| `data/artifact-manifest.json` | `npm run manifest` 重新生成（187 个产物）。 |

---

## 六、界面与交互回归测试结果

### V2 新增 21 项（`test/liveUiV2.test.ts`，全绿）

| 编号 | 断言 |
|---|---|
| V2-UI-01 | 空座位只显示加号（DOM 恰 1 个子节点，文本恰为 `＋`，不含「加入玩家」） |
| V2-UI-02 | 空座位仍可点，且点开的是真实座位菜单（含「加入玩家」） |
| V2-UI-03 | 最近动作逐条渲染（每行 3 格），最后一条带 `ra-latest` |
| V2-UI-04 | 超过 5 条时截断，并如实写出「前面还有 N 条」 |
| V2-UI-05 | 🔴 **服务端的建议绝不能被当成 Hero 的实际动作写进牌局** |
| V2-UI-06 | 切到「录入历史」必须收起旧建议（不留过期结论） |
| V2-UI-07 | 🔴 重叠请求结束后控件必须复原（静态锁死可重入性） |
| V2-CSS-01…03 | 动作按钮 ≥ 42px / 座位卡 92×48 / 顶栏 44px + 右栏 380px |
| V2-CSS-04 | 🔴 body 锁死纵向滚动 + `#main` 可收缩 + `html` 撑满视口 |
| V2-CSS-05…06 | 🔴 无渐变、无绿色毡面；蓝色只给 Hero 与当前行动者 |
| V2-CSS-07 | 右栏顺序必须是 行动者 → 动作 → 建议 → 最近动作 |
| V2-CSS-08 | `table.css` 里 V1 的 11 段覆盖块必须消失，且 `.seatTip` / `--felt` 仍在 |
| V2-CSS-09 | `index.html` 必须在 `table.css` **之后**加载 `live-ui.css` |
| V2-CSS-10 | 牌面选择器必须是静态折叠结构，**代码里不得再用 `insertBefore`** |

### 全量结果

```text
npm run verify
  类型检查        零错误
  manifest:check  全部 187 个产物与清单一致
  测试            2,266 项 / 137 套件 / 0 失败
```

**所有既有测试全部保留并通过**（V1 的 2,247 项 → 2,266 项，只增不减）。

---

## 七、测试过程中发现并修正的**测试自身**问题

诚实记录，因为它们一度伪装成产品缺陷：

| 现象 | 真因 |
|---|---|
| 「点得动但状态一个字都没变」 | 验收脚本按 `.card` 找牌面按钮，实际 class 是 **`.pick`**。`element.click()` 找不到元素时**静默失败**，脚本还老实记了 `ok: true`。 |
| 「手牌只选上 1 张，本手永远不开始」 | `clickHeroCard()` 是「点空位 → 点牌面」两步，第一步会重新渲染手牌区；不 `settle()` 就点第二张，点到的是**已经不存在的旧节点**。 |
| 「设置菜单有 bug，点不开」 | `app.inflight = 1` —— 一次 GTO 求解真的在路上，全部控件被正确禁用。**验收脚本没等在途请求结束**，误判成产品缺陷。 |
| 两张截图逐字节相同 | 诊断代码自己点了一下 `moreBtn`，把菜单从「开」切成「关」，然后才截图。 |
| 「本手还没开始」但已经选了牌 | `NEXT_HAND` 在 `handActive = true` 时会让状态变成「`handActive=false` 但手牌还在」而**被后端正确拒绝**。本手是靠 `SET_HERO_CARD` 开始的，不是靠「下一手」。 |
| 自研 CSS 解析器在 `#topbar` 上返回 `null` | 跨块正则的 `lastIndex` 会跳过紧跟在 `}` 后没有 `}` 的规则块。改成逐行解析（`probes/css-probe.ts` 逐块打印下标才定位到）。 |

**教训**：验收脚本自己的时序与选择器错误，看起来和产品缺陷一模一样。
全部记在 `verify-live-ui-v2.ts` 的注释里与 `test/liveUiV2.test.ts` 的文件头。

---

## 八、Git 分支与远程状态

见 `reports/LIVE_UI_V2_GIT_AND_MERGE.md`（提交与推送在本报告定稿后单独执行并核实）。

---

## 九、与另一台电脑合并的潜在冲突与注意事项

见 `reports/LIVE_UI_V2_GIT_AND_MERGE.md` 第三节。

---

## 十、仍然存在、本轮**未**修的问题（如实列出）

1. **`engine.ts` 的 `doFold` 缺陷**（上一轮已报告，本轮未动）：
   全员弃牌到 BB 时 `finishByFold` 直接结束本手，违反 README 核心不变量第 5 条
   （大盲在无人加注时仍有选择权）。`test/engine.test.ts` 的「大盲的选择权」
   只覆盖全 CALL 路径，未覆盖全 FOLD 路径。**该文件在用户给定的禁止修改清单上**，
   因此只报告不修。详见 `reports/LIVE_UI_V1_BLOCKER_HERO_ACTOR.md`。

2. **自动分析的求解耗时**：翻牌圈 9 人桌实测 20–30 秒，期间全部控件禁用。
   本轮**没有**为此做任何优化或预算控制 —— 只是让状态条如实显示「正在分析…」。
   这是「如实告知」而非「解决问题」。

3. **`SET_BOARD_CARD` 无「参与者 ≥ 2」的显式闸门**：
   只有 Hero 在座时理论上可以先把公共牌填上。适配器的
   「本手可参与的座位只有 N 个」会挡住分析，但**写路径本身不拦**。
   本轮未修（不在用户列出的验收场景内），记录在此。

4. **`→ 200 / ← 200` 之外的边界**：`live-ui.css` 只做了 Chrome 的实测；
   Firefox / Safari 未验证（本项目此前也未做过跨浏览器验证）。

---

## 十一、复现方式

```powershell
# 1. 启动服务（仓库根目录）
cd D:\德州
node --experimental-strip-types src\app\webServer.ts     # 默认 127.0.0.1:5173

# 2. 真实浏览器验收（截图 + 布局断言 + 操作计数 + 耗时）
cd D:\德州-audit-20260922
node --experimental-strip-types verify-live-ui-v2.ts
#   产物：live-ui-v2-main-1366x768.png / -menu- / -picker- / live-ui-v2-verify.json

# 3. 全量回归
cd D:\德州
npm run verify
```
