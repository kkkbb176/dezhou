# PLAYER PROFILE QUANTIFICATION V2 — REPORT

**裁决：`PLAYER PROFILE QUANTIFICATION V2 — PASS_WITH_WARNINGS`**

```text
UNIFIED_ACTION_LIKELIHOOD = ACTIVE
NEUTRAL_PARITY            = PASS（48/48 网格单元逐位相等，最大绝对差 0）
PROFILE_RANGE_INFLUENCE   = TRIVIAL
ALPHA_DECISION_MODEL_VERSION = 1.0.5（patch，见 §16）
```

**`npm run verify` 全绿**：typecheck 0 错误 · `manifest:check` 154 个产物一致 ·
**tests 1772 / suites 137 / pass 1772 / fail 0**（exit 0）。

---

## 1. Initial Problem

V1 已把画像接入决策链（`PROFILE_RANGE_INFLUENCE = TRIVIAL`）——即方向对但幅度弱：
权益只动 **0.79pp**、诈唬质量只动 1.95pp。根因是**有界线性条件化**
`(0.5+rate)/(0.5+π)` 的动态范围只有 ≈1.75×，而它乘的基准（既有档位似然）
在河牌进攻动作上极度厌恶诈唬（档位 5 归一化后 ≈0.055）。

V1 曾试过「**替换**档位似然」：幅度够（2.20pp），但原型与中性**不同尺**，
导致四条排序断言变成跨模型比较而不可能成立。V2 要同时拿到「强影响」与「单模型」。

## 2. 本阶段的核心设计：统一动作似然

新增 `estimateUnifiedActionLikelihood`（`src/domain/player/behaviorProfile.ts`）：

```text
likelihood = baseLikelihood × ( Π 已施加条件化因子 ) ^ (1/K)

baseLikelihood = tierWeightOf(likelihoodWeights('AGGRESSIVE', betRatio), strengthBucket)
                 ↑ 中性校准层 = **既有档位权重本身**（不重新实现）
K              = 结构槽位数 = 1（节点槽）+ (诈唬类?1:0)（尺寸槽）+ (可条件化?1:0)（类别槽）
条件化因子      = cond(trait) = odds(rate) / odds(池先验)   ← 几率比（Bernoulli 似然比）
```

返回 `{ likelihood, rawLikelihood, clamped, baseLikelihood, combinedAdjustment,
appliedTraitCount, sizeAdjustment, nodeAdjustment, profileAdjustment, contributions, trace, noteZh }`。

**`strengthBucket` 由 `riverComboClassOf` 一次给出**（该函数内部本来就算出了档位，
此前被丢弃并由调用方另行推导 —— 那会形成第二把尺子）。现在全局只有一个来源。

## 3. 为什么是「几率比」+「几何平均」——两处都是结构性判断

**(a) 几率比而不是有界线性式。** 一个 Bernoulli 动作在「该玩家做这个动作的率 = r」
下的似然是 `r`，相对池先验 `π` 的证据强度在贝叶斯意义下就是几率比
`(r/(1−r)) / (π/(1−π))`。三条性质都是数学性质而非拟合：

1. **中性恒等**：`r === π` ⇒ 恰为 `1.0`（分子分母同一浮点表达式）；
2. **单调且动态范围大**：`0.10 → 0.55` 放大到 **≈11×**（旧式仅 ≈1.75×）；
3. **可解释**：直接写进 trace 供审计（§四十三）。

每条条目的实测放大倍数（03A CALLING_STATION → 03B MANIAC）：

| trait | 池先验 | 03A | 03B | 旧式 A/B | **几率比 A/B** |
|---|---|---|---|---|---|
| `riverBluff` | 0.28 | 0.15 | 0.50 | 0.833 / 1.282 | **0.454 / 2.571** |
| `riverLargeBetBluff` | 0.20 | 0.08 | 0.42 | 0.829 / 1.314 | **0.348 / 2.897** |
| `missedDrawBluff` | 0.25 | 0.10 | 0.55 | 0.800 / 1.400 | **0.333 / 3.667** |
| `probeAfterTurnCheckBack` | 0.30 | 0.18 | 0.50 | 0.850 / 1.250 | **0.512 / 2.333** |

**(b) 几何平均而不是乘积 —— 并且分母必须是「结构槽位数」，不是「已施加条目数」。**
这两点都是**实测纠正**，且第二点纠正的是任务书原本给的写法：

- **乘积会三重计票**：`missedDrawBluff` / `riverLargeBetBluff` /
  `probeAfterTurnCheckBack` 表达的是**同一个潜在倾向**（「这个人爱开火」）。
  三者在 LARGE + TURN_CHECK_BACK 上同时施加，乘积实测 `0.0594 → 24.7816`
  （放大 **417×**）；基准 ≈0.055 ⇒ `0.055 × 24.78 = 1.36` **撞上钳位 1.0** ——
  即「错过听牌」与**坚果**一样可能开火，且 `MISSED_DRAW` 与 `PURE_AIR` 被一起压平，
  恰好摧毁 V2 要建立的类别区分。
- **但用「已施加条目数」做分母会破坏 §三十八 的方向**：实测（MANIAC · 错过听牌 · LARGE）

  ```text
  我让牌后他开火（3 条）  0.348 × 3.667 × 2.333 = 24.78 ⇒ 24.78^(1/3) = 2.915
  他跟注后他 donk（2 条） 0.348 × 3.667          = 10.62 ⇒ 10.62^(1/2) = 3.259
  ⇒ 3.259 > 2.915：「让牌后开火」的似然反而更低，与 §三十八 相反
  ```

  原因是「开火」因子（2.333）**低于另外两条的几何平均**，计入分母等于给
  「多施加一条」附带惩罚。改为**结构槽位数**（与画像、与前序线无关）后：
  `24.78^(1/3)=2.915 > 10.62^(1/3)=2.198` ✓ 方向正确，且 `0.055 × 2.915 ≈ 0.160 ≪ 0.95`
  远离钳位。

## 4. 条件化只作用于「诈唬端」——两处结构性限制

1. **尺寸与节点因子只施加于诈唬类**（`MISSED_*` / `PURE_AIR`）。
   价值端（NUT/STRONG）与摊牌端不接受任何条件化：它们的调整恒为 1.0。
   理由：坚果本来就会下注，用「他爱开火」去抬高坚果似然在语义上是错的，
   而且基准 0.95 会被任何 >1.05 的因子推过 1.0（钳位）。
2. **`THIN_VALUE` 只接受 `thinValueBet` 类别因子，不接受尺寸/节点因子。**
   🔴 这是**实测出来的符号修正**：`THIN_VALUE` 的判据是
   `versusHero === 'STRONGER'` ⇒ 它是**能打败 Hero** 的牌。把节点因子乘上去，
   等于同时抬高「能赢 Hero」那一端。实测（只改画像）：

   ```text
   THIN_VALUE 的节点因子  03A √0.512 = 0.716    03B √2.333 = 1.528
   ⇒ 03A 55.81% / 03B 57.61%（修正后，方向正确）
   修正前：03A 60.94% > 03B 50.02%（**与 §二十 相反**）
   ```

   隔离实验排除了「基础范围」这一嫌疑：把似然固定为中性时两个原型的权益是
   **56.31% vs 56.20%**（差 0.11pp，蒙特卡洛噪声内）⇒ 倒置完全来自似然，不是基础范围。

## 5. 单一生产入口（§十七 / §四十五）

**`archetypePriorAvailable` 闸门已删除。** 此前它让中性标签走旧档位路径、
有先验原型走类别模型 —— 即**两个生产入口**。V2 的中性校准层让中性画像
**逐位等于**旧结果（见 §7），闸门因此是恒等变换，保留它只会长期并存两个模型。

现在所有河牌进攻性动作都走 `estimateUnifiedActionLikelihood`；
没有画像（`UNKNOWN`）时注入**中性画像**（等价池先验），结果与既有档位似然逐位一致。
唯一剩余回落是 `node === null`（牌面不足 3 张 / 拿不到下注比例）——
那是**拿不到输入**的 fail-closed，不是第二个模型。

> **权威路径 = `estimateUnifiedActionLikelihood`；闸门不再存在。**

## 6. 中性校准层与「单一尺子」

`likelihoodWeights` / `tierWeightOf` 来自既有 `likelihoodModel.ts` —— **不重新实现**。
这是 `domain → app` 的**值导入**，与项目既有先例同向
（`domain/postflop/exploit.ts` 导入 `QuickProfile`、`domain/poker/equityPolicy.ts`
导入 `DecisionDeadline`）。

## 7. NEUTRAL_PARITY（§三 / §三十一 / §二十六）—— **逐位相等，无需容差**

网格：**River 25% / 75% / 125% × 8 个类别 × 2 条前序线 = 48 个单元**，
中性画像结果 vs `tierWeightOf(likelihoodWeights('AGGRESSIVE', ratio), bucket)`：

```text
⇒ 网格单元数 48
⇒ 最大绝对差 0
⇒ NEUTRAL_PARITY = PASS（逐位相等）
```

**过程中发现并修复了一个 1 ULP 缺陷**：初测时 42/48 逐位相等，6 个（全是 `THIN_VALUE`）
差 **5.55e-17**。根因是 `statEvidenceOf` 在零机会时算
`(priorRate × priorWeight) / priorWeight`，而 `(0.2 × 6) / 6 = 0.20000000000000004`。
已改为**零机会时逐位返回先验**（语义上也更正确：没有观测 ⇒ 生效值就是先验）。
修后 **48/48 逐位相等**。这也是闸门可以被删除的前提。

## 8. §四十二 变异 A/B —— 两条都**实测变红**（逐字）

**变异 A：把 03A 与 03B 设成同一个画像**（两侧同画像 ⇒ 分布距离为 0）

```text
✖ §二十 03A vs 03B：诈唬质量、错过听牌质量、权益与 EV 必须单调 (939.0196ms)
AssertionError [ERR_ASSERTION]: 03B 的诈唬质量必须高于 03A：0.0500 vs 0.0500
ℹ pass 1
ℹ fail 1
```

（同画像下 `profileRangeDistance` 亦为 `TV=0 / JS=0`，而 §二十三 断言要求 `TV > 0.02`；
`§二十三 profileRangeDistance：相同 ⇒ 0` 这条单测已独立证明该输入下距离恰为 0，
故变异 A 同时打中单调性与距离两条断言。）

**变异 B：旁路画像条件化**（令 `cond` 恒返回 1）

```text
✖ §二十 03A vs 03B：诈唬质量、错过听牌质量、权益与 EV 必须单调 (937.3197ms)
AssertionError [ERR_ASSERTION]: 03B 的诈唬质量必须高于 03A：0.0184 vs 0.0192
ℹ pass 1
ℹ fail 1
```

（注意 `0.0184 < 0.0192` —— 条件化被旁路后连方向都反了，正是基础范围的微弱残余。）

## 9. 钳位可见性（§十七）—— 0 个饱和

逐类别给出**钳位前**的 `base × 调整 = raw`（03A / 03B，LARGE + TURN_CHECK_BACK）：

| 类别 | 基准 | 03A 调整 | 03A raw | 03B 调整 | 03B raw | 钳位? |
|---|---|---|---|---|---|---|
| NUT_VALUE | 0.950000 | 1.000000 | 0.950000 | 1.000000 | 0.950000 | no |
| STRONG_VALUE | 0.457069 | 1.000000 | 0.457069 | 1.000000 | 0.457069 | no |
| THIN_VALUE | 0.219393 | **1.000000** | 0.219393 | **1.000000** | 0.219393 | no |
| SHOWDOWN_VALUE | 0.127979 | 1.000000 | 0.127979 | 1.000000 | 0.127979 | no |
| MISSED_FLUSH_DRAW | 0.054848 | 0.390144 | 0.021399 | 2.915478 | 0.159909 | no |
| MISSED_STRAIGHT_DRAW | 0.054848 | 0.390144 | 0.021399 | 2.915478 | 0.159909 | no |
| MISSED_COMBO_DRAW | 0.054848 | 0.390144 | 0.021399 | 2.915478 | 0.159909 | no |
| PURE_AIR | 0.054848 | 0.432396 | 0.023716 | 2.590265 | 0.142072 | no |

```text
⇒ 发生钳位的 (类别, 画像)：无（0 个）
⇒ 最大 raw = 0.457（2026 倍低于 1.0）⇒ 远离饱和，类别区分完好
```

⚠️ `THIN_VALUE` 的调整为 **1.000000**：`thinValueBet` 在**所有**原型先验里都是中性的
（V1 的 D4 已移除），因此 `THIN_VALUE` 对原型画像**不携带任何条件化** ——
这是**预期行为**，不是缺陷（§十九 定义 03B 时只列诈唬类条目）。
若将来用**实测/人工证据**声明薄价值倾向，该通道仍然可用（单测覆盖）。

## 10. §四十八 A/B 表（**只有实测数字**）

黄金手（§十七）：9-max · 100BB · Hero CO `A♣J♥` · 牌面 `A♦8♠4♠2♣K♦` ·
CO 开 2.5 → BB 跟 → 翻牌 BB 过/Hero 下 2/BB 跟 → 转牌 BB 过/**Hero 过牌让牌** →
河牌 BB 下 7（75%）⇒ 节点 `TURN_CHECK_BACK` + `LARGE`。**只改 `villain.quickProfile`**。

| 指标 | 03A `CALLING_STATION` | 03B `MANIAC` | 单调性 |
|---|---|---|---|
| Value Mass | **41.14%** | **39.40%** | — |
| ├ 其中 Thin Value | 29.60% | 28.76% | — |
| Showdown Value Mass | 58.07% | 55.60% | — |
| Missed Draw Bluff Mass | **0.49%** | **3.40%** | ✅ **6.9×** |
| Pure Air Mass | 0.29% | 1.60% | — |
| Bluff Mass（错过听牌+纯空气） | **0.78%** | **5.00%** | ✅ **6.4×** |
| Raw Support Combos | **449** | **449** | 不变（只改概率） |
| Effective Combos | **125.64** | **136.02** | — |
| 90% Mass Combos | **120** | **152** | — |
| 95% Mass Combos | **172** | **259** | — |
| Range Distance（TV / JS） | \multicolumn{2}{c}{**0.0422 / 0.0128**} | ✅ |
| Hero Equity | **55.81%** | **57.61%** | ✅ **+1.80pp** |
| Call EV | **12.230** | **13.076** | ✅ **+0.846** |
| Final Action | CALL | CALL | §四十七 允许相同 |
| Confidence | HIGH | HIGH | — |

**§二十 四条单调性全部成立**：`bluffMass` / `missedDrawBluffMass` / `heroEquity` / `callEV`。
**权益差 +1.80pp 高于蒙特卡洛分辨率**（p≈0.56、6000 次迭代 ⇒ SE ≈ 0.6pp）。
动作两边都是 CALL —— 按 §四十七 允许；本测试**从不**断言「03A 必须 FOLD / 03B 必须 CALL」。

**449 vs 125.64 vs 120** 正是「不能把 449 当等权」的量化证据：
449 个原始组合在等权意义下只等效于约 126 手，而 90% 的可能性集中在 120–152 手之内。

## 11. §二十六 估计量必须与机器负载无关（实测发现并修复）

**同一个测试文件：单独运行 ✔ 通过；完整套件 ✖ 失败。**
根因不是随机噪声，而是 `AnalyzeOptions.budget` 驱动真实的 `DecisionDeadline`，
而 `equityPolicy` **按剩余预算**在「精确枚举」与「蒙特卡洛（迭代数可变）」之间选型 ——
CPU 争用时它会选到更粗的估计量，于是权益**随负载变化**。

修法：黄金测试显式给出宽裕预算 `budget: { softMs: 120_000, hardMs: 240_000 }`，
两侧走同一条（精确）路径。修后单独与全套件结果一致。

## 12. §二十五 诚实判定 —— **仍是 TRIVIAL：方向正确、已可测，但幅度未达 MATERIAL**

```text
equityDelta      = +1.80pp
bluffMassDelta   = +4.22pp
rangeDistance    = TV 0.0422 / JS 0.0128
materiality      = TRIVIAL（equityDelta 0.0180 < equityMaterial 0.02
                     ∧ bluffMassDelta 0.0422 < massMaterial 0.05）
```

⚠️ **严格按 `MATERIALITY_THRESHOLDS`**：`equityMaterial = 0.02`，实测 `0.0180` ——
**权益维度仍差一点点**才够 MATERIAL；但 `massMaterial = 0.05` 也被 `0.0422` 差一点点。
两项都**刚好落在 TRIVIAL 与 MATERIAL 之间**。本报告不掩饰这一点：

> **V2 把画像影响从 0.79pp 提到 1.80pp（≈2.3×），从「不可测」提到「可测且方向正确」，
> 但仍未达到 V1 报告里 `MATERIAL` 档位所需的幅度。**
> 按 §二十五，我**不**仅凭单调性通过就宣布问题关闭：
> **`PROFILE EFFECT` 已实质改善但仍偏弱**，属本阶段最重要的遗留项。

⚠️ **本报告页首此前误写为 `MATERIAL`，已更正为 `TRIVIAL`**（V2 收口修正）。

按 `profileMaterialityOf()` 的规则，**两个维度都未达各自阈值**（equity 0.0180 < 0.02
且 mass 0.0422 < 0.05），因此判定为 `TRIVIAL` —— 与本节正文、与
`MATERIALITY_THRESHOLDS` 一致。质量维度从 V1 的 1.95pp 提到 4.22pp（翻倍有余）是
**真实改善**，但「翻倍有余」**不是**判定依据；判定依据只有阈值比较。
**展示数字与业务判定必须分离 —— 不得用手写结论覆盖规则输出。**

## 13. §二十七 / §二十八 / §二十九 / §三十 范围可审计结构

新增 `src/domain/player/profileRangeMetrics.ts`（**纯函数**，确定性审计的后继要求），
并在 `rangeFacts.profileClassMasses` 上输出：

| 量 | 精确定义 |
|---|---|
| `rawSupportCombos` | 未与 Hero/公共牌重叠、`prior > 0` 的组合数（原始支持集） |
| `effectiveCombos` | **`(Σp)² / Σp²`**（逆辛普森 / 参与率）。等权时 = N；一个组合独占 → 1 |
| `posteriorMassCombos90/95` | 按后验权重**降序**累计首次 ≥ 90% / 95% 所需的最少组合数 |
| `profileClassMasses` | 类别**概率质量**（不是组合数），`valueMass` / `thinValueMass` / `showdownMass` / `missedDrawMass` / `bluffMass` / `pureAirMass` … |

`unclassifiedMassShare` 单列分类失败的质量（不猜）。**§二十九/§三十** 的
「类别构成 = 后验概率质量、合计 ≈1」由 `profileClassMasses` 承担，
与既有的**非概率** `nutDensity` / `airDensity` 特征分（§十五 已加锁）是不同量。

## 14. §六 / §四十一 `MEDIUM_VALUE`：**删除**（不是补定义）

**决定：删除。** 理由：它在这套判据下**永远不可能被产生** ——
`classifyRiverAction` 对 `versusHero === 'STRONGER'` 只给 `CLEAR_VALUE`（档 0–1 ⇒ NUT/STRONG）
与 `THIN_VALUE`（档 2），档 3 落到 `SHOWDOWN`。让它可达需要重新切分价值轴，
而那会移动 03A/03B 黄金夹具与 `riverActionMassesOf` —— 为一个当前**零信息**的类别
去动摇本任务必须保持稳定的夹具，不划算。

**触碰的消费者（全部）**：
`src/domain/player/behaviorProfile.ts`（枚举成员、`VALUE_CLASSES`、`betLikelihoodOf` 的 `0.4` 分支）、
`src/app/manualInput/rangeFacts.ts`（`byClass` 初始化、`valueMass` 求和、
`mediumValueMass` 字段）、`src/domain/postflop/types.ts`（`profileClassMasses.mediumValueMass`）、
`test/profileQuantification.test.ts`（合成夹具里的 `'MEDIUM_VALUE'` → `'STRONG_VALUE'`）。

**`mediumValueMass` 的下场**：**一并删除**。全仓 grep 确认它**只**有类型声明与
`rangeFacts` 赋值两处引用，**没有任何 viewmodel / web / debug 消费者** ——
所以不存在「UI 读它而我悄悄删掉」的情况。

⚠️ 这与 `RelativeHandRole.MEDIUM_VALUE`（`domain/postflop/types.ts`）**不是同一个枚举**；
那个是翻后**手牌角色**，可达且被 `relativeHandRole` / `valueBetGate` 与多个测试广泛使用，
**未改动**。

**防复发**：新增 `test/profileV2Metrics.test.ts` 的**覆盖锁** ——
在 9 个牌面/底牌组合上穷举全部 1326 个组合调用 `riverComboClassOf`，
断言**每个枚举成员都被真的产出过**。新增成员若不可达，这条测试立刻变红并指名它。

（过程中该锁先报 `NUT_VALUE` 不可达 —— 追查发现档 0 = 同花顺/四条/葫芦，
而**无对子的牌面上两名对手各 2 张底牌不可能做出**四条或葫芦（最多三条 = 档 1），
所以扫描必须包含**有对子**或**同花顺**牌面。补上后 8/8 可达 ⇒ 不存在第二个死成员。）

## 15. §三十五 缓存：本路径上**没有**缓存

- `rawSupportCombos` / `profileClassMasses` / `effectiveCombos` 都是**每次现算**。
- 河牌似然路径上**没有**任何以「画像」为键的缓存：全 `src/` 的模块级缓存只有
  `rangeCache.ts`（上下文路径**未引用**）与 `preflopPriors.WEIGHT_CACHE`
  （键为不可变的 `rfi:<tier>` 等先验，与画像无关）。
- 因此**不存在**「画像变了但缓存未失效」的风险（V1 墨菲 #6/#7/#8 的形态）。
- ⚠️ 若将来为河牌似然加缓存，键**必须**包含
  `画像身份/版本 + 节点（街/尺寸/前序线/牌面纹理）+ betRatio + ALPHA_DECISION_MODEL_VERSION`。
  本阶段没有这样的缓存，故无键可加。

## 16. §四十四 版本决定：`1.0.4` → **`1.0.5`**（patch）

**先读了现有规则**（不机械升级）：

- `artifactDefinitions.ts:314`：对 `decision.types.ts` ——
  「**所有决策判定阈值发生变化**（该文件改动**必须升** `ALPHA_DECISION_MODEL_VERSION`）」。
  措辞是**无条件必须升**，没有 major/minor 之分。
- `decision.types.ts:1237`：「`decision.types.ts` 的改动按该纪律必须升版本号」。
- 变更记录里既有条目是 `1.0.1` / `1.0.3` / `1.0.4` —— **全部是 patch 级**，
  每条都写「为什么必须升版本」。**全 `src/` 与文档中没有找到**任何
  semver / MAJOR / MINOR 政策文字。

⇒ **采用 `1.0.5`（patch）**，并在 `decision.types.ts` 的变更记录里按既有风格写明：
改了什么、为什么必须升、以及**明确未改**的部分（`handEval` / 底池赔率 / 所需权益 /
SPR / combo 数学 / 权益算法 / EV 公式，全部冻结）。

> 「统一模型替换是架构变更 ⇒ 该给 `1.1.0`」**不作为理由采纳** ——
> 没有规则授权 minor 升级，而一个不遵守任何既定规则的版本号会失去它唯一的用途
> （回答「这手牌为什么从 FOLD 翻成 CALL」）。若将来想引入 semver 政策，
> 那应当是一次**显式的新约定**，而不是本次悄悄采用。

## 17. §四十三 运行时间（**只报实测到的**）

| 项 | 实测 |
|---|---|
| `§二十 03A/03B` 单测 | **0.94–4.05 s**（随机器负载浮动；与 §11 的估计量切换同源） |
| `test/profileV2Metrics.test.ts`（6 项） | **≈1.3 s**（其中覆盖锁 ≈0.47 s，穷举 5 个牌面 × 1326 组合） |
| `test/nodeDeterminism.test.ts`（6 项） | ≈42 s（D1 含 20 次重复） |
| `npm run verify`（全量） | **未精确计时**；本次运行的完整门（typecheck + manifest + 1772 项）在后台作业上限内完成 |

⚠️ 03A/03B 的**端到端**运行时间我**没有**单独插桩，因此不给出数字推测。

## 18. 契约变更与「不写死动作」（§十九–§二十二 / §四十七）

1. **`§二十` 只断言四条单调性**，从不断言 `03A=FOLD / 03B=CALL`；两边都是 CALL 也通过（§四十七）。
2. **`§38` 的断言由 `contributions` 改为 `trace`** —— V2 起**节点**条目记录在 `trace`
   （`contributions` 只记**类别**条目）。这是审计面的**结构说明**，不是放宽。
3. **`§35` 的薄价值断言由字面量 `0.35` 改为「池先验」** ——
   旧断言 `< 0.35` **一直是靠浮点巧合通过的**：`(0.35 × 6) / 6 = 0.3499999999999999`
   恰好低 1 ULP。§7 的零机会即位返回先验修掉那个 ULP 之后它变成精确的 `0.35`，
   `0.35 < 0.35` 立刻为假。真实契约是「被动原型不得把薄价值倾向抬到池先验之上」
   ⇒ 改为与 `ENVIRONMENT_BEHAVIOR_PRIOR.thinValueBet` 比较。**这不是放宽**，
   而是把依赖浮点尾差的条件换成真实语义条件。（同一处另一条断言改为
   `missedDrawBluff < 池先验`，并注释说明为何是「低于池先验」而非「小于 0.2」。）
4. **黄金测试显式给宽裕时间预算**（§11）：这是让 A/B 比较**不依赖机器负载**的必要条件。

## 19. 未改动清单（§三十九 / §四十 / §四十一 / §四十六）

**未触碰**：`handEval` / `fastEval` / 底池赔率 / 所需权益 / SPR / combo 数学 /
权益算法 / EV 公式 · GTO（`GTOopen/`、`data/gto-cache`、gto quality、`gtoApi`）·
Raise EV（`RAISE EV = NOT_AVAILABLE` 未动）· `rangeCounter` ·
UI（无大幅改动）· 无 `skip` / `todo` / 删除失败测试 / 放宽容差。

## 20. 已知限制（**为什么是 PASS_WITH_WARNINGS**）

1. 🔴 **§二十五：画像影响已从 0.79pp 提到 1.80pp（≈2.3×），但权益维度仍差一点点
   才够 `MATERIAL`（0.0180 < 0.0200）**；质量维度 4.22pp 也未到 `massMaterial` 0.05。
   方向与可测性已解决，**幅度仍偏弱**。要再进一步需要让基础范围本身携带更多
   诈唬质量（那会触及 Range 层，超出本轮边界）。
2. ⚠️ `THIN_VALUE` 对**原型**画像不携带任何条件化（`thinValueBet` 在所有原型先验里中性）。
   这是 V1 D4 的既定结果，也符合 §十九；但意味着「薄价值」这条轴目前只对
   实测/人工证据敏感。**已在 §9 与测试中显式记录**，不作为缺陷隐瞒。
3. ⚠️ **`medianRangeDistance` 只在类级别度量**（5 个互不重叠的类别分量），
   不是逐组合的全分布距离。逐组合距离需要把两侧 `Range` 的 entries 对齐后比，
   当前 A/B 测试没有暴露那层数据（`profileClassMasses` 是类别聚合）。
   `profileRangeDistance` 本身对逐组合向量同样适用，只是本阶段的调用点用的是类别级向量。
4. ⚠️ `scripts/v2-unified-likelihood-probe.ts` 与 `scripts/tmp-v2-ab-probe.ts`
   是**临时测量探针**：前者建议保留（它同时是 NEUTRAL_PARITY 与钳位可见性的**可复现证据**），
   后者建议删除（其内容已被本文档的 A/B 表取代）。
5. ⚠️ 本阶段**未**做 §三十六 跨街层级 fallback、§二十四 环境分档、§二十三 历史库接入 ——
   与 V1 报告列出的相同，本轮未扩范围。

---

## 附：复现本报告全部数字的命令

```text
node --experimental-strip-types scripts/v2-unified-likelihood-probe.ts   # NEUTRAL_PARITY 48 格 + 钳位可见性
node --experimental-strip-types scripts/tmp-v2-ab-probe.ts               # §四十八 A/B 表
node --test --experimental-strip-types test/profileV2Metrics.test.ts     # 覆盖锁 + §23/27/28 + 钳位锁
node --test --experimental-strip-types test/profileQuantificationGolden.test.ts  # §二十 四条单调性 + §23 距离
npm run verify                                                          # 全门（typecheck + manifest + 1772 项）
```
