/**
 * Decision Context Builder
 *
 * ## 这个模块在端到端链中解决什么
 *
 * 把「已校验的牌局状态 + 外部输入（对手画像 / 环境 / 动态观察）」
 * 组合成决策层需要的**完整上下文**。
 *
 * ## 职责边界（规范第 18 节）
 *
 * > **只组合数据。不做最终策略判断。**
 *
 * 因此本文件里没有任何 `if (equity > required) → CALL` 这类逻辑。
 * 它只负责：
 * 1. 算数学九项（**调用**既有 Poker Core，自己不重算）
 * 2. 建对手范围（**调用**既有 Range 引擎，自己不重算贝叶斯）
 * 3. 组装玩家 / 环境 / 动态快照
 * 4. 记录耗时与降级
 *
 * ## 对手范围的建模方式（**必须如实告知的近似**）
 *
 * 两条信息合起来决定对手范围：
 *
 * 1. **基础范围**：由「对手的第一个进攻动作 + 他是第几次加注 + 他的位置」选定
 *    - 第一个加注 = **开池** → 该位置的开池范围
 *    - 第二个及以上 = **3Bet/4Bet** → 再加注范围（紧得多）
 *    - 跟注 → 面对开池的继续范围
 * 2. **似然更新**：用 Range 引擎的贝叶斯更新，按「强牌更可能加注、
 *    弱牌更可能弃牌」这一**公开扑克常识**逐条修正
 *
 * ⚠️ 似然模型是**启发式**（见 `likelihoodModel.ts`），
 * 它只表达**单调倾向**，不声称精确频率。
 * 范围来源在 `RangeSnapshot.sourceKind` 里标为 `HEURISTIC`。
 *
 * ## 多人池（规范第 107 节）
 *
 * 若活跃对手 ≥ 2，本模块**仍会**构建范围快照（针对第一个对手），
 * 但 `DecisionContext.activeOpponentCount` 会如实为 2 或 3；
 * **是否拒绝给出建议由决策引擎决定**（≥3 时返回信息不足），
 * 而不是在这里偷偷只分析一个对手。
 */

import { Street, Position, ActionType, ALL_CARDS, type Card } from '../src/domain/types.ts';
import {
  computePot,
  requiredCallAmount,
  playerById,
  allBoardCards,
  realizedOpponentIds,
  yetToActIds,
  /** 🔴 U1 P0：本街已投入必须从状态读，不许用「单次下注」假设推 */
  committedThisStreet,
  type ActionRecord,
  type GameState,
  type PlayerState,
} from '../src/domain/poker/gameState.ts';
import { previewCommit } from '../src/domain/poker/pots.ts';
import { isUnopenedPot, applyAction } from '../src/domain/poker/engine.ts';
import { effectiveStackBetween } from '../src/domain/poker/odds.ts';
import { evaluateCards, type EvaluatedHand } from '../src/domain/poker/handEval.ts';
import { boardRelativeTierOf } from '../src/domain/poker/boardRelativeStrength.ts';
import { opponentRangeFactsOf } from '../src/app/manualInput/rangeFacts.ts';
import { describeHand } from '../src/domain/poker/handDescription.ts';
import { handDescriptionText } from '../src/i18n/index.ts';
import { computeEquity } from '../src/domain/poker/equity.ts';
import { EquityComputeMode } from '../src/domain/poker/equity.types.ts';
import { RangeState, toRangeAction, type Range } from '../src/domain/range/range.types.ts';
import { buildRangeFromRankClasses } from '../src/domain/range/range.ts';
import { updateRange } from '../src/domain/range/rangeUpdate.ts';
import { PlayerMetric } from '../src/domain/player/player.types.ts';
import {
  readPlayer,
  type PlayerRead,
  type ProfileAdjustment,
} from '../src/domain/player/playerClassifier.ts';
import { createProfile, PROFILE_VERSION } from '../src/domain/player/playerProfile.ts';
import { evaluateDynamicBehavior } from '../src/domain/dynamic/dynamicBehavior.ts';
import { adaptAdjustments } from '../src/domain/dynamic/dynamicAdapter.ts';
import { DYNAMIC_MODEL_VERSION, type UserHintKind } from '../src/domain/dynamic/dynamic.types.ts';
import { GameEnvironment, environmentProfile } from '../src/domain/range/gameEnvironment.ts';
import {
  environmentAdviceFor,
  resolveIndividualOverEnvironment,
  type EnvironmentAdviceResult,
} from '../src/domain/environment/environmentAccess.ts';
import {
  StrategyStreet,
  GameEnvironmentId as KnowledgeEnvironmentId,
  type StrategyKnowledge,
} from '../src/domain/knowledge/knowledge.types.ts';

import { deriveLegalActions, buildSizeGrid, closestSizeTo, type LegalActions } from '../src/app/manualInput/legalActions.ts';
import type { RangeSource } from '../src/domain/range/range.types.ts';
import type { RankClassWeights } from '../src/domain/range/range.ts';
import {
  PREFLOP_PRIOR_PROVENANCE,
  PREFLOP_PRIOR_NOTE,
  bigBlindCheckWeights,
  defendWeightsByHandedness,
  rfiWeightsByHandedness,
  threeBetWeightsByHandedness,
} from '../src/app/manualInput/preflopPriors.ts';
import {
  LIMPER_ARCHETYPE_ZH,
  LimperArchetype,
  effectiveTraits,
  isoRaiseEVOf,
  isoRaiseSizeOf,
  jointResponsesOf,
  limpArrivalRangeOf,
  limpResponseOf,
  limpResponseRangesOf,
  playersBehindRiskOf,
  quickProfileToLimperArchetype,
  type LimperInput,
  type PreflopIsoFacts,
} from '../src/app/manualInput/limpIsolation.ts';
import {
  betRatioOf,
  likelihoodWeights,
  normalizeLikelihood,
  tierOfRankClass,
  tierWeightOf,
} from '../src/app/manualInput/likelihoodModel.ts';
import {
  /*
   * 🔴 `BOARD_COUNT_BY_STREET` 必须**复用同一份定义**，不得在这里重写 0/3/4/5。
   *
   * 目前「各街应有几张公共牌」出现在三个地方：解析器（校验）、
   * 适配器（由张数推街道）、以及本模块的可见性护栏（校验）。
   * 三处各写一份数字，迟早有一天漂移，而漂移的表现形式是
   * 「解析器放行、护栏拒绝」或反向 —— 两者都极难诊断。
   *
   * 现在三处都指向 `manualInput.ts` 的这一个 `Object.freeze` 表。
   */
  BOARD_COUNT_BY_STREET,
  QUICK_PROFILE_CONFIDENCE,
  DYNAMIC_HINT_CONFIDENCE,
  STREET_ZH,
  type DynamicHint,
  type QuickProfile,
} from '../src/app/manualInput/manualInput.ts';
import {
  ALPHA_CONTEXT_VERSION,
  CONFIDENCE_BAND_ZH,
  DECISION_ACTION_ZH,
  confidenceBandOf,
  type DecisionContext,
  type DynamicSnapshot,
  type EnvironmentSnapshot,
  type EquitySource,
  type MathSnapshot,
  type PlayerSnapshot,
  type PostflopFacts,
  type ProfileRangeEvidence,
  type RangeSnapshot,
  type RangeUpdateTraceEntry,
} from '../src/domain/decision/decision.types.ts';
import { ACTION_ZH, POSITION_ZH } from '../src/app/manualInput/manualInput.ts';
import {
  buildResponseModel,
  classifyVillainAfterCheck,
  composeCheckEVTree,
  composeMultiwayBetEV,
  heroDrawPotentialOf,
  jointStatesOf,
  legalizeBetSizes,
  realizationFactorOf,
  responseTendenciesOf,
  JOINT_INDEPENDENCE_NOTE,
  JointModel,
  type BetDecisionFacts,
  type MultiwayBetEV,
  type MultiwayBetFacts,
  type OpponentResponseShares,
  type OpponentSizeResponse,
  type SizeResponseWithEquity,
  type SizeSaturationAudit,
} from '../src/domain/postflop/betResponse.ts';
import { boardTextureOf } from '../src/domain/postflop/boardDelta.ts';
import {
  ActionContext,
  actionContextOf,
  lastAggressorOfStreet,
  type ActionContextValue,
} from '../src/domain/postflop/actionContext.ts';
import { buildBettingRangeFacts } from '../src/app/manualInput/bettingRange.ts';
import { buildRaiseResponse, raiseEVOf, CASHFLOW_CONTRACT } from '../src/app/manualInput/raiseResponse.ts';
import {
  boardTextureLabelOf,
  riverComboClassOf,
} from '../src/domain/postflop/riverProfileClassify.ts';
import { drawProfileOf, outAuditOf } from '../src/domain/postflop/draws.ts';
import { madeHandClassOf } from '../src/domain/postflop/relativeHandRole.ts';
import { boardWetnessOf } from '../src/domain/postflop/rangeCompression.ts';
import { compareHands } from '../src/domain/poker/handEval.ts';
import {
  TENDENCY_TIER_ZH,
  archetypeDimensionsOf,
  resolveTendencyDimensions,
  TendencyEvidenceTier,
  type ResolvedTendencyDimensions,
} from '../src/domain/player/archetypeDimensions.ts';
import {
  createTendencyProvider,
  OBSERVATION_TILTS,
  type TendencyEvidence,
  type TendencyProvider,
} from '../src/domain/player/tendencyProvider.ts';
import {
  estimateUnifiedActionLikelihood,
  behaviorProfileOf,
  BetSizeBucketOf,
  type BehaviorNodeContext,
  type PlayerBehaviorProfile,
} from '../src/domain/player/behaviorProfile.ts';
/* 🔴 PLAYER PROFILE V3：标签 Prior + 实测连续统计 ⇒ 分街画像 */
import { resolvePlayerProfile, type PlayerObservedStats } from '../src/domain/player/observedStats.ts';

/* ============================================================
 * 常量
 * ============================================================ */

/**
 * 「模块未提供数据」时的**中性置信度**。
 *
 * ## 为什么不是 0
 *
 * `confidenceOf` 取各分量的**最小值**。若把「本手没有该对手的历史」
 * 记为 0，那么**每一次**在没有画像的牌局里，整体决策置信度都会是 0 ——
 * 而 `0` 在界面上意味着「这个建议完全不可信」，
 * 与「我们只是在玩家层没有数据」完全不是一回事。
 *
 * 混淆这两种情形会造成两个方向的错误：
 * - 假阴性：本来数学上很清楚的建议被标成不可信
 * - 掩盖：真正「数据不可信」的情形与「没数据」无法区分
 *
 * 取 0.5 表示「该维度不提供信息，也不构成缺陷」，
 * 并必须在诊断里如实说明「本手缺少该数据」。
 */
export const NO_DATA_NEUTRAL = 0.5;

/* ============================================================
 * 外部输入
 * ============================================================ */

export type ContextBuildInput = {
  state: GameState;
  /** 知识层规则（由调用方注入，本层零 I/O） */
  rules: readonly StrategyKnowledge[];
  /** 牌局环境（由用户选择） */
  environment: GameEnvironment;
  /** 已归一的决策时刻（Unix 毫秒） */
  asOf: number;
  /** 用户手选的对手快速画像（主观判断，可信度受限） */
  quickProfile?: QuickProfile;
  /**
   * 🔴 **逐座位的快速画像**（MULTIWAY RESPONSE TREE）。
   *
   * 多人下注 EV 要求每个对手**各自**的 fold/call/raise，而「他是谁」直接决定
   * 他爱不爱弃牌；只支持一个画像时，另一个座位只能当中立先验 —— 那是表达能力缺口。
   */
  seatProfiles?: Readonly<Partial<Record<Position, QuickProfile>>>;
  /**
   * 用户手选的动态观察提示。
   *
   * ⚠️ 类型是 `DynamicHint` 而**不是** `string`（红队 F-11）：
   * 写成 `string` 时，`mapDynamicHint` 只能靠 `default` 兜底，
   * 「界面上有、领域层没有」的取值会被静默吞掉。
   * 收紧成联合类型后，这个错误在编译期就无法通过。
   */
  dynamicHint?: DynamicHint;
  /** 对手的稳定 id（用于关联真实画像；未提供时用位置 id） */
  villainPlayerId?: string;
  /**
   * 该对手的**真实画像**（可选）。
   *
   * 有它时，个体数据优先于环境先验；
   * 没有时用「快速画像」兜底，且可信度被 `QUICK_PROFILE_CONFIDENCE` 上限截断。
   */
  villainProfile?: unknown;
  /**
   * 🔴 **行为画像**（PLAYER PROFILE QUANTIFICATION V1 · §十二）。
   *
   * ## 为什么它是**独立于** `quickProfile` 的一个字段
   *
   * `quickProfile` 是**标签**（「我觉得他是跟注站」），本模块只把它当作
   * 维度先验的来源。而 `PlayerBehaviorProfile` 是**逐条行为证据**
   * （每条带机会数与收缩后的生效比率），它才能回答
   * 「他在这个节点上下注的概率是多少」。
   *
   * ## 严格可选 —— 不传就逐位不变
   *
   * 不传 ⇒ `applyLikelihoodUpdates` 走既有档位似然路径，
   * **一个字节都不多算**（既有 1700+ 项测试依赖这个契约）。
   * 传了 ⇒ 只对**河牌进攻性动作**启用画像感知似然，
   * 并在同一条动作上抑制 `adjustmentProvider`（避免画像计两次）。
   */
  behaviorProfile?: PlayerBehaviorProfile;
  /**
   * 🔴 **PLAYER PROFILE V3**：该对手的**连续统计**（VPIP/PFR/FoldTo*CBet/…）。
   *
   * 语义三层（§四）：`quickProfile` 是**标签 Prior**，本字段是**实测证据**，
   * 两者由 `resolvePlayerProfile` 合并成 resolved profile —— 标签**不被覆盖**。
   *
   * 不传 / 全 `null` ⇒ 所有分街系数 = 1 ⇒ 与 V2 archetype-only **逐位一致**。
   */
  observedStats?: PlayerObservedStats | null;
  /**
   * 🔴 **下注范围构成注入点**（TEST 09 §二十：合成向量测试）。
   *
   * 给了就把它当作「无摊牌价值的牌下注的概率」，**不再**由画像推导，
   * 用于独立验证「给定范围构成 ⇒ 权益 ⇒ 动作」这条链路：
   *
   * ```text
   * 50% 无解价值 + 50% 纯诈唬  ⇒  抓诈牌权益 ≈ 50%  ⇒  面对 120% 池应 CALL
   * 80% 价值     + 20% 诈唬    ⇒  抓诈牌权益 ≈ 20%  ⇒  应 FOLD
   * ```
   *
   * ⚠️ 它**不是**模型参数，不进任何默认路径（缺省 `undefined` 时一切由画像推导）。
   * 只允许测试 / 审计脚本显式传入。
   */
  betRangeBluffShareOverride?: number | null;
  /** 蒙特卡洛种子（可复现） */
  equitySeed?: number;
  /**
   * 🔴 **求解器范围覆盖**（Phase 1.2）：按**对手 id** 索引。
   *
   * 由上层预取后注入 —— 见 `SolverRangeOverride` 的说明：
   * 本模块是同步纯函数、零 I/O，查求解器是异步网络动作，两者必须分开。
   *
   * 某一家不在这个映射里 ⇒ 那一家用启发式先验（并且 provenance 会如实说明）。
   */
  solverRanges?: Readonly<Record<string, SolverRangeOverride>>;
  /**
   * 时间预算（毫秒）。
   *
   * ⚠️ 分工（红队 F-13）：本模块**只负责如实记录**
   * —— 它把 `{softMs, hardMs, elapsedMs}` 写进 `context.deadlineBudget`，
   * 供诊断与界面显示。
   *
   * **执行**（软超时警告 / 硬超时中止）在 `alphaPipeline` 里，
   * 因为它需要覆盖整条链而不只是本模块。
   *
   * 这里刻意**不**据预算削减任何计算规模：那会让同一手牌在不同机器上
   * 得到不同结果，直接违反确定性纪律。预算只能决定「要不要继续算」，
   * 不能决定「算得多准」。
   */
  budget?: { softMs: number; hardMs: number };
  /**
   * 🔴 **进入本模块时，整条链已经花掉的毫秒数**（2026-09 修正轮）。
   *
   * 由 `alphaPipeline` 的 `DecisionDeadline` 提供。唯一用途是给
   * **可选**的分层权益计算做**失败安全**的预算保护：若剩余时间连
   * `LAYERED_BUDGET_RESERVE_MS` 都不够，就跳过它（回到保守的
   * 「不给方向 / 只用可证明的下界」），而不是硬算完再把整条分析
   * 拖成 `DEADLINE` 失败。
   *
   * ⚠️ 它**不**影响任何精度：跳过的只是「多算几层胜率」这项增强，
   * 而且跳过后的方向永远比硬算更保守（绝不会因此给出错误方向）。
   */
  budgetElapsedMs?: number;
};

export type ContextBuildResult = {
  context: DecisionContext;
  legal: LegalActions;
  warnings: readonly string[];
};

/* ============================================================
 * 小工具
 * ============================================================ */

function streetToKnowledge(street: Street): StrategyStreet {
  switch (street) {
    case Street.PREFLOP:
      return StrategyStreet.PREFLOP;
    case Street.FLOP:
      return StrategyStreet.FLOP;
    case Street.TURN:
      return StrategyStreet.TURN;
    default:
      return StrategyStreet.RIVER;
  }
}

/** 知识层的环境枚举与本项目环境枚举取值相同；此处显式转换并校验 */
function toKnowledgeEnvironment(environment: GameEnvironment): KnowledgeEnvironmentId {
  const known: readonly string[] = Object.values(KnowledgeEnvironmentId);
  if (!known.includes(environment)) {
    throw new Error(`buildDecisionContext: 未登记的环境「${String(environment)}」`);
  }
  return environment as KnowledgeEnvironmentId;
}

/** 当前应行动的玩家（Hero） */
function heroPlayer(state: GameState): PlayerState | null {
  if (state.userPlayerId === null) return null;
  return playerById(state, state.userPlayerId) ?? null;
}

/* ============================================================
 * 数学快照
 * ============================================================ */

function buildMathSnapshot(
  state: GameState,
  hero: PlayerState,
  opponentId: string | undefined,
  equity: { value: number | null; source: EquitySource | null },
  options: { layeredEV?: MathSnapshot['layeredEV'] } = {},
  /**
   * 🔴 **TEST 09 P0-1**：`Hero vs Villain **下注范围**` 的权益。
   *
   * 面对已下注节点时，`callEV` **必须**用它而不是 `equity.value`（到达范围）。
   * 详见 `bettingRange.ts` 的说明与调用点的注释。
   *
   * `null` / 未给 ⇒ 沿用到达范围权益（非面对下注节点、或多人口径），
   * 此时行为与修复前**逐位一致**。
   */
  heroEquityVsBetRange: number | null = null,
): MathSnapshot {
  const pot = computePot(state);
  const callCost = requiredCallAmount(state, hero.id);
  const effective = effectiveStackBetween(state, hero.id, opponentId);

  const effectiveStack = effective.ok ? effective.value.amount : hero.remainingStack;

  /*
   * 🔴 **可赢得总量 = 假设我跟注之后，我实际能争夺到的总量**（2026-09 边池轮）。
   *
   * ## 修复前错在哪
   *
   * 修复前直接用 `pot`（所有人投入之和）当「可赢得总量」。那在有人
   * **投入超过对手跟不起的上限**时是**虚高**的 —— 超出部分按规则退回，
   * 不在池子里等着被赢走。
   *
   * ## ⚠️ 这个式子我写错过两次，两次都值得记下来
   *
   * **第一次**：`contestedPot(state) + callCost`。
   * `contestedPot` 是**决策时刻**的口径，而「我还没跟」会让对手的整笔下注
   * 都显示为「未被跟注」：
   *
   * ```text
   * 我 100BB，UTG 全下 100BB，我还没行动
   *   contestedPot = 200   （只算了我已投的 1BB 与对手的 1BB）
   * ```
   *
   * 于是可赢量被算成 2BB 量级 —— 比正确值小了约 50 倍。
   *
   * **第二次**：`pot − 退回 + callCost`。
   * 它修好了上面那种情形，却在另一种情形下错：
   *
   * ```text
   * 我 200BB，UTG 只有 50BB 全下
   *   决策时刻退回 4900 —— 那是「我还没跟」造成的假象
   *   ⇒ 被当成永久退回，于是把 UTG 确实跟不到的 49BB 也算进了可赢量
   * ```
   *
   * ## 唯一同时正确的口径
   *
   * **先假设投入，再分层**（`winnableIfCommit`）。两种情形都对：
   *
   * | 情形 | 我跟注后仍退回 | 可争夺 |
   * |---|---|---|
   * | 我 100BB / 对手 100BB 全下 | 0 | 10100 |
   * | 我 200BB / 对手只有 50BB 全下 | 4900 | 1000 |
   *
   * ⚠️ 顺序不能反：先分层再补跟注，得到的是「决策时刻」的假象值。
   */
  const preview = previewCommit(state, hero.id, callCost);
  const winnable = preview.winnable;

  /*
   * 🔴 **「一个胜率门槛」只在「我只有一层」或「边池是暂时的」时成立**（2026-09 多人边池修复）。
   *
   * 我**有资格争夺的层 ≥ 2** 且某个层界被**已全下**的活人冻结时，我会
   * **输掉主池却赢下边池** —— 两笔钱的胜负条件不同，没有任何单一胜率能
   * 同时描述它们。这时 `requiredEquity` 仍然给数（界面要显示、指纹测试要比对），
   * 但决策层**不得**据此判定「负期望」。
   *
   * ⚠️「还有筹码、只是暂时投得少」的玩家造成的层**不算**（他一跟注就并回主池）。
   * 这条区分由 `pots.previewCommit.singleThresholdApplies` 判定 ——
   * 否则 `preflop-03-72o-vs-open`（BB 还没行动）会被误判成「判不了方向」，
   * 那正是 `test/alphaSmokeSpots.test.ts` 抓到的过度收紧。
   *
   * 实测反例：短码 9♥9♣ 暗三条全下 1000、大筹码 T♥J♥ 听牌全下 3000、
   * 我 A♥A♦ 需跟 2000（牌面 K♥9♠4♦2♣）⇒ 门槛 28.4%、我的权益 4.8%，
   * 但我 90.5% 赢边池 ⇒ 真实跟注 EV = **+1764**。
   * 修复前这里会输出「跟注在数学上是负期望」并且**不允许**策略层翻转。
   */
  const requiredEquityApplies = preview.singleThresholdApplies;

  /*
   * ⚠️ **SPR 刻意仍用「总投入」当分母**（与本函数其它量不同）。
   *
   * 这不是漏改，是口径选择，理由有三：
   *
   * | 理由 | 说明 |
   * |---|---|
   * | **它是标准定义** | SPR 的通行定义就是「有效筹码 ÷ **当前底池**」，而当前底池就是台面上的钱 |
   * | **它不参与决策** | 全项目只有 `decisionViewModel` 的诊断行与 CLI 显示读它 —— 改它不会改变任何建议 |
   * | **改了反而难解释** | 使用者按标准 SPR 心算，与界面不符会以为是 bug |
   *
   * 与之相对，`requiredEquity` / `callEV` **必须**用「可争夺量」——
   * 它们直接决定「跟不跟」，而拿一笔永远不会被跟注的筹码去算赔率是错的。
   */
  const spr = pot > 0 ? effectiveStack / pot : null;

  // 底池赔率：跟注成本 / 跟注后可争夺总量
  const potOdds = callCost > 0 && winnable > 0 ? callCost / winnable : 0;
  const requiredEquity = potOdds;

  /*
   * 🔴 **跟注 EV 的代数必须与 `winnable` 的口径一致**（2026-09 修复）。
   *
   * ## 修复前错在哪（这是我自己引入的缺陷，由独立审查抓到）
   *
   * 我把「可赢得总量」从 `pot`（不含本次跟注）换成了 `winnable`
   *（**含**本次跟注），却**没有同步改 EV 公式** ——
   * 于是 EV 被系统性地抬高了 `equity × callCost`。
   *
   * 两种口径的正确式子（`c` = 跟注额，`W` = 跟注后的总量，`E` = 权益）：
   *
   * | 口径 | 公式 |
   * |---|---|
   * | `reward = pot`（**不含**我的跟注） | `E × (W − c) − (1 − E) × c` |
   * | `reward = W`（**含**我的跟注） | `E × W − c` |
   *
   * 把第一式套到第二式的 `W` 上，等价于凭空多给 `E × c`。
   * 实测（深筹码常规局面）：快照 1236.34，正确 832.54，差 403.8 = `E × c`。
   *
   * ## 为什么必须用第二式（`E × W − c`）
   *
   * 因为它与底池赔率**同源**：`requiredEquity = c / W` 成立时
   * `E × W − c = 0` —— 也就是「权益正好等于所需权益时 EV 为零」。
   * 这条恒等式是 `odds.ts` 自己写明的定义，也是本项目
   * `finalMathSanityCheck`（「建议跟注但 EV 为负」）赖以成立的依据。
   * 写成第一式时那条安全网会**永远不触发**。
   *
   * ⚠️ 全项目此前**没有**任何测试锁住这条恒等式 —— 因此它能活到被审查发现。
   * 现在 `test/layeredPot.test.ts` 的 POT-12 专门锁它。
   */
  /*
   * ⚠️ `layeredEV` 还没算出来（它在 `buildDecisionContext` 里、本函数之后），
   * 因此这里先给**下界口径**的值；拿到分层 EV 后在下面的返回里**替换**。
   * 这样 `callEV` 与「判方向用的那个 EV」永远是同一个数 ——
   * 否则 `finalMathSanityCheck` 的「建议跟注但 EV 为负」会误报。
   */
  /*
   * 🔴 **TEST 09 P0-1：`callEV` 的权益输入对象**。
   *
   * - 面对 Villain 已下注、且算得出他的**下注范围** ⇒ 用 `heroEquityVsBetRange`；
   * - 其余情形 ⇒ 用到达范围权益（与修复前逐位一致）。
   *
   * ⚠️ 这两个量**不能共用同一个字段**：到达范围回答「他拥有什么」，
   * 下注范围回答「他选择下注的是什么」。前者用于「我领先他的整体范围吗」，
   * 后者用于「跟这一注划不划算」。混用会系统性高估 `CALL EV`。
   */
  const equityForCallEV = heroEquityVsBetRange ?? equity.value;
  const lowerBoundCallEV =
    equityForCallEV !== null && callCost > 0 ? equityForCallEV * winnable - callCost : null;

  const board = allBoardCards(state);
  const described =
    hero.holeCards !== null && hero.holeCards.length === 2 && board.length >= 3
      ? describeHand([hero.holeCards[0]!, hero.holeCards[1]!], board)
      : null;
  const evaluation: EvaluatedHand | null =
    hero.holeCards !== null && hero.holeCards.length === 2 && board.length >= 3
      ? evaluateCards([hero.holeCards[0]!, hero.holeCards[1]!, ...board])
      : null;

  // 翻牌前没有公共牌 → `describeHand` / `evaluateCards` 都不适用
  //（两者都要求 ≥5 张）。此时用**起手牌档位**描述，
  // 并明确标注它是起手牌评估而不是成手牌力。
  const preflopTier = board.length < 3 ? preflopStrengthOf(hero.holeCards) : null;

  /*
   * ⚠️ `layeredEV` 由调用方（`buildDecisionContext`）在算完基础权益后
   * 通过 `options.layeredEV` 注入 —— 因为它需要**逐层再算一次权益**，
   * 那是昂贵操作，必须与基础权益一样受 `mark()` 计时。
   */
  const layeredEV = options.layeredEV;

  /*
   * 🔴 `callEV` 与「判方向用的 EV」必须是**同一个数**。
   *
   * 多层且分层算得出来时用**精确分层 EV**；否则用下界口径的值。
   * 混用会让两个数字互相矛盾 —— 而 `finalMathSanityCheck` 正是读 `callEV`
   * 判「建议跟注但 EV 为负」，用错口径就会误报。
   */
  const callEV =
    layeredEV !== undefined && layeredEV.exact ? layeredEV.value : lowerBoundCallEV;

  return Object.freeze({
    street: state.street,
    pot,
    callCost,
    myRemainingStack: hero.remainingStack,
    effectiveStack,
    myCommittedThisStreet: hero.committedByStreet[state.street],
    spr,
    potOdds,
    requiredEquity,
    requiredEquityApplies,
    winnable,
    ...(layeredEV !== undefined ? { layeredEV } : {}),
    heroEquity: equity.value,
    equitySource: equity.source,
    /*
     * 🔴 **TEST 09 P0-1**：与 `heroEquity`（到达范围）**分开保存**（§八）。
     * `null` 表示「不是面对下注节点，或算不出下注范围」——不是 0。
     */
    heroEquityVsBetRange,
    callEV,
    handRankZh:
      described !== null
        ? handDescriptionText(described)
        : preflopTier !== null
          ? `起手牌：${preflopTier.labelZh}（翻牌前评估，非成手牌力）`
          : '未知',
    handCategory: described?.category ?? 0,
    bigBlind: state.config.bigBlind,
    rakeModel: 'NOT_APPLIED' as const,
  });
}

/**
 * 翻牌前起手牌档位。
 *
 * ## 为什么不是「牌力」
 *
 * 翻牌前没有公共牌，**没有成手牌力可言**。这里的档位只用于
 * 决定「是否值得主动下注取值」，而且**只区分大致强弱**：
 * 对子 / A 带大脚 / 两张高牌 / 同花连张 / 其他。
 *
 * ⚠️ 它**不是** Chens 公式或其他公开评分体系的复刻 ——
 * 那会引入一个没有在本项目验证过的外部算法。
 * 这里只做**类别判断**（是不是对子、有没有 A），
 * 因此不声称任何精确排名。
 */
function preflopStrengthOf(
  hole: readonly Card[] | null,
): { tier: 'PREMIUM' | 'STRONG' | 'PLAYABLE' | 'SPECULATIVE' | 'WEAK'; labelZh: string } | null {
  if (hole === null || hole.length !== 2) return null;
  const [a, b] = hole as [Card, Card];
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  const isPair = a.rank === b.rank;
  const isSuited = a.suit === b.suit;
  const gap = hi - lo;

  if (isPair) {
    if (hi >= 11) return { tier: 'PREMIUM', labelZh: '大对子' };
    if (hi >= 8) return { tier: 'STRONG', labelZh: '中对子' };
    if (hi >= 5) return { tier: 'PLAYABLE', labelZh: '小对子' };
    return { tier: 'SPECULATIVE', labelZh: '最小对子' };
  }
  if (hi === 14) {
    if (lo >= 12) return { tier: 'PREMIUM', labelZh: isSuited ? 'AK/AQ 同花' : 'AK/AQ' };
    if (lo >= 10) return { tier: 'STRONG', labelZh: 'A 带大脚' };
    if (isSuited) return { tier: 'PLAYABLE', labelZh: 'A 带小脚同花' };
    return { tier: 'WEAK', labelZh: 'A 带小脚' };
  }
  if (hi >= 12 && lo >= 10) {
    return { tier: 'STRONG', labelZh: isSuited ? '两张大牌同花' : '两张大牌' };
  }
  if (isSuited && gap <= 2 && lo >= 6) return { tier: 'PLAYABLE', labelZh: '同花连张' };
  if (isSuited && hi >= 11) return { tier: 'PLAYABLE', labelZh: '同花高张' };
  if (hi >= 13) return { tier: 'PLAYABLE', labelZh: '单张大牌' };
  return { tier: 'WEAK', labelZh: '弱起手牌' };
}

/* ============================================================
 * 对手范围
 * ============================================================ */

/**
 * 「某条街上**当时**看到的公共牌」= 最终牌面的前缀。
 *
 * 翻牌 3 张 / 转牌 4 张 / 河牌 5 张；翻前为空。
 *
 * ⚠️ 这是**单一事实来源**：范围似然（`applyLikelihoodUpdates`）与
 * 画像的「弱牌」判据（`TendencyProviderOptions.boardOfStreet`）都用它，
 * 两处各写一份 `slice(0,3/4/5)` 迟早漂移。
 */
function boardAtStreetOf(state: GameState, street: Street): readonly Card[] {
  const count = street === Street.FLOP ? 3 : street === Street.TURN ? 4 : street === Street.RIVER ? 5 : 0;
  return count === 0 ? [] : allBoardCards(state).slice(0, count);
}

/* ============================================================
 * 画像节点上下文（PLAYER PROFILE QUANTIFICATION V1 · §八/§十二）
 * ============================================================ */

/** 盲注 / 前注类投入：它们**不是**「进池决定」，不参与底池类型判定 */
const BLIND_ACTION_TYPES: readonly ActionType[] = [
  ActionType.POST_SB,
  ActionType.POST_BB,
  ActionType.POST_ANTE,
  ActionType.STRADDLE,
];

/** 进攻性动作（下注/加注/再加注/全下） */
function isAggressiveActionType(type: ActionType): boolean {
  return (
    type === ActionType.BET ||
    type === ActionType.RAISE ||
    type === ActionType.RERAISE ||
    type === ActionType.ALL_IN
  );
}

/**
 * 翻前底池类型 —— **由真实翻前行动推出**（不读 `state.street`，不看牌）。
 *
 * 【启发式】判据（结构性，不是估出的参数）：
 *
 * | 档 | 判据 |
 * |---|---|
 * | `THREE_BET` | 翻前进攻动作（RAISE/RERAISE/ALL_IN）≥ 2 次 |
 * | `LIMPED` | 有**跛入**（首次加注之前的 CALL），且进攻动作 ≤ 1 次 |
 * | `SRP` | 恰好 1 次进攻动作（单次加注底池） |
 * | `OTHER` | 其余（无人加注、无人跛入，例如全弃到盲注） |
 *
 * ⚠️ 已知上限：`THREE_BET` 不区分 3Bet/4Bet/5Bet；`LIMPED` 不区分单跛入与多跛入。
 * 升级路径：把 `BehaviorNodeContext.potType` 扩成更细的枚举，这里同步细化。
 */
function potTypeOf(state: GameState): BehaviorNodeContext['potType'] {
  const preflop = state.actions.filter(
    (a) => a.street === Street.PREFLOP && !BLIND_ACTION_TYPES.includes(a.type),
  );
  let raised = 0;
  let limped = false;
  for (const action of preflop) {
    if (isAggressiveActionType(action.type)) {
      raised += 1;
      continue;
    }
    // 「首次加注之前的跟注」= 跛入
    if (action.type === ActionType.CALL && raised === 0) limped = true;
  }
  if (raised >= 2) return 'THREE_BET';
  if (limped && raised <= 1) return 'LIMPED';
  if (raised === 1) return 'SRP';
  return 'OTHER';
}

/**
 * 前序街道线（§三十八 —— 这一项让「我 check-back 后他 probe」与
 * 「他跟注后他 donk」成为**不同**的节点）。
 *
 * **从 `state.actions` 推出，绝不读 `state.street`**：
 *
 * | 转牌发生了什么 | 判定 |
 * |---|---|
 * | 有下注/加注 **且** 有人跟注 | `TURN_BET_CALL` |
 * | 有下注/加注 但无人跟注 | `OTHER` |
 * | **没有任何**下注/加注，且有人过牌 | `TURN_CHECK_BACK` |
 * | 转牌没有任何记录 | `OTHER` |
 *
 * ⚠️ `TURN_CHECK_BACK` 判据是「无下注 + 有人过牌」而不是「我过牌」：
 * 一条无下注的转牌街上，行动者只能是过牌者，因此这两者在**行动记录完整**时等价；
 * 不额外要求「IP 身份」，因为位置由 `villainPosition` / `heroPosition` 单独表达。
 */
function previousStreetLineOf(state: GameState): BehaviorNodeContext['previousStreetLine'] {
  const turn = state.actions.filter(
    (a) => a.street === Street.TURN && !BLIND_ACTION_TYPES.includes(a.type),
  );
  const aggressive = turn.some((a) => isAggressiveActionType(a.type));
  if (aggressive) {
    return turn.some((a) => a.type === ActionType.CALL) ? 'TURN_BET_CALL' : 'OTHER';
  }
  return turn.some((a) => a.type === ActionType.CHECK) ? 'TURN_CHECK_BACK' : 'OTHER';
}

/**
 * 为**某一个进攻性河牌动作**构造画像节点上下文。
 *
 * ## 🔴 拿不到就返回 `null`，绝不编造
 *
 * 两个必需输入都可能拿不到：
 * - `boardTextureLabelOf(board)` 需要 ≥3 张公共牌；
 * - `betRatioOf(amount, potBefore)` 需要**正的**下注额与动作前底池。
 *
 * 任一缺失 ⇒ 返回 `null` ⇒ 调用方回落到既有档位似然（**逐位不变**）。
 * 用默认值顶上就是编造一个节点，那会让画像在这一手悄悄换个含义。
 */
function behaviorNodeOf(input: {
  state: GameState;
  opponent: PlayerState;
  hero: PlayerState | null;
  action: ActionRecord;
}): BehaviorNodeContext | null {
  if (input.hero === null) return null;
  const texture = boardTextureLabelOf(boardAtStreetOf(input.state, input.action.street));
  const ratio = betRatioOf(input.action.amount, input.action.potBefore);
  if (texture === null || ratio === undefined) return null;

  return Object.freeze({
    street: 'RIVER',
    heroPosition: input.hero.position,
    villainPosition: input.opponent.position,
    potType: potTypeOf(input.state),
    playerCount: input.state.players.filter((p) => !p.folded).length,
    previousStreetLine: previousStreetLineOf(input.state),
    /*
     * ⚠️ 按**真实动作类型**取，而不是一律写 'BET' ——
     * 把加注写成下注就是「编造一个不存在的节点」。
     * （`betLikelihoodOf` 当前不读这个字段，因此这一点不影响任何数值。）
     */
    currentAction:
      input.action.type === ActionType.RAISE || input.action.type === ActionType.RERAISE
        ? 'RAISE'
        : 'BET',
    sizeBucket: BetSizeBucketOf(ratio),
    boardTexture: texture,
  });
}

type RangeBuild = {
  snapshot: RangeSnapshot | null;
  range: Range | null;
  warnings: string[];
  /**
   * 🔴 **画像 / 近期倾向进入范围的证据**（P0 架构修复）。
   *
   * 它回答的是使用者点名的那一问：「画像到底有没有进入 action-conditioned
   * range 与 Hero equity 主链」。`applied === false` 表示范围**逐位不变**，
   * 而不是「看起来差不多」。
   */
  tendency?: RangeTendencyCore | null;
  /**
   * 🔴 **画像是否真的改变了这一家的范围**（V2.1 去重闸门修复）。
   *
   * 修复前决策层用的是 `tendency.provider.applied`，而上面的
   * `applied === false 表示范围逐位不变` 这句话**已经不成立**：
   * 河牌统一似然通道上 provider 被主动抑制（`suppressProvider`），
   * 跛入原型通道根本不经过 provider。两个反例都有实测
   * （`reports/V21_REVIEW_3_PIPELINE.md` 的 A/B 两个洞）。
   * 因此去重闸门必须读**这个**字段。
   */
  profileAppliedToRange?: boolean;
  /** 画像似然真正被施加的动作数（0 = 该通道未生效） */
  profileAppliedActions?: number;
  /**
   * 🔴 **RIVER BET RANGE V2**：`state.actions` 里「当前这一次下注」**之前**的范围
   * —— 也就是**真正的到达范围**。
   *
   * `range`（默认返回）在「他正在下注」的节点上已经包含这次下注的似然，
   * 因此它不能当作到达范围用（拿它再乘一次 `P(BET|手牌)` 就是重复计费）。
   * `null` = 没有捕获（不是「他在下注」的节点，或求解器范围路径下的退化情形）。
   */
  rangeBeforeAction?: Range | null;
};

/** 建范围阶段就能拿到的画像证据（权益部分由调用方补齐） */
type RangeTendencyCore = {
  /** provider 侧证据（乘数摘要、是否被夹、中文说明） */
  provider: TendencyEvidence;
  /** 维度来源（实测 / 手选原型 / 加权合并 / 无证据） */
  dimensionTier: string;
  dimensionTierZh: string;
  dimensionNoteZh: string;
  /** 调整前后可达组合数（**必须相等**：只改概率，不产生/删除组合） */
  combosBefore: number;
  combosAfter: number;
};

/**
 * 对手在**翻牌前**的第一个动作 —— 决定用哪一份**翻前先验**。
 *
 * ## 🔴 为什么必须限定翻前（2026-09 审计修复，CRITICAL）
 *
 * 修复前这个函数扫描**全部街道**，把「本手第一个进攻动作」一律当作
 * `action: 'RAISE'` 返回，`raiseOrdinal` 还跨街累加。于是：
 *
 * | 局面 | 修复前的后果 |
 * |---|---|
 * | 跛入池（翻前无人加注），**BB 在翻牌下注** | `rfiWeightsByHandedness('BB')` **抛错** ⇒ 整条分析 `CONTEXT_BUILD_FAILED` |
 * | 跛入池，**CO 在翻牌下注** | 静默套上「CO 的开池范围」（实测 1081 组合 = 全部牌型的 **81.5%**）—— 把翻牌下注者建模成翻前开池者 |
 * | 有人 3Bet 后 Hero 跟注，翻牌有人下注 | `raiseOrdinal` 把翻后加注也算进去，可能取到「3Bet 范围」档 |
 *
 * 翻前先验只回答一个问题：**他翻前是怎么进池的**。翻后的进攻性由
 * `applyLikelihoodUpdates` 逐街更新范围来表达（见该函数的说明）。
 *
 * ⚠️ `raiseOrdinal` 现在只数**翻前**的加注次数：
 * 1 = 开池（RFI），2 = 3Bet，3+ = 4Bet 及以上。
 */
function firstPreflopActionOf(
  state: GameState,
  opponentId: string,
): { action: 'RAISE' | 'CALL'; street: Street; raiseOrdinal: number } | null {
  let raiseCount = 0;
  for (const record of state.actions) {
    // 🔴 只看翻前：翻后的 BET / RAISE 与「先验档位」无关
    if (record.street !== Street.PREFLOP) continue;
    const isRaise = record.type === 'RAISE' || record.type === 'RERAISE';
    if (isRaise) raiseCount += 1;

    if (record.playerId !== opponentId) continue;
    if (isRaise || record.type === 'ALL_IN') {
      return { action: 'RAISE', street: record.street, raiseOrdinal: Math.max(1, raiseCount) };
    }
    if (record.type === 'CALL') {
      return { action: 'CALL', street: record.street, raiseOrdinal: 0 };
    }
  }
  return null;
}

/** 找出翻牌前第一个加注者（用于判断「面对谁的开池」） */
function openerPositionOf(state: GameState, excludeId: string): PlayerState['position'] | null {
  for (const record of state.actions) {
    if (record.street !== Street.PREFLOP) continue;
    if (record.playerId === excludeId) continue;
    if (record.type === 'RAISE' || record.type === 'RERAISE') {
      const p = playerById(state, record.playerId);
      if (p) return p.position;
    }
  }
  return null;
}

/**
 * 由对手的进攻性动作选定基础范围。
 *
 * ## 🔴 选档用的是**本手人数**，不是座位容量（Table Topology Correction）
 *
 * 修复前这里传的是 `state.config.tableSize`（**容量**）。9 座桌坐 8 人时，
 * 对手的 UTG 会拿到 9 人桌 UTG 的档位；更糟的是 2/3/4/5/7 人时，
 * `rfiTierOf` 的二分会让所有人落进「6 人桌」档 ——
 * 8 人桌 UTG 被当成 6 人桌 UTG（**范围偏松**），
 * 而 3 人桌的 BTN 被当成 6 人桌 BTN（**范围偏紧**）。
 *
 * 现在改用 `*ByHandedness` 系列：位置名本身编码了「离 Button 多远」，
 * 而位置名由 `canonicalRolesOf(本手人数)` 分配，因此档位自动跟着人数走。
 */
function buildBaseRange(
  state: GameState,
  opponent: PlayerState,
  aggression: { action: 'RAISE' | 'CALL'; street: Street; raiseOrdinal: number } | null,
  deadCards: readonly Card[],
  /** 求解器给的范围权重（若这一家有可用的 GTO 数据）；见 `SolverRangeOverride` */
  solverOverride?: SolverRangeOverride,
  /**
   * 这一家的**跛入原型**（多人 limp 修复，§4）。
   *
   * 🔴 修复前「无人加注的被动进入」一律用 `bigBlindCheckWeights()` ——
   * 那是**任意两张**（1225 组合），于是「跛入者范围」根本不含任何信息：
   * 画像、位置、类型全都进不去，Hero 权益也就永远是一个数。
   * 现在改成按原型收窄的 limp 到达范围（`limpArrivalRangeOf`）。
   */
  limpProfile?: { archetype: LimperArchetype; confidence: number } | null,
): { ok: true; range: Range } | { ok: false; reason: string } {
  let weights: RankClassWeights;
  let label: string;

  /*
   * 🔴 **求解器版本优先**（Phase 1.2）。
   *
   * 有 GTO 数据时，范围是**算出来的**而不是猜的。此时：
   *
   * - `weights` 直接取求解器频率，按**牌名**对齐 —— 见 `solverRangePrior.ts`
   *   的纪律 2：项目里两套 169 类顺序只有 5/169 相同，按序号对接会静默把
   *   164 个牌型的频率灌到别的牌上（长度对得上、类型对得上、没有报错）；
   * - `provenance` 换成求解器来源（可信度提高，但仍受「翻前是近似模型」
   *   这个天花板约束，**不会**变成「已验证」）；
   * - **不再施加似然更新**（见 `buildRangeSnapshot` 的 `skipLikelihoodUpdates`）。
   */
  if (solverOverride !== undefined) {
    weights = solverOverride.weights;
    label = solverOverride.labelZh;
  } else if (aggression === null) {
    // 对手只是跟盲注进入（例如大盲位、或翻牌前无人加注而大家都过牌）
    weights = bigBlindCheckWeights();
    label = '无人加注时的宽范围（对手被动进入，范围极宽）';
  } else if (aggression.action === 'RAISE') {
    // ⚠️ 区分「开池」与「再加注」（红队 F-03）
    //
    // 第一个加注 = 开池 → 开池范围
    // 第二个及以上加注 = 3Bet/4Bet → 再加注范围（**紧得多**）
    if (aggression.raiseOrdinal >= 2) {
      const opener = openerPositionOf(state, opponent.id);
      weights =
        opener !== null && opener !== opponent.position
          ? threeBetWeightsByHandedness(opponent.position, opener)
          : threeBetWeightsByHandedness(opponent.position, Position.UTG);
      label =
        `再加注（3Bet+）范围：${POSITION_ZH[opponent.position]} 对 ` +
        `${opener !== null ? POSITION_ZH[opener] : '前位'} 开池的启发式 3Bet 范围` +
        '（QQ+/AK 为主 + 少量诈唬）';
    } else {
      weights = rfiWeightsByHandedness(opponent.position);
      label =
        `${POSITION_ZH[opponent.position]}的启发式开池范围（对手主动加注，` +
        `按本手 ${state.players.length} 人取档）`;
    }
  } else {
    // 主动跟注（未加注）
    const opener = openerPositionOf(state, opponent.id);
    if (opener !== null && opener !== opponent.position) {
      weights = defendWeightsByHandedness(opener, opponent.position);
      label = `面对${POSITION_ZH[opener]}开池的启发式继续范围（对手选择跟注）`;
    } else if (limpProfile === null || limpProfile === undefined) {
      weights = bigBlindCheckWeights();
      label = '无人加注时的宽范围';
    } else {
      // 🔴 跛入：按原型收窄（不再是任意两张）
      const arrival = limpArrivalRangeOf({
        position: opponent.position,
        archetype: limpProfile.archetype,
        confidence: limpProfile.confidence,
      });
      weights = arrival.weights;
      label =
        `跛入到达范围：${LIMPER_ARCHETYPE_ZH[limpProfile.archetype]}` +
        `${limpProfile.confidence > 0 ? '（画像）' : '（无画像 ⇒ 人群先验）'}，` +
        `有效宽度 ${arrival.width.toFixed(2)}（**不是**任意两张）`;
    }
  }

  const built = buildRangeFromRankClasses(weights, {
    provenance:
      solverOverride !== undefined
        ? /*
           * 🔴 求解器来源的 provenance。
           *
           * ⚠️ 可信度**不是 1**：GTOpen 的翻前是**近似延续模型**（源码自述），
           * 求解器自己的 gap 收敛也只是那个近似模型内部的均衡。
           * 因此这里给的是「比启发式高、但远不到已验证」的一档，
           * 且 `verified` 恒为 `false`。
           *
           * `sourceType` 用 `EMPIRICAL` 而不是 `THEORY_SOURCE`：
           * 后者在本项目的登记表里要求「有可信 solver 输出或权威公开数据集支撑」，
           * 而我们用的是**近似模型**的求解输出 —— 说成理论来源会抬高它的地位。
           */
          {
            sourceId: `solver.preflop-range.${solverOverride.engineCommit ?? 'unknown'}`,
            sourceType: 'EMPIRICAL' as RangeSource,
            version: '1.0.0',
            description:
              `${solverOverride.labelZh}。求解器 ${solverOverride.engineCommit ?? '未知版本'}，` +
              `取用动作 [${solverOverride.usedActions.join('/')}]，` +
              `迭代 ${solverOverride.iterationsCompleted ?? '未报告'}` +
              `${solverOverride.reportedGap === null ? '' : `，gap ${solverOverride.reportedGap}`}。` +
              '⚠️ 翻前是**近似延续模型**，因此这不是完整 GTO，也**不是**已验证数据。',
            verified: false,
            confidence: SOLVER_RANGE_CONFIDENCE,
          }
        : {
            ...PREFLOP_PRIOR_PROVENANCE,
            description: `${PREFLOP_PRIOR_PROVENANCE.description}（${label}）`,
          },
    deadCards,
    rangeIdPrefix: 'alpha',
  });

  if (!built.ok) {
    return { ok: false, reason: `范围构建失败：${built.code}` };
  }
  return { ok: true, range: built.value };
}

/* ============================================================
 * 求解器范围覆盖（Phase 1.2）
 * ============================================================ */

/**
 * 求解器给出的范围可信度。
 *
 * 🔴 **不是 1，也不是 0.9。** 依据：
 *
 * - GTOpen 的翻前用的是**近似延续模型**（源码自述：modeled continuation
 *   payoffs, not a full postflop game），求解器自述的 gap 收敛只是那个
 *   近似模型内部的均衡；
 * - 9 人桌只迭代 12 次、8 人桌 20 次 —— 迭代数本身就不高；
 * - 169 类机会模型忽略**联合去牌效应**。
 *
 * 因此它明显高于启发式先验的 0.3，但**远不到**「已验证」。
 * 这个数字是判断，不是测量 —— 所以它写成一个具名常量并在这里说明依据，
 * 而不是散在代码里。
 */
export const SOLVER_RANGE_CONFIDENCE = 0.55;

/**
 * 某一家对手的**求解器范围权重**（按需注入）。
 *
 * ## 🔴 为什么是「注入」而不是让 `contextBuilder` 自己去查
 *
 * `contextBuilder` 是**同步纯函数、零 I/O**（这是领域层的既有纪律，
 * 也是它可测、可重放的原因）。而查 GTOpen 是**异步 + 网络**。
 *
 * 因此由上层（`alphaPipeline`）**先预取**，再把结果作为数据传进来。
 * 这里只负责「有就用、没有就回落」，不负责去拿。
 */
export type SolverRangeOverride = {
  /** 169 类权重，**按牌名**索引（不是按序号） */
  weights: RankClassWeights;
  /** 中文说明，会进 provenance.description */
  labelZh: string;
  engineCommit: string | null;
  usedActions: readonly string[];
  reportedGap: number | null;
  iterationsCompleted: number | null;
};

/**
 * 用行动历史逐条做贝叶斯更新。
 *
 * ## 为什么用「异常行动」而不是「全部行动」
 *
 * 基础范围已经编码了「他会用什么牌加注/跟注」。
 * 如果再对**同一条**加注动作施加一次似然，等于**重复计票**：
 * 范围会被收缩两次，最终窄到不真实。
 *
 * 因此似然只施加在**偏离其基础范围所选动作**的行动上。
 * 这是对「范围引擎 + 启发式先验」这套组合的**近似处理**，
 * 在 `updateTrace` 里逐条可见。
 */
function applyLikelihoodUpdates(
  range: Range,
  state: GameState,
  opponent: PlayerState,
  baseAggression: { action: 'RAISE' | 'CALL'; street: Street; raiseOrdinal: number } | null,
  /**
   * 🔴 **画像 / 近期倾向的调整提供者**（P0 架构修复 · 规范第二十节）。
   *
   * 修复前这里是空的：`updateRange` 有完整的 `adjustmentProvider` 通道
   * （对数域乘法 + 逐条日志，规范第二十节要求的唯一合法入口），
   * 但**生产路径从未传入** ⇒ 画像永远到不了范围，只能在决策末端当偏好修正。
   *
   * 传入后：`posterior ∝ prior × likelihood × profileFactor × observationFactor`，
   * 因此**权益、底池赔率比较、Call EV、动作排名全部自动跟着变** ——
   * 不需要在决策层再加任何画像逻辑（那才会变成两处口径）。
   */
  provider?: TendencyProvider,
  /**
   * 🔴 **行为画像**（PLAYER PROFILE QUANTIFICATION V1 · §十二/§十三）。
   *
   * 严格可选：**没传就与改动前逐位一致**（这是既有测试依赖的契约）。
   *
   * 传了之后，**只对河牌的进攻性动作**改变似然来源：
   * `likelihood = normalizeLikelihood(betLikelihoodOf(comboClass, node, profile))`，
   * 并在同一条动作上**抑制** `provider`（见下方注释：避免画像被计两次）。
   * 其余动作（翻前/翻牌/转牌、跟注、过牌）**完全不变**。
   */
  behaviorProfile?: PlayerBehaviorProfile,
  /**
   * 🔴 **RIVER BET RANGE V2 —— 捕获「当前正在被建模的那一次动作」之前的范围**。
   *
   * ## 为什么需要它（重复计费）
   *
   * 本函数把**每一个**进攻动作当似然乘进范围 —— 包括**当前这一次下注**。
   * 于是函数返回的范围已经是 `P(手牌 | 他已经下注)`。
   * 而 `bettingRange.ts` 的下注范围又要乘一次 `P(BET | 手牌)` ⇒ 似然被**平方**。
   *
   * 传了本参数（= `state.actions` 里那一条记录的**下标**）后，
   * 函数会在处理到它之前把当时的状态**原样捕获**下来（引用赋值，零额外计算），
   * 作为 `rangeBeforeAction` 返回 —— 那就是**真正的到达范围**：
   *
   * ```text
   * 到达范围      = 本链在「当前下注」这一步之前的状态
   * 下注范围      = 到达范围 × P(BET | 公共强度带)      ← 当前下注只在这里计一次
   * 范围(默认返回) = 到达范围 × P(当前下注 | 手牌)        ← 原有语义，逐位不变
   * ```
   *
   * ⚠️ **它只跳过一条记录**，不是「关闭全部历史行动过滤」：
   * 翻牌跟注、转牌跟注、以及更早的进攻动作**照旧施加似然**。
   */
  captureBeforeActionIndex?: number,
): {
  range: Range;
  trace: RangeUpdateTraceEntry[];
  providerCalls: number;
  profileLikelihoodActions: number;
  /** 见 `captureBeforeActionIndex`；未捕获时为 `null` */
  rangeBeforeAction: Range | null;
} {
  let current = range;
  let rangeBeforeAction: Range | null = null;
  const trace: RangeUpdateTraceEntry[] = [];
  let providerCalls = 0;
  /**
   * 🔴 **统一动作似然真的被施加了几次**（V2.1 去重闸门修复）。
   *
   * 去重闸门原先只看 `provider.applied`，而 V2 起**河牌进攻动作上的 provider
   * 是被抑制的**（`suppressProvider`）⇒ 画像明明改了范围，`provider.applied`
   * 却是 `false` ⇒ 决策层把同一份证据**再计一次**。
   * 计数在这里最可靠：它就是「画像似然被真正乘进范围」的次数。
   */
  let profileLikelihoodActions = 0;

  /*
   * 河牌画像路径要用 Hero 底牌来判「谁比谁强」。
   * 拿不到 ⇒ 整条画像路径不启用（`behaviorNodeOf` 会返回 null）。
   */
  const heroPlayer =
    (state.userPlayerId === null
      ? undefined
      : state.players.find((p) => p.id === state.userPlayerId)) ??
    state.players.find((p) => p.holeCards !== null) ??
    null;
  const heroHole: readonly Card[] = heroPlayer?.holeCards ?? [];

  let actionIndex = 0;
  let skippedBaseAction = false;
  for (const [recordIndex, record] of state.actions.entries()) {
    /*
     * 🔴 到达范围的捕获点：**在这一条动作被施加似然之前**。
     * 位置刻意放在最前面 —— 无论下面走哪条分支（基础动作跳过 / 似然回落 / 正常施加），
     * 捕获到的都是「这条动作发生之前」的那份范围。
     */
    if (captureBeforeActionIndex !== undefined && recordIndex === captureBeforeActionIndex) {
      rangeBeforeAction = current;
    }
    if (record.playerId !== opponent.id) continue;
    const rangeAction = toRangeAction(record.type);
    if (rangeAction === null || rangeAction === 'FOLD') continue;

    const isAggressive =
      rangeAction === 'BET' || rangeAction === 'RAISE' || rangeAction === 'ALL_IN';
    const isPassive = rangeAction === 'CHECK' || rangeAction === 'CALL';

    // 跳过「基础范围已经表达过的那一条」（只跳第一次）
    const isBaseAction =
      baseAggression !== null &&
      record.street === baseAggression.street &&
      ((baseAggression.action === 'RAISE' && isAggressive) ||
        (baseAggression.action === 'CALL' && isPassive));
    if (!skippedBaseAction && isBaseAction) {
      skippedBaseAction = true;
      continue;
    }

    actionIndex += 1;
    // ⚠️ 似然必须**看下注量**：注越大 → 范围越偏强牌。
    //
    // 修复前似然是常数，实测后果：河牌持一对 K 面对 **3 倍超池下注**时
    // 算出 **90.2% 权益**并建议加注到 40BB。任何真实对手的 3 倍超池
    // 都不是「一半诈唬」的范围。
    //
    // 🔴 **跟注与过牌必须分开**（2026-09 审计修复，C2）：
    // 修复前两者共用 `normalLikelihood`，而它的放大器只在 `bet/pot > 0.5`
    // 时生效 ⇒ 正常跟注（≤0.5 池）与过牌**逐位相同**。实测后果是
    // 「连跟两街」的对手在河牌的范围≈翻前先验（顶级牌质量 7.5% vs 8.1%）。
    const betRatio = betRatioOf(record.amount, record.potBefore);
    const weights = likelihoodWeights(
      isAggressive ? 'AGGRESSIVE' : rangeAction === 'CALL' ? 'CALL' : 'CHECK',
      betRatio,
    );

    /*
     * 🔴 **翻后用「牌面相对强度」索引似然，不是翻前牌型档**（C3）。
     *
     * 该行动**当时**的公共牌 = 最终牌面的前缀（翻牌 3 张 / 转牌 4 张 / 河牌 5 张）。
     * 于是「同花完成后」同花组合的形态真的变成同花 ⇒ 档位提升 ⇒ 权重上升，
     * 范围里 ♣♣ 的质量随之变大（修复前它与花色完全无关）。
     *
     * ⚠️ 牌面不足 3 张（翻前）时 `boardRelativeTierOf` 返回 null，
     * 此处回落到 `tierOfRankClass` —— **翻前行为逐位不变**。
     */
    const boardAtAction = boardAtStreetOf(state, record.street);
    const tierOfEntry = (combo: { rankClass: string; cardIndices: readonly [number, number] }): number => {
      if (boardAtAction.length >= 3) {
        const relative = boardRelativeTierOf(
          [ALL_CARDS[combo.cardIndices[0]]!, ALL_CARDS[combo.cardIndices[1]]!],
          boardAtAction,
        );
        if (relative !== null) return relative;
      }
      return tierOfRankClass(combo.rankClass);
    };

    /*
     * 🔴 **河牌画像似然**（PLAYER PROFILE QUANTIFICATION V1 · §十二/§十三）。
     *
     * ## 为什么要单独一条路径（而不是继续走倾斜通道）
     *
     * 倾斜通道（`TendencyProvider`，见其文件头）对**同一个**进攻性画像
     * 会同时抬高「价值端」与「空气端」——`valueTilt` 与 `bluffTilt` 都被 raise。
     * 两端增益互相抵消，实测 MANIAC 的空气/价值比（×1.118 / ×1.086）
     * 反而**低于** BLUFF_HEAVY（×1.103 / ×1.056）：
     * 在诈唬倾向上是**非单调**的。这正是
     * `PLAYER_PROFILE_RANGE_INFLUENCE_TOO_WEAK` 的结构性根因。
     *
     * `betLikelihoodOf` 从构造上消除了它：价值类别
     * （`NUT_VALUE` / `STRONG_VALUE` / `MEDIUM_VALUE`）**不乘任何画像条目**，
     * 只有薄价值、错过听牌、纯空气与「我 check-back 后他开火」带乘数。
     * 于是画像只推动**诈唬/薄价值那一端** ⇒ 对诈唬倾向**严格单调**。
     *
     * ## 纪律
     *
     * - 只对**河牌 + 进攻性动作**生效；其余动作逐位不变。
     * - 节点上下文或 Hero 底牌拿不到 ⇒ **不启用**（回落档位似然），不猜。
     * - 只要有一个组合**无法如实分类** ⇒ 整条动作**不启用**：
     *   混用两种量纲的似然会让 `normalizeLikelihood`（max 归一化）失去意义。
     *   原因写进 `updateTrace.noteZh`，因此它是**可见的**而不是静默降级。
     * - 似然经 `normalizeLikelihood` 落到 `(0, 0.95]` ——
     *   范围引擎要求 `likelihood ∈ [0,1]`，越界会让整个动作模型被
     *   `validateActionModel` 拒绝并**静默失效**（见 `likelihoodModel` 的警告）。
     */
    let likelihoodOverride: readonly number[] | null = null;
    let profileNoteZh: string | null = null;

    /*
     * 🔴 **V2 §四十五：单一生产入口 —— 闸门已移除。**
     *
     * 这里此前有一道 `behaviorProfile.archetypePriorAvailable` 闸门，
     * 让中性标签走「既有档位似然」、有先验原型走类别模型 —— 也就是
     * **两个生产入口**。当时保留它的理由是「防止中性标签静默重标定」，
     * 而那正是 V1「替换」式的缺陷。
     *
     * V2 的中性校准层从构造上解决了这一点：统一似然的第一段**就是**
     * 既有档位权重，画像只在上面施加**几率比**条件化，而中性画像的
     * 每个条件化因子**恰为 `1.0`** ⇒ 结果与旧实现**逐位相同**。
     *
     * 这一点已实测：`NEUTRAL_PARITY` 在
     * River 25% / 75% / 125% × 8 类别 × 2 前序线 = **48 个网格单元上
     * 最大绝对差为 0**（逐位相等，无需任何容差）。
     *
     * 既然闸门在数值上是**恒等变换**，就没有理由再保留第二条路径
     * （§四十五 禁止长期并存两个生产入口）。现在**所有**河牌进攻性动作
     * 都走 `estimateUnifiedActionLikelihood`：
     * - 有画像 ⇒ 用该画像；
     * - 没有画像（`UNKNOWN`）⇒ 用**中性画像**（等价于池先验），
     *   结果与既有档位似然逐位一致。
     *
     * 唯一剩余的回落是 `node === null`（牌面不足 3 张 / 拿不到下注比例）——
     * 那是**拿不到输入**的 fail-closed，不是第二个模型。
     */
    if (record.street === Street.RIVER && isAggressive) {
      /** 没有画像时用**中性画像**（池先验）—— 等价于既有档位似然，逐位一致 */
      const effectiveProfile =
        behaviorProfile ?? behaviorProfileOf({ playerId: 'neutral', archetype: null });
      const node = behaviorNodeOf({ state, opponent, hero: heroPlayer, action: record });
      if (node === null || heroHole.length !== 2) {
        profileNoteZh = '统一似然未启用：节点上下文（牌面纹理/下注量）或 Hero 底牌不足 ⇒ 回落档位似然';
      } else {
        const holes = current.entries.map(
          (entry) =>
            [ALL_CARDS[entry.combo.cardIndices[0]]!, ALL_CARDS[entry.combo.cardIndices[1]]!] as const,
        );
        const classes = holes.map((hole) =>
          riverComboClassOf({ hole, board: boardAtAction, heroHole }),
        );
        const unclassified = classes.reduce((n, c) => (c === null ? n + 1 : n), 0);
        if (unclassified > 0) {
          profileNoteZh =
            `画像似然未启用：${unclassified}/${classes.length} 个组合无法如实分类` +
            '（牌力比较失败或与 Hero/公共牌重叠）⇒ 整条动作回落档位似然';
        } else {
          /*
           * 🔴 **画像是「调制」，不是「替换」**（本轮修正 · 本阶段的核心量纲缺陷）。
           *
           * 修复前这里用 `normalizeLikelihood(betLikelihoodOf(...))` **替换**了
           * 档位似然。后果是：一个原型一旦进入类别模型，它的范围就与仍走档位似然的
           * 中性原型**不同尺**。隔离实测：
           *
           * ```text
           * VERY_TIGHT 31.962%（类别模型） vs NORMAL 17.495%（档位模型）
           * ⇒ 「越紧的对手给 Hero 越高权益」—— 量纲伪影，不是语义
           * ```
           *
           * 于是任何「A 类 < 中性 < C 类」的排序断言都变成**跨模型比较**（两把尺子），
           * 在数学上不可能成立 —— T1 / T2 / T13 / TEST 6 四项红灯全部源于此。
           *
           * 规范 §十二 要求的是「画像**只修改**动作似然」。因此取**相对中性画像的
           * 似然比**，乘到既有档位似然上：
           *
           * ```text
           * likelihood(combo) = 档位似然(tier) × [ P_画像(class) / P_中性(class) ]
           * ```
           *
           * 性质：
           * - **中性画像 ⇒ 比值恒为 1.000** ⇒ 与既有模型逐位一致（闸门因此可保留，
           *   `UNKNOWN == NORMAL` 继续成立）；
           * - 有先验原型 ⇒ 只把诈唬 / 薄价值那一端按条目比率缩放，**与基准同尺** ⇒
           *   跨原型的比较重新变成**单模型比较**，排序断言恢复意义；
           * - **不再需要 `normalizeLikelihood`**：比值无上界，但乘回档位似然后钳到
           *   `[0,1]` 即满足范围引擎契约（越界会让整个动作模型被
           *   `validateActionModel` **静默**拒绝 —— 见 `likelihoodModel` 的警告）。
           */
          /*
           * 🔴 **V2：走统一动作似然（`estimateUnifiedActionLikelihood`）。**
           *
           * 这里此前是「档位似然 × 相对中性画像的似然比」—— V1 的**调制**式。
           * 它保住了同尺（好），但动态范围只有 ≈1.75×，实测
           * `PROFILE_RANGE_INFLUENCE = TRIVIAL`（权益仅动 0.79pp）。
           *
           * 现在**类别与档位由 `riverComboClassOf` 一次给出**（同一来源，
           * 调用方不再二次推导档位 —— 那会形成第二把尺子），交给统一似然：
           *
           * ```text
           * likelihood = 中性校准层(既有档位权重) × 几何平均(已施加的几率比)
           * ```
           *
           * - **中性画像**：每个几率比恰为 `1.0` ⇒ 几何平均 `1.0` ⇒
           *   `likelihood` **逐位等于**既有档位权重 ⇒ NEUTRAL_PARITY 由构造保证；
           * - **有先验原型**：几率比把 `0.10 → 0.55` 这类差异放大到 ≈11× 动态范围，
           *   而**多条目按几何平均合并**，避免把「爱开火」这同一条倾向**数三次**
           *   （乘积实测会放大 417× 并撞上钳位 ⇒ 类别区分被压平）。
           */
          /*
           * 🔴 热路径：档位权重**每个动作只算一次**并注入 —— 否则统一似然会在
           * Θ(449) 个组合上各自 `normalizeLikelihood` 一遍（449 次 6 元数组分配），
           * 实测会把「热路径预算」性能测试压红。
           */
          const riverBaseWeights = likelihoodWeights('AGGRESSIVE', betRatio);
          const unified = classes.map((cls) =>
            estimateUnifiedActionLikelihood({
              semanticClass: cls!.category,
              strengthBucket: cls!.strengthBucket,
              ...(betRatio === undefined ? {} : { betRatio }),
              baseWeights: riverBaseWeights,
              node,
              profile: effectiveProfile,
              action: rangeAction === 'RAISE' || rangeAction === 'ALL_IN' ? 'RAISE' : 'BET',
            }),
          );
          likelihoodOverride = Object.freeze(unified.map((u) => u.likelihood));
          /*
           * 钳位必须**可见**（父代理要求）：若任何组合被钳到 1，说明
           * `MISSED_DRAW` 与 `NUT_VALUE` 被压平成同一个值，类别区分已经失效。
           * 把它写进 `updateTrace`，不允许静默吸收。
           */
          const clampedCount = unified.reduce((n, u) => n + (u.clamped ? 1 : 0), 0);
          const counts = unified.map((u) => u.appliedTraitCount);
          profileNoteZh =
            `统一动作似然 V2（中性校准层 × 几何平均画像调整；同一条动作上抑制 adjustmentProvider）：` +
            `${node.street}/${node.villainPosition}/${node.potType}/${node.previousStreetLine}/` +
            `${node.sizeBucket}/${node.boardTexture}；条目数 ${Math.min(...counts)}–${Math.max(...counts)}；` +
            `钳位 ${clampedCount}/${unified.length}` +
            (clampedCount > 0 ? '（**饱和：类别区分被压平！**）' : '（无饱和）');
        }
      }
    }
    const suppressProvider = likelihoodOverride !== null;
    if (likelihoodOverride !== null) profileLikelihoodActions += 1;

    const result = updateRange(
      current,
      {
        likelihoods: Object.freeze(
          current.entries.map((entry, entryIndex) => ({
            comboId: entry.combo.canonicalId,
            action: rangeAction,
            likelihood:
              likelihoodOverride === null
                ? tierWeightOf(weights, tierOfEntry(entry.combo))
                : likelihoodOverride[entryIndex]!,
            source: range.provenance.sourceType,
            confidence: range.provenance.confidence,
          })),
        ),
        complete: false,
        completenessNote: 'PARTIAL_ACTION_MODEL：启发式似然，只表达单调倾向，不是完整策略',
        provenance: range.provenance,
      },
      {
        // 用**该行动自己的街道**，不是 `state.street`（当前街）。
        //
        // 实测缺陷：一律用当前街道，于是「翻牌圈更新一个翻牌前的范围」
        // 被 `validateActionModel` 以 `RANGE_VALIDATION_FAILED` 拒绝，
        // 范围更新**静默失效**（只在 updateTrace 里留下一行「更新失败」）。
        street: record.street,
        action: rangeAction,
        actor: opponent.id,
        actionIndex,
        activePlayerCount: state.players.filter((p) => !p.folded).length,
        potSize: computePot(state),
        ...(record.amount > 0 ? { betSize: record.amount } : {}),
      },
      {
        withDiff: false,
        /*
         * 🔴 画像 / 近期倾向进入动作似然（规范第二十节唯一合法入口）。
         *
         * ⚠️ **画像似然生效时必须抑制它**：那条似然本身已经含画像，
         * 再乘一次倾斜因子等于把画像计两次（且会破坏单调性 —— 见
         * `likelihoodOverride` 的构造注释）。
         */
        ...(provider !== undefined && !suppressProvider ? { adjustmentProvider: provider } : {}),
      },
    );
    if (provider !== undefined && !suppressProvider) providerCalls += 1;

    if (!result.ok) {
      trace.push({
        street: record.street,
        action: `${record.type}（更新失败：${result.code}）`,
        actorPositionZh: POSITION_ZH[opponent.position],
        supportBefore: current.metrics.supportSize,
        supportAfter: current.metrics.supportSize,
        entropyBefore: current.metrics.entropyBits,
        entropyAfter: current.metrics.entropyBits,
      });
      continue;
    }

    const before = current.metrics;
    current = result.value.range;
    trace.push({
      street: record.street,
      action: String(record.type),
      actorPositionZh: POSITION_ZH[opponent.position],
      supportBefore: before.supportSize,
      supportAfter: current.metrics.supportSize,
      entropyBefore: before.entropyBits,
      entropyAfter: current.metrics.entropyBits,
      // 画像路径的启用/回落理由必须留在审计轨迹里（§四十三：可调试）
      ...(profileNoteZh === null ? {} : { noteZh: profileNoteZh }),
    });
  }

  return { range: current, trace, providerCalls, profileLikelihoodActions, rangeBeforeAction };
}

function buildRangeSnapshot(
  state: GameState,
  opponent: PlayerState,
  deadCards: readonly Card[],
  /** 求解器给这一家的范围权重（有则用，无则回落启发式先验） */
  solverOverride?: SolverRangeOverride,
  /**
   * 🔴 画像 / 近期倾向的 provider（**只对画像描述的那个对手传入**）。
   *
   * 对陌生人（没有画像、没有手选类型）不传：替他套一个原型就是编造数据。
   */
  tendency?: { provider: TendencyProvider; dimension: ResolvedTendencyDimensions } | null,
  /** 跛入原型（多人 limp 修复，§4）：画像描述的那家带画像，其余 = 人群先验 */
  limpProfile?: { archetype: LimperArchetype; confidence: number } | null,
  /**
   * 🔴 **行为画像**（PLAYER PROFILE QUANTIFICATION V1 · §十二）。
   *
   * 与 `tendency` 同样**只对画像描述的那个对手传入**；
   * 且严格可选 —— 不传时 `applyLikelihoodUpdates` 走原路径，逐位不变。
   */
  behaviorProfile?: PlayerBehaviorProfile | null,
  /**
   * 🔴 **RIVER BET RANGE V2**：`state.actions` 里「当前这一次下注」的下标。
   *
   * 传了之后会额外产出 `rangeBeforeAction` —— **真正的到达范围**
   *（该动作发生**之前**的范围）。只有「正在下注的那一家」才需要传。
   */
  captureBeforeActionIndex?: number,
): RangeBuild {
  const warnings: string[] = [];
  const aggression = firstPreflopActionOf(state, opponent.id);

  const base = buildBaseRange(state, opponent, aggression, deadCards, solverOverride, limpProfile);
  if (!base.ok) {
    return { snapshot: null, range: null, warnings: [base.reason], tendency: null, rangeBeforeAction: null };
  }

  /*
   * 🔴 **求解器范围不再施加似然更新。**
   *
   * 为什么：`applyLikelihoodUpdates` 是给**启发式先验**打的补丁 ——
   * 那个先验只编码了「他会用什么牌做这类动作」的粗略倾向，
   * 因此需要拿真实行动去做贝叶斯收缩。
   *
   * 而求解器给的范围**已经是**「面对这个具体动作时的混合策略频率」：
   * 它已经包含了这次行动的全部信息。再乘一次似然就是**重复计票** ——
   * 范围会被收缩第二次，窄到不真实（这正是 `applyLikelihoodUpdates`
   * 自己的文件头警告过的形态）。
   *
   * 跳过之后 `updateTrace` 为空，界面会显示「（无更新，直接使用先验）」；
   * 对求解器范围那是**正确**的描述。
   *
   * ⚠️ 画像同样不施加于求解器范围：求解器范围是**策略频率**，
   * 它本身已经隐含了对手类型（那是求解器的输入）；再乘一次画像因子
   * 会与求解器口径冲突，且无法验证。
   */
  const updated =
    solverOverride !== undefined
      ? {
          range: base.range,
          trace: [] as RangeUpdateTraceEntry[],
          providerCalls: 0,
          profileLikelihoodActions: 0,
          /*
           * 求解器范围**不施加任何似然** ⇒ 它本身就是到达范围，
           * 因此「当前动作之前的范围」与它就是同一份（引用相同，零额外计算）。
           */
          rangeBeforeAction: base.range as Range | null,
        }
      : applyLikelihoodUpdates(
          base.range,
          state,
          opponent,
          aggression,
          tendency?.provider,
          behaviorProfile ?? undefined,
          captureBeforeActionIndex,
        );
  const range = updated.range;

  /*
   * 画像证据（P0）：**先验侧与组合侧都要如实记录**。
   *
   * `combosBefore` 取「进入本街似然更新之前的支持集」——
   * 用第一条 trace 的 `supportBefore`（若没有更新，则就是基础范围本身）。
   */
  const tendencyCore: RangeTendencyCore | null =
    tendency === undefined || tendency === null
      ? null
      : {
          provider: tendency.provider.evidence(),
          dimensionTier: tendency.dimension.tier,
          dimensionTierZh: TENDENCY_TIER_ZH[tendency.dimension.tier],
          dimensionNoteZh: tendency.dimension.noteZh,
          combosBefore:
            updated.trace.length > 0
              ? updated.trace[0]!.supportBefore
              : base.range.metrics.supportSize,
          combosAfter: range.metrics.supportSize,
        };

  // ---- 范围塌缩：必须如实报告，禁止自动补均匀范围 ----
  const collapsed = range.state === RangeState.COLLAPSED || range.metrics.supportSize === 0;
  if (collapsed) {
    warnings.push(
      '对手范围已塌缩（0 个合法组合）—— 决策将返回「信息不足」，不会自动补一个均匀范围',
    );
  }

  const totalCombos = 1326;
  const snapshot: RangeSnapshot = Object.freeze({
    opponentId: opponent.id,
    opponentPositionZh: POSITION_ZH[opponent.position],
    sourceId: range.provenance.sourceId,
    sourceKind: range.provenance.sourceType,
    sourceDescription: range.provenance.description,
    confidence: range.provenance.confidence,
    supportSize: range.metrics.supportSize,
    supportShare: range.metrics.supportSize / totalCombos,
    metrics: range.metrics,
    collapsed,
    updateTrace: Object.freeze(updated.trace),
  });

  return {
    snapshot,
    range,
    warnings,
    tendency: tendencyCore,
    rangeBeforeAction: updated.rangeBeforeAction,
    /**
     * 画像是否**通过任一通道真的改变了这个对手的范围**（V2.1 去重闸门修复）。
     *
     * 三个通道，缺一不可：
     * ① `provider.applied` —— 倾向乘法通道（中性可信度不足时为 false）；
     * ② `profileLikelihoodActions > 0` —— 河牌统一似然通道（**该通道上 provider 被抑制**，
     *    因此只看 ① 会把「画像已经生效」误判为「没生效」）；
     * ③ 跛入原型通道 —— 由调用方按 `profileChangesLimpRange` 补上。
     */
    profileAppliedToRange:
      tendencyCore !== null && (tendencyCore.provider.applied || updated.profileLikelihoodActions > 0),
    profileAppliedActions: updated.profileLikelihoodActions,
  };
}

/* ============================================================
 * 下注决策事实包（BET DECISION ENGINE PHASE 1）
 * ============================================================ */

/** 条件范围权益的抽样次数（响应模型一次要算 3 尺寸 × 2 桶 = 6 次） */
const RESPONSE_EQUITY_ITERATIONS = 6000;

/**
 * 对**某一份组合权重**算 Hero 权益（与 `computeHeroEquity` 同一引擎、同一口径）。
 *
 * ⚠️ 只有迭代数与种子不同：响应模型需要 6 次权益（3 尺寸 × 跟注/加注桶），
 * 每次 20,000 会把节点耗时推到秒级。这里降到 6,000 并在 debug 里如实标出
 * 迭代数与方法 —— **不是**为了好看而降精度，而是预算分配（决策层可在
 * `betDecision.sizes[].equityIterations` 里看到真实精度）。
 */
function rangeEquityOf(
  heroHole: readonly Card[],
  board: readonly Card[],
  entries: readonly { cardIndices: readonly [number, number]; probability: number }[],
  seed: number,
): { value: number | null; method: 'EXACT' | 'MONTE_CARLO' | 'NOT_AVAILABLE'; iterations: number } {
  return rangeEquityOfMany(heroHole, board, [entries], seed);
}

/**
 * 对**多份**条件范围同时算 Hero 权益（真正的多人权益，§6）。
 *
 * 🔴 用途：多人联合分支里「两家都跟」的权益必须是
 * `Hero vs UTG-call-range vs CO-call-range` 的**一次**计算，
 * 不是两个单挑权益的平均/最小值。这里直接调用同一个权益引擎
 * （`computeEquity` 的 `opponents` 本来就是列表），不自己写采样。
 */
function rangeEquityOfMany(
  heroHole: readonly Card[],
  board: readonly Card[],
  entrySets: readonly (readonly { cardIndices: readonly [number, number]; probability: number }[])[],
  seed: number,
): { value: number | null; method: 'EXACT' | 'MONTE_CARLO' | 'NOT_AVAILABLE'; iterations: number } {
  const usable = entrySets.filter((e) => e.length > 0);
  if (usable.length === 0) return { value: null, method: 'NOT_AVAILABLE', iterations: 0 };
  const outcome = computeEquity(
    [heroHole[0]!, heroHole[1]!],
    board,
    usable.map((entries, index) => ({
      label: `条件范围 ${index + 1}（响应模型）`,
      combos: entries.map(
        (e) => [ALL_CARDS[e.cardIndices[0]]!, ALL_CARDS[e.cardIndices[1]]!] as const,
      ),
    })),
    {
      mode: EquityComputeMode.FAST,
      seed,
      iterations: RESPONSE_EQUITY_ITERATIONS,
      opponentWeights: usable.map((entries) => entries.map((e) => e.probability)),
    },
  );
  if (!outcome.ok) return { value: null, method: 'NOT_AVAILABLE', iterations: 0 };
  return {
    value: outcome.result.equity,
    method: outcome.result.method === 'EXACT' ? 'EXACT' : 'MONTE_CARLO',
    iterations: outcome.result.iterations,
  };
}

/**
 * 🔴 **TEST 08 P0-3：节点语义判定**。
 *
 * ## 问的是什么
 *
 * **首要对手**在这个决策点处于哪种下注节点语义 —— 由此决定
 * `FoldTo*CBet` 这类「他面对下注时的反应」统计能不能进直接通道。
 *
 * ## 关键：不能只看「本街谁已经下注」
 *
 * 第一版只找本街最后一个下注者，结果 TEST 08（Hero 正在决定要不要领打）
 * 返回 `null` —— **门根本没触发**，`FoldToTurnCBet` 照样生效。
 *
 * 正确的问法是「**这一注属于哪一类**」，而答案取决于
 * 「下注者 vs 上一街进攻者」，与「是不是 Hero 在下注」无关：
 *
 * | 情形 | 本街下注者 | 判定 |
 * |---|---|---|
 * | Hero 正在领打（尚未下注） | Hero | 与上一街进攻者比较 ⇒ DONK / CBET |
 * | Hero 已经下注 | Hero | 同上 |
 * | 对手下注 | 对手 | 与上一街进攻者比较 ⇒ CBET / DONK |
 * | 本街无人下注且无人正在下注 | — | `null`（他还没面对任何下注） |
 *
 * 上一街无人进攻（check-check / 未到该街）⇒ `GENERIC_BET`（延迟 cbet 与探牌
 * 从行动序列上无法区分，不猜）。
 */
function nodeActionContextOf(
  state: GameState,
  hero: PlayerState,
  primaryOpponent: PlayerState | null,
): ActionContextValue | null {
  if (primaryOpponent === null) return null;
  /*
   * 「谁在下注」：已发生的最后一个下注者优先；否则若正轮到 Hero 行动，
   * 则他**正在决定要不要下注** —— 对响应层来说这就是「他面对 Hero 的下注」。
   */
  const bettor = lastAggressorOfStreet(state.actions, state.street) ?? hero.position;
  if (bettor !== hero.position && bettor !== primaryOpponent.position) {
    return ActionContext.GENERIC_BET;
  }
  return actionContextOf({
    street: state.street,
    bettorPosition: bettor,
    actions: state.actions,
  });
}

/**
 * 构建下注决策事实包：响应模型（逐尺寸概率 + 条件范围）+ 条件范围权益 +
 * Hero 听牌潜力 + 权益实现因子。
 *
 * @returns 翻前 / 无牌面 / 无对手组合时返回 `null`（不编造概率）
 */
function buildBetDecisionFacts(input: {
  range: Range | null;
  /**
   * 🔴 **全部已实现对手**（每家一份自己的范围 + 位置 + 他自己的画像倾向）。
   *
   * 多人下注 EV **必须**消费这个完整列表（§13）：`range` / `dimensions` 两个
   * 旧字段只保留给**单挑口径与展示**，不再有权单独决定 BetEV。
   * ⚠️ 每个对手的响应对象必须**独立构建**（禁止复用同一份 —— §2/§21.10）。
   */
  opponents?: readonly {
    opponentId: string;
    range: Range | null;
    positionZh: string;
    /** 这一家自己的响应倾向（由**他本人**的画像解析；无画像 ⇒ 中立先验） */
    dimensions: Parameters<typeof responseTendenciesOf>[0];
    /**
     * 🔴 **他自己**画像的可信度（不是全局那一个）。
     *
     * 修复前这里传的是 `playerBuilt.confidence`（首要对手的可信度）：
     * 有逐座位画像、但首要对手没画像时它是 0，于是
     * `responseTendenciesOf` 直接返回中立先验 —— **逐座位画像被静默丢弃**，
     * 表现为「跟注站与普通玩家的响应逐位相同」。
     */
    confidence: number;
    tendencyNoteZh: string;
  }[];
  board: readonly Card[];
  heroHole: readonly Card[];
  pot: number;
  street: Street;
  spr: number | null;
  opponentCount: number;
  heroPosition: Position;
  villainPosition: Position | null;
  equityVsArrivalRange: number | null;
  dimensions: Parameters<typeof responseTendenciesOf>[0];
  profileConfidence: number;
  seed: number;
  /** Hero 当前**剩余**筹码（不是带入筹码） */
  heroRemaining: number;
  /**
   * 对手里**最短**的剩余筹码（多人池的有效筹码上限）。
   *
   * 🔴 修复前这里是 **primary opponent** 的筹码：三人池里 primary 恰好是深筹码时，
   * 尺寸网格会放出「只有一个人跟得起」的下注额。
   */
  villainRemaining: number;
  /** 最小下注额（通常 1 个大盲） */
  minBet: number;
  /**
   * 🔴 **PLAYER PROFILE V3**：当前街 + 该街的分街系数。
   *
   * `undefined` ⇒ 响应层不做任何分街修正（与 V2 逐位一致）。
   */
  v3Street?:
    | {
        street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER';
        factors: { foldScale: number; callScale: number; checkRaiseScale: number; betScale?: number };
      }
    | undefined;
  /**
   * 🔴 **PLAYER PROFILE V3**：由实测统计解析出的四维度（覆盖标签维度）。
   *
   * 为什么需要它：标签维度（`archetypeDimensionsOf`）**只反映标签**，
   * 而 V3 要让「VPIP/PFR/WTSD/FoldTo*CBet」也推动 tightness / aggression /
   * passivity。若不 override，resolved 维度就只会出现在 trace 里、
   * **不进模型** —— 那是「算了但没用」的假接线。
   *
   * `undefined` ⇒ 用原始 `dimensions`（与 V2 逐位一致）。
   */
  v3Dimensions?: {
    tightness: number;
    aggression: number;
    bluffTendency: number;
    passivity: number;
  } | undefined;
}): BetDecisionFacts | null {
  if (input.range === null || input.board.length < 3 || input.heroHole.length !== 2) return null;

  const texture = boardTextureOf(input.board);
  const wetness = texture === null ? 0 : boardWetnessOf(texture);
  /*
   * 🔴 **V3：实测统计解析出的维度覆盖标签维度**（没有实测时 `v3Dimensions` 缺失 ⇒ 逐位不变）。
   *
   * 覆盖而不是叠加：`resolvePlayerProfile` 已经把「标签 Prior + 实测」
   * 收缩成**一份**维度（§六），再叠一次就是重复计票。
   */
  const effectiveDimensions =
    input.v3Dimensions === undefined
      ? input.dimensions
      : {
          ...(input.dimensions as unknown as Record<string, unknown>),
          tightness: input.v3Dimensions.tightness,
          aggression: input.v3Dimensions.aggression,
          bluffTendency: input.v3Dimensions.bluffTendency,
          passivity: input.v3Dimensions.passivity,
        } as Parameters<typeof responseTendenciesOf>[0];
  const tendencies = responseTendenciesOf(effectiveDimensions, input.profileConfidence, input.v3Street ?? null);

  /*
   * 🔴 **先合法化，再算响应与 EV**（本轮 P0）。
   *
   * 修复前：理论 118 / 177 先各算一套响应与 EV，最后才映射到合法 112
   * ⇒ 同一个合法动作两套 EV。现在金额先按「单挑有效筹码」封顶并去重，
   * 所有下游计算只使用 `legalAmount`。
   */
  const { sizes: legalSizes, dropped } = legalizeBetSizes({
    pot: input.pot,
    heroRemaining: input.heroRemaining,
    villainRemaining: input.villainRemaining,
    minBet: input.minBet,
  });

  const responseModel = legalSizes.length === 0
    ? null
    : buildResponseModel({
        entries: input.range.entries.map((e) => ({
          cardIndices: e.combo.cardIndices as unknown as readonly [number, number],
          probability: e.probability,
        })),
        heroHole: input.heroHole,
        board: input.board,
        pot: input.pot,
        street: input.street,
        spr: input.spr,
        opponentCount: input.opponentCount,
        wetness,
        tendencies,
        sizes: legalSizes,
        heroRemaining: input.heroRemaining,
        /* 🔴 P1-4：对手剩余筹码 —— 「他跟这一注就全下 ⇒ 他不能再加注」这条判据要用它 */
        villainRemaining: input.villainRemaining,
      });
  if (responseModel === null) return null;

  const draw = heroDrawPotentialOf(input.heroHole, input.board);
  const inPosition = positionOrder(input.heroPosition) > positionOrder(input.villainPosition);
  const realization = realizationFactorOf({
    street: input.street,
    // 无人下注时我处于主动方（可以下注/过牌），因此按主动权处理；
    // 位置比较用座位顺序（越靠后越有位置优势）。
    hasInitiative: true,
    inPosition,
    spr: input.spr,
    draw,
  });
  /*
   * 过牌分支的实现因子：同一条代理模型，但**没有主动权、也不享受听牌实现加成**
   *（过牌把主动权交出去了；成牌只能靠对手再下注）。见 `checkRealizationFactor`。
   */
  const checkRealization = realizationFactorOf({
    street: input.street,
    hasInitiative: false,
    inPosition,
    spr: input.spr,
    draw: { ...draw, drawQuality: 0, nutPotential: 0 },
  });

  /** 基础尺寸事实（含**首要对手**的条件范围权益）—— 多人字段在下面统一补上 */
  const sizes: Omit<SizeResponseWithEquity, 'multiway' | 'evKind'>[] =
    responseModel.sizes.map((size, index) => {
    const call = size.buckets.find((b) => b.bucket === 'CALL');
    const raise = size.buckets.find((b) => b.bucket === 'RAISE');
    // 每个尺寸/桶用**不同种子**，避免三个尺寸的抽样误差完全相关
    const callEquity = rangeEquityOf(input.heroHole, input.board, call?.entries ?? [], input.seed + 101 * (index + 1));
    const raiseEquity = rangeEquityOf(input.heroHole, input.board, raise?.entries ?? [], input.seed + 211 * (index + 1));
    return Object.freeze({
      ...size,
      heroEquityVsCallRange: callEquity.value,
      heroEquityVsRaiseRange: raiseEquity.value,
      equityMethod: callEquity.method === 'NOT_AVAILABLE' && raiseEquity.method === 'NOT_AVAILABLE'
        ? ('NOT_AVAILABLE' as const)
        : callEquity.method === 'EXACT' && raiseEquity.method === 'EXACT'
          ? ('EXACT' as const)
          : ('MONTE_CARLO' as const),
      equityIterations: Math.max(callEquity.iterations, raiseEquity.iterations),
    });
  });

  /*
   * ============================================================
   * 多人联合响应树（MULTIWAY POSTFLOP RESPONSE TREE PHASE 1）
   * ============================================================
   *
   * 🔴 根因：修复前三人池只有**一组** Fold/Call/Raise —— 那是**首要对手**
   * 一个人的响应，却被当成「整个多人池的响应」，而弃牌分支
   * （`P(弃) × 底池`）被解释成「Hero 直接拿下底池」。
   * 两者在 2 家以上时是**不同的事件**：拿下底池要求**所有对手同时弃牌**。
   *
   * 现在：每家一份**独立**响应模型 → 联合状态分布 → 每个分支**各自**算权益
   * （含真正的多人权益）→ 逐分支加权求 EV。
   */
  const multiwayResult = (() => {
    const opponents = input.opponents ?? [];
    // 单挑：`betEV` 就是单挑口径，两条路径**不同时存在**（避免「哪个是真的」）
    if (opponents.length < 2 || opponents.some((o) => o.range === null)) return null;

    /** 每家一份独立响应模型（**禁止**共用对象：画像/范围/位置都不同） */
    const perOpponent = opponents.map((o, index) => {
      const model = buildResponseModel({
        entries: o.range!.entries.map((e) => ({
          cardIndices: e.combo.cardIndices as unknown as readonly [number, number],
          probability: e.probability,
        })),
        heroHole: input.heroHole,
        board: input.board,
        pot: input.pot,
        street: input.street,
        spr: input.spr,
        opponentCount: opponents.length,
        wetness,
        tendencies: responseTendenciesOf(o.dimensions, o.confidence),
        sizes: legalSizes,
        heroRemaining: input.heroRemaining,
        /* 🔴 P1-4：对手剩余筹码 —— 「他跟这一注就全下 ⇒ 他不能再加注」这条判据要用它 */
        villainRemaining: input.villainRemaining,
      });
      return { opponent: o, model, seed: input.seed + 31 * (index + 1) };
    });
    if (perOpponent.some((p) => p.model === null)) return null;

    const sizeFacts = legalSizes.map((spec, sizeIndex) => {
      const shares: OpponentResponseShares[] = perOpponent.map((p) => {
        const size = p.model!.sizes[sizeIndex]!;
        return Object.freeze({
          opponentId: p.opponent.opponentId,
          positionZh: p.opponent.positionZh,
          tendencyNoteZh: p.opponent.tendencyNoteZh,
          foldProbability: size.foldLikelihood,
          callProbability: size.callLikelihood,
          raiseProbability: size.raiseLikelihood,
        });
      });
      const states = jointStatesOf(shares);
      if (states === null) return null;

      // ---- 每个跟注分支**各自**的权益（含真多人权益）----
      const equityByCallerId: Record<string, number | null> = {};
      const callEntrySets: (readonly { cardIndices: readonly [number, number]; probability: number }[])[] = [];
      const raiseEntriesWeighted: { cardIndices: readonly [number, number]; probability: number }[] = [];
      let raiseMass = 0;
      for (const [index, p] of perOpponent.entries()) {
        const size = p.model!.sizes[sizeIndex]!;
        const call = size.buckets.find((b) => b.bucket === 'CALL');
        equityByCallerId[p.opponent.opponentId] = rangeEquityOf(
          input.heroHole,
          input.board,
          call?.entries ?? [],
          p.seed + 7,
        ).value;
        callEntrySets.push(call?.entries ?? []);
        const raise = size.buckets.find((b) => b.bucket === 'RAISE');
        const weight = shares[index]!.raiseProbability;
        if (raise !== undefined && weight > 0) {
          for (const e of raise.entries) {
            raiseEntriesWeighted.push({ ...e, probability: e.probability * weight });
            raiseMass += e.probability * weight;
          }
        }
      }
      const allCallEquity = rangeEquityOfMany(input.heroHole, input.board, callEntrySets, input.seed + 613).value;
      const anyRaiseEquity =
        raiseMass <= 0
          ? null
          : rangeEquityOf(
              input.heroHole,
              input.board,
              raiseEntriesWeighted.map((e) => ({ ...e, probability: e.probability / raiseMass })),
              input.seed + 619,
            ).value;

      const ev = composeMultiwayBetEV({
        pot: input.pot,
        betAmount: spec.legalAmount,
        ratioToPot: spec.legalAmount / (input.pot > 0 ? input.pot : 1),
        realizationFactor: realization.factor,
        states,
        equityByCallerId,
        allCallEquity,
        anyRaiseEquity,
        opponentCount: opponents.length,
      });

      const perOpponentResponse: OpponentSizeResponse[] = perOpponent.map((p, index) => {
        const size = p.model!.sizes[sizeIndex]!;
        const previous = sizeIndex === 0 ? null : p.model!.sizes[sizeIndex - 1]!;
        return Object.freeze({
          opponentId: p.opponent.opponentId,
          positionZh: p.opponent.positionZh,
          tendencyNoteZh: p.opponent.tendencyNoteZh,
          kind: size.kind,
          betAmount: size.betAmount,
          foldProbability: size.foldLikelihood,
          callProbability: size.callLikelihood,
          raiseProbability: size.raiseLikelihood,
          rawFoldProbability: size.rawFoldLikelihood,
          rawCallProbability: size.rawCallLikelihood,
          rawRaiseProbability: size.rawRaiseLikelihood,
          foldElasticityVsPrevious: previous === null ? null : size.foldLikelihood - previous.foldLikelihood,
          heroEquityVsCallRange: equityByCallerId[p.opponent.opponentId] ?? null,
          heroEquityVsRaiseRange:
            size.buckets.find((b) => b.bucket === 'RAISE')?.entries.length === 0
              ? null
              : rangeEquityOf(
                  input.heroHole,
                  input.board,
                  size.buckets.find((b) => b.bucket === 'RAISE')?.entries ?? [],
                  p.seed + 11,
                ).value,
          noteZh:
            `${p.opponent.positionZh}｜${p.opponent.tendencyNoteZh}：` +
            `弃 ${(size.foldLikelihood * 100).toFixed(1)}% / 跟 ${(size.callLikelihood * 100).toFixed(1)}% / ` +
            `加 ${(size.raiseLikelihood * 100).toFixed(1)}%（封顶前 ${(size.rawRaiseLikelihood * 100).toFixed(1)}% 加注）`,
        });
      });

      return { spec, shares, states, equityByCallerId, allCallEquity, anyRaiseEquity, ev, perOpponentResponse };
    });

    if (sizeFacts.some((s) => s === null)) return null;
    const facts = sizeFacts as NonNullable<(typeof sizeFacts)[number]>[];

    /* ---- 尺寸饱和审计（§14）：只报告，**不制造**差异 ---- */
    const identicalPairs: { a: string; b: string; opponents: readonly string[] }[] = [];
    for (let i = 0; i < facts.length; i += 1) {
      for (let j = i + 1; j < facts.length; j += 1) {
        const sameAmount = Math.abs(facts[i]!.spec.legalAmount - facts[j]!.spec.legalAmount) < 1e-9;
        const sameOpponents = perOpponent
          .filter((p) => {
            const a = p.model!.sizes[i]!;
            const b = p.model!.sizes[j]!;
            const key = (s: typeof a): string =>
              `${s.rawFoldLikelihood.toFixed(6)}/${s.rawCallLikelihood.toFixed(6)}/${s.rawRaiseLikelihood.toFixed(6)}`;
            return key(a) === key(b);
          })
          .map((p) => p.opponent.positionZh);
        if (!sameAmount && sameOpponents.length > 0) {
          identicalPairs.push({
            a: facts[i]!.spec.kind,
            b: facts[j]!.spec.kind,
            opponents: Object.freeze(sameOpponents),
          });
        }
      }
    }
    const anySameAmount = facts.some((s, i) =>
      facts.some((t, j) => i !== j && Math.abs(s.spec.legalAmount - t.spec.legalAmount) < 1e-9),
    );
    const sizeSaturation: SizeSaturationAudit = Object.freeze({
      status:
        identicalPairs.length > 0
          ? ('IDENTICAL_RESPONSE_QUANTIZED' as const)
          : anySameAmount
            ? ('IDENTICAL_RESPONSE_SAME_AMOUNT' as const)
            : ('DISTINCT_RESPONSES' as const),
      identicalPairs: Object.freeze(identicalPairs),
      reasonZh:
        identicalPairs.length === 0
          ? '各尺寸的响应向量互不相同（差异来自价格门槛与尺寸压力项，不是人工制造）'
          : `⚠️ ${identicalPairs.map((p) => `${p.a} 与 ${p.b}`).join('、')} 在 ${identicalPairs
              .flatMap((p) => p.opponents)
              .join('/')} 上给出**逐位相同**的响应向量。` +
            '分类改为**连续混频**后，逐位相同只可能来自**相同价格**（同一合法金额，已被去重）；' +
            '若两个不同注额却给出相同响应，说明分类用的价格与申报注额不符（复用了同一个响应桶），' +
            '那属于缺陷而不是量化 —— 测试会直接判红。',
    });

    return Object.freeze({
      facts: Object.freeze({
        opponents: Object.freeze(
          opponents.map((o, index) => ({
            opponentId: o.opponentId,
            positionZh: o.positionZh,
            tendencyNoteZh: o.tendencyNoteZh,
            comboCount: perOpponent[index]!.model!.comboCount,
          })),
        ),
        jointModel: JointModel.CONDITIONAL_INDEPENDENCE,
        independenceAssumption: JOINT_INDEPENDENCE_NOTE,
        jointStates: Object.freeze(
          facts.map((f) => Object.freeze({ kind: f.spec.kind, betAmount: f.spec.legalAmount, states: f.states })),
        ),
        conditionalEquities: Object.freeze(
          facts.map((f) =>
            Object.freeze({
              kind: f.spec.kind,
              betAmount: f.spec.legalAmount,
              byCallerId: Object.freeze({ ...f.equityByCallerId }),
              allCall: f.allCallEquity,
              anyRaise: f.anyRaiseEquity,
              noteZh:
                '仅一家跟：' +
                Object.entries(f.equityByCallerId)
                  .map(([id, eq]) => `${id} ${eq === null ? '—' : (eq * 100).toFixed(1) + '%'}`)
                  .join('｜') +
                `｜全部跟（真多人）：${f.allCallEquity === null ? '—' : (f.allCallEquity * 100).toFixed(1) + '%'}` +
                `｜加注分支：${f.anyRaiseEquity === null ? '—' : (f.anyRaiseEquity * 100).toFixed(1) + '%'}`,
            }),
          ),
        ),
        branchEVs: Object.freeze(
          facts.map((f) => Object.freeze({ kind: f.spec.kind, betAmount: f.spec.legalAmount, branches: f.ev.branches })),
        ),
        totalBetEV: Object.freeze(
          facts.map((f) =>
            Object.freeze({
              kind: f.spec.kind,
              betAmount: f.spec.legalAmount,
              totalEV: f.ev.totalEV,
              evKind: f.ev.evKind,
            }),
          ),
        ),
        sizeElasticity: Object.freeze(
          perOpponent.map((p) =>
            Object.freeze({
              opponentId: p.opponent.opponentId,
              foldDeltaPerSize: Object.freeze(
                p.model!.sizes.map((s, index) =>
                  index === 0 ? 0 : s.foldLikelihood - p.model!.sizes[index - 1]!.foldLikelihood,
                ),
              ),
            }),
          ),
        ),
        sizeSaturation,
        primaryOpponentUsedForEV: false as const,
        modelConfidence: Math.max(0.2, Math.min(0.5, 0.45 - 0.05 * (opponents.length - 2))),
        noteZh:
          `${opponents.length} 家联合树（每家一份独立响应模型）；` +
          'EV 逐分支加权，**不使用** primary opponent 的单一响应；' +
          `${JOINT_INDEPENDENCE_NOTE}；加注分支为下界（RAISE_RESPONSE = HEURISTIC）`,
        perOpponentResponse: Object.freeze(facts.flatMap((f) => f.perOpponentResponse)),
      }),
      /** 逐尺寸的完整多人 EV 对象（供 `sizes[].multiway` 与决策层覆盖 betEV） */
      evBySize: Object.freeze(facts.map((f) => f.ev)),
    } satisfies { facts: MultiwayBetFacts; evBySize: readonly MultiwayBetEV[] });
  })();

  /*
   * ---- CHECK 树（§5/§6；TEST 08 P0-2：**不再限定河牌**）----
   *
   * Hero 在**前位**过牌之后对手仍可下注，因此不能把过牌当成摊牌。
   * 修复前这里写的是 `input.street === 'RIVER' && !inPosition` ——
   * 结果翻牌/转牌的前位过牌一律退化成 `HEURISTIC_ONE_STREET`，
   * `betLikelihood` 恒为 0（对 MANIAC 与 NIT 给出完全相同的结果）。
   *
   * 但「我前位过牌 ⇒ 他仍可下注」是**行动顺序**问题，与街无关。
   * 因此门只由 `inPosition` 决定：后位（他刚过牌）⇒ 摊牌终止；
   * 前位 ⇒ 构建 `CHECK_BACK | BET` 最小树。
   */
  const checkTree = (() => {
    if (inPosition) {
      return composeCheckEVTree({
        pot: input.pot,
        street: input.street,
        isInPosition: inPosition,
        heroEquityVsArrivalRange: input.equityVsArrivalRange,
        realizationFactor: checkRealization.factor,
        afterCheck: null,
      });
    }

    // 他的代表下注尺寸：2/3 池，按**他的**剩余筹码封顶（不能超过他能拿出的）
    const representative = Math.max(
      input.minBet,
      Math.min(input.pot * (2 / 3), Math.max(0, input.villainRemaining)),
    );
    const price = input.pot + 2 * representative > 0
      ? representative / (input.pot + 2 * representative)
      : 0;

    // 逐组合分流：CHECK_BACK | BET（混频权重，画像只改概率）
    const checkBackEntries: { cardIndices: readonly [number, number]; probability: number }[] = [];
    const betEntries: { cardIndices: readonly [number, number]; probability: number }[] = [];
    let checkBackMass = 0;
    let betMass = 0;
    /*
     * 🔴 **TEST 08 P0-2 诊断：与范围构成无关的「行为倾向」**。
     *
     * `betLikelihood = betMass / (betMass + checkBackMass)` 是**占到达范围的份额**，
     * 会被范围宽度稀释：MANIAC 开池 58% ⇒ 带进来大量「必然过牌」的弱牌
     * （tier 3 中段、tier 4/5 垃圾），份额被摊薄。实测 MANIAC 0.1159 < NIT 0.1215，
     * 但**不是因为他不爱开枪**，而是因为他的分母大。
     *
     * 因此这里额外累积**逐组合下注权重的范围均值**（按到达概率加权）：
     *
     * ```text
     * fireWeight = Σ p(combo) × betWeight(combo) / Σ p(combo)
     * ```
     *
     * 它是「他拿着**平均一手牌**时的开枪意愿」，与范围宽窄无关 ——
     * 这才是画像下注倾向应该驱动的量。两者都保留：
     * - `betLikelihood` 用于 EV 计算（它必须是份额，否则 EV 不一致）
     * - `fireWeight` 用于**方向审计**与画像差异的可读对比
     */
    let betWeightAcc = 0;
    let weightAll = 0;
    let heroEval;
    try {
      heroEval = evaluateCards([...input.heroHole, ...input.board]);
    } catch {
      heroEval = null;
    }
    for (const entry of input.range.entries) {
      if (!(entry.probability > 0)) continue;
      const hole: [Card, Card] = [
        ALL_CARDS[entry.combo.cardIndices[0]]!,
        ALL_CARDS[entry.combo.cardIndices[1]]!,
      ];
      if (heroEval === null) continue;
      let versusHero: 'STRONGER' | 'WEAKER' | 'EQUAL';
      try {
        const cmp = compareHands(evaluateCards([...hole, ...input.board]), heroEval);
        versusHero = cmp > 0 ? 'STRONGER' : cmp < 0 ? 'WEAKER' : 'EQUAL';
      } catch {
        continue;
      }
      const classification = classifyVillainAfterCheck({
        tier: boardRelativeTierOf(hole, input.board) ?? 5,
        versusHero,
        tendencies,
        pot: input.pot,
        betSize: representative,
        street: input.street,
      });
      const w = classification.weights;
      betWeightAcc += entry.probability * w.bet;
      weightAll += entry.probability;
      if (w.checkBack > 0) {
        checkBackEntries.push({
          cardIndices: entry.combo.cardIndices as unknown as readonly [number, number],
          probability: entry.probability * w.checkBack,
        });
        checkBackMass += entry.probability * w.checkBack;
      }
      if (w.bet > 0) {
        betEntries.push({
          cardIndices: entry.combo.cardIndices as unknown as readonly [number, number],
          probability: entry.probability * w.bet,
        });
        betMass += entry.probability * w.bet;
      }
    }
    /** 与范围宽度无关的「平均一手牌的开枪意愿」（0..1） */
    const fireWeight = weightAll > 0 ? betWeightAcc / weightAll : null;
    const totalMass = checkBackMass + betMass;
    if (!(totalMass > 0)) {
      return composeCheckEVTree({
        pot: input.pot,
        street: input.street,
        isInPosition: inPosition,
        heroEquityVsArrivalRange: input.equityVsArrivalRange,
        realizationFactor: checkRealization.factor,
        afterCheck: null,
      });
    }
    const normalize = (
      entries: typeof checkBackEntries,
      mass: number,
    ): { cardIndices: readonly [number, number]; probability: number }[] =>
      mass <= 0 ? [] : entries.map((e) => ({ ...e, probability: e.probability / mass }));

    const checkBackEquity = rangeEquityOf(
      input.heroHole,
      input.board,
      normalize(checkBackEntries, checkBackMass),
      input.seed + 977,
    );
    const betEquity = rangeEquityOf(
      input.heroHole,
      input.board,
      normalize(betEntries, betMass),
      input.seed + 983,
    );
    void price;

    return composeCheckEVTree({
      pot: input.pot,
      street: input.street,
      isInPosition: inPosition,
      heroEquityVsArrivalRange: input.equityVsArrivalRange,
      realizationFactor: checkRealization.factor,
      afterCheck: {
        checkBackLikelihood: checkBackMass / totalMass,
        betLikelihood: betMass / totalMass,
        heroEquityVsCheckBackRange: checkBackEquity.value,
        heroEquityVsBetRange: betEquity.value,
        villainBetAmount: representative,
        ...(fireWeight !== null ? { fireWeight } : {}),
      },
    });
  })();

  return Object.freeze({
    pot: input.pot,
    heroEquityVsArrivalRange: input.equityVsArrivalRange,
    draw,
    realization,
    checkRealizationFactor: checkRealization.factor,
    /*
     * 🔴 每个尺寸的 `betEV` **来源只有一个**：
     * - ≥2 家 ⇒ 多人联合树（`multiway.totalEV`，且 `evKind` 如实标注加注分支是下界）；
     * - 1 家  ⇒ 单挑旧口径（`SINGLE_OPPONENT_MODEL_EV`，与历史逐位一致）。
     * `multiway` 字段本身只在该尺寸**真的用了**联合树时非 null。
     */
    sizes: Object.freeze(
      sizes.map((size, index) => {
        const ev = multiwayResult === null ? null : multiwayResult.evBySize[index] ?? null;
        return Object.freeze({
          ...size,
          multiway: ev,
          evKind:
            ev === null
              ? ('SINGLE_OPPONENT_MODEL_EV' as const)
              : ev.totalEV === null
                ? ('NOT_AVAILABLE' as const)
                : ev.evKind,
        });
      }),
    ),
    droppedSizes: dropped,
    checkTree,
    comboCount: responseModel.comboCount,
    tendencies,
    multiway: multiwayResult === null ? null : multiwayResult.facts,
    modelNoteZh:
      `${responseModel.noteZh}；条件范围权益：每桶 ${RESPONSE_EQUITY_ITERATIONS} 次抽样（` +
      '⚠️ 与主权益口径同引擎但迭代数较低，debug 里如实标出）；' +
      `权益实现因子 ${realization.factor.toFixed(3)} 是**代理模型**（HEURISTIC），不是求解器结果` +
      (multiwayResult === null
        ? input.opponentCount >= 2
          ? '；⚠️ 多人（≥2 家）但拿不到全部对手的可达范围 ⇒ **联合树未构建**，本尺寸 EV 仍是单挑口径（MULTIWAY_EQUITY_NOT_IMPLEMENTED）'
          : '；单挑节点：BetEV 为单挑口径（与历史逐位一致）'
        : `；**多人联合树**：${multiwayResult.facts.noteZh}`),
  });
}

/** 座位顺序（越靠后 = 越有位置优势） */
function positionOrder(position: Position | null): number {
  if (position === null) return -1;
  const order: readonly Position[] = ['SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN'];
  return order.indexOf(position);
}

/* ============================================================
 * 权益（多人口径）
 * ============================================================ */

/**
 * 计算 Hero 对**全部已实现对手**的权益（多人口径）。
 *
 * ## 🔴 这里曾经是单挑口径 —— 那是「5 家进池就拒答」的根因
 *
 * 修复前签名是 `(hero, board, range, seed)`，只收**一个**范围。
 * 底池赔率按真实进池人数算（`buildMathSnapshot` 用的是真实底池），
 * 权益却按 1 家算 —— 两个数字口径不一致，结果系统性偏乐观。
 *
 * 决策层为了不输出误导性建议，只能在 `realizedOpponentCount >= 3` 时
 * **拒绝给建议**。但那条拒绝让工具在真实牌桌上基本失效。
 *
 * 现在按真实对手数计算。实测同一手 AK 顶对：
 *
 * | 对手数 | 权益 |
 * |---|---|
 * | 1 | 87.1% |
 * | 3 | 67.3% |
 * | 5 | 53.8% |
 *
 * 差 33 个百分点 —— 足以把「跟注」变成「弃牌」。
 *
 * ## 性能
 *
 * 实测（5 家 × 120 组合 × 20,000 次迭代）**116 ms**，
 * 在 3 秒软预算内绰绰有余。迭代数按对手数分档下调：
 * 人越多、每次迭代越贵，而多人口池的权益本身也不需要单挑那样的精度
 *（对手越多，权益越趋于稳定）。
 */
function computeHeroEquity(
  hero: PlayerState,
  board: readonly Card[],
  opponentRanges: readonly { opponentId: string; range: Range }[],
  seed: number,
): { value: number | null; source: EquitySource | null; warning: string | null } {
  if (hero.holeCards === null || hero.holeCards.length !== 2) {
    return { value: null, source: null, warning: '缺少 Hero 底牌，无法计算权益' };
  }
  if (opponentRanges.length === 0) {
    return {
      value: null,
      source: null,
      warning: '没有任何**已实现**的对手范围，无法计算权益（还没人进池）',
    };
  }

  const usable = opponentRanges.filter((o) => o.range.metrics.supportSize > 0);
  if (usable.length === 0) {
    return { value: null, source: null, warning: '对手范围为空或塌缩，无法计算权益' };
  }

  /*
   * 迭代数按对手数分档。
   *
   * ⚠️ 这不是「为了快而降低精度」—— 6 家池的权益分布本身比单挑窄得多，
   * 而每次迭代要抽 6 副互不冲突的对手牌，代价随人数上升。
   * 实测 20,000 次在 5 家时是 116 ms，仍然够用，因此**不激进下调**。
   */
  const iterations = usable.length <= 2 ? 20000 : usable.length <= 4 ? 16000 : 12000;

  const outcome = computeEquity(
    [hero.holeCards[0]!, hero.holeCards[1]!],
    board,
    usable.map((o, index) => ({
      label: usable.length === 1 ? '对手范围（启发式）' : `对手 ${index + 1} 范围（启发式）`,
      // ⚠️ 组合**按牌面传入**，权重通过 `opponentWeights` 单独传递
      // 并在 MC 内按 CDF 抽样 —— 否则范围后验会被静默丢掉
      //（见 equityMonteCarlo 的 perOpponentWeights 文档）。
      combos: o.range.entries.map(
        (e) => [ALL_CARDS[e.combo.cardIndices[0]]!, ALL_CARDS[e.combo.cardIndices[1]]!] as const,
      ),
    })),
    {
      mode: EquityComputeMode.FAST,
      seed,
      iterations,
      opponentWeights: usable.map((o) => o.range.entries.map((e) => e.probability)),
    },
  );

  if (!outcome.ok) {
    return { value: null, source: null, warning: `权益计算失败：${outcome.code}` };
  }

  const result = outcome.result;
  return {
    value: result.equity,
    source: {
      method: result.method,
      iterations: result.iterations,
      confidenceHalfWidth: result.confidenceInterval95,
      downgradedFromExact: result.downgradedFrom !== null,
    },
    warning: null,
  };
}

/* ============================================================
 * 分层权益（2026-09 多层权益轮）
 * ============================================================ */

/**
 * 每层分层计算要预留的毫秒数（实测：层 j 的抽样次数按该层对手数分档，
 * 单次抽样 0.0036 ms（2 层）→ 0.0066 ms（7 层））。
 */
const LAYERED_PER_LAYER_RESERVE_MS = 150;
/** 决策层与 ViewModel 的固定余量 */
const LAYERED_FIXED_RESERVE_MS = 300;

/**
 * 时间预算还够不够做**可选**的分层权益计算。
 *
 * ## 为什么需要它（2026-09 修正轮）
 *
 * 硬超时原先只在 `buildDecisionContext` **返回之后**检查，而分层计算
 * 无条件跑完 —— 于是新增的耗时会把「本来能算完」的分析整条变成
 * `DEADLINE` 失败（实测 `hardMs = 300` 时必然中止）。
 *
 * ## 预留必须按**层数**算，不能是一个固定数
 *
 * 实测耗时随层数上升（2 层 ≈ 110–220 ms，7 层 ≈ 610–1030 ms）。
 * 固定预留 600 ms 会让「7 层但只剩 800 ms」的局面照样开跑，
 * 跑完 1.0 s 再整条失败 —— 预留就失去意义了。
 *
 * ## 为什么这不算「按预算降低精度」
 *
 * 跳过它不会改变任何已算出的数：回落路径是**更保守**的那一边
 *（用一个可证明的下界，或干脆不给方向），因此**绝不会**因为时间紧张
 * 而给出错误方向 —— 它要么与原结论同向，要么拒绝表态。
 * 这与 `alphaPipeline` 的纪律一致：预算只能决定「要不要继续算」，
 * 不能决定「算得多准」（因此这里**不做**「少跑几次蒙特卡洛」那种削减）。
 *
 * 无 `budgetElapsedMs`（直接调用本模块的测试）⇒ 一律照算，行为不变。
 */
function shouldSpendOnLayeredEquity(input: ContextBuildInput, plannedLayers: number): boolean {
  if (input.budgetElapsedMs === undefined) return true;
  const hardMs = (input.budget ?? { softMs: 3000, hardMs: 8000 }).hardMs;
  const reserve = LAYERED_FIXED_RESERVE_MS + LAYERED_PER_LAYER_RESERVE_MS * Math.max(0, plannedLayers);
  return input.budgetElapsedMs + reserve < hardMs;
}

/**
 * 🔴 **逐层算胜率，得到真实的跟注 EV**。
 *
 * ## 为什么单一权益不够
 *
 * 多人边池下，各层的**胜负条件不同**：
 *
 * ```text
 * 主池：要赢**该层全部**对手      → 胜率低
 * 边池：只需赢**同层**的对手      → 胜率高
 * ```
 *
 * 拿「对全部对手的胜率」乘「全部可争夺量」，等于假装每一层都是同样的难度 ——
 * 于是它只是**下界**。据此弃牌会系统性弃掉本该跟的牌（`POT-13` 用逐张枚举
 * 锁住过一手真实 EV = **+1764** 却被判负期望的牌）。
 *
 * ## 算法（🔴 口径：**先假设投入，再分层**，顺序不能反）
 *
 * ```text
 * 预览  = previewCommit(state, 我, 跟注额)          ← 与 winnable 同源
 * 若 预览.singleThresholdApplies ⇒ 返回 undefined（门槛就是真门槛，见下）
 * 对 预览.layersForPlayer 的每一层 j：
 *   该层对手 = 该层 eligibleIds − 我，且必须**已实现**（有范围）
 *   胜率_j   = computeHeroEquity(我, 牌面, 该层对手)   ← 各自独立算
 * EV = Σ_j (胜率_j × 层额_j) − 跟注额                 ← 层额已含我在这层里的钱
 * ```
 *
 * ## 🔴 为什么层必须来自 `previewCommit`，而不是 `computeLayeredPot(state)`
 *
 * 决策时刻直接分层，会把「我还没跟注」误当成「对手那笔钱不会被争」：
 *
 * ```text
 * 我 BB 100 ／ UTG 300 ／ CO 300
 *   computeLayeredPot(state).contested = 750      ← 我的 200 跟注不在里面
 *   winnableIfCommit(state, 我, 200)    = 950      ← 跟注后才是真实可争夺量
 * ```
 *
 * 用前者算出的 EV 是 `E × 750 − 200`，比项目自己的下界 `E × 950 − 200`
 * 还小 `E × 200` —— 一个**更小的下界**却被当作 `exact = true` 的「真值」
 * 用于**不可翻转的硬判**。实测后果：
 *
 * | 局面 | 错误口径 | 正确口径 |
 * |---|---|---|
 * | `POT-14`（AA，跟 2900，`contested` 2150） | **−1352（判弃牌）** | **+2176** |
 * | 我跟注额 > 决策时刻的可争夺量时 | **被算术强制为负**（与权益无关） | 正常 |
 *
 * 这与 `pots.ts` 420-455 行反复强调的「先假设投入，再分层」是同一条不变量；
 * 同文件里 `winnable` 一直是对的，只有这里用错了 state。
 *
 * ## 只在「门槛不适用」时才跑（判据与 `requiredEquityApplies` 同源）
 *
 * `previewCommit(...).singleThresholdApplies === true` ⇒ 立刻返回 `undefined`。
 * 这一个判据同时覆盖两类局面：
 *
 * | 局面 | 为什么不必算 |
 * |---|---|
 * | 我**只有一层**（跟注后） | 此时 `E × winnable − c` 就是真值（见下） |
 * | 层界**非结构性**（卡在我下面的人还能再投钱，一跟注层就并回主池） | 门槛仍适用，分层反而会改判黄金局面 |
 *
 * ⚠️ 此前这里用的是 `computeLayeredPot(state).layers.length <= 1`，
 * 于是全项目出现了**两套「单层」定义**：我投过盲注/跟注而对手在我上方时，
 * 决策时刻会冒出一个**我根本不在其中、跟注后就消失**的「暂时性层」，
 * 让本该走单层门槛的局面被改判（连红队 `F-06` 那类局面都被打中）。
 *
 * ## 为什么「我只有一层」时不必算
 *
 * 我只有一层 ⇒ 那一层就是主池，参与者是**全部**还在桌上的人
 * ⇒ 「赢下所有人」的胜率正是该层胜率 ⇒ `E × winnable − c` 已经是真值。
 *
 * ## 成本（实测 2026-09，2–3 个对手）
 *
 * | 项 | 实测 |
 * |---|---|
 * | 单层 / 门槛仍适用 | **0 ms**（直接返回） |
 * | 多层：2–3 层 | **126–302 ms** |
 * | 极端（7 层 / 7 对手） | 约 1.1 s（受 `deadlineBudget` 约束，见调用方） |
 *
 * ## `exact` 的含义
 *
 * 每一层都必须能拿到对手范围才叫精确。若某层的对手里有人**没有范围**
 *（例如范围塌缩），那层的胜率就不可信 ⇒ `exact = false`，
 * 调用方必须回落「不给方向」，**不得**用 `lowerBound` 判方向。
 *
 * @returns `undefined` 表示不需要或无法分层（门槛仍适用、无跟注、无底牌）
 */
function computeLayeredEquity(
  state: GameState,
  hero: PlayerState,
  board: readonly Card[],
  callCost: number,
  opponentRanges: readonly { opponentId: string; range: Range }[],
  seed: number,
): MathSnapshot['layeredEV'] {
  if (callCost <= 0) return undefined;
  if (hero.holeCards === null || hero.holeCards.length !== 2) return undefined;

  /*
   * 🔴 「先假设投入，再分层」—— 层必须来自跟注**之后**的预览。
   * `winnable` 用的是同一个预览，因此 Σ层额 === winnable 恒成立。
   */
  const preview = previewCommit(state, hero.id, callCost);
  if (preview.singleThresholdApplies) return undefined;

  const layers = preview.layersForPlayer;
  if (layers.length <= 1) return undefined; // 防御：上面那条已经覆盖

  const startedAt = Date.now();
  const rangeById = new Map(opponentRanges.map((o) => [o.opponentId, o]));

  /** 每层的胜率；`null` 表示该层拿不到可信胜率 */
  const layerEquities: (number | null)[] = [];

  for (const [index, layer] of layers.entries()) {
    /*
     * 该层有资格争夺的人（除了我）。
     * ⚠️ 用 `eligibleIds` 而不是「全部对手」—— 那正是分层的意义。
     */
    const otherEligibleIds = layer.eligibleIds.filter((id) => id !== hero.id);

    /*
     * 🔴 **「确实只有我一人有资格」与「对手全都没有范围」必须先分开**
     * （2026-09 修正轮 · 审查 A1）。
     *
     * 这两件事的结论**相反**：前者是我独占该层（胜率 = 1，事实清楚），
     * 后者是**数据缺失**（胜率未知，必须按「算不准」处理）。
     * 修复前这里先按「过滤掉没有范围的对手」得到 `eligibleOpponents`，
     * 再看它是不是空 —— 于是「对手全都没有范围」被当成「无人能争」，
     * 胜率被写成 1。实测同一个响应里能同时出现
     * `heroEquity = null`（算不出来）与 `layeredEV.exact = true`（精确值 4100）。
     *
     * ⚠️ 不能为了「凑一个胜率」而丢掉没有范围的对手 —— 那会高估；
     * 也不能把「没有数据」当成「没有对手」—— 那会把不知道说成必胜。
     */
    if (otherEligibleIds.length === 0) {
      layerEquities.push(1); // 该层只有我 ⇒ 无人能争
      continue;
    }

    /* 有资格者里有人**没有范围** ⇒ 这一层算不准（缺失 ≠ 独占） */
    if (otherEligibleIds.some((id) => !rangeById.has(id))) {
      layerEquities.push(null);
      continue;
    }

    const eligibleOpponents = otherEligibleIds.map(
      (id) => rangeById.get(id) as { opponentId: string; range: Range },
    );
    const computed = computeHeroEquity(hero, board, eligibleOpponents, seed + index * 7919);
    layerEquities.push(computed.value);
  }

  const exact = layerEquities.every((e) => e !== null);
  const known = layerEquities.filter((e): e is number => e !== null);

  if (known.length === 0) return undefined;

  /*
   * 精确值：逐层用各自的胜率（Σ层额 === `winnable`，层额已含我的跟注）。
   * 若有层算不准，则给出**上下界**（只用于显示与诊断，绝不能用来判方向）：
   *   下界 = 未知层的贡献取 0（最保守） → 实际上是 `−跟注额` 到真值之间
   *   上界 = 未知层的贡献取 1（最乐观）
   */
  const sumWith = (fill: number): number =>
    layers.reduce((sum, layer, index) => {
      const e = layerEquities[index];
      return sum + (e ?? fill) * layer.amount;
    }, 0);

  const exactSum = exact ? sumWith(0) : null;
  const lowerBound = (exactSum ?? sumWith(0)) - callCost;
  const upperBound = (exactSum ?? sumWith(1)) - callCost;

  return {
    exact,
    value: exact ? exactSum! - callCost : lowerBound,
    lowerBound,
    upperBound,
    layerCount: layers.length,
    costMs: Date.now() - startedAt,
  };
}

/* ============================================================
 * 玩家快照
 * ============================================================ */

function buildPlayerSnapshot(
  villainId: string,
  profile: unknown,
  quickProfile: string | undefined,
  /** 近期倾向（P0 修复：它现在进入**动作似然**，不再只是一个展示字段） */
  dynamicHint?: DynamicHint,
  /** 「某条街上当时的公共牌」（画像的弱牌判据要锚定到牌面） */
  boardOfStreet?: (street: Street) => readonly Card[],
): {
  snapshot: PlayerSnapshot;
  hasUsableProfile: boolean;
  confidence: number;
  /**
   * 🔴 **实测可信度（未被手选画像覆盖之前的值）**。
   *
   * `snapshot.confidence` 在「无实测数据但有手选画像」时会被抬到
   * `QUICK_PROFILE_CONFIDENCE`（那是**断言**的可信度）。
   * 若把那个数当成「实测可信度」去解析维度，就会得出
   * 「实测可信度 0.35 ≥ 手选上限 0.35 ⇒ 只用实测维度」——
   * 而那份「实测维度」其实来自零手画像（全中立）⇒ 画像**静默失效**。
   * 这正是本轮修复必须区分的两个量，因此单独返回。
   */
  measuredConfidence: number;
  tendency: { provider: TendencyProvider; dimension: ResolvedTendencyDimensions } | null;
} {
  // 没有真实画像时，用零手画像（它会走到 UNKNOWN / 中性调整）
  const effectiveProfile =
    profile !== null && profile !== undefined && typeof profile === 'object'
      ? (profile as Parameters<typeof readPlayer>[0])
      : createProfile(villainId);

  const read: PlayerRead = readPlayer(effectiveProfile);
  const handsObserved = read.sampleNote.totalHands;
  const measuredConfidence = read.adjustment.confidence;

  let confidence = read.adjustment.confidence;
  let note = `标签：${read.label}；样本 ${handsObserved} 手`;
  let neutralized = confidence <= 0;

  // 用户手选的快速画像：**可信度受限**，且不得覆盖真实画像
  //
  // ⚠️ `confidence` 在无数据时会被设为 0，而 0 在 `confidenceOf` 的
  // 「取最小值」语义下会把**整个决策置信度拉到 0**。
  // 那混淆了两件不同的事：
  // - 「有数据但不可信」→ 应该拉低整体置信度
  // - 「这个模块没有数据」→ 是**信息缺失**，不是**数据不可信**
  if (confidence <= 0) {
    if (quickProfile !== undefined && quickProfile !== 'UNKNOWN') {
      confidence = QUICK_PROFILE_CONFIDENCE;
      neutralized = false;
      note = `无实测数据，采用用户手选画像「${quickProfile}」（主观判断，可信度上限 ${QUICK_PROFILE_CONFIDENCE}）`;
    } else {
      confidence = NO_DATA_NEUTRAL;
      neutralized = true;
      note =
        '没有该玩家的实测数据，也没有手选画像 —— 玩家层不提供任何调整' +
        '（视作信息缺失，不视作数据不可信）';
    }
  }

  /*
   * 🔴 **画像 → 维度 → Range**（P0 架构修复 · 规范第二十节）。
   *
   * 修复前这里就结束了：`snapshot.adjustment` 只在决策末端被
   * `exploitAdjustmentOf` 当作偏好分修正，**从未进入范围**。
   * 现在把「维度来源解析 + provider 构造」放在这儿（**同一处**，
   * 不产生第二份口径），由调用方在建范围时使用。
   */
  const dimension = resolveTendencyDimensions({
    measured: read.adjustment.dimensions,
    measuredConfidence,
    quickProfile:
      quickProfile !== undefined && quickProfile !== ''
        ? (quickProfile as QuickProfile)
        : null,
  });
  const adjustment: ProfileAdjustment = {
    ...read.adjustment,
    confidence,
    dimensions: dimension.dimensions,
  };
  /*
   * ⚠️ **没有证据时连 provider 都不建**（信息缺失 ≠ 中性调整）。
   *
   * - 维度来源是 `PRIOR`（既无实测、也无手选画像）**且**没有近期倾向
   *   ⇒ 不构造 provider：范围链路**完全不参与**，也就不会产生任何
   *   「画像证据」对象（那会让「没有画像」与「画像没起作用」看起来一样）。
   * - 只要**有一层**有证据（手选画像 / 实测维度 / 近期倾向），
   *   就构造 provider，并如实记录它是否真的改变了形状（`applied`）。
   */
  const observationActive = dynamicHint !== undefined && OBSERVATION_TILTS[dynamicHint] !== null;
  const hasEvidence =
    dimension.tier !== TendencyEvidenceTier.PRIOR || observationActive;
  const tendency = hasEvidence
    ? {
        provider: createTendencyProvider({
          adjustment,
          observation: dynamicHint === undefined ? null : dynamicHint,
          /*
           * 「他在这个牌面上是不是空气」必须用**当时那张牌面**判断 ——
           * 见 `TendencyProviderOptions.boardOfStreet` 记录的实测非单调性。
           */
          boardOfStreet: boardOfStreet ?? (() => []),
        }),
        dimension,
      }
    : null;

  const snapshot: PlayerSnapshot = Object.freeze({
    playerId: villainId,
    label: read.label,
    labelZh: read.label,
    // 用户手选画像必须**原样带上去**（决策层的剥削层要用它；见 PlayerSnapshot 的说明）
    quickProfile:
      quickProfile !== undefined && quickProfile !== '' ? (quickProfile as QuickProfile) : null,
    confidence,
    handsObserved,
    adjustment: Object.freeze(adjustment),
    note,
    neutralized,
  });

  return { snapshot, hasUsableProfile: handsObserved > 0, confidence, measuredConfidence, tendency };
}

/* ============================================================
 * 环境快照
 * ============================================================ */

function buildEnvironmentSnapshot(
  environment: GameEnvironment,
  street: Street,
  rules: readonly StrategyKnowledge[],
  priority: ReturnType<typeof resolveIndividualOverEnvironment>,
): EnvironmentSnapshot {
  const profile = environmentProfile(environment);
  const advice: EnvironmentAdviceResult = environmentAdviceFor(
    toKnowledgeEnvironment(environment),
    streetToKnowledge(street),
    rules,
  );

  // 知识层纪律：当前**不允许**任何规则带 magnitude
  const anyMagnitudePresent = rules.some((r) => typeof r.magnitude === 'number');

  return Object.freeze({
    environment,
    labelZh: profile.label,
    advice: advice.advice,
    unmappedTargets: advice.unmappedTargets,
    skippedByStreet: advice.skippedByStreet,
    priority,
    anyMagnitudePresent,
  });
}

/* ============================================================
 * 动态快照
 * ============================================================ */

function buildDynamicSnapshot(
  state: GameState,
  villainId: string,
  asOf: number,
  dynamicHint: DynamicHint | undefined,
): DynamicSnapshot {
  const events = state.actions
    .filter((record) => record.playerId === villainId)
    .map((record, index) => ({
      eventId: `${villainId}-${index}`,
      handId: state.id,
      playerId: villainId,
      seq: index,
      timestamp: new Date(asOf - (state.actions.length - index) * 60_000).toISOString(),
      opportunities: opportunitiesOf(record.type),
    }));

  if (events.length === 0) {
    return Object.freeze({
      computed: false,
      deviationScore: 0,
      state: 'UNKNOWN',
      stateProvenance: 'OBSERVED_BEHAVIOR',
      confidence: 0,
      tiltProbability: 0,
      adapted: Object.freeze([]),
      explanation: Object.freeze(['本手没有该对手的可用事件，动态层不参与']),
      applied: false,
    });
  }

  const outcome = evaluateDynamicBehavior({
    playerId: villainId,
    baseline: {
      playerId: villainId,
      handsObserved: 0,
      version: PROFILE_VERSION,
      metrics: {},
    },
    recentEvents: events,
    asOf,
    ...(dynamicHint !== undefined && dynamicHint !== 'UNKNOWN'
      ? {
          userHints: [
            {
              kind: mapDynamicHint(dynamicHint),
              timestamp: new Date(asOf - 60_000).toISOString(),
            },
          ],
        }
      : {}),
  });

  if (!outcome.ok) {
    return Object.freeze({
      computed: false,
      deviationScore: 0,
      state: 'UNKNOWN',
      stateProvenance: 'OBSERVED_BEHAVIOR',
      confidence: 0,
      tiltProbability: 0,
      adapted: Object.freeze([]),
      explanation: Object.freeze([`动态层未能计算（${outcome.code}）`]),
      applied: false,
    });
  }

  const snapshot = outcome.value;
  const adapted = adaptAdjustments(snapshot).map((a) => ({
    target: a.target,
    direction: a.direction,
    multiplier: a.multiplier,
    magnitudeProvenance: a.magnitudeProvenance,
    conflicting: a.conflicting,
  }));

  // ⚠️ 无基线 → Dynamic 必然 UNKNOWN；此时置信度上限为提示的可信度
  const confidence =
    snapshot.dominantState === 'UNKNOWN'
      ? Math.min(snapshot.confidence, DYNAMIC_HINT_CONFIDENCE)
      : snapshot.confidence;

  return Object.freeze({
    computed: true,
    deviationScore: snapshot.deviationScore,
    state: snapshot.dominantState,
    stateProvenance: snapshot.stateProvenance,
    confidence,
    tiltProbability: snapshot.tilt.probability,
    adapted: Object.freeze(adapted),
    explanation: Object.freeze([...snapshot.explanation]),
    applied: false, // 由决策引擎在 Shadow 阶段决定
  });
}

/** 由动作类型推导「这次行动提供了什么机会」 */
function opportunitiesOf(actionType: string): { metric: PlayerMetric; success: boolean }[] {
  switch (actionType) {
    case 'RAISE':
    case 'RERAISE':
      return [
        { metric: PlayerMetric.PFR, success: true },
        { metric: PlayerMetric.VPIP, success: true },
      ];
    case 'CALL':
      return [
        { metric: PlayerMetric.VPIP, success: true },
        { metric: PlayerMetric.CALL_OPEN, success: true },
      ];
    case 'CHECK':
      return [{ metric: PlayerMetric.VPIP, success: false }];
    case 'BET':
      return [
        { metric: PlayerMetric.CBET, success: true },
        { metric: PlayerMetric.VPIP, success: true },
      ];
    case 'ALL_IN':
      return [
        { metric: PlayerMetric.PFR, success: true },
        { metric: PlayerMetric.VPIP, success: true },
      ];
    default:
      return [{ metric: PlayerMetric.VPIP, success: false }];
  }
}

/**
 * Alpha 动态提示 → 领域层 `UserHintKind` 的**穷举**映射。
 *
 * 🔴 红队 F-11：这里以前是一个带 `default: return 'UNKNOWN'` 的 `switch`，
 * 于是「界面上有、领域层没有」的 `SIZE_ANOMALY` 被**静默**吞掉 ——
 * 用户以为自己的观察被纳入，系统实际收到的是「什么都没说」。
 *
 * 现在写成 `Record<DynamicHint, UserHintKind>`：
 * 只要 `DynamicHint` 多一个成员而这里没跟上，**编译就报错**。
 * 这类「静默丢弃用户输入」的缺陷从此不可能再悄悄出现。
 */
const HINT_MAP: Readonly<Record<DynamicHint, UserHintKind>> = Object.freeze({
  NORMAL: 'NORMAL',
  LOOSER_RECENTLY: 'LOOSER_RECENTLY',
  TIGHTER_RECENTLY: 'TIGHTER_RECENTLY',
  AGGRESSION_UP: 'AGGRESSIVE_RECENTLY',
  TILT_SIGNAL: 'SUSPECT_TILT',
  CHASE_LOSS_SIGNAL: 'SUSPECT_CHASE_LOSS',
  UNKNOWN: 'UNKNOWN',
});

function mapDynamicHint(hint: DynamicHint): UserHintKind {
  return HINT_MAP[hint];
}

/* ============================================================
 * 决策时刻可见性护栏（**Fail-Closed，最后一道**）
 * ============================================================ */


/**
 * 决策层能看到的信息，**只能**是该决策时刻已经公开的信息。
 *
 * # 不变量
 *
 * > `DecisionContext` 只能包含该决策时已经公开的信息。
 *
 * ## 为什么需要这道护栏（它挡的是什么）
 *
 * `DecisionContext` 是决策链的**唯一**信息入口：权益、牌力、范围、
 * 底池赔率全部从这里读。因此一旦更晚的公共牌混进来，
 * 后果不是精度问题，而是**信息泄漏** ——
 * 系统会在「还不知道转牌是什么」的时候，用一个已知未来的牌面算权益，
 * 然后给出一个自信的建议。使用者完全看不出来。
 *
 * ## 为什么不能只依赖上游
 *
 * 实测确认：目前**不存在**可达的泄漏路径 ——
 * `parseManualInput` 要求 `board.length` **严格等于**该街应有张数，
 * 而 `tableAdapter` 的 `street` 又由 `board.length` 推导。
 * 两条规则碰巧互相抵消，于是「翻牌已录入却分析翻牌前」这种状态
 * **构造不出来**。
 *
 * 但那是**副作用，不是保证**：没有任何一行代码在为这条性质负责。
 * 任何人日后为了别的目的把那个 `===` 放宽（例如支持历史决策回看），
 * 泄漏会立刻出现，而**不会有任何测试变红**。
 *
 * 因此这条不变量必须由 `DecisionContext` 的**构造者自己**验证，
 * 而不是相信上游。
 *
 * ## 为什么不静默 slice
 *
 * 本函数**刻意不做** `board.slice(0, expected)`，也**刻意不去**
 * 用 `streetFromBoard(board)` 反推街道。理由：
 *
 * 静默修正会把「非法状态」变成「看起来正常的分析结果」——
 * 使用者拿到的是一份基于被悄悄改过的输入算出来的建议，
 * 而系统认为自己一切正常。这正是项目明令禁止的那类失败模式。
 *
 * **宁可响亮地失败，也不给出一个来源不明的建议。**
 *
 * ## 判据是 exact，不是 at-most
 *
 * 少了也不行：`FLOP + 0 张` 会让决策层以为「翻牌还没发」，
 * 于是牌力评估、权益、底池赔率全部基于一个错误的局面。
 * 可见性必须是**恰好**，不是**至多**。
 *
 * @throws 当 `allBoardCards(state)` 的张数 ≠ 该街应有张数时
 */
function assertBoardVisibility(state: GameState): void {
  const expected = BOARD_COUNT_BY_STREET[state.street];
  const actual = allBoardCards(state).length;
  if (actual === expected) return;

  const direction =
    actual > expected
      ? `多了 ${actual - expected} 张 —— 这些牌在「${STREET_ZH[state.street]}」这一刻**还没有公开**，` +
        '把它们算进去等于用未来的信息做决策（信息泄漏）'
      : `少了 ${expected - actual} 张 —— 决策层会基于一个公共牌不完整的局面计算`;

  throw new Error(
    'DECISION_BOARD_VISIBILITY_VIOLATION：' +
      `决策时刻可见性被破坏。当前街道「${STREET_ZH[state.street]}」应有 ${expected} 张公共牌，` +
      `实际 ${actual} 张（${direction}）。` +
      '这一条是**拒绝**而不是修正：静默删掉多余的牌会让使用者拿到一份' +
      '基于被悄悄改过的输入算出来的建议。',
  );
}

/* ============================================================
 * 翻前多人 limp：隔离加注事实包（MULTI_LIMP ISOLATION RAISE PHASE 1）
 * ============================================================ */

/**
 * 只回答一件事：**跛入池里，隔离加注自己的 EV 是多少**（§2–§8）。
 *
 * 为什么只能在这里做：`Range` 对象与权益引擎只在这一层可用；
 * 决策层拿不到逐组合概率，自己编一个 EV 就是伪造证据。
 *
 * ⚠️ 与既有 `math.callEV` 的**零点相同**（弃牌 ≡ 0，单位筹码），
 * 因此两者可以在同一张表里比较；但**口径不同**：
 * `callEV` 用的是「对全部对手到达范围的多人权益」，
 * 这里用的是「对 limp-call **条件范围**」的权益（§8 禁止混用）。
 */
function buildPreflopIsoFacts(args: {
  hero: PlayerState;
  street: Street;
  limpers: readonly PlayerState[];
  /** 每个 limp 的原型：画像描述的那家用画像，其余用人群先验 */
  limperInputOf: (player: PlayerState) => LimperInput;
  playersBehind: readonly PlayerState[];
  pot: number;
  bigBlind: number;
  /** 合法动作（尺寸网格与最小加注额都从这里取，不自己重算） */
  legal: LegalActions;
  heroRemaining: number;
  /** 对全部对手**到达范围**的权益（= `math.heroEquity`，只作对照，禁止用来证明加注） */
  equityVsArrival: number | null;
  /** 既有跟注代理 EV（零点 = 弃牌 0）；它**只**与弃牌比较过 */
  callProxyEV: number | null;
  board: readonly Card[];
  seed: number;
}): PreflopIsoFacts | null {
  if (args.street !== 'PREFLOP' || args.limpers.length === 0) return null;
  const bb = args.bigBlind;

  const inputs = args.limpers.map((p) => ({ player: p, input: args.limperInputOf(p) }));
  const traits = inputs.map((e) => effectiveTraits(e.input));

  /*
   * 尺寸：先按公开公式算（人数 / 位置 / 黏度 / 筹码），再截断到合法范围。
   * `ponytail:` 黏度 = 跟注倾向的线性映射（0.65..1.35 → 0..1），只有一次使用，
   * 需要真实黏度数据时再换成实测统计。
   */
  const stickiness = Math.max(
    0,
    Math.min(1, traits.reduce((acc, t) => acc + (t.call - 0.65) / 0.7, 0) / traits.length),
  );
  const size = isoRaiseSizeOf({
    limperCount: inputs.length,
    heroPosition: args.hero.position,
    stickiness,
    effectiveStackBB: Math.min(args.heroRemaining, ...inputs.map((e) => e.player.remainingStack)) / bb,
    minRaiseToBB: args.legal.minRaiseToAmount / bb,
  });
  /*
   * 🔴 目标尺寸必须**落到合法网格上**才算数：模型算出的 7.1BB 不在网格里时，
   * 真正能按下去的按钮是最近的合法尺寸（这里 = 6BB）。
   * 拿「7.1BB 的 EV」去证明「6BB 的加注」是把两个动作混为一谈。
   */
  const isoGrid = buildSizeGrid(args.legal, args.pot, 'RAISE');
  const isoOption = closestSizeTo(isoGrid, size.requestedIsoSize * bb, (o) => o.toAmount);
  const isoChips = isoOption === null ? args.legal.minRaiseToAmount : isoOption.toAmount;

  // 每个 limp 对「加注到 isoChips」的响应（价格用加注后的底池）
  const heroCommitted = args.hero.committedByStreet[args.street] ?? 0;
  const potAfterRaise = args.pot + (isoChips - heroCommitted);
  const responses = inputs.map((e) =>
    limpResponseOf({
      limper: e.input,
      potAfterRaise,
      chipsToCall: isoChips - (e.player.committedByStreet[args.street] ?? 0),
    }),
  );
  const joint = jointResponsesOf(responses);

  /*
   * 🔴 **条件范围**（§4/§5/§8）：加注只能拿「跟注范围」算权益。
   * 用 `limpResponseRangesOf` 切出每个 limp 的跟注/再加注范围，
   * 再交给权益引擎 —— 不自己写采样、不自己乘系数。
   */
  const chipsToCallOf = (player: PlayerState): number =>
    isoChips - (player.committedByStreet[args.street] ?? 0);
  const splits = inputs.map((e) =>
    limpResponseRangesOf({ limper: e.input, potAfterRaise, chipsToCall: chipsToCallOf(e.player) }),
  );
  const callRanges = inputs.map((e, i) => ({
    opponentId: e.player.id,
    range: (() => {
      const built = buildRangeFromRankClasses(splits[i]!.callWeights, {
        provenance: {
          ...PREFLOP_PRIOR_PROVENANCE,
          sourceId: 'heuristic.limp-call-conditional-range.v1',
          description:
            `${POSITION_ZH[e.player.position]} 跛入后面对隔离加注的**跟注条件范围**` +
            `（原型 ${LIMPER_ARCHETYPE_ZH[e.input.archetype]}；` +
            `${PREFLOP_PRIOR_PROVENANCE.description}）`,
        },
        deadCards: args.board,
        rangeIdPrefix: 'limp',
      });
      if (!built.ok) throw new Error(`limp-call 条件范围构建失败：${built.code}`);
      return built.value;
    })(),
  }));
  const equityVsCallers = (count: number): number | null =>
    computeHeroEquity(
      args.hero,
      args.board,
      callRanges.slice(0, count).map((r) => ({ opponentId: r.opponentId, range: r.range })),
      args.seed,
    ).value;

  const equityVsOneCaller = equityVsCallers(1);
  /*
   * 多人权益：只有 1 家 limp 时不存在「3 家跟注」分支，此时把 3 家权益取成
   * 1 家的值 —— 那一项的权重（`joint.threeCallers`）恒为 0，不会污染 EV。
   * 2 家 limp 时用**实测的 2 家权益**（模型对 2 家那档用的就是它）。
   */
  const equityVsMultiCallers =
    inputs.length >= 2 ? equityVsCallers(Math.min(3, inputs.length)) : equityVsOneCaller;

  const playersBehind = playersBehindRiskOf({
    behind: args.playersBehind.map((p) => ({
      position: p.position,
      archetype: args.limperInputOf(p).archetype,
      confidence: 0,
      effectiveStackBB: p.remainingStack / bb,
    })),
  });

  const isoEV = isoRaiseEVOf({
    potChips: args.pot,
    isoRaiseChips: isoChips,
    // 跟注者还要再投入的筹码（他们本街的 limp 已经在底池里）
    callerAddsChips:
      inputs.reduce((acc, e) => acc + (isoChips - (e.player.committedByStreet[args.street] ?? 0)), 0) /
      inputs.length,
    joint,
    equityVsOneCaller,
    equityVsThreeCallers: equityVsMultiCallers,
    equityVsReraise: null,
    playersBehind,
  });
  const isoAssumptions = Object.freeze([
    ...isoEV.assumptionsZh,
    ...(inputs.length === 2
      ? ['本节点只有 2 家 limp ⇒ 「3 家跟注」项由**实测的 2 家权益**代入（该档权重见 joint）']
      : []),
  ]);

  const perLimper = Object.freeze(
    inputs.map((e, i) => {
      const t = traits[i]!;
      const r = responses[i]!;
      const split = splits[i]!;
      return Object.freeze({
        positionZh: POSITION_ZH[e.player.position],
        archetypeZh: LIMPER_ARCHETYPE_ZH[e.input.archetype],
        arrivalWidth: limpArrivalRangeOf(e.input).width,
        foldProbability: r.foldProbability,
        callProbability: r.callProbability,
        reraiseProbability: r.reraiseProbability,
        priceRequiredEquity: r.priceRequiredEquity,
        confidence: e.input.confidence,
        noteZh:
          `${LIMPER_ARCHETYPE_ZH[e.input.archetype]}：宽度 ${t.width.toFixed(2)}｜` +
          `跟注/弃牌倾向 ${t.call.toFixed(2)}/${t.fold.toFixed(2)}｜再加注倾向 ${t.reraise.toFixed(2)}｜` +
          `条件范围占比 跟注 ${(split.callShare * 100).toFixed(1)}% / 再加注 ${(split.reraiseShare * 100).toFixed(1)}%`,
      });
    }),
  );

  return Object.freeze({
    limperCount: inputs.length,
    perLimper,
    joint,
    isoSize: Object.freeze({ ...size, legalIsoSize: isoChips / bb }),
    heroEquity: Object.freeze({
      vsArrival: args.equityVsArrival,
      vsOneCaller: equityVsOneCaller,
      vsThreeCallers: equityVsMultiCallers,
      vsReraise: null, // 被再加注按「不再继续」处理 ⇒ 不需要权益
    }),
    isoEV,
    callProxyEV: args.callProxyEV,
    callScope: 'VS_FOLD_ONLY' as const,
    playersBehind,
    rakeStatus: 'NOT_IMPLEMENTED' as const,
    modelConfidence: Math.max(
      0.2,
      Math.min(0.6, inputs.reduce((acc, e) => acc + e.input.confidence, 0) / inputs.length),
    ),
    assumptionsZh: Object.freeze([
      ...isoAssumptions,
      '各 limp 的响应**独立**假设（`HEURISTIC_INDEPENDENCE_ASSUMPTION`）—— 真实牌局里响应正相关，本模型未建模',
      'limp 到达范围 = 既有「无人加注宽范围」基线按「有效宽度^档位」衰减（不是实测频率）',
      '对 limp-call 条件范围的权益是**独立**算的：禁止拿「对到达范围的权益」证明隔离加注（§8）',
    ]),
    noteZh:
      `${inputs.length} 家 limp ⇒ 隔离加注 ${(isoChips / bb).toFixed(1)}BB（` +
      `${size.noteZh} ⇒ 落到合法网格 ${(isoChips / bb).toFixed(1)}BB）；` +
      `${joint.noteZh}｜${isoEV.noteZh}`,
  });
}

/**
 * 构建决策上下文。
 *
 * 返回 `context`（只读）+ `legal`（合法动作）+ `warnings`（降级说明）。
 *
 * ⚠️ 本函数**不做**「该不该跟注」的判断。它只保证
 * 「决策层需要的每一项数据都在这里，且来源可追溯」。
 */
export function buildDecisionContext(input: ContextBuildInput): ContextBuildResult {
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const warnings: string[] = [];

  const state = input.state;
  const hero = heroPlayer(state);
  if (hero === null) {
    throw new Error('buildDecisionContext: 找不到 Hero 玩家（userPlayerId 缺失或无效）');
  }

  assertBoardVisibility(state);

  const mark = <T>(key: string, fn: () => T): T => {
    const t0 = Date.now();
    try {
      return fn();
    } finally {
      timings[key] = (timings[key] ?? 0) + (Date.now() - t0);
    }
  };

  /* ---- 1. 对手 ---- */
  const opponents = state.players.filter((p) => p.id !== hero.id && !p.folded);

  /*
   * 🔴 **已实现 vs 还没说话**（Table Topology Correction）
   *
   * 判据由领域层给出（`realizedOpponentIds` / `yetToActIds`），
   * **本模块不自己实现一份** —— `tablePreview` 要用同一个判据去
   * 提前告知「点分析会不会返回信息不足」，两份实现迟早分歧，
   * 而分歧的表现形式是「界面说可以分析、引擎说信息不足」。
   *
   * 边界说明见 `gameState.ts` 的 `realizedOpponentIds`：
   * 盲注不算（强制投入）、CHECK 算（说过话了）、全下一定算。
   */
  const realizedIds = realizedOpponentIds(state);
  const yetToActAll = yetToActIds(state);
  const realizedOpponents = opponents.filter((p) => realizedIds.has(p.id));
  const playersYetToAct = opponents.filter((p) => yetToActAll.has(p.id));

  /* ---- 2. 合法动作 ---- */
  const legal = mark('legal', () => deriveLegalActions(state, hero));

  /* ---- 3. 范围 ----
   *
   * 🔴 **逐对手建范围，不只建首要对手的那一个。**
   *
   * 修复前这里只有 `primaryOpponent`，于是权益是**单挑口径**：
   * 5 家进池时底池赔率按 5 家算、权益却按 1 家算，系统性偏乐观，
   * 决策层只能在 ≥3 家时**拒绝给建议**。
   *
   * 权益引擎本来就支持多人（`computeEquity` 的 `opponents` 是列表），
   * 范围构建函数 `buildRangeSnapshot` 也本来就是**逐对手**的 ——
   * 缺的只是「把已实现的对手都建一遍」这一步。
   *
   * ⚠️ 只对**已实现**的对手建范围（真的投入过 / 全下 / 说过话）。
   * 还没轮到说话的对手**没有**可信范围：替他假设一个范围
   * 等于凭空造数据，而他们的情况由 `playersYetToAct` 如实提示。
   */
  const deadCards: Card[] = [...(hero.holeCards ?? []), ...allBoardCards(state)];

  /*
   * ---- 3·0. RIVER BET RANGE V2：定位「当前正在被建模的那一次下注」----
   *
   * ## 为什么必须有这一步
   *
   * `applyLikelihoodUpdates` 会把**每一个**进攻动作当似然乘进范围 ——
   * 包括**当前这一次下注**。于是返回的 `range` 已经是
   * `P(手牌 | 他已经下注)`；而 `bettingRange.ts` 又要乘一次 `P(BET | 手牌)`
   * ⇒ **同一条动作的似然被计了两次**（实测把下注范围权益从 7.6% 压到 0.54%）。
   *
   * ## 单一、可追踪的路径
   *
   * ```text
   * ① 到达范围    = 本链在「当前下注」之前的状态          ← 本函数捕获（零额外计算）
   * ② 下注范围    = ① × P(BET | 公共强度带, 尺寸, 牌面, 画像)   ← 当前下注只在这里计一次
   * ③ range（默认）= ① × P(当前下注 | 手牌)               ← 原有语义，供整体范围口径使用
   * ```
   *
   * ⚠️ 只跳过**这一条**记录：翻牌跟注、转牌跟注与更早的进攻动作照旧施加似然。
   * 判据是「本街最后一个进攻动作」——也就是 `state.currentBet` 的来源那一条。
   */
  const currentBetRecord = (():
    { index: number; actorId: string; position: PlayerState['position'] } | null => {
    for (let i = state.actions.length - 1; i >= 0; i -= 1) {
      const record = state.actions[i]!;
      if (record.street !== state.street) continue;
      if (
        record.type === ActionType.BET ||
        record.type === ActionType.RAISE ||
        record.type === ActionType.RERAISE ||
        record.type === ActionType.ALL_IN
      ) {
        return { index: i, actorId: record.playerId, position: record.position };
      }
    }
    return null;
  })();

  /*
   * ---- 3a. 玩家画像（**必须在建范围之前**）----
   *
   * 🔴 P0 架构修复：修复前画像在第 6 步才算，**结构上不可能**进入范围 ——
   * 那正是「画像只在决策末端当偏好修正」的一半根因。
   * 现在它前移到这里，并由 `createTendencyProvider` 注入动作似然通道，
   * 于是 posterior ∝ prior × likelihood × profile × observation，
   * 权益 / 底池赔率 / Call EV / 动作排名**全部自动跟着变**。
   *
   * ⚠️ 只对**画像描述的那个对手**（`villainId`）注入：给其他对手套一个
   * 画像就是编造数据。
   */
  const villainId =
    input.villainPlayerId ?? realizedOpponents[0]?.id ?? opponents[0]?.id ?? 'villain';

  /*
   * 🔴 **行为画像必须在生产路径上真的被构造出来**
   * （PLAYER PROFILE QUANTIFICATION V1 · §二十五/§二十六）。
   *
   * ## 为什么不能只认显式传入的 `input.behaviorProfile`
   *
   * `behaviorProfileOf` 在修复前**没有任何生产调用者** —— 画像量化模型
   * （`behaviorProfile.ts`）虽然完整且单测全绿，却是一座孤岛，
   * 这正是 `PROFILE_RANGE_INFLUENCE_TOO_WEAK` 的根因。
   * 只认显式字段等于把这个孤儿状态**原样搬到上一层**：
   * 界面与 `/api/analyze` 只设置 `quickProfile`，于是新似然永不触发。
   *
   * 因此：**没有显式画像时，用 `quickProfile` 标签推一个**。
   * `behaviorProfileOf` 的四级来源（实测 > 人工 > 标签先验 > 池先验）
   * 保证这一步是「有依据的先验」，不是编造。
   *
   * ## ⚠️ UNKNOWN 必须排除
   *
   * `quickProfile === 'UNKNOWN'` 在本文件里**本来就等于「没有可用的读」**
   * （见 `buildPlayerSnapshot`：它走 `NO_DATA_NEUTRAL` 并标 `neutralized`）。
   * 为它推一个纯池先验画像会凭空改变范围 —— 那是「替陌生人套一个原型」，
   * 正是本项目明令禁止的编造数据。因此 UNKNOWN 与**根本没有画像**一样，
   * 保持既有档位似然路径（逐位不变）。
   */
  const behaviorProfile: PlayerBehaviorProfile | undefined =
    input.behaviorProfile ??
    (input.quickProfile !== undefined && input.quickProfile !== 'UNKNOWN'
      ? behaviorProfileOf({
          playerId: villainId,
          archetype: input.quickProfile as QuickProfile,
        })
      : undefined);

  /*
   * 跛入原型：只有画像描述的那一家带画像可信度，其余 = 人群先验（可信度 0 ⇒
   * `effectiveTraits` 自动回落到 POPULATION，不编造画像）。
   */
  const profileArchetype = quickProfileToLimperArchetype(input.quickProfile);
  const limpProfileFor = (
    playerId: string,
  ): { archetype: LimperArchetype; confidence: number } => ({
    archetype: playerId === villainId ? profileArchetype : LimperArchetype.POPULATION,
    confidence: playerId === villainId ? playerBuilt.confidence : 0,
  });
  const playerBuilt = mark('player', () =>
    buildPlayerSnapshot(
      villainId,
      input.villainProfile,
      input.quickProfile,
      input.dynamicHint,
      (street) => boardAtStreetOf(state, street),
    ),
  );


  const allRangeBuilds = mark('range', () =>
    realizedOpponents.map((opponent) => ({
      opponentId: opponent.id,
      build: buildRangeSnapshot(
        state,
        opponent,
        deadCards,
        input.solverRanges?.[opponent.id],
        opponent.id === villainId ? playerBuilt.tendency : null,
        limpProfileFor(opponent.id),
        // 画像只对**它描述的那一家**注入（给别的座位套画像就是编造数据）
        opponent.id === villainId ? (behaviorProfile ?? null) : null,
        /*
         * 🔴 **只有「正在下注的那一家」需要捕获到达范围**：
         * 其余对手没有「当前这一次下注」可言，他们的范围语义逐位不变。
         */
        currentBetRecord !== null && currentBetRecord.actorId === opponent.id
          ? currentBetRecord.index
          : undefined,
      ),
    })),
  );
  for (const entry of allRangeBuilds) warnings.push(...entry.build.warnings);

  const usableRangeBuilds = allRangeBuilds.filter((entry) => entry.build.range !== null);

  /** 首要对手（用于展示与玩家画像）—— 与 `realizedOpponents[0]` 一致 */
  const primaryOpponent = realizedOpponents[0] ?? opponents[0] ?? null;
  const primaryBuild =
    allRangeBuilds.find((entry) => entry.opponentId === primaryOpponent?.id)?.build ??
    (primaryOpponent !== null
      ? buildRangeSnapshot(
          state,
          primaryOpponent,
          deadCards,
          undefined,
          primaryOpponent.id === villainId ? playerBuilt.tendency : null,
          limpProfileFor(primaryOpponent.id),
          primaryOpponent.id === villainId ? (behaviorProfile ?? null) : null,
          currentBetRecord !== null && currentBetRecord.actorId === primaryOpponent.id
            ? currentBetRecord.index
            : undefined,
        )
      : { snapshot: null, range: null, warnings: [] as string[], tendency: null, rangeBeforeAction: null });
  const rangeBuild = primaryBuild;

  /* ---- 4. 权益（**多人口径**）---- */
  const equity = mark('equity', () =>
    computeHeroEquity(
      hero,
      allBoardCards(state),
      usableRangeBuilds.map((entry) => ({ opponentId: entry.opponentId, range: entry.build.range! })),
      input.equitySeed ?? 20260913,
    ),
  );
  if (equity.warning !== null) warnings.push(equity.warning);

  /* ---- 4a. PLAYER PROFILE V3：标签 Prior + 实测连续统计 ⇒ 分街画像 ---- */
  /*
   * 🔴 **算一次、用多处**：同一个解析结果既进响应层（分街系数），
   * 又进 `context.profileV3`（诊断 / Profile Trace）。
   * 两处各算一次必然有一天分歧（本项目反复踩过的「两处口径」）。
   *
   * ⚠️ 没有连续统计时仍然会构造 `resolvedV3`，但所有维度 = 0.5、
   * 所有分街系数 = 1 ⇒ 下游**逐位**与 V2 一致（`resolvePlayerProfile` 的恒等性）。
   */
  const observedForPrimary = input.observedStats ?? null;
  const opportunitiesForPrimary = (() => {
    const profile = input.villainProfile;
    if (profile === null || profile === undefined) return null;
    const metrics = (profile as unknown as { metrics?: Record<string, { opportunities?: number }> })
      .metrics;
    if (metrics === undefined) return null;
    /*
     * `PlayerProfile` 的指标名与 V3 的统计键**刻意对齐**（VPIP / PFR / THREE_BET…），
     * 这样不需要再维护一张映射表。只有「确实存在」的项才作为机会数传入，
     * 其余保持 null（走「手数 × 频率」近似）。
     */
    const map: Record<string, number | null> = {};
    for (const [v3Key, metricKey] of [
      ['vpip', 'VPIP'], ['pfr', 'PFR'], ['threeBet', 'THREE_BET'],
      ['wtsd', 'RIVER_SHOWDOWN'], ['foldToFlopCBet', 'FOLD_TO_CBET'],
      ['foldToTurnCBet', 'TURN_FOLD'], ['foldToRiverBet', 'RIVER_FOLD'],
      ['flopCheckRaise', 'CHECK_RAISE_FLOP'], ['turnCheckRaise', 'TURN_CHECK_RAISE'],
      ['riverCheckRaise', 'RIVER_RAISE'],
    ] as const) {
      const m = metrics[metricKey];
      map[v3Key] = m?.opportunities === undefined ? null : Number(m.opportunities);
    }
    return map;
  })();
  /* 当前街（由公共牌张数判定）—— 必须在 profile 解析**之前**算好：
   * 分街统计要按各自街做语义门匹配（TEST 09）。 */
  const boardNow = allBoardCards(state).length;
  const streetOfNow: 'FLOP' | 'TURN' | 'RIVER' =
    boardNow >= 5 ? 'RIVER' : boardNow === 4 ? 'TURN' : 'FLOP';
  const resolvedV3 = resolvePlayerProfile({
    baseArchetype: (input.quickProfile ?? null) as never,
    observedStats: observedForPrimary,
    opportunities: opportunitiesForPrimary as never,
    actionContext: nodeActionContextOf(state, hero, primaryOpponent),
    street: streetOfNow,
  });
  const v3StreetInput = {
    street: streetOfNow,
    factors: resolvedV3.resolved.street[streetOfNow],
  };

  /* ---- 4b. 分层权益（**只有「门槛不适用」才跑**）---- */
  /*
   * 🔴 放在基础权益**之后**、数学快照**之前**，且单独计时。
   *
   * `computeLayeredEquity` 的第一步就是 `previewCommit(...)`：只要
   * `singleThresholdApplies === true`（我只有一层，或层界非结构性）
   * 就立刻返回 `undefined`，**不做任何计算** —— 因此那些局面的行为与耗时
   * 逐位不变（含全部黄金局面）。
   *
   * 结构性多层时它逐层再算一次权益，实测额外 **110–1030 ms**（2 层 ≈ 110–220、
   * 7 层 ≈ 610–1030），记在 `timings.layeredEquity` 里。预留按**层数**算
   *（见 `shouldSpendOnLayeredEquity`），因此它不可能把整条分析拖成硬超时。
   */
  const plannedLayeredCount = previewCommit(state, hero.id, requiredCallAmount(state, hero.id))
    .layersForPlayer.length;
  const layeredEV = mark('layeredEquity', () =>
    shouldSpendOnLayeredEquity(input, plannedLayeredCount) === false
      ? undefined
      : computeLayeredEquity(
          state,
          hero,
          allBoardCards(state),
          requiredCallAmount(state, hero.id),
          usableRangeBuilds.map((entry) => ({
            opponentId: entry.opponentId,
            range: entry.build.range!,
          })),
          input.equitySeed ?? 20260913,
        ),
  );

  /* ---- 4c. BETTING RANGE（TEST 09 P0-1；RIVER BET RANGE V2 修正）---- */
  /*
   * 🔴 面对 Villain **已经下注**的节点，`CALL EV` 必须用
   * 「Hero vs 他的**下注范围**」的权益，而不是「vs 他的**到达范围**」。
   *
   * 到达范围里有一大半是根本不会下注的牌（中对、底对、错失听牌）；
   * 拿它们摊牌等于假设他会用这些牌主动打光全部筹码 —— 他的下注范围
   * 远比到达范围**偏价值**，所以真实权益**更低**，`CALL EV` 被系统性高估。
   *
   * ## 🔴 RIVER BET RANGE V2：原料必须是**真正的到达范围**
   *
   * `primaryBuild.range` 已经含**当前这一次下注**的似然（见 3·0 的说明），
   * 拿它再乘 `P(BET | 手牌)` 会把同一条动作计两次费。
   * 因此这里改用 `primaryBuild.rangeBeforeAction` —— 同一次范围更新链里
   * 「当前下注之前」的那份状态（**零额外计算**，只是引用捕获）：
   *
   * ```text
   * 到达范围 → × P(BET | 公共强度带, 尺寸, 牌面, 画像) → 下注范围   ← 本模块
   * ```
   *
   * 捕获拿不到（不是「他在下注」的节点，或求解器范围路径）时**如实回落到
   * 默认范围并写警告**，绝不静默换口径。
   */
  const betRangeArrivalRange = primaryBuild.rangeBeforeAction ?? null;
  const bettingRangeFacts = mark('bettingRange', () => {
    const bettorPosition = lastAggressorOfStreet(state.actions, state.street);
    const primaryPosition = primaryOpponent === null ? null : primaryOpponent.position;
    if (bettorPosition === null || primaryPosition === null) return null;
    /*
     * 只有「首要对手正在下注」时才有下注范围可言。
     * Hero 自己下注时，该量是「Hero 的下注范围」——不是本模块的对象。
     */
    if (bettorPosition !== primaryPosition) return null;
    const arrivalRange = betRangeArrivalRange ?? primaryBuild.range;
    if (arrivalRange === null || hero.holeCards === null || hero.holeCards.length !== 2) {
      return null;
    }
    if (betRangeArrivalRange === null) {
      /*
       * 兜底路径：拿不到「当前下注之前」的状态 ⇒ 到达范围里已经含这次下注，
       * 乘权重会让它计两次。**必须可见**，不允许静默降级。
       */
      warnings.push(
        '下注范围：未能捕获「当前下注之前」的到达范围，已回落到完整范围 ' +
          '（该范围已含本次下注的似然 ⇒ 权重可能被重复施加）。',
      );
    }
    const betChips = state.currentBet;
    if (!(betChips > 0)) return null;
    const potBeforeBet = Math.max(0, computePot(state) - betChips);
    if (!(potBeforeBet > 0)) return null;
    const ownDimensions =
      playerBuilt.tendency === null ? null : playerBuilt.tendency.dimension.dimensions;
    const tendencies = responseTendenciesOf(
      ownDimensions,
      playerBuilt.tendency === null ? 0 : playerBuilt.confidence,
      v3StreetInput,
    );
    return buildBettingRangeFacts({
      arrivalEntries: arrivalRange.entries.map((e) => ({
        cardIndices: e.combo.cardIndices as unknown as readonly [number, number],
        probability: e.probability,
      })),
      board: allBoardCards(state),
      heroHole: hero.holeCards,
      potChips: potBeforeBet,
      betChips,
      street: streetOfNow,
      tendencies,
      ...(input.betRangeBluffShareOverride !== undefined
        ? { bluffShareOverride: input.betRangeBluffShareOverride }
        : {}),
    });
  });
  const heroEquityVsBetRange =
    bettingRangeFacts === null
      ? null
      : rangeEquityOfMany(
          hero.holeCards ?? [],
          allBoardCards(state),
          [bettingRangeFacts.entries],
          (input.equitySeed ?? 20260913) + 1301,
        ).value;

  /* ---- 4d. RAISE RESPONSE（U1：补上加注 EV）---- */
  /*
   * 🔴 **补上「面对加注的响应」**（`reports/UNCERTAINTY_REGISTER.md` 的 U1）。
   *
   * 在它之前 `RAISE` 在全项目里没有任何筹码 EV：`EqVsRaiseContinueRange = NOT_IMPLEMENTED`，
   * 「加注是否比跟注好」无法被计算 —— 只能靠启发式，而启发式在河牌把一对牌推成全下。
   *
   * ## 算的是哪一个尺寸
   *
   * 与决策层**同一个选择规则**：`desiredTo = pot + 2×callCost`，
   * 在 `buildSizeGrid(legal, pot, 'RAISE')` 里取最接近的候选（共用 `closestSizeTo`）。
   * 决策层只有在「它选中的尺寸就是这个尺寸」时才允许使用该 EV（同 `isoUsable` 的纪律）。
   *
   * ## 零点与下界
   *
   * 零点 = 弃牌（≡ 0），与 `callEV` 同一比较零点。
   * 再加注分支没有模型（产品无再加注树）⇒ 按「Hero 放弃本次增量」计入 ⇒ 得到**下界**，
   * 在 `evKind = MODEL_EV_WITH_LOWER_BOUND_RERAISE_BRANCH` 里如实标注。
   */
  const raiseResponseFacts = mark('raiseResponse', (): NonNullable<PostflopFacts['raiseResponse']> | null => {
    /*
     * 🔴🔴 **U1 P0 修复 · 多人底池必须显式拦截**（放在最前面：无论后面因为什么回落，
     * 这条「为什么没有加注 EV」的原因都必须说出去）。
     *
     * U1 的响应模型只针对**一个**对手（`primaryOpponent`）的下注范围建模：
     * 它没有建模「身后还有别人可能跟注/再加注」。两个以上活跃对手时
     * 按单挑口径算 RAISE EV 是**错的**（会系统性高估加注），
     * 因此这里**明确不产出**加注 EV，并把原因写进 warnings ——
     * 而不是悄悄按单挑算一个数字。决策层随后会把所有加注金额
     * 如实列进「未评估动作」（`RAISE_EV_NOT_IMPLEMENTED`）。
     */
    const activeOpponents = state.players.filter((p) => p.id !== hero.id && !p.folded);
    if (activeOpponents.length !== 1) {
      warnings.push(
        `加注 EV 不适用：本节点有 ${activeOpponents.length} 个活跃对手，` +
          '而「面对加注的响应模型」只按**单挑**口径建模（未建模身后玩家的跟注/再加注）' +
          '⇒ 所有加注金额一律计入「未评估动作」，不参与 EV 比较。',
      );
      return null;
    }
    if (bettingRangeFacts === null) return null;
    if (hero.holeCards === null || hero.holeCards.length !== 2) return null;
    const opponent = activeOpponents[0]!;
    const villainStreetCommitted = committedThisStreet(state, opponent.id);
    const heroStreetCommitted = committedThisStreet(state, hero.id);
    const currentPot = computePot(state);
    /** Hero 还需补多少才跟平（= 引擎的 `requiredCallAmount`） */
    const heroCallCost = Math.max(0, state.currentBet - heroStreetCommitted);
    if (!(state.currentBet > 0)) return null;
    if (!(currentPot > 0)) return null;
    /*
     * 🔴 **与决策层完全同一个尺寸选择**（U1 P0 修复 · D2）：
     *
     * 决策层：`buildSizeGrid(legal, math.pot, 'RAISE')` + `desiredTo = math.pot + 2×math.callCost`。
     * 修复前本处用 `potBeforeBet` 与 `betChips = currentBet` —— Hero 本街已有投入时
     * （`callCost = currentBet − heroStreetCommitted`）两层目标尺寸会相差 `2×本街已投`，
     * 于是尺寸对不上、`raiseModelUsable = false`：加注 EV **被静默关闭**。
     * 现在两处使用同一个底池基准与同一个目标式。
     */
    const grid = buildSizeGrid(legal, currentPot, 'RAISE');
    if (grid.length === 0) return null;
    const desiredTo = currentPot + 2 * heroCallCost;
    const chosen = closestSizeTo(grid, desiredTo, (o) => o.toAmount);
    if (chosen === null) return null;
    const raiseTo = chosen.toAmount;
    /*
     * ---- 资金记账（唯一事实来源）----
     *
     * heroAdd     = 我这次加注真正新增的筹码（不重复扣我本街已投的部分）
     * villainAdd  = 对手跟平还差多少，**按他实际能投的封顶**（短筹码/全下）
     * 终池        = 双方都投入后**我能争夺到**的底池
     *
     * ⚠️ 为什么不能直接用 `previewCommit(state, hero, heroAdd)`：
     * 它把「我投入 heroAdd」记进去时**对手还没跟注**，于是我未被跟注的部分
     * 会被整块算成退回（实测 HAND A 会得到 `winnable = 134`、`heroContestedAdd < 0`）。
     * 这里按「双方都投入」的直接口径算：
     *
     * ```text
     * 他跟平后的本街总额 = villainStreetCommitted + villainAdd
     * 我真正留在池中      = min(heroAdd, 他跟平后的本街总额 − 我本街已投)
     * 终点底池            = currentPot + 我留在池中的 + 他补的
     * ```
     *
     * 三种情形都对：
     * · 双方都跟得满 ⇒ 终池 = currentPot + heroAdd + villainAdd（使用者给的恒等式）；
     * · 他筹码不足   ⇒ 只算他跟得起的部分，我的超额**退回**（不计入投入）；
     * · 我本街已投>0 ⇒ 不重复扣那部分（`heroAdd = raiseTo − 我本街已投`）。
     */
    const heroAdd = Math.max(0, raiseTo - heroStreetCommitted);
    if (!(heroAdd > 0)) return null;
    const villainAddRaw = Math.max(0, raiseTo - villainStreetCommitted);
    const villainAdd = Math.min(villainAddRaw, Math.max(0, opponent.remainingStack));
    if (!(villainAdd > 0)) return null;
    /*
     * 🔴 **P1-2a：他跟平即投光** ⇒ 他**不可能**再有再加注分支。
     *
     * 判据必须看**他投完之后还剩多少**（`remainingStack − villainAdd` 是否为 0），
     * 而**不是**看「封顶有没有生效」：
     *
     * | 情形 | `villainAddRaw` vs 剩余 | 封顶生效？ | 他跟完还剩 | 应该算全下吗 |
     * |---|---|---|---|---|
     * | 他补得起 | raw < 剩余 | 否 | > 0 | ❌ 不是 |
     * | **恰好用光** | **raw == 剩余** | **否（相等不触发 min）** | **0** | ✅ **是**（边界！） |
     * | 补不起 | raw > 剩余 | 是 | 0 | ✅ 是 |
     *
     * ⚠️ 只用「`villainAdd < villainAddRaw`」会把**中间那一行**漏掉 ——
     * 本仓库的边界场景 G 正是这一行（它当时仍错误地给出了 17.69% 的再加注分支）。
     */
    const villainIsAllInByCall = opponent.remainingStack <= villainAdd + 1e-9;
    const villainStreetTotalAfterCall = villainStreetCommitted + villainAdd;
    const heroContestedAdd = Math.max(
      0,
      Math.min(heroAdd, villainStreetTotalAfterCall - heroStreetCommitted),
    );
    if (!(heroContestedAdd > 0)) return null;
    const finalPot = currentPot + heroContestedAdd + villainAdd;
    const ownDimensions =
      playerBuilt.tendency === null ? null : playerBuilt.tendency.dimension.dimensions;
    const tendencies = responseTendenciesOf(
      ownDimensions,
      playerBuilt.tendency === null ? 0 : playerBuilt.confidence,
      v3StreetInput,
    );
    const built = buildRaiseResponse({
      betRangeEntries: bettingRangeFacts.entries,
      board: allBoardCards(state),
      currentPot,
      heroAdd,
      villainAdd,
      heroContestedAdd,
      finalPot,
      street: streetOfNow,
      tendencies,
      heroIsAllIn: raiseTo >= legal.allInToAmount - 1e-9,
      /* 🔴 P1-2a：他跟平即投光 ⇒ 不得生成再加注分支（判据只看**他的**筹码） */
      villainIsAllInByCall,
    });
    if (built === null) return null;
    const eqVsCall = rangeEquityOf(
      hero.holeCards,
      allBoardCards(state),
      built.callContinueEntries,
      (input.equitySeed ?? 20260913) + 1601,
    );
    /* ============================================================
     * 🔴 **P1-2b：被再加注后的 Hero 决策（FOLD / CALL 两选一）**
     * ============================================================
     *
     * ## 零点统一（这一条最关键）
     *
     * 三个分支**必须**都以**首次加注前的决策节点**为零点：
     *
     * ```text
     * foldBranchEV = −heroContestedAdd                       （放弃本次加注投入）
     * callBranchEV = EqVsReraise × 跟注后终池 − heroContestedAdd − 我需再投
     * reraiseBranchEV = max(foldBranchEV, callBranchEV)
     * ```
     *
     * ⚠️ 绝不能把「后续节点的局部 EV」直接与前两项比较 —— 那会混用起点
     *（U1 的 P0 就是这一类口径错误）。
     *
     * ## 再加注尺寸：**从真实行动状态推导**，不用固定倍数
     *
     * `minReRaiseTo = raiseTo + (raiseTo − villainStreetCommitted)`（引擎的最小加注规则）；
     * 他买不起完整再加注时只能**全下（under-raise）** —— 那条法律上仍有效；
     * 连全下都超不过我的总额 ⇒ 他根本不能加注（`rr` 已由 P1-2a 归零）。
     */
    const reRaiseFacts = (() => {
      if (built.reRaiseLikelihood <= 0 || built.reRaiseEntries.length === 0) return null;
      const minReRaiseTo = raiseTo + (raiseTo - villainStreetCommitted);
      const villainMaxTo = villainStreetTotalAfterCall + Math.max(0, opponent.remainingStack - villainAdd);
      const reRaiseTo = Math.min(minReRaiseTo, villainMaxTo);
      if (!(reRaiseTo > raiseTo + 1e-9)) return null;
      /** 他这次再加注是否把他的筹码全部投入（⇒ Hero 没有再加注的余地） */
      const villainReRaiseIsAllIn = reRaiseTo >= villainMaxTo - 1e-9;
      const heroRemainingAfterRaise = Math.max(0, legal.myRemainingStack - heroAdd);
      const additionalCall = Math.min(reRaiseTo - raiseTo, heroRemainingAfterRaise);
      if (!(additionalCall > 0)) return null;
      /*
       * 用**引擎自己的**动作与分层底池算后续资金：
       * Hero 加注 → 他再加注 → Hero 跟注 ⇒ 我能争夺到的量（与 CALL EV 同一口径）。
       */
      const afterRaise = applyAction(state, { playerId: hero.id, type: 'RAISE', amount: raiseTo } as never);
      if (!afterRaise.ok) return null;
      const afterReRaise = applyAction(afterRaise.state, {
        playerId: opponent.id, type: 'RAISE', amount: reRaiseTo,
      } as never);
      if (!afterReRaise.ok) return null;
      const finalPotAfterCall = previewCommit(afterReRaise.state, hero.id, additionalCall).winnable;
      if (!(finalPotAfterCall > 0)) return null;
      return { minReRaiseTo, villainMaxTo, reRaiseTo, villainReRaiseIsAllIn, additionalCall, finalPotAfterCall };
    })();
    const eqVsReraise: { value: number | null } = reRaiseFacts === null
      ? { value: null }
      : rangeEquityOf(hero.holeCards, allBoardCards(state), built.reRaiseEntries, (input.equitySeed ?? 20260913) + 2601);
    /*
     * 分支值：拿得到再加注范围与资金 ⇒ 用 `max(弃牌, 跟注)`；
     * 拿不到 ⇒ **退回下界** `−heroContestedAdd` 并如实标注（绝不编造跟注 EV）。
     */
    const reraiseBranchEV = reRaiseFacts !== null && eqVsReraise.value !== null
      ? Math.max(
          -heroContestedAdd,
          eqVsReraise.value * reRaiseFacts.finalPotAfterCall - heroContestedAdd - reRaiseFacts.additionalCall,
        )
      : -heroContestedAdd;
    const reraiseBranchKind: 'FOLD' | 'CALL' | 'LOWER_BOUND_NOT_IMPLEMENTED' =
      reRaiseFacts === null || eqVsReraise.value === null
        ? 'LOWER_BOUND_NOT_IMPLEMENTED'
        : reraiseBranchEV > -heroContestedAdd + 1e-9 ? 'CALL' : 'FOLD';
    const raiseEV =
      eqVsCall.value === null
        ? null
        : raiseEVOf({
            foldLikelihood: built.foldLikelihood,
            callLikelihood: built.callLikelihood,
            reRaiseLikelihood: built.reRaiseLikelihood,
            currentPot,
            heroContestedAdd,
            finalPot,
            equityVsRaiseCall: eqVsCall.value,
            reraiseBranchEV,
          });
    return Object.freeze({
      sizeChips: raiseTo,
      sizeBB: raiseTo / state.config.bigBlind,
      raiseIncrement: villainAdd,
      /* 🔴 U1 P0：完整资金口径随事实包一起带出去（决策层/诊断/测试都读它） */
      cashflowContract: CASHFLOW_CONTRACT,
      currentPot,
      heroStreetCommitted,
      villainStreetCommitted,
      heroAdd,
      villainAdd,
      villainAddRaw,
      /** 🔴 P1-2a：他跟平即投光（真 ⇒ 模型不会给出再加注分支） */
      villainIsAllInByCall,
      heroContestedAdd,
      finalPot,
      uncalledReturn: Math.max(0, heroAdd - heroContestedAdd),
      /* 🔴 P1-2b：被再加注分支（零点与其它分支一致） */
      reraiseBranchEV,
      reraiseBranchKind,
      /** 弃牌分支（= −留在池中的投入）与跟注分支，供独立复算与审计 */
      reraiseFoldBranchEV: -heroContestedAdd,
      reraiseCallBranchEV: reRaiseFacts !== null && eqVsReraise.value !== null
        ? eqVsReraise.value * reRaiseFacts.finalPotAfterCall - heroContestedAdd - reRaiseFacts.additionalCall
        : null,
      heroEquityVsReraiseRange: eqVsReraise.value,
      reraiseBranchUnsupportedZh: reraiseBranchKind === 'LOWER_BOUND_NOT_IMPLEMENTED'
        ? (built.reRaiseLikelihood <= 0
            ? null
            : '再加注分支不可计算（缺再加注范围或权益）⇒ 该分支按**下界**（损失本次投入）计入')
        : null,
      ...(reRaiseFacts === null
        ? {
            reRaiseCombos: built.reRaiseCombos,
            /* `null` = **不适用**（本节点根本没有再加注分支）—— 与「不支持（false）」是两件事 */
            heroFourBetSupported: null as boolean | null,
          }
        : {
            reRaiseCombos: built.reRaiseCombos,
            reRaiseTo: reRaiseFacts.reRaiseTo,
            reRaiseMinLegalTo: reRaiseFacts.minReRaiseTo,
            villainReRaiseIsAllIn: reRaiseFacts.villainReRaiseIsAllIn,
            heroAdditionalCallVsReRaise: reRaiseFacts.additionalCall,
            finalPotAfterCallVsReRaise: reRaiseFacts.finalPotAfterCall,
            /* 他的再加注若不是全下 ⇒ Hero 还有再加注（4-bet）选项 —— **本模型不支持** */
            heroFourBetSupported: reRaiseFacts.villainReRaiseIsAllIn,
          }),
      foldLikelihood: built.foldLikelihood,
      callLikelihood: built.callLikelihood,
      reRaiseLikelihood: built.reRaiseLikelihood,
      heroEquityVsRaiseCallRange: eqVsCall.value,
      equityMethod: eqVsCall.method,
      equityIterations: eqVsCall.iterations,
      raiseEV,
      evKind: 'MODEL_EV_WITH_LOWER_BOUND_RERAISE_BRANCH' as const,
      reachableCombos: built.reachableCombos,
      callCombos: built.callCombos,
      model: built.model,
      assumptionsZh: Object.freeze([
        '面对加注的响应是**结构性先验**（公共强度带 + 听牌 + 价格 + 画像），未经统计校准',
        '零点 = 弃牌 ≡ 0（与 CALL EV 同一口径：底池含对手已下注的筹码、投入只算我自己新增的）',
        '对手弃牌 ⇒ 我赢下完整底池 currentPot；他跟注 ⇒ 终池 finalPot（引擎分层口径，含退回修正）',
        '再加注分支没有模型 ⇒ 按「Hero 放弃本次投入」计入 = **下界**；' +
          '⚠️ `heroIsAllIn`（我不能再加注）与 `villainIsAllInByCall`（他跟平即投光、他不能再加注）是**两个独立判据**，' +
          '任一为真都不产出再加注分支',
        '再加注分支没有模型 ⇒ 按「Hero 放弃本次投入」计入 = **下界**',
        '未计抽水（本项目无 Rake Engine）',
      ]),
      noteZh:
        built.noteZh +
        `｜加注到 ${raiseTo}（我方新增 ${heroAdd}${heroAdd === heroContestedAdd ? '' : `，其中被跟注 ${heroContestedAdd}、退回 ${heroAdd - heroContestedAdd}`}` +
        `，对手补 ${villainAdd}${villainIsAllInByCall ? '（**他跟平即全下** ⇒ 不会再有再加注分支）' : ''}，终池 ${finalPot}）⇒ ` +
        (raiseEV === null
          ? 'RAISE EV 不可算（跟注桶权益不可得）'
          : `RAISE EV = ${built.foldLikelihood.toFixed(4)}×${currentPot} + ` +
            `${built.callLikelihood.toFixed(4)}×(${(eqVsCall.value ?? 0).toFixed(4)}×${finalPot} − ${heroContestedAdd}) + ` +
            `${built.reRaiseLikelihood.toFixed(4)}×(−${heroContestedAdd}) = **${raiseEV.toFixed(4)}**` +
            '（⚠️ 再加注分支无模型 ⇒ **下界**）'),
    });
  });

  /*
   * 🔴 **到达范围自己的权益**（RIVER BET RANGE V2 · 数据一致性）。
   *
   * 修复前 `math.heroEquity` 被界面/审计读成 `EqVsArrivalRange`，
   * 但它其实是「链上含当前下注」的那份范围的权益 —— 名实不符。
   * 现在到达范围有了**明确的对象**（`betRangeArrivalRange`）与**它自己的权益**，
   * 两者再也不会被混为一谈：
   *
   * | 量 | 回答 |
   * |---|---|
   * | `betRangeArrival.heroEquityVsArrivalRange` | 他**到达**这个节点时我领先多少 |
   * | `math.heroEquityVsBetRange` | 他**选择下注**时我领先多少（CALL EV 用它） |
   * | `math.heroEquity` | 对「含本街全部动作」的整体范围的权益（决策层既有口径） |
   *
   * 用与下注范围**同一个种子偏移**（`+1301`）计算，两个条件权益可直接比较。
   */
  const heroEquityVsArrivalRange =
    betRangeArrivalRange === null || hero.holeCards === null || hero.holeCards.length !== 2
      ? null
      : rangeEquityOfMany(
          hero.holeCards,
          allBoardCards(state),
          [
            betRangeArrivalRange.entries.map((e) => ({
              cardIndices: e.combo.cardIndices as unknown as readonly [number, number],
              probability: e.probability,
            })),
          ],
          (input.equitySeed ?? 20260913) + 1301,
        ).value;

  /* ---- 5. 数学 ---- */
  const math = mark('math', () =>
    buildMathSnapshot(
      state,
      hero,
      primaryOpponent?.id,
      {
        value: equity.value,
        source: equity.source,
      },
      layeredEV !== undefined ? { layeredEV } : {},
      heroEquityVsBetRange,
    ),
  );

  /* ---- 6. 玩家画像的**范围级证据**（P0 修复的验收数据）----
   *
   * 🔴 这一节回答使用者点名的问题：「画像到底有没有进入
   * action-conditioned range 与 Hero equity 主链」。
   *
   * 做法：当 provider **确实**改变了范围形状时，用同一份输入、
   * **不传 provider** 再建一次该对手的范围，并再算一次权益。
   * 那两个权益就是「调整前 / 调整后」——
   * 若它们相等，说明画像没有进入主链。
   *
   * ⚠️ 两次权益用**同一个种子**、同一批对手范围，只有首要对手的范围不同，
   * 因此差异只可能来自画像调整本身（不是抽样噪声）。
   * ⚠️ 只在 `applied === true` 时才算 —— 没有画像的牌局**一个字节都不多算**。
   */
  let profileEvidenceApplied = false;
  const profileRangeEvidence: ProfileRangeEvidence | null = (() => {
    /*
     * 🔴 **证据必须取自「画像描述的那一家」，不是 `realizedOpponents[0]`**
     *（V2.1 独立核查 A 洞，P0）。
     *
     * 修复前这里是 `rangeBuild = primaryBuild`，而 `primaryBuild` 恒等于
     * `realizedOpponents[0]`。于是当画像挂在**别的座位**上
     * （`villainPlayerId` 指向 CO，而首要对手是 UTG）时：
     * 范围**已经被画像改了**，但证据对象为 `null`、字段被整个省掉
     * ⇒ 决策层的去重闸门读到 `undefined` ⇒ 同一份「范围强度」证据
     * 在权益与 scorer 层**各计一次**（实测 `bluffCatchDelta` 由 0
     * 变成 +0.035，`deDuplicated` 由 true 变成 false）。
     *
     * 现在按 `villainId` 定位「被画像描述的对手」；定位不到就退回首要对手
     *（此时两者本来就是同一家）。
     */
    const profiledOpponent =
      (villainId !== null && villainId !== undefined
        ? (realizedOpponents.find((o) => o.id === villainId)
          ?? opponents.find((o) => o.id === villainId)
          ?? null)
        : null) ?? primaryOpponent;
    const evidenceBuild =
      allRangeBuilds.find((entry) => entry.opponentId === profiledOpponent?.id)?.build ?? primaryBuild;
    const core = evidenceBuild.tendency ?? null;
    if (core === null) return null;

    /**
     * 画像是否通过**跛入原型**改变了这个对手的范围（见下面两条路径的说明）。
     *
     * 判据：被画像描述的那家确实跛入（CALL 且无人加注）**且**画像给出的原型不是人群先验。
     */
    const profileChangesLimpRange =
      profiledOpponent !== null &&
      profileArchetype !== LimperArchetype.POPULATION &&
      firstPreflopActionOf(state, profiledOpponent.id)?.action === 'CALL' &&
      openerPositionOf(state, profiledOpponent.id) === null;

    /*
     * 🔴 画像有**三条**进范围的路径，任何一条生效都要做前后对比：
     * ① 倾向 provider（乘数通道，翻前结构上常常不生效）；
     * ② **河牌统一似然通道**（该通道上 provider 被主动抑制，见 suppressProvider）——
     *    只看 ① 会漏掉它，这正是去重闸门失效的根因；
     * ③ **跛入原型通道**（多人 limp 修复新增）—— 它改变跛入者的到达范围，
     *    因此会改变 Hero 权益，即使 provider 自称 `applied = false`。
     * 只看 ① 会让界面写「画像没有改变范围」，而实际上权益已经变了。
     */
    const profileApplied =
      core.provider.applied
      || (evidenceBuild.profileAppliedActions ?? 0) > 0
      || profileChangesLimpRange;
    profileEvidenceApplied = profileApplied;

    if (
      !profileApplied ||
      profiledOpponent === null ||
      evidenceBuild.range === null
    ) {
      return Object.freeze({
        ...core,
        equityBefore: equity.value,
        equityAfter: equity.value,
        equityDeltaPct: 0,
      });
    }

    const baseline = buildRangeSnapshot(
      state,
      profiledOpponent,
      deadCards,
      input.solverRanges?.[profiledOpponent.id],
      null,
      // 基线 = **没有画像**：跛入原型也回到人群先验，否则测不出画像的真实影响
      { archetype: LimperArchetype.POPULATION, confidence: 0 },
    );
    if (baseline.range === null) {
      return Object.freeze({
        ...core,
        equityBefore: null,
        equityAfter: equity.value,
        equityDeltaPct: null,
      });
    }

    const baselineEquity = computeHeroEquity(
      hero,
      allBoardCards(state),
      usableRangeBuilds.map((entry) => ({
        opponentId: entry.opponentId,
        range:
          entry.opponentId === profiledOpponent.id ? baseline.range! : entry.build.range!,
      })),
      input.equitySeed ?? 20260913,
    );
    const delta =
      baselineEquity.value === null || equity.value === null
        ? null
        : (equity.value - baselineEquity.value) * 100;

    return Object.freeze({
      ...core,
      equityBefore: baselineEquity.value,
      equityAfter: equity.value,
      equityDeltaPct: delta,
    });
  })();

  /* ---- 7. 环境 ---- */
  const priority = resolveIndividualOverEnvironment({
    hasProfile: playerBuilt.hasUsableProfile,
    individualConfidence: playerBuilt.confidence,
    individualBasis: playerBuilt.snapshot.note,
    environmentAdviceCount: 0,
  });

  const environment = mark('environment', () =>
    buildEnvironmentSnapshot(input.environment, state.street, input.rules, priority),
  );
  if (environment.anyMagnitudePresent) {
    warnings.push(
      '⚠️ 知识层出现了带 magnitude 的环境规则 —— 这违反 Phase 4.5 的纪律，环境接入层不会使用它',
    );
  }

  /* ---- 8. 动态 ---- */
  const dynamic = mark('dynamic', () =>
    buildDynamicSnapshot(state, villainId, input.asOf, input.dynamicHint),
  );

  /* ---- 9. 组装 ---- */
  const elapsed = Date.now() - startedAt;
  const budget = input.budget ?? { softMs: 3000, hardMs: 8000 };

  /*
   * ---- 8b. 翻后事实包（2026-09 翻后升级 · P2）----
   *
   * 🔴 只有这里能算：决策层拿不到 `Range` 对象（只有快照）。
   * 两条入口（直连 input / 牌桌适配器）都经由本函数 ⇒ **口径自动一致**，
   * 不需要在两侧各填一遍（`interactiveTableDifferential` 的逐字段相等因此成立）。
   */
  const boardCards = allBoardCards(state);
  const previousBoard = boardCards.length >= 4 ? boardCards.slice(0, boardCards.length - 1) : [];
  const postflopFacts: PostflopFacts | undefined =
    boardCards.length < 3
      ? undefined
      : {
          previousBoard: Object.freeze([...previousBoard]),
          /*
           * 用**首要对手**的范围（与 `range` 快照同源）。
           * 多人池下它是「最相关的那个对手」——本项目的权益虽然按全部对手算，
           * 但单对手的牌面适配统计只能对一份范围做，取首要对手并在文档里写明。
           */
          /*
           * 🔴 **必须带上我方底牌**（对抗性审计修复）：
           * `weakerShare` / `strongerShare`（「有哪些更差的牌会跟 / 更好的牌会继续」）
           * 是**相对于我这手牌**的量。缺了它，成对/成花牌面上会得出
           * 「坚果同花也不该下注」的反向结论（见 `rangeFacts.ts` 顶部记录）。
           */
          /*
           * 🔴 复合牌力结构（问题 2）：成手 + 听牌 + 四桶补牌。
           * 在这里算是因为只有这一层同时拿得到 Hero 底牌与公共牌。
           */
          handStructure: (() => {
            const holeCards = hero.holeCards ?? [];
            if (holeCards.length !== 2) return undefined;
            const draw = drawProfileOf(holeCards, boardCards);
            const audit = outAuditOf(holeCards, boardCards);
            let madeClass = 'HIGH_CARD';
            try {
              madeClass = madeHandClassOf(evaluateCards([...holeCards, ...boardCards]).category);
            } catch {
              madeClass = 'HIGH_CARD';
            }
            const parts: string[] = [madeClass];
            if (draw.openEnded) parts.push('OESD');
            else if (draw.gutshot) parts.push('GUTSHOT');
            if (draw.flushDraw) parts.push('FLUSH_DRAW');
            return Object.freeze({
              madeHandClass: madeClass,
              openEnded: draw.openEnded,
              gutshot: draw.gutshot,
              flushDraw: draw.flushDraw,
              structureLabel: parts.join('_PLUS_'),
              rawOuts: audit.rawOuts,
              cleanOuts: audit.cleanOuts,
              discountedOuts: audit.discountedOuts,
              dirtyOuts: audit.dirtyOuts,
              doubleCounted: audit.doubleCounted,
              nonNutFlushDraw: audit.nonNutFlushDraw,
              notesZh: Object.freeze([
                `成手 ${madeClass}｜听牌 ${parts.slice(1).join(' + ') || '（无）'}`,
                ...audit.notesZh,
              ]),
            });
          })(),
          opponentRangeFacts: opponentRangeFactsOf(
            primaryBuild.range,
            boardCards,
            hero.holeCards ?? [],
          ),
          /*
           * 🔴 **TEST 09 P0-1：BET RANGE（他的**下注**范围）**。
           *
           * 与上面的 `opponentRangeFacts`（**到达**范围）**并列但不同义**（§十九）：
           * - `opponentRangeFacts` 回答「他走到这个节点**拥有**什么」
           * - `bettingRangeFacts` 回答「他在这里实际**选择下注**的是哪些牌」
           *
           * ⚠️ RIVER BET RANGE V2：`opponentRangeFacts` 取自 `primaryBuild.range`
           * （**含**本街全部动作，含当前下注），因此它**不是**到达范围；
           * 真正的到达范围见下面的 `betRangeArrival`（§数据一致性）。
           *
           * `null` 表示当前不是「他在下注」的节点（或算不出来）——不是空范围。
           */
          bettingRangeFacts:
            bettingRangeFacts === null
              ? null
              : {
                  classMasses: Object.freeze({ ...bettingRangeFacts.classMasses }),
                  bandMasses: Object.freeze({
                    arrival: Object.freeze({ ...bettingRangeFacts.bandMasses.arrival }),
                    bet: Object.freeze({ ...bettingRangeFacts.bandMasses.bet }),
                  }),
                  bandRates: Object.freeze({ ...bettingRangeFacts.bandRates }),
                  model: Object.freeze({
                    ...bettingRangeFacts.model,
                    factors: Object.freeze({ ...bettingRangeFacts.model.factors }),
                  }),
                  arrivalMass: bettingRangeFacts.arrivalMass,
                  betMass: bettingRangeFacts.betMass,
                  betShareOfArrival: bettingRangeFacts.betShareOfArrival,
                  entryCount: bettingRangeFacts.entries.length,
                  effectiveComboCount: bettingRangeFacts.effectiveComboCount,
                  posteriorMassCombos90: bettingRangeFacts.posteriorMassCombos90,
                  noteZh: bettingRangeFacts.noteZh,
                },
          betRangeSizing: bettingRangeFacts?.sizing ?? null,
          heroEquityVsBetRange,
          /*
           * 🔴 **U1：面对加注的响应 + 加注 EV**（`reports/UNCERTAINTY_REGISTER.md`）。
           *
           * `null` = 本节点没有加注候选 / 算不出来（不是「加注 EV = 0」）。
           * 决策层只有在它选中的加注尺寸与 `sizeChips` 一致时才允许使用该 EV。
           */
          raiseResponse:
            raiseResponseFacts === null
              ? null
              : {
                  sizeChips: raiseResponseFacts.sizeChips,
                  sizeBB: raiseResponseFacts.sizeBB,
                  raiseIncrement: raiseResponseFacts.raiseIncrement,
                  /* 🔴 U1 P0：完整资金口径必须随诊断一起可见（决策层据此授予比较资格） */
                  cashflowContract: raiseResponseFacts.cashflowContract,
                  currentPot: raiseResponseFacts.currentPot,
                  heroStreetCommitted: raiseResponseFacts.heroStreetCommitted,
                  villainStreetCommitted: raiseResponseFacts.villainStreetCommitted,
                  heroAdd: raiseResponseFacts.heroAdd,
                  villainAdd: raiseResponseFacts.villainAdd,
                  villainAddRaw: raiseResponseFacts.villainAddRaw,
                  villainIsAllInByCall: raiseResponseFacts.villainIsAllInByCall,
                  heroContestedAdd: raiseResponseFacts.heroContestedAdd,
                  /* 🔴 P1-2b：被再加注分支（Hero 的 FOLD / CALL 两选一） */
                  reraiseBranchEV: raiseResponseFacts.reraiseBranchEV,
                  reraiseBranchKind: raiseResponseFacts.reraiseBranchKind,
                  reraiseFoldBranchEV: raiseResponseFacts.reraiseFoldBranchEV,
                  reraiseCallBranchEV: raiseResponseFacts.reraiseCallBranchEV,
                  heroEquityVsReraiseRange: raiseResponseFacts.heroEquityVsReraiseRange,
                  reraiseBranchUnsupportedZh: raiseResponseFacts.reraiseBranchUnsupportedZh,
                  /* 桶大小与 4-bet 支持与否**恒上报**（rr = 0 时桶为空、不支持反加） */
                  reRaiseCombos: raiseResponseFacts.reRaiseCombos,
                  heroFourBetSupported: raiseResponseFacts.heroFourBetSupported,
                  ...('reRaiseTo' in raiseResponseFacts
                    ? {
                        reRaiseTo: raiseResponseFacts.reRaiseTo,
                        reRaiseMinLegalTo: raiseResponseFacts.reRaiseMinLegalTo,
                        villainReRaiseIsAllIn: raiseResponseFacts.villainReRaiseIsAllIn,
                        heroAdditionalCallVsReRaise: raiseResponseFacts.heroAdditionalCallVsReRaise,
                        finalPotAfterCallVsReRaise: raiseResponseFacts.finalPotAfterCallVsReRaise,
                      }
                    : {}),
                  finalPot: raiseResponseFacts.finalPot,
                  uncalledReturn: raiseResponseFacts.uncalledReturn,
                  foldLikelihood: raiseResponseFacts.foldLikelihood,
                  callLikelihood: raiseResponseFacts.callLikelihood,
                  reRaiseLikelihood: raiseResponseFacts.reRaiseLikelihood,
                  heroEquityVsRaiseCallRange: raiseResponseFacts.heroEquityVsRaiseCallRange,
                  equityMethod: raiseResponseFacts.equityMethod,
                  equityIterations: raiseResponseFacts.equityIterations,
                  raiseEV: raiseResponseFacts.raiseEV,
                  evKind: raiseResponseFacts.evKind,
                  reachableCombos: raiseResponseFacts.reachableCombos,
                  callCombos: raiseResponseFacts.callCombos,
                  assumptionsZh: raiseResponseFacts.assumptionsZh,
                  model: Object.freeze({
                    ...raiseResponseFacts.model,
                    strengthOfBand: Object.freeze({ ...raiseResponseFacts.model.strengthOfBand }),
                  }),
                  noteZh: raiseResponseFacts.noteZh,
                },
          /*
           * 🔴 **RIVER BET RANGE V2：真正的「河牌下注前到达范围」**。
           *
           * 它是同一次范围更新链在**当前下注之前**的状态（引用捕获，零额外计算），
           * 因此验证方式是可证伪的：**只改当前下注的尺寸，它必须逐位不变**。
           *
           * `null` = 没有捕获（不是「他在下注」的节点）。
           */
          betRangeArrival:
            betRangeArrivalRange === null
              ? null
              : {
                  heroEquityVsArrivalRange,
                  supportCount: betRangeArrivalRange.metrics.supportSize,
                  arrivalMass: bettingRangeFacts?.arrivalMass ?? null,
                  /** 到达范围的**公共强度带**质量（与下注范围同一把尺子） */
                  bandMasses: bettingRangeFacts === null
                    ? null
                    : Object.freeze({ ...bettingRangeFacts.bandMasses.arrival }),
                  excludedActionZh:
                    currentBetRecord === null
                      ? null
                      : `本街最后一次进攻动作（下标 ${currentBetRecord.index}，` +
                        `${POSITION_ZH[currentBetRecord.position]}）—— 它只在**下注范围**里计一次`,
                  noteZh:
                    '到达范围 = 本手范围更新链在「当前下注」这一步**之前**的状态：' +
                    '翻前/翻牌/转牌的跟注与更早的进攻动作都已施加似然，' +
                    '唯独当前这一次下注**没有**（它由下注权重计一次）。',
                },
          /*
           * 🔴 **下注决策事实包**（BET DECISION ENGINE PHASE 1）。
           *
           * 只有这里能算：决策层拿不到 `Range` 对象，而「面对每个尺寸的
           * fold / call / raise 条件范围 + 对它们的权益」必须基于**真实范围**。
           * 与 `opponentRangeFacts` 同一条架构纪律（见本文件 §8b 的说明）。
           */
          betDecision: buildBetDecisionFacts({
            range: primaryBuild.range,
            /*
             * 🔴 **完整对手列表**（§13）：每家一份自己的范围 + **他自己的**画像倾向。
             * 优先级：`seatProfiles[位置]` > `quickProfile`（当该座位就是画像描述的那家）> 中立先验。
             */
            opponents: usableRangeBuilds.map((entry) => {
              const opponent =
                realizedOpponents.find((p) => p.id === entry.opponentId) ?? primaryOpponent;
              const seatProfile =
                opponent === null || opponent === undefined
                  ? undefined
                  : input.seatProfiles?.[opponent.position];
              const isVillain = entry.opponentId === villainId;
              const ownDimensions =
                seatProfile !== undefined && seatProfile !== 'UNKNOWN'
                  ? archetypeDimensionsOf(seatProfile as QuickProfile, QUICK_PROFILE_CONFIDENCE)
                  : isVillain && playerBuilt.tendency !== null
                    ? playerBuilt.tendency.dimension.dimensions
                    : null;
              return {
                opponentId: entry.opponentId,
                range: entry.build.range,
                positionZh: opponent === null || opponent === undefined ? '对手' : POSITION_ZH[opponent.position],
                dimensions: ownDimensions,
                confidence:
                  seatProfile !== undefined && seatProfile !== 'UNKNOWN'
                    ? QUICK_PROFILE_CONFIDENCE
                    : isVillain && playerBuilt.tendency !== null
                      ? playerBuilt.confidence
                      : 0,
                tendencyNoteZh:
                  seatProfile !== undefined && seatProfile !== 'UNKNOWN'
                    ? `逐座位画像「${seatProfile}」（用户主观判断，可信度上限 ${QUICK_PROFILE_CONFIDENCE}）`
                    : ownDimensions !== null
                      ? '画像（首要对手，含实测与手选合并）'
                      : '无画像 ⇒ 中立先验（不编造类型）',
              };
            }),
            board: boardCards,
            heroHole: hero.holeCards ?? [],
            pot: math.pot,
            street: math.street,
            spr: math.spr,
            opponentCount: realizedOpponents.length,
            heroPosition: hero.position,
            villainPosition: primaryOpponent?.position ?? null,
            equityVsArrivalRange: math.heroEquity,
            dimensions:
              playerBuilt.tendency === null ? null : playerBuilt.tendency.dimension.dimensions,
            profileConfidence: playerBuilt.tendency === null ? 0 : playerBuilt.confidence,
            /* 🔴 PLAYER PROFILE V3：把分街系数与实测维度交给响应层（无统计时逐位不变） */
            v3Street: v3StreetInput,
            /*
             * 🔴 **P0-B 修正**：交给响应层的是**融合后**的维度（标签 prior ⊕ 实测），
             * 不再是「只有实测」的那一层 —— 后者在修复前会**整体覆盖**标签理解，
             * 于是「同一份实测 + CS 标签」与「+ NIT 标签」得到逐位相同的人物画像。
             */
            ...(resolvedV3.observedStatCount > 0
              ? { v3Dimensions: resolvedV3.resolved.resolvedDimensions }
              : {}),
            seed: input.equitySeed ?? 20260913,
            // 「当前剩余」而不是带入筹码；上限取场上**最短**筹码（多人池的有效筹码）
            heroRemaining: math.myRemainingStack,
            villainRemaining:
              usableRangeBuilds.length === 0
                ? (primaryOpponent === null ? 0 : primaryOpponent.remainingStack)
                : Math.min(
                    ...usableRangeBuilds.map(
                      (entry) =>
                        realizedOpponents.find((p) => p.id === entry.opponentId)?.remainingStack ?? 0,
                    ),
                  ),
            minBet: state.config.bigBlind,
          }),
        };

  /*
   * ---- 8c. 翻前多人 limp：隔离加注事实包（MULTI_LIMP ISOLATION RAISE PHASE 1）----
   *
   * 只在「Hero 面对跛入、且尚无人加注」的翻前节点构建。
   * 其余节点（含「面对真实开池」——那里不是隔离加注）保持原样，
   * 决策层也就拿不到任何可用的隔离加注 EV（宁可不给，也不编）。
   */
  const preflopIsoFacts: PreflopIsoFacts | null = (() => {
    if (state.street !== 'PREFLOP' || legal.callCost <= 0) return null;
    const anyRaiser =
      opponents.some((o) => firstPreflopActionOf(state, o.id)?.action === 'RAISE');
    if (anyRaiser) return null;
    const limpers = realizedOpponents.filter(
      (o) => firstPreflopActionOf(state, o.id)?.action === 'CALL',
    );
    if (limpers.length === 0) return null;

    /*
     * 原型：只有**画像描述的那一家**用画像（其余用人群先验）。
     * 手动录入目前只支持一个 `quickProfile`，因此多人桌上只有一个座位
     * 能带上原型 —— 这是输入限制，不是模型限制（见报告 §F）。
     */
    const profileArchetype = quickProfileToLimperArchetype(input.quickProfile);
    const inputOf = (player: PlayerState): LimperInput => ({
      position: player.position,
      archetype: player.id === villainId ? profileArchetype : LimperArchetype.POPULATION,
      confidence: player.id === villainId ? playerBuilt.confidence : 0,
    });

    return buildPreflopIsoFacts({
      hero,
      street: state.street,
      limpers,
      limperInputOf: inputOf,
      playersBehind: playersYetToAct,
      pot: math.pot,
      bigBlind: state.config.bigBlind,
      legal,
      heroRemaining: math.myRemainingStack,
      equityVsArrival: math.heroEquity,
      callProxyEV: math.callEV,
      board: allBoardCards(state),
      seed: input.equitySeed ?? 20260913,
    });
  })();

  /** 我之后还需要行动的对手数（取自 pendingQueue，已含「下注重开行动」） */
  const playersRemainingToActCount = (() => {
    const queue = state.pendingQueue;
    const heroIndex = queue.indexOf(hero.id);
    const after = heroIndex >= 0 ? queue.slice(heroIndex + 1) : [];
    return after.filter((id) => {
      const player = state.players.find((p) => p.id === id);
      return player !== undefined && !player.folded && !player.allIn;
    }).length;
  })();

  const context: DecisionContext = Object.freeze({
    heroCards: Object.freeze([...(hero.holeCards ?? [])]),
    board: Object.freeze(allBoardCards(state)),
    activeOpponentCount: opponents.length,
    realizedOpponentCount: realizedOpponents.length,
    playersYetToAct: playersYetToAct.length,
    /*
     * 🔴 **「我之后还有谁要行动」必须来自引擎的行动队列**（TEST HAND MULTIWAY TURN FIX）。
     * pendingQueue 已经把「下注重开行动」算进去了：已经过牌的玩家在有人下注后
     * 仍需再表态。修复前用的是 playersYetToAct（= 本街还没说过话的人），
     * 于是 UTG+1 check → LJ bet → Hero 被写成「本街已无人待行动」。
     */
    playersRemainingToAct: playersRemainingToActCount,
    isClosingAction: playersRemainingToActCount === 0,
    math,
    ...(profileRangeEvidence !== null ? { profileRangeEvidence } : {}),
    /**
     * 🔴 **去重闸门的权威标志**（V2.1 修复）。
     *
     * 与 `profileRangeEvidence` 分开传是**刻意**的：证据对象只在
     * 「建范围阶段拿得到 provider 证据」时才存在，而「画像是否真的改了范围」
     * 是一个**独立的事实**（证据对象缺失不代表画像没生效 —— 那正是
     * A 洞的形态）。决策层必须读这个字段，不得读 `evidence?.provider.applied`。
     */
    profileAppliedToRange: profileEvidenceApplied
      || (rangeBuild.profileAppliedToRange ?? false)
      || allRangeBuilds.some((entry) => entry.build.profileAppliedToRange === true),
    ...(postflopFacts !== undefined ? { postflopFacts } : {}),
    ...(preflopIsoFacts !== null ? { preflopIso: preflopIsoFacts } : {}),
    range: rangeBuild.snapshot,
    opponentRanges: Object.freeze(
      usableRangeBuilds
        .map((entry) => entry.build.snapshot)
        .filter((s): s is RangeSnapshot => s !== null),
    ),
    player: playerBuilt.snapshot,
    /* 🔴 PLAYER PROFILE V3 的 Profile Trace（诊断 / 审计模式可见） */
    profileV3: Object.freeze({
      baseArchetype: (input.quickProfile ?? null) as string | null,
      observedStatCount: resolvedV3.observedStatCount,
      confidenceTierZh: resolvedV3.confidenceTierZh,
      /*
       * 🔴 **TEST 08 P0-3**：节点语义与「被语义门挡下的分街条目」。
       * 不暴露它们的话，「统计给了却毫无影响」会变成一个无法审计的静默行为。
       */
      actionContext: resolvedV3.actionContext,
      deniedStreetTraits: Object.freeze([...resolvedV3.deniedStreetTraits]),
      /*
       * 🔴 **P0-B：三个维度字段必须分清**（`dimensions` 保持既有语义 = 只有实测）。
       *
       * | 字段 | 含义 |
       * |---|---|
       * | `dimensions` | ① 只有实测说话（无实测 ⇒ 0.5）—— 既有字段，语义未变 |
       * | `observedDimensions` | ① 的显式别名 |
       * | `resolvedDimensions` | ③ 标签 ⊕ 实测融合（**下游响应层消费的就是它**） |
       * | `baseDimensions` | 融合基准 = 标签维度 |
       * | `evidenceMass` / `blendWeight` | 逐轴证据量与融合权重（可审计） |
       */
      dimensions: Object.freeze({ ...resolvedV3.resolved.observedOnlyDimensions }),
      observedDimensions: Object.freeze({ ...resolvedV3.resolved.observedOnlyDimensions }),
      resolvedDimensions: Object.freeze({ ...resolvedV3.resolved.resolvedDimensions }),
      baseDimensions: Object.freeze({ ...resolvedV3.resolved.baseDimensions }),
      evidenceMass: Object.freeze({ ...resolvedV3.resolved.evidenceMass }),
      blendWeight: Object.freeze({ ...resolvedV3.resolved.blendWeight }),
      street: Object.freeze({
        PREFLOP: Object.freeze({ ...resolvedV3.resolved.street.PREFLOP }),
        FLOP: Object.freeze({ ...resolvedV3.resolved.street.FLOP }),
        TURN: Object.freeze({ ...resolvedV3.resolved.street.TURN }),
        RIVER: Object.freeze({ ...resolvedV3.resolved.street.RIVER }),
      }),
      trace: Object.freeze(
        resolvedV3.trace.map((x) => Object.freeze({ ...x })),
      ) as readonly Readonly<Record<string, unknown>>[],
      issues: Object.freeze(
        resolvedV3.issues.map((x) => Object.freeze({ ...x })),
      ) as readonly Readonly<Record<string, unknown>>[],
      noteZh: resolvedV3.noteZh,
    }),
    environment,
    dynamic,
    deadlineBudget: Object.freeze({ ...budget, elapsedMs: elapsed }),
    timings: Object.freeze({ ...timings, total: elapsed }),
  });

  return { context, legal, warnings: Object.freeze([...warnings]) };
}

/** 保留导出以便诊断与测试 */
export {
  isUnopenedPot,
  ALPHA_CONTEXT_VERSION,
  CONFIDENCE_BAND_ZH,
  DECISION_ACTION_ZH,
  ACTION_ZH,
  confidenceBandOf,
  DYNAMIC_MODEL_VERSION,
  PREFLOP_PRIOR_NOTE,
};

/* ==== AUDIT SHADOW EXPORTS (temp) ==== */
export { buildRangeSnapshot, buildPlayerSnapshot, nodeActionContextOf, firstPreflopActionOf, boardAtStreetOf, rangeEquityOfMany, TENDENCY_TIER_ZH, QUICK_PROFILE_CONFIDENCE };
