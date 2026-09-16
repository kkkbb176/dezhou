# Phase 4.5「外部知识融合审计」红队审计报告

> **审计员**：独立红队（未参与 Phase 4.5 开发）
> **审计日期**：2026-09-13 02:36 – 02:56（本地时间）
> **审计对象快照（SHA256 前 16 位 / 最后写入时刻）**

| 产物 | SHA256(前16) | 最后写入 | 本轮审计读取时刻 |
|---|---|---|---|
| `src/domain/knowledge/knowledge.ts` | `70A57332D6F96109` | 02:36:46 | 02:37 / 02:50 |
| `src/domain/knowledge/knowledge.types.ts` | `7ABD2E4A747772C0` | 02:36:59 | 02:36:50（**早于写入，已重读**）|
| `src/domain/knowledge/knowledgeLoader.ts` | `704F216ACE0C0485` | 02:33:22 | 02:37 |
| `test/knowledge.test.ts` | `6551F8A22A17B905` | 02:37:04 | 02:37:40 |
| `data/knowledge/source-registry.json` | `A09FCC9F8B243EEF` | 02:32:50 | 02:37:40 |
| `data/knowledge/strategy-rules.json` | `BAA815A4D80A3157` | 02:30:53 | 02:37:55 |
| `reports/EXTERNAL_KNOWLEDGE_AUDIT.md` | `F13A8422386A0621` | **02:52:32（审计中第三次改写）** | 02:37 → 02:41 → **02:56 重读** |
| `reports/REFERENCE_INTEGRATION_MAP.md` | `AA7E68746F906900` | 02:35:21 | 02:38 |
| `reports/CASE_TAXONOMY.md` | `A16E4A9F9E87BF7A` | **02:47:31** | 02:38 → **02:51 重读** |
| `reports/SOLVER_CROSS_VALIDATION_PLAN.md` | `DA00FD83BD1C8102` | 02:35:58 | 02:39 |

> ⚠️ **审计目标在审计期间被并发改写**（详见 F-00）。上表所有结论均已按最终快照重跑验证；`CASE_TAXONOMY.md` 在审计中新增的 §7.1「翻牌前分类 vs 25 项指标逐条对照」我已按新版本重新核对。由于 `EXTERNAL_KNOWLEDGE_AUDIT.md` 在 3 小时内被改写了 3 次（行号会漂移），下文凡引用该文件均以**章节号 + 快照 hash** 定位，必要时附当前快照下的行号。

---

## 1. 审计范围与方法

### 1.1 我实际做了什么

| # | 手段 | 与开发者自检的差异 |
|---|---|---|
| 1 | **GitHub REST API 独立复核**：`/repos`、`/commits/{sha}`（逐个 sha 验证存在）、`/git/trees/{sha}?recursive=1` | 开发者用 `commits?per_page=1` **比对**最新 commit；我直接请求 `commits/{sha}` **验证该 sha 真的存在**，并额外比对 `shaIsLatest` |
| 2 | **全仓库文本语料拉取**：按审计 commit 拉取 4 个仓库全部 `<400KB` 的 `md/txt/rst/toml/json`（GTOpen 1064 个、pokersolver 169 个、DCFR 3 个、poker_solver 425 个），落盘成 `raw-corpus.json` 后做全文检索 | 开发者只读 README 与少数 docs；我对**每个数字**做全语料定位，因此能发现「数字在，但不在报告声称的文件里」 |
| 3 | **GTOpen 许可证穷举扫描**：拉取全部 `rs/ts/tsx/js/py/toml/json/html/sh/ps1/yml/css` 且 <200KB 的文件（1194 个候选，成功取回 1187 个），逐个匹配 `licen[cs]e|SPDX|copyright|all rights reserved|MIT|Apache License` | 开发者的三重核对只覆盖「文件名 / 根 README / 根 Cargo.toml」；我补上**源码级**扫描 |
| 4 | **原文逐字比对**：对报告中每一段引文在语料中定位（含换行拼接），比对行号与上下文 | 开发者的 §8.2 也做了逐字核对，但其行号有误（见 F-08）|
| 5 | **书目独立核实**：用独立 web 检索核对 4 个 ISBN ↔ 书名 / 作者（OpenLibrary / Google Books API 在本机被网络策略阻断，改用检索快照）| 开发者只用「官方出版页」；我用第三方书店/图书馆目录交叉验证 |
| 6 | **代码攻击**：边界许可证（26 种输入）、Fail-Closed 损坏输入、悬空/自引用、重复 id、BOM 变体、`null` 文件、类型错误字段、`1e999`、深嵌套、零宽字符、索引冻结与嵌套改写、语义矛盾输入（见 §3 各条复现）| 开发者的 50 项测试是「正向 + 少量负向」；我构造的是「绕过闸门」的输入 |
| 7 | **交叉引用逐条对照**：`CASE_TAXONOMY.md` ↔ `src/domain/player/player.types.ts`（25 项指标）与 `playerClassifier.ts`（`PlayerLabel` / `dimensions`）| 开发者新增的 §7.1 只对照了翻牌前 10 个 Spot，**未对照 `PlayerLabel` 全集**（见 F-09）|
| 8 | **元层面清点**：§7.1 的 8/3/3/2/2 逐条回溯；§8 自检记录的每条「✅」逐条复算 | 无对应动作 |

### 1.2 我**没有**做的事（诚实声明）

- 未 `git clone` 任何被审计仓库（只读 API + raw），因此**未验证仓库二进制内容**（如 GTOpen 的 `.gtop` 数据文件）。
- GTOpen 有 27 个 >200KB 的文本文件未做许可证扫描（均为 `cache/`、`research/` 下的 JSON/HTML 产物）。文件名层面的 `license|licence|copying` 检索是**全树 3242 项**、无遗漏。
- 未运行任何被审计项目的代码（无算力/无许可证），因此其自述数字**一律未复现**（与开发者的结论一致）。
- 未做第三方源码相似度/抄袭检测（只确认本仓库无 `references/`、`vendor/`、`third_party/` 目录）。

---

## 2. 基线

| 项 | 开发者报告 | 我实测 | 一致？ |
|---|---|---|---|
| 全量测试（`node.exe --test --experimental-strip-types "test/**/*.test.ts"`） | 873 项 | **878 项 / 878 pass / 0 fail / 136 suites**（30–60s） | ❌ 差 5（F-07）|
| 其中 `test/knowledge.test.ts` | 任务书称 45 项 | **50 项 / 50 pass / 0 fail** | ❌（F-07）|
| 不含知识层的既有测试 | 报告称 828 项全绿 | **828 项 / 828 pass / 0 fail**（单独跑 25 个文件） | ✅ |
| 类型检查（`npx.cmd tsc --noEmit`） | 零错误 | **exit 0，无输出** | ✅ |

**基线口径说明**：我第一次运行全量测试时得到 `tests 873`（02:36:46 启动 → 02:37:15 结束），当时 `test/knowledge.test.ts` 仍是 45 项版本；该文件于 02:37:04 被改写为 50 项版本，重跑即得 878。这既解释了报告的 873，也证明**审计期间目标在变**（F-00）。

---

## 3. 发现列表

严重级别：CRITICAL / MAJOR / MINOR / INFO。**本轮未发现 CRITICAL 级缺陷**（即：未发现编造的来源、编造的 commit、错误的许可证判定、或凭空捏造的数字）。全部复现脚本位于 `tmp-rt-knowledge/`（审计结束后删除），下文给出可独立执行的最小复现。

---

### F-00 · MAJOR（元层面/流程）· 审计目标在审计期间被并发改写，报告与产物已出现版本漂移

**结论**：被审计的 10 个产物中有 6 个在我开始读取之后被再次写入（02:30–02:47），其中 `knowledge.types.ts`、`EXTERNAL_KNOWLEDGE_AUDIT.md` 在我读过之后被改写，`CASE_TAXONOMY.md` 在我核对完之后又被改写（02:47:31）。任何「审计通过」的结论都必须绑定 hash，否则不可复核。

**最小复现**

```powershell
Get-ChildItem -File src\domain\knowledge\*,test\knowledge.test.ts,data\knowledge\*.json,reports\EXTERNAL_KNOWLEDGE_AUDIT.md,reports\CASE_TAXONOMY.md |
  ForEach-Object { "{0} {1} {2}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.Substring(0,16), $_.LastWriteTime.ToString('HH:mm:ss'), $_.Name }
```

**实测输出（节选，02:51 快照）**

```
7ABD2E4A747772C0  02:36:59  knowledge.types.ts
6551F8A22A17B905  02:37:04  knowledge.test.ts
A29BB43A86FACD59  02:38:40  EXTERNAL_KNOWLEDGE_AUDIT.md   <-- 我读过之后被改写
A16E4A9F9E87BF7A  02:47:31  CASE_TAXONOMY.md              <-- 我核对完之后又被改写
（02:52:32 EXTERNAL_KNOWLEDGE_AUDIT.md 第三次改写 → F13A8422386A0621，605 行）
```

**行为层证据（同一命令，两次运行结果不同）**

```
02:36:46 启动：licenseGateOf('BSD') = RED      （旧实现：精确匹配 + startsWith）
02:41:00 运行：licenseGateOf('BSD') = YELLOW   （新实现：新增模糊 BSD / CC-BY-SA / SPDX OR/AND/WITH）
02:36:46 启动的全量测试：tests 873
02:50:00 运行的全量测试：tests 878
```

**根因**：开发流程在报告定稿后继续编辑 `src/` 与 `reports/`，且未在报告中记录版本/hash。
**修复建议**：① 在报告头部登记每个产物的 SHA256；② 冻结窗口内禁止改写；③ 若必须改写，重跑自检并更新报告中的数字（F-07 正是漏更新的一例）。

---

### F-01 · MAJOR（来源真实性 / 自引）· `internal.spec-priority` 声称的「规范性一手证据」在被引用文件里根本不存在

**结论**：注册表把「知识优先级规范」登记为 `evidenceLevel: PRIMARY`、`url: "docs/ARCHITECTURE.md"`，但 `docs/ARCHITECTURE.md` 全文**没有**这条优先级链；全仓库唯一出现该链的地方是「规则自己」和「引用它的报告」。这是本阶段最反对的「来源幻觉」的同构缺陷，只不过发生在内部来源上。

**最小复现**

```powershell
# 1) 该链在全仓库的出现位置
Select-String -Path . -Pattern "Math Truth|Game Environment Prior|Generic Heuristic" -Recurse | Select-Object Path,LineNumber
# 2) 被引用文件里是否存在该链
Select-String -Path docs\ARCHITECTURE.md -Pattern "Math Truth|个体|环境先验|裁决|优先级顺序"
```

**实测输出**

```
data\knowledge\strategy-rules.json:23      "notes": "优先级顺序：Math Truth > ..."
data\knowledge\source-registry.json:338    "title": "本项目知识优先级规范（Math Truth > ...）"
reports\REFERENCE_INTEGRATION_MAP.md:133   高  Math Truth ...
--- docs\ARCHITECTURE.md ---
(无匹配：0 条)
```

`docs/` 目录下**只有一个文件**（`ARCHITECTURE.md`，29,521 字节）；`README.md` 对它的描述是「V1 阶段的架构与规范（**历史基线**）」。而 `data/knowledge/strategy-rules.json` 的旗舰规则 `priority.individual-over-environment`（`confidence: 0.95`、`evidenceLevel: PRIMARY`）唯一来源就是它。

**期望输出**：被引用文件应包含该优先级链（或该来源的 `evidenceLevel` 降为 `HEURISTIC` 并在 `notes` 中写明「本项目的自定纪律，无外部/文本依据」）。

**根因**：`data/knowledge/source-registry.json:337-358`（`url` 指向不承载该内容的文件；`notes` 宣称「它就是本项目必须遵守的规则本身」）；守卫测试 `test/knowledge.test.ts:588-604` 只做 `existsSync`，不校验内容。

**修复建议**：① 把优先级规范真正写入 `docs/`（例如 `docs/KNOWLEDGE_POLICY.md`）并把 `url` 指过去；② 或将该来源降级为「内部自定假设」；③ 把测试从「文件存在」升级为「文件必须包含该优先级链的 5 个层级名」。

---

### F-02 · MAJOR（许可证门禁一致性）· 注册表手写的 `licenseGate` 与运行期实际门禁不一致（2/12），且该不一致对加载器完全不可见

**结论**：`internal.environment-priors` 与 `internal.spec-priority` 在 JSON 中声明 `licenseGate: "GREEN"`，但 `license: "PROJECT_INTERNAL"` 经 `licenseGateOf()` 推出 `RED`；解析器丢弃声明值，于是运行期这两个来源变成 RED，并被合规清单报成「无许可证 / 权利不明 —— 只研究概念，禁止复制」。

**最小复现**（`tmp-rt-knowledge/attack2.mjs` 的 E1 段，核心 6 行）

```js
import { loadKnowledgeBaseOrThrow, DEFAULT_KNOWLEDGE_DIR } from '../src/domain/knowledge/knowledgeLoader.ts';
import { readFileSync } from 'node:fs';
let raw = readFileSync(DEFAULT_KNOWLEDGE_DIR + 'source-registry.json', 'utf8');
if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
const declared = JSON.parse(raw).sources;
const idx = loadKnowledgeBaseOrThrow();
for (const s of idx.allSources()) {
  const d = declared.find((x) => x.id === s.id)?.licenseGate;
  if (d !== s.licenseGate) console.log('MISMATCH', s.id, s.license, 'declared=' + d, 'runtime=' + s.licenseGate);
}
console.log(idx.summary().byLicenseGate, idx.copyRestrictions().filter((c) => c.id.startsWith('internal.')));
```

**实测输出**

```
MISMATCH internal.environment-priors: license=PROJECT_INTERNAL declared=GREEN runtime=RED
MISMATCH internal.spec-priority:     license=PROJECT_INTERNAL declared=GREEN runtime=RED
runtime byLicenseGate  = {"RED":9,"GREEN":3}
declared byLicenseGate = {"RED":7,"GREEN":5}
internal sources in copyRestrictions = [
  {"id":"internal.environment-priors","gate":"RED","reason":"许可证为 PROJECT_INTERNAL（无许可证 / 权利不明）—— 只研究概念，禁止复制"},
  {"id":"internal.spec-priority",   "gate":"RED","reason":"许可证为 PROJECT_INTERNAL（无许可证 / 权利不明）—— 只研究概念，禁止复制"}]
loadKnowledgeBase().ok = true      <-- 不一致对加载器不可见
```

**连带影响**（跨产物矛盾）：

- `reports/REFERENCE_INTEGRATION_MAP.md:31` 写「内部环境先验 … GREEN（内部）」——与运行期 RED 冲突。
- 只要有人统计「GREEN 几个来源」（例如 UI、合规报表），读 JSON 得 5，读索引得 3。
- `validateKnowledgeSource()` 中「门禁声明 ≠ 许可证推导」的检查（`knowledge.types.ts:359-366`）在生产路径上是**死代码**：`parseKnowledgeSource()` 在 `knowledge.ts:158` 用推导值覆盖声明值，所以该检查永远不会触发——而唯一能覆盖它的测试（`knowledge.test.ts:154-185`）恰恰在断言「解析器忽略该字段」。

**期望输出**：要么加载时报 `COPY_NOT_ALLOWED`（声明与推导不一致就拒绝），要么数据里不再保留这个冗余字段；无论如何，索引的 `byLicenseGate` 应与 JSON 一致。

**根因**：`data/knowledge/source-registry.json:313` 与 `:342`（`"licenseGate": "GREEN"`）+ `src/domain/knowledge/knowledge.ts:157-158`（推导覆盖）+ `src/domain/knowledge/knowledge.types.ts:359`（检查不可达）。

**修复建议**：① 内部来源改用 `licenseGateOf` 能识别的标识（例如显式把 `PROJECT_INTERNAL` 判为 GREEN 并写明理由），或把 JSON 的声明值改为 `RED` 并接受「内部来源也不得复制」的语义；② **保留**声明字段但让它参与校验：解析器保留声明值 → `validateKnowledgeSource` 报不一致 → 加载失败；③ 增加一条测试：解析后的 `licenseGate` 必须等于 JSON 中声明值。

---

### F-03 · MAJOR（Fail-Closed 缺口）· 不引用任何来源的规则可以通过全部校验并进入索引（「每条结论可追溯」无强制）

**结论**：`validateStrategyKnowledge()` 不检查 `sources` 是否为空；证据等级校验又只在 `resolved.length > 0` 时执行。于是一条 `sources: []`、`evidenceLevel: "PRIMARY"`、`confidence: 0.99` 的规则可以成功建索引。

**最小复现**

```js
import { buildKnowledgeIndex } from '../src/domain/knowledge/knowledge.ts';
import { validateStrategyKnowledge } from '../src/domain/knowledge/knowledge.types.ts';
const r = { ruleId: 'no-source', street: 'ANY', gameEnvironment: 'MID_LOW_STAKES', situation: 's',
  adjustment: 'NEUTRAL', target: 'RANGE_WIDTH', evidenceLevel: 'PRIMARY', confidence: 0.99,
  sources: [], exceptions: ['e'], notes: 'n' };
console.log('issues =', validateStrategyKnowledge(r, new Map()).map((i) => i.code));
const idx = buildKnowledgeIndex({ version: '1', auditDate: '2026-09-13', sources: [], rules: [r] });
console.log('built; evidence =', idx.rule('no-source').evidenceLevel, '; sourcesOf =', idx.sourcesOf('no-source'));
```

**实测输出**

```
issues = []
built; evidence = PRIMARY ; sourcesOf = []
```

**期望输出**：`issues` 至少包含一条「规则必须引用至少一个已登记来源」（新码，例如 `MISSING_SOURCES`），`buildKnowledgeIndex` 抛错。

**根因**：`src/domain/knowledge/knowledge.types.ts:437-450`（空数组不产生任何 issue）、`:478`（`if (resolved.length > 0)` 把证据等级校验整体跳过）；`src/domain/knowledge/knowledge.ts:370-375` 只在有 issue 时抛错。

**修复建议**：在 `validateStrategyKnowledge` 开头加 `if (rule.sources.length === 0) → MISSING_SOURCES`；证据等级校验去掉 `resolved.length > 0` 守卫（无来源时本身就应报错）；补测试。

---

### F-04 · MAJOR（索引完整性）· `Object.freeze` 只冻结第一层：`scope` / `limitations` / `sources` 均可被调用方改写，`rulesUsing()` 还直接返回内部数组

**结论**：`buildKnowledgeIndex()` 注释与测试都宣称「校验通过的对象就是运行时对象」「不得被调用方改写」，实测只冻结了索引对象与两个顶层数组；来源的 `scope`、`limitations` 与规则的 `sources`、`exceptions` 都可写；`rulesUsing()` 返回的是**内部可变数组**。

**最小复现**

```js
import { loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
const idx = loadKnowledgeBaseOrThrow();
const s = idx.source('github.gtopen');
console.log('frozen:', Object.isFrozen(s), Object.isFrozen(s.scope), Object.isFrozen(s.limitations));
s.scope.gameType = 'Tournament (rewritten by caller)';
s.scope.tableSize = '9-max';
s.limitations.length = 0;                       // 清空该来源的全部已知限制
const r = idx.allRules()[0];
r.sources.push('ghost.source');                 // 校验期之后塞入悬空引用
console.log(s.scope, s.limitations, r.sources);
console.log('rulesUsing 内部数组：', idx.rulesUsing('github.gtopen').length);
idx.rulesUsing('github.gtopen').push({ ruleId: 'INJECTED' });
console.log('再取一次：', idx.rulesUsing('github.gtopen').length);
```

**实测输出**

```
frozen: true false false
scope after = {"gameType":"Tournament (rewritten by caller)","tableSize":"9-max", ...}
limitations = []
rule.sources = ["github.gtopen","ghost.source"]
rulesUsing 内部数组：3   →   再取一次：4
```

**期望输出**：任意嵌套写入都应抛 `TypeError`（严格模式）或至少不影响索引；`rulesUsing()` 应返回副本/冻结数组。

**根因**：`src/domain/knowledge/knowledge.ts:379-380`（`Object.freeze(s)` 是浅冻结；`scope`/`limitations` 是引用类型）、`:421`（`rulesBySource.get(sourceId) ?? []` 直接外泄内部数组）；测试 `test/knowledge.test.ts:577-582` 只断言 `index`、`allSources()`、`allRules()` 三个顶层对象冻结。

**真实影响**：来源的 `scope` 正是「防止范围混淆」（约束 #7）的载体——调用方可以把 `book.grinders-manual` 的 `tableSize` 从「6-max」改成「9-max」，或清空 `book.mastering-small-stakes` 的限制文本，而所有下游断言（含 `scope` 审计测试）随后都会看到被改写后的值。目前知识层**没有生产消费者**（`src/` 中除 knowledge 自身外无任何 import），因此这是**潜在**而非**已发生**的破坏；但「冻结」的承诺与实际不符，且测试给了虚假的安全感。

**修复建议**：① 深冻结（递归 `Object.freeze` 或结构化克隆后冻结）`scope/limitations/exceptions/sources`；② `rulesUsing` 返回 `Object.freeze([...list])`；③ 测试改为**尝试**嵌套写入并断言失败。

---

### F-05 · MAJOR（许可证纪律 / 自相矛盾）· 明确「禁止复制数据」的无许可证来源（GTOpen，RED）的成组数值被复制进本项目产物

**结论**：报告自己写「本项目不得引用上表的任何数值（无许可证）」，注册表写「本项目**不得**引用其文本或数据」，但同一批数字被原样写进了报告表格与 `strategy-rules.json` 的规则注释。数字本身**核实为真**（逐字存在于 GTOpen `docs/player_types.md`），所以这不是「编造数字」，而是**违反本阶段自己的许可证纪律**（RED = 只研究概念，禁止复制）。

**最小复现**

```powershell
Select-String -Path data\knowledge\strategy-rules.json -Pattern "0\.89|0\.74|0\.72|0\.26|0\.21|2,942|1,450 万|0\.12"
Select-String -Path reports\EXTERNAL_KNOWLEDGE_AUDIT.md -Pattern "0\.89|0\.74|0\.72|0\.26|0\.21|0\.25|6%"
```

**实测输出（节选）**

```
data\knowledge\strategy-rules.json:66  "...该数据集显示 VPIP 方差解释度 0.89、open-limp 0.74、fold-vs-raise 0.72..."
data\knowledge\strategy-rules.json:70  "...对 2,942 名 1,500+ 手满员桌玩家（1,450 万手）...fold-to-flop-bet 0.26、fold-to-turn-bet 0.21、c-bet 0.03、raise-vs-bet 0.05、fold-to-3-bet 0.03..."
data\knowledge\strategy-rules.json:86  "...K-means 轮廓系数在 k=2 达峰（紧 vs 松），k≥4 后平坦在约 0.12..."
reports\EXTERNAL_KNOWLEDGE_AUDIT.md:119-121  （同一批数值的表格，另加 0.25 / 6%）
```

原文比对（我独立拉取 `raw.githubusercontent.com/MatthewPDingle/GTOpen/92c86ed…/docs/player_types.md`）：

```
62|   postflop.** Share of variance explained by the nine old bands: VPIP 0.89,
63|   open-limp 0.74, fold-vs-raise 0.72, PFR 0.41 — but fold-to-flop-bet 0.26,
64|   fold-to-turn-bet 0.21, c-bet 0.03, raise-vs-bet 0.05, fold-to-3-bet 0.03.
```

（即：报告的数字**全部真实且可核实**；缺陷在于「声明禁止复制」与「实际复制」并存。）

**期望输出**：数据文件中只保留**方向性结论**与出处指针（如「见其 `docs/player_types.md` §2 的方差解释度表；本项目未复制其数值」）；报告表格如需说明方法论，应写成不含具体数值的转述，或明确标注为「为审计目的的最小必要引用，已记录来源与限制」并给出法律/权利理由，而不是同时宣称「不得引用」。

**根因**：`reports/EXTERNAL_KNOWLEDGE_AUDIT.md` §1.4（快照 `F13A8422386A0621` 下第 108–135 行，数值表在 119–121，禁止语在 123）；`data/knowledge/strategy-rules.json:66,70,86`（规则注释复制数值）；`data/knowledge/source-registry.json:42`（GTOpen `notes` 亦复述其统计与「6% 是松的」）。

**修复建议**：把上述数值从 `strategy-rules.json` 与注册表 `notes` 中删除，改为「数值见来源 §2，本项目未复制」；报告保留方法论结论，删除数字列，或将其降级为「仅记录已查阅、不在本项目内引用」。

---

### F-06 · MINOR（范围审计机制）· `scope` 字段是完全未校验的强制转换，且范围审计测试只检查「键名是否出现」

**结论**：`parseKnowledgeSource()` 用 `input.scope as KnowledgeSource['scope']` 原样接收任意结构；`knowledge.test.ts` 的「范围审计」只对 `JSON.stringify(scope)` 做 `includes('gameType'|'tableSize')`，因此 `tableSize: 42`、`gameType: {…}`、2000 层嵌套都能通过「范围审计」。

**最小复现**

```js
import { parseKnowledgeSource, buildKnowledgeIndex } from '../src/domain/knowledge/knowledge.ts';
const p = parseKnowledgeSource({ id: 'weird', title: 't', type: 'BOOK', license: 'MIT', auditDate: '2026-09-13',
  evidenceLevel: 'SECONDARY', allowedUsage: 'CONCEPT_ONLY', fullTextAvailable: false, hasQuantitativeData: false,
  derivableQuantitativeData: false, notes: 'n', limitations: ['l'],
  scope: { gameType: { nested: ['deep'] }, tableSize: 42, stackDepthBB: null, players: [] } });
console.log(p.ok, p.value.scope, typeof p.value.scope.tableSize);
console.log(buildKnowledgeIndex({ version: '1', auditDate: '2026-09-13', sources: [p.value], rules: [] }).source('weird').scope);
```

**实测输出**

```
true {"gameType":{"nested":["deep"]},"tableSize":42,"stackDepthBB":null,"players":[]} number
{"gameType":{"nested":["deep"]},"tableSize":42,"stackDepthBB":null,"players":[]}
```

**期望输出**：`scope` 各字段必须是非空字符串（或未登记取值报错）；`tableSize: 42` 应被拒绝。

**根因**：`src/domain/knowledge/knowledge.ts:180`；测试 `test/knowledge.test.ts:634-649`（`declared` 判定只看键名）。
**修复建议**：为 `scope` 写显式的 `requireOptionalString` 校验（并在测试里断言类型错误被拒），或把 `scope` 定义为受控词表枚举。

---

### F-07 · MINOR（报告数字）· 报告中的两个自有数字与实测不符：仓库体积合计「约 690 MB」（实测 ≈544 MiB）、测试「828 → 873」（实测 828 → 878）

**结论**：§8.4 声称「报告中的数字……全部为被审计项目的自述」，但这两处是报告**自己的**数字，且都不成立。

**最小复现**

```powershell
# 体积：四个仓库的 API size（KB）
# GTOpen 385689 / pokersolver 142057 / DCFR-SOLVER 192 / poker_solver 29307
(385689+142057+192+29307)/1024      # = 544.2 MiB
node.exe --test --experimental-strip-types "test/**/*.test.ts"  | Select-String "^ℹ tests"
node.exe --test --experimental-strip-types "test/knowledge.test.ts" | Select-String "^ℹ tests"
```

**实测输出**

```
544.2 MiB   （报告：约 690 MB；按报告自己的 GTOpen 385 MB 口径相加也只有 385+142+0.2+29 ≈ 557）
全量：tests 878 / pass 878 / fail 0
知识层：tests 50 / pass 50 / fail 0   （828 + 50 = 878；报告写 828 → 873，即 +45）
```

**期望输出**：报告头部基线行（快照 `F13A8422386A0621` 下第 6 行）应为 `828 → 878（新增 50 项）`；§0 方法说明（同快照第 24 行）应为「合计约 544 MiB」。

**根因**：报告写于 02:38:40，而 `test/knowledge.test.ts` 于 02:37:04 由 45 项扩到 50 项（新增 5 条许可证边界测试），报告未同步；体积系手工估算错误。
**修复建议**：基线数字改为「由脚本生成」，并在报告头部登记快照 hash（配合 F-00）。

---

### F-08 · MINOR（自检记录准确性）· §8.2 有一处行号错误：`fail-closed full-hand model` 标为 Poker Lab README 第 50 行，实际在第 12–13 行

**最小复现**

```powershell
Select-String -Path tmp-corpus\pokersolver\README.md -Pattern "fail-closed full-hand" -Context 1,1
```

**实测输出**

```
12|  push/fold drills, policy-frequency feedback, and fail-closed full-hand model
13|  loading.
---
50| | Hand evaluator | `lib/evaluator.ts` |      <-- 报告标注的「第 50 行」是一张架构表
```

同表其余三处行号（71–72 / 70–71 / 77）我逐一核对，**均正确**。
**根因**：`reports/EXTERNAL_KNOWLEDGE_AUDIT.md` §8.2 表格最后一行（快照 `F13A8422386A0621` 下第 547 行）。
**修复建议**：改为「第 12–13 行（跨行）」，与同表其他行的标注方式一致。

---

### F-09 · MINOR（跨文件一致性）· `CASE_TAXONOMY.md` §2.1 的「11 个标签」与代码里 `PlayerLabel` 的 11 个取值只有 7 个对得上，且文件自相矛盾

**结论**：报告列出的 11 个标签中有 3 个在代码里**不存在**（Maniac / Overfolder / Overbluffer），Nit 与代码的 `ULTRA_TIGHT` 只是粗略对应；代码里有 4 个标签报告**完全没提**（`TIGHT_PASSIVE` 紧弱、`ULTRA_TIGHT`、`REG_AVERAGE`、`REG_STRONG`）。同时 §2.1 把 `Overfolder` 列为 11 个标签之一，而 §2.3/§7.4 又说「本轮**不新增**该标签」。

**最小复现**

```powershell
Select-String -Path src\domain\player\playerClassifier.ts -Pattern "^  [A-Z_]+: '" | Select-Object -First 11
Select-String -Path reports\CASE_TAXONOMY.md -Pattern "^\| B[0-9]+ \|"
```

**实测输出**

```
代码（src/domain/player/playerClassifier.ts:34-46）：
  UNKNOWN, TIGHT_PASSIVE, TIGHT_AGGRESSIVE, LOOSE_PASSIVE, LOOSE_AGGRESSIVE,
  CALLING_STATION, BLUFF_HEAVY, BLUFF_LIGHT, ULTRA_TIGHT, REG_AVERAGE, REG_STRONG
报告（CASE_TAXONOMY.md:102-112）：
  Unknown, Nit, TAG, LAG, Calling Station, Passive Recreational,
  Aggressive Recreational, Maniac, Overfolder, Underbluffer, Overbluffer
```

逐条对照（§2.1 → 代码）：

| 报告标签 | 代码取值 | 判定 |
|---|---|---|
| Unknown | `UNKNOWN` | ✅ |
| Nit | `ULTRA_TIGHT` | 🟡 语义近似（报告写「超紧型」，代码是「入池率极低」）|
| TAG | `TIGHT_AGGRESSIVE` | ✅ |
| LAG | `LOOSE_AGGRESSIVE` | ✅ |
| Calling Station | `CALLING_STATION` | ✅ |
| Passive Recreational | `LOOSE_PASSIVE` | ✅ |
| Aggressive Recreational | `BLUFF_HEAVY` | 🟡 代码还要求 `aggression ≥ 0.6`，报告只写「诈唬倾向高 + 凶」|
| Maniac | **无** | ❌ |
| Overfolder | **无**（且 §2.3 说未启用）| ❌ 自相矛盾 |
| Underbluffer | `BLUFF_LIGHT` | ✅ |
| Overbluffer | **无**（与 B7 重复语义）| ❌ |
| （报告缺失）| `TIGHT_PASSIVE` / `REG_AVERAGE` / `REG_STRONG` | ❌ 漏登记 |

§2.2 的「`PlayerLabel` 是 11 个 `as const` 取值」**数量**正确，因此数量断言无法发现该不一致。§7.3「轴 B 的 11 种标签 🟡 已实现 11 种」同样只对了数量。

**期望输出**：§2.1 直接以代码的 11 个取值为准（或明确拆成「分类学命名法」与「代码标签」两栏，并给出映射表）。
**根因**：`reports/CASE_TAXONOMY.md:100-112`、`:130-135`、`:331`。
**修复建议**：用代码生成该表，或在测试中断言「报告列出的标签集合 == `Object.values(PlayerLabel)`」。

---

### F-10 · MINOR（Fail-Closed 诊断质量）· JSON 文件内容为字面 `null` 时，加载失败但**零诊断信息**

**结论**：`readJson()` 用 `null` 同时表示「读失败/解析失败」与「解析成功但内容是 null」，于是 `loadKnowledgeBase()` 会返回 `{ok:false, issues:[]}`，`loadKnowledgeBaseOrThrow()` 抛出的信息里没有任何原因。

**最小复现**

```js
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadKnowledgeBase, loadKnowledgeBaseOrThrow } from '../src/domain/knowledge/knowledgeLoader.ts';
mkdirSync('tmp-null', { recursive: true });
writeFileSync('tmp-null/source-registry.json', 'null');
writeFileSync('tmp-null/strategy-rules.json', JSON.stringify({ rules: [] }));
console.log(loadKnowledgeBase('tmp-null'));
try { loadKnowledgeBaseOrThrow('tmp-null'); } catch (e) { console.log(JSON.stringify(e.message)); }
```

**实测输出**

```
{ ok: false, issues: [] }
"loadKnowledgeBaseOrThrow: 知识库加载失败（Fail-Closed，拒绝降级）：\n"
```

**期望输出**：至少一条 issue，例如 `[SCHEMA_FIELD_INVALID] source-registry.json：文件内容为 null（不是对象）`。
**根因**：`src/domain/knowledge/knowledgeLoader.ts:38-57`（返回类型 `unknown | null` 混淆两种语义）+ `:69`（`if (registryRaw === null || rulesRaw === null) return { ok:false, issues }`）。
**修复建议**：让 `readJson` 返回判别式结果（`{ok:true,value} | {ok:false}`），或在 `:69` 处补一条「文件内容为 null」的 issue。

---

### F-11 · MINOR（数据文件规范）· 两个数据文件编码不一致：`source-registry.json` 带 UTF-8 BOM；且两个 `$schema` 指向不存在的文件

**最小复现**

```powershell
foreach ($f in @('data\knowledge\source-registry.json','data\knowledge\strategy-rules.json')) {
  $b = [System.IO.File]::ReadAllBytes((Resolve-Path $f)); "{0}: {1:X2} {2:X2} {3:X2}" -f $f, $b[0], $b[1], $b[2] }
Test-Path data\knowledge\source-registry.schema.json; Test-Path data\knowledge\strategy-knowledge.schema.json
```

**实测输出**

```
data\knowledge\source-registry.json: EF BB BF        <-- BOM
data\knowledge\strategy-rules.json:  7B 0A 20        <-- 无 BOM
False
False
```

**影响**：① 任何不经 loader 的消费者（`jq`、Python `json.load(open(f))`、编辑器 schema 校验、未来的工具脚本）在注册表上直接失败；② 两个文件声明的 `$schema` 是不存在的文件——在一个以「每条声明都必须可核实」为主题的阶段里，这是**不可核实的声明**。loader 的 BOM 容忍在起作用（我用 `bom-both`/`bom-reg-only` 两种夹具验证过能正常加载），但这也意味着**唯一的真实数据文件正好走在容错路径上**。
**期望输出**：两个文件都不带 BOM（一致性）；`$schema` 要么提供实体文件，要么删除该键。
**根因**：`data/knowledge/source-registry.json:2`、`strategy-rules.json:2`；`knowledgeLoader.ts:50`（容错）。
**修复建议**：用 `write` 工具重写注册表（不带 BOM）；补一条测试断言两个数据文件的首字节不是 `EF BB BF`。

---

### F-12 · MINOR（校验逻辑）· `requireEnum()` 失败时仍报 `MISSING_LIMITATIONS`，而 `SCHEMA_FIELD_INVALID` 已定义却在该路径未使用（修复不彻底）

**结论**：`SCHEMA_FIELD_INVALID` 已加入 `KnowledgeIssueCode` 并在三个 `require*` 助手中改正，但**枚举校验路径漏改**：非法枚举值报的是 `MISSING_LIMITATIONS`（语义为「缺限制」）。而 `knowledge.types.ts:325-326` 对该码的定义恰好是「字段缺失、类型错误或**取值不在已登记集合内**」。

**最小复现**

```js
import { parseKnowledgeSource } from '../src/domain/knowledge/knowledge.ts';
const p = parseKnowledgeSource({ id: 'x', title: 'x', type: 'NOT_A_TYPE', license: 'MIT', auditDate: '2026-09-13',
  evidenceLevel: 'HEURISTIC', allowedUsage: 'CONCEPT_ONLY', fullTextAvailable: true,
  hasQuantitativeData: false, derivableQuantitativeData: false, notes: 'x', limitations: ['x'] });
console.log(p.issues.map((i) => [i.code, i.params.field]));
```

**实测输出**

```
[["MISSING_LIMITATIONS","type"]]      <-- 期望 [["SCHEMA_FIELD_INVALID","type"]]
```

现有测试之所以没发现：`test/knowledge.test.ts:419` 只断言 `i.message.includes('已登记取值')`，**断言的是文案而不是错误码**。
**附带证据（自检记录过度声称）**：`reports/EXTERNAL_KNOWLEDGE_AUDIT.md` §8.8 第 1 条写「新增 `SCHEMA_FIELD_INVALID` 并**逐处改正**」——实测只改了 `requireString`/`requireBoolean`/`requireStringArray` 三处，`requireEnum` 漏改，因此「逐处」不成立。
**根因**：`src/domain/knowledge/knowledge.ts:96`。
**修复建议**：改为 `'SCHEMA_FIELD_INVALID'`；测试改为断言 `code`（文案可另测）。

---

### F-13 · MINOR（校验逻辑）· `evidenceRank()` 对未登记取值返回 `undefined`，比较静默为 false → 绕过解析器时可建立「未登记证据等级」的索引

**最小复现**

```js
import { buildKnowledgeIndex } from '../src/domain/knowledge/knowledge.ts';
import { evidenceRank, validateStrategyKnowledge } from '../src/domain/knowledge/knowledge.types.ts';
console.log('rank =', evidenceRank('THEORY'));
const src = { id: 'g', title: 't', type: 'GITHUB', license: 'MIT', licenseGate: 'GREEN', auditDate: '2026-09-13',
  evidenceLevel: 'HEURISTIC', allowedUsage: 'CONCEPT_ONLY', fullTextAvailable: true, hasQuantitativeData: false,
  derivableQuantitativeData: false, notes: 'n', limitations: ['l'] };
const rule = { ruleId: 'r', street: 'ANY', gameEnvironment: 'MID_LOW_STAKES', situation: 's', adjustment: 'NEUTRAL',
  target: 'RANGE_WIDTH', evidenceLevel: 'THEORY', confidence: 0.5, sources: ['g'], exceptions: ['e'], notes: 'n' };
console.log(validateStrategyKnowledge(rule, new Map([['g', src]])).map((i) => i.code));
console.log(buildKnowledgeIndex({ version: '1', auditDate: '2026-09-13', sources: [src], rules: [rule] }).rule('r').evidenceLevel);
```

**实测输出**

```
rank = undefined
[]
THEORY          <-- 索引建立成功
```

**范围**：经 JSON 加载路径不可达（`requireEnum` 会拦下）；但 `buildKnowledgeIndex` / `validateKnowledgeBase` 是导出的领域 API，任何直接构造对象的调用方（含未来 UI/导入器）都能命中。
**期望输出**：`MAGNITUDE`/证据校验前应先校验等级本身，未登记取值报错。
**根因**：`src/domain/knowledge/knowledge.types.ts:349-351`（`Record` 索引返回 `undefined` 但类型声明为 `number`）、`:479-492`。
**修复建议**：`evidenceRank` 对未知键抛错，或在 `validateStrategyKnowledge` 里显式校验 `rule.evidenceLevel ∈ EVIDENCE_RANK`。

---

### F-14 · MINOR（「不编造数字」的闸门强度）· `magnitude` 只有「正有限数」这一条约束（无单位、无上限），而整个反编造保证实际只挂在注册表的一个手写布尔上

**结论**：当某来源把 `derivableQuantitativeData` 写成 `true`（且 `hasQuantitativeData: true` + GREEN），任何正有限数都能通过——`1e-12`、`0.61`、`1e9`、`1.79e308` 一视同仁；端到端加载成功。也就是说「没有数据就不许写幅度」这条**可执行断言**，其可执行性等于「一个人工布尔没有被写错」，没有任何机制要求该布尔**有依据**（无字段要求给出数据链接、样本量、推导方法或可复现路径）。

**最小复现**（自包含；把两个夹具写进临时目录即可）

```js
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadKnowledgeBase } from '../src/domain/knowledge/knowledgeLoader.ts';
mkdirSync('tmp-flag', { recursive: true });
writeFileSync('tmp-flag/source-registry.json', JSON.stringify({
  registryVersion: '1', auditDate: '2026-09-13',
  sources: [{ id: 'self.claim', title: '自述来源', type: 'USER_NOTE', license: 'MIT',
    auditDate: '2026-09-13', evidenceLevel: 'HEURISTIC', allowedUsage: 'CONCEPT_ONLY',
    fullTextAvailable: true, hasQuantitativeData: true, derivableQuantitativeData: true,
    notes: '没有任何数据链接，只是把这个布尔写成 true', limitations: ['无'] }],
}));
writeFileSync('tmp-flag/strategy-rules.json', JSON.stringify({
  rules: [{ ruleId: 'self.claim.rule', street: 'ANY', gameEnvironment: 'LOW_STAKES_ONLINE',
    situation: '低级别河牌诈唬不足', adjustment: 'DECREASE', target: 'BLUFF_WEIGHT',
    magnitude: 0.61, evidenceLevel: 'HEURISTIC', confidence: 0.5,
    sources: ['self.claim'], exceptions: ['无'], notes: '凭空写一个幅度' }],
}));
const r = loadKnowledgeBase('tmp-flag');
console.log(r.ok, r.ok ? r.index.rule('self.claim.rule').magnitude : r.issues);
```

**实测输出**

```
magnitude=1e-12  -> issues=[]
magnitude=0.61   -> issues=[]
magnitude=1000000-> issues=[]
magnitude=1.7976931348623157e+308 -> issues=[]
loadKnowledgeBase.ok = true ; rule.magnitude = 0.61 ; rulesWithoutMagnitude = 0
```

**期望输出**：`magnitude` 应有语义（乘数？百分点？筹码？）与合理区间；声称 `derivableQuantitativeData: true` 的来源应被要求登记**推导依据**（数据路径 + 方法 + 样本量），否则该字段与「凭一句话写 0.61」没有区别。
**现状说明（重要）**：**当前发布数据没有违反**——12 条规则全部无 `magnitude`，12 个来源 `derivableQuantitativeData` 全为 `false`（我实测确认）。因此这是一条**闸门强度**问题，不是已发生的编造。
**根因**：`src/domain/knowledge/knowledge.types.ts:455-475`（唯一约束 `> 0 && finite`）、`:204-224`（`derivableQuantitativeData` 无配套证据字段）。
**修复建议**：给 `magnitude` 定义量纲与区间（例如「相对倍率，∈(0,2]」）；在 `KnowledgeSource` 上增加 `derivationBasis`（必填当 `derivableQuantitativeData === true`），并在测试中断言「可推导来源必须带推导依据」。

---

### F-15 · MINOR（证据等级语义）· 同为「仅凭对方 README、本项目未复现」，两个项目的结论被给了不同等级；两条 GTOpen 规则标 `VERIFIED_SECONDARY`，而其来源说明明确「不得引用其数据 / 未复现任何数值」

**实测对照**（`attack3.mjs` X5 段，规则 ← 来源等级）

| 规则 | 声明等级 | 最强来源 | 备注 |
|---|---|---|---|
| `validation.suit-isomorphism-permutation-direction` | `SECONDARY` | DCFR `VERIFIED_SECONDARY` | 规则注释：「仅凭 README 记载，**未在本项目内复现**」|
| `validation.beware-test-harness-encoding-artifacts` | `VERIFIED_SECONDARY` | poker_solver `VERIFIED_SECONDARY` | 同样是只读 README/docs |
| `profile.preflop-type-does-not-predict-postflop` | `VERIFIED_SECONDARY` | GTOpen `PRIMARY` | 规则注释：「**本项目未复现其任何数值**，因此不得据此设定任何阈值」|
| `profile.player-stats-are-continuum-not-clusters` | `VERIFIED_SECONDARY` | GTOpen `PRIMARY` | 同上 |

注册表自己的图例（`source-registry.json:13`）把 `VERIFIED_SECONDARY` 定义为「**经独立复核**的二手证据：有方法与样本量、可追溯原始数据」。既然本项目既未复现、又不得引用其数据，把它标成「经独立复核」与 `SECONDARY`（「有出处但无法独立复核原始数据」）的界线就模糊了——同一类证据（只读对方 README）在两条规则里被分别标成 `SECONDARY` 与 `VERIFIED_SECONDARY`。
**根因**：`data/knowledge/strategy-rules.json:62,79,95,111,128,143` 与 `data/knowledge/source-registry.json:97,128`。
**修复建议**：把「独立复核」的门槛写成一条可判定规则（谁复核、复核了什么、可否复现），并据此统一评级；或在图例中改名为「有方法可追溯的二手证据（未见独立复核）」。

---

### F-16 · MINOR（风险披露可复核性）· 盗版站点防护对现有数据是空转，且风险只写「疑似盗版全文站点」而不记录域名

**结论**：`knowledge.test.ts:615-632` 的第二段逻辑（「说明里提到盗版站点时必须写明未使用」）在现有数据上**永不执行**——注册表两条相关 `notes` 只说「疑似盗版全文站点」，不含 `pirateHosts` 里的任何一个域名；URL 检查也天然通过。因此「已登记为风险」这一说法无法被任何人复核（不知道是哪个站）。

**最小复现**

```powershell
Select-String -Path data\knowledge\source-registry.json -Pattern "libgen|z-lib|pdfdrive|1lib|kupdf|archive.org/stream"
```

**实测输出**

```
(无匹配；仅有两处「网络搜索曾返回疑似盗版全文站点；本项目未读取、未引用、不会使用此类来源」——第 171、224 行)
```

**期望输出**：测试应至少有一条「夹具命中」样本证明该分支可执行（否则它是不可证伪的守卫）；风险登记处应记录**被拒绝的域名**（作为「已识别并拒绝」的证据），而不是只在叙述里说「疑似」。
**根因**：`test/knowledge.test.ts:615-632`；`data/knowledge/source-registry.json:171,224`。
**修复建议**：在测试里加一个提到 `libgen` 但未写「未使用」的负例夹具，断言其被拒；在报告/风险登记中列出实际被排除的域名。

---

### F-17 · MINOR（文档/实现口径）· `magnitude` 的说明文字写的是 `hasQuantitativeData`，实现用的是 `derivableQuantitativeData` —— 恰好是本阶段最强调的那组区分

**结论**：本阶段最大卖点就是把「来源里有数字」与「我们能拿它定参数」分开。但类型定义文档与数据文件的 `magnitudePolicy` 都把闸门写成 `hasQuantitativeData`，而代码用的是 `derivableQuantitativeData`。三处口径不一致，读者按文档理解会得到错误的合规结论。

**最小复现**

```powershell
Select-String -Path src\domain\knowledge\knowledge.types.ts -Pattern "hasQuantitativeData: true"
Select-String -Path src\domain\knowledge\knowledge.types.ts -Pattern "derivableQuantitativeData\)"
Select-String -Path data\knowledge\strategy-rules.json -Pattern "magnitudePolicy"
```

**实测输出**

```
src\domain\knowledge\knowledge.types.ts:285: * 它要求「有 magnitude ⇒ 必须至少有一个 `hasQuantitativeData: true` 的来源」。
src\domain\knowledge\knowledge.types.ts:456:     const hasData = resolved.some((s) => s.derivableQuantitativeData);
data\knowledge\strategy-rules.json:6: "magnitudePolicy": "...其来源必须至少有一个 hasQuantitativeData=true。"
```

**期望输出**：`:285` 与 `strategy-rules.json:6` 都应写 `derivableQuantitativeData: true`（代码在 `knowledge.ts` 头部注释与 `:452-454` 的注释里是对的，只有这两处漏改）。
**根因**：`src/domain/knowledge/knowledge.types.ts:280-286`、`data/knowledge/strategy-rules.json:6`。
**修复建议**：改文档；并在测试中断言该注释不出现 `hasQuantitativeData: true`（防再次漂移）。

---

### F-18 · INFO（元层面）· §7.1 的 8/3/3/2/2 清点：8 条方法论 ✅、3 条设计 ✅、2 条前置警告 ✅、2 条风险发现 ✅，但「交叉印证了既有设计 3 条」中有 1 条找不到外部依据

**清点结果**

| 声明 | 实际可回溯 | 判定 |
|---|---|---|
| 8 条方法论（Fail-Closed / 双种子门禁 / 哈希校验 / Reference-first / 两层差分测试 / 优化可关闭 / EV 优先于频率 / 纯策略一致作必要条件）| §2.1/§2.2/§4.1/§4.2/§3.1 逐条对应，**8/8 可回溯** | ✅ |
| 3 条设计（证据标签区分来源与置信度 / 被编辑数据必须重新检查 / 无决策点显示「不适用」）| §1.3 三条直接引用 `model_evidence.md`，**3/3 可回溯** | ✅ |
| 交叉印证 3 条（连续谱而非聚类 / 翻牌前与翻牌后独立 / **环境不得改数学**）| 前两条来自 GTOpen `player_types.md`（我已逐字核实）；**第三条在 4 个被审计项目中找不到任何对应论述**——它只被本项目自己的 `internal.spec-priority` 支持 | 🟡 2 条外部 + 1 条内部 |
| 2 条前置警告（花色同构排列方向 / 测试包装层编码瑕疵）| §3.2、§4.4，均有原文 | ✅ |
| 2 条风险发现（无许可证项目数据权利不明 / web 搜索返回盗版全文站点）| §1.4、§5.1（后者不可复核，见 F-16）| 🟡 |

**修复建议**：把第 3 条移到「内部不变式」而不是「外部交叉印证」，或给出外部依据。

**§8 自检记录的诚实性总评**：§8 是这一阶段最值得肯定的部分（它甚至如实记录了「跨行引用导致 `NOT FOUND` 虚警」的过程）。但有两处**过度声称**：① §8.8 第 1 条「逐处改正」不成立（漏了 `requireEnum`，见 F-12）；② §8.4「报告中的数字……**全部**为被审计项目的自述」不成立（报告自己的两个数字就是错的，见 F-07）；③ §8.3「门禁能否被手写绕过 ✅ 解析器忽略 JSON 里的门禁字段」把一个**缺陷面**（声明值与生效值不一致且无人发现，见 F-02）写成了纯优点。此外 §8 完全未提及：内部来源引用不成立（F-01）、零来源规则（F-03）、冻结深度（F-04）、无许可证数值被复制（F-05）。

---

### F-19 · INFO（元数据语义）· 注册表 `lastActivity` / `language` 与 GitHub API 同名字段语义不同且未标注

| 来源 | 注册表 `lastActivity` | API `pushed_at`（最近活动） | 说明 |
|---|---|---|---|
| `github.gtopen` | `2026-09-11T03:06:25Z` | `2026-09-12T16:10:16Z` | 注册表用的是**被审计 commit 的时间**，比仓库最近活动早 1 天多 |
| `github.poker-lab` | `2026-09-09T21:40:09Z` | `2026-09-09T21:40:14Z` | 差 5 秒 |
| `github.dcfr-solver` | `2026-03-16T08:46:06Z` | `2026-03-16T08:46:11Z` | 差 5 秒 |
| `github.poker-solver` | `2026-06-18T17:59:17Z` | `2026-06-18T17:59:45Z` | 差 28 秒 |

`language` 字段是复合描述（如 poker-lab「TypeScript / Rust(WASM) / Next.js」），而 API `language` 是单一主语言（`Rust`）。报告 §0 声明用 `GET /repos` 确认「语言、活跃度」，读者会按 API 字段理解。
**修复建议**：字段名改为 `auditedCommitDate` / 或在 `notes` 注明这两个字段的口径（不影响可复现性，因为 `commitHash` 是精确的）。

---

### F-20 · INFO（诚实性的另一面）· `internal.spec-priority` 的**另一处** `url` 是真实的，但知识层至今没有任何生产消费者

- `internal.environment-priors` → `src/domain/range/gameEnvironment.ts` **确实**定义了 `LOW_STAKES_ONLINE / MID_LOW_STAKES / THEORY_REFERENCE` 三种环境，且 `THEORY_REFERENCE` 的描述里确实写着「本项目**没有求解器输出**……不得在界面上称为 GTO 最优」（我实测：`gameEnvironment.ts:199-218`）→ 该来源引用**属实**。
- 但 `src/` 中除 `src/domain/knowledge/` 自身外，**没有任何文件 import 知识层**（`grep -r "knowledge" src/` 只命中三个 knowledge 文件；`src/domain/index.ts` 也不导出它）。因此：约束「知识层不得进入决策热路径」**成立且是平凡成立**；同时「Fail-Closed 加载」「门禁清单」这些机制目前**只被测试执行**，没有生产调用方。
- `reports/REFERENCE_INTEGRATION_MAP.md:45-46` 说「已有源码扫描测试」——实际存在的是 `test/gameEnvironment.test.ts:387-409` 对 `gameEnvironment.ts` 的 import 扫描；**知识层没有对应的 import 扫描测试**（我人工核对：`knowledge.ts` 只 import `knowledge.types.ts`，`knowledgeLoader.ts` 只 import `node:fs`/`node:url`/`knowledge.ts`，结论正确但无守卫）。
**修复建议**：把该扫描测试推广到 `src/domain/knowledge/**`；在路线图里明确「知识层尚未接线」。

---

## 4. 未能证伪的假设（我试过但攻击失败的）

以下都是我**主动攻击但未能推翻**的，附攻击方法与规模。这些不是「没问题」的证明，而是「在本次攻击面内未被攻破」。

| # | 假设 | 攻击方法 | 结论 |
|---|---|---|---|
| 1 | 4 个仓库真实存在且 owner/名称与报告一致 | `GET /repos/{owner}/{repo}` ×4 | **未能证伪**：4/4 返回 200，`full_name` 与报告一致 |
| 2 | 4 个 commit 哈希真实存在于对应仓库 | 逐个 `GET /repos/{o}/{r}/commits/{sha}`（不是比对最新 commit） | **未能证伪**：4/4 返回 200 且 `sha` 完全一致；并且每个都**恰好等于该仓库默认分支当前 HEAD**（`shaIsLatest = true`），不存在「引用了过期 commit」 |
| 3 | GTOpen 无许可证 → RED | ① `license: null`；② 全树 3,242 项（`truncated:false`）文件名匹配 `licen[cs]e|copying|notice|unlicense` → 0；③ 根 README（7,595 字节）匹配 `licen/copyright` → **0**；④ 根 `Cargo.toml`（181 字节）匹配 `license/publish` → **0**；⑤ **我加做**：拉取全部源码/配置（1,194 个候选，成功 1,187 个）匹配 `licen[cs]e|SPDX|copyright|all rights reserved|Apache License` → **0**（唯一 8 条命中是 `/MIT\b/` 误匹配 `CONTINUATION_JOB_LIMIT` 之类的 `LIMIT"`）| **未能证伪**，RED 判定成立（比报告的四路核对更强）|
| 4 | 三个 MIT 仓库的许可证判定 | `license.spdx_id` = `MIT` ×3；逐个拉 `LICENSE` 原文并核对字节数 | **未能证伪**：1,071 / 1,066 / 1,062 字节与报告**完全一致**；DCFR README 结尾亦写 `## License / MIT` |
| 5 | 报告元数据（stars/forks/size/pushed_at/language） | 与 API 逐字段比对 | **未能证伪**：12/2、1/1、19/6、4/3；385,689 KB、142,057 KB、192 KB、29,307 KB；pushed_at 四项全中（语言见 F-18）|
| 6 | 报告中 6 本书的书目信息（含 ISBN） | 独立 web 检索 ISBN → 书名/作者；对能访问的书店页做内容匹配 | **未能证伪**：9781909457898→Modern Poker Theory（Acevedo）✅；9781909457775→Mastering Small Stakes NLH（Little），且官方副标题确认「Tournaments **and** Cash Games」（报告的范围混淆警告成立）✅；9781518655388→Strategies for Beating Small Stakes Poker Cash Games（Little）✅；9781909457232→Jonathan Little on Live No-Limit Cash Games: The Theory (Vol 1) ✅；Grinder's Manual 页面含 `Clarke`/`Grinder` ✅。**没有发现编造的 ISBN** |
| 7 | 报告引文是否逐字存在 | 把 4 个仓库全部 `md/txt/rst/toml/json`（共 1,661 个文件）落盘后做逐字检索（含跨行拼接）| **未能证伪**：§1.3（3 句 + 8 个标签）、§1.4（0.25/0.43/0.12/k≈9/2,942/1,500+/6%/0.89/0.74/0.72/0.26/0.21/0.03/0.05/0.03/25–50NL/HandHQ/PHH/300+ 手/8-max 150–200bb $2/2 与 $2/5/「单一类型满桌、不会自适应、绝对 EV 是上限」）、§3.1（12-15%/241 of 499/0.1 chips/100% 纯策略）、§3.2（forward/inverse/3-cycles S3/0.65%–0.73%）、§3.3（+163.8%/α=1.5 β=0 γ=2.0/SoA/compact mapping/RBP）、§4.1（References 全段/not redistributed/open_spiel Apache-2.0/noambrown MIT）、§4.2（两层 + diff tests/三个环境变量/bit-identical）、§4.4（PR 40 段全文，含 `r_jam`、`r_low`、`cdhs` vs `shdc`、22-42pp）、§4.5（minutes not instant）、§2（Poker Lab 的 fail-closed / never substitutes fabricated strategy / two independent seeds / component hash / low confidence），**全部逐字命中**。特别地：`Practice never substitutes fabricated strategy…` 确实是**跨行**（README 71–72 行），报告已如实记录该坑。唯一问题是行号（F-08）|
| 8 | 「22–42pp / max-L1 ≤ 1.9 / top-action ≥ 60% / 33 个百分点」是否只在 README（=误引） | 全语料检索 | **未能证伪**：这些数字不在 README，但确实存在于 `docs/aggregator_vs_true_nash_explainer.md:116-133,144-146`、`docs/v1_5_brown_current_state_2026-05-26.md:26`、`docs/_archive_2026-05-26/*` 与 `docs/v1_6_1_ship_hold_review_2026-05-26.md:84`；报告 §4.4 的引用**逐字来自 aggregator explainer**（我原先按 README 检索误判为「未找到」，已纠正）|
| 9 | RED 来源能否被标成 `CODE_REFERENCE` | ① 直接构造 `licenseGate:'RED' + CODE_REFERENCE`；② 用 JSON 声明 `licenseGate:'GREEN'` 试图骗过解析器 | **未能证伪**：两条路径都被 `COPY_NOT_ALLOWED` 拦下，`buildKnowledgeIndex` 抛错。解析器确实**不采信** JSON 里的门禁字段 |
| 10 | API license 与注册表是否一致 | 注册表 `license` 字段 vs `license.spdx_id` | **未能证伪**：4/4 一致（3×MIT、1×NONE）。**但注册表的 `licenseGate` 字段不一致**（F-02）|
| 11 | `data/knowledge/cases/` 是否真的不存在 | `Test-Path` | **未能证伪**：不存在，报告声明属实 |
| 12 | 内部来源指向的仓库文件是否存在 | `existsSync` + 人工核对内容 | **部分证伪**：`gameEnvironment.ts` 属实（F-19）；**`docs/ARCHITECTURE.md` 不含其声称的规范**（F-01，升级为缺陷）|
| 13 | 是否存在被复制进来的第三方代码树 | `Test-Path references/vendor/third_party/libs/external` | **未能证伪**：均不存在（不能排除逐行改写，未做相似度检测）|
| 14 | 索引对象/访问器能否被替换 | 写 `idx.size`、替换 `idx.allSources` | **未能证伪**：均被冻结拦住（嵌套对象除外，见 F-04）|
| 15 | 空/损坏输入是否会静默降级 | `{}`、`[]`、`null`、`42`、`"x"`、`{sources:{}}`、`{sources:[null]}`、`{sources:[{}]}`、`{rules:{}}`、`{rules:[{}]}`、缺字段、类型错误的字段、`1e999`、字符串 magnitude、2000 层嵌套、零宽字符/emoji id | **基本未能证伪**：全部被拒或按预期处理；**唯一漏网**是「文件内容为字面 null → 零诊断」（F-10）与 U+200B/emoji id 被接受（`requireString` 只对 trim 后的空串报错，`' a '` 会被原样存为 id —— 见下）|
| 16 | 是否有测试断言了与需求相反的东西 / `assert.ok(true)` 式假绿 | 逐条审查 50 项测试 | **未能证伪**：未发现空断言或反向断言；发现的是**断言过弱**（§5）|
| 17 | 报告中「被审计项目自述」的数字是否被当成事实 | 逐个数字回源 | **未能证伪**：每个外部数字都真实存在且报告都标注了「未在本项目复现」（唯一例外是报告自己的两个数字，F-07）|

---

## 5. 测试质量评估

**规模**：`test/knowledge.test.ts` 50 项，全绿；全量 878 项全绿；`tsc --noEmit` 零错误。

### 5.1 假绿（断言过弱 / 不可失败）

| # | 位置 | 问题 | 放过了什么 |
|---|---|---|---|
| 1 | `knowledge.test.ts:419` | 非法枚举只断言 `message.includes('已登记取值')`，不断言 `code` | **F-12**：错误码语义错误（枚举路径用 `MISSING_LIMITATIONS`）|
| 2 | `knowledge.test.ts:577-582` | 冻结测试只查 `Object.isFrozen(index/allSources()/allRules())` 三层 | **F-04**：`scope`/`limitations`/`sources` 可写、`rulesUsing()` 外泄内部数组 |
| 3 | `knowledge.test.ts:634-649` | 范围审计只查 `JSON.stringify(scope).includes('gameType'|'tableSize')` | **F-06**：`tableSize: 42` / 任意嵌套结构都算「已登记适用范围」|
| 4 | `knowledge.test.ts:588-604` | 内部来源只做 `existsSync` | **F-01**：引用了不含该内容的文件 |
| 5 | `knowledge.test.ts:615-632` | 盗版站点「提到就必须写明未使用」分支在现有数据上永不执行（notes 不含任何被禁域名） | **F-16**：不可证伪的守卫 |
| 6 | `knowledge.test.ts:571-572` | `(summary.byEvidenceLevel[s.evidenceLevel] ?? 0) >= 1` 用 `?? 0` 兜底，统计键缺失也会通过（`>= 1` 才拦） | 弱化了 summary 一致性检查（实际仍有效，因为 `>= 1`）|
| 7 | `playerClassifier.test.ts:894-907` | CASE_TAXONOMY §2.2 声称「改变标签阈值后，调整因子**逐位**不变」，测试只比较 `rangeWidthFactor` **一个**因子 | 其余 4 个因子若随阈值跳变不会被发现 |

### 5.2 覆盖缺口（无测试覆盖的攻击面）

1. `sources: []` 的规则（**F-03**，MAJOR 级缺口，无任何测试）。
2. 注册表 JSON 声明字段与解析结果的一致性（**F-02**，无任何测试）。
3. 嵌套冻结 / 索引可变性（**F-04**）。
4. `scope` 字段类型（**F-06**）。
5. 文件内容为字面 `null`（**F-10**）。
6. `requireEnum` 的错误码（**F-12**）。
7. 未登记的证据等级（**F-13**）。
8. 数据文件首字节（BOM）与 `$schema` 目标存在性（**F-11**）。
9. `src/domain/knowledge/**` 的 import 边界扫描（**F-20**）。
10. 内部来源 URL 的**内容**是否支持其声明（**F-01**）。

### 5.3 是否固化了错误行为

未发现「测试断言了与需求相反的东西」。但有两条测试把**当前行为**固化成了契约，值得复核：
- `knowledge.test.ts:667-674`「空知识库是合法的」——与约束 #10（任何一处损坏即拒绝）并不冲突（空 ≠ 损坏），但它与 F-03 合起来意味着「空库」和「无来源规则」都是合法状态。
- `knowledge.test.ts:154-185`「解析器不得采信 JSON 里的门禁字段」——这条本身是对的（防手写放宽），但它在语义上**同时**固化了「声明字段可以不等于推导值而不报错」，正是 F-02 的温床。建议在同一测试里补上「声明值必须与推导值一致」的反向断言。

---

## 6. 结论

### 6.1 当前是否存在已知缺陷

**存在。** 本轮未发现 CRITICAL 级缺陷（没有编造的来源 / commit / ISBN / 许可证判定，也没有凭空捏造的数字——所有外部数字我都回源逐字核对过），但发现：

| 级别 | 数量 | 条目 |
|---|---|---|
| **CRITICAL** | **0** | — |
| **MAJOR** | **6** | F-00（审计期被并发改写）、F-01（PRIMARY 内部来源引用不成立）、F-02（声明门禁 ≠ 实际门禁，合规清单误报自家规范）、F-03（零来源规则可通过校验）、F-04（冻结只到第一层）、F-05（RED 来源数值被复制，与自身禁令矛盾）|
| **MINOR** | **12** | F-06（scope 未校验）、F-07（报告两个自有数字错误）、F-08（自检行号错误）、F-09（标签表与代码不一致）、F-10（null 文件零诊断）、F-11（BOM 不一致 + $schema 悬空）、F-12（枚举错误码语义错误）、F-13（evidenceRank 静默放行）、F-14（magnitude 闸门强度）、F-15（证据等级口径不一）、F-16（盗版防护空转）、F-17（magnitude 文档口径错误）|
| **INFO** | **3** | F-18（清点偏乐观 1 条）、F-19（元数据语义）、F-20（无生产消费者 / 缺 import 扫描测试）|

### 6.2 三句话总结

1. **来源真实性与数字真实性这一仗，开发者打得比报告自己写的还好**：4 个仓库、4 个 commit（逐个 sha 验证存在且都是 HEAD）、3 个 MIT + 1 个无许可证的判定、6 本书的书目、以及报告中每一个外部数字，我都独立核实过，**没有发现一处编造**；GTOpen 的 RED 判定我用源码级穷举扫描（1,187 个文件）加固后依然成立。
2. **真正的缺陷集中在「机制层」而不是「事实层」**：一个 PRIMARY 内部来源引用了不含该内容的文件（F-01）、注册表声明的门禁与运行期生效的门禁相差 2 个来源且不一致被静默吞掉（F-02）、不引用任何来源的规则可以进索引（F-03）、冻结承诺只兑现了第一层且测试给了虚假安全感（F-04）、以及报告一边写「不得引用其数值」一边把 9 个数值抄进数据文件（F-05）。
3. **Fail-Closed 的骨架是真的**（损坏输入、悬空引用、重复 id、Infinity、非法枚举都能拦住，RED→CODE_REFERENCE 无路径，`{ok:false}` 未被任何调用方忽略），但它的**三条承诺被高估了**：可追溯性（F-03）、不可变性（F-04）、可推导性（F-14）在实现上都比文档弱一档；此外本阶段产物在审计过程中被并发改写（F-00），建议今后为每个阶段产物登记 SHA256 并在冻结窗口内禁止改写。

---

## 附录 A：复现脚本清单（审计后已删除）

| 脚本 | 用途 |
|---|---|
| `tmp-rt-knowledge/gh-check.mjs` → `gh-check.out.json` | 4 仓库 metadata / commit sha 存在性 / 完整树 / 许可证文件名扫描 |
| `tmp-rt-knowledge/fetch-raw.mjs`、`grep-corpus.mjs` → `raw-corpus.json` | 拉取 1,661 个文本文件并全文检索 |
| `tmp-rt-knowledge/gtopen-license-scan.mjs` | GTOpen 1,187 个源码/配置文件的许可证头穷举扫描 |
| `tmp-rt-knowledge/books-check.mjs`、`books2.mjs` | 6 本书的书目与 URL 核实 |
| `tmp-rt-knowledge/attack2.mjs`、`attack3.mjs`、`attack-code.mjs`、`verify-f14.mjs` | 代码攻击用例（边界许可证 26 例 / Fail-Closed 损坏输入 / 冻结 / 语义矛盾 / 证据等级 / 错误码）|

## 附录 B：本轮审计使用的独立命令

```powershell
node.exe --test --experimental-strip-types "test/**/*.test.ts"      # 878 / 878 pass
node.exe --test --experimental-strip-types "test/knowledge.test.ts" # 50 / 50 pass
& npx.cmd tsc --noEmit                                             # exit 0
# 不含知识层的既有测试（25 个文件显式传入）：828 / 828 pass
```
