# 工作区损坏事故报告（工具误用导致，**需要人工恢复**）

> 状态：**已停止一切修改**。产品当前**无法通过类型检查（965 个语法错误）**，无法运行。
> 除下列两个文件外，工作区**其余文件均未被该命令触及**（同一命令只写了这两个路径）。

## 1. 发生了什么（准确命令）

为了把 `heroFourBetSupported` 改成三态（`boolean | null`），我用 PowerShell 做了**就地文本替换**：

```powershell
$p='src/app/decision/decisionEngine.ts'
(Get-Content $p -Raw) -replace '…' -replace '…' | Set-Content -NoNewline -Encoding utf8 $p
$q='src/domain/decision/decision.types.ts'
(Get-Content $q -Raw) -replace '…' | Set-Content -NoNewline -Encoding utf8 $q
```

**根因**：这两个文件是**无 BOM 的 UTF-8**，而本机控制台代码页是 **GBK(936)**。
`Get-Content -Raw` 按 GBK 解码 ⇒ 中文全部变成乱码字符；`Set-Content -Encoding utf8` 再把乱码写成 UTF-8。
更严重的是：GBK 是双字节编码，解码时**把部分换行/引号字节当成汉字的第二字节吃掉了**
⇒ 不只是文字乱码，**换行本身丢失**，文件结构被破坏。

**我的第一次抢救是错的**：我先用「GBK 重新编码」去反转它 —— 那一步把文件变成**GBK 字节**（不再合法 UTF-8，
`tsc` 报 `File appears to be binary`）。随后我用「GBK 解码」退回**乱码但合法 UTF-8**的状态，
`U+FFFD` 已归零，但**丢失的换行无法恢复**。

## 2. 损坏量化（实测）

| 文件 | 损坏前行数 | 当前行数 | 丢失行数 | 当前状态 |
|---|---|---|---|---|
| `src/app/decision/decisionEngine.ts` | 3622 | 3150 | **-472** | 965 个语法错误中的绝大多数；17 行超长（最长 552 字符，换行被吞） |
| `src/domain/decision/decision.types.ts` | 1700 | 1293 | **-407** | 21 行超长（最长 730 字符） |

（损坏前行数取自本会话早前对这些文件的读取输出：`of 3622` / `of 1700`。）

## 3. 已排除的恢复途径（都试过了）

| 途径 | 结果 |
|---|---|
| `git stash list` | 空 |
| git 索引版本 | 索引 blob == HEAD blob（`dbef846f…` / `583be836…`）⇒ 未暂存过，无法从索引恢复 |
| 工作区备份（`*.orig` / `*.bak` / `*.rej`） | 无 |
| 其它副本（按特征串 `allInGuardVerdictOf` 全盘搜索，排除 node_modules/.git） | 只有本文件与两个测试文件 |
| `%TEMP%` 下更早的完整副本 | 无（只有我抢救时另存的**损坏**副本） |

**损坏副本已保全**（供人工比对/取证，未被继续改动）：
`C:\Users\16584\AppData\Local\Temp\dsh-corrupt-20260919-165619\{decisionEngine.ts,decision.types.ts}`

## 4. 恢复选项（需人工裁决，我不再自行尝试）

| 选项 | 做法 | 代价 / 风险 |
|---|---|---|
| **A（推荐）** | 从**任何外部备份**恢复这两个文件：IDE 本地历史（VS Code/WebStorm Local History）、Windows「以前的版本」/文件历史、云同步（OneDrive 等）、或另一份检出/压缩包。恢复后我**按清单重贴**本会话对这两个文件的全部改动 | 前提是存在备份；重贴改动是机械工作，我可以逐条给出 old/new 字符串 |
| **B** | 无备份时，由我**重建**这两个文件：以 HEAD 版为骨架 + 按 `reports/`、`test/` 与本次会话记录**重新实现**各轮改动（U1 资金口径、披露层、P1-2a、P1-4、BET 尺寸一致性、P1-2b） | 工作量大；**注释与论证文字只能重写而非逐字还原**；行为细节可能丢失，需要按测试逐条对齐（1968 项测试是可用判据） |
| **C** | `git checkout -- <这两个文件>`（回到 HEAD） | **不建议**：会一次性丢弃这两个文件里**所有轮次**的未提交工作（U1 全套、P1-2a/P1-4、BET 一致性…），且这些改动没有其它记录可完整重建 |

## 5. 当前事实清单（供裁决参考）

- **受影响**：仅 `decisionEngine.ts` 与 `decision.types.ts`
- **未受影响**：`contextBuilder.ts`、`raiseResponse.ts`、`betResponse.ts`、`postflopAdvisor.ts`、
  `legalActions.ts`、全部测试、全部脚本、全部报告与证据、`data/artifact-manifest.json`
- **本阶段（P1-2b）在损坏前的完成度**：13 项测试全绿；但**这些改动有一部分在这两个被损坏的文件里**
  （`raiseEVOf` 的调用、诊断搬运、`candidatesForDecision`、`heroFourBetSupported` 三态…）
- **本会话对这两个文件的全部改动清单**（选项 A 恢复后可按此重贴）：
  1. `decisionEngine.ts`：`allInGuardVerdictOf` 的调用与 `raiseShape` 资金字段；
  2. `decisionEngine.ts`：`raiseModelUsable` 的 `CASHFLOW_CONTRACT` 硬门槛 + `RAISE_EV_SIZE_MISMATCH` / `RAISE_EV_CASHFLOW_CONTRACT_REJECTED`；
  3. `decisionEngine.ts`：`RAISE_MODEL_EV` / `RAISE_MODEL_EV_LOSES` 两条理由路径 + `MATH_CALL_SUPPORTED` 作用域声明；
  4. `decisionEngine.ts`：`unevaluatedActions` 跳过「有自有 EV 的尺寸」+ `raiseSizesWithOwnEV`；
  5. `decisionEngine.ts`：`postflopSnapshotOf` 里加注事实的全部新字段搬运（多次增补）；
  6. `decisionEngine.ts`：`candidatesForDecision`（把被评估的下注金额补进候选）+ 两处引用替换；
  7. `decisionEngine.ts`：被再加注分支字段（`reraiseBranchEV` 等）与 `heroFourBetSupported` 三态；
  8. `decision.types.ts`：`BettingRangeFactsSnapshot` / `PostflopFacts` 的加注事实类型扩展（多轮）；
  9. `decision.types.ts`：`allInGuard.raiseSizesWithOwnEV`；`decisionMargin` 相关注释未改。

**在人工恢复之前，我不会再对这两个文件做任何写入。**
