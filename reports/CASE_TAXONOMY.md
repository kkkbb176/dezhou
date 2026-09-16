# 案例分类体系 —— Phase 4.5

> **用途**：为相似检索、解释生成、训练、回归样例、红队样例提供**统一的局面命名法**。
>
> ⚠️ **三条铁律**
>
> 1. 本文件只定义**分类**，不定义**答案**。找不到「遇到这个局面就该这样打」。
> 2. 案例库**禁止**直接覆盖引擎输出（规范第 29 节）。相似案例只能提供**证据**。
> 3. `result` **不得**进入 Decision Analysis 输入（规范第 28 节）。

---

## 0. 分类的两个轴

本体系的分类由**两个正交轴**构成，任何案例都是二者的组合：

```
轴 A：局面（Spot）        —— 由牌局状态定义，与玩家动作无关
轴 B：玩家类型（Profile） —— 只是摘要标签，底层是连续维度
```

外加一层**跨轴标记**：

```
层 C：特殊情况（Special） —— Cooler / Bad Beat / Leak / Tilt 等
```

---

## 1. 轴 A：局面分类

### 1.1 翻牌前（Preflop）

| # | Spot | 中文 | 机会由什么定义（**与玩家动作无关**） |
|---|---|---|---|
| P1 | Limp | 溜入 | 轮到我行动、尚未投入筹码、且当前无人加注 |
| P2 | Iso Raise | 隔离加注 | 前面有人溜入，轮到我行动 |
| P3 | RFI（Raise First In） | 开池加注 | 前面所有人弃牌，我是第一个行动的 |
| P4 | Call Open | 跟注开池 | 前面有人开池加注，我尚未投入筹码 |
| P5 | 3Bet | 再加注 | 前面恰好有一次加注（开池） |
| P6 | Call 3Bet | 跟注 3Bet | 我开池后被人 3Bet |
| P7 | 4Bet | 4Bet | 前面已经出现 3Bet |
| P8 | Call 4Bet | 跟注 4Bet | 我 3Bet 后被人 4Bet |
| P9 | Shove | 全下 | 轮到我行动且（通常）有效筹码较浅 |
| P10 | Blind Defense | 盲注防守 | 我在盲注位，面对后位开池 |

> ⚠️ **这是本项目全部指标命名的来源**。
> 实现位于 `src/domain/player/player.types.ts` 的 `METRIC_DEFINITIONS`，
> 每条都有中文 `opportunityRule` / `successRule` 作为**可审计契约**。

### 1.2 翻牌（Flop）

| # | Spot | 中文 | 关键变量 |
|---|---|---|---|
| F1 | IP CBet | 有位置持续下注 | 位置优势、翻牌前加注者身份 |
| F2 | OOP CBet | 无位置持续下注 | 同上 |
| F3 | Check Back | 过牌跟注（跟到底） | 有位置且选择过牌 |
| F4 | Check Raise | 过牌加注 | 先过牌、对手下注、再轮到我 |
| F5 | Donk | 领先下注 | 非翻牌前加注者先下注 |
| F6 | Multiway | 多人池 | `activePlayerCount >= 3` |
| F7 | Top Pair | 顶对 | 牌力类别 + 踢脚 |
| F8 | Overpair | 超对 | 牌力类别 |
| F9 | Draw | 听牌 | 补牌数 + 听牌类型 |
| F10 | Set | 暗三条 | 牌力类别 |
| F11 | Two Pair | 两对 | 牌力类别 |
| F12 | Board Texture | 牌面纹理 | 单调 / 两色 / 彩虹 / 配对 / 连张 |

### 1.3 转牌（Turn）

| # | Spot | 中文 | 关键变量 |
|---|---|---|---|
| T1 | Blank | 空白牌 | 未改变牌力结构 |
| T2 | Overcard | 高张 | 高于翻牌所有牌 |
| T3 | Flush Completing | 成花牌 | 第三张同花 |
| T4 | Straight Completing | 成顺牌 | 连接两端 |
| T5 | Board Pair | 牌面对子 | 改变葫芦 / 三条结构 |
| T6 | Second Barrel | 连续开火 | 上一街我下注 |
| T7 | Check Back | 过牌 | 有位置且过牌 |
| T8 | Raise | 加注 | 面对下注 |

### 1.4 河牌（River）

| # | Spot | 中文 | 关键变量 |
|---|---|---|---|
| R1 | Thin Value | 薄价值 | 对手跟注范围中我仍领先的比例 |
| R2 | Polar Bet | 极化下注 | 范围两极分化 |
| R3 | Bluff | 诈唬 | 我的牌几乎无摊牌价值 |
| R4 | Bluff Catch | 抓诈唬 | 我的牌只能赢诈唬 |
| R5 | Overbet | 超池下注 | 下注额 > 底池 |
| R6 | Block Bet | 阻断下注 | 小额下注以抑制对手大额下注 |
| R7 | Check Raise | 过牌加注 | 先过牌、对手下注、再轮到我 |
| R8 | Jam | 全下 | 全下额 |

---

## 2. 轴 B：玩家类型分类

### 2.1 标签清单 —— **与代码的 `PlayerLabel` 逐字对应**

> ⚠️ **本表是交叉引用，必须与 `src/domain/player/playerClassifier.ts` 的
> `PlayerLabel` 取值集合完全一致。**
> 本文件初版列了三个人工想象但**代码中不存在**的标签
> （Maniac / Overfolder / Overbluffer），又漏了代码中的四个
> —— 这是独立红队发现的问题（F-09），已修正。
> 有一条测试断言两者一致，防止再次漂移。

| # | `PlayerLabel` 取值 | 中文 | 典型连续维度特征 |
|---|---|---|---|
| B1 | `UNKNOWN` | 未知玩家 | 样本不足（`PRELIMINARY`）→ **强制未知** |
| B2 | `ULTRA_TIGHT` | 超紧型 | 入池率极低 |
| B3 | `TIGHT_PASSIVE` | 紧弱型 | 紧 + 弱 |
| B4 | `TIGHT_AGGRESSIVE` | 紧凶型 | 紧 + 凶 |
| B5 | `LOOSE_PASSIVE` | 松弱型 | 松 + 弱 |
| B6 | `LOOSE_AGGRESSIVE` | 松凶型 | 松 + 凶 |
| B7 | `CALLING_STATION` | 跟注站 | 高被动 + 偏松 |
| B8 | `BLUFF_HEAVY` | 爱诈唬 | 诈唬倾向高 + 凶 |
| B9 | `BLUFF_LIGHT` | 很少诈唬 | 诈唬倾向低 + 偏紧 |
| B10 | `REG_AVERAGE` | 普通常客 | 各维度都在中间 |
| B11 | `REG_STRONG` | 强常客 | 中间入池率 + 凶 |

**判定顺序**（从最特征化到最一般化）：
`UNKNOWN`（样本不足）→ `CALLING_STATION` → `BLUFF_HEAVY` → `BLUFF_LIGHT` →
`ULTRA_TIGHT` → 紧松 × 凶弱四象限 → `REG_STRONG` / `REG_AVERAGE`。

### 2.2 **硬约束**（规范第 21 节）

> 这些**只能是摘要标签**。底层仍使用 **continuous profile**。

**落地方式**（三重保证，均有测试）：

1. `PlayerLabel` 是 11 个 `as const` 取值，`deriveLabel` 的输出必须落在集合内。
2. 所有调整因子由 `computeAdjustment(dimensions)` 计算，**输入是连续维度而不是标签**。
3. 有测试断言：**改变标签阈值后，调整因子逐位不变**。

### 2.3 标签与维度的映射关系（不是等号）

| 标签 | 不是「维度等于某值」，而是 |
|---|---|
| `ULTRA_TIGHT` | 入池率低于 `ultraTightVpip`（**先验中心决定的中立点之上**） |
| `CALLING_STATION` | 被动度 ≥ 阈值 **且** 入池率 ≥ 阈值 |
| `BLUFF_HEAVY` / `BLUFF_LIGHT` | 对应 `bluffTendency` 的两个极端；**零机会时强制中立 0.5**，不得因为「没数据」被标成 `BLUFF_LIGHT` |
| `REG_AVERAGE` / `REG_STRONG` | 不属于任何极端象限时的兜底分类，按凶度区分 |

### 2.4 **缺口：概念标签 vs 已实现标签**

规范第 21 节列出的概念清单包含若干**当前代码中不存在**的类型。
它们不能直接写成标签（会造成「有标签但没有维度支撑」的空壳分类），
因此登记为**待补项**：

| 规范中的概念 | 代码中是否有 | 缺口原因 | 处置 |
|---|---|---|---|
| Unknown | ✅ `UNKNOWN` | — | 已实现 |
| Nit | ✅ `ULTRA_TIGHT` | 命名不同，语义一致 | 已实现 |
| TAG | ✅ `TIGHT_AGGRESSIVE` | — | 已实现 |
| LAG | ✅ `LOOSE_AGGRESSIVE` | — | 已实现 |
| Calling Station | ✅ `CALLING_STATION` | — | 已实现 |
| Passive Recreational | ✅ `LOOSE_PASSIVE` | — | 已实现 |
| Aggressive Recreational | ✅ `BLUFF_HEAVY` | 语义近似 | 已实现 |
| **Maniac** | ❌ | 需要「极松 **且** 极凶」的双极端判定；当前 `tightness` / `aggression` 各自独立，未定义联合极端区 | ⬜ 待补：需要先定义联合阈值，否则会是空壳 |
| **Overfolder** | ❌ | **没有独立维度支撑**（只有「面对持续下注弃牌率」的原始统计，未进入维度计算） | ⬜ 待补：先把 fold-to-bet 变成一个维度 |
| **Underbluffer** | ✅ `BLUFF_LIGHT` | 命名不同，语义一致 | 已实现 |
| **Overbluffer** | ✅ `BLUFF_HEAVY` | 命名不同，语义一致 | 已实现 |

> **原则**：宁可少一个标签，也不加一个**没有维度支撑**的标签。
> 标签存在的意义是「让人更快读懂连续维度」；若它不映射到任何维度，
> 就只是装饰，且会诱导使用者以为系统「看得见」某个它其实看不见的东西。

---

## 3. 层 C：特殊情况分类

| # | Case | 中文 | 定义要点 |
|---|---|---|---|
| C1 | Cooler | 冤家牌 | 当时信息与合理范围下决策**基本正确**，但遇到范围顶部或极端强牌 |
| C2 | Bad Beat | 坏运气 | Hero 在**投入关键筹码时权益明显领先**，结果被反超 |
| C3 | Setup | 布局牌 | 双方都被牌面「设计」成必然对抗（与 Cooler 的区别：Setup 更强调牌面结构） |
| C4 | Hero Call | 英雄跟注 | 用只能赢诈唬的牌跟注大额下注 |
| C5 | Missed Value | 错失价值 | 本可获取更多价值却选择保守线路 |
| C6 | Thin Value | 薄价值 | 在对手跟注范围中仅微弱领先时下注 |
| C7 | Overplay | 过度游戏 | 用不够强的牌投入过多筹码 |
| C8 | Underplay | 过度保守 | 用很强的牌投入过少筹码 |
| C9 | Tilt | 情绪失控 | 行为偏移概率升高（**不是布尔判定**） |
| C10 | Chase Loss | 追损 | 为挽回损失而偏离基线 |
| C11 | Win Tilt | 赢后放松 | 赢大池后行为变松 |
| C12 | Bet Size Anomaly | 下注尺寸异常 | 尺寸偏离该玩家的基线分布 |
| C13 | Multiway Trap | 多人池陷阱 | 多人池中慢玩导致的陷阱局面 |
| C14 | Deep Stack Collision | 深筹码碰撞 | 深筹码下双方范围顶部相撞 |

---

## 4. Cooler / Bad Beat / Leak 三分法（规范第 23 节）

### 4.1 定义

| 类别 | 英文 | 定义 | **判据必须是** |
|---|---|---|---|
| **Cooler** | Cooler | 当时信息和合理范围下，决策**基本正确**，但遇到范围顶部或极端强牌 | Decision Snapshot 重新分析 |
| **Bad Beat** | Bad Beat | Hero 在投入关键筹码时**权益明显领先**，结果被反超 | **投入时的权益**（不是结果） |
| **Leak** | Leak | 当时已有信息**支持更优动作**，但 Hero 选择明显更差路线 | Decision Snapshot 重新分析 |

### 4.2 **结果不能定义类别**（规范第 24 节）

❌ **禁止**的推理：

```
输了大底池  →  Cooler
```

✅ **必须**的流程：

```
Decision Snapshot（当时可得的信息）
  ↓
重新分析：当时有哪些合法动作？各自的 EV 是多少？
  ↓
① EV 损失小 且 遇到范围顶部/极端强牌   →  Cooler
② 投入时权益明显领先 且 结果被反超      →  Bad Beat
③ 存在明显更优动作 且 EV 损失大         →  Leak
```

### 4.3 三者的关键区别

| 维度 | Cooler | Bad Beat | Leak |
|---|---|---|---|
| 决策质量 | 好 | 好（当时） | **差** |
| 权益状态 | 可能落后（对手范围顶部） | **投入时明显领先** | 无关 |
| 结果的作用 | **仅用于事后分类，不参与判定** | 需要结果才能称「被反超」，但**判定核心是投入时的权益** | **完全无关** |
| 是否可改进 | 否 | 否 | **是** |

> ⚠️ **Bad Beat 的微妙之处**：它需要「结果」才能叫「beat」，
> 但其**判定核心**是「投入关键筹码时的权益」。因此实现时必须
> **先算权益、再与结果比对**，而不能「先看结果、再找理由」。

---

## 5. Cooler Cluster 保护（规范第 25 / 26 节）

### 5.1 触发条件

近期**连续多个大底池损失**。

### 5.2 第一步：检查 Decision Quality

**结果差但决策质量稳定 → 不改变基础策略。**

### 5.3 第二步：检查行为偏移

| 检查项 | 信号 |
|---|---|
| Hero Call 是否增加 | 偏移 |
| 3Bet Call 是否增加 | 偏移 |
| River Call 是否增加 | 偏移 |
| Jam 是否增加 | 偏移 |
| Bet Size 是否变大 | 偏移 |

### 5.4 第三步：只有**行为同时变化**才提高概率

```
结果差 + 决策质量稳定 + 行为无变化   →  什么都不做
结果差 + 决策质量稳定 + 行为有变化   →  提高 Tilt / Chase-loss likelihood
结果差 + 决策质量下降                →  这是 Leak，进入复盘
```

❌ **禁止**：根据输钱**直接**调整策略。
✅ **必须**：通过**行为变化**间接推断。

---

## 6. 案例数据模型与 Decision / Result 分离（规范第 27 / 28 节）

### 6.1 分离的物理形式

```ts
type PokerCase = {
  // ---- 决策数据（决策分析的唯一输入）----
  decisionData: {
    id: string;
    sourceId: string;
    gameType: string;
    environment?: GameEnvironment;
    players: number;
    effectiveStackBB: number;
    heroPosition: string;
    villainPosition?: string;
    heroCards?: string[];
    board?: string[];
    actions: Action[];
    decisionStreet: Street;
    decisionQuestion: string;
    theoryAnalysis?: CaseAnalysis;
    lowStakesAnalysis?: CaseAnalysis;
    midLowAnalysis?: CaseAnalysis;
  };

  // ---- 结果数据（**不得进入决策分析**）----
  resultData?: {
    villainCards?: string[];   // 摊牌才知道
    outcome: 'WIN' | 'LOSE' | 'SPLIT';
    amountWon?: number;
    classification?: 'COOLER' | 'BAD_BEAT' | 'LEAK' | 'STANDARD';
  };
};
```

### 6.2 三条强制要求

1. **loader 必须物理分开返回 `decisionData` 与 `resultData`** —— 不是「约定不要看」。
2. `decisionData` 的类型**不得包含** `villainCards` / `outcome` 字段。
3. 有测试断言：`decisionData` 的序列化结果中**不含**任何结果字段。

### 6.3 案例库的允许用途（规范第 29 / 30 节）

| ✅ 允许 | ❌ 禁止 |
|---|---|
| 相似检索（找出相似 Spot） | 找到类似牌就直接复制动作 |
| 解释生成（「类似案例中曾出现同类策略」） | 用案例结果覆盖引擎输出 |
| 训练（出一道题） | 把案例当作「标准答案」 |
| 回归样例（防止行为漂移） | 把案例当作数学真值 |
| 红队样例（构造攻击面） | — |

**最终动作永远由 `Math × Range × Profile × Dynamic × Environment` 产生。**
案例只能**提供证据**，不能**提供结论**。

---

## 7. 与实现的关系（诚实说明当前状态）

### 7.1 翻牌前分类 vs 25 项指标的逐条对照

> 本节是**交叉引用**，最容易出错，因此逐条列出。

| Spot | 对应指标 | 状态 |
|---|---|---|
| P1 Limp | `LIMP` 翻牌前溜入率 | ✅ 已实现 |
| P2 **Iso Raise** | **无** | ⬜ **缺口**：隔离加注未被任何指标覆盖 |
| P3 RFI | `OPEN` 翻牌前开池率 | ✅ 已实现 |
| P4 Call Open | `CALL_OPEN` 面对开池跟注率 | ✅ 已实现 |
| P5 3Bet | `THREE_BET` 翻牌前 3Bet 率 | ✅ 已实现 |
| P6 Call 3Bet | `CALL_THREE_BET` 面对 3Bet 跟注率 | ✅ 已实现（同时有 `FOLD_TO_THREE_BET`） |
| P7 4Bet | `FOUR_BET` 翻牌前 4Bet 率 | ✅ 已实现 |
| P8 **Call 4Bet** | **无** | ⬜ **缺口**：面对 4Bet 的跟注/弃牌未被覆盖 |
| P9 Shove | 部分（`RIVER_RAISE` 等的「全下」计入加注） | 🟡 部分：无独立的「全下率」指标 |
| P10 Blind Defense | 部分（盲注位的 RFI / Call Open 会计入同名指标） | 🟡 部分：**未按位置分桶**，无法单独观察盲注防守 |
| — 通用 | `VPIP` / `PFR` | ✅ 已实现 |

### 7.2 轴 A 的其它分类

| 项 | 状态 |
|---|---|
| 翻牌 F1–F5（CBet / Check Back / Check Raise / Donk） | 🟡 部分：有 `CBET` / `FOLD_TO_CBET` / `CALL_CBET` / `RAISE_CBET` / `CHECK_RAISE_FLOP`；**无 Donk 指标** |
| 翻牌 F6 Multiway | ⬜ 未按人数分桶（风险 D6 已登记） |
| 翻牌 F7–F11（牌力类别） | ⬜ 未按牌力类别分桶 |
| 翻牌 F12 牌面纹理 | ⬜ 未按纹理分桶（`domainCodes.ts` 有纹理码，但未进入指标分桶） |
| 转牌 T1–T5（牌面变化） | ⬜ 未按牌面变化分桶 |
| 转牌 T6–T8 | ✅ 有 `TURN_BARREL` / `TURN_FOLD` / `TURN_RAISE` / `TURN_CHECK_RAISE` |
| 河牌 R1–R8 | 🟡 部分：有 `RIVER_BET` / `RIVER_BARREL` / `RIVER_OVERBET` / `RIVER_CALL` / `RIVER_RAISE` / `RIVER_FOLD`；**无 block bet / check-raise 指标** |

### 7.3 轴 B 与层 C

| 项 | 状态 |
|---|---|
| 轴 B 的 11 种标签 | ✅ 已实现 11 种（与代码 `PlayerLabel` 逐字对应，见 §2.1）；规范概念清单中的 `Maniac` / `Overfolder` 登记为待补（见 §2.4） |
| 层 C 的 14 种特殊情况 | ⬜ **未实现**（本文件仅建立定义） |
| Cooler / Bad Beat / Leak 判定 | ⬜ **未实现**（需要 Decision Snapshot，属后续 Phase） |
| Cooler Cluster 保护 | ⬜ **未实现**（依赖 Step 7 动态行为） |
| 案例数据模型 | ⬜ **未实现**（`data/knowledge/cases/` 目录尚未创建，因为**没有案例数据**） |

### 7.4 诚实结论

本文件是**分类体系**（命名法），不是**已实现功能**。
逐条对照的结果是：翻牌前 10 个 Spot 中 **8 个有指标覆盖、2 个是明确缺口**；
翻牌后的分类**大部分尚未分桶**。

建立它的目的是让后续实现有统一命名，**而不是宣称这些能力已经存在**。

**已登记的具体缺口**（供后续 Phase 补齐）：

| # | 缺口 | 影响 |
|---|---|---|
| 1 | 无 Iso Raise 指标 | 无法观察「面对溜入者的隔离加注倾向」 |
| 2 | 无 Call 4Bet / Fold to 4Bet 指标 | 无法观察面对 4Bet 的应对 |
| 3 | 无 Donk 指标 | 无法观察领先下注倾向 |
| 4 | 无 block bet / river check-raise 指标 | 河牌的两条重要线路不可观测 |
| 5 | 翻牌后未按牌力类别 / 牌面纹理 / 人数分桶 | 无法回答「他在干燥面 vs 湿润面的 CBet 差异」 |
| 6 | `Overfolder` 标签无维度支撑 | 该标签未启用（避免空壳分类） |

> ⚠️ 这些缺口**不影响当前正确性** —— 它们只是「暂时无法观测某些行为」，
> 而本项目的纪律是**无法观测就不给结论**（而不是猜）。
> 因此缺口的存在是**安全的**，把它们伪装成已覆盖才是危险的。

---

## 8. 分类的元规则

### 8.1 每个分类必须能回答

| 问题 | 为什么 |
|---|---|
| 这个 Spot 的**机会**由什么定义？ | 防止「分母被玩家行为偷走」（本项目已有的核心纪律） |
| 需要哪些**可观测**信息才能分类？ | 防止分类依赖不可得信息（例如对手底牌） |
| 分类**不依赖**什么？ | 明确排除 `result` |
| 相似度的**度量**是什么？ | 防止「看起来像」式的主观匹配 |

### 8.2 相似度必须明确定义

当前**尚未定义**相似度度量。可选维度（按可观测性排序）：

1. 街道 + 位置 + 人数 + 有效筹码（**最高优先级，全部可观测**）
2. 牌面纹理 + 我的牌力类别（可观测）
3. 行动序列（可观测）
4. 对手类型标签（**最低优先级** —— 因为它是摘要，且可能样本不足）

⚠️ **不作定义的理由**：在没有真实案例数据之前定义相似度函数，
等于**凭空设计一个没有验证对象的度量**。这属于规范第 17 节禁止的「无依据量化」。
