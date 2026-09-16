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

import { Street, Position, ActionType, ALL_CARDS, type Card } from '../../domain/types.ts';
import {
  computePot,
  requiredCallAmount,
  playerById,
  allBoardCards,
  realizedOpponentIds,
  yetToActIds,
  type GameState,
  type PlayerState,
} from '../../domain/poker/gameState.ts';
import { previewCommit } from '../../domain/poker/pots.ts';
import { isUnopenedPot } from '../../domain/poker/engine.ts';
import { effectiveStackBetween } from '../../domain/poker/odds.ts';
import { evaluateCards, type EvaluatedHand } from '../../domain/poker/handEval.ts';
import { boardRelativeTierOf } from '../../domain/poker/boardRelativeStrength.ts';
import { opponentRangeFactsOf } from './rangeFacts.ts';
import { describeHand } from '../../domain/poker/handDescription.ts';
import { handDescriptionText } from '../../i18n/index.ts';
import { computeEquity } from '../../domain/poker/equity.ts';
import { EquityComputeMode } from '../../domain/poker/equity.types.ts';
import { RangeState, toRangeAction, type Range } from '../../domain/range/range.types.ts';
import { buildRangeFromRankClasses } from '../../domain/range/range.ts';
import { updateRange } from '../../domain/range/rangeUpdate.ts';
import { PlayerMetric } from '../../domain/player/player.types.ts';
import { readPlayer, type PlayerRead } from '../../domain/player/playerClassifier.ts';
import { createProfile, PROFILE_VERSION } from '../../domain/player/playerProfile.ts';
import { evaluateDynamicBehavior } from '../../domain/dynamic/dynamicBehavior.ts';
import { adaptAdjustments } from '../../domain/dynamic/dynamicAdapter.ts';
import { DYNAMIC_MODEL_VERSION, type UserHintKind } from '../../domain/dynamic/dynamic.types.ts';
import { GameEnvironment, environmentProfile } from '../../domain/range/gameEnvironment.ts';
import {
  environmentAdviceFor,
  resolveIndividualOverEnvironment,
  type EnvironmentAdviceResult,
} from '../../domain/environment/environmentAccess.ts';
import {
  StrategyStreet,
  GameEnvironmentId as KnowledgeEnvironmentId,
  type StrategyKnowledge,
} from '../../domain/knowledge/knowledge.types.ts';

import { deriveLegalActions, type LegalActions } from '../manualInput/legalActions.ts';
import type { RangeSource } from '../../domain/range/range.types.ts';
import type { RankClassWeights } from '../../domain/range/range.ts';
import {
  PREFLOP_PRIOR_PROVENANCE,
  PREFLOP_PRIOR_NOTE,
  bigBlindCheckWeights,
  defendWeightsByHandedness,
  rfiWeightsByHandedness,
  threeBetWeightsByHandedness,
} from '../manualInput/preflopPriors.ts';
import {
  betRatioOf,
  likelihoodWeights,
  tierOfRankClass,
  tierWeightOf,
} from '../manualInput/likelihoodModel.ts';
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
} from '../manualInput/manualInput.ts';
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
  type RangeSnapshot,
  type RangeUpdateTraceEntry,
} from '../../domain/decision/decision.types.ts';
import { ACTION_ZH, POSITION_ZH } from '../manualInput/manualInput.ts';

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
  const lowerBoundCallEV =
    equity.value !== null && callCost > 0 ? equity.value * winnable - callCost : null;

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

type RangeBuild = {
  snapshot: RangeSnapshot | null;
  range: Range | null;
  warnings: string[];
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
    weights =
      opener !== null && opener !== opponent.position
        ? defendWeightsByHandedness(opener, opponent.position)
        : bigBlindCheckWeights();
    label =
      opener !== null
        ? `面对${POSITION_ZH[opener]}开池的启发式继续范围（对手选择跟注）`
        : '无人加注时的宽范围';
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
): { range: Range; trace: RangeUpdateTraceEntry[] } {
  let current = range;
  const trace: RangeUpdateTraceEntry[] = [];

  let actionIndex = 0;
  let skippedBaseAction = false;
  for (const record of state.actions) {
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
    const boardAtAction = allBoardCards(state).slice(
      0,
      record.street === Street.FLOP ? 3 : record.street === Street.TURN ? 4 : 5,
    );
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

    const result = updateRange(
      current,
      {
        likelihoods: Object.freeze(
          current.entries.map((entry) => ({
            comboId: entry.combo.canonicalId,
            action: rangeAction,
            likelihood: tierWeightOf(weights, tierOfEntry(entry.combo)),
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
      { withDiff: false },
    );

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
    });
  }

  return { range: current, trace };
}

function buildRangeSnapshot(
  state: GameState,
  opponent: PlayerState,
  deadCards: readonly Card[],
  /** 求解器给这一家的范围权重（有则用，无则回落启发式先验） */
  solverOverride?: SolverRangeOverride,
): RangeBuild {
  const warnings: string[] = [];
  const aggression = firstPreflopActionOf(state, opponent.id);

  const base = buildBaseRange(state, opponent, aggression, deadCards, solverOverride);
  if (!base.ok) {
    return { snapshot: null, range: null, warnings: [base.reason] };
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
   */
  const updated =
    solverOverride !== undefined
      ? { range: base.range, trace: [] as RangeUpdateTraceEntry[] }
      : applyLikelihoodUpdates(base.range, state, opponent, aggression);
  const range = updated.range;

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

  return { snapshot, range, warnings };
}

/* ============================================================
 * 权益
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
): { snapshot: PlayerSnapshot; hasUsableProfile: boolean; confidence: number } {
  // 没有真实画像时，用零手画像（它会走到 UNKNOWN / 中性调整）
  const effectiveProfile =
    profile !== null && profile !== undefined && typeof profile === 'object'
      ? (profile as Parameters<typeof readPlayer>[0])
      : createProfile(villainId);

  const read: PlayerRead = readPlayer(effectiveProfile);
  const handsObserved = read.sampleNote.totalHands;

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

  const snapshot: PlayerSnapshot = Object.freeze({
    playerId: villainId,
    label: read.label,
    labelZh: read.label,
    // 用户手选画像必须**原样带上去**（决策层的剥削层要用它；见 PlayerSnapshot 的说明）
    quickProfile:
      quickProfile !== undefined && quickProfile !== '' ? (quickProfile as QuickProfile) : null,
    confidence,
    handsObserved,
    adjustment: Object.freeze({ ...read.adjustment, confidence }),
    note,
    neutralized,
  });

  return { snapshot, hasUsableProfile: handsObserved > 0, confidence };
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
 * 主入口
 * ============================================================ */

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

  const allRangeBuilds = mark('range', () =>
    realizedOpponents.map((opponent) => ({
      opponentId: opponent.id,
      build: buildRangeSnapshot(
        state,
        opponent,
        deadCards,
        input.solverRanges?.[opponent.id],
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
      ? buildRangeSnapshot(state, primaryOpponent, deadCards)
      : { snapshot: null, range: null, warnings: [] as string[] });
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
    ),
  );

  /* ---- 6. 玩家 ---- */
  const villainId = input.villainPlayerId ?? primaryOpponent?.id ?? 'villain';
  const playerBuilt = mark('player', () =>
    buildPlayerSnapshot(villainId, input.villainProfile, input.quickProfile),
  );

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
          opponentRangeFacts: opponentRangeFactsOf(
            primaryBuild.range,
            boardCards,
            hero.holeCards ?? [],
          ),
        };

  const context: DecisionContext = Object.freeze({
    heroCards: Object.freeze([...(hero.holeCards ?? [])]),
    board: Object.freeze(allBoardCards(state)),
    activeOpponentCount: opponents.length,
    realizedOpponentCount: realizedOpponents.length,
    playersYetToAct: playersYetToAct.length,
    math,
    ...(postflopFacts !== undefined ? { postflopFacts } : {}),
    range: rangeBuild.snapshot,
    opponentRanges: Object.freeze(
      usableRangeBuilds
        .map((entry) => entry.build.snapshot)
        .filter((s): s is RangeSnapshot => s !== null),
    ),
    player: playerBuilt.snapshot,
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
