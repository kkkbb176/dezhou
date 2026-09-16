# 交互式牌桌录入层 · 适配器/卡牌/竞态/前端诚实性 独立红队报告

> 审计对象：`D:\德州` · 交互式牌桌录入（`src/app/table/*`、`src/app/web/table.js`、`src/app/webServer.ts`）
> 审计方式：**独立探针**（自建 DOM 桩驱动真实 `table.js` + 真实 HTTP 服务端；不使用作者夹具、不修改 `src/` 与 `test/`）
> 审计范围：适配器保真度 · 卡牌映射 · 竞态与重复提交 · 前端诚实性（§90 / §27 / §29）· Fail-Closed · 性能
> 证据文件：`scripts/rt-table-adapter-evidence.txt`（探针 #1 + #2 的**逐字原始输出**，本报告所有「实际观测值」均可逐行核对）

---

## 0. 快照、探针与可复现命令

### 0.1 审计期间的版本漂移（必须写在最前面）

本轮审计窗口内 `src/` 被作者**多次修改**（含一次「冻结」之后的再次修改）。因此：

| 时点 | 事件 |
|---|---|
| 13:05–13:09 | 作者持续修改（`tableAdapter` / `tableApi` / `seatLifecycle` / `tableState` / `table.types` / `table.js`） |
| **13:09:19** | 作者宣布冻结 |
| 13:16:10–13:17:22 | **冻结之后又改**：`tablePreview`（ALL_IN 去掉金额、新增 `EXPAND` 组、改用 `effectiveStackBetween`）、`table.types`、`tableOps`、`seatLifecycle`、`tableApi` |
| 13:18:21–13:18:56 | 针对本报告 F-01 / F-02 / F-03 / F-06 / F-07 的修复落盘 |
| **13:18:56** | **最终快照**（此后 `src/` 无写入，探针连续两次运行结果一致） |

**红队判定针对的是 13:18:56 的最终快照。** 13:09:19「冻结版」以及 13:16–13:17 的中间版本在本轮红队下**不是干净的**（见 §1 的 F-01 / F-02）。本报告把审计窗口内**真实命中**的缺陷逐条留档，并给出「修复前快照 / 修复后复核」两边的原始证据。

### 0.2 最终快照（`scripts/rt-table-adapter-evidence.txt` §0 逐字复现）

| 文件 | SHA256 前缀 | mtime |
|---|---|---|
| `src/app/table/tableAdapter.ts` | `ac4ef748a39603ec` | 13:05:22 |
| `src/app/table/tablePreview.ts` | `4c0d51745055d866` | 13:17:22 |
| `src/app/table/tableOps.ts` | `87aa2d143ff32602` | 13:16:21 |
| `src/app/table/tableApi.ts` | `bf37c85e31a021b5` | 13:18:44 |
| `src/app/table/tableState.ts` | `2cbe1e96fd9fc402` | 13:06:32 |
| `src/app/table/seatLifecycle.ts` | `4023fc6eefbfe6be` | 13:17:43 |
| `src/app/table/table.types.ts` | `0812db7ad78c2e99` | 13:18:56 |
| `src/app/web/table.js` | `0299c760578f15ee` | 13:18:21 |
| `src/app/webServer.ts` | `b52c3a79c72ff59a` | 13:18:39 |
| `src/app/manualInput/manualInput.ts` | `f4cfd65839dd3b0c` | 12:40:34 |
| `src/app/manualInput/reconstruct.ts` | `06d435b96db79855` | 12:38:42 |
| `src/app/manualInput/legalActions.ts` | `377f3ebc1f905561` | 10:01:28 |

（另：F-01 命中时的 `table.js` = `580b6fcd6a889e25`；F-02 命中时的 `tablePreview.ts` = `84a091baf7fe47a4`、`table.types.ts` = `25f0bceab86f0f53`；F-04 命中时的 `tablePreview.ts` = `66ed308404face26`。）

### 0.3 探针

| 脚本 | 覆盖 |
|---|---|
| `scripts/rt-table-adapter-probe.ts` | 卡牌映射(10) · 视觉vs逻辑(11) · §90 三方一致 · 有效筹码口径 · 跨手泄漏(14) · NEW_TABLE(15) · `seatStacksBB` · 空座/暂离 · **按钮穷举属性检查**（§27/§29 + 往返等价）· 竞态/双击(12/13) · 畸形载荷 · meta · 体积与性能 |
| `scripts/rt-table-adapter-probe2.ts` | 极简 DOM 桩 + **真实 `table.js`** + 真实 HTTP：网格点击→提交代码 · 双击 · §90 三方一致（屏幕渲染文本 vs 拦截到的提交载荷 vs 后端重放指纹）· 成功建议是否真的渲染 · 离桌决策弹层 · 全下按钮真实点击 |

```
node.exe --experimental-strip-types "scripts/rt-table-adapter-probe.ts"
node.exe --experimental-strip-types "scripts/rt-table-adapter-probe2.ts"
```

**最终快照结果：探针 #1 `OK=36 HIT=0 INFO=5`；探针 #2 `OK=7 HIT=0`。**
**审计期间（修复前快照）命中：探针 #1 `HIT=10~11`、探针 #2 `HIT=3`。**

---

## 1. 总览：发现清单

| # | 严重级别 | 一句话 | 命中时快照 | 最终状态 |
|---|---|---|---|---|
| F-01 | **CRITICAL** | `table.js` 的 `box.appendChild(... ? box : box)` = 把 `box` 插进自己 → 真实 DOM 抛 `HierarchyRequestError` → **分析成功的建议永远显示不出来**，且 `render()` 后半段（时间线/调试/按钮可用性/**弹层**）全部不执行 | `table.js 580b6fcd` | **已修复**（13:18:21），红队复核通过 |
| F-02 | **CRITICAL** | 后端把「展开尺寸」按钮的 `group` 改成 `'EXPAND'`，而 `table.js` 只认 `'PRIMARY'/'SIZE'` → **下注/加注及其全部合法尺寸按钮从屏幕上消失**，用户只能弃牌/过牌/全下（屏幕不再提供后端已判定的合法动作） | `tablePreview 84a091ba` + `table.js 580b6fcd` | **已修复**（13:18:21），红队复核通过 |
| F-03 | **MAJOR** | 客户端自持状态（含最多 60 层撤销栈）在**一手牌 + 十几次操作**后就顶到服务端请求体上限：实测 87.7KB → 第 14 次请求 **128.8KB** → 服务端 `req.destroy()` → 客户端只看到 `fetch failed`，且会一直重发同一个超限状态（**只能刷新页面 = 丢桌**） | `webServer.ts 71d1f897`（上限 128KB） | **已修复**（上限提到 1MB + 结构化拒绝），复核通过 |
| F-04 | **MAJOR** | 「全下」按钮携带 `allInToAmount`（= 本街总额），而引擎 `doAllIn` 要求 `amount === 剩余筹码`；**只要本街已投入过筹码**（SB/BB 盲注、平跟后面对加注、下注后被加注）→ 按钮被后端拒绝；连「按引擎语义填对金额」也因**落库金额同样用了本街总额**而通不过重放自检 → 该动作在牌桌上**完全不可达** | `tablePreview 66ed3084` + `tableOps d94b8f2a` | **已修复**（ALL_IN 不再携带金额），复核通过 |
| F-05 | **MAJOR** | 「有效筹码」有两个定义：屏幕面板用 `preview.effectiveStackBB`（所有未弃牌且能下注者的最小剩余），决策引擎用 `min(我, 首要对手)` → 实测 **19BB vs 99BB**（两名活跃对手、筹码不同）与 **99BB vs 0BB**（面对全下，SPR 0.00） | `tablePreview 66ed3084` | **已修复**（改用 `effectiveStackBetween`），复核通过 |
| F-06 | **MINOR** | `POST /api/table` 传 `{op:{kind:'ACT'}}` 或 `{op:{kind:'ACT',action:null}}` → **HTTP 500**（读 `request.type` 抛 TypeError），违反 `tableApi.ts` 头部「不抛异常」的契约；同类还有 `amountChips` 类型不校验（字符串 `"500"` 被 JS 隐式转换后**照常落账**）、非字符串牌面被存入公共牌 | `tableApi 4bc7e8ad` / `tableApi bf37c85e` 之前 | **已修复**（0 × 5xx），复核通过 |
| F-07 | **MINOR** | `table.js` 自己硬编码离桌选项与中文标签（`FOLD_AND_LEAVE` / `LEAVE_AFTER_HAND` / `CANCEL`），而 `meta.leaveChoices` 已提供同一份数据；`meta.seatStatuses` / `occupiedStatuses` 从未被消费 | `table.js 580b6fcd` | **已修复**（改用 meta），复核通过 |
| I-01 | INFO | `NEW_TABLE` 会保留撤销栈 → 新建牌桌后按 UNDO 可把旧牌桌连同全部 Villain 画像恢复 | 全窗口 | 属撤销语义，非缺陷（已在报告中标明） |
| I-02 | INFO | `{}`（无 `state`）被当成「新建牌桌」并静默使用默认 6 人桌 / BTN；`bigBlindBB=2` 这类非 100 面额被接受（只影响显示口径，不影响任何 BB 口径判断） | 全窗口 | 设计如此 |
| I-03 | INFO | 未被丢弃的**陈旧响应**仍会覆盖 `app.preview`（状态被版本保护挡住、预览没挡）→ 需要双标签页才会显现 | 全窗口 | 残余风险（潜在） |
| I-04 | INFO | 动作按钮的 `group` 取值（`PRIMARY`/`SIZE`/`EXPAND`）不在 `meta` 里，前端仍然硬编码 —— F-02 正是这一类漂移的现实版本 | 全窗口 | **建议**把组名并入 meta |

**本轮「干净、有证明」的向量**（详见 §3）：卡牌映射(10) · 视觉vs逻辑(11) · 陈旧响应与重复提交(12/13) · 跨手泄漏(14) · `NEW_TABLE`(15) · §90 三方一致 · §27/§29 前端零规则 · `applyTableAction` 往返等价 · `seatStacksBB` · 空座/暂离拒绝 · 畸形载荷 · 性能。

---

## 2. 逐条发现（最小复现 + 原始观测）

### F-01 CRITICAL —— 分析建议永远显示不出来，且 `render()` 后半段被整个跳过

**最小复现**（探针 #2 §E/§F，真实 `table.js`）：

```
# 用 DOM 桩驱动真实客户端：加满 5 名玩家 → 选 As/Kd → 弃牌到 Hero → 跟注 → 选 K♣7♥2♦ → 过牌到 Hero
# 点「分析当前决策」，然后读屏幕
```

**原始观测**（`scripts/rt-table-adapter-evidence.txt`，探针 #2 §F）：

```
  后端返回的建议=建议：下注
  屏幕 #result 的内容=（空）
  捕获到的前端异常：HierarchyRequestError: Failed to execute 'appendChild' on 'Node': The new child element contains the parent.
[HIT] F1 后端已经返回成功建议「建议：下注」，但 #result 面板是空的
  座位菜单打开=true；后端返回 leaveDecision=true
  弹层 class=show；弹层内容=玩家6 大盲位状态：在座 筹码：100BB…座位管理暂时离座更换玩家清空座位编辑筹码（仅
[HIT] F2 后端要求用户明确选择离桌方式（§8），但由于 render() 在建议面板处抛异常，弹层没有重建 —— 用户看不到必须做的选择
```

**根因**（命中时 `table.js 580b6fcd` 第 711 行，逐字）：

```js
box.appendChild(el('div', null, a.viewModel.actionZh).id ? box : box);
```

三元运算符**两边都是 `box`**，因此无论条件如何，实际执行的永远是 `box.appendChild(box)` —— 把一个节点插进它自己的子树。DOM 规范对此抛出 `HierarchyRequestError`（`The new child element contains the parent`）。

**影响链**（三条，全部可复现）：

1. **决策支持的核心输出看不见**：`a.ok === true` 时 `renderResult()` 在 `clear(box)` 之后立刻抛错 → `#result` 面板保持**空**。用户点「分析当前决策」后界面没有任何建议。
2. **同一次 `render()` 的后半段全部不执行**：`render()` 的顺序是 `… renderActorPanel() → renderTimeline() → renderDebug() → updateActionDisabled() → renderModal()`，`renderResult()` 在 `renderActorPanel()` 末尾 → 时间线、调试面板（含指纹）、按钮可用性、**弹层**都不再更新。
3. **界面进入「半冻结」**：`app.analysis` 一旦被设置就不会自动清空（只有「下一手/重置本手/撤销/新牌桌/清空对手」五个按钮会清），于是**此后每一次 render 都在同一行抛错**。实测后果：分析成功后点座位菜单的「清空座位」，后端确实回了 `leaveDecision`，但 `renderModal()` 没跑 → 弹层仍是旧的座位菜单，**§8 要求「不许默认猜」的离桌选择永远不出现**（F2 实测：弹层里没有「仅标记手后离桌」按钮）。

**修复与复核**：该行已删除（`table.js 0299c760`，13:18:21；原行仅作为注释留档）。同一探针在同一场景下重跑：

```
  屏幕 #result 的内容=建议：下注1.00BB（100 筹码） · 中低 · 边缘决策对对手范围估计权益 89.3% 且明显领先…
[OK] F1 成功分析的建议确实渲染到了 #result
  弹层 class=show；弹层内容=该玩家本手已参与牌局 —— 请选择处理方式玩家6（BB）…仅标记手后离桌取消…
[OK] F2 离桌选择弹层正常显示
```

---

### F-02 CRITICAL —— 下注/加注的尺寸按钮从屏幕上消失（前后端枚举漂移）

**最小复现**（探针 #2 §E，读真实渲染出来的按钮）：

**原始观测**（修复前的中间版本，13:17）：

```
  街道行=翻牌 底池行=底池 2.5BB 行动者行=现在轮到你（我（Hero））
  按钮=弃牌 / 过牌 / 全下（99BB）          ← 修复前：没有任何「下注/加注」按钮
```

对照 13:09 版本与最终版本：

```
  按钮=弃牌 / 过牌 / 下注（选尺寸） / 下注到 1BB / … / 下注到 2.5BB / 全下（99BB）
  按钮=弃牌 / 过牌 / 下注（选尺寸） / 全下（99BB）        ← 最终版本（展开后可选尺寸）
```

**根因**：13:16 的改动把 BET/RAISE 的「展开」按钮 group 由 `'PRIMARY'` 改为 `'EXPAND'`（`tablePreview.ts` 的 `group: 'EXPAND'`）并同步了 `table.types.ts`，但 `table.js`（当时 `580b6fcd`，13:09）仍然只认两个组：

```js
var primary = p.actionButtons.filter(function (b) { return b.group === 'PRIMARY'; });
var sizes   = p.actionButtons.filter(function (b) { return b.group === 'SIZE'; });
```

→ `'EXPAND'` 的展开按钮被整条丢弃 → `app.sizeExpanded` 永远无法被设置 → 尺寸行永远不渲染。同时后端仍在**合法**返回这些动作（同一快照下 11201 次按钮穷举 0 次被拒），所以这是「屏幕不提供后端已判定的合法动作」，与 §27/§29 的契约正好相反：用户除弃牌/过牌/全下外**无法表达任何下注或加注**。

**修复与复核**：`table.js 0299c760` 现在同时接受 `'PRIMARY' || 'EXPAND'` 并按 `button.group === 'EXPAND'` 走展开分支。探针 #2 复核：`按钮=弃牌 / 过牌 / 下注（选尺寸） / 全下（99BB）`，且 `[OK] G1 全下按钮被后端接受`。

> **这属于「注释/文档承诺 ≠ 代码」之外的另一类真实缺陷：跨模块枚举漂移。** 建议把动作组名并入 `GET /api/table/meta`（见 I-04）。

---

### F-03 MAJOR —— 自持状态顶到请求体上限：客户端只能看到网络错误

**最小复现**（探针 #1「性能/体积」段）：满座 + 两张手牌，点满一手牌（24 条行动），然后反复点同一个座位操作（每次 +1 层撤销栈）。

**原始观测**（修复前 `webServer.ts 71d1f897`，`MAX_BODY_BYTES = 128 * 1024`）：

```
  深状态请求体大小 = 87.7 KB（服务端上限 128 KB）
  深状态构成：历史 24 条 + 撤销栈 36 层
  深状态请求第 14 次失败（重试后仍失败，已采样 13 次）：fetch failed；此时请求体 128.8KB，撤销栈 49 层
[HIT] V-SIZE 请求体 228KB 超过 MAX_BODY_BYTES(128KB) → 服务端**销毁连接**，客户端只看到网络错误「fetch failed」，
      没有任何结构化原因；而深状态（一手 24 条行动 + 36 层撤销栈）本身已经 87.7KB
```

`webServer.ts` 的实现是 `reject(...) + req.destroy()`：**连接被销毁，客户端拿不到任何结构化原因**；而 `table.js` 会把这个状态原样重发（每一次点击都带完整状态 + 最多 60 层撤销栈），所以界面会停在「网络或服务端错误」，唯一出路是刷新页面（= 新建牌桌，丢掉整场会话）。每层撤销快照约 2.4KB，因此**一手牌 + 十几次操作**就能顶到上限。

**修复与复核**：`webServer.ts b52c3a79` 把上限提到 1MB 并给出结构化原因。复核（最终快照）：

```
  深状态请求体大小 = 87.7 KB（服务端上限 1024 KB）
[INFO] V-SIZE 超过旧上限（228KB）的请求体得到结构化响应 ok=false（上限已提到 1024KB）
```

残余风险：状态仍随操作线性增长（约 2.4KB/次操作，上限 1MB）；按当前撤销栈上限 60 层估算，一手牌内不会触及，但**跨多手不清空撤销栈**的长会话值得关注（本次未观察到）。

---

### F-04 MAJOR —— 「全下」按钮在后端被拒（预览给的动作，引擎不认）

**最小复现 A（纯函数，探针 #1「ALL_IN 专项」）**：6 人桌，UTG..BTN 弃牌 → 轮到小盲位（本街已投入 0.5BB 盲注）。

```
  预览按钮：弃牌[PRIMARY] / 跟注 0.5BB[PRIMARY chips=50] / 加注（选尺寸）[PRIMARY] /
            加注到 2BB[SIZE chips=200] / 加注到 100BB[SIZE chips=10000] / 全下（100BB）[PRIMARY chips=10000]
  ALL_IN 按钮：{"type":"ALL_IN","labelZh":"全下（100BB）","amountBB":100,"amountChips":10000,"isAllIn":true,"group":"PRIMARY"}
  引擎口径：行动者剩余=9950 本街已投入=50 → doAllIn 要求 amount === 9950
  按钮携带 amountChips = 10000（= 已投入 + 剩余）
[HIT] V-ALLIN-1 点 ALL_IN 按钮被后端拒绝：ILLEGAL_ACTION:「小盲位」的这个动作被规则拒绝：ISSUE.ALLIN_AMOUNT_MISMATCH
  对照 A：ALL_IN amountChips=9950（剩余筹码）→ ok=false ["INTERNAL_ERROR"]      ← 连填对金额也失败
  对照 B（加注 → 选全下尺寸）：RAISE(amountChips=10000) → ok=true               ← 同一动作的另一条 UI 路径可用
```

**最小复现 B（真实 UI 点击，探针 #2 §G）**：

```
  现在轮到：玩家5 当前行动
  按钮：弃牌 / 跟注 0.5BB / 加注（选尺寸） / 全下（100BB）
  点击载荷={"kind":"ACT","action":{"type":"ALL_IN","amountChips":10000}}
  提示条：「小盲位」的这个动作被规则拒绝：ISSUE.ALLIN_AMOUNT_MISMATCH。界面上只显示合法动作…
  指纹是否变化：false
```

**穷举量化**（探针 #1 §27/§29，11201 次按钮点击，覆盖 4 个局面 × 5 层决策树）：

```
  按按钮标签汇总：全下（…）×1545
  按后端原因汇总：
    1285× ILLEGAL_ACTION:「小盲位」的这个动作被规则拒绝：ISSUE.ALLIN_AMOUNT_MISMATCH
    197× ILLEGAL_ACTION:「大盲位」的这个动作被规则拒绝：ISSUE.ALLIN_AMOUNT_MISMATCH
     63× ILLEGAL_ACTION:「庄家位」的这个动作被规则拒绝：ISSUE.ALLIN_AMOUNT_MISMATCH
```

**根因（两处，同一语义分歧）**：

1. `tablePreview.actionButtonsFrom()` 给 ALL_IN 按钮塞 `amountChips: legal.allInToAmount`（= 本街总额 = 已投入 + 剩余）；
2. `engine.doAllIn()` 的语义是 `amount === player.remainingStack`（本次投入），`amount` 不填即「投入全部剩余筹码」；
3. `tableOps.applyTableAction()` 落库时对 ALL_IN 也写 `amountBB = 本街总额`，重放时 `toChips()` 再把它当「本次投入」提交 → 当且仅当「本街已投入 = 0」时两个口径恰好相等，于是**只有本街第一次行动全下才成功**（探针 #1 记录：`UTG（本街已投入 0）全下成功：记录={"type":"ALL_IN","amountBB":100}`）。SB/BB 盲注、平跟后面对加注、下注后被加注——这三种最常见的全下场景全部失败。

**影响**：屏幕把「全下」列为合法动作并显示为红色主按钮，点击后被后端规则拒绝，还弹出「属于界面/引擎不同步，请截图反馈」的文案。虽然不会产生错误建议，但它**让一个真实存在的决策选项在牌桌上不可达**（用户只能改用「加注 → 选全下尺寸」这条等价路径，而那条路径的标签是「加注到 X BB」，不是「全下」）。

**修复与复核**：`tablePreview 4c0d5174` 现在对 ALL_IN **不携带金额**（注释明确写出「引擎要求 amount = 本次投入的剩余筹码，不传金额由引擎自己算」）。复核：

```
[OK] V-ALLIN-1 点 ALL_IN 按钮被后端接受
[OK] V27 共试 11201 个按钮，其中 0 个被后端拒绝
[OK] G1 全下按钮被后端接受
```

---

### F-05 MAJOR —— 「有效筹码」：屏幕一个值，决策引擎另一个值

**最小复现 A**（探针 #1「有效筹码口径」）：Hero CO 100BB、HJ 100BB（座位序第一 → 首要对手）、BTN 20BB，翻牌前都平跟、翻牌都过牌 → 轮到 Hero。

```
  轮到 CO（HeroTurn=true）活跃对手=2
  屏幕 preview.effectiveStackBB=19BB；各座位剩余={"UTG":100,"HJ":99,"CO":99,"BTN":19,"SB":99.5,"BB":99}
  适配器首要对手位置=HJ（= contextBuilder 的 opponents[0]）
  决策引擎 math.effectiveStack=9900 筹码 = 99BB；SPR=22
[HIT] V-EFF 场景 A：屏幕「有效筹码」=19BB，决策引擎实际使用=99BB —— 同一个名字两个值
```

**最小复现 B**（面对全下）：UTG 全下、HJ/CO 弃牌 → 轮到 Hero BTN。

```
  屏幕 preview.effectiveStackBB=99BB
  决策引擎 math.effectiveStack=0 筹码 = 0BB；SPR=0
  分析结果 debug.math 行：[{"label":"底池","value":"10150 筹码（101.5BB）"},
                          {"label":"有效筹码","value":"0 筹码（0.00BB）"},{"label":"SPR","value":"0.00"},…]
[HIT] V-EFF-B 场景 B：屏幕「有效筹码」=99BB，决策引擎实际使用=0BB
```

**根因**：`tablePreview.effectiveRemaining()` 的口径是「所有未弃牌、未全下、还有筹码者的最小剩余」（并把全下玩家显式排除），而决策链的 `contextBuilder.buildMathSnapshot()` 用 `effectiveStackBetween(state, hero, 首要对手)` = `min(我, 首要对手)`（**不排除全下玩家**）。两者在「多路底池筹码不等」或「首要对手已全下」时必然分叉。

**影响**：牌桌面板的「有效筹码」是用户读数、用来估 SPR 的数；而分析面板 `debug.math` 里同一个名字是另一个数（面对全下时是 0）。同一个界面上两个不同含义的同名数字，符合 §90「屏幕显示 ≠ 后端使用」的定义。**未观察到它改变最终建议**（`spr` / `effectiveStack` 在 `decisionEngine` 里没有任何消费者，只进 ViewModel 与日志），因此定为 MAJOR 而非 CRITICAL。

**修复与复核**：`tablePreview 4c0d5174` 引入 `import { effectiveStackBetween } from '../../domain/poker/odds.ts'` 并改用它。复核：

```
[OK] V-EFF 屏幕与决策引擎的有效筹码一致（99BB）
[OK] V-EFF-B 场景 B：屏幕「有效筹码」=0BB，决策引擎实际使用=0BB
```

---

### F-06 MINOR —— 畸形 HTTP 载荷：曾出现 500 与「静默接受错误类型」

**原始观测（修复前）**：

```
  ACT 无 action                             status=500 ok=false code=INTERNAL_ERROR
  ACT action=null                          status=500 ok=false code=INTERNAL_ERROR
  ACT RAISE 字符串金额                          status=200 ok=true code=ACCEPTED
      ⚠ 被接受：revision 9→10 历史长度=3 …                    ← 字符串 "500" 被 JS 隐式转换后照常落账
  SET_BOARD_CARD 数字牌面                      status=200 ok=true code=ACCEPTED   ← 数字被存进公共牌
  undo 61 条（超上限）                           传输层错误：fetch failed            ← 请求体过大被销毁连接
[HIT] V-MAL-a 畸形载荷共 37 例，HTTP 5xx 数量=2，传输层错误=1
```

根因：`parseOp()` 只校验 `op.kind`，`ACT` 的 `action` 形状不校验 → `applyTableAction(state, undefined)` 读 `request.type` 抛 TypeError → `webServer` 的兜底 catch 变成 500（而 `tableApi.ts` 头部明确写着「无论成功失败都返回结构化结果 —— 不抛异常」）。字符串金额之所以没造成状态损坏，是因为 `engineViewOf(next)` 的**重放自检**（重新解析落库的 `ManualAction`）把它拦下了——这道自检是真实有效的防线。

**修复与复核（最终快照）**：

```
  ACT 无 action                             status=200 ok=false code=INTERNAL_ERROR
  ACT action=null                          status=200 ok=false code=INTERNAL_ERROR
  ACT RAISE 字符串金额                          status=200 ok=false code=INTERNAL_ERROR
  SET_BOARD_CARD 数字牌面                      status=200 ok=false code=INTERNAL_ERROR
  undo 61 条（超上限）                           status=200 ok=false code=INTERNAL_ERROR
  handActive 伪造 false + SET_STACK          status=200 ok=false code=INTERNAL_ERROR
[OK] V-MAL-a 畸形载荷共 37 例，HTTP 5xx 数量=0，传输层错误=0
[INFO] V-MAL-b 被**接受**的例数=2（`{}` → 按设计新建牌桌；`bigBlindBB=2` → 合法面额）
```

---

### F-07 MINOR —— 前端仍硬编码枚举（离桌选项）

**原始观测（修复前）**：

```
  客户端硬编码枚举字面量：LEAVING_AFTER_HAND×1 SITTING_OUT×2 FOLD_AND_LEAVE×2 LEAVE_AFTER_HAND×1 PREFLOP×1 PRIMARY×1 SIZE×1
[HIT] V-META-c table.js 自己硬编码了离桌选项与中文标签，而 meta.leaveChoices 已提供同一份数据
  客户端**未**消费的 meta 字段：leaveChoices,seatStatuses,occupiedStatuses
```

**修复与复核（最终快照）**：`[OK] V-META-c 前端未硬编码离桌选项`；只剩 `[INFO] V-META-e 未被 table.js 消费的 meta 字段：seatStatuses,occupiedStatuses`（后者只影响调试区，且状态中文来自后端的 `statusZh`）。

> 同一类漂移的另一个实例就是 F-02（`PRIMARY`/`SIZE`/`EXPAND`）。**建议**把动作按钮的组名也纳入 meta。

---

## 3. 逐向量结论（清单要求逐条对应）

| 向量 | 结论 | 证据要点 |
|---|---|---|
| **10 卡牌映射** | **干净** | 从 `table.js` 源码正则抽出它真正生成的 52 个代码：`As…2c`；52 张全部被 `SET_HERO_CARD` **原样**接受；`SET_HERO_CARD('As','Kd')+board('Kh','7c','2d')` → 引擎 `holeCards=["As","Kd"]` / `flop=["Kh","7c","2d"]`（`As` 处处都是黑桃 A，`s/h/d/c` 一一对应，`T` 就是 10）；Hero∩公共牌重复被 `CARD_ALREADY_USED` 拒绝（双向）；同一张牌点两次 = **取消**（不是重复选择）；网格去重 52 张 |
| **11 视觉 vs 逻辑** | **干净** | 6 个 Hero 位置下提交给管线的 `seatStacksBB/actionHistory` 归一化后**只有 1 种取值**；视觉序号是 0..5 的双射且 Hero 恒为 0；`table.js` 里 `visualIndex/angleDeg` 只出现在布局与调试打印处，**0 处**用于逻辑判断 |
| **12 陈旧响应** | **干净** | 水位线拒绝迟到旧版本（`STALE_REVISION`，HTTP 200）；失败响应回传的 `state.revision(7) <= 已应用(8)` → 客户端丢弃判据成立；UNDO 后 revision **仍单调递增**（8→9），不会卡住合法撤销。残余（INFO）：被丢弃的响应仍会覆盖 `app.preview`（需双标签页才显现） |
| **13 双击 / 重复提交** | **干净** | 真实客户端连点两次「弃牌」→ **只发出 1 个** `/api/table` 请求（inflight 守卫）；服务端两个并发同版本请求 → **恰好 1 个被应用**、另一个 `STALE_REVISION`，行动历史恰好 +1（无重复落账）；无副作用 op 保持 revision 且无累积效应 |
| **14 上一手泄漏** | **干净** | `NEXT_HAND` 后：heroCards/board/actionHistory 清空、`handActive=false`、全部座位回到 `SEATED_ACTIVE`、筹码按上一手剩余更新（100/40→100/39 等）、tableId/Hero 位置/环境/画像保留；「手后离桌」在 `RESET_HAND` 与 `NEXT_HAND` 上都会真正解除绑定（本次审计窗口内曾被遗忘，现已修复并复核） |
| **15 `NEW_TABLE` 清 Villain** | **干净** | `playersById` 只剩 Hero 一个对象；5 个 Villain 座位全部 `EMPTY/null`；手牌/公共牌/历史/弃牌全下状态全清；`nextPlayerNumber` 重置。INFO：撤销栈保留旧牌桌（按 UNDO 可恢复 Villain 画像），属撤销语义 |
| **§90 三方一致** | **干净（含渲染层）** | 探针 #2 在真实翻牌决策点上：屏幕 `debugInput`（归一化后）**逐字等于**后端由同一状态适配出的 `ManualHandInput`（730 字符）；屏幕指纹 == 后端重放指纹；屏幕底池 2.5BB == 后端重算 250 筹码；屏幕「现在轮到你」== 后端 `pendingQueue[0] === userPlayerId`；Hero 手牌/公共牌代码与引擎牌面一致；行动台账与屏幕时间线逐条对应；有效筹码一致（修复后）。**另**：探针 #1 §90 在 6 个 Hero 位置 × 多种局面下不一致项 = 0 |
| **§27/§29 前端零规则** | **干净** | `table.js` 中 `preflopOrder/postflopOrder/minRaiseTo/computePot/isUnopenedPot/requiredCallAmount` **全部不存在**；**属性检查（offer ⇒ accept）**：11201 次点击覆盖 4 个局面 × 5 层决策树，最终快照 **0 次被后端拒绝**；「预览指纹 vs 重放指纹」不一致 **0 次**。注：F-02 是这条属性的反方向（后端给的合法动作没出现在屏幕上），已修复 |
| **`applyTableAction` 往返** | **干净** | 最小加注 / 全下 / 短全下（不重开加注）/ 分数筹码（37.5BB）/ 非 100 面额（`bigBlindBB=3`）/ 多街序列 / 逐座位不同筹码：全部 `ok=true`，且每个状态上 `preview.stateFingerprint === stateFingerprintOf(engineViewOf(state))`。唯一的历史缺陷是全下口径（F-04，已修复） |
| **`seatStacksBB`** | **干净** | 满座时适配器写入**全部 6 个位置**；`UTG=42BB / BB=7.5BB` 逐座位精确生效（引擎 `startingStack` 42/7.5）；缺位置时**静默回退**到 `effectiveStackBB`（不报错）——但牌桌路径永远写满，故 UI 不可达（INFO）。对手筹码不同时 `effectiveStack` 与决策引擎一致（F-05 修复后） |
| **暂离 / 空座** | **干净** | 只有 Hero 时空桌：`ok=false`、无行动者、底池 0、阻塞原因可读；暂离：拒绝分析、**0 个动作按钮**、适配器返回失败；暂离+空座并存时阻塞原因**去重**（同一条不显示两遍）；不崩、不静默发牌 |
| **畸形载荷** | **干净** | 37 例：`null/数组/字符串/state=null/未知 op/op 数组/ACT 无 action/伪造撤销快照/垃圾撤销/超长撤销/座位数不符/位置重复/visualIndex 重复或整体偏移/heroCards 三张/公共牌空串或重复/`bigBlindBB=0`/`handActive` 伪造/坏 JSON` → 最终快照 **0 个 5xx、0 个传输层错误**，且被拒绝时状态不发生任何变化（`revision` 不变、历史不变） |
| **`GET /api/table/meta`** | **基本干净** | 客户端**确实消费** meta（`positions/tableSizes/environments/quickProfiles/dynamicHints/streets/actionTypes/leaveChoices` 全部有引用，启动时先取 meta 再建桌）；meta 全部画像取值 11/11 被 `SET_PROFILE` 接受，6 人桌位置 6/6 被 `SET_HERO_POSITION` 接受。剩余硬编码：卡片字母表（`SUITS/RANKS`，属领域词汇）、动作组名 `PRIMARY/SIZE/EXPAND`（F-02 的现实教训） |
| **性能** | **干净** | `POST /api/table`（每次请求都要跑「适配 → 解析 → PREVIEW 重放 → 校验 → ANALYZE 门禁」全链）：浅状态 40 次 `min=2.5ms p50=15.8ms p95=19.4ms max=21.1ms`；深状态（24 条行动 + 36 层撤销栈，请求体 87.7KB）20 次 `p50≈16ms max=28.1ms`。**最慢 28.1ms < 100ms** |

---

## 4. 审计窗口内「修好之后复核通过」的其它项（如实留档）

以下是我在更早快照上命中、随后在 13:05–13:18 之间被修复并由探针复核的项（避免与作者已知修复重复计数，仅作留档）：

| 项 | 命中时观测 | 最终快照复核 |
|---|---|---|
| 公共牌「跳着填」静默丢牌（`board=['','','2d']` 截断成 `[]` 却返回 ok） | 我最初的读码与最小复现均命中 | 现在直接拒绝并要求「按顺序选第 N 张」 |
| `RESET_HAND` 后「手后离桌」意图被遗忘，离桌玩家仍被算进本手 | 计划中的 V14b 复现 | `RESET_HAND 后 UTG 座位：status=EMPTY playerId=null` |
| `handActive` 由客户端断言 → 本手进行中可 `SET_STACK`/`ADD_PLAYER` | 计划中的 Fail-Closed 缺口 | `handActive 伪造 false + SET_STACK → 200 ok=false INTERNAL_ERROR` |
| 适配器同时传 `villain` 与 `villains`（画像可能绑到已弃牌的第一个对手） | 作者已在其消息中说明（我未独立命中，探针 #1 §90 打印显示提交内容里只剩 `villain`） | 已修复 |

---

## 5. 残余风险与建议（不改变判定）

1. **I-04**：把动作按钮的 `group` 取值（以及 `SeatStatus` 之外的展示口径）并入 `GET /api/table/meta`。F-02 证明「前端硬编码后端枚举」会在一次重构中静默丢失整个功能面。
2. **I-03**：`applyTableResponse()` 在状态被版本保护丢弃时仍覆盖 `app.preview`。单标签页不可达，双标签页会渲染「新状态 + 旧预览」。建议把 `preview` 与 `state` 的接受/丢弃做成同一个判断。
3. **F-03 残余**：状态体积随操作线性增长（≈2.4KB/次）。上限已到 1MB，短期安全；若将来允许跨手保留撤销栈，需要重新评估。
4. **可测性建议**：F-01 这类「渲染期抛异常」在纯 Node 测试里永远不会暴露。`scripts/rt-table-adapter-probe2.ts` 的 DOM 桩（含 DOM 规范的 `appendChild` 祖先检查）只有约 120 行，建议把它固化成常驻测试：**任何 `render()` 抛出的异常都必须让测试失败**。

---

## 6. 结论

- 最终快照（§0.2 的 12 个 SHA256 前缀）上，探针 #1 的 **36 项断言全部通过**（含 11201 次按钮穷举 0 拒绝、0 次重放指纹不一致、37 例畸形载荷 0 个 5xx、最深 28.1ms），探针 #2 的 **7 项断言全部通过**（网格代码 / 双击 / §90 三方一致 / 建议真的渲染出来 / 离桌弹层 / 全下按钮）。
- 审计窗口内**真实命中** 2×CRITICAL、2×MAJOR、2×MINOR（F-01…F-07），全部在窗口内修复，并由同一批探针在最终快照上复核通过；其中 F-01/F-02 是「屏幕与后端不一致」这一最危险类别的现实版本（建议永远显示不出来 / 合法动作从屏幕消失），F-04 让最常见的全下场景不可达。
- 因此：**对 13:18:56 的最终快照判 PASS；对 13:09:19 的「冻结版」与 13:16–13:17 的中间版本，本轮的判定是 FAIL**（F-01、F-02 可稳定复现）。若需以「冻结版」交付，请把最终快照的修复一并纳入并重新冻结。

# 红队判定：PASS

---

## 增量复验（最终快照）

> 触发原因：作者在 13:18:56 的最终快照之后**又改了 4 处源文件**（另一位红队报的 RT-L6 / L7 / L8 / L9）。
> 本节只做**增量复验**，不重跑全部攻击面；原始审计记录（§0–§6）**未做任何删改**。
> 探针：`scripts/rt-table-adapter-probe3.ts`（新增）· 证据：`scripts/rt-table-adapter-evidence.txt` 的「探针 #3」段（UTF-8，Node 写文件）

### 增量复验快照（探针 #3 §0 逐字复现）

| 文件 | SHA256 前缀 | mtime | 与 13:18:56 快照的关系 |
|---|---|---|---|
| `src/app/web/table.js` | `0501c1a7483ff53c` | 13:23:20 | **已改**（`580b6fcd…`→ 座位菜单暂离取消入口） |
| `src/app/table/tableApi.ts` | `edb44ebfc912e005` | 13:23:26 | **已改**（`bf37c85e…`→ 新建分支 heroPosition 校验 + 结果自校验） |
| `src/app/table/seatLifecycle.ts` | `49f7729516159f55` | 13:23:30 | **已改**（`4023fc6e…`→ SET_TABLE_SIZE / NEW_TABLE 文案） |
| `src/app/table/tablePreview.ts` | `4c0d51745055d866` | 13:17:22 | 未变 |
| `src/app/table/tableOps.ts` | `87aa2d143ff32602` | 13:16:21 | 未变 |
| `src/app/table/table.types.ts` | `0812db7ad78c2e99` | 13:18:56 | 未变 |
| `src/app/table/tableAdapter.ts` | `ac4ef748a39603ec` | 13:05:22 | 未变 |
| `src/app/table/tableState.ts` | `2cbe1e96fd9fc402` | 13:06:32 | 未变 |
| `src/app/webServer.ts` | `b52c3a79c72ff59a` | 13:18:39 | 未变 |
| `src/app/manualInput/manualInput.ts` | `f4cfd65839dd3b0c` | 12:40:34 | 未变 |
| `src/app/manualInput/reconstruct.ts` | `06d435b96db79855` | 12:38:42 | 未变 |
| `src/app/manualInput/legalActions.ts` | `377f3ebc1f905561` | 10:01:28 | 未变 |

### 1. RT-L7：新建牌桌分支（真实 HTTP，4 + 1 例）

| 请求 | 期望 | 实测 |
|---|---|---|
| `{tableSize:6, heroPosition:"UTG1"}` | `ok:false` + 可读原因 | `status=200 ok=false code=SEAT_NOT_FOUND`，原因逐字：**「6 人桌上没有「UTG1」这个位置。可选：UTG / HJ / CO / BTN / SB / BB」**，且**不返回任何 state** |
| `{tableSize:6}` | `ok:true`，Hero=BTN，6 座 | `ok=true heroPosition=BTN 座位数=6 自校验=true Hero绑定=true` |
| `{tableSize:9, heroPosition:"UTG2"}` | `ok:true`，Hero=UTG2，9 座 | `ok=true heroPosition=UTG2 座位数=9 自校验=true Hero绑定=true` |
| `{heroPosition:"BTN"}` | `ok:true`，Hero=BTN，6 座 | `ok=true heroPosition=BTN 座位数=6 自校验=true Hero绑定=true` |
| `{tableSize:9, heroPosition:"LJ"}` | `ok:true`，Hero=LJ，9 座 | `ok=true heroPosition=LJ 座位数=9 自校验=true Hero绑定=true` |

「自校验」= 把服务端返回的 `state` 原样喂回 `parseTableState()`，必须 `ok`（即**服务器不会产出自己校验不过的状态**）；「Hero绑定」= `seats[heroPosition].playerId === heroPlayerId`。`[OK] L7-a` + 4×`[OK] L7-b`。

### 2. RT-L8 / RT-L9：notice 必须点名 / 必须如实

**RT-L8**（9 人桌 Hero=UTG1 且 BTN 上坐着「玩家7」→ 切 6 人桌）实际 notice（逐字）：

```
桌型已切换为 6 人桌。
UTG1、UTG2、LJ 这些位置在新桌型里不存在，对应座位已移除（玩家对象仍保留在历史里，不再绑定任何座位）。
Hero 原位置 UTG1 在 6 人桌不存在，已自动改到庄家位。
庄家位 座位上原本是「玩家7」—— 该座位已交给 Hero，他不再绑定任何座位（玩家对象仍保留在历史里）。
座位筹码保持不变；Hero 的筹码跟着 Hero 走。
```

`[OK] L8`（点名了被顶掉的玩家 + 说明座位已交给 Hero）；`[OK] L8-b`（同一批 notice 的另半句承诺也为真：Hero 筹码 100BB → 100BB，**没有被目标座位的筹码顶替**）。

**RT-L9**（Hero 250BB / UTG 42BB → 点「新建牌桌」）：

```
已新建牌桌：其他座位与玩家画像、动态观察、行动历史全部清空。
所有座位筹码重置为默认 100BB（**包括 Hero**）—— Hero 的位置、环境、默认筹码设置保持不变。
```

`[OK] L9`：文案与实际状态一致（`全部座位=[100,100,100,100,100,100]`，Hero=100BB）——**「文案不实」这一类缺陷的判据是文案与状态同时核对，本节两者都查了**。

### 3. RT-L6：「下一手暂离」的取消入口（**真实 `table.js` + DOM 桩**）

流程：启动真实客户端 → 加满 5 名玩家 → 选 `As/Kd`（本手已开始）→ 点 UTG 座位 → 点「暂时离座」→ 重新打开座位菜单 → 点「取消「下一手暂离」」。

| 检查 | 实测 |
|---|---|
| 本手进行中点「暂时离座」 | `ok=true UTG.sitOutNextHand=true UTG.status=SEATED_ACTIVE`（**只设标记，座位仍是「在座」**）`[OK] L6-a` |
| 当前手是否被影响 | 预览指纹（长度 915）**未变**、底池 `底池 1.5BB 当前注 1BB` **未变**、行动者 `玩家2 当前行动` **未变** `[OK] L6-b` |
| 座位卡片文案 | `玩家2枪口位（UTG）100BB在座（下一手暂离）` |
| 座位菜单里是否有取消入口 | 出现 **「取消「下一手暂离」」** 按钮 `[OK] L6-c` |
| 点击后的载荷与结果 | 载荷 `{"kind":"SIT_IN","seatId":"seat_UTG"}` → `sitOutNextHand=false`、`status=SEATED_ACTIVE`、`actionHistory` 长度不变（0）、`handActive=true` `[OK] L6-d` |
| 驱动真实客户端期间的前端异常 | 捕获到 **0** 个未处理 Promise 异常（含 DOM 规范的 `appendChild` 祖先检查）`[OK] L6-e` |

（`SIT_IN` 正是后端既有的取消入口；本节确认了「后端支持 + 界面给按钮 + 点击真的落库」三段都通。）

### 4. 增量没有破坏既有结论（全量回归）

| 验证 | 结果 |
|---|---|
| 探针 #1（卡牌映射 / §90 / 按钮穷举 / 竞态 / 畸形载荷 / 体积 / 性能） | `OK=36 HIT=0 INFO=5`：`V27 共试 11201 个按钮，其中 0 个被后端拒绝`；`V90 三方比对不一致项 0 条`；`V-EFF 屏幕与决策引擎的有效筹码一致（99BB）`；`V-MAL-a 畸形载荷 37 例，HTTP 5xx 数量=0，传输层错误=0`；`V-PERF 最慢一次 POST /api/table = 50.9ms`（该轮机器负载较高；同一探针在安静轮的观测为 p50 15.8–22.5ms / max 21.1ms，均 <100ms） |
| 探针 #2（真实客户端：网格 / 双击 / §90 / 建议渲染 / 离桌弹层 / 全下） | `OK=7 HIT=0`：`按钮=弃牌 / 过牌 / 下注（选尺寸） / 全下（99BB）`（F-02 修复保持）；`屏幕 #result 的内容=建议：下注1.00BB（100 筹码） · 中低 · 边缘决策…`（F-01 修复保持）；`[OK] G1 全下按钮被后端接受` |
| `node.exe --test --experimental-strip-types "test/interactiveTable*.test.ts"` | **65 / 65 通过**（含作者新增的 `interactiveTableRedteam.test.ts`、`interactiveTableRedteam2.test.ts`） |
| `node.exe --test --experimental-strip-types "test/**/*.test.ts"` | **1185 项 / 136 套件 / 0 失败** |
| `npx.cmd tsc --noEmit` | 0 错误（exit=0） |

### 5. 增量复验结论

- RT-L6 / RT-L7 / RT-L8 / RT-L9 四项**全部通过**，且都是**行为级**验证（DOM 桩点击真实客户端、真实 HTTP、文案与状态双向核对），不是读码判断。
- 增量改动**没有**破坏本报告 §3 的任何既有结论：探针 #1 的 36 项、探针 #2 的 7 项全绿，全量测试 1185 项全绿，类型检查 0 错误。
- 本轮增量**未发现新的 CRITICAL / MAJOR / MINOR**；4 处改动均为「补入口 / 补校验 / 改文案」，且都补上了对应的可复现断言。
- 交付依据（建议）：**最终快照（上表 12 个 SHA256 前缀）+ 本增量复验 PASS**。

# 增量复验判定：PASS
