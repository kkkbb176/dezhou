# CB-5 · 河牌「打光筹码」容差带护栏 V1（**已实施，未提交**）

> **轮次**：CB5_RIVER_STACK_GUARD_V1（2026-09）
> **授权**：`reports/FLOP_RIVER_THEORY_EXPLOIT_AUDIT_V1.md` §八 第①项的一半 —— 只做 CB-5 的**决策护栏**；
> CB-1 只允许「不影响策略的诊断」，且允许在需要大范围改动时**暂不实施**。
> **本轮未提交、未推送**（按任务 §十二：完成后停止等待人工确认）。

---

## §1 基线与修改前保护

| 项 | 值 |
|---|---|
| `HEAD` / `origin/main`（本轮开始） | `536433def5c8e62b5401451505aa2d5b70e29c29`（= F2 修复，已推送） |
| 工作区 | 已跟踪改动 **0**；未跟踪 133（全部保留） |
| 本轮检查点 | `%TEMP%\dezhou-checkpoint-f2ac-20260920-131436`｜**719/719 文件逐位 sha256，0 差异**｜`FILES.sha256.txt` = `46CD6F9DFAF98BD49EB92A12CD29DB94F23B08BBDED4A6478222697001048406` |
| 「修复前」对照树 | `%TEMP%\cb5-before-132759`（`git archive HEAD` + `node_modules` junction）；124 节点扫描在两棵树用**同一脚本、同一输入**各跑一次 |
| 基线哈希 | `evidencePriority.ts = E7E11F28…2AB66978`｜`decisionEngine.ts = B1CCFAA8…9CB26CC`｜`decision.types.ts = 812AA39A…DC50` |
| 代码与审计是否一致 | **一致**：`evidencePriority.ts` 自 `5ef4f2f` 起未改动；审计引用的行号与工作区逐条对齐（未凭旧行号替换） |

**124 节点可复现性**：`scripts/next-phase-estimate.ts`（修复前）与 `scripts/cb5-impact-scan.ts`（修复前/后）使用**完全相同**的输入
（同种子 `20260913`、同手牌、同公共牌、同行动历史、同画像、同有效筹码、同环境），修复前两脚本对同一节点给出**一致**的动作与 EV。

---

## §2 五个目标节点的生产路径追踪（`scripts/cb5-trace.ts`，修复前）

| # | 节点 | Hero | 底池 / 跟注 / 剩余 | FOLD / CALL / RAISE 证据 | 最佳非全下备选 | 差 vs 带 | 结论 |
|---|---|---|---|---|---|---|---|
| ① | R-05（120% 池）NORMAL | BTN A♠K♠｜K♦9♣4♥6♠2♦ | 136 / 83 / 174 | EXACT 0 / PROXY_EV 45.33 / **MODEL_EV 48.48** | CALL 45.33 | **3.145** ≤ ±10.95 | 全下胜出 |
| ② | ①MANIAC | 同 | 同 | 0 / 60.39 / **70.38** | CALL 60.39 | **9.992** ≤ ±10.95 | 全下胜出 |
| ③ | R-05b（100% 池）NORMAL | 同 | 122 / 69 / 174 | 0 / 42.92 / **42.96** | CALL 42.92 | **0.032** ≤ ±9.55 | 全下胜出 |
| ④ | ③MANIAC | 同 | 同 | 0 / 56.06 / **63.73** | CALL 56.06 | **7.669** ≤ ±9.55 | 全下胜出 |
| ⑤ | AK 河牌黄金节点 NORMAL | 同 | 108 / 40 / 174 | 0 / 42.02 / **42.11** | CALL 42.02 | **0.090** ≤ ±6.65 | 全下胜出 |

**路径证明（每个节点 ⑪ 行）**：`经过证据优先级跨动作比较路径 = true`（量化候选 3 个；
来源 `SUPPORTED_ACTION_PRIORITY`、`evidenceScope = RAISE_MODEL_EV`）——
这三项只能由 `chooseByEvidencePriority` 的「量化分支最终 return」产生（`evidencePriority.ts` 中 `scope = ${best.action}_${best.estimateType}`）。
`actionShape.kind = RAISE_TO_ALL_IN`、`allInGuard.consumesStack = true`。

**是否存在其他提前定案的路径**：**没有**。`primaryAction` 就是最终 `action`（`decisionEngine.ts:3926`），
`baseDecision` 是 `pickCandidate` 的返回值（`:3330`），而 `chooseByEvidencePriority` 正是 `pickCandidate` 内部的裁决点
（`:2415`）⇒ **只需修改这一处**；`adjustedDecision` / `shadow` 在本轮 5 个节点上与最终动作同值（无独立策略层改动）。
**结论：不需要修改额外函数**（护栏的披露在调用方读取返回字段，不是第二份判据）。

**对照组（同一脚本）**：C1 黄金向量（CALLING_STATION）最优证据是 CALL（19.70，差 19.70 > 6.65 ⇒ 不触发）；
C2 99 暗三条（RAISE 174.40 vs CALL 79.22，差 95.18 ≫ 6.65 ⇒ 不触发）；
C3 审计原始 R-05 形态（差 3.085 ≤ ±11.75 ⇒ 触发）；C4 翻牌（`NORMAL_RAISE`，不消耗筹码 ⇒ 不适用）；
C5 翻前 3Bet（来源 `STRATEGIC_HEURISTIC`，量化最优是 CALL ⇒ 不走该分支）。

---

## §3 第一性原理：护栏的数学口径

| 项 | 确认结果 | 证据 |
|---|---|---|
| 同一零点 | ✅ 两条 EV 都是**节点增量口径**、零点 = 弃牌 ≡ 0 | `raiseResponse.assumptionsZh`：「零点 = 弃牌 ≡ 0（与 CALL EV 同一口径…）」；CALL EV = `EqVsBetRange × winnable − callCost` |
| 两条 EV 均有效/有限/有比较资格 | ✅ 由 `quantified`（`isQuantified(type) && ev !== null`）保证 | `evidencePriority.ts:292` |
| 容差带与节点一致 | ✅ `band = MODEL_UNCERTAINTY_RATIO(0.05) × winnable`：219→10.95、191→9.55、133→6.65 | `decisionEngine.ts` 的 `uncertaintyBandChips`（**未改**） |
| 不混证据级别 | ⚠️ **如实记录**：本护栏继承**既有**的跨动作比较（MODEL_EV vs PROXY_EV 按数值比），护栏自身**不引入**新的比较；两个估计类型都写进护栏诊断 | 护栏字段 `blockedEstimateType` / `alternativeEstimateType` |
| 不把 null 当 0 | ✅ `ev === null` 的候选**根本不在 `quantified` 里**，结构上无法成为 `best`/`second`，也无法触发护栏 | 单元 `CB5-06`（K/L） |
| 不新增模型系数 / 不改 EV 公式 | ✅ 本轮 diff 中**没有任何**阈值常量或 EV 表达式改动 | §6 的 diff 核对 |
| 护栏**不**声称备选更高 | ✅ 护栏文案与 `reasonZh` 显式写明「这不等于声称备选动作在真实牌局中更高」 | 生产输出（§5） |

**判定式（实现）**：
`street = RIVER ∧ facingBet ∧ best.commitsStack = true ∧ ∃second(不消耗筹码) ∧ 两条 EV 有限 ∧ 0 ≤ EV_stack − EV_alternative ≤ 容差带`
⇒ 选 `second`（**含边界**：差 = 0 与差 = 带都触发，单元 H/I）。

---

## §4 最小修复范围（2 个生产文件）

### `src/domain/decision/evidencePriority.ts`（+129 行，其中绝大多数是注释）

- 输入新增 `stackCommitmentGuardApplies?: boolean`（由调用方判定，缺省 ⇒ 行为与本护栏引入前逐位一致）。
- 输出 `EvidenceDecision` 新增 `stackCommitmentGuard?`：`blockedAction / alternativeAction / blockedEV / alternativeEV /
  gapChips / bandChips / blockedEstimateType / alternativeEstimateType / reasonZh`。
- 在**跨动作量化 EV 比较**路径中新增护栏（早返回）：命中后 `action = 最佳非全下候选`，
  `source = SUPPORTED_ACTION_PRIORITY`（备选若为独立模型证据则如实写 `INDEPENDENT_STRATEGIC_EVIDENCE`），
  `evidenceScope = ${best.action}_STACK_COMMITMENT_WITHIN_BAND`、
  `overrideAttempt = ${best.action}_STACK_COMMITMENT`、`overrideBlockedReason = STACK_COMMITMENT_MARGIN_GUARD`。
- 触发条件共 6 条硬条件（见 §3），**同一条判据只在这一处**。

### `src/app/decision/decisionEngine.ts`（+34 行）

1. 调用点传 `stackCommitmentGuardApplies: math.street === Street.RIVER && callCandidate !== null`
   （复用既有 `callCandidate === null` 判据 ⇒ 「面对下注」的判定**只有一处**）。
2. `decisionSource` 如实带出护栏字段（仅披露，不参与计算）。
3. CALL 胜出分支：护栏触发时改用原因码 **`STACK_COMMITMENT_MARGIN_GUARD`**，
   **不再**输出「跟注更高」（那是与事实不符的句子：加注 EV 其实略高、只是高得没有意义）。

**未改动**：`MARGINAL_EV_GAP_RATIO` / `MODEL_UNCERTAINTY_RATIO` / `MATH_EV_EPSILON` / `RAISE_EDGE_*` /
`MAX_RAISE_TO_POT_RATIO` / `MIN_CATEGORY_FOR_LARGE_RAISE` / 尺寸网格倍数档 / 任何 EV 公式 /
条件范围构造 / 下注响应概率 / 画像融合 / 普通（非全下）加注规则 / 翻前·翻牌·转牌策略
（`git diff` 中这些常量**零出现**；`contextBuilder.ts` / `legalActions.ts` / `betResponse.ts` / `bettingRange.ts` 未改动）。

---

## §5 失败测试（先失败，后修复）

`test/riverStackCommitmentMarginGuard.test.ts`（10 项，全部走**生产入口**，仅在 H–N 用合成证据表做边界语义）：

**修复前：5 项失败 / 5 项通过**

```text
✖ CB5-01（A–E）  A · R-05（120% 池）NORMAL：最终动作 = RAISE @174（消耗全部筹码），
                 但它只比「CALL」（EV 45.331178407650015）高 3.145 筹码，落在 ±10.95 内
✖ CB5-02（A–E）  A：本节点必须留下护栏诊断（blockedAction / alternativeAction / 两条 EV / 差 / 带）
✖ CB5-05（H/I/J） H：差为 0（模型完全分辨不出）⇒ 不得打光筹码（'RAISE' !== 'CALL'）
✖ CB5-07（M/N）  M/N 边界语义
✖ CB5-08（O）    翻前 3Bet / 4Bet 不受影响（当时的失败是测试自身的节点构造错误，已修好）
✔ CB5-03（F）黄金向量不变 ｜ ✔ CB5-04（G）强牌全下保留 ｜ ✔ CB5-06（K/L）null 不得当 0
✔ CB5-09（P）翻牌·转牌不变 ｜ ✔ CB5-10（M9）候选与证据保全
```

**修复后：10 / 10 通过**，`npm run typecheck` 零错误。

**修复后用户可见理由链（R-05 NORMAL）**：

```text
最终动作 = CALL @83 ｜ 界面：建议：跟注 ｜ 41.5BB（83 筹码）
6. [STACK_COMMITMENT_MARGIN_GUARD] RAISE（87.0BB）：「RAISE」（MODEL_EV EV 48.48）会让 Hero 把剩余筹码**全部投入**，
   而它相对最佳非全下候选「CALL」（PROXY_EV EV 45.33）只高 3.14 筹码 —— 落在模型自身的工程容差带 ±10.95 之内。
   ⇒ **这点优势不足以单独授权打光筹码**，改按既有证据优先级选择不消耗筹码的动作。
   ⚠️ 这不等于声称备选动作在真实牌局中更高（两个数字都在模型的分辨力之内）。
   ｜被拦截动作 = RAISE，有效备选 = CALL（⚠️ 该加注的 EV 与候选金额均**未被修改**，仍可在诊断里查看）
```

---

## §6 影响面（同一 124 个「节点 × 画像」输入）

| 指标 | 结果 |
|---|---|
| 变化的节点 | **恰好 5 个**：R-05 NORMAL / R-05 MANIAC / R-05b NORMAL / R-05b MANIAC / AK 河牌 NORMAL |
| 变化内容 | 动作 `RAISE@全下 → CALL@跟注额`（83 / 83 / 69 / 69 / 40） |
| 变化的字段 | **只有 4 类**：`action`、`evidenceScope`、`consumesStack`(true→false)、新增的护栏诊断 |
| **未变化** | FOLD / CALL / RAISE 的 EV 与估计类型、`arrival`/`betRange`/`heroEquity`/`eqBetRange`/`requiredEquity`/`winnable`、`foldLikelihood`/`callLikelihood`/`reRaiseLikelihood`、`raiseResponse` 的资金字段（`heroAdd`/`villainAdd`/`heroContestedAdd`/`uncalledReturn`/`finalPot`）、容差带数值 —— 逐一比对**逐字未变** |
| 未预期的变化 | **0**（若出现资金/权益/EV 数值变化即停止 —— 未出现） |
| 133 节点指纹（`scripts/f2-blast-radius.ts`） | **0 差异** |
| 125 局面扫描（`scripts/p1-fix-sweep.ts`） | **0 差异** |

**动作变化的归因（任务要求）**：5 例全部来自**新增的 `stackCommitmentGuard`**，位置在
`chooseByEvidencePriority` 的「量化候选分支」——即修复前 `return best`（RAISE）的那条出口；
触发后改返回「最佳非全下量化候选」（CALL）。**不涉及**范围、响应概率、条件权益或资金流（它们的数值逐字未变），
也不涉及原有证据优先级（`overrideJustification` / `crossActionInconclusive` / 硬约束三条路径均未被改动）。

---

## §7 完整回归与独立验证

| 项 | 结果 |
|---|---|
| `npm run verify` | **exit 0**｜TypeScript **0 错误**｜`tests 2072 / suites 137 / pass 2072 / fail 0`｜产物 **163/163** |
| 原有测试 | **未删除、未跳过、未放宽**：唯一失败过的是「状态文档声称的测试文件数」（106 → 107），已同步文档；**没有**任何既有测试因本修复而改变动作预期 |
| 既有 12 组回归 | P1 CALL/FOLD、River Bet Range V2、River Raise Decision V2、U1 RAISE EV、P1-2a/P1-4/P1-2b、TEST 16/17/18、AK 河牌黄金向量、99 暗三条价值加注、F2 翻前全下保护、P0-7 短筹码 —— **全部通过**（TEST 18 仍为 `RAISE 186`；AK 黄金向量仍为 `CALL 40`） |
| **独立干净检出验证** | `git archive HEAD` ⇒ `%TEMP%\cb5-clean-133411`（**588 文件，仅已跟踪内容 + 本轮将提交的 5 个文件，无任何未跟踪探针**）⇒ `npm run verify` **exit 0**｜2072/2072｜163/163 |
| 产物清单 | 已 `npm run manifest` 刷新（163 个产物，含本轮改动的 2 个生产文件） |

---

## §8 CB-1 诊断核查（**只核对与记录，未改行为、未加字段**）

| 量 | 定义（代码自述） | 事件 / 分母 | 量纲 |
|---|---|---|---|
| `nutDensity` | `rangeCompression.ts`：「坚果强度**特征分**（0..1，**非概率**）……由 `strongShare` 派生的特征分，**不是占比本身**」 | 对手**当前范围**的构成 | **特征分，非概率** |
| `callLikelihood` | U1 响应模型：桶内权重按桶归一化、满足 `fold + call + raise = 1`（`betResponse.ts:911`），分母 = 参与分类的**可达组合数**（`:1020`） | 「他面对我的加注**会跟注**」 | **概率** |

**结论（需更正审计表述）**：两者是**不同事件、不同量纲**的量 ⇒ 按任务要求 **不得标记为「数学矛盾」**。
`reports/FLOP_RIVER_THEORY_EXPLOIT_AUDIT_V1.md` 的 CB-1 应改读为：
「两个不同量纲的量（特征分 vs 概率）并列展示，容易被误读为互相矛盾；且响应先验未经统计校准」——
属**可读性 / 校准**问题，不是数学不一致。

**披露现状**：`nutDensity`（`postflop.rangeCompression`）与四个响应概率（`postflop.raiseResponse`）
**都已经存在于现有生产诊断输出**中（审计正是从这两处读到的） ⇒ **不需要新增字段、不需要改类型或 UI**。
因此本轮**未实施**任何 CB-1 相关改动（既未加 `nutDensity ≥ 0.8 / callLikelihood ≥ 0.6` 之类判据，也未构造代理变量）。
独立审计结果原样保留在审计报告中（本轮不覆盖该文件）。

---

## §9 墨菲定律专项（M1–M14）

| # | 风险 | 结果 | 证据 |
|---|---|---|---|
| M1 | 只判断 `RAISE` 名称，误伤非全下加注 | ✅ 未发生 | 护栏用 `best.commitsStack === true`（不是动作名）；单元 N：非全下 RAISE（优势在带内）**不触发**；翻牌 `RAISE 40` 不变 |
| M2 | 只判断 `ALL_IN` 名称，遗漏 `RAISE_TO_ALL_IN` | ✅ 未发生 | 5 个节点的 `actionShape.kind = RAISE_TO_ALL_IN`，其证据条目为 `RAISE` 且 `commitsStack = true` ⇒ 被正确识别；独立的 `ALL_IN` 候选没有 EV ⇒ 不会成为量化最优 |
| M3 | 仅比较 raise-to 金额、未用真实有效筹码 | ✅ 未发生 | `commitsStack` 来自 `raiseCandidate.sizeChips >= allInToAmount − ε`（真实剩余）；H/I（3BB/4BB）与 R-06（`minRaiseTo 200 > allInTo 166`）在 124 节点扫描中**未变化** |
| M4 | 把 `EV=null` 当 0 | ✅ 未发生 | `quantified` 过滤 + 单元 K/L |
| M5 | 混用不同估计类型/零点的 EV | ⚠️ **如实披露** | 护栏继承既有的跨动作比较（MODEL_EV vs PROXY_EV），**未新增**比较；护栏诊断同时记录两个估计类型；零点一致性见 §3 |
| M6 | 容差带用错底池口径 | ✅ 未发生 | 用的是既有 `uncertaintyBandChips = 0.05 × winnable`（219/191/133 ⇒ 10.95/9.55/6.65 逐一核对），**未改** |
| M7 | 拦截明显有优势的强牌全下 | ✅ 未发生 | 99 暗三条（差 95.18 ≫ 6.65）仍 `RAISE 174`；124 节点扫描无任何成手强牌节点变化 |
| M8 | 只保护 CALL，忽略 CHECK/FOLD 等有效备选 | ✅ 未发生（但记边界） | 选择逻辑是「**最佳非全下量化候选**」，与动作名无关；单元 M 中备选即 CALL、单元 L 中 null 备选被排除。⚠️ 若某河牌节点 `CALL EV` 不可得而 FOLD 是唯一有效非全下候选，护栏会选 FOLD —— 该形态在 124 个节点中**未出现**，属设计边界（已在测试中显式记录） |
| M9 | 被拦截的全下从候选表被删除 | ✅ 未发生 | `CB5-10`：候选表条目与 RAISE 证据（含 EV）原样保留；`unevaluatedActions` 不含最终动作 |
| M10 | 动作变了，界面仍宣称「全下 EV 最高」 | ✅ 未发生 | 原因码改为 `STACK_COMMITMENT_MARGIN_GUARD` 并如实说明「加注 EV 略高但落在容差带内」；不再输出「跟注更高」；首屏 = 建议：跟注 |
| M11 | 为通过测试而调响应概率/画像/容差带 | ✅ 未发生 | diff 中无任何常量改动；`betResponse.ts` / `bettingRange.ts` / 画像相关文件**未改动** |
| M12 | `consumesStack=true` 但实际有未匹配退回 | ✅ 未发生 | 5 个节点的 `raiseResponse` 资金字段（含 `uncalledReturn`）修复前后**逐字相同**；护栏只看 `commitsStack` 布尔量，不参与资金计算 |
| M13 | 重复应用护栏导致循环/动作不确定 | ✅ 未发生 | 护栏是**单点早返回**（`evidencePriority.ts` 内一处），无递归；同一输入重复运行结果一致（124/133/125 三次扫描均可复现） |
| M14 | 原有无 EV 全下保护被替换或失效 | ✅ 未发生 | `test/preflopAllInGuard.test.ts`（F2）11/11 通过；`allInGuard.onePairAllInBlocked` 语义未改动（本轮未触碰 `shouldRaise` / `allInGuardVerdictOf`） |

---

## §10 验收块

```text
CB5_RIVER_STACK_GUARD_V1 = DONE（**未提交、未推送**，等人工确认）
BASELINE_PRESERVED = YES｜HEAD 536433d = origin/main｜工作区已跟踪改动 0（开始前）｜检查点 719/719 逐位 0 差异
ORIGINAL_FIVE_NODES_REPRODUCED = YES（差 3.145/9.992/0.032/7.669/0.090；带 10.95/10.95/9.55/9.55/6.65；
           来源 SUPPORTED_ACTION_PRIORITY/RAISE_MODEL_EV；actionShape RAISE_TO_ALL_IN；且经 ⑪ 结构性证明走该路径）
MODEL_EV_COMPARABILITY = 同一零点（弃牌≡0）、两条 EV 均有限且属 quantified；估计类型分别为 MODEL_EV 与 PROXY_EV
           （**继承既有比较，未新增**，并在护栏字段中如实记录两者类型）
MARGIN_SEMANTICS = 既有 uncertaintyBandChips = MODEL_UNCERTAINTY_RATIO(0.05) × winnable；**含边界**（差=0、差=带均触发）
STACK_COMMITMENT_SCOPE = 仅「河牌 + 面对下注」（判据只有一处：math.street === RIVER && callCandidate !== null）
           ∧ best.commitsStack === true ∧ 存在不消耗筹码的备选 ∧ 两条 EV 有限 ∧ 0 ≤ 差 ≤ 带
NON_ALLIN_ACTIONS_PRESERVED = YES（单元 N；翻牌 RAISE 40 不变；133 + 125 扫描 0 差异）
PREFLOP_FLOP_TURN_PRESERVED = YES（CB5-08/09；翻前 36 节点与翻牌/转牌节点动作、尺寸全部未变；TEST 18 仍 RAISE 186）
STRONG_VALUE_ALLIN_PRESERVED = YES（99 暗三条 差 95.184 > 带 6.65 ⇒ 仍 RAISE 174）
UNSUPPORTED_EV_HANDLED = YES（ev === null 不在 quantified 内 ⇒ 结构上不可能被当成 0；护栏要求两条 EV 有限）
CANDIDATE_EVIDENCE_PRESERVED = YES（CB5-10：候选金额、加注 EV、估计类型原样保留；被拦截动作仍可审计）
CB1_DIAGNOSTIC_STATUS = 已核对并记录，**未实施任何改动** —— nutDensity 是**特征分（非概率，由 strongShare 派生）**，
           callLikelihood 是**响应概率**（分母=可达组合数，fold+call+raise=1）⇒ **不同事件/不同量纲，不得称为数学矛盾**
           （审计 CB-1 措辞应相应更正为「可读性/校准」问题）；两者**均已在现有诊断输出**，无需新增字段/改 UI
BEFORE_AFTER_124_NODES = 5 / 124 变化（R-05 NORMAL·MANIAC、R-05b NORMAL·MANIAC、AK 河牌 NORMAL），
           全部 RAISE@全下 → CALL@跟注额；仅 action / evidenceScope / consumesStack / 护栏字段四类变化
UNEXPECTED_ACTION_CHANGES = 0（EV、条件权益、响应概率、资金字段、容差带数值逐字未变；133 指纹 0 差异；125 扫面 0 差异）
EV_FORMULAS_UNCHANGED = YES（无任何 EV 表达式或常量改动）
STRATEGY_PARAMETERS_UNCHANGED = YES（阈值常量在 diff 中零出现；范围/响应/画像/环境参数未动）
TYPECHECK = 0 错误 ｜ TESTS_PASS = 2072 ｜ TESTS_FAIL = 0 ｜ suites 137
MANIFEST = 163/163（已刷新）
CLEAN_CHECKOUT_VERIFY = PASS（588 文件，仅已跟踪内容 + 本轮 5 个文件；exit 0；2072/2072；163/163）
UNAUTHORIZED_FILE_CHANGES = 0（未改策略参数/画像权重/GTO/EV 公式；未删除/跳过/放宽任何既有断言；未清理未跟踪文件）
SAFE_TO_CONTINUE_HAND_TESTING = YES —— 护栏已在生产入口生效且诊断完整；
           遗留限制：CB-1（响应先验未校准）与 CB-4/CB-2 等见审计报告，未修
```

## §11 待提交白名单（**等人工确认后单独执行**）

```text
src/domain/decision/evidencePriority.ts      （护栏本体）
src/app/decision/decisionEngine.ts           （调用点 + 披露）
test/riverStackCommitmentMarginGuard.test.ts （新增 10 项）
CURRENT_PROJECT_STATUS.md                    （§10.0.23 + 计数同步）
data/artifact-manifest.json                  （产物清单刷新）
reports/CB5_RIVER_STACK_GUARD_V1.md          （本报告）
```

未纳入（继续保留为未跟踪）：全部探针脚本（`scripts/cb5-*.ts`、`scripts/next-phase-estimate.ts` 等）、
`reports/FLOP_RIVER_THEORY_EXPLOIT_AUDIT_V1.md`、`reports/F2_FINAL_ACCEPTANCE_AND_NEXT_PHASE.md`、`reports/evidence/*`。
**本轮不执行 `git add` / `commit` / `push`。**
