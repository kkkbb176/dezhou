# PLAYER PROFILE TABLE UI V1 · 人物画像前端接入与浏览器验收报告

**日期**：2026-09　|　**基线**：`HEAD = 50077e2`（与 `origin/main` 同步）
**结果**：`npm run verify` ⇒ **2,118 项 / 2,118 通过 / 0 失败 / exit 0**（新增 9 项；原有 2,109 项**断言零改动**）
**浏览器验收**：真实 Chrome + DevTools Protocol ⇒ **16/16 通过**（`scripts/browser-e2e-player-picker.ts`，零新增依赖）
**状态**：**未提交、未推送、未部署**（等人工验收）

> 三种状态严格区分：
> **① 代码级通过**（`npm run verify` 内的自动化测试）｜**② 浏览器实际通过**（真实 Chrome 跑通流程）｜**③ 尚未验证**（明确列出）。

---

## PLAYER_PICKER — ① + ②

**实现**（复用现有 `openModal` / `sendOp` / 座位菜单，未新建页面）：

| 授权要求 | 实现 | 证据 |
| --- | --- | --- |
| 输入名称搜索已有玩家 | `/api/table/players?q=`（显示名或 playerId 子串，大小写不敏感） | ①「名册：按名字/身份搜索」；②「搜索到已保存玩家并显示稳定身份」 |
| 显示名称 / 稳定身份 / 区分信息 | 行内显示 `displayName` + `playerId` + 历史手数 + 两项统计的成功/机会数 | ②`阿豪（同名，请按身份区分）｜身份 player_001　历史 1 手｜河牌面对下注弃牌：1 / 1 次机会（100%）` |
| 选择已有玩家入座 | `ADD_PLAYER{seatId, playerId, displayName}`（历史按 **playerId** 绑定） | ②「§五.5/6 重新选择历史玩家并恢复绑定」 |
| 创建新玩家 | `ADD_PLAYER{seatId, displayName}`（新稳定身份） | ②「§五.1 创建新玩家（新身份）」 |
| 同名玩家区分 | 列表**并列**并标注「同名，请按身份区分」，`duplicateName` 由后端给出；**绝不自动合并** | ①「同名不同身份」；②「§五.7」名册 `player_001/阿豪/dup=true｜player_002/阿豪/dup=true` |
| 更换当前座位绑定的玩家 | 座位菜单「加入玩家 / 选择历史玩家…」两分支（占用座位同样可换） | ②「§五.9」同座位换人流程 |
| 换座位后历史仍绑定原 id | 座位只存 `seatId`，身份只认 `playerId` | ②「§五.8 换座位后历史仍绑定原 playerId」 |

**唯一入口**：座位的名称/头像区域（`data-player-id` / `data-seat-id` 已暴露到 DOM，供验收断言）。

## IDENTITY_BINDING — ① + ②

- 三层身份保持分离：`persistentPlayerId`（历史键）/ `seatId`（本手座位）/ `displayName`（只显示）；
- **换座位不换身份**：② 实测 `座位 seat_UTG → player_001`，且换到另一座位后仍为 `player_001`；
- **同名不合并**：① 两条独立记录 + `duplicateName`；② 页面标注同名、名册两条独立身份；
- **换人不继承**：①「新建玩家得到新身份且不继承任何历史」；② 新建同名玩家得到新身份（`p2`），
  且名册里**不出现**该新身份（**没有任何行动 ⇒ 就是「暂无历史记录」，不是 0 手画像**）。

## PROFILE_POPOVER — ① + ②

**悬停提示**（`#seatTip`）字段：座位与位置 → 玩家名称 → 当前画像（标签先验）→ 近期观察 →
历史累计手数 → 实测可信度（收缩权重）→ **河牌面对下注弃牌：成功 / 机会** →
**河牌过牌加注：成功 / 机会** → **已进入决策模型**（逐项）→ **尚未接通**（逐项）。

- **不显示 0%**：没有机会 ⇒ `暂无机会（未观察到 ⇒ 不是 0%）`（② 实测：`河牌过牌加注：暂无机会（未观察到 ⇒ 不是 0%）`）；
- **没有历史** ⇒ `暂无历史记录`；
- **不遮挡**：`.seatTip { pointer-events: none }` ⇒ 提示层**永不拦截点击**，不可能遮住公共牌 / 底池 / 行动按钮
  （① 断言 CSS 规则存在；② 提示为浮层且点击穿透）；
- **点击头像** ⇒ 座位菜单内展开**真实历史抽屉**：`历史累计 / 实测可信度 / 两项统计 / 已接通 / 尚未接通`
  + 明确区分「真实观测统计」「标签先验」「未接通指标」（②「§五.9 抽屉如实展示真实历史读数」）。

## HISTORY_RELOAD — ① + ②

- ① HTTP 面：`/api/table/players` 读真实 JSONL；**损坏文件 ⇒ `ok:false` + `HISTORY_CORRUPT`**
  （前端显示「历史读取失败」，不显示任何统计）；
- ② 浏览器面：**重启服务 + 刷新页面后**名册仍有 3 条（`页面重载=true；名册条数=3`）⇒ 历史来自磁盘而非内存；
- **隔离**：浏览器 profile 与历史目录都是 `mkdtempSync` 临时目录（`DSH_PLAYER_HISTORY_DIR`），
  ② 实测断言「仓库 `data/player-history.jsonl` 不存在」⇒ **未污染真实玩家历史**。

## PROFILE_INJECTION — ①（②仅覆盖披露渲染）

链路（上一轮已实现，本轮**未改**）：`ADD_PLAYER{playerId}` → `playerHistory` 注入 `TablePlayer.observedStats`
→ `tableAdapter` → `ManualVillain.observedStats` → `contextBuilder.resolvePlayerProfile` → 响应概率 → EV。

- ① 覆盖：`test/playerProfileExploitV1.test.ts`（15 项）+ 本轮 `test/playerPickerUi.test.ts`；
- ② 覆盖：页面**读到的**实测数据（手数 / 机会数 / 已接通项 / 未接通 8 项）与后端一致
  （`{"hands":1,"fold":{...},"connected":["foldToRiverBet"],"unconnected":8}`）；
- **未在浏览器内完成的**：跑到一个「河牌面对下注」的真实决策点并观察 EV 变化
  （需要在页面里打完整一手；本轮浏览器脚本只走到「录入两张手牌 + 点弃牌」）。
  ⇒ 该环节属于 **③ 尚未验证（浏览器内 EV 变化）**；EV/响应概率变化本身在 ① 已由 15 项断言覆盖。

## BROWSER_E2E — ② （真实浏览器，16/16）

```bash
node --experimental-strip-types scripts/browser-e2e-player-picker.ts
```

| # | 授权 §五 | 结果 | 证据摘要 |
| --- | --- | --- | --- |
| 1 | 创建新玩家 | ✔ | `新座位 seat_HJ → p2` |
| 2 | 录入玩家真实行动 | ✔ | 页面点「弃牌」⇒ `动作按钮=CLICKED` |
| 3 | 历史记录成功保存 | ✔ | `动作前名册=[player_001:1,player_002:1] → 动作后名册=[p1:1,player_001:1,player_002:1]` |
| 4 | 刷新页面 / 重启服务 | ✔ | `页面重载=true；名册条数=3` |
| 5 | 重新选择该玩家 | ✔ | `座位 seat_UTG → player_001` |
| 6 | 历史与画像正确恢复 | ✔ | 抽屉：`历史累计：1 手（已完成 1 手）｜河牌面对下注弃牌：1 / 1 次机会（100%）` |
| 7 | 同名不同 ID 不混淆 | ✔ | 页面标注「同名，请按身份区分」；名册 `player_001/阿豪/dup=true｜player_002/阿豪/dup=true` |
| 8 | 换座位后绑定不变 | ✔ | 换到另一座位仍为 `player_001` |
| 9 | 换人不继承上一人画像 | ✔ | 新身份 `p2` 不出现在名册（=「暂无历史记录」） |
| 10 | 真实统计进入响应模型并影响计算 | **①**✔ / **②**部分 | ①：注入与 EV 变化已断言；②：仅验证「页面读到的统计与后端一致」，**未在浏览器内打到河牌决策点** |
| 11 | 页面如实展示已使用的实测数据 | ✔ | `{hands:1, fold:{1/1}, connected:["foldToRiverBet"], unconnected:8}` |

**浏览器**：`chrome.exe`（headless=new），**DevTools Protocol**（Node 24 内置 `WebSocket`，**未新增任何依赖**）。
**交互方式如实说明**：通过 CDP `Runtime.evaluate` 在页面内触发**真实 DOM 事件**（`element.click()`、
`input` 事件）——页面代码、`fetch`、服务端、磁盘全部是真的；**不使用 OS 级鼠标合成事件**。

## REGRESSION_TESTS — ①

新增 `test/playerPickerUi.test.ts`（**9 项**，全部走生产入口，全部用临时目录）：

| 项 | 覆盖 |
| --- | --- |
| 名册搜索（名字 / 身份 / 搜不到） | 前端搜索的数据源 |
| 同名不合并 + `duplicateName` | 同名区分 |
| 无机会 ⇒ `null`（不得 0%）+ 无历史 ⇒ 空名册 | 画像展示的诚实性 |
| 已接通统计显示为「成功 / 机会」（受控记录，已标注） | 展示字段 |
| 新建玩家新身份且不继承 | 身份绑定 |
| 选历史玩家入座按 `playerId` 绑定（换座位不丢） | 身份绑定 + 历史恢复 |
| **HTTP `/api/table/players`**（真实服务器）名册 + 损坏历史 `HISTORY_CORRUPT` | 端点 + 错误处理 |
| 前端资源含选人弹窗 / 悬停画像 / `pointer-events:none` | UI 契约 + 不遮挡 |
| 画像数字全部来自接口字段、渲染块内无硬编码比例 | 不得伪造统计 |

**全量回归**：`npm run verify` ⇒ 2,118/2,118 通过 / 0 失败（原有 2,109 项含 STREET STATE CONSISTENCY V2 12 项、
RIVER DECISION CONSISTENCY V1 10 项、PLAYER PROFILE EXPLOIT V1 15 项，**全部未改断言**）。

## REMAINING_LIMITATIONS

1. **浏览器内未验证**：在页面里打完整一手到河牌并观察 EV 随实测统计变化（③）；多人池；跨街统计。
2. **同名消歧**目前是「列表并列 + 标注同名」（未做二次确认弹窗）——满足「不得自动合并」，但选择体验可再加强。
3. **对手范围层仍未接入实测统计**（只进响应层；属模型层改动，需单独授权）。
4. 11 项统计中仅 `foldToRiverBet` / `riverCheckRaise` 两项有输入通道（其余 8 项在界面明示「尚未接通」）。
5. 悬停提示用 CDP 断言的是**DOM 与样式契约**；真实鼠标悬停的像素级表现未逐帧截图比对。
6. 少量真实历史（1–2 手）因 K=500 收缩几乎不影响建议——界面已如实显示「实测可信度」为小数值。

## FINAL_VERDICT

| 维度 | 结论 |
| --- | --- |
| **代码级** | ✅ 通过：`npm run verify` 2,118/2,118，0 失败；新增 9 项覆盖身份绑定 / 搜索 / 同名区分 / 历史恢复 / 画像展示 / 错误处理 |
| **浏览器实际** | ✅ 通过：真实 Chrome 16/16（创建玩家 / 录入真实行动并落盘 / 重启+刷新后恢复 / 重新选人 / 同名不混淆 / 换座不丢 / 换人不继承 / 披露如实 / 隔离目录不污染） |
| **尚未验证** | ⚠️ 浏览器内「打完整一手到河牌并观察 EV 变化」、多人池、跨街统计；像素级悬停截图比对 |

**最终回答**：使用者现在可以**在牌桌页面上**点击座位 → 搜索并选择历史玩家（或新建）→ 看到该玩家的真实画像
与统计来源 → 录入真实行动并自动落盘 → 刷新或重启后重新选择同一玩家即恢复历史与画像；
同名玩家并列显示、按稳定身份区分；换座位不丢历史，换人不继承上一人的画像。

**Git 状态**：`HEAD = 50077e2`（origin 同步，**本轮未提交**）；已修改 7 个、未跟踪 2 个：

| 状态 | 文件 |
| --- | --- |
| 已修改 | `src/app/webServer.ts`、`src/app/table/playerHistory.ts`、`src/app/web/table.js`、`src/app/web/table.css`、`src/app/web/index.html`、`CURRENT_PROJECT_STATUS.md`、`data/artifact-manifest.json` |
| 新增（未跟踪） | `test/playerPickerUi.test.ts`、`scripts/browser-e2e-player-picker.ts`、（本报告 `reports/PLAYER_PROFILE_TABLE_UI_V1.md`） |

**拟提交清单** = 上表全部（等人工验收后再提交/推送）。
