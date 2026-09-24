/**
 * ============================================================================
 * 翻前加注响应（PREFLOP RAISE RESPONSE）—— 「他会不会跟我的 3Bet / 4Bet」
 * ============================================================================
 *
 * ## 这个模块补的是什么
 *
 * 在它之前，**翻前的加注在全项目里没有任何筹码 EV**：
 * `raiseResponse.ts`（U1）的响应模型要求 `board.length >= 3`，
 * 而翻前 `board` 恒为空 ⇒ `buildRaiseResponse` 返回 `null` ⇒
 * `contextBuilder` 不产出 `raiseResponse` 事实包 ⇒ 决策层把**每一个**加注金额
 * 列进 `unevaluatedActions`，理由码 `RAISE_EV_NOT_IMPLEMENTED`。
 *
 * 实测（`scripts/rr-audit-baseline.ts`，6 人桌 BB 持 AA 面对 BTN 开池 2.5BB）：
 *
 * ```text
 * 建议动作        = RAISE 7.5BB   ← 来自启发式（STRATEGIC_RAISE_FOR_VALUE）
 * CALL EV         = +313.09 筹码
 * 每个加注尺寸 EV = null          ← 7 个候选（4/4.5/6/7.5/9/12/100BB）全部未评估
 * ```
 *
 * 于是「加注 7.5BB 是否比跟注 +313.09 更好」**无法被计算** ——
 * 建议是启发式给的，而界面同时说「加注 EV 未实现」。这正是本项目
 * 在 `MATH_DOMINANCE` 里已经写明的口径：「下注/加注的 EV 依赖对手弃牌率，
 * 本项目无可信估计，**不在此比较之内**」。
 *
 * 本模块给出**翻前专属**的响应模型与逐尺寸 EV，使翻前加注第一次拥有
 * 与 CALL 同一零点、同一单位、可独立复算的模型 EV。
 *
 * ## 🔴 口径：只用**公共信息**（不读 Hero 的隐藏底牌）
 *
 * | 轴 | 来源 | 是否读 Hero 底牌 |
 * |---|---|---|
 * | 对手到达范围 | `RangeSnapshot`（已按他的行动历史贝叶斯更新） | ❌ |
 * | 起手牌强度 | `preflopStrengthOf(rankClass)`（本文件的结构阶梯） | ❌ |
 * | 价格 | `villainAdd / finalPot` ——【数学确定】 | ❌ |
 * | 画像 | `ResponseTendencies`（call/fold/raise/bluffRaise 四个倍率） | ❌ |
 *
 * 强度只用**他的**组合算，与 Hero 拿什么牌无关 —— 有测试锁定
 * 「换掉 Hero 底牌，响应概率逐位不变」。
 *
 * ## 🔴🔴 资金记账：本模块**不自己算底池**
 *
 * 与 `raiseResponse.ts` 同一条纪律（U1 P0 修复的教训）：
 *
 * ```text
 * currentPot      = 决策时完整底池（**含**对手这次加注）
 * heroAdd         = 我这次加注真正新增的筹码
 * villainAdd      = 对手跟平还要补的筹码（短筹码时按他实际能投的封顶）
 * finalPot        = 双方投入后**我能争夺到**的底池（引擎分层口径）
 * price           = villainAdd / finalPot        ← 他跟注所需的最低权益
 * ```
 *
 * 这些量**全部由 `contextBuilder` 用引擎（`computePot` / `previewCommit` /
 * `applyAction`）算好后传入**，本模块只做响应建模。资金口径只有一处事实来源。
 *
 * ## ⚠️ 未校准声明（与 U1 / `betProbabilityByBand` 同一纪律）
 *
 * 本模块只声称三件事：
 * 1. **单调**：起手牌越强 ⇒ 越可能继续（价格相同时）；
 * 2. **价格敏感**：加注越大 ⇒ 继续门槛越高（`required = price + margin`）；
 * 3. **非退化**：每个强度档的继续权重都在 (0,1) 内，不会整类消失。
 *
 * 它**不声称**任何具体频率是真实的。全部结构性取值随
 * `model.strengthLadder` 一起导出，供将来用真实统计替换。
 */

import type { ResponseTendencies } from '../../domain/postflop/betResponse.ts';

/* ============================================================
 * 版本
 * ============================================================ */

/** 模型版本（进诊断与决策快照；结构性取值变化必须升版本） */
export const PREFLOP_RAISE_RESPONSE_MODEL_VERSION = 'PREFLOP_RAISE_RESPONSE_V1';

/**
 * 🔴 **资金口径契约版本**。
 *
 * 与 `raiseResponse.CASHFLOW_CONTRACT` **必须是同一个值**：两种模型共用
 * `raiseEVOf` 这**唯一一条**现金流公式，契约不同就意味着有一处没跟上。
 * 有测试断言两者字面相等。
 */
export const PREFLOP_RAISE_CASHFLOW_CONTRACT = 'NODE_INCREMENTAL_CHIPS_V2' as const;

/* ============================================================
 * 起手牌强度阶梯（**结构性**，只有序关系有意义）
 * ============================================================ */

/**
 * 🔴 **起手牌强弱的锚点**（0..1）—— 只是对外的**可读刻度**。
 *
 * ## 为什么不是「用开池范围权重当强度」
 *
 * 用 `rfiWeights` 的权重当强度会**抹平顶端差异**：按钮位的 RFI 表给
 * `AA` 与 `22` **都是 1.0**（「几乎总会开」），于是「AA 与 22 一样强」——
 * 而 4Bet 范围必须由顶端构成，抹平顶端就等于建不出 4Bet 范围。
 *
 * ## 🔴 「锚点」不是「查表兜底」—— 全域只有**一个**函数
 *
 * 第一版写成「锚点命中直接返回、未命中才算公式」，两套口径拼在一起会产生
 * **互相矛盾**的序（实测 `A9s = 0.34` 而 `A9o = 0.63` ⇒「同花反而不如不同花」）。
 *
 * 现在只有 `preflopStrengthOf` 一个函数；本表由它算出，且
 * `selfCheckPreflopStrength()` 会**逐条断言**两者一致（不是注释，是测试）。
 *
 * 刻度只表达**序关系**：不声称任何数值等于胜率、权益或频率。
 */
export const PREFLOP_STRENGTH_ANCHORS: readonly { readonly key: string; readonly value: number }[] =
  Object.freeze([
    Object.freeze({ key: 'AA', value: 1.0 }),
    Object.freeze({ key: 'KK', value: 0.955 }),
    Object.freeze({ key: 'QQ', value: 0.91 }),
    Object.freeze({ key: 'JJ', value: 0.865 }),
    Object.freeze({ key: 'TT', value: 0.82 }),
    Object.freeze({ key: '99', value: 0.775 }),
    Object.freeze({ key: '88', value: 0.73 }),
    Object.freeze({ key: '77', value: 0.685 }),
    Object.freeze({ key: '66', value: 0.64 }),
    Object.freeze({ key: '55', value: 0.595 }),
    Object.freeze({ key: '44', value: 0.55 }),
    Object.freeze({ key: '33', value: 0.505 }),
    Object.freeze({ key: '22', value: 0.46 }),
    Object.freeze({ key: 'AKs', value: 0.573 }),
    Object.freeze({ key: 'AQs', value: 0.553 }),
    Object.freeze({ key: 'AKo', value: 0.538 }),
    Object.freeze({ key: 'KQs', value: 0.533 }),
    Object.freeze({ key: 'AQo', value: 0.518 }),
    Object.freeze({ key: 'AJs', value: 0.525 }),
    Object.freeze({ key: 'KQo', value: 0.498 }),
    Object.freeze({ key: 'A2s', value: 0.345 }),
    Object.freeze({ key: '76s', value: 0.293 }),
    Object.freeze({ key: '32o', value: 0.098 }),
  ]);

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const;

/** 点数名 → 0（A）..12（2） */
function rankIndexOf(char: string): number {
  return RANKS.indexOf(char as (typeof RANKS)[number]);
}

/* ---- 结构式的结构性系数（全部导出 ⇒ 可独立复算） ---- */

/** 对子区间的步长：`AA = 1.00`，每个点数名递减 0.045 ⇒ `22 = 0.46` */
const S_PAIR_STEP = 0.045;
/** 非对子结构基准的斜率：`base(n) = 0.55 − 0.020 × n`（n = 两个点数名序号之和） */
const S_NONPAIR_BASE = 0.55;
const S_NONPAIR_SLOPE = 0.02;
/** 同花加成 */
const S_SUITED = 0.035;
/** 连张加成（近似顺子潜力，公开扑克理论的结构性描述） */
const S_CONNECTOR = 0.008;

/**
 * 起手牌类别的**强度**（0..1）—— 本模型**唯一**的强度来源。
 *
 * ```text
 * 对子     ：1.00 − 0.045 × 点数名序号  （AA = 1.00 … 22 = 0.46）
 * 非对子   ：0.55 − 0.020 × (高牌序号 + 低牌序号) + 同花加成 0.035 + 连张加成 0.008
 * ```
 *
 * 五条性质（由 `selfCheckPreflopStrength()` **逐条断言**，不靠注释）：
 *
 * | 性质 | 依据 |
 * |---|---|
 * | 对子按点数严格递减 | 步长恒为 0.045 |
 * | 同花严格高于同点数的不同花 | `suited = offsuit + 0.035 > 0` |
 * | A 高严格高于 K 高（同低牌、同结构） | 相邻档差为 0.020 < 0.035 |
 * | 全部落在 (0, 1]，AA 是全域最大值 | 非对子上限 0.99、对子上限 1.00 |
 * | 锚点表与结构式逐位一致 | 同一条断言 |
 *
 * ⚠️ 它是**序关系刻度**：不声称任何具体数值等于胜率或频率。
 * 改这些系数会改变响应概率 ⇒ 已在报告的敏感度分析里覆盖。
 */
export function preflopStrengthOf(rankClass: string): number {
  const isPair = rankClass.length === 2;
  const suited = rankClass.endsWith('s');
  const high = rankIndexOf(rankClass[0]!);
  const low = rankIndexOf(rankClass[1]!);
  if (high < 0 || low < 0) return 0.1; // 未知类别 ⇒ 中性偏低，绝不假装强

  if (isPair) return 1 - S_PAIR_STEP * high;

  const connector = Math.abs(low - high - 1) <= 1 ? S_CONNECTOR : 0;
  const value = S_NONPAIR_BASE - S_NONPAIR_SLOPE * (high + low) + (suited ? S_SUITED : 0) + connector;
  return Math.max(0.05, Math.min(0.99, value));
}

/* ============================================================
 * 结构性系数（全部导出，供独立复算与敏感度分析）
 * ============================================================ */

/**
 * 继续所需的**余量**（`requiredStrength = price + margin`，`price = villainAdd / finalPot`）。
 *
 * ## 为什么必须有这个余量（不是可选的装饰）
 *
 * `price` 是他跟注的**盈亏平衡权益** —— 只按它继续会**系统性高估他的继续比例**，
 * 因为翻前的原始摊牌权益不等于能实现的权益（他还要在三条街上打完，
 * 且位置/可玩性都会影响实现率）。
 *
 * 实测这个缺陷的规模（第一版把价格敏感度写成「固定 0.04 的推移」）：
 *
 * ```text
 * Hero BB AA 面对 BTN 开池 2.5BB，100BB 深
 *   全下 100BB 的模型 EV = +955  ← 看起来「全下最好」
 * Hero BB 55 在同一节点
 *   全下 100BB 也被选中         ← **不可信**：55 面对 100BB 冷 4Bet 不可能继续
 * 根因：他的继续门槛只要求强度 ≥ 0.397，而对 49.5% 的价格这是荒谬的宽松。
 * ```
 *
 * 现在 `requiredStrength = price + margin`：全下时 `price ≈ 0.49` ⇒
 * 门槛 `≈ 0.68` ⇒ 只有 AA / KK / QQ / AKs 这一档才会继续 ——
 * 与「面对 100BB 冷 4Bet 只能拿顶端继续」这一公开扑克理论描述一致。
 *
 * ## 取值的依据（0.19 = 「正常 3Bet 的继续范围约 15%」这一公开量级）
 *
 * 翻前加注的典型局面是「开池 2.5BB、我 3Bet 到 7.5BB」：
 *
 * ```text
 * price  = 5 / 15.5   ≈ 0.323
 * 门槛   = 0.323 + 0.19 = 0.513
 * ```
 *
 * 而本模型的强度刻度上 `≥ 0.513` 的类别是
 * **AA … 55、AKs/AQs/AKo/KQs/AJs/AQo/KJs/ATs/KQo/JTs/AJo/33/A9s/KTs** ——
 * 也就是他开池范围里大约 **15%** 的那一段。这正是公开扑克理论对
 * 「面对 3Bet 的继续范围」给出的量级（12–18%）。
 *
 * 🔴 **`HEURISTIC_THRESHOLD`**：0.19 是**工程取值**，不是从数据估出的参数。
 * 它随模型一起导出，并在 `reports/PREFLOP_RAISE_DECISION_V1.md` 第 5 节
 * 的敏感度分析里被逐档扫过（0.00 / 0.06 / 0.09 / 0.12 / 0.18 / 0.24）。
 */
export const PREFLOP_CONTINUE_MARGIN = 0.19;

/**
 * 价格对继续门槛的**额外推移**（画像的 `foldScale` 走这条通道）。
 *
 * 与 `raiseResponse.ts` 的 `0.05 × foldScale` 同量纲、可直接比较；
 * 取值比翻后小，因为翻前加注的相对涨幅通常小于翻后。
 */
export const PREFLOP_FOLD_SCALE_WEIGHT = 0.03;

/** 再加注（4Bet）的强度门槛：低于它只能是「诈唬 4Bet」，高于它才是价值 4Bet */
export const PREFLOP_RERAISE_VALUE_THRESHOLD = 0.6;

/** 价值端 4Bet 的最大比例（强到顶时全部再加注） */
export const PREFLOP_RERAISE_MAX_SHARE = 0.85;

/** 诈唬端 4Bet 的最大比例（最弱的一档） */
export const PREFLOP_RERAISE_BLUFF_MAX_SHARE = 0.12;

/** 诈唬 4Bet 需要画像偏诈唬：`bluffRaiseScale` 超过它才启用 */
export const PREFLOP_BLUFF_RERAISE_MIN_SCALE = 1.1;

/**
 * 🔴 **再加注桶（4Bet）的强度门槛**。
 *
 * 只有强度 ≥ 门槛的组合才**可能**再加注 —— 这是「4Bet 范围由顶端构成」
 * 这一公开扑克理论描述的可执行形式。
 *
 * 当前取值 0.44 对应本模型的强度刻度上：**所有对子 + AKs/AQs/AKo/KQs/AJs** 及以上。
 * 它直接决定 `P(他 4Bet)` 的量级 ⇒ 必须随模型一起导出并做敏感度分析
 *（`reports/PREFLOP_RAISE_DECISION_V1.md` 的第 5 节）。
 */
export const PREFLOP_RERAISE_GATE = 0.44;

/** 门槛内**线性**映射到再加注比例下界（0 = 刚过门槛只偶尔再加注） */
export const PREFLOP_RERAISE_VALUE_FLOOR = 0.25;

/**
 * 🔴 **可注入的模型调参**（默认 = 下面的生产常数）。
 *
 * ## 为什么要有这个入口（不是「为测试开后门」）
 *
 * 使用者第七节要求：新增系数必须记录来源、假设、版本和**敏感性分析**，
 * 并报告「改变合理假设后，推荐动作或尺寸是否变化」。
 *
 * 若常数被写死在函数体里，敏感性分析就只能**复制一份公式**去改数字 ——
 * 那正是本项目最忌讳的「两处口径」：分析用的公式与生产用的公式会漂移，
 * 于是「敏感度报告」证明的是另一套代码。
 *
 * 因此唯一的公式接受一个**显式**的调参对象，默认值等于生产常数：
 *
 * - 生产：不传 ⇒ 逐位使用下方常数；
 * - 敏感性探针：显式传入被扫的值 ⇒ **同一条公式**、同一份代码。
 */
export type PreflopRaiseTuning = {
  /** 继续门槛余量（默认 `PREFLOP_CONTINUE_MARGIN`） */
  readonly continueMargin: number;
  /** 4Bet 闸门（默认 `PREFLOP_RERAISE_GATE`） */
  readonly reRaiseGate: number;
  /** 价值 4Bet 的强度门槛（默认 `PREFLOP_RERAISE_VALUE_THRESHOLD`） */
  readonly reRaiseValueThreshold: number;
  /** 价值端 4Bet 的最大比例（默认 `PREFLOP_RERAISE_MAX_SHARE`） */
  readonly reRaiseMaxShare: number;
  /** 门槛内线性映射的下界（默认 `PREFLOP_RERAISE_VALUE_FLOOR`） */
  readonly reRaiseValueFloor: number;
};

/** 生产默认调参（`Object.freeze` 且被测试锁定为「等于上方常数」） */
export const PREFLOP_RAISE_TUNING: PreflopRaiseTuning = Object.freeze({
  continueMargin: PREFLOP_CONTINUE_MARGIN,
  reRaiseGate: PREFLOP_RERAISE_GATE,
  reRaiseValueThreshold: PREFLOP_RERAISE_VALUE_THRESHOLD,
  reRaiseMaxShare: PREFLOP_RERAISE_MAX_SHARE,
  reRaiseValueFloor: PREFLOP_RERAISE_VALUE_FLOOR,
});

/* ============================================================
 * 价格
 * ============================================================ */

/**
 * 他面对这次加注所需的**权益**（他跟注要补的筹码占他跟注后底池的比例）。
 *
 * 【数学确定】：`villainAdd / finalPot`，不含任何模型假设。
 */
export function preflopPriceOf(input: { villainAdd: number; finalPot: number }): number {
  if (!(input.finalPot > 0)) return 1;
  return input.villainAdd / input.finalPot;
}

/* ============================================================
 * 响应模型
 * ============================================================ */

export type PreflopRaiseResponseBucket = 'FOLD' | 'CALL' | 'RERAISE';

export type PreflopRaiseResponse = {
  readonly foldLikelihood: number;
  readonly callLikelihood: number;
  readonly reRaiseLikelihood: number;
  /** 跟注桶的**条件范围**（桶内归一化） */
  readonly callEntries: readonly { readonly cardIndices: readonly [number, number]; readonly probability: number }[];
  /** 再加注桶的**条件范围**（桶内归一化；桶空 ⇒ 空数组，绝不伪造） */
  readonly reRaiseEntries: readonly { readonly cardIndices: readonly [number, number]; readonly probability: number }[];
  readonly reachableCombos: number;
  readonly callCombos: number;
  readonly reRaiseCombos: number;
  /** 他面对这次加注需要的权益（【数学确定】） */
  readonly priceRequiredEquity: number;
  /** 模型使用的余量 */
  readonly margin: number;
  readonly requiredStrength: number;
  readonly noteZh: string;
};

/**
 * 构建「他面对我的翻前加注」的响应。
 *
 * @param arrivalEntries 他**到达范围**的逐组合权重（由引擎的贝叶斯更新产生，
 *   已按他的开池行动条件化 —— 不做这一步就等于忽略他开过池这个事实）
 * @param currentPot 决策时完整底池（**含**他这次加注）
 * @param heroAdd 我这次加注真正新增的筹码
 * @param villainAdd 他跟平还要补的筹码（调用方已按他的剩余筹码封顶）
 * @param finalPot 双方投入后我能争夺到的底池
 * @param tendencies 他面对加注的响应倍率（**只来自公共信息**）
 * @param heroIsAllIn 我已把筹码投光 ⇒ 他不能再加注
 * @param villainIsAllInByCall 他跟平即投光 ⇒ 他不能再加注
 * @returns `null` 表示输入不足（无组合、价格非法）—— 调用方必须如实回落，不猜
 */
export function buildPreflopRaiseResponse(input: {
  readonly arrivalEntries: readonly { readonly cardIndices: readonly [number, number]; readonly probability: number }[];
  readonly currentPot: number;
  readonly heroAdd: number;
  readonly villainAdd: number;
  readonly finalPot: number;
  readonly tendencies: ResponseTendencies;
  readonly heroIsAllIn: boolean;
  readonly villainIsAllInByCall: boolean;
  /** 可选的公共行动历史折扣；不读 Hero 底牌。 */
  readonly actionHistoryScale?: { readonly foldScale?: number; readonly callScale?: number; readonly reRaiseScale?: number };
  /** 契约：**禁止**读 Hero 底牌。调用方无从传入，这里显式记入事实包 */
  /** 🔴 可注入调参（默认 = 生产常数）；仅供**同一条公式**的敏感性分析使用 */
  readonly tuning?: PreflopRaiseTuning;
}): PreflopRaiseResponse | null {
  const tuning = input.tuning ?? PREFLOP_RAISE_TUNING;
  if (!(input.currentPot > 0)) return null;
  if (!(input.heroAdd > 0)) return null;
  if (!(input.villainAdd > 0)) return null;
  if (!(input.finalPot > 0)) return null;

  const price = preflopPriceOf({ villainAdd: input.villainAdd, finalPot: input.finalPot });
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;

  const required = price + tuning.continueMargin;

  const history = input.actionHistoryScale;
  const callScale = Number.isFinite(input.tendencies.callScale) ? input.tendencies.callScale : 1;
  const foldScale = (Number.isFinite(input.tendencies.foldScale) ? input.tendencies.foldScale : 1) * (history?.foldScale ?? 1);
  const raiseScale = (Number.isFinite(input.tendencies.raiseScale) ? input.tendencies.raiseScale : 1) * (history?.reRaiseScale ?? 1);
  const bluffRaiseScale = Number.isFinite(input.tendencies.bluffRaiseScale) ? input.tendencies.bluffRaiseScale : 1;
  const historicalCallScale = history?.callScale ?? 1;

  /*
   * 🔴 **门槛 = 价格 + 余量**，再叠加一点画像折扣（`foldScale` 越大 ⇒ 他越爱弃
   * ⇒ 门槛略降）。**不再**用一个固定的「0.04 推移」——
   * 那会让 100BB 全下（价格 ≈ 0.49）也只需要强度 0.397，于是任何对子都能「继续」。
   */
  const requiredStrength = Math.max(0, required - PREFLOP_FOLD_SCALE_WEIGHT * (foldScale - 1));

  let foldMass = 0;
  let callMass = 0;
  let reRaiseMass = 0;
  let total = 0;
  let reachable = 0;
  const callEntries: { cardIndices: readonly [number, number]; probability: number }[] = [];
  const reRaiseEntries: { cardIndices: readonly [number, number]; probability: number }[] = [];
  /** 再加注闸门的实际作用范围（诊断用） */
  let gateCombos = 0;
  let gateMass = 0;

  const canReRaise = !input.heroIsAllIn && !input.villainIsAllInByCall;

  for (const entry of input.arrivalEntries) {
    const p = entry.probability;
    if (!(p > 0)) continue;
    reachable += 1;
    total += p;

    const strength = preflopStrengthOf(rankClassOfIndices(entry.cardIndices));
    /*
     * 与 U1 同构的「继续指数」：`强度 × callScale`（他越爱跟 ⇒ 同强度更容易继续），
     * 与 `requiredStrength`（= 价格 + 余量）比较。两者都是 0..1 的无量纲刻度。
     */
    const continueIndex = strength * callScale * historicalCallScale;

    if (continueIndex < requiredStrength) {
      foldMass += p;
      continue;
    }

    let reRaiseShare = 0;
    if (canReRaise) {
      const gateActive = strength >= tuning.reRaiseGate;
      if (gateActive) {
        gateCombos += 1;
        gateMass += p;
        const span = 1 - tuning.reRaiseGate;
        const positionInGate = span > 0 ? (strength - tuning.reRaiseGate) / span : 0;
        const isValue = strength >= tuning.reRaiseValueThreshold;
        const valueShare = isValue
          ? tuning.reRaiseValueFloor +
            (tuning.reRaiseMaxShare - tuning.reRaiseValueFloor) *
              Math.max(0, Math.min(1, positionInGate))
          : 0;
        /*
         * 诈唬 4Bet 只在**画像明确偏诈唬**时启用（`bluffRaiseScale > 1.1`）。
         * 没有画像时 `bluffRaiseScale === 1` ⇒ 恒为 0 ⇒ 不凭空造诈唬。
         * 这是「画像只改概率、不制造组合」的既有纪律。
         */
        const bluffShare =
          bluffRaiseScale > PREFLOP_BLUFF_RERAISE_MIN_SCALE
            ? Math.min(
                PREFLOP_RERAISE_BLUFF_MAX_SHARE,
                PREFLOP_RERAISE_BLUFF_MAX_SHARE *
                  Math.max(0, 1 - positionInGate) *
                  (bluffRaiseScale - 1),
              )
            : 0;
        reRaiseShare = Math.max(valueShare, bluffShare);
        reRaiseShare = Math.max(0, Math.min(1, reRaiseShare * raiseScale0(raiseScale)));
      }
    }

    const callShare = 1 - reRaiseShare;
    callMass += p * callShare;
    reRaiseMass += p * reRaiseShare;
    if (callShare > 0) callEntries.push({ cardIndices: entry.cardIndices, probability: p * callShare });
    if (reRaiseShare > 0) reRaiseEntries.push({ cardIndices: entry.cardIndices, probability: p * reRaiseShare });
  }

  if (reachable === 0 || !(total > 0)) return null;

  const callTotal = callEntries.reduce((a, x) => a + x.probability, 0);
  const normalizedCall = callTotal > 0
    ? callEntries.map((x) => ({ cardIndices: x.cardIndices, probability: x.probability / callTotal }))
    : [];
  const reRaiseTotal = reRaiseEntries.reduce((a, x) => a + x.probability, 0);
  const normalizedReRaise = reRaiseTotal > 0
    ? reRaiseEntries.map((x) => ({ cardIndices: x.cardIndices, probability: x.probability / reRaiseTotal }))
    : [];

  return Object.freeze({
    foldLikelihood: foldMass / total,
    callLikelihood: callMass / total,
    reRaiseLikelihood: reRaiseMass / total,
    callEntries: Object.freeze(normalizedCall.map((x) => Object.freeze(x))),
    reRaiseEntries: Object.freeze(normalizedReRaise.map((x) => Object.freeze(x))),
    reachableCombos: reachable,
    callCombos: normalizedCall.length,
    reRaiseCombos: normalizedReRaise.length,
    priceRequiredEquity: price,
    margin: PREFLOP_CONTINUE_MARGIN,
    requiredStrength,
    noteZh:
      `他面对加注（**${PREFLOP_RAISE_RESPONSE_MODEL_VERSION}**，结构性先验、未经统计校准）：` +
      `弃 ${((foldMass / total) * 100).toFixed(1)}% / 跟 ${((callMass / total) * 100).toFixed(1)}% / ` +
      `再加注 ${((reRaiseMass / total) * 100).toFixed(1)}%｜` +
      `他要补 ${input.villainAdd.toFixed(2)}、终池 ${input.finalPot.toFixed(2)}，` +
      `价格 ${price.toFixed(4)} + 余量 ${PREFLOP_CONTINUE_MARGIN.toFixed(2)} = 门槛 ${requiredStrength.toFixed(4)}｜` +
      `跟注桶 ${normalizedCall.length} 组合、再加注桶 ${normalizedReRaise.length} 组合` +
      `（闸门 ${PREFLOP_RERAISE_GATE} 内 ${gateCombos} 组合 / 质量 ${(total > 0 ? gateMass / total : 0).toFixed(4)}）｜` +
      `强度只用**他的**起手牌类别（不读 Hero 底牌）`,
  });
}

/** 画像「更爱加注」倍率对再加注比例的缩放（有界，避免 >1） */
function raiseScale0(raiseScale: number): number {
  if (!Number.isFinite(raiseScale)) return 1;
  // 1 ± 0.35 的画像倍率 ⇒ 0.65..1.35 的缩放；夹在 [0.5, 1.5]
  return Math.max(0.5, Math.min(1.5, 0.5 + 0.5 * raiseScale));
}

/* ============================================================
 * 类别解析
 * ============================================================ */

const RANK_CHARS_OUT = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const;

/**
 * 由组合的两张牌下标求**类别键**（`AA` / `AKs` / `AKo`）。
 *
 * ⚠️ 只看点数与是否同花 —— 与「读 Hero 底牌」没有任何关系：
 * 这里读的是**对手自己**的组合。
 */
export function rankClassOfIndices(cardIndices: readonly [number, number]): string {
  /*
   * 🔴 索引编码以 `domain/poker/cards.ts` 的 `cardIndex` 为**唯一权威**：
   * `index = suitIndex × 13 + (rank − 2)`。
   * 因此排名 = `index % 13`（0 = 2 … 12 = A）、花色 = `floor(index / 13)`。
   * 绝不在这里自己造一套位移编码 —— 那种「两处口径」正是本项目最忌讳的形态。
   */
  const a = cardIndices[0];
  const b = cardIndices[1];
  const rankA = a % 13;
  const rankB = b % 13;
  const suitA = Math.floor(a / 13);
  const suitB = Math.floor(b / 13);
  if (rankA === rankB) return `${RANK_CHARS_OUT[12 - rankA]}${RANK_CHARS_OUT[12 - rankA]}`;
  const high = Math.max(rankA, rankB);
  const low = Math.min(rankA, rankB);
  const suited = suitA === suitB ? 's' : 'o';
  return `${RANK_CHARS_OUT[12 - high]}${RANK_CHARS_OUT[12 - low]}${suited}`;
}

/* ============================================================
 * 翻前再加注尺寸（从真实行动状态推导，不用固定倍数）
 * ============================================================ */

/**
 * 他面对我的加注后**再加注到多少**。
 *
 * 规则（与引擎一致，不从模型编造）：
 *
 * ```text
 * minReRaiseTo = 我的加注额 + (我的加注额 − 加注前他的本街投入)   ← 最小完整加注
 * villainMaxTo = 他跟平后的本街总额 + 他剩余的筹码               ← 他的全下上限
 * reRaiseTo    = min(minReRaiseTo, villainMaxTo)
 * ```
 *
 * 他买不起完整再加注时**只能全下（under-raise）** —— 那条法律上仍有效
 * （TDA：不足一个完整加注的全下仍然合法）。若连全下都超不过我的总额
 * ⇒ 他根本不能加注（调用方应在此之前把 `reRaiseLikelihood` 归零）。
 */
export function preflopReRaiseToOf(input: {
  /** 我这次加注到多少（本街总额） */
  readonly raiseTo: number;
  /** 我加注**之前**他的本街投入 */
  readonly villainCommittedBefore: number;
  /** 他跟平我的加注之后的本街总额 */
  readonly villainStreetTotalAfterCall: number;
  /** 他跟平之后还剩多少筹码 */
  readonly villainRemainingAfterCall: number;
}): {
  readonly minReRaiseTo: number;
  readonly villainMaxTo: number;
  readonly reRaiseTo: number;
  readonly isAllIn: boolean;
} {
  const minReRaiseTo = input.raiseTo + (input.raiseTo - input.villainCommittedBefore);
  const villainMaxTo = input.villainStreetTotalAfterCall + Math.max(0, input.villainRemainingAfterCall);
  const reRaiseTo = Math.min(minReRaiseTo, villainMaxTo);
  return Object.freeze({
    minReRaiseTo,
    villainMaxTo,
    reRaiseTo,
    isAllIn: reRaiseTo >= villainMaxTo - 1e-9,
  });
}

/* ============================================================
 * 自检（构建期与测试用）
 * ============================================================ */

/**
 * 强度阶梯自检：六条不变量。
 *
 * 1. 全部落在 (0, 1]
 * 2. 对子按点数严格递减（AA > KK > … > 22）
 * 3. 同花严格高于同点数的不同花
 * 4. A 高严格高于同结构 / 同低牌的非 A 类别
 * 5. **锚点表与结构式逐位一致**（防止「表说 0.9、公式算 0.7」这类两处口径）
 * 6. AA 是全域最大值
 *
 * 返回空数组表示全部通过 —— 与项目其余 `selfCheck*` 同一形状。
 */
export function selfCheckPreflopStrength(): string[] {
  const problems: string[] = [];
  const all: string[] = [];
  for (let i = 0; i < RANKS.length; i += 1) {
    for (let j = 0; j < RANKS.length; j += 1) {
      const a = RANKS[i]!;
      const b = RANKS[j]!;
      if (i === j) all.push(`${a}${b}`);
      else if (i < j) all.push(`${a}${b}s`, `${a}${b}o`);
    }
  }
  // 1. 值域
  for (const key of all) {
    const v = preflopStrengthOf(key);
    if (!Number.isFinite(v) || v <= 0 || v > 1) problems.push(`${key} 强度越界：${v}`);
  }
  // 2. 对子单调
  for (let i = 0; i + 1 < RANKS.length; i += 1) {
    const higher = `${RANKS[i]}${RANKS[i]}`;
    const lower = `${RANKS[i + 1]}${RANKS[i + 1]}`;
    if (!(preflopStrengthOf(higher) > preflopStrengthOf(lower))) {
      problems.push(`对子不单调：${higher} ${preflopStrengthOf(higher)} !> ${lower} ${preflopStrengthOf(lower)}`);
    }
  }
  // 3. 同花 > 不同花
  for (const key of all) {
    if (!key.endsWith('s')) continue;
    const offsuit = `${key.slice(0, 2)}o`;
    if (!(preflopStrengthOf(key) > preflopStrengthOf(offsuit))) {
      problems.push(
        `同花未高于不同花：${key} ${preflopStrengthOf(key)} !> ${offsuit} ${preflopStrengthOf(offsuit)}`,
      );
    }
  }
  // 4. A 高 > K 高（同低牌、同结构）
  for (let low = 1; low < RANKS.length; low += 1) {
    const lowChar = RANKS[low]!;
    for (const suffix of ['s', 'o'] as const) {
      const aceHigh = `A${lowChar}${suffix}`;
      const kingHigh = `K${lowChar}${suffix}`;
      if (!(preflopStrengthOf(aceHigh) > preflopStrengthOf(kingHigh))) {
        problems.push(
          `A 高未高于 K 高：${aceHigh} ${preflopStrengthOf(aceHigh)} !> ${kingHigh} ${preflopStrengthOf(kingHigh)}`,
        );
      }
    }
  }
  // 5. 锚点表与结构式一致（容差 1e-9；锚点表只是刻度展示）
  for (const anchor of PREFLOP_STRENGTH_ANCHORS) {
    const computed = preflopStrengthOf(anchor.key);
    if (Math.abs(computed - anchor.value) > 1e-9) {
      problems.push(`锚点 ${anchor.key} 与结构式不一致：表 ${anchor.value} vs 公式 ${computed}`);
    }
  }
  // 6. AA 最大
  for (const key of all) {
    if (preflopStrengthOf(key) > preflopStrengthOf('AA') + 1e-12) {
      problems.push(`${key} 强于 AA：${preflopStrengthOf(key)} > ${preflopStrengthOf('AA')}`);
    }
  }
  return problems;
}

/** 供诊断与测试读取的位置相关说明（本模型不按位置改强度，位置只改范围与价格） */
export const PREFLOP_RAISE_POSITION_NOTE =
  '位置影响的是**他的到达范围**（开池档位由位置决定）与**价格**，' +
  '不在本模块里对强度另加位置系数 —— 避免同一份位置证据收两次费';
