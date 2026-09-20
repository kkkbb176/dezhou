# RIVER DECISION CONSISTENCY · 全下 / 下注动作一致性审计与修复报告

**日期**：2026-09　|　**授权**：使用者报告「最终建议『下注 55BB』而内部最高 EV 是 ALL_IN，
并出现 `DECISION_CONSISTENCY_ERROR` / `ACTION_CONTRADICTS_PREFERENCE`」后的专项审计 + 最小修复
**基线**：`HEAD = bc56191`（CB-5 已提交未推送）
**统计**：全量 **2,094 项 / 2,094 通过 / 0 失败 / exit 0**（`npm run verify`）；新增套件 **10 项（修复前 5 项失败）**
**复现探针**：`scripts/audit-river-decision-consistency-v1.ts`（未跟踪，只读）

---

## ROOT_CAUSE

**同一个实际动作在本项目里有两套命名，一致性校验与界面都按「名字」而不是「实际语义」比较。**

| 位置 | 命名空间 | 例子 |
| --- | --- | --- |
| 候选尺寸表 / 偏好分表（`betDecision.sizes[].kind`） | **尺寸档位** | `BET_SMALL`、`ALL_IN` |
| 最终动作（`AlphaDecision.action`） | **动作类型** | `BET`、`RAISE`、`ALL_IN` |

当**下注额 = Hero 全部剩余筹码**时，`BET`（金额 = 剩余全部）与 `ALL_IN` 是**同一个实际动作**
（同样投入、同样底池、同样对手响应），但：

1. **动作形态分类**（`decisionEngine.ts:3385-3394`）对 `RAISE` 区分了 `RAISE_TO_ALL_IN` 与 `NORMAL_RAISE`，
   对 `BET` **没有**对应档位 —— 打光筹码的下注仍然只叫 `'BET'`（尽管同一处的 `consumesStack: true` 已如实标出）。
2. **一致性校验**（`decisionConsistency.ts` 偏好分分支）用 `familyOf(a) = a.startsWith('BET') ? 'BET' : a`
   比较家族：最终动作家族 `'BET'` vs 偏好表最高家族 `'ALL_IN'` ⇒ 误报
   `ACTION_CONTRADICTS_PREFERENCE`（实测文案：**「最高偏好分是 ALL_IN（0.62），最终动作却是 BET（0.60）」**）。
3. **界面**（`decisionViewModel.ts:211`）`isAllInRaise` 只认 `RAISE_TO_ALL_IN` / `DIRECT_ALL_IN`
   ⇒ 打光筹码的下注被渲染成「建议**下注** 55BB」，且不显示「本注即全下」⇒ 与内部候选表看起来矛盾。

⇒ **不是策略分歧、不是 EV 计算不一致、也不存在「推荐 ALL_IN 却输出 BET」的两条决策路径** —— 是命名与语义未归一。

## MINIMAL_REPRODUCTION

**执行命令**：`node --experimental-strip-types scripts/audit-river-decision-consistency-v1.ts`

**装置**（生产入口 `analyzeManualHand`，1BB = 50 筹码）：9 人桌 · Hero BTN · A♠K♠ ·
牌面 `Jh 8s Qs Kh Kd` · 河牌 · 行动史 = CO 溜入 / BTN 加注 3BB / CO 补 2BB → 翻牌 CO 过牌·BTN 下注 10BB·CO 跟 →
转牌 CO 过牌·BTN 下注 35BB·CO 跟 → **河牌 CO 过牌**（双方各投入 48BB）。

**复现到的状态（与截图一致）**：`pot = 4875 筹码（97.5BB）`、`myRemainingStack = 2750（55BB）`、
`effectiveStack = 2750`、`SPR = 0.564`、`callCost = 0`（确实轮到 Hero）、牌力 `K三条（明三条），A踢脚`。

**复现到的缺陷（修复前）**：

```text
最终 action = "BET" ｜ consistency.ok = false
✖ ACTION_CONTRADICTS_PREFERENCE：最高偏好分是 ALL_IN（0.62），最终动作却是 BET（0.60）
betDecision: checkEV=3711.5 checkScore=0.500 bestSize=ALL_IN bestScore=0.619
   BET_SMALL  bet=1625  EV=4647.9  score=0.596  ΔvsCheck=+936.4
   ALL_IN     bet=2750  EV=4869.0  score=0.619  ΔvsCheck=+1157.5
actionShape = { kind:"BET", sizeChips:2750, allInToAmount:2750, consumesStack:true }
viewModel.actionZh = "建议：下注"          ← 截图中的「最终建议：下注」
```

**修复后（同一输入、同一探针）**：`consistency.ok = true`，
`actionShape` 与三个 EV **逐位不变**（`1625/2750`、`4647.9/4869.0/3711.5`），
界面文案变为「建议：**全下** …（本注即全下）」。

**关于截图绝对数值的说明（不作为根因依据）**：截图三个 EV（7042.2 / 7355.0 / 6267.8）与本复现
（4647.9 / 4869.0 / 3711.5）**排序与结构完全一致**（ALL_IN > BET_SMALL > CHECK），量级差异与
「筹码/BB 口径不同」一致（截图的 CHECK EV ÷ 97.5BB 底池 ≈ 0.64 权益，本复现为 0.76 权益）。
**根因与口径无关**：命名比较在任意口径下都会误报。

## ACTION_NORMALIZATION

**结论：下注额等于全部剩余筹码时，必须按「全下」语义归一 —— 本轮已实施，且不是只改文案。**

判据**只有一处**（沿用既有表达式，未新增任何判据）：
`consumesStackForAction = |finalSizeChips − legal.allInToAmount| < ALL_IN_COMPARE_EPSILON`（`decisionEngine.ts:3383`）。

| 消费者 | 归一化动作 |
| --- | --- |
| 一致性校验 | 新增可选输入 `actionEffectiveFamily`；引擎传 `consumesStackForAction ? 'ALL_IN' : null` ⇒ 打光筹码的 `BET` 与偏好表的 `ALL_IN` 进入**同一家族**比较 |
| 界面文案 | `betConsumesStack = action === 'BET' && actionShape.consumesStack === true` ⇒ `isAllInRaise` 纳入该情形 ⇒「建议全下 …（本注即全下）」 |

**未变更的东西（逐项核对）**：
- `AlphaDecision.action` 仍是 `'BET'`（金额口径：BET 的 `sizeChips` = 本街累计）——**动作类型不变**；
- 候选尺寸表、EV、排序、`bestSize` 全部不变（探针修复前后逐位对比见 `MINIMAL_REPRODUCTION`）；
- **不传** `actionEffectiveFamily` 时校验判据与修复前**逐位相同**（未放宽）⇒ `§8` 用同一函数证明：
  真正小于全下额的下注（1625）配「最高分是 ALL_IN」**仍然报错**。

## EV_COMPARISON

三个候选**口径完全一致、可直接比较**（同一 `betDecision` 表、同一函数、同一底池）：

| 维度 | CHECK | BET_SMALL | ALL_IN | 是否同口径 |
| --- | --- | --- | --- | --- |
| 底池定义 | `pot = 4875`（同一字段 `betDecision.pot` = `math.pot`） | 同 | 同 | ✅ |
| 筹码单位 | 筹码（1BB = 50） | 同 | 同 | ✅ |
| 本次新增投入 | 0 | 1625（33% 池） | 2750（= 剩余全部） | ✅ 各自独立 |
| 对手可跟注金额 | — | 1625 | 2750（对手剩 2750，可全额跟注） | ✅ |
| 分支 | — | `0.007×4875 + 0.567×3355.3 + 0.426×52.8` | 同结构、参数按尺寸各算 | ✅ |
| 权益方法 | `equity EXACT`（990 次枚举） | 同 | 同 | ✅ |
| 抽水 | `rakeModel = NOT_APPLIED`（三者相同，如实披露） | 同 | 同 | ✅ |
| 已投入/剩余口径 | `EV = ΔvsCheck` 同一基准（checkEV=3711.5） | 同 | 同 | ✅ |
| 净收益口径 | 均为「相对过牌的增量筹码 EV」 | 同 | 同 | ✅ |

**BET 55BB 与 ALL_IN 55BB 是否是同一个动作？是。** 证据：`betDecision.sizes` 中**没有**第二个
「BET 2750」条目 —— 全表只有 `BET_SMALL 1625` 与 `ALL_IN 2750` 两档；最终 `actionShape.sizeChips = 2750`
与 `ALL_IN.betAmount = 2750` 逐个相等 ⇒ 引擎走的是**同一条**计算路径。
⇒ **不存在重复计算、不存在分支不一致、不存在被覆盖或伪造的 EV。**
（`§3` 反向固定：`BET_SMALL` 与 `ALL_IN` 金额不同 ⇒ EV 必须分别计算，不得复用。）

## CONSISTENCY_CHECK

`ACTION_CONTRADICTS_PREFERENCE` 本次是**误报**（命名），不是真实策略分歧：

- 修复前：`familyOf('BET') = 'BET'` vs 最高偏好分家族 `'ALL_IN'` ⇒ 违规；
- 修复后：打光筹码的 `BET` 实际家族 = `'ALL_IN'` ⇒ 与偏好表最高家族一致 ⇒ 无违规，
  而**动作、金额、EV、底池全部未变**（探针逐位对比）—— 若真存在策略分歧，这个改动不可能同时成立。
- **校验能力未被取消**（`§7` 反证 + `§8` 双输入）：金额 1625（真小于全下额）配同样的偏好表
  ⇒ 仍然报 `ACTION_CONTRADICTS_PREFERENCE` ✓。

**如实记录的观察（本轮未改，列入 REMAINING_RISKS）**：同一次决策存在两种「依据」描述 ——
诊断输出 `decisionBasis.kind = ACTION_EV_COMPARISON`（由 `byBetDecisionModel` 推出），
而一致性校验内部自算的依据是 `PREFERENCE_SCORE`。两者都能自圆其说（尺寸选择确实同时有 EV 与偏好分来源），
但**同一输出里出现两个依据名**是可读性隐患，需另行授权处理。

## UI_ERROR_HANDLING

**现有 UI 已满足要求，本轮只做了「让文案与实际语义一致」，未改错误处理逻辑**（执行证据）：

1. **不得伪装成已验证推荐**：`decisionViewModel.ts:262-267` 在 `consistency.ok === false` 时
   `warnings.unshift('DECISION_CONSISTENCY_ERROR：本次输出内部不一致，**不要据此行动**，请把这条反馈给开发者 —— ' + 逐条违规)`
   ⇒ 置于警告列表**最前**。`§9` 注入一条违规后实测：首条警告以 `DECISION_CONSISTENCY_ERROR` 开头、
   含「不要据此行动」、含违规代码 ✓。
2. **保留候选动作与调试信息**：`§9` 同时断言 `diagnostics.betDecision` 等调试字段仍存在（不得为掩盖冲突清空）✓。
3. **不得自动执行下注/全下**：决策路径是纯读取 —— 唯一的牌桌写入口是 `applyTableOp`（由使用者显式操作触发），
   `analyzeManualHand` / `toDecisionViewModel` 均不写台账（探针只读运行，复现前后 `git status` 未出现台账改动）✓。
4. **不得覆盖已有行动记录**：同上，决策路径不产出任何 `TableOp` ✓。

## REGRESSION_TESTS

新增 `test/riverBetAllInConsistency.test.ts`（**10 项**，覆盖授权清单 1–10 条）：

| 项 | 断言要点 | 修复前 |
| --- | --- | --- |
| §1 | 剩 55BB、下注 55BB ⇒ `sizeChips === allInToAmount`、`consumesStack === true`、界面写「全下」、无违规 | ✖ 失败 |
| §2 | 金额相同 ⇒ 最终下注额与 `ALL_IN.betAmount` 逐个相等、`bestSize = ALL_IN`、不得报一致性错误 | ✖ 失败 |
| §3 | 金额不同 ⇒ 保留区分：`1625 ≠ 2750`、两条 EV 分别计算 | ✔ |
| §4 | 最高分尺寸是 ALL_IN ⇒ 输出一致地表达全下（`sizeChips` = ALL_IN 金额） | ✖ 失败 |
| §5 | 深筹码（200/400BB）变体 ⇒ `consumesStack` 必须严格等价于「金额 = 全下金额」，未打光时不得写「全下」 | ✔ |
| §6 | 形态识别是纯标注：全下金额恒等式、有效筹码、底池口径、顶层金额与形态金额一致 | ✔ |
| §7 | 按实际语义比较（含反证：真小于全下额仍须报错） | ✖ 失败 |
| §8 | 同一校验函数双输入：等价动作无违规 + 真分歧保留报错 | ✖ 失败 |
| §9 | 违规时界面显著提示且保留调试信息 | ✔ |
| §10 | V2 街道状态 / 补录 / 未来牌隔离契约不受影响 | ✔ |

**修复前证据（实跑，先于修改）**：`tests 10 / pass 5 / fail 5`（§1/§2/§4/§7/§8），
失败信息如「界面建议文案必须写明全下（实际「建议：下注」）」「最高偏好分是 ALL_IN（0.62），最终动作却是 BET（0.60）」。
**修复后**：`tests 10 / pass 10 / fail 0`。
**全量回归**：`npm run verify` → `tests 2094 / suites 137 / pass 2094 / fail 0`，`exit 0`
（含上一轮 STREET STATE CONSISTENCY V2 的 12 项与全部 137 套件；**既有测试断言未做任何修改或放宽**）。

## FINAL_VERDICT

| 截图中的问题 | 结论 |
| --- | --- |
| 错误是否复现 | ✅ **已复现**（同一错误码 `ACTION_CONTRADICTS_PREFERENCE` + `DECISION_CONSISTENCY_ERROR`，同一结构：`bestSize=ALL_IN` 而动作是 `BET`） |
| BET 55BB 与 ALL_IN 55BB 是否同一实际动作 | ✅ **是**（`sizeChips = allInToAmount = 2750`，候选表只有这一条全下档，`consumesStack = true`） |
| 最终推荐为什么显示 BET | 动作**类型**本就是 `BET`（金额口径要求），但形态分类/界面/校验都漏了「这一注等于全下」⇒ 显示为「下注 55BB」；已按同一判据归一为「全下」语义 |
| 三个候选 EV 是否可比 | ✅ 可比（同表、同底池、同单位、同分支公式、同权益方法、同抽水披露） |
| 是否存在重复计算或动作分支不一致 | ❌ **不存在**（候选表无重复条目，最终金额 = ALL_IN 档金额，EV 修复前后逐位相同） |
| 修改了哪些生产文件 | `src/domain/decision/decisionConsistency.ts`（新增可选 `actionEffectiveFamily` + 家族比较）、`src/app/decision/decisionEngine.ts`（调用点传实际家族）、`src/viewmodels/decisionViewModel.ts`（下注即全下的文案归一）——**3 个文件** |
| 新旧测试各通过多少项 | 新增 10/10（修复前 5/10）；全量 2,094/2,094，失败 0，`npm run verify` exit 0 |
| 是否影响 STREET STATE CONSISTENCY V2 | ❌ **无影响**：V2 的 12 项仍全绿，`§10` 断言了「先录牌后补录 + 未完成不得声称就绪」契约 |

**范围纪律**：未改 EV 公式 / 尺寸网格 / 条件范围 / 对手响应模型 / GTO / 画像 / 剥削模型；
未放宽任何既有断言；未清理或覆盖未跟踪文件；**未提交、未推送、未部署**。

**REMAINING_RISKS**：① 同一次决策存在两种依据名（`ACTION_EV_COMPARISON` 与校验内部 `PREFERENCE_SCORE`），
需另行授权统一；② 本轮未做浏览器端到端验证（证据均为服务端/视图模型层，前端文件未改）；
③ 上一轮遗留项（CB-1/2/3/4/6/7、F1、M6/M14/M19）与
**CB-5/V2 两轮改动仍未推送**（网络不可达，连续 4 次 `git ls-remote` 失败）依旧存在。
