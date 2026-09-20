# F2 最终验收 + 翻后回归 + GitHub 备份 + 下一阶段排序

> **轮次**：F2_FINAL_ACCEPTANCE_AND_NEXT_PHASE（2026-09）
> **本轮实际动作**：只读验收 / 回归 / 干净检出验证 + **一次白名单提交与快进推送**（用户明确授权）；
> **未**修改策略参数、画像权重、GTO 范围、EV 公式；**未**删除或清理任何既有未跟踪文件。

---

## §一 基线与工作区保护

| 项 | 值 |
|---|---|
| 分支 / `HEAD`（本轮开始） | `main` ｜ `91c35e8`（P1 CALL/FOLD 最小修复）= `origin/main` |
| 已修改（未暂存） | 4 个：`src/app/decision/decisionEngine.ts`、`src/domain/decision/decision.types.ts`、`CURRENT_PROJECT_STATUS.md`、`data/artifact-manifest.json`（**F2 改动，尚未提交**） |
| 已暂存 | 无 |
| 未跟踪 | 133 个（历史审计探针/证据 + 本轮新增探针，**全部保留**） |
| 上一轮 F2 实际改动 | `git diff --stat HEAD`：4 文件 / +118 −11（生产 2 + 状态文档 + 产物清单） |
| 测试与清单 | `test/*.test.ts` = 106；产物 163 |
| 已有恢复检查点 | 7 个（`dezhou-checkpoint-{pi-v1,m1,m1d,test17,test18,p1fix,preF2}-*`），其中 `preF2-20260920-121657` 为 F2 修复前基线 |

**本轮新检查点**：`%TEMP%\dezhou-checkpoint-f2ac-20260920-131436`
**719 / 719 文件**逐位 SHA-256 校验 **0 差异**，`FILES.sha256.txt` 自身 sha256 = `46CD6F9DFAF98BD49EB92A12CD29DB94F23B08BBDED4A6478222697001048406`。
（含已提交、未提交与全部未跟踪成果；未执行任何 `reset --hard` / `restore` / `clean` / `checkout --` / `add -A`。）

---

## §二 F2 翻前全下保护验收（生产入口 `analyzeManualHand`）

```powershell
node --experimental-strip-types scripts/f2-acceptance-and-postflop-regression.ts
# 在 %TEMP%\dezhou-checkpoint-preF2-20260920-121657（修复前）与当前工作区（修复后）各跑一次
```

| 节点 | 修复前 | 修复后 | 关键判定 |
|---|---|---|---|
| A 5BB AA 面对开池 | `blocked=true` | **`blocked=false`**（`street=PREFLOP`） | 翻后保护不再误触发 |
| B 5BB KK | `blocked=true` | **`blocked=false`** | 同上（CALL EV 6.15） |
| C 5BB AKs | `blocked=true` | **`blocked=false`** | 同上（CALL EV 4.40） |
| D 10BB AA | `blocked=false`、`RAISE 16` | 逐字不变 | 非全下尺寸，本轮不影响 |
| E 100BB AA 面对 3bet | `blocked=false`、`RAISE 56` | 逐字不变 | 同上 |
| F-a 99 中对面对 20 筹码领打 | `CALL 20`（CALL EV 2.71） | 逐字不变 | P1 裁决保持 |
| F-b 多人池顶对（唯一加注=全下） | **`blocked=true`** | **`blocked=true`** | **翻后保护仍然生效** |
| G-a 99 三条河牌面对 20BB | `RAISE 174`（RAISE EV 174.40） | 逐字不变 | 强牌加注可达 |
| G-b 99 三条转牌面对加注 40BB | `RAISE 186`（RAISE EV 184.81） | 逐字不变 | 同上 |
| H 3BB（`minRaiseTo 10 > allInTo 6`） | `CALL 4`、候选 `[FOLD, CALL@4]` | 逐字不变 | **under-raise 边界**：无合法加注；跟注即投入全部剩余（有效筹码 0） |
| I 4BB（`minRaiseTo 10 > allInTo 8`） | `CALL 4`、候选 `[FOLD, CALL@4, ALL_IN@8]` | 逐字不变 | 独立 `ALL_IN` 候选保留；`未评估=[ALL_IN@8:RAISE_EV_NOT_IMPLEMENTED]` |

**任务 §三 七项确认**

| # | 要求 | 结果 | 证据 |
|---|---|---|---|
| 1 | 翻前 `handCategory=0` 不再触发翻后一对牌保护 | ✅ | A/B/C：`street=PREFLOP`、`handCategory=0`、`consumesStack=true`、`onePairAllInBlocked` **true→false** |
| 2 | AA/KK/AKs 的**合法全下候选**不被错误删除 | ✅ | 5BB：候选含 `RAISE@10 = allInTo`；`heuristicScore 0 → >0`（进入证据表）；4BB：`ALL_IN@8` 独立保留 |
| 3 | 翻后原有保护仍有效 | ✅ | F-b（多人池顶对，`consumesStack` ∧ `!hasOwnEV`）⇒ `blocked=true`；`test/preflopAllInGuard.test.ts` M5-1 同一断言 |
| 4 | 短筹码 under-raise 全下仍按真实规则判合法性 | ✅ | H：`minRaiseTo > allInTo` ⇒ 无加注候选，跟注即全下；I：`ALL_IN` 合法且未被拦；翻后同类 R-06（`minRaiseTo 200 > allInTo 166`）⇒ 仅 `ALL_IN@166` |
| 5 | 无 EV 的全下/加注不得伪装成已算 EV | ✅ | A/B/C：`RAISE = null / HEURISTIC`；D/E：`RAISE=null/HEURISTIC`；I：`ALL_IN@8:RAISE_EV_NOT_IMPLEMENTED`；无 `RAISE_MODEL_EV` / `ISO_RAISE_MODEL_EV` 理由 |
| 6 | 加注金额 / 本街新增投入 / 有效筹码 / 未匹配退回正确 | ✅ | R3 `RAISE 186`（本街已投入 20 ⇒ 新增 166 = `allInToAmount − committed`）；R7 `heroAdd 120 / villainAdd 14 / heroContestedAdd 34 / **uncalledReturn 86** / finalPot 121 = pot 73 + 34 + 14` |
| 7 | 不得硬编码 AA/KK/AKs 的最终动作 | ✅ | A/B/C 同为 `CALL 4`（由既有证据纪律选出）；D `RAISE 16`、E `RAISE 56` ⇒ 同一手 AA 在不同筹码/局面下动作不同；测试只断言属性（`blocked=false`、`heuristicScore>0`、`ev=null`），无动作硬编码 |

**⚠️ 必须区分的两件事（任务 §三 明确要求）**

- **合法性修复：成功** —— 翻前 `handCategory=0` 不再触发翻后保护，合法全下候选恢复且进入证据表。
- **策略证据：仍然不足** —— 全下**没有自有 EV**（`ev=null`、`HEURISTIC`），而既有证据纪律规定「打光筹码且无 EV 的启发式加注不得覆盖边际清晰的 CALL 证据」（`evidencePriority.ts:392-399`）⇒ A/B/C 的最终动作仍是 `CALL 4`，并如实给出 `overrideBlockedReason = CANNOT_OVERRIDE_CLEAR_SUPPORTED_CALL_WITH_UNEVALUATED_ALL_IN`。
  ⇒ 「AA 短码推全下」在**合法性**上已可达，但在**EV 依据**上仍不可达；要让策略真的推全下，需要为翻前全下建立自有 EV 模型（**属新增模型，本轮未授权、未实施**）。

---

## §三 翻后回归（既有已登记牌局，修复前后真实生产结果）

**修复前检查点 vs 当前工作区逐行 diff：差异 36 行，其中「非 guard 行」= 0**
⇒ 全部差异仅为新增的 `street` 字段（以及 5BB 三例的 `onePairAllInBlocked` 翻转）。
`action=`、`EV:`、`范围/权益:`、`候选=`、`raiseFacts=`、`画像:` 六类行**逐字一致**。

| # | 节点 | 修复前后 | 与既有登记值一致？ |
|---|---|---|---|
| R1 | TEST 16 · 河牌三条 AA 面对 10BB 领打（阿豪/MANIAC 800 手实测画像） | `RAISE 120`（CALL EV 72.94 / RAISE EV 146.49 MODEL_EV） | ✅ 未变 |
| R2 | TEST 17 · 转牌顶对 + 坚果同花听（A♣J♣）面对 10BB | `RAISE 80`（CALL 30.72 / RAISE 36.76） | ✅ 未变 |
| R3 | TEST 18 · 转牌面对加注至 40BB | `RAISE 186`（**CALL EV 75.18**、**RAISE EV 93.98**） | ✅ 与 TEST 18 验收数值一致 |
| R4 | 99 中对正 CALL EV 裁决（P1 原始节点，阿豪实测画像） | `CALL 20`（**CALL EV +2.71**、RAISE −28.21） | ✅ P1 修复后行为保持 |
| R5 | AK 河牌面对 20BB 领打（U1/V2 黄金节点） | `CALL 40`（CALL 19.70、RAISE −7.38） | ✅ 「算过但更低」口径保持 |
| R6 | 99 暗三条河牌价值加注 | `RAISE 174`（RAISE EV 174.40） | ✅ 与 V2 验收一致 |
| R7 | P0-7 短筹码对手（30BB）+ 未匹配退回 | `RAISE 120`；`villainAdd 14`（按其剩余封顶）、**`uncalledReturn 86`**、`finalPot 121` | ✅ 与 P0-7 契约一致 |

逐项核对结论：合法动作集合、条件范围与权益来源（`arrival` / `betRange` 分列、CALL EV 用 `EqVsBetRange`）、实际参与比较的 EV（`actionEvidence` 的 estimateType）、最终动作与尺寸、`allInGuard`（`street` 为唯一新增字段）、画像身份与统计来源（`seat_BB` / `player_001` / 阿豪 / 800 手实测）**全部未因 F2 修复而改变**。
⇒ **未发现任何动作变化**（因此无需「变化原因」说明）。

---

## §四 完整验证

| 项 | 结果 |
|---|---|
| `npm run verify`（工作区） | **exit 0**｜TypeScript **0 错误**｜`tests 2062 / suites 137 / pass 2062 / fail 0`｜产物 **163/163** 一致 |
| 测试是否被删除/跳过/放宽 | **否**：`git show 536433d --stat` 只含 7 个文件，`test/preflopAllInGuard.test.ts` 为**新增**；无任何既有测试文件被修改；`skip/todo = 0`（verify 输出） |
| 未授权策略参数变化 | **无**：提交 diff 中不含任何阈值常量改动（`MIN_CATEGORY_FOR_LARGE_RAISE` / `MAX_RAISE_TO_POT_RATIO` / `RAISE_EDGE_*` / `MARGINAL_EV_GAP_RATIO` / `MODEL_UNCERTAINTY_RATIO` 全部未出现在 `+` 行） |
| **独立干净检出验证** | `git archive HEAD` → `%TEMP%\dezhou-f2ac-clean-131644`（**587 文件，只含已跟踪内容**，无任何未跟踪探针/证据）⇒ `npm run verify` **exit 0**｜`2062/2062`｜产物 **163/163** |

> 说明：干净检出首次运行报 `'tsc' is not recognized` —— 原因是检出目录**没有 `node_modules`**（依赖不入库），与代码无关；
> 用目录 junction 指向工作区 `node_modules` 后重跑即 **exit 0**。该失败**不是** PASS 造假，已如实记录。
> 干净检出中匹配「探针命名」的 5 个文件均为**历史已提交**产物：`scripts/p1-fix-sweep.ts`、`scripts/test18-amount-matrix.ts`、`reports/evidence/p1-fix-sweep-{before,after}.txt`、`reports/evidence/test18-amount-matrix.txt`。

---

## §五 GitHub 安全备份

**白名单（显式路径 `git add --`，未使用 `add -A`）**

```text
src/app/decision/decisionEngine.ts          （F2 生产修复）
src/domain/decision/decision.types.ts       （纯类型：allInGuard.street）
test/preflopAllInGuard.test.ts              （新增 11 项失败测试/回归）
reports/PREFLOP_DECISION_PATH_AUDIT_V1.md   （F2 的来源审计报告）
reports/PREFLOP_F2_ALLIN_GUARD_FIX.md       （F2 修复报告）
CURRENT_PROJECT_STATUS.md                   （状态文档 §10.0.22 + 计数同步）
data/artifact-manifest.json                 （产物清单刷新）
```

**未纳入（保留为未跟踪，留给下一轮各自的授权）**：本轮全部探针脚本（`scripts/flopriver-*`、`scripts/flriver-*`、`scripts/f2-*`、`scripts/preflop-path-audit*`）、
`reports/FLOP_RIVER_THEORY_EXPLOIT_AUDIT_V1.md`、`reports/evidence/*` 等约 131 个文件。

| 步骤 | 结果 |
|---|---|
| 提交 | `536433d fix: validate preflop all-in guard without changing postflop protection`（父 `91c35e8`），7 files changed, +1345 −11 |
| 提交后干净检出复验 | **exit 0**（见 §四） |
| 推送前查询远端 `main` | `91c35e8…`（= 本地提交的**祖先**，`git merge-base --is-ancestor` 判定可快进） |
| 推送 | `git push origin main` ⇒ `91c35e8..536433d  main -> main`（**快进**，无强制、无合并） |
| 推送后核对 | `origin/main = 536433d`；本地 `HEAD = 536433d`；**远程 HEAD 与本地 HEAD 一致 = True** |
| 未跟踪文件 | **131 个全部保留**（未清理、未删除） |

---

## §六 翻牌/河牌审计报告复核（`reports/FLOP_RIVER_THEORY_EXPLOIT_AUDIT_V1.md`）

对每一项按 7 个维度复核（① 生产入口复现 ② 规则/数学 Bug ③ 模型能力缺口 ④ 未经校准的策略假设 ⑤ 是否影响最终动作 ⑥ 是否影响画像剥削 ⑦ 是否已被测试/后续修复覆盖）：

| 发现 | ① | ② | ③ | ④ | ⑤ | ⑥ | ⑦ 覆盖情况 |
|---|---|---|---|---|---|---|---|
| **CB-1** 条件范围互斥（R-05：`nutDensity 0.88` vs `callLikelihood 0.865`、`reRaise 0`）驱动全下 | ✅ 生产入口（`analyzeManualHand` R-05 NORMAL/STATION 两画像） | 属**模型接口缺陷**（两个子模型各自归一化、互不约束），非纯数学错误 | ✅ U1 响应模型缺「当前下注范围强度下限」输入 | ✅ 两条通道均为结构性先验 | ✅ **是**（`RAISE 166` 全下 / STATION 变体 `FOLD`） | ✅ 间接影响（画像改变权益 ⇒ 同节点相反动作） | ❌ **无测试**：`nutDensity` 出现 7 次但无「与响应模型一致性」断言 |
| **CB-2** BET 侧「已算 EV」与 `BET_EV_NOT_IMPLEMENTED` 并存 | ✅ F-02/F-05/R-01/R-02/R-04 | 披露一致性缺陷（非数学） | ✅ BET 侧缺 `raiseSizesWithOwnEV` 同源机制 | — | ❌ 否（不改变动作） | ❌ 否 | ❌ **无测试**：`BET_EV_NOT_IMPLEMENTED` / `ACTION_EV_COMPARISON` 在 `test/*.ts` 中出现 **0** 次 |
| **CB-3** 踢脚文案取公共牌（K5/K4 显示「8踢脚」） | ✅ Agent 1 生产节点 | 文案缺陷（数字符合规则） | — | — | ❌ 否 | ❌ 否 | ❌ **无测试**（`kickerRank` 0 次） |
| **CB-4** 河牌仍报 `flushDraw=true / discountedOuts=9` | ✅ Agent 1 生产节点 | **数据层缺陷**（`draws.ts` 不按街停用） | ✅ 下游（`betResponse` / `rangeFacts` / `rangeCompression`）同样未按街停用 | — | ⚠️ **未证实**（因果混杂：对照牌面花色构成不同） | ❌ 未证实 | ❌ **无测试**（`handStructure` 0 次；且该字段目前只写不读） |
| **CB-5** 跨动作 EV 差落在自述容差带内仍决定「全下/弃牌」 | ✅ R-05 两画像 | **规则/纪律违背**（引擎自述「工程容差不翻转动作」） | ✅ 跨动作比较缺「带内不得升级为消耗筹码动作」约束 | — | ✅ **是** | ✅ 间接 | ❌ **无测试** |
| **CB-6** FOLD 节点 `actionEvidence = []` | ✅ R-03 STATION | 审计性缺陷 | — | — | ❌ 否 | ❌ 否 | ⚠️ 部分（`riverConsistencyV21` 只验证分割守恒，未验证证据表完整性） |
| **CB-7** 文案「不读我的底牌」不精确（阻断通道确实读牌） | ✅ 四底牌受控对照 | 文案精度 | — | — | ❌ 否 | ⚠️ 间接（阻断只进偏好分） | ❌ **无测试** |
| **CB-8** 固定实现因子 0.73 / 超池封顶 100% | ✅ F-02/F-05/R-01 vs 探针 ③（`actualRatio 1.2029 → modeledRatio 1.0`） | — | ✅ 模型能力缺口 | ✅ | ⚠️ 是（CHECK/BET EV 的绝对值） | ❌ 否 | ✅ `sizeApproximation` 在测试中出现 3 次（`riverBetRangeV2` / `test09`）⇒ 已覆盖且属**已披露**限制 |
| **M6 / M14 / M19** | — | — | — | — | — | — | **保持 NOT_TESTED（本轮未改写为 CONFIRMED_BUG）** |

**M6 / M14 / M19 的最小补测方法（原状态保持）**

- **M6（画像融合后是否二次按样本量衰减）**：对同一节点构造「仅有标签」「标签 + 实测统计 800 手」「标签 + 实测统计 50 手」三组，
  读取 `context.profileV3.resolvedDimensions` 与 `postflop.betDecision.sizes[].foldLikelihood`，
  断言 `dimensions = 1 + (raw − 1) × confidence` 的**单次**缩放关系（`betResponse.ts:400`），并检查 `confidence` 是否同时进入 `rangeCompression`。
- **M14（错失听牌是否进入河牌诈唬范围）**：构造**三花转牌 + 河牌空白**（如 `K♦9♣4♣6♣2♦`，Hero 不持草花）与干燥面对照，
  比较 `bettingRangeFacts` 的 `bluffDensity/airDensity`、`betDecision.sizes[].raiseComboCount` 与 `foldLikelihood`；
  断言「错失听牌面」的诈唬质量占比**显著不同**（当前探针因牌面只含两张草花而无效）。
- **M19（牌面纹理标签语义）**：`diagnostics` 无 `boardTextureZh`（本轮探针取值为 `undefined`），
  需从 `boardDelta` / `rangeCompression` 的定义与 `BOARD_DELTA` 理由文本逐条对照（例如「白板度」「范围适配度」的阈值来源），
  或在展示层新增该字段后再断言，属**需要先补诊断字段**的条目。

---

## §七 第一性原理与墨菲定律（本轮 M1–M12）

| # | 风险 | 结果 | 证据 |
|---|---|---|---|
| M1 | F2 修复后翻后一对牌保护意外失效 | ✅ 未发生 | F-b `blocked=true`；133 节点指纹 + 15 节点验收中「非 guard 差异行 = 0」；`M5-1` 测试通过 |
| M2 | 翻前合法全下进入候选，却被其他启发式静默删除 | ✅ 未发生（且已披露） | 全下进入证据表（`heuristicScore>0`）并被 `overrideJustification` 记录；未选中时给出 `overrideBlockedReason = CANNOT_OVERRIDE_CLEAR_SUPPORTED_CALL_WITH_UNEVALUATED_ALL_IN` |
| M3 | 全下无 EV，界面却宣称它是 EV 最高 | ✅ 未发生 | A/B/C/I：`RAISE=null/HEURISTIC`、`ALL_IN@8:RAISE_EV_NOT_IMPLEMENTED`；无 RAISE EV 理由码（`F2-3` 断言） |
| M4 | F2 修复影响 CALL/FOLD 裁决，正 CALL EV 被弃掉 | ✅ 未发生 | R4 `CALL EV +2.71 ⇒ CALL 20`；R5 `+19.70 ⇒ CALL 40`；`callFoldVerdictRuler` 11 项全通过 |
| M5 | 翻后面对下注的条件范围被替换为整体范围 | ✅ 未发生 | `conditionalEquities` 三路分列（arrival 69.8–86.5% / betRange 58.6–85.7% / wholeRange）；CALL EV 标注使用 `EqVsBetRange` |
| M6 | 同一对手行动在到达/下注范围重复计票 | ✅ 未复现（沿用既有守恒回归） | `riverConsistencyV21.test.ts:605`（更强+更弱+打平 = 可达总数）本轮通过；`rangeCounts` 为**到达口径**（`rangeFacts.ts:245`） |
| M7 | 画像实测统计被重复样本量收缩 | ⚠️ 未测 | 见 §六 M6 补测方法（保持 NOT_TESTED） |
| M8 | Hero 隐藏底牌影响对手下注概率模型 | ✅ 未复现为「牌力泄漏」 | 四底牌对照：`foldLikelihood` 变化可由 `reachableCombos 498→538` 的阻断效应解释；文案精度问题见 CB-7 |
| M9 | 不可能发生的再加注分支仍参与 EV | ✅ 未发生 | 加注即全下的节点 `reRaiseLikelihood = 0`（R-05/R-06/R5/R7）；P0 夹具测试断言短筹码场景为 0 |
| M10 | 加注至的本街累计金额与实际新增投入混淆 | ✅ 未发生 | R3 `RAISE 186`（本街已投入 20 ⇒ 新增 166）；R7 `heroAdd 120, heroContestedAdd 34, uncalledReturn 86, finalPot 121` |
| M11 | 未评估加注尺寸被显示为 EV 较低 | ✅ 未发生（但发现**反向**问题） | 本轮：`unevaluatedActions` 只写 `NOT_IMPLEMENTED`，不写「更低」；**反向**问题见 CB-2（已评估的 BET 被写成未实现） |
| M12 | 为让验收通过而擅改阈值 / 权重 / 旧测试预期 | ✅ 未发生 | 提交 7 文件、无阈值常量改动、无既有测试文件改动、无断言放宽；测试数 2051 → 2062（+11 新增） |

---

## §八 下一阶段修复排序（最多三项，**未授权开发**）

> 明确排除：完整跨街 Solver、商业 GTO 数据、重构人物画像系统、重新设计 EV 模型。
> 下列条目只是**建议**，需使用者单独授权后才实施。

### ① CB-1 + CB-5（同一处，最高优先）
- **缺陷**：跨动作 EV 差落在引擎自述容差带内仍决定 `consumesStack` 的动作；且 U1 加注响应（`callLikelihood 0.865`、`reRaise 0`）与当前下注范围（`nutDensity 0.88`）互不约束。
- **最小复现**：`R-05`（BTN A♠K♠，K♦9♣4♥6♠2♦，河牌面对 120% 池 83 筹码）⇒ `RAISE 166`（全下）；换 `CALLING_STATION` ⇒ `FOLD`。
- **影响决策**：河牌（及转牌）面对大注的 CALL/RAISE/ALL-IN；一对牌的巨额投入。
- **需改文件/函数**：`src/domain/decision/evidencePriority.ts`（跨动作分支加「带内 ⇒ 优先不消耗筹码」约束）、`src/domain/postflop/betResponse.ts`（响应模型接入 `bettingRangeFacts` 的强度下限作为约束或降级为 `NOT_IMPLEMENTED`）。
- **是否涉及资金/EV 公式**：**涉及规则约束，不改 EV 公式**（`raiseEV` 计算式不动）。
- **是否需新增统计数据**：**否**（用已有的范围压缩度量做一致性约束）。
- **能否在现有结构内完成**：可以。
- **最小失败测试 + 回归**：`test/` 新增断言「带内跨动作差 ⇒ 不得选 `consumesStack` 动作」「`nutDensity>0.8` ⇒ `callLikelihood(全下) ≤ 0.6 ∨ reRaiseLikelihood > 0`」；回归要求：133 节点指纹 + TEST 16/17/18 + U1/V2 组全绿。

### ② CB-2（BET 侧证据通道）
- **缺陷**：`betDecision.sizes[].betEV` 有值并据以选动作，但 `actionEvidence = []`、BET 候选 `ev=null`、`unevaluatedActions` 报 `BET_EV_NOT_IMPLEMENTED`。
- **最小复现**：`F-02`（暗三条·对手过牌）⇒ `basis=ACTION_EV_COMPARISON` + `actionEvidence=[]`。
- **影响决策**：不改变动作；影响**可审计性**与使用者对依据的信任。
- **需改文件/函数**：`src/app/decision/decisionEngine.ts:3388-3401`（BET 同源清单）+ `src/viewmodels/decisionViewModel.ts`（一行展示）。
- **是否涉及资金/EV 公式**：否。
- **是否需新增统计数据**：否。
- **最小失败测试 + 回归**：断言「`betDecision.bestSize` 存在且 `betEV` 有限 ⇒ 不得列入 `BET_EV_NOT_IMPLEMENTED`，且证据表须含 BET（`MODEL_EV`）」；回归：无人下注节点的展示快照。

### ③ CB-4（河牌幽灵听牌，按街停用）
- **缺陷**：`drawProfileOf` 不区分钟街，河牌仍产出 `flushDraw/discountedOuts` 并被 `betResponse`/`rangeFacts`/`rangeCompression` 消费。
- **最小复现**：Agent 1 节点（`Kd Qc Jc 4s 2c` 等）⇒ `handStructure.flushDraw=true, discountedOuts=9`。
- **影响决策**：当前 `handStructure` 只写不读（无直接影响）；下游因果**未证实**。
- **需改文件/函数**：`src/app/manualInput/contextBuilder.ts:4523-4534`（按 `cardsToCome` 停用）、`src/domain/postflop/draws.ts`（街参数化）。
- **是否涉及资金/EV 公式**：否（只停用不适用的听牌事实）。
- **是否需新增统计数据**：否。
- **最小失败测试 + 回归**：断言河牌 `handStructure.flushDraw === false && discountedOuts === 0`；随后**单独评估**响应模型是否有数值回归（若有，则本项升级为独立一轮）。

**不列入本轮（记录在案）**：CB-3 / CB-6 / CB-7（文案与审计性，可随时做）、CB-8（固定实现因子与超池封顶需**新的校准数据**，不属「最小修复」）；M6 / M14 / M19 仍是 NOT_TESTED，先补测再决定。

---

## §九 最终验收块

```text
F2_FINAL_ACCEPTANCE_AND_NEXT_PHASE = DONE
BASELINE = 分支 main｜HEAD 91c35e8（= origin/main，推送前）｜已修改 4（F2 未提交）｜已暂存 0｜未跟踪 133｜
           test/*.test.ts 106｜产物 163｜已有检查点 7 个（含 preF2 修复前基线）
WORKSPACE_CHECKPOINT = %TEMP%\dezhou-checkpoint-f2ac-20260920-131436 ｜ 719/719 文件逐位 sha256，0 差异 ｜
           FILES.sha256.txt sha256 = 46CD6F9DFAF98BD49EB92A12CD29DB94F23B08BBDED4A6478222697001048406
           （含已提交 + 未提交 + 全部未跟踪成果；未执行 reset/restore/clean/checkout --/add -A）
F2_PREFLOP_ALLIN_GUARD = PASS —— A/B/C：onePairAllInBlocked true→false、street=PREFLOP、全下进入证据表
           （heuristicScore 0→>0）；D/E/F/G/H/I 逐字未变；4BB 独立 ALL_IN 候选保留
POSTFLOP_PROTECTION_PRESERVED = YES —— F-b（多人池顶对，consumesStack ∧ !hasOwnEV）⇒ blocked=true；
           133 节点指纹与 15 节点验收中「非 guard 差异行 = 0」
SHORT_STACK_LEGALITY = OK —— H(3BB)：minRaiseTo 10 > allInTo 6 ⇒ 无加注、跟注即全下（有效筹码 0）；
           I(4BB)：ALL_IN@8 合法且未被拦；翻后 R-06：minRaiseTo 200 > allInTo 166 ⇒ 仅 ALL_IN@166
RAISE_EV_PROVENANCE = 如实 —— 翻前全下/加注 ev=null、estimateType=HEURISTIC、raiseSizesWithOwnEV=[]、
           无 RAISE_MODEL_EV / ISO_RAISE_MODEL_EV 理由；「合法性已修复」与「策略尚无 EV 依据」已在 §二 明确区分
FLOP_RIVER_REGRESSION = PASS —— R1–R7（TEST16/17/18、99 CALL EV、AK 河牌、99 河牌加注、P0-7）修复前后逐字一致；
           TEST 18 数值 CALL 75.18 / RAISE 186 EV 93.98；P0-7 uncalledReturn 86 / finalPot 121
CALL_FOLD_CONSISTENCY = OK —— 99 节点 CALL EV +2.71 ⇒ CALL 20；AK 河牌 +19.70 ⇒ CALL 40；callFoldVerdictRuler 11/11
PROFILE_IDENTITY_PRESERVED = YES —— TEST 16 节点 seat_BB / player_001 / 阿豪 / 800 手实测统计逐字未变；
           画像身份路由与统计来源未被本轮触碰
EV_FORMULAS_UNCHANGED = YES —— callEV / edge / verdictEdge / 分层 EV / 加注 EV / 下注 EV 公式与全部策略阈值均未改动
TYPECHECK = 0 错误（tsc --noEmit，工作区与干净检出均为 0）
TESTS_PASS = 2062 ｜ TESTS_FAIL = 0 ｜ suites 137（skip/todo = 0）
MANIFEST = 163/163 一致（工作区与干净检出均通过 manifest:check）
CLEAN_CHECKOUT_VERIFY = PASS —— git archive HEAD ⇒ 587 文件（仅已跟踪内容，无未跟踪探针/证据）⇒ verify exit 0、
           2062/2062、163/163。（首次失败原因 = 检出无 node_modules 导致 tsc 缺失，已如实记录并用 junction 解决，
           未改动任何源码或断言）
LOCAL_COMMIT = 536433def5c8e62b5401451505aa2d5b70e29c29（父 91c35e8；7 文件 +1345 −11）
REMOTE_COMMIT = 536433def5c8e62b5401451505aa2d5b70e29c29（origin/main，推送后核对；远程 HEAD == 本地 HEAD = True）
GITHUB_BACKUP_COMPLETE = YES —— 白名单显式暂存（7 个文件）；推送前确认远端 91c35e8 为本地提交祖先（可快进）；
           git push origin main ⇒ 91c35e8..536433d（无 --force、无合并）；未跟踪 131 个文件全部保留；
           本轮审计报告与全部探针脚本**未纳入**本次提交（留给下一轮各自授权）
CONFIRMED_FLOP_RIVER_BUGS = CB-1（条件范围互斥→全下）｜CB-2（BET EV 口径互斥）｜CB-3（踢脚文案）｜
           CB-4（河牌幽灵听牌，数据层）｜CB-5（带内差异决定全下/弃牌）｜CB-6（FOLD 无证据表）｜CB-7（文案不精确）
NOT_TESTED_ITEMS = M6（画像二次收缩）、M14（错失听牌诈唬范围）、M19（牌面纹理语义）—— 状态**保持 NOT_TESTED**，
           未改写为 CONFIRMED_BUG；§六 已分别给出最小补测方法
NEXT_MINIMAL_FIX_PRIORITY = ①CB-1+CB-5（规则约束，涉资金安全）②CB-2（BET 证据通道，只改可审计性）
           ③CB-4（按街停用幽灵听牌，改后再评估下游）；CB-3/CB-6/CB-7 备选，CB-8 需新校准数据
UNAUTHORIZED_FILE_CHANGES = 0 —— 本轮未改策略参数/画像权重/GTO 范围/EV 公式；提交仅含白名单 7 文件；
           未删除或清理任何未跟踪文件（131 → 保留）
SAFE_TO_CONTINUE_HAND_TESTING = YES（可作牌局复核工具）；「面对大注/超池」的河牌节点仍须人工复核 CB-1/CB-5；
           真实资金决策仍为 NO（范围为未校准先验、无求解器验证、CB-1/CB-5 未修）
```

---

## §十 下一轮待处理问题（最多三项）

1. **CB-1 + CB-5**（证据：R-05 生产运行 —— `nutDensity 0.88` 与 `callLikelihood 0.865 / reRaise 0` 并存，EV 差 3.08 落在 ±11.75 带内却选全下；换画像即变 FOLD）
2. **CB-2**（证据：F-02 生产运行 —— `basis=ACTION_EV_COMPARISON` 列 `BET_SMALL EV 12.66` 等数值，同屏 `actionEvidence=[]` 且全部 BET 尺寸列 `BET_EV_NOT_IMPLEMENTED`）
3. **CB-4**（证据：河牌生产节点 `handStructure.flushDraw=true / discountedOuts=9`，而 `relativeHandRole` 已按街停用 ⇒ 同一引擎两套口径）

**未授权开发，等待指示。**
