/**
 * 🔴 **Hero 相对牌力角色**（2026-09 翻后升级 · P1）
 *
 * ## 修的是什么
 *
 * 审计确认：修复前翻后只看 `handCategory`（1..9 的**绝对**牌型）：
 *
 * ```text
 * 超对 A 与底对 2 → 同为 category 2 → 同一档 MEDIUM → 同一条下注尺寸公式
 * 两对（category 3）权益 87.9% 面对 1/3 池下注 → 只能 CALL（shouldRaise 不含 MEDIUM）
 * ```
 *
 * 形状（超对/顶对/中对/底对/暗三条…）由 `describeHand` **早就算出来了**，
 * 却只被渲染成中文字符串 —— 决策层一个字段都没读。
 *
 * 本模块把「形状 + 权益 + 是否面对下注 + 人数 + 听牌 + 对手范围事实」
 * 组合成**相对**角色。同一个「一对」在不同牌面/范围下可以是
 * 顶对价值、中等价值、摊牌价值或抓诈牌。
 *
 * ## 判据全部是结构性的（没有针对具体牌面的硬编码）
 *
 * - 门限用**权益相对门槛**（`heroEquity` 与 `requiredEquity`）与**结构阈值**
 *  （权益 0.85/0.70/0.58/0.45 四档），不是「KQ 就怎样」
 * - 形状来自既有的 `HandShape`（单一事实来源）
 * - 多人池按人数做**单调惩罚**（见 `multiway.ts`）
 * - 听牌来自 `draws.ts` 的补牌计数，**且只在还有牌要发的街上有效**
 *
 * ## 🔴 河牌的定义域约束（RIVER CONSISTENCY V2）
 *
 * ```text
 * street === 'RIVER'  ⇒  role ∉ { DRAW, SEMI_BLUFF }
 * ```
 *
 * 「听牌」的语义是「现在没成，但**还有牌能让我成**」；河牌之后第二句永远为假。
 * 修复前实测：Hero A♣Q♠ 在 Q♦8♣5♣2♥K♣（三张♣）上因 `flushDraw = true`
 * 被判成 `DRAW` —— 那是**上一街**的身份，不是当前决策点的牌力。
 * 现在第 3 节在河牌整段不适用，另有 `normalizeRiverRole` 在产出侧兜底。
 */

import type { HandShape } from '../poker/handDescription.ts';
import { RelativeHandRole, RELATIVE_ROLE_ZH, type PostflopInputs, type OpponentRangeFacts } from './types.ts';
import { multiwayAdjustment } from './multiway.ts';

/** 权益分档（**结构性判断**，不是从数据估出的参数） */
export const EQUITY_BANDS = Object.freeze({
  /** ≥ 此值且形状够好 = 坚果级 */
  NUT: 0.85,
  /** ≥ 此值 = 强价值 */
  STRONG: 0.7,
  /** ≥ 此值 = 中等价值（多数顶对/超对） */
  MEDIUM: 0.58,
  /** ≥ 此值 = 薄价值（只在更差的牌会跟时才有意义） */
  THIN: 0.45,
});

/** 形状是否属于「坚果级结构」（不需要靠权益判断） */
function isNutStructure(shape: HandShape): boolean {
  return shape === 'STRAIGHT_FLUSH' || shape === 'QUADS' || shape === 'FULL_HOUSE';
}

/** 形状是否属于「强价值结构」 */
function isStrongStructure(shape: HandShape): boolean {
  return shape === 'FLUSH' || shape === 'STRAIGHT' || shape === 'SET' || shape === 'TRIPS';
}

/** 形状是否属于「一对级」（含超对/顶对/中对/底对/小对子） */
export function isOnePairShape(shape: HandShape): boolean {
  return (
    shape === 'OVERPAIR' ||
    shape === 'OVERPAIR_TOP' ||
    shape === 'TOP_PAIR' ||
    shape === 'MIDDLE_PAIR' ||
    shape === 'BOTTOM_PAIR' ||
    shape === 'UNDERPAIR' ||
    shape === 'POCKET_PAIR_OVER'
  );
}

/** 形状是否属于「两对级」 */
function isTwoPairShape(shape: HandShape): boolean {
  return shape === 'TWO_PAIR' || shape === 'TOP_TWO_PAIR';
}

/** 形状是否「有摊牌价值但不值得下注」 */
function isShowdownShape(shape: HandShape): boolean {
  return shape === 'MIDDLE_PAIR' || shape === 'BOTTOM_PAIR' || shape === 'UNDERPAIR';
}

/* ============================================================
 * 🔴 Made Hand 与 Relative Role 必须分开（RIVER CONSISTENCY V2.1 · P0-1）
 * ============================================================ */

/**
 * **成交牌型**（made hand class）—— 「我手里是什么」，与对手/牌面无关。
 *
 * 🔴 与 `RelativeHandRole` 是**两个不同的问题**（使用者第二节）：
 *
 * | 问题 | 类型 | 例子 |
 * |---|---|---|
 * | 我**是什么**牌 | `MadeHandClass` | `PAIR`（一对 Q） |
 * | 这手牌**相对**对手范围/牌面是什么角色 | `RelativeHandRole` | `SHOWDOWN_VALUE` / `BLUFF_CATCHER` |
 *
 * 修复前的缺陷正是把两者混在一起：一手**中对**因为「权益低于 0.9 × 门槛」
 * 被直接归为 `AIR`，而 `AIR` 的定义是「什么都赢不了」——
 * 一手能赢下对手 22% 范围的中对显然不是空气。
 */
export const MadeHandClass = {
  HIGH_CARD: 'HIGH_CARD',
  PAIR: 'PAIR',
  TWO_PAIR: 'TWO_PAIR',
  TRIPS: 'TRIPS',
  STRAIGHT: 'STRAIGHT',
  FLUSH: 'FLUSH',
  FULL_HOUSE: 'FULL_HOUSE',
  QUADS: 'QUADS',
  STRAIGHT_FLUSH: 'STRAIGHT_FLUSH',
} as const;
export type MadeHandClass = (typeof MadeHandClass)[keyof typeof MadeHandClass];

/** 成交牌型的中文名（对外文案） */
export const MADE_HAND_CLASS_ZH: Readonly<Record<MadeHandClass, string>> = Object.freeze({
  HIGH_CARD: '高牌',
  PAIR: '一对',
  TWO_PAIR: '两对',
  TRIPS: '三条',
  STRAIGHT: '顺子',
  FLUSH: '同花',
  FULL_HOUSE: '葫芦',
  QUADS: '四条',
  STRAIGHT_FLUSH: '同花顺',
});

/**
 * 牌型序号（`HandCategory`，1..9）→ 成交牌型类。
 *
 * 映射是**结构性的**（一对就是一对），不含任何牌面或对手信息。
 */
export function madeHandClassOf(category: number): MadeHandClass {
  switch (category) {
    case 1:
      return MadeHandClass.HIGH_CARD;
    case 2:
      return MadeHandClass.PAIR;
    case 3:
      return MadeHandClass.TWO_PAIR;
    case 4:
      return MadeHandClass.TRIPS;
    case 5:
      return MadeHandClass.STRAIGHT;
    case 6:
      return MadeHandClass.FLUSH;
    case 7:
      return MadeHandClass.FULL_HOUSE;
    case 8:
      return MadeHandClass.QUADS;
    case 9:
      return MadeHandClass.STRAIGHT_FLUSH;
    default:
      return MadeHandClass.HIGH_CARD;
  }
}

/** 有多少「更差 / 打平」的质量才算**有摊牌价值**（低于此值才允许判空气） */
export const MIN_SHOWDOWN_VALUE_SHARE = 0.02;

/**
 * 对**对手可达范围**是否有摊牌价值。
 *
 * 判据只用**真实数据**（`weakerShare` 与 `equalShare` 来自
 * `handEval.compareHands` 的逐组合精确比较）：
 *
 * - 有一小部分质量比我校（≥ `MIN_SHOWDOWN_VALUE_SHARE`）⇒ 有摊牌价值
 * - **拿不到范围事实** ⇒ 如实返回 `null`（不知道），调用方必须按「不知道」处理，
 *   **不得**默认成空气
 */
export function hasShowdownValueOf(facts: OpponentRangeFacts | null): boolean | null {
  if (facts === null) return null;
  return facts.weakerShare + facts.equalShare >= MIN_SHOWDOWN_VALUE_SHARE;
}

/**
 * 🔴 **域不变量**：河牌上「成交牌型 ≥ 一对」的手牌**不得**被归类为空气。
 *
 * ```text
 * street === 'RIVER' && madeHand !== HIGH_CARD  ⇒  role ≠ AIR
 * ```
 *
 * ## 为什么需要它
 *
 * 修复前实测（真实管线，Hero BTN A♣Q♠，牌面 Q♦8♣5♣/2♥/K♣，面对 22BB）：
 *
 * ```text
 * madeHandShape = MIDDLE_PAIR（中对 Q，A 踢脚）
 * equity 24.0% < requiredEquity × 0.9 = 25.2%
 * ⇒ role = AIR                    ← 一手能赢下对手 22.06% 范围的中对被叫空气
 * ```
 *
 * 触发点是 `isOnePairShape` 分支里的 `equity >= requiredEquity * 0.9`：
 * 它回答的是「**能不能盈利地抓诈唬**」，却被用来回答「**是不是空气**」。
 *
 * ## 唯一的例外（必须显式、有数据支撑）
 *
 * `AIR` 的文档定义是「什么都赢不了」。因此如果对手的**可达范围**里确实
 * **没有任何**比这手牌更差的组合（`weakerShare + equalShare ≈ 0`），
 * 那么「空气」这个词是准确的 —— 底对 5♥4♥ 在本节点权益仅 1.3%，
 * 就属于这种情况，它**仍然**可以是 AIR。
 *
 * 唯一的禁区是：**不能因为「价值下注不成立」或「抓诈唬不够」就判空气**。
 */
export function madeHandRoleInvariantViolation(input: {
  street: string;
  madeHand: MadeHandClass;
  role: RelativeHandRole;
}): string | null {
  if (input.street !== 'RIVER') return null;
  if (input.role !== RelativeHandRole.AIR) return null;
  if (input.madeHand === MadeHandClass.HIGH_CARD) return null;
  return (
    `河牌上「${input.madeHand}」不得被归类为 AIR —— AIR 的定义是「对对手最终继续范围` +
    '没有任何摊牌价值」；成交牌型 ≥ 一对时，除非可达范围里确实没有任何更差的组合，' +
    '否则必须归为 SHOWDOWN_VALUE / BLUFF_CATCHER 等有摊牌价值的角色'
  );
}

/**
 * 面对下注时，**成交牌型 ≥ 一对**的手牌该落到哪个角色（P0-1 的统一规则）。
 *
 * 三个输入决定，全部来自真实数据：
 *
 * | 输入 | 来源 |
 * |---|---|
 * | 权益是否够跟注 | `heroEquity >= requiredEquity` |
 * | 是否有摊牌价值 | `hasShowdownValue`（逐组合精确比较） |
 * | 是否还有牌要发 | 河牌上没有「听牌」这条路（V2 已锁） |
 *
 * ```text
 * 权益 ≥ 门槛              ⇒ BLUFF_CATCHER（跟注本身有利可图）
 * 有摊牌价值（或不详）      ⇒ SHOWDOWN_VALUE（能赢一部分摊牌，但不值得继续投入）
 * 确认毫无摊牌价值          ⇒ AIR（这才是「什么都赢不了」）
 * ```
 */
function madeHandRoleFacingBet(input: {
  heroEquity: number | null;
  requiredEquity: number;
  hasShowdownValue: boolean | null;
}): RelativeHandRole {
  const { heroEquity, requiredEquity, hasShowdownValue } = input;
  if (heroEquity !== null && heroEquity >= requiredEquity) return RelativeHandRole.BLUFF_CATCHER;
  /*
   * ⚠️ 「不知道」不能当成「没有」：拿不到范围事实时按**有**摊牌价值处理
   *（宁可保守地承认这手牌能赢点什么，也不要谎称它是空气）。
   */
  if (hasShowdownValue !== false) return RelativeHandRole.SHOWDOWN_VALUE;
  return RelativeHandRole.AIR;
}

/**
 * 判定角色。
 *
 * ⚠️ **面对下注**与**无人下注**是两种不同的处境：
 * 前者关心「跟注/加注/弃牌」，后者关心「下注/过牌」。
 * 同一个手牌在两种处境下的角色可以不同（例如中等对子在面对下注时是抓诈牌，
 * 在无人下注时是摊牌价值）。
 */
export function classifyRelativeRole(input: PostflopInputs): RelativeHandRole {
  const { shape, heroEquity, requiredEquity, facingBet, draws, opponentCount, spr } = input;
  const multiway = opponentCount >= 2;
  const bandShift = multiwayAdjustment(opponentCount).equityThresholdShift;
  const equity = heroEquity;
  /*
   * 🔴 **河牌没有未来公共牌**（【数学确定】· RIVER CONSISTENCY V2）。
   *
   * `draws.ts` 的 `flushDraw` / `openEnded` / `gutshot` 是**未来补牌**的描述：
   * 「我有四张同花 ⇒ 还有一张能让我成同花」。河牌发完之后这件事**不存在** ——
   * 要么已经成花，要么永远不成。
   *
   * 修复前实测（真人节点 Hero BTN A♣Q♠，牌面 Q♦8♣5♣/2♥/**K♣**，面对 22BB 下注）：
   *
   * ```text
   * shape = MIDDLE_PAIR（中对 Q）     drawProfile.flushDraw = true（A♣ + 三张♣）
   * ⇒ 角色 = DRAW（听牌）            ⇒ 3 街后的河牌仍被标记为「听牌」
   * ```
   *
   * 后果不只是文案：`DRAW` 会绕开第 4 节的「一对级」判定，
   * 于是一手**抓诈牌**被当成听牌处理（价值判断、阻断牌、偏好分全部受影响）。
   *
   * 现在：只有**还有牌要发**的街才允许进入听牌分支。河牌上「听牌」在结构上
   * 不可能存在，因此这里不是「降低听牌权重」，而是**整段不适用**。
   */
  const cardsToCome = input.street !== 'RIVER';

  // ---- 1) 坚果级：结构上就是坚果，**且权益确认** ----
  /*
   * 🔴 审计抓到的 MAJOR：第一版只看形状 ⇒「任意葫芦 = 坚果级（强度 1.0）」、
   * 「非坚果同花/底三条 = 强价值（0.82）」，而**权益可能很低**
   * （实测：单色面上底三条 22% 权益仍被判成强价值）。
   *
   * 现在形状只给**上限**，权益给**确认**：
   * 权益明显低于该档位应有水平时降级。权益未知（null）时保持形状判断
   *（宁可如实说「不知道」也不假装确认）。
   */
  if (isNutStructure(shape)) {
    if (equity === null || equity >= EQUITY_BANDS.STRONG + bandShift) return RelativeHandRole.NUT_VALUE;
    return RelativeHandRole.STRONG_VALUE;
  }
  if (equity !== null && equity >= EQUITY_BANDS.NUT + bandShift) return RelativeHandRole.NUT_VALUE;

  // ---- 2) 强价值：三条/顺子/同花级结构（同样需要权益确认） ----
  if (isStrongStructure(shape)) {
    if (equity === null || equity >= EQUITY_BANDS.MEDIUM + bandShift) return RelativeHandRole.STRONG_VALUE;
    // 形状是成手，但权益说它被反超（例如单色面上的底三条）⇒ 降为中等价值
    return RelativeHandRole.MEDIUM_VALUE;
  }
  if (equity !== null && equity >= EQUITY_BANDS.STRONG + bandShift) {
    return isTwoPairShape(shape) && equity >= EQUITY_BANDS.STRONG + 0.1
      ? RelativeHandRole.STRONG_VALUE
      : RelativeHandRole.MEDIUM_VALUE;
  }

  // ---- 3) 听牌：**还没成手但补牌够**，且后面还有牌要发 ----
  const hasRealDraw = cardsToCome && (draws.flushDraw || draws.openEnded);
  if (hasRealDraw && !isStrongStructure(shape) && !isTwoPairShape(shape)) {
    /*
     * 半诈唬 = 听牌 + 有下注主动权（弃牌率 + 补牌双重盈利）；
     * 没有主动权时它只是「听牌」，该用底池赔率决定是否继续。
     */
    if (!facingBet && input.hasInitiative) return RelativeHandRole.SEMI_BLUFF;
    return RelativeHandRole.DRAW;
  }

  // ---- 4) 一对 / 两对级：按权益与形状细分 ----
  /*
   * 🔴 **P0-1**：一对/两对**不得**因为「价值下注不成立」或「抓诈唬不够」
   * 就被归为 AIR。统一走 `madeHandRoleFacingBet`（规则见该函数文档），
   * 由「权益是否够跟」+「对可达范围是否有摊牌价值」共同决定。
   */
  const showdownValue = hasShowdownValueOf(input.opponentRangeFacts ?? null);

  if (isTwoPairShape(shape)) {
    if (equity !== null && equity >= EQUITY_BANDS.MEDIUM + bandShift) return RelativeHandRole.MEDIUM_VALUE;
    if (equity !== null && equity >= EQUITY_BANDS.THIN) return RelativeHandRole.THIN_VALUE;
    return facingBet
      ? madeHandRoleFacingBet({ heroEquity: equity, requiredEquity, hasShowdownValue: showdownValue })
      : RelativeHandRole.SHOWDOWN_VALUE;
  }

  if (isOnePairShape(shape)) {
    /*
     * 「一对 + 卡顺」在**还有牌要发**的街上仍按原来的方式处理
     *（权益不够但补牌尚可 ⇒ 抓诈牌 / 摊牌价值）—— 这段**不适用于河牌**：
     * 河牌没有补牌，卡顺不构成继续的理由（V2 已锁的定义域约束）。
     */
    if (cardsToCome && draws.gutshot && draws.outs >= 4 && equity !== null && equity < EQUITY_BANDS.MEDIUM) {
      return facingBet ? RelativeHandRole.BLUFF_CATCHER : RelativeHandRole.SHOWDOWN_VALUE;
    }
    if (equity !== null && equity >= EQUITY_BANDS.MEDIUM + bandShift) {
      /*
       * 顶对/超对在**高 SPR** 下仍然是中等价值（不该把底池做大到失控），
       * 在**低 SPR** 下则接近强价值（筹码已经不多，取值就是承诺）。
       * 这条区分由 `commitment.ts` 在 EV 层处理，这里只给「中等价值」。
       */
      return RelativeHandRole.MEDIUM_VALUE;
    }
    if (facingBet) {
      /*
       * 面对下注：够跟就是抓诈牌；不够跟但有摊牌价值就是摊牌价值手
       *（**不是**空气）；只有确认对可达范围毫无摊牌价值时才是空气。
       *
       * 修复前这里写的是 `equity >= requiredEquity * 0.9 ? BLUFF_CATCHER : AIR` ——
       * 那个 0.9 系数回答的是「抓诈唬够不够」，却拿去回答了「是不是空气」，
       * 于是中对（权益 24.0% / 门槛 28.0% / 更差占比 22.06%）被判成 AIR。
       */
      return madeHandRoleFacingBet({ heroEquity: equity, requiredEquity, hasShowdownValue: showdownValue });
    }
    /*
     * 🔴 无人下注时，**任何一对都至少有摊牌价值** —— 不能判成 AIR。
     *
     * 这是本模块第一版的一个真实缺陷（测试当场抓到）：顶对但权益只有 42%
     * 时被判成 `AIR`，而 AIR 的含义是「什么都赢不了」。一手顶对过牌到摊牌
     * 能赢下不少底池，把它归为空气会让上层错误地放弃它。
     */
    if (equity !== null && equity >= EQUITY_BANDS.THIN) return RelativeHandRole.THIN_VALUE;
    return RelativeHandRole.SHOWDOWN_VALUE;
  }

  // ---- 5) 无成手：听牌已在上面处理 ⇒ 有主动权是纯诈唬，否则空气 ----
  if (!facingBet && input.hasInitiative) {
    /*
     * 纯诈唬只在**有主动权**且没有摊牌价值时才成立。
     * ⚠️ 不许因为「我有主动权」就诈唬 —— 是否下注由 EV 比较决定（`valueBetGate`）。
     */
    return RelativeHandRole.PURE_BLUFF;
  }
  if (spr !== null && spr <= 1 && equity !== null && equity >= requiredEquity) {
    return RelativeHandRole.BLUFF_CATCHER;
  }
  return RelativeHandRole.AIR;
}

/**
 * 🔴 **河牌角色不变量**（【数学确定】· RIVER CONSISTENCY V2）。
 *
 * 河牌之后**没有任何公共牌**，因此「听牌 / 半诈唬」在语义上不可能存在：
 * 听牌 = 「现在没成，但还有牌能让我成」；河牌上第二句永远为假。
 *
 * ```text
 * street === 'RIVER'  ⇒  role ∉ { DRAW, SEMI_BLUFF }
 * ```
 *
 * ⚠️ 这不是「把听牌降级」的启发式，而是**定义域约束**：
 * 就像「河牌不能有下一条街」一样，它是分类体系的一部分。
 * 上一街曾经是听牌这件事仍然有意义（`previousStreetRole`），
 * 但它描述的是**历史**，不是当前决策点的牌力。
 */
export const RIVER_FORBIDDEN_ROLES: readonly RelativeHandRole[] = Object.freeze([
  RelativeHandRole.DRAW,
  RelativeHandRole.SEMI_BLUFF,
]);

/**
 * 河牌角色的**兜底规范化**。
 *
 * `classifyRelativeRole` 已经不会在河牌产出听牌（第 3 节整段不适用），
 * 但分类器以外还有别的入口（手写输入、未来的新分支、测试构造）。
 * 因此在**产出侧**再做一次显式检查：一旦有人在河牌给出听牌角色，
 * 就按「没有成手 ⇒ 空气 / 面对下注且权益够 ⇒ 抓诈牌」重新定位，
 * 而不是把非法角色放进决策链。
 *
 * @returns 规范化后的角色；非河牌输入原样返回
 */
export function normalizeRiverRole(input: {
  street: string;
  role: RelativeHandRole;
  facingBet: boolean;
  heroEquity: number | null;
  requiredEquity: number;
  spr: number | null;
  /**
   * 对对手可达范围是否有摊牌价值（来自 `hasShowdownValueOf`）。
   * 省略/`null` = **不知道** ⇒ 不得当成「没有」。
   */
  hasShowdownValue?: boolean | null;
}): RelativeHandRole {
  if (input.street !== 'RIVER') return input.role;
  if (!RIVER_FORBIDDEN_ROLES.includes(input.role)) return input.role;
  /*
   * 河牌上「听牌」= 什么都没成。此时唯一的区别是**能不能抓诈唬**：
   * 权益够得上底池赔率就是抓诈牌，否则看有没有摊牌价值（P0-1 的同一规则）。
   * 没有第三分支。
   */
  const equity = input.heroEquity;
  const hasShowdownValue = input.hasShowdownValue ?? null;
  if (!input.facingBet) {
    // 无人下注：没有成手且没有未来补牌 ⇒ 只能过牌到摊牌
    return equity !== null && equity >= input.requiredEquity
      ? RelativeHandRole.SHOWDOWN_VALUE
      : hasShowdownValue === false
        ? RelativeHandRole.AIR
        : RelativeHandRole.SHOWDOWN_VALUE;
  }
  if (equity !== null && equity >= input.requiredEquity) return RelativeHandRole.BLUFF_CATCHER;
  /*
   * ⚠️ 「不知道」不能当成「没有」：没有范围事实时按**有**摊牌价值处理。
   */
  return hasShowdownValue === false ? RelativeHandRole.AIR : RelativeHandRole.SHOWDOWN_VALUE;
}

/**
 * 跨街角色迁移的**原因说明**（中文，供界面显示）。
 *
 * 使用者明确要求：河牌是空白牌时，**不允许**因为「牌面没变」就自动把
 * 中等价值恢复成强价值 —— 除非对手行动与范围信息支持。
 */
export function roleChangeReasonZh(input: {
  previous: RelativeHandRole | null;
  current: RelativeHandRole;
  delta: {
    blankScore: number;
    overcardImpact: number;
    flushCompleted: boolean;
    straightCompleted: boolean;
    heroRelativeStrengthChange: number;
    villainRangeImprovement: number | null;
  } | null;
  equityBefore: number | null;
  equityAfter: number | null;
}): string {
  const { previous, current, delta } = input;
  /*
   * ⚠️ 角色名必须用**中文**输出。第一版直接拼了枚举原文
   *（`MEDIUM_VALUE` / `SHOWDOWN_VALUE`），与项目「所有对外文案都是中文」的
   * 纪律不符 —— 测试当场抓到。
   */
  const zh = (role: RelativeHandRole): string => RELATIVE_ROLE_ZH[role];
  if (previous === null) return '本街首次判定角色（没有上一街可比较）';
  if (previous === current) {
    return delta !== null && delta.blankScore > 0.7
      ? `牌面接近空白（blankScore ${delta.blankScore.toFixed(2)}），角色保持「${zh(current)}」`
      : `角色保持「${zh(current)}」（牌面与范围都没有改变方向性结论）`;
  }
  const reasons: string[] = [];
  if (delta !== null) {
    if (delta.flushCompleted) reasons.push('这张牌让**同花成为可能**（花色结构变化）');
    if (delta.straightCompleted) reasons.push('这张牌让**顺子成为可能**（连接度变化）');
    if (delta.overcardImpact > 0.3) reasons.push(`新高牌显著高于原牌面（overcardImpact ${delta.overcardImpact.toFixed(2)}）`);
    if (delta.villainRangeImprovement !== null && delta.villainRangeImprovement > 0.5) {
      reasons.push(`对手范围与新牌面适配度上升（${delta.villainRangeImprovement.toFixed(2)}）`);
    }
    if (delta.heroRelativeStrengthChange < 0) reasons.push('我方相对档位下降');
  }
  if (input.equityBefore !== null && input.equityAfter !== null && input.equityAfter < input.equityBefore) {
    reasons.push(
      `我方权益由 ${(input.equityBefore * 100).toFixed(1)}% 降到 ${(input.equityAfter * 100).toFixed(1)}%`,
    );
  }
  if (reasons.length === 0) reasons.push('对手行动/范围信息改变了对这手牌的定位');
  return `角色由「${zh(previous)}」变为「${zh(current)}」：${reasons.join('；')}`;
}

