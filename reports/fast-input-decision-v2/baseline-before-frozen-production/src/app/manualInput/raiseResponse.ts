/**
 * ============================================================================
 * 面对加注的响应（RAISE RESPONSE）—— 「他跟不跟这一注」
 * ============================================================================
 *
 * ## 这个模块补的是什么（U1 · `NOT_IMPLEMENTED` → 实现）
 *
 * 在它之前，`RAISE` 这个动作在全项目里**没有任何筹码 EV**：
 * `reports/UNCERTAINTY_REGISTER.md` 的 U1 记录了这条缺口，产品自述
 * `checkTree.raiseResponse = 'NOT_IMPLEMENTED'`（`betResponse.ts`）。
 * 后果是「加注是否比跟注好」无法被计算，只能靠启发式 —— 而启发式在河牌
 * 把一对牌推成了 87BB 全下（`reports/RIVER_RAISE_DECISION_AUDIT.md`）。
 *
 * ## 🔴 口径：**公共信息**（不读 Hero 的隐藏底牌）
 *
 * 与 `bettingRange.ts`（RIVER BET RANGE V2）同一条纪律：
 *
 * | 轴 | 来源 | 是否读 Hero 底牌 |
 * |---|---|---|
 * | 手牌强度 | `publicStrengthBandOf(他的底牌, 公共牌)`（9 档） | ❌ |
 * | 可玩性 | `drawProfileOf(他的底牌, 公共牌)`（同花听/两头顺/卡顺） | ❌ |
 * | 价格 | `villainAdd / finalPot` ——【数学确定】 | ❌ |
 * | 画像 | `ResponseTendencies`（aggression / bluffTendency / passivity） | ❌ |
 *
 * ## 🔴🔴 资金记账（U1 P0 修复）：本模块**不再自己算底池**
 *
 * 修复前本模块收到的是「扣掉对手这一注的底池 + 2×增量」，
 * 于是价格分母少了对手已经下注的那笔筹码（实测 HAND A：0.4174 vs 正确 0.3342，
 * 系统性把对手的继续门槛抬高 8.3 个百分点）。现在：
 *
 * ```text
 * currentPot      = 决策时完整底池（**含**对手这一注）
 * heroAdd         = 我这次加注真正要新增的筹码
 * villainAdd      = 对手跟注还要补的筹码（短筹码时按他实际能投的封顶）
 * finalPot        = 双方投入后**我能争夺到**的底池（引擎分层口径）
 * price           = villainAdd / finalPot        ← 他跟注所需的最低权益
 * ratioToPot      = heroAdd / currentPot         ← 我的加注相对当前底池的大小
 * ```
 *
 * ⚠️ 这些量**全部由引擎（`contextBuilder` 第 4d 步）用
 * `committedThisStreet` / `computePot` / `previewCommit` 算好后传入**，
 * 本模块只做响应建模 —— 资金口径只有**一处**事实来源，避免两个地方各算一遍。
 *
 * 与既有响应模型（`betResponse.classifyVillainAfterCheck` / `classifyResponse`）
 * 的关系：**形状相同、强度基准不同**。既有模型用 `versusHero + tier` 作强度，
 * 那是**上帝视角**（也正因如此不能用于下注范围权重）；
 * 本模块改用公共强度带 ⇒ 两者构成**互相独立**的两把尺子，
 * 这正是 U1 要求的「方案②生产 + 方案①独立对照」。
 *
 * ## ⚠️ 未校准声明（与 `betProbabilityByBand` 同一纪律）
 *
 * 本模块只声称三件事：
 * 1. **单调**：手牌越强 ⇒ 越可能继续（价格相同的前提下）；
 * 2. **价格敏感**：加注越大 ⇒ 继续的门槛越高（`required = price + margin`）；
 * 3. **非退化**：每个强度带的继续权重都在 (0,1) 内，不会整类消失。
 *
 * 它**不声称**任何具体频率是真实的：`BAND_STRENGTH` 与 `RAISE_SHARE_*`
 * 全部是结构性取值，随 `model.strengthOfBand` 一起导出，供将来用真实统计替换。
 */

import type { Card } from '../../domain/types.ts';
import { ALL_CARDS } from '../../domain/poker/cards.ts';
import { drawProfileOf } from '../../domain/postflop/draws.ts';
import type { ResponseTendencies } from '../../domain/postflop/betResponse.ts';
import {
  PublicStrengthBand,
  publicStrengthBandOf,
} from './bettingRange.ts';

/**
 * 🔴 **公共强度带 → 继续强度代理**（0..1）。
 *
 * 含义：这手牌「在公共信息下有多值得继续」。
 * 取值是**结构性阶梯**（只声称序关系），不是任何实测频率。
 */
export const RAISE_RESPONSE_BAND_STRENGTH: Readonly<Record<PublicStrengthBand, number>> = Object.freeze({
  NUT: 0.97,
  STRONG_MADE: 0.86,
  TWO_PAIR: 0.72,
  OVERPAIR: 0.62,
  TOP_PAIR_GOOD: 0.52,
  TOP_PAIR_WEAK: 0.4,
  MIDDLE_PAIR: 0.3,
  WEAK_PAIR: 0.2,
  AIR: 0.07,
});

/** 听牌带来的可玩性（隐含赔率），与既有响应模型的刻度一致 */
const PLAYABILITY_STRONG_DRAW = 0.1;
const PLAYABILITY_WEAK_DRAW = 0.05;

/**
 * 🔴 **资金口径契约版本**（U1 P0 修复）。
 *
 * 决策层要求事实包带这个标记才允许把加注 EV 放进跨动作比较 ⇒
 * 旧口径的（或缓存里的）事实包永远无法重新获得 MODEL_EV 资格。
 */
export const CASHFLOW_CONTRACT = 'NODE_INCREMENTAL_CHIPS_V2' as const;

/**
 * ============================================================================
 * RAISE EV —— **与 CALL EV 同一套筹码口径**（U1 P0 修复后的唯一公式）
 * ============================================================================
 *
 * ```text
 * RAISE EV = P(弃) × currentPot                                  ← 他弃牌：我赢下**完整**底池
 *          + P(跟) × (EqVsRaiseCallRange × finalPot − 我留在池中的投入)
 *          + P(再加注) × (−我留在池中的投入)                       ← Hero 全下 ⇒ 该权恒为 0
 * ```
 *
 * 零点 = 弃牌 ≡ 0；单位 = 筹码；时点 = Hero 本次决策。
 *
 * ⚠️ **本公式与 CALL EV 完全同口径**：CALL EV = `EqVsBetRange × winnable − callCost`，
 * 其中 `winnable` 同样是「按引擎分层口径我能争夺到的底池」、`callCost` 同样是
 * 「我真正新增的投入」。
 *
 * ⚠️ **这不是「最优后续」的 EV**：再加注分支假定 Hero 弃牌
 *（`reRaiseLikelihood` 只有在不是全下时才可能大于 0），也没有建模 Hero 的
 * 后续再加注、多人底池与抽水。
 *
 * @param input.heroContestedAdd 我真正留在池中的筹码。双方都跟得满时
 *        `heroContestedAdd === heroAdd`；对手筹码不足时差额是**退回**，
 *        不得计入投入（旧公式在这里会多扣）。
 * @param input.reraiseBranchEV 🔴 **P1-2b：被再加注分支的 EV**，**必须与其它分支同一零点**
 *        （= 首次加注前的决策节点）。调用方按
 *        `max(−heroContestedAdd, EqVsReraiseRange × 跟注后终池 − heroContestedAdd − 我需再投)`
 *        算出后传入；拿不到再加注范围时**退回下界** `−heroContestedAdd` 并如实标注未实现。
 */
export function raiseEVOf(input: {
  foldLikelihood: number;
  callLikelihood: number;
  reRaiseLikelihood: number;
  /** 决策时完整底池（含对手这一注） */
  currentPot: number;
  /** 我真正留在池中的筹码 */
  heroContestedAdd: number;
  /** 双方投入后我能争夺到的底池 */
  finalPot: number;
  /** 他跟注我时的条件权益（`EqVsRaiseCallRange`） */
  equityVsRaiseCall: number;
  /** 🔴 P1-2b：被再加注分支的 EV（与其它分支同一零点；下界 = `−heroContestedAdd`） */
  reraiseBranchEV: number;
}): number {
  const { foldLikelihood: f, callLikelihood: c, reRaiseLikelihood: rr } = input;
  return (
    f * input.currentPot +
    c * (input.equityVsRaiseCall * input.finalPot - input.heroContestedAdd) +
    rr * input.reraiseBranchEV
  );
}

/** 继续所需的**余量**（越靠后街隐含赔率越少 ⇒ 余量越小），与既有响应模型同刻度 */
function marginOfStreet(street: 'FLOP' | 'TURN' | 'RIVER'): number {
  return street === 'FLOP' ? 0.16 : street === 'TURN' ? 0.14 : 0.1;
}

/** 价值再加注的门槛超出额（比继续门槛再高这么多才值得再加注） */
const VALUE_RERAISE_EXCESS = 0.2;
const VALUE_RERAISE_BASE = 0.45;
const VALUE_RERAISE_SLOPE = 0.35;
const RAISE_SCALE_WEIGHT = 0.25;
/** 诈唬再加注：只有真听牌 / 纯空气 + 画像偏诈唬 + 我的加注不太大时才出现 */
const BLUFF_RERAISE_BASE = 0.15;
const BLUFF_RERAISE_BLUFF_WEIGHT = 0.2;
const BLUFF_RERAISE_MAX_RATIO = 0.8;

export type RaiseResponseModelFacts = {
  readonly kind: 'PUBLIC_BAND_RAISE_RESPONSE_V1';
  readonly evidence: 'HEURISTIC_STRUCTURAL';
  /** 权重是否读过 Hero 的隐藏底牌 —— 恒为 false（由测试锁定） */
  readonly usesHeroHiddenCards: false;
  /**
   * 🔴 **资金口径契约标记**（U1 P0 修复）。
   *
   * 决策层**只有**看到这个标记才允许把该 EV 放进跨动作比较
   *（`raiseModelUsable` 的硬条件）—— 这样「旧口径 / 缓存里的旧事实包」
   * 永远无法重新获得 MODEL_EV 比较资格。
   */
  readonly cashflowContract: 'NODE_INCREMENTAL_CHIPS_V2';
  /** 决策时完整底池（**含**对手这一注） */
  readonly currentPot: number;
  /** Hero 本次加注真正新增的筹码 */
  readonly heroAdd: number;
  /** 对手跟注还要补的筹码（短筹码时按他实际能投的封顶） */
  readonly villainAdd: number;
  /** Hero 真正**留在池中**的筹码（对手跟不起时小于 `heroAdd`，差额退回） */
  readonly heroContestedAdd: number;
  /** 双方投入后 Hero 能争夺到的底池（引擎分层口径） */
  readonly finalPot: number;
  /** 他面对这次加注需要的权益（= `villainAdd / finalPot`）【数学确定】 */
  readonly priceRequiredEquity: number;
  /** 模型使用的余量（价格 + margin 才是继续门槛） */
  readonly margin: number;
  /** 我的加注相对**当前底池**的大小（= `heroAdd / currentPot`） */
  readonly ratioToPot: number;
  readonly street: 'FLOP' | 'TURN' | 'RIVER';
  /** Hero 是否已全下（真 ⇒ 他不能再加注，权重迁移到跟注） */
  readonly heroIsAllIn: boolean;
  /** 🔴 P1-2a：对手跟注即全下（真 ⇒ 他不能再加注，权重迁移到跟注） */
  readonly villainIsAllInByCall: boolean;
  readonly strengthOfBand: Readonly<Record<PublicStrengthBand, number>>;
  readonly noteZh: string;
};

export type RaiseResponseResult = {
  /** 他弃牌的概率（质量口径） */
  readonly foldLikelihood: number;
  /** 他跟注的概率（质量口径） */
  readonly callLikelihood: number;
  /** 他再加注的概率（质量口径；`heroIsAllIn` 时恒为 0） */
  readonly reRaiseLikelihood: number;
  /** 跟注桶的**条件范围**（已归一化）—— 用于算 `EqVsRaiseContinueRange` */
  readonly callContinueEntries: readonly { readonly cardIndices: readonly [number, number]; readonly probability: number }[];
  /**
   * 🔴 **P1-2b：再加注桶的条件范围**（已归一化）—— 用于算 `EqVsReraiseRange`。
   *
   * 与跟注桶**同源同权重**（同一个逐组合循环、同一套死牌过滤与范围条件），
   * 但**不是**跟注桶：前者是「他决定跟」，这里是「他决定再加注」。
   * `P(再加注) = 0` 时恒为空数组与 0 组合 ⇒ 不得生成虚假的再加注分支。
   */
  readonly reRaiseEntries: readonly { readonly cardIndices: readonly [number, number]; readonly probability: number }[];
  readonly reachableCombos: number;
  /** 跟注桶组合数 */
  readonly callCombos: number;
  /** 🔴 P1-2b：再加注桶组合数（0 ⇒ 没有再加注分支，`reRaiseEntries` 为空） */
  readonly reRaiseCombos: number;
  readonly model: RaiseResponseModelFacts;
  readonly noteZh: string;
};

/**
 * 构建「他面对我的加注」的响应。
 *
 * @param input.betRangeEntries 他**下注范围**的逐组合权重（V2 口径，已归一化）
 * @param input.currentPot 决策时完整底池（**含**对手这一注）
 * @param input.heroAdd 我这次加注真正新增的筹码
 * @param input.villainAdd 对手跟注还要补的筹码（调用方已按他的剩余筹码封顶）
 * @param input.heroContestedAdd 我真正留在池中的筹码（对手跟不起时小于 `heroAdd`）
 * @param input.finalPot 双方投入后我能争夺到的底池（调用方用分层底池算好）
 * @returns `null` 表示输入不足（无组合、价格非法、牌面不足）—— 调用方必须如实回落，不猜
 */
export function buildRaiseResponse(input: {
  betRangeEntries: readonly { readonly cardIndices: readonly [number, number]; readonly probability: number }[];
  board: readonly Card[];
  /** 决策时完整底池（含对手这一注） */
  currentPot: number;
  /** 我这次加注新增的筹码 */
  heroAdd: number;
  /** 对手跟注还要补的筹码（已封顶） */
  villainAdd: number;
  /** 我真正留在池中的筹码（≤ heroAdd；差额是对手跟不起的退回） */
  heroContestedAdd: number;
  /** 双方投入后我能争夺到的底池 */
  finalPot: number;
  street: 'FLOP' | 'TURN' | 'RIVER';
  tendencies: ResponseTendencies;
  heroIsAllIn: boolean;
  /**
   * 🔴 **P1-2a：对手「跟注即全下」**（他的剩余筹码 ≤ 他为了跟平还需要的筹码）。
   *
   * 这种情形下他跟注之后**下注轮就结束了**（他 allIn、无筹码可再投），
   * 引擎会拒绝他的任何再加注（`ISSUE.ACTION_AFTER_HAND_OVER`）——
   * 因此**不得**产出再加注分支。与 `heroIsAllIn` 是**两个独立判据**：
   * 前者是「我不能再加注」，后者是「他不能再加注」。
   */
  villainIsAllInByCall: boolean;
}): RaiseResponseResult | null {
  const { board } = input;
  if (board.length < 3) return null;
  if (!(input.currentPot > 0)) return null;
  if (!(input.heroAdd > 0)) return null;
  if (!(input.villainAdd > 0)) return null;
  if (!(input.finalPot > 0)) return null;
  /*
   * 🔴 价格 = 他跟注所需的最低权益 = `villainAdd / finalPot`（【数学确定】）。
   *
   * 这是他**自己**的跟注赔率：他要补 `villainAdd`，跟注后底池是 `finalPot`。
   * 修复前用的是 `增量 / (扣掉他这一注的底池 + 2×增量)` —— 分母少了他已经投入的钱，
   * 门槛被系统性抬高（HAND A：0.417445 vs 0.334165）。
   */
  const price = input.villainAdd / input.finalPot;
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;

  const margin = marginOfStreet(input.street);
  const required = price + margin;
  /** 我的加注相对**当前底池**的大小（与 `heroAdd` 同口径；修复前用的是「对手增量 / 扣掉他这一注的底池」） */
  const ratioToPot = input.heroAdd / input.currentPot;

  const t = input.tendencies;
  const callScale = Number.isFinite(t.callScale) ? t.callScale : 1;
  const foldScale = Number.isFinite(t.foldScale) ? t.foldScale : 1;
  const raiseScale = Number.isFinite(t.raiseScale) ? t.raiseScale : 1;
  const bluffRaiseScale = Number.isFinite(t.bluffRaiseScale) ? t.bluffRaiseScale : 1;

  let foldMass = 0;
  let callMass = 0;
  let reRaiseMass = 0;
  let total = 0;
  let reachable = 0;
  const callEntries: { cardIndices: readonly [number, number]; probability: number }[] = [];
  const reRaiseEntries: { cardIndices: readonly [number, number]; probability: number }[] = [];

  for (const entry of input.betRangeEntries) {
    const p = entry.probability;
    if (!(p > 0)) continue;
    const hole: [Card, Card] = [ALL_CARDS[entry.cardIndices[0]]!, ALL_CARDS[entry.cardIndices[1]]!];
    const band = publicStrengthBandOf(hole, board);
    if (band === null) continue;
    reachable += 1;
    total += p;

    const draw = drawProfileOf(hole, board);
    const playability = draw.flushDraw || draw.openEnded
      ? PLAYABILITY_STRONG_DRAW
      : draw.gutshot
        ? PLAYABILITY_WEAK_DRAW
        : 0;
    const strength = RAISE_RESPONSE_BAND_STRENGTH[band] + playability;
    const continueIndex = Math.max(0, Math.min(1, strength * callScale - 0.05 * foldScale));

    if (continueIndex < required) {
      foldMass += p;
      continue;
    }
    /*
     * 继续：再分「跟注 / 再加注」。
     *
     * ⚠️ **Hero 已全下 ⇒ 他不能再加注**（与既有响应模型同一条契约）：
     * 加注权重**迁移到跟注**，而不是从条件范围里消失 ——
     * 否则「Hero 全下」会假装把强牌从他的继续范围里删掉。
     *
     * 🔴 **P1-2a：对手「跟注即全下」时同样不能再加注**。
     *
     * 判据是**他的**筹码，不是我的：他跟平所需要的筹码 ≥ 他的全部剩余
     * ⇒ 他跟注即 allIn，下注轮随即结束，引擎拒绝他的任何再加注
     *（实测 `ISSUE.ACTION_AFTER_HAND_OVER`）。此时若仍产出再加注分支，
     * 就等于凭空给他一个**不可能存在的动作**，并按「Hero 弃牌、损失全部投入」计价。
     *
     * 两个判据**必须分开**（不得合并成一个 `isAllIn`）：
     * | 判据 | 含义 | 谁不能再加注 |
     * |---|---|---|
     * | `heroIsAllIn` | 我已经把筹码投光 | **他**不能再加注（没人能跟） |
     * | `villainIsAllInByCall` | 他跟平即投光 | **他**不能再加注（跟注后轮次结束） |
     *
     * ⚠️ 与「他可以做**不足最小加注额的短筹码全下加注**」是两回事：
     * 只要他跟完之后**还剩筹码**（哪怕不够一次完整再加注），加注就仍然合法，
     * 本分支照旧保留（实测：`RAISE 174`（min 280）被引擎接受）。
     */
    let reRaiseShare = 0;
    if (!input.heroIsAllIn && !input.villainIsAllInByCall) {
      const valueRaise =
        strength >= required + VALUE_RERAISE_EXCESS
          ? Math.max(
              0,
              Math.min(
                1,
                VALUE_RERAISE_BASE +
                  VALUE_RERAISE_SLOPE * (strength - (required + VALUE_RERAISE_EXCESS)) +
                  RAISE_SCALE_WEIGHT * (raiseScale - 1),
              ),
            )
          : 0;
      const bluffRaise =
        (band === PublicStrengthBand.AIR || band === PublicStrengthBand.WEAK_PAIR) &&
        bluffRaiseScale > 1.05 &&
        ratioToPot <= BLUFF_RERAISE_MAX_RATIO
          ? Math.max(0, Math.min(1, BLUFF_RERAISE_BASE + BLUFF_RERAISE_BLUFF_WEIGHT * (bluffRaiseScale - 1)))
          : 0;
      reRaiseShare = Math.max(valueRaise, bluffRaise);
    }
    const callShare = 1 - reRaiseShare;
    callMass += p * callShare;
    reRaiseMass += p * reRaiseShare;
    if (callShare > 0) callEntries.push({ cardIndices: entry.cardIndices, probability: p * callShare });
    /* 🔴 P1-2b：再加注桶**逐组合**收集（与跟注桶同一循环、同一权重来源） */
    if (reRaiseShare > 0) reRaiseEntries.push({ cardIndices: entry.cardIndices, probability: p * reRaiseShare });
  }

  if (reachable === 0 || !(total > 0)) return null;

  const callTotal = callEntries.reduce((a, x) => a + x.probability, 0);
  const normalized = callTotal > 0
    ? callEntries.map((x) => ({ cardIndices: x.cardIndices, probability: x.probability / callTotal }))
    : [];
  /* 🔴 P1-2b：再加注桶同样按桶内质量归一化（桶为空 ⇒ 空数组，绝不伪造） */
  const reRaiseTotal = reRaiseEntries.reduce((a, x) => a + x.probability, 0);
  const normalizedReRaise = reRaiseTotal > 0
    ? reRaiseEntries.map((x) => ({ cardIndices: x.cardIndices, probability: x.probability / reRaiseTotal }))
    : [];

  const model: RaiseResponseModelFacts = Object.freeze({
    kind: 'PUBLIC_BAND_RAISE_RESPONSE_V1',
    evidence: 'HEURISTIC_STRUCTURAL',
    usesHeroHiddenCards: false,
    cashflowContract: CASHFLOW_CONTRACT,
    currentPot: input.currentPot,
    heroAdd: input.heroAdd,
    villainAdd: input.villainAdd,
    heroContestedAdd: input.heroContestedAdd,
    finalPot: input.finalPot,
    priceRequiredEquity: price,
    margin,
    ratioToPot,
    street: input.street,
    heroIsAllIn: input.heroIsAllIn,
    villainIsAllInByCall: input.villainIsAllInByCall,
    strengthOfBand: RAISE_RESPONSE_BAND_STRENGTH,
    noteZh:
      `面对加注的响应（**结构性先验，未经统计校准**）：他需再投 ${input.villainAdd.toFixed(2)}（价格 ${price.toFixed(4)} = ` +
      `${input.villainAdd.toFixed(2)}/${input.finalPot.toFixed(2)}，门槛 ${required.toFixed(4)} = 价格 + ${margin.toFixed(2)}）｜` +
      `继续指数 = 公共强度 × callScale − 0.05×foldScale` +
      `（callScale ${callScale.toFixed(3)}、foldScale ${foldScale.toFixed(3)}、raiseScale ${raiseScale.toFixed(3)}）｜` +
      `Hero 全下 = ${input.heroIsAllIn}（真 ⇒ 他不能再加注，加注权重迁移到跟注）｜` +
      `对手跟注即全下 = ${input.villainIsAllInByCall}（真 ⇒ 同理，他不会再有再加注分支）｜` +
      '强度只用**公共强度带 + 听牌**（不读 Hero 底牌）',
  });

  return Object.freeze({
    foldLikelihood: foldMass / total,
    callLikelihood: callMass / total,
    reRaiseLikelihood: reRaiseMass / total,
    callContinueEntries: Object.freeze(normalized.map((x) => Object.freeze(x))),
    reRaiseEntries: Object.freeze(normalizedReRaise.map((x) => Object.freeze(x))),
    reachableCombos: reachable,
    callCombos: normalized.length,
    reRaiseCombos: normalizedReRaise.length,
    model,
    noteZh:
      `他面对加注：弃 ${((foldMass / total) * 100).toFixed(1)}% / 跟 ${((callMass / total) * 100).toFixed(1)}% / ` +
      `再加注 ${((reRaiseMass / total) * 100).toFixed(1)}%｜跟注桶 ${normalized.length} 组合` +
      `（他要补 ${input.villainAdd.toFixed(2)}，终池 ${input.finalPot.toFixed(2)}，价格 ${price.toFixed(4)}）`,
  });
}
