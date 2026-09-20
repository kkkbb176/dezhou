# 跨阶段发牌与行动状态一致性 · 根因报告（STREET_STATE_CONSISTENCY_V1）

> **性质**：审计（只读）报告。修复方案见 §6；实施与测试结果见交付说明。
> **复现命令**：`node --experimental-strip-types scripts/audit-street-state-v1.ts`
> **原始输出**：`%TEMP%\street-audit-1.txt`

---

## §1 最小复现（9 人桌 · Hero BTN · A♠K♠ · 转牌对手下注 · Hero 未行动）

全部经**生产入口**：`createTable` → `applyTableOp`（前端点击对应的后端操作）→ `engineViewOf` /
`buildTablePreview` / `tableStateToManualHandInput` / `reconstructGameState` / `analyzeManualHand`。

```text
§5 转牌：对手下注，Hero 尚未行动（一致状态）
   board=[Kd 9c 4h 6s]（4 张）｜actionHistory=13 条｜最后一条 = TURN BB BET 5BB
   engineViewOf: ok=true ｜ street=TURN ｜ bettingRoundComplete=false ｜ 行动者=BTN(p1)
   preview: street=TURN(转牌) ｜ blockers=[]
   adapter: input.street=TURN ｜ input.board=4 张
   reconstruct(DECISION): ok=true ｜ analyzeManualHand: ok=true（动作=CALL）   ← 一切正常

§6 此时录入河牌 Q♥（用户的报告场景）
   SET_BOARD_CARD(slot=4, Qh) ⇒ **操作被接受 = true**（只校验顺序与重复）
§7 录入后：
   board=[Kd 9c 4h 6s Qh]（5 张）｜actionHistory 仍是 13 条
   engineViewOf: ok=true ｜ street=**TURN** ｜ bettingRoundComplete=false ｜ 行动者=BTN
   preview: street=TURN(转牌) ｜ **blockers=[]**（界面认为可以分析）
   adapter: input.street=**RIVER**（由牌数反查得到）｜ input.board=5 张
   reconstruct(PREVIEW): street=TURN（停在真实状态）
   reconstruct(DECISION): ✖ HISTORY_DOES_NOT_REACH_STREET
        「要分析「河牌」，但行动记录在「转牌」还没结束。还需要录入「庄家位」的行动（或他的弃牌/跟注/过牌）。」
   analyzeManualHand: ok=false ｜ stage=RECONSTRUCT（**这就是用户看到的 RECONSTRUCT**）

对照 A（先把转牌跟注补齐，再录河牌）：
   录入被接受；engineViewOf ⇒ street=RIVER；preview ⇒ 河牌；analyzeManualHand ⇒ 正常
对照 B（Hero 在转牌弃牌后再录河牌）：
   录入被接受；engineViewOf ⇒ street=TURN、handComplete=true；preview ⇒ 转牌 +「本手已经结束」
   analyzeManualHand ⇒ ✖ HISTORY_DOES_NOT_REACH_STREET（「请补齐该街剩余的行动」）
```

---

## §2 四种可能性的逐一排除（任务 §一 要求）

| 假设 | 判定 | 证据 |
|---|---|---|
| ① 前端允许错误跳转 | **部分成立 = 缺陷的一环** | `SET_BOARD_CARD` 在「转牌下注未结算」时**被接受**（§6 `ok=true`）；牌槽可随时点击，无任何提示 |
| ② 行动记录没有正确保存 | **排除** | 13 条行动完整落库，最后三条 `FLOP BB CALL 5BB / TURN BB BET 5BB`；`engineViewOf` 能逐条重放并给出正确行动者 |
| ③ 状态重建未正确读取行动 | **排除** | `reconstruct(PREVIEW)` 停在 TURN（真实状态）；`reconstruct(DECISION)` 给出**准确**中文原因（指出缺「庄家位」的行动）。它读对了，只是**拒绝了不可达的目标街** |
| ④ 合法的手动录入模式允许跳过未知历史 | **排除（该模式不存在）** | `ReconstructMode` 只有 `PREVIEW / DECISION / ANALYZE`；严格重放要求历史可达目标街。**没有任何模式**允许「只有河牌局面、没有转牌历史」 |

⇒ 结论：既不是行动丢失，也不是重建读错，**也不是**一个允许跳过的合法手动模式被误当成缺陷。
真正的缺陷是**「当前街」存在三个互不一致的定义，且没有任何一致性闸门或提示**。

---

## §3 根因（三处，按重要性）

### 根因 1（核心）：「当前街」有三个来源，其中一个是「已录公共牌张数的反查」

| 来源 | 位置 | §7 状态下的取值 |
|---|---|---|
| ① **权威状态**（引擎，由行动重放得到） | `engineViewOf` / `reconstruct` | **TURN**（`bettingRoundComplete=false`） |
| ② **声明街**（适配器交给决策管线的 `ManualHandInput.street`） | `tableAdapter.ts:167` `declaredStreetOfBoard(state.board.length)` | **RIVER**（因为牌有 5 张） |
| ③ 界面显示街 | `tablePreview` 用 `engineState.street` | TURN（但**牌面行显示 5 张牌**，使用者读到的是「河牌已发」） |

`declaredStreetOfBoard` 本身是「张数 → 街道」的合法反查（Table Topology Correction 之后的既有设计），
问题在于**它被当作决策管线的目标街**：只要用户录满 5 张牌，决策层就被要求分析河牌，
而历史停在转牌 ⇒ 必然 `HISTORY_DOES_NOT_REACH_STREET`。**「录入牌面」不等于「进入下一阶段」**
（`test/state.test.ts:395` 已把这条契约钉住：**街只由 `advanceStreet` 推进**），
两者被混在一个数字上。

### 根因 2：牌面录入路径没有阶段准入检查（服务端也没有）

- `setBoardCard`（`seatLifecycle.ts:1070-1121`）只校验：槽位范围、必须按顺序填、重复牌、Hero 手牌冲突。
- **没有任何一条**检查「这张牌属于哪一街」与「下注轮是否已经结算」。
- 前端每帧只发 `SET_BOARD_CARD`，服务端 `applyTableOp`（`tableOps.ts:404`）直接转交 ⇒ **前后端都没有闸门**。
- 领域层**有**闸门，但只在 `advanceStreet`（`streetAdvance.ts:56` `STREET_NOT_COMPLETE`），
  而录牌路径**根本不经过** `advanceStreet` ⇒ 闸门被绕过。

### 根因 3：预览层「说可以分析」，决策层却拒绝（同类缺陷的已知形态）

§7 的 `preview.blockers = []`、`preview.decision.ready` 为真（因为按真实状态确实轮到 Hero），
而 `analyzeManualHand` 直接失败 ⇒ 正是项目此前修过的「界面说可以分析、点了却信息不足」形态。
根因是**没有人比较「牌面声明的街」与「行动可达的街」**。

---

## §4 已经正确的部分（不得改坏）

| 机制 | 位置 | 行为 |
|---|---|---|
| 街道推进的完整性守卫 | `streetAdvance.ts:56-65` | `bettingRoundComplete=false` ⇒ `STREET_NOT_COMPLETE`，并说明谁还需要跟多少 |
| 目标街可达性检查 | `reconstruct.ts:588-610` | 逐街推进，失败时给**准确**中文原因（含缺谁的什么行动） |
| 行动者判定在后端 | `tableOps.applyTableAction` | 前端不能指定行动者；金额由引擎算出 |
| 「录牌不推进街道」契约 | `test/state.test.ts:395`、`streetAdvance` 头注释 | 只有 `advanceStreet` 切街发牌 |
| 摊牌不等于跳过发牌 | `streetAdvance.ts:82-101` | 无人可行动 ⇒ 只标记本街结束；公共牌不够则**如实拒绝**，绝不凭空补牌 |

---

## §5 未实现项（本轮不新增，如实标注）

- **手动局面模式（任务 §二.2.B）不存在**：无法「只输入河牌局面 + 底池 + 有效筹码」而跳过此前行动。
  严格模式要求行动可达目标街。⇒ 不存在「把未知行动伪装成已发生」的风险，但用户也没有该入口。
- 若将来新增该模式，必须显式标注缺失信息与能力限制（不得生成伪精确历史范围或 EV）—— 本轮**不实施**。

---

## §6 最小修复方案（不动决策引擎 / 画像 / 剥削 / 底池 / 历史）

**关键设计约束（实测得出）**：不能简单地「未结算就禁止录入更后一街的牌」——
既有数据录入流程是**先把公共牌录完再录行动**（`test/autoAnalyze.test.ts:262-271`：
选 Hero 手牌 → 录 3 张翻牌 → 才录行动）。因此必须区分：

- **「提前录入牌面」**（当前街还没有任何行动）⇒ **允许**（既有契约，不影响任何现有测试）；
- **「当前街已经开打但尚未结算」**（本街已有行动、下注轮未完成）⇒ **禁止录入更后一街的牌**（这就是用户报告的缺陷形态）。

### 修复 1：阶段准入检查（一处规则，服务端强制）

- `tableAdapter.ts` 新增**纯规则** `boardAppendAdmissionOf({ boardCount, engineStreet, engineStreetHasActions, bettingRoundComplete })`
  → `{ allowed, messageZh }`（唯一实现；中文原因写清「当前街 / 还缺谁的行动 / 撤销第几张牌」）。
- `tableOps.applyTableOp` 的 `SET_BOARD_CARD` 分支：**追加新牌**（`slot === board.length`）时调用该规则；
  不满足 ⇒ `fail([...])` 拒绝（前端按钮因此无法绕过；HTTP 路径共用 `applyTableOp`，见 `tableApi.ts:761`）。

### 修复 2：状态冲突提示 + 安全修正入口（预览层）

- `tablePreview`：当「牌面声明的街」**超过**「行动可达的街」且当前街已开打未结算 ⇒
  向 `analyzeBlockers` 写入中文冲突说明（含修正入口：补齐缺失行动，或撤销最后一张牌），
  并令 `decision.ready=false`、`decision.state=ERROR`（**无需改前端**：界面已逐条渲染 blockers）。

### 修复 3：回归测试（8 项，任务 §二.4）

`test/streetAdmission.test.ts`：转牌面对下注禁止录河牌 / 跟注结算后允许 / Hero 加注后对手未回应禁止 /
全员过牌后允许 / Hero 弃牌后不得再以 Hero 身份决策 / 全员全下允许按规则发完剩余公共牌 /
手动局面模式未实现 ⇒ 如实报错且不产生伪 EV / 前端与底层都不能绕过（含冲突已存在时不得继续扩大）。

### 修复 4（不做）

不改 `advanceStreet`、不改 `declaredStreetOfBoard` 的语义、不改决策引擎、不给行动记录补写任何东西、
不自动扣筹码、不自动删牌（冲突状态只提示 + 提供撤销入口）。

---

## §7 V2 复审：上一轮修复为何打断 4 个既有测试（本轮新增，**未实施任何生产改动**）

### §7.1 逐项核对（任务 §二）

| 测试 | 对应的真实状态（已核实部分） | 上一轮规则为何拒绝 |
|---|---|---|
| `§D-4`「公共牌给满时，关掉下注轮只推到翻牌」 | `buildDivergenceTable(['Ah','7c','2d','Ks','9h'])` ⇒ **先把 5 张公共牌全部录入**，再跑 `SCENARIO` 行动；断言引擎停在翻牌、转牌/河牌未发 | 属于「先录牌、后录行动」的**合法录入顺序**；上一轮规则 ⑥ 在「本街已有行动且未结算」时禁止再录更后一街的牌 |
| `§E-3`「全员全下 + 公共牌 5 张 ⇒ 一路发到河牌之后才进摊牌」 | 全员全下（后续**无下注义务**）但公共牌是**先录满**的 | 同上：规则 ⑥ 只看「本街已有行动 ∧ 未结算」，**没有区分「无人可行动」**（全下场景下 `bettingRoundComplete` 的时序与录牌顺序耦合） |
| `§E-4`「反证：公共牌只有 4 张时河牌不得被发出来」 | 同上，边界为 4 张 | 同上 |
| `AUTO-3`「Hero=CO 拿完牌但前位未行动」 | 待行动玩家是**前位（非 Hero）** | 规则 ⑥ 只看「本街有行动 ∧ 未结算」，**没有把「pending actor 是不是 Hero」作为判据** |

**共性结论（这就是上一轮失败的根本原因）**：规则 ⑥ 的判据选错了。
「本街已有行动且未结算」这一条**既覆盖不了用户报告的缺陷**（它需要「欠行动的是 Hero 本人」），
又**过度命中**既有契约（先录牌顺序 / 全下 / 非 Hero 待行动）。

### §7.2 V2 拟采用的规则（**设计，待授权实施**）

在**同一处**服务端入口（`tableOps.applyTableOp` 的 `SET_BOARD_CARD` 追加分支）实现，
复用既有 `actorOnTurn` / `deriveLegalActions` 判定，不新增第二套街道状态：

| 规则 | 判据（全部满足才生效） | 行为 |
|---|---|---|
| **A（唯一拦截）** | 追加后的张数构成更后一街 ∧ 引擎当前街**已结算为假** ∧ **本街已有行动** ∧ **`actorOnTurn(engine) === Hero 本人`**（未全下、未弃牌、确有合法动作） | **拒绝**该次录牌，中文原因指明「Hero 还有未处理的决策」+「撤销第 N 张」 |
| **B** | 更后一街 ∧ 本街未结算 ∧ 待行动是**其他玩家** | **允许录牌**；保留真实行动进度；预览层如实提示冲突，不标记 ready |
| **C** | 本街已结算（含**全员全下**、无人可行动） | 允许继续发牌（§D-4/§E-3/§E-4 契约不变） |
| **D** | 牌面声明的街 > 行动可达的街 | 预览 `ready=false` + 复用既有 RECONSTRUCT 文案（**不新建第二套提示**）；保留已录公共牌 |

**判据要点**：「是不是 Hero 本人」必须由**引擎重放**得到（`playerById(engine, actorOnTurn(engine)).position === heroPosition`），
**不得**用前端缓存、`board.length` 或座位状态推断；Hero 已全下/已弃牌时该规则**不生效**。

### §7.3 本轮新增的 12 项回归测试规格（**已列，未提交代码**）

1. Hero 转牌面对下注未行动 ⇒ 录河牌被拒（含中文原因与撤销入口）
2. Hero 跟注且本街**真正结算** ⇒ 允许录河牌且引擎真的进入河牌
3. Hero 加注后对手未回应 ⇒ 河牌不得标记为「正式可分析」（预览 ready=false）
4. Hero 已完成、**其他玩家未完成** ⇒ 不得错误推进下注轮（引擎街不变）
5. 所有人过牌完成 ⇒ 允许进入下一街
6. 全部剩余玩家全下且无后续下注 ⇒ 允许连续发出剩余公共牌
7. **部分**玩家全下、其他人仍有行动义务 ⇒ 不得错误结算
8. 既有「先录牌、后补录行动」顺序**必须保留可用**（禁止靠删除该能力取得通过）
9. Hero 弃牌后不得再以 Hero 身份生成决策
10. 牌面与行动历史已冲突 ⇒ 预览提示冲突、`ready=false`、不输出伪精确 EV
11. 前端路径与**直接调用 `applyTableOp`** 得到相同准入结果（唯一入口 `tableApi.ts:761`）
12. 重复录牌 / 修改已录牌 / 撤销（UNDO）不得破坏一致性

**状态**：本轮**未实施**生产改动（上一轮修复已完整撤回，工作区与 `HEAD=bc56191` 逐字节一致，
`npm run verify` = 2072/2072 通过）。上述规则与测试规格保留为下一轮的施工图，等待授权。

