## A. 矩阵清点

- 组合数（脚本声称）：**1260**
- 实际行数：**1260**
- 可分析：**1260** / 1260；失败 **0**
- 补充矩阵（MANIAC / VERY_LOOSE）：**280 行**（主矩阵 9 档之外，避免把「没测」写成「测了失败」）
- 不同权益值个数：**267**
- 不同诈唬质量个数：**267**
- 不同动作：**CALL**
- 总耗时：**778.4 s**（逐行实测 elapsedMs 之和）

## B. 中性对照（**这是所有 Δ 的分母**）

| 对照 | 权益 | 诈唬质量 | 跟注 EV | 动作 | 组合数 |
|---|---|---|---|---|---|
| NORMAL/E0/N0（中性） | 56.2588% | 1.8421% | 12.442 | CALL | 449 |
| UNKNOWN/E0/N0（无画像） | 56.2588% | 1.8421% | 12.442 | CALL | 449 |

- **UNKNOWN 与 NORMAL 逐位相同（仅限本场景 S1 / SRP）**：是

> 🔴 **适用范围必须与这句话一起读**（独立审查 FALSIFY：`reports/V21_REVIEW_5_COUNTEREVIDENCE.md`）：
> 逐位相等只在**加注池（SRP）**上成立。**跛入池上不成立** —— 本轮自己的 S7 夹具实测
> `UNKNOWN = 0.07845850542399040` vs `NORMAL = 0.07872806694852144`（**Δ = 2.695615e-4**）。
> 机制：`quickProfileToLimperArchetype('NORMAL')` 给出**带 0.35 可信度**的原型，
> 而 UNKNOWN 的可信度为 0 ⇒ `effectiveTraits` 的混合方式不同。
> 因此**不得**把 `NEUTRAL_PARITY` 说成「全生产入口成立」。

## C. 合理输入范围内的最大 / 典型 Δ（分母 = 1260 个组合，全部相对中性对照）

| 量 | min | p50（典型） | p95 | max | mean |
|---|---|---|---|---|---|
| equityDelta（pp） | -0.5728 | -0.0354 | 0.9840 | 1.3748 | 0.0105 |
| bluffMassDelta（pp） | -1.2041 | -0.0335 | 2.3000 | 3.1761 | 0.0785 |
| 类别级 rangeDistance（**TV**，CATEGORY_LEVEL） | 0.0000 | 0.0052 | 0.0230 | 0.0318 | 0.0071 |

> ⚠️ **TV 与 bluffMassDelta 不是两个独立证据**。在本夹具里，两个后验分布的总质量都是 1，
> 而画像**只**改诈唬类（错过了听牌 + 纯空气）⇒ 其它三个分量逐位不变
> ⇒ `TV ≡ |ΔbluffMass|`（独立核查实测：0.04216817393165691 vs 0.04216817393165682，差 1e-16）。
> 因此**不得**把它当成「第二个独立指标」来加强结论。

- **最大 |equityDelta|** = **1.3748pp** @ `BLUFF_HEAVY / E1_MANUAL_STRONG / N0_NO_OBSERVATION / dev=0.8 (机会 0, 成功 0)`
- **最大 |bluffMassDelta|** = **3.1761pp** @ `BLUFF_HEAVY / E1_MANUAL_STRONG / N0_NO_OBSERVATION / dev=0.8 (机会 0, 成功 0)`

### C.1 materiality —— **用未舍入实测值、逐行判定**

```text
MATERIALITY_THRESHOLDS = {"equityTrivial":0.005,"equityMaterial":0.02,"equityStrong":0.05,"massTrivial":0.01,"massMaterial":0.05}
max |equityDelta|    = 0.013748227231824228  （1.3748pp）  @ BLUFF_HEAVY / E1_MANUAL_STRONG / N0_NO_OBSERVATION / dev=0.8 (机会 0, 成功 0)
max |bluffMassDelta| = 0.03176097057388931  （3.1761pp）  @ BLUFF_HEAVY / E1_MANUAL_STRONG / N0_NO_OBSERVATION / dev=0.8 (机会 0, 成功 0)
两者是否同一行        = 是（同一行，因此这一对是**实测组合**）
```

**逐行判定**（用该行**原始**值，不做 base+delta 重建）：

- **最强判定 = `TRIVIAL`** @ `VERY_TIGHT / E0_TAG_PRIOR_ONLY / N0_NO_OBSERVATION / dev=0.05 (机会 0, 成功 0)`
  - equityDelta = `-0.0028368081376471954`（-0.2837pp）；bluffMassDelta = `-0.005285636822366779`（-0.5286pp）
  - `画像物性 TRIVIAL（EXPERIMENTAL 阈值）：权益差 -0.28pp｜诈唬质量差 -0.53pp｜EV 差 -0.13 筹码｜范围距离 0.0000`
- 判定分布（**分母 = 1260 行**）：TRIVIAL 1260（100.0%）

- 阈值比较（**这是判定依据，不是展示数字**）：|equityDelta| 0.0137 vs equityMaterial 0.02 → <；|bluffMassDelta| 0.0318 vs massMaterial 0.05 → <
- 两维取或 ⇒ TRIVIAL（这与上面**逐行判定**的最强档位一致：是）

- ⚠️ **同一单元**里最接近阈值的是 `BLUFF_HEAVY / E1_MANUAL_STRONG / N0_NO_OBSERVATION / dev=0.8 (机会 0, 成功 0)`：equityDelta=1.3748pp（占阈值 0.69×）、bluffMassDelta=3.1761pp（占阈值 0.64×）

## D. action flip

- 翻转数：**0** / 1260 = **0.00%**
- 中性对照动作：**CALL**
- 原动作 → 新动作分布：

## E. 单调性核查（**用同一档样本量横向比较**）

### E.1 「机会数 ↑ ⇒ 越靠近实测」（同一原型、同一偏离、同一证据强度）

| 原型 | 偏离 | 机会数 → 权益（E0 标签先验 / E3 实测重申） |
|---|---|---|
| VERY_TIGHT | 0.8 | N0: 55.98/55.98 · N2: 55.98/56.08 · N20: 55.98/56.24 · N200: 55.98/56.35 · N1000: 55.98/56.37 |
| NORMAL | 0.8 | N0: 56.26/56.26 · N2: 56.26/56.34 · N20: 56.26/56.47 · N200: 56.26/56.57 · N1000: 56.26/56.58 |
| MANIAC | 0.8 | N0: 57.61/57.61 · N2: 57.61/57.73 · N20: 57.61/57.88 · N200: 57.61/57.98 · N1000: 57.61/58.00 |
| BLUFF_HEAVY | 0.8 | N0: 57.24/57.24 · N2: 57.24/57.36 · N20: 57.24/57.50 · N200: 57.24/57.61 · N1000: 57.24/57.63 |

> ⚠️ **左列（E0）在所有机会数上都不动** —— 因为 E0 是「只有标签先验」，
> 它根本没有用到机会数。只有右列（E3 实测重申）随机会数移动。

### E.2 偏离程度 ↑ ⇒ 诈唬质量 ↑（同一原型、同一证据强度 E1 人工读、同一档）

| 原型 | 4.8%(0.05) | 20%(0.20) | 45%(0.45) | 65%(0.65) | 80%(0.80) | 单调? |
|---|---|---|---|---|---|---|
| VERY_TIGHT | 1.195 | 1.411 | 1.668 | 1.914 | 2.213 | ✅ |
| NORMAL | 1.535 | 1.756 | 2.019 | 2.270 | 2.575 | ✅ |
| MANIAC | 4.042 | 4.436 | 4.903 | 5.348 | 5.885 | ✅ |
| BLUFF_HEAVY | 3.376 | 3.726 | 4.142 | 4.539 | 5.018 | ✅ |

> ⚠️ **E0（只有标签先验）下这一行必然恒定** —— 标签先验不使用人工读，
> 因此那里「单调」无从谈起，本表**只**用 E1。第一版脚本误用 E0，
> 把「未测」印成了「❌ 不单调」（独立统计审查 C5 指出）。

## F. 语料覆盖（8 场景 × 8 画像探针）

| 场景 | 我的位置 | 手牌 | 公共牌 | 街 | 底池 | 有效筹码 | 类型 | 底池结构 | 桌型 | 中性权益 | 中性动作 | 跟注站→疯子 权益 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `S1_RIVER_BLUFFCATCH_TURN_CHECKBACK` | **CO** | AcJh | Ad 8s 4s 2c Kd | RIVER | 19.5BB | 100BB | BLUFF_CATCH | SRP | 9-max | 56.26% | CALL | 55.81% → 57.61% |
| `S2_RIVER_BLUFFCATCH_TURN_BETCALL` | **BB** | KhQh | Kc 9s 5d 2h 7c | RIVER | 19.5BB | 100BB | BLUFF_CATCH | SRP | 9-max | 27.67% | CALL | 27.44% → 28.61% |
| `S3_TURN_FACING_BET` | **BB** | AsQs | Qd Jh 4h 6c | TURN | 22BB | 100BB | FACING_BET | SRP | 9-max | 48.28% | CALL | 48.30% → 49.02% |
| `S4_FLOP_HERO_VALUE_BET` | **CO** | AcJh | Ad 8s 4s | FLOP | 5BB | 100BB | VALUE_BET | SRP | 9-max | 76.88% | BET | 76.53% → 76.55% |
| `S5_RIVER_OVERBET_FACING` | **BB** | KsQs | Kd 8c 3h 2d 7s | RIVER | 19.5BB | 100BB | BLUFF_CATCH | SRP | 9-max | 49.24% | CALL | 47.09% → 55.11% |
| `S6_THREEBET_POT_TURN_FACING` | **BB** | AsKs | Kh 7d 2c Js | TURN | 40.5BB | 100BB | FACING_BET | THREE_BET | 9-max | 45.69% | RAISE | 45.75% → 46.64% |
| `S7_LIMPED_POT_RIVER_BLUFFCATCH` | **BB** | 9h9c | Qs 8d 3c 6s Ks | RIVER | 13BB | 100BB | BLUFF_CATCH | LIMPED | 6-max | 7.87% | FOLD | 7.86% → 9.45% |
| `S8_SEVEN_HANDED_UNSUPPORTED` | **BB** | AcJh | Ad 8s 4s 2c Kd | RIVER | 19.5BB | 100BB | BLUFF_CATCH | UNSUPPORTED | 7-max | **UNSUPPORTED** | — | —% → —% |

### F.1 每个场景的画像敏感性（中性 → 跟注站 / 疯子）

| 场景 | 中性 EQ / 诈唬 / 动作 | 跟注站 EQ / 诈唬 / 动作 / ΔEQ | 疯子 EQ / 诈唬 / 动作 / ΔEQ | 尺寸变化 |
|---|---|---|---|---|
| `S1_RIVER_BLUFFCATCH_TURN_CHECKBACK` | 56.26% / 1.84% / CALL | 55.81% / 0.78% / CALL (-0.45pp) | 57.61% / 5.00% / CALL (1.35pp) | — |
| `S2_RIVER_BLUFFCATCH_TURN_BETCALL` | 27.67% / 1.72% / CALL | 27.44% / 1.16% / CALL (-0.23pp) | 28.61% / 2.89% / CALL (0.94pp) | — |
| `S3_TURN_FACING_BET` | 48.28% / 8.55% / CALL | 48.30% / 8.14% / CALL (0.02pp) | 49.02% / 9.60% / CALL (0.74pp) | — |
| `S4_FLOP_HERO_VALUE_BET` | 76.88% / 41.90% / BET | 76.53% / 42.04% / BET (-0.35pp) | 76.55% / 41.71% / BET (-0.33pp) | — |
| `S5_RIVER_OVERBET_FACING` | 49.24% / 6.83% / CALL | 47.09% / 2.85% / CALL (-2.15pp) | 55.11% / 17.59% / CALL (5.87pp) | — |
| `S6_THREEBET_POT_TURN_FACING` | 45.69% / 5.06% / RAISE | 45.75% / 4.81% / RAISE (0.07pp) | 46.64% / 5.68% / RAISE (0.95pp) | — |
| `S7_LIMPED_POT_RIVER_BLUFFCATCH` | 7.87% / 1.83% / FOLD | 7.86% / 1.34% / FOLD (-0.01pp) | 9.45% / 3.04% / FOLD (1.58pp) | — |
| `S8_SEVEN_HANDED_UNSUPPORTED` | **UNSUPPORTED** | UNSUPPORTED | UNSUPPORTED | — |

## G. 决策影响指标（来自 `v21-decision-impact.json`）

- 退化自检：`{"equitySpreadAcrossProfiles":0.13617316032255972,"bluffMassSpreadAcrossProfiles":0.12121743500759476}`
- 确定性自检：**11/11** 逐位相同（同输入两次调用）
- Profile Dominance 违规行：**0/11**
- `requiredEquity` 不随画像变化：**成立**

| 画像 | 动作 | 权益 | eqΔ | 诈唬Δ | EqVsCallΔ | 跟注EVΔ | TV |
|---|---|---|---|---|---|---|---|
| `REF_NEUTRAL_NORMAL` | CALL | 56.26% | 0.00pp | 0.00pp | 26.47pp | 0.000 | 0.0000 |
| `NO_PROFILE_UNKNOWN` | CALL | 56.26% | 0.00pp | 0.00pp | 26.47pp | 0.000 | 0.0000 |
| `TAG_CALLING_STATION` | CALL | 55.77% | -0.48pp | -1.09pp | 25.99pp | -0.228 | 0.0109 |
| `TAG_UNDERBLUFFER` | CALL | 55.75% | -0.50pp | -1.13pp | 25.97pp | -0.237 | 0.0113 |
| `TAG_MANIAC` | CALL | 57.66% | 1.41pp | 3.15pp | 27.88pp | 0.661 | 0.0315 |
| `OBS_MANIAC_50_45` | CALL | 58.21% | 1.95pp | 4.38pp | 28.43pp | 0.918 | 0.0438 |
| `OBS_STATION_50_5` | CALL | 55.76% | -0.50pp | -1.12pp | 25.97pp | -0.235 | 0.0112 |
| `OBS_ZERO_OPPORTUNITIES` | CALL | 57.66% | 1.41pp | 3.15pp | 27.88pp | 0.661 | 0.0315 |
| `TAG_THEN_HIGH_DEVIATION` | CALL | 56.45% | 0.19pp | 0.43pp | 26.66pp | 0.091 | 0.0075 |
| `TAG_THEN_LOW_DEVIATION_AGGRESSIVE` | CALL | 57.24% | 0.98pp | 2.19pp | 27.45pp | 0.459 | 0.0222 |
| `EXTREME_ALL_VERY_HIGH` | CALL | 44.60% | -11.66pp | 10.99pp | 14.81pp | -5.482 | 0.2852 |

### G.1 输入微扰稳定性

- 边界声明：合理输入边界：下注额 ±5%、asOf ±1 天、权益种子取值。**不含**改牌/改底池/改位置/改筹码（那些是不同的牌局）。
- 发生动作翻转的画像数：**0/11**
- 最大权益极差：**0.0000pp**

### G.2 冲突场景原始数字

```json
{
 "C1": {
  "id": "C1_HISTORY_PASSIVE_CURRENT_STRONG",
  "description": "历史标签「跟注站」（被动、诈唬低）↔ 当前河牌**超池**下注（更强范围证据）",
  "rows": [
   {
    "betShareOfPot": 0.25,
    "betBB": 4.88,
    "neutral": {
     "equity": 0.5625883726719891,
     "bluffMass": 0.018421440058874042,
     "action": "CALL",
     "fold": null
    },
    "callingStation": {
     "equity": 0.5591421237023602,
     "bluffMass": 0.010687845683545666,
     "action": "CALL",
     "fold": null
    },
    "maniac": {
     "equity": 0.5702355642929245,
     "bluffMass": 0.035582207788627744,
     "action": "CALL",
     "fold": null
    }
   },
   {
    "betShareOfPot": 0.5,
    "betBB": 9.75,
    "neutral": {
     "equity": 0.5625883726719892,
     "bluffMass": 0.018421440058874052,
     "action": "CALL",
     "fold": null
    },
    "callingStation": {
     "equity": 0.5577395263456295,
     "bluffMass": 0.007540331059829269,
     "action": "CALL",
     "fold": null
    },
    "maniac": {
     "equity": 0.5766449214663655,
     "bluffMass": 0.04996519898363892,
     "action": "CALL",
     "fold": null
    }
   },
   {
    "betShareOfPot": 0.75,
    "betBB": 14.63,
    "neutral": {
     "equity": 0.5625883726719894,
     "bluffMass": 0.018421440058874052,
     "action": "CALL",
     "fold": null
    },
    "callingStation": {
     "equity": 0.55773952634563,
     "bluffMass": 0.007540331059829269,
     "action": "CALL",
     "fold": null
    },
    "maniac": {
     "equity": 0.5766449214663656,
     "bluffMass": 0.04996519898363895,
     "action": "CALL",
     "fold": null
    }
   },
   {
    "betShareOfPot": 1,
    "betBB": 19.5,
    "neutral": {
     "equity": 0.5625883726719892,
     "bluffMass": 0.018421440058874052,
     "action": "CALL",
     "fold": null
    },
    "callingStation": {
     "equity": 0.5577395263456295,
     "bluffMass": 0.007540331059829269,
     "action": "CALL",
     "fold": null
    },
    "maniac": {
     "equity": 0.5766449214663655,
     "bluffMass": 0.049965198983638937,
     "action": "CALL",
     "fold": null
    }
   },
   {
    "betShareOfPot": 1.5,
    "betBB": 29.25,
    "neutral": {
     "equity": 0.5625883726719892,
     "bluffMass": 0.018421440058874052,
     "action": "CALL",
     "fold": null
    },
    "callingStation": {
     "equity": 0.5577395263456295,
     "bluffMass": 0.007540331059829269,
     "action": "CALL",
     "fold": null
    },
    "maniac": {
     "equity": 0.5766449214663655,
     "bluffMass": 0.04996519898363892,
     "action": "CALL",
     "fold": null
    }
   }
  ]
 },
 "C2": {
  "id": "C2_HISTORY_AGGRESSIVE_CURRENT_WEAK",
  "description": "历史标签「疯子」（诈唬高）↔ 当前干燥面 + 三次过牌后 **小注 2.5BB（13% 池）**（削弱诈唬解释）",
  "neutral": {
   "equity": 1,
   "bluffMass": 0.2985183693061232,
   "action": "RAISE",
   "fold": null
  },
  "maniac": {
   "equity": 1,
   "bluffMass": 0.2985183693061232,
   "action": "RAISE",
   "fold": null
  },
  "station": {
   "equity": 1,
   "bluffMass": 0.11265048221091442,
   "action": "RAISE",
   "fold": null
  }
 },
 "C3": {
  "id": "C3_HISTORY_TIGHTWEAK_recentAggressive",
  "description": "历史标签「极紧」（诈唬低）↔ 少量近期行为看似激进（人工读 VERY_HIGH / 2 手中 2 次开火）",
  "tagOnly": {
   "equity": 0.5603971678738563,
   "bluffMass": 0.013504241896068381,
   "action": "CALL",
   "fold": null
  },
  "manualVeryHigh": {
   "equity": 0.5645170707290436,
   "bluffMass": 0.022749556970095623,
   "action": "CALL",
   "fold": null
  },
  "observed2of2": {
   "equity": 0.5615067830026087,
   "bluffMass": 0.01599428640362008,
   "action": "CALL",
   "fold": null,
   "note": "2/2 = observedRate 1.0，但收缩后 effectiveRate = (0.12×6 + 2)/(6+2) = 0.34"
  },
  "observed30of30": {
   "equity": 0.565319061044631,
   "bluffMass": 0.02454927250091193,
   "action": "CALL",
   "fold": null
  }
 }
}
```
