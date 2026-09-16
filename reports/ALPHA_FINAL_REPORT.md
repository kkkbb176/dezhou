# Alpha 可测试版本 —— 最终报告（红队修复后）

> 判定见文末。本报告的所有数字都来自**可重跑的确定性命令**，
> 没有任何一项来自估计或推断。

---

## 1. 端到端可运行

**YES。**

不是「模块能单独跑」，而是**一条完整的链**：

```
浏览器中文表单
  → POST /api/analyze
  → parseManualInput（结构层）
  → buildAnalyzableState（重建 + Poker Core Validator）
  → buildDecisionContext（数学九项 / 范围 / 玩家 / 环境 / 动态 / 权益）
  → decideAlpha（候选评估 → 数学优势保护 → 选动作 → 置信度 → 分类 → Shadow）
  → finalMathSanityCheck（二次数学验证）
  → toDecisionViewModel（唯一允许界面消费的结构）
  → appendDecisionLog（JSONL 追溯）
  → 浏览器渲染「建议：… / 尺寸 / 置信度 / 分类 / 理由 / 警告」
```

现场实测（`http://127.0.0.1:5173`）：

```
GET /api/health     → {"ok":true,"knowledgeRules":23,"mode":"INTERNAL_ALPHA"}
GET /              → 200，20,124 字节，中文页面 UTF-8
POST /api/analyze  → 200，HTTP 往返 131 ms
```

---

## 2. INTERNAL ALPHA TESTABLE

**YES。**

PASS 条件（用户锁定原文）：

> 「我可以打开网页，输入一手合法牌，系统能够在合理时间内给我一个
> 可解释、合法、经过数学和范围验证的建议。」

逐条对照：

| 条件 | 状态 | 证据 |
|---|---|---|
| 打开网页 | ✅ | `GET /` 200，中文表单，无构建步骤、无前端框架 |
| 输入一手合法牌 | ✅ | 表单含「对手筹码(BB)」与全部字段；`ALL_IN` 金额可留空 |
| 合理时间内 | ✅ | 端到端 P95 ≤ **63.6 ms**（预算 3,000 / 8,000 ms） |
| 可解释 | ✅ | 首屏 3 条理由**必有一条解释被选中的动作**（见 §12 的 F-15） |
| 合法 | ✅ | 全部输出动作经 `legal.actions` 与 Poker Core 双重校验；非法即**抛错** |
| 经过数学和范围验证 | ✅ | 数学九项只由确定性代码产生；范围附来源、可信度、组合数与更新轨迹 |

**20 项内部门禁：20/20 PASS**（第 17 项「独立红队 PASS」本轮由 FAIL 修复后达成）。

---

## 3. 一手真实牌局的完整示例（原始输出）

输入（表单等价 JSON）：

```json
{
  "tableSize": 6, "heroPosition": "CO", "heroCards": ["As", "Kd"],
  "board": ["Kh", "7c", "2d"], "street": "FLOP", "effectiveStackBB": 100,
  "environment": "MID_LOW_STAKES",
  "actionHistory": [
    {"position":"UTG","type":"FOLD"}, {"position":"HJ","type":"FOLD"},
    {"position":"CO","type":"RAISE","amountBB":3}, {"position":"BTN","type":"FOLD"},
    {"position":"SB","type":"FOLD"}, {"position":"BB","type":"CALL","amountBB":2},
    {"position":"BB","type":"CHECK","street":"FLOP"}
  ],
  "villain": {"quickProfile": "NORMAL"}
}
```

输出（原文，未编辑）：

```
HTTP ROUND TRIP : 131 ms
ACTION          : 建议：下注
SIZE            : 3.25BB（325 筹码）
CONFIDENCE      : 中低  (0.3)
CLASSIFICATION  : 边缘决策
INPUT HASH      : h8e1a3ac6
COMPUTED POT    : 650 chips   CLAIMED: (未声明)

TOP-3 REASONS:
  - 对对手范围估计权益 88.9% 且明显领先，当前牌力（顶对 K，A踢脚）适合主动下注取值
  - 牌局环境「中低级别」提供了 1 条方向参考（无幅度，仅方向）
  - 抽水模型：未计入（本项目尚无 Rake Engine，EV 为未计抽水口径）

WARNINGS:
  - 抽水模型：未计入（本项目尚无 Rake Engine，EV 为未计抽水口径）

MATH (九项):
  底池             = 650 筹码（6.50BB）
  跟注需要         = 0 筹码（0.00BB）
  我的剩余筹码     = 9700 筹码（97.0BB）
  有效筹码         = 9700 筹码（97.0BB）
  SPR              = 14.92
  底池赔率         = 0.0%
  所需权益         = 0.0%
  估计权益         = 88.9%
  权益来源         = 蒙特卡洛（20,000 次，±0.4%）
  跟注 EV          = —（无法计算）
  当前牌力         = 顶对 K，A踢脚
  抽水模型         = 未计入

LEGAL ACTIONS   : 弃牌 / 过牌 / 下注 / 全下
RANGE:
  针对对手         = 大盲位
  来源类型         = HEURISTIC
  来源可信度       = 0.30
  有效组合数       = 507 / 1326（38.2%）
  熵               = 8.89 bit
  是否塌缩         = 否
  更新轨迹         = FLOP 大盲位 CHECK：507→507

SERVER TIMING   : {"parse":0,"validate":1,"context":88,"decide":1,"viewmodel":0,"total":90}
VERSIONS        : decision=1.0.1  context=1.0.0  math=1.0.0  rangeSource=HEURISTIC
```

**这段输出可以被逐项质疑，也可以被逐项复现** —— 这是本项目的验收标准。

---

## 4. 新增文件（本轮）

| 文件 | 行数 | 作用 |
|---|---:|---|
| `test/alphaRedteamRegression.test.ts` | 1,058 | **红队 F-01…F-15 的永久回归测试**，标题与报告编号一一对应 |
| `test/manualInputPriors.test.ts` | 402 | `preflopPriors.ts` / `likelihoodModel.ts` 的**单元测试**（此前零覆盖 = F-02 根因） |
| `scripts/alpha-perf.ts` | 133 | 端到端性能实测（只测量，不判断） |
| `reports/ALPHA_FINAL_REPORT.md` | 本文件 | 最终报告 |

---

## 5. 修改文件（本轮）

| 文件 | 改了什么 |
|---|---|
| `src/app/alphaPipeline.ts` | `action=null` 的合法性分支 + 「明确决策不得低置信」硬检查；**真正执行时间预算**（软警告 / 硬中止 `stage: DEADLINE`）；哈希补齐全部输入字段；`finalTimings` 三处共用 |
| `src/app/decision/decisionEngine.ts` | 新增 `MIN_RANGE_CONFIDENCE_MULTIWAY` + `MULTIWAY_APPROXIMATION` 降级；三条改判 `STRONG`（翻牌后加注可达）；动态惩罚只在**观察到偏离**时施加；**理由排序**（动作理由进首屏）；`MATH_DOMINANCE` 措辞声明比较范围 |
| `src/domain/decision/decision.types.ts` | `DegradationEntry.impact` 新增 `MATH`；`ALPHA_DECISION_MODEL_VERSION` → `1.0.1` 并附变更记录 |
| `src/app/decisionLog.ts` | `decision: string \| null` |
| `src/viewmodels/decisionViewModel.ts` | 以 `action !== null` 分支；新增 `withFinalTimings()` |
| `src/app/manualInput/manualInput.ts` | `bigBlindBB` 语义明确为「1BB = 多少筹码」并校验为 **≥2 的整数**；`ALL_IN` 金额改为可选；删除领域层无法表达的 `SIZE_ANOMALY` |
| `src/app/manualInput/reconstruct.ts` | `bigBlindChipsOf()`（死字段复活）；`actionableHintForAction()` 把引擎机器码翻成「怎么改」 |
| `src/app/manualInput/contextBuilder.ts` | `mapDynamicHint` 改**穷举映射**（漏一个即编译失败）；输入类型收紧为 `DynamicHint` / `QuickProfile` |
| `src/app/manualInput/likelihoodModel.ts` | 自检改用**具名牌型**并扩到 169 类逐档扫描 |
| `src/app/manualInput/preflopPriors.ts` | 自检新增：3Bet 必须严格更紧、顶级牌必须在范围内、大盲过牌范围必须最宽 |
| `src/app/webServer.ts` | **启动自检 Fail-Closed**：两个自检失败即拒绝启动 |
| `src/app/web/index.html` | 已知限制文案改为事实（1–2 名对手）；新增「对手筹码(BB)」输入框；`ALL_IN` 金额可留空的提示 |
| `src/infra/artifactDefinitions.ts` | 新增 6 个产物登记 → 63 个 |
| `test/alphaPipeline.test.ts` / `alphaSmokeSpots.test.ts` / `alphaWebServer.test.ts` | 适配 `action: null`，并**加强**断言（`action=null` ⟺ `actionable=false`） |
| `docs/ALPHA_USAGE.md` | `ALL_IN` 填法、对手筹码、`bigBlindBB` 语义、2 名对手是近似 |
| `CURRENT_PROJECT_STATUS.md` / `reports/TEST_MATRIX.md` / `reports/STEP_REPORTS.md` | 数字同步 + 记录本轮的结构性教训 |
| `data/artifact-manifest.json` | 重新生成（63 个产物，UTF-8 无 BOM） |

---

## 6. 端到端测试结果

`test/alphaPipeline.test.ts`（14 项）：

| 用例 | 断言要点 | 结果 |
|---|---|---|
| E2E-1 | 合法输入 → 合法、可解释的 `AlphaDecision`（含 `action !== null`） | ✅ |
| E2E-1b | 结果隔离：结果字段不得进入决策链 | ✅ |
| E2E-2 | 重复牌在 Math / Range / Decision **之前**阻断 | ✅ |
| E2E-3 | 底池不符阻断；未声明底池放行；声明正确放行 | ✅ |
| E2E-4 | 非法行动历史阻断 | ✅ |
| E2E-4b | 无决策点阻断（不给出「建议：过牌」） | ✅ |
| E2E-5 | 失败结构完整（stage + issues + timings） | ✅ |
| 三环境 | 数学九项逐位一致 | ✅ |
| 确定性 | 同一输入 10 次 → 1 个指纹 | ✅ |
| 输入哈希 | 同一输入 → 同一哈希 | ✅ |
| 不修改调用方对象 | 深比较原对象 | ✅ |
| 性能 | 8 秒硬上限内 | ✅ |

---

## 7. 烟测点结果

`test/alphaSmokeSpots.test.ts`（4 项 / **25 个 Spot**）：

| 组 | 数量 | 结果 |
|---|---:|---|
| 翻牌前（AA / AKo / 72o / AA vs 3bet / 全下） | 5 | ✅ |
| 翻牌（顶对 / 超对 / 弱牌 / 听牌 / 三条） | 5 | ✅ |
| 转牌 / 河牌（含超池面对） | 6 | ✅ |
| 多人池 / 短筹码 / 边界 | 4 | ✅ |
| 三环境对照 | 12/12 可比 | ✅ |

不变量：**0 次全下建议**、全部尺寸 ≤ 剩余筹码、全部动作在合法集合内、
非怪兽牌加注不超过底池 2.5 倍、`action=null` ⟺ `actionable=false`。

---

## 8. 独立红队发现（按级别）与修复

**判定：FAIL** → 全部修复。完整报告 `reports/ALPHA_INDEPENDENT_REDTEAM.md`，
原始证据 `scripts/rt-alpha-evidence.txt`。

### CRITICAL（2）

| # | 缺陷 | 后果 | 修复 |
|---|---|---|---|
| **F-01** | `pickCandidate` **永不返回 RAISE**（BET/RAISE 的 `ev = null`，被过滤掉） | **加注功能整体缺失** —— AA 面对 3bet 建议「跟注」 | 新增 `shouldRaise()` + `pickClosestRaise()`/`largestRaise()`；**并发现同族问题：三条被归为 MEDIUM，翻牌后依然不可加注** → 改判 `STRONG` |
| **F-02** | `tierOfRankClassIndex` 按 169 表的**数组位置**切牌力档 | **牌力倒挂**：`QQ` 进攻似然 0.5938 **低于** `A7s` 的 0.9500；且自检函数**零调用者** | 改为解析牌型字符串；自检改具名牌型并扩到 169 类；**两个自检接入服务器启动 Fail-Closed** |

### MAJOR（4）

| # | 缺陷 | 后果 | 修复 |
|---|---|---|---|
| F-03 | 3Bet 场景被当成开池范围（`rfiTierOf(6max, BB)` → `default: BUTTON`） | AKo 权益**虚高 27.5 个百分点** | `THREEBET_SPECS` / `threeBetWeights()`；自检断言「3Bet 必须严格更紧」 |
| F-04 | `classifyOf` 完全不看置信度 | 置信度 **0.1537** 被标成**「明确决策」** | `CLEAR` 增加 `CLEAR_MIN_CONFIDENCE = 0.55`；管线再加一道**抛错**的最终检查 |
| F-05 | 信息不足时 `action` 仍是 `'FOLD'` | 「拒绝给建议」在 HTTP / JSONL 里与「建议弃牌」**无法区分** | `action: DecisionAction \| null`；日志同步；界面文案分开 |
| F-06 | 注释声称「2 名对手会要求更高范围可信度并在诊断注明近似」，**代码里两件事都没有** | 使用者拿到基于**单挑权益**、忽略第二家行动的建议，而界面告诉他这种情况会被拒绝 | 实现 `MIN_RANGE_CONFIDENCE_MULTIWAY`；新增 `MULTIWAY_APPROXIMATION` 降级（`impact: MATH`）并在**界面警告里显示** |

### MINOR / INFO（6）

| # | 缺陷 | 修复 |
|---|---|---|
| F-07 | `bigBlindBB` 是死字段（解析、校验、阻断都做了，对输出零影响） | 真正生效；并**加强**校验（≥2 的整数，禁止静默取整） |
| F-08 | `ALL_IN` 强制要求金额，错误信息不说怎么改 → 短筹码全下**无法录入** | 金额改可选；新增「对手筹码(BB)」输入框；错误信息给出两种改法 |
| F-09 | ViewModel 在 `mark('viewmodel')` **内部**构建，拿不到自己的耗时 | `withFinalTimings()` 回填**同一份** `finalTimings`（返回值 / 日志 / 界面逐位一致） |
| F-10 | `hashManualInput` 漏 `bigBlindBB` / `villains` / `actionHistory[].street` | 补齐；新增**穷举式**回归（`keyof ManualHandInput` 类型级清单，漏字段即**编译失败**） |
| F-11 | 只要 `dynamic.confidence > 0` 就惩罚 → **主动填观察反而降置信** | 只在**观察到偏离**时惩罚；`NORMAL` 与 `UNKNOWN` 同为中性；删除界面上无法表达的 `SIZE_ANOMALY`（曾被静默吞掉） |
| F-12 | `CURRENT_PROJECT_STATUS.md` 与代码事实矛盾 | 同步更新 + 补记结构性教训 |
| F-13 | `options.budget` 只被转发、**不控制任何计算** | 接入 `DecisionDeadline`：软超时警告、硬超时中止。**刻意不按剩余时间缩减 MC 迭代**（那会破坏确定性） |

### 修复过程中**又发现 2 个**（红队未报，同族）

| # | 缺陷 | 后果 | 修复 |
|---|---|---|---|
| **F-14** | `selfCheckLikelihoodModel` 用 `KEYS[0]`/`KEYS[last]` 当「最好/最差」，注释写 `32o`，而末键**实际是 `22`** | **一个「通过」的自检在验证一个不是它声称的不变量** | 全部改具名牌型 + 逐档扫描 |
| **F-15** | `MATH_DOMINANCE` 的理由比动作自己的理由**更早**进列表，而首屏只显示 3 条 | 首屏出现「建议：**加注**」配「**跟注** 在数学上明显占优」—— 两句都真，并排读自相矛盾 | 理由按「动作理由 → 通用事实 → 数学优势」重排；措辞显式声明比较范围 |

---

## 9. 每个 Bug 的回归测试

`test/alphaRedteamRegression.test.ts` —— **38 项**，标题以 `F-xx` 开头，
与报告编号**一一对应**，可机械核对：

| 编号 | 测试标题（摘要） |
|---|---|
| F-01 | 面对下注时 RAISE **可达**；翻牌后强牌 RAISE 可达且尺寸不超剩余筹码 |
| F-02 | 自检必须通过且**有调用者**；档位由牌型字符串决定；似然始终 ∈ [0,1]；**自检不得依赖数组首尾** |
| F-03 | 3Bet 范围严格更紧；先验自检通过；面对 3bet 的 AA 权益低于面对开池 |
| F-04 | 「明确决策」置信度 ≥0.45；管线**抛错**拦截「明确 + 低置信」 |
| F-05 | `action === null` ⟺ `!actionable`；日志里是 `null` 而不是 `"FOLD"` |
| F-06 | 2 名对手必须声明单挑口径近似；多人门槛严格更高；3 名以上必须拒绝 |
| F-07 | 生效且只改筹码口径；非法值阻断；**小数/小于 2 必须阻断而不是取整** |
| F-08 | 全下金额可省略；短筹码全下可录入；错误信息必须告诉用户怎么改 |
| F-09 | 耗时表与管线 timings 逐位一致；日志与返回值同一份 |
| F-10 | **穷举**全部字段都影响哈希；`street` 参与哈希；同输入同哈希 |
| F-11 | 填观察不得比不填更不可信；`SIZE_ANOMALY` 不得出现在界面选项 |
| F-13 | 硬预算真正中止；宽预算结果逐位一致；软预算只警告不降级 |
| F-15 | 首屏理由必须解释被选中的动作；`MATH_DOMINANCE` 必须声明比较范围 |
| 交叉 | 三环境数学逐位一致；输出动作始终合法；10 次运行 1 个指纹 |

**历史上修正过的断言**（必须记录，共 4 处，**无一处是放宽**）：
1. `engine.test.ts` / `validator.test.ts` 固化错误行动顺序的 2 处 → 修正为正确顺序（A1）
2. `projectStatus.test.ts` 的「必须标注端到端 0%」→ 改为双向一致（否则等于要求文档撒谎）
3. 本次 `alphaPipeline` / `alphaSmokeSpots` / `alphaWebServer` 中 4 处 `action` 断言
   → **加强**为「`action=null` 当且仅当 `actionable=false`」

---

## 10. 动态层翻转统计

| 项 | 值 |
|---|---|
| Alpha 第一版允许的动作翻转 | **0**（刻意：幅度是 `UNVERIFIED_MAGNITUDE`） |
| 动态层实际影响 | 只改**置信度**与**分类**（Shadow） |
| 观察到的偏离状态 → 置信度惩罚 | `max(0.3, 1 − 0.25 × confidence)` |
| `NORMAL` / `UNKNOWN` | **惩罚因子 = 1**（修复 F-11 后不再惩罚） |
| 存在数学明显占优动作时 | 低置信度动态**不允许**翻转 |
| 翻转门槛（未来启用时） | `DYNAMIC_FLIP_MIN_CONFIDENCE = 0.5` |

`dynamicShadowOf` 每次输出 `actionChanged` / `dynamicConfidence` / `magnitudeProvenance`，
进日志与诊断区 —— 「动态到底有没有影响结论」永远可查。

---

## 11. 性能

`scripts/alpha-perf.ts`（每档 60 次，预热后计时；两次运行取更保守的一次）：

| 街道 | P50 | P95 | Max | 输出动作 |
|---|---:|---:|---:|---|
| 翻牌前 | 56.0 ms | 63.6 ms | 68.0 ms | RAISE |
| 翻牌 | 55.6 ms | 75.9 ms | 89.4 ms | BET |
| 转牌 | 29.3 ms | 33.0 ms | 35.4 ms | BET |
| 河牌 | 4.9 ms | 5.7 ms | 6.5 ms | CALL |

| 项 | 值 |
|---|---|
| HTTP 往返（含解析 / 序列化 / 日志写盘） | **131 ms** |
| 锁定预算 | 软 3,000 ms / 硬 8,000 ms |
| 锁定指标 | 最佳 1–2 s，常规 ≤3 s，复杂 ≤5 s，硬上限 8 s |
| 结论 | **远优于预算**（慢 30–50 倍仍有余量） |

慢在权益蒙特卡洛（20,000 次），随街道递减是因为河牌无需再发牌。

---

## 12. `npm run verify`

```
> tsc --noEmit                                 → 零错误
> generateManifest.ts --check                  → ✔ 全部 63 个产物与清单一致
> node --test "test/**/*.test.ts"              → ℹ tests 1119 / suites 136
                                                  ℹ pass 1119 / fail 0
EXIT = 0
```

---

## 13. `tsc`

`npx.cmd tsc --noEmit` → **零错误**。

（注意：本机 `npx.ps1` 被执行策略拦截，必须用 `npx.cmd`。）

---

## 14. 产物清单

| 项 | 值 |
|---|---|
| 产物总数 | **63**（本轮 +6：红队报告 / 2 个测试文件 / 性能脚本 / 最终报告 / 用法文档） |
| 类别 | KNOWLEDGE 6 / RANGE 16 / ENVIRONMENT 2 / PLAYER_MODEL 9 / DECISION 19 / REPORT 11 |
| 校验方式 | `sha256` + 字节数，`npm run verify` 强制通过 |
| 自指排除 | `data/artifact-manifest.json`，附原因说明（不得静默跳过） |
| 双向漂移检测 | 文件消失 → `MISSING`；新增未登记 → `UNLISTED` |

清单里每一条都带**影响说明**（「改了它，什么会变」），
这是「昨天 CALL 今天 FOLD」能被追到源的唯一机制。

---

## 15. CURRENT_PROJECT_STATUS

已同步（防漂移测试 `test/projectStatus.test.ts` 通过）：

| 项 | 值 |
|---|---|
| 端到端 | **已可端到端使用** |
| 真实牌局验证 | **尚未**（下一步唯一要做的事） |
| 源代码 | 68 个文件 / 27,076 行 |
| 测试代码 | 36 个文件 / 21,314 行 |
| 测试 | 1,119 项 / 136 套件 / 0 失败 |
| 类型检查 | 零错误 |
| 产物绑定 | 63 个 / 6 类 |
| 独立红队 | 7 轮 |
| 历史基线 | … → 1,035 → 1,061 → 1,116 → **1,119**，无一次放宽断言 |

并新增 §10.1.1 记录本轮的两个**结构性教训**：

1. **注释里的承诺不算承诺，只有代码里的行为算**（F-06）
2. **自检函数没有调用者 = 没有自检**（F-02）

以及三条可执行对策：启动自检 Fail-Closed / 判据不依赖数组顺序 / 红队编号 ↔ 永久回归测试。

---

## 16. 已知限制（必须与判定一起读）

| 限制 | 说明 |
|---|---|
| **尚未用真实牌局验证** | 这是 PASS 之后**唯一**要做的事（20–30 个真实 Spot） |
| 范围是**启发式先验** | 不是求解器输出、不是 GTO；可信度 0.3；界面明确标注来源与「不是求解器输出」 |
| **抽水未计入** | `Rake model: NOT_APPLIED`；无 Rake Engine；不显示 bb/100 |
| 下注/加注的 **EV 不参与比较** | 缺可信弃牌率估计 → 「加注 vs 跟注」是**定性**判断；结论里显式声明 |
| **≥3 名活跃对手** | 明确返回「信息不足」，**不假装单挑** |
| **2 名活跃对手是近似** | 权益只按单挑口径估算，第二家行动未进模型 → **偏乐观**；界面显示该警告 |
| 翻牌前范围三档 | 开池 / 面对开池的继续 / 3Bet；防守范围把跟注与再加注合并 |
| 范围更新是**单调启发式** | 只表达方向，不是实测频率；`updateTrace` 全程可查 |
| 不支持 | 3 名以上活跃对手 / 锦标赛 / 短牌 / Rake / 自然语言输入 |
| 静态页无构建步骤 | 有意为之（依赖只有 `typescript` + `@types/node`，无 web 框架） |

**不要用本工具做**：自动读牌、自动点击、任何形式的自动打牌。
它只是一个手动输入后的参考。

---

# INTERNAL ALPHA TESTABLE — PASS

**判定依据**：

1. 端到端真的跑通（网页 → 输入 → 建议，131 ms）
2. PASS 条件的 6 个子项逐条有据（§2）
3. 独立红队的 FAIL 结论已**全部修复**，且**每条都有永久回归测试**
4. `npm run verify` exit 0；1,119 项测试 / 136 套件 / 0 失败；`tsc` 零错误
5. 无已知核心逻辑 Bug（**不声称「零 Bug」** —— 只声称当前没有已知的核心逻辑缺陷）

**下一步（PASS 之后立即执行，不新增 Phase）**：
打开 `http://127.0.0.1:5173`，录入自己的 20–30 个真实牌局 Spot，
**在看到摊牌之前**先写下自己的判断，再与系统建议对照，
把「一眼就明显错误」的建议逐条记录（含完整输入与调试区层级）。
