# LIVE UI V1 · 阶段 0 阻塞项报告：后端「当前行动者」在一种常见情形下不可用

- 分支：`dev-computer-a` @ `e28b650`
- 发现方式：按任务第三节要求，先核实后端是否可靠提供「当前应行动玩家」
- 结论：**大部分情形可靠，但有一种常见情形不可靠** ⇒ 需要你决定是否批准最小修改

---

## 一、可靠的部分（已实测）

后端 `tablePreview.ts:653` 用引擎的 `actorOnTurn(engineState)` 计算
`currentActorSeatId` / `currentActorPosition` / `isHeroTurn`，**不是前端推测**。
实测这些情形全部正确：

| 情形 | 实测结果 |
|---|---|
| 翻前正常行动顺序（9MAX） | `UTG → UTG1 → UTG2 → LJ → HJ → CO → BTN → SB` 逐位正确 |
| 6MAX 前 5 位弃牌推进 | `UTG → HJ → CO → BTN → SB` 正确 |
| 有人加注后的重新行动 | `UTG 开池 → HJ` 正确 |
| 弃牌玩家被跳过 | UTG/HJ 弃牌后 CO 开池 → `BTN` 正确 |
| 合法动作列表 | 完全来自后端 `preview.actionButtons`（PRIMARY/EXPAND/SIZE 三组） |
| Hero 在中间位 | `UTG 开池 → HJ → 弃 → CO(Hero)`，`isHeroTurn=true` 正确 |

**⇒ 第三节要求的「不得仅通过前端座位顺序推测下一位玩家」是可以满足的：
后端已经给出了权威答案，UI 只需渲染它。**

---

## 二、不可靠的部分（真缺陷）

### 复现

6MAX（9MAX 同样），Hero = BB，前面所有人弃牌：

```text
动作序列：UTG:FOLD  HJ:FOLD  CO:FOLD  BTN:FOLD  SB:FOLD
预期：轮到 BB(Hero)，他有无加注时的选择权（check 或 raise）
实际：phase = COMPLETE
      actorOnTurn = null
      handComplete = true
      currentBet = 0
      winners = ["seat_BB"]
      BB.folded = false   ← 他没有弃牌，也确实还没行动过
```

### 根因

`src/domain/poker/engine.ts:176-186`（`doFold`）：

```ts
function doFold(state: GameState, playerId: string): StateResult {
  const player = playerById(state, playerId)!;
  player.folded = true;
  ...
  if (countContenders(state) === 1) {
    finishByFold(state);        // ← 只要剩一人就收手
    return { ok: true, state, issues: [] };
  }
```

`countContenders === 1` 这个判据**只数剩下几个人**，没有区分：

- 「剩下的是**已经行动过**的大盲」（例如所有人都 CALL 过，大盲已经用掉选择权）⇒ 收手正确
- 「剩下的是**还没行动过**的大盲」（所有人都 FOLD 到他）⇒ **收手错误**

这不是前端能修的问题 —— 引擎一旦把 `phase` 置为 `COMPLETE`，后续任何动作都会被
`ACTION_AFTER_HAND_OVER` 拒绝，`/api/analyze` 也没有决策点。

### 为什么既有测试没抓到

`test/engine.test.ts` 的「大盲的选择权（翻牌前 option）」只覆盖了
**全员溜入**（UTG/HJ/CO/BTN/SB 全部 `CALL`）这一种路径：

```ts
assert.equal(actorOnTurn(state), 'bb');   // 全员 CALL 时正确
assert.equal(state.pendingQueue.length, 1);
```

**没有覆盖「全员 FOLD 到大盲」**。这两条路径在 `doFold` 里走的是不同分支
（前者不进 `countContenders === 1`，后者进）。

### 与项目自述规则的冲突

`README.md` 核心不变量第 5 条：

> 5. **大盲在无人加注时仍有选择权。**

且 `README.md` 明确把「漏掉大盲的翻牌前选择权」列为已修复的缺陷类型之一。
**本次实测说明该不变量只对「全员跟注」成立，对「全员弃牌」不成立。**

---

## 三、影响评估

| 影响面 | 说明 |
|---|---|
| 触发频率 | **高**。9MAX 现金局里「弃到盲注」极常见；只要 Hero 是大盲、前面全弃，100% 触发 |
| 本任务 | **阻塞第三节的自动跟随**：弃到 Hero 时 `actor=null`，UI 无法高亮焦点、也无法录入 Hero 的动作 |
| 其他功能 | 不影响「Hero 面对加注」这条主路径（那条实测正确） |
| 是否本轮引入 | **不是**。基线 `e28b650` 就如此；`src/domain/poker/engine.ts` 本轮未改动 |

---

## 四、最小修改方案（**未执行，待你批准**）

### 方案 A（推荐）：在 `doFold` 收手前加一个「剩余者是否已行动过」判据

```ts
if (countContenders(state) === 1) {
  const last = state.players.find((p) => !p.folded)!;
  /*
   * 翻前「弃到大盲」不是本手结束：
   * 大盲已投盲注但**从未行动过**，他在无人加注时仍有选择权
   * （README 核心不变量第 5 条）。
   */
  const bbHasOption =
    state.street === Street.PREFLOP &&
    last.position === Position.BB &&
    !state.actedSinceLastAggression.includes(last.id) &&
    state.currentBet <= state.config.bigBlind;
  if (!bbHasOption) {
    finishByFold(state);
    return { ok: true, state, issues: [] };
  }
}
```

`actedSinceLastAggression` 是引擎里已有的字段（`engine.ts` 自身在维护），
因此不需要新状态。**判断依据全部来自引擎已有事实，不引入新牌局规则。**

### 方案 B（更保守）：只在 UI 侧标注

不改引擎，UI 在检测到 `handComplete === true && 唯一未弃牌者 === Hero`
时显示「本手已被判定结束（引擎：全员弃牌到大盲）」并**明确告知这是已知缺陷**。

- 优点：零核心改动
- 缺点：**用户无法记录「大家弃到我，我加注」这一类真实牌局** —— 而这在实战里很常见

### 我建议

**方案 A**，但**必须**同时补一条测试锁住两条路径：

```ts
// ① 全员 CALL → 大盲有选择权（已有测试，保留）
// ② 全员 FOLD → 大盲仍有选择权（**新增，当前失败**）
```

理由：README 把它列为核心不变量，而当前实现只兑现了一半。
另外要跑全量 2247 项回归确认没有别的测试依赖「只剩一人即收手」这个行为。

---

## 五、本轮的处理

1. **不修改 `engine.ts`**（在你明令不改的清单里）
2. 前端仍然**完全依赖后端**的 `currentActorSeatId` / `isHeroTurn` / `actionButtons`，
   不自行推断顺序 —— 因此在后端可用的情形下，自动跟随照常工作
3. 当后端返回 `actor=null` 且 `handComplete=true` 时，UI **如实显示该状态**，
   不静默、也不伪造一个行动者
4. 等你批准后再执行方案 A
