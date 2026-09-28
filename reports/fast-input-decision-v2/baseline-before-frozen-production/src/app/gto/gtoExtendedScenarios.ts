/**
 * 扩展场景目录（Phase 1.1 第二轮）：VS_OPEN / VS_3BET / VS_4BET
 *
 * ## 这个模块与 `gtoScenarioCatalog.ts` 的分工
 *
 * | 模块 | 内容 | 特点 |
 * |---|---|---|
 * | `gtoScenarioCatalog.ts` | Phase 1 的基础目录（RFI / 面对开池） | 已被 Phase 1 的 22 项测试锁住，**不改** |
 * | 本模块 | Phase 1.1 的扩展目录 | 新增，独立可测 |
 *
 * 分开的理由：Phase 1 的目录里有「哪些组合无法表达」的**逐条中文原因**，
 * 而那是被测试逐条断言的。往里塞新模板会同时改动「已有组合的
 * `unsupportedReasonFor` 分支」—— 那是回归风险，不是功能。
 *
 * ## 🔴 一个被实测反复推翻之后才定下来的结论
 *
 * 「3Bet」在树里**只有一侧是可达的决策节点**：
 *
 * ```text
 * UTG 加注 → HJ 3Bet → CO/BTN/SB/BB 弃 → 行动回到 UTG   ✅ 可达（UTG 面对 3Bet）
 *                                        → 行动回到 HJ   ❌ 这个节点不存在
 * ```
 *
 * 依据是求解器源码 `crates/solver/src/preflop/mod.rs` 的 `next_state_of()`：
 *
 * ```rust
 * ns.needs = ((1u32 << n) - 1) & !ns.folded & !ns.allin & !(1 << actor);
 * ```
 *
 * 一次加注只为**除加注者之外**的每个活人重新打开行动 ——
 * 3Bettor（最后一个加注者）**永远不会**再被叫到。
 *
 * 因此本模块**不提供**「Hero 自己做 3Bet」这个模板：它不是一个节点，
 * 构造出来只会指向别人的策略（实测四次全部落在开池者身上，
 * 见 `reports/evidence/gto-threebet-live-evidence.txt`）。
 * 要读「Hero 用哪些牌 3Bet」，读 `VS_NAMED_OPEN` 节点上的 `RAISE` 项。
 */

import {
  GtoActionKind,
  GtoScenarioKind,
  type GtoPosition,
  type GtoScenario,
  type GtoScenarioAction,
  type GtoTableSize,
  gtoPositionsFor,
} from '../../domain/gto/gto.types.ts';
import {
  DEFAULT_OPEN_SIZE_BB,
  DEFAULT_RAISE_MULT,
  buildGtoScenario,
  canHeroFaceThreeBet,
  circularAfter,
  legalThreeBettorsFor,
  roundBB,
  scenarioHashOf,
  type GtoScenarioSpec,
} from '../../domain/gto/gtoScenario.ts';

/** 扩展模板 */
export const GtoExtendedTemplate = {
  /**
   * 面对**第一个行动位**的开池。
   *
   * ⚠️ 这一条与「面对 BTN 开池」是**不同的节点**，别混用 ——
   * 用错会读到别人的策略。要指定开池者请用 `VS_NAMED_OPEN`。
   */
  VS_FIRST_OPEN: 'VS_FIRST_OPEN',
  /**
   * 🔴 **Phase 1.1 的关键修正**：面对**指定位置**的开池。
   *
   * ## 为什么必须加这一条
   *
   * 用户点名的场景是「BB vs **BTN** Open」「BTN vs **CO** Open」，
   * 而本模块的第一版实现把它们错误地构造成了「面对**第一个行动位**的开池」
   *（6MAX 下 = UTG 开池）—— 那是**另一个节点**，读到的范围完全不同。
   *
   * 这个缺陷是 `test/gtoExtendedScenarios.test.ts` 与真实联调一起抓出来的：
   * 探针打印的真实场景描述里写着「UTG 加注到 2.5BB」，
   * 而标签写着「vs BTN Open」—— **标签与数据不一致**。
   *
   * 教训：**标签必须由数据生成，不能由调用方另写一份**。
   * 现在开池者由 `openerPosition` 显式给出，并进入场景哈希。
   */
  VS_NAMED_OPEN: 'VS_NAMED_OPEN',
  /**
   * 🔴 **Phase 1.1（第六版几何）**：Hero **开池之后被 3Bet**，行动回到 Hero。
   *
   * ## 为什么 Hero 是开池者，而不是 3Bettor
   *
   * 求解器源码 `crates/solver/src/preflop/mod.rs` 的 `next_state_of()`：
   *
   * ```rust
   * ns.needs = ((1u32 << n) - 1) & !ns.folded & !ns.allin & !(1 << actor);
   * ```
   *
   * 一次加注为**除加注者之外**的每个活人重新打开行动。
   * 因此 3Bettor（最后一个加注者）**不会再被叫到**，
   * 一圈人弃牌之后行动回到的是**开池者** —— 他去面对那个 3Bet。
   *
   * 实测（`scripts/gto-node-walk.raw.mjs`，6 人桌）：
   *
   * ```text
   * UTG 加注 2.5 → HJ 3Bet 7.5 → CO 弃 → BTN 弃 → SB 弃 → BB 弃 → 行动者 = UTG
   * ```
   *
   * 探针连续 4 次都落在「开池者」身上，这就是那 4 次失败给出的答案。
   *
   * ## 目录层为什么**仍然**把它标成未支持
   *
   * 不是「表达不了」（`heroAlreadyActed` 已经支持这种形态），
   * 而是**读出来会是一个残缺节点**：`max_raises = 2` 时开池者没有 4Bet 分支，
   * 实测菜单只有 `Fold · Call 7.5`。理由见 `VS_3BET_UNSUPPORTED_REASON`。
   */
  VS_3BET: 'VS_3BET',
  /** Hero 面对一个 4Bet（需要第三次加注，当前配置下树里没有这条路径） */
  VS_4BET: 'VS_4BET',
} as const;
export type GtoExtendedTemplate =
  (typeof GtoExtendedTemplate)[keyof typeof GtoExtendedTemplate];

export const GTO_EXTENDED_TEMPLATE_ZH: Readonly<Record<GtoExtendedTemplate, string>> = Object.freeze({
  VS_FIRST_OPEN: '面对首位开池',
  VS_NAMED_OPEN: '面对指定开池',
  VS_3BET: '面对 3Bet',
  VS_4BET: '面对 4Bet',
});

/** 扩展目录条目 */
export type GtoExtendedCatalogEntry = {
  id: string;
  tableSize: GtoTableSize;
  heroPosition: GtoPosition;
  template: GtoExtendedTemplate;
  /**
   * 开池者的位置（仅 `VS_NAMED_OPEN` 有意义，其余为 `null`）。
   *
   * 🔴 这个字段存在的理由是**让标签与数据一一对应**：
   * 之前用「面对开池」一个标签盖住了所有开池者，
   * 于是「BB vs BTN Open」的标签下面是 UTG 开池的数据。
   */
  openerPosition: GtoPosition | null;
  labelZh: string;
  scenario: GtoScenario | null;
  scenarioHash: string;
  unsupportedReason: string | null;
  /**
   * 该场景需要的**最少加注层数**（开池=1，3Bet=2，4Bet=3）。
   *
   * 用途：在**建树之前**就能判断「当前配置的 `max_raises` 够不够」，
   * 而不是等求解器返回「路径不存在」。这是一个可静态计算的必要条件 ——
   * 但**不是充分条件**（树里真的有没有那条路径，仍然要靠求解器的动作菜单）。
   */
  requiredMaxRaises: number;
};

/* ============================================================
 * 前序动作构造
 * ============================================================ */

function fold(position: GtoPosition): GtoScenarioAction {
  return { position, kind: GtoActionKind.FOLD, sizeBB: null };
}

function raiseTo(position: GtoPosition, sizeBB: number): GtoScenarioAction {
  return { position, kind: GtoActionKind.RAISE, sizeBB };
}

/**
 * Hero 之前、第一个行动位之后的全部座位（不含 Hero，不含已行动的座位）。
 *
 * ⚠️ 这里的 `order` 是**翻牌前行动顺序**，因此「Hero 之前」=
 * 数组下标小于 Hero 的那些座位。**不**包含 Hero 自己。
 */
function seatsBetween(order: readonly GtoPosition[], from: number, to: number): GtoPosition[] {
  return order.slice(from, to);
}

/**
 * 构造扩展场景的前序动作。
 *
 * ## 每条规则（**显式写出来，因为它决定了「验证了什么」**）
 *
 * | 模板 | 前序动作 | Hero 是什么角色 |
 * |---|---|---|
 * | `VS_FIRST_OPEN` | `open(第一位)` + 中间全弃 | 面对开池 |
 * | `VS_NAMED_OPEN` | `open(openerPosition)` + 中间全弃 | 面对开池 |
 * | `VS_3BET` | **Hero 开池** + 中间全弃 + 有人 3Bet + 环绕全弃 | **开池者**（被 3Bet 的人） |
 * | `VS_4BET` | —— 返回 `null`（见下） | 面对 4Bet 的人 |
 *
 * ## ⚠️ 一条必须说清楚的结构事实
 *
 * 求解器的行动顺序里**盲注位在最后**，且每个节点是「谁在行动」，不是「谁是 Hero」。
 *
 * - **「Hero 自己做 3Bet」在树里不是一个可达的决策节点。**
 *   求解器源码 `next_state_of()`：
 *   `ns.needs = ((1u32 << n) - 1) & !ns.folded & !ns.allin & !(1 << actor);`
 *   —— 一次加注只为**除加注者之外**的每个活人重新打开行动。
 *   3Bettor 是最后一个加注者，所以一圈人弃牌之后行动回到的是**开池者**，
 *   3Bettor 永远不会再被叫到。实测确认：
 *   `UTG 加注 → HJ 3Bet → CO/BTN/SB/BB 弃 → 行动者是 UTG`。
 *
 *   因此「读 Hero 的 3Bet 范围」**不**通过一个「Hero 3Bet」场景来读，
 *   而是读 **`VS_NAMED_OPEN` 节点上的 `RAISE` 项**（那个节点的菜单本来就是
 *   `Fold / Call / 3-bet / All-in`，实测 6MAX 是
 *   `FOLD · CALL@2.5BB · 3-bet@7.5BB · ALL-IN@100BB`）。
 *
 * - **`VS_3BET` 需要「Hero 已经行动过」这种形态**（他是开池者），
 *   由 `heroAlreadyActed` 支持。它在目录里仍然标未支持，
 *   但理由变成了「读出来是残缺节点」（缺 4Bet 分支），
 *   详见 `VS_3BET_UNSUPPORTED_REASON`。
 */
export function extendedActionHistoryFor(
  tableSize: GtoTableSize,
  heroPosition: GtoPosition,
  template: GtoExtendedTemplate,
  openSizeBB = DEFAULT_OPEN_SIZE_BB,
  /** `VS_NAMED_OPEN` 用：开池者；`VS_3BET` 用：3Bettor */
  counterpartyPosition?: GtoPosition,
): GtoScenarioAction[] | null {
  const order = gtoPositionsFor(tableSize);
  const heroIndex = order.indexOf(heroPosition);
  if (heroIndex < 0) return null;
  const openerPosition = counterpartyPosition;
  const threeBettorPosition = counterpartyPosition;
  // 除 `VS_3BET` 外，其余模板都要求 Hero 前面有人（有人先开池）
  if (template !== GtoExtendedTemplate.VS_3BET && heroIndex < 1) return null;
  // `VS_3BET` 要求 Hero 后面有人可以 3Bet
  if (template === GtoExtendedTemplate.VS_3BET && heroIndex >= order.length - 1) return null;

  switch (template) {
    case GtoExtendedTemplate.VS_FIRST_OPEN: {
      const first = order[0]!;
      return [raiseTo(first, openSizeBB), ...seatsBetween(order, 1, heroIndex).map(fold)];
    }

    case GtoExtendedTemplate.VS_NAMED_OPEN: {
      /*
       * 🔴 开池者必须**显式给出**，且必须满足两条：
       * 1. 在 Hero **之前**行动（否则「面对他的开池」不成立）；
       * 2. 不是 Hero 自己。
       *
       * 不满足就返回 `null` —— **不用第一个行动位顶替**。
       * 这正是第一版犯的错：标签写 BTN、数据是 UTG。
       *
       * ## 历史的三段结构（**这是真实行动几何，不是随意拼的**）
       *
       * ```text
       * [UTG…opener 之前的人] 弃牌  →  [opener] 加注  →  [opener 之后、Hero 之前的人] 弃牌
       * ```
       *
       * 三段**缺一不可**：
       * - 第一段：他们比 opener 先行动，且都弃牌（否则 opener 不是「开池者」）；
       * - 第二段：opener 加注；
       * - 第三段：opener 之后的人**还没行动**，而 Hero 面对的是 opener 的加注，
       *   因此他们要弃牌 —— **但盲注位的弃牌要排除**：
       *
       * ⚠️ 为什么排除 SB/BB：`SB` 在行动顺序里排在 `BB` **之前**。
       * 对 `Hero = BB` 而言，`SB` 在 Hero 之前，理应弃牌（这一步要保留）；
       * 但 **Hero 自己 = BB 不在 `between` 里**（`seatsBetween` 到 heroIndex 为止）。
       * 真正要排除的是「**Hero 之后**的盲注位」—— 而按 `heroIndex` 切分已经做到了。
       *
       * 换句话说：第三段就是 `order[(openerIndex+1) … heroIndex-1]`，
       * 一行 `seatsBetween` 就够，**不额外排除任何东西**。
       */
      if (openerPosition === undefined) return null;
      const openerIndex = order.indexOf(openerPosition);
      if (openerIndex < 0 || openerIndex >= heroIndex) return null;
      const before = seatsBetween(order, 0, openerIndex);
      const after = seatsBetween(order, openerIndex + 1, heroIndex);
      return [...before.map(fold), raiseTo(openerPosition, openSizeBB), ...after.map(fold)];
    }

    case GtoExtendedTemplate.VS_3BET: {
      /*
       * 🔴 **Hero 是开池者**，3Bettor 在 Hero **之后**。
       *
       * 真实几何（**第六版**，前五版全部被实测推翻）：
       *
       * ```text
       * UTG 加注 2.5(Hero) → HJ 3Bet 7.5 → CO 弃 → BTN 弃 → SB 弃 → BB 弃 → 回到 UTG
       * ```
       *
       * ## 三段结构
       *
       * ```text
       * [Hero] 开池  →  [Hero 与 3Bettor 之间] 弃牌  →  [3Bettor] 加注  →  [环绕一圈] 弃牌
       * ```
       *
       * ⚠️ **最后一段必须是「环绕顺序」**：加注之后行动从 3Bettor 的下一位
       * 开始绕，跳过已经弃牌的、以及**行动要回去的那个开池者**。
       * 写成「数组里 3Bettor 之后的部分」会漏掉下标更小、却还没行动过的座位，
       * 后果不是「少两步」而是**行动落到别人身上**。
       */
      if (threeBettorPosition === undefined) return null;
      /*
       * 🔴 **Hero 必须是第一个行动位** —— 这是第六版最后一条结论。
       *
       * 只要 Hero 前面还有「还没行动过」的座位，那个人就会在 Hero 之后
       * 回答这个 3Bet，于是收口人是他、不是 Hero。实测：
       * `HJ 开池 → CO 3Bet → BTN/SB/BB 弃 → UTG 弃` 之后**牌局结束**，
       * HJ 再也没有轮到（`reports/evidence/gto-vs3bet-live-evidence.txt`）。
       */
      if (!canHeroFaceThreeBet(tableSize, heroPosition)) return null;
      const threeBettorIndex = order.indexOf(threeBettorPosition);
      if (threeBettorIndex <= heroIndex) return null; // 3Bettor 必须在 Hero 之后
      if (threeBettorPosition === 'SB' || threeBettorPosition === 'BB') return null; // 盲注位不作为 3Bettor
      const between = seatsBetween(order, heroIndex + 1, threeBettorIndex);
      /*
       * 🔴 3Bet 之后的弃牌必须是**环绕一圈**，而且**不排除 Hero**。
       *
       * 一圈从 3Bettor 的下一位开始，走遍所有**还没弃牌**的座位，
       * 最后回到 Hero（他是开池者，也是这一圈的收口人）。
       *
       * ⚠️ 第六版第一稿把 Hero 放进了 `exclude`，于是
       * `6MAX HJ 开池 vs CO 3Bet` 的历史漏掉了**开头的 UTG**：
       * 座位顺序是 `UTG HJ CO BTN SB BB`，一圈本该是
       * `BTN SB BB UTG → 回到 HJ`，而错的那版只写了 `BTN SB BB` ——
       * 实测走到的是 **UTG**（`INVALID_RESPONSE`），也就是别人的策略。
       *
       * 这正是那个反复出现的同一类缺陷：**弃牌顺序不是「数组里的那一段」，
       * 而是「从加注者下一位开始的环绕」**。
       */
      const afterThreeBettor = circularAfter(tableSize, threeBettorPosition, between);
      if (afterThreeBettor.length === 0) return null;
      /*
       * ⚠️ `circularAfter` 返回的是一圈**包括收口人**的完整顺序，
       * 而收口人正是 Hero —— 他**不是**「弃牌的人」，他是那个要决策的人。
       * 因此这里核对收口人是 Hero，然后把他从弃牌列表里去掉。
       *
       * 第一版忘了去掉，于是历史以 `UTG:FOLD` 结尾，
       * 被 `validatePriorActions` 判成「Hero 不能已经弃牌」——
       * 17 条自检全部失败。
       */
      if (afterThreeBettor[afterThreeBettor.length - 1] !== heroPosition) return null;
      const foldsAfter = afterThreeBettor.slice(0, -1);
      return [
        raiseTo(heroPosition, openSizeBB), // Hero 开池
        ...between.map(fold),
        raiseTo(threeBettorPosition, roundBB(openSizeBB * DEFAULT_RAISE_MULT)),
        ...foldsAfter.map(fold), // 环绕一圈弃牌 → 行动回到 Hero
      ];
    }

    case GtoExtendedTemplate.VS_4BET:
      return null;

    default:
      return null;
  }
}

/**
 * 为什么 `VS_3BET`（Hero 开池后被 3Bet、再轮到 Hero）在本阶段仍是**未支持**。
 *
 * ## 这条理由是**改过两次的**，两次改动本身就是两个结论
 *
 * | 版本 | 理由 | 为什么被推翻 |
 * |---|---|---|
 * | 1 | 「本项目的场景模型表达不了 Hero 已行动」 | `heroAlreadyActed` 落地后不成立 —— 留着它界面会给出一个被我们自己的代码推翻的理由 |
 * | 2 | 「Hero 是 3Bettor，读的是他自己的 3Bet 范围」 | 那个节点**在树里不存在**（见下），而且 Hero 其实是开池者 |
 * | **3** | **节点在树里、也能走到，但读出来是残缺菜单** | 见下 |
 *
 * ## 那真正的理由是什么
 *
 * 节点**真实存在**，而且我们**真的走到了它**。实测（6 人桌，`scripts/gto-node-walk.raw.mjs`）：
 *
 * ```text
 * UTG 加注 2.5 → HJ 3Bet 7.5 → CO 弃 → BTN 弃 → SB 弃 → BB 弃
 * 路径 [1,2,0,0,0,0] → 行动者 UTG，菜单 = Fold · Call 7.5     ← 只有两项
 * ```
 *
 * 但生产配置 `max_raises = 2` 下，开池者在**这个**节点上能选的动作只有两个：
 *
 * | 想要的动作 | 为什么在树里没有 |
 * |---|---|
 * | 4Bet | 需要第 3 次加注（开池 + 3Bet + 4Bet），而 `max_raises = 2` |
 * | All-in | 开池者已经加注过，再推算是第 3 次加注；且 8/9 人桌的 `add_allin` 本就关闭 |
 *
 * 也就是说：**这不是「表达不了」，而是「读出来会是一个残缺的决策节点」**。
 * 把「只能弃牌或跟注」说成「面对 3Bet 的 GTO 策略」，
 * 正是本项目禁止的那种「用残缺数据冒充完整答案」。
 *
 * ## ⚠️ 顺带一个更硬的结论：**「Hero 自己做 3Bet」不是一个可达节点**
 *
 * 求解器源码 `crates/solver/src/preflop/mod.rs` 的 `next_state_of()`：
 *
 * ```rust
 * ns.needs = ((1u32 << n) - 1) & !ns.folded & !ns.allin & !(1 << actor);
 * ```
 *
 * 一次加注只为**除加注者之外**的每个活人重新打开行动。3Bettor 是最后一个
 * 加注者，所以一圈人弃牌之后行动回到的是**开池者**，3Bettor 不会再被叫到。
 * 实测：`UTG 加注 → HJ 3Bet → CO/BTN/SB/BB 弃` 之后行动者是 **UTG**。
 *
 * 因此 `GtoScenarioKind.THREE_BET` 在本项目里**恒为未支持**，
 * 目录不生成任何条目 —— 不是「以后可能用得上」的钩子，
 * 而是给上面这条结论一个可命名的位置。
 *
 * ## 要让它变成支持，需要什么（明确写出来，不是含糊的「以后再说」）
 *
 * 1. `max_raises` 提到 3；
 * 2. 接受建树与求解时间的上升，并重新测收敛等级；
 * 3. 本项目的几何**已经**构造正确（`UTG 开池 → HJ 3Bet → 全弃 → 回到 UTG`）
 *    且已被真实求解器走到 —— 缺的只有配置这一项。
 */
export const VS_3BET_UNSUPPORTED_REASON =
  '生产配置 max_raises = 2 下，开池者面对 3Bet 时树里**没有 4Bet 分支**' +
  '（第 3 次加注超限），开池者自己也已经加注过、无法再全下；' +
  '实测该节点的菜单只有「Fold · Call」。' +
  '本项目不把残缺的菜单当作「面对 3Bet 的策略」，因此标为未支持 —— ' +
  '这个节点本身在树里是真实存在、也真的能走到的，' +
  '缺的是 max_raises = 3 这一项配置。';

/**
 * 这个模板是否**必须**给出对手位置才能定位到一个节点
 *（`VS_NAMED_OPEN` 是开池者，`VS_3BET` 是 3Bettor）。
 *
 * 🔴 这个谓词存在的唯一理由是「同一个判断被写在两处」这种缺陷形态：
 * 目录生成的循环、`buildExtendedScenario` 的查找、以及未来的路径校验
 * 只要有一处漏掉，就会把**别人的**条目/节点当成命中项。
 */
export function templateNeedsCounterparty(template: GtoExtendedTemplate): boolean {
  return (
    template === GtoExtendedTemplate.VS_NAMED_OPEN || template === GtoExtendedTemplate.VS_3BET
  );
}

/* ============================================================
 * 目录
 * ============================================================ */

/**
 * 模板 → 场景类型。
 *
 * ⚠️ `VS_FIRST_OPEN` 与 `VS_NAMED_OPEN` **都**映射到 `GtoScenarioKind.VS_OPEN`：
 * 场景类型描述的是「Hero 面对开池」这个语义，而「谁开的池」由
 * `actionHistory` 表达并进入场景哈希。两者不是两种场景类型，
 * 而是同一类型的两个不同节点。
 */
function kindOfTemplate(template: GtoExtendedTemplate): GtoScenarioKind {
  switch (template) {
    case GtoExtendedTemplate.VS_FIRST_OPEN:
    case GtoExtendedTemplate.VS_NAMED_OPEN:
      return GtoScenarioKind.VS_OPEN;
    case GtoExtendedTemplate.VS_3BET:
      return GtoScenarioKind.VS_3BET;
    case GtoExtendedTemplate.VS_4BET:
      return GtoScenarioKind.VS_4BET;
    default:
      return GtoScenarioKind.VS_OPEN;
  }
}

const EXTENDED_TEMPLATES: readonly GtoExtendedTemplate[] = Object.freeze([
  GtoExtendedTemplate.VS_FIRST_OPEN,
  GtoExtendedTemplate.VS_NAMED_OPEN,
  GtoExtendedTemplate.VS_3BET,
  GtoExtendedTemplate.VS_4BET,
]);

/**
 * 该模板**读出完整策略**需要的最少加注层数。
 *
 * ⚠️ 注意语义：不是「能走到那个节点所需的层数」，而是「读出来的菜单不残缺
 * 所需的层数」。两者对 `VS_3BET` **不一样**，而那个差别正是它被标未支持的原因。
 *
 * - `VS_FIRST_OPEN` / `VS_NAMED_OPEN` → **1**：只构造「有人开池」，
 *   3Bet 是**菜单里的选项**，不需要树里真的发生过。
 * - `VS_3BET` → **3**：走到它只要 2 次加注，但要读出完整的决策点
 *   （开池者手里得有 4Bet）必须有第 3 次。
 * - `VS_4BET` → **3**：需要真的发生过 4Bet。
 */
function requiredMaxRaises(template: GtoExtendedTemplate): number {
  switch (template) {
    case GtoExtendedTemplate.VS_FIRST_OPEN:
    case GtoExtendedTemplate.VS_NAMED_OPEN:
      return 1;
    case GtoExtendedTemplate.VS_3BET:
    case GtoExtendedTemplate.VS_4BET:
      return 3;
    default:
      return 1;
  }
}

/**
 * 一个桌型的扩展目录（含**无法表达**的组合及其具体原因）。
 *
 * 与 Phase 1 的目录一样：**不隐藏**不支持项，而是列出来并说明原因 ——
 * 「界面上看不到」与「我们明确知道它不支持」是两种不同的状态。
 */
export function extendedCatalogForTableSize(
  tableSize: GtoTableSize,
  effectiveStackBB = 100,
  openSizeBB = DEFAULT_OPEN_SIZE_BB,
  maxRaises = 2,
): GtoExtendedCatalogEntry[] {
  const order = gtoPositionsFor(tableSize);
  const entries: GtoExtendedCatalogEntry[] = [];

  for (const position of order) {
    const heroIndex = order.indexOf(position);
    for (const template of EXTENDED_TEMPLATES) {
      // `VS_NAMED_OPEN` 与 `VS_3BET` 都要为每个「对手位置」单独生成条目
      //（见下面的两个循环），因此这里跳过它们在「一位置一模板」这一层的生成。
      if (templateNeedsCounterparty(template)) continue;
      const id = `${tableSize}-${position}-${template}`;
      const labelZh = `${position} · ${GTO_EXTENDED_TEMPLATE_ZH[template]}`;
      const needed = requiredMaxRaises(template);

      if (template === GtoExtendedTemplate.VS_4BET) {
        entries.push({
          id,
          tableSize,
          heroPosition: position,
          template,
          labelZh,
          scenario: null,
          scenarioHash: '',
          unsupportedReason:
            `「面对 4Bet」需要动作树支持 ${needed} 次加注（开池 + 3Bet + 4Bet），` +
            `而本阶段的生产配置是 max_raises = ${maxRaises}。` +
            '树里根本没有这条路径 —— 因此标为未支持，不用相近场景顶替。' +
            `（把 max_raises 提到 ${needed} 并接受更长的求解时间后，本模板即可用。）`,
          openerPosition: null,
          requiredMaxRaises: needed,
        });
        continue;
      }

      const history = extendedActionHistoryFor(tableSize, position, template, openSizeBB);
      if (history === null) {
        entries.push({
          id,
          tableSize,
          heroPosition: position,
          template,
          openerPosition: null,
          labelZh,
          scenario: null,
          scenarioHash: '',
          unsupportedReason:
            position === order[0]
              ? `${position} 是 ${tableSize} 人桌的第一个行动位，前面没有任何人 —— 构造不出「面对某人」的场景。`
              : `${position} 前面没有足够的位置来构造「${GTO_EXTENDED_TEMPLATE_ZH[template]}」（${tableSize} 人桌的行动顺序是 ${order.join(' → ')}）。`,
          requiredMaxRaises: needed,
        } satisfies GtoExtendedCatalogEntry);
        continue;
      }

      const spec: GtoScenarioSpec = {
        kind: kindOfTemplate(template),
        tableSize,
        effectiveStackBB,
        heroPosition: position,
        villainPosition: null,
        actionHistory: history,
        openSizeBB,
      };
      const scenario = buildGtoScenario(spec);
      entries.push({
        id,
        tableSize,
        heroPosition: position,
        template,
        openerPosition: null,
        labelZh,
        scenario,
        scenarioHash: scenario === null ? '' : scenarioHashOf(scenario),
        unsupportedReason: scenario === null ? '场景构造失败（参数组合不合法）' : null,
        requiredMaxRaises: needed,
      } satisfies GtoExtendedCatalogEntry);
    }

    /*
     * 🔴 `VS_NAMED_OPEN` 要为**每一个可能的开池者**生成一个条目。
     *
     * 为什么不能像别的模板那样「一个位置一个条目」：这个模板的核心参数
     * 就是「谁开的池」。用户点名的场景是「BB vs **BTN** Open」
     * 与「BTN vs **CO** Open」—— 它们是**不同的节点**。
     * 给每个开池者一个独立条目，等于让「标签」与「数据」一一对应，
     * 不可能再出现「标签写 BTN、数据是 UTG」。
     */
    for (let openerIndex = 0; openerIndex < heroIndex; openerIndex++) {
      const opener = order[openerIndex]!;
      const id = `${tableSize}-${position}-${GtoExtendedTemplate.VS_NAMED_OPEN}-${opener}`;
      const labelZh = `${position} vs ${opener} 开池`;
      const history = extendedActionHistoryFor(
        tableSize,
        position,
        GtoExtendedTemplate.VS_NAMED_OPEN,
        openSizeBB,
        opener,
      );
      if (history === null) continue; // 该组合不成立（理论上不会发生）
      const scenario = buildGtoScenario({
        kind: GtoScenarioKind.VS_OPEN,
        tableSize,
        effectiveStackBB,
        heroPosition: position,
        villainPosition: opener,
        actionHistory: history,
        openSizeBB,
      });
      entries.push({
        id,
        tableSize,
        heroPosition: position,
        template: GtoExtendedTemplate.VS_NAMED_OPEN,
        openerPosition: opener,
        labelZh,
        scenario,
        scenarioHash: scenario === null ? '' : scenarioHashOf(scenario),
        unsupportedReason: scenario === null ? '场景构造失败（参数组合不合法）' : null,
        requiredMaxRaises: requiredMaxRaises(GtoExtendedTemplate.VS_NAMED_OPEN),
      } satisfies GtoExtendedCatalogEntry);
    }

    /*
     * 🔴 `VS_3BET` 要为**每一个能面对 3Bet 的位置 × 每一个 3Bettor** 生成条目。
     *
     * ## ⚠️ 条件一：Hero 必须是**第一个行动位**
     *
     * 这不是保守，而是实测结论：只要 Hero 前面还有「还没行动过」的座位，
     * 那个人就会在 Hero 之后回答这个 3Bet，于是收口人是他、不是 Hero。
     * 实测（6 人桌）：
     *
     * ```text
     * HJ 开池 → CO 3Bet → BTN 弃 → SB 弃 → BB 弃 → UTG 弃 → 牌局结束
     *                                     Hero(HJ) 再也没有轮到 ❌
     * ```
     *
     * 46 个组合里只有 17 个真的走到 Hero（4MAX/CO、5MAX/HJ、6MAX/UTG、
     * 8MAX/UTG、9MAX/UTG 的第一位开池者），见
     * `reports/evidence/gto-vs3bet-live-evidence.txt`。
     * 因此只对**第一个行动位**生成条目 —— 别的组合是**不存在**的节点，
     * 列出来只会制造「看起来能用」的入口。
     *
     * ## ⚠️ 条件二：条目仍然**不构造场景**
     *
     * 几何已经是对的，而且被真实求解器走到过。未支持的原因是
     * **读出来是残缺菜单**：`max_raises = 2` 时开池者手里没有 4Bet，
     * 实测菜单只有 `Fold · Call`。
     *
     * 那为什么不干脆构造出来给人看？因为一个「只能弃牌或跟注」的
     * 「面对 3Bet 策略」会被当成完整答案使用 —— 那正是本轮禁止的事。
     * 因此这里**仍然**把 `scenario` 留成 `null`，并把真实原因写进
     * `unsupportedReason`，让界面能显示「为什么没有」。
     */
    if (!canHeroFaceThreeBet(tableSize, position)) continue;
    for (const threeBettor of legalThreeBettorsFor(tableSize, position)) {
      const id = `${tableSize}-${position}-${GtoExtendedTemplate.VS_3BET}-${threeBettor}`;
      const labelZh = `${position} 开池 vs ${threeBettor} 3Bet`;
      entries.push({
        id,
        tableSize,
        heroPosition: position,
        template: GtoExtendedTemplate.VS_3BET,
        /*
         * 🔴 对手位置必须**真的存进条目**，即使这个条目恒为未支持。
         *
         * 否则 `buildExtendedScenario` 按「位置 + 模板 + 对手」查找时会
         * 找不到自己刚生成的那一条（条目字段是 `null`、查询给的是 `HJ`），
         * 于是返回「目录里没有 6-UTG-VS_3BET-HJ」——
         * 一个**看起来像参数拼错**的理由，而真实理由是「菜单残缺」。
         */
        openerPosition: threeBettor,
        labelZh,
        scenario: null,
        scenarioHash: '',
        unsupportedReason: VS_3BET_UNSUPPORTED_REASON,
        requiredMaxRaises: requiredMaxRaises(GtoExtendedTemplate.VS_3BET),
      } satisfies GtoExtendedCatalogEntry);
    }
  }
  return entries;
}

/** 全部桌型的扩展目录 */
export function extendedFullCatalog(
  tableSizes: readonly GtoTableSize[] = [4, 5, 6, 8, 9],
  effectiveStackBB = 100,
  maxRaises = 2,
): GtoExtendedCatalogEntry[] {
  return tableSizes.flatMap((s) => extendedCatalogForTableSize(s, effectiveStackBB, 2.5, maxRaises));
}

/** 只保留可查询的条目 */
export function extendedSupportedCatalog(
  tableSizes: readonly GtoTableSize[] = [4, 5, 6, 8, 9],
  effectiveStackBB = 100,
  maxRaises = 2,
): GtoExtendedCatalogEntry[] {
  return extendedFullCatalog(tableSizes, effectiveStackBB, maxRaises).filter(
    (e) => e.scenario !== null,
  );
}

/**
 * 按「Hero 位置 + 模板」精确构造一个场景（探针与界面用）。
 *
 * 返回 `null` 表示**本项目的场景模型表达不了它**，
 * 调用方应当把它记成明确的不支持，而不是换一个相近场景。
 */
export function buildExtendedScenario(input: {
  tableSize: GtoTableSize;
  heroPosition: GtoPosition;
  template: GtoExtendedTemplate;
  /** 对手位置（`VS_NAMED_OPEN` 是开池者；`VS_3BET` 是 3Bettor） */
  counterpartyPosition?: GtoPosition;
  effectiveStackBB?: number;
  openSizeBB?: number;
}): { scenario: GtoScenario } | { unsupportedReason: string } {
  const { tableSize, heroPosition, template } = input;
  const entries = extendedCatalogForTableSize(
    tableSize,
    input.effectiveStackBB ?? 100,
    input.openSizeBB ?? DEFAULT_OPEN_SIZE_BB,
  );
  /*
   * ⚠️ 「需要对手位置的模板」必须与生成端**用同一个判断**。
   * 上一版在这里硬写了 `template !== VS_NAMED_OPEN`，于是新增模板时
   * 查找会把**第一个**同模板条目当成命中项 —— 又是一个
   * 「同一份约束写在两处、只改了一处」。现在它是一个具名谓词。
   */
  const wantsCounterparty = templateNeedsCounterparty(template);
  const entry = entries.find(
    (e) =>
      e.heroPosition === heroPosition &&
      e.template === template &&
      (!wantsCounterparty || e.openerPosition === (input.counterpartyPosition ?? null)),
  );
  if (entry === undefined) {
    /*
     * `VS_3BET` 的位置约束必须在**找不到条目**时说出来。
     *
     * 否则调用方（界面 / 探针）拿到的是一句
     * 「目录里没有 6-UTG-VS_3BET-HJ」—— 看起来像拼错了参数，
     * 实际上是**这个节点走不到 Hero**（实测：收口人是别人）。
     * 一个正确的否定必须以**正确的理由**呈现。
     */
    const positionIsWrong =
      template === GtoExtendedTemplate.VS_3BET &&
      !canHeroFaceThreeBet(tableSize, heroPosition);
    return {
      unsupportedReason: positionIsWrong
        ? `${heroPosition} 在 ${tableSize} 人桌上不是第一个行动位 —— ` +
          '「开池后面对 3Bet」只有在**没人欠着动作**时才回到 Hero 手上；' +
          '只要前面还有没行动过的座位，收口人就是那个人。'
        : wantsCounterparty && input.counterpartyPosition === undefined
          ? `「${GTO_EXTENDED_TEMPLATE_ZH[template]}」必须给出对手位置（counterpartyPosition）—— ` +
            '不给就用第一个候选顶替，正是本模块修掉的缺陷。'
          : `目录里没有 ${tableSize}-${heroPosition}-${template}` +
            (input.counterpartyPosition === undefined ? '' : `-${input.counterpartyPosition}`),
    };
  }
  if (entry.scenario === null) {
    return { unsupportedReason: entry.unsupportedReason ?? '无法表达' };
  }
  return { scenario: entry.scenario };
}

/** 自检 */
export function selfCheckExtendedCatalog(): string[] {
  const problems: string[] = [];
  const all = extendedFullCatalog();
  const ids = new Set<string>();
  for (const e of all) {
    if (ids.has(e.id)) problems.push(`扩展目录 id 重复：${e.id}`);
    ids.add(e.id);
    if (e.scenario !== null && scenarioHashOf(e.scenario) !== e.scenarioHash) {
      problems.push(`扩展目录 ${e.id} 的哈希与场景不一致`);
    }
    if (e.scenario === null && (e.unsupportedReason ?? '').length < 10) {
      problems.push(`扩展目录 ${e.id} 的不支持原因过于简略`);
    }
  }

  /*
   * 🔴 最关键的一条自检：**标签与数据必须一致**。
   *
   * `VS_NAMED_OPEN` 的标签写着「vs X 开池」，那么场景的
   * `actionHistory` 里第一个加注的人**必须**是 X。
   * 本模块的第一版就是在这里错的（标签 BTN、数据 UTG），
   * 因此把这条不变量写进启动自检，而不是只写在测试里。
   *
   * ⚠️ 这条自检**只覆盖有场景的条目** —— `VS_3BET` 的条目恒为 `null`
   *（原因见 `VS_3BET_UNSUPPORTED_REASON`），因此它走不到这里。
   * 它的几何由下面那条独立的「可构造性」自检验证。
   */
  for (const e of all) {
    if (e.template !== GtoExtendedTemplate.VS_NAMED_OPEN || e.scenario === null) continue;
    const opener = e.scenario.actionHistory.find((a) => a.kind === GtoActionKind.RAISE);
    if (opener === undefined) {
      problems.push(`${e.id} 的标签说「${e.openerPosition} 开池」，但历史里没有任何加注`);
    } else if (opener.position !== e.openerPosition) {
      problems.push(
        `${e.id} 标签与数据不一致：标签说开池者是 ${e.openerPosition}，实际是 ${opener.position}`,
      );
    }
    if (e.scenario.villainPosition !== e.openerPosition) {
      problems.push(`${e.id} 的 villainPosition（${e.scenario.villainPosition}）与开池者不一致`);
    }
  }

  /*
   * 🔴 `VS_3BET` 的**几何自检** —— 它必须在**每一档**桌型上都能被构造出来。
   *
   * 这是本轮代价最大的一条结论的守卫：几何写错时不会抛异常，
   * 只会让 `buildGtoScenario` 返回 `null`，而 `null` 被上层报成
   * 「参数组合不合法」—— 一个**看不见的**缺陷。
   *（真的发生过：`THREE_BET` 的 85 个条目全部悄悄变成「不支持」。）
   *
   * 因此这里**跳过目录**，直接按几何构造一遍并要求成功，再逐条核对：
   *
   * 1. Hero 是**第一个行动位**（否则他不是收口人，见 `canHeroFaceThreeBet`）；
   * 2. Hero 是**开池者**（历史里第一个加注的人）；
   * 3. 3Bettor **在 Hero 之后**加注（第二次加注）；
   * 4. `heroAlreadyActed` 为真（Hero 已经出过手）。
   */
  for (const size of [4, 5, 6, 8, 9] as const) {
    for (const heroPosition of gtoPositionsFor(size)) {
      /*
       * ⚠️ 只对**能面对 3Bet** 的位置做构造性自检。
       * 别的位置不是「构造失败」，而是**本来就不该被构造** ——
       * 把它们也拿来构造会把一条正确的否定判成缺陷。
       */
      if (!canHeroFaceThreeBet(size, heroPosition)) continue;
      const threeBettors = legalThreeBettorsFor(size, heroPosition);
      if (threeBettors.length === 0) continue; // 该位置后面没有合法的 3Bettor
      for (const threeBettor of threeBettors) {
        const history = extendedActionHistoryFor(
          size,
          heroPosition,
          GtoExtendedTemplate.VS_3BET,
          DEFAULT_OPEN_SIZE_BB,
          threeBettor,
        );
        if (history === null) {
          problems.push(`VS_3BET 几何构造失败：${size}MAX ${heroPosition} vs ${threeBettor} 3Bet`);
          continue;
        }
        const scenario = buildGtoScenario({
          kind: GtoScenarioKind.VS_3BET,
          tableSize: size,
          effectiveStackBB: 100,
          heroPosition,
          villainPosition: threeBettor,
          actionHistory: history,
          openSizeBB: DEFAULT_OPEN_SIZE_BB,
        });
        if (scenario === null) {
          problems.push(
            `VS_3BET 场景被 buildGtoScenario 拒绝：${size}MAX ${heroPosition} vs ${threeBettor} 3Bet`,
          );
          continue;
        }
        const raises = scenario.actionHistory.filter((a) => a.kind === GtoActionKind.RAISE);
        const opener = raises[0];
        const lastRaiser = raises[raises.length - 1];
        if (opener === undefined || opener.position !== heroPosition) {
          problems.push(
            `${size}MAX ${heroPosition} vs ${threeBettor} 3Bet：开池者是 ${opener?.position ?? '（无）'}，` +
              `应当是 Hero（${heroPosition}）`,
          );
        }
        if (lastRaiser === undefined || lastRaiser.position !== threeBettor) {
          problems.push(
            `${size}MAX ${heroPosition} vs ${threeBettor} 3Bet：最后加注者是 ` +
              `${lastRaiser?.position ?? '（无）'}，应当是 ${threeBettor}`,
          );
        }
        if (!scenario.heroAlreadyActed) {
          problems.push(
            `${size}MAX ${heroPosition} vs ${threeBettor} 3Bet：heroAlreadyActed 应为 true`,
          );
        }
      }
    }
  }

  // 桌人数隔离：同名位置 + 同模板在不同桌型上必须不同哈希
  for (const template of [
    GtoExtendedTemplate.VS_FIRST_OPEN,
    GtoExtendedTemplate.VS_NAMED_OPEN,
  ] as const) {
    for (const position of ['CO', 'BTN', 'SB', 'BB'] as const) {
      const hashes = new Set<string>();
      let count = 0;
      for (const size of [4, 5, 6, 8, 9] as const) {
        const e = all.find(
          (x) => x.tableSize === size && x.heroPosition === position && x.template === template,
        );
        if (e === undefined || e.scenario === null) continue;
        count += 1;
        hashes.add(e.scenarioHash);
      }
      if (count >= 2 && hashes.size !== count) {
        problems.push(`扩展目录桌人数隔离失败：${position}/${template}`);
      }
    }
  }

  /*
   * 同名位置 + 同名开池者，在不同桌型上也必须是不同的节点。
   * 例：6MAX 的「BTN vs CO 开池」与 9MAX 的「BTN vs CO 开池」——
   * 两者的行动历史完全不同（9MAX 前面还有 UTG/UTG1/UTG2/LJ 要弃牌）。
   */
  for (const position of ['BTN', 'SB', 'BB'] as const) {
    const hashes = new Set<string>();
    let count = 0;
    for (const size of [4, 5, 6, 8, 9] as const) {
      const e = all.find(
        (x) =>
          x.tableSize === size &&
          x.heroPosition === position &&
          x.template === GtoExtendedTemplate.VS_NAMED_OPEN &&
          x.openerPosition === 'CO',
      );
      if (e === undefined || e.scenario === null) continue;
      count += 1;
      hashes.add(e.scenarioHash);
    }
    if (count >= 2 && hashes.size !== count) {
      problems.push(`扩展目录「${position} vs CO 开池」跨桌型隔离失败`);
    }
  }

  // `VS_3BET` / `VS_4BET` 必须**全部**标为不支持，且各自给出**具体**原因
  for (const e of all) {
    if (e.template !== GtoExtendedTemplate.VS_3BET && e.template !== GtoExtendedTemplate.VS_4BET) {
      continue;
    }
    if (e.scenario !== null) {
      problems.push(`${e.id} 不应被构造出场景（本阶段无对应结构）`);
      continue;
    }
    if (e.requiredMaxRaises <= 2) {
      problems.push(`${e.id} 的 requiredMaxRaises 应为 3 以上，实际 ${e.requiredMaxRaises}`);
    }
  }

  /*
   * 🔴 `THREE_BET`（Hero 自己做 3Bet）**不允许**出现在目录里。
   *
   * 它不是一个可达节点（见文件头与 `VS_3BET_UNSUPPORTED_REASON`）。
   * 如果它出现在目录里，界面就会给出一个「Hero 3Bet 范围」的入口，
   * 而点进去拿到的是**别人的**策略。
   */
  for (const e of all) {
    if ((e.template as string) === 'THREE_BET') {
      problems.push(`${e.id}：「Hero 自己做 3Bet」不是可达节点，不得出现在目录里`);
    }
  }

  // `VS_FIRST_OPEN` 的开池者必须是该桌型的第一个行动位
  for (const size of [4, 5, 6, 8, 9] as const) {
    const first = gtoPositionsFor(size)[0]!;
    for (const e of all) {
      if (e.tableSize !== size || e.template !== GtoExtendedTemplate.VS_FIRST_OPEN) continue;
      if (e.scenario === null) continue;
      const opener = e.scenario.actionHistory.find((a) => a.kind === GtoActionKind.RAISE);
      if (opener === undefined || opener.position !== first) {
        problems.push(`${e.id} 的开池者应为 ${first}，实际 ${opener?.position ?? '无'}`);
      }
    }
  }
  return problems;
}
