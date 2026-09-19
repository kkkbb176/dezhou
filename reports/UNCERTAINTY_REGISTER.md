# 不确定登记表（UNCERTAINTY REGISTER）

> 按 `docs/UNCERTAINTY_POLICY.md` 第 4 节的九行格式逐条登记。
> **本文件是「尚未解决」部分的唯一事实来源**；已修复的部分见各自的轮次报告。
>
> 登记轮**未修改任何产品代码**（只取证与登记）。
> **U1 实现轮**（人工授权「实现加注 EV（方案②公共信息口径 + 方案①独立对照）」）：
> 实现了 U1，并在实现过程中发现两处**披露层自相矛盾**（U10 / U11），已修。
> **U1 P0 修复轮**（人工授权「修复已确认的资金记账与赔率 P0」）：
> 修掉了 U1 的**筹码口径错误**（对手已下注的筹码被漏出底池）与**跟注赔率错误**，
> 新增资金口径安全门 `CASHFLOW_CONTRACT`；U12 的动作随之从 CALL 变回 RAISE（边缘）；
> U9 的锯齿幅度在正确价格下**变大**（最大 +21.7pp）。详见 `reports/U1_RAISE_EV_P0_FIX_REPORT.md`。
> 取证脚本：`scripts/uncertainty-register-evidence.ts`、`scripts/u1-raise-ev-crosscheck.ts`、
> `scripts/u1-response-monotonicity.ts`、`scripts/u1-raise-fields-probe.ts`、
> `scripts/u1-audit-ev-convention.ts`、`scripts/u1-f01-probe.ts`｜原始输出：`reports/evidence/` 下同名 `.txt`

**当前开放条目：9 条** —— `MODEL_LIMITATION` 4 条（U1 残余、U4、U6、U7）、
`CONFIRMED_BUG`（仅呈现层，**已修并留档**）2 条（U10、U11）、
`INCONCLUSIVE`（需人工裁决）3 条（U2、U5、U12）。
已关闭：U1 由 `NOT_IMPLEMENTED` → 已实现 → **P0 资金口径已修**（残余只剩未校准与下界近似）。

---

## U1 · 加注 EV 与「面对加注的继续范围」—— **已实现（残余未校准）**

```text
问题是什么：      面对下注时的加注动作没有任何筹码 EV 依据，却曾长期被选为最终动作（AK 节点 RAISE 174）。
                 人工裁决：**实现加注 EV**，口径 = 方案②（公共信息）为生产、方案①（既有模型）作独立对照。
已确认的根因：    ~~NOT_IMPLEMENTED~~ → **已实现**。新增 `src/app/manualInput/raiseResponse.ts`：
                  (a) 他面对我加注的弃/跟/再加概率（公共强度带 + 听牌 + 价格 + 画像），
                  (b) 加注继续范围 EqVsRaiseCallRange（条件范围，已归一化），
                  (c) RAISE EV = P(弃)·pot + P(跟)·(Eq·(pot+2·inc) − inc) + P(再加注)·(−inc)。
                  模型自述：`kind = PUBLIC_BAND_RAISE_RESPONSE_V1`、`usesHeroHiddenCards = false`。
实际复现证据：    · 生产输出（`reports/evidence/rrdv2-acceptance.txt`）：AK 河牌节点
                    `RAISE EV = −5.447466`、`CALL EV = +19.697943` ⇒ 动作 **CALL 40**（不再是无依据的加注）；
                  · 正向可达（`reports/evidence/u1-raise-fields-probe.txt`）：99 河牌暗三条
                    `RAISE MODEL_EV = +140.011825` > `CALL EV = +79.218472` ⇒ 动作 **RAISE 174**（`RAISE_TO_ALL_IN`）；
                  · 独立对照（`reports/evidence/u1-raise-ev-crosscheck.txt`）：方案① 与方案② 在 8 个节点上
                    RAISE EV **符号 7/7 一致**（节点数 7 个可比），量级不同；
                  · 尺寸单调性（`reports/evidence/u1-response-monotonicity.txt`）：弃/继续/再加注三条单调性
                    在 29 个尺寸点上无一次违反；
                  · 测试锁定：`test/raiseResponseU1.test.ts`（U1-1…U1-8）、
                    `test/riverRaiseDecisionV2.test.ts`（V2-15、V2-16）。
已经验证的修复：  已实现并验证（含「Hero 全下 ⇒ 他不能再加注，权重迁移到跟注」「非法输入返回 null」）。
                  ⚠️ 政策第 8 条：**不得**把本项整体宣告为 PASS —— 见下两行的残余。
仍然不确定的部分：① **系数未校准**：`RAISE_RESPONSE_BAND_STRENGTH`（9 档）、价值/诈唬再加注份额、
                    河牌余量 0.10 全部是结构性取值，仓库内**没有**「按手牌类别的面对加注继续频率」数据源；
                  ② **再加注分支取下界**（`MODEL_EV_WITH_LOWER_BOUND_RERAISE_BRANCH`）⇒ RAISE EV 系统性偏低；
                  ③ **方案① · 方案② 有一处决策级分歧**：99 暗三条节点
                    方案② +140.01 / 方案① +67.92 / CALL +79.22 ⇒ 方案② 选 RAISE、方案① 会选 CALL。
                    符号一致（都为正）但**相对 CALL 的名次相反**，故「同号」这一门槛**不足以**证明可直接生产比较；
                  ④ 与 U9 的联动：跟注率随尺寸非单调 ⇒ 大尺寸 RAISE EV 会被抬高。
是否改变了原有策略：**是（本轮）**。加注从「启发式」变为「参与 EV 比较」：
                    · AK 河牌：仍为 CALL 40（与上一轮一致，但依据由「无 EV 被拦」变成「RAISE EV −5.45 < CALL +19.70」）；
                    · 99 河牌 100BB：CALL → **RAISE 174**（依据 MODEL_EV +140.01）；
                    · 99 河牌 400BB：RAISE 160（不变）；TEST 4（AA 转牌）：CALL（不变）；
                    · AA 面对 3bet（翻前）：RAISE 56（不变；翻前加注 EV 仍缺，走启发式 + 披露）。
是否存在回归风险：中。风险集中在「加注从启发式变 EV 后，所有面对下注节点的动作可能改变」。
                  已用全仓测试 + V2 家族（16 条）+ U1 家族（9 条）锁定；**未**发现规模性翻转
                  （抽样 5 个节点仅 99 暗三条一个动作改变）。
建议下一步：      (a) 取真实数据校准 ①（需要外部数据源，不得调参凑结果）；
                  (b) 把再加注分支升级为真 EV（去掉下界近似）；
                  (c) 由人裁决「方案① vs 方案② 名次分歧」是否可接受（见 ③）。
是否需要人工裁决：**是**（③ 的分歧 + ① 的校准数据来源）。
```

---

## U2 · 「非全下加注仍可被启发式覆盖」这一取舍

```text
问题是什么：      上一轮规范第 3 节字面要求「CALL EV 有效 + RAISE EV 未建模 ⇒ 不允许启发式 RAISE 覆盖 CALL」，
                 而实现把这条禁令只施加在**打光筹码**的加注上，**保留**了非全下加注的覆盖权。
已确认的根因：    INCONCLUSIVE —— 这是规则之间的一处冲突，不是计算错误：
                 · 字面执行 ⇒ AA 面对 3bet 的 4bet、深筹码河牌的暗三条加注都会被拦成 CALL；
                 · 已有契约要求这些加注可达（`test/preflopEvidencePriority.test.ts` 的 T7
                   明写「AA 面对 3bet 必须加注（价值加注必须仍然可达）」；`multiLimpIsolation` 同理）。
                 两者的唯一交点就是「该加注是否打光筹码」（`evidencePriority.ts` 的 `commitsStack`）。
实际复现证据：    · `reports/evidence/rrdv2-acceptance.txt` 对照表：
                   AA 面对 3bet → RAISE 56（`commitsStack=false`）；
                   99 河牌 400BB → RAISE 160（`commitsStack=false`）；
                   同节点 100BB → CALL（`commitsStack=true`，被拦）。
                 · 代码：`src/domain/decision/evidencePriority.ts`（`commitsStack !== true` 才保留覆盖权）。
已经验证的修复：  部分验证 —— 「打光筹码 ⇒ 无覆盖权」这条已被 V2-1 / V2-2 / V2-11 锁定；
                 「不消耗筹码 ⇒ 仍可覆盖」目前**只有** T7 与对照表作证，没有专门的回归测试。
仍然不确定的部分：该取舍是否正确 —— 即「非全下加注的启发式覆盖」应当保留还是也一并禁止。
是否改变了原有策略：是（上一轮）：打光筹码的启发式加注路径被关闭（见 U1 的三处动作变化）。
是否存在回归风险：若改成字面口径，**会**破坏 T7 与 multiLimp 的价值加注契约（需同步重写这些测试）；
                 保持现口径则风险集中在「非全下加注仍可能无 EV 地覆盖清晰 CALL」。
建议下一步：      二选一由人裁决：
                 (a) 保留现口径 + 补一条回归测试（把 T7 的契约写成显式断言）；
                 (b) 改成字面口径，并同步重新定义 T7 / multiLimp 的期望动作（需要人工确认这些
                     期望动作在新口径下仍然符合扑克策略）。
是否需要人工裁决：**是**。
```

---

## U3 · CALL 的**展示权益**与 CALL EV 不同源

```text
问题是什么：      界面/理由里的「估计权益 65.9%」与同一句里的「跟注 EV = 19.70」不是同一把尺子：
                 后者由 EqVsBetRange（44.89%）算出，前者用的是 math.heroEquity（链条后验 65.92%）。
                 读者按展示的权益复算会得到 +47.67，与显示值不符。
已确认的根因：    CONFIRMED_BUG（**呈现层**）—— 文本生成读 `math.heroEquity`，
                 而 `callEV` 读 `heroEquityVsBetRange`（TESр 09 P0-1 起就是分离的两个字段）。
                 最小复现：`reports/evidence/ak-candidate-comparison.txt` §三 +
                 `MATH_CALL_SUPPORTED` 理由文本 + 候选表 `CALL.noteZh`「当前估计权益 65.9%」。
实际复现证据：    · EqVsBetRange = 0.448857 → 0.448857 × 133 − 40 = **+19.697943**（与 math.callEV 逐位一致）
                 · math.heroEquity = 0.659153 → 0.659153 × 133 − 40 = **+47.67**（按展示权益复算）
                 · 同一句文本同时出现「65.9%」与「19.70」⇒ 不可复算。
已经验证的修复：  加注门槛已在上一轮改成与 CALL EV **同源**（`raiseReason.data.equitySource = EqVsBetRange`），
                 但 **CALL 的文本与候选注记未同步**。
仍然不确定的部分：只有一处：文本应写哪个权益？（面向用户应是「跟这一注的权益」= EqVsBetRange；
                 是否同时并列展示「整体范围权益」供参考，属呈现选择。）
是否改变了原有策略：否（纯文本口径；不改任何动作、EV 或阈值）。
是否存在回归风险：低。若改动文本，需同步 `decisionViewModel` 与相关快照断言。
建议下一步：      把 `MATH_CALL_SUPPORTED` / `CALL.noteZh` 的权益改为 `EqVsBetRange`（缺失时显式标注回落），
                 并新增一条测试：文本中的权益必须能复算出 `callEV`。
是否需要人工裁决：否（唯一合理解；但改的是用户可见文本，仍建议确认后再动）。
```

---

## U4 · Betting Range V2 的「公共强度带」系数未校准

```text
问题是什么：      下注范围的构成由一个未校准的先验决定（顶对 ×0.70、弱顶对 ×0.40、超对 ×0.85、
                 中对 ×1.00、弱对 ×0.60，外加牌面纹理系数与 softplus 软化 0.06）。
已确认的根因：    MODEL_LIMITATION —— 计算链路正确（复算与引擎逐位一致），但系数的**幅度**没有数据支撑。
实际复现证据：    · `reports/evidence/rbrv2-sensitivity.txt`：只改「顶对系数」一项，
                   CALL EV 依次为 ×0 → −22.92、×0.25 → −7.51、×0.5 → +3.91、×1 → **+19.70**、×2 → +37.47；
                   动作在 ×0.4 附近翻转；诈唬系数、中对系数的影响小一个量级。
                 · 到达范围与下注范围的权益（0.7552 / 0.4489）本身是**精确枚举**，不是抽样噪声。
已经验证的修复：  结构层已验证（非退化、序关系阶梯、不读 Hero 底牌、尺寸/牌面/画像均进入权重），
                 并已由 M1–M14 与 D-1…D-3 锁定；**幅度未校准这一事实已随结果披露**。
仍然不确定的部分：系数的真实取值；软化尺度 0.06 的取值；锚点公式（value/thin/show/bluff）本身是否合理。
是否改变了原有策略：是（RIVER BET RANGE V2 轮，已记录）：该节点 EqVsBetRange 由 0.54% 变为 44.89%。
是否存在回归风险：低（敏感性已量化；差异全部来自同一先验的不同取值）。
建议下一步：      需要外部数据源：「按手牌类别的河牌主动下注频率」。在拿到之前**不得**调参。
是否需要人工裁决：否（属于缺数据，不是方案选择）；但**调参**前必须有人确认数据来源。
```

---

## U5 · 三处测试契约变更（其中 1 处为真实放宽）

```text
问题是什么：      RIVER BET RANGE V2 / RAISE V2 两轮共改动了 4 处既有断言与 1 处测试输入，
                 其中「BLUFF_HEAVY ≤ MANIAC」的容差由 1e-12 放宽到 0.01。
已确认的根因：    INCONCLUSIVE（需人工裁决）——
                 · 3 处是**基线替换**（与「后验」比较 → 与「到达范围」比较）并同时**加强**
                   （要求两量必须不同、要求动作 ⇔ EV 符号），有证据表明它们不是放宽；
                 · 1 处（T2 容差）是**真实放宽**：实测差 0.0007pp，严格不等式在新模型下不成立，
                   因为两个原型在 aggression 上也不同，两条通道方向相反；
                 · 1 处（T13 边缘节点）是**测试输入重标定**（`bluffShareOverride` 0.9 → 0），
                   断言本身未改。
实际复现证据：    · `reports/evidence/rrda-04-regression.txt` §六·二：四个画像下
                   `betEq < arrivalEq` **严格**成立（0.316<0.478 / 0.166<0.470 / 0.054<0.459 …）；
                 · 同上：TEST 4 的动作在第二轮由 FOLD 变 RAISE，第三轮又由 RAISE 变 CALL
                   （当前 `reports/evidence/uncertainty-register-evidence.txt` 实测 CALL）；
                 · T2 容差：`test/profileRangeAdjustment.test.ts` 中 `+ 0.01` 与注释。
已经验证的修复：  这些变更本身是「让测试与新的正确基线一致」，已逐条附理由；
                 **没有**任何一处是通过删除测试、跳过测试或改预期动作来掩盖缺陷
                 （全仓计数 1,897 → 1,910 → 1,911，无 skip / 无删除）。
仍然不确定的部分：T2 那条容差是否可以换成**结构性**断言（例如只锁空气质量单调，而不再锁权益单调）；
                 TEST 4 / T13 的期望动作是否需要人工确认符合扑克策略。
是否改变了原有策略：否（都是测试契约；产品行为的变化另行记录在 U1/U4）。
是否存在回归风险：若把 T2 容差收回 1e-12，测试会红 —— 而那不是产品退化，是断言过强。
建议下一步：      (a) 把 T2 的权益单调改为「诈唬质量单调 + 权益不得显著反向」；
                 (b) TEST 4 / T13 的期望值由人工确认后写死并注释依据。
是否需要人工裁决：**是**（涉及「测试该锁什么」的判断）。
```

---

## U6 · 决策层其余部分仍读 `math.heroEquity`

```text
问题是什么：      同一节点上，加注门槛与 CALL EV 已统一到 EqVsBetRange，但
                 相对牌力角色（roleStrength）、tier、价值守门器（gate）、范围压缩仍读 math.heroEquity（后验）。
                 同一份决策里存在两个「他下注后我领先多少」的估计（0.6592 vs 0.4489，差 21.03pp）。
已确认的根因：    MODEL_LIMITATION（口径共存）—— 两者都已如实分列（`conditionalEquities`），
                 不是静默替代；但它们在决策层被**同时**使用。
实际复现证据：    · `reports/evidence/ak-candidate-comparison.txt` §三：三个权益分列且数值不同；
                 · `reports/RIVER_RAISE_DECISION_AUDIT.md` §五：TEST 09 节点 22.55%（后验）vs 31.63%（下注范围）。
已经验证的修复：  加注门槛的统一已由 V2-5 锁定（`edge` 与所声明的条件权益自洽）。
仍然不确定的部分：roleStrength / gate 是否也应改用下注范围权益 —— 这会改变相对牌力角色与守门器结论，
                 进而可能改变多个节点的动作（属「会改变扑克策略」）。
是否改变了原有策略：否（本轮未动）。
是否存在回归风险：若统一，风险集中在角色分类与 gate 结论的连锁变化（需逐节点对照）。
建议下一步：      先做**单变量对照实验**（只换角色/gate 的权益输入），量化有多少节点的动作会变化，
                 再决定是否统一。
是否需要人工裁决：**是**（若对照显示动作变化不可忽略）。
```

---

## U7 · 结构性常数未校准

```text
问题是什么：      `RAISE_EDGE_STRONG = 0.15`、`RAISE_EDGE_ANY = 0.30`、`MAX_RAISE_TO_POT_RATIO = 2.5`、
                 `MIN_CATEGORY_FOR_LARGE_RAISE = 3`、`MODEL_UNCERTAINTY_RATIO = 0.05`、
                 softplus 软化 0.06、带系数阶梯 —— 全部是结构性判断，没有统计支撑。
已确认的根因：    MODEL_LIMITATION —— 代码注释已声明「结构性判断，不是从数据估出的参数」。
实际复现证据：    `src/app/decision/decisionEngine.ts`（常数定义处的注释）+
                 `reports/evidence/rbrv2-sensitivity.txt`（软化与带系数的影响幅度）。
已经验证的修复：  本轮只让**判据变精确**（`consumesStack` 取代比例近似），没有重新标定任何取值。
仍然不确定的部分：这些阈值的真实取值。
是否改变了原有策略：是（`MIN_CATEGORY_FOR_LARGE_RAISE` 的**触发条件**变了：现在能拦真正的全下）。
是否存在回归风险：低（触发更精确，且带 `hasOwnEV` 例外）。
建议下一步：      与 U4 合并取数：拿到真实频率后再谈标定。
是否需要人工裁决：否（缺数据）。
```

---

## U8 · 审计用「影子模块」的漂移风险

```text
问题是什么：      `scripts/__shadow-contextBuilder.ts` 是从产品源码机械生成的副本
                 （只改相对导入路径 + 追加 export），用于读取上下文内部对象。
                 若产品源码变化而影子未同步，基于它的一切审计数字都会失真。
已确认的根因：    MODEL_LIMITATION（工具链）—— 生成脚本 `scripts/__make-shadow.ts` 是唯一入口，
                 且已核实**产品代码与测试都不 import 它**（只有审计脚本用）。
实际复现证据：    `Select-String src/**/*.ts test/*.ts -Pattern '__shadow'` → 无匹配；
                 `scripts/rbrv2-sensitivity.ts` 首行做「本地复算 vs 引擎」逐位一致性校验并通过。
已经验证的修复：  每个用它的脚本都在输出里做一次「与引擎逐位一致」的校验（失败即整份证据不可信）。
仍然不确定的部分：是否值得把该影子模块改为「运行时从源码生成」以确保永不过期。
是否改变了原有策略：否。
是否存在回归风险：无（不影响产品）；但**证据可信度**依赖每次重新生成。
建议下一步：      在影子模块头部写明「必须先生成再使用」，或让消费脚本自动调用生成器。
是否需要人工裁决：否（工程卫生，随时可做）。
```

---

## U9 · 面对加注的响应：跟注桶随尺寸**非单调**（锯齿）

```text
问题是什么：      「加注越大 ⇒ 他越少跟注」在模型里**不成立**。跟注概率是尺寸的锯齿函数：
                  在弃牌率的每一段平台上它一路上升，跨过一整档强度时骤降。
                  后果直接进入 RAISE EV：`P(跟) × (EqVsRaiseCallRange × 终池 − 增量)` 被抬高。
已确认的根因：    MODEL_LIMITATION（结构性副作用，**不是**计算错误）——
                  弃牌判定是「继续指数 ≥ 价格 + 余量」的阈值判定，而继续指数只有 9 档
                  ⇒ 弃牌率是阶梯函数；与此同时再加注门槛（价格 + 0.2）**随价格一起上移**，
                  把「还能继续、但不再够格再加注」的中强牌从再加注桶搬进跟注桶。
                  由于 `P(跟) = 1 − P(弃) − P(再加注)`，两项同时下降 ⇒ 第三项必然可以上升。
实际复现证据：    · `reports/evidence/u1-response-monotonicity.txt`（**U1 P0 修复后重新测得**，
                    价格门槛下降 ⇒ 更多中强牌越过继续线，锯齿**幅度变大**）：
                    AK·CS 加注至 80→100：跟 47.62%→**65.16%**（+17.5pp）；AK·MANIAC 最大 +21.7pp；
                    AK·NORMAL +20.0pp；99 暗三条同样存在。
                    合成等权范围：跟 0.3699 → **0.4900** → 0.3704（先升后降）。
                  · 三条**数学确定**的单调性（弃 ↑、继续 ↓、再加注 ↓）仍然无一次违反。
                  · 测试：`test/raiseResponseU1.test.ts` U1-2 只锁这三条；U1-2b 是**变更探测器**
                    （锯齿消失会故意变红，强制回来更新本条）。
已经验证的修复：  **未修复**，且**不应**在没有裁决的情况下修：两种可辩护的实现都会改变所有节点的 RAISE EV：
                  (a) 再加注门槛改成与价格无关的绝对强度阈值；
                  (b) 再加注份额按「继续范围内的相对分位」而不是绝对强度。
                  修任何一个都等于重新标定策略参数（政策第 2.3 条禁止）。
仍然不确定的部分：① 锯齿的真实幅度是否可接受（修复口径后最大约 +21.7pp，**比修复前更大**）；
                  ② 是否值得为「单调性」牺牲现有口径（现有口径在**单手提价**的意义上是对的：
                    价格越差，同一手牌越不该再加注）；
                  ③ 是否应改为「跟注桶也用条件分布重算」而不是硬阈值。
是否改变了原有策略：口径修复轮**未**改动本项（锯齿由系数与阈值决定，不由资金口径决定）。
是否存在回归风险：不修 ⇒ 大尺寸 RAISE EV 可能被高估。已在 U1 的「仍然不确定」里联动披露。
建议下一步：      做单变量对照实验：把 (a)/(b) 各实现一版，量化「多少节点的动作会变」，
                  再决定是否采纳；在此之前**不得**改。
是否需要人工裁决：**是**（会改变扑克策略）。
```

---

## U10 · 加注 EV 与「未评估动作」披露自相矛盾 —— **已修复（呈现层）**

```text
问题是什么：      U1 落地后，产品一边**用加注 EV 做决策**，一边告诉用户「加注 EV 未实现」：
                  99 暗三条节点动作 = RAISE @174（依据 MODEL_EV +140.01），
                  同一份诊断的 `unevaluatedActions` 却列着「RAISE 174 RAISE_EV_NOT_IMPLEMENTED」，
                  并且 `factReasons` 里还输出「本次加注/全下**没有** EV 模型」。
已确认的根因：    CONFIRMED_BUG（呈现层）—— `unevaluatedActions` 用 `candidate.ev === null`
                  当作「没有 EV 模型」的代理，而**加注候选的 `ev` 字段永远是 null**
                  （加注 EV 挂在 `actionEvidence` 上；CALL 候选则确实有数值）。
                  该字段在 U1 落地时未被同步更新。
实际复现证据：    · 修复前：`reports/evidence/u1-raise-fields-probe.txt` 的旧版本记录
                    `unevaluatedActions` 含 5 个金额（80/100/120/160/**174**）；
                  · 修复后（同一脚本，当前证据文件）：只剩 80/100/120/160，
                    `allInGuard.raiseSizesWithOwnEV = [174]`；
                  · 测试：`test/riverRaiseDecisionV2.test.ts` V2-15（V2-16 锁同源的生产路径）。
已经验证的修复：  已在 `decisionEngine` 里把「真正有自有可比 EV 的加注尺寸」从
                  `pickCandidate`（唯一知道尺寸是否与事实包匹配的地方）经 `evidenceOut.raiseShape`
                  单一事实来源带出，`unevaluatedActions` 与 `allInGuard` 共用它；
                  `factReasons` 的文案在有 EV 时改为「**部分**加注金额没有 EV」。
                  **没有**改动任何 EV、门槛或动作选择逻辑（纯披露层）。
仍然不确定的部分：首屏理由 `decision.reasons` 被 `slice(0, 6)` 截断 —— 这条事实理由
                  **可能进不了首屏**（AK 节点实测首屏 6 条里没有它）。是否需要把披露挪进
                  必显位置，属呈现层选择，**未**擅自改。
是否改变了原有策略：否（纯披露）。
是否存在回归风险：低（V2-6 / V2-14 仍然通过：其余金额确实未建模，披露未被清空）。
建议下一步：      若要保证披露一定可见，需要改首屏理由的选取规则（另议）。
是否需要人工裁决：否（唯一合理解：不得声称「没有 EV 模型」而同时使用该 EV）。
```

---

## U11 · 首屏理由与最终动作相互矛盾（「加注的 EV 无法计算」/「跟注 EV 更高」）—— **已修复（呈现层）**

```text
问题是什么：      U1 之后，首屏理由与证据表相互矛盾，**两处**：
                  · 加注**胜出**侧（99 暗三条）：`[STRATEGIC_RAISE_FOR_VALUE] … ⚠️ 加注的 EV 无法计算`
                    —— 而该动作正是**由** RAISE EV +140.01 选出的；
                  · 加注**落败**侧（AK 河牌）：`[RAISE_STRATEGIC_CANDIDATE] … EV = NOT_AVAILABLE
                    （缺 fold-to-3bet / call-3bet / 4bet 响应数据）`
                    —— 而同一份证据表里明明有 `RAISE MODEL_EV = −5.4475 < CALL +19.6979`。
                  · 另：`[MATH_CALL_SUPPORTED] … ⇒ **跟注 EV 更高**` 未声明比较范围，
                    读起来像 CALL 优于 RAISE。
已确认的根因：    CONFIRMED_BUG（呈现层）—— RAISE 的两条分支（胜出 / 落败）都只认
                  「隔离加注模型 `isoUsable`」与「战略启发式」两条路径，
                  U1 的 `raiseModelUsable` 没有对应分支 ⇒ 落进「没有 EV」的旧文案。
                  「**算过但更低**」与「**没算过**」是两件事（结论 vs 能力缺口），不能共用一句话。
实际复现证据：    · 加注胜出侧修复前：`reports/evidence/u1-raise-fields-probe.txt` 旧版本第 2 节点
                    首屏第 5 条 =「加注的 EV 无法计算」；
                    修复后 = `[RAISE_MODEL_EV] 加注到 87.0BB：**面对加注的响应模型 EV** = 140.01 筹码
                    vs 跟注 79.22 筹码（同一零点 = 弃牌 0）… 弃 10.2% / 跟 89.8% / 再加注 0.0%`。
                  · 加注落败侧修复前：`reports/evidence/rrdv2-acceptance.txt`（旧）
                    `[RAISE_STRATEGIC_CANDIDATE] RAISE（87.0BB）：… EV = NOT_AVAILABLE`；
                    修复后 = `[RAISE_MODEL_EV_LOSES] RAISE（87.0BB）：**有**面对加注的响应模型 EV = -5.45 筹码
                    ⇒ 本次比较是**算出来的**：跟注 19.70 更高 ⇒ 不加注（⚠️ … 未经统计校准；再加注分支取下界 …）`。
                  · `MATH_CALL_SUPPORTED` 末尾追加「（本句只比较 CALL 与 FOLD）」。
                  · 测试：`test/riverRaiseDecisionV2.test.ts` V2-15 后半段（加注胜出侧）
                    与 **V2-17**（加注落败侧：理由不得含 `NOT_AVAILABLE`、EV 必须与证据表复算、
                    且必须随结论披露「未经统计校准」）。
已经验证的修复：  新增两条 RAISE 理由路径 `RAISE_MODEL_EV`（胜出）与 `RAISE_MODEL_EV_LOSES`（落败），
                  文案如实报出模型 EV / 跟注 EV / 响应权重 / 未校准声明 / 下界说明；
                  `MATH_CALL_SUPPORTED` 只补一句作用域声明。**未**改动任何数值与动作选择。
仍然不确定的部分：启发式路径的文案 `STRATEGIC_RAISE_FOR_VALUE` / `RAISE_STRATEGIC_CANDIDATE`
                  （真正无 EV 时）保持不变是否正确 —— 保持，因为那条路径上「EV 无法计算」确实是事实。
是否改变了原有策略：否（纯文案 + 理由代码；`data` 新增字段为附加信息）。
是否存在回归风险：低。`riverRaiseDecisionAudit.test.ts` RD-1 在 `ev !== null` 时本就跳过；
                  V2-5 的加注理由查询在翻前 AA 节点（启发式路径）上不受影响。
建议下一步：      把「理由里的数值必须能复算出证据表里的同一 EV」写成通用契约（已由 V2-17 起步，
                  U3 的 CALL 展示权益是同一族的下一处）。
是否需要人工裁决：否。
```

---

## U12 · F-01 节点动作：CALL → **RAISE**（口径修复后回到加注，但差距在容差带内）

```text
问题是什么：      F-01（翻牌 K72、Hero K♦K♣、BB 下注 6BB）的动作经历了两轮变化：
                  U1 实现轮 RAISE → CALL；**U1 P0 口径修复轮又回到 RAISE**。
                  最终动作与「旧动作」一致，但**依据完全不同**（旧的是无 EV 的启发式）。
已确认的根因：    INCONCLUSIVE（需人工裁决）——两轮变化分别来自：
                  · U1 实现轮：加注有了模型 EV，而当时 EV 用错口径 ⇒ 647.19 < CALL 1205.29 ⇒ CALL；
                  · P0 修复轮：口径修正后 RAISE EV 1226.73 > CALL 1205.29 ⇒ RAISE。
                  ⚠️ 但差距只有 **21.44 筹码**，**小于**决策层自己的跨动作容差带
                  （`5% × winnable` ≈ ±92.5）⇒ 这是**边缘决策**，不是「加注明显更好」。
实际复现证据：    · `reports/evidence/u1-audit-ev-convention.txt`：修复前 RAISE 647.191821 / 修复后 1226.726791
                    （CALL 1205.291667 两轮不变，逐位一致）；差距 21.44 < 容差带；
                  · `reports/evidence/u1-response-monotonicity.txt`：该节点 P(跟) 0.0244 → 0.0364、
                    EqVsRaiseCallRange 0.965392 → 0.941650（概率随价格一起重算，未沿用旧值）；
                  · 测试：`test/raiseEvCashflowP0.test.ts`（P0-1…P0-9 / M1–M4 / GATE）。
已经验证的修复：  账目本身已修（见 `reports/U1_RAISE_EV_P0_FIX_REPORT.md`）。
                  「RAISE 可达」由 V2-16（99 暗三条，差距 95.18 > 容差带，清晰结论）继续保证。
仍然不确定的部分：① 「差距在容差带内的加注」应当如何呈现与使用 —— 现在引擎会按
                    `crossActionInconclusive` + 战略启发式打断给出 RAISE，这在**三条**（类别 4）上
                    符合扑克直觉，但同机制在边缘牌上是否也会给出加注，本轮**未做全节点扫描**；
                  ② F-01 的期望动作本身是否需要人工确认（旧契约是「三条必须加注」）。
是否改变了原有策略：**是（本轮）**：flop KK 面对 6BB 从 CALL 变回 RAISE（按新的、正确的口径）。
是否存在回归风险：中。「跟随容差带内的 EV 差距」可能在其他节点改变动作；
                  本轮只抽了 5 个深度节点，**未**做全量扫描（列为下一步第一件事）。
建议下一步：      (a) 全节点扫描：统计口径修正导致的动作变化清单；
                  (b) 由人确认「容差带内的加注」的呈现方式（是否应标注为边缘并给出跟注备选）。
是否需要人工裁决：**是**。
```

---

## 附：已确认并已修复（不在上表）

| 项 | 结论 | 报告 |
|---|---|---|
| 河牌当前 BET 似然被计两次 | `CONFIRMED_BUG` → 已修（单一计费路径 + 尺寸不变性锁定） | `reports/RIVER_BET_RANGE_V2_REPORT.md` |
| SHOWDOWN 整类被夹到 0 | `CONFIRMED_BUG` → 已修（公共强度带 + 非退化变换） | 同上 |
| 下注权重读 Hero 隐藏底牌 | `CONFIRMED_BUG` → 已修（权重与解释解耦） | 同上 |
| 无 EV 的启发式加注覆盖清晰 CALL | `CONFIRMED_BUG` → 已修（覆盖权限按 `commitsStack` 收窄） | `reports/RIVER_RAISE_DECISION_V2_REPORT.md` |
| 一对牌无 EV 全下 | `CONFIRMED_BUG` → 已修（精确打光判定 + 牌力类别 + 自有 EV 例外） | 同上 |
| `RAISE(全下)` 与 `ALL_IN` 同额重复 | `CONFIRMED_BUG` → 已修（候选去重 + `actionShape`） | 同上 |
| 「未评估的合法动作」未披露 | `CONFIRMED_BUG`（呈现层）→ 已修（逐候选列出） | 同上 |
| 加注 EV / 面对加注的继续范围不存在 | `NOT_IMPLEMENTED` → 已实现（U1 轮；残余见上表 U1/U9） | `reports/U1_RAISE_EV_REPORT.md` |
| 「未评估动作」清单把**有 EV 的**加注金额也列进去 | `CONFIRMED_BUG`（呈现层）→ 已修（`raiseSizesWithOwnEV` 同源） | 同上（U10） |
| 首屏理由称「加注的 EV 无法计算」而动作正由该 EV 选出 | `CONFIRMED_BUG`（呈现层）→ 已修（`RAISE_MODEL_EV` 路径 + 作用域声明） | 同上（U11） |

**登记轮自身的产品改动：无。** U1 轮的产品改动只有三类：① 新增面对加注的响应模型与加注 EV；
② 两处**呈现层**一致性修复（U10/U11，不改任何数值与动作选择）；
③ `src/app/manualInput/raiseResponse.ts` 的新文件登记。
