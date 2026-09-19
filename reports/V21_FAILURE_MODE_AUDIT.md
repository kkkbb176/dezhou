# V21 画像（PLAYER PROFILE）链路失败模式审计 —— 18 项

- **审计对象**：`analyzeManualHand` → `buildDecisionContext` → `behaviorProfileOf` → `applyLikelihoodUpdates`
  → `estimateUnifiedActionLikelihood` → `riverComboClassOf` / `profileClassMasses` → `decideAlpha`
- **审计者**：独立审计代理（只读 `src/`、`test/`；未修改任何既有文件）
- **环境**：Windows / Node v24.19.0 / `node --experimental-strip-types`（无测试框架，`node:test`）
- **基座夹具**：`test/profileQuantificationGolden.test.ts:82-126`（9-max · Hero CO A♣J♥ ·
  河牌 A♦8♠4♠2♣K♦ · CO 开池 2.5 → BB 跟 · 翻牌 BB 过/Hero 2/BB 跟 · 转牌 BB 过/Hero **check-back** ·
  河牌 BB **下注 7** → Hero 决策）。`AnalyzeOptions = {rules, asOf: 1_757_000_000_000, writeLog:false, budget:{softMs:120000,hardMs:240000}}`
- **探针脚本**（交付物，全部可复跑）
  | 脚本 | 覆盖 |
  |---|---|
  | `scripts/v21-fmaudit-model.ts` | items 1/2/3/4/5/6/10/17 的**模型层**（直接调生产函数） |
  | `scripts/v21-fmaudit-pipeline.ts` | items 3/4/6/7/8/9/10/11/12/13/14/16/17/18 的**生产管线**（A–J 共 10 组） |
  | `scripts/v21-fmaudit-noise.ts` | item 15（估计量/种子敏感度） |
  | `scripts/v21-fmaudit-dedup.ts` | item 12 的机制验证（决策层去重判据） |
  | `scripts/v21-fmaudit-seven-handed.ts` | item 18 补充：7 人局（9 座容量 − 2 座）与 `tableSize=7` 的对照 |
  | `scripts/v21-fmaudit-diag-shape.ts` | 辅助：`decision.diagnostics` 字段形状 |
- **原始输出**：`reports/evidence/v21-fmaudit-*.out.txt`（本报告引用的每一行数字都在其中，逐字可查）
- **锁定测试**（本次实跑，全部通过）
  - `test/profileV2Metrics.test.ts` + `test/profileQuantification.test.ts`：`pass 15 / fail 0`
  - `test/profileRangeAdjustment.test.ts`：`pass 14 / fail 0`
  - `test/profileQuantificationGolden.test.ts`：`pass 5 / fail 0`
  - `test/rangeProfileIntegration.test.ts`：`pass 14 / fail 0`

**判定口径**：PASS = 我实跑并确认失败模式被挡住（且能指出挡住它的 `file:line` 或锁定测试）；
FAIL = 我实跑并确认失败模式**活着**（给出机制 + 观测数值 vs 期望值）；
NOT_TESTED = 没跑。**本报告 PASS 的每一项都附实跑命令与原始数字。**

---

## 汇总表

| # | 触发（我实际执行的输入） | 期望（依据） | 实际观测 | 判定 |
|---|---|---|---|---|
| 1 | `observed:{riverBluff:{0,0}}`；管线 B1 | 逐位等于先验、`observedRate=null`、`confidence=0`（`behaviorProfile.ts:102-127`；NEUTRAL_PARITY 锁） | `effectiveRate=0.28===priorRate`；管线权益 0.5761 与「不传 observed」逐位相同 | **PASS** |
| 2 | `observed` 1/1、2/2、0/1、1/2 | 收缩（小样本 ≈ 先验）`behaviorProfile.ts:82-86`；`test/profileQuantification.test.ts:42` | 1/1→0.382857、2/2→0.46、0/1→0.24、1/2→0.335（先验 0.28）；2/2 的 PURE_AIR 似然 0.0737（中性 0.0568，×1.30） | **PASS** |
| 3 | ① `manual:{}`；② 只给 `observed.riverBluff`；③ 缺 board / 缺底牌；④ **注入残缺 `behaviorProfile`（`traits` 少键）** | ①②缺失条目回落到池先验（`behaviorProfile.ts:451-457`）；③解析层阻断；④应被校验或以明确错误拒绝 | ①②③ 全部符合；④ **整条分析失败**：`stage=CONTEXT`，`CONTEXT_BUILD_FAILED：Cannot read properties of undefined (reading 'effectiveRate')` | **FAIL**（④） |
| 4 | `successes=NaN`、`opportunities=NaN`、`priorWeight=Infinity`、`opportunities=Infinity`、`successes=-3`、`99/10`、浮点机会数 | 必须 finite 且有界（`behaviorProfile.ts:97` 只对 `priorRate` 做了 `Number.isFinite` 守卫；`validateActionModel` 要求 likelihood finite） | NaN/Infinity **穿透**：`effectiveRate=NaN`→`likelihood=NaN`（`clamped=true`）→`RANGE_VALIDATION_FAILED`→**河牌动作的贝叶斯更新被整条丢弃**；权益 0.5626→**0.6751（+11.25pp）**、callEV 12.44→17.73；负数/越界/`priorRate` 越界均被正确钳位 | **FAIL** |
| 5 | 注入 `effectiveRate ∈ {0, 0.001, 0.999, 1}`；`observed` 0/100000、100000/100000 | `rateOdds` 钳到 `[1e-3,0.999]`（`behaviorProfile.ts:592-595`）、`likelihood` 钳到 [0,1] 且**钳位可见**（`:929-932`） | 单条几率比 ∈ `[0.004, 3996]`（有限）；经 `behaviorProfileOf` **到不了** 0/1（1.68e-5 / 0.999957）；注入 1.0 → `raw=163.6`、`like=1.0`、`clamped=true`，轨迹写明 `钳位 490/990（**饱和：类别区分被压平！**）` | **PASS** |
| 6 | 同一 `observed 30/50`，`asOf=2020-01-01` vs `asOf=2125` | 陈旧证据应被衰减/标注（本项要求） | **逐位相同**：权益 0.5770/0.5770、诈唬质量 0.0520/0.0520、动作 CALL/CALL；`StatEvidence` 与 `PlayerBehaviorProfile` **没有任何时间字段**，`asOf` 只进 `buildDynamicSnapshot`（`contextBuilder.ts:3400`） | **FAIL**（未设防） |
| 7 | 同一手重复计数：`observed` 1/1 → 2/2 → 10/10 → 100/100 | 同一手不得被数多次（本项要求） | 无任何 hand-id 概念；重复**单调**抬高画像：权益 0.5768→0.5773→0.5803→**0.5908**、诈唬质量 0.0515→0.0528→0.0595→**0.0830**（中性 0.0184）、confidence 0.143→0.943 | **FAIL**（未设防） |
| 8 | `villain.playerId ∈ {'BB','seat_BB','nonsense','BTN','CO'}`；画像对象自带 `playerId` | 画像应绑到「那个玩家」；错绑/不绑必须可见 | 绑定只认 `input.villain.playerId` 且必须等于内部 id `seat_<位置>`（`reconstruct.ts:290`）：`'BB'`/`'nonsense'`/`'BTN'` 一律**静默丢弃画像**（权益 0.5626 = 无画像基线，无 warning/无 issue）；`'seat_BB'` 生效（0.5761）。**画像对象自己的 `playerId` 被完全忽略**（I4：`playerId='seat_BTN'` 但不写输入字段 ⇒ 0.3329 = 无画像）。`villains[1..]` 整条丢弃（`manualInput.ts:911`） | **FAIL** |
| 9 | 换座：同一 `behaviorProfile` 对象换座位再分析；`seatProfiles` 通道 | 画像应跟玩家走；座位级画像通道应生效 | 身份是**座位**（id = `seat_<位置>`），没有跨手玩家实体；`seatProfiles={BB:'MANIAC'}` 对范围链**零影响**（0.5626 = 基线；`seatProfiles` 只喂多人 `betDecision` 维度，`contextBuilder.ts:3491-3518`）；换座后旧 id 静默失配（E2 `'seat_BTN'`：该座已弃牌 ⇒ 基线） | **FAIL** |
| 10 | `observed.riverBluff = 12/50`（行为分母）vs `12/1000`（总手数分母）；`unknown=500` + `opportunities=1` | 分母必须是「该行为的机会数」（`behaviorProfile.ts:56-57` 明文）；不合口径应被拦 | 无任何口径校验：`effectiveRate 0.244286 vs 0.013598`（相差 **23.45×** 几率比），而 `confidence` 反而从 **0.893 升到 0.994**；管线权益 0.5742→0.5709（−0.32pp）、诈唬质量 0.0457→0.0384（−0.72pp）；`unknown=500 / opportunities=1` 被接受 | **FAIL** |
| 11 | 弃牌者：死牌集合、支持集、分母；合成「已弃牌但底牌已知」状态 | 未知底牌不得被当死牌剔除；弃牌者不得进入分母（`contextBuilder.ts:3127`；`rangeFacts.ts:219-238`） | 死牌 = Hero 2 + 公共牌 5 ⇒ 条目数 **990 = C(45,2)**（轨迹 `钳位 N/990`）；`realized=1 / opponentRanges=1`；质量分母 `totalMass=1.0`、`reachable=449`、`unclassified=0`；合成状态（UTG 弃牌但底牌已知 AsKs）权益 0.5626 = 对照 0.5626（代码从不读他人 `holeCards`） | **PASS** |
| 12 | ①`quickProfile=MANIAC`+**显式中性画像**（只开倾斜通道）②只注入画像（只开似然通道）③界面路径（两条都开）④多人池中画像家≠首要对手 | 同一份证据只能计一次（`contextBuilder.ts:1345-1351`、`postflopAdvisor.ts:457-475`，T4 锁） | ①−0.0588pp（形状层 ×1.004–1.150 作用于 **990/990** 组合）②+1.4057pp ③+1.3503pp ⇒ **同一 UI 读同时进两条通道**；④去重闸门 `profileRangeEvidence?.provider.applied`（`postflopAdvisor.ts:468`）在「画像家≠首要对手」时拿不到证据：权益已被画像推动 **+3.275pp**，而 `bluffCatchDelta=0.035000, deDuplicated=false`（单挑对照 `0.000000 / true`）⇒ 范围一次 + 决策层一次 | **FAIL** |
| 13 | 同进程交替 MANIAC/CS/MANIAC/CS/MANIAC；模块级缓存清单 | 缓存键不得漏掉画像 | MANIAC 三次逐位相同（权益 0.5761、诈唬质量 0.0500、轨迹**逐字相等**）、CS 两次逐位相同；`WEIGHT_CACHE` 只按 `rfi/3bet/defend:tier` 键（与画像无关，`preflopPriors.ts:689-697`）、`potentialCache` 按组合 id、`createCachedResolver` **无生产调用者** | **PASS** |
| 14 | 无画像 / `UNKNOWN` / `NORMAL` / 显式池先验画像；48 格网格 | 必须与「画像前路径」逐位相同（`behaviorProfile.ts:624-628`；`profileRangeIntegration.test.ts:120`；T3） | A1=A2=A3=A4 权益 **0.5625883726719894**、诈唬质量 0.018421 **逐位相同**；NEUTRAL_PARITY 测试通过（3 尺寸 × 8 类别 × 2 前序线最大绝对差 0） | **PASS** |
| 15 | 7 个 `equitySeed` × 3 画像 × 2 预算；翻牌（我方下注）节点 5 个 seed | 噪声必须可量化，且**不得被当成画像效果**（`test/profileQuantificationGolden.test.ts:57-80`） | 河牌抓诈唬节点：`equitySource={"method":"EXACT","iterations":990,"confidenceHalfWidth":0}` ⇒ 跨 seed 极差 **0.0000pp**（画像信号 1.3503pp）；翻牌下注节点：`MONTE_CARLO, 20000 次, halfWidth≈0.0059` ⇒ 跨 seed 极差 **0.72pp**（无画像）/0.56pp（MANIAC），而画像在该节点的效应只有 **−0.33pp** ⇒ 落在噪声带内 | **PASS**（附「<0.7pp 不可分辨」的量化限制） |
| 16 | `bigBlindBB = 2 / 100 / 1` | 只影响筹码面额，BB 口径判断不变（`manualInput.ts:256-275`） | `bb=2` vs `bb=100`：动作 CALL/CALL、`spr=5.3636` 相同、`requiredEquity=0.297872` 相同、权益 0.576091 相同；筹码口径按 ×50 缩放（pot 33→1650、callEV 13.0763→653.8147）；`bb=1` 被解析层阻断（`INVALID_NUMBER`：必须为 ≥2 的整数） | **PASS** |
| 17 | 注入 `effectiveRate = 1 / 0.999 / 0.0001 / 0 / Infinity`（6 条目全改） | 不得产生非法概率/越界似然/范围塌缩；饱和必须可见（`behaviorProfile.ts:929-932`） | `1.0`：`raw=163.6→like=1.0`、`clamped=true`、饱和计数 **490/990** 明写进轨迹；权益 0.3720、诈唬质量 0.1412（7.7× 中性）、支持集 **449 不变**；`0`：似然 1.64e-4 > 0、支持集 449 不变、权益 0.7799；**无越界、无塌缩、无 NaN（除 item 4 的 NaN 输入本身）** | **PASS** |
| 18 | `tableSize=7`（物理容量）；9 座桌的 **7 人局**（`occupiedPositions`）；9 座 −UTG（8 人局）；4 人局多人池；翻前节点 | 不支持的桌型必须拒绝；画像不得越界到别的座位；翻前不得被画像似然污染 | `tableSize=7` → `PARSE INVALID_TABLE_SIZE（桌型只能是 6 人桌或 9 人桌）`（硬拒绝）；**7 人局在 9 座桌上被正确接受**且画像逐位一致（MANIAC 0.576091 / 跟注站 0.558080 = 9 人局同值）⇒ 容量 ∈{6,9}、本手人数由 `occupiedPositions` 表达（4/5/7/8 人局均可表达）；8 人局 = 9 座 −UTG，权益 0.5761 与单挑一致；**翻前 F1=F2=F3=F4 逐位相同（0.6157，`provider.applied=false`）**——结构原因：决策点前对手只可能有一条翻前行动 = 基础行动，被 `contextBuilder.ts:1096-1104` 跳过；4 人局画像只作用于被指定的座位，且按画像单调（MANIAC 0.3745 > 无画像 0.3349 > 跟注站 0.3243） | **PASS**（多席位的证据对象缺口计入 item 12） |

**计数：PASS 10 / FAIL 8 / NOT_TESTED 0。**

---

# 详细记录（逐项：触发 → 期望与依据 → 实跑 → 原始输出 → 判定）

## ITEM 1 零样本（opportunities = 0）—— **PASS**

**触发**：`statEvidenceOf({successes:0, opportunities:0, priorRate:0.28, priorWeight:6})`；
`behaviorProfileOf({archetype:'MANIAC', observed:{riverBluff:{successes:0,opportunities:0}}})`；管线 B1。

**期望与依据**：`behaviorProfile.ts:102-118` 明文要求「零机会时**逐位**返回先验」，
`observedRate = null`、`confidence = 0`（`:120-127`）；`NEUTRAL_PARITY` 测试（本次通过）依赖该性质。

**命令与原始输出**
```text
> node --experimental-strip-types scripts/v21-fmaudit-model.ts
ITEM 1 零样本：observed { successes: 0, opportunities: 0 }
opportunities=0: observedRate=null confidence=0.000000
  priorRate=0.280000 effectiveRate=0.280000 逐位相等=true
  observed 0/0 vs 不传 observed：riverBluff effectiveRate 0.500000 vs 0.500000 逐位相等=true
  但 source 不同：OBSERVED_HAND_HISTORY vs PROFILE_PRIOR（前者声称「实测手牌历史」，实测为 0 次）
  似然：observed0=0.147058 无observed=0.147058 逐位相等=true
```
```text
> node --experimental-strip-types scripts/v21-fmaudit-pipeline.ts
B1 MANIAC + observed 0/0   ok=true act=CALL EQ=0.5761 callEV=13.08 bluffM=0.0500 effC=136.0 ΔEQ=1.350pp
A7 quickProfile=MANIAC（界面路径） ok=true act=CALL EQ=0.5761 callEV=13.08 bluffM=0.0500 effC=136.0 ΔEQ=1.350pp
```

**判定 PASS**。唯一可记的瑕疵是 `source` 被标成 `OBSERVED_HAND_HISTORY`（实测 0 次），
但 `noteZh` 如实写了「实测 —」，且 `confidence=0`，不构成「拿先验冒充实测」。

## ITEM 2 极少样本（1/1、2/2、0/1）—— **PASS**

**期望与依据**：Beta-Binomial 后验均值 `(prior×6+s)/(6+n)`（`behaviorProfile.ts:115-118`）；
`test/profileQuantification.test.ts:42`（§33：2/2 的 effectiveRate 必须低于 60/100）本次通过。

**原始输出**
```text
ITEM 2 极少样本：1/1、2/2、0/1 的收缩
1/1: observedRate=1.000000 effectiveRate=0.382857 confidence=0.142857 相对池先验几率比=1.5952×
2/2: observedRate=1.000000 effectiveRate=0.460000 confidence=0.250000 相对池先验几率比=2.1905×
0/1: observedRate=0.000000 effectiveRate=0.240000 confidence=0.142857 相对池先验几率比=0.8120×
1/2: observedRate=0.500000 effectiveRate=0.335000 confidence=0.250000 相对池先验几率比=1.2954×
0/0: observedRate=null     effectiveRate=0.280000 confidence=0.000000 相对池先验几率比=1.0000×
5/5: observedRate=1.000000 effectiveRate=0.607273 confidence=0.454545 相对池先验几率比=3.9762×
60/100: observedRate=0.600000 effectiveRate=0.581887 confidence=0.943396 相对池先验几率比=3.5786×
2/2 画像 × PURE_AIR 似然=0.073732（钳位=false） 相对中性=1.2987×
  2/2 不会变成 100%：effectiveRate=0.460000 < 1
```
管线：`B2 1/1 → EQ 0.5768 / bluffM 0.0515`、`B3 2/2 → 0.5773 / 0.0528`、`B4 0/1 → 0.5755 / 0.0486`
（中性 0.5626 / 0.0184）。方向、幅度、单调性都符合收缩公式。

**判定 PASS**。

## ITEM 3 缺失字段 —— **FAIL（注入路径）**

**触发（4 个子例）**
1. `behaviorProfileOf({playerId:'x'})`（无 archetype / 无 manual / 无 observed）
2. `behaviorProfileOf({playerId:'x', manual:{}})`、只给 `observed.riverBluff`
3. 管线：`board: []`（street=RIVER）、`heroCards: []`
4. 管线：`villain.behaviorProfile` 少键（`traits` 只有 `riverBluff`；以及 `traits: {}`）

**期望与依据**
- 1/2：缺失条目必须回落池先验（`behaviorProfile.ts:451-457`），不得变成 0.5 或 undefined；
- 3：解析层必须阻断（`manualInput.ts:465-470`、`CARD_COUNT_MISMATCH` / `MISSING_FIELD`）；
- 4：`input.behaviorProfile` 的类型是完整 `PlayerBehaviorProfile`（`manualInput.ts:226`），
  但**解析器完全不校验它的形状**（`:731-751` 只校验 `quickProfile` / `dynamicHint`），
  而 `estimateUnifiedActionLikelihood` 直接取 `t.<trait>.effectiveRate`（`behaviorProfile.ts:742, 766, 804, 821, 841`）。

**原始输出**
```text
ITEM 3 缺失字段：无 archetype / 空 manual / 只给一个条目 / 缺 traits 键
无 archetype：isUnknownPlayer=true archetypePriorAvailable=false
  6 条目是否全部等于池先验：riverBluff=true riverLargeBetBluff=true missedDrawBluff=true
                             probeAfterTurnCheckBack=true thinValueBet=true callTooWide=true
空 manual {}：逐位等于无 manual = true
只给 observed.riverBluff：riverBluff source=OBSERVED_HAND_HISTORY，其余 5 条 source=ENVIRONMENT_PRIOR
残缺 traits（只有 riverBluff）→ 抛错：TypeError: Cannot read properties of undefined (reading 'effectiveRate')
    MISSED_FLUSH_DRAW 也抛：Cannot read properties of undefined (reading 'effectiveRate')
```
```text
F11 缺 board（street=RIVER, board=[]）  ok=false stage=PARSE
    [{"code":"CARD_COUNT_MISMATCH","message":"河牌应有 5 张公共牌，当前填了 0 张。…","field":"board"}]
F12 缺 heroCards                     ok=false stage=PARSE
    [{"code":"MISSING_FIELD","message":"Hero 手牌必须是 2 张（收到 0 张）","field":"heroCards"}]
C7 残缺画像（traits 只有 riverBluff） ok=false act=- EQ=—
    issues/stage: CONTEXT [{"code":"CONTEXT_BUILD_FAILED",
    "message":"构建决策上下文失败：Cannot read properties of undefined (reading 'effectiveRate')"}]
C8 traits={} 完全缺失                ok=false stage=CONTEXT（同上）
```

**机制**：`behaviorProfile.ts:841` `const rate = t.riverBluff.effectiveRate;` 对不存在的条目直接取属性；
`alphaPipeline.ts:1075-1082` 把任何异常包成 `CONTEXT_BUILD_FAILED` ⇒ **整手牌无法分析**。
一个只填了 `observed.riverBluff` 的调用方（例如手牌历史导入器）会把系统打挂，
错误信息是 JS 内部文案（不是「画像缺少条目 X」这种可操作提示）。**FAIL**。

## ITEM 4 非法数值（NaN / Infinity / 负数 / successes>opportunities / 浮点机会数）—— **FAIL**

**触发**：`behaviorProfileOf({observed:{riverBluff:{successes,opportunities}}})` 的 14 种取值，
经真实解析后进管线（B6–B11）。所有输入都从**生产入口**（`villain.behaviorProfile`）进，不是直接调内部函数。

**期望与依据**：`statEvidenceOf` 号称把任何输入钳到合法区间（`behaviorProfile.ts:97-101` 的 `clamp01`
与 `Math.max/min`；`:85-86` 的性质清单「有界 [0,1]」）；`validateActionModel` 要求 likelihood finite 且 ∈[0,1]
（`rangeUpdate.ts:75-102`）。**finite 这一条对 `successes` / `opportunities` / `priorWeight` 没有守卫** ——
`clamp01` 只用在 `priorRate` 上。

**原始输出（模型层）**
```text
case                          observedRate  effectiveRate  confidence  反推似然（PURE_AIR）
基线 3/10                       0.300000      0.292500       0.6250      0.057943 (clamped=false)
successes=NaN                 NaN           NaN            0.6250      NaN (clamped=true)
opportunities=NaN             NaN           NaN            NaN         NaN (clamped=true)
successes=Infinity            1.000000      0.730000       0.6250      0.108357 (clamped=false)
opportunities=Infinity        0.000000      0.000000       NaN         0.007781 (clamped=false)
priorWeight=Infinity          0.300000      NaN            0.0000      0.057943 (clamped=false)
opportunities=-5              null          0.280000       0.0000      0.056773 (clamped=false)
successes=-3                  0.000000      0.105000       0.6250      0.038077 (clamped=false)
successes=99>opportunities=10 1.000000      0.730000       0.6250      0.108357 (clamped=false)
priorRate=1.7                 0.300000      0.562500       0.6250      0.057943 (clamped=false)
priorRate=-0.4                0.300000      0.187500       0.6250      0.057943 (clamped=false)
priorRate=NaN                 0.300000      0.187500       0.6250      0.057943 (clamped=false)
opportunities=2.5（浮点）         0.400000      0.315294       0.2941      0.060063 (clamped=false)
opportunities=10.9（浮点）        0.275229      0.276923       0.6450      0.056484 (clamped=false)
priorWeight=Infinity 的 effectiveRate=NaN
```

**原始输出（管线，B6/B7 是 `successes=NaN` / `opportunities=NaN`）**
```text
B5 MANIAC + observed 30/50         ok=true act=CALL EQ=0.5770 callEV=13.12 bluffM=0.0520 effC=136.6 ΔEQ=1.437pp
B6 MANIAC + observed NaN/10        ok=true act=CALL EQ=0.6751 callEV=17.73 bluffM=0.0629 effC=177.4 ΔEQ=11.248pp
B7 MANIAC + observed 3/NaN         ok=true act=CALL EQ=0.6751 callEV=17.73 bluffM=0.0629 effC=177.4 ΔEQ=11.248pp
B8 MANIAC + observed 3/Infinity    ok=true act=CALL EQ=0.5699 callEV=12.79 bluffM=0.0361 effC=132.2 ΔEQ=0.732pp
B9 MANIAC + observed 99/10         ok=true act=CALL EQ=0.5803 callEV=13.28 bluffM=0.0595 effC=138.6 ΔEQ=1.773pp
B10 MANIAC + observed -3/10        ok=true act=CALL EQ=0.5735 callEV=12.95 bluffM=0.0441 effC=134.4 ΔEQ=1.087pp
B11 MANIAC + observed 1/2.5        ok=true act=CALL EQ=0.5758 callEV=13.06 bluffM=0.0494 effC=135.9 ΔEQ=1.324pp

B6 MANIAC + observed NaN/10: ok=true 动作=CALL 权益=0.6751 轨迹条数=4
    [FLOP] CHECK
    [FLOP] CALL
    [TURN] CHECK
    [RIVER] BET（更新失败：RANGE_VALIDATION_FAILED）      ← 河牌那一条动作的贝叶斯更新被整条丢弃
B7 MANIAC + observed 3/NaN: 同上
```

**观测 vs 期望（最小复现）**
```ts
// 最小复现：NaN 成功数 ⇒ 河牌更新被丢弃 ⇒ 权益 +11.25pp
const profile = behaviorProfileOf({
  playerId: 'villain', archetype: 'MANIAC',
  observed: { riverBluff: { successes: NaN, opportunities: 10 } },
});
analyzeManualHand({ ...黄金夹具, villain: { quickProfile: 'MANIAC', behaviorProfile: profile } }, OPTIONS);
```

- 期望：`effectiveRate` finite 且 ∈(0,1)（`statEvidenceOf` 自己声明的性质），
  或非法输入被**显式拒绝**（`INVALID_NUMBER`）而不是进入模型；
- 实际：`effectiveRate=NaN` → `rateOdds(NaN)=NaN`（`behaviorProfile.ts:592-595` 的 `Math.min/max` 对 NaN 无效）
  → `likelihood=NaN` 且 `clamped=true`（`:932` 用 `!==` 比较 NaN，恒为 true）
  → `validateActionModel` 拒绝整条动作模型 → `applyLikelihoodUpdates` 走失败分支
  → **河牌下注这条证据完全没有进入范围**：范围停留在「跟了翻牌、转牌过牌」的状态，
  权益从 0.5626 被推到 **0.6751（+11.25pp）**、callEV 12.44 → 17.73。
- 失败只写在 `range.updateTrace` 的 `action` 字段（`BET（更新失败：RANGE_VALIDATION_FAILED）`），
  **不进 `warnings`**，因此界面层若无渲染 updateTrace 就完全看不到。
- 另外 `opportunities=Infinity` 会得到 `observedRate=0`、`confidence=NaN`（静默接受）；
  `priorWeight=Infinity`（只能由注入式画像或未来扩展触发）同样得 NaN。
- 浮点机会数（2.5 / 10.9）被静默接受：不产生非法概率，但「机会数」是计数，
  没有任何整数校验（记为**观察项**，不单独计 FAIL）。

**FAIL**（机制：`src/domain/player/behaviorProfile.ts:98-101` 缺少 finite 守卫；
放大点：`src/domain/player/behaviorProfile.ts:841`（读取）→ `:928-932`（NaN 未拦）→ `src/domain/range/rangeUpdate.ts:80`（整条拒绝））。

## ITEM 5 概率边界（rate 恰好 0 或 1）—— **PASS**

**触发**：① 经 `behaviorProfileOf` 的极端观测（0/100000、100000/100000、0/1、1/1）；
② 注入 `effectiveRate = 0 / 0.001 / 0.999 / 1`（8 个类别逐个跑）；③ 单条几率比范围。

**期望与依据**：`rateOdds` 把 rate 钳到 `[0.001, 0.999]`（`behaviorProfile.ts:592-595`）⇒ 几率比有限；
`likelihood` 钳到 `[0,1]` 且 `clamped` 必须如实标记（`:929-932`）；`test/profileV2Metrics.test.ts:217`（§十七 钳位可见）本次通过。

**原始输出**
```text
（a）经 behaviorProfileOf 是否可达 0 或 1：
  0/100000: effectiveRate=0.00001679899206047637 ===0?false ===1?false
  100000/100000: effectiveRate=0.9999568025918444 ===0?false ===1?false
  0/1: effectiveRate=0.24000000000000002 ===0?false ===1?false
  1/1: effectiveRate=0.3828571428571429 ===0?false ===1?false
  manual VERY_HIGH effectiveRate=0.8 VERY_LOW=0.05
（b）注入式画像可以给出恰好 0 / 1：
  effectiveRate=0 PURE_AIR           base=0.056773 combined=0.0029 raw=0.000164 like=0.000164 clamped=false
  effectiveRate=0 MISSED_FLUSH_DRAW  base=0.056773 combined=0.0030 raw=0.000173 like=0.000173 clamped=false
  effectiveRate=1 PURE_AIR           base=0.056773 combined=2881.6146 raw=163.598942 like=1.000000 clamped=true
  effectiveRate=1 MISSED_FLUSH_DRAW  base=0.056773 combined=3033.5524 raw=172.224958 like=1.000000 clamped=true
  effectiveRate=1 NUT_VALUE          base=0.950000 combined=1.0000 raw=0.950000 like=0.950000 clamped=false
（c）大注诈唬条目单条几率比范围 = [0.00400×, 3996.0000×]（非 0、非 ∞ ⇒ 概率本身有界）
```
管线（`C2`）：轨迹 `钳位 490/990（**饱和：类别区分被压平！**）` —— 饱和**没有被静默吸收**。

**判定 PASS**：边界不会产生 NaN/∞ 概率；恰好 0/1 在正常构造路径**不可达**，
注入路径下被钳位且钳位状态可见。

## ITEM 6 陈旧数据 / 时间衰减 —— **FAIL（未设防）**

**触发**：同一 `observed = {riverBluff:{successes:30,opportunities:50}}`，
`asOf = 1_577_836_800_000`（2020-01-01）vs `asOf = 4_900_000_000_000`（2125 年）。

**期望与依据**：本项要求「旧观测/`asOf` 远未来 ⇒ 衰减或至少被识别」。
仓库内的相关契约：`behaviorProfile.ts:379` 只承诺「未来可从历史库持续更新（§二十三）；
V1 只保证结构上能绑定」——**没有**任何时间语义；`asOf` 的唯一消费者是
`buildDynamicSnapshot`（`contextBuilder.ts:3400`、`:2630-2673` 用 `asOf` 反推「几分钟前」的合成事件）。

**原始输出**
```text
ITEM 6 PlayerBehaviorProfile 字段：playerId, playerName, archetype, traits, isUnknownPlayer,
        archetypePriorAvailable, priorNoteZh
       StatEvidence 字段：observedRate, opportunities, successes, unknownOutcomeOpportunities,
        priorRate, priorWeight, effectiveRate, confidence, source, noteZh
★ 无任何时间戳 ⇒ 「5 年前的 30/50」与「昨天的 30/50」在本层逐位相同。

D1 observed 30/50，asOf=2020-01-01      ok=true act=CALL EQ=0.5770 callEV=13.12 bluffM=0.0520 effC=136.6 ΔEQ=1.437pp
D2 observed 30/50，asOf=2125（未来 100 年）  ok=true act=CALL EQ=0.5770 callEV=13.12 bluffM=0.0520 effC=136.6 ΔEQ=1.437pp
D1 vs D2 权益：逐位相等｜诈唬质量：逐位相等｜动作 CALL/CALL
```

**观测 vs 期望**：期望（若要挡住该失败模式）至少要有「观测时间」字段 + 衰减或拒绝未来时间；
实际 `StatEvidence` / `PlayerBehaviorProfile` 连字段都没有，`asOf` 对画像层**零影响**。
这是「失败模式完全活着且不可见」，不是数值错误。**FAIL**。

## ITEM 7 重复手牌（同一手被数两次）—— **FAIL（未设防）**

**触发**：`observed.riverBluff` 依次给 1/1、2/2、10/10、100/100
（语义：**同一手**被导入 1/2/10/100 次）。

**期望与依据**：`observed` 的契约是 `{successes, opportunities, unknownOutcomeOpportunities?}`
（`behaviorProfile.ts:416`）—— **没有任何 hand-id / 去重键**，
因此重复计数既不可检测也不可拒绝；`confidence = opp/(opp+priorWeight)`（`:127`）随重复次数上升。

**原始输出**
```text
D3 同一手被数两次：observed 1/1        EQ=0.5768 callEV=13.11 bluffM=0.0515 effC=136.4 confidence=0.1429
D4 同一手被数两次：observed 2/2        EQ=0.5773 callEV=13.14 bluffM=0.0528 effC=136.8 confidence=0.2500
D4b 同一手重复 10 次：observed 10/10   EQ=0.5803 callEV=13.28 bluffM=0.0595 effC=138.6 confidence=0.6250
D4c 同一手重复 100 次：observed 100/100 EQ=0.5908 callEV=13.77 bluffM=0.0830 effC=145.1 confidence=0.9434
重复计数单调抬高诈唬质量：1/1 0.0515 → 2/2 0.0528 → 10/10 0.0595 → 100/100 0.0830（中性基线 0.0184）
对应权益：0.5768 → 0.5773 → 0.5803 → 0.5908（中性 0.5626）
```
（confidence 取自模型层：`1/1 → 0.142857`、`100/100 → 0.943396`，见 item 2 输出。）

**观测 vs 期望**：同一手重复 100 次把诈唬质量从 0.0515 抬到 0.0830（中性 0.0184），
权益 +1.4pp，而「置信度」从 0.14 升到 0.94 —— 也就是说**重复计数被模型读成更强的证据**。
没有去重键、没有上界、没有告警。**FAIL**（最小复现：把同一 `{1,1}` 传两次，
与把同一手真的观测两次在数据上不可区分）。

## ITEM 8 玩家身份混淆（两个玩家共用一个 playerId / 画像给错座位）—— **FAIL**

**触发**：
- `villain.playerId ∈ {'BB','seat_BB','BTN','CO','nonsense'}`；
- 画像对象自带 `playerId = 'Alice' / 'seat_BTN' / 'seat_CO'`，输入里**不写** `villain.playerId`；
- 多人池里两个已实现对手（4 人局，首要 = CO，下注者 = BTN）。

**期望与依据**：`villainPlayerId` 是绑定画像的唯一入口（`contextBuilder.ts:3141-3142`），
`ManualVillain.playerId?: string`（`manualInput.ts:204`）**没有任何格式/取值校验**
（`:731-751` 只校验 `quickProfile`/`dynamicHint`）；实际 id 由 `reconstruct.ts:290`
`id: playerIdOfPosition(position)` 生成 ⇒ 内部形如 `seat_BB`。

**原始输出**
```text
E1  villain.playerId=BB（=位置名，非内部 id）   EQ=0.5626 callEV=12.44 bluffM=0.0184 prov=null
E1b villain.playerId=seat_BB（内部 id）        EQ=0.5761 callEV=13.08 bluffM=0.0500 prov=true
E2  villain.playerId=BTN（已弃牌的座位）        EQ=0.5626 …（画像被丢弃）
E3  villain.playerId=CO（Hero 自己的座位）      EQ=0.5626 …（画像被丢弃）
E4  villain.playerId="nonsense"（自由字符串）   EQ=0.5626 …（画像被丢弃）
E5  不写 playerId（默认第一个已实现对手）           EQ=0.5761 …（生效）
A1  无 quickProfile / 无 behaviorProfile   EQ=0.5626 ← 与 E1/E2/E3/E4 逐位相同

I0 4 人局：无画像                              EQ=0.3329
I1 画像 playerId=Alice，不写 villain.playerId   EQ=0.3329（画像对象自带 id 被忽略）
I4 画像 playerId=seat_BTN，不写 villain.playerId EQ=0.3329（同上）
I5 画像 playerId=seat_CO，不写 villain.playerId  EQ=0.3329（同上）
I3 画像 playerId=Alice + villain.playerId=seat_BTN EQ=0.3749（生效）
```

**机制**：`updateRange` 的 `actor` 用对手 id，画像只通过
`allRangeBuilds` 的 `opponent.id === villainId` 注入（`contextBuilder.ts:3199-3213`）；
`villainId` 取自输入字段。因此：
1. **写位置名（`'BB'`）或拼错 ⇒ 画像静默失效**（无 warning、无 issue、决策照常给出，
   与「根本没有画像」逐位相同）。这违反了项目自己的纪律
   「看起来设了画像、实际用中立先验比没有画像更危险」（`manualInput.ts:794-795`）。
2. **画像对象自己的 `playerId` 字段是装饰性的**（I1/I4/I5 全部等于无画像），
   于是「两个玩家共用一个 playerId」这件事在画像对象侧根本无从表达 —— 但反过来说，
   一个持久化的画像对象（带自己的 playerId）搬进新输入时会**静默失效**。
3. `villains[1..]` 整条被丢弃（`manualInput.ts:911` `villain: villainList[0] ?? {}`），
   多人池里第二个对手的 `quickProfile`/`behaviorProfile` 无法表达。

**FAIL**（最小复现：黄金夹具里写 `villain:{playerId:'BB', quickProfile:'MANIAC'}` ⇒ 权益 0.5626，
与完全不写画像逐位相同；改成 `'seat_BB'` ⇒ 0.5761）。

## ITEM 9 换座 / 重新入座（画像绑座位还是绑玩家）—— **FAIL**

**触发**：① 同一 `behaviorProfile` 对象换座位复用；② 座位级通道 `seatProfiles`；
③ 弃牌座位/非首要座位上的画像。

**期望与依据**：`ManualHandInput.seatProfiles` 的中文契约是「逐座位的快速画像 …… 
**优先级**：本表 > `villain.quickProfile`（当该座位就是 `villain.playerId`）> 中立先验」
（`manualInput.ts:295-310`）；而实际消费点只有 `betDecision` 的维度
（`contextBuilder.ts:3487-3518`），**范围/画像似然链一次都没读它**。

**原始输出**
```text
E6 seatProfiles={BB:MANIAC}（座位画像，无 villain.quickProfile）  EQ=0.5626（= 无画像基线，零影响）
E7 seatProfiles={BTN:MANIAC}（弃牌座位）                          EQ=0.5626（零影响）
E8 seatProfiles={BB:MANIAC} + villain.quickProfile=CALLING_STATION EQ=0.5581（= 只有 CALLING_STATION 生效）
I6 villain.playerId=seat_BTN（画像来自 quickProfile）              EQ=0.3745
I7 villain.playerId=seat_CO（画像来自 quickProfile）               EQ=0.3311
```
另外 `state.players` 的 id 全部是座位派生（见 item 11 输出：`seat_UTG … seat_BB`），
仓库内**没有任何跨手玩家实体**（`playerId` 就是座位 id）。

**观测 vs 期望**：
- 玩家换座位后被描述为「同一手的新座位」时，画像只能靠**手填座位 id**重新绑定；
  旧 id 失配 ⇒ 静默丢弃（E2）。
- 「座位级画像」这条契约通道对范围链**不生效**（E6/E8），
  因此**无法**表达「这个座位上的玩家是疯子」这种座位绑定语义。
- 结论：画像事实上**绑座位、不绑玩家**，且两条路（座位画像 / 玩家画像）一条失效、一条静默失配。
  **FAIL**。

## ITEM 10 错误的机会数分母（总手数 vs 行为机会数）—— **FAIL（未设防）**

**触发**：`observed.riverBluff = 12/50`（正确：50 次「河牌面对下注」机会，12 次诈唬）
vs `12/1000`（错误：把 1000 手总手数当分母）；以及 `unknownOutcomeOpportunities=500` 与 `opportunities=1` 并存。

**期望与依据**：`StatEvidence.opportunities` 的中文契约明确写「该行为的**机会数**（§二十九：不是总手数）」
（`behaviorProfile.ts:56-57`）；`unknownOutcomeOpportunities` 必须**分账**且「不计入分母」（`test/profileQuantification.test.ts:65`，本次通过）。

**原始输出（模型层）**
```text
行为分母 12/50  ： effectiveRate=0.244286 confidence=0.8929
总手数分母 12/1000： effectiveRate=0.013598 confidence=0.9940
两者相对池先验的几率比： 0.8312× vs 0.0354× ⇒ 相差 23.45×
confidence 却从 0.893 升到 0.994（错的分母看起来更可信）
★ unknownOutcomeOpportunities 与 opportunities 之间无一致性校验：
  1/1 + unknown 500 ⇒ opportunities=1 unknown=500（被接受）
```
**原始输出（管线）**
```text
D5 正确分母 12/50（河牌面对下注） ok=true act=CALL EQ=0.5742 callEV=12.99 bluffM=0.0457 ΔEQ=1.156pp
D6 错分母 12/1000（总手数）       ok=true act=CALL EQ=0.5709 callEV=12.83 bluffM=0.0384 ΔEQ=0.834pp
D5 vs D6（分母错 20 倍）权益差 = -0.3224pp｜诈唬质量差 = -0.7224pp｜动作 CALL vs CALL
```
**观测 vs 期望**：公式本身正确，但**没有任何机制阻止调用方传入错误口径的分母**，
而且错误的方向会得到**更高的置信度**（0.893→0.994）——「错得更自信」。
`unknown` 与 `opportunities` 之间也没有一致性约束（500 > 1 被接受）。
风险在于：这是唯一的外部输入通道（`/api/analyze` 的 JSON body 原样透传，
`webServer.ts:679-816` 不做字段级语义校验）。

**FAIL**（最小复现：同一份真实统计，若调用方把 `opportunities` 填成总手数，
诈唬条目几率比被压到 0.035×，诈唬质量 0.0457→0.0384，且 confidence 从 0.89 升到 0.99）。

## ITEM 11 弃牌后的未知底牌（分母 / 范围）—— **PASS**

**触发**：黄金夹具（6 家翻前弃牌）的 `state.players`、范围支持集、质量分母；
以及**合成状态**（把已弃牌的 UTG 底牌人为设成 AsKs）再跑一次。

**期望与依据**：死牌集合 = Hero 底牌 + 公共牌（`contextBuilder.ts:3127`
`const deadCards = [...(hero.holeCards ?? []), ...allBoardCards(state)]`）；
`rangeFacts.ts:219-238` 的质量分母跳过与 Hero/公共牌重叠的组合；
`contextBuilder.ts:3103-3105` 只对**已实现**对手建范围。

**原始输出**
```text
state.players 的 id / 位置 / 是否弃牌 / holeCards：
    id=seat_UTG  pos=UTG  folded=true  holeCards=null（未知）
    id=seat_CO   pos=CO   folded=false holeCards=14c11h
    id=seat_BB   pos=BB   folded=false holeCards=null（未知）
    （其余 6 席均 folded=true / holeCards=null）
持有底牌的玩家数 = 1（只有 Hero）
activeOpponentCount=1 realizedOpponentCount=1 playersYetToAct=0 opponentRanges=1
首要对手范围：supportSize=449 sourceKind=HEURISTIC supportShare=0.3386
profileClassMasses：totalMass=1.0000 reachableRangeCount=449 effectiveCombos=127.24 unclassifiedMassShare=0.000000
★ 死牌集合口径 = Hero 底牌 2 张 + 公共牌 5 张 ⇒ 可用牌 45 张 ⇒ C(45,2)=990 个组合
  实测 range.entries 数（轨迹「钳位 N/990」）= 990 ⇒ 与「只有 Hero+公共牌是死牌」一致
  ⇒ 弃牌者的未知底牌**没有**被当成死牌（正确：它们不可知，也没有被踢出范围）
合成状态（UTG 已弃牌但底牌已知 = AsKs）：supportSize=449 reachableRangeCount=449 权益=0.5626
  对照（未合成）：                        supportSize=449 reachableRangeCount=449 权益=0.5626
```

**判定 PASS**：未知底牌既没有被当成死牌剔除，也没有进入任何分母；
弃牌者不建范围、不进权益分母。**附一条边界说明**：代码**从不读其他玩家的 `holeCards`**，
所以若将来手牌历史导入器能提供「已弃牌但已知的底牌」，它们**不会**被加进 `deadCards`
（合成实验证明了这一点：结果逐位不变）—— 那时需要在 `contextBuilder.ts:3127` 补一条来源。

## ITEM 12 历史证据与当前证据重复计票 —— **FAIL（两处，其中一处实测 3.275pp + 0.035 偏移）**

**触发（4 组对照，全部走生产入口）**
- A5：**只**注入 `behaviorProfile(MANIAC)`（无 `quickProfile`）⇒ 只开「统一似然」通道；
- A6：`quickProfile=MANIAC` + **显式中性画像** ⇒ 只开「倾斜 provider」通道；
- A7：`quickProfile=MANIAC`（界面路径）⇒ 两条通道都开；
- J1–J5 / C–D（`scripts/v21-fmaudit-dedup.ts`）：单挑 vs 4 人局，画像家是否首要对手。

**期望与依据**
- `contextBuilder.ts:1345-1351`：「画像似然生效时必须抑制它 …… 再乘一次倾斜因子等于把画像计两次」；
- `postflopAdvisor.ts:457-475`：画像已进范围 ⇒ `bluffCatchDelta` 记 0 并标 `deDuplicated`；
- `test/profileRangeAdjustment.test.ts:352`（T4，本次通过）锁定该去重。

**原始输出（A 组：同一 UI 读进两条通道）**
```text
A1 无 quickProfile / 无 behaviorProfile  EQ=0.5626 callEV=12.44 bluffM=0.0184 effC=127.2
A5 只注入 MANIAC behaviorProfile         EQ=0.5766 callEV=13.10 bluffM=0.0500 effC=135.6   （只似然通道 +1.4057pp）
A6 quickProfile=MANIAC + 中性画像         EQ=0.5620 callEV=12.41 bluffM=0.0184 effC=127.7   （只倾斜通道 −0.0588pp）
   维度来源=USER_ARCHETYPE applied=true 形状层生效=true
   形状层 ×1.004–1.150（990/990 生效）｜似然层 ×0.938–0.957（2970/2970 生效）
A7 quickProfile=MANIAC（界面路径）        EQ=0.5761 callEV=13.08 bluffM=0.0500 effC=136.0   （两条都开 +1.3503pp）
A7 轨迹：统一动作似然 V2（…同一条动作上抑制 adjustmentProvider）：… 条目数 0–3；钳位 0/990（无饱和）
A6 轨迹：[FLOP] CHECK / [FLOP] CALL / [TURN] CHECK（三条都调用了 provider）
```
- `finalMultiplier.calls = 2970 = 3 次更新 × 990 组合`（翻牌过牌、翻牌跟注、转牌过牌），
  **河牌那条被抑制** ⇒ 同一条动作上的抑制**确实生效**（这一点是 PASS 的子项）。
- 但 `comboWeightMultiplier.calls = 990`、`effective = 990/990` ⇒ 形状层在**第一次更新**
  就把同一个 `quickProfile` 的维度乘进了到达范围（`×1.004–1.150`），
  而河牌的统一似然又把同一个 `quickProfile` 的条目乘了一遍 ⇒ **同一份用户读进入两次**。

**原始输出（去重闸门在多人池下失效 —— 决定性证据）**
```text
> node --experimental-strip-types scripts/v21-fmaudit-dedup.ts
A 单挑 9-max：BLUFF_HEAVY（画像家＝首要 BB）   权益=0.572429 首要=seat_BB realized=1
   evidence=有(applied=true before=0.562588 after=0.572429)
   exploit: applied=true bluffCatchDelta=0.000000 deDuplicated=true
B 单挑 9-max：无画像                          权益=0.562588 evidence=无 exploit: applied=false
C 4 人局：BLUFF_HEAVY@seat_BTN（画像家≠首要 CO） 权益=0.367642 首要=seat_CO realized=2
   evidence=无                                  ← 拿不到证据对象
   exploit: applied=true bluffCatchDelta=0.035000 deDuplicated=false   ← 去重没有发生
D 4 人局：BLUFF_HEAVY@seat_CO（画像家＝首要 CO） 权益=0.328708 evidence=有(applied=true) 
   exploit: applied=true bluffCatchDelta=0.000000 deDuplicated=true
E 4 人局：无画像                              权益=0.334892 exploit: applied=false
```
```text
J3 vs J5（4 人局：画像家在 BTN，非首要）权益差 = 3.2750pp   ← 画像确实改了范围
J1 vs J2（单挑：画像 vs 无画像）权益差 = 0.9840pp
J4 vs J5（4 人局：画像家＝首要 CO）权益差 = -0.6183pp
```

**机制（file:line）**
1. 形状层：`src/domain/player/tendencyProvider.ts:358-380`（`adjustComboWeight` 只在第一次更新生效）
   + `src/app/manualInput/contextBuilder.ts:1343-1352`（只在**同一条动作**上抑制 provider）；
2. 去重闸门：`src/app/decision/postflopAdvisor.ts:468` `rangeProfileApplied = context.profileRangeEvidence?.provider.applied === true`，
   `:472` `bluffCatchDelta: rangeProfileApplied ? 0 : exploit.bluffCatchDelta * scale`；
3. 证据对象的来源：`src/app/manualInput/contextBuilder.ts:3220-3233`（`primaryBuild` = **首个已实现对手**）
   + `:3305-3306`（`const core = rangeBuild.tendency ?? null; if (core === null) return null;`）。
   ⇒ 当画像家**不是**首要对手时 `profileRangeEvidence` 为 `undefined`，去重闸门恒为 false。

**观测 vs 期望**：期望「同一份画像证据只计一次」（T4 在单挑下成立：`0.000000 / true`）；
多人池且画像家非首要时，同一份 `BLUFF_HEAVY` 读**既**改了范围（权益 +3.275pp）
**又**保留了 `bluffCatchDelta = 0.035` 的决策层抓诈唬偏移（`deDuplicated=false`）。
另外 `profileClassMasses` / `opponentRangeFacts` 也只对**首要对手**计算
（`contextBuilder.ts:3469-3473`），因此多人池下画像对手的质量变化**不上报**
（F7/I6 的 `bluffM=0.0830` 与无画像的 F8/I0 完全相同）。**FAIL**。

## ITEM 13 缓存未失效（模块级缓存键漏掉画像）—— **PASS**

**触发**：① 同进程交替画像：MANIAC → CALLING_STATION → MANIAC → CALLING_STATION → MANIAC；
② `grep` 全部模块级缓存并逐个看键。

**期望与依据**：任何按「输入」缓存的结果都必须把画像纳入键；
既有先例 `test/rangeProfileIntegration.test.ts:120`（无 provider 时与旧版逐位一致）本次通过。

**原始输出**
```text
G1 MANIAC（第一次）            EQ=0.5761 callEV=13.08 bluffM=0.0500 effC=136.0 ΔEQ=1.350pp
G2 CALLING_STATION（第二次）    EQ=0.5581 callEV=12.23 bluffM=0.0078 effC=125.6 ΔEQ=-0.451pp
G3 MANIAC（第三次）            EQ=0.5761 …（与 G1 逐位相同）
G4 CALLING_STATION（第四次）    EQ=0.5581 …（与 G2 逐位相同）
G5 MANIAC（第五次）            EQ=0.5761 …（与 G1 逐位相同）
G1 vs G3: EQ 逐位相等；bluffMass 逐位相等；轨迹条数 4/4
G1 vs G3 全部轨迹文本逐字相等：true
```
缓存清单（`grep`，`src/**/*.ts`）：
- `preflopPriors.ts:689-697` `WEIGHT_CACHE`，键 `rfi:${tier}` / `3bet:${tier}` / `defend:${tier}`，
  `tier` 只由 `(tableSize, position)` 决定 ⇒ 与画像无关；
- `handPotential.ts:84` `potentialCache`，键 = `combo.canonicalId` ⇒ 与画像无关；
- `rangeCache.ts:232-247` `createCachedResolver` / `RangeCacheKeyInput`（`rangeCache.ts:1-20`）
  **无生产调用者**，且其键本来也没有画像维度；
- GTO 缓存与画像链路无关（且属于禁改范围）。

**判定 PASS**。

## ITEM 14 中性画像回归（UNKNOWN / NORMAL 必须与画像前逐位一致）—— **PASS**

**触发**：① 不传任何画像；② `quickProfile='UNKNOWN'`；③ `'NORMAL'`；
④ 显式注入 `behaviorProfileOf({playerId:'neutral'})`（六条目全为池先验）。
另：锁定测试 `test/profileV2Metrics.test.ts`（NEUTRAL_PARITY 48 格）、
`test/profileRangeAdjustment.test.ts` T3、`test/rangeProfileIntegration.test.ts:120`。

**期望与依据**：`behaviorProfile.ts:624-628`（中性画像三个调整因子恰为 1.0 ⇒ 逐位等于既有档位权重）；
`contextBuilder.ts:3168-3175`（`UNKNOWN` 与「没有画像」一样，保持既有路径）。

**原始输出**
```text
A1 无 quickProfile / 无 behaviorProfile  EQ=0.5626 callEV=12.44 bluffM=0.0184 airM=0.0064 sup=449 effC=127.2
A2 quickProfile=UNKNOWN                EQ=0.5626 callEV=12.44 bluffM=0.0184 airM=0.0064 sup=449 effC=127.2
A3 quickProfile=NORMAL                 EQ=0.5626 callEV=12.44 bluffM=0.0184 airM=0.0064 sup=449 effC=127.2
A4 只注入中性 behaviorProfile            EQ=0.5626 callEV=12.44 bluffM=0.0184 airM=0.0064 sup=449 effC=127.2
A1 vs A2 权益：逐位相等｜诈唬质量：逐位相等
A1 vs A3 权益：逐位相等｜诈唬质量：逐位相等
A1 vs A4 权益：逐位相等｜诈唬质量：逐位相等
```
```text
> node --test --experimental-strip-types test/profileV2Metrics.test.ts test/profileQuantification.test.ts
✔ NEUTRAL_PARITY：中性画像必须在 3 尺寸 × 8 类别 × 2 前序线上与既有档位权重**逐位相等**
✔ §十七 钳位可见：03A / 03B 在黄金节点上不得出现饱和（clamped === false）
✔ 覆盖锁：RiverComboClass 的每个成员都必须真的能被 riverComboClassOf 产出
ℹ tests 15  ℹ pass 15  ℹ fail 0
> node --test --experimental-strip-types test/profileRangeAdjustment.test.ts
✔ T3：没有画像（UNKNOWN）时，画像链路必须**完全不参与**（与 NORMAL 逐位一致）
✔ T4 / T1 / T5 / T8 / T9 / T10 / T11 …  ℹ tests 14  ℹ pass 14  ℹ fail 0
> node --test --experimental-strip-types test/profileQuantificationGolden.test.ts
✔ §二十 03A vs 03B：诈唬质量、错过听牌质量、权益与 EV 必须单调
ℹ tests 5  ℹ pass 5  ℹ fail 0
> node --test --experimental-strip-types test/rangeProfileIntegration.test.ts
✔ 未提供 provider 时，结果与旧版本逐位一致，且 provider 日志为 null
ℹ tests 14  ℹ pass 14  ℹ fail 0
```

**判定 PASS**（4 条路径 + 4 个测试文件全部逐位/全绿）。

## ITEM 15 随机采样噪声（多少差异是真的）—— **PASS（附量化上限）**

**触发**：同一夹具逐行改 `equitySeed ∈ {1,2,3,42,1234,20260913,999999999}`，
两种预算（宽裕 120s / 交互默认），三种画像（无 / MANIAC / CALLING_STATION）；
另取一个「我方主动下注」的翻牌节点（Hero CO A♣J♥ / A♦8♠4♠ / BB 过牌）扫 5 个 seed。

**期望与依据**：`test/profileQuantificationGolden.test.ts:57-80` 明文要求
「若回落到蒙特卡洛，报告必须给出**采样分辨率**，不得把噪声当成画像效果」；
`equitySource` 必须如实标注 method / iterations / halfWidth（`decision.types.ts:173-175`）。

**原始输出（河牌抓诈唬节点：确定性估计量 ⇒ 0 噪声）**
```text
[无画像] equitySource = {"method":"EXACT","iterations":990,"confidenceHalfWidth":0,"downgradedFromExact":false}
[MANIAC] equitySource = {"method":"EXACT","iterations":990,"confidenceHalfWidth":0,"downgradedFromExact":false}
===== 无画像（宽裕预算 120s） ===== 7 个 seed：权益 0.562588（全部相同） ⇒ 极差 = 0.0000pp
===== MANIAC（宽裕预算 120s） ===== 7 个 seed：权益 0.576091（全部相同） ⇒ 极差 = 0.0000pp
===== CALLING_STATION（宽裕预算）===== 7 个 seed：权益 0.558080（全部相同） ⇒ 极差 = 0.0000pp
===== 无画像 / MANIAC / CALLING_STATION（交互默认预算） ===== 同样全部 0.0000pp
诈唬质量极差 = 0.000000pp（全部配置）
```
⇒ 在这个节点上，画像信号（MANIAC 57.6091% vs 无画像 56.2588% = **+1.3503pp**；
跟注站 55.8080% = **−0.4508pp**）远高于噪声下限 0。

**原始输出（翻牌下注节点：蒙特卡洛 ⇒ 噪声 >（部分）画像效应）**
```text
[无画像] 估计={"method":"MONTE_CARLO","iterations":20000,"confidenceHalfWidth":~0.00585}
  seed=1 权益=0.76465 | seed=2 0.7638 | seed=20260913 0.768825 | seed=777 0.761625 | seed=999999999 0.76465
  ⇒ 极差 = 0.0072 = 0.72pp；checkEV 6.1401/6.1333/6.1737/6.1158/6.1401（极差 0.058 筹码）
[MANIAC] 
  seed=1 权益=0.766775 | seed=2 0.7614 | seed=20260913 0.76555 | seed=777 0.761225 | seed=999999999 0.76475
  ⇒ 极差 = 0.00555 = 0.56pp
同 seed（20260913）画像效应 = 0.76555 − 0.768825 = −0.3275pp  ← **落在 0.56–0.72pp 的噪声带内**
postflop.uncertaintyBandChips = 2.35（模型自报容差带）；MANIAC vs 跟注站 callEV 差 = 0.85 筹码 < 2.35
```
（每个尺寸的 `foldLikelihood/callLikelihood/raiseLikelihood` 跨 seed **逐位相同** ——
采样噪声只出现在权益/EV，不出现在响应树的频率上。）

**判定 PASS**：噪声被如实标注（`method/iterations/halfWidth`）且可量化；
结论也要照实写：**河牌抓诈唬节点上画像效应可分辨；蒙特卡洛节点上 < ~0.7pp 的权益差不可归因于画像**
（正是审计要问的「多大的 delta 是真的」）。

## ITEM 16 下注单位混淆（BB vs 筹码）—— **PASS**

**触发**：同一黄金手，`bigBlindBB ∈ {2, 100, 1}`。

**期望与依据**：`manualInput.ts:256-275`（`bigBlindBB` 只影响绝对筹码换算，不影响任何 BB 口径判断）；
红队 F-07 的历史（该字段曾是死字段，现在 `reconstruct.ts:252-281` 真的读它）。

**原始输出**
```text
  A7 quickProfile=MANIAC（bb=2）     动作=CALL pot=33.0000    spr=5.3636 reqEQ=0.297872 EQ=0.576091 callEV=13.0763
  A1 无画像（bb=2）                  动作=CALL pot=33.0000    spr=5.3636 reqEQ=0.297872 EQ=0.562588 callEV=12.4417
  F9 bigBlindBB=100（同一手）        动作=CALL pot=1650.0000  spr=5.3636 reqEQ=0.297872 EQ=0.576091 callEV=653.8147
  F10 bigBlindBB=1（同一手）         动作=-   stage=PARSE
     [{"code":"INVALID_NUMBER","message":"大盲的筹码面额必须是**不小于 2 的整数**（收到 1）…","field":"bigBlindBB"}]
```
- `bb=2 → bb=100`：决策动作、SPR、所需权益、权益**逐位不变**；筹码口径按 ×50 缩放
  （底池 33→1650 筹码、callEV 13.0763→653.8147 筹码）⇒ 唯一的量纲差是**显示面额**，符合契约。
- `bb=1` 被解析层拒绝（要求整数 ≥2），因此不存在「小盲无法用整数筹码表示」的静默取整。
- 画像相关量（`betRatio` = 下注/底池、`sizeBucket`、`likelihoodWeights` 的下注量放大器）
  全部是无量纲比值 ⇒ 无 2 倍/50 倍串档路径。

**判定 PASS**。

## ITEM 17 极端画像值主导（非法概率 / 范围塌缩）—— **PASS**

**触发**：① 四个有先验原型（MANIAC / CALLING_STATION / BLUFF_HEAVY / UNDERBLUFFER）在 8 个类别上的似然；
② **注入式**全条目极值：`effectiveRate = 0.999 / 1 / 0.0001 / 0 / Infinity`（经生产入口）；
③ 模型层检查似然是否可能 ≤0 或 NaN。

**期望与依据**：`behaviorProfile.ts:929-932`（钳到 [0,1] 且 `clamped` 显式）+
`:924-926`（几何平均，结构槽位分母，避免 417× 复合饱和）；
`test/profileV2Metrics.test.ts:217`（03A/03B 在黄金节点不得饱和）本次通过；
`rangeUpdate.ts:75-102`（非法似然会被拒绝 ⇒ 不应出现）。

**原始输出（模型层）**
```text
MANIAC           NUT_VALUE:0.9500 STRONG_VALUE:0.4731 THIN_VALUE:0.2271 SHOWDOWN_VALUE:0.1325
                 MISSED_FLUSH_DRAW:0.1655 MISSED_STRAIGHT_DRAW:0.1655 MISSED_COMBO_DRAW:0.1655 PURE_AIR:0.1471
CALLING_STATION  … MISSED_*:0.0221 PURE_AIR:0.0245
BLUFF_HEAVY      … MISSED_*:0.1370 PURE_AIR:0.1217
UNDERBLUFFER     … MISSED_*:0.0221 PURE_AIR:0.0209
--- 全条目极值（注入式：6 条全部 effectiveRate=0.999） ---
  NUT_VALUE  base=0.950000 combined=1.0000    raw=0.950000  like=0.950000 clamped=false
  THIN_VALUE base=0.227093 combined=43.0730   raw=9.781602  like=1.000000 clamped=true
  PURE_AIR   base=0.056773 combined=2881.6146 raw=163.598942 like=1.000000 clamped=true
--- 全条目 0.0001 ---
  PURE_AIR   base=0.056773 combined=0.002887 raw=0.000164 like=0.000164 clamped=false（>0? true）
  NUT_VALUE  base=0.950000 combined=1.000000 raw=0.950000 like=0.950000 clamped=false（>0? true）
```
**原始输出（管线）**
```text
C1 全条目 effectiveRate=0.999（注入）  ok=true act=CALL EQ=0.3720 callEV=3.48 bluffM=0.1412 sup=449 effC=94.2
C2 全条目 effectiveRate=1（注入）      ok=true act=CALL EQ=0.3720 callEV=3.48 bluffM=0.1412 sup=449 effC=94.2
C3 全条目 effectiveRate=0.0001（注入） ok=true act=CALL EQ=0.7799 callEV=22.65 bluffM=0.0001 sup=449 effC=92.5
C4 全条目 effectiveRate=0（注入）      ok=true act=CALL EQ=0.7799 callEV=22.65 bluffM=0.0001 sup=449 effC=92.5
C2 轨迹：[RIVER] BET —— … 钳位 490/990（**饱和：类别区分被压平！**）
（中性基线：EQ=0.5626 callEV=12.44 bluffM=0.0184 sup=449 effC=127.2）
```
- 似然恒在 [0,1]：极值只表现为**钳到 1**（`clamped=true`，且饱和计数写进轨迹）与**极小但 >0**
  （1.64e-4）—— 后者保证不会有组合被静默删掉；
- 范围**不塌缩**：`supportSize` 恒为 449、`reachableRangeCount=449`、`unclassifiedMassShare=0`
  （`reweightCombos` 归一化，`behaviorProfile.ts:1068`）；
- 极端画像的**幅度**很大（权益 0.3720 vs 0.7799，跨 40.8pp；诈唬质量 0.0001 vs 0.1412），
  但这是「极端输入 ⇒ 极端输出」的定义行为，且有饱和可见性兜底。

**判定 PASS**。与 item 4 的分界：**有限**极值被正确钳位并可见；**NaN/∞** 是唯一穿透的输入（item 4 FAIL）。

## ITEM 18 不支持的游戏结构（非 4/5/6/8/9 人桌 / 翻前节点 / 多人 ≥3）—— **PASS**

**触发**：① `tableSize=7`；② 9 座桌 −UTG（8 人局）；③ 4 人局（CO/BTN/SB/BB）3 家到河牌；
④ 翻前节点（Hero BB 面对 BTN 开池）。

**期望与依据**：`manualInput.ts:465-470`（桌型只能是 6/9）；
`positionConsistency` / `tableTopology` 契约（`occupiedPositions` 表达 8 人局）；
`contextBuilder.ts:1202-1207`（画像似然只在 RIVER+进攻性动作上启用）；
`contextBuilder.ts:1096-1104`（基础行动跳过）。

**原始输出**
```text
F5 7 人桌（tableSize=7）  ok=false stage=PARSE
   [{"code":"INVALID_TABLE_SIZE","message":"桌型只能是 6 人桌或 9 人桌（收到 7）","field":"tableSize"}, …]
F6 8 人局（9 座桌 − UTG）  ok=true act=CALL EQ=0.5761 callEV=13.08 bluffM=0.0500 sup=449 effC=136.0 prov=true ΔEQ=1.350pp
   （与单挑 9-max 的 A7 完全一致：0.5761 / 0.0500 / +1.350pp）
```
```text
> node --experimental-strip-types scripts/v21-fmaudit-seven-handed.ts
9 座 / 7 人局：无画像                          ok=true 动作=CALL 权益=0.562588 callEV=12.4417
9 座 / 7 人局：quickProfile=MANIAC          ok=true 动作=CALL 权益=0.576091 callEV=13.0763
9 座 / 7 人局：quickProfile=CALLING_STATION ok=true 动作=CALL 权益=0.558080 callEV=12.2298
9 座 / 7 人局：tableSize=7（物理容量非法）       ok=false stage=PARSE
   issues=[{"code":"INVALID_TABLE_SIZE","message":"桌型只能是 6 人桌或 9 人桌（收到 7）","field":"tableSize"}, …]
   （MANIAC 0.576091 / 跟注站 0.558080 与 9 人局黄金夹具**逐位相同** ⇒ 7 人局在画像层没有任何特殊退化）
```
```text
F1 翻前：无画像                 ok=true act=CALL EQ=0.6157 callEV=4.47 prov=null
F2 翻前：只注入 MANIAC 画像      ok=true act=CALL EQ=0.6157 callEV=4.47 prov=null
F3 翻前：quickProfile=MANIAC    ok=true act=CALL EQ=0.6157 callEV=4.47 prov=false shape=false ΔEQ=0.000pp
F4 翻前：quickProfile=跟注站     ok=true act=CALL EQ=0.6157 callEV=4.47 prov=false shape=false ΔEQ=0.000pp
F1 vs F2：权益 逐位相等；F1 vs F3：权益差 0.0000pp；F1 vs F4：权益差 0.0000pp

F7 4 人局：BTN 带 MANIAC        EQ=0.3745 callEV=4.10
F8 4 人局：无画像对照            EQ=0.3349 callEV=2.40
F8b 4 人局：BTN + 跟注站         EQ=0.3243 callEV=1.95
F13 4 人局：只注入 MANIAC 画像    EQ=0.3749 callEV=4.12
F7 vs F8（画像 vs 无画像）权益差 = 3.9608pp｜动作 CALL/CALL
F8 vs F8b（跟注站）权益差 = -1.0550pp
```
- **7 人桌**分两种含义，两种都实测了：
  - `tableSize=7`（**物理容量**）：解析层直接阻断（`INVALID_TABLE_SIZE`，并附带 15 条行动记录位置错误
    + 9 条座位筹码键错误 —— 拒绝是硬性的，不会静默按 7 人算）；
  - 9 座桌上的 **7 人局**（`occupiedPositions` 去掉 UTG/UTG1）：**被正确接受**，画像照常生效，
    而且数值与 9 人局**逐位一致**（见下），说明本手人数与容量是分开建模的
    （`manualInput.ts:311-327`），因此 4/5/7/8 人局都能表达；只有容量 ∉ {6,9} 不被支持。
- **8 人局**（9 座 −UTG）：行为与单挑 9-max 逐位一致（0.5761 / 0.0500 / +1.350pp）。
- **翻前节点**：四条路径**逐位相同**（0.6157），且 `provider.applied=false`。
  结构原因比「契约上只对河牌生效」更强：翻前在 Hero 决策之前，对手只可能有一条行动，
  而那条必然是 `firstPreflopActionOf`（基础行动）⇒ 被 `contextBuilder.ts:1096-1104` 跳过
  ⇒ 翻前**不存在**任何画像调整的入口（无论 `quickProfile` 还是 `behaviorProfile`）。
- **多人 ≥3**：画像只作用于被指定的座位（`contextBuilder.ts:3209-3210`、
  `opponent.id === villainId ? (behaviorProfile ?? null) : null`），
  且方向正确（MANIAC > 无画像 > 跟注站）；`behaviorProfile` 单独注入时也只在河牌生效（F13 vs F8）。
  ⚠️ 两个已知缺口**不计入本项 PASS 的反例**，而是计入 item 8/12：
  `villains[1..]` 被丢弃（`manualInput.ts:911`）、画像家非首要时 `profileRangeEvidence` 缺失（J3/C 组）。

**判定 PASS**。

---

# FAIL 汇总（含最小复现、机制、观测 vs 期望）

| # | file:line | 机制 | 观测 vs 期望 |
|---|---|---|---|
| 3 | `src/domain/player/behaviorProfile.ts:742,766,804,821,841`（读取 `t.<trait>.effectiveRate`）；入口无校验 `src/app/manualInput/manualInput.ts:226`、`src/app/manualInput/manualInput.ts:731-751`、`src/app/alphaPipeline.ts:1051-1053`；异常包装 `alphaPipeline.ts:1075-1082` | 注入式画像缺 trait 键 ⇒ 读取 `undefined.effectiveRate` ⇒ TypeError ⇒ 整个 `buildDecisionContext` 抛出 ⇒ `CONTEXT_BUILD_FAILED` | 期望：缺条目回落池先验或给出「画像缺条目 X」的可操作错误。实际：**整手牌无法分析**，`stage=CONTEXT`，文案 `Cannot read properties of undefined (reading 'effectiveRate')`（`traits={}` 与「只有 riverBluff」都触发） |
| 4 | `src/domain/player/behaviorProfile.ts:98-101`（缺 finite 守卫，`clamp01` 只保护 `priorRate`）→ `:592-595`（`rateOdds(NaN)=NaN`）→ `:928-932`（NaN 未被钳位，`clamped=true` 是假信号）→ `src/domain/range/rangeUpdate.ts:79-102`（整条动作模型被拒） | NaN/∞ 穿透画像层，河牌动作的似然为 NaN ⇒ `updateRange` 返回 `RANGE_VALIDATION_FAILED` ⇒ `applyLikelihoodUpdates` `continue`（`contextBuilder.ts:1357-1368`）⇒ **该条动作证据完全不进范围**，仅 `updateTrace.action` 有一行 | 期望：非法数值被拒/被钳，或至少不改变结论。实际：`successes=NaN`（或 `opportunities=NaN`）⇒ 权益 0.5626→**0.6751（+11.25pp）**、callEV 12.44→**17.73**、诈唬质量 0.0184→0.0629；`priorWeight=Infinity` / `opportunities=Infinity` 同样产出 NaN |
| 6 | `src/domain/player/behaviorProfile.ts:53-72`（`StatEvidence` 无时间字段）、`:378-406`（画像无时间字段）；`asOf` 仅 `src/app/manualInput/contextBuilder.ts:3400`→`:2630-2673`（动态层） | 画像层没有「观测发生时间」这一维，任何衰减都无处可挂，`asOf` 改 100 年也不影响 | 期望：陈旧读数被衰减/标注。实际：`asOf=2020` 与 `asOf=2125` **逐位相同**（权益 0.5770/0.5770、诈唬质量 0.0520/0.0520） |
| 7 | `src/domain/player/behaviorProfile.ts:416`（`observed` 只有三个计数，无 hand-id）；`:127`（confidence 随 opportunities 上升） | 数据模型里没有任何手牌身份，重复导入不可检测；重复还会**提高**置信度 | 期望：同一手重复不得增加证据。实际：同一手 ×1/×2/×10/×100 ⇒ 权益 0.5768/0.5773/0.5803/**0.5908**、诈唬质量 0.0515/0.0528/0.0595/**0.0830**（中性 0.0184）、confidence 0.143/0.25/0.625/**0.943** |
| 8 | `src/app/manualInput/manualInput.ts:204`（`playerId?: string` 无校验）、`:731-751`（只校验 `quickProfile`/`dynamicHint`）；`src/app/manualInput/reconstruct.ts:290`（id=`seat_<位置>`）；`src/app/manualInput/contextBuilder.ts:3141-3142,3199-3213`（按 id 注入）；`manualInput.ts:911`（只取 `villainList[0]`） | 画像绑定 = 输入里的自由字符串 vs 内部座位 id；不匹配 ⇒ 该对手拿不到画像（无告警）；画像对象自带的 `playerId` 被忽略 | 期望：写错/写位置名应阻断（项目自己的纪律 `manualInput.ts:794-795`）。实际：`playerId='BB'`/`'nonsense'`/`'BTN'`/`'CO'` 全部 **权益 0.5626 = 无画像基线**（无 warning、无 issue），只有 `'seat_BB'` 生效（0.5761）；`villains[1..]` 静默丢弃 |
| 9 | `src/app/manualInput/reconstruct.ts:290`；`src/app/manualInput/manualInput.ts:295-310`（`seatProfiles` 契约）vs `src/app/manualInput/contextBuilder.ts:3487-3518`（只喂 `betDecision` 维度） | 身份 = 座位（无跨手玩家实体）；座位级画像通道不进范围/似然链；换座后旧 id 静默失配 | 期望：画像跟玩家走，或座位画像通道生效。实际：`seatProfiles={BB:'MANIAC'}` ⇒ 0.5626（= 基线，零影响）；`seatProfiles={BB:'MANIAC'}` + `quickProfile=跟注站` ⇒ 0.5581（只有标签生效）；换座后写旧座位（已弃牌）⇒ 基线 0.5626 |
| 10 | `src/domain/player/behaviorProfile.ts:56-57,88-101,127`（分母由调用方给定，无口径校验） | `opportunities` 被当作「该行为机会数」但没有任何来源/口径约束；`confidence=opp/(opp+priorWeight)` 奖励大分母；`unknownOutcomeOpportunities` 与 `opportunities` 无一致性约束 | 期望：分母口径错误应被拦或至少不提高置信度。实际：12/50 vs 12/1000 ⇒ `effectiveRate 0.244286 vs 0.013598`（几率比 0.8312× vs 0.0354×，差 **23.45×**），管线权益 0.5742→0.5709、诈唬质量 0.0457→0.0384，而 confidence **0.893→0.994**；`unknown=500 / opportunities=1` 被接受 |
| 12 | ① `src/domain/player/tendencyProvider.ts:358-380` + `src/app/manualInput/contextBuilder.ts:1343-1352`（抑制只覆盖**同一条动作**）；② `src/app/decision/postflopAdvisor.ts:468,472,475` + `src/app/manualInput/contextBuilder.ts:3220-3233,3305-3306`（证据对象只来自**首要**对手） | ① 同一个 `quickProfile` 既进形状层（第一次更新，990/990 组合）又进河牌统一似然；② 画像家≠首要对手时 `profileRangeEvidence` 缺失 ⇒ 去重闸门恒 false ⇒ 范围一次 + 决策层一次 | 期望：同一份证据只计一次（T4 在单挑下成立）。实际 ①：只倾斜 −0.0588pp、只似然 +1.4057pp、界面路径 +1.3503pp（同一条用户读两条通道）；实际 ②：4 人局 `BLUFF_HEAVY@seat_BTN`（首要=CO）⇒ 权益已被画像推动 **+3.275pp** 且 `bluffCatchDelta=0.035000 / deDuplicated=false`，而单挑同一画像 `bluffCatchDelta=0.000000 / true`；同时多人池的 `profileClassMasses` 只报首要对手（0.0830 与无画像完全相同） |

**给修复代理的次序建议（只报告，未改动任何代码）**
1. item 4 / 3（NaN 与残缺画像 ⇒ 静默降级或整手失败）—— 影响面最大，
   建议在 `statEvidenceOf` 加 finite 守卫（非法 ⇒ 抛/拒绝），并在入口对 `behaviorProfile` 做形状校验；
2. item 12 ②（多人池去重闸门失效 ⇒ 实测重复计票）；
3. item 8 / 9（画像绑定：自由字符串 vs 内部 id，静默失效；`seatProfiles` 通道不进范围链）；
4. item 6 / 7 / 10（数据模型缺口：无时间、无 hand-id、无分母口径校验）。

---

# 审计边界（诚实声明）

- 未运行 `npm run verify`（按要求），只跑了 4 个画像相关测试文件 + 我自己的探针；
  因此**没有**全仓回归结论。
- 未触碰 `GTOopen/`、`gto-cache`、`gtoApi`、`handEval.ts`、`fastEval.ts`、
  底池赔率 / 所需权益 / SPR / 组合数 / 权益 / EV 公式，以及 `rangeCounter`；
  这些模块的数值被我当作**既有事实**引用（例如 `equitySource` 的 EXACT/MONTE_CARLO 标注）。
- 「已弃牌但底牌已知」在真实输入契约里**不可表达**（`ManualHandInput` 只接受 Hero 底牌），
  item 11 的合成状态是为了探测代码是否会读他人 `holeCards`，它不是生产路径。
- item 6 / 7 / 9 / 10 的 FAIL 属于「失败模式未设防」而非「数值算错」：
  公式本身与既有锁定测试一致，缺的是输入维度与校验；报告已逐条标注口径。
- item 15 的结论只在**同一估计量**内成立：河牌抓诈唬节点是 `EXACT`（噪声 0），
  翻牌下注节点是 `MONTE_CARLO/20000`（噪声 0.56–0.72pp），两者不可互相比较。
