# 优先级修复报告（P0–P4）

**验收**：`npm run verify` ⇒ **exit 0，2,323 / 2,323 通过**（每项改完都重跑全量）
**日志**：`reports/_verify_after_priority_fixes.log`

| 项 | 内容 | 状态 |
|---|---|---|
| **P0** | 决策尾延迟 | **step1 已优化（−14% wall）；step2 已把剩余 991ms 拆开：98% = 16 次分桶权益**；下一步范围已缩到「先补 `equityMethod`/`equityIterations` 披露」 |
| **P1** | `FoldTo*CBet` 驱动「他面对我加注」的响应 | **✅ 已修复** |
| **P2** | `betScale` 里残留的 PFR | **✅ 结论反转为「不是缺陷」**（实测推翻原判断） |
| **P3** | 弃牌锚定状态做成正式诊断字段 | **✅ 已完成** |
| **P4** | 牌局记录补底牌与公共牌 | 已定清范围，**未做**（见 §5） |

---

## P1 —— `FoldTo*CBet` 进入加注响应（**已修复**）

**缺陷**：该统计只进 `streetFoldScale`（面对下注的分流）；`buildRaiseResponse` 不吃它
⇒ 对「弃给下注」的紧手，加注 EV 被系统性低估。

**修法**（`src/app/manualInput/raiseResponse.ts`）：`continueIndex` 乘上
`streetCallScale` —— 与响应层**同一个量、同一方向**（`foldScale ↑ ⇒ callScale = 2 − foldScale ↓ ⇒ 他更少继续`）。

**对照**（他下注 5BB，我 A♠Q♠，加注档响应）：

| 他的 `foldToFlopCBet` | 修复前 弃/跟/再加注 | **修复后** | 修复前 RAISE EV | **修复后** |
|---|---|---|---|---|
| 未观测 | 77.1% / 19.5% / 3.5% | **91.9% / 4.6% / 3.5%** | 626.8 | **998.7** |
| 75% | 77.1% / 19.5% / 3.5% | **91.9% / 4.6% / 3.5%** | 626.8 | **998.7** |
| 90% | 77.1% / 19.5% / 3.5% | **92.9% / 3.6% / 3.5%** | 626.8 | **1,028.0** |

⇒ 修复前「弃多弃少同一条数」，修复后**随统计单调变化**。
⚠️ 如实标注：**未观测与 75% 目前给出同一值**（该档在低弃牌率区间饱和）——
这是「继续指数」在 0..1 上有界的必然结果，不是新缺陷，但也意味着**敏感区在高弃牌率一侧**。

---

## P2 —— **不是缺陷**（实测推翻原判断，未改动）

原判断：`betScaleOfUnifiedDimensions` 里仍含 PFR ⇒ 同一个玩家两套「爱不爱开枪」。

**实测推翻**（`scripts/betscale-pfr-probe.ts`，标签 `VERY_TIGHT`，2000 手）：

| 只改 `pfr` | `resolved.aggression` | `FLOP.betScale` |
|---|---|---|
| 5% | 0.2665 | **0.8232** |
| 9% | 0.3057 | **0.8232** |
| 22% | 0.4331 | **0.8232** |
| 40% | 0.5604 | **0.8232** |

⇒ PFR 在这条通道上是**惰性的**（净贡献被标签基线项抵消），**不存在「两套口径」**。

而且我尝试「改成只吃翻后统计」时，`profileResolverV3Fix` 的
**UNIFIED-1 / UNIFIED-3 / UNIFIED-4** 三条测试立刻失败 —— 它们锁着一条**有意的不变量**：

> `betScale` 必须**完全由 `resolved` 维度决定**（防止「同一次分析里，主动下注模型内部的维度
> 与响应模型不一致」）。

⇒ 改动它会**破坏**那条不变量（把想修的问题换成更大的问题）。
**决定：维持原样，P2 关闭为「不是缺陷」**，把结论写进了源码注释（避免下一轮再被当成缺陷重开）。

---

## P3 —— 锚定状态成为正式字段（**已完成**）

**改法**：`SizeResponse.foldAnchor { measured, tolerance, modeled, applied, clamped }`
→ 经 `postflopAdvisor`（`BetSizeAdvice`）与 `decisionEngine` 的 sizes 快照**原样带出**。

**披露效果**（`scripts/fold-anchor-verify-out.txt`）：

```text
hands=2000 25%→ 锚定[未启用 模型74.1%]          ← 2000 手时该街可信度未过门槛
hands=8000 25%→ 锚定[实测30% 模型74.6%→45.1% **已夹**]   ← 可**直接判定**夹过，不必反推
hands=8000 65%→ 锚定[实测62% 模型80.8%→77.1% **已夹**]
hands=8000 85%→ 锚定[实测78% 模型83.5%→83.5% 未夹]
无该统计    → 锚定[未启用 模型76.6%]
```

⇒ 使用者/审计可以一眼看出「这一档的弃牌概率是模型自算的，还是被实测拉回来的」。

---

## P0 —— 决策尾延迟（**已修复：面对下注节点 1,618ms → 690ms**）

**真实数据**（`data/decision-log.jsonl`，10,917 条）：

| 指标 | 值 |
|---|---|
| 中位 | **587ms** |
| p90 | **2,707ms** |
| 最大 | 6,674ms |
| > 1 秒 | **33.7%** |
| > 3 秒（软预算） | **5.2%** |

**分层定位**（`scripts/context-latency-audit.ts` / `scripts/latency-median.ts`）：热点是 **`raiseResponse`**，
面对下注节点 wall ≈ **2.0–2.3s**，其中 `raiseResponse` ≈ **1.0–1.2s**；**与画像无关**（有无画像几乎相同）
⇒ 是**基线设计成本**：加注网格 7 档，每档各跑一遍响应分类 + 桶权益。

### 已做的优化（P0-step1，**纯去重、不改任何数值**）

**机制**：同一节点的 7 个档位用**同一副公共牌 + 同一份对手范围**，
但 `publicStrengthBandOf`（内含 `describeHand` 完整牌型评估）与 `drawProfileOf`（听牌评估）
原先被**逐条重算 7 遍**。

**改法**：`buildRaiseResponse` 新增可选 `comboClassificationMemo`（`Map`，键 = 组合 `cardIndices`），
由 `contextBuilder` 在**同一决策内**创建一次并跨档位复用。
**缺省 ⇒ 走原重算路径**（既有调用方/测试逐位不变）。

**去重率实测**（`scripts/memo-hitrate.ts`，只读计数器 `RAISE_COMBO_MEMO_STATS`）：

```text
缓存 命中 = 5,016 ｜ 未命中（实算）= 456  ⇒ 去重率 91.7%
```

**收益实测**（5 次取中位）：

| 指标 | 修复前 | **修复后** |
|---|---|---|
| wall（翻牌·面对 2/3 池） | 2,312ms | **1,989ms**（−14%） |
| `raiseResponse` | 1,224ms | **991ms**（−19%） |

**契约**：全量 2,323 项测试**全部通过**（该改动是等价变换：不抽样、不近似、不裁剪候选）。

### P0 剩余（**本轮已把 991ms 拆开：98% 是 16 次分桶权益**）

**step2（已完成）：把 `raiseResponse` 拆成三段永久计时**（新增只读计时键，**不改任何计算**）：

| 计时键 | 含义 |
|---|---|
| `raiseComboClassify` | 逐组合牌面分类（`buildRaiseResponse` 的组合循环） |
| `raiseBucketEquity` | 分桶条件权益（`rangeEquityOf`：跟注桶 / 再加注桶） |
| （差值） | 资金记账 / 5-bet 展开 / 组装 |

**实测（`scripts/raise-subphase-timing.ts`，3 次）**：

```text
raiseResponse 总 = 972ms
  ├ 组合分类 raiseComboClassify =  14ms   ← step1 去重后已可忽略
  ├ 桶权益   raiseBucketEquity  = 953ms   ← 98%
  └ 其余                        =   5ms
raiseResponse 三次: 1009, 1004, 936
```

**再往下定位**（`scripts/raise-equity-method-probe.ts`）：

```text
raiseResponseAll 档位数 = 8（加注网格 2/2.5/3/4/5/6/8 倍 + 全下）
⇒ 8 档 × 2 桶（跟注桶 + 再加注桶）= 16 次 rangeEquityOf
⇒ 953ms / 16 ≈ 60ms 每次
```

**⚠️ 一个未解释的事实（不下结论）**：调用点 `rangeEquityOfMany` 显式申请
`iterations: RESPONSE_EQUITY_ITERATIONS = 6000`（注释写着「响应模型一次要算 3 尺寸 × 2 桶 = 6 次」
⇒ 显然是**抽样**预算），而 6000 次抽样**不可能要 60ms**（对照：主决策的 3 个尺寸
用 EXACT、共约 47 万 matchups，只花 56ms）。
⇒ 说明这条路径实际做的**远多于 6000 次**，但**具体机制我还没测出来**
（是升级为精确枚举？还是 `mode: FAST` 下另有行为？）——**没有测到就不写结论**。

**追问已得出结论（step3：把「方法」变成正式披露字段）**：
`raiseResponseAll` 每次响应现在永久带上 `equityMethod` / `equityIterations`，实测：

```text
8 个档位：equityMethod = EXACT（8/8）
           局数 53,460 / 53,460 / 60,060 / 60,060 / 66,990 / 66,990 / 77,220 / 77,220
⇒ 合计约 47 万局，全是精确枚举
```

**根因（已确认，非猜测）**：`rangeEquityOfMany` 确实按 `iterations: 6000` 调用，
但 `buildCapacity` 的规则是「matchups ≤ `maxExactMatchups`（默认 500,000）⇒ **不论申请多少次迭代都走 EXACT**」。
本路径 matchups 在 5.3 万–7.7 万，**远低于 50 万** ⇒ **被静默升级为精确枚举**。
这就是「申请 6000 次抽样却花 60ms/次」的机制：它做的根本不是 6000 次，而是 5–8 万局枚举。

### P0 最终修复（step4：让权益方法与它自己的声明一致）

**改法**：给条件范围权益一个**与调用方声明一致的枚举预算** ——
`contextBuilder.ts` 新增 `RESPONSE_EQUITY_MAX_EXACT_MATCHUPS = 20_000` 并传给 `rangeEquityOfMany`，
该函数把它透传给权益引擎的 `maxExactMatchups`（**参数早已存在，此前只是没被这个调用点使用**）。

**三条性质（逐条对照项目铁律）**：

1. **仍是确定性** —— 固定 seed + 固定迭代数（6000）⇒ 同输入同输出，**与机器负载、剩余时间无关**；
2. **不是「按时间降级」** —— 这里**不看时间**，只看调用方自己声明的迭代数（项目明文禁止的是前者）；
3. **表驱动、非特判** —— 所有经 `rangeEquityOfMany` 的条件范围权益**统一**适用，无逐点 if。

**修复前后实测**（`scripts/raise-subphase-timing.ts` / `context-latency-audit.ts`）：

| 指标 | 修复前 | **修复后** |
|---|---|---|
| `raiseBucketEquity` | 1,017ms | **401ms（−61%）** |
| `raiseResponse` | 1,035ms | **421ms（−59%）** |
| 面对下注节点总耗时 | 1,618ms | **690ms（−57%）** |
| 分桶权益方法 | EXACT 5.3–7.7 万局 × 16 | **MONTE_CARLO 6000 次 × 16**（最小档 16,830 < 20,000 仍 EXACT） |

**为什么 20,000 这个阈值**：它同时满足「抽样预算 6000 不被升级」和「小桶（≤2 万局）仍走精确」，
是**工程选择**（已写进源码注释），不是拟合出的最优值。**想完全回到旧数值**：
把 `RESPONSE_EQUITY_MAX_EXACT_MATCHUPS` 调回 500,000 即可。

**副作用（必须披露）**：修掉静默升级会**移动一批 EV 数值**（约 0.1–2%），
5 处钉值测试已逐项更新（见 `reports/PRIORITY_FIXES_ROUND.md` 文末「契约影响」），
契约本身（EV>0 不得弃牌、一致性、资金口径）**未变**。最终全量 **2,323 / 2,323 通过**。

**契约影响（5 处钉值，逐项更新并附理由）**：

| 测试 | 旧钉值 | 新钉值 |
|---|---|---|
| `callFoldVerdictRuler` P1-A | CALL EV `2.6317493125308147`；下注范围权益 `0.32799636684827266` | **`3.3277500000000018`**；**`0.33808333333333335`** |
| `kqFlopDisclosureRepair` D5-1 | `MODEL_EV EV = 1948.14` | **`1944.75`** |
| `test17DisplayDisclosure` D-3 / D-8 | `73.50%`；CALL EV `30.715422655009696` | **`74.03%`**；**`31.083`** |
| `raiseToAmountConsistency` §八 | CALL EV `75.3924782169689` | **`76.52100000000002`** |

### P0 诚实边界（仍未解决的部分）

1. **仍剩 401ms 分桶权益**（16 次 × ~25ms）：6000 次抽样本身的开销。
   再往下只有两条路 —— 降迭代数（**改精度，需你拍板**）或改权益引擎热路径（**动冻结核**）。
2. **`RESPONSE_EQUITY_ITERATIONS = 6000`、`RESPONSE_EQUITY_MAX_EXACT_MATCHUPS = 20_000`
   都是工程选择**，不是拟合出的最优值；两者都已写进源码注释。
3. **本轮只优化了「面对下注」这一个节点**。`data/decision-log.jsonl` 里 5.2% 超 3 秒的
   极端样本**未逐条归因**（其中可能含其它节点）；中位数 587ms 已经够快，
   尾部是否还有第二个热点**没有测**。

---

## 5. P4 —— 牌局记录可回放（**已修复：新增 `board` / `holeCards` + 回放模块**）

### 问题（实测，不是估计）

| 文件 | 条数 | 有牌面吗 |
|---|---|---|
| `data/player-history.jsonl` | **1,036** | ❌ **带 board 的 0 条、带底牌的 0 条** |
| `data/decision-log.jsonl` | 10,917 | ❌ 只存 `inputHash` |

⇒ 「真实牌局复盘 + 实战验证」这条线**根本不成立**：不知道牌面，就无法判断任何一条
决策在当时是否正确。本轮 100 手验证只能用**结构化语料**代替真实牌局。

### 修复

**① `ObservationRecord` 新增两个可选字段**（`src/app/table/playerHistory.ts`）：

| 字段 | 口径 | 为什么 |
|---|---|---|
| `board?: readonly string[]` | 行动**之前**已发出的公共牌，**按街切片**（翻前 `[]` / 翻牌 3 / 转牌 4 / 河牌 5） | 记「行动前」而不是行动后：否则等于用**决策者当时看不到的牌**去解释他的决策 |
| `holeCards?: readonly string[]` | **行动者自己**的底牌（`As` / `Ks` 同格式） | 只有 Hero 的手牌会被录入，对手一律缺省 —— **未知就是未知，绝不虚构** |

**② 数据源选对了才不是白记**（这一步走错就会「有字段但永远为空」）：

| 候选源 | 实测结果 | 结论 |
|---|---|---|
| `engineViewOf().engine.board` | 已录入翻牌 3 张 + 转牌 1 张后仍是 **`flop/turn/river = 0/0/0`**，`street` 恒为 `PREFLOP` | ❌ **引擎要等 `advanceStreet` 跑过才有牌** ⇒ 拿它当源会**静默记下空牌面** |
| `state.board`（牌桌的 `string[]`） | 与用户录入逐字一致（`Kh 7c 2d Qd`） | ✅ **真源** |

**③ 切片长度由记录自己的 `street` 决定** —— 与写 `street` 字段**共用同一个表达式**
（`const streetOfAction = action.street ?? streetNow`），保证「记录说这是转牌」与
「牌面有 4 张」永远自洽，不引入第二处街道判断。

**④ 新增回放模块 `src/domain/handReplay/handReplay.ts`**（纯函数，不碰文件/牌桌）：

- `replayHand(handId, records)` → 公共牌 / 底牌 / 行动序列（含位置还原 `seat_XXX → BTN`）；
- 顺序键 = `historyLength`（撤销回退判据）→ `seq` → 读入顺序（**完全确定**，不依赖 `sort` 实现）；
- **不重新决策**：只还原「当时是什么局面」，不调引擎 ⇒ 不会因引擎版本变化而给出与当时不同的答案。

### 边界（Fail Closed，绝不拼一个假牌局）

| 情形 | 行为 |
|---|---|
| 旧记录（无牌面字段） | 照常读；`board` 为空、`heroCards` **缺省**（不是空数组）；`recordsWithBoard = 0` **如实计数** |
| 同手出现**互不为前缀**的公共牌 | ❌ `HAND_REPLAY_BOARD_CONFLICT`（拼「最长前缀」会造出一个**从未存在过的牌局**） |
| 同手出现**互不相同**的底牌 | ❌ `HAND_REPLAY_CARDS_CONFLICT`（底牌没有「前缀」概念，必须完全一致） |
| 座位还原不出位置 | ❌ `HAND_REPLAY_BAD_SEAT`（**不猜位置**） |
| 没有该手的记录 | ❌ `HAND_REPLAY_NO_RECORDS` |

> ⚠️ 第一版把「公共牌份数 > 1」直接判成冲突，于是**正常的多街牌局也会被拒** ——
> `P4-10` 抓到了这个缺陷。判据必须是「**互不为前缀**」，不是「不止一份」。

### 修复前后证据（`scripts/p4-history-replay-verify.ts`）

```text
=== 建桌：6 人，Hero 在 BTN，手牌 As Ks ===
=== 翻前：全部 CHECK/CALL 打到本街结束 ===
本街打完后 street = PREFLOP（仍是翻前：引擎在等公共牌）
=== 录入翻牌 Kh 7c 2d ⇒ 引擎重放并把街道推进到翻牌 ===
录牌后 street = FLOP
=== 录入转牌 Qd ⇒ 推进到转牌 ===
录牌后 street = TURN

=== 回放校验（用生产函数 replayHand）===
记录共 18 条 ⇒ 回放出 1 手
手 local#H1：
  记录条数            = 18（带公共牌 18 条 / 带底牌 3 条）
  回放 board          = [Kh 7c 2d Qd]   真实 = [Kh 7c 2d Qd]
  回放 heroCards      = [As Ks]   真实 = [As Ks]
  回放 行动条数       = 18   真实 = 18
  覆盖街道            = FLOP / PREFLOP / TURN
  ⇒ board ✅ | heroCards ✅ | 行动序列 ✅

=== 旧记录（本次修复前写入的 1,036 条）===
  带 board 的 = 0；带 holeCards 的 = 0
  ⇒ 旧记录**不可回放**。这是历史事实，不会被追溯补上。
```

### 契约

新增 `test/handReplayableRecord.test.ts`（**10 项全绿**），用**真实牌桌操作**
（翻前 → 录翻牌 → 翻牌 → 录转牌 → 转牌）锁住：

- `P4-1` 每条记录的 `board` 与自己的 `street` 自洽；翻前是**空数组**（不是缺字段）；
- `P4-2` 底牌只写在「行动者就是 Hero」的记录上，对手是**缺字段**（不是空数组）；
- `P4-3` `replayHand` 还原公共牌 / 底牌 / 行动序列，且**同输入同输出**；
- `P4-4` 三条街的行动**真的都记到了**（否则测试「绿得毫无意义」）+ 街道不回退 + 位置可还原；
- `P4-5`–`P4-10` 旧记录 / 矛盾牌面 / 矛盾底牌 / 坏座位 / 无记录 / 前缀合并。

### 诚实边界

1. **旧数据不会被追溯补上** —— 已写入的 1,036 条记录永远不可回放（当时没记牌面）。
   想复盘只能靠**此后**的新记录。
2. **对手底牌永远是缺省** —— 不是遗漏，是**没人知道**。因此「对手拿着什么」无法回放，
   Hero 视角的决策复核不受影响。
3. **`decision-log.jsonl` 仍然不可回放**（只存 `inputHash`）。本次**没有**改它
   —— 它与 `player-history.jsonl` 是两套记录，改哪一套、要不要合并，需要你定。
4. **隐私**：记录现在含具体底牌。这是"可回放"的必要代价；`data/` 目录本就在本机，
   但分享/上传该文件时**必须**知道里面有牌。

### 顺带澄清的一个机制（此前我误读过）

`applyAction` **只标记**「本街下注轮已结束」，**从不改 `street`**；推进街道的是
`settleCanonicalStreet(..., view.boardCards)`，而它**需要公共牌**：

> 下注轮结束 **且** 公共牌够 ⇒ 推进到下一街；公共牌不够 ⇒ 停在当前街（两边一致，不是错误）。

⇒ **先录牌，街道才动**。我第一版探针没按这个顺序，于是 18 条记录**全部**被如实记成
翻前行动（不报错、只是静默少掉两街）—— 这个顺序已写进测试注释，避免后人再踩。

---

## 6. 复现

```powershell
node --experimental-strip-types scripts/context-latency-audit.ts         # P0 分层耗时（wall / raiseResponse）
node --experimental-strip-types scripts/raise-subphase-timing.ts         # P0 三段永久计时
node --experimental-strip-types scripts/raise-equity-method-probe.ts     # P0 权益方法披露（修复前 EXACT / 修复后 MC）
node --experimental-strip-types scripts/raise-response-foldtrait-probe.ts  # P1 对照
node --experimental-strip-types scripts/betscale-pfr-probe.ts            # P2 反证
node --experimental-strip-types scripts/fold-anchor-verify.ts            # P3 披露
node --experimental-strip-types scripts/p4-history-replay-verify.ts      # P4 记录可回放（修复前后对照）
npm run verify
```
