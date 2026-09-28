# 修复报告：弃牌频率的**实测锚定**（FOLD-ANCHOR FIX）

**轮次**：FOLD-ANCHOR FIX ｜ **验收**：`npm run verify` ⇒ 见 §5
**起因**：`reports/HUNDRED_HANDS_THREE_STREETS_AUDIT.md` §2 的缺陷（100 手实战验证发现）
**用户授权**：批准修法 A，K = 0.15

---

## 0. 一句话

> 模型自算的「他弃多少」原先可以**大幅偏离实测**，而且在**多人路径上完全不接分街统计**
> （`responseTendenciesOf(o.dimensions, o.confidence)` 没传 street 输入）。
> 修复后：**只有样本足够**时，模型弃牌频率被夹在「该街实测值 ± 15pp」内；
> 无实测 / 样本不足 / 语义门挡下 ⇒ **逐位不变**。
> 效果：一个只弃 25% 的对手面前，满池诈唬的 ΔEV 从 **+920 变成 −183.9**（不再推荐诈唬）。

---

## 1. 缺陷的两层（比第一版报告更深一层）

| 层 | 现象 | 证据 |
|---|---|---|
| ① **口径** | **多人路径**（`buildBetDecisionFacts` 的 per-opponent 循环）调用 `responseTendenciesOf(o.dimensions, o.confidence)`——**没有第 3 个实参** ⇒ 该家拿不到 `streetFoldScale`、`betAggression`、实测锚点。单挑路径（`:1998`）一直是传的 | 修复前：`foldToRiverBet` 65% 与 85% 给出**逐位相同**的数值 |
| ② **幅度** | 即使口径通了，模型自算值仍可远超实测（实测 65% vs 模型 78%），且**没有价格一致性约束**（满池给 2:1，他需 33.3% 权益） | 见 `HUNDRED_HANDS_THREE_STREETS_AUDIT.md` §2 |

---

## 2. 修法（3 处生产改动 + 1 条门槛）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/app/manualInput/contextBuilder.ts` | ① `buildBetDecisionFacts` 的 `opponents[]` 新增可选 `v3Street`（逐家当前街分街因子）；② per-opponent 的 `responseTendenciesOf(...)` 补传 `o.v3Street` 与 `betAggression`；③ 调用点只对**画像描述的那一家**（`isVillain`）注入 ⇒ 逐座位手选画像与无画像两家**逐位不变** |
| 2 | `src/domain/player/observedStats.ts` | 新增 `measuredStreetTrait`（分开记录「真有实测」的值与**可信度**——`streetTraitValue` 在未观测/被挡下时都是 0.5，拿它当锚点会把中立当证据）；`StreetFactors.foldTraitValue` 只在**语义门放行且样本足够**时给出 |
| 3 | `src/domain/postflop/betResponse.ts` | 新增常量 `FOLD_ANCHOR_TOLERANCE = 0.15`；`ResponseTendencies.streetFoldTraitValue`；`buildResponseModel` 在聚合处把 fold 质量夹到 `[measured−0.15, measured+0.15]`，差额**按原比例补给 call/raise**（保持 `fold+call+raise=1`、组合集不变、桶内权重重新归一） |

### 2.1 样本充分性门槛（**这一条是自测抓出来的**）

第一版没有门槛 ⇒ `playerProfileExploitV1` 的「**样本不足必须被强收缩**」当场失败：
2 手实测通过锚点**直接改写**弃牌频率，等于绕过整个收缩机制。

修法：`confidence > 0.5` 才启用锚定 —— 即「至少要到 K 手，实测才开始与先验等权」，
与 `statEvidenceOfRate` 同一口径（PFR/VPIP 类 K=30）。未达标 ⇒ `undefined` ⇒ 不锚定。

---

## 3. 修复前后对照（河牌纯空气 A♠5♠，满池 17.5BB）

| 情形 | 修复前 最大档 P(弃) | **修复后** | 修复前 ΔEV | **修复后 ΔEV** |
|---|---|---|---|---|
| 无该统计（对照） | 76.6% | 76.6%（**逐位不变**） | +920.0 | +920.0 |
| 实测 25%（8000 手） | 76.6% | **45.1%（夹到 40%）** | +920.0 | **−183.9** |
| 实测 65%（2000 手） | 76.6% | **78.2%**（带内，不夹） | +920.0 | +973.6 |
| 实测 85%（8000 手） | 76.6% | **83.5%** | +920.0 | +1161.5 |

完整的「样本量 × 实测值」矩阵（`scripts/fold-anchor-verify-out.txt`）：

```text
hands=2     25%→P(弃)=82.6% ΔEV=+1129.9 ｜ 65%→82.6% ｜ 85%→82.6%    ← 样本不足 ⇒ 完全不锚定（三者逐位相同）
hands=30    25%→81.1% ｜ 65%→81.2% ｜ 85%→81.3%                        ← 刚到门槛，几乎不动
hands=200   25%→77.6% ｜ 65%→78.3% ｜ 85%→78.6%
hands=2000  25%→74.1% ｜ 65%→78.2% ｜ 85%→80.1%
hands=8000  25%→45.1%（ΔEV −183.9）｜ 65%→77.1% ｜ 85%→83.5%
无该统计     76.6%（ΔEV +920.0）
```

**判读**：
- **样本不足时逐位相同**（`hands=2` 三列完全一致）⇒ 收缩机制未被绕过；
- **样本越大、锚点越硬**（8000 手时 25% ⇒ 夹到 40%，ΔEV 从 +920 变 −183.9）⇒ 与「实测说了算」的既有纪律一致；
- **锚点只在方向确实偏离时才生效**（65% 那列落在带内 ⇒ 不夹，保持模型自己的价格弹性）。

---

## 4. 契约影响

`npm run manifest` 已重算（197 个产物）。
本轮**未新增/修改任何测试断言**：全量 2,313 项**全部通过**，说明
①「无实测路径逐位不变」②「样本不足强收缩」③ 既有画像方向断言**都没有被破坏**。

---

## 5. 验收

```text
npm run verify ⇒ exit 0
类型检查：0 错误
产物清单：197 个文件全部一致
测试：2,313 项 / 2,313 通过 / 0 失败
日志：reports/_verify_after_fold_anchor.log
```

---

## 6. 复现

```powershell
node --experimental-strip-types scripts/fold-anchor-verify.ts    # 样本量 × 实测值矩阵
node --experimental-strip-types scripts/hundred-hands-three-streets.ts
npm run verify
```

---

## 7. 遗留（如实）

1. **锚点披露未进诊断快照**：夹逼结果目前只在逐尺寸的 `noteZh` 文案里，没有独立的
   `model.foldAnchor` 字段（我尝试加过，但该字段所在的快照链与逐尺寸事实包不是同一个对象，
   为避免改坏结构未强行接）。**影响**：外部只能从「数值是否落在实测 ±15pp 内」反推是否夹过。
2. **门槛取 `confidence > 0.5` 是工程选择**（与 K 同性质），不是拟合出来的最优值。
3. **分街统计的语义门仍然是保守的**：`GENERIC_BET`（三街过牌后的第一枪）上该统计依旧不生效
   —— 那是既有政策，本轮未动。
