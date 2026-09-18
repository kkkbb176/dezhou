# 画像 → Range → 权益 / EV 主链修复报告（P0 架构缺陷）

> **审计日期**：2026-09-17 · **审计方式**：逐行代码核对 + 真实牌局复算 + 变异测试 + 全量回归
> **结论**：缺陷**已定位到具体断点并修复**；画像现在通过**动作似然**进入
> `posterior ∝ prior × likelihood × profile × observation`，因此权益、底池赔率比较、
> Call EV 与动作排名**全部随画像变化**；末端抓诈唬偏移已**去重**（不重复计票）。
> **回归**：**1,691 项 / 137 套件 / 0 失败**（`npm run verify` 全绿；画像链路测试文件新增 14 项）。
>
> 证据等级标注：**【数学确定】**（可复算）· **【公开扑克理论】** · **【工程约束】** · **【启发式】**（只有方向/序关系有意义）

---

## 1. 使用者报告的现象（复现）

同一局面（BTN A♥Q♣｜河牌 Q♠8♦3♣6♠K♠｜CO 下注 82% 池｜需 31.0% 权益），
只改对手画像，**修复前**六个情形给出**逐位相同**的结论：

| 画像 | 权益 | 跟注 EV | 动作 | CALL 偏好分 | 抓诈唬 δ |
|---|---|---|---|---|---|
| VERY_TIGHT | 17.5% | −17.43 | FOLD | 0.364 | −0.0140 |
| UNDERBLUFFER | 17.5% | −17.43 | FOLD | 0.368 | −0.0105 |
| NORMAL | 17.5% | −17.43 | FOLD | 0.379 | 0.0000 |
| BLUFF_HEAVY | 17.5% | −17.43 | FOLD | 0.414 | +0.0350 |
| BLUFF_HEAVY+AGGRESSION_UP | 17.5% | −17.43 | FOLD | 0.414 | +0.0350（**与上一行逐位相同**） |
| MANIAC+AGGRESSION_UP | 17.5% | −17.43 | FOLD | 0.415 | +0.0350 |

**只有末端偏好分在动，权益 / EV / 动作一字不动** —— 与使用者的判断完全一致。

---

## 2. 根因：三处断点（全部是**接线**问题，不是参数问题）

### 2.1 断点 ①：`updateRange` 的画像通道从未被传入（死代码）

规范第二十节要求的唯一合法入口是 `RangeAdjustmentProvider`。项目**早就实现了**它
（`src/domain/range/profileProvider.ts`，含 `adjustActionLikelihood` 的诈唬/价值倾斜），
`updateRange` 也有完整的对数域乘法与逐条日志（`rangeUpdate.ts` §3b/§3c）。

**但生产路径从未传入**：

```ts
// 修复前（contextBuilder.applyLikelihoodUpdates）
const result = updateRange(current, model, ctx, { withDiff: false });   // ← 没有 adjustmentProvider
```

于是那份实现是**死代码**：画像永远到不了范围，只能在决策末端当偏好修正。
这是**结构上**的不可能 —— 不是「幅度太小」。

### 2.2 断点 ②：手选画像**没有维度**（0.35 的「可信度」被当成了「实测可信度」）

`buildPlayerSnapshot` 在「无实测数据 + 有手选画像」时把 `confidence` 抬到
`QUICK_PROFILE_CONFIDENCE = 0.35`，**但维度仍来自零手画像**（全部落在 0.5 中立点）。
即便修好断点 ①，所有乘性因子仍是 `exp(0.4 × 0.35 × 0) = 1` ⇒ 范围逐位不变。

更隐蔽的一条：如果把那个 0.35 当作「实测可信度」交给维度解析，
会得出「实测可信度 0.35 ≥ 手选画像上限 0.35 ⇒ 只用实测维度」——
而那份「实测维度」其实来自零手画像。**画像会再次静默失效，且日志显示一切正常。**

### 2.3 断点 ③：`AGGRESSION_UP` 逐位无效

`DynamicHint` 只进 `dynamic` 快照与展示文案，**没有任何一条路径把它写进范围或似然** ——
实测 `BLUFF_HEAVY` 与 `BLUFF_HEAVY+AGGRESSION_UP` 在修复前**逐位相同**。

---

## 3. 修复后的数据流（严格按使用者给定顺序）

```text
① 到达范围（先验：位置 / 翻前动作 / 求解器覆盖）
      ↓
② 街道 / 动作 / 尺寸条件化（既有 likelihoodWeights；本次未改）
      ↓
③ 画像似然调整（PROFILE_MULTIPLIER；新增接线）
      ↓
④ 近期倾向调整（OBSERVATION_MULTIPLIER；修复前完全不存在）
      ↓
⑤ 归一化（既有对数域 Log-Sum-Exp；max-shift 稳定，未见下溢）
      ↓
⑥ Hero equity（既有权益引擎；**自动跟着范围变**）
      ↓
⑦ 底池赔率 → Call EV → 动作排名（既有 decisionEngine；**未加任何画像逻辑**）
```

| 环节 | 落点 | 说明 |
|---|---|---|
| 画像 → 维度 | `src/domain/player/archetypeDimensions.ts`（新） | 11 种手选画像 → 连续维度；`NORMAL` **恰好**全 0.5（因此因子恒 1） |
| 维度 → 似然 | `src/domain/player/tendencyProvider.ts`（新） | `RangeAdjustmentProvider` 实现；对数域乘性、有界、可审计 |
| 接线 | `src/app/manualInput/contextBuilder.ts` | `applyLikelihoodUpdates` 传入 provider；画像快照**前移到建范围之前** |
| 证据 | `decision.types.ts` / `viewmodels/decisionViewModel.ts` | `profileRangeEvidence` → 诊断 + 调试面板 |
| 去重 | `src/app/decision/postflopAdvisor.ts` | 画像进入范围后 `bluffCatchDelta` 记 0 并标注 |

### 3.1 证据优先级（不做两次乘性调整）

```text
实测可信度 ≥ 手选画像上限(0.35)  ⇒ 只用实测（原型退出）
0 < 实测可信度 < 0.35            ⇒ 按可信度**加权平均**（权重和为 1）
实测 = 0 且 有手选画像            ⇒ 只用原型（标记 USER_ARCHETYPE，可信度上限 0.35）
两者都没有                        ⇒ PRIOR 中立（**连 provider 都不构造**）
```

「加权平均」而不是「两次相乘」是**防重复计票**：【工程约束】实测维度与原型维度是
**同一个量**（这个人的松/凶/诈唬倾向）的两个估计，对同一个量施加两次乘性调整
会让幅度远超证据支持。

### 3.2 街道级倾向字段（使用者 §6）的落地对照

| 使用者要求 | 本次实现 | 说明 |
|---|---|---|
| `bluffFrequency` | `bluffTendency` 维度 | 现有连续维度，不新造频率数字（本项目没有分级真实数据） |
| `aggression` | `aggression` 维度 | 同上 |
| `largeBet bluff` / `smallBet bluff` | **尺寸通道** `sizeBoost` | 【启发式】`sizeBoost = 1 + 0.25 × sizeWeight × max(0,weakness) × bluff`，`sizeWeight = clamp01((bet/pot − 0.5)/0.5)` |
| `valueThinness` | **未实现**（诚实报告） | 没有可信数据定义「薄价值倾向」的刻度；现有 `thinValueDelta` 仍在剥削层按画像方向作用 |

尺寸通道的三条性质（`test/profileRangeAdjustment.test.ts` T14 锁定）：
**有界**（`[0.75, 1.25]`）、**对诈唬倾向单调**（A/B/C 单调性不受影响）、
**只作用于弱牌端**（强牌端在两个尺寸下**逐位相同**）。

---

## 4. 修复过程中的两个**实测缺陷**（不是设计选择，是量出来的）

### 4.1 弱牌判据用错锚点 ⇒ A/B/C **非单调**

第一版沿用既有 `profileProvider` 的判据 `weaknessOf(comboPotential(combo))`
（**翻前牌力潜力**）。在这张牌面上，翻前潜力低的牌（33 / 88 / 6x）恰恰是
**成了三条 / 两对**的那些牌 —— 它们**比 Hero 强**。压低它们等于**抬高** Hero 权益。
实测：

```text
VERY_TIGHT（应当收紧他的进攻 ⇒ 我的权益下降）⇒ 权益 17.508%（NORMAL 17.495%）
BLUFF_HEAVY（应当让他的进攻含更多空气）      ⇒ 权益 17.511%
⇒ 两个相反方向**同时**抬高权益 —— 非单调
```

修正：翻后一律用**牌面相对强度档**（既有 `boardRelativeTierOf`，与似然模型同一判据）；
翻前仍用翻前潜力（那时「弱牌」本来就该按起手牌判）。修复后 A(16.99/16.82) < B(17.50) < C(18.12/18.07)。

### 4.2 「进攻性」被同时记在两端 ⇒ 「更疯」反而空气占比更低

原式 `valueTilt = aggro × 强牌 × 0.7` 与 `bluffTilt = bluff × 弱牌` 同时生效，
于是「又凶又爱诈唬」的对手两端一起被抬高，谁抬得多决定权益方向。实测：
`BLUFF_HEAVY` 的空气 ×1.103 / 价值 ×1.056 ⇒ 价值端（那些**比我强**的牌）盖过空气端
⇒ 权益低于 NORMAL；`MANIAC` 的比值甚至**低于** `BLUFF_HEAVY`。

修正：**只有「未被诈唬解释的那部分进攻性」才抬高价值端**
（`valueTilt = aggro × (1 − bluffShare) × …`，`bluffShare = max(0, bluff 偏移)`）。
不引入新参数，只是**去掉重复计票**。

### 4.3 先验形状层只作用于**一个组合**（自己引入又量出来的缺陷）

`updateRange` 是**逐组合**回调 provider 的，因此「一个布尔量表示本轮已施加」
会让先验形状层只作用于**第一个组合**（实测日志：`1 个组合被改变`，
正确值应为该轮全部可达组合）。修正：用 `街道|动作|序号` 三元组识别**第几次更新调用**，
第 1 次调用内**全部**组合都施加，之后的调用退出（防跨街重复计票）。T10 锁定。

### 4.4 尺寸通道被 ±1 护栏吸收（T14 的由来）

把尺寸调制乘在 `bluffTilt` 上时，弱牌端倾斜和已撞到 ±1 工程护栏，
再乘 > 1 的系数**被完全吸收** —— 「大注诈唬」在最弱的那一档恰好失效。
改为**独立的有界通道**（相加而非相乘，见 §3.2），实测生效：

| 河牌下注 | 画像因子（BLUFF_HEAVY） | 诈唬质量 NORMAL → BLUFF_HEAVY | 权益 NORMAL → BLUFF_HEAVY |
|---|---|---|---|
| 1.5BB（16% 池） | ×1.000–1.150 | 5.14% → 6.01% | 19.20% → 20.70% |
| 6BB（63% 池） | ×1.000–1.150 | 5.14% → 6.01% | 19.20% → 20.70% |
| 12BB（126% 池） | ×1.000–**1.174** | 5.14% → 6.12% | 19.20% → 20.88% |
| 18BB（189% 池） | ×1.000–**1.212** | 5.14% → 6.29% | 19.20% → **21.19%** |

---

## 5. 验收表（**真实节点**：测试局 3 河牌，CO 下注 82% 池）

| 画像 | 诈唬质量% | Hero 权益 | 所需权益 | Call EV | 决策边际 | 模型置信度 | 最终动作 | 组合数 |
|---|---|---|---|---|---|---|---|---|
| 无画像（UNKNOWN） | 1.32% | **17.495%** | 31.01% | −17.431 | CLEAR_FOLD | HIGH | FOLD | 407 → 407 |
| NORMAL | 1.32% | **17.495%** | 31.01% | −17.431 | CLEAR_FOLD | HIGH | FOLD | 407 → 407 |
| VERY_TIGHT | 1.02% | 16.986% | 31.01% | −18.088 | CLEAR_FOLD | HIGH | FOLD | 407 → 407 |
| TIGHT | 1.12% | 17.055% | 31.01% | −17.999 | CLEAR_FOLD | HIGH | FOLD | 407 → 407 |
| UNDERBLUFFER | 0.99% | **16.822%** | 31.01% | −18.300 | CLEAR_FOLD | HIGH | FOLD | 407 → 407 |
| CALLING_STATION | 1.22% | 17.703% | 31.01% | −17.163 | CLEAR_FOLD | HIGH | FOLD | 407 → 407 |
| AGGRESSIVE | 1.34% | 16.905% | 31.01% | −18.192 | CLEAR_FOLD | HIGH | FOLD | 407 → 407 |
| BLUFF_HEAVY | 1.69% | **18.123%** | 31.01% | −16.621 | CLEAR_FOLD | HIGH | FOLD | 407 → 407 |
| MANIAC | 1.58% | **18.073%** | 31.01% | −16.686 | CLEAR_FOLD | HIGH | FOLD | 407 → 407 |
| BLUFF_HEAVY + AGGRESSION_UP | 1.83% | 18.425% | 31.01% | −16.232 | CLEAR_FOLD | HIGH | FOLD | 407 → 407 |
| MANIAC + AGGRESSION_UP | 1.71% | 18.374% | 31.01% | −16.297 | CLEAR_FOLD | HIGH | FOLD | 407 → 407 |
| MANIAC + TIGHTER_RECENTLY | 1.51% | 17.898% | 31.01% | −16.911 | CLEAR_FOLD | HIGH | FOLD | 407 → 407 |

**单调性（A < B < C，两个量都单调）** 【数学确定】（在同一份代码上复算）：

```text
权益：max(A) = 16.986%  <  B = 17.495%  <  min(C) = 18.073%
EV  ：max(A) = −17.999  <  B = −17.431  <  min(C) = −16.621
诈唬质量：max(A) = 1.12% <  B = 1.32%   <  min(C) = 1.58%
```

- `UNKNOWN` 与 `NORMAL` **逐位相同**（17.495% / −17.431）—— 中性原型不产生任何调整。
- 近期倾向**真的有方向**：`AGGRESSION_UP` 把权益从 18.123% 推到 18.425%；
  反向的 `TIGHTER_RECENTLY` 压回 17.898%。
- 组合数 **407 → 407 全程不变**：画像只改概率，不增删组合。

### 5.1 门槛邻近节点上的**动作翻转**（真实节点，非构造）

同一手 BB A♥9♥｜河牌 K♣9♠5♦2♥7♣｜BTN 偷盲线 → 河牌下注 3BB（需 19.35%）：

| 画像 | 权益 | 所需 | Call EV | 边际 | 动作 |
|---|---|---|---|---|---|
| VERY_TIGHT | 17.42% | 19.35% | < 0 | MARGINAL | FOLD |
| NORMAL | **19.20%** | 19.35% | < 0 | MARGINAL | **FOLD** |
| BLUFF_HEAVY | **20.70%** | 19.35% | > 0 | MARGINAL | **CALL** |
| MANIAC | **20.66%** | 19.35% | > 0 | MARGINAL | **CALL** |

即：**画像合法地把权益推过底池赔率门槛 ⇒ Call EV 转正 ⇒ 动作自然变 CALL**。
动作不是被覆盖出来的（决策层没有加任何画像分支，仍是 `CHIP_EV` 排名）。

---

## 6. 反向测试（使用者 §9）

| 反向测试 | 结果 |
|---|---|
| 关闭画像（`UNKNOWN` / 无 `villain` 字段）⇒ 与基线逐位一致 | ✅ 17.495% / −17.431 逐位相同；**不产生**画像证据对象 |
| `UNDERBLUFFER` 不得增加诈唬质量 | ✅ 0.99% < NORMAL 1.32%，权益 16.822% < 17.495% |
| `BLUFF_HEAVY` 不得增加价值组合（只重新加权） | ✅ 可达组合数前后一致；只改概率 |
| 所有组合都经过死牌过滤 | ✅ 既有 `updateRange` 顺序未改（死牌 → 似然 → 归一化） |
| 权重有限 / 非负 / 归一化 | ✅ Σp = 1（< 1e-9），区间/熵有限，乘数为正有限 |
| 不重复计票 | ✅ 画像进范围后 `bluffCatchDelta = 0` 且 `deDuplicated = true`，理由里写明 |
| 工程护栏 | ✅ `CLAMP_APPLIED` / `clampCount` 可见；因子落在 `[0.2, 5]` |
| 手选画像不得伪装成实测 | ✅ `sampleSize = 0`、`tier = PRELIMINARY`、`USER_ARCHETYPE` |

---

## 7. 调试证据（使用者 §7 逐项对照）

| 要求的证据 | 落点 | 本次实现情况 |
|---|---|---|
| 到达组合数 / 质量 | `profileRangeEvidence.combosBefore` | ✅ 组合数如实给出；**「到达质量」在贝叶斯归一化后恒为 1**，因此不伪造一个数字（诚实报告） |
| 大注范围质量 | `actionMasses.totalMass` + 逐档直方图 + 尺寸通道乘数 | ✅ 质量口径可达组合；尺寸通道乘数单独可见 |
| 价值 / 薄价值 / 诈唬质量 | `actionMasses.{clearValueMass, thinValueMass, bluffCandidateMass}` | ✅ **新增质量口径**（计数口径在画像前后逐位相同，看不见画像） |
| 诈唬占比 | `actionMasses.bluffMassShare` | ✅ 验收表第 2 列 |
| 乘数摘要 | `PROFILE_MULTIPLIER` / `OBSERVATION_MULTIPLIER` / `FINAL_MULTIPLIER` / `CLAMP_APPLIED` | ✅ 调试面板逐行显示 |
| 画像调整前后权益 | `equityBefore` / `equityAfter` / `equityDeltaPct` | ✅ **同一手牌、同一牌面、同一种子**各算一次 |
| 所需权益 / Call EV | 既有 `math.requiredEquity` / `math.callEV` | ✅ 同一口径 |
| 决策边际 | `diagnostics.decisionMargin`（新） | ✅ `CLEAR_FOLD` / `MARGINAL` / `CLEAR_CALL` + 容差带数值 |
| 模型置信度 | `postflop.confidence` | ✅ **与边际分开**显示（两者回答不同问题） |

**关键证据（为什么必须补质量口径）**：同一局面下画像把可达范围的概率重排了，
但**分类计数**始终是 `价值候选 118 / 诈唬候选 143 / 摊牌牌 36 / 证据不足 110`
（逐位相同）；只有**质量**从 1.32% 变到 1.69%。计数口径**看不见画像**。

---

## 8. 变异测试（证明测试真的能抓到回归）

| 变异 | 期望 | 实测 |
|---|---|---|
| M1 移除 `adjustmentProvider` 传参（回到修复前的死代码状态） | T1/T2/T5/T6/T13 变红 | ✅ 6 项失败 |
| M2 恢复「进攻性同时记两端」（去掉 `bluffShare` 扣减） | T1 单调性变红 | ✅ 1 项失败 |
| M3 弱牌判据退回翻前潜力（忽略牌面锚点） | T1/T2/T5/T6/T13 变红 | ✅ 5 项失败 |
| M4 去掉抓诈唬偏移去重 | T4 + TEST 6 变红 | ✅ 2 项失败 |
| M5 先验形状层退回「只作用于一个组合」 | T10 变红 | ✅ 1 项失败 |

---

## 9. 全量历史回归（**没有放宽任何断言**）

```text
npm run verify  →  1,691 项 / 137 套件 / 0 失败（TypeScript 0 错误，产物清单 136 项一致）
```

### 9.1 必须**如实报告**的两处契约变更

1. **`test/postflopRegressionCases.test.ts` TEST 6（契约升级，不是放宽）**
   旧断言：`exploit.bluffCatchDelta` 为正 / 为负 —— 它锁的是**修复前的架构**
   （画像只能通过末端偏好表达「他爱不爱诈唬」）。
   新断言更强：要求 `profileRangeEvidence.provider.applied === true`
   **且权益本身按画像方向移动**（`Δequity > 0` / `< 0`），并要求去重显式可见
   （`bluffCatchDelta === 0` + `deDuplicated === true` + 理由含「去重」）。
2. **`test/postflopRangeFoundation.test.ts` C3-3（接线锁锁点移动）**
   公共牌前缀截取被抽成单一事实来源 `boardAtStreetOf`（画像的弱牌判据也要用它）。
   锁点从「函数体内出现三元表达式」改为「函数体调用该 helper」+「helper 本身按街道截取」。

**没有**任何阈值被调整、没有容差被放宽、没有测试被删除或跳过。

### 9.2 真实牌局复算（历史脚本原样重跑，答案无回退）

| 脚本 | 节点 | 修复后答案 | 与修复前对比 |
|---|---|---|---|
| `review-hand-01` | 翻前 A♠J♠ / 翻牌 / 转牌 | 加注 9BB / 过牌 / 过牌 | 动作不变；下注分 0.000 → 0.020（画像进入范围） |
| `review-hand-02` | 翻牌 / 转牌 / 河牌 | 加注 12BB / 下注 29.5BB / 下注 56BB | 动作与尺寸不变；权益 89.4% → 89.2%（画像进入范围） |
| `review-hand-03` | 河牌（三画像） | FOLD / FOLD / FOLD | 动作不变；权益 17.5 / 16.8 / 18.1%（**画像开始区分**） |

---

## 10. 未解决 / 需要使用者裁决的事项（**不静默迁就**）

1. **测试局 3 节点无法被有界画像翻转为 CALL，这是正确行为而非缺陷。**
   该节点权益 17.5% vs 所需 31.0%，缺口 **13.5 个百分点**。
   本次画像通道的总幅度按工程护栏限制在「方向性提示」量级
   （单层 ≤ 0.4 对数、观测层 ≤ 0.35、尺寸层 ≤ 0.25，且明文禁止覆盖硬数学）。
   要让这个节点翻转，需要把画像幅度放大到 `exp(0.55)` 以上，
   那等于让「用户随手选的类型」推翻数学结论 —— 与使用者自己的禁令冲突。
   因此报告如实给出两个**门槛邻近**的真实节点作为动作翻转的验收证据（§5.1）。
2. **`valueThinness`（薄价值倾向）未实现为独立字段**（见 §3.2）：没有可信数据定义它的刻度。
   现有 `thinValueDelta` 仍按画像方向作用于剥削层（未去重，因为范围里没有「他跟注我的下注」这条信息）。
3. **翻前基础范围仍未受画像调整**：`buildBaseRange` 用位置先验构建，
   画像只作用于「超出基础动作之外」的行动似然。翻前开池范围如何按画像调宽调窄，
   需要一个独立的、可验证的口径（涉及 169 类权重表，不宜顺带改）。
4. **`AGGRESSIVE` / `CALLING_STATION` 的方向值得使用者确认**（诚实列出，不伪装成结论）：
   实测「激进」让 Hero 的抓诈唬权益**下降**（16.905% < NORMAL 17.495%），
   因为「凶而诈唬不多」的对手，其下注范围更偏价值；
   「跟注站」让权益**上升**（17.703%），因为其范围极宽、含大量弱牌。
   两者都符合「只有未被诈唬解释的进攻性才抬高价值端」这条口径，但与直觉印象可能不同。
5. 既有的历史待办不变：`hashManualInput` 的牌序规范化（会作废历史日志 hash）、
   缓存键 64/128 位摘要迁移、半诈唬下注分恒为 0.000、`boardWetnessOf` 只看牌面自身结构、
   低 SPR 下薄价值配满池尺寸。

---

## 11. 改动清单

**新增**

- `src/domain/player/archetypeDimensions.ts`：手选画像 → 连续维度 + 证据优先级解析
- `src/domain/player/tendencyProvider.ts`：画像 / 近期倾向 → 动作似然的 provider（有界、可审计）
- `test/profileRangeAdjustment.test.ts`：14 项验收（A/B/C 单调、动作翻转、反向、去重、护栏、尺寸通道）
- `reports/PROFILE_RANGE_MAINCHAIN_REPORT.md`（本文件）
- `scripts/profile-range-probe.ts` / `scripts/profile-flip-search.ts`：验收与搜索脚本

**修改**

- `src/app/manualInput/contextBuilder.ts`：画像前移 + provider 接线 + 证据组装 + `boardAtStreetOf` 单一事实来源
- `src/app/decision/postflopAdvisor.ts`：抓诈唬偏移去重（显式标注）
- `src/app/decision/decisionEngine.ts`：`decisionMargin`（与模型置信度分离）+ 诊断字段
- `src/domain/decision/decision.types.ts`：`ProfileRangeEvidence` / `DecisionMargin` / `DecisionMarginFacts`
- `src/domain/postflop/riverActionClass.ts`：质量口径 `riverActionMassesOf`
- `src/domain/postflop/exploit.ts` / `src/domain/postflop/types.ts`：`deDuplicated` / `actionMasses`
- `src/app/manualInput/rangeFacts.ts`：`actionMasses` 接入
- `src/viewmodels/decisionViewModel.ts`：`debug.profileRange` / `debug.decisionMargin` 两组调试行
- `src/infra/artifactDefinitions.ts`：两个新域文件纳入产物清单（134 → 136）
- `CURRENT_PROJECT_STATUS.md`：测试数 / 产物数 / 红队轮次同步
