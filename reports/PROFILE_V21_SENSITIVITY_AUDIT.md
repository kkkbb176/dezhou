# PROFILE V2.1 — 画像敏感度与决策影响审计

**裁决：`V2.1 PROFILE SENSITIVITY & DECISION IMPACT — PASS_WITH_WARNINGS`**

```text
ALPHA_DECISION_MODEL_VERSION = 1.0.5（**未升**，理由见 §19）
画像影响分类（本轮实测）      = TRIVIAL
max |equityDelta|            = 1.3748pp   （与 max |bluffMassDelta| 3.1761pp **同一行**）
MATERIAL 阈值（**未改动**）   = equityMaterial 0.02 / massMaterial 0.05
action flip                  = 0 / 1260（0.00%）
sizing change                = 0（本夹具是面对下注，没有下注决策点）
NEUTRAL_PARITY（48 格）      = PASS（**本轮重新实测**，最大绝对差 0）
Profile Dominance 违规        = 0 / 11
本轮修的缺陷                  = 4（D6 去重闸门 / D7 非法数值穿透 / D8 残缺画像 / materiality 非有限输入）
```

> ⚠️ **本报告的一切数字都是本轮实测**，不是从上轮报告抄的。
> 上一轮的 V2 报告数字（1772 项、equityDelta 0.0180、bluffMassDelta 0.0422、
> 48/48 未重测）在 §1 逐条核实，**其中三项被证伪或修正**。

**报告结构说明**：**仓库里不存在 V2.1 的原始 20 节报告要求**（全仓搜索 `V2.1` 只命中
「河牌一致性 V2.1」，与本任务无关 —— 见 §1.6）。因此本报告**自建**覆盖任务书全部条款的结构，
并在此**明确披露**没有沿用任何旧的结构要求。

---

## 1. 交接基线核实

### 1.1 逐条核实结果

| 交接声明 | 核实方式 | 结论 |
|---|---|---|
| `ALPHA_DECISION_MODEL_VERSION = 1.0.5` | 读 `src/domain/decision/decision.types.ts` | ✅ **成立** |
| `npm run verify` 通过，1778 tests / 137 suites / fail 0 | 本轮实跑（`logs/v21-verify-baseline.txt`） | ⚠️ **部分成立**：1778 / 137 **对**；**fail 0 不成立**（本轮 fail 1，另一份既有日志 fail 4） |
| `PROFILE_MATERIALITY = TRIVIAL` | 本轮实测 | ✅ **成立**（且幅度比上轮更小，见 §7） |
| `equityDelta = 0.0180`、`bluffMassDelta = 0.0422` | 本轮重算 | ⚠️ **上轮数字**：本轮在**同一条 A/B 对比**（03A CALLING_STATION vs 03B MANIAC）上复现出 `+1.80pp / +4.22pp`（§7.2）—— 数字本身可复现，但它**不是**本轮扫描出的最大值 |
| MATERIAL 阈值 `equityDelta ≥ 0.02 或 bluffMassDelta ≥ 0.05` | 读 `MATERIALITY_THRESHOLDS` | ✅ **成立**，且**本轮未改**（§7.4） |
| `NEUTRAL_PARITY` 的 48/48 来自此前 V2，本轮未重测 | 本轮重跑 `scripts/v2-unified-likelihood-probe.ts` | ✅ 该声明**诚实**；本轮**已重测**（§5） |
| 工作区有大量修改及未跟踪文件，没有提交 | `git status` | ✅ **成立**（26 已修改 + 139 未跟踪；`HEAD = c3391ef`） |
| V2.1 尚未开始 | 读 `CURRENT_PROJECT_STATUS.md` / reports 目录 | ⚠️ **当时成立但已过时**：工作区里存在上一会话的
`reports/PROFILE_V21_SMALL_SCALE_AUDIT.md`（12 场景小规模验证，裁决 `PASS_WITH_WARNINGS`，画像影响 `TRIVIAL`、equityDelta 0.0135 / bluffMassDelta 0.0316），其页首**自己声明**「未做 1260 组合全量矩阵、未做五 Agent 审查、未做 20 节长报告」⇒ 与本轮**不重叠**，本轮予以保留并作为**独立交叉核对源** |

**注**：`AGENTS.md` **在仓库里不存在**（`docs/` 下也没有）—— 任务书要求先读它，实际**无法读到**。
可读到的等价权威文档是 `CURRENT_PROJECT_STATUS.md`（自述为「项目阶段状态的唯一权威来源」）、
`docs/ARCHITECTURE.md`、`reports/V2_ARCHITECTURE.md`、`reports/MURPHY_RISK_REGISTER.md`、
`reports/PLAYER_PROFILE_QUANTIFICATION_V{1,2}_REPORT.md`。**这是本轮的一个交接缺口，如实登记。**

### 1.2 同一份报告为什么会同时出现 `M` 和 `??`

**核实结论**：**不存在**「同一份报告既是 `M` 又是 `??`」这件事。`git status --porcelain` 的分类是互斥的：

```text
 M <path>   = 该文件**被 Git 跟踪**，内容与 HEAD 不同
?? <path>   = 该文件**没有被跟踪**，Git 完全不知道它
```

交接里说「工作区有大量修改及未跟踪文件」指的是**两个不同的集合**，
而在本轮的实际状态里这两个集合**没有任何交集**（已用 `scripts/v21-repro-state.ts` 逐文件核对：

```text
已修改（tracked）：26
未跟踪：           139
其中本轮 V2.1 新增：80
接手前就有的既有工作：59
```

真正容易造成「同一份报告出现两次」错觉的是**报告与它的证据文件分属不同集合**：
例如 `reports/PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md` 是 `??`（未跟踪），
而 `reports/PLAYER_REDTEAM_AUDIT.md` 是 tracked（在 manifest 里）。
**完整可复现清单与每个文件的 sha256 见 `reports/evidence/v21-repro-state.txt`。**

### 1.3 `137 suites` 与 `85→86` 分别代表什么（**单位必须说清**）

`node --test` 的输出有三个**不同单位**，把它们混起来就会出现「137 套件 vs 86 文件」这种困惑：

| 数字 | 单位 | 实测依据 |
|---|---|---|
| **1778** | **测试用例数**（`test(...)` 调用被执行到的条数，含 `describe` 内的子测试） | 全量运行输出的 `ℹ tests 1778` |
| **137** | **suite 数** = `describe(...)` 分组的个数 | 本轮实测：`node --test test/profileV2Metrics.test.ts` → `tests 6 / suites 0`（该文件有 6 个 `test()`、0 个 `describe()`）⇒ **suite ≠ 文件** |
| **86** | **测试文件数**（磁盘上 `test/**/*.test.ts` 的个数） | `test/projectStatus.test.ts` 的断言对象（`readdirSync('test').filter(f => f.endsWith('.test.ts'))`）= 86 |

因此 **86 ≠ 137 ≠ 1778**，三者都对，只是单位不同。
**`85→86` 的含义**：磁盘上多了一个 `.test.ts` 文件（`test/reportVerdictConsistency.test.ts`），
它恰好贡献 **6 个用例**，因此 `1772 → 1778`。这与 `CURRENT_PROJECT_STATUS.md` 的
`1,778 项 / 137 套件 / 86 个测试文件` **一致**；而
`reports/PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md:13` 的 `tests 1772` 是**旧值**
（该报告写完 24 秒后才出现那个测试文件）。

### 1.4 哪些文件属于现有交付 / 其他工作 / UNKNOWN

| 分类 | 数量 | 判据 |
|---|---|---|
| **现有交付（tracked 已修改）** | 26 | 与 `HEAD` 有差异；其中 **5 个是本轮 V2.1 修的缺陷**（见 §8），其余 21 个是**既有工作**（未动） |
| **既有工作（未跟踪）** | 59 | 未跟踪且**不属于本轮 V2.1 前缀**（`reports/V21_*` / `reports/PROFILE_V21_*` / `reports/evidence/v21-*` / `scripts/v21-*`） |
| **本轮 V2.1 新增（未跟踪）** | 80 | 上述前缀 |
| **UNKNOWN** | 1 | `reports/PROFILE_V21_SMALL_SCALE_AUDIT.md` —— 文件名不符合本轮前缀，但**内容属于 V2.1 画像审计**（见 §1.1 末行）。它的作者是**上一会话**，本轮**未修改**它，也**不把它算作本轮交付** |

### 1.5 当前 HEAD、工作区差异、未跟踪文件是否纳入验证

```text
HEAD      = c3391ef19942b568784562057c65b508b9e2aaef
HEAD 提交 = cache keys: 黄金向量 + 规范化序列化 + 碰撞防线（CACHE KEY GOLDEN VECTOR — PASS）
```

- **已修改的 tracked 文件**：`npm run verify` 会同时覆盖 `src/**` 与 `test/**`（typecheck 的
  `include` 是 `["src/**/*.ts","test/**/*.ts","tools/**/*.ts"]`；测试用 glob `test/**/*.test.ts`）
  ⇒ **26 个已修改文件全部在验证范围内**。
- **未跟踪文件**：`test/**` 下的 12 个未跟踪 `*.test.ts` **在验证范围内**
  （glob 不区分是否被 Git 跟踪）；`src/**` 下的未跟踪模块（`behaviorProfile.ts`、
  `tendencyProvider.ts`、`betResponse.ts` 等）**也在范围内**（被 `src/**` 的 import 图覆盖）。
- **不在范围内的**：`scripts/**`（`tsconfig` 的 `include` 不含它 ⇒ **只被 `manifest:check` 覆盖**，
  而 manifest 是**白名单**）、`reports/**`（同上）、`GTOopen/**`（刻意排除）。
  ⇒ **本轮的测量脚本（`scripts/v21-*.ts`）不在 typecheck 覆盖下**，
  因此它们各自带运行期自检（见 §18.3）。

### 1.6 V2.1 原始任务要求是否存在

```text
全仓搜索 "V2.1"（含 src / test / docs / reports / *.md）：
  CURRENT_PROJECT_STATUS.md:349        「河牌一致性 V2.1」（**旧轮次**）
  CURRENT_PROJECT_STATUS.md:1119       §10.0.12 河牌一致性 V2.1
  reports/RIVER_CONSISTENCY_V2_1_REPORT.md:1
  src/app/web/webServer.ts:948         注释引用「RIVER CONSISTENCY V2.1」
  src/viewmodels/decisionViewModel.ts:387,477
  test/layeredPotDecision.test.ts:439,444
  test/riverConsistencyV21.test.ts:2
⇒ **没有任何**「画像敏感度 / 决策影响审计 V2.1」的 20 节要求
```

**披露**：本报告的 20 节结构是本轮**自建**的，覆盖任务书全部条款；
没有沿用任何仓库内的旧结构，也没有据此声称「符合原定 20 节要求」。

### 1.7 「未提交状态」不得称为干净 Git 基线

本轮**不使用**「干净 Git 基线」这个说法，改用：

> **可复现的文件状态**：`HEAD = c3391ef` + 26 个已修改文件的逐个 sha256 + 139 个未跟踪文件的逐个 sha256
> （`reports/evidence/v21-repro-state.txt`，由 `scripts/v21-repro-state.ts` 生成，可重跑复现）。

⚠️ 生成该清单的脚本**不能自己 spawn `git`**：本环境的沙箱不允许进程用**管道**捕获另一个程序的输出
（Node `child_process` 默认 `stdio: 'pipe'` 会失败）。这是**环境事实**，不是缺陷；
因此改为「shell 落盘 `git status` → 脚本读文件」，结果同样可复现。

---

## 2. 审计边界（本轮自我约束）

| 禁止项 | 本轮的遵守方式 |
|---|---|
| 修改 materiality 阈值来改变结论 | ✅ 未改（§7.4 给出前后哈希一致的证据） |
| 用四舍五入后的展示值参与判定 | ✅ 判定一律用**未舍入**原始值；且**逐行**判定，不做 `base+delta` 重建（§7.5） |
| 挑选最容易 action flip 的场景冒充总体结果 | ✅ 报告 max 时同时给出 p50/p95 与**同一固定牌局**这一限制（§7.3） |
| 把动作变化等同于决策改善 | ✅ 本轮 **0 个 action flip**，因此不做这种等同；即使有也只在 §9.2 逐例解释「哪个中间量变了」 |
| 把模型内部 EV 上升等同于真实盈利提升 | ✅ 明确写：本报告**不**证明盈利改善（§16） |
| 将旧结果写成本轮实测 | ✅ 每个数字标来源；重测的标「重测」，引用的标「引用」 |

**确实发现代码缺陷 ⇒ 做了最小必要修复**（4 项，§8），并保存了**修复前后证据**。
**参数调优与缺陷修复分开报告**：本轮**没有任何参数调优**（未改权重、未改阈值、未改公式常数）。

---

## 3. 指标含义核实：`profile → range → equity/behavior → decision` 的真实链路

> 本节由**独立核查者**完成，完整报告见 `reports/V21_PRODUCTION_CHAIN_VERIFICATION.md`
> （含每一个 `file:line`）。以下是要点。

### 3.1 真实入口（三个，都可达）

| 入口 | 携带画像的字段 | 说明 |
|---|---|---|
| `analyzeManualHand(input, options)`（`src/app/alphaPipeline.ts`） | `villain.quickProfile`、`villain.behaviorProfile` | **生产主入口**；`alphaPipeline.ts:1034-1053` 把两者转发给 `contextBuilder` |
| `buildDecisionContext(input)`（`src/app/manualInput/contextBuilder.ts`） | `quickProfile`、`behaviorProfile`、`villainProfile`、`seatProfiles`、`dynamicHint` | 直接调用入口；`villainProfile`（实测画像字段）**全仓零调用者 ⇒ 生产上是死通道** |
| HTTP / 牌桌 UI | 只有 `quickProfile`（单值字符串） | `/api/analyze` 与牌桌页都只能给标签；`tableAdapter.ts:227-240` 把首个对手的位置当 `villain.playerId` |

### 3.2 画像在哪里被构造

```text
contextBuilder.ts:3168-3175
  behaviorProfile = input.behaviorProfile
                 ?? (quickProfile !== undefined && quickProfile !== 'UNKNOWN'
                       ? behaviorProfileOf({ playerId: villainId, archetype: quickProfile })
                       : undefined)
```

- `quickProfile === 'UNKNOWN'` ⇒ **不构造画像**（刻意：替陌生人套原型＝编造数据）。
- `NORMAL` / `TIGHT` / `VERY_LOOSE` / `AGGRESSIVE` ⇒ **构造**画像，但它们的先验**恰等于池先验**
  ⇒ 数值上与「没有画像」**逐位相同**（在加注池上，见 §5.3）。

### 3.3 画像在哪里改变数字（唯一的生产通道）

```text
estimateUnifiedActionLikelihood（behaviorProfile.ts:650）
  ↑ 只被 contextBuilder.ts:1281 调用（**唯一生产调用点**），
    且被 `record.street === Street.RIVER && isAggressive` 锁定（contextBuilder.ts:1202）
→ likelihoodOverride（contextBuilder.ts:1291）
→ updateRange（rangeUpdate.ts:407/447）
→ 后验范围 entries.probability
→ computeHeroEquity（contextBuilder.ts:2169）→ 权益 / 底池赔率比较 / Call EV / 动作排序
→ profileClassMasses（rangeFacts.ts:203-267）→ 报告与证据
```

**第二个调用点** `behaviorProfile.ts:1057`（`reweightCombosByUnifiedLikelihood`）在 `src/` 里
**零调用者**（只有测试/探针用）。

### 3.4 画像**不能**触碰的东西（已核实）

| 量 | 画像是否影响 | 证据 |
|---|---|---|
| `requiredEquity`（所需权益） | **不** | 11/11 画像下恒为 29.79%（Profile Dominance 不变量检查） |
| 可达组合集 | **不** | `combosBefore === combosAfter === 449`（只改概率，不产生/删除组合） |
| 底池 / 筹码 / SPR / 手牌牌力 | **不** | 属「数学层绝对优先级」清单，画像只能改概率 |
| 加注 EV | **不** | 保持 `NOT_AVAILABLE`（本轮未动） |

### 3.5 🔴 `rangeDistance` 的真实含义 —— **它必须被标成 `CATEGORY_LEVEL_RANGE_DISTANCE`**

**核实结论（独立核查 + 本轮复核，双方一致）**：

1. `profileRangeDistance(a, b)` 本身（`src/domain/player/profileRangeMetrics.ts:106`）对**任意等长向量**
   都能算全变差与 JS 散度 —— **函数不限于类别级**。
2. **但生产代码里它的调用点是 0 个。** 全仓 7 处调用**全部在测试里**：

   ```text
   test/profileQuantificationGolden.test.ts:294
   test/profileV2Metrics.test.ts:194, :199, :204, :205, :209, :210
   src/ 下：0 处（只有定义）
   ```

3. **实际喂进去的向量是 5 个互不重叠的类别分量**（`test/profileQuantificationGolden.test.ts:287-293`）：

   ```text
   [ 坚果+强价值, 薄价值, 摊牌价值, 错过听牌, 纯空气 ]     （合计 ≈ 1）
   ```

   而它的来源 `profileClassMasses`（`rangeFacts.ts:203-267`）是把 **8 个类别压成这 5 个**。
4. **`medianRangeDistance` 这个名字在代码里根本不存在** —— 全仓唯一命中是
   `reports/PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md:382` 这句散文。
   也就是说 V2 报告**给它起了一个代码里没有的名字**，而真实量是**全变差 / JS 散度**。
5. **实测后果（独立核查的可复现探针 `scripts/v21-chain-distance-probe.ts`）**：

   ```text
   两张后验范围，质量在**同一类别内部**从 A 组合搬到 B 组合：
     类别级 profileRangeDistance = { totalVariation: 0,        jsDivergence: 0 }
     组合级（对齐后的逐组合向量）  = { totalVariation: 0.5,      jsDivergence: 0.2200241522709298 }
   正对照（质量跨类别搬动）：类别级 TV = 0.25、JS = 0.0487949406953985
   十进制权重下类别级 TV = 5.55e-17（1 ULP，不是精确 0），JS = −9.6e-17
   ```

   ⇒ **它确实无法识别同类别内部的组合变化**。
6. **逐组合的后验向量今天拿不到**：`RangeSnapshot`（`decision.types.ts:514-554`）**没有 `entries`**；
   `Range.entries` 从不离开 `contextBuilder`；`opponentRangeFacts` 只暴露聚合量；
   `RangeMetrics` 只有标量。`range.ts:378/388` 的 `probabilityByRankClass` /
   `rawWeightByRankClass` **全仓零调用者**。
7. **⚠️ 更要紧的一件事**：在本夹具里 `TV ≡ |ΔbluffMass|`（代数上被迫相等）——
   独立核查实测 `0.04216817393165691` vs `0.04216817393165682`（差 1e-16）。
   原因是两个分布质量和都是 1，而画像**只**改诈唬类 ⇒ 另外三个分量逐位不变。
   ⇒ **不得把 `rangeDistance` 当作「第二个独立证据」来加强结论。**

**本轮处置（按要求明确标识，但**不**做全仓重命名）**：

- 新增/修改的**代码注释**（`profileRangeMetrics.ts` 头部、`rangeFacts.ts` 的 `profileClassMasses`）
  写明该量的量纲是 `CATEGORY_LEVEL_RANGE_DISTANCE`；
- 本报告与 `reports/evidence/v21-summary.md` 里一律写作
  **「类别级 rangeDistance（TV，`CATEGORY_LEVEL_RANGE_DISTANCE` / `RANGE_DISTANCE_PROXY`）」**；
- **测试名称**：不改（`§二十三 profileRangeDistance：相同 ⇒ 0、不相交 ⇒ 1、且对称有界`
  这条测的是**函数性质**，对逐组合向量同样成立，名字没有说谎）；
- **UI 展示**：全仓**没有任何 UI 展示这个量**（`profileRangeDistance` 零个 `src/` 调用者，
  `profileClassMasses` 也零个 `src/` 消费者）⇒ **没有需要改的展示**。
- **不做全仓重命名**：`profileRangeDistance` 被 2 个测试文件、2 个脚本引用，
  改名是纯风险而无正确性收益（函数本身对逐组合向量也正确）。

---

## 4. V2 三项架构债的核实与登记

**仓库里已有风险清单** = `reports/MURPHY_RISK_REGISTER.md`（按 A–K 分类）。
它**没有**「画像量化 V2 / V2.1」条目，也**没有**通用「架构债」章节
（grep `画像` / `profile` 在其中的命中全是别的主题）。
⇒ 本轮**新建** `reports/V21_RISK_REGISTER.md` 作为 V2.1 的登记处，**不向外部平台发帖**。

| V2 报告的限制 | 本轮核实 | 现状 |
|---|---|---|
| **债务 1**：`medianRangeDistance` 只在类级别度量，不是逐组合分布距离 | 见 §3.5：**函数不限类别级，但调用点确实只有类别级**；且**该名字代码里不存在** | **仍然成立**（已加 `CATEGORY_LEVEL_RANGE_DISTANCE` 标识） |
| **债务 2**：`THIN_VALUE` 对原型画像零条件化 | 实测：`thinValueBet` 不在 `ARCHETYPE_BEHAVIOR_PRIORS` 的任何一个原型里（`behaviorProfile.ts:191-266`），03A/03B 的 cond **都恰好 1.000000**，trace 里 `factor=1.000000 rate=0.35` | **仍然成立**（= `V21_RISK_REGISTER.md` 的 **D2**） |
| **债务 3**：§三十六 跨街层级 fallback / §二十四 环境分档 / §二十三 历史库接入 未实现 | 三条**逐条核实**：① `estimateUnifiedActionLikelihood` 只有一个生产调用点且被「河牌 + 进攻」锁定；② `ENVIRONMENT_BEHAVIOR_PRIOR` 是**单个扁平 6 元常量**，`behaviorProfileOf` **从不接收 environment**；③ **没有任何画像持久化 / 历史库**，`observed` 没有生产产出者 | **三条全部仍然成立**（= **D3**，其中第③条升级为 **D4**，见下） |

**额外登记（本轮新发现，V2 报告未列）**：
**D4** —— 生产链上**没有任何入口**能把实测手牌历史喂给画像。
`handsPlayed`（`seatLifecycle.ts:1239`）只自增、**不进入任何画像/统计**；
牌桌 API 只有 `SET_PROFILE`（单值标签）；`src/` 里**没有任何代码**传 `observed:`。
⇒ `CURRENT_PROJECT_STATUS.md` §5.0 的「有实测数据时优先」在当前代码上**不可达**。

---

## 5. `NEUTRAL_PARITY` 本轮重测

### 5.1 函数层（48 格网格）

**本轮实际执行** `node --experimental-strip-types scripts/v2-unified-likelihood-probe.ts`：

```text
⇒ 网格单元数 48（3 尺寸 × 8 类别 × 2 前序线）
⇒ 最大绝对差 0
⇒ NEUTRAL_PARITY = PASS（逐位相等，无需容差）
⇒ 发生钳位的 (类别, 画像)：无（0 个）
⇒ 池先验自检：6 个条目 rate === env ⇒ cond 恰为 1
```

⇒ **本轮重新测量，不是引用旧结果**。与独立审查者各自重跑的结果一致。

### 5.2 全生产入口（本轮新增的更强检查）

用 `analyzeManualHand`（**不是**似然函数）对同一手牌跑 `UNKNOWN` / `NORMAL` / 不给画像：

```text
权益      0.5625883726719894  （三者逐位相同，Δ = 0.000e+0）
诈唬质量  0.018421440058874042
动作      CALL
```

⇒ 在**本场景（S1 / 加注池）**上，`UNKNOWN == NORMAL == 不给`。

### 5.3 🔴 **但这句话不能推广**（独立审查 FALSIFY，本轮如实登记）

在**跛入池**上（本轮自己的 S7 夹具逐字复现）：

```text
UNKNOWN = 0.07845850542399040
NORMAL  = 0.07872806694852144     Δ = 2.695615e-4
（同座位/同手牌/同牌面的加注池对照：Δ = 0）
```

**机制**：`quickProfileToLimperArchetype('NORMAL')` 给出**带 0.35 可信度**的跛入原型，
而 `UNKNOWN` 的可信度为 0 ⇒ `limpIsolation.effectiveTraits` 的混合方式不同。

⇒ 因此本报告与本轮生成的 `reports/evidence/v21-summary.md` 都**限定**：
`NEUTRAL_PARITY` 只在**加注池**上逐位成立。
上一会话的 `reports/PROFILE_V21_SMALL_SCALE_AUDIT.md:11`
（「不给 == UNKNOWN == NORMAL == 零手实测，逐位相同」）**已被本轮数据证伪**，见 §17。

---

## 6. 1260 组合敏感度矩阵

### 6.1 档位定义 —— **仓库里没有，本轮自定并披露**

> 🔴 **全仓搜索确认：不存在 V2.1 的原始档位定义**（§1.6）。
> 因此下表是本轮**自定**的，**不声称沿用旧方案**。

| 维度 | 档数 | 取值 | 选择理由 | 局限 |
|---|---|---|---|---|
| **样本量** | 7 | 机会数 `0 / 2 / 5 / 20 / 50 / 200 / 1000` | 覆盖收缩公式 `(π·6+s)/(6+n)` 的三个区制（n≪6 / n≈6 / n≫6）、`SampleTier` 的 30/200 两个阈值、以及 n=0 的「无观测」边界 | `SampleTier` **本身不被画像路径读取**（读它的是 `playerClassifier` / `archetypeDimensions`，且用的是 `effectiveSampleSize`）——「覆盖阈值」只意味着机会数**跨越**了那两个数值，**不**意味着画像路径在这两个点上换挡（它不换挡，见 §12.4） |
| **玩家类型** | 9 | `VERY_TIGHT` / `LOOSE` / `CALLING_STATION` / `UNDERBLUFFER` / `BLUFF_HEAVY`（**有先验**）+ `UNKNOWN` / `NORMAL` / `TIGHT` / `AGGRESSIVE`（**刻意中性**） | 正好是 `ARCHETYPE_BEHAVIOR_PRIORS` 的键（6 个）与 `NEUTRAL_ARCHETYPES` 的键（5 个）中最有决策意义的部分 | 🔴 **`MANIAC` 与 `VERY_LOOSE` 不在主矩阵里**（独立统计审查 C5 指出）。因此**另跑 280 行补充矩阵**（§6.4） |
| **偏离程度** | 5 | `VERY_LOW/LOW/MEDIUM/HIGH/VERY_HIGH` = **实测生效值** `0.05 / 0.20 / 0.45 / 0.65 / 0.80` | 生产入口自己的刻度（`manualReadEvidence`），比率由探针**逐档实测**确认（`effectiveRate` 分别等于上述五值） | 人工通道**上限是 0.80**；`0.95` 只能经 `observed` 达到 ⇒ 0.95 单列为「极端探针」（§10.3），**不进这张表** |
| **当前证据强度** | 4 | `E0` 只有标签先验 / `E1` 人工读（强）/ `E2` 人工读（弱）/ `E3` 实测重申（带机会数） | `behaviorProfileOf` 四级来源（标签先验 / 人工 / 实测）的可达组合 | 🔴 **E2 整块被 E1 包含**（E2 的比率 {0.20,0.45,0.65} ⊂ E1 的 {0.05,0.20,0.45,0.65,0.80}）⇒ **E2 不增加新测量**；`E3` 的 N0 档与 `E0` **逐位相同**（没有观测时实测通道等于不存在）。这是**忠实覆盖**，不是 bug，但报告必须说明（§7.3） |

### 6.2 矩阵实测结果

```text
组合数               = 1260（实际行数 1260）
可分析               = 1260 / 1260（失败 0）
不同权益值个数        = 267
不同动作             = CALL（**只有一个**）
整行耗时之和          = 778.4 s（含每行额外一次 buildDecisionContext）
```

**中性对照（所有 Δ 的分母）**：

```text
NORMAL / E0 / N0（无观测）      权益 56.2588%  诈唬质量 1.8421%  跟注EV 12.442  动作 CALL  组合数 449
UNKNOWN / E0 / N0（无画像）     同上，**逐位相同**
```

### 6.3 需求要求的四项区分（本轮逐项落实）

| 要求 | 本轮实现 |
|---|---|
| **总手数 vs 某项行为的有效机会数** | 矩阵里唯一的样本量维度是 `riverBluff` 这一个条目的**机会数**，不是总手数；`StatEvidence` 的字段名就是 `opportunities`，`noteZh` 写「实测 s/n」 |
| **无观察记录 vs 观察到零次** | **代码与实测都分开**：`opportunities === 0` ⇒ 不传 `observed` ⇒ `observedRate === null`、`effectiveRate` **逐位等于先验**（`behaviorProfile.ts:115-118`）；`{successes: 0, opportunities: 5}` ⇒ `observedRate = 0`、后验被真的拉低。独立审查验证 135/135 组合逐位成立 |
| **玩家类型标签 vs 实际行为证据** | 矩阵的「玩家类型」轴只填 `archetype`（标签），「证据强度」轴才填 `manual` / `observed`。**没有把标签当成实测**：`StatSource` 明确区分 `PROFILE_PRIOR` / `MANUAL_USER_INPUT` / `OBSERVED_HAND_HISTORY`，且 `manual` 的 noteZh 写「主观判断，非实测」 |
| **历史证据 vs 当前牌局证据** | 本轮的「历史证据」= `observed`（跨手统计，带机会数）；「当前牌局证据」= 行动历史（`actionHistory`）驱动的似然更新。**两者在代码里是两个不同的量**（`traits` vs `applyLikelihoodUpdates`），且在河牌进攻动作上 **provider 被抑制**以避免重复计票（§8.1） |

**同一牌局的画像对照必须使用相同计算设置** —— 已落实（`OPTIONS` 常量，见 §18.1）：
`asOf` / `equitySeed` 固定、`budget` 宽裕（避免 `equityPolicy` 因负载换型）、`writeLog: false`。
**含随机采样的部分固定了可复现种子**，且本轮实测**该路径根本不采样**（§12.5）。

### 6.4 补充矩阵（`MANIAC` / `VERY_LOOSE`）

```text
280 行（2 档 × 5 偏离 × 4 证据强度 × 7 档）—— 全部可分析
```

补上这两档之后，**11 个标签里 11 个都被测过**（主矩阵 9 + 补充 2）。

### 6.5 单调性核查（**本轮实测**）

**(a) 偏离程度 ↑ ⇒ 诈唬质量 ↑**（同一档 N0、证据强度 E1）：

| 原型 | 4.8% | 20% | 45% | 65% | 80% | 单调 |
|---|---|---|---|---|---|---|
| `VERY_TIGHT` | 1.195% | 1.411% | 1.668% | 1.914% | 2.213% | ✅ |
| `NORMAL` | 1.535% | 1.756% | 2.019% | 2.270% | 2.575% | ✅ |
| `MANIAC` | 4.042% | 4.436% | 4.903% | 5.348% | 5.885% | ✅ |
| `BLUFF_HEAVY` | 3.376% | 3.726% | 4.142% | 4.539% | 5.018% | ✅ |

> ⚠️ 在 **E0（只有标签先验）**下这一行**必然恒定** —— 标签先验不使用人工读，
> 所以那里「单调」无从谈起。第一版汇总脚本误用 E0，把「未测」印成了
> 「❌ 不单调」（独立统计审查 C5 指出，已修）。

**(b) 机会数 ↑ ⇒ 越靠近实测**（E3 列，偏离 0.80）：

| 原型 | N0 | N2 | N20 | N200 | N1000 |
|---|---|---|---|---|---|
| `VERY_TIGHT` | 55.98% | 56.08% | 56.24% | 56.35% | 56.37% |
| `NORMAL` | 56.26% | 56.34% | 56.47% | 56.57% | 56.58% |
| `MANIAC` | 57.61% | 57.73% | 57.88% | 57.98% | 58.00% |
| `BLUFF_HEAVY` | 57.24% | 57.36% | 57.50% | 57.61% | 57.63% |

**全部单调递增，且逐渐逼近各自的「纯实测」极限** —— 与收缩公式的数学预期一致。
（E0 列**完全不随机会数变化**，因为 E0 根本不使用机会数。）

---

## 7. 合理输入范围内的最大影响（**核心数字**）

### 7.1 本轮实测最大值（分母 = 1260 行，全部相对中性对照）

| 量 | min | **p50（典型）** | p95 | **max** | mean |
|---|---|---|---|---|---|
| `equityDelta`（pp） | −0.5728 | **−0.0354** | 0.9840 | **1.3748** | 0.0105 |
| `bluffMassDelta`（pp） | −1.2041 | **−0.0335** | 2.3000 | **3.1761** | 0.0785 |
| 类别级 `rangeDistance`（TV） | 0.0000 | 0.0052 | 0.0230 | 0.0318 | 0.0071 |

```text
max |equityDelta|    = 1.3748pp  @ BLUFF_HEAVY / E1 人工读(强) / N0 无观测 / 人工读 0.80
max |bluffMassDelta| = 3.1761pp  @ **同一行**
⇒ 两者是**同一次实测**的组合，不是两个独立归约拼起来的
```

**⚠️ 必须与这些数字一起读的三件事**：

1. **典型值比最大值小两个数量级**：p50 是 **−0.0354pp**（权益）/ **−0.0335pp**（质量）。
   拿 max 当「画像的典型影响」是错的。
2. **1260 行只有 305 次不同调用 / 267 个不同结果**（独立统计审查逐一验证：
   多重性直方图 `232×1, 19×2, 18×7, 9×14, 18×21, 9×40 = 1260`）。
   因此 max 是**描述性最大值**，**不是推断统计量**。
3. **全部落在同一个固定牌局上**（S1）。这不等于牌局覆盖充分 —— 覆盖见 §6.5 与 §9。

### 7.2 与 V2 报告数字的关系（**两个不同的比较**）

| 比较 | 本轮实测 | 说明 |
|---|---|---|
| **03A `CALLING_STATION` vs 03B `MANIAC`**（V2 §10 的 A/B 表） | 权益 55.808% vs 57.609% ⇒ **Δ = +1.80pp**；诈唬质量 0.78% vs 5.00% ⇒ **Δ = +4.22pp** | ✅ **上轮数字可复现**（本轮用真实生产入口重算，逐位吻合） |
| **本轮 1260 组合扫描的最大值** | `equityDelta` **1.3748pp** / `bluffMassDelta` **3.1761pp** | 比上一项**更小**，因为 A/B 那对是**两个极端原型**，而本轮扫描包含大量接近中性的组合 |

⇒ **结论：V2 报告的 0.0180 / 0.0422 是「两个极端画像之间」的差，本轮把它放进了 1260 组合的分布里，
最大值反而更小。** 这不是矛盾，是两个不同的分母。

### 7.3 明确分母、单位、场景范围、噪声处理

| 指标 | 单位 | 分母 | 场景范围 | 噪声处理 |
|---|---|---|---|---|
| `equityDelta` | 比例（报告 ×100 = pp） | 差值，无分母 | S1 固定牌局（1260 行）+ 8 场景语料 | 权益是**精确枚举**（§12.5），SE = 0；固定种子 |
| `bluffMassDelta` | 概率质量（**未归一化的绝对质量，分母恒为 1**） | 见下注 | 同上 | 确定性，无采样 |
| 类别级 `rangeDistance` | TV ∈ [0,1] | 5 个类别分量（**类别级**） | 同上 | 确定性 |
| 对手弃牌/跟注/加注概率 | 概率 | 响应模型对该尺寸分类的**可达组合质量** | §10.2 | **蒙特卡洛 6000 次/桶**（SE ≈ 0.65pp/桶）⚠️ |
| `sizingChange` | BB 与 % 底池 | 下注前底池 | §10 | 确定性 |

> 🔴 **`bluffMass` 的分母必须写准**（独立统计审查 C6 纠正）：
> `bluffMass = missedDrawMass + pureAirMass`（`rangeFacts.ts:256`）是
> **绝对概率质量，分母恒为 1**；只有 `unclassifiedMassShare`（`:257`）除以了 `totalMass`。
> 本夹具里 `totalMass = 1.0000000000000047` 且 `Σp(整个范围)` 与它**差恰好 0**
> （`reachableRangeCount = supportSize = 449` ⇒ 没有任何质量落在死牌上，那句排除是纯防御），
> 因此两者在本夹具上数值相同 —— **但公式上它们不是一回事**。

### 7.4 阈值**未被修改**的证据

```text
MATERIALITY_THRESHOLDS = {"equityTrivial":0.005,"equityMaterial":0.02,"equityStrong":0.05,
                          "massTrivial":0.01,"massMaterial":0.05}
```

本轮**没有**编辑 `MATERIALITY_THRESHOLDS` 的任何一项（`behaviorProfile.ts` 的该段未在 diff 中）。
判定依据只有：
`|equityDelta| 0.0137 < equityMaterial 0.02` **且** `|bluffMassDelta| 0.0318 < massMaterial 0.05`
⇒ `TRIVIAL`。

### 7.5 判定**不使用舍入值、不做重建**（本轮修正了自己的一个方法缺陷）

第一版汇总与敏感度脚本把「max |equityDelta|」与「max |bluffMassDelta|」**两个独立归约**
拼成一对，再用 `neutral + delta` **重建**那个值。两处都错（独立数值审查 C4）：

1. 那个组合**不对应任何一行实测**；
2. `base + delta − base !== delta`（实测在 43/45 权益探针上不成立，最大偏差 **15 ULP**）
   ⇒ 重建值可能**跨过阈值**，判定就不是实测值的判定。

**已改**：`profileMaterialityOf` 现在**逐行**用该行**原始**值调用一次，取最强判定。

```text
逐行判定分布（分母 = 1260 行）：TRIVIAL 1260（100.0%）
最强判定 = TRIVIAL
```

**「最大合理变化」的合理输入边界**（不得把极端非法输入当成果）：

```text
✅ 计入：真实的玩家类型标签（11 个全部枚举）、人工读的 5 档（生产刻度）、
        实测机会数 0…1000、以及「标签 + 与之矛盾的证据」这一类真实冲突（§9.4）
❌ 不计入：非法数值（NaN / Infinity / 负数 / successes > opportunities）
          —— 这些在本轮修复后**已被信任边界阻断**（§8.2）
❌ 不计入：改牌 / 改底池 / 改位置 / 改筹码 —— 那些是**不同的牌局**，不是画像变化
```

---

## 8. 本轮修复的缺陷（**最小必要修复 + 前后证据**）

> **参数调优与缺陷修复分开报告**：以下是**缺陷修复**。
> 本轮**没有任何参数调优** —— 未改任何权重、阈值、公式常数。
> 修复前后证据：`reports/evidence/v21-defect-evidence-before.txt` /
> `-after.txt`（`scripts/v21-defect-evidence.ts before|after`）。

### 8.1 D6 · 画像去重闸门读**代理指标**（严重度最高）

**缺陷**：`postflopAdvisor` 的「防止画像被计两次」闸门读
`context.profileRangeEvidence?.provider.applied === true`。
**这个量不等于「画像改了范围」**，三处会误判为 `false`：

| 通道 | `provider.applied` | 范围真的变了吗 |
|---|---|---|
| 河牌统一似然通道 | **`false`**（该通道上 provider 被 `suppressProvider` 主动抑制） | **是** |
| 跛入原型通道 | **`false`**（不经过 provider） | **是** |
| 画像挂在**非首要对手**身上 | 证据对象**整个缺失** | **是** |

**实测后果**（由独立核查者与失败模式审计各自复现）：

```text
A 洞：villain=seat_CO（画像不在首要对手上）
       profileRangeEvidence 缺失 ⇒ rangeLayerApplied=false
       doubleCountBlocked=false、bluffCatchDelta=+0.0350、deDuplicated=false
       权益已被画像推动 +0.3892pp
       对照 villain=seat_UTG：doubleCountBlocked=true、bluffCatchDelta=0.0000
B 洞：跛入池，Hero 翻牌先行动 ⇒ provider 从未被调用
       MANIAC：权益 74.3675% → 73.4875%（Δ −0.8800pp），bluffCatchDelta=+0.0350
       NORMAL：Δ −0.5925pp ⇒ **证伪** contextBuilder.ts:769 的
               「applied === false 表示范围逐位不变」
```

**修复**：新增**事实字段** `DecisionContext.profileAppliedToRange`，
在 `buildRangeSnapshot` 里数出「统一似然真正被施加的动作数」（`profileLikelihoodActions`），
与 provider、跛入通道一起归约；两处闸门改读它。
同时把证据对象从 `realizedOpponents[0]` 改为**按 `villainId` 定位被画像描述的那一家**。

### 8.2 D7 · 非法数值穿透 / D8 · 残缺画像把整手牌打挂

见 `reports/V21_RISK_REGISTER.md` §D7/D8 的完整前后对照表。摘要：

| | 修前 | 修后 |
|---|---|---|
| `observed {successes: NaN}` | 权益 **67.5071%**（对照 56.2588%，**+11.25pp**）、callEV 17.728、**无 warning** | `PARSE` 阶段 `INVALID_NUMBER` 阻断，字段路径到 `...traits.riverBluff.successes` |
| `traits = {}` | `CONTEXT_BUILD_FAILED`（**整手牌不可分析**） | 权益 56.2000%（缺失条目**回落池先验**） |
| `profileMaterialityOf(equityB = Infinity)` | **STRONG**（"权益差 Infinitypp"） | `NO_EFFECT` + 「**无法判定**」 |

### 8.3 未修但已登记（本轮审计边界之外）

`callTooWide` 死条目、`THIN_VALUE` 槽位数、跛入池中性不一致、实测历史不可达、
人工读与标签先验之间无收缩、尺寸档死边界、两条「回归锁」锁不住画像 ——
全部带 `file:line` 与实测数字登记在 `reports/V21_RISK_REGISTER.md`（D9–D17）。
**明确不动**：`rangeCounter`、GTO、Raise EV、`handEval` / 底池赔率 / 所需权益 /
SPR / combo 数学 / 权益公式 / EV 公式。

---

## 9. 牌局覆盖

### 9.1 8 个场景（每个都先写「我的位置」）

| 场景 | **我的位置** | 我的手牌 | 公共牌 | 街 | 底池 | 有效筹码 | 决策类型 | 底池结构 | 桌型 | 结果 |
|---|---|---|---|---|---|---|---|---|---|---|
| `S1` | **CO** | A♣J♥ | A♦8♠4♠2♣K♦ | 河牌 | 19.5BB | 100BB | 抓诈唬 | 加注池 | 9-max | ✅ |
| `S2` | **BB** | K♥Q♥ | K♣9♠5♦2♥7♣ | 河牌 | 19.5BB | 100BB | 抓诈唬 | 加注池 | 9-max | ✅ |
| `S3` | **BB** | A♠Q♠ | Q♦J♥4♥6♣ | 转牌 | 22BB | 100BB | 面对下注 | 加注池 | 9-max | ✅ |
| `S4` | **CO** | A♣J♥ | A♦8♠4♠ | 翻牌 | 5BB | 100BB | **价值下注** | 加注池 | 9-max | ✅ |
| `S5` | **BB** | K♠Q♠ | K♦8♣3♥2♦7♠ | 河牌 | 19.5BB | 100BB | 抓诈唬（**超池**） | 加注池 | 9-max | ✅ |
| `S6` | **BB** | A♠K♠ | K♥7♦2♣J♠ | 转牌 | 40.5BB | 100BB | 面对下注 | **3Bet 池** | 9-max | ✅ |
| `S7` | **BB** | 9♥9♣ | Q♠8♦3♣6♠K♠ | 河牌 | 13BB | 100BB | 抓诈唬 | **溜入池** | 6-max | ✅ |
| `S8` | **BB** | A♣J♥ | A♦8♠4♠2♣K♦ | 河牌 | 19.5BB | 100BB | — | — | **7-max** | ❌ **UNSUPPORTED** |

**行动过程**（逐字见 `scripts/v21-profile-sensitivity-audit.ts` 的 `S1`–`S8` 常量）：

```text
S1（黄金夹具，V2 §17 同源）
  我的位置 CO，A♣J♥，9-max 100BB
  UTG/UTG1/UTG2/LJ/HJ 弃 → CO 开池 2.5 → BTN/SB 弃 → BB 跟 1.5
  翻牌 A♦8♠4♠：BB 过 · CO 下 2（33% 池）· BB 跟
  转牌 2♣：BB 过 · **CO 过牌让牌**
  河牌 K♦：BB 下 7（**75% 池，LARGE**）→ 我决策
S2  CO 开 2.5 → BB 跟 → 翻 BB 过/CO 下 2/BB 跟 → 转 BB 过/CO 下 5.5/BB 跟
    → 河 BB 过/CO 下 7.5 → 我（BB）决策
S3  CO 开 2.5 → BB 跟 → 翻 BB 过/CO 下 4/BB 跟 → 转 BB 过/CO 下 7 → 我决策
S4  CO 开 2.5 → BB 跟 → 翻 BB 过 → 我（CO）决策（价值下注面）
S5  同 S1 的前三街（转牌 CO 过牌让牌）→ 河 BB 下 30（**154% 池，OVERBET**）→ 我决策
S6  CO 开 2.5 → BTN 3Bet 到 9 → BB 跟 8 → CO 弃
    → 翻 BB 过/BTN 下 13.5/BB 跟 → 转 BB 过/BTN 下 20 → 我决策（40.5BB 池）
S7  6-max：UTG 跟 1 → HJ 弃 → CO 跟 1 → BTN/SB 弃 → BB 过
    → 翻 BB 过/UTG 过/CO 下 2/BB 跟/UTG 跟
    → 转 BB 过/UTG 过/CO 下 4/BB 跟/UTG 弃
    → 河 BB 过/CO 下 6 → 我决策
S8  同 S1，但桌型填 7 → **被拒**（UNSUPPORTED，见 §9.3）
```

### 9.2 覆盖矩阵与缺口

| 维度 | 覆盖 | 缺口 |
|---|---|---|
| 街 | 翻牌（S4）、转牌（S3/S6）、河牌（S1/S2/S5/S7） | — |
| 决策类型 | 价值下注（S4）、抓诈唬（S1/S2/S5/S7）、面对下注（S3/S6） | 🔴 **纯诈唬（Hero 主动诈唬）没有独立场景** —— S4 是价值下注面；**本轮如实标注为未覆盖** |
| 位置 | CO（S1/S4）、BB（S2/S3/S5/S6/S7）、多人池（S7 三家） | 🔴 **BTN / SB / UTG 作为 Hero 未覆盖** |
| 底池结构 | 加注池（5 个）、**3Bet 池**（S6）、**溜入池**（S7） | 4Bet 池 / 全下底池未覆盖 |
| 尺寸档 | SMALL/MEDIUM（S1 的 36% 实测为 MEDIUM 侧）、LARGE（S1 75%）、OVERBET（S5 154%） | — |
| 桌型 | 9-max、6-max | 4/5/8-max 未覆盖（引擎支持 4/5/6/8/9） |

### 9.3 `UNSUPPORTED` 标注

`S8`（7 人桌）被引擎**明确拒绝**（`INVALID_TABLE_SIZE`：桌型只能是 6 或 9），
并按位置逐条报出 `POSITION_NOT_AT_TABLE`。**这是正确行为**（项目纪律：不支持的结构必须拒绝而不是近似顶替）。
⇒ 本报告中该场景一律标 **UNSUPPORTED**，不计入任何统计。

### 9.4 🔴 **1260 组合 ≠ 牌局覆盖充分**

```text
1260 行 = 305 次不同调用 / 267 个不同结果，**全部在 S1 这一个牌局上**
```

因此本报告把「画像影响的幅度」与「牌局覆盖」**分开陈述**：
矩阵回答「同一局面下画像能撬动多少」，语料回答「不同局面下画像往哪个方向动」。

---

## 10. 至少 12 项决策影响指标

> 完整原始数据：`reports/evidence/v21-decision-impact.json`（11 个画像探针 × 全部指标）
> 与 `reports/evidence/v21-profile-sensitivity.json`（1260 + 280 + 64 行）。
> 汇总表：`reports/evidence/v21-summary.md`。

### 10.1 指标 1 / 2 / 3 / 7 / 8（权益、质量、距离、EqVsCall、EV）

以中性对照（`NORMAL`，无观测）为基线，S1 局面：

| 画像探针 | 动作 | 权益 | eqΔ | 诈唬质量Δ | **EqVsCallΔ** | 跟注 EVΔ | 类别级 TV |
|---|---|---|---|---|---|---|---|
| `NORMAL`（对照） | CALL | 56.2588% | 0.0000pp | 0.0000pp | 26.4688pp | 0.00000 | 0.00000 |
| `UNKNOWN`（无画像） | CALL | 56.2588% | 0.0000pp | 0.0000pp | 26.4688pp | 0.00000 | 0.00000 |
| `CALLING_STATION` 标签 | CALL | 55.7739% | **−0.4849pp** | **−1.0881pp** | 25.9839pp | −0.22790 | 0.01088 |
| `UNDERBLUFFER` 标签 | CALL | 55.7548% | **−0.5040pp** | −1.1310pp | 25.9648pp | −0.23688 | 0.01131 |
| `MANIAC` 标签 | CALL | 57.6645% | **+1.4057pp** | +3.1544pp | 27.8745pp | +0.66066 | 0.03154 |
| `MANIAC` + 实测 45/50 | CALL | 58.2128% | **+1.9540pp** | +4.3848pp | 28.4228pp | +0.91837 | 0.04385 |
| `CALLING_STATION` + 实测 5/50 | CALL | 55.7583% | −0.5005pp | −1.1232pp | 25.9683pp | −0.23524 | 0.01123 |
| `MANIAC` + 实测 **0/0** | CALL | 57.6645% | +1.4057pp | +3.1544pp | 27.8745pp | +0.66066 | 0.03154 |
| `VERY_TIGHT` + 人工 VERY_HIGH | CALL | 56.4517% | +0.1929pp | +0.4328pp | 26.6617pp | +0.09065 | 0.00746 |
| `MANIAC` + 人工 VERY_LOW | CALL | 57.2351% | +0.9763pp | +2.1908pp | 27.4451pp | +0.45885 | 0.02223 |
| **`MANIAC` + 5 条人工全 VERY_HIGH** | CALL | **44.5955%** | **−11.6633pp** | +10.9907pp | 14.8055pp | −5.48177 | 0.28516 |

（全部为 `reports/evidence/v21-decision-impact.json` 的**未舍入**值。）

> ⚠️ **不要把这行 `TAG_MANIAC` 的 +1.4057pp 与 §7.1 的矩阵最大值 1.3748pp 混为一谈**：
> 前者是「`MANIAC` 标签 + 无观测」，后者是「`BLUFF_HEAVY` + 人工读 0.80」——
> **两个不同的探针**，恰好量级接近。这也是 `TAG_MANIAC` **不在主矩阵 9 档里**（在补充矩阵里）的原因。

**`requiredEquity` 在 11/11 画像下恒为 29.79%** ⇒ 画像**没有**触碰价格（Profile Dominance 不变量成立）。

> ⚠️ 最后一行（−11.66pp）是**一条人工读同时改 5 个条目**（含 `thinValueBet`）的极端探针。
> 它**不是**「合理输入范围内的画像影响」—— 见 §10.3 关于 `thinValueBet` 的量级警告。

### 10.2 指标 4 / 5 / 6（对手弃牌 / 跟注 / 加注概率）

**🔴 必须在正确的节点上测**：在 S1 这种「面对下注」的节点，
`diagnostics.postflop.betDecision` **按构造就是 `null`**
（`postflopAdvisor.ts:550`：`if (facingBet || betDecisionFacts === null) return null`）——
因为响应模型回答的是「**我**下注后他会怎么办」，而我此时并没有下注权。

因此这两项在 **S4（我主动下注的翻牌价值面）** 上测：

| 尺寸 | 比例 | 弃牌 | 跟注 | 加注 |
|---|---|---|---|---|
| 见 `reports/evidence/v21-decision-impact.json` 的 `sizeTable` | — | — | — | — |

⚠️ **本轮的诚实局限**：`betDecision` 只在「我有下注权」时存在，
而**画像只在河牌进攻动作上生效** ⇒ 「画像 → 对手响应概率」这条因果链
在本引擎里**没有直接的耦合点**（响应模型的输入维度是
`ResponseTendencies`，而画像经范围影响权益）。
因此本轮**不声称**已测得「画像造成的弃牌/跟注/加注概率变化」——
那是**通过范围的间接影响**，且幅度被响应模型的 6000 次蒙特卡洛噪声（SE ≈ 0.65pp/桶）淹没：
**约 1pp 的两桶差在 z≈1.1，落在噪声内**（独立统计审查 C3 的算术）。
⇒ 这三项本轮标为 **NOT_MEASURED_WITH_REQUIRED_PRECISION**，并给出上表结构（`foldLikelihood` /
`callLikelihood` / `raiseLikelihood` 在 JSON 里逐尺寸可取），**不写虚假数字**。

### 10.3 指标 9（最优与次优动作的 EV 差距）

**`evGapBestSecond` 在 11/11 画像下都是 `null`**，且 `candidateEVs` 为空。
原因（**不是缺陷**）：`BET` / `RAISE` 的 EV 依赖对手弃牌率，而项目**明确拒绝编造弃牌率**
（`decisionEngine.ts:389-390`）⇒ 那些候选的 `ev` 恒为 `null`；
在「面对下注」节点上唯一可比的 EV 是 `CALL` vs `FOLD`。

⇒ 本轮**如实记录**为「该节点上不存在可比的最优/次优 EV 对」，
并在 §10.1 用 `callEV` 的**绝对差**代替该指标（这是本节点上唯一有意义的量）。

### 10.4 指标 10（action flip）

```text
翻转数 = 0 / 1260 = 0.00%
中性对照动作 = CALL；1260 行的动作**全部是 CALL**
```

⇒ **原动作 → 新动作的分布为空。** 本轮**没有**任何画像组合改变最终动作。
（独立统计审查、失败模式审计、扑克逻辑审查各自独立复现了「0/1260」。）

**同时如实说明**：扑克逻辑审查在**另一个局面**（边缘牌）上搜到了 11/11 都 FOLD 的情形，
即「画像在这两个局面里都不翻动作」。它在**人工 `thinValueBet`** 上找到了动作级影响
（权益 −33.45pp），但那是**单条目极端值**，不是标签画像。

### 10.5 指标 11（sizing change）

```text
本夹具（S1）与 8 场景语料里，`sizing` 在**所有画像**下都不存在（面对下注节点没有尺寸）
⇒ sizing change = 0，**无 BB / 底池比例可报**
```

在 S4（我主动下注）上画像**不生效**（不是河牌）⇒ 尺寸逐位不变。
**结论**：本轮**没有观测到任何下注尺度变化**，因为画像的作用域
（河牌 + 进攻）与本轮能测到尺寸的节点（翻牌 + 我下注）**不相交**。
这是**结构性缺口**，如实登记，不用「0 变化」冒充「测过没有变化」。

### 10.6 指标 12（决策稳定性：合理输入微扰）

**边界声明（必须先有边界）**：

```text
✅ 计入的微扰：下注额 ±5%（6.65 / 7.00 / 7.35 BB —— 现实录入误差量级）、
              asOf ±1 天（知识库生效时刻的录入误差）、权益种子取 3 个不同值
❌ 不计入：改牌 / 改底池 / 改位置 / 改筹码（那是**不同的牌局**）
```

| 项 | 实测 |
|---|---|
| 发生动作翻转的画像数 | **0 / 11** |
| 最大权益极差 | **0.0000pp** |
| 尺寸范围 | 不存在（本节点无尺寸） |
| 同一输入两次调用 | **11/11 逐位相同**（`JSON.stringify` 全等） |

⇒ **没有观测到异常跳变**。

---

## 11. 冲突场景与 Profile Dominance 防护

### 11.1 三个冲突场景（**逐例给实测数字**）

**冲突 1 · 历史偏跟注，但当前行动及后续尺度支持更强范围**

| 河牌下注 | 中性 | 跟注站 | 疯子 |
|---|---|---|---|
| 25% 池（4.88BB） | 权益 56.26%、诈唬 1.84%、CALL | 55.91%、1.07%、CALL | 57.02%、3.56%、CALL |
| 50% 池（9.75BB） | 56.26%、1.84%、CALL | 55.77%、0.75%、CALL | 57.66%、5.00%、CALL |
| 75% 池（14.63BB） | 56.26%、1.84%、CALL | 55.77%、0.75%、CALL | 57.66%、5.00%、CALL |
| 100% 池（19.5BB） | 56.26%、1.84%、CALL | 55.77%、0.75%、CALL | 57.66%、5.00%、CALL |
| **150% 池（29.25BB）** | 56.26%、1.84%、CALL | **55.77%、0.75%、CALL** | **57.66%、5.00%、CALL** |

**读数**：
- 超池下注**确实**是「更强范围」的证据（中性权益不变是因为中性基线不含尺寸语义；
  尺寸语义通过 `betRatio → likelihoodWeights` 进入**档位权重**，对中性画像同样生效）。
- **但画像的影响在 50% 池之后完全饱和**：从 50% 到 150%，跟注站与疯子的权益**一个字都没动**
  （55.77% / 57.66%）。原因是 `BetSizeBucketOf` 的 `LARGE` 与 `OVERBET` 在
  `estimateUnifiedActionLikelihood` 里走**同一条分支**（`big = LARGE || OVERBET`）
  ⇒ **超池与半池大注对画像条件是同一件事**。
- **冲突没有被「当前行动压过历史」硬编码解决**，而是**两者都进了**：
  历史影响诈唬端的几率比，当前尺寸影响档位权重与「大注诈唬」条目。
  **没有**「当前永远压过历史」的硬规则 —— 真实机制是**乘法叠加**。
- ⚠️ **证据不足的部分**：本场景里没法判断「画像 vs 当前证据谁更该赢」，
  因为**两边都不翻动作** ⇒ 标 **UNCERTAIN**。

**冲突 2 · 历史激进，但当前牌面/行动线削弱诈唬解释**

局面：`Kd 7s 2h 4c 9d`（干燥面），三次过牌后 CO 河牌**小注 2.5BB（13% 池）**；
Hero BB 持 K♥K♣（顶三条）。

```text
中性  ：权益 1.0（=100%，三条在干燥面 …）、诈唬质量 29.85%、动作 RAISE
疯子  ：权益 1.0、诈唬质量 29.85%、动作 RAISE     ← **与中性逐位相同**
跟注站：权益 1.0、诈唬质量 11.27%、动作 RAISE
```

**读数**：
- 🔴 **`equity = 1.0` 本身是一个必须解释的观测**：Hero 持 K♥K♣、牌面 `Kd 7s 2h 4c 9d`
  ⇒ 顶三条，而对手范围里**没有任何能赢它的组合**在引擎的档位模型下被保留 ⇒ 权益 100%。
  这是**牌局极端性**（不是画像缺陷），但**它使这个场景对画像不敏感** ⇒ 该场景**不适合**回答冲突 2。
- 可读的部分：**小注（13% 池 = SMALL 档）没有触发「大注诈唬」条目**
  ⇒ 疯子的调整只来自类别条目；跟注站的诈唬质量被压到 11.27% vs 中性 29.85%
  （差 **−18.6pp**）—— 这是**本轮见到的最大单场景质量差**，比 S1 上的 3.17pp 大 6 倍。
- **动作没变**（两边都 RAISE），因此「历史激进是否被当前牌面削弱」在**动作层**上仍是 **UNCERTAIN**。

**冲突 3 · 历史紧弱，但少量近期行为看似激进**

| 证据 | 权益 | 诈唬质量 | 动作 |
|---|---|---|---|
| 只有标签 `VERY_TIGHT` | 56.040% | 1.350% | CALL |
| + 人工读 `VERY_HIGH` | **56.452%** | **2.275%** | CALL |
| + 实测 **2/2** | 56.151% | 1.599% | CALL |
| + 实测 **30/30** | 56.532% | 2.455% | CALL |
| 基线 `UNKNOWN` | 56.259% | 1.842% | CALL |

**读数（这是三条里最有信息量的）**：
- **`2/2` 的收缩**（`(0.12×6 + 2)/(6+2) = 0.34`）把 `observedRate = 1.0` 压到 0.34
  ⇒ 权益只动 **+0.111pp**、质量动 **+0.249pp**。
  **小样本没有推翻历史标签** ✅ 这正是收缩公式的设计意图。
- **`30/30` 的收缩**是 `(0.12×6 + 30)/36 = 0.853` ⇒ 权益 +0.492pp、质量 +1.105pp。
  即使 30 次全中，**仍然没有把「极紧」标签翻过来**（0.853 < 1.0）—— 因为先验权重 6 与 30 次观测同量级。
- **动作始终 CALL**。⇒ 冲突 3 的**方向正确、幅度可控**，但**没有任何动作级后果**。

### 11.2 是否硬编码了「当前永远压过历史」/「历史样本多就永远优先」

**核实结论：都没有硬编码。** 真实机制是：

```text
likelihood = 中性校准层(既有档位权重，由**当前**动作/尺寸决定)
           × Π(几率比条件化)^(1/K)      ← 几率比里 rate 已由**收缩公式**融合了历史与当前
```

- **当前证据**（本手行动、尺寸、牌面）通过 `betRatio` / `node` / `sizeBucket` 进入**两个**位置：
  ① 档位权重曲线（中性校准层）；② 尺寸/节点条件化因子。
- **历史证据**（标签先验 / 人工读 / 实测）**只**通过 `rate` 进入几率比，而 `rate` 是收缩后的值。
- 因此「谁压过谁」是**样本量的连续函数**，不是硬编码规则：
  `effectiveRate = π + (r − π)·n/(n+6)`。

### 11.3 Profile Dominance 检查（逐项，**11/11 无违规**）

| 问题 | 检查方式 | 实测 |
|---|---|---|
| 画像是否造成**不合法范围或概率**？ | `heroEquity` / `requiredEquity` / `bluffMass` ∈ [0,1] 且有限；类别质量向量之和 ≤ 1 且无负分量 | ✅ 0 违规 |
| 是否**压过强烈反证**？ | 冲突 3 的 `2/2` / `30/30` 实测（§11.1） | ✅ 小样本**没有**推翻历史；30/30 也没翻过来 |
| 是否**改变客观事实**（牌面/阻断/筹码）？ | `combosBefore === combosAfter`（449 → 449）；`requiredEquity` 11/11 恒为 29.79%；组合集不变 | ✅ 只改概率 |
| 是否**因同一证据被多处使用而重复放大**？ | ① 同一条动作上 provider 被抑制（实测 provider calls 1980 vs 2970，差**恰好 990** = 河牌那次更新）；② 跨层去重闸门... | ⚠️ **修复前有洞（3 处），本轮已修**（§8.1）；修后闸门读事实字段 |
| **样本不足时是否仍做大幅调整**？ | `n=0` 时 `effectiveRate` **逐位等于先验**；`n=2` 的 2/2 只动 +0.111pp | ✅ 收缩生效 |

**重复计票的深入核查（独立审查）**：在同一组合内**没有**任何条目被施加两次；
但三个「进攻」条目（`riverBluff` / `missedDrawBluff` / `riverLargeBetBluff`）
**来自同一张手写表**，而代码自己声明该表「五个主动条目逐条严格单调」
⇒ 它们是**同一个标量的三个投影**，不是三个独立证据。
几何平均（K=3）把乘积 `24.781609` 压到 `2.915478`，
与「只算一次」的上界 `3.666667` 相差 20.5% —— **它抑制了放大，但没有提供独立性证据**。

---

## 12. 失败模式审计（18 项）

完整报告：`reports/V21_FAILURE_MODE_AUDIT.md`（18 行摘要表 + 每项详细章节 + 原始命令输出）。
**判定：PASS 10 / FAIL 8 / NOT_TESTED 0。**

| # | 失败模式 | 判定 | 关键实测 |
|---|---|---|---|
| 1 | 零样本 | **PASS** | `opportunities = 0` ⇒ `observedRate = null`、`effectiveRate` **逐位等于先验**（135/135 组合） |
| 2 | 极少样本 | **PASS** | `2/2` ⇒ `effectiveRate = 0.4375`（不是 1.0）；`{0,5}` ⇒ 0.08182 < 0.15 严格 |
| 3 | 缺失字段 | **FAIL** | `traits = {}` 或只给一条 ⇒ `CONTEXT_BUILD_FAILED`（**整手牌不可分析**）→ **本轮已修**（§8.2） |
| 4 | 非法数值 | **FAIL** | `successes: NaN` ⇒ 权益 **+11.25pp** 且**无 warning** → **本轮已修**（§8.2） |
| 5 | 概率边界 | **PASS** | 注入 `effectiveRate = 1.0` ⇒ 钳位 **490/990** 并**明写进轨迹**；`rateOdds` 夹取到 [0.001, 0.999] |
| 6 | 陈旧数据 | **FAIL** | `StatEvidence` **没有任何时间字段**；`asOf = 2020` 与 `2125` **逐位相同**（权益 0.5770/0.5770） |
| 7 | 重复手牌 | **FAIL** | `observed` **没有 hand-id**；同一手 ×1/×2/×10/×100 ⇒ 权益 0.5768→**0.5908**、质量 0.0515→**0.0830**、`confidence` 0.143→**0.943**（重复被读成更强证据） |
| 8 | 玩家身份混淆 | **FAIL** | `playerId = 'BB'` / `'nonsense'` ⇒ **静默等于无画像**（0.5626，无 warning）；只有 `'seat_BB'` 生效（0.5761）；画像对象自带的 `playerId` **被忽略** |
| 9 | 座位更换 | **FAIL** | `seatProfiles` 对范围/画像似然链**零影响**（`{BB:'MANIAC'}` ⇒ 0.5626 = 基线）；身份即座位（无跨手玩家实体） |
| 10 | 统计机会分母错误 | **FAIL** | `12/50`（行为机会）vs `12/1000`（总手数）⇒ `effectiveRate` 0.2443 vs 0.0136（**差 23.45×**），而 `confidence` **反而上升** 0.893→0.994（**错得更自信**） |
| 11 | 弃牌后未知手牌处理 | **PASS** | 死牌 = Hero 2 张 + 公共牌 5 张（条目 990 = C(45,2)）；弃牌者**不进分母** |
| 12 | 历史与当前证据重复计算 | **FAIL** | 多人池画像家 ≠ 首要对手 ⇒ 权益已被推动 **+3.275pp** 而 `bluffCatchDelta=0.035`、`deDuplicated=false` → **本轮已修**（§8.1） |
| 13 | 缓存未失效 | **PASS** | 全 `src/` 唯一模块级缓存是 `WEIGHT_CACHE`（键为 `rfi:/3bet:/defend:${tier}`，**不含画像**）；`rangeCache` **无生产调用者**；同进程交替画像**逐位可复现** |
| 14 | 中性画像回归 | **PASS** | `UNKNOWN == NORMAL == 不给 == 零手实测` 在**加注池**上逐位相同（0.5625883726719894）；⚠️ **跛入池上不成立**（§5.3） |
| 15 | 随机采样噪声 | **PASS（附范围）** | 河牌节点 `equitySource = EXACT / 990`，跨 7 个种子极差 **0.0000pp**；翻牌下注节点 `MONTE_CARLO / 20000`，极差 **0.72pp** > 画像效应 0.33pp ⇒ **该节点上 <0.7pp 的画像效应不可归因** |
| 16 | 下注单位混淆 | **PASS** | `bigBlindBB 2` vs `100` ⇒ 决策/SPR/所需权益/权益**逐位不变**，仅筹码 ×50 |
| 17 | 画像极端值支配 | **PASS（附警告）** | 极值只表现为**可见的钳位**与似然 > 0；支持集 449 **不变**、不塌缩；⚠️ 但 `manual thinValueBet` 极端值可动权益 **−33.45pp**（§10.1 末行） |
| 18 | 不支持的牌局结构 | **PASS** | `tableSize = 7` 被拒；7 人局（9 座 − 2）与 8 人局正常；翻前四条路径**逐位相同**（画像在翻前结构上不生效） |

**⚠️ 关于 `NOT_TESTED`**：本轮 **0 项** NOT_TESTED。
**关于凑数**：所有 FAIL 都带可复现的探针（`scripts/v21-fmaudit-*.ts`）与原始输出；
**没有**写镜像实现的无效测试。

---

## 13. 独立审查（5 个视角）

**环境支持多 Agent**（本轮实际启用了 5 个独立审查者 + 2 个专项核查者，
每个都独立读代码、独立跑探针、独立出报告）。**因此可以称「完成五个独立 Agent 审查」**，
不是「多视角自查」。

| 视角 | 报告 | 关键 CONFLICT |
|---|---|---|
| **1 统计与有效样本** | `reports/V21_REVIEW_1_STATISTICS.md` | ① 独立**逐位复现**了 1260 行（最大绝对差 0）✅；② **第 5 档偏离被错标为 0.95**（生产是 0.80）→ 已修；③ `MANUAL_READ_CONFIDENCE_CAP` **无读者**；④ 权益是 **EXACT**（比原文声称的更强），但**响应模型是 6000 次 MC**（SE ≈ 0.65pp/桶）—— 原文的「噪声已被钉住」**越界**了；⑤ **1260 行 = 305 次调用 / 267 个结果**（E2 整块被 E1 包含） |
| **2 扑克决策与剥削逻辑** | `reports/V21_REVIEW_2_POKER_LOGIC.md` | ① `callTooWide` 是**死条目**；② 画像只触及 8 个类别中的 **4 个** ⇒ **98.16% 的后验质量对画像免疫**；③ 🔴 **低端符号反了**：`VERY_TIGHT > CALLING_STATION > UNDERBLUFFER`（权益 55.975% > 55.808% > 55.715%）—— 「他不诈唬」这条轴在低端**反向**；④ **尺寸档只有 0.6 一个活边界**；⑤ 实测**没有**复现「激进原型推高价值质量」 |
| **3 生产链路 / 缓存 / 身份** | `reports/V21_REVIEW_3_PIPELINE.md` | ① **去重闸门不 airtight，两个可达的洞**（A 洞 P0 / B 洞 P1）→ 已修；② 身份绑定在 `playerId` 上 ✅；③ **无跨对手泄漏**（非画像家 range 熵逐位相同）✅；④ 缓存**无画像键** ✅；⑤ 确定性 ✅（6 画像 × 3 顺序，0 处不一致） |
| **4 数值与测试可信度** | `reports/V21_REVIEW_4_NUMERICS.md` | ① 🔴 **我的探针用正则从中文日志里取判定依据，且读错了对象 ⇒ fail-open**（恒判通过）→ 已修；② **6 条「画像回归锁」里只有 3 条能抓到画像被破坏**；`riverConsistencyV21.test.ts` **全程中性标签** ⇒ 根本不是画像锁；③ `equityTrivial`/`massTrivial` 是**死参数**（34,191 点网格零变化）；④ `NaN` 可穿透 `profileMaterialityOf` → 已修 |
| **5 反证 / 失败模式 / 报告一致性** | `reports/V21_REVIEW_5_COUNTEREVIDENCE.md` | ① 独立重测 48 格 ✅ PASS；② 🔴 **`NEUTRAL_PARITY` 在跛入池被证伪**（Δ=2.695615e-4）→ 已登记并修正措辞；③ V2 报告的 `1772` 是**旧值**（真实 1778）；④ 「fail 0」**不可复现**（两次运行 fail 1 / fail 4）；⑤ `THIN_VALUE` 的 K=2 但只有 1 个可填槽 |
| **专项 A：生产链路核实** | `reports/V21_PRODUCTION_CHAIN_VERIFICATION.md` | `profileRangeDistance` 在 `src/` 里**零调用**；`medianRangeDistance` **代码里不存在**；类别级距离实测**无法看到同类别内部变化**（0 vs 0.5） |
| **专项 B：失败模式** | `reports/V21_FAILURE_MODE_AUDIT.md` | 18 项，PASS 10 / FAIL 8 / NOT_TESTED 0 |

### 13.1 CONFLICT / EVIDENCE / RESOLUTION 汇总

| CONFLICT | EVIDENCE | RESOLUTION |
|---|---|---|
| 我的矩阵第 5 档偏离标 0.95，生产是 0.80 | 两方独立实测 `manualReadEvidence(VERY_HIGH).effectiveRate = 0.8` | **审查对**；已改用**实测值**重跑矩阵（max 由 1.9761pp 修正为 **1.3748pp**） |
| 我的 materiality 判定用了**重建的合成对** | `base+delta−base !== delta`，43/45 探针不成立 | **审查对**；已改为**逐行用原始值**判定 |
| 我的钳位检查读错对象 ⇒ **恒判通过** | `opponentRangeFacts.updateTrace` 不存在（trace 在 `context.range.updateTrace`） | **审查对**；已改为读正确路径 + **fail-closed**；修后实测 `clampCheckAvailable=true`、`钳位 0/990` |
| 去重闸门只有一个 `applied` 代理 | 三处可达反例，带数字 | **审查对**；已修（§8.1） |
| `NEUTRAL_PARITY` 可推广到全链 | 跛入池 Δ=2.695615e-4 | **审查对**；已限定适用范围 |
| 1260 组合 = 1260 份独立证据 | 305 次调用 / 267 个结果 | **审查对**；报告已如实写明 |
| V2 报告「1772 / fail 0」 | 本轮实测 1778 / fail 1 | **审查对**；已在 §1 更正 |
| 我的汇总把「未测」印成「❌ 不单调」 | E0 下偏离不影响标签先验 | **审查对**；已改用 E1 并补 MANIAC |
| `bluffMass` 的分母写错 | 公式上分母恒为 1 | **审查对**；已在 §7.3 更正 |

**⚠️ 审查者也承认没能证伪的项**：1260 行逐位复现（差 0）、收缩公式（315/315 逐位）、
48 格 NEUTRAL_PARITY、缓存无画像键、无跨对手泄漏、确定性、`RiverComboClass.MEDIUM_VALUE` 确实不可达。

---

## 14. 画像支配与重复计算 —— 结论

| 问题 | 结论 |
|---|---|
| 发现画像支配了吗？ | ❌ **没有**（11/11 无违规；`requiredEquity` 不随画像变；组合集不变；无非法概率） |
| 发现重复计算了吗？ | ✅ **发现 3 处可达的重复消费**（§8.1 的 A/B 洞 + 多人池），**本轮已修** |
| 修复后还有残留吗？ | ⚠️ 有：① 独立审查**没能构造出「重复计票导致最终动作翻转」的用例** —— 已证明的是「同一份范围证据被消费两次」；② 画像对象自带的 `playerId` **从不与 `villainId` 比对**（D13） |
| 同一组合内有条目被施加两次吗？ | ❌ **没有**（独立审查逐 combo 追踪确认） |
| 那三个进攻条目算重复吗？ | ⚠️ **是同一个标量的三个投影**（同一张声明单调的手写表）⇒ 几何平均抑制了放大（24.78 → 2.92），但**不提供独立性证据** |

---

## 15. 历史画像数据是否适合进入决策

**结论：目前不适合 —— 因为「历史画像数据」根本没有生产入口。**

| 层 | 现状 |
|---|---|
| **数据结构** | ✅ 已完整：`StatEvidence` 带 `opportunities` / `successes` / `unknownOutcomeOpportunities`，收缩公式正确（315/315 逐位验证），`n=0` 与「观测到 0」严格分开 |
| **统计正确性** | ✅ 收缩、单调、有界、小样本保护都通过 |
| **进入决策的通道** | ✅ 存在且可复现：`observed → effectiveRate → 几率比 → 统一似然 → 范围 → 权益 → 决策` |
| 🔴 **生产入口** | ❌ **不存在**。`handsPlayed` 只自增不入统计；牌桌 API 只有 `SET_PROFILE`（单值标签）；`src/` 里**没有任何代码**传 `observed:` ⇒ **整个 7 档样本量轴需要手工构造画像对象才能到达**（= D4） |
| ⚠️ 其他缺口 | 无时间字段（陈旧数据无设防，D6）、无 hand-id（重复手牌无设防，D7）、无**行为专属**机会分母校验（用了总手数会差 23.45×，D10） |

⇒ **诚实的说法**：**统计模型已经准备好接收历史数据，但产品还没有把数据接进来。**
在接入之前，「历史画像数据是否适合进入决策」这个问题的答案是
**「模型层面适合（有收缩保护），工程层面不可达」**。

---

## 16. 哪些结果只证明「链路存在」，哪些支持「决策合理性」

| 只证明链路存在 | 支持决策合理性 |
|---|---|
| 画像能被构造并注入（11/11 探针都改变了范围/质量） | 收缩公式的数学性质（`n=0` 逐位回先验、`2/2` 不变成 100%、单调、有界）—— **315/315 逐位独立复现** |
| `NEUTRAL_PARITY`（中性画像 == 无画像） | 冲突 3 的方向：小样本**没有**推翻历史标签、30/30 也没翻过来 |
| `profileRangeDistance` 能算出距离 | 响应模型的**尺寸单调性**（注越大 ⇒ 弃牌↑、跟注↓、加注↓、Hero 权益↓）—— 独立审查逐档实测，**方向全部正确** |
| 组合集不变（只改概率） | `TURN_CHECK_BACK` 节点方向正确（独立审查**未能证伪**，且扑克论证一致） |
| Profile Dominance 无违规 | 画像**没有**触碰价格（`requiredEquity` 恒定）与客观事实 |

### 🔴 **本轮明确不证明的事**

1. **不证明盈利改善。** 所有 EV 都是**未计抽水**的模型内 EV；`BET`/`RAISE` 的 EV **恒为 `null`**
   （项目拒绝编造弃牌率）。「模型内 EV 上升」**不等于**「真实盈利提升」。
2. **不证明动作会变好。** 本轮 **0 个 action flip** ⇒ 没有「新动作更好」的证据；
   而没有变化也**不等于**「画像无用」（可能是这里没有边缘局面）。
3. **不证明画像的幅度足够。** 这是 `TRIVIAL`，且最大行占阈值 0.69×（权益）/ 0.64×（质量）。
4. **不证明牌局覆盖充分。** 1260 行全在**一个**牌局上；§9.2 列了 3 个未覆盖维度。

---

## 17. 仍无法证明的内容与未解决风险

| # | 无法证明 / 未解决 | 为什么 | 风险 |
|---|---|---|---|
| 1 | **跛入池上「中性」不中性** | `NORMAL` vs `UNKNOWN` Δ=2.695615e-4；机制清楚但**未修**（会改变跛入池数值，需要独立回归轮） | 中：报告/界面说「中性不改变结果」在跛入池上是错的 |
| 2 | `THIN_VALUE` 的 K=2 但只有 1 个可填槽 | 指数恒为 1/2 ⇒ 唯一薄价值通道被永久开平方 | 低-中：薄价值方向的幅度被系统性压低 |
| 3 | `callTooWide` 是死条目 | 无生产读者 | 中：`CALLING_STATION` 的**定义性**条目无效 |
| 4 | 低端符号反向（`VERY_TIGHT` > `CALLING_STATION` > `UNDERBLUFFER`） | `VERY_TIGHT` 缺 `riverLargeBetBluff` / `probeAfterTurnCheckBack` 先验，回落池先验 | **中-高**：这是「confidently wrong sign」，且落在用户最常用的两个标签上 |
| 5 | 尺寸档 4 档只有 1 个活边界 | SMALL≡MEDIUM、LARGE≡OVERBET 逐位相同 | 低-中：参数化的 4 档是错觉 |
| 6 | 画像在**翻前完全无效** | `behaviorProfile` 只被河牌进攻动作消费 | 中：与「画像」这个名字给人的期望不符，且**界面没有说明** |
| 7 | 98.16% 的后验质量对画像免疫 | 画像只触及 4/8 类别 | 中：幅度小的**结构性**原因，不是「权重调小」 |
| 8 | 没有动作翻转 ⇒ 无法区分「画像无用」与「此处无边缘局面」 | 单牌局 | 中 |
| 9 | 纯诈唬 / BTN·SB·UTG 位置 / 4·5·8-max 未覆盖 | 语料缺口 | 中 |
| 10 | 重复计票是否会导致动作翻转 | 未构造出用例 | 低（已修闸门，但影响面未完全量化） |
| 11 | 实测历史数据不可达 | 产品缺口（D4） | **高**：`CURRENT_PROJECT_STATUS.md` 的「有实测数据时优先」当前是空话 |
| 12 | 两条回归锁锁不住画像 | `riverConsistencyV21` 全程中性；`reportVerdictConsistency` 硬编码 | 中：覆盖度被高估 |

**未解决的环境事实**（不是缺陷，但必须记录）：
`node --test` 全量运行有**4 个负载相关的时间断言**会偶发失败（§18.5）；
沙箱不允许 Node 用管道捕获子进程输出（因此 `scripts/v21-repro-state.ts` 改成读 shell 落盘文件）。

---

## 18. 可复现性、脚本与噪声处理

### 18.1 固定设置（**同一牌局的画像对照必须使用相同计算设置**）

```text
asOf      = 1_757_000_000_000        （固定：时间衰减/知识库版本不随运行时刻变）
equitySeed= 20260913                 （固定：若回落到蒙特卡洛，两侧同种子）
budget    = { softMs: 120_000, hardMs: 240_000 }   （宽裕：避免 equityPolicy 因负载换型）
writeLog  = false                    （无副作用文件）
rules     = loadKnowledgeBaseOrThrow().allRules()  （同一份知识库）
```

### 18.2 可复现脚本清单（全部是**本轮交付**）

| 脚本 | 作用 |
|---|---|
| `scripts/v21-profile-sensitivity-audit.ts` | 1260 组合矩阵 + 280 行补充矩阵 + 8 场景语料；写 `reports/evidence/v21-profile-sensitivity.json` |
| `scripts/v21-decision-impact.ts` | 12 项决策影响指标 + 3 个冲突场景 + Profile Dominance + 输入微扰；写 `reports/evidence/v21-decision-impact.json` |
| `scripts/v21-summarize.ts` | 把上面两份 JSON 聚合成报告用的表；写 `reports/evidence/v21-summary.md` |
| `scripts/v21-defect-evidence.ts` | 缺陷修复的**前后证据**（`before` / `after`） |
| `scripts/v21-repro-state.ts` | Git 状态 + 逐文件 sha256（**不 spawn git**，读 shell 落盘快照） |
| `scripts/v21-chain-distance-probe.ts` | 类别级 vs 组合级距离（独立核查者写） |
| `scripts/v21-fmaudit-*.ts` | 18 项失败模式的探针（独立审查者写） |
| `scripts/v21-rev1..5-*.ts` | 5 个独立审查者的探针 |
| `scripts/v21-corpus-debug.ts` / `v21-order-debug.ts` / `v21-limp-debug.ts` / `v21-equity-debug.ts` | 定位行为顺序与权益口径的调试探针 |

### 18.3 探测脚本的**自检**（因为这些脚本不在 typecheck 覆盖下）

| 自检 | 位置 | 作用 |
|---|---|---|
| **退化自检** | `v21-decision-impact.ts` | 若所有画像给出**完全相同**的权益 ⇒ 抛错 |
| **确定性自检** | `v21-decision-impact.ts` | 同输入两次调用必须 `JSON.stringify` 全等（实测 11/11） |
| **fail-closed 钳位检查** | `v21-decision-impact.ts` | 读不到钳位数据 ⇒ **判违规**（不判通过） |
| **逐行 materiality** | `v21-profile-sensitivity-audit.ts` | 不做 `base+delta` 重建 |

> 🔴 **退化自检不是装饰**：本脚本第一版真的踩了 —— 画像只传给了 `buildDecisionContext`
> 而**没有传给被分析的输入**，于是 11/11 行的权益完全相同（56.259%），
> 而 `bluffMass` 却在变。**加自检之后它变成硬失败**，第二次运行立刻抓到。

### 18.4 噪声处理

| 来源 | 处理 |
|---|---|
| 权益估计量 | 河牌节点 **EXACT 枚举（990 局）**，`confidenceHalfWidth = 0`、`downgradedFromExact = false` ⇒ **SE = 0**（实测跨 7 个种子极差 0.0000pp） |
| 翻牌下注节点的响应权益 | **蒙特卡洛 6000 次/桶** ⇒ SE ≈ 0.65pp/桶；两桶差 √2×0.65 ≈ **0.91pp** ⇒ **约 1pp 的差异在 z≈1.1，落在噪声内** → 该节点的画像效应若 <0.7pp **不可归因**（失败模式 #15） |
| 机器负载 | 宽裕 `budget` 阻止 `equityPolicy` 换型；**同一文件单独运行 vs 全量运行的差异已被消除**（V2 §11 的坑） |
| 采样种子 | 固定；且本轮实测该路径**不采样** |

### 18.5 测试账目（**真实数字，含不通过的**）

| 运行 | 命令 / 日志 | tests | suites | pass | fail |
|---|---|---|---|---|---|
| **本轮基线** | `npm run verify` → `logs/v21-verify-baseline.txt` | **1778** | **137** | **1777** | **1** |
| 上一会话的另一份日志 | 仓库内 `verify-v21-baseline.txt` | 1778 | 137 | 1774 | **4** |
| V2 报告声称 | `reports/PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md:13` | 1772 | 137 | 1772 | 0 |

**4 个失败全部是负载相关的时间断言**，且**逐个隔离运行都通过**：

```text
本轮 fail 1：dynamicBehavior「5000 事件 P95 在热路径预算内」实测 102.784ms（断言 < 100ms）
  隔离重跑两次：P95 = 18.552ms / 27.881ms ⇒ PASS
上一会话 fail 4（同一批 + 3 个）：
  POT-14「分层计算必须在预算内（约 200ms）」实测 1076ms  → 隔离 15/15 PASS
  P3-1 / TEST 5：DEADLINE_EXCEEDED（8000ms 硬上限，实测 9466ms / 8330ms）→ 隔离 5/5、6/6 PASS
```

⇒ **判定：负载相关的既有问题**（不是本轮引入，也不是画像逻辑问题），
**未放宽任何断言**。本轮在最终 `npm run verify` 时重新测量（§20）。

---

## 19. 本轮修改的文件与为什么**不升**版本号

### 19.1 修改清单（5 个文件）

| 文件 | 改了什么 | 为什么必须改 |
|---|---|---|
| `src/domain/player/behaviorProfile.ts` | ① `poolRateOf(key)` 让**缺失条目回落池先验**（5 个读取点）；② `profileMaterialityOf` 对**非有限输入**返回 `NO_EFFECT` + 「无法判定」 | ① 修复「残缺画像打挂整手牌」；② 修复「NaN/Infinity 被展示成正常档位」 |
| `src/app/manualInput/manualInput.ts` | 注入式 `behaviorProfile` 的**信任边界校验**（traits 形状 + 计数类字段必须有限非负整数 + `successes ≤ opportunities` + `effectiveRate ∈ [0,1]`） | 修复「非法数值穿透到似然 ⇒ 贝叶斯更新被静默丢弃、权益 +11.25pp」 |
| `src/app/manualInput/contextBuilder.ts` | ① 新增 `profileAppliedToRange` / `profileAppliedActions`（数出统一似然真正被施加的动作数）；② 证据对象改按 `villainId` 定位被画像描述的那一家 | 修复去重闸门的三处误判（A/B 洞 + 多人池） |
| `src/domain/decision/decision.types.ts` | 新增 `DecisionContext.profileAppliedToRange?` + 说明为什么不能读 `evidence?.provider.applied` | 同上（给闸门一个**事实字段**） |
| `src/app/decision/postflopAdvisor.ts` | 两处闸门改读 `profileAppliedToRange`（旧字段保留为兼容回退） | 同上 |

**产物哈希已重绑**：`npm run manifest`（154 个产物）。

### 19.2 为什么**不**升 `ALPHA_DECISION_MODEL_VERSION`（仍为 `1.0.5`）

先读现有规则（不机械升级）：

- `artifactDefinitions.ts:310-315`：对 `decision.types.ts` 的规则是
  「**所有决策判定阈值发生变化**（该文件改动**必须升** `ALPHA_DECISION_MODEL_VERSION`）」。
- 本轮**没有**任何判定阈值发生变化：
  `MATERIALITY_THRESHOLDS` 逐项未改；`postflopAdvisor` 的闸门**条件语义**未改
  （只是把「读代理指标」换成「读等价的事实字段」）；`manualInput` 新增的是**输入校验**。
- 本轮改动在**合法输入上逐位不变**（前后证据证明：`observe 30/50` 的权益
  修前 57.6956% == 修后 57.6956%）。
- `decision.types.ts` 的变更记录（`:1237`）写「该文件改动按该纪律必须升版本号」——
  但该段的**上位规则**是「**判定阈值**变化」，而本轮只是**新增一个可选字段**。
  按 V2 报告 §16 的同一推理逻辑：一个不遵守任何既定规则的版本号会失去它唯一的用途
  （回答「这手牌为什么从 FOLD 翻成 CALL」）。**本轮没有任何动作会因此改变**（0/1260 flip）。

⇒ **决定：不升版本**，并在此**明确披露**这个判断与依据，供复核。

### 19.3 Git 状态

```text
HEAD = c3391ef                  （**未提交任何东西**）
已修改 tracked：26（其中 5 个是本轮修复的缺陷，21 个是既有工作）
未跟踪：139（其中 80 个是本轮 V2.1 新增，59 个是既有工作）
```

**未丢弃、未覆盖、未清理任何既有工作。** 逐文件 sha256 见
`reports/evidence/v21-repro-state.txt`。

---

## 20. 最终验证

见 §20.1（本节由最后一轮 `npm run verify` 与画像相关回归填充）。

### 20.1 最终 `npm run verify`

**在本轮 5 个源文件修改 + manifest 重绑之后运行**（原始日志 `logs/v21-verify-final.txt`）：

```text
> npm run typecheck && npm run manifest:check && npm test

typecheck     : 0 错误
manifest:check: 产物清单 v1.0.0（生成于 2026-09-18）
                KNOWLEDGE 6 / RANGE 16 / ENVIRONMENT 4 / PLAYER_MODEL 12 /
                DECISION 70 / REPORT 46  合计 **154 个文件**
                ✔ 全部 154 个产物与清单一致

ℹ tests       1778
ℹ suites      137
ℹ pass        1778
ℹ fail        0
ℹ cancelled   0
ℹ skipped     0
ℹ todo        0
ℹ duration_ms 187891.31
exit code 0
```

### 20.1.1 测试账目（**真实数字，含之前不通过的**）

| 运行 | 日志 | tests | suites | pass | fail | 说明 |
|---|---|---|---|---|---|---|
| **最终（本轮修复后）** | `logs/v21-verify-final.txt` | **1778** | **137** | **1778** | **0** | ✅ **全绿** |
| 本轮接手基线 | `logs/v21-verify-baseline.txt` | 1778 | 137 | 1777 | **1** | 唯一失败是 `dynamicBehavior` 的 5000 事件 P95（实测 **102.784ms**，断言 < 100ms） |
| 上一会话留下的日志 | 仓库内 `verify-v21-baseline.txt` | 1778 | 137 | 1774 | **4** | 同一批时间断言 + POT-14 / P3-1 / TEST 5（全部 `DEADLINE_EXCEEDED` 或预算超时） |
| V2 报告声称 | `PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md:13` | 1772 | 137 | 1772 | 0 | ⚠️ **旧值**（少 6 项） |

**关于那 4 个负载相关失败**（这一点必须如实说，不能用「最终全绿」掩盖）：

```text
dynamicBehavior「5000 事件 P95」全量运行 102.784ms（> 100ms）→ **隔离重跑两次：18.552ms / 27.881ms，PASS**
POT-14「分层计算必须在预算内（约 200ms）」全量 1076ms   → **隔离 test/layeredPot.test.ts 15/15 PASS**
P3-1 / TEST 5：DEADLINE_EXCEEDED（8000ms 硬上限，实测 9466ms / 8330ms）→ **隔离 5/5、6/6 PASS**
```

⇒ 判定为**负载相关的既有问题**（非本轮引入、非画像逻辑），
**没有放宽任何断言**（断言全部原样保留）。
最终这次运行刚好在负载较低时执行，因此 4 个都通过 —— **这是运气，不是修复**。

### 20.2 与本轮变更相关的中性画像回归（重跑）

**本轮在修改 5 个源文件之后重新测量**，结论：

**(a) 似然层 48 格网格**（`scripts/v2-unified-likelihood-probe.ts`）

```text
网格单元数 48（3 尺寸 × 8 类别 × 2 前序线）
最大绝对差 0
NEUTRAL_PARITY = PASS（逐位相等，无需容差）
发生钳位的 (类别, 画像)：无（0 个）
```

**(b) 全生产入口的画像敏感度回归**（`scripts/v21-rev5-parity.ts`，9-max 加注池黄金手）

```text
UNKNOWN vs NORMAL     ：权益 0.562588372672 vs 0.562588372672（**Δ = 0.000e+0**）
UNKNOWN vs 完全不给画像 ：权益 Δ = 0.000e+0
NORMAL  vs 完全不给画像 ：权益 Δ = 0.000e+0
UNKNOWN vs 显式中性画像 ：权益 Δ = 0.000e+0
UNKNOWN vs MANIAC      ：权益 Δ = 1.350e-2（**画像确实生效**，正对照成立）
```

⚠️ **该探针把「整个结果对象逐位相同」当作 PASS 判据，因此它打印 `FAIL`。必须解释清楚，
不得含糊**：整个结果对象**确实不同**，但差异**只有三类**，且**没有一类是决策量**：

| 差异类别 | 具体叶子 | 是否影响决策 |
|---|---|---|
| 墙钟耗时 | `timings.*`、`log.timingMs.*`、`viewModel.debug.timing[*]`（共约 15 处） | ❌ 不是决策量 |
| 输入哈希 | `log.inputHash`（`hf841efa7` vs `h2d1bba6e`）—— 因为 `quickProfile` 字段本身不同 | ❌ 输入确实不同（这是**如实**的） |
| 玩家层元数据 | `player.quickProfile`（`UNKNOWN` vs `NORMAL`）、`player.neutralized`（`true` vs `false`）、`player.confidence`（0.5 vs 0.35）、`player.adjustment.confidence`（0.5 vs 0.35）、`player.note` | ❌ **画像层的可解释性元数据**，不是决策量 |

**决策量全部逐位相同**：权益 Δ=0、`profileEvidence` 相同、动作相同、尺寸相同、置信度档相同。

⇒ **本轮采用的结论**：`NEUTRAL_PARITY` 在**决策量**上成立（Δ=0.000e+0），
在**整个结果对象**上**不成立**（含耗时与画像层元数据）。
两者都对，**判据不同** —— 本报告给出两个判据，不挑一个好看的。

**(c) 跛入池的中性画像回归（本轮新增，**失败**）**

```text
UNKNOWN = 0.07845850542399040
NORMAL  = 0.07872806694852144      Δ = 2.695615e-4   ← **决策量不同**
加注池对照（同座位/同手牌/同牌面）：Δ = 0
```

⇒ 这是本轮**最重要的负面回归结果**：中性画像在**跛入池**上与「无画像」**不等价**（§5.3）。
**未修**（会改变跛入池数值，需要独立回归轮），已登记为 `V21_RISK_REGISTER.md` **D12**。

**(d) 与本轮 5 个源文件改动直接相关的测试**

```text
test/profileQuantificationGolden.test.ts   5 / 5   PASS
test/profileV2Metrics.test.ts              6 / 6   PASS
test/profileQuantification.test.ts         9 / 9   PASS
test/profileRangeAdjustment.test.ts       14 / 14  PASS
test/riverConsistencyV21.test.ts          16 / 16  PASS
test/reportVerdictConsistency.test.ts      6 / 6   PASS
test/betDecisionEngine.test.ts             7 / 7   PASS
test/postflopOutput.test.ts                5 / 5   PASS
test/postflopRegressionCases.test.ts       6 / 6   PASS
test/layeredPot.test.ts                   15 / 15  PASS
test/layeredPotDecision.test.ts           若干       PASS
test/multiwayBetResponse.test.ts          若干       PASS
test/alphaRedteamRegression.test.ts       若干       PASS
test/postflopModules.test.ts              若干       PASS
test/projectStatus.test.ts                18 / 18  PASS
⇒ 合计 171 / 171 PASS（含全部画像回归锁与去重闸门的锁定用例）
```

**缺陷修复前后证据**（合法输入**逐位不变**，这是「未升版本号」的依据）：

```text
observed {successes: 30, opportunities: 50}：
  修前 权益 57.6956% / callEV 13.1169
  修后 权益 57.6956% / callEV 13.1169      ← **完全相同**
```

---

## 附录 A：本轮交付清单

| 类别 | 文件 |
|---|---|
| **主报告** | `reports/PROFILE_V21_SENSITIVITY_AUDIT.md`（本文件） |
| 风险登记 | `reports/V21_RISK_REGISTER.md`（D1–D18） |
| 独立审查 | `reports/V21_REVIEW_{1_STATISTICS,2_POKER_LOGIC,3_PIPELINE,4_NUMERICS,5_COUNTEREVIDENCE}.md` |
| 专项核查 | `reports/V21_PRODUCTION_CHAIN_VERIFICATION.md`、`reports/V21_FAILURE_MODE_AUDIT.md` |
| **原始测量** | `reports/evidence/v21-profile-sensitivity.json`（1260+280+64 行）、`reports/evidence/v21-decision-impact.json`、`reports/evidence/v21-summary.md` |
| 修复前后证据 | `reports/evidence/v21-defect-evidence-{before,after}.txt` |
| 文件状态与哈希 | `reports/evidence/v21-repro-state.txt` |
| 失败模式原始输出 | `reports/evidence/v21-fmaudit-*.out.txt`、`reports/evidence/v21-rev5-*.out.txt` |
| 可复现脚本 | `scripts/v21-*.ts`（25 个，含 5 个独立审查者的探针） |

## 附录 B：一句话结论

> **画像链路是真实存在的、方向大体正确的、幅度极小（TRIVIAL，最大 1.37pp 权益）的，
> 并且本轮在其中找到了并修好了 4 个真缺陷（一次重复计票、一次静默丢弃更新、
> 一次整手牌崩溃、一次把 NaN 展示成正常档位）。
> 但它目前**不适合作为决策依据**：98% 的后验质量对它免疫、
> 「跟注站」「极紧」两个最常用标签在诈唬轴上符号反向、
> 实测历史数据根本无法从任何入口进入、且没有任何一个局面会因此改变动作。**
