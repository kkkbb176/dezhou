# LIVE UI V1 · 简约实战快速模式 · 交付报告

- 分支：**`dev-computer-a`**，tip **`b5362d5`**
- 基线：`e28b650`（含"验收入口钩子"）
- 远端：**已推送** `origin/dev-computer-a` = `b5362d5`（`main` 保持 `7dffffc` 未动）
- `npm run verify` **exit 0**：**2,247 项 / 137 套件 / 0 失败**，186 个产物与清单一致

---

## 一、主界面截图

| 文件 | 内容 |
|---|---|
| `D:\德州-audit-20260922\ui-baseline-main.png` | **改造前**（1366×768） |
| `D:\德州-audit-20260922\ui-s2-firstscreen.png` | **改造后首屏**（1366×768，9 人桌实战局面） |
| `D:\德州-audit-20260922\ui-1366x768.png` | 改造前另一视角（含决策结果） |
| `D:\德州-audit-20260922\ui-after1c-main.png` 等 | 各阶段中间态 |

改造后首屏可见：紧凑顶栏 → 9 人椭圆牌桌（Hero 在底部、A♠A♥）→ 左侧手牌与时间线；
右侧「当前行动」（行动者 / 底池 / 需要跟注 / 4 个合法动作 / 3 个快捷尺寸）
+「建议：全下」+ **折叠的详细分析** + 折叠的说明/调试。

---

## 二、本次修改的全部文件

| 文件 | 改动 |
|---|---|
| `src/app/web/table.css` | +约 250 行：紧凑顶栏 / 牌桌自适应 / 座位紧凑 / 折叠样式 / 快捷尺寸 / 右列加宽 / 统计格多列 / `.actionMeta` |
| `src/app/web/table.js` | +约 225 行：`setupCollapsiblePanels()`、快捷尺寸渲染、详细分析折叠、验收钩子扩展 `applyTableResponse` |
| `src/app/web/index.html` | 「重新分析」按钮包进 `.actionMeta`（id 与绑定未变） |
| `data/artifact-manifest.json` | 生成物（按项目流程 `npm run manifest` 重新生成，未手改哈希） |
| `reports/LIVE_UI_V1_BLOCKER_HERO_ACTOR.md` | 阻塞项报告（见第八节） |

**未改动**（任务第七节清单，逐项确认）：
`decisionEngine.ts` · `decision.types.ts` · 画像核心模型 · GTO 缓存键与策略数据 ·
合法下注金额计算模块 · **后端 API 契约** · `src/domain/poker/engine.ts`

---

## 三、测试结果

| 套件 | 结果 |
|---|---|
| **全量** `npm run verify` | **2,247 / 2,247 通过，0 失败** |
| `autoAnalyzeHistoryEntry`（旧分析失效 10 项） | 10/10 |
| `fillSeatsUi` | 全通过 |
| `newTableModal` | 8/8 |
| `interactiveTableRedteam` / `interactiveTable` / `buttonSeatInvariant` | 全通过 |

**新增交互的验证**（真实 Chrome + 真实后端，非仅模块测试）：
- 快捷尺寸按钮确实来自后端 `actionButtons` 的 `SIZE` 组（实测 7 个尺寸，显示前 3 个）
- 点击快捷尺寸能**一次完成录入**（1 击）
- 折叠区可开合，内容一字未删

**未新增测试文件**：本轮改动由既有 2,247 项覆盖（任务第九节要求"保留所有既有测试"已满足）；
针对"快速录入 / 行动焦点 / 撤销 / 旧决策失效"的**专项回归锁仍未补**（见第九节）。

---

## 四、九人桌一手牌录入的实际点击次数

| 阶段 | 击数 | 明细 |
|---|---|---|
| 开局配置 | 5 | 9 人桌 · Hero=BB · 一键加入玩家 · A♠ · A♥ |
| 录入一手（9 人桌） | **8** | UTG 开池 **1**（快捷尺寸）+ 7 家弃牌 **7×1** |
| 分析 | **0** | 轮到 Hero 自动分析 |
| **合计** | **13** | 改造前 **14** |

**减少的那一击**：加注从「点『加注（选尺寸）』→ 再点尺寸」= 2 击，降到直接点快捷尺寸 = 1 击。
（弃牌/跟注/过牌本来就是 1 击，未变。）

---

## 五、用户操作到界面反馈的实测延迟

| 操作 | 改造前 | 改造后 |
|---|---|---|
| 录入一次动作（往返 + 渲染） | 平均 **11.2 ms**，最大 15.8 ms | 平均 **21 ms**（含 `waitFor` 轮询间隔，非纯渲染差异） |
| 分析耗时 | 571 ms | 1078–1480 ms（**随 GTO 取数状态波动**，非 UI 改动所致） |

**说明**：录入延迟量级是 **10–20 ms**，远低于人的感知阈值；
真正的时间花在**分析**上（0.5–1.5 秒），而分析是**异步**的 ——
`render()` 不等待它，因此录入下一个动作不被阻塞。
**没有用动画代替性能优化**：上表是 `performance.now()` 实测的往返耗时。

---

## 六、当前 Git 分支、Commit ID 和远程备份状态

| 项 | 值 |
|---|---|
| 分支 | `dev-computer-a` |
| Tip | **`b5362d5`** |
| 阶段提交 | `62294ba`（阶段 1）→ `b5362d5`（阶段 2） |
| 远端 | **`origin/dev-computer-a` = `b5362d5`** ✔ 已确认 |
| `main` | 本地与远端均 `7dffffc` —— **未推送、未合并** ✔ |
| 工作区 | **干净（0 项）** |
| 推送方式 | 普通 `git push --set-upstream` —— **无 force、无 hard reset、无 clean** |

---

## 七、与另一台电脑最新代码合并时可能冲突的文件

按冲突概率排序（依据：电脑 B 最后一次提交在 09-20，改过画像/牌桌/UI；我在 09-22 改过同类文件）：

| 概率 | 文件 | 原因 | 处理 |
|---|---|---|---|
| 🔴 **必然** | `data/artifact-manifest.json` | 生成的全量 sha256 表，任何文件变动即整体重写 | **不要手改**：合并后跑 `npm run manifest` |
| 🔴 **必然** | `CURRENT_PROJECT_STATUS.md` | 电脑 B 大概率也在改（它记录版本/测试数） | 人工合并 |
| 🔴 **高** | **`src/app/web/table.js`** | 电脑 B 的 `player profile picker and history UI` 改过它；本轮我又大改 | 人工合并；本轮改动集中在 `renderResult` 与新增函数，注释已写明每处原因 |
| 🔴 **高** | **`src/app/web/table.css`** | 同上 | 本轮改动**全部追加在文件末尾**（按 ①–⑪ 编号分段），**几乎没有改动原有行** ⇒ 冲突面小 |
| 🟠 中 | `src/app/web/index.html` | 我只动了 `.actionMeta` 一处 | 手工取并集 |
| 🟠 中 | `src/app/table/playerHistory.ts` / `seatLifecycle.ts` | 电脑 B 改过 | 本轮**未动**，风险来自电脑 B 之间 |
| 🟢 低 | `data/gto-cache/index.json` | 追加型数组 | 取并集或删掉重新生成 |
| ⚪ 无 | `data/player-history.jsonl` 等 | 被 `.gitignore` 忽略，Git 不看 | 但**也不会被合并/备份** |

**合并后必须重跑**：`npm run verify`（2247 项）+ 首屏可见性探针。

---

## 八、一个必须先解决的阻塞项（已单独报告，**未擅自修改**）

`reports/LIVE_UI_V1_BLOCKER_HERO_ACTOR.md`

**现象**：9 人桌上**所有人弃牌到大盲**时，引擎直接判定本手结束
（`phase=COMPLETE`、`actorOnTurn=null`、`handComplete=true`），
而大盲**从未行动过**、也没有弃牌。

**根因**：`src/domain/poker/engine.ts:183` 的 `doFold` 只判 `countContenders === 1` 就收手，
没有区分「剩下的是**已用掉选择权**的大盲」还是「**还没行动**的大盲」。

**违反项目自述规则**：`README.md` 核心不变量第 5 条 ——
「大盲在无人加注时仍有选择权」。既有测试只覆盖「**全员跟注**」路径，**没覆盖「全员弃牌」**。

**为什么我没改**：`engine.ts` 在你明令不改的清单里。报告里给了**最小修改方案**
（用引擎已有的 `actedSinceLastAggression` 加一个判据）与必须同时补的测试。

**对本轮的影响**：**不阻塞**。面对加注的主路径实测完全正确
（`UTG 开池 → HJ → CO → BTN → SB → BB(Hero)`，`isHeroTurn=true`），
我的记录流程（UTG 开池 + 7 家弃牌）实测 `actor=seat_BB`、`handComplete=false` —— 正确。

---

## 九、已知限制 / 下一步

| 项 | 状态 |
|---|---|
| 「固定决策区」做成**独立 DOM 区域** | **未做**。当前靠右列布局达到等效效果（首屏可见性 5/5）。做成独立区域需移动 DOM + 改 `index.html`，风险更大，**留待下一轮** |
| 整页高度 877px > 768px | 多出的 109px 是**默认折叠在最下方的「调试」面板**，不影响任何操作 |
| 针对快速录入 / 行动焦点 / 撤销 / 旧决策失效的**新增回归锁** | **未补**。既有 token/revision/modeEpoch 三守卫**一行未动**（已 diff 确认），但按任务第九节要求应有专门测试锁住 |
| 完整 9 人桌端到端点击计数的**自动化** | 当前由探针脚本驱动并统计，未固化为测试 |
| 翻后 / 短码 / 全下的 UI 流程 | 未专门验证 |
| `addAllin=false`（9MAX 无全下分支） | 后端能力限制，UI 如实反映 |

---

## 十、过程中的两次同类失误（都已写进代码注释）

给这个前端加 **DOM API 之前必须先确认假 DOM 有没有实现它** —— 我踩了两次：

1. **阶段 1**：用了 `parent.insertBefore(...)`，而 `test/helpers/tableJsHarness.ts`
   只实现 `appendChild`/`removeChild` ⇒ `TypeError` ⇒ `boot()` 中断
   ⇒ `newTableModal` **8 个测试全挂**。
2. **阶段 2**：用了 `box.querySelector(...)`，而假 DOM 只有 `querySelectorAll`
   ⇒ `TypeError` ⇒ `renderResult` 中断 ⇒ **整个 `render()` 挂掉**
   ⇒ `autoAnalyzeHistoryEntry` Case J 与 `fillSeatsUi` FILLUI-06 失败。

两次都是**非核心的渐进增强把主流程弄挂**。现在两处都有能力检测与降级路径。
