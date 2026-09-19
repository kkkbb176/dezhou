# U1 RAISE EV P0 修复 —— 定向修复与墨菲定律验收报告

> 修复轮。范围**只有** U1 已确认的资金记账与赔率缺陷。
> 未修改：人物画像 Resolver / Archetype 参数 / Betting Range V2 权重 / 翻前 GTO 范围 /
> 牌力求值器 / 下注响应系数 / UI / Opportunity Model / 跨街 Solver。
> 未清理、未回滚任何既有未提交工作。
>
> 基准：`HEAD = a914f9c`（`main`），`ALPHA_DECISION_MODEL_VERSION = '1.0.7'`，
> 修复前工作区 85 项未提交变更；测试基线 **1,923 项 / 137 套件 / 0 失败**。

---

## A. Root Cause

```text
旧公式（contextBuilder 第 4d 步，U1 原实现）
    potBeforeBet = computePot(state) − betChips          // 把对手这一注从底池里扣掉
    increment    = raiseTo − streetAlready − betChips    // 这是**对手**还要补的钱
    finalPot     = potBeforeBet + 2 × increment          // 少 2×betChips
    RAISE EV     = P(弃)×potBeforeBet                    // 少赢 betChips
                 + P(跟)×(EqVsRaiseCallRange×finalPot − increment)   // 投入少算 betChips
                 + P(再加注)×(−increment)                // 少扣 betChips
同时 raiseResponse.ts 的价格 = increment / (potBeforeBet + 2×increment)   // 分母同样少 betChips

新公式
    heroAdd             = raiseTo − heroStreetCommitted                      // 我方真正新增
    villainAdd          = min(raiseTo − villainStreetCommitted, 对手剩余筹码) // 他真正要补（封顶）
    我方留在池中         = min(heroAdd, 对手跟平后本街总额 − 我方本街已投)      // 退回不算投入
    finalPot            = currentPot + 我方留在池中 + villainAdd
    RAISE EV            = P(弃)×currentPot                                   // 赢下**完整**底池
                        + P(跟)×(EqVsRaiseCallRange×finalPot − heroContestedAdd)
                        + P(再加注)×(−heroContestedAdd)                      // 全下时 P(再加注) ≡ 0
    对手跟注所需权益     = villainAdd / finalPot
```

**具体修改文件与函数**

| 文件 | 改动 |
|---|---|
| `src/app/manualInput/raiseResponse.ts` | `buildRaiseResponse` 入参改为**资金事实**（`currentPot/heroAdd/villainAdd/heroContestedAdd/finalPot`）；`price = villainAdd/finalPot`；`ratioToPot = heroAdd/currentPot`；新增 `CASHFLOW_CONTRACT` 契约常量；**新增唯一 EV 公式 `raiseEVOf`** |
| `src/app/manualInput/contextBuilder.ts` | 第 4d 步：用 `committedThisStreet` 读**双方本街已投**（不再假设单次下注）；尺寸选择与决策层统一（`buildSizeGrid(legal, currentPot, 'RAISE')` + `desiredTo = currentPot + 2×callCost`，修掉 D2 静默关闭）；多人底池**显式拦截 + 警告**；资金量随事实包与诊断一起带出 |
| `src/app/decision/decisionEngine.ts` | `raiseModelUsable` 增加**硬门槛**：必须带 `cashflowContract` 且四个资金量有限自洽；尺寸不匹配时输出 `RAISE_EV_SIZE_MISMATCH`（不再静默关闭）；口径不符时输出 `RAISE_EV_CASHFLOW_CONTRACT_REJECTED` |
| `src/domain/decision/decision.types.ts` | 事实包与诊断类型补上资金口径字段 |
| `src/infra/artifactDefinitions.ts` | **补登记** `raiseResponse.ts`（此前不在产物清单 ⇒ 改它没有任何 hash 提示） |
| `test/raiseEvCashflowP0.test.ts`（新增，15 项） | P0-1…P0-9 + M1–M4 独立不变量 + 两道安全门 |
| `test/raiseResponseU1.test.ts` | 旧断言**复刻了错误口径**（详见 §F-10），已按资金事实重写 |
| `scripts/u1-audit-ev-convention.ts` | 从「最小复现」改为「修复后复核」：逐位一致性 + 四条契约 + 修复前后对照 |

---

## B. Before / After（三个核心节点）

### HAND A · AK 河牌（Hero BTN A♠K♠｜K♦9♣4♥6♠2♦｜底池 93｜对手下注 40｜Hero 剩余 174｜CALLING_STATION）

| 项 | 修复前 | 修复后 |
|---|---|---|
| 终池（他跟注） | 321 = 53 + 2×134 | **401 = 93 + 174 + 134** |
| 我方投入 | 134（= **对手**要补的钱） | **174**（Hero 真正新增） |
| 对手弃牌我赢 | 53 | **93** |
| 对手价格 | 0.417445 | **0.334165**（= 134/401） |
| P(弃) / P(跟) / P(再加注) | 0.1159 / 0.8841 / 0.0000 | **0.0998 / 0.9002 / 0.0000** |
| EqVsRaiseCallRange | 0.376606 | **0.387784** |
| **RAISE EV** | **−5.447466** | **−7.375830** |
| CALL EV | +19.697943 | +19.697943（未变，逐位一致） |
| **最终动作** | CALL 40 | **CALL 40**（差距 27.07 > 容差带 ⇒ 清晰结论） |

### HAND B · 99 暗三条河牌（同节点，Hero 9♠9♥）

| 项 | 修复前 | 修复后 |
|---|---|---|
| P(弃) / P(跟) / P(再加注) | 0.1024 / 0.8976 / 0.0000 | **0.0824 / 0.9176 / 0.0000** |
| EqVsRaiseCallRange | 0.884554 | **0.887071** |
| **RAISE EV** | **+140.011825** | **+174.402566** |
| CALL EV | +79.218472 | +79.218472（未变） |
| **最终动作** | RAISE 174 | **RAISE 174**（差距 95.18 > 容差带） |

### HAND C · F-01 翻牌 KK（Hero CO K♦K♣，K♥7♣2♦，BB 下注 6BB）

| 项 | 修复前 | 修复后 |
|---|---|---|
| P(弃) / P(跟) / P(再加注) | 0.9580 / 0.0244 / 0.0176 | **0.9424 / 0.0364 / 0.0212** |
| EqVsRaiseCallRange | 0.965392 | **0.941650** |
| **RAISE EV** | **+647.191821** | **+1226.726791** |
| CALL EV | +1205.291667 | +1205.291667（未变） |
| **最终动作** | CALL | **RAISE**（⚠️ **边缘决策**：差距 21.44 **落在模型容差带内**） |

⚠️ **必须说清楚的三件事**（不得夸大）：

1. **F-01 的动作确实从 CALL 变成了 RAISE**，但差距（21.44 筹码）**小于**决策层自己的跨动作容差带
   （`5% × winnable`）⇒ 这是**边缘决策**，不是「加注明显更好」。
   我**没有**为了恢复旧动作调整任何系数：变化完全来自口径修正。
2. **上一轮审计预测的 +1225.04 不是修复后的值**：那是在**沿用旧概率**的前提下算的。
   修好价格门槛后概率本身也变了（P(跟) 0.0244 → 0.0364）⇒ 真实值是 **+1226.73**。
3. **TEST 4**（第四节点，非本次要求）：RAISE EV 3336.666816 → **2166.233954**，
   与上一轮审计用**同一批概率**独立预测的 2166.233954 **六位小数一致** ⇒ 修复与预测自洽；动作仍为 CALL。
   **第二形态**（Hero 先下注后被加注）：RAISE 0.7584 → **34.9624**，仍低于 CALL 40.84 ⇒ CALL。

---

## C. Cashflow Audit（逐分支 + 独立复算）

| 分支 | 资金流 | 独立复算（不复制产品实现） | 结果 |
|---|---|---|---|
| **Villain 弃牌** | 我赢下决策时**完整底池** `currentPot`（含他这一注） | M1：`P(弃)=1 ⇒ EV = currentPot = 93` | ✔ |
| **Villain 跟注** | 终池 = `currentPot + 我方留在池中 + villainAdd`；我按**自己新增**的筹码计费 | M2：`P(跟)=1, Eq=0.5 ⇒ 0.5×401 − 174 = 26.5` | ✔ |
| **Villain 再加注（我弃牌）** | 我损失本次**全部**投入 `heroContestedAdd`（不是「相对跟注的增量」） | M3：`P(再加注)=1 ⇒ EV = −174`（并断言 ≠ −134） | ✔ |
| **Hero 全下** | `P(再加注) ≡ 0`；终池 = 93 + 174 + 134 = 401 | M4：全下节点 `rr = 0` 且 EV 退化为两项之和 | ✔ |
| **对手筹码不足** | `villainAdd` 按他实际能投封顶；我方超额**退回**、不计入投入 | P0-7：`villainAdd = min(raiseTo − 他那注, 剩余 14) = 14`，`退回 = heroAdd − 留在池中` | ✔ |
| **Hero 本街已投入** | `heroAdd = raiseTo − 我方本街已投`（**不重复扣** callCost） | P0-5：本街已投 10、需补 30 ⇒ `heroAdd = raiseTo − 10`，`villainAdd = raiseTo − 他那注` | ✔ |
| **多人底池** | U1 只按单挑建模 ⇒ **显式拦截**，不产出加注 EV | P0-6：2 个活跃对手 ⇒ 无加注事实 + 明确警告 + 全部金额列入「未评估」 | ✔ |
| **口径逐位核对** | — | 5 个节点：产品 RAISE EV 与「同一套口径」的独立复算**逐位一致**（差 0.000000000000） | ✔ |
| **CALL 参照系** | `EqVsBetRange × (pot + callCost) − callCost` | 4 个节点逐位一致 ⇒ 加注 EV 对齐的就是引擎自己的跟注口径 | ✔ |

安全门（第十阶段）也已落地并锁定：事实包必须带 `cashflowContract = NODE_INCREMENTAL_CHIPS_V2`，
且四个资金量有限自洽；尺寸对不上时输出 `RAISE_EV_SIZE_MISMATCH` 而不是静默关闭。
**没有**退回到「无 EV 的启发式加注」——FOLD/CALL 路径逐位未变（四个节点 CALL EV 全部一致）。

---

## D. Pot Odds Audit

| 加注至 | 他要补 | 跟注后底池 | 旧价格 | **新价格** | 说明 |
|---|---|---|---|---|---|
| 80 | 40 | 213 | 0.4174（对 174 那个尺寸） | **0.1878** | 使用者给定的表；三行全部逐位对上 |
| 120 | 80 | 293 | — | **0.2730** | 同上 |
| 174 | 134 | 401 | 0.417445 | **0.334165** | 生产节点实际使用的尺寸 |

* 旧价格 = `increment / (potBeforeBet + 2×increment)`：分母漏掉对手已经投入的那一笔，
  **系统性抬高门槛 7.7–9.3 个百分点**（AK +8.33pp、F-01 +9.33pp、TEST 4 +7.72pp、第二形态 +11.84pp）。
* 修复后：`price = villainAdd / finalPot`，四个节点与手算逐位一致。
* **响应概率与范围权益全部重算**（没有沿用旧价格下的概率）：
  例如 HAND A `P(跟) 0.8841 → 0.9002`、`EqVsRaiseCallRange 0.376606 → 0.387784`；
  HAND C `P(跟) 0.0244 → 0.0364`、`EqVsRaiseCallRange 0.965392 → 0.941650`。
* 副作用（真实存在，不隐瞒）：`ratioToPot` 也从「对手增量/扣掉他这一注的底池」改为
  「我方新增/当前底池」。它只影响**诈唬再加注**的尺寸条件（AIR/WEAK_PAIR），
  该条件与阈值（0.8）未动；本批节点上 P(再加注) 的变化主要来自门槛下移。

---

## E. Regression

| 节点 | 动作变化 | 直接原因 |
|---|---|---|
| HAND A · AK 河牌 | CALL → CALL（不变） | RAISE EV −5.45 → −7.38，仍低于 CALL |
| HAND B · 99 暗三条 | RAISE → RAISE（不变） | RAISE EV 140.01 → 174.40，仍高于 CALL |
| **HAND C · F-01** | **CALL → RAISE** | RAISE EV 647.19 → **1226.73** 反超 CALL 1205.29（差距 21.44 < 容差带 92.5 ⇒ **边缘**） |
| TEST 4 · AA 转牌 | CALL → CALL（不变） | RAISE EV 3336.67 → 2166.23，差距扩大 |
| 第二形态 · CO AA | CALL → CALL（不变） | RAISE EV 0.76 → 34.96，仍低于 CALL 40.84 |
| 三人底池（HAND E） | — | 新增**显式拦截**：不再产出单挑口径的加注 EV |

**回归保护核对（RIVER BET RANGE V2 / PROFILE V3 / RAISE DECISION V2 / TEST 07–12 / 翻前 3bet·4bet）**：
全仓 **1,938 项测试通过、0 失败**（除产物清单与状态文档计数两处登记项，已同步）。
`EqVsBetRange`、下注范围、`math.callEV` 在四个节点上与修复前**逐位一致**；
翻前加注（`ISO_RAISE_MODEL_EV` / `STRATEGIC_RAISE_FOR_VALUE`）路径**未触碰**。

---

## F. Murphy Findings（只列**真正复现**的）

| # | 检查项 | 结果 |
|---|---|---|
| 1 | 只修 EV、忘了同步赔率 | **本轮就发生过**：先修 EV 时 P0-3 仍红（0.4174），同步改 `raiseResponse.ts` 后才绿 ⇒ 该项已按第七阶段一起改 |
| 2 | 改赔率后继续用旧 Raise-Call Range | **未发生**：`built.callContinueEntries` 由新价格重新分类后再算权益（数字已变，见 §D） |
| 3 | Hero 本街已投入时重复扣 callCost | **已修**：P0-5 锁死 `heroAdd = raiseTo − 本街已投`；修复前该节点**根本没有事实包**（D2 静默关闭） |
| 4 | 对手弃牌时错误计算 Hero 自己新投入 | **已修**：弃牌分支只取 `currentPot`，不含我方任何新投入（M1 锁死） |
| 5 | 再加注后弃牌只扣「相对 CALL 的增量」 | **已修**：改为扣 `heroContestedAdd`（M3 断言 = −174 且 ≠ −134） |
| 6 | 全下节点仍生成非法再加注分支 | **未发生**：`heroIsAllIn ⇒ rr ≡ 0`（M4 + P0-8），4 个全下节点的 P(再加注) 均为 0 |
| 7 | 加注尺寸与响应模型金额不同 | **已修**（D2）：两层现在共用同一网格与同一目标式；不一致时输出 `RAISE_EV_SIZE_MISMATCH` |
| 8 | 缓存继续用旧模型版本的范围/EV | **已加门槛**：`cashflowContract` 不符即拒绝参与比较（含显式理由码） |
| 9 | FOLD/CALL 路径被意外改变 | **未发生**：4 个节点 CALL EV 逐位一致；全仓测试 0 失败 |
| 10 | **测试复刻产品错误公式** | **复现，且是本轮最值得记的一条**：`test/raiseResponseU1.test.ts` 的 U1-7 直接复刻了 `finalPot = potPre + 2*increment`，U1-2 的价格表把错分母锁成了预期值 ⇒ 上一轮 1,923 项全绿却账目全错。已记录原断言为何无效并替换为**独立现金流不变量**（`test/raiseEvCashflowP0.test.ts`，预期值全部手算） |
| 11 | （额外复现）我自己的第一版修复写错 | **复现**：改用 `previewCommit(state, hero, heroAdd)` 取终池时，因**对手尚未跟注**而把我方未匹配部分整块算成退回 ⇒ `heroContestedAdd < 0`、事实包为 null。已改为「双方都投入」的直接口径，并把该坑写进代码注释 |
| 12 | （额外复现）多人节点静默按单挑算 | **复现**（修复前）：3 人节点照样产出单挑口径的加注 EV。现已拦截并给警告（P0-6） |

---

## G. Full Verification

```text
typecheck:  0 errors（tsc --noEmit，exit 0）
tests:      1938
pass:       1938
fail:       0
suites:     137
manifest:   158/158 一致（exit 0；本轮补登记 raiseResponse.ts）
verify:     exit 0
```

说明：`npm run verify` = `typecheck && manifest:check && test`；本机 `npm.ps1` 被执行策略阻止
（既有环境限制），故按 package.json 定义**逐条直接运行**等价命令。
**未删除、未跳过、未放宽任何断言**；唯一被替换的断言（U1-7 / U1-2 的旧价格表）已在 §F-10 说明原断言
为何无效，并替换为更强的独立不变量。

---

## H. Final Verdict

```text
U1_RAISE_EV_P0_FIX — PASS_WITH_WARNINGS

CASHFLOW_FIXED              = YES   （heroAdd/villainAdd/finalPot/三分支 EV 全部按双方实际投入重算，
                                      5 节点与独立复算逐位一致，含短筹码封顶与本街已投）
POT_ODDS_FIXED              = YES   （price = villainAdd/finalPot；使用者给定的 80/120/174 表逐位对上；
                                      响应概率与加注继续范围已重算，未沿用旧值）
STREET_COMMITTED_FIXED      = YES   （committedThisStreet 读双方真实本街投入；两层尺寸目标统一；
                                      不再静默关闭 U1，改为显式理由码）
RAISE_EV_RECOMPUTED         = YES   （AK −7.375830｜99 +174.402566｜F-01 +1226.726791｜TEST 4 +2166.233954）
CALL_FOLD_REGRESSION        = NONE  （四节点 CALL EV 逐位一致；全仓 1,938 项 0 失败）
RIVER_BET_RANGE_V2_PRESERVED = YES  （EqVsBetRange 与下注范围逐位未变）
PROFILE_V3_PRESERVED        = YES   （画像链路未触碰；V3 相关测试全绿）
SAFE_TO_CONTINUE_HAND_TESTING = YES（有条件）
```

### 为什么是 PASS_WITH_WARNINGS（不得读成 PASS）

1. **F-01 的动作变了**（CALL → RAISE），且差距 **21.44 筹码落在容差带内** ⇒ 必须按**边缘决策**使用，
   不得当作「加注明显更优」。这需要人工确认是否符合扑克策略直觉。
2. **响应系数仍未校准**（U1 残余 ①）、**再加注分支仍取下界**（残余 ②）——
   本轮只修账目，没有也不允许标定任何系数。
3. **U9 锯齿仍在，且幅度变大**（口径修正后最大 +21.7pp）——属模型局限，需人工裁决是否改。
4. **D1 仍未修**：跨动作容差带 `5% × winnable` 仍是 CALL 口径的量，用在加注 EV 上
   （单位现已一致，但「显著性门槛」的基准仍是跟注的可争夺量）。
5. **D5 部分未修**：决策日志仍无「加注响应模型版本」（修复前后日志不可区分）。
6. 本轮只跑了 5 个深度节点 + 尺寸扫描；**未做全节点扫描**（哪些节点的动作因口径修正而改变，仍未知）。
   F-01 的变化说明这类节点**确实存在**。

**SAFE_TO_CONTINUE_HAND_TESTING = YES 的条件**：可用于真人牌局复盘，
但必须同时满足 ① 把 F-01 类「差距在容差带内」的加注结论当作参考而非结论；
② 不把 RAISE EV 的绝对值当校准过的数字；③ 多人底池（本版本已拦截）与翻前加注仍按原路径理解。
