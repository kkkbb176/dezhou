# V2.1 第一轮 · 画像决策小规模验证报告

**裁决（本轮范围）：`SMALL_SCALE_VALIDATION — PASS_WITH_WARNINGS`**

> 🔴 **适用范围警告**：本报告的全部数字实测于
> `src/domain/player/behaviorProfile.ts @ cebd50eab4c3cc5e…`。
> **该文件在报告写作期间已被另一并发会话改动**（→ `2229938c4255…`），
> 因此本报告**不适用于**改动后的版本。详见 §7.1。

```text
ALPHA_DECISION_MODEL_VERSION = 1.0.5（未改动）
生产链路（画像 → 决策）      = 真实存在且可复现（PASS）
行为方向依据                = 有依据（行为层 Fold/Call/Raise 与 ΔBetEV 方向一致）
决策变化合理性              = 12 场景全部 CONSISTENT；action flip 0 / sizing change 0
画像影响分类（本轮实测）    = TRIVIAL（equityDelta 0.0135 / bluffMassDelta 0.0316）
中性画像兼容性              = PASS（不给 == UNKNOWN == NORMAL == 零手实测，逐位相同）
实际盈利改善                = 未证明（本轮未做，也不声称）
```

> ⚠️ **本轮只做小规模验证，完成后停止。** 未做 1260 组合全量矩阵、未做五 Agent 审查、
> 未做 20 节长报告、未改任何权重或阈值、未改 `MATERIALITY_THRESHOLDS`、未提交 commit。

---

## 0. 一句话结论

**画像确实通过生产链路影响决策，方向有依据、幅度极小、且在本轮的 12 个场景里没有
改变任何一个动作或下注尺度。** `TRIVIAL` 不是失败 —— 它意味着「数值上可测、
方向上正确、但不足以单独改变行动」；真正需要警惕的是下面 §7 登记的三条风险。

---

## 1. 交接基线的核实结果（**与交接说法不一致的都已标出**）

### 1.1 核实表

| 交接声称 | 本轮实测 | 判定 |
|---|---|---|
| `ALPHA_DECISION_MODEL_VERSION = 1.0.5` | `decision.types.ts:1307` = `'1.0.5'` | ✅ 属实 |
| `npm run verify` 通过 | **基线 fail 4 / 收尾 fail 5**（详见 §1.2、§8.4） | ❌ **不属实** |
| 1778 tests | `tests 1778` | ✅ 属实 |
| 137 suites | `suites 137` | ✅ 属实 |
| fail 0 | **fail 4（首次）/ fail 5（收尾）** | ❌ **不属实** |
| `PROFILE_MATERIALITY = TRIVIAL` | 本轮独立复算仍为 `TRIVIAL` | ✅ 属实（但**数值不同**，见下） |
| `equityDelta = 0.0180` | 本轮 12 场景最大 **0.0135** | ⚠️ 0.0180 是 V2 黄金夹具的旧值；**本轮未复现该数字** |
| `bluffMassDelta = 0.0422` | 本轮 12 场景最大 **0.0316** | ⚠️ 同上 |
| `MATERIAL` 阈值 = `equityDelta ≥ 0.02` 或 `bluffMassDelta ≥ 0.05` | `behaviorProfile.ts:1093-1099` 确认 `equityMaterial: 0.02` / `massMaterial: 0.05`，判定是**或**关系 | ✅ 属实 |
| 工作区有大量修改及未跟踪文件，没有提交 | 确认（§8）；**且本轮进行中有另一个会话在并发写同一工作区** | ✅ 属实 + ⚠️ 见 §1.4 |
| V2.1 尚未开始 | ❌ **仓库里已有大量 V2.1 产物**（§1.4） | ❌ **不属实** |

**关于 `equityDelta` 的两个数字必须分开读**：
`0.0180` 出自 V2 报告的黄金夹具（CO `A♣J♥` / 牌面 `A♦8♠4♠2♣K♦` / 河牌 BB 下 75% 池），
本轮 B1 场景**就是那一手**，实测 `+0.0135`。差异来源是
`villain.quickProfile` 取值路径不同：V2 用 `MANIAC`，本轮 B1 也是 `MANIAC`，
但**本轮把两侧都收敛到同一 `equitySeed` 与宽裕预算**，故取到的是本轮复算值。
**本轮不把 0.0180 写成本轮实测。**

### 1.2 本轮 `npm run verify` 的真实账目

```text
npm run typecheck      ✔ 0 错误
npm run manifest:check ✔ 154 个产物与清单一致
npm test               1778 tests / 137 suites / pass 1774 / fail 4
exit code 1
```

**单位澄清（交接里混用过的三个数）**

| 数字 | 单位 | 本轮实测 |
|---|---|---|
| **1778** | **测试用例数**（`node:test` 的 `tests`） | 1778 |
| **137** | **套件数**（`node:test` 的 `suites`，即顶层 `describe`/子测试组） | 137 |
| **86** | **测试文件数**（`test/**/*.test.ts`） | **86**（tracked 75 + untracked 11） |

⇒ 交接里的「85→86」是**测试文件数**（+1 个新测试文件），与 137 套件、1778 用例
**不是同一把尺子**，不能互相推算。

### 1.3 4 个失败的定性：**既有问题，非本轮引入**

四个失败**全部是墙钟预算/性能断言**，且**单独运行全部通过**：

```text
node --test test/layeredPot.test.ts test/postflopOutput.test.ts \
           test/postflopRegressionCases.test.ts test/dynamicBehavior.test.ts
⇒ tests 82 / suites 0 / pass 82 / fail 0
```

| 失败用例 | 断言 | 实际 |
|---|---|---|
| `dynamicBehavior.test.ts:1071` | 5000 事件 P95 热路径预算 20ms | 111.0ms |
| `layeredPot.test.ts:483`（POT-14） | 分层计算预算约 200ms | 1076ms |
| `postflopOutput.test.ts:50`（P3-1） | 分析硬上限 8000ms | 9466.7ms |
| `postflopRegressionCases.test.ts:276`（TEST 5） | 分析硬上限 8000ms | 8330.3ms |

**定性依据**：本轮**只新增** `reports/` 与 `scripts/` 下的文件，**没有触碰任何
`src/` 热路径代码**（`src/` 的唯一改动是一段 JSDoc 注释，见 §6）。
因此本轮不可能引入这些延迟。它们是**全套件并发 CPU 争用**下的墙钟抖动，
与 V2 报告 §11 记录的现象同源。

**处理方式：不放宽任何断言，不修改测试，如实记为既有问题。**

### 1.4 🔴 未跟踪文件的归属，以及一个必须披露的环境事实

**本轮进行期间，有另一个开发会话在并发写同一个工作区。** 证据：

```text
本轮开始时  git status --porcelain  ⇒ 82 条
本轮中期    git status --porcelain  ⇒ 137 条
本轮结束时  git status --porcelain  ⇒ 156 条（26 M + 130 ??）—— **仍在增长**
本轮期间新建  scripts/v21-*.ts 约 35 个（创建时间戳连续落在 18:36–18:56）
```

也就是说，交接里说的「V2.1 尚未开始」**不成立**：仓库在我接手时已有
（且在我工作期间持续新增）另一会话产出的 V2.1 脚本与报告。

**归属登记**

| 类别 | 文件 | 归属 |
|---|---|---|
| 现有交付（V2 及更早，未提交） | `src/` 下 26 个 `M` 文件、22 个 tracked 测试 `M`、V2 之前的 `??` 报告与脚本 | **EXISTING（非本轮）** |
| V2 画像量化交付 | `reports/PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md`、`src/domain/player/behaviorProfile.ts`、`profileRangeMetrics.ts`、`test/profileV2Metrics.test.ts` 等 | **EXISTING（V2 交付，未提交）** |
| 并发会话的 V2.1 产物 | `scripts/v21-*.ts`（约 35 个）、`reports/V21_*.md`、`reports/V21_*.txt`、`reports/evidence/v21-*` | **UNKNOWN（非本轮，来源为并发会话）** |
| **本轮产出** | `scripts/v21-small-scale-scenarios.ts`、`scripts/v21-small-scale-supplement.ts`、`scripts/tmp-v21-history-shape-probe.ts`、`logs/v21-small-scale-*.txt`、`reports/evidence/v21-supplement.out.txt`、`reports/PROFILE_V21_SMALL_SCALE_AUDIT.md`、`src/domain/player/profileRangeMetrics.ts`（仅注释） | **THIS ROUND**（SHA256 见 §8.3） |

⚠️ **不得把上表第 3 行当作本轮实测**：那些文件不是本轮产物，其内容本轮**未复核、
未引用为证据**。本轮所有数字都来自本轮亲自运行的脚本（§5）。

### 1.5 「同一报告为什么同时出现 M 和 ??」

**没有出现过。** 本轮开局 `git status --porcelain` 中
`PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md` 只出现一次，状态为 `??`（未跟踪）。
不存在同一路径既是 `M` 又是 `??` 的情形 —— Git 的 porcelain 格式对同一路径
只输出一行，`M`（已跟踪已修改）与 `??`（未跟踪）在语义上互斥。

**最可能的来源**：交接把**两个不同文件**的条目合并叙述了 ——
同一批未跟踪报告里既有 V2 报告（`??`），也有**已跟踪但被修改**的
`CURRENT_PROJECT_STATUS.md` / `data/artifact-manifest.json`（`M`）。
⇒ **判定为交接叙述混淆，不是真实的多重真相源事故。**

### 1.6 未提交状态不得称为「干净 Git 基线」

**本轮不使用「干净基线」这个说法。** 可复现的文件状态是：

```text
HEAD              = c3391ef19942b568784562057c65b508b9e2aaef
branch            = main（与 origin 无跟踪配置）
tracked 修改      = 26 个 M
未跟踪            = 130 个（含本轮 7 个）—— ⚠️ 该数字在报告写作期间**仍在增长**（并发会话）
共享源文件 SHA256（本轮读取的判定依据，前 16 位）：
  src/domain/player/behaviorProfile.ts      CEBD50EAB4C3CC5E
  src/app/manualInput/rangeFacts.ts         EC69C4E8525650CE
  src/app/manualInput/contextBuilder.ts     474866AC5066253A
```

⚠️ **因为存在并发写入，上表哈希只代表「本轮读取时」的状态**；
本轮未对其加锁，也未阻止其他会话继续修改。这是本报告的**已知不确定性**。

---

## 2. 生产链路的真实入口与消费位置

**结论：链路真实存在。** 画像不是孤立函数 —— 它从**生产决策入口**进入，
影响一路传到范围、权益、EV 与最终动作。

```text
analyzeManualHand(input)                        src/app/alphaPipeline.ts
 └─ buildDecisionContext(input)                 src/app/manualInput/contextBuilder.ts:3067
     │
     ├─ ① 画像构造（P0 修复的接线点）
     │    behaviorProfile = input.behaviorProfile
     │      ?? behaviorProfileOf({ playerId: villainId, archetype: quickProfile })
     │                                        contextBuilder.ts:3168-3175
     │    ⚠️ quickProfile === 'UNKNOWN' ⇒ **不派生**（保持无画像路径）
     │
     ├─ ② 画像 → 范围（**两个通道都真实生效**）
     │    a) tendency provider：applyLikelihoodUpdates(..., tendency.provider, behaviorProfile)
     │                                        contextBuilder.ts:1440-1447 → :1039
     │       posterior ∝ prior × likelihood × profileFactor × observationFactor
     │       ⇒ 对**所有街**生效（翻前到河牌）
     │    b) 河牌进攻动作的**似然覆盖**（V2 统一似然）
     │       if (record.street === RIVER && isAggressive)   contextBuilder.ts:1202
     │         estimateUnifiedActionLikelihood(...)         contextBuilder.ts:1280-1290
     │         → likelihoodOverride → updateRange           contextBuilder.ts:1310-1328
     │       ⚠️ 仅河牌 + BET/RAISE/ALL_IN；`node === null` 时 fail-closed 回落
     │
     ├─ ③ 范围 → 牌面事实（**只读观测，不参与决策**）
     │    opponentRangeFactsOf(range, board, heroHole)      rangeFacts.ts:84
     │      ├─ profileClassMasses（类别概率质量 + effectiveCombos + mass90/95）
     │      └─ actionMasses / counts / weakerShare / ...
     │    🔴 生产链路**没有**任何消费者读取 profileClassMasses / actionMasses
     │       （`src/` 内零引用，仅 `test/` 与 `scripts/` 读它）⇒ **观测层，不是决策输入**
     │
     ├─ ④ 范围 → 权益
     │    computeHeroEquity(...)                           contextBuilder.ts:2169
     │
     ├─ ⑤ 范围 → 行为响应（Fold / Call / Raise）
     │    buildBetDecisionFacts(...)                       contextBuilder.ts:1567
     │      → buildResponseModel({ tendencies: responseTendenciesOf(dimensions, confidence) })
     │      ⇒ 画像经 `dimensions` 改变对手的弃/跟/加概率
     │
     └─ ⑥ → 动作与尺度
          postflopAdvisor betDecision（候选尺寸 + BetEV）  postflopAdvisor.ts:549-619
          valueBetGate / decisionEngine                    decisionEngine.ts
```

**关键判定**：`profileClassMasses` 与 `profileRangeDistance` **都不是决策输入**。
画像影响决策的真实中介量是 ②-a 的 `profileFactor`、②-b 的 `likelihoodOverride`、
以及 ⑤ 的响应倾向。**这一条纠正了「画像主要经范围质量影响决策」的直觉读法。**

---

## 3. `rangeDistance` 的真实含义（已按任务要求加注）

**核实结论：确实只是 5 个互不重叠类别的分布差异，不是 1326 组合级距离。**

生产聚合器 `profileClassMasses`（`rangeFacts.ts:203-267`）把后验质量归入
**8 个 `RiverComboClass`**，测试再用它们拼成 **5 个互不重叠分量**：

```text
[ valueMass − thinValueMass, thinValueMass, showdownMass, missedDrawMass, pureAirMass ]
```

`profileRangeDistance` 对**任意对齐向量**都成立，但**本仓库唯一调用点**
（`test/profileQuantificationGolden.test.ts:294`）传的就是上面这个 5 维向量。

**本轮已落地的标注（只加注释，不做全仓重命名）**

| 位置 | 加注内容 |
|---|---|
| `src/domain/player/profileRangeMetrics.ts`（`profileRangeDistance` 的 JSDoc） | 新增 `CATEGORY_LEVEL_RANGE_DISTANCE (= RANGE_DISTANCE_PROXY)` 标注；写明「同一类别内部的组合变化它看不见」；写明与 `profileMaterialityOf.rangeDistance` 的**同名不同义** |
| 本报告 §4 / §5 表格 | 该列一律写 `CATEGORY_LEVEL_RANGE_DISTANCE(TV)`，不写「范围距离」 |
| `scripts/v21-small-scale-scenarios.ts` 输出头 | 打印口径说明行 |

**未做全仓重命名**，原因：`rangeDistance` 作为字段名被
`profileMaterialityOf` 的入参、`RangeDistance` 类型、V2 报告与多个脚本引用；
盲目改名会破坏兼容性且超出本轮范围。**内部字段名保持 `rangeDistance`。**

⚠️ 另有一处**真实的同名不同义**（本轮核实，登记而非修改）：
`profileMaterialityOf({ rangeDistance })` 是**装饰字段**（`behaviorProfile.ts:1121-1132`
的判定只用 `equityDelta` 与 `bluffMassDelta`），而黄金测试传进去的其实是
`|ΔbluffMass|`、两个脚本传字面量 `0`。⇒ 该字段的 `noteZh` 里「范围距离 X」
在黄金测试中打印的是 **ΔbluffMass**。

---

## 4. 12 个代表场景的对照表

**对照方法**：每个场景跑**两次真实生产入口**，**只改 `villain.quickProfile`**；
`actionHistory` / 底牌 / 牌面 / 筹码 / `asOf` / `equitySeed` / 预算**逐位相同**。
画像输入**不含**本手牌的未来行动或摊牌结果（夹具只到决策时刻）。

**固定设置**：9-max · 1/2 · 100BB · `asOf=1757000000000` · `equitySeed=20260913` ·
`budget 120000/240000ms`（宽裕预算 ⇒ 两侧走**同一条**估计量路径）。

| # | 场景 | 我的位置 | 手牌 / 公共牌 | 动作 | CATEGORY_LEVEL_RANGE_DISTANCE(TV) | Δ权益 | Δ诈唬质量 | ΔCallEV | Δ对手弃/跟/加 | flip |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 | 跟注站 · 弱牌诈唬 | CO | `9c8c` / `AdKs7h3c2d` | CHECK→CHECK | 0.0052 | +0.09pp | +0.08pp | 0 | −3.16 / **+3.30** / −0.14pp | 无 |
| A2 | 跟注站 · 强牌价值 | CO | `AcAh` / `AdKs7h3c2d` | BET→BET | 0.0007 | −0.01pp | +0.06pp | 0 | −4.28 / +4.44 / −0.16pp | 无 |
| A3 | 跟注站 · 边缘薄价值 | CO | `Th9d` / `AhTs5c3d2h` | CHECK→CHECK | 0.0082 | +0.44pp | +0.13pp | 0 | −0.70 / +1.87 / −1.17pp | 无 |
| B1 | 疯狂型 · 抓诈唬（75%池） | CO | `AcJh` / `Ad8s4s2cKd` | CALL→CALL | **0.0316** | **+1.35pp** | **+3.16pp** | **+0.63** | N/A（我面对下注） | 无 |
| B2 | 疯狂型 · 行动线偏强（超池） | CO | `QcQd` / `Jh8s4c2d9h` | CALL→CALL | 0.0234 | +1.33pp | +2.34pp | +2.06 | N/A | 无 |
| B3 | 疯狂型 · 价值牌 vs 超池 | CO | `KcKd` / `Kh8s4c2d9h` | RAISE→RAISE | 0.0291 | +0.00pp | +2.91pp | 0 | N/A | 无 |
| C1 | 紧弱型 · 弃牌率与诈唬机会 | CO | `9c8c` / `AdKs7h3c2d` | CHECK→CHECK | 0.0062 | −0.21pp | −0.19pp | 0 | **+2.66** / −2.60 / −0.06pp | 无 |
| C2 | 紧弱型 · 对手强行动后更新 | CO | `AcJh` / `Ad8s4s2cKd` | CALL→CALL | 0.0059 | +0.05pp | −0.16pp | +0.08 | N/A | 无 |
| C3 | 紧弱型 · 尺度与继续范围 | CO | `AcAh` / `AdKs7h3c2d` | BET→BET | 0.0004 | +0.01pp | −0.03pp | 0 | **+8.93** / −8.89 / −0.04pp | 无 |
| D1 | 样本不足 / 无画像 | CO | `AcJh` / `Ad8s4s2cKd` | CALL→CALL | 0.0000 | +0.00pp | 0.00pp | 0 | N/A | 无 |
| D2 | 历史 vs 当前冲突（尺寸隔离） | CO | `AcJh` / `Ad8s4s2cKd` | CALL→CALL | 0.0172 | +0.71pp | +1.72pp | +0.19 | N/A | 无 |
| D3 | 中性画像兼容性 | CO | `AcJh` / `Ad8s4s2cKd` | CALL→CALL | 0.0000 | +0.00pp | 0.00pp | 0 | N/A | 无 |

```text
场景总数 = 12    action flip = 0    sizing change = 0
最大 |Δ权益|     = +1.35pp（B1）
最大 |Δ诈唬质量| = 0.0316（B1）
materiality     = TRIVIAL（0.0135 < 0.02 且 0.0316 < 0.05，两个维度都未达阈值）
```

**Δ对手弃/跟/加「N/A」的原因**：响应模型（`buildBetDecisionFacts`）**只在无人下注的
下注决策节点构建**（`postflopAdvisor.ts:550`：`if (facingBet || betDecisionFacts === null) return null`）。
因此「我面对下注」的节点（B1/B2/B3/C2）**结构性地拿不到**对手对我下注的反应概率。
这是**设计边界，不是缺陷**，如实记为 `NOT_AVAILABLE`。

---

## 5. 合理 / 不合理 / 证据不足 / 不支持

### 5.1 合理（预期与实际方向一致，且因果链可读）

**（1）跟注站削弱纯诈唬 —— A1（行为层，方向正确）**

```text
预期（运行前写定）：跟注站 Call 概率更高 ⇒ 纯诈唬的弃牌收益下降 ⇒ 下注 EV 不得上升
实测（第一档尺寸 33% 池）：
  弃牌率  10.2% → 7.0%   （−3.16pp）
  跟注率  82.2% → 85.5%  （+3.30pp）
  BetEV   −2.457 → −2.916 筹码（−0.459）
  过牌EV   0.261 → 0.271（过牌仍是最优 ⇒ 动作不变）
⇒ CONSISTENT。因果链：画像维度 → 响应倾向 → P(弃)↓ → 弃牌分支收益↓ → BetEV↓
```

**（2）紧弱型提高弃牌率、抬升诈唬吸引力 —— C1 / C3（行为层，方向正确）**

```text
C1（空气，33%池）：弃牌率 10.2% → 12.8%（+2.66pp）；BetEV −2.457 → −2.065（+0.392）
C3（坚果，33%池）：弃牌率 19.1% → 28.0%（+8.93pp）；跟注率 73.3% → 64.4%（−8.89pp）
⇒ CONSISTENT：紧弱对手确实更容易被赶走，坚果下注的相对吸引力上升。
```

**（3）疯狂型的抓诈唬依据 —— B1（范围层，四条单调性全部成立）**

```text
诈唬质量  STATION 0.0078 < 中性 0.0184 < MANIAC 0.0500   ✅ 双向
Hero 权益 STATION 55.81% < 中性 56.26% < MANIAC 57.61%   ✅ 双向
CallEV    STATION 12.230 < 中性 12.442 < MANIAC 13.076   ✅ 双向
动作两边都是 CALL（按规范**不断言**动作必须翻转）
```

**（4）中性兼容性完全成立 —— D1 / D3**

```text
不给画像 == UNKNOWN    ：逐位相同 ✅
不给画像 == NORMAL     ：逐位相同 ✅
不给画像 == 零手实测画像：逐位相同 ✅（handsObserved=0，neutralized=true）
```

**（5）尺寸隔离成立 —— D2 vs B1（同一条倾向未被重复计入）**

```text
只改河牌下注额（7 → 2），同一 MANIAC 画像：
  大注（75%池）Δ权益 +1.35pp / Δ诈唬 +3.16pp
  小注（25%池）Δ权益 +0.71pp / Δ诈唬 +1.72pp
⇒ 小注下调整幅度**约为大注的一半**，`riverLargeBetBluff` 条目未被施加。
  这是 `sizeBucket ≥ LARGE`（`behaviorProfile.ts:538-539`）门限行为的直接证据。
```

### 5.2 不合理 / 需要解释的观察（**均标 UNCERTAIN，不当成结论**）

**（1）B3 的 Δ权益 = +0.00pp，但 Δ诈唬质量 = +2.91pp — UNCERTAIN**

```text
局面：Hero 顶三条 KKK，河牌面对 30BB 超池（底池 147）
两侧：权益都是 100.00%（精确枚举），CallEV 都是 147.00，动作都是 RAISE
但对手范围的诈唬质量 0.0234 → 0.0526（+2.91pp）
```

**解释（部分，不足以下定论）**：Hero 持 `KcKd` 且牌面 `Kh`，对手范围里
能打败三条 K 的组合**不存在**，故权益饱和到 100%，画像改变范围组成**不可能**
改变权益。**⇒ 这是「牌力饱和」导致的合法上限，不是画像失效。**
**UNCERTAIN 的部分**：本轮**没有**验证「对手范围里诈唬质量的增加是否真的
改变了任何中间量」——在权益饱和时它只体现在 CallEV 的构成上，
而 `callEV = 权益 × winnable − callCost` 在权益=1 时**与范围无关**。
⇒ **本场景不能用来证明画像有效，只能证明「画像不破坏正确决策」。**

**（2）A3 在「河牌无进攻动作」时仍然不同 — UNCERTAIN（且推翻了我自己的预期）**

```text
预期（运行前写定）：河牌无进攻动作 ⇒ 画像似然通道不触发 ⇒ 两侧逐位相同
实测：两侧不同（Δ权益 +0.44pp，Δ诈唬 +0.13pp）
```

**根因已定位**：`contextBuilder.ts:1202` 的河牌似然覆盖**只作用于河牌进攻动作**，
但**倾向 provider（②-a，`contextBuilder.ts:1440-1447`）对所有街生效** ——
本手翻牌 Hero 有一次下注，那次 `applyLikelihoodUpdates` 就走的是带画像的
`adjustmentProvider`。⇒ **我的预期写错了，代码行为是对的。**
**UNCERTAIN 的部分**：本轮未逐一枚举 provider 在哪几条动作上真正改变了形状
（只在 A1/A3/C1/C3 打印了 `profileEvidence`，显示 `rangeLayerApplied=true`、
`doubleCountBlocked=true`）。⇒ 记为 **预期错误 + 根因已定位**，
**不是缺陷**，但报告原样保留这条写错的预期。

### 5.3 证据不足

| 项 | 为什么证据不足 |
|---|---|
| **实际盈利改善** | 本轮**完全没有**做盈利模拟。所有 EV 都是**未计抽水**（`rakeModel: 'NOT_APPLIED'`）的模型内部 EV。**模型 EV 上升 ≠ 真实盈利提升。** |
| **12 场景的统计代表性** | 12 个场景是**人工挑选的代表**，不是随机抽样。`action flip = 0` **不能**外推为「画像从不改变决策」。 |
| **对手弃/跟/加在「面对下注」节点的变化** | 结构性 `NOT_AVAILABLE`（§4 说明）。B1/B2/B3/C2 的**行为层影响完全未测**。 |
| **候选动作 EV 对决策的作用** | `diagnostics.candidates` 里 **BET/RAISE/ALL_IN 的 EV 全部 `null`**，只有 FOLD=0 / CALL=callEV / CHECK=0 参与 `mathDominanceOf`。⇒ 「哪个尺寸最好」在**面对下注**的节点上**没有 EV 依据**。 |
| **画像影响随样本量增长的行为** | 本轮**全部画像都是标签先验（有效机会次数 = 0）**。`QUICK_PROFILE_CONFIDENCE = 0.35`。**实测样本路径（`villainProfile` + `observeHand`）本轮只在 D1 用零手画像做了兼容性验证**，未做样本量 × 影响幅度的曲线。 |
| **多人与多街覆盖** | 12 场景**全部是单挑底池（BB vs CO）**、**全部在河牌决策**。**不支持的结构标为 UNSUPPORTED**（见 5.4）。 |

### 5.4 不支持（UNSUPPORTED）

| 结构 | 状态 | 证据 |
|---|---|---|
| **Hero 为 BB 的翻后场景** | **UNSUPPORTED（夹具层）** | 实测：BTN 开池、Hero BB 跟注时，引擎仍要求**翻后 BB 先说话**；把 BTN 的下注写在前面会被 `ACTION_NOT_ACTOR` 拒绝（`scripts/tmp-v21-history-shape-probe.ts` 的 V6/V7 被拒，V1 通过） |
| **Hero 在 CO、对手在 BTN 且 Hero 先说话** | UNSUPPORTED（夹具层） | 同上，单挑翻后顺序固定为 BB 先 |
| **翻牌 / 转牌决策点上的画像对照** | **NOT_TESTED** | 12 场景全部在河牌做决策；翻前/翻牌/转牌的**决策点**影响未测（但这些街的**范围更新**有被覆盖，见 §5.2(2)） |
| **多人池（≥3 家）画像对照** | **NOT_TESTED** | 本轮夹具全部单挑 |
| **非 100BB / 非 SPR≈1–3 的筹码结构** | NOT_TESTED | 12 场景固定 100BB |

---

## 6. 本轮实际修改、发现的问题、修复

### 6.1 生产代码修改：**只有一处，且仅注释**

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/domain/player/profileRangeMetrics.ts` | `profileRangeDistance` 的 JSDoc 新增 `CATEGORY_LEVEL_RANGE_DISTANCE` 口径标注 | **零行为变更**（纯注释）。`npm run verify` 的 typecheck 通过 |

**没有修改任何权重、阈值、公式、`MATERIALITY_THRESHOLDS` 或版本号。**

### 6.2 本轮自查抓到的缺陷（**都是我自己夹具的缺陷，不是生产缺陷**）

| ID | 缺陷 | 如何发现 | 处理 |
|---|---|---|---|
| **D-1** | 夹具行动顺序错误：按位置 `sort` 同街动作，把同一玩家的两个动作并到一起；且误以为「开池者」是翻后先说话方 | `ACTION_NOT_ACTOR` 拒绝 | 改为**保留作者顺序 + 仅在首位说话者无动作时插入过牌**；并实测确认「单挑翻后固定 BB 先说话」。**证据保留在 `scripts/tmp-v21-history-shape-probe.ts`** |
| **D-2** | 误把「河牌无进攻动作 ⇒ 画像不生效」写成预期 | 实测两侧不同 | 定位到 provider 对**所有街**生效；报告原样保留写错的预期并说明根因（§5.2(2)） |
| **D-3** | 用错字段名读候选下注 EV（读 `sizes[].ev` 得 `null`，真实字段是 `betEV`） | 字段转储核查 | 修正探针；**这条同时暴露了一个真实的观测面事实**（见 §6.3 W-2） |
| **D-4** | 稳定性扫描只扫 6–8BB，恰好全落在 `LARGE` 档（阈值 0.6/0.4）⇒ 得到「权益完全不动」的假平台 | 跨档宽扫描 | 改为 2–30BB 扫描，**暴露了真实的档位阶梯**（见 §6.3 W-3） |

### 6.3 发现但**未修复**的问题（按任务要求：只登记，不实施）

| ID | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| **W-1** | 4 个测试在**全套件并发**下超墙钟预算而红（单跑全绿） | §1.3 | CI 信噪比；可能掩盖真实回归 | 下一轮：给这些用例显式宽裕预算（与 V2 §11 同法）或分离性能套件 |
| **W-2** | **面对下注的节点上，候选动作 EV 全部不可得** —— `diagnostics.candidates` 中 9 个 RAISE 档 + ALL_IN 全部 `ev: null`，只有 FOLD/CALL/CHECK 参与比较 | §5.3 | 「加注到哪个尺寸」在这类节点上**没有数学依据**；`mathDominance` 只在 FOLD vs CALL 之间比较 | 需在 `postflopAdvisor` 里为**面对下注**的节点也构建响应模型与加注 EV（超出本轮范围） |
| **W-3** | `BetSizeBucketOf` 的档位阈值使**尺寸证据呈阶梯状**：`equity` 在 ratio 跨过 0.4 / 0.6 / 1.25 时才跳变 | 2–30BB 扫描：NORMAL 恒定 56.26%（1 个值）；MANIAC 只有 56.97% / 57.61%（2 个值，切换点在 5→6BB，恰好跨 0.4） | **`sizing change` 只能发生在档位边界**；连续尺寸与小尺寸扰动**不可能**改变结论（本轮 6.0–8.0BB 步长 0.25 的微扰：动作跳变 0、权益跳变 0.000pp） | 属于**设计选择**（阶梯 vs 连续），需产品决策，不是缺陷；但报告必须写明 |
| **W-4** | `profileMaterialityOf.rangeDistance` 是**装饰字段**且**同名不同义** | `behaviorProfile.ts:1121-1132` 判定不用它；黄金测试传的是 `|ΔbluffMass|`；脚本传 `0` | 读者会把 `noteZh` 里的「范围距离」误当成 TV 距离 | 建议改名或移除该字段（本轮**不改**，避免破坏兼容性） |
| **W-5** | `profileClassMasses` / `actionMasses` 在 `src/` 内**零消费者** | 全仓 grep | 「画像改变了范围质量」在牌桌上**到不了使用者** | 若要在 UI 展示，需显式接线（本轮不做） |

**修复前后证据**：本轮**没有**修复任何生产缺陷，因此不存在「修复前后对比」。
D-1～D-4 是我自己夹具的缺陷，其修正前后的**具体表现**已在上表逐条记录
（`ACTION_NOT_ACTOR` 原文、字段转储输出、扫描平台）。

---

## 7. 未解决的风险

| # | 风险 | 等级 | 说明 |
|---|---|---|---|
| **R1** | 🔴 **并发写入同一工作区 —— 本轮结论的适用范围因此受限** | **高（实质）** | 见 §7.1：另一会话在本轮结束前修改了**本报告判定依据的两个源文件** |
| R2 | **画像证据全部是标签先验（0 次有效机会）** | 高 | 12 场景的 `quickProfile` 可信度上限 0.35，无任何实测样本。**「有依据」在本轮仅指「有先验依据」，不指「有实测依据」** |
| R3 | **动作与尺度零变化** | 中 | `action flip = 0`、`sizing change = 0`。画像在本轮**没有改变任何决策**；`TRIVIAL` 与这个结果一致，但**不能**据此说「画像无用」——见 R5 |
| R4 | **幅度的可信区间未估** | 中 | 权益差 +1.35pp 是**单点估计**；V2 §10 给出 MC SE ≈ 0.6pp（p≈0.56、6000 次）。本轮两侧共用同一 `equitySeed`，**系统性偏差被抵消但噪声未被量化**（未做重复抽样） |
| R5 | **面对下注节点的行为层完全未测** | 中 | W-2 |
| R6 | **不支持的结构（BB 视角、多人、翻/转决策点）覆盖为零** | 中 | §5.4 |
| R7 | **`equityDelta` 与 V2 的 0.0180 不一致（本轮 0.0135）** | 低（已被 R1 解释掉一部分） | 除两侧收敛设置外，`behaviorProfile.ts` 在报告写作期间被并发改动（§7.1），**差异可能来自该改动** |
| R8 | **未计抽水** | 低（但方向性） | 全部 EV 是 `rakeModel: 'NOT_APPLIED'`。中低级别现金局的抽水会**系统性削弱**薄价值/薄诈唬的收益 —— 而本期画像影响的正是这些牌 |

### 7.1 🔴 必须披露：判定依据在报告写作期间被并发改动

本报告 §1.6 记录了读取时的源文件哈希。**报告写作期间**，工作区被另一会话继续修改，
`npm run manifest:check` 随后报出：

```text
[CHANGED] src/domain/player/behaviorProfile.ts
          cebd50eab4c3… → 2229938c4255…
[CHANGED] src/app/manualInput/manualInput.ts
          907c2db423a7… → e3696ad4a269…
```

`behaviorProfile.ts` **正是本报告 §2/§3/§5 的判定依据**（`estimateUnifiedActionLikelihood`、
`MATERIALITY_THRESHOLDS`、`BetSizeBucketOf` 都在该文件里）。它的哈希已变，
而 `cebd50eab4c3…` 是本轮实测所用的版本。

**⇒ 因此本报告的全部数字的适用范围是：**

```text
VALID FOR: src/domain/player/behaviorProfile.ts @ cebd50eab4c3cc5e…（本轮读取时刻）
NOT VALID: 该文件在 2229938c4255… 及之后版本上的行为
```

**我没有重新测量，也没有回退并发改动**（未经授权不得覆盖他人工作）。
若需要「当前 HEAD + 最新工作区」的结论，**必须用 §8.2 的命令重跑**。

⚠️ 同样地，`data/artifact-manifest.json` 在本轮重算通过后**又被并发改动弄脏**
（上述两项 `[CHANGED]`）。我**没有**再次重算 —— 那会掩盖「这轮并发改动尚未登记」
这一事实，且重算清单属于并发会话自己的工作流。**下一轮开始前应先解决这个清单不一致。**


---

## 8. 交付物与 Git 状态

### 8.1 本轮新增/修改文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `reports/PROFILE_V21_SMALL_SCALE_AUDIT.md` | 新增 | 本报告 |
| `scripts/v21-small-scale-scenarios.ts` | 新增 | 12 场景主验证脚本（可复现） |
| `scripts/v21-small-scale-supplement.ts` | 新增 | 补充指标探针（行为层 + EV + 稳定性） |
| `scripts/tmp-v21-history-shape-probe.ts` | 新增 | **诊断用**夹具形状探针（D-1 证据） |
| `logs/v21-small-scale-scenarios.txt` | 新增 | 主脚本原始输出（412 行） |
| `logs/v21-small-scale-supplement.txt` | 新增 | 补充探针原始输出 |
| `reports/evidence/v21-supplement.out.txt` | 新增 | 补充探针原始输出（副本） |
| `src/domain/player/profileRangeMetrics.ts` | **修改（仅注释）** | `CATEGORY_LEVEL_RANGE_DISTANCE` 口径标注 |
| `CURRENT_PROJECT_STATUS.md` | 修改 | 新增 §10.0.14 一节，**保留 V2 历史结论** |
| `data/artifact-manifest.json` | 修改 | 因上一条触发 `manifest:check` 报 `[CHANGED]`，按项目自身流程 `npm run manifest` 重算（**154 个产物不变**） |

`logs/` 与 `scripts/tmp-*` 被 `.gitignore` 覆盖，故不出现在 `git status` 中。
`verify-v21-baseline.txt` 是本轮验证的原始输出，未跟踪。

### 8.2 复现命令

```text
node --experimental-strip-types scripts/v21-small-scale-scenarios.ts    # 12 场景对照表
node --experimental-strip-types scripts/v21-small-scale-supplement.ts   # 行为层 + EV + 稳定性
node --experimental-strip-types scripts/tmp-v21-history-shape-probe.ts  # D-1 夹具形状证据
node --test --experimental-strip-types test/profileV2Metrics.test.ts \
  test/profileQuantificationGolden.test.ts test/profileQuantification.test.ts \
  test/profileRangeAdjustment.test.ts test/reportVerdictConsistency.test.ts   # 中性回归（40/40）
npm run verify
```

### 8.3 可复现文件状态与哈希

```text
HEAD = c3391ef19942b568784562057c65b508b9e2aaef     （本轮未提交任何 commit）

本轮产出 SHA256（前 16 位）：
  scripts/v21-small-scale-scenarios.ts     511AF2231F0A56DE
  scripts/v21-small-scale-supplement.ts    90956112F17B60B4
  scripts/tmp-v21-history-shape-probe.ts   522B2862DAE7B8F7

本轮读取的判定依据 SHA256（前 16 位）：
  src/domain/player/behaviorProfile.ts     CEBD50EAB4C3CC5E
  src/app/manualInput/rangeFacts.ts        EC69C4E8525650CE
  src/app/manualInput/contextBuilder.ts    474866AC5066253A

git status（本轮结束时刻）：156 条 —— 26 M + 130 ??（含并发会话产出；**数字仍在增长**）
```

### 8.4 本轮最终的验证状态

```text
npm run typecheck       ✔ 0 错误
npm run manifest:check  ✔ 154 个产物一致（因本轮改动了 CURRENT_PROJECT_STATUS.md
                          曾报 [CHANGED]，按项目自身流程 npm run manifest 重算后通过）
npm test                1778 tests / 137 suites / pass 1773 / fail 5
                        （失败集合**每次运行都在变**，见下）

本轮两次全量运行（同一份代码，中间只多了 JSDoc 注释与状态文档）：
  基线（verify-v21-baseline.txt）: pass 1774 / fail 4
    动态行为 P95、layeredPot POT-14、postflopOutput P3-1、postflopRegressionCases TEST 5
  收尾（verify-v21-final.txt）  : pass 1773 / fail 5
    多人池 rangeProvenance、动态行为 P95、postflopOutput P3-1/P3-2/P3-3
  ⇒ **失败项本身在两次运行之间换了位置**（P3-2/P3-3 只在第二次红；
    POT-14 与 TEST 5 只在第一次红）—— 这正是「墙钟抖动」而不是「确定回归」的判据。

中性画像回归（本轮重跑）：
  test/profileV2Metrics.test.ts（含 NEUTRAL_PARITY 48 格逐位相等）  ✔
  test/profileQuantificationGolden.test.ts（§二十 四条单调性）      ✔
  test/profileQuantification.test.ts / profileRangeAdjustment / reportVerdictConsistency  ✔
  ⇒ 40 tests / pass 40 / fail 0

本轮确定性自检：
  B1/MANIAC 同一输入重复 3 次 ⇒ equity 57.61% / callEV 13.08 / bluff 0.0500 逐位相同  ✔
```

⚠️ **两次运行的 `fail` 数不同（4 → 5）不得被读成本轮引入了新缺陷**：
本轮对 `src/` 的唯一改动是 `profileRangeMetrics.ts` 的一段 JSDoc，
**不被任何热路径或上表失败用例引用**；且失败项在两次运行间**互相替换**。
真实解释是**同一台机器上的并发会话正在跑自己的脚本**（§1.4），
把全套件推到了更重的 CPU 争用下。⇒ 这同时是 **R1（并发写入）** 的一次现场印证。


---

## 9. 明确区分四件事（按任务要求）

| 命题 | 本轮结论 | 依据 |
|---|---|---|
| **链路真实存在** | ✅ **已证明** | §2：从 `analyzeManualHand` 到动作的完整调用链，逐点行号；且**只改画像**即可改变范围/权益/EV |
| **行为方向有依据** | ✅ **已证明（在标签先验意义上）** | §5.1：跟注站 ⇒ 弃牌率↓、紧弱 ⇒ 弃牌率↑、疯狂型 ⇒ 诈唬质量↑，三条都与扑克原理方向一致 |
| **决策变化合理** | ✅ **本轮 12 场景全部 CONSISTENT** | 但**变化幅度为 0**（action flip 0 / sizing change 0）。「合理」在这里指**没有出现不合理的变化**，不指「产生了更好的决策」 |
| **实际盈利改善** | ❌ **完全未证明** | §5.3：未做盈利模拟、未计抽水、无实测样本。**模型内部 EV 上升不等于真实盈利提升** |

---

## 10. 下一轮最值得处理的最多 3 个问题

**1. 打通「面对下注」节点的候选动作 EV（W-2）**
现状：9 个 RAISE 档 + ALL_IN 的 EV 全是 `null`，`mathDominance` 只在 FOLD vs CALL
之间比较。⇒ **中低级别现金局最常见的节点（面对下注）没有尺寸依据。**
最小方案：在 `postflopAdvisor` 里对 `facingBet` 分支复用 `buildResponseModel`
（它已经在 `buildBetDecisionFacts` 里可用），为加注档产出区间 EV 并标 `HEURISTIC`。

**2. 给「画像影响幅度」一个可信区间，而不是单点（R4）**
现状：+1.35pp 是单点；V2 的 0.0180 与本轮的 0.0135 差异未归因。
最小方案：对 B1 做 `equitySeed` 的**重复抽样**（≥20 次），报告均值与标准误，
并解释与 V2 的差异是否落在噪声内。

**3. 把 `TRIVIAL` 的边界条件做成可复现的期望值测试（R3 / W-3）**
现状：`action flip = 0` 是**观察**，没有测试锁定「哪些场景**应该**翻转」。
最小方案：构造**紧邻决策边界**的场景（权益贴近 `requiredEquity`），
断言画像**能把动作推过边界**；同时断言**档位边界外**的连续尺寸扰动**不**翻转
（把 W-3 的阶梯行为变成显式契约，而不是隐含行为）。

> ⚠️ 上述三项都**超出本轮范围**，本轮只登记，不实施。

---

## 附：本轮**没有**做的事（防止误读）

- ❌ 1260 组合全量矩阵
- ❌ 五 Agent 独立审查（本轮**没有**多 Agent 能力，故**不声称**完成五个独立 Agent 审查；
  上述内容全部是**单会话多视角自查**）
- ❌ 20 节长报告（仓库内**未找到**原定 20 节格式要求，故自建本节结构 —— 如实披露）
- ❌ 1326 combo 级范围引擎
- ❌ 修改 `MATERIALITY_THRESHOLDS` 或任何权重/参数
- ❌ 用四舍五入后的展示值参与判定（所有判定用原始浮点值）
- ❌ 为制造更多 action flip 而优化
- ❌ 把模型内部 EV 上升说成真实盈利提升
- ❌ commit
