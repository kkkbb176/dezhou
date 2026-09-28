# 验证报告：实测 `PFR` 如何改变「对手翻牌下注范围」的强度（以及它是否违反本项目自己的纪律）

**日期**：本轮实测 ｜ **性质**：只读验证（未改任何生产代码）
**被验证的现象**：对手实测 `PFR` 越低 ⇒ 引擎给 Hero 的 `EqVs下注范围` 越高、`CALL_EV` 越好、动作越偏向加注/跟注而不是弃牌。

```text
A♠Q♥ 面对紧手 5BB（K♠7♥2♣）：
  PFR 未观测 38.04% → PFR 5% 49.15% → 9% 46.64% → 13% 44.17% → 17% 41.78%
  → 22% 38.96% → 28% 35.91% → 35% 32.99%
  单调性：**严格单调递减**（PFR↑ ⇒ 我们的权益↓），跨度 16.2 个百分点
```

---

## 0. 一句话结论

> **方向是设计出来的，但它用错了统计量，而且幅度失控。**
> 引擎让**翻前主动性 `PFR`** 驱动**翻后下注范围**：`pfr ↓` ⇒ 融合维度 `aggression ↓` ⇒ 公共强度带模型的价值锚 `valueAnchor = 0.45 + 0.3×aggression + 0.25×bluffTendency`（`src/app/manualInput/bettingRange.ts:447`）下降
> ⇒ 价值/薄价值/摊牌三档的**下注率整体下调**，而诈唬锚 `bluffAnchor = bluffTendency × valueAnchor`（同文件 `:450`）**按比例下调得更多**
> ⇒ 归一化后**下注范围里空气占比上升**：`pfr=9%` ⇒ 46.54% 空气，`pfr=22%` ⇒ 36.42% 空气。
>
> 判定：**C ——「故意的方向 + 用错了统计量」**（把**翻前**主动性当成**翻后**开枪倾向），
> 并且它撞上了本项目自己在源码里写下的硬约束「PFR 不碰 `bluffTendency`（禁止「翻前凶 ⇒ 河牌爱诈唬」）」
> （`src/domain/player/observedStats.ts:848-849`）——极性表照做了（`pfr.bluffTendency = 0`），
> 但 `aggression` 被另一层当成「开枪倾向」的系数，于是**被禁止的那句话从后门成立**。

---

## 1. 实测证据（可复现）

### 1.1 单变量扫描：只改 PFR，其余全部固定

固定：标签 `VERY_TIGHT` + `vpip=12%`、`threeBet=3%`、`wtsd=24%`、`foldToFlopCBet=72%`、2000 手、位置/牌面/尺寸/Hero 底牌全不变。
源文件：`scripts/tight-villain-pfr-sweep-out.txt`（命令见 §5）。

| PFR | EqVs下注(AQ) | CALL_EV | 价值 | 薄价值 | 摊牌 | 纯空气 | 动作(JJ) |
|---|---|---|---|---|---|---|---|
| 未观测 | 38.04% | 212.137 | 40.17% | 12.72% | 21.06% | 38.77% | RAISE 20.00 |
| 5% | 49.15% | 360.133 | 31.78% | 5.84% | 18.53% | 49.68% | CALL 5.00 |
| **9%** | **46.64%** | **316.162** | 34.46% | 7.49% | 19.00% | 46.54% | **CALL 5.00** |
| 13% | 44.17% | 273.035 | 36.93% | 9.44% | 19.69% | 43.38% | CALL 5.00 |
| 17% | 41.78% | 231.195 | 39.19% | 11.63% | 20.58% | 40.23% | CALL 5.00 |
| **22%** | **38.96%** | **181.742** | 41.68% | 14.57% | 21.90% | 36.42% | **RAISE 20.00** |
| 28% | 35.91% | 128.502 | 44.18% | 18.14% | 23.61% | 32.21% | RAISE 20.00 |
| 35% | 32.99% | 77.342 | 46.59% | 21.99% | 25.28% | 28.13% | RAISE 20.00 |

同一扫描在 J♥J♠、K♥Q♥ 上方向一致（源文件同表）。**J♥J♠ 在 PFR=22% 与 9% 之间发生动作翻转（RAISE↔CALL）**——即这条通道足以翻掉一个决策。

### 1.2 最强对照：把「松被动鱼」与「紧手」放在同一条 PFR 上

| 画像（实测 2000 手） | EqVs下注(AQ) | 动作 | 价值 | 薄价值 | 纯空气 |
|---|---|---|---|---|---|
| 无实测 | 38.04% | RAISE 20.00 | 42.46% | 15.61% | 35.15% |
| 只有 `vpip=0.12` | 38.04% | RAISE 20.00 | 42.46% | 15.61% | 35.15% |
| 只有 `pfr=0.09` | 44.10% | RAISE 20.00 | 37.00% | 9.50% | 43.29% |
| **`vpip=0.60` + `pfr=0.09`（松被动鱼）** | **44.10%** | CALL 5.00 | 37.00% | 9.50% | 43.29% |
| **`vpip=0.12` + `pfr=0.09`（紧手）** | **44.10%** | CALL 5.00 | 37.00% | 9.50% | 43.29% |
| `vpip=0.12` + `pfr=0.35`（紧且极凶） | 29.35% | RAISE 20.00 | 50.96% | 28.16% | 23.40% |
| `vpip=0.60` + `pfr=0.35`（松凶） | 29.35% | CALL 5.00 | 50.96% | 28.16% | 23.40% |

两条硬结论（逐位相同，不是「接近」）：

1. **`VPIP` 完全不参与**：把 VPIP 从 12%（极紧）改成 60%（极松），`EqVs下注`、下注范围构成**逐位不变**。
2. **`PFR` 单独决定下注范围**：只要 PFR 相同，**「12/9 的紧手」与「60/9 的松被动鱼」在引擎眼里是同一个下注者**——两类人的下注范围构成与给我们的价格完全相同。

### 1.3 机制定位（直接调用解析器，绕过决策层）

`resolvePlayerProfile({ baseArchetype:'VERY_TIGHT', observedStats })` 的直接读数：

| 输入 | observedOnly.aggression | blendWeight | resolved.aggression | FLOP `betScale` |
|---|---|---|---|---|
| **全部 10 项，`pfr=0.09`**（§2.1 夹具） | 0.276874 | 0.833333 | **0.305728** | 0.736619 |
| **全部 10 项，`pfr=0.22`**（§2.1 夹具） | 0.429694 | 0.833333 | **0.433078** | 0.813029 |
| 只有 `pfr=0.09`（2000 手，conf 0.9639） | 0.320041 | 0.80 | **0.346033** | **0.762620** |
| 只有 `pfr=0.22`（2000 手） | 0.532720 | 0.80 | **0.516176** | **0.864706** |
| 只有 `pfr=0.09`（仅 30 手，conf 0.2857） | 0.418519 | 0.056604 | 0.448218 | 0.823931 |
| 只有 `vpip=0.12` | 0.500000 | 0.000000 | 0.450000（**不变**） | 0.825000 |

⇒ 通道是：**`pfr` →（极性 +1）`aggression` → 融合层 `base×(1−w) + observed×w` → 由 `bettingRange.ts:447` 消费**。
样本量只影响幅度（30 手时效应几乎消失），**方向在 conf 很小时就已确定**。
注意 `betScale` 列（另一条通道，见 §2.2）在同一次观测里也随之变化，但**它不是本现象的成因**。

---

## 2. 代码链（每一跳都可核对）

| # | 位置 | 做了什么 |
|---|---|---|
| 1 | `src/domain/player/observedStats.ts:851-890` | `STAT_DIMENSION_POLARITY`：`pfr` 的极性 = `aggression +1.0`，`bluffTendency 0` |
| 2 | `observedStats.ts:914-918` | `statDeviationOf`：锚点 PFR=0.20、半宽 0.15 ⇒ `0.09` 归一化偏离 ≈ **−0.733** |
| 3 | `observedStats.ts:1368-1375` | `opportunities = 手数 × 频率` 近似（trace 实测：2000 手 ⇒ 机会数 2000）；`confidence = 2000/(2000+30) = 0.9639` |
| 4 | `observedStats.ts:1416-1422` | 逐轴**加权平均**累加：`res = Σ(p×center×conf) / (priorMass + Σ\|p\|×conf)` ⇒ `observedOnly.aggression = 0.32004` |
| 5 | `observedStats.ts:1540-1570` | 融合层：`w = evidenceMass / (evidenceMass + K_PROFILE_LABEL=500) = 0.8`；`resolved = base×(1−w) + observed×w`。**数值核对**：`0.45×0.2 + 0.32004×0.8 = 0.34603271983640077` = 引擎实际 `resolved.aggression`（逐位相等） |
| 6 | **`app/manualInput/contextBuilder.ts:3881-3883`** | **关键接线**：下注范围层 `betProbabilityByBand`「**只读 `effectiveDimensions`，不读 `confidence`**」，吃的是**未折 0.35 的 V3 融合维度**（注释自带实测依据：若折 0.35 会让 `betMass` 在第一次观测处跳变 −38.1%） |
| 7 | `app/manualInput/bettingRange.ts:390-400` | `betProbabilityByBand` 只读 `dims.aggression` / `bluffTendency` / `passivity` |
| 8 | **`bettingRange.ts:447-450`** | `valueAnchor = 0.45 + 0.3×aggro + 0.25×bluff`；`thinAnchor = 0.25 + 0.3×aggro + 0.3×bluff`；`showAnchor = 0.1 + 0.15×aggro + 0.15×bluff − 0.2×passive`；**`bluffAnchor = bluffTendency × valueAnchor`** |
| 9 | `bettingRange.ts:453-480` | 四档锚 → `softPositive(sizePolarized(...))` 速率；**AIR 带不带任何牌面/结构系数**（`AIR: airRate`），价值阶梯则被 `factors` / `texture` 逐档削减 |
| 10 | `bettingRange.ts:629-700` | `buildBettingRangeFacts` 用这些速率×到达权重 ⇒ `classMasses` / `bandMasses.bet` ⇒ 该范围与 Hero 的权益即 `EqVs下注范围` |

### 2.1 两个 PFR 值的逐项算术（**与引擎自报锚值逐位相等**，可复算）

夹具 = 全部 10 项实测统计（`vpip12 / threeBet3 / wtsd24 / foldCbet72 …`）+ `pfr` 取 9% 与 22%；标签 `VERY_TIGHT`。

| 量 | `pfr=9%` | `pfr=22%` |
|---|---|---|
| `resolved.aggression` | **0.3057279303718774** | **0.43307806789495495** |
| `aggro = (agg−0.5)×2` | −0.38854 | −0.13384 |
| `bluffTendency` / `bluff = c(bluffTendency)` | 0.15 / −0.70 | 0.15 / −0.70 |
| `passivity` / `passive` | 0.45303 / −0.09394 | 0.45303 / −0.09394 |
| **`valueAnchor`** = `0.45 + 0.3×aggro + 0.25×bluff` | **0.1584** | **0.2348** |
| **`thinAnchor`** = `0.25 + 0.3×aggro + 0.3×bluff` | **−0.0766** | **−0.0002** |
| `showAnchor` = `0.1 + 0.15×aggro + 0.15×bluff − 0.2×passive` | −0.0445 | −0.0063 |
| `bluffAnchor` = `0.15 × valueAnchor` | 0.0238 | 0.0352 |
| 引擎自报锚（`bettingRangeFacts.model.noteZh`） | `价值 0.1584、薄价值 −0.0766、摊牌 −0.0445、诈唬 0.0238` | `价值 0.2348、薄价值 −0.0002、摊牌 −0.0063、诈唬 0.0352` |
| 实测 `EqVs下注` | **46.64%** | **38.96%** |
| 实测 `纯空气` / `薄价值` | **46.54% / 7.49%** | **36.42% / 14.57%** |

**上表左右两列逐格复核通过**：我用 `resolvedDimensions` 手算的四个锚与引擎自报的四个锚**逐位相同**
⇒ 「PFR → 融合 aggression → 锚 → 下注范围」这条链被完全确证，没有第三个隐藏输入。

> 🔴 **真正的放大器是 `thinAnchor` 跨过 0 点**：
> `pfr=9%` ⇒ `thinAnchor = −0.0766`，经 `softPositive`（`bettingRange.ts:453-459`）后**薄价值速率≈0**
> ⇒ 顶对/中对/底对这些「薄价值 + 摊牌」档**几乎被踢出下注范围**，而 AIR 带（`AIR: airRate`，不带任何结构系数）
> 在归一化中吃下全部腾出的质量 ⇒ 他的下注范围里空气占比 **35.15% → 46.54%**、薄价值 **15.61% → 7.49%**。
> `pfr=22%` 时 `thinAnchor = −0.0002`（刚好在 0 附近）⇒ 薄价值保住 14.57%。
>
> 也就是说：**「他翻前加注频率低」这一个数，决定了我们眼里他的顶对到底算不算下注范围的一部分。**

### 2.2 另一条通道（`betScale`）不是本现象的成因

`observedStats.ts:1634` 的 `betScale = 1 + 0.3×aggro + 0.25×bluff − 0.3×passive`（`observedStats.ts:1164-1175`）确实随 PFR 变化
（0.09 ⇒ **0.7626**，0.22 ⇒ **0.8647**），并被 `betResponse.ts:1345` 的硬阈值 `bluffBet = weakTail && betScale > 1` 消费。
但**两个值都 < 1**，因此在两条口径下弱尾牌都被禁止开枪 —— 它无法解释实测的单调变化。
`bettingRangeFacts`（本报告全部数字的来源）由 `bettingRange.ts` 的公共强度带模型产出，**不读 `betScale`**
（`contextBuilder.ts:3881` 明文：该层只读 `effectiveDimensions`）。

⇒ **本现象 100% 由 §2 第 8-9 步的锚系数 + 非线性压缩决定**，与响应层的 `betScale` 无关。
附带结论（也值得修）：同一个人身上并存两套「他爱不爱开枪」的口径（锚系数 vs `betScale` 阈值），二者可以给出**相反的定性判断**。

---

## 3. 这是不是「故意的」？——三条互相独立的反证

### 3.1 源码自己禁止这件事

`src/domain/player/observedStats.ts:848-849`（原文）：

```text
VPIP 不碰 `bluffTendency`（禁止「松 ⇒ 爱诈唬」），
PFR 不碰 `bluffTendency`（禁止「翻前凶 ⇒ 河牌爱诈唬」）。
```

**极性表（第 851-890 行）确实照做了**（`pfr.bluffTendency = 0`）。但 §2 第 8-9 步把同一个 `aggression` 维度
拿去当「开枪份额」的系数，于是被禁止的推论（翻前主动性 ⇒ 翻后诈唬）**从后门成立**：
实测 `纯空气占比` 从 5% PFR 的 49.68% 变到 35% PFR 的 28.13%——**这正是被禁止的那句话**。

### 3.2 代码注释里已经写死过「方向不对」的教训

`betResponse.ts:299-301` 原文：

```text
⚠️ 保留 `streetFoldScale` 形参**只为向后兼容签名**，不再参与计算：
第一版用它做映射，符号是错的（高 `foldScale` = 他更爱弃 ≠ 他更爱开枪）；
```

⇒ 本项目**已经知道**「把翻前/响应的量当成开火倾向」会犯方向错，并为此改过一次；
本轮验证发现：`pfr` 仍从 `aggression` 这条侧门回到了同一个位置。

### 3.3 内部信息丢失（最可执行的一条）

§1.2 的对照说明：引擎把**松被动鱼（60/9）**与**紧手（12/9）**算成同一个下注者。
按项目自己的 `docs/player_types.md`（GTOopen 实测库，2009 年 25–50NL、300+ 手样本）这张表：

| 类型 | VPIP | PFR | c-bet F | folds to flop bet |
|---|---|---|---|---|
| Nit | 10.5 | 7.1 | **72%** | 72% |
| Tight-passive | 18.8 | 7.2 | 67% | 64% |
| Loose-passive fish | 33.4 | 10.1 | 66% | 56% |
| LAG | 29.9 | 21.6 | 67% | 56% |

两点据此：

- **同 PFR、不同 VPIP 的类型，c-bet 频率几乎一样**（Nit 72% vs Tight-passive 67%）——用 PFR 区分他们的翻后开枪倾向，**在这个数据集里没有依据**；真正的区分量是 `fold-to-flop-bet`（72% vs 64%），而本项目那份数据里 `foldToFlopCBet` **对引擎零影响**（已实测，见主报告 §1.1）。
- **Nit 恰恰是 c-bet 最频繁的类型（72%）**：所以「他很紧 ⇒ 他下注=有牌」在实测数据里也不成立；
  但引擎给出的解释不是「他开火多」，而是「他下注里 46.54% 是空气」——
  **同一个结论用了一个没有数据支撑的中间量**，这才是风险所在。

---

## 4. 判定与影响面

| 问题 | 判定 |
|---|---|
| 是不是符号写反的算术 Bug？ | **不是**。`pfr ↓ ⇒ 更被动 ⇒ 开枪少` 在「PFR 是主动性度量」的前提下方向自洽 |
| 是不是故意的模型设计？ | **方向是故意的**（`betScaleOfUnifiedDimensions` 的系数 0.3 / 0.25 / −0.3 与注释都表明是有意设计） |
| 那问题在哪？ | **① 越权**：被源码明文禁止的推论（翻前主动性 ⇒ 翻后诈唬）经 `aggression → betScale` 后门成立；**② 用错统计量**：`PFR` 是翻前量、且**不区分**同 PFR 的松/紧两类人（§1.2 逐位相同）；**③ 幅度**：单条统计可移动我方权益 16.2pp、翻掉 JJ 的动作 |

**对「针对很紧的玩家」这条主线的直接后果**：面对 12/9 的紧手，引擎把我们的边际牌（JJ、AQ）价格调**好**、
动作从 RAISE 降成 CALL——与我们真正想做的事（对紧手少打边缘牌、别给他付钱）方向相反。
主报告 `TIGHT_VILLAIN_ENGINE_ANSWER.md` 的 §1.1/§6 已按本轮结果更新。

---

## 5. 复现命令

```powershell
node --experimental-strip-types scripts/tight-villain-pfr-sweep.ts          # → scripts/tight-villain-pfr-sweep-out.txt
node --experimental-strip-types scripts/tight-villain-stat-attribution.ts   # → scripts/tight-villain-stat-attribution-out.txt（逐项归因）
node --experimental-strip-types scripts/tight-villain-engine-answer.ts      # → scripts/tight-villain-out.txt（主报告全部数字）
```

- 本报告 §1.1 数字 = `tight-villain-pfr-sweep-out.txt`；§1.2 与 §1.3 = 本轮附加对照（脚本内联，可与 §1.1 用同一夹具重跑）。
- 所有夹具都用 `persistentPlayerId` + `seatId` 显式绑定身份，避免身份告警干扰。

---

## 6. 若要修，最小改动点（本轮未改任何代码）

1. **首选：把「开火倾向」的音源从 `pfr` 上摘掉**——`observedStats.ts:1634` 的 `betScaleOfUnifiedDimensions({...resolvedDimensions})`
   把 `aggression` 权重从 0.3 降到 0 或改为只吃 `bluffTendency`／`passivity`。这会破坏锁定「画像必须改变尺寸/EV」的测试
   （`test/profileEffectiveness.test.ts` 的 P4-5 / P4-6），需同步更新契约而不是放宽断言。
2. **补一条自检**：`bluffTendency` 未变时，`pfr` 的变化**不得**改变下注范围的 `pureAirMass`（把被禁止的推论变成可执行断言）。
3. **给 VPIP 一条真正的通道**：当前 `VPIP` 在翻后下注范围上是零影响，而同 PFR 的松/紧两类人在实测数据里
   `folds to flop bet` 差 8pp（72% vs 64%）——用**有数据的那条统计**（`foldToFlopCBet`）替代 PFR 的越权作用，
   才是「用有数据的量」的做法。
4. **幅度上限**：无论哪条通道，单条实测统计不应能移动我方权益 16pp；现有 `PROFILE_CONFIDENCE_CAP` 只约束了标签，未约束 V3 分街系数。
