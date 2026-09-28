# 修复报告：切断「翻前 PFR → 翻后下注范围」越权通道

**轮次**：PFR→BETRANGE FIX ｜ **日期**：本轮
**验证判据**：`npm run verify` ⇒ **exit 0**（类型检查 + 产物清单校验 + **2,312 项 / 2,312 通过 / 0 失败**）
日志：`reports/_verify_after_pfr_betrange_fix.log`（最终一次运行即本轮收尾；期间每次改动生产/测试/状态文件后都重跑过）
**前置**：`reports/PFR_TO_BETRANGE_VERIFICATION.md`（缺陷的定位与对照实验）

---

## 0. 一句话

> **一条实测 `pfr=9%` 曾经能把「他翻牌下注范围里空气占多少」从 35% 改到 47%、
> 把我方权益抬 8.6pp、把 J♥J♠ 的动作从 RAISE 翻成 CALL。修复后该层只认
> 「翻后证据 + 手选标签」：全部翻前统计（`VPIP` / `PFR` / `3Bet`）对该层的
> 影响**逐位为 0**（13 种统计组合给出同一个数），而响应层与翻前链路**完全不变**。**

---

## 1. 缺陷回顾（为什么必须修）

| | 修复前 |
|---|---|
| 通道 | `pfr` →（极性 +1）融合维度 `aggression` → `betProbabilityByBand` 的锚 `valueAnchor / thinAnchor / showAnchor` |
| 实测后果 | `pfr` 5% → 49.15% 权益、`pfr` 35% → 32.99%（**16.2pp 跨度**）；`thinAnchor` 被推到 −0.0766 ⇒「顶对/中对」整档被踢出他的下注范围 |
| 纪律冲突 | 源码明文禁止该推论：`observedStats.ts`「PFR 不碰 `bluffTendency`（禁止「翻前凶 ⇒ 河牌爱诈唬」）」——极性表照做了，但 `aggression` 在另一层被当成「开枪倾向」的系数，于是**从后门成立** |
| 语义错误 | `VPIP` 在该层是零影响，因此「12/9 紧手」与「60/9 松被动鱼」被算成**同一个下注者**；而 `docs/player_types.md`（实测库）里两者 c-bet 率 72% vs 66%、fold-to-flop-bet 72% vs 64% |

---

## 2. 修法（**最小改动**，不动任何 EV / 赔率 / 权益公式）

> 思路：**给下注范围层一个它自己的 aggression**，其取值**只由翻后统计推动**；
> 无翻后证据时**逐位等于标签原型值**（= 修复前取值）⇒ 标签路径与既有夹具零变化。

改动共 **5 个生产文件**：

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/domain/player/observedStats.ts` | ① 把「逐统计推力」抽成可复用的 `StatPush` + `accOf(pushes, axes)`（只取部分轴做加权平均，用于「剔除翻前统计」）；② 新增 `postflopBetAggression`：只让 `STAT_TO_STREET_TRAIT` 覆盖到的统计计入 `aggression`，无翻后证据 ⇒ 返回 `baseDimOf('aggression')`；③ `StreetFactors` 新增 `betAggression`（逐街同一个值，随既有透传链带走）；④ `neutralStreetFactors()` 补 `betAggression: 0.5` |
| 2 | `src/domain/postflop/betResponse.ts` | `ResponseTendencies` 新增可选 `aggressionForBetRange`；`responseTendenciesOf(dims, conf, street, betAggression?)` 在**显式给出**时才带上该字段（缺省 ⇒ 返回值逐位不变，既有调用方零影响） |
| 3 | `src/app/manualInput/contextBuilder.ts` | `betRangeTendenciesForSeat`（**唯一**给下注范围层供数的地方）把 `v3StreetInput.factors.betAggression` 作为第 4 个实参传入 |
| 4 | `src/app/manualInput/bettingRange.ts` | 锚点计算改读 `aggressionForBetRange`（缺省回落读维度 ⇒ 旧入口/审计脚本行为不变）；模型事实包新增 `aggressionInput { value, source }`，使**该层吃了哪份 aggression 可从快照复算** |
| 5 | — | 未改任何 EV / 赔率 / 权益 / 行动排序 / 语义门 |

**为什么不是「把 aggression 从锚里删掉」**：那样会让**标签路径**的数值全部改变
（幅度更大），而缺陷只出在「翻前统计通过该轴进入」。本修法把**取证来源**与
**消费者**分开，标签路径保持逐位不变。

---

## 3. 修复前后对照（同一夹具，逐位可复算）

夹具：9 人桌 / 100BB / K♠7♥2♣ / UTG 开池 3BB → Hero BTN 跟注 → UTG 下注 5BB；
对手标签 `VERY_TIGHT`，其余实测统计固定（`vpip12 / threeBet3 / wtsd24 / foldCbet72 …`），**只改 `pfr`**。

| PFR | 修复前 EqVs下注 | 修复后 EqVs下注 | 修复前 纯空气 | 修复后 纯空气 | 修复后动作 |
|---|---|---|---|---|---|
| 未观测 | 40.69% | **38.04%** | 38.77% | **35.15%** | RAISE 20.00 |
| 5% | 49.15% | **38.04%** | 49.68% | **35.15%** | RAISE 20.00 |
| 9% | 46.64% | **38.04%** | 46.54% | **35.15%** | RAISE 20.00 |
| 13% | 44.17% | **38.04%** | 43.38% | **35.15%** | RAISE 20.00 |
| 17% | 41.78% | **38.04%** | 40.23% | **35.15%** | RAISE 20.00 |
| 22% | 38.96% | **38.04%** | 36.42% | **35.15%** | RAISE 20.00 |
| 28% | 35.91% | **38.04%** | 32.21% | **35.15%** | RAISE 20.00 |
| 35% | 32.99% | **38.04%** | 28.13% | **35.15%** | RAISE 20.00 |

> **「未观测」行修复前也是 40.69% 而不是 38.04%**，这不是修复造成的 —— 两个数的差别来自
> 「其余 9 项统计是否给」：修复前该行的 `aggression` 由 `vpip12/threeBet3/wtsd24` 等一起推，
> 而修复后该层的 aggression 只认翻后统计 ⇒ 退到标签原型值 0.45。
> 两列分别取自**同一夹具**（其余 9 项实测统计全部给出）的同一探针：
> 修复前 `scripts/tight-villain-pfr-sweep-out.txt`、修复后 `scripts/tight-villain-pfr-sweep-after-fix.txt`。

**PFR 扫描（同一探针，修复后）**：`scripts/tight-villain-pfr-sweep-after-fix.txt` ——
`EqVs下注` 全域 **38.04%**、`CALL_EV` 全域 **165.643**、`纯空气` 全域 **35.15%**、动作全域 `RAISE 20.00`。

逐项归因矩阵（`scripts/tight-villain-stat-attribution-after-fix.txt`，13 种组合 × 4 手牌）：

```text
全部组合（无实测 / 全 10 项 / 单加 vpip / 单加 pfr / 单加 threeBet / 单加 wtsd /
单加 foldToFlopCBet / 单加 flopCheckRaise / 组合若干 / pfr=22%）
⇒ EqVs下注 38.0%｜动作 RAISE 20.00｜strengthFloor 0.7717｜nutDensity 0.6218｜airDensity 0.2470｜CALL_EV 165.6
```

**全部逐位相同** —— 即「翻前统计不再改写他下注范围的构成」。

### 3.1 仍然生效的部分（没有被顺手掐断）

| 通道 | 修复后是否仍生效 | 证据 |
|---|---|---|
| 标签（`MANIAC` vs `VERY_TIGHT`）→ 下注范围 | **仍生效** | 测试 `墨菲 M-4` 的 ②：MANIAC 的 AIR 率严格高于 VERY_TIGHT |
| `WTSD` → `passivity` → 下注范围 | **仍生效** | 测试 `墨菲 M-7` 与 `附录-2` ③ |
| 实测统计 → **响应层**（弃/跟刻度、分街系数） | **仍生效** | `profileFacingBetChannel` 测试五（VPIP）、`profileEffectiveness` P4-1/P4-2/P4-5/P4-6 全绿 |
| 翻前加注响应模型（画像 → 逐尺寸加注 EV） | **仍生效** | P4-5 / P4-6 未改动且通过 |
| 语义门（河牌统计不得影响翻牌节点） | **仍生效** | P4-3 通过 |

---

## 4. 测试契约更新（**不是放宽断言**）

共 **10 处**，全部是「钉住旧行为」的断言，改为钉住**新契约**并写明理由：

| 文件 | 测试 | 更新内容 |
|---|---|---|
| `test/profileFacingBetChannel.test.ts` | 复算助手 `bandRatesUnderDims` | 与生产**同口径**：从快照 `model.aggressionInput` 读实际使用的 aggression 再复算（原助手复算的是修复前语义） |
| 同上 | §五-A1 | 断言「其余三轴吃 V3 融合维度 + aggression 吃 `betAggression`」，并新增对照「该层仍被画像驱动」 |
| 同上 | 墨菲 M-4 | 断言改为「VPIP/PFR/3Bet **不得**改写该层」+「方向仍由标签决定」 |
| 同上 | 墨菲 M-7 | 断言改为「PFR 全域与该层逐位相同」+ 对照「响应层仍吃 VPIP、该层仍吃 WTSD」 |
| 同上 | 附录-2 ② | 「该层仍随 WTSD 变化」（原断言把 PFR 也算进驱动源） |
| `test/profileEffectiveness.test.ts` | 夹具 `flopNode` / `riverNode` | 新增 `bind` 形参（身份绑定）与翻后统计；**新增 P4-1b**：只有翻前统计 ⇒ CALL EV 必须与「无统计」**逐位相同**（把修复本身钉成回归锁） |
| `test/callFoldVerdictRuler.test.ts` | P1-A 钉值 | CALL EV `2.705235410024 → 2.6317493125308147`；下注范围权益 `0.32906138275397 → 0.32799636684827266`（**契约不变**：EV>0 ⇒ 不得弃牌、一致性必须通过） |
| `test/test17DisplayDisclosure.test.ts` | D-3 显示值 | `73.51% → 73.50%` |
| 同上 | D-8 钉值 | CALL EV `30.719693642502683 → 30.715422655009696`；RAISE EV `36.75849453937832 → 36.82403661199185`；P1-2b 跟注分支 `−67.732181090706945 → −67.60440198090103`（尺寸 80 / FOLD 分支 / 最终动作**不变**） |
| `test/raiseToAmountConsistency.test.ts` | §八 钉值 | CALL EV `75.18122987205047 → 75.3924782169689`；RAISE 186 EV `93.97844769482654 → 94.45548888245273`（**资金口径与动作全部不变**） |

产物清单：`npm run manifest` 已重新生成 `data/artifact-manifest.json`（197 个文件）。

---

## 5. 遗留与边界（如实标注）

1. **下注范围层目前没有正向的「翻后 aggression」证据源**：极性表里 `FoldTo*CBet` / `*CheckRaise`
   对 `aggression` 的极性都是 0 ⇒ `betAggression` 目前**只做减法**（切断越权），不做加法。
   将来给 `*CheckRaise` 补上 aggression 极性即可让该通道变成真正的「有数据驱动」，
   **不需要再改接线**（`postflopAgg` 的融合已经就绪，有测试覆盖「剔除翻前统计」这一层）。
2. **同一个人身上仍并存两套「他爱不爱开枪」的口径**：`betScaleOfUnifiedDimensions`（阈值门，
   含 PFR）与新的锚系数（不含 PFR）。本次只修了**下注范围构成**这条；`betScale` 的定性判断
   是否也要摘掉翻前来源，属下一轮决策（本轮未改，未扩大改动面）。
3. **`foldToFlopCBet` 仍然对该层零影响**（它只走分街通道）。这与 `docs/player_types.md`
   里「Nit vs Tight-passive 的真正区分量是 fold-to-flop-bet」不一致，是**下一个候选修复**，
   但不在本轮授权范围。
4. 所有数字都是**未计抽水**、响应模型为**结构性先验未校准**（引擎自带免责声明）。

---

## 6. 复现

```powershell
# 修复前后对照（同一脚本，同一夹具）
node --experimental-strip-types scripts/tight-villain-pfr-sweep.ts            # → scripts/tight-villain-pfr-sweep-out.txt（修复前）
node --experimental-strip-types scripts/tight-villain-pfr-sweep.ts            # → 修复后重跑：应为全平
node --experimental-strip-types scripts/tight-villain-stat-attribution.ts     # → *-after-fix.txt（13 组全平）

# 验收
npm run verify
```
