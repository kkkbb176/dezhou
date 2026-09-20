# PREFLOP F2 · 「一对牌全下」保护的街道适用范围 —— 最小修复报告

> **轮次**：PREFLOP P0 — F2 ALL-IN GUARD FIX（2026-09）
> **授权**：审计报告 `reports/PREFLOP_DECISION_PATH_AUDIT_V1.md` §四 F2（「翻前节点错误使用翻后牌型类别保护，
> 导致 AA 等强牌的合法全下加注被拦截」）。**未**修改 F1 的开池范围构建；**未**新增 Solver / 扩 GTO 范围表 /
> 调画像参数；**未**提交、**未**推送；**未**清理任何既有未跟踪文件。

---

## §1 修改前保护（基线冻结）

| 项 | 值 |
|---|---|
| `HEAD` | `91c35e8`（P1 CALL/FOLD 最小修复）= `origin/main` |
| 工作区 | 已跟踪改动 **0**（本轮开始前）；未跟踪文件 104 个（**全部保留**） |
| 检查点 | `%TEMP%\dezhou-checkpoint-preF2-20260920-121657` |
| 检查点校验 | **689 / 689 文件**逐位 sha256 比对，**0 差异**；`FILES.sha256.txt` 自身 sha256 = `64B6BB85…E36BFB262` |
| 基线哈希 | `decisionEngine.ts = 552EB273…021BC04`｜`evidencePriority.ts = E7E11F28…2AB66978`｜`contextBuilder.ts = 3D2CA2CE…020A5AC`｜`legalActions.ts = 4D93D6B9…801C4BE` |

**审计与代码一致性核对**：审计报告引用的行号与工作区逐条对齐（`shouldRaise` `:996-1041`、
`allInGuardVerdictOf` `:952-982`、`handCategory` 来源 `contextBuilder.ts:648`、`postflopFacts` 门 `:4500-4502`），
**未发现**代码与报告不符 ⇒ 未做任何「凭旧行号替换」。

---

## §2 先写失败测试（修复前先取得失败证据）

新增 `test/preflopAllInGuard.test.ts`（11 项，全部走**生产入口** `analyzeManualHand`）。

**修复前：4 项失败 / 7 项通过**（`node --test --experimental-strip-types test/preflopAllInGuard.test.ts`，exit 1）：

```text
✖ F2-1（A–D）：翻前「加注到全下」不得被**翻后**的一对牌保护拦下
    AssertionError：A · 5BB AA：翻前的合法全下被**翻后**的「一对牌全下」保护拦下了
    （handCategory=0 是翻前的正常值，不是「一对牌」）｜consumesStack=true、hasOwnEV=false
    ｜noteZh=🔴 命中「一对牌全下」保护：牌力类别 0 < 3、加注 = 打光筹码、且这次加注**没有自己的 EV**…
    actual: true  expected: false
✖ F2-2（A–D）：全下加注必须**真的**进入证据表
    AssertionError：A · 5BB AA：合法全下必须通过加注准入（shouldRaise）并带上启发式分数，
    实际 heuristicScore=0（0 ⇒ 被判据拦下、未参与任何比较）  actual: false  expected: true
✖ M9：有效筹码 3–25BB 扫描——全下候选始终在候选表里，保护不再误触发
✖ 街道矩阵：PREFLOP 不适用；FLOP/TURN/RIVER 与缺省都必须生效
    AssertionError：一对牌 + 打光 + 无 EV｜PREFLOP：翻前没有成手牌类别 ⇒ 该保护必须按街道不适用（实际 true）
```

**修复后：11 / 11 通过**，`npm run typecheck` 零错误。

---

## §3 全下保护的适用范围核查（每项判据 × 四条街）

| 判据 | 定义处 | PREFLOP | FLOP / TURN / RIVER | 处置 |
|---|---|---|---|---|
| `handCategory` | `contextBuilder.ts:648`（`described?.category ?? 0`） | **恒为 0**（翻前 `described === null`，`decisionEngine.ts:218-223` 自己就写着） | 真实成手类别（1…9） | **不改**（它是事实，不是参数） |
| `MIN_CATEGORY_FOR_LARGE_RAISE = 3` | `decisionEngine.ts:891` | 阈值本身与街道无关 | 同 | **不改**（阈值一个字未动） |
| 保护①：`consumesStack ∧ !hasOwnEV` | `:1035` | **加入街道条件 ⇒ 不适用** | 照旧生效 | ✅ 本轮修复点 |
| 保护②：`raiseToAmount/pot > 2.5` | `:1038` | **照旧生效**（未动） | 照旧生效 | ⏸ 见 §8 残留 |
| `hasOwnEV = raiseModelUsable \|\| isoUsable` | `:2174` | 响应模型不可用（`postflopFacts === undefined`）⇒ 仅跛入池隔离模型可能为真 | U1 响应模型可用时为真 | **不改** |
| `stackOffAllowed` / `commitmentException` | `:2129-2138`、`contextBuilder` | 翻前 `advice === null` ⇒ 恒 false | 按 SPR / 角色强度 | **不改** |
| `qualifies`（准入） | `:1021-1025` | 起手牌档位 MONSTER/STRONG + 权益优势 ≥ 15pp ⇒ **翻前的把关者** | 成手类别分档 | **不改**（M1 的依据） |

**关键判断**：原保护是**翻后**「一对牌打光」的风险控制（`decisionEngine.ts:894-923` 的 RIVER RAISE DECISION V2）。
翻前没有成手牌 ⇒ 该风险不存在 ⇒ 给它**明确的街道适用条件**（不是删除规则、也不是把翻后类别映射成
翻前的 AA/KK 档位 —— `handCategory` 在翻前仍如实为 0，测试 `M9` 专门锁这一点）。

§四 要求的五个边界，实测（修复后）：

| 边界 | 实测 |
|---|---|
| 5BB 短筹码合法全下 | 唯一加注 = 全下 10 ⇒ 保护**不再**触发，加注进入证据表（`heuristicScore = 1`） |
| 10BB 存在多个加注尺寸 | 选中 `RAISE 16`（非全下，`consumesStack = false`）⇒ 本轮修复**不影响**该节点（逐字不变） |
| 对手短筹码导致的有效筹码封顶 | 引擎的 `allInToAmount` 只按**自己**的剩余筹码算（`legalActions.ts:152`）；本轮的候选与尺寸集合**未变**，故不涉及（见 §8 观察） |
| under-raise 全下合法性 | 3BB：`minRaiseTo(10) > allInTo(6)` ⇒ 合法动作只有 `FOLD/CALL`，**跟注即投入全部剩余**；4BB：`minRaiseTo > allInTo` 但 `ALL_IN` 合法 ⇒ 候选表保留独立 `ALL_IN`。两者修复前后一致（`M6` 锁住） |
| 没有加注 EV 时启发式的适用范围 | 加注证据仍为 `ev = null`、`HEURISTIC`；启示式**只在「不打光筹码」时**才有覆盖清晰 CALL 证据的权限（`evidencePriority.ts:392-399`，**未改**） |

---

## §4 最小修复（2 个文件 · 1 条规则加条件 · 1 个纯类型字段）

### `src/app/decision/decisionEngine.ts`

1. `allInGuardVerdictOf(input)` 新增可选 `street?: Street`；在「不是全下加注」的既有分支**之后**新增：

```ts
if (input.street === Street.PREFLOP) {
  return {
    onePairAllInBlocked: false,
    reasonZh: '翻前 ⇒ 「一对牌全下」保护**按街道不适用**：翻前没有成手牌类别（`handCategory ≡ 0`，' +
      '只有起手牌档位），「一对牌打光筹码」这一风险在翻前不存在。翻前的全下准入由**起手牌档位' +
      '（MONSTER/STRONG）+ 权益优势**（`shouldRaise` 的 qualifies）把关 —— 不是无条件放开全下。',
  };
}
```

2. `shouldRaise(...)` 的 options 增加 `street?: Street`，**保护①**加同一条件（**保护②不动**）：

```ts
const streetApplies = options.street === undefined || options.street !== Street.PREFLOP;
if (streetApplies && options.consumesStack === true && options.hasOwnEV !== true) return false;
if (pot > 0 && raiseToAmount / pot > MAX_RAISE_TO_POT_RATIO) return false;   // ← 逐字未改
```

3. **三处调用点传同一个街道（M2）**：`shouldRaise(...)` 的 options、`pickCandidate` 里的
   `allInGuardVerdictOf`、`decideAlpha` 诊断装配里的 `allInGuardVerdictOf` —— 全部传 `math.street`。
   诊断对象新增 `street` 字段（使用者可据此判断 `onePairAllInBlocked = false` 是「让位于自有 EV」
   还是「本街道不适用」）。

**未改动（逐字核对）**：`MIN_CATEGORY_FOR_LARGE_RAISE`、`MAX_RAISE_TO_POT_RATIO`、`RAISE_EDGE_ANY`、
`RAISE_EDGE_STRONG`、`MARGINAL_EV_GAP_RATIO`、`MODEL_UNCERTAINTY_RATIO`、`qualifies`、
`pickClosestRaise` / `desiredTo = pot + 2×callCost`、尺寸网格倍数档 `[2,2.5,3,4,5,6,8]`、
`isoRaiseSizeOf`、`evidencePriority.ts`（**一个字未动**）、`legalActions.ts`、`contextBuilder.ts`（**未动**，F1 范围逻辑未碰）。

### `src/domain/decision/decision.types.ts`

`allInGuard?` 类型增加可选 `readonly street?: Street`（**纯类型**；无阈值 / 分类 / 置信度 / EV gap 变化）。

---

## §5 逐项验收（任务 §六）

| # | 要求 | 结果 | 证据 |
|---|---|---|---|
| 1 | 5BB AA 节点**合法全下能够进入决策候选** | ✅ | `candidates = [FOLD, CALL@4, RAISE@10]`（10 = `allInTo`）；`allInGuard.onePairAllInBlocked = false`（修复前 `true`）；RAISE 证据 `heuristicScore 0 → 1`、`commitsStack = true`、`ev = null` |
| 2 | **最终动作来自现有翻前策略，不得硬编码** | ✅ | 动作仍为 `CALL 4`（由 `evidencePriority.ts:392-399` 的既有纪律判定：**打光筹码且无自有 EV 的启发式加注不得覆盖清晰的 CALL 证据**）；测试**不**断言任何手牌的最终动作，只断言「保护不得拦下 / 必须进证据表 / 无 EV 如实为 null」；`AKo` 的 `heuristicScore = 0.984`（≠1）证明分数来自档位与权益，不是硬编码 |
| 3 | **翻后的一对牌全下保护仍然生效** | ✅ | 生产节点（多人池转牌，AK 顶对，类别 2，`consumesStack = true`、`hasOwnEV = false`）⇒ `onePairAllInBlocked = true`，说明仍点名该保护，且动作不是加注；纯函数在 `FLOP/TURN/RIVER` 与**缺省**下四种组合全部保持原语义 |
| 4 | **CALL/FOLD 数学一致性不回归** | ✅ | `test/callFoldVerdictRuler.test.ts` 11 项全通过；P1 原始 99 节点实测仍是 `CALL 20`（`action=CALL 20.00`，`RAISE_MODEL_EV_LOSES`）——与本轮修复无关地逐字不变 |
| 5 | **U1 / P1-2b / TEST 16·17·18 等核心回归全部通过** | ✅ | `npm run verify` = **exit 0**：`tests 2062 / suites 137 / pass 2062 / fail 0`；产物清单 **163/163 一致** |
| 6 | 所有候选动作的**金额、合法性与 EV 证据类型一致** | ✅ | `test/raiseToAmountConsistency.test.ts`（12 项）与 `test/decisionDisplay*.test.ts` 全通过；加注候选 `ev = null` + `HEURISTIC` + `raiseSizesWithOwnEV = []`（`F2-3` 锁住）；`finalMathSanityCheck` 无告警 |

---

## §6 影响面（133 节点指纹：修复前检查点 vs 工作区）

脚本：`scripts/f2-blast-radius.ts`（只读），同一份脚本在两棵树各跑一次，逐行 diff。

| 分类 | 数量 | 说明 |
|---|---|---|
| **最终动作发生变化** | **0** | 无任何节点的动作/尺寸改变 |
| 仅新增 `street` 字段、其余逐字一致 | 97 | 含全部翻后节点、跛入池、3bet、无人入池等 |
| 实质性变化 | 36 | **全部**落在 `BB 5/6/7/8BB 面对 3BB 开池` 这一族 |

36 例的细分：

- **24 例**（AA / KK / AKs / AKo / QQ / TT × 4 个深度）：`onePairAllInBlocked: true → false`，
  `heuristicScore: 0 → >0`，来源如实变为
  `overrideAttempt = RAISE_HEURISTIC`、
  `overrideBlockedReason = CANNOT_OVERRIDE_CLEAR_SUPPORTED_CALL_WITH_UNEVALUATED_ALL_IN`
  ⇒ **全下不再被「翻后牌型保护」拦下，而是被既有证据纪律以正确理由拒绝**（同时修掉了审计 F3 的披露缺口）。
- **12 例**（55 / JTs / A5s × 4 个深度）：**只有** `onePairAllInBlocked` 翻转，
  `heuristicScore` 仍为 0、`overrideAttempt` 仍为 `null`
  ⇒ **M1 成立：保护没有被无条件取消，弱牌与中等牌照样推不出去。**

翻后**多人池一对牌 + 全下**这一真实触发点：除新增字段外逐字不变（`blocked = true`）。

---

## §7 墨菲定律对照（任务 §五 M1–M10）

| # | 风险 | 结果 | 证据 |
|---|---|---|---|
| M1 | 修 AA 后其他翻前起手牌的保护被无条件取消 | ✅ 未发生 | 55/JTs/A5s@5–8BB：`heuristicScore` 仍 0；72o 在所有深度都不消耗筹码、不受影响；测试 `M1` 锁住 4 手牌的档位标签与 `heuristicScore = 0` |
| M2 | 只修 `shouldRaise`，遗漏 `evidencePriority` 的同类拦截 | ✅ 未发生 | `allInGuardVerdictOf` 的**两个**调用点都传 `math.street`；测试 `F2-2` 断言「证据表说它过了准入」与「`allInGuard` 不得仍报被拦」一致 |
| M3 | 合法全下进入候选，但候选选择器仍把它删掉 | ✅ 未发生 | 5BB 候选表 `RAISE@10 = allInTo`；`M9` 对 3–25BB 逐深度断言全下额可达（三条合法表达之一） |
| M4 | 把翻前 AA 误当成翻后的「一对 A」 | ✅ 未发生 | `handCategory` 在翻前仍如实为 **0**（`M9` 明确断言「不得被改写成『一对牌』」）；修复用**街道**判据，未做任何类别映射 |
| M5 | 翻后弱一对保护被意外关闭 | ✅ 未发生 | `M5-1` 用**生产节点**（多人池转牌顶对）锁住 `onePairAllInBlocked = true`；纯函数街道矩阵穷举 `FLOP/TURN/RIVER` + 缺省 |
| M6 | 短筹码下合法的 under-raise 全下被拒绝 | ✅ 未发生 | 3BB：合法动作 `FOLD/CALL`，跟注额 = 全部剩余（测试断言）；4BB：独立 `ALL_IN` 候选保留；`legalActions.ts` 未改动 |
| M7 | AA 全下被允许后界面错误宣称它有真实 EV | ✅ 未发生 | 加注证据 `ev = null`、`estimateType = HEURISTIC`、`raiseSizesWithOwnEV = []`；理由码里**不出现** `RAISE_MODEL_EV` / `ISO_RAISE_MODEL_EV`（`F2-3`） |
| M8 | 翻前没有对应条件范围，却把整体范围权益当作 4Bet EV | ✅ 未发生 | 本轮**没有**新增任何 EV 公式或数值；4bet 场景（BTN 面对 3bet 至 10BB）也逐字不变（`RAISE 56`，`ev = null`） |
| M9 | 只修 5BB、其他有效筹码深度仍触发同一缺陷 | ✅ 已扫描 | 3–25BB × 11 手牌 = 132 节点 + 翻后 4 节点；5–8BB 共 36 例修复，9BB 以上本就未触发（选中尺寸非全下） |
| M10 | 改策略阈值让 AA 全下，从而掩盖街道适用范围错误 | ✅ 未发生 | 所有阈值逐字未改（§4 清单）；保护②（底池比例档）仍对所有街道生效；`M10` 断言 `minCategoryForLargeRaise = 3` 且 `RIVER` 上规则仍触发 |

---

## §8 残留与未授权项（**均未实施**）

1. **翻前全下仍不会成为最终动作**（动作未变）。它没有自有 EV，而既有证据纪律规定
   「打光筹码且没有 EV 的启发式加注不得覆盖清晰的 CALL 证据」（`evidencePriority.ts:392-399`）。
   要让短码推注真正可达，需要为**翻前全下建立自有 EV 模型**（权益 + 弃牌率 / 摊牌终止近似）——
   属**新增模型**，本轮明确禁止。当前行为已如实披露：
   `overrideBlockedReason = CANNOT_OVERRIDE_CLEAR_SUPPORTED_CALL_WITH_UNEVALUATED_ALL_IN`。
2. **保护②（底池比例档 `MAX_RAISE_TO_POT_RATIO = 2.5`）**以 `handCategory < 3` 为前提，
   而翻前恒成立 ⇒ 仍是「同一根因的第二处实例」（约束**大额非全下加注**）。
   本轮**刻意未改**：翻前的底池很小，解除它会让 3bet/4bet 尺寸策略整体变化（属策略变更，需单独授权）。
3. **`allInToAmount` 不按对手剩余筹码封顶**（`legalActions.ts:152`）：短筹码对手在池时，
   候选尺寸可能超过「有效可争夺量」。本轮候选集合未变，故未处理 —— 记为观察项。
4. **manifest 影响说明指向一个不存在的常量**：`data/artifact-manifest.json` 对
   `src/domain/decision/decision.types.ts` 的影响文案写着「该文件改动必须升 `ALPHA_DECISION_MODEL_VERSION`」，
   但全仓（`src` / `test` / `scripts`）grep **不存在**该常量（只在该文案里出现）。
   本轮对该文件的改动是**纯类型**（诊断类型加一个可选字段，零阈值变化），
   因此**没有**自行发明版本常量 —— 请使用者决定是补上版本机制还是修正该文案。
5. 审计报告 §四 F1 里「`tablePreview` 会提前提示信息不足」一句**基于注释**，本轮核查发现该提示
   已在「多人池不再劝退」那一轮被**移除**（`tablePreview.ts:750-771` 明确写「连提示都不加」）
   ⇒ **该说法应更正**：无人入池时使用者不会在点击前得到预警。

---

## §9 F1 只读实施前审查（**本轮只给方案，不改生产代码**）

### Q1 无人入池时为什么权益为空？

链条（唯一判据，与画像无关）：

```text
gameState.ts:301-314         realizedOpponentIds：**盲注 / 前注不算**（`POST_SB/POST_BB/POST_ANTE` 被排除）
contextBuilder.ts:3419-3421  realizedOpponents = opponents.filter(realizedIds.has)
contextBuilder.ts:3730-3754  allRangeBuilds 只遍历 realizedOpponents ⇒ usableRangeBuilds = []
contextBuilder.ts:2494-2500  computeHeroEquity 见 opponentRanges.length === 0 ⇒ 返回 null + 警告
decisionEngine.ts:610-615    heroEquity === null ⇒ 推 EQUITY_NOT_COMPUTABLE ⇒ 判「信息不足」
```

实测：BTN 无人入池（AA / KK / JTs / A5s / 20BB 短码 AA）与「带完整 MANIAC 实测统计」的对照节点
**结论逐字相同** ⇒ 与对手画像无关，是**结构性的**。

**注意**：`context.range`（展示/画像用）**不是 null** —— `contextBuilder.ts:3756-3772` 的 fallback 分支
为「首要对手」（`realizedOpponents[0] ?? opponents[0]`，即盲注位）**照样建了一份**先验范围
（实测 `supportSize = 1225`、`share = 0.9238`）。也就是说：**建范围的能力存在，只是没喂给权益。**

### Q2 现有 fallback 范围对应的是盲注未行动范围，还是面对开池的继续范围？

**是「盲注未行动（被动进入）的宽范围」**，不是「面对开池的继续范围」。判据在
`contextBuilder.ts:1000-1003`：

```ts
} else if (aggression === null) {
  weights = bigBlindCheckWeights();
  label = '无人加注时的宽范围（对手被动进入，范围极宽）';
}
```

`bigBlindCheckWeights()`（`preflopPriors.ts:834`）就是「大盲无人加注时的过牌范围」，
其自检要求它**比任何开池范围都宽**（`preflopPriors.ts:960-964`）。
而「面对开池的继续范围」是另一套（`defendWeightsByHandedness`，`:1029`），
「面对 3bet」又是第三套（`threeBetWeightsByHandedness`，`:1013`）—— 三者**没有混用**（红队 F-03 的永久锁）。

⇒ 语义上，把「盲注未行动的宽范围」用于**开池决策**是正确的（他们还没展示强度），
不存在「拿继续范围冒充未行动范围」的问题。

### Q3 翻前范围表是否已经提供位置专属 RFI 开池决策？

**是**。`preflopPriors.ts` 已经有三套位置专属范围表：

| 表 | 内容 | 取值入口 |
|---|---|---|
| `RFI_SPECS`（`:168-355`） | 按位置从紧到松的开池（RFI）范围，含按钮位（`:299`）与小盲位开池（`:335`） | `rfiWeights(tableSize, position)`（`:700`）/ `rfiWeightsByHandedness(position)`（`:810`） |
| `DEFEND_SPECS`（`:370-497`） | 面对前/中/后位开池的继续范围（跟注 + 3Bet） | `defendWeightsByHandedness(opener, defender)` |
| `THREEBET_SPECS`（`:515-591`） | 面对前/中/后位开池的 3Bet 范围（严格更紧） | `threeBetWeightsByHandedness` |

并有 `selfCheckPreflopPriors()`（`:884`）把四条不变量锁死（位置单调、3Bet 严格窄于开池、
顶级牌必须在范围内、大盲过牌范围最宽）。
⚠️ 但**注意语义**：这些表描述的是**对手**「如果开池会是什么范围」，
而 Hero 自己开池时需要的是**对手尚未行动时的宽范围**（Q2 的 `bigBlindCheckWeights` 那一路）。
两者都已具备 ⇒ **F1 不缺数据表，缺的是数据流。**

### Q4 没有可用权益时，现有开池策略是否仍能够输出有依据的动作？

**不能，而且这是刻意的纪律**（「宁可不给建议，也不编造」）：

- `equity === null` ⇒ `EQUITY_NOT_COMPUTABLE`（`:610-615`）⇒ `actionable = false` ⇒ `action = null`；
- 面对下注分支需要 `verdictEdge` / `callEV`（都要求权益）；
- 无人下注分支的下注资格是 `legacyHasInitiativeValue = equity !== null && context.range !== null && equity > 0.55`
  （`:2667-2668`）—— 权益为 null 直接不成立。

⇒ 现状是「**没有权益就不给方向**」，而不是「有一条不依赖权益的开池启发式」。
F1 的修复必须**同时**提供可计算权益的（扩大口径）与披露（说清口径）两部分，否则只是把「不给建议」换成「无依据的建议」。

### Q5 能否通过最小数据流修复使 BTN、CO 无人入池时正常输出建议？

**能，且改动面很小（3 处 + 披露），但语义上属于「新增一类可决策场景」，必须单独授权。**

建议方案（**推荐 A**，最小且不发明策略）：

| 步 | 位置 | 改动 |
|---|---|---|
| A1 | `contextBuilder.ts:3730-3754` | 在 `realizedOpponents` 之外，另外为「**未弃牌、尚未行动**」的对手（`playersYetToAct`，`:3422` 已存在）建一份范围（复用 `buildRangeSnapshot`，它会走 `aggression === null ⇒ bigBlindCheckWeights()`），并**打上标签**（`sourceKind` / `labelZh` 标注「尚未行动 ⇒ 宽范围先验」） |
| A2 | `contextBuilder.ts:3777-3785` | 把 A1 的范围并入 `computeHeroEquity` 的输入（可与已实现范围**同时**进入多人口径），并让 `math` 带出「本次权益含 N 家**尚未行动**的先验范围」 |
| A3 | `decisionEngine.ts:610-615` + 理由/警示 | 不再因权益为 null 短路；新增披露条目（例如 `PRIOR_ONLY_RANGE_APPROXIMATION`），并在 `tablePreview` 侧如实提示（注意 §8-5：该提示目前已被移除，需重新设计为**提示而非阻断**） |
| A4 | 测试 | 新增：无人入池 6 个位置 × 手牌档位的动作方向不为 null；盲注先验进入权益的数值回归；「未行动先验」披露必须存在；不得影响已有「已实现范围」节点的任何数值 |

**不推荐方案 B（新增不依赖权益的开池启发式）**：那等于在缺证据时凭空定义开池门槛
（哪些档位开、开多大），与项目「不得把启发式当 EV」的既有纪律冲突，且会引入一套**无法验证**的策略。

**风险与代价（必须先说清）**：A 会改变**全部无人入池翻前节点**的 `heroEquity`，进而影响
`edge` / `verdictEdge` / 加注准入 / 分类与置信度 —— 虽然只影响「现在根本不给建议」的那些节点，
但**新增的建议本身**必须经过一轮独立验收（含墨菲扫描），不能与 F2 这类「规则适用范围」修复混在一轮。

### Q6 是否需要修改其他面对 3Bet、4Bet 或多人底池的范围语义？

**不需要。** 实测：

- 面对开池（BB vs BTN 3BB）：`opponentRanges = 1`，来源 = 「庄家位的启发式开池范围（对手主动加注，按本手 6 人取档）」
  ⇒ 已是**位置专属 RFI**；
- 面对 3bet（BTN vs BB 至 10BB）：来源 = 「再加注（3Bet+）范围：大盲位 对 庄家位 开池的启发式 3Bet 范围」
  ⇒ 已是**位置对 + 红队 F-03 的严格更紧**；
- 多人池 / 跛入池：`opponentRanges = 2`，来源 = 「跛入到达范围：普通（中立）（画像），有效宽度 0.65（**不是**任意两张）」
  ⇒ 已是**按原型收窄**的到达范围（`limpArrivalRangeOf`）。

⇒ 这三类场景的范围语义**已经就绪**，F1 只需要补「尚未行动 ⇒ 宽范围先验」这一条**缺失的接入口**，
不应改动 3Bet / 4Bet / 跛入的既有表与档位选择逻辑。
（可选增强：`AnalyzeOptions.gtoRanges` 已在 `webServer.ts:814-819` 按预取注入求解器范围；
若无人入池节点也能拿到预取范围，A1 的近似误差会进一步下降 —— 这属于数据源，不是语义变更。）

---

## §10 机器可读验收块

```text
ROUND                         = PREFLOP_F2_ALLIN_GUARD_FIX
MODE                          = AUTHORIZED_FIX（最小修复 + 先写失败测试）
BASELINE                      = HEAD 91c35e8（= origin/main）｜工作区已跟踪改动 0
CHECKPOINT                    = %TEMP%\dezhou-checkpoint-preF2-20260920-121657
CHECKPOINT_FILES              = 689 / 689（逐位 sha256 比对 0 差异）
CHECKPOINT_MANIFEST_SHA256    = 64B6BB85700FB1B88A48E11898D26BA8459C81DD7835CECA878B331E36BFB262

PROD_FILES_CHANGED            = 2（src/app/decision/decisionEngine.ts；src/domain/decision/decision.types.ts[纯类型]）
DOC_FILES_CHANGED             = 2（CURRENT_PROJECT_STATUS.md；data/artifact-manifest.json[重新生成]）
PROD_FILES_FORBIDDEN_TOUCHED  = 0（contextBuilder.ts / legalActions.ts / evidencePriority.ts / preflopPriors.ts 未改）
STRATEGY_THRESHOLDS_CHANGED   = 0（MIN_CATEGORY_FOR_LARGE_RAISE / MAX_RAISE_TO_POT_RATIO / RAISE_EDGE_* /
                                   MARGINAL_EV_GAP_RATIO / MODEL_UNCERTAINTY_RATIO / desiredTo / 尺寸倍数档 / isoRaiseSizeOf）
F1_SCOPE_BUILD_TOUCHED        = NO
NEW_SOLVER_OR_GTO_TABLE       = NO ｜ PROFILE_PARAMS_CHANGED = NO

TESTS_ADDED                   = test/preflopAllInGuard.test.ts（11 项）
FAILING_EVIDENCE_PRE_FIX      = 4 failed / 7 passed（F2-1 / F2-2 / M9 / 街道矩阵）
TESTS_POST_FIX                = 11 / 11 passed
TYPECHECK                     = 零错误（tsc --noEmit）
TESTS_PASS                    = 2062 ｜ TESTS_FAIL = 0 ｜ SUITES = 137
MANIFEST                      = 163 / 163 一致（npm run verify exit 0）
OLD_TEST_EXPECTATIONS_REWRITTEN = 0（原有断言一条未改；唯一曾失败的旧测试是状态文档计数，已同步文档）

PREFLOP_ALLIN_LEGAL           = YES（5/6/7/8BB 的 BB 面对开池：onePairAllInBlocked true→false，
                                     全下以 RAISE@allInTo 候选进入证据表，heuristicScore 0→>0）
POSTFLOP_ONE_PAIR_PROTECTION_PRESERVED = YES（多人池转牌顶对生产节点仍 blocked=true；纯函数四组合 × 四街道穷举）
AA_KK_AKS_BEHAVIOR            = 保护不再拦下（heuristicScore 1 / 1 / 1）；动作仍 CALL 4（由既有证据纪律决定，
                                     非硬编码）；AKo heuristicScore = 0.984 ≠ 1 ⇒ 分数来自档位与权益
SHORT_STACK_BOUNDARY          = 5–8BB：保护翻转（36 例之一）；3BB：无合法加注、跟注即全下；4BB：独立 ALL_IN 候选保留；
                                     9BB 以上：选中尺寸非全下 ⇒ 本轮不影响
EVIDENCE_PRIORITY_VALID        = YES（evidencePriority.ts 一字未改；两个 allInGuardVerdictOf 调用点共用 math.street）
RAISE_EV_PROVENANCE           = 加注证据 ev = null / estimateType = HEURISTIC / raiseSizesWithOwnEV = []；
                                     无 RAISE_MODEL_EV 或 ISO_RAISE_MODEL_EV 理由码（不得声称有 EV）
EXISTING_EV_FORMULAS_UNCHANGED = YES（callEV / edge / verdictEdge / 分层 EV / 加注 EV 公式全部未动）

BLAST_RADIUS                  = 133 节点指纹对照：动作变化 0 ｜ 仅新增 street 字段 97 ｜ 实质变化 36（全部在 BB 5–8BB vs 开池）
SPECIAL_THANKS_MURPHY         = M1–M10 全部对照（§7），无一项命中
RESIDUAL_FOR_AUTHORIZATION    = 翻前全下仍无自有 EV（不会被选中）；保护②（底池比例档）仍约束翻前大额加注；
                                 allInToAmount 不按对手筹码封顶；manifest 引用的 ALPHA_DECISION_MODEL_VERSION 不存在
F1_MINIMAL_IMPLEMENTATION_PLAN = §9（A1–A4：未行动对手的先验范围接入权益 + 口径披露 + 预览提示 + 专项测试）；
                                 本轮**只给方案，未改任何生产代码**
UNAUTHORIZED_FILE_CHANGES     = 0
SAFE_TO_CONTINUE_PREFLOP_TESTING = YES（前提：F1 若实施必须单独授权并做独立验收）
GIT_ADD_COMMIT_PUSH           = NONE（未提交、未推送；未清理任何未跟踪文件）
```
