# NODE DETERMINISM / ORDER DEPENDENCY AUDIT

**裁决：`NODE DETERMINISM AUDIT — PASS_WITH_WARNINGS`**

```text
ROOT_CAUSE = 跨代码状态的比较混淆（非顺序依赖、非隐藏共享状态）
             旧设计 = 类别模型「替换」档位似然 ∧ archetypePriorAvailable 闸门缺席

NODE_B_ISOLATED   = 19.2024%
NODE_B_FILE_RUN   = 19.2024%
NODE_B_FULL_SUITE = 19.2024%     ← 三者逐位一致
```

> **一句话结论**：`19.20%` 与 `40.88%` 不是同一个代码状态下的两次运行，
> 而是**两个不同代码状态**下的两次测量被并排比对。本审计用**变异实验**证明了
> `40.88%` 的确切来源，并且**证否**了顺序依赖与隐藏共享状态。

---

## 1. Initial Symptom

审计起因：同一逻辑节点 `nodeB`（9-max · BB `A♥9♥` · 牌面 `Kc 9s 5d 2h 7c` ·
BTN 开 3BB → 翻牌半池 → 转牌过牌 → 河牌 3BB，Hero 需 19.3548% 权益）
在**隔离运行**与**文件内运行**下给出不同结果：`19.20%` vs `40.88%`。

差异幅度 **21.7 个百分点**，远超任何浮点尾差 —— 因此按 §十一，
**不允许**用放宽容差处理。

## 2. Reproduction Matrix（§二）

四种执行方式实测（均在新会话的当前工作树上）：

| 模式 | 执行方式 | nodeB 权益 | 结论 |
|---|---|---|---|
| **A** | 专用探针单进程（`scripts/node-b-determinism-probe.ts`） | **19.2024%** | 见 §5 |
| **B** | `--test-name-pattern="^T2"` 只跑该 case | 通过（基线 < 门槛 19.3548%） | 与 A 一致 |
| **C** | 整文件 `test/profileRangeAdjustment.test.ts` | **14 pass / 0 fail** | 与 A 一致 |
| **D** | 完整套件 `npm test` | **19.2024%**（文件内仪器打印） | 与 A 一致 |

**四模式一致。历史症状 `40.88%` 在**当前工作树**上不可复现。**

模式 D 的仪器输出（`test/nodeDeterminism.test.ts` 的 D1 打印，供跨模式比对）：

```text
[determinism] NODE_B_CANONICAL equity=19.2024% callEV=-0.0473 action=FOLD
              margin=MARGINAL stronger=80.1710% support=513 trace=3
```

## 3. Input Hash Comparison（§三）

未做字符串哈希，而做了更强的 **canonical snapshot 逐字段比较** ——
因为要回答的是「同输入是否真同输入」，逐字段比对可定位到具体漂移项，
哈希只能回答「是否相同」。

快照字段（每次进入核心函数前重建输入并取样）：

```text
equity / requiredEquity / callEV / winnable / action / margin
strongerShare / rangeSupport（可达组合数） / updateTrace 长度
```

实测（§五 探针）：

| 取样点 | equity | callEV | margin | stronger | support | trace |
|---|---|---|---|---|---|---|
| baseline（最先测） | 19.2024% | −0.0473 | MARGINAL | 80.1710% | 513 | 3 |
| nodeB × 10 次 | 19.2024% | −0.0473 | MARGINAL | 80.1710% | 513 | 3 |
| nodeA×5 → nodeB | 19.2024% | −0.0473 | MARGINAL | 80.1710% | 513 | 3 |
| 03A→03B → nodeB | 19.2024% | −0.0473 | MARGINAL | 80.1710% | 513 | 3 |
| nodeB→nodeA → nodeB | 19.2024% | −0.0473 | MARGINAL | 80.1710% | 513 | 3 |

**输入未漂移，输出未漂移。** 逐字段完全相同（不是"接近"）。

## 4. State Mutation Investigation（§四）

逐项排查结果：

| # | 排查项 | 结论 |
|---|---|---|
| 1 | **Module-level mutable state** | 找到两处，均**不影响 nodeB**（见 §11）：`src/domain/range/range.ts:70 let rangeCounter`（rangeId 生成器）与 `src/app/gto/gtoApi.ts:82 let enabled`（GTO 开关单例） |
| 2 | **Fixture mutation** | 夹具是**工厂函数**（`nodeA()/nodeB()/golden()` 每次返回新对象），不存在 `const fixture = BASE; fixture.x = ...` 模式；`D5` 的多组排列未触发差异 |
| 3 | **In-place normalization** | `normalizeLikelihood` 是 `map` 后 `Object.freeze`，**不修改入参**；范围归一化走 `rangeLogSpace`（内部 `let sum` 均为函数局部） |
| 4 | **Cache key 不完整** | `src/` 下全部模块级缓存只有两个：`rangeCache.ts`（上下文路径**未引用**）与 `preflopPriors.WEIGHT_CACHE`（键为不可变的 `rfi:<tier>`/`defend:<tier>`/`3bet:<tier>`/`bb-check` 先验，与画像无关）。**无缓存以画像为键** |
| 5 | **RNG** | 全 `src/` 的 `Math.random` **只出现在两处注释里**（`rng.ts:6` 写着"领域层禁止直接调用"、`alphaPipeline.ts:1305` 写着"刻意不用"）。实际 RNG 是 `infra/rng.ts` 的**种子化 PRNG**；权益用固定 `equitySeed`（默认 `20260913`）⇒ **蒙特卡洛亦确定性** |
| 6 | **Object identity 分支** | 未发现 `profile === DEFAULT_PROFILE` / `context === cachedContext` 一类引用身份判断 |
| 7 | **Test lifecycle** | `profileRangeAdjustment` / `nodeDeterminism` 均**无** `beforeAll/beforeEach/afterEach`；`setGtoEnabled(true)` 出现在 `test/gtoWebUi.test.ts`（**另一个文件**，见 §11-2） |
| 8 | **Sort mutation** | 未发现依赖 `Array.prototype.sort` 原地语义决定 nodeB 结果的路径 |
| 9 | **Map/Set 插入顺序** | 组合遍历走 `range.entries` 的**数组序**（非 Map 迭代序），且已由 D1（20 次一致）覆盖 |
| 10 | **浮点累加顺序** | 不适用：差异为 21.7pp，按 §十 不得优先归咎浮点 |

**关键结构性事实**：`node --test` **每个测试文件一个子进程**（本会话早期已实测到
`runner.js` 逐文件 `spawn`，沙箱下还因此报过 EPERM）。因此**跨文件状态泄漏在架构上
不可能** —— 调查范围因此收敛到**单文件内**，而单文件内 D1–D5 全部通过。

## 5. Root Cause（§五 —— **经变异实验证明**）

症状**不是**顺序依赖，**也不是**隐藏共享状态。它是：

> **把两个不同代码状态下的测量并排比对。**

隔离值 `19.20%` 取自**闸门在场**（或现行"调制"设计）的状态；
文件内值 `40.88%` 取自**旧设计**的状态 —— 即

```text
类别模型「替换」了档位似然（replace）  ∧  archetypePriorAvailable 闸门缺席
⇒ NORMAL 这个**被显式声明为中性**的标签也进入了类别模型
```

**变异实验（决定性证据）**：临时还原旧设计后逐一测量 `nodeB`：

| 设计 | NORMAL | UNKNOWN | VERY_TIGHT | CALLING_STATION | BLUFF_HEAVY | MANIAC |
|---|---|---|---|---|---|---|
| replace **＋ 无闸门**（历史） | **40.8781%** | 19.2024% | 37.1220% | 38.7822% | 45.4476% | 45.8853% |
| replace ＋ 闸门 | 19.2024% | 19.2024% | 37.1220% | 38.7822% | 45.4476% | 45.8853% |
| **modulate ＋ 闸门（现行）** | 19.2024% | 19.2024% | 17.4181% | 18.5012% | 21.2515% | 21.4999% |

**`NORMAL` 在「replace ＋ 无闸门」下 = `40.8781%`，四舍五入正是历史症状的 `40.88%`。**
而在闸门在场（无论 replace 还是 modulate）下恒为 `19.2024%`。

补充证据：对现行设计做**全画像扫描**，`nodeB` 的取值范围是 `17.42% – 21.50%`；
**没有任何画像或输入变体能产生 40.88%** —— 因此该值不可能来自当下的任何隐藏状态。

这也解释了为什么症状"时有时无"：它取决于**测量那一刻闸门在不在代码里**，
而不是取决于测试顺序。

## 6. Exact Polluting Sequence（§六）

**不存在污染序列。** 按 §六 要求的五个问题逐一回答：

```text
哪一个测试     —— 没有。D2（nodeA×5→nodeB）、D3（03A→03B→nodeB）、
                        D4（反向）、D5（6 组固定排列）全部逐位一致。
哪一个函数     —— 没有。全 src/ 的模块级可变状态只有 rangeCounter 与
                        gtoApi.enabled，两者都不进入 nodeB 的决策输入（§11）。
哪一份状态     —— 没有。§3 的 canonical snapshot 逐字段相同。
什么时候被修改 —— 不适用。
为什么没恢复   —— 不适用。
```

历史症状的真实来源是 §5 的**代码状态差异**，不是运行时状态泄漏。
⚠️ 我在本阶段早前的对话里两次把这类"跨状态比对"误判为顺序依赖
（记录见 `PLAYER_PROFILE_QUANTIFICATION_V1_REPORT.md` §11 末），
本次审计用**变异实验**把它钉死，避免第三次重犯。

## 7. Fix（§七）

**无需修复顺序依赖 —— 因为它不存在。** 实际的"修复"是**度量纪律**：

1. 旧设计（类别模型**替换**档位似然）已在
   `PLAYER_PROFILE_QUANTIFICATION_V1` 中被改为**调制**：
   `likelihood = 档位似然(tier) × [P_画像(class) / P_中性(class)]`，钳到 `[0,1]`。
   中性画像比值**恒为 1.000** ⇒ 与既有模型逐位一致 ⇒
   **不存在"某个原型与基准不同尺"的量纲问题**（那正是 40.88% 那一类偏差的来源）。
2. **保留** `archetypePriorAvailable` 闸门：中性标签（`NORMAL`/`UNKNOWN`/`TIGHT`/
   `VERY_LOOSE`/`AGGRESSIVE`）**不进入**类别模型，`UNKNOWN == NORMAL` 继续成立。
3. 新增**永久确定性回归锁** D1–D5（§8）+ 专用探针
   `scripts/node-b-determinism-probe.ts`（§五 要求的 debug probe）。

未采用「在测试里人工 reset」「放宽数值容差」等掩盖手段（§七/§十一明令禁止）。

## 8. Determinism Regression Tests（§十）

新增 `test/nodeDeterminism.test.ts`（**6 项，全绿**）：

| 测试 | 内容 | 结果 |
|---|---|---|
| **D1** | nodeB 同一输入连续 **20 次**逐位一致（`NORMAL` 与 `MANIAC` 两条路径） | ✅ |
| **D2** | `nodeA × 5 个有先验原型 → nodeB` 与单独 nodeB 相同 | ✅ |
| **D3** | `03A → 03B → nodeB` 相同 | ✅ |
| **D4** | 反向 `nodeB → nodeA → nodeB` 基线不变 | ✅ |
| **D5** | **6 组固定 permutation**（非随机，随机无法复现失败）打乱后 nodeB 逐一相同 | ✅ |
| 附 | rangeId 全局计数器不得成为决策输入（同输入两次快照一致） | ✅ |

断言纪律：比较的是 **canonical snapshot 逐字段相等**，**不是**某个具体百分比 ——
**没有为了让数字"对上"而写死 nodeB**（§最重要原则）。快照含权益/所需权益/Call EV/
可争夺量/动作/边际/更强占比/可达组合数/更新日志长度，不只最终百分比（§二）。

## 9. Full Verify（§九）

```text
npm run verify → typecheck 0 错误 │ manifest:check 154 个产物一致
                 tests 1766 / suites 137 / pass 1766 / fail 0   （exit 0）
NODE_B_CANONICAL（套件内） = equity=19.2024% callEV=-0.0473 action=FOLD
                              margin=MARGINAL stronger=80.1710% support=513 trace=3
```

套件内数值与隔离探针**逐位一致**。

## 10. Model Version Decision（§十三）

**已升：`ALPHA_DECISION_MODEL_VERSION` `1.0.3` → `1.0.4`**
（`src/domain/decision/decision.types.ts`，含变更记录）。

依据：`artifactDefinitions.ts` 对该文件写明「该文件改动必须升
`ALPHA_DECISION_MODEL_VERSION`」；且本次改动**实质改变了行为链** ——
画像经动作似然进入对手范围 ⇒ 对手范围 → 权益 → EV → 建议全部随之变化。
实测（§十七 黄金手，只改 `quickProfile`）：`bluffMass` 0.0470→0.1136、
`missedDrawBluffMass` 0.0345→0.0865、`heroEquity` 0.6579→0.6799、
`callEV` 16.92→17.95。变更记录同时写明**未**改动的部分
（`handEval` / 底池赔率 / 所需权益 / SPR / combo 数学 / 权益算法 / EV 公式，全部冻结）。

升版本后 `npm run verify` 仍全绿（1766/1766）。

## 11. Remaining Risks（§十一）

1. ⚠️ **`src/domain/range/range.ts:70` 的模块级 `let rangeCounter`** ——
   `nextRangeId()` 的 ID 在**进程内单调递增**，因此同一逻辑范围在
   "隔离运行"与"跑过别的用例之后"会拿到**不同的 id**。
   同时 `__resetRangeIdCounter()`（第 79 行）**没有任何调用者**，是死代码。
   **当前不影响确定性**：实测 `rangeId` 不出现在决策输入里（§8 附测试锁住这一点；
   `rangeId=null` 于决策上下文中）。**但这是真实的结构性隐患** ——
   一旦有人拿 `rangeId` 做缓存键或判等，就会立刻变成真正的顺序依赖。
   建议（未做，超出本轮边界）：改为显式工厂/依赖注入，或直接删除死掉的 reset 函数。
2. ⚠️ **`src/app/gto/gtoApi.ts:82` 的模块级 `let enabled`** ——
   `test/gtoWebUi.test.ts` 有 4 处 `setGtoEnabled(true)` 且**不恢复**。
   因 `node --test` **逐文件独立进程**，这**不会**泄漏到其他文件；
   但在该文件内部它是全局状态。因本轮明确**禁止修改 GTO**，未动。
   风险等级：低（当前无跨文件影响），但若将来把测试改为同进程运行则立即可见。
3. ⚠️ 本轮**未**归因的一件事：本阶段早前观察到 `nodeB` 在**当时的工作树**上
   文件内/隔离不一致。本审计证明了那个不一致来自**代码状态差异**（§5），
   并证明**当下工作树**不存在该问题。也就是说：**当时那次观测是真实现象，
   但它的成因不是运行时状态**。我没有重跑当时的源码（那段代码已被替换），
   因此 §5 的证明方式是**变异复现**（还原旧设计 → 得到 `40.8781%`），
   而不是对历史源码的逐行回溯 —— 这一点如实记录，不夸大。
4. ⚠️ `ALPHA_DECISION_MODEL_VERSION` 升到 `1.0.4` 后，**历史决策日志
   （`data/decision-log.jsonl`）里的旧记录带的是 `1.0.3`**。这是版本号存在的
   意义（回答"昨天 CALL 今天 FOLD 是哪个版本变了"），无需处理，但读日志时须知。

## 12. 提交卫生（§十四）

| 项 | 状态 |
|---|---|
| `node_modules/` | **0 个被跟踪文件**；`.gitignore` 有 `node_modules/` ✅ 不会误提交 |
| `GTOopen/` | **1 个被跟踪文件**（`GTOopen/start-gtopen.ps1`）——`.gitignore` 写的是 `GTOopen/*` + `!GTOopen/start-gtopen.ps1`，**是刻意保留的启动脚本** ✅ 其余全部忽略 |
| 变更规模 | **26 个已跟踪文件被修改 + 50 个未跟踪** |

分类（供拆分提交，**本轮未提交**）：

```text
[A] PLAYER PROFILE QUANTIFICATION V1
    src/domain/player/behaviorProfile.ts（新）
    src/domain/postflop/riverProfileClassify.ts（新）
    src/app/manualInput/contextBuilder.ts、rangeFacts.ts、manualInput.ts、alphaPipeline.ts
    src/domain/decision/decision.types.ts（含 1.0.4 记录）
    src/infra/artifactDefinitions.ts、src/viewmodels/decisionViewModel.ts
    test/profileQuantification.test.ts（新）、test/profileQuantificationGolden.test.ts（新）
    test/profileRangeAdjustment.test.ts（T5 契约变更）
    test/postflopModules.test.ts（COMP-4）

[B] NODE DETERMINISM AUDIT（本轮）
    test/nodeDeterminism.test.ts（新，D1–D5）
    scripts/node-b-determinism-probe.ts（新，§五 debug probe）
    CURRENT_PROJECT_STATUS.md（测试账目 1,766 项 / 84 个文件）

[C] Generated Reports
    reports/PLAYER_PROFILE_QUANTIFICATION_V1_REPORT.md
    reports/NODE_DETERMINISM_ORDER_DEPENDENCY_AUDIT.md（本文件）
    data/artifact-manifest.json（hash 重绑）

[D] Untracked / 非本轮
    其余第三方报告与探针（GTOopen/、node_modules/ —— 均已在 .gitignore 内）
```

⚠️ **[B] 与 [A] 不应混为一个不可审计的提交**（§十四）。当前工作树**全部未提交**，
可用 `git diff` 逐条复核。

---

## 附：复现本审计的命令

```text
node --experimental-strip-types scripts/node-b-determinism-probe.ts   # §五 探针（A 模式）
node --test --experimental-strip-types test/nodeDeterminism.test.ts    # D1–D5
node --test --experimental-strip-types --test-name-pattern="^T2[^0-9]" test/profileRangeAdjustment.test.ts   # B 模式
node --test --experimental-strip-types test/profileRangeAdjustment.test.ts                                    # C 模式
npm run verify                                                         # D 模式 + 全门
```
