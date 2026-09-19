# 河牌下注范围确认实验 —— 诊断报告

**轮次性质**：只做诊断。未修改任何产品代码、未调参、未新增功能。
**日期**：2026-09-19
**复现对象**：Hero BTN A♠K♠｜Board K♦ 9♣ 4♥ 6♠ 2♦｜BB 河牌领打 40（底池 93）
**异常**：`EqVsBetRange = 0.54%`、`CALL EV ≈ −39.28`

---

## 0. 复现结果（先确认「同一个异常」）

| 量 | 引擎实测（本轮复现） | 审计报告 |
|---|---|---|
| pot | 93 | 93 |
| callCost | 40 | 40 |
| winnable（跟注后可争夺） | 133 | — |
| requiredEquity | 0.3007518796992481 | — |
| `math.heroEquity`（所谓 EqVsArrivalRange） | **0.659153024494907** | 65.92% |
| `math.heroEquityVsBetRange` | **0.005433446930540442** | 0.54% |
| `math.callEV` | **−39.277351558238124** | ≈ −39.28 |
| 引擎动作 | **FOLD** | — |

复现配置：6 人桌、`bigBlindBB = 2`（20BB = 40 筹码）、`equitySeed = 20261014`、
BB 的 `quickProfile = CALLING_STATION`、**无 HUD 实测统计**、`environment = MID_LOW_STAKES`。

```
行动史：UTG/HJ/CO FOLD｜BTN RAISE 3｜SB FOLD｜BB CALL 2
        FLOP BB CHECK｜BTN BET 2.5｜BB CALL
        TURN BB CHECK｜BTN BET 7.5｜BB CALL
        RIVER BB BET 20
```

**精度说明**：本节点河牌已发完，权益是**精确枚举**（`method=EXACT`，990 个 matchup），
不是蒙特卡洛 —— 0.54% 不是抽样噪声，是模型的确定输出。

**「独立复现 = 逐位一致」这条链的证明**（本轮所有归因实验的前提）：

| 复现对象 | 复现值 | 引擎值 | 差异 |
|---|---|---|---|
| 第 ④ 层范围权益 | 0.659153024 | 0.659153024494907 | < 1e-12（逐位） |
| 下注范围权益 | 0.0054334469305 | 0.005433446930540442 | < 1e-12（逐位） |

复现方式：`scripts/__make-shadow.ts` 从 `src/app/manualInput/contextBuilder.ts` **机械生成**
一份影子模块（只重写相对导入路径 + 追加一条 `export`），探针直接调用**产品自己的**
`buildRangeSnapshot` / `buildPlayerSnapshot` / `buildBettingRangeFacts` / `computeEquity`。
影子与原文的 diff 共 95 行 = 46 条导入路径 + 3 行追加导出，**无任何逻辑改动**。

---

## 第一部分 真实范围来源（逐层）

### 1.1 组合计数（每层相同）

```
全牌           1326 组合
被 Hero 底牌(A♠K♠) + 公共牌(K♦9♣4♥6♠2♦) 阻断   336 组合（死牌，两侧都不计）
合法组合        990 组合
正权重组合      469 组合（每层都是 469 —— 似然只改权重，不改支持集）
总权重          1.000000（每层都归一）
```

### 1.2 四层范围

| 层 | 正权组合 | 总权重 | Hero 相对权益 | 价值质量 | 摊牌质量 | 诈唬质量 | 更新轨迹 |
|---|---|---|---|---|---|---|---|
| ① 翻前（BB 跟注 BTN 开池） | 469 | 1.000000 | **91.99%** | 7.14% | 47.10% | 45.76% | （基础范围，翻前跟注不重复计费） |
| ② 翻牌跟注后（K94） | 469 | 1.000000 | **82.56%** | 14.79% | 69.97% | 15.24% | FLOP/CHECK → FLOP/CALL |
| ③ 转牌跟注后（K946） | 469 | 1.000000 | **75.52%** | 20.38% | 77.34% | 2.28% | ＋TURN/CHECK → TURN/CALL |
| ④ **河牌 BET 似然施加后**（＝引擎 `math.heroEquity` 的口径） | 469 | 1.000000 | **65.92%** | 29.59% | 70.09% | 0.32% | ＋**RIVER/BET** |

逐层强弱分布（逐组合精确比较）：

| 层 | Hero 领先（他更弱） | 平局 | Hero 落后（他更强） |
|---|---|---|---|
| ① | 91.13% | 1.73% | 7.14% |
| ② | 79.91% | 5.29% | 14.79% |
| ③ | 71.43% | 8.19% | 20.38% |
| ④ | 61.43% | 8.98% | 29.59% |

### 1.3 🔴 第一处必须点明的事实：第 ④ 层不是「河牌下注前的到达范围」

`updateTrace` 的最后一条是 **`RIVER / BET`**：

```
统一动作似然 V2（中性校准层 × 几何平均画像调整；同一条动作上抑制 adjustmentProvider）：
RIVER/BB/SRP/TURN_BET_CALL/LARGE/DRY；条目数 0–2；钳位 0/990（无饱和）
```

也就是说：**引擎在「他已经领打 40」之后，把这次下注的似然又乘进了范围**，
然后才把这份范围当作 `math.heroEquity`（界面/审计里叫 `EqVsArrivalRange`）的输入。

- 真正的「下注前到达范围」是**第 ③ 层：75.52%**；
- 引擎报出来的「Arrival Range 权益」是**第 ④ 层：65.92%**。

③ → ④ 的**隐含似然比**（这一条就是已经被施加过的「下注似然」）：

| 类别 | ③ 质量 | ④ 质量 | ④/③ |
|---|---|---|---|
| STRONG_VALUE | 0.061081 | 0.139499 | **×2.2838** |
| THIN_VALUE | 0.142713 | 0.156447 | ×1.0962 |
| SHOWDOWN_VALUE | 0.773400 | 0.700878 | ×0.9062 |
| MISSED_*（错失听牌） | 0.013996 | 0.001870 | **×0.1336** |
| PURE_AIR | 0.008809 | 0.001305 | **×0.1481** |
| 价值合计 | 0.203795 | 0.295946 | ×1.4522 |
| 诈唬合计（空气） | 0.022805 | 0.003175 | **×0.1392** |

⇒ 河牌那一次下注，**已经在"到达范围"里把空气压掉 ≈7.2 倍、把价值抬高 ≈1.45 倍**。

### 1.4 范围对象/口径核对：没有用错「面对 Hero 下注」的响应范围

`contextBuilder.ts:3559-3597`：

```ts
const bettorPosition = lastAggressorOfStreet(state.actions, state.street);   // = 'BB'
const primaryPosition = primaryOpponent.position;                            // = 'BB'
if (bettorPosition !== primaryPosition) return null;                         // 不触发
...
arrivalEntries: primaryBuild.range.entries    // ← 对手自己的范围对象
```

- `bettorPosition(BB) === primaryPosition(BB)` ⇒ 走的是「**他正在下注**」分支 ✅
- 下注范围的原料是 `primaryBuild.range`（Villain 本人的 `Range`）✅
- `CALL/RAISE/FOLD` 三个响应桶（`betResponse` 的 `classifyVillainAfterCheck` 家族）
  只出现在 `buildBetDecisionFacts`（**Hero 自己下注**的 EV 树）里，
  **没有**进入 Villain 的下注范围 ✅
- `bettingRange.ts` 文件头明确写着「不再用 `classifyVillainAfterCheck` 的 `weights.bet`」，
  代码与注释一致 ✅

**结论：不存在「拿 Call/Raise/Continue Range 冒充主动下注范围」这一类错误。**

---

## 第二部分 下注范围逐组合检查

### 2.1 P(BET | 手牌类别) 的取值与来源

Villain 的响应倾向（`responseTendenciesOf` 实测）：

```
confidence = 0.35
effectiveDimensions = { tightness 0.3, aggression 0.3, bluffTendency 0.35, passivity 0.8 }
modeledRatio = 40 / 53 = 0.7547（未超网格上限，sizeApproximation = false）
```

`betProbabilityByClass(tendencies, 0.7547)` 的输出，以及**它的算式**：

```text
center(v) = (v − 0.5) × 2   ⇒  a = −0.4（aggro）  b = −0.3（bluff）  p = +0.6（passive）
valueExponent = 1 + 0.5 × (0.7547 − 2/3) = 1.044
bluffExponent = 1 + 0.7 × (0.7547 − 2/3) = 1.0616

strong   = clamp01(0.45 + 0.30a + 0.25b)              = 0.2550 → polarize → 0.2442
thin     = clamp01(0.25 + 0.30a + 0.30b)              = 0.0400 → polarize → 0.0197
showdown = clamp01(0.10 + 0.15a + 0.15b − 0.20p)      = −0.1250 → **clamp01 ⇒ 0.0000** → polarize → 0
bluffRate= clamp01(bluffTendency × strong) = 0.35 × 0.2550 = 0.0892 → polarize → 0.0639
```

| 类别 | P(BET 40 \| 类别) |
|---|---|
| NUT_VALUE / STRONG_VALUE | 0.2442 |
| THIN_VALUE | 0.0197 |
| **SHOWDOWN_VALUE** | **0.0000（精确 0）** |
| MISSED_FLUSH / MISSED_STRAIGHT / MISSED_COMBO / PURE_AIR | 0.0639 |

### 2.2 下注范围的总量与构成

```
到达范围总质量        1.000000
下注范围总质量(归一前) 0.037360      ← 他会下注的比例 = 3.74%
组合数                469 → 236
归一化                Σp = 1.000000（正确）
```

| 下注范围类别质量 | 归一化后 |
|---|---|
| NUT_VALUE | 0.0000 |
| STRONG_VALUE（暗三条/顺子级） | **0.9119** |
| THIN_VALUE（两对/超对） | **0.0827** |
| SHOWDOWN_VALUE | **0.0000** |
| 错失听牌（三类合计） | 0.0032 |
| PURE_AIR | 0.0022 |
| **价值质量** | **0.994566553069** |
| **诈唬质量** | **0.005433446931** |

### 2.3 逐组合证据（236 个组合的完整清单见 `reports/evidence/river-betrange-01-layers-and-percombo.txt`）

权重最高的组合（全部是击败 AK 的牌）：

| Hand | Hand Strength | tier | 类别 | Arrival W | P(BET) | Bet W | Norm W | Hero Equity |
|---|---|---|---|---|---|---|---|---|
| 4d4c / 4s4c / 4s4d | 4 三条（暗三条） | 1 | STRONG_VALUE | 1.763e-2 | 0.2442 | 4.307e-3 | 0.1153 | 0 |
| 9h9d / 9s9d / 9s9h | 9 三条（暗三条） | 1 | STRONG_VALUE | 1.692e-2 | 0.2442 | 4.133e-3 | 0.1106 | 0 |
| KhKc | K 三条（暗三条） | 1 | STRONG_VALUE | 1.659e-2 | 0.2442 | 4.050e-3 | 0.1084 | 0 |
| 6d6c / 6h6c / 6h6d | 6 三条（暗三条） | 1 | STRONG_VALUE | 4.868e-3 | 0.2442 | 1.189e-3 | 0.0318 | 0 |
| 2h2c / 2s2c / 2s2h | 2 三条（暗三条） | 1 | STRONG_VALUE | 1.299e-3 | 0.2442 | 3.173e-4 | 0.0085 | 0 |
| 9dKc …（K9 顶两对 ×5） | 顶两对 K9 | 2 | THIN_VALUE | 1.247e-2 | 0.0197 | 2.462e-4 | 0.0066 | 0 |
| AdAc / AhAc / AhAd | 超对 A，K 踢脚 | 2 | THIN_VALUE | 1.224e-2 | 0.0197 | 2.417e-4 | 0.0065 | 0 |
| 2cKc / 2hKh | 顶两对 K2 | 2 | THIN_VALUE | 8.320e-3 | 0.0197 | 1.643e-4 | 0.0044 | 0 |
| 4cKc | 顶两对 K4 | 2 | THIN_VALUE | 8.316e-3 | 0.0197 | 1.642e-4 | 0.0044 | 0 |
| 6cKc / 6hKh | 顶两对 K6 | 2 | THIN_VALUE | 8.305e-3 | 0.0197 | 1.640e-4 | 0.0044 | 0 |
| 6d9d / 6h9h | 两对 96 | 2 | THIN_VALUE | 5.720e-3 | 0.0197 | 1.130e-4 | 0.0030 | 0 |
| 3c5c …（6 高顺子 ×4） | 顺子 6 | 1 | STRONG_VALUE | 1.850e-4 | 0.2442 | 4.519e-5 | 0.0012 | 0 |
| TdAc / ThAc / …（AK 高牌 ×9） | 高牌 AKT96 | 5 | PURE_AIR | 2.285e-5 | 0.0639 | 1.461e-6 | ≈0.0000 | **1** |
| JdQc / …（错失顺听 ×多） | 高牌 KQJ96 | 5 | MISSED_STRAIGHT_DRAW | 2.085e-5 | 0.0639 | 1.333e-6 | ≈0.0000 | **1** |

> 说明：本板上**不可能有成花**（公共牌只有 2 张 ♦）；**不可能有顺子**除了 2-3-4-5-6 用底牌 3/5 的极小概率组合。
> 击败 AK 的可达牌只有两类：**暗三条**（99/44/66/22/KK）与**两对**（K9/K6/K4/K2/96/64/42）＋超对 AA。

### 2.4 按牌型分类汇总（用户指定的桶）

| 桶 | 组合数 | 到达质量 | 下注质量 | 归一化后 | 桶内 Hero 权益 | 对总权益贡献 |
|---|---|---|---|---|---|---|
| 44（暗三条，比 AK 强） | 3 | 5.290e-2 | 1.292e-2 | 0.3458 | 0.00% | 0.00% |
| 99（暗三条，比 AK 强） | 3 | 5.077e-2 | 1.240e-2 | 0.3318 | 0.00% | 0.00% |
| KK（三条，比 AK 强） | 1 | 1.659e-2 | 4.050e-3 | 0.1084 | 0.00% | 0.00% |
| 66（暗三条，比 AK 强） | 3 | 1.461e-2 | 3.567e-3 | 0.0955 | 0.00% | 0.00% |
| 两对（K9/K6/K4/K2，比 AK 强） | 10 | 1.039e-1 | 2.052e-3 | 0.0549 | 0.00% | 0.00% |
| 22（暗三条，比 AK 强） | 3 | 3.897e-3 | 9.518e-4 | 0.0255 | 0.00% | 0.00% |
| AA（比 AK 强） | 3 | 3.672e-2 | 7.252e-4 | 0.0194 | 0.00% | 0.00% |
| 其他比 AK 强的成手（两对 96/64/42） | 10 | 1.656e-2 | 4.932e-4 | 0.0132 | 0.00% | 0.00% |
| **错失听牌 / 纯空气** | **200** | **3.175e-3** | **2.030e-4** | **0.0054** | **100.00%** | **0.54%** |
| **KQ / KJ / KT / 其他弱 Kx** | **0** | **0** | **0** | **0** | — | **0.00%** |
| **中等对子 / 小对子** | **0** | **0** | **0** | **0** | — | **0.00%** |
| **AK（平局）** | **0** | **0** | **0** | **0** | — | **0.00%** |

### 2.5 到达范围（④）被过滤掉的类别 —— 这就是答案

| 类别 | 组合数 | 到达质量 | P(BET\|类) | 贡献质量 | 占下注范围 |
|---|---|---|---|---|---|
| STRONG_VALUE | 17 | 0.1395 | 0.2442 | 3.407e-2 | **91.19%** |
| **SHOWDOWN_VALUE** | **233** | **0.7009** | **0.0000** | **0.000e+0** | **0.00%** |
| THIN_VALUE | 19 | 0.1564 | 0.0197 | 3.090e-3 | 8.27% |
| MISSED_STRAIGHT_DRAW | 112 | 0.0016 | 0.0639 | 1.012e-4 | 0.27% |
| MISSED_COMBO_DRAW | 12 | 0.0001 | 0.0639 | 9.482e-6 | 0.03% |
| PURE_AIR | 67 | 0.0013 | 0.0639 | 8.342e-5 | 0.22% |
| MISSED_FLUSH_DRAW | 9 | 0.0001 | 0.0639 | 8.941e-6 | 0.02% |
| 合计 | 469 | 1.0000 | — | 3.736e-2 | 3.74% |

### 2.6 🔴 核心恒等式

```
EqVsBetRange = 0.005433446930540442
诈唬质量     = 0.005433446931
价值质量     = 0.994566553069     （全部击败 AK，Hero 权益 0）
摊牌质量     = 0.000000000000     （平局组合被一并删光，Hero 的 0.5 分成也没了）
```

> **Hero 对下注范围的权益 = 模型自己给下注范围设定的诈唬占比。**
> 不是「对手真的很强」，而是「模型把『Hero 能击败的牌』定义成了不会下注的牌」。

### 2.7 回答用户的问题：是权重模型过滤，还是链路算错？

**是权重模型明确过滤；权重生成、归一化、范围对象、牌力判断都正确。**

证据（全部逐位可复现）：

1. **归一化正确**：`Σ BetW / betMass = 1.000000`，236 个组合的 Norm W 合计为 1。
2. **范围对象正确**：`arrivalEntries` 是 Villain 本人的 469 个可达组合，无一条来自 Hero 的响应桶。
3. **牌力判断正确**：逐组合用 `handEval.compareHands` 精确比较，`weird` 结果为零；
   每条 0.0000 权益都对应真实的暗三条/两对。
4. **过滤是显式的**：`SHOWDOWN_VALUE` 的 P(BET) 被算成**精确 0**，
   233 个组合（占到达质量 **70.09%**）被整类删除；`THIN_VALUE` 只剩 0.0197（比强价值低 12.4 倍）。
5. **诈唬并没有被额外打压**：空气的 P(BET)=0.0639 反而是薄价值的 3.2 倍；
   诈唬质量之所以只有 0.54%，是因为**到达范围里空气本身只剩 0.32%**（第 ③→④ 层与三街跟注似然共同造成的）。

---

## 第三部分 行动上下文

| 检查项 | 实测 | 判定 |
|---|---|---|
| 本街（RIVER）最后进攻者 | `BB` | — |
| 首要对手位置 | `BB` | — |
| 是否同一人 | **true** | 走「他正在下注」分支 ✅ |
| `actionContext`（`nodeActionContextOf`） | **`FACING_DONK`** | 上一街（TURN）进攻者是 BTN ⇒ 他领打，语义正确 ✅ |
| `betSize` | 40 筹码（20BB） | — |
| `betRatioToPot` | 40 / 53 = **0.7547** | — |
| `betRangeSizing` | `{actualBetChips:40, potChips:53, actualRatio:0.754717…, modeledRatio:0.754717…, sizeApproximation:false}` | 未做尺寸近似 ✅ |
| `resolvedDimensions`（CALLING_STATION 无统计） | `{tightness 0.3, aggression 0.3, bluffTendency 0.35, passivity 0.8}` | — |
| `resolvedV3.street[RIVER]` | `{foldScale 1, callScale 1, checkRaiseScale 1, betScale 0.625}` | `betScale` **未进入**下注范围（见下） ✅/⚠️ |
| `deniedStreetTraits` | `null`（无实测统计，没有统计被误用） | ✅ |
| `FoldToRiverBet` 是否被用于主动下注范围 | **否**。`betProbabilityByClass` 只读 `tendencies.effectiveDimensions` 四个标签维度；`foldToRiverBet` 属于响应层（`responseTendenciesOf` 的 `streetFoldScale`），只作用于「Hero 下注时他会怎么办」 | ✅ |

**节点定性确认**：Hero 前两街持续下注（FLOP/TURN 最后进攻者均为 BTN），
Villain 前两街跟注，河牌**主动领打**。这是 **Villain 的主动下注行为**，
`buildBettingRangeFacts` 也确实走的是「他正在下注」分支，**不是**面对 Hero 下注的响应模型。✅

### 3.1 ⚠️ HUD 实测统计对「他的下注范围」完全没有影响

同一牌局，只改实测统计（`observedStats`）：

| 配置 | resolvedV3.resolvedDimensions | 进 P(BET) 的 `tendency.dimension.dimensions` | EqVsBetRange（12 位） | CALL EV | 动作 |
|---|---|---|---|---|---|
| CALLING_STATION 无统计 | tight 0.30 / agg 0.30 / bluff 0.35 / passive 0.80 | **同上** | 0.005433447 | −39.277352 | FOLD |
| CALLING_STATION + MANIAC 统计（vpip60/pfr45/wtsd35/foldToRiverBet18%） | tight 0.247 / agg 0.705 / bluff 0.35 / passive 0.712 | **仍然 = 标签值** | **0.005433447** | **−39.277352** | FOLD |
| CALLING_STATION + NIT 统计（vpip15/pfr12/wtsd22/foldToRiverBet75%） | tight 0.593 / agg 0.330 / bluff 0.35 / passive 0.624 | **仍然 = 标签值** | **0.005433447** | **−39.277352** | FOLD |
| NORMAL 无统计 / +MANIAC / +NIT | 三组各不相同 | 三组都 = 标签值 | 0.353122265 | 6.965261 | RAISE |

⇒ 实测统计**逐位不改变** `heroEquity`、`EqVsBetRange`、`callEV`。
原因：`observedStats` 只进 V3 的 `resolvePlayerProfile`（分街系数），
而 `betProbabilityByClass` 读的是 `playerBuilt.tendency.dimension.dimensions`
（由 `quickProfile` 标签先验推出）；V3 的 `street[RIVER].betScale`（0.625 / 0.9205 …）
在 `betProbabilityByClass` 里**没有被读取**。见第六部分「缺少哪些统计」。

---

## 第四部分 合成范围反证

保持 Hero 手牌、牌面、底池（93）、下注额（40）与 Arrival Range（引擎口径 ④，469 组合）不变，
只用**显式权重**构造两组下注范围（`BetW = ArrivalW × w`，再归一化，`w ∈ [0,1]`）：

- **A（以击败 Hero 的价值牌为主）**：击败 Hero 的牌 `w = 0.80`；Hero 能击败的弱价值牌 `w = 0`；平局牌 `w = 0.40`；空气/错失听牌 `w = 0.20`
- **B（含更多 Hero 能击败的弱价值牌与诈唬）**：击败 Hero 的牌 `w = 0.50`；Hero 能击败的牌 `w = 0.50`；平局 `w = 0.50`；空气/错失听牌 `w = 0.50`

| 组 | 组合数 | EqVsArrivalRange | EqVsBetRange | Required Equity | CALL EV | FOLD EV | Final Action |
|---|---|---|---|---|---|---|---|
| A | 242 | **0.659153** | **0.068043** | 0.300752 | **−30.9511** | 0 | **FOLD** |
| B | 469 | **0.659153** | **0.659153** | 0.300752 | **+47.6674** | 0 | **CALL** |

- Arrival Equity 两组**完全相同**（0.659153，同一份范围）✅
- Bet Range Equity 随下注权重正确变化（A: 6.80%，B: 65.92%）✅
- `CALL EV = EqVsBetRange × winnable(133) − call(40)` —— 与引擎口径一致 ✅
- 权重合法（`w ∈ [0,1]`）、归一化正确（两组 `Σp = 1.000000`）✅
- **最终动作由 `CALL EV > FOLD EV` 决定，未硬编码**：A ⇒ FOLD，B ⇒ CALL ✅

同一构造用在**真正下注前**的到达范围（③）上：`EqVsArrival = 0.755247`，A ⇒ 0.000000，B ⇒ 0.778035。

**结论：这条链路（要求权益 → Bet Range 权益 → CALL EV → 动作）本身是通的、正确的。
0.54% 不是从这条链路漏出来的，而是从「下注权重怎么定」这一步进去的。**

---

## 第五部分 人物画像对照

只改 `quickProfile` 标签，其余输入完全不变（无 HUD 统计）：

| 画像 | resolvedDimensions（tight/agg/bluff/passive） | P(BET\|STRONG) | P(BET\|THIN) | **P(BET\|SHOWDOWN)** | P(BET\|AIR) | Bet Range 支持 | 价值质量 | 诈唬质量 | 摊牌质量 | 下注占比 | EqVsBetRange | CALL EV | 动作 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| NORMAL | 0.50 / 0.50 / 0.50 / 0.50 | 0.4478 | 0.2390 | 0.0824 | 0.2081 | 469 | 62.25% | 0.80% | 36.95% | 15.66% | **0.353122** | +6.9653 | RAISE |
| CALLING_STATION | 0.30 / 0.30 / 0.35 / 0.80 | 0.2442 | 0.0197 | **0.0000** | 0.0639 | 236 | 99.46% | 0.54% | 0.00% | 3.74% | **0.005433** | −39.2774 | FOLD |
| MANIAC | 0.15 / 0.92 / 0.90 / 0.35 | 0.9197 | 0.7527 | 0.4019 | 0.8310 | 469 | 45.11% | 1.97% | 52.92% | 53.06% | **0.513312** | +28.2705 | RAISE |
| VERY_TIGHT（= 用户所称 NIT） | 0.88 / 0.45 / 0.15 / 0.45 | 0.2338 | **0.0000** | **0.0000** | 0.0082 | 217 | 99.88% | 0.12% | 0.00% | 3.09% | **0.001167** | −39.8448 | FOLD |

**四组并不都接近 0.54%** ⇒ 「所有标签都被过度过滤」这个假设**不成立**。
真正的分界是**被动项 `passivity`**，逐画像的公式级归因：

| 画像 | strong（未夹取） | thin（未夹取） | **showdown = 0.10 + 0.15a + 0.15b − 0.20p** | bluffRate |
|---|---|---|---|---|
| NORMAL | 0.4500 | 0.2500 | **+0.1000**（> 0 ⇒ 有效） | 0.2250 |
| CALLING_STATION | 0.2550 | 0.0400 | **−0.1250 ⇒ 夹到 0** | 0.0892 |
| MANIAC | 0.9020 | 0.7420 | **+0.4060**（> 0 ⇒ 有效） | 0.8118 |
| VERY_TIGHT | 0.2450 | 0.0100 | **0.0000 ⇒ 夹到 0** | 0.0368 |

⇒ 一旦 `passivity` 足够高（本节点阈值 ≈ `0.15(a+b) − 0.2p ≤ −0.1`），
**SHOWDOWN 整类被精确清零**，Hero 能击败的 70.09% 到达质量全部退出下注范围。

---

## 第六部分 最终裁决

# ✅ BET_RANGE_MODEL_LIMITATION

**0.54% 不是算错，是模型的假设在这一点上退化。** 但它同时暴露两处必须单独记账的缺陷，
下面分开写，避免把「模型局限」当成「一切正常」。

### 6.1 为什么是「模型局限」而不是「算错」（证据）

1. 全链路逐位可复现（`< 1e-12`），权益是**精确枚举**而非抽样（0.54% 不是噪声）。
2. 类别权重、归一化、范围对象、牌力比较、`CALL EV` 公式**全部正确**（第四部分反向验证：
   同一链路在 A/B 两组合成范围上给出正确的不同结论与不同动作）。
3. `EqVsBetRange` 恰好等于**模型自己给下注范围设定的诈唬质量**（0.005433446931）。
   也就是说：这个数字不是「推断出对手很强」，而是「把 Hero 能击败的牌定义为不会下注」的**同义反复**。
4. 决定这个数字的，是 `betProbabilityByClass` 里的一条可读公式在被动标签下被下限夹到 0；
   不是任何越界、错位、NaN、缓存或索引错误。

### 6.2 直接导致 0.54% 的那一条假设（模型局限的具体位置）

> **「比 Hero 弱 ⇒ 有摊牌价值 ⇒ 不下注」+「摊牌类频率公式在被动画像下夹到 0」。**

```text
riverComboClassOf → classifyRiverAction（riverActionClass.ts:92-108）
  WEAKER 且 tier ≤ 3  ⇒ SHOWDOWN          ← 把「不会诈唬」写成了「不会下注」
  WEAKER 且 tier = 5  ⇒ BLUFF_CANDIDATE

betProbabilityByClass（bettingRange.ts:206-247）
  showdown = clamp01(0.10 + 0.15a + 0.15b − 0.20p)   ← CALLING_STATION: −0.1250 ⇒ 0
```

**本板上的后果（具体组合）**：KQ / KJ / KT（顶对弱踢，tier 2）、88/77/T9s 一类中对（tier 3）、
4x/6x/2x 中对与底对（tier 4）——**共 233 个组合、占到达质量 70.09%**，
全部被判为「不会下注」，权重被乘 0。
而其中 KQ/KJ/KT 恰恰是「跟了两街、河牌领打」这条线上最常见的**取值牌**。
分类轴是 `versusHero`（上帝视角），因此模型无法表达「他认为自己领先所以下注」。

### 6.3 归因实验：每次只改一个假设

| 场景 | 下注占比 | 价值质量 | 诈唬质量 | **EqVsBetRange** | CALL EV | 动作 |
|---|---|---|---|---|---|---|
| **S0 引擎现状** | 3.74% | 99.46% | 0.54% | **0.005433** | −39.2774 | FOLD |
| S1 只把 SHOWDOWN 从 0 放开到 0.0824（NORMAL 的值） | 9.51% | 39.07% | 0.21% | **0.570435** | +35.8679 | **CALL** |
| S2 只把「比 Hero 弱的顶对 KQ/KJ/KT」按强价值下注（0.2442） | 14.24% | 26.09% | 0.14% | **0.739054** | +58.2942 | **CALL** |
| S3 只换成真正「下注前」的到达范围 ③（去掉下注似然的重复计费） | 1.92% | 92.40% | 7.60% | **0.075965** | −29.8967 | FOLD |
| S4 S1+S2+S3 同时 | 14.64% | 12.11% | 1.00% | **0.855809** | +73.8226 | **CALL** |
| S5 只把「他领先的顶对/中对」按薄价值 0.30 下注 | 22.81% | 16.29% | 0.09% | **0.820868** | +69.1754 | **CALL** |

（S0 复刻校验：下注质量 0.037360、组合数 236、权益 0.0054334469305 —— 与引擎**逐位一致**。）

**结论**：0.54% 由「SHOWDOWN 整类清零」主导（S1 单独一项就把权益从 0.54% 抬到 57.04%，
并让动作从 FOLD 翻成 CALL）。重复计费是**次要**成因（S3 单独修改只到 7.60%，动作仍为 FOLD）。

### 6.4 同时确认的**次要缺陷**（这一类属于 Bug，必须单独记账）

> **⚠️ 附：`BET_RANGE_BUG_CONFIRMED`（数据流缺陷，非 0.54% 的主因）**

1. **下注似然被计两次。**
   `contextBuilder.ts:3583` 把 `primaryBuild.range.entries` 作为「到达范围」交给
   `buildBettingRangeFacts`，但 `primaryBuild` 由 `buildRangeSnapshot` → `applyLikelihoodUpdates`
   生成，而后者已经把**本街的 BET 动作**按 `estimateUnifiedActionLikelihood` 当似然乘过一次
   （`updateTrace` 最后一条 = `RIVER/BET`）。
   于是下注范围 = `先验 × P(BET|手牌) × P(BET|类别)` —— 同一条动作的似然被平方。
   实测代价：到达权益 75.52%（③ 真值）被显示成 65.92%（④），下注范围权益 7.60% 被压到 0.54%。
2. **字段名实不符。** `math.heroEquity` 在界面/审计里被读作 `EqVsArrivalRange`（"他到达时拥有什么"），
   但它对应的范围**已经包含他在河牌下注这一事实**。因此审计报告里
   「65.92% → 0.54%」这个对比，实际比的是「下注后范围」与「下注后范围再平方」，而不是「到达 → 下注」。
3. **V3 分街系数在下注范围里失效。** `responseTendenciesOf` 算出 `streetBetScale`
   （本节点 CALLING_STATION = 0.625），但 `betProbabilityByClass` 不读取它；
   实测统计（含 `foldToRiverBet`）逐位不改变 `EqVsBetRange`（见 3.1）。

**受影响函数 / 数据流 / 最小复现**：

| 项 | 内容 |
|---|---|
| 受影响函数 | `contextBuilder.ts:3559-3606`（`bettingRangeFacts` / `heroEquityVsBetRange`）；`bettingRange.ts:206-247`（`betProbabilityByClass`）；`riverActionClass.ts:92-108` + `riverProfileClassify.ts:228-282`（分类轴） |
| 错误数据流 | `buildRangeSnapshot`（含 `RIVER/BET` 似然）→ `primaryBuild.range` → `buildBettingRangeFacts(arrivalEntries)` → `× P(BET\|类别)` → `rangeEquityOfMany` → `math.heroEquityVsBetRange` → `callEV` |
| 最小复现 | 6 人桌、BTN A♠K♠、board K♦9♣4♥6♠2♦、历史见 §0、`quickProfile = CALLING_STATION`（或 `VERY_TIGHT`）、**无 HUD 统计**、`bigBlindBB = 2`；脚本 `scripts/audit-river-betrange.ts` |
| 触发条件（结构性） | `0.10 + 0.15·center(aggro) + 0.15·center(bluff) − 0.20·center(passivity) ≤ 0`（本节点 = −0.125） |
| 建议修复范围（本轮**不**实施） | ① 交给 `buildBettingRangeFacts` 的应是**未施加本街 BET 似然**的到达范围（或在 `applyLikelihoodUpdates` 中排除当前节点动作）＋ 字段更名/加注；② `showdown` 的取值域需要下限或结构性重写；③ 分类轴引入「他自认为领先」的判据（例如相对**他自身范围**的强度，而非相对 Hero 的牌力） |

### 6.5 缺少哪些真实统计才能校准（回答「模型局限缺什么」）

1. **河牌领打（donk/lead）频率** —— 尤其「面对连续两街 cbet 后河牌领打」这一节点的总频率。
   现在这个频率完全由标签维度合成，没有任何实测入口。
2. **按手牌类别的河牌下注频率**：顶对弱踢 / 第二对子 / 错过听牌 各自的下注率。
   这是 `SHOWDOWN_VALUE` 与 `THIN_VALUE` 频率的唯一正确标定来源。
3. **下注尺寸 × 范围的联合分布**（本节点 0.7547 池的下注范围构成）。
4. **WTSD / W$SD**：用于区分「有摊牌价值就不下注」与「有摊牌价值但会薄价值下注」。
5. **实测统计进入下注范围的通道**（当前 `observedStats` 只影响 V3 分街系数，不影响本模型）。

### 6.6 一句话结论

> **软件并不是"认为"对手几乎全是能击败 AK 的牌 —— 它把「Hero 能击败的牌」在定义上排除出了下注范围
> （`P(BET | SHOWDOWN_VALUE)` 被夹到精确 0），只留下"能击败 Hero 的价值牌 + 极少量诈唬"。
> 于是 `EqVsBetRange` 退化成模型自己设定的诈唬占比 0.54%。
> 计算链路没有错（逐位可复现、精确枚举、反向合成测试通过）；
> 错的是这条下注权重假设把「不会诈唬」当成了「不会下注」，并且它在被动画像上退化成了 0。
> 另有一处必须单独修的数据流缺陷：本街下注似然被计了两次，且 `math.heroEquity` 被当成"下注前到达范围"呈现。**

---

## 附录：证据文件与脚本

| 文件 | 内容 |
|---|---|
| `scripts/audit-river-betrange.ts` | 主探针（六部分全量输出） |
| `scripts/audit-river-betrange-deep.ts` | 归因实验 S0–S5、③/④ 逐类似然比、全组合清单 |
| `scripts/audit-river-betrange-stats.ts` | 画像 × HUD 统计对照 |
| `scripts/audit-river-betrange-probe.ts` | 结构探查（首次复现） |
| `scripts/__make-shadow.ts` → `scripts/__shadow-contextBuilder.ts` | 临时审计影子模块（由产品源码机械生成，仅改导入路径 + 追加 export） |
| `reports/evidence/river-betrange-01-layers-and-percombo.txt` | 逐层范围 + 236 组合逐条权重 |
| `reports/evidence/river-betrange-02-attribution.txt` | S0–S5、似然比、469 组合全清单 |
| `reports/evidence/river-betrange-03-profile-x-stats.txt` | 八组画像×统计对照（12 位精度） |

**本轮未修改任何产品代码**：`src/` 下文件的最后修改时间均为 11:01–12:51（本轮工作开始之前），
本轮的写入全部发生在 `scripts/` 与 `reports/`（13:13 之后）。
