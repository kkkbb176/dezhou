# RIVER DECISION CONSISTENCY V2 — PASS

**日期**：2026-09
**触发**：真人牌局测试（9人桌 · Hero BTN A♣Q♠ · Q♦8♣5♣ / 2♥ / K♣ · CO 河牌 lead 22BB）
**范围**：只修**一致性与口径**，**不改扑克打法**（使用者第二节 / 第二十二节）
**验收**：`npm run verify` → **TypeScript 0 错误 / 1,636 项测试 / 137 套件 / 0 失败**；
既有测试**零删除、零放宽**；新增 11 条（R1–R10 + R1b）；5 项变异测试全部有效

```text
本轮**不**宣称：+EV VERIFIED / GTO VERIFIED / SOLVER VERIFIED / LONG-TERM PROFIT VERIFIED
本轮**只**宣称：RIVER DECISION CONSISTENCY V2 — PASS（输出内部一致、口径统一、无提前结算）
```

---

## 证据等级（全轮统一）

| 等级 | 含义 | 本轮适用 |
|---|---|---|
| 【数学确定】 | 可以直接锁死为 invariant | 河牌无未来公共牌、底池赔率代数、节点增量 EV、死牌移除 |
| 【公开扑克理论】 | 有成熟理论依据，但频率仍依赖范围与环境 | 价值/诈唬定义、阻断价值 vs 阻断诈唬、抓诈唬顺序 |
| 【工程约束】 | 为保证软件内部一致性，不代表扑克策略 | 动作与指标同体系、事件去重、不提前结算 |
| 【启发式 / 未验证】 | 只能作为 preference score 输入 | 归一化评分、画像偏移、blocker 加权、信心分档 |

---

## 1. 河牌被识别成 DRAW 的根因

**根因（一行）**：`classifyRelativeRole` 的听牌分支**不看当前街**。

```text
draws.flushDraw === true  ⇔  「我有四张同花」⇔  「还有一张能让我成同花」
Hero A♣Q♠，牌面 Q♦8♣5♣/2♥/K♣ → A♣ + 三张♣ = 四张同花 ⇒ flushDraw = true
⇒ 第 3 节直接返回 DRAW（并**绕开**第 4 节的「一对级」判定）
```

- 复现：`shape = MIDDLE_PAIR`（中对 Q，A 踢脚）而 `role = DRAW` —— 两者自相矛盾。
- 后果不只文案：`DRAW` 让这手牌**不再走抓诈牌/空气的判定**，进而影响价值守门器、
  阻断牌与偏好分（R1 用例覆盖 5 种河牌成手）。

**修复（【数学确定】定义域约束，不是启发式降级）**：

```text
street === 'RIVER'  ⇒  role ∉ { DRAW, SEMI_BLUFF }
```

| 位置 | 改动 |
|---|---|
| `relativeHandRole.ts` | 听牌分支加前提 `cardsToCome = street !== 'RIVER'`（河牌整段不适用） |
| 同上 | 新增 `RIVER_FORBIDDEN_ROLES` 常量 + `normalizeRiverRole()` **产出侧兜底**（分类器以外还有别的入口） |
| `postflopAdvisor.ts` | 分类后调用 `normalizeRiverRole`；**上一街角色**单独算并存为 `previousStreetRole` |

**上一街角色保留**（使用者第二节）：转牌曾经是听牌这件事仍然显示，但标为
「历史参考，**不是**当前牌力」—— 实测 `previousHandRole = DRAW` / `handRole = AIR`。

---

## 2. 当前所谓「EV」的真实数学来源

被使用者点名的那个数（界面「理论 EV −378.33 筹码」/ 本节点 `−317.61`）
是 `math.callEV`，**它确实是一个真 EV**，但**只在写清参考点之后才成立**：

```text
来源：src/app/manualInput/contextBuilder.ts
公式：callEV = 权益 × winnable − 跟注额          （winnable = 跟注后可争夺量 = P + 2B）
口径：节点增量（node-local incremental）
参考点：弃牌 EV ≡ 0 —— 已投入底池的筹码是**沉没成本**
```

验证（本节点实测，R3 用例锁死）：

| 量 | 值 |
|---|---|
| 跟注额 B | 2,200 筹码 |
| 下注前底池 P | 3,450 筹码 |
| 可争夺量 `winnable` = P + 2B | 7,850 筹码 |
| 权益 `heroEquity` | 23.980% |
| 所需权益 `requiredEquity` = B/(P+2B) | 28.025% |
| `callEV` = 0.2398 × 7850 − 2200 | **−317.61 筹码** |

恒等式（两条都进测试）：
`callEV = 权益 × winnable − B`；且 `权益 = requiredEquity ⇒ callEV = 0`（精确为 0）。

**它不是**：不是 solver EV、不是整手牌累计收益、不含抽水（界面已声明
「抽水模型：未计入」）。

---

## 3. 是否保留「EV」这个名称

**保留 `callEV`，但必须带三个限定词；其余一律改名。**

| 字段 | 是否叫 EV | 理由 |
|---|---|---|
| `math.callEV` | ✅ **可以叫 EV** | 满足 EV 定义：outcome（赢/输）明确、概率来自权益引擎、payoff 与筹码同单位、范围权重有来源、底池重建正确、参考点一致（弃牌 ≡ 0） |
| `estimatedBetEVScore` / `estimatedCheckEVScore` | ❌ 改名「偏好分」 | 0..1 启发式比较分，**没有** outcome 概率与 payoff ⇒ 不满足 EV 定义 |
| `ValueBetAssessment.metricKind` | 新增字段 | 本模块恒为 `PREFERENCE_SCORE`（**永不自称 EV**） |
| `blocker` 的 `netBlockerPreference` | ❌ 不是 EV | 只进偏好分，幅度有上限，标 `evidenceQuality` |
| 压缩状态（强度下限/坚果密度/空气密度） | ❌ 评分 | 界面标签改为「内部评分，非概率」 |

界面现在**分行**显示，且各自带口径：

```text
跟注 EV（节点增量口径）：-317.61 筹码｜参考点：从当前决策点往后算，弃牌 EV ≡ 0
价值判断：PREFER_CHECK（下注偏好分 0.00 vs 过牌偏好分 0.15，内部评分）
```

（修复前：一行「理论 EV −378.33 筹码」+ 一行「偏好顺序」+ 一个与两者都不一致的动作。）

---

## 4. Node-local EV 的实现方式

`decisionEngine` 的动作判据**统一**在「节点增量」口径上，三档：

| 区间 | 判据 | 输出 |
|---|---|---|
| `callEV < −带` | 【数学确定】 | `MATH_FOLD_DOMINANT` → FOLD（**不允许策略层翻转**） |
| `callEV > +带` | 【数学确定】 | `MATH_CALL_SUPPORTED` → CALL（强牌可 RAISE） |
| `|callEV| ≤ 带` | 【工程约束】 | `MATH_INDIFFERENT_BAND`：**无差别带**内取代价最小方向（跟注），并写明「这是规则，不是 +EV 结论」 |

其中 `带 = MARGINAL_EV_GAP_RATIO (5%) × winnable` —— 与 `edge` 口径**严格等价**
（`callEV = winnable × edge`），因此不存在两把尺子。

**新增 `decisionBasisOf`**（使用者第八节）：从输出**反推**本次动作的依据种类
（`CHIP_EV` / `PREFERENCE_SCORE` / `INDIFFERENCE_BAND` / `SAFETY_RULE` / `NO_ACTION`），
界面显示在「决策依据」行，守卫据此校验动作与依据是否同体系。

**硬错误（不再只警告）**：`finalMathSanityCheck` 现在对
「`callEV < −带` 却建议跟注」**直接抛错**（与「明确决策 + 低置信度」同级）。
修复前它对 `callEV < 0` 只推一条警告，于是实测输出里
警告说「数学上不成立」、动作却是跟注 —— 那正是「自相矛盾地给建议」。

---

## 5. Pot Odds 测试结果（R2）

`requiredEquity = B / (P + 2B)`，五种尺度全部通过
（`P` = **下注前**底池 = `math.pot − callCost` ＝ 3,450 筹码，五种尺度下都不变）：

| 河牌下注 | 占池比 | 跟注额 B | 可争夺量 P+2B | 期望所需权益 | 实测 | 结果 |
|---|---|---|---|---|---|---|
| 3BB（小注） | 8.7% | 300 | 4,050 | 7.407% | 7.407% | ✅ |
| 10BB | 29.0% | 1,000 | 5,450 | 18.349% | 18.349% | ✅ |
| 22BB（本节点） | 63.8% | 2,200 | 7,850 | 28.025% | 28.025% | ✅ |
| 45BB（超池） | 130.4% | 4,500 | 12,450 | 36.145% | 36.145% | ✅ |
| 90BB（超池） | 260.9% | 9,000 | 21,450 | 41.958% | 41.958% | ✅ |

同时断言 `winnable === pot + B`（可争夺量口径一致）。误差阈值 `1e-12`。
**上表每个数字都来自真实管线的探针实测**（不是手算示例）。

**含 rake 的情形**：本项目**尚无 Rake Engine**，`callEV` 是未计抽水口径，
界面与诊断都显式声明（`RAKE_MODEL: NOT_APPLIED`）。**没有**为凑这个要求而写一个假 rake 公式。

---

## 6. Blocker value / bluff 双向分析

**改造前（V1）**：只有牌面特征打分 —— `blocksValue = (同花面且我持该花色 ? 0.55 : 0) + (我持最高张 ? 0.3 : 0)`，
于是 **A♣ 与 2♣ 在 ♣♣♣ 面上得到完全相同的阻断分**，且从不回答
「挡掉了他多少**组合**」。它也没有用可达范围（1326 组合与真实可达范围是两件事）。

**改造后（V2，【公开扑克理论】+【数学确定】计数 +【启发式】加权）**：

| 字段 | 含义 | 等级 |
|---|---|---|
| `blockedValueCombos` | 被 Hero 的牌**物理上移除**的、且比 Hero 更好的对手组合数 | 【数学确定】计数 |
| `blockedBluffCombos` | 同上，但比 Hero 更差（诈唬/摊薄一侧） | 【数学确定】计数 |
| `valueBlockBenefit` | 阻断价值 = **收益** | 【公开扑克理论】 |
| `bluffBlockCost` | 阻断诈唬 = **代价**（他没牌可诈唬了） | 【公开扑克理论】 |
| `netBlockerPreference` | 收益 − 代价（−1..1） | 【启发式】→ 只进偏好分 |
| `evidenceQuality` | `HIGH/MEDIUM/LOW/NONE`（按可达组合数） | 【工程约束】 |

**基于可达范围**（使用者第十一节）：输入是 `OpponentRangeFacts`
（逐档直方图 + 更差/更好占比 + 组合数 `supportSize`），组合枚举时排除牌面与 Hero 的牌。

本节点实测（A♣Q♠，可达范围 410 个组合）：

```text
挡掉价值组合 29 个、诈唬组合 63 个；价值阻断收益 0.27、诈唬阻断代价 0.20、
净偏好 +0.07（证据质量 HIGH，内部评分）
```

**纪律（使用者第十节）**：`netBlockerPreference` **不单独决定动作**；
代码里**没有** `if (hasNutSuitBlocker) increaseCall()`。
R6 用例专门验证「换一张牌 ⇒ 挡掉的诈唬组合数独立变化」，并**不**断言「A♣ 就该跟注」。

---

## 7. A♣Q♠ 案例的生产 pipeline 结果

**修复前 → 修复后**（真实管线：manual input → reconstruct → context → range → postflop → decision → UI）：

| 输出 | 修复前 | 修复后 |
|---|---|---|
| 相对牌力角色 | **听牌（DRAW）** | 空气（AIR，强度 0.05）；上一街角色（历史参考）听牌 |
| 底池 / 跟注 / 可争夺 | 5,650 / 2,200 / 7,850 | 同（未改数学） |
| 所需权益 | 28.025% | 同 |
| 权益 | 23.980% | 同 |
| 跟注 EV | −317.61 筹码（**口径未写**） | −317.61 筹码（**节点增量口径 + 弃牌 EV ≡ 0**） |
| 价值判断 | NOT_VALUE（下注 0.00 / 过牌 0.19） | PREFER_CHECK（下注偏好分 0.00 / 过牌偏好分 0.15，内部评分） |
| 偏好顺序 | FOLD 0.58 > CALL 0.42（**未说明它是不是依据**） | FOLD 0.51 > CALL 0.49 > RAISE 0.15　← **本次动作不是由它选出的**（依据：INDIFFERENCE_BAND） |
| 决策依据 | （无此字段） | `INDIFFERENCE_BAND`：跟注 EV 落在 ±392.50 筹码带内 ⇒ 数学上无明显优劣，取代价最小方向 |
| 最终动作 | CALL | CALL（**同一动作，但现在口径自洽**） |
| 界面警告 | 「建议跟注但跟注 EV 为负 —— 数学上不成立的建议不应出现」 | **已删除**（该警告只在真矛盾时触发，且此时直接抛错） |
| 结算 | **无人跟注、退回 2200**（Hero 还没决定） | **尚待跟注 2200**（下注轮未结束：还有人可以跟 —— 这**不是**退回） |
| 一致性守卫 | （无） | `ok = true`，零违规 |

⚠️ **本轮不断言 CALL 或 FOLD 哪个对** —— 没有 solver ground truth 支持这种硬编码。
本轮断言的只有：**输出内部一致**（角色合法、赔率正确、口径不混、动作与所用指标同体系、无提前/重复结算）。

---

## 8. SPR / river 逻辑修复

**问题（【公开扑克理论】+【工程约束】）**：河牌没有下一街，但理由文本说
「SPR 1.09（筹码已基本入池）⇒ 这手牌**可以**纳入 stack-off 考虑」——
「以后反正要打光所以现在该跟」在河牌上**在结构上不存在**。

| 改动 | 内容 |
|---|---|
| `assessCommitment` 新增输入 | `street` |
| 新增输出 | `futureStreetCommitmentBonus`（非河牌 ≤ 0.2；**河牌恒为 0**） |
| 河牌理由 | 改成明确声明：「河牌**没有下一街**，SPR 只作背景信息：本次跟注/加注必须由当前节点的赔率与牌力决定」 |
| 决策层 | 河牌加注**不再**由「筹码已基本入池」的承诺例外放行（该例外现在要求 `futureStreetCommitmentBonus > 0`） |
| 守卫 | 检查 J：河牌 `futureStreetCommitmentBonus === 0` |
| 测试 | R7（三手牌 × 河牌，均断言为 0） |

SPR 本身仍作为**背景信息**显示（使用者允许：「SPR 可以保留为背景信息」）。

---

## 9. `2359` 的来源

**机制（已确证）**：那个数字是 `computeLayeredPot` 的 `returned`（单位：**筹码**），
算法是**既有的**「封顶投入」口径，不是自查公式：

```text
未被跟注量 = 我投入 − 其他所有人的最高投入
本节点：CO = 2.5 + 4 + 10 + 22 = 38.5BB；Hero BTN = 2.5 + 4 + 10 = 16.5BB
⇒ 超额 = 22BB = 2,200 筹码（1BB = 100 筹码）
```

**本机复现（精确按使用者描述的手牌）**：`total 5650 / contested 3450 / returned {seat_CO: 2200}`
→ 旧代码 `linesZh` 渲染「无人跟注、退回 2200」。

**关于 2359 这个具体数字**：同一公式下 `2359 筹码 = 23.59BB × 100 筹码/BB`。
即在使用者的牌桌配置里，那个超额是 **23.59BB**（而本机描述局面是 22BB）——
可能是牌桌盲注单位或实际下注额与描述略有差异。
⚠️ **我无法在这里确证使用者的盲注/下注配置**，因此只能给出公式与单位换算，
不编造一个「就是 XX 来源」的结论。

**可以确定的两件事**（这两件才是缺陷本身）：

1. **不该出现**：在下注轮未结束的决策节点，这笔钱**不是**退回，而是「尚未匹配」。
2. **不该出现两次**：`meta.layeredPot.linesZh`（服务端）与 `table.js`（客户端）
   **各自拼了一次**同样的文案 ⇒ 界面重复。

**修复后**：该节点不再有任何 `UNCALLED_BET_RETURN`；
`returnedTotal = 0`、`pendingTotal = 2200`、`roundClosed = false`，
界面只显示一行「尚待跟注 2200（…这**不是**退回…）」。**2359 这个类别的文案在该节点永久消失**（任何配置下都一样）。

---

## 10. settlement 重复的来源

| 来源 | 说明 | 修复 |
|---|---|---|
| **服务端** `describeLayeredPotZh` | 内部拼 `无人跟注、退回 ${returnSum}`（**汇总值**，不区分玩家） | 改为**由结算事件生成**（单一事实来源） |
| **客户端** `table.js` | 又拼一条 `无人跟注、退回 ${lp.returnedTotal}：这部分不在底池里…` | **删除**；改为渲染服务端事件列表，并按 `id` 去重 |
| **无身份标识** | 文案没有 id，无法判断两条是不是同一件事 | 事件带**内容标识 id**（`street|kind|playerId|amount|discriminator`），内容相同 ⇒ id 相同 ⇒ 去重收敛 |
| **时序混淆** | 「未匹配」与「退回」共用一个字段 | 拆成 `pendingUnmatched` / `returned`，事件带 `final` 标记 |

守恒不变量同步升级（`selfCheckLayeredPot` + `POT-11` 随机压力测试）：

```text
contested + Σreturned + ΣpendingUnmatched === total
pendingUnmatched > 0  ⇔  roundClosed === false
returned > 0  ⇒  除他之外没有任何未弃牌、未全下、还有筹码的玩家
```

---

## 11. 新增测试数量

| 文件 | 条数 | 内容 |
|---|---|---|
| `test/riverConsistency.test.ts`（新） | **11** | R1 / R1b / R2 / R3 / R4 / R5 / R6 / R7 / R8 / R9 / R10 |
| `test/layeredPot.test.ts`（升级） | — | `POT-11` 守恒式升级 + 时序不变量 + 「尚未匹配」路径必须被压到 |

**测试纪律**：全部跑**真实生产管线**（不是模块级单测）；
**不**断言「必须 CALL / 必须 FOLD」（无 solver 依据）；断言的是不变量与方向。
其中 R4 / R10 会**独立复算**守卫（不信任生产输出的 `ok` 布尔值）。

---

## 12. Mutation Test 结果

| # | 变异 | 必须失败 | 实际失败 |
|---|---|---|---|
| 1 | 允许河牌角色 = DRAW（分类器 + 兜底规范化都关掉） | R1 | ✅ R1、R1b、R4（守卫报 `RIVER_ROLE_DRAW`）、R10 |
| 2 | 把「无差别带」谎报成「由 chip EV 决定」 | R4 | ✅ R4、R10（守卫报 `ACTION_CONTRADICTS_CHIP_EV`） |
| 3 | 河牌 `futureCardProtectionScore > 0` | R7 | ✅ R7、R4（守卫报 `RIVER_FUTURE_CARD_PROTECTION_NONZERO`） |
| 4 | 不区分「尚未匹配」与「最终退回」 | R8 | ✅ R8、R10 |
| 5 | 同一 settlement event 生成两次 | R9 | ✅ R9（`事件 id 必须唯一`） |

**恢复**：每次变异后按 SHA-256 校验文件 hash 与原值**逐位一致**
（`relativeHandRole.ts` `8E0AB7D3…`、`decisionConsistency.ts` `21FB3564…`、
`valueBetGate.ts` `665F2DA1…`、`pots.ts` `E9FC10E9…`），源码中无残留标记。

> 变异 3 的过程发现了我自己写的一条**不敏感断言**：R7 最初只测 A♣Q♠，
> 而这一手 `protectionRelevant = false`（wetness 0.33 < 0.4）⇒ 变异不被触发。
> 已改为覆盖 3 手牌（含 `protectionRelevant = true` 的那手）。
> **不敏感的测试等于没写** —— 这正是变异测试存在的意义。

---

## 13. `npm run verify` 结果

```text
> tsc --noEmit                        → 0 错误
> node scripts/checkManifest.ts       → 134 个产物一致
> node --test                          → 1,636 项 / 137 套件 / 0 失败 / 0 跳过
```

| 项 | 值 |
|---|---|
| 既有测试删除 | **0** |
| 既有断言放宽 | **0**（`POT-11` 的守恒式是**加强**：新增两项时序不变量与 `pending` 项） |
| 新增测试文件 | 1（`test/riverConsistency.test.ts`） |
| 测试文件总数 | 73 |
| 状态文档同步 | `CURRENT_PROJECT_STATUS.md` §10.0.11 + 数量表 |

**未改动**（使用者第二十二节）：preflop range / GTOpen / 玩家画像 schema / 已有玩家数据 /
`legalActions` / 无关 UI / 翻前策略 / solver 数据。

---

## 14. 剩余未验证的策略假设（如实记录）

| # | 假设 | 为什么仍未验证 | 风险 |
|---|---|---|---|
| 1 | 无差别带内**取跟注**（代价最小方向） | 这是**规则**而非 EV 结论。若改成「按偏好分选」，由于 `foldScore = 1 − callScore` 在 0.5 处翻转，会**系统性收紧边缘跟注** —— 属策略改动，本轮刻意不做 | 中：边缘局面方向由规则决定，需真人样本评估 |
| 2 | blocker 的**加权**：被挡组合按「可达范围的档位占比 ÷ 组合数」加权 | 可达范围只给逐档质量，未给逐组合后验；逐组合后验需要把似然模型暴露成可复用函数 | 低-中：方向正确，幅度是启发式（已标 `evidenceQuality`） |
| 3 | **加注 EV 不可算** | 缺可信的对手弃牌率模型 ⇒ 加注只能由安全规则（`shouldRaise` 量级保护 + 权益优势）选出 | 中：加注建议是定性判断（界面已写明） |
| 4 | 权益引擎的精度 | 本节点是**精确枚举**（`method = EXACT`，990 局组合，±半宽 0）；但**范围本身是启发式**（`sourceKind = HEURISTIC`，可信度 0.30）⇒ 权益的误差主要来自范围，而不是枚举 | 中：范围误差直接进 EV |
| 5 | 相对牌力角色的结构阈值（0.85/0.70/0.58/0.45） | 结构性判断，未做真人样本校准 | 低-中 |
| 6 | 抽水未建模 | 无 Rake Engine | 低（低级别现金局抽水影响小但非零） |
| 7 | 「当前街角色重算」在**转牌**上的正确性 | 本轮只修河牌定义域约束；转牌听牌语义未审 | 低 |

---

## 15. 是否可以恢复 30 局对抗性测试

**可以恢复，但按「受控抽样 + 逐局复盘」的方式，且先看三条硬指标。**

**建议恢复的理由**

1. 触发本轮的全部 8 项一致性风险都有**可执行的回归锁**（R1–R10 + 守卫），
   且 5 项变异测试证明这些锁**真的会失败**；
2. 输出现在**自证口径**：界面显示「决策依据（`CHIP_EV` / `INDIFFERENCE_BAND` / …）」、
   「跟注 EV（节点增量口径，弃牌 EV ≡ 0）」、「偏好顺序 ← 本次动作不是由它选出的」，
   因此每一局都能复盘「引擎凭什么这么想」；
3. 结算不再提前、不再重复（事件带 id，界面按 id 去重），
   因此不会再出现「无人跟注、退回 X」这种误导信息；
4. 一致性守卫在违规时**大声报错**（`DECISION_CONSISTENCY_ERROR`），不会静默给矛盾答案。

**恢复时必须遵守的三条**

| # | 要求 | 理由 |
|---|---|---|
| 1 | 每局记录：位置 / 有效筹码 / 翻前动作 / 三条街动作与尺寸 / 对手画像证据 / **引擎的决策依据字段** | 「依据 = INDIFFERENCE_BAND」的局面**不能**用来评价策略好坏（那是规则决定的） |
| 2 | 只统计**方向性分歧**，并区分「引擎错」「引擎对但我没这么打」；**不得**用输赢判断决策质量 | 30 局的结果噪声远大于策略差异 |
| 3 | 样本 < 30 局**不调参**；只接受**可复现的方向性问题**并附真实反例 | 本轮已两次证明「看起来像调参」的其实是口径错位 |

**恢复前建议先做的一件工程事**：`git init`。
本轮改动涉及 9 个源文件 + 2 个测试 + 结算/客户端渲染，目前**没有 diff 可审计**，
只能靠文件 hash 自证 —— 那对手工核对不友好。

**明确不做的部分**

- ❌ 不把 `callEV` 当 solver EV，也不换算成「这一注值 X 元」的收益承诺；
- ❌ 不在没有 ≥30 手证据时依赖 exploit 层（可信度 0 时偏移恒为 0，这是设计）；
- ❌ 不为通过某一手真人牌而写死动作（本轮**没有**新增任何 `if (A♣Q♠ …) CALL` 类分支，
  也没有 `flush-completing river ⇒ FOLD`、`nut blocker ⇒ CALL`、`SPR < 1 ⇒ stack off`）。

---

## 附：本轮修改文件清单

| 文件 | 改动 |
|---|---|
| `src/domain/postflop/relativeHandRole.ts` | 河牌定义域约束（听牌分支按街门控）+ `RIVER_FORBIDDEN_ROLES` + `normalizeRiverRole` |
| `src/domain/postflop/commitment.ts` | `street` 输入 + `futureStreetCommitmentBonus`（河牌 = 0）+ 河牌理由改写 |
| `src/domain/postflop/valueBetGate.ts` | `futureCardProtectionScore`（名字收窄，河牌 = 0）+ `metricKind` |
| `src/domain/postflop/blockers.ts` | **重写**：可达范围逐组合双向计数 + 证据质量 |
| `src/domain/postflop/types.ts` | `OpponentRangeFacts.supportSize`（占比的分母） |
| `src/app/manualInput/rangeFacts.ts` | 统计并输出 `supportSize` |
| `src/domain/decision/decisionConsistency.ts` | **新增**：守卫 A–K + `decisionBasisOf` |
| `src/domain/decision/decision.types.ts` | 快照新增上一街角色 / 保护分 / blocker 计数 / 依据 / 一致性 |
| `src/app/decision/decisionEngine.ts` | 无差别带口径写清 + 河牌承诺例外失效 + 守卫与依据接入 |
| `src/app/decision/postflopAdvisor.ts` | 河牌角色规范化 + 上一街角色 + blocker 范围输入 + 评分/概率措辞分离 |
| `src/app/alphaPipeline.ts` | 跟注 EV 检查改为「只在真矛盾时抛错」 |
| `src/domain/poker/pots.ts` | `pendingUnmatched` / `roundClosed` + 结算事件（内容 id）+ 去重 + 文案单一来源 |
| `src/app/webServer.ts` | 暴露 pending / 事件 / 去重结果 |
| `src/app/web/table.js` | 按事件 id 渲染 + 删除重复的「退回」文案 + 「尚待跟注」措辞 |
| `src/viewmodels/decisionViewModel.ts` | 决策依据 / 一致性 / 评分标注 / 分母 / EV 参考点 |
| `test/riverConsistency.test.ts` | **新增** 11 条 |
| `test/layeredPot.test.ts` | `POT-11` 不变量升级 |
| `CURRENT_PROJECT_STATUS.md` | §10.0.11 本轮记录 + 数量同步 |
