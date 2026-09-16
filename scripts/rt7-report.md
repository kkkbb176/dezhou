# Step 7「动态行为模型」独立红队审计报告

> 审计员：独立红队（未修改 `src/` 任何一行；未新增 `test/` 下任何文件）
> 所有结论均来自本报告列出的脚本的**真实输出**，原始输出见 `scripts/rt7-evidence-output.txt`。
> 凡未确认者一律标注「未确认」，不做推测。

---

## 0. 审计基线与可复现信息

| 项 | 值 |
|---|---|
| 工作目录 | `D:\德州` |
| 运行命令 | `node.exe --experimental-strip-types "scripts/rt7-probeN.ts"` |
| node | v24.19.0 |
| 现有测试 | `node --test test/dynamicBehavior*.test.ts` → 81 pass / 0 fail（全绿，**但不能阻止本报告任何一条**） |
| 类型检查 | `npx.cmd tsc --noEmit` → exit 0 |
| 审计脚本 | `scripts/rt7-lib.ts`、`scripts/rt7-probe1..9.ts`（保留，作为证据） |
| 原始输出 | `scripts/rt7-evidence-output.txt`（probe1–9 全部输出 + 源码哈希） |

### ⚠️ 审计期间源码被并发修改（必须知悉）

审计过程中 `src/domain/dynamic/` 被**另一个执行者持续修改**。最终定格运行（9 个探针全部 exit 0，`09:20:29`）对应的修订为：

```
40308713CF4096C8  dynamic.types.ts
47F6855048D2B06D  dynamicAdapter.ts
71A94961032ED05D  dynamicBehavior.ts
5C913E03E346F1E1  dynamicDeviation.ts
E3099258340BEA8B  dynamicStats.ts
8DFCAFE13F08817B  playerStats.ts   (Step 6)
```

- `dynamicBehavior.ts` 在审计中被改过一次（`E156B3F8…` → `71A94961…`）：该次改动**未触及**本报告的任何结论（`aggressionBlocked` 分支、Hint 解析、`ignoredCount` 等结构逐行不变）。
- `dynamicAdapter.ts` 在审计中被改了两次（`11F7F28A` → `F5CB6305` → `47F68550`），**修掉了本报告 F13 的原始形态**（详见 F13，附残留问题）。
- 若在阅读本报告时哈希已变，请以「发现条目内标注的修订」为准重跑对应脚本。

---

## 1. 发现汇总

| 编号 | 级别 | 一句话 |
|---|---|---|
| F1 | **CRITICAL** | 最经典的偏离（入池↑ + 加注↓）被判成 `AGGRESSION_DOWN`/`NORMAL`，范围调整完全消失，且与自身解释文本矛盾 |
| F2 | **CRITICAL** | 充分性门槛与 `confidence` 由「跨指标机会总数」决定 → 1 手越过 UNKNOWN、2 手拿到 0.900 置信度与上限 1.2523× 幅度 |
| F3 | **CRITICAL** | 方向检验的样本量与强度/窗口的样本量不一致 → 同一份 W20 统计在 60 手判「无变化」、80 手判「变松」；误报率随历史长度升到 50.7% |
| F4 | MAJOR | `deviationScore` 无零假设刻度：完全无变化的数据平均 20 分、P95 36 分 |
| F5 | MAJOR | 「尺寸异常」维度是死代码；12 个真实指标（含全部翻后/转牌）不参与偏差，但其机会数照样推高门槛 |
| F6 | MAJOR | 上下文事件不校验 `playerId`/`timestamp`/`observedAfterEventIds` → 别人的损失改变本人的 Tilt 概率 |
| F7 | MAJOR | 人工 Hint 时间戳被忽略、可静默丢弃、能造出 `dominantState=TILT_SIGNAL` 而 `tilt.probability=0` 且无 provenance 的快照 |
| F8 | MAJOR | Fail Closed 失效：畸形 `opportunities` 直接 TypeError 崩溃；`success` 真值性/未知指标被静默接受 |
| F9 | MAJOR | `asOf` 为 NaN/Infinity 时未来事件全部参与计算，且污染快照字段 |
| F10 | MAJOR | 从不参与计算的 `betSizePotRatio` 一旦非法，会让**整条事件的全部机会**被丢弃 |
| F11 | MAJOR | 收缩公式与文档不变量差 c 倍（基线权重实测 10.0% vs 文档 66.7%）；时间衰减在常见窗口被完全抹平；`MAX_SINGLE_EVENT_SHARE` 是死常量 |
| F12 | MAJOR | 热路径 P95 在 5000 条事件处突破 20ms（≈31ms）；排序比较器内每次比较调用两次 `Date.parse` |
| F13 | MAJOR→已修复(残留 MINOR) | 适配层同目标相反方向合并出「direction=INCREASE + 因子 1.000」；原始形态已在审计期间被并发修复，残留浮点边界 |
| F14 | MINOR | 重复 `eventId` 内容不同时结果依赖输入数组顺序（与 `normalizeEvents` 文档声明相反） |
| F15 | MINOR | 死参数/死字段、Hint 上限语义错位、`explanation` 与 `dominantState` 可能矛盾、`baseline.metrics` 接受任意键 |

**未发现问题（本轮实验范围内）**：深冻结/不可变性、确定性（同输入/乱序/键序/幂等）、类型层与结果隔离、绝大多数数值极端。详见第 3 节。

---

## 2. 发现详情

### F1 — CRITICAL：「信息更全 → 判决反转」，且输出自相矛盾

**最小复现**：`scripts/rt7-probe9.ts` 头条 1；`scripts/rt7-probe2.ts` 变体 B；`scripts/rt7-probe1.ts` A/B/C 段

**实际观测**（40 手，基线 VPIP 15% / PFR 12% / 3Bet 7%，近期 36/40、0/40、0/40 = 典型「开始大量跟注、几乎不再加注」）：

场景 1-A（三条指标都记 —— 信息更完整）
```
dominantState = AGGRESSION_DOWN   deviationScore = 19   confidence = 0.900
conflicts     = ["入池率上升但主动加注率下降 —— 更可能是被动跟注变多，而非整体变激进",
                 "入池率上升但 3Bet 下降 —— 更可能是跟注变多，而非进攻性上升"]
explanation   = ["翻牌前入池偏离个人基线（主要指标：VPIP）",
                 "入池率上升但主动加注率下降 —— 更可能是被动跟注变多，而非整体变激进"]
tilt          = {"p":0,"c":0,"e":[]}
signals       = [["AGGRESSION_DOWN",0.252,["THREE_BET"]]]
adjustments   = [["AGGRESSION_LIKELIHOOD","DECREASE",0.9],["FOLD_LIKELIHOOD","INCREASE",0.9]]
adapters      = [["AGGRESSION_LIKELIHOOD","DECREASE",0.7985],["FOLD_LIKELIHOOD","INCREASE",1.2523]]
```
→ **没有任何 `RANGE_WIDTH` 调整**，反而输出「更可能弃牌」（×1.2523）。

场景 1-B（只记 VPIP —— 信息更少）
```
dominantState = LOOSER_RECENTLY   deviationScore = 26   confidence = 0.833
adjustments   = [["RANGE_WIDTH","INCREASE",0.833]]  → adapters 1.2316
```
⇒ **追加两条真实且强相关的证据（PFR↓、3Bet↓），把正确判决换成了错误判决。** 这不是「冲突保护」，而是方向信息被抹掉。

**机理（可证明，非推测）**：`detectConflicts` 的『入池率上升但主动加注率下降』只在 `vpip.direction==='HIGHER' && pfr.direction==='LOWER'` 时产生；而 VPIP 与 PFR **同属 ENTRY 组**，`aggregateGroup` 用的是同一窗口、同一 `metricDeviation` → `higher≥1 && lower≥1` → 组方向被判为 `NONE`。于是 `dynamicBehavior.ts` 里这段专为该冲突写的兜底：

```ts
} else if (aggressionBlocked && entry?.direction === 'HIGHER') {   // ← entry 此时必为 NONE
  dominantState = DynamicState.LOOSER_RECENTLY;
```
**在这个冲突下永不可达。** 扫描证据（`rt7-probe2.ts` D 段）：16 个产生冲突的配置中，出现「被动跟注变多」冲突且 `ENTRY ≠ NONE` 的配置数 = **0**。

**影响**：使用者会把一个「开始大量跟注」的对手读成「进攻性下降 + 更爱弃牌」，从而**放弃价值下注、错判诈唬频率**。这是本模块存在意义的核心场景。

---

### F2 — CRITICAL：充分性与置信度由「跨指标机会总数」决定

**最小复现**：`scripts/rt7-probe9.ts` 头条 2；`scripts/rt7-probe3.ts` B/C 段；`scripts/rt7-probe5.ts` D 段

**实际观测**：

1. 门槛：`MIN_RECENT_OPPORTUNITIES = 8` 实际比较的是 `totalOpportunities(W20)` = **窗口内所有指标机会数之和**。
   - 1 手牌声明 8 个指标机会 → `状态=NORMAL 置信=0.3333`（**不是 UNKNOWN**）。
   - 其中 7 个可以是 **未登记进 `METRIC_GROUP` 的指标**（对偏差零贡献）。
2. `confidence` 的样本项 = `min(1, 总机会数 / 24)`：
   ```
   2a) 真实行为恰好等于基线的玩家：
       1 手 → confidence 0.542（NORMAL，无调整）
       2 手 → confidence 0.900   ← 13 指标 × 2 手 = 26 个机会
       3 手 → confidence 0.900
      20 手 → confidence 0.851   ← 比 2 手更低
   ```
   **置信度随样本增加而下降**（20 手时三个窗口的组分数向量不再完全一致，`consistency` 从 1.0 掉到 0.851）。
3. 行为极端偏离 + **2 手**数据 → `AGGRESSION_UP`，`confidence 0.900`，三个 target 各 `1.2523×`（= 上限 `exp(0.25)`）：
   ```
   adapters = [["AGGRESSION_LIKELIHOOD","INCREASE",1.2523],
               ["BLUFF_LIKELIHOOD","INCREASE",1.2523],
               ["VALUE_LIKELIHOOD","INCREASE",1.2523]]
   ```
4. **每个指标自己的机会数对 `confidence` 零影响**（`rt7-probe3.ts` B 表：1/2/3/5/8/20 手、每指标 1–10 次机会，`confidence` 全部只由总数决定）。

**影响**：`confidence 0.900` 与 `1.25×` 这类「看起来有统计依据」的输出可以建立在 2 手牌上；使用者会把噪声当证据。这也让 `MIN_RECENT_OPPORTUNITIES`（写的是「机会数门槛」）失去了「这个指标被观测够了吗」的含义。

---

### F3 — CRITICAL：方向检验与强度用了不同的样本量 → 判决不可复现且随手数翻转

**最小复现**：`scripts/rt7-probe9.ts` 头条 3；`scripts/rt7-probe6.ts` B 段

**实际观测**（基线 VPIP 15%，真实率恒为 25%，`s = round(0.25n)`）：
```
 n   全历史机会数   W20 raw  W20 机会  W20 adjusted    ENTRY 方向  状态             分数  RANGE↑
 40           40      0.25        20      0.240001         NONE  NORMAL               5  无
 50           50       0.3        20      0.285001       HIGHER  LOOSER_RECENTLY     14  有
 60           60      0.25        20      0.240001         NONE  NORMAL               5  无
 70           70       0.3        20      0.285001       HIGHER  LOOSER_RECENTLY     14  有
 80           80      0.25        20      0.240001       HIGHER  LOOSER_RECENTLY      9  有
100          100      0.25        20      0.240001       HIGHER  LOOSER_RECENTLY      9  有
200          200      0.25        20      0.240001       HIGHER  LOOSER_RECENTLY      9  有
```
n=40 / 60 / 80 的 W20 窗口统计**逐位相同**（`rawRate 0.25`、`20` 次机会、`adjustedRate 0.240001`），方向却从 `NONE` 翻成 `HIGHER`，状态从 `NORMAL` 变 `LOOSER_RECENTLY`，并凭空多出一次范围放宽。
⇒ **快照公布的数字无法复算出 `direction`**；判定取决于调用方多喂了多少手**同一水平**的历史。可解释性与审计链在这里断裂。

**机理**：`metricDeviation` 用 `samples = Math.max(stat.opportunities, countOpportunities(全部近期事件))` 算噪声门槛（∝1/√n），却拿 **W20 窗口** 的 `rawRate` 与之比较。n↑ → 门槛↓ → 同一窗口差异被「显著化」。

**误报率随历史长度上升**（`rt7-probe6.ts` B，13 指标/手，真值 = 基线，400 个确定性 LCG 种子）：

| 历史手数 | 状态≠NORMAL（= 产出调整） | 虚假「方向冲突」提示 | 分数均值 | 分数 P95 |
|---|---|---|---|---|
| 20 | 12.3% | 0.3% | 20.2 | 36 |
| 30 | 29.5% | 3.5% | 22.2 | 40 |
| 40 | 38.8% | 5.5% | 24.7 | 41 |
| 60 | 50.7% | 12.5% | 25.4 | 41 |
| 100 | 50.7% | 10.8% | 26.0 | 40 |
| 200 | 46.3% | 30.0% | 24.3 | 36 |

**影响**：a) 同一玩家在不同历史长度下得到相反结论；b) 用得越久误报越多（200 手时 30% 的数据会出现误导性的「方向冲突」提示）；c) 回放/审计无法复现判定。

---

### F4 — MAJOR：`deviationScore` 没有零假设刻度

**最小复现**：`scripts/rt7-probe3.ts` A 段

**实际观测**（真值 = 基线，400 种子，20 手，13 指标/手）：
```
deviationScore 均值 19.82   P50 17   P95 35   MAX 49
> 20 分占 35.5%     > 30 分占 11.0%
状态 ≠ NORMAL 占 12.0%（其中 LOOSER 4.8% / TIGHTER 6.8% / AGGRESSION_UP 0.5%）
误报调整的最大幅度 |因子 − 1| = 0.2523（= 上限）
一个误报样例：seed=110866 状态=LOOSER_RECENTLY 分数=48 调整=[RANGE_WIDTH INCREASE 0.900]
```
**机理**：`metricDeviation` 的 `strength` 不做任何显著性门槛；`aggregateGroup` 在组方向为 `NONE` 时仍把 `strength × cap × 0.5` 计入总分。于是「随机波动 + 向基线收缩后的残差」直接变成分数。

**影响**：任何「分数 > X 才算变化」的用法都会产生大量误报；分数不可跨历史长度比较；且误差幅度与真实变化的上限相同（都是 1.2523×），数值幅度不携带任何区分信息。

---

### F5 — MAJOR：「尺寸异常」维度是死代码；翻后/转牌行为完全不可见

**最小复现**：`scripts/rt7-probe5.ts` D 段

**实际观测**：
```
超池/全下/尺寸比全开 vs 完全不提供 → 快照 JSON 逐位一致 = true
SIZING 组：score=0  direction=NONE  comparedMetrics=0
是否出现过 SIZE_ANOMALY 信号：false
RIVER_OVERBET（未登记）全命中 → 状态=NORMAL 分数=0  该指标是否进入偏差计算：否
CBET（未登记）全命中        → 状态=NORMAL 分数=0  否
TURN_BARREL（未登记）全命中  → 状态=NORMAL 分数=0  否
RIVER_CALL（已登记）全命中   → 状态=NORMAL 分数=18 是
```
**源码事实**：`METRIC_GROUP` 里**没有任何指标映射到 `DeviationGroup.SIZING`** → `aggregateGroup(SIZING)` 永远返回 `score 0` → `dynamicBehavior.ts:373`（`sizing.score > 0`）与 `:447`（`sizing.score > 0.25`）**不可达**，`SIZE_ANOMALY` 永不出现。
`isOverbet` / `isAllIn` 在整个 `src/` 下**从未被读取**；`betSizePotRatio` 只被 `validateEvent` 校验（见 F10）。
未登记指标共 12 个：`FOLD_TO_THREE_BET / CBET / FOLD_TO_CBET / RAISE_CBET / CHECK_RAISE_FLOP / TURN_BARREL / TURN_FOLD / TURN_RAISE / TURN_CHECK_RAISE / RIVER_BARREL / RIVER_OVERBET / RIVER_SHOWDOWN`。

**影响**：a) 9 种状态中的 `SIZE_ANOMALY` 是空头承诺，`ObservedPokerEvent` 的三个尺寸字段是死字段；b) **只改变翻后/转牌打法的玩家完全不可见**（假阴性）；c) 这些指标的机会数还会被算进 F2 的门槛，反而降低保护。

---

### F6 — MAJOR：上下文事件不校验 `playerId` / `timestamp` / `observedAfterEventIds`

**最小复现**：`scripts/rt7-probe5.ts` E 段

**实际观测**（40 手，VPIP 15%→60%，锚点 `seq=20`）：
```
变体                                        与「无上下文」逐位一致  tilt概率
无上下文事件                                    —          0.0000
正确 playerId                               否          0.6248
playerId = somebody-else（别人的损失）           否          0.6248   ← 与正确玩家完全相同
timestamp = 2099（未来才发生的损失）               否          0.6248
observedAfterEventIds = ["e21"]（应只看 1 条）   否          0.6248
handId 不存在                                否          0.6248
```
**源码事实**：`analyzeContextEvents` 只读 `c.seq`；`ContextEvent.playerId`、`timestamp`、`observedAfterEventIds`（类型注释承诺「该事件之后需要观察的事件 id 范围」）在整个 `src/` 下**从未被读取**。

**影响**：把多名玩家的上下文事件一起传入（很自然的调用方式）会让 A 的损失锚点抬高 B 的 `CHASE_LOSS`/Tilt 概率；「未来才发生的损失」会立刻生效（时间锚点失效）。这与「个人数据优先」与「结果隔离」的立场直接冲突。

---

### F7 — MAJOR：人工 Hint 时间戳被忽略、静默丢弃、与 `tilt.probability` 自相矛盾

**最小复现**：`scripts/rt7-probe5.ts` F 段

**实际观测**：
```
无 Hint                 ：状态=NORMAL      分数=8 置信=0.333 tilt=0.000 信号=[] 调整=[]
Hint 时间戳 = 2099（未来）：状态=TILT_SIGNAL 分数=8 置信=0.317 tilt=0.000 信号=[] 调整=[CALL_LIKELIHOOD,FOLD_LIKELIHOOD]
Hint 时间戳 = 2020（过去）：状态=TILT_SIGNAL 分数=8 置信=0.317 tilt=0.000 信号=[] 调整=[CALL_LIKELIHOOD,FOLD_LIKELIHOOD]
未来 Hint 与过去 Hint 输出逐位一致 = true
调整幅度：["CALL_LIKELIHOOD INCREASE ×1.0824","FOLD_LIKELIHOOD DECREASE ×0.9239"]
选择规则：[NORMAL(新), SUSPECT_TILT(旧)] → TILT_SIGNAL；[SUSPECT_TILT(旧), NORMAL(新)] → NORMAL
静默丢弃：resolveUserHints(机会数=12, 置信=0.9) → {"state":"TIGHTER_RECENTLY","confidence":0.43,
                                                    "conflicts":[],"overridden":false}
```
**问题点**：
1. 类型注释明说 `timestamp` 「用于判断是否早于 asOf」，实际**完全未使用**；`resolveUserHints` 只取 `hints[hints.length-1]`（数组最后一条，而非时间戳最新一条）。
2. 结果自相矛盾：`dominantState = TILT_SIGNAL`，而 `tilt.probability = 0`、`tilt.confidence = 0`、`signals = []`、`deviationScore` 仍由真实数据给出。消费者读 `tilt.probability` 得到 0，读 `dominantState` 得到 TILT_SIGNAL。
3. 静默丢弃：真实 `confidence ≥ 0.5` 但 `recentOpportunities < 16` 时，Hint 既不生效、也不记录冲突、`overridden` 仍为 `false`，快照里没有任何痕迹。
4. 快照**没有 provenance 字段**，无法区分「这个状态来自 USER_OBSERVED」还是「来自真实数据」。
5. 一次点击即可产出 ±8~25% 的范围因子（此处 ×1.0824 / ×0.9239），而真实数据支持为零。

---

### F8 — MAJOR：Fail Closed 失效（崩溃 + 静默接受）

**最小复现**：`scripts/rt7-probe4.ts` B 段；`scripts/rt7-probe5.ts` B 段

**实际观测**（`evaluateDynamicBehavior` 直接抛异常，未返回 `DynamicFailure`）：
```
opportunities = {}          → ✖ 崩溃 TypeError: object is not iterable
opportunities = 42          → ✖ 崩溃 TypeError: number 42 is not iterable
opportunities = [null]      → ✖ 崩溃 TypeError: Cannot read properties of null (reading 'metric')
opportunities = [{}]        → ok（未拒绝）  W20 出现 "undefined:0/1" 统计项，ignored=0
success = "yes"             → ok（未拒绝）  与 success:true 完全等效（20/20 全算命中）
success = 1                 → ok（未拒绝）  同上
success 缺失                → ok（未拒绝）  一律按失败计（20/0，rawRate 0.000）
metric = "NOT_A_METRIC"     → ok（未拒绝）  作为正常指标进入 windows[].stats 与 totalOpportunities
metric = null               → ok（未拒绝）  同上
```
`DynamicErrorCode.MALFORMED_EVENT` 已定义但从未被使用。
**源码位置**：`dynamicStats.ts:109-114`（`Array.isArray` 报错后仍继续 `for...of`）、`:111`（不对 `metric`/`success` 做类型与取值校验）。

**影响**：热路径遇到畸形输入会抛异常（训练循环里等于崩溃）；而「不抛异常」的脏数据会静默改变统计口径（`success` 缺失 → 命中率被系统性拉低；未知指标 → 推高充分性门槛）。

---

### F9 — MAJOR：`asOf` 非有限值 → 未来事件全部参与计算 + 快照字段污染

**最小复现**：`scripts/rt7-probe5.ts` A 段

**实际观测**（20 条事件，时间戳全部在 `asOf` 之后 30 天）：
```
asOf=1780272000000 → 未来事件被忽略 20、W20 机会 0、UNKNOWN、0 分、快照 asOf=1780272000000
asOf=NaN           → 未来事件被忽略 0、 W20 机会 100、NORMAL、34 分、快照 asOf=NaN（JSON → null）
asOf=Infinity      → 未来事件被忽略 0、 W20 机会 100、NORMAL、34 分、快照 asOf=Infinity（JSON → null）
asOf=-Infinity     → 未来事件被忽略 20、UNKNOWN
```
**机理**：`time > asOf` 对 NaN 恒为 `false`（过滤失效）；`validateBaseline` 只校验 baseline，从不校验 `asOf`。
**影响**：未来数据泄漏进「最近表现」；`NaN/Infinity` 进入快照会污染缓存 key 与 JSON 产物（序列化后变成 `null`）。

---

### F10 — MAJOR：一个从不参与计算的字段能让整条事件的机会全部丢失

**最小复现**：`scripts/rt7-probe5.ts` C 段

**实际观测**（8 手，VPIP 7/8）：
```
场景                                 W20 机会数  被丢弃事件  状态               分数  调整
无 betSizePotRatio                     8        0      LOOSER_RECENTLY  26   1
betSizePotRatio = 0.75（合法）            8        0      LOOSER_RECENTLY  26   1
betSizePotRatio = -1（非法）             0        8      UNKNOWN           0   0
betSizePotRatio = NaN                  0        8      UNKNOWN           0   0
isOverbet = true / isAllIn = true      8        0      LOOSER_RECENTLY  26   1
isOverbet = "垃圾值"                     8        0      LOOSER_RECENTLY  26   1
```
**影响**：调用方只要在尺寸计算里产生一次 `NaN`/负值，该手的**全部**指标机会（VPIP/PFR/3Bet…）都会消失；样本稀薄时直接把检测打成 UNKNOWN（漏报）。而该字段对输出**没有任何贡献**（F5），属于「校验了不该校验的东西」。

---

### F11 — MAJOR：收缩公式与文档不变量差 c 倍；时间衰减被抹平；`MAX_SINGLE_EVENT_SHARE` 是死常量

**最小复现**：`scripts/rt7-probe1.ts` E/H 段

**实际观测**（基线 VPIP 0.15、基线 confidence 0.9、20 次机会 12 次命中）：
```
快照给出的 adjustedRate = 0.555003（rawRate = 0.6000）
实现所用 k = ((REF − c)/c) × quality = ((60 − 20)/20) × 0.9 = 1.8000
        → (加权命中 + 1.8 × 0.15) / (16.201 + 1.8) = 0.555003   ✔ 与快照一致
文档口径 k = REF − c = 36.0
        → (加权命中 + 36 × 0.15) / (16.201 + 36) = 0.289663
实测权重占比：基线 10.0% / 近期 90.0%；文档声称「(REF − c) : c = 40 : 20」= 基线 66.7%

关键刻度（文档称 vs 实现）：
 c=1  → 基线 98.3%（文档 98.3%，一致）
 c=5  → 68.8%（文档 91.7%）
 c=20 → 9.1%（文档 66.7%）
 c=30 → 3.2%（文档 50.0%，文档称此处「等权」）
 c=59 → 0.0%（文档 1.7%）
```
⇒ 文档的不变量 `基线 : 近期 = (REF − c) : c` 要求 `k = REF − c`，实现却给了 `(REF − c)/c`：**保护强度比文档声称的弱 c 倍**（20 手时 ≈10×）。这正是 F3/F4 误报的直接放大器。

**时间衰减被抹平**：
```
20 次机会（age 19..0，半衰期 30）：
  Σw(原始) = 16.201356，Σw(capped) = 16.201356
  capped 权重去重后个数 = 1  ← 完全均匀，时间衰减被单手影响上限抹平
  effectiveSampleSize：原始 19.6524 → capped 20.0000
```
`capSingleHandWeight` 在 `positiveCount ≤ 20` 且最新权重为 1 时，`minAchievableShare = 1/c ≥ maxShare = 0.05`，二分必然收敛到 `α = 0`（完全均匀）。因此**常见指标在 20 手窗口里 `RECENT_HALF_LIFE_HANDS = 30` 完全不起作用**。

**死常量**：`MAX_SINGLE_EVENT_SHARE`（`dynamic.types.ts:552`）只在 `dynamicBehavior.ts:41` 被 import、`:874` 原样 re-export，**任何计算都未使用**；实际生效的是 Step 6 的 `DEFAULT_DECAY.maxSingleHandShare`。改 Dynamic 自己的常量不会改变任何输出。`RecentBehaviorStat.effectiveSample` 也无任何消费者（`dynamicDeviation` 用的是 `stat.opportunities` 与 `stat.confidence`）。

---

### F12 — MAJOR：热路径 P95 在 5000 条事件处突破 20ms

**最小复现**：`scripts/rt7-probe7.ts`

**实际观测**（每事件 5 次机会，基线 25 个指标）：
```
事件数  观测数   P50(ms)  P95(ms)  MAX(ms)  P95 达标
1      5       0.1267   0.2492   0.7156   是
10     50      0.1557   0.3502   0.8817   是
50     250     0.3824   0.7104   1.4425   是
200    1000    0.7510   1.3461   1.8045   是
1000   5000    2.9348   5.0927   5.4982   是（另一轮 4.02 / 6.27 / 6.63）
2500   12500   6.055    10.711   11.554   是
5000   25000   20.262   31.318   40.672   否（另一轮 28.60 / 31.68 / 33.08）
10000  50000   24.164   30.748   34.543   否
```
增长曲线（P50）：1000→5000 规模 ×5、耗时 ×7.1（超线性指数 ≈1.22）。
最坏情况（每事件 25 次机会）：1000 事件 → P95 8.70ms（达标）。
**成本归因**：`normalizeEvents` 的 `sort` 比较器里**每次比较调用两次 `Date.parse`**：
```
5000 条排序：比较器内 Date.parse = 3.568ms；预解析后排序 = 0.355ms（≈10×）
仅排序一项就占总 P50（≈20ms）的 17.8%
```
**影响**：长会话/批量回放超出预算；且「只有最近 50 手参与统计」却要付 O(全部历史) 的代价（`normalizeEvents` / `countOpportunities` 都遍历全部事件）。现有性能测试只覆盖到 1000 条，因此没有发现。
**未确认**：5000 条事件是否属于设计输入范围（类型层没有上界）；若不属，本条可降级为 MINOR。

---

### F13 — MAJOR（原始形态）→ 已在审计期间被并发修复，残留 MINOR

**原始形态（修订 `dynamicAdapter.ts = 11F7F28A7E0E13ED`，`scripts/rt7-probe6.ts` A 段）**：
```
adjustments 里 FOLD_LIKELIHOOD 出现两次（INCREASE 0.9 / DECREASE 0.9）
旧 adaptAdjustments → FOLD_LIKELIHOOD INCREASE（因子 1.000，UNVERIFIED_MAGNITUDE）
reasons = ["进攻性下降通常伴随更愿意弃牌","损失之后行为偏移，可能更不愿意弃牌"]
```
即 `direction` 说「提高」、`multiplier` 说「完全不动」，且没有 `conflicting` 之类字段告知调用方。**该形态在我审计期间被并发修复**（现修订 `47F6855048D2B06D`）：新实现改为在对数域分别累加、取净效应方向，并新增 `conflicting: boolean`，`describeAdaptation` 会输出「方向冲突已抵消」。

**残留问题（现修订上可复现）**：
```
logInc = 0.22500000000000006   logDec = -0.22499999999999998   和 = 8.326672684688674e-17（≠ 0）
netLog > 0 → direction = INCREASE；而 Math.exp(netLog) === 1（严格等于 1）
输出：FOLD_LIKELIHOOD  INCREASE  multiplier = 1  conflicting = true
      describeAdaptation: "FOLD_LIKELIHOOD INCREASE（因子 1.000，方向冲突已抵消，UNVERIFIED_MAGNITUDE）"
```
⇒ 两条等幅反向调整时，`direction` 由**浮点噪声**（8.3e-17）决定，而不是由「无净方向」决定。人读的字符串已被 `conflicting` 救回；**机器读的 `direction` 字段仍然自相矛盾**（`INCREASE` + `multiplier === 1`）。建议用 `Math.abs(netLog) < ε` 判无净方向。

**仍然存在（现修订）**：`multiplierOf(direction, confidence)` 是导出 API，直接返回 `exp(±0.25 × confidence)`（`confidence=1 → 1.284025`），**不带任何 provenance**。只有 `adaptAdjustments` 的返回值带 `UNVERIFIED_MAGNITUDE`。任何调用方绕过 `adaptAdjustments` 即可拿到「看起来像已验证幅度」的数字。

---

### F14 — MINOR：重复 `eventId` 内容不同 → 结果依赖输入数组顺序

**最小复现**：`scripts/rt7-probe4.ts` C 段
**实际观测**：两条 `eventId='dup'`（一条 VPIP=true、一条 false）
```
[a, b] → deviationScore 2, ENTRY direction HIGHER
[b, a] → deviationScore 0, ENTRY direction NONE
逐位一致 = false
```
`normalizeEvents` 的文档（`dynamicStats.ts:150`）写「结果**不依赖输入数组顺序**」，去重却是 first-wins。
**影响**：同一批数据以不同顺序重放会得到不同分数（幂等/可复现契约在「同 id 不同内容」下失效）。

---

### F15 — MINOR：其他契约/死代码问题（均已实测）

1. **死参数**：`deriveState` 的 `windows`、`ignoredCount` 从未使用；`positionalStrength` 的 `maxSeq`（`void maxSeq`）、`river`（`void river`）同上。
2. **分数刻度几乎没有分辨力**：`MAX_TOTAL_GROUP_SCORE = 3.8`；单组变化最多只能拿到 26/100（VPIP 15%→100% 实测 26），干净场景下分数只出现 0/5/9/13/14/21/22/24/25/26 这些台阶。
3. **`USER_HINT_PROBABILITY_CAP` 语义错位**：被当作 **confidence** 上限使用（`finalConfidence = Math.min(hint.confidence, USER_HINT_PROBABILITY_CAP)`），与其名字/注释（「最高状态概率」）不符。
4. **`explanation` 与 `dominantState` 可能矛盾**：probe9 场景 1-A 中 `explanation` 说「偏离个人基线」并附冲突说明，`dominantState` 却是 `AGGRESSION_DOWN`；probe2 变体 B 中 `explanation` 说「偏离」而状态是 `NORMAL`、无调整。
5. **`baseline.metrics` 接受任意键**（非 `PlayerMetric`）：注入 20 个伪造指标（`confidence = 1`）把快照 `confidence` 从 `0.900000` 抬到 `0.906846`；`validateBaseline` 会逐个校验伪造项的数值合法性，但不会拒绝它们。
6. 快照无 provenance 字段（见 F7-4）。

---

## 3. 明确「未发现问题」的部分（本轮实验范围内）

- **不可变性（深冻结）：PASS**。16 处嵌套写入全部抛 `TypeError`，包括 `groupScores[0].score`、`groupScores.push`、`windows[0].stats[0].confidence`、`windows[0].eventIds[0]`/`.push`、`tilt.evidence[0]`、`tilt.probability`、`signals[0].drivers.push`、`adjustments[0].reasons[0]`、`adjustments[0].confidence`、`ignoredEvents[0].reason`、`evidenceEventIds.push`、`conflicts.push`、`explanation.push`；递归遍历快照**未发现任何未冻结对象**。
- **确定性：PASS（除 F14）**。同输入两次逐位一致；事件数组逆序逐位一致；`baseline.metrics` 键序不同逐位一致；重复（同内容）事件逐位一致。
- **类型层隔离：PASS**。5 种注入（input 多余属性 / `Object.setPrototypeOf` 原型链注入 / baseline 快照 / 每条事件 / `baseline.metrics` 每一项，注入 `adjustedRange`、`inferredVillainRange`、`finalAction`、`recommendation`、`decisionConfidence`、`exploitOutput`、`previousDynamicState`、`previousTiltProbability`、`tilt`、`showdownRange`、`finalProfitLoss`、`decision`、`action`）——输出与干净输入**逐位一致**。
- **结果隔离：PASS**。同行为 + `COOLER`/`LOST_BIG_POT` 上下文 vs `WON_BIG_POT`/`SHOWDOWN` 上下文 → 逐位一致（输赢本身不进入评分）。
- **数值稳定性：除 F9 外未发现问题**。基线率恰为 0 / 恰为 1、`seq = Number.MAX_SAFE_INTEGER`、`seq = 1.5`（被合法拒绝）、全部时间戳相同、500 手事件、全部指标极端、重复事件 ×3 —— 均未产生 `NaN`/`Infinity`/越界值，快照各字段范围正确。
- **`takeWindow` 手数边界、`countOpportunities` 语义、组上限（`GROUP_CAPS`）不超限**：本轮未发现异常。
- **接入状态（INFO）**：`src/domain/dynamic/*` 目前**没有任何仓内消费者**（仅 `src/infra/artifactDefinitions.ts` 的产物清单引用），因此上述问题的当前爆炸半径限于「接入方」；但接入即全部生效。

---

## 4. 结论

必须修的阻塞项（按优先级）：

1. **F1** — 经典偏离模式被判反，且输出自相矛盾（`entry.direction` 的组内冲突抹掉了方向，兜底分支不可达）。
2. **F2** — 充分性与 `confidence` 必须回到**每指标机会数**，不能用跨指标机会总数；否则「2 手 0.900 置信度 + 1.25× 幅度」无法避免。
3. **F3** — 方向检验的样本量必须与所比较的比率同源（同一窗口）；否则判决不可复现、误报率随使用时间上升。
4. **F6**（隔离纪律）— 上下文事件必须校验 `playerId`/时间戳/`observedAfterEventIds`。
5. **F8 / F9**（Fail Closed 纪律）— 畸形输入必须返回 `DynamicFailure` 而不是抛异常；`asOf` 必须校验有限性。

上述未修复前，本模块会：把「开始大量跟注」的对手读成「更爱弃牌」（F1）、用 2 手牌给出 0.900 置信度与 1.2523× 范围因子（F2）、并在无任何行为变化的数据上以 12%~51% 的概率报出变化（F3/F4）。

# Step 7 独立红队：FAIL

阻塞项：**F1、F2、F3**（CRITICAL）＋ **F6、F8、F9**（设计纪律：隔离 / Fail Closed / 时间窗）。
