# MULTIWAY POSTFLOP RESPONSE TREE PHASE 1 — REPORT

固定回归节点（使用者指定，**未修改**）：

```text
6-max｜盲注 1/2
翻前：UTG limp 2｜HJ limp 2｜CO limp 2｜Hero BTN K♠Q♠ Raise 到 16（8BB）
      HJ fold｜SB fold｜BB fold｜UTG call 14｜CO call 14
翻牌：J♦ 8♣ 4♥｜底池 53｜Hero 有效后手 164｜SPR ≈ 3.09
行动：UTG CHECK｜CO CHECK ⇒ 轮到 Hero（BTN）
画像：UTG = 松弱（LOOSE_PASSIVE）｜CO = 明显跟注站（CALLING_STATION）
```

旧输出（修复前）：`CHECK 7.0｜SMALL 22.2｜MEDIUM 26.9（选中，67% 池）｜LARGE 22.2`。

---

## A. 根因：旧版那个 64% 的 P(Fold) 到底是什么

**它是「首要对手一个人弃牌」的概率，被当成「整个多人池都弃牌」。**

| 项 | 旧版 | 事实 |
|---|---|---|
| 响应对象 | 每个尺寸**一组** `fold/call/raise` | 它由 `buildResponseModel` 对**首要对手**的范围逐组合分类得出；`opponentCount` 只被透传，`classifyResponse` 从不读它 |
| 弃牌分支 | `P(弃) × 底池` | 「拿下底池」要求 **所有对手同时弃牌**；2 家时该概率是连乘，不是一个人的 |
| 计算示例（本节点 67% 池） | 0.64 × 53 ≈ **33.9** | 真值 0.608 × 0.581 = **0.354** ⇒ 18.8（**差 15 个筹码**） |
| EqVsCall | 只有一个数（17.1%） | 「一家跟」与「两家都跟」是**两个不同的事件**，权益必须分开算 |

由此产生的连锁错误（每一条都在固定节点上实测到）：

1. 三人池只有一组响应 ⇒ §2/§3 无法回答「UTG 跟 / CO 跟 / 两家都跟」；
2. 弃牌分支被高估 ⇒ **BetEV 系统性偏高**（SMALL 22.2 → 修后 8.3，MEDIUM 26.9 → 修后 7.6）；
3. 多人池的有效筹码上限取的是 **primary opponent** 的剩余筹码（primary 恰好是深筹码时会放出「只有一个人跟得起」的注额）；
4. `EqVsCall` 单值 ⇒ 无法区分「一家跟」与「两家都跟」。

---

## B. 修改文件

| 文件 | 函数 / 位置 | 作用 |
|---|---|---|
| `src/domain/postflop/betResponse.ts` | `responseTendenciesOf` 之前新增 `jointStatesOf` / `composeMultiwayBetEV` / `JointModel` / `JointStateKind` / `MultiwayBetFacts` 等 | **联合状态树 + 多人 BetEV 公式**（纯函数、可独立测试） |
| 同上 | `classifyResponse` | 继续/弃牌改为**连续混频**（门槛附近按比例分流）：修掉「画像在响应层完全失效」与「尺寸饱和」两个同源缺陷；新增 `rawWeights`（封顶前） |
| 同上 | `buildResponseModel` / `SizeResponse` | 逐尺寸额外输出 `rawFold/Call/RaiseLikelihood`（尺寸弹性审计用，§14） |
| `src/domain/postflop/betResponse.ts` | `BetDecisionFacts.multiway` | 挂载 `debug.multiwayBetDecision` 的完整事实包 |
| `src/app/manualInput/contextBuilder.ts` | `buildBetDecisionFacts` | ① 收**完整对手列表**（每家一份范围 + 他自己的画像倾向 + 他自己的可信度）；② 每家**独立**建响应模型；③ 逐尺寸建联合状态；④ 逐分支算权益（含**真三人权益**）；⑤ 逐分支加权求 EV；⑥ 尺寸饱和审计 |
| 同上 | `rangeEquityOfMany`（新） / `rangeEquityOf` | 复用同一个权益引擎对**多份**条件范围求权益（「两家都跟」必须一次算完，不得取平均） |
| 同上 | `buildPreflopIsoFacts` 调用点 | 多人池的有效筹码上限改为**场上最短筹码** |
| `src/app/manualInput/manualInput.ts` | `ManualHandInput.seatProfiles` + 解析校验 | **逐座位画像**（`Partial<Record<Position, string>>`）；写错的位置/取值**阻断**而不是静默忽略 |
| `src/app/alphaPipeline.ts` | `hashManualInput` / `contextInput` | 逐座位画像进入输入哈希（否则「只改了 CO 的类型」追不到） |
| `src/app/decision/postflopAdvisor.ts` | `betDecision` 组装 | 有联合树时 `betEV = multiway.totalEV`，单挑旧值留在 `betEVSingleOpponent`（不参与决策） |
| `src/app/decision/decisionEngine.ts` | diagnostics | 新增 `multiwayBetDecision` |
| `src/viewmodels/decisionViewModel.ts` | `debug.multiwayBetDecision` | 逐对手响应 / 联合状态 / 条件权益 / 逐分支 EV / 总 EV / 饱和审计 / `primaryOpponentUsedForEV` |
| `test/multiwayBetResponse.test.ts` | 新增 T1–T8 | 见 §I |
| `scripts/multiway-mutations.ts` | 新增 M1–M8 | 见 §J |
| `scripts/review-hand-08.ts` | 固定节点输出 | §C–§G 的表格都来自它 |

---

## C. 固定 K♠Q♠ 节点新输出

```text
建议：BET｜尺寸 9BB（17.7 筹码 = 33% 池）｜置信度 0.30（MEDIUM_LOW）｜分类 MARGINAL
CHECK EV 7.01

尺寸         金额(筹码)  33%池    P(弃)   P(跟)   P(加)   EqVsCall   BetEV   分
BET_SMALL      17.7      33%     0.45    0.53    0.02    19.8%      8.33   0.512  ← 选中
BET_MEDIUM     35.3      67%     0.58    0.40    0.01    18.6%      7.59   0.505
BET_LARGE      53.0     100%     0.62    0.37    0.01    17.8%      4.20   0.473
```

- 与旧输出对比：`MEDIUM 26.9`（选中）→ `7.59`；选中项从 **67% 池**变成 **33% 池**。
- 变化**不是**靠硬编码 KQs：三个尺寸的 EV 全部由联合树逐分支算出（§G），
  且 `M7`（尺寸复用响应）与「硬编码 KQs」类改法都被测试/变异挡住。
- 注意 `CHECK EV = 7.01` 仍是**代理**（翻牌/转牌用权益实现因子，`HEURISTIC_ONE_STREET`），
  精度等级与 BetEV **不同**（§17 / §十六）。

---

## D. 每个对手独立响应（§2/§18）

| 尺寸 | UTG（松弱，414 组合） | CO（跟注站，414 组合） |
|---|---|---|
| SMALL 17.7 | 弃 **48.8%** / 跟 49.3% / 加 1.8%｜EqVsCall 19.6% | 弃 **44.9%** / 跟 **53.4%** / 加 1.8%｜EqVsCall 20.0% |
| MEDIUM 35.3 | 弃 60.8% / 跟 37.6% / 加 1.5%｜EqVsCall 18.2% | 弃 58.1% / 跟 40.4% / 加 1.4%｜EqVsCall 18.9% |
| LARGE 53.0 | 弃 66.9% / 跟 31.9% / 加 1.2%｜EqVsCall 17.3% | 弃 62.1% / 跟 36.7% / 加 1.2%｜EqVsCall 18.0% |

- 两位对手**各有自己的对象**（分别建 `buildResponseModel`，画像取 `seatProfiles` 里**他自己**的那一条）；
- 每位对手三概率和 = 1（T1 锁定）；
- 尺寸弹性 `P(弃)` 逐档变化：UTG `[0, +0.120, +0.060]`、CO `[0, +0.133, +0.040]` —— **非零且有差异**。

---

## E. 联合状态概率（§3/§11）

```text
                     ALL_FOLD   UTG_ONLY   CO_ONLY   ALL_CALL   ANY_RAISE   Σ
SMALL  (17.7)          21.9%      22.1%     26.1%     26.3%       3.6%     1.0000
MEDIUM (35.3)          35.4%      21.9%     24.6%     15.2%       2.9%     1.0000
LARGE  (53.0)          41.5%      19.8%     24.6%     11.7%       2.4%     1.0000
```

- `ALL_FOLD` = `P(弃_UTG) × P(弃_CO)`（实测 0.354 = 0.608 × 0.581 ✓ 连乘）；
- `jointModel = CONDITIONAL_INDEPENDENCE`＋`HEURISTIC_INDEPENDENCE_ASSUMPTION` 在 debug 与理由里都写明；
- `ANY_RAISE` = `1 − Π P(弃或跟)`（聚合分支，完整再加注树未实现）；
- 概率和 = 1（有测试锁；出现负余量时**拒绝输出**而不是给一张自相矛盾的表）。

---

## F. 各条件范围权益（§5/§6）

| 尺寸 | Eq vs UTG-only-call | Eq vs CO-only-call | Eq vs both-call（**真三人**） | Eq vs raise |
|---|---|---|---|---|
| SMALL | 19.6% | 20.0% | **14.0%** | 3.2% |
| MEDIUM | 18.2% | 18.9% | **12.5%** | 3.2% |
| LARGE | 17.3% | 18.0% | **11.9%** | 3.2% |

- 「两家都跟」由 `computeEquity` 一次对**两份条件范围**求出，**不是**两次单挑的平均/最小值；
  T4 断言 `EqBothCall ≤ max(单挑权益)` 且 ≠ 两者平均；
- 加注分支权益只用 `P(加注)` 加权的**混合范围**（谁加注未区分 —— 如实标注为聚合）。

---

## G. 每个分支的 EV 与总 EV（可逐项复算）

`BET_SMALL`（我投入 17.7）：

| 分支 | p | 权益 | 实现后 | 底池 | 我投入 | EV | 贡献 |
|---|---|---|---|---|---|---|---|
| ALL_FOLD | 21.9% | — | — | 53.0 | 0 | **+53.00** | +11.61 |
| UTG_ONLY_CALL | 22.1% | 19.6% | 16.7% | 88.3 | 17.7 | −2.93 | −0.65 |
| CO_ONLY_CALL | 26.1% | 20.0% | 17.1% | 88.3 | 17.7 | −2.57 | −0.67 |
| ALL_CALL | 26.3% | 14.0% | 11.9% | 106.0 | 17.7 | −5.05 | −1.33 |
| ANY_RAISE | 3.6% | 3.2% | — | 70.7 | 17.7 | −17.67 | −0.64 |
| **总计** | | | | | | | **8.33** |

`BET_MEDIUM`（我投入 35.3）：`ALL_FOLD 35.4%×53 = +18.76`；`UTG 21.9%×(−16.14)`；`CO 24.6%×(−15.45)`；
`ALL_CALL 15.2%×(−18.33)`；`ANY_RAISE 2.9%×(−35.33)` ⇒ **7.59**。

`BET_LARGE`（我投入 53.0）：`41.5%×53 = +22.00`；`19.8%×(−29.57)`；`24.6%×(−28.54)`；
`11.7%×(−31.39)`；`2.4%×(−53.00)` ⇒ **4.20**。

公式（与实现逐条对应）：

```text
EV_allFold = 当前底池（下注额收回，不扣成本）
EV_jCall   = eq_j × (底池 + 2B) × 实现率 − B          ← j 的投入进入底池（§9）
EV_allCall = eq_all × (底池 + (N+1)B) × 实现率 − B     ← 真多人权益
EV_raise   = −B（Hero 放弃）                          ← 下界，RAISE_RESPONSE = HEURISTIC
BetEV      = Σ p × EV（同一零点 = 当前决策点）
Hero 下注成本 **每个分支只扣一次**（T1 逐分支复算锁定）
```

`EqVsArrivalRange`（16.3%）**没有**参与任何分支 —— 到达范围权益只作对照。

---

## H. Size saturation 审计（§14/§15）

**修前**：`MEDIUM 67%` 与 `LARGE 100%` 给出**逐位相同**的 `0.64 / 0.35 / 0.01`。
**根因不是 clamp，是分类的量化死区**：

```text
继续指数 continueIndex = (strengthScore + playability) × callScale − 0.05 × foldScale
strengthScore 只有 6 档：0.15 + 0.6×(1 − tier/5)，相邻档差 ≈ 0.12
门槛 requiredWithMargin = 价格 + 余量(0.16 − 0.06×街压)
```

67% 与 100% 的价格分别是 0.286 / 0.333，两个门槛（0.386 / 0.433）落在**同一档牌力**的同一侧 ⇒
逐组合分类结果完全相同。同一个死区还导致**画像在响应层完全失效**（跟注站与普通玩家的
弃/跟/加概率**逐位相同**：`0.34743787553756983` vs `0.34743787553756983`）。

**修复**：门槛附近按**连续混频**分流，窗口宽度 = 既有余量（不是新参数）：

```text
继续比例 = clamp01( (continueIndex − 门槛) / (2×余量) + 0.5 )
```

**修后**：`sizeSaturation.status = DISTINCT_RESPONSES`，两档的 `P(弃)` 从「逐位相同」变成
**0.45 / 0.58 / 0.62**（单调、且由各自价格算出）；`rawFold/Call/RaiseLikelihood`（封顶前）与
`foldElasticityVsPrevious` 都在 debug 里；`SIZE_RESPONSE_CLAMPED` 类情形现在只可能出现在
**同一合法金额**上（已被去重），若两个不同注额给出相同响应，测试直接判红（T6 + M7）。

> ⚠️ 没有为了让两档不同而人为调任何阈值：分开它们的是**价格本身**（这是真实模型结果，§15）。

---

## I. 全量验证（`npm run verify`）

```text
TypeScript：0 错误
产物清单：与文件系统逐位一致（150 个产物）
测试：1736 项 / 137 套件 / 0 失败
```

**旧测试的处理（未删除、未放宽）**——两处必须说明，因为它们都是**真实冲突**：

| 位置 | 旧断言 | 处理 |
|---|---|---|
| `test/betDecisionEngine.test.ts` T3 | 「全下尺寸的跟注桶组合数 ≥ 小注尺寸的跟注桶组合数」 | 该不等式只在**硬切分类**下偶然成立（两个尺寸价格不同 ⇒ 继续集合本来就不同）。改为**同尺寸、同组合**的直接检验：强牌在全下时 `raise = 0`、加注权重**迁移到跟注**、`弃+跟 = 1`；权益断言保留并改为方向 + 量级（跟注范围是到达范围的继续子集 ⇒ `EqVsCall ≤ 到达 + 0.05`，且不得崩到只剩坚果） |
| `test/postflopRegressionCases.test.ts` TEST 5 | 「跟注站的价值尺寸 ≥ 紧手」 | 实测两个尺寸的 BetEV 只差 **0.4%**（268.7 vs 267.6 筹码）⇒ 方向由两位小数决定，断言方向等于断言噪声。保留「画像必须真的改变尺寸」，并**新增更强**的机制断言：`EqVsCall(跟注站) > EqVsCall(紧手)`（跟注站用更差的牌跟）。方向性结论留待 EV 面审计 |

两处都**新增了断言**而不是删掉要求；具体数字与理由写在上面的表格里，可复核。

---

## J. 变异测试（M1–M8，全部必须变红）

`scripts/multiway-mutations.ts`：精确字面替换 → 跑 `test/multiwayBetResponse.test.ts` → 立刻还原（末尾逐字节校验）。

| 变异 | 内容 | 结果 | 捕获者 |
|---|---|---|---|
| M1 | `allFold` 改成「平均弃牌率」 | ✅ | T1 / T2 / T3 |
| M2 | 多人 EV 由 primary opponent 一个人决定 | ✅ | T1 / T2 / T3 |
| M3 | 两个对手共用同一份响应对象 | ✅ | T7 |
| M4 | `BOTH_CALL` 权益改成两次单挑权益平均 | ✅ | T4 |
| M5 | 忽略 `ANY_RAISE` 分支 | ✅ | T1 / T8 |
| M6 | Hero 下注成本每个分支扣两次 | ✅ | T1（逐分支复算） |
| M7 | 三个尺寸共用同一份响应（按最小尺寸价格分类） | ✅ | T6（价格不同却响应相同 ⇒ 判红） |
| M8 | 逐座位画像不再影响**他自己**的响应 | ✅ | T2 / T7 |

```text
变异捕获：8/8｜源文件已恢复且逐字节一致：是
```

---

## 诚实声明（本轮**没有**做到的事）

1. **`ANY_RAISE` 只是下界**：完整再加注树（谁加注 → Hero 跟/弃/再加 → 其他人再响应）未实现，
   `EV_raise = −B`，标注 `RAISE_RESPONSE = HEURISTIC`、`evKind = MODEL_EV_WITH_HEURISTIC_RAISE_BRANCH`。
2. **联合模型是条件独立假设**（`HEURISTIC_INDEPENDENCE_ASSUMPTION`）：真实牌局里两人响应正相关。
   修掉的是「结构错误」（用单对手概率冒充联合概率），不是相关性建模。
3. **`CHECK EV` 仍是单对手代理**（`HEURISTIC_ONE_STREET`，翻牌/转牌用权益实现因子），
   没有升级为多人 CHECK 树 —— 精度等级与 BetEV 不同，已在输出里分开标注（§十六）。
4. **多人权益只对「全部跟注」这一支真算多人**；`PARTIAL_CALLS`（≥3 家才出现）用 k=2 的下界近似。
5. **画像可信度上限仍是 0.35**（用户主观判断），因此跟注站与松弱的差异是几个百分点量级，
   不是「跟注站跟注率 80%」那种强断言。
6. **RAKE 仍然 NOT_IMPLEMENTED**。
7. `seatProfiles` 是**新增输入能力**：只支持手动录入路径（牌桌 UI 的逐座位画像录入未接）。

---

## 验收建议

固定 BTN K♠Q♠ / J♦8♣4♥ 三人池节点请重新验收，重点：

1. `debug.multiwayBetDecision`：逐对手响应（UTG vs CO **必须不同**）、联合状态（Σ=1）、
   条件权益（「两家都跟」显著低于单挑）、逐分支 EV 与总 EV；
2. 首屏建议从 `BET 67%` 变为 `BET 33%` —— 看这个尺寸是否符合你的实战判断；
3. 若你判定仍不对，请指出**哪一项数字**与预期不符（例如「跟注站 33% 池不该弃 45%」），
   我按根因改模型，不用阈值凑结果。
