# 翻前决策路径 · 只读核查报告（PREFLOP DECISION PATH AUDIT · V1）

> **授权范围**：本轮为**只读核查**。用户指令原文：「先核查现有翻前决策路径，**不要直接修改加注策略**。」
> 本轮**未修改**任何产品代码、测试、参数或阈值；**未修改加注策略**；**未 `git add` / `git commit` / `git push`**。
> 新增的 4 个探针脚本（`scripts/preflop-path-audit{,2,3,4}.ts`）为**只读**工具，未注册进 `data/artifact-manifest.json`，可随时删除。
>
> 复核对象：`HEAD = 91c35e8`（工作树与 `origin/main` 一致、无已跟踪改动）。
> 核查方式：**生产入口** `analyzeManualHand` + `buildDecisionContext` 的实测输出（非阅读猜测），并与
> 「P1 修复前的检查点源码树」跑同一探针做**逐字节对照**。

---

## §一 复现方式（全部只读）

```powershell
cd 'D:\德州决策'
node --experimental-strip-types scripts/preflop-path-audit.ts   # 13 个翻前节点 · 全链路快照
node --experimental-strip-types scripts/preflop-path-audit2.ts  # 信息充分性 / 范围来源 / 完整理由文本
node --experimental-strip-types scripts/preflop-path-audit3.ts  # 全下保护判定 + 「只能全下」节点
node --experimental-strip-types scripts/preflop-path-audit4.ts  # 逐对手范围来源与可信度
```

固定条件：6 人桌 · 盲注 1/2（`bigBlindBB = 2`）· `equitySeed = 20260913` · `asOf = 1757000000000` ·
`budget = { softMs: 120000, hardMs: 240000 }`。全部节点**未另造牌局**（沿用 `scripts/test18-amount-matrix.ts`
一脉的行动记录写法：`RAISE` 的 `amountBB` = **加注到的本街总额**，`CALL` 的 `amountBB` = **本次补入**）。

**P1 对照的控制条件**（保证「逐字节差异」只可能来自 P1 修复）：

| 项 | 值 |
|---|---|
| 检查点 | `%TEMP%\dezhou-checkpoint-p1fix-20260920-102512` |
| 检查点与工作树**内容不同**的文件 | 仅 `src/app/decision/decisionEngine.ts` 与 `data/artifact-manifest.json`（全树 sha256 逐文件比对，其余 0 个差异、0 个仅检查点存在） |
| `decisionEngine.ts` sha256 | 检查点 `3F11164C…AC4C` ｜ 工作树 `552EB273…1BC04` |

---

## §二 翻前决策链全景（层 → 代码位置 → 翻前实际取值）

| # | 层 | 代码位置 | 翻前**实际**行为 |
|---|---|---|---|
| 1 | 合法动作 | `src/app/manualInput/legalActions.ts`（`deriveLegalActions`） | `FOLD/CALL/RAISE/ALL_IN`；`minRaiseTo = currentBet + (currentBet − 我已投入)`；`allInTo = 我的本街已投入 + 剩余筹码` |
| 2 | 尺寸网格 | `legalActions.ts:252-341` | 加注档基准轴 = **跟注额 `toCall` 的倍数** `[2,2.5,3,4,5,6,8]`（`:276`），**仅当 `toCall > 0` 才铺档**（`:311`）；再无条件并入 `minTo` 与 `allInTo`（`:319`） |
| 3 | 「谁进池了」 | `src/domain/poker/gameState.ts:301-314` + `contextBuilder.ts:3419-3421` | `realizedOpponentIds` 判据：**盲注/前注不算**（`:291`）、行动过（含 CHECK）算、全下一定算 ⇒ `realizedOpponents` |
| 4 | 逐对手范围 | `contextBuilder.ts:3730-3751` | **只对 `realizedOpponents` 建范围**（`allRangeBuilds`）；`usableRangeBuilds = 范围非 null 的那些`（`:3754`） |
| 5 | 展示用范围 | `contextBuilder.ts:3756-3772` | `primaryOpponent = realizedOpponents[0] ?? opponents[0]` ⇒ **无人入池时也会**为「盲注位」建一份先验范围（仅供展示/画像） |
| 6 | 权益 | `contextBuilder.ts:2486-2505` | `opponentRanges.length === 0` ⇒ **直接返回 `null`** 并给出警告「没有任何**已实现**的对手范围…（还没人进池）」；否则**多人口径**蒙特卡洛（≤2 家 20000 次，`:2514`） |
| 7 | 赔率口径 | `contextBuilder.ts:497/536-537/629` | `winnable = pot + callCost`；`potOdds = callCost / winnable = requiredEquity` |
| 8 | CALL EV | `contextBuilder.ts:585-619` | `callEV = (EqVsBetRange ?? heroEquity) × winnable − callCost`；翻前 `postflopFacts === undefined`（`:4500-4502`）⇒ `EqVsBetRange ≡ null` |
| 9 | 起手牌档 | `contextBuilder.ts:602/646-648` + `decisionEngine.ts:246-270` | `handRankZh = "起手牌：<标签>（翻牌前评估，非成手牌力）"`；**`handCategory ≡ 0`**（`:648 described?.category ?? 0`，翻前 `described = null`） |
| 10 | 风险判断 | `decisionEngine.ts:1687/1758-1769` | `edge = heroEquity − requiredEquity`；P1 后 `verdictEdge = singleLayerEdge = callEV / winnable` |
| 11 | 决策分支 | `decisionEngine.ts:2650-2773`（场景 2 无人下注）｜ 场景 1（面对下注） | 场景 2 的**下注资格** = `legacyHasInitiativeValue`（`equity > 0.5 + 0.05`，`:2667-2668`）⇒ **`shouldRaise`/证据优先级在该分支完全不参与** |
| 12 | 加注选择 | `decisionEngine.ts:1959-1981` | 目标额 `desiredTo = pot + 2×callCost`；跛入池则改用 `preflopIso.isoSize.legalIsoSize`（`:1968-1972`） |
| 13 | 加注 EV | `decisionEngine.ts:1979-2050` | `isoUsable`（跛入池隔离模型且**尺寸逐位相同**）；`raiseModelUsable`（U1 响应模型）**翻前恒为 false**（依赖 `postflopFacts.raiseResponse`，`:1989`） |
| 14 | 加注准入 | `decisionEngine.ts:996-1041`（`shouldRaise`） | `qualifies`（tier/edge）→ 类别 <3 时：① `consumesStack && !hasOwnEV` ⇒ **拒**；② `toAmount/pot > 2.5` ⇒ 拒 |
| 15 | 全下保护 | `decisionEngine.ts:891/952-982/2189-2242` | `onePairAllInBlocked ⇔ 打光 ∧ handCategory<3 ∧ 无自有 EV`；`commitmentException` 翻前恒 false（`advice === null`，`:2129-2138`） |
| 16 | 证据裁决 | `src/domain/decision/evidencePriority.ts:259-529` | ③ 无量化证据 ⇒ 启发式；②-a 有清晰 CALL 证据但带 `overrideJustification` **且不消耗筹码** ⇒ 允许覆盖（`:400-418`）；②-b 只到 MARGINAL ⇒ `HEURISTIC_TIEBREAK`（`:465-486`） |
| 17 | 分类/置信度 | `decisionEngine.ts:2937-2948` | `confidence < 0.55 ⇒ MARGINAL`（无论数学多清晰） |
| 18 | 展示 | `src/viewmodels/decisionViewModel.ts:1179-1180` | 首屏 = `reasons.slice(0,3)`，展开 = 全部；`allInGuard` **不在展示层**（全仓 grep：仅 `decision.types.ts:1287-1307` 的类型与引擎内部） |

### 翻前各动作的**可达性**（由 §三 实测得出）

| 动作 | 翻前可达？ | 依据 |
|---|---|---|
| FOLD | ✅ | ③⑪⑬ 等 |
| CALL（含「跟注即全下」） | ✅ | ③⑦ B C F |
| CHECK（大盲/溜入后） | ✅ | ⑥ |
| RAISE（**非**全下，启发式） | ✅ 需过 `shouldRaise` | ③（未过→跟注）/④⑦⑬（过→加注） |
| RAISE = 全下（短码推注 / 4bet 全下） | ❌ **结构性禁止** | B（5BB：唯一加注=全下 ⇒ 被「一对牌全下」保护拒绝 ⇒ 只能跟注 4、身后留 2BB） |
| 开池（作为**首个**入池者） | ❌ **无建议** | ①②⑧⑨⑩ A（`action = null`、`INSUFFICIENT_INFORMATION`） |

---

## §三 实测节点与结果（18 个节点）

### 3.1 无人入池（开池）——**一律无建议**

| 节点 | 牌 | `heroEquity` | `callEV` | 动作 | 分类 | 置信度 |
|---|---|---|---|---|---|---|
| ① BTN 无人入池 | A♠A♥ | `null` | `null` | **`null`** | `INSUFFICIENT_INFORMATION` | 0 |
| ② CO 无人入池 | K♠K♥ | `null` | `null` | **`null`** | 同上 | 0 |
| ⑧ BTN 20BB 无人入池 | A♠A♥ | `null` | `null` | **`null`** | 同上 | 0 |
| ⑨ BTN 无人入池 | J♠T♠（同花连张） | `null` | `null` | **`null`** | 同上 | 0 |
| ⑩ BTN 无人入池 | A♠5♠（A 带小脚同花） | `null` | `null` | **`null`** | 同上 | 0 |
| A BTN 无人入池 + 对手带**完整 MANIAC 实测统计** | A♠A♥ | `null` | `null` | **`null`** | 同上 | 0 |

① 的原始数据：`pot = 3`、`callCost = 2`、`winnable = 5`、`requiredEquity = 40%`；
`context.range`（展示用）= **小盲位的「无人加注时的宽范围」**，`sourceKind = HEURISTIC`、`confidence = 0.3`、`supportSize = 1225`；
但 `context.opponentRanges = 0 条` ⇒ 权益拒绝计算。
A 节点证明这与画像无关：**给 BB 挂上 800 手 VPIP48/PFR35/3Bet16 的实测统计，结论逐字不变**。

### 3.2 面对下注（CALL/FOLD/RAISE 三分支）

| 节点 | 局面 | `heroEquity` | `callEV` | 候选加注 EV | 动作 | 来源 |
|---|---|---|---|---|---|---|
| ③ BB AKo | 面对 BTN 开池 3BB | 63.06% | **+4.197475** | 全部 `null` | `CALL 4` | `SUPPORTED_ACTION_PRIORITY`（`PROXY_EV`，`CLEAR_CALL_OVER_FOLD`，带 ±0.65） |
| ④ BTN AA | 面对 BB 3bet 至 10BB | 83.61% | **+20.278050** | 全部 `null` | **`RAISE 56`** | `STRATEGIC_HEURISTIC`（`CALL_CLEAR_CALL_OVER_FOLD_OVERRIDDEN`） |
| ⑬ BTN AA | 面对 BB 3bet 至 12BB（limper 已弃） | — | **+26.638550** | 全部 `null` | **`RAISE 64`** | 同上（`MONSTER_STRENGTH_DOMINANCE`） |
| ⑦ BB AA，10BB | 面对 BTN 开池 | 84.20% | +6.945675 | 全部 `null` | **`RAISE 16`**（8BB；`allInTo = 20`） | 同上 |
| **B BB AA，5BB** | 面对 BTN 开池；`minRaiseTo = allInTo = 10` | 84.20% | +6.945675 | 全下（唯一加注） | **`CALL 4`**（身后剩 4 筹码） | `SUPPORTED_ACTION_PRIORITY` |
| C BB 72o，5BB | 同上（对照组） | 30.02% | −0.0974 | 全下 | `FOLD` | — |
| F BB AA，3BB | `minRaiseTo(10) > allInTo(6)` ⇒ 合法动作只有 `FOLD/CALL` | 84.20% | +6.945675 | — | `CALL 4`（= 全部剩余） | `SUPPORTED_ACTION_PRIORITY` |

⑦ 的加注尺寸来源：`desiredTo = pot + 2×callCost = 9 + 8 = 17` ⇒ `pickClosestRaise` 取 **16**（非全下）
⇒ `consumesStack = false` ⇒ 避开「全下保护」；若候选落到 20（= 全下）则该保护会直接拒绝它（见 §四 F2）。

### 3.3 跛入池

| 节点 | 局面 | 关键事实 | 动作 |
|---|---|---|---|
| ⑤ BTN AKo（1 limper） | `pot 5 / callCost 2 / winnable 7` | **`raiseSizesWithOwnEV = [10]`、`hasOwnEV = true`**；RAISE 证据 `INDEPENDENT_STRATEGIC_EVIDENCE` **EV = +3.444619755885** > CALL +2.522175 | **`RAISE 10`**（5BB）✅ 唯一「按 EV 正面比出来的加注」 |
| ⑥ BB AKo（2 limper，`callCost = 0`） | `pot 7 / toCall = 0` | 加注候选**只有 `RAISE 4` 与 `RAISE 200`**；`callEV = null`；`heroEquity = 47.61%` | **`CHECK`**（`STRATEGIC_CHECK`：「估计权益 47.6% 不足以支撑主动下注取值」） |

### 3.4 场景构造对照

⑫（`[UTG F, HJ CALL 1, CO F, BTN RAISE 4, SB F, BB RAISE 12]`）被引擎如实拒绝：
`DECISION_POINT_NOT_AVAILABLE — 现在应该轮到「劫持位」`。这是**探针的场景写错**（漏了跛入者的第二次行动），
**不是引擎缺陷**；已补 ⑬（跛入者弃牌后）覆盖同型节点。

---

## §四 发现（按严重度排序；**本轮一律不改**）

### 🔴 F1（P0 · 功能缺口）翻前开池节点**完全不给建议**，且与画像无关

- **实测**：①②⑧⑨⑩A —— `heroEquity = null` ⇒ `callEV = null` ⇒ `actionable = false`、`action = null`、
  `classification = INSUFFICIENT_INFORMATION`、`confidence = 0`。
- **根因链**（唯一判据，**不是**缺少数据）：
  1. `gameState.ts:301-314` `realizedOpponentIds`：**盲注/前注不算已实现**（注释 `:291-292` 的动机是
     「把大盲算作已实现，9 人桌的开池就会凭空变成 2 人池」）；
  2. `contextBuilder.ts:3419-3421` `realizedOpponents = opponents.filter(realizedIds.has)`；
  3. `contextBuilder.ts:3730-3754` `allRangeBuilds` **只遍历 `realizedOpponents`** ⇒ `usableRangeBuilds = []`；
  4. `contextBuilder.ts:2494-2500` `computeHeroEquity` 见 `opponentRanges.length === 0` ⇒ 返回 `null` + 该警告；
  5. `decisionEngine.ts:565-569` / `EQUITY_NOT_COMPUTABLE` 分支 ⇒ 判信息不足。
- **反证（关键）**：**建范围的能力是有的，只差没接上** —— `contextBuilder.ts:3756-3772` 的 fallback 分支
  在「零个已实现对手」时**照样**为 `opponents[0]`（盲注位）建出了一份先验范围
  （实测 `supportSize = 1225`、`share = 0.9238`、文案「无人加注时的宽范围」），只是**没有进 `opponentRanges`**。
- **影响**：翻前**最常用**的决策（首个入池：开池/偷盲/前位弃牌）**没有任何建议**；工具在这类节点上等价于不可用。
  用户会看到「无法计算权益（还没人进池）」。`tablePreview` 会**提前**提示（`gameState.ts:282` 注释），因此不是静默失败。
- **可能的最小修复方向（需授权，本轮不动）**：把「尚未说话的盲注位先验范围」按同一 `buildRangeSnapshot`
  纳入权益计算，并在输出中显式标注「含 N 家**强制投入但尚未行动**的范围（先验，非实测）」；
  或退一步：至少在开池节点给出**结构性建议**并如实标注「无对手范围证据」。**两条都改变翻前行为，必须先获授权。**

### 🔴 F2（P0 · 行为缺陷）「一对牌全下保护」在翻前**拦下所有全下加注**，包括 AA

- **实测 B**（BB 5BB，持 A♠A♥，面对 BTN 开池 3BB）：

  ```text
  legal.actions = [FOLD, CALL, RAISE, ALL_IN]   minRaiseTo = 10   allInTo = 10   callCost = 4   剩余 8
  候选 = [FOLD 0, CALL 4 (+6.945675), RAISE 10 (EV=null)]
  allInGuard = { handCategory: 0, consumesStack: true, hasOwnEV: false,
                 onePairAllInBlocked: true, raiseToPotRatio: 1.111, spr: 0.444 }
  noteZh = 「🔴 命中「一对牌全下」保护：牌力类别 0 < 3、加注 = 打光筹码、且这次加注**没有自己的 EV**，
            不得仅凭「CALL EV / 低 SPR / 牌力类别」升级成全下」
  最终动作 = CALL 4（身后剩 4 筹码 = 2BB）
  ```

- **机理**（三处常数叠加，每处单独看都对）：
  - `contextBuilder.ts:648`：翻前 `handCategory ≡ 0`（`described?.category ?? 0`，翻前无成手）——
    `decisionEngine.ts:218-223` **自己就记载了这个事实**，但它是为「牌力分档」写的，**没有为全下保护写例外**；
  - `decisionEngine.ts:891` `MIN_CATEGORY_FOR_LARGE_RAISE = 3`（注释针对**河牌**一对牌打光）；
  - `decisionEngine.ts:1035` `consumesStack === true && hasOwnEV !== true ⇒ return false`，而
    `hasOwnEV = raiseModelUsable || isoUsable`（`:2174`）；`raiseModelUsable` 依赖
    `postflopFacts.raiseResponse`，**翻前该事实包不存在**（`contextBuilder.ts:4500-4502`）
    ⇒ 翻前 `hasOwnEV` 只在「跛入池 + 隔离模型尺寸恰好等于全下额」时为真。
- **结论**：翻前的全下加注**只有一条路径可达**：跛入池里隔离模型给出的尺寸恰好等于全下额（且 ≤2.5×底池）。
  短码推注、4bet 全下**结构性不可达**。
- **7 的对照**：10BB 节点**看起来**还行（`RAISE 16`），但那是因为 `desiredTo = 17` 恰好选中了
  **非全下**的 16 —— 是**尺寸网格意外绕开了规则**，不是设计意图。同一手牌在 5BB 时规则就露出来了（B）。
- ⚠️ 该保护在**河牌**的设计意图（`decisionEngine.ts:894-923`）完全正当；问题只在
  `handCategory` 在翻前**恒等于 0** ⇒ 保护范围从「一对牌」意外扩大成「翻前所有牌」。

### 🔴 F3（P1 · 披露缺口）全下保护**没有进入用户可见输出**，且把「被规则拒绝」说成「没算过 EV」

- `allInGuard` / `onePairAllInBlocked` 只在 `diagnostics`（类型见 `decision.types.ts:1287-1307`）；
  `src/viewmodels/decisionViewModel.ts` **不引用**它；`decision.reasons` 里也**没有任何**对应条目
  （全仓 grep「ONE_PAIR / ALL_IN_BLOCKED / 一对牌全下」：命中仅引擎内部与测试）。
- B 节点的**首屏三条**理由是：

  ```text
  1. [MATH_CALL_SUPPORTED]     整体范围权益 84.2% 高于跟注所需 30.8%：跟注 EV = 6.95 筹码 …（本句只比较 CALL vs FOLD）
  2. [CALL_PROXY_EV_POSITIVE]  CALL：PROXY_EV 6.95 筹码，决策边际 CLEAR_CALL_OVER_FOLD（容差带 ±0.65）…
  3. [RAISE_STRATEGIC_CANDIDATE] RAISE（5.0BB）：合法候选，来源 = STRATEGIC_CANDIDATE，EV = NOT_AVAILABLE（…）
  ```

  第 3 条把「**被一条规则明确拒绝**」表述成了「**合法但没算 EV**」（`decisionEngine.ts:2497-2511` 的三个分支里
  **没有**「被守门器/保护拒绝」这一支）。使用者无法知道：全下不是「没算」，而是「被拒」。
- 这与本项目自己的披露纪律相悖 —— 同一份代码在 `:2487-2496` 专门写明了「『算过但更低』与『没算过』是两件事，不能共用一句话」。

### 🟠 F4（P1 · 呈现自相矛盾）启发式覆盖清晰 CALL 证据时，首屏同时出现「跟注 EV 更高」与「建议加注」

- ④（BTN AA 面对 3bet）实测：
  - `decisionSource`：`kind = STRATEGIC_HEURISTIC`、`evidenceScope = CALL_CLEAR_CALL_OVER_FOLD_OVERRIDDEN`、
    `overrideJustification.kind = MONSTER_STRENGTH_DOMINANCE`。这是 `evidencePriority.ts:400-418` 的**合法分支**
    （要求「不消耗筹码」）⇒ 覆盖本身**是设计允许的**；
  - 首屏第 1 条理由：`[MATH_CALL_SUPPORTED] …跟注 EV = 20.28 筹码 …**跟注 EV 更高**（本句只比较 CALL vs FOLD）`；
  - 首屏第 2 条理由：`[STRATEGIC_RAISE_FOR_VALUE] …支持主动加注做大底池⚠️ 加注的 EV 无法计算 …⇒ 依据来源 = **STRATEGIC_HEURISTIC**（无任何量化 EV 证据）`；
  - 首屏动作：**建议：加注**（`sizeZh = 加注至 56 筹码（28.0BB，本街累计）｜本次再投入 50 筹码（25.0BB）`）。
- 两处具体不准确：
  1. 「**（无任何量化 EV 证据）**」（`decisionEngine.ts:2438-2441` 的三元分支）在本节点**不成立** ——
     存在 `CALL PROXY_EV +20.28` 且边际清晰，只是被覆盖；而引擎**手里就有**能区分两者的字段
     （`evidenceScope` / `overrideJustification`）。同一个 `STRATEGIC_HEURISTIC` 把「③ 真的什么都没有」
     （`evidencePriority.ts:505-521`，`scope = HEURISTIC_ONLY`）与「②-a 有清晰证据但被覆盖」共用一句话。
  2. 展开后的第 6 条 `[MATH_DOMINANCE]` 写着「**跟注** 在**可比较 EV 的动作**里明显占优（EV 差 20.28 筹码 …）」——
     与「建议：加注」并排出现，而 `decisionSource.noteZh` 里那句正确的解释
     （「…⇒ 允许战略启发式覆盖（来源 STRATEGIC_HEURISTIC；**不是 EV 优胜，不得如此呈现**）」）**只存在于诊断**。
- 说明：数学上不矛盾（`MATH_DOMINANCE` 的作用域是「可比较 EV 的动作」，而加注没有 EV 不在此列）；
  但**呈现上**使用者读到的是一条说「跟注更高」、一条说「加注」，没有任何一句解释为何允许让位。
  修改文案**不改加注策略本身**，但仍属产品文件改动 ⇒ 需授权。

### 🟠 F5（P1 · 决策质量）跛入池里大盲的加注菜单塌缩成「最小加注 / 全下」两档

- 实测 ⑥（BB AKo，2 limper）：`legal = [FOLD, CHECK, RAISE, ALL_IN]`，**加注候选只有 `RAISE 4` 与 `RAISE 200`**。
- 机理：`legalActions.ts:311-315` 只在 `toCall > 0` 时铺倍数档；大盲面对跛入池时
  `toCall = currentBet(2) − 我已投入(2) = 0` ⇒ 档位为空 ⇒ 只剩 `:319` 无条件加入的 `minTo` 与 `maxTo`。
  同时 `desiredTo = pot + 2×callCost = pot + 0`（`decisionEngine.ts:1959`）⇒ 目标 ≈ 底池（7 筹码），
  而档位只有 4 与 200（`pickClosestRaise` 只能取 4）。
- 该节点还走「场景 2（无人下注）」：下注资格 = `equity > 0.55`（`:2667-2668`）；
  AKo 对两家跛入 = 47.61% ⇒ **CHECK**。`shouldRaise` 与证据优先级在此节点**完全不参与**。
- 影响：大盲面对跛入池拿到 AKo 只能「过牌」（或最小加注/全下），
  使用者拿不到 5–8BB 这种正常的隔离尺寸。**是否改由用户决定**；本轮只报告。

### 🟡 F6（P2 · 起手牌档位的两处实现分歧 + 一个死字段）

- `contextBuilder.ts:668-698` `preflopStrengthOf` 同时给出 `tier`（`PREMIUM/STRONG/PLAYABLE/SPECULATIVE/WEAK`）
  与 `labelZh`；实测**全仓只有 `labelZh` 被读取**（`:646`），`tier` 是**死字段**。
- 决策层 `decisionEngine.ts:254-261` 用**字符串匹配**重新分档，两处已经出现分歧：

  | 标签 | `preflopStrengthOf` 的 `tier` | `handStrengthTier` | 能否通过 `qualifies`（需 MONSTER/STRONG） |
  |---|---|---|---|
  | 大对子 / AK/AQ 同花 | PREMIUM | MONSTER | ✅ |
  | 中对子 / AK/AQ / A 带大脚 / 两张大牌（同花） | STRONG | STRONG | ✅ |
  | 小对子 / 最小对子 / 同花连张 / 同花高张 | PLAYABLE / SPECULATIVE | MEDIUM | ❌ |
  | **A 带小脚同花**（如 A5s） | **PLAYABLE** | **WEAK** | ❌ |
  | **单张大牌**（如 Kx） | **PLAYABLE** | **WEAK** | ❌ |

- 影响：翻前加注资格只发给「大对子 / AK-AQ / 88+ / A 带大脚 / 两张大牌」；
  **JTs、A5s、Kx 这类标准偷盲/隔离牌永远不能主动加注**。这是**结构性窄**，不是数据问题。
  `tier` 字段与 `handStrengthTier` 的两份口径，正是本项目反复踩过的「两处口径」形态。
- 另：`commitmentException` 在翻前**恒为 false**（`decisionEngine.ts:2129-2138`，`advice === null`；
  实测 ⑦ `spr = 1.556`、B `spr = 0.444` 均为 `commitmentException: false`）⇒ 低 SPR 例外在翻前不生效。

### 🟡 F7（P2 · 口径/文案）翻前所有可执行决策的置信度恒为 0.3、分类恒为 MARGINAL

- 实测 ③④⑤⑥⑦⑬ 全部 `confidence = 0.3000`、`classification = MARGINAL`（`band = MEDIUM_LOW`）。
- 原因是**可解释的**：翻前唯一的范围来源是启发式先验（`sourceKind = HEURISTIC`、`confidence = 0.3`），
  而 `classifyOf` 要求 `confidence ≥ CLEAR_MIN_CONFIDENCE = 0.55` 才允许标「明确决策」
  （`decisionEngine.ts:2937-2948`，动机见 `:2917-2936` 的红队 F-04 修复）。
- **这不是缺陷**（诚实优先），但使用者会看到「建议 + 中低置信度 + 边缘」在翻前**恒定**出现；
  而 `decisionMargin.kind = CLEAR_CALL_OVER_FOLD`（数学清晰）与 `classification = MARGINAL`（数据不可信）
  同时出现**是刻意的**，两句话量的不是同一件事（前者=数学分离度，后者=可信度）。
- 提示：若走 `gtoRanges`（`webServer.ts:814-819` 的预取注入、`alphaPipeline.ts:1099-1100`）则范围来源不再是
  0.3 先验，本条结论**只对「启发式先验」路径成立**。

### 🟡 F8（P3 · 文案归属错误）隔离加注的 EV 被写成「面对加注的响应模型」

- ⑤ 实测 `raiseSizesWithOwnEV = [10]`（来自**隔离模型** `ISO_RAISE_MODEL_EV`），
  但 `decisionEngine.ts:3416-3419` 的 `RAISE_EV_NOT_IMPLEMENTED`（「部分」变体）会写成
  「加注：10 有模型 EV（**面对加注的响应模型**）」⇒ 把隔离模型算的 EV 归给了 U1 响应模型。
- 影响：只是归属描述错误（数值、动作、来源均正确），属披露精度问题。

### 🟢 P-1（正面结论）跛入池隔离加注是**唯一**按 EV 正面比较选出的翻前加注

- ⑤：`CALL +2.522175` vs `RAISE 10 = +3.444619755885`（证据类型 `INDEPENDENT_STRATEGIC_EVIDENCE`）
  ⇒ `RAISE 10`，`margin.scope = CROSS_ACTION`（跨动作比较**已做**），`decisionSource` 明确标注
  「该动作自有模型给出的代理 EV，已在同一零点与其他动作正面比较」⇒ 决策来源诚实。
- ⑤ 同时如实前置 `preflopIso` 的使用范围（「limp-call 条件范围」「权益实现因子 = 1（翻前不套用翻后实现模型）」）
  与不确定性（`confidence = 0.35`）。**这条通道是本轮核查里质量最高的翻前路径。**

---

## §五 P1（CALL/FOLD 标尺）修复与翻前的关系：**代数恒等 + 逐字节零影响**

**代数**（`heroEquityVsBetRange ≡ null` 时）：

```text
contextBuilder:585  callEV = heroEquity × winnable − callCost
contextBuilder:536  requiredEquity = potOdds = callCost / winnable
decisionEngine:1687 edge = heroEquity − requiredEquity
decisionEngine:1765 singleLayerEdge（P1 新标尺）= callEV / winnable = heroEquity − callCost / winnable = edge  ∎
```

**实测**（全部 8 个「CALL EV 存在」的节点：探针① 6 个 + 探针②/③ 2 个；新标尺 vs 旧标尺之差 ≤ 1 ulp）：

```text
[标尺对照] 新（P1）callEV/winnable = 0.322882692307692 ｜ 旧 edge = E−requiredEquity = 0.322882692307692  ⇒ 差 0.000000000000000056
[标尺对照] 新（P1）callEV/winnable = 0.494586585365854 ｜ 旧 edge = E−requiredEquity = 0.494586585365854  ⇒ 差 0.000000000000000056
[标尺对照] 新（P1）callEV/winnable = 0.522324509803921 ｜ 旧 edge = E−requiredEquity = 0.522324509803922  ⇒ 差 0.000000000000000111
…（其余 13 个节点差 0 或 1 ulp）
```

**逐字节**：同一探针在「P1 修复前检查点树」与当前工作树上分别运行 13 个翻前节点，
输出**逐行完全相同**（`sha256 = B4C2F133098D7A6087FBF304733DCCF168DFB63232FAC09AACCE2ECE0D39EB8C` 两边一致）：
动作、`callEV`、候选构成、`decisionMargin`、`decisionSource`、`evidence`、`allInGuard`、`reasons`、
`consistency`、`warnings`、`vm` **全部一致**。

⇒ **P1 的 125 局面扫描里「15 个节点 FOLD→CALL」的爆炸半径，在翻前路径上是 0**（翻前没有 `下注范围` 权益可用，
两把标尺必然重合）。这条结论同时解释了 P1 报告里「其余 110 个局面 bit-identical」的原因。

**本轮未改加注策略**：`shouldRaise`、`RAISE_EDGE_*`、`MAX_RAISE_TO_POT_RATIO`、`MIN_CATEGORY_FOR_LARGE_RAISE`、
`isoRaiseSizeOf`、`desiredTo` 公式、尺寸网格倍数档 `[2,2.5,3,4,5,6,8]` **一字未动**。

---

## §六 墨菲定律对照（翻前专项）

| # | 可能出错的事 | 本轮是否发生 | 证据 |
|---|---|---|---|
| M1 | 我把「没算过 EV」与「算过但更低」混为一谈 | ⚠️ **产品里有（F3）** | B：`RAISE_STRATEGIC_CANDIDATE` 说「合法候选…EV = NOT_AVAILABLE」，实为被保护拒绝 |
| M2 | 探针自己算错，得出「引擎有 bug」的假结论 | ✅ **本轮发生过 2 次，均已修** | ① `built.range` 路径写错（真字段是 `built.context.range`）；② 标尺对照把 `requiredEquity` 减了两次，虚报「30.77pp 标尺漂移」。两处都在报告里保留了修正说明 |
| M3 | 拿修复前的树当对照，却没验证「只有目标文件不同」 | ✅ 已控制 | 全树 sha256 逐文件比对：仅 `decisionEngine.ts` + `artifact-manifest.json` 不同 |
| M4 | 用「看起来合理」的牌局构造掩盖真实行为 | ✅ 已避免 | 18 个节点全部经生产入口实跑；⑫ 的构造错误被引擎如实拒绝并记录在案 |
| M5 | 把「工程容差带」当成可以翻转动作的统计误差 | ✅ 未发生 | C：`callEV −0.0974`（在 ±0.65 带内）仍判 FOLD，且文案写明「那是工程容差，不改变 EV 排名」 |
| M6 | 以「无建议」当作安全默认，掩盖工具在常见局面不可用 | ⚠️ **用户可见（F1）** | ①②⑧⑨⑩A 全部 `action = null` |
| M7 | 为修 A 而破坏 B（例如为开池补权益而让全下保护失效） | ⏸ 本轮未修，风险已标注 | F1/F2 的候选修法都会**改变翻前行为**，必须单独授权 + 独立回归 |
| M8 | 只读轮次偷偷改了产品文件 | ✅ 未发生 | 本轮**零**产品/测试文件改动；`npm run verify` = exit 0、**2,051/2,051 通过**、137 套件、manifest 未改 |
| M9 | 用「注释写了」代替「实测如此」 | ✅ 全部实测 | 例如 `handCategory ≡ 0`、`commitmentException ≡ false`、`opponentRanges = 0` 都有节点数据 |

---

## §七 未决事项（**全部需要用户授权才能动**）

| # | 事项 | 会改变翻前行为？ | 风险 |
|---|---|---|---|
| U1 | F1 开池无建议：把「强制投入但未行动」的盲注先验范围接入权益（并显式标注） | **会**（新增一大类可执行建议） | 高 —— 需重新定义「已实现」的边界与披露文案，并覆盖 `tablePreview` 的「会/不会信息不足」提示一致性 |
| U2 | F2 翻前全下不可达：给「一对牌全下保护」加翻前例外（例如 `street !== PREFLOP` 时不以 `handCategory` 为判据），或要求翻前全下必须有自有 EV 之外的独立论证 | **会**（短码推注从不可达变可达） | 高 —— 直接触及「不得永久禁止全下」与「不得凭牌力类别打光」两条纪律的边界 |
| U3 | F3 全下保护披露：为「被保护拒绝」新增可见理由码（文案层） | 否（只加披露） | 低，但会改变首屏三条理由的排序，需重跑展示层测试 |
| U4 | F4 覆盖文案：「（无任何量化 EV 证据）」按 `evidenceScope` 分成两句 | 否 | 低 |
| U5 | F5 跛入池大盲加注菜单（`toCall = 0` 时不铺档） | **会**（新增中间尺寸候选） | 中 —— 会改候选集合 ⇒ 可能改动作 |
| U6 | F6 `preflopStrengthOf.tier` 与 `handStrengthTier` 合并为单一事实来源 | 可能（若合并后 A5s/Kx 升档） | 中 —— 若只是消除死字段则零行为变化 |
| U7 | F8 隔离加注 EV 的归属文案 | 否 | 极低 |
| U8 | 是否把本轮报告 / 4 个探针脚本登记进 `data/artifact-manifest.json` 并提交 | 否 | 需授权（本轮**未** `git add`） |

**建议的下一步（按性价比）**：先做 U3 + U4 + U7（纯披露/文案，零行为风险，直接消除「界面自相矛盾」），
再单独授权 U2（翻前全下的结构性缺陷是本轮发现里唯一的**行为级** P0），最后再评估 U1（范围口径变更，面最大）。

---

## §八 机器可读验收块

```text
AUDIT_ID                      = PREFLOP_DECISION_PATH_AUDIT_V1
MODE                          = READ_ONLY
AUTHORIZED_SCOPE              = 核查翻前决策路径；不得修改加注策略
PRODUCT_FILES_MODIFIED        = 0
TEST_FILES_MODIFIED           = 0
PARAMS_THRESHOLDS_MODIFIED    = 0
RAISE_STRATEGY_MODIFIED       = NO   (shouldRaise / RAISE_EDGE_* / MAX_RAISE_TO_POT_RATIO /
                                      MIN_CATEGORY_FOR_LARGE_RAISE / isoRaiseSizeOf / desiredTo /
                                      RAISE_MULTIPLES 全部未动)
GIT_ADD / COMMIT / PUSH       = NONE
NEW_UNTRACKED_PROBES          = scripts/preflop-path-audit.ts, preflop-path-audit2.ts,
                                preflop-path-audit3.ts, preflop-path-audit4.ts
MANIFEST_REGISTERED           = NO (data/artifact-manifest.json 未改)

NODES_COVERED                 = 18（13 主探针 + 5 补充）
P1_CONTROL_DIFF_FILES         = 2（decisionEngine.ts / artifact-manifest.json）
P1_RULER_IDENTITY             = callEV/winnable ≡ heroEquity − requiredEquity（翻前，差 ≤ 1 ulp）
P1_OUTPUT_DIFF_PREFLOP        = NONE（13 节点逐行相同，sha256 两边 = B4C2F133…D39EB8C）

FINDINGS                      = F1(P0 开池无建议) F2(P0 翻前全下不可达,含 AA)
                                F3(P1 全下保护未披露) F4(P1 覆盖文案自相矛盾)
                                F5(P1 跛入池大盲加注菜单塌缩) F6(P2 档位两处口径 + 死字段)
                                F7(P2 翻前置信度恒 0.3/MARGINAL,已解释非缺陷)
                                F8(P3 隔离 EV 归属文案)
                                P-1(正面：跛入池隔离加注是唯一按 EV 比较选出的翻前加注)

NPM_RUN_VERIFY                = exit 0 ｜ tests 2051 ｜ suites 137 ｜ pass 2051 ｜ fail 0
TESTS_CHANGED                 = 0
```
