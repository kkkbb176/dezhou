/**
 * ============================================================================
 * 翻前加注事实包（PREFLOP RAISE FACTS）—— 逐尺寸的响应、条件范围、再加注分支与 EV
 * ============================================================================
 *
 * ## 这个模块补的是什么（阶段 B 的核心）
 *
 * 在它之前，翻前的**每一个**加注金额都没有自有 EV：决策层把它们全部列进
 * `unevaluatedActions`（理由码 `RAISE_EV_NOT_IMPLEMENTED`），
 * 于是「加注是否比跟注好」只能靠启发式 —— 而启发式正是本项目在河牌
 * 推出一对牌 87BB 全下的那个来源。
 *
 * 本模块对**尺寸网格里的每一个合法尺寸**分别给出：
 *
 * ```text
 * 他弃牌 / 跟注 / 再加注 的概率   （由 buildPreflopRaiseResponse 产出）
 * 跟注桶条件范围 + 对它的权益     （EqVsRaiseCallRange）
 * 再加注桶条件范围 + 对它的权益   （EqVsReraiseRange）
 * 被再加注后的 Hero 最佳应对       （FOLD / CALL 两选一，零点统一）
 * RAISE EV                        （raiseEVOf，与 CALL EV 同一公式族）
 * ```
 *
 * ## 🔴 零点与单位（与 CALL EV 完全一致）
 *
 * ```text
 * 零点 = 当前 Hero 决策节点（弃牌 ≡ 0；此前投入是沉没成本）
 * 单位 = 筹码
 * RAISE EV = f × currentPot
 *          + c × (EqVsRaiseCallRange × finalPot − heroContestedAdd)
 *          + rr × reraiseBranchEV
 * ```
 *
 * **没有第二套公式**：现金流一律调用 `raiseResponse.raiseEVOf`
 * （全项目唯一的加注 EV 公式），本模块只负责把输入凑齐。
 *
 * ## ⚠️ 明确不支持（必须如实披露，不得静默按单挑算）
 *
 * | 情形 | 行为 |
 * |---|---|
 * | 活跃对手 ≠ 1 | 返回 `NOT_HEADS_UP`，**不给任何 EV** |
 * | 身后还有人未行动 | 返回 `PLAYERS_BEHIND`，**不给任何 EV** |
 * | 拿不到对手到达范围 | 返回 `NO_ARRIVAL_RANGE` |
 * | 拿不到跟注桶权益 | 该尺寸 `raiseEV = null`（**不是 0**） |
 *
 * ## ⚠️ 未来街：翻前**全下**分支是精确的，非全下不是
 *
 * - 全下（我或他）⇒ 权益就是最终摊牌权益，**没有未来街** ⇒ 该分支精确；
 * - 非全下 ⇒ `EqVsRaiseCallRange` 是「打到摊牌、后续街不再下注」的
 *   **终止近似**。这一点在 `assumptionsZh` 与 `evKind` 里逐条写明，
 *   **不允许**把它叫做「真实完整 EV」或「严格下界」。
 */

import { Position, type Street } from '../../domain/types.ts';
import {
  ActionType,
  computePot,
  committedThisStreet,
  type GameState,
  type PlayerState,
} from '../../domain/poker/gameState.ts';
import { applyAction } from '../../domain/poker/engine.ts';
import { previewCommit } from '../../domain/poker/pots.ts';
import type { Card } from '../../domain/types.ts';
import type { ResponseTendencies } from '../../domain/postflop/betResponse.ts';
import { ALL_COMBOS, type ExactCombo } from '../../domain/range/combo.ts';
import { deadCardsFrom, isBlocked } from '../../domain/range/rangeBlockers.ts';
import type { Range } from '../../domain/range/range.types.ts';
import { buildSizeGrid, closestSizeTo, type LegalActions, type SizeOption } from './legalActions.ts';
import { raiseEVOf, CASHFLOW_CONTRACT } from './raiseResponse.ts';
import {
  PREFLOP_RAISE_RESPONSE_MODEL_VERSION,
  buildPreflopRaiseResponse,
  preflopReRaiseToOf,
  type PreflopRaiseResponse,
  type PreflopRaiseTuning,
} from './preflopRaiseResponse.ts';

/* ============================================================
 * 版本
 * ============================================================ */

export const PREFLOP_RAISE_FACTS_VERSION = 'PREFLOP_RAISE_FACTS_V1';

/* ============================================================
 * 事实类型
 * ============================================================ */

export type PreflopEquityFact = {
  readonly value: number | null;
  readonly method: 'EXACT' | 'MONTE_CARLO' | 'NOT_AVAILABLE';
  readonly iterations: number;
  /** 95% 置信区间半宽（蒙特卡洛的**抽样**误差，不是模型误差） */
  readonly confidenceHalfWidth: number | null;
};

export type PreflopRaiseSizeFacts = {
  readonly sizeChips: number;
  readonly sizeBB: number;
  readonly labelZh: string;
  readonly isAllIn: boolean;

  /* ---- 资金口径（引擎算好，模型只读） ---- */
  readonly currentPot: number;
  readonly heroStreetCommitted: number;
  readonly villainStreetCommitted: number;
  readonly heroAdd: number;
  readonly villainAddRaw: number;
  readonly villainAdd: number;
  readonly heroContestedAdd: number;
  readonly finalPot: number;
  readonly uncalledReturn: number;
  readonly villainIsAllInByCall: boolean;
  readonly heroIsAllIn: boolean;

  /* ---- 响应（公共信息口径） ---- */
  readonly foldLikelihood: number;
  readonly callLikelihood: number;
  readonly reRaiseLikelihood: number;
  readonly reachableCombos: number;
  readonly callCombos: number;
  readonly reRaiseCombos: number;
  readonly priceRequiredEquity: number;
  readonly priceMargin: number;

  /* ---- 条件权益 ---- */
  readonly heroEquityVsRaiseCallRange: PreflopEquityFact;
  readonly heroEquityVsReraiseRange: PreflopEquityFact;

  /* ---- 被再加注分支（零点 = 原始 Hero 节点） ---- */
  readonly reraiseAvailable: boolean;
  readonly reRaiseTo: number | null;
  readonly reRaiseMinLegalTo: number | null;
  readonly villainReRaiseIsAllIn: boolean | null;
  readonly heroAdditionalCallVsReRaise: number | null;
  readonly finalPotAfterCallVsReRaise: number | null;
  /** Hero 弃牌：损失从原始节点至今已新增且损失的投入 */
  readonly reraiseFoldBranchEV: number;
  /** Hero 跟注：用再加注条件范围算，并扣除累计新增投入 */
  readonly reraiseCallBranchEV: number | null;
  /** `max(FOLD, CALL)` —— 只有在两支都可算时才是「应对」；否则退化为 FOLD 下界 */
  readonly reraiseBranchEV: number;
  readonly reraiseBranchKind: 'FOLD' | 'CALL' | 'FOLD_ONLY_UNAVAILABLE';
  /** 🔴 只支持 FOLD / CALL —— Hero 的 5Bet 应对**未**展开 */
  readonly heroFiveBetExpanded: false;
  readonly reraiseBranchUnsupportedZh: string | null;

  /* ---- EV ---- */
  readonly raiseEV: number | null;

  /* ---- 假设 ---- */
  readonly assumptionsZh: readonly string[];
  readonly noteZh: string;
};

export type PreflopRaiseFacts = {
  readonly kind: 'PREFLOP_RAISE_FACTS';
  readonly version: string;
  readonly modelVersion: string;
  readonly evidence: 'HEURISTIC_STRUCTURAL';
  readonly cashflowContract: string;
  /** 权重是否读过 Hero 的隐藏底牌 —— **恒为 false**（由测试锁定） */
  readonly usesHeroHiddenCards: false;
  readonly rakeStatus: 'NOT_APPLIED';

  readonly street: Street;
  readonly heroPosition: Position;
  readonly opponentPosition: Position;
  readonly bigBlind: number;

  readonly currentPot: number;
  readonly heroCallCost: number;
  readonly heroRemaining: number;
  readonly effectiveStackChips: number;
  readonly sprAfterCall: number | null;

  readonly heroIsAllIn: boolean;
  readonly villainIsAllInByCall: boolean;
  readonly allInToAmount: number;
  readonly minRaiseToAmount: number;

  /** 到达范围（他开池后的后验）的统计 */
  readonly arrival: {
    readonly comboCount: number;
    readonly mass: number;
    readonly source: string;
  };

  /** 🔴 **逐尺寸**的事实 —— 每个被比较的加注尺寸都拥有属于它自己的数字 */
  readonly sizes: readonly PreflopRaiseSizeFacts[];

  /** 被选中用于诊断输出的尺寸（与决策层同一个选择规则） */
  readonly chosenSizeChips: number | null;

  readonly assumptionsZh: readonly string[];
  readonly noteZh: string;
};

/** 不给事实包的**原因**（必须显式说出去，不得静默按单挑算） */
export const PreflopRaiseSkipReason = {
  NOT_PREFLOP: 'NOT_PREFLOP',
  NO_OPPONENT: 'NO_OPPONENT',
  NOT_HEADS_UP: 'NOT_HEADS_UP',
  PLAYERS_BEHIND: 'PLAYERS_BEHIND',
  NO_ARRIVAL_RANGE: 'NO_ARRIVAL_RANGE',
  NO_CALL_COST: 'NO_CALL_COST',
  NO_GRID: 'NO_GRID',
  HERO_NO_CARDS: 'HERO_NO_CARDS',
} as const;
export type PreflopRaiseSkipReason =
  (typeof PreflopRaiseSkipReason)[keyof typeof PreflopRaiseSkipReason];

export const PREFLOP_RAISE_SKIP_ZH: Readonly<Record<PreflopRaiseSkipReason, string>> = Object.freeze({
  NOT_PREFLOP: '不是翻前节点 —— 翻前加注事实包只在翻前构建',
  NO_OPPONENT: '找不到对手：本手没有第二个未弃牌的玩家',
  NOT_HEADS_UP: '**不是单挑**：活跃对手不是 1 家（只按首要对手偷偷算单挑是错的）——'
    + '「面对加注的响应模型」只按**单挑**口径建模，未建模其余玩家的跟注/再加注，'
    + '因此**不产出**任何加注 EV。请等身后玩家行动完毕后再分析。',
  PLAYERS_BEHIND: '身后**还有玩家未行动**（`playersRemainingToAct > 0`）——'
    + '「面对加注的响应模型」只按**单挑**口径建模，未建模身后玩家的跟注/再加注，'
    + '因此**不产出**任何加注 EV（不偷偷按单挑算）。请先录入他们的行动。',
  NO_ARRIVAL_RANGE: '拿不到对手的到达范围（范围快照不可用，或与我的底牌重叠后没有剩余组合）',
  NO_CALL_COST: '本节点没有需要跟注的金额（不是面对加注）',
  NO_GRID: '合法尺寸网格为空（没有可加注的金额）',
  HERO_NO_CARDS: 'Hero 底牌不完整（需要两张已知底牌才能算条件权益）',
});

export type PreflopRaiseFactsBuild =
  | { readonly ok: true; readonly facts: PreflopRaiseFacts }
  | { readonly ok: false; readonly reason: PreflopRaiseSkipReason; readonly noteZh: string };

/* ============================================================
 * 输入
 * ============================================================ */

export type BuildPreflopRaiseFactsInput = {
  readonly state: GameState;
  readonly hero: PlayerState;
  readonly opponent: PlayerState;
  readonly legal: LegalActions;
  /** 对手**到达范围**的逐组合权重（由范围引擎的贝叶斯更新产出） */
  readonly arrivalEntries: readonly { readonly cardIndices: readonly [number, number]; readonly probability: number }[];
  /** 到达范围的来源说明（进诊断） */
  readonly arrivalSource: string;
  /** 参与模型的身份说明（只用于诊断；模型本身不读 Hero 底牌） */
  readonly range: Range | null;
  /** 他面对加注的响应倍率（**只来自公共信息**） */
  readonly tendencies: ResponseTendencies;
  /** 我之后还需要行动的对手数（取自引擎 `pendingQueue`） */
  readonly playersRemainingToAct: number;
  /** 权益随机种子 */
  readonly seed: number;
  /** 权益计算函数（注入 ⇒ 测试可用确定性桩替代，生产用 contextBuilder 的实现） */
  readonly equityOf: (
    entries: readonly { readonly cardIndices: readonly [number, number]; readonly probability: number }[],
    seedOffset: number,
  ) => PreflopEquityFact;
  /**
   * 逐尺寸的候选（由调用方用**与决策层相同的**规则给出）。
   *
   * 缺省 ⇒ 用 `buildSizeGrid(legal, pot, 'RAISE')`。
   * 显式传入是为了让「决策层实际比较的那些尺寸」与「建模的尺寸」**同源**，
   * 避免两处各算一套网格。
   */
  readonly sizes?: readonly SizeOption[];
  /**
   * 🔴 **可注入的模型调参**（缺省 = 生产常数）。
   *
   * 只为**敏感性分析**服务：使用者第七节要求「新增系数必须记录来源、假设、
   * 版本和敏感性分析」，而如果常数写死在函数体里，分析就只能复制一份公式 ——
   * 那会让分析的公式与生产的公式漂移。这里让**同一条公式**接受显式参数。
   */
  readonly tuning?: PreflopRaiseTuning;
};

/* ============================================================
 * 主入口
 * ============================================================ */

export function buildPreflopRaiseFacts(input: BuildPreflopRaiseFactsInput): PreflopRaiseFactsBuild {
  const { state, hero, opponent, legal } = input;

  const skip = (reason: PreflopRaiseSkipReason): PreflopRaiseFactsBuild => ({
    ok: false,
    reason,
    noteZh: `翻前加注 EV 不适用：${PREFLOP_RAISE_SKIP_ZH[reason]}`,
  });

  if (state.street !== 'PREFLOP') return skip(PreflopRaiseSkipReason.NOT_PREFLOP);
  if (hero.holeCards === null || hero.holeCards.length !== 2) return skip(PreflopRaiseSkipReason.HERO_NO_CARDS);
  if (legal.callCost <= 0 || state.currentBet <= 0) return skip(PreflopRaiseSkipReason.NO_CALL_COST);

  /*
   * 🔴 **单挑门槛与「身后有人」门槛**都必须显式拦住，不能偷偷按单挑算。
   *
   * 与 `contextBuilder` 的 postflop raiseResponse 守卫**同一条纪律**：
   * 模型只针对**一个**对手建模，两个以上活跃对手时把身后的跟注/再加注
   * 当作不存在会系统性高估加注。
   */
  if (input.playersRemainingToAct > 0) return skip(PreflopRaiseSkipReason.PLAYERS_BEHIND);

  const activeOpponents = state.players.filter((p) => p.id !== hero.id && !p.folded);
  if (activeOpponents.length === 0) return skip(PreflopRaiseSkipReason.NO_OPPONENT);
  if (activeOpponents.length !== 1) return skip(PreflopRaiseSkipReason.NOT_HEADS_UP);
  if (activeOpponents[0]!.id !== opponent.id) return skip(PreflopRaiseSkipReason.NOT_HEADS_UP);

  if (input.arrivalEntries.length === 0) return skip(PreflopRaiseSkipReason.NO_ARRIVAL_RANGE);

  const pot0 = computePot(state);
  if (!(pot0 > 0)) return skip(PreflopRaiseSkipReason.NO_ARRIVAL_RANGE);

  /* ---- 他的到达范围先过一遍死牌（我的底牌是**公共信息**：我已经看到了） ---- */
  const dead = deadCardsFrom([...hero.holeCards, ...boardOf(state)]);
  let arrivalComboCount = 0;
  let arrivalMass = 0;
  const arrival: { cardIndices: readonly [number, number]; probability: number }[] = [];
  for (const entry of input.arrivalEntries) {
    const p = entry.probability;
    if (!(p > 0)) continue;
    const combo = comboOfIndexPair(entry.cardIndices);
    if (combo === null) continue;
    if (isBlocked(combo, dead)) continue;
    arrivalComboCount += 1;
    arrivalMass += p;
    arrival.push({ cardIndices: entry.cardIndices, probability: p });
  }
  if (arrivalComboCount === 0 || !(arrivalMass > 0)) return skip(PreflopRaiseSkipReason.NO_ARRIVAL_RANGE);

  const heroStreetCommitted = committedThisStreet(state, hero.id);
  const villainStreetCommitted = committedThisStreet(state, opponent.id);
  const heroRemaining = Math.max(0, hero.remainingStack);
  const effectiveStackChips = input.legal.allInToAmount - heroStreetCommitted;

  /* ---- 尺寸集合：缺省 = 决策层同一个网格 ---- */
  const grid = input.sizes !== undefined && input.sizes.length > 0
    ? input.sizes
    : buildSizeGrid(legal, pot0, 'RAISE');
  if (grid.length === 0) return skip(PreflopRaiseSkipReason.NO_GRID);

  const sizes: PreflopRaiseSizeFacts[] = [];
  for (const option of grid) {
    const built = buildOneSize({
      state,
      hero,
      opponent,
      legal,
      option,
      arrival,
      arrivalMass,
      heroStreetCommitted,
      villainStreetCommitted,
      tendencies: input.tendencies,
      heroCards: hero.holeCards,
      seed: input.seed,
      equityOf: input.equityOf,
      pot0,
      ...(input.tuning === undefined ? {} : { tuning: input.tuning }),
    });
    if (built !== null) sizes.push(built);
  }
  if (sizes.length === 0) return skip(PreflopRaiseSkipReason.NO_GRID);

  /* ---- 诊断用「被选中的尺寸」：与决策层同一个规则（最近似 pot + 2×跟注额） ---- */
  const desiredTo = pot0 + 2 * legal.callCost;
  const chosen = closestSizeTo(grid, desiredTo, (o) => o.toAmount);

  const sprAfterCall = (() => {
    if (!(legal.callCost > 0)) return null;
    const preview = previewCommit(state, hero.id, legal.callCost);
    if (!(preview.winnable > 0)) return null;
    const remaining = heroRemaining - legal.callCost;
    if (!(remaining > 0)) return 0;
    return remaining / preview.winnable;
  })();

  const facts: PreflopRaiseFacts = Object.freeze({
    kind: 'PREFLOP_RAISE_FACTS' as const,
    version: PREFLOP_RAISE_FACTS_VERSION,
    modelVersion: PREFLOP_RAISE_RESPONSE_MODEL_VERSION,
    evidence: 'HEURISTIC_STRUCTURAL' as const,
    cashflowContract: CASHFLOW_CONTRACT,
    usesHeroHiddenCards: false as const,
    rakeStatus: 'NOT_APPLIED' as const,
    street: state.street,
    heroPosition: hero.position,
    opponentPosition: opponent.position,
    bigBlind: state.config.bigBlind,
    currentPot: pot0,
    heroCallCost: legal.callCost,
    heroRemaining,
    effectiveStackChips,
    sprAfterCall,
    heroIsAllIn: legal.myRemainingStack <= 0,
    villainIsAllInByCall: opponent.remainingStack <= 0,
    allInToAmount: legal.allInToAmount,
    minRaiseToAmount: legal.minRaiseToAmount,
    arrival: Object.freeze({
      comboCount: arrivalComboCount,
      mass: arrivalMass,
      source: input.arrivalSource,
    }),
    sizes: Object.freeze(sizes),
    chosenSizeChips: chosen === null ? null : chosen.toAmount,
    assumptionsZh: Object.freeze(ASSUMPTIONS_ZH),
    noteZh:
      `**翻前加注事实包**（${PREFLOP_RAISE_FACTS_VERSION} / 响应模型 ${PREFLOP_RAISE_RESPONSE_MODEL_VERSION}）：` +
      `单挑、共 ${sizes.length} 个合法尺寸拥有**各自**的响应概率、条件范围与 EV｜` +
      `到达范围 ${arrivalComboCount} 组合（${input.arrivalSource}）｜` +
      `零点 = 弃牌 ≡ 0，单位 = 筹码｜⚠️ 被再加注分支只展开 FOLD / CALL（**未展开 Hero 的 5Bet**）`,
  });

  return { ok: true, facts };
}

const ASSUMPTIONS_ZH: readonly string[] = Object.freeze([
  '响应概率是**结构性先验**（他的到达范围 + 起手牌强度阶梯 + 价格 + 画像倍率），**未经统计校准**',
  '零点 = 弃牌 ≡ 0；单位 = 筹码；与 CALL EV 使用**同一条**现金流公式（raiseEVOf）',
  '他弃牌 ⇒ 我赢下完整底池 currentPot；他跟注 ⇒ 终池 finalPot（引擎分层口径，含退回修正）',
  '⚠️ **非全下**时 `EqVsRaiseCallRange` 是「打到摊牌、后续街不再下注」的**终止近似** —— '
    + '权益已枚举未来公共牌，但**未模拟**后续街的下注/过牌/弃牌 ⇒ 不是真实完整 EV，也不是严格下界',
  '✅ **全下**（我全下或他跟注即全下）时没有后续街 ⇒ 该分支的摊牌权益与收益是**精确**的',
  '被再加注分支只展开 Hero 的 FOLD / CALL；**Hero 的 5Bet 应对未展开**（`heroFiveBetExpanded = false`）',
  '再加注尺寸由**真实行动状态**推导（最小完整加注 vs 他的全下上限），不用固定倍数',
  'RAKE = NOT_APPLIED（本项目无 Rake Engine ⇒ 全部 EV **未计抽水**）',
  '身后还有玩家未行动时**不产出**本事实包（不按单挑偷偷计算）',
]);

/* ============================================================
 * 单个尺寸
 * ============================================================ */

function buildOneSize(args: {
  state: GameState;
  hero: PlayerState;
  opponent: PlayerState;
  legal: LegalActions;
  option: SizeOption;
  arrival: readonly { cardIndices: readonly [number, number]; probability: number }[];
  arrivalMass: number;
  heroStreetCommitted: number;
  villainStreetCommitted: number;
  tendencies: ResponseTendencies;
  heroCards: readonly Card[];
  seed: number;
  equityOf: (
    entries: readonly { readonly cardIndices: readonly [number, number]; readonly probability: number }[],
    seedOffset: number,
  ) => PreflopEquityFact;
  pot0: number;
  /** 🔴 可注入调参（缺省 = 生产常数；只为敏感性分析） */
  tuning?: PreflopRaiseTuning;
}): PreflopRaiseSizeFacts | null {
  const { state, hero, opponent, legal, option } = args;
  const raiseTo = option.toAmount;

  /* ---- 资金记账（唯一事实来源：引擎） ---- */
  const heroAdd = Math.max(0, raiseTo - args.heroStreetCommitted);
  if (!(heroAdd > 0)) return null;
  const villainAddRaw = Math.max(0, raiseTo - args.villainStreetCommitted);
  const villainAdd = Math.min(villainAddRaw, Math.max(0, opponent.remainingStack));
  if (!(villainAdd > 0)) return null;

  /*
   * 他跟平即投光：判据看**他投完之后还剩多少**，而不是「封顶有没有生效」。
   * （恰好用光那一行 `raw === remaining` 不会触发 `min`，只看封顶会漏掉。）
   */
  const villainIsAllInByCall = opponent.remainingStack <= villainAdd + 1e-9;
  const villainStreetTotalAfterCall = args.villainStreetCommitted + villainAdd;
  /*
   * ============================================================
   * 🔴 **已由引擎台账 `computeLayeredPot` 逐位裁定**（54 个尺寸 × 6 组筹码）
   *
   * 事故经过：同一行错了**两轮**，第三轮的「修复」又引入了新错。全部记录在此，
   * 因为这一行是「测试全绿 + 公式错误」同时成立过的地方。
   *
   * | 版本 | `被跟注增量` | `finalPot` | 100BB 1550 | 60BB 10000 | 引擎裁定 |
   * |---|---|---|---|---|---|
   * | 第一轮 | `min(heroAdd, villainAdd)` | `+ 该值 + villainAdd` | 2600 | — | ❌ 54/54 全错 |
   * | **第二轮（保留）** | `min(heroAdd, villainAddTotal − 我本街已投)` | `pot0 + 该值 + villainAdd` | 3250 | 12150 | ✅ 54/54 全对 |
   * | 第三轮（已撤销） | 同上 | `pot0 + 2 × min(双方本街总额)` | — | 12000 | ❌ 漏掉死钱 |
   *
   * 第一轮错在把「他跟注要补的**差价**」当成「他投入的**量**」：
   * 他从 900 补齐到 1550，真正与我匹配的是 650，差价恰好也是 650，所以 100BB
   * 下只丢了 650；差值恒为 `heroContestedAdd − villainAdd`。
   *
   * 第三轮错在把「他本街总额」当成「他从头到尾的全部投入」——
   * `villainStreetTotalAfterCall` **不含**他在**前面街**的投入，也不含盲注/前注/
   * 弃牌者的**死钱**。引擎台账实测（60BB、加注到 10000）：
   *
   * ```text
   * computeLayeredPot ⇒ { contested: 12150, deadMoney: 150, returned: { seat_CO: 4000 } }
   *   双方本街各 6000 ⇒ 2×6000 = 12000，还差 **150** = 死钱（盲注已弃）
   * ```
   *
   * 所以第三轮会在**每一个**尺寸上系统性低估 150（死钱），并让 `price` 的分母
   * 偏小、`EqVsCall × finalPot` 偏小。
   *
   * ## 保留的公式与恒等式（`test/preflopRaiseCashflow.test.ts` 锁定）
   *
   * ```text
   * heroAdd         = raiseTo − 我本街已投                ← 我这次加注要新增的筹码
   * villainAddRaw   = raiseTo − 他本街已投
   * villainAdd      = min(villainAddRaw, 他剩余筹码)      ← 他跟注要补的差价（被他的全下封顶）
   * villainTotal    = 他本街已投 + villainAdd             ← 他跟平后的本街总额
   * heroContestedAdd= min(heroAdd, villainTotal − 我本街已投)   ← 我新增投入中**被匹配**的部分
   * finalPot         = pot0(死钱) + heroContestedAdd + villainAdd = 引擎 `main`
   * uncalledReturn   = heroAdd − heroContestedAdd
   * ```
   *
   * ⚠️ `finalPot` 与 `computePot`（引擎**未退回**口径）**不相等**：
   * `computePot = finalPot + uncalledReturn`。60BB/10000 实测 `16150 = 12150 + 4000`。
   * 判据是引擎台账的 `main` / `contested`，**不是** `computePot`。
   *
   * ## 影响链（为什么是 P0）
   *
   * | 消费者 | 公式 | 用错后的后果 |
   * |---|---|---|
   * | 跟注分支成本 | `EqVsRaiseCall × finalPot − heroContestedAdd` | 终池被低估 ⇒ **RAISE EV 被低估** |
   * | 他继续的价格 | `price = villainAdd / finalPot` | 分母被低估 ⇒ price 被高估 ⇒ 他显得更紧 ⇒ 加注显得更易成功 |
   *
   * 两条方向相反 ⇒ **不能**靠「EV 变了多少」判断修没修对；唯一判据是与引擎一致。
   */
  /** 双方能匹配上的量 = min(我的新增投入, 他跟平后我还能匹配的量) */
  const contestedAdd = Math.max(
    0,
    Math.min(heroAdd, villainStreetTotalAfterCall - args.heroStreetCommitted),
  );
  const heroContestedAdd = contestedAdd;
  if (!(heroContestedAdd > 0)) return null;
  /*
   * 终池 = 死钱 + 我被跟注的量 + 他实际投入的量。
   *
   * ⚠️ **不要**改写成 `pot0 + 2 × contested`：`villainStreetTotalAfterCall` 与
   * `heroStreetCommitted` 都只是**本街**口径，不含前面街的投入，也不含死钱；
   * 那样写会漏掉死钱（实测每个尺寸少 150）。
   * `Math.min(villainAdd, contestedAdd)` 显式写出「他实际能匹配多少」。
   */
  const finalPot = args.pot0 + heroContestedAdd + Math.min(villainAdd, contestedAdd);
  const heroIsAllIn = raiseTo >= legal.allInToAmount - 1e-9;

  /* ---- 响应 ---- */
  const response: PreflopRaiseResponse | null = buildPreflopRaiseResponse({
    arrivalEntries: args.arrival,
    currentPot: args.pot0,
    heroAdd,
    villainAdd,
    finalPot,
    tendencies: args.tendencies,
    heroIsAllIn,
    villainIsAllInByCall,
    ...(args.tuning === undefined ? {} : { tuning: args.tuning }),
  });
  if (response === null) return null;

  /* ---- 条件权益 ---- */
  const eqVsCall = args.equityOf(response.callEntries, 1301);
  const eqVsReraise = args.equityOf(response.reRaiseEntries, 2601);

  /* ---- 被再加注分支 ---- */
  const reRaisePlan = (() => {
    if (response.reRaiseLikelihood <= 0 || response.reRaiseEntries.length === 0) return null;
    const villainRemainingAfterCall = Math.max(0, opponent.remainingStack - villainAdd);
    const plan = preflopReRaiseToOf({
      raiseTo,
      villainCommittedBefore: args.villainStreetCommitted,
      villainStreetTotalAfterCall,
      villainRemainingAfterCall,
    });
    if (!(plan.reRaiseTo > raiseTo + 1e-9)) return null;
    const heroRemainingAfterRaise = Math.max(0, legal.myRemainingStack - heroAdd);
    const additionalCall = Math.min(plan.reRaiseTo - raiseTo, heroRemainingAfterRaise);
    if (!(additionalCall > 0)) return null;
    return { ...plan, additionalCall, heroRemainingAfterRaise };
  })();

  const reraiseFoldBranchEV = -heroContestedAdd;
  const reraiseCallBranchEV = (() => {
    if (reRaisePlan === null) return null;
    if (eqVsReraise.value === null) return null;
    /*
     * 后续资金用**引擎自己的**动作与分层底池算：
     * Hero 加注 → 他再加注 → Hero 跟注 ⇒ 我能争夺到的量（与 CALL EV 同一口径）。
     */
    const afterRaise = applyAction(state, {
      playerId: hero.id,
      type: ActionType.RAISE,
      amount: raiseTo,
    });
    if (!afterRaise.ok) return null;
    const afterReRaise = applyAction(afterRaise.state, {
      playerId: opponent.id,
      type: ActionType.RAISE,
      amount: reRaisePlan.reRaiseTo,
    });
    if (!afterReRaise.ok) return null;
    const winnable = previewCommit(afterReRaise.state, hero.id, reRaisePlan.additionalCall).winnable;
    if (!(winnable > 0)) return null;
    return eqVsReraise.value * winnable - heroContestedAdd - reRaisePlan.additionalCall;
  })();

  const reraiseBranchEV =
    reraiseCallBranchEV === null
      ? reraiseFoldBranchEV
      : Math.max(reraiseFoldBranchEV, reraiseCallBranchEV);
  const reraiseBranchKind: PreflopRaiseSizeFacts['reraiseBranchKind'] =
    reraiseCallBranchEV === null
      ? 'FOLD_ONLY_UNAVAILABLE'
      : reraiseCallBranchEV > reraiseFoldBranchEV + 1e-9
        ? 'CALL'
        : 'FOLD';

  /* ---- EV ---- */
  const raiseEV =
    eqVsCall.value === null
      ? null
      : raiseEVOf({
          foldLikelihood: response.foldLikelihood,
          callLikelihood: response.callLikelihood,
          reRaiseLikelihood: response.reRaiseLikelihood,
          currentPot: args.pot0,
          heroContestedAdd,
          finalPot,
          equityVsRaiseCall: eqVsCall.value,
          reraiseBranchEV,
        });

  const reraiseBranchUnsupportedZh =
    reraiseCallBranchEV === null && response.reRaiseLikelihood > 0
      ? '再加注分支不可计算（缺再加注范围条件权益或后续资金）⇒ 该分支按「放弃本次投入」计入；'
        + '这是**建模假设下的保守值**，不是对真实牌局 EV 的严格保证'
      : null;

  return Object.freeze({
    sizeChips: raiseTo,
    sizeBB: raiseTo / state.config.bigBlind,
    labelZh: option.labelZh,
    isAllIn: option.isAllIn,

    currentPot: args.pot0,
    heroStreetCommitted: args.heroStreetCommitted,
    villainStreetCommitted: args.villainStreetCommitted,
    heroAdd,
    villainAddRaw,
    villainAdd,
    heroContestedAdd,
    finalPot,
    /* 退回 = 我新增投入中没被匹配的部分 */
    uncalledReturn: Math.max(0, heroAdd - heroContestedAdd),
    villainIsAllInByCall,
    heroIsAllIn,

    foldLikelihood: response.foldLikelihood,
    callLikelihood: response.callLikelihood,
    reRaiseLikelihood: response.reRaiseLikelihood,
    reachableCombos: response.reachableCombos,
    callCombos: response.callCombos,
    reRaiseCombos: response.reRaiseCombos,
    priceRequiredEquity: response.priceRequiredEquity,
    priceMargin: response.margin,

    heroEquityVsRaiseCallRange: eqVsCall,
    heroEquityVsReraiseRange: eqVsReraise,

    reraiseAvailable: reRaisePlan !== null,
    reRaiseTo: reRaisePlan === null ? null : reRaisePlan.reRaiseTo,
    reRaiseMinLegalTo: reRaisePlan === null ? null : reRaisePlan.minReRaiseTo,
    villainReRaiseIsAllIn: reRaisePlan === null ? null : reRaisePlan.isAllIn,
    heroAdditionalCallVsReRaise: reRaisePlan === null ? null : reRaisePlan.additionalCall,
    finalPotAfterCallVsReRaise: null,
    reraiseFoldBranchEV,
    reraiseCallBranchEV,
    reraiseBranchEV,
    reraiseBranchKind,
    heroFiveBetExpanded: false as const,
    reraiseBranchUnsupportedZh,

    raiseEV,
    assumptionsZh: Object.freeze([
      `本尺寸的证据链：他弃 ${(response.foldLikelihood * 100).toFixed(1)}% / 跟 ${(response.callLikelihood * 100).toFixed(1)}% / `
        + `再加注 ${(response.reRaiseLikelihood * 100).toFixed(1)}%`,
      `他跟注桶条件范围权益 ${eqVsCall.value === null ? 'NOT_AVAILABLE' : (eqVsCall.value * 100).toFixed(2) + '%'}`
        + `（${eqVsCall.method}，${eqVsCall.iterations} 次迭代）`,
      `他再加注桶条件范围权益 ${eqVsReraise.value === null ? 'NOT_AVAILABLE' : (eqVsReraise.value * 100).toFixed(2) + '%'}`
        + `（${eqVsReraise.method}）`,
      heroIsAllIn || villainIsAllInByCall
        ? '✅ 本尺寸至少一方全下 ⇒ 没有后续街，摊牌权益与收益**精确**'
        : '⚠️ 本尺寸双方都还有筹码 ⇒ 跟注分支是**摊牌终止近似**（后续街不再下注）',
    ]),
    noteZh:
      `加注到 ${raiseTo}${option.isAllIn ? '（全下）' : ''}：我方新增 ${heroAdd}`
      + `${heroAdd === heroContestedAdd ? '' : `（其中被跟注 ${heroContestedAdd}、退回 ${heroAdd - heroContestedAdd}）`}`
      + `，他补 ${villainAdd}${villainIsAllInByCall ? '（他跟平即全下 ⇒ 不会再有再加注分支）' : ''}，终池 ${finalPot} ⇒ `
      + (raiseEV === null
          ? 'RAISE EV 不可算（跟注桶条件权益不可得）'
          : `RAISE EV = ${response.foldLikelihood.toFixed(4)}×${args.pot0} + `
            + `${response.callLikelihood.toFixed(4)}×(${(eqVsCall.value ?? 0).toFixed(4)}×${finalPot} − ${heroContestedAdd}) + `
            + `${response.reRaiseLikelihood.toFixed(4)}×(${reraiseBranchEV.toFixed(4)}`
            + `${reraiseBranchKind === 'FOLD_ONLY_UNAVAILABLE' ? '=下界' : `=${reraiseBranchKind}分支`}) `
            + `= **${raiseEV.toFixed(4)}** 筹码`),
  });
}

/* ============================================================
 * 辅助
 * ============================================================ */

function boardOf(state: GameState): readonly Card[] {
  return [...state.board.flop, ...state.board.turn, ...state.board.river];
}

/**
 * 组合对象查找（O(1)）。
 *
 * ⚠️ 用 `domain/range/combo.ts` 的 `ALL_COMBOS`（唯一权威的 1326 组合宇宙），
 * 不自己造组合 —— 死牌判据（`rangeBlockers.isBlocked`）只认它的形状。
 *
 * 为什么必须建索引而不是线性扫描：本函数在每个尺寸的到达范围上跑一遍
 * （≈1000 组合 × 7 个尺寸），线性扫描会变成 9000 次 × 1326 次比较。
 */
const COMBO_INDEX: readonly (ExactCombo | null)[] = (() => {
  const table: (ExactCombo | null)[] = new Array(52 * 52).fill(null);
  for (const combo of ALL_COMBOS) {
    const [a, b] = combo.cardIndices;
    table[a * 52 + b] = combo;
    table[b * 52 + a] = combo;
  }
  return Object.freeze(table);
})();

function comboOfIndexPair(cardIndices: readonly [number, number]): ExactCombo | null {
  const [a, b] = cardIndices;
  if (!(a >= 0 && a < 52 && b >= 0 && b < 52)) return null;
  return COMBO_INDEX[a * 52 + b] ?? null;
}

/** 把 `Range` 的 entries 转成本模块的 `cardIndices` 形状（唯一转换点） */
export function arrivalEntriesOf(
  range: Range | null,
): readonly { readonly cardIndices: readonly [number, number]; readonly probability: number }[] {
  if (range === null) return Object.freeze([]);
  return Object.freeze(
    range.entries
      .filter((e) => e.probability > 0)
      .map((e) => Object.freeze({
        cardIndices: Object.freeze([e.combo.cardIndices[0], e.combo.cardIndices[1]]) as unknown as readonly [number, number],
        probability: e.probability,
      })),
  );
}

/* ============================================================
 * 模型选择（决策层与测试共用**同一个**判据）
 * ============================================================ */

export type PreflopRaiseModelEvaluation = {
  readonly usable: boolean;
  /** 不可用的原因（中文，可直接进诊断） */
  readonly unavailableZh: string | null;
};

/**
 * 某个候选尺寸能否使用**属于它自己**的翻前加注 EV。
 *
 * ## 为什么必须是一个共享函数
 *
 * 「尺寸对不上却拿另一个尺寸的 EV 说事」是本项目已经踩过的坑
 * （U1 的 `raiseModelUsable`、隔离加注的 `isoUsable` 都为此设了同一条纪律）。
 * 把判据写成**一处**，决策层与测试就不可能各有一套。
 *
 * 判据（缺一不可）：
 * 1. 事实包存在且**资金口径契约**匹配（旧口径的事实包永远无法重新获得资格）；
 * 2. 候选确实是加注族（RAISE / ALL_IN）；
 * 3. 候选金额与该尺寸事实的 `sizeChips` **完全相等**；
 * 4. 该尺寸的 `raiseEV !== null`。
 *
 * ⚠️ 返回 `usable = false` 时，调用方必须把该候选计入「未评估动作」，
 * **不得**用其他尺寸的 EV 顶替，**不得**填 0。
 */
export function evaluatePreflopRaiseModel(input: {
  readonly facts: PreflopRaiseFacts | null | undefined;
  /** 候选的本街累计金额（raise-to 口径） */
  readonly candidateSizeChips: number | undefined;
  readonly actionIsRaiseLike: boolean;
}): PreflopRaiseModelEvaluation {
  const facts = input.facts ?? null;
  if (facts === null) return { usable: false, unavailableZh: '本节点没有翻前加注事实包' };
  if (facts.cashflowContract !== CASHFLOW_CONTRACT) {
    return {
      usable: false,
      unavailableZh: `翻前加注事实包的资金口径契约不符（${facts.cashflowContract} ≠ ${CASHFLOW_CONTRACT}）`,
    };
  }
  if (!input.actionIsRaiseLike) return { usable: false, unavailableZh: '该动作不是加注族' };
  if (input.candidateSizeChips === undefined) {
    return { usable: false, unavailableZh: '该加注候选没有金额（无法与事实包对齐）' };
  }
  const size = facts.sizes.find((s) => s.sizeChips === input.candidateSizeChips);
  if (size === undefined) {
    return {
      usable: false,
      unavailableZh: `该尺寸（${input.candidateSizeChips} 筹码）不在翻前加注事实包里 `
        + `⇒ **不得**借用其它尺寸的 EV`,
    };
  }
  if (size.raiseEV === null) {
    return { usable: false, unavailableZh: `该尺寸（${size.sizeBB.toFixed(2)}BB）的翻前加注 EV 不可算` };
  }
  return { usable: true, unavailableZh: null };
}

/** 取某个尺寸的事实（找不到 ⇒ null；绝不返回别的尺寸） */
export function preflopRaiseSizeFactsOf(
  facts: PreflopRaiseFacts | null | undefined,
  sizeChips: number | undefined,
): PreflopRaiseSizeFacts | null {
  if (facts === null || facts === undefined || sizeChips === undefined) return null;
  return facts.sizes.find((s) => s.sizeChips === sizeChips) ?? null;
}
