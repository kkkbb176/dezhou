# V2.1 独立评审 1 —— 统计与有效样本量（STATISTICS & EFFECTIVE SAMPLE SIZE）

> **评审范围**：V2.1 画像审计的**统计方法论**（不是只复核数字）。
> **评审方式**：全部结论来自**本轮真实执行**的独立探针（自带脚本、不调用审计脚本的聚合代码），
> 并用**逐格 bit 级比对**与审计产物交叉验证。
> **本文件由 Reviewer 1 独立撰写，未修改 `src/` 或 `test/` 任何文件。**

---

## 0. 环境事实与产物状态（先说清楚读数前提）

| # | 事实 | 证据 |
|---|---|---|
| E1 | 审计产物 **`reports/evidence/v21-profile-sensitivity.json` 在评审期间被重写**：18:35:14 的版本 schema = `{meta, corpus}`（只有 64 行 8 场景语料，**没有矩阵**）；19:00:09 的版本 schema = `{meta, matrix}`（1260 行矩阵，**没有语料**） | 两次 `Object.keys()` 实测；文件 116693 B → 1625511 B |
| E2 | 因此「1260 组合敏感度矩阵」在我开始评审时**并不在产物里**；我按脚本 `scripts/v21-profile-sensitivity-audit.ts` 的定义**独立重跑**了全部 1260 格 | `scripts/v21-rev1-matrix-distinct.ts` |
| E3 | 单格真实管线成本实测 **798–1178 ms**（`analyzeManualHand` + `buildDecisionContext` 两次管线）；1260 格逐格重跑 ≈ **1005–1485 s** | 探针计时输出 |
| E4 | 审计自报「总耗时 745.2 s」只统计了 `elapsedMs`，而该字段在脚本 `:383-386` 只包住 `analyzeManualHand`，**不含**同一行 `:438` 的 `buildDecisionContext` ⇒ 真实墙钟约为其 2 倍 | 脚本 `:382-386` / `:433-480` |
| E5 | `node --test` 的 EPERM 问题本轮**未触发**（我全部改用直接执行探针脚本测量，不依赖测试跑） | 本文件所有数字均来自直接执行 |
| E6 | 评审期间出现了 4 份其它 Agent 的报告（`V21_REVIEW_2/3/4/5_*.md`）与 `reports/evidence/v21-summary.md`；**审计的正式主张以 `v21-summary.md` 为准** | 见各 ITEM 的 CLAIM 段 |
| E7 | 全程**未执行**任何 git 写操作；未修改 `src/`、`test/` | — |

**审计的头部主张（本评审的 CLAIM 来源）** —— `reports/evidence/v21-summary.md`：

- `:3-9` 组合数 1260、实际行数 1260、可分析 1260、**不同权益值 267**、**不同诈唬质量 267**、动作恒 `CALL`、总耗时 745.2 s。
- `:28-29` **max |equityDelta| = 1.9761pp**、**max |bluffMassDelta| = 4.5242pp**，同一格 `BLUFF_HEAVY / E3_TAG_PRIOR_REASSERTED / N1000_LARGE / dev=0.95`。
- `:37-42` materiality = **TRIVIAL**（0.0198 vs 0.02 阈值 = 0.99×；0.0452 vs 0.05 = 0.90×）。
- `:48` action flip = **0 / 1260**。
- 脚本 `:19-30` 档位定义：7 样本档 × 9 原型 × 5 偏离 × 4 证据强度。
- 脚本 `:50-58`「固定设置」：`asOf` 固定、budget 宽裕（不会换型）、`equitySeed` 固定、`writeLog:false`。
- JSON `meta.unitNotes.bluffMass`：`概率质量占比（0..1）；分母 = 该对手可达组合的后验质量之和（不含与 Hero/公共牌重叠者）`。

---

## 1. VERDICT 总表

| # | 主题 | 审计的主张 | 我的独立结论 | CONFLICT |
|---|---|---|---|---|
| 1 | 收缩估计量 / 7 档样本轴 | 7 档 = 0/2/5/20/50/200/1000 机会数；5 偏离档 = 0.05/0.20/0.45/0.65/**0.95** 是「生产入口自己的刻度」 | 7 档与独立公式**完全正确**（315/315 bit 相同，1260/1260 逐格 bit 相同）；**但第 5 档 0.95 不在生产刻度上 —— 模型里 `VERY_HIGH = 0.80`** | **YES**（1 处刻度错标 + 1 处 `SampleTier` 归属误述） |
| 2 | 「无观测」vs「观测到 0 次」 | 两者必须分开；`n=0 ⇒ observedRate=null, effectiveRate ≡ 先验`；`n>0,s=0 ⇒ 后验被真的拉低` | **全部成立**，且 `effectiveRate` 与 `priorRate` **逐位相同**（IEEE 位 = `0x3fc3333333333333`，135/135 组合全同） | NO |
| 3 | `confidence` 是否有意义 | 「实测强度即置信度 0.35 上限（`MANUAL_READ_CONFIDENCE_CAP`）」 | `confidence = n/(n+6)` 是**收缩权重本身**（数学上有意义），但**没有任何阈值读它**；`MANUAL_READ_CONFIDENCE_CAP` 在 `src/` 里**零读者（死常量）**；真正进入「画像→范围」的是**另一个** confidence | **YES** |
| 4 | 蒙特卡洛分辨率 | 固定种子 + 宽裕预算「钉住」权益估计 | S1 河牌节点**必然是精确枚举**（bound 990 ≤ 500000），实测 `{method:EXACT, iterations:990, confidenceHalfWidth:0}`，**采样标准误 = 0** ⇒ 1–2pp 差别不是「可分辨」而是**精确**；但**响应模型的 6000 次抽样**不在该主张覆盖范围内，其 ~1pp 差别**在噪声内** | **YES（局部）** —— 主结论对，覆盖范围被夸大 |
| 5 | 样本量轴是否接线 | 7 档样本轴是敏感度矩阵的一个维度 | `opportunities` **只**通过 `effectiveRate` 起作用；**没有任何最小样本量闸门**；`unknownOutcomeOpportunities` 对模型**零影响**；且生产入口**无法填充** `observed`（该轴只能由直接调用方手工构造） | **YES（未披露）** —— 数值对，性质未披露 |
| 6 | 多重比较 / 选择性 | 1260 格上报 max \|Δ\| | 1260 格只有 **305 个不同调用指纹 / 267 个不同结果**（简并 4.13×/4.72×）；**E2 整块（315 格）被 E1 包含、零新增**；E3 的 N0 档（45 格）与 E0 逐位重复；max 本身**复现无误**（1.9761pp / 4.5242pp，同一格） | **YES（可比性/覆盖）** —— 数字对，「1260 组合」的说法误导；另有 MANIAC 漏测被写成 ❌ |
| 7 | `bluffMass` 分母 | 「分母 = 对手可达组合的后验质量之和」 | `totalMass` 确实排除 Hero/公共牌（`:226-228`）；但 **`bluffMass` 源码上并未除以 `total`** —— 它的隐含分母是 **1（整个范围）**；本夹具 `totalMass = 1.0000000000000047`，两口径差 4.7e-15 ⇒ **数值对、公式错** | **YES（公式）** |

---

## ITEM 1 —— 收缩估计量的行为是否如审计所称

### CLAIM

脚本 `:19-22`：

> 样本量 7 档：0 / 2 / 5 / 20 / 50 / 200 / 1000 **机会数** —— 覆盖收缩公式 `(prior×6+s)/(6+n)` 的三个区制（n≪6 / n≈6 / n≫6）、**`SampleTier` 的 30 / 200 两个阈值**、以及 n=0 的「无观测」边界

脚本 `:24`：

> 偏离程度 5 档：`VERY_LOW/LOW/MEDIUM/HIGH/VERY_HIGH` = 0.05/0.20/0.45/0.65/**0.95** —— **生产入口自己的刻度**（`manualReadEvidence` 的 5 档），不是自造

### EVIDENCE

**(a) 7 档逐档点名核对（脚本 `:523-531` vs JSON `meta.tiers.sample`）** —— 逐项一致：
`N0_NO_OBSERVATION=0`、`N2_TINY=2`、`N5_VERY_SMALL=5`、`N20_PRELIMINARY=20`、`N50_STANDARD=50`、`N200_CONFIRMED_EDGE=200`、`N1000_LARGE=1000`。**无差异。**

**(b) 9 个原型的 `riverBluff` 先验率（实测 import，非抄写）**

| 原型 | 有先验? | priorRate | priorWeight | source | 未观测时 `effectiveRate === priorRate` |
|---|---|---|---|---|---|
| VERY_TIGHT | ✔ | 0.120 | 6 | PROFILE_PRIOR | true |
| LOOSE | ✔ | 0.300 | 6 | PROFILE_PRIOR | true |
| CALLING_STATION | ✔ | 0.150 | 6 | PROFILE_PRIOR | true |
| UNDERBLUFFER | ✔ | 0.120 | 6 | PROFILE_PRIOR | true |
| BLUFF_HEAVY | ✔ | 0.450 | 6 | PROFILE_PRIOR | true |
| UNKNOWN / NORMAL / TIGHT / AGGRESSIVE | ✘ | 0.280 | 6 | ENVIRONMENT_PRIOR | true |

⇒ **9 个标签只有 5 个不同先验率**（0.12 / 0.15 / 0.28 / 0.30 / 0.45），4 个中性标签全部等于 `ENVIRONMENT_BEHAVIOR_PRIOR.riverBluff = 0.28`。

**(c) 独立复算 vs 模型输出（E3 = observed 档，9 原型 × 7 档 × 5 偏离 = 315 格）**

我用自己的公式 `n===0 ? prior : (prior*w + round(rate*n))/(w+n)` 与 `Object.is` 逐位比较：

```text
逐位比较：315 格全部与独立公式一致？ mismatches = 0
```

抽样（`priorRate=0.15` CALLING_STATION，`priorWeight=6`）：

| n | succ(0.95n) | 我的独立复算 | 模型输出 | |
|---|---|---|---|---|
| 2 | 2 | 0.362499999999999989 | 0.362499999999999989 | bit-同 |
| 1000 | 950 | 0.945228628230616263 | 0.945228628230616263 | bit-同 |

**(d) 更强的一步：把审计的 1260 行**逐格**与我的独立重跑比对**

```text
mine 1260  audit 1260  joined 1260
successes 不一致: 0
heroEquity 逐位相同: 1260 / 1260   不同: 0
bluffMass  逐位相同: 1260 / 1260   不同: 0
action 不一致: 0
⇒ 逐位完全一致，最大绝对差 = 0
```

即：审计产物里的**每一个字**（`heroEquity` / `bluffMass` / `action` / `successes`）我都能独立复现，**最大绝对差 = 0**。

**(e) 但第 5 偏离档是错的。** 源码 `behaviorProfile.ts:145-151`：

```ts
const rate = { VERY_LOW: 0.05, LOW: 0.2, MEDIUM: 0.45, HIGH: 0.65, VERY_HIGH: 0.8 }[input.tendency];
```

实测经生产入口 `behaviorProfileOf({ manual: { riverBluff: T } })` 取到的**真正进入模型**的值：

```text
VERY_LOW   → 0.05000000000000000
LOW        → 0.20000000000000001
MEDIUM     → 0.45000000000000001
HIGH       → 0.65000000000000002
VERY_HIGH  → 0.80000000000000004        ← 不是 0.95
```

审计脚本 `:635` 却用 `{ ... VERY_HIGH: 0.95 }` 计算 `successes = round(rate × n)`，并把档名写成 `'VERY_HIGH_0.95'`（`:552`）。后果：

- **E1/E2 两档（manual 通道）的「dev=0.95」实际上是 0.80** —— 审计自己声称这 5 档是「生产入口自己的刻度」，而 0.95 **不在**该刻度上（`manualReadEvidence` 的输出集合 = {0.05, 0.20, 0.45, 0.65, 0.80}）。
- **E3（observed 通道）用 0.95 造成功数** ⇒ 同一个「偏离档」在两个证据强度下**含义不同**（0.80 vs 0.95），跨强度横向比较不成立。
- 实测 E1/E2 的有效率集合：E1 = {0.05, 0.2, 0.45, 0.65, **0.8**}（5 个），E2 = {0.2, 0.45, 0.65}（3 个）。

**(f) `SampleTier` 的 30 / 200 归属误述。** `src/domain/player/playerStats.ts:344-362` 确实有：

```ts
export const SampleTier = { PRELIMINARY, STANDARD, CONFIRMED }
export const DEFAULT_TIER_THRESHOLDS = { preliminaryBelow: 30, confirmedAbove: 200 };
```

但全仓 grep：`SampleTier` 只被 `playerClassifier.ts` 与 `archetypeDimensions.ts` 使用，**`behaviorProfile.ts` 一次都没有**；而且它的输入是 `effectiveSampleSize`（时间衰减后的**有效**样本量，`playerStats.ts:364-378` 注释明说「注意用的是 effectiveSampleSize 而不是原始 opportunities」）。所以 7 档只是**数值上跨过** 30/200，被审计的这条路径**不读** `SampleTier`。

### CONFLICT

**YES —— 两处：**

1. **偏离第 5 档刻度错标**：审计文档与档名写 0.95，模型实测 **0.80**。这不是舍入：0.95 在 `manual` 通道上**不可达**。
2. **`SampleTier` 30/200 归属误述**：这两个阈值属于**另一个子系统**（`PlayerMetricStat` + `effectiveSampleSize`），对 `StatEvidence` / `effectiveRate` **零作用**。

### RESOLUTION

**审计的数字对，刻度描述错。** 7 档枚举、315 格独立复算、以及 1260 格逐格 bit 级一致（最大绝对差 = 0）全部成立 —— 这部分**审计完全正确，我无异议**。需要修的是文字与档名：

- 把 `'VERY_HIGH_0.95'` 改成 `'VERY_HIGH_0.80（manual 刻度）/ 0.95（observed 成功数）'`，或把 E1/E2 的第 5 档显式标注为「0.80（模型上限）」。
- 删掉「`SampleTier` 的 30 / 200 两个阈值」这句，改为「数值上跨过 30/200（该阈值属 `PlayerMetricStat` 子系统，本条路径不读）」。

**附带发现（对审计有利）**：`behaviorProfile.ts:105-114` 声称零机会时旧式会差 1 ULP。我实测**旧式 `(rate×6)/6` 在 0.05、0.20、0.80、0.35 上确实差 1 ULP**：

```text
rate     rate_bits           (rate*6)/6_bits       old===new
0.05     0x3fa999999999999a  0x3fa999999999999b   false
0.2      0x3fc999999999999a  0x3fc999999999999b   false
0.8      0x3fe999999999999a  0x3fe999999999999b   false
0.35     0x3fd6666666666666  0x3fd6666666666665   false
0.15     0x3fc3333333333333  0x3fc3333333333333   true   ← 源码注释举的 0.2 是真的，0.15 恰好不是
```

⇒ 该 `opportunities === 0` 分支的**存在理由成立**，且恰好保护了 manual 刻度里的 0.05 与 0.80 两档。

---

## ITEM 2 —— 「无观测」是否真的不同于「观测到 0 次」

### CLAIM

脚本 `:564-570`：

> ⚠️ **「无观测记录」与「观察到零次」必须分开**：
> - `opportunities === 0` ⇒ 不传 `observed`（`observedRate = null`，`effectiveRate ≡ 先验`）；
> - `opportunities > 0, successes = 0` ⇒ 传 `observed`（`observedRate = 0`，后验被真的拉低）。

### EVIDENCE

**(a) 逐位（bit）验证** —— `priorRate = 0.15`，`priorWeight = 6`：

```text
n=0        observedRate=null  effectiveRate=0.14999999999999999445
           effectiveRate === priorRate ? true  (Object.is=true)
           priorRate     的 IEEE 位 = 0x3fc3333333333333
           effectiveRate 的 IEEE 位 = 0x3fc3333333333333      ← 逐位相同
n=5,s=0    observedRate=0     effectiveRate=0.08181818181818180380
           n=0 严格大于 n=5,s=0 ? true   差 = 0.06818181818181819065
confidence n=0 → 0 ; n=5 → 0.45454545454545453
```

**(b) 扫描**：9 个原型先验率 × 5 个先验权重({0,1,3,6,12}) × 3 个成功数({0,1,7}) = **135 例，逐位不同 = 0**。

**(c) 「观测到 0」的真实代价**（`priorRate=0.15`，`priorWeight=6`）：

| n | successes | effectiveRate | confidence |
|---|---|---|---|
| 0 | 0 | 0.150000000000 | 0.000000 |
| 2 | 0 | 0.112500000000 | 0.250000 |
| 5 | 0 | 0.081818181818 | 0.454545 |
| 20 | 0 | 0.034615384615 | 0.769231 |
| 50 | 0 | 0.016071428571 | 0.892857 |
| 200 | 0 | 0.004368932039 | 0.970874 |
| 1000 | 0 | 0.000894632207 | 0.994036 |

**(d) 端到端（管线级）验证** —— 审计自己的 `reports/evidence/v21-decision-impact.json` 里：

| 画像 id | heroEquity | bluffMass |
|---|---|---|
| `TAG_MANIAC` | 0.5766449214663655 | 0.04996519898363892 |
| `OBS_ZERO_OPPORTUNITIES`（MANIAC + `observed {successes:0, opportunities:0}`） | **0.5766449214663655** | **0.04996519898363892** |

两行**逐位相同**（我的 1260 格重跑同样得到这一对完全相同）⇒ 「传了 observed 但机会数为 0」在全生产链上**确实等价于**「没传 observed」，与审计声明一致。

**(e) 唯一保留意见（不是冲突）**：`n=0` 但 `successes>0` 时信息被**静默丢弃**：

```text
successes=1     n=0 → successes=0 observedRate=null effectiveRate=0.150000 (== 先验)
successes=1000  n=0 → successes=0 observedRate=null effectiveRate=0.150000 (== 先验)
```

`behaviorProfile.ts:99` 的 `Math.min(opportunities, input.successes)` 把矛盾输入压成 0，不抛错、不进 `noteZh`。语义上「没有机会就没有数据」是对的，但调用方打错了字段（例如把 `opportunities` 忘传）时**不会得到任何提示**。建议：`successes > 0 && opportunities === 0` 时在 `noteZh` 里显式记一句。

### CONFLICT

**NO。** 审计的这条声明**完全正确**，且是逐位级别的正确。

### RESOLUTION

**审计对。** 证明它的数字：`effectiveRate` 与 `priorRate` 的 IEEE 位串完全相同（`0x3fc3333333333333`），而 `{0/5}` 给出 0.08181818181818180380 —— 严格更小，差 0.06818181818181819065。端到端 `TAG_MANIAC` 与 `OBS_ZERO_OPPORTUNITIES` 的权益/诈唬质量逐位相同。

---

## ITEM 3 —— `confidence` 字段是否有意义

### CLAIM

脚本 `:25-26`：

> 「实测」强度即置信度 0.35 上限，故用 `manual` 表达（`MANUAL_READ_CONFIDENCE_CAP`）

风险登记册 D4（`reports/V21_RISK_REGISTER.md:96-97`）：

> `ARCHETYPE_CONFIDENCE = 0.35`（`archetypeDimensions.ts:159`）与 `MANUAL_READ_CONFIDENCE_CAP = 0.35`（`behaviorProfile.ts:76`）**就是这条通路的可信度上限**。

### EVIDENCE

**(a) 7 档 `confidence = n/(n+6)` 实测**（与我的复算逐位一致）：

| tier | n | confidence | 1−confidence |
|---|---|---|---|
| N0_NO_OBSERVATION | 0 | 0.000000000000 | 1.000000000000 |
| N2_TINY | 2 | 0.250000000000 | 0.750000000000 |
| N5_VERY_SMALL | 5 | 0.454545454545 | 0.545454545455 |
| N20_PRELIMINARY | 20 | 0.769230769231 | 0.230769230769 |
| N50_STANDARD | 50 | 0.892857142857 | 0.107142857143 |
| N200_CONFIRMED_EDGE | 200 | 0.970873786408 | 0.029126213592 |
| N1000_LARGE | 1000 | 0.994035785288 | 0.005964214712 |

`n/(n+6) ≥ 0.35 ⇔ n ≥ 3.230769…`；`MANUAL_READ_CONFIDENCE_CAP = 0.35` 若按 `priorWeight=6` 解释，对应约 **3.23 次机会**。

**(b) `confidence` 在数学上**不是**没有意义** —— 它就是收缩权重：

```text
effectiveRate = (π·w + r·n)/(w + n) = π + (r − π)·n/(w+n) = π + (r − π)·confidence
```

数值核对：`0.15 + (1.00−0.15)×0.25 = 0.3625`（n=2, s=2 ✓）；`0.15 + (0.95−0.15)×0.994035785288 = 0.945228628`（n=1000, s=950 ✓）。

**(c) 但没有任何阈值读它。全仓 grep 结果：**

| 常量 / 字段 | 定义处 | `src/` 内的读者 |
|---|---|---|
| `MANUAL_READ_CONFIDENCE_CAP = 0.35` | `behaviorProfile.ts:76` | **0 处** —— 全仓唯一引用在审计自己的探针 `scripts/v21-fmaudit-model.ts:19` |
| `StatEvidence.confidence` | `behaviorProfile.ts:68/127` | **0 处生产读者** —— 唯一消费 `traits` 的函数是 `estimateUnifiedActionLikelihood`（`behaviorProfile.ts:682`），它只读 `effectiveRate`（`:742, :766, :804, :821, :841`） |
| `'profile.stat.confidence'`（i18n） | `zh-CN.ts:536` | **0 处** —— viewmodel 与 `src/app/web/*.js` 均无引用 |
| `MANUAL_READ_PSEUDO_COUNT = 3` | `behaviorProfile.ts:75` | **有**（`:156, :446`，作为 manual 的 `priorWeight`） |

**(d) 真正进入「画像→范围」的是**另一个** confidence（必须区分）：**

```text
profileProvider.ts:59,76    ProfileProviderConfig.minConfidence = 0.2
profileProvider.ts:165,220  confidence: adjustment.confidence / if (adjustment.confidence < minConfidence) return 1
profileProvider.ts:262,415  const neutral = adjustment.confidence < config.minConfidence
tendencyProvider.ts:43,248,285  同一形态（minConfidence 闸门）
        ↑ 它的来源：
archetypeDimensions.ts:331  confidence: Math.max(measuredConfidence, archetypeConfidence)   // ARCHETYPE_CONFIDENCE = 0.35 (:159)
```

这条链的输入是 `quickProfile → archetypeDimensions → ProfileAdjustment`（**维度通道**，由 `PlayerMetricStat`/`effectiveSampleSize` 驱动），**与 `StatEvidence.confidence` 毫无关系**。全仓不存在名为 `minimumProfileConfidence` 的符号；形近的是上表的 `minConfidence`。

**(e) manual 通道的 `confidence` 恒为 0**（因为走 `n=0` 分支）：

```text
VERY_LOW   confidence=0  priorWeight=3  opportunities=0
LOW        confidence=0  priorWeight=3  opportunities=0
MEDIUM     confidence=0  priorWeight=3  opportunities=0
HIGH       confidence=0  priorWeight=3  opportunities=0
VERY_HIGH  confidence=0  priorWeight=3  opportunities=0
```

⇒ 审计把 E1 叫 `MANUAL_STRONG`、E2 叫 `MANUAL_WEAK`，但**两者在权重/置信度上完全相同**（`priorWeight=3`、`opportunities=0`、`confidence=0`），差别**只在 rate 数值**：E1 = {0.05,0.20,0.45,0.65,0.80}，E2 = {0.20,0.45,0.65}（把极端档向中间折）。

### CONFLICT

**YES —— 三处：**

1. `MANUAL_READ_CONFIDENCE_CAP = 0.35` 在 `src/` 里**零读者**，是**死常量**；把它称作「这条通路的可信度上限」是把一个未被执行的常量说成了闸门。
2. manual 路径的 `confidence` 实测 **≡ 0**（不是 0.35）—— 0.35 与它无关。
3. `MANUAL_STRONG` / `MANUAL_WEAK` 这对命名暗示了置信度差异，而模型里**不存在**该差异。

### RESOLUTION

**审计对「它不构成闸门」这一点是**错的**，对数字无影响。** 精确表述应为：

- `StatEvidence.confidence` **不是 display-only，也不是无用** —— 它是收缩公式里 `observedRate` 的权重（`effectiveRate = π + (r−π)·confidence`），但它的作用**已经被烘焙进 `effectiveRate`**，因此**没有任何外部读者**：无阈值、无闸门、无 UI。
- 真正做闸门的是**另一个** confidence（`ProfileAdjustment.confidence`，门槛 `minConfidence = 0.2`，上界 `ARCHETYPE_CONFIDENCE = 0.35`），属于维度通道。
- `MANUAL_READ_CONFIDENCE_CAP` 应删除或在 `manualReadEvidence` 里真正接上；当前它只是文档承诺。

**消除歧义的最小动作**：在 `behaviorProfile.ts:68` 的注释里写明「本字段是收缩权重，不参与任何门槛」；在 `:76` 的常量上标 `UNUSED`（或删掉）。

---

## ITEM 4 —— 蒙特卡洛分辨率

### CLAIM

脚本 `:50-58`：

> - `budget` 宽裕 ⇒ `equityPolicy` 不会因机器负载在「精确枚举」与「蒙特卡洛」之间换型；
> - `equitySeed` 固定 ⇒ 若真的回落到蒙特卡洛，两侧用**同一个种子**。

### EVIDENCE

**(a) 选型是**结构性**的，与负载无关**（`equityPolicy.ts:50-92`）：

```text
knownCardCount=7  remainingDeck=45  cardsToCome=0
对手组合上界 C(45,2) = 990
精确枚举上界 bound = 990 × C(45,0)=1 ⇒ 990
DEFAULT_MAX_EXACT_MATCHUPS = 500000（equity.types.ts:176,188）
⇒ bound ≤ maxExact ? true ⇒ 河牌**必然是精确枚举**（equityPolicy.ts:75-81）
```

`bound` 与 `deadline` 无关（`applyDeadlineToMethod` 只对 `EXACT` **降级**，不会升格）；河牌的 `cardsToCome = 0` ⇒ `C(45,0) = 1` ⇒ bound 只有 990，**离 500000 差 505 倍**。所以「budget 宽裕」在这里根本不是必要条件。

**(b) 实测 `equitySource`**：

```text
★ 实测 equitySource = {"method":"EXACT","iterations":990,"confidenceHalfWidth":0,"downgradedFromExact":false}
★ heroEquity = 0.5625883726719894
```

对 **305 个不同调用指纹**（覆盖全部 1260 格）统计：

```text
method 分布 = [["EXACT",305]]
iterations 取值 = [990]
confidenceHalfWidth 取值 = [0]
```

⇒ **采样标准误 SE = 0**（`iterations = 990` 是枚举的对局数，不是抽样数；`confidenceHalfWidth = 0` 与 `decision.types.ts:1176` 的注释「本节点是精确枚举，`confidenceHalfWidth = 0`」一致）。

**(c) 所以：1–2pp 的 `equityDelta` 在这里不是「可分辨」，而是**精确**。** 审计上报的 max = 1.9761pp，我的独立重跑得到**同一格、同一值**：

```text
★ max |equityDelta|    = 1.9761pp @ BLUFF_HEAVY/E3_TAG_PRIOR_REASSERTED/N1000_LARGE/devVERY_HIGH_0.95
★ max |bluffMassDelta| = 4.5242pp @ 同一格
```

**(d) 算术（万一真的降级为蒙特卡洛；p ≈ 0.5626，p(1−p) = 0.246082696）**

| n | SE = √(p(1−p)/n) | 95% 半宽 | 两条独立 MC 之差 SE = √2·SE | 1.00pp 差异的 z |
|---|---|---|---|---|
| 1 000 | 1.5687pp | 3.0746pp | 2.2185pp | 0.45 |
| 10 000 | 0.4961pp | 0.9723pp | 0.7015pp | 1.43 |
| 100 000 | 0.1569pp | 0.3075pp | 0.2218pp | 4.51 |
| 1 000 000 | 0.0496pp | 0.0972pp | 0.0702pp | 14.25 |

⇒ **结论**：在 FAST 的 1e6 上限下，1pp 差别 z≈14、2pp z≈28，**可分辨**；在 1e3 下 z≈0.45，**不可分辨**。而 S1 实测是 EXACT ⇒ 上表只是对照，实际**没有噪声**。

**(e) 审计主张**未覆盖**的部分（这才是真正的风险）**：响应模型（弃牌/跟注/加注似然、`betDecision` 的候选 EV）走的是**蒙特卡洛**，每次抽样 **6000 次**：

```text
contextBuilder.ts:1542  const RESPONSE_EQUITY_ITERATIONS = 6000;
contextBuilder.ts:1589      iterations: RESPONSE_EQUITY_ITERATIONS,
```

p ≈ 0.5 时单桶 SE = √(0.25/6000) = **0.6455pp**；两桶之差 √2×0.6455 = **0.913pp** ⇒ **1pp 的 foldLikelihood 差别 z ≈ 1.1，落在噪声内**。而 `equitySeed` 固定只给**可复现性**，不给**准确性**。对 S1 这些字段为 `null`（面对下注 ⇒ `betDecision = null`，主报告 `:450` 亦实测 `"betDecision":null`），所以矩阵结论不受影响；但**翻牌价值下注类场景**（如语料 S4）会带这些字段，任何基于 ~1pp 响应概率差的推论都**不可分辨**。

### CONFLICT

**YES（局部，覆盖范围问题）** ——

1. 「budget 宽裕 ⇒ 不会换型」在本节点是**多余条件**：河牌 `bound = 990` 是结构性精确枚举。
2. 「固定种子 ⇒ 估计被钉住」的表述会让人以为整条链都是确定的；实际上**响应模型的 6000 次抽样**有 0.6455pp/桶的标准误，任何 ~1pp 的响应概率差都在噪声内。

### RESOLUTION

**审计在「这项权益是精确的」这一主结论上完全正确**，而且比它自己说的更强：不是「固定种子钉住」，而是**精确枚举 ⇒ SE ≡ 0**（305/305 配置 `method=EXACT`、`confidenceHalfWidth=0`）。**建议改为**：

> S1 河牌节点 `bound = C(45,2)×C(45,0) = 990 ≤ 500000` ⇒ **必然精确枚举**（与预算/负载无关）；
> 实测 `equitySource = {EXACT, iterations: 990, confidenceHalfWidth: 0}` ⇒ **采样标准误为 0**，1.9761pp 的权益差是精确差。
> ⚠️ 本保证**不延伸到**响应模型：`RESPONSE_EQUITY_ITERATIONS = 6000`（`contextBuilder.ts:1542`）⇒ 单桶 SE ≈ 0.6455pp，响应概率差 < 1pp 不可分辨；`equitySeed` 只保证可复现，不保证准确。

---

## ITEM 5 —— 样本量轴是否接线到任何东西

### CLAIM

脚本 `:21`：把「样本量 7 档」作为敏感度矩阵的一个轴；`:28-30` 只披露「偏离只施加在 `riverBluff` 一条条目上……本矩阵测的是**单条目敏感度**」。

### EVIDENCE

**(a) 模型层：`opportunities` 只进入三个派生量。** `behaviorProfile.ts:98-134` 里 `opportunities` 的全部出现：

```text
:98    const opportunities = Math.max(0, input.opportunities);
:99    const successes = Math.max(0, Math.min(opportunities, input.successes));
:115   const effectiveRate = opportunities === 0 ? priorRate : (priorRate*priorWeight + successes)/(priorWeight + opportunities);
:120   observedRate: opportunities === 0 ? null : successes / opportunities,
:127   confidence: opportunities === 0 ? 0 : opportunities / (opportunities + priorWeight),
```

**没有任何最小样本量闸门**：`n=1` 与 `n=1000` 在结构上无区别，只有数值不同。

**(b) `unknownOutcomeOpportunities` 进入**零**个量**：

```text
unknown=0   → effectiveRate=0.857142857143 confidence=0.892857142857
unknown=900 → effectiveRate=0.857142857143 confidence=0.892857142857
逐位相同 = true   ← 900 次「未知结果」对模型零影响
```

**(c) 全仓 grep：`StatEvidence` 的样本字段没有生产读者。** 搜 `.opportunities` / `observedRate` / `priorWeight`：

- `behaviorProfile.ts` 内部（`:115-127`）—— 只有派生式；
- 其余命中全部是**动态层**的 `MetricStat` / `BaselineMetricStat`（`dynamicStats.ts:89,125,130,220,510,574,583,591`、`dynamicDeviation.ts:291,294,311,345`、`playerClassifier.ts:169,217,218`）—— **不同子系统、不同类型**；
- `SampleTier` / `allowsDirectionalClaim`（`playerStats.ts:344-387`）**未接入** `behaviorProfile`。

⇒ `opportunities` **只通过 `effectiveRate`**（以及那个无人读的 `confidence`）起作用。**审计未在任何地方披露这一点。**

**(d) 端到端影响面（n=10 的 9/10 vs n=1000 的 900/1000，同 0.9 成功率，MANIAC）**

```text
n=10   9/10     effectiveRate=0.75                 confidence=0.625
n=1000 900/1000 effectiveRate=0.8976143141153081   confidence=0.9940357852882704
decision 全字段深度对比：不同路径 75 条
  $.diagnostics.math.heroEquity: 0.5790671613009191 → 0.5831675263242868   (+0.4100pp)
  $.diagnostics.profileRange.equityDeltaPct: 1.6478788628929708 → 2.0579153652297455
  $.diagnostics.range.metrics.entropyBits: 7.54547631122876 → 7.579473328562774
  $.diagnostics.postflop.valueAssessment.weakerShare / strongerShare / … （共 75 条）
动作 A=CALL B=CALL；档位 A=MEDIUM_LOW B=MEDIUM_LOW
equitySource A=EXACT B=EXACT
```

⇒ 变化**全部**是 `effectiveRate` 的下游（0.75 → 0.8976），**没有任何一条**是因为「样本量本身被读过」。

**(e) `effectiveRate` 在 n=2 → n=1000 之间走多远（固定成功率 r）**

解析式：`effectiveRate = π + (r−π)·n/(n+6)`。

`r = 0.95`，`π = 0.15`（CALLING_STATION，w=6），successes = `round(0.95n)`：

| n | successes | effectiveRate | 与先验之差 |
|---|---|---|---|
| 2 | 2 | 0.362500000 | +0.212500 |
| 5 | 5 | 0.536363636 | +0.386364 |
| 20 | 19 | 0.765384615 | +0.615385 |
| 50 | 48 | 0.873214286 | +0.723214 |
| 200 | 190 | 0.926699029 | +0.776699 |
| 1000 | 950 | 0.945228628 | +0.795229 |

⇒ **端点位移 Δ = 0.945228628 − 0.362500000 = 0.582728628**（即 0.15 → 0.945）。若用「恰好 95%」的成功数：n=2 → 0.350000、n=1000 → 0.945228628，Δ = 0.595228628。
对照 `π = 0.45`（BLUFF_HEAVY）：n=2,s=2 → 0.587500000；n=1000,s=950 → 0.947017892644（Δ = 0.359517893）。

**(f) 生产可达性（对样本量轴的釜底抽薪）**：全 `src/` 只有两处调用 `behaviorProfileOf`：

```text
contextBuilder.ts:1205   behaviorProfile ?? behaviorProfileOf({ playerId: 'neutral', archetype: null })     ← 中性回落
contextBuilder.ts:3168-3175  input.behaviorProfile ?? (quickProfile !== 'UNKNOWN' ? behaviorProfileOf({ playerId: villainId, archetype: input.quickProfile }) : undefined)
```

两处**都只传 `archetype`**，无 `manual`、无 `observed`；全 `src/` 内 `observed:` 的命中全部是 `handsObserved`（另一个字段）。⇒ **7 档样本量轴只能由「直接调用 `analyzeManualHand` 并手工构造 `PlayerBehaviorProfile`」的调用方产生**（审计脚本正是这样做）。这独立复现了风险登记册 D4。

### CONFLICT

**YES（未披露，非数值错误）** —— 矩阵把「样本量」列为一个**自变量维度**，但代码里：

1. 它**只**通过 `effectiveRate` 起作用，**不存在**最小样本量闸门（`n=1` 与 `n=1000` 结构等价）；
2. `unknownOutcomeOpportunities`（900 次）对模型**零影响**；
3. 生产入口**无法填充** `observed`，该轴在生产上不可达。

审计的 `:28-30` 只披露了「单条目」，**未披露「无闸门」与「生产不可达」**。

### RESOLUTION

**审计的数值与「单条目敏感度」定性都对，但「样本量轴」这个说法需要加两个限定。** 建议补一句：

> 本轴不是「样本量闸门」的敏感度：`opportunities` 仅通过 `effectiveRate = π + (r−π)·n/(n+6)` 线性重标定一个条目的率（n=2→1000 使该率从 0.3625 走到 0.9452，Δ=0.5827），**不存在**任何最小机会数闸门；`unknownOutcomeOpportunities` 对模型零影响；且生产入口（`contextBuilder.ts:3168-3175`）只从 `quickProfile` 造画像，`observed` 通道**在生产上不可达**（＝风险册 D4）。

---

## ITEM 6 —— 多重比较 / 选择性

### CLAIM

`v21-summary.md:3-9`：**1260 组合**，不同权益值 **267**，动作恒 `CALL`。
`:28-29`：`max |equityDelta| = 1.9761pp`、`max |bluffMassDelta| = 4.5242pp`（同一格）。

### EVIDENCE

**(a) 头部统计量复现 —— 逐格 bit 级一致**

我的独立重跑（305 次真实调用，按指纹展开到 1260 格）与审计的 JSON：

```text
heroEquity 逐位相同: 1260 / 1260   不同: 0
bluffMass  逐位相同: 1260 / 1260   不同: 0
action 不一致: 0        successes 不一致: 0    ⇒ 最大绝对差 = 0
```

`max` 也一致：

```text
★ max |equityDelta|    = 1.9761pp @ BLUFF_HEAVY/E3_TAG_PRIOR_REASSERTED/N1000_LARGE/devVERY_HIGH_0.95
★ max |bluffMassDelta| = 4.5242pp @ 同一格
动作翻转 = 0 / 1260（0.00%）
```

审计 `:6-7` 的「不同权益值 267」也被我独立得到：

```text
不同 heroEquity 取值 = 267 / 1260 格
不同 bluffMass  取值 = 267 / 1260 格
不同 动作       取值 = 1 = ["CALL"]
不同 (equity, bluffMass, 动作) 三元组 = 267
```

**(b) 但 1260 格只有 305 个不同调用。** 调用指纹 = 传入画像的 6 个条目 `effectiveRate/priorWeight/source` + `quickProfile`：

```text
1260 格 → 不同调用指纹 305 个
重复倍数分布（倍数 → 指纹个数）：[[1,232],[2,19],[7,18],[14,9],[21,18],[40,9]]
逐「证据强度」的不同指纹数：
  E0_TAG_PRIOR_ONLY        格 315 → 不同指纹   9
  E1_MANUAL_STRONG         格 315 → 不同指纹  45
  E2_MANUAL_WEAK           格 315 → 不同指纹  27
  E3_TAG_PRIOR_REASSERTED  格 315 → 不同指纹 260
```

闭合校验：指纹数 232+19+18+9+18+9 = **305**；格数 232·1+19·2+18·7+9·14+18·21+9·40 = 232+38+126+126+378+360 = **1260** ✓。

**(c) 简并是**可证的**，而且我用执行验证了它**：

| 简并 | 证明 | 独立执行验证 |
|---|---|---|
| **E0 内 35 格塌成 1 个**（每原型） | E0 不读 `tier`/`deviation`/`successes`（脚本 `:579-585`，`manual=undefined`、`useObserved=false`） | 每个原型 E0 的 5×7=35 格指纹相同 |
| **E3 的 N0 档（45 格）与 E0 逐位重复** | 脚本 `:590` `useObserved && tier.opportunities > 0` ⇒ n=0 时不传 `observed` | `E3@n=0 的 9 个指纹是否全部落在 E0 的 9 个指纹里？ true`；**8 对跨格实跑逐位相同**（run 1 检 6 对、run 2 检 2 对，`bit-同 8/8`） |
| **E2 整块（315 格）被 E1 包含，零新增** | 脚本 `:583` E2 只把 `VERY_HIGH→LOW`、`VERY_LOW→HIGH`，其余沿用 ⇒ 率集合 {0.20,0.45,0.65} ⊂ E1 的 {0.05,0.20,0.45,0.65,0.80} | `E2 的 27 个指纹是否全部落在 E1 的 45 个指纹里？ true` |

⇒ 有效独立数算术**精确闭合**：`9 + 45 + 27 + 260 = 341`，减去 `9`（E3@N0 ≡ E0）再减 `27`（E2 ⊆ E1）= **305** ✓。

> 口径说明：本节的指纹**含 `quickProfile`**（`quickProfile` 会经 `archetypeDimensions` 另开一条范围调整通道，因此必须计入「不同调用」）。
> `scripts/v21-rev1-model-stats.ts` 用的是**不含 `quickProfile`** 的纯画像指纹，故其读数为 6 / 30 / 18 / 202 —— 两者不矛盾，且其 `E1 ∩ E0 = 0`、`E1 ∩ E3(n>0) = 0` 恰好证明跨强度碰撞**只有** `9 + 27 = 36` 个，与 341 − 305 = 36 完全吻合。

**(d) 抽样验证（执行级）**：

```text
bit-同  VERY_TIGHT/E0/N0/devVERY_LOW    vs  VERY_TIGHT/E3/N0/devVERY_HIGH   eq=0.5597515645343422 vs 0.5597515645343422
bit-同  LOOSE/E0/N0/devVERY_LOW         vs  LOOSE/E3/N0/devVERY_HIGH        eq=0.5633260210601938 vs 0.5633260210601938
bit-同  CALLING_STATION/E0/N0/…         vs  CALLING_STATION/E3/N0/…         eq=0.5580798411791583 vs 0.5580798411791583
bit-同  UNDERBLUFFER/E0/N0/…            vs  UNDERBLUFFER/E3/N0/…            eq=0.5571452032137431 vs 0.5571452032137431
bit-同  BLUFF_HEAVY/E0/N0/…             vs  BLUFF_HEAVY/E3/N0/…             eq=0.5724286979958632 vs 0.5724286979958632
bit-同  UNKNOWN/E0/N0/…                 vs  UNKNOWN/E3/N0/…                 eq=0.5625883726719894 vs 0.5625883726719894
受检 8 对，逐位相同 8 对 ⇒ 同指纹 ⇒ 同结果（成立）
```

**(e) 边际新增（结果级）**：E3 内每档新增的**不同三元组**（45 格/档）：

```text
N0   新增  8 / 45  累计   8
N2   新增 24 / 45  累计  32
N5   新增 40 / 45  累计  72
N20  新增 39 / 45  累计 111
N50  新增 40 / 45  累计 151
N200 新增 39 / 45  累计 190
N1000 新增 39 / 45  累计 229
```

⇒ n ≥ 5 的每一档**都贡献约 39–40 个新测量**（不是重复），所以「样本量轴本身有信息量」这一点**成立**；被浪费的是 **E0（315 格 → 9）、E2（315 格 → 27，且 ⊆ E1）、E3@N0（45 格 ≡ E0）**。

**(f) 选择性 / 可比性**：

- max 是**同一个手牌、同一牌面、同一对手**上的 267 个不同配置里的最大值（不是 267 次独立试验）⇒ 不能附任何多重比较修正的 p 值 / 置信区间；它是**描述性极值**，不是推断统计量。
- 选择性后果是实质的：`equityDelta = 0.01976131229310596` vs `equityMaterial = 0.02` ⇒ **占阈值 0.99×**。也就是说「materiality = TRIVIAL」这个判定是**由最大值的选择**决定的：换一个手牌/牌面，同样 267 个配置的最大值很可能跨过 0.02。审计把 max 同时当作「worst case」与「materiality 输入」，但只有**一个**固定手牌支撑它。
- 审计**已经**提供了分布（`:22-26`：min −0.5728、p50 −0.0341、p95 0.9840、max 1.9761、mean 0.0178 pp）—— 这是正确的做法，应当以 p50/p95 为主、max 为界。

**(g) 覆盖缺口（且被误报为失败）**：审计的 9 原型 = 6 个有先验原型中的 **5** 个 + 5 个刻意中性标签中的 **4** 个：

```text
ARCHETYPE_BEHAVIOR_PRIORS keys = 6 ["CALLING_STATION","BLUFF_HEAVY","UNDERBLUFFER","MANIAC","LOOSE","VERY_TIGHT"]
NEUTRAL_ARCHETYPES keys       = 5 ["UNKNOWN","NORMAL","TIGHT","VERY_LOOSE","AGGRESSIVE"]
audit covers 9 of 11 ; missing = ["VERY_LOOSE","MANIAC"]
prior-bearing covered = 5 / 6   missing: ["MANIAC"]     ← MANIAC 的 riverBluff 先验最高（0.50）
neutral covered       = 4 / 5   missing: ["VERY_LOOSE"]
```

而 `v21-summary.md:60` 与 `:68` 把 MANIAC 打成 `—` 与 **`❌`**（单调性「不通过」）：`| MANIAC | — | — | — | — | — | ❌ |`。**「未测」被写成了「失败」** —— 这是报告缺陷，且正好落在唯一被语料探针使用的原型上（语料里 `TAG_MANIAC` / `OBS_MANIAC_50_45` 都是关键对照）。

### CONFLICT

**YES（可比性与覆盖），数字本身无冲突** ——

1. 「1260 组合」作为独立比较数是**误导**：不同调用 **305**、不同结果 **267**（简并 4.13× / 4.72×）；其中 **E2 的 315 格零新增**、**E3 的 N0 档 45 格与 E0 逐位重复**。
2. 在一个固定手牌上取 267 个相关配置的 max 并用作 materiality 的**唯一**输入 —— max 恰好落在阈值的 0.99×，判定对选择高度敏感；max 不是推断统计量。
3. MANIAC（先验最高）与 VERY_LOOSE **漏测**，且 MANIAC 被误表示为单调性 **❌**。

### RESOLUTION

**审计的每个数字都对（我逐格 bit 级复现了 1260/1260），错的是「1260 个组合」这个可比性框架，以及一处覆盖误报。** 建议改为：

> 1260 **行** = 305 个不同调用 / 267 个不同结果（简并 4.13×/4.72×）；其中 `E2_MANUAL_WEAK` 的全部 315 行与 `E3` 的 `N0` 档 45 行是**逐位重复**，不含新信息。
> max |Δ权益| = 1.9761pp 是**单手牌上 267 个配置的最大值**（p50 = −0.0341pp，p95 = 0.9840pp），**不是**总体最坏情况，也不构成可做多重比较修正的样本；它占 `equityMaterial` 阈值的 0.99×，因此 materiality=TRIVIAL 的判定对「取 max」这一选择敏感。
> 覆盖：9/11 个标签（缺 `MANIAC`、`VERY_LOOSE`），MANIAC **未测**（不是单调性失败）。

---

## ITEM 7 —— 分母审计

### CLAIM

`v21-profile-sensitivity.json` → `meta.unitNotes.bluffMass`：

> 概率质量占比（0..1）；**分母 = 该对手可达组合的后验质量之和**（不含与 Hero/公共牌重叠者）

`v21-decision-impact.json` → `meta.units.bluffMass`：

> 概率质量占比；分母 = 对手可达组合后验质量之和

`src/domain/postflop/types.ts:199`：

> ⚠️ 质量占比的分母是 `totalMass`（可达且已扣除死牌的质量）

### EVIDENCE

**(a) 精确公式（`src/app/manualInput/rangeFacts.ts`）**

```text
:203   const profileClassMasses = (() => {
:204-206   let total = 0; let reachable = 0; let unclassified = 0;
:219     for (const entry of range.entries) {
:220       const p = entry.probability;
:221       if (!(p > 0)) continue;                       ← 0 概率组合不计入任何一侧
:226-228   if (hole.some((c) => heroSet.has(...) || boardSet.has(...))) { continue; }   ← Hero 底牌 + 公共牌在这里被排除
:229       reachable += 1;                               ← 组合数（可达）
:230       total += p;                                   ← 质量（可达）⇒ totalMass 的定义
:231       weights.push(p);
:232       const comboClass = riverComboClassOf({ hole, board, heroHole });
:233-236   if (comboClass === null) { unclassified += p; continue; }   ← 分类失败**单列**
:237       byClass[comboClass.category] += p;
:240-242   const missedDrawMass = byClass.MISSED_FLUSH_DRAW + byClass.MISSED_STRAIGHT_DRAW + byClass.MISSED_COMBO_DRAW;
:242       const valueMass = byClass.NUT_VALUE + byClass.STRONG_VALUE + byClass.THIN_VALUE;
:244       totalMass: total,
:256       bluffMass: missedDrawMass + byClass.PURE_AIR,          ← **未除以 total**
:257       unclassifiedMassShare: unclassified / total,          ← **除以 total**（唯一归一化的占比）
```

⇒ **`bluffMass` 是绝对概率质量**，隐含分母 = **1（整个范围）**；它等于「可达质量占比」**当且仅当** `totalMass ≡ 1`。`types.ts:199` 的那句注释对 `unclassifiedMassShare` 成立，对 `bluffMass` **不成立**（`types.ts:219-221` 也只把 `unclassifiedMassShare` 命名为「归一化占比」）。

**(b) 本夹具实测（S1 中性格）**

```text
supportSize（整个范围，类型注释即「扣除已知牌后」）= 449
metrics.probabilitySum（整个范围 Σp）              = 1.0000000000000047
reachableRangeCount（可达组合数）                  = 449
totalMass（可达质量）                              = 1.0000000000000047
Σp(全部) − totalMass(可达)                         = 0        ← 死牌上的质量 = 0
supportSize(全部) − reachableRangeCount(可达)       = 0
bluffMass（原样）                                  = 0.018421440058874052
bluffMass ÷ totalMass                              = 0.018421440058873965   （相对差 4.7e-15）
unclassifiedMassShare                              = 0
missedDrawMass + pureAirMass                       = 0.018421440058874052   （恒等成立）
```

**(c) 闭合性与不变量（305 个不同配置全量）**

```text
分量闭合（nut+strong+thin+showdown+missed+air+unclassified == totalMass）：305 / 305；最大偏差 4.6629367034256575e-15
valueMass == nut+strong+thin 不成立的格数 = 0
bluffMass == missedDrawMass+pureAirMass 不成立的格数 = 0
totalMass 的不同取值个数 = 73 ⇒ 全部落在 [0.9999999999999948, 1.0000000000000047]
```

**(d) Hero 的牌与公共牌是否被排除**：**是**。`:226-228` 在 `reachable += 1; total += p`（`:229-230`）**之前** `continue`。但本夹具上该检查**没有真的减掉任何东西**：`Σp(全部) − totalMass(可达) = 0`，`supportSize − reachableRangeCount = 0` ⇒ 与死牌重叠的组合在**上游**已是 0 概率，这段是**纯防御性**的（与 `:140-143` 的注释一致）。

### CONFLICT

**YES（公式表述），数值无误** ——

1. `bluffMass` 在源码里**不是**商，它是**未归一化的绝对质量**；「分母 = 可达质量之和」把 `totalMass` 说成了它的分母，而它的分母是 **1**。审计的 JSON `unitNotes`、`decision-impact` 的 `units`、以及 `types.ts:199` **三处**都这样写。
2. 本夹具上两种读法**数值差 4.7e-15**（因为 `totalMass = 1.0000000000000047`，`支持集 = 可达集 = 449`），所以**结论不受影响** —— 一旦某个范围在死牌上带质量（或 0 概率组合被计入分母），两者就会分离，而当前公式描述会掩盖这种分离。

### RESOLUTION

**审计的数字对、公式错。** 正确表述应为：

```text
bluffMass = Σ_{c ∈ 可达, class(c) ∈ {MISSED_FLUSH_DRAW, MISSED_STRAIGHT_DRAW, MISSED_COMBO_DRAW, PURE_AIR}} p_c
          （绝对概率质量，隐含分母 = 1；rangeFacts.ts:256）
可达质量占比 = bluffMass / totalMass                （rangeFacts.ts:244 + :257 的口径）
```

建议把 JSON 的 `unitNotes.bluffMass` 改成：

> `bluffMass` = 可达组合中诈唬类（错过听牌 + 纯空气）的**绝对概率质量**（rangeFacts.ts:256，**未除以 totalMass**）；`profileClassMasses.totalMass` 才是可达质量之和（:244）。本夹具 `totalMass = 1.0000000000000047` 且 `unclassifiedMassShare = 0`，故「绝对质量」与「可达质量占比」相差 4.7e-15；**两者一般不等价**。

同一处修正也适用于 `types.ts:199` 的注释（它只对 `unclassifiedMassShare` 成立）。

---

## 附录 A —— 复现方式

| 脚本 | 覆盖 | 运行 |
|---|---|---|
| `scripts/v21-rev1-model-stats.ts` | ITEM 1(a,b)、ITEM 2、ITEM 3、ITEM 6 的模型层简并 | `node --experimental-strip-types scripts/v21-rev1-model-stats.ts` |
| `scripts/v21-rev1-pipeline-probe.ts` | ITEM 4（选型/迭代/SE 算术）、ITEM 5（75 条字段差异） | `node --experimental-strip-types scripts/v21-rev1-pipeline-probe.ts` |
| `scripts/v21-rev1-matrix-distinct.ts` | ITEM 6（305 指纹 / 267 结果 / 8 对逐位验证 / max 复算）、ITEM 7（totalMass 闭合） | `node --experimental-strip-types scripts/v21-rev1-matrix-distinct.ts`（≈4–6 min） |
| `scripts/v21-rev1-denominator-check.ts` | ITEM 7（死牌质量 = Σp(全部) − totalMass(可达) = 0） | `node --experimental-strip-types scripts/v21-rev1-denominator-check.ts` |

逐格比对（我的重跑 vs 审计 JSON）已在临时目录落盘 `%TEMP%\v21-rev1-matrix-1260.json`，比对命令见 ITEM 1(d)。

## 附录 B —— 与审计一致的量（明确说「审计对」的部分）

| 量 | 审计 | 我 | 一致方式 |
|---|---|---|---|
| 7 档样本量定义 | 0/2/5/20/50/200/1000 | 同 | 逐项 |
| E3 收缩公式 315 格 | — | 独立公式 | **bit 相同，mismatches = 0** |
| 1260 格 `heroEquity` | — | 独立重跑 | **1260/1260 逐位相同** |
| 1260 格 `bluffMass` | — | 独立重跑 | **1260/1260 逐位相同** |
| 1260 格 `action` | CALL | CALL | **1260/1260** |
| 不同权益值个数 | 267 | 267 | 相同 |
| max \|equityDelta\| | 1.9761pp | 1.9761pp | 同一格 |
| max \|bluffMassDelta\| | 4.5242pp | 4.5242pp | 同一格 |
| action flip | 0/1260 | 0/1260 | 相同 |
| 中性基线 | 56.2588% / 1.8421% / 449 | 0.5625883726719894 / 0.018421440058874052 / 449 | 逐位 |
| `UNKNOWN ≡ NORMAL` | 逐位相同 | 逐位相同 | 相同 |
| 无观测 ≡ 观测 0 次 | 成立 | 成立（含端到端） | 逐位 |
| 权益算法 | — | EXACT / 990 / halfWidth 0 | 补强 |
| materiality | TRIVIAL | TRIVIAL（0.0198 < 0.02，占 0.99×） | 相同（但见 ITEM 6(f) 的选择性意见） |

## 附录 C —— 需要修的清单（按代价排序）

| 优先级 | 位置 | 修法 |
|---|---|---|
| 高 | 脚本 `:24` / `:552` / `:635` | 偏离第 5 档：manual 通道上限是 **0.80**；0.95 只用于 E3 造成功数。档名与文档必须区分这两者 |
| 高 | `v21-summary.md:68` | `MANIAC ❌` 改为「**未测**」（该原型不在 9 档轴内）；或把 MANIAC 补进矩阵（它是先验最高、且被语料使用的原型） |
| 高 | `rangeFacts.ts`/JSON `unitNotes`/`types.ts:199` | `bluffMass` 是**未归一化**的绝对质量；「分母 = totalMass」只对 `unclassifiedMassShare` 成立 |
| 中 | 脚本 `:21-22` | 删掉「`SampleTier` 的 30/200 两个阈值」——该阈值属 `PlayerMetricStat` 子系统，本条路径不读 |
| 中 | 报告 | 「1260 组合」→「1260 行 = 305 次调用 / 267 个结果」；并声明 E2 净新增为 0、E3@N0 ≡ E0 |
| 中 | 报告 | 样本量轴补一句「无最小机会数闸门；`observed` 生产不可达（D4）」 |
| 中 | 报告 | 蒙特卡洛一节补「响应模型 6000 次抽样 ⇒ ~1pp 差不可分辨；种子只保证可复现」 |
| 低 | `behaviorProfile.ts:76` | `MANUAL_READ_CONFIDENCE_CAP` 无读者 ⇒ 删除或在 `manualReadEvidence` 里真正接上 |
| 低 | `behaviorProfile.ts:99` | `successes > 0 && opportunities === 0` 时在 `noteZh` 里显式记录信息被丢弃 |
| 低 | `v21-summary.md:9` | 745.2 s 只含 `analyzeManualHand`；真实墙钟约为 2×（另一处 `buildDecisionContext` 未计时） |
