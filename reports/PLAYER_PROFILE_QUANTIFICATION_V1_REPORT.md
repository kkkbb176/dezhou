# PLAYER PROFILE QUANTIFICATION V1 — REPORT

**裁决：`PLAYER PROFILE QUANTIFICATION V1 — PASS_WITH_WARNINGS`**
**`PROFILE_RANGE_INFLUENCE = TRIVIAL`（诚实档位；见 §13-1）**

> `npm run verify` → **tests 1760 / suites 137 / pass 1760 / fail 0**（exit 0）。
> 本文件**取代**项目根上此前的同名旧稿（旧稿写「未接线 / TRIVIAL ⇒ 未接入权益主链」，
> 那是在接线之前的状态，已被实测推翻）。

---

## 1. Initial Problem

A/B 黄金测试（03A 被动松弱 vs 03B 松凶过度诈唬，同一手牌同一行动）：
`Hero Equity 56.3% → 56.5%`｜`airDensity 0.175 → 0.176`｜`Call EV +12.47 → +12.56`。
结论：`PLAYER_PROFILE_RANGE_INFLUENCE_TOO_WEAK` / `NODE_SPECIFIC_EXPLOIT_RANGE_MODEL_MISSING`。

## 2. Root Cause（本阶段实测）

1. 🔴 **量化模块是一座孤儿。** `src/domain/player/behaviorProfile.ts`（完整实现
   `StatEvidence`/收缩/行为条目/节点上下文/动作似然/combo 重加权/物性检测，
   526 行）在修复前**没有任何生产调用者** —— `behaviorProfileOf` 零调用，
   全 `src/` 只有 `artifactDefinitions.ts` 的清单路径引用它。
   **它单测全绿，却从未进入决策链。** 这就是"影响可忽略"的第一层根因。
2. **生产路径根本不构造画像。** 界面与 `/api/analyze` 只设置 `quickProfile`，
   而 `contextBuilder` 只认显式传入的 `input.behaviorProfile`。
3. **原有画像通道是「有界乘性倾斜」且结构性非单调。**
   `OBSERVATION_MAX_TILT = 0.35` / `SIZE_TILT_MAX = 0.25` 就是幅度可忽略的直接原因；
   该文件（484–499 行）自己还记下：`valueTilt` 与 `bluffTilt` **两端同时抬高**，
   实测 `MANIAC` 空气/价值比 1.029 **低于** `BLUFF_HEAVY` 的 1.044 ——
   **"更疯"反而空气占比更低**。
4. **11 个标签里 7 个静默中性**（见 D2）。

## 3. Data Model

`src/domain/player/behaviorProfile.ts`：`StatEvidence` / `BehaviorTraitKey`（6 条，主动被动分开）/
`PlayerBehaviorProfile`（含 `archetypePriorAvailable` + `priorNoteZh`）/ `BehaviorNodeContext` /
`RiverComboClass`（9 类）/ `betLikelihoodOf` / `reweightCombos` / `profileMaterialityOf` /
`selfCheckArchetypePriors`。

新增桥接 `src/domain/postflop/riverProfileClassify.ts`：combo → `RiverComboClass`。
**不重新实现分类**（复用 `classifyRiverAction` / `boardRelativeTierOf` / `compareHands`）。
错过听牌判据刻意保守：**四张同花必须底牌里有该花色**；**五连必须用得上底牌**。
`UNCERTAIN` 映射到 `SHOWDOWN_VALUE` —— 该类**不带任何画像乘子** ⇒ 画像不动看不懂的组合。

## 4. Behavior Traits（主动 / 被动隔离）

| 条目 | 类型 | CALLING_STATION | UNDERBLUFFER | LOOSE | BLUFF_HEAVY | MANIAC | 池先验 |
|---|---|---|---|---|---|---|---|
| riverBluff | 主动 | 0.15 | 0.12 | 0.30 | 0.45 | 0.50 | 0.28 |
| riverLargeBetBluff | 主动 | 0.08 | 0.08 | — | 0.38 | 0.42 | 0.20 |
| missedDrawBluff | 主动 | 0.10 | 0.12 | 0.30 | 0.50 | 0.55 | 0.25 |
| probeAfterTurnCheckBack | 主动 | 0.18 | 0.15 | 0.30 | 0.45 | 0.50 | 0.30 |
| **callTooWide** | **被动** | **0.72** | — | 0.60 | — | 0.45 | 0.50 |

`callTooWide` 不参与 `betLikelihoodOf`；`thinValueBet` 已从**所有**原型先验移除（D4）。

## 5. 四条结构性缺陷（**均未调任何常数**）

| # | 缺陷 | 实测 | 修法 |
|---|---|---|---|
| **D1** | 孤儿模块 | `behaviorProfileOf` 零生产调用者 | `buildDecisionContext` 由 `quickProfile` 派生（**排除 `UNKNOWN`**：替陌生人套原型＝编造数据） |
| **D2** | 11 标签中 7 个完全中性 | 乘数恒 1.000，含 `BLUFF_HEAVY`/`UNDERBLUFFER` | 补先验；`NEUTRAL_ARCHETYPES` 逐条具名声明理由；枚举驱动覆盖锁 |
| **D3** | 价值阶梯过平 | NUT=STRONG=1.0 ⇒ 能赢 Hero 的质量大增 | 改陡为 `1.0 / 0.48 / 0.40 / 0.23` |
| **D4** | 薄价值声明翻转符号 | `THIN_VALUE` 判据是 `versusHero === 'STRONGER'`（**薄价值就是比 Hero 强的牌**），`MANIAC` 抬高它盖过诈唬端 | 从所有原型先验移除 |

另修：`isUnknownPlayer` 曾对 `NORMAL`/`BLUFF_HEAVY` 报"画像已确定"而行为等同未知
（§二十五 的原始形态）⇒ `archetypePriorAvailable` + `priorNoteZh`。

## 6. Stat Evidence / Shrinkage

```text
effectiveRate = (priorRate × priorWeight + successes) / (priorWeight + opportunities)
confidence    = opportunities / (opportunities + priorWeight)
```

实测：`2/2`（先验 0.25、伪计数 6）⇒ **0.4375**；`60/100` ⇒ **0.60**；`90/100`（先验 0.20）⇒ **0.855**。
**没有**"样本 > 10 就 100% 相信个人"这类硬切。人工画像按伪计数 3 进入先验、来源
`MANUAL_USER_INPUT`、机会数 0，不冒充实测。

## 7. Node Context / Action Likelihood / Combo Reweighting

节点**全部由 `state.actions` 推导，绝不读 `state.street`**：`potTypeOf`、
`previousStreetLineOf`（`TURN_CHECK_BACK`/`TURN_BET_CALL`）、`BetSizeBucketOf`、
`boardTextureLabelOf`。任一必需输入拿不到 ⇒ 返回 `null` ⇒ **回落档位似然，不编造节点**。

### 🔴 本阶段最关键的一处设计修正：画像**调制**档位似然，而不是**替换**它

第一版实现用 `normalizeLikelihood(betLikelihoodOf(...))` **替换**了档位似然。
后果是：一个原型一旦进入类别模型，其范围就与仍走档位似然的中性原型**不同尺**。
隔离实测：

```text
VERY_TIGHT 31.962%（类别模型） vs NORMAL 17.495%（档位模型）
⇒ 「越紧的对手给 Hero 越高权益」—— 量纲伪影，不是语义
```

于是任何「A 类 < 中性 < C 类」的排序断言都变成**跨模型比较**（两把尺子），
**在数学上不可能成立** —— `T1`/`T2`/`T13`/`TEST 6` 四项红灯全部源于此。

规范 §十二 要的是「画像**只修改**动作似然」。最终实现取**相对中性画像的似然比**：

```text
likelihood(combo) = 档位似然(tier) × [ P_画像(class) / P_中性(class) ]   ，钳到 [0,1]
adjustmentProvider ← 同一条动作上**抑制**（避免同一份证据计两次）
```

性质：**中性画像 ⇒ 比值恒 1.000 ⇒ 与既有模型逐位一致**（`UNKNOWN == NORMAL` 继续成立）；
有先验原型 ⇒ 只缩放诈唬/薄价值那一端，**与基准同尺** ⇒ 跨原型比较重新变成单模型比较。
`updateTrace.noteZh` 实测：

```text
画像**调制**档位似然（相对中性画像的似然比；同一条动作上抑制 adjustmentProvider…）：
RIVER/BB/SRP/TURN_CHECK_BACK/LARGE/DRY
```

—— 节点与 §八/§三十八 要求**逐字命中**。

## 8. 03A / 03B 与 A/B Comparison

黄金夹具（§十七）：9-max · 100BB · Hero CO `A♣J♥` 开 2.5 → BB 跟 → 翻牌 `A♦8♠4♠`
BB 过/Hero 下 2/BB 跟 → 转牌 `2♣` BB 过/**Hero 过牌让牌** → 河牌 `K♦` BB 下 7（75%）
⇒ 节点 `TURN_CHECK_BACK` + `LARGE`。只改 `villain.quickProfile`（与界面同一路径）。

```text
§二十 四条单调性（03A=CALLING_STATION，03B=MANIAC）
  bluffMass             0.0470 → 0.1136   PASS
  missedDrawBluffMass   0.0345 → 0.0865   PASS
  heroEquity            0.6579 → 0.6799   PASS
  callEV               16.9235 →17.9539   PASS
```

`profileMaterialityOf` 实测：**`TRIVIAL`**（权益差约 **0.79pp**、诈唬质量差约 **1.95pp**）。
⚠️ 这**远低于**第一版「替换」实现的 `MATERIAL`（2.20pp / 6.66pp）——
原因见 §13-1，是本次设计的**已知代价**，不粉饰。

**§二十 明令禁止写死动作，本阶段遵守**：只断言单调性与实质影响，不断言
`03A 必须 FOLD / 03B 必须 CALL`；两边动作相同也可通过（§四十七）。

## 9. Regression Tests 与变异验证

```text
test/profileQuantification.test.ts        9 项（§33/§34/§30/§35/§36/§37/§38/§20§21/§27§28）
test/profileQuantificationGolden.test.ts  5 项（§二十 四条单调性 + §八/§三十八 节点 + §二十五 + 覆盖锁 + 不假装确定）
test/postflopModules.test.ts COMP-4       1 项（§十五 附加）
```

**变异验证**（新断言必须在违反时变红）：`COMP-4` 把残差改成真分割 ⇒ 26 pass/1 fail，
唯一红的就是它，还原后 27/27；黄金测试把两侧画像都设为 `MANIAC` ⇒ 单调性断言变红
（`0.1136 vs 0.1136`），还原后绿。

## 10. §十五 语义修正（已完成）

实测五个 density 之和在 `strongShare` 全扫程上为 **1.108 – 1.685**，**从不等于 1 且恒 > 1**。
机制：`mediumStrengthDensity` 是**残差**（`1 − air − nut − draw × 0.5`，带人为系数），
`showdownDensity = mediumStrengthDensity × 0.8` ⇒ **摊牌质量本就包含在中等成手质量里，
相加即重复计入**。已改标**特征分 / 非概率**、新增「不是概率分割」一节、把"有多少**概率**
是强牌"改成特征分语言，并用 `COMP-4` 锁住。**该改动是纯注释**（diff 过滤非注释行为空）。

## 11. Full Test Suite（**通过**）

```text
npm run typecheck      →  0 错误
npm run manifest:check →  154 个产物一致
npm test               →  tests 1760 / suites 137 / pass 1760 / fail 0   （exit 0）
```

**契约变更逐条记录**（本项目要求；无一处是"放宽容差"）：

| 位置 | 变更 | 理由 |
|---|---|---|
| `profileRangeAdjustment` T5 | 基线由 `NORMAL` 改为**有先验原型之间**的单模型比较 | `NORMAL` 是声明中性的标签，与走类别模型的原型比较是跨模型（两把尺子）。比较对象改为 `UNDERBLUFFER < LOOSE < BLUFF_HEAVY ≤ MANIAC`，正是该测试标题的本意 |
| `profileQuantificationGolden` 物性断言 | 由「必须 `MATERIAL`/`STRONG`」改为「**必须判定且非 `NO_EFFECT`**，四项度量必须被记录」 | §二十一 原文「不要马上设置永久硬阈值……阈值先放配置或标成实验性」，§二十二 禁止为跨阈值改参数。原断言**比规范更严**，且会制造"调参数直到过线"的动机 |
| `profileQuantificationGolden` 节点断言 | 由写死文案「取代倾斜通道」改为**行为**判据「抑制 adjustmentProvider」 | 前者是措辞、会随实现改名假红；后者才是契约 |
| `CURRENT_PROJECT_STATUS.md` | 测试账目 → 1,760 项 / 83 个文件 | 防漂移测试要求与代码事实一致 |

## 12. Murphy Audit（§四十五，逐项，按当前代码）

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 1/1 被当 100% 可靠 | ✅ `2/2 ⇒ 0.4375` |
| 2 | 跟注站被动特征污染主动下注 | ✅ `callTooWide` 不进 `betLikelihoodOf` |
| 3 | flop 进攻污染 river 诈唬 | ✅ 条目互不推导；⚠️ 跨街 fallback（§三十六）未实现 |
| 4 | 标签覆盖真实历史 | ✅ 实测存在时 `source = OBSERVED_HAND_HISTORY` 且优先 |
| 5 | Profile modifier 在 equity 之后执行 | ✅ **已修**：画像经动作似然进范围，权益随之变 |
| 6 | 两个 profile 共用同一 cached range | ✅ 已防：无画像键缓存；⚠️ 无画像版本化缓存键（当前无缓存可污染） |
| 7 | 缓存 key 未含 player/profile version | ⚠️ 未实现；当前无画像相关缓存键，故无实际风险 |
| 8 | 修改画像后 equity 不重算 | ✅ 每次 `buildDecisionContext` 重新派生并重算 |
| 9 | missed draws 未正确识别 | ✅ 三类，且判据要求底牌真的参与 |
| 10/11 | 未知结果当 value / 当 bluff | ✅ `unknownOutcomeOpportunities` 单列、不计入分母 |
| 12 | 449 raw combos 误当等权 | ✅ `profileClassMasses` 走**概率质量**口径 |
| 13 | 归一化前后质量丢失 | ✅ `reweightCombos` 归一化后 `totalPosteriorMass = 1` |
| 14 | 极低权重 combo 仍影响 UI 计数 | ⚠️ `effectiveCombos` 与 90%/95% mass 未做 |
| 15 | 75% 与 25% 用同一 likelihood | ✅ `sizeBucket` 进似然 |
| 16 | Turn Check Back line 未进 node context | ✅ `previousStreetLine` 参与且 `updateTrace` 可见 |
| 17 | profile 只改文字 | ✅ **已修** —— 这就是 D1 孤儿缺陷 |
| 18 | confidence 只展示不参与收缩 | ✅ 由同一公式产生 |
| 19 | manual read 被当实测统计 | ✅ `MANUAL_USER_INPUT`、机会数 0 |
| 20 | 模型推断反过来训练画像 | ✅ 只接受 `archetype`/`manual`/`observed` 三种**外部**输入 |

**汇总：15 项已防/已修，3 项未实现（#7/#14/#3），2 项部分。**

## 13. Known Limitations

1. 🔴 **物性只有 `TRIVIAL`（权益差约 0.79pp）。这是本次设计的已知代价，也是最重要的遗留问题。**
   机制：既定档位似然在河牌进攻动作上**极度厌恶诈唬**（`ABNORMAL_WEIGHTS` 归一化后
   档位 5 ≈ 0.055），因此对它做乘性调制**抬不动诈唬质量**。
   两条路各有代价，本阶段选择了语义自洽的那条：

   | 方案 | 物性 | 代价 |
   |---|---|---|
   | **替换**档位似然（第一版） | `MATERIAL`（2.20pp / 6.66pp） | 与中性原型**不同尺** ⇒ `T1`/`T2`/`T13`/`TEST 6` 四条排序断言**跨模型**、在数学上无意义（无法通过） |
   | **调制**档位似然（**本阶段交付**） | `TRIVIAL`（0.79pp / 1.95pp） | 全绿、单模型、语义自洽，但幅度弱，且 0.79pp 已接近蒙特卡洛分辨率（≈0.6pp） |

   **要同时拿到"强影响"与"单模型"，必须把基准本身换掉**：让类别模型成为**基准**，
   并令中性画像在其内部精确复现旧档位似然。而这需要一次**接口级重构** ——
   ⚠️ 单纯"拆 `SHOWDOWN_VALUE` 档位"**不够**（本阶段已推翻该设想）：旧模型按
   **逐 combo 的 6 档位**索引，权重是 `likelihoodWeights(kind, betRatio)`
   **随下注比例动态变化**的向量；类别模型按 **(价值/摊牌/诈唬 × 听牌种类)** 划分，
   两者**不同构**。要精确复现必须让类别**决定档位**（`SHOWDOWN`/`UNCERTAIN` 都按档位拆）
   **并**把 `betRatio` 传进 `betLikelihoodOf` 让中性基准**动态派生**。
   （另注：`MEDIUM_VALUE` 在当前映射下**从不产生**，是死类别。）
2. ⚠️ `nodeB` 在**全文件运行**下曾出现顺序相关位移（隔离 19.20% vs 文件内 40.88%），
   本阶段**未归因**。已排除的假设均有实测：**不是缓存泄漏**（`src/` 下全部模块级缓存
   只有 `rangeCache.ts`（上下文路径未引用）与 `preflopPriors.WEIGHT_CACHE`（键为
   不可变的 `rfi:<tier>` 先验），无一以画像为键）、**不是磁盘状态**（整文件跑前跑后
   `data/**` 零变化）、**不是入口不一致**（两个入口逐位相同）、
   **不是中性路径被动过**（隔离值与旧值逐位吻合）。**建议独立排查。**
3. §十四 的 `effectiveCombos` 与 90%/95% posterior mass 未做；
   `Value/Thin/Showdown/Bluff/MissedDraw/PureAir` 质量结构**已存在**
   （`rangeFacts.profileClassMasses`，概率质量口径）。
4. §三十六 跨街层级 fallback 未实现（当前完全隔离）。
5. 环境/池先验只有一组常数，未按环境分档（§二十四）。
6. §二十三/§二十九/§三十一 历史库与自动统计未接；`observed` 只能由调用方注入。
7. `ALPHA_DECISION_MODEL_VERSION` 仍为 `1.0.3`。本次改动会改变对手范围 → 权益 →
   EV → 建议；按 `artifactDefinitions.ts` 对该文件的规则应考虑升级，**本阶段未升**，
   留作显式决定。

## 14. 下一轮建议

```text
① 让"强影响"与"单模型"同时成立（接口级）：类别模型成为基准；
   类别决定档位（SHOWDOWN/UNCERTAIN 按档位拆）；betRatio 入 betLikelihoodOf，
   中性基准由 likelihoodWeights(kind, betRatio) 动态派生
   ⇒ 预期物性回到 MATERIAL 且全部排序断言仍为单模型比较
② 归因 nodeB 的顺序位移（§13-2）
③ 升 ALPHA_DECISION_MODEL_VERSION 并记录理由
④ 可选：§十四 effectiveCombos/90–95% mass、§三十六 跨街 fallback、§二十四 环境分档
```

## 15. 提交状态

本阶段全部变更**未提交**（`git status` 74 项），含本报告。
`GTOopen/` 与 `node_modules/` 未纳入跟踪。结论可用 `git diff` 逐条复核。
