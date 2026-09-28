# 牌力档提示（UI）—— 交付状态与验证清单

> ## ✅ **已交付并验证通过（2026-09-28）**
>
> | 验证项 | 结果 |
> |---|---|
> | `npx tsc --noEmit` 类型检查 | ✅ **零错误** |
> | 全量测试 | ✅ **2,332 / 2,332 / fail 0**（含本功能新增 7 条） |
> | 产物清单 | ✅ 已重新生成（`npm run manifest`） |
> | 测试文件数断言 | ✅ 128（已同步 `CURRENT_PROJECT_STATUS.md`） |
> | **界面实际显示** | ✅ **使用者确认可见**（绿框 + 牌力档 + 信任结论） |
>
> **过程中踩到的唯一实质缺陷**：见 §7 —— 本块最初**不在 `compactResult` 的白名单里**，
> 于是被静默搬进折叠区，界面上看起来「功能没生效」。
> 数据链路全程是对的，只是**不在可见区域**。

> ## ⚠️ 开发期间的构建环境说明（留档）
>
> 开发过程中本机 `pwsh`（PowerShell 7）**进程启动即崩**：
>
> ```text
> Process terminated.
> Encountered infinite recursion while looking up resource 'Arg_AccessViolationException'
> in System.Private.CoreLib.
>    at System.Diagnostics.Tracing.EventSource.InitializeDefaultEventSources()
> ```
>
> 崩点在 .NET 运行时的 **EventSource 初始化**里 —— 即 **`pwsh` 还没开始执行任何命令就死了**，
> 所以 `tsc --noEmit` / `npm test` / `npm run verify` **一次都没跑成**。
> 换命令、重试多次均无效（这是主机侧问题，不是命令问题）。
>
> **因此下面的代码是「逐字人工核对」的产物，不是「跑通了」的产物。**
> 环境恢复后请按 §4 的清单验证；若报错，按 §5 的风险表定位。

---

## 1. 做了什么（使用者要求：一眼看出要不要信引擎的建议）

在「当前建议」面板的**动作正下方**、其它信息之前，加一块牌力档 + 信任结论：

```text
建议：跟注
┃ 强牌（坚果级价值，强度 0.92）              ← 绿框
┃ ✅ 可以信 —— 这手牌靠权益赢，不靠对手弃牌
```

三档 = 三档可信度：

| 框色 | 牌力档 | 结论 |
|---|---|---|
| 🟢 绿 | **强牌**（坚果级价值 / 强价值） | ✅ 可以信 —— 利润来自**摊牌权益**（数学） |
| 🟡 黄 | **中等牌**（中等价值 / 薄价值 / 抓诈牌 / 摊牌价值） | ⚠️ 打折看 |
| 🔴 红 | **弱牌 / 听牌**（听牌 / 半诈唬 / 纯诈唬 / 空气） | ❌ 最不可信 —— 几乎全靠**弃牌率** |

## 2. 这个映射的依据（不是 UI 偏好，是实测结论）

`reports/REAL_HAND_VALIDATION.md` §6 实测：引擎预测的弃牌率**系统性偏高**
（预测 65–75% vs 真实 `fold-to-flop-bet` **51.6%**），且**几乎没有分辨力**
（与真实弃牌的相关系数 **r ≈ −0.03**）。

**这个偏差只落在依赖弃牌率的建议上** ⇒ 于是「该不该信」可以由牌力档推出：

> 引擎唯一被证伪的模块是**弃牌率**；强牌不依赖它，弱牌几乎全靠它。

## 3. 改了哪些文件

| 文件 | 改动 |
|---|---|
| `src/viewmodels/handStrengthHint.ts` | **新增**：`RelativeHandRole` → 牌力档 + 信任等级 |
| `src/viewmodels/decisionViewModel.ts` | 视图模型新增 `handStrengthHint` 字段（**加法**，不改既有字段） |
| `src/app/web/table.js` | 在 `#resultAction` 之后渲染该区块 |
| `src/app/web/table.css` | 三档配色样式 |
| `test/handStrengthHint.test.ts` | **新增** 7 条回归锁 |

**没有动引擎**：不碰 `decisionEngine` / `responseTendenciesOf` / 任何策略数学。
数据全部来自**领域层已有的** `d.postflop.handRole` 与 `roleStrength`。

## 4. 环境恢复后的验证清单（按顺序）

```powershell
cd D:\德州

# ① 类型检查（最关键 —— 我在无法编译的情况下写的代码）
npx tsc --noEmit

# ② 新功能的 7 条回归锁
node --experimental-strip-types --test test/handStrengthHint.test.ts

# ③ 新增文件 ⇒ 产物清单必须重生成（否则 manifest:check 会失败）
npm run manifest

# ④ 全量
npm run verify

# ⑤ 重启牌桌服务（**服务端代码是启动时加载的，必须重启**）
#    前端 table.js / table.css 是每次请求从磁盘读的（webServer.ts 的 readAsset），刷新即可
node --experimental-strip-types src/app/webServer.ts
# 然后打开 http://127.0.0.1:5173/ ，录一手翻后牌局，看建议下方有没有那块
```

## 5. 剩余风险（我已核对 / 未核对）

### 5.1 已逐项核对（**每一项都对照了源码定义处，不是凭印象**）

| 项 | 怎么核的 | 结果 |
|---|---|---|
| `RelativeHandRole` 10 档键名与中文 | 对照 `domain/postflop/types.ts:63-74` 逐档 | ✅ 一致 |
| `RELATIVE_ROLE_ZH` 是否单一来源 | 本模块 **import** 领域层那一份 | ✅ **不复制**，无"同一事实两处各算一次" |
| `d.postflop.handRole` / `roleStrength` 真存在吗 | `decisionViewModel.ts:540` **本来就在读**这两个字段 | ✅ 存在 |
| `d.postflop` 是否可选 | `decision.types.ts:1390` 是 `postflop?:` | ✅ 我的 `=== undefined` 判断**必要**，不是多余 |
| `handStrengthHint` 属性名前后端一致 | 后端 `decisionViewModel.ts:1464` ↔ 前端 `table.js` 读取处 | ✅ 一致（JSON 序列化保持 camelCase） |
| `el(tag, className, text)` 签名 | `table.js:159` | ✅ 我的三参数用法正确 |
| CSS 变量 `--muted` / `--accent` 是否存在 | `table.css:31-32` | ✅ 都存在 |
| 新增字段会不会打破既有构造点 | 全仓搜 `DecisionViewModel` 字面量 | ✅ **只有一个构造点**（`toDecisionViewModel`），加必填字段安全 |
| 测试文件 5 个导入名是否都被导出 | grep 两个模块的 `export` 行 | ✅ 全部导出（含 const/type 同名对） |
| 本模块 6 个导出名与测试引用是否一致 | grep `^export (const\|type\|function)` | ✅ 一致 |

### 5.2 ✅ 又核销三项「会拦住你」的风险（本轮补充）

| 风险 | 怎么核的 | 结论 |
|---|---|---|
| **有没有测试对视图模型做整体形状深比较** | 搜 `deepEqual(…viewModel…)` | ✅ 只有**字段级**比较（`reasonsZh`/`warningsZh`，`alphaWebServer.test.ts:235-236`）⇒ 加字段不破坏 |
| **新增 3 个文件会不会让 `manifest:check` 报错** | 读 `src/infra/artifactManifest.ts:218-230` 的 `UNLISTED` 分支 | ✅ **不会**：它只查「定义表有、清单没有」，**不查**反方向 |
| **清单测试是否要求登记每个源文件** | 读 `test/artifactManifest.test.ts:259/271` | ✅ **不要求**：只查「六类都有」+ 4 个硬编码文件 |

⇒ 因此 `manifest:check` **只会**因我改动的**已登记文件**报 `CHANGED`：
`src/viewmodels/decisionViewModel.ts`、`src/app/web/table.js`、`src/app/web/table.css`。
**`npm run manifest` 一次解决。**

### 5.3 ❌ **仍未验证**（环境所限，无法静态替代）

| 项 | 为什么静态核不出来 |
|---|---|
| **`tsc --noEmit` 能否通过** | 唯一能确定类型正确性的手段。我做了逐行审查，但审查 ≠ 编译 |
| 界面实际渲染效果 | 需要浏览器；`pwsh` 崩 ⇒ 服务也无法重启加载新代码 |
| 7 条回归锁是否全绿 | 需要跑 Node 测试 runner |

### 5.4 一处我自己写错、已更正的注释（留档）

我最初在 `ROLE_TO_TIER` 上写了一句「漏一档会在 TS 层报错」。**那是假的** ——
为了让入参接受快照层放宽后的 `string`，键类型必须是 `string`，**TypeScript 不会**因漏档报错。

已改成如实说明：**「10 档全覆盖由测试 `H4` 保证，不由类型保证」**，
避免后人看到那句注释就以为有编译期保护。

### 5.5 ✅ 已登记进产物清单（2026-09-28 完成）

`src/viewmodels/handStrengthHint.ts` **已登记**进 `src/infra/artifactDefinitions.ts`
（`category: DECISION`，紧挨 `decisionViewModel.ts`）。

**为什么一个纯展示文件值得登记**（这是登记与否的真正判据）：

它**不改变任何引擎决策** ⇒ 进不了任何 EV、也进不了决策类测试的判据。
但它会改变**界面对「这条建议能不能信」的表述**，而使用者据此决定是否照做。

> 改错那张映射（例如把 `PURE_BLUFF` 划进「✅ 可以信」）的后果是：
> **引擎建议完全不变、测试也不一定拦得住、但界面在说谎。**

这是本功能**唯一**能造成的伤害，而它不体现在任何数值上 ——
所以只能靠清单把「改这个文件意味着什么」显形。

登记后 `manifest:check` 会打印：

```text
影响：牌力档 → 「这条建议该不该信」的映射变化（相对牌力角色 → 强/中/弱 + 信任等级）
     → **不改变任何引擎决策，但会改变界面对「这条建议能不能信」的表述**；
     映射写错会让使用者照着一个错误的「可以信」下注
```

**未登记** `test/handStrengthHint.test.ts` —— 它是**冗余的**：
测试文件的增删已由 `test/projectStatus.test.ts` 的
「测试文件数必须与实际一致」断言守住（本次已触发并同步过一次）。

### 已知的一处类型放宽（本功能的防御点）

`PostflopDecisionSnapshot.handRole` 在快照层被**放宽成了 `string`**
（`domain/decision/decision.types.ts:467`），而它真正的来源是精确的
`RelativeHandRole`（`app/decision/postflopAdvisor.ts:158`）。

**处理方式**：**不改引擎契约**（那会让类型风险外溢到决策层），
改为在展示层做**运行时白名单校验**（`KNOWN_ROLES`）：
不认识的角色 ⇒ 返回 `null` ⇒ 界面显示「—」，**绝不猜一个信任等级**。

> 为什么这条重要：将来若引擎新增了角色而忘了在这里登记，
> 失效方式是「不显示」，**不是**给人一个错误的「可以信」——
> 后者会让使用者照着一个错标签下注。
> 回归锁 `H5` 专门锁这个行为。

## 6. ✅ 类型检查已通过（2026-09-28）

`npx tsc --noEmit` **零错误**。此前"在没有编译器的情况下写了约 150 行 TypeScript"
这个最大风险已核销。

---

## 7. 🔴 交付过程中唯一的实质缺陷：**被折叠，而不是没生效**

### 现象

功能上线后使用者报告「没出现」。当时的排查方向**全部猜错**：
先后怀疑「后端没发字段」「服务没重启」「浏览器缓存」——
实际上 **`Cache-Control: no-store` 已禁用缓存，后端数据也是对的**。

### 根因

`src/app/web/table.js` 的 `compactResult(box, a)`（**快速录入模式的紧凑渲染**）里有一份白名单：

```javascript
var keep = ['resultAction', 'resultMeta', 'resultReasons'];
Array.from(box.children).forEach(function (n) {
  if (keep.indexOf(n.id) < 0) details.appendChild(n);   // ← 不在名单里就搬进折叠区
});
```

新块 `id='resultHandStrength'` **不在名单里** ⇒ 被搬进折叠的
「收益、范围与完整依据」`<details>` ⇒ **界面上看不见**。

### 为什么这个 bug 特别有迷惑性

- DOM 里**节点存在**；
- 数据**完全正确**（后端确实发了 `handStrengthHint`）；
- 界面**渲染成功**、无任何报错；
- **只是不在可见区域。**

于是「功能没生效」和「功能生效但藏起来了」在外部表现上**完全一样**。

### 修法

把它加进白名单（`table.js` 的 `compactResult`）：

```javascript
var keep = ['resultAction', 'resultMeta', 'resultReasons', 'resultHandStrength'];
```

**理由**：它是**判断依据**，不是**补充披露**。使用者要先知道「这条建议能不能信」，
才决定要不要展开看后面的理由 —— 折叠它等于**把最关键的一条藏起来**。

### 判据（写给下一次）

> 当「**数据存在**」与「**界面不显示**」同时成立时，
> **先查展示层的可见性逻辑**（白名单 / 折叠 / `display:none` / 被搬走），
> 再怀疑数据链路。

本次的转折点是使用者那张截图 —— 里面**已经显示出来的**
「相对牌力角色「坚果级价值」（强度 1.00）」证明**后端是对的**。
我本该在看到那张图时立刻转向展示层，而不是继续怀疑后端与服务。
