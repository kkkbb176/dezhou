# 德州扑克智能决策与复盘训练系统

> 定位：**训练 + 复盘 + 决策研究**。
> 不做自动读取牌桌、自动点击下注、实时浮层或任何绕过平台规则的功能。

当前状态：**Poker Core 已冻结，权益引擎已拆分，决策管线 / 范围引擎 / 玩家画像 / 牌局环境机制已完成并端到端接通**，
并已通过**独立红队审计**（3 CRITICAL + 7 MAJOR 全部修复）。
**921 项测试全绿 + 类型检查零错误**。

- 阶段 1~3：确定性内核（牌 / 位置 / 行动 / 底池 / 筹码 / 牌型 / 数学 / 权益）
- Step 2：权益引擎拆分 + 8 秒决策硬上限
- Step 3-lite：`DecisionContext` / 阶段预算 / Abort 传播 / 七项耗时
- **Step 5A：范围引擎机制（1326 组合宇宙 / blocker / 归一化 / 贝叶斯更新 / 不可变 / 缓存 / 来源可信度）**
- **Step 5A.1：数值稳定性（对数域连乘 / Log-Sum-Exp 归一化 / 尺度不变性）**
- **Step 6：玩家画像（25 项指标 / 收缩 / 时间衰减 / 单手影响上限 / 连续维度 + 标签摘要 / 绝不直接决策）**
- **Step 6.5：牌局环境（低级别线上 / 中低级别 / 理论参考三种模式）**
- **Alpha Decision Integration：画像与环境通过 `RangeAdjustmentProvider` 真正接入 `updateRange`**
- Step 5B：**BLOCKED / NOT REQUIRED FOR CURRENT DEVELOPMENT**
  —— 引擎能表达来源，但没有任何可信数据，且**不编造**。
  此项**不阻塞**后续开发：Player Profile 的收缩机制本来就要求「向先验收缩」，
  而先验可以是启发式的（已标注 `HEURISTIC_PRIOR`）。真实范围数据到位后替换即可。
- Step 7：动态真人行为（进行中）

```
npm run verify   # 类型检查 + 全部测试（阶段验收的唯一判据）
npm run demo     # 中文命令行演示：走完一手牌并输出全部确定性计算结果
```

---

## 这个系统在做什么

不是「输入手牌 → AI 猜一个动作」，而是：

**可验证、可复盘、可解释、可测试、并且知道自己什么时候不确定的**扑克决策训练系统。

四条不可违背的原则：

1. **目标不是赢下这一手，而是长期 EV 最大化。**
   获胜概率 ≠ 最佳决策。权益 35%、跟注只需 25% 时，跟注仍是正 EV。
2. **结果绝不污染决策评价。**
   「当时决策分析」与「摊牌后分析」在数据结构层面物理隔离，赢了不代表决策对。
3. **数学真值只能来自确定性代码。**
   语言模型只负责解释，绝不参与计算；算不了就输出「暂时无法准确计算权益」。
4. **中文优先。**
   领域层只输出码值，UI 层只做映射；英文仅作为括号内的辅助小字。

---

## 文档

| 文件 | 内容 |
|---|---|
| `reports/V2_ARCHITECTURE.md` | V2 独立架构：12 层分层、依赖规则、各引擎职责 |
| `reports/MURPHY_RISK_REGISTER.md` | 墨菲风险登记册：每条风险的设防措施与验证方式 |
| `reports/TEST_MATRIX.md` | 测试矩阵：可执行的验收清单（含 Phase 4+ 待补项） |
| `reports/GITHUB_REFERENCE_AUDIT.md` | 6 个 GitHub 扑克项目的红队审计 + 独立复核记录 |
| `reports/STEP_REPORTS.md` | 阶段执行报告（Step 1 / 2 / 3-lite / 5A / 5A.1 / 6 / 6.5 / 集成） |
| `reports/RANGE_REDTEAM_AUDIT.md` | 范围引擎独立红队审计 |
| `reports/NUMSTAB_REDTEAM_AUDIT.md` | 数值稳定性独立红队审计（BigInt 精确定点验证） |
| `reports/PLAYER_REDTEAM_AUDIT.md` | 玩家画像独立红队审计（3 CRITICAL + 7 MAJOR + 13 MINOR） |
| `docs/ARCHITECTURE.md` | V1 阶段的架构与规范（历史基线） |

---

## 目录结构

```
├─ src/
│  ├─ domain/            领域层（纯函数、零 I/O、零随机）
│  │  ├─ types.ts          牌 / 位置 / 街 / 动作 / 牌型（唯一权威定义）
│  │  ├─ domainCodes.ts    全部「可翻译码值」定义（中文由 i18n 渲染）
│  │  └─ poker/
│  │     ├─ cards.ts         牌、严格解析、52 张唯一性、重复牌检查
│  │     ├─ positions.ts     座位几何、行动顺序、盲注位
│  │     ├─ handEval.ts      权威牌力引擎（9 种牌型 / A2345 / 踢脚 / 平分）
│  │     ├─ fastEval.ts      高速热路径引擎（与权威实现逐位一致）
│  │     ├─ handDescription.ts 牌力中文描述（顶两对 / J三条Q踢脚 / 打公共牌）
│  │     ├─ gameState.ts     牌局状态、账本、筹码守恒
│  │     ├─ engine.ts        行动状态机、合法性、队列重建
│  │     ├─ streetAdvance.ts 街道推进与发牌
│  │     ├─ odds.ts          底池赔率 / 最低所需权益 / SPR / EV / 尺寸网格
│  │     ├─ equity.ts        权益门面：校验 → 过滤 → 选型 → 分派（159 行）
│  │     ├─ equity.types.ts  权益共享类型 / 常量 / 容量报告
│  │     ├─ equityExact.ts   精确枚举（黄金测试与数学验证的真值来源）
│  │     ├─ equityMonteCarlo.ts 蒙特卡洛（自适应 / 可复现 / 可中止）
│  │     ├─ equityPolicy.ts  选型 + 三重提前停止判定（纯决策逻辑）
│  │     └─ validator.ts     牌局检查器（收集式校验 + 红队级拦截）
│  │  ├─ range/           范围引擎（Step 5A / 5A.1 / 6.5）
│  │  │  ├─ combo.ts          1326 组合宇宙（逐层深冻结）
│  │  │  ├─ range.ts          范围构建与冻结
│  │  │  ├─ rangeUpdate.ts    贝叶斯更新（**全程对数域**）+ 外部调整者接入
│  │  │  ├─ rangeLogSpace.ts  Log-Sum-Exp / max-shift 稳定归一化
│  │  │  ├─ rangeBlockers.ts  死牌过滤（严格表示校验）
│  │  │  ├─ rangeValidator.ts 范围校验（14 种违规码）
│  │  │  ├─ gameEnvironment.ts 牌局环境（**方向由知识层决定**；文件内数值为待校准占位）
│  │  │  ├─ profileProvider.ts 画像/环境 → 范围的唯一连接点
│  │  │  └─ handPotential.ts  启发式手牌潜力标尺（声明「不是胜率」）
│  │  ├─ knowledge/       知识来源体系（Phase 4.5）
│  │  │  ├─ knowledge.types.ts  来源/证据等级/许可证门禁 + 「不编造」硬校验
│  │  │  ├─ knowledge.ts        Fail-Closed JSON 解析 + 只读索引
│  │  │  └─ knowledgeLoader.ts  唯一文件 I/O 入口（校验失败即拒绝加载）
│  │  └─ player/          玩家画像（Step 6）
│  │     ├─ player.types.ts     25 项指标定义 + 先验表（无「理论先验」取值）
│  │     ├─ playerStats.ts      收缩 / 有效样本量 / 置信度 / 衰减 / 单手影响上限
│  │     ├─ playerProfile.ts    事件驱动增量画像 / 幂等 / 修正历史 / 深冻结
│  │     └─ playerClassifier.ts 连续维度 + 11 种标签 + 有界调整因子
│  ├─ app/               决策管线基础设施
│  │  └─ decisionDeadline.ts DecisionDeadline（软 3 秒 / 硬 8 秒）+ PhaseTimer
│  ├─ i18n/              中文词条层（唯一文案出口，i18n → domain 单向）
│  ├─ infra/
│  │  ├─ rng.ts                可复现伪随机源
│  │  ├─ artifactManifest.ts   **产物 hash 绑定**（生成 / 校验）
│  │  └─ artifactDefinitions.ts 全项目产物定义表（31 个文件 / 6 类）
│  └─ index.ts           中文 CLI 演示
├─ scripts/
│  └─ generateManifest.ts  `npm run manifest`（生成）/ `manifest:check`（校验）
├─ data/
│  ├─ knowledge/          来源注册表 + 策略规则（全部无 magnitude）
│  └─ artifact-manifest.json  全项目产物 SHA256 清单
├─ test/                 921 项测试 / 136 个套件
└─ reports/              架构 / 风险 / 测试矩阵 / 审计 / 红队
```

### 产物 hash 绑定（全项目标准）

```sh
npm run manifest        # 重新生成 data/artifact-manifest.json
npm run manifest:check  # 只校验（已接入 npm run verify）
```

**要回答的问题**：「昨天建议 CALL，今天同一手牌建议 FOLD —— 究竟是哪一个版本变了？」

31 个关键产物（Range 数据 / 环境参数 / 模型版本 / 决策常量 / 红队报告）全部绑定 SHA256。
校验会报出**具体文件**与**该文件变化会影响什么**，例如：

```
[CHANGED] src/domain/range/gameEnvironment.ts 内容已变化（18cc9e0b1d0d… → 131ea58a66a9…）。
          影响：**环境参数变化 → 三种模式的范围/似然调整幅度变化，直接影响建议**
          （这是「昨天 CALL 今天 FOLD」最可能的来源之一）
```

机制是「生成与校验共用同一套代码」，因此不存在「生成用一种方式、校验用另一种方式」的漂移。

---

## 核心不变量（都有测试保护）

1. 一副牌恰好 52 张且互不重复。
2. 筹码守恒：`Σ起始 == Σ(剩余 + 前注 + 各街投入)`。
3. 底池恒等于账本合计（单一数据源），且与用户手填值强制对照。
4. 行动顺序：翻牌前枪口位先、大盲最后；翻牌后小盲先、庄家最后。
5. 大盲在无人加注时仍有选择权。
6. 短全下加注不重开加注权（TDA）。
7. 两种牌力引擎的强度编码逐位相同。
8. 精确枚举局数 = 组合数 × C(剩余牌数, 待发牌数)。
9. 非法输入一律拦截，且**绝不静默纠正**（不会把 7♦ 自动改成 7♣）。
10. **范围更新全程在对数域**：`p × likelihood` 小到 1e-324 也不会被静默归零。
11. **归一化尺度不变**：所有权重整体缩放不改变任何概率。
12. **玩家画像绝不直接给出打法**，只能改范围权重与动作概率（结构 + 类型 + 模块三重断言）。
13. **牌局环境绝不改变牌力 / 底池 / SPR / 赔率 / 权益公式**（源码扫描 + 行为对照双重断言）。
14. **机会由牌局状态定义，绝不由玩家动作定义**（否则分母会被玩家行为偷走）。
15. **产物 hash 绑定**：31 个关键产物（Range / 环境 / 模型 / 决策 / 报告）全部绑定 SHA256，
    任何变化都会报出**具体文件**与**影响范围**。
16. **环境只有方向，没有幅度**：环境规则全部 `magnitude` 缺省；
    「有幅度必须有可推导数据」是**硬校验**而非注释。

---

## 开发过程中真实修复的 Bug（已固化为回归测试）

| Bug | 后果 | 测试 |
|---|---|---|
| 用 `1 << (4*rankIndex)` 建点数直方图（JS 位移对 32 取模） | A/K/Q/J/T/9 计数串位，牌型判断系统性错误 | `handEval.test.ts` |
| 用「位置权值」拼接关键点数 | 两对里踢脚大于小对子时顺序颠倒（983/200000 手出错） | `equity.test.ts` 差分测试 |
| 两对踢脚取到「第三个对子」的点数 | `QQTT883` 被算成踢脚 8 | `equity.test.ts` 回归 B1 |
| 四条踢脚漏掉对子点数 | `7777JJ4` 踢脚被算成 4 而非 J | `equity.test.ts` 回归 B2 |
| 精确枚举未从牌堆扣除对手底牌 | AA vs KK 权益从 82% 算成 69% | `equity.test.ts` 回归 B3 |
| clone 后仍修改原状态的玩家对象 | 账本记了一笔、筹码却没动 | `engine.test.ts` 属性测试 |
| 仅凭「投入额 < 当前注额」判断是否需行动 | 漏掉大盲的翻牌前选择权 | `engine.test.ts` |
| 自动切换街道但又要求发牌 | 「街已切换、牌未发」的错位状态 | `engine.test.ts` |
| `Object.freeze(数组)` 不冻结元素 | 一行类型安全的赋值即可污染全部组合与已缓存范围 | `rangeRedTeam.test.ts` |
| 归一化用绝对阈值 `weightSum <= 1e-9` | 全部合法的小似然被判成「范围坍塌」；尺度不变性被破坏 | `rangeNumericalStability.test.ts` |
| `updateRange` 先 `Math.exp` 回线性域再归一化 | `p × likelihood < 2.5e-324` 时组合被**静默剔除**，校验仍返回 valid | `rangeLogSpaceRedTeam.test.ts` |
| `scale = cap / maxWeight` 的单手影响上限 | 分子分母同乘 scale，**占比完全不变**，约束根本没执行 | `playerProfile.test.ts` |
| 收缩公式分母用 `n_eff` 而非 `Σw` | `adjustedRate` 越出「先验 ~ 观测」区间（200 手 40 次成功得到 0.161） | `playerProfile.test.ts` |
| 标签阈值用「入池率」与「紧度维度」比较 | 阈值改了也**不生效**；反解 22% 入池得到 4.8% | `playerClassifier.test.ts` |
| 逐 combo 的 `adjustComboWeight` 做几何均值归一 | 单元素归一恒等于 1 → 画像与环境**完全失效**（38 个组合全部返回 1） | `rangeProfileIntegration.test.ts` |
| `createProfile` 按引用存入 `DEFAULT_DECAY`，且 `freezeProfile` 漏冻结 `decay` | 一行 `decay.halfLife = 50` 永久污染**此后每个新建画像**的衰减 | `playerRedTeam.test.ts` |
| `seq` 只校验「非负整数」而非量级 | 一手 `seq=500000` 静默作废 200 手历史（adjustedRate 0.887→0.242，warnings=0） | `playerRedTeam.test.ts` |
| `amendHand` 不去重、不校验 seq | 同一手 3 条重复指标得到 `opportunities=4`，违反自身的等价契约 | `playerRedTeam.test.ts` |
| `sampleSummary` 用机会数而注释写「用有效样本量」 | 文档与实现相反；300 机会 / n_eff=22 的指标被判「样本充足」 | `playerRedTeam.test.ts` |
| 维度中立点不等于先验中心 | **先验被当成观测**：打法全程不变、仅攒更多手数，因子从 1.0000 漂到 0.9644 | `playerRedTeam.test.ts` |
| `seenHandIds` 是可变 Set | `.delete()` 后同一 handId 被二次接受，手数虚增 | `playerRedTeam.test.ts` |
| `provider.stats()` 是破坏性读取 | `updateRange` 之后返回全零，与 `providerLog` 互相矛盾 | `playerRedTeam.test.ts` |
| 未知 `comboId` 静默退化为「中等牌」 | 任意未知 id 都得到与真正中等牌逐位相同的因子 | `playerRedTeam.test.ts` |

> 这些 Bug 全部由测试或**独立红队审计**捕获，而非人工发现 —— 这就是「先确保不会算错」的实际含义。
>
> 红队的三条元层建议已落地为**表驱动不变量测试**：
> 遍历全部属性断言冻结 · 遍历全部指标断言「先验中心 → 中立」 · 对所有入口施加同一份规范化断言。
> 这样**将来新增字段/指标/入口时会自动被覆盖**，不依赖维护者记得补测试。

---

## 尚未实现（后续 Step）

动态真人行为（Step 7）· Exploit 引擎 · 决策引擎 · 多智能体对抗审查 ·
最小中文 UI · 牌局历史与回放 · 漏洞报告。

Step 5B（真实翻牌前范围数据）：**BLOCKED / NOT REQUIRED FOR CURRENT DEVELOPMENT**。

- **BLOCKED**：Phase 4.5 审计了 4 个 GitHub 项目与 6 本书，**没有一个**能提供可引用的
  翻牌前范围数据（求解器输出无法本地复现、书籍无正文、数据集权利不明）。
- **NOT REQUIRED**：Player Profile 的收缩机制本来就要求「向先验收缩」，
  而先验可以是启发式的（已标注 `HEURISTIC_PRIOR` 而非 `THEORY_PRIOR`）。
  真实数据到位后**替换 profile 对象即可，调用方零改动**。
- 因此它**不阻塞**后续 Step。本项目的立场始终是：**宁可没有数据，也不编造数据。**

详见 `reports/V2_ARCHITECTURE.md` 第 17 节与 `reports/TEST_MATRIX.md` 第 11 节。

**开发优先级**：正确性 > 数据完整性 > 数学可靠性 > 对手建模 > 动态真人模型
> 复盘能力 > 易用性 > UI 美观 > 功能数量。
