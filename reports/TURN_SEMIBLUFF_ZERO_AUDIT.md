# 专项审计：转牌半诈唬节点三个 BET 尺寸为什么全部为 0

> **纪律声明**：本轮**只观察、追踪、记录、定位**。没有改任何参数 / 阈值 / 权重 / 测试 / 牌局输入，
> 没有为了让下注出现而加分。所有结论都有可复算证据：审计脚本
> `scripts/audit-turn-bet-zero.ts` 用**引擎自己给出的输入**逐项重算评分链，
> 并断言 `clamp(raw) === 引擎报告值`（三个尺寸 + CHECK 分 + verdict **逐位一致**）。
>
> 证据等级：【数学确定】可复算的算式与逐位相等 · 【工程约束】代码结构/顺序 · 【启发式】评分权重 · 【公开扑克理论】扑克论断

## 0. 被审计节点（输入固定）

6-max 1/2｜HJ open 3BB → CO 3bet 9BB → BTN/SB/BB fold → HJ call（底池 19.5BB）
翻牌 Q♦8♠4♠：HJ check → Hero check｜转牌 2♥：HJ check → **Hero CO A♠J♠**
引擎输出：`CHECK`｜role `SEMI_BLUFF`(0.35)｜equity **44.07%**｜CHECK **0.2384**｜BET_SMALL/MEDIUM/LARGE **0.0000**｜`NOT_VALUE`

## A. 完整评分链（clamp 之前 vs 之后）

**共同项（所有尺寸共享，因为三个尺寸来自同一个分数）** 【数学确定】

| 项 | 值 | 算式 / 来源 |
|---|---|---|
| role / strength | SEMI_BLUFF / 0.35 | `roleStrengthOf`（valueBetGate.ts:176-199） |
| equity | 0.440685 | 对 HJ 范围（385 组合）的多人口径权益 |
| fairShare（单挑基线） | 0.500000 | `1/(opponentCount+1)` |
| **valuePart** | **0.000000** | `clamp01((0.4407 − 0.5)/0.5)` ⇒ **权益低于 50% ⇒ 恒 0** |
| **valueContribution** | **0.000000** | `valuePart × (0.5 + 0.5×worseCallDensity 0.192887)` |
| **semiBluffContribution** | **+0.198174** | `bluffComponent 0.396349 × (0.5 − 多人惩罚 0)` |
| protectionContribution | 0.000000 | `protectionBenefit 0.229682 × 0.15` **但** `protectionRelevant=false` ⇒ 该项为 0 |
| betterContinueAdjustment | **−0.188275** | `−betterContinueDensity 0.537929 × 0.35` |
| raiseRiskAdjustment | **−0.108437** | `−raiseRisk 0.542183 × 0.20` |
| additive（画像偏移） | 0.000000 | UNKNOWN ⇒ `thinValueDelta=0`、`bluffDelta=0` |
| **rawScoreBeforeClamp** | **−0.098537** | 上面各项之和 |
| clamp | `clamp01`（floor 0 / ceil 1） | **raw 为负 ⇒ clamp 不是"吃掉正值"，它如实反映负值** |
| finalScore | 0.000000 | = 引擎报告 0.000000（逐位一致 true） |
| CHECK raw → final | 0.238370 → 0.238370 | `showdownValue 0.395343×0.35 + 0.1`（`worseHandsCanCall=false` 的无条件 +0.1 项） |
| gap / verdict | −0.238370 ⇒ `NOT_VALUE` | 逐位一致 true |

**三个尺寸**（`postflopAdvisor.ts:441-444`）【工程约束】

| Size | Raw（clamp 前） | SemiBluff | FoldEq | FutureEq | SDV 罚项 | Blocker | RaiseRisk | Street adj | Final before clamp | Final |
|---|---:|---:|---|---|---:|---:|---:|---|---:|---:|
| BET_SMALL | **−0.093610** | +0.198174 | NOT_IMPLEMENTED | NOT_IMPLEMENTED | 0（不进 betScore） | NOT_IMPLEMENTED | −0.108437 | 间接（经 ac） | −0.093610 | **0.000000** |
| BET_MEDIUM | **−0.098537** | +0.198174 | NOT_IMPLEMENTED | NOT_IMPLEMENTED | 0 | NOT_IMPLEMENTED | −0.108437 | 间接 | −0.098537 | **0.000000** |
| BET_LARGE | **−0.178537** | +0.198174 | NOT_IMPLEMENTED | NOT_IMPLEMENTED | 0 | NOT_IMPLEMENTED | −0.108437 | 间接 | −0.178537 | **0.000000** |

```text
BET_SMALL = betScore × 0.95｜BET_MEDIUM = betScore｜BET_LARGE = max(0, betScore − 0.08)
⇒ 三者**不是独立评分**：它们是同一个 gate 分数的三次变换。一个分数为 0 ⇒ 三个全 0。
```

**代码里不存在的项（如实标 NOT_IMPLEMENTED，不伪造）**：`pureBluffContribution`（并入 `bluffComponent`）、
`foldEquityContribution`、`futureEquityContribution`、`drawEquityContribution`、`blockerAdjustment`、
`unblockerAdjustment`、`SPRAdjustment`、`positionAdjustment`、`sizeAdjustment`、`observationAdjustment`、
`confidenceAdjustment`、`baseScore`。
其中 `spr` 与 `hasInitiative` 在 `ValueGateInput` 里**声明了但函数体内零引用**（`grep input.spr` = 0 命中）。

## B. 翻牌 vs 转牌逐字段 diff（按影响排序，节选前 12 项）

| 字段 | 翻牌 | 转牌 | 变化 |
|---|---:|---:|---:|
| valuePart | 0.194250 | **0.000000** | **−0.194250** |
| equity | 0.597125 | 0.440685 | −0.156440 |
| **betScoreRaw** | **+0.048821** | **−0.098537** | **−0.147358** |
| valueContribution | +0.120705 | 0.000000 | −0.120705 |
| showdownValue | 0.473562 | 0.395343 | −0.078220 |
| strongerShare | 0.653739 | 0.718964 | +0.065224 |
| betterContinueDensity | 0.478363 | 0.537929 | +0.059566 |
| weakerShare | 0.313941 | 0.254630 | −0.059311 |
| raiseRisk | 0.490351 | 0.542183 | +0.051832 |
| worseCallDensity | 0.242780 | 0.192887 | −0.049893 |
| checkScore(final) | 0.265747 | 0.238370 | −0.027377 |
| wetness | 0.166667 | 0.166667 | **0.000000** |

**对 betScoreRaw 的贡献分解（转牌 − 翻牌）**【数学确定】

```text
valueContribution 消失        −0.120705   (82%)
betterContinuePenalty 变大    −0.020848   (14%)
raiseRiskPenalty 变大         −0.010366    (7%)
semiBluffContribution 变大    +0.004561   (−3%)
合计                          −0.147358   ⇒ 0.048821 → −0.098537
```

**结论：让 BET 从「小幅正值」跌到「严格 0」的不是 clamp，而是加权和本身变成了负数。**
主因（82%）= **权益跌破 50% 单挑基线 ⇒ `valuePart` 由 0.194 变成 0**；
次因（21%）= 他的范围相对我这手牌更强（strongerShare 65.4%→71.9%）**同时**推高
`betterContinueDensity` 与 `raiseRisk` 两项罚分。

## C. 根因（文件 / 函数 / 关键分支 / 逻辑）

### C-1（**主因**）半诈唬在评分里**没有任何正项通道**（除一个近似常数）
`src/domain/postflop/valueBetGate.ts` · `assessValueBet` · 第 328-340 行

```ts
const valuePart = clamp01((equity - fairShare) / Math.max(1e-6, 1 - fairShare));   // 权益 <50% ⇒ 0
const bluffComponent = role ∈ {PURE_BLUFF, SEMI_BLUFF}
  ? clamp01(clamp01(wetness) * 0.4 + (1 - compression.airDensity) * 0.2 + 0.2)     // 本节点 = 0.3963
  : 0;
betScoreRaw = valuePart * (0.5 + 0.5*worseCallDensity)     // 0
            + bluffComponent * (0.5 - multiwayBluffPenalty) // +0.1982 ← 唯一的正项
            + protectionBenefit * 0.15                      // 0（被 protectionRelevant 门槛关掉）
            - betterContinueDensity * 0.35                  // −0.1883
            - raiseRisk * 0.2;                              // −0.1084
```

【公开扑克理论】半诈唬的收益 = **弃牌率** + 被跟注后的补牌权益。本项目的模型里：

- `foldEquityContribution` = **NOT_IMPLEMENTED**（文件头明确写「弃牌率不建模」）；
- `drawEquityContribution` = **NOT_IMPLEMENTED**（Hero 自己的听牌从未进入评分，见 C-3）；
- `valuePart` 以 50% 为基线 ⇒ 半诈唬**按定义**拿不到它。

⇒ 一个"权益 44% 的坚果同花听"在评分上**只剩一个约 0.2 的常数项**去抵消 0.30 的两项罚分。
这不是"分小"，而是**结构上不可能为正**。

### C-2（**次因，重复计票**）`strongerShare` 被收两次费
同一函数第 264-280 行：`betterContinueDensity = strongerShare × (0.6 + 0.4×ac)` **与**
`raiseRisk = strongerShare × 0.7 + ac × 0.15 − wetness × 0.1` 都以 `strongerShare` 为主项。
本节点 `strongerShare = 0.719` ⇒ 两项合计收费 **−0.2967**，而半诈唬的全部正项只有 **+0.1982**。
「他手里有多少比我好的牌」这一份证据被计了两遍（一遍当"会继续"，一遍当"会加注"）。
【启发式】权重本身是设计选择，但**同一输入被两条通道同时惩罚**属于结构性重复计票。

### C-3 `SEMI_BLUFF` 标签**确实**进了评分，但只贡献一个与牌面无关的常数
`postflopAdvisor.ts:190` 计算了 Hero 的听牌剖面（`flushDraw / openEnded / outs`），
它只被传给 `classifyRelativeRole`（决定标签），**从未传给 `assessValueBet`**。
评分里唯一的"听牌"量是 `compression.drawDensity`，那是**对手**的听牌密度（0.029），不是我的。
⇒ 坚果同花听与完全空气在这个 scorer 里拿到**同一个** `bluffComponent`（0.3963）。
角色扫描证据（同输入只换 role）：

```text
SEMI_BLUFF      betScore 0.0000   bluffComponent 0.3963
PURE_BLUFF      betScore 0.0000   bluffComponent 0.3963
DRAW            betScore 0.0000   bluffComponent 0.0000   ← 连听牌角色都没有诈唬项
SHOWDOWN_VALUE  betScore 0.0000   bluffComponent 0.0000
THIN_VALUE      betScore 0.0000   bluffComponent 0.0000
```
即：标签**有**接入（+0.198 的存在性可证），但 `DRAW` 角色拿不到任何诈唬项 —— 语义不一致。

### C-4（动作层）`NOT_VALUE` 不把分数置 0，但它把**动作**关掉，且有效门槛很高
`src/app/decision/decisionEngine.ts:1417-1432`

```ts
const gateWantsBet = advice.gate.verdict === 'CLEAR_VALUE' || advice.gate.verdict === 'THIN_VALUE' ||
  (advice.gate.verdict === 'MARGINAL' && betScore > checkScore);
```
`verdict` 是**分数算完之后**由 gap 推出的（valueBetGate.ts:400-410），
因此**不存在** `if (NOT_VALUE) betScore = 0` 这类短路。
但有效门槛是：`MARGINAL` 需 `betScore > check − 0.06 = 0.178370`，
`THIN_VALUE` 需 `≥ 0.298370`，`CLEAR_VALUE` 需 `≥ 0.418370`。
⇒ **即使半诈唬拿到一个小的正分（如翻牌的 +0.0488），也永远选不上**（翻牌同样输出 CHECK）。

### C-5 `raiseRisk` 的定义审计（使用者 §4 专项）
`valueBetGate.ts:276-280`【数学确定】

```text
raiseRisk = clamp01( strongerShare × 0.7  +  aggressionCredibility × 0.15  −  clamp01(wetness) × 0.1 )
```

| 问题 | 结论 |
|---|---|
| 是什么 | **归一化危险指数**（range share + 启发式可信度的加权和）。**不是** check-raise 概率，**不是**频率 |
| 输入来源 | `strongerShare`（逐组合精确比较，范围层）【数学确定】；`aggressionCredibility`（`compressionFactor`，启发式）；`wetness`（牌面纹理） |
| 0–1 概率？ | 否。0–1 **指数**，有 `clamp01` |
| 画像影响 | **间接**：① 经 profile-adjusted range 的 `strongerShare`；② 经 `profileCompressionMultiplier`（CALLING_STATION 0.7、MANIAC 0.72、VERY_TIGHT 1.25…）。实测：ac 0.332(跟注站) vs 0.403(极紧) ⇒ raiseRisk 0.5378 vs 0.5463 |
| 街道影响 | **是**：`STREET_WEIGHT`（flop 1/3、turn 2/3）进入 ac |
| 纹理影响 | **是**：直接 `−wetness×0.1`，且 wetness 进 `compressionFactor` 的 `wetnessPart` |
| 范围组成影响 | **是**（主项，权重 0.7） |
| 扣了多少分 | `× 0.20` **一次性**作用于 betScore：−0.108437，三个尺寸**同样**承担（尺寸不改变它） |

**翻牌 0.490 → 转牌 0.542 的分解**【数学确定】：

```text
strongerShare 0.653739 → 0.718964  = +0.065225 × 0.7  = +0.045657
ac            0.329333 → 0.370500  = +0.041167 × 0.15 = +0.006175
wetness       0.166667 → 0.166667  =  0        × −0.1 =  0
合计 +0.051832  ✓ 与 ΔraiseRisk 逐位吻合
```
即：**涨的 88% 来自"他范围里比我好的牌变多了"**（转牌没帮到我的 A 高张，而他在两条街过牌后范围更偏中等成对牌），
12% 来自街道权重。

**使用者假设的「HJ 偏松弱 / 翻后被动」在本轮审计里并未设定**（输入是 `quickProfile: UNKNOWN`）。
实测把画像设成 `CALLING_STATION`：raw −0.0985 → **−0.0958**（略微"更该下注"），动作仍是 CHECK。
原因见 C-6。

### C-6（画像断层 + 方向反了）画像进了 scorer，但**没有以"条件概率"的形式**进
- 进了：`strongerShare/weakerShare` 来自**画像调整后的范围**；`compression` 的密度也由调整后的范围算出 ⇒ 画像确实进入评分。
- 没进：scorer 里**没有任何** `P(fold|bet)` / `P(call|bet)` / `P(raise|bet)`。
  `worseCallDensity = weakerShare × stickiness`、`raiseRisk = strongerShare×0.7 + ac×0.15 − wetness×0.1`
  都是**组成 × 启发式**，不是条件概率。项目里"被动/跟注倾向"的维度（`passivity`）**只**影响
  exploit 层的 `thinValueDelta/bluffDelta`，**不影响"他会不会跟我的下注"**。
- **方向反了的实例**：`stickiness = clamp01(showdownDensity×0.6 + mediumStrengthDensity×0.4 + 0.25)`；
  跟注站画像让压缩因子下降（ac 0.370→0.332）⇒ `airDensity` 上升、`mediumStrengthDensity` 下降
  ⇒ `stickiness` 0.4612→0.4571 ⇒ **`worseCallDensity` 0.1929→0.1912 下降**。
  语义上「跟注站」应当**提高**"更差的牌会跟"的密度，实际却降低了。这是**同一份画像在两个方向上被使用**的结果。
- **重复计数**：画像同时经 ① 调整后的范围组成 与 ② `profileCompressionMultiplier` 进入同一个 raw。

### C-7（§8 专项）半诈唬是否错误依赖 `protectionGain`？
**不是依赖，但有一条被门槛丢掉的潜在正项。**
- `bluffComponent` 的算式**不含** `protectionBenefit`（两者是并列的两项）⇒ 不存在 `semiBluff ≈ protection` 的耦合。
- 但 `protectionBenefit = 0.229682` 已经算出，却因为 `protectionRelevant = wetness>0.4 || 对手听牌密度>0.25`
  在本节点为 `false` 而被乘成 0（损失 +0.0331）。
- 而 `bluffComponent` 唯一的牌面输入是 `wetness`，其定义（`boardWetnessOf`）**只看牌面自身的花色数与连张数**：
  Q♦8♠4♠(2♥) ⇒ `0.5×((2−1)/3) + 0 + 0 = 0.1667`。**Hero 手里的坚果同花听完全不参与**。
  所以半诈唬的"牌面相关部分"在坚果听与纯空气之间**没有区别**。

## D. 根因分类（按使用者 §10 的分类表）

| 分类 | 判定 | 证据 |
|---|---|---|
| A. `SEMI_BLUFF` 信号未接入转牌 scorer | **REFUTED** | 角色扫描：SEMI_BLUFF/PURE_BLUFF 拿到 `bluffComponent 0.3963`（+0.198）；换成 SHOWDOWN_VALUE 则该项为 0 |
| B. `NOT_VALUE` gate 错误压制诈唬/半诈唬 | **CONFIRMED（动作层，非分数层）** | 分数先算、verdict 后推（无短路置 0）；但 `gateWantsBet` 用 verdict，且有效门槛 0.178/0.298/0.418 远高于半诈唬可达分数 |
| C. `raiseRisk` 权重过大或定义错误 | **CONFIRMED（重复计票）** | `strongerShare` 同时进 `betterContinueDensity×0.35` 与 `raiseRisk×0.2` ⇒ 合计 −0.2967 vs 半诈唬正项 +0.1982 |
| D. 翻牌/转牌使用不同 scorer，转牌缺逻辑 | **REFUTED** | 同一函数、同一分支；两街唯一差异是输入 + `STREET_WEIGHT`；差异 100% 可由 A/B 表解释 |
| E. profile-adjusted range 未进入 betting scorer | **PARTIAL** | 范围组成**进了**；但**没有任何动作条件概率**，且画像被计两次（C-6） |
| F. blocker / showdown-value penalty 叠加过强 | **PARTIAL** | 阻断牌**不进** betScore（NOT_IMPLEMENTED）；`showdownValue` 只加 CHECK 分（+0.138）⇒ 抬高了下注的相对门槛 |
| G. `protectionGain` 错误成为必要条件 | **REFUTED** | `bluffComponent` 与 protection 并列；把 protection 补满也只到 raw −0.0654，仍为负 |
| H. clamp/floor 掩盖小幅正 raw | **转牌 REFUTED / BET_LARGE CONFIRMED** | 转牌 raw = −0.0985（本就为负）；`BET_LARGE = max(0, score−0.08)` 确实吞掉 <0.08 的正分（翻牌 +0.0488 ⇒ LARGE 0） |
| I. 其他 | **CONFIRMED（主因）** | `valuePart` 以 50% 为基线 + `foldEquity` 未建模 + Hero 自身听牌未进入评分 ⇒ 半诈唬**没有正项通道**（C-1/C-3） |

**一句话根因**：
> 这是一个**自洽但能力缺失**的 scorer。三个 BET 尺寸不是三个独立评分，而是同一个 gate 分数的三次变换；
> 该分数在转牌为 **−0.0985**（不是"小的正数被夹掉"）。半诈唬的全部正项只有一个与牌面无关的常数
> `bluffComponent×0.5 = +0.198`，而"他比我好的牌多"这一份证据被 `betterContinue` 与 `raiseRisk`
> **同时**收费 −0.297；同时 `valuePart` 因权益 44.07% < 50% 归零、`foldEquity` 与 Hero 自身听牌权益
> 都未实现 ⇒ 结构上不可能为正。翻牌之所以非零（+0.0488）只是因为权益 59.7% > 50% 拿到了 `valuePart`。

## E. 修复建议（**最小正确方案；本轮未实施**）

按"先证据、后改动"的顺序，建议下一轮做**其中一项**并配测试，而不是同时调多个旋钮：

1. **去重复计票（最小、最保守）**：`strongerShare` 只应被收一次费。
   建议把两项合并为一个有上限的惩罚项（例如 `max(betterContinue×0.35, raiseRisk×0.2)`，
   或两项权重之和封顶在 0.35），并加测试锁定"strongerShare 单调 ⇒ 罚分单调且不重复"。
   *影响面小、语义清晰、不必引入新参数。*
2. **补上半诈唬的缺失正项（能力修复，需产品裁决）**：本项目**没有**弃牌率模型，
   因此"权益 < 50% 的纯半诈唬该不该下注"在模型里目前**无法回答**。
   若产品要求引擎能半诈唬，必须显式引入一个**可解释的弃牌率代理**
   （例如由 `airDensity`（他有空气的比例）× 下注尺寸弹性 × 牌面纹理构成），
   并在 UI 明示它是启发式代理 —— 而不是调高 `SEMI_BLUFF` 常数。
3. **把 Hero 自己的听牌接进评分**：`drawProfileOf` 已算出 `flushDraw/openEnded/outs`，
   目前只用于打标签。让它进入 `bluffComponent`（替换/补充 board-only 的 `wetness`）
   是本节点最贴近扑克的修法，但会改变所有听牌节点的分数 ⇒ 需配套回归。
4. **`BET_LARGE` 的 −0.08 floor**：应改为与 `betScore` 尺度无关的独立尺寸评分，或至少把 floor 的作用写进 UI 文案 ——
   否则"大注"在 0.08 以下永远不存在。
5. **画像方向修正**：`stickiness` 不应因"跟注站"画像而下降（C-6）。这是明确的方向性缺陷，且与画像重复计数同源。
6. **不建议做的事**（本轮禁令）：调高 SEMI_BLUFF bonus、调低 raiseRisk 权重、强行 `BET_SMALL > 0`、放宽测试。

## F. 墨菲定律清单核对（使用者 §12）

| 失败模式 | 本轮结论 |
|---|---|
| 修复后所有 draw 都过度下注 | 未修复；但**任何**新正项都会经过 `bluffComponent`，需加"空气不得优于强听牌"的单调测试 |
| SEMI_BLUFF 被重复加权 | 目前**没有**（`bluffComponent` 只此一处）；但 `strength` 同时进 `showdownValue`（只影响 CHECK 分） |
| 画像在 range 层与 scorer 层重复计数 | **已确认存在**（C-6），实测幅度 ±0.003 raw（当前很小但机制在） |
| raiseRisk 同时来自 range 与 heuristic | **已确认**：`strongerShare`（range，0.7）+ `ac`（启发式，0.15，且 ac 的基线本身也由 range 事实构成） |
| flop/turn 定义不同但 UI 同名字段 | 否（同一函数）；但 `wetness` 在两街**逐位相同**（0.1667），因为它不包含新牌/我方听牌信息 |
| clamp 前出现 NaN / Infinity / 负权重 | **干净**（扫描 0 项）；负数是**合法结果**而非坏数据 |
| zero 是缺省值而非计算值 | **否**：逐位复算一致 ⇒ 是真算出来的 0 |
| 未生成候选被 UI 当成 0 | **否**：`legal.actions` 含 BET，`scores` 有 4 项 |
| normalization 吃掉小正值 | 转牌不适用（raw 为负）；`BET_LARGE` 的 −0.08 floor **确实**吃掉小正值 |
| size scorer 与 action scorer 顺序错误 | 本质更严重：**不存在独立 size scorer**，三个尺寸是同一分数的变换 |
