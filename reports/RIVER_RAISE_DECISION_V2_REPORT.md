# RIVER RAISE DECISION V2 —— 定向修复与墨菲定律验收报告

**范围**：只修五件事（证据优先级 / 无 RAISE EV 时的裁决 / 河牌全下保护 / RAISE≡ALL-IN 去重 / 条件权益口径）。
未触碰人物画像 Resolver、Betting Range V2 权重、翻前范围、牌力求值器、UI、跨街 Solver。
**没有硬编码 AK**：AK 节点的新结果由规则推出，且同一套规则在暗三条/翻前节点上给出**不同**结果（见 §9 对照表）。

# 最终裁决：`RIVER_RAISE_DECISION_V2 — PASS_WITH_WARNINGS`

| 结论 | 判定 | 依据 |
|---|---|---|
| `NO_UNSUPPORTED_RAISE_OVERRIDE` | **YES** | AK 节点：`CALL`（40），来源 `SUPPORTED_ACTION_PRIORITY`，`evidenceScope = CALL_PROXY_ONLY`；无 EV 的打光筹码加注**没有**任何覆盖路径（`shouldRaise` 直接 false + `commitsStack` 收窄覆盖权限）。V2-1/V2-11 锁定 |
| `CALL_EV_PRESERVED` | **YES** | `CALL EV = +19.697943 = 0.448857 × 133 − 40`（恒等式逐位成立）；四种画像下均成立（V2-11） |
| `RAISE_EV_MISSING_HANDLED` | **YES** | `RAISE.ev` 保持 `null`、`estimateType = HEURISTIC`；诊断新增 `unevaluatedActions`（`RAISE_EV_NOT_IMPLEMENTED`）与事实理由；**未**参与 EV 比较、**未**被当作 0（V2-6/V2-12） |
| `ALL_IN_DEDUPLICATED` | **YES** | 候选表不再同时出现 `RAISE 174` 与 `ALL_IN 174`；动作形态由 `actionShape`（`NORMAL_RAISE` / `RAISE_TO_ALL_IN` / `DIRECT_ALL_IN`）显式区分（V2-3/V2-4） |
| `ONE_PAIR_PROTECTION_VALID` | **YES** | 判据由底池比例改为**真正的打光判定**（`raise-to ≥ allInToAmount`）+ 牌力类别 + 是否自有 EV。AK 命中（拦截）、暗三条不命中（V2-2/V2-10）；河牌深筹码下的暗三条加注仍然可达（§9 对照） |
| `RIVER_BET_RANGE_V2_PRESERVED` | **YES** | `EqVsArrivalRange = 0.755247`、`EqVsBetRange = 0.448857`、到达范围尺寸不变性、SHOWDOWN 非零、无隐藏底牌泄漏、`FoldTo` 不进主动下注 —— 全部逐位复现（§8） |
| `SAFE_TO_CONTINUE_HAND_TESTING` | **YES（附警告）** | 全仓 **1,910 项 / 1,910 通过**；typecheck 与产物清单通过；13 项新测试覆盖 M1–M10。警告见 §10（三处口径取舍 + 加注 EV 仍缺） |

---

## 一、核心目标（本轮修的 5 件事）

| # | 修复项 | 状态 |
|---|---|---|
| 1 | 最终动作的证据优先级 | ✅ `evidencePriority.ts` 的覆盖口子按「是否打光筹码」收窄 |
| 2 | 无 RAISE EV 时的动作裁决 | ✅ 只在**可评估**候选间裁决 + 显式披露未评估动作 |
| 3 | 河牌一对牌全下保护 | ✅ 两层判据（精确全下 + 底池比例档）+ 自有 EV 例外 |
| 4 | RAISE / ALL-IN 同额去重与合法性 | ✅ 候选去重 + `actionShape` 区分三种形态 |
| 5 | 条件范围语义 | ✅ 加注门槛改用与 CALL EV 同一个条件权益并标注来源；`EqVsRaiseContinueRange = NOT_IMPLEMENTED` 显式分列 |

---

## 二、先写失败测试（第二阶段）

`test/riverRaiseDecisionV2.test.ts`（13 项，全部调用 `analyzeManualHand` 生产链）：

```text
修改前：✖ 9 / ✔ 4
  ✖ V2-1  M1：CALL EV 为正且边际 CLEAR，无 EV 的启发式加注不得覆盖它
          AssertionError: CALL EV = 19.697942509917368（边际 CLEAR）被一个没有 EV 的加注覆盖：
                          action=RAISE size=174（打光筹码）raise.ev=null
  ✖ V2-2  §四：一对牌 + 打光筹码 + 无 RAISE EV ⇒ 不得升级成全下
  ✖ V2-3  M7：同额 RAISE 与 ALL_IN 不得重复计入候选 → [["174",["RAISE","ALL_IN"]]]
  ✖ V2-4  M6：动作形态（普通加注/加注到全下/直接全下）必须可区分 → 无 actionShape
  ✖ V2-5  §六：加注门槛不得用 math.heroEquity 顶替 / 条件权益必须分列
  ✖ V2-6  §三：必须披露未评估的合法动作 → 无 unevaluatedActions
  ✖ V2-10 M5：一对牌与暗三条必须被分别判断 → 无 allInGuard
  ✖ V2-11 M8：换画像后证据优先级语义一致
  ✖ V2-12 M9：未实现的 EV 必须标注 NOT_IMPLEMENTED → 无 conditionalEquities
修改后：✔ 13 / ✖ 0
```

---

## 三、证据优先级（第三阶段）

### 修改位置

| 文件 · 函数 | 改动 |
|---|---|
| `src/domain/decision/evidencePriority.ts` · `chooseByEvidencePriority` ②-a | 覆盖清晰量化赢家的例外**只保留给不消耗筹码的动作**（`ActionEvidence.commitsStack !== true`）；打光筹码时返回量化赢家并写明 `overrideBlockedReason = CANNOT_OVERRIDE_CLEAR_SUPPORTED_CALL_WITH_UNEVALUATED_ALL_IN` |
| 同上 · 模块说明 | 明确写下新规则表（不消耗筹码 ✅ / 打光筹码 ❌）与它的理由 |
| `src/app/decision/decisionEngine.ts` · 加注证据行 | 新增 `commitsStack`（= 这次加注是否把剩余筹码全部投入） |

### Before / After（AK 节点）

| 项 | Before | After |
|---|---|---|
| `decisionSource.kind` | `STRATEGIC_HEURISTIC` | **`SUPPORTED_ACTION_PRIORITY`** |
| `evidenceScope` | `CALL_CLEAR_CALL_OVER_FOLD_OVERRIDDEN` | **`CALL_PROXY_ONLY`** |
| `overrideAttempt` / `overrideBlockedReason` | `RAISE_HEURISTIC` / `null` | `null` / `null`（加注**在门槛层就被拦下**，没有产生覆盖尝试） |
| 最终动作 | RAISE 174（全下） | **CALL 40** |

### 四条禁令的落实

| 禁令 | 落实方式 |
|---|---|
| 不允许启发式 RAISE 仅凭正 CALL EV 覆盖 CALL | 打光筹码的加注在 `shouldRaise` 就返回 false；即便通过，`commitsStack` 也剥夺其覆盖权 |
| 不允许通过 `overrideJustification` 绕过 EV 证据门 | ②-a 分支的条件加上了 `commitsStack !== true` |
| 不允许把 `VS_FOLD_ONLY` 解释成 RAISE 优于 CALL | 该作用域注记保持不变，并新增「本次动作是在**可评估**候选之间的裁决」的明示 |
| 不允许把 `ev=null` 当作 0 或虚构正 EV | 未改动既有规则，并由 V2-12 锁定（`HEURISTIC ⇔ ev === null`） |

---

## 四、河牌全下保护（第四阶段）

### 三种形态的区分

| 形态 | 判据 | 本节点 |
|---|---|---|
| 普通加注 | `raise-to < allInToAmount` | 80 / 100 / 120 / 160 |
| **加注到全下** | `raise-to = allInToAmount` | **174（= 全下 87BB）** |
| 直接全下 | 独立的 `ALL_IN` 动作 | 只在尺寸网格不含全下额时存在（已去重） |

`actionShape` 现在把这些形态写进诊断（`kind` / `sizeChips` / `allInToAmount` / `consumesStack` / 中文注记）。

### 两层保护（不再只靠 `raiseTo / pot > 2.5`）

```text
① 精确的「打光筹码」：raise-to ≥ allInToAmount
   ⇒ 牌力类别 < 3（一对及以下）且 **该加注没有自己的 EV** ⇒ 拦截
② 原有的底池比例档：raise-to / pot > 2.5
   ⇒ 牌力类别 < 3 ⇒ 拦截（管「没打光但已经很重」的加注）
```

本节点实测：`174 / 93 = 1.871 ≤ 2.5`（旧判据不触发）但 `174 = allInToAmount` ⇒ **① 命中**：

```text
ALL_IN_GUARD = onePairAllInBlocked=true｜consumesStack=true｜handCategory=2 < 3｜hasOwnEV=false
```

**没有永久禁止全下**：`hasOwnEV = true`（例如隔离加注模型给出可比 EV）时 ① 不拦；
`test/riverRaiseDecisionV2.test.ts` 的 V2-8 锁定「加注自带 MODEL_EV 且更高 ⇒ 裁决必须选 RAISE」。
**也没有无条件删除合法加注**：非全下加注的覆盖权限保留（AA 面对 3bet 仍然 4bet 到 56；河牌 400BB 深筹码下暗三条仍然加注到 160，见 §9）。

---

## 五、启发式守卫逐条（AK 节点）

| 项 | 值 | 说明 |
|---|---|---|
| `roleStrength` | **0.62** | 相对牌力角色「中等价值」 |
| `handCategory` | **2** | 一对（阈值 `MIN_CATEGORY_FOR_LARGE_RAISE = 3`） |
| `SPR` | **1.441** | ≤ 1.5 ⇒ `commitment.band = COMMITTED`、`stackOffAllowed = true` |
| `stackOffAllowed` | **true** | **但它现在不再能单独放行加注** |
| `commitmentException` | **false**（实际条款 = `null`） | 河牌上整条承诺通道关闭 |
| `raiseToPotRatio` | **1.871** | ≤ 2.5 ⇒ 旧档位保护不触发 |
| `consumesStack` | **true** | raise-to 174 = 全部剩余 |
| `overrideJustification` | **null** | 本次没有触发任何放行论证 |
| 放行条件 ① | `edge ≥ 0.30 且 tier = MONSTER` → **false** | tier = MEDIUM |
| 放行条件 ② | `edge ≥ 0.15 且 tier ∈ {MONSTER, STRONG}` → **false** | 同上 |
| 放行条件 ③ | `承诺例外 且 edge ≥ 0.09` → **false** | **河牌关闭** |

### 修复「低 SPR 例外 / roleStrength 条款」描述不一致

修复前：`commitmentException = stackOffAllowed && (roleStrength ≥ 0.55 || 河牌恒 false 的第二款)` ——
只有第二个条款带河牌守卫，于是河牌上第一条照旧放行，而注记却写着「低 SPR 承诺放行」。
实测放行 AK 那次全下的正是**第一条**。

现在：**河牌上 `commitmentException` 恒为 false**（与 `commitment.ts` 自己生成的注记一致：
「河牌没有下一街，SPR 只作背景信息……不构成打光的理由」），并且
`commitmentClause` 会如实上报实际触发的是 `ROLE_STRENGTH` 还是 `FUTURE_STREET_COMMITMENT`
（`allInGuard.commitmentClause`），不再让注记与真实原因各说各话。

**其他可绕过证据门的通道**（统一纳入）：

| 通道 | 处理 |
|---|---|
| `overrideJustification`（`LOW_SPR_COMMITMENT` / `MONSTER_STRENGTH_DOMINANCE`） | 打光筹码时**不再构成覆盖授权**（仍作为「启发式本来想怎么做」的如实叙述） |
| `commitmentException → qualifies` | 河牌关闭；非河牌保留（保住 turn/flop 的低 SPR 承诺契约） |
| `MAX_RAISE_TO_POT_RATIO` 的近似 | 保留为第二层，另加精确全下判定 |
| 全下候选的孪生条目 | 去重（`RAISE(全下)` 不再与 `ALL_IN` 并列） |

---

## 六、条件权益口径（第六阶段）

| 字段 | 值 | 条件事件 | 用途 |
|---|---|---|---|
| `EqVsArrivalRange` | 0.755247 | P(手牌 \| 全部动作，**不含**本次下注) | 报告 / 与下注范围对比 |
| `EqVsBetRange` | **0.448857** | P(手牌 \| 他选择下注 40) | **CALL EV** 与 **加注门槛**（同一个条件权益） |
| `math.heroEquity`（整体范围） | 0.659153 | P(手牌 \| 本手全部动作) | 相对牌力角色 / tier **（不再进加注门槛）** |
| `EqVsRaiseContinueRange` | **NOT_IMPLEMENTED** | P(手牌 \| 他下注且他跟注我的加注) | 缺失 ⇒ **不产生加注 EV**，也不做任何替代 |

修复前：加注门槛读 `math.heroEquity`（0.659153 ⇒ edge 35.8pp），CALL EV 读 `EqVsBetRange`
（0.448857 ⇒ 同口径 edge 只有 14.8pp）—— 同一节点两个动作被两把尺子量，
用户看到的「高出所需 35.8 个百分点」与同段的「CALL EV +19.70」对不上
（若真按 65.9% 算，CALL EV 应为 +47.67）。
现在加注门槛与 CALL EV 共用 `EqVsBetRange`，并在诊断里写明
`conditionalEquities.usedByRaiseThreshold = EqVsBetRange`（回落时写 `FALLBACK_WHOLE_RANGE`，不静默）。

---

## 七、墨菲定律 M1–M10

| 编号 | 断言 | 结果 |
|---|---|---|
| M1 | CALL EV 为正 + RAISE EV 缺失 ⇒ 启发式不得覆盖 | ✔ V2-1（修前红） |
| M2 | CALL EV 为负 + RAISE EV 缺失 ⇒ 不得凭空认定加注正 EV | ✔ V2-7 |
| M3 | CALL EV 为正且 RAISE EV 更高 ⇒ 保留加注选择 | ✔ V2-8（`MODEL_EV` 更高 ⇒ RAISE 胜出） |
| M4 | CALL EV 为正但 RAISE EV 更低 ⇒ 不得选 RAISE | ✔ V2-9 |
| M5 | 强价值牌与弱一对牌分别判断 | ✔ V2-10（AK 命中保护 / 暗三条不命中） |
| M6 | 短筹码下普通加注与全下的识别 | ✔ V2-4（`actionShape` 与金额自洽） |
| M7 | 同额 RAISE 与 ALL-IN 不得重复计入 | ✔ V2-3（修前红） |
| M8 | 换画像后 CALL EV / Bet Range / 证据优先级语义一致 | ✔ V2-11（修前红） |
| M9 | 未实现动作 EV 必须保持 null / NOT_IMPLEMENTED | ✔ V2-12（修前红） |
| M10 | 所有已算 EV 同一筹码口径与决策时点 | ✔ V2-13（FOLD ≡ 0、CALL = `math.callEV`、容差带 = 0.05 × 同一 winnable） |

---

## 八、回归保护（第八阶段）

### 8.1 关键回归文件显式复跑（13 个文件 / 153 项，全绿）

```text
test08P0Audit / test09BetRangeAudit（BR-1…BR-13） / profileResolverV3Fix（TEST 12）
riverConsistency / riverConsistencyV21 / profileRangeAdjustment（T1…T13）
multiLimpIsolation（ISO_RAISE_MODEL_EV 可达性） / preflopEvidencePriority（T1…T7，含 AA 面对 3bet 必须加注）
postflopRegressionCases（TEST 1…4b） / riverBetRangeV2 / riverBetRangeV2Defect
riverRaiseDecisionAudit（RD-1…RD-4） / riverRaiseDecisionV2（V2-1…V2-13）
= 153 项 / 153 通过 / 0 失败
```

### 8.2 RIVER BET RANGE V2 未回退（逐位复现）

| 项 | 结果 |
|---|---|
| `EqVsArrivalRange` | 0.755247（与 V2 验收值逐位一致） |
| `EqVsBetRange` | 0.448857（逐位一致） |
| 到达范围的尺寸不变性 | 下注 40 与 8 时逐位相同 ✔（`riverBetRangeV2` M1/M6） |
| SHOWDOWN 不再整类清零 | 摊牌类质量 0.443894 > 0 ✔ |
| 无隐藏底牌泄漏 | `usesHeroHiddenCards = false`；M5/D-1 测试 ✔ |
| `FoldTo` 不预测主动下注 | BR-10 单变量扫描逐位不变 ✔ |
| `EqVsBetRange × winnable − callCost = CALL EV` | 恒等式成立 ✔ |

### 8.3 T2 容差放宽（1e-12 → 0.01）是否符合原契约

**结论：符合，但它是上一轮唯一的真实放宽，本轮再次如实记录。**

- 被放宽的只有 `BLUFF_HEAVY ≤ MANIAC` 这一对（实测差 0.0007pp）：两个原型在 `aggression` 上也不同，
  两条通道方向相反，所以「更爱诈唬 ⇒ 权益更高」**不是**它们之间的单调性质；
- 原契约的**方向**仍被更严格的断言锁住：BR-12 要求 `MANIAC > NIT` 严格成立（未改）；
- T2 的另外两处改动（与**到达范围**比较、删掉 FOLD pin）都不是放宽：前者要求
  `betEq < arrivalEq` **严格**成立且两者必须不同（退化时会失败）。
- 本轮**没有**新增任何放宽：`test/riverRaiseDecisionAudit.test.ts` 的 RD-4 撤销了它对
  「本节点必须 RAISE」的 pin（那条本来就是「审计事实，不是要求」），改为锁定与动作无关的金额语义。

### 8.4 没有被删除/跳过的测试

全仓计数由 **1,897 → 1,910**（新增 13 项），无 skip、无 todo、无删除。

---

## 九、最终验收（第九阶段）

```text
FOLD EV = 0
CALL EV = +19.697943
RAISE EV = null（= RAISE_EV_NOT_IMPLEMENTED；estimateType = HEURISTIC，不参与 EV 比较）

最终动作 = CALL（40）
最终动作依据 = SUPPORTED_ACTION_PRIORITY
              （evidenceScope = CALL_PROXY_ONLY；overrideAttempt = null；
                理由链：MATH_CALL_SUPPORTED → CALL_PROXY_EV_POSITIVE +
                        RAISE_STRATEGIC_CANDIDATE「EV = NOT_AVAILABLE」+
                        RAISE_EV_NOT_IMPLEMENTED（事实理由））

RAISE_EV_GUARD   = EV 未实现 ⇒ 未参与比较（ev 保持 null；未评估动作清单里如实列出）
ALL_IN_GUARD     = onePairAllInBlocked=true｜consumesStack=true｜handCategory=2<3｜hasOwnEV=false｜ratio=1.871
EVIDENCE_PRIORITY = SUPPORTED_ACTION_PRIORITY｜canOverrideEvidence=false
```

### 对照表（证明规则不是针对 AK 的固定禁令）

| 节点 | 手牌类别 | 动作 | size | 打光? | 一对牌全下被拦? | 来源 |
|---|---|---|---|---|---|---|
| **AK 河牌（一对，100BB）** | 2 | **CALL** | 40 | false | **true** | SUPPORTED_ACTION_PRIORITY |
| 99 河牌（暗三条，100BB） | 4 | CALL | 40 | false | false | SUPPORTED_ACTION_PRIORITY |
| KK 河牌（暗三条，100BB） | 4 | CALL | 40 | false | false | SUPPORTED_ACTION_PRIORITY |
| **99 河牌（暗三条，400BB 深筹码）** | 4 | **RAISE** | 160 | false | false | STRATEGIC_HEURISTIC |
| **AA 面对 3bet（翻前）** | 0 | **RAISE** | 56 | false | false | STRATEGIC_HEURISTIC |

⇒ 合法加注**没有被无条件删除**；河牌上的加注也没有被一刀切禁掉（深筹码下的暗三条仍然加注）；
保护只对「一对及以下 + 真正打光筹码 + 没有自有 EV」生效。

---

## 十、未解决的模型假设与警告（必须随结论一起读）

1. **加注 EV 仍然不存在**（本轮明确不做完整 Raise Solver）：
   `EqVsRaiseContinueRange` / `P(他面对加注的弃/跟/再加)` 全部 `NOT_IMPLEMENTED`。
   直接后果：河牌上**打光筹码**的加注在当前证据体系里**无法被证明**，
   因此引擎会更保守（AK 从「加注 87BB」变成「跟注 20BB」；暗三条在 100BB 时同样跟注）。
   一旦补上 Raise-Continue Range 与 RAISE EV，它会自动以 `MODEL_EV` 参与同一张证据表并可获胜
   （V2-8 已预演该路径）。
2. **一处口径取舍（需要明确知悉）**：§三的字面要求是「CALL EV 有效 + RAISE EV 未建模 ⇒ 不允许启发式覆盖」。
   本轮实现把这条禁令精确施加在**打光筹码**的加注上，而**保留**了非全下加注的覆盖权
   （AA 面对 3bet 的 4bet、深筹码河牌的暗三条加注）。
   理由是 §八 同时要求「现有合法加注功能没有被无条件删除」，两者只有在「是否打光筹码」这条线上才能同时满足。
   如果要求连非全下加注也不得覆盖，只需把 `commitsStack !== true` 这个条件去掉 —— 但那会同时
   打断仓库中已被 `preflopEvidencePriority.test.ts`（T7）与 `multiLimpIsolation` 锁住的价值加注契约。
3. **`math.heroEquity` 与 `EqVsBetRange` 仍是同一条件概率的两个估计**（链条后验 vs 专用下注模型），
   两者可以相差二十余个百分点。本轮把**加注门槛**改成与 CALL EV 同源，
   但决策层的其他部分（相对牌力角色、tier、gate）仍读 `math.heroEquity` —— 那属于决策层口径统一，超出本轮范围。
4. **`MIN_CATEGORY_FOR_LARGE_RAISE = 3` 与 `MAX_RAISE_TO_POT_RATIO = 2.5` 仍是结构性常数**，
   没有真实统计支撑；本轮只是让「打光筹码」这条判据**精确**，没有重新标定它们的取值。
5. **`EqVsRaiseContinueRange` 一旦实现，必须自带响应概率**（`P(弃)/P(跟)/P(再加)`）
   与同一零点（弃牌 ≡ 0）的筹码 EV；否则会重演「用一个条件权益顶替另一个」的旧缺陷。

---

## 十一、改动清单

| 文件 | 改动 |
|---|---|
| `src/domain/decision/evidencePriority.ts` | `ActionEvidence.commitsStack`；②-a 覆盖条件收窄；模块规则说明改写 |
| `src/app/decision/decisionEngine.ts` | 候选去重；`shouldRaise` 精确全下保护 + `hasOwnEV` 例外；加注门槛改用 `EqVsBetRange` 并标注来源；河牌关闭承诺通道并上报实际条款；新增 `actionShape` / `allInGuard` / `unevaluatedActions` / `conditionalEquities` 诊断与 `RAISE_EV_NOT_IMPLEMENTED` 事实理由；证据表带 `commitsStack` |
| `src/domain/decision/decision.types.ts` | 上述四个诊断字段的类型 |
| `test/riverRaiseDecisionV2.test.ts`（新） | 13 项：缺陷复现（修前 9 红）+ M1–M10 |
| `test/riverRaiseDecisionAudit.test.ts` | RD-4 撤销对动作的 pin（改为锁金额语义） |
| `scripts/rrdv2-acceptance.ts`（新） | 第九阶段验收探针 |
| `reports/evidence/rrdv2-acceptance.txt` | 验收原始输出 |

**全仓验证**：`tsc --noEmit` 通过；`generateManifest --check` 通过；
`node --test --experimental-strip-types "test/**/*.test.ts"` = **1,910 项 / 1,910 通过 / 0 失败**。
