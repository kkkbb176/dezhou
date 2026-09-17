# CACHE KEY GOLDEN VECTOR — PASS

**日期**：2026-09
**起始基线**：git `9c1321c` / tag `v0.1-baseline`（开始前 `git status --short` 为空）
**范围**：只审计并加固 `scenarioHash` / `treeId` / `cacheKey`
**未改动**：preflop strategy · postflop thresholds · player profile semantics ·
decision engine 策略逻辑 · `GTOopen/` 第三方目录 · 无关 UI

```text
> tsc --noEmit        → 0 错误
> 清单校验             → 134 个产物一致
> node --test         → 1,677 项 / 137 套件 / 0 失败 / 0 跳过
> 新增测试             → 25 条（黄金向量 24 + 存储层碰撞 1）
> 变异测试             → 6 项，全部有效，恢复后 SHA-256 逐位一致
```

**本轮只证明**：缓存身份映射具有**可重复性、敏感性**与**基本抗静默误命中能力**。
**不声称**：collision impossible · solver verified · strategy verified。

---

## 1. `scenarioHash` 定义

**位置**：`src/domain/gto/gtoScenario.ts:scenarioHashOf`
**含义**：**「我在问哪个问题」** —— 扑克场景身份（不含求解设置、不含真人信息）

```text
scenarioHash = 'g' + fnv1a32( canonical( scenario 载荷 ) )
```

**输入字段（9 项，逐字段追踪生产代码）**：

| 字段 | 为什么必须进 |
|---|---|
| `v` = `GTO_SCENARIO_HASH_VERSION`（`gto-scenario-v1`） | 口径变更时旧缓存必须**失效**而不是误命中 |
| `kind`（RFI / VS_OPEN / VS_3BET / …） | RFI 与 VS_OPEN 不是同一个问题 |
| `gameType`（`CASH`） | 赛制不同则场景不同（本轮只支持现金局） |
| `tableSize` | 4MAX 的 BTN ≠ 6MAX 的 BTN ≠ 9MAX 的 BTN |
| `effectiveStackBB`（`roundBB` 到 6 位） | 100BB 与 40BB 是完全不同的决策节点 |
| `heroPosition` | 「我在 BTN」与「我在 BB」是两个问题 |
| `actionHistory[].position/kind/sizeBB` | 谁开的池、开多少、谁弃牌 —— 全都改变答案 |
| `blinds.sbBB/bbBB/anteBB` | 盲注结构不同 ⇒ 筹码深度与赔率都不同 |
| `heroAlreadyActed` | 决定 Hero 面对的是不是 3Bet |

**刻意不进**（有明确理由，不是遗漏）：
`villainPosition`（已完整体现在 `actionHistory` 里，重复计入会造成「同一份策略的两份缓存」）、
求解器版本、**真人信息**（类型级防线：`GtoScenario` 里没有这些字段）、**底牌与公共牌**（见 §9/§10）。

---

## 2. `treeId` 定义

**位置**：`gtoScenario.ts:treeIdOf`
**含义**：**「这是同一棵动作树吗」** —— 用于「BR gap 只在同一棵树内可比」

实测依据（既有注释）：6MAX 两分支树 gap 之和 `0.015`，三分支树 `0.998` —— 差 60 倍；
拿两棵树的 gap 互比会得出「这个桌型收敛更差」这种**错误结论**。

**输入字段（9 项）**：`tableSize` · `blinds{sbBB,bbBB,anteBB}` · `stack` ·
`openSizesBB[]` · `raiseMults[]` · `maxRaises` · `limp` · `addAllin` · `engine`

| 特性 | 说明 |
|---|---|
| **对 Hero 位置不敏感** | 同一棵树上的不同节点共享 treeId（`CACHE-GOLDEN-2` 锁定） |
| **对求解设置敏感** | 打开全下 ⇒ 树形状变了 ⇒ treeId 变（`CACHE-SENS-6`） |
| **无版本常量** | 设计如此：树形状的每个字段都在载荷里，任何形状变化都会改变 id；且字段表让「新增字段」必须显式声明 |

---

## 3. `cacheKey` 定义

**位置**：`gtoScenario.ts:cacheKeyOf`
**含义**：**「这份缓存还能用吗」** = 场景身份 + 求解设置身份

```text
cacheKey = 'c' + fnv1a32( canonical({ v: GTO_CACHE_KEY_VERSION, scenario: scenarioHash, solve: solveFingerprint }) )
```

**它不重复哈希同一个 payload**（`CACHE-GOLDEN-4` 锁定）：三个键对应**三个不同的载荷文本**，
`cacheKey` 的载荷**只由另两把键组成**。

`solveFingerprint`（`solveFingerprintOf`，前缀 `s`）含 **19 项**：
`v` · `engine` · `engineCommit` · `solverVersion` · `openSizesBB[]` · `raiseMults[]` · `maxRaises` ·
`limp` · `addAllin` · `rakePct` · `rakeCap` · `realization` · `multiwayEquityModel` ·
`iterations` · `targetGap` · `checkEvery` · `enginePositions[]` · `posts[]` · `ante`

---

## 4. 三者各自输入字段（对照使用者清单）

| 使用者清单项 | scenarioHash | treeId | cacheKey | 说明 |
|---|---|---|---|---|
| tableSize / playerCount | ✅ | ✅ | ✅（间接） | 一级参数 |
| heroPosition | ✅ | ❌ | ✅（间接） | 树与「谁在问」无关 |
| villainPosition | ❌ | ❌ | ❌ | 已含于 `actionHistory` |
| effectiveStack | ✅ | ✅ | ✅ | |
| street | ❌ | ❌ | ❌ | 本套键只覆盖**翻前**场景（见 §17 审计结论） |
| holeCards | ❌ | ❌ | ❌ | **设计如此**（范围级基线） |
| board | ❌ | ❌ | ❌ | 同上 |
| pot | ❌ | ❌ | ❌ | 翻前场景由 blinds + actionHistory 决定 |
| betting history | ✅ | ❌ | ✅ | 场景的一部分；树只由菜单决定 |
| action sizes | ✅（本次动作额） | ✅（**菜单**列表） | ✅ | 二者的区分是设计要点 |
| legal actions | ❌ | ✅（菜单 = 分叉） | ✅ | 树的形状即「合法动作集合」 |
| preflop context | ✅ | ✅ | ✅ | kind + history + 位置 |
| heads-up / multiway | ✅（经 history） | ❌ | ✅ | 无独立字段，由 history 表达 |
| player profile | ❌ | ❌ | ❌ | 类型级禁止（`gtoContextIsolation` 另有锁定） |
| mode / strategy source | ❌ | ❌ | ❌ | Alpha 侧概念，不进 GTO 键 |
| GTO scenario parameters | ✅ | ✅ | ✅ | |
| solver config | ❌ | 部分（engine/菜单） | ✅ | 完整 19 项在 solveFingerprint |
| bet sizing tree | ❌ | ✅ | ✅ | `openSizesBB` / `raiseMults` / `maxRaises` |
| 版本 / schema version | ✅ `scenario-v1` | ❌（设计） | ✅ `cache-v1` + 间接含场景版本 | |

---

## 5. 哪些字段原来缺失

**结论：三把键的字段集合本身没有缺失**（逐字段追踪后确认）。
原来缺的是**保证字段集合不变的机制**，以及**读取侧的逐字段验证**：

| 类别 | 原来 | 现在 |
|---|---|---|
| 字段集合 | 由对象字面量隐式决定 —— 加/删字段**没有断言** | 显式字段表 `PAYLOAD_SCHEMAS`；多一个/少一个**抛错** |
| 字段顺序 | 由源码书写顺序隐式决定 | 由字段表决定（顶层 + **嵌套**对象） |
| 读取侧验证 | 持久化只比 3 个哈希**字符串** | 追加**逐字段场景比对** |
| in-flight 复用 | **只比缓存键** | 逐字段比对 |
| 非有限数 | `JSON.stringify` 静默写成 `null` | 必需值抛错 / 可空值显式 `null` |

---

## 6. 是否发现静默碰撞风险

**发现 2 处真实风险（均已修）**，另有 1 处无法在本轮消除（如实报告）：

| # | 风险 | 后果 | 处置 |
|---|---|---|---|
| 1 | 持久化读取只比 32 位哈希字符串（条目里明明有完整 `scenario`） | 一次碰撞或索引被改写 ⇒ **问 A 得到 B 的策略**，且毫无迹象 | 追加逐字段比对，拒绝 + 警告（`GTO-CACHE-25` 用**人工伪造的碰撞**验证：只比哈希时确实会命中，加比对后拒绝） |
| 2 | in-flight 复用只比缓存键 | 两个场景碰撞时共享同一个求解 Promise ⇒ 第二个场景拿到第一个的结果 | `inFlight` 存 `{scenario, task}`，复用前比对 |
| 3 | FNV-1a **32 位**（8 hex）本身 | 理论上会碰撞；256 条缓存下碰撞概率约 1e-5 量级 | **不消除**，靠三层逐字段比对保证「碰撞不被静默接受」；换 64/128 位摘要需独立一轮 + 版本迁移 |

---

## 7. Canonical serialization 方式

```text
canonicalPayloadOf(kind, fields):
  ① 字段集合必须与 PAYLOAD_SCHEMAS[kind] **完全相等**（否则抛错）
  ② 按**表顺序**重新装配顶层对象（JSON.stringify 对字符串键保持插入序）
  ③ 嵌套对象（blinds / actionHistory[i]）按 NESTED_SHAPES 同样重排
  ④ 数组**保持原顺序**（不做任何排序）
  ⑤ 数值：必需值经 requiredBB（非有限 ⇒ 抛错）；可空金额经 nullableBB（显式 null）
```

**明确禁止的依赖**（逐条对照使用者 §7）：

| 禁止项 | 现状 |
|---|---|
| JSON 对象插入顺序 | ✅ 不再依赖（顶层与嵌套都按表重排；`CACHE-CANON-1` / `CACHE-CANON-2b`） |
| Map 迭代顺序 | 不涉及（无 Map 参与键） |
| 平台路径分隔符 | 不涉及（键不含路径） |
| CRLF/LF | 不涉及（键不含文件文本；`CACHE-CANON-1` 断言载荷无 `\r`） |
| locale | `CACHE-INSENS-2` 切换 `LANG` / `LC_ALL`（含土耳其语大小写陷阱）后键不变 |
| 系统时区 | `CACHE-INSENS-2` 切换 `TZ` 后键不变 |
| 数组排序 | ✅ 语义有序数组**不排序**（`CACHE-CANON-2`：动作历史与动作菜单换序 ⇒ 载荷必须不同） |

---

## 8. Cards canonicalization 方式

**三把 GTO 键里没有牌**，因此不存在「牌的规范化」问题。
真正含牌的键是 **`hashManualInput`**（`alphaPipeline.ts`，决策日志的 `inputHash`，
**本轮未改动** —— 不在本轮范围内）。审计观察：

| 项 | 现状 | 影响 |
|---|---|---|
| `heroCards` | 按**原样数组**序列化 ⇒ `['As','Ks']` 与 `['Ks','As']` 得到**不同**哈希 | 仅影响日志身份（同一问题被记成两条），**不影响策略结果**（不是缓存键） |
| `board` | 按原样数组 ⇒ flop 三张的内部顺序会影响哈希（turn/river 顺序本就语义相关） | 同上 |
| `seatStacksBB` | **已排序**（对象键序归一化）✅ | —— |
| `occupiedPositions` | 未排序（集合语义，顺序可不同） | 同上，仅日志身份 |
| 算法 | 同样是 FNV-1a 32 位 | 同上 |

**建议（未实施，属另一轮）**：给 `hashManualInput` 的底牌 / flop 加集合规范化 + 版本后缀。
代价：历史日志的 `inputHash` 全部变化（需接受或做双写迁移）。**本轮不动**。

---

## 9. 是否存在 suit isomorphism

**不存在，也没有引入。**

- 三把 GTO 键**不含任何牌面信息**，因此「花色归一化导致 reducer 合并」这类风险在键层面**不可能发生**；
- `hashManualInput` 按原样保留花色（`As` ≠ `Ah`），未做 nor 也不做同构映射；
- 唯一与花色有关的决策逻辑（blocker 分析）**不进键**，因此
  「nut flush blocker 与 non-blocker 被映射到同一缓存」这一具体危险**在当前架构下不存在**。

**结论**：使用者 §9 的担忧在本项目里**无对应实现**；本轮按「如果没有：保持实际花色进入 key」处理 ——
即**不做任何花色归一化**。

---

## 10. Blocker-sensitive 场景是否安全

**安全，理由与 §9 相同**：blocker 敏感的量（`blockedStrongerCombos` / `netBlockerPreference` 等）
只存在于**决策层输出**（`diagnostics.postflop.blockers`），**不参与任何缓存键**。
本项目的缓存只有两类：

| 缓存 | 键 | 是否含牌面/牌 |
|---|---|---|
| GTO 策略缓存（内存 + `data/gto-cache`） | `cacheKey` | ❌ 不含 |
| 稳定性证据（`data/gto-stability.json`） | 同 `cacheKey` | ❌ 不含 |

因此不存在「两个 blocker 敏感局面共用缓存」的路径。

---

## 11. Schema version 处理

| 常量 | 值 | 进入哪个键 |
|---|---|---|
| `GTO_SCENARIO_HASH_VERSION` | `gto-scenario-v1` | `scenarioHash` 的 `v` 字段（⇒ 间接进 `cacheKey`） |
| `GTO_CACHE_KEY_VERSION` | `gto-cache-v1` | `solveFingerprint` 与 `cacheKey` 的 `v` 字段 |
| `GTO_STORE_VERSION` | `gto-strategy-store-v1` | 存储**条目结构**（`entry.storeVersion`），不进键 |
| `keySchemaVersionOf()` | `scenario=…;cache=…` | **诊断用**，不进任何键 |

**已存在，无需新增**（使用者 §11 的「如果目前没有」不成立）。
另：`CACHE-VERSION-1` 断言**不得**把 git commit 当 schema version（那会伪造出「缓存失效」），
并用 `versionOverride`（测试与迁移演练专用）证明版本变化 ⇒ 键变化 ⇒ 旧缓存 miss 而非误命中。

---

## 12. Hash 碰撞二次验证方式

```text
三层，从内到外：
① cacheKey = 场景哈希 + 求解设置指纹        （两段独立折叠）
② 持久化：store.load(cacheKey, { scenarioHash, treeId, scenario })
     ├─ 载荷 cacheKey 必须等于请求键
     ├─ scenarioHash / treeId 必须一致
     └─ **scenario 逐字段比对**（scenariosEquivalent）      ← 本轮新增
③ 内存 / in-flight：scenariosEquivalent(entry.scenario, scenario)  ← in-flight 为本轮新增
```

`scenariosEquivalent` 覆盖键的**全部字段**（`CACHE-COLLISION-2` 逐项验证 12 类扰动：
kind / tableSize / effectiveStackBB / heroPosition / heroAlreadyActed /
blinds×3 / history 长度 / sizeBB / kind / position）。

**不声称「不会碰撞」**；声称的是「碰撞不会被静默接受」。

---

## 13. Cache hit validation（调试诊断）

`GtoLookupStats` 新增三个字段（**普通实战 UI 不显示**，供开发/测试/报告）：

```text
cacheHit          （原有）
cacheKey          （原有）
scenarioHash      ← 新增
treeId            ← 新增
keySchemaVersion  ← 新增（scenario=…;cache=…）
```

所有 `stats()` 调用点（内存命中 / 持久化命中 / in-flight 复用 / 冷求解 / 失败早退）都会带上键。

---

## 14. 新增测试数量

| 文件 | 条数 | 分组 |
|---|---|---|
| `test/gtoCacheKeyGolden.test.ts`（新） | **24** | GOLDEN 4 · SENS 7（含 HOLE） · INSENS 2 · CANON 5 · VERSION 2 · COLLISION 3 · SCHEMA 1 |
| `test/gtoCacheQuality.test.ts` | **+1** | `GTO-CACHE-25` 存储层碰撞拒绝（人工伪造碰撞） |
| **合计** | **25** | |

---

## 15. Mutation test 结果

| # | 变异 | 必须失败 | 实际失败 |
|---|---|---|---|
| 1 | 把 `position` 移出键 | GOLDEN | ✅ CACHE-GOLDEN-1 / -3、CACHE-CANON-1（3 条） |
| 2 | 把 `effectiveStackBB` 移出键 | SENS | ✅ GOLDEN-1 / -3、SENS-2、CANON-3、COLLISION-1（5 条） |
| 3 | 把动作历史移出键（`board` 的替身，见 §17） | SENS | ✅ GOLDEN-1 / -3、SENS-4 / -5、CANON-1、COLLISION-1（6 条） |
| 4 | 把 schema 版本固定成常量 | VERSION | ✅ GOLDEN-1 / -3、CANON-1、VERSION-1（4 条） |
| 5 | 序列化器改为依赖对象插入顺序 | CANON | ✅ CANON-1、CANON-2b（2 条） |
| 6 | 短路碰撞防线（存储层 + in-flight 各一次） | COLLISION | ✅ GTO-CACHE-25 + CACHE-COLLISION-3（存储层）；CACHE-COLLISION-3（in-flight） |

**恢复校验**：三份被变异文件按 SHA-256 核对，与变异前**逐位一致**
（`gtoScenario.ts` `45FA32C6…`、`gtoStrategyStore.ts` `E13C275F…`、`gtoSafeLookup.ts` `D74D26B1…`），
源码零残留标记。

> **过程记录（诚实披露）**：变异 5 之前，`CACHE-CANON-1` 先**真实失败**过一次 ——
> 因为我的第一版序列化器只排了顶层，没排嵌套对象。
> 那不是测试写错，而是**测试抓到了实现缺陷**：当时文档已声称「顺序无关」，而承诺是假的。
> 现在 `CACHE-CANON-2b` 专门锁嵌套顺序。

---

## 16. `npm run verify` 结果

```text
> tsc --noEmit                        → 0 错误
> node scripts/checkManifest.ts       → 全部 134 个产物与清单一致
> node --test                          → 1,677 项 / 137 套件 / 0 失败 / 0 跳过
```

| 项 | 结果 |
|---|---|
| TypeScript | 0 错误 |
| artifact manifest | PASS（134 个产物一致） |
| 既有测试删除 | **0** |
| 既有断言放宽 | **0** |
| 全部测试 | PASS（1677/1677） |
| 新增黄金向量 | PASS（24 条 + 1 条） |
| mutation tests | 6/6 有效 |

---

## 17. `git diff`（未提交，等审计）

**开始前**：`git status --short` → **空**（工作区干净，HEAD = `9c1321c`）

**完成后**：

```text
$ git status --short
 M CURRENT_PROJECT_STATUS.md
 M data/artifact-manifest.json
 M src/domain/gto/gtoSafeLookup.ts
 M src/domain/gto/gtoScenario.ts
 M src/domain/gto/gtoStrategyStore.ts
 M test/gtoCacheQuality.test.ts
?? test/gtoCacheKeyGolden.test.ts

$ git diff --stat
 CURRENT_PROJECT_STATUS.md          |  75 ++++++-
 data/artifact-manifest.json        |  12 +-
 src/domain/gto/gtoSafeLookup.ts    |  52 ++++-
 src/domain/gto/gtoScenario.ts      | 407 ++++++++++++++++++++++++++++++-------
 src/domain/gto/gtoStrategyStore.ts |  26 ++-
 test/gtoCacheQuality.test.ts       |  66 ++++++
 6 files changed, 550 insertions(+), 88 deletions(-)

$ git diff --name-only
CURRENT_PROJECT_STATUS.md
data/artifact-manifest.json
src/domain/gto/gtoSafeLookup.ts
src/domain/gto/gtoScenario.ts
src/domain/gto/gtoStrategyStore.ts
test/gtoCacheQuality.test.ts
```

**未自动 commit**（按使用者 §17）。新增文件 `test/gtoCacheKeyGolden.test.ts` 目前未跟踪。

---

## 18. 是否发现真实缓存 Bug

**发现 4 处真实缺口，其中 2 处属于「静默错答案」等级**（全部已修，见 §5/§6）：

| 等级 | 缺口 | 是否已能被测试抓到 |
|---|---|---|
| **静默错答案** | 持久化读取只比 32 位哈希 ⇒ 碰撞/索引改写会命中别的场景 | ✅ `GTO-CACHE-25`（人工伪造碰撞，修复前确实命中） |
| **静默错答案** | in-flight 复用只比缓存键 ⇒ 碰撞时共享他人结果 | ✅ `CACHE-COLLISION-3` 源码级断言（+ 逻辑比对） |
| 静默语义漂移 | 字段顺序 / 嵌套顺序决定键；文档声称「顺序无关」而实际不是 | ✅ `CACHE-CANON-1` / `-2b` |
| 静默折叠 | `NaN` → `null` ⇒ 与「无金额」撞键 | ✅ `CACHE-CANON-3` |

**同时确认**：三把键的**职责没有混淆**（`CACHE-GOLDEN-2` / `-4`：位置影响场景不影响树；
菜单/全下影响树；`cacheKey` 只由另两把键组成），也没有「同一个 payload 重复哈希三次」的问题。

**真实触发概率**：以上前两条需要 32 位哈希碰撞（约 7.7 万条才到 50%）或**索引被人工改写**。
因此它们更多是「防线缺失」而不是「正在发生的错误」—— 但按使用者要求，
**本轮的重点就是让这类缺陷不可能静默通过**。

---

## 19. 是否建议合并本轮修改

**建议合并。** 理由：

1. **逐字节兼容**：三把键的取值与加固前**逐位相同**（黄金向量锁定），
   因此 `data/gto-cache`（134 个产物中的缓存条目）与按 `cacheKey` 索引的
   `data/gto-stability.json` **不需要重建**，质量评级不会静默降级；
2. **零放宽**：既有 1,652 项测试全部保留且通过（总量 1,677），新增 25 条；
3. **只加防线、不改策略**：改动集中在「键是怎么被决定的」与「命中是怎么被验证的」，
   决策引擎、preflop/postflop 策略、画像语义、`legalActions`、`GTOopen/` 均未触碰；
4. **6 项变异测试**证明新增的锁真的会失败；
5. **诊断增强**：`stats` 新增三把键 + 版本指纹，便于以后排查「为什么没命中」。

**合并前建议你确认两件事**（都属于决策而非缺陷）：

| # | 事项 | 说明 |
|---|---|---|
| 1 | 是否接受「必需数值非有限 ⇒ 抛错」 | 这是本轮唯一**行为上变严**的地方。理论不可达（上游校验会先拒绝非法场景），但如果生产里出现过 `NaN` 筹码，会从「静默算出一个键」变成「抛错」。我倾向保留抛错（静默折叠更危险） |
| 2 | `hashManualInput` 的底牌顺序问题（§8） | **本轮未改**。要不要单独开一轮做集合规范化？代价是历史日志 `inputHash` 全部变化 |

---

## 附：本轮修改文件清单

| 文件 | 改动 |
|---|---|
| `src/domain/gto/gtoScenario.ts` | 新增 `PAYLOAD_SCHEMAS` / `NESTED_SHAPES` / `canonicalPayloadOf` / `hashKeyOf` / 三个载荷构造器 / `keySchemaVersionOf`；`requiredBB` / `nullableBB`；三把键改用规范化序列化（**逐字节兼容**） |
| `src/domain/gto/gtoStrategyStore.ts` | `load()` 支持 `expected.scenario` 并做**逐字段比对**（碰撞拒绝 + 警告） |
| `src/domain/gto/gtoSafeLookup.ts` | in-flight 存 `{scenario, task}` 并复用前比对；两处 `store.load` 传 `scenario`；`stats` 新增 `scenarioHash` / `treeId` / `keySchemaVersion` |
| `test/gtoCacheKeyGolden.test.ts` | **新增 24 条**（黄金向量 / 敏感性 / 不敏感 / 规范化 / 版本 / 碰撞 / 字段表） |
| `test/gtoCacheQuality.test.ts` | **新增 `GTO-CACHE-25`**（存储层碰撞拒绝，人工伪造） |
| `CURRENT_PROJECT_STATUS.md` | §10.0.13 本轮记录 + 数量/轮次/版本控制同步 |
| `data/artifact-manifest.json` | 134 个产物重新绑定 |
