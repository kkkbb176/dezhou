# WORKSPACE_RECOVERY_SEARCH — A

> 只读搜索轮。**未恢复任何文件、未修改任何产品代码、未执行任何 git 回退/清理。**
> 唯一写入：本报告（新文件）。
> 已读取：`reports/INCIDENT_WORKSPACE_CORRUPTION.md`（事故现场、时间、9 组改动清单）。

---

## 1. 事故现场（本轮实测，未改动）

| 文件 | 字节 | 行数 | mtime | SHA-256 |
|---|---|---|---|---|
| `src/app/decision/decisionEngine.ts` | 208,133 | 3,150 | 2026-09-19 16:56:06 | `142403758bd8657ed2ebc0a4eed7ce7fa6e1541b802f402c72f590a7e99de64e` |
| `src/domain/decision/decision.types.ts` | 99,107 | 1,293 | 2026-09-19 16:56:06 | `a733d61b981f2c718b0cbd8002eb5b0322c6728ffa21a60386df6249830f1293` |

- 当前状态：合法 UTF-8（`U+FFFD` 已归零）但**中文乱码 + 换行丢失**；`tsc --noEmit` 报 **965 个语法错误**。
- 损坏前：3,622 行 / 1,700 行 ⇒ **各丢失 472 / 407 行**。
- 损坏副本（我早前抢救前另存）：`C:\Users\16584\AppData\Local\Temp\dsh-corrupt-20260919-165619\`，**未被本轮触及**。

---

## 2. 已检查的恢复来源（逐项）

| 来源 | 结论 | 证据 |
|---|---|---|
| **VS Code History** | **不存在（IDE 未安装）** | `%APPDATA%\Code`、`Code - Insiders`、`VSCodium` 三者 `Test-Path = False` ⇒ 无 `User\History` |
| **VS Code Backup / Hot Exit** | **不存在** | `%APPDATA%\Code\Backups` = False |
| **JetBrains Local History** | **不存在（IDE 未安装）** | `%APPDATA%\JetBrains`、`%LOCALAPPDATA%\JetBrains`、`~\.WebStorm*`、`~\.IntelliJIdea*` 全部 False |
| **Windows File History** | **不存在** | `%LOCALAPPDATA%\Microsoft\Windows\FileHistory` = False |
| **Windows 卷影副本（VSS）** | **不存在** | `vssadmin list shadows` 无任何条目输出 |
| **系统还原点** | **不存在** | `Get-ComputerRestorePoint` 为空 |
| **其他 Git Worktree** | **不存在** | `git worktree list` 仅主工作区 `D:/德州决策 a914f9c [main]`；项目内无 `.worktrees`/`backup` 类目录 |
| **提示的两个路径** | **不存在** | `D:\德州-v21-audit-snapshot` = False；`D:\德州-worktrees` = False |
| **历史项目副本（全盘按文件名）** | **不存在** | `D:\` 与 `C:\Users\16584`（深度 6）搜索 `decisionEngine.ts` / `decision.types.ts` ⇒ **仅命中受损的两个文件本身** |
| **同盘其他「德州」目录** | **无关项目** | `D:\德州GTO` = GTOpen 求解器（Rust：crates/target/saves，无 `src/app/decision`）；`D:\德州资料库` = 无任何 `.ts` |
| **云同步** | **不存在** | 项目路径不含 OneDrive；项目内无 `.onedrive/.dropbox/.baidu/.nutstore` 标记（D:\ 根有百度网盘客户端目录，但与本项目无关） |
| **压缩包备份** | **不存在** | D:\ 根、Desktop、Documents、Downloads（深度 2、>1MB）的 zip/7z/rar 全部为无关内容（浏览器插件、RiverSolver、TexasHoldemSolverJava、JDK src、某 App 版本包…） |
| **回收站** | **不存在** | `D:\$Recycle.Bin` / `C:\$Recycle.Bin` 中无 >50KB 的 `.ts` |
| **编辑器临时/自动保存文件** | **不存在** | 项目内无 `*.ts~` / `*.swp` / `*.tmp` / `*.autosave` / `*.orig` / `*.bak` / `*.rej` |
| **DSH 会话/存储目录（用户清单外，我额外查的）** | **无源码内容** | `~\.dsh\{sessions,storages}` 共 17 个文件 / 38.8 MB，搜 `allInGuardVerdictOf`、`raiseSizesWithOwnEV` ⇒ 无命中 |
| **`%TEMP%` 下的工具输出/调度文件** | **无源码内容** | 全量搜索特征串 ⇒ 唯一命中是我自己另存的**损坏副本** |

**未检查（NOT_CHECKED）**：无。
（补充说明：`D:\德州-recovery\` 目录**未能创建** —— `New-Item` 返回 `Access to the path '德州-recovery' is denied`，D:\ 根目录对本进程不可写；因未找到任何候选文件，该目录也无内容可放。）

---

## 3. 找到的候选版本

```text
decisionEngine.ts

候选路径：   （无）
备份时间：   —
行数：       —
SHA-256：    —
完整性：     —
缺失修改：   —
```

```text
decision.types.ts

候选路径：   （无）
备份时间：   —
行数：       —
SHA-256：    —
完整性：     —
缺失修改：   —
```

⇒ **本轮未找到任何候选版本**（事故前或较旧的项目副本都不存在）。上一轮事故报告 §4 的「选项 A（从外部备份恢复）」在本机**没有可用来源**。

---

## 4. 恢复风险

| 风险项 | 结论 |
|---|---|
| 候选是否来自错误项目/其他 Worktree | 无候选 ⇒ 不适用（已排除 `D:\德州GTO` 为无关仓库） |
| 两文件是否属于不兼容的不同版本 | 无候选 ⇒ 不适用 |
| 编码是否完整、是否仍有隐藏乱码 | 当前两文件：合法 UTF-8 但**乱码 + 结构性换行丢失**，**不可作为恢复源** |
| 是否遗漏大量未提交修改 | **是**：这两个文件承载**全部轮次**的未提交工作（U1 全套 / P1-2a / P1-4 / BET SIZE / P1-2b），HEAD 版完全没有这些内容 |
| 是否误把损坏副本当备份 | 风险已隔离：损坏副本只存在于 `%TEMP%\dsh-corrupt-20260919-165619\`，**未**放入任何名为 recovery/backup 的目录 |
| 是否存在同名但更旧的文件 | 全盘搜索**没有**任何同名文件 |
| 是否有未保存到磁盘的编辑器内容 | 无编辑器在运行该项目（VS Code / JetBrains 均未安装） |
| 恢复操作是否可能覆盖其他会话正在修改的文件 | 本轮未做任何恢复、未写入项目任何源文件；工作区状态与事故后一致 |

---

## 5. 建议恢复方式

```text
A4 = 没有找到可靠备份，需要人工授权重建
```

**理由**：13 类来源全部为「不存在/无内容」，且不存在任何项目副本或历史快照。
**若你（或另一台机器、聊天记录、邮件、网盘历史版本）手里有任何一份事故前的项目副本**，请提供路径，
届时按 `reports/INCIDENT_WORKSPACE_CORRUPTION.md` §5 的 **9 组改动清单**逐条重贴即可（那是 A1/A2/A3 路线）。

若确认无外部副本，可授权 **A4 重建**，我建议的方案（**待批准，本轮不做**）：

1. 以 `git show HEAD:<path>` 的两个文件为骨架（HEAD 版语法完整、无乱码）；
2. 以**现有测试为验收判据**逐条重建：`raiseEvCashflowP0`(15)、`raiseResponseU1`(9)、
   `riverRaiseDecisionV2`(16)、`raiseReraiseBranchLegality`(13)、`betSizeConsistency`(4)、
   `reraiseBranchP12b`(13)，以及全部既有套件（危险点：`betDecisionEngine`、`alphaRedteamRegression`、
   `test09BetRangeAudit`、`profileRangeAdjustment`、`postflopRegressionCases`…共 1,968 项）；
3. 接口以**未损坏的兄弟文件**为准（`contextBuilder.ts` / `raiseResponse.ts` / `betResponse.ts` /
   `postflopAdvisor.ts` 都完好，它们规定了 `CASHFLOW_CONTRACT`、`raiseEVOf` 的新签名、
   `villainIsAllInByCall`、被再加注字段等）；
4. **必须如实告知的损失**：中文论证注释只能**重写而非逐字还原**；任何**测试未覆盖**的行为细节
   可能被重建为等价而非原样 —— 因此重建后需要一次完整的对抗性复核。

---

## 6. 最终裁决

```text
RECOVERY_CANDIDATE_FOUND      = NO

DECISION_ENGINE_RECOVERABLE   = NO
DECISION_TYPES_RECOVERABLE    = NO

BACKUP_COMPLETENESS           = 0%（13 类来源全部不存在，无任何候选版本）

MISSING_CHANGESETS            = 两个文件内的**全部**未提交改动，即：
                                U1 RAISE EV（资金口径 / 赔率 / 条件权益 / 披露层 / 安全门）、
                                P1-2a（villainIsAllInByCall 及其诊断字段）、
                                P1-4（下注通路的同一守卫）、
                                BET SIZE CONSISTENCY（candidatesForDecision + 被评估金额补进候选）、
                                P1-2b（再加注分支字段、heroFourBetSupported 三态、诊断搬运）
                                —— 逐条清单见 reports/INCIDENT_WORKSPACE_CORRUPTION.md §5

ORIGINAL_WORKSPACE_UNCHANGED  = YES（本轮未写任何项目源文件；两文件仍为事故后状态，哈希如上）

SAFE_TO_RESTORE               = NO（没有可恢复来源 ⇒ 不存在「安全恢复」动作）

NEEDS_USER_APPROVAL           = YES
```

**本轮完成，停止并等待人工确认（是否提供外部副本 / 是否授权 A4 重建）。**
