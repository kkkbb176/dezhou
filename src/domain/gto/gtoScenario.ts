/**
 * GTO 场景：构造、归一化、哈希
 *
 * ## 这个模块解决什么
 *
 * 把「我想问求解器的问题」变成一个**规范化、可哈希、可缓存**的对象，
 * 并且保证：**桌人数是一级参数**。
 *
 * ## 🔴 四条纪律
 *
 * 1. **桌人数参与哈希**。`4MAX / 100BB / CO / RFI` 与
 *    `6MAX / 100BB / CO / RFI` 必须是两个完全不同的场景 ——
 *    即使两边的位置名都叫 `CO`。这是「严禁不同桌人数复用 Range」的实现方式。
 *
 * 2. **真人信息不参与**。`GtoScenario` 在类型上就没有这些字段，
 *    所以哈希里也不可能出现它们。`gtoContextIsolation.test.ts` 会证明
 *    「把 Alpha 输入里的 Tilt / 画像 / 动态提示全部改掉，场景哈希逐位不变」。
 *
 * 3. **归一化是纯函数**。同样的语义必须得到同样的哈希，
 *    与调用方构造对象的字段顺序、浮点写法（2.5 vs 2.50）无关。
 *
 * 4. **不猜测**。给一个 7 人桌，`buildGtoScenario` 返回 `null`，
 *    而不是「就近取整到 6 或 8」。
 */

import {
  GTO_STANDARD_BLINDS,
  gtoSeatCountOf,
  GtoActionKind,
  GtoScenarioKind,
  isGtoTableSize,
  type GtoBlindStructure,
  type GtoPosition,
  type GtoScenario,
  type GtoScenarioAction,
  type GtoTableSize,
  type GtoSolveKeyParts,
  gtoPositionsFor,
} from './gto.types.ts';

/**
 * 重新导出 `GtoSolveKeyParts`。
 *
 * 🔴 这不是多余的：`gtoStrategyStore` / `gtoCacheQuality.test` 都从
 * **本模块**导入它（因为「求解设置」这个概念是与三把键一起被消费的）。
 * 不再导出会让那些调用点全部报错 —— 而那些调用点正是在「键的口径」
 * 这件事上有话语权的地方。
 */
export type { GtoSolveKeyParts };

/* ============================================================
 * 常量
 * ============================================================ */

/** 标准开池尺寸（BB）——本项目的**请求参数**，不是求解结果 */
export const DEFAULT_OPEN_SIZE_BB = 2.5;

/** 标准再加注倍数（相对当前注额）——同样是请求参数 */
export const DEFAULT_RAISE_MULT = 3.0;

/** 场景哈希的版本号。改变哈希口径时必须递增，否则旧缓存会被误用。 */
export const GTO_SCENARIO_HASH_VERSION = 'gto-scenario-v1';

/**
 * 缓存键的版本号。
 *
 * 🔴 **Phase 1.1：从无到有**。Phase 1 直接用场景哈希当缓存键，
 * 于是「求解器换版本」「把全下打开」「改迭代数」都会命中同一份旧缓存。
 * 现在缓存键 = `场景哈希 + 求解设置指纹`，版本号独立，便于将来再改口径时
 * 一次性作废旧缓存。
 */
export const GTO_CACHE_KEY_VERSION = 'gto-cache-v1';

/* ============================================================
 * 数值归一化
 * ============================================================ */

/**
 * 归一化一个 BB 金额：四舍五入到 6 位小数。
 *
 * 为什么需要它：`2.5` 与 `2.5000000000000004`（浮点累加的结果）
 * 必须得到**同一个**哈希，否则缓存永远命中不了，而且日志里会出现
 * 「看起来一样但是两条记录」的场景。
 */
export function roundBB(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/* ============================================================
 * 位置
 * ============================================================ */

/**
 * 位置在某桌人数下是否合法。
 *
 * ⚠️ 这是**唯一**允许用来回答「这个位置在这张桌子上存在吗」的函数。
 * 任何地方直接用 `includes` 都可能在桌人数上出错。
 *
 * 🔴 桌人数本身不在支持列表里时返回 `false`（**不抛异常**）：
 * 一个不支持的桌人数应当变成「这个场景不支持」这个**可展示状态**，
 * 而不是一个 500。抛异常会让「7 人桌」这种输入直接把整条链打断。
 */
export function positionValidAt(tableSize: GtoTableSize, position: GtoPosition): boolean {
  if (!isGtoTableSize(tableSize)) return false;
  return gtoPositionsFor(tableSize).includes(position);
}

/**
 * 4 人桌的「第一个行动位」。
 *
 * 🔴 4 人桌没有 UTG。它的第一个行动位就是 **CO**（这也是 Alpha
 * `CANONICAL_ROLES[4]` 的定义：`CO BTN SB BB`）。
 * 不要为了「看起来完整」而给 4 人桌补一个 UTG —— 那会凭空多出一个
 * 在求解器里根本不存在的座位角色。
 */
export function firstToActPositionOf(tableSize: GtoTableSize): GtoPosition {
  return gtoPositionsFor(tableSize)[0]!;
}

/** 某桌人数下盲注位（最后两个座位） */
export function blindsAt(tableSize: GtoTableSize): { sb: GtoPosition; bb: GtoPosition } {
  const order = gtoPositionsFor(tableSize);
  return { sb: order[order.length - 2]!, bb: order[order.length - 1]! };
}

/** 某位置在某桌人数下的行动序号（0 起） */
export function actingIndexOf(tableSize: GtoTableSize, position: GtoPosition): number {
  return gtoPositionsFor(tableSize).indexOf(position);
}

/* ============================================================
 * 3Bet 几何（Phase 1.1 第二轮：六次修正之后的最终形状）
 * ============================================================ */

/**
 * `VS_3BET` 场景里**合法的 3Bettor 候选** = Hero 之后、**非盲注**的座位。
 *
 * ## 🔴 这个函数的语义（第六次才定对，前五次都被实测推翻）
 *
 * 它返回的不是「谁开池」，而是：
 *
 * > **Hero 开池之后，谁 3Bet 了他、使行动重新回到 Hero 手上。**
 *
 * ## 为什么 3Bettor 必须在 Hero **之后**
 *
 * 求解器源码 `crates/solver/src/preflop/mod.rs`：
 *
 * | 位置 | 逐字 | 含义 |
 * |---|---|---|
 * | `next_state_of` | `ns.needs = ((1u32 << n) - 1) & !ns.folded & !ns.allin & !(1 << actor);` | **一次加注为除加注者之外的每个活着的人重新打开行动** |
 * | `next_actor_of` | 从 `st.next_seat` 起 `% n` 环绕，取第一个 `needs` 且未弃牌未全尽的人 | 行动从加注者的**下一位**开始环绕 |
 *
 * 于是「Hero 开池 → 后面的人 3Bet → 一圈人弃牌 → 行动回到 Hero」是树里
 * **真实存在**的节点（实测：`UTG 加注 2.5 → HJ 3Bet 7.5 → CO/BTN/SB/BB 弃 → UTG`）。
 *
 * ## ⚠️ 反过来「Hero 自己做 3Bet」**不是**一个可达的决策节点
 *
 * 上面的 `needs` 公式把**加注者自己**排除在外 —— 3Bettor 是最后一个加注者，
 * 一圈人弃牌之后行动回到的是**开池者**，而不是 3Bettor。
 * 实测：`UTG 加注 → HJ 3Bet → CO/BTN/SB/BB 弃` 之后行动者是 **UTG**。
 *
 * @returns Hero 之后、非盲注的座位（按行动顺序）；空数组表示无法构造
 */
export function legalThreeBettorsFor(
  tableSize: GtoTableSize,
  heroPosition: GtoPosition,
): readonly GtoPosition[] {
  const order = gtoPositionsFor(tableSize);
  const heroIndex = order.indexOf(heroPosition);
  if (heroIndex < 0) return Object.freeze([]);
  return Object.freeze(order.slice(heroIndex + 1).filter((p) => p !== 'SB' && p !== 'BB'));
}

/**
 * Hero **之前**的**非盲注**座位。
 *
 * 在 `VS_3BET` 场景里它们的含义是：
 *
 * > **「还会欠着动作的人」** —— 他们在 Hero 之前行动、而且还没动过，
 * > 因此 Hero 开池、别人 3Bet、一圈弃牌之后，**他们**才是收口人，
 * > 不是 Hero。见 `canHeroFaceThreeBet`。
 *
 * 在其它场景（`VS_OPEN` 系列）里它们的含义是普通的「可以开池的位置」。
 *
 * ⚠️ 盲注位要排除：`SB`/`BB` 在 Hero 之前行动时只是「补盲」，
 * 不构成开池，也**不算欠着动作**（他们的盲注已经投了）。
 */
export function legalThreeBetOpenersFor(
  tableSize: GtoTableSize,
  heroPosition: GtoPosition,
): readonly GtoPosition[] {
  const order = gtoPositionsFor(tableSize);
  const heroIndex = order.indexOf(heroPosition);
  if (heroIndex <= 0) return Object.freeze([]);
  return Object.freeze(order.slice(0, heroIndex).filter((p) => p !== 'SB' && p !== 'BB'));
}

/**
 * `VS_3BET` 场景里 Hero 必须满足的**硬条件**：他是**第一个行动位**。
 *
 * ## 🔴 这是第六版最后一条、也是最难接受的一条结论
 *
 * 「Hero 开池 → 有人 3Bet → 一圈弃牌 → 行动回到 Hero」看起来对**任何**
 * 开池位置都成立。实测把它推翻了（6 人桌，`scripts/gto-node-walk.raw.mjs`）：
 *
 * ```text
 * HJ 开池 2.5 → CO 3Bet 7.5 → BTN 弃 → SB 弃 → BB 弃 → UTG 弃 → 牌局结束
 *                                                       ^^^^^^^^^^^^
 *                                          Hero(HJ) **再也没有轮到**，收口人是 UTG
 * ```
 *
 * 为什么？因为求解器从不跳过任何一个还没行动过的座位
 *（`next_actor_of` 的 `needs` 过滤）。HJ 开池时 **UTG 还没行动过**，
 * 所以他必须回答那个 3Bet —— 而他才是这一圈的收口人。
 *
 * 反过来，只有**第一个行动位**开池时，一圈弃牌之后收口人正好就是他自己。
 *
 * ## 因此「谁可以」= 「谁前面没有还没行动过的座位」
 *
 * 判据就是 `legalThreeBetOpenersFor()` 是否为空。
 */
export function canHeroFaceThreeBet(
  tableSize: GtoTableSize,
  heroPosition: GtoPosition,
): boolean {
  return legalThreeBetOpenersFor(tableSize, heroPosition).length === 0;
}

/**
 * `VS_3BET` 场景的**开池者** = Hero **自己**。
 *
 * 保留成一个具名函数而不是让调用方直接写 `heroPosition`，理由是
 * 「谁是开池者」在这个场景里被搞错过五次 —— 让它有一个可搜索的名字。
 */
export function threeBetOpenerFor(heroPosition: GtoPosition): GtoPosition {
  return heroPosition;
}

/**
 * 从 `from` **之后**开始、环绕一圈的座位顺序（不含 `from`、不含 `exclude`）。
 *
 * ## 🔴 这是加注之后**真实的**行动顺序
 *
 * 求解器源码 `crates/solver/src/preflop/mod.rs` 的 `next_actor_of()`：
 *
 * ```rust
 * for k in 0..n {
 *     let s = (st.next_seat + k) % n;      // 环绕
 *     if st.folded & bit == 0 && st.allin & bit == 0 && st.needs & bit != 0 { return Some(s); }
 * }
 * ```
 *
 * 其中 `next_seat = (actor + 1) % n`，而 `needs` 在加注时被重置成
 * 「除加注者之外的每个活人」。也就是说：
 *
 * > 加注之后，行动从**加注者的下一位**开始环绕，
 * > 且**跳过加注者自己**（他不需要再回答自己的加注）。
 *
 * 实测例（6 人桌）：
 *
 * ```text
 * UTG 加注 → HJ 3Bet → CO 弃 → BTN 弃 → SB 弃 → BB 弃 → 回到 UTG ✅
 * ```
 *
 * 早期版本把它写成「Hero 之后的那一段数组」，于是漏掉下标更小、
 * 却**还没行动过**的座位 —— 后果不是「少两步」，而是**行动落到别人身上**。
 *
 * @param exclude 已经弃牌 / 已经行动过 / 行动要回到的那个座位
 */
export function circularAfter(
  tableSize: GtoTableSize,
  from: GtoPosition,
  exclude: readonly GtoPosition[] = [],
): readonly GtoPosition[] {
  const order = gtoPositionsFor(tableSize);
  const start = order.indexOf(from);
  if (start < 0) return Object.freeze([]);
  const skip = new Set(exclude);
  const out: GtoPosition[] = [];
  for (let k = 1; k < order.length; k++) {
    const position = order[(start + k) % order.length]!;
    if (skip.has(position)) continue;
    out.push(position);
  }
  return Object.freeze(out);
}

/* ============================================================
 * 场景构造
 * ============================================================ */

export type GtoScenarioSpec = {
  kind: GtoScenarioKind;
  tableSize: GtoTableSize;
  effectiveStackBB: number;
  heroPosition: GtoPosition;
  /** 主要对手的位置；不填由场景类型推导 */
  villainPosition?: GtoPosition | null;
  /** 前序动作；不填由场景类型自动构造（例如 VS_OPEN = 对手开池 2.5BB） */
  actionHistory?: readonly GtoScenarioAction[];
  /** 开池尺寸（BB）；默认 2.5 */
  openSizeBB?: number;
  /** 再加注倍数；默认 3.0 */
  raiseMult?: number;
  blinds?: GtoBlindStructure;
  /**
   * 🔴 **Phase 1.1**：Hero 在本节点之前**已经行动过**（且没有弃牌）。
   *
   * 用于表达「Hero 开池后被 3Bet，再轮到 Hero」这类节点。
   * 省略时**由场景类型推导**（`VS_3BET` ⇒ `true`），其余情况为 `false`
   *（与 Phase 1 行为**逐位一致**）。
   */
  heroAlreadyActed?: boolean;
};

function raiseTo(position: GtoPosition, sizeBB: number): GtoScenarioAction {
  return { position, kind: GtoActionKind.RAISE, sizeBB };
}

function foldAt(position: GtoPosition): GtoScenarioAction {
  return { position, kind: GtoActionKind.FOLD, sizeBB: null };
}

/**
 * 按场景类型自动构造前序动作。
 *
 * ## 支持与不支持（**明确列出，不假装**）
 *
 * | 场景 | 自动构造的前序动作 | 状态 |
 * |---|---|---|
 * | `RFI` | 无（Hero 是第一个行动的人） | 支持 |
 * | `VS_OPEN` | 最后一个在 Hero 之前的位置开池到 `openSizeBB` | 支持 |
 * | `VS_3BET` | Hero 开池 + 中间全弃 + 有人 3Bet + 环绕全弃 | 支持 |
 * | `VS_4BET` | 开池 + 3Bet + 4Bet | **暂不自动构造**（见下） |
 * | `LIMPED` | 前置位置跛入 | **暂不自动构造** |
 *
 * `VS_4BET` / `LIMPED` 刻意不自动构造：它们的动作序列有多种合理写法
 *（4Bet 的尺寸、跛入的人数），**自动挑一种就等于替使用者做了一个
 * 他没有做的假设**。调用方必须显式给出 `actionHistory`。
 */
export function defaultActionHistoryFor(spec: GtoScenarioSpec): GtoScenarioAction[] | null {
  const { kind, tableSize, heroPosition } = spec;
  const order = gtoPositionsFor(tableSize);
  const heroIndex = order.indexOf(heroPosition);
  if (heroIndex < 0) return null;

  /*
   * 🔴 「无人入池」的定义（这里刻意写得**严格**）
   *
   * 源码核对：GTOpen 的树从 `positions[0]` 开始，**每次加注都会重开一轮行动**。
   * 也就是说，UTG 开池、其余全弃之后回到 UTG 时，UTG 面对的是**自己的加注**
   *（`to_call > 0`），**不是**一个「无人入池」的节点。
   *
   * 结论：`RFI` 场景只允许 `heroIndex === 0`。给 HJ / CO / BTN 构造
   * 「RFI」会把一个不存在的节点伪装成存在 —— 所以这里返回 `null`。
   */
  if (kind === GtoScenarioKind.RFI) {
    return heroIndex === 0 ? [] : null;
  }

  const openSize = roundBB(spec.openSizeBB ?? DEFAULT_OPEN_SIZE_BB);
  const mult = spec.raiseMult ?? DEFAULT_RAISE_MULT;
  const firstIsBlind = order[0] === 'SB' || order[0] === 'BB';
  if (firstIsBlind) return null;

  if (kind === GtoScenarioKind.VS_OPEN) {
    // 需要 Hero 前面至少有一个非盲注位置可以开池
    const openerIndex =
      spec.villainPosition !== undefined && spec.villainPosition !== null
        ? order.indexOf(spec.villainPosition)
        : heroIndex - 1;
    if (openerIndex < 0 || openerIndex >= heroIndex) return null;
    if (order[openerIndex] === 'SB' || order[openerIndex] === 'BB') return null;
    return [{ position: order[openerIndex]!, kind: GtoActionKind.RAISE, sizeBB: openSize }];
  }

  if (kind === GtoScenarioKind.VS_3BET) {
    /*
     * 「**Hero 开池 → 后面的人 3Bet → 中间全弃 → 环绕一圈 → 行动回到 Hero**」。
     *
     * ## 🔴 Hero 是**开池者**，3Bettor 在他**之后**
     *
     * 前五版都把 Hero 当成 3Bettor，全部被实测推翻。根因在求解器源码里：
     * `next_state_of` 的 `needs` 把加注者**自己**排除在外，因此 3Bettor
     * 不会被再次叫到 —— 一圈人弃牌之后，行动回到的是**开池者**。
     *
     * ## 真实几何（`scripts/gto-node-walk.raw.mjs` 直接问的求解器）
     *
     * ```text
     * UTG 加注 2.5 → HJ 3Bet 7.5 → CO 弃 → BTN 弃 → SB 弃 → BB 弃 → 回到 UTG ✅
     * ```
     *
     * ## 五版失败的记录（保留，因为「推断被实测推翻」本身就是结论）
     *
     * | 版本 | Hero 的角色 | 实测结果 |
     * |---|---|---|
     * | 1 | 3Bettor = `order[heroIndex+1]` | 6MAX/CO 取到 HJ（在 CO 之前不可能）→ 坐到 SB ❌ |
     * | 2 | 候选跳过盲注，历史写成「先 3Bet 再全弃」 | 5MAX/CO、6MAX/CO 错 ❌ |
     * | 3 | 顺序改成「之前先弃 → 加注 → 之后弃」，Hero 仍是开池者 | 坐到 SB ❌ |
     * | 4 | **Hero 改成 3Bettor**，开池者在他之前 | 探针全部**回到开池者** ⇒ 已说明 Hero 不是 3Bettor ❌ |
     * | 5 | 第 4 版 + 弃牌改成环绕顺序 | 仍然落在开池者身上 ⇒ 应该把 Hero 放到开池者位置 ✅ |
     * | **6** | **Hero = 开池者且必须是第一个行动位** | 见 `reports/evidence/gto-vs3bet-live-evidence.txt` |
     */
    if (!canHeroFaceThreeBet(tableSize, heroPosition)) return null;
    const threeBettors = legalThreeBettorsFor(tableSize, heroPosition);
    if (threeBettors.length === 0) return null;
    const threeBettor = spec.villainPosition ?? threeBettors[0]!;
    if (!threeBettors.includes(threeBettor)) return null; // 指定的 3Bettor 不合法
    const threeBettorIndex = order.indexOf(threeBettor);
    const between = order.slice(heroIndex + 1, threeBettorIndex); // Hero 与 3Bettor 之间的人
    /*
     * 🔴 3Bet 之后的弃牌必须是**环绕一圈**，而且**包含 Hero 在内的整圈**。
     *
     * `circularAfter` 返回的是一圈**包括收口人**的完整顺序，收口人正是 Hero。
     * 这里核对收口人是 Hero，然后把他从**弃牌列表**里去掉 ——
     * 他不是「弃牌的人」，他是那个要决策的人。
     */
    const afterThreeBettor = circularAfter(tableSize, threeBettor, between);
    if (afterThreeBettor.length === 0) return null;
    if (afterThreeBettor[afterThreeBettor.length - 1] !== heroPosition) return null;
    const foldsAfter = afterThreeBettor.slice(0, -1);
    return [
      raiseTo(heroPosition, openSize), // Hero 开池
      ...between.map(foldAt),
      raiseTo(threeBettor, roundBB(openSize * mult)), // 有人 3Bet
      ...foldsAfter.map(foldAt), // 环绕一圈弃牌 → 行动回到 Hero
    ];
  }

  return null;
}

/* ============================================================
 * 前序动作校验
 * ============================================================ */

type HistoryValidation = { ok: true } | { ok: false; reason: string };

function isAggressive(a: GtoScenarioAction): boolean {
  return (
    a.kind === GtoActionKind.RAISE || a.kind === GtoActionKind.BET || a.kind === GtoActionKind.ALL_IN
  );
}

/**
 * 校验前序动作是否与「Hero 是当前行动者」相容。
 *
 * ## 🔴 两种形态、两套规则（Phase 1.1 的核心扩展）
 *
 * ### 形态 A：`heroAlreadyActed === false` —— **Phase 1 的行为，逐字未变**
 *
 * | 规则 | 内容 |
 * |---|---|
 * | A1 | **任何** `index >= heroIndex` 的动作都非法（有人抢在 Hero 之后行动） |
 * | A2 | 最后一次加注**之前**的座位序号必须**严格递增**（不许插队 / 回绕） |
 * | A3 | 最后一次加注**之后**不得再有人加注 |
 * | A4 | 加注之后的弃牌者必须是加注者的**后继**且仍在 Hero 之前 |
 *
 * ### 形态 B：`heroAlreadyActed === true` —— **Phase 1.1 新增**
 *
 * 用于表达「Hero 开池后被 3Bet，再轮到 Hero」这类节点。
 * **这不是放宽校验，而是新增一条分支**：A1 仍然在形态 A 下逐字生效，
 * 所以真正的 Hero/Villain 反转依然被挡住。
 *
 * | 规则 | 内容 |
 * |---|---|
 * | B1 | Hero 必须在历史里出现过，**且至少加注过一次**，且没有弃牌 |
 * | B2 | 整条动作路径必须与「从第一个动作起环绕一圈」的**唯一**顺序逐项相同 |
 * | B3 | **Hero 不能是最后一个加注者**（最后一个加注者不会被再次叫到） |
 *
 * ## ⚠️ 为什么 B1 要求「Hero 必须加注过」
 *
 * 「Hero 已经行动过」在这个项目里**只有一个含义**：他开过池（或加注过）。
 * 一个只跟注过的 Hero 与「Hero 是当前行动者」在数据上无法区分，
 * 那种历史应当被判成形态 A。
 */
export function validatePriorActions(
  tableSize: GtoTableSize,
  heroPosition: GtoPosition,
  history: readonly GtoScenarioAction[],
  heroAlreadyActed: boolean,
): HistoryValidation {
  const heroIndex = actingIndexOf(tableSize, heroPosition);
  if (heroIndex < 0) {
    return { ok: false, reason: `${tableSize} 人桌上没有 ${heroPosition}` };
  }

  for (const action of history) {
    if (!positionValidAt(tableSize, action.position)) {
      return { ok: false, reason: `${action.position} 不在 ${tableSize} 人桌上` };
    }
    if (action.sizeBB !== null && (!Number.isFinite(action.sizeBB) || action.sizeBB <= 0)) {
      return { ok: false, reason: `${action.position} 的金额非法：${String(action.sizeBB)}` };
    }
  }

  /* ---------------- 形态 A ---------------- */
  if (!heroAlreadyActed) {
    for (const action of history) {
      if (actingIndexOf(tableSize, action.position) >= heroIndex) {
        return { ok: false, reason: '有人抢在 Hero 之后行动了 —— 那不是「Hero 决策」' }; // A1
      }
    }
    let lastRaiseAt = -1;
    for (let i = 0; i < history.length; i++) {
      if (isAggressive(history[i]!)) lastRaiseAt = i;
    }
    let previousIndex = -1;
    for (let i = 0; i <= lastRaiseAt; i++) {
      const index = actingIndexOf(tableSize, history[i]!.position);
      if (index <= previousIndex) return { ok: false, reason: '加注之前的座位顺序必须严格递增' }; // A2
      previousIndex = index;
    }
    if (lastRaiseAt >= 0) {
      const raiserIndex = actingIndexOf(tableSize, history[lastRaiseAt]!.position);
      for (let i = lastRaiseAt + 1; i < history.length; i++) {
        if (isAggressive(history[i]!)) {
          return { ok: false, reason: '最后一次加注之后不得再有加注' }; // A3
        }
        const index = actingIndexOf(tableSize, history[i]!.position);
        if (!(index > raiserIndex && index < heroIndex)) {
          return { ok: false, reason: '加注之后的弃牌者必须是加注者的后继且仍在 Hero 之前' }; // A4
        }
      }
    }
    return { ok: true };
  }

  /* ---------------- 形态 B：Hero 已经行动过 ---------------- */
  if (history.length === 0) {
    return { ok: false, reason: 'heroAlreadyActed = true 时历史不能为空（Hero 得先行动过）' };
  }

  // B1：Hero 必须真的行动过，且**至少加注过一次**（「已经行动过」的唯一含义）
  const heroActions = history.filter((a) => a.position === heroPosition);
  if (heroActions.length === 0) {
    return { ok: false, reason: `Hero（${heroPosition}）在历史里没有出现过` };
  }
  if (heroActions.some((a) => a.kind === GtoActionKind.FOLD)) {
    return { ok: false, reason: 'Hero 不能已经弃牌' };
  }
  if (!heroActions.some(isAggressive)) {
    return {
      ok: false,
      reason: 'Hero 必须至少加注过一次（否则他不是「已经行动过」而是「刚轮到」）',
    };
  }

  /*
   * B3：**Hero 不能是最后一个加注者**（放在几何之前 —— 这是更基本的不变量）。
   *
   * ## 🔴 这条规则在第六版被**反过来**了，而反过来本身就是一个结论
   *
   * 旧版写的是「Hero 加注之后不得再有加注 —— 否则他就不是那个 3Bettor」。
   * 那是把 Hero 当 3Bettor 的那个错误几何留下的规则。第六版确认
   * Hero 是**开池者**，于是它的**逆命题**才是对的：
   *
   * ```text
   * 有人 3Bet 了 Hero 的开池  ⇒  最后一个加注者**必然不是** Hero
   * ```
   *
   * 更根本的理由在求解器源码里（`next_state_of` 的 `needs` 公式）：
   * 最后一个加注者不会被再次叫到。
   *
   * 这条规则同时替我们挡住了那个**不存在**的节点：
   * 「Hero 自己做 3Bet」（`GtoScenarioKind.THREE_BET`）。
   *
   * ⚠️ 顺序很重要：这条判据只看**最后一步**，而 B2 要看整条几何。
   * 简单的那条放在前面，一条「以 Hero 加注结尾」的历史就不会先被几何规则
   * 拦下、给出一个**看不出根因**的理由。
   */
  const lastAction = history[history.length - 1]!;
  if (lastAction.position === heroPosition && isAggressive(lastAction)) {
    return {
      ok: false,
      reason:
        '历史以「Hero 加注」结尾 —— 但最后一个加注者不会被再次叫到，' +
        '行动回不到 Hero 手上。这个节点在树里不存在（它不是「Hero 面对 3Bet」）。',
    };
  }

  /*
   * B2：**整条动作路径必须与「环绕一圈」的唯一顺序逐项相同**。
   *
   * ## 为什么不能再用「下标递增 + 末步回绕」
   *
   * 那条规则（第 4 版）只对**开池那一条**路径成立。3Bet 之后不是：
   * 6MAX/Hero=UTG/3Bettor=HJ 的真实顺序是
   * `UTG 加注 → HJ 加注 → CO 弃 → … → BB 弃`，而当 Hero 不是第一个
   * 行动位时，收口人会是**前面那个还没行动过的座位**，顺序会绕回来。
   *
   * ## 现在的规则（**由行动几何算出来，而不是猜出来**）
   *
   * 历史的第一条是「之前全弃之后的第一个动作」（开池），
   * 此后每一步都必须是从它**下一位**开始环绕所得到的**唯一**顺序：
   *
   * ```text
   * history[1…] === 从 history[0] 的下一位起环绕一圈的座位顺序（取其前缀）
   * ```
   *
   * 历史可以是这条路径的**前缀**（走到 Hero 就够了），但**不能**比它长，
   * 也不能与它分叉：多出来的步骤意味着这一圈走完了还在继续。
   */
  {
    const order = gtoPositionsFor(tableSize);
    const firstPos = history[0]!.position;
    const firstIndex = order.indexOf(firstPos);
    const expected: GtoPosition[] = [];
    const seen = new Set<GtoPosition>([firstPos]);
    for (let k = 1; k < order.length; k++) {
      const seat = order[(firstIndex + k) % order.length]!;
      if (seen.has(seat)) continue;
      expected.push(seat);
      seen.add(seat);
    }
    for (let i = 1; i < history.length; i++) {
      const cur = history[i]!.position;
      if (i - 1 >= expected.length) {
        return {
          ok: false,
          reason:
            `第 ${i} 步（${cur}）超出了从 ${firstPos} 起的那一圈 —— ` +
            '这一圈已经走完还在继续，说明历史被拼错了',
        };
      }
      if (expected[i - 1] !== cur) {
        return {
          ok: false,
          reason:
            `第 ${i} 步应该是 ${expected[i - 1]}，实际是 ${cur} —— ` +
            '有人插队或被跳过（加注之后的行动必须按环绕顺序逐一进行）',
        };
      }
      // 已经弃牌的人不会再出现；出现第二次说明历史里有重复动作
      if (history.slice(0, i).some((a) => a.position === cur)) {
        return { ok: false, reason: `${cur} 在历史里出现了两次 —— 那不是一条真实路径` };
      }
    }
  }
  return { ok: true };
}

/**
 * 由「场景规格」构造一个完整的理论场景。
 *
 * 返回 `null` 表示**这个场景在本项目里无法被严谨地表达**，
 * 调用方必须据此返回 `UNSUPPORTED` —— **不得**用相近场景顶替。
 */
export function buildGtoScenario(spec: GtoScenarioSpec): GtoScenario | null {
  if (!positionValidAt(spec.tableSize, spec.heroPosition)) return null;
  if (!Number.isFinite(spec.effectiveStackBB) || spec.effectiveStackBB <= 0) return null;
  if (spec.villainPosition !== undefined && spec.villainPosition !== null) {
    if (!positionValidAt(spec.tableSize, spec.villainPosition)) return null;
    if (spec.villainPosition === spec.heroPosition) return null;
  }

  const history = spec.actionHistory ?? defaultActionHistoryFor(spec);
  if (history === null) return null;

  /*
   * ---- 前序动作的合法性 ----
   *
   * 🔴 **Phase 1.1：拆成「两种形态、两套规则」**
   *
   * 形态 A（`heroAlreadyActed === false`）：Phase 1 的全部规则**逐字未变**。
   * 形态 B（`heroAlreadyActed === true`）：新增的、**更严**的一套，用于表达
   * 「Hero 开池后被 3Bet，再轮到 Hero」这类节点。
   *
   * 实现见 `validatePriorActions` —— 它是**唯一**的校验实现，
   * 因此「允许什么」在一处可读、可测、可审计。
   *
   * 🔴 `VS_3BET` 的形态**由场景类型决定，不由调用方决定**：
   * 这个场景的定义就是「Hero **开池之后被 3Bet**，行动又回到他手上」，
   * 因此 Hero **必然已经行动过**。让调用方每次记得传 `heroAlreadyActed: true`
   * 是一个迟早会漏的约定（漏了就是 `null`，而 `null` 会被上层报成
   * 「参数组合不合法」—— 一个**看不见的**缺陷）。
   *
   * ⚠️ 这条推导是本轮**真实抓到**的一次缺陷：曾经有 85 个目录条目
   * 全部构造失败，而原因就是漏了这一个条件 —— 目录层看起来「一切正常」，
   * 只是所有条目都悄悄变成了「不支持」。
   */
  const heroAlreadyActed = spec.heroAlreadyActed ?? spec.kind === GtoScenarioKind.VS_3BET;
  const validation = validatePriorActions(
    spec.tableSize,
    spec.heroPosition,
    history,
    heroAlreadyActed,
  );
  if (!validation.ok) return null;

  // 注：**盲注位可以出现在前序动作里**（真实的牌局里 SB/BB 当然可以加注），
  // 因此这里不排除它们。目录层面只提供「由非盲注的第一个行动位开池」的模板，
  // 那是**目录的选择**，不是 `GtoScenario` 这个数据结构的限制。

  /*
   * 🔴 **语义不变量**：`RFI` 只允许出现在第一个行动位。
   *
   * 这一条无论 `actionHistory` 是自动生成还是调用方显式给的，都必须成立 ——
   * 只检查 `defaultActionHistoryFor` 的返回值是不够的：显式传
   * `actionHistory: []` 就能绕过它，于是一个**不存在于树里**的节点
   *（「6 人桌 HJ 无人入池」）会被伪装成存在，并拿到别人节点的策略。
   */
  if (spec.kind === GtoScenarioKind.RFI) {
    if (actingIndexOf(spec.tableSize, spec.heroPosition) !== 0) return null;
    if (history.length !== 0) return null;
    if (heroAlreadyActed) return null;
  }

  const raiseSizes = history
    .filter(
      (a) =>
        a.kind === GtoActionKind.RAISE ||
        a.kind === GtoActionKind.BET ||
        a.kind === GtoActionKind.ALL_IN,
    )
    .map((a) => roundBB(a.sizeBB ?? 0))
    .filter((v) => v > 0);

  return {
    kind: spec.kind,
    gameType: 'CASH',
    tableSize: spec.tableSize,
    effectiveStackBB: roundBB(spec.effectiveStackBB),
    heroPosition: spec.heroPosition,
    villainPosition: spec.villainPosition ?? null,
    actionHistory: Object.freeze(
      history.map((a) =>
        Object.freeze({
          position: a.position,
          kind: a.kind,
          sizeBB: a.sizeBB === null ? null : roundBB(a.sizeBB),
        }),
      ),
    ),
    raiseSizesBB: Object.freeze(raiseSizes),
    blinds: Object.freeze({
      sbBB: roundBB((spec.blinds ?? GTO_STANDARD_BLINDS).sbBB),
      bbBB: roundBB((spec.blinds ?? GTO_STANDARD_BLINDS).bbBB),
      anteBB: roundBB((spec.blinds ?? GTO_STANDARD_BLINDS).anteBB),
    }),
    heroAlreadyActed,
  };
}

/* ============================================================
 * 哈希
 * ============================================================ */

/**
 * FNV-1a 32 位哈希（与 `hashManualInput` 同一算法族），输出 8 位十六进制。
 *
 * ⚠️ **不是密码学哈希**。它的用途是「把同样的输入折叠成一个稳定的短串」，
 * 而不是防碰撞攻击。碰撞的后果是缓存命中错条目 —— 这一点由
 * 「缓存键 = 场景哈希 + 求解设置指纹」部分缓解，但**不是**彻底解决。
 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 场景哈希（FNV-1a，与 `hashManualInput` 同一算法族）。
 *
 * ## 🔴 必须进入哈希的字段（缺一不可）
 *
 * | 字段 | 为什么 |
 * |---|---|
 * | `tableSize` | 4MAX 的 BTN ≠ 6MAX 的 BTN ≠ 9MAX 的 BTN |
 * | `effectiveStackBB` | 100BB 与 40BB 是完全不同的决策节点 |
 * | `heroPosition` | 「我在 BTN」与「我在 BB」是两个问题 |
 * | `kind` | RFI 与 VS_OPEN 不是同一个问题 |
 * | `actionHistory` | 谁开的池、开多少、谁弃牌 —— 全都改变答案 |
 * | `heroAlreadyActed` | Hero 是否已经出过手（决定他面对的是不是 3Bet） |
 *
 * ## ⚠️ 刻意**不**进入哈希的东西
 *
 * - **真人信息**：`GtoScenario` 里根本没有这些字段（类型级防线）；
 * - **求解器版本**：那属于缓存键，不属于「问题」本身；
 * - **`villainPosition`**：它已经完整地体现在 `actionHistory` 里
 *  （谁是那个加注的人）。重复计入会让「同样的历史、一条填了 villain、
 *   一条没填」得到两个哈希 —— 那是**同一份策略的两份缓存**。
 */
export function scenarioHashOf(scenario: GtoScenario): string {
  const payload = {
    v: GTO_SCENARIO_HASH_VERSION,
    kind: scenario.kind,
    gameType: scenario.gameType,
    tableSize: scenario.tableSize,
    effectiveStackBB: roundBB(scenario.effectiveStackBB),
    heroPosition: scenario.heroPosition,
    actionHistory: scenario.actionHistory.map((a) => ({
      position: a.position,
      kind: a.kind,
      sizeBB: a.sizeBB === null ? null : roundBB(a.sizeBB),
    })),
    blinds: {
      sbBB: roundBB(scenario.blinds.sbBB),
      bbBB: roundBB(scenario.blinds.bbBB),
      anteBB: roundBB(scenario.blinds.anteBB),
    },
    heroAlreadyActed: scenario.heroAlreadyActed,
  };
  return `g${fnv1a(JSON.stringify(payload))}`;
}

/**
 * **动作树指纹**：描述「这是同一棵树吗」。
 *
 * ## 🔴 它存在的唯一理由：BR gap 只在**同一棵树**上可比
 *
 * | 键 | 回答的问题 | 对 Hero 位置敏感？ | 对求解设置敏感？ |
 * |---|---|---|---|
 * | `scenarioHash` | 我在问哪个问题 | ✅ | ❌ |
 * | `treeId` | 这是同一棵动作树吗 | ❌ | ✅ |
 * | `cacheKey` | 这份缓存还能用吗 | ✅ | ✅ |
 *
 * 实测依据：6MAX 的「两分支树」（无全下）gap 之和是 `0.015`，
 * 而「三分支树」（含全下）是 `0.998` —— 差 **60 倍**。
 * 拿两个不同树的 gap 互相比，会得出「这个桌型收敛得更差」这种**错误结论**。
 *
 * ⚠️ 树由「桌人数 + 盲注结构 + 动作菜单」定义，**不由 Hero 是谁定义** ——
 * 同一棵树上的不同节点，gap 是可以比较的。这正是它与 `cacheKey` 的区别。
 */
export function treeIdOf(
  scenario: GtoScenario,
  tree: {
    openSizesBB: readonly number[];
    raiseMults: readonly number[];
    maxRaises: number;
    limp: boolean;
    addAllin: boolean;
    engine: string;
  },
): string {
  const payload = {
    // 树的「形状」由桌人数与盲注决定
    tableSize: scenario.tableSize,
    blinds: {
      sbBB: roundBB(scenario.blinds.sbBB),
      bbBB: roundBB(scenario.blinds.bbBB),
      anteBB: roundBB(scenario.blinds.anteBB),
    },
    stack: roundBB(scenario.effectiveStackBB),
    // 树的「分叉」由动作菜单决定
    openSizesBB: [...tree.openSizesBB].map(roundBB),
    raiseMults: [...tree.raiseMults].map(roundBB),
    maxRaises: tree.maxRaises,
    limp: tree.limp,
    addAllin: tree.addAllin,
    engine: tree.engine,
  };
  return `t${fnv1a(JSON.stringify(payload))}`;
}

/**
 * **求解设置指纹**：描述「用什么配置去解」。
 *
 * 它与场景哈希是**两把不同的键**：
 *
 * ```text
 * cacheKey = 场景哈希 + 求解设置指纹
 *          = 「哪个问题」+「用什么配置解的」
 * ```
 *
 * 少了后半段，就会出现「把 add_allin 打开之后命中了没有全下的旧结果」
 * 这种最难查的缺陷 —— 数字看起来完全正常。
 */
export function solveFingerprintOf(solve: GtoSolveKeyParts): string {
  const payload = {
    v: GTO_CACHE_KEY_VERSION,
    engine: solve.engine,
    engineCommit: solve.engineCommit,
    solverVersion: solve.solverVersion,
    openSizesBB: [...solve.openSizesBB].map(roundBB),
    raiseMults: [...solve.raiseMults].map(roundBB),
    maxRaises: solve.maxRaises,
    limp: solve.limp,
    addAllin: solve.addAllin,
    rakePct: roundBB(solve.rakePct),
    rakeCap: roundBB(solve.rakeCap),
    realization: solve.realization,
    multiwayEquityModel: solve.multiwayEquityModel,
    iterations: solve.iterations,
    targetGap: solve.targetGap,
    checkEvery: solve.checkEvery,
    enginePositions: [...solve.enginePositions],
    posts: [...solve.posts].map(roundBB),
    ante: roundBB(solve.ante),
  };
  return `s${fnv1a(JSON.stringify(payload))}`;
}

/**
 * 缓存键 = 场景哈希 + 求解设置指纹。
 *
 * 输出形如 `c1a2b3c4d`（9 字符：前缀 + 8 位十六进制）。
 */
export function cacheKeyOf(scenario: GtoScenario, solve: GtoSolveKeyParts): string {
  const payload = {
    v: GTO_CACHE_KEY_VERSION,
    scenario: scenarioHashOf(scenario),
    solve: solveFingerprintOf(solve),
  };
  return `c${fnv1a(JSON.stringify(payload))}`;
}

/**
 * 把三把键一次性算出来。
 *
 * 🔴 存在的理由：**调用方不该自己拼这三把键的口径**。
 * 曾经在 store 与 API 里各写了一遍「缓存键 = 场景 + 设置」，
 * 于是一处改了另一处没改 —— 那正是「同一份约束写在两处」的经典形态。
 */
export function keysOf(
  scenario: GtoScenario,
  solve: GtoSolveKeyParts,
): { scenarioHash: string; treeId: string; cacheKey: string } {
  return {
    scenarioHash: scenarioHashOf(scenario),
    treeId: treeIdOf(scenario, {
      openSizesBB: solve.openSizesBB,
      raiseMults: solve.raiseMults,
      maxRaises: solve.maxRaises,
      limp: solve.limp,
      addAllin: solve.addAllin,
      engine: solve.engine,
    }),
    cacheKey: cacheKeyOf(scenario, solve),
  };
}

/* ============================================================
 * 可读描述
 * ============================================================ */

function formatBB(value: number): string {
  return String(roundBB(value));
}

function describeActionZh(action: GtoScenarioAction): string {
  switch (action.kind) {
    case GtoActionKind.FOLD:
      return `${action.position} 弃牌`;
    case GtoActionKind.CHECK:
      return `${action.position} 过牌`;
    case GtoActionKind.CALL:
      return action.sizeBB === null
        ? `${action.position} 跟注`
        : `${action.position} 跟注到 ${formatBB(action.sizeBB)}BB`;
    case GtoActionKind.BET:
      return action.sizeBB === null
        ? `${action.position} 下注`
        : `${action.position} 下注 ${formatBB(action.sizeBB)}BB`;
    case GtoActionKind.RAISE:
      return action.sizeBB === null
        ? `${action.position} 加注`
        : `${action.position} 加注到 ${formatBB(action.sizeBB)}BB`;
    case GtoActionKind.ALL_IN:
      return action.sizeBB === null
        ? `${action.position} 全下`
        : `${action.position} 全下 ${formatBB(action.sizeBB)}BB`;
    default:
      return `${action.position} ${String(action.kind)}`;
  }
}

/**
 * 一行中文描述这个场景（**给界面与证据文件用**）。
 *
 * 形如：
 *
 * ```text
 * 9 人桌 / 100BB / BB / VS_OPEN（UTG 加注到 2.5BB → UTG1 弃牌 → … → SB 弃牌）
 * ```
 *
 * 🔴 为什么值得单独做一个函数：**场景必须能被打印出来**。
 * 「标签写 BTN、数据是 UTG」那个缺陷之所以被发现，就是因为探针把
 * 真实场景打印出来对照了标签。一个看不见的场景等于一个无法审计的场景。
 */
export function describeScenarioZh(scenario: GtoScenario): string {
  const head =
    `${scenario.tableSize} 人桌 / ${formatBB(scenario.effectiveStackBB)}BB / ` +
    `${scenario.heroPosition} / ${scenario.kind}`;
  if (scenario.actionHistory.length === 0) return `${head}（Hero 是第一个行动的人）`;
  const history = scenario.actionHistory.map(describeActionZh).join(' → ');
  return `${head}（${history}）`;
}

/**
 * 可读的「这个数字是怎么来的」——**多行**，不是一坨哈希。
 *
 * 用途：界面上有一个「为什么是这个数字」的折叠面板；缺陷排查时
 * 把这几行贴进报告就能完整复现。
 *
 * ⚠️ 每一行都必须**可独立阅读**：不接受「详见上文」这种写法。
 */
export function scenarioFingerprintLines(
  scenario: GtoScenario,
  solve: GtoSolveKeyParts,
): readonly string[] {
  const keys = keysOf(scenario, solve);
  const lines: string[] = [];
  lines.push(
    `场景 ${scenario.tableSize}MAX / ${formatBB(scenario.effectiveStackBB)}BB / ` +
      `Hero=${scenario.heroPosition}`,
  );
  lines.push(`问题 ${scenario.kind}${scenario.heroAlreadyActed ? '（Hero 已行动过）' : ''}`);
  if (scenario.actionHistory.length === 0) {
    lines.push('前序 无（Hero 是第一个行动的人）');
  } else {
    lines.push(
      '前序 ' +
        scenario.actionHistory
          .map((a) =>
            a.kind === GtoActionKind.FOLD
              ? `${a.position} 弃牌`
              : `${a.position} ${a.kind}→${a.sizeBB === null ? '?' : `${formatBB(a.sizeBB)}BB`}`,
          )
          .join(' → '),
    );
  }
  lines.push(
    `求解 开池 [${solve.openSizesBB.map(formatBB).join('/')}] · ` +
      `再加注 [${solve.raiseMults.map(formatBB).join('/')}]× · ` +
      `加注上限 ${solve.maxRaises} · 跛入 ${solve.limp ? '允许' : '关闭'} · ` +
      `全下 ${solve.addAllin ? '提供' : '不提供'}`,
  );
  lines.push(
    `引擎 ${solve.engine}` +
      `${solve.engineCommit === null ? '' : ` @ ${solve.engineCommit.slice(0, 7)}`}` +
      `${solve.solverVersion === null ? '' : ` ${solve.solverVersion}`} · ` +
      `多路权益模型 ${solve.multiwayEquityModel ?? '未报告'}`,
  );
  lines.push(
    `预算 迭代 ${solve.iterations} · 目标 gap ${solve.targetGap} · 检查间隔 ${solve.checkEvery}`,
  );
  lines.push(
    `盲注 SB ${formatBB(scenario.blinds.sbBB)} / BB ${formatBB(scenario.blinds.bbBB)} / ` +
      `前注 ${formatBB(scenario.blinds.anteBB)}`,
  );
  lines.push(
    `座位 ${solve.enginePositions.join(' → ')} · 下注 [${solve.posts.map(formatBB).join(',')}]`,
  );
  lines.push(
    `键 scenario=${keys.scenarioHash} · tree=${keys.treeId} · cache=${keys.cacheKey} · ` +
      `solve=${solveFingerprintOf(solve)}`,
  );
  return Object.freeze(lines);
}

/* ============================================================
 * 等价与自检
 * ============================================================ */

/**
 * 两个场景是不是**同一个问题**。
 *
 * 用途：`GtoSafeLookup` 在从缓存读回一个条目时，必须先确认
 * 「缓存里那个场景」与「我现在要问的场景」是同一个 ——
 * 缓存文件的键是哈希，而哈希理论上会碰撞，更现实的是**文件被换过**。
 * 这里逐字段比对，而不是只比哈希。
 */
export function scenariosEquivalent(a: GtoScenario, b: GtoScenario): boolean {
  if (a.kind !== b.kind) return false;
  if (a.gameType !== b.gameType) return false;
  if (a.tableSize !== b.tableSize) return false;
  if (roundBB(a.effectiveStackBB) !== roundBB(b.effectiveStackBB)) return false;
  if (a.heroPosition !== b.heroPosition) return false;
  if (a.heroAlreadyActed !== b.heroAlreadyActed) return false;
  if (roundBB(a.blinds.sbBB) !== roundBB(b.blinds.sbBB)) return false;
  if (roundBB(a.blinds.bbBB) !== roundBB(b.blinds.bbBB)) return false;
  if (roundBB(a.blinds.anteBB) !== roundBB(b.blinds.anteBB)) return false;
  if (a.actionHistory.length !== b.actionHistory.length) return false;
  for (let i = 0; i < a.actionHistory.length; i++) {
    const x = a.actionHistory[i]!;
    const y = b.actionHistory[i]!;
    if (x.position !== y.position) return false;
    if (x.kind !== y.kind) return false;
    const xs = x.sizeBB === null ? null : roundBB(x.sizeBB);
    const ys = y.sizeBB === null ? null : roundBB(y.sizeBB);
    if (xs !== ys) return false;
  }
  return true;
}

/**
 * 启动自检：把「这个模块里不许成立的事情」变成可执行的检查。
 *
 * 返回**问题清单**（空数组 = 通过）。刻意不抛异常：
 * 启动自检的用途是「把问题打出来」，而不是让进程起不来。
 */
export function selfCheckScenarioLayer(): string[] {
  const problems: string[] = [];
  const sizes = [4, 5, 6, 8, 9] as const;

  // 1. 支持列表与位置表必须自洽
  for (const tableSize of sizes) {
    const order = gtoPositionsFor(tableSize);
    if (order.length !== gtoSeatCountOf(tableSize)) {
      problems.push(`${tableSize} 人桌的位置数与座位数不一致`);
    }
    if (order[order.length - 1] !== 'BB' || order[order.length - 2] !== 'SB') {
      problems.push(`${tableSize} 人桌的最后两位必须是 SB 与 BB`);
    }
    const blinds = blindsAt(tableSize);
    if (blinds.sb !== 'SB' || blinds.bb !== 'BB') {
      problems.push(`${tableSize} 人桌的盲注位推导错误`);
    }
    if (tableSize === 4 && firstToActPositionOf(4) !== 'CO') {
      problems.push('4 人桌的第一个行动位必须是 CO（4 人桌没有 UTG）');
    }
  }
  if (isGtoTableSize(7)) problems.push('7 人桌必须是「不支持」');

  // 2. 「能面对 3Bet 的位置」必须恰好是第一个行动位
  for (const tableSize of sizes) {
    const order = gtoPositionsFor(tableSize);
    for (const position of order) {
      const can = canHeroFaceThreeBet(tableSize, position);
      if (can !== (position === order[0])) {
        problems.push(`${tableSize}MAX ${position}：只有第一个行动位能面对 3Bet`);
      }
    }
  }

  // 3. RFI 只允许第一个行动位
  for (const tableSize of sizes) {
    for (const heroPosition of gtoPositionsFor(tableSize)) {
      const built = buildGtoScenario({
        kind: GtoScenarioKind.RFI,
        tableSize,
        effectiveStackBB: 100,
        heroPosition,
      });
      const shouldBeRfi = firstToActPositionOf(tableSize) === heroPosition;
      if (shouldBeRfi !== (built !== null)) {
        problems.push(`${tableSize}MAX ${heroPosition} 的 RFI 可构造性判定错误`);
      }
    }
  }

  // 4. 哈希格式稳定，且桌人数确实进入哈希
  const rfiHashes = new Set<string>();
  for (const tableSize of sizes) {
    const scenario = buildGtoScenario({
      kind: GtoScenarioKind.RFI,
      tableSize,
      effectiveStackBB: 100,
      heroPosition: firstToActPositionOf(tableSize),
    });
    if (scenario === null) {
      problems.push(`${tableSize}MAX 的 RFI 构造失败`);
      continue;
    }
    const hash = scenarioHashOf(scenario);
    if (hash !== scenarioHashOf(scenario)) problems.push(`${tableSize}MAX 的 RFI 哈希不稳定`);
    if (!/^g[0-9a-f]{8}$/.test(hash)) problems.push(`${tableSize}MAX 的 RFI 哈希格式错误`);
    rfiHashes.add(hash);
  }
  if (rfiHashes.size !== sizes.length) {
    problems.push('5 个桌型的 RFI 场景哈希出现重复（桌人数隔离失守）');
  }

  /*
   * 5. 🔴 **`VS_3BET` 的几何必须处处可构造** —— 本轮代价最大的一条结论。
   *
   * 写错时不会抛异常，只会让 `buildGtoScenario` 返回 `null`，
   * 而 `null` 被上层报成「参数组合不合法」—— 一个**看不见的**缺陷。
   */
  for (const tableSize of sizes) {
    for (const heroPosition of gtoPositionsFor(tableSize)) {
      if (!canHeroFaceThreeBet(tableSize, heroPosition)) continue;
      const bettors = legalThreeBettorsFor(tableSize, heroPosition);
      if (bettors.length === 0) {
        problems.push(`${tableSize}MAX ${heroPosition} 后面没有可 3Bet 的非盲注座位`);
        continue;
      }
      for (const bettor of bettors) {
        const scenario = buildGtoScenario({
          kind: GtoScenarioKind.VS_3BET,
          tableSize,
          effectiveStackBB: 100,
          heroPosition,
          villainPosition: bettor,
          openSizeBB: DEFAULT_OPEN_SIZE_BB,
        });
        if (scenario === null) {
          problems.push(`${tableSize}MAX ${heroPosition} vs ${bettor} 3Bet 构造失败`);
          continue;
        }
        const raises = scenario.actionHistory.filter((a) => isAggressive(a));
        if (raises[0]?.position !== heroPosition) {
          problems.push(`${tableSize}MAX ${heroPosition} vs ${bettor} 3Bet 的开池者不是 Hero`);
        }
        if (raises[raises.length - 1]?.position !== bettor) {
          problems.push(
            `${tableSize}MAX ${heroPosition} vs ${bettor} 3Bet 的最后加注者不是 ${bettor}`,
          );
        }
        if (!scenario.heroAlreadyActed) {
          problems.push(
            `${tableSize}MAX ${heroPosition} vs ${bettor} 3Bet 的 heroAlreadyActed 应为 true`,
          );
        }
      }
    }
  }

  return problems;
}
