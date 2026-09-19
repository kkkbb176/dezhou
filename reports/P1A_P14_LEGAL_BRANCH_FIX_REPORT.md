# P1-2a / P1-4 定向修复报告（第一阶段）

> 授权范围：仅修 **P1-2a**（U1 加注响应链的「不可能再加注分支」）与 **P1-4**（同根因的既有下注响应通路）。
> **未**实施 P1-2b（Hero 跟注再加注的选择权）、多尺寸 EV 优化、人物画像权重调整或任何其它策略改动。
> 修复依据 = 合法动作与概率分支的共同边界；**没有任何按手牌/节点硬编码的金额**。

---

## A. 缺陷根因及准确代码位置

```text
共同根因：模型只判断「我（Hero）是不是全下」，从不判断「对手跟平之后还剩不剩筹码」。
          而对手「跟注即全下」时，下注轮随即结束，引擎会拒绝他的任何再加注
          （实测 ISSUE.ACTION_AFTER_HAND_OVER）⇒ 该分支不可能存在。
```

| 通路 | 位置（修复前） | 表现 |
|---|---|---|
| **P1-2a** U1 加注响应 | `src/app/manualInput/raiseResponse.ts` 的 `if (!input.heroIsAllIn) { …reRaiseShare… }`；调用方 `src/app/manualInput/contextBuilder.ts` 只传了**已封顶**的 `villainAdd`，没传「他这一跟就是全下」 | P0-7 节点：`P(再加注) = 43.108%`，每个单位按 `−heroContestedAdd` 计 |
| **P1-4** 下注响应 | `src/domain/postflop/betResponse.ts` 的 `raiseShare = input.heroIsAllIn ? 0 : rawRaiseShare`（`heroIsAllIn` 只由 `input.heroRemaining` 推导）；`legalizeBetSizes` 的下注额上限是 `min(heroRemaining, villainRemaining)`，因此「下注额 = 对手全部剩余」是合法候选 | BB 20BB 节点：`P(加注) = 5.230%` |

**独立复现（先做，且不看报告的结论）**：
`reports/evidence/p1a-reraise-repro-before.txt`（引擎级重放：他跟注 14 → `allIn = true`、剩余 0 →
再 RAISE 被拒 `ACTION_AFTER_HAND_OVER`，而模型给 43.108%）；
`reports/evidence/p14-betresponse-repro-before.txt`（下注 14 = 他全部剩余 → 引擎同样拒绝，模型给 5.230%）。
**报告与实际代码一致，未发现不一致项。**

---

## B. 修改文件清单及每处修改目的

| 文件 | 修改 | 目的 |
|---|---|---|
| `src/app/manualInput/raiseResponse.ts` | 入参新增**必需**字段 `villainIsAllInByCall`；`reRaiseShare` 的守卫改为 `if (!heroIsAllIn && !villainIsAllInByCall)`；`model` / `noteZh` 如实上报 | 禁止生成不可能的再加注分支，质量按既有机制**迁移到跟注桶** |
| `src/app/manualInput/contextBuilder.ts` | 用**实际筹码**算 `villainIsAllInByCall = opponent.remainingStack <= villainAdd + 1e-9`（含**恰好用光**的边界）；随事实包与诊断带出；假设清单注明两个判据独立 | 判据来自状态、不硬编码；两个全下判据**分开** |
| `src/domain/decision/decision.types.ts` | 事实包/诊断类型新增 `villainAddRaw`、`villainIsAllInByCall`（必需） | 披露与可审计 |
| `src/app/decision/decisionEngine.ts` | `postflopSnapshotOf` 原样搬运新字段 | 诊断可见（测试与界面读它） |
| `src/domain/postflop/betResponse.ts`（**P1-4**，既有模块） | `ResponseInput` 新增必需 `villainIsAllInByCall`；`raiseShare` 改为 `cannotRaise = heroIsAllIn \|\| villainIsAllInByCall`；`buildResponseModel` 新增 `villainRemaining` 并用实际筹码算该标志；`SizeResponse` 暴露该字段；理由文案区分「我全下」与「他跟注即全下」 | 同一条规则的第二个通路 |
| `src/app/decision/postflopAdvisor.ts` | `BetSizeAdvice` 与映射带上 `villainIsAllInByCall` | 下注建议可审计 |
| `test/raiseReraiseBranchLegality.test.ts`（新增，13 项） | A–H + I1–I4 + P1-4-1…3 + 控制组 | 锁住「非零概率 ⇒ 真实可达」 |
| 既有测试的机械适配 | `test/betDecisionEngine.test.ts`（2 处）、`test/raiseResponseU1.test.ts`（1 处） | 新增必需字段 ⇒ 明确声明「对手不会因跟注全下」；**断言未放宽、未删除** |

---

## C. P1-2a 修复前后对比（P0-7 夹具：Hero 100BB A♠K♠ / BB 30BB / 河牌 BB 下注 10BB）

| 项 | 修复前 | 修复后 |
|---|---|---|
| 加注至 / 他补 / 终池 / 退回 | 120 / 14 / 121 / 86 | **完全相同**（修复不动钱） |
| `villainIsAllInByCall` | 未上报（模型不知道） | **true** |
| P(弃) / P(跟) / **P(再加注)** | 5.297% / 51.595% / **43.108%** | 5.297% / **94.703%** / **0.000%** |
| EqVsRaiseCallRange | 0.6270 | **0.5380**（质量并入跟注桶 ⇒ 对手更强，权益如实下降） |
| RAISE EV | +10.8102 | **+33.3158** |
| **最终动作** | **CALL @ 20** | **RAISE @ 120**（RAISE 33.32 vs CALL 20.53，差距 12.8 > 容差带 ±4.65） |

**EV 变化可完整追溯（+22.51 的三项分解）**：
`+14.657`（删掉不可能的再加注分支）+ `+13.400`（43.108% 质量并入跟注桶，按新权益计价）+ `−5.556`
（权益本身从 0.6270 降到 0.5380，作用于原有跟注质量）= **+22.50** ✔（与 +33.3158 − 10.8102 一致）

**控制组（无该缺陷的节点一律不动）**：KQ 节点（对手 100BB）`P(弃)/P(跟)/P(再加注) = 0.16952719033920757 /
0.6611688848970236 / 0.16930392476376954` **逐位不变**；三个核心节点（AK / 99 / F-01）与 TEST 4、
第二形态的资金与 EV **逐位不变**（见 F）。

---

## D. P1-4 修复前后对比（Hero BTN 100BB / BB 20BB / 河牌 BB 过牌 ⇒ Hero 下注）

| 项 | 修复前 | 修复后 |
|---|---|---|
| 合法下注额（被封顶） | 14 = 他的全部剩余 | 14（不变） |
| `heroIsAllIn` | false | **false**（判据独立） |
| `villainIsAllInByCall` | 未上报 | **true** |
| P(弃) / P(跟) / **P(加注)** | 9.921% / 84.849% / **5.230%** | 9.921% / **90.079%** / **0.000%** |
| 引擎侧 | `CALL 14 → allIn = true、剩余 0`；`RAISE → ACTION_AFTER_HAND_OVER` | 同 |

**控制组**：对手 100BB 时仍存在 `P(加注) > 0` 的尺寸 ⇒ 合法的加注分支未被误杀（测试 P1-4-3）。

---

## E. 新增和原有测试结果

```text
新增 test/raiseReraiseBranchLegality.test.ts：13 项，全部通过
  A 双方未全下且可完整再加注        → 分支保留、villainAdd === villainAddRaw、无退回
  B Hero 全下                       → P(再加注) = 0，质量迁移（弃+跟 = 1），且 villainIsAllInByCall = false
  C 对手跟注即全下（P0-7）          → P(再加注) = 0；villainAdd 14 / contested 34 / 退回 86 / 终池 121 不变
  D 短筹码全下加注仍合法（KQ）      → 分支**保留**（不得误杀）
  E 可完整再加注                    → 分支保留
  F 多余筹码退回                    → 退回 = heroAdd − contested；终池 = pot + contested + villainAdd
  G 边界（恰好用光）                → 判为「跟注即全下」、P(再加注) = 0、无退回
  H Hero 本街已投 10                → heroAdd = R − 10；villainAdd = R − 对手本街已投；不重复扣 callCost
  I1–I4 不变量（逐场景）            → 全下⇒rr=0｜rr>0⇒他确有筹码｜ΣP=1（±1e-12）｜分支投入 ≤ 实际筹码
  P1-4-1/2/3                        → 下注吃光他筹码 ⇒ 加注 = 0；逐尺寸不变量；对手充足时分支保留
  控制组                            → 对手 100BB 节点三个概率逐位不变

针对性回归：raiseEvCashflowP0 + raiseResponseU1 + riverRaiseDecisionV2 + betDecisionEngine = 62 项，全部通过
```

---

## F. 完整验证结果

```text
typecheck:  0 errors（tsc --noEmit，exit 0）
tests:      1951
pass:       1951
fail:       0
suites:     137
manifest:   158/158 一致（exit 0）
verify:     exit 0
端到端重放（生产入口）：
  AK 河牌 CALL 40（EV 逐位 −7.375830）｜99 暗三条 RAISE 174（+174.402566）｜
  F-01 翻牌 RAISE（+1226.726791）｜TEST 4 CALL（+2166.233954）｜第二形态 CALL（+34.962428）
  ⇒ **与本轮修复前逐位一致**（这些节点不含被封顶的对手）
  KQ 控制节点：CALL，RAISE EV −8.700406，P(弃/跟/再加) = 16.40%/67.05%/16.54% ⇒ 未变
```

**未删除任何测试、未放宽任何断言、未修改基线、未调整画像参数。**

---

## G. 资金流、条件权益及 EV 变化说明

1. **资金流不变**：`heroAdd / villainAdd / heroContestedAdd / finalPot / uncalledReturn` 在 P0-7 节点
   修复前后完全相同（120 / 14 / 34 / 121 / 86），引擎 `contested = 121`、`returned = {BTN: 86}` 与之一致
   ⇒ 修复只动**分支结构**，不动钱。
2. **条件权益如实重算**：再加注质量并入跟注桶后，`EqVsRaiseCallRange` 由 0.6270 降到 0.5380
   —— 这是**正确方向**（他会用原本想加注的强牌跟注）⇒ 满足「概率质量重新分配必须同步检查条件范围与权益」。
3. **EV 变化可追溯**：见 C 节的三项分解（+14.657 / +13.400 / −5.556）。
4. **概率归一**：两处修复后 `ΣP = 1`（实测 5.297+94.703 = 100.000；9.921+90.079 = 100.000）。
5. **不得混用的两个判据**：`heroIsAllIn`（我投光）与 `villainIsAllInByCall`（他跟注即投光）
   在类型、代码与文案三处分开；场景 B 专门锁「Hero 全下但对手筹码充足」时后者必须为 false。

---

## H. 未解决问题与潜在回归风险

**未解决（本轮未授权）**
1. **P1-2b**：被再加注分支仍假定 Hero 弃牌 ⇒ RAISE EV 是**宽松下界**（本节点 13–26 筹码/尺寸，S1 节点可达 ~+28）。
2. **P1-1**：用户提供的 1200 手统计被解析但不参与决策（带/不带逐位一致）。
3. **P1-3**：U1 用标签维度、`betDecision` 用融合维度（同节点 1.0882/0.9027 vs 1.078984/0.911353）。
4. **P2-1**：只评估一个启发式尺寸（全量最优 57 / 网格最优 60，生产选 120）。
5. **P2-2/P2-3**：诊断 `player` 块自述「无实测数据」；trace 印「伪计数 6」而实际 K = 200。
6. **本轮新观察（未修，未授权）**：下注通路存在**推荐尺寸 ≠ 被评估尺寸**的迹象 ——
   BB 20BB 节点里诊断 `sizes` 只有 **14**（封顶全下），而决策层给出的建议是 **BET 13**（`sizeBB 6.5`），
   即界面推荐的那个金额**不是**响应概率所对应的金额。需要单独复现（疑与 `legalizeBetSizes` 的
   去重/封顶与决策层候选网格不一致有关）。

**潜在回归风险**
- 新增必需字段会强制所有调用方表态：`classifyResponse` 的 3 个测试调用点已显式传 `false`；
  `scripts/` 下的历史审计脚本未传该字段（运行期 `undefined` ⇒ 行为与修复前一致，故历史证据仍可复现原缺陷）。
- `betResponse.ts` 属既有已验证模块：改动仅在 `raiseShare` 的守卫与一个新字段；
  `betDecisionEngine`（62 项之一）、`postflopRegressionCases`、`alphaRedteamRegression` 全绿。
- 若将来有人把「他跟注即全下」与「我全下」合并成一个 `isAllIn`，场景 B/控制组会立刻变红（刻意设计）。

---

## I. 当前 Git 工作区状态（本轮 vs 既有修改的区分）

```text
HEAD = a914f9c83410ca95cedd3bbd90bcf00b8e862728｜branch = main｜未提交 = 105 项（执行前 99 项）
```

| 类别 | 文件 |
|---|---|
| **本轮新修改的已跟踪文件（4）** | `src/domain/postflop/betResponse.ts`、`src/app/decision/postflopAdvisor.ts`、`test/betDecisionEngine.test.ts`、`data/artifact-manifest.json` |
| **本轮修改、但本就在既有未提交清单里（5）** | `src/app/manualInput/contextBuilder.ts`、`src/app/decision/decisionEngine.ts`、`src/domain/decision/decision.types.ts`、`CURRENT_PROJECT_STATUS.md`、`test/raiseResponseU1.test.ts`※ |
| **既有未提交、本轮未触碰（9）** | `src/app/manualInput/bettingRange.ts`、`src/domain/decision/evidencePriority.ts`、`src/domain/player/observedStats.ts`、`src/infra/artifactDefinitions.ts`、`test/alphaRedteamRegression.test.ts`、`test/postflopRegressionCases.test.ts`、`test/profileRangeAdjustment.test.ts`、`test/test09BetRangeAudit.test.ts`、`src/app/manualInput/raiseResponse.ts`※ |
| **本轮新增（未跟踪）** | `test/raiseReraiseBranchLegality.test.ts`；脚本 `scripts/p1a-reraise-repro.ts`、`scripts/p1a-scenario-debug.ts`、`scripts/p14-betresponse-repro.ts`（另有审计轮遗留的 4 个脚本）；证据 `reports/evidence/p1a-*.txt`、`p14-*.txt` |

※ `raiseResponse.ts` 与 `raiseResponseU1.test.ts` 是本会话早前（U1/P0 修复轮）新建的文件，故不在既有 13 项清单内。

**未执行**：`git add/commit/stash/checkout/clean`；未回滚或清理任何既有改动；未修改无关模块。

---

## 第一阶段完成，停止并等待第二阶段授权。
