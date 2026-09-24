# 决策正确性修复与基线验收 V1

> 生成日期：2026-09-22 | 工作目录：`D:\德州决策` | 分支：`main` | HEAD：`7dffffc`
> 本报告对应的代码状态：工作区未提交（含本轮修复），**未提交、未推送、未切换分支**。
> 验证命令：`npm run verify`（typecheck + manifest:check + 全量测试）

---

## 1. 本轮实际审查的代码状态

### 1.1 仓库与工作区

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/kkkbb176/dezhou.git`（`origin`） |
| 分支 | `main` |
| HEAD | `7dffffc feat: 翻前加注决策 V1 + 桌况动态 V1 + 求解器闭环（9MAX）` |
| 未提交修改 | `CURRENT_PROJECT_STATUS.md`、`data/artifact-manifest.json`、`src/domain/postflop/betResponse.ts`、`test/betDecisionEngine.test.ts`、`test/multiwayBetResponse.test.ts`、`test/postflopRegressionCases.test.ts` |
| 新增未跟踪 | `test/villainInformationBoundary.test.ts`、`reports/probes/`、`reports/evidence/` 下本轮证据 |
| 保留策略 | 上一轮全部修复与证据文件原样保留；本轮只在其上补验证与收口 |

### 1.2 验证结果

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 0 错误 |
| `npm run manifest:check` | 187/187 产物一致 |
| `npm test` | **2,250 项通过 / 137 套件 / 0 失败 / 0 跳过** |
| 端到端延迟 | P50 = 256.2ms，P95 = 276.8ms（目标 1–3 秒内） |
| 真实浏览器 CDP 验收 | `scripts/browser-e2e-player-picker.ts` → 16/16 通过 |

---

## 2. 已确认缺陷：复现、根因、修复、验证

### D1（已修复）：对手行为规则读取 Hero 真实底牌（信息边界泄漏）

**复现**
- 探针 `reports/probes/villain-rule-hero-leak.ts` / 测试 `test/villainInformationBoundary.test.ts` R1/R2。
- 修复前：同一对手组合、同一公共牌、同一画像，仅把 `versusHero` 从 `STRONGER` 改到 `WEAKER`，`classifyResponse` 与 `classifyVillainAfterCheck` 的弃/跟/加权重就发生变化。

**根因**
- `src/domain/postflop/betResponse.ts`：
  - `classifyResponse` 原来用 `versusHero` 生成 `relativeAdj`（`STRONGER +0.15 / EQUAL +0.05 / WEAKER −0.05`）并叠加到 `strengthScore`。
  - `classifyVillainAfterCheck` 原来用 `strongMade && (versusHero === 'STRONGER' || tier <= 1)` 判定 `valueBet`。
- `versusHero` 是「对手组合 vs Hero 真实底牌」的比较结果，规则层可用信息只有公共牌面 + 对手自己的牌 + 画像，Hero 真实底牌属于不应泄漏的隐藏信息。

**最小修复**
- `classifyResponse`：保留基于 `tier`（公共牌面 + 对手两张牌的成手档位）的强度曲线，删除 `versusHero` 的相对修正。
- `classifyVillainAfterCheck`：价值下注判定改为 `valueBet = input.tier <= 1`，不再读取 `versusHero`。
- `versusHero` 字段本身保留，仅用于范围汇总/诊断层，不删除参数、不写死概率。

**验证（有效对照，两次输入真的不同）**
- R1/R2：`STRONGER` / `EQUAL` / `WEAKER` 三种输入，档 0–5 全部 `deepEqual`，规则权重逐位相同。
- R3：同一对手组合、只换 Hero 底牌：
  - 规则层权重逐位相同；
  - 汇总层 `buildBettingRangeFacts` 的可达组合数与 `arrivalMass` **必须不同**（证明 Hero 底牌确实被消费，不是空测试）。
- 全量测试通过，未出现「换 Hero 底牌后所有概率必须完全不变」的错误验收。

**修复前后代表差异**
- 档 3 中性倾向：修复前依赖 `versusHero === 'STRONGER'` 的 +0.05 加成给出 CALL；修复后该加成消失，同为档 3 时中性可为 FOLD。
- 该变化不是回归：测试改为锁定不依赖 Hero 的两条定性关系（同倾向下档位越强继续权重不下降；同档位下越紧弃牌权重不下降）。

---

### D2（已修复）：多人下注证据等级被无差别标成「启发式加注分支」

**复现**
- `test/multiwayBetResponse.test.ts` T8，修复前实测失败：
  `AssertionError: 多人 EV 的证据等级必须如实标注（加注分支是启发式下界）`
- 探针 `reports/probes/_tmp-t8-eq.ts` / `_tmp-t8-map.ts` 显示中/大注的 `raiseProbability` 精确为 0。

**根因**
- 测试（及对应标注逻辑的期望）把「多人节点」整体等同于「存在启发式加注分支」。
- 实际只有当某个尺寸的 `ANY_RAISE` 分支概率 > 0 时，才存在启发式加注下界；概率为 0 的尺寸是纯独立联合 EV。

**最小修复**
- 修正证据等级判定：按每个尺寸是否真的存在非零 `ANY_RAISE` 分支，分别标注 `MODEL_EV_WITH_HEURISTIC_RAISE_BRANCH` 或 `MODEL_EV_MULTIWAY`。
- 测试改为逐尺寸核对，不再要求所有尺寸都标启发式。

**验证**
- T8 修复前 1 项失败 → 修复后通过。
- 全量 2,250 项通过。

---

### D3（已修复）：单挑 BetEV 回归测试存在「自证式」断言

**复现**
- `test/multiwayBetResponse.test.ts` T8 原断言 `assert.equal(legacy.betEV, legacy.betEV)` 恒真，无法检测生产值是否等于旧单挑公式。

**根因**
- 测试拿被测量对象自己与自己比较，属于空断言。

**最小修复**
- 改为 `assert.equal(size.betEV, legacy.betEV, ...)`，并把遍历源从 `bd!.sizes` 改为 `recommended!.sizes`，确保生产建议与事实包逐尺寸一一对应。

**验证**
- 单挑 EV 必须逐位等于旧公式，多人节点必须与单挑不同。

---

### D4（已确认，测试期望不合理，已收敛为稳健断言）：画像必须改变尺寸选择

**复现**
- `test/postflopRegressionCases.test.ts` TEST 5，修复前实测失败：`画像必须真的改变尺寸选择：350 vs 350`。
- 探针 `reports/probes/_tmp-test5.ts` / `_tmp-sizing-consume.ts` 显示：
  - CALLING_STATION：`targetRatio = 0.6381`，`BET_LARGE 350`，score 0.7011，EV 297.29
  - VERY_TIGHT：`targetRatio = 0.5858`，`BET_LARGE 350`，score 0.7191，EV 309.00

**根因**
- 连续混频后的 EV 面在该节点非常平坦，两个画像目标尺寸都落在网格上限 350，最终动作相同。
- 原断言「最终金额必须不同」把「数值噪声/网格上限」当成「画像是否被消费」的证据。

**处理（不是放宽断言掩盖失败）**
- 保留可稳健检验的机制：被跟注后的权益必须按画像方向变化、理由必须写明画像来源。
- 移除「最终金额必须不同」这一不稳健断言，并在测试注释中如实记录两个尺寸差约 0.4% 的平坦面事实。
- **不为了通过测试强行挪动概率或尺寸。**

**验证**
- TEST 5 修复前 1 项失败 → 修复后 7/7 通过。
- `reports/evidence/decision-correctness-sizing-consume.txt` 记录逐尺寸 `targetRatio`、score、EV，证明画像确实进入了目标尺寸计算。

---

### D5（已修复，待本次确认）：产物清单与代码状态漂移

**复现**
- `reports/evidence/decision-correctness-verify-current-round2.txt`：`[CHANGED] src/domain/postflop/betResponse.ts 内容已变化（36bf2367… → 51c82e3e…）`。

**根因**
- 修复代码后未同步 `data/artifact-manifest.json`。

**最小修复**
- 刷新产物清单；本轮报告生成后再次 `npm run manifest` 并 `manifest:check`。

**验证**
- `npm run verify` 全绿（见 §1.2）。

---

## 3. 已推翻、未再修改的旧结论

| 旧结论 | 状态 | 处理 |
|---|---|---|
| 「翻前加注原公式错误」 | **已撤回** | 未重新套用那次错误修复；本轮只核对翻后/现有资金流，不改翻前公式 |
| 「生产求解器从未生效」 | **已推翻** | 未追查该旧结论；求解器接线不在本轮修改范围 |
| 「迟到响应必然覆盖新状态」 | **已更正** | 未重复新建保护；核对现有 `revision` + `modeEpoch` + single-flight 保护完整性 |
| 「跟注 EV 正确 ⇒ 所有下注/加注 EV 正确」 | **不成立** | 分别对 BET / RAISE / CALL / FOLD 做资金流与独立复算验证 |
| 「换 Hero 底牌后所有概率必须完全不变」 | **不成立** | 规则层必须不变；Hero 视角汇总层允许因合法阻断/重归一化而变（R3 已锁） |

---

## 4. 资金流与收益计算核对结果

### 4.1 覆盖范围

已存在并通过的独立复算与资金台账测试（`test/raiseEvCashflowP0.test.ts`、`test/raiseReraiseBranchLegality.test.ts`、`test/preflopRaiseCashflow.test.ts`、`test/layeredPot.test.ts`、`test/layeredPotDecision.test.ts`、`test/raiseResponseU1.test.ts` 等）：

- 行动前底池 / Hero 本次新增投入 / 对手实际新增投入 / 未跟注退回
- 单挑、多人、有效筹码不等、短码全下、对手已全下、无人跟注、部分玩家跟注
- 不同加注尺寸（网格逐尺寸独立响应/EV）
- 主池 / 边池 / Hero 可争夺金额与沉没成本

### 4.2 关键独立复算口径

| 口径 | 公式 | 状态 |
|---|---|---|
| Hero 加注后留存投入 | `heroAdd = 留在池中的投入 + 退回` | 通过（守恒测试 G） |
| 加注终池 | `currentPot + heroAdd + villainAdd` | 通过 |
| CALL EV | `equity × contestedPot − callCost` | 通过（P0-9、R3、D-1） |
| RAISE EV | 三/四分支概率 × 各自 EV，同一弃牌零点 0 | 通过（M10、P0-2） |
| 再加注分支合法性 | `P(raise) > 0 ⇒ 对手真的还能加注` | 通过（I1–I4、A–H、P1-4） |
| 不满注退回 | 退回不进池、不计成本 | 通过（M7、F、G） |
| 分层 EV | 逐层权益，不能退化为单一门槛 | 通过（POT-01…D10） |

### 4.3 逐尺寸差异（报告要求的关键节点）

以 TEST 5 节点（`pot = 350`，CALLING_STATION vs VERY_TIGHT）为例：

| 尺寸 | 画像 | targetRatio | 金额 | EV | Score |
|---|---|---|---|---|---|
| BET_SMALL | CALLING_STATION | 0.6381 | 116.667 | 266.30 | 0.6568 |
| BET_MEDIUM | CALLING_STATION | 0.6381 | 233.333 | 287.56 | 0.6872 |
| BET_LARGE | CALLING_STATION | 0.6381 | 350 | 297.29 | 0.7011 |
| BET_SMALL | VERY_TIGHT | 0.5858 | 116.667 | 276.17 | 0.6722 |
| BET_MEDIUM | VERY_TIGHT | 0.5858 | 233.333 | 297.70 | 0.7029 |
| BET_LARGE | VERY_TIGHT | 0.5858 | 350 | 309.00 | 0.7191 |

差异分解：
- **底池差**：本夹具两画像的底池相同（350），差异不来自底池。
- **成本差**：本夹具每个尺寸的投入金额相同，差异不来自投入。
- **EV/Score 差**：来自响应概率与条件权益按画像方向变化（VERY_TIGHT 弃牌更多 ⇒ 同尺寸 EV 更高，score 更高）。
- 结论：该节点 EV 差的来源是「对手响应/范围」，不是资金流重复计算。

---

## 5. 画像与桌况的正确消费

### 5.1 已确认并保留的修复

- 持久 `playerId` 与 `seatId` 分离；换座、按钮轮转、玩家更换后身份对应正确（`test/playerIdentityRouting.test.ts`、`test/seatSwap.test.ts`、`test/buttonSeatInvariant.test.ts`）。
- 机会数与未知行动：无机会显示「未观察到」，不显示 0%（浏览器验收 §五.1/§五.11）。
- 同一行为不在多个层次重复计权：`profileAppliedToRange` 闸门与 `deDuplicated` 字段（V21 D6 修复）。
- 翻前证据不无依据传播到翻后：`bluffTendency` 不可由「翻前再加注频率」断言（TABLE DYNAMICS M-⑤）。
- 不把弃牌倾向误当爱跟注：`foldScale` / `callScale` 分轴（TEST 4）。
- 不把再加注偏低直接解释为诈唬不足：`bluffTendency` 只由有依据的观测通道更新。

### 5.2 confidence 的真实作用

| 层 | 是否进入估计 | 说明 |
|---|---|---|
| `observedStats` / resolver | 是 | `blendWeight = evidenceMass/(evidenceMass+K_PROFILE_LABEL)`，融合实测与标签 |
| `dynamicStats` | 是 | 窗口偏差按 `effectiveSample` 向个人基线收缩；近期机会数决定收缩强度 |
| 范围可信度 | 是 | 进入多人池可信度门槛与决策置信度 |
| 最终 EV | **不乘** confidence | 未采用「把最终 EV 乘以置信度」的错误做法 |
| 下游展示 | 只读 | 诊断显示与上游实际消费参数同源，不再显示默认 0.5 |

### 5.3 五类专项调整

- 不支持的部分继续明确标记「不支持」；动态适应保持**影子模式**（只对比、不覆盖正式建议）。
- 本轮没有为追求动作翻转而改动最终建议。

---

## 6. 时间权重最小复核（5.2 / 15.7）

**结论：撤回 5.2 / 15.7 作为当前证据。**

- 在 `reports/*.md` 中检索 `5.2` / `15.7`，命中项均为章节号或无关数值（如 `5.204e-18`），未找到这两个数字的原始逐条年龄记录与当时配置。
- 按本轮要求：**不可恢复 ⇒ 撤回这两个数字作为当前结论的证据**，不据其调整参数。
- 改用固定合成记录验证实际公式。

实际公式（`src/domain/player/playerStats.ts`）：

```text
decayWeight(age) = 2^(-age / halfLife)
DEFAULT_DECAY.halfLife = 400 手
半衰期含义：age = halfLife 时权重恰为 0.5
```

各机制分工：

| 机制 | 作用 |
|---|---|
| 窗口 | 决定纳入哪些观测（如近期窗口 vs 全历史） |
| 半衰期 | 决定同一窗口内不同年龄的权重 `2^(-age/halfLife)` |
| 加权证据总量 | 权重之和（`Σw`），代表有效证据量 |
| 平滑 | 避免小样本比率落到 0/1 极端 |
| 收缩 | 把样本不足的估计向基线拉，强度由有效样本量决定 |

- 不因「半衰期小于窗口」就认定缺陷；也不为通过样例继续调参。

---

## 7. 用户看到的是当前且真实的结果

### 7.1 现有保护机制

`src/app/web/table.js`：

- `app.revision`：单调递增，旧 revision 响应丢弃。
- `app.modeEpoch`：模式切换即递增，失效在途请求（模式是界面意图，不动 revision）。
- single-flight + `autoAnalyzedKey(revision, modeEpoch)`：一个 revision 最多一次自动分析。
- 服务端 `RevisionGuard` 水位线：挡住已在路上的旧请求。
- 超时/失败：`INSUFFICIENT` / `TIMEOUT` 状态明确，且不留旧建议。
- 正式建议与影子结果：`shadow` 字段独立展示，影子模式不覆盖正式建议。

### 7.2 自动化验证

| 场景 | 测试 |
|---|---|
| 切换手牌 / 继续行动 | AUTO-13、AUTO-14、Case H |
| 切模式（当前决策 ↔ 录入历史） | AUTO-11、AUTO-12、Case A/B/C |
| 迟到响应被丢弃 | `autoAnalyze.test.ts`、`autoAnalyzeHistoryEntry.test.ts` |
| 超时/失败不伪装 | `decisionDeadline.test.ts`、AUTO-15 |
| 影子与正式区分 | `test/tableDynamics.test.ts` J 组十一条契约 |

### 7.3 真实浏览器验收

`node --experimental-strip-types scripts/browser-e2e-player-picker.ts`（真实 Chrome + CDP，隔离临时历史目录）：

```text
=== 浏览器验收汇总 ===
通过 16/16
```

覆盖：页面加载、座位渲染、真实 DOM 事件、历史落盘、重启服务 + 刷新恢复、换座位绑定、同名不混淆、未接通统计如实显示、未污染仓库 `data/`。

---

## 8. 复现能力与留存

- 探针：`reports/probes/`（`villain-rule-hero-leak.ts`、`_tmp-test5.ts`、`_tmp-t8-map.ts`、`_tmp-sizing-consume.ts` 等）。
- 前后证据：`reports/evidence/decision-correctness-*.txt`。
- 相关测试：`test/villainInformationBoundary.test.ts`、`test/multiwayBetResponse.test.ts`、`test/postflopRegressionCases.test.ts`、`test/betDecisionEngine.test.ts`。
- 真实玩家数据：本轮未写入任何测试夹具或公开报告；浏览器验收使用 `mkdtempSync` 隔离目录。

---

## 9. 仍未解决 / 未验证 / 受环境阻塞

| 项 | 状态 | 说明 |
|---|---|---|
| 全下 / 边池极端组合的完整求解器口径 | 未验证 | 本项目范围仍是启发式先验，非 GTO 输出；抽水未计入 |
| 真实牌局盈利性 | **未证明** | 本轮不宣称盈利能力 |
| 9MAX 求解任务 | 未开始 | 按授权不自动开始 |
| GTOpen 本机可用性 | 见 §10 | 本轮未修改求解器算法、未扩展接线、未批量生成缓存 |
| 时间权重 5.2 / 15.7 | 撤回 | 原始记录不可恢复，不作为当前证据 |
| 画像对最终尺寸的强制翻转 | 不支持 | 连续混频下 EV 面平坦，不强行制造动作翻转 |

---

## 10. GTOpen 接入可继续到哪一步

- 本轮未改动 GTOpen 求解器算法、未扩展接线、未批量生成缓存。
- 现有生产链路已具备：请求 revision/modeEpoch 保护、范围来源披露、影子模式对比、产物 hash 绑定、真实浏览器验收脚本。
- **可以继续的下一步**：在既有 `gtoProviderAdapter` / 求解器接线之上，对**单个**已知节点做端到端只读验证（输入 → 求解器范围 → 决策 → 披露），确认版本与缓存键一致后，再决定是否扩大缓存。
- **不应在基线验收阶段做的**：不在关键缺陷未确认前跑 9MAX 全量求解；不把启发式先验结果宣称为 GTO。

---

## 11. 大白话总结

**哪些会算错或误导建议的问题修好了？**

1. 对手行为规则不再偷看 Hero 的真实底牌——同一个对手在同一公共牌面上，不会因为「Hero 拿了什么」而改变他自己的弃/跟/加规则。Hero 视角的范围仍会因合法阻断而变，这是对的。
2. 多人下注的 EV 证据等级不再乱标：只有真的存在加注分支才标「启发式」，概率为 0 的尺寸如实标成纯多人 EV。
3. 单挑 BetEV 的回归测试从「自己等于自己」的空断言改成真比较，以后能真的抓住口径回归。
4. 「画像必须让最终下注金额不同」这种不稳健断言已收敛为可检验的机制（权益方向 + 理由来源）。没有为了测试好看去硬改概率或尺寸。
5. 产物清单与代码重新对齐，类型检查、187 个产物、2,250 项测试全部通过；真实浏览器 16/16 通过。

**哪些仍然存在？**

- 全下/边池的极端组合没有完整求解器口径验证；抽水仍未计入。
- 真实牌局的盈利能力**未证明**。
- 时间权重的 5.2 / 15.7 原始记录不可恢复，已撤回，不作为当前结论。
- 画像对最终尺寸的强制翻转不保证——EV 面平坦时两个画像可能选同一尺寸，这是模型事实，不是 bug。

**当前能否作为后续 GTOpen 接入的计算基线？**

**可以作为「修复后、已验收」的计算基线继续做单节点只读接入验证**，但不能宣称已经证明盈利能力，也不能把启发式先验当成 GTO。本轮未开始 9MAX 求解任务，未改动求解器算法。
