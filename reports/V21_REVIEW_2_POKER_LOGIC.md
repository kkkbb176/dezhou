# V21_REVIEW_2_POKER_LOGIC — 扑克决策与剥削逻辑（对抗性评审 2/5）

**评审人**：Reviewer 2 — POKER DECISION & EXPLOITATION LOGIC
**被测仓库**：`D:\德州`（Windows / Node v24.19.0 / TypeScript ESM，显式 `.ts` 扩展名）
**方法**：只读 `src/`，全部结论由**真实执行**得出；探针 8 个（`scripts/v21-rev2-*.ts`）。
**未做**：`git` 写操作、`npm run verify`、任何 `src/` / `test/` 修改。

复现命令（每个都在本机跑过并已在下面引用其输出）：

```text
node --experimental-strip-types scripts/v21-rev2-priors.ts        # 先验真值表 / 单调性 / 死条目
node --experimental-strip-types scripts/v21-rev2-likelihood.ts    # 类别可达性 / 乘数分解
node --experimental-strip-types scripts/v21-rev2-hand.ts          # 生产链路：画像 / 前序线 / 尺寸
node --experimental-strip-types scripts/v21-rev2-thin-response.ts # THIN_VALUE 攻击 / 响应模型
node --experimental-strip-types scripts/v21-rev2-final.ts         # 11 标签全扫 / 决策可翻转性
node --experimental-strip-types scripts/v21-rev2-sizecount.ts     # 尺寸阈值 + 中性标签
node --experimental-strip-types scripts/v21-rev2-boundary.ts      # 权威下注比例 + 阈值边界
node --experimental-strip-types scripts/v21-rev2-size04.ts        # 0.4 阈值
```

---

## 0. VERDICT 表

| # | 审查项 | 结论 | CONFLICT | 关键数字 |
|---|---|---|---|---|
| 1 | 先验是否扑克合理且自洽 | 4/5 主动条目严格单调成立；`callTooWide` **全项目零读者**（死条目）；`VERY_TIGHT` 缺 2 条关键先验 ⇒ 诈唬轴**反序** | **YES** | VT 0.7423 vs CS 0.3901 vs UB 0.3884（乘数）；VT 55.9752% > CS 55.8080% > UB 55.7145%（权益） |
| 2 | 类别可达性 / 画像可见性 | 8 类中只有 **4 类**（3×missed + PURE_AIR）被画像触及；参考手 **98.16%** 的后验质量对画像不可见 | **YES**（与"画像已进入范围"的叙事强度不符） | 不可见质量占比 98.16%（中性）/ 99.22%（CS）/ 95.00%（MANIAC） |
| 3 | 方向是否正确 | **诈唬轴方向正确**（MANIAC > CS：权益 +1.8012pp、callEV +0.8465）；未复现"价值质量反向上升"；但**跨标签**存在反序（very_tight > calling station） | **YES**（跨标签反序） | 权益 +1.8012pp / callEV +0.8465（+6.92%）；动作恒为 CALL（11/11） |
| 4 | THIN_VALUE 攻击 | 一旦写入 `manual.thinValueBet`，权益被这一条主宰（±14~19pp）；诈唬轴**不反向**（保持单调，幅度衰减） | **YES**（量级失控，但方向不反） | 权益 56.2588% → 37.2133%（VERY_HIGH）/ → 70.6654%（VERY_LOW） |
| 5 | `TURN_CHECK_BACK` 节点 | 真实改变似然**与**决策量；方向**扑克正确** | NO | 诈唬质量 1.84% → 0.30%；权益 56.2588% → 54.32%；乘数 2.9155 vs 2.1981 |
| 6 | 尺寸档语义 | 阈值 0.4/0.6/1.25 **逐字确认**；但**只有 0.6 是活边界**，0.4 与 1.25 逐位无效；响应模型对尺寸单调**全部正确** | **YES**（4 值枚举实际 2 值；参考手是 LARGE 而非 36%） | SMALL≡MEDIUM 逐位相同；LARGE≡OVERBET 逐位相同；跨 0.6 权益 +0.6424pp |
| 7 | 「画像」抽象是否合适 | **主观判断**：当前实现是**装饰性旋钮**（动作/置信度从不改变，权益动 1.90pp，98% 质量不可见，定义性条目是死代码） | **YES** | 极差 1.895pp；动作集合 {CALL}；置信度恒 0.3 |

---

## 0.1 先修正题目前提（实测）

**题目给的参考手比例（"7 into 19.5" = 36%）与引擎口径不符。**

`state.actions` 里河牌那条记录的权威值是（`v21-rev2-boundary.ts` §0）：

```text
amountBB=7   state.amount=14   potBefore=19   ⇒ 权威比例=0.736842 (73.68%) ⇒ BetSizeBucketOf=LARGE
⇒ 若按「7 进 19.5」算会得 0.358974 (36%)，与引擎实际口径**不符**
```

即：大盲 2 筹码 ⇒ 底池 9.5BB = **19 筹码**，BB 的 7BB = **14 筹码**，比例 **0.7368**，档位 **LARGE**。
项目自己的黄金测试也锁这个事实（`test/profileQuantificationGolden.test.ts:335`：`note.includes('LARGE')`，"75% 池必须归入 LARGE 尺寸档"）。

因此下文所有"参考手"数字都是 **BB 河牌下注 7BB = 73.68% 池 = LARGE 档**下的值：
`Hero 权益 56.2588%｜所需权益 29.79%｜callEV 12.4417｜动作 CALL｜置信度 0.3`。

---

## 1. 先验是否扑克合理、是否自洽

### CLAIM
`ARCHETYPE_BEHAVIOR_PRIORS` 编码的序关系是
`UNDERBLUFFER < 池先验 < BLUFF_HEAVY < MANIAC`，五个主动条目**逐条严格单调**（源码注释 `behaviorProfile.ts:215-216` 原话，声称"有测试锁"）。

### EVIDENCE（`v21-rev2-priors.ts`）

**1a. 先说清规模**：不是 5 个有先验的原型，是 **6 个**（`VERY_TIGHT, LOOSE, CALLING_STATION, BLUFF_HEAVY, UNDERBLUFFER, MANIAC`）；`NEUTRAL_ARCHETYPES` 有 **5 个**（`UNKNOWN, NORMAL, TIGHT, VERY_LOOSE, AGGRESSIVE`）。`selfCheckArchetypePriors` 返回 `[]`（通过）。

**1b. 生效先验全真值表**（`*` = 表里没给 ⇒ 回落池先验）

| 标签 | riverBluff | riverLargeBetBluff | missedDrawBluff | probeAfterTurnCheckBack | thinValueBet | callTooWide |
|---|---|---|---|---|---|---|
| 池先验 | 0.280 | 0.200 | 0.250 | 0.300 | 0.350 | 0.500 |
| UNKNOWN | 0.280* | 0.200* | 0.250* | 0.300* | 0.350* | 0.500* |
| VERY_TIGHT | 0.120 | **0.200\*** | 0.120 | **0.300\*** | 0.350* | 0.250 |
| TIGHT | 0.280* | 0.200* | 0.250* | 0.300* | 0.350* | 0.500* |
| NORMAL | 0.280* | 0.200* | 0.250* | 0.300* | 0.350* | 0.500* |
| LOOSE | 0.300 | **0.200\*** | 0.300 | 0.300（等于池） | 0.350* | 0.600 |
| VERY_LOOSE | 0.280* | 0.200* | 0.250* | 0.300* | 0.350* | 0.500* |
| CALLING_STATION | 0.150 | 0.080 | 0.100 | 0.180 | 0.350* | **0.720** |
| AGGRESSIVE | 0.280* | 0.200* | 0.250* | 0.300* | 0.350* | 0.500* |
| BLUFF_HEAVY | 0.450 | 0.380 | 0.500 | 0.450 | 0.350* | 0.500* |
| UNDERBLUFFER | 0.120 | 0.080 | 0.120 | 0.150 | 0.350* | 0.500* |
| MANIAC | 0.500 | 0.420 | 0.550 | 0.500 | 0.350* | **0.450** |

**1c. 声明链的逐条单调性（执行结果）**

```text
riverBluff               UNDERBLUFFER=0.120 < 池=0.280 < BLUFF_HEAVY=0.450 < MANIAC=0.500  ⇒ 严格递增=YES
riverLargeBetBluff       UNDERBLUFFER=0.080 < 池=0.200 < BLUFF_HEAVY=0.380 < MANIAC=0.420  ⇒ 严格递增=YES
missedDrawBluff          UNDERBLUFFER=0.120 < 池=0.250 < BLUFF_HEAVY=0.500 < MANIAC=0.550  ⇒ 严格递增=YES
probeAfterTurnCheckBack  UNDERBLUFFER=0.150 < 池=0.300 < BLUFF_HEAVY=0.450 < MANIAC=0.500  ⇒ 严格递增=YES
thinValueBet             四个值全部 =0.350                                                  ⇒ 严格递增=**NO**
callTooWide              UNDERBLUFFER=0.500 … MANIAC=0.450                                 ⇒ 严格递增=**NO**（不在声明内）
⇒ 声明链上的违例条目数 = 2
```

**1d. `callTooWide` 是死条目（三种独立证据）**
1. 静态：`callTooWide` / `CALL_TOO_WIDE` 在 `src/` 内共 10 处，**全部**在 `behaviorProfile.ts`（枚举、中文名、先验表、注释）；**没有任何生产读者**，包括注释声称的"响应模型"。
2. 行为：把 `manual.callTooWide` 从 `VERY_LOW` 拉到 `VERY_HIGH`，八个类别 × 一条动作的似然**逐位相同**：
   `0.95000000 0.45706896 0.21939310 0.12797931 0.02139875 ×3 0.02371616`（两行完全一致）。
3. 后果：`CALLING_STATION` 的**定义性条目**（跟注过宽 0.72）对决策零影响；该标签在模型里只剩"诈唬更少"这一半语义。

### CONFLICT — **YES**（三处）

1. **注释与执行矛盾**：源码声称五个主动条目逐条严格单调"有测试锁"，实测 `thinValueBet` 是**常数 0.350**，即只有 **4/5** 严格单调。`test/profileRangeAdjustment.test.ts:452` 的 T5 锁的是 `UNDERBLUFFER < LOOSE < BLUFF_HEAVY ≤ MANIAC` 的 **bluffMassShare**（4 个原型、1 个量），**没有**任何测试锁 5 条目的逐条单调性。
2. **诈唬轴跨标签反序**：`VERY_TIGHT` 缺 `riverLargeBetBluff` 与 `probeAfterTurnCheckBack` 两条先验（回落池），而 `CALLING_STATION` / `UNDERBLUFFER` 都有。在参考节点（LARGE + TURN_CHECK_BACK）的合成乘数：

   ```text
   MISSED_* 类：VERY_TIGHT 0.7423 ｜ CALLING_STATION 0.3901 ｜ UNDERBLUFFER 0.3884 ｜ LOOSE 1.0874
   PURE_AIR 类：VERY_TIGHT 0.7052 ｜ CALLING_STATION 0.4324 ｜ UNDERBLUFFER 0.3689
   ⇒ 「最紧的对手」被建模为比「跟注站」和「不诈唬型」**多 1.90×** 的河牌开火倾向
   ⇒ 权益：VERY_TIGHT 55.9752% > CALLING_STATION 55.8080% > UNDERBLUFFER 55.7145%
   ⇒ 诈唬质量：VERY_TIGHT 1.31% > CALLING_STATION 0.78% > UNDERBLUFFER 0.70%
   ```
   在"他不诈唬"这条语义轴上，标签序是**反的**。
3. **规范自相矛盾**：模块注释明确写「诈唬倾向不蕴含跟注宽度（主动被动隔离）」并据此**刻意不给** `BLUFF_HEAVY` / `UNDERBLUFFER` 的 `callTooWide`；但同样是诈唬原型的 **`MANIAC` 却给了 `callTooWide: 0.45`**。要么这是跨维度推断（那另两个也该有），要么不是（那 MANIAC 不该有）。而它又是死条目 ⇒ 这 0.45 是**不可验证的虚构精度**，正是 §二十八 自己禁止的东西。

### RESOLUTION
- 把源码注释改成"4 条主动条目严格单调 + `thinValueBet` 刻意恒定"，或补一条真的遍历 5 条目的测试锁。
- 给 `VERY_TIGHT` 补 `riverLargeBetBluff` / `probeAfterTurnCheckBack` 先验（或把它整个移进 `NEUTRAL_ARCHETYPES` 并写明理由），否则必须放弃"紧 ⇒ 少诈唬"的可读语义。
- `callTooWide` 三选一：接进响应模型（`betResponse`）、删掉、或标成 `NOT_WIRED`。**保留"已建模"的外观而不接任何读者是最坏选项**——这正是本项目自己反复点名的"静默失效"。
- `MANIAC.callTooWide = 0.45` 删除或补上与 `BLUFF_HEAVY` 一致的处理。

---

## 2. 类别可达性与画像可见性

### CLAIM
画像通过「动作似然 → 组合重加权 → 加权范围 → 权益」影响决策（`behaviorProfile.ts` 文件头链路图）。

### EVIDENCE（`v21-rev2-likelihood.ts`）

**2a. 8 个 `RiverComboClass` 在参考牌面上的真实可达性**（穷举 45 选 2 = 990 组合）

```text
NUT_VALUE              combos=  0  **不可达**
STRONG_VALUE           combos= 29  档位={1}
THIN_VALUE             combos= 86  档位={2}
SHOWDOWN_VALUE         combos=471  档位={2,3,4}
MISSED_FLUSH_DRAW      combos= 22  档位={5}
MISSED_STRAIGHT_DRAW   combos=208  档位={5}
MISSED_COMBO_DRAW      combos= 32  档位={5}
PURE_AIR               combos=142  档位={5}
分类失败(null)=0
```

**2b. 条件化因子分解（`base × size × node × profile`，几何平均，分母 K = 结构槽位数）**

| 段 | 何时施加 | 施加什么 | 中性值 |
|---|---|---|---|
| BASE | 永远 | `tierWeightOf(likelihoodWeights('AGGRESSIVE', ratio), strengthBucket)` | 既有档位曲线本身 |
| SIZE | `sizeBucket ∈ {LARGE, OVERBET}` **且** 类别 ∈ 3×MISSED ∪ PURE_AIR | `cond(riverLargeBetBluff)` | 1.0 |
| NODE | 诈唬类 **且** `previousStreetLine === 'TURN_CHECK_BACK'` | `cond(probeAfterTurnCheckBack)` | 1.0 |
| PROFILE | `MISSED_* → cond(missedDrawBluff)`；`PURE_AIR → cond(riverBluff)`；`THIN_VALUE → cond(thinValueBet)`；`NUT/STRONG/SHOWDOWN → 无` | 几率比 | 1.0 |

`K = 1 + (诈唬类?1:0) + (诈唬类或薄价值?1:0)` ⇒ **诈唬类恒 K=3，薄价值 K=2，其余 K=1**（与实际施加了几条**无关**）。

**2c. 逐类 × 逐标签的合成乘数（LARGE + TURN_CHECK_BACK）**

```text
类别                K   UNKNOWN VERY_TIGHT TIGHT NORMAL LOOSE VERY_LOOSE CS     AGGRESSIVE BLUFF_HEAVY UNDERBLUFFER MANIAC
NUT_VALUE           1   1.0000  1.0000     1.0000 1.0000 1.0000 1.0000    1.0000 1.0000     1.0000      1.0000      1.0000   ← 画像不可见
STRONG_VALUE        1   1.0000  1.0000     1.0000 1.0000 1.0000 1.0000    1.0000 1.0000     1.0000      1.0000      1.0000   ← 画像不可见
THIN_VALUE          2   1.0000  1.0000     1.0000 1.0000 1.0000 1.0000    1.0000 1.0000     1.0000      1.0000      1.0000   ← 画像不可见
SHOWDOWN_VALUE      1   1.0000  1.0000     1.0000 1.0000 1.0000 1.0000    1.0000 1.0000     1.0000      1.0000      1.0000   ← 画像不可见
MISSED_FLUSH_DRAW   3   1.0000  0.7423     1.0000 1.0000 1.0874 1.0000    0.3901 1.0000     2.4125      0.3884      2.9155
MISSED_STRAIGHT_…   3   1.0000  0.7423     1.0000 1.0000 1.0874 1.0000    0.3901 1.0000     2.4125      0.3884      2.9155
MISSED_COMBO_DRAW   3   1.0000  0.7423     1.0000 1.0000 1.0874 1.0000    0.3901 1.0000     2.4125      0.3884      2.9155
PURE_AIR            3   1.0000  0.7052     1.0000 1.0000 1.0329 1.0000    0.4324 1.0000     2.1434      0.3689      2.5903
```

**2d. 画像不可见的类别（11 个标签下 likelihood 逐位相同）= 4/8**
`NUT_VALUE, STRONG_VALUE, THIN_VALUE, SHOWDOWN_VALUE`。可见的只有 `MISSED_FLUSH/STRAIGHT/COMBO_DRAW` 与 `PURE_AIR`。

**2e. 参考手中"对画像不可见"的后验质量占比**（`v21-rev2-hand.ts` A2）

| 标签 | nut | strong | thin | showdown | 不可见合计 | missed+air（可动） |
|---|---|---|---|---|---|---|
| UNKNOWN/NORMAL | 0.00% | 11.01% | 29.66% | 57.49% | **98.16%** | 1.84% |
| CALLING_STATION | 0.00% | 11.54% | 29.60% | 58.07% | **99.22%** | 0.78% |
| VERY_TIGHT | 0.00% | 10.86% | 30.05% | 57.77% | **98.69%** | 1.31% |
| BLUFF_HEAVY | 0.00% | 10.66% | 29.08% | 56.12% | **95.86%** | 4.14% |
| MANIAC | 0.00% | 10.64% | 28.76% | 55.60% | **95.00%** | 5.00% |

### CONFLICT — **YES（解释层面）**
画像只能触碰 **1.84%** 的后验质量（中性基线），98.16% 的质量位于 `profileAdjustment ≡ 1.0` 的类别上。这不是 bug（是"只推诈唬端"的刻意设计，见 `behaviorProfile.ts:791-802`），但它意味着"画像已经进入范围"这句话在**质量口径上只覆盖 1/54 的范围**，任何把它读成"对手范围被画像显著改写"的 UI 文案都是过度声称。

### RESOLUTION
在 `profileRangeEvidence` 里**同时**输出"可动质量占比"（现在只有 `equityBefore/After` 与组合数），让使用者一眼看到画像的作用面只有 1.8%。`NUT_VALUE` 在参考牌面不可达一事建议补进 `riverComboClassCoverage` 的说明（普通牌面上它是可达的，此处只是本牌面无档 0）。

---

## 3. 方向是否正确（参考手 CALLING_STATION vs MANIAC）

### CLAIM
`数学层绝对优先级`（`CURRENT_PROJECT_STATUS.md:324`）冻结 `Pot/Odds/Required Equity/Equity 算法/EV 算法`，画像**只改概率**；且 §二十 要求"对手诈唬越多 ⇒ Hero 抓诈唬权益越高"。

### EVIDENCE（`v21-rev2-hand.ts` A + `v21-rev2-final.ts` §1）

**3a. 题目要求的 `diagnostics.postflop.betDecision.sizes` 在该节点不存在**

```text
参考手（Hero 面对下注）：betDecision = null，pot=—，sizes=[]
postflopAdvisor.ts:550  if (facingBet || betDecisionFacts === null) return null;
⇒ 面对下注的节点**根本不建响应模型**，因此"对手的弃/跟/加概率"在本题的节点上是**不可得的**。
```

响应模型只在 Hero **有下注权**时存在（`v21-rev2-final.ts` §2，BB 河牌 check 变体）：

```text
尺寸         比例     金额    弃牌     跟注     加注     权益(对跟注)  权益(对加注)  EV      评分
BET_SMALL   0.3333   6.33    0.2341   0.6566   0.1093   53.2989%       63.917%      13.084  0.5174
BET_MEDIUM  0.6667  12.67    0.3526   0.6135   0.0340   48.8788%        4.466%      11.466  0.4748
BET_LARGE   1.0000  19.00    0.4419   0.5304   0.0277   40.2852%        4.376%       9.561  0.4246
```

**3b. Hero 权益 / 所需权益 / callEV（参考手，11 标签全扫）**

```text
标签              动作   置信度   权益         所需权益   callEV     Δvs中性(pp)
UNKNOWN          CALL   0.3     56.2588%    29.79%    12.4417    0.000
VERY_TIGHT       CALL   0.3     55.9752%    29.79%    12.3083   -0.284
TIGHT            CALL   0.3     56.2036%    29.79%    12.4157   -0.055
NORMAL           CALL   0.3     56.2588%    29.79%    12.4417    0.000
LOOSE            CALL   0.3     56.3326%    29.79%    12.4763   +0.074
VERY_LOOSE       CALL   0.3     56.2884%    29.79%    12.4555   +0.030
CALLING_STATION  CALL   0.3     55.8080%    29.79%    12.2298   -0.451
AGGRESSIVE       CALL   0.3     56.1577%    29.79%    12.3941   -0.101
BLUFF_HEAVY      CALL   0.3     57.2429%    29.79%    12.9041   +0.984
UNDERBLUFFER     CALL   0.3     55.7145%    29.79%    12.1858   -0.544
MANIAC           CALL   0.3     57.6091%    29.79%    13.0763   +1.350
⇒ 极差 1.895pp；动作集合 = {CALL}；置信度恒为 0.3
```

**3c. 高诈唬率是否让跟注变好？—— 是。**
`MANIAC vs CALLING_STATION`：权益 **55.8080% → 57.6091%（+1.8012pp）**，callEV **12.2298 → 13.0763（+0.8465 筹码，+6.92%）**；同时 `missedDrawMass 0.49% → 3.40%`、`bluffMass 0.78% → 5.00%`。所需权益完全不变（29.79%，与画像无关，符合"数学层冻结"）。**方向 CONFLICT = NO。**

**3d. 题目猜想的"反向量"（激进原型的价值质量上升）—— 未复现。**
`MANIAC` 的价值质量是 **下降**的：`valueMass 40.672% → 39.399%`、`strongValueMass 11.01% → 10.64%`、`thinValueMass 29.66% → 28.76%`。原因是设计上价值端**不乘任何画像条目**，只有归一化把质量从价值端挪走。**这一条 CONFLICT = NO**（设计成立）。

**3e. 但我构造出了另一处真实的反序（跨标签，同一轴）**
"他不诈唬"这一侧：`UNDERBLUFFER 55.7145% < CALLING_STATION 55.8080% < VERY_TIGHT 55.9752%`，而 `VERY_TIGHT` 的 `riverBluff`/`missedDrawBluff`（0.12）**与 UNDERBLUFFER 完全相同**（0.12/0.12）。差异全部来自 `VERY_TIGHT` 缺失那两条先验（§1c-1d）。即：**"最紧"被赋予比"不诈唬型"更高的诈唬率**。

**3f. "刻意中性"标签并非中性（第二条画像通道仍在跑）**

```text
标签            权益         vs UNKNOWN   provider.applied
UNKNOWN        56.258837%    0.000000     null
NORMAL         56.258837%    0.000000     false
TIGHT          56.203569%   -0.055268     true
VERY_LOOSE     56.288360%   +0.029522     true
AGGRESSIVE     56.157746%   -0.101091     true
```

四类诈唬条目的乘数对这四个标签全部恰为 1.0000，所以差异**不可能**来自先验层。它只能来自条目层之外的通道：`suppressProvider` 只在**河牌进攻动作**上生效（`contextBuilder.ts:1308`），而对手范围还由翻前跟注 / 翻牌跟注两条记录更新，那两条仍会走倾斜 provider（【代码推断】），实测这三家 `provider.applied === true`（【实测】）。⇒ `NEUTRAL_ARCHETYPES` 的"画像在这一层不提供信息"只在**条目层**为真，在**决策层**为假。
副产品：下拉框的松紧序不单调 —— `TIGHT 56.2036% < NORMAL 56.2588% < LOOSE 56.3326% > VERY_LOOSE 56.2884%`。

**3g. 决策能否被画像翻转？—— 不能（两个手牌都试过）**
固定手：11/11 标签都是 `CALL`（权益差 1.90pp，而对所需权益的余量是 **26.47pp**）。
边际手（把 Hero 换成 `KsQs` 等 6 手牌找最大权益）：最接近所需权益的是 `KsQs` 的 9.2956% vs 所需 29.79%（余量 −20.49pp），11/11 标签都是 `FOLD`。需求权益的结构上限是 0.5（`b/(P+2b) → 0.5`），因此在本节点"权益 ~56%"根本不可能被定价出局——**画像与决策翻转无关**。

### CONFLICT — **YES**（3e、3f 两处）
其余方向断言（3c 的诈唬轴、3d 的价值端单向性、所需权益冻结）**全部通过**。

### RESOLUTION
- 修 `VERY_TIGHT` 的先验覆盖（见 §1 RESOLUTION），否则"紧 ⇒ 少诈唬"这条最直观的语义在模型里是反的。
- `NEUTRAL_ARCHETYPES` 的文案改成"**条目层**中性"；或者在决策层把这些标签真的做中性（把 `archetypeDimensionsOf` 对中性标签的产出置空）。
- UI 不应在 `betDecision === null` 的节点上展示任何"对手弃/跟/加"数字（现在没有，保持）。

---

## 4. 攻击 `THIN_VALUE`

### CLAIM
`THIN_VALUE_TRAIT_POLICY`：标签先验一律不给 `thinValueBet`（回落池 0.35 ⇒ 乘数 1.000），因此 03A/03B 的差别"恰好"是诈唬轴；并声称若给先验会"把符号弄反"。

### EVIDENCE（`v21-rev2-thin-response.ts` B；参考节点 LARGE + TURN_CHECK_BACK）

```text
标签              手动thin  动作   权益      所需      callEV    thin质量  价值质量  strong  showdown  air   画像进范围
neutral           —         CALL   56.2588%  29.79%   12.4417  29.6600%  40.6720%  11.01%  57.49%    0.64% null
neutral+thinLOW   VERY_LOW  CALL   70.6654%  29.79%   19.2128  11.6475%  25.4795%  13.83%  72.21%    0.80% null
neutral+thinHIGH  VERY_HIGH CALL   37.2133%  29.79%    3.4902  53.4725%  60.7566%   7.28%  38.02%    0.42% null
CS                —         CALL   55.8080%  29.79%   12.2298  29.6018%  41.1410%  11.54%  58.07%    0.29% true
CS+thinLOW        VERY_LOW  CALL   70.0639%  29.79%   18.9301  11.6188%  26.1057%  14.49%  72.91%    0.37% true
CS+thinHIGH       VERY_HIGH CALL   36.9396%  29.79%    3.3616  53.4031%  61.0410%   7.64%  38.44%    0.19% true
MANIAC            —         CALL   57.6091%  29.79%   13.0763  28.7563%  39.3994%  10.64%  55.60%    1.60% true
MANIAC+thinLOW    VERY_LOW  CALL   71.8013%  29.79%   19.7466  11.2052%  24.4702%  13.26%  69.30%    1.99% true
MANIAC+thinHIGH   VERY_HIGH CALL   38.5036%  29.79%    4.0967  52.3836%  59.4970%   7.11%  37.16%    1.07% true
```

**4a. 薄价值质量的乘数可逐位复算**：`cond(0.8)/cond(0.35) = 7.4286`，`K=2` ⇒ `7.4286^(1/2) = 2.7255`；后验占比预测 `2.7255×0.2966/(1−0.2966+2.7255×0.2966) = 53.47%`，实测 **53.4725%**（VERY_LOW 同理：`0.31264` ⇒ 预测 11.65%，实测 **11.6475%**）。

**4b. 量级：薄价值这一条 = 整条画像轴 ×10**

```text
thin 从 VERY_LOW → VERY_HIGH：中性权益 70.6654% → 37.2133%（×0.5266，−33.45pp）
                              MANIAC 权益 71.8013% → 38.5036%（−33.30pp）
                              callEV  19.7466 → 4.0967（×0.2075）
对比：11 个标签的画像轴极差 = 1.895pp ⇒ **薄价值单条 = 画像全轴 17.7×**
```

**4c. 诈唬轴在薄价值两极下是否保持单调？—— 保持（不反向，但幅度衰减）**

```text
无 thin 设定   权益 55.8080% → 57.6091%（Δ +1.801pp） callEV Δ +0.8465 ⇒ 单调=YES
thin=VERY_LOW  权益 70.0639% → 71.8013%（Δ +1.737pp） callEV Δ +0.8166 ⇒ 单调=YES
thin=VERY_HIGH 权益 36.9396% → 38.5036%（Δ +1.564pp） callEV Δ +0.7351 ⇒ 单调=YES
⇒ 单调性 HOLDS；幅度随 thin 上升而**收缩**（1.801 → 1.737 → 1.564pp）
⇒ 但**极性**由 thin 决定：thin=VERY_HIGH 时 Hero 只剩 36.9%（CALL 靠的是 29.79% 的门槛），
  thin=VERY_LOW 时 70.1%。画像在这两个世界里都只是 ±1.5~1.8pp 的抖动。
```

**4d. 通道可达性**：`manualInput.ts:226` 的 villain 字段确实有 `behaviorProfile?: PlayerBehaviorProfile`，`parseManualInput` 也接受它（本探针就是这样注入的）。**GUI 下拉框只给 `quickProfile`**，所以这条 ±19pp 的通道在界面上不可达，但 `POST /api/analyze` 一个 JSON 字段即可到达。

### CONFLICT — **YES**（机制的"安全"建立在"没人用"之上）
1. 源码注释（`behaviorProfile.ts:286-297`）举证的反向案例（`CS 68.17% vs MANIAC 67.99%`）来自**已被删除的"按标签给 thinValueBet"**版本；在当前实现下，我把同一个 manual 值施加到两个原型上，诈唬轴**不反向**。⇒ 该注释现在是**过期的证据**，它证明的机制已不存在，读者会误以为"薄价值必然反向"。
2. 机制的风险没有消除，只是被"标签不给先验"挡住了：`thinValueBet` 是唯一缩放"**能打败 Hero**那一侧"的条目，一旦有人给标签补上它（或界面暴露 manual 通道），权益就被单条主宰（±33pp），而 `THIN_VALUE` 的 `K=2` 稀释只把它压到 2.7255×——一个 19pp 的杠杆。

### RESOLUTION
把注释里的旧数字标记为"已删除实现的历史证据"；并在 `estimateUnifiedActionLikelihood` 里给 `thinValueBet` 的乘数加一条**显式上界**（例如与 `riverBluff` 同量级的 ±1.5×）或要求"必须带 `observed.opportunities > 0`"才允许超过某阈值——现在是任意 manual 值直接进 2.7255×。

---

## 5. `TURN_CHECK_BACK` 节点

### CLAIM
`previousStreetLine` 让"我 check-back → 他 probe"与"他下注 → 我跟注"成为不同节点（§三十八），且"让牌后开火"的似然**更高**。

### EVIDENCE

**(a) 纯函数隔离（`v21-rev2-likelihood.ts` §3，MISSED_* 类）**

```text
前序线            尺寸    MANIAC 合成乘数    条目数
TURN_CHECK_BACK  LARGE    2.9155           3
TURN_BET_CALL    LARGE    2.1981           2
TURN_BET_CALL    SMALL    1.5420           1   （K=3 稀释：只剩 3.6667^(1/3)）
⇒ 方向：CHECK_BACK > BET_CALL，与管理层注释一致
```

**(b) 生产链路隔离（`v21-rev2-hand.ts` C2：河牌同为 LARGE，只改转牌线）**

```text
标签             前序线        节点                     权益        所需       callEV    诈唬质量
UNKNOWN         CHECK_BACK   TURN_CHECK_BACK/LARGE   56.26%     29.79%    12.442    1.84%
UNKNOWN         BET_CALL     TURN_BET_CALL/LARGE     54.32%     30.84%    25.121    0.30%
CALLING_STATION CHECK_BACK   TURN_CHECK_BACK/LARGE   55.81%     29.79%    12.230    0.78%
CALLING_STATION BET_CALL     TURN_BET_CALL/LARGE     54.15%     30.84%    24.937    0.16%
MANIAC          CHECK_BACK   TURN_CHECK_BACK/LARGE   57.61%     29.79%    13.076    5.00%
MANIAC          BET_CALL     TURN_BET_CALL/LARGE     54.38%     30.84%    25.186    0.63%
⇒ 只改前序线：权益 −1.94pp（中性）、诈唬质量 1.84% → 0.30%（−84%）、MANIAC 5.00% → 0.63%
```

### CONFLICT — **NO**
方向**扑克正确**：我 check-back 转牌 ⇒ 我的范围被封顶（没有强价值），对手在空白河牌上的 probe 是攻击封顶范围的廉价手段 ⇒ 诈唬密度**更高**；反过来，"他转牌领打、我跟注、他河牌再开火（barrel-barrel）"是强价值加权线 ⇒ 诈唬密度**更低**。模型两条都是对的。

**但要记录两个非对称**：
1. **节点比画像强**：翻前序线带来的权益变化（1.94pp）**大于整条画像轴的极差（1.895pp）**。同一个用户在"转牌线怎么读"上的一次不同理解，比他在下拉框里选哪个标签更重要——而界面并不提示这一点。
2. **单边性**：`probeAfterTurnCheckBack` 只乘到诈唬类，价值类不乘。真实上"他 probe 我的 check-back"是**两极分化**（更多诈唬 + 更多薄价值，更少摊牌牌），模型只做了一极。好处是方向永不反；代价是权益响应被单向夸大，且模型**永远无法表达**"我 check-back 后他更可能拿两对/暗三开火"。

### RESOLUTION
保持方向；在 `trace` 里把"节点因子只作用于诈唬端"写进 `noteZh`（现在 `noteZh` 只说施加了哪条条目）。§4 的 `thinValueBet` 上界也能顺带限制这个单边性。

---

## 6. 尺寸档语义

### CLAIM
`BetSizeBucketOf` 用 0.4 / 0.6 / 1.25 三阈值分 SMALL/MEDIUM/LARGE/OVERBET；模型对尺寸的响应在扑克上是单调的（下注越大 ⇒ 范围越强 ⇒ Hero 权益越低）。

### EVIDENCE

**6a. 源码阈值逐字 + 执行确认**（`behaviorProfile.ts:538-539`：`>=1.25 OVERBET : >=0.6 LARGE : >=0.4 MEDIUM : SMALL`）

```text
ratio=0.300 ⇒ SMALL    ratio=0.400 ⇒ MEDIUM    ratio=0.600 ⇒ LARGE    ratio=1.250 ⇒ OVERBET
ratio=0.399 ⇒ SMALL    ratio=0.599 ⇒ MEDIUM    ratio=1.249 ⇒ LARGE    ratio=1.540 ⇒ OVERBET
```

**6b. 参考手的真实档位 —— 是 LARGE，不是 36%/SMALL**

```text
状态记录：amount = 14 筹码，potBefore = 19 筹码 ⇒ 权威比例 0.736842 ⇒ **LARGE**
⇒ 题目的“36%”前提不成立；项目黄金测试同样锁 LARGE
```

**6c. 三个阈值的真实作用（MANIAC / CALLING_STATION，`v21-rev2-boundary.ts` + `v21-rev2-size04.ts`）**

```text
金额  比例      源码档     trace档    MANIAC权益      CS权益        Δ(pp)     MANIAC诈唬
 7    0.368421  SMALL      SMALL     56.966726%    55.953798%   1.012927   3.5618%
10    0.526316  MEDIUM     MEDIUM    56.966726%    55.953798%   1.012927   3.5618%   ← 与 SMALL **逐位相同**
11    0.578947  MEDIUM     MEDIUM    56.966726%    55.953798%   1.012927   3.5618%   ← 与 SMALL **逐位相同**
14    0.736842  LARGE      LARGE     57.609138%    55.807984%   1.801154   5.0014%   ← 跨 0.6 跳变
15    0.789474  LARGE      LARGE     57.609138%    55.807984%   1.801154   5.0014%
23    1.210526  LARGE      LARGE     57.609138%    55.807984%   1.801154   5.0014%
29    1.526316  OVERBET    OVERBET   57.609138%    55.807984%   1.801154   5.0014%   ← 与 LARGE **逐位相同**
38    2.000000  OVERBET    OVERBET   57.609138%    55.807984%   1.801154   5.0014%   ← 与 LARGE **逐位相同**
```

**6d. 结论：4 值枚举实际只有 1 条活边界（0.6）**
- `0.4` 是**死边界**：SMALL 与 MEDIUM 在 MANIAC/CS 上权益与诈唬质量**逐位相同**。
- `1.25` 是**死边界**：LARGE 与 OVERBET 逐位相同（`big = LARGE || OVERBET` 把两者合并），121% 池与 200% 池被建模为同一件事。
- 唯一跳变在 `0.6`：MANIAC 权益 **56.966726% → 57.609138%（+0.642412pp）**，诈唬质量 **3.5618% → 5.0014%（×1.404）**。这是一条**悬崖**：池注比例从 0.58 走到 0.64，模型的"他在诈唬"质量就跳 40%。

**6e. 响应模型对尺寸的单调性（Hero 有下注权节点）—— 全部正确**

```text
弃牌率随尺寸↑: YES [0.2341 → 0.3526 → 0.4419]
跟注率随尺寸↓: YES [0.6566 → 0.6135 → 0.5304]
加注率随尺寸↓: YES [0.1093 → 0.0340 → 0.0277]
权益(对跟注范围)随尺寸↓: YES [53.2989% → 48.8788% → 40.2852%]   ← 大注 ⇒ 更强的跟注范围 ⇒ Hero 权益更低 ✓
权益(对加注范围)随尺寸↓: YES [63.917% → 4.466% → 4.376%]
betEV 随尺寸↓: YES [13.084 → 11.466 → 9.561]
⇒ 方向 CONFLICT = NO
```

**6f. 两把尺寸尺子（次要不一致）**
响应模型的梯度是 `1/3 · 2/3 · 1` 池（`BET_SIZE_SPECS`），似然模型的活边界是 `0.6`。于是响应模型的"**中注**"（2/3 = 0.6667）在似然侧被判成 **LARGE**；而似然侧有一个 MEDIUM 档（0.4–0.6）**在响应模型里没有任何尺寸落进去**。同一"尺寸"概念在两条链上用了不同刻度。

### CONFLICT — **YES**（枚举语义与死边界）
### RESOLUTION
- 要么把 `SMALL/MEDIUM` 与 `LARGE/OVERBET` 合并成二值（并删掉 0.4 / 1.25 两个从不生效的阈值），要么让多个尺寸条目作用于不同档（例如 `MEDIUM` 用 `thinValueBet`、`OVERBET` 用更强的条目）。**现在是把 4 个选项画在界面上、只有 1 个在数学上存在。**
- 0.6 的悬崖需要平滑（例如按 `log(ratio)` 连续插值），否则使用者把 0.58 记成 0.62 就会改变模型输出 40%。
- 统一尺寸刻度：让 `BET_SIZE_SPECS` 的比例落在 `BetSizeBucketOf` 的不同档上。

---

## 7. 「画像」这个抽象在这个节点上是否合适 —— 主观判断

> **以下是我的判断，不是测量结果。测量数字在第 3/2/1 节，可以独立复核。**

**我的判断：对"单人使用、低注额现金局、手工录入"的定位，当前这个"一人一个标签"的画像在**这个节点**上基本是装饰性的，而且它的复杂度/风险比它的收益高。**

支撑它的数字（全部实测）：
1. **它从不改变输出动作**：11/11 个标签在参考手都是 `CALL`（余量 26.47pp）；在边际手（换 6 手牌找最接近门槛的）11/11 都是 `FOLD`。需求权益的结构上限 0.5、而参考手权益 ~56%，这个节点在数学上不可能被 1.9pp 推动。
2. **它甚至不改变置信度**：11/11 都是 `0.3`。
3. **它能看见的范围只有 1.84%**：98.16% 的后验质量落在 `profileAdjustment ≡ 1.0` 的 4 个类别上；`NUT/STRONG/THIN/SHOWDOWN` 的乘数**在所有 11 个标签下逐位等于 1.0000**。
4. **唯一能区分"跟注站"的条目是死代码**：`callTooWide = 0.72` 在 `src/` 里零读者。因此"跟注站"在模型里只是"诈唬略少的 UNDERBLUFFER"——两者权益差 **0.0935pp**（55.8080% vs 55.7145%，4 位小数），而 MANIAC vs CS 是 1.8012pp。也就是说，**用户标注"跟注站"这个操作，其语义（他跟得太宽）根本没有进入计算，只有它的副作用（他很少诈唬）进入了**。
5. **它已经在语义上反了**：`VERY_TIGHT` 55.9752% > `CALLING_STATION` 55.8080% > `UNDERBLUFFER` 55.7145%，即"最紧的对手"被当成比"不诈唬型"更爱开火（乘数 0.7423 vs 0.3884，1.90×）。这不是精度问题，是**符号问题**，而它恰好落在使用者最可能随手选的两个标签上。
6. **文档声称的可信度上限没有作用在这条通道上**：`QUICK_PROFILE_CONFIDENCE = 0.35` 没有出现在 `estimateUnifiedActionLikelihood` 的任何位置；`traits[k].confidence` 为 0（0 次机会），而乘数按**满强度**施加（`MANIAC riverBluff cond = 2.5714 = odds(0.50)/odds(0.28)`）。也就是说，那句"主观判断，可信度上限 0.35"在**唯一真正改变权益的通道**上是装饰。
7. **同一只手/同一节点上，另两个旋钮比它大一个数量级**：转牌线读法 1.94pp > 画像全轴 1.895pp；`manual.thinValueBet` ±33pp。画像既不是最大的不确定性来源，也不是最容易被用户搞错的那个。

**它做对了什么（必须一起说）**：去重做得很干净（`scorerProfileConfidence = rangeLayerApplied ? 0 : …`、`bluffCatchDelta: rangeProfileApplied ? 0 : …`），方向在"诈唬轴"上是对的，`selfCheckArchetypePriors` + `archetypePriorAvailable` 这套"不许静默失效 / 不许假装确定"的工程纪律是我在这个仓库里见到的最扎实的部分之一。所以我的结论不是"画像很糟"，而是**"这一个标签承载的信息量，撑不起它现在占的推理面积"**。

**如果我是维护者，我会**（按性价比排序）：① 修 `VERY_TIGHT` 的符号反序；② 把 `callTooWide` 接进响应模型或删掉——它是"跟注站"标签的全部意义；③ 把 4 值尺寸枚举压成 2 值、或让 0.4/1.25 真的生效；④ 在 UI 上把"画像只影响 1.8% 的范围质量、不改变本次动作"如实说出来；⑤ 把 `thinValueBet` 的 manual 通道加上界。

**什么证据会让我改变判断（预先声明）**
- **实测数据**：如果 `observed` 通道真的接上了手牌历史（本项目已支持 `{successes, opportunities}` 且会把标签先验当作伪计数收缩），任何一个标签的权益贡献能在 100+ 手的机会数下稳定超过 1.9pp 并且**翻转至少一个真实边缘决策**，那画像就从装饰变成了资产。现在的 1.895pp 极差是**先验**造成的，不是数据造成的。
- **分布证据**：如果参考手这类"顶对 vs 河牌大注"之外的节点（例如空气 vs 小注、封顶范围 vs probe）上画像的权益极差显著大于 2pp（我预判 §5 的节点会放大它），那么"画像无用"就只对这一个节点成立——这需要第二个黄金夹具来否证我。
- **可解释性证据**：如果界面能把"这个标签改了哪几条条目、每条几倍、动了多少质量"逐条显示（`withTrace: true` 已经能产出这些），使用者就有机会发现并纠正 5 里的符号反序；那时"单标签"作为**交互原语**是可接受的，只是数值需要重标定。
- **反向证据**：如果 `callTooWide` 被接进 `betResponse` 后，"跟注站 vs 不诈唬型"的决策差异被拉到可与 MANIAC↔CS 相比（≥1pp 且能翻转一个边缘决策），那么我关于"标签冗余"的判断就被推翻。

---

## 8. 环境事实与限制

- `node --test` 未作为主证据（避免与其它评审争抢 `npm run verify`／3 分钟预算）；全部结论取自 `node --experimental-strip-types` 直跑生产函数。**未遇到 EPERM。**
- `.ts` 直跑要求显式扩展名：`computePot` 在 `src/domain/poker/gameState.ts`（不是 `src/domain/state.ts`）——这是本探针唯一一次导入失败，已修正。
- 权益与范围量在同一种子（`equitySeed: 20260913`）与无种子（`analyzeManualHand` 默认）两条路径下**数值一致**（例如 UNKNOWN 56.2588% 两次相同），因此下文所有 pp 级差异都是确定性的，不是蒙特卡洛噪声。
- 下注金额被量化到整数筹码（`amountBB: 3.42` → `state.amount = 7`），因此无法精确落在我要求的比例上；§6 表格给的是**记录里的权威比例**。
- 未修改 `src/`、`test/`；未执行任何 `git` 写操作。
