# RIVER BET RANGE V2 —— 定向修复与墨菲定律审查报告

**范围**：只处理河牌主动下注范围的四个问题（重复计费 / SHOWDOWN 整类清零 / 隐藏底牌泄漏 / 数据一致性）。
未触碰牌力求值器、人物画像 Resolver、翻前范围、下注响应模型、Opportunity Model、Solver、UI、GTO 数据与 HUD 系统。

**结论**：`RIVER_BET_RANGE_V2 — PASS_WITH_WARNINGS`

---

## 0. 八项结论

| 结论 | 判定 | 依据（可复现） |
|---|---|---|
| `BET_EVENT_COUNTED_ONCE` | **YES** | 到达范围改成「同一条范围更新链在**当前下注之前**」的捕获快照；实测**只改下注尺寸时到达范围逐位不变**（0.755247 / 顶对带 39.8556% 在 40/16/8 筹码三次运行完全相同），而旧口径会随尺寸漂移（0.659153024 → 0.659609040）。见 `M1/M6` 测试与 `reports/evidence/rbrv2-acceptance.txt`【7】 |
| `SHOWDOWN_ZERO_FILTER_FIXED` | **YES** | `P(BET\|SHOWDOWN_VALUE)` 不再夹到 0：改为**公共强度带**细分 + `softplus` 结构性非退化。实测被动画像下 摊牌类质量 0.000000 → 0.443889；弱顶对/中对/底对率 0.023000 / 0.005001 / 0.003000（全部 > 0 且随画像变化）。见 `D-2`/`D-3`/`M3` 测试 |
| `NO_HERO_HIDDEN_HAND_LEAKAGE` | **YES** | 权重只读公共信息（底牌 + 公共牌 + 尺寸 + 牌面纹理 + 画像）。实测：同一批组合在两副完全不同的 Hero 底牌下，**逐组合权重与逐带质量逐位相同**（旧实现 66/66 个组合全部变化）。见 `M5`/`D-1` 测试 |
| `BET_RANGE_EQUITY_VALID` | **YES** | 下注范围构成 = 到达范围 × P(BET\|带)，归一化后 Σp = 1；用产品 API 在外部**独立复算**得到 0.448857，与引擎 `math.heroEquityVsBetRange` **逐位一致**（< 1e-12）。见 `reports/evidence/rbrv2-sensitivity.txt` 首行 |
| `CALL_EV_USES_CORRECT_RANGE` | **YES** | `CALL EV = EqVsBetRange × winnable − callCost` 恒等式成立（+19.697943 = 0.448857 × 133 − 40）；`BR-1` 同时锁住「不得等于用整体范围权益算出的数」 |
| `PROFILE_STAT_ROUTING_PRESERVED` | **YES** | `FoldTo*` 三项**逐位不改变**下注范围（`BR-10` 通过）；主动下注信号只来自画像的 aggression / bluffTendency / passivity 三条**语义正确**的轴；`streetBetScale` **未**接入（避免把响应类统计接进主动下注）；无新增代理变量 |
| `SAFE_TO_CONTINUE_HAND_TESTING` | **YES（附警告）** | 全仓 **1,893 项测试 / 1,891 通过**（余下 2 项为产物清单，已重新生成后通过，见 §7）；4 处旧断言按「契约变更」改写并逐条记录理由。警告：下注权重的**幅度**仍是未校准先验，本节点动作对「顶对是否下注」这一条假设敏感（§6） |

---

## 1. 第一阶段：冻结旧结果

`scripts/rbrv2-freeze-before.ts` → `reports/evidence/rbrv2-before.json`

| 量（AK 河牌面对 40 筹码） | 旧值 |
|---|---|
| 链条「到达范围」权益（实为后验） | 0.659153024494907 |
| 真正的下注前到达范围权益 | 0.7552466429154752 |
| `math.heroEquityVsBetRange` | 0.005433446930540442 |
| 下注范围构成 | 价值 99.4567% / 摊牌 0.0000% / 诈唬 0.5433% |
| `math.callEV` | −39.277351558238124 |
| 动作 | FOLD |

**旧缺陷的直接证据（只改当前下注尺寸）**：

```
③ 真正到达范围权益： 0.7552466429154752 → 0.7552466429154752   （应当相同）
④ 引擎「到达范围」： 0.659153024494907  → 0.6596090398280883   （随尺寸漂移 ⇒ BET 似然已在链上计过一次）
```

**先写测试（修改产品代码之前）**：`test/riverBetRangeV2Defect.test.ts`

```
✖ D-1（信息泄漏）：同一对手组合的下注权重不得随 Hero 隐藏底牌变化   （66/66 个组合变化）
✖ D-2（结构性过滤）：被动画像下「有摊牌价值的牌」不得整类消失        （showdownMass = 0）
✖ D-3（结构性过滤）：下注范围里必须有「Hero 能击败的成手牌」         （一个都没有）
ℹ pass 0 / fail 3
```

---

## 2. 第二阶段：消除重复下注更新（单一可追踪路径）

### 问题定位

| 问题 | 答案 |
|---|---|
| 河牌下注前的到达范围是什么 | **同一条范围更新链在「当前下注」这一步之前的状态**（翻前/翻牌/转牌的跟注与更早的进攻动作都已施加似然） |
| 当前 BET 事件在哪一步进入模型 | `contextBuilder.applyLikelihoodUpdates`：对**每一个**进攻动作施加似然 —— 包括**当前这一次**（`updateTrace` 最后一条 = `RIVER/BET`） |
| 有没有重复计算 | **有**。`buildBettingRangeFacts` 又乘了一次 `P(BET\|手牌)` ⇒ 同一条动作的似然被平方 |
| 两次权重的条件概率定义 | ① 历史动作似然：`P(他做了那个动作 \| 手牌)`；② 当前下注权重：`P(他下注这个尺寸 \| 公共强度带, 牌面, 画像)`。**互不重叠**，各自只计一次 |

### 修改（`src/app/manualInput/contextBuilder.ts`）

```text
① 到达范围    = 本链在「当前下注」之前的状态        ← applyLikelihoodUpdates 的 captureBeforeActionIndex（引用捕获，零额外计算）
② 下注范围    = ① × P(BET | 公共强度带, 尺寸, 牌面, 画像)   ← 当前下注只在这里计一次
③ range（默认）= ① × P(当前下注 | 手牌)             ← 原有语义完全不变（决策层的整体范围口径）
```

- 只跳过**一条**记录（`state.actions` 里本街最后一个进攻动作），**不是**关闭全部历史过滤；
- 其余对手的范围语义逐位不变；求解器范围路径下到达范围 = 该范围本身；
- 捕获失败时**写警告并回落**，不静默换口径。

### 实测

| 项 | 修复前 | 修复后 |
|---|---|---|
| `EqVsArrivalRange`（真值，40/16/8 筹码） | 无此量（被当成 0.659153） | **0.755247 / 0.755247 / 0.755247** |
| `EqVsBetRange` | 0.005433446930540442 | **0.448857** |
| 独立复算与引擎是否一致 | — | 逐位一致（< 1e-12） |

---

## 3. 第三阶段：修复 SHOWDOWN 整类清零

### 修改（`src/app/manualInput/bettingRange.ts`）

1. **公共强度带**（`PublicStrengthBand`，9 档）：坚果 / 强成手 / 两对 / 超对 / **顶对·好踢脚** / **顶对·弱踢脚** / 中对 / 底对 / 高牌。
   顶对按「**底牌里那张踢脚**是否 ≥ 牌面第二高点」细分（标准 top pair, good kicker）。
2. **非退化变换**：`soft(x) = s·ln(1+e^(x/s))`，`s = 0.06`。性质：恒 > 0；`x ≥ 2s` 时 `soft(x) ≈ x`（强价值锚不被改写，实测 +0.3%）；`x → −∞` 时指数衰减。
   ⚠️ 它**不是固定下限**：每个带的值仍由画像 / 尺寸 / 牌面共同决定，软化只改变「趋近 0 的方式」。
3. **强度阶梯护栏**：`NUT = STRONG_MADE ≥ TWO_PAIR ≥ OVERPAIR ≥ TOP_PAIR_GOOD ≥ TOP_PAIR_WEAK ≥ MIDDLE_PAIR ≥ WEAK_PAIR`（AIR 独立）。它只做「取相邻上界的较小值」，不引入任何常数。
4. **尺寸 / 牌面 / 画像全部进入权重**：尺寸极化沿用 §二十一 的指数（锚点 2/3 不变），牌面纹理（DRY/PAIRED/WET/MONOTONE）调制薄价值与摊牌档。
5. **不确定性显式化**：`model.kind = 'PUBLIC_BAND_SOFT_V2'`、`evidence = 'HEURISTIC_STRUCTURAL'`、`nonDegenerate = true`、`usesHeroHiddenCards = false`，并把全部系数写进 `model.factors`。

### 修复过程中发现并修掉的两个**新**缺陷（自测抓到）

| 缺陷 | 现象 | 修法 |
|---|---|---|
| 带系数乘在**锚点**上 | 被动锚为负时 `×0.6` 反而更接近 0 ⇒ **底对下注率高于中对**（序关系被翻转） | 系数改乘在**变换后的正速率**上 |
| 踢脚判据用了 `describeHand().kickerRank` | 该值是「最佳五张里第二高点」，在 K-9-4-6-2 上持 K8 时它**就是公共牌的 9** ⇒ 「弱顶对」这一档**永远为空**（到达质量 0.0000%） | 改用**底牌自己那张踢脚**与牌面第二高点比较 |

### 实测（AK 节点，40 筹码，CALLING_STATION）

| 公共强度带 | 到达权重 | P(BET \| 带) | 下注权重 |
|---|---|---|---|
| 强成手（三条） | 6.108% | 0.245230 | 34.651% |
| 两对 | 10.921% | 0.052272 | 13.206% |
| 超对 | 3.350% | 0.044431 | 3.443% |
| **顶对·好踢脚** | 39.856% | **0.040249** | 37.109% |
| **顶对·弱踢脚** | 7.572% | **0.023000** | 4.029% |
| 中对 | 25.394% | 0.005001 | 2.938% |
| 底对/小对子 | 4.519% | 0.003000 | 0.314% |
| 高牌（含错失听牌） | 2.281% | 0.081696 | 4.310% |

与 Hero 的关系（**仅用于解释**）：价值 51.301% / 摊牌 44.389% / 诈唬 4.310%（修复前：99.4567 / 0 / 0.5433）。

---

## 4. 第四阶段：信息泄漏

**修改前**：权重取自 `riverComboClassOf().category`，而该类别由 `compareHands(他的手牌, Hero 的手牌)` 决定（上帝视角）。
实测：同一批组合、同一牌面、同一下注额、同一画像，只换 Hero 底牌 ⇒ **66/66 个组合的下注权重全部变化**（如 K♣K♥：0.047656 vs 0.043621）。

**修改后**：

| 层 | 输入 | 用途 |
|---|---|---|
| Villain 下注行为模型 | 底牌 + 公共牌 + 尺寸 + 牌面纹理 + 画像维度 | **唯一控制权重的层**（不读 Hero 底牌） |
| Hero 对下注范围的权益 | 下注范围 × Hero 底牌 | 权益计算（角色互换，与行为模型解耦） |
| 相对 Hero 的类别（value/showdown/bluff 质量） | 逐组合精确比较 | **仅解释与报告**，不参与任何权重 |

实测：换 Hero 底牌后，逐带下注质量、下注率、下注占比**逐位相同**（`M5`）。
`buildBettingRangeFacts` 的入参注释明确标注 `heroHole` **只用于合法阻断与报告**。

---

## 5. 第五阶段：统计语义

| 检查 | 结果 |
|---|---|
| `FoldToRiverBet` 是否被用来预测他自己的主动下注 | **否**。单变量扫描（0.05 / 0.95）不改变下注范围任何一位（`BR-10` 通过） |
| 主动下注信号来源 | 画像的 `aggression` / `bluffTendency` / `passivity`（`ResponseTendencies.effectiveDimensions`）—— 语义正确的先验轴 |
| `streetBetScale`（V3 分街系数） | **刻意不接入**：它由响应类统计融合而来，接进主动下注模型就是统计语义串线 |
| 新增代理变量 | **无** |

---

## 6. 第六阶段：墨菲定律对抗测试

`test/riverBetRangeV2.test.ts`（10 项，全部通过）

| 编号 | 断言 | 结果 |
|---|---|---|
| M1 | 只改尺寸 ⇒ 到达范围逐位不变、下注范围随之变化、尺寸口径如实 | ✔ |
| M2 | 只改下注权重（诈唬注入 0 ↔ 1）⇒ `EqVsBetRange` 正确变化、归一化仍为 1 | ✔ |
| M3 | 被动玩家可持弱顶对/中对下注，但空气率必须 < 强价值率的一半、诈唬质量 < 价值质量 | ✔ |
| M4 | MANIAC 的弱牌（顶对弱/中对/底对/空气）下注率 > NIT（**不锁动作**） | ✔ |
| M5 | 换 Hero 底牌不得改变逐带质量 / 下注率 / 下注占比 | ✔ |
| M6 | 到达范围与下注尺寸无关；模型自述 `usesHeroHiddenCards = false` | ✔ |
| M7 | 仍存在**正确的 FOLD** 节点（A 高面对窄范围 ⇒ `callEV < 0` 且动作 ≠ CALL） | ✔ |
| M8 | 零权重 / 空范围 / 全死牌 / 下注额 0 / 负 / NaN / ∞ / 底池 0 / 牌面不足 / 底牌不足 ⇒ `null`；合法阻断只扣该组合 | ✔ |
| M8b | 81 组极端画像 × 6 组尺寸：所有带**有限、∈(0,1)、满足强度阶梯** | ✔ |
| M9 | X→Y→X 三次运行逐位一致（无缓存污染）；三个权益口径互不相同；EV 恒等式成立 | ✔ |
| M10 | 全仓测试（见 §7） | ✔ |

**敏感性（未校准假设的影响幅度）** —— `reports/evidence/rbrv2-sensitivity.txt`：

| 情形（只改一个带的系数） | EQ(下注范围) | CALL EV | 动作 |
|---|---|---|---|
| 顶对 ×0（＝修复前的整类清零） | 0.1285 | −22.92 | FOLD |
| 顶对 ×0.25 | 0.2443 | −7.51 | FOLD |
| 顶对 ×0.5 | 0.3301 | +3.91 | CALL |
| **基准** | **0.4489** | **+19.70** | **CALL** |
| 顶对 ×2 | 0.5825 | +37.47 | CALL |
| 中对/底对 ×0 | 0.4303 | +17.23 | CALL |
| 诈唬 ×0 / ×2 | 0.4240 / 0.4716 | +16.40 / +22.73 | CALL |
| 强成手 ×2 | 0.3333 | +4.34 | CALL |
| 到达范围 × **旧类别模型**（＝去重复计费后的旧模型） | 0.0760 | −29.90 | FOLD |

⇒ 本节点的动作在「顶对系数 ≈ 0.4」处翻转。**决策的数值稳健性依赖于一条未校准假设**（这正是必须随结果一起报告的东西）。

---

## 7. 第七阶段：功能验收（原样重跑 AK 节点）

`scripts/rbrv2-acceptance.ts` → `reports/evidence/rbrv2-acceptance.txt`

| 输出 | 值 |
|---|---|
| 真正的河牌下注前 Arrival Range | 支持 **469** 组合；被排除的动作 = 下标 14（大盲位，本街最后一次进攻） |
| **Hero EqVsArrivalRange** | **0.755247**（与下注尺寸无关） |
| 当前 40 筹码的 Villain Bet Range | 组合 469；下注质量 0.043228；他会下注的比例 **4.323%**；有效组合数见 `effectiveComboCount` |
| **Hero EqVsBetRange** | **0.448857** |
| `math.heroEquity`（链条整体范围口径，决策层既有用法） | 0.659153 |
| **CALL EV** | **+19.697943**（= 0.448857 × 133 − 40） |
| **FOLD EV** | 0 |
| 最终动作 | **RAISE（174）** |
| 决策依据 | `POSTFLOP_ROLE`（中等价值 0.62）→ `MATH_CALL_SUPPORTED`（权益 65.9% > 所需 30.1%，跟注 EV +19.70）→ `STRATEGIC_RAISE_FOR_VALUE`（低 SPR 承诺放行） |

逐牌型到达/下注权重见 §3 表；逐组合（前 24，按下注权重降序）见验收文件【6】，例如
`KhQc`（顶对 K，Q 踢脚）到达 1.505e-2 → P(BET) 0.040249 → 下注 6.057e-4 → 归一化 0.014012，HeroEq = **1.00**。

---

## 8. 根因 Before / After 对照

| # | 根因 | 修改函数 | Before | After |
|---|---|---|---|---|
| 1 | 当前 BET 似然重复应用 | `contextBuilder.applyLikelihoodUpdates`（新增 `captureBeforeActionIndex` + `rangeBeforeAction`）、`buildRangeSnapshot`、`buildDecisionContext`（4c 段） | 到达范围 = 后验（0.659153，随尺寸漂移）；下注范围 = 后验 × P(BET) | 到达范围 = 链上本动作**之前**的快照（0.755247，与尺寸无关）；下注范围 = 到达 × P(BET) 计一次 |
| 2 | SHOWDOWN 整类清零 | `bettingRange.ts`：`betProbabilityByClass` → `betProbabilityByBand` + `publicStrengthBandOf` + `softPositive` + 强度阶梯 | `P(BET\|SHOWDOWN)=0`（精确），摊牌质量 0.0000，下注范围 99.46% 是击败 Hero 的牌 | 9 档公共强度带，全部 > 0 且随画像/尺寸/牌面变化；摊牌质量 0.443889 |
| 3 | 权重依赖 Hero 隐藏底牌 | `bettingRange.ts`：权重与「相对 Hero 的类别」解耦 | 66/66 个组合权重随 Hero 底牌变化 | 逐位不变（类别只用于解释） |
| 4 | 口径混用（名实不符） | `contextBuilder`（`betRangeArrival` 对象 + `heroEquityVsArrivalRange`）、`decision.types.ts`、`decisionEngine.postflopSnapshotOf` | `math.heroEquity` 被读作 `EqVsArrivalRange` | 三个口径各自成字段：到达 / 下注 / 整体；`callEV` 只用下注范围 |

**测试证据**

| 文件 | 内容 |
|---|---|
| `test/riverBetRangeV2Defect.test.ts` | 修改前 **3 项全红**（复现旧缺陷）；修改后全绿 |
| `test/riverBetRangeV2.test.ts` | M1–M10 共 10 项 |
| `test/test09BetRangeAudit.test.ts` | `BR-2` 契约变更：与**到达范围**比较（而非后验） |
| `test/postflopRegressionCases.test.ts` | `TEST 4` 契约变更：动作不再锁死 FOLD，改由 EV 符号决定 |
| `test/profileRangeAdjustment.test.ts` | `T2` 契约变更（到达范围比较 + BLUFF_HEAVY/MANIAC 容差）；`T13` 边缘节点改用「诈唬全关」构造 |

**全仓验证**：`node node_modules/typescript/bin/tsc --noEmit` 通过；`node --experimental-strip-types "scripts/generateManifest.ts" --check`
= 全部 155 个产物与清单一致；`node --test --experimental-strip-types "test/**/*.test.ts"`
= **1,893 项 / 1,893 通过 / 0 失败**（86.4 秒）。

---

## 9. 未解决的模型假设（必须随结论一起读）

1. **带系数的幅度未校准**（`TOP_PAIR_GOOD ×0.70`、`TOP_PAIR_WEAK ×0.40`、`MIDDLE_PAIR ×1.00`、`WEAK_PAIR ×0.60`、`OVERPAIR ×0.85`、`TWO_PAIR ×1.00`）。
   它们只声称**序关系**；本节点动作在顶对系数 ≈0.4 处翻转。**没有一个真实统计支撑这些数字** —— 需要「按手牌类别的河牌主动下注频率」才能校准。
2. **软化尺度 `s = 0.06`** 是「去退化」的数值选择：它决定了被动画像的摊牌档率（≈0.3%–3%），同样未校准。
3. **锚点公式沿用修复前**（`value/thin/show/bluff`），只有夹取方式变了。锚点本身是否合理，本轮未评审。
4. **`math.heroEquity` 与 `heroEquityVsBetRange` 仍是同一条件概率的两个估计**（链条似然 vs 专用下注模型）。两者不再重复计费，但可以相差数个到十个百分点（TEST 09 节点：22.55% vs 31.63%）。决策层的加注门槛仍读前者、跟注 EV 读后者 —— 本轮**未**统一（那属于决策层口径改动，超出定向修复范围）。
5. **软权重下没有任何组合被精确清零** ⇒ `entryCount` 恒等于到达支持集；「下注范围有多宽」必须看新增的 `effectiveComboCount` / `posteriorMassCombos90`。
6. **未接入实测主动下注统计**（`PlayerObservedStats` 里根本没有 `riverBet`/`donkFrequency` 这类字段，`normalizeObservedStats` 会把它们显式列为「未进入模型」）。这是**故意的**：宁可留空缺，也不拿 `FoldToRiverBet` 之类的响应统计冒充。

## 10. 建议的下一步（本轮**未**实施）

1. 用真实数据标定「按公共强度带的河牌主动下注频率」，替换 §9.1 的系数。
2. 决策层加注门槛改用**下注范围权益**（或在两处显式标注口径差异）。
3. 把 `betRangeArrival` 与 `bandMasses` 接到界面诊断区（当前只在 `diagnostics` 里）。
