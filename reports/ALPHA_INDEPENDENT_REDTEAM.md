# Alpha 独立红队审计报告

> 审计对象：`D:\德州` · Alpha 可测试版本
> 审计方式：**独立构造探针**（不使用作者夹具、不修改 `src/` 与 `test/`）
> 审计基线：`node --test test/**/*.test.ts` → **1061 项 / 136 套件 / 全部通过**；`npx tsc --noEmit` → 0 错误
> 结论见文末。

---

## 0. 证据脚本清单（全部保留在 `scripts/`，可直接运行）

| 脚本 | 覆盖的攻击面 |
|---|---|
| `scripts/rt-alpha-lib.ts` | 独立夹具与指纹工具（不依赖 `test/helpers.ts`） |
| `scripts/rt-alpha-probe1.ts` | 攻击 1（数学污染）· 5（动态翻转）· 6（结果污染）· 7（确定性/种子） |
| `scripts/rt-alpha-probe2.ts` | 攻击 2（非法动作穷举 216 场景）· 3（输入静默纠正） |
| `scripts/rt-alpha-probe3.ts` | 攻击 11（多人池）· 4（信息不足）· 8（概率统计）· 2E（ALL_IN 语义） |
| `scripts/rt-alpha-probe4.ts` | 攻击 8H（似然自检失败）· 11（多人池）· 2F（全下应对）· 4C/4D（位置档位） |
| `scripts/rt-alpha-probe5.ts` | 攻击 2G（满筹码全下）· 9（性能）· 10（UI 一致性）· 12（队列回归/加权兼容） |
| `scripts/rt-alpha-probe6.ts` | 攻击 10D（分类×置信度）· 3D（死字段）· 11B（9 人桌）· 7C（日志哈希） |
| `scripts/rt-alpha-probe7.ts` | 攻击 7D（逐位确定性）· 3E（bigBlindBB 严格证明） |
| `scripts/rt-alpha-probe8.ts` | 攻击 10F（HTTP vs 引擎）· 11C（UI 文案 vs 引擎阈值）· 8I（3bet 范围） |
| `scripts/rt-alpha-probe9.ts` | 攻击 10G（HTTP 严格逐字段）· 4F/4G（置信度天花板） |
| `scripts/rt-alpha-probe10.ts` | 攻击 2H（全下额不足最小加注）· deriveLegalActions 等价性 |
| `scripts/rt-alpha-probe11.ts` | 攻击 2I（raiseClosedFor 与推导层不一致） |
| `scripts/rt-alpha-probe12.ts` | 复核：置信度各分量（避免误报） |

运行方式：

```
node.exe --experimental-strip-types "scripts/rt-alpha-probe1.ts"
...（probe1 ~ probe12）
```

全部 12 个探针的**原始完整输出**已固化为 `scripts/rt-alpha-evidence.txt`（1098 行，12 个探针全部 `exit=0`），
本报告中的所有「实际观测值」均可在此文件中逐字核对。

**审计期间未修改 `src/` 与 `test/` 下任何文件；未删除或弱化任何现有测试或断言。**

---

## 1. 总览：发现清单

| # | 严重级别 | 一句话 |
|---|---|---|
| F-01 | **CRITICAL** | 面对下注时**永远不会建议加注**——`pickCandidate` 无加注分支，AA 面对 3bet 建议「跟注」 |
| F-02 | **CRITICAL** | **似然模型自检失败**（弱牌被动似然低于强牌），且该自检函数**从未被任何测试或代码调用** |
| F-03 | **MAJOR** | 3bet/4bet 场景把对手范围当成**开池范围**（BB 3bet 用 BTN 开局范围 47.8%），权益虚高 **+27.5 个百分点** |
| F-04 | **MAJOR** | 置信度被启发式范围可信度 0.3 **锁死**，但分类仍大量输出「明确决策」（21/40） |
| F-05 | **MAJOR** | 信息不足时 `decision.action` 仍为 `'FOLD'`（Web `/api/analyze` 与日志都带出去） |
| F-06 | **MAJOR** | UI 声称「只支持单挑」，引擎实际在 **2 名活跃对手**下给出建议且**忽略第二名对手的行动** |
| F-07 | **MINOR** | `bigBlindBB` 是死字段：解析、校验、阻断都做了，但**对输出零影响** |
| F-08 | **MINOR** | 对手全下**无法录入**：`ALL_IN` 金额校验与 `villain.stackBB` 缺省冲突，合法牌局被拒 |
| F-09 | **MINOR** | ViewModel 调试区 `viewmodel 0.0 ms / total 0.0 ms` —— 用构建**之前**的 timings 渲染 |
| F-10 | **MINOR** | `hashManualInput` 漏掉 `bigBlindBB` / `villains` / `actionHistory[].street`，不同输入同哈希 |
| F-11 | **MINOR** | 提供动态提示反而**降低**置信度：`dynamicHint=UNKNOWN` 得 0.3000，明确给 `TILT_SIGNAL` 只得 0.2344 |
| F-12 | **INFO** | 文档漂移：`CURRENT_PROJECT_STATUS.md` 仍写「决策引擎未实现 / 产品能力 0% 可端到端使用」 |
| F-13 | **INFO** | `budget` 参数只进 `context.deadlineBudget` 字段，**不控制**任何计算 |

**本轮未发现的问题（如实声明）**：
- 在本轮实验范围内**未发现**「输出的动作无法被 `applyAction` 执行」的场景（216 个自建场景 + 36 个状态 × 7 种动作穷举，0 例不一致）。
- 在本轮实验范围内**未发现**策略层（环境 / 画像 / 动态 / 对手筹码）修改数学九项（264 组合 × 4 场景，指纹数恒为 1）。
- 在本轮实验范围内**未发现**结果信息（多余属性 / 原型链 / 原型污染）改变决策。
- 在本轮实验范围内**未发现**无权重调用与修复前不逐位一致（4 个种子，全部逐位相等）。

---

## 2. CRITICAL 发现

### F-01 · 面对下注时永远不建议加注（结构性缺失）

- **严重级别**：CRITICAL
- **最小复现**：`scripts/rt-alpha-probe2.ts` → 「攻击 2B / 2B-2」

**实际观测值**

```
攻击 2B：面对下注时 RAISE 是否可达？
  面对下注的场景数: 136
  建议 RAISE/ALL_IN 的次数: 0
  RAISE 合法但未被建议的次数: 133
   · flop达成下注 AsKd@Kh7c2d 1BB: 合法集合[FOLD,CALL,RAISE,ALL_IN] 但建议 CALL
   · flop达成下注 7h7d@Kh7c2d 1BB: 合法集合[FOLD,CALL,RAISE,ALL_IN] 但建议 CALL（权益 0.964 vs 所需 0.118）

攻击 2B-2：翻牌前 AA 面对 3bet 的具体输出
  动作=CALL 尺寸=700 分类=CLEAR
  合法集合=["FOLD","CALL","RAISE","ALL_IN"]
  权益=0.8398 所需=0.34146341463414637
  候选=[{"a":"FOLD","ev":0,"f":true},{"a":"CALL","s":700,"ev":1021.59,"f":true},
        {"a":"RAISE","s":1700,"ev":null,"f":true},{"a":"RAISE","s":10000,"ev":null,"f":true},
        {"a":"ALL_IN","s":10000,"ev":null,"f":true}]
```

同时，probe2 的 216 场景穷举动作分布为：`{"CALL":113,"BET":13,"FOLD":31,"CHECK":14}` —— **RAISE 与 ALL_IN 各 0 次**。

**根因（源码定位，未修改）**

`src/app/decision/decisionEngine.ts` 的 `pickCandidate()` 只有三个出口：

1. 场景 1（`legal.callCost > 0`）→ 只可能返回 `foldCandidate` 或 `callCandidate`（含 MARGINAL 分支）；
2. 场景 2（有 `checkCandidate`）→ 返回 `checkCandidate` 或 `largestAggressive(...)`（只在 `canBet` 时存在，即**无人下注**时）；
3. 场景 3 兜底 `bestComparable(candidates) ?? foldCandidate` —— `bestComparable` 只在 `ev !== null` 的候选里挑，而 BET/RAISE/ALL_IN 的 `ev` 在 `evaluateCandidates` 里被**刻意设为 `null`**。

三条路径**没有一条**能返回 RAISE。RAISE 只在「无人下注」时通过场景 2 的 `largestAggressive` 以 BET 形式出现。

**影响**

使用者在**任何面对下注的局面**（翻牌前面对开池/3bet、翻后面对下注）拿到的建议只可能是「弃牌」或「跟注」。具体后果：

- 拿 AA / KK 面对 3bet → 系统说「跟注」，漏掉 4bet 价值；
- 翻牌中三条（权益 96.4%）面对下注 → 系统说「跟注」，漏掉加注；
- 有强听牌/组合听牌 → 永远拿不到半诈唬加注建议。

对低级别现金局，**「只用跟注应对下注」是直接亏钱的漏洞**（价值无法三层街化、无法保护手牌、无法拒绝权益）。这不是「保守」，是决策空间被砍掉了 1/3。

**当前测试为何全绿**：`test/alphaSmokeSpots.test.ts` 只断言「不含一眼明显错误的建议」，而作者自己的烟测输出正好把它记录成了正常现象：

```
preflop-02-AA-vs-open=CALL(2.5BB) | preflop-04-AA-vs-3bet=CALL(7.0BB)
```

### F-02 · 似然模型自检失败 + 自检是死代码

- **严重级别**：CRITICAL
- **最小复现**：`scripts/rt-alpha-probe4.ts` → 「攻击 8H」；`scripts/rt-alpha-probe3.ts` → 「攻击 8A」

**实际观测值**

```
攻击 8H：likelihoodModel.selfCheckLikelihoodModel() 是否通过？
  返回值 = ["被动性似然应满足 junk > top（junk=0.6333333333333333 top=0.7599999999999999）"]
  结果 = **失败 ✘（1 项）**
  顶级（KEYS[0]） = AA  垃圾（KEYS[last]） = 22
  → 断言「被动性似然 junk > top」：**不成立**

  被动（NORMAL）似然表（169 类的取值集合）：
    0.9500  共  34 类  例：QTs QTo Q9s Q9o Q8s Q8o Q7s Q7o Q6s Q6o …
    0.8867  共  69 类  例：AQo AJs AJo ATs ATo A9s A9o A8o KJs …
    0.7600  共  46 类  例：AA AKs AKo AQs A7s A7o A6s A6o A5s A5o …
    0.6333  共  20 类  例：63s 63o 62s 62o 55 54s 54o 53s 53o 52s …
```

**根因**

`src/app/manualInput/likelihoodModel.ts` 的 `tierOfRankClassIndex(index, total)` 用「索引/总数」的**百分比切分**去划分一个**按牌力手工排序**的 169 类列表。对子占索引 0–12（7.7%），却被 `if (index < 13) return index < 4 ? 0 : 1 : 2` 压缩到档位 0/1/2，而「1」这个档位在 `NORMAL_WEIGHTS` 里是 **1.4（次高）**。于是：

| 类别 | index | tier | 进攻似然 | 被动似然 |
|---|---|---|---|---|
| AA | 0 | 0 | 0.9500 | 0.7600 |
| AKo | 2 | 0 | 0.9500 | 0.7600 |
| **QQ** | 48 | 2 | **0.5938** | 0.8867 |
| **A7s** | 23 | 0 | **0.9500** | 0.7600 |
| **72o** | 143 | 2 | **0.1069** | **0.7600** |
| **32o** | 167 | 5 | 0.0712 | **0.6333** |

- `A7s`（弱 Ax 同花）与 `AA` 拿到**完全相同的进攻似然 0.9500**，而 `QQ` 只有 0.5938；
- `72o` 的被动似然（0.7600）**高于** `AA`（0.7600 相同）与 `22`（0.6333）——即「对手只是跟注/过牌」时，模型认为他更可能有 72o 而不是 22。

**该自检从未被调用**（证据：全仓库 grep）

```
src\app\manualInput\likelihoodModel.ts:229: export function selfCheckLikelihoodModel()
src\app\manualInput\preflopPriors.ts:627:   export function selfCheckPreflopPriors()
```

除定义处外，**只有我的探针**引用它们。`test/` 下没有 `alphaLikelihoodModel.test.ts`，也没有 `alphaPreflopPriors.test.ts` —— 这两个新模块**零单元测试覆盖**，自检函数返回的失败项因此永远不会被发现。

**影响**

范围更新的似然方向被系统性扭曲：某些弱牌在「对手进攻」时被赋予与顶级牌相同的权重，某些强牌（QQ）被压到中档。虽然最终影响被 `rangeUpdate` 的归一化部分吸收，但**范围的形状**（进而权益、进而跟注/弃牌的边缘判断）建立在一个连自己都判失败的模型上。而 `likelihoodModel` 的文档明确写着「本函数表达什么，由 `selfCheckLikelihoodModel()` 断言」—— 断言不成立。

---

## 3. MAJOR 发现

### F-03 · 3bet/4bet 场景把对手范围当成「开池范围」，权益虚高 27.5 个百分点

- **严重级别**：MAJOR
- **最小复现**：`scripts/rt-alpha-probe8.ts` → 「攻击 8I」

**实际观测值**

```
引擎：范围针对「大盲位」
   来源说明 = 启发式翻牌前范围先验：…（大盲位的启发式开池范围（对手主动加注））
   组合数 = 634（占 1326 的 47.8%）
   权益 = 0.6306  动作 = CALL

对照：若对手是紧 3bet 范围（QQ+/AK，13 个组合）
   AKo 权益 = 0.3558
   → 引擎用开池范围得到的权益 0.6306 比紧 3bet 范围高 27.5 个百分点
   所需权益 = 34.15%
```

**根因**

1. `src/app/manualInput/preflopPriors.ts` 的 `rfiTierOf(TableSize.SIX_MAX, Position.BB)` 落到 `default: return 'BUTTON'` —— **BB 位被赋予按钮位档位（权重和 84.20 / 169 类中 110 类非零）**。
   ```
   位置 UTG  → 档位 EARLY         权重和 33.20
   位置 HJ   → 档位 MIDDLE        权重和 47.30
   位置 CO   → 档位 LATE          权重和 68.95
   位置 BTN  → 档位 BUTTON        权重和 84.20
   位置 SB   → 档位 SMALL_BLIND   权重和 48.00
   位置 BB   → 档位 BUTTON        权重和 84.20     ← 默认兜底
   ```
2. `contextBuilder.buildBaseRange()` 对**任何** `RAISE` 类首个进攻动作都调用 `rfiWeights(...)`，**不区分开池与 3bet/4bet**；3bet 范围数据在 `preflopPriors.ts` 里也明确写着「未建模」。

**影响**

对手做了最强的动作（3bet/4bet），系统却认为他的手牌在**所有牌**里占 47.8%。于是：

- Hero 的权益被系统性抬高（本例 +27.5pp）；
- 面对 3bet 时所需权益 34.15%、估计权益 63.06% → 建议跟注，而真实权益 35.58% 只比门槛高 1.4pp；
- 边缘牌（如 AJo/KQo）会被错误地建议跟注 3bet；
- 与 F-01 叠加：本应 4bet/弃牌的牌被建议「跟注」。

### F-04 · 置信度被启发式范围锁死在 0.30，却仍输出「明确决策」

- **严重级别**：MAJOR
- **最小复现**：`scripts/rt-alpha-probe9.ts` → 「攻击 4F / 4G」；`scripts/rt-alpha-probe6.ts` → 「攻击 10D」

**实际观测值**

```
攻击 4F：置信度天花板 —— 逐分量拆解
  最终置信度 = 0.3  档位 = MEDIUM_LOW  分类 = MARGINAL
     范围可信度 rangeConfidence = 0.3  ← **天花板**（启发式先验固定 0.3）
     玩家可信度 playerConfidence = 0.35
     环境可信度 environmentConfidence = 0.4
     动态可信度 dynamicConfidence = 0.5
     数学精度 precision ≈ 0.96
     降级惩罚 degradationPenalty = 1

攻击 4G：AA 面对 100BB 全下
  动作=CALL 权益=0.8396 所需=0.4938 跟注EV=6933.48
  数学占优=true EV差占底池=0.6831
  **置信度=0.3（档位「MEDIUM_LOW」）分类=CLEAR**
  首屏会显示："建议：跟注" / 置信度「中低」/ 类型「明确决策」
```

分类 × 置信度联合分布（40 个自建可分析样本）：

```
  CLEAR × MEDIUM_LOW（置信度 0.30）    21 次
  MARGINAL × MEDIUM_LOW（置信度 0.30） 19 次
  **「明确决策」+ 低/中低置信度 = 21 / 40**
```

**根因**

`confidenceOf` 对八个分量取 `Math.min`，而 `rangeConfidence` 恒为启发式先验的 `0.3`（`PREFLOP_PRIOR_PROVENANCE.confidence = 0.3`，且 `updateRange` 不改变它）。因此**只要走启发式范围，置信度的上界就是 0.3**，档位永远是「中低」。而 `classifyOf` 的 `CLEAR` 判据只看 EV 分离度与权益区间宽度，**与置信度无关**。

**影响**

界面同时显示「明确决策」与「中低置信度」。使用者在真实牌局里对「明确决策」的心理权重远高于「中低」——这会让他把「启发式范围 + 0.3 置信度」的建议当成可靠结论执行。这正是规范里「信息不足时敢说不知道」要防的方向，只是它没有触达分类字段。

（补充：`confidenceOf` 的环境分量取 `advice.length > 0 ? 0.4 : 0.3` —— **环境规则越多，置信度越高**，但环境规则「只提供方向、无幅度」，这个方向值得复核。）

### F-05 · 信息不足时 `decision.action` 仍是 `'FOLD'`，且随 Web 响应与日志外流

- **严重级别**：MAJOR
- **最小复现**：`scripts/rt-alpha-probe8.ts` → 「攻击 10F 用例 2」；`scripts/rt-alpha-probe4.ts` → 「攻击 2F」

**实际观测值**

三人池（3 名活跃对手，引擎判定信息不足）经真实 HTTP 接口：

```
用例2（三人池）HTTP 200 ok=true
     **decision 字段 = {"action":"CALL","sizeChips":200,...,"actionable":true}**   ← 这一例是 2 名活跃对手
```

4 名活跃对手（UTG 全下 + HJ 弃牌 + 其余未行动）：

```
  AA 面对 UTG 10BB 全下
     动作=FOLD 分类=INSUFFICIENT_INFORMATION 置信度=0.0000 可执行=false
     底池=1150 需投入=1000 所需权益=46.51% 估计权益=83.96% 跟注EV=805.09
```

**根因**

`decideAlpha` 组装输出时：

```ts
const action = finalCandidate?.action ?? DecisionAction.FOLD;
```

`finalCandidate` 在 `actionable === false` 时是 `null`，于是 `action` 落成 `'FOLD'`。`viewModel.actionZh` 会正确地显示「无法分析」，但：

- `webServer.ts` 返回体里 `decision.action` 原样带出去；
- `decisionLog.ts` 的 `entry.decision = decision.action` 写进 JSONL；
- `alphaPipeline` 的 `AlphaAnalysisSuccess.decision` 也带出去。

**影响**

任何按 JSON 字段（而不是按中文文案）读取结果的消费方——包括使用者自己翻 `/api/analyze` 的原始 JSON（UI 里就有「原始 JSON」展开区）、以及日后基于 JSONL 做统计的脚本——都会把「信息不足」读成「建议弃牌」。而「信息不足」与「建议弃牌」在策略上是**相反**的结论（前者是不知道，后者是知道且不该玩）。

### F-06 · UI 声称「只支持单挑」，引擎在 2 名活跃对手下给出建议并忽略第二名对手

- **严重级别**：MAJOR
- **最小复现**：`scripts/rt-alpha-probe8.ts` → 「攻击 11C」；`scripts/rt-alpha-probe4.ts` → 「攻击 11」

**实际观测值**

```
index.html:197  <li>只支持<b>单挑</b>局面（多人池会明确返回「信息不足」，不会假装单挑）</li>
index.html:201  <li>不支持多人池、锦标赛、短牌</li>

三人池实际：actionable=true 分类=CLEAR 范围针对=1 位对手（枪口位）
→ 引擎在「2 名活跃对手」时会给出动作建议（与 UI 声称的「只支持单挑」不符）
```

引擎门面（probe4 攻击 11）：

```
  2 名活跃对手（UTG 开池 + HJ 跟注）
     期望活跃对手=2 实际=2  范围只针对=枪口位（组合 294）
     动作=CALL 可执行=true 分类=CLEAR 置信度=0.3000 底池=750 权益=0.58845 所需=0.2105
  3 名活跃对手（UTG 开池 + HJ/CO 跟注）
     动作=FOLD 可执行=false 分类=INSUFFICIENT_INFORMATION 置信度=0.0000
```

**分析**

- 引擎阈值 `MULTIWAY_REFUSE_THRESHOLD = 3` 是有意设计（`decisionEngine.ts` 注释解释了为什么从 2 改成 3），但其注释同时写着「有 2 个对手时……`checkSufficiency` 会要求范围可信度**更高**才给建议，并在诊断里注明当前是近似处理」。**代码里没有这条逻辑**：`checkSufficiency` 对 2 名对手的唯一判据仍是 `MIN_RANGE_CONFIDENCE = 0.15`，与单挑完全一致，诊断里也没有「多人池近似」这项。
- `contextBuilder` 只把 `opponents[0]` 交给 `buildRangeSnapshot`，第二名对手的**行动历史完全不参与范围构建**（第二个对手跟注了 3BB 这一信息被丢弃），权益按单挑计算。所以「不会只分析其中一位来假装单挑」这句话在 2 名对手时**并不成立**。
- UI 的已知限制文案与引擎阈值不一致：界面告诉用户「多人池会返回信息不足」，实际 2 人池会给建议。

**影响**

用户在 3 人底池（1 人开池 + 1 人跟注 + 自己）下会拿到一个**基于单挑权益引擎、且忽略跟注者行动**的建议，同时界面文案让他相信这种情况本来就会被拒绝，因此他不会怀疑这个建议。

---

## 4. MINOR 发现

### F-07 · `bigBlindBB` 是死字段

- **最小复现**：`scripts/rt-alpha-probe7.ts` → 「攻击 3E」

```
  bigBlindBB=1      CALL@200     VM=2.00BB（200 筹码）       FOLD,CALL,RAISE,ALL_IN
      pot=450 callCost=200 stack=9900 eff=9700 spr=21.555555555555557
      potOdds=0.3076923076923077 reqEq=0.3076923076923077 bigBlind=100
  bigBlindBB=2      … 完全相同的全部字段 …
  bigBlindBB=10     … 完全相同的全部字段 …
  bigBlindBB=100    … 完全相同的全部字段 …
  bigBlindBB=0.01   … 完全相同的全部字段 …
  不同 math 取值数 = 1
  结论：bigBlindBB 对输出**完全无效**（死字段）
```

`manualInput.ts:451` 解析并校验它（0 / -1 / NaN / Infinity 都会被 `INVALID_NUMBER` 阻断），但 `reconstruct.ts:160` 硬编码 `const bigBlindChips = 100;` 并按 `effectiveStackBB * 100` 换算 —— `bigBlindBB` 从未被读取。文档（`manualInput.ts:215`）却说它「用于把 BB 单位换算成筹码单位」。

**影响**：界面/调用方以为自己在指定盲注级别，实际没有任何效果；若将来有人依据这个字段做单位换算，会出现静默的口径错误。

### F-08 · 对手全下无法录入（`ALL_IN` 语义与 `villain.stackBB` 缺省冲突）

- **最小复现**：`scripts/rt-alpha-probe3.ts` → 「攻击 2E」

```
  villain.stackBB=8        ALL_IN 不带金额 → 阻断(PARSE) INVALID_ACTION:
      第 1 条行动记录（ALL_IN）缺少合法的金额。该动作需要填「加注到的本街总额」（单位 BB）
  villain.stackBB=undefined ALL_IN 不带金额 → 阻断(PARSE)（同上）
  用户按「全下 8BB」录入（amountBB=8，未填 stackBB） → 阻断(RECONSTRUCT)
      第 1 条行动记录被规则拒绝：ISSUE.ALLIN_AMOUNT_MISMATCH。（记录内容：枪口位 ALL_IN 8BB）
  全下额恰好 100BB（= 起始筹码） → 建议 FOLD 底池=10150 callCost=10000
```

要录一个「UTG 全下 8BB」，用户必须**同时**把 `villain.stackBB` 写成 8 **且**把 `amountBB` 写成 8。只填其一必被拒绝，且错误信息不告诉他该怎么填。而 `villain.stackBB` 缺省时所有对手都是 100BB —— 因此**任何「对手筹码不足 100BB」的牌局都必须额外填一个界面之外的字段**（Web UI 里根本没有 `villain.stackBB` 输入框）。

**影响**：短筹码对手的全下（现金局最常见的局面之一）在 Web UI 上**无法录入**，用户会以为是自己填错了。

### F-09 · ViewModel 调试区的 `viewmodel` / `total` 耗时永远是 0.0 ms

- **最小复现**：`scripts/rt-alpha-probe6.ts` → 「攻击 10E」

```
     VM.debug.timing = [{"label":"parse","value":"0.0 ms"},{"label":"validate","value":"0.0 ms"},
                        {"label":"context","value":"58.0 ms"},{"label":"decide","value":"0.0 ms"}]
     pipeline timings = {"parse":0,"validate":0,"context":58,"decide":0,"viewmodel":0,"total":58}
     用管线 timings 重算 → 与管线返回是否完全一致：✘ 否
       差异字段 debug：首个不同位置 3243
         重算 …{"label":"viewmodel","value":"0.0 ms"},{"label":"total","value":"58.0 ms"}
         管线 …（无 viewmodel / total 两行）
```

**影响**：调试面板缺少「接口总耗时」（而 Web UI 顶部又用 `meta.timings` 单独显示一份），使用者无法从结果面板直接看到总耗时，也无法看到 ViewModel 构建耗时。

### F-10 · `hashManualInput` 漏字段

- **最小复现**：`scripts/rt-alpha-probe6.ts` → 「攻击 7C」

```
  基准哈希 = hbc834650
  bigBlindBB=2                               哈希相同 ✘  决策相同
  villain.stackBB=20                         哈希不同 ✔  决策不同
  villain.playerId="x"                       哈希不同 ✔  决策相同
  actionHistory[0].street=PREFLOP（显式写 street） 哈希相同 ✘  决策相同
  villains=[两个对手]（第 2 个被忽略）                  哈希相同 ✘  决策相同
```

**影响**：决策日志的 `inputHash` 无法唯一标识一手牌，做「同一输入的重复分析」去重或「输入变了吗」比对时可能误判。本轮未观察到「哈希相同但决策不同」的实例（`bigBlindBB` 恰好是死字段），但这是**偶然安全**而非设计保证。

### F-11 · 提供动态提示反而降低置信度

- **最小复现**：`scripts/rt-alpha-probe12.ts`

```
  hint=NORMAL               computed=true  state=NORMAL           conf=0.2500 → 分量 = 0.25
  hint=TILT_SIGNAL          computed=true  state=TILT_SIGNAL      conf=0.2500 → 分量 = 0.25
  hint=SIZE_ANOMALY         computed=true  state=UNKNOWN          conf=0.2500 → 分量 = 0.5
  hint=UNKNOWN              computed=true  state=UNKNOWN          conf=0.0000 → 分量 = 0.5
```

（probe1 攻击 5 的端到端结果）

```
    SIZE_ANOMALY         → BET   conf=0.2813
    NORMAL               → BET   conf=0.2344
    TILT_SIGNAL          → BET   conf=0.2344
    UNKNOWN              → BET   conf=0.3000
```

**影响**：`dynamicHint=UNKNOWN`（用户什么都不说）拿到**最高**置信度 0.3000；用户主动提供任一观察（哪怕 `NORMAL`）反而掉到 0.2344。这是因为 `evaluateDynamicBehavior` 对明确提示给出 `computed/state/confidence=0.25`，触发 `dynamicPenalty = max(0.3, 1 − 0.25×0.25) = 0.9375`，而 `UNKNOWN` 走中性 0.5、惩罚为 1。语义上说不通：**更多的信息不该让结论更不可信**。（本轮未发现它能翻转动作 —— 见 §5 攻击 5 的实测。）

---

## 4. MINOR 发现

### F-12 · 文档漂移：`CURRENT_PROJECT_STATUS.md` 与代码事实矛盾

- **严重级别**：INFO
- **实际观测值**（`CURRENT_PROJECT_STATUS.md` 原文）

```
第 16-17 行：> **数学与概率基础设施已完成并经过 4 轮独立红队；决策引擎尚不存在。**
             > 因此当前**还不能对一手真实牌局给出建议**。
第 79-83 行：| ⑧ | 决策引擎 | ⬜ **未实现** | 无 `decisionEngine.ts` |
             | ⑫ | 中文 UI | 🟡 **词条层已实现，界面未实现** | …无 Web/CLI 交互界面 |
第 136-138 行：| 手动输入解析（人数/位置/Stack/Hero Cards/Board/Action History） | ⬜ **不存在** |
              | 输出 Action + Size + Confidence + Reason | ⬜ **不存在** |
第 142 行：> **产品能力 = 0% 可端到端使用。**
```

而实际存在：`src/app/decision/decisionEngine.ts`（714 行）、`src/app/manualInput/*`（6 文件）、`src/app/webServer.ts` + `src/app/web/index.html`（完整中文表单界面），且端到端可运行（本报告所有探针都是端到端跑通的）。

`npm test` 全绿是因为 `test/projectStatus.test.ts` 的 `LAYER_EVIDENCE` 只核对「状态标记 ↔ 文件存在性」的一部分组合，未覆盖「写『未实现』但文件存在」这一方向。

**影响**：这份文件自称「单一事实来源」「有测试强制与代码一致」。实际使用者在同目录里同时看到「产品能力 0%」与「可以打开网页输入一手牌拿到建议」时，会对整个项目的可信度产生怀疑 —— 而这份文档存在的意义正是消除这种怀疑。

---

## 4.1 INFO 发现

### F-13 · `budget` 参数不控制任何计算

- **严重级别**：INFO

`alphaPipeline.ts:95` 定义 `budget?: { softMs: number; hardMs: number }`，`contextBuilder.ts:929-940` 把它写进 `context.deadlineBudget`：

```ts
const budget = input.budget ?? { softMs: 3000, hardMs: 8000 };
...
deadlineBudget: Object.freeze({ ...budget, elapsedMs: elapsed }),
```

但 `deadlineBudget` 只被 `DecisionContext` 持有，**没有任何代码读取它做中止判断**；`computeHeroEquity` 调用 `computeEquity` 时也没有传 `deadline`，因此实际生效的是 `equityPolicy.defaultDeadlineForMode(FAST)` 的内部默认值（`INTERACTIVE: softMs 3000 / hardMs 8000`）。

`scripts/rt-alpha-probe1.ts` / `probe5.ts` 的所有调用都**没有**传 `budget`，耗时仍全部正常（P95 ≤ 90ms），说明当前场景下不会触发预算逻辑 —— 因此这是「参数无效」而非「参数有害」。风险在于：调用方以为可以通过收紧 `budget` 来控制延迟，实际不会生效。

### 附：本轮实测的两个「源码级死代码」证据

```
src\app\manualInput\likelihoodModel.ts:229: export function selfCheckLikelihoodModel()   ← 除定义处外仅被探针引用
src\app\manualInput\preflopPriors.ts:627:   export function selfCheckPreflopPriors()      ← 除定义处外仅被探针引用
```

`preflopPriors.ts:166` 的注释写着「这个单调性是结构性成立的，并由 `selfCheckPreflopPriors()` **断言**」，
`likelihoodModel.ts` 的 `selfCheckLikelihoodModel` 文档写着「这两条就是『模型表达了什么』的全部内容」。
但没有任何测试或生产代码调用它们 —— **断言没有执行者**。这是 F-02 能长期存在而不被 1061 项测试发现的直接原因。

---

## 5. 逐项攻击结果（含未发现问题）

### 攻击 1 · 数学被策略层污染 —— **未发现**

`scripts/rt-alpha-probe1.ts`。环境（3）× 快速画像（11）× 动态提示（8）= 264 组合，覆盖翻牌前 / 翻牌 / 转牌 / 河牌：

```
  场景「翻牌前」成功样本: 264  失败样本: 0  不同的数学九项指纹数（应为 1）: 1
  场景「翻牌」  成功样本: 264  失败样本: 0  不同的数学九项指纹数（应为 1）: 1
  场景「转牌」  成功样本: 264  失败样本: 0  不同的数学九项指纹数（应为 1）: 1
  场景「河牌」  成功样本: 264  失败样本: 0  不同的数学九项指纹数（应为 1）: 1
```

指纹覆盖 `pot / callCost / myRemainingStack / myCommittedThisStreet / effectiveStack / spr / potOdds / requiredEquity / handCategory / handRankZh / bigBlind / street`。

**但有一个正确性疑点（未确认是否缺陷，如实记录）**：`villain.stackBB` 只影响 `effectiveStack` 与 `spr`，**不影响权益**：

```
  villain.stackBB=undefined pot=650 callCost=0 effStack=9700 spr=14.92 heroEq=0.895600
  villain.stackBB=50        pot=650 callCost=0 effStack=4700 spr=7.23  heroEq=0.895600
  villain.stackBB=5         pot=650 callCost=0 effStack=200  spr=0.31  heroEq=0.895600
```

对手只有 5BB（SPR 0.31）与 100BB（SPR 14.9）时权益完全相同。数学上权益确实与筹码无关，因此这不是错误；但**决策完全看不到 SPR 差异**（动作与尺寸都是 `BET@325`），意味着极短筹码局面下「权益足够就下注取值」的判断没有考虑对手无法跟注更多。属于策略层缺口，非数学污染。

### 攻击 2 · 非法动作输出 —— **未发现（边界穷举干净）**

`scripts/rt-alpha-probe2.ts`：216 个自建场景（翻牌前 / 翻牌 / 转牌 / 河牌 × 多牌力 × 多尺寸 × 短筹码），把引擎输出的动作与尺寸**构造成真实 `ActionCommand` 交给 `applyAction`**：

```
  场景总数: 216
  结果分布: {"OK":171,"ANALYSIS_FAILED":45}
  动作分布（仅成功执行的）: {"CALL":113,"BET":13,"FOLD":31,"CHECK":14}
  ✔ 无「输出动作无法执行」的场景
```

45 个 `ANALYSIS_FAILED` 全部是我故意构造的非法输入（重复牌、加注超筹码、全下录入语义），**无一例是「合法输入被拒」或「非法输出」**。

尺寸网格合法性：

```
  检查过的 BET/RAISE 候选数: 685
  违规数: 0        （< 最小下注 / > 剩余筹码 / < 最小加注 全为 0）
```

`deriveLegalActions` vs `applyAction` 边界等价性（36 个状态 × 7 种动作 = 252 次尝试）：

```
  检查过的状态数 = 36（每个 7 种动作尝试）
  不一致数 = 0
```

短全下关闭加注权（TDA）边界（`scripts/rt-alpha-probe11.ts`）：

```
  CO 全下到 400（最小加注到=600）→ 现在轮到 UTG
     raiseClosedFor = ["UTG"]
     engine.canRaise(UTG) = false
     **deriveLegalActions.actions = [FOLD,CALL]**     ← 正确排除了 RAISE
       FOLD   → 引擎接受 ✔
       CALL   → 引擎接受 ✔
```

**一个观察（非缺陷但值得记录）**：`callCost` 被 `requiredCallAmount` 按剩余筹码截断，而 `potOdds = callCost / (pot + callCost)`。当 Hero 筹码不足跟注额时（3BB 面对 3BB 开池），所需的 3BB 与实际投入的 2BB 不同，公式仍自洽（`probe2 攻击 2D`：`stack=3BB callCost=200 myRemainingStack=200 跟注即全下=true 动作=CALL size=200 合法=[FOLD,CALL,ALL_IN]`），但**输出动作标成 `CALL` 而非 `ALL_IN`**，语义上「跟注」实际是全下。

### 攻击 3 · 输入静默纠正 —— **未发现**

`scripts/rt-alpha-probe2.ts` → 「攻击 3」，13 个错误输入案例，**全部被阻断，无一被自动修正**：

```
  ✔ Hero 手牌与公共牌重复（翻牌 7d vs 手牌 7d）        → 阻断(VALIDATE) ISSUE.USER_CARD_ON_BOARD
  ✔ 公共牌内部重复（Ks 两次）                        → 阻断(RECONSTRUCT) HISTORY_DOES_NOT_REACH_STREET
  ✔ 街道与公共牌张数不符（说翻牌却给 0 张）             → 阻断(PARSE) CARD_COUNT_MISMATCH
  ✔ 底池声明与实际不符（填 99BB，实际 6.5BB）          → 阻断(VALIDATE) ISSUE.POT_MISMATCH
  ✔ 行动顺序错误（跳过 HJ 直接 CO 加注）               → 阻断(RECONSTRUCT) ACTION_NOT_ACTOR
  ✔ 加注额低于最小加注（3BB 开池后加到 3.5BB）          → 阻断(RECONSTRUCT) ISSUE.RAISE_BELOW_MIN
  ✔ 加注超过筹码（100BB 筹码加到 500BB）              → 阻断(RECONSTRUCT) ISSUE.BET_EXCEEDS_STACK
  ✔ 无人下注却「跟注」                              → 阻断(RECONSTRUCT) ISSUE.CALL_AMOUNT_ILLEGAL
  ✔ 过牌时却带非零金额                              → 阻断(RECONSTRUCT) ISSUE.CHECK_FACING_BET
  ✔ CALL 金额与所需不符（应 2BB 却写 5BB）            → 阻断(RECONSTRUCT) ISSUE.CALL_AMOUNT_ILLEGAL
  ✔ 盲注被写进行动历史                              → 阻断(RECONSTRUCT) ACTION_NOT_ACTOR
  ✔ 同一位置重复行动两次                            → 阻断(RECONSTRUCT) ACTION_NOT_ACTOR
  ✔ Hero 自己已弃牌却又要求建议                      → 阻断(RECONSTRUCT) HISTORY_OVERSHOOTS_STREET
```

**一个静默取整（MINOR，如实记录）**：`toChips` 用 `Math.round(amountBB * 100)`，且 `bigBlindBB` 无效（F-07），所以 `100.4BB` 与 `100BB`、`100.6BB` 分别变成 9940 / 9900 / 9960 筹码 —— 用户输入的小数被静默取整（影响极小，且已在文档中说明金额单位是 BB）。

### 攻击 4 · 信息不足却高置信 —— **部分命中，见 F-04**

零玩家数据 / 零动态数据 / 纯启发式范围下（`scripts/rt-alpha-probe3.ts`）：

```
  完全没有 villain 字段
     动作=CALL 分类=CLEAR 档位=MEDIUM_LOW 置信度=0.3000 可执行=true
     范围来源=HEURISTIC 范围可信度=0.3 组合=634 更新轨迹条数=0
     玩家标签=UNKNOWN 手数=0 中性化=true 玩家可信度=0.5
     动态 computed=true state=UNKNOWN conf=0
```

**没有出现「置信度极高」**（本轮实验中置信度恒 ≤ 0.3），但出现了「**明确决策** + 中低置信度」（F-04），这在用户视角是同一类问题的另一种表现。

另外，把快速画像从 `VERY_TIGHT` 换到 `MANIAC`，**分类、置信度、动作、范围可信度全部逐位不变**：

```
  quickProfile=VERY_TIGHT       → 分类=CLEAR 置信度=0.3000 动作=CALL 范围可信度=0.3
  quickProfile=MANIAC           → 分类=CLEAR 置信度=0.3000 动作=CALL 范围可信度=0.3
  （11 种画像全部相同）
```

用户在下拉框里选「疯子型」与选「极紧」，得到的建议与可信度完全一样 —— 这个下拉框在决策上**没有任何作用**（仅体现在诊断文本里）。这与 `QUICK_PROFILE_CONFIDENCE = 0.35` 的设计意图（「足够影响边缘决策」）不符。**本轮未确认它是否在任何场景下改变过动作** —— 至少在这 11 种画像 × 4 个场景下没有。

### 攻击 5 · 低置信动态翻转明确决策 —— **未发现**

`scripts/rt-alpha-probe1.ts` → 「攻击 5」：

```
  场景「翻牌前」动作×尺寸的不同取值数 = 1
    NORMAL → CALL size=200 | LOOSER_RECENTLY → CALL size=200 | TIGHTER_RECENTLY → CALL size=200
    AGGRESSION_UP → CALL size=200 | SIZE_ANOMALY → CALL size=200 | TILT_SIGNAL → CALL size=200
    CHASE_LOSS_SIGNAL → CALL size=200 | UNKNOWN → CALL size=200
  场景「翻牌/转牌/河牌」动作×尺寸的不同取值数 = 1（同上）
```

8 种动态提示 × 4 个场景，**动作与尺寸零变化**；只有置信度小幅变化（0.2344 ~ 0.3000）。`dynamicShadowOf` 的 `actionChanged` 恒为 `false`，`dynamicAllowedToFlip` 恒为 `false`（因为幅度来源是 `HEURISTIC`/`UNVERIFIED_MAGNITUDE`）。符合设计纪律。**未发现翻转路径**。

### 攻击 6 · 结果污染 —— **未发现**

`scripts/rt-alpha-probe1.ts` → 「攻击 6」，7 种注入方式，全部与基准指纹一致：

```
  基准指纹: {"action":"BET","classification":"MARGINAL","confidence":0.3,"math":{...,"pot":650,...},"sizeChips":325}
  多余自有属性 result/winner/heroProfit: 一致 ✔
  多余自有属性 outcome=BAD_BEAT: 一致 ✔
  原型链注入（Object.create + __proto__）: 一致 ✔
  嵌套 villain 带 result: 一致 ✔
  actionHistory 条目带 result: 一致 ✔
  Symbol 与不可枚举属性: 一致 ✔
  构造函数原型污染（Object.prototype.result）: 一致 ✔
```

经真实 HTTP 接口再验一次（`scripts/rt-alpha-probe8.ts`）：

```
  用例4（多余字段（result / winner））HTTP 200 ok=true
     动作=BET size=325
```

### 攻击 7 · 确定性 —— **未发现**

```
攻击 7D-1：不传 asOf（真实界面路径）→ 同一输入连跑 10 次
  10 次运行的不同**全量**指纹数 = 1
  10 次的权益取值 = ["0.8398"]
  10 次的动作 = ["CALL@200"]
攻击 7D-2：固定 asOf → 10 次运行的不同指纹数 = 1
攻击 7（4 场景 × 5 次）= 每个场景不同指纹数 = 1
```

换 `equitySeed`（1000..1004 / 999999）时，动作、尺寸、置信度、分类**逐位不变**，只有权益变化：

```
  场景「翻牌前」：动作集合 CALL | 尺寸集合 200 | 置信度取值 0.300000
    seed=1000 eq=0.627425 | seed=1001 eq=0.632325 | seed=1002 eq=0.636875 | seed=999999 eq=0.633300
  场景「河牌」：动作集合 CALL | 尺寸集合 1000 | 置信度取值 0.300000
    seed=1000 eq=0.902020 | … | seed=999999 eq=0.902020（河牌为精确枚举，种子无影响）
```

### 攻击 8 · 概率与统计正确性 —— **部分命中，见 F-02；其余正确**

自检：

```
  selfCheckPreflopPriors(): []
  selfCheckLikelihoodModel(): ["被动性似然应满足 junk > top（junk=0.6333 top=0.7600）"]   ← F-02
```

**加权抽样确实生效**（`scripts/rt-alpha-probe3.ts` → 「攻击 8D」）：

```
  均匀抽样权益: 0.448125
  权重偏向强范围（0.99）权益: 0.134025
  权重偏向弱范围（0.99）权益: 0.66665
```

**权益随对手范围变强而合理下降**（单调，无倒挂）：

```
  1 个顶级对子      组合数= 1 权益=0.0721
  2 个顶级对子      组合数= 2 权益=0.1875
  3 个顶级对子      组合数= 3 权益=0.2672
  纯垃圾            组合数= 6 权益=0.6719
  垃圾 + 1 个顶级对子 组合数= 7 权益=0.5768
  垃圾 + 3 个顶级对子 组合数=12 权益=0.4527
  AKo vs {AA,KK} 权益: 0.125     AKo vs {72o,32o} 权益: 0.671925（合理）
```

**非法权重被 Fail-Closed 处理**：

```
  负权重      → THROW simulateMonteCarlo: 第 0 位对手出现非法权重（-1）
  NaN 权重    → THROW simulateMonteCarlo: 第 0 位对手出现非法权重（NaN）
  全部 0 权重  → THROW simulateMonteCarlo: 第 0 位对手的全部权重为 0 —— 范围已空，不得静默退化为均匀抽样
  长度短一位   → cannotCompute ISSUE.EQUITY_NOT_COMPUTABLE（权重数 11 与组合数 12 不一致）
  含 Infinity → THROW simulateMonteCarlo: 第 0 位对手出现非法权重（Infinity）
```

（注：抛异常发生在**没有** `.ok` 包装的深层函数里。`contextBuilder` 只传合法的、来自 `range.entries` 的权重，因此端到端不可达；但库级使用者会拿到异常而非 `{ok:false}`，与 `equity.ts` 的「算不了就说算不了」铁律不完全一致 —— 属 INFO 级观察。）

**位置档位单调性**（`preflopPriors` 自检覆盖的 5 档）：

```
  6人桌 UTG  tier=EARLY         权重和=33.20 非零类别=52/169
  6人桌 HJ   tier=MIDDLE        权重和=47.30 非零类别=75/169
  6人桌 CO   tier=LATE          权重和=68.95 非零类别=92/169
  6人桌 BTN  tier=BUTTON        权重和=84.20 非零类别=110/169
  6人桌 SB   tier=SMALL_BLIND   权重和=48.00 非零类别=82/169
  6人桌 BB   tier=BUTTON        权重和=84.20 非零类别=110/169   ← 见 F-03
```

### 攻击 9 · 性能 —— **未发现超线性 / 卡死**

`scripts/rt-alpha-probe5.ts` → 「攻击 9」（30 次采样，预热后）：

```
  翻牌前: n=30 P50=62.6ms P95=89.9ms MAX=92.7ms MIN=57.0ms
     阶段耗时 = {"parse":0,"validate":1,"context":61,"decide":0,"viewmodel":0,"total":62}
  翻牌:   n=30 P50=56.4ms P95=86.0ms MAX=86.4ms MIN=53.7ms
  转牌:   n=30 P50=35.9ms P95=42.3ms MAX=47.8ms MIN=30.6ms
  河牌:   n=30 P50=5.8ms  P95=7.4ms  MAX=7.5ms  MIN=5.5ms
```

**远优于 1–3 秒目标**（P95 最大 89.9ms）。耗时几乎全在 `context`（范围 + 权益）。

极端筹码：

```
  翻牌前 effectiveStackBB=100     开池=3BB   97.2ms → CALL 权益来源=MONTE_CARLO
  翻牌前 effectiveStackBB=1000    开池=3BB  106.0ms → CALL 权益来源=MONTE_CARLO
  翻牌前 effectiveStackBB=100000  开池=3BB   78.8ms → CALL 权益来源=MONTE_CARLO
  翻牌有效筹码 1e12BB                         0.3ms → 阻断（我的场景构造不完整）
```

**未发现超线性或卡死路径**。所有病态输入都在毫秒级返回结构化结果。

### 攻击 10 · UI 与引擎一致性 —— **除 F-05 / F-09 外未发现问题**

排除耗时字段后，HTTP 与引擎**逐字段一致**（`scripts/rt-alpha-probe9.ts`）：

```
  翻牌：viewModel（去耗时）逐字段一致 = ✔
     HTTP decision  == 引擎精简 decision：✔
  河牌：viewModel（去耗时）逐字段一致 = ✔
     HTTP decision  == 引擎精简 decision：✔
```

动作与尺寸映射正确：

```
  翻牌: 引擎 action=BET size=325 → VM actionZh="建议：下注" sizeZh="3.25BB（325 筹码）" ✔
  河牌: 引擎 action=CALL size=1000 → VM actionZh="建议：跟注" sizeZh="10.0BB（1000 筹码）" ✔
  翻牌前: 引擎 action=CALL size=200 → VM actionZh="建议：跟注" sizeZh="2.00BB（200 筹码）" ✔
```

`ViewModel.debug.math` 与引擎 `math` 逐项对照正确：

```
  引擎：pot=650 callCost=0 stack=9700 eff=9700 spr=14.923 potOdds=0 reqEq=0 eq=0.8956 ev=null
    底池 = 650 筹码（6.50BB）      我的剩余筹码 = 9700 筹码（97.0BB）
    有效筹码 = 9700 筹码（97.0BB）  SPR = 14.92
    底池赔率 = 0.0%                所需权益 = 0.0%
    估计权益 = 89.6%               权益来源 = 蒙特卡洛（20,000 次，±0.4%）
```

协议层健壮性：

```
  用例3（重复牌）HTTP 200 ok=false stage=VALIDATE
  用例4（缺少 input / null / 字符串）HTTP 400 ok=false stage=REQUEST MISSING_INPUT
  用例4（完全空的 input 对象）HTTP 200 ok=false stage=PARSE（逐字段中文报错）
  用例5（坏 JSON）HTTP 400 {"ok":false,"stage":"REQUEST","issues":[{"code":"BAD_JSON",...}]}
  用例6 GET /            HTTP 200 content-type=text/html; charset=utf-8
  用例6 GET /api/health  HTTP 200 content-type=application/json; charset=utf-8
  用例6 GET /api/nope    HTTP 404 content-type=application/json; charset=utf-8
```

### 攻击 11 · 多人池退化 —— **命中，见 F-06**

```
  1 名活跃对手：activeOpponentCount=1 动作=CALL 可执行=true
  2 名活跃对手：activeOpponentCount=2 动作=CALL 可执行=true   ← 只分析 opponents[0]
  3 名活跃对手：activeOpponentCount=3 动作=FOLD 可执行=false 分类=INSUFFICIENT_INFORMATION
```

3 名及以上**确实明确拒绝**（`MULTIWAY_NOT_SUPPORTED` 文案正确：「**不会**只分析其中一位来假装单挑」）。2 名时虽未「偷偷退化」为主动单挑，但**只构建了一位对手的范围、丢弃了第二位对手的行动**，且 UI 文案声称只支持单挑 —— 见 F-06。

### 攻击 12 · 新改动回归 —— **未发现**

`rebuildPendingQueue`（`scripts/rt-alpha-probe5.ts` → 「攻击 12A」）8 个场景全部正确：

```
  场景1 UTG 弃牌：队列=[HJ,CO,BTN,SB,BB] 应轮到=HJ 实际=HJ
  场景2 UTG/HJ 弃牌：队列=[CO,BTN,SB,BB] 应轮到=CO 实际=CO
  场景3 BTN 加注到 3BB：队列=[SB,BB] 应轮到=SB；SB 弃牌后队列=[BB] 应轮到=BB
  场景4 UTG 开池/BTN 3bet：队列=[SB,BB,UTG]；SB/BB 弃牌后队列=[UTG]；UTG 弃牌后 phase=COMPLETE winners=["seat_BTN"]
  场景5 BTN 短全下到 1200：队列=[SB,BB,UTG]
  场景6 全员溜入到 BB：队列=[BB] 应轮到=BB（大盲选择权保留）；BB 过牌后 bettingRoundComplete=true
  场景7 全员弃牌：phase=COMPLETE winners=["seat_BB"]
  场景8 推进到翻牌：队列=[SB,BB,UTG,HJ,CO,BTN]（postflop 从 SB 开始正确）
```

加权抽样向后兼容（`scripts/rt-alpha-probe5.ts` → 「攻击 12B/C」）：

```
  seed=1         无权重=0.6911616162 全1权重=0.6911616162 逐位相等=✔
  seed=42        无权重=0.6911616162 全1权重=0.6911616162 逐位相等=✔
  seed=20260913  无权重=0.6911616162 全1权重=0.6911616162 逐位相等=✔
  seed=999999    无权重=0.6911616162 全1权重=0.6911616162 逐位相等=✔

  死牌过滤后权重同步：含被过滤组合的加权结果 = 手动对齐过滤后 = 0.651515 → 逐位相同 ✔（权重同步正确）
```

---

## 6. 无法确认的事项（明确声明「未确认」）

1. **快速画像是否在任何场景下改变过动作** —— 未确认。11 种画像 × 4 个场景下全部不变。需要更大规模的场景扫描才能断言「完全无效」。
2. **`villain.stackBB` 导致 SPR 从 0.31 变到 14.9 而决策不变，是否属于缺陷** —— 未确认。数学上权益与筹码无关是正确行为；但决策层完全不看 SPR 是否可接受，取决于设计意图。
3. **`equityMonteCarlo` 对非法权重抛异常（而非返回 `{ok:false}`）是否会在未来的调用方中暴露** —— 未确认。当前 `contextBuilder` 只传合法权重，端到端不可达。
4. **`likelihoodModel` 的档位错配在端到端权益上的净影响幅度** —— 未确认。它被 `rangeUpdate` 的归一化部分吸收，我没有做「修好档位后权益变化多少」的对照实验（那需要修改 `src/`，被禁止）。
5. **`grep` 结果为「除定义处外无引用」，是源码级证据；我没有检查构建产物或运行时动态调用** —— 但本项目无构建步骤（`--experimental-strip-types` 直接跑 TS），因此判定为死代码。

---

## 7. 结论

```
# Alpha 独立红队：FAIL
```

### 必须修的阻塞项

| 阻塞项 | 为什么阻塞 |
|---|---|
| **F-01** 面对下注时 `RAISE` 不可达 | 决策空间缺 1/3。AA 面对 3bet 建议「跟注」、三条面对下注建议「跟注」。这是**会直接亏钱**的系统性漏洞，且当前所有测试（含烟测）都把它当成正常输出。必须在 `pickCandidate` 的场景 1 里加入加注分支（或在无弃牌率依据时明确输出「跟注/加注均为候选，请人工判断」而不是默认跟注）。 |
| **F-02** 似然模型自检失败 + 零测试覆盖 | 范围更新的方向性错误，且**自检函数从未被调用**，1061 项测试中没有一项能发现它。必须修 `tierOfRankClassIndex` 的档位边界（对子不参与百分比切分），并把 `selfCheckLikelihoodModel()` / `selfCheckPreflopPriors()` 接入测试。 |
| **F-03** 3bet/4bet 对手范围用开池范围 | 权益虚高 27.5 个百分点，直接把「弃牌」翻成「跟注」。与 F-01 叠加会放大损失。必须为 3bet/4bet 建立独立档位（或至少在缺少数据时**拒绝**而不是套用开池范围）。 |
| **F-04** 「明确决策」+「中低置信度」被大量输出 | 使用者会把启发式结论当成可靠结论执行，与「信息不足时要敢说不知道」的项目纪律直接冲突。要么让 `classifyOf` 参考置信度，要么在界面上明确「明确决策 ≠ 高置信」。 |
| **F-05** 信息不足时 `decision.action='FOLD'` | 机器可读字段与真实语义**相反**，且已经流到 Web 响应与 JSONL 日志。必须改成 `null` / `'NONE'`（并同步 `DecisionLogEntry` 类型）。 |
| **F-06** UI 声称单挑、引擎分析 2 人池且忽略第二名对手 | 界面文案与引擎行为矛盾，使用者会基于未建模的底池做决策。要么把阈值调回 2 并在诊断里如实标注近似，要么修正 UI 文案并明确「只对第一位对手建模」。 |
