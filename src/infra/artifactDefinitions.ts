/**
 * 全项目产物定义表（规范：Range 数据 / 环境参数 / 模型版本 / 红队报告全部绑定 hash）
 *
 * ## 为什么需要一张**集中**的定义表
 *
 * 如果每个模块各自登记自己的 hash，就会出现两种漂移：
 * 1. 新增了一个产物，但没人记得登记
 * 2. 同一个产物在两处登记了不同的值
 *
 * 集中定义后，「已绑定的产物全集」成为**单一事实来源**，
 * 并有测试断言「定义表里的每个文件都真的在清单里」。
 *
 * ## `impact` 字段的作用
 *
 * 当校验失败时，报错信息会带上「这个文件一旦变化会影响什么」。
 * 这样「昨天 CALL、今天 FOLD」的追查可以直接从错误信息开始，
 * 而不需要先读一遍代码才知道哪个文件重要。
 */

import { ManifestCategory, type ArtifactDefinition } from './artifactManifest.ts';

export const ARTIFACT_DEFINITIONS: readonly ArtifactDefinition[] = Object.freeze([
  /* ---- 知识层 ---- */
  {
    path: 'data/knowledge/source-registry.json',
    category: ManifestCategory.KNOWLEDGE,
    impact: '知识来源注册表变化 → 某条策略结论的出处、许可证门禁或可推导性发生变化',
  },
  {
    path: 'data/knowledge/strategy-rules.json',
    category: ManifestCategory.KNOWLEDGE,
    impact: '策略规则变化 → 方向性调整（或未来的幅度）发生变化，直接影响建议',
  },
  {
    path: 'docs/KNOWLEDGE_POLICY.md',
    category: ManifestCategory.KNOWLEDGE,
    impact: '知识政策变化 → 来源优先级链或使用纪律发生变化',
  },
  {
    path: 'docs/UNCERTAINTY_POLICY.md',
    category: ManifestCategory.KNOWLEDGE,
    impact:
      '不确定修复处理规则变化 → 「无法确认根因时如何行动、如何分类结论、必须报告什么」的强制纪律发生变化' +
      '（四种结论定义 / 八条强制规则 / 九行报告格式）',
  },
  {
    path: 'reports/UNCERTAINTY_REGISTER.md',
    category: ManifestCategory.REPORT,
    impact:
      '未解决条目的登记表变化 → 「哪些动作尚未获得模型支持、哪些改动需要人工裁决」的事实来源发生变化；' +
      '它缺失或过期时，不得声称任何相关内容已解决',
  },
  {
    path: 'src/domain/knowledge/knowledge.types.ts',
    category: ManifestCategory.KNOWLEDGE,
    impact: '知识类型与校验变化 → 许可证门禁或「不编造」硬校验的强度发生变化',
  },
  {
    path: 'src/domain/knowledge/knowledge.ts',
    category: ManifestCategory.KNOWLEDGE,
    impact: '知识加载与索引变化 → 校验严格程度或查询语义发生变化',
  },
  {
    path: 'src/domain/knowledge/knowledgeLoader.ts',
    category: ManifestCategory.KNOWLEDGE,
    impact: '知识文件加载变化 → Fail-Closed 行为或 BOM 容忍度发生变化',
  },

  /* ---- 环境参数 ---- */
  {
    path: 'src/domain/range/gameEnvironment.ts',
    category: ManifestCategory.ENVIRONMENT,
    impact:
      '**环境参数变化 → 三种模式的范围/似然调整幅度变化，直接影响建议**' +
      '（这是「昨天 CALL 今天 FOLD」最可能的来源之一）',
  },

  /* ---- 范围层 ---- */
  {
    path: 'src/domain/range/range.types.ts',
    category: ManifestCategory.RANGE,
    impact: '范围类型与 EPSILON 变化 → 归一化容差与来源语义发生变化',
  },
  {
    path: 'src/domain/range/rangeUpdate.ts',
    category: ManifestCategory.RANGE,
    impact: '贝叶斯更新变化 → 后验范围计算方式或外部调整者的接入方式发生变化',
  },
  {
    path: 'src/domain/range/rangeLogSpace.ts',
    category: ManifestCategory.RANGE,
    impact: '对数域归一化变化 → 极端似然下的数值行为发生变化',
  },
  {
    path: 'src/domain/range/rangeNormalize.ts',
    category: ManifestCategory.RANGE,
    impact: '归一化策略变化 → 权重到概率的映射发生变化',
  },
  {
    path: 'src/domain/range/rangeProvenance.ts',
    category: ManifestCategory.RANGE,
    impact: '来源校验与可信度上限变化 → 范围可信度判定发生变化',
  },
  {
    path: 'src/domain/range/rangeValidator.ts',
    category: ManifestCategory.RANGE,
    impact: '范围校验变化 → 非法范围的拦截范围发生变化',
  },
  {
    path: 'src/domain/range/rangeMetrics.ts',
    category: ManifestCategory.RANGE,
    impact: '范围度量变化 → 收窄程度与 KL 散度的计算发生变化',
  },
  {
    path: 'src/domain/range/rangeBlockers.ts',
    category: ManifestCategory.RANGE,
    impact: '死牌过滤变化 → 被阻断组合的判定发生变化',
  },
  {
    path: 'src/domain/range/range.ts',
    category: ManifestCategory.RANGE,
    impact: '范围构建变化 → 初始权重与冻结行为发生变化',
  },
  {
    path: 'src/domain/range/rangeCache.ts',
    category: ManifestCategory.RANGE,
    impact: '范围缓存变化 → 缓存 key 与失效行为发生变化',
  },
  {
    path: 'src/domain/range/combo.ts',
    category: ManifestCategory.RANGE,
    impact: '组合宇宙变化 → 1326 组合的 id / 类别 / 索引发生变化',
  },
  {
    path: 'src/domain/range/handPotential.ts',
    category: ManifestCategory.RANGE,
    impact: '手牌潜力标尺变化 → 画像调整的强度梯度发生变化',
  },
  {
    path: 'src/domain/range/profileProvider.ts',
    category: ManifestCategory.RANGE,
    impact: '画像/环境到范围的桥接变化 → 调整因子的计算与归一化方式发生变化',
  },

  /* ---- 玩家模型 ---- */
  {
    path: 'src/domain/player/player.types.ts',
    category: ManifestCategory.PLAYER_MODEL,
    impact: '指标定义与先验表变化 → 所有指标的收缩目标发生变化',
  },
  {
    path: 'src/domain/player/playerStats.ts',
    category: ManifestCategory.PLAYER_MODEL,
    impact:
      '统计机制变化（衰减 / 有效样本量 / 单手影响上限 / 收缩）→ ' +
      '**所有画像数值发生变化**',
  },
  {
    path: 'src/domain/player/playerProfile.ts',
    category: ManifestCategory.PLAYER_MODEL,
    impact: '画像引擎变化 → 幂等、修正历史、冻结行为或 seq 校验发生变化',
  },
  {
    path: 'src/domain/player/playerClassifier.ts',
    category: ManifestCategory.PLAYER_MODEL,
    impact:
      '分类与调整因子变化（含维度中立点、标签阈值）→ ' +
      '**画像对范围的影响幅度发生变化**',
  },
  {
    path: 'src/domain/player/archetypeDimensions.ts',
    category: ManifestCategory.PLAYER_MODEL,
    impact:
      '手选画像 → 连续维度的原型表变化 → ' +
      '**画像通过似然通道对范围的影响发生变化**（P0 主链修复的入口）',
  },
  /*
   * 🔴 **本轮补登记（清单覆盖缺口）**：`observedStats.ts` 是
   * 「连续统计 → 人物维度」的**解析器本身**（逐统计锚点/半宽、标签 prior
   * 融合权重、分街条目收缩），也是 PLAYER PROFILE V3 修复的落点，
   * 但此前**没有**被登记进清单 —— 于是「同一批 HUD 数据为什么给出不同建议」
   * 这个最该被回答的问题恰恰查不到源（同目录的 playerStats / playerClassifier /
   * archetypeDimensions 都已登记，唯独漏了它）。
   */
  {
    path: 'src/domain/player/observedStats.ts',
    category: ManifestCategory.PLAYER_MODEL,
    impact:
      '连续统计 → 人物维度的解析器变化（逐统计中性锚点/半宽、标签 prior 与实测的融合权重、' +
      '分街条目的收缩与语义门）→ **所有带实测统计的对手的 ' +
      'tightness / aggression / bluffTendency / passivity 与分街系数发生变化**' +
      ' ⇒ Fold/Call/Raise 概率、Hero 权益、BetEV 与最终建议全部受影响',
  },
  {
    path: 'reports/PROFILE_RANGE_MAINCHAIN_REPORT.md',
    category: ManifestCategory.REPORT,
    impact: '画像 → Range → 权益主链修复的证据与验收表变化 → **本报告必须与新证据同步**',
  },
  {
    path: 'src/domain/player/tendencyProvider.ts',
    category: ManifestCategory.PLAYER_MODEL,
    impact:
      '画像 / 近期倾向进入动作似然的方式变化（弱牌锚点、价值倾斜、观测倾斜、工程护栏）→ ' +
      '**范围后验、Hero 权益与 Call EV 全部发生变化**',
  },
  {
    path: 'src/domain/postflop/betResponse.ts',
    category: ManifestCategory.DECISION,
    impact:
      '下注响应模型变化（每尺寸的 P(弃/跟/加)、条件范围、Hero 听牌通道、权益实现因子、BetEV 公式）→ ' +
      '**所有「无人下注」节点的下注决策与尺寸选择都会变化**',
  },
  {
    path: 'reports/BET_DECISION_ENGINE_PHASE1_REPORT.md',
    category: ManifestCategory.REPORT,
    impact: '下注决策引擎 Phase 1 的验收表与限制清单变化 → **本报告必须与新证据同步**',
  },
  {
    path: 'reports/RIVER_LEGAL_ACTION_TREE_FIX_REPORT.md',
    category: ManifestCategory.REPORT,
    impact: '河牌合法动作树的验收表与墨菲核对变化 → **本报告必须与新证据同步**',
  },
  {
    path: 'src/domain/decision/evidencePriority.ts',
    category: ManifestCategory.DECISION,
    impact:
      '动作证据优先级与覆盖权限变化（谁能覆盖谁、UNKNOWN 是否参与比较、MARGINAL 是否允许启发式打断）→ ' +
      '**所有面对下注节点的动作来源与最终动作都可能变化**',
  },
  {
    path: 'reports/PREFLOP_EVIDENCE_PRIORITY_FIX_REPORT.md',
    category: ManifestCategory.REPORT,
    impact: '证据优先级修复的验收表与覆盖权限规则变化 → **本报告必须与新证据同步**',
  },
  {
    path: 'reports/MULTI_LIMP_ISOLATION_RAISE_PHASE1_REPORT.md',
    category: ManifestCategory.REPORT,
    impact:
      '多人 limp 隔离加注（Phase 1）的根因、模型、固定节点验收表与变异测试结果 → ' +
      '**本报告必须与 `limpIsolation.ts` 的实际公式同步**',
  },
  {
    path: 'scripts/preflop-iso-probe.ts',
    category: ManifestCategory.REPORT,
    impact: '隔离加注事实包探针（逐家 limp 响应 / 权益 / EV 分解）→ 仅诊断用，不参与决策',
  },
  {
    path: 'scripts/iso-mutations.ts',
    category: ManifestCategory.REPORT,
    impact: '隔离加注的变异测试（M1–M8，逐个把修复改回坏版本）→ 仅诊断用，不参与决策',
  },
  {
    path: 'scripts/multiway-mutations.ts',
    category: ManifestCategory.REPORT,
    impact: '多人联合响应树的变异测试（M1–M8：平均弃牌率 / primary 决定 EV / 共用响应 / 单挑平均 / 丢分支 / 重复扣成本 / 尺寸复用 / 画像失效）→ 仅诊断用',
  },
  {
    path: 'scripts/seat-profile-probe.ts',
    category: ManifestCategory.REPORT,
    impact: '逐座位画像 → 维度 → 响应倾向探针 → 仅诊断用',
  },
  {
    path: 'scripts/station-size-probe.ts',
    category: ManifestCategory.REPORT,
    impact: '跟注站 / 紧手尺寸方向探针 → 仅诊断用',
  },
  {
    path: 'src/domain/player/behaviorProfile.ts',
    category: ManifestCategory.PLAYER_MODEL,
    impact: '人物画像量化（StatEvidence/收缩/行为条目/节点上下文/动作似然/combo 重加权/物性检测）→ 河牌面对下注的加权范围与权益将随画像变化',
  },
  {
    path: 'reports/PLAYER_PROFILE_QUANTIFICATION_V1_REPORT.md',
    category: ManifestCategory.REPORT,
    impact: '画像量化的数据模型、收缩公式、03A/03B 单调性验收与墨菲审计 → 本报告必须与 behaviorProfile.ts 同步',
  },
  {
    path: 'reports/TEST_HAND_MULTIWAY_TURN_FIX_REPORT.md',
    category: ManifestCategory.REPORT,
    impact: '真实测试牌局定点修复（Board Delta / 复合牌力 / 非 closing action / RAISE 排序语义）→ 本报告必须与实际公式同步',
  },
  {
    path: 'scripts/board-delta-probe.ts',
    category: ManifestCategory.REPORT,
    impact: '牌面变化分类探针（A–D 用例）→ 仅诊断用',
  },
  {
    path: 'reports/MULTIWAY_POSTFLOP_RESPONSE_TREE_PHASE1_REPORT.md',
    category: ManifestCategory.REPORT,
    impact:
      '多人翻后响应树（Phase 1）的根因、联合树结构、固定节点验收表、尺寸饱和审计与变异结果 → ' +
      '**本报告必须与 `betResponse.ts` 的联合公式同步**',
  },

  /* ---- 动态行为引擎（Step 7） ---- */
  {
    path: 'src/domain/dynamic/dynamic.types.ts',
    category: ManifestCategory.PLAYER_MODEL,
    impact:
      '动态行为的类型、9 状态集合、组上限与**收缩/置信度刻度**变化 → ' +
      '所有动态判定阈值发生变化（该文件改动必须升 `DYNAMIC_MODEL_VERSION`）',
  },
  {
    path: 'src/domain/dynamic/dynamicStats.ts',
    category: ManifestCategory.PLAYER_MODEL,
    impact:
      '窗口统计变化（规范化 / 机会感知分母 / 向基线收缩强度）→ ' +
      '**近期行为率的估计值发生变化**',
  },
  {
    path: 'src/domain/dynamic/dynamicDeviation.ts',
    category: ManifestCategory.PLAYER_MODEL,
    impact:
      '偏差计算变化（有界归一化 / 组聚合 / 方向噪声检验）→ ' +
      '**DeviationScore 与方向判定发生变化**',
  },
  {
    path: 'src/domain/dynamic/dynamicBehavior.ts',
    category: ManifestCategory.PLAYER_MODEL,
    impact:
      '动态主引擎变化（状态推导 / 置信度 / 上下文锚点 / 人工 Hint）→ ' +
      '**输出状态与调整方向发生变化**',
  },
  {
    path: 'src/domain/dynamic/dynamicAdapter.ts',
    category: ManifestCategory.PLAYER_MODEL,
    impact:
      '适配层变化（UNVERIFIED_MAGNITUDE 幅度）→ ' +
      '下游可用的乘数发生变化（**该幅度未经校验，不得冒充已校准参数**）',
  },

  /* ---- Alpha 决策链（Environment → Manual Input → Decision → Web） ---- */
  {
    path: 'src/domain/environment/environmentAccess.ts',
    category: ManifestCategory.ENVIRONMENT,
    impact:
      '环境接入层变化（规则目标映射 / 优先级裁决）→ ' +
      '**环境方向建议的集合发生变化**（该层不得输出任何幅度）',
  },
  {
    path: 'src/domain/decision/decision.types.ts',
    category: ManifestCategory.DECISION,
    impact:
      '决策类型与常量变化（阈值 / 分类 / 置信度档位 / EV gap 门槛）→ ' +
      '**所有决策判定阈值发生变化**（该文件改动必须升 `ALPHA_DECISION_MODEL_VERSION`）',
  },
  {
    path: 'src/app/manualInput/preflopPriors.ts',
    category: ManifestCategory.RANGE,
    impact:
      '启发式翻牌前范围先验变化 → **对手范围形状与权益估计发生变化**' +
      '（该数据**不是**求解器输出，改动必须同步更新 provenance 说明）',
  },
  {
    path: 'src/app/manualInput/likelihoodModel.ts',
    category: ManifestCategory.RANGE,
    impact:
      '启发式似然模型变化（档位权重 / 归一化 / 下限）→ ' +
      '**行动历史对范围的收缩方式发生变化**',
  },
  {
    path: 'src/app/manualInput/manualInput.ts',
    category: ManifestCategory.DECISION,
    impact:
      '手动输入结构变化（字段 / 牌面格式 / 街道与公共牌约束）→ ' +
      '**输入解析与校验行为发生变化**（影响所有录入路径）',
  },
  {
    path: 'src/app/manualInput/playerIdentity.ts',
    category: ManifestCategory.DECISION,
    impact:
      '玩家身份路由变化（座位 id `seat_<位置>` / 持久 `playerId` / 显示名三者的解析与优先级）→ ' +
      '**画像 provider、行为画像、跛入原型与下注/响应权重被注入到哪一家身上发生变化** ' +
      '（注入落空时范围权重、权益、CALL/Raise EV 与最终建议全部跟着变；' +
      '同名不同人的隔离、换座位与换玩家的正确性都由它决定）',
  },
  {
    path: 'src/app/manualInput/facingBetProfile.ts',
    category: ManifestCategory.DECISION,
    impact:
      '「面对下注」有效人物画像的构造（标签贡献 0.35×(1−w) + 实测贡献 w×center(observed)）→ ' +
      '**面对下注时的下注范围权重与面对加注的响应概率发生变化**（进而影响 EqVsBetRange、' +
      'CALL/Raise EV 与最终建议）；无实测证据时逐位退回旧标签实现',
  },
  {
    path: 'src/app/manualInput/reconstruct.ts',
    category: ManifestCategory.DECISION,
    impact:
      '输入 → 牌局状态重建变化（行动重放 / 街道推进 / 决策点检查 / 底池对照）→ ' +
      '**哪些输入被接受、哪些被阻断发生变化**',
  },
  {
    path: 'src/app/manualInput/legalActions.ts',
    category: ManifestCategory.DECISION,
    impact:
      '合法动作与尺寸网格变化 → **决策可输出的动作集合与尺寸集合发生变化**' +
      '（必须与 Poker Core 的校验保持一致）',
  },
  {
    path: 'src/app/manualInput/limpIsolation.ts',
    category: ManifestCategory.DECISION,
    impact:
      '多人 limp 隔离加注模型（limp 到达范围 / 响应树 / 联合响应 / 尺寸 / 身后风险 / 代理 EV）→ ' +
      '**跛入池里「加注 vs 跟注」的依据与尺寸发生变化**（翻前，代理 EV，RAKE 未实现）',
  },
  {
    path: 'src/app/manualInput/contextBuilder.ts',
    category: ManifestCategory.DECISION,
    impact:
      '决策上下文组装变化（数学快照 / 范围 / 玩家 / 环境 / 动态 / 权益）→ ' +
      '**决策层看到的全部输入数据发生变化**',
  },
  {
    /*
     * 🔴 U1 P0 修复补登记（`reports/U1_RAISE_EV_P0_FIX_REPORT.md`）：
     * 这个文件产出的**响应权重与对手跟注赔率**直接决定 RAISE EV，
     * 而它此前**不在产物清单里** —— 改了它不会有任何 hash 提示。
     */
    path: 'src/app/manualInput/raiseResponse.ts',
    category: ManifestCategory.DECISION,
    impact:
      '面对加注的响应模型变化（公共强度带权重 / 对手跟注所需权益 price / 再加注份额 / 资金口径契约 ' +
      '`CASHFLOW_CONTRACT`）→ **加注 EV、EqVsRaiseCallRange 与「加注 vs 跟注」的排序发生变化**；' +
      '⚠️ 该文件同时定义 `raiseEVOf`（加注 EV 的唯一公式），改动必须同步 ' +
      '`test/raiseEvCashflowP0.test.ts` 与 `reports/U1_RAISE_EV_LIGHT_AUDIT.md` 的结论',
  },
  {
    path: 'src/app/decision/decisionEngine.ts',
    category: ManifestCategory.DECISION,
    impact:
      '决策引擎变化（候选评估 / 数学优势保护 / 动作选择 / 置信度 / 分类 / Shadow）→ ' +
      '**最终建议的动作、尺寸与置信度发生变化**',
  },
  {
    /*
     * 🔴 阶段 B 补登记（`reports/PREFLOP_RAISE_DECISION_V1.md`）：
     * 这两个文件是**翻前加注 EV 的唯一来源**（响应概率 + 条件范围 + 逐尺寸 EV），
     * 改了它们会让「翻前是加注还是跟注、加到多少」发生变化。
     */
    path: 'src/app/manualInput/preflopRaiseResponse.ts',
    category: ManifestCategory.DECISION,
    impact:
      '翻前加注响应模型变化（起手牌强度阶梯 / 继续门槛余量 `PREFLOP_CONTINUE_MARGIN` / ' +
      '再加注闸门 `PREFLOP_RERAISE_GATE` / 诈唬再加注门槛）→ ' +
      '**他的弃/跟/再加注概率与条件范围发生变化 ⇒ 翻前每一个加注尺寸的 EV 与排名都会变**；' +
      '⚠️ 该文件里的全部常数都是**未校准的结构性先验**，改动必须在报告中重新做敏感度分析',
  },
  {
    path: 'src/app/manualInput/preflopRaiseFacts.ts',
    category: ManifestCategory.DECISION,
    impact:
      '翻前加注事实包变化（逐尺寸资金口径 / 被再加注分支 / 单挑与身后玩家门槛 / EV 组装）→ ' +
      '**翻前加注的自有 EV、可比较性门槛与「未评估动作」披露发生变化**；' +
      '⚠️ 现金流必须继续走 `raiseResponse.raiseEVOf`（全项目唯一公式），' +
      '改动必须同步 `test/preflopRaiseDecision.test.ts`（独立复算）与 ' +
      '`test/preflopRaiseE2E.test.ts`（端到端一致性）',
  },
  {
    path: 'src/app/alphaPipeline.ts',
    category: ManifestCategory.DECISION,
    impact:
      '端到端管线变化（阶段顺序 / 失败阶段划分 / 最终数学一致性检查 / 日志）→ ' +
      '**整条链的失败行为与输出结构发生变化**',
  },
  {
    path: 'src/app/decisionLog.ts',
    category: ManifestCategory.DECISION,
    impact:
      '决策日志结构变化 → **追溯链（输入哈希 / 版本 / 抽水口径）记录发生变化**',
  },
  {
    path: 'src/app/webServer.ts',
    category: ManifestCategory.DECISION,
    impact:
      '内部测试服务器变化（路由 / 请求校验 / 响应结构 / 监听范围）→ ' +
      '**网页入口的可用性与隐私边界发生变化**',
  },
  {
    path: 'src/app/web/index.html',
    category: ManifestCategory.DECISION,
    impact:
      '中文输入表单与结果页变化 → **使用者看到的界面与输入方式发生变化**' +
      '（界面不得包含任何策略判断）',
  },
  {
    path: 'src/viewmodels/decisionViewModel.ts',
    category: ManifestCategory.DECISION,
    impact:
      'ViewModel 映射变化 → **界面显示的内容发生变化**' +
      '（必须忠实映射引擎输出，不得二次推导结论）',
  },

  /* ---- 决策引擎 ---- */
  {
    path: 'src/app/decisionDeadline.ts',
    category: ManifestCategory.DECISION,
    impact: '时间预算变化 → 软/硬上限与提前中止行为发生变化',
  },
  {
    path: 'src/app/decisionPipeline.ts',
    category: ManifestCategory.DECISION,
    impact: '决策管线变化 → 阶段预算与 Abort 传播行为发生变化',
  },

  /* ---- GTO 集成（外部求解器作为独立计算引擎） ---- */
  //
  // ## 为什么这一组文件必须登记
  //
  // GTO 是**第一个外部数据来源**。它一旦漂移，后果与其他产物不同：
  // 不是「数学算错了」，而是「拿到的是别人的策略」——
  // 界面上一切正常，只是数据不属于当前场景。
  // 因此这里的 impact 都要写清楚「哪一个具体的行为会变」。
  {
    path: 'src/domain/gto/gto.types.ts',
    category: ManifestCategory.DECISION,
    impact:
      'GTO 领域类型变化 → **GtoScenario / GtoBaseline / 求解状态与可信度的语义发生变化**；' +
      '🔴 这个文件里**不允许**出现任何真人信息字段（Tilt / 画像 / 动态提示），' +
      '它是「真人信息不得污染理论基线」的类型级防线',
  },
  {
    path: 'src/domain/gto/gtopenHandMatrix.ts',
    category: ManifestCategory.DECISION,
    impact:
      '169 类矩阵变化 → **AKs/AKo 或同花/不同花可能互换**、类号与求解器数组错位；' +
      '这类错误在界面上完全看不出来（名字都对）',
  },
  {
    path: 'src/domain/gto/gtoScenario.ts',
    category: ManifestCategory.DECISION,
    impact:
      '场景构造与哈希变化 → **桌人数隔离、缓存键、场景可表达性判定发生变化**；' +
      '哈希口径变化会让旧缓存全部失效（这是好事，但必须知道）',
  },
  {
    path: 'src/domain/gto/gtoSafeLookup.ts',
    category: ManifestCategory.DECISION,
    impact:
      '安全查询层（缓存 + 硬超时 + 回退）变化 → **「求解器故障时 Alpha 仍可用」这条保证的强度发生变化**',
  },
  {
    path: 'src/domain/gto/providers/gtopenCapabilities.ts',
    category: ManifestCategory.DECISION,
    impact:
      'GTOpen 能力表变化 → **各桌人数/场景的支持级别与「翻前是近似模型」这一结论发生变化**；' +
      '🔴 把 preflopApproximateModel 改成 false 等于声称一个近似模型是精确的',
  },
  {
    path: 'src/domain/gto/providers/gtopenHttpClient.ts',
    category: ManifestCategory.DECISION,
    impact:
      'GTOpen 传输层变化 → **超时 / 连接失败 / 坏响应 / 超大响应的处置方式发生变化**',
  },
  {
    path: 'src/domain/gto/providers/gtopenMapping.ts',
    category: ManifestCategory.DECISION,
    impact:
      '位置与动作映射变化 → **座位错位一格或 SB/BB、Hero/Villain 反转**；' +
      '这是「读到别人策略」的直接入口',
  },
  {
    path: 'src/domain/gto/providers/gtopenProvider.ts',
    category: ManifestCategory.DECISION,
    impact:
      'GTOpen 适配器变化 → **外部 JSON → 内部统一格式的全部转换规则发生变化**' +
      '（含会话串行化、求解预算、近似标记）',
  },
  {
    path: 'src/domain/gto/providers/providerRegistry.ts',
    category: ManifestCategory.DECISION,
    impact:
      'Provider 注册表变化 → **新增求解器（交叉验证）的接入方式发生变化**；' +
      '这里是「禁止 if engine === GTOPEN 散布全项目」的实现点',
  },
  {
    path: 'src/app/gto/gtoScenarioCatalog.ts',
    category: ManifestCategory.DECISION,
    impact:
      '场景目录变化 → **界面上能选哪些桌人数/位置/场景、以及每个场景的前序动作发生变化**',
  },
  {
    path: 'src/app/gto/gtoApi.ts',
    category: ManifestCategory.DECISION,
    impact:
      'GTO 应用层装配变化 → **Alpha 与 Provider 的连接点、关闭开关（ALPHA_GTO）、' +
      '以及界面消费的响应形状发生变化**',
  },
  {
    path: 'src/app/web/gto.html',
    category: ManifestCategory.DECISION,
    impact:
      '中文 GTO 范围页变化 → **使用者看到的界面的变化**；' +
      '🔴 本页不得把近似结果表述成「绝对 GTO」或「已验证」',
  },
  {
    path: 'src/app/web/gto.css',
    category: ManifestCategory.DECISION,
    impact: 'GTO 范围页样式变化 → 矩阵配色与「主要动作」的可读性发生变化（不影响数据）',
  },
  {
    path: 'src/app/web/gto.js',
    category: ManifestCategory.DECISION,
    impact:
      'GTO 范围页脚本变化 → **13×13 矩阵渲染、混合策略展示、百分比格式化发生变化**；' +
      '🔴 ×100 只允许出现在 fmtPercent 一处（否则会出「0.65 显示成 0.65%」）',
  },
  {
    path: 'GTOopen/start-gtopen.ps1',
    category: ManifestCategory.DECISION,
    impact:
      'GTOpen 启动脚本变化 → **本地求解器的端口、内存上限与线程数发生变化**；' +
      '这些限制决定了「哪些场景能建树」，是能力审计的一部分',
  },
  {
    path: 'test/helpers/fakeGtopen.ts',
    category: ManifestCategory.DECISION,
    impact:
      '假求解器变化 → **GTO 适配层测试的有效性发生变化**；' +
      '它必须与真实响应结构一致，否则测试会「绿着通过、生产里失败」',
  },
  {
    path: 'test/gtoHandMatrix.test.ts',
    category: ManifestCategory.REPORT,
    impact: '169 类矩阵测试变化 → 同花/不同花与类号方向的防线强度发生变化',
  },
  {
    path: 'test/gtoProviderAdapter.test.ts',
    category: ManifestCategory.REPORT,
    impact: 'GTO 适配层测试变化 → 失败回退与墨菲定律审计的覆盖范围发生变化',
  },
  {
    path: 'test/gtoScenarioIsolation.test.ts',
    category: ManifestCategory.REPORT,
    impact:
      '桌人数隔离与契约边界测试变化 → **「不同桌人数不得复用」与「只有适配层能碰求解器」的防线强度发生变化**',
  },
  {
    path: 'test/gtoWebUi.test.ts',
    category: ManifestCategory.REPORT,
    impact: 'GTO 界面与接口测试变化 → 「求解器离线时 Alpha 仍可用」的防线强度发生变化',
  },
  {
    path: 'test/newTableModal.test.ts',
    category: ManifestCategory.REPORT,
    impact:
      '新建牌桌弹层测试变化 → **「桌型 / Hero 座位到底能不能选」这条防线强度发生变化**。' +
      '🔴 它防的是一个真实缺陷：弹层里点桌型之后，`openNewTableModal()` 重进函数时' +
      '把局部变量 `chosenSize` 重置回 `app.state`，使用者的选择当场丢失 —— ' +
      '界面表现是「桌型根本选不动」，只能建出与当前桌型相同的桌子。',
  },
  {
    path: 'test/raiseSizeGrid.test.ts',
    category: ManifestCategory.REPORT,
    impact:
      '加注尺寸网格测试变化 → **「加注到底有没有得选」这条防线强度发生变化**。' +
      '🔴 它防的是一个真实缺陷：`buildSizeGrid` 对 BET 与 RAISE 共用同一份底池百分比网格，' +
      '而加注的基准应当是「跟注额的倍数」—— 百分比算出的数额低于最小加注额后被去重成一项，' +
      '于是菜单只剩「最小加注 + 全下」。' +
      '⚠️ 既有的 `hotfix001ActionDedup.test.ts` **抓不到它**（它只断言 `raises.length >= 1`，' +
      '1 个尺寸就满足了）—— 这两个文件的防线是互补的，不得互相替代。',
  },
  {
    path: 'test/handClassOrdering.test.ts',
    category: ManifestCategory.REPORT,
    impact:
      '**169 类手牌顺序的桥接防线**变化 → 「接 GTO 时会不会静默错位」这条防线强度发生变化。' +
      '🔴 项目里有**两套** 169 类顺序（GTO 显示顺序 `AA AKs AQs…` vs 先验顺序 `AA AKs AKo…`），' +
      '实测只有 **5/169** 个位置相同。按序号直接对接会把约 164 个牌型的频率灌到别的牌上，' +
      '而且**长度对得上、类型对得上、没有任何报错**。' +
      '这个文件钉住两套顺序的差异，并提供按**牌名**对齐的转换器。',
  },
  {
    path: 'test/solverRangePrior.test.ts',
    category: ManifestCategory.REPORT,
    impact:
      '**翻前 GTO 范围接入**的防线变化 → 「对手范围是算的还是猜的」这条链的可信度发生变化。' +
      '🔴 它防三类**会静默出错**的缺陷：' +
      '① 按序号对接 169 类（约 164 个牌型错位）；' +
      '② 尺寸/筹码对不上却照用（读到的是**另一个牌局**的策略，数字看起来正常）；' +
      '③ 对求解器范围再乘一次似然（重复计票，范围被收缩两次）。',
  },
  {
    path: 'test/tableDynamicsIdSpace.test.ts',
    category: ManifestCategory.REPORT,
    impact:
      '🔴 **桌况链路的 ID 口径**回归锁：钉住「座位 id（`seat_BTN`）」与' +
      '「持久 playerId（`p2`）」不得混用。' +
      '`computeTableDynamics` 的三个入参（`presentPlayerIds` / `heroPlayerId` / ' +
      '`relevantPlayerIds`）都在持久 id 空间，而引擎侧给的是座位 id；' +
      '混用会造成**静默失效**：实测 `recordsUsed` 0（6 条记录全被判「非在桌玩家」）' +
      '⇒ 桌况恒为「观察中」、调整永不生效，且没有任何报错。' +
      '它同时锁住「Hero 自己的行为不得混进对手桌况」这条自我剥削防线。',
  },
  {
    path: 'test/preflopRaiseCashflow.test.ts',
    category: ManifestCategory.REPORT,
    impact:
      '🔴 **翻前加注资金流与引擎分层台账逐位一致**的回归锁。' +
      '它防的是一类特别隐蔽的缺陷形态：**测试与生产共享同一条错误公式**，' +
      '于是「测试全绿」与「公式错误」同时成立。' +
      '本项目在这一行上错过**两次**（把「他跟注要补的差价」当成「他投入的量」），' +
      '因此本文件的期望值一律由**引擎台账**（`computeLayeredPot` 的 ' +
      '`main` / `contested` / `returned`）给出，事实包只提供「要测哪个尺寸」。' +
      '⚠️ 它同时钉住「`finalPot` ≠ `computePot`」这条口径区分：' +
      '`computePot = main + returned`，只在双方都能跟满时相等。',
  },
  {
    path: 'test/solverRangeAdmission.test.ts',
    category: ManifestCategory.REPORT,
    impact:
      '**求解器缓存准入闸**的防线变化 → 「没收敛的快照能不能进建议」这条链的可信度发生变化。' +
      '🔴 它防的缺陷实测存在：缓存里 `c067cd8cb`（6MAX/1000000BB/UTG/RFI）' +
      '`brGapTotal 129.147510` 而 `targetGap` 只有 `0.2`、`notConverged = true`，' +
      '却被当成求解器结论换掉对手的 169 类权重（权益、底价、Call EV、动作排名全跟着变）。' +
      '它同时钉住**判别力**：必须拒绝未收敛的，也**必须不能**误杀已收敛的，' +
      '因此冻结了「不给 `effectiveStackBB` 加人为上限」这条决定。',
  },
  {
    path: 'src/app/manualInput/solverRangePrior.ts',
    category: ManifestCategory.DECISION,
    impact:
      '🔴 **范围先验的来源开关**：这个文件决定「对手范围来自求解器还是启发式」。' +
      '它变化会直接影响所有翻前决策的输入数据。' +
      '⚠️ 它内含四道拒绝闸（动作可达性 / 配置匹配 / 行动者一致性 / **收敛准入**），' +
      '放宽任何一道都会让**别的牌局**的策略、或**没收敛的噪声**被当成这个牌局的结论。' +
      '`admitSolverBaseline` 是**冷求解与缓存共用**的那一道闸 —— ' +
      '只加在其中一条路径上等于没加（另一条会成为漏洞）。',
  },
  {
    path: 'src/app/manualInput/solverScenarioForOpponent.ts',
    category: ManifestCategory.DECISION,
    impact:
      '「对手动作 → 求解节点」的映射表变化 → **哪些情形能用 GTO 范围**发生变化。' +
      '⚠️ 只支持 `RFI` 与 `VS_OPEN` 两种；多轮加注 / 跛入 / 补盲**一律返回 null** 并回落。' +
      '把「用相近节点顶替」加进来会读到别人的策略 —— 这是本项目反复修掉的那类缺陷。',
  },
  {
    path: 'src/app/gto/backgroundSolve.ts',
    category: ManifestCategory.DECISION,
    impact:
      '🔴 **前台响应速度与 GTO 覆盖率的分离机制**变化 → 「分析要等多久」与' +
      '「多久之后能用上 GTO 范围」这两件事都发生变化。' +
      '⚠️ 它承载 Phase 1.3 的核心交易：前台**只读缓存、绝不求解**（冷求解实测 6 人桌 59 秒 / ' +
      '9 人桌 195 秒），未命中则把场景排进后台队列，求解成功后**自动落盘**，' +
      '于是第二次同样的局面直接命中 GTO 范围。' +
      '把 `lookupWithStats`（会落盘）换成 `lookupScenario`（不落盘）会让「算完了但没存」—— ' +
      '表现为每次重启都要重算几十分钟，且**没有任何报错**。' +
      '把前台改成等待后台任务会让响应时间退化到分钟级。',
  },
  {
    path: 'test/backgroundSolve.test.ts',
    category: ManifestCategory.REPORT,
    impact:
      '**前台不等求解器**这条保证的防线变化 → 「1～3 秒给建议」这个核心指标的强度发生变化。' +
      '🔴 它钉住三件事：① 缓存未命中时前台耗时必须是毫秒级（不得退化成等待求解）；' +
      '② 同一场景只入队一次（连点十次不等于算十次）；' +
      '③ 落盘路径走的是会写缓存的那一层（否则第二次查询永远还是启发式）。',
  },
  {
    path: 'scripts/gto-phase13-probe.ts',
    category: ManifestCategory.REPORT,
    impact:
      '**Phase 1.3 实况判据**变化 → 「前台不等求解器 / 后台会补算 / 第二次自动用上 GTO」' +
      '这三条保证的验证强度发生变化。' +
      '⚠️ 它对接**真实服务**（默认 5173）断言四件事：① 前台回答与求解耗时**无关**；' +
      '② 未命中时如实标注「正在后台计算」且说明之后会自动改用 GTO；' +
      '③ 后台算完后同样的查询**自动**变成 `fromSolver=true`；' +
      '④ 结构上算不了的局面对「等也不会变」说清楚，不误导成「稍后就有」。',
  },
  {
    path: 'src/domain/poker/pots.ts',
    category: ManifestCategory.DECISION,
    impact:
      '🔴 **分层底池与「会被争夺的量」**变化 → 底池赔率、跟注 EV、可赢上限**全线**变化。' +
      '⚠️ 这个模块回答三个规则问题：① 无人能跟的超额筹码必须**退回**（不是底池）；' +
      '② 多路不同筹码全下时按主池/边池**分层**（短筹码赢不了整池）；' +
      '③ 弃牌者的钱是**死钱** —— 留在池里、并入可争夺的量，但不算「退回」。' +
      '🔴 不变量：`主池 + 边池 + 退回 === 所有人投入之和`（`selfCheckLayeredPot` 在服务器启动时强制，失败即拒绝启动）。' +
      '最容易写错的两种情形：把「只有一名未弃牌玩家投到的层」当成边池（它该退回）；' +
      '把「我还没跟注」造成的暂时性未跟注当成永久退回（它会被我跟，不该退）。',
  },
  {
    path: 'test/pokerRules.test.ts',
    category: ManifestCategory.REPORT,
    impact:
      '🔴 **德州扑克规则对照（含独立参考实现）**变化 → 「引擎是否符合真实规则」这条保证的强度发生变化。' +
      '⚠️ 它刻意**不调用**项目的评估函数，自己穷举全部 5 张组合写了一份最朴素的参考实现 —— ' +
      '因为 `handEval` 与 `fastEval` 是同一套规则的两份实现，它们**共享错误**时差分测试恒为 0' +
      '（2026-09 真的发生过：两对踢脚在三对共存时取错，62 万+ 随机 7 张差异为 0）。' +
      '钉住的规则：两对踢脚（三对共存）、大盲的选择权（引擎/推导跨层一致性）、' +
      '短大盲不降低入池代价、短全下不关闭未行动者的加注权。',
  },
  {
    path: 'scripts/gto-live-probe.ts',
    category: ManifestCategory.REPORT,
    impact: '真实求解器联调探针变化 → 5 个桌人数真实数据验证的可复现性发生变化',
  },
  {
    path: 'scripts/start-alpha.cmd',
    category: ManifestCategory.ENVIRONMENT,
    impact:
      '**Alpha 的唯一启动入口** → 启动方式变化意味着「网页打不开」这类问题的排查起点变化。' +
      '⚠️ 这个文件必须是**纯 ASCII**：`cmd.exe` 用 OEM 代码页（本机是 GBK）读取 `.cmd`，' +
      '写成 UTF-8 的中文会被解析成残缺命令（实测过）。',
  },
  {
    path: 'scripts/stop-alpha.cmd',
    category: ManifestCategory.ENVIRONMENT,
    impact:
      'Alpha 的停止入口 → 它必须**只杀监听指定端口的进程**，' +
      '否则会误伤 GTOpen 求解器（3737）与其它 node 进程。同样是纯 ASCII。',
  },
  {
    path: 'scripts/gto-vs3bet-live-probe.ts',
    category: ManifestCategory.REPORT,
    impact:
      '「开池后面对 3Bet」几何联调探针变化 → **「Hero 是否会真的轮到」这条结论的证据强度发生变化**' +
      '（该几何被实测推翻过六次，探针是唯一的守卫）',
  },
  {
    path: 'scripts/gto-node-walk.raw.mjs',
    category: ManifestCategory.REPORT,
    impact:
      '裸节点行走工具变化 → **「不经过本项目任何场景模型、直接问求解器每一步轮到谁」的能力发生变化**' +
      '（六次几何修正中的每一次都靠它定案）',
  },
  {
    path: 'reports/evidence/gto-vs3bet-live-evidence.txt',
    category: ManifestCategory.REPORT,
    impact:
      '「面对 3Bet」联调证据变化 → **「17/17 都真的走到 Hero」与「菜单只有 Fold·Call」两条结论的证据发生变化**',
  },

  /* ---- 报告（红队与审计） ---- */
  {
    path: 'CURRENT_PROJECT_STATUS.md',
    category: ManifestCategory.REPORT,
    impact:
      '**阶段状态的单一事实来源变化 → 项目进度声明发生变化**' +
      '（若它被改动，必须确认新状态与代码事实一致）',
  },
  {
    path: 'docs/ALPHA_USAGE.md',
    category: ManifestCategory.REPORT,
    impact:
      'Alpha 使用说明变化 → **使用者理解如何输入与如何解读结果的方式发生变化**' +
      '（含金额语义、行动顺序、已知限制的说明）',
  },
  {
    path: 'reports/EXTERNAL_KNOWLEDGE_AUDIT.md',
    category: ManifestCategory.REPORT,
    impact: '外部知识审计结论变化 → 「哪些来源可用」的记录发生变化',
  },
  {
    path: 'reports/KNOWLEDGE_REDTEAM_AUDIT.md',
    category: ManifestCategory.REPORT,
    impact: '知识层红队报告变化 → 已知缺陷清单发生变化',
  },
  {
    path: 'reports/PLAYER_REDTEAM_AUDIT.md',
    category: ManifestCategory.REPORT,
    impact: '玩家画像红队报告变化 → 已知缺陷清单发生变化',
  },
  {
    path: 'reports/NUMSTAB_REDTEAM_AUDIT.md',
    category: ManifestCategory.REPORT,
    impact: '数值稳定性红队报告变化 → 已知缺陷清单发生变化',
  },
  {
    path: 'reports/RANGE_REDTEAM_AUDIT.md',
    category: ManifestCategory.REPORT,
    impact: '范围引擎红队报告变化 → 已知缺陷清单发生变化',
  },
  {
    path: 'reports/DYNAMIC_REDTEAM_AUDIT.md',
    category: ManifestCategory.REPORT,
    impact:
      '动态行为红队报告变化 → 已知缺陷清单与「假阴性」风险的记录发生变化' +
      '（该报告记录了两轮审计：作者自查 3 CRITICAL + 2 MAJOR，' +
      '独立红队 3 CRITICAL + 9 MAJOR，全部为测试全绿时存在的缺陷）',
  },
  {
    path: 'reports/DYNAMIC_INDEPENDENT_REDTEAM.md',
    category: ManifestCategory.REPORT,
    impact:
      '**独立**红队报告变化 → 第三方视角的缺陷清单与判定结论发生变化' +
      '（该报告由未参与实现的审计员产出，方法为批量确定性种子统计 / 边界扫描 / 源码死代码检查，' +
      '判定从 FAIL 到全部修复的追溯链依赖它）',
  },

  /* ---- 制品工具（生成/校验清单的代码本身） ---- */
  {
    path: 'src/infra/artifactManifest.ts',
    category: ManifestCategory.DECISION,
    impact: '产物清单的生成与校验逻辑变化 → hash 绑定的可信度发生变化',
  },
  {
    path: 'src/infra/artifactDefinitions.ts',
    category: ManifestCategory.DECISION,
    impact: '产物定义表变化 → 哪些文件被 hash 绑定发生变化',
  },
  {
    path: 'scripts/generateManifest.ts',
    category: ManifestCategory.DECISION,
    impact: '清单生成脚本变化 → 生成与校验行为发生变化',
  },
  {
    path: 'scripts/alpha-demo.ts',
    category: ManifestCategory.DECISION,
    impact:
      '端到端命令行演示变化 → **「输入一手牌 → 打印完整建议与诊断」的可复现证据发生变化**',
  },
  {
    path: 'reports/ALPHA_INDEPENDENT_REDTEAM.md',
    category: ManifestCategory.REPORT,
    impact:
      'Alpha 决策链独立红队报告变化 → **已知缺陷清单（F-01 … F-13）发生变化**；' +
      '每个编号必须有对应的永久回归测试（`test/alphaRedteamRegression.test.ts`）。' +
      '⚠️ 修复轮中又自查出 F-14 / F-15（同族缺陷，红队未报），' +
      '它们的记录在 `reports/TEST_MATRIX.md` §0.4 与本文件对应的回归测试里 —— ' +
      '**不得因为红队报告里没有就把它们当成不存在**',
  },
  {
    path: 'test/alphaRedteamRegression.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      '红队发现的永久回归测试变化 → **「已修复的缺陷是否仍然被锁住」这一保证发生变化**；' +
      '本文件删掉任何一条断言都等于放弃对应的修复',
  },
  {
    path: 'test/manualInputPriors.test.ts',
    category: ManifestCategory.RANGE,
    impact:
      '翻牌前先验与似然模型的单元测试变化 → **范围表结构性不变量（单调性 / 覆盖度 / 3Bet 更紧 / 来源标注）' +
      '的保护强度发生变化**（这两个模块曾零覆盖，是红队 F-02 的根因）',
  },
  {
    path: 'scripts/alpha-perf.ts',
    category: ManifestCategory.DECISION,
    impact:
      '端到端性能实测脚本变化 → **「1–3 秒内给出建议」这一锁定指标的证据发生变化**；' +
      '本脚本只测量、不做判断，数字必须原样进报告',
  },
  {
    path: 'reports/ALPHA_FINAL_REPORT.md',
    category: ManifestCategory.REPORT,
    impact:
      'Alpha 最终报告变化 → **判定（`INTERNAL ALPHA TESTABLE — PASS/FAIL`）与全部证据发生变化**；' +
      '本文件是「能不能开始用真实牌局测试」的唯一依据，数字必须可由命令复现',
  },

  /* ---- 交互式牌桌录入（UI / 输入工作流重构） ---- */
  {
    path: 'src/app/table/table.types.ts',
    category: ManifestCategory.DECISION,
    impact:
      '牌桌数据模型变化（座位状态 / 座位 / 玩家 / 牌桌状态 / 操作）→ ' +
      '**「Fold ≠ Leave」「Seat ≠ Player」这两条铁律的表达能力发生变化**；' +
      '`SeatStatus` 少一个成员就等于把两种语义混成一种，必须同步全部生命周期测试',
  },
  {
    path: 'src/app/table/tableState.ts',
    category: ManifestCategory.DECISION,
    impact:
      '牌桌创建与**视觉旋转**变化 → **Hero 的视觉位置与逻辑位置是否仍然分离**发生变化' +
      '（视觉位置一旦参与计算，就会出现「Hero 显示在底部所以他是 BB」这类致命错误）；' +
      '`staffingProblems` 同时是「能不能分析」的判据来源',
  },
  {
    path: 'src/app/table/seatLifecycle.ts',
    category: ManifestCategory.DECISION,
    impact:
      '座位生命周期变化（加入 / 清空 / 换人 / 暂离 / 手后离桌 / 下一手 / 新牌桌 / 撤销 / 手牌与公共牌）→ ' +
      '**哪些操作会改动座位绑定、玩家画像、筹码与手牌历史发生变化**；' +
      '本文件里任何「按座位删除历史」的改动都会破坏筹码守恒与行动台账',
  },
  {
    path: 'src/app/table/tableOps.ts',
    category: ManifestCategory.DECISION,
    impact:
      '牌桌操作分发变化（尤其是 `applyTableAction` 的**重放等价自检**）→ ' +
      '**「牌桌显示的状态」与「分析时重放出的状态」是否仍然一致**发生变化；' +
      '去掉那一段自检等于放弃这条保证',
  },
  {
    path: 'src/app/table/tableAdapter.ts',
    category: ManifestCategory.DECISION,
    impact:
      '牌桌状态 → `ManualHandInput` 的**唯一转换点**变化 → ' +
      '**「屏幕显示 = 实际提交 = 后端状态」三者一致**这一保证发生变化' +
      '（首要对手的画像必须按 playerId 解析；引擎侧 id 必须用 `seat_<位置>` 口径，' +
      '否则动态层的事件匹配会静默失效）',
  },
  {
    path: 'src/app/table/tablePreview.ts',
    category: ManifestCategory.DECISION,
    impact:
      '牌桌预览变化（街道 / 当前行动者 / 合法动作按钮 / 底池筹码 / 座位视图 / 状态指纹）→ ' +
      '**使用者看到的牌局与合法动作集合发生变化**；' +
      '本文件必须继续复用 `reconstruct` + `deriveLegalActions` + Poker Core 校验器，' +
      '一旦自己实现规则，前端与引擎就会分叉',
  },
  {
    path: 'src/app/table/tableApi.ts',
    category: ManifestCategory.DECISION,
    impact:
      '牌桌 API 变化（请求形状校验 / Fail-Closed / **版本水位线** / 元数据）→ ' +
      '**畸形载荷是否被拒绝、迟到请求是否会被丢弃**发生变化；' +
      '`parseTableState` 是「客户端状态不可信」这条纪律的唯一执行点（撤销栈也必须逐条校验）',
  },
  /* ============================================================
   * TABLE DYNAMICS V1（牌桌动态适应）
   *
   * 这一组产物的共同点：它们决定「从真实行为记录里读出了什么桌况」，
   * 因此**改任何一个都会改变调整输入**。登记它们的目的不是形式合规，
   * 而是让「昨天为什么多调了一档」有唯一的可查对象。
   * ============================================================ */
  {
    path: 'src/app/table/playerHistory.ts',
    category: ManifestCategory.DECISION,
    impact:
      '**逐手行为记录的形状与写入时机**变化 → 「机会数 / 命中数」的分母来源变化；' +
      '该文件在**行动发生的那一刻**快照行动前状态（人数 / 有效筹码 / 底池 / ' +
      '面对下注额与池比 / 本街第几个行动 / 身后还有几人）—— 这些都是**只能在此刻取得**的事实，' +
      '事后无法从行动序列反推。改动它等于改变**此后全部桌况统计与玩家实测统计**的输入；' +
      '旧格式记录（缺桌况字段）会被桌况层如实排除并计数，不会被当成 0',
  },
  {
    path: 'src/app/table/tableDynamicsSeatOrder.ts',
    category: ManifestCategory.DECISION,
    impact:
      '本街行动顺序的共享推导变化 → 「身后还有几个未行动的对手」与「翻前第几个行动」' +
      '所依据的顺序发生变化；该顺序由 `config.tableSize` + `config.dealerPosition` 推导，' +
      '**取不到就返回空顺序并让相关字段为 null（不猜）**。' +
      'playerHistory 与 tableDynamicsServer 必须共用这一份实现',
  },
  {
    path: 'src/domain/tableDynamics/tableDynamics.ts',
    category: ManifestCategory.DECISION,
    impact:
      '**桌况模型与五类调整方向**变化 → 十项维度（入池松紧 / 冷跟 / 再加注压力 / 多人底池 / ' +
      '三档面对下注弃牌 / 持续下注 / 过牌加注 / 盲注弃池）的机会定义、工程基线、' +
      '平滑与收缩强度、方向门槛、调整幅度上限（±15%）发生变化 ⇒ ' +
      '**对手标签与调整方向会变**。改动必须同步核对 `TABLE_DYNAMICS_CONFIG` 里的 ' +
      '「工程初始值」声明不得被写成「已校准参数」',
  },
  {
    path: 'src/domain/tableDynamics/tableDynamicsShadow.ts',
    category: ManifestCategory.DECISION,
    impact:
      '**影子执行契约**变化 → 「正式建议是否先于调整计算」「失败与超时是否被收敛为状态」' +
      '「调整后的建议是否被写回正式建议」发生变化。' +
      '🔴 本文件是「影子模式绝不改变正式建议」这条保证的唯一执行点：' +
      '任何把 `adjusted` 回写 `base`、或让异常向上传播的改动都会破坏它',
  },
  {
    path: 'src/domain/tableDynamics/tableDynamicsDigest.ts',
    category: ManifestCategory.DECISION,
    impact:
      '桌况稳定摘要的算法变化 → **缓存键 / 重放判据**变化；' +
      '摘要必须只包含**影响结果**的部分（版本、可信度、逐维度机会数与收缩后比率），' +
      '不含耗时与文案 —— 否则「同一输入」会产生不同键，表现为缓存永远不命中',
  },
  {
    path: 'src/app/table/tableDynamicsWiring.ts',
    category: ManifestCategory.DECISION,
    impact:
      '**调整落到输入的翻译层**变化 → 对手标签注入到哪个字段、哪些座位被跳过发生变化；' +
      '🔴 本文件是「不产生动作、不加 EV、不伪造」三条禁令的执行点：' +
      '它只能改 `seatProfiles`（或已存在的 `villains[]` 项），' +
      '座位 id 对不上时必须**跳过并记录原因**，不得硬塞键让模型静默忽略',
  },
  {
    path: 'src/app/table/tableDynamicsServer.ts',
    category: ManifestCategory.DECISION,
    impact:
      '**服务端接入**变化 → 桌况取数（玩家历史）、模式解析（`DSH_TABLE_DYNAMICS`，默认影子、' +
      '`ACTIVE` 本阶段必须降级）、影子对比落盘路径（`<dataDir>/table-dynamics-log.jsonl`）' +
      '与响应片段形状发生变化 ⇒ **界面上看到的桌况与实验对比会变**',
  },
  {
    path: 'test/tableDynamics.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      '桌况模型的**行为契约锁**变化 → 「无数据不得编造数字」「机会数不等于动作次数」' +
      '「少量连续加注不得产生极端调整」「整桌偏松不得覆盖个体紧」「离桌玩家不得主导桌况」' +
      '「不读未来信息」「单挑与多人边界」「影子不改变正式建议」' +
      '「调整后金额仍合法」这些保证发生变化',
  },
  {
    path: 'test/tableDynamicsE2E.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      '桌况**端到端契约锁**变化 → 「真实牌桌操作确实写入桌况字段」「重复事件不重复累计」' +
      '「撤销后无残留」「影子对比记录字段齐全且可逐条读回」「桌况变化则摘要变化」' +
      '这些保证发生变化',
  },
  {
    path: 'scripts/table-dynamics-examples.ts',
    category: ManifestCategory.REPORT,
    impact:
      '牌桌动态适应的**三组可重放示例**（盲位弃给开池偏多 / 跟注偏多 / 再加注压力较高）变化 → ' +
      '「桌况读出来是什么方向、注入哪些对手标签、可信度多少」的书面基准发生变化；' +
      '该脚本只读（不写文件、不改状态），运行方式：`node --experimental-strip-types scripts/table-dynamics-examples.ts`',
  },
  {
    path: 'reports/PROJECT_FUNCTIONAL_STATUS_AUDIT.md',
    category: ManifestCategory.REPORT,
    impact:
      '**全项目功能状态审计**（逐项给出完成程度 / 验证程度 / 是否影响正式建议 / ' +
      '当前能做什么 / 关键限制与证据）变化 → ' +
      '「这套软件现在实际能完成什么、哪些只是框架或影子、哪些会让结论错误」的' +
      '**唯一书面基准**发生变化；它同时登记了未完成项、优先工作包与未审范围，' +
      '改动它等于改变对项目当前状态的判断',
  },
  {
    path: 'src/app/web/table.js',
    category: ManifestCategory.DECISION,
    impact:
      '客户端脚本变化 → **界面的交互方式与渲染结果发生变化**；' +
      '🔴 本文件**不允许**出现任何牌局规则（轮到谁 / 合法动作 / 街道推进 / 底池 / 筹码），' +
      '一旦出现，前端与后端就会在某个边界上分歧，而表现形式是「牌桌看起来对、后端收到的是另一个牌局」',
  },
  {
    path: 'test/liveUiV2.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      'LIVE UI V2 的**界面与交互回归锁**变化 → ' +
      '「空座位只显示加号且仍可点开真实座位菜单」「最近动作最多 5 条并如实说明前面还有几条」' +
      '「🔴 服务端的建议绝不能被当成 Hero 的实际动作写进牌局」「切到录入历史必须收起旧建议」' +
      '「主要动作按钮 ≥ 42px / 座位卡片 92×48 / 顶栏 44px 与右栏 380px」' +
      '「🔴 body 锁死纵向滚动」「🔴 不用大面积绿色毡面与任何渐变」「蓝色只给 Hero 与当前行动者」' +
      '「右栏顺序必须是行动者→动作→建议→最近动作」「table.css 里 V1 的 11 段覆盖块必须消失」' +
      '「index.html 必须在其后加载 live-ui.css」「代码里不得再用 insertBefore」' +
      '「重叠请求结束后控件必须复原」这些保证发生变化；' +
      '删掉任何一条断言都等于放弃对应的界面纪律',
  },
  {
    path: 'reports/LIVE_UI_V2_GIT_AND_MERGE.md',
    category: ManifestCategory.REPORT,
    impact:
      'LIVE UI V2 的**分支状态与双电脑合并注意事项**变化 → ' +
      '「哪些文件必然冲突、哪些只是追加、合并后必须复验哪几条命令、' +
      '出现某类症状时先查哪一行代码」的书面基准发生变化；' +
      '它同时记录了本轮修复的三个产品缺陷在合并后可能被回退掉的**具体代码位置**',
  },
  {
    path: 'reports/LIVE_UI_V2_REPORT.md',
    category: ManifestCategory.REPORT,
    impact:
      'LIVE UI V2 交付报告变化 → 「界面到底长什么样、多少像素、点几下、多快、' +
      '以及本轮从真实浏览器里抓出了哪三个产品缺陷」的书面基准发生变化；' +
      '它同时记录了三处**由截图而非测试发现**的缺陷（选牌 500 / 自洽检查误判 / 控件永久禁用）' +
      '与它们的回归锁位置，改动它等于改变对「这一轮究竟改了什么」的判断',
  },
  {
    path: 'src/app/web/table.css',
    category: ManifestCategory.DECISION,
    impact: '牌桌样式变化 → 只影响观感；不得借样式隐藏状态（例如把「暂离」画成「在座」）',
  },
  {
    path: 'src/app/web/live-ui.css',
    category: ManifestCategory.DECISION,
    impact:
      'LIVE UI V2 布局与外观的唯一来源（顶栏 44px / 左椭圆牌桌 / 右 380px 操作台）变化 → ' +
      '**实战录入时的可见信息与可点击区域发生变化**；' +
      '🔴 它同时承担三条界面纪律的视觉实现：' +
      '(1) **不用大面积绿色毡面**、蓝色只给 Hero 与当前行动者；' +
      '(2) 主操作按钮 ≥ 42px、座位卡片 ≥ 90×48px（不得为塞进一屏而缩小到难以点击）；' +
      '(3) 1366×768 下正常录入一手牌**不出现纵向滚动**；' +
      '改这里等于改变「使用者一眼能看到什么」，而看不清当前行动者与合法动作会直接导致录入错误',
  },
  {
    path: 'test/interactiveTable.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      '座位生命周期与三条铁律的永久回归测试变化 → **「Fold ≠ Leave」「Seat ≠ Player」' +
      '「当前手历史不可删」这三条保证的强度发生变化**；删掉任何一条断言都等于放弃对应的修复',
  },
  {
    path: 'test/interactiveTableDifferential.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      '差分测试变化 → **「牌桌点选」与「直接构造输入」两条路径逐位一致**这一保证发生变化；' +
      '这是「界面在撒谎」的主防线',
  },
  {
    path: 'test/interactiveTableApi.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      'API/HTTP 层测试变化 → **畸形载荷被拒、竞态被挡、双击不重复提交**这些保证发生变化',
  },
  {
    path: 'scripts/table-walkthrough.ts',
    category: ManifestCategory.DECISION,
    impact:
      '现场走查脚本变化 → **每个 Spot 的点击次数与服务端耗时证据发生变化**；' +
      '点击次数决定了录入效率上限，效率退化必须立刻可见',
  },
  {
    path: 'docs/TABLE_INPUT_USAGE.md',
    category: ManifestCategory.REPORT,
    impact: '牌桌录入使用说明变化 → **使用者「怎么点」的方式发生变化**（含三条铁律的行为说明）',
  },
  {
    path: 'reports/TABLE_INTERACTIVE_REDTEAM_LIFECYCLE.md',
    category: ManifestCategory.REPORT,
    impact:
      '牌桌录入**座位生命周期/玩家身份**独立红队报告变化 → **该视角的已知缺陷清单发生变化**；' +
      '每个编号（RT-Lx）必须有对应的永久回归测试',
  },
  {
    path: 'reports/TABLE_INTERACTIVE_REDTEAM_ADAPTER.md',
    category: ManifestCategory.REPORT,
    impact:
      '牌桌录入**适配器/卡牌映射/竞态/前端诚实性**独立红队报告变化 → ' +
      '**该视角的已知缺陷清单与增量复验结论发生变化**；' +
      '每个编号（F-xx / V-xx）必须有对应的永久回归测试',
  },
  {
    path: 'reports/TABLE_INTERACTIVE_REPORT.md',
    category: ManifestCategory.REPORT,
    impact:
      '牌桌录入最终报告变化 → **判定（`INTERACTIVE TABLE INPUT — PASS/FAIL`）与全部证据发生变化**；' +
      '本文件是「能不能停止开发 UI、转入真实牌局测试」的唯一依据',
  },
  {
    path: 'test/interactiveTableRedteam.test.ts',
    category: ManifestCategory.DECISION,
    impact: '红队第一轮（RT-L1…L5）的永久回归测试变化 → 对应修复的保护强度发生变化',
  },
  {
    path: 'test/interactiveTableRedteam2.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      '红队第二轮（F-01/F-02/V-xx）的永久回归测试变化 → 对应修复的保护强度发生变化；' +
      '含一个 **DOM 桩**真实执行 `table.js`（能抓到「渲染残骸让整块面板不再更新」这类缺陷）',
  },
  {
    path: 'scripts/table-probe-buttons.ts',
    category: ManifestCategory.DECISION,
    impact:
      '按钮合法性穷举 + 畸形载荷 HTTP 穷举脚本变化 → **「预览给出的按钮 100% 被后端接受」' +
      '与「畸形载荷 0×5xx」这两条不变量的证据发生变化**',
  },
  {
    path: 'scripts/rt-table-adapter-probe3.ts',
    category: ManifestCategory.DECISION,
    impact:
      '红队**最终快照增量复验**探针变化 → 「最后一轮修复没有破坏任何既有结论」这一结论的证据发生变化；' +
      '本文件是「交付依据 = 最终快照 + 增量复验 PASS」的支撑',
  },
  {
    path: 'test/tableTopology.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      '桌型拓扑（Table Topology Correction）**黄金用例 + 产品路径**回归测试变化 → ' +
      '**「9 座桌 8 人可分析」「空座位不阻断」「单挑顺序」「Button 轮转」**这些保证发生变化；' +
      '含一条**反证**：域层放行时表层不得拦回（拦截点搬家是本轮的头号缺陷形态）',
  },
  {
    path: 'test/tableTopology.property.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      '桌型拓扑**属性测试**（穷举 9,481 组拓扑组合 + 5,551 组 Button 轮转）变化 → ' +
      '「容量 × 本手人数 × Button 座位的每一个组合都成立」这一保证发生变化',
  },
  {
    path: 'test/seatSwap.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      '**座位对调语义**（`setHeroPosition`）回归测试变化 → ' +
      '「换位后玩家数 / 空位数 / 桌上筹码总数三者逐位不变」「Button 不悬空 ⇒ 本手角色 = 所坐座位名」' +
      '「目标座位空着时 Hero 的筹码跟着他走」这四条保证发生变化；' +
      '本文件是使用者报告「6 人桌设为 UTG 却显示大盲位」的修复锁',
  },
  {
    path: 'test/preflopFiveBetMinRaise.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      '**翻前连续再加注（3Bet/4Bet/5Bet）最小加注额**回归测试变化 → ' +
      '「lastRaiseSize 必须是上一次完整加注增量 ⇒ minRaiseTo = currentBet + lastRaiseSize」' +
      '「加注低于最小额被拒、短码全下例外成立、不足额全下不改写 lastRaiseSize」' +
      '「尺寸网格与决策候选不得出现低于最小额的尺寸」「最终建议必须落在网格内且可被实际执行入口接受」' +
      '「全下的 amountChips 是本 street 投入口径（预览按钮刻意不带金额）」这些保证发生变化；' +
      '本文件是使用者报告「建议 5Bet 到 32BB（最小应为 34BB）」的专项审计结论锁',
  },
  {
    path: 'reports/TABLE_SIZE_SEMANTICS_AUDIT.md',
    category: ManifestCategory.REPORT,
    impact:
      '**桌型语义独立审计**报告变化 → 「`tableSize` 这个字段在 185 处引用里哪些真需要容量、' +
      '哪些真需要本手人数」这一分桶结论与未收敛清单发生变化',
  },
  {
    path: 'scripts/rt-topology-verify.ts',
    category: ManifestCategory.DECISION,
    impact:
      '桌型拓扑**端到端复验**探针变化 → 「产品路径上真的能分析 9 座 8 人」这一结论的证据发生变化；' +
      '本文件刻意**只走产品入口**（applyTableOp / buildTablePreview / handleTableRequest），' +
      '因为「域层修好了、表层拦回来」这种缺陷只有产品路径能发现',
  },
  {
    path: 'reports/TABLE_TOPOLOGY_CORRECTION.md',
    category: ManifestCategory.REPORT,
    impact:
      '桌型拓扑修正最终报告变化 → **判定（`TABLE TOPOLOGY CORRECTION — PASS/FAIL`）与全部证据发生变化**；' +
      '本文件是「容量 ≠ 本手人数」这一结构修正能否收尾、可否转入真实牌局测试的唯一依据',
  },
  {
    path: 'test/hotfix001BoardLeak.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      '**决策时刻可见性不变量**（`DecisionContext` 只能包含该决策时已公开的信息）的永久回归变化 → ' +
      '**「未来牌泄漏进更早的决策快照」这一 CRITICAL 风险的保护强度发生变化**；' +
      '含「绕过 Parser 直接攻击 ContextBuilder」与「少了也要拒（exact 而非 at-most）」两类反证',
  },
  {
    path: 'test/autoAnalyze.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      '**Hero Decision Ready ⇒ Auto Analyze** 后端闸门 + 12 条规范回归的永久测试变化 → ' +
      '**「手牌没选满 / 公共牌还在选 / 轮到别人 / 人员不足 / 本手已结束时绝不就绪」这些保证的强度发生变化**；' +
      '本文件直接跑真实的 `tablePreview.decision`（不是模型），并钉住 8 个原因码的优先级 —— ' +
      '`WAITING_HERO_CARDS` 与 `WAITING_BOARD` 曾因 `STATE_INVALID` 抢在前面而**恒不可达**，' +
      '删掉任何一条断言都等于放弃对应修复',
  },
  {
    path: 'test/autoAnalyzeHistoryEntry.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      '**真实 `table.js` 的 `HISTORY_ENTRY` 模式闸门**永久回归变化 → ' +
      '**「录入历史下不自动分析 / 已发出的请求在录入历史期间返回不得写进用户可见决策 UI / ' +
      '切回当前决策也不得让旧 epoch 的响应复活 / 开新一手必须主动取消旧 debounce timer」' +
      '这些保证的强度发生变化**；本文件用真实 DOM 桩 + 可控 fake timer **执行生产脚本**，' +
      '闭合静态审计 F-8（此前没有任何测试执行过生产模式闸门：`autoAnalyze.test.ts` 跑的是自建模型，' +
      '唯一跑 `table.js` 的 DOM 桩测试 `setTimeout` 是 no-op 且从未进入 `HISTORY_ENTRY`）',
  },
  {
    path: 'test/helpers/tableJsHarness.ts',
    category: ManifestCategory.DECISION,
    impact:
      '**执行 `table.js` 的 harness**（DOM 桩 / 可控 fake timer / 真后端语义 fetch 桩 / bootstrap）变化 → ' +
      '**依赖它的生产路径回归可能「假绿」**：例如 fake timer 若不再支持取消或不再能精确 fire，' +
      'Case B / Case E 会静默失去鉴别力，而测试仍然全绿；' +
      '因此它不是普通测试工具，而是上述保证证据链的组成部分。' +
      '本文件刻意**不含**任何 `CURRENT_DECISION` / `HISTORY_ENTRY` 业务判断',
  },
  {
    path: 'scripts/rt-hotfix001-diverge.ts',
    category: ManifestCategory.DECISION,
    impact:
      '**增量应用 vs 完整重放**分叉定位探针变化 → ' +
      '「`DIVERGENCE_FIRST_OCCURS_AT` 是哪一条动作、差在哪些字段」这一根因结论的证据发生变化；' +
      '本探针逐字段差分（street / phase / currentBet / minRaiseTo / board / 逐玩家筹码），不是只比最终状态',
  },
  {
    path: 'test/hotfix001StreetReconciliation.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      '**街道结算（D）与 All-In 发牌（E）**的永久回归变化 → ' +
      '**「应用动作之后必须结算下注轮，且只有公共牌真的够才推进街道」与 ' +
      '「无人可行动 ≠ 已经进入摊牌，绝不凭空发牌」这两条保证的强度发生变化**；' +
      '含现场分叉场景（9 座桌 SB `CALL 1.75` 关掉翻牌前下注轮）的 12 步逐步对拍，' +
      '以及「停住不是分叉」「全下不得越过新开启的下注轮」两类反证。' +
      '删掉任何一条断言都等于让「内部一致性检查失败」重新可复现',
  },
  {
    path: 'test/hotfix001CallContract.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      '**CALL / 全下跟注金额契约（G）**的永久回归变化 → ' +
      '**「`CALL` 的金额 = 本次实际投入且被夹到剩余筹码」「全下跟注必须标成 isAllIn 并写明全下」' +
      '「不得同时显示两个等价按钮」「跟不完整时没有加注权」这些保证的强度发生变化**；' +
      '含「每一个可执行按钮都必须被后端接受」的契约扫描与「传未夹的差额必须被拒绝」的反证',
  },
  {
    /*
     * 🔴 M1 自审报告补登记：它记录的是**未提交改动**的审查结论与待裁决清单
     * （含一条会影响既有验收数字的 🟠 发现：验收块归因错误）。
     * 该结论若被后续轮次引用而文件本身悄悄变化，会出现「引用的是旧结论」这一类静默漂移。
     */
    path: 'reports/M1_FACING_BET_CHANNEL_SELF_REVIEW.md',
    category: ManifestCategory.REPORT,
    impact:
      '**面对下注画像通道 M1 的自审结论**变化 → 「下注范围层标签重标定（1.0 → 0.35）」' +
      '「RAISE EV 归因三路分解（P1 +0.2817 / P2a +0.1454 / P2b +0.9925）」' +
      '「哪些证据形态能打开通道」这些判定与待裁决项（U-F1 / U-F3 / U1 / U2 / U-F6）发生变化；' +
      '本文件同时是「上轮验收块归因需修正」这一结论的唯一书面依据',
  },
  {
    /*
     * 🔴 M1 修复报告补登记：它记录了「下注范围层吃错维度」这一缺陷的修复
     * 与**修复前后的 EV 分解**（P2b +0.9925 → 0）—— 该结论是后续一切
     * 「面对下注 EV 变化」讨论的基准，文件本身漂移会让基准失效。
     */
    path: 'reports/M1_BAND_LAYER_LABEL_SCALING_FIX.md',
    category: ManifestCategory.REPORT,
    impact:
      '**下注范围层标签重标定修复**的结论变化 → 「`betMass`/`CALL EV`/`RAISE EV` 相对纯标签的位移」' +
      '「P1 +0.2817 / P2a +0.1454 / P2b 0」这一分解、「逐轴隔离（仅 VPIP ⇒ 该层不动）」' +
      '与「首观测位移 0.9%」这些判定发生变化；' +
      '本文件同时固定「修复只影响下注范围层、未触碰响应层」的证据（`M1_FREEZE_BAND` 受控实验）',
  },
  {
    /*
     * 🔴 P1 审计报告补登记：它记录了「CALL EV 为正却弃牌」这一**已确认缺陷**的
     * 首次分歧位置（decisionEngine.ts:1816 的标尺不一致）与最小修复范围；
     * 该结论在修复落地前是唯一书面依据，文件漂移会让「修什么」失去基准。
     */
    path: 'reports/P1_99_CALL_FOLD_CONSISTENCY_AUDIT.md',
    category: ManifestCategory.REPORT,
    impact:
      '**99 中对 CALL/FOLD 一致性审计**的结论变化 → 「硬判标尺（到达范围权益差）与 callEV（下注范围权益）不一致」' +
      '「首次分歧位置 decisionEngine.ts:1816」「一致性告警本身正确」「影响面 15/75 局面」' +
      '「最小修复 = 硬判标尺与 callEV 同源 + 文案 + 6 条失败测试」这些判定发生变化；' +
      '本文件同时固定「缺陷在已推送基线 3899189 内、与 TEST 18 金额口径修复无关」这一边界结论',
  },
  {
    path: 'test/hotfix001ActionDedup.test.ts',
    category: ManifestCategory.DECISION,
    impact:
      '**UI ACTION DEDUP**（BET/RAISE 尺寸项 ↔ 独立 `ALL_IN`）的永久回归变化 → ' +
      '**「全下必须有一个入口且只能有一个」这条呈现纪律的保护强度发生变化**；' +
      '覆盖「最小加注/下注 == 全下 ⇒ 由尺寸项承担、不再生成独立 ALL_IN」' +
      '「正常加注 < 全下 ⇒ RAISE 与 ALL_IN 是两个不同动作」' +
      '「短码全下低于最小加注 ⇒ 独立 ALL_IN 不得被误删」三类情形与跨场景不变量',
  },
  {
    /*
     * 🔴 PREFLOP RAISE DECISION 阶段 A/B 报告补登记：它是本阶段
     * **唯一**记录「翻前加注第一次拥有自有 EV」的完整结论的文件 ——
     * 包含分级结论（合法按钮 / 启发式 / 模型 EV / 已校准 / 已实战验证）、
     * 明确不支持清单、参数敏感度与三类误差的分列披露。
     */
    path: 'reports/PREFLOP_RAISE_DECISION_V1.md',
    category: ManifestCategory.REPORT,
    impact:
      '**翻前加注决策系统阶段 A/B 的结论**变化 → 「翻前加注有没有自有 EV」「哪些场景明确不支持」' +
      '「全下保护与偏离最高模型 EV 的披露」「参数敏感度与权益采样误差」这些判定发生变化；' +
      '改动该文件等于改变「本阶段完成到什么程度」的**唯一书面基准**',
  },
  {
    path: 'reports/SOLVER_WIRING_AUDIT.md',
    category: ManifestCategory.REPORT,
    impact:
      '🔴 **求解器接线审计**：回答「现有求解器接在哪个入口 / 哪些局面能调用 / ' +
      '什么结果会被接受 / 最后有没有影响页面建议」。它是「先把现有连接用对、再扩大数据」' +
      '这条决策的事实依据 —— 实测同一输入注入求解器范围后，决策响应有 **225 个字段**变化' +
      '（对对手范围权益 83.0%→84.7%、Call EV 306.36→315.81、置信度 0.30→0.35、' +
      '**用户看到的中文理由文本**）。' +
      '⚠️ 它同时**推翻**了 `reports/ROUND1_COMPUTATION_AND_ADMISSION_FIX.md` §2.6 的' +
      '「生产环境里求解器范围从未生效」—— 那是探针绕过 `scenarioForOpponent` 直接构造 ' +
      '`buildGtoScenario` 造成的误判。真实覆盖面边界（只覆盖 RFI 第一个行动位、' +
      '**9MAX 缓存为 0 条**、VS_OPEN 已被实现却被生产 `maxRaises = 2` 挡死）在此逐条实测列出。',
  },
  {
    path: 'reports/ROUND1_COMPUTATION_AND_ADMISSION_FIX.md',
    category: ManifestCategory.REPORT,
    impact:
      '第一轮「计算正确性与数据准入修复」的交付记录：翻前加注资金流与引擎分层台账逐位一致、' +
      '求解器缓存准入闸（18 条真实缓存实测：拒绝 3 / 放行 15）、玩家记录 id 口径修复、' +
      '画像验收规范 A1–A5 修正。' +
      '⚠️ 它记录了本项目一处**方法论教训**：同一行公式错过两轮，' +
      '且旧测试断言的正是错误公式（「测试全绿」与「公式错误」同时成立）。' +
      '其 §2.6 的结论已在 `reports/SOLVER_WIRING_AUDIT.md` 中被推翻并就地标注保留。',
  },
  {
    path: 'reports/NINE_MAX_SOLVER_CLOSED_LOOP_V1.md',
    category: ManifestCategory.REPORT,
    impact:
      '🔴 **9MAX 求解器完整闭环**的交付记录：真实 9 人桌局面' +
      '（100BB / 枪口位开池 2.5BB / Hero=BB / A♠A♥ / 缓存键 `c7348fc89`）走通' +
      '「未命中 → 后台求解（181 秒、12 次迭代、gap 0.021030 < 目标 0.05）→ 准入 → 落盘 ' +
      '→ 再次读取 → **重启后读取**（`cacheSource=persistent`）→ 页面正确显示来源」。' +
      '它同时钉住两件事：① **「1225 组合」不是范围宽度**（= C(50,2) 全部组合；' +
      '真实等效宽度 94.1、加权 121.1），② 9MAX 的真实能力边界（**`addAllin=false` ⇒ ' +
      '求解器菜单只有 FOLD/RAISE 2.5**、开池模板只覆盖第一个行动位、VS_OPEN 被 ' +
      '`maxRaises=2` 挡死）。任何降低这三条约束的改动都会让本报告的结论失效。',
  },
  {
    path: 'reports/evidence/preflop-raise-sensitivity.txt',
    category: ManifestCategory.REPORT,
    impact:
      '**翻前加注模型的参数敏感度原始证据**变化 → 「换 margin / gate / 开池尺寸 / 筹码深度后' +
      '推荐尺寸是否移动」「换随机种子后建议是否翻转」这些实测数字发生变化；' +
      '由 `scripts/rr-sensitivity.ts` 生成（可复现）',
  },
]);

/** 被排除的文件及原因（清单无法包含自己的哈希） */
export const MANIFEST_EXCLUSIONS = Object.freeze([
  {
    path: 'data/artifact-manifest.json',
    reason: '清单无法包含自身的哈希（自指）。因此它由定义表 + 文件系统共同决定，无需自绑定',
  },
]);

/** 全项目清单文件路径（仓库相对） */
export const PROJECT_MANIFEST_PATH = 'data/artifact-manifest.json';
