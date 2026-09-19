# V21 生产链路验证报告 —— 画像 → 决策，以及 `rangeDistance` 的真实含义

> 独立验证（adversarial）。所有结论都带 `file:line` 与**可复现的实测输出**。
> 未修改 `src/` 与 `test/`；新增文件仅 `scripts/v21-chain-profile-probe.ts`、
> `scripts/v21-chain-distance-probe.ts` 与 `reports/` 下的原始输出。
>
> | 产物 | 路径 |
> |---|---|
> | 本报告 | `reports/V21_PRODUCTION_CHAIN_VERIFICATION.md` |
> | Part A 探针 | `scripts/v21-chain-profile-probe.ts` |
> | Part B 探针 | `scripts/v21-chain-distance-probe.ts` |
> | Part A 原始输出 | `reports/V21_CHAIN_PROFILE_PROBE_OUTPUT.txt` |
> | Part B 原始输出 | `reports/V21_CHAIN_DISTANCE_PROBE_OUTPUT.txt` |
> | 黄金测试原始输出 | `reports/V21_CHAIN_GOLDEN_TEST_OUTPUT.txt` |
>
> 复现命令：
>
> ```text
> node --experimental-strip-types scripts/v21-chain-profile-probe.ts
> node --experimental-strip-types scripts/v21-chain-distance-probe.ts
> node --test --experimental-strip-types test/profileV2Metrics.test.ts
> node --test --experimental-strip-types test/profileQuantificationGolden.test.ts
> ```
>
> 测试基线（本报告写作时实测）：`profileV2Metrics.test.ts` 6/6 通过、
> `profileQuantificationGolden.test.ts` 5/5 通过（原始输出见上表）。

## TL;DR（六条最重要的结论）

1. **画像进入范围有三条生产通道**：①`quickProfile` 在 `contextBuilder` 内派生
   `behaviorProfileOf(...)`（`contextBuilder.ts:3168-3175`）→ 河牌进攻动作的统一似然
   （`contextBuilder.ts:1202-1307`）；②维度 provider 的乘数通道
   （`contextBuilder.ts:1352` → `rangeUpdate.ts:407/447`）；③跛入原型通道
   （`quickProfileToLimperArchetype`，`contextBuilder.ts:3181-3187` → `buildBaseRange`，
   代码在 `:3320-3326` 明说这是「画像有**两条**进范围的路径」中的第二条）。
   **`villainProfile`（实测画像）没有任何生产调用者。**
2. `quickProfile: 'UNKNOWN'` 与「完全不给画像」**逐位相同**（range/math/facts/decision
   digest 全等），且 `context.profileRangeEvidence` **字段根本不存在**；
   `quickProfile: 'NORMAL'` **构造了**画像（`profileRangeEvidence` 存在、
   `dimensionTier=USER_ARCHETYPE`）但结果**逐位相同**（`provider.applied=false`）。
   实测 digest 见 §A.2。
3. 防重复计费的闸门只有一条判据：`context.profileRangeEvidence?.provider.applied === true`
   （`postflopAdvisor.ts:383` 与 `:468`）。它读的是**倾斜 provider**（旧通道）的证词，
   **不是** V2 统一似然通道的证词 ⇒ **不是构造上严密的**。已实测到一条
   「画像改了范围、证据却缺席」的真实路径（§A.4）。
4. `profileRangeDistance` 在**生产代码里零调用**：全仓仅 7 处调用表达式，
   全在 2 个测试文件里（§B.1）；`medianRangeDistance` **在代码里不存在**，
   只出现在 V2 报告的一行（§B.2）。
5. §二十三 实际喂进去的是 **5 个类别质量**（坚果+强价值 / 薄价值 / 摊牌 / 错过听牌 / 纯空气），
   构造点在 `test/profileQuantificationGolden.test.ts:287-293`。探针实测：在**同一个类别内部**
   把质量从 `3c2d` 挪到 `3c2h` / `3c2s`（`SHOWDOWN_VALUE`，同理反向操作 `MISSED_STRAIGHT_DRAW`）
   ⇒ 类别级 `TV = 0`（精确）、`JS = 0`，
   而**逐组合** `TV = 0.5`、`JS = 0.2200241522709298`（§B.4）。
6. **逐组合后验在生产输出里拿不到**：`RangeSnapshot`（`decision.types.ts:514-554`）
   没有 `entries`，`Range.entries` 只活在 `contextBuilder` 内部；
   公开面只有类别质量、分位数与标量（§B.5）。

---

# Part A —— 画像 → 决策的生产链路

## A.0 方法与夹具

夹具与 `test/profileQuantificationGolden.test.ts` 的 §十七 黄金手**逐字一致**
（9-max、Hero CO `A♣J♥`、牌面 `A♦8♠4♠2♣K♦`、BB 河牌下注 75% 池），
只改画像参数。探针只用生产函数（`parseManualInput` → `buildAnalyzableState` →
`buildDecisionContext` → `analyzeManualHand` / `advisePostflop`），
比较用「canonical JSON 的 sha256（前 16 hex）」。

> ⚠️ 一处必要的手工复刻：`analyzeManualHand` **不返回** `context`
> （`alphaPipeline.ts:1161-1170` 只返回 decision/viewModel/log/timings/warnings/…），
> 因此要看范围层数字，探针按 `alphaPipeline.ts:1029-1073` 逐字重建了
> `ContextBuildInput`（同一个 `gate.state`、同样五个可选画像字段）。
> 这不是新增输入，只是把管线内部的拼装照抄一遍以便读数。

## A.1 外部入口：哪些画像字段真的会被读

| # | 入口 | 位置 | 实际读取的画像字段 | 值的来源 |
|---|---|---|---|---|
| 1 | `analyzeManualHand` | `src/app/alphaPipeline.ts:933` | `parsed.value.villain.quickProfile` → `contextInput.quickProfile`（`:1034-1036`）；`villain.dynamicHint`（`:1037-1039`）；`villain.playerId`（`:1040-1042`）；`villain.behaviorProfile`（`:1051-1053`）；`seatProfiles`（`:1054-1056`） | `parseManualInput` 的 `villain: villainList[0] ?? {}`（`manualInput.ts:911`）——**只取第一个对手**；`villains[]` 若存在则 `input.villain` 被完全忽略（`manualInput.ts:710`） |
| 2 | `buildDecisionContext` | `src/app/manualInput/contextBuilder.ts:3067`；入参类型 `:235` | `input.quickProfile`（`:244` 声明 → `:3170-3174` 派生画像、`:3181` 跛入原型、`:3192` 玩家快照）；`input.dynamicHint`（`:260` → `:3193`、`:3400`）；`input.behaviorProfile`（`:287` → `:3169`、`:3210`）；`input.villainProfile`（`:269` → `:3191`）；`input.seatProfiles`（`:251` → `:3493` 多人响应维度） | 由入口 1 或调用方显式给出 |
| 3 | HTTP `POST /api/analyze` | `src/app/webServer.ts:679`（路由）、`:814`（调 `analyzeManualHand`） | **不读任何画像字段**——原样透传 `{input}`；`{table}` 走 `parseTableState` + `tableStateToManualHandInput`（`:712-732`） | 客户端 JSON |
| 4 | 交互式牌桌 API | `src/app/table/tableApi.ts:213-224`（校验 `playersById[*].quickProfile` / `dynamicHint` 合法）、`:829-830`（meta 里列出可选画像） | 校验 + 展示；写操作在 `tableOps.ts:387-389` → `seatLifecycle.ts:688-720`（`setProfile` / `setDynamicHint`） | 牌桌状态 `playersById[p].quickProfile` |
| 5 | Web UI | `src/app/web/table.js:847-848`（座位标签）、`:1635-1652`（发 `SET_PROFILE` / `SET_DYNAMIC_HINT`）；`tablePreview.ts:156-157` 提供 `quickProfileZh` / `dynamicHintZh` | 只读写 `quickProfile` / `dynamicHint`；**没有** `behaviorProfile` / `villainProfile` / `seatProfiles` 的入口 | 用户点击 |
| 6 | ViewModel | `src/viewmodels/decisionViewModel.ts:109` + `:621-669`（`debug.profileRange`）、`:610-612`（player）、`:729`（`betDecision.profileEvidence`） | 读 `decision.diagnostics.profileRange`（= `context.profileRangeEvidence`）、`context.player`、`betDecision.profileEvidence` | `decisionEngine.ts:2767` / `:974` |
| 7 | 牌桌 → 决策的画像传递 | `src/app/table/tableAdapter.ts:202-240` | `villain.quickProfile`、`villain.dynamicHint`（`:236-237`），**只传首要对手**（`:215-226` 的红队注释说明为何不传 `villains[]`） | `primaryOpponentPosition` 座位上的 `playersById` |

### A.1.1 三个「看起来能带画像、实际带不动」的字段（对抗性发现）

* **`villainProfile`（实测画像）是死字段。** 全仓 grep `villainProfile` 只命中
  `contextBuilder.ts:269`（声明）与 `:3191`（读取）——**没有任何调用方赋值**，
  连测试与脚本都没有。因此「实测标签优先」的那条链
  （`readPlayer` → `handsObserved > 0`）在生产里永不触发；
  `PlayerSnapshot` 永远由 `quickProfile` / `behaviorProfile` / 动态提示 / 空 构造。
* **`seatProfiles`（逐座位画像）在牌桌路径上到不了决策。**
  `tableStateToManualHandInput`（`tableAdapter.ts:242-257`）**不产出** `seatProfiles`，
  于是 UI 上给「非首要对手」设的 `quickProfile`（`SET_PROFILE` 对任意座位都可用，
  `tableApi.ts:829-830` 也把它列为 meta）**只影响座位标签显示**
  （`tablePreview.ts:156-157` → `table.js:847`），不影响范围/权益/决策。
  该字段只有 `{input:{seatProfiles:…}}` 这条 API 路径能带进来
  （`contextBuilder.ts:3493` 用它做多路响应维度）。这**不是**编造数据，
  而是「界面能设、决策不听」的可见性缺口。
* **Web UI 不渲染 `profileRangeEvidence`。** `webServer.ts:836-838` 把
  `viewModel` 整个回传（含 `debug.profileRange`），但 `table.js:1500-1523` 的调试面板
  只输出 `stage / decision / rangeProvenance / reasonsZh / warningsZh / issues /
  timings / warnings` —— **没有 `viewModel.debug`**。所以 §A.5 里那张
  「画像 → 范围」的证据表目前只存在于 API 响应体与 viewmodel 对象里，
  在页面上一个字都看不到（`table.js:1510` 的注释只提到 `viewModel.debug.range`，
  而实际代码并未把它写进调试面板）。

## A.2 画像在哪里被构造

`behaviorProfileOf` 的**全部**调用点（生产 vs 非生产）：

| 位置 | 性质 | 说明 |
|---|---|---|
| `src/app/manualInput/contextBuilder.ts:3171` | **生产** | 由 `quickProfile` 派生（`archetype: input.quickProfile`） |
| `src/app/manualInput/contextBuilder.ts:1205` | **生产** | 河牌进攻动作没有画像时用**中性画像**（`archetype: null`）回落到统一似然 |
| `test/profileQuantification.test.ts:38,39,114,250` | 测试 | — |
| `test/profileV2Metrics.test.ts:74,218,219` | 测试 | — |
| `test/profileQuantificationGolden.test.ts:421,425,432,444` | 测试 | — |
| `scripts/v2-unified-likelihood-probe.ts:24-26`、`scripts/v21-fmaudit-model.ts`、`scripts/v21-fmaudit-pipeline.ts`、`scripts/v21-profile-sensitivity-audit.ts` | 脚本 | 探针/审计 |

派生点原文（`contextBuilder.ts:3160-3175`）：

```ts
  /*
   * ## ⚠️ UNKNOWN 必须排除
   * ...
   */
  const behaviorProfile: PlayerBehaviorProfile | undefined =
    input.behaviorProfile ??
    (input.quickProfile !== undefined && input.quickProfile !== 'UNKNOWN'
      ? behaviorProfileOf({
          playerId: villainId,
          archetype: input.quickProfile as QuickProfile,
        })
      : undefined);
```

### A.2.1 执行验证：`UNKNOWN` 无注入 / `NORMAL` 构造但逐位相同

探针实测（`reports/V21_CHAIN_PROFILE_PROBE_OUTPUT.txt` 第 4-58 行）：

```text
================ A0 完全不给画像 （1161 ms） ================
profileRangeEvidence：字段**不存在**（没有任何画像/倾向证据）
范围：supportSize=449  entropyBits=7.355069734  effectiveComboCount=127.243371  topProbability=0.012294789
digests：range=37da1689d1b3be7c math=e3dd978b1a708175 facts=aba31333300cd4e3 player=654deba6671c281a decision=70855d66940f5199

================ A1 quickProfile=UNKNOWN （757 ms） ================
player.quickProfile=UNKNOWN  confidence=0.5  neutralized=true
profileRangeEvidence：字段**不存在**（没有任何画像/倾向证据）
范围：supportSize=449  entropyBits=7.355069734  effectiveComboCount=127.243371  topProbability=0.012294789
digests：range=37da1689d1b3be7c math=e3dd978b1a708175 facts=aba31333300cd4e3 player=89fcdddc26ab4fb8 decision=70855d66940f5199

================ A2 quickProfile=NORMAL （917 ms） ================
player.quickProfile=NORMAL  confidence=0.35  neutralized=false
profileRangeEvidence：存在；applied=false；tier=USER_ARCHETYPE
  provider.finalMultiplier.calls=2970  profile effective/calls=0/2970  observation.calls=0
  equityBefore=0.5625883726719894 → equityAfter=0.5625883726719894（Δ=0.0000pp）  combos 449 → 449
digests：range=37da1689d1b3be7c math=e3dd978b1a708175 facts=aba31333300cd4e3 player=6468404fc2bcba63 decision=70855d66940f5199
```

逐位比较（同一原始输出，§1）：

```text
--- A1(UNKNOWN) vs A0(完全不给) ---
  rangeDigest     37da1689d1b3be7c == 37da1689d1b3be7c
  mathDigest      e3dd978b1a708175 == e3dd978b1a708175
  factsDigest     aba31333300cd4e3 == aba31333300cd4e3
  playerDigest    89fcdddc26ab4fb8 != 654deba6671c281a
  decisionDigest  70855d66940f5199 == 70855d66940f5199
  **范围链路**（range.metrics + updateTrace + opponentRangeFacts）差异：0 条（逐位相同）

--- A2(NORMAL) vs A1(UNKNOWN) ---
  rangeDigest     37da1689d1b3be7c == 37da1689d1b3be7c
  mathDigest      e3dd978b1a708175 == e3dd978b1a708175
  factsDigest     aba31333300cd4e3 == aba31333300cd4e3
  decisionDigest  70855d66940f5199 == 70855d66940f5199
  完整 context 的差异路径（13 条，节选）：
    player.adjustment.confidence: 0.35 !== 0.5
    player.neutralized: false !== true
    player.quickProfile: NORMAL !== UNKNOWN
    postflopFacts.betDecision.tendencies.confidence: 0.35 !== 0
    profileRangeEvidence: {…} !== __UNDEFINED__
  **范围链路**（range.metrics + updateTrace + opponentRangeFacts）差异：0 条（逐位相同）
```

**结论（精确表述）**：

* `'UNKNOWN'` 与「不给」的差别**只在展示层**：`player.quickProfile`
  由 `null` 变成 `'UNKNOWN'`（`contextBuilder.ts:2580-2581`），
  `confidence` 都是 `NO_DATA_NEUTRAL = 0.5`、`neutralized = true`；
  **`profileRangeEvidence` 两者都不存在**（`contextBuilder.ts:3305-3307`：
  `rangeBuild.tendency === null` ⇒ 直接 return null，`:3620` 的条件展开不写该键）。
* `'NORMAL'` **确实构造了**画像：`profileRangeEvidence` 存在、
  `dimensionTier = USER_ARCHETYPE`（`archetypeDimensions.ts:166-184` 的证据层级），
  且 provider 确实被回调（`finalMultiplier.calls = 2970`，
  即 `TendencyEvidence.finalMultiplier.calls`）；但因为 `NORMAL` 的四维全是 0.5
  （`archetypeDimensions.ts:96-102`），
  `rawComboWeightFactor` / `rawActionLikelihoodFactor` 的因子**恒为 1**
  ⇒ `profile.applied = false`（`tendencyProvider.ts:276-281`）⇒ 范围/权益/动作
  **逐位相同**。这与代码注释 `archetypeDimensions.ts:94-95`
  「中性：全部 0.5，因此因子恒为 1 —— 这是『NORMAL = 不调整』的落地」**一致**。
* ⚠️ 一处**注释与行为不符**：`contextBuilder.ts:1196-1197` 声称「没有画像（UNKNOWN）
  ⇒ 用中性画像，结果与既有档位似然逐位一致」——数值上成立，但**河牌 trace 的
  中文日志对 UNKNOWN 也会写「统一动作似然 V2（…同一条动作上抑制 adjustmentProvider）」**
  （A0/A1/A2 三个案例的 `noteZh` 逐字相同，见原始输出中各自的「河牌 trace noteZh」行）。
  也就是说：一个**没有任何画像**的牌局，河牌日志会宣称它走了画像似然路径。

## A.3 画像在哪里改变数字（完整调用图）

```text
外部入口（A.1）
  └─ analyzeManualHand                         alphaPipeline.ts:933
       ├─ parseManualInput                     manualInput.ts:911（villain = villainList[0]）
       └─ buildDecisionContext                 contextBuilder.ts:3067（输入拼装 :1029-1073）
            ├─ 画像构造                        contextBuilder.ts:3168-3175
            │    └─ behaviorProfileOf          behaviorProfile.ts:409
            ├─ 玩家快照（维度 + provider）      contextBuilder.ts:3188-3196
            │    ├─ resolveTendencyDimensions  archetypeDimensions.ts:264-268
            │    └─ createTendencyProvider     tendencyProvider.ts:244
            ├─ 范围（**画像在这里改数**）        contextBuilder.ts:3199-3213
            │    └─ buildRangeSnapshot         contextBuilder.ts:1388
            │         └─ applyLikelihoodUpdates  contextBuilder.ts:1039
            │              ├─ 河牌 + 进攻闸门     contextBuilder.ts:1202
            │              │    ├─ 中性回落        contextBuilder.ts:1204-1205
            │              │    ├─ behaviorNodeOf  （牌面纹理/尺寸档/前序线）
            │              │    ├─ riverComboClassOf  riverProfileClassify.ts:228-282
            │              │    └─ estimateUnifiedActionLikelihood  behaviorProfile.ts:650
            │              ├─ likelihoodOverride   contextBuilder.ts:1291
            │              ├─ 逐 entry 索引映射      contextBuilder.ts:1310-1324
            │              │    （`likelihoods[entryIndex] = likelihoodOverride[entryIndex]`）
            │              └─ updateRange          rangeUpdate.ts:407/447（provider 回调）
            │                   └─ adjustmentProvider 条件注入  contextBuilder.ts:1352
            ├─ 权益                            contextBuilder.ts:3236-3243 → computeHeroEquity
            ├─ 画像范围级证据（前后对比）        contextBuilder.ts:3305-3379
            └─ 翻后事实（类别质量）              contextBuilder.ts:3469-3473
                 └─ opponentRangeFactsOf        rangeFacts.ts:84
                      ├─ riverActionMassesOf     rangeFacts.ts:183
                      └─ profileClassMasses      rangeFacts.ts:203-267
                           └─ riverComboClassOf  riverProfileClassify.ts:232
  └─ decideAlpha → advisePostflop              decisionEngine.ts:2374-2379 → postflopAdvisor.ts:259
       ├─ exploitSourceOf（读 quickProfile）    postflopAdvisor.ts:216
       ├─ 压缩乘数（闸门 ①）                    postflopAdvisor.ts:383-411
       └─ 抓诈唬偏移（闸门 ②）                  postflopAdvisor.ts:468-476
```

### A.3.1 实测：画像确实改变数字（A1 → A3，只改 `quickProfile`）

```text
================ A3 quickProfile=MANIAC （1239 ms） ================
profileRangeEvidence：存在；applied=true；tier=USER_ARCHETYPE
  provider.finalMultiplier.calls=2970  profile effective/calls=2970/2970  observation.calls=0
  equityBefore=0.5625883726719894 → equityAfter=0.5760913804269139（Δ=1.3503pp）  combos 449 → 449
范围：supportSize=449  entropyBits=7.517204332  effectiveComboCount=136.024612  topProbability=0.012121908
profileClassMasses：bluff=0.050014166 missedDraw=0.034028869 pureAir=0.015985297 value=0.393993576 effectiveCombos=136.024612 mass90=152
决策：equity=57.6091%  callEV=13.076295  action=CALL
```

| 量 | A1 `UNKNOWN` | A3 `MANIAC` | 去向 |
|---|---|---|---|
| 支持集 `supportSize` | 449 | 449（**不变**） | 画像只改概率、不增删组合（`contextBuilder.ts:1308-1324` 只写 `likelihood`） |
| 熵 `range.metrics.entropyBits` | 7.355069734 | 7.517204332 | `range.ts:343-365` |
| 有效组合数 | 127.243371 | 136.024612 | `range.ts:357` |
| 诈唬质量 `profileClassMasses.bluffMass` | 0.018421440 | 0.050014166 | `rangeFacts.ts:240-256` |
| 权益 | 56.2588% | 57.6091% | `computeHeroEquity`（`contextBuilder.ts:3236`） |
| `callEV` | 12.441654 | 13.076295 | `decisionEngine` / `math` |
| 动作 | CALL | CALL | 动作未变（§四十七 允许） |

### A.3.2 供应商抑制（`suppressProvider`）的真实条件

```ts
// contextBuilder.ts:1308
const suppressProvider = likelihoodOverride !== null;
// contextBuilder.ts:1352
...(provider !== undefined && !suppressProvider ? { adjustmentProvider: provider } : {}),
```

* 抑制的是**倾斜 provider**（`TendencyProvider`：画像维度乘数 + 近期倾向乘数）。
  抑制是**硬抑制**：`rangeUpdate.ts:342` 取 `options.adjustmentProvider`，
  `:407/:447` 只有 provider 存在时才回调 —— 被抑制时 provider **一次都不会被调用**，
  而不是「调用但返回 1」。
* ⚠️ **`likelihoodOverride !== null` 在「没有任何画像」时也为真**：
  `contextBuilder.ts:1202` 的条件只看 `street === RIVER && isAggressive`，
  拿不到画像时用**中性画像**（`:1204-1205`）。于是 `quickProfile=UNKNOWN`
  或完全没有画像时，河牌进攻动作上的 `adjustmentProvider` 同样被抑制。
* 实测后果（探针 A5/A6）：`dynamicHint='AGGRESSION_UP'`（近期倾向 =
  `OBSERVATION_TILTS.AGGRESSION_UP`，`tendencyProvider.ts:126`）在黄金手上
  **对范围零影响**：

  ```text
  ================ A5 不给画像 + dynamicHint=AGGRESSION_UP （752 ms） ================
  profileRangeEvidence：存在；applied=false；tier=PRIOR
    provider.finalMultiplier.calls=2970  profile effective/calls=0/2970  observation.calls=0
  --- A5(不给画像+AGGRESSION_UP) vs A0 ---
    rangeDigest     37da1689d1b3be7c == 37da1689d1b3be7c
    mathDigest      e3dd978b1a708175 == e3dd978b1a708175
    **范围链路**差异：0 条（逐位相同）
  动态层：applied=false state=AGGRESSION_UP adapted=3
  ```

  `observation.calls = 0` 说明**观测乘数一次都没施加**（`tendencyProvider.ts:405-417`
  只在 `isAggressive` 时 push，而唯一进攻动作被抑制）。动态提示仍然通过
  `dynamic.adapted`（`contextBuilder.ts:3400` → `adaptAdjustments`）影响决策末端，
  但**范围通道在河牌进攻动作上被顺带关掉了**。
  这与 `tendencyProvider.ts:22-24` 的表述
  「修复前 `AGGRESSION_UP` 在实测中**逐位不产生任何变化**（陈旧性缺陷）」
  形成张力：该缺陷在**非河牌动作**上修好了，在**河牌进攻动作**上又回来了。

### A.3.3 注释引用了**已被删除**的函数

`contextBuilder.ts:1062` 写着
``likelihood = normalizeLikelihood(betLikelihoodOf(comboClass, node, profile))``，
`:1157` 写「`betLikelihoodOf` 从构造上消除了它」，`:1226` 写
「修复前这里用 `normalizeLikelihood(betLikelihoodOf(...))` 替换了档位似然」。
但 `betLikelihoodOf` **在当前代码里不存在**：全仓 grep 只命中注释与文档字符串
（`behaviorProfile.ts:964` 明说「已随 `betLikelihoodOf` 一并删除」、
`:1015` 写「这里原先是 `betLikelihoodOf(...)`」）。
现在的实现是 `estimateUnifiedActionLikelihood`（`behaviorProfile.ts:650`），
调用点 `contextBuilder.ts:1280-1290`。**这些注释描述的是一个不存在的函数。**

## A.4 画像的「第二次计费」：去重规则与它是否严密

### A.4.1 规则的原文与判据

```ts
// postflopAdvisor.ts:383-391
const rangeLayerApplied = context.profileRangeEvidence?.provider.applied === true;
const scorerProfileConfidence = rangeLayerApplied ? 0 : exploitSource.confidenceScale;
const scorerLayerApplied = scorerProfileConfidence > 0;
const doubleCountBlocked = rangeLayerApplied && exploitSource.confidenceScale > 0 && !scorerLayerApplied;

// postflopAdvisor.ts:468-476
const rangeProfileApplied = context.profileRangeEvidence?.provider.applied === true;
const scaledExploit: ExploitAdjustment = {
  ...exploit,
  thinValueDelta: exploit.thinValueDelta * scale,
  bluffCatchDelta: rangeProfileApplied ? 0 : exploit.bluffCatchDelta * scale,
  bluffDelta: exploit.bluffDelta * scale,
  sizingMultiplier: 1 + (exploit.sizingMultiplier - 1) * scale,
  deDuplicated: rangeProfileApplied && exploit.bluffCatchDelta !== 0,
};
```

**唯一条件**：`context.profileRangeEvidence?.provider.applied === true`。
`profileRangeEvidence` 由 `contextBuilder.ts:3305-3379` 构造，`provider` 是
`rangeBuild.tendency.provider.evidence()`（`contextBuilder.ts:1460`），
即 **`TendencyProvider`（倾斜通道）**的 `applied`。

### A.4.2 实测：闸门在黄金夹具上确实生效

```text
--- A3 quickProfile=MANIAC ---
  profileRangeEvidence=存在(applied=true) ⇒ 闸门 rangeLayerApplied=true
  {"exploit.applied":true,"exploit.bluffCatchDelta":0,"exploit.deDuplicated":true,
   "exploit.bluffDelta":0.021,"exploit.sizingMultiplier":1.035,"exploit.thinValueDelta":-0.0105}
```

受控反事实（同一个 context，只把 `profileRangeEvidence` 字段拿掉）：

```text
--- A3(MANIAC) 的受控反事实：把 profileRangeEvidence 拿掉 ---
有 profileRangeEvidence（生产路径）：
  {"compression.aggressionCredibility(=压缩因子)":0.5752777777777778,"exploit.bluffCatchDelta":0,"exploit.deDuplicated":true,…}
拿掉 profileRangeEvidence：
  {"compression.aggressionCredibility(=压缩因子)":0.5189005555555556,"exploit.bluffCatchDelta":0.034999999999999996,"exploit.deDuplicated":false,…}
差异 3 条：
  compression.aggressionCredibility(=压缩因子): 0.5752777777777778 !== 0.5189005555555556
  exploit.bluffCatchDelta: 0 !== 0.034999999999999996
  exploit.deDuplicated: true !== false
```

⇒ 闸门是**载荷路径**（不是装饰）：一旦判据为假，画像会**第二次**改变决策
（压缩乘数 + 抓诈唬偏移）。

### A.4.3 严密性判定：**不严密**（三条攻击路径，其中一条已实测打通）

判据读的是**倾斜通道**的证词，而 V2 让**河牌进攻动作走统一似然通道并抑制倾斜通道**
（`contextBuilder.ts:1202-1308`）。因此「画像改了范围」与「证据说 applied=true」
在结构上是可以分离的。已实测的两条分离：

**(i) 证据缺席但画像确实改了范围 —— 已打通（真实生产输入）**

`villain.behaviorProfile`（不传 `quickProfile`）时：`playerBuilt.tendency === null`
（`contextBuilder.ts:2557-2573` 的 `hasEvidence` 为假，因为维度层级是 `PRIOR`），
于是 `profileRangeEvidence` **不存在**；但 `behaviorProfile` 仍被注入范围
（`:3210`），河牌似然照常使用它（`:1204` 的 `behaviorProfile ?? 中性`）。实测：

```text
================ A4 只给显式 behaviorProfile(MANIAC) （792 ms） ================
player.quickProfile=null  confidence=0.5  neutralized=true
profileRangeEvidence：字段**不存在**（没有任何画像/倾向证据）
范围：supportSize=449  entropyBits=7.511453278  effectiveComboCount=135.568308  topProbability=0.011899686
profileClassMasses：bluff=0.049965199 missedDraw=0.033906641 pureAir=0.016058558 value=0.393650017
决策：equity=57.6645%  callEV=13.102311  action=CALL
digests：range=342d35d07cc56b8e …（基线 37da1689d1b3be7c）
--- A4(只给显式 behaviorProfile) vs A0(完全不给) ---
  rangeDigest     342d35d07cc56b8e != 37da1689d1b3be7c
  mathDigest      47fd5f1e5ac2d50b != e3dd978b1a708175
  factsDigest     4321737156106afb != aba31333300cd4e3
  **范围链路**差异：≥24 条（探针的差异列表硬上限是 24 条；首条：facts.actionMasses.bluffCandidateMass 0.04996519898363891 vs 0.01842144005887408）
```

同一份输出里的完整差异路径清单（含 `math.heroEquity`、`opponentRanges[0].metrics.*`、
`postflopFacts.betDecision.*`）见原始输出 §1 的
`--- A4(只给显式 behaviorProfile) vs A0(完全不给) ---` 段落。
关键一条：**`playerDigest` 与基线完全相同**（`654deba6671c281a`），
即玩家快照一个字都没变（`quickProfile` 仍是 `null`），
而范围/权益/CallEV **全变了**（权益 56.2588% → 57.6645%，+1.41pp），
`profileRangeEvidence` 却是「没有画像」。于是
`decisionViewModel.ts:621-623` 会打印
**「画像 → 范围：—（本局没有画像 / 近期倾向）」** —— 界面文案与行为相反。

> 今天这条路径上「第二次计费」**恰好是中性的**，因为剥削层的画像来源是
> `exploitSourceOf`，它只读 `player.quickProfile`（`postflopAdvisor.ts:216`）：
> `quickProfile` 为 `null` ⇒ `confidenceScale = 0` ⇒ 压缩乘数与偏移都被缩放为 0。
> 也就是说：**重复计费是潜在的，不是当前活的** ——
> 一旦剥削层改为读 `behaviorProfile`（或该字段被 UI 接上），它立刻变成活的。

**(ii) `applied=false` 但画像已在河牌改范围（`NORMAL` 之外需要构造）**

`provider.applied` 需要「至少一次非抑制调用且因子 ≠ 1」
（`tendencyProvider.ts:276-281`）。合法牌局里对手在翻牌/转牌必然要行动，
因此这些动作会喂给 provider；但**若对手唯一的进攻动作在河牌**，
该动作被抑制（`contextBuilder.ts:1302-1308`）、
其余动作（CHECK/CALL）在 `aggression/passivity = 0.5` 的原型下因子恰为 1，
`applied` 就会是 `false`，而统一似然通道仍在河牌改范围。
本报告**没有构造出**满足这一条的真实合法牌局（对手在翻牌/转牌不可能完全不行动，
除非已被全下，而全下之后就没有河牌进攻动作），因此它属于**结构性缺口**，
不是已复现的活缺陷。判据本身没有「统一似然通道是否生效」这一项，
是缺口的来源（建议的修法：让 `profileRangeEvidence` 记录
`likelihoodOverride !== null` 的次数，闸门读那个量）。

**(iii) 反向分离：证据存在但没生效**

`NORMAL` 的 `profileRangeEvidence` 存在而 `applied=false`（§A.2）——
这一侧是安全的（闸门读到 false，剥削层按可信度 0.35 生效，
但因为 `NORMAL` 的偏移全是 0，实际也是恒等）。

**判定**：去重规则**在当前生产夹具上是有效的**，但**不是构造上严密的**：
它的判据与被去重的那条通道（V2 统一似然）**没有耦合**，
并且存在已实测的「行为有、证据无」路径。

## A.5 消费者清单（含 UI 可见性）

### A.5.1 `context.profileRangeEvidence` 的全部消费者

| 位置 | 用法 | 用户可见？ |
|---|---|---|
| `src/app/decision/postflopAdvisor.ts:383` | `rangeLayerApplied` → 压缩乘数闸门 | 间接（改变建议） |
| `src/app/decision/postflopAdvisor.ts:384,390,391` | `scorerProfileConfidence` / `scorerLayerApplied` / `doubleCountBlocked` | 间接 |
| `src/app/decision/postflopAdvisor.ts:392-402` | `profileEvidence.noteZh`（进 `betDecision`） | 仅当 `facingBet=false`（`postflopAdvisor.ts:550` `if (facingBet \|\| …) return null`；实测黄金夹具 `"betDecision":null`） |
| `src/app/decision/postflopAdvisor.ts:468,472,475` | `rangeProfileApplied` → `bluffCatchDelta` 归零 + `deDuplicated` | 间接（改变建议） |
| `src/app/decision/postflopAdvisor.ts:861-869` | 「🔴 去重：画像已进入对手范围…」理由文本 | 是（`reasonsZh` 进 UI） |
| `src/app/decision/decisionEngine.ts:2767` | → `diagnostics.profileRange`（类型 `decision.types.ts:978`） | 是（经 API） |
| `src/viewmodels/decisionViewModel.ts:621-669` | `debug.profileRange` 十余行行文本 | **否**：API 回传了 `viewModel`（`webServer.ts:838`），但 `table.js:1500-1523` 不渲染 `debug` |
| `test/profileRangeAdjustment.test.ts` 等 | 测试断言 | 否 |

### A.5.2 `profileClassMasses` 的全部消费者

| 位置 | 用法 |
|---|---|
| `src/app/manualInput/rangeFacts.ts:203-267` | **生产者**（唯一） |
| `src/domain/postflop/types.ts:203-239` | 类型声明 |
| `test/profileQuantificationGolden.test.ts:173-180` | **唯一的读取者**（`measure()` 把它取出来算 §二十 单调性与 §二十三 距离） |
| `reports/PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md:384` | 文档提及 |

⇒ **`profileClassMasses` 与 `actionMasses` 在 `src/` 里没有任何消费者**
（grep `actionMasses` 只命中 `rangeFacts.ts:183/282` 与 `postflop/types.ts:168`）。
它们**不是用户可见量**：不进 `diagnostics`（`decisionEngine.ts:2697/2705` 只读
`supportSize` 与 `counts`）、不进 API、不进 UI。
今天唯一「看见」画像是否改变质量结构的方式是**测试与脚本**。

---

# Part B —— `rangeDistance` 的真实含义

## B.1 `profileRangeDistance` 的全部调用点

定义：`src/domain/player/profileRangeMetrics.ts:106-126`（导出类型 `RangeDistance`
在 `:70-78`）。

| # | 文件:行 | 性质 | 实参 |
|---|---|---|---|
| 1 | `test/profileQuantificationGolden.test.ts:294` | 测试（**黄金断言**） | `dist(a.masses)` / `dist(b.masses)` —— **5 个类别质量** |
| 2 | `test/profileV2Metrics.test.ts:194` | 测试 | `[0.5,0.5]` vs `[0.5,0.5]`（合成 2 元向量） |
| 3 | `test/profileV2Metrics.test.ts:199` | 测试 | `[1,0]` vs `[0,1]` |
| 4 | `test/profileV2Metrics.test.ts:204` | 测试 | `[0.7,0.3]` vs `[0.2,0.8]`（对称性） |
| 5 | `test/profileV2Metrics.test.ts:205` | 测试 | 同上反向 |
| 6 | `test/profileV2Metrics.test.ts:209` | 测试 | `[0.5]` vs `[0.5,0.5]`（长度不一致 ⇒ null） |
| 7 | `test/profileV2Metrics.test.ts:210` | 测试 | `[]` vs `[]`（空输入 ⇒ null） |
| — | `scripts/v21-profile-sensitivity-audit.ts:46` | **仅 import，无调用** | 该文件在 `:801` 传的是 `rangeDistance: 0`（字面量） |

> ⚠️ 仓库在验证期间是**活动**的：`scripts/v21-profile-sensitivity-audit.ts` 等
> `v21-*` 脚本由并行代理在本次验证过程中创建（观察到 mtime `2026-09-18 18:30–18:31`）。
> 上表是**写作时刻的快照**；`src/` 与 `test/` 的调用点在同一时刻未观察到变动。

**生产（`src/`）调用点：0 个。** `grep -rn profileRangeDistance src/` 只命中定义处
（`profileRangeMetrics.ts:100` 注释与 `:106` 定义）。

补充：`profileRangeMetrics.ts` 这个模块**确实**在生产路径上被用 ——
但用的是它的另外两个函数：`effectiveCombosOf` 与 `posteriorMassCombosOf`
（`rangeFacts.ts:56-57` 导入、`:263-265` 调用），**不是距离函数**。

## B.2 `medianRangeDistance` 是否存在

**不存在（NO）。** 全仓（含 `src/` `test/` `scripts/` `reports/` `docs/`）grep：

```text
reports\PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md
Line 382: 3. ⚠️ **`medianRangeDistance` 只在类级别度量**（5 个互不重叠的类别分量），
```

只有这一行，而且是在**已知限制**小节里。代码里没有任何名为
`medianRangeDistance` 的函数、变量、类型或导出；也不存在「若干距离取中位数」的实现。
V2 报告 §12 的表格（`:241`）用的名字是 `rangeDistance`，
数值 `TV 0.0422 / JS 0.0128` 与本报告实测的 §二十三 值**一致**
（实测 `TV 0.04216817393165691 / JS 0.0127654409487184`）——
所以**数字是对的，`medianRangeDistance` 这个名字是报告的笔误**（凭空发明的名字）。

## B.3 实际传入的向量是什么

黄金断言处的原文（`test/profileQuantificationGolden.test.ts:287-294`）：

```ts
  const dist = (m: typeof a.masses): number[] => [
    (m.valueMass ?? 0) - (m.thinValueMass ?? 0),
    m.thinValueMass ?? 0,
    m.showdownMass ?? 0,
    m.missedDrawMass ?? 0,
    m.pureAirMass ?? 0,
  ];
  const distance = profileRangeDistance(dist(a.masses), dist(b.masses));
```

**确认成立**：距离是在 **5 个互不重叠的类别级质量**上算的，
不是 1326 维、也不是逐组合（每 entry）的概率向量。

| 分量 | 表达式 | 上游聚合（`rangeFacts.ts`） |
|---|---|---|
| 1. 坚果+强价值 | `valueMass - thinValueMass` | `:242` `valueMass = NUT_VALUE + STRONG_VALUE + THIN_VALUE`；减去薄价值后 = 坚果 + 强 |
| 2. 薄价值 | `thinValueMass` | `:248` `byClass.THIN_VALUE` |
| 3. 摊牌价值 | `showdownMass` | `:249` `byClass.SHOWDOWN_VALUE`（含 `UNCERTAIN`，见 `riverProfileClassify.ts:257-261`） |
| 4. 错过听牌 | `missedDrawMass` | `:240-241` 错过同花 + 错过顺子 + 两者都错过 |
| 5. 纯空气 | `pureAirMass` | `:253` `byClass.PURE_AIR` |

逐组合 → 类别的累加在 `rangeFacts.ts:219-238`（`riverComboClassOf` 在 `:232`），
8 个类别在 `:209-218` 初始化；`:226-228` 把与 Hero/公共牌重叠的组合剔除
（因此 5 分量之和不含 `unclassifiedMass`，且归一化由
`profileRangeDistance` 内部的 `normalise` 处理）。
`RiverComboClass` 共 **8 类**（`NUT_VALUE / STRONG_VALUE / THIN_VALUE /
SHOWDOWN_VALUE / MISSED_FLUSH_DRAW / MISSED_STRAIGHT_DRAW / MISSED_COMBO_DRAW /
PURE_AIR`），在 5 分量里被压成 5 个互不重叠的组。

## B.4 探针实测数字（`scripts/v21-chain-distance-probe.ts`）

夹具：黄金手的牌面 `A♦8♠4♠2♣K♦` + Hero `A♣J♥`。用 **`riverComboClassOf`**
对全部 1326 个组合分类（原始输出 §1）：

```text
ALL_COMBOS=1326；与 Hero/公共牌重叠=336；无法分类=0
  SHOWDOWN_VALUE          471 个组合
  MISSED_STRAIGHT_DRAW    208 个组合
  PURE_AIR                142 个组合
  THIN_VALUE               86 个组合
  MISSED_COMBO_DRAW        32 个组合
  STRONG_VALUE             29 个组合
  MISSED_FLUSH_DRAW        22 个组合
选中的两个类别：SHOWDOWN_VALUE（取 3c2d/3c2h/3c2s） 与 MISSED_STRAIGHT_DRAW（取 6c3c/6c3d/6c3h）
```

两条后验向量**只在类别内部不同**：A 在 `SHOWDOWN_VALUE` 内均匀（0.5/0.25/0.25），
B 把质量挪到 `3c2d`（0.875/0.0625/0.0625）；`MISSED_STRAIGHT_DRAW` 同理反向。
真实 `Range` 由 `buildRangeFromComboWeights` 构建，
类别质量由**生产聚合器** `opponentRangeFactsOf` 算（TEST_ONLY 来源）。

### (a) 类别级（黄金测试的算法）

```text
  黄金测试的 5 分量向量（坚果+强价值, 薄价值, 摊牌, 错过听牌, 纯空气）：
    A = [0.00000000000000, 0.00000000000000, 0.50000000000000, 0.50000000000000, 0.00000000000000]
    B = [0.00000000000000, 0.00000000000000, 0.50000000000000, 0.50000000000000, 0.00000000000000]
    JSON 逐位相同 = true
  (a) 类别级：profileRangeDistance(黄金5分量A, 黄金5分量B) = { totalVariation: 0, jsDivergence: 0, sharedSupport: 2 }
```

**`totalVariation = 0`、`jsDivergence = 0`（精确 0，不是「小于阈值」）。**
生产聚合器逐字段比较也全等：`showdownMass 0.5 == 0.5`、`missedStraightMass 0.5 == 0.5`、
`bluffMass 0.5 == 0.5`、`totalMass 1 == 1`。

### (b) 逐组合级（对齐后的逐组合后验）

```text
  entries 数：A=6 B=6；canonicalId 序列逐位对齐=true
    逐组合后验 A = [0.25000000000000, 0.12500000000000, 0.12500000000000, 0.25000000000000, 0.12500000000000, 0.12500000000000]
    逐组合后验 B = [0.43750000000000, 0.03125000000000, 0.03125000000000, 0.03125000000000, 0.03125000000000, 0.43750000000000]
  (b) 逐组合：profileRangeDistance(后验A, 后验B) = { totalVariation: 0.5, jsDivergence: 0.2200241522709298, sharedSupport: 6 }
```

**类别级 `TV = 0` vs 逐组合 `TV = 0.5`、`JS = 0.2200241522709298`** ——
同一对范围，同一个距离函数，结论从「完全相同」变成「差得很远」。

### 正对照（证明不是函数写错）

把质量挪到**另一个类别**（`SHOWDOWN 0.6→0.75`、`MISSED_STRAIGHT 0.4→0.25`）：

```text
  正对照（把质量挪到**另一个类别**）：C 的 5 分量 = [0, 0, 0.75000000000000, 0.25000000000000, 0] ⇒ totalVariation: 0.25, jsDivergence: 0.0487949406953985
  ⇒ 同一函数：**跨类别** TV=0.25 vs **同类别内部** TV=0；逐组合口径 TV=0.5
```

### 诚实性附注 1：十进制权重下不是精确 0

变体 2（`0.2/0.2/0.2` 对 `0.5/0.05/0.05`）暴露了累加顺序的浮点噪声：

```text
    totalMass              A=1                      B=0.9999999999999998     !=
    showdownMass           A=0.6000000000000001     B=0.5999999999999999     !=
    missedStraightMass     A=0.4                    B=0.3999999999999999     !=
  (a) 类别级：{ totalVariation: 5.551115123125783e-17, jsDivergence: -9.610279511444755e-17, sharedSupport: 2 }
  (b) 逐组合：{ totalVariation: 0.46666666666666673, jsDivergence: 0.16950491685150207, sharedSupport: 6 }
```

两点如实记录：① 类别级距离不是数学上的 0，而是 `5.6e-17`（1 ULP 量级）；
② `jsDivergence` 出现了**极小负值**（`-9.6e-17`）——
JSD 数学上 ≥ 0，`profileRangeMetrics.ts:119-120` 的浮点求和会给出 -1e-16 量级。
当前断言（`> 0.002`）不受影响，但若将来有人断言 `jsDivergence >= 0` 会假红。

### 诚实性附注 2：`profileClassMasses` 不是完全看不见「类别内集中」

同一份探针输出里，两个**标量**字段**确实**看见了类别内的集中：

```text
    effectiveCombos        A=5.333333333333333      B=2.585858585858586      !=
    posteriorMassCombos90  A=6                      B=3                      !=
    posteriorMassCombos95  A=6                      B=5                      !=
```

所以准确的说法是：**§二十三 用的那条距离对类别内重分配完全不敏感**，
而同一个结构里的 `effectiveCombos` / `posteriorMassCombos90/95`
（`rangeFacts.ts:262-265`）是敏感的 —— 只是它们**不在 §二十三 的输入里**，
而且如 §A.5 所述**没有任何 UI/diagnostics 消费者**。

### 诚实性附注 3：黄金夹具上 TV 与「诈唬质量差」数值相同（不是巧合）

实测：`|Δ bluffMass| = 0.05001416632562606 - 0.007845992393969235 = 0.04216817393165682`，
而 §二十三 的 `totalVariation = 0.04216817393165691`（差 9e-17）。
原因是代数上的：两侧总质量都是 1，于是 `Σ Δᵢ = 0` ⇒
`TV = ½ Σ|Δᵢ| = Σ(正 Δᵢ)`；而在这个夹具里**唯一上升的两个分量恰好就是
`missedDraw` 与 `pureAir`**（其余三个都下降），所以
`TV = ΔmissedDraw + ΔpureAir = ΔbluffMass`。
⇒ 对**这一个夹具**，§二十三 的 `TV > 0.02` 与物性判定的
`bluffMassDelta` 项携带**同一份信息**，`profileRangeDistance` 没有提供独立信号。

真实的 §二十三 数字（生产路径，探针 §4）：

```text
  03A 5 分量 = [0.11539219557984, 0.29601805190890, 0.58074376011729, 0.00491544454395, 0.00293054785002]
  03B 5 分量 = [0.10643042563804, 0.28756315004423, 0.55599225799210, 0.03402886893302, 0.01598529739261]
  §二十三 实际断言的就是这个距离：{ totalVariation: 0.04216817393165691, jsDivergence: 0.0127654409487184, sharedSupport: 5 }
```

（断言阈值：`totalVariation > 0.02`、`jsDivergence > 0.002`，
`test/profileQuantificationGolden.test.ts:296-303`。）

## B.5 逐组合后验向量今天能不能从生产输出拿到？

**不能。** 证据：

* `Range` 类型有 `entries: readonly RangeEntry[]`（每项 `combo.cardIndices` +
  `probability`，`range.types.ts:95-106`），但**它不出现在任何公开输出里**。
* 决策层拿到的是 `RangeSnapshot`（`decision.types.ts:514-554`），字段实测为：

  ```text
  RangeSnapshot 的字段：collapsed, confidence, metrics, opponentId, opponentPositionZh,
  sourceDescription, sourceId, sourceKind, supportShare, supportSize, updateTrace
  ```

  没有 `entries`。（`decision.types.ts:834` 自己也写明
  「决策层只拿得到**快照**，拿不到逐组合概率」。）
* `DecisionContext` 的公开字段实测为：

  ```text
  activeOpponentCount, board, deadlineBudget, dynamic, environment, heroCards,
  isClosingAction, math, opponentRanges, player, playersRemainingToAct, playersYetToAct,
  postflopFacts, profileRangeEvidence, range, realizedOpponentCount, timings
  ```

  `range` / `opponentRanges` 都是 `RangeSnapshot`。
* `opponentRangeFacts` 的公开字段实测为：

  ```text
  actionMasses, counts, drawShare, equalShare, meanTier, profileClassMasses,
  strongShare, strongerShare, suitFit, supportSize, tierHistogram, topPairPlusShare, weakerShare
  ```

  全是**聚合量**；`profileClassMasses` 是**类别**聚合（`rangeFacts.ts:203-267`），
  `actionMasses` 也是聚合（`:183-190`）。
* `profileRangeMetrics` 里唯一能表达「逐组合集中度」的公开量是**标量**：
  `effectiveCombos`（`:263`）、`posteriorMassCombos90/95`（`:264-265`）；
  `range.ts:343-365` 的 `RangeMetrics` 同样只有标量
  （`entropyBits` / `effectiveComboCount` / `topProbability`）。
* `range.ts:378-395` 的 `probabilityByRankClass` / `rawWeightByRankClass`
  是仅有的「吃 `Range` 吐聚合」的公开辅助函数，但
  **全仓没有任何调用者**（连测试都没有）。

⇒ 今天要算逐组合距离，只能：①在 `contextBuilder` 内部加一条导出
（改 `src/`，本任务禁止）；或②在外部**重新构建**范围
（本探针的做法，`buildRangeFromComboWeights` + 自造权重）——
但那**不是生产后验**（没有 `applyLikelihoodUpdates` 的似然更新，
也无法复现 `updateRange` 的对数域归一化）。所以「逐组合距离」目前
**只在测试内部的合成向量上算得出来**（`test/profileQuantification.test.ts:223-227`
就是一个手写的逐组合 TV，用 `reweightCombos` 的 8 个合成组合）。

## B.6 命名误导清单（只列，不改名）

| # | 位置 | 问题 |
|---|---|---|
| 1 | `reports/PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md:382` | **`medianRangeDistance` 这个名字在代码里不存在**；且「median」毫无出处（指标是 TV/JS，没有中位数）。 |
| 2 | `src/domain/player/profileRangeMetrics.ts:100` | 文档说「§二十三 `profileRangeDistance`：两个画像下的**后验范围**有多不同」——「后验范围」读起来是逐组合后验；实际调用点喂的是 5 个类别质量。 |
| 3 | `src/domain/player/profileRangeMetrics.ts:70` | `RangeDistance` 类型注释「两个**后验分布**之间的距离（要求按同一顺序对齐、且各自已归一化）」——对任意向量都成立，放在「范围」模块里天然被读成逐组合。 |
| 4 | `test/profileQuantificationGolden.test.ts:275` | 「§二十三 `profileRangeDistance`：两个画像的**后验分布**必须真的分开」——只在 `:277-282` 才说明是 5 个分量。 |
| 5 | `test/profileV2Metrics.test.ts:10`、`:190,193` | 测试名「§二十三 profileRangeDistance：相同 ⇒ 0、不相交 ⇒ 1」用的是 `[0.5,0.5]` 这种 2 元向量，名字里没有任何「类别级」限定。 |
| 6 | `src/domain/player/behaviorProfile.ts:1108,1114,1138,1142` | `profileMaterialityOf` 的入参/出参/文案都叫 `rangeDistance` / 「范围距离」，但它 (a) **不参与判定**（`:1121-1132` 只用 `equityDelta` 与 `bluffMassDelta`），(b) 黄金测试传进去的是 `Math.abs(b.masses.bluffMass! - a.masses.bluffMass!)`（`test/profileQuantificationGolden.test.ts:231`）——即**诈唬质量差**；(c) 两个脚本直接传 `0`（`scripts/v21-profile-sensitivity-audit.ts:801`、`scripts/v21-fmaudit-model.ts:444`）。⇒ `profileMaterialityOf` 的 noteZh 里那行「范围距离 X」在黄金测试里打印的是 **ΔbluffMass**；而 V2 报告 §12 表里的 `rangeDistance = TV 0.0422 / JS 0.0128`（`:241`）才是真正的 TV。两者**数值恰好相同**（见 B.4 附注 3），极易互相混淆。 |
| 7 | `test/profileQuantification.test.ts:223` | 同一个名字 `rangeDistance` 在这里指的是**手写的逐组合 TV**（8 个合成组合，`:223-227`），并被传进 `profileMaterialityOf`（`:237`）——与 #6 的口径**不同**，两个文件同名不同义。 |
| 8 | `test/reportVerdictConsistency.test.ts:55` | 同一字段又传 `0`（占位）。 |

## B.7 对抗性结论汇总（注释/报告与代码不符之处）

1. **`medianRangeDistance` 不存在**（V2 报告 `:382` 凭空命名）。
2. **`profileRangeDistance` 零生产调用**；「§二十三 后验分布距离」在生产决策里
   没有任何作用（它既不影响动作，也不进 diagnostics）。
3. 黄金测试 §二十三 的输入是 **5 个类别质量**；类别内重分配对它完全不可见
   （实测 TV 从 0 → 逐组合 0.5）。
4. 黄金夹具上 §二十三 的 `TV` 与 `|ΔbluffMass|` **数值相等**（代数必然，
   见 B.4 附注 3）⇒ 该断言没有提供独立信息。
5. `profileMaterialityOf.rangeDistance` 是**装饰字段**：不参与判定，
   黄金测试传的是诈唬质量差，脚本传 0；而报告文案写「范围距离」，
   且 V2 报告 §12 表里的 `rangeDistance` 又是另一个量（真正的 TV，
   数值恰好相同）。同一个名字在同一条证据链上指两件事。
6. `contextBuilder.ts:1062/1157/1226` 引用的 `betLikelihoodOf` **已被删除**
   （`behaviorProfile.ts:964` 自己说的）。
7. 去重闸门（`postflopAdvisor.ts:383/468`）读的是**倾斜通道**的证词，
   与 V2 统一似然通道无耦合；已实测到「画像改了范围（+1.41pp 权益）、
   `profileRangeEvidence` 却缺席」的真实路径，且此时
   `decisionViewModel.ts:621-623` 会打印「本局没有画像」。
8. `suppressProvider = likelihoodOverride !== null` 对**无画像**的河牌进攻动作
   同样为真 ⇒ `dynamicHint` 的观测乘数在河牌进攻动作上永不生效
   （实测 `observation.calls = 0`，范围与无提示时逐位相同），
   与 `tendencyProvider.ts:22-24` 的修复叙述相冲突。
9. `villainProfile`（实测画像通道）**没有生产调用者**；`seatProfiles`
   在牌桌路径上到不了决策；`profileClassMasses` / `actionMasses` /
   `probabilityByRankClass` 在 `src/` 里**没有消费者**——
   也就是说「画像质量结构」目前只对测试与脚本可见。
10. Web UI 不渲染 `viewModel.debug`（`table.js:1500-1523`），
    所以唯一的画像链路证据面板在页面上是看不到的。

---

## 附录 A：Part A 原始输出的关键段落（逐字）

见 `reports/V21_CHAIN_PROFILE_PROBE_OUTPUT.txt`（约 358 行；行数会随
`timings.*` 差异条目数轻微浮动，因此本报告的引用一律按**小节名**索引，不按绝对行号）。
节选已内联在 §A.2.1、§A.3.1、§A.3.2、§A.4.2、§A.4.3。

**确定性实测**：把探针连续跑两次并 `Compare-Object` 比对整份输出 ——
**全部业务数字（digest、质量、权益、CallEV、熵，以及所有 `!=` 判定）逐位相同**；
唯一的差异行是 `timings.*` / `deadlineBudget.elapsedMs` / 每案例的耗时标签，
以及由它们导致的「差异路径条数」计数。Part B 探针重跑 **0 处差异**。

## 附录 B：Part B 原始输出

见 `reports/V21_CHAIN_DISTANCE_PROBE_OUTPUT.txt`（102 行，重跑零差异）。节选已内联在 §B.4。

## 附录 C：黄金测试 / V2 指标测试基线输出

```text
✔ §二十 03A vs 03B：诈唬质量、错过听牌质量、权益与 EV 必须单调 (2884.8662ms)
✔ §八/§三十八 黄金夹具的节点必须是 TURN_CHECK_BACK + LARGE（画像似然真的生效） (615.8911ms)
✔ §二十五 未知玩家不得与前两个画像产生同样强的调整（不替陌生人套原型） (3270.4908ms)
✔ 🔴 覆盖锁：每一个 QuickProfile 都必须「有先验」或「显式声明中性」 (2.7448ms)
✔ 🔴 画像不得假装确定：无先验的中性标签必须自报家门 (1.1511ms)
ℹ tests 5 / pass 5 / fail 0
```

```text
✔ NEUTRAL_PARITY：中性画像必须在 3 尺寸 × 8 类别 × 2 前序线上与既有档位权重**逐位相等**
✔ §二十七 effectiveCombos：等权时等于组合数，集中时趋近 1
✔ §二十八 posteriorMassCombos：90% / 95% 质量所需的最少组合数
✔ §二十三 profileRangeDistance：相同 ⇒ 0、不相交 ⇒ 1、且对称有界
ℹ tests 6 / pass 6 / fail 0
```

> 说明：这两个文件在本报告写作时**全部通过**。本报告的结论不是「测试红了」，
> 而是「测试绿的同时，若干注释/报告的措辞与代码行为不一致」。
