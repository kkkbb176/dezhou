# U1 RAISE EV —— 最小可行对抗性审计报告

> **⚠️ 后续状态（后一轮更新）**：本报告判定的 P0（`U1-EV-CONVENTION-MISMATCH`）**已修复**，
> 见 `reports/U1_RAISE_EV_P0_FIX_REPORT.md`（`U1_RAISE_EV_P0_FIX — PASS_WITH_WARNINGS`）。
> 修复后：AK −7.375830 / 99 +174.402566 / F-01 +1226.726791（边缘）/ TEST 4 +2166.233954，
> 全部与「与 CALL EV 同一口径」的独立复算**逐位一致**；本报告 §E 的预测值 2166.233954 得到验证。
> 本文件保留为**当时**的审计记录（含当时的错误数值），不得当作现状引用。

> 只读审计轮。**未修改任何产品代码、策略参数或测试断言。**
> 基准冻结：`HEAD = a914f9c`（`main`），`ALPHA_DECISION_MODEL_VERSION = '1.0.7'`，
> 工作区 84 项未提交变更（13 modified / 71 untracked，审计前 82 项 + 本轮新增 1 个只读脚本与 1 份证据）。
> 复现脚本：`scripts/u1-audit-ev-convention.ts`（新增，只读）｜证据：`reports/evidence/u1-audit-ev-convention.txt`
> 独立复核：两个对抗性子代理（一个专职**尝试证伪**，一个专职**追踪影响面**）。

---

## 0. 最终裁决（先说结论）

```text
U1_RAISE_EV_LIGHT_AUDIT — FAIL
```

**一句话**：U1 的 RAISE EV 与它要比较的 CALL EV **不是同一套筹码口径** ——
RAISE EV 把对手已经下注的那笔筹码从底池里漏掉了（终池少 `2×betChips`、我方投入少 `betChips`、
对手弃牌时少赢 `betChips`），而产品自己声明的正是「与 CALL EV 同一口径」。
该缺陷**逐位可复现**、有**闭式解**、影响**每一个有加注 EV 的节点**，并已污染响应模型的价格门槛。

按审计规程第六阶段：**发现 P0 后立即停止扩大扫描**，故 20–30 节点的全量扫描**未完成**（见 §A）。

---

## A. 扫描覆盖

```text
实际扫描节点：12 行（5 个深度审计节点 + 8 个下注尺寸扫描行，其中 1 行与深度节点重复）
  深度审计（含独立复算，逐位校验）：5
    · HAND 01 AK 河牌 vs 40（CS）
    · HAND 02 99 暗三条河牌 vs 40（CS）
    · HAND 03 F-01 翻牌 KK vs 6BB（NORMAL）
    · TEST 4 AA 转牌 vs 60（低 SPR）
    · 第二形态 CO AA 翻牌先下注后被 BB 加注（独立复核者提出）
  下注尺寸扫描行：8（AK 顶对 × 4 尺寸、99 暗三条 × 4 尺寸）
  已有证据引用（本轮未重算）：6（AK×2 画像、AJ 空气、99@400BB、AA vs 3bet、TEST 09、KK 河牌）
成功：13（全部跑通生产链路 `analyzeManualHand`）
未支持（NOT_SUPPORTED）：4 类
  · TEST 07 / TEST 08 / TEST 12 —— Hero 是**下注方**（对手过牌），没有「面对下注 ⇒ 加注」这条路径，
    因此 U1 的 RAISE EV 根本不参与，**不得**用它们验证本功能
  · 翻前 3bet / 4bet 节点 —— U1 是**翻后**（面对下注）的加注响应模型，翻前加注仍无 EV
    （`RAISE_STRATEGIC_CANDIDATE` / `ISO_RAISE_MODEL_EV` 是另一条路径），两者**必须分开报告**
未完成：本轮**主动停止**（P0 命中，见 §六）
  · 20–30 节点全量扫描（画像矩阵、手牌类别、街道广度）
  · 方案①（`classifyResponse`）在**修正口径后**的重算 ⇒ 上轮的①/②分歧无法在本轮裁定
  · U9 锯齿的**逐手牌转移分解**（FOLD→CALL / RERAISE→CALL）
  · 单变量敏感性分析（M6）
```

---

## B. 动作变化

```text
节点                                    产品动作        修正口径下的顺序                直接原因
HAND 01 AK 河牌 vs 40（CS）             CALL 40         CALL 第一（未变）               RAISE EV −5.45 → −9.54，仍低于 CALL +19.70
HAND 02 99 暗三条 vs 40（CS）           RAISE 174       RAISE 第一（未变）              140.01 → 171.72，仍高于 CALL +79.22
HAND 03 F-01 翻牌 KK vs 6BB（NORMAL）   CALL            **顺序反转**（19.75 筹码差）    647.19 → 1225.04，反超 CALL 1205.29
TEST 4 AA 转牌 vs 60                    CALL            CALL 第一（未变）                3336.67 → 2166.23，差距扩大
第二形态 CO AA（先下注后被加注）        CALL            **顺序反转**（15.38 筹码差）    0.76 → 25.47，反超 CALL 40.84 ⚠️ 见下
```

⚠️ **两条必须写清楚的限制**：

1. **HAND 03 的反转不等于「动作改变」**（独立复核者指出，已采纳）：
   19.75 筹码的差距**小于**决策层自己的跨动作容差带 `5% × winnable = ±92.50`。
   修正口径后该节点会落进「跨动作不确定 / `HEURISTIC_TIEBREAK`」，**不是**一个干净的 RAISE 胜出。
   所以正确表述是：**产品当前在这类节点上给出的「干净 CALL」本身就是错误口径的产物**。
2. **第二形态那行的「修正口径」不是完整反事实**：该节点的 `raiseIncrement` 契约已被破坏
   （见 §E 的第二形态），响应概率是在**错误的增量**下算出来的 ——
   要判断真实动作必须先修输入再重算概率，本轮不做。

---

## C. 模型分歧（方案① vs 方案②）

```text
现状（口径未修正）：符号一致 7/7；99 暗三条节点名次相反（② 140.01 / ① 67.92 / CALL 79.22）
本轮新增的关键限制：**这个比较本身建立在同一个错误口径上**，因此不能用来裁定分歧。
```

证据（`scripts/u1-raise-ev-crosscheck.ts:176`）：

```text
方案① 的 EV = (f1/t1)*potPre + (c1/t1)*(eq*(potPre + 2*increment) − increment) + (r1/t1)*−increment
                                                                  ↑ 与产品 RAISE EV 完全相同的漏项
```

⇒ 上轮报告的「符号一致 7/7」只能说明两套**概率/权益模型方向一致**，
**不能**说明 EV 量级或名次一致（两者共享同一个漏掉 `betChips` 的口径）。
最佳加注尺寸的分歧同理未裁定（① 与 ② 都用同一个 `desiredTo`/网格）。

---

## D. U9 锯齿（跟注率随尺寸非单调）

```text
是否复现：**是**（已在本轮的下注尺寸扫描中再次出现，见 evidence 脚本输出）
直接原因：结构性，不是赔率/归一化错误 ——
  ① 弃牌判定是「继续指数 ≥ 价格 + 余量」的**阈值判定**，而继续指数只有 9 档 ⇒ 弃牌率是**阶梯函数**；
  ② 与此同时再加注门槛（`价格 + 0.2`）随价格上移，把「还能继续、但不再够格再加注」的中强牌
     从再加注桶搬进跟注桶；
  ③ 由于 P(跟) = 1 − P(弃) − P(再加注) 且两项同时下降 ⇒ P(跟) 必然可以在平台上上升。
是否影响 EV 排名：**受影响，但不是本轮 P0**。锯齿改变的是 P(跟)/P(弃) 的分配，
  经 §E 的漏项放大后可能改变名次；本轮**未**做逐手牌转移分解（已停止，见 §A）。
是否属于「数学错误」：**否**（响应权重的重新分配，三项之和恒为 1；P(弃) 单调不减、
  继续率与再加注率单调不增这三条在 29 个尺寸点上**无一次违反**）。
```

---

## E. 数学与范围 —— 找到的实际 Bug

```text
Bug ID：U1-EV-CONVENTION-MISMATCH（P0：筹码口径错误 + 与 CALL EV 不可比）
```

### 最小复现

`node --experimental-strip-types scripts/u1-audit-ev-convention.ts`
（HAND 01：6-max，BB=2，Hero BTN A♠K♠，牌面 K♦9♣4♥6♠2♦，底池面对 Hero = 93，对手下注 40，Hero 剩余 174）

### 实际结果（产品输出）

```text
底池（含对手这一注）      = 93        ← 与使用者的描述一致
potBeforeBet（扣掉他这注）= 53
raiseTo = 174｜产品口径的「增量」= 134（= **对手**还要再投）
finalPot（产品）          = potBeforeBet + 2×134 = 321
我的投入（产品）          = 134
对手弃牌我赢（产品）      = 53
RAISE EV（产品）          = 0.1159×53 + 0.8841×(0.376606×321 − 134) + 0×(−134) = **−5.447466**
CALL  EV（产品）          = 0.448857×133 − 40 = **+19.697943**
```

### 独立复算

```text
① 用**产品自己的公式**复算 RAISE EV = −5.447466 ⇒ 与产品**逐位一致**（4/4 节点）
② 用**同一口径**复算 CALL  EV = 19.697943 ⇒ 与产品**逐位一致**（4/4 节点）
   ⇒ 两处口径不同是**代码事实**，不是复算者读错代码。
③ 用与 CALL **同一套**口径（零点 = 弃牌 ≡ 0）复算 RAISE EV：

     对手弃牌 ⇒ 我赢**当前底池** = 93（含他这一注；他弃牌就放弃它）
     他跟注   ⇒ 我投 174（= raiseTo，我本街原为 0），终池 = 93 + 174 + 134 = **401**
     他再加注 ⇒ 我损失本次投入的**全部** 174

     RAISE EV = 0.1159×93 + 0.8841×(0.376606×401 − 174) + 0 = **−9.538929**
```

| 节点 | 产品 RAISE EV | 同口径 RAISE EV | 差额 | CALL EV | 顺序是否反转 |
|---|---|---|---|---|---|
| HAND 01 AK 河牌 | −5.4475 | −9.5389 | −4.09 | 19.6979 | 否 |
| HAND 02 99 暗三条 | 140.0118 | 171.7222 | +31.71 | 79.2185 | 否 |
| HAND 03 F-01 翻牌 | 647.1918 | 1225.0435 | +577.85 | 1205.2917 | **是**（差 19.75 < 容差带 92.50） |
| TEST 4 AA 转牌 | 3336.6668 | 2166.2340 | −1170.43 | 4181.1792 | 否 |
| 第二形态 CO AA | 0.7584 | 25.4663 | +24.71 | 40.8428 | **是**（差 15.38 > 容差带 4.65）⚠️ 输入已失真 |

### 根因（闭式解，4/4 节点逐位吻合）

```text
ΔEV = 产品 − 同口径 = betChips × ( P(再加注) − P(弃) + P(跟) × (1 − 2 × EqVsRaiseCallRange) )
```

来源（`src/app/manualInput/contextBuilder.ts`，`mark('raiseResponse', …)` 块，约 3765–3842 行）：

| 行 | 代码 | 问题 |
|---|---|---|
| 3770 | `potBeforeBet = computePot(state) − betChips` | 对手这一注被从底池里扣掉 |
| 3779 | `increment = raiseTo − streetAlready − betChips` | 这是**对手**还要投的量，被当成**我方**投入 |
| 3804 | `finalPot = potBeforeBet + 2 × increment` | 漏掉对手这一注（少 `2×betChips`） |
| 3808 | `f × potBeforeBet` | 对手弃牌时我赢的是**整个**底池 `computePot`（少 `betChips`） |
| 3810 | `rr × (−increment)` | 被再加注时只扣了 `increment`，实际损失 `raiseTo − streetAlready` |
| 3828 | 自述 `零点 = 弃牌 ≡ 0（与 CALL EV 同一口径）` | **产品自己的声明被违反** |

对照 CALL EV（同一份输出）：`math.winnable = pot + callCost = 133`（**含**对手这一注）、
`callEV = EqVsBetRange × winnable − callCost`（扣**我方**投入）⇒ 两者不可比。

### 同一根因的第二个污染点（响应模型自己的价格门槛）

```text
src/app/manualInput/raiseResponse.ts：price = increment / (potChips + 2×increment)   // potChips 已扣掉对手这一注
引擎自己的跟注口径：  callCost / (pot + callCost)    （math.requiredEquity = 30.1% 就是这么来的）

HAND 01 实测：模型价格 0.417445 vs 引擎口径 0.334165 ⇒ **门槛被抬高 8.33 个百分点**
TEST 4：0.260105 vs 0.182942（+7.72pp）｜HAND 03：0.423529 vs 0.330275（+9.33pp）
⇒ 响应模型的**输入**（他面对加注需要的权益）系统性偏高 ⇒ 系统性高估他的弃牌率
```

### 同一根因的第二个形态（Hero 本街已有投入时）

```text
第二形态节点（CO AA 翻牌先下注 5BB → BB 加注到 20BB → 轮到 CO）：
  对手本街总额 = callCost + 本街已投 = 30 + 10 = 40 ⇒ 他还要投 110
  产品告诉响应模型的增量 = 100 ⇒ **差 10（正好是 Hero 本街已投）**
  ⇒ `raiseIncrement` 的契约（`raise-response.ts:125`：= raise-to − 当前注额）在该节点已不成立
  ⇒ 该形态下「修正口径」不是完整反事实（概率本身是错的输入算出来的）
```

### 影响范围

- **每一个有加注 EV 的节点**：`ΔEV` **线性于 `betChips`** ⇒ 对手下注越大越严重。
  下注尺寸扫描实测：|ΔEV| 从 1.83（8 筹码）→ 41.44（60 筹码）。
- **符号与量级都可翻转**：`EqVsRaiseCallRange > 0.5` 时产品**低估**，`< 0.5` 时**高估**
  （HAND 01 高估 4.09、99 低估 31.71、TEST 4 高估 1170.43）。
- **对外披露**：`assumptionsZh` 的「与 CALL EV 同一口径」为假；理由文案里的 `RAISE EV = …`
  与 `终池 = …` 均为错值（`RAISE_MODEL_EV` / `RAISE_MODEL_EV_LOSES` 两条路径）。
- **测试与上轮结论**：`test/raiseResponseU1.test.ts`（U1-1…U1-8）与
  `scripts/u1-raise-ev-crosscheck.ts:176` 都**复制了同一错误口径** ⇒ 它们只能锁住「接线」，
  锁不住「账目」。这也是「全绿但结论错」的直接来源。
- **未受影响（数学上干净）**：FOLD EV ≡ 0、CALL EV、`EqVsBetRange`、下注范围（Betting Range V2）、
  手牌评估、翻前范围与画像链路（本轮复算与产品输出逐位一致）。
- **「免疫」但不是「安全」**（独立复核者逐行确认）：`alphaPipeline.finalMathSanityCheck`
  与 `decisionConsistency` 的数值自检**只覆盖 CALL / FOLD**，没有任何一条能拦住跨口径的加注；
  `decisionLog` 也不记录加注响应模型版本 ⇒ 修复前后同一版本号、同一份日志无法区分。
- **本缺陷的「血统」值得记录**：它在 `src/` 内**只**出现在 U1 新代码里，而代码库既有六处 EV 生产者
  全部使用正确口径（`equity × 投入后底池 − 我方新增投入`），`limpIsolation.ts:639-643`
  甚至**明文写过这个坑**（「他那 1BB 已经在池子里，不要重复计算」）。
  该错误写法的来源是**上几轮的审计脚本**（`scripts/ak-candidate-comparison.ts:202-237`
  → `scripts/u1-raise-ev-crosscheck.ts:176` → 被搬进产品）—— 即「审计脚手架的口径被当成基准搬进生产」。

### E.2 同一轮发现的其它缺陷（D1–D5，**均未修**）

| 编号 | 级别 | 内容（行号已逐条核对） |
|---|---|---|
| **D1** | P1 | **容差带是 CALL 口径，却用在加注 EV 上**：`decisionMargin` 用 `uncertaintyBandChips = 5% × math.winnable`（`decisionEngine` 1593 定义、1964 处用于 RAISE），而 `winnable` 是 CALL 口径的量 ⇒ 「差距是否显著」的判据本身也不可比 |
| **D2** | P1 | **两层各自算 `desiredTo`，导致 U1 在「Hero 本街已投」时被静默关闭**：`contextBuilder:3775` 用 `computePot + 2×betChips`（`betChips = currentBet`），`decisionEngine:1702` 用 `math.pot + 2×callCost`（`callCost = currentBet − 本街已投`）⇒ 两者相差 `2×本街已投`；尺寸对不上时 `raiseModelUsable = false`，加注 EV **悄悄消失**（不是报错）。三处 `buildSizeGrid(..., 'RAISE')` 还用了三个不同底池基准（`contextBuilder` 3773 / `decisionEngine` 381 / `contextBuilder` 3199） |
| **D3** | P2（呈现） | **三处文案仍说「翻后加注没有 EV」**：`decisionEngine:1213` `evRanking` 的 `STRATEGIC_CANDIDATE_ONLY`→「**EV = NOT_AVAILABLE**（翻后加注无 EV 模型）」；`decisionViewModel:440-456`「真实 EV 排名（节点增量口径）」只列 FOLD/CALL ⇒ **在推荐 RAISE 的节点上界面会同时显示「CALL 更高」**；`decisionViewModel:775-778` 仍展示 `checkTree.raiseResponse = 'NOT_IMPLEMENTED'` |
| **D4** | P1（测试） | **没有任何测试断言加注分支的筹码守恒**。缺的恒等式（(a) 终池 = 本街外底池 + 我方投入 + 对手投入；(b) EV 里的成本 = `SizeOption.costChips` = `sizeChips − 本街已投`；(c) 对手弃牌时赢得 = `computePot`；(d) 与 CALL 同口径复算；(e) 对手价格 = `villainAdd/(pot + heroAdd + villainAdd)`）。更糟的是：`test/raiseResponseU1.test.ts` 的 U1-7 **自己复刻了错误口径**（`finalPot = potPre + 2*increment`、成本 `−increment`），U1-2 的价格表（0.1370/0.3008/0.3756/0.4174）把「少算对手这一注」的分母**锁成了预期行为**；`U1-5` / `V2-16` 只断言顺序与动作。既有两条**正确**的范式（`test/multiLimpIsolation.test.ts:151-172` 从具名现金流入量复算 ISO 加注 EV、`test/betDecisionEngine.test.ts:913-919` 复算 CHECK EV）在 U1 上没有对应物 |
| **D5** | P2 | **没有安全网与追溯**：`alphaPipeline.finalMathSanityCheck`（1266-1275）只在 `action === 'CALL' && callEV < −band` 时报错；`decisionConsistency` 的数值自检只覆盖 CALL/FOLD ⇒ **跨口径的 RAISE 永远不会被任何自检拦下**。`decisionLog` 记 `decision/context/math` 版本但**没有加注响应模型版本**；`src/app/manualInput/raiseResponse.ts` 也**未登记**进 `src/infra/artifactDefinitions.ts`（其调用方已登记）⇒ 修复后日志与产物清单都无法区分前后 |

### 建议最小修复（**本轮不实施**）
```text
在 contextBuilder 的 raiseResponse 块内，把三个量的口径改成与 CALL EV 一致：

  heroAdd    = raiseTo − streetAlready                     // 我方真正再投的筹码
  villainAdd = raiseTo − (callCost + streetAlready)        // = 对手本街总额被追平所需
  finalPot   = computePot(state) + heroAdd + villainAdd    // 真实终池
  RAISE EV   = f × computePot(state)
             + c × (EqVsRaiseCallRange × finalPot − heroAdd)
             + rr × (−heroAdd)

并同步：① 响应模型的 price 分母改成 finalPot（`increment / finalPot`）；
        ② 上表两个测试/脚本里复制口径的地方；
        ③ **补 (a)–(e) 五条筹码恒等式测试**（否则同样的错误还能再进一次）；
        ④ 把 `raiseResponse.ts` 登记进产物清单，并给决策日志加「加注响应模型版本」。
不涉及任何系数标定、阈值或策略参数的调整。

代码库内已有正确模板可比对：翻前隔离加注 EV（`contextBuilder` ≈4320 行 +
`limpIsolation.ts:666-691`）用的就是 `allFold × pot`（完整底池）+ `eq × (pot + raise + …) − raise`
− `reraise × raise` —— 即「对手弃牌赢完整底池、我方按自己的投入计费」。
```

---

## F. 墨菲定律（只列**真实复现**的失败模式）

| 编号 | 是否复现 | 证据 |
|---|---|---|
| M1 算术正确但条件范围错误 | **复现（变体）** | 不是「范围错」而是「**口径错**」：CALL 用 `pot + callCost`，RAISE 用 `potBeforeBet + 2×increment` ⇒ 两者排序**没有可比性**（§E） |
| M2 加注有正 EV 但仍低于 CALL | **未发现反例** | 99 节点 RAISE 140.01 > CALL 79.22 属真胜出；AK 节点 RAISE 为负；未观察到「RAISE>0 就选 RAISE」 |
| M3 ①/② 排序相反 | **复现但无法裁定** | 99 节点 ② 选 RAISE / ① 会选 CALL；**但①的 EV 也用了错口径**（`u1-raise-ev-crosscheck.ts:176`）⇒ 须先修口径再判 |
| M4 极端画像饱和 | **未完成** | 停止于 P0（§A）；仅间接证据：MANIAC/NIT 的 RAISE EV 量级不同（−2.76 / −10.37），未见硬饱和 |
| M5 再加注分支被简化却被当成最优后续 | **复现** | 分支本身有「下界」标注（✔ 未伪装成最优），但**扣减金额错**：只扣 `increment` 而非 `heroAdd`（§E 行 3810），且 Hero 全下时 rr=0 是正确的（4/4 节点实测 P(再加注)=0） |
| M6 单一系数敏感性 | **未完成** | 停止于 P0（§A） |
| （额外）测试全绿但账目错 | **复现** | 1,923 项测试 100% 通过，而 RAISE EV 在每个节点上都是错值：**没有任何测试断言加注分支的筹码守恒**（D4）；`test/raiseResponseU1.test.ts` 的 U1-7 甚至复刻了同一个错误口径，`alphaPipeline`/`decisionConsistency` 的自检只覆盖 CALL/FOLD（D5） |
| （额外）审计脚手架污染生产 | **复现** | 该错误写法在 `src/` 内只出现在 U1 新代码，而它是从**上几轮的审计脚本**搬进来的（`scripts/ak-candidate-comparison.ts` → `scripts/u1-raise-ev-crosscheck.ts:176` → 产品），既有六处 EV 生产者与 `limpIsolation.ts:639-643` 的明文警告都证明代码库本来知道正确口径 |

---

## G. 验证结果

```text
tests:      1923
pass:       1923
fail:       0
suites:     137
typecheck:  0 errors（tsc --noEmit，exit 0）
manifest:   157/157 一致（exit 0）
verify:     exit 0
```

说明：`npm run verify` = `npm run typecheck && npm run manifest:check && npm test`；
本机 `npm.ps1` 被执行策略阻止（既有环境限制，非本轮引入），
故按 package.json 的定义**逐条直接运行**等价命令（`node node_modules/typescript/bin/tsc --noEmit`、
`node --experimental-strip-types scripts/generateManifest.ts --check`、
`node --test --experimental-strip-types "test/**/*.test.ts"`）。
**未删除、未跳过、未放宽任何断言**；`git status` 显示产品代码零改动（新增文件仅 1 个只读审计脚本 + 证据 + 本报告）。

---

## H. 最终验收

```text
U1_RAISE_EV_LIGHT_AUDIT — FAIL

RAISE_EV_MATH_VALID            = NO      （口径错误：终池少 2×betChips、我方投入少 betChips、
                                          被再加注时少扣 betChips；闭式解 4/4 逐位吻合）
RAISE_CONTINUE_RANGE_VALID     = NO      （管线正确：同源、已归一化、与诊断字段逐位一致；
                                          但**桶的构成**由被抬高的价格门槛决定 ⇒ 数值不是
                                          「他跟注我时的真实权益」）
MODEL_RANKING_STABLE           = NO      （5 个深度节点中 2 个顺序反转；其中 HAND 03 反转幅度
                                          在决策容差带内 ⇒ 应记为「跨动作不确定」）
SIZE_RESPONSE_VALID            = PARTIAL （结构方向有效：P(弃) 单调不减、继续率与再加注率单调
                                          不增 —— 29 个尺寸点无一次违反；量级无效：价格门槛
                                          系统性偏高 7.7–9.3pp、ΔEV 随下注额线性放大）
PROFILE_SENSITIVITY_VALID      = NOT_TESTED（停止于 P0，§A；本轮不给出结论）
ALL_IN_DECISION_VALID          = NO      （Hero 全下 ⇒ rr=0 正确；但全下本身的 EV 用错口径，
                                          且被再加注分支少扣筹码 ⇒ 全下被系统性**高估**）
SAFE_TO_CONTINUE_HAND_TESTING  = NO      （数值层面不可依赖：小注/中等权益节点误差 4–32 筹码、
                                          低权益大注节点误差上千筹码；边际节点的名次可能反转。
                                          CALL/FOLD、范围与权益链路仍可信，可继续用于复盘，
                                          但**不得**把 RAISE EV 当作实战依据）
SAFE_TO_DECLARE_U1_STABLE      = NO      （另有 3 项未完成 / 4 类未支持 ⇒ 按规程不得记 PASS）
```

---

## 附：本轮新增物（全部只读）

| 文件 | 性质 |
|---|---|
| `scripts/u1-audit-ev-convention.ts` | 新增只读审计脚本（最小复现 + 独立复算 + 闭式解 + 价格/增量契约检查 + 下注尺寸扫描） |
| `reports/evidence/u1-audit-ev-convention.txt` | 上述脚本的原始输出 |
| `reports/U1_RAISE_EV_LIGHT_AUDIT.md` | 本报告 |

产品代码、测试、策略参数：**零改动**。
