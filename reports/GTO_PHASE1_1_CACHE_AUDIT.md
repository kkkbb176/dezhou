# GTO Phase 1.1 —— 缓存审计

> 本报告回答：**缓存键到底包含什么、持久化是怎么做的、坏了会怎样。**
>
> Phase 1 的已知缺口是「缓存键里没有 `engineCommit`」。本报告给出修复前后
> 的逐项对照、6 条隔离测试的实际结果，以及持久化缓存的原子性与损坏容忍。

---

## 0. 结论

| 项 | 结果 |
|---|---|
| `engineCommit` 是否进入缓存键 | ✅ **是**（与 17 项求解侧参数一起） |
| 持久化缓存是否完成 | ✅ **是**（`data/gto-cache/`，原子写入） |
| 进程重启后是否可读取 | ✅ **是**（实测：新 store 实例命中，且**不再建树**） |
| 是否只是内存 Map | ❌ **不是**（内存缓存 + 持久化缓存两层） |
| 失败结果是否入缓存 | ❌ **不入**（避免把「离线」缓存 30 分钟） |
| 缓存损坏是否会带崩 Alpha | ❌ **不会**（坏索引 → 空索引；坏载荷 → 未命中） |

---

## 1. 修复前后对照（用户 §三 的字段清单逐项）

| 会改变策略结果的输入 | Phase 1 在键里吗 | Phase 1.1 | 依据 |
|---|---|---|---|
| `gameType` | ✅ | ✅ | 场景哈希 |
| `tableSize` | ✅ | ✅ | 场景哈希 |
| `effectiveStackBB` | ✅ | ✅ | 场景哈希 |
| `blindStructure` / `ante` | ✅ | ✅ | 场景哈希 |
| `heroPosition` | ✅ | ✅ | 场景哈希 |
| `villainPosition` | ✅ | ✅ | 场景哈希（`VS_NAMED_OPEN` 用它记开池者） |
| `actionHistory` | ✅ | ✅ | 场景哈希 |
| `raiseSizes`（来自**历史**的尺寸） | ✅ | ✅ | 场景哈希 |
| **`engine`（引擎身份）** | ❌ | ✅ | `GtoSolveKeyParts.engine` |
| **`engineCommit`** | ❌ **缺** | ✅ | **本轮修复的核心** |
| **`solverVersion`** | ❌ | ✅（GTOpen 恒为 `null`，**不编**） | `solveKeyParts` |
| **`actionMenu` / 动作树（开池尺寸、再加注倍数、加注上限、跛入、全下）** | ❌ **缺** | ✅ | `openSizesBB` / `raiseMults` / `maxRaises` / `limp` / `addAllin` |
| **`solverSettings`（迭代数、收敛目标、测量间隔）** | ❌ | ✅ | `iterations` / `targetGap` / `checkEvery` |
| **`approximationMode`（延续模型、多人权益模型）** | ❌ | ✅ | `realization` / `multiwayEquityModel` |
| **抽水** | ❌ | ✅ | `rakePct` / `rakeCap` |
| **求解器侧座位定义** | ❌ | ✅ | `enginePositions` / `posts` / `ante` |

**也就是说**：Phase 1 里「换求解器版本」「把全下打开」「把迭代数从 60 改成 12」
「把开池尺寸从 2.5 改成 2.0」**都会命中同一份旧缓存**。现在都不会了。

### 1.1 三把键的分工（**不要混用**）

| 键 | 语义 | 用途 | 对什么敏感 |
|---|---|---|---|
| `scenarioHash`（`g…`） | **问了什么问题** | 报告、日志、并列比较 | 桌人数 / 位置 / 筹码 / 动作历史 |
| `treeId`（`t…`） | **哪一棵树** | **只有相同 treeId 的 BR gap 才可比较** | 桌人数 / 筹码 / 盲注 / 动作菜单 / 求解器 |
| `cacheKey`（`c…`） | **哪一次求解的产物** | 命中判定 | 上面两者 **+ 全部求解设置 + 引擎版本** |
| `solveFingerprint`（`s…`） | 求解设置指纹（不含场景） | 报告里回答「这两份是同一套设置跑的吗」 | 求解设置 |

⚠️ `treeId` 对 **Hero 位置不敏感**（同一棵树上的不同节点共享 treeId），
但 `cacheKey` 敏感 —— 这是刻意的：同一棵树上的两个节点 gap 可比，
但**它们的策略是两份不同的数据**，必须分开缓存。
`test/gtoCacheQuality.test.ts` 的 GTO-CACHE-08 锁住了这一点。

---

## 2. 用户点名的 6 条隔离测试（实际结果）

| # | 要求 | 测试 | 结果 |
|---|---|---|---|
| 1 | commit A 的结果不能被 commit B 命中 | GTO-CACHE-01 + GTO-CACHE-12（含**持久化**层面） | ✅ |
| 2 | 4MAX 不能命中 9MAX | GTO-CACHE-02 | ✅ |
| 3 | RFI 不能命中 VS_OPEN | GTO-CACHE-03 | ✅ |
| 4 | Raise 2.0BB 不能命中 Raise 2.5BB | GTO-CACHE-04 | ✅ |
| 5 | 有 All-in 树不能命中无 All-in 树 | GTO-CACHE-05（缓存键 + 树指纹**都**必须不同） | ✅ |
| 6 | Solver 设置不同不能错误复用 | GTO-CACHE-06（**逐项验证 15 个字段**） | ✅ |

`GTO-CACHE-06` 逐项覆盖：`iterations` / `targetGap` / `checkEvery` /
`openSizesBB` / `raiseMults` / `maxRaises` / `limp` / `rakePct` / `rakeCap` /
`realization` / `multiwayEquityModel` / `enginePositions` / `posts` / `ante` /
`solverVersion`。

### 2.1 禁止的写法（已用测试排除）

- ❌ 只用 `tableSize + position` 当缓存键 —— 那会让「同一位置不同开池者」
  「同一位置不同尺寸」「同一位置不同迭代数」全部串在一起。
- ❌ 只比哈希不逐字段复核 —— 哈希实现漏一个字段就会静默命中错误缓存。
  因此 `GtoSafeLookup` 在命中时仍调用 `scenariosEquivalent()` **逐字段**复核，
  并且在「键相同但场景不同」时**删掉那条缓存**。

---

## 3. 持久化缓存的形态

### 3.1 为什么是 JSON 文件而不是 SQLite

| 方案 | 结论 |
|---|---|
| SQLite（`better-sqlite3`） | 本项目**零运行时依赖**（只有 `typescript` + `@types/node`）。引入原生模块会新增一条需要审计的依赖链 |
| SQLite（`node:sqlite`） | Node 24 里仍是实验特性。把它放进验收链会引入不稳定性 |
| **JSON 文件（选它）** | 零依赖、可读、可进产物清单做 hash 绑定、可人工检查 |

代价是「没有事务」，因此原子性由写入流程保证（见 §3.3）。

### 3.2 两级文件

```
data/gto-cache/
  index.json                    每个条目约 1KB 元数据（含 cacheKey）
  strategy/<cacheKey>.json      完整载荷（169 类策略 + 全部元数据）
```

**为什么分两级**：12 个场景的完整载荷约 7 MB。若命中判定要把它们全部读进来，
冷启动会很慢。索引只用于**判定命中**，载荷只在真正命中时才读。

### 3.3 原子写入（墨菲定律第 19 条：「缓存文件部分写入后程序崩溃」）

```
写 <name>.json.tmp-<pid>-<ts>
   ↓  fsync（保证内容真的落盘，而不只是进了页缓存）
rename(tmp → 正式文件)   ← 同一文件系统内的 rename 是原子的
   ↓
更新索引（同样走原子写入）
```

为什么必须 `fsync`：`rename` 只保证「目录项切换是原子的」，
**不保证数据已经落盘**。断电时可能出现「目录项指向一个内容为空的文件」。
先 `fsync` 内容再 `rename`，才能让「要么是旧的完整文件、要么是新的完整文件」成立。

测试 `GTO-CACHE-13` 断言：写入后目录里**不得留下 `.tmp-` 文件**。

### 3.4 损坏容忍（墨菲定律第 20 条：「corrupt cache 读取后导致 Alpha 崩溃」）

| 情形 | 行为 | 测试 |
|---|---|---|
| 索引文件不存在 | 视为空索引，**不报警告**（首次运行是正常的） | GTO-CACHE-15 情形 A |
| 索引文件损坏 | 视为空索引 + **记一条警告**（不静默） | GTO-CACHE-15 情形 B |
| 载荷文件缺失但索引有 | 视为未命中 + 删除该条目 | 代码路径 |
| 载荷不是合法 JSON | 视为未命中 + 删除该条目 | GTO-CACHE-14 |
| 载荷结构非法（缺字段） | 拒绝使用 + 删除该条目 | 代码路径 |
| **载荷里的键与请求的键不一致** | **拒绝使用**（不删，只拒） | GTO-CACHE-16 |
| 载荷未通过一致性校验 | 拒绝使用 | GTO-CACHE-17/18 |

> `GtoStrategyStore` 的**所有方法都不抛异常**：缓存是加速手段，不是真相来源。
> 缓存坏了应该退化成「重新求解」，而不是让 Alpha 崩掉。

---

## 4. 缓存里存了什么（用户 §五 的清单逐项）

`GtoCacheEntry` 的实际字段，与用户要求的对照：

| 要求 | 字段 | 备注 |
|---|---|---|
| `scenarioHash` | ✅ `scenarioHash` | |
| `engine` | ✅ `source.engine` | |
| `engineCommit` | ✅ `source.engineCommit` | |
| `solverVersion` | ✅ `source.solverVersion` | GTOpen 无版本端点 ⇒ **恒为 `null`**（不编） |
| `tableSize` | ✅ `scenario.tableSize` | |
| `effectiveStackBb` | ✅ `scenario.effectiveStackBB` | |
| `positions` | ✅ `solve.enginePositions` | 求解器侧座位定义 |
| `actionHistory` | ✅ `scenario.actionHistory` | |
| `raiseSizes` | ✅ `scenario.raiseSizesBB` + `solve.openSizesBB` / `raiseMults` | 历史尺寸与**配置**尺寸都存 |
| `actionMenu` | ✅ `range.actionMenu` | |
| `iterations` | ✅ `solveMeta.iterationsCompleted` / `iterationsRequested` | |
| `BR gap / convergence` | ✅ `solveMeta.brGapTotal` + `seatGaps` + `stopReason` + `targetGap` | 逐座位 gap 也存了 |
| `solveDuration` | ✅ `solveMeta.solveDurationMs` | |
| `approximationFlags` | ✅ `approximationFlags`（5 个布尔 + notes） | |
| `qualityLevel` | ✅ `quality` + `qualitySummaryZh` + `qualityReasonsZh` + `qualityBlockersZh` | 判定理由一起存，便于复核 |
| `createdAt` | ✅ `createdAt` | |
| `169 hand strategies` | ✅ `range.hands`（169 项） | |
| `source` | ✅ `source` | |
| **求解器没提供的项** | ✅ `unavailableFields` | **显式列出**「哪些字段求解器没给」，而不是留一个无法解释的 `null` |

`unavailableFields` 当前内容（逐条）：
1. `evBB（逐动作 EV）` —— GTOpen 的翻前节点接口不返回逐手牌、逐动作的 EV
2. `sourceVersion` —— GTOpen 没有版本端点
3. `equity` —— GTOpen 内部有权益表，但没有对外的权益查询接口

---

## 5. 数据一致性校验（用户 §二十三）

`validateCachedRange()` 在**写入前**与**读取后**都会跑。逐项覆盖：

| 要求 | 检查 | 违反后果 |
|---|---|---|
| `frequency >= 0` | `FREQUENCY_RANGE` | 拒绝写入 / 拒绝使用 |
| `frequency <= 1` | `FREQUENCY_RANGE` | 同上 |
| 动作频率总和 ≈ 1 | `FREQUENCY_SUM`（容差 1e-6） | 同上 |
| 169 hands 存在 | `HAND_COUNT` | 同上 |
| 无重复 hand | `DUPLICATE_HAND` | 同上 |
| 无 NaN | `NAN_FREQUENCY` | 同上 |
| 无 Infinity | `NAN_FREQUENCY` | 同上 |
| 无 undefined action | `UNDEFINED_ACTION` / `BAD_ACTION_KIND` | 同上 |
| 无非法 position | `BAD_POSITION` | 同上 |
| 无非法 tableSize | `BAD_TABLE_SIZE` | 同上 |
| 无非法 stack | `BAD_STACK` | 同上 |
| 组合数合法 | `BAD_COMBOS` | 同上 |
| `reach ∈ [0,1]` | `BAD_REACH` | 同上 |

⚠️ **一个刻意的例外**：写入时若校验失败，**仍然允许**写入
`quality === LOW_CONVERGENCE` 的条目 —— 因为用户明确要求
「低质量允许保存，但必须保留 qualityLevel」。
这里拒绝的从来不是「质量低」，而是「**结构自相矛盾**」。

`selfCheckStoreLayer()` 在启动时会**主动喂一份坏数据**给校验器，
断言它真的能抓到 `HAND_COUNT` / `DUPLICATE_HAND` / `FREQUENCY_RANGE` ——
防止校验器本身退化成「永远返回空数组」。

---

## 6. 并发保护（用户 §二十六）

| 情形 | 行为 | 测试 |
|---|---|---|
| 连点同一场景 3 次 | **只启动 1 次真实求解**（in-flight 去重按 `cacheKey`） | GTO-CACHE-19 |
| 不同场景并发 | 各自独立（但 Provider 内层仍串行，因为 GTOpen 只有一个会话） | GTO-ADP-29 |
| 两个并发请求写同一个缓存条目 | 原子 `rename` 保证「要么旧要么新」；索引写入是最后一步，失败等价于未命中 | GTO-CACHE-13 |
| 求解超时/失败 | **不写缓存**（避免把「离线」缓存 30 分钟） | GTO-CACHE-20 |

---

## 7. 已知缺口（**必须与结论一起读**）

| # | 缺口 | 影响 | 现状 |
|---|---|---|---|
| C-1 | 缓存**没有过期时间**（TTL） | 一份几天前的缓存会一直被命中 | 键里含 `engineCommit` 与全部求解设置，因此**只有「同样的输入」才会命中**。但求解器行为变化（不换 commit 的重新编译）无法检测 |
| C-2 | 缓存**没有容量上限** | 场景数量增长后目录会变大 | 当前 12 个场景约 7 MB；后续可通过索引做 LRU |
| C-3 | 缓存**没有内容校验和** | 文件被外部工具改坏时只能靠结构校验发现 | 结构校验能挡住绝大多数损坏；下一步可加 `sha256` |
| C-4 | 索引与载荷的一致性依赖写入顺序 | 若索引写入成功但载荷被外部删除，会命中失败并删除条目（安全方向） | 已按「安全方向」设计 |
| C-5 | 只对 4/6/9MAX 的 RFI 实测过稳定性 | 其他场景的 `stability` 证据缺失 ⇒ 质量等级停在 `LOW_CONVERGENCE` | **这是刻意的安全默认值**（没有证据就不给高等级） |
