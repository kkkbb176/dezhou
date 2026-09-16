# Range Engine 红队审计报告

审计对象：`D:\德州\src\domain\range\`（10 个源文件）+ `test/combo.test.ts` / `test/range.test.ts` / `test/rangeBenchmark.test.ts`
审计角色：红队（以证伪为目标，不修改任何 `src/` 或 `test/` 文件）

---

## 一、审计方法

1. **逐行阅读**全部 10 个源文件（`combo.ts` / `range.types.ts` / `rangeProvenance.ts` / `rangeNormalize.ts` / `rangeBlockers.ts` / `range.ts` / `rangeUpdate.ts` / `rangeMetrics.ts` / `rangeValidator.ts` / `rangeCache.ts`），以及 `types.ts`、`poker/cards.ts`、`app/decisionDeadline.ts` 的依赖面。
2. **写可执行脚本证伪**：在 `tmp-redteam/` 下写 6 个一次性脚本（a~f），用 `node --experimental-strip-types` 直接跑 TS；每条假设都写成「可失败的断言」，失败即视为线索。审计结束后脚本已删除，报告内给出等价的最小复现片段。
3. **静态 + 运行双证据**：函数签名（是否有 clock 参数）+ 运行耗时/断言结果；类型层用 `tsc` 验证「某处写入是否需要类型断言」。
4. **先建基线快照**：审计中途 `rangeCache.ts`（00:04:06）与 `test/range.test.ts`（00:04:10）被并发修改（首次跑测 533 条，修改后 535 条）。全部实验均针对下表冻结快照运行，最终校验哈希未再变化。

| 文件 | SHA256 前 12 位 | 文件 | SHA256 前 12 位 |
| --- | --- | --- | --- |
| combo.ts | 13BE0208575A | rangeMetrics.ts | 7348A6B7E12A |
| range.types.ts | AF4036F914CA | rangeNormalize.ts | 7F9B1D7F5F43 |
| rangeBlockers.ts | 0E3F6D1967F7 | rangeProvenance.ts | 9CA99DE75654 |
| range.ts | 4827649E6A4B | rangeUpdate.ts | 5FD7AB9E8548 |
| rangeCache.ts | 70AE6597099D | rangeValidator.ts | F403DD56D565 |
| test/range.test.ts | D47469479B4E | test/rangeBenchmark.test.ts | 949440653415 |

**测试与类型检查（当前快照）**
- `npm test` 无法直接调用（本机 PowerShell 执行策略禁止运行 `E:\npm.ps1`），改用等价命令：
  `node --test --experimental-strip-types "test/**/*.test.ts"` → **tests 535 / pass 535 / fail 0，exit code 0**。
- `node node_modules/typescript/bin/tsc --noEmit` → **exit code 0，无类型错误**。

---

## 二、逐项结论（10 条假设）

### 假设 1：贝叶斯方向被写反
**结论：未能证伪。方向实现正确，且逐条与解析解完全一致（最大误差 0）。**

证据
- `rangeUpdate.ts:188`：
  `const value = likelihood === undefined ? 0 : entry.probability * likelihood;`
  先验用的是 `entry.probability`（不是 `rawWeight`），与 `rangeUpdate.ts:5` 的公式声明一致；随后 `normalizeWeights` 归一，单调性不会被破坏。

复现（`tmp-redteam/a-*.ts` 断言）
- 先验 `{AA:1, KK:1, 72o:1}` + Hero 死牌 As/Kd → 18 组合。
- 弃牌似然 `P(FOLD|AA)=0.05, P(FOLD|KK)=0.2, P(FOLD|72o)=0.9`：
  AA `0.166667 → 0.012987`（下降），72o `0.666667 → 0.935065`（上升）。
- 反向场景 `P(FOLD|AA)=0.9, P(FOLD|72o)=0.05`：AA `0.166667 → 0.562500`（上升）。
- 对每条组合断言 `posterior == prior×L / Σ(p×L)`：`maxErr = 0`。
- 更新后回读 prior：AA 概率仍为 `0.16666666666666666`，先验未被就地修改。

### 假设 2：归一化错误（Σp≠1 / p>1 / 负值或 NaN 被静默修复）
**结论：部分证伪。**归一化本身干净，未构造出 Σp≠1 或 p>1；但存在 2 处「掩蔽」与 1 处「误判坍塌」。

证据
- 坏值不修复而是报错（正确）：`NaN/-1/-Infinity/Infinity` 四种 rawWeight 全部返回 `RANGE_VALIDATION_FAILED`（`rangeNormalize.ts:36-47, 78-87`）。
- 400 组随机权重（指数跨 1e-310~1e310）+ 极端网格（含 `5e-324`、`Number.MIN_VALUE`、`1e300`）：`max|Σp-1| = 2.22e-16`，`max p = 1`（未出现 p>1）。1326 组合均匀范围：`Σp = 0.9999999999999967`，偏差 3.33e-15。
- **[掩蔽 1] `rangeNormalize.ts:163`**：`if (!Number.isFinite(p) || p < 0) continue;`
  `probabilityMetrics([0.5, NaN, -0.25, 0.5])` → `probabilitySum = 1`（真实总和为 NaN），NaN 与负概率被直接跳过，度量对象静默失真。注释 `rangeNormalize.ts:5-6` 明确宣称「禁止静默修好」。
- **[掩蔽 2] `rangeProvenance.ts:75-81` / `rangeValidator.ts:140-141`**：`confidenceCapFor()` 对未知来源返回 `undefined`，`confidence > undefined + 1e-9` 恒为 `false`（NaN 比较），上限检查静默失效（见假设 7）。
- **[误判] `rangeNormalize.ts:98`**：`if (weightSum <= EPSILON)`。合法分布 `{AsKd:1e-10, AhKh:1e-10}` 被判定为 `RANGE_COLLAPSE`；而 `{1e-4,1e-4}`、`{1e-8,1e-8}` 正常。这与 `rangeUpdate.ts:12-16` 宣称的「先验绝对尺度不影响后验、先验等价则后验等价」相矛盾：**同一分布整体缩放 1e6 倍后语义就变了**（向上缩放不触发，向下缩放触发）。

### 假设 3：Blocker 遗漏
**结论：确认为真实缺陷（多条静默失效路径）。**容量断言全部成立，但三种「死牌表示」被静默忽略。

证据
- 容量正确：`C(52,2)=1326`、`C(50,2)=1225`、`C(47,2)=1081`；`COMBO_CAPACITY[2]=1225`、`[5]=1081`、`maxCombosForKnownCards(2/5)=1225/1081` 全部通过（`combo.ts:219-233`）。
- `RankClassWeights` 与 `ComboWeights` 两条路径均正确过滤：死牌 `[As,Kd]` → **1225**；5 张死牌 → **1081**；`uniformRange` → 1081；`Set<number>` → 1225；过滤后 `Σp ≈ 1`（`rangeBlockers.ts:110`）。
- **[缺陷 3a] `Set<string>` 死牌静默全失效**：`range.ts:76-83` 的 `isDeadCardSet()` 只检查 `.has` 是否为函数，`Set<string>{'As','Kd'}` 会被当作 `DeadCardSet` 直接使用；`dead.has(12)` 永远为 false。实测 `buildRangeFromComboWeights(全部 1326 组合, deadCards=new Set(['As','Kd']))` → **entries = 1326（应为 1225），As 组合仍在范围内**，无任何错误。
- **[缺陷 3b] 越界索引静默失效**：`deadCards = new Set([99, -3])` → **1326**（应为 1326 减去 0 张…即应报错或忽略并告警，实际是「非空集合但一张也没挡」），无错误。
- **[缺陷 3c] 大小写/合法性未校验的 Card 对象静默失效**：`cardIndex()`（`poker/cards.ts:163-166`）用 `ALL_SUITS.indexOf(card.suit)`，大小写敏感；`{rank:14, suit:'S'}` → `indexOf` 返回 -1 → **索引 = -1**（合法域 0..51），死牌过滤失效 → **1326**。对比同文件 `indexToCard()`（`cards.ts:169-174`）会严格校验并抛错，两者一致性缺失。
- **[缺陷 3d] 更新路径完全没有 blocker 入口**：见「新发现问题 MAJOR-2」。

### 假设 4：缓存 key 碰撞
**结论：未能证伪（当前快照下无法构造语义不同却同 key 的请求）。**

证据
- `rangeCache.ts:64-92` 现在会强制校验：只接受 `string`、必须匹配 `/^[2-9TJQKA][shdc]$/`、拒绝重复项（69-79 行），再排序拼接；`deadCards` 排序后拼接，顺序无关（`['As','Kd']` 与 `['Kd','As']` 同 key，命中同一缓存条目，实测 hit1=false / hit2=true）。
- 数字索引被显式拒绝（抛错，不再静默混用）；`['As,Kd']`（含逗号的伪牌）被拒绝；重复 `['As','As']` 被拒绝。
- 字段边界注入暴力搜索：对 5 个自由字符串字段两两组合、11 种注入值（含 `|`、`a=b`、`x|d=As`、`d=`、`v=1`）共构造 1210 个不同 key，**0 次语义不同却同 key**。结构上也成立：key 由 7 个固定 `x=` 前缀段拼接，注入 `|` 只会新增段而无法抵消，故不可能等值。
- 小写 `'as'` 会被**抛错拒绝**而非规范化（与 `parseCard` 接受 `AS/as/aS` 的大小写不敏感语义不一致，但因响亮失败而非静默错误命中，不构成缺陷；仅提示调用方必须先 `cardToString` 规范化）。

### 假设 5：可变性与缓存污染
**结论：确认为真实缺陷，且是整个审计中最严重的一条（CRITICAL）。**`probability` / `tags` / `provenance` / `metrics` 四层确实被冻结，但**嵌套的 `combo` 与 `indexById` 没有被冻结**，且 `combo` 是全局共享对象。

| 写入操作 | 结果 |
| --- | --- |
| `entries[0].probability = 0.99` | BLOCKED（TypeError，已冻结） |
| `entries[0].tags.push('x')` / `tags = [...]` | BLOCKED（tags 被复制并冻结，`range.ts:304`） |
| `provenance.confidence = 0.99` | BLOCKED（浅拷贝后冻结，`range.ts:310`） |
| `metrics.probabilitySum = 0` | BLOCKED（浅拷贝后冻结，`range.ts:311`） |
| `entries.push(...)` | BLOCKED |
| **`entries[0].combo.canonicalId = 'ZZZZ'`** | **成功（且无需任何类型断言，`tsc --strict` 通过）** |
| **`entries[0].combo.rankClass = 'AA'`** | **成功（同样无需断言）** |
| **`entries[0].combo.card1.rank = 99`** | 成功（类型层因 `Card.rank` 为 readonly 报 TS2540，运行时加断言即可写入） |
| **`entries[0].combo.cardIndices[0] = 0`** | **成功（`readonly` 仅是类型约束，运行时可写）** |
| **`range.indexById.set('bogus',0)` / `.clear()`** | **成功（`Object.freeze(range)` 不冻结 Map 内部）** |

污染传播（单条赋值，进程内实测）
- 根因：`range.ts:303-305` 的 `Object.freeze({ ...entry, ... })` 是**浅冻结**，`entry.combo` 仍指向 `combo.ts:147-156` 的模块级 `ALL_COMBOS` 元素；`entry.combo.card1` 更是指向 `types.ts:188-194` 的模块级 `ALL_CARDS` 元素。
- 写 `entries[0].combo.canonicalId = 'ZZZZ'` 后：
  - `COMBO_BY_ID.get('2d2c').canonicalId === 'ZZZZ'`（全局登记表被污染）；
  - 之后**新建**的任何范围 `entries[0].combo.canonicalId === 'ZZZZ'`，`validateRange` 报 `UNKNOWN_COMBO`；
  - 用 `ALL_COMBOS` 自身的键逐个重建范围直接失败：`{"ok":false,"code":"RANGE_UNKNOWN_COMBO","params":{"comboIds":"ZZZZ"}}`；
  - 缓存中已存对象同样被污染（`cache.get('k').entries[0].combo.canonicalId === 'ZZZZ'`），正是 `rangeCache.ts:10-14` 声称要防的事故。
- 写 `entries[0].combo.card1.rank = 99` 后：全局 `ALL_CARDS` 元素 rank 变为 99 → `cardIndex()` 返回 **123**（合法域 0..51），`cardToString()` 返回 `'undefinedd'`；拿这张牌做死牌建立范围得到 **1326 组合（未过滤）**——**一次赋值让全局死牌过滤对该牌永久失效**。
- 更糟的是 `isFrozen(range)`（`rangeCache.ts:196-205`）在上述污染之后仍返回 **true**，给出「已冻结」的假保证；`test/range.test.ts:564-577` 的不可变性测试也只断言了 `entry.probability` 与 `Object.isFrozen`，覆盖不到该层。

### 假设 6：全零权重被静默修好
**结论：未能证伪。**所有坍塌路径都显式失败，未发现任何 uniform/兜底替换。

证据
- `buildRangeFromRankClasses({AA:0,KK:0})` → `RANGE_COLLAPSE`（`{weightSum:0,itemCount:12}`）。
- 全部 likelihood = 0 的更新 → `RANGE_COLLAPSE`，且带 `action/actor/street/note` 诊断，不返回范围对象。
- 52 张牌全部当死牌 → `RANGE_COLLAPSE`（`条目数为 0`），不是「均匀兜底」。
- `rangeNormalize.ts:98-101`、`range.ts:126-131/199-204/254-256` 三处入口都做了零和检查；`uniformRange` 只在显式调用时产生均匀分布，且 `src/` 内没有任何「失败后回退 uniformRange」的调用点（grep 全仓 `uniformRange` 仅出现在定义与测试中）。
- 唯一沾边的问题是**误判**（见假设 2 的 MINOR：`Σw=2e-10` 的合法分布被判坍塌），属于「响亮失败于错误的理由」，不是静默修复。

### 假设 7：无来源数据被标为 THEORY_SOURCE / 置信度突破来源上限
**结论：确认为真实缺陷。**`validateProvenance` 在构造路径上完全不被调用，且对未知来源字符串彻底失效。

证据
- 构造路径不校验：`buildRangeFromComboWeights`（`range.ts:98-161`）、`buildRangeFromRankClasses`（169-233）、`freezeRangeFromPairs`（244-284）、`uniformRange`（378-388）都**没有调用 `validateProvenance`**，也不要求来源已登记（`requireProvenance` 在 `src/` 内无任何调用）。
- 实测：`{sourceType:'THEORY_SOURCE', verified:false, confidence:0.95}` → 构建**成功**，`entries[0].source==='THEORY_SOURCE'`、`confidence===0.95`、`isProductionUsable()===true`；而 `validateProvenance()` 单独调用会报「THEORY_SOURCE 必须 verified=true」。即**「把启发式冒充理论」只有调用方额外执行 validateRange 时才会被发现**。
- 实测：`HEURISTIC + confidence 0.99`（上限 0.55）→ 构建成功；`updateRange` 还会把它传播到新范围（`log.confidence = 0.99`，新范围 `entries[0].confidence = 0.99`），只有事后 `validateRange` 报 `CONFIDENCE_EXCEEDS_SOURCE_CAP`。
- **上限检查可被未知来源字符串整体绕过**：`{sourceType:'GTO_SOLVER', verified:false, confidence:1}` →
  - `validateProvenance()` 返回 **[]（0 条问题）**；
  - `validateRange()` 返回 **valid = true**（`rangeValidator.ts:140-141` 的 `cap` 为 `undefined`，比较为 NaN，永不触发）。
- 后果外溢：`{sourceType:'GTO_SOLVER', confidence:2}` 仍能构建成功，`metrics.weightedConfidence = 1.9999999999999998`（> 1 的可信度进入下游度量）。
- 注意：TypeScript 能拦住字面量，但本模块的设计前提是「范围数据放在 `data/ranges/**` 并版本化、不硬编码进引擎」（`rangeProvenance.ts:5-7`），即来源类型来自运行时数据文件——正是这条路径。

### 假设 8：存在不可中止的计算路径
**结论：确认为真实缺口。**只有 `updateRange` 可中止；其余全部不可中止（多数连 clock 参数都没有）。

| 函数 | 可中止 | 证据 |
| --- | --- | --- |
| `updateRange` | ✅ | `rangeUpdate.ts:179-201` 用 `forEachChunkAbortable`；预算为 0 的时钟 → `RANGE_DEADLINE_EXCEEDED{processedCombos:0,totalCombos:1225}`，不返回部分范围 |
| `forEachChunkAbortable` | ✅ | 每 128 个组合检查一次 `canAfford`，首个 chunk 之前就检查（实测 processed=0 即中止） |
| `buildRangeFromComboWeights` | ❌ | `range.ts:109-117` 单层 for 循环；`BuildRangeOptions`（`range.ts:50-61`）**没有 clock 字段** |
| `buildRangeFromRankClasses` | ❌ | `range.ts:180-190`；实测 1225 组合耗时 **9.22ms**，无法被打断 |
| `uniformRange` | ❌ | `range.ts:383` `ALL_COMBOS.filter(...)`，无 clock |
| `diffRanges` | ❌ | `rangeMetrics.ts:85-98` 遍历并集，无 clock；实测 2.86ms |
| `probabilityByRankClass` / `rawWeightByRankClass` | ❌ | `range.ts:354-357 / 364-367`，无 clock；实测 1.02ms |
| `densityFromCategories` | ❌ | `rangeMetrics.ts:166-171`，无 clock；实测 0.83ms |
| `validateRange` / `validateEntry` | ❌ | `rangeValidator.ts:62-199 / 224-240`，无 clock 参数；实测 3.16ms |
| `normalizeWeights` / `freezeRange` / `probabilityMetrics` / `removeBlockedCombos` | ❌ | 纯循环，无 clock |

- `rangeBlockers.ts:56-67` 的注释宣称「禁止长时间不可中断循环」「从第一天起就把遍历拆成 chunk」，但 `removeBlockedCombos`（42-54）与 `deadCardsFrom` 都是普通循环，chunk 机制实际只服务于 `updateRange`。
- 附带：默认成本估算 `estimatedComboCostMs = 0.002`（`rangeUpdate.ts:157`）与实测 ~1.41µs/组合同量级（偏保守 1.4 倍），中止粒度可接受。

### 假设 9：浮点下溢导致支持集静默减少
**结论：确认（但属浮点固有，影响有限）。**

证据
- 1225 组合先验，连续 50 次更新、AAAA 组似然固定为 `1e-7`：AA 概率 `2.455e-10 → 2.455e-73 → 2.455e-213 → 0`，**第 46 轮变为精确 0**，`supportSize 1225 → 1222`，`totalEntries` 仍为 1225；全程无错误、无告警、无诊断字段。
- 对照组 `likelihood = 0.5` 连续 50 轮：`p = 2.18e-18 > 0`，不下溢。
- 判断：第 46 轮的真实后验约 1e-322，早已低于任何有意义量级，因此**不构成「结果错误」**；但引擎没有任何「支持集正在消失」的显式信号（只能事后看 `supportSize`），标为 MINOR。

### 假设 10：多人池被错误建模（人越多权重和越小）
**结论：未能证伪（`src/` 内不存在任何按人数调整权重的代码），但「多人池必须走独立逻辑」这一文档要求实际未实现。**

证据
- `activePlayerCount` 在 `src/` 中**只出现一次**：`range.types.ts:252` 的类型定义；无任何算术分支。
- 实测同一先验/同一动作模型，`activePlayerCount = 2 / 6 / 9` 三次更新的后验**逐位相同**（AhKh 均为 `0.0008130081300812926`），`Σp` 恒为 1。
- `range.types.ts:251` 的注释写「多人池必须走独立逻辑，不得套用单挑模型」，但该字段目前只被原样写进日志（`test/range.test.ts:597` 也只断言日志回填）。即：**不是建模错误，而是「声明了要求但未实现，且静默接受 6 人上下文」**。

---

## 三、新发现的问题（按严重程度）

### CRITICAL-1　`Range` 的「不可变」只冻到第一层，可被类型安全的代码破坏全局组合宇宙
- 位置：`range.ts:299-315`（`freezeRange`）、`combo.ts:147-156`（`ALL_COMBOS`）、`types.ts:188-194`（`ALL_CARDS`）、`rangeCache.ts:196-205`（`isFrozen`）。
- 现象：`range.entries[0].combo.canonicalId = 'ZZZZ'` 与 `range.entries[0].combo.rankClass = 'AA'` **在 `tsc --strict` 下无需断言即可编译**（`ExactCombo` 字段未标 `readonly`），运行时静默成功。由于 `entries` 与 `ALL_COMBOS`/`COMBO_BY_ID` 共享同一批对象，一条赋值即可污染：全局登记表、缓存中的旧范围、之后新建的所有范围、以及用 `ALL_COMBOS` 键重建的范围（直接 `RANGE_UNKNOWN_COMBO` 失败）。
- 进一步：`entry.combo.card1` 就是全局 `ALL_CARDS` 的元素，改其 rank（加断言）→ `cardIndex()` 返回 123（越界）→ **该牌的死牌过滤永久失效（1326 而非 1225）**。
- 影响：静默产生错误结果、跨范围/跨缓存命中传播，且被污染后 `isFrozen()` 仍报 true。
- 建议方向：模块初始化时 `deepFreeze(ALL_COMBOS/ALL_CARDS)`，或 `freezeRange` 里对 `combo` 做 `Object.freeze`（共享同一对象时冻结一次即可），并给 `ExactCombo` 字段加 `readonly`；`test/range.test.ts:564` 的不可变性测试需覆盖 `combo` 层。

### MAJOR-2　动作模型「覆盖不全」被标为 `complete=true`，并静默抹掉概率质量
- 位置：`rangeUpdate.ts:102-115`（`checkActionModelCompleteness` 只统计**已声明**的 combo）、`rangeUpdate.ts:184-190`（缺失似然按 0 处理）、`rangeUpdate.ts:297-309`（`makeActionModel` 据此写 `complete`）。
- 现象：只声明 3/18 个组合的似然 → `complete = true`、`completenessNote` 缺失；更新成功，`supportSize 18 → 3`，`log.modelCompleteness.complete = true`，无任何告警。`validateActionModel`（67-94）也只校验「已声明的 combo 是否存在」，不校验覆盖率。
- 影响：下游会把严重不完整的动作模型当作完整策略使用；`RANGE_PARTIAL_ACTION_MODEL` 错误码（`range.types.ts:335`）与其中文文案（`src/i18n/zh-CN.ts:322`）**从未被任何代码路径产生**。
- 独立缺陷同源：`diffRanges` 的 `removedByBlockers`（`rangeMetrics.ts:89`）把「似然为 0 而消失」计成 blocker 移除——实测在**没有任何死牌变化**的情况下该值为 3。

### MAJOR-3　`updateRange` 没有死牌入口，翻牌后的新死牌不会被排除
- 位置：`rangeUpdate.ts:121-137`（`UpdateRangeOptions` 无 `deadCards`）、`range.ts:244-284`（`freezeRangeFromPairs` 也无 blocker 过滤）。
- 现象：用翻牌前先验（1225 组合）直接做 `street:'FLOP'` 的更新，结果仍含 **144 个与翻牌 7h/2c/9d 冲突的组合**；`validateRange(range, {deadCards: 5 张})` → `valid=false`，`DEAD_CARD_COLLISION=144`；而 `log.summary.removedByBlockers = 0`（如实反映了「没人移除」）。
- 与文档冲突：`rangeBlockers.ts:4-9` 规定顺序必须是「建立 Prior → 移除 Impossible Combos → 重新归一化 → 应用 Likelihood → 再次归一化」，引擎实现了后两步，前两步没有任何 API 组合能作用在既有 Range 上。
- 影响：一旦接入决策管线（当前 `src/` 内除测试外无调用方），翻牌/转牌/河牌的范围都会包含不可能的牌，属静默错误；现为潜在缺陷。

### MAJOR-4　死牌表示的三种非法形式被静默忽略（blocker 全失效）
- 位置：`range.ts:76-83`（`isDeadCardSet` 只看 `.has`）、`poker/cards.ts:163-166`（`cardIndex` 不校验）。
- 现象：`new Set(['As','Kd'])` → 1326（应 1225）；`new Set([99,-3])` → 1326；`{rank:14,suit:'S'}` → `cardIndex = -1` → 1326。三者都不报错。
- 影响：静默错误结果。`DeadCardSet` 是运行时无类型信息的结构，而 `rangeCache.ts:23-31` 的注释本身就承认「0..51 索引与牌面字符串两种拼写会造成错误命中」——同一风险在 blocker 侧仍敞开。

### MAJOR-5　来源与置信度校验可被绕过（含 `undefined` 上限导致的 NaN 比较失效）
- 位置：`rangeProvenance.ts:75-81`、`rangeValidator.ts:140-141`、所有构建函数（不调用 `validateProvenance`）。
- 现象：`{sourceType:'GTO_SOLVER', verified:false, confidence:1}` → `validateProvenance` 0 条问题、`validateRange` valid=true；未验证的 `THEORY_SOURCE` 与 `HEURISTIC + 0.99` 都能直接建出范围并被 `updateRange` 传播；`confidence:2` 时 `metrics.weightedConfidence = 2.0`。
- 影响：静默的元数据错误（「启发式冒充理论」「可信度突破上限」），正是规范第十三/十五/五十六节要拦的东西。

### 最小复现片段（审计脚本已删除，以下片段可独立重跑）

```ts
// 用 node --experimental-strip-types <file> 运行；<file> 放在项目根目录下的任意目录
import { uniformRange, buildRangeFromRankClasses, buildRangeFromComboWeights } from './src/domain/range/range.ts';
import { updateRange, makeActionModel } from './src/domain/range/rangeUpdate.ts';
import { testOnlyProvenance } from './src/domain/range/rangeProvenance.ts';
import { parseCardStrict } from './src/domain/poker/cards.ts';
import { COMBO_BY_ID, ALL_COMBOS } from './src/domain/range/combo.ts';
import { validateRange } from './src/domain/range/rangeValidator.ts';
const P = testOnlyProvenance('rt', '红队');
const C = (s: string) => parseCardStrict(s);

// CRITICAL-1：一条类型安全赋值污染全局
const r = uniformRange(P, [C('As'), C('Kd')]);
if (r.ok) {
  r.value.entries[0]!.combo.canonicalId = 'ZZZZ';        // tsc --strict 通过，无需断言
  console.log(COMBO_BY_ID.get('2d2c')!.canonicalId);      // 'ZZZZ'
  const r2 = uniformRange(P, [C('As'), C('Kd')]);
  console.log(validateRange(r2.value).valid);            // false, UNKNOWN_COMBO
  const cw = new Map(ALL_COMBOS.map((c) => [c.canonicalId, 1]));
  console.log(buildRangeFromComboWeights(cw, { provenance: P })); // RANGE_UNKNOWN_COMBO
}

// MAJOR-2：覆盖不全的动作模型被标 complete=true 且静默坍缩 support
const prior = buildRangeFromRankClasses({ AA: 1, KK: 1, '72o': 1 }, { provenance: P, deadCards: [C('As'), C('Kd')] });
if (prior.ok) {
  const L = new Map<string, number>();
  for (const e of prior.value.entries) if (e.combo.rankClass === 'KK') L.set(e.combo.canonicalId, 1);
  const res = updateRange(prior.value, makeActionModel('RAISE', L, P),
    { street: 'PREFLOP', action: 'RAISE', actor: 'v', actionIndex: 1, activePlayerCount: 2 });
  if (res.ok) console.log(res.value.modelCompleteness.complete, prior.value.metrics.supportSize, res.value.range.metrics.supportSize); // true 18 3
}

// MAJOR-4：Set<string> 死牌静默失效
const cw2 = new Map(ALL_COMBOS.map((c) => [c.canonicalId, 1]));
const bad = buildRangeFromComboWeights(cw2, { provenance: P, deadCards: new Set(['As', 'Kd']) as never });
console.log(bad.ok && bad.value.entries.length); // 1326（应为 1225）
```

### MINOR（汇总）
1. `rangeCache.ts:196-205` `isFrozen()` 不检查 `entry.combo` 与 `indexById`，在污染后仍返回 true（假保证；`range.ts:290-298` 的注释却宣称「必须逐条冻结 entry 对象本身」已修好该坑）。
2. `range.types.ts:376-387` `deadlineClock().isAborted` 写成 `deadline.isSettled() === false ? false : false`，**恒为 false**；实测已 `markSettled()` + 超硬上限后仍返回 false（`src/` 内暂无调用方，故仅 MINOR）。`updateRange` 只用 `canAfford`，未受累。
3. `rangeUpdate.ts:262-263` `aborted:false` / `abortReason:null` 是硬编码常量，且中止路径直接返回 `RangeFailure`（不产生日志），即**中止事件没有任何审计记录**，与「日志完整可审计」的规范要求不符。
4. `rangeNormalize.ts:163` 的 `continue` 掩蔽 NaN/负概率（见假设 2 证据）。
5. `rangeNormalize.ts:98` 用绝对阈值判坍塌，破坏尺度不变性（合法分布 `Σw=2e-10` 被误判 `RANGE_COLLAPSE`）。
6. 浮点下溢导致 support 静默减少（第 46 轮，假设 9）。
7. 中止能力未覆盖构建/diff/度量/校验路径（假设 8 表）。
8. `EPSILON` 在两个模块重复定义（`combo.ts:31` 与 `range.types.ts:23`），而 `range.types.ts:19-22` 明确要求「不允许每个模块各自定义 epsilon」；`rangeUpdate.ts:102` 又单独使用 `1e-6` 作为完整性容差。
9. 死代码/死文案：`RANGE_PARTIAL_ACTION_MODEL`、`RANGE_INVALID_LIKELIHOOD`（`range.types.ts:335/339`，i18n 已有中文字串）从未产生；`isNormalized`、`probabilitySumOk`、`mergeDeadCards`、`removeBlockedCombos`、`validateEntry`、`assertComboUniverseIntegrity`、`narrowingRatio` 等在 `src/` 内无调用方。
10. 动作模型 `ActionLikelihood.source/confidence` 被忽略，条目来源一律取 `model.provenance.sourceType`（`rangeUpdate.ts:226-230`）：似然来自 EMPIRICAL、但模型 provenance 写 THEORY_SOURCE 时，后验会被整片标为 THEORY_SOURCE。
11. `benchmark` 断言极宽（P95 < 1000ms 等，`rangeBenchmark.test.ts:270-277`），只能捕捉数量级退化；「大范围比小范围慢 1.2 倍」的断言（354 行）在极快机器上属潜在脆弱断言。

---

## 四、未能证伪的假设（明确结论）

1. **贝叶斯方向（假设 1）**：公式、方向、先验不可变性均正确，逐条与解析解误差为 0。未发现任何反向相乘或方向反转。
2. **归一化数值正确性（假设 2 主体）**：未构造出 `Σp≠1`（> 1e-9 偏差）或 `p>1` 的输入；负值/NaN/Infinity 一律显式报错，未见 `Math.max(0,w)` 式修复（全仓 grep 仅 `rangeMetrics.ts:70` 对 KL 散度做了 `Math.max(0,d)`，数学上合理）。
3. **缓存 key 碰撞（假设 4）**：当前快照下无法构造语义不同却同 key 的请求；1210 组注入搜索 0 碰撞，死牌顺序无关性、重复/非法表示拒绝均按预期工作。
4. **坍塌静默修复（假设 6）**：所有全零路径都显式失败，未发现 uniform 兜底替换。
5. **多人池权重和错误（假设 10）**：不存在「人数越多权重和越小」的代码；后验与人数无关。（但「多人池未实现」另计，见假设 10 结论。）

---

## 五、已知限制

1. **审计快照与时序**：审计期间 `src/domain/range/rangeCache.ts`（00:04:06）与 `test/range.test.ts`（00:04:10）被并发修改（测试数 533 → 535）。本报告全部结论对应第二节的哈希快照，最终复核哈希未再变化。`rangeCache.ts` 的**早期版本**（审计开始时读到的那一版，已被覆盖）接受 `readonly (number|string)[]` 死牌且仅 `.map(String).sort().join(',')`，存在 `['As,Kd']` 与 `['As','Kd']` 同 key、以及索引/字符串两种拼写并存的问题；当前版本已通过「只接受规范牌面字符串 + 拒绝索引 + 拒绝重复 + 正则校验」修掉，因此假设 4 以**当前版本**判定为未证伪。
2. **未覆盖运行时外部集成**：`src/` 内除测试外没有 Range Engine 的调用方，因此 MAJOR-3（翻牌后死牌）、MINOR-3（中止无审计）等属于「一旦接入就会显形」的潜在缺陷，无法用现有调用链证明其真实影响面。UI / CLI / 决策管线未纳入本次审计。
3. **未做形式化验证**：数值类结论基于随机 400 组 + 极端网格搜索（含 ±1e300、5e-324），非穷举；「未发现」不等于「不存在」。
4. **未评估数据质量**：`data/ranges/**` 的实际范围数据内容、solver 来源真实性不在本次范围（引擎内确实不含硬编码范围数据，符合声明）。
5. **未测并发/多线程**：`nextRangeId`（`range.ts:63-69`）的模块级计数器与缓存均为进程内单线程假设，未做并发写入验证。
6. **性能结论仅本机**：`updateRange` 1225 组合 ≈ 1.72ms/次（≈1.41µs/组合）；构建 1225 组合 ≈ 9.22ms；`diffRanges` 2.86ms；`validateRange` 3.16ms。数值受机器影响，仅用于判断中止粒度与「不可中止路径」的代价量级。

---

## 六、修复记录（由主 Agent 独立完成并验证）

> 本节不属于原红队审计产出，是收到报告后的修复与验证记录。
> 全部修复都附带**永久回归测试**（`test/rangeRedTeam.test.ts`，31 项）。

### CRITICAL-1 —— 已修复 ✅

**修复内容：**

1. `ExactCombo` 的全部字段加 `readonly` → 一行类型安全赋值**编译期即被拒绝**
2. `makeCombo` 内部 `Object.freeze` 组合本体、两张牌、`cardIndices`、`ranks`
3. `ALL_COMBOS` 数组本体也冻结
4. `indexById` 由 `ReadonlyMap`（仅编译期约束）改为**只读视图**：只暴露 `get` / `has`，
   运行时不存在 `set` / `clear` / `delete`
5. `isFrozen` 递归检查到 `combo` 层与 `tags` 层

**回归测试**：6 项 —— 「改 canonicalId 抛错」「改 card1.rank 抛错」「改 ALL_COMBOS[0] 抛错」
「先验条目的 combo 也冻结」「isFrozen 能识破 combo 未冻结」「indexById 无 set/clear/delete」。

### MAJOR-2 —— 已修复 ✅

**修复内容：**

1. 新增 `assessCoverage(model, prior)`：显式列出**未被声明**的组合、占比、`fullyCovered`
2. `UpdateRangeResult` 新增 `coverage` 与 `removals: { byDeadCards, byZeroLikelihood }`
3. 新增选项 `requireFullCoverage` → 未覆盖时返回 `RANGE_PARTIAL_ACTION_MODEL`
   （该错误码与 i18n 文案此前**从未被触发过**）
4. `removedByBlockers` 不再统计「似然为 0」；`RangeDiffSummary` 拆成
   `removedByBlockers` / `removedByZeroLikelihood` / `removedTotal` 三个字段

**回归测试**：7 项 —— 「3/18 覆盖度必须标出未覆盖」「support 18→3 如实报告」
「requireFullCoverage 报错」「无死牌时 removedByBlockers 必须为 0」。

### MAJOR-3 —— 已修复 ✅

**修复内容：** `UpdateRangeOptions` 新增 `deadCards`；`updateRange` 在计算似然**之前**
先移除与死牌冲突的组合，严格符合规范第十一节
「Prior → 移除 Impossible → 归一化 → 应用似然 → 归一化」。

**回归测试**：3 项 —— 「传入翻牌后零残留冲突组合」「移除后仍归一化」
「全被封死 → RANGE_COLLAPSE」。

### MAJOR-4 —— 已修复 ✅

**修复内容：** 重写 `deadCardsFrom`：

- 接受 `Card[]` / `Set<string>` / `Set<number>` / `Iterable<unknown>`
- 花色**大小写不敏感**（`'S'` → `'s'`）
- 越界索引、非法牌面字符串、缺字段对象**一律抛错**，绝不静默丢弃
- `makeCombo` 增加 `cardIndex` 越界检查（返回 −1 时抛错）
- 新增 `normalizeCard()` / `isCardIndexInRange()` 供调用方显式校验

**回归测试**：6 项。

### MAJOR-5 —— 已修复 ✅

**修复内容：**

1. `confidenceCapFor` 对未知来源类型返回 **0**
   （旧版返回 `undefined` → `NaN > undefined` 恒为 false）
2. `validateProvenance` 首先校验 `sourceType` 是否为已知枚举值
3. 新增 `assertValidProvenance`，并在**全部三个构建入口**调用
   （`buildRangeFromComboWeights` / `buildRangeFromRankClasses` / `freezeRangeFromPairs`）

**回归测试**：5 项 —— 含「未知来源类型 `GTO_SOLVER` 必须报错且上限为 0」。

### MINOR —— 已修复 ✅

| 项 | 处置 |
|---|---|
| `isFrozen` 假保证 | 递归检查到 combo / tags / indexById |
| `deadlineClock.isAborted` 恒 false | 改为表意明确的 `() => false`，并注释说明该信号不存在 |
| 中止事件无审计 | `RANGE_DEADLINE_EXCEEDED` 现携带 `action` / `actor` / `street` |
| `probabilityMetrics` 掩蔽 | 保留「跳过坏值」行为，但明确注释：**本函数不足以证明范围合法**，严格校验在 validator |
| `EPSILON` 重复定义 | 仅保留 `range.types.ts` 一处；`combo.ts` 的重复定义已删；`rangeUpdate.ts` 的 `1e-6` 已改为统一 `EPSILON` |
| `rankClassOf` 索引方向写反 | 修正为只在 `after` 中查询 |
| `probabilitySumOk` 无调用方 | 已删除（死代码） |

### 修复后基线

- **测试：566 / 566 通过**（修复前 535；新增红队回归 31 项）
- **TypeScript：零错误**
- 原有 410 项基线测试全部继续通过，**无断言放宽、无测试删除**

### 对报告中「未能证伪」项的复核

报告判定「未证伪」的若干项，本次修复**未改动其逻辑**，并已在回归测试中再次确认：
贝叶斯方向、归一化数值、缓存 key 无碰撞、无坍塌静默修复、无「人越多权重和越小」的错误模型。

### 一处**未采纳**的建议（附理由）

报告建议「`test/range.test.ts:564` 只断言了 probability，覆盖不到 combo 层」。
已采纳并**新建独立文件** `test/rangeRedTeam.test.ts`，而不是改写原文件 ——
理由是原文件既有断言全部保持原样（满足「不允许放宽原有断言」），
红队回归单独成册便于日后审计追溯。
