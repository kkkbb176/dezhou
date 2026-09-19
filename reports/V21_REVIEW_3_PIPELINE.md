# V2.1 独立审计 · 审阅者 3 —— 生产管线 / 缓存 / 身份隔离

> 仓库：`D:\德州`（Windows / pwsh）。本轮**只读** `src`、`test`；新增文件仅本报告与
> `scripts/v21-rev3-*.ts` 探针。未执行任何 `git add/commit/stash/checkout/restore/clean`。
> 未运行 `npm run verify`；未触碰 `GTOopen/`、`data/gto-cache`、`gtoApi`（详见 §5.4 一句边界说明）。
>
> 全部结论都是**执行取证**（命令 + 原始输出）或**精确代码论证**（`file:line`）。
> 未经执行的推断一律标注「未执行」。

---

## 0. VERDICT 总表

| # | 审计项 | 结论 | 冲突 | 严重度 |
|---|---|---|---|---|
| 1 | 单一入口：画像改范围/决策的**全部**路径枚举；统一似然与倾斜 provider 是否会在同一条动作上同时生效 | **通过**（互斥由代码结构保证，已差分取证） | 否 | — （1 条设计观察，非缺陷） |
| 2 | 去重闸门 `context.profileRangeEvidence?.provider.applied === true` 是否 airtight | **不 airtight —— 存在 2 个可达漏洞** | **是** | **P0（A 洞）/ P1（B 洞）** |
| 3 | 身份隔离：画像绑定**玩家**还是**座位** | **通过**（绑 `playerId`；换人生成新 id 并清零；暂离保留） | 否 | — （1 条 API 专属的**座位键**通道，见 §3.4） |
| 4 | 画像是否跨对手泄漏 | **通过**（逐位相同；既有测试 + 本探针双证） | 否 | — |
| 5 | 模块级可变缓存审计 + 顺序无关性 | **通过**（唯一生产缓存 `WEIGHT_CACHE` 非画像键且已冻结；无画像键缓存） | 否 | 低（`rangeCounter` 只进诊断 id，不进决策） |
| 6 | 确定性 / 顺序 | **通过**（`nodeDeterminism` 6/6；6 画像 × 3 顺序逐字节一致） | 否 | — |
| 7 | 入口一致性（HTTP vs 直调）与 UI 表达力 | 一致性**通过**；另报 2 条表达力缺口 | 否（缺口） | P2 |

**一句话总结**：画像进入范围的**通道有 3 条**（倾斜 provider、河牌统一似然、跛入原型），
但去重闸门只看**第 1 条**的 `applied` 标志，而且这个标志取自**首要对手**的范围构建。
当画像通过第 2/3 条通道改变范围、或挂在与首要对手不同的座位上时，闸门读到 `false`，
scorer 层（抓诈唬偏移 + 范围压缩乘数）会**再计一次**。

---

## 1. 单一入口：画像 → 范围 / 决策的全部路径

### CLAIM
`quickProfile` / `behaviorProfile` 影响对手范围或决策的路径可完全枚举；其中
「统一似然」与「倾斜 provider」在**同一条动作**上不会同时生效。

### EVIDENCE

**1.1 路径枚举（代码）** —— 画像只在 `villainId` 这一家注入：

| 通道 | 位置 | 生产可达 | 条件 |
|---|---|---|---|
| C1 倾斜 provider（乘数：先验形状层 `adjustComboWeight` + 逐动作 `adjustActionLikelihood`） | `contextBuilder.ts:3207,3210` → `buildRangeSnapshot` `:1399,1445` → `rangeUpdate.ts:407,447`；provider 构造 `contextBuilder.ts:2560-2573`；`tendencyProvider.ts:277-281`（`applied`）, `:358-380`, `:382-423` | 是 | 有证据（tier≠PRIOR 或近期倾向）；`solverOverride` 存在时整条通道关闭（`:1437-1447`） |
| C2 河牌统一似然（`estimateUnifiedActionLikelihood`） | `contextBuilder.ts:1202-1307`；`behaviorProfile` 派生 `:3168-3175` | 是 | `street===RIVER && isAggressive` 且节点可分类、Hero 底牌 2 张 |
| C3 跛入原型通道（`limpArrivalRangeOf`） | `contextBuilder.ts:3181-3187,3208` → `buildBaseRange` `:923-938`；`limpIsolation.ts:113-124,150-175` | 是 | 首要/该对手翻前**首个动作是 CALL 且无人加注**，且原型≠POPULATION |
| D1 抓诈唬/薄价值/诈唬/尺寸偏移（exploit） | `postflopAdvisor.ts:371,383-411,447-476` | 是 | `exploitSource.confidenceScale>0` |
| D2 范围压缩乘数（scorer 层） | `postflopAdvisor.ts:384,403-427`；`rangeCompression.ts:164-183` | 是 | 同上（**闸门只在这里**） |
| D3 响应层倾向（每家自己的维度） | `contextBuilder.ts:3487-3519`（`seatProfiles[位置]` > `villain` 倾向 > 中立）→ `betResponse.ts` | 是 | 有画像或逐座位画像 |
| D4 翻前隔离加注事实包（到达宽度 + 弃/跟/加响应） | `contextBuilder.ts:3555-3592`；`limpIsolation.ts:150`（到达）与 `:224-236`（响应） | 是 | 翻前、面对跛入、无人加注 |
| D5 环境优先级（`hasProfile`） | `contextBuilder.ts:3382-3387` | 是 | 仅影响说明/置信度口径 |

**1.2 「同一条动作」互斥性 —— 差分取证**

```text
命令：node --experimental-strip-types scripts/v21-rev3-probe3.ts item1
河牌动作=BET  权益=18.8139% evidence.applied=true
  profileMultiplier.calls=1980  finalMultiplier.calls=1980  comboWeight.calls=990  actions=[BET]
  trace=[{"street":"FLOP","action":"BET","note":""},{"street":"TURN","action":"BET","note":""},
         {"street":"RIVER","action":"BET","note":"统一动作似然 V2（中性校准层 × 几何平均画像调整；同一条动作上抑制 adjustment…"}]
河牌动作=CHECK  权益=41.7305% evidence.applied=true
  profileMultiplier.calls=2970  finalMultiplier.calls=2970  comboWeight.calls=990  actions=[BET,CHECK]
  trace=[{"street":"FLOP","action":"BET","note":""},{"street":"TURN","action":"BET","note":""},
         {"street":"RIVER","action":"CHECK","note":""}]
```

两局面**逐字相同**，只把对手河牌动作从 `BET` 换成 `CHECK`。
- `BET` 局面：provider 只被调用 **1980** 次（翻牌 + 转牌两次更新），河牌那一次**没有被 provider 处理**，
  且河牌 trace 的备注正是统一似然的备注。
- `CHECK` 局面：`2970`，`actions=[BET,CHECK]`，统一似然备注**一处都没有**。
- 两局面唯一差别是河牌动作，因此差值 **990** 就是「河牌那一次更新被 provider 处理」的组合数
  （每次 `updateRange` 的似然条目数 = 该次范围的支持集大小；1980/2 与 2970/3 都等于 990，与
  §4 实测的 `supportSize=990` 一致）。

**代码论证**：`contextBuilder.ts:1308` `const suppressProvider = likelihoodOverride !== null;`
与 `:1352` `...(provider !== undefined && !suppressProvider ? { adjustmentProvider: provider } : {})`
—— provider 对象在统一似然生效时**根本没有传进 `updateRange`**，故二者在同一条动作上互斥。

### CONFLICT
**否。** 不存在同时生效的第二条路径。

### RESOLUTION
无需修复。**设计观察（非缺陷，建议登记）**：同**一手牌**的不同动作上两条通道会先后生效 ——
C1 的先验形状层在第一次更新时施加（`tendencyProvider.ts:358-380`），C2 在河牌动作上施加。
两者消费的是同一份 `adjustment.dimensions` / 行为 traits，只是回答不同问题
（「他怎么到达这里」vs「他河牌用什么下注」）。当前「去重」规则只按**动作**定义，故合规；
但若将来把 C1 从「只第一次」改为逐条动作，就会与本条互斥性冲突。

---

## 2. 去重闸门是否 airtight（**核心发现**）

### CLAIM
`postflopAdvisor.ts:383` / `:468` 以 `context.profileRangeEvidence?.provider.applied === true`
判断「画像已进范围」。**该判据不等于「画像改变了范围」**。

### EVIDENCE

闸门读数是三段信息的合成，每段都可能为假：

1. `profileRangeEvidence` 为 `undefined` 时（`contextBuilder.ts:3620` 用条件展开，
   `null` 时**整个字段不存在**），`?.` 使表达式为 `undefined`，`=== true` ⇒ `false`。
2. `profileRangeEvidence` 由 **`primaryBuild.tendency`** 派生（`:3220-3233,3305-3307`），
   而 `tendency` **只注入给 `villainId` 那一家**（`:3207,3210`）。
   ⇒ `primaryOpponent.id !== villainId` 时证据必然缺失（`primaryOpponent = realizedOpponents[0]`，`:3219`）。
3. `provider.applied`（`tendencyProvider.ts:277-281`）只反映**乘数通道**是否生效；
   而 `contextBuilder.ts:3327-3338` 在 `!applied && profileChangesLimpRange` 时**刻意继续**算前后权益，
   返回 `{...core}` —— `applied` **仍是 false**。

#### 漏洞 A（P0）：画像挂在**非首要对手**的座位上

`villainId = input.villainPlayerId ?? realizedOpponents[0]?.id`（`:3141-3142`），
`primaryOpponent = realizedOpponents[0]`（`:3219`）。二者可以不相等。

```text
命令：node --experimental-strip-types scripts/v21-rev3-probe.ts item2
[A] villain=seat_CO profile=MANIAC          ← 画像在 CO，首要对手是 UTG
    profileRangeEvidence = null（实为字段缺失）｜equityBefore=null equityAfter=null delta=null
    heroEquity=2.1242% callEV=-22.1307 action=FOLD
    exploit.bluffCatchDelta=0.0350 deDuplicated=false
    gate.profileEvidence={"rangeLayerApplied":false,"scorerLayerApplied":true,"doubleCountBlocked":false,
      "noteZh":"画像未在 range 层生效 ⇒ scorer 层压缩乘数按可信度 0.35 生效"}
    compression.aggressionCredibility=0.3729 strengthFloor=0.9545
[A] villain=seat_CO profile=UNKNOWN
    heroEquity=1.7350% callEV=-22.4732
[A-基线] 完全无画像 villain={}   heroEquity=1.7350%
[A] villain=seat_UTG profile=MANIAC         ← 同一画像挂到首要对手（对照组）
    profileRangeEvidence = present provider.applied=true｜equityBefore=1.7700% equityAfter=1.7742% delta=0.0042
    exploit.bluffCatchDelta=0.0000 deDuplicated=true
    gate.profileEvidence={... "doubleCountBlocked":true ...}
    compression.aggressionCredibility=0.4134
```

**数字**（同牌局、同行动、同画像 `MANIAC`，只改 `villainPlayerId`）：

| 量 | villain=seat_CO（漏洞） | villain=seat_UTG（去重生效） | 差 |
|---|---|---|---|
| `profileRangeEvidence` | 字段缺失 | present, `applied=true` | — |
| `rangeLayerApplied` / `doubleCountBlocked` | false / **false** | true / **true** | — |
| `exploit.bluffCatchDelta` | **+0.0350** | 0.0000 | +0.0350 |
| `scorerLayerApplied` | true | false | — |
| 范围层证据（画像 vs 无画像） | 1.7350% → **2.1242%**（+0.3892 pp） | — | — |
| `callEV` | −22.1307（UNKNOWN 时 −22.4732） | — | +0.3425 筹码 |

即：画像**确实**改了范围（+0.3892 pp 权益、+0.3425 筹码 Call EV），
而抓诈唬偏移**又**按满额 0.035 加了一次，压缩乘数也仍按可信度 0.35 参与
（`aggressionCredibility` 0.3729 vs 去重时的 0.4134）。
该偏移直接进跟注分：`postflopAdvisor.ts:664-678`
`callScore = clamp(0.5 + edge×1.2 + (诈唬抓) + scaledExploit.bluffCatchDelta + …)`
——`+0.035` 是 0…1 归一化刻度上的 3.5%，与 `EXPLOIT_MAX_DELTA=0.12` 同量级。

**可达性**：`/api/analyze` 的 `input.villain.playerId` 是**自由字符串、不做校验**。

```text
命令：node --experimental-strip-types scripts/v21-rev3-probe2.ts item7-hole
HTTP input.villain.playerId=seat_UTG ⇒ ok=true ... action=FOLD
HTTP input.villain.playerId=seat_CO  ⇒ ok=true ... action=FOLD
```
两个 id 都被接受。牌桌 UI 路径**不可达**：`tableAdapter.ts:227-240` 恒把
`villain.playerId` 设成 `primaryOpponentPosition`，而该函数与 `opponents[0]` 同判据（`:74-92`）。

**RESOLUTION（A）**：把闸门改为**范围层事实**而不是 provider 自述，例如
`rangeLayerApplied = profileRangeEvidence !== undefined && (profileRangeEvidence.provider.applied === true || profileRangeEvidence.equityDeltaPct !== 0)`；
或（更稳）让 `profileRangeEvidence` 由 **villain** 的构建产物派生，并在 `villainPlayerId` 与
`realizedOpponents[0]` 不等时**阻断/告警**（`contextBuilder.ts:3141-3142` 与 `:3219-3233` 之间加一致性断言）。

#### 漏洞 B（P1）：跛入原型通道（`provider.applied === false` 但范围已变）

```text
命令：node --experimental-strip-types scripts/v21-rev3-probe.ts item2   （B 组：跛入池 + Hero 翻牌先行动）
[B] profile=CALLING_STATION
    profileRangeEvidence=applied=false｜equityBefore=74.3675% equityAfter=74.3275% delta=-0.0400｜heroEquity=74.3275%
    action=BET exploit.bluffCatchDelta=-0.0070 deDuplicated=false
    gate.profileEvidence={"rangeLayerApplied":false,"scorerLayerApplied":true,"doubleCountBlocked":false, ...}
    compression.aggressionCredibility=0.3103 strengthFloor=0.3949
[B] profile=MANIAC
    applied=false｜74.3675% → 73.4875% delta=-0.8800｜heroEquity=73.4875%
    action=BET exploit.bluffCatchDelta=0.0350 deDuplicated=false
[B] profile=NORMAL
    applied=false｜74.3675% → 73.7750% delta=-0.5925
[B] profile=UNKNOWN
    profileRangeEvidence=null｜heroEquity=73.5775%｜scorerLayerApplied=false
[B-隔离] profileCompressionMultiplier('MANIAC', 0.35)=0.9020 vs ('MANIAC', 0)=1.0000
[B-隔离] profileCompressionMultiplier('CALLING_STATION', 0.35)=0.8950 vs ('CALLING_STATION', 0)=1.0000
```

**牌桌 UI 路径可达**（非构造）——同一节点用真实牌桌操作复现，逐字同数：

```text
命令：node --experimental-strip-types scripts/v21-rev3-probe2.ts item2-ui
牌桌路径 profile=CALLING_STATION
  座位序当前行动者=BB isHeroTurn=true villain.playerId=seat_UTG quickProfile=CALLING_STATION
  profileRangeEvidence=present provider.applied=false equityBefore=74.3675% equityAfter=74.3275% delta=-0.0400
  heroEquity=74.3275% action=BET
牌桌路径 profile=MANIAC   → applied=false  74.3675% → 73.4875%  delta=-0.8800  action=BET
牌桌路径 profile=NORMAL   → applied=false  74.3675% → 73.7750%  delta=-0.5925
牌桌路径 profile=UNKNOWN / 从未设置 → 证据缺失，scorerLayerApplied=false
```
（节点：6-max，Hero=BB，UTG 带画像跛入，其余弃牌，BB 过牌 → 翻牌由 **Hero 先行动**，
因此对手在本手**没有任何翻后记录** ⇒ `applyLikelihoodUpdates` 对 villain 零次更新
⇒ provider 的 `applied` 恒为 false，`comboWeight`/`profile`/`observation` 三个摘要全空。
范围则已被 `contextBuilder.ts:923-938` 的跛入到达范围改变。）

**NORMAL 的 −0.5925 pp 直接证伪了源码文档的不变量**：
`contextBuilder.ts:769` 写着「`applied === false` 表示范围**逐位不变**」。

### CONFLICT
**是（2 处）。**
- A：`src/app/manualInput/contextBuilder.ts:3305-3307` + `:3219-3233` + `:3620` 与
  `src/app/decision/postflopAdvisor.ts:383,468` 的语义不一致（证据取自首要对手，闸门却用来判断 villain 已进范围）。
- B：`src/app/manualInput/contextBuilder.ts:3314-3318,3327-3338` 产生的对象
  `provider.applied === false` 但 `equityDeltaPct !== 0`（实测 −0.0400 / −0.8800 / −0.5925 pp），
  闸门 `postflopAdvisor.ts:383,468` 据此放行 scorer 层第二次加权。

### RESOLUTION
1. `postflopAdvisor.ts:383/468`：闸门改用「范围是否真被画像改变」（见 A 的修法），
   或在 `profileRangeEvidence` 上新增 `rangeChanged: boolean`（由 `equityDeltaPct !== 0 || combosBefore !== combosAfter`
   或 provider/limp 双通道标志共同决定）。
2. `contextBuilder.ts:3314-3338`：`profileChangesLimpRange` 为真时应把
   **「跛入通道已生效」显式写进证据对象**（例如 `limpChannelApplied: true`），否则该对象自相矛盾。
3. `contextBuilder.ts:3141-3142`：`villainPlayerId` 与 `realizedOpponents[0]` 不一致时，
   要么把两者对齐，要么让证据对象覆盖 villain 的那一份（当前只覆盖 primary）。
4. 守卫测试建议（本审计未改测试）：在 `multiLimpIsolation`/`profileRangeAdjustment` 中加一条
   「跛入池 + Hero 翻牌先行动 ⇒ `doubleCountBlocked === true`」的断言；现有测试
   （`profileRangeAdjustment.test.ts` T4、`betDecisionEngine.test.ts` T7）都只覆盖**加注池/河牌**节点，
   因此这两条真实缺陷在 65/65 全绿的测试下**完全不可见**。

---

## 3. 身份隔离：画像绑玩家还是绑座位

### CLAIM
画像绑 `playerId`（人），不绑座位；换人生成新 `playerId` 并清零画像；暂离/弃牌/下一手保留画像。

### EVIDENCE（代码 + 执行）
- 唯一存储：`state.playersById[playerId].quickProfile`（`tableState.ts:142`、`table.types.ts:176`）；
  写入只经 `seatLifecycle.ts:688-698`（`setProfile` 按 `playerId` 改写对象）。
- `freshPlayer`（`:225-232`）与 `replacePlayer`（`:516-565`）都产出 `quickProfile:'UNKNOWN'`/`handsPlayed:0`；
  旧玩家对象**保留在 `playersById` 但无任何座位引用**（`:541-557`）。
- 分析侧按座位→`playerId`→画像解析：`tableAdapter.ts:227-240`（并把它作为 `villain.playerId` 传入，
  由 `alphaPipeline.ts:1040-1042` 转成引擎口径 `villainPlayerId`）。

```text
命令：node --test --experimental-strip-types test/interactiveTable.test.ts
✔ 不变量 B：清空座位必须真正解除 seat → playerId 绑定
✔ §10 CRITICAL：座位 4 换人后，新玩家绝不继承旧玩家的画像与动态
✔ §69 CRITICAL：A 在 UTG 是跟注站、离开后 B 坐进来 —— 分析不得再读到 A 的画像
✔ §72 暂离回归：当前手不变、画像保留、重新入座后状态正确
✔ 不变量 A：弃牌只影响当前手 —— 下一手玩家仍在原座位
✔ §48 新牌桌必须清干净：其他座位、Villain 画像、动态、历史
✔ §68 视觉旋转差分：旋转前后送进管线的数据逐位一致
ℹ tests 22  pass 22  fail 0
```

**锁定关系**：
- 换人后**不得读到旧画像** → `§10` + `§69`（后者用 `inputHash` 与「全新牌桌」逐字节比对，是最强的一条）。
- 暂离/回座**保留**画像 → `§72`；弃牌**不影响**跨手绑定 → `不变量 A`。
- 多路手里画像不串座位 → §4（本审阅者探针）与 `multiwayBetResponse.test.ts` T5/T7。
- **「换座」操作不存在**：`TableOp` 联合（`table.types.ts:326-369`）里没有移动/交换座位的 op，
  因此「换座后画像跟着人走」是**不可表达**的；可观察的等价物（弃牌→下一手、暂离→回座、
  同座位换人）分别由 `不变量 A`、`§72`、`§10/§69` 锁定。

### CONFLICT
**否。**

### RESOLUTION
无需修复。**唯一例外（P2，API 专属）**：`ManualHandInput.seatProfiles` 是**按位置**键的画像表
（`manualInput.ts:310`、`contextBuilder.ts:3493-3511`），它把画像喂给**响应层**（每家 `dimensions`）。
同一个 `seatProfiles` 跨手复用、而座位上换了人时，画像会落到新玩家头上。
牌桌 UI 不产出该字段（`tableAdapter` 无 `seatProfiles`），只有手写 `/api/analyze` 请求可达。
建议：要么在 UI 也接上（并按 `playerId` 键），要么在文档里明确它是「按座位」的口径。

---

## 4. 画像是否跨对手泄漏

### CLAIM
画像只影响 `villainId` 那一家的范围；其他对手的范围不受影响。

### EVIDENCE

```text
命令：node --experimental-strip-types scripts/v21-rev3-probe.ts item4
   （3 家跛入池，画像挂 seat_CO；比较每家 range 的 {support, entropy, strongShare, meanTier}）
profile=MANIAC           seat_UTG: baseline={"support":990,"entropy":8.106262124324953,...}
                                  vs profile={"support":990,"entropy":8.106262124324953,...} ⇒ 逐位相同
profile=MANIAC           seat_CO:  7.361887228282482 → 7.559517391344333          ⇒ **不同**
profile=CALLING_STATION  seat_UTG: 8.106262124324953 → 8.106262124324953          ⇒ 逐位相同
profile=CALLING_STATION  seat_CO:  7.361887228282482 → 7.377013105911296          ⇒ **不同**
profile=UNDERBLUFFER     seat_UTG: 8.106262124324953 → 8.106262124324953          ⇒ 逐位相同
profile=UNDERBLUFFER     seat_CO:  7.361887228282482 → 7.1360588789229675         ⇒ **不同**
villain=seat_UTG profile=MANIAC   seat_UTG: **不同** 8.084917188344605 → 8.09003543740413
villain=seat_UTG profile=MANIAC   seat_CO:  逐位相同 7.378558586062925 → 7.378558586062925
```
`support` 恒为 990（只改概率、不增删组合），`entropy` 逐位可辨。反向挂载同样通过。

**既有测试**：`test/multiwayBetResponse.test.ts` 有 8 条多人/逐座位画像用例（T1–T8），全部通过：
```text
命令：node --test --experimental-strip-types test/betDecisionEngine.test.ts test/profileRangeAdjustment.test.ts \
      test/multiwayBetResponse.test.ts test/multiLimpIsolation.test.ts test/rangeProfileIntegration.test.ts
✔ T5：只改 primary opponent（两家画像都由逐座位给出）⇒ 多人 EV 不得变化
✔ T7：紧手 vs 跟注站 —— 两人的响应必须来自各自的画像
✔ T4：EqBothCall 必须 ≤ 两个单挑权益（真三人权益，不是平均）
ℹ tests 65  pass 65  fail 0
```
结论：**无泄漏**；「第二家范围不受影响」既有测试（T5/T7）锁住，本探针用逐位熵值再证一次。

### CONFLICT
**否。**

### RESOLUTION
无需修复。代码依据：`contextBuilder.ts:3208-3210`（`tendency`/`behaviorProfile` 均按 `opponent.id === villainId` 三元注入）
与 `:3185-3186`（`limpProfileFor` 只给 villain 真原型，其余 `POPULATION/confidence 0`）。

---

## 5. 缓存审计 + 顺序无关性

### CLAIM
`src/` 下不存在「按画像键」的缓存；不同画像共用同一进程时不会互相读到对方的范围。

### EVIDENCE

`src/` 模块级可变状态全表（`grep -rn "^(const|let) .*new (Map|Set)|^let " src`，逐条人工核对）：

| 位置 | 键 | 画像相关？ | 结论 |
|---|---|---|---|
| `src/app/manualInput/preflopPriors.ts:689` `WEIGHT_CACHE` | `rfi:${tier}` / `3bet:${tier}` / `defend:…`（tier 由桌型+位置派生）；值 `buildWeights()` 已被 `Object.freeze`（`:155`） | **否** | 安全。同一键在任何画像下都是同一张 169 权重表；且冻结 ⇒ 无污染 |
| `src/domain/range/handPotential.ts:81` `potentialCache` | `combo.canonicalId`；值 = `comboPotential(combo)`（纯函数） | **否** | 安全（≤1326 条，与画像无关） |
| `src/domain/range/rangeCache.ts:122` `createRangeCache` | 见 `buildRangeCacheKey`（版本/桌型/位置/筹码桶/行动签名/尺寸桶/死牌） | **否**（键里没有画像） | **生产无调用者**：全仓 `createRangeCache(` 只出现在 `test/`（`range.test.ts:855,868,887`, `rangeRedTeam.test.ts:492`, `rangeBenchmark.test.ts:213,232,300`）—— 属**未接线**模块，不构成风险 |
| `src/domain/range/range.ts:70` `rangeCounter` | 进程内单调计数器 → `rangeId` | 否（只进诊断 id） | 见下「执行取证」 |
| `src/domain/poker/fastEval.ts:183,185` `scratch` / `suitMasks` | 无键（复用缓冲区） | 否 | 每次调用入口清零（`:196-199`），结果立即解构（`:232-233`），不返回别名；同步直线代码无重入 ⇒ 安全 |
| `src/domain/range/combo.ts:192` `COMBO_BY_ID` | 常量表（`ReadonlyMap`） | 否 | 只读 |
| `src/domain/gto/providers/providerRegistry.ts:41` `REGISTRY`、`src/app/gto/*`（`instance`/`provider`/`enabled`/`queue`）、`gtoSafeLookup.cache` | 场景哈希键 | 否 | **本轮按指令不调查**；但类型层面 `GtoScenario` **显式禁止** `quickProfile`/`dynamicHint`/`playerId`（`gto.types.ts:350-363`），且 `gtoContextIsolation.test.ts` 锁「带全部真人字段 vs 清空 ⇒ 逐位一致」。⇒ **不存在与 `GTOopen/`、`data/gto-cache` 的画像键碰撞**（仅此一句，未深入） |
| `src/app/table/tableApi.ts:71` `RevisionGuard.seen` | `tableId` | 否 | 只做版本水位线 |
| `src/i18n/index.ts:29` `activeDictionary` | 语言 | 否 | — |

**顺序无关性（执行）**
```text
命令：node --experimental-strip-types scripts/v21-rev3-probe.ts item5
连续两次同输入 profile=MANIAC: 主链快照 逐字节相同
连续两次同输入 profile=CALLING_STATION: 主链快照 逐字节相同

命令：node --experimental-strip-types scripts/v21-rev3-probe3.ts item5b
决策快照 A===B ? YES
全量 diagnostics A===B ? YES（逐字节）           ← 中间插入另一手牌 + 另一画像（MANIAC）
diagnostics 长度 A=12088 B=12088
决策输出里出现 rangeId 字段的次数：A=0 B=0 []
```
即：`rangeCounter` 在两次运行之间**确实前进**（插入的分析会消耗 id），
但 `rangeId` **不出现在决策输出里**（0 次），全量 `decision.diagnostics` 仍逐字节相同
⇒ 计数器是**仅诊断用**的进程内序号，不构成顺序依赖。

### CONFLICT
**否。**

### RESOLUTION
无需修复；建议（非阻塞）把 `rangeCache.ts` 标注为「尚未接线」，避免后来者误以为生产走了缓存。
`rangeCounter` 按指令**未改动**。

---

## 6. 确定性 / 顺序

### CLAIM
同一输入在同一进程内重复、以及不同顺序下都逐位一致。

### EVIDENCE
```text
命令：node --test --experimental-strip-types test/nodeDeterminism.test.ts
[determinism] NODE_B_CANONICAL equity=19.2024% callEV=-0.0473 action=FOLD margin=MARGINAL stronger=80.1710% support=513 trace=3
✔ D1：nodeB 同一输入连续 20 次必须逐位一致（含类别模型路径） (75911ms)
✔ D2：先跑 nodeA（含全部有先验原型）不得改变 nodeB (29266ms)
✔ D3：03A→03B（黄金手）不得改变 nodeB (8464ms)
✔ D4：反向顺序（nodeB→nodeA→nodeB）基线不变 (6551ms)
✔ D5：固定 permutation 打乱执行顺序，nodeB 仍逐位一致 (33519ms)
✔ 附：rangeId 计数器不得成为决策输入（同输入两次的决策快照必须一致）
ℹ tests 6  pass 6  fail 0  duration_ms 157969
```
**D1–D5 各自锁什么**（`test/nodeDeterminism.test.ts:202-324`）：
- **D1**（`:202`）：nodeB 同输入**连续 20 次**（`NORMAL` 与 `MANIAC` 两条）逐位一致 —— 锁「重复分析不漂移」。
- **D2**（`:223`）：先跑 nodeA（含 5 个有先验原型）+ 只造上下文，**不得**改变 nodeB —— 锁「前一手牌/前一个画像不污染」。
- **D3**（`:242`）：黄金手 03A→03B 之后再跑 nodeB 不变 —— 锁「黄金局面之间无隐藏共享状态」。
- **D4**（`:255`）：**反向**顺序 nodeB→nodeA→nodeB 基线不变 —— 锁「顺序无关」。
- **D5**（`:267`）：6 组**固定** permutation 打乱执行，nodeB 逐位一致 —— 锁「排列无关」（并注明刻意不用随机）。
- **附**（`:317`）：`rangeId` 不得成为决策输入。
  比较口径是 8 元组 `{equity, required, callEV, winnable, action, margin, strongerShare, rangeSupport, traceLen}`（`:135-166`）
  的逐位相等（NaN 视为相等），**不是**全量 diagnostics —— 本审阅者用全量 `diagnostics` 补测（§5 item5b，逐字节 YES）。

**自建顺序探针（6 画像 × 3 顺序，单进程）**
```text
命令：node --experimental-strip-types scripts/v21-rev3-probe.ts item6
profile=NORMAL           顺序A===顺序B===顺序C ? YES（逐字节）
profile=TIGHT            顺序A===顺序B===顺序C ? YES（逐字节）
profile=CALLING_STATION  顺序A===顺序B===顺序C ? YES（逐字节）
profile=UNDERBLUFFER     顺序A===顺序B===顺序C ? YES（逐字节）
profile=BLUFF_HEAVY      顺序A===顺序B===顺序C ? YES（逐字节）
profile=MANIAC           顺序A===顺序B===顺序C ? YES（逐字节）

6 个画像 × 3 种顺序：不一致数量 = 0
```
（顺序 A/B/C = 正序 / 逆序 / 交错；每个画像比较 `decision.diagnostics.math` 全量 +
`action` + `confidence` + `decisionMargin.kind` + 全部 `reasons[].code` 的 JSON，逐字节。）

### CONFLICT
**否。**

### RESOLUTION
无需修复。

---

## 7. 入口一致性（HTTP vs 直调）与 UI 表达力

### CLAIM
`/api/analyze`（`{input}` 与 `{table}` 两种体）与直接调用 `analyzeManualHand` 对同一画像给出同一决策；
UI 能表达的画像值都能到达画像逻辑，不存在「下拉选了却静默 no-op」。

### EVIDENCE
```text
命令：node --experimental-strip-types scripts/v21-rev3-probe2.ts item7
跛入池 villain=seat_UTG   直调 action=FOLD conf=0.3   HTTP action=FOLD ⇒ 不同键 = （无）逐字段相同
加注池 (nodeA) NORMAL     直调 action=FOLD conf=0.3   HTTP action=FOLD ⇒ 不同键 = （无）逐字段相同
加注池 (nodeA) MANIAC     直调 action=FOLD conf=0.3   HTTP action=FOLD ⇒ 不同键 = （无）逐字段相同

{table} 画像=false（适配后 villain.quickProfile=UNKNOWN playerId=seat_UTG）  直调 action=CALL  HTTP action=CALL ⇒ 不同键 = （无）
{table} 画像=true （适配后 villain.quickProfile=MANIAC  playerId=seat_UTG）  直调 action=CALL  HTTP action=CALL ⇒ 不同键 = （无）
```
比较字段：`decision{action,sizeChips,confidence,band,classification,actionable}` +
`viewModel{actionZh,confidenceZh,classificationZh,reasonsZh,warningsZh}`。
`{table}` 路径由 `webServer.ts:712-732` 复用同一个 `tableStateToManualHandInput`（无第二条适配代码）。
（注：HTTP 侧固定用 `asOf: Date.now()`，`{input}` 用例仍逐字段相同 —— 说明 `asOf` 在这些节点不影响决策。）

**UI 标签覆盖（11 个 `ALL_QUICK_PROFILES`）**
```text
命令：node --experimental-strip-types scripts/v21-rev3-probe2.ts labels
基线（无画像）加注池 equity=17.4953%｜跛入池 equity=1.7525%
标签               加注池Δequity   加注池applied  跛入池Δ       跛入applied
UNKNOWN            0.0000pp       none          0.0000pp      none      ← 与「无画像」逐位相同
VERY_TIGHT        -0.3479pp       true         -0.2800pp      true
TIGHT             -0.1301pp       true         -0.0850pp      true
NORMAL             0.0000pp       false         0.0825pp      false     ← 乘数通道中性，仅跛入通道动
LOOSE              0.0495pp       true          0.0392pp      true
VERY_LOOSE        -0.0398pp       true          0.0717pp      true
CALLING_STATION   -0.3895pp       true          0.1575pp      true
AGGRESSIVE        -0.3606pp       true         -0.0075pp      true
BLUFF_HEAVY        1.3186pp       true         -0.0158pp      true
UNDERBLUFFER      -0.6670pp       true         -0.0850pp      true
MANIAC             1.4823pp       true          0.0217pp      true
```
**11 个标签中 10 个在两条节点上都改变了范围/权益；`UNKNOWN` 与「根本没有 villain 字段」逐位相同**（
`contextBuilder.ts:3168-3175` 显式排除 UNKNOWN）。⇒ **不存在「下拉有值但无先验 ⇒ 静默 no-op」**。
`NORMAL` 在加注池 Δ=0.0000 pp 是**已声明的刻意中性**（`behaviorProfile.ts:334-340`），
但它在跛入池仍动 0.0825 pp（跛入通道），因此也不是 no-op。

**表达力缺口**
1. **LOST（UI 表达不了）**：`seatProfiles`（按座位的响应层画像，§3.4）只能通过手写 `/api/analyze` 请求体给出，
   牌桌 UI 不产出（`tableAdapter.ts:242-257` 的 `input` 无该字段）。
2. **未校验（MIS-MAPPED 风险）**：`villain.playerId` 无校验 ⇒ §2 漏洞 A 可经 HTTP 触发。
   牌桌 UI 不受影响（`tableAdapter.ts:227-240` 恒传首要对手）。
3. 无其他丢失：`quickProfile` / `dynamicHint` / `stackBB` / `behaviorProfile` 四条画像相关字段
   在适配器里逐条搬运（`tableAdapter.ts:232-240`）。

### CONFLICT
**否**（一致性通过；上列是表达力缺口，不是口径分歧）。

### RESOLUTION
- 给 `villain.playerId` 加校验：必须是 `realizedOpponents` 中的座位（或未给出）；
  与 `realizedOpponents[0]` 不一致时至少要**在同一份诊断里如实标注**（当前静默）。
- 若要支持逐座位画像，UI 应把 `seatProfiles` 接上并改按 `playerId` 键（与 §3 的隔离纪律一致）。

---

## 8. 复现清单（全部命令）

```text
node --test --experimental-strip-types test/nodeDeterminism.test.ts                     # 6/6 pass（157.9s）
node --test --experimental-strip-types test/interactiveTable.test.ts                     # 22/22 pass
node --test --experimental-strip-types test/betDecisionEngine.test.ts test/profileRangeAdjustment.test.ts \
  test/multiwayBetResponse.test.ts test/multiLimpIsolation.test.ts test/rangeProfileIntegration.test.ts   # 65/65 pass
node --experimental-strip-types scripts/v21-rev3-probe.ts  item2|item4|item5|item6
node --experimental-strip-types scripts/v21-rev3-probe2.ts item7|item7-hole|item2-ui|labels
node --experimental-strip-types scripts/v21-rev3-probe3.ts item1|item5b
```
未执行：`npm run verify`（指令禁止，另一代理占用）；`test/alphaRedteamRegression.test.ts` 等重文件未跑。
未触发 EPERM（`node --test` 在本机正常）。

## 9. 局限 / 未覆盖

- 本审阅者**未**构造最终动作**翻转**的用例（§2 两洞在这些节点上动作仍为 `BET`/`FOLD`）；
  已证明的是**同一份范围证据被两处消费**（权益 + scorer 层），并提供逐项数字差值。
- §2 漏洞 A 的「UI 不可达」结论基于 `tableAdapter.ts:74-92` 与 `contextBuilder.ts:3219` 的判据比对；
  未穷举所有 `positionsForTableOf` 组合（两者判据在**翻后**实测同序，见 §7 `{table}` 用例）。
- GTO 侧仅做了一句类型层边界确认（见 §5 表末行），按指令未深入。
