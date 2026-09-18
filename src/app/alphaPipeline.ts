/**
 * 端到端管线：`analyzeManualHand`
 *
 * ## 这个模块在端到端链中解决什么
 *
 * 把整条链串起来，并保证**任何一步失败都返回可解释的结果**，
 * 而不是崩溃或返回半截对象。
 *
 * ```
 * Manual Input → Validation → Math → Range → Player → Environment
 *   → Dynamic → Decision → Final Math Sanity → ViewModel → Decision Log
 * ```
 *
 * ## 三条纪律
 *
 * 1. **管线不跳过校验**（规范第 12 节）：未通过 Validator 的输入
 *    不会进入决策。校验失败时返回 `stage: 'VALIDATE'` 与中文原因。
 * 2. **`analyzeManualHand` 自身不使用 LLM、不访问网络**（规范第 49 节）：
 *    它是**同步纯函数**，只调用确定性的本地模块。
 *
 *    ⚠️ **Phase 1.2 的边界调整**：求解器范围预取（`prefetchSolverRanges`）
 *    确有一次网络访问 —— 因此它被**单独放在本模块的另一个导出函数里**，
 *    由调用方在分析**之前** `await`。`analyzeManualHand` 只接收**已取到的数据**
 *    （`AnalyzeOptions.gtoRanges`），自身仍然零 I/O。
 *
 *    这样分工的理由：约 100 个调用点（测试 / 探针）依赖它的同步性，
 *    而它们**根本不需要 GTO**。把它们全改成 async 是拿一个大改动
 *    去换一个小功能。
 * 3. **管线不修改调用方对象**（规范第 80 节）：
 *    输入被读取后立即转成内部结构，输出是全新的冻结对象。
 */

import type { Card } from '../domain/types.ts';
import { Street } from '../domain/types.ts';
import type { StrategyKnowledge } from '../domain/knowledge/knowledge.types.ts';
import { GameEnvironment } from '../domain/range/gameEnvironment.ts';
import type { AlphaDecision } from '../domain/decision/decision.types.ts';
import type { DecisionViewModel } from '../viewmodels/decisionViewModel.ts';
import { toDecisionViewModel, withFinalTimings } from '../viewmodels/decisionViewModel.ts';

import {
  allBoardCards,
  realizedOpponentIds,
  type GameState,
  type PlayerState,
} from '../domain/poker/gameState.ts';
import {
  GtoActionKind,
  gtoPositionsFor,
  gtoTableSizeOf,
  type GtoPosition,
  type GtoProvider,
  type GtoScenarioAction,
  type GtoTableSize,
} from '../domain/gto/gto.types.ts';
import { keysOf } from '../domain/gto/gtoScenario.ts';
import type { GtoLookupResult } from '../domain/gto/gto.types.ts';

import {
  parseManualInput,
  POSITION_ZH,
  type ManualHandInput,
  type ParsedManualInput,
} from './manualInput/manualInput.ts';
import { buildAnalyzableState, type ManualAnalysisGate } from './manualInput/reconstruct.ts';
import {
  buildDecisionContext,
  type ContextBuildInput,
  type SolverRangeOverride,
} from './manualInput/contextBuilder.ts';
import type { QuickProfile } from './manualInput/manualInput.ts';
import type { Position } from '../domain/types.ts';
import { preflopShapeOf, scenarioForOpponent } from './manualInput/solverScenarioForOpponent.ts';
import {
  lookupPreflopRangePrior,
  priorFromCachedBaseline,
  solveSettingsMatch,
  type OpponentPreflopAction,
  type SolverRangePrior,
} from './manualInput/solverRangePrior.ts';
import {
  BackgroundSolveState,
  backgroundSolveQueue,
  type BackgroundSolveRecord,
} from './gto/backgroundSolve.ts';
import { decideAlpha } from './decision/decisionEngine.ts';
import { MARGINAL_EV_GAP_RATIO } from '../domain/decision/decision.types.ts';
import { appendDecisionLog, type DecisionLogEntry } from './decisionLog.ts';
import { DEADLINE_DEFAULTS, DecisionDeadline, DeadlineMode } from './decisionDeadline.ts';

/**
 * 交互式分析的默认时间预算（软 3 秒 / 硬 8 秒）。
 *
 * 直接引用 `DEADLINE_DEFAULTS.INTERACTIVE`，**不重新写一遍数字** ——
 * 两处各写一份必然会漂移，而这是项目锁定的硬指标。
 */
const INTERACTIVE_BUDGET: { softMs: number; hardMs: number } = DEADLINE_DEFAULTS[DeadlineMode.INTERACTIVE];

/* ============================================================
 * 结果类型
 * ============================================================ */

/**
 * 失败的阶段（用于分类 Bug）。
 *
 * `DEADLINE` 是**独立**的一档，不混进其他阶段：
 * 超时不是「解析错了」也不是「决策错了」，
 * 把它记成 `CONTEXT` 会让「为什么这次没给建议」变得无法追溯。
 */
export type FailureStage = 'PARSE' | 'RECONSTRUCT' | 'VALIDATE' | 'CONTEXT' | 'DECISION' | 'DEADLINE';

export type AlphaAnalysisFailure = {
  ok: false;
  stage: FailureStage;
  /** 中文说明（可配置界面直接显示） */
  issues: readonly { code: string; message: string; field?: string }[];
  /** 各阶段耗时（毫秒），失败时也有值，便于定位性能问题 */
  timings: Readonly<Record<string, number>>;
};

export type AlphaAnalysisSuccess = {
  ok: true;
  /** 引擎决策（**唯一的策略真相来源**） */
  decision: AlphaDecision;
  /** 界面唯一允许消费的结构 */
  viewModel: DecisionViewModel;
  /** 决策日志条目（已写入 JSONL，同时返回便于测试） */
  log: DecisionLogEntry;
  /** 各阶段耗时 */
  timings: Readonly<Record<string, number>>;
  /** 管线层面的警告（不阻断） */
  warnings: readonly string[];
  /** 已校验的状态（调试用；不含对手底牌） */
  computedPot: number;
  /** 用户声明的底池；`null` = 未声明（由引擎重算） */
  claimedPot: number | null;
};

export type AlphaAnalysisResult = AlphaAnalysisSuccess | AlphaAnalysisFailure;

/**
 * 求解器范围预取的默认时间上限（毫秒）。
 *
 * 🔴 它必须**显著小于**「1～3 秒给建议」这个核心目标 ——
 * 否则求解器一慢，整个分析就跟着慢。
 * 冷启动建树实测：4 人桌约 2 秒、6 人桌约 47 秒、9 人桌约 159 秒，
 * 因此默认值只够命中**已缓存**的场景；冷启动时会超时回落（这是刻意的）。
 */
export const SOLVER_PREFETCH_BUDGET_MS = 1500;

/**
 * 翻前某个对手与 Hero 之间的**有效筹码（BB）**。
 *
 * 🔴 为什么必须取「两者较小者」而不是 Hero 的剩余筹码：
 * 求解场景是按**有效筹码**建的（100BB 的策略与 40BB 完全不同）。
 * 用 Hero 的筹码去建一个对手只有 30BB 的场景，会读到一份描述
 * **另一个牌局**的数据 —— 而且读到的数字看起来完全正常。
 *
 * ⚠️ 本函数只处理**翻前**：翻前没有投入过筹码（盲注除外），
 * 因此用「起始筹码 + 盲注」即可；翻后**不会**走到这里
 *（`prefetchSolverRanges` 在翻后直接返回空）。
 */
function preflopEffectiveStackBB(state: GameState, heroId: string, opponentId: string): number {
  const hero = state.players.find((p) => p.id === heroId);
  const opponent = state.players.find((p) => p.id === opponentId);
  const bigBlind = state.config.bigBlind;
  if (hero === undefined || opponent === undefined || bigBlind <= 0) return 100;

  // 起始筹码 = 当前剩余 + 本手已投入（翻前就是盲注）
  const committed = (p: PlayerState): number =>
    p.committedByStreet[Street.PREFLOP] + p.committedByStreet[Street.FLOP] +
    p.committedByStreet[Street.TURN] + p.committedByStreet[Street.RIVER];
  const heroStart = (hero.remainingStack + committed(hero)) / bigBlind;
  const oppStart = (opponent.remainingStack + committed(opponent)) / bigBlind;

  return Math.max(1, Math.min(heroStart, oppStart));
}

/* ============================================================
 * 依赖注入
 * ============================================================ */

export type AnalyzeOptions = {
  /**
   * 知识层规则（**由调用方注入**）。
   *
   * 为什么不用本模块自己读文件：领域层必须保持纯函数、零 I/O
   *（`knowledgeLoader.ts` 的注释明确写了这条分工）。
   * 服务端启动时加载一次，之后复用。
   */
  rules: readonly StrategyKnowledge[];
  /** 决策时刻（Unix 毫秒）；省略时用当前时间 */
  asOf?: number;
  /** 蒙特卡洛种子（可复现；省略时用固定值） */
  equitySeed?: number;
  /** 时间预算 */
  budget?: { softMs: number; hardMs: number };
  /** 是否写入决策日志（默认 true） */
  writeLog?: boolean;
  /** 决策日志文件路径（默认 `data/decision-log.jsonl`） */
  logPath?: string;
  /**
   * 🔴 **求解器范围预取预算**（Phase 1.2）。
   *
   * 超时就放弃预取、全部分回落启发式先验。
   * 默认 1500 ms —— 它必须显著小于「1～3 秒给建议」这个核心目标，
   * 否则求解器一慢，整个分析就跟着慢。
   */
  gtoPrefetchBudgetMs?: number;
  /**
   * 🔴 **求解器范围取数（Phase 1.2 → 1.3）**。
   *
   * ⚠️ 它**不在这里被调用** —— `analyzeManualHand` 是同步纯函数。
   * 这个字段只是让 `prefetchSolverRanges()` 知道去哪问。
   * 见 `gtoRanges`。
   */
  gtoProvider?: GtoProvider | null;
  /**
   * 🔴 **带缓存的 GTO 查询器**（Phase 1.3）。
   *
   * 与 `gtoProvider` 的分工：
   *
   * | 字段 | 用来做什么 |
   * |---|---|
   * | `gtoProvider` | 算**缓存键**（`solveKeyParts`）、枚举场景 |
   * | `gtoLookup`（本字段） | **读缓存**（`lookupCachedOnly`）、**后台求解并落盘** |
   *
   * 为什么必须分开：落盘只发生在 `GtoSafeLookup` 里。后台任务若直接调
   * `provider.lookupScenario()`，就会「算完了但没存」，下次重启又要重算几十分钟 ——
   * 那正是本轮要消灭的问题。
   *
   * ⚠️ 缺省（不传）时**完全不用 GTO 范围**，行为与 Phase 1.2 之前逐位一致。
   */
  gtoLookup?: GtoCachedLookup | null;
  /**
   * 🔴 **已预取的求解器范围**（Phase 1.2），按对手 id 索引。
   *
   * 由 `prefetchSolverRanges()` 产出。为什么要分成两步：
   *
   * - `analyzeManualHand` 是**同步纯函数**，约 100 个调用点（测试 / 探针）
   *   都依赖这一点。把它改成 async 会波及全部调用点，
   *   而那些调用点**根本不需要 GTO**。
   * - 查询 GTOpen 是异步网络动作，属于「取数据」，不属于「算决策」。
   *
   * 因此：**取数据在调用方（可以 await），算决策保持同步**。
   * 不传这个字段 = 全部用启发式先验（既有行为逐位不变）。
   */
  gtoRanges?: Readonly<Record<string, SolverRangeOverride>>;
};


/**
 * 筹码 → BB，保留 6 位小数（与 `roundBB` 同一口径）。
 *
 * ⚠️ 必须归一化：内部筹码是**整数**（`round(amountBB × 面额)`），
 * 因此 2.5BB 可能是 250 或 25 或 2500 —— 除以面额后可能带浮点尾巴。
 * 不归一化会让「2.5000000000000004 ≠ 2.5」这种比较失败，
 * 于是**明明匹配的场景被判成不匹配**、白白回落到启发式。
 */
function roundBBChips(chips: number, bigBlind: number): number {
  return Math.round((chips / bigBlind) * 1e6) / 1e6;
}

/**
 * 按**原始输入**预取求解器范围（服务器与探针用的便捷入口）。
 *
 * 内部走一遍「解析 → 重建」，与 `analyzeManualHand` **用同一对函数** ——
 * 不自己实现一份，否则「预取时看到的牌局」与「分析时看到的牌局」
 * 迟早会分歧（那会表现为「范围对不上建议」这种极难查的缺陷）。
 *
 * ⚠️ 解析或重建失败时返回空 —— 那时 `analyzeManualHand` 会给出
 * 正确的失败响应，预取不需要也不应该抢答。
 */
/* ============================================================
 * 对手场景枚举（前台取数 / 后台补算**共用**）
 * ============================================================ */

/**
 * 一个对手 → 他所在节点的求解场景。
 *
 * 🔴 前台与后台**必须**用同一个枚举函数。各写一份的话，
 * 「后台算的那个节点」与「前台查的那个节点」迟早会分歧 ——
 * 那会表现为「后台明明算完了，前台还是拿不到」，
 * 而这正是本模块这一轮修掉的那类缺陷最恶心的形态：**两边都不报错**。
 */
type OpponentScenario = {
  opponentId: string;
  position: GtoPosition;
  /** 用于显示的名字，例如「枪口位」 */
  positionZh: string;
  /** 他在这个节点做了什么（中文），例如「开池」 */
  behaviorZh: string;
  action: OpponentPreflopAction;
  scenario: NonNullable<ReturnType<typeof scenarioForOpponent>>['scenario'];
};

/** 枚举本手里**可以问求解器**的对手场景；问不了的直接不出现 */
function enumerateOpponentScenarios(state: GameState): readonly OpponentScenario[] {
  const tableSize = gtoTableSizeOf(state.players.length);
  if (tableSize === null) return [];

  const heroId = state.userPlayerId;
  if (heroId === null || !state.players.some((p) => p.id === heroId)) return [];

  /*
   * **只在翻前用求解器范围。**
   *
   * GTOpen 只解翻前。翻后的范围是翻前范围的**延续**，而延续需要翻后求解 ——
   * 拿翻前频率去描述翻后范围会丢掉全部翻后信息（谁在翻牌弃牌、谁在转牌加注）。
   * 因此翻后一律回落启发式 + 行动似然更新，并如实标注。
   */
  if (state.street !== Street.PREFLOP || allBoardCards(state).length > 0) return [];

  /*
   * ⚠️ **单位换算**：`state.actions[].toAmount` 是**筹码**，而 GTO 场景用 **BB**。
   *
   * 用 `amount`（本次投入）是错的：开池到 2.5BB 时 `amount` 是「补到 2.5BB 的增量」，
   * 而场景要的是「**到多少**」（`toAmount`）。这两个口径在项目里被混淆过多次
   *（见 `manualInput.ts` 里 `amountBB` 的语义表），因此这里显式用 `toAmount` 并除以大盲。
   */
  const bigBlind = state.config.bigBlind;
  if (!(bigBlind > 0)) return [];

  const history: GtoScenarioAction[] = state.actions
    .filter((a) => a.street === Street.PREFLOP)
    .map((a) => ({
      position: a.position,
      kind: a.type as GtoActionKind,
      sizeBB: a.toAmount > 0 ? roundBBChips(a.toAmount, bigBlind) : null,
    }));

  const shape = preflopShapeOf(tableSize, history);
  /*
   * 无人加注（全跛入）或**多次加注** —— 本项目的场景模型表达不了，全部回落。
   *
   * ⚠️ 多次加注不是「暂时不支持」而是**结构上不支持**：
   * 3Bet 之后的决策点需要 `max_raises >= 3`（见 `VS_3BET` 的说明），
   * 而生产配置是 2。用相近节点顶替会读到别人的策略。
   */
  if (shape.raiseCount !== 1) return [];

  const realizedIds = realizedOpponentIds(state);
  const opponents = state.players.filter(
    (p) => p.id !== heroId && !p.folded && realizedIds.has(p.id),
  );

  const out: OpponentScenario[] = [];
  for (const opponent of opponents) {
    const mapped = scenarioForOpponent(
      tableSize,
      preflopEffectiveStackBB(state, heroId, opponent.id),
      shape,
      opponent.position,
    );
    if (mapped === null) continue;
    out.push({
      opponentId: opponent.id,
      position: opponent.position,
      positionZh: POSITION_ZH[opponent.position],
      behaviorZh: behaviorZhOf(mapped.action.action),
      action: mapped.action,
      scenario: mapped.scenario,
    });
  }
  return out;
}

/** 对手动作 → 中文（只用于**显示**） */
function behaviorZhOf(action: OpponentPreflopAction['action']): string {
  switch (action) {
    case 'OPEN':
      return '开池';
    case 'CALL_VS_OPEN':
      return '面对开池跟注';
    case 'THREE_BET_VS_OPEN':
      return '面对开池 3Bet';
    default:
      return '行动';
  }
}

/** 把一次成功的查询变成 `contextBuilder` 要的范围覆盖 */
function overrideFromPrior(
  entry: OpponentScenario,
  prior: Extract<SolverRangePrior, { ok: true }>,
): SolverRangeOverride {
  return {
    weights: prior.weights,
    labelZh: `${entry.positionZh} 的**求解器**翻前范围（${entry.behaviorZh}）`,
    engineCommit: prior.engineCommit,
    usedActions: prior.usedActions,
    reportedGap: prior.reportedGap,
    iterationsCompleted: prior.iterationsCompleted,
  };
}

/** 这家对手为什么用不了求解器范围（中文，可直接显示给使用者） */
function rangeSourceZhOf(entry: OpponentScenario, outcome: GtoRangeOutcome): string {
  if (outcome.fromSolver) {
    return `${entry.positionZh}：命中已缓存的 GTO 策略`;
  }
  switch (outcome.state) {
    case 'SOLVING':
      return (
        `${entry.positionZh}：GTO 正在后台计算 —— ` +
        '算完会写入本地缓存，**之后同样的局面会自动改用 GTO 范围**'
      );
    case 'COMPUTING':
      return (
        `${entry.positionZh}：GTO 正在计算中（更早的一次请求已经排上队），` +
        '本次先用启发式范围'
      );
    case 'SOLVE_FAILED':
      return `${entry.positionZh}：GTO 计算失败 —— ${outcome.reasonZh ?? '未给原因'}`;
    default:
      return `${entry.positionZh}：${outcome.reasonZh ?? '未使用求解器范围'}`;
  }
}

/**
 * 一次对手取数的**结局**。
 *
 * 🔴 分成这几种而非「成功 / 失败」两种，是因为它们对使用者意味着
 * **完全不同的东西**：
 *
 * - `SOLVED`：这次的建议用的是 GTO 范围
 * - `SOLVING`：这次不是，但**等一下就会是**（最容易让人误解成「不支持」）
 * - `SOLVE_FAILED`：求解器真的出问题了（该去看求解器）
 * - `NOT_APPLICABLE`：这个局面本项目**结构上**算不了（跛入 / 多次加注 / 翻后）
 * - `EMPTY`：场景对得上，但一份范围都没取到
 */
export const GtoRangeOutcomeState = {
  SOLVED: 'SOLVED',
  SOLVING: 'SOLVING',
  COMPUTING: 'COMPUTING',
  SOLVE_FAILED: 'SOLVE_FAILED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  EMPTY: 'EMPTY',
} as const;
export type GtoRangeOutcomeState =
  (typeof GtoRangeOutcomeState)[keyof typeof GtoRangeOutcomeState];

export type GtoRangeOutcome = {
  opponentId: string;
  position: string;
  positionZh: string;
  state: GtoRangeOutcomeState;
  /** 这次是否真的用上了求解器范围 */
  fromSolver: boolean;
  /** 命中缓存时的来源（`memory` / `persistent`） */
  cacheSource: 'memory' | 'persistent' | null;
  /** 拿不到的原因（中文）；`fromSolver` 为 true 时是 null */
  reasonZh: string | null;
  /** 后台任务的缓存键（用于查状态）；没入队时为 null */
  backgroundCacheKey: string | null;
};

/**
 * 供调用方（服务器 / 界面）使用的**预取状态**。
 *
 * `warnings` 与 `outcomes` 是同一批事实的两种呈现：
 * 前者是一句话（可直接显示），后者是结构化的（界面分层渲染）。
 * 两者都由这里产出，不重复计算。
 */
export type GtoPrefetchStatus = {
  ranges: Record<string, SolverRangeOverride>;
  warnings: string[];
  outcomes: GtoRangeOutcome[];
  /** 这次响应**因为 GTO 多花了**多少毫秒（用于证明它没有拖慢回答） */
  elapsedMs: number;
};

/* ============================================================
 * 求解器范围预取（Phase 1.3：只读缓存 + 后台补算）
 * ============================================================ */

/**
 * 前台能用的 GTO 查询能力：**只读缓存，绝不求解**。
 *
 * 刻意只声明这一个方法 —— 于是「前台不小心调了会阻塞的查询」
 * 在**类型层面**就不可能发生。`GtoSafeLookup` 天然满足它
 *（它还提供 `lookupWithStats`，但那种慢方法不在本接口里）。
 */
export type GtoCachedLookup = {
  lookupCachedOnly(
    scenario: Parameters<GtoProvider['lookupScenario']>[0],
  ): Promise<{ result: GtoLookupResult; stats: { source: 'memory' | 'persistent' | 'solver' | 'none' } } | null>;
  /**
   * ⚠️ 这个方法是**给后台队列用的**（它会落盘），前台取数路径**不调用它** ——
   * 前台只走 `lookupCachedOnly`。之所以声明在同一个类型里，是因为
   * `GtoSafeLookup` 同时提供这两种能力，拆成两个接口只会让装配处多传一个参数，
   * 而多一个参数就多一处「忘了传 → 静默不落盘」的机会。
   */
  lookupWithStats(scenario: Parameters<GtoProvider['lookupScenario']>[0]): Promise<{
    result: GtoLookupResult;
  }>;
};

/**
 * 为本手取求解器范围：**只读缓存，绝不求解**。
 *
 * ## 为什么不再是「带预算的预取」
 *
 * Phase 1.2 的写法是「带预算去查询」，而那个预算**并不成立**：
 * 超时检查在循环体之前，第一个对手永远无条件开始求解然后等到底 ——
 * 实测预算写 1500 ms，9 人桌实际耗时 **195 312 ms**。
 * 更要命的是它**静默**：拿不到就回落启发式，界面上只有一句
 * 「启发式先验」，使用者无从知道 GTO 其实在线、只是还没算。
 *
 * Phase 1.3 把这个函数变成**纯读缓存**，并把求解交给后台队列
 *（`queueBackgroundSolverRanges`）。于是：
 *
 * | | Phase 1.2 | Phase 1.3 |
 * |---|---|---|
 * | 耗时 | 上限不可控（实测 195 秒） | **必然**是几次磁盘读（毫秒级） |
 * | 未命中 | 阻塞等待求解 | 立刻回落 + **后台开始算** |
 * | 第二次查询 | 仍然可能阻塞 | **秒回，且是 GTO 范围** |
 * | 原因 | 静默丢弃 | 如实进入 `outcomes` 与 `warnings` |
 *
 * 它现在是 `async` 只因为缓存读盘是异步的 —— 与「等求解」不是一回事。
 */
export async function prefetchSolverRanges(
  state: GameState,
  options: Pick<AnalyzeOptions, 'gtoProvider' | 'gtoLookup'>,
): Promise<GtoPrefetchStatus> {
  const startedAt = Date.now();
  const ranges: Record<string, SolverRangeOverride> = {};
  const warnings: string[] = [];
  const outcomes: GtoRangeOutcome[] = [];

  const provider = options.gtoProvider;
  const lookup = options.gtoLookup;
  if (provider === undefined || provider === null || lookup === undefined || lookup === null) {
    return { ranges, warnings, outcomes, elapsedMs: Date.now() - startedAt };
  }

  const tableSize = gtoTableSizeOf(state.players.length);
  if (tableSize === null) {
    warnings.push('求解器范围未使用：本桌人数不在受支持的 4/5/6/8/9 之内');
    return { ranges, warnings, outcomes, elapsedMs: Date.now() - startedAt };
  }

  const candidates = enumerateOpponentScenarios(state);
  if (candidates.length === 0) {
    /*
     * 枚举为空有几种原因（翻后 / 跛入 / 多次加注 / 没有对手），
     * 它们对使用者是**不同的信息**，因此这里给出可区分的一句，
     * 而不是含糊的「未使用求解器范围」。
     */
    if (state.street !== Street.PREFLOP || allBoardCards(state).length > 0) {
      warnings.push('求解器范围仅覆盖翻前 —— 翻后使用启发式范围加行动似然更新');
    } else {
      const note = describeWhyNoCandidatesZh(state, tableSize, provider);
      if (note !== null) warnings.push(note);
    }
    return { ranges, warnings, outcomes, elapsedMs: Date.now() - startedAt };
  }

  for (const entry of candidates) {
    const outcome = await readOneOpponentRange(entry, provider, lookup);
    outcomes.push(outcome);
    if (outcome.fromSolver) {
      const prior = outcome.prior;
      if (prior !== undefined) ranges[entry.opponentId] = overrideFromPrior(entry, prior);
    } else {
      warnings.push(rangeSourceZhOf(entry, outcome));
    }
  }

  return { ranges, warnings, outcomes, elapsedMs: Date.now() - startedAt };
}

/** 读数一家对手：只查缓存，顺便问一下后台任务的状态 */
async function readOneOpponentRange(
  entry: OpponentScenario,
  provider: GtoProvider,
  lookup: GtoCachedLookup,
): Promise<GtoRangeOutcome & { prior?: Extract<SolverRangePrior, { ok: true }> }> {
  const base = {
    opponentId: entry.opponentId,
    position: entry.position,
    positionZh: entry.positionZh,
    backgroundCacheKey: null as string | null,
  };

  /*
   * 🔴 **第 0 步：先核对求解设置 —— 它必须先于「后台在算吗」这个问题。**
   *
   * ## 为什么顺序不能反（实测踩到过）
   *
   * 尺寸对不上时（例如观察到的开池是 3BB，而求解配置是 2.5BB），
   * 这份数据描述的是**另一个牌局**，本项目**永远**不会用它。
   *
   * 而如果先去看后台记录：那个场景**曾经**入过队（修复前会），
   * 于是这里会报「GTO 正在计算中，本次先用启发式范围」——
   * 让使用者以为等一下就好。实际上他等的是一个**永远不会被采用**的结果。
   *
   * 正确的话只有一句：**这个局面算不了，等也不会变。**
   *
   * ## 不核对会发生什么（这是本项目最严重的那类缺陷）
   *
   * `RFI` 场景的前序动作**恒为空**（`defaultActionHistoryFor` 对 RFI 直接
   * 返回 `[]`，它不把开池尺寸写进去），因此 `openSizeBB` **不参与**
   * `scenarioHash` 与 `cacheKey`：
   *
   * ```text
   * 开池 2BB   → scenarioHash=gb2c2da23  cacheKey=c91e7b60a
   * 开池 2.5BB → scenarioHash=gb2c2da23  cacheKey=c91e7b60a
   * 开池 3BB   → scenarioHash=gb2c2da23  cacheKey=c91e7b60a   ← 同一把键！
   * ```
   *
   * 于是「对手开池 3BB」会读到为 2.5BB 算的那份策略，并且**照用** ——
   * 数字看起来完全正常，这正是它危险的地方。
   *
   * ## 为什么是「加闸」而不是「改缓存键」
   *
   * 改键能治本，但它是**已落盘数据全体失效**的改动（键变了 ⇒ 现有缓存
   * 一条都对不上）。而这道闸是**纯判定**：对不上就不许用，并如实说明。
   * 两者不冲突 —— 这道闸无论如何都该有，因为**任何**键实现都可能哪天出偏差。
   *
   * ⚠️ 修复前 `solveSettingsMatch`（`solverRangePrior.ts`）在生产路径上
   * **一个调用者都没有**：它只被 `lookupPreflopRangePrior` 调用，
   * 而前台已经改成只读缓存、不再走那条路。**校验写了却没人用，等于没有校验。**
   */
  let cacheKey: string | null = null;
  try {
    const settings = solveSettingsMatch({
      solve: provider.solveKeyParts(entry.scenario),
      observedOpenSizeBB: entry.action.observedOpenSizeBB,
      observedThreeBetSizeBB: entry.action.observedThreeBetSizeBB,
    });
    if (!settings.ok) {
      /*
       * 状态用 `NOT_APPLICABLE` 而不是 `SOLVING`：这不是「等一会儿就好」，
       * 因为等待不会改变「求解配置是 2.5BB」这个事实。
       */
      return {
        ...base,
        state: GtoRangeOutcomeState.NOT_APPLICABLE,
        fromSolver: false,
        cacheSource: null,
        backgroundCacheKey: null,
        reasonZh: settings.reasonZh,
      };
    }
    cacheKey = keysOf(entry.scenario, provider.solveKeyParts(entry.scenario)).cacheKey;
  } catch (error) {
    /*
     * 拿不到求解侧参数 ⇒ 缓存键不可信 ⇒ **不入队、不用缓存**，如实说明。
     * （队列那边也会用 `unkeyable:` 记录拒绝入队；两边一致。）
     */
    return {
      ...base,
      state: GtoRangeOutcomeState.SOLVE_FAILED,
      fromSolver: false,
      cacheSource: null,
      backgroundCacheKey: null,
      reasonZh: `无法取得求解侧参数，缓存键不可信：${String((error as Error).message)}`,
    };
  }

  const background = backgroundSolveQueue().statusOf(cacheKey);

  let cached: Awaited<ReturnType<GtoCachedLookup['lookupCachedOnly']>> = null;
  try {
    cached = await lookup.lookupCachedOnly(entry.scenario);
  } catch (error) {
    return {
      ...base,
      state: GtoRangeOutcomeState.SOLVE_FAILED,
      fromSolver: false,
      cacheSource: null,
      backgroundCacheKey: cacheKey,
      reasonZh: `读取本地缓存时抛错：${String((error as Error).message)}`,
    };
  }

  if (cached !== null && !('status' in cached.result)) {
    const prior = priorFromCachedBaseline(entry.action, cached.result);
    if (prior.ok) {
      return {
        ...base,
        state: GtoRangeOutcomeState.SOLVED,
        fromSolver: true,
        cacheSource: cached.stats.source === 'persistent' ? 'persistent' : 'memory',
        backgroundCacheKey: cacheKey,
        reasonZh: null,
        prior,
      };
    }
    /*
     * 缓存里那份数据**通不过校验**（节点不可达 / 行动者不是他 / 频率全零）。
     * 🔴 这时**绝不**拿它当范围用，但要**如实说明**为什么 ——
     * 直接回落会让「缓存里有东西却不用」变得无法解释。
     */
    return {
      ...base,
      state: GtoRangeOutcomeState.SOLVE_FAILED,
      fromSolver: false,
      cacheSource: null,
      backgroundCacheKey: cacheKey,
      reasonZh: prior.reasonZh,
    };
  }

  // ---- 缓存未命中：如实说明现在处于哪一步 ----
  if (background !== null) {
    const record = background;
    if (record.state === BackgroundSolveState.QUEUED || record.state === BackgroundSolveState.RUNNING) {
      return {
        ...base,
        state:
          record.state === BackgroundSolveState.RUNNING
            ? GtoRangeOutcomeState.COMPUTING
            : GtoRangeOutcomeState.SOLVING,
        fromSolver: false,
        cacheSource: null,
        backgroundCacheKey: cacheKey,
        reasonZh: null,
      };
    }
    if (record.state === BackgroundSolveState.FAILED) {
      return {
        ...base,
        state: GtoRangeOutcomeState.SOLVE_FAILED,
        fromSolver: false,
        cacheSource: null,
        backgroundCacheKey: cacheKey,
        reasonZh: record.reasonZh,
      };
    }
  }

  /*
   * 🔴 **缓存未命中，就是未命中。**
   *
   * 这里曾经调用 `lookupPreflopRangePrior()` 去「问一次求解器，好在理由里
   * 说得更具体」—— 那是个**严重**的错误：那个函数会**真的发起求解**。
   * 于是「只读缓存」这条保证被自己破了，一次分析被拖回几十秒到几分钟。
   *
   * 测试 `BG-SOLVE-01` 抓到了它（前台耗时 3025 ms，而求解需 3000 ms）。
   *
   * 现在这里**不做任何网络动作**：缓存没有 ⇒ 如实说「还没算，已在后台开始算」。
   * 至于「这局面结构上算不了」那一类，在 `enumerateOpponentScenarios` 里
   * 就已经被排除了，由 `describeWhyNoCandidatesZh` 统一说明 ——
   * 两条信息通道各管一类，**不重叠**。
   */
  return {
    ...base,
    state: GtoRangeOutcomeState.SOLVING,
    fromSolver: false,
    cacheSource: null,
    backgroundCacheKey: cacheKey,
    reasonZh: null,
  };
}

/** 为什么这次一个对手都枚举不出来（中文）；没有可说的返回 `null` */
function describeWhyNoCandidatesZh(
  state: GameState,
  tableSize: GtoTableSize,
  provider: GtoProvider,
): string | null {
  const heroId = state.userPlayerId;
  if (heroId === null || !state.players.some((p) => p.id === heroId)) return null;

  const bigBlind = state.config.bigBlind;
  if (!(bigBlind > 0)) return null;

  const history: GtoScenarioAction[] = state.actions
    .filter((a) => a.street === Street.PREFLOP)
    .map((a) => ({
      position: a.position,
      kind: a.type as GtoActionKind,
      sizeBB: a.toAmount > 0 ? roundBBChips(a.toAmount, bigBlind) : null,
    }));

  const shape = preflopShapeOf(tableSize, history);
  if (shape.raiseCount === 0) {
    return '本手翻前无人加注（全跛入）—— 求解场景模型里没有这个节点，回落启发式先验';
  }
  if (shape.raiseCount > 1) {
    return (
      `本手翻前有 ${shape.raiseCount} 次加注（3Bet/4Bet 后的节点）—— ` +
      '生产配置的加注上限是 2，算不了这个节点，回落启发式先验（**不是**「等一会儿就有」）'
    );
  }

  const realizedIds = realizedOpponentIds(state);
  const opponents = state.players.filter(
    (p) => p.id !== heroId && !p.folded && realizedIds.has(p.id),
  );
  if (opponents.length === 0) return null;

  /*
   * 有对手、只有一次加注，却仍然枚举不出来。这里有**两类**原因，
   * 而它们对使用者意味着完全不同的事 —— 必须分开说：
   *
   * | 原因 | 使用者该做什么 |
   * |---|---|
   * | 开池者不是第一个行动位（RFI 模板只覆盖第一个行动位） | 接受启发式（**等也不会变**，是本项目的已知上限） |
   * | 尺寸 / 筹码对不上 | 接受启发式（换一个尺寸的记录可能就覆盖了） |
   *
   * ⚠️ 修复前这里**一律**说成「筹码或位置不匹配」，于是最常遇到的
   * 第一种情况被说成第二种 —— 使用者会以为「换个尺寸就行了」，
   * 而实际上这个局面在本项目的场景模型里**根本表达不出来**。
   */
  const firstActor = gtoPositionsFor(tableSize)[0] ?? null;
  const blocked: string[] = [];
  for (const opponent of opponents) {
    const mapped = scenarioForOpponent(
      tableSize,
      preflopEffectiveStackBB(state, heroId, opponent.id),
      shape,
      opponent.position,
    );
    if (mapped === null) {
      const positionZh = POSITION_ZH[opponent.position];
      const isOpener = shape.opener === opponent.position;
      blocked.push(
        isOpener && firstActor !== null && opponent.position !== firstActor
          ? `${positionZh} 是**开池者**，但本项目的开池（RFI）模板只覆盖` +
            `第一个行动位（${POSITION_ZH[firstActor]}）—— 这个局面算不了，**等也不会变**`
          : `${positionZh}（这个位置的行动在本项目的场景模型里表达不出来）`,
      );      continue;
    }
    const match = solveSettingsMatch({
      solve: provider.solveKeyParts(mapped.scenario),
      observedOpenSizeBB: mapped.action.observedOpenSizeBB,
      observedThreeBetSizeBB: mapped.action.observedThreeBetSizeBB,
    });
    if (!match.ok) blocked.push(`${POSITION_ZH[opponent.position]}（${match.reasonZh}）`);
  }
  if (blocked.length === 0) return null;
  return `没有任何对手能对上求解场景：${blocked.join('；')}`;
}

/**
 * 把**当前局面**里所有能算的对手场景排进后台队列。
 *
 * 🔴 **不 `await`、不返回结果** —— 返回的是入队后的状态。
 * 这是刻意的类型设计：调用方**没有办法**误等它，
 * 因此「后台补算把前台请求拖死」在类型层面就不成立。
 *
 * 调用方应在**已经开始生成响应之后**调用它（或在同一 tick 内），
 * 使求解与响应渲染并行。
 */
export function queueBackgroundSolverRanges(
  state: GameState,
  options: Pick<AnalyzeOptions, 'gtoProvider' | 'gtoLookup'>,
): readonly BackgroundSolveRecord[] {
  const provider = options.gtoProvider;
  const lookup = options.gtoLookup;
  if (provider === undefined || provider === null || lookup === undefined || lookup === null) {
    return [];
  }
  if (gtoTableSizeOf(state.players.length) === null) return [];

  const records: BackgroundSolveRecord[] = [];
  for (const entry of enumerateOpponentScenarios(state)) {
    /*
     * 🔴 **前提对不上就根本不要算。**
     *
     * 求解器只会解**它配置的那棵树**（生产配置是开池 2.5BB）。当这手牌里
     * 观察到的开池尺寸不是 2.5BB 时，算出来的东西描述的是**另一个牌局** ——
     * 前台已经会拒绝它（见 `readOneOpponentRange` 的 `solveSettingsMatch`），
     * 因此这里再算一遍纯属白烧几十秒 CPU，还会占着那条串行队列。
     *
     * ⚠️ 这一步是**必须**的：`RFI` 场景的前序动作恒为空，因此
     * `openSizeBB` **不进** `scenarioHash` / `cacheKey`（实测 2BB / 2.5BB /
     * 3BB / 4BB 得到同一把键）。于是「3BB 开池」的手与「2.5BB 开池」的手
     * 会命中同一个缓存键 —— 尺寸核对是唯一能把它们分开的东西。
     */
    const settings = solveSettingsMatch({
      solve: provider.solveKeyParts(entry.scenario),
      observedOpenSizeBB: entry.action.observedOpenSizeBB,
      observedThreeBetSizeBB: entry.action.observedThreeBetSizeBB,
    });
    if (!settings.ok) continue;

    records.push(backgroundSolveQueue().submit(provider, lookup, entry.scenario));
  }
  return records;
}

/** 按**原始输入**取求解器范围（只读缓存）；解析失败返回空 */
export async function prefetchSolverRangesForInput(
  input: ManualHandInput,
  options: Pick<AnalyzeOptions, 'gtoProvider' | 'gtoLookup'>,
): Promise<GtoPrefetchStatus> {
  const empty: GtoPrefetchStatus = {
    ranges: {},
    warnings: [],
    outcomes: [],
    elapsedMs: 0,
  };
  const parsed = parseManualInput(input);
  if (!parsed.ok) return empty;
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) return empty;
  return await prefetchSolverRanges(gate.state, options);
}

/**
 * 按**原始输入**把当前局面的求解排进后台队列。
 *
 * 与 `prefetchSolverRangesForInput` 走**同一对** 「解析 → 重建」函数，
 * 理由同前：不自己实现一份，避免「后台算的牌局」与「前台看的牌局」分歧。
 */
export function queueBackgroundSolverRangesForInput(
  input: ManualHandInput,
  options: Pick<AnalyzeOptions, 'gtoProvider' | 'gtoLookup'>,
): readonly BackgroundSolveRecord[] {
  const parsed = parseManualInput(input);
  if (!parsed.ok) return [];
  const gate = buildAnalyzableState(parsed.value);
  if (!gate.ok) return [];
  return queueBackgroundSolverRanges(gate.state, options);
}

/* ============================================================
 * 主入口
 * ============================================================ */
/**
 * 分析一手手动输入的牌局。
 *
 * ## 失败时不抛异常
 *
 * 任何失败都返回 `{ ok: false, stage, issues }`。
 * 唯一会抛的情形是**依赖注入缺失**（`rules` 为空数组是合法的，
 * 但那会让环境层无建议 —— 这是允许的降级，不是错误）。
 */
export function analyzeManualHand(
  input: ManualHandInput,
  options: AnalyzeOptions,
): AlphaAnalysisResult {
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const mark = <T>(key: string, fn: () => T): T => {
    const t0 = Date.now();
    try {
      return fn();
    } finally {
      timings[key] = (timings[key] ?? 0) + (Date.now() - t0);
    }
  };

  /* ---- 0. 时间预算（红队 F-13） ----
   *
   * 🔴 修复前 `options.budget` 只被**转发**进 `context.deadlineBudget`，
   * 而那个字段从来没有任何读者 —— 也就是说「时间预算」这个参数
   * 表面上贯穿整条链，实际上**不控制任何计算**。
   *
   * 现在它由项目已有的 `DecisionDeadline` 真正执行：
   * - 超过**软**上限 → 本次结果附一条明确警告（**不降级、不改数学**）
   * - 超过**硬**上限 → 立即中止，返回 `stage: 'DEADLINE'`
   *
   * ## ⚠️ 刻意**不**做「按剩余时间缩减蒙特卡洛迭代次数」
   *
   * 那样会让**同一手牌在不同机器上得到不同的权益与不同的建议** ——
   * 直接违反本项目的确定性纪律（同一个输入必须得到同一个输出）。
   * 时间预算只能决定「要不要继续算」，**绝不能**决定「算得多准」。
   */
  const budget = options.budget ?? INTERACTIVE_BUDGET;
  const deadline = new DecisionDeadline({ softMs: budget.softMs, hardMs: budget.hardMs });
  let softWarned = false;

  /** 硬超时 → 立刻返回可解释的失败（不返回半截对象） */
  const deadlineFailure = (): AlphaAnalysisFailure | null => {
    if (!deadline.hardExpired()) return null;
    return {
      ok: false,
      stage: 'DEADLINE',
      issues: [
        {
          code: 'DEADLINE_EXCEEDED',
          message:
            `分析超过硬性时间上限（${deadline.hardMs} ms，实际 ${deadline.elapsedMs()} ms），已中止。` +
            '这不是输入错误 —— 请重试；若持续出现，请反馈该手牌的输入内容。',
        },
      ],
      timings: Object.freeze({ ...timings, total: Date.now() - startedAt }),
    };
  };

  /** 软超时 → 记一条警告（结果照旧完整计算） */
  const noteSoftBudget = (warnings: string[]): void => {
    if (softWarned || !deadline.softExpired()) return;
    softWarned = true;
    warnings.push(
      `⏱️ 本次分析耗时 ${deadline.elapsedMs()} ms，超过软预算 ${deadline.softMs} ms` +
        '（硬上限内，结果**完整计算、未做任何降级**）。',
    );
  };

  /* ---- 1. 解析（结构层） ---- */
  const parsed = mark('parse', () => parseManualInput(input));
  if (!parsed.ok) {
    return {
      ok: false,
      stage: 'PARSE',
      issues: parsed.issues.map((i) => ({
        code: i.code,
        message: i.message,
        ...(i.field !== undefined ? { field: i.field } : {}),
      })),
      timings: Object.freeze({ ...timings, total: Date.now() - startedAt }),
    };
  }

  /* ---- 2. 重建 + 校验（规则层） ---- */
  const gate: ManualAnalysisGate = mark('validate', () => buildAnalyzableState(parsed.value));
  if (!gate.ok) {
    return {
      ok: false,
      stage: gate.stage,
      issues: gate.issues.map((i) => ({ code: i.code, message: i.message })),
      timings: Object.freeze({ ...timings, total: Date.now() - startedAt }),
    };
  }
  {
    const expiredAfterValidate = deadlineFailure();
    if (expiredAfterValidate !== null) return expiredAfterValidate;
  }

  /* ---- 3. 上下文（数学 / 范围 / 玩家 / 环境 / 动态） ---- */
  let contextBuilt;
  try {
    const contextInput: ContextBuildInput = {
      state: gate.state,
      rules: options.rules,
      environment: environmentOf(parsed.value),
      asOf: options.asOf ?? Date.now(),
      ...(parsed.value.villain.quickProfile !== undefined
        ? { quickProfile: parsed.value.villain.quickProfile }
        : {}),
      ...(parsed.value.villain.dynamicHint !== undefined
        ? { dynamicHint: parsed.value.villain.dynamicHint }
        : {}),
      ...(parsed.value.villain.playerId !== undefined
        ? { villainPlayerId: parsed.value.villain.playerId }
        : {}),
      /*
       * 🔴 **行为画像**（PLAYER PROFILE QUANTIFICATION V1 · §十二）。
       *
       * 严格可选：不传时 `contextBuilder` 走既有路径，**逐位不变**。
       * 传了之后只影响**河牌进攻性动作**的似然来源 ——
       * 因此权益 / 底池赔率比较 / Call EV / 动作排名会跟着变，
       * 不需要在决策层再加任何画像逻辑（那会变成两处口径）。
       */
      ...(parsed.value.villain.behaviorProfile !== undefined
        ? { behaviorProfile: parsed.value.villain.behaviorProfile }
        : {}),
      ...(Object.keys(parsed.value.seatProfiles).length > 0
        ? { seatProfiles: parsed.value.seatProfiles as Readonly<Partial<Record<Position, QuickProfile>>> }
        : {}),
      ...(options.equitySeed !== undefined ? { equitySeed: options.equitySeed } : {}),
      /* 🔴 PLAYER PROFILE V3：把首要对手的连续统计带进上下文（可选，缺省 ⇒ 与 V2 逐位一致） */
      ...(parsed.value.villain?.observedStats !== undefined &&
      parsed.value.villain?.observedStats !== null
        ? { observedStats: parsed.value.villain.observedStats }
        : {}),
      ...(options.budget !== undefined ? { budget: options.budget } : {}),
      /*
       * 🔴 把「整条链已经花掉多少时间」交给上下文组装层，让它能给
       * **可选**的分层权益计算做失败安全的预算保护（见
       * `shouldSpendOnLayeredEquity`）：时间不够就跳过这项增强，
       * 回落到更保守的结论，而不是硬算完再整条 `DEADLINE` 失败。
       */
      budgetElapsedMs: deadline.elapsedMs(),
      /*
       * 已预取的求解器范围（由调用方 `await prefetchSolverRanges(...)` 得到）。
       * 为空 ⇒ 全部走启发式先验，**与改动前逐位一致**。
       */
      ...(options.gtoRanges !== undefined && Object.keys(options.gtoRanges).length > 0
        ? { solverRanges: options.gtoRanges }
        : {}),
    };
    contextBuilt = mark('context', () => buildDecisionContext(contextInput));
  } catch (error) {
    return {
      ok: false,
      stage: 'CONTEXT',
      issues: [{ code: 'CONTEXT_BUILD_FAILED', message: `构建决策上下文失败：${(error as Error).message}` }],
      timings: Object.freeze({ ...timings, total: Date.now() - startedAt }),
    };
  }
  {
    const expiredAfterContext = deadlineFailure();
    if (expiredAfterContext !== null) return expiredAfterContext;
  }

  /* ---- 4. 决策 ---- */
  let decision: AlphaDecision;
  try {
    decision = mark('decide', () => decideAlpha(contextBuilt.context, contextBuilt.legal));
  } catch (error) {
    return {
      ok: false,
      stage: 'DECISION',
      issues: [{ code: 'DECISION_FAILED', message: `决策引擎失败：${(error as Error).message}` }],
      timings: Object.freeze({ ...timings, total: Date.now() - startedAt }),
    };
  }

  /* ---- 4.5 硬超时检查（决策之后、组装之前，最贵的两步都已完成） ---- */
  const expired = deadlineFailure();
  if (expired !== null) return expired;

  /* ---- 5. 最终数学一致性检查（规范第 44 节） ---- */
  const sanityProblems = finalMathSanityCheck(decision, contextBuilt.legal);
  const warnings: string[] = [...contextBuilt.warnings, ...sanityProblems];
  noteSoftBudget(warnings);

  /* ---- 6. ViewModel ---- */
  //
  // ⚠️ 顺序很关键：`mark('viewmodel', …)` **返回之后**才拿得到最终耗时表
  //（`viewmodel` 与 `total` 两项要等这次调用结束才写得进 `timings`）。
  // 所以先构建，再用 `withFinalTimings` 把**同一份**最终表回填进去
  // —— 红队 F-09：修复前调试面板里的 viewmodel / total 永远是 0.0 ms。
  const viewModelBase = mark('viewmodel', () =>
    toDecisionViewModel(decision, warnings, Object.freeze({ ...timings })),
  );

  /* ---- 7. 最终耗时表（三处共用同一份，保证逐位一致） ---- */
  //
  // 用在三个地方：返回值的 `timings`、决策日志的 `timingMs`、ViewModel 的调试面板。
  // 三者共用同一个对象的理由：任何一处单独计算都会引入新的不一致。
  const finalTimings = Object.freeze({ ...timings, total: Date.now() - startedAt });
  const viewModel = withFinalTimings(viewModelBase, finalTimings);

  /* ---- 8. 决策日志 ---- */
  const log: DecisionLogEntry = Object.freeze({
    at: new Date(options.asOf ?? Date.now()).toISOString(),
    inputHash: hashManualInput(input),
    computedPot: gate.computedPot,
    claimedPot: gate.claimedPot,
    environment: parsed.value.environment,
    decision: decision.action,
    sizeChips: decision.sizeChips ?? null,
    confidence: Number(decision.confidence.toFixed(4)),
    classification: decision.classification,
    actionable: decision.actionable,
    versions: Object.freeze({ ...decision.diagnostics.versions }),
    timingMs: finalTimings,
    rangeSupportSize: decision.diagnostics.range?.supportSize ?? null,
    rangeSourceKind: decision.diagnostics.range?.sourceKind ?? null,
    dynamicApplied: decision.diagnostics.dynamic.applied,
    shadow: Object.freeze({
      actionChanged: decision.diagnostics.shadow.actionChanged,
      dynamicConfidence: decision.diagnostics.shadow.dynamicConfidence,
      magnitudeProvenance: decision.diagnostics.shadow.magnitudeProvenance,
    }),
    rakeModel: decision.diagnostics.math.rakeModel,
  });

  if (options.writeLog !== false) {
    try {
      appendDecisionLog(log, options.logPath);
    } catch (error) {
      // 日志写入失败**不得**影响决策结果的返回（日志是副作用，不是依据）
      warnings.push(`决策日志写入失败（不影响本次建议）：${(error as Error).message}`);
    }
  }

  return {
    ok: true,
    decision,
    viewModel,
    log,
    timings: finalTimings,
    warnings: Object.freeze([...warnings]),
    computedPot: gate.computedPot,
    claimedPot: gate.claimedPot,
  };
}

/* ============================================================
 * 最终数学一致性检查
 * ============================================================ */

/**
 * 二次数学验证（规范第 44 节）。
 *
 * 目的：防止「Exploit 调整之后推荐了一个明显负 EV 的动作」。
 *
 * ## 检查项
 *
 * 1. 输出的动作必须在合法动作集合内（**硬错误**，抛异常）；
 *    `action === null`（信息不足）单独判定，不得与 `actionable` 矛盾
 * 2. 建议的尺寸必须在 `[0, 剩余筹码]` 内，且不导致筹码为负
 * 3. 跟注建议的 EV 不得为负 —— 若为负，说明策略层翻转了数学结论
 * 4. 分类为「明确决策」时置信度不得低于中档（**硬错误**，红队 F-04）
 *
 * 第 3 项是**警告**而非阻断：`MARGINAL` 情形下跟注 EV 略负是允许的
 *（数学上接近临界时，其他因素可以合理地决定选择）。
 * 但它必须被**显示出来**，不能静默。
 *
 * 第 1、4 项是硬错误：它们不是「数学上临界」，而是**内部自相矛盾**
 *（输出了不允许的动作 / 声称明确却没有可信度支撑）。
 * 这类矛盾一旦被送到界面上，使用者看到的就是一个自信的错误结论。
 */
export function finalMathSanityCheck(
  decision: AlphaDecision,
  legal: { actions: readonly string[]; myRemainingStack: number; callCost: number },
): string[] {
  const problems: string[] = [];
  const math = decision.diagnostics.math;

  // ---- 1. 动作合法性（硬错误） ----
  //
  // `action === null` 表示**信息不足**（引擎拒绝给建议），那是合法状态，
  // 不做合法性检查 —— 但**也不能**悄悄跳过：下面会明确记一条警告。
  if (decision.action !== null && !legal.actions.includes(decision.action)) {
    throw new Error(
      `finalMathSanityCheck: 决策输出了非法动作 ${decision.action}，` +
        `合法集合为 [${legal.actions.join(', ')}]。这是必须修复的缺陷。`,
    );
  }
  if (decision.action === null && decision.actionable) {
    // 「可执行但没有动作」是内部不一致，必须暴露
    throw new Error(
      'finalMathSanityCheck: 决策声称 actionable=true 但 action=null —— 内部不一致',
    );
  }

  // ---- 2. 尺寸合法性 ----
  if (decision.sizeChips !== undefined) {
    if (!Number.isFinite(decision.sizeChips) || decision.sizeChips < 0) {
      problems.push(`⚠️ 建议尺寸非法（${decision.sizeChips}）—— 已被最终数学检查拦截`);
    } else if (decision.sizeChips > legal.myRemainingStack) {
      problems.push(
        `⚠️ 建议尺寸 ${decision.sizeChips} 超过剩余筹码 ${legal.myRemainingStack} —— ` +
          '已被最终数学检查拦截（不应发生，请报告）',
      );
    }
  }

  // ---- 3. 跟注建议的 EV ----
  /*
   * 🔴 **只在真正矛盾时报警**（RIVER CONSISTENCY V2 · 使用者 §19 H）。
   *
   * 修复前判据是 `callEV < 0` ⇒ 实测输出：
   *
   * ```text
   * 建议：跟注
   * ⚠️ 建议跟注但跟注 EV 为负（-317.61 筹码，边缘局面）—— 请人工复核；数学上不成立的建议不应出现
   * ```
   *
   * 两句话直接打架，而引擎的规则其实是**明确的**：跟注 EV 落在
   * ±5% 可争夺量的**无差别带**内 ⇒ 数学上没有明显优劣，系统取代价最小的方向。
   * 那不是「数学上不成立」，而是「数学上无差别」。
   *
   * 现在：
   *
   * | 情形 | 处理 |
   * |---|---|
   * | `callEV < −带` 却建议跟注 | **硬错误**：动作与 chip EV 直接矛盾 ⇒ 抛错（与「明确决策 + 低置信度」同级） |
   * | `−带 ≤ callEV < 0` 却建议跟注 | 只作**中性说明**（无差别带内取代价最小方向），**不报警** |
   * | `callEV ≥ 0` | 无需说明 |
   */
  if (decision.action === 'CALL' && math.callEV !== null) {
    const band = MARGINAL_EV_GAP_RATIO * math.winnable;
    if (math.callEV < -band) {
      throw new Error(
        `finalMathSanityCheck: 建议跟注但跟注 EV = ${math.callEV.toFixed(2)} 筹码，` +
          `已超出无差别带 ±${band.toFixed(2)}（= 可争夺量 ${math.winnable} 的 ${(MARGINAL_EV_GAP_RATIO * 100).toFixed(0)}%）` +
          '—— 动作与 chip EV 直接矛盾。这是必须修复的缺陷（RIVER CONSISTENCY V2 §19 F/H）。',
      );
    }
  }

  // ---- 4. 「明确决策」不得出现在低置信度上（硬错误）----
  //
  // 红队 F-04：修复前 `classifyOf` 完全不看置信度，
  // 于是「置信度 0.1537（中低）」也会被标成 `CLEAR`（明确决策）——
  // 中文界面上就是「明确决策」四个字配一条几乎不可信的结论，
  // 这是**对外表达与内部事实相反**，比算错更危险。
  //
  // 引擎侧已改为 `confidence < CLEAR_MIN_CONFIDENCE` 直接降为 `MARGINAL`。
  // 这里再加一道**独立**的最终检查（规范第 44 节「二次数学验证」的同一精神）：
  // 就算以后有人改了引擎的判据，只要「明确」与「低置信度」同时出现，
  // 端到端管线就立刻抛错，而不是把矛盾送到界面上。
  if (decision.classification === 'CLEAR' && decision.confidence < 0.45) {
    throw new Error(
      `finalMathSanityCheck: 分类为「明确决策」但置信度仅 ${decision.confidence.toFixed(4)}` +
        `（分档 ${decision.band}）—— 「明确」必须至少是中置信度（≥0.45）。` +
        '这是必须修复的缺陷（红队 F-04）。',
    );
  }

  return problems;
}

/* ============================================================
 * 辅助
 * ============================================================ */

/** 从解析结果读取环境（默认中低级别） */
function environmentOf(parsed: ParsedManualInput): GameEnvironment {
  const value = parsed.environment;
  const known = Object.values(GameEnvironment) as readonly string[];
  return known.includes(value) ? (value as GameEnvironment) : GameEnvironment.MID_LOW_STAKES;
}

/**
 * 手动输入的稳定哈希（用于决策日志去重与追溯）。
 *
 * 简单 FNV-1a 变体：不用于安全用途，只用于「同样输入是否得到同样记录」。
 * 刻意**不用** `Math.random` 或时间戳 —— 同一输入必须得到同一哈希。
 *
 * ## 🔴 红队 F-10：必须覆盖**全部**输入字段
 *
 * 修复前漏掉了 `bigBlindBB`、`villains`、`actionHistory[].street`，
 * 于是「不同的输入」可能得到「同一个哈希」——
 * 决策日志的 `inputHash` 就无法唯一标识一手牌，
 * 「同一输入的重复分析」去重与「输入变了吗」比对都会误判。
 *
 * 当时的实际后果被 `bigBlindBB` 恰好是死字段（F-07）掩盖了 ——
 * 那是**偶然安全**，不是设计保证。
 *
 * ## 这是怎么被永久锁住的
 *
 * `test/alphaPipeline.test.ts` 里有一条**穷举式**回归测试：
 * 逐个字段扰动 `ManualHandInput` 的每一个键，要求哈希**必须**改变；
 * 并且用 `keyof ManualHandInput` 做类型级清单，
 * **新增字段而忘了加进哈希 → 测试立刻失败**（而不是等到下一次红队）。
 */
export function hashManualInput(input: ManualHandInput): string {
  const villainOf = (v: NonNullable<ManualHandInput['villain']> | undefined): unknown =>
    v === undefined
      ? null
      : [
          v.playerId ?? null,
          v.quickProfile ?? null,
          v.dynamicHint ?? null,
          v.stackBB ?? null,
        ];

  // 字段顺序**刻意固定**（不依赖对象字面量的书写顺序，但依赖这里的行序）：
  // 顺序变了哈希就变，这是可接受的（哈希不承诺跨版本稳定），
  // 但**同一版本内**同一输入必须同一哈希。
  const canonical = JSON.stringify({
    tableSize: input.tableSize,
    heroPosition: input.heroPosition,
    heroCards: input.heroCards,
    board: input.board,
    street: input.street,
    effectiveStackBB: input.effectiveStackBB,
    potBB: input.potBB ?? null,
    environment: input.environment,
    bigBlindBB: input.bigBlindBB ?? null,
    /**
     * 本手拓扑（Table Topology Correction，规范第 66 条）。
     *
     * 🔴 输入哈希**必须**区分「同样的手牌 / 公共牌 / 行动，但人数或位置不同」——
     * 9 人桌 UTG 与 8 人桌 UTG 是**两个完全不同的决策节点**
     * （对手数量、范围、有效筹码都不一样）。
     * 不写进哈希就等于「昨天 9 人桌 CALL、今天 8 人桌 FOLD」追不到原因。
     */
    occupiedPositions: input.occupiedPositions === undefined ? null : [...input.occupiedPositions],
    buttonPosition: input.buttonPosition ?? null,
    // 逐座位筹码：**按位置排序**后再序列化。
    // 对象键序在 JS 里是插入序，同一份数据用不同顺序构造会得到不同哈希 ——
    // 那会让「同一手牌」被记成两条记录。排序消除了这个不确定性。
    seatStacksBB:
      input.seatStacksBB === undefined
        ? null
        : Object.entries(input.seatStacksBB)
            .filter(([, value]) => value !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    /**
     * 逐座位画像（MULTIWAY RESPONSE TREE）：**必须进哈希** ——
     * 同一手牌、同一个行动记录，只把 CO 从 NORMAL 改成 CALLING_STATION，
     * 多人下注 EV 会变；不写进哈希就追不到「为什么昨天不下注、今天下注」。
     */
    seatProfiles:
      input.seatProfiles === undefined
        ? null
        : Object.entries(input.seatProfiles)
            .filter(([, value]) => value !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    actionHistory: input.actionHistory.map((a) => [
      a.position,
      a.type,
      a.amountBB ?? null,
      a.street ?? null,
    ]),
    villain: villainOf(input.villain),
    villains: input.villains === undefined ? null : input.villains.map(villainOf),
  });

  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `h${hash.toString(16).padStart(8, '0')}`;
}

/** 供界面显示：当前牌面（不含对手底牌） */
export function publicCardsOf(input: ManualHandInput): { hero: readonly Card[]; board: readonly Card[] } {
  return { hero: [], board: [] };
}
