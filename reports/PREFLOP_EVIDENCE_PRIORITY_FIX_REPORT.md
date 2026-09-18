# PREFLOP EVIDENCE PRIORITY FIX — REPORT

> **日期**：2026-09-17 · **性质**：只修「动作证据优先级与 fallback 权限」
> **回归**：`npm run verify` → **1,720 项 / 137 套件 / 0 失败**，TypeScript 0 错误，产物清单 140 项一致。
> 未扩展 3bet EV 模型、未改 AJs 策略、未改画像参数、未改任何旧节点输入。

---

## A. 根因

固定节点（6-max 1/2，Hero CO A♠J♠，HJ open 3BB）修复前的实际代码路径：

```ts
// decisionEngine.pickCandidate（面对下注分支）
if (verdictEdge !== null && ((evEdge !== null && evEdge < -MATH_EV_EPSILON) || ...)) return foldCandidate;
const callSupported = (evEdge !== null && evEdge > MATH_EV_EPSILON) || ...;
if (callSupported) {
  reasons.push({ code: 'MATH_CALL_SUPPORTED', ... });     // ← CALL 的证据到此已经算清楚
  // …然后**无条件**尝试加注：
  if (raiseCandidate !== null && shouldRaise(equity, requiredEquity, tier, size, pot, category, commit)) {
    reasons.push({ code: 'STRATEGIC_RAISE_FOR_VALUE', ... });
    return raiseCandidate;                                 // ← 直接 return，丢掉 CALL 的证据
  }
  return callCandidate;
}
```

三处缺陷叠加：

1. **没有证据分级**：`CALL` 的 `+2.73 筹码（PROXY_EV，边际 CLEAR_CALL）` 与 `RAISE` 的
   `EV = NOT_AVAILABLE` 在同一个 `if` 里被比较 —— 实际上是**后写的分支直接获胜**。
2. **`shouldRaise` 是战略启发式**（牌力档 + 权益优势 + 量级保护），却拥有**覆盖量化证据**的权力。
3. **命名错位**：这条路径的决策依据对外写成 `SAFETY_RULE`（「安全规则」），
   而它表达的完全是**战略偏好**（「A 带大脚适合加注」）。使用者 §17 的要求：
   Safety 这个名字只留给合法性 / 输入保护。

即：`CLEAR_CALL + 已量化 proxy EV` 被一个 `EV UNKNOWN` 的战略启发式覆盖，且该覆盖被伪装成「安全」。

---

## B. 代码改动

| 文件 | 函数 / 位置 | 目的 |
|---|---|---|
| `src/domain/decision/evidencePriority.ts`（**新增**，纯函数） | `EstimateType`（EXACT/MODEL_EV/PROXY_EV/HEURISTIC/UNKNOWN）、`DecisionSourceKind`（HARD_CONSTRAINT / SUPPORTED_ACTION_PRIORITY / HEURISTIC_TIEBREAK / STRATEGIC_HEURISTIC / FALLBACK）、`ActionEvidence`、`marginOf`、`chooseByEvidencePriority` | **证据层级与覆盖权限的唯一实现**：低质量证据不得覆盖清晰的高质量证据；`UNKNOWN EV ≠ 0`；MARGINAL 允许打断；硬约束最高 |
| `src/app/decision/decisionEngine.ts` | `pickCandidate`（面对下注分支） | 构造 FOLD/CALL/RAISE 三份 `ActionEvidence`，交给裁决函数；CALL 胜出时写 `CALL_PROXY_EV_POSITIVE` / `RAISE_STRATEGIC_CANDIDATE` / `SUPPORTED_EVIDENCE_PRIORITY` 理由链 + `overrideAttempt` / `overrideBlockedReason` |
| 同上 | `pickCandidate` 的出口箱 `evidenceOut` | `pickCandidate` 是独立函数，用显式出口把裁决结果带回 `decideAlpha`（避免两处口径） |
| 同上 | `decisionMargin` 分类 | **复用** `marginOf`（删掉重复的三元表达式）—— 下注分支与决策边际从此同一把尺子 |
| 同上 | `diagnostics` | 新增 `decisionSource`（kind/kindZh/priority/estimateType/canOverrideEvidence/evidenceScope/overrideAttempt/overrideBlockedReason）、`actionEvidence`、`primaryAction`、`alternativeActions` |
| `src/domain/decision/decisionConsistency.ts` | `DecisionBasisKind` / `decisionBasisOf` | 新增 5 个证据来源 kind；`SAFETY_RULE` **只在没有证据来源时**用于加注/全下，且注释写明它已不再表达战略偏好 |
| `src/domain/decision/decision.types.ts` | `DecisionDiagnostics` | 承载上述新字段 |
| `src/viewmodels/decisionViewModel.ts` | `debug.decisionSource` | 可审计三件套：来源 / 优先级 / 被阻断的覆盖尝试 + 每个动作的证据行 |
| `test/preflopEvidencePriority.test.ts`（**新增**） | T1–T7 + 墨菲 | 见 §E |
| `test/riverConsistency.test.ts` | R4 | 独立复算改为读**快照声明的来源**（并新增「加注/全下必须声明来源」断言）—— 见 §E 说明 |

---

## C. 固定 A♠J♠ 节点：修复后完整输出

| 动作 | 合法性 | 证据类型 | EV | 决策边际 | 置信度 | 状态 |
|---|---|---|---|---|---|---|
| **FOLD** | legal | `EXACT` | 0（定义） | CLEAR_FOLD | 1.00 | — |
| **CALL** | legal | `PROXY_EV` | **+2.73 筹码** | **CLEAR_CALL** | 0.95 | **主推荐** |
| **3BET 9BB** | legal | `HEURISTIC` | **null（NOT_AVAILABLE）** | — | 0.50 | 备选：`STRATEGIC_CANDIDATE` |

```text
FINAL            = CALL
decisionBasis    = CHIP_EV（真实跟注 EV 排名）
decisionSource   = SUPPORTED_ACTION_PRIORITY（优先级 3，canOverrideEvidence = false）
evidenceScope    = CALL_PROXY_ONLY
overrideAttempt  = RAISE_HEURISTIC
overrideBlockedReason = CANNOT_OVERRIDE_CLEAR_SUPPORTED_CALL
alternativeActions = [3BET 9BB（HEURISTIC，EV_NOT_AVAILABLE，STRATEGIC_CANDIDATE）]
```

理由链（首屏实际文本）：

```text
[MATH_CALL_SUPPORTED]      估计权益 58.2% 高于所需 40.0%：跟注 EV = 2.73 筹码，弃牌 EV ≡ 0 ⇒ 跟注 EV 更高
[CALL_PROXY_EV_POSITIVE]   CALL：PROXY_EV 2.73 筹码，边际 CLEAR_CALL（±0.75）；⚠️ 代理 EV，不是完整博弈树 EV
[RAISE_STRATEGIC_CANDIDATE] RAISE（9.0BB）：合法候选，EV = NOT_AVAILABLE（缺 fold-to-3bet / call-3bet / 4bet）
[SUPPORTED_EVIDENCE_PRIORITY] 有战略启发式想选 RAISE（分 0.77），但它的 EV 不可得且没有独立论证
                              ⇒ 不得覆盖清晰的可比 EV 证据；overrideBlockedReason = CANNOT_OVERRIDE_CLEAR_SUPPORTED_CALL
```

⚠️ **`CLEAR_CALL` 的限定含义**（使用者 §7）：它现在是
`CLEAR_CALL + evidenceScope = CALL_PROXY_ONLY` —— 即「在**当前已建模**的证据里清晰领先」，
不是「全局最优」。UI/debug 两处都带这句限定。

---

## D. Before / After

```text
旧： CALL  CLEAR_CALL，PROXY_EV +2.73
     3BET  EV NOT_AVAILABLE（战略启发式）
     FINAL 3BET ← SAFETY_RULE（把战略偏好伪装成安全约束，且丢掉 CALL 的证据）

新： CALL  CLEAR_CALL，PROXY_EV +2.73（evidenceScope = CALL_PROXY_ONLY）
     3BET  EV NOT_AVAILABLE（无独立论证）⇒ 覆盖被阻断并记录原因
     FINAL CALL ← SUPPORTED_ACTION_PRIORITY
```

**与模板的差异（如实报告）**：模板预期「supported evidence priority ⇒ CALL」，实测一致 ✓。
但我在实现中发现**模板规则的字面版本会造成真实回归**：把「CLEAR + 量化 ⇒ 启发式一律不得覆盖」
写成硬规则后，**价值加注全部失效** —— 旧契约里的
「AA 面对 3bet 必须加注」「三条面对下注必须加注」「低 SPR 下 AA 必须全下」「AA 面对开池+跟注必须加注」
四条同时变红（实测 6 项测试失败）。

因此规则加了一条**只允许既有模型论证**的例外（不引入任何新参数）：

```text
启发式可以覆盖清晰证据 ⇔ 它带独立论证：
  ① MONSTER_STRENGTH_DOMINANCE —— 牌力档 MONSTER，或（类别 ≥ MIN_CATEGORY_FOR_LARGE_RAISE 且权益优势 ≥ RAISE_EDGE_ANY）
  ② LOW_SPR_COMMITMENT        —— commitmentException（低 SPR 承诺）
```

即「加注的额外筹码是在领先时投入的」（价值加注）与「筹码已基本入池，加注与跟注只差把剩余部分投入」
（承诺）这两种情形本来就有既有模型支撑；而**中等强度的 3bet 没有这两条论证** ⇒ 必须让位给 CLEAR_CALL。
这正是 AJs 节点的情形。

---

## E. 回归测试（T1–T7）

| 用例 | 断言 | 结果 |
|---|---|---|
| **T1** 固定节点 | 动作 = CALL；依据 ≠ SAFETY_RULE；`decisionSource.kind = SUPPORTED_ACTION_PRIORITY`；`canOverrideEvidence = false`；`overrideAttempt = RAISE_HEURISTIC`；`overrideBlockedReason = CANNOT_OVERRIDE_CLEAR_SUPPORTED_CALL`；`evidenceScope = CALL_PROXY_ONLY`；CALL 证据 `PROXY_EV/CLEAR_CALL/ev>0`；RAISE 证据 `HEURISTIC/ev=null`；RAISE 仍在 `alternativeActions` | ✅ |
| **T2** 启发式不得覆盖清晰 CALL | proxy +5、启发式 1.0、EV null ⇒ CALL，来源 `SUPPORTED_ACTION_PRIORITY` | ✅ |
| **T3** MARGINAL 允许打断 | proxy +0.3（MARGINAL）+ 强启发式 ⇒ RAISE，来源 `HEURISTIC_TIEBREAK` | ✅ |
| **T4** 硬约束覆盖 | CALL 清晰但不合法 ⇒ RAISE，来源 `HARD_CONSTRAINT`，`canOverrideEvidence = true` | ✅ |
| **T5** 完整 3bet EV 可胜 | CALL proxy +2、RAISE `MODEL_EV` +5 ⇒ **RAISE**（证明不是硬编码「永远跟注」） | ✅ |
| **T6** 无证据兜底 | 全 UNKNOWN ⇒ `FALLBACK`；有 EXACT 弃牌证据时**不得**兜底 | ✅ |
| **T7**（§17/§19.8） | 加注节点的 `decisionBasisKind` 必须**等于** `decisionSource.kind`，且 ≠ `SAFETY_RULE` | ✅ |
| 墨菲 | `UNKNOWN EV` 不参与比较；纯启发式标 `STRATEGIC_HEURISTIC`；`marginOf` 单一分类（CLEAR/MARGINAL/null） | ✅ |

**一处测试改写（必须说明）**：`test/riverConsistency.test.ts` 的 R4 原先独立复算
`decisionBasisOf({...})` 并与快照比对。加注路径的来源现在由证据裁决决定，因此独立复算必须
**读快照自己声明的 `decisionSource.kind`**，并新增「加注/全下必须声明来源」的断言。
这不是放宽：旧写法在「两侧调用同一个被改坏的函数」时**抓不到**解释层与行为层不一致
（M6 变异实测正是如此），新写法把两个字段**直接对比**，反而更严。

---

## F. 全量验证

```text
npm run verify
  TypeScript : 0 错误
  产物清单    : 140 个产物与清单一致
  tests      : 1,720
  suites     : 137
  fail       : 0
```

未删除任何测试；未放宽任何既有断言。上一轮基线 1,712 项全部通过，本轮新增 8 项（T1–T7 + 墨菲）。

---

## G. 变异测试（6/6 被抓到）

| 变异 | 期望 | 实测 |
|---|---|---|
| M1 恢复 `SAFETY_RULE → force 3BET`（启发式无条件覆盖） | T1/T2 红 | ✅ 2 项失败 |
| M2 让 heuristic 可以覆盖 CLEAR_CALL | 同上（与 M1 同一处权限判定） | ✅ 2 项失败 |
| M3 把 HARD_CONSTRAINT 与 STRATEGIC_HEURISTIC 合并 | T4 红 | ✅ 1 项失败 |
| M4 fallback 在有 CLEAR 证据时仍触发 | T1/T2 红 | ✅ 2 项失败 |
| M5 硬编码「CLEAR_CALL ⇒ 永远跟注」（忽略独立论证） | 旧契约 F-01 ×2 / 解释一致性 / POT-D7 / TEST 4 红 | ✅ **5 项失败**（旧测试抓到的，说明例外规则不是白加的） |
| M6 UI 理由仍写 SAFETY_RULE 而真实来源不同 | T7 红 | ✅ 1 项失败（**首版未被抓到 → 新增 T7 直接对比两个字段**） |

**M6 的教训（与上一轮 M5 同类）**：任何「用同一个函数独立复算再比对」的守卫，
在**函数本身被改坏**时都会自我一致通过。要抓「解释层与行为层不同来源」，
必须让断言直接比较**两个独立字段**（`decisionSource.kind` vs `decisionBasisKind`），
而不是让两侧走同一条代码路径。

---

## 十九、墨菲定律逐条

| # | 检查 | 结论 |
|---|---|---|
| 1 | `SAFETY_RULE` 是否还有战略用途 | ✅ 已移除：加注/全下由证据来源 kind 表达；`SAFETY_RULE` 只在**没有证据来源**时作为真安全兜底，注释写明它不代表战略偏好 |
| 2 | heuristic 是否仍可静默覆盖 clear evidence | ✅ 不可（除带独立论证的两条：MONSTER 强度优势 / 低 SPR 承诺），且覆盖被记录为 `STRATEGIC_HEURISTIC` + `overrideAttempt` |
| 3 | fallback 是否在已有 clear evidence 时触发 | ✅ 不会（T6 断言有 EXACT 证据时来源为 `SUPPORTED_ACTION_PRIORITY`） |
| 4 | HARD_CONSTRAINT 是否被误用成策略规则 | ✅ 唯一入口是「CALL 候选不存在（不合法）」这类合法性/输入安全；T4 单独锁定 |
| 5 | `CLEAR_CALL` 是否误变成永久 CALL | ✅ 不是（T5：RAISE 有 `MODEL_EV` +5 时自然获胜；M5 变异被旧测试抓到） |
| 6 | 完整 3bet EV 以后是否还能超过 CALL | ✅ T5 直接构造并锁定 |
| 7 | alternative action 是否被错误当 final | ✅ `primaryAction` 与 `alternativeActions` 分开；备选不参与动作输出 |
| 8 | UI 显示动作与 decision source 是否一致 | ✅ T7 直接对比两个字段 |
| 9 | explanation 是否仍声称 value raise | ✅ 未宣称；加注理由明确写「来源 = STRATEGIC_HEURISTIC / HEURISTIC_TIEBREAK，不是 EV 结论」 |
| 10 | heuristic score 是否伪装成 EV | ✅ `ev` 字段为 `null`，另有独立 `heuristicScore`；UI 分行显示 |
| 11 | UNKNOWN EV 是否被当成 0 | ✅ 不参与比较（`ev === null` 被排除在量化集合之外） |
| 12 | UNKNOWN EV 不因「0 < +2.73」被误判输 | ✅ 不是靠数值大小，而是靠证据类型；且被记为「被阻断的覆盖尝试」而非「EV 更小」 |
| 13 | proxy EV 是否伪装成 exact EV | ✅ `estimateType = PROXY_EV` + `evidenceScope = *_PROXY_ONLY`，理由里带「不是完整博弈树 EV」 |
| 14 | invalid/NaN 状态仍能触发真 Safety | ✅ `marginOf` 对非有限数返回 `null`；合法性/候选缺失仍走 `HARD_CONSTRAINT` |
| 15 | 所有合法动作仍保留 | ✅ 候选列表未删（F-01 系列断言 RAISE/ALL_IN 仍在候选与合法集合里） |
| 16 | 动作来源单一可追踪 | ✅ `decisionSource` 是唯一来源，`decisionBasis.kind` 与之相等（T7） |
| 17 | 旧测试不得被放宽 | ✅ 1,712 项全通过；仅 R4 的独立复算改为读快照来源（并加严，见 §E） |
| 18 | 无画像 baseline 必须保持稳定 | ✅ 本轮未触碰画像/范围/权益链路；固定节点两种画像输出一致（先前已记录的结构性事实） |

---

## 已知限制（不伪造）

| 项 | 状态 |
|---|---|
| 3BET 的真实 EV | **仍未建模**（缺 fold-to-3bet / call-3bet / 4bet）。本轮的 `upgradeNoteZh` 写明：一旦建模即升级为 `MODEL_EV`，会自动在同一张证据表里参与比较（T5 已锁定该行为） |
| 覆盖例外的两条论证 | 【启发式】结构式（MONSTER 强度优势 / 低 SPR 承诺），复用既有常量 `RAISE_EDGE_ANY`、`MIN_CATEGORY_FOR_LARGE_RAISE`，**未新增任何阈值** |
| 多街 / 多人情景 | 本轮只改证据优先级，未触及多人权益与放弃率模型 |
