# REAL HAND HOTFIX 001 / UX ADDENDUM —— AUTO ANALYZE

# REAL HAND HOTFIX 001 — VERIFICATION BLOCKED

> ## 阻塞原因
>
> 执行环境（shell）不可用。两次独立探测均失败，**无输出、`exit code 2`**：
>
> ```
> $ echo hi        → exit code 2
> $ Write-Output   → exit code 2
> ```
>
> 因此以下**全部无法执行**，也就**全部不能声称**：
> `tsc --noEmit` / focused tests / full tests / `npm run verify` /
> `npm run manifest` / 浏览器现场复验。
>
> 按规范第 39 条：**立即停止写代码，报告 VERIFICATION BLOCKED**。
> 本轮**没有**「先把剩下的都写完」。
>
> ## 状态分类
>
> | 类别 | 内容 |
> |---|---|
> | **VERIFIED** | 仅第 2 节的分叉定位（根因确认，已实测） |
> | **IMPLEMENTED_BUT_NOT_VERIFIED** | 第 5 节的 Board Guard 与 AUTO ANALYZE；第 8 节的两个测试文件 |
> | **NOT_IMPLEMENTED** | D（`finalizeAfterAction`）／E（SHOWDOWN 过度推断）／G（CALL 契约）／H–K |
> | **KNOWN_LIMITATION** | 第 10 节 |
>
> ## ⚠️ 现场 Bug 当前**仍然复现**
>
> 根因已定位（第 4 节），但 D/E 未实现 → 「内部一致性检查失败」不会被消除。
> **找到根因 ≠ 修复完成。**
>
> ## 最后已知的绿色状态**不能**外推
>
> ```
> 1,242 项 / 1,240 通过 / 2 失败（工件清单漂移）
> ```
>
> 这是**加决策闸门之前**的状态。`TablePreview.decision` 是在那之后加入的，
> 因此**当前 Head 从未被完整验证过**。
>
> ## 唯一允许的下一步（环境恢复后，按顺序）
>
> 1. shell sanity（`echo hi` / `node --version` / `npm --version`）
> 2. `tsc --noEmit`
> 3. focused tests：`test/hotfix001BoardLeak.test.ts`、`test/autoAnalyze.test.ts`
> 4. **focused 失败 → 先修当前 Head，禁止同时开始 D/E/G**
> 5. 记录基线 → `reports/REAL_HAND_HOTFIX_001_BASELINE.md`
> 6. 然后严格按 **D → E → G**，不得并行大改

---

> **本文其余部分的原始状态说明（保留，未改写）**：
> 实现已完成；验证未完成。运行类验证全部标注为「**未验证**」，
> 没有任何一条数字是推测出来的。
>
> 本文件同时是 `REAL_HAND HOTFIX 001` 与 `UX ADDENDUM — AUTO ANALYZE` 的记录；
> HOTFIX 001 主线（`finalizeAfterAction` 等）**尚未完成**，见第 6 节。

---

## 1. 用户现场现象

真实 Web 测试出现：

```
内部一致性检查失败：应用后的状态与重新重放出来的状态不一致。这一块已被拒绝。
```

截图关键差异：

| 字段 | 应用后 | 重新重放后 |
|---|---|---|
| `street` | `PREFLOP` | `FLOP` |
| `phase` | `BETTING` | `SHOWDOWN` |
| `currentBet` | `10000` | `0` |
| `minRaiseTo` | `19625` | `100` |
| `pot` | `49950` | `49950` |
| `bettingRoundComplete` | `true` | `true` |

现场感受：「只能点全下才走得下去」。

---

## 2. 最小复现（已执行，结论可用）

探针：`scripts/rt-hotfix001-diverge.ts`（逐字段差分，不是只比最终状态）。

场景：Hero 在 SB，9 座满桌，100BB，公共牌 `Ah 7c 2d`。

```
DIVERGENCE_FIRST_OCCURS_AT = 12
（第 12 条动作：SB CALL 1.75 —— **关掉翻牌前下注轮的那一条**）
```

差分（同一场景的三种公共牌状态都跑了）：

| 公共牌 | 结果 |
|---|---|
| 未录入（0 张） | **无分叉** |
| 刚好够翻牌（3 张） | 第 12 条动作分叉 |
| 录满（5 张） | 第 12 条动作分叉 |

```
A(增量) PREFLOP/BETTING/bet=375/minRaiseTo=550/brc=true  board=[]
B(重放) FLOP   /BETTING/bet=0  /minRaiseTo=100/brc=false board=[3张]
```

> 这也解释了为什么现场「有时行有时不行」：**公共牌录入之后**才会触发。

---

## 3. First Divergent Action

**第 12 条动作**（关掉当前下注轮的那一条）。判据不是「某条特殊动作」，
而是**一类动作**：

> 只要「某条动作关掉了下注轮」**且**「公共牌已经够下一街」→ 两条路径必然分叉。

---

## 4. 根因

两条路径对**同一条动作**的**结算范围**不同：

| | `applyAction`（增量） | `reconstruct`（重放） |
|---|---|---|
| 标记下注轮结束 | ✅ | ✅ |
| **推进街道 + 发牌** | ❌ **从不做** | ✅ 只要牌面够就推 |

`src/domain/poker/streetAdvance.ts` 的文件头注释明确写着：
「`applyAction` 只负责标记『本街下注轮已结束』，**绝不动 `street`**」。
`reconstruct` 则在动作之后额外做了「能推多远推多远」。

于是 `tableOps.applyTableAction` 的自检比较的是**两个不同阶段**的状态：

```ts
const after = result.state;            // 引擎直接改出来的状态（未推街）
const verify = engineViewOf(next);     // 完整重放（会推街）
if (stateFingerprintOf(after) !== stateFingerprintOf(verify.engine)) → 拒绝
```

**这是两个职责不同的状态被当成同一个来比** —— 与「同一个数字在两处含义不一致」
是同一类结构缺陷（本项目已在 `effectiveStackBetween` / `realizedOpponentIds`
上各踩过一次）。

### 4.1 现场 `phase=SHOWDOWN` 是**第二个独立缺陷**

`advanceStreet`（`streetAdvance.ts:82-86`）：

```ts
// 无人可行动（全员全下）时直接进入摊牌阶段
if (next.pendingQueue.length === 0) {
  next.phase = HandPhase.SHOWDOWN;
  next.bettingRoundComplete = true;
}
```

**「下注阶段结束」被当成了「已经进入摊牌」。** 后果：
全员全下时 `phase` 变成 `SHOWDOWN`，而公共牌还是 0 张 ——
这正是规范第 9 条明令禁止的「All-In 不代表可以凭空发牌」。

---

## 5. 本轮已完成的部分

### 5.1 「决策时刻可见性」不变量（ADDENDUM，路线 A —— 已批准）

**新增护栏**：`contextBuilder.assertBoardVisibility(state)`

- Fail-Closed **抛错**，错误码 `DECISION_BOARD_VISIBILITY_VIOLATION`
- **不 slice**、**不反推 street**，只验证
- 错误信息写明：声明街道 / 应有张数 / 实际张数 / 多了还是少了
- 「多了」时直接点明这是**信息泄漏**

**唯一权威表**：`0/3/4/5` 原本散在两处（`manualInput.BOARD_COUNT_BY_STREET`
与 `tableAdapter.declaredStreetOfBoard` 里写死的四个 `if`）。现在后者改为
**反查权威表**，护栏也从同一处 import —— 三处指向同一张冻结表。

### 5.2 AUTO ANALYZE（UX ADDENDUM）

**后端闸门**（新增 `TablePreview.decision`）：

```
decision.ready      —— 7 个状态条件全部成立
decision.reasonCode —— READY / WAITING_HERO_CARDS / WAITING_OTHERS /
                       WAITING_BOARD / ROUND_COMPLETE / HAND_COMPLETE /
                       STATE_INVALID / STAFFING
decision.state      —— WAITING_CARDS / WAITING_OTHERS / WAITING_BOARD /
                       ANALYZING / DONE / INSUFFICIENT / ERROR
decision.conditions —— 逐条布尔（诊断与红队用）
decision.groups     —— 分「决策就绪」与「分析可用性」两组的中文原因
```

**关键设计**：`analyzeBlockers` **不再自己拼**，改为从闸门分组摊平。
从前是手写的一串 `if`，与闸门各写一遍「谁没轮到 / 牌够不够」——
两份实现迟早分歧。

**前端**：

- 顶栏一个紧凑切换 `[当前决策] [录入历史]`，默认**当前决策**，
  并显示徽标「自动分析：开启 / 已暂停」
- 「当前行动」面板新增状态行（7 态，穷举映射，**不做规则判断**）
- `[分析当前决策]` → **`[重新分析]`**（仅手动重试 / 调试 / 主动刷新）
- 切到录入历史：清 `app.analysis`（建议区收起），**保留**调试面板
- 新牌桌 / 下一手：模式重置回**当前决策**

**为什么不猜模式（规范明确禁止路线 2）**：
「用户正在补录历史」与「用户正常打牌」在**牌局状态上完全一样**。
实测反例：正常打牌时你自己录完前位弃牌、轮到你了 ——
「行动历史变了」会被启发式误判成历史录入，于是**不自动分析**，
恰好违反核心诉求。

**四道保护**：debounce（60ms 合并同轮多次触发）／single-flight（令牌）／
revision 保护（旧响应不覆盖新状态）／modeEpoch 保护（切模式失效在途请求）。

> `modeEpoch` 与 `revision` **正交，必须都要**：
> 只看 revision → 切模式时牌局没变，旧响应仍会被显示；
> 只看 epoch → 打一张牌又撤销，旧响应会覆盖新状态。
> 刻意**不**「把 revision 改一下」：mode 是界面意图，revision 是牌局状态，
> 挪用一个字段表达另一个概念正是本项目一直在清的那类混用。

---

## 6. 未完成的部分（HOTFIX 001 主线）

| 步骤 | 状态 |
|---|---|
| A. ContextBuilder Board Visibility Guard | ✅ 完成 |
| B. 永久 Regression | ⚠️ **已写，未运行** |
| C. 回到 HOTFIX 001 主线 | ⏳ |
| D. `finalizeAfterAction` / street reconciliation | ⏳ **未做** |
| E. 修 `no-actors → SHOWDOWN` | ⏳ **未做** |
| F. `AWAITING_BOARD` / RUNOUT 等价语义 | ⏳ |
| G. CALL / short all-in 契约 | ⏳ |
| H–K. 差分测试 / 浏览器复验 / verify / 裁决 | ⏳ |

**第 4 节的根因已定位，但修复尚未落地。** 也就是说：
**现场那个「内部一致性检查失败」目前仍然会复现。**

---

## 7. Canonical State 定义（D 的设计基线，尚未实现）

按规范第 7 条，不能把增量强行改成重放的结果，也不能反过来 ——
必须先定**规范状态**，再让两条路都走到它。拟定：

> 一条动作之后的规范状态 =
> **应用动作** → **结算下注轮** → **只有在公共牌真的够时才推进街道**，
> 并且发出的必须是**真实存在的牌**（绝不凭空生成）。

按这条判据，「重放推到 `FLOP`」是**对的**（牌是真的、够），
「增量停在 `PREFLOP`」是**错的**。因此修的是增量侧缺的那一步。

⚠️ 但第 4.1 节的 `SHOWDOWN` 那一条**必须同时修**：
按「牌面够才推进」的顺序，`FLOP + 0 张` 这种状态就不该出现；
而现状是 `advanceStreet` 在牌面为 0 时也会把 `phase` 设成 `SHOWDOWN`。

---

## 8. 测试（已写，**未运行**）

| 文件 | 项数 | 覆盖 |
|---|---:|---|
| `test/hotfix001BoardLeak.test.ts` | 14 | 四街合法入口（0/3/4/5）／绕过 Parser **直接攻击 ContextBuilder** ／「少了也要拒」（exact 而非 at-most）／唯一权威表反查一致性／四街 × 0~5 张穷举 |
| `test/autoAnalyze.test.ts` | 15 | 12 条规范回归 + `decision.ready` 与 `canAnalyze` 对拍 + 「后端闸门不得包含 mode」架构断言 |

`autoAnalyze.test.ts` 第五部分是一个**可执行的调度模型**（与 `table.js` 的
`runAnalyze` / `scheduleAutoAnalyze` / `setMode` 逐条对应），用来钉住
debounce / single-flight / 迟到响应 —— 这三类缺陷不依赖 DOM 就能完整表达。

⚠️ **模型与实现必须同步**：若 `table.js` 的调度逻辑改了而模型没改，
这组测试会**假绿**。已在 `table.js` 里加了指向该测试文件的注释。
浏览器端真实点击复验尚未做。

---

## 9. 已验证 / 未验证（诚实清单）

### 已验证（本轮实际跑过）

| 项 | 命令 | 结果 |
|---|---|---|
| 分叉定位 | `node --experimental-strip-types scripts/rt-hotfix001-diverge.ts` | `DIVERGENCE_FIRST_OCCURS_AT = 12`，三种牌面状态 |
| 类型检查 | `npx.cmd tsc --noEmit` | 0 错误（闸门 + 护栏 + adapter 改动后） |
| 全量回归 | `node --test "test/**/*.test.ts"` | 1,242 项 / 1,240 通过 / 2 失败（**均为工件清单漂移，非产品回归**）—— 这是**加护栏之后、加决策闸门之前**的状态 |

### 未验证（执行环境不可用）

| 项 | 说明 |
|---|---|
| `test/hotfix001BoardLeak.test.ts` 全部 14 项 | 未运行 |
| `test/autoAnalyze.test.ts` 全部 15 项 | 未运行 |
| `TablePreview.decision` 加入之后的**全量回归** | 未运行 |
| `npm run manifest` / `npm run verify` | 未运行（清单当前**必然过期**：新增 2 个测试文件 + 1 个探针未登记） |
| 浏览器真实点击复验（`[跟注] [跟注全下] [全下] [加注到]`） | 未做 |
| `runtime` 上 `table.js` 的自动分析实际行为 | 未做 |

> ⚠️ 因此**本文件不给 PASS / FAIL 裁决**。按规范第 36 条，裁决只允许在
> `npm run verify` exit 0 且浏览器复验通过之后给出。

---

## 10. 已知限制

| 限制 | 说明 |
|---|---|
| **现场 Bug 仍未修** | 根因已定位（第 4 节），但 `finalizeAfterAction` 未实现 → 「内部一致性检查失败」仍会复现 |
| **`SHOWDOWN` 凭空跳转未修** | 全员全下时 `phase` 变 `SHOWDOWN` 而牌面为 0 张 |
| **路线 B 已明确延后** | 「录完整牌面回看早街决策」**本轮不做**。它需要独立设计 `fullHandBoard` vs `decisionVisibleBoard`、`fullActionHistory` vs `historyVisibleAtDecision`、`showdownInfo` vs `decisionTimeInfo`，**不能**靠把 `===` 改成 `>=` 实现 |
| **调度模型与实现可能漂移** | `autoAnalyze.test.ts` 的调度模型是**副本**，不是真实 DOM 执行 |
| **CALL 金额契约未审计** | 规范第 10–15 条（`CALL` 到底传什么、short all-in call、UI 不得同时显示无法完成的跟注）**尚未开始**。现场「只能点全下才走得下去」的感受很可能是**这个**造成的，而不是分叉本身——需要按规范第 32 条逐个构造金额单位用例 |
| **UI 内部一致性错误展示未改** | 规范第 30 条（开发模式可展开 JSON、普通模式只给一句话 + 复制按钮）未做 |

---

## 11. 下一步（按规范顺序）

1. **恢复执行环境** → 跑 `test/hotfix001BoardLeak.test.ts` 与 `test/autoAnalyze.test.ts`
2. 修 D（`finalizeAfterAction`）+ E（`SHOWDOWN` 凭空跳转）
3. 修 G（CALL / short all-in 契约，规范第 10–15 条）+ 金额单位红队（第 32 条）
4. H（随机差分测试）→ I（浏览器现场复验）→ J（`verify`）→ K（裁决）
5. 登记新增产物、重新生成清单、更新状态文档与测试矩阵
