# 快速录入与快速决策 UI V2 验收报告

生成日期：2026-09-24（Asia/Shanghai）  
项目：`D:\德州决策`  
基线：`main` / `7dffffc965116c0a688d3357244624153def6a52`

## 结论

本轮已完成深灰＋蓝色的快速录入界面、固定录入区、精确金额输入、当前行动者自动跟随、建议状态管理、录入与分析解耦，以及请求重试和分析调度保护。没有切换分支，没有提交或推送，也没有清理开始时已有的未提交修改。

最终全量验证为 **2,271 项通过、0 失败（137 套件）**。真实 Chrome/CDP 验收覆盖主要录入、错误恢复、慢请求、布局和旧/新 UI 输入一致性。固定机器上的本地反馈 P95 为 **16.6 ms**，行动保存 P95 为 **17.7 ms**；3 个已支持且持久化范围缓存命中的 9 人桌节点，各重复 10 次，建议可见耗时 P95 为 **955.0 ms**。没有通过降低迭代、改模型、返回旧建议或复用旧决策来换取速度。

这不是“绝对零 bug”承诺。未完成的测量和仍存在的系统边界见“未覆盖与风险”。

## 基线与保护

- 改造前分支、HEAD、工作区状态、机器信息和逐文件 SHA-256：`reports/fast-input-decision-v2/baseline-before-metadata.json`。
- 改造前完整验证：`reports/fast-input-decision-v2/baseline-before-verify.log`，当时 2,254 项全部通过。
- 改造前 Web 源码冻结副本：`reports/fast-input-decision-v2/baseline-before-web-source/`。
- 改造前生产计算链冻结副本和来源说明：`baseline-before-frozen-production/`、`baseline-before-frozen-provenance.json`。
- 已保留开始时存在的决策引擎、GTO 缓存、报告和测试修改。本轮没有顺手调整胜率、EV、范围、画像、下注规则或求解质量。

## 实际完成的操作流程

1. 顶部保留牌桌、玩家档案、GTO 范围、当前决策/录入历史、桌型和牌桌设置等真实入口；未实现的训练/复盘入口没有伪装成可用按钮。
2. 左侧为紧凑牌桌、座位/筹码、手牌、公共牌和可折叠行动时间线；底部是固定快速录入区；右侧固定显示当前建议、状态、金额、简短原因和真实范围来源，详细证据折叠展示。
3. 当前行动者完全取自后端预览。弃牌、过牌、跟注成功后才应用服务端 revision 并移动到下一位；请求没确认时不会先跳位。
4. 动作区固定为“弃牌 / 过牌或跟注 / 确认下注或加注 / 全下”。按钮只按后端合法动作启用；短码跟注显示“跟注全下”，但仍按引擎的 `CALL` 语义一次点击记录；主动点击“全下…”必须在包含玩家和金额的弹窗内二次确认。
5. 金额框支持键入、粘贴、回车、筹码/BB 切换、另一单位换算和本街已投入/本次需补。金额用十进制字符串和整数筹码转换，不经浮点四舍五入。快捷金额只填值，不自动提交。
6. 空值、负数、NaN、Infinity、科学计数、超安全整数、零碎筹码、低于最小加注和超过筹码均明确拒绝。输入等于全下金额时要求走单独的全下确认。
7. 选牌面板会自动定位下一槽，禁止重复，支持替换、清除和撤销；牌局进行中筹码编辑由既有后端规则禁止，并给出重置本手/下一手路径。
8. 行动保存与分析分离。正式计算进入独立 Worker；前台最多 1 个运行任务和 1 个最新等待任务。新 revision、模式切换、客户端断开或新请求会终止过时 Worker，迟到结果仍受 tableId/revision/modeEpoch/token 四重保护。
9. 行动请求带可重放 requestId。响应丢失时界面保留原始 state/op/requestId，只能“重试确认”同一次操作；服务端回执缓存校验载荷，避免重复写动作。保存未确认时，新建牌桌入口和底层调用均被锁住，避免旧请求重试后复活旧桌。
10. 既有 GTO 后台求解仍是 1 个并发、同 cacheKey 去重；本轮把等待队列限制为 8 个，队满时由最新局面替换最旧尚未启动项，避免不同局面持续堆积。

## 常见动作点击数

| 操作 | 点击数 | 说明 |
|---|---:|---|
| 弃牌 / 过牌 / 普通跟注 / 跟注全下 | 1 | 成功响应后才换到下一位 |
| 直接输入下注或加注 | 2 | 点金额框输入，再点确认；输入框已有焦点时只需确认 |
| 快捷金额下注或加注 | 2 | 点快捷金额填入，再点确认 |
| 主动全下 | 2 | 点“全下…”，再点“确认全下” |
| 撤销 | 1 | 点“撤销”；非文本编辑时也可 Ctrl+Z |
| 选择两张手牌 | 3 | 点第一槽、选第一张、选第二张；落点自动前进 |
| 查看玩家资料 | 1 | 点玩家名称/头像区域；点筹码数字只进入筹码管理 |

## 金额和合法动作证据

- CO 开池 2.5BB、BTN 加注到 10BB、CO 加注到 22BB 后，后端返回 BTN 最小完整再加注到 **34BB**；BB 与 3,400 筹码两种方式提交结果相同。
- 面对下注时不提供过牌；短码 0.5BB 的跟注显示“跟注全下”并记录为 0.5BB `CALL`；无人下注轮到 BB 时显示“过牌”。
- 快捷金额来自既有 `LegalActions` 和尺寸网格，过滤非法、重复、超过筹码和普通输入中的全下项；没有另写一套前端下注规则。
- 双击、按键自动重复、重复回车和响应丢失重试均只记录一次。中文输入法组合期间的 Enter 不提交；文本框内 Ctrl+Z 只撤销文字。

## 建议区与状态

建议区明确区分等待手牌、等待前位行动、等待公共牌、已就绪、分析中、完成、超时、失败和信息不足。状态变化时旧建议立即清除；录入历史模式不显示建议。协作式计算截止 `DEADLINE` 与浏览器请求超时都显示“分析超时”，不是笼统失败。

正式建议继续取自原生产管线；影子对比只在折叠证据中按原标签展示。建议同屏显示本次实际范围来源、是否来自求解器、必要限制和缓存/后台求解状态，没有编造可信度或耗时。

## 性能实测

固定环境：13th Gen Intel Core i5-13600KF（20 逻辑核）、Windows 10.0.26200、Node v24.19.0、Chrome 153.0.8010.48、当前工作区构建。P95 采用 nearest-rank `ceil(0.95 × n)`。

| 环节 | 样本 | P50 | P95 | 最大值 |
|---|---:|---:|---:|---:|
| 本地指针/输入到下一帧 | 269 | 12.3 ms | **16.6 ms** | 17.2 ms |
| 行动保存请求 | 127 | 16.2 ms | **17.7 ms** | 18.6 ms |
| 缓存节点建议可见（CDP 观察） | 30 | 893.3 ms | **955.0 ms** | 997.6 ms |
| 分析 HTTP 请求 | 30 | 839.0 ms | 915.9 ms | 952.1 ms |
| 服务端排队 | 30 | 0.012 ms | 0.027 ms | 0.036 ms |
| 缓存准备 | 30 | 0.387 ms | 0.802 ms | 0.934 ms |
| 决策计算 | 30 | 669.0 ms | 710.8 ms | 751.4 ms |
| Worker 全程 | 30 | 834.9 ms | 910.9 ms | 946.9 ms |
| 本地传输、响应组装与解码残差 | 30 | 3.48 ms | 4.24 ms | 4.33 ms |
| 前端渲染 | 30 | 0.70 ms | 1.30 ms | 1.50 ms |

缓存节点是 9MAX BB 面对 UTG 2.5BB 开池，分别用 AhAd、AsKs、QhQd；每个节点重复 10 次。只复用持久化的**范围缓存**，每次正式决策仍重新计算，并逐次确认 `rangeProvenance.fromSolver=true`，没有缓存旧建议。

首次读取持久化缓存的该轮服务端总耗时为 893.8 ms，其中准备 13.8 ms、计算 694.8 ms、Worker 879.2 ms。本轮没有重新跑耗时很长的全新求解器任务，所以**没有新的冷求解完成耗时**；这项不能拿缓存数据冒充。范围未命中时，前台会立刻用真实标注的启发式来源继续给建议，后台求解不阻塞录入。

原始数据：`reports/fast-input-decision-v2/final-summary.json`、`browser-cache-final/cached-performance.json`。

## 计算结果一致性

- 固定 `asOf=1757000000000`、随机种子 `20260924`、相同预算，7 个生产夹具的改造前后**规范化输入逐字段相同、正式决策逐字段相同、重复运行确定**。
- 夹具覆盖 9 人桌/6 人桌开池、面对开池、34BB 再加注、翻牌/转牌/河牌面对下注。
- `allStableIdentical=false` 是预期结果：新预览增加了 `amountInput` UI 契约；关键结论为 `allDecisionsIdentical=true`、`allNormalizedInputsIdentical=true`、`legalityUnchanged=true`。
- 真实旧 UI 冻结资源与 V2 UI 通过同一服务端录入 “UTG 弃牌、HJ 弃牌、CO 开池 3BB”，输出的 `manualHandInput` 深度相等。证据：`browser-supplement/ui-normalized-comparison.json`。

## 真实 Chrome/CDP 验收

所有动作通过 Chrome 的鼠标、键盘、IME 和网络控制输入完成；`Runtime.evaluate` 只读 DOM/验收钩子，没有注入牌局状态。主要结果：

| 场景 | 结果 |
|---|---|
| 多人连续弃牌、跟注、加注与行动顺序 | 通过 |
| 筹码/BB 切换、直接输入、快捷金额 | 通过 |
| 2.5 → 10 → 22BB 后最小 34BB | 通过 |
| 过牌、短码跟注全下、主动全下二次确认、非法金额 | 通过 |
| 双击、长按 Enter、重复 Enter、真实 IME composition、文本 Ctrl+Z | 通过 |
| 慢分析期间输入/行动/撤销，旧响应不得覆盖 | 通过 |
| 选牌、替换、清除、换手牌、模式切换、下一手、9 人桌 | 通过 |
| 玩家资料打开、真实历史区域、显式更换玩家 | 通过 |
| 断网、30 秒超时、失败后重试、提交成功但响应丢失 | 通过 |
| 1366×768 | 通过；主动作按钮底部 735.5px，无整页滚动 |
| 1024×768、390×844 | 通过；滚动后真实点击全下并打开确认弹窗 |
| 911×512（1366×768 在 150% 缩放下的等效 CSS 视口） | 通过；滚动后按钮可达可点 |
| 旧 UI / V2 UI 规范化输入一致 | 通过 |

一次补充脚本最初点中了玩家卡片里的“筹码”子元素，正确打开的是“筹码管理”，却被脚本误当成玩家资料失败；改为点玩家名称后独立重跑通过。这是验收脚本选择器问题，失败证据保留在 `browser-final-supplement/acceptance.json`，最终通过证据在 `browser-player-final/acceptance.json`，没有删除或掩盖失败记录。

浏览器控制台没有 JavaScript 异常。日志中的 404 favicon、离线测试 `ERR_INTERNET_DISCONNECTED` 和丢响应测试 `ERR_CONNECTION_CLOSED` 都是已知、刻意制造的验收事件。

## 自动验证

- `npm run typecheck`：通过。
- `npm run manifest:check`：通过。
- `npm test`：2,271 / 2,271 通过，137 套件，0 失败。
- 完整日志：`reports/fast-input-decision-v2/final-verify.log`。
- 浏览器主证据：`reports/fast-input-decision-v2/browser/acceptance.json`。
- 最终补充证据：`browser-final-supplement/acceptance.json`、`browser-player-final/acceptance.json`、`browser-cache-final/acceptance.json`。

## 未覆盖与风险

- 本轮没有重新完成一个全新、未命中范围缓存的 GTO 求解，所以不报告冷求解 P95；它会在后台运行，前台使用明确标注的真实来源继续工作。
- 前台分析 Worker 可以实际终止；已经交给外部 GTO 求解器的活动任务没有安全的中途取消 API，不能假装“前端 abort 等于求解器停止”。已通过 1 并发、cacheKey 去重和最多 8 个等待项控制资源；最新等待局面会替换最旧未启动项。
- 回执防重是服务进程内缓存（128 条、约 8 MiB、10 分钟 TTL）。服务进程恰在“已产生副作用但客户端没收到响应”时崩溃，跨进程恢复仍依赖既有持久化/版本校验，不承诺跨重启的绝对 exactly-once。
- 手牌替换由两个已经确认的原子牌操作完成，因此完全回到替换前需要撤销两次；界面不会在中间状态偷偷提交分析。
- 只整理实际已有的牌桌、玩家档案、GTO 范围和历史录入能力；没有为了匹配效果图开发训练或完整复盘系统。

## 启动与使用（大白话）

启动：双击 `scripts\start-alpha.cmd`。它会启动本地服务并打开 `http://127.0.0.1:5173/`。也可以在项目目录运行：

```powershell
node --experimental-strip-types src/app/webServer.ts
```

录入：先选桌型、Hero 座位并“一键加入玩家”，点空白手牌/公共牌选牌。系统会高亮当前该行动的人；弃牌、过牌、跟注直接点一次。下注或加注时，在宽输入框里输入“本街累计到多少”，或者点一个快捷金额，再点确认。面对下注不用自己算差额，下方会显示本街已投入和本次需补。

撤销：点录入区右上角“撤销”。光标在金额框里时，Ctrl+Z 只撤销文字；光标不在编辑框里时，Ctrl+Z 才撤销牌局操作。

看建议：切到“当前决策”，轮到 Hero 且牌面齐全时会自动分析。右侧会写明“分析中 / 完成 / 超时 / 失败”，完成后显示动作、金额、简短原因和真实数据来源。录入历史时建议会收起，避免把 Hero 的旧建议当成对手动作。

## 截图

- `reports/fast-input-decision-v2/browser/layout-1366x768.png`
- `reports/fast-input-decision-v2/browser/reraise-minimum-34bb.png`
- `reports/fast-input-decision-v2/browser/allin-confirmation.png`
- `reports/fast-input-decision-v2/browser/analysis-does-not-block-recording.png`
- `reports/fast-input-decision-v2/browser/analysis-timeout.png`
- `reports/fast-input-decision-v2/browser/retry-after-lost-response.png`
- `reports/fast-input-decision-v2/browser-player-final/player-profile-and-replacement.png`
