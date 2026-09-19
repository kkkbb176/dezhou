# U1 加注 EV 实现轮 —— 报告（九行格式）

> 依据 `docs/UNCERTAINTY_POLICY.md`（不确定时停止猜测，先取得证据）第 4 节。
> 本轮授权范围：**人工裁决选定的唯一一项** ——
> 「U1 实现加注 EV（方案②公共信息口径 + 方案①独立对照）」。
> U2 / U3 / U5 / U6 **未被选中**，因此本轮**未改动**它们涉及的任何代码或断言。
>
> 结论一句话：**加注 EV 已实现并进入生产比较；本轮不宣告整体 PASS。**
> （政策第 8 条：部分成功必须分开报告 —— 模型已可用，但系数未校准、再加注分支取下界、
> 且方案① 与方案② 在一处节点上给出相反名次，这三项全部留在登记表里。）

---

## 1. 问题是什么

面对下注时，「加注」这个动作在全项目里**没有任何筹码 EV 依据**：
`UN1`（登记表 U1）记录 `checkTree.raiseResponse = 'NOT_IMPLEMENTED'`，
后果是「加注是否比跟注好」无法计算 —— 上一轮只能在**没有 EV 的情况下**禁止它覆盖清晰的 CALL，
这既低估进攻性（小加注可能是 +EV），也无法解释任何一次加注。

本轮解决的问题是：**给加注一个可复算的 EV，并让它按 EV 参与动作比较**；
同时用产品**既有的独立模型**做对照，避免「自己证明自己」。

---

## 2. 已确认的根因

`NOT_IMPLEMENTED`（不是缺陷）：产品里缺三样东西 ——

| # | 缺什么 | 后果 |
|---|---|---|
| a | 他面对我加注的**弃/跟/再加注**概率 | RAISE EV 的第一项、第二项、第三项全都没数 |
| b | **加注继续范围** `EqVsRaiseCallRange` | 无法算「他跟注我时我领先多少」 |
| c | **RAISE EV** 本身 | `actionEvidence` 里 RAISE 永远是 `ev = null` + `estimateType = HEURISTIC` |

---

## 3. 实际复现证据

| 证据 | 文件 | 关键数字 |
|---|---|---|
| 实现前的缺口 | `reports/evidence/ak-candidate-comparison.txt` | 5 个加注金额（80/100/120/160/174）`ev` 全 `null` |
| **实现后 · 生产输出（AK 节点）** | `reports/evidence/rrdv2-acceptance.txt` | `RAISE EV = −5.447466` / `CALL EV = +19.697943` ⇒ 动作 **CALL 40** |
| **实现后 · 正向可达（99 暗三条）** | `reports/evidence/u1-raise-fields-probe.txt` | `RAISE MODEL_EV = +140.011825` > `CALL EV = +79.218472` ⇒ 动作 **RAISE 174**（`RAISE_TO_ALL_IN`） |
| 方案① vs 方案② 独立对照 | `reports/evidence/u1-raise-ev-crosscheck.txt` | 8 个节点、7 个可比：**符号 7/7 一致**；量级不同 |
| 尺寸轴单调性 | `reports/evidence/u1-response-monotonicity.txt` | 6 个节点 / 29 个尺寸点：弃↑、继续↓、再加注↓ **无一次违反** |
| F-01 节点动作变更 | `reports/evidence/u1-f01-probe.txt` | `CALL +24.01` vs `RAISE +12.94`（P(弃) 95.8%）⇒ **CALL** |
| 全仓测试 | `CURRENT_PROJECT_STATUS.md` | **1,922 项 / 137 套件 / 96 个测试文件**，全绿 |

**新增测试**（全部跑生产链路，不是文案断言）：

| 文件 | 条目 |
|---|---|
| `test/raiseResponseU1.test.ts` | U1-1 公共信息（不读 Hero 底牌）｜U1-2 数学确定的单调性｜U1-2b **已知局限变更探测器**｜U1-3 非退化（81 组极端画像 × 3 尺寸）｜U1-4 Hero 全下 ⇒ 权重迁移到跟注｜U1-5 生产路径正向可达｜U1-6 全下保护规则四组合｜U1-7 两模型 RAISE EV 同号｜U1-8 非法输入返回 null |
| `test/riverRaiseDecisionV2.test.ts` | V2-15 披露一致性（加注胜出侧）｜V2-17 披露一致性（加注落败侧：「算过但更低」不得说成「没算过」）｜V2-16 生产路径动作形态 / 去重自洽 |
| `test/alphaRedteamRegression.test.ts` | F-01 由「必须加注」改为「动作必须等于 EV 排名第一」（**更强**，见 §6） |

---

## 4. 已经验证的修复

### 4.1 生产模型（方案②，公共信息口径）

新增 `src/app/manualInput/raiseResponse.ts`：

```text
RAISE EV = P(弃)·pot + P(跟)·(EqVsRaiseCallRange·(pot + 2·增量) − 增量) + P(再加注)·(−增量)
零点 = 弃牌（与 CALL EV 同一口径）

强度 = 公共强度带（9 档，`publicStrengthBandOf`）+ 听牌可玩性       ← 不读 Hero 底牌
门槛 = 价格 + 余量（河牌 0.10）      价格 = 增量 / (底池 + 2×增量)   ← 数学确定
继续指数 = 强度 × callScale − 0.05 × foldScale                      ← 画像
```

接入点：`contextBuilder` 第 4d 步（`raiseResponseFacts`）→ `decisionEngine` 里以
`EstimateType.MODEL_EV` 进入 `actionEvidence`，与 FOLD（EXACT 0）、CALL（PROXY_EV）正面比 EV。
尺寸纪律：**只有决策层选中的尺寸 = 模型算 EV 的尺寸**才允许使用该 EV
（与隔离加注 `isoUsable` 同一条纪律）。

### 4.2 独立对照（方案①）

`scripts/u1-raise-ev-crosscheck.ts`：把产品既有的 `classifyResponse` 的价格换成加注赔率，
在同一批节点上独立算 RAISE EV。**符号 7/7 一致** ⇒ 生产模型没有给出与既有模型方向相反的结论。

### 4.3 本轮顺带修掉的三处**呈现层**自相矛盾（纯披露，不改任何数值与动作选择）

| 编号 | 修复前（实测） | 修复后 |
|---|---|---|
| U10 | 99 暗三条节点动作 = RAISE @174（依据 MODEL_EV +140.01），`unevaluatedActions` 却列着「RAISE 174 RAISE_EV_NOT_IMPLEMENTED」，`factReasons` 还说「本次加注**没有** EV 模型」 | 有自有 EV 的尺寸由 `allInGuard.raiseSizesWithOwnEV` 单一事实来源带出，未评估清单只剩 80/100/120/160；文案改为「**部分**加注金额没有 EV」 |
| U11-A（加注**胜出**侧） | 首屏理由写「⚠️ 加注的 EV 无法计算」，**而该动作正是由该 EV 选出的** | 新增 `RAISE_MODEL_EV` 路径，如实报出 `RAISE EV 140.01 vs 跟注 79.22` + 响应权重 + 未校准声明 + 下界说明 |
| U11-B（加注**落败**侧） | AK 河牌节点首屏写 `RAISE（87.0BB）… EV = NOT_AVAILABLE（缺 fold-to-3bet …）`，**而证据表里就有** `RAISE MODEL_EV = −5.4475 < CALL +19.6979` | 新增 `RAISE_MODEL_EV_LOSES` 路径：`**有**面对加注的响应模型 EV = -5.45 筹码 ⇒ 本次比较是**算出来的**：跟注 19.70 更高 ⇒ 不加注`；另 `MATH_CALL_SUPPORTED` 补「（本句只比较 CALL 与 FOLD）」 |

根因（三处同源）：`unevaluatedActions` 用 `candidate.ev === null` 当作「没有 EV 模型」的代理，
而**加注候选的 `ev` 字段永远是 null**（加注 EV 挂在证据表上）；RAISE 的两条分支
（胜出 / 落败）只认「隔离加注模型」与「战略启发式」，U1 的模型路径没有对应分支。
**「算过但更低」（结论）与「没算过」（能力缺口）不能共用一句话** —— 这是三处的共同教训。

---

## 5. 仍然不确定的部分

| 编号 | 内容 | 分类 |
|---|---|---|
| U1 残余 ① | `RAISE_RESPONSE_BAND_STRENGTH`（9 档）、价值/诈唬再加注份额、河牌余量 0.10 **全部未校准**；仓库内**没有**「按手牌类别的面对加注继续频率」数据源 ⇒ **不得调参** | `MODEL_LIMITATION` |
| U1 残余 ② | 再加注分支取下界（`MODEL_EV_WITH_LOWER_BOUND_RERAISE_BRANCH`，一律按 `−增量`）⇒ RAISE EV **系统性偏低** | `MODEL_LIMITATION` |
| U1 残余 ③ | **方案① 与方案② 在一处节点上名次相反**：99 暗三条 方案② +140.01 / 方案① +67.92 / CALL +79.22 ⇒ 方案② 选 RAISE、方案① 会选 CALL。符号一致**不足以**证明可直接生产比较 | `INCONCLUSIVE`（需裁决） |
| U9 | 「加注越大 ⇒ 他越少跟注」**不成立**：跟注率是尺寸的**锯齿轮**（再加注门槛随价格上移，把中强牌从再加注桶搬进跟注桶）。实测最大 +2.32pp（AK·NORMAL 40→60）；AK·CS 与 99 暗三条从最小加注到全下**净上升**。两种改法都会改变所有节点的 RAISE EV ⇒ 未修 | `MODEL_LIMITATION`（需裁决） |
| U12 | F-01 节点动作 **RAISE → CALL**，推翻了一条既有验证过的契约 | `INCONCLUSIVE`（需裁决） |

**未做全节点扫描**：本轮只抽样 5 个节点（AK×3 画像 / 99 暗三条 / AJ 空气）+ 2 个既有节点，
其中动作发生变化的是 99 暗三条（CALL→RAISE）与 F-01（RAISE→CALL）。
「加注从启发式变 EV」对**全部面对下注节点**的影响面尚未统计 —— 这是下一步第一件事。

---

## 6. 是否改变了原有策略

**是**，分三类，全部有实测数字：

| 节点 | 变化 | 依据 |
|---|---|---|
| AK 河牌 vs 40（三个画像） | CALL 40（未变，但**依据变了**） | 由「无 EV ⇒ 被拦」变为 `RAISE EV −5.45 < CALL +19.70` |
| 99 河牌 100BB | CALL → **RAISE 174** | `MODEL_EV +140.01 > CALL +79.22`（`SUPPORTED_ACTION_PRIORITY`） |
| 99 河牌 400BB | RAISE 160（未变） | — |
| TEST 4（AA 转牌） | CALL（未变） | — |
| AA 面对 3bet（翻前） | RAISE 56（未变） | 翻前加注 EV 仍缺 ⇒ 走启发式 + 披露 |
| **F-01（flop KK vs 6BB）** | RAISE 48 → **CALL** | `CALL +24.01 > RAISE +12.94`（P(弃) 95.8%） |

**测试契约变更（1 处，已注释、非静默放宽）**：F-01 由「必须选 RAISE」改为
「动作必须等于 EV 排名第一」+「RAISE 可达由另一个 EV 支持加注的节点证明」。
新断言**更强**：它要求诊断里的证据表可复算出动作，而旧断言只要求一个动作名。
F-01 的原始意图（`pickCandidate` 永不返回 RAISE 的结构性缺失）仍被锁定（V2-16）。

**未改动**：手牌评估器、画像解析器、翻前范围、无关的面对下注响应模型、
`EqVsBetRange` 的口径、全下保护规则、候选去重 —— 全部逐位不变。

---

## 7. 是否存在回归风险

| 风险 | 等级 | 说明与现状 |
|---|---|---|
| 加注由启发式变 EV ⇒ 动作面变化 | **中** | 已抽样 5+2 个节点；**未做全扫描**（下一步第一件事） |
| U9 锯齿 ⇒ 大尺寸 RAISE EV 偏高 | 中 | 已在登记表登记并与 U1 残余 ④ 联动披露；修它会改策略 ⇒ 等裁决 |
| F-01 类「强牌面对小注」契约 | 中 | 已登记 U12，等人工确认期望动作 |
| 呈现层改动破坏既有断言 | 低 | 全仓 1,922 项通过；RD-1 在 `ev !== null` 时本就跳过；V2-5 的加注理由查询在翻前启发式节点上，不受影响 |
| 尺寸对不上却使用 EV（冒充） | 低 | 尺寸匹配纪律由 V2-15 + `raiseModelUsable` 双重约束 |

**未发现**规模性翻转（抽样范围内仅 2 个动作改变），但**不能**据此声称全仓无回归 —— 见 §5 的未扫描说明。

---

## 8. 建议下一步

1. **全节点扫描**（最高优先）：把所有既有节点跑一遍，统计「加注从启发式变 EV」导致的动作变化清单 ——
   这是判断本轮是否可接受的前提。
2. **U9 单变量对照**：分别实现「再加注门槛与价格无关」与「按继续范围相对分位」两版，
   量化多少节点的动作会变，再决定是否采纳（**在此之前不得改**）。
3. **取数校准**：需要外部数据源「按手牌类别的面对加注继续频率」；在拿到之前**不得**调参。
4. 翻前加注 EV（3bet/4bet 响应数据）仍缺 —— 属**另一个** `NOT_IMPLEMENTED`，本轮未涉及。
5. 工程卫生：`decision.reasons` 被 `slice(0, 6)` 截断，披露可能进不了首屏（U10 未决部分）；
   新增的 U1 文件未登记进 `src/infra/artifactDefinitions.ts`（登记表是人工清单，不影响测试）。

---

## 9. 是否需要人工裁决

**是。** 三项：

| # | 裁决内容 | 选项 |
|---|---|---|
| 1 | **U12**：F-01 节点的期望动作 | (a) 接受 CALL（承认「三条面对 96% 弃牌率，跟注更好」）；(b) 认为三条必须加注 ⇒ 那要改的是**响应系数**（U1 残余 ①），**不是**测试 |
| 2 | **U1 残余 ③**：方案① 与方案② 在 99 暗三条上名次相反 | (a) 接受方案②（公共信息口径更干净）；(b) 要求两者名次也必须一致才允许生产使用 ⇒ 需先解释差异来源 |
| 3 | **U9**：跟注桶锯齿是否可接受 | (a) 接受（现有口径在「同一手牌价格越差不该再加注」的意义上是对的）；(b) 改为单调实现（会改变所有节点 RAISE EV，需重新验收） |

---

## 附：本轮产物清单

**新增产品代码**：`src/app/manualInput/raiseResponse.ts`（模型）
**修改产品代码**：`src/app/decision/decisionEngine.ts`（EV 接入 + 3 处披露层修复）、
`src/domain/decision/decision.types.ts`（类型）、`src/app/manualInput/contextBuilder.ts`（第 4d 步，上一轮已落）
**新增测试**：`test/raiseResponseU1.test.ts`；修改 `test/riverRaiseDecisionV2.test.ts`、`test/alphaRedteamRegression.test.ts`
**新增证据脚本**：`scripts/u1-response-monotonicity.ts`、`scripts/u1-raise-fields-probe.ts`
（另有上一轮的 `scripts/u1-raise-ev-crosscheck.ts`、`scripts/u1-f01-probe.ts`）
**新增证据**：`reports/evidence/u1-response-monotonicity.txt`、`reports/evidence/u1-raise-fields-probe.txt`
**登记表**：`reports/UNCERTAINTY_REGISTER.md`（U1 改写为「已实现 + 残余」；新增 U9/U10/U11/U12）
**状态文档**：`CURRENT_PROJECT_STATUS.md`（测试 1,922 项 / 137 套件 / 96 文件；产物 157）
**产物清单**：`data/artifact-manifest.json`（已按 `scripts/generateManifest.ts` 重新生成）
