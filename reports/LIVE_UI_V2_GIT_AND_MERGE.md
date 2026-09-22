# LIVE UI V2 —— Git 分支状态与双电脑合并注意事项

**日期**：2026-09-22　**仓库**：`D:\德州`（电脑 A）

---

## 一、当前分支与远程状态（实施前基线）

| 项 | 值 |
|---|---|
| 当前分支 | `dev-computer-a` |
| 本文件撰写时的 HEAD | `c65836b`（LIVE UI V1 交付报告） |
| `origin/dev-computer-a` | `c65836b`（已推送） |
| `origin/main` | `7dffffc`（**本轮未触碰**） |
| 另一个 worktree | `D:\德州-worktrees\opportunity-model-v1` @ `a91967d`（**本轮未触碰**） |
| 工作区 | 见下方「三、本轮改动清单」 |

**纪律遵守情况**：

- ✅ 只在 `dev-computer-a` 上实施；
- ✅ 未修改 `main`、未修改另一个 worktree；
- ✅ 未强推、未硬重置、未 `git clean`；
- ⏳ 「每完成一个可验证阶段独立提交」——提交在本报告定稿后执行（见第四节）；
- ⏳ 「只上传 `dev-computer-a` 并核实远程提交」——同上。

---

## 二、本轮的改动规模（`git diff --stat` 实测）

```text
 CURRENT_PROJECT_STATUS.md             |   4 +-
 data/artifact-manifest.json           |  67 +++--
 src/app/table/seatLifecycle.ts        |  75 ++++-
 src/app/table/tableApi.ts             |  21 +-
 src/app/web/index.html                | 239 +++++++++------
 src/app/web/table.css                 | 285 ------------------
 src/app/web/table.js                  | 544 ++++++++++++++++++++++++++--------
 src/app/webServer.ts                  |  49 ++-
 src/infra/artifactDefinitions.ts      |  35 +++
 test/fillSeatsUi.test.ts              |  12 +-
 test/helpers/tableJsHarness.ts        |  28 ++
 test/interactiveTableApi.test.ts      | 132 ++++++++-
 test/interactiveTableRedteam.test.ts  |  26 +-
 test/interactiveTableRedteam2.test.ts |   4 +
 14 files changed, 957 insertions(+), 564 deletions(-)

 新增（未跟踪）
 src/app/web/live-ui.css      1138 行
 test/liveUiV2.test.ts         637 行
 reports/LIVE_UI_V2_REPORT.md
 reports/LIVE_UI_V2_GIT_AND_MERGE.md（本文件）
```

`table.css` 是**净删除 285 行**（1213 → 928），删的是 V1 那 11 段追加覆盖块。

> ⚠️ **行尾注意**：本轮我一度用 `Set-Content` 处理过 `table.css` 与
> `CURRENT_PROJECT_STATUS.md`，把它们的行尾从 LF / CRLF 改成了另一种，
> 导致 `git diff` 一度显示 2139 行与 4250 行的「全文件改写」。
> **已修正回原样**（`table.css` → LF，`CURRENT_PROJECT_STATUS.md` → CRLF），
> 现在 diff 只显示真实改动。
> 由于 `artifactManifest` 的 sha256 是**对原始字节**计算的（`readFileSync` 后直接 hash），
> 行尾变化会让 `manifest:check` 在不同机器上失败 —— 合并后必须重跑
> `npm run manifest`，见第三节。

---

## 三、与另一台电脑（电脑 B）合并的潜在冲突

电脑 B 有**未推送的更新的代码**（它最后一次推送是玩家画像选人与历史 UI）。
以下是按冲突可能性排序的清单。

### 3.1 必然冲突（人工或脚本都躲不掉）

| 文件 | 为什么必冲突 | 怎么解 |
|---|---|---|
| `data/artifact-manifest.json` | 两边都会重新生成，**整个文件都是 hash 列表** | **不要手工合并**。取任意一边，然后在合并后的工作区跑 `npm run manifest`，再跑 `npm run manifest:check`。 |
| `CURRENT_PROJECT_STATUS.md` | 两边都会改「测试 N 项 / N 个测试文件」这一行 | 取**合并后实际数字**：跑 `npm run verify`，把输出的 `tests` 与 `test/*.test.ts` 文件数写进去。`test/projectStatus.test.ts` 会强制你写对。 |

### 3.2 高风险冲突（两边都动过同一批文件）

| 文件 | 本轮改了什么 | 电脑 B 可能改了什么 | 冲突形态 |
|---|---|---|---|
| `src/app/web/table.js` | 座位渲染、最近动作、设置菜单、自定义金额、`setControlsDisabled`、删除 `setupCollapsiblePanels` | 玩家画像选人 UI / 历史 UI（B 的最后一次推送主题） | **同一个函数体内两侧都有改动** —— 尤其 `renderSeats()` 与 `openPlayerPicker()` / `openSeatMenu()` 附近 |
| `src/app/web/table.css` | 删除末尾 285 行 V1 覆盖块 | 画像/历史抽屉样式（`.pickerList` / `.pickerRow` / `.drawerProfile` 等） | 若 B 在**末尾追加**过规则，删除块会与它重叠 |
| `src/app/web/index.html` | 整页重排 | 画像弹层容器、可能新增的元素 | **结构性冲突**，基本要人工重排 |
| `src/app/webServer.ts` | 静态资源改白名单 + 删 `/gto.css` `/gto.js` 分支 | 若 B 新增过端点，位置会重叠 | 逻辑冲突：B 新增的 `readAsset` 调用要改用新白名单 |
| `test/helpers/tableJsHarness.ts` | 新增 `recentActions` / `moreBtn` / `moreMenu` 三个 id + `exposedTest()` | 若 B 也加过 id | 双方都在 `ELEMENT_IDS` 数组里加行 —— 容易自动合并，但**要确认两边都留下了** |
| `test/fillSeatsUi.test.ts` | 空座位改按 `.empty` class 找 | B 可能也动过 | 小面积 |

### 3.3 低风险 / 无冲突

| 文件 | 说明 |
|---|---|
| `src/app/web/live-ui.css` | **本轮新增**，B 不可能有这个文件。若 B 也新建了同名文件，说明两人做了同一件事 —— 以本文件为准（它是 V2 的唯一来源）。 |
| `test/liveUiV2.test.ts` | 本轮新增。 |
| `src/app/table/seatLifecycle.ts` | 本轮只改 `recomputeHandActive` 与 `commit()` 两处。若 B 没动牌桌状态机则不冲突。 |
| `src/app/table/tableApi.ts` | 本轮只改自洽检查那一段。 |
| `src/infra/artifactDefinitions.ts` | 两边都可能在数组里追加登记项 —— 追加式改动，通常自动合并；但要确认新增项**两边都在**，否则 `manifest:check` 会报「未登记的产物」。 |
| `reports/LIVE_UI_V2_*.md` | 本轮新增。 |

### 3.4 合并后的**必须**复验清单

```powershell
cd D:\德州
npm run manifest          # 1. 重算全部 hash（行尾/内容都变了）
npm run manifest:check    # 2. 必须「全部 N 个产物与清单一致」
npm run verify            # 3. 类型检查 + 清单 + 全量测试，必须 0 失败
```

然后**必须**重跑浏览器验收（样式与布局是测试覆盖最弱的一层）：

```powershell
# 启动服务
node --experimental-strip-types src\app\webServer.ts
# 另开一个窗口
cd D:\德州-audit-20260922
node --experimental-strip-types verify-live-ui-v2.ts
```

重点看 `live-ui-v2-verify.json` 里的三个字段：

| 字段 | 期望 |
|---|---|
| `布局.verticalScroll` | `false`（不得出现纵向滚动） |
| `布局.topbar.h` | `44` |
| `布局.rail.w` | `380` |
| `布局.hasGreenFelt` | `"none"` |
| `录入后布局.firstScreenVisible.actionButtons` | `> 0` |
| `在途状态诊断.disabledCount` | 应当只剩「本来就该禁用」的少数几个（实测 6），**不是 97** |

### 3.5 如果合并后出现「手牌点了没反应」

先确认 `src/app/table/seatLifecycle.ts` 里这两处**都在**：

```ts
// ① recomputeHandActive 必须有「参与者 ≥ 2」这一条
function recomputeHandActive(state: TableCore): boolean {
  const hasCards = state.heroCards.length > 0 || state.board.length > 0 || state.actionHistory.length > 0;
  if (!hasCards) return false;
  return participantSeatsOf(state).length >= 2;
}

// ② commit() 里必须**重算** handActive，而不是只读 next.handActive
const recomputed: TableCore = { ...next, handActive: recomputeHandActive(next) };
```

以及 `src/app/table/tableApi.ts` 里的自洽检查必须是
`!handActive && hasProgression`（**公共牌或行动记录**），
**不是** `!handActive && (historyList.length > 0 || cards.length > 0 || boardCards.length > 0)`。

这两处是「新牌桌 → 选牌 → 再坐人」这条最常见路径能不能用的分水岭。

### 3.6 如果合并后出现「按钮点不动、整页没反应」

检查 `src/app/web/table.js` 的 `setControlsDisabled` 里是否还有哨兵：

```js
var DISABLED_BY_BUSY = 'busy';
```

若被合并回了 `node.dataset.prevDisabled = node.disabled ? '1' : '0'`，
重叠请求（自动分析 20+ 秒 + 用户点动作）就会把全部按钮**永久**禁用。
`test/liveUiV2.test.ts` 的 V2-UI-07 会红。

---

## 四、提交计划（分阶段，每阶段都可独立验证）

| 阶段 | 内容 | 验证方式 |
|---|---|---|
| ① | 三个**产品缺陷**修复 + 回归锁（`seatLifecycle.ts` / `tableApi.ts` / `interactiveTableApi.test.ts` / `interactiveTableRedteam.test.ts`） | 只跑这几个测试文件即绿；与 UI 无关，可独立回退 |
| ② | V2 布局与交互（`index.html` / `table.js` / `live-ui.css` / `table.css` / `webServer.ts` / harness / `fillSeatsUi.test.ts` / `liveUiV2.test.ts` / `artifactDefinitions.ts` / manifest） | `npm run verify` 2266 项 0 失败 |
| ③ | 交付报告 + 本文件 + 状态文档数字 + manifest | `npm run manifest:check` + `projectStatus.test.ts` |

推送：**只推 `dev-computer-a`**，推完用 `git ls-remote origin dev-computer-a` 核对
本地 `HEAD` 与远程 SHA 一致。

---

## 五、诚实记录：本轮我制造并修好的两个「非产品」问题

1. **行尾**：用 `Set-Content` 把 `table.css` / `CURRENT_PROJECT_STATUS.md` 的行尾
   改了，导致 diff 虚增 6000+ 行。已还原。
   **教训**：这个仓库里改文本文件应当用编辑工具，不要用 `Set-Content -NoNewline`
   重写整个文件。

2. **验收脚本自己的错误**（详见 `reports/LIVE_UI_V2_REPORT.md` 第七节）：
   选择器写错（`.card` vs `.pick`）、没等重新渲染就连点、
   没等在途请求结束就断言菜单坏了 —— 这三次都一度看起来像产品缺陷。
