# RIVER RAISE DECISION —— 墨菲定律定向审计报告

**轮次性质**：**只读审计**。本轮**未修改任何产品代码**（无阈值调整、无权重调整、无新功能）。
证据脚本：`scripts/rrda-*.ts`；原始输出：`reports/evidence/rrda-01-freeze.txt`、`rrda-02-trace.txt`、`rrda-03-sections345.txt`、`rrda-04-regression.txt`。

# 最终裁决：`RIVER_RAISE_DECISION_AUDIT — FAIL`

**理由（一句话）**：本节点推荐的 **RAISE 174 没有任何筹码 EV 依据**，它是由一条**被河牌明文废止的**启发式通道放行的；而引擎里唯一写着「一对牌不许打光」的保护**没有触发**；用引擎自己的响应分类器按真实加注赔率复算，**RAISE EV 为负**（−16.4 / −5.2 / −41.5，取决于对手响应前提），而 CALL EV = **+19.70**。

---

## 一、冻结当前 AK 节点

| 项 | 值 |
|---|---|
| 最终动作 | **RAISE**（sizeChips = **174**，sizeBB = 87） |
| 底池（含他的下注）/ 跟注额 / 可争夺量 | 93 / 40 / 133 |
| Hero 剩余 / Villain 剩余 | **174** / 134（他本街已投入 40） |
| 有效筹码 `effectiveStack` | 134 |
| SPR | 1.441 |
| requiredEquity | 0.300752 |
| 置信度 / classification | 0.3 / MARGINAL |
| EqVsArrivalRange | 0.755247 |
| EqVsBetRange | 0.448857 |
| CALL EV / FOLD EV | **+19.697943** / 0 |
| 决策来源 | `STRATEGIC_HEURISTIC`（"战略启发式（无任何量化证据）"），evidenceScope = `CALL_CLEAR_CALL_OVER_FOLD_OVERRIDDEN` |

### 加注金额的语义 / 合法性（逐项核对）

```text
合法加注区间 = [minRaiseToAmount 80, allInToAmount 174]（raise-to 口径）
「RAISE 174」= raise-to（本街总额目标），增量 = 174 − 40 = 134
Hero 本街已投入 0、剩余 174 ⇒ 加注后剩余 = 0 ⇒ **这一手就是全下**
Villain 需要再投入 134、身后恰好 134 ⇒ 跟得起（没有「跟不起的溢出部分」）
174 = allInToAmount ⇒ 与候选表里的 ALL_IN 174 **是同一个动作**（两条并列出现在候选表）
合法 ✔（落在 [80,174] 内，且 ≥ minRaiseTo）
```

**语义缺陷**：同一个动作在候选表里出现两次（`RAISE`「全下」与 `ALL_IN`），
而只有 `RAISE` 那一条带证据行、能走启发式覆盖；`ALL_IN` 在 `actionEvidence` 里**没有条目**，
因此永远不可能被证据裁决选中。引擎最终返回的是 `RAISE` 标签。

「价值加注」的尺寸公式 `desiredTo = pot + 2×callCost = 93 + 80 = 173` 落到最近的合法候选 = 174（全下）
⇒ **本节点「价值加注」的默认尺寸就是把 87BB 全部推入。**

---

## 二、最终动作的真实代码路径

| 环节 | 文件 · 函数 | 说明 |
|---|---|---|
| ① `MATH_CALL_SUPPORTED` | `src/app/decision/decisionEngine.ts` · `decideAlpha`（约 1453–1478 行） | 条件：`evEdge > MATH_EV_EPSILON`（`evEdge` 来自 `math.callEV`）。**读的是 `math.heroEquityVsBetRange`**（经 `callEV`） |
| ② 加注候选 | 同上 · `pickClosestRaise(candidates, desiredTo)` | 目标 `pot + 2×callCost = 173` → 取最近的合法候选 **174** |
| ③ 加注门槛 | 同上 · `shouldRaise(equity, requiredEquity, tier, raiseToAmount, pot, handCategory, commitmentException)` | **读的是 `math.heroEquity`**（链条整体范围口径），**不是** Bet Range，也**不是** Raise-Continue Range |
| ④ 证据表 | 同上 · `ActionEvidence[]` | FOLD `EXACT` ev=0；CALL `PROXY_EV` ev=+19.70；**RAISE `HEURISTIC` ev=null** |
| ⑤ 覆盖裁决 | `src/domain/decision/evidencePriority.ts` · `chooseByEvidencePriority` | CALL 的边际是 **CLEAR**（+19.70 对容差带 ±6.65）⇒ 进入 ②-a 分支；RAISE 带 `overrideJustification` ⇒ **允许覆盖** |
| ⑥ 理由 | `decisionEngine.ts` 约 1692 行 | `code = 'STRATEGIC_RAISE_FOR_VALUE'`，`data = { edge: 35.8, tier: 'MEDIUM', source: 'STRATEGIC_HEURISTIC' }` |

### 触发价值加注的条件（逐条实测）

```text
edge = math.heroEquity − requiredEquity = 0.659153 − 0.300752 = +0.3584（+35.8 个百分点）
tier = MEDIUM（handCategory = 2，一对）—— 由 handStrengthTier() 按牌型类别给出
① edge ≥ 0.30 且 tier = MONSTER              → false
② edge ≥ 0.15 且 tier ∈ {MONSTER, STRONG}    → false
③ commitmentException 且 edge ≥ 0.09          → **true ← 唯一放行通道**
量级保护：raiseToAmount / pot = 174 / 93 = 1.871 > 2.5 ? **否 ⇒ 未触发**
          （其注释写着「河牌加注到全下时，对手只会用能击败一对 K 的牌跟注…**一对不行**」）
```

`commitmentException = stackOffAllowed && (roleStrength ≥ 0.55 || 河牌恒为 false 的第二款)`
= `true && (0.62 ≥ 0.55)` = **true**，其中 `stackOffAllowed` **完全由 SPR ≤ 1.5 决定**。

### ❗ 与引擎自身注释的直接冲突（原文引用）

`commitment.ts:159-161` 为本节点生成的注记是：

> 「SPR 1.44（筹码已基本入池）—— 河牌**没有下一街**，SPR 只作背景信息：
> 本次跟注/加注必须由当前节点的赔率与牌力决定，**不构成「以后反正要打光所以现在该跟」的理由**」

`decisionEngine.ts:1531-1538` 的注释也写着：

> 「🔴 **河牌不能再用「以后反正要打光」放行加注**（【数学确定】· §13）」

但该守卫**只施加在第二个条款上**（`futureStreetCommitmentBonus > 0 && band === 'COMMITTED'`，河牌恒为 false），
**第一个条款 `roleStrength ≥ 0.55` 没有任何河牌守卫** —— 而本节点放行加注的正是第一条。
⇒ 河牌保护**只实现了一半**：SPR 派生的 `stackOffAllowed` 仍然可以为一次 87BB 的全下加注背书。

### 是否真正计算了 RAISE EV？

**没有。** `diagnostics.actionEvidence` 中 RAISE 的 `estimateType = HEURISTIC`、`ev = null`、
`assumptionsZh` 明确写着「牌力 + 权益优势的量级保护（`shouldRaise`）：既有启发式，**不是** EV」
与「缺 fold-to-3bet / call-3bet / 4bet 响应数据 ⇒ EV 不可得」。

> ### `RAISE_EV_NOT_IMPLEMENTED`

### 是否比较了 CALL EV 与 RAISE EV？

**没有可比对象**：`chooseByEvidencePriority` 的 `quantified` 集合只含 FOLD(0) 与 CALL(19.70)，
RAISE 因 `ev === null` **不参与 EV 比较**；它靠 `overrideJustification` 在 ②-a 分支直接覆盖。

值得记下的**诚实之处**（不是缺陷）：
- `decisionSource.kind = STRATEGIC_HEURISTIC`、理由文本写明「⚠️ 加注的 EV 无法计算…⇒ 依据来源 = **STRATEGIC_HEURISTIC**（无任何量化 EV 证据）」；
- `decisionMargin.scope = VS_FOLD_ONLY`，注记写明「本次比较**只有跟注 vs 弃牌**，对加注/全下**没有**发言权」；
- 产品**没有**把启发式强牌判断伪装成筹码 EV 排名。这三条已由新增测试 `test/riverRaiseDecisionAudit.test.ts`（RD-1/RD-2）锁住。

---

## 三、Villain 面对 Hero 加注的响应

### 引擎里**存在**的响应模型（形状不同，不可顶替）

`postflopFacts.betDecision`（**Hero 下注 → 他弃/跟/加**）在本节点是存在的：

| Hero 下注尺寸 | FOLD | CALL | RAISE | 对跟注范围权益 | 对加注范围权益 |
|---|---|---|---|---|---|
| 31（1/3 池） | 7.6% | 82.9% | 9.4% | 0.6849 | 0.1572 |
| 62（2/3 池） | 20.6% | 72.8% | 6.5% | 0.6217 | **0.0000** |
| 93（1 池） | 33.7% | 61.0% | 5.3% | 0.5280 | **0.0000** |

⚠️ **它不是本节点需要的那个条件概率**：

| | Hero 下注 | **Hero 加注（本节点）** |
|---|---|---|
| 他面对的价格 | 0.3008（跟 40 进 93） | **0.3946**（跟 134 进 93+268） |
| 底池 | 93 | 361（若他跟注） |
| 他能否再加注 | 可以（模型含 RAISE 桶） | **不能**（Hero 已全下） |

### 引擎里**缺失**的模型

```text
Villain Bet Range                        = 存在（RIVER BET RANGE V2，逐组合权重可审计）
Hero Raise Amount                        = 174（raise-to，= 全下，增量 134）
Villain Fold Probability（面对加注）     = NOT_IMPLEMENTED
Villain Call Probability（面对加注）     = NOT_IMPLEMENTED
Villain Raise Probability（面对加注）    = NOT_IMPLEMENTED（且不合法：Hero 已全下）
Villain Raise-Call Range                 = NOT_IMPLEMENTED
Hero EqVsRaiseCallRange                  = NOT_IMPLEMENTED
RAISE EV                                 = NOT_IMPLEMENTED
```

产品**自述**第 6 项：`postflopFacts.betDecision.checkTree.raiseResponse = 'NOT_IMPLEMENTED'`
（`betResponse.ts:1334` 与 `:1381` 两处硬编码），`composeCheckEVTree` 的最佳应手只取 `max(FoldEV, CallEV)`。
顾问层同时满足 `facingBet ⇒ advice.betDecision = null`（不建 Hero 下注树）。

⇒ **没有一个字段被拿来顶替**：本报告不使用 Bet Range、也不使用「面对普通下注的 Call Range」
去冒名 Raise-Continue Range。

---

## 四、墨菲定律反证：A–D

### 四·一 审计重建（**明确标注：不是产品输出**）

固定 Villain Bet Range（引擎 V2 口径，逐组合权重不变）、Hero 手牌、牌面、底池与加注额，
**只改「他面对加注的响应倾向」** —— 这正是产品没有建模的那一维。
重建使用**产品自己的** `classifyResponse`（价格换成真实加注赔率 0.3946、`heroIsAllIn = true`）
与产品权益引擎：

```text
RAISE EV（零度点 = 弃牌 0）= P(弃)×93 + P(跟)×[EqVsRaiseCall × 361 − 134]
```

| 前提 | P(弃) | P(跟) | P(再加) | EqVsRaiseCall | **重建 RAISE EV** | CALL EV | 结论 |
|---|---|---|---|---|---|---|---|
| **A** 只用更强的价值牌跟注 | 0.588 | 0.412 | 0 | **0.0040** | **−16.37** | +19.70 | 跟注更优 |
| **B** 大量较弱顶对也跟注 | 0.167 | 0.833 | 0 | **0.3381** | **−5.17** | +19.70 | 跟注更优 |
| **C** 经常弃牌但被跟时权益很低 | 0.710 | 0.290 | 0 | **0.0000** | **+15.65** | +19.70 | 跟注更优 |
| **D** 中性（对照） | 0.417 | 0.583 | 0 | **0.0822** | **−41.52** | +19.70 | 跟注更优 |

- A 与 D 的差异（EqVsRaiseCall 0.4% vs 8.2%）证明「对手的继续范围」会**显著**改变 RAISE EV；
- **前提 D 在本节点成立**：CALL EV = +19.70 > 0 而（重建的）RAISE EV = −41.52 < 0；
- 即使前提 C（弃牌率 71%、纯弃牌收益）也只有 +15.65 < +19.70 ⇒ 四种前提下**加注都不优于跟注**。

### 四·二 引擎自己的动作是否随前提变化？

| 画像（引擎输入） | EqVsBetRange | CALL EV | EqVsArrival | 最终动作 | sizeChips | 决策来源 |
|---|---|---|---|---|---|---|
| VERY_TIGHT | 0.460132 | +21.20 | 0.752220 | RAISE | 174 | STRATEGIC_HEURISTIC |
| NORMAL | 0.616655 | +42.02 | 0.753230 | RAISE | 174 | STRATEGIC_HEURISTIC |
| CALLING_STATION | 0.448857 | +19.70 | 0.755247 | RAISE | 174 | STRATEGIC_HEURISTIC |
| MANIAC | 0.654551 | +47.06 | 0.753164 | RAISE | 174 | STRATEGIC_HEURISTIC |

⇒ **从极紧到疯子，动作与尺寸完全不变**。原因是结构性的：
`shouldRaise` 的入参只有 `equity / requiredEquity / tier / raiseToAmount / pot / handCategory / commitmentException`，
**没有任何一项**来自「他面对加注会怎么办」。

### 结论

> 引擎**无法区分 A、B、C、D**：它既没有 Raise-Continue Range，也没有
> 「面对加注的折/跟」概率，加注决策完全不读响应维度；
> 而用引擎自己的响应分类器补上这一维后，本节点的 RAISE EV 在三/四种前提下为**负**。

---

## 五、条件权益一致性

| 字段 | 值 | 对应的**条件事件** | 范围来源 | 用途 |
|---|---|---|---|---|
| `math.heroEquity` | **0.659153** | P(手牌 \| 本手**全部**已发生动作，**含**他在河牌下注 40) | 范围更新链的贝叶斯后验（`buildRangeSnapshot` 全链） | 相对牌力角色、**加注门槛**（+35.8pp）、tier 判定 |
| `postflop.betRangeArrival.heroEquityVsArrivalRange` | 0.755247 | P(手牌 \| 全部已发生动作，**不含**他在河牌下注 40) | 同一条链在「当前下注」**之前**的捕获快照 | 仅报告 / 与下注范围对比 |
| `math.heroEquityVsBetRange` | **0.448857** | P(手牌 \| 他选择下注 40)（专用下注模型） | 到达范围 × P(BET \| 公共强度带, 尺寸, 牌面, 画像) | **CALL EV**（= 0.448857 × 133 − 40 = +19.70） |
| `heroEquityVsRaiseCallRange` | **NOT_IMPLEMENTED** | P(手牌 \| 他下注 40 **且**他跟注 Hero 的全下) | **不存在** | RAISE EV 必需 —— 缺失 |

### 两个「都声称表达他下注后我领先多少」的字段为何不同

- **输入范围不同**：`heroEquity` 的输入是**含本次下注似然的后验**；`heroEquityVsBetRange` 的输入是
  「**到达范围 × 专用下注权重**」。两者都不是对方的子集，因此数值差 **0.210296（21.03 个百分点）**。
- **计算方法不同**：前者来自范围更新链（`estimateUnifiedActionLikelihood` 逐 combo 似然）；
  后者来自公共强度带模型（`betProbabilityByBand`）。
- **后果（已证实）**：同一节点上，**加注门槛读前者、CALL EV 读后者**。
  加注理由向用户显示的「高出所需 **35.8** 个百分点」用的是 0.659153；
  而同一张卡片的 CALL EV（+19.70）若用同一个 65.9% 计算应为 **+47.67**
  （0.659153 × 133 − 40）—— **同一段文字里的两个数字不是同一把尺子量出来的**。

### 这一条是否就是 RAISE 的原因？

**不是**（已用 `shouldRaise` 逐行复刻验证）：

| 作为门槛的权益 | edge | ①MONSTER+≥0.30 | ②强档+≥0.15 | ③承诺例外+≥0.09 | qualifies |
|---|---|---|---|---|---|
| `math.heroEquity`（产品实际） | 0.3584 | false | false | **true** | **true** |
| 若改用 `heroEquityVsBetRange` | 0.1481 | false | false | **true** | **true** |

⇒ 换成下注范围权益**动作仍然是 RAISE**：放行完全由 ③ 低 SPR 承诺例外承担（该条款与权益数值几乎无关）。
因此「两个权益口径不一致」是一条**独立的一致性缺陷**（必须修，但不是本节点的近因），
近因是 **RAISE 没有 EV 模型 + 承诺例外覆盖了清晰的 CALL 证据 + 全下保护未触发**。

---

## 六、回归保护

### 六·一 AK 节点原样复测（对照 RIVER BET RANGE V2 验收值）

| 量 | 本轮实测 | V2 验收值 | 一致 |
|---|---|---|---|
| EqVsArrivalRange | 0.755247 | 0.755247 | ✔ 逐位一致 |
| EqVsBetRange | 0.448857 | 0.448857 | ✔ 逐位一致 |
| CALL EV | 19.697943 | 19.697943 | ✔ 逐位一致 |
| FOLD EV | 0 | 0 | ✔ |
| 最终动作 / sizeChips | RAISE / 174 | RAISE / 174 | ✔ |

### 六·二 RIVER BET RANGE V2 四项已确认修复的复测

| 项 | 复测 |
|---|---|
| 当前 BET 只计一次 | 到达范围权益 0.755247（下注 40）＝ 0.755247（下注 8）**逐位一致** ✔ |
| SHOWDOWN 不再整类清零 | 摊牌类质量 0.443894 > 0 ✔ |
| 下注概率不读 Hero 隐藏底牌 | 模型自述 `usesHeroHiddenCards = false`；`M5`/`D-1` 测试锁定 ✔ |
| FoldToRiverBet 不预测主动下注 | `BR-10` 单变量扫描逐位不变 ✔ |
| CALL EV 数学关系 | 0.448857 × 133 − 40 = 19.697943 = CALL EV ✔ |

### 六·三 四处既有断言变更 —— 是否为迎合新动作而放宽？

| 位置 | 变更 | 判定 |
|---|---|---|
| `test09BetRangeAudit.test.ts` · BR-2 | `betEq ≤ heroEquity`（后验，错误基线）→ `betEq ≤ **arrivalEq**` + 「两者必须不同」 | **不是放宽**。四个画像下 `betEq < arrivalEq` 全部**严格成立**（0.316<0.478、0.316<0.478、0.166<0.470、0.054<0.459），且「必须不同」使断言在「下注范围退化为到达范围」时会失败 |
| `profileRangeAdjustment.test.ts` · T2 ① | 删除 `assert.equal(normal.action, 'FOLD')` | **是行为 pin 的移除**。该节点下注范围权益由 6.92% 升到 34.50%，FOLD 已不成立；改锁「动作 ⇔ EV 符号」 |
| `profileRangeAdjustment.test.ts` · T2 ② | `betEq ≤ equity` → `betEq ≤ arrivalEq` | **不是放宽**（同上，换成正确基线） |
| `profileRangeAdjustment.test.ts` · T2 ③ | `BLUFF_HEAVY ≤ MANIAC` 容差 1e-12 → **0.01** | ⚠️ **唯一的真实放宽**（实测差 0.0007）。理由：两个原型在 aggression 上也不同，两条通道方向相反；BR-12 的 `MANIAC > NIT` 仍为严格不等式 |
| `postflopRegressionCases.test.ts` · TEST 4 | ①`< heroEquity` → `≤ arrivalEq`；②「必须 FOLD」→「动作由 EV 符号决定」 | **不是收紧也不是放宽，是行为契约变更**：该节点动作确实由 FOLD 变成 RAISE（下注范围权益 15.37% → 39.69%），本审计**如实记录**该变更 |
| `profileRangeAdjustment.test.ts` · T13 | 边缘节点输入由 `bluffShareOverride: 0.9` 改为 `0` | **是测试输入的重新标定**（0.9 在新模型下 callEV ≈ +547，远在 ±77.5 之外）；断言本身未改，MARGINAL 与置信度差异仍被锁住 |

**结论**：四处变更中，**1 处是真实放宽**（T2 的单调性容差 1e-12 → 0.01，已记录）；
**2 处是行为 pin 的移除**（T2 基线动作、TEST 4 的 FOLD）；**1 处是测试输入重新标定**（T13）；
其余为把「与错误基线比较」改成「与正确基线比较」，属于加严而非放宽。

**这些变更与本周期的 RAISE 缺陷无关**（两条独立证据）：

1. **被改的四处断言对应的节点都不是本节点**（TEST 09 / nodeB / TEST 4 / T13 的节点 B 变体），
   而 RAISE 缺陷发生在**加注路径**上；
2. `git diff` 证明**加注路径一行未改**：
   `shouldRaise` / `commitmentException` / `RAISE_EDGE_*` / `MIN_CATEGORY_FOR_LARGE_RAISE` /
   `MAX_RAISE_TO_POT_RATIO` / `STRATEGIC_RAISE_FOR_VALUE` 在两次改动中**都没有出现在 diff 里**，
   `src/domain/decision/evidencePriority.ts` 更是**完全未被改动**（`git status` 无输出）。

⚠️ **但要注意本节点的动作确实是 V2 之后才变成 RAISE 的**：

| 版本 | EqVsBetRange | CALL EV | 最终动作 |
|---|---|---|---|
| RIVER BET RANGE V1 | 0.54% | −39.28 | **FOLD** |
| RIVER BET RANGE V2（现状） | 44.89% | **+19.70** | **RAISE 174** |

V2 修正了下注范围（0.54% → 44.89%）⇒ 跟注从「数学负期望」变成「清晰的 +19.70」，
而下游那条**早已存在但被压住看不见**的启发式加注通道随即把 CALL 升级成 87BB 全下。
⇒ **V2 没有制造这条缺陷，但把它暴露出来了**：这正是本轮审计的价值所在。

---

## 七、最终报告（要求的字段）

```text
FOLD EV                        = 0（节点增量口径的定义）

CALL EV                        = +19.697943
                                 （= EqVsBetRange 0.448857 × winnable 133 − callCost 40）

RAISE EV                       = NOT_IMPLEMENTED
                                 （产品自述：estimateType = HEURISTIC、ev = null、
                                   "缺 fold-to-3bet / call-3bet / 4bet 响应数据 ⇒ EV 不可得"）

RAISE EV SOURCE                = NOT_IMPLEMENTED（无计算来源）
                                 现有替代品是启发式 shouldRaise()：
                                 edge 35.8pp（用 math.heroEquity）+ tier MEDIUM
                                 + 低 SPR 承诺例外（stackOffAllowed：SPR 1.441 ≤ 1.5）
                                 + commit 量级保护未触发（174/93 = 1.871 ≤ 2.5）

RAISE CONTINUE RANGE           = NOT_IMPLEMENTED
                                 （无「他面对加注的继续范围」；产品自述
                                   checkTree.raiseResponse = 'NOT_IMPLEMENTED'）

HERO EQ VS RAISE CALL RANGE    = NOT_IMPLEMENTED
                                 （无字段、无计算）

FINAL ACTION                   = RAISE 174（raise-to，= 全下 87BB；与 ALL_IN 174 同额）

FINAL ACTION BASIS             = STRATEGIC_HEURISTIC
                                 （decisionSource.kind = STRATEGIC_HEURISTIC，
                                   evidenceScope = CALL_CLEAR_CALL_OVER_FOLD_OVERRIDDEN，
                                   overrideAttempt = RAISE_HEURISTIC，
                                   overrideBlockedReason = null）
                                 ⚠️ 不是 EV 优胜：CALL 有 PROXY_EV +19.70 且边际 CLEAR，
                                    被一条没有 EV 的启发式覆盖
```

**审计重建（明确标注：不是产品输出）**：按引擎自己的 `classifyResponse`
在真实加注赔率 0.3946 下，本节点 `P(弃) 0.417 / P(跟) 0.583 / EqVsRaiseCall 0.0822`
⇒ `RAISE EV ≈ −41.52 < CALL EV +19.70`；在 A/B/C/D 四种响应前提下 RAISE EV 分别为
−16.37 / −5.17 / +15.65 / −41.52，**全部不优于 CALL EV**。

---

## 八、只报告已证实的事实：三条可复现的缺陷

| # | 缺陷 | 证据 | 位置 |
|---|---|---|---|
| **D1** | **没有 RAISE EV 的情况下，启发式加注覆盖了「边际清晰」的 CALL** | `decisionSource.evidenceScope = CALL_CLEAR_CALL_OVER_FOLD_OVERRIDDEN`、`overrideBlockedReason = null`；CALL 是 `PROXY_EV` 且 `decisionMargin = CLEAR_CALL_OVER_FOLD`（19.70 > 6.65） | `evidencePriority.ts:330-356`（②-a 的 `justified` 分支）+ `decisionEngine.ts:1641-1658` |
| **D2** | **河牌保护只实现了一半**：`commitmentException` 的第二个条款有河牌守卫，第一个（`roleStrength ≥ 0.55`）没有；而本节点正是靠第一条放行 | `commitment.ts:159-161` 的注记明说河牌上 SPR「不构成打光的理由」，`decisionEngine.ts:1531-1538` 的注释也明说「河牌不能再用『以后反正要打光』放行加注」；实测 `stackOffAllowed = true`（SPR 1.441 ≤ 1.5）且 `roleStrength = 0.62 ≥ 0.55` ⇒ `commitmentException = true` | `decisionEngine.ts:1526-1538`、`commitment.ts:118,130` |
| **D3** | **「一对牌不许打光」的保护被阈值口径绕过** | 该保护判据是 `raiseToAmount / pot > 2.5`；本节点 174/93 = 1.871 ⇒ 不触发。而它的注释写明要拦的正是「河牌拿一对加注到全下」。真正被绕过的原因是：**174 = 全下**（= `allInToAmount`），但 raise-to 与底池之比只有 1.87 | `decisionEngine.ts:762-786, 816-818` |

**附带发现（不是近因，但属于口径不一致）**

- **D4**：加注门槛读 `math.heroEquity`（0.659153），CALL EV 读 `heroEquityVsBetRange`（0.448857），
  两者差 21.03pp；用户可见的「高出所需 35.8 个百分点」与同一段里的「CALL EV +19.70」不是同一把尺子
  （若用 65.9% 算，CALL EV 应为 +47.67）。复刻验证：换成下注范围权益动作**仍是 RAISE**，故 D4 不是近因。
- **D5**：候选表里 `RAISE 174` 与 `ALL_IN 174` 是同一动作的两个标签，但 `ALL_IN` 在
  `actionEvidence` 里没有条目 ⇒ 它永远无法参与证据裁决。
- **D6**：`advice.gate.verdict = MARGINAL`（价值守门器结论）与 `worseCallDensity = 0.4428`
  在加注路径上**没有被读取**（`shouldRaise` 不含 gate 结论）。

---

## 九、修复建议（本轮**未**实施）

1. **给加注建 EV**：用引擎已有的 `classifyResponse` 在**加注赔率**下算
   `P(弃|加注) / P(跟|加注)`，条件范围 = 下注范围 × 跟注权重，得到
   `heroEquityVsRaiseCallRange`，再算
   `RAISE EV = P(弃)×pot + P(跟)×[EqVsRaiseCallRange × 终池 − 加注增量]`；
   有了 EV 它就会**自然**进入 `chooseByEvidencePriority` 的 `quantified` 集合参与比较。
2. **河牌守卫补全**：把 `commitmentException` 的第一个条款也加上河牌豁免
   （或在河牌禁用 `LOW_SPR_COMMITMENT` 这条 override 理由）。
3. **全下保护改判据**：除了 `raiseToAmount / pot`，再加一条
   「`raiseToAmount === allInToAmount` 且 `handCategory < MIN_CATEGORY_FOR_LARGE_RAISE` ⇒ 拦截」。
4. **口径统一**：加注门槛改用与 CALL EV 同一个条件权益（或显式标注两者不同）。
5. **候选去重**：`RAISE(全下)` 与 `ALL_IN` 只保留一条并共用证据行。

## 十、本轮新增/未新增的测试

- 新增 `test/riverRaiseDecisionAudit.test.ts`（4 项，**全部通过**）：
  RD-1 加注无 EV 时不得被呈现为 EV 优胜；RD-2 `decisionMargin` 作用域必须如实；
  RD-3 三个条件权益必须可区分且加注继续范围必须标注缺失；RD-4 加注金额语义（raise-to / 全下同额）。
  ⚠️ 这些测试**只锁呈现诚实性**，不锁 A–D 缺陷本身 —— 否则会给仓库留下长期红灯。
- **未**新增「引擎必须能区分 A–D」的断言：那是本轮确认的缺陷，修复时才应新增（届时本文件的 RD-1/RD-2 会自动改写为「有 EV 时必须走 EV 比较」）。
- 全仓验证：`tsc --noEmit` 通过；`test/**/*.test.ts` **1,897 项 / 全部通过**；产物清单已重新生成并校验通过。
