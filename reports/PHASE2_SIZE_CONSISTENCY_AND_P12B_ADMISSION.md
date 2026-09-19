# 第二阶段报告：决策金额一致性与 P1-2b 准入审查

> 只读调查 + **任务一的最小修复**（经批准）。**未**开发 P1-2b、未新增 Solver、未调整画像参数、未改 UI。
> 证据：`reports/evidence/phase2-size-and-uncalled.txt`、`phase2-uncalled-chips.txt`、`phase2-full-suite.txt`
> 脚本：`scripts/phase2-size-and-uncalled-probe.ts`、`scripts/phase2-uncalled-chips.ts`

---

## 任务一：BET 13 / 14 尺寸一致性 → **确认错配，已最小修复**

### 完整链路（BB 20BB 节点，同一决策节点 ✅）

| 步骤 | 值 | 来源 |
|---|---|---|
| ① 决策点 | 底池 53｜Hero 剩余 174｜对手剩余 **14**｜minBet 2｜allInTo 174 | `deriveLegalActions` |
| ② 理论尺寸 | 1/3 = 17.67｜2/3 = 35.33｜1 池 = 53.00 | `BET_SIZE_SPECS` |
| ③ 合法尺寸 | 三者都被 `maxBet = min(174, 14) = 14` **封顶到 14**，去重后**只剩 1 个** | `legalizeBetSizes` |
| ④ 响应模型实际评估 | **14**（`betDecision.sizes = [{BET_SMALL, betAmount 14, wasCapped true}]`） | `buildResponseModel` |
| ⑤ 决策层候选网格 | **[2, 13, 18, 27, 35, 40, 53, 174]**（另一套百分比：0.25/1/3/0.5/2/3/0.75/1 × 池） | `buildSizeGrid(legal, pot, 'BET')` |
| ⑥ 最终推荐（修复前） | **13** —— 目标 14 在网格中不存在 ⇒ `pickClosestAggressive` 取最近（\|14−13\|=1 < \|18−14\|=4） | `decisionEngine` 2481-2499 |

⇒ **确实错配**：界面展示的响应概率与 EV 属于 **14**，而用户被建议下 **13**。
两者属于**同一决策节点**（同一 `analyzeDiagnostics`、同一底池/街道），不存在语义不同的可能。

### 修复（先写失败测试 → 再改代码）
- 新增 `test/betSizeConsistency.test.ts`（T1–T4）：**修复前 4 项全红**（T1 断言「推荐 14 = 被评估 14」实测 13）。
- 修复方式：`decisionEngine` 在算完 `postflopAdvice` 后，**把「被评估的那个合法金额」补进候选**
  （`candidatesForDecision`：仅在缺失时补、只补一个、与其它下注候选一样 `ev = null`），
  并把该列表同时用于 `pickCandidate` 与 `diagnostics.candidates`。
  ⇒ 尺寸规则自然选中它；**不删除任何既有候选、不注入任何 EV、不改任何策略参数**。
- 修复后：**推荐 14 = 被评估 14**（候选变为 `2, 13, 18, 27, 35, 40, 53, 174, 14`），T1–T4 全绿。

### 一次**被自己回退**的尝试（记录在案）
我先在 `legalizeBetSizes` 里给 `legalAmount` 加 `Math.round`（想让「被评估 = 可执行 = 整筹码」），
结果打破既有契约 `P0-1 / P0-1b`（「底池 29 ⇒ 三个尺寸必须是 **9.667 / 19.333 / 29**」——
合法尺寸必须严格按底池比例、可含小数）。**按「不得放宽既有断言」的纪律，我回退了取整**，
改为在推荐侧对齐。⇒ 结论：**一致性由「推荐金额 = 被评估金额」保证，而不是改单位**；
`betDecisionEngine.test.ts` 25 项全绿。

---

## 任务二：短筹码未匹配金额 → **处理正确**

P0-7 节点（对手剩余 14，跟平最多补 14），**五个不同名义加注额**：

| 名义加注至 | 我方新增 | 他补 | 留在池中 | **退回** | 终池 | P(弃) | P(跟) | P(再加) | EqVsRaiseCall | RAISE EV |
|---|---|---|---|---|---|---|---|---|---|---|
| 120 | 120 | 14 | 34 | 86 | 121 | 0.052967 | 0.947033 | 0 | 0.537986 | 33.315809 |
| 130 | 130 | 14 | 34 | 96 | 121 | 0.052967 | 0.947033 | 0 | 0.537986 | 33.315809 |
| 150 | 150 | 14 | 34 | 116 | 121 | 0.052967 | 0.947033 | 0 | 0.537986 | 33.315809 |
| 173 | 173 | 14 | 34 | 139 | 121 | 0.052967 | 0.947033 | 0 | 0.537986 | 33.315809 |
| 174 | 174 | 14 | 34 | 140 | 121 | 0.052967 | 0.947033 | 0 | 0.537986 | 33.315809 |

- **概率、条件权益、EV 逐位相同** ⇒ 名义金额只影响**退回**多少，不影响任何决策量。
- 退回筹码**没有被计入成本或收益**：弃牌分支 = `+currentPot`（73，含他这一注，退回 0）；
  跟注分支 = `EqVsRaiseCall × 终池 − **留在池中**的投入`（34，而不是名义新增）。
- 资金守恒逐行核对：`终池 = 底池 + 留在池中 + 他补`；`退回 = 名义新增 − 留在池中`。

---

## 任务三：P1-2b 准入审查（**只读，未开发**）

### 已具备、可直接复用（均已验证 + 有测试）
| 能力 | 现有实现 |
|---|---|
| 任意节点的合法行动 | `deriveLegalActions(state, player)`、`canRaise`、`minRaiseTo`、`minBetAmount`（含「不足最小加注的全下加注合法」这条，第一阶段已实测） |
| 后续节点状态构造 | `applyAction(state, command)`（本阶段两次用它做引擎级重放） |
| 有效筹码 / 退回 / 分层底池 | `committedThisStreet`、`requiredCallAmount`、`computePot`、`previewCommit`、`computeLayeredPot`（`contested` / `returned`） |
| 节点增量 EV 口径 | `raiseEVOf`（弃牌 ≡ 0；成本 = 我方**留在池中**的投入）+ CALL EV 的同口径恒等式（已被 P0 测试锁定） |
| 条件权益计算 | `rangeEquityOfMany`（`computeEquity` + 固定种子偏移 `equitySeed + 1601`，小范围自动升级为 EXACT 枚举 ⇒ 无抽样误差） |
| 逐组合的再加注权重 | `buildRaiseResponse` **内部已经算出**每个组合的 `reRaiseShare`（只是没导出） |

### 缺失（**不得**用启发式冒充）
1. **再加注桶的条件范围**：`RaiseResponseResult` 只导出 `callContinueEntries`，**没有** `reRaiseEntries`
   ⇒ `EqVsReraise`（Hero 对他再加注范围的权益）目前**取不到**。需要改动：按既有循环把再加注桶归一化导出。
2. **再加注的**尺寸**未建模**：模型给的是概率，不是金额。若要建后续节点，必须新增一条确定性尺寸规则
   （例如 `minReRaiseTo = 2R − B`，买不起则取他的全下额）——这属于**新的结构假设**，必须显式登记。
3. **Hero 的 4-bet 分支没有模型**：若对手的再加注**不是全下**，Hero 还有再加注选项，
   而「对手面对 Hero 4-bet 的继续范围 / 权益 / EV」全部不存在 ⇒ 该分支只能**如实标注为未建模**，
   不能用启发式顶上（河牌被全下时该分支不存在，无需建模）。
4. **对手跟 Hero 4-bet 的条件范围**：同上，缺失。

### 最小实现方案（供批准，本轮不做）
```text
步骤 1  导出再加注桶：RaiseResponseResult 增加 reRaiseEntries（归一化）+ 记录其可达组合数
步骤 2  确定性尺寸规则：reRaiseTo = min(2R − B, 对手全下额)；写进 model 事实包并披露
步骤 3  后续节点资金：用 applyAction 构造「Hero 加注 → 他再加注」的真实状态，
        取 previewCommit/computeLayeredPot 得到终池′、Hero 需再投、退回
步骤 4  分支值：reraiseBranchEV = max( −heroContestedAdd , EqVsReraise × 终池′ − Hero 需再投 )
        （EqVsReraise 不可得 ⇒ 保持现有下界 + 明确披露，绝不编造）
步骤 5  Hero 的 4-bet：仅当对手再加注非全下时存在 ⇒ 标注 UNSUPPORTED，不进入 max()
```
**测试范围**：① 分支值不再恒等于 `−heroAdd`；② `EqVsReraise` 不可得时仍为下界且披露；③ 全下再加注 ⇒ 只剩 fold/call；
④ 与 CALL EV 同口径复算逐位一致；⑤ 资金守恒（终池′ = 底池 + 双方投入 − 退回）。

---

## 任务四：回归与验收

- 第一阶段两条合法性约束**仍然成立**：`test/raiseReraiseBranchLegality.test.ts` 13 项全绿
  （含 C「对手跟注即全下 ⇒ rr = 0」、D「短筹码全下加注的合法分支必须保留」、G 边界）。
- P0-7 的资金 / 退回 / 条件权益 / EV 测试**全部保留且通过**（`raiseEvCashflowP0.test.ts` 15 项）。
- 本阶段新增 4 项金额一致性测试；既有比例契约 `P0-1/P0-1b` **未被改动且通过**。
- 全仓：**tests 1955｜pass 1955｜fail 0｜suites 137｜typecheck 0 errors｜manifest 158/158｜exit 0**。
- 未清理、未覆盖、未回滚任何未提交工作；未 `git add/commit/stash/clean`。

---

## 最终裁决

```text
BET_SIZE_CONSISTENCY        = FIXED（确认错配：评估 14 / 推荐 13 → 现在两者都是 14；
                                      新增 T1–T4 失败测试先行，修复仅补一个候选，未删候选、未注入 EV）
UNCALLED_CHIPS_HANDLING     = CORRECT（5 个名义金额 ⇒ 概率/权益/EV 逐位相同；退回不计成本也不计收益；
                                      资金守恒逐行核对通过）
P1_2B_EXISTING_CAPABILITIES = 合法行动、状态构造、有效筹码/退回/分层底池、节点增量 EV 口径、
                              条件权益计算、逐组合再加注权重（模型内部已有）
P1_2B_MISSING_CAPABILITIES  = ① 再加注桶的条件范围未导出（EqVsReraise 取不到）
                              ② 再加注**尺寸**未建模（需新增确定性规则）
                              ③ Hero 的 4-bet 分支无模型（对手再加注非全下时才需要）
                              ④ 对手跟 Hero 4-bet 的条件范围缺失
SAFE_TO_IMPLEMENT_P1_2B     = YES_WITH_CONDITIONS
                              条件：(a) 先只导出再加注桶 + 尺寸规则，并用现有工具算 EqVsReraise；
                                    (b) 4-bet 分支一律标 UNSUPPORTED 并披露，不得用启发式冒充；
                                    (c) EqVsReraise 不可得时保留下界 + 明确披露；
                                    (d) 必须新增「分支值不再恒为 −heroAdd」与「资金守恒」测试
SAFE_TO_CONTINUE_HAND_TESTING = YES（有条件）
                              条件：① 下注/加注的**推荐金额**现在与**被评估金额**一致，可放心按建议执行；
                                    ② 再加注分支仍是**宽松下界**（P1-2b 未做）⇒ 面对「他会再加注」的
                                       场景不要依赖 RAISE EV 的绝对值；
                                    ③ 画像统计仍不参与决策（P1-1）、单尺寸仍是启发式（P2-1）
```

**未发现需要「停止并猜测」的问题**：三个任务的全部结论都有代码位置或实测数字支撑；
唯一无法确认的是 P1-2b 完成后 `EqVsReraise` 的量级（因为范围尚未导出），已如实列为缺失能力。

**第二阶段完成，停止并等待下一步授权。**
