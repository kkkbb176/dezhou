# DECISION BASIS CONSISTENCY V1 · EV 比较与偏好评分专项审计报告（**只读，未改生产代码**）

**日期**：2026-09　|　**性质**：只读审计 + 生产入口最小复现（**未实施任何生产改动、未提交、未推送**）
**基线**：`HEAD = bc56191`；工作区含 RIVER DECISION CONSISTENCY V1（未提交）与 STREET STATE CONSISTENCY V2（未提交）
**探针（未跟踪，只读）**：`scripts/audit-decision-basis-v1.ts`（45 个节点扫描 + 公式边界）、`scripts/audit-decision-basis-v2.ts`（24 个栈深 + 30 个组合的实例搜索 + 披露检查）
**执行证据**：两探针均实跑；全量 `npm run verify` 于本轮结束时再跑一次（2094/2094，见 `FINAL_VERDICT`）

---

## DECISION_BASIS_AUDIT

`DecisionBasisKind` 共 12 种（`decisionConsistency.ts:88-100`）。本轮关注的两种都由**同一个函数**、
按**输入事实**反推（不是模块自报）：

```ts
// decisionConsistency.ts:115-172
if (!input.facingBet) {
  if (input.byBetDecisionModel === true) return { kind: 'ACTION_EV_COMPARISON',
    noteZh: '无人下注：动作由**下注决策模型**的合法动作 EV 比较选出 —— …（⚠️ 启发式代理 EV，不是 Solver EV）' };
  return { kind: 'PREFERENCE_SCORE',
    noteZh: '无人下注：动作由**价值守门器的偏好分**（下注分 vs 过牌分）选出 —— 内部评分，不是 chip EV' };
}
```

| 事实 | 引擎输出（诊断） | 一致性校验内部 |
| --- | --- | --- |
| 取依据的调用点 | `decisionEngine.ts:3691-3724` | `decisionConsistency.ts:362-374` |
| 传入 `byBetDecisionModel` | ✅ `!isFacingBet && betDecision != null && action !== 'CHECK'` | ❌ **未传**（该字段不在校验输入里） |
| 无人下注节点得到 | `ACTION_EV_COMPARISON` | `PREFERENCE_SCORE` |
| 有人下注节点得到 | `CHIP_EV` / `SUPPORTED_ACTION_PRIORITY` / `STRATEGIC_HEURISTIC` / `HEURISTIC_TIEBREAK` / `FALLBACK` / `HARD_CONSTRAINT` / `SAFETY_RULE` / `MODEL_UNCERTAINTY_OVERRIDE` | 同左（输入相同） |

⇒ **同一个决策、同一次输出里出现两个依据名**。这不是两个决策模块，而是**两处对同一事实的不同标注**
（`ACTION_CONTRADICTS_PREFERENCE` 只在无人下注节点可能触发 —— 有人下注时依据不会是 `PREFERENCE_SCORE`）。

## EV_SELECTION_SOURCE（Q1）

**输入**（`src/domain/postflop/betResponse.ts`）：对每个尺寸分别建「弃牌 / 跟注 / 加注」三支响应树，
分支概率来自对手范围与响应模型，逐支算 EV，再按概率加权：

```text
BetEV(33% 池 = 1625.0 筹码) = 0.007×4875.0 + 0.567×3355.3 + 0.426×52.8 ⇒ 1961.00 筹码（启发式代理 EV）
```
（上式为另一次实测输出的原文；本报告主局面为 `pot=4875`、`checkEV=3711.5`。）

- 多人池时 `betEV = multiway.totalEV`，单挑值留在 `betEVSingleOpponent` 且**不参与决策**（`postflopAdvisor.ts:601-611`）；
- `checkEV` 与权益同源：实测 `4875 × 0.7613 = 3711.0 ≈ 3711.5` ✓；
- **作用**：`EV_SELECTION_SOURCE` 就是最终动作的选择依据（见 `ACTION_SELECTION_TRACE`）。

## PREFERENCE_SCORE_SOURCE（Q2、Q3）

**公式**（`betResponse.ts:2235-2239`，唯一实现）：

```text
normalizeEVScore(ev, checkEV, pot) = clamp01( 0.5 + 0.5 × (ev − checkEV) / pot )
```

**实测边界**（`scripts/audit-decision-basis-v1.ts` 尾部，pot=4875、checkEV=3711.5）：

| ΔEV | score |
| --- | --- |
| 0.1×pot | 0.550000 |
| 0.5×pot | 0.750000 |
| 1.0×pot（钳位边界） | **1.000000** |
| 1.5×pot / 3.0×pot | **1.000000 / 1.000000**（饱和 ⇒ 不同 EV 同分） |
| −0.5×pot | 0.250000 |
| −1.0×pot（下钳位） | 0.000000 |

⇒ 在 `ΔEV ∈ (−pot, +pot)` 内**严格单调递增**；`score > 0.5 ⟺ betEV > checkEV`（无 ε、无容差）。
CHECK 一侧固定为 `checkScore = 0.5`（`postflopAdvisor.ts:644`）—— 即「以过牌为 0.5 基准」。

**是否比较同一组合法动作（Q3）**：是。`postflopAdvisor.ts:631-640` 先**按合法金额去重**（同额只留第一份），
再在**同一份 `unique` 列表**上取 `best = argmax(score)`；`bestSize` / `bestAmount` / `bestScore` /
`preferredAction` 全部由这一次比较产生（`:666-671`，注释原文「动作建议完全由 EV 比较产生（不做任何硬编码）」）。

**Q4（筹码 / 底池 / 有效筹码 / 行动历史是否同源）**：同源。`betDecision.pot === math.pot`（实测 4875 = 4875），
`checkEV` 与各尺寸 EV 用同一 `pot`、同一权益引擎、同一行动历史；`§6` 的既有测试（RDC V1）已固定该等式。

**Q5（偏好分是否含 EV 之外的东西）**：分两种情况，**必须区分**：

| 路径 | 比较尺度 | 是否含 EV 之外的因素 |
| --- | --- | --- |
| **有下注决策模型**（`betDecision != null`） | `normalizeEVScore(ΔEV)` | **不含**。画像/动态只通过**响应概率**进入 EV（fold/call/raise 分支权重），不是附加惩罚。EV 与 score 排序**等价** |
| **无下注决策模型**（回落到价值守门器） | `gate.estimatedBetEVScore` / `estimatedCheckEVScore`；`ActionScoreKind.RAISE = roleStrength×0.8 + commitmentScore×0.2`；`FOLD = 1 − callScore`（`postflopAdvisor.ts:717-740`） | **含**策略/角色/承诺等启发式因素 ⇒ 但**标签如实写作 `PREFERENCE_SCORE`**，文案明说「内部评分，**不是 chip EV**」（`:170`） |

⇒ 授权要求「若存在策略调整后的评分，必须与原始 EV 分别标识」**已满足**：这些分数从不以 EV 名义出现。

## ACTION_SELECTION_TRACE（Q6、Q7）

真实链路（文件:行）：

```text
① 候选合法动作        legalActions.ts（deriveLegalActions / allInToAmount）
② 动作尺寸生成        postflopAdvisor.ts:596-626（尺寸网格 → 每个尺寸的响应树 EV）
③ 对手范围与行为概率   betResponse.ts:1980-2043（joint states；fold/call/raise 概率）
④ EV 计算             betResponse.ts:2194（Σ 概率×分支 EV）→ betDecision.sizes[].betEV
⑤ 偏好分数计算        postflopAdvisor.ts:613-615（score = normalizeEVScore(betEV, checkEV, pot)）
⑥ 最终动作选择        postflopAdvisor.ts:631-671（去重 → argmax(score) = bestSize / preferredAction）
                      decisionEngine.ts:2743-2763（modelWantsBet = bestSize≠null && bestScore > checkScore）
                      decisionEngine.ts:2806-2824（尺寸：bestSpec.kind==='ALL_IN' ⇒ 落 ALL_IN 候选，
                                              否则 pickClosestAggressive(desired)）
⑦ 动作规范化          decisionEngine.ts:3383-3408（consumesStackForAction；actionShape）
                      （RDC V1 起：打光筹码的 BET 在一致性校验与界面按「全下」语义归一）
⑧ 一致性校验          decisionConsistency.ts:292-460（自算依据 → 家族比较 → 违规列表）
⑨ 前端建议输出        decisionViewModel.ts:208-240（actionZh / sizeZh）、:832-850（下注决策模型表）
                      → alphaPipeline.ts:1146（toDecisionViewModel）
```

**Q6 答案**：无人下注节点由 **`postflopAdvisor` 的下注决策模型**（EV 表 + 归一化分）选出，
`decisionEngine` 只负责把它落到**合法候选**上（`bestSpec.kind === 'ALL_IN'` ⇒ 必须落 ALL_IN 候选，
代码注释记录了此前正因此处不一致而误报过 `ACTION_CONTRADICTS_PREFERENCE`）。

**Q7 答案**：一致性校验使用 **`postflopAdvice.scores`（同一份偏好分表，按家族取最大值）** 作为比较基准
（`decisionEngine.ts:3679-3682` → `decisionConsistency.ts:399-413`），**不是**用引擎自报的依据名去比。

## NORMALIZATION_BOUNDARY

| 场景 | 实测（栈深扫描，A♠K♠/NORMAL，pot=4875=97.5BB） |
| --- | --- |
| **C** BET = 全部剩余筹码 | 103BB：`sizes=[BET_SMALL@1625 S0.596, ALL_IN@2750 S0.619]`、`bestSize=ALL_IN`、`action=BET`、`sizeChips=2750=allInToAmount`、`consumesStack=true`、界面「建议：**全下**…（本注即全下）」 |
| **D** BET < 剩余筹码 | 300BB：`sizes=[BET_SMALL@1625 S0.596, BET_MEDIUM@3250 S0.583, BET_LARGE@4875 S0.555]`、`sizeChips=1625 < allIn=12600`、`consumesStack=false`、界面「建议：下注」 |
| **边界恰在金额** | 83BB：`BET_SMALL S0.596 > ALL_IN@1750 S0.594` ⇒ 选**小注**（`consumesStack=false`）；88BB 起全下分反超 ⇒ 选全下。**归一化看金额，不看标签** ✓ |
| **E** 同金额、不同标签 | **不会进入比较**：`droppedSizes` 明确记录封顶去重，例如 103BB 时 `BET_LARGE@4875→2750：封顶后与另一个候选金额相同（已去重）…`；53–163BB 共 24 个栈深中 **13 个**发生封顶去重，**0 个**出现同额两份；53BB 时只剩 `ALL_IN@250 cap=true heroIsAllIn=true` 一份 |

⇒ 「动作规范化前后不改变实际投入 / 底池 / 有效筹码」在本轮**再次核验**：RDC V1 变更仅影响
「家族比较」与「界面文案」，EV、金额、底池在修复前后逐位相同（前一轮报告已留对比）。

## CONSISTENCY_CHECK_BEHAVIOR（Q8 + 场景 A/B）

**A（最高 EV = 最高分）**：45 个节点全部命中 —— `agree = true` 45/45（0 不一致）。
典型：`ALL_IN@2750 EV4869.0 S0.619 > BET_SMALL@1625 EV4647.9 S0.596`。

**B（最高 EV ≠ 最高分）**：**实例搜索 0 命中**，与公式分析一致：
`score` 是 `ΔEV` 的**仿射严格单调**映射，故排序等价；唯一的例外是**钳位饱和**
（`ΔEV ≥ pot ⇒ score=1`；`ΔEV ≤ −pot ⇒ score=0`），此时两个不同 EV 得到同一分数，
`reduce` 保留**先出现者**（`unique` 按金额升序 ⇒ 金额较小者）。
实测搜索到的最大 `ΔEV/pot = 0.281`（AsKs/CALLING_STATION/103BB）—— 距 ±1.0 的钳位边界尚远，
因此 **B 在当前模型空间内不可达**；边界本身已由公式探针直接证明（上表 1.0×pot 与 3.0×pot 同为 1.000000）。

**Q8（两套机制给出不同排序时如何处理）**：软件**不做双轨比较** —— 只有一条选择链（上文 ⑥）。
若最终动作与「最高偏好家族」不符，**不静默、不自行调和**，而是由一致性守卫输出
`DECISION_CONSISTENCY_ERROR` 并置于警告首位 +「**不要据此行动**」（`decisionViewModel.ts:262-267`，RDC V1 `§9` 已实测）。
显式偏离机制（如 CB-5 打光筹码护栏）必须把偏离原因写进 `diagnostics`（`stackCommitmentGuard`），
**不覆盖也不伪造 EV**（上一轮已验收）。

**披露缺口（本轮新发现，非决策缺陷）**：弱牌局面下 `bestSize = BET_SMALL`（下注族最高分 0.369）
而 `preferredAction = CHECK`（过牌基准 0.5）⇒ 引擎 action = CHECK（正确）；
但 `decisionEngine.ts:3708-3715` 拼出的表尾是 **`最佳 = BET_SMALL`** ——
「最佳」指的是**下注族内最佳尺寸**，不是最终建议。使用者截图里「内部最高 EV 动作：ALL_IN」很可能就是这一行的读法
⇒ 存在**被误读为最终建议**的空间（实测三例：`QdJc`/`7c6c`/`5h5d` 全部 `bestSize=BET_SMALL` 而建议 CHECK）。

## PROFILE_EXPLOIT_INTERACTION（F、G）

**F（同局面、不同画像）**：实测同手同史、仅换快速画像（无观测历史）：

| 手牌 / 深度 | NORMAL | TIGHT | MANIAC |
| --- | --- | --- | --- |
| A♠K♠ / 103BB | checkEV 3711.5；ALL_IN 4869.0 | 3714.1；4704.0 | 3702.2；**4908.1** |
| T♠9♠ / 103BB | 3500.1；4459.7 | 3499.4；4290.2 | 3495.4；4505.4 |
| Q♦J♣ / 103BB | 1266.1；BET_SMALL −11.2 | 1263.6；−19.5 | 1249.3；−64.1 |

⇒ 画像确实改变**响应概率 → EV**（幅度约 0.3%～4%），并改变最佳尺寸的出现位置；
在观测空间内**未改变排序**（argmax 仍一致）。**画像不是加在 EV 上的惩罚项**，而是通过分支概率进入 ——
符合授权要求，不存在「加了画像权重仍当原始经济 EV 展示」的情形。

**G（样本不足）**：无观测历史时实测 `player = { source: null, confidence: 0.35, samples: 0 }`、
`range.confidence = 0.3`、`degradations = []` ⇒ 走**基础范围 + 低置信度**路线，动作照常给出，
不确定性通过**置信度 / 容差带 / 披露文本**表达，而不是偷偷改 EV 数值。

## MINIMAL_REPRODUCTION

```bash
node --experimental-strip-types scripts/audit-decision-basis-v1.ts   # 45 节点 + 公式边界 + 画像差分
node --experimental-strip-types scripts/audit-decision-basis-v2.ts   # 24 栈深 + 30 组合实例搜索 + 披露检查
```

装置（生产入口 `analyzeManualHand`，1BB=50 筹码）：9 人桌 · Hero BTN · 河牌 · 牌面 `Jh 8s Qs Kh Kd` ·
CO 溜入→BTN 加注 3→CO 补 2→翻牌/转牌 CO 过牌·BTN 下注·CO 跟→**河牌 CO 过牌**；
起始 103BB ⇒ `pot=4875（97.5BB）`、`stack=2750（55BB）`、`callCost=0`。

主局面完整轨迹（实测）：

```text
A♠K♠ 三条K｜NORMAL｜103BB ⇒ eq=0.7613 checkEV=3711.5
  sizes=[BET_SMALL@1625 EV4647.9 S0.596 | ALL_IN@2750 EV4869.0 S0.619]
  argmaxEV=ALL_IN argmaxScore=ALL_IN agree=true dup=null clampTie=null
  bestSize=ALL_IN preferredAction=ALL_IN ⇒ action=BET size=2750 consumesStack=true
  basis=ACTION_EV_COMPARISON（校验内部同局面判为 PREFERENCE_SCORE）consOk=true viol=[]
  vm=建议：全下｜下注 2750 筹码（55.0BB，本街累计；本注即全下）
```

## PROPOSED_FIX_IF_NEEDED

**结论：本轮未发现需要修复的「决策缺陷」**（无动作选择冲突、无重复计算、无 EV 口径混用）。
仅发现两项**披露层面**的改进点与一项**理论边界**，均**未实施**（等下一轮授权）：

| # | 问题 | 建议方案（最小） | 影响面 | 回归测试设计 |
| --- | --- | --- | --- | --- |
| P1 | 同一决策两个依据名（`ACTION_EV_COMPARISON` vs `PREFERENCE_SCORE`） | 让校验内部的依据推导与引擎同源：`ConsistencyInput` 增 `byBetDecisionModel`（或引擎把校验用到的依据显式传入），使两处对同一节点给出同一名字；**不改任何判据** | `decisionConsistency.ts` + `decisionEngine.ts`（约 10 行） | 节点矩阵（无下注/面对下注 × 有/无 betDecision）断言「引擎依据 == 校验依据」，且违规集合为空 |
| P2 | `最佳 = BET_SMALL` 可能被读成最终建议（而建议是 CHECK） | 文案改为「**下注族**最佳尺寸 = X」，并在同一行显式写出最终建议（如「最终建议 = 过牌」） | `decisionEngine.ts:3708-3715`（1 处字符串） | 断言：`preferredAction === 'CHECK'` 时文本不含歧义的「最佳 = <下注尺寸>」形式，且必含最终建议 |
| P3 | 钳位饱和时（`ΔEV ≥ pot`）多个尺寸同分，`reduce` 取先出现者（金额较小） | 同分时显式比较 `betEV` 取更高者（并列再按金额小者），并把「同分钳位」写进诊断 | `postflopAdvisor.ts:637-640`（1 个比较器） | 单测：构造两个 `score=1.0` 的尺寸（ΔEV 分别 1.2×pot、3×pot）⇒ 必须选 EV 更高者 |

优先级：**P1/P2 为披露一致性（低风险、纯文案/标注）；P3 为理论边界（实测最大 ΔEV/pot = 0.281，暂不可达）**。

## FINAL_VERDICT

| 授权问题 | 结论（实测） |
| --- | --- |
| 是否真实动作选择冲突 | ❌ **无**：45/45 节点 argmax(EV) == argmax(score)；`§四` A–G 中 A 全中、B **不可达**（仅钳位饱和理论可能，最大 ΔEV/pot=0.281，边界 1.0） |
| 是否只是动作名称不一致 | ✅ **是**（RDC V1 的 `BET` vs `ALL_IN` 家族命名）；本轮进一步确认**依据标签**也是命名差异（一处事实、两处标注） |
| 是否重复计算 / EV 口径混用 | ❌ 无重复：同额候选在比较前**去重**（24 栈深中 13 次封顶去重，`droppedSizes` 留痕）；45 节点 `evKinds` 全部单一 `SINGLE_OPPONENT_MODEL_EV`（本轮局面均为单挑，多人树未覆盖，见下） |
| 一致性校验是否用了正确基准 | ✅ 用**同一份偏好分表**（`postflopAdvice.scores`）作为基准；缺陷只在「家族命名」，RDC V1 已修 |
| 界面是否准确披露依据 | ⚠️ **基本准确但不一致**：`PREFERENCE_SCORE` 明说「不是 chip EV」✓；但同一决策两个依据名（P1）、`最佳 = <下注尺寸>` 易误读（P2） |
| 是否可用统一标签掩盖差异 | ❌ 不允许，且本轮**未做任何改动**；P1/P2 只让标注与事实一致，不改判据、不改 EV |

**特别回答：当前软件究竟是根据 EV 选择，还是根据偏好分数选择？**

> **有人下注/加注的节点**：按 **chip EV / 证据优先级**（`CHIP_EV`、`SUPPORTED_ACTION_PRIORITY`、
> `HEURISTIC_TIEBREAK`…）选择，并有 CB-5 等显式护栏。
> **无人下注（面对过牌）节点**：由**下注决策模型的动作 EV 比较**选择 —— 它使用的「偏好分」
> `clamp01(0.5 + 0.5ΔEV/pot)` 是**同一 EV 的保序重标度**（过牌固定 0.5），因此
> **「按偏好分选」与「按 EV 选」在当前实现里是同一件事**（45/45 节点排序一致，
> 仅在 `ΔEV ≥ pot` 的钳位饱和处可能出现同分并列，实测未出现）。
> **两者若不一致**：软件不做双轨调和，而是**如实报错**——`DECISION_CONSISTENCY_ERROR` +
> 「不要据此行动」置顶显示；显式偏离（如打光筹码护栏）必须带诊断字段。
> **现状的不足不是选择规则，而是标注**：同一次决策在引擎输出与一致性校验里各有一个依据名，
> 且下注族最高尺寸在文案里被写作「最佳」（P1/P2）。

**保护既有修复（§五）**：STREET STATE CONSISTENCY V2 的 12 项、RIVER DECISION CONSISTENCY V1 的 10 项
均在 `npm run verify` 全量套件内通过；本轮**未修改任何生产文件、未新增测试、未提交、未推送、未清理未跟踪文件**。
**覆盖局限（如实记录）**：本轮扫描局面均为单挑（CO vs BTN），**多人下注树（`multiway.totalEV`）未覆盖**；
`F` 仅覆盖「快速画像提示」而未注入真实观测历史序列。

**产出**：本报告 `reports/DECISION_BASIS_CONSISTENCY_V1.md`、探针
`scripts/audit-decision-basis-v1.ts` / `scripts/audit-decision-basis-v2.ts`（均未跟踪）、
`CURRENT_PROJECT_STATUS.md` §10.0.26（只读审计记录）。
