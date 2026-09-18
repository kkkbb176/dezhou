# TEST HAND MULTIWAY TURN FIX — REPORT

固定回归牌局（未修改）：9-max｜1/2｜有效 120BB｜Hero **BB 9♠8♠**
翻前 UTG+1 开 3BB、LJ 跟、Hero 跟；翻牌 **T♠7♦2♠** Hero check / UTG+1 bet 3BB / LJ call / Hero call；
转牌 **8♦** Hero check / UTG+1 check / **LJ bet 14BB（76%）** ⇒ Hero 行动。

---

## Initial Bug（修复前输出）

```text
建议 CALL｜所需权益 30.1%｜Hero Equity 36.3%
[BOARD_DELTA] 牌面接近空白｜白板度 0.87              ← 8♦ 被判成空白
[POSTFLOP_ROLE] 角色「听牌」强度 0.30               ← 已经成对，但只显示「听牌」
[动作顺序] pendingQueue = [seat_BB, seat_UTG1]       ← 引擎自己知道 UTG+1 还在后面
           降级说明却写「本街已无人待行动」          ← 自相矛盾
[RAISE_STRATEGIC_CANDIDATE] EV = NOT_AVAILABLE
【动作偏好序】CALL 0.623｜FOLD 0.377｜RAISE 0.365    ← 三个数被摆成同一把尺子
```

## Root Cause

| # | 问题 | 根因 |
|---|---|---|
| 1 | 8♦ 被判空白（0.87） | `computeBoardDelta` 的 `changed` **只**由「高张 + 四个布尔翻转（四张同花/四张连张/成对/同花可能）+ 我方档位」构成。`T72→8` 一个布尔都没翻转 ⇒ 0.87。而这张牌让 **J9/96 成顺、88 成三条、T8/87 成两对**，牌面出现 T-8-7 连张。**结构性漏判**，不是阈值问题 |
| 2 | 只听牌、看不到成对 | 快照只给单一 `handRole`（相对牌力角色）；`drawProfileOf` 的补牌没有分桶，成手与听牌没有被合成一个结构描述，且 outs 会把 6♠/J♠ 这类「顺子+同花」补牌混在一起 |
| 3 | 非 closing 却用简化 Call EV | `yetToActIds` 把「本街已经说过话」当成「不再需要说话」，**忽略了「下注重开行动」**；于是 `playersYetToAct = 0`，而引擎自己的 `pendingQueue` 里 UTG+1 还在 Hero 之后 |
| 4 | RAISE 与 CALL/FOLD 同列排序 | `evRanking` 只存 `{action, score}`，把「有 EV 的动作」与「只有启发式偏好分的战略候选」放进同一数组，界面直接显示成可比数值 |

## Changed Files

| 文件 | 改动 |
|---|---|
| `src/domain/postflop/boardDelta.ts` | `changed` 改为**连续量加权和**：高张、结构布尔、**连张变化**、**同花听变化**、**新完成牌类**、我方档位、坚果偏移、对手范围改善；新增 `BoardDeltaKind`（BLANK/SEMI_BLANK/DYNAMIC/HIGH_IMPACT）、`straightDrawDelta`、`flushDrawDelta`、`classCompletion`、`dynamicScore` |
| `src/domain/postflop/draws.ts` | 新增 `outAuditOf`：RAW / CLEAN / DISCOUNTED / DIRTY 四桶（**互不重复**，重复的牌如实列出）、非坚果同花听标记 |
| `src/domain/decision/decision.types.ts` | `DecisionContext.playersRemainingToAct` / `isClosingAction`；`PostflopFacts.handStructure`；`evRanking` 每项加 `kind` / `noteZh` |
| `src/app/manualInput/contextBuilder.ts` | 从 `state.pendingQueue` 计算 `playersRemainingToAct`；在 §8b 计算 `handStructure`（成手 + 听牌 + 四桶补牌） |
| `src/app/decision/postflopAdvisor.ts` | 牌面变化文案改为与 `kind`/连续结构量一致（不再「接近空白 + 白板度 0.27」并存） |
| `src/app/decision/decisionEngine.ts` | 降级说明改用 `playersRemainingToAct`；新增 `ACTION_NOT_CLOSED` 警告；`evRanking` 打上 `EV_SUPPORTED` / `STRATEGIC_CANDIDATE_ONLY`；`BOARD_DELTA` 理由列出新完成牌类 |
| `src/viewmodels/decisionViewModel.ts` | 调试区拆成「EV 支持的动作（可互相比较）」与「战略候选（无 EV，分数不可比）」两行 + 排序语义说明 |
| `test/multiwayTurnFix.test.ts` | 新增 TEST A / A2 / A3 / A4 / B / C / D / E / F（9 项） |
| `test/postflopOutput.test.ts` | P3-4 按新语义更新（**并新增**「RAISE 不得出现在 EV 组」的反证断言） |
| `scripts/board-delta-probe.ts` | A–D 牌面变化探针 |

## Board Delta Fix

```text
changed = 0.20×|高张| + 0.15×|结构布尔翻转|
        + 0.35×连张变化 + 0.20×同花听变化
        + 0.65×新完成影响（新成顺 0.7 权重 / 新成花 0.2 / 新三条 0.05 / 新两对 0.05）
        + 0.15×|我方档位变化| + 0.10×|坚果偏移| + 0.10×对手范围改善
blankScore = 1 − changed；kind：≥0.85 BLANK｜≥0.65 SEMI_BLANK｜≥0.40 DYNAMIC｜否则 HIGH_IMPACT
```

「新三条 / 新两对」**任何一张牌都会非零**（新牌自己就与牌面组成两对），因此只给弱权重；
真正区分动态牌的是**新成顺 / 新成花**。实测（`scripts/board-delta-probe.ts`）：

| 用例 | kind | blankScore | 新成顺 | 新三条 | 新两对 |
|---|---|---|---|---|---|
| **A** T♠7♦2♠ → **8♦**（固定牌局） | **DYNAMIC**（含范围事实时 HIGH_IMPACT 0.27） | **0.446**（旧 0.87） | 4（J9/96） | 1（88） | 6（T8/87…） |
| B T♠7♦2♠ → 3♣（真空白） | BLANK | 0.901 | 0 | 1 | 6 |
| C T♠7♦2♠ → 8♣（成顺牌） | DYNAMIC | 0.446 | 4 | 1 | 6 |
| D T♠7♠2♠ → 3♠（四张同花） | DYNAMIC | 0.616 | 0 | 1 | 6 |

TEST B 证明没有「修复过头」：真正的空白牌仍然是 BLANK（≥0.85）且新成顺 = 0。

## Hand Role Fix

`handStructure`（新增，逐手牌可测）：

```text
成手 PAIR｜听牌 OESD + FLUSH_DRAW ⇒ structureLabel = PAIR_PLUS_OESD_PLUS_FLUSH_DRAW
RAW 20 = 顺子补牌 8 ∪ 同花补牌 9 ∪ 成对补牌 5（6♠/J♠ 同时属于顺子与同花 ⇒ **只计一次**）
CLEAN 6（非花色顺子补牌）｜DISCOUNTED 9（非坚果同花听）｜DIRTY 5（成对补牌）
nonNutFlushDraw = true（9 高同花，可能输给更大的花）
```

角色强度（`roleStrength = 0.30`）**本轮不改数字**：它是一个跨街可比的相对刻度，
真正的缺口是「成手与听牌没有被分开描述」。现在两者同时可见（TEST A2 锁定），
并且**禁止**把 RAW outs 直接换算成胜率（`notesZh` 明确写了这条纪律）。

## Closing Action Fix

```text
playersRemainingToAct = pendingQueue 中「Hero 之后」且未弃牌/未全下的玩家数
isClosingAction       = playersRemainingToAct === 0
固定牌局：pendingQueue = [seat_BB, seat_UTG1] ⇒ playersRemainingToAct = 1 ⇒ isClosingAction = false
```

- 修复前：`playersYetToAct = 0` ⇒ 降级说明写「本街已无人待行动」（与自己的队列矛盾）。
- 修复后：说明改为「**我行动之后还有 1 名对手必须行动**（下注重新打开了行动）—— 本次跟注不是 closing action」。
- 新增 `ACTION_NOT_CLOSED` 警告：「跟注后仍有 N 名对手未行动，当前跟注 EV 为**简化代理值**，
  未包含后位玩家继续跟注或加注的影响（底池赔率与所需权益仍然有效）」。

## Raise Ranking Fix

```text
EV 支持的动作（可互相比较）：CALL 0.62 > FOLD 0.38
战略候选（**无 EV**，上面的分数不可比）：RAISE heuristicScore 0.37（EV: NOT_AVAILABLE）
排序语义说明：CALL EV_SUPPORTED｜RAISE STRATEGIC_CANDIDATE_ONLY｜FOLD EV_SUPPORTED
```

`evRanking` 的每项都带 `kind`；ViewModel 拆成两行显示；TEST A4 断言 RAISE **不得**出现在 EV 组。

## Regression Tests

`test/multiwayTurnFix.test.ts`（9 项，全绿）：

```text
TEST A  8♦ 必须是动态牌（非 BLANK、白板度 < 0.7、新成顺 ≥3 / 新三条 ≥1 / 新两对 ≥3）
TEST A2 Hero 9♠8♠ = PAIR + OESD + FLUSH_DRAW；RAW = CLEAN+DISCOUNTED+DIRTY；6♠/J♠ 只计一次；非坚果同花听
TEST A3 playersRemainingToAct = 1、isClosingAction = false、ACTION_NOT_CLOSED 存在、所需权益仍给出
TEST A4 RAISE 进战略候选组（EV: NOT_AVAILABLE），不进 EV 组
TEST B  T♠7♦2♠→3♣ 仍是 BLANK（≥0.85，新成顺 = 0）
TEST C  T♠7♦2♠→8♣ 识别 J9/96（新成顺 ≥3）
TEST D  T♠7♠2♠→3♠ 识别同花结构变化（flushCompleted / fourToFlush / flushDrawDelta > 0）
TEST E  单挑 Hero 最后行动 ⇒ isClosingAction = true
TEST F  A 过牌 → B 下注 → Hero ⇒ isClosingAction = false（不靠人数判断）
```

## Full Test Suite

```text
npm run typecheck  → 0 错误
npm run verify     → 见下方「最终验证」段（typecheck + manifest + 全量测试）
旧测试处理：只有 `test/postflopOutput.test.ts` P3-4 因**显示语义变化**更新，
            并**新增**了「RAISE 不得进入 EV 组」的反证断言（未放宽、未删除任何旧断言）。
```

## Remaining Limitations

1. **Equity 36.3% 未改**（按要求）：它来自 `computeEquity`（FAST 模式、6000 次抽样、
   固定种子 `equitySeed ?? 20260913`），对手范围 = UTG+1 的开池范围 + LJ 的跟注范围，
   死牌 = Hero 底牌 + 公共牌。但对手范围本身是**启发式先验 + 似然更新**，
   故仍标：`EQUITY_INPUT_NOT_FULLY_AUDITABLE`（范围组成可解释，可信度 0.30）。
2. `playersYetToAct`（本街没说过话的人）与 `playersRemainingToAct`（我之后还要行动的人）
   仍是两个概念，前者继续用于「信息不足」提示 —— 两者在 UI 上尚未合并展示。
3. `roleStrength`（0.30）与 `drawStrength` 仍是单一刻度；本轮只补了**结构化**描述，
   刻度本身的重标定（pair + 双听应该给多少）留给下一轮，避免出现「为了让这手好看而调刻度」。
4. `ANY_RAISE` / 多人再加注树仍未实现（沿用上轮的下界口径）。
5. RAKE 未实现；LJ 画像（VPIP 48 / 少诈唬）仍未进入面对下注节点的权益（上轮已报）。
