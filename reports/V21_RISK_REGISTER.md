# V2.1 画像审计 · 本地风险登记册与架构债台账

> **本文件是本轮（V2.1 画像敏感度与决策影响审计）的本地风险登记与架构债台账。**
> 仓库原有的墨菲风险册是 `reports/MURPHY_RISK_REGISTER.md`（按「A 输入 / B 数学 / C 范围 /
> D 样本 / E Tilt / F 多人池 / G 结果导向 / H LLM / I 中文 / J 工程 / K 红队」分类）。
> 该册**没有**「画像量化 V2 / V2.1」条目，也没有通用的「架构债」章节 ——
> 因此本轮**新建本文件**作为 V2.1 的登记处，**不向外部平台发帖**。
>
> 每条都带**代码证据**（`file:line`）与**可复现命令**。
> 本轮修改过的源文件版本锚点见 §版本锚点（审查要求：报告必须能被钉到某个 revision）。

---

## 版本锚点（本轮报告所依据的确切文件状态）

| 文件 | 本轮是否修改 | 说明 |
|---|---|---|
| `src/domain/player/behaviorProfile.ts` | **是**（缺陷修复 D-A/D-B/D-C） | 非有限数值守卫、`traits` 缺条目回落、materiality 非有限输入 |
| `src/app/manualInput/manualInput.ts` | **是**（缺陷修复 D-A/D-B） | 注入式画像的信任边界校验 |
| `src/app/manualInput/contextBuilder.ts` | **是**（缺陷修复 D-D 去重闸门） | `profileAppliedToRange` 事实字段 |
| `src/domain/decision/decision.types.ts` | **是**（缺陷修复 D-D） | 新增 `profileAppliedToRange?` |
| `src/app/decision/postflopAdvisor.ts` | **是**（缺陷修复 D-D） | 去重闸门改读事实字段 |
| 其余 `src/**` | 否 | 与 `git status` 一致 |

产物哈希：`npm run manifest` 重新绑定后的 `data/artifact-manifest.json`（154 个产物）。
**未升** `ALPHA_DECISION_MODEL_VERSION`（仍为 `1.0.5`）：本轮改动**不改变任何判定阈值**，
且在合法输入上**逐位不变**（已用 `scripts/v21-defect-evidence.ts` 的前后证据证明）；
按 `artifactDefinitions.ts:314` 的措辞，需要升版本的触发条件是「决策判定阈值发生变化」。

---

## 0. 结论速览

| 编号 | 债务 / 缺陷 | 类型 | 严重度 | 状态 |
|---|---|---|---|---|
| D1 | `rangeDistance` 只在**类别级**度量（5 个互不重叠分量），不能识别同类别内部的组合变化 | 度量口径 | 中 | 确认 + 加注记（不改行为） |
| D2 | `THIN_VALUE` 对**原型标签**零条件化 | 覆盖缺口 | 低-中 | 确认，仍存在 |
| D3 | §三十六 跨街 fallback / §二十四 环境分档 / §二十三 历史库 **未实现** | 未实现功能 | 中 | 确认，仍存在 |
| D4 | 生产链**没有任何入口**能把实测手牌历史喂给画像（`observed` 不可达） | 管线缺口 | **高** | 新发现（本轮） |
| D5 | `archetypePriorAvailable` / `priorNoteZh` **只写不读** | 文档-代码漂移 | 低 | 新发现（本轮） |
| **D6** | **画像去重闸门读的是代理指标**（`provider.applied`），三处会误判为 false ⇒ 同一份证据被计两次 | **正确性缺陷** | **高** | **本轮已修**（前后证据见 §D6） |
| **D7** | **非法数值（NaN/Infinity）穿透到似然** ⇒ 整条贝叶斯更新被静默丢弃、权益反而变高 +11pp | **正确性缺陷** | **高** | **本轮已修**（§D7） |
| **D8** | **残缺画像把整手牌打挂**（`traits` 缺条目 ⇒ `CONTEXT_BUILD_FAILED`） | **正确性缺陷** | **中-高** | **本轮已修**（§D7） |
| **D9** | `manualReadEvidence` 的 `environmentPrior` 参数**被忽略**，`MANUAL_READ_CONFIDENCE_CAP` **无读者** ⇒ 人工读与标签先验之间没有收缩 | 语义缺口 | 中 | 新发现（本轮，未修） |
| **D10** | `profileMaterialityOf` 的 `equityTrivial` / `massTrivial` 是**死参数**（两个分支返回同一个值） | 死代码 | 低 | 新发现（本轮，未修） |
| **D11** | `THIN_VALUE` 的**结构槽位数 K=2 但只有 1 个可填槽** ⇒ 唯一的薄价值通道被永久开平方 | 公式口径 | 低-中 | 新发现（本轮，未修） |
| **D12** | **跛入池上「中性」不中性**：`NORMAL` 与 `UNKNOWN` 权益差 2.695615e-4 | 一致性缺陷 | 中 | 新发现（本轮，未修） |
| **D13** | `villain.playerId` 是**未校验的自由字符串**，与内部 `seat_<位置>` id 不一致时画像**静默失效** | 输入校验 | 中 | 新发现（本轮，未修） |
| **D14** | `callTooWide` 是**死条目**：10 处引用全在定义文件内，无生产读者 | 死代码 | 中 | 新发现（本轮，未修） |
| **D15** | `riverConsistencyV21.test.ts` 全程只用 `quickProfile: 'NORMAL'` ⇒ **它根本不是画像回归锁** | 测试可信度 | 中 | 新发现（本轮，未修） |
| **D16** | `reportVerdictConsistency.test.ts` **不重算** delta，只是硬编码字面量比对 ⇒ 结论真的变了它也不会红 | 测试可信度 | 中 | 新发现（本轮，未修） |
| **D17** | 尺寸档 `BetSizeBucketOf` 的 4 档里**只有 0.6 一个边界是活的**（SMALL≡MEDIUM、LARGE≡OVERBET 逐位相同） | 死档位 | 低-中 | 新发现（本轮，未修） |
| D18 | `rangeCounter`（`src/domain/range/range.ts`）结构性隐患 | 已知 | 中 | **刻意不动**（父代理指令 + 既有回归锁） |

---

## D6 · 画像去重闸门读代理指标（**本轮已修 · 严重度最高**）

### 主张
`postflopAdvisor` 的「防止画像被计两次」闸门原先读
`context.profileRangeEvidence?.provider.applied === true`。
**这个量不等于「画像改了范围」**，三处会把它误判为 false：

| 通道 | `provider.applied` | 范围是否真的变了 | 证据 |
|---|---|---|---|
| 倾向乘法通道 | `true` | 是 | 正常路径 |
| **河牌统一似然通道** | **`false`**（该通道上 provider 被 `suppressProvider` 主动抑制） | **是** | `contextBuilder.ts:1308/1352` |
| **跛入原型通道** | **`false`**（根本不经过 provider） | **是** | `contextBuilder.ts:3314-3318` |
| **画像挂在非首要对手身上** | 证据对象**整个缺失** ⇒ `undefined` | **是** | `contextBuilder.ts` 证据只取 `realizedOpponents[0]` |

### 实测（独立核查 `reports/V21_REVIEW_3_PIPELINE.md`，以及失败模式审计 #12）

```text
A 洞（画像在非首要对手；同一手牌，只改 villain.playerId）
  villain=seat_CO ：profileRangeEvidence 缺失 ⇒ rangeLayerApplied=false
                    doubleCountBlocked=false、bluffCatchDelta=+0.0350、deDuplicated=false
                    权益已被画像推动 +0.3892pp
  villain=seat_UTG：证据在 ⇒ doubleCountBlocked=true、bluffCatchDelta=0.0000、deDuplicated=true

B 洞（跛入池，Hero 翻牌先行动 ⇒ provider 从未被调用）
  MANIAC        ：applied=false，权益 74.3675% → 73.4875%（Δ −0.8800pp），bluffCatchDelta=+0.0350
  CALLING_STATION：applied=false，Δ −0.0400pp，bluffCatchDelta=−0.0070
  NORMAL        ：applied=false，Δ −0.5925pp ⇒ **证伪** contextBuilder.ts:769 的
                  「applied === false 表示范围逐位不变」
  两者都可从交互式牌桌 UI 复现

多人池（4 人，画像家 BTN ≠ 首要 CO）
  权益已被画像推动 +3.275pp，而 profileRangeEvidence 缺失 ⇒ bluffCatchDelta=0.035000、deDuplicated=false
  （单挑对照：0.000000 / true）
```

### 修法（本轮落地）
不再读代理指标，改为**独立的事实字段**：
`contextBuilder` 在 `buildRangeSnapshot` 里数出「统一似然真正被施加的动作数」
（`profileLikelihoodActions`），并连同 provider 与跛入通道一起归约成
`RangeBuild.profileAppliedToRange`；该字段再上传到 `DecisionContext.profileAppliedToRange`；
`postflopAdvisor` 的两处闸门改读它（旧字段保留为兼容回退，历史行为不变）。
同时把证据对象的来源从 `realizedOpponents[0]` 改为**按 `villainId` 定位被画像描述的那一家**。

### 前后证据
见 `reports/evidence/v21-defect-evidence-before.txt` / `-after.txt` 与
`reports/V21_REVIEW_3_PIPELINE.md` 的 A/B 两洞复核。

### 仍然存在的残留（**未修，如实登记**）
- 独立审查未能构造出「重复计票导致**最终动作翻转**」的用例；
  已证明的是**同一份范围证据被消费两次**（权益 + scorer 层）。
- 画像对象自带的 `profile.playerId` **从不与 `villainId` 比对**（见 D13）。

---

## D7/D8 · 非法数值穿透 与 残缺画像打挂（**本轮已修**）

### D7 主张与实测（修前）
`behaviorProfile.ts` 的 `statEvidenceOf` **只对 `priorRate` 做了 `Number.isFinite` 守卫**，
`successes` / `opportunities` / `priorWeight` **没有守卫**。后果链：

```text
observed {successes: NaN, opportunities: 10}
  ⇒ effectiveRate = NaN
  ⇒ rateOdds(NaN) = NaN ⇒ likelihood = NaN（且 clamped=true —— 一个假信号）
  ⇒ rangeUpdate 拒绝整条动作模型（RANGE_VALIDATION_FAILED）
  ⇒ contextBuilder 跳过该动作 ⇒ **该街的贝叶斯更新被静默丢弃**
  ⇒ 失败只写在 updateTrace.action，**不进 warnings**
```

**实测后果（修前，S1 黄金局面）**：

| 输入 | 权益 | 跟注 EV | 与无画像对照 |
|---|---|---|---|
| 对照（无画像） | 56.2588% | 12.442 | — |
| 合法 observed 30/50 | 57.6956% | 13.117 | +1.44pp |
| **`successes: NaN`** | **67.5071%** | **17.728** | **+11.25pp** |
| **`opportunities: NaN`** | **67.5071%** | **17.728** | **+11.25pp** |
| **`opportunities: Infinity`** | 56.9904% | 12.786 | （被读成「他从不诈唬」） |

即：**一个坏数字让结论变得更激进，而界面上看不出任何异常**。

### D8 主张与实测（修前）
`PlayerBehaviorProfile.traits` 类型上是
`Record<BehaviorTraitKey, StatEvidence>`（非可选），但它是**外部可注入的对象**，
运行时可以缺条目；读取点直接取 `traits.<条目>.effectiveRate`。实测：

```text
traits = {}            ⇒ ok=false / stage=CONTEXT /
                          CONTEXT_BUILD_FAILED: Cannot read properties of undefined (reading 'effectiveRate')
traits 只有 riverBluff 一条 ⇒ 同上
```

**整手牌无法分析**，而错误信息对使用者完全不可操作。

### 修法（本轮落地）
1. **信任边界阻断**（`manualInput.ts`）：对 `villain.behaviorProfile.traits` 逐条校验
   —— `successes` / `opportunities` / `unknownOutcomeOpportunities` 必须是**有限非负整数**、
   `successes ≤ opportunities`、`effectiveRate` 必须是 `[0,1]` 的有限数。
   按项目纪律（第 16 节）**阻断而不是静默夹取**。
2. **读取端回落**（`behaviorProfile.ts`）：新增 `poolRateOf(key)` ——
   单条目缺失或非有限 ⇒ **回落池先验**（语义上「这一条没有证据」是合法状态，
   与 `behaviorProfileOf` 对无先验标签的处理一致）。五个读取点全部走它。

### 前后证据
`reports/evidence/v21-defect-evidence-before.txt`（修前）与
`reports/evidence/v21-defect-evidence-after.txt`（修后）：

```text
修前 A1 successes=NaN        ⇒ 权益 67.5071%（+11.25pp），无 warning
修后 A1 successes=NaN        ⇒ PARSE 阶段 INVALID_NUMBER 阻断，字段路径精确到
                               villain.behaviorProfile.traits.riverBluff.successes
修前 B1 traits={}            ⇒ CONTEXT_BUILD_FAILED，整手牌不可分析
修后 B1 traits={}            ⇒ 权益 56.2000%（回落池先验，可分析）
修前 B2 traits 只有一条       ⇒ CONTEXT_BUILD_FAILED
修后 B2 traits 只有一条       ⇒ 权益 56.3031%（缺失条目回落池先验）
```

### 仍存在的残留（**如实登记**）
- `statEvidenceOf` **本身**仍会为非法输入返回 `effectiveRate = NaN` / `confidence = NaN`；
  现在由上游阻断 + 读取端回落**掩盖**，而不是在源头修好
  （独立审查 `reports/V21_REVIEW_5_COUNTEREVIDENCE.md` 明确指出这一点）。
  这是一个**域层内部的纯函数**，它的调用者可能不止 `behaviorProfileOf`；未扩大修改面。
- `successes: -5` 仍被 `statEvidenceOf` 静默夹到 0（**未**在信任边界被阻断，
  因为它经 `Math.max(0, …)` 后语义正确）—— 修后实测与「0 次」同值。

---

## D9 · 人工读与标签先验之间没有收缩

`manualReadEvidence({ tendency, environmentPrior })` 接一个 `environmentPrior` 参数，
**但函数体不使用它**：`manualReadEvidence` 的返回值只由 `tendency` 决定
（实测 `effectiveRate` = 0.05/0.20/0.45/0.65/0.80），随后以 `priorWeight = 3` 的
**伪计数**进入 `statEvidenceOf`。
`behaviorProfile.ts:441` 的注释写「人工画像作为伪计数先验**叠加在标签先验之上**」——
实测**不成立**：标签先验（例如 `CALLING_STATION.riverBluff = 0.15`）被**完全丢弃**。
`MANUAL_READ_CONFIDENCE_CAP = 0.35` 在 `src/` 中**没有任何读者**。

**后果**：用户在界面上手选「跟注站」+ 人工读「他很爱诈唬」时，
拿到的不是两者的加权，而是后者**单独**决定该条目。

---

## D10 · `equityTrivial` / `massTrivial` 是死参数

`profileMaterialityOf` 的分支 A（`|Δeq| < equityTrivial ∧ |Δmass| < massTrivial ⇒ TRIVIAL`）
与分支 D（兜底 `⇒ TRIVIAL`）**返回同一个常量**。
独立审查在 **34,191 点网格**上把 `equityTrivial → 0.0199999`、`massTrivial → 0.0499999`，
判定**零次变化** ⇒ 这两个阈值**控制不了任何东西**。
只有 `equityMaterial = 0.02` 与 `massMaterial = 0.05` 是真阈值。

---

## D11 · `THIN_VALUE` 的结构槽位数 K=2 但只有 1 个可填槽

独立审查实测：`THIN_VALUE` 的指数**恰好是 1/2.0000**，
而该类别**只有一个**可填槽（`thinValueBet`）⇒ 它唯一的画像通道被**永久开平方**：
`VERY_HIGH` 的 cond = 7.428571，实际只交付 `×2.725541`。
若 K 的语义是「结构槽位数」，那么薄价值端的槽位数应为 1。
**未修**（会改变所有 `THIN_VALUE` 数值，需要独立回归轮）。

---

## D12 · 跛入池上「中性」不中性

本轮 S7 夹具（6-max，Hero BB `9h9c`，牌面 `Qs 8d 3c 6s Ks`）实测：

```text
UNKNOWN = 0.07845850542399040
NORMAL  = 0.07872806694852144     Δ = 2.695615e-4
```

机制：`quickProfileToLimperArchetype('NORMAL')` 给出**带 0.35 可信度**的原型，
而 `UNKNOWN` 的可信度为 0 ⇒ `limpIsolation.effectiveTraits` 的混合方式不同。
**加注池（SRP）对照 Δ = 0**，因此这是**跛入池专有**的不一致。
后果：`CURRENT_PROJECT_STATUS.md` 与各报告里「UNKNOWN == NORMAL」的说法
**必须限定在加注池**。

---

## D13 · `villain.playerId` 未校验

`ManualVillain.playerId` 是**自由字符串**（`manualInput.ts:203-204`），
而实际座位 id 是**派生**的 `seat_<位置>`（`reconstruct.ts:290`）。
实测：

```text
playerId = 'seat_BB'  ⇒ 画像生效（权益 0.5761）
playerId = 'BB' / 'BTN' / 'CO' / 'nonsense' ⇒ **静默等于无画像**（0.5626），无 warning、无 issue
画像对象自带的 profile.playerId = 'seat_BTN' 但输入字段不写 ⇒ 完全不生效（0.3329 = 无画像基线）
```

按项目自己的纪律（`manualInput.ts:794-795`：写错应阻断），这里应当阻断而不是静默失效。

---

## D14 · `callTooWide` 是死条目

`BehaviorTraitKey.CALL_TOO_WIDE` 在 `src/` 中有 10 处引用，**全部在 `behaviorProfile.ts` 内部**
（枚举、中文标签、5 个原型先验、注释）。**没有任何生产读者**。
行为证据：`manual: { callTooWide: 'VERY_LOW' }` 与 `'VERY_HIGH'` 产出**逐位相同**的
8 类似然（`0.95000000 0.45706896 0.21939310 0.12797931 0.02139875 ×3 0.02371616`）。

后果：`CALLING_STATION` 这个标签的**定义性**条目（跟注过宽）在决策上**完全无效**，
只有它「诈唬更少」的那一半是活的 —— 而 `CALLING_STATION` 与 `UNDERBLUFFER`
在 S1 上的权益只差 **0.0935pp**。

---

## D15 / D16 · 两条「回归锁」其实锁不住画像

| 测试文件 | 实测结论 |
|---|---|
| `test/riverConsistencyV21.test.ts` | 全程只用 `quickProfile: 'NORMAL'`（`:83` / `:526`），而 `NORMAL` 是**声明中性**的原型 ⇒ 整个文件 `cond ≡ 1` ⇒ **它不是画像回归锁**，把它算进「画像回归覆盖」会虚增覆盖度 |
| `test/reportVerdictConsistency.test.ts` | `verdictOf(0.018, 0.0422)` 直接**硬编码**报告里的同一组数字；若真实 delta 从 0.01801 变成 0.02100（真正跨到 MATERIAL），报告仍会写 TRIVIAL 而测试仍会通过 |
| `test/profileV2Metrics.test.ts` | 6 条全部是中性画像或大常数钳位 ⇒ 变异 `cond ≡ 1` 下**全部通过** |

**能抓到** `cond ≡ 1` 的三条：`profileQuantificationGolden.test.ts`、
`profileQuantification.test.ts`、`profileRangeAdjustment.test.ts`。

---

## D17 · 尺寸档 4 档里只有 1 个活边界

`BetSizeBucketOf` 的阈值 0.4 / 0.6 / 1.25 **已逐字确认**，
但实测 SMALL 与 MEDIUM **逐位相同**、LARGE 与 OVERBET **逐位相同**：
0.368421 / 0.526316 / 0.578947 三种比例给出**完全相同**的结果。
只有跨过 **0.6** 才有变化（MANIAC 权益 +0.642412pp、诈唬质量 ×1.404）。
即：一个 4 值枚举实际只有 **2 个状态**，另外两个阈值是死代码。

---

## D18 · `rangeCounter`

`src/domain/range/range.ts` 的 `rangeCounter` 是已知结构性隐患（模块级可变计数器）。
独立核查实测：`rangeId` **从不出现在决策输出里**（全仓 0 次命中），
且同一进程内交替分析不同画像时完整 `diagnostics` **逐字节相同**（6 画像 × 3 种顺序，0 处不一致）。
因此本轮**确认它不影响画像路径**，并**明确不触碰**（父代理指令 + 既有回归锁）。

---

## 附：可复现命令

```text
node --experimental-strip-types scripts/v21-defect-evidence.ts before   # 修前证据
node --experimental-strip-types scripts/v21-defect-evidence.ts after    # 修后证据
node --experimental-strip-types scripts/v21-profile-sensitivity-audit.ts  # 1260 组合矩阵 + 8 场景语料
node --experimental-strip-types scripts/v21-decision-impact.ts          # 12 项决策影响指标
node --experimental-strip-types scripts/v21-summarize.ts                # 聚合（写入 reports/evidence/v21-summary.md）
node --experimental-strip-types scripts/v21-chain-distance-probe.ts     # 类别级 vs 组合级距离
npm run manifest                                                        # 重绑 154 个产物哈希
npm run verify                                                          # 全门
```
