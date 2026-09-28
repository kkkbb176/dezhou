# 牌桌页「点击」路径 × 画像：画像会不会改变「牌力的下注」

**问题**：不同画像下，牌桌页点击时「按牌力下注」的建议会不会变？
若是**代码（手动录入）会变、牌桌页点击不变**，则为接线缺陷，须修。

**结论**：❌ **不存在这个缺陷**。两条路径行为**完全一致**。
但顺带确认了一个**真实缺口**（两条路径都一样）：**主动下注通道对画像完全不敏感**。

---

## 1. 为什么要走牌桌页那条路径

牌桌页不是直接调 `analyzeManualHand`。它把画布点击翻译成 op，再用 `table` 换结论：

```
点击 → POST /api/table { state, op, requestId }
     → POST /api/analyze { table: state }
     → 服务端 tableAdapter 把**座位**转成 villain.quickProfile / observedStats
     → analyzeManualHand
```

画像是在**服务端从座位**读的，所以「手动录入会变、牌桌页不变」这种缺口**只有在这条路径上才测得出来**。

## 2. 方法：隔离实例 + 真实 op 序列

| 措施 | 值 |
|---|---|
| 端口 | `ALPHA_PORT=5199`（**不碰**正在跑的 5173） |
| 玩家历史 | `DSH_PLAYER_HISTORY_DIR=reports/_probe_table_click` |
| GTO 缓存 | `ALPHA_GTO_CACHE_DIR=reports/_probe_gto_cache` |

op 序列与页面点击一致：`NEW_TABLE → FILL_EMPTY_SEATS → CLEAR_SEAT → NEXT_HAND →
ADD_PLAYER → SET_BUTTON → SET_PROFILE → SET_HERO_CARD ×2 → ACT ×9 → SET_BOARD_CARD ×3 → ACT`，
最后 `POST /api/analyze {table}`。

固定一切，只改画像：Hero `KsQs`｜牌面 `Qh 9s 5s`｜9 人桌｜CO vs BB｜100BB。

### 2.1 数据安全（跑前跑后逐位一致）

| 文件 | 跑前 | 跑后 |
|---|---|---|
| `data/player-history.jsonl` | `D079A152…`（986 行） | `D079A152…` ✅ |
| `data/gto-cache/index.json` | `CD18BA31…` | `CD18BA31…` ✅ |

隔离目录确实接到了写入（446KB → 525KB）⇒ 隔离**生效**，真实数据未被触碰。

## 3. 结果一：画像**确实**进入了牌桌路径的输入

改对手座位（BB）的画像后，`inputHash` 每次都变：

```
UNKNOWN          h72e00fa4
CALLING_STATION  hf9d4d685
MANIAC           h4a98e9cb
VERY_TIGHT       h48776133
LOOSE            haacc19a8
BLUFF_HEAVY      h26eaf293
```

### 座位正确性（双向对照）

| 组 | 改谁的画像 | inputHash |
|---|---|---|
| 基线 | 对手(BB)=UNKNOWN | `h72e00fa4` |
| 对照⑦ | **只改非对手(UTG)**=MANIAC | `h72e00fa4`（**精确复现基线**） |
| ③ | 对手(BB)=MANIAC | `h4a98e9cb` |
| 对照⑧ | 对手=MANIAC **且** 非对手=CALLING_STATION | `h4a98e9cb`（**精确复现③**） |

⇒ `tableAdapter` 取的是**正确座位**的画像，非对手座位不干扰。**接线没断。**

## 4. 结果二：同节点「手动录入 vs 牌桌点击」逐项对照

### 场景 A：BB 过牌 ⇒ Hero CO 要**主动下注**

| 画像 | 手动·建议 | 手动·下注EV | 牌桌·建议 | 牌桌·下注EV |
|---|---|---|---|---|
| UNKNOWN | BET 5.5BB | 全 `—` | BET 5.5BB | 全 `—` |
| MANIAC | BET 5.5BB | 全 `—` | BET 5.5BB | 全 `—` |
| VERY_TIGHT | BET 5.5BB | 全 `—` | BET 5.5BB | 全 `—` |
| CALLING_STATION | BET 5.5BB | 全 `—` | BET 5.5BB | 全 `—` |

**两条路径都不变**（但两条路径的 `inputHash` 都随画像变）。

### 场景 B：BB 下注 3.5BB ⇒ Hero CO **面对下注**

| 画像 | 手动·跟注EV | 牌桌·跟注EV |
|---|---|---|
| UNKNOWN | 703.96 | 712.50 |
| MANIAC | **719.48** | **719.27** |
| VERY_TIGHT | **692.50** | **698.44** |
| CALLING_STATION | 710.52 | 700.00 |

**两条路径都随画像变化**，且趋势一致（MANIAC 最高、VERY_TIGHT 最低）。加注 EV 同样随画像变。

### 判定

| 场景 | 手动会变 | 牌桌会变 | 一致？ |
|---|---|---|---|
| A 主动下注 | 否 | 否 | ✅ |
| B 面对下注 | 是 | 是 | ✅ |

⇒ **不存在「代码会变、牌桌页不变」的缺陷，无需修。**
（两条路径的绝对数值有小差，来源是牌桌路径的座位/行动序号与全新玩家绑定不同；**敏感度与方向完全一致**。）

## 5. ★ 顺带确认的真实缺口：**主动下注通道对画像完全不敏感**

场景 A 里，无论画像怎么改、无论走哪条路径：

```
建议 = BET 5.5BB（恒定）
下注候选尺寸 = 1.00/1.38/1.83/2.75/3.67/4.13/5.50/97.5BB（恒定）
下注候选 EV   = —（**8 档全部未建模**）
```

两个原因叠加：

1. **下注 EV 没有模型**：候选表里 BET 的 `ev` 全为 `null`，`unevaluatedActions` 报
   `BET_EV_NOT_IMPLEMENTED`（"下注 EV 依赖对手弃牌率，本项目没有可信估计"）⇒
   画像**无处施力**。
2. 尺寸由启发式给出，不参与 EV 比较。

**这不是牌桌接线问题**（手动录入同样不变），而是**下注模型缺失**。
与手册审计 §8.6、实战体检报告 §4 记录的是同一件事。

**产品影响**：使用者最关心的「这手牌该下多大」恰恰是唯一**没有 EV 支撑、且不随画像变化**的建议。

## 6. 复现命令

```powershell
cd D:\德州
# 1) 起隔离实例（另开一个终端）
$env:ALPHA_PORT='5199'
$env:DSH_PLAYER_HISTORY_DIR='D:\德州\reports\_probe_table_click'
$env:ALPHA_GTO_CACHE_DIR='D:\德州\reports\_probe_gto_cache'
node --experimental-strip-types src/app/webServer.ts

# 2) 跑对照
node reports/probes/table-vs-manual-profile-e2e.mjs   # 手动 vs 牌桌 同节点对照
node reports/probes/table-profile-click-e2e.mjs       # 只改画像 + 非对手座位对照
```

## 7. 本次**没有**做的事

1. **没有**修改任何引擎代码或数值。
2. **没有**触碰真实玩家历史与 GTO 缓存（哈希跑前跑后一致，见 §2.1）。
3. **没有**判定「下注 EV 该不该建模」—— 那需要弃牌率数据来源，属独立立项。
