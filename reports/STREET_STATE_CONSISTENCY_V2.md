# STREET STATE CONSISTENCY V2 · 街道状态一致性修复报告

**日期**：2026-09　|　**授权**：使用者报告「Hero 未完成转牌行动，却提前进入河牌」后的 V2 实施授权（含 §一～§七 全部补充约束）
**基线**：`HEAD = bc56191`（CB-5 河牌容差带护栏，已提交未推送）
**统计**：全量 **2,084 项 / 2,084 通过 / 0 失败 / exit 0**（`npm run verify`：typecheck + manifest:check + tests）；产物清单 **163 个文件**
**检查点**：`%TEMP%\dezhou-checkpoint-f2ac-20260920-131436`（719 文件 + `FILES.sha256.txt`，逐位 0 差异）

---

## ROOT_CAUSE

**结论：引擎从未「提前进入河牌」；缺陷是「预览宣布可分析」与「管线拒绝」的口径冲突。**

逐项实测（`scripts/audit-street-v2-evidence.ts`，9 人桌 · Hero BTN · 转牌面对 BB 下注 · Hero 未行动）：

| 事实 | 证据 |
| --- | --- |
| 引擎权威街道**只由行动重放决定** | `src/domain/poker/streetAdvance.ts:56` `STREET_NOT_COMPLETE` 是唯一换街守卫；`applyAction` 只置 `bettingRoundComplete`；`reconstruct.ts` 的 `settleCanonicalStreet` 仅在行动补齐后按牌面能否推进换街 |
| `SET_BOARD_CARD` **只是数据录入** | `seatLifecycle.ts:1070-1121` 只校验槽位范围 / 顺序 / 重复 / 与 Hero 手牌冲突，**不触达街道** |
| 录牌后引擎仍停在转牌 | 录入第 5 张 `Qh` 后：`engine.street = TURN`、`bettingRoundComplete = false`、行动者仍为 BTN、`allBoardCards(engine)` 仍为 `Kd 9c 4h 6s`（4 张） |
| **缺陷的真实表现** | 录入第 5 张后，修复前预览 `ready=true / state=ANALYZING / reasonCode=READY / blockers=[]`，而 `analyzeManualHand(adapter.input)`（`input.street = RIVER`）返回 `ok=false / stage=RECONSTRUCT`（`HISTORY_DOES_NOT_REACH_STREET`）⇒ **界面承诺了它给不出的东西** |

为什么不能靠「拦住录牌」修：`declaredStreetOfBoard`（`tableAdapter.ts:167`）按**录入张数**声明 `ManualHandInput.street`
（3→FLOP、4→TURN、5→RIVER），而「先录公共牌、后补录历史行动」是**已锁定契约**
（`test/state.test.ts:395`「录牌不推进街道」；`§D-4` 5 张先录再补行动）。上一轮（V1）曾在 `SET_BOARD_CARD` 上加闸门，
**打破 `§D-4`/`§E-3`/`§E-4`/`AUTO-3`** ⇒ 已全量回滚（三个文件逐位还原 `HEAD`，新增测试删除，`npm run verify` 恢复 2,072/2,072）。

关于「是否需要新增操作类型」：**已按要求先证必要性 —— 结论是不需要**。
正常阶段推进已由 `applyTableAction` → `engineViewOf` → `settleCanonicalStreet` 在服务端闸门内完成，
`SET_BOARD_CARD` 不推进街道，用户操作意图**不能**由 `actorOnTurn` 反推（同一录入动作在不同局势下语义不同）。
因此采用**只改口径、不改准入**的最小方案。

## IMPLEMENTATION

**生产改动 = 1 个文件**：`src/app/table/tablePreview.ts`（新增**预览一致性闸门**，约 45 行，含完整中文注释）。

触发条件（四条**全部**满足，少一条都不提示 —— 这是避免 V1 过度匹配的关键）：

1. 已录公共牌所属街**晚于**引擎真实街（`declaredStreetOfBoard(state.board.length)` vs `engineState.street`）；
2. **轮到 Hero 本人**行动（用重放后的 `currentActorPosition`，不是缓存字段）；
3. 当前街**已有行动**且**尚未结算**（`engineState.actions.some(a => a.street === engineState.street) && !engineState.bettingRoundComplete`）；
4. 本手未结束（`!handComplete`）。

触发后：`decision.ready = false`、`decision.state = ERROR`、`decision.reasonCode = STATE_INVALID`、
`canAnalyze = false`，并追加一条中文提示（点明「河牌已录入 / 缺的是转牌行动 / 轮到谁 / 可撤销第 N 张」），
**已录入的公共牌原样保留**（不清空、不回退为「选择中」）。

**未做的事（约束遵守）**：
- **未**在 `SET_BOARD_CARD` 上加任何准入门槛 ⇒ 「先录牌、后补行动」（**含 Hero 本人行动**）能力完整保留；
- **未**新增操作类型；**未**用 `actorOnTurn` 反推意图；
- **未**改 EV / 条件范围 / 牌型强度 / 画像 / 利用性调整；`tableOps.ts`、`tableAdapter.ts`、`reconstruct.ts`、
  `streetAdvance.ts`、`seatLifecycle.ts`、`evidencePriority.ts`、`decisionEngine.ts` **零改动**；
- **未**在前端绕过服务端校验（闸门在服务端预览层，前端 `table.js` 未改）。

## REGRESSION_TESTS

新增 `test/streetStateConsistencyV2.test.ts`（**12 项**，全部通过公开入口断言）：

| 项 | 内容 |
| --- | --- |
| §A-1 | 前置状态：引擎街 TURN、本街未结算、行动者为 BTN（Hero） |
| §A-2 | 录入第 5 张**不推进街道**、不自动结算、不改行动者、引擎牌面仍 4 张、桌面数据保留 5 张、行动数不变 |
| §A-3 | 只有完成转牌行动才推进到 RIVER；**且绝不凭空发牌**（未录第 5 张时完成转牌行动不得出现用户未录入的牌） |
| §A-4 | 录牌不改变底池 / 各玩家投入 / 行动序列（不自动跟注、不自动结算） |
| §B-1 | 「先录满 5 张 → 补录全部行动」仍可达 RIVER（录牌不被拦截） |
| §B-2 | Hero 本人历史行动可补录（翻前 RAISE 如实记录），未录入的行动**不得**被当成 CHECK |
| §C-1 | 未完成转牌行动时录入第 5 张：预览 `ready=false / ERROR / STATE_INVALID / canAnalyze=false`，街仍显示 TURN，牌保留，提示包含「河牌 / 转牌 / 尚未完成 / 庄家位」 |
| §C-2 | 预览与管线**口径一致**：同局面 `analyzeManualHand` 亦拒绝（`stage ∈ {PARSE, RECONSTRUCT}`），无正式河牌策略/EV |
| §C-3 | 闸门不误伤正常流程：转牌正常决策点（4 张）仍 `ready=true / READY / blockers=[]` 且能产出决策 |
| §E-1 | 预录第 5 张牌不进引擎状态（牌面 / 街 / 行动序列三项逐位相同） |
| §E-2 | 未来信息隔离：用引擎已回放状态重建输入后，预录 `Qh`（与 Hero 听牌相关）与 `2c` 对转牌决策**逐位零影响** |
| §E-3 | 未完成转牌行动时**不存在**合法河牌决策节点（`analyzeManualHand` 拒绝、预览街不为 RIVER） |

**修复前失败证据（实测执行，非推断）**：临时将 `tablePreview.ts` 还原为 `HEAD` 版本后运行本套件 ——
**`§C-1`、`§C-2` 两项失败，其余 10 项通过**；恢复修复版后 **12/12 通过**。
（其余 10 项在修复前后均通过，说明本修复只纠正预览口径，未改变任何引擎行为。）

**全量回归**：`npm run verify` → `tests 2084 / suites 137 / pass 2084 / fail 0`，`exit 0`；
V1 曾打破的 `§D-4`、`§E-3`、`§E-4`、`AUTO-3` 以及全部 137 套件均在内；**既有测试断言未做任何修改、放宽或跳过**。

## ORIGINAL_REPRODUCTION

原始复现（`scripts/audit-street-v2-evidence.ts`，修复后重跑）：

```
=== ① 转牌面对下注、Hero 未行动（尚未录第 5 张）===
  引擎街=TURN ｜ bettingRoundComplete=false ｜ 行动者=BTN
  预览: ready=true state=ANALYZING reason=READY｜blockers=[]      ← 正常决策点，保持就绪
  录入河牌 Q♥ 被接受 = true                                        ← 录牌能力未被砍
=== ② 录入河牌之后（转牌行动仍未结算）===
  引擎街=TURN ｜ 预览街=TURN                                       ← 没有提前进入河牌
  预览: ready=false state=ERROR reason=STATE_INVALID canAnalyze=false
  blockers=["⚠️ 河牌已录入，但转牌行动尚未完成（轮到「庄家位」的跟注 / 加注 / 弃牌 / 过牌还没录入）。
             请先补录该街的必要行动，完成后再进行河牌分析；或撤销第 5 张公共牌。
             （本工具不会替你补写行动，也不会自动结算下注轮）"]
  adapter.input.street=RIVER ｜ analyzeManualHand: ok=false stage=RECONSTRUCT
```

修复前同一探针的 ② 段为 `ready=true / state=ANALYZING / reason=READY / blockers=[]`，与管线的 `RECONSTRUCT` 冲突。

## FUTURE_INFORMATION_ISOLATION

§四 要求的隔离测试**已实现并执行**（§E-1/§E-2/§E-3），核心结论：

1. **引擎状态隔离**：预录第 5 张牌后，`engineViewOf(state).street = TURN`、
   `allBoardCards(engine) = [Kd, 9c, 4h, 6s]`（**不含**预录牌），行动序列逐位不变 ⇒ 未来牌从未进入引擎状态，
   而权益/EV 计算全部以引擎状态为输入（`allBoardCards(engineState)`）⇒ 结构上不可能读到未来牌。
2. **数值隔离（逐位）**：取「引擎已回放状态」重建输入（牌面截到已发生的 4 张、街声明为 TURN），
   分别对「预录 `Qh`（会改变 Hero 听牌）」与「预录 `2c`」求解，投影（`street / heroEquity / callEV / pot / winnable / action`）
   与基准 **`deepEqual` 完全相同**（`heroEquity = 0.674908490349777`、`callEV = 613.7483031353072`、`pot = 975`、`winnable = 1225`、`action = CALL`）。
3. **河牌节点不可达**：未完成转牌行动时 `analyzeManualHand` 拒绝（`stage = RECONSTRUCT`），
   拒绝结果中**不含**河牌数学；预览街**不显示**为 RIVER ⇒ 不产出正式河牌策略或 EV。
4. **架构无需报阻塞**：隔离性由既有架构（引擎状态 = 行动回放的产物）天然保证，未发现泄漏路径。

> 说明：探针 ③ 的**手工录入**变体（`street:'TURN'` + 5 张牌面）会被 `parseManualInput` 在 `PARSE` 阶段拒绝
> （牌面张数与街不一致）⇒ 该变体**不是**有效对照，已不作为证据；有效证据为上表第 1–3 条（表路径 + 引擎状态）。

## REMAINING_RISKS

1. **闸门范围刻意收窄**：仅在「**Hero 本人**欠当前街行动 + 牌面超前」时提示。若欠行动的是**其他玩家**且牌面已超前，
   预览不提示冲突（与 `AUTO-3` 既有契约一致：那种局面本就由 `WAITING_OTHERS` 表达）。**这是取舍，不是漏洞**，
   但若使用者希望「任何玩家欠行动都不许宣布就绪」，需要一并修改 `AUTO-3` 等既有断言 —— **需新授权**。
2. **适配层的街声明仍是按张数**（`declaredStreetOfBoard`）：`adapter.input.street` 在 5 张时仍为 `RIVER`，
   由管线的 `RECONSTRUCT` 兜底拒绝。未改成「按引擎状态声明」是因为它会改变既有输入契约与大量测试，
   本轮**明确不动**（现状：预览与管线已一致，用户不会被误导）。
3. **未做 UI 点击路径的端到端验证**（无浏览器自动化）：本轮证据均为服务端 API 层（`applyTableOp` / `buildTablePreview`）。
   前端 `table.js` 未改，阻断提示沿用既有 `analyzeBlockers` 渲染路径。
4. **未修复的相邻问题（本轮范围外，如实记录）**：CB-1（模型侧 `nutDensity`/`callLikelihood` 语义披露）、
   CB-2（BET EV 披露）、CB-3（踢脚文案）、CB-4（河牌幽灵听牌）、CB-6（FOLD 证据表为空）、CB-7（措辞）；
   F1（翻前开池无建议）仍未实施；M6/M14/M19 仍为 `NOT_TESTED`。
5. **推送未完成**：`HEAD = bc56191` 与本轮改动**均未推送**（`git ls-remote origin main` 连续 3 次网络失败）；
   本地领先 `origin/main` 1 个提交。**未做** force / merge / rebase。

## FINAL_VERDICT

**A–F 六项验收全部同时满足（实测执行）**：

| 项 | 要求 | 结果 |
| --- | --- | --- |
| A | Hero 未完成行动时不得提前推进街道 | ✅ 引擎街恒为 TURN（`§A-1`/`§A-2`/`§A-3`） |
| B | 「先录牌、后补行动」（含 Hero 本人）能力保留 | ✅ `§B-1`/`§B-2`；`SET_BOARD_CARD` 无新增门槛 |
| C | 预览不得把后续街显示为「可正式分析」 | ✅ `§C-1`/`§C-2`（修复前正是这两项失败） |
| D | 合法局面不得倒退为 RECONSTRUCT | ✅ `§C-3` + 全量 2,084 项 0 失败 |
| E | 不得读取未来公共牌 | ✅ `§E-1`/`§E-2`/`§E-3`（逐位隔离 + 河牌节点不可达） |
| F | 全部测试通过，且**不得**修改既有断言掩盖回归 | ✅ 2,084/2,084，既有断言零改动 |

**结论**：缺陷的根因是**预览与决策管线的口径冲突**（并非引擎提前换街）；已用**单文件最小修复**使其一致，
同时完整保留录牌与补录能力，未触碰任何策略与数学模块。**未提交、未推送、未部署**（等人工验收）。

**修改清单**：`src/app/table/tablePreview.ts`（生产，+45 行）、`test/streetStateConsistencyV2.test.ts`（新增，12 项）、
`CURRENT_PROJECT_STATUS.md`（§10.0.24 + 计数行 + Git 行）、`data/artifact-manifest.json`（hash 刷新）、
`reports/STREET_STATE_CONSISTENCY_V2.md`（本文件）、`scripts/audit-street-v2-evidence.ts`（探针，未跟踪）。
**Git**：`HEAD = bc56191`；已修改 3 个受跟踪文件；未跟踪 142 个（含本报告）——**一律保留**。
