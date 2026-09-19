# P1 · 99 中对「CALL EV 为正却弃牌」一致性定向审计

**轮次代号**：`P1_99_CALL_FOLD_CONSISTENCY_AUDIT`
**类型**：**只读**审计（未修改任何产品代码 / 测试 / 策略参数 / Git 状态）
**审计对象**：`DECISION_CONSISTENCY_ERROR` / `ACTION_CONTRADICTS_CHIP_EV`
**运行基线**：已推送的 GitHub 提交 **`3899189`**（工作区另有**未提交**的 TEST 18 金额口径修复，与本缺陷无关 —— 见 §6）
**结论**：**确认存在缺陷（CONFIRMED BUG）**，属于**决策层判据的「标尺不一致」**；一致性告警本身是**正确**的。

---

## 1. 原始复现节点（未另造牌局）

夹具逐字取自 `scripts/test18-amount-matrix.ts`（与 `reports/evidence/test18-amount-matrix.txt` 的原始输出一致）：

| 项 | 值 |
|---|---|
| Hero 位置 / 手牌 / 公共牌 | BTN ｜ 9♥9♣ ｜ J♦ 8♣ 4♣ 6♠（**转牌**） |
| 盲注 / 有效起始筹码 | 1/2 ｜ 双方 200 筹码 = 100BB |
| 行动历史 | UTG 弃 → HJ 弃 → CO 弃 → **BTN 加注至 6** → SB 弃 → **BB 跟注** ｜ 翻牌 BB 过牌 → BTN 下注 8 → BB 跟注 ｜ 转牌 **BB 主动下注 20** |
| 当前街 / 底池 / 跟注 | TURN ｜ **49.00** ｜ **20.00**（所需权益 **28.9855%**，可争夺量 69.00） |
| 我的剩余 / 有效筹码 / SPR | 186.00 ｜ 166.00 ｜ 3.388 |
| 牌力（引擎） | 「小对子（低于牌面）9，J 踢脚」｜成手 一对 ｜ 角色 **摊牌价值**（强度 0.280） |
| 合法动作 | `FOLD` / `CALL` / `RAISE` / `ALL_IN`（minRaiseTo 40 ｜ 全下到 186 ｜ currentBet 20） |
| 对手 | 阿豪 ｜ seat_BB ｜ `player_001` ｜ **MANIAC** ｜ 800 手 VPIP 48% / PFR 35% / 3Bet 16% / WTSD 36%，**其余统计 null** |
| 复现命令 | `node --experimental-strip-types scripts/p1-99-consistency-audit.ts` |
| **基线复现** | 用 `git archive HEAD`（= `3899189`）导出的**原样代码树**运行同一探针，结果**逐位相同** ⇒ 缺陷在已推送基线内 |

## 2. 第一性原理：EV 与权益口径（独立复算）

| 量 | 值 | 说明 |
|---|---|---|
| FOLD EV | **0.000000** | 节点增量零点（弃牌不再投入） |
| **CALL EV** | **+2.705235410024** | 独立复算 `EqVsBetRange × winnable − callCost` 残差 **0** |
| RAISE EV（被评估尺寸 80） | **−28.205343774394** | 加注明显负期望 ⇒ 加注分支被否 |
| CALL 所需权益 | 28.985507% | = 20 / 69 |
| Hero Equity vs **Bet Range** | **32.906138275397%** | CALL EV 的**真实输入**（EXACT，45,540 局，半宽 0） |
| Hero Equity 整体/到达范围 | 21.545565973459% | **不是** CALL EV 的输入 |
| 权益来源 / 类型 | `EqVsBetRange` ｜ `EXACT`（无抽样噪声、未降级） | — |
| 抽水 / 未来街 | `rakeModel = NOT_APPLIED`（未计抽水）；权益**已枚举河牌** | 均已披露 |
| 容差带（5% × 69） | **±3.45 筹码** | `|CALL EV| = 2.705` **落在带内** |

⇒ **CALL EV 是有效的、可比较的节点增量值**（正值、精确枚举、与零点的分母一致）。
⚠️ 反证：若误用整体范围权益，CALL EV 会算成 **−5.133559**（差 7.84 筹码）—— 「用哪一份权益」在本节点是决定性的。

## 3. 逐层追踪（首次分歧位置）

| 层 | 观测 | 结论 |
|---|---|---|
| ① 数学层 | `evEdge = callEV = +2.705`（> ε）；`verdictEdge = edge = 21.55% − 28.99% = −7.44 个百分点` | **两条标尺互相矛盾** |
| ② 候选构建 | `FOLD 0` / `CALL 20 → +2.705` / `RAISE ×8 → null(未评估)` | 与既有契约一致 |
| ③ 边际 / 容差带 | `kind = MARGINAL`、`scope = VS_FOLD_ONLY`、`evChips = 2.705`、`bandChips = 3.45`：**「真实跟注 EV = 2.71 vs 工程容差带 ±3.45 ⇒ MARGINAL」** | 容差带只描述工程不确定性 |
| ④ 证据优先级 | `decisionSource = null`、`actionEvidence = []` | **本层没有参与** |
| ⑤ 战略守门器 | `role = 摊牌价值 0.28`、`showdownValue 0.248`、`protection 0`、`bluff 0`；SPR 3.39 中档 | 只作为理由出现，**未覆盖动作** |
| ⑥ 最终动作 | **`FOLD`** ｜ confidence 0.30 ｜ MARGINAL ｜ `actionable = true` | — |
| ⑦ `finalMathSanityCheck` | **无问题**（该检查不检查「FOLD + 正 EV」） | — |
| ⑧ 用户可见理由 | 5 条，其中 `MATH_FOLD_DOMINANT` 写着：「对手下注范围权益 **32.9% 低于**跟注所需 29.0%：跟注 EV = 2.71 筹码 … ⇒ **弃牌 EV 更高**」 | 该句**自相矛盾**（32.9% 并不低于 29.0%，且 0 < 2.71） |
| 一致性检查 | `violations = [ACTION_CONTRADICTS_CHIP_EV]`：**「依据是 chip EV 排名，但跟注 EV = 2.71 筹码为正却建议弃牌」** | 见 §4 |

### 🔴 首次分歧位置（精确到条件与行号）

**`src/app/decision/decisionEngine.ts:1816`** 的**第二个或分支**：

```ts
// 数学明显不划算（真实 EV 为负）→ 弃牌
if (verdictEdge !== null && ((evEdge !== null && evEdge < -MATH_EV_EPSILON) || verdictEdge < -MARGINAL_EV_GAP_RATIO)) {
```

- `evEdge = math.callEV`（`math.heroEquityVsBetRange` 口径）→ **+2.705**，第一个分支为假；
- `verdictEdge = layeredEdge ?? (layeredEquity ? null : edge)`（`:1738`），而 `edge = equity − requiredEquity`、`equity = math.heroEquity`（`:1496`，**到达范围**口径）→ **−0.0744 < −0.05** ⇒ 第二个分支为**真** ⇒ 直接 `return foldCandidate`（`:1843` 附近）。
- 代码在 `:1729` 明确写着它依赖的恒等式：**「单层时 `edge = E − c/winnable = callEV / winnable`」**。
 实测：`callEV / winnable = +0.03921`，而 `edge = −0.0744` ⇒ **恒等式被打破 11.36 个百分点**
（= 32.906% − 21.546%，即两份条件权益之差）。
- ⇒ **同一节点上，`callEV` 用「对手下注范围权益」，硬判用「整体/到达范围权益」**：正是 `decisionEngine.ts:1507` 已经为**加注门槛**修过的那一类缺陷（那里改成了 `raiseEquityRaw = heroEquityVsBetRange ?? equity`），但 **CALL/FOLD 硬判仍留着旧标尺**。

### 其余逐项核对（对应审计清单）

| 检查项 | 结论 |
|---|---|
| 正 EV 是否被当成负 EV | **是**（间接）：正值 `callEV` 被另一个标尺的 `edge < −5%` 判成「数学明显不划算」 |
| CALL 与 FOLD 是否同一节点增量口径 | **零点是同一个**（弃牌 ≡ 0、CALL = 权益×可争夺量 − 跟注额）；但**判据多用了第三个量**（权益差），且其权益来源与 EV 不同 |
| 代理 EV 是否有参与比较的资格 | **有**（设计如此）：`evOfCall = exactLayeredEV ?? math.callEV`（`:1776`），候选 `estimateType = PROXY_EV`，依据分类器把本节点判为 `CHIP_EV` |
| 置信度 / 容差带是否构成覆盖授权 | **不是**：`decisionConsistency.ts:340-345` 明确「容差带**不构成**偏离 EV 排名的理由，除非显式开启覆盖并标注」；`allowUncertaintyOverride` 默认关闭；置信度 0.30 只影响分类与分档 |
| 是否有旧启发式 FOLD 覆盖数学证据 | **没有**：`decisionSource = null`、`actionEvidence = []` ⇒ 分歧发生在**数学层内部**，不是策略层覆盖 |
| 一致性告警是否自身有错 | **没有错**：依据分类器 `decisionBasisOf` 在本节点返回 `CHIP_EV`，其 `noteZh` 自己写着「⇒ 由**真实 chip EV 排名**判定：**CALL** 更高」；守卫 `decisionConsistency.ts:365-370` 正是执行这一契约 |

## 4. 墨菲定律反证（A–F：只改对手条件范围，赔率与合法动作不变）

| 变体 | 动作 | CALL EV | EqVsBet | EqArr | 带内 | 依据 | 一致性告警 | 判定 |
|---|---|---|---|---|---|---|---|---|
| **A 原始（MANIAC 800 手）** | **FOLD** | **+2.705** | 32.91% | 21.55% | 是 | CHIP_EV | **ACTION_CONTRADICTS_CHIP_EV** | ❌ **缺陷** |
| B 紧弱（VERY_TIGHT，无统计） | FOLD | −0.544 | 28.20% | 19.83% | 是 | CHIP_EV | 无 | ✅ 数学不支持 CALL |
| **B′ 合成强范围**（生产入口 `gtoRanges` 注入） | **CALL 20** | **+8.252** | 40.94% | 35.15% | 否 | CHIP_EV | 无 | ✅ 超出容差带 ⇒ 跟注 |
| C 合成弱范围（只用垃圾） | RAISE 80 | +32.522 | 76.12% | 71.80% | 否 | SUPPORTED_ACTION_PRIORITY | 无 | ✅ 证据优先级接管 |
| **D 中性（NORMAL，无统计）** | **FOLD** | **+0.0455** | 29.05% | 20.77% | 是 | CHIP_EV | **ACTION_CONTRADICTS_CHIP_EV** | ❌ **缺陷**（同一机理） |
| **E 无画像（UNKNOWN）** | **FOLD** | **+0.0455** | 29.05% | 20.77% | 是 | CHIP_EV | **ACTION_CONTRADICTS_CHIP_EV** | ❌ 同上（置信度最低时同样） |
| F 无人下注（`callCost = 0`） | CHECK | `null` | — | 33.15% | — | PREFERENCE_SCORE | 无 | ✅ 不产生 FOLD 硬判 |

**判据边界**：B′ 与 C 证明「一旦 `CALL EV` 超出容差带 / 或 `edge ≥ −5%`，动作就是正确的 CALL/RAISE」；
**缺陷只在「`CALL EV` 为正且落在带内、同时到达范围权益比门槛低 5 个百分点以上」时出现**，
即需要 `EqVsBetRange − EqArrival > 5pp`（本节点 11.36pp）。
方向是**单向的**：`callSupported` 要求 `evEdge > ε` 或 `evEdge === null` ⇒ **不会**出现「负 EV 却建议跟注」；本缺陷只会**弃掉本该跟的牌**。

### 影响面扫描（现有场景网格 5 画像 × 5 统计形态 × 3 牌面 = 75 局面）

```
扫描局面数 = 75 ｜ 「CALL EV > 0 却弃牌」= 15
```
15 例**全部**落在 99（中对）那张牌面（AJ 顶对+听花、AA 河牌超对两个牌面为 0 例）。
即：**凡是「模型认为他的下注范围比他的整体范围弱得多」的面对下注节点**（本项目的带速率模型给 AIR 的下注率高达 0.83 —— 极化先验），都会命中这一类误判。

## 5. 最小修复范围（**未实施，等待授权**）

**范围**：`src/app/decision/decisionEngine.ts` 一个表达式的口径统一 + 相应文案/测试。

1. **核心（1 处）**：把硬判的标尺与 `callEV` 同源。二选一（推荐 ②）：
 ① `edge` 改为用 `callEV` 的同一份条件权益：`const equityForVerdict = math.heroEquityVsBetRange ?? math.heroEquity;`
 ② 或直接使用代码已声明的恒等式：`verdictEdge = layeredEdge ?? (layeredEquity ? null : (math.callEV !== null && math.winnable > 0 ? math.callEV / math.winnable : edge))`。
 ⇒ 修复后本节点 `verdictEdge = +0.0392 > 0` ⇒ 既不触发「< −5% 弃牌」，也会命中 `callSupported` ⇒ **CALL**，与 `decisionBasisOf` 的 `CHIP_EV` 说明、`trueEvRanking`（FOLD 0 < CALL 2.71）与一致性契约三者一致。
 **不得**顺带放宽 `MARGINAL_EV_GAP_RATIO`、`MATH_EV_EPSILON` 或容差带（`MODEL_UNCERTAINTY_RATIO`）—— 那会让「无差别带」变成新的覆盖理由，违反 P0-2。
2. **文案（同分支）**：`MATH_FOLD_DOMINANT` 的句子在「带内」时必须说明「无差别带内取代价最小方向」，**不得**再写「弃牌 EV 更高」（本节点该句把 32.9% 说成「低于」29.0%，是本次审计抓到的第二个可见矛盾）。
3. **应新增的失败测试**（建议放在 `test/` 新文件 `test/callFoldVerdictRuler.test.ts`，先红后绿）：
 - **P1-1**：原始 99 节点（MANIAC 800 手）⇒ `callEV > 0` 时动作**不得**是 FOLD；且 `consistency.ok === true`、无 `ACTION_CONTRADICTS_CHIP_EV`；
 - **P1-2**：恒等式护栏 —— 对一组面对下注节点断言 `verdictEdge` 与 `callEV / winnable` 同源（`|差| ≤ 1e-9`），直接钉住 `decisionEngine.ts:1729` 的契约；
 - **P1-3**：负 EV 反向护栏 —— `callEV < −ε` 时**必须**弃牌（防止修过头）；
 - **P1-4**：`callEV = null`（无人下注 / 权益不可得）时不得产生 FOLD 硬判；
 - **P1-5**：文案护栏 —— 带内弃牌的句子必须包含「无差别带」且不出现「弃牌 EV 更高」；
 - **P1-6**：把 B / B′ / D 三个墨菲对照固化为「数学支持 CALL / 数学不支持 CALL / 带内」三分类断言（合成范围仅测试内使用）。
4. **回归范围**：`npm run verify` 全量 + `riverConsistency*` / `layeredPot*` / `raiseEvCashflowP0` / `raiseResponseU1` / `test08P0Audit` / `test09BetRangeAudit` / `decisionPipeline` / `nodeDeterminism`。**修复会改变部分 FOLD 输出**（本网格 15/75）⇒ 必须逐条核对既有断言是否属于「旧标尺下的期望」，不得直接放宽。

## 6. 与本轮之外事项的边界

- 本缺陷与**未提交的 TEST 18 金额口径修复无关**：后者只改了尺寸上限判据（`alphaPipeline.ts`）与展示文案（`decisionViewModel.ts`），既不参与动作选择，也不参与一致性检查。基线原样导出（`3899189`）复现结果与工作区**逐位一致**（§1 末行）。
- 本缺陷与 TEST 17 的展示修复**无关但被其暴露**：TEST 17 把 `MATH_FOLD_DOMINANT` 的句子改成「EV 的权益输入 = 对手下注范围权益」后，该句与它的**触发条件**（到达范围口径）不再同源，于是「32.9% 低于 29.0%」这种自相矛盾被摆到台面上。**计数与动作在修复前后完全相同**（`:1816` 的条件未被改动）。

## 7. 复现与证据

```powershell
node --experimental-strip-types scripts/p1-99-consistency-audit.ts   # §2/§3 全量追踪
node --experimental-strip-types scripts/p1-99-murphy.ts              # §4 墨菲 A–F + 影响面扫描
# 基线复现（只读导出，不改工作区）：
git archive --format=zip -o %TEMP%\head3899189.zip HEAD
Expand-Archive %TEMP%\head3899189.zip %TEMP%\dezhou-HEAD3899189-check ; 复制 node_modules 后运行同一探针
```

证据：`reports/evidence/p1-99-audit.txt`（§2/§3/§4 原始输出）、`reports/evidence/p1-99-murphy.txt`（§4 墨菲 + 扫描）。

## 8. 验收块

```
P1_99_CALL_FOLD_CONSISTENCY_AUDIT
ORIGINAL_NODE_REPRODUCED = YES —— 原始夹具逐字复现（BTN 9♥9♣ / J♦8♣4♣6♠ / 转牌 / pot 49 / call 20 / 需求 28.9855%）；并在 git archive HEAD(3899189) 的原样代码树上逐位复现
CALL_EV_VALID = YES —— +2.705235410024；= EqVsBetRange 32.906138275397% × 69 − 20（残差 0）；EXACT 枚举、无抽样噪声、已枚举河牌；rake 未计（已披露）
FOLD_EV_VALID = YES —— 0（节点增量零点），与 CALL EV 同一基线
SAME_EV_BASELINE = PARTIAL —— 零点与 EV 公式一致；但**硬判另用第三个量**（权益差 edge），且其权益来源（整体/到达范围）与 callEV（下注范围）不同 ⇒ 文档化恒等式 edge = callEV/winnable 被打破 11.36 个百分点
FIRST_DIVERGENCE_LOCATION = src/app/decision/decisionEngine.ts:1816（第二或分支 verdictEdge < -MARGINAL_EV_GAP_RATIO）；根因在 :1496（equity = math.heroEquity）→ :1738（verdictEdge）与 contextBuilder.ts:585（callEV 用 EqVsBetRange）的口径不一致
FINAL_ACTION_SOURCE = MATH_FOLD_DOMINANT（数学层硬判），decisionSource = null、actionEvidence = [] ⇒ 策略/证据层未参与
EVIDENCE_PRIORITY_VALID = N/A —— 本节点证据优先级层未运行（decisionSource = null）
CONSISTENCY_WARNING_VALID = YES —— 告警正确：依据分类器在本节点返回 CHIP_EV（其说明自身写着「CALL 更高」），守卫执行的是已声明的 P0-2 契约（EV > +ε ⇒ 跟注；容差带不构成偏离理由）
CONFIRMED_BUG = YES —— 「正 CALL EV 被另一标尺判成负期望 ⇒ 弃牌」，违反 decisionEngine.ts:1763-1769 的三段规则（EV > +ε ⇒ 跟注）与 P0-2 契约；单向偏差（只会弃掉本该跟的牌），扫描中 15/75 局面命中
MINIMAL_FIX_REQUIRED = YES（未实施）—— ① decisionEngine.ts 一处：硬判标尺与 callEV 同源（推荐 verdictEdge 由 callEV/winnable 推导，保留 layeredEdge / layeredEquity 优先级与全部阈值不变）；② 同分支文案在带内改说「无差别带内取代价最小方向」；③ 新增 6 条失败测试（P1-1…P1-6，含负 EV 反向护栏与恒等式护栏）；④ 全量 verify + 指定回归，逐条核对会翻转的 FOLD 期望
OTHER_AFFECTED_NODES = 影响面 = 面对下注 且 EqVsBetRange − EqArrival > 5pp 且 CALL EV ∈ (0, 带) 的节点；本次扫描网格 75 局面中 15 例命中（全部为「中对/边缘摊牌价值」牌面）；AJ 顶对+听花、AA 河牌超对两个牌面 0 例
SAFE_TO_CONTINUE_HAND_TESTING = YES_WITH_CAVEATS —— 数值与资金口径可信（残差 0），但**本类节点的最终动作不可信**（会把 +EV 的跟注弃掉，并输出「不要据此行动」的一致性告警）；在修复授权前，遇到 DECISION_CONSISTENCY_ERROR 的节点应人工按 CALL EV 与对手下注范围权益复核
```

本轮结束：**未修改任何产品代码 / 测试 / 参数**，等待人工授权后再实施 §5 的最小修复。
