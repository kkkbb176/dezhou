# RIVER CONSISTENCY V2.1 — PASS

**日期**：2026-09
**触发**：V2 通过工程一致性测试后，最终复核仍发现 4 个未关闭问题
**范围**：**只修这四点** —— 不调策略、不为让某一手变成 CALL/FOLD、不重构 postflop engine
**验收**：`npm run verify` → **TypeScript 0 错误 / 1,652 项 / 137 套件 / 0 失败**；
既有测试零删除、零放宽（`POT-D10` 是**语义升级**而非放宽）；新增 16 条 + 5 项变异测试全部有效

```text
本轮**不**宣称：+EV VERIFIED / GTO VERIFIED / SOLVER VERIFIED / LONG-TERM PROFIT VERIFIED
本轮**只**验证：角色语义正确 · EV 表达正确 · range 语义正确 · settlement 作用域正确
```

---

## 证据等级（全轮统一，逐项标注）

| 等级 | 本轮适用 |
|---|---|
| 【数学确定】 | 河牌无未来公共牌；成交牌型与强弱比较；节点增量 EV 与 EV 排名；死牌移除；浮点余量 1e-6 |
| 【公开扑克理论】 | 「有摊牌价值 ⇒ 不诈唬」；价值 / 薄价值 / 摊牌 / 诈唬四类的划分；抓诈唬的检查顺序 |
| 【工程约束】 | 动作与指标同体系；容差带只标记不确定性；简化退款公式的作用域；结算事件唯一性 |
| 【启发式 / 未验证】 | 档位 + 相对强弱 → 动作类别的映射表；阻断牌权重；画像偏移 |

---

## 1. 为什么 pair 最终变 AIR

**根因（一行）**：`isOnePairShape` 分支里的门槛用错了问题。

```text
if (facingBet) {
  return equity !== null && equity >= requiredEquity * 0.9
    ? BLUFF_CATCHER
    : AIR;              ← 这里
}
```

`equity >= requiredEquity × 0.9` 回答的是「**能不能盈利地抓诈唬**」，
但它的两个出口却是「抓诈牌 / **空气**」。于是一手**中对 Q**（能赢下对手 22.06% 的可达范围、
`weakerShare = 0.2206`）被判成「什么都赢不了」。

**实测（真实管线，修复前）**：

| Hero | 成交牌型 | 权益 | 所需 | 角色 |
|---|---|---|---|---|
| Q♣J♣ | FLUSH | 99.4% | 28.0% | NUT_VALUE |
| Q♠8♠ | TWO_PAIR | 38.1% | 28.0% | BLUFF_CATCHER |
| **A♣Q♠** | **MIDDLE_PAIR** | **24.0%** | **28.0%** | **AIR** ← 错误 |
| 5♥4♥ | BOTTOM_PAIR | 1.3% | 28.0% | AIR ← 合法（例外） |
| A♠J♠ | HIGH_CARD | 0.6% | 28.0% | AIR ← 合法 |

---

## 2. AIR fallback 被谁触发

| 触发点 | 位置 | 是否合法 |
|---|---|---|
| `equity >= requiredEquity * 0.9 ? BLUFF_CATCHER : AIR` | `relativeHandRole.ts` 一对级分支 | ❌ **非法**（本次修复） |
| 同样的 0.9 系数 | `normalizeRiverRole`（河牌兜底规范化） | ❌ 一并修复 |
| 两对级分支的 `facingBet ? BLUFF_CATCHER : SHOWDOWN_VALUE` | 同上 | ⚠️ 不会产出 AIR，但语义同样不看权益 ⇒ 一并统一 |
| 无成手 + 有主动权 ⇒ `PURE_BLUFF` | 同上第 5 节 | ✅ 合法（定义如此） |
| 高牌 → `AIR` | 同上第 5 节末尾 | ✅ 合法（且必须保留，见 ROLE-2 的反向保护） |

**AIR 的定义现在是受数据约束的**（不再由「价值下注是否成立」决定）：

```text
AIR ⇔ 对对手**可达范围**没有任何摊牌价值（weakerShare + equalShare < 0.02）
```

---

## 3. 新 role mapping 规则

**两个问题必须分开**（使用者第二节）：

| 问题 | 类型 | 取值 |
|---|---|---|
| 我**是什么**牌 | `MadeHandClass` | `HIGH_CARD / PAIR / TWO_PAIR / TRIPS / STRAIGHT / FLUSH / FULL_HOUSE / QUADS / STRAIGHT_FLUSH` |
| 这手牌**相对**对手范围是什么 | `RelativeHandRole` | `NUT_VALUE / STRONG_VALUE / MEDIUM_VALUE / THIN_VALUE / SHOWDOWN_VALUE / BLUFF_CATCHER / PURE_BLUFF / AIR` |

**统一规则**（`madeHandRoleFacingBet`，一对 / 两对 / 更弱的成交牌型共用）：

```text
权益 ≥ 门槛                       ⇒ BLUFF_CATCHER（跟注本身有利可图）
有摊牌价值（或不详 = 拿不到范围）   ⇒ SHOWDOWN_VALUE（能赢一部分摊牌，但不值得继续投入）
确认毫无摊牌价值（数据支撑）        ⇒ AIR（这才是「什么都赢不了」）
```

**域不变量**（可执行）：

```text
street === 'RIVER' && madeHand !== HIGH_CARD  ⇒  role ≠ AIR
```

- 实现为 `madeHandRoleInvariantViolation()`（可被守卫与测试调用）
- **例外是显式的、有数据支撑的**：可达范围里确实没有任何更差的组合时，AIR 是准确的描述
  （底对 5♥4♥ 权益 1.3% → AIR；ROLE-3 用例锁定这个例外）
- ⚠️ 「不知道」不能当成「没有」：拿不到范围事实时按**有**摊牌价值处理

---

## 4. 392.50 的精确来源

**唯一公式**：

```text
toleranceChips = MODEL_UNCERTAINTY_RATIO (5%) × winnable (跟注后的可争夺量 = P + 2B)
本节点：5% × 7850 = 392.50 筹码
```

**逐项排除**（同一节点实测）：

| 候选口径 | 数值 | 是否就是它 |
|---|---|---|
| 5% × `winnable`（P+2B） | **392.50** | ✅ **就是它** |
| 5% × `pot`（含对手下注） | 282.50 | ❌ |
| 5% × `callCost` | 110.00 | ❌ |
| 5% × `effectiveStack` | 307.50 | ❌ |
| 5% × `myRemainingStack` | 417.50 | ❌ |
| 固定系数 / heuristic scaling | —— | ❌ 不是固定值，随可争夺量线性 |

代码位置：`MARGINAL_EV_GAP_RATIO`（= `MODEL_UNCERTAINTY_RATIO`），在 `decisionEngine` 里乘 `math.winnable`。

---

## 5. 该 band 到底是数学误差还是工程容差

**是【工程约束】意义上的人为容差，不是数学误差。** 三条证据：

| 可能的正当来源 | 本节点的事实 | 结论 |
|---|---|---|
| 统计误差 / 置信区间 | 没有为 EV 建立区间 | ❌ |
| solver error bound | 本项目没有求解树 | ❌ |
| sampling variance | 本节点是**精确枚举**（`method = EXACT`，990 局组合，`confidenceHalfWidth = 0`） | ❌ |
| 人为工程容差 | 5% × 可争夺量，纯约定 | ✅ **就是这个** |

**真正的数学无差异**（使用者第六节）是 `|EV_a − EV_b| ≤ ε`，ε 只用于浮点/数值误差 ——
本项目取 `MATH_EV_EPSILON = 1e-6` 筹码。

---

## 6. 是否更名为 MODEL_UNCERTAINTY_BAND

**是。** 命名改动（对外表述与依据类型）：

| 旧 | 新 | 含义 |
|---|---|---|
| `INDIFFERENCE_BAND`（决策依据类型） | **`MATH_INDIFFERENCE`** | **数学**上确实相等：`\|ΔEV\| ≤ 1e-6` 筹码 |
| 同上 | **`MODEL_UNCERTAINTY_OVERRIDE`** | **工程**上偏离 EV 排名（必须显式开启并声明非数学结论） |
| 「无差别带」文案 | **「模型容差带（工程容差，非数学无差异）」** | 界面原文 |
| —— | `MODEL_UNCERTAINTY_RATIO`（常量别名） | 与 `MARGINAL_EV_GAP_RATIO` 同值，专用于对外表述 |

界面实测输出：

```text
真实 EV 排名（节点增量口径）：FOLD 0.00　vs　CALL -317.61　⇒　**FOLD 更高**
模型容差带（工程容差，非数学无差异）：±392.50 筹码｜来源：MODEL_UNCERTAINTY_RATIO (5%) × winnable
  = 392.50 筹码 —— **工程容差**（不是统计误差，也不是 solver error bound）
  ｜不确定性覆盖：未开启（动作严格跟随 EV 排名）
```

⚠️ 常量名 `MARGINAL_EV_GAP_RATIO` **保留**（避免既有调用点静默改变含义），
但所有对外文本与依据类型都已改名，且守卫会拒绝把容差带说成数学无差异。

---

## 7. 是否允许 uncertainty override

**允许，但默认关闭，且必须显式开启。**

| 项 | 实现 |
|---|---|
| 开关 | `decideAlpha(context, legal, { allowUncertaintyOverride })`，**默认 false** |
| 触发条件（三条同时） | ① 显式开启；② 真实 EV 存在且 `\|EV\| ≤ 容差带`；③ EV 为负（覆盖方向 = 代价最小的跟注） |
| 标记 | `decisionBasis = MODEL_UNCERTAINTY_OVERRIDE`，文案含「**工程启发式，不是数学结论**」 |
| 测试 | `BAND-3`（关闭时跟随 EV 排名）、`BAND-4`（开启时标成覆盖且守卫零违规） |

**默认行为**（本节点，未开启覆盖）：

```text
action = FOLD      （FOLD EV ≡ 0 > CALL EV −317.61）
basis  = CHIP_EV
classification = MARGINAL（结论强度仍是边缘，但方向由真实 EV 决定）
```

---

## 8. stronger/weaker 与 value/bluff 如何分离

**新增分类器** `src/domain/postflop/riverActionClass.ts`：

```text
RiverActionClass = CLEAR_VALUE | THIN_VALUE | SHOWDOWN | BLUFF_CANDIDATE | UNCERTAIN
```

| 与 Hero 的关系 | 相对档位 | 类别 | 依据 |
|---|---|---|---|
| 更强 | 0–1 | `CLEAR_VALUE` | 【公开扑克理论】强成手会下注取值 |
| 更强 | 2 | `THIN_VALUE` | 边缘成手可能薄价值下注 |
| 更强 | 3 | `SHOWDOWN` | 比他强但不够下注价值 ⇒ 摊牌 |
| 更强 | 4–5 | `UNCERTAIN` | 证据不足 ⇒ **不强行归类** |
| 打平 | 任意 | `SHOWDOWN` | 摊牌 |
| 更弱 | 0–3 | `SHOWDOWN` | **有摊牌价值 ⇒ 不会诈唬** |
| 更弱 | 4 | `UNCERTAIN` | 底对/小对子，可能摊牌也可能诈唬 ⇒ 不硬算 |
| 更弱 | 5 | `BLUFF_CANDIDATE` | **无摊牌价值 ⇒ 唯一有诈唬动机的一类** |

**字段分离**（禁止等价）：

```text
数学确定的强弱比较：strongerThanHeroCount / weakerThanHeroCount
分类之后的动作计数：valueBetCandidateCount / bluffCandidateCount
                       ↑ 只有分类完成后才允许使用「价值 / 诈唬」这两个词
```

**实测（A♣Q♠ 节点，可达 410 组合）**：

| 量 | 值 |
|---|---|
| 更强 / 更弱 / 打平（**未加权组合数**） | 112 / 292 / 6 |
| 更强 / 更差（**概率质量占比**，分母 410） | 74.1% / 22.1% |
| 价值下注候选（明确 33 + 薄 79） | 112 |
| **诈唬候选** | **156** ← 远小于「更弱」292 |
| 摊牌牌 / 证据不足 | 30 / 112 |

⚠️ **两个口径必须分列**：组合数回答「有多少手牌比我强」，概率质量回答「他实际多大概率比我强」——
真实后验下前者 27%、后者 74%（强牌组合少但权重高）。

---

## 9. River bluff candidate 如何定义

必须**同时**满足（缺一不可）：

1. **到河牌可达**（在对手的 reachable range 内）——【数学确定】
2. **比 Hero 弱**（`compareHands` 逐组合精确比较）——【数学确定】
3. **没有足够摊牌价值**（相对档位 5 = 高牌/无对）——【公开扑克理论】
4. **在当前下注模型下可能下注** ——【启发式】：本实现以「无摊牌价值 ⇒ 有诈唬动机」为操作化代理

**证据不足时返回 `UNCERTAIN`**（档位 4 的底对/小对子），**不**强行算成诈唬。
分类**不是**下注频率模型 —— 它不声称「他会用 30% 的频率诈唬」。

---

## 10. Blocker 输出是否改名

**是，全部改名 + 增加分类计数。**

| 旧名 | 新名 | 语义 |
|---|---|---|
| `blockedValueCombos` | **`blockedStrongerCombos`** | 被 Hero 的牌移除的、比 Hero **更强**的组合数【数学确定】 |
| `blockedBluffCombos` | **`blockedWeakerCombos`** | 被移除的、比 Hero **更弱**的组合数【数学确定】 |
| （无） | **`blockedValueBetCandidateCount`** | 分类后属于价值下注候选的（有分类才产出，否则 `null`） |
| （无） | **`blockedBluffCandidateCount`** | 分类后属于诈唬候选的（同上） |

界面文案（实测）：

```text
阻断牌（可达范围逐组合）：挡掉更强的组合 29 个、更弱的组合 63 个；
其中经河牌动作分类：价值下注候选 29 个、诈唬候选 21 个；净偏好 0.07（证据质量 HIGH，内部评分）
⚠️「更强/更弱」是强弱比较，不等于价值/诈唬
```

⚠️ 本节点 `blockedValueBetCandidateCount = blockedStrongerCombos = 29` 是**数据使然**
（比中对 Q 更强的组合必然是最强档 ⇒ 都会下注取值），不是把两个字段等同。
反方向的差别是实质性的：**更弱 63 → 诈唬候选只有 21**。

---

## 11. pending / returned / side pot 的新边界

| 概念 | 定义 | 何时产生 |
|---|---|---|
| `pendingUnmatched` | 当前下注轮中，某玩家下注额**尚未被其他玩家匹配**的部分；Hero 未行动时只是 **pending** | 轮次未关闭 |
| `returned` | 下注轮**已关闭**、确定没有任何合法对手能匹配，最终退还给下注者的筹码 | 轮次关闭 / 复盘 |
| `sidePotSettlement`（分层） | 多人全下 / 不同有效筹码形成的主池、副池分层 | 由投入台账决定 |

**三者禁止共用语义**（本轮把它们变成三个可读、可测的量）：

```text
contested + Σreturned + ΣpendingUnmatched === total
pendingUnmatched > 0  ⇔  roundClosed === false
returned > 0  ⇒  除他之外没有任何未弃牌、未全下、还有筹码的玩家
```

**实测三态**（本节点）：

| 状态 | pending | returned | roundClosed | 事件 |
|---|---|---|---|---|
| Hero 未行动 | 2200 | **0** | false | `LAYER(3450) + PENDING_UNMATCHED(2200)` |
| Hero CALL | 0 | 0 | true | —— |
| Hero FOLD | 0 | 2200 | true | `LAYER + UNCALLED_BET_RETURN(2200)`（恰好一次） |

---

## 12. 简化退款公式是否仍存在

**存在，但已被限定作用域并改名。**

| 项 | 内容 |
|---|---|
| 公式 | `未匹配超额 = 我的投入 − 其他所有人的最高投入` |
| 新函数名 | **`computeHeadsUpClosedRoundUnmatchedReturn(state, playerId)`**（名字体现限定条件） |
| 断言 | `assertHeadsUpUnmatchedScope(state)`：**轮次已关闭**（≤1 人能行动）+ **未弃牌者 ≤ 2**，违反即**抛错** |
| 作用域字段 | `LayeredPot.scope = HEADS_UP_CLOSED_ROUND \| LEDGER_LAYERED`（+ 中文说明） |
| 交叉复核 | 单挑关闭轮次时，台账口径与简化式**互相复算**，不一致即抛错 |

**它没有**被用来冒充通用结算：多人 / 全下 / 边池一律走投入台账分层路径
（`capped_i = min(投入_i, 其他人最高投入)`，层界去重升序，含弃牌者死钱）。

---

## 13. 它现在允许在哪些条件下调用

**仅当三条同时成立**：

1. **下注轮已关闭**：未弃牌者中最多 1 人还能行动（其余全下或只剩一人）
2. **未弃牌者 ≤ 2**：三人以上全下会产生边池 ⇒ 必须走台账
3. 调用方是 `computeLayeredPot` 在 `scope === HEADS_UP_CLOSED_ROUND` 时的**交叉复核**（或测试）

```text
scope === 'LEDGER_LAYERED'  ⇒  调用简化函数 = 抛错（SETTLEMENT-4 锁定）
```

---

## 14. 新增测试数

| 文件 | 条数 | 内容 |
|---|---|---|
| `test/riverConsistencyV21.test.ts`（新） | **16** | ROLE-1..5（5）+ BAND-1..4（4）+ RANGE-1..3（3）+ SETTLEMENT-1..4（4） |
| `test/layeredPotDecision.test.ts`（语义升级） | — | `POT-D10`：容差带内**跟随 EV 排名弃牌**、只标 `MARGINAL`、不得声称数学无差异、依据必须是 `CHIP_EV` |

全部走**真实生产管线**（manual input → reconstruct → context → range → postflop → decision → UI），
**不**断言「必须 CALL / 必须 FOLD」。

---

## 15. Mutation test 结果

| # | 变异 | 必须失败 | 实际失败（用例） |
|---|---|---|---|
| 1 | 让「一对」可以回落到 AIR（短路摊牌价值判据） | ROLE-1 | ✅ ROLE-1、ROLE-2、ROLE-5 |
| 2 | 把 5% 容差重新标成「数学无差异」 | BAND-2 | ✅ R4、R10、BAND-1、BAND-4（守卫报 `ACTION_CONTRADICTS_CHIP_EV`：`动作被标为「数学上无差异」，但 \|跟注 EV\| = 317.6080 已超出浮点余量 0.000001`） |
| 3 | 令 `weakerThanHero` 直接等于 bluff | RANGE-1 | ✅ RANGE-1、RANGE-2、RANGE-3 |
| 4 | Hero 未行动时把 pending 直接转 returned | SETTLEMENT-1 | ✅ R8、R10、BAND-3、SETTLEMENT-1 |
| 5 | 让多人 side-pot 调用简化退款路径 | SETTLEMENT-4 | ✅ SETTLEMENT-4（`多人全下局面必须走投入台账分层路径`） |

**恢复校验**：每次变异后按 SHA-256 核对文件与变异前**逐位一致**
（`relativeHandRole.ts` `AA4146C9…`、`decisionConsistency.ts` `42D655FE…`、
`riverActionClass.ts` `1ADE8FF3…`、`pots.ts` `4AC6C864…`），源码零残留标记。

> ⚠️ 过程记录（诚实披露）：变异 1 的第一版（只改分类器、不改摊牌价值判据）**没有**让 ROLE-1 失败 ——
> 因为兜底规范化仍然拦住了它。我据此把变异改成「短路摊牌价值判据」才复现出缺陷。
> **变异测试本身也需要被验证**：一个不会失败的变异说明测试没覆盖到那条路径。
>
> 另：本轮用 PowerShell 批量替换改过 2 个源文件，导致行尾变成 CRLF 且一次 `edit` 报告「文件已变更」。
> 已全部**改回 LF** 并重新记录 hash；**结论：源码编辑一律用 `edit` 工具，不用 shell 替换**（此前的教训再次生效）。

---

## 16. `npm run verify` 结果

```text
> tsc --noEmit                → 0 错误
> 清单校验                     → 134 个产物一致
> node --test                 → 1,652 项 / 137 套件 / 0 失败 / 0 跳过
```

| 项 | 值 |
|---|---|
| 既有测试删除 | **0** |
| 既有断言放宽 | **0**（`POT-D10` 是语义升级；`R5`/`R6` 只把字段名换成 V2.1 的新名） |
| 新增测试文件 | 1（`test/riverConsistencyV21.test.ts`） |
| 测试文件总数 | 74 |
| 状态文档 | `CURRENT_PROJECT_STATUS.md` §10.0.12 + 数量表同步 |

**未改动**（使用者禁令）：preflop / GTOpen / `legalActions` / 玩家画像 schema / 既有 range tables /
已通过的 Board Delta / Range Compression / Value Gate / 无关 UI / 已通过测试的策略阈值。

---

## 17. 当前真实案例最终输出

**Hero BTN A♣Q♠ ｜ Q♦8♣5♣/2♥/K♣ ｜ 面对 CO 22BB**（实机 `http://127.0.0.1:5173/`）：

```text
建议：弃牌 ｜ 置信度：中低
  成交牌型（我是什么牌）：一对（PAIR）
  相对牌力角色：摊牌价值（SHOWDOWN_VALUE，强度 0.28）
  上一街角色（历史参考）：听牌（DRAW）—— 历史身份，不是当前牌力
  真实 EV 排名（节点增量口径）：FOLD 0.00　vs　CALL -317.61　⇒　**FOLD 更高**
  模型容差带（工程容差，非数学无差异）：±392.50 筹码｜来源：MODEL_UNCERTAINTY_RATIO (5%) × winnable
    ｜不确定性覆盖：未开启（动作严格跟随 EV 排名）
  可达范围（组合数，未加权）：共 410 个组合：更强 112、更弱 292、打平 6
  河牌动作分类（组合数）：价值下注候选 112（明确取值 33 + 薄价值 79）、诈唬候选 156、
    摊牌牌 30、证据不足 112（证据质量 HIGH）　⚠️「更弱」≠「会诈唬」
  对手范围 vs 我的牌（概率质量占比，有分母）：更差 22.1%、更好 74.1%，分母 = 可达 410 个组合
  阻断牌（可达范围逐组合）：挡掉更强的组合 29 个、更弱的组合 63 个；其中经河牌动作分类：
    价值下注候选 29 个、诈唬候选 21 个；净偏好 0.07（证据质量 HIGH，内部评分）
  决策依据：CHIP_EV —— 跟注 EV = -317.61 筹码（弃牌 EV ≡ 0）⇒ 由真实 chip EV 排名判定：FOLD 更高
  一致性检查：通过（动作 / 指标 / 解释属于同一体系）
结算：scope=LEDGER_LAYERED（轮次未关闭 ⇒ 不走简化路径） returned=0 pending=2200 事件=2 重复=0
  · 主池 3450（含已弃牌者投入 150），2 家有资格
  · 尚待跟注 2200（下注轮未结束：还有人可以跟 —— 这**不是**退回，跟注后会并入底池）
```

对照使用者的 10 条验收要求：

| # | 要求 | 结果 |
|---|---|---|
| 1 | MadeHand = PAIR / MIDDLE_PAIR 类 | ✅ `成交牌型（我是什么牌）：一对（PAIR）` |
| 2 | Role 不能 DRAW | ✅ `SHOWDOWN_VALUE` |
| 3 | Role 不能 AIR | ✅ 同上 |
| 4 | 更合理候选：BLUFF_CATCHER 或 SHOWDOWN_VALUE | ✅ `SHOWDOWN_VALUE` |
| 5 | FOLD / CALL EV 数学排序真实显示 | ✅ `FOLD 0.00 vs CALL -317.61 ⇒ FOLD 更高` |
| 6 | 偏离最高真实 EV 必须有非数学 override 标签 | ✅ 本节点**未偏离**；开启覆盖时标 `MODEL_UNCERTAINTY_OVERRIDE` 并声明工程启发式 |
| 7 | stronger/weaker 不得冒充 value/bluff | ✅ 字段改名 + 分类计数（更弱 292 vs 诈唬候选 156） |
| 8 | Hero 尚未行动：returned = 0 | ✅ |
| 9 | pending unmatched 可以存在 | ✅ 2200 |
| 10 | 无重复 settlement | ✅ 事件 2 条、id 唯一、重复 0 |

---

## 18. 是否可以恢复 30 局对抗性测试

**可以恢复，条件比 V2 更明确（因为动作现在由真实 EV 决定）。**

**支持恢复的四条事实**

1. 四个未关闭问题都有**可执行的不变量**（域不变量 / EV 排名 / 分类计数 / 作用域断言），
   且 5 项变异测试证明这些锁**真的会失败**；
2. 动作与指标**强制同体系**：`decisionBasis` 显式写出（`CHIP_EV` / `MATH_INDIFFERENCE` /
   `MODEL_UNCERTAINTY_OVERRIDE` / `PREFERENCE_SCORE` / `SAFETY_RULE`），守卫逐项核对；
3. EV 表达已经**诚实**：真实排名与工程容差分列，界面不再可能出现「负 EV + 跟注 + 数学无差异」；
4. 结算边界明确：决策节点只有 `pending`，`returned` 只在轮次关闭后出现，且事件唯一。

**恢复时必须遵守的四条**

| # | 要求 | 理由 |
|---|---|---|
| 1 | 记录每局的 `decisionBasis` | `MODEL_UNCERTAINTY_OVERRIDE` 的局面（需开启开关）不能用来评价策略；`MATH_INDIFFERENCE` 的局面本身无信息量 |
| 2 | 只统计**方向性分歧**，区分「引擎错 / 引擎对但我没这么打」 | 30 局的结果噪声远大于策略差异 |
| 3 | 样本 < 30 局**不调参** | 前两轮已两次证明「像调参」的其实是口径错位 |
| 4 | 特别关注**新变化**：默认不再给「边缘跟注」 | 与 V2 相比，负 EV 的边缘局面从 CALL 变成 FOLD —— 这是本轮**唯一**的行为变化，需要在真人样本里被观察 |

**仍然不做的部分**

- ❌ 不把 `callEV` 当 solver EV，不换算成收益承诺；
- ❌ 不在没有 ≥30 手证据时依赖 exploit 层（可信度 0 ⇒ 偏移恒为 0，这是设计）；
- ❌ 不为通过某一手而写死动作（本轮**没有**新增任何 `if (A♣Q♠ …) CALL/FOLD` 类分支，
  也没有 `flush-completing river ⇒ FOLD`、`nut blocker ⇒ CALL`、`SPR < 1 ⇒ stack off`）。

**本轮唯一的行为变化（必须如实记录）**：
负 EV 且落在容差带内的局面，默认动作从「跟注（代价最小方向）」改为「**弃牌（跟随真实 EV 排名）**」，
只有显式开启 `allowUncertaintyOverride` 才回到旧行为，且会被标记为工程覆盖。

---

## 附：本轮修改文件清单

| 文件 | 改动 |
|---|---|
| `src/domain/postflop/relativeHandRole.ts` | `MadeHandClass` + `MADE_HAND_CLASS_ZH` + `madeHandClassOf` + `hasShowdownValueOf` + `madeHandRoleInvariantViolation` + `madeHandRoleFacingBet`（P0-1） |
| `src/domain/postflop/riverActionClass.ts` | **新增**：`RiverActionClass` 分类器 + `riverActionCountsOf` 逐组合计数（P1-1） |
| `src/domain/postflop/blockers.ts` | 字段改名 + 分类计数（P1-1） |
| `src/domain/postflop/types.ts` | `OpponentRangeFacts.counts`（整数组合数） |
| `src/app/manualInput/rangeFacts.ts` | 产出 `counts` |
| `src/domain/decision/decision.types.ts` | `MODEL_UNCERTAINTY_RATIO` / `MATH_EV_EPSILON` 常量 + 快照新字段（`madeHand` / `trueEvRanking` / `uncertaintyBandChips` / `allowUncertaintyOverride` / `rangeCounts`） |
| `src/domain/decision/decisionConsistency.ts` | 依据类型改名 + 容差带语义 + 覆盖校验（P0-2） |
| `src/app/decision/decisionEngine.ts` | 动作跟随真实 EV 排名 + 覆盖开关（默认关）+ 河牌 SPR 例外（沿用 V2） |
| `src/app/decision/postflopAdvisor.ts` | 暴露 `madeHand` / `category`；规范化传入摊牌价值 |
| `src/domain/poker/pots.ts` | `SettlementScope` + `assertHeadsUpUnmatchedScope` + `computeHeadsUpClosedRoundUnmatchedReturn` + 交叉复核（P1-2） |
| `src/app/webServer.ts` | 暴露 `scope` / `scopeZh` |
| `src/viewmodels/decisionViewModel.ts` | 成交牌型行 / 真实 EV 排名行 / 容差带行 / 组合数与占比分列 / 阻断牌新文案 |
| `test/riverConsistencyV21.test.ts` | **新增** 16 条 |
| `test/layeredPotDecision.test.ts` | `POT-D10` 语义升级 |
| `test/riverConsistency.test.ts` | R5/R6 字段名同步（断言不变） |
| `CURRENT_PROJECT_STATUS.md` | §10.0.12 + 数量同步 |
