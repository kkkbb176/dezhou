# V2.1 审查 · REVIEWER 5 —— 反证、失效模式与报告一致性

**角色**：五名独立对抗性审查者之一 · **反证 / 失效模式 / 报告一致性**
**审查时间**：2026-09-18 18:45 – 19:15（本地）
**方法纪律**：`src/` 与 `test/` **只读**；新增文件只有本报告与 `scripts/v21-rev5-*.ts`；
未执行 `git add/commit/stash/checkout/restore/clean`；未执行 `npm run verify`（3+ 分钟，属别的 Agent）。

> ### 🔴 首要环境事实：工作区在我审查期间被并发写入
>
> | 时刻 | 事实 |
> |---|---|
> | 18:35:14 | `reports/evidence/v21-profile-sensitivity.json` = 11.7 万字节，schema `{meta, corpus}`（8 场景 × 8 探针 = 64 行） |
> | 18:49:43 | `reports/evidence/v21-decision-impact.json` 出现（我第一次列举时**不存在**） |
> | 19:00:09 | 同一 JSON **被重写**为 162.6 万字节，schema `{meta, matrix}`（S1 × 1260 组合行） |
> | **19:05:44** | **`src/domain/player/behaviorProfile.ts` 被修改**（1144 行 → 1201 行：加入非有限输入守卫） |
> | 19:07:25 | `scripts/v21-profile-sensitivity-audit.ts` 被修改 |
> | 18:40 → 19:07 | 本轮报告陆续出现（`V21_PRODUCTION_CHAIN_VERIFICATION.md`、`V21_FAILURE_MODE_AUDIT.md`、`PROFILE_V21_SMALL_SCALE_AUDIT.md`、`V21_REVIEW_2/3/4_*`） |
>
> **后果**：本报告所有结论都锚定在被测 revision 上。凡在 19:05 前后结论发生变化者，
> 我都给出 **BEFORE / AFTER** 两份原始输出（`reports/evidence/v21-rev5-*-BEFORE.out.txt` 与现文件）。
> `src/domain/player/behaviorProfile.ts` 现行 sha256 前缀 `2229938C4255789B`（19:05:44 版）；
> `contextBuilder.ts` 全程未变，前缀 `474866AC5066253A`。

---

## 0. VERDICT 表

| # | 被测声明 | 我方结论 | 关键数字 |
|---|---|---|---|
| 1a | `CURRENT_PROJECT_STATUS.md:345`「1,778 项 / 137 套件 / 86 个测试文件」 | ✅ **属实（未能证伪）** | 86 个 `*.test.ts`；全量日志 `tests 1778 / suites 137` |
| 1b | `PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md:13`「tests 1772 / suites 137 / pass 1772 / fail 0」 | ❌ **CONFLICT** | 少报 **6** 项；且「fail 0」**不可复现**（实测 fail 1 与 fail 4 两次） |
| 2-D3 | V2 §20 限制 3：范围距离只在类级别度量 | ⚠️ **STILL TRUE（比所述更弱）** | 生产 `src/` 内 `profileRangeDistance` 调用点 = **0**；且 `medianRangeDistance` 这个名字在代码里出现 **0** 次 |
| 2-D2 | V2 §20 限制 2：`THIN_VALUE` 对原型标签无任何条件化 | ⚠️ **STILL TRUE** | 03A 与 03B 的 `thinValueBet` cond 均为 **1.000000**（生效值都是池先验 0.35） |
| 2-D5 | V2 §20 限制 5：跨街 fallback / 环境分档 / 历史库均未实现 | ⚠️ **STILL TRUE ×3** | 统一似然生产调用点只有 1 处且被 `Street.RIVER` 锁死；行为池先验是**单个扁平 6 元常量**；无任何画像持久化 |
| 3 | V2：几何平均「修好了」同一倾向被数三次 | ⚠️ **PARTIALLY FALSIFIED** | 单 combo 内**没有**同一条目被用两次；但 3 个条目来自**同一张单调手写先验表**。几何平均 2.915478 vs 乘积 24.781609 vs max 3.666667 ⇒ 几何平均只比「只数一次」的上界低 20.5%，比乘积低 8.5× |
| 3b | （我方新发现）`THIN_VALUE` 槽位 K=2 但只有 1 个条目可填 | ❌ **缺陷** | 隐含指数实测**恰为 1/2.0000** ⇒ 唯一可用的画像通道被**开平方** |
| 4-A1 | 原型 + 矛盾 manual（5 条全给） | ✅ PASS（**但注释与实现不符**） | 5 条全部 0.8；`callTooWide` 保持 0.72；标签先验 0.15 被**完全丢弃** |
| 4-A2 | `successes > opportunities` | ✅ PASS | 10/3 → 钳到 3/3，率 0.52 |
| 4-A3 | 负 `opportunities` | ✅ PASS | −5 → 0 ⇒ 逐位回落 0.28，confidence 0 |
| 4-A4/A6 | NaN 机会数 / NaN 成功数 | ❌ **FAIL（18:58 版）→ 已于 19:05 在生产入口修复（AFTER 版 PASS）** | BEFORE：`likelihood=NaN`，全链路权益 0.6747883905405524（**+11.22pp**）且 `warnings=0`；AFTER：PARSE 阻断 |
| 4-A5 | `opportunities = Infinity` | ❌ FAIL（18:58）→ 19:05 后 PARSE 阻断 | BEFORE：静默 `effectiveRate=0`、`confidence=NaN` |
| 4-A7 | 极端 `manual thinValueBet` | ❌ **FAIL** | THIN 似然 **0.603280 > STRONG 0.461132**（结构序关系被翻转）；单条 manual 使全链路权益 0.5626 → **0.3694（−19.32pp）** / 0.7180（+15.54pp） |
| 4-A8 | 画像 `playerId` 与实际被分析对手不一致 | ❌ **FAIL** | 标 `seat_BTN` 的 MANIAC 画像对 BB 生效，权益 **0.5766449214663655**，与正确标注 `seat_BB` **完全相同**（无画像 0.5625883726719894） |
| 4-A9 | 给已弃牌玩家画像 | ✅ PASS | 不崩溃、不注入 |
| 4-A10 | 给 Hero 自己的座位画像 | ✅ PASS | 不崩溃、不注入 |
| 4-A11 | 3 人池画像 | ✅ PASS | 仅 villain 生效（0.5617456831 → 0.5684718038） |
| 5a | `NEUTRAL_PARITY = PASS`（48 格，最大绝对差 0） | ✅ **本轮由我重测通过（未能证伪）** | 网格 48，最大绝对差 **0**，钳位 0 |
| 5b | 全链路 `UNKNOWN == NORMAL`（SRP·9-max 黄金手） | ✅ 决策数学逐位相同 | 权益 Δ = **0.000000e+0**；但整个结果对象有 **30 处**叶子不同（溯源/计时，非数学） |
| 5c | 「不给 == UNKNOWN == NORMAL」**普遍成立** | ❌ **FALSIFIED（溜入底池）** | S7 逐字夹具：UNKNOWN 0.07845850542399040 vs NORMAL 0.07872806694852144 ⇒ Δ = **2.695615e-4**；同结构 SRP 对照 Δ = **0.000000e+0** |
| 6 | 本轮主报告 `reports/PROFILE_V21_SENSITIVITY_AUDIT.md` | ⛔ **不存在（19:15 仍缺失）** | 无法审计；改审本轮已存在的 6 份报告与 2 份证据文件 |
| 6b | `v21-summary.md:18`「NEUTRAL_PARITY 在全生产入口上也成立」 | ❌ **CONFLICT** | 被 5c 与**本轮自己的旧版 JSON**（S7 Δ=2.7e-4）双重否证 |
| 6c | `v21-summary.md:38`「范围距离 0.0452」 | ❌ **CONFLICT** | 该值与同一行的「诈唬质量差 4.52pp」**逐位相同**（0.045241799827181），而生成该行 noteZh 的脚本 `:815` 传的是**字面量 0** |
| 6d | 偏离档刻度 = 0.05/0.20/0.45/0.65/**0.95** | ❌ **CONFLICT** | 生产 `manualReadEvidence` 的 `VERY_HIGH` = **0.80**；本轮脚本 `:24/:635` 与 JSON 元数据用 **0.95** |
| 6e | `MATERIALITY_THRESHOLDS` 未改动 | ✅ 属实（未能证伪） | 19:07 实测仍为 0.005 / 0.02 / 0.05 / 0.01 / 0.05 |
| 6f | 「TRIVIAL」为唯一结论 | ❌ **CONFLICT（依语料/revision 而异）** | 本轮 **1260 行矩阵**：max\|Δ权益\| = **0.019761312293106**（阈值的 **0.99×**）、max\|Δ诈唬质量\| = **0.045241799827181**（阈值的 **0.90×**）；而**同一文件 18:35:14 版**（8 场景语料）记录 max\|Δ权益\| = **0.0881**（按项目自己的阈值 = **STRONG**） |

---

## 1. 报告一致性扫荡（上一轮 V2）

### CLAIM UNDER TEST
`CURRENT_PROJECT_STATUS.md:345` = 「**1,778 项 / 137 套件 / 86 个测试文件**」；
`reports/PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md:13` = 「tests **1772** / suites 137 / pass 1772 / fail 0」（`:401` 亦写「1772 项」）。

### METHOD
1. 盘面清点：`Get-ChildItem -Recurse -File test -Filter *.test.ts`。
2. 全量运行日志清点（**未重跑** `npm test`：日志已在 20 分钟内产出，且并发重跑只会加重 CPU 争用——见下）：
   `logs/v21-verify-baseline.txt`、`verify-v21-baseline.txt`、`test-out.txt`、`verify-out.txt`。
3. **执行**验证「suite」语义：`node --test --experimental-strip-types test/profileV2Metrics.test.ts`。

### EVIDENCE (raw)
```text
盘面:  *.test.ts = 86 个；test/ 下全部 .ts = 89 个（多出 test/helpers.ts、
       test/helpers/fakeGtopen.ts、test/helpers/tableJsHarness.ts）

logs/v21-verify-baseline.txt   mtime 2026-09-18 18:26:40  sha256 70E8F160…E6D1
  ℹ tests 1778   ℹ suites 137   ℹ pass 1777   ℹ fail 1   ℹ duration_ms 203433.8778
  唯一失败: test/dynamicBehavior.test.ts:1071
            「5000 事件的 P95 出现量级级退化（实际 102.784ms；热路径预算 20ms）」

verify-v21-baseline.txt（根目录）  mtime 2026-09-18 18:33:27  sha256 F31AA2E7…3ECB8
  ℹ tests 1778   ℹ suites 137   ℹ pass 1774   ℹ fail 4   ℹ duration_ms 217022.4284
  四个失败全部是墙钟/性能断言（dynamicBehavior / layeredPot POT-14 /
  postflopOutput P3-1 / postflopRegressionCases TEST 5）

test-out.txt   （更早）ℹ tests 1754 / suites 137 / pass 1753 / fail 1
verify-out.txt （更早）ℹ tests 1754 / suites 137 / pass 1754 / fail 0

「suite」语义（执行）: node --test test/profileV2Metrics.test.ts
  静态: describe( = 0 处；test( = 6 处
  输出: ℹ tests 6   ℹ suites 0   ℹ pass 6   ℹ fail 0
  ⇒ suites 计的是 describe() 分组，与文件数无关

缺口归因: test/reportVerdictConsistency.test.ts
  文件 mtime 18:09:50；V2 报告 mtime 18:09:26（**晚 24 秒**）
  该文件 test( = 6 处；18:26 日志第 1895–1900 行逐条出现这 6 条
  ⇒ 1772 + 6 = 1778（逐项对齐）
```

### CONFLICT — yes
* **`PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md` 错**：少报 **6** 个用例（1772 vs 1778）。
  差额 100% 由 `test/reportVerdictConsistency.test.ts` 解释：它比 V2 报告**晚写 24 秒**，
  在报告落盘时确实还不存在 —— 这不是伪造，是**报告未标注「截至时刻」的陈旧数字**。
* **V2 报告「pass 1772 / fail 0 / 全绿」今日不可复现**：两次隔 7 分钟的全量运行分别
  `fail 1`（18:26）与 `fail 4`（18:33），`pass` 分别为 1777 与 1774。
  `PROFILE_V21_SMALL_SCALE_AUDIT.md:35-38` 已如实记录 fail 4。
* **`CURRENT_PROJECT_STATUS.md` 对**：1,778 / 137 / 86 三个数分别对应用例 / 套件 / 文件，
  三把尺子互不换算，它写得准确。

### RESOLUTION
**真值（截至 18:26 全量日志，与我 19:00 盘面清点一致）= `tests 1778 / suites 137 / 测试文件 86`。**
`CURRENT_PROJECT_STATUS.md:345` 正确；`PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md:13`（及 `:401`）
是**陈旧快照**，少 6 项，且其 `fail 0` 已被两次运行否证。**未能证伪**的是
`CURRENT_PROJECT_STATUS.md` 的那三个数字 —— 使我没能证伪的数字就是 86 / 137 / 1778。
建议：任何本轮报告引用计数必须带「日志文件名 + mtime」，禁止裸写数字。

---

## 2. 三条架构债是否今日仍成立

### 2.1 限制 3 —— 「`medianRangeDistance` 只在类级别度量」

**CLAIM**：`PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md:382-385`。
**METHOD**：全仓库检索该名字；定位真实函数；枚举**所有**调用点；检查调用向量维数。

**EVIDENCE (raw)**
```text
medianRangeDistance 在 src/ test/ scripts/ data/ 中出现次数 = 0
  ⇒ 「medianRangeDistance」这个名字**在代码里根本不存在**（只在报告散文与其他审查报告里）
  ⇒ 指标是 TV / JS 散度，**没有中位数**，名字本身也是错的

真实函数: src/domain/player/profileRangeMetrics.ts:106
  export function profileRangeDistance(a: readonly number[], b: readonly number[]): RangeDistance | null
  返回 { totalVariation: tv/2, jsDivergence, sharedSupport }（:121-125）
  对**任意等长向量**通用（:110 只检查长度）

调用点枚举（`profileRangeDistance`）:
  src/            0 处（含定义 1 处，无任何生产调用者）
  test/           2 个文件：profileQuantificationGolden.test.ts:294；profileV2Metrics.test.ts:194/199/204/205/209/210
  scripts/        2 个文件：v21-chain-distance-probe.ts:224/238/246/371（合成范围，逐组合口径）；
                            v21-decision-impact.ts:417（s.classVector vs ref.classVector）

生产聚合口径（5 个互不重叠类别）:
  src/domain/postflop/types.ts:203            profileClassMasses: { ... }
  src/app/manualInput/rangeFacts.ts:203,283   生产聚合器
  test/profileQuantificationGolden.test.ts:287-293
      dist = [valueMass − thinValueMass, thinValueMass, showdownMass, missedDrawMass, pureAirMass]
      ⇒ 5 分量

🔴 本轮脚本自身的矛盾:
  scripts/v21-profile-sensitivity-audit.ts:46   import { profileRangeDistance } …   （**从未调用**）
  scripts/v21-profile-sensitivity-audit.ts:815  rangeDistance: 0,                   （**字面量 0**）
  tsconfig.json 无 noUnusedLocals ⇒ 未使用 import 能通过 typecheck
```

**CONFLICT — yes（比 V2 自述更严重）**
V2 说「`profileRangeDistance` 本身对逐组合向量同样适用，只是本阶段的调用点用的是类别级向量」——
前半句成立，但后一句掩盖了事实：**生产 `src/` 里一个调用点都没有**。
而本轮新写的 `v21-chain-distance-probe.ts` 确实做了逐组合口径，但它用的是**合成范围**且只在 `scripts/` 下；
`v21-decision-impact.ts` 仍然只喂类别向量。

**RESOLUTION**：**STILL TRUE**（且从「只在类级别度量」升级为「生产代码零调用」）。
顺带两个可直接修的小问题：`v21-profile-sensitivity-audit.ts:46` 是**死 import**；
`:815` 把 `rangeDistance` 写死为 0（见 §6 第 3 条，它已经污染了 `v21-summary.md` 的一个数字）。

### 2.2 限制 2 —— `THIN_VALUE` 对原型标签无任何条件化

**CLAIM**：`PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md:379-381`。
**METHOD**：读先验表 + 政策常量；执行测量 03A/03B 的 `thinValueBet` 生效值与 cond。

**EVIDENCE (raw)**
```text
src/domain/player/behaviorProfile.ts:191-266  ARCHETYPE_BEHAVIOR_PRIORS
  CALLING_STATION: riverBluff/riverLargeBetBluff/missedDrawBluff/probeAfterTurnCheckBack/callTooWide
                   ← **无 thinValueBet**（:200 注释明说）
  BLUFF_HEAVY     : 4 条，无 thinValueBet（:225-237 注释明说）
  UNDERBLUFFER    : 4 条，无 thinValueBet
  MANIAC          : 4 条 + callTooWide，无 thinValueBet（:251）
  LOOSE           : 3 条 + callTooWide，无 thinValueBet
  VERY_TIGHT      : 2 条 + callTooWide，无 thinValueBet
src/domain/player/behaviorProfile.ts:268-313  THIN_VALUE_TRAIT_POLICY（结构性政策，非调参）
src/domain/player/behaviorProfile.ts:803-819  THIN_VALUE 分支：只施加 cond(thinValueBet)
src/domain/player/behaviorProfile.ts:369-376  ENVIRONMENT_BEHAVIOR_PRIOR.thinValueBet = 0.35

执行（本报告探针 1 与 3）:
  trait                 池先验  03A(CALLING_STATION)  03B(MANIAC)   cond03A     cond03B
  thinValueBet          0.35    0.35                  0.35          1.000000    1.000000
  riverBluff            0.28    0.15                  0.5           0.453782    2.571429
  riverLargeBetBluff    0.2     0.08                  0.42          0.347826    2.896552
  missedDrawBluff       0.25    0.1                   0.55          0.333333    3.666667
  probeAfterTurnCheckBack 0.3   0.18                  0.5           0.512195    2.333333
  参考手 THIN_VALUE trace: [PROFILE] trait=thinValueBet factor=1.000000 rate=0.35
```

**CONFLICT — no**（V2 自述与实现一致）。
**RESOLUTION**：**STILL TRUE**。`thinValueBet` 仍然只有 `manual` / `observed` 两个入口；
六个原型标签全部不给它先验。**未能证伪**该限制 —— 使其未能被证伪的数字是
03A/03B 两侧 cond 都恰好 `1.000000`（逐位）。

### 2.3 限制 5 —— 跨街层级 fallback / 环境分档 / 历史库接入

**CLAIM**：`PLAYER_PROFILE_QUANTIFICATION_V2_REPORT.md:389-390`（三条一起）。
**METHOD**：检索生产调用点与作用域；检索环境参数是否进入行为先验；检索任何持久化。

**EVIDENCE (raw)**
```text
(a) 跨街层级 fallback（§三十六）—— **未实现**
  estimateUnifiedActionLikelihood 的生产调用点**只有 1 处**：
    src/app/manualInput/contextBuilder.ts:1281
  它被锁死在：
    src/app/manualInput/contextBuilder.ts:1202
      if (record.street === Street.RIVER && isAggressive) {
  翻牌/转牌的进攻动作仍走原档位似然（`isPassive` 与其它街不进该分支）。
  唯一回落是 `node === null`（牌面不足 3 张 / 拿不到下注比例）的 fail-closed（:1207-1208）。
  第二条（非生产）调用点：src/domain/player/behaviorProfile.ts:1057，位于 `reweightCombos`，
  而 `reweightCombos` 在 `src/` 内**零调用者**（只有 test/profileQuantification.test.ts:207-208 用）。
  ⇒ 它是一座「第二个入口」的休眠实现，与 §四十五「禁止两个生产入口并存」的精神相悖。

(b) 环境分档（§二十四）—— **未实现**
  src/domain/player/behaviorProfile.ts:369-376
    ENVIRONMENT_BEHAVIOR_PRIOR 是**单个扁平 6 元常量**（riverBluff 0.28 /
    riverLargeBetBluff 0.2 / missedDrawBluff 0.25 / probeAfterTurnCheckBack 0.3 /
    thinValueBet 0.35 / callTooWide 0.5），**不按 GameEnvironment 索引**。
  behaviorProfileOf 的入参（:409-417）里**没有** environment 字段，全程未接收 GameEnvironment。
  仓库里唯一的 `environmentProfile()`（src/domain/range/gameEnvironment.ts:275）
  服务于**知识层规则**（经 contextBuilder.ts:2602 buildEnvironmentSnapshot），
  与行为先验无任何数据流交集。
  ⇒ MID_LOW_STAKES / HIGH_STAKES / TOURNAMENT 得到的行为先验**逐位相同**。

(c) 历史库接入（§二十三）—— **未实现**
  PlayerBehaviorProfile.playerId 只是 `string`（:380，注释自承「未来可从历史库持续更新」）。
  `observed` 通道在生产链上**没有任何生产者**：
    src/ 内 `observed:`（画像语义）零出现；contextBuilder.ts:2662 只有 `handsObserved: 0`。
  仓库内唯一持久化讨论是 GTO 策略存储（src/domain/gto/gtoStrategyStore.ts:9-13，且明确拒绝 SQLite）。
  src/app/table/tableApi.ts:343 的牌桌画像通道只有 SET_PROFILE（单值 quickProfile），无手牌历史上传口。
```

**CONFLICT — no**（与 V2 自述一致；`V21_RISK_REGISTER.md` D3 亦同）。
**RESOLUTION**：**STILL TRUE ×3**。**未能证伪**这三条未实现声明。

---

## 3. 同一证据被数两次？—— 逐 combo 结构槽位实测

### CLAIM UNDER TEST
`src/domain/player/behaviorProfile.ts:859-926` 与 V2 §3：三/四条相关条目用**几何平均**合并，
分母是**结构槽位数** K；因此「同一条倾向被数三次」的问题被修好。

### METHOD
在**参考手**（9-max，Hero CO `Ac Jh`，牌面 `Ad 8s 4s 2c Kd`，河牌；CO 开 2.5 / BB 跟；
翻牌 BB check / CO bet 2 / BB call；转牌 BB check / CO check-back；河牌 BB bet 7）上，
用 `withTrace: true` 逐个类别打印 trace，并**反推** K（`K = ln(乘积)/ln(几何平均)`），
与代码公式 `K = max(1, 1 + (诈唬类?1:0) + (诈唬类||薄价值类?1:0))` 对照
（脚本：`scripts/v21-rev5-slots.ts`）。池 = 5.5 → 9.5 → 9.5，betRatio = 7/9.5 = **0.7368421052631579** ⇒ LARGE。

### EVIDENCE (raw)
```text
类别                    条目数 槽位K   几何平均     原始乘积      max       实测似然      clamped
NUT_VALUE               0     1      1.000000    1.000000    1.000000  0.95000000   no
THIN_VALUE              1     2      1.000000    1.000000    1.000000  0.22134330   no
MISSED_FLUSH_DRAW       3     3      2.915478   24.781609    3.666667  0.16133041   no
PURE_AIR                3     3      2.590265   17.379310    2.896552  0.14333445   no

(a) MISSED_FLUSH_DRAW trace（MANIAC）:
  [BASE]    factor=0.055336
  [SIZE]    trait=riverLargeBetBluff          rate=0.42  factor=2.896552
  [NODE]    trait=probeAfterTurnCheckBack    rate=0.5   factor=2.333333
  [PROFILE] trait=missedDrawBluff            rate=0.55  factor=3.666667
(b) PURE_AIR trace（MANIAC）:
  [SIZE]    trait=riverLargeBetBluff          rate=0.42  factor=2.896552
  [NODE]    trait=probeAfterTurnCheckBack    rate=0.5   factor=2.333333
  [PROFILE] trait=riverBluff                 rate=0.5   factor=2.571429
(c) THIN_VALUE trace: [PROFILE] trait=thinValueBet rate=0.35 factor=1.000000（唯一一条）
(d) NUT_VALUE trace : [SIZE]/[NODE]/[PROFILE] 三行 factor 全 = 1.000000（价值端不调整）

几何平均 vs 乘积 vs max（最终似然，未钳位前）：参考手 betRatio=0.7368
类别                  画像        几何平均   乘积        max        最终(几何)  最终(乘积)  最终(max)
MISSED_FLUSH_DRAW     03A-CS     0.390144  0.059385   0.512195   0.021589    0.003286    0.028343
MISSED_FLUSH_DRAW     03B-MANIAC 2.915478 24.781609   3.666667   0.161330    1.000000*   0.202898
PURE_AIR              03B-MANIAC 2.590265 17.379310   2.896552   0.143334    0.961698    0.160283
  * 乘积路径被钳到 1.0（raw 1.3718）；PURE_AIR 乘积 0.961698 **未钳位却已高于 NUT_VALUE 0.95**

THIN_VALUE 隐含指数（manual 五档，逐档反推）:
  manual=thinValueBet:VERY_LOW  rate=0.05 cond=0.097744 ⇒ 倍率 0.312641  隐含指数 1/2.0000
  …LOW 0.20 cond=0.464286 ⇒ 0.681385 1/2.0000 ; …MEDIUM 0.45 ⇒ 1.232672 1/2.0000
  …HIGH 0.65 cond=3.448980 ⇒ 1.857143 1/2.0000 ; …VERY_HIGH 0.80 cond=7.428571 ⇒ 2.725541 1/2.0000
  ⇒ 条目数 = 1，但分母 K = 2 ⇒ **唯一可用的画像因子被开平方**
```

### CONFLICT — **yes（两条）**
1. **字面上的「同一证据数两次」不存在**：单个 combo 的似然里**没有任何 trait 被施加两次**，
   三个条目是三张不同的表项。所以 V2 说「几何平均修好了重复计票」在**机制层面**是成立的。
2. **但三个条目不是三个独立测量**：它们全部出自 `ARCHETYPE_BEHAVIOR_PRIORS` 这一张**手写**表，
   而代码自己声明这张表的 5 条主动条目**逐条严格单调**（`behaviorProfile.ts:216`
   「五个主动条目逐条严格单调（有测试锁）」）。实测 cond 完全同步：
   03A = 0.453782 / 0.347826 / 0.333333 / 0.512195；03B = 2.571429 / 2.896552 / 3.666667 / 2.333333。
   即：`riverBluff`、`missedDrawBluff`、`riverLargeBetBluff` 是**同一个标量的三种写法**。
   把相关性为 1 的三项做几何平均，只是把一个 3 次的乘性重复换成一个**约定的阻尼律**：
   * 相对「只数一次」的上界（max）：几何平均 2.915478 / 3.666667 = **0.795**（低 20.5%），
     最终似然 0.161330 vs 0.202898（低 20.5%）；
   * 相对乘积：几何平均是乘积的 **1/8.5**，最终似然是 **1/6.2**。
   ⇒ 几何平均**压住了爆炸**，但**没有提供任何独立性证据**，也没有在任何地方量化
   「这三条究竟相关到什么程度」。V2 的「已修好」是**方向正确、强度未被证明**。
3. **新发现的槽位缺陷**：`THIN_VALUE` 的 K=2（节点槽 + 类别槽），但 `THIN_VALUE` **永远填不满节点槽**
   （节点槽只在 `bluffClass` 时填，`behaviorProfile.ts:765`）。于是这条**唯一**对薄价值开放的
   画像通道被恒定开平方：`cond=7.428571`（manual VERY_HIGH）只交付 `×2.725541`。
   这与「几何平均 = 已施加因子的平均」的设计意图不符 —— 空槽位在这里变成了**惩罚**，
   而代码注释（:894-923）说明 K 的设计初衷恰恰是**避免**「多施加一条就被惩罚」。

### RESOLUTION
* 「同一 combo 内重复计票」→ **FIXED（未能证伪）**。使我没能证伪的数字：三个 trait 的
  `contributions` 与 trace 各出现 1 次，`appliedTraitCount === 3 === K`。
* 「三条是独立测量」→ **FALSIFIED**：它们是同一个单调标量的三个投影；几何平均是阻尼而非去相关。
* 「K 公式正确」→ **FALSIFIED for THIN_VALUE**：`K=2` 而可填槽位只有 1，实测指数恰为 1/2.0000。

---

## 4. 画像主导性攻击（对抗输入）

脚本：`scripts/v21-rev5-adversarial.ts`；
原始输出：`reports/evidence/v21-rev5-adversarial.out.txt`（**19:05 后版本**）与
`reports/evidence/v21-rev5-adversarial-BEFORE.out.txt`（**18:58 版本**）。

### A1 原型 + 5 条主动条目全部矛盾的 manual 证据
**期望**：manual 覆盖标签先验（四级来源声明 `behaviorProfile.ts:408`），被动条目不受影响，无 NaN。
**实际（raw）**
```text
riverBluff             effectiveRate=0.8 priorRate=0.8 source=MANUAL_USER_INPUT conf=0
riverLargeBetBluff     effectiveRate=0.8 priorRate=0.8 ...
missedDrawBluff        effectiveRate=0.8 ...
probeAfterTurnCheckBack effectiveRate=0.8 ...
thinValueBet           effectiveRate=0.8 ...        ← 标签先验 0.35 也被覆盖
callTooWide            effectiveRate=0.72 priorRate=0.72 source=PROFILE_PRIOR   ← 未被污染
archetypePriorAvailable=true  isUnknownPlayer=false
priorNoteZh=标签「CALLING_STATION」提供行为先验（与池先验**不同**）｜人工条目 5 条（…）
```
**CONFLICT — yes（注释 vs 实现）**：`behaviorProfile.ts:441` 的注释写
「人工画像作为**伪计数先验**叠加在标签先验之上」，但实测标签先验被**完全丢弃**
（CALLING_STATION 的 `riverBluff` 标签先验是 0.15，实测 `priorRate` = 0.8）。
根因：`manualReadEvidence`（:141-159）**忽略**自己的 `environmentPrior` 形参，
且 `MANUAL_READ_CONFIDENCE_CAP = 0.35`（:76）在整个仓库**没有任何读者**。
**判定 PASS（行为符合四级优先级）/ 但注释与死常量必须修**。

### A2 `successes(10) > opportunities(3)`
**期望**：钳到 opportunities。**实际**：`successes=3 opportunities=3 observedRate=1 effectiveRate=0.52 confidence=0.3333`。
解析式 (0.28×6+3)/(6+3) = 0.52 —— 逐位吻合。**PASS**

### A3 `opportunities = −5`
**期望**：视作无观测。**实际**：`opportunities=0 effectiveRate=0.28 observedRate=null confidence=0`。**PASS**

### A4 / A5 / A6 非有限输入（NaN、∞）—— **我先发现缺陷，19:05 被并发修复**

#### BEFORE（18:58:0x，`behaviorProfile.ts` 尚未修改）
```text
A4 opportunities = NaN
  证据层: opportunities=NaN successes=NaN effectiveRate=NaN confidence=NaN observedRate=NaN
  似然层: base=0.05533582538851817 combinedAdjustment=NaN rawLikelihood=NaN likelihood=NaN clamped=true
          [PROFILE] trait=riverBluff factor=NaN rate=NaN
  全链路: ok action=CALL heroEquity=0.6747883905405524 callEV=17.71505435540596 profileRange=null warnings=0
  对照（无画像）: heroEquity=0.5625883726719894
  ⇒ 权益被静默抬高 **+0.1122（+11.22pp）**，clamped=true 却 warnings=0，无任何提示

A6 successes = NaN，opportunities = 10
  证据层: opportunities=10 successes=NaN effectiveRate=NaN confidence=0.625 observedRate=NaN
  似然层: combinedAdjustment=NaN rawLikelihood=NaN likelihood=NaN clamped=true
  全链路: heroEquity=0.6747883905405524（与 A4 相同）

A5 opportunities = Infinity
  证据层: opportunities=Infinity effectiveRate=0 confidence=NaN observedRate=0
  似然层: combinedAdjustment=0.13704703970136958 likelihood=0.007583611058928305（有限）
  全链路: heroEquity=0.5601571058382347 callEV=12.327383974397033 warnings=0
  ⇒ 「机会数无穷」被静默读成「他从不诈唬」（effectiveRate=0），confidence=NaN
```
**判定（BEFORE）：A4 **FAIL**、A6 **FAIL**、A5 **FAIL（静默语义 + NaN confidence）**。**
这是**静默决策腐蚀**而不是崩溃：没有任何 issue、没有任何 warning，动作仍是 CALL，权益却偏了 11.22pp。

#### AFTER（19:0x，`behaviorProfile.ts` 19:05:44 版）
```text
A4/A6 全链路: NOT_OK stage=PARSE
  {"code":"INVALID_NUMBER","message":"对手的行为条目「riverBluff」的 successes 必须是
   **有限非负整数**，收到 NaN。（项目纪律：非法数值阻断，不做静默修正 ——
   夹取会把「数据坏了」变成「数据看起来正常」）",
   "field":"villain.behaviorProfile.traits.riverBluff.successes"}
A5 全链路: NOT_OK stage=PARSE …「opportunities 必须是有限非负整数，收到 Infinity」
似然层: [PROFILE] trait=riverBluff factor=1 rate=0.28（非有限率被回落到池先验）
证据层: effectiveRate 仍 = NaN，confidence 仍 = NaN
```
**判定（AFTER）：A4/A6/A5 在**生产入口**已被阻断 —— PASS（但属「修复发生在审查期间」）。**
**残留（未修）**：`statEvidenceOf`（:88-135）**仍然**对 NaN 输入返回
`effectiveRate=NaN / confidence=NaN / observedRate=NaN`；新增的 `:705` 守卫把它
**静默掩蔽**成池先验而不是拒绝。也就是说：**NaN 是在证据层产生的，却只在解析层被拦住**，
任何绕过 `parseManualInput` 的路径（脚本、未来的 API、直接构造 `PlayerBehaviorProfile`）
仍会拿到一个「看起来正常」的池先验读数。**这是掩蔽，不是根治。**

### A7 极端 `manual thinValueBet`（唯一没有标签先验的条目）
**期望**：结构序关系 THIN < STRONG（`behaviorProfile.ts:979`）不被翻转。
**实际（raw）**
```text
STRONG_VALUE 似然（价值端恒 ×1.000）= 0.4611318782376514
THIN_VALUE  neutral        VERY_LOW  cond=0.097744 ×0.312641 ⇒ 0.069201
THIN_VALUE  neutral        VERY_HIGH cond=7.428571 ×2.725541 ⇒ 0.603280   ← **越过 STRONG**
THIN_VALUE  CALLING_STATION VERY_HIGH ⇒ 0.603280（与 neutral 相同：标签先验本就中性）
THIN_VALUE  MANIAC          VERY_HIGH ⇒ 0.603280
全链路（§二十 方向）：CALLING_STATION + thin=VERY_HIGH : heroEquity=0.3693957550765856
                     MANIAC          + thin=VERY_LOW  : heroEquity=0.7180132602858421
  §二十 要求 03B > 03A ⇒ 成立（未被翻转）
  但对照无画像基线 0.5625883726719894 ⇒ 单条 manual 使权益 −19.32pp / +15.54pp
  （= 项目 equityMaterial 阈值 0.02 的 9.7× / 7.8×）
```
**判定 FAIL**。两点：
1. 序关系翻转：单条 `manual thinValueBet=VERY_HIGH` 即可让 THIN_VALUE(0.603280) 高于
   STRONG_VALUE(0.461132)。V2 用「标签先验会污染 §二十 单调性」为理由**关闭了标签通道**（:268-313），
   但**同样的污染通过 `manual` 通道完全可达**，而且因为被开平方（K=2）之后**仍然**足以翻转 ——
   说明这条通道的幅度**从未被本轮量化**。
2. 量级：单条人工读数造成 ±15–19pp 的权益移动，而本轮与 V2 都用「TRIVIAL / 幅度极小」概括画像影响。
   两者不是同一个语料，但报告必须说明「TRIVIAL」的适用范围（见 §6）。

### A8 身份不匹配（`playerId` ≠ 实际被分析的对手）
**期望**：`contextBuilder.ts:3138-3139`「只对画像描述的那个对手（`villainId`）注入：
给其他对手套一个画像就是编造数据」⇒ `playerId='seat_BTN'` 的画像对 BB 必须无效。
**实际（raw）**
```text
无画像                              : heroEquity=0.5625883726719894 callEV=12.4416535155835
playerId='seat_BTN' 的 MANIAC 画像  : heroEquity=0.5766449214663655 callEV=13.102311308919177
playerId='seat_BB'  的 MANIAC 画像  : heroEquity=0.5766449214663655 callEV=13.102311308919177   ← 完全相同
```
**判定 FAIL**。`contextBuilder.ts:3169` 直接采信 `input.behaviorProfile`，
唯一的闸门在座位维度（`:3210` `opponent.id === villainId ? (behaviorProfile ?? null) : null`），
而 `villainId` 来自调用方给的 `input.villainPlayerId ?? realizedOpponents[0]?.id ?? …`（`:3141-3142`）。
**`profile.playerId` 从头到尾没有任何一处被比对**（`:3172` 只在**派生**画像时用它填字段）。
影响面：`manualInput.ts:226` 的 `ManualVillain.behaviorProfile` 是类型可达的公开入口；
`playerId` 又是 §二十三 未来历史库绑定的键 —— 今天它是**装饰性字段**。

### A9 给翻前弃牌的玩家（BTN）画像
**实际**：`ok action=CALL heroEquity=0.5625883726719894 … profileRange=null`（与无画像逐位相同）。**PASS**

### A10 把画像挂在 Hero 自己的座位（`seat_CO`）
**实际**：`ok heroEquity=0.5625883726719894`，与无画像对照**逐位相同** ⇒ 未被当作对手注入。**PASS**

### A11 多人池（LJ/CO/BB 三家看翻牌，河牌 BB bet 10 / LJ fold）
```text
villain 默认（无画像）      : heroEquity=0.5617456830987888 callEV=24.939654647903104 action=CALL
villain=BB   MANIAC        : heroEquity=0.5684718038296322 callEV=25.47774430637058  profileRange applied=true 2970/2970
villain=LJ   MANIAC（河牌已弃牌）: heroEquity=0.5617456830987888（与默认逐位相同）
```
**判定 PASS**：多人池可分析；画像只对 `villainId` 生效；对已弃牌座位无影响。

### 4.x 对抗攻击总账
| 用例 | 判定 | 一句话 |
|---|---|---|
| A1 原型+矛盾 manual ×5 | PASS（注释失真） | manual 覆盖正确；标签先验被完全丢弃（注释说「叠加」） |
| A2 successes > opportunities | PASS | 钳到 3/3 |
| A3 负 opportunities | PASS | → 0，回落池先验 |
| A4 NaN opportunities | **FAIL → 19:05 修复** | BEFORE `likelihood=NaN`、权益 +11.22pp、`warnings=0` |
| A5 ∞ opportunities | **FAIL → 19:05 阻断** | BEFORE 静默读成 effectiveRate=0、confidence=NaN |
| A6 NaN successes | **FAIL → 19:05 修复** | 同 A4 |
| A7 极端 manual thinValueBet | **FAIL** | THIN(0.603280) > STRONG(0.461132)；±19pp 权益 |
| A8 playerId 不一致 | **FAIL** | 不匹配的画像照样生效，权益与匹配时逐位相同 |
| A9 已弃牌玩家画像 | PASS | 不崩溃、不注入 |
| A10 Hero 座位画像 | PASS | 不注入 |
| A11 多人池 | PASS | 只对 villain 生效 |

---

## 5. 中性对等（NEUTRAL_PARITY）重测

### 5.1 重跑 V2 探针（48 格）
```text
$ node --experimental-strip-types scripts/v2-unified-likelihood-probe.ts
================ 1. NEUTRAL_PARITY 网格（中性画像 vs 既有档位权重）================
size  类别                      legacy        unified       diff        equal?
25%   NUT_VALUE              0.95000000  0.95000000  0（逐位）  YES
25%   STRONG_VALUE           0.59375000  0.59375000  0（逐位）  YES
25%   THIN_VALUE             0.28500000  0.28500000  0（逐位）  YES
25%   SHOWDOWN_VALUE         0.16625000  0.16625000  0（逐位）  YES
25%   MISSED_FLUSH_DRAW      0.07125000  0.07125000  0（逐位）  YES
25%   MISSED_STRAIGHT_DRAW   0.07125000  0.07125000  0（逐位）  YES
25%   MISSED_COMBO_DRAW      0.07125000  0.07125000  0（逐位）  YES
25%   PURE_AIR               0.07125000  0.07125000  0（逐位）  YES
75%   NUT_VALUE              0.95000000  0.95000000  0（逐位）  YES
75%   STRONG_VALUE           0.45706896  0.45706896  0（逐位）  YES
75%   THIN_VALUE             0.21939310  0.21939310  0（逐位）  YES
75%   SHOWDOWN_VALUE         0.12797931  0.12797931  0（逐位）  YES
75%   MISSED_* / PURE_AIR    0.05484828  0.05484828  0（逐位）  YES
125%  …（同上，全部 0）        YES

  ⇒ 网格单元数 48（3 尺寸 × 8 类别 × 2 前序线）
  ⇒ 最大绝对差 0
  ⇒ NEUTRAL_PARITY = PASS（逐位相等，无需容差）
  ⇒ 发生钳位的 (类别, 画像)：无（0 个）
exit=0
```
**结论**：**48/48 是这一轮由我重测的，不是转抄。** 最大绝对差 **0**，与 V2 报告 `:7` 完全一致。
**未能证伪。**

### 5.2 我自己的全链路探针（`scripts/v21-rev5-parity.ts`，9-max SRP 黄金手）
```text
U_unknown           权益=0.562588372672  动作=CALL  full=9e3166368563f90b
N_normal            权益=0.562588372672  动作=CALL  full=edc5b250deea6297
NO_none           权益=0.562588372672  动作=CALL  full=ed8ee9a9e0bb21f1
P_explicitNeutral 权益=0.562588372672  动作=CALL  full=3d9ab8de3fea126a
M_maniac          权益=0.576091380427  动作=CALL  full=a63610492ed8111b

UNKNOWN vs NORMAL          : Δ权益 = 0.000000e+0  （**决策数学逐位相同**）
UNKNOWN vs 完全不给画像      : Δ权益 = 0.000000e+0
NORMAL  vs 完全不给画像      : Δ权益 = 0.000000e+0
UNKNOWN vs 显式中性画像      : Δ权益 = 0.000000e+0
UNKNOWN vs MANIAC          : Δ权益 = 1.350e-2（画像确实生效）

range.updateTrace 的 sha256：U / N / NO / P **四者完全相同**（91c95e5298653238）
「整个结果对象」sha256 不同：UNKNOWN vs NORMAL 有 **30 处**叶子差异
  $.decision.diagnostics.player.confidence : 0.5 ⇒ 0.35
  $.decision.diagnostics.player.neutralized: true ⇒ false
  $.decision.diagnostics.player.quickProfile: UNKNOWN ⇒ NORMAL
  $.decision.diagnostics.profileRange      : null ⇒ object（13 行）
  $.viewModel.debug.profileRange           : 数组长度 1 vs 13
  $.log.inputHash / $.timings.* / $.viewModel.debug.timing[*].value  ← 墙钟，天然不同
```
**判读**：在 **SRP** 下，`UNKNOWN` 与 `NORMAL` 的**决策数学**（权益、动作、范围更新日志）
**逐位相同** —— 这是真实且强的结论。但「整个结果对象逐位相同」**不成立**：
`NORMAL` 会额外产出一个 13 行的 `profileRange` 证据块、把玩家可信度写成 0.35、
把 `neutralized` 由 true 改成 false。也就是说：**UI 呈现上 NORMAL 表现为「画像已生效」而数学上没有生效**。
`archetypePriorAvailable`（`behaviorProfile.ts:403`）本是为了区分这两种情况而加的，
但它在 `decision.diagnostics` 与 viewModel 中**都没有出口**（全仓库只有测试读它）。

### 5.3 🔴 溜入底池：NEUTRAL_PARITY **被证伪**（`scripts/v21-rev5-limp-parity.ts`）
逐字复刻本轮自己证据文件里的 **S7_LIMPED_POT_RIVER_BLUFFCATCH**（6-max，Hero BB `9h 9c`，
牌面 `Qs 8d 3c 6s Ks`，UTG/CO/BB 溜入池）：
```text
================ LIMPED（S7 逐字）================
  UNKNOWN          ok=true 权益=0.07845850542399040 动作=FOLD profileRange=null
  NORMAL           ok=true 权益=0.07872806694852144 动作=FOLD profileRange=有
  none             ok=true 权益=0.07845850542399040 动作=FOLD profileRange=null
  explicitNeutral  ok=true 权益=0.07845850542399040 动作=FOLD profileRange=null
  UNKNOWN vs NORMAL : Δ权益 = 2.695615e-4  ⇒ **不同**      ⇒ NEUTRAL_PARITY = **FAIL**

================ SRP 对照（同 6-max 座位 / 同 hero / 同牌面，只换翻前结构）================
  UNKNOWN 0.11021033037680723 / NORMAL 0.11021033037680723 / none 同 / explicitNeutral 同
  UNKNOWN vs NORMAL : Δ权益 = 0.000000e+0  ⇒ 逐位相同      ⇒ NEUTRAL_PARITY = PASS
```
**机制（已定位）**
```text
contextBuilder.ts:3181  const profileArchetype = quickProfileToLimperArchetype(input.quickProfile);
contextBuilder.ts:3185  archetype: playerId === villainId ? profileArchetype : LimperArchetype.POPULATION,
contextBuilder.ts:3186  confidence: playerId === villainId ? playerBuilt.confidence : 0,
  'NORMAL'  → LimperArchetype.NORMAL（limpIsolation.ts:436-453 的 default 分支）
             且 playerBuilt.confidence = QUICK_PROFILE_CONFIDENCE = 0.35
  'UNKNOWN' → 走 NO_DATA_NEUTRAL，confidence = 0
limpIsolation.ts:113-124  effectiveTraits: mix(base, pop) = pop + (base−pop)×c
  ⇒ c=0.35 时 limp 范围被 LIMP_TRAITS.NORMAL 拉动；c=0 时纯 POPULATION ⇒ 两条范围不同
```
**数字双重复核**：我实测的 `2.695615e-4` 与本轮**自己的证据文件 18:35:14 版**
（`reports/evidence/v21-profile-sensitivity.json`，schema `{meta,corpus}`）
记录的 `NO_PROFILE_UNKNOWN` 对 `NEUTRAL_NORMAL` 在 S7 上的最大 `|Δequity|` = **0.00027 完全吻合**。

**CONFLICT — yes**：`reports/evidence/v21-summary.md:18`
「UNKNOWN 与 NORMAL 逐位相同：是（`NEUTRAL_PARITY` 在**全生产入口**上也成立）」
与 `reports/PROFILE_V21_SMALL_SCALE_AUDIT.md:11`「不给 == UNKNOWN == NORMAL == 零手实测，逐位相同」
**均被证伪**：在溜入底池上 `NORMAL ≠ UNKNOWN`，差值 **2.695615e-4**（且是本轮自己的证据文件先记录的）。
这两份声明的语料都是 **S1 类（SRP）**，所以它们在**自己的语料内**成立 —— 问题是把
「SRP 逐位相同」写成了「全生产入口成立」。

### 5.4 中性对等总账
| 层次 | 结论 | 数字 |
|---|---|---|
| 似然函数 48 格 | ✅ PASS（我重测） | 最大绝对差 **0** |
| 全链路决策数学（SRP 9-max） | ✅ PASS（我重测） | 权益 Δ = **0.000000e+0** |
| 全链路整个结果对象（SRP 9-max） | ❌ 不同 | 30 处叶子（provenance/计时，非数学） |
| 全链路（**LIMPED** 6-max，S7 逐字） | ❌ **FAIL** | Δ权益 = **2.695615e-4** |

---

## 6. 本轮报告一致性

### CLAIM UNDER TEST
`reports/PROFILE_V21_SENSITIVITY_AUDIT.md`（任务书指定的本轮主报告）。
### EVIDENCE
```text
Test-Path reports/PROFILE_V21_SENSITIVITY_AUDIT.md  ⇒  False（19:15 仍不存在）
```
### RESOLUTION
⛔ **无法审计**：本轮主报告尚未落盘。我改为审计**已存在**的本轮产物：
`reports/PROFILE_V21_SMALL_SCALE_AUDIT.md`（19:07:37）、`reports/evidence/v21-summary.md`（19:01:36）、
`reports/V21_PRODUCTION_CHAIN_VERIFICATION.md`、`reports/V21_RISK_REGISTER.md`、
`reports/V21_FAILURE_MODE_AUDIT.md`、`reports/V21_REVIEW_2/3/4_*`、
`reports/evidence/v21-profile-sensitivity.json`、`reports/evidence/v21-decision-impact.json`。

#### 发现 1（❌ CONFLICT）中性对等被过度概括
* `PROFILE_V21_SMALL_SCALE_AUDIT.md:11`：「中性画像兼容性 = PASS（不给 == UNKNOWN == NORMAL == 零手实测，逐位相同）」
* `v21-summary.md:18`：「UNKNOWN 与 NORMAL 逐位相同：是（NEUTRAL_PARITY 在全生产入口上也成立）」
* **两个数字**：报告说「逐位相同」；实测溜入底池 UNKNOWN 0.07845850542399040 vs NORMAL 0.07872806694852144
  ⇒ **Δ = 2.695615e-4 ≠ 0**。且该数字**先由本轮自己的旧版 JSON 记录**（S7，0.00027）。

#### 发现 2（❌ CONFLICT / 语料依赖）「TRIVIAL」不是唯一答案
* `PROFILE_V21_SMALL_SCALE_AUDIT.md:10`：TRIVIAL（equityDelta **0.0135** / bluffMassDelta **0.0316**）
* `v21-summary.md:28-29`：max\|Δ权益\| = **1.9761pp**、max\|Δ诈唬质量\| = **4.5242pp**（1260 行矩阵，S1）
* 我独立复算 `reports/evidence/v21-profile-sensitivity.json`（19:00:09 版，1260 行）：
  ```text
  基线 = S1 / NORMAL / N0_NO_OBSERVATION / E0：eq=0.562588372671989 bluff=0.0184214400588741
  max|Δequity|    = 0.019761312293106  @ BLUFF_HEAVY / N1000_LARGE / E3_TAG_PRIOR_REASSERTED / dev=0.95
                     （equityMaterial 0.02 的 0.99×；差 −0.000238687706894）
  max|ΔbluffMass| = 0.045241799827181  @ 同一单元
                     （massMaterial 0.05 的 0.90×；差 −0.004758200172819）
  1260 行动作分布：CALL ×1260（**没有一个动作被改变**）
  ```
* **同一文件 18:35:14 版**（8 场景语料，schema `{meta,corpus}`）记录的最大值：
  ```text
  MANIAC_OBS_50_45 @ S5_RIVER_OVERBET_FACING : Δ权益 = 0.0881（**按项目自己的阈值 = STRONG，> 0.05**）
  MANIAC_TAG       @ S5_RIVER_OVERBET_FACING : Δ权益 = 0.0587（同为 STRONG）
  MANIAC_OBS_0_0   @ S5                       : Δ权益 = 0.0587
  ```
  ⇒ 本轮证据文件在审查期间被**重写**（18:35 → 19:00，语料从 8 场景换成 S1×1260 组合）。
  两份 revision 的 max\|Δ权益\| 分别是 **0.0881** 与 **0.0198**，**相差 4.5×**。
  **任何引述「TRIVIAL」的句子必须写明语料与 JSON revision**，否则不可复现。

#### 发现 3（❌ CONFLICT）`v21-summary.md:38` 的「范围距离 0.0452」不可由所述脚本复现
```text
v21-summary.md:38
  noteZh = 画像物性 TRIVIAL（EXPERIMENTAL 阈值）：权益差 1.98pp｜诈唬质量差 4.52pp
           ｜EV 差 0.00 筹码｜范围距离 0.0452

scripts/v21-profile-sensitivity-audit.ts:46   import { profileRangeDistance } …（**从未调用**）
scripts/v21-profile-sensitivity-audit.ts:815  rangeDistance: 0,   ← 传给 profileMaterialityOf 的是**字面量 0**
scripts/v21-profile-sensitivity-audit.ts:799-800  evA = neutral.callEV; evB = neutral.callEV  ← EV 差恒为 0
（该脚本 mtime 19:07:25 —— 19:07 时行号 815，仍是字面量 0）
```
两个数字并列写出：报告写 `范围距离 0.0452`；生成该行 `noteZh` 的代码传 `0`
（`noteZh` 会打印 `｜范围距离 0.0000`）。且 `0.0452` 与同一行的
`诈唬质量差 4.52pp` **逐位相同**（0.045241799827181）—— 高度可疑是把质量差误当距离复用。
无论哪种解释：**`v21-summary.md` 的范围距离数字无法从它引用的脚本复现。**

#### 发现 4（❌ CONFLICT）人工读数刻度 0.95 vs 0.80
```text
scripts/v21-profile-sensitivity-audit.ts:24   「VERY_LOW/LOW/MEDIUM/HIGH/VERY_HIGH = 0.05/0.20/0.45/0.65/0.95」
                                              并自称「**生产入口自己的刻度**（manualReadEvidence 的 5 档），不是自造」
scripts/v21-profile-sensitivity-audit.ts:552  { name: 'VERY_HIGH_0.95', tendency: 'VERY_HIGH' }
scripts/v21-profile-sensitivity-audit.ts:635  { …, VERY_HIGH: 0.95 }[dev.tendency]
reports/evidence/v21-profile-sensitivity.json  meta.tiers.deviations 含 "VERY_HIGH_0.95"
src/domain/player/behaviorProfile.ts:145-151  manualReadEvidence: VERY_HIGH → **0.80**
实测（本报告 A1/A7）: behaviorProfileOf({manual:{thinValueBet:'VERY_HIGH'}}).effectiveRate = **0.8**
```
**两个数字**：本轮自称的极端档 = **0.95**；生产实际交付 = **0.80**（相差 0.15）。
`v21-summary.md:58-64` 的表头也写 `0.95`。这直接影响「极端档」的所有结论强度 ——
极端档被高估，反向也说明生产模型的最强人工读数比报告所称弱 19%。

#### 发现 5（⚠️ 需披露）计数与「全绿」
`PROFILE_V21_SMALL_SCALE_AUDIT.md:35-38` 如实写了 `fail 4 / pass 1774`（对应 18:33 日志）；
但 18:26 的日志是 `fail 1 / pass 1777`。两次隔 7 分钟的全量运行失败数不同
（1 vs 4），四个失败全是墙钟/性能断言 ⇒ **套件对 CPU 争用敏感**。
本轮报告若只引一次运行、或复述 V2 的「全绿」，都会失真。**必须同时披露 1 与 4。**

#### 发现 6（✅ 未能证伪）物性阈值本身未被改动
```text
src/domain/player/behaviorProfile.ts:1119-1124（19:07 实测）
  equityTrivial 0.005 / equityMaterial 0.02 / equityStrong 0.05 / massTrivial 0.01 / massMaterial 0.05
与 V2 报告 §1.1 引用值逐位相同 ⇒ **阈值未改**（未能证伪）。
但 `profileMaterialityOf` 的**行为**在 19:05:44 被改（加入非有限输入守卫，返回 NO_EFFECT），
所以「阈值没改」与「判定没改」是两件事：报告必须锚定 revision。
```
另注：`scripts/v21-profile-sensitivity-audit.ts:792-806` 的 materiality 块不是「两个真实画像的比较」，
而是 `equityB = neutral + max|Δeq|`、`bluffMassB = neutral + max|Δbm|` 的**上包络**（`evDelta ≡ 0`、
`rangeDistance ≡ 0`）。任何从此块引用的结论必须标注为「上包络」，否则读者会误当成实测配对。

---

## 7. 建议（按可执行性排序）

1. 🔴 **先固定 revision**：给 `src/domain/player/behaviorProfile.ts`（19:05:44，`2229938C4255789B`）
   与 `contextBuilder.ts`（`474866AC5066253A`）建立基线；本轮所有报告改写前先声明锚点。
2. 🔴 **修正中性对等的措辞**：改为「在 SRP 语料上逐位相同；**溜入底池 Δ=2.695615e-4 不成立**」，
   并在 `limpIsolation.effectiveTraits` 的调用点把 `NORMAL` 的可信度按「该标签无行为先验」置 0
   （与 `UNKNOWN` 对齐）—— 这是**一处即可修复**的算术不一致。
3. 🔴 **`THIN_VALUE` 的槽位**：`K` 应只计**可填**槽位（薄价值类 K=1），或让薄价值也接受节点槽。
   现状是所有薄价值画像通道被恒定开平方（实测指数 1/2.0000）。
4. 🔴 **`playerId` 身份校验**：在 `contextBuilder.ts:3169` 之后加一条
   `input.behaviorProfile.playerId === villainId` 的断言或 issue（A8 实测不匹配画像照样生效）。
5. 🟠 **把 NaN 挡在产生处**：`statEvidenceOf` 应对非有限输入返回 `null`/抛错，而不是
   产生 NaN 再靠下游掩蔽（A4 的 `effectiveRate` 至今仍是 NaN）。
6. 🟠 **`v21-profile-sensitivity-audit.ts`**：删掉死 import（:46）；`rangeDistance` 改用真实值或
   明确标注为 0；刻度文案改为 0.80；把 materiality 块标注为「上包络」。
7. 🟡 报告里所有计数带上日志文件名 + mtime；把「fail 0」改成两次运行的实测（1 与 4）。

---

## 附：本报告全部数字的复现命令

```text
node --experimental-strip-types scripts/v2-unified-likelihood-probe.ts      # 48 格 NEUTRAL_PARITY（我重跑：最大差 0）
node --experimental-strip-types scripts/v21-rev5-slots.ts                   # §3 槽位 / trace / 几何平均 vs 乘积 vs max
node --experimental-strip-types scripts/v21-rev5-parity.ts                  # §5.2 全链路 UNKNOWN/NORMAL/无画像/显式中性 + 差异叶子
node --experimental-strip-types scripts/v21-rev5-limp-parity.ts             # §5.3 溜入底池 NEUTRAL_PARITY = FAIL（2.695615e-4）
node --experimental-strip-types scripts/v21-rev5-adversarial.ts             # §4 A1–A11 对抗用例
node --test --experimental-strip-types test/profileV2Metrics.test.ts        # 「suite」语义：tests 6 / suites 0
Get-Content logs/v21-verify-baseline.txt | Select-String '^ℹ '              # 真值计数 1778/137/pass 1777/fail 1
```
新增文件（未触碰 `src/`、`test/`，未做任何 git 写操作）：
`scripts/v21-rev5-slots.ts`、`scripts/v21-rev5-parity.ts`、`scripts/v21-rev5-limp-parity.ts`、
`scripts/v21-rev5-adversarial.ts`，以及 `reports/evidence/v21-rev5-*.out.txt`（含 `*-BEFORE.out.txt` 两个 revision 快照）。
