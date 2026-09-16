# 翻后决策系统升级 · 最终报告（P6）

**日期**：2026-09
**范围**：`Alpha` 主应用的**翻后**决策链升级（不是重写项目）
**验收**：`npm run verify` 全绿 —— **1,625 项 / 137 套件 / 0 失败**，类型检查零错误，产物清单一致

**唯一目标（使用者给定）**：在真实低级别现金局 / 朋友局环境中，使翻后动作优先选择
**长期期望值 EV 更高**的决策，并保持**理论基线**与**真人 exploit** 两层逻辑分离。

```text
GTO / 理论基线  → 防止明显错误（底池赔率、权益、门槛、承诺、多人惩罚）
真人画像        → 只在有可靠证据时做 +EV 剥削（幅度受上限与可信度约束，永不覆盖硬数学）
```

---

## 1. 修改文件清单

### 1.1 新增（21 个源文件 + 5 个测试文件）

| 类别 | 文件 | 作用 |
|---|---|---|
| 领域 | `src/domain/poker/boardRelativeStrength.ts` | 形态 → 0..5 **牌面相对强度档**（C3 修复的底座） |
| 领域（13） | `src/domain/postflop/types.ts` | 共享类型：`RelativeHandRole`(10) / `OpponentRangeFacts` / `DrawProfile` / `PostflopInputs` |
| | `src/domain/postflop/draws.ts` | `drawProfileOf` 听牌剖面（同花听 / 两头顺 / 卡顺 / 补牌数） |
| | `src/domain/postflop/suit.ts` | 花色序（单一事实来源） |
| | `src/domain/postflop/boardDelta.ts` | **Board Delta 12 个数值字段** |
| | `src/domain/postflop/relativeHandRole.ts` | **相对牌力角色** 10 类判定 |
| | `src/domain/postflop/rangeCompression.ts` | **Range Compression**：`compressionFactor` + 状态量 |
| | `src/domain/postflop/multiway.ts` | **多人惩罚**（强度/诈唬/门槛三路单调） |
| | `src/domain/postflop/commitment.ts` | **SPR / 承诺**评估 |
| | `src/domain/postflop/valueBetGate.ts` | **Value Bet Gate**（五问 + `ValueBetAssessment`） |
| | `src/domain/postflop/blockers.ts` | **阻断牌 / 非阻断牌** |
| | `src/domain/postflop/sizing.ts` | **独立尺寸**选择（动作与尺寸分离） |
| | `src/domain/postflop/evScore.ts` | 动作 EV 比较分 + **置信度**（首选比次选好多少） |
| | `src/domain/postflop/exploit.ts` | **真人剥削层**（受约束偏移） |
| 应用 | `src/app/manualInput/rangeFacts.ts` | 对手范围的**牌面事实** + **与我这手牌的精确比较** |
| 应用 | `src/app/decision/postflopAdvisor.ts` | 把 13 步按序组装成一条可解释建议 |
| 测试 | `test/postflopRangeFoundation.test.ts`（8） | C1/C2/C3 三个基础 CRITICAL 的回归锁 |
| | `test/postflopModules.test.ts`（26） | P1 各模块的方向断言 |
| | `test/postflopRegressionCases.test.ts`（6） | 使用者点名的 **TEST 1–6** |
| | `test/postflopOutput.test.ts`（5） | 输出契约（快照完整性 / 无伪精确 EV / 置信度语义 / 界面可读性） |
| | `test/postflopValueMonotonic.test.ts`（8） | 第二轮审计的**单调性与口径锁**（`NUT-*` / `GATE-*` / `RIVER-*`） |

### 1.2 修改（8 个源文件 + 2 个文档/清单）

| 文件 | 改动 |
|---|---|
| `src/app/manualInput/likelihoodModel.ts` | 新增 `CALL_WEIGHTS`（跟注 ≠ 过牌）与按动作种类的权重族 |
| `src/app/manualInput/contextBuilder.ts` | ① `firstAggressionOf` → **`firstPreflopActionOf`**（只认翻前，修 C1）；② 范围更新改用按牌面档位的权重（修 C2/C3）；③ 注入 `postflopFacts`（含 `previousBoard` 与范围事实） |
| `src/domain/decision/decision.types.ts` | `PostflopFacts` / `PostflopDecisionSnapshot` / `PlayerSnapshot.quickProfile` / `MathSnapshot.winnable` |
| `src/app/decision/decisionEngine.ts` | 接入建议器：**每个候选动作都读同一份 advice**；场景 2 的下注判据改为 `gateWantsBet`；尺寸取自 `advice.sizing.gridRatio`；新增理由码 `POSTFLOP_ROLE` / `BOARD_DELTA` / `SPR_COMMITMENT` / `VALUE_GATE`；`diagnostics.postflop` 快照 |
| `src/viewmodels/decisionViewModel.ts` | 新增 `debug.postflop` 诊断组（13 行，含「对手范围 vs 我的牌」）；「动作偏好顺序」按分数**降序**显示 |
| `data/artifact-manifest.json` | 134 个产物重新绑定 |
| `CURRENT_PROJECT_STATUS.md` | §10.0.10 记录两轮审计的 10 项修复与剩余风险；同步测试/代码规模数字 |

### 1.3 明确**未动**的部分（验收基线的保护范围）

- 翻前模块：`src/domain/gto/*`、`rfi*`、开池/3bet 范围表 —— **零改动**
- 手动输入模块：`manualInput.ts`、`reconstruct.ts`、`legalActions.ts`、牌桌适配器 —— **零改动**
- 玩家画像模块：`playerClassifier.ts`、`playerStore` —— **零改动**（只是在建议器里**读**它）
- 权益引擎、边池/分层权益、GTOpen 集成（`GtoProvider` 边界）—— **零改动**
- 既有测试：**没有删除、没有放宽任何一条断言**（新增 53 条，修改 2 条的**输入/措辞**但保留并加强了原断言）

---

## 2. 原问题根因（为什么必须改）

### 2.1 三个基础 CRITICAL（P0，均在真实管线上复现）

| # | 缺陷 | 修复前实测 | 根因 |
|---|---|---|---|
| **C1** | 跛入池（翻前无人加注）里的翻后下注被当成**翻前开池** | BB 下注 ⇒ `rfiTierByPositionName:「BB」没有开池范围` ⇒ **整条 `CONTEXT_BUILD_FAILED`**；CO 下注 ⇒ 静默套上「CO 开池范围」 | `firstAggressionOf` 遍历**全部街**找第一个加注，翻牌的下注命中 |
| **C2** | 「跟注」与「过牌」在范围似然上**完全同义** | 「翻/转都跟注」与「翻/转都过牌」的范围**逐位相同**（总变差 0、KL 0；熵 `8.938576941805767` 两者一致） | 权重只在 `bet/pot > 0.5` 时才区分，低级别常见的 1/3 池跟注被当作过牌 |
| **C3** | 范围**完全不随牌面变化** | 同花完成面上 38 个同花组合概率比 = **1.000000000**（`p(A♣Q♣)=p(A♠Q♠)`）；♣♣ 质量 5.64% 反而低于无同花可能的牌面 7.08% | 公共牌只被当「死牌」删组合，权重只看翻前牌型档 |

### 2.2 决策层的结构性缺口（P1 之前）

修复前「无人下注」时的**唯一**判据是 `equity > 0.55 且 档位 ≠ WEAK`，而
`BET` / `RAISE` 的 `ev` 恒为 `null`（「下注 EV 依赖弃牌率，本项目没有可信估计」）
⇒ **下注类动作永远不参与 EV 比较，分类永远是 MARGINAL**。
结果：「大量更差的牌会弃、大量更好的牌会跟、而我摊牌价值很高」这种
**显然该过牌**的局面，引擎照样下注 45% 底池。

### 2.3 第一轮对抗性审计（Agent A + B/C）发现的 6 项

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | `sizing.ts`：`SPR≤3 ⇒ ratio≥1` 是**悬崖**（SPR 3.0→1.0、3.1→0.20，3% 深度变化 ⇒ 4 倍跳变） | 连续函数（SPR 1→1.4、2→0.9、3→0.4、>3.8→0） |
| 2 | `SIZING_GRID` 含 1.25/1.5/2，而真实下注网格只有 ≤1 ⇒ 选中 >1 时引擎退化成「最大合法下注」 | 网格与 `buildSizeGrid` 对齐 |
| 3 | 我自造的**全下赔率公式** `R/(P+c+R)` 漏项，偏差在 `R≈c/3` **变号**（实测 `P=100,c=100,R=100,E=35%` 放行真实 EV −25 的全下） | **删除自造公式**，改用既有 `edge` + SPR 分档 |
| 4 | 「坚果/强价值」只看形状不看权益（任意葫芦 = 强度 1.0；单色面底三条 22% 权益 = 强价值 0.82） | 形状给上限、**权益给确认**，不足则降级 |
| 5 | 权益基线固定 0.5，而权益是**多人口径**（4 人池 40% 真实优势被判成弱） | 基线改为 `1/(人数+1)` |
| 6 | 🔴 **界面文案与行为相反**：画像压缩乘数不按可信度缩放 ⇒ 可信度 0 时画像仍改动作，同屏却打印「剥削偏移被缩放到 0」 | 乘数按可信度线性缩放（可信度 0 ⇒ 恒为 1）；主观画像再被 `EXPLOIT_CONFIDENCE_CAP`(0.35) 夹一次 |

另：**置信度改为按「动作族」比较**（第一版直接比前三名，而 `BET_SMALL = 0.95×BET_MEDIUM`
⇒ 只要下注最高就恒为 LOW，实测 `CLEAR_VALUE` 也是 LOW）。

### 2.4 第二轮对抗性审计（Agent E · Murphy · 9 类形态扫描）：4 项，其中 2 项 CRITICAL

**结论**：**防过度进攻方向成功**（湿面 / 强范围 / 听牌完成面 / 明显落后牌
全部正确收敛，多人惩罚单调正确），但**反方向出现系统性反向漏洞**：

| # | 审计实测反例 | 根因 | 修复 |
|---|---|---|---|
| **F-1** | 牌面 `K♠K♦6♣2♣9♣`、UTG 三条街全过牌、Hero BTN **A♣Q♣ 坚果同花**：权益 **94.7%**，同一份输出里 `worseCallDensity = 0.049` ⇒ `NOT_VALUE`、**引擎过牌** | 问题 1/2（「更差的牌会跟 / 更好的牌会继续」）**天生相对于我这手牌**，却被「他的范围整体多强」（`strongShare`）回答。成对牌面上每手都是「一对 K」⇒ `strongShare = 1.0000` 饱和 | 改用 `handEval.compareHands` **逐组合精确比较**（`weakerShare` / `strongerShare`） |
| **F-2** | 同牌面只换底牌：bet(4♣5♣ 最小同花 0.8800)=**0.2806** > bet(A♣Q♣ 坚果同花 0.9471)=**0.2300**；bet(K♥Q♥ 三条 K 0.8297)=0.2489 也更高 ⇒ **下注分对牌力非单调** | ① `valuePart` 分母固定 0.35，权益 ≥0.85 整段**饱和到 1**；② 负项由与我的牌无关的 `nutDensity`/`strengthFloor` 驱动；③ 保护分是纯加分项 | ① 分母改 `1 − 公平基线`；② 负项改用「比我更好的牌」占比（坚果自动 0 罚分）；③ 保护分加「后面还有没有牌发」前提 |
| **F-4** | 换街后价值无理由下降：K♦K♥ 超对 转牌 bet 0.3092 `CLEAR_VALUE` ⇒ 白板河牌 **0.0273 `NOT_VALUE`**；Q♥Q♦ 0.2901 ⇒ **0.0000** | 与 F-1/F-2 同源（街权重抬高 floor ⇒ 饱和加剧） | 同源修复 + `RIVER-1` 回归锁 |
| **F-5** | 河牌仍能拿到保护分（上限 0.15，与 0.06 的判定阈值同量级 ⇒ 可翻转薄价值：湿面 0.1057 `MARGINAL` vs 关保护 0.0143 `PREFER_CHECK`） | 保护收益定义为「让更差但有权益的牌弃牌」，而**河牌没有补牌** | 加 `hasCardsToCome`；河牌恒为 0；另补 `Number.isFinite` 守卫（`valueBetGate` / `sizing` / `boardWetnessOf`）|

**同一审计确认「无问题」的形态**：过度进攻（形态 2/6）、hero call（形态 3，偏保守）、
多人惩罚（形态 4，k=0..9 全单调）、干面过度保护（形态 5，`wet ≤ 0.17` 时保护分恒 0）、
小样本画像（形态 8，≤30 手 ⇒ 可信度 0 ⇒ 偏移逐位为 0）、数值边界（形态 9，可达路径无 NaN）。

### 2.5 修复前后实测对照（同一局面，只换底牌；审计原始复现局面）

| Hero | 权益 | 修复前 bet → check | 修复后 bet → check | 修复后判定 / 尺寸 |
|---|---|---|---|---|
| 9♥9♦ 第二坚果葫芦 | 0.9942 | 0.2787 / 0.6125 `NOT_VALUE` | **0.8122 / 0.2502** | `CLEAR_VALUE` / 75% |
| **A♣Q♣ 坚果同花** | 0.9471 | 0.2300 / 0.6125 `NOT_VALUE` | **0.7012 / 0.2466** | `CLEAR_VALUE` / 75% |
| Q♣J♣ 第三坚果同花 | 0.9136 | 0.2832 / 0.6125 `NOT_VALUE` | **0.6239 / 0.2441** | `CLEAR_VALUE` / 75% |
| 4♣5♣ 最小同花 | 0.8800 | 0.2806 / 0.6125 `NOT_VALUE` | **0.5480 / 0.2416** | `CLEAR_VALUE` / 75% |
| K♥Q♥ 三条 K | 0.8297 | 0.2489 / 0.5653 `NOT_VALUE` | **0.4379 / 0.2067** | `CLEAR_VALUE` / 75% |
| A♠A♥ 两对 AA | 0.7227 | 0.0906 / 0.2627 `PREFER_CHECK` | 0.2136 / 0.1637 | `MARGINAL` / 67% |

⇒ 下注分**严格随牌力单调**（修复前三条反例），坚果牌从「引擎过牌」变为
**「建议下注 75% 底池、置信度 HIGH」**（实机 `http://127.0.0.1:5173/` 实测输出见 §9.3）。

---

## 3. 新决策链（13 步，顺序不可颠倒）

```text
 1. Legal Actions            合法动作集合（既有 deriveLegalActions）
 2. Pot / Stack / SPR        底池、剩余筹码、SPR          → commitment.ts
 3. Hero Hand Role           相对牌力角色（10 类）          → relativeHandRole.ts
 4. Board Delta              这张牌改变了什么（12 个数值）  → boardDelta.ts
 5. Villain Range Compression 他的范围被压到什么程度         → rangeCompression.ts
 6. Multiway Adjustment      人数惩罚（强度/诈唬/门槛）      → multiway.ts
 7. Value / Bluff / Showdown 五问价值守门器                 → valueBetGate.ts
 8. Pot Odds / Fold Equity   底池赔率与权益优势（既有 math）
 9. Blockers                 阻断牌 / 非阻断牌              → blockers.ts
10. Player Profile Exploit   **最后**，且幅度受上限与可信度约束 → exploit.ts
11. Action EV comparison     动作比较分（启发式，非 solver EV）→ evScore.ts
12. Bet sizing               **独立一步**（动作与尺寸分离）   → sizing.ts
13. Confidence               「首选比次选好多少」            → evScore.ts
```

**两条硬纪律**：
1. **顺序不可颠倒** —— 画像永远在最后，且**不能覆盖硬数学**（`MATH_FOLD_DOMINANT` 不可翻转，红队已验证）。
2. **建议器不做动作决定** —— 它输出结构化建议与分数，真正的动作仍由 `decisionEngine`
   的 EV 判据产生（既有安全网保持不变）。`decideAlpha` **只算一次** advice，
   判据与 `diagnostics.postflop` 用的是**同一个对象**（防止「界面显示的」与「参与判断的」分歧）。

---

## 4. EV Guard 实现

**位置**：`src/domain/postflop/valueBetGate.ts`（五问）+ `multiway.ts` + `commitment.ts`

| 问题 | 字段 | 口径（修复后） |
|---|---|---|
| ① 有哪些**更差**的牌会跟？ | `worseCallDensity` | `weakShare × 黏度`，其中 `weakShare = P(他的牌比我差)`（**精确比较**）|
| ② 有哪些**更好**的牌会跟？ | `betterContinueDensity` | `strongerShare × (0.6 + 0.4 × 进攻可信度)` |
| ③ 更好的牌会不会**加注**？ | `raiseRisk` | `strongerShare × 0.7 + 可信度 × 0.15 − 湿润度 × 0.1` |
| ④ 过牌的**摊牌价值**？ | `showdownValue` | `0.5 × 角色强度 + 0.5 × 权益`（两者都随牌力单调） |
| ⑤ 下注是否**迫使更差但有权益的牌弃牌**？ | `protectionBenefit` | 只在「有听牌/高张」**且后面还有牌发**时存在；河牌恒为 0 |

**核心 +EV 规则（使用者给定，此处只调分数，绝不硬编码动作）**：

```text
摊牌价值高 + 更差牌跟注少 + 更好牌继续多  ⇒  下注 EV ↓、过牌 EV ↑
```

**分数构成**（`0..1` 启发式比较分，字段名与界面都标注「不是 solver EV」）：

```text
betScore   = valuePart × (0.5 + 0.5 × worseCallDensity)      ← 优势有多大 × 能不能兑现
           + bluffComponent × (0.5 − 多人诈唬惩罚)
           + protectionBenefit × 0.15                        ← 保护是真收益，但不是价值
           − betterContinueDensity × 0.35                    ← 被更强牌继续
           − raiseRisk × 0.2                                 ← 被加注
           + 画像薄价值/诈唬偏移（受上限与可信度约束）
checkScore = showdownValue × 0.35
           + (更差牌会跟 ? −0.15 × worseCallDensity : +0.1)  ← 对方愿意跟 ⇒ 过牌机会成本
           + (陷阱条件 ? +0.25 : 0)
```

`valuePart = clamp01((权益 − 1/(人数+1)) / (1 − 1/(人数+1)))` ——
**基线按人数走、分母与基线同源**（这是 F-2 的修复点：固定分母 0.35 会让权益 ≥0.85 整段饱和）。

**多方惩罚**（`multiwayAdjustment`，k=0..9 实测全单调非减）：
`multiwayStrengthPenalty` / `multiwayBluffPenalty` / `multiwayValueThresholdAdjustment`
三路同时抬高门槛并压低诈唬分；`equityThresholdShift` 对 `heroEquity` 与 `requiredEquity` 同减同加，无跳变。

**SPR / 承诺**（`commitment.ts`）：非有限 SPR 一律回落 `MEDIUM`（score 0、`stackOffAllowed=false`、cap 0.75）；
`COMMITTED` 时 `sizingCap` 提升，动作侧只在 `stackOffAllowed && (角色强度 ≥0.55 || (COMMITTED && 权益 − 门槛 ≥ 0))` 才放行加注。

---

## 5. Range Compression 实现

**位置**：`src/domain/postflop/rangeCompression.ts`

使用者点名的公式（显式结构式，不是拟合参数）：

```text
compressionFactor = f(betSize / pot, street, multiway, playerProfile, boardTexture)
```

| 变量 | 方向 | 实现 |
|---|---|---|
| 尺寸 / 底池 ↑ | 压缩 ↑ | `sizePart = min(1, ratio / 1.5)`，进攻性动作系数更高 |
| 街越靠后 | 压缩 ↑ | `STREET_WEIGHT: FLOP 1/3 → TURN 2/3 → RIVER 1`，乘 `(0.7 + 0.3 × streetPart)` |
| 人数 ↑ | 压缩 ↓ | `1 / (1 + 0.35 × (人数 − 1))` |
| 对手越松/越黏 | 压缩 ↓ | `profileCompressionMultiplier`（跟注站 0.7 … 极紧 1.25），**按可信度线性缩放** |
| 牌面越湿 | 压缩 ↓ | `1 − 0.3 × 湿润度` |

**状态量**（全部 `0..1` 启发式标尺，用于排序与阈值，**不是频率估计**）：

| 字段 | 修复后的口径 |
|---|---|
| `strengthFloor` | **只由弱尾质量驱动**（档 ≥4 的占比 × 压缩）：成对牌面上弱尾本来就接近 0 ⇒ 下限为 1，这是事实；但下游**不再**用它回答「有没有更差的牌」 |
| `nutDensity` | 强牌**占比**被压缩抬升后的值（占比用占比算） |
| `mediumStrengthDensity` / `drawDensity` / `airDensity` / `showdownDensity` | 由范围事实 + 压缩因子派生 |
| `aggressionCredibility` | 等于 `compressionFactor`（同样的动作，尺寸越大、街越靠后、人越少 ⇒ 越可信） |

**底层数据**（`src/app/manualInput/rangeFacts.ts`，只做**对已知范围的重新加权统计**）：

| 输出 | 定义 |
|---|---|
| `strongShare` / `topPairPlusShare` | 档 ≤2 的概率质量（**他的范围整体多强**） |
| `meanTier` | 概率加权平均档位（0 最强 .. 5 最弱） |
| `tierHistogram` | 档 0..5 的完整质量分布（弱尾只能从这里取） |
| `suitFit` / `drawShare` | 与牌面主导花色的贴合度 / 真听牌质量 |
| **`weakerShare` / `equalShare` / `strongerShare`** | **逐组合与我这手牌精确比大小**（`handEval.compareHands`，单一事实来源） |

⚠️ **没有任何「我觉得这张 A 帮到他了」式的猜测**，也没有引入新先验。

---

## 6. Board Delta 实现

**位置**：`src/domain/postflop/boardDelta.ts` —— 12 个**数值**字段（不是布尔开关）：

| 字段 | 含义 |
|---|---|
| `overcardImpact` | 新牌比原牌面高多少 |
| `flushCompleted` / `straightCompleted` | 这张牌让同花 / 顺子成为可能（0..1 强度，不是 `if`） |
| `pairedBoard` | 牌面是否成对 |
| `fourToStraight` / `fourToFlush` | 是否出现四张连/四张同花 |
| `nutShift` | 坚果归属是否转移 |
| `heroRelativeStrengthChange` | **我方**相对强度的变化 |
| `villainRangeImprovement` | **对手范围**与新牌面的适配度（由真实范围算出，无范围时为 `null`） |
| `heroRangeImprovement` | 我方范围的适配度 |
| `blankScore` | 白板度（0..1） |

🔴 **纪律**：这些字段**只进理由文案与诊断快照**，全项目**没有任何**
`if (同花完成) then check` / `if (A 出现) then 停止下注` 之类的分支（Agent A 已独立复核）。

---

## 7. Exploit 层实现（两层逻辑分离）

**位置**：`src/domain/postflop/exploit.ts` + `postflopAdvisor.ts:exploitSourceOf`

| 层 | 来源 | 可信度 | 能否覆盖硬数学 |
|---|---|---|---|
| **理论基线** | 底池赔率 / 权益 / 门槛 / SPR / 多人惩罚 | — | **它就是硬数学** |
| **真人 exploit** | ① 实测标签（`handsObserved > 0`）② 用户手选画像（**主观判断**） | ① `player.confidence` ② `min(EXPLOIT_CONFIDENCE_CAP=0.35, confidence)` | **不能**（`MATH_FOLD_DOMINANT` 与 ±5% 带优先） |

**约束**：
- 偏移上限 `EXPLOIT_MAX_DELTA = 0.12`，且**按可信度线性缩放**（可信度 0 ⇒ 偏移恒为 0）
- 主观画像的可信度**再夹一次** 0.35 —— 修复了「5 手实测样本的可信度 0.60 被用来放大
  主观画像」的漏洞
- 界面**分开显示**两个来源（`sourceZh` 明确写「实测标签（样本 N 手，可信度 x）」或
  「用户手选画像（主观判断，可信度上限 0.35）」）
- 压缩乘数同样按可信度缩放 ⇒ **可信度 0 时与无画像逐位相同**（Agent B/C 实测复核）

---

## 8. 新增测试数

| 文件 | 条数 | 锁什么 |
|---|---|---|
| `test/postflopRangeFoundation.test.ts` | 8 | C1/C2/C3（含 C3 的**判别性**修正：断言同点不同花的组合拿到不同档，而不是「权益变了」） |
| `test/postflopModules.test.ts` | 26 | 10 个模块的方向断言（角色 / Delta / 压缩 / 多人 / 承诺 / 守门器 / 阻断 / 尺寸 / EV 分数 / 剥削） |
| `test/postflopRegressionCases.test.ts` | 6 | 使用者点名的 TEST 1–6 |
| `test/postflopOutput.test.ts` | 5 | 快照完整性 / 无伪精确 EV / 置信度语义 / 界面可读性 / 面对下注也要给角色 |
| `test/postflopValueMonotonic.test.ts` | 8 | 第二轮审计的单调性与口径锁 |
| **合计** | **53** | |

**变异测试（证明这些断言不是摆设）**：把对应修复改回旧口径后，
`NUT-1` / `GATE-MONO-1` / `RIVER-1`（旧 `strongShare` 口径）与
`NUT-2`（旧 `nutAdvantage` 口径）、`P3-4`（未排序的偏好顺序）**全部立刻失败**；
恢复后 hash 与修复前**逐位一致**。

---

## 9. 全部测试结果

### 9.1 验收命令

```text
npm run verify  →  typecheck && manifest:check && test
```

| 项 | 结果 |
|---|---|
| 类型检查（`tsc --noEmit`） | **0 错误** |
| 产物清单（134 个产物 / 6 类） | **一致**（`artifact-manifest.json` 已重新生成） |
| 测试 | **1,625 项 / 137 套件 / 0 失败 / 0 跳过** |
| 历史基线回归 | 535 → … → 1,612 → 1,617 → **1,625**，**无一次放宽断言** |

### 9.2 未回归的既有约束（抽查）

- `alphaPipeline.test.ts`：翻牌 K72 顶对 vs 过牌 **必须 BET** ✅
- `alphaRedteamRegression`：翻牌暗三条面对下注 **必须 RAISE** ✅
- smoke 的 `forbiddenActions`：**永不弃掉**顶对/超对/暗三条 ✅
- 加注 ≤ 2.5 倍底池、全下建议 ≤ 15%、`CLEAR ⇒ 置信度 ≥ 0.45` ✅
- 画像一致性：`NORMAL ≡ UNKNOWN`（逐位相同）、`TILT ≤ UNKNOWN`、`MANIAC` 不改置信度 ✅
- 字段对齐：`interactiveTableDifferential` / `alphaWebServer` 的逐字段相等 ✅
- GTO 隔离：`decisionEngine.ts` 内**不出现** `gto` ✅
- 分层权益：`POT-D6..D10` 全绿（层额之和 ≡ `winnable`，±5% 带按 `winnable` 计）✅
- 翻前路径：建议器翻前返回 `null` ⇒ **翻前行为逐位不变** ✅

### 9.3 实机验证（`http://127.0.0.1:5173/`，修复后重启服务）

审计原始局面（Hero BTN A♣Q♣，牌面 K♠K♦6♣2♣9♣，UTG 三条街全过牌）：

```text
建议：下注 ｜ 5.63BB（563 筹码） ｜ 置信度：中低
  相对牌力角色：坚果级价值（NUT_VALUE，强度 1.00）
  牌面变化：同花成为可能、白板度 0.63
  对手范围压缩：强度下限 1.00、坚果密度 0.93、空气密度 0.18
  价值判断：CLEAR_VALUE（下注分 0.72 vs 过牌分 0.25）
  对手范围 vs 我的牌：更差 95.7%、更好 4.3%（更差的牌能跟注：是）
  摊牌 / 保护 / 诈唬潜力：0.98 / 0.00 / 0.22
  动作偏好顺序：BET_MEDIUM 0.72 > BET_SMALL 0.69 > BET_LARGE 0.64 > CHECK 0.25
  置信度（首选比次选好多少）：HIGH（差 0.476）
```

修复前同一局面是 **`NOT_VALUE` + 引擎过牌**。

---

## 10. 六个 Regression Case 逐局解释

| 用例 | 局面 | 要防的错误 | 断言方向（不锁数值） |
|---|---|---|---|
| **TEST 1** | 河牌三梅花，一对 J | 把一对 J 当成标准 50% 底池价值下注 | 必须倾向过牌，并明确说明「为何不是价值下注」（`VALUE_GATE` + 角色降级） |
| **TEST 2** | 对手连跟两街 ⇒ 河牌 KQ | 无理由开第三枪 | 角色必须降级（连跟两街 = 范围被压缩），且不得无理由下注 |
| **TEST 3** | 三人池 + 转牌高张 + 面对下注 | 不肯弃牌 | 弃牌必须是最高分动作，且多人惩罚必须生效 |
| **TEST 4** | 🔴 低 SPR 下 AA | **过度保守**（用一对机械控池、不敢全下） | 必须能全下（实测 RAISE 全下 134BB） |
| **TEST 5** | 🔴 跟注站 vs 紧手，薄价值 | 守门器把**所有**薄价值都 check 掉 | 跟注站面前下注分上升 + 尺寸放大；紧手面前收紧（两者必须**不同**） |
| **TEST 6** | 🔴 面对过度诈唬的对手 | 永久 overfold | 抓诈唬跟注必须提高；「不诈唬型」必须更低 |

每个用例都对照**同一局面下的另一种输入**断言**相对**行为 —— 即便以后调参，
只要方向还对，测试仍然有效。

---

## 11. 剩余风险（已知未修，如实记录）

| # | 风险 | 影响 | 评估 |
|---|---|---|---|
| 1 | `bluffCatchDelta` 只改**分数与理由**，不改动作 | 「不诈唬型 → 抓诈唬↓」目前无法翻转跟注 | 中：方向正确但力度不足；硬数学仍然优先（安全） |
| 2 | `hasInitiative` 在建议器里硬编码 `!facingBet` | 字段语义被架空 | 低：当前所有使用点都与语义一致 |
| 3 | `exploit.ts` 的 `drawCompleted` 参数与 `drawChaserNote` **无生产调用点** | 死代码 | 低：不影响行为，但会误导读者 |
| 4 | 相对比较是**当前 7 张牌的牌力**比较，天然忽略补牌质量 | 听牌落在「更差」一侧 ⇒ 听牌面的薄价值仍需权益项承担 | 低-中：与「更差的手会跟注」语义一致，但湿面薄价值偏保守 |
| 5 | `PlayerLabel.NORMAL ≡ UNKNOWN`（画像零效果） | 「正常玩家」标签不产生任何调整 | 低：符合「无证据不剥削」的纪律 |
| 6 | 无版本控制（项目未 `git init`） | 无法用 diff 审计本轮改动 | 中：建议尽快初始化仓库 |
| 7 | 缓存三键（`scenarioHash/treeId/cacheKey`）缺 golden-vector 测试 | 键碰撞会静默复用错误结果 | 中：与本轮无关，但属最高优先级遗留项 |
| 8 | 未做**真人牌局**验证 | 53 条新测试 + 变异测试证明的是「机制正确」，不是「长期 EV 更高」 | **高：这是唯一无法用测试替代的验证** |

---

## 12. 是否建议进入下一轮真人牌局测试

**建议：可以进入，但只按「受控抽样 + 逐局复盘」的方式，而不是直接全量使用。**

**理由**：

✅ **够用的部分**
1. 三个基础 CRITICAL（C1/C2/C3）都在**真实管线**上复现并修复，且各有独立回归锁；
2. 第二轮审计的 CRITICAL（坚果拒不下注、下注分非单调）已修，并有**变异测试**证明回归锁有效；
3. 硬数学优先级未被削弱：`MATH_FOLD_DOMINANT` 不可被画像覆盖，合法动作/尺寸/全下占比等既有红队约束全绿；
4. 翻前、手动输入、牌桌适配器、玩家画像、GTOpen 边界**零改动**，验收基线未被破坏；
5. 输出可解释：界面新增「对手范围 vs 我的牌（更差/更好）」与完整的 13 步诊断，
   **每一局都能复盘「引擎为什么这么想」**。

⚠️ **必须先做的三件事**
1. **记录 20–30 局真实牌局**（低级别现金局 / 朋友局），每局记录：位置、有效筹码、
   翻前动作、三条街的动作与尺寸、对手画像证据；重点覆盖：
   ① 成对/成花牌面上的强牌（F-1 的原始形态）；② 多人池薄价值；③ 空白河牌；
   ④ 低 SPR 承诺局面。
2. **逐局比对「引擎动作 vs 你的实际动作」**，只统计**方向性分歧**（该下注却过牌 /
   该弃却跟），并区分「引擎错」与「引擎对但我当时没这么打」——**不要**用结果
   （赢/输）判断决策质量。
3. **不要**在样本 < 30 局时调参：本轮已两次证明「看起来像调参问题」的其实是口径错位，
   在小样本上改数值只会把错误固化。

🔴 **不做的部分（明确划界）**
- 不把引擎当 solver：`estimatedBetEVScore` 等分数是 **0..1 启发式比较分，不是货币 EV**，
  界面已强制标注；请只用它做**排序与置信度**，不要换算成「这一注值 X 元」。
- 不在没有可靠画像证据（≥30 手）时依赖 exploit 层：可信度 0 时偏移恒为 0，这是**设计**不是缺陷。
- 不因为某一局的输赢修改策略：只接受**可复现的方向性**问题，并且必须带真实反例。
