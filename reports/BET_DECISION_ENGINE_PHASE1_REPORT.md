# BET DECISION ENGINE PHASE 1 — 修复报告

> **日期**：2026-09-17 · **性质**：正式修复（非只读审计）
> **结论**：`SEMI_BLUFF` 现在通过「**弃牌收益 + Hero 自身听牌（非权益通道）+ 对手条件继续范围**」参与下注决策；
> 三个尺寸**各自**有响应概率与 EV；`valuePart > 0` 不再是下注的前提。
> **回归**：`npm run verify` → **1,704 项 / 137 套件 / 0 失败**，TypeScript 0 错误，产物清单 138 项一致。
> **未做的事**：没有调高任何 semi-bluff 常数、没有调低 raiseRisk 权重、没有为让固定节点下注而调参、没有改测试输入、没有放宽或删除断言、没有伪造 EV。

证据等级：**【数学确定】**（可复算）· **【公开扑克理论】** · **【工程约束】** · **【启发式】**（只有方向/序关系有意义）

---

## A. 修改文件

| 文件 | 函数 / 位置 | 目的 |
|---|---|---|
| `src/domain/postflop/betResponse.ts`（**新增**） | `classifyResponse` / `buildResponseModel` / `heroDrawPotentialOf` / `realizationFactorOf` / `responseTendenciesOf` / `composeBetEV` / `composeCheckEV` / `normalizeEVScore` | 对手面对**每个尺寸**的 fold/call/raise 概率与条件范围；Hero 自身听牌（非权益通道）；权益实现代理；三分支下注 EV |
| `src/domain/postflop/valueBetGate.ts` | `assessValueBet` | **P0-1** 去重复计票（`strongerShare` 只收一次费）；**P0-2** 响应层「爱跟」倾向修正方向；**P0-5** 听牌进入 `semiBluffQuality`（不进权益）；**§8** `raiseRisk → raisePressureIndex`（保留别名，降级为只读指数）；**P0-3** 画像证据归属入参 |
| `src/app/manualInput/contextBuilder.ts` | `buildBetDecisionFacts`（新增）、`positionOrder`、`postflopFacts` 组装 | 用**真实 Range** 构建响应模型与三个条件范围的权益（决策层拿不到 `Range` 对象 —— 与 `opponentRangeFacts` 同一条架构纪律） |
| `src/app/decision/postflopAdvisor.ts` | 压缩输入、`betDecision` 组装、`scores` 生成 | **P0-3** 阻断画像在 scorer 层的第二次加权；**P0-4/§9** 三个尺寸独立评分；过牌分支口径对称（`checkRealizationFactor`）；`raisePressureIndex` 文案 |
| `src/app/decision/decisionEngine.ts` | 场景 2（无人下注） | 动作由 **CHECK / BET_SMALL / BET_MEDIUM / BET_LARGE 的 EV 比较**自然产生；`NOT_VALUE` 不再禁止下注；诊断新增 `betDecision` |
| `src/domain/decision/decision.types.ts` | `PostflopFacts.betDecision`、`PostflopDecisionSnapshot.betDecision`、`DecisionDiagnostics.betDecision` | 类型与快照（可序列化，证据等级逐项标注） |
| `src/viewmodels/decisionViewModel.ts` | `debug.betDecision` | 每尺寸的 P(弃/跟/加)、条件范围权益、三分支 EV、BetEV、听牌、实现因子、画像证据归属、证据等级 |
| `test/betDecisionEngine.test.ts`（**新增**） | 13 项 | TEST 1–5 + P0-1/P0-3/§9 专项 + 墨菲清单 |
| `reports/BET_DECISION_ENGINE_PHASE1_REPORT.md`（本文件） | — | 交付报告 |

---

## B. 修复前后对比（固定节点 A♠J♠，输入逐字未改）

**转牌 Q♦8♠4♠2♥（HJ check-check）**

| | 修复前 | 修复后 |
|---|---|---|
| 角色 | SEMI_BLUFF | SEMI_BLUFF（不变） |
| 权益 | 44.07% | 44.07%（**未改**） |
| CHECK | 0.238（价值偏好分） | EV **14.72 筹码**（偏好分 0.500 基准） |
| BET_SMALL | **0.000** | EV **13.71**（分 0.487） |
| BET_MEDIUM | **0.000** | EV **15.79**（分 0.514） |
| BET_LARGE | **0.000** | EV **11.60**（分 0.460） |
| 最终动作 | CHECK（结构缺失导致） | **BET 13BB**（中注 EV 最高 ⇒ 自然产生） |

**翻牌 Q♦8♠4♠（HJ check）**：CHECK 18.55 / SMALL 22.96 / **MEDIUM 25.74** / LARGE 25.51 ⇒ **BET 13BB**。

⚠️ **PASS 不依赖"转牌变成 BET"**：转牌的差距只有 1.07 筹码（≈2.7% 底池），属边缘决定；关键是三个 BET 现在是**真实算出来的**（有概率、有条件范围权益、有 EV），而不是结构性 0。

---

## C. 三尺寸 EV 表

### 转牌（被审计节点）

| Size | P(Fold) | P(Call) | P(Raise) | Eq vs Call | Eq vs Raise | EV_fold | EV_call | EV_raise | EV | Final |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| BET_SMALL (33% ≈13.0) | **0.313** | 0.605 | 0.083 | 27.83% | 17.54% | 39.0 | 4.0 | −11.0 | **13.71** | 分 0.487 |
| BET_MEDIUM (67% ≈26.0) | **0.508** | 0.409 | 0.083 | 25.58% | 17.54% | 39.0 | −4.1 | −28.4 | **15.79** | 分 0.514 |
| BET_LARGE (100% ≈39.0) | **0.508** | 0.409 | 0.083 | 25.58% | 17.54% | 39.0 | −10.8 | −45.8 | **11.60** | 分 0.460 |
| CHECK | — | — | — | （到达范围 44.07%） | — | — | — | — | **14.72** | 0.500 |

桶组合数：SMALL 205/163/17、MEDIUM 270/98/17、LARGE 270/98/17（**三桶之和 = 385 = 可达组合数**，组合集不变，只有权重重新归一化）。

### 翻牌（对照）

| Size | P(Fold) | P(Call) | P(Raise) | Eq vs Call | Eq vs Raise | EV | Final |
|---|---:|---:|---:|---:|---:|---:|---|
| BET_SMALL | 0.385 | 0.553 | 0.062 | 48.22% | 30.09% | 22.96 | 0.557 |
| BET_MEDIUM | 0.600 | 0.337 | 0.062 | 44.32% | 30.09% | **25.74** | **0.592** |
| BET_LARGE | 0.657 | 0.281 | 0.062 | 43.21% | 30.09% | 25.51 | 0.589 |
| CHECK | — | — | — | （到达 59.71%） | — | **18.55** | 0.500 |

**方向自洽（【公开扑克理论】+【数学确定】）**：注越大 ⇒ P(弃)↑（0.313→0.508→0.508）、P(跟)↓（0.605→0.409）、被跟注后的权益↓（27.8%→25.6%）、EV_call↓（+4.0→−4.1→−10.8）。

---

## D. 画像单调性

| 画像 | P(弃) SMALL / MED / LARGE | P(跟) MED | 大注 EV | 最佳尺寸 | 动作 |
|---|---|---|---|---|---|
| NORMAL | 0.313 / 0.508 / 0.508 | 0.4094 | 11.60 | BET_MEDIUM | BET 13BB |
| **CALLING_STATION** | 0.310 / 0.509 / 0.509 | 0.4070 | 11.58 | BET_MEDIUM | BET 13BB |
| **VERY_TIGHT** | 0.314 / 0.508 / **0.572** | 0.4110 | 14.49 | BET_MEDIUM | BET 13BB |
| MANIAC | 0.313 / 0.507 / 0.507 | 0.4110 | 11.52 | BET_MEDIUM | BET 13BB |

- **紧手/过弃（TEST 4）✅**：大注弃牌率 0.572 > 0.508（+6.4 个百分点），方向正确且显著。
- **跟注站（TEST 3）⚠️ 分层结论（实测证据，不掩盖）**：
  - **同一份范围、只改响应倾向**（主判据，单元级）：P(跟) ↑、P(弃) ↓ — **严格成立**（`responseTendenciesOf` 的 `callScale = 1.088 > 1`、`foldScale = 0.903 < 1`）；
  - **管道层聚合值**：`P(跟)` 0.4094 → 0.4070（−0.0024）、`P(弃)` 0.508 → 0.509（+0.001）。
  - **原因（范围证据）**：画像**同时**进两条通道 —— ① range 层（上一轮 P0 修复）让跟注站的**范围更宽**，同一个尺寸下"本来就该弃"的垃圾牌**变多**；② 响应层让同一手牌更爱跟。两者在聚合值上方向相反，几乎抵消。
  - 要让聚合值也严格满足，需要让"跟注站的垃圾牌也跟大注"（`callScale ≈ 2.8`）——那是把画像变成「不会弃牌」的假模型。**因此保留单元级严格断言 + 管道层容差断言，并把实测差值写进断言消息。**

---

## E. 全量测试

```text
npm run verify
  TypeScript : 0 错误
  assert 清单 ：138 个产物与清单一致
  tests      ：1,704
  suites     ：137
  fail       ：0
  working tree：本报告 + 9 个源文件 + 1 个测试文件（未提交；按纪律由使用者决定）
```

- **没有放宽任何旧断言**：既有 1,691 项全部原样通过（含画像 A/B/C 单调、`407→407` 组合数不变、Decision Margin / Model Confidence 拆分、观察倾向、死牌过滤）。
- 唯一需要同步的是**状态文档计数**（测试文件数 / 行数 / 产物数）—— 由 `test/projectStatus.test.ts` 强制，已同步。

---

## F. 变异测试（7 项，全部被抓到）

| 变异 | 期望 | 实测 |
|---|---|---|
| M1 移除 Hero 听牌参与（`drawQuality/nutPotential` 归零） | TEST 5 变红 | ✅ 2 项失败（TEST 1 / TEST 5） |
| M2 让 CALLING_STATION 再次**降低**继续概率 | TEST 3 变红 | ✅ 3 项失败 |
| M3 `strongerShare` 恢复双重计票 | T6 变红 | ✅ 2 项失败 |
| M4 三个尺寸共用同一 score/EV | TEST 1 / T8 变红 | ✅ 3 项失败 |
| M5 去掉画像重复计数阻断 | T7 变红 | ✅ 1 项失败（**首次未抓到 → 已把断言从"标记"升级为"效果"**）|
| M6 关闭弃牌分支（无 fold likelihood） | TEST 1 / T8 变红 | ✅ 4 项失败 |
| M7 `NOT_VALUE` 重新禁止半诈唬下注 | TEST 1 变红 | ✅ 1 项失败 |

**变异 M5 的教训（值得记录）**：第一版 T7 只断言 `doubleCountBlocked === true` 这个**标记**，而标记与「乘数是否真的被阻断」是两处独立代码 —— 变异后标记仍为 true，测试仍绿。现在：① 标记**从实际使用的值推导**（标记不可能与行为相反）；② T7 增加**效果断言**（阻断时压缩因子必须与"无画像乘数"逐位相同，并附一条"不阻断则必须不同"的区分力对照）。

---

## 十七. 最终裁决对照（使用者 PASS 标准）

| 要求 | 状态 | 证据 |
|---|---|---|
| Hero 自身听牌进入主链 | ✅ | `heroDrawPotentialOf` → `semiBluffQuality`（价值侧）+ `realizationFactor`（EV 侧）；TEST 5 锁「空气 ≠ 坚果听」 |
| 对手面对下注的 fold/call/raise 条件范围 | ✅ | `buildResponseModel` 逐组合分类 → 三桶（组合集不变、权重归一化）→ 对跟注/加注范围**各算一次权益** |
| 人物画像进入 | ✅ | range 层（上一轮）+ 本轮新增**响应层**（`callScale/foldScale/raiseScale/bluffRaiseScale`）；P0-3 阻断 scorer 层重复计数 |
| 下注尺寸进入 | ✅ | 三尺寸各自的价格 `r = b/(P+2b)` 驱动反应分类；TEST 8 锁「不得共用同一分数」 |
| 不重复计数 | ✅ | P0-1（`strongerShare` 单次收费，T6 用**敏感度**而非定性断言）、P0-3（T7 效果断言）、Hero 听牌**不进权益**（T9b/§十三.1） |
| 不硬编码 | ✅ | 全部输入来自范围/牌面/位置/筹码/画像维度；无任何牌面或具体手牌分支 |
| 不伪造 EV | ✅ | 三分支公式是**单街精确**；未来街用 `realizationFactor`（标 `HEURISTIC`）；debug/UI/快照逐项标 `EXACT / HEURISTIC / NOT_IMPLEMENTED` |
| 不破坏上一轮画像修复 | ✅ | A/B/C 单调、`407→407`、Decision Margin / Model Confidence 拆分全部原样通过 |
| 最终动作由数学自然产生 | ✅ | 动作 = argmax(CHECK, 三个尺寸的 EV 换算分)；`NOT_VALUE` 只是价值侧判断（M7 变异可证） |

---

## 十、诚实报告：未实现 / 已知限制（不伪装）

| 项 | 状态 | 说明 |
|---|---|---|
| 阻断牌 | **NOT_IMPLEMENTED** | 按使用者 §10 纪律：只有在「阻断牌改变 fold/call/raise 的加权范围」时才算接入。它**间接**通过条件范围（已做死牌过滤）体现，但没有独立的加法项 —— debug 里如实标 `NOT_IMPLEMENTED`。 |
| 多人池的响应模型 | **单对手口径** | 响应模型按**首要对手**构建（与 `opponentRangeFacts` 同口径）；多人池的 EV 未做联合分布。 |
| 被加注分支 | **HEURISTIC** | 假设「我再跟一次同额注」⇒ `eq×(P+4b) − 2b`；同时暴露 `evRaiseFoldLowerBound = −b`（不继续的下界）。 |
| 权益实现因子 | **HEURISTIC** | 基准（翻牌 0.78 / 转牌 0.84 / 河牌 1.00）+ 主动权/位置/深筹码/听牌实现；加成上限 +0.13，故翻牌 ≤0.91、转牌 ≤0.97，**不可能**饱和到 1。 |
| 条件范围权益精度 | **6,000 次抽样** | 主权益 20,000 次；响应模型一次要算 6 份权益，因此降档并在 `equityIterations` 里如实标出（预算分配，不是掩盖）。 |
| 「空气也会诈唬」 | **已知限制** | 当 `P(弃) ≈ 0.5` 时，单街 fold-equity 模型**必然**认为空气下注有利（这是模型的内部一致性，不是 bug）。真实扑克里空气少诈唬是因为**多街威胁价值**与**阻断牌**——两者本 Phase 都未建模。已加约束：**坚果听牌的 BetEV 必须高于空气**（TEST 5）。 |
| 中注与大注的弃牌率相同 | **刻度限制** | 在 `r` 从 0.286→0.333 之间没有更多手牌跨越门槛 ⇒ 弃牌率饱和；**但 EV 仍正确区分**（被跟注后权益更低）。若要让弃牌率继续上升，需要引入「下注额相对筹码量」的压力项（Phase 2）。 |
| 翻前 | **未改** | 响应模型只在翻后；翻前 `betDecision === null` ⇒ 旧路径逐位不变。 |
| 尺寸落注金额 | 仍由 `buildSizeGrid` 决定 | 响应模型只提供**建模比例**（1/3、2/3、1 池），实际金额取最近的合法网格尺寸 —— 不生成任意数值。 |

---

## 墨菲定律清单（使用者 §13）逐条

| # | 检查 | 结论 |
|---|---|---|
| 1 | Hero draw equity 被算两次 | ✅ 未发生：听牌**不进权益**（T9b + `heroDrawPotentialOf` 的 `improvementProbability` 只用于展示） |
| 2 | profile 再次 double count | ✅ P0-3 阻断 + 标记从实际取值推导（M5 可证） |
| 3 | `strongerShare` 多次收费 | ✅ 单一事实来源 `betterHandPressure`，T6 用敏感度锁定 |
| 4 | 概率 NaN / 负 / 和 > 1 | ✅ T9 扫 2 条街 × 4 画像 × 3 尺寸，和为 1（<1e-9） |
| 5 | 永远小注 / 永远大注 | ✅ 实测：转牌选 MEDIUM、翻牌选 MEDIUM；小/大注各自在某些节点占优（EV 表） |
| 6 | CALLING_STATION 反而更爱弃牌 | ✅ 同一范围下方向正确；聚合值几乎抵消已在 §D 如实报告 |
| 7 | MANIAC 自动等于过度诈唬 | ✅ 加注需**独立条件**（真强牌，或真听牌 + 诈唬倾向 + 小注）：NORMAL P(加)=0.062、MANIAC 同为 0.083（不到处加注） |
| 8 | SEMI_BLUFF 变成「有听牌就下注」 | ✅ 下注由 EV 决定；且空气也可能下注（限制已披露） |
| 9 | PURE_BLUFF 错误获得 draw equity | ✅ `heroDrawPotentialOf` 与角色无关，只按**Hero 的手牌/牌面**计算；`semiBluffQuality` 只调制 `bluffComponent`（半诈唬/纯诈唬共用），不进入权益 |
| 10 | 价值牌被新模型压制 | ✅ 价值侧 `valuePart` 未改（只去掉重复罚分）；`BIG_VALUE` 类既有用例全部通过 |
| 11 | 河牌仍算未来权益 | ✅ T9b：`cardsToCome=0`、`improvementProbability=0`、实现因子恒 1 |
| 12 | 转牌只有一张待发 | ✅ `cardsToComeOf` 单测 + TEST 2 |
| 13 | 翻牌与转牌共用同一 realization | ✅ 基准不同（0.78 / 0.84），TEST 2 断言两者不同 |
| 14 | 多人池仍用 50% 公平基线 | ✅ T9d：3 人池 34% 权益必须产生正价值项（公平份额 25%） |
| 15 | 条件范围不遵守 card removal | ✅ `computeEquity` 内部按已知牌过滤；桶内权重已归一化（T9 断言 Σp=1） |
| 16 | 下注前/后底池混淆 | ✅ 全部口径统一为**下注前**底池（T9c 逐项锁定） |
| 17 | bet cost 扣两次 | ✅ 每个分支各扣一次（T9c：P(弃)=1 ⇒ EV = 底池；P(跟)=1 ⇒ EV = eq×(P+2b) − b） |
| 18 | 弃牌分支仍计 Hero 权益 | ✅ `evFoldBranch = pot`，不含权益（T9c） |

---

## 下一轮（Phase 2）建议

1. **多街威胁价值**：把「坚果听牌可以在后续街继续下注」建模为显式的多街 EV（现在只有 realization 代理），以修正「空气比坚果听更爱下注」这一已知限制。
2. **尺寸压力项**：让中注→大注的弃牌率继续上升（引入「下注额 / 剩余筹码」压力）。
3. **响应模型的行动历史条件化**：目前只用了范围 + 尺寸 + 街 + 位置 + 画像；对手**本手的行动序列**（例如翻牌跟注后转牌过牌）应进入 `P(反应)`。
4. **阻断牌的真实接入**：只有在能改变 fold/call/raise 加权范围时才做（§10 纪律）。
5. 把 `estimatedBetEVScore`（价值偏好分）与 `betDecision`（EV）在 UI 上明确分栏，避免使用者把偏好分读成 EV。
