# Step 6「玩家画像（Player Profile）」独立红队审计报告

- 审计日期：本轮审计会话（工作目录 `D:\德州`）
- 审计对象修订（SHA-256 前 12 位）：
  | 文件 | SHA-256 前缀 | 行数 |
  |---|---|---|
  | `src/domain/player/player.types.ts` | `BBEC252AE5F9` | 385 |
  | `src/domain/player/playerStats.ts` | `49B10927765A` | 353 |
  | `src/domain/player/playerProfile.ts` | `0DEBD6A602FB` | 389 |
  | `src/domain/player/playerClassifier.ts` | `4009838F7807` | 462 |
  | `src/domain/range/profileProvider.ts` | `FC34A7A1DD4B` | 488 |
  | `src/domain/range/handPotential.ts` | `BE9888CB305C` | 72 |
  | `test/playerProfile.test.ts` | `246434B9B3A0` | 996 |
  | `test/playerClassifier.test.ts` | `C45F339F5238` | 898 |
- 临时脚本目录：`tmp-rt-player/`（审计完成后已删除）
- **未修改 `src/` 与 `test/` 下任何文件。**

> **重要前提：审计期间仓库被并发修改。**
> 审计开始时 `profileProvider.ts` 为 372 行且 `RangeAdjustmentProvider` **未被任何生产代码调用**；
> 审计过程中该文件被改为 488 行，`rangeUpdate.ts` 新增了 `adjustmentProvider` 选项并**首次真正接入**，
> 同时新增了 `src/domain/range/gameEnvironment.ts`。本报告的全部结论均已在**上述最终修订**上重新跑过一遍完整复现，
> 全部仍然成立（唯一失效的旧结论「provider 未接入 updateRange」已在 §3-D12 中更新为对新接入路径的审计结果）。

---

## 1. 审计范围与方法

### 1.1 范围

六个被审计文件，以及因并发修改而必须一并审的 `src/domain/range/rangeUpdate.ts` 的 provider 接入段。

### 1.2 与开发者测试方法的差异

开发者测试（`test/playerProfile.test.ts` 60 项、`test/playerClassifier.test.ts` 51 项）的核心方法是
**「按实现的公开契约复算期望值，再断言实现等于该期望值」**。这种方式能锁住回归，但有两个结构性盲区：

1. **循环论证**：期望值由实现自己的辅助函数算出（例如 `decayedStats()` 内部调用 `capSingleHandWeight()`，
   而这正是被测函数本身）。一旦该辅助函数本身有偏差，测试与实现会**一起错**。
2. **只测「值」不测「语义」**：断言 `adjustedRate < 0.1`、`factors >= minFactor` 这类不等式，
   无法发现「先验被当成观测」「中立点偏移」「聚合口径不一致」这类**方向对但量级错**的缺陷。

本审计采用的方法：

| 方法 | 具体做法 |
|---|---|
| **独立复算** | 用不依赖 `src/` 的纯数学式重算期望值，与实现输出逐位比对（F2、F7、F17） |
| **公理反例搜索** | 对「凸组合区间」「占比上限」等已声明的不变量做 3000~4000 例确定性随机搜索，找最小反例（§4 #1、F7） |
| **语义基线法** | 构造「打法是**项目自己声明的先验中心**」的合成玩家，检查各维度是否读回 0.5（F5、F6） |
| **收敛性检验** | 同一玩家在不同手数（100→30000）下的维度轨迹，区分「有限样本效应」与「公式结构性偏差」（F6） |
| **不连续探测** | 在阈值两侧取 ±1e-9 的输入，测量调整因子的跳变量（F11、D8） |
| **可达性穷举** | 对 `deriveLabel` 做 833,931 组维度网格穷举，判定分支可达性（D6） |
| **故障注入** | 直接对深冻结对象、全局共享常量、可变 Set 做写入，实测抛错/静默（F1、F8） |
| **真实接入** | 把 provider 接进**真实的** `updateRange`，观察端到端概率分布（D2、F9、D12） |
| **元测试审查** | 逐条检查现有断言是否恒真、是否固化了缺陷、是否覆盖了关键层次（§5） |

共编写 19 个独立攻击脚本（`rt01`~`rt19`），全部可独立运行。

---

## 2. 基线

| 项目 | 审计开始时 | 审计结束时（当前修订） |
|---|---|---|
| 全量测试 | 734 tests / 734 pass / 0 fail | **794 tests / 794 pass / 0 fail** |
| `test/playerProfile.test.ts` | 60 / 60 pass | 60 / 60 pass |
| `test/playerClassifier.test.ts` | 51 / 51 pass | 51 / 51 pass |
| `npx.cmd tsc --noEmit` | **exit 2**：`test/rangeLogSpaceRedTeam.test.ts(32,45): error TS2459: Module '"../src/domain/range/rangeUpdate.ts"' declares 'ActionModel' locally, but it is not exported.` | **exit 0，0 行输出**（该错误已被并发修改修掉） |
| 新增测试文件 | — | `test/rangeProfileIntegration.test.ts`(517 行)、`test/gameEnvironment.test.ts` |

**基线结论：所有现有测试都是绿的。本报告的全部发现都发生在绿灯之下**——这正是本次审计存在的意义。

---

## 3. 发现列表

### 3.A CRITICAL

---

#### F1 —— `profile.decay` 是**未冻结的全局共享常量** `DEFAULT_DECAY`，一行赋值即可永久污染整个模块

- **严重级别：CRITICAL**
- **一句话结论**：`createProfile` 把模块级常量 `DEFAULT_DECAY` **按引用**存进画像，`freezeProfile` 对它不做任何冻结；
  任何持有画像的代码执行 `profile.decay.halfLife = 50` 都会改写全局衰减，之后**每一个**新建画像的统计结果全部改变。

**最小复现**（`tmp-rt-player/rt15-final.ts` F1 段）：

```ts
import { PlayerMetric } from '../src/domain/player/player.types.ts';
import { DEFAULT_DECAY, decayWeight } from '../src/domain/player/playerStats.ts';
import { createProfile, observeHand, metricOf } from '../src/domain/player/playerProfile.ts';

const TS = '2024-06-01T12:00:00.000Z';
const mk = (pid: string, n: number, s: number) => {
  let q = createProfile(pid);
  for (let i = 0; i < n; i++) {
    const r = observeHand(q, { handId: `${pid}-${i}`, playerId: pid, seq: i, timestamp: TS,
      observations: [{ metric: PlayerMetric.VPIP, success: i < s }] });
    if (r.ok) q = r.value;
  }
  return q;
};

console.log('decay 是否冻结 =', Object.isFrozen(createProfile('p3').decay));    // 期望 true → 实测 false
console.log('decay 是否共享全局常量 =', createProfile('p3').decay === DEFAULT_DECAY); // 期望 false → 实测 true
console.log('污染前 decayWeight(400) =', decayWeight(400));                      // 期望 0.5
const p = createProfile('p1');
p.decay.halfLife = 50;                       // 一行「只改我自己的画像」
console.log('污染后 decayWeight(400) =', decayWeight(400));                      // 全局函数已被改
console.log('污染后新建画像 adjustedRate =', mk('v', 100, 40).metrics[PlayerMetric.VPIP].adjustedRate);
DEFAULT_DECAY.halfLife = 400;
console.log('复原后新建画像 adjustedRate =', mk('v2', 100, 40).metrics[PlayerMetric.VPIP].adjustedRate);
```

**实测输出**：

```
  decay 是否冻结 = false
  decay 是否共享全局常量 = true
  Object.isFrozen(profile.decay) = false
  污染前 decayWeight(400) = 0.5
  污染后 decayWeight(400) = 0.00390625   （期望恒为 0.5）
  DEFAULT_DECAY.halfLife = 50   （期望 400）
  新建画像的 decay.halfLife = 50   （期望 400）
  污染后新建的 100 手画像 adjustedRate = 0.2480871175709116
  复原后新建的 100 手画像 adjustedRate = 0.34750616933630374  ← 两者必须相同
```

**期望输出**：`Object.isFrozen(profile.decay) === true`、`profile.decay !== DEFAULT_DECAY`、
`decayWeight(400)` 恒为 `0.5`、污染前后新建画像的 `adjustedRate` 完全相同。

**根因分析**：

- `playerProfile.ts:109` —— `const decay = options.decay ?? DEFAULT_DECAY;` **直接引用**模块常量，未克隆。
- `playerProfile.ts:152-157` —— `freezeProfile` 冻结了 `profile` 本体、`metrics`、每个 `MetricStat`、
  `stat.prior`、`log`、每个 `log` 元素、每个 `observations` 数组及其元素，**唯独没有冻结 `decay` 这一层**。
- 因此 `profile.decay` 与 `DEFAULT_DECAY` 是**同一个对象**，且完全可写。
- 污染后果可见：`decayWeight` 是导出函数，被 `recompute`（`playerProfile.ts:278`）使用；
  `DEFAULT_DECAY` 被所有未显式传入 decay 的 `createProfile` 使用。

**为什么现有测试没发现**：
`test/playerProfile.test.ts:779-797` 的深冻结测试逐层检查了
`profile` / `metrics` / `metrics[metric]` / `metrics[metric].prior` / `log` / `log[0]` /
`log[0].observations` / `log[0].observations[0]` —— **`decay` 这一层从未被检查**。
这与作者已经修过的「只冻结外层 `prior` 会污染 `METRIC_DEFINITIONS`」是**完全同一类缺陷**，
只是迁移到了另一个共享常量上。作者的注释（`playerProfile.ts:145-148`）恰好描述了这个模式，却没有推广到 `decay`。

**修复建议**：

```ts
// createProfile
const decay: DecayOptions = Object.freeze({ ...(options.decay ?? DEFAULT_DECAY) });
// freezeProfile：在返回对象里显式冻结/克隆
return Object.freeze({ ...profile, decay: Object.freeze({ ...profile.decay }), /* ... */ });
```

并在 `test/playerProfile.test.ts` 的深冻结测试中补上 `profile.decay` 与 `profile.seenHandIds`（见 F9）。

---

#### F2 —— `seq` 巨大的一手观测会**静默作废整个历史**（`adjustedRate` 塌回先验中心）

- **严重级别：CRITICAL**
- **一句话结论**：`recompute` 用「日志里的最大 `seq`」当"现在"，`seq` 只被校验为「非负整数」；
  一手 `seq=500000` 的合法输入会让其余所有手的衰减权重下溢为 0，
  于是 200 手 100% 入池的画像变成 `n_eff=1`、`adjustedRate` 塌回先验中心，且**零警告**。

**最小复现**（`tmp-rt-player/rt15-final.ts` F2 段）：

```ts
import { PlayerMetric, METRIC_DEFINITIONS } from '../src/domain/player/player.types.ts';
import { createProfile, observeHand, metricOf } from '../src/domain/player/playerProfile.ts';

const TS = '2024-06-01T12:00:00.000Z';
let p = createProfile('q');
for (let i = 0; i < 200; i++) {
  const r = observeHand(p, { handId: `H${i}`, playerId: 'q', seq: i, timestamp: TS,
    observations: [{ metric: PlayerMetric.VPIP, success: true }] });
  if (r.ok) p = r.value;
}
const a = metricOf(p, PlayerMetric.VPIP);
console.log(`200 手：rawRate=${a.rawRate} adjusted=${a.adjustedRate} n_eff=${a.effectiveSampleSize} conf=${a.confidence}`);

const r = observeHand(p, { handId: 'HX', playerId: 'q', seq: 500000, timestamp: TS,
  observations: [{ metric: PlayerMetric.VPIP, success: false }] });
if (r.ok) {
  const b = metricOf(r.value, PlayerMetric.VPIP);
  console.log(`+1 手 seq=500000：rawRate=${b.rawRate} adjusted=${b.adjustedRate} n_eff=${b.effectiveSampleSize} conf=${b.confidence}`);
  console.log('warnings =', r.warnings.length);
  console.log('先验中心 =', METRIC_DEFINITIONS[PlayerMetric.VPIP].prior.center);
}
```

**实测输出**：

```
  200 手 100% 入池：rawRate=1 adjustedRate=0.8870304571322843 n_eff=198.02191857597262 confidence=0.8684337006400349
  + 一手 seq=500000 未入池：rawRate=0.9950248756218906 adjustedRate=0.24193548387096775 n_eff=1 confidence=0.03225806451612903
  先验中心 = 0.25 → adjustedRate 塌回先验
  warning 数量 = 0（引擎对此完全静默）
```

**期望输出**：`adjustedRate` 应从 `0.887` 微降到约 `0.883`（200 手里加 1 手失败），
`n_eff` 应保持 ≈199。实测 `adjustedRate` 掉到 `0.242`（低于先验中心 0.25），
`n_eff` 从 198 掉到 1 —— **200 手证据被 1 手凭空作废**。

**根因分析**：

- `playerProfile.ts:268` —— `const maxSeq = log.reduce((max, item) => (item.seq > max ? item.seq : max), 0);`
  把最大 `seq` 当"现在"，没有任何合理性校验。
- `playerProfile.ts:277-278` —— `age = maxSeq - hand.seq; weight = 2^(-age/halfLife)`。
  `halfLife=400` 时 `age ≥ 480000` 即 `2^-1200` **下溢为 0**（实测 `age=415000 → 4.8e-313`（次正规）、`age=500000 → 0`）。
- `playerProfile.ts:193-195` —— `seq` 的唯一校验是 `!Number.isInteger(seq) || seq < 0`，
  且该问题被归入 `NEGATIVE_COUNT` **非阻塞**警告（`playerProfile.ts:229-231` 只阻塞
  `PLAYER_MISMATCH` / `DUPLICATE_HAND` / `INVALID_TIMESTAMP`）。
- 更根本的设计问题：`timestamp` 字段被采集、被校验格式（`isValidTimestamp`），
  但**从未参与任何计算**。真正的时间语义被一个无上界的整数取代。
- `capSingleHandWeight` 在这里没有救场：唯一正权重的观测 `positiveCount === 1`，
  函数在 `playerStats.ts:133` 直接 `return sanitized` 不做处理。

**修复建议**（三者至少取一，建议全做）：

1. `seq` 校验改为**阻塞**，并对 `maxSeq − minSeq` 设上限（例如 `> halfLife × 20` 时拒绝并报错）；
2. 用 `timestamp` 推导 `age`（画像已有该字段，语义正确且有真实上界），`seq` 仅作稳定排序键；
3. 至少要让「绝大多数观测权重下溢为 0」成为一种**显式错误**（例如
   `if (positiveWeightCount < log.length * 0.5) throw`），而不是静默产出先验值。

---

#### F3 —— `amendHand` 不做去重、不做 `seq` 校验，与 `observeHand` 行为不一致，且可用 `NaN` 让整个引擎崩溃

- **严重级别：CRITICAL**
- **一句话结论**：`observeHand` 对「同一手内重复指标」去重且校验 `seq`；
  `amendHand` 两者都不做 —— 结果既违反「修正后 == 一开始就录对」的显式契约，
  又能让 `seq=NaN` 在 `recompute` 深处抛出未处理异常。

**最小复现**（`tmp-rt-player/rt15-final.ts` F3 段）：

```ts
import { PlayerMetric } from '../src/domain/player/player.types.ts';
import { createProfile, observeHand, amendHand, metricOf, type HandObservation } from '../src/domain/player/playerProfile.ts';

const TS = '2024-06-01T12:00:00.000Z';
const V = PlayerMetric.VPIP;
let p = createProfile('a');
for (const [i, s] of [[0, true], [1, true]] as const) {
  const r = observeHand(p, { handId: `H${i}`, playerId: 'a', seq: i, timestamp: TS,
    observations: [{ metric: V, success: s }] });
  if (r.ok) p = r.value;
}
// 修正 H0，给出「同一手内 3 个重复的 VPIP」
const dup = [{ metric: V, success: true }, { metric: V, success: false }, { metric: V, success: false }];
const am = amendHand(p, 'H0', { seq: 0, timestamp: TS, observations: dup });

// 「一开始就录对」= 用 observeHand 录同一份数据
let direct = createProfile('a');
for (const [i, obs] of [[0, dup], [1, [{ metric: V, success: true }]]] as const) {
  const r = observeHand(direct, { handId: `H${i}`, playerId: 'a', seq: i, timestamp: TS, observations: obs as never });
  if (r.ok) direct = r.value;
}
if (am.ok) {
  const x = metricOf(am.value, V), y = metricOf(direct, V);
  console.log(`amendHand  : s=${x.successes} n=${x.opportunities} adjusted=${x.adjustedRate}`);
  console.log(`observeHand: s=${y.successes} n=${y.opportunities} adjusted=${y.adjustedRate}`);
}
// seq 校验
for (const seq of [-5, 1.5]) {
  const r = amendHand(p, 'H0', { seq, timestamp: TS, observations: [{ metric: V, success: true }] });
  console.log(`seq=${seq} → ok=${r.ok} log[0].seq=${r.ok ? r.value.log[0]!.seq : '-'} warnings=${r.ok ? r.warnings.length : '-'}`);
}
try {
  amendHand(p, 'H0', { seq: Number.NaN, timestamp: TS, observations: [{ metric: V, success: true }] });
} catch (e) { console.log('seq=NaN → 抛错:', (e as Error).message); }
```

**实测输出**：

```
  amendHand : successes=2 opportunities=4 adjustedRate=0.27940352597260354
  observeHand: successes=2 opportunities=2 adjustedRate=0.2968369552007974
  ★ 不一致：同一手内 3 个重复指标被计成 3 次机会
  amendHand seq=-5 → ok=true log[0].seq=-5 warnings=0
  amendHand seq=1.5 → ok=true log[0].seq=1.5 warnings=0
  amendHand seq=NaN → 【抛错】computeMetricStat(VPIP): 观测权重必须是非负有限数（收到 NaN）
```

**期望输出**：两条路径应逐位相等（`opportunities` 都是 2、`adjustedRate` 都是 `0.2968369552007974`）；
`seq=-5`/`seq=1.5`/`seq=NaN` 应被拒绝或至少报出 `NEGATIVE_COUNT` 警告。

**根因分析**：

- `playerProfile.ts:334` —— `observations: replacement.observations.filter((o) => ALL_PLAYER_METRICS.includes(o.metric))`
  只过滤未知指标，**没有 `observeHand:234-242` 的去重逻辑**。
- `playerProfile.ts:332` —— `seq: replacement.seq ?? target.seq` **完全没有走 `validateObservation`**。
- `playerProfile.ts:322-324` —— `amendHand` 只校验 `timestamp`。
- `seq=NaN` 时 `maxSeq` 变 `NaN` → `age = NaN - seq = NaN` → `weight = Math.pow(2, NaN) = NaN`
  → `computeMetricStat:240` 抛错。注意抛错点距离错误输入很远（`amendHand` → `recompute` → `computeMetricStat`），
  调用方无法把异常归因到具体是哪一手牌的哪个字段。
- 与显式契约冲突：`playerProfile.ts:310-312` 的注释写「修正后的统计与『一开始就录入正确数据』完全一致（有测试保证）」。
  该契约只在「修正数据本身就满足 `observeHand` 的规范化前提」时成立。

**修复建议**：把 `observeHand` 的规范化 + 校验抽成共享的 `normalizeObservation()`，
`amendHand` 复用它，并让 `seq` 非法成为阻塞性 issue。

---

### 3.B MAJOR

---

#### F4 —— `sampleSummary` 用原始 `opportunities` 而非 `effectiveSampleSize`，与同文件文档相反

- **严重级别：MAJOR**
- **一句话结论**：`playerProfile.ts:333-335` 的注释明确写「注意用的是 `effectiveSampleSize` 而不是原始 `opportunities`」，
  但 `playerProfile.ts:383` 实现用的是 `stat.opportunities` —— **文档与实现相反**。

**最小复现**（`tmp-rt-player/rt18-samplesummary.ts`）：

```ts
import { PlayerMetric } from '../src/domain/player/player.types.ts';
import { createProfile, observeHand, sampleSummary } from '../src/domain/player/playerProfile.ts';

const TS = '2024-06-01T12:00:00.000Z';
let p = createProfile('decay');
for (let i = 0; i < 300; i++) {
  const r = observeHand(p, { handId: `D${i}`, playerId: 'decay', seq: i * 20000, timestamp: TS,
    observations: [{ metric: PlayerMetric.CBET, success: i === 299 }] });
  if (r.ok) p = r.value;
}
const st = p.metrics[PlayerMetric.CBET];
console.log(`opportunities=${st.opportunities} n_eff=${st.effectiveSampleSize} confidence=${st.confidence}`);
console.log('sampleSummary 判为充足?', sampleSummary(p).sufficientMetrics.includes(PlayerMetric.CBET));
```

**实测输出**：

```
  CBET: opportunities=300（原始计数）n_eff=21.98952879581153 confidence=0.42296072507552884 adjusted=0.582258064516129
  sampleSummary: 充足? true
  → 300 次机会里真正有信息量的只有 21.99 次，仍被判为「样本充足」
```

**期望输出**：`sufficientMetrics` 不应包含 `CBET`（其有效样本量仅 22，低于 30 的初步门槛）。

**根因分析**：`playerProfile.ts:383` —— `if (stat.opportunities >= 30 && stat.confidence >= 0.3)`。
`opportunities` 是**原始计数**，不含时间衰减；同文件的 `sampleTier` 文档（`playerStats.ts:334-335`）
与 `sampleSummary` 的注释（`playerProfile.ts:333-335`）都明确要求用有效样本量。

> 顺带说明一个**没有**出问题的变体：若把 30 次机会铺在较近的时间窗内（`seq = i*20000, i<30`），
> 实测 `n_eff = 21.99`、`confidence = 0.524`，仍会被判为「充足」——
> 但此时 `n_eff` 与 `opportunities` 的差距（22 vs 30）刚好没跨过门槛，属于侥幸而非正确。

**修复建议**：`if (stat.effectiveSampleSize >= 30 && stat.confidence >= 0.3)`。

---

#### F5 —— `passivity` 维度完全未按先验定标：把「先验水平」的玩家判为偏被动，且与 `computeDimensions` 的其它维度口径不一致

- **严重级别：MAJOR**
- **一句话结论**：`passivity = CALL_CBET / (CALL_CBET + FOLD_TO_CBET)` 直接把两个**原始收缩后比率**相除，
  而 `CALL_CBET` / `FOLD_TO_CBET` 的先验中心分别是 `0.40` / `0.45`（比值 `0.4706 ≠ 0.5`）；
  于是「打法是项目自己声明的常客中心」的玩家被判为 `passivity = 0.4705`（偏不被动），
  而**完全没有数据**的陌生人反而是中立的 `0.5`。

**最小复现**（`tmp-rt-player/rt12-neutral-drift.ts`）：

```ts
import { PlayerMetric, METRIC_DEFINITIONS } from '../src/domain/player/player.types.ts';
import { createProfile, observeHand } from '../src/domain/player/playerProfile.ts';
import { computeDimensions } from '../src/domain/player/playerClassifier.ts';

const TS = '2024-06-01T12:00:00.000Z';
const build = (pid: string, hands: number, plan: Array<[PlayerMetric, number]>) => {
  let p = createProfile(pid);
  for (let i = 0; i < hands; i++) {
    const observations = plan.map(([metric, rate]) => ({
      metric, success: Math.floor(i * rate) !== Math.floor((i - 1) * rate),
    }));
    const r = observeHand(p, { handId: `${pid}-H${i}`, playerId: pid, seq: i, timestamp: TS, observations });
    if (r.ok) p = r.value;
  }
  return p;
};
const CALL = METRIC_DEFINITIONS[PlayerMetric.CALL_CBET].prior.center;   // 0.40
const FOLD = METRIC_DEFINITIONS[PlayerMetric.FOLD_TO_CBET].prior.center; // 0.45

console.log('无任何机会      →', computeDimensions(createProfile('z')).passivity);
for (const n of [30, 100, 400, 2000]) {
  const d = computeDimensions(build(`p${n}`, n, [[PlayerMetric.CALL_CBET, CALL], [PlayerMetric.FOLD_TO_CBET, FOLD]]));
  console.log(`n=${n}（打法恒等于先验中心）→ passivity = ${d.passivity}  偏差 ${d.passivity - 0.5}`);
}
```

**实测输出**：

```
  无任何机会      → passivity = 0.5（中立）
  n=30   → passivity = 0.465463   偏差 -0.034537
  n=100  → passivity = 0.470475   偏差 -0.029525
  n=400  → passivity = 0.470456   偏差 -0.029544
  n=2000 → passivity = 0.470451   偏差 -0.029549
```

**期望输出**：四个手数下都应为 `0.5`（该玩家的真实倾向就是项目自己定义的"中立/常客"）。

**根因分析**：`playerClassifier.ts:216-221`

```ts
const callCbet = rateOf(profile, PlayerMetric.CALL_CBET);
const foldCbet = rateOf(profile, PlayerMetric.FOLD_TO_CBET);
const passiveDenominator = callCbet !== null && foldCbet !== null ? callCbet + foldCbet : null;
const callShare = passiveDenominator && passiveDenominator > 0 ? callCbet! / passiveDenominator : null;
const passivity = callShare === null ? 0.5 : callShare;
```

对比同一函数里的 `bluffTendency`（`playerClassifier.ts:197-213`）：那里先把每个指标的比率用
`relativeToCenter(rate, 该指标自己的先验中心)` 定标，再聚合，因此先验水平能正确映射回 `0.5`
（实测对照组 `n=2000 → 0.496450`，偏差仅 `-0.0036`，属于收缩残差）。

`passivity` 缺少这一步，直接把 `0.40` 与 `0.45` 当同一个尺子相加。
副作用：`passivity` 被系统性抬高约 `0.03`，导致
`callingThresholdFactor` 被低估、`foldToAggressionFactor` 被高估（见 F6 的实测数字）。

**修复建议**：对两个指标各自先做 `relativeToCenter`，再以「弃牌相对倾向」为轴合成，例如：

```ts
const callRel = callCbet === null ? null : relativeToCenter(callCbet, DEF.CALL_CBET.prior.center);
const foldRel = foldCbet === null ? null : relativeToCenter(foldCbet, DEF.FOLD_TO_CBET.prior.center);
const passivity = callRel === null || foldRel === null ? 0.5 : clamp01(0.5 + (callRel - foldRel) / 2);
```

（至少在两端对称、且在两者都处于先验中心时严格返回 0.5。）

---

#### F6 —— 一名「打法恒等于先验中心」的玩家，其调整因子会随手数**从 1.0 漂移到 0.978/1.028**（先验被当成观测）

- **严重级别：MAJOR**
- **一句话结论**：`tightness` 的中立点被隐含设为 `VPIP = 0.275`（代码中不存在此常量），
  但先验中心是 `0.25`；`passivity` 的中立点被隐含设为 `0.5`，但先验比值是 `0.4706`。
  结果是**同一个玩家、同样的真实打法**，仅仅因为「攒了更多手证据」，就从「不做任何调整」漂移到有明确方向的调整。

**最小复现**（`tmp-rt-player/rt12-neutral-drift.ts` 末段）：

```ts
// 玩家全程 25% 入池 / 18% PFR / 40% 跟注CB / 45% 弃牌CB —— 全部恰好等于 METRIC_DEFINITIONS 的先验中心
import { PlayerMetric } from '../src/domain/player/player.types.ts';
import { computeDimensions, computeAdjustment, readPlayer } from '../src/domain/player/playerClassifier.ts';
const plan: Array<[PlayerMetric, number]> = [
  [PlayerMetric.VPIP, 0.25], [PlayerMetric.PFR, 0.18],
  [PlayerMetric.CALL_CBET, 0.40], [PlayerMetric.FOLD_TO_CBET, 0.45],
];
for (const n of [0, 30, 100, 400, 2000]) {
  const prof = n === 0 ? createProfile('zz') : buildExact(`e${n}`, n, plan);
  const adj = computeAdjustment(computeDimensions(prof));
  console.log(n, adj.rangeWidthFactor, adj.callingThresholdFactor, adj.foldToAggressionFactor, readPlayer(prof).label);
}
```

**实测输出**：

```
  手数    rangeWidthF   callingThr   foldToAggr   标签
  0       1.000000      1.000000     1.000000     UNKNOWN
  30      1.000000      1.000000     1.000000     UNKNOWN
  100     0.971899      0.982005     1.022030     REG_AVERAGE
  400     0.966062      0.978313     1.026660     REG_AVERAGE
  2000    0.964392      0.977259     1.027988     REG_AVERAGE

  ★ 玩家的真实打法全程【完全没有变化】，但调整因子从「不调整」漂移到 rangeWidthFactor ≈ 0.964
```

以及三个维度的中立点偏移（同一脚本）：

```
  tightness    : 0 次机会 → 0.500000；VPIP 稳定在 25%（= 先验中心）→ 0.546575  偏差 +0.0466
  passivity    : 0 次机会 → 0.500000；CALL/FOLD 稳定在先验中心    → 0.470451  偏差 -0.0295
  bluffTendency: 0 次机会 → 0.500000；3Bet/RCB 稳定在先验中心    → 0.496450  偏差 -0.0035  ← 这一项是正确的做法
```

**期望输出**：若 `0.5` 表示「中立」，则「打法 = 先验中心」的玩家三个维度都应 ≈ `0.5`，
调整因子都应 ≈ `1.0`（与手数无关）。

**根因分析**：

- `playerClassifier.ts:181` / `129-133` —— `tightnessFromVpip(rate) = 1 − rate / VPIP_SCALE`，`VPIP_SCALE = 0.55`。
  `tightness = 0.5` ⟺ `VPIP = 0.275`；而 `METRIC_DEFINITIONS[VPIP].prior.center = 0.25`。
  两者不一致，且 `0.275` 这个数字在代码里**从未出现**，因此没有人会注意到它是一个隐含参数。
- `playerClassifier.ts:221` —— `passivity` 未定标（见 F5）。
- 语义矛盾：`player.types.ts:145` 的 prior 描述自称「常客玩家翻牌前入池率的常见区间中心约 25%」，
  即项目自己声明 25% 就是「典型常客」；但 `tightness` 把 25% 读成比陌生中立更紧 `0.0466`。

**修复建议**：把中立点与先验中心**显式绑定**，例如

```ts
export const VPIP_NEUTRAL = METRIC_DEFINITIONS[PlayerMetric.VPIP].prior.center; // 0.25
export function tightnessFromVpip(rate: number): number {
  const c = VPIP_NEUTRAL;
  const clamped = Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) : c;
  return clamped >= c ? 1 - 0.5 * (clamped - c) / (1 - c) : 0.5 + 0.5 * (c - clamped) / c;  // 中心 → 0.5
}
```

并相应调整 `vpipRateOf` 的逆映射与 `DEFAULT_LABEL_THRESHOLDS`（阈值语义需同步改为「相对先验中心的偏移」或保留百分比但重新标定）。

---

#### F7 —— `capSingleHandWeight` 在权重数组中含 0 时**违反自身声明的占比上限**（导出 API 的契约缺陷）

- **严重级别：MAJOR（潜在缺陷；经由 `computeMetricStat` 的当前调用链不可达）**
- **一句话结论**：函数的触发条件用 `positiveCount`（正权个数），而 `mean` 的分母用 `sanitized.length`（含 0 的总长度）；
  两个口径不一致，当两者差异足够大时二分收敛到 `α = 0`，返回**完全未受约束**的权重，最大占比超限 5.5 倍。

**最小复现**（`tmp-rt-player/rt16-cap-clean.ts`）：

```ts
import { capSingleHandWeight, effectiveSampleSize } from '../src/domain/player/playerStats.ts';

const zeros = new Array(38).fill(0);
const positives = [1, 0.3, 0.2, 0.15, 0.1, 0.09, 0.08, 0.07, 0.06, 0.05, 0.04];
const ws = [...zeros, ...positives];
const share = 0.08469611883163453;

const capped = capSingleHandWeight(ws, share);
const total = capped.reduce((s, w) => s + w, 0);
console.log(`n=${ws.length} 零权数=${zeros.length} 正权数=${positives.length}`);
console.log(`maxShare·n = ${share * ws.length}（>1 → 函数认为约束生效）`);
console.log(`cap 后权重 = [${[...new Set(capped.map((w) => +w.toFixed(9)))].join(', ')}]`);
console.log(`实测最大占比 = ${Math.max(...capped) / total}`);
console.log(`契约要求     ≤ ${share}`);
```

**实测输出**：

```
  n=49  零权数=38  正权数=11
  maxShare·n    = 4.150109822750092  （> 1，所以函数认为约束生效）
  cap 后权重（去重）= 0, 1, 0.3, 0.2, 0.15, 0.1, 0.09, 0.08, 0.07, 0.06, 0.05, 0.04
  实测最大占比 = 0.4672897196261682
  契约要求     ≤ 0.08469611883163453
  ★ 契约被违反（超出 5.5 倍）
```

第二个表现（更直观，`rt16` 第 2 段）：

```ts
const zeros = new Array(100).fill(0);
const positives = new Array(5).fill(0).map((_, i) => 1 - i * 0.1); // [1,0.9,0.8,0.7,0.6]
const capped = capSingleHandWeight([...zeros, ...positives], 0.15);
```

```
  n=105（零权 100）正权 5 个，maxShare=0.15
  maxShare·n = 15.75 > 1        正权数的倒数 = 0.2 > maxShare = 0.15
  cap 后权重 = [1.000000, 0.900000, 0.800000, 0.700000, 0.600000]   ← 完全未改动
  实测最大占比 = 0.25     契约要求 ≤ 0.15     ★ 契约被违反
```

**期望输出**：函数文档（`playerStats.ts:73-75`）声明
`max(新权重) ≤ maxShare · n · mean(w) = maxShare · Σw`，即 `最大占比 ≤ maxShare`。实测不成立。

**根因分析**（`playerStats.ts:117-164`）：

- `playerStats.ts:132` —— `const positiveCount = sanitized.reduce((count, w) => count + (w > 0 ? 1 : 0), 0);`
- `playerStats.ts:137` —— `if (maxShare * positiveCount <= 1 + 1e-9) return sanitized;` ← 触发条件用 `positiveCount`
- `playerStats.ts:131` —— `const n = sanitized.length;` ← **含零**
- `playerStats.ts:142` —— `const mean = total / n;` ← 分母用 `n`
- `playerStats.ts:145-152` —— `shareAt(0) = (total/n) / total = 1/n`
- 二分要成立，必须保证 `shareAt(0) = 1/n ≤ maxShare`；触发条件只保证了 `1/positiveCount ≤ maxShare`。
  由于 `positiveCount ≤ n`，`1/n ≤ 1/positiveCount`，**触发条件比实际需要弱**，存在 `1/n > maxShare ≥ 1/positiveCount` 的空隙。
- 落在空隙里时 `shareAt(0) > maxShare`，二分无解，`low` 保持 `0`，函数返回 `α=0` 的**完全均匀权重**——
  而此时最大占比等于 `max(w)/Σw` 的原始值（示例中 0.467），根本没有被约束。

**生产可达性（重要限定）**：
`computeMetricStat:246` 只把 `weight > 0` 的观测推入 `rawWeights`，因此经由画像路径传入的数组**不含 0**，
此时 `positiveCount === n`，触发条件恰好正确，契约成立。所以这**不是**一个当前可触发的线上错误，
而是**导出 API 的契约缺陷**：任何直接使用 `capSingleHandWeight` 的调用方（它是 `export`ed）
在 `maxShare·n > 1` 时都会得到「以为被夹住、实际没夹」的结果。
这也正是注释里提到的「与 `effectiveSampleSize` 同一口径」这句自我承诺没被执行的地方
（`effectiveSampleSize` 跳过 0，`capSingleHandWeight` 把 0 计入 `n`）。

**修复建议**：把 `n` 与 `positiveCount` 统一为同一个量：

```ts
// 方案 1：全部按有效（正权）个数计算，与 effectiveSampleSize 口径一致
const active = sanitized.filter((w) => w > 0);
const n = active.length;
const total = active.reduce((s, w) => s + w, 0);
// 并在返回时把 0 映射回 0
// 方案 2：保留长度语义，但把触发条件改成 if (maxShare * n <= 1 + 1e-9) return sanitized;
```

并在 `playerStats.ts` 补一条断言/测试：对任意含 0 的权重向量，
`max(capSingleHandWeight(w, s)) / Σcap ≤ s`。

---

#### F8 —— `seenHandIds` 是**未冻结的可变 Set**：外部掏空它即可绕过幂等保护、让同一 `handId` 被重复计数

- **严重级别：MAJOR**
- **一句话结论**：`freezeProfile` 原样传递 `seenHandIds`（`playerProfile.ts:155`），
  `Object.freeze` 对 Map/Set 的内部槽位无效；`profile.seenHandIds.delete('H0')` 之后，
  同一个 `handId` 会被第二次接受，`handsObserved` 与所有指标分母一起虚增。

**最小复现**（`tmp-rt-player/rt15-final.ts` 末段）：

```ts
import { PlayerMetric } from '../src/domain/player/player.types.ts';
import { createProfile, observeHand, metricOf, type HandObservation } from '../src/domain/player/playerProfile.ts';

const TS = '2024-06-01T12:00:00.000Z';
const mkh = (seq: number): HandObservation => ({
  handId: `S${seq}`, playerId: 's', seq, timestamp: TS,
  observations: [{ metric: PlayerMetric.VPIP, success: true }],
});
let sp = createProfile('s');
for (let i = 0; i < 3; i++) { const r = observeHand(sp, mkh(i)); if (r.ok) sp = r.value; }

console.log('正常重复 → ok =', observeHand(sp, mkh(0)).ok);        // 期望 false
(sp.seenHandIds as Set<string>).delete('S0');
const dup = observeHand(sp, mkh(0));
console.log('掏空后重复 → ok =', dup.ok, ' handsObserved =', dup.ok ? dup.value.handsObserved : '-');
console.log('log 中的 handId =', dup.ok ? dup.value.log.map((l) => l.handId).join(', ') : '-');
console.log('Object.isFrozen(profile.seenHandIds) =', Object.isFrozen(sp.seenHandIds));
```

**实测输出**：

```
  正常：重复录入 s-H0 → ok=false（期望 false）
  掏空 seenHandIds 后重复录入 s-H0 → ok=true（期望 false，实际被接受）
    handsObserved=4（期望 3，被计成 4）
    VPIP opportunities=4（期望 3）successes=4（期望 3）
    log 中的 handId = [s-H0, s-H0, s-H1, s-H2]
    同一 handId 出现 2 次 ← 事件日志被污染
  Object.isFrozen(profile.seenHandIds) = false
  掏空后重复 S0：ok=true（期望 false）handsObserved=4（期望 3）
```

**期望输出**：`seenHandIds` 在运行时不存在可用的写入口；重复 `handId` 永远被拒绝。

**根因分析**：

- `playerProfile.ts:155` —— `seenHandIds: profile.seenHandIds,` 直接透传。
- `Object.freeze(new Set())` 返回 `true` 但 `.add()` / `.delete()` 仍然生效（内部 slot 不受属性描述符约束）。
  项目在 `range.types.ts:140-151` 的 `ReadOnlyIndex` 注释里**已经明确记录了这个教训**
  （「红队审计发现 `range.indexById.set(...)` / `.clear()` 在运行时**真的能改**，
  而 `Object.freeze` 对 Map 的内部槽位无效。因此这里只暴露 `get` / `has`」）——
  同一模式在画像模块里没有复用。
- 后果链：`seenHandIds` 被掏空 → `validateObservation:187` 不再报 `DUPLICATE_HAND`
  → 同一 `handId` 进入 `log` 两次 → `recompute:276-282` 把它当两手不同的牌，各产生一次观测
  → 分母虚增。日志里出现重复 `handId`，而 `log` 是「修正历史」的唯一真相来源。

**修复建议**：照抄 `ReadOnlyIndex` 的做法，只暴露 `has`：

```ts
export type ReadOnlyIdSet = { has(id: string): boolean; readonly size: number };
// freezeProfile: seenHandIds: Object.freeze({ has: (id) => profile.seenHandIds.has(id), get size() { return profile.seenHandIds.size; } })
```

同时把 `PlayerProfile.seenHandIds` 的类型从 `ReadonlySet<string>` 改为该只读视图
（注：`ReadonlySet<T>` 是纯编译期约束，与 `ReadonlyMap` 一样挡不住运行时写入）。

---

#### F9 —— provider 的 `stats()` 在 `updateRange` 之后返回**过期且错误**的数据（`neutralized: true`, `adjustments: 0`），而 `describe()` 会偷偷改状态

- **严重级别：MAJOR**（新接入路径 `updateRange` 首次暴露，见 §3.D12）
- **一句话结论**：`finalize()` 只在 `describe()` 里被调用，`stats()` 是纯读取；
  接进真实的 `updateRange` 之后，`stats()` 会报告「0 次调整、已中性化」，
  而实际刚刚发生了 1326 次权重调整 + 1326 次似然调整。

**最小复现**（`tmp-rt-player/rt17-integration.ts` 第 2 段）：

```ts
import { updateRange } from '../src/domain/range/rangeUpdate.ts';
import { createProfileRangeProvider } from '../src/domain/range/profileProvider.ts';
// …（见脚本中 prior / model / ctx 的构造）
const provider = createProfileRangeProvider(readPlayer(build('s', 300, 210, 150)).adjustment);
const out = updateRange(prior, model, ctx, { adjustmentProvider: provider });
console.log('updateRange provider log:', out.value.provider);       // weightCalls=1326, weightAdjustments=1326
console.log('stats()（未经 describe）=', provider.stats());
console.log('describe() =', provider.describe());
console.log('stats()（describe 之后）=', provider.stats());
```

**实测输出**：

```
  provider log: weightCalls=1326 weightAdjustments=1326 factorsValid=true
  stats()（未经 describe）= {"providerId":"profile.range.adjustment.v1","adjustments":0,"minFactor":1,"maxFactor":1,"meanFactor":1,"direction":"UNCHANGED","neutralized":true}
  describe() = 依据玩家画像整体调宽范围（平均因子 1.07）
  stats()（describe 之后）= {"adjustments":2652,"minFactor":0.9743031610080866,"maxFactor":1.4029545257979616,"meanFactor":1.071165535421537,"direction":"WIDENED","neutralized":false}
```

**期望输出**：`updateRange` 返回后立即调用 `stats()` 应得到 `adjustments ≈ 2652`、`neutralized === false`、
`direction === 'WIDENED'`。`stats()` 作为文档标注「**只读**快照」的 API 不应依赖另一次调用才有内容。

**根因分析**（`profileProvider.ts:194-288`）：

- `finalize()` 只在 `describe()` 里被调用（`profileProvider.ts:344`）。
- `stats: () => stats`（`profileProvider.ts:341`）直接返回上一次 `finalize()` 的结果，
  初始值为 `emptyStats(config.providerId)`（`profileProvider.ts:192`），其 `neutralized` 默认是 `true`
  ——于是**尚未 finalize 时 `stats()` 谎报「已中性化」**。
- `describe()` 内部调用 `finalize()`，`finalize()` 又 `collected = []`（`profileProvider.ts:288`），
  所以 `describe()` 是一个**改变状态的"读取"函数**。
- 另有两个相关问题：
  (a) `collected` 把**语义不同的两类因子**（combo 权重因子与动作似然因子）混在同一个数组里
      —— 实测 `adjustments: 2652 = 1326 + 1326`，而 `stats` 的字段名（`meanFactor` / `direction`）读起来像「范围宽窄」；
  (b) `direction` 用**算术均值**判断（`playerProvider.ts:285`），批量版又用几何均值归一，
      两个入口的 `direction` 语义不可比。

**修复建议**：拆成 `comboStats()` / `likelihoodStats()`；把 `finalize()` 改为非破坏性
（累加进累计统计而不是清空）；或在 `stats()` 内部也调用 `finalize()`（至少消除「谎报 neutralized」）。

---

#### F10 —— `adjustActionLikelihood` 对**未知 `comboId`** 静默退化为「中等牌」，且与最弱牌因子完全相同

- **严重级别：MAJOR**
- **一句话结论**：`comboById(id)` 返回 `undefined` 时，代码把 `weakness` 当成 `0`（= 中等牌、无倾向），
  于是「查不到的牌」与「最弱的 72o」得到**逐位相同**的因子 —— 一个不存在的组合被当成了一手具体的弱牌。

**最小复现**（`tmp-rt-player/rt06-classifier.ts` 第 6 段）：

```ts
import { createProfileRangeProvider } from '../src/domain/range/profileProvider.ts';
import { RangeAction } from '../src/domain/range/range.types.ts';
// read = 300 手 40% 入池的画像
const provider = createProfileRangeProvider(read.adjustment);
const L = (comboId: string) => ({ comboId, action: RangeAction.BET, likelihood: 0.5,
  source: 'HEURISTIC' as const, confidence: 0.5 });
const unknown = provider.adjustActionLikelihood!(L('NOT_A_COMBO'), CONTEXT);
const weakest = provider.adjustActionLikelihood!(L('7c2d'), CONTEXT);
console.log({ unknown, weakest, same: unknown === weakest });
```

**实测输出**：

```
  未知 comboId → 因子 1.209107044689271（weakness 退化为 0，静默当作「中等牌」）
  最弱牌 7c2d → 因子 1.209107044689271；未知 comboId 与最弱牌因子是否相同：true
```

**期望输出**：未知 `comboId` 应返回 `1`（不调整）或抛错/记录问题；不应与某个真实组合的因子重合。
注意 `RangeErrorCode.RANGE_UNKNOWN_COMBO` 已在 `range.types.ts:366` 定义，但从未在此处使用。

**根因分析**：`profileProvider.ts:305-306`

```ts
const combo = comboById(likelihood.comboId);
const weakness = combo ? weaknessOf(comboPotential(combo)) : 0;
```

**修复建议**：

```ts
const combo = comboById(likelihood.comboId);
if (!combo) return 1;   // 未知组合：明确不调整，并记入 providerLog
```

---

### 3.C MINOR

---

#### F11 —— `sampleTier` 的 30 手门槛在调整因子上造成**硬开关悬崖**（29.999 手 → 30.001 手，因子跳变 12.75%）

- **严重级别：MINOR（可辩护为刻意的样本保护，但与项目「不因阈值突变」的自我要求同类）**
- **一句话结论**：`computeAdjustment` 在 `tier === PRELIMINARY` 时**完全归零**，
  而 `confidence` 本身是连续的（`n_eff/(n_eff+k)`）；跨过 30 手门槛时因子从 `1.000` 直接跳到 `1.127`。

**最小复现**（`tmp-rt-player/rt15-final.ts`「其余精确确认」段）：

```ts
import { sampleTier } from '../src/domain/player/playerStats.ts';
import { computeAdjustment } from '../src/domain/player/playerClassifier.ts';
const dim = (nEff: number) => ({
  tightness: 0.2, aggression: 0.9, bluffTendency: 0.9, passivity: 0.1,
  confidence: nEff / (nEff + 30), sampleSize: nEff, tier: sampleTier(nEff),
});
console.log(computeAdjustment(dim(29.999)).rangeWidthFactor);
console.log(computeAdjustment(dim(30.001)).rangeWidthFactor);
```

**实测输出**：

```
  n_eff=29.999 → rangeWidthFactor = 1
  n_eff=30.001 → rangeWidthFactor = 1.127499106537751
  跳变 = 0.1274991065377511
```

**期望输出**：`MAX_ADJUSTMENT * confidence` 本身就是连续且自限幅的
（`n_eff=30 → confidence=0.5 → 因子 ≈ 1.127`，`n_eff=3 → confidence≈0.09 → 因子 ≈ 1.02`），
因此硬归零是**冗余**的，可以去掉换取连续性；若要保留「样本不足不调整」的语义，
应改用连续权重（例如 `confidence` 乘一个平滑的门控函数）。

**根因分析**：`playerClassifier.ts:359-362`

```ts
const hasEnoughSample = options.hasEnoughSample ?? dimensions.tier !== SampleTier.PRELIMINARY;
if (!hasEnoughSample || dimensions.confidence <= 0) return neutralAdjustment(dimensions);
```

而 `dimensions.tier` 来自 `playerClassifier.ts:230` 的 `sampleTier(confidence > 0 ? sampleSize : 0, thresholds)`，
`sampleTier` 在 `playerStats.ts:341-343` 是硬阈值判断。

**修复建议**：见上（删掉硬开关，或改成连续门控），并补一条测试：
「同一维度下，`n_eff` 从 29 连续变到 31，`rangeWidthFactor` 的最大跳变 < 1e-3」。

---

#### F12 —— `sampleSize` 取 VPIP/PFR 的**最小值**，使 PFR 机会为 0 的玩家**永远无法**脱离 `PRELIMINARY`（含 `handsObserved=0` 的中立点矛盾）

- **严重级别：MINOR**
- **一句话结论**：`sampleSize = Math.min(VPIP.n_eff, PFR.n_eff)`；
  PFR 机会永远 ≤ VPIP 机会，但只要 PFR 的机会为 0，`sampleSize` 就是 0，层级永远是「样本不足」。
  同时 `tightness` 在无 VPIP 机会时回退到 `tightnessFromVpip(0.25)`，而**真正的空画像**回退到 `0.5`。

**最小复现**（`tmp-rt-player/rt07-extreme.ts` 第 3 段）：

```ts
import { PlayerMetric } from '../src/domain/player/player.types.ts';
import { createProfile, observeHand } from '../src/domain/player/playerProfile.ts';
import { readPlayer, computeDimensions } from '../src/domain/player/playerClassifier.ts';
// 只录 VPIP，从不录 PFR（PFR 机会 = 0）
for (const n of [30, 200, 201]) {
  let p = createProfile('b');
  for (let i = 0; i < n; i++) {
    const r = observeHand(p, { handId: `H${i}`, playerId: 'b', seq: i, timestamp: TS,
      observations: [{ metric: PlayerMetric.VPIP, success: true }] });
    if (r.ok) p = r.value;
  }
  const read = readPlayer(p);
  console.log(n, read.dimensions.tier, read.label, read.dimensions.sampleSize, read.adjustment.rangeWidthFactor);
}
console.log('空画像 tightness =', computeDimensions(createProfile('z')).tightness);
console.log('有 VPIP 无 PFR 时 tightness =', /* 见下 */);
```

**实测输出**：

```
  n=29   label=UNKNOWN  tier=PRELIMINARY  rangeF=1.000000
  n=30   label=UNKNOWN  tier=PRELIMINARY  rangeF=1.000000
  n=200  label=UNKNOWN  tier=PRELIMINARY  rangeF=1.000000
  n=201  label=UNKNOWN  tier=PRELIMINARY  rangeF=1.000000
  （200 手 100% 入池 —— 最极端的紧手 —— 也永远无法被分类）

  空画像 tightness = 0.5454545454545454
```

**期望输出**：至少 `n=200` 时应能用 VPIP 单独支撑出「超紧」结论；
且「没有数据」与「有 VPIP 数据但没有 PFR 数据」不应给出**同一个** `tightness`（都是 `0.5454`）。

**根因分析**：

- `playerClassifier.ts:229` —— `const sampleSize = Math.min(...coreStats.map((s) => s.effectiveSampleSize));`
- `playerClassifier.ts:180-181` —— `const vpipPrior = METRIC_DEFINITIONS[VPIP].prior;`
  `const tightness = vpip === null ? tightnessFromVpip(vpipPrior.center) : tightnessFromVpip(vpip);`
  `rateOf` 在 `opportunities === 0` 时返回 `null`（`playerClassifier.ts:150-154`），
  于是无 VPIP 机会时 `tightness = tightnessFromVpip(0.25) = 0.5454`。
  **而空画像（0 手）走的也是这条分支**，所以它也不是 `0.5` —— 即「无数据」与「有数据但恰好等于先验」不可区分（F6 的同一根因）。
- 注：`Math.max` 用于 `confidence`（`playerClassifier.ts:228`），`Math.min` 用于 `sampleSize` —— 两个聚合方向不一致。

**修复建议**：`sampleSize` 改用「核心指标中机会数 > 0 者的最小 n_eff」，
或直接改用 VPIP 的 n_eff（VPIP 是唯一被所有玩家必然观察到的前置指标）；
无证据时把 `tightness` 走**中立 0.5** 而不是「先验水平的紧度」。

---

#### F13 —— 25 项指标中有 **19 项**被采集、被展示、被计入 `sampleSummary`，但**从未参与任何维度计算**

- **严重级别：MINOR**
- **一句话结论**：`computeDimensions` 只读取 6 项指标；其余 19 项对任何调整因子零影响。

**最小复现**（`tmp-rt-player/rt13-opportunity.ts` 第 4 段 / `rt15-final.ts`）：

```ts
// computeDimensions 中 rateOf(...) 的全部调用点
// playerClassifier.ts:179  VPIP
// playerClassifier.ts:184  PFR
// playerClassifier.ts:197  THREE_BET
// playerClassifier.ts:198  RAISE_CBET
// playerClassifier.ts:216  CALL_CBET
// playerClassifier.ts:217  FOLD_TO_CBET
```

**实测输出**：

```
  25 项指标中被 computeDimensions 读取的：VPIP/PFR/THREE_BET/RAISE_CBET/CALL_CBET/FOLD_TO_CBET = 6 项
  采集但从未使用的指标（19 项）：
    LIMP, OPEN, CALL_OPEN, FOUR_BET, FOLD_TO_THREE_BET, CALL_THREE_BET, CBET,
    CHECK_RAISE_FLOP, TURN_BARREL, TURN_FOLD, TURN_RAISE, TURN_CHECK_RAISE,
    RIVER_BET, RIVER_BARREL, RIVER_OVERBET, RIVER_CALL, RIVER_RAISE, RIVER_FOLD, RIVER_SHOWDOWN
```

**期望输出**：要么这些指标参与维度计算，要么在 UI/文档中明确标注「仅展示，不参与调整」。
当前状态下用户会看到「河牌超池下注率 62%（高可信）」这样的卡片，
而画像的调整完全不反映它 —— 这是**可解释性上的误导**（`profileProvider.ts` 的文档承诺「UI 必须能说清为什么这个范围被调宽了 12%」）。

**根因分析**：`playerClassifier.ts:174-241` 的 `computeDimensions` 只覆盖 6 项。
特别值得注意：`bluffTendency` 只用 `THREE_BET` + `RAISE_CBET`，
因此一名「3Bet 机会为 0、但 300 手河牌超池下注 0 次」的玩家与一名从不下注的玩家得到**完全相同**的 `bluffWeightFactor`（实测两者都是 `1.000000`）。

**修复建议**：把 `_BARREL` / `RIVER_OVERBET` / `CHECK_RAISE_*` 纳入 `bluffTendency`；
或明确标注未使用。

---

#### F14 —— 用户可见中文文案硬编码在领域层，绕过 `src/i18n`，且与 i18n 中已存在的同义键**文案不同**

- **严重级别：MINOR（违反项目的硬约束 10）**
- **一句话结论**：`src/i18n/zh-CN.ts:415-505` 已经登记了完整的 `profile.*` 文案键（含 `profile.adjust.widened`
  等**与 provider 输出逐字相同**的键），但 `profileProvider.describe()` 自己拼字符串；
  `player.types.ts` 里 25 项指标的 `label` / `opportunityRule` / `successRule` / `prior.description`
  也全是硬编码中文。

**最小复现**（`tmp-rt-player/rt07-extreme.ts` 第 6 段）：

```
  src/domain/range/profileProvider.ts
    import i18n? false    含中文的非注释代码行 = 4
      | if (neutral) return '玩家样本不足，未对范围做任何调整';
      | return `依据玩家画像整体调宽范围（平均因子 ${stats.meanFactor.toFixed(2)}）`;
      | return `依据玩家画像整体调窄范围（平均因子 ${stats.meanFactor.toFixed(2)}）`;
      | return '玩家画像未改变范围的整体宽窄';
  src/domain/player/player.types.ts
    import i18n? false    含中文的非注释代码行 = 100
```

**实测输出（i18n 中已存在对应键）**：

```
  src/i18n/zh-CN.ts
  Line 449:   'profile.adjust.widened': '依据玩家画像整体调宽范围（平均因子 {meanFactor}）',
  Line 450:   'profile.adjust.narrowed': '依据玩家画像整体调窄范围（平均因子 {meanFactor}）',
  Line 451:   'profile.adjust.unchanged': '玩家画像未改变范围的整体宽窄',
  Line 452:   'profile.adjust.neutral': '玩家样本不足，未对范围做任何调整',
  Line 286: export function playerLabelText(label: string): string { ... }
  Line 334: export function profileAdjustmentText(params: { ... }): string { ... }
```

**期望输出**：`describe()` 应返回 `profileAdjustmentText({ ... })` 的结果，而不是自己拼字符串。

**根因分析**：`profileProvider.ts:343-354` 与 `player.types.ts:110-118` 直接内联中文字面量。
实测两者的**格式化行为不一致**：i18n 版本用 `meanFactor.toFixed(2)` 处理参数，provider 用模板字符串插值，
若上游传入的是已格式化的字符串/数字，两条渲染路径会给出不同文本。

**修复建议**：`describe()` 改为调用 `src/i18n` 的 `profileAdjustmentText`；
`METRIC_DEFINITIONS` 的 `label` 改为 i18n key（`profile.metric.<METRIC>` 已存在，共 25 条，一一对应）。

---

#### F15 —— `MetricStat.lastUpdatedSeq` 对全部 25 项指标都等于全局最大 `seq`，字段语义失效

- **严重级别：MINOR**
- **一句话结论**：`recompute` 把 `lastUpdatedSeq: maxSeq` 传给**每一个**指标，
  但类型注释（`player.types.ts:367-368`）说它是「统计涉及的**最近一手序号**」，
  即应当是该指标**自己最后一次观测**的序号。

**最小复现**（`tmp-rt-player/rt19-misc.ts`）：

```ts
import { PlayerMetric } from '../src/domain/player/player.types.ts';
import { createProfile, observeHand } from '../src/domain/player/playerProfile.ts';
let p = createProfile('x');
// H0 只有 VPIP；H1..H9 只有 PFR
for (let i = 0; i < 10; i++) {
  const r = observeHand(p, { handId: `H${i}`, playerId: 'x', seq: i, timestamp: TS,
    observations: [i === 0 ? { metric: PlayerMetric.VPIP, success: true }
                          : { metric: PlayerMetric.PFR, success: true }] });
  if (r.ok) p = r.value;
}
console.log('VPIP.lastUpdatedSeq =', p.metrics[PlayerMetric.VPIP].lastUpdatedSeq);  // 期望 0
console.log('PFR.lastUpdatedSeq  =', p.metrics[PlayerMetric.PFR].lastUpdatedSeq);   // 期望 9
console.log('CBET.lastUpdatedSeq =', p.metrics[PlayerMetric.CBET].lastUpdatedSeq);  // 期望 -1
```

**实测输出**：

```
  VPIP.lastUpdatedSeq = 9   （期望 0）
  PFR.lastUpdatedSeq  = 9   （期望 9）
  CBET.lastUpdatedSeq = 9   （期望 -1）
```

**期望输出**：见上注释。`player.types.ts:368` 的注释明确写「用于排序与增量窗口」，
但该字段当前对「从未有观测的指标」也返回 `maxSeq`（而非 `emptyMetricStat` 定义的 `-1`），
任何基于它的「增量窗口」逻辑都会把无数据指标误判为「刚更新过」。

**根因分析**：`playerProfile.ts:286-289` —— `computeMetricStat(metric, ..., { decay, lastUpdatedSeq: maxSeq })`
对循环内每个 `metric` 传同一个 `maxSeq`。`computeMetricStat` 在 `playerStats.ts:302` 原样透传。

**修复建议**：传该指标自己最后一条观测的 `seq`（`perMetric` 数组里存 `seq` 即可），
无观测时保持 `-1`。

---

#### F16 —— `hasUsableSample` 与 `readPlayer` 对「画像是否可用」给出**相反**的结论

- **严重级别：MINOR**
- **一句话结论**：`hasUsableSample` 取全部 25 项指标的 `max(confidence)`，
  `computeDimensions` 取 VPIP/PFR 两项的 `max(confidence)`；一个只有边角指标的画像会被前者判为「可用」，后者判为「样本不足」。

**最小复现**（`tmp-rt-player/rt18-samplesummary.ts`）：

```ts
// 只录 RIVER_BARREL 300 手，VPIP / PFR 完全零样本
console.log('hasUsableSample =', hasUsableSample(p, 0.5));
const read = readPlayer(p);
console.log(read.dimensions.tier, read.dimensions.confidence, read.label, read.adjustment.rangeWidthFactor);
```

**实测输出**：

```
  VPIP: opp=0 conf=0
  PFR : opp=0 conf=0
  RIVER_BARREL: opp=300 conf=0.9214876980082399
  hasUsableSample(profile, 0.5) = true
  实际 readPlayer: tier=PRELIMINARY confidence=0 label=UNKNOWN rangeWidthFactor=1
```

**期望输出**：两个判据应一致。建议 `hasUsableSample` 采用与 `computeDimensions` 相同口径
（VPIP/PFR，或至少「参与调整的 6 项」）。
补充：`hasUsableSample` / `allowsDirectionalClaim` / `sampleTier`(公开) 目前**没有任何生产代码调用**
（grep 全仓 `src/`，除定义处外 0 命中），既未生效也未被任何测试覆盖「多个指标混合」的情形。

**根因分析**：`playerProfile.ts:368-370` 用 `ALL_PLAYER_METRICS.some(...)` vs
`playerClassifier.ts:224-228` 用两个核心指标。

---

#### F17 —— `effectiveSampleSize` 对极端权重返回 `NaN` / `0`（`w*w` 溢出与下溢）

- **严重级别：MINOR（当前由 `decayWeight ≤ 1` 保证不可达）**
- **一句话结论**：`sumSquares += w * w` 没有对中间量做有限性检查：
  `w = 1e308` 时 `w*w = Infinity` → `(sum*sum)/Infinity = NaN`；
  `w = 1e-320`（次正规）时 `w*w` 下溢为 `0` → 返回 `0`。

**最小复现**（`tmp-rt-player/rt01-stats.ts` 第 3 段）：

```ts
import { effectiveSampleSize } from '../src/domain/player/playerStats.ts';
console.log(effectiveSampleSize([1e308, 1e308]));   // 期望 2
console.log(effectiveSampleSize([1e-320, 1e-320, 1e-320])); // 期望 3
```

**实测输出**：

```
  次正规权重 [1e-320 x3] → n_eff=0
  [1e-320, 1] → n_eff=1（真实必然 = 1 + 1e-320）
  [1e308, 1e308] → n_eff=NaN（sum 溢出 → 期望 NaN/Infinity）
```

**期望输出**：`2` 与 `3`。

另一个观察（非缺陷但值得记录）：等权重下 `n_eff` 会因浮点舍入**略微超过** `n`
（实测 `n=1000 → n_eff = 1000.0000000000342`，超出 `3.4e-11`）。
`test/playerProfile.test.ts:278` 的断言 `values[5] <= 601` 只在 `n=601` 上验证，恰好没触发该舍入。

**根因分析**：`playerStats.ts:178-188`。

**修复建议**：`if (!Number.isFinite(sumSquares) || sumSquares <= 0) return 0;`，
并在返回前 `Math.min(result, weights.filter(w => Number.isFinite(w) && w > 0).length)`。

---

#### F18 —— `isValidTimestamp` 接受 JS `Date.parse` 的日期回卷与缺时区字符串，且真实时间戳从不参与计算

- **严重级别：MINOR**
- **一句话结论**：`'2024-02-30T00:00:00Z'` 与 `'2024-06-31T00:00:00Z'`（不存在的日期）被 `Date.parse` 回卷后通过校验；
  无时区/仅日期的字符串也被接受；而该字段既然从不参与计算，这种「校验」实际上只提供了虚假的安全感。

**最小复现**（`tmp-rt-player/rt05-amend.ts` 第 5 段）：

```ts
import { isValidTimestamp } from '../src/domain/player/playerProfile.ts';
for (const ts of ['2024-02-30T00:00:00Z', '2024-06-31T00:00:00Z',
                  '2024-06-01T12:00:00+08:00', '2024-06-01', '2024-06-01T12:00:00']) {
  console.log(JSON.stringify(ts), isValidTimestamp(ts), Date.parse(ts));
}
```

**实测输出**：

```
  isValidTimestamp("2024-02-30T00:00:00Z") = true   Date.parse=1709251200000   ← 不存在的日期
  isValidTimestamp("2024-06-31T00:00:00Z") = true   Date.parse=1719792000000   ← 不存在的日期
  isValidTimestamp("2024-06-01T12:00:00+08:00") = true
  isValidTimestamp("2024-06-01") = true
  isValidTimestamp("2024-06-01T12:00:00") = true
  isValidTimestamp("  2024-06-01T12:00:00Z  ") = false
  isValidTimestamp(aaaa…(len=100020)) = false
  isValidTimestamp(2024-06-01T12:00:00Z + 50000 空格) = false
```

超长字符串与前后空格被正确拒绝（无 DoS 风险）；问题只在「不存在的日期被静默归一化」。

**根因分析**：`playerProfile.ts:165-173` 只做 `Date.parse` + 区间判断。
`Date.parse('2024-02-30T00:00:00Z')` 在 V8 中按 `2024-03-01` 解析（ECMA-262 Date Time String Format 的"out-of-bounds"回退）。

**修复建议**：用 `new Date(parsed).toISOString()` 与输入的规范化形式比较以拒绝回卷；
或强制要求严格的 ISO-8601 `YYYY-MM-DDTHH:mm:ss(.sss)?Z` 正则。
更重要的是：**要么让 `timestamp` 参与 `age` 计算（见 F2），要么在文档中明确它只是元数据**。

---

#### F19 —— 模块内**没有任何跨指标一致性校验**，物理上不可能的「机会」组合被无条件接受

- **严重级别：MINOR**
- **一句话结论**：`observations` 完全由调用方构造，引擎无法区分「真机会」与「被伪造的机会」；
  例如 `FOLD_TO_THREE_BET.opportunities = 5` 而 `OPEN.opportunities = 0`（机会规则要求「我做过开池加注」）被静默接受。

**最小复现**（`tmp-rt-player/rt13-opportunity.ts` 第 5 段）：

```ts
let p = createProfile('bad');
for (let i = 0; i < 5; i++) {
  const r = observeHand(p, { handId: `B${i}`, playerId: 'bad', seq: i, timestamp: TS,
    observations: [{ metric: PlayerMetric.FOLD_TO_THREE_BET, success: true }] });
  if (r.ok) p = r.value;
}
console.log('FOLD_TO_THREE_BET opp =', metricOf(p, PlayerMetric.FOLD_TO_THREE_BET).opportunities);
console.log('OPEN opp =', metricOf(p, PlayerMetric.OPEN).opportunities);
```

**实测输出**：

```
  构造：FOLD_TO_THREE_BET opp=5，OPEN opp=0
  「面对 3Bet 弃牌」的机会规则要求「我做过开池加注」——这里 0 次开池却有 5 次弃牌机会。
  模块 ok=true（无任何校验 / 无任何警告）
```

**期望输出**：至少报出 `PROFILE_INCONSISTENT` 类问题（`ProfileIssue.code` 里其实预留了从未使用的
`OUT_OF_ORDER_SEQ` 与 `UNKNOWN_PLAYER`，见 `playerProfile.ts:86`、`90`）。

**补充说明（重要限定）**：硬约束 3 说「机会由牌局状态定义，绝不由玩家动作定义」。
逐条审查 25 条 `opportunityRule` 后，本审计的结论是：**引擎侧无法强制这条约束**
（它由领域层如何产出 `observations` 决定），且大部分规则确实是状态定义的。
有 5 条规则的前提包含玩家自己的动作
（`CBET`「我在翻牌前是最后一位加注者」、`TURN_BARREL`「我在翻牌下过注」、
`RIVER_BARREL`「我在转牌下过注」、`CHECK_RAISE_FLOP`/`TURN_CHECK_RAISE`「我先过牌」、
`FOLD_TO_THREE_BET`/`CALL_THREE_BET`「我做过开池加注」），
但这 5 条中除 `RIVER_BARREL` 外都符合「条件频率」的统计直觉（「我下注后，下一街还下注的比例」）。
**唯一边界情形**是 `RIVER_BARREL`：其规则同时含状态条件（「河牌后轮到我行动且无人下注」）
与玩家动作条件（「我在转牌下过注」），实测一名「从不在转牌下注」的玩家
`RIVER_BARREL.opportunities === 0`、`adjustedRate` 永远是先验 `0.5`，
而其 `TURN_BARREL` 数据已经明确显示他不会连续开火（`adjustedRate = 0.0708`）。
这构成对硬约束 3 的**字面违反**，但由于 `RIVER_BARREL` 属于 §F13 的 19 项哑指标之一，
**当前不产生任何调整影响**。

**修复建议**：在模块内加一致性不变量校验（至少：
`FOLD_TO_THREE_BET.opp ≤ OPEN.opp`、`CALL_THREE_BET.opp ≤ OPEN.opp`、
`TURN_BARREL.opp ≤ CBET.opp + CBET_opportunity_variants.opp`），
把不可能的组合报为 issue；并复核 `RIVER_BARREL` 的机会定义。

---

#### F20 —— `amendHand` 用 `DUPLICATE_HAND` 错误码表示「该手牌不在画像中」

- **严重级别：MINOR**
- **一句话结论**：`amendHand` 在两个互斥场景（"已存在" vs "不存在"）里复用了同一个错误码，调用方无法区分。

**最小复现**：

```ts
import { amendHand, createProfile } from '../src/domain/player/playerProfile.ts';
const r = amendHand(createProfile('p'), 'NOT_EXIST',
  { seq: 0, timestamp: '2024-06-01T12:00:00.000Z', observations: [] });
console.log(r);
```

**实测输出**：

```
  ok = false
  code = DUPLICATE_HAND   ← 语义是「找不到」，却报 DUPLICATE_HAND
  i18n 中 DUPLICATE_HAND 对应文案：'这手牌已经在画像里了（handId {handId}），重复录入会被拒绝。'
  i18n 中另有 profile.amend.unknownHand：'这手牌不在画像中（handId {handId}），无法修正。'（永远用不到）
```

**期望输出**：`code === 'HAND_NOT_FOUND'`（或任何与「已存在」互斥的码）。
附带影响：`src/i18n/zh-CN.ts:500-501` 已分别登记
`profile.amend.duplicateHand`（"已经在画像里了"）与 `profile.amend.unknownHand`（"不在画像中，无法修正"）
两个不同文案，但领域层只发得出前者的 code（`src/i18n/index.ts:354-357` 把 `DUPLICATE_HAND`
映射到 `duplicateHand`），因此**用户修正不存在的手牌时会看到"这手牌已经在画像里了"** ——
一条与事实相反的提示。

**根因分析**：`playerProfile.ts:319-321`。

---

#### F21 —— 无效的内部死代码块

- **严重级别：MINOR**
- **一句话结论**：`playerProfile.ts:196-198` 是一个空 `if` 块 + 一条注释，不做任何事。

**最小复现**：

```ts
if (observation.seq <= profile.handsObserved - 1 && !profile.seenHandIds.has(observation.handId)) {
  // 允许乱序（外部数据可能不是顺序到达），但必须是非负整数
}
```

**实测输出**：N/A（静态可见）。
**期望输出**：要么删掉，要么实现「记录 `OUT_OF_ORDER_SEQ` 警告」（该 code 已在 `playerProfile.ts:86` 声明但从未被 push 过）。
**根因分析**：`playerProfile.ts:196-198`。
**修复建议**：删除，或补上 `issues.push({ code: 'OUT_OF_ORDER_SEQ', ... })`。

---

#### F22 —— 性能：每一手都全量重扫全部历史（与文件头「绝不每次分析都重扫全部历史」的声明相反）

- **严重级别：MINOR（当前规模可用，规模化会失效）**
- **一句话结论**：`observeHand` → `recompute` 每次重新排序整个 `log`、重建 25 个指标的完整观测数组并重算。

**最小复现**（`tmp-rt-player/rt07-extreme.ts` 第 5 段）：

```ts
const t0 = performance.now();
let p = createProfile('perf');
for (let i = 0; i < 10000; i++) {
  const r = observeHand(p, { handId: `H${i}`, playerId: 'perf', seq: i, timestamp: TS,
    observations: [{ metric: PlayerMetric.VPIP, success: i % 4 === 0 },
                   { metric: PlayerMetric.PFR, success: i % 5 === 0 },
                   { metric: PlayerMetric.RIVER_OVERBET, success: i % 100 === 0 }] });
  if (r.ok) p = r.value;
}
console.log(`耗时 ${(performance.now() - t0).toFixed(0)} ms`);
```

**实测输出**：

```
  incremental observeHand × 10000 耗时 = 54473 ms
  平均每手 = 5.447 ms  ← 每手都全量重算
```

规模曲线（`tmp-rt-player/rt19-misc.ts`）：

```
  1000  手 → 410 ms（每手 0.410 ms）
  3000  手 → 3356 ms（每手 1.119 ms）
  10000 手 → 54473 ms（每手 5.447 ms）
  → 每手成本随手数线性增长 = O(n²)
```

**期望输出**：单次 `observeHand` 应为 O(1)~O(log n) 量级的增量更新（文件头第 6-8 行明确承诺
「每手牌产生若干机会观测，追加到该玩家的观测序列。**绝不每次分析都重扫全部历史**」）。
54 秒 / 10000 手 是 O(n²)；100k 手需要约 90 分钟。`recompute` 是逐手重建的**唯一**实现，
`observeHand` 从未真正增量。

**根因分析**：`playerProfile.ts:251` 每次调用 `recompute(profile.playerId, log, ...)`，
而 `recompute` 在 `262-301` 全量重算。

**修复建议**：短期至少把「每手重算」换成「只更新受影响指标」；
若必须保留全量重算（为正确性），应在文档与文件头注释中如实说明，
并加一个「每手 O(1)」或「10000 手 < 2s」的性能测试作为门禁。

---

#### F23 —— `decayWeight` 校验 `halfLife` 但不校验 `maxSingleHandShare`，非法值延迟到远处才抛错

- **严重级别：MINOR**
- **一句话结论**：`decayWeight` 会拒绝 `halfLife <= 0`，但对同一个 `DecayOptions` 里的
  `maxSingleHandShare` 不做任何检查；后者只在 `computeMetricStat` → `capSingleHandWeight` 里被校验，
  此时已经离开调用点很远。

**最小复现**（`tmp-rt-player/rt04-critical-decay.ts` 复现 2）：

```ts
const p = createProfile('p2');
p.decay.maxSingleHandShare = 2;      // 非法值（合法范围 (0,1]）
try { observeHand(p, hand(0, true)); } catch (e) { console.log((e as Error).message); }
```

**实测输出**：

```
  [抛错] observeHand → capSingleHandWeight: maxShare 必须在 (0, 1]（收到 2）
  [未抛错] createProfile
```

**期望输出**：非法 `DecayOptions` 应在 `createProfile` 时就抛错（快速失败），
而不是等到某次 `observeHand` 才有观测可用时抛出。
（注：`createProfile` 不抛错是因为它调用 `computeMetricStat(metric, [], ...)`，
空观测在 `playerStats.ts:249-255` 提前返回，还没走到 `capSingleHandWeight`。）

**修复建议**：加一个 `assertValidDecayOptions(decay)` 并在 `createProfile` 头部调用。

---

### 3.D INFO / 已证伪

---

#### D1（INFO）—— `foldToAggressionFactor` 的文档语义与数值方向一致，但该因子**没有任何消费方**

`playerClassifier.ts:387` 用 `factor(-passive * 1.2)`，文档（`playerClassifier.ts:386`）说
「越被动 → 越不容易弃牌，我们的诈唬越没用」。实测被动玩家 `foldToAggressionFactor = 0.6866 < 1` ✔ 方向正确。

但 `profileProvider.ts` **从不读取** `rangeWidthFactor` / `bluffWeightFactor` / `valueWeightFactor` /
`callingThresholdFactor` / `foldToAggressionFactor` —— 它只读 `adjustment.dimensions` 与 `adjustment.confidence`，
自己用 `rawComboWeightFactor` / `adjustActionLikelihood` 重算。实测（`rt06` 第 6 段）：
一个 `foldToAggressionFactor = 0.6866` 的跟注站，其 `FOLD` 似然因子是 `0.881097` —— 虽然 < 1（方向对），
但与 `0.6866` 毫无数量关系。这五个字段是**纯展示字段**，建议在类型注释中写明，
否则将来有人把它们接进计算会因为「双重计数」而出错。

#### D2（INFO）—— 批量几何均值归一确实生效；但**逐 combo 路径没有归一**，而文档承诺的是全局行为

实测（`rt06` 第 5 段 / `rt17` 第 3 段）：

```
  批量：Π f^(1/n) = 0.9999999999999997（误差 3.3e-16）        [OK] 几何均值归一
  极端画像：几何均值 = 0.9999999999999984（误差 1.6e-15）
  逐 combo 路径因子范围 = [0.987482502161656, 1.4029545257979616]，mean = 1.156700  ← 没有归一
  逐 combo / 批量 的比值范围 = [1.1461487008444844, 1.1461487008444846]  ← 仅差一个常数
```

`profileProvider.ts:22-27` 的文档写「本文件的做法：先算出全部因子，再除以几何均值，使调整只改变分布形状」，
该承诺只对 `adjustComboWeightsBatch` 成立。`adjustComboWeight` 已被 `updateRange` 实际调用，
返回的是**未归一**的因子。这在数学上没问题（`updateRange` 在对数域重新归一化，常数因子被吸收，
实测端到端结果正确），但文档需要更新——否则后来者会误以为单 combo 因子已经是归一化的，
从而在别处再乘一次。

端到端实测（`rt17` 第 1 段，真实 `updateRange` 接入）：

```
  紧手（300 手 10% 入池）：弱/强概率比 1.000000 → 0.782676   ← 弱牌端变窄 ✔ 方向正确
  松手（300 手 70% 入池）：弱/强概率比 1.000000 → 1.408587   ← 弱牌端变宽 ✔ 方向正确
  provider log: weightCalls=1326 weightAdjustments=1326 factorsValid=true
```

**这是新接入路径的核心正向结论：画像 → Range 的方向语义正确。**

#### D3（INFO）—— `minFactor` / `maxFactor` 护栏在默认配置下**成立**（该攻击假设已证伪）

我原本怀疑「`clampFactor` 发生在 `neutralizeGeometric` 之前，归一后可能越界」。
用 `minFactor=0.9 / maxFactor=1.1` 的严格配置 + 极端维度实测：

```
  配置 minFactor=0.9 maxFactor=1.1
  实测 min=0.930107991926556 max=1.0085213318125532
  未越界
```

原因：`clampFactor` 的上限是 `exp(MAX_ADJUSTMENT) = exp(0.4) ≈ 1.4918`，
而几何均值归一的缩放因子 ∈ `[exp(-0.4), exp(0.4)]`，两者抵消后
`归一后最大值 ≤ exp(0.4) × exp(0.4) = exp(0.8) ≈ 2.226`；
只有当 `config.minFactor > 0.67` 或 `config.maxFactor < 1.49` 时才可能越界。
默认值 `[0.2, 5]` 安全。**不报告为缺陷**，仅记录该边界分析。

#### D4（INFO）—— `neutralizeGeometric` 对 0 / NaN / 负数返回 1，无 NaN 泄漏 ✔

```
  neutralizeGeometric([0, NaN, -1, 2]) → 全部有限且 > 0 ✔
  neutralizeGeometric([1e308, 1e308])  → logSum 有限，结果正常 ✔
```

#### D5（INFO）—— `adjustActionLikelihood` 对全部 6 个 `RangeAction` 都有定义 ✔

```
  动作 CHECK → 0.827057   BET → 1.209107   CALL → 0.968849
       RAISE → 1.329527   FOLD → 0.881097  ALL_IN → 1.372275
```

`Record<RangeAction, number>` 是穷举类型，漏掉任何动作会**编译期报错**（`tsc --noEmit` 会拒绝）。
另有 `?? 0` 的运行时兜底（`profileProvider.ts:318`）。

#### D6（INFO）—— `deriveLabel` 的 10 个标签全部可达；`UNKNOWN` 不可达是**正确的**

833,931 组维度网格穷举结果：

```
  穷举 833931 组维度，出现 10 / 11 种标签
    UNKNOWN            ★ 不可达（在 tier=CONFIRMED 且 hasEnoughSample=true 时，这是正确行为）
    TIGHT_PASSIVE      可达（39312 组）
    TIGHT_AGGRESSIVE   可达（10920 组）
    LOOSE_PASSIVE      可达（137592 组）
    LOOSE_AGGRESSIVE   可达（61516 组）
    CALLING_STATION    可达（118482 组）
    BLUFF_HEAVY        可达（114296 组）
    BLUFF_LIGHT        可达（124992 组）
    ULTRA_TIGHT        可达（100464 组）
    REG_AVERAGE        可达（87318 组）
    REG_STRONG         可达（39039 组）
```

`UNKNOWN` 只能由 `!hasEnoughSample || tier === PRELIMINARY` 触发（`playerClassifier.ts:306-308`），
在设计上就是「样本不足专用」——**不报告为缺陷**。

#### D7（INFO）—— 调整因子**完全由连续维度决定**，不随标签阈值跳变 ✔

穷举 7×6×5×5×4×5×4×5 = 84,000 组 `LabelThresholds` 组合，标签出现了 10 种变化，
而 `rangeWidthFactor` / `bluffWeightFactor` / `valueWeightFactor` / `callingThresholdFactor` /
`foldToAggressionFactor` 的偏离基准次数 = **0** ✔
硬约束 2「标签只是摘要」在代码层面**成立**。

#### D8（INFO）—— 调整因子在入池率阈值处**连续** ✔

在 `vpip = 0.14 / 0.22 / 0.32` 三个标签阈值两侧各取 `±1e-9`：

```
  vpip=0.14: 标签 ULTRA_TIGHT → TIGHT_AGGRESSIVE；调整因子最大跳变 = 1.2e-9
  vpip=0.22: 标签 TIGHT_AGGRESSIVE → REG_STRONG；最大跳变 = 1.3e-9
  vpip=0.32: 标签 REG_STRONG → LOOSE_AGGRESSIVE；最大跳变 = 1.5e-9
  全局最大因子跳变 = 1.527377557763998e-9
```

（量级为 `1e-9`，来自 `eps` 本身，不是真实跳变。）
唯一的真实跳变来源是 F11（`sampleTier` 硬开关），**不是标签阈值**。

#### D9（INFO）—— `tightnessFromVpip` / `vpipRateOf` 在 `[0,1]` 全域严格互逆 ✔

```
  vpip ∈ {0, 1e-12, 0.05, 0.14, 0.22, 0.32, 0.5, 0.55, 0.5500001, 0.7, 1} 全部互逆（误差 < 1e-12）
  tightness ∈ {0, 0.1, 0.5, 0.9, 1} 全部互逆
  tightnessFromVpip(NaN) = 1     vpipRateOf(NaN) = 0.55
  tightnessFromVpip(-1)  = 1     vpipRateOf(-1)  = 0.55
  tightnessFromVpip(∞)   = 1     vpipRateOf(∞)   = 0.55
```

注意 `vpip = 0.7 > VPIP_SCALE = 0.55` 时反解得到 `0.55`（`min(vpip, VPIP_SCALE)`），
这是**刻意**的饱和行为且有测试锁定（`test/playerClassifier.test.ts:253-263` 的
`Math.min(vpip, VPIP_SCALE)`），不算缺陷。
NaN/负数被钳到无害值，未产生 NaN 传播 ✔。

#### D10（INFO）—— 硬约束 4（不编造数据）完全成立 ✔

- `PriorSource` 只有 `HEURISTIC_PRIOR` / `TEST_PRIOR` / `UNKNOWN_PRIOR` / `EMPIRICAL_PRIOR`，
  无 `THEORY_PRIOR` / `GTO_PRIOR` ✔
- 25 项指标的 `prior.description` 全部为「常客…中心约 X%」式启发式表述，无「理论最优」声明 ✔
- `handPotential.ts` 明确声明 `potential` 是「0..1 的启发式排序标尺，只用于比较强弱，不用于任何概率计算」，
  且该文件不 import 任何 equity 模块 ✔
- `RangeSource.FALLBACK` / `TEST_ONLY` 独立存在，未静默降级 ✔

#### D11（INFO）—— 画像**绝无可能**影响牌力 / 底池 / 赔率 / 所需权益（代码级证据）✔

```
  profileProvider 的 import 目标：
    ./range.types.ts, ./combo.ts, ./handPotential.ts, ./player/playerClassifier.ts,
    ./gameEnvironment.ts
    含 "equity" ? false   含 "odds" ? false    含 "pot" ? false
    含 "handEval" ? false 含 "fastEval" ? false 含 "engine" ? false  含 "decision" ? false

  profileProvider 导出：DEFAULT_PROVIDER_CONFIG, RangeSource, adjustComboWeightsBatch,
    createProfileRangeProvider, emptyStats, neutralizeGeometric（+ 环境组合相关）
  playerClassifier 导出：DEFAULT_LABEL_THRESHOLDS, MAX_ADJUSTMENT, PlayerLabel, PlayerMetric,
    VPIP_SCALE, computeAdjustment, computeDimensions, deriveLabel, neutralAdjustment,
    readPlayer, tightnessFromVpip, vpipRateOf, scaleAdjustmentConfidence
```

- 两个模块的导出集合里**没有任何** `equity` / `odds` / `potOdds` / `requiredEquity` / `handRank` / `spr` 入口。
- `playerProfile.ts` 与 `playerClassifier.ts` 均不 import 任何 `poker/` 下的模块。
- `PlayerRead` / `ProfileAdjustment` / `PlayerDimensions` 的键集合：
  `playerId, label, dimensions, adjustment, sampleNote, priorSources` /
  `rangeWidthFactor, bluffWeightFactor, valueWeightFactor, callingThresholdFactor, foldToAggressionFactor, confidence, dimensions` /
  `tightness, aggression, bluffTendency, passivity, confidence, sampleSize, tier`
  —— 按 `Object.keys` + 原型链遍历均无动作语义字段（`action`/`fold`/`check`/`raise`/`decision`/`recommend`…）✔
- 唯一输出到 Range 引擎的量是 `adjustComboWeight`（乘性权重因子）与 `adjustActionLikelihood`（乘性似然因子），
  二者都是 `RangeAdjustmentProvider`（`range.types.ts:338-348`）定义的**概率调整**接口 ✔

**硬约束 1「画像绝不直接决策」在代码层面成立。**

#### D12（INFO，更新）—— provider **现已接入** `updateRange`；接入本身不产生静默错误，但暴露了两个问题

审计开始时 `RangeAdjustmentProvider` 确实只被定义、未被调用。审计期间
`rangeUpdate.ts` 新增了 `UpdateRangeOptions.adjustmentProvider`（第 213 行）并在第 407/447 行调用。
对该新路径的独立审计结论：

- **正向**：`resolveFactor`（`rangeUpdate.ts:359-374`）对非法因子（NaN/Inf/≤0）
  **绝不静默当成 0 或 1**，而是记入 `providerLog.invalidSamples` 并跳过调整 ✔
  这满足硬约束 8「禁止静默修复坏数据」。
- **正向**：`likelihood` 调整后重新做合法性检查（`rangeUpdate.ts:434-443`）并夹到 `≤ 1` ✔
- **正向**：方向语义正确（见 D2 的端到端实测：紧手弱端收窄 0.783，松手弱端放宽 1.409）✔
- **问题 1**：`stats()` 在该路径下返回过期/错误数据 —— 见 **F9**。
- **问题 2**：`baseLikelihood === 1` 时任何 `> 1` 的似然因子都被夹回 `1`，
  调整被完全吞掉（实测 `RAISE` 因子 `1.0874` 在 `likelihood=1` 时消失，在 `likelihood=0.5` 时生效为 `0.5437`）。
  这是 `updateRange.ts:443` 的 `if (likelihood > 1) likelihood = 1;` 与
  provider 因子可 > 1 的组合结果。若真实动作模型存在 `P(动作|手牌) = 1` 的条目，
  该条目上的所有似然调整都是无效的。建议 `rangeUpdate` 在夹取时计入
  `providerLog`（例如新增 `clampedLikelihoods` 计数），否则这属于「静默丢弃调整」。

#### D13（INFO）—— `ALL_COMBOS` 的元素无法被画像代码路径污染 ✔

```
  potentialOfComboId(combo) 只读 combo.canonicalId，写入模块私有的 potentialCache: Map<string, number>
  weaknessOf / comboPotential 都是纯函数，不写任何共享对象
  ALL_COMBOS 的元素在 combo.ts:116-120 的 freezeCombo 中已深冻结（含两张牌）
  实测：Object.isFrozen(ALL_COMBOS) = true，元素与其 card1/card2 均冻结
```

画像代码路径（`profileProvider` → `handPotential`）对 `ALL_COMBOS` **只读**，
`potentialCache` 是 `Map<string, number>`（值类型，无引用泄漏）。**攻击失败** ✔

---

## 4. 未能证伪的假设（试过但攻击失败）

| # | 假设 | 攻击方法与规模 | 结果 |
|---|---|---|---|
| 1 | `adjustedRate` 会越出 `[先验中心, 观测加权比率]` 凸组合区间 | 4000 例确定性随机搜索（含 0 权重、极端成功分布、n∈[1,400]）；另对 9 组手工边界（n=1,3,10,50,200,500,2000）逐位比对独立复算的 `(1−λ)·center + λ·weightedRate` | **未能证伪**。最大差值 `2.8e-17`（浮点噪声）。λ 被限制在 `[0,1]`（`cappedWeightSum/(cappedWeightSum+k)` 且 `k ≥ 0`），数学上必然成立 ✔ |
| 2 | 3 手 100% 入池被当成 100% 玩家 | 独立复算 `(3 + 30×0.25)/(3+30) = 0.340909...` | **未能证伪**。实测 `adjustedRate = 0.3409090909090909`，`confidence = 0.0909 < 0.1`，`sampleTier = PRELIMINARY` ✔ 收缩正确 |
| 3 | 300 手紧手 + 最后 1 手疯狂诈唬能推翻画像 | 299 手不入池 + 最后 1 手入池 | **未能证伪**。`successes=1, opportunities=300`，`n_eff ≈ 198`，`adjustedRate < 0.1` ✔ |
| 4 | 无机会被计成失败 | 100 手只录 `OPEN`，不产生 `FOLD_TO_THREE_BET` 观测 | **未能证伪**。`FOLD_TO_THREE_BET.opportunities = 0`，`rawRate = null`，`adjustedRate = 先验中心`，`confidence = 0` ✔ |
| 5 | 「从不诈唬」的玩家不进诈唬机会分母 | 50 手 `RIVER_BET` 全 `success=false` | **未能证伪**（引擎侧）。`opportunities = 50`、`successes = 0`、`rawRate = 0` ✔。**但**领域层的 `_BARREL` 机会规则确实会被玩家自己的动作取消 —— 见 F19 的限定说明 |
| 6 | 每项指标共享分母 | 200 手 VPIP + 0 手 RIVER_OVERBET | **未能证伪**。`VPIP.opp = 200`、`RIVER_OVERBET.opp = 0`；25 个 `MetricStat` 对象两两不同引用 ✔ |
| 7 | Kish `n_eff` 超过实际手数（正常路径） | n ∈ {1,2,3,7,20,100,1000,5000,20000} 等权；另测 `[1e-320, 1]`、`[1e308,1e308]`、全零、含 NaN/Inf/负数 | **部分证伪**：等权下最大超出 `3.4e-11`（浮点舍入，非缺陷）；`1e308` → NaN、`1e-320` → 0 见 F17；正常路径下 **未能证伪** |
| 8 | `n_eff` 为 NaN / Infinity / 负数 | 全零权重、空数组、含 NaN/±Inf/负数的数组 | **未能证伪**（正常权重域）。`effectiveSampleSize` 的 `!Number.isFinite(w) \|\| w < 0` continue 与 `sumSquares > 0` 门禁正确挡住了 ✔ |
| 9 | 置信度公式在 `k=0` / `n_eff=0` / 负先验强度下出错 | `confidenceFromSamples(0,30)`、`(30,0)`、`(30,-5)`、`(-1,30)`、`(NaN,30)` | **未能证伪**。分别返回 `0` / `1` / `0.857` / `0` / `0`，无 NaN ✔ |
| 10 | `capSingleHandWeight` 在**全正权**下违反占比上限 | 3000 例随机搜索（n∈[21,320]、零权比例 0~1、maxShare 0.005~0.5） | **未能证伪**（全正权时）。全正权时 `positiveCount === n`，触发条件与 `mean` 分母一致，契约恒成立。仅含 0 时违反 —— 见 F7 |
| 11 | 「按比例整体缩放」旧实现残留 | 复现旧算法 | **未能证伪**。`test/playerProfile.test.ts:405-418` 的回归测试正确锁定了旧做法无效；当前实现用线性插值 + 二分，正确 ✔ |
| 12 | 重复 `handId` 不幂等 | 同玩家 / 跨玩家（通过 `PLAYER_MISMATCH` 拦截）；`removeHand` 后重录 | **未能证伪**（正常路径）。同玩家重复 → `DUPLICATE_HAND` 拒绝且画像不变；跨玩家 → `PLAYER_MISMATCH` 拒绝 ✔。`removeHand` 后重录与原状态**逐位相等**（实测 `adjustedRate` 与「从未移除」一致）。**但** `seenHandIds` 可被外部掏空 —— 见 F8 |
| 13 | `amendHand` 后与「一开始就录对」逐位相等（3 手以上复杂场景） | 5 个场景：seq 变化（2→7）、观测数变化（1→3 项，含换指标）、重复指标、非法 seq、非法时间戳。逐字段指纹比对（25 个指标的 7 个字段 + `handsObserved` + `seenHandIds` + `log` 全序列） | **部分证伪**：场景 1、2 **逐位相等** ✔（含 seq 变化与观测数变化）；场景 3（重复指标）**不一致** —— 见 F3。场景 4 的非法 seq 被静默接受 —— 见 F3 |
| 14 | 未知枚举指标 / NaN / Infinity / 负数 / 非整数 seq / 乱序到达 / 非法时间戳 | 逐个注入 | **部分证伪**。未知指标 → 警告 + 不计数 ✔；NaN/Inf 权重 → `computeMetricStat` 抛错 ✔（测试已覆盖）；乱序 → 结果与顺序无关 ✔；非整数 seq（`observeHand`）→ `NEGATIVE_COUNT` 警告 ✔。**但** 非法 seq 未阻塞（F2/F3）、`amendHand` 不校验 seq（F3） |
| 15 | 时间戳校验可绕过（不存在日期 / 时区偏移 / 超长串） | 12 种输入 | **部分证伪**。超长串（10 万字符）与前后空格 → 正确拒绝（无 DoS）；**但** 不存在的日期被回卷后接受 —— 见 F18 |
| 16 | 超大输入（10000 手）超时或内存爆炸 | 10000 手 × 3 指标 | **未能证伪**（未崩溃）。耗时 54.5s（O(n²)，见 F22），内存正常。**未测** 100k 手 |
| 17 | 深冻结每一层都生效 | 逐层 `Object.isFrozen` + 严格模式赋值（8 个位置） | **部分证伪**。`profile` / `metrics` / `MetricStat` / `prior` / `log` / `log[i]` / `observations` / `observations[j]` 全部冻结且赋值抛 `TypeError` ✔。`decay`（F1）与 `seenHandIds`（F8）**可写** |
| 18 | `prior` 对象可污染全局 `METRIC_DEFINITIONS` | 严格模式写 `METRIC_DEFINITIONS[VPIP].prior.center = 0.9`；比较 JSON 前后 | **未能证伪**。抛 `TypeError`，全局先验表未变。`freezeProfile:149` 的 `Object.freeze({ ...stat.prior })` 正确生效 ✔ |
| 19 | 两个玩家的画像共享可变对象 | 比较 `metrics` / `MetricStat` / `prior` / `log` / `seenHandIds` 引用 | **部分证伪**。`metrics` / `MetricStat` / `prior` / `log` 全部独立 ✔；**但** `decay` 三方共享（`a.decay === b.decay === DEFAULT_DECAY`）—— 见 F1 |
| 20 | `ALL_COMBOS` 元素被画像路径污染 | 审查 `handPotential.ts` 全部写入点 + `Object.isFrozen` 实测 | **未能证伪**。只读 + 深冻结；`potentialCache` 是值类型 Map ✔ |
| 21 | `PlayerRead` / `ProfileAdjustment` / `PlayerDimensions` 含动作语义字段 | `Object.keys` + 原型链遍历 + 正则（`action\|recommend\|suggest\|decision`） | **未能证伪**。三者的键集合全部为概率/维度/元数据字段 ✔ |
| 22 | 调整因子可由标签驱动 | 84,000 组 `LabelThresholds` 穷举，检查 5 个因子是否偏离基准 | **未能证伪**。偏离次数 = 0；标签出现 10 种变化 ✔ |
| 23 | 标签跳变导致因子跳变 | 三个 VPIP 阈值两侧 `±1e-9` | **未能证伪**。最大跳变 `1.5e-9`（= eps）✔ |
| 24 | `deriveLabel` 存在不可达分支 | 833,931 组维度网格穷举 | **未能证伪**。10 个标签全部可达；`UNKNOWN` 在设计上不可达（正确）✔ |
| 25 | `vpipRateOf` / `tightnessFromVpip` 在边界（0/1/负数/>1/NaN）失互逆 | 11 个 vpip 值 + 5 个 tightness 值 + 4 个异常值 | **未能证伪**。全域误差 < 1e-12 ✔ |
| 26 | 阈值改动意外影响调整因子 | 见 #22 | **未能证伪** ✔ |
| 27 | provider 因子为 0 / 负数 / Infinity / NaN | 遍历 1326 组合 × 6 动作；极端维度（`tightness=0, aggression=1, bluff=1, passivity=0, confidence=1`） | **未能证伪**。全部有限且 `> 0`；`boundedFactor` 用 `exp(0.4 × confidence × v)`，`v ∈ [-1,1]`、`confidence ∈ [0,1]`，必然落在 `[exp(-0.4), exp(0.4)]` ✔。`clampFactor` 另对非有限值返回 `1` |
| 28 | 几何均值归一未真正生效 | `Π f^(1/n)` 独立计算（批量 1326 组合；另测极端画像） | **未能证伪**。误差 `3.3e-16` / `1.6e-15` ✔ |
| 29 | 未知 `comboId` 不安全（抛错/NaN） | 传入 `'NOT_A_COMBO'` | **未能证伪**（不抛错、不 NaN）。**但** 静默退化为「中等牌」—— 见 F10 |
| 30 | `adjustActionLikelihood` 漏定义某个动作 | 类型为 `Record<RangeAction, number>`（穷举）+ 运行时 `?? 0` | **未能证伪**。6 个动作全部返回有限正因子 ✔ |
| 31 | `minFactor` / `maxFactor` 未夹住 | 遍历 1326 组合 × 6 动作 | **未能证伪**。全部落在 `[0.2, 5]`；`min=1.1949`、`max=1.4030`（极端画像下仍远在护栏内）✔ |
| 32 | 画像影响牌力 / 底池 / 赔率 / 所需权益 | 模块导出集合审查 + import 图审查 + `Object.keys` 结构审查 | **未能证伪（即「绝无可能」成立）**。详见 D11 ✔ |
| 33 | 入池率恰好 0% / 100%、样本恰好 30 / 200 手 | 12 组边界组合 | **未能证伪**。全部有限、无 NaN、无越界；`label` 与 `tier` 一致 ✔（唯一异常是 200 手仍为 `PRELIMINARY` —— 见 F12） |
| 34 | 衰减后权重全部相同 / 全部为 0 | `[0,0,0,0]`、`[0.5,0.5,0.5]`、`computeMetricStat` 全零权重 | **未能证伪**。全零 → `n_eff=0`、`confidence=0`、`adjustedRate=先验`；全等 → `n_eff=n` ✔ |
| 35 | 25 项指标全部有观测且极端（全成功 / 全失败）出现 NaN / Infinity / 越界 / 标签异常 | 500 手 × 25 指标全 `success=true`；再 500 手全 `false` | **未能证伪**。两轮均 0 处越界、0 处 NaN；标签分别为 `BLUFF_HEAVY` / `BLUFF_LIGHT`（合理）✔ |
| 36 | 标签阈值单位不一致（作者已修）是否真的修好 | 读代码 + 实测 `tightnessFromVpip(0.2) → 0.636` 反解回 `0.2`；阈值改动实测生效 | **未能证伪**。`deriveLabel:311` 用 `vpipRateOf(dimensions.tightness)` 反解，单位统一 ✔ |

---

## 5. 测试质量评估

### 5.1 假绿（断言过弱 / 恒真 / 循环论证）

**T1 [MAJOR] `test/playerProfile.test.ts:157-176` —— 断言恒真，测试标题与内容不符**

```ts
test('收缩公式精确性：无单手上限干扰时，exactly (s + k·center)/(n + k)', () => {
  const denominator = stat.effectiveSampleSize + prior.strength;
  const expected = (stat.adjustedRate * denominator - prior.strength * prior.center) / 1;
  assert.ok(Number.isFinite(expected));                       // ← 只断言「有限」
  const weightedSuccesses = stat.adjustedRate * denominator - prior.strength * prior.center;
  assert.ok(weightedSuccesses > 0 && weightedSuccesses <= stat.effectiveSampleSize + 1e-9, ...);
});
```

- `expected` 被算出后**从未与任何东西比较**，只断言 `Number.isFinite`——恒真。
- 第二个断言里的 `weightedSuccesses` 是**从被测值 `stat.adjustedRate` 反解出来的**，
  因此断言的是 `adjustedRate·D − k·c ∈ (0, n_eff]`，这几乎对任何合理实现都成立。
- 测试名声称验证 `(s + k·center)/(n + k)`，但**正文完全没有出现这个公式，也没有 `assert.equal`**。
  而且它用的分母是 `effectiveSampleSize`，而实现（`playerStats.ts:274-291`）用的分母是
  `Σcapped` —— 两者不同，测试却因此「恰好」通过了。
- 结论：这是本次审计发现的**最强假绿**。真正验证该公式的是 `:141-155` 的 `expectedAdjusted` 版本
  （但那个版本又通过 `decayedStats` → `capSingleHandWeight` 与实现**共享同一个被测函数**，属于部分循环论证）。

**T2 [MAJOR] `test/playerProfile.test.ts:178-207` —— 期望值由实现的辅助函数算出（部分循环）**

`decayedStats()` 内部调用 `capSingleHandWeight()` 与 `decayWeight()` —— 两个都是被测对象。
若 `capSingleHandWeight` 有偏差（F7），该测试会与实现**一起错**，仍然全绿。
建议：至少对「cap 未触发」的场景改用纯数学式 `(s + k·c)/(n + k)` 独立断言。

**T3 [MINOR] `test/playerProfile.test.ts:157` 的注释与代码矛盾**

```ts
// 衰减半衰期 400 手，100 手内权重 0.84~1.0；单手占比 ~1% < 5%，未触发上限
assert.ok(stat.effectiveSampleSize > n * 0.9, ...)
```

「单手占比 ~1%」描述的是 `max(w)/Σw`（正确，约 1%），但 `capSingleHandWeight` 的触发判据是
`max(w) > maxShare · Σw`，即 `1 > 0.05 × total`，`total` 需 `> 20`。100 手时 `total ≈ 88 > 20`，
**上限其实已经触发了**（只是压缩量极小）。注释误述了触发条件。

**T4 [MINOR] `test/playerProfile.test.ts:114-139` 的「3 手」断言实际很弱**

`assert.ok(stat.adjustedRate < prior.center + (1 - prior.center) / 2)` —— 上界是 `0.625`，
而实测值是 `0.3409`。这个断言几乎不会失败，无法区分正确实现与「把 3 手当成 30 手」的坏实现
（后者 `adjustedRate = (3 + 7.5)/33 = 0.318`，也会通过）。

**T5 [INFO] `test/playerClassifier.test.ts:253-263` 用 `Math.min(vpip, VPIP_SCALE)` 当期望值**

测试名字是「严格互逆」，但期望值里含 `Math.min(vpip, VPIP_SCALE)` ——
即测试承认了 `vpip > 0.55` 时**不互逆**。名字比实际强。属可接受（饱和是刻意设计），但应改名。

### 5.2 固化了错误行为（把 Bug 当规格）

**T6 [CRITICAL 相关] `test/playerProfile.test.ts:779-797` —— 深冻结测试漏掉 `decay` 与 `seenHandIds` 两层**

该测试极其仔细地逐层检查了 8 个位置（`profile` / `metrics` / `metrics[metric]` / `prior` /
`log` / `log[0]` / `observations` / `observations[0]`），**偏偏漏掉了 F1 的 `decay`**。
由于它以「深冻结已完整」为名通过，读者会认为不可变性已经闭合。
建议补：

```ts
assert.equal(Object.isFrozen(profile.decay), true);
assert.notEqual(profile.decay, DEFAULT_DECAY);   // 且必须是克隆
```

**T7 [MAJOR] `test/playerProfile.test.ts:692-703` —— 「负数 / 非整数 seq 必须被报出」固化了「只警告不阻塞」**

```ts
const outcome = observeHand(profile, hand(-3, PlayerMetric.VPIP, true));
assert.equal(outcome.ok, true, 'seq 仅作警告，不阻塞录入');
```

这个断言把「非法 seq 被接受」写成了规格。它本身没错（糟糕输入可容忍），
但**没有任何测试覆盖「被接受的非法 seq 会造成什么后果」**——
这正是 F2（`seq=500000` 作废全部历史）能长期潜伏的原因。
建议补一条：`seq=500000` 录入后断言 `n_eff` **不得**崩塌到 1。

**T8 [MAJOR] `test/playerProfile.test.ts:571-599` —— `amendHand` 等价性测试只覆盖单项观测**

```ts
const outcome = amendHand(amended, 'H2', {
  seq: 2, timestamp: TS,
  observations: [{ metric: PlayerMetric.VPIP, success: true }],   // ← 只有 1 项，无法触发去重差异
});
```

该测试的 `observations` 只有一项，因此**永远无法触及「`amendHand` 不去重」**这一缺陷（F3）。
它验证了 seq 不变的情形（`:574` 传 `seq: 2` 与原值相同），
也没有覆盖「修正后 seq 变化」或「观测数变化」。
本审计的场景 1、2 证明这两种情形**是正确的**（逐位相等），
所以缺的是**场景 3（重复指标）**——恰好是唯一出错的那个。

**T9 [MAJOR] `test/playerClassifier.test.ts:749-762` —— `stats()` 只在 `describe()` **之后**被检查**

```ts
for (const id of ['7c2d', 'AsAd', 'AsKs']) provider.adjustComboWeight!(comboById(id)!, CONTEXT);
const description = provider.describe();      // ← 先 describe
const stats = provider.stats();               // ← 后 stats（此时已被 finalize 填充）
assert.ok(stats.adjustments > 0);
```

测试顺序恰好绕过了 F9（`stats()` 在 `describe()` 之前返回 `adjustments: 0, neutralized: true`）。
`stats()` 的文档标注是「**只读**快照」，用户/UI 的正常用法就是直接读它。

**T10 [MINOR] `test/playerClassifier.test.ts:892-898` —— 「先验表不被污染」的测试是自证的**

```ts
const before = JSON.stringify(METRIC_DEFINITIONS[PlayerMetric.VPIP].prior);
readPlayer(buildProfile({ hands: 300, vpipSuccesses: 300 }));
computeAdjustment(computeDimensions(buildProfile({ hands: 300, vpipSuccesses: 300 })));
const after = JSON.stringify(METRIC_DEFINITIONS[PlayerMetric.VPIP].prior);
assert.equal(before, after, '分类过程不得污染全局先验表');
```

`readPlayer` / `computeAdjustment` 从设计上就不写 `prior`，这个断言恒真。
它检查的是**分类器**，而真正会污染全局常量的路径是**画像构造**（`createProfile` /
`observeHand` / `amendHand` / `removeHand`）—— 恰好对应 F1（`decay`）与 F8（`seenHandIds`）。
**测试检查错了对象。**

**T11 [MINOR] `test/playerProfile.test.ts:980-990` —— `sampleSummary` 的测试用「机会数」语义**

```ts
const profile = profileWith(PlayerMetric.VPIP, 100, 30);
assert.ok(summary.sufficientMetrics.includes(PlayerMetric.VPIP));
```

该断言在 `opportunities` 与 `effectiveSampleSize` 两种实现对等下都成立（100 手时两者都 > 30），
因此锁不住 F4（文档说用有效样本量、实现用原始机会数）。

### 5.3 覆盖缺口（现有测试完全没碰的面）

| 缺口 | 对应发现 | 建议测试 |
|---|---|---|
| `profile.decay` 的冻结与共享 | **F1 (CRITICAL)** | `assert.notEqual(profile.decay, DEFAULT_DECAY)` + `assert.equal(Object.isFrozen(profile.decay), true)` + 「污染一个画像不影响另一个」 |
| `seq` 巨大 / 跨度巨大的行为 | **F2 (CRITICAL)** | 200 手 + 1 手 `seq=500000`，断言 `n_eff > 100` 且 `adjustedRate` 变化 < 0.01 |
| `amendHand` 的去重与 seq 校验 | **F3 (CRITICAL)** | 与 `observeHand` 的逐字段指纹比对（含重复指标、`seq` 变化、观测数变化） |
| `seenHandIds` 的运行时只读性 | **F8 (MAJOR)** | `assert.throws(() => (profile.seenHandIds as Set<string>).delete('H0'))` 或类型上不存在 `.delete` |
| `sampleSummary` 用有效样本量 | **F4 (MAJOR)** | 构造 `opportunities=300, n_eff=22` 的画像，断言不在 `sufficientMetrics` 中 |
| `passivity` 的中立点 | **F5/F6 (MAJOR)** | 「打法 = 先验中心」的合成玩家断言四个维度都 ≈ 0.5（容差 0.01） |
| `tightness` 的中立点 | **F6 (MAJOR)** | 同上；另断言 `tightnessFromVpip(prior.center) === 0.5` |
| 调整因子随手数的漂移 | **F6 (MAJOR)** | 同一真实打法在 100 / 400 / 2000 手下，`rangeWidthFactor` 变化 < 0.01 |
| `stats()` 在 `describe()` 之前 | **F9 (MAJOR)** | `provider.adjustComboWeight(...)` 后立即 `assert.equal(provider.stats().neutralized, false)` |
| 未知 `comboId` | **F10 (MAJOR)** | 断言未知 combo 的因子 === 1（而不是等于某个真实组合的因子） |
| `sampleTier` 30 手门槛的连续性 | **F11 (MINOR)** | `n_eff` 29→31 时因子最大跳变 < 1e-3 |
| `lastUpdatedSeq` 的逐指标语义 | **F15 (MINOR)** | 构造「H0 只有 VPIP、H1..H9 只有 PFR」，断言 `VPIP.lastUpdatedSeq === 0`、`CBET.lastUpdatedSeq === -1` |
| `hasUsableSample` 与 `readPlayer` 一致 | **F16 (MINOR)** | 只录边角指标的画像，断言两者判断一致 |
| 跨指标一致性 | **F19 (MINOR)** | `FOLD_TO_THREE_BET.opp > OPEN.opp` 应报 issue |
| 性能门禁 | **F22 (MINOR)** | 10000 手 < 2s（或 1000 手 < 100ms） |
| 非法 `DecayOptions` 快速失败 | **F23 (MINOR)** | `createProfile('p', { decay: { halfLife: 400, maxSingleHandShare: 2 } })` 应抛错 |
| `stats()` 与 `describe()` 的纯函数性 | **F9 (MAJOR)** | 连续两次 `describe()` 的 `stats().adjustments` 应一致（当前第二次会变成 0） |

### 5.4 测试断言与需求相反的情形

**未发现**「断言与需求直接相反」的测试。
最接近的是 T7（`:692-703`）：它把「非法 `seq` 不阻塞」写成了规格，
与硬约束 8「坏数据必须显式报错」有张力 —— 但规则本身可辩护（糟糕输入容忍 + 警告），
真正缺失的是对「容忍后的后果」的断言。

---

## 6. 结论

### 6.1 当前是否存在已知核心逻辑缺陷？

**是。存在 3 个 CRITICAL、7 个 MAJOR。**

**核心逻辑缺陷（会直接产出错误结论）：**

1. **F1（CRITICAL）** —— `profile.decay` 是未冻结的全局共享常量。这是**模块级状态污染**，
   一行赋值即可让整个进程内所有画像的时间衰减永久错误。这与作者已经修过的
   「`prior` 未冻结导致 `METRIC_DEFINITIONS` 被污染」是同一类缺陷，
   说明该修复**只处理了被点名的那个字段，没有做系统性排查**。现有测试的深冻结断言
   逐层检查了 8 个位置却漏掉 `decay`，属于典型的「测试跟着修复走、而不是跟着不变式走」。

2. **F2（CRITICAL）** —— 一手 `seq=500000` 的合法输入会静默作废 200 手历史
   （`adjustedRate` 从 `0.887` 塌到 `0.242`，`n_eff` 从 `198` 塌到 `1`，**零警告**）。
   根因是「最大 `seq` 当现在」这一设计 + 无上界的 `seq` + 从不使用真实 `timestamp`。
   违反硬约束 8「禁止静默修复坏数据」的镜像面：**静默放行坏数据**。

3. **F3（CRITICAL）** —— `amendHand` 不去重、不校验 `seq`，既破坏其自身声明的
   「修正后 == 一开始就录对」契约（实测 `adjustedRate 0.2794 vs 0.2968`），
   又能用 `NaN` 让引擎在深处抛出无法归因的异常。

**架构层面正确的部分（正面结论）：**

- 硬约束 1（画像绝不直接决策）：**成立**，代码级证据见 D11。
- 硬约束 2（标签只是摘要）：**成立**，84,000 组阈值穷举零漂移（D7）。
- 硬约束 4（绝不编造数据）：**成立**（D10）。
- 硬约束 9（凸组合不变量）：**成立**，4000 例随机搜索零越界（§4 #1）。
- 硬约束 5（样本不足低置信度）：**成立**（§4 #2）。
- 硬约束 6（每指标独立分母）：**成立**（§4 #6）。
- `adjustedRate` 的数学推导（作者在 `playerStats.ts:272-291` 记录的那次修复）**确实是正确的**。

**统计正确性的系统性问题：**

三个维度中有两个（`tightness`、`passivity`）把「先验中心」映射到了**非中立**的位置
（F5/F6），后果是「打法恰好等于项目自述常客中心」的玩家被给予方向性调整
（`rangeWidthFactor = 0.964`、`callingThresholdFactor = 0.977`、`foldToAggressionFactor = 1.028`），
而**没有任何数据**的陌生人反而是中立的。这属于「把先验伪装成观测」——
与作者已经修掉的 `bluffTendency` 零机会问题（`playerClassifier.ts:192-196` 的注释）
是**同一类错误的一个变体**，但只修了 `bluffTendency` 一处，`tightness` 与 `passivity` 都漏了。
`bluffTendency` 本身是正确做法的对照样本（实测偏差仅 `-0.0035`）。

### 6.2 修复优先级建议

| 顺序 | 发现 | 理由 |
|---|---|---|
| 1 | **F1** | 一行代码的修复，后果是全模块级；且与已修缺陷同类，风险最高 |
| 2 | **F3** | 直接违反显式契约，且有崩溃路径 |
| 3 | **F2** | 需要设计决策（用 `timestamp` 还是限制 `seq`），但当前是静默数据毁灭 |
| 4 | **F5 + F6** | 影响所有下游调整因子的量级，且修复方式明确（照 `bluffTendency` 的做法） |
| 5 | **F8 / F4 / F9 / F10** | 一致性/正确性问题，修复代价小 |
| 6 | F11–F23 | 质量与可维护性 |

### 6.3 对开发者自修 4 个 bug 的评价

作者自修的四项（深冻结层数不足、单手影响上限算法三次迭代、标签阈值单位不一致、
非线性映射不可逆）经本审计独立验证**都确实修好了**：

- 单手影响上限：全正权下占比约束**恒成立**（3000 例随机搜索零违规），仅含 0 时失效（F7）；
- 标签阈值单位：`vpipRateOf` 反解正确，阈值改动实测生效（D8）；
- 非线性映射不可逆：改为线性定标后全域互逆，误差 < 1e-12（D9）；
- 深冻结层数：8 个位置全部生效（§4 #17）。

但这四项修复有一个共同的模式：**每次只修被点名的那一处，没有把修复提升为不变式**。
F1（`decay` 没冻结）、F5/F6（只有 `bluffTendency` 做了先验定标）、
F3（`observeHand` 有去重、`amendHand` 没有）——都是同一个模式在新位置的复现。
**建议的元层修复**：把这三条不变式写成表驱动测试
（遍历 `PlayerProfile` 的**所有**属性做冻结断言；遍历 `computeDimensions` 用到的**所有**指标做
「先验中心 → 中立」断言；对**所有**接收 `observations` 的入口做同一份规范化断言）。
