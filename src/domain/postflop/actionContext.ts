/**
 * ============================================================================
 * ACTION CONTEXT —— 「他此刻面对的是哪一种下注」
 * ============================================================================
 *
 * ## 为什么需要它（TEST 08 P0-3 的根因）
 *
 * PLAYER PROFILE V3 引入了 `FoldTo{Flop,Turn,River}CBet` 三条**分街统计**，
 * 它们经 `STAT_TO_STREET_TRAIT` 落成 `streetTraitValue.foldTo{Flop,Turn,River}Bet`，
 * 再经 `factorsOf(street)` 变成 `foldScale`，最后作用于**该街所有面对下注的节点**。
 *
 * 问题：`FoldToTurnCBet` 在 HUD 里的含义是**「他是翻前/翻牌进攻者、转牌继续开火时，
 * 对手弃牌的比例」**。它描述的是**他开枪**时的弃牌率。
 *
 * 而 TEST 08 的节点是：
 *
 * ```text
 * BTN 翻前加注 → BTN 翻牌 cbet → BB 跟注
 * 转牌：BB 先行动，BB 下注   ← 这是 Turn Donk / Turn Lead
 * ```
 *
 * 这里 BTN 是**面对 donk 的人**，不是开枪的人。用 `FoldToTurnCBet` 回答
 * 「他面对 donk 会怎么反应」是**拿错了统计** —— 两者是完全不同的决策场景
 * （面对 cbet 时他的范围里有大量中等牌力要防守；面对 donk 时他是范围优势方）。
 *
 * ## 口径
 *
 * 每条分街统计只在**它自己的那个节点语义**下才允许进入直接统计通道：
 *
 * | 统计 | 允许的直接通道 | 语义 |
 * |---|---|---|
 * | `foldToFlopCBet` | `FACING_CBET`（翻牌，bettor = 翻前进攻者） | 面对 cbet |
 * | `foldToTurnCBet` | `FACING_CBET`（转牌，bettor = 翻牌进攻者） | 面对二次开火 |
 * | `flopCheckRaise` | （过牌-加注通道，见 `streetCheckRaiseScale`） | — |
 *
 * **节点语义不匹配时不做「找一条相近统计代替」**：那会把一种场景的证据
 * 挪用到另一种场景，正是本项目反复禁止的「证据错配」。回落到
 * 「范围构成 + 标签维度 + 通用弃牌倾向」—— 即 `foldScale = 1`
 * （分街通道**中立**，但 `tightness`/`passivity` 维度的通用倾向仍在生效）。
 *
 * ## 本轮范围
 *
 * 只覆盖 `FoldTo*CBet` 的三条。`*CheckRaise` 与未来可能出现的
 * `FoldToDonk` / `FoldToProbe` / `FoldToDelayedCBet` **留作后续**，
 * 因为当前 `PlayerObservedStats` 里没有这些字段（不伪造）。
 */

/** 他此刻面对的下注属于哪一类 */
export const ActionContext = Object.freeze({
  /** 下注者 = 上一街的进攻者 ⇒ 持续下注（cbet / 二次开火 / 三次开火） */
  FACING_CBET: 'FACING_CBET',
  /** 下注者 ≠ 上一街进攻者，且存在上一街进攻者 ⇒ 主动领打（donk / lead） */
  FACING_DONK: 'FACING_DONK',
  /**
   * 上一街**无人进攻**（check-check 或无人下注）⇒ 本街第一枪。
   *
   * 它是 Delayed CBet 与 Probe 的**共同**形态，而本系统无法从行动序列区分
   * 两者（取决于下注者当时是否**本可以**下注，那是意图而非记录）。
   * 因此**不猜**，直接标为通用。
   */
  GENERIC_BET: 'GENERIC_BET',
} as const);

export type ActionContextValue = (typeof ActionContext)[keyof typeof ActionContext];

export const ACTION_CONTEXT_ZH: Readonly<Record<ActionContextValue, string>> = Object.freeze({
  FACING_CBET: '面对持续下注（cbet / 二次开火）',
  FACING_DONK: '面对主动领打（donk / lead）',
  GENERIC_BET: '面对通用下注（上一街无人进攻 ⇒ 延迟 cbet 或探牌，不区分）',
});

/** 本街的一次下注记录（只取需要的字段） */
export type StreetBetRecord = {
  readonly street: string;
  readonly position: string;
  readonly type: string;
};

/**
 * 从行动序列中找**指定街**最后一个进攻动作（BET / RAISE）的下注者位置。
 *
 * 找不到（该街无人下注，或该街还没发生）⇒ `null`。
 *
 * ⚠️ 用 `BET` / `RAISE` 而不是 `state.lastAggressorId`：后者在**进入新街时被重置**
 * （`beginStreet` 把它清成 `null`），因此在本街的决策点上读不到上一街的进攻者。
 * 行动序列是完整记录，才是可靠来源。
 */
export function lastAggressorOfStreet(
  actions: readonly StreetBetRecord[],
  street: string,
): string | null {
  let found: string | null = null;
  for (const a of actions) {
    if (a.street !== street) continue;
    if (a.type === 'BET' || a.type === 'RAISE') found = a.position;
  }
  return found;
}

/** 比 `street` 早的那一街 */
export function previousStreetOf(street: string): string | null {
  switch (street) {
    case 'FLOP':
      return 'PREFLOP';
    case 'TURN':
      return 'FLOP';
    case 'RIVER':
      return 'TURN';
    default:
      return null;
  }
}

/**
 * 判定「正在下注的那个人」此刻处在哪种节点语义。
 *
 * @param input.street         当前街
 * @param input.bettorPosition 正在下注的人（他是在**面对**什么之前先下了注 ——
 *                             因此我们问的是「他这一注属于哪一类」，
 *                             由此决定**跟注方**面对的是哪一类）
 * @param input.actions        完整行动序列（含盲注，会被类型过滤掉）
 * @param input.streetAggressorOf 允许调用方注入已算好的上一街进攻者（便于测试）；
 *                                 不给则从 `actions` 现算
 */
export function actionContextOf(input: {
  street: string;
  bettorPosition: string;
  actions: readonly StreetBetRecord[];
  streetAggressorOf?: (street: string) => string | null;
}): ActionContextValue {
  const prev = previousStreetOf(input.street);
  if (prev === null) return ActionContext.GENERIC_BET;
  const priorAggressor =
    input.streetAggressorOf !== undefined
      ? input.streetAggressorOf(prev)
      : lastAggressorOfStreet(input.actions, prev);
  /*
   * 上一街无人进攻 ⇒ 无法区分「他本可以下注却没下」（延迟 cbet）
   * 与「他本来就没机会」（探牌）⇒ 通用，不冒充 cbet。
   */
  if (priorAggressor === null) return ActionContext.GENERIC_BET;
  return priorAggressor === input.bettorPosition
    ? ActionContext.FACING_CBET
    : ActionContext.FACING_DONK;
}

/**
 * 某条**分街统计**是否被允许进入直接统计通道。
 *
 * ## 判据必须**逐条目按各自街**匹配（TEST 09 发现并修正）
 *
 * 第一版只看「当前街的节点语义」就决定**所有** `foldTo*` 条目 —— 那是错的：
 * `foldToFlopBet` 描述的是**翻牌**上他开枪后的弃牌率，与「现在是不是转牌」无关。
 * 后果实测（TEST 09 河牌节点）：河牌上算出 `FACING_CBET`（他连续第三枪，
 * 语义正确），但同一次判定把 `foldToFlopBet` / `foldToTurnBet` 也一起「放行」了 ——
 * 而它们各自的街（翻牌 / 转牌）根本不在当前节点上，本就应当保持中立。
 *
 * 正确判据：
 *
 * ```text
 * 该统计所属的街 ≠ 当前街  ⇒  不适用（它描述的是另一条街）
 * 该统计所属的街 = 当前街  ⇒  必须是 FACING_CBET 才放行
 * ```
 *
 * `context === null`（调用方未提供节点语义）⇒ 放行，保持旧调用路径逐位不变。
 *
 * @param streetTrait `STAT_TO_STREET_TRAIT` 落成的 trait 名
 * @param context     当前节点语义
 * @param currentStreet 当前街（`null` ⇒ 不做街匹配，等同旧行为）
 */
export function isTraitAllowedInContext(
  streetTrait: string,
  context: ActionContextValue | null,
  currentStreet?: string | null,
): boolean {
  const traitStreet =
    streetTrait === 'foldToFlopBet' ? 'FLOP'
      : streetTrait === 'foldToTurnBet' ? 'TURN'
        : streetTrait === 'foldToRiverBet' ? 'RIVER'
          : null;
  // 过牌-加注类不走这条通道（它们经 `streetCheckRaiseScale`）
  if (traitStreet === null) return true;
  /*
   * 街不匹配 ⇒ 该条目描述的是另一条街的行为，在当前节点上**不适用**。
   * 例：河牌节点上 `foldToFlopBet` 必须保持中立，不能被河牌的语义放行。
   */
  if (currentStreet !== undefined && currentStreet !== null && currentStreet !== traitStreet) {
    return false;
  }
  return context === null || context === ActionContext.FACING_CBET;
}
