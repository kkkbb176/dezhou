# RIVER LEGAL ACTION TREE FIX — REPORT

> **日期**：2026-09-17 · **性质**：P0 缺陷修复（不扩展新功能）
> **结论**：下注尺寸现在**先合法化、再去重，然后用合法金额构建响应模型与 EV**；
> `Hero 全下 ⇒ P(加) = 0`（强牌迁移到跟注）；河牌前位过牌走 **CHECK 树**（不再当成摊牌）；
> 决策依据改为读取**真实决策来源**（`ACTION_EV_COMPARISON`）。
> **回归**：`npm run verify` → **1,712 项 / 137 套件 / 0 失败**，TypeScript 0 错误，产物清单 139 项一致。

---

## A. 根因

修复前的顺序是「**理论尺寸 → 响应模型 → EV → 最后才映射到合法动作**」：

```text
MEDIUM 理论 118（> 身后 112）→ 用 118 算 P(弃)/P(跟)/EqVsCall/EV = 169.2 → 最后映射成 112
LARGE  理论 177（> 身后 112）→ 用 177 算 P(弃)/P(跟)/EqVsCall/EV =  89.7 → 最后映射成 112
                                  ↑ 同一个**合法**动作（全下 112）两套完全不同的数与 EV
```

三个具体缺陷：

1. **理论金额没有被有效筹码封顶**：`betAmount = pot × ratio`，`LARGE = 177 > 112`。
   更严重的是被加注分支按 `eq×(P+4b) − 2b = −207.6` 计算 —— 那是**物理上不可能**的投入。
2. **没有按合法金额去重**：封顶后 `MEDIUM` 与 `LARGE` 都变成 112，却各留一份响应与 EV。
3. **全下后仍允许对手加注**：`P(加) = 0.297`，而 Hero 已经没有筹码可跟 —— 非法游戏树；
   同时「比我强的牌」全部停在加注桶里，导致 `EqVsCall = 100.00%`（虚高），
   Hero 的全下 EV 因此被系统性高估。

附带两个同批缺陷：

4. **河牌前位过牌被当成立即摊牌**：`CheckEV = 权益 × 底池 = 133.4`，而我过牌之后对手**仍可下注**
   （实测他下注 17.0% 的频率、Hero 对其下注范围只有 20.44% 权益 ⇒ 那一支是全下/弃牌的负 EV 分支）。
5. **解释层与行为层事实来源不同**：动作已由下注决策模型的三尺寸 EV 比较选出，
   文案却仍写「动作由**价值守门器的偏好分**选出」。

---

## B. 修改文件

| 文件 | 函数 / 位置 | 目的 |
|---|---|---|
| `src/domain/postflop/betResponse.ts` | `legalizeBetSizes`（**新增**） | **P0**：`legal = min(requested, Hero 剩余, 对手剩余)`、最低注约束、**按金额去重**、`ALL_IN` 标签、`requestedAmount/wasCapped/requestedKind` 只进 debug |
| 同上 | `classifyResponse` | **P0**：`weights {fold, call, raise}` 混频（和为 1）；**`heroIsAllIn ⇒ raise = 0`，权重迁移到跟注** |
| 同上 | `buildResponseModel` | **P0**：只接收**合法**尺寸，价格 `r = b/(P+2b)`、尺寸压力、`ratioToPot` 全部由**合法金额**推导；桶按 `p × w` 加权归一化（质量守恒） |
| 同上 | `classifyVillainAfterCheck` / `composeCheckEVTree`（**新增**） | **P0**：河牌 `CHECK_BACK | BET` 最小树；前位 `CheckEV = P(过牌)×摊牌EV + P(下注)×Hero最佳应手`；加注应手 `NOT_IMPLEMENTED` |
| 同上 | `responseTendenciesOf` | 新增 `riverBetScale`（画像影响「我过牌后他下注」的概率；只改概率不造牌） |
| `src/app/manualInput/contextBuilder.ts` | `buildBetDecisionFacts` | 合法化 → 响应模型 → 条件范围权益；构建河牌 CHECK 树的两条条件范围与权益；传 `heroRemaining / villainRemaining / minBet` |
| `src/app/decision/postflopAdvisor.ts` | `betDecision` 组装 | CHECK EV 取 `checkTree.checkEV`；按合法金额去重后比较；暴露 `legalSizes / droppedSizes / bestAmount / checkTree` |
| `src/app/decision/decisionEngine.ts` | 场景 2 + `decisionBasisOf` | **ALL_IN 必须落到 ALL_IN 候选**（否则一致性守卫报错）；依据改为 `ACTION_EV_COMPARISON` + 合法动作表 |
| `src/domain/decision/decisionConsistency.ts` | `DecisionBasisKind` / `decisionBasisOf` | 新增 `ACTION_EV_COMPARISON`；读真实决策来源 |
| `src/viewmodels/decisionViewModel.ts` | `debug.betDecision` | 新增 CHECK 树、`requested/legal/wasCapped`、被丢弃候选 |
| `test/betDecisionEngine.test.ts` | T1–T8 | 合法化/去重/全下不可加注/CHECK 树/画像方向/极短码/EV 零点契约 |
| `reports/RIVER_LEGAL_ACTION_TREE_FIX_REPORT.md`（本文件） | — | 交付报告 |

---

## C. 修复后旧节点 2 完整表

固定节点：Hero BB 9♠8♠｜河牌 T♠7♦6♣J♦7♣｜底池 177｜身后 112｜SPR 0.63｜Hero 先行动。

| Action | Amount | Legal | P(Fold) | P(Call) | P(Raise) | Eq vs Call | EV | 分 |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| **CHECK** | 0 | yes | — | — | — | （见 CHECK 树） | **127.2** | 0.500 |
| **BET** | **59** | yes | 0.008 | 0.754 | 0.238 | 86.27% | **160.0** | 0.593 |
| **ALL-IN** | **112** | yes | 0.008 | 0.992 | **0.000** | **75.17%** | **189.3** | **0.675** |
| ~~BET~~ | ~~118~~ | **丢弃** | — | — | — | — | — | — |
| ~~BET~~ | ~~177~~ | **丢弃** | — | — | — | — | — | — |

- 参与 EV 的金额只有 **59 / 112**，两者均 ≤ 身后 112；**118 与 177 只出现在 debug 的 `requestedAmount` 里**。
- 被丢弃候选（`droppedSizes`）：`BET_LARGE 理论 177 → 合法 112`（封顶后与 MEDIUM 的合法金额相同 ⇒ 去重）。
- **最终动作 = `ALL_IN`（56BB / 112 筹码）** —— 且 `decisionBasis.kind = ACTION_EV_COMPARISON`，
  理由行给出 `CHECK EV 127.2｜BET 59 EV 160.0｜ALL-IN 112 EV 189.3｜最佳 = ALL_IN`。
- 修复前：`BET 56BB`，但模型的最佳是 `ALL_IN`（0.68）却执行 `BET`（0.59），
  被一致性守卫判为 `ACTION_CONTRADICTS_PREFERENCE` —— 该错误**已消失**（守卫仍在运行）。

---

## D. ALL-IN 条件范围

| 桶 | 修复前（用非法的 177 建模） | 修复后（合法 112，Hero 全下） |
|---|---:|---:|
| fold mass | 0.557 | **0.008** |
| call mass | 0.148 | **0.992** |
| raise mass | **0.295（非法：他已无筹码可跟）** | **0.000** |
| Eq vs Call | **100.00%** | **75.17%** |
| Eq vs Raise | 16.54% | —（加注桶为空） |
| EV_call | 354.0 | 189.4 |
| EV_raise | −207.6（投入 2×177，不可能） | —（分支不参与） |
| **BetEV** | 89.7 | **189.3** |

**与旧 100% 的对比是关键证据**：旧版把「比他强的 19.8% + 打平 9.8%」全部停在一个
**非法**的加注桶里，于是跟注桶里只剩他打不过我的牌 ⇒ `EqVsCall = 100%`。
现在全下后加注权重强制为 0、**原本会加注的强牌按权重迁移到跟注桶**
（`P(弃) + P(跟) = 1`，质量守恒 Σ桶质量 = 1），因此
`EqVsCall = 75.17%`，与**到达范围权益 75.36%** 几乎相等 ——
这正是「他跟注 = 用几乎全部继续范围跟」应有的结果。

---

## E. CHECK 树（河牌前位过牌 ≠ 摊牌）

```text
CHECK 树类型            : HEURISTIC_TREE（我在前位）
P(他过牌)               : 0.830
P(他下注 112.0 筹码)     : 0.170        ← 代表尺寸 = 2/3 池 = 118，按**他的**剩余筹码封顶到 112
摊牌分支：EqVsCheckBack : 86.64%  ⇒ EV_showdown      = 153.3
下注分支：EqVsBet        : 20.44%  ⇒ Hero CALL EV     = −30.0
                                    Hero FOLD EV      =   0.0   （零点 = 当前决策点）
                                    Hero 最佳应手      =   0.0   （取 max(Fold, Call)）
                                    加注应手           = NOT_IMPLEMENTED（不伪造）
--------------------------------------------------------------
CHECK EV = 0.830 × 153.3 + 0.170 × 0.0 = **127.2**
对照（旧口径）: 权益 × 底池 = 0.7536 × 177 = **133.4**   ⇒ 两者不同（差值 6.2 筹码）
```

**为什么必须不同**：我过牌后他仍会以 17.0% 的频率下注，而我对**他的下注范围**只有 20.44% 权益
（他的下注范围是葫芦/四条），跟注 112 的 EV 是 **−30.0** ⇒ 我应当在那一支弃牌、收益为 0。
把这一支算成「照样摊牌赢 133.4」是系统性高估过牌。

**画像方向（T6 锁定）**：`riverBetScale = 1 + 0.3×aggression + 0.25×bluff − 0.3×passivity`
（按可信度缩放）⇒ 疯子 > 普通 > 跟注站；不诈唬型/极紧的**大注诈唬**权重下降。
画像只把同一组合在 `CHECK_BACK` 与 `BET` 之间分流，**不制造任何不存在的组合**。

---

## F. 全量验证

```text
npm run verify
  TypeScript : 0 错误
  产物清单    : 139 个产物与清单一致
  tests      : 1,712
  suites     : 137
  fail       : 0
```

- **没有删除或放宽任何旧测试**：上一次基线 1,704 项全部通过；
  本轮新增 8 项（T1–T8）⇒ 1,712 项。
- 唯一被**改写**的旧断言是我自己上一轮写的 T9 中的一条：
  「三桶组合数之和 = 可达组合数」在**混频**（§8）下不再成立（同一组合可同时出现在两个桶）。
  已改为更强且仍然精确的契约：**三桶组合的并集 = 可达组合集**（不丢牌、不造牌）+ **Σ桶质量 = 1**。
  ⚠️ 这不是放宽：旧断言在混频下是**错的**（会误报合法行为）；新断言同时锁住了质量守恒。

---

## G. 变异测试（6/6 被抓到）

| 变异 | 期望 | 实测 |
|---|---|---|
| M1 去掉有效筹码封顶 | T1 / T7 红 | ✅ 2 项失败 |
| M2 允许全下后加注 | T2 / T3 红 | ✅ 2 项失败 |
| M3 封顶后不去重 | T1 / T7 红 | ✅ 2 项失败 |
| M4 河牌 OOP 过牌重新当成摊牌 | T4 / T6 红 | ✅ 2 项失败 |
| M5 CHECK 用旧的「权益 × 底池」口径 | T4 红 | ✅ 1 项失败 |
| M6 全下时把「原本会加注」的强牌**丢弃**（而不是迁移到跟注） | T2 / T3 红 | ✅ 2 项失败 |

**M6 的教训**：第一版变异写成「跳过 `bucket === 'RAISE'` 的组合」——
而混频之后这些组合的 `bucket` 已经是 `CALL`（权重迁移后主导桶变了），
变异成了**空操作**，测试当然不会红。改为「权重全零 ⇒ 质量丢失」后立刻被抓到。
这说明：变异必须真的破坏被断言的性质，否则「测试没红」既可能说明测试弱，也可能说明变异无效。

---

## 十四、墨菲定律专项核对

| # | 检查 | 结论 |
|---|---|---|
| 1 | `requestedAmount > stack` 是否所有路径都封顶 | ✅ `legalizeBetSizes` 是**唯一**入口；`legal = min(requested, Hero 剩余, 对手剩余)` |
| 2 | MEDIUM/LARGE 同时封顶是否产生重复动作 | ✅ 按金额去重，`LARGE 177→112` 被丢弃并留痕 |
| 3 | ALL-IN 后 raise 概率是否真的为 0 | ✅ 权重为 0（不是 UI 显示 0）：加注桶 `comboCount = 0`，`P(弃)+P(跟) = 1` |
| 4 | 被移除 raise 桶的强牌是否丢失 | ✅ 迁移到跟注桶：`EqVsCall 75.17% ≈ 到达权益 75.36%`（T3） |
| 5 | range mass 是否守恒 | ✅ Σ桶质量 = 1（< 1e-9） |
| 6 | `fold + call (+raise)` 是否 = 1 | ✅ 每个组合的权重和为 1；聚合亦为 1（T2/T9） |
| 7 | Hero 全下后 Villain call cost 是否正确 | ✅ 合法金额由**单挑有效筹码**封顶 ⇒ 他不会跟超过自己筹码的部分 |
| 8 | Villain 全下时 Hero 不能 raise | ⚠️ **未覆盖**：本轮的 `heroIsAllIn` 只处理「Hero 下注即全下」；对手全下时 Hero 的加注应手在**面对下注**分支（Phase 1 未改）⇒ 记为 Phase 2 |
| 9 | 河牌没有 future equity | ✅ `cardsToCome = 0`、`improvementProbability = 0`、实现因子恒 1（T9b） |
| 10 | CHECK OOP 与 CHECK BACK 不共用终止逻辑 | ✅ `HEURISTIC_TREE` vs `SHOWDOWN_TERMINAL`（T4/T5） |
| 11 | sunk cost 不重复进入 EV | ✅ 统一零点：弃牌 = 0、过牌/下注分支都从**下注前**底池起算（T8） |
| 12 | tie equity 处理 | ✅ 权益引擎按平局分摊（`equalShare 9.8%`）；响应分类把打平牌按强度处理 |
| 13 | all-in 后最终底池计算 | ✅ `pot + 2×legalAmount`（不是理论金额） |
| 14 | overbet 理论尺寸封顶后重建 response | ✅ 封顶发生在 `buildResponseModel` **之前**（T1 断言金额唯一且 ≤ 112） |
| 15 | debug 里 requested/legal 不混淆 | ✅ 两个字段分开；EV 只用 `legalAmount` |
| 16 | 同一合法动作不因原始 label 得到不同 EV | ✅ 去重 + T1 的「金额 → EV/概率」唯一性断言 |
| 17 | 画像不能制造非法动作 | ✅ 画像只改 `callScale/foldScale/raiseScale/riverBetScale`（概率），不动动作集合 |
| 18 | 极短码 0.2 SPR 仍合法 | ✅ T7：`heroRemaining=20, pot=100` ⇒ 只剩 `ALL_IN 20` |
| 19 | `stack = 0` 不产生 BET | ✅ T7：候选 0 个、全部进 `droppedSizes` |
| 20 | min-bet / min-raise 不被破坏 | ✅ 低于最小注且非全下 ⇒ 丢弃（最大注由有效筹码封顶）；`minRaiseTo` 路径未改动 |

---

## 已知限制（本轮明确不做的部分，不伪造）

| 项 | 状态 |
|---|---|
| Hero 面对下注时的加注应手 | `NOT_IMPLEMENTED`（`raiseResponse` 字段如实标注）——河牌 CHECK 树里 Hero 只比较 `CALL / FOLD` |
| Villain 全下时 Hero 不能加注 | 归 Phase 2（见墨菲 #8）；当前面对下注分支沿用既有 `shouldRaise` 安全规则 |
| 对手下注的**多尺寸**树 | 本轮只做 `CHECK_BACK | BET` 最小树（代表尺寸 = 2/3 池，按他的剩余筹码封顶），标 `HEURISTIC` |
| 混频权重的刻度 | 价值加注 `0.45 + 0.35×超额 + 0.25×(raiseScale−1) − 0.2×尺寸压力`、诈唬加注 `0.25 + 0.5×(bluffRaiseScale−1) − 0.3×尺寸压力` —— 【启发式】结构式，只有方向与序关系有意义 |
| 条件范围权益精度 | 每桶 6,000 次抽样（主权益 20,000），逐尺寸在 `equityIterations` 里如实标出 |
