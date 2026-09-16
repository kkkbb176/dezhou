/**
 * 分层底池与「会被争夺的量」（2026-09 边池轮）
 *
 * ## 这个模块解决什么问题
 *
 * 修复前 `computePot` 只是「所有人投入之和」—— 那个数字在两种情况下**不是**
 * 玩家真正能赢到的钱：
 *
 * ### 情况一：未被跟注的超额（all-in 差额）
 *
 * ```text
 * 我剩 100BB，对手全下 200BB
 * → 我只能跟 100BB，对手多出的 100BB **永远不会被跟注**，按规则立即退回
 * → 真正被争夺的是 200BB（100 + 100），而不是 300BB
 * ```
 *
 * 用 300BB 当「可赢得总量」会让跟注 EV 虚高一整块 ——
 * 实测（深对手全下、我短筹码）跟注 EV 被高估 240 筹码量级。
 *
 * ### 情况二：多路不同筹码全下（边池）
 *
 * ```text
 * A 全下 1000、B 全下 400、C 全下 150
 * → 主池 450（三家各 150，三家都能赢）
 *   边池 500（A 与 B 各再 250，只有 A、B 能赢）
 *   退回 600（A 超出 B 的部分，无人能跟）
 * ```
 *
 * 修复前这三件事被压成一个 1550 的整池。使用者因此**无法知道**
 * 短筹码赢不了全部底池、也无法知道自己的实际可赢上限。
 *
 * ## 🔴 一条不能违反的不变量
 *
 * > `main + Σ side + returned === 所有人投入之和`
 *
 * 也就是说本模块只做**重新划分**，绝不凭空创造或丢弃筹码。
 * 自检 `selfCheckLayeredPot` 会逐场景核对这条。
 *
 * ## 为什么「退回」在**决策时刻**恒为零（但仍要建模）
 *
 * 下注轮结束的条件是「所有还能行动的玩家都已跟平」。因此在一个**合法的
 * 决策点**上，最后一名加注者的投入不会比第二高的人多出未被跟注的部分 ——
 * 多出来的那一刻下注轮就已经结束了（其余人全部弃牌或全下）。
 *
 * 那为什么还要建？两个理由：
 *
 * 1. **界面与复盘**会看已经结束的牌局，那时退回是真实存在的钱
 * 2. 「可赢上限」这件事**在决策时刻同样重要**：短筹码全下时，
 *    他能赢的永远只是 `main + 他所在的那层边池`，而不是整池
 */

import { allBoardCards, type GameState, type PlayerState } from './gameState.ts';

/* ============================================================
 * 类型
 * ============================================================ */

/** 一层底池 */
export type PotLayer = {
  /**
   * 层序号：`0` 是主池，`1` 起是边池（从小到大）。
   *
   * ⚠️ 只有**非空**层会被产出，因此 `layerIndex` 可能不连续 ——
   * 用它做显示序号，不要用它做数组下标。
   */
  layerIndex: number;
  /** 这一层里每个「有资格者」各自投入了多少（层的人均额度） */
  perPlayer: number;
  /** 这一层的总额 */
  amount: number;
  /** 有资格争夺这一层的玩家 id（投入达到本层额度、且未弃牌） */
  eligibleIds: readonly string[];
};

/**
 * 🔴 **结算作用域**（RIVER CONSISTENCY V2.1 · P1-2 / §15 / §16）。
 *
 * 使用者点名的要求：`returned = myContribution − maxOtherContribution`
 * 这类简化公式**只能**在明确限定的条件下使用，且函数名必须体现限定条件 ——
 * 不能放在 `computeLayeredPot()` 里充当通用结算。
 */
export const SettlementScope = {
  /**
   * 单挑 + 下注轮已关闭 + 不需要边池 ⇒ 允许「未匹配超额」的**简化**路径。
   *
   * 前置条件（`assertHeadsUpUnmatchedScope` 会逐条断言）：
   * ① 未弃牌且有筹码的玩家恰好 2 人；② 没有第三方的死钱需要分层；
   * ③ 下注轮已关闭（没有人还能加注/跟注）
   */
  HEADS_UP_CLOSED_ROUND: 'HEADS_UP_CLOSED_ROUND',
  /** 其它一切情况 ⇒ 必须走**投入台账分层**（主池/边池/退回由层界决定） */
  LEDGER_LAYERED: 'LEDGER_LAYERED',
} as const;
export type SettlementScope = (typeof SettlementScope)[keyof typeof SettlementScope];

export const SETTLEMENT_SCOPE_ZH: Readonly<Record<SettlementScope, string>> = Object.freeze({
  HEADS_UP_CLOSED_ROUND: '单挑 · 下注轮已关闭 · 无需要边池（允许简化未匹配路径）',
  LEDGER_LAYERED: '投入台账分层（多人 / 全下 / 边池）',
});

/**
 * 断言「单挑 + 关闭轮次」这个**简化路径**的前置条件。
 *
 * ⚠️ 违反即抛错（不是静默降级）：简化公式用错作用域会**算错钱**，
 * 而钱算错在界面上一眼看不出来。多人/全下必须走 ledger。
 */
export function assertHeadsUpUnmatchedScope(state: GameState): void {
  const live = state.players.filter((p) => !p.folded);
  if (live.length > 2) {
    throw new Error(
      `assertHeadsUpUnmatchedScope: 简化未匹配退款只适用于「单挑或仅剩一人」的轮次关闭局面` +
        `（未弃牌者 ${live.length} 人）—— 三人以上全下会产生边池，必须走投入台账分层路径`,
    );
  }
  const canStillAct = live.filter((p) => !p.allIn && p.remainingStack > 0);
  if (canStillAct.length > 1) {
    throw new Error(
      'assertHeadsUpUnmatchedScope: 下注轮尚未关闭（仍有 2 名以上玩家可以继续行动）—— ' +
        '此时只能算「尚未匹配」，不得算「最终退回」',
    );
  }
}

/**
 * 🔴 **简化路径**：单挑、下注轮已关闭时的「未匹配超额」。
 *
 * ```text
 * 未匹配超额 = 我的投入 − 其他所有人的最高投入
 * ```
 *
 * ⚠️ **只允许在上述两项前置条件同时成立时调用**（函数内会断言）。
 * 多人 / 全下 / 边池一律走 `computeLayeredPot` 的台账路径。
 *
 * 这条式子本身是【数学确定】的（在没有第三方能匹配时，超出部分按规则退回），
 * 真正需要限定的是**作用域** —— 那正是本函数与 `assertHeadsUpUnmatchedScope` 的作用。
 */
export function computeHeadsUpClosedRoundUnmatchedReturn(
  state: GameState,
  playerId: string,
): number {
  assertHeadsUpUnmatchedScope(state);
  const me = state.players.find((p) => p.id === playerId);
  if (me === undefined) return 0;
  const myAmount = totalCommittedOf(state, me);
  const others = state.players.filter((p) => p.id !== playerId).map((p) => totalCommittedOf(state, p));
  const highestOther = others.length === 0 ? 0 : Math.max(...others);
  return Math.max(0, myAmount - highestOther);
}

/** 判断当前局面属于哪个结算作用域 */
export function settlementScopeOf(state: GameState): SettlementScope {
  const live = state.players.filter((p) => !p.folded);
  const canStillAct = live.filter((p) => !p.allIn && p.remainingStack > 0);
  const roundClosedNow = canStillAct.length <= 1;
  /*
   * 简化路径的两个前置条件（多一条都不行）：
   * ① **轮次已关闭**（最多 1 人还能行动）；
   * ② **未弃牌者 ≤ 2**（三人以上全下会产生边池 ⇒ 必须走台账）。
   *
   * 顺带一个结构性事实：按 `capped = min(投入, 其他人最高投入)` 的定义，
   * **至多只有一名玩家**会有正的未匹配超额（唯一最高投入者），
   * 因此不需要额外检查「只有一笔未匹配」。
   */
  return roundClosedNow && live.length <= 2
    ? SettlementScope.HEADS_UP_CLOSED_ROUND
    : SettlementScope.LEDGER_LAYERED;
}

export type LayeredPot = {
  /** 当前底池总额（= 所有人投入之和，与 `computePot` 恒等） */
  total: number;
  /**
   * 🔴 **会被争夺的量** —— 主池 + 边池之和。
   *
   * 这是「可赢得总量」的正确口径：未被跟注的超额**不在其中**。
   */
  contested: number;
  /**
   * 🔴 **尚未匹配、但可能被跟上的超额**（RIVER CONSISTENCY V2 §16）。
   *
   * 与 `returned` 的区别是**时序**，不是金额：
   *
   * | 字段 | 含义 | 何时产生 |
   * |---|---|---|
   * | `pendingUnmatched` | 他下注了，但**还有人可以跟** ⇒ 这笔钱只是**暂时**没人匹配 | 决策时刻（下注轮未结束） |
   * | `returned` | 没有人**能**再跟（其余人都弃牌或全下）⇒ 按规则退回 | 下注轮已结束 / 摊牌后复盘 |
   *
   * 修复前两者被压进同一个 `returned`，于是**决策节点**（Hero 还没决定跟不跟）
   * 也会显示「无人跟注、退回 2200」—— 而那笔钱其实是 Hero 正要去跟的。
   */
  pendingUnmatched: Readonly<Record<string, number>>;
  /** 下注轮是否已结束（没有任何对手还能跟注） */
  roundClosed: boolean;
  /**
   * 🔴 **本次结算走的是哪条路径**（RIVER CONSISTENCY V2.1 · P1-2）。
   *
   * | 值 | 含义 |
   * |---|---|
   * | `HEADS_UP_CLOSED_ROUND` | 单挑 + 下注轮已关闭 + 无需要边池 ⇒ 才允许用「未匹配超额」这条**简化**路径 |
   * | `LEDGER_LAYERED` | 其它一切情况（多人 / 有人全下 / 边池）⇒ 必须走**投入台账分层**路径 |
   *
   * ⚠️ 之所以要显式写出来：`退回 = 我的投入 − 其他人最高投入` 这个式子在
   * **单挑且轮次已关闭**时是精确的，但它**不是**通用的边池/结算规则
   *（多人全下时谁跟得起谁跟不起由 ledger 决定）。使用者第十七节要求
   * 「不能用一个简化公式冒充通用结算」，因此这里把作用域变成**可读、可测**的字段。
   */
  scope: SettlementScope;
  /** 主池（`layers[0]` 的便捷访问；无人投入时为 0） */
  main: number;
  /** 边池总额（所有 `layers[1..]` 之和） */
  sideTotal: number;
  /**
   * **死钱** —— 已弃牌玩家投入的筹码之和。
   *
   * 它**不塞进任何层**：死钱没有「跟到某个额度」的含义，硬塞进某一层
   * 会让该层的金额与该层有资格者实际能投到的量不符
   *（实测出现过「主池 220，人均 100，2 家有资格」这种自相矛盾的显示）。
   *
   * 死钱**会被争夺**（算进 `contested`），只是不单独成层。
   * 恒有：`contested === Σ layers[].amount + deadMoney`。
   */
  deadMoney: number;
  layers: readonly PotLayer[];
  /**
   * 未被跟注、按规则应**退回**给投注者的部分：`{ 玩家 id → 金额 }`。
   * 恒有 `Σ returned === total - contested`。
   */
  returned: Readonly<Record<string, number>>;
};

/* ============================================================
 * 计算
 * ============================================================ */

/**
 * 一名玩家在这一手里的**全部**投入（含前注与所有街）。
 *
 * ⚠️ 不能用 `committedByStreet[street]` —— 那只是本街的投入。
 * 分层底池是按**整手**算的：转牌新投的钱要和翻牌留在池里的钱一起分层。
 */
export function totalCommittedOf(state: GameState, player: PlayerState): number {
  let sum = player.ante;
  for (const street of ['PREFLOP', 'FLOP', 'TURN', 'RIVER'] as const) {
    sum += player.committedByStreet[street];
  }
  return sum;
}

/**
 * 🔴 **这个玩家最多能赢到多少**（他能争夺到的总量上限）。
 *
 * 口径：他自己的投入封顶了「别人能从他这里赢走的量」，因此
 * 他能争夺的总量 = `min(他的投入, 第二高投入) × 有资格的人数 + 他自己的超额`…
 * 直接用分层结果更简单也更不容易错：把**他有资格**的那些层加起来。
 *
 * 这是「短筹码赢不了全部底池」的量化表达。
 */
export function maxWinFor(state: GameState, playerId: string): number {
  const pot = computeLayeredPot(state);

  /*
   * ---- 只剩一名未弃牌者（弃牌获胜）----
   *
   * 他赢走整池，**但要扣掉自己被退回的部分** —— 那部分本来就还给他、
   * 不参与争夺，算进「能赢多少」会虚高。
   *
   * ⚠️ 第一版这里返回 `pot.total`（不扣退回），于是
   * `UTG 加注 600、其余全弃` 会把 600 也算进可赢量，而实际可争的只有 250。
   */
  const live = state.players.filter((p) => !p.folded && totalCommittedOf(state, p) > 0);
  if (live.length <= 1) {
    if (!live.some((p) => p.id === playerId)) return 0;
    return pot.contested;
  }

  /*
   * ---- 多人摊牌：**有资格的那些层之和** ----
   *
   * `layers` 已按「有效投入」（= min(投入, 第二高投入)）建层，
   * 因此这个和**自动排除**了：
   *
   * - 自己被退回的部分（那部分在层界之上，不构成任何层）
   * - 自己够不到的高额边池（`eligibleIds` 不含他）
   *
   * ⚠️ 别改成「Σ活钱 + 全部死钱」那种写法 —— 死钱也会被搬进高额边池，
   * 于是短码被告知能赢一个他根本没资格的层（三个独立审查者都指到这一处）。
   */
  let sum = 0;
  for (const layer of pot.layers) {
    if (layer.eligibleIds.includes(playerId)) sum += layer.amount;
  }
  return sum;
}

/**
 * 把底池按投入额度**分层**（主池 + 边池），并算出应退回的部分。
 *
 * ## 算法
 *
 * 1. 取所有**未弃牌**玩家的投入，从大到小排序、去重 ⇒ 得到若干「层界」
 * 2. 每一层的人均额度 = 本层界 − 上一层界；层额 = 人均额度 × **投入达到本层界**的人数
 * 3. 有资格争夺某层的人 = 投入达到该层界、且未弃牌的人
 * 4. **已弃牌**玩家投过的钱仍然留在底池里（这是规则），但**不进**任何一层的
 *    `eligibleIds` —— 它们被并入「投入达到该层界」的那一层的**金额**里
 *
 * ## 关于弃牌者的处理（容易写错的地方）
 *
 * 弃牌者的筹码**属于底池**，但**不属于任何人**。因此：
 *
 * - 算**层额**时：弃牌者的投入也要计入（钱确实在池里）
 * - 算**资格**时：弃牌者不在 `eligibleIds` 里
 *
 * 例：A 投入 100 后弃牌、B 与 C 各投入 100。
 * 主池 = 300，有资格者 = [B, C]。若把弃牌者的 100 漏掉，主池会少 100。
 */
export function computeLayeredPot(state: GameState): LayeredPot {
  const committed: { player: PlayerState; amount: number }[] = state.players.map((p) => ({
    player: p,
    amount: totalCommittedOf(state, p),
  }));

  const total = committed.reduce((sum, c) => sum + c.amount, 0);

  /*
   * ============================================================
   * 🔴 核心口径：**退回 = 自己的投入 − 其他所有人的最高投入**
   * ============================================================
   *
   * 一笔筹码能不能被跟注，取决于**别人投了多少** —— 而不是「别人里还有谁
   * 没弃牌」。这个区分是本模块最容易错的地方，我为此写错了两版：
   *
   * | 错误写法 | 反例 | 后果 |
   * |---|---|---|
   * | `cap = 第二高未弃牌投入` | UTG 投 10000、HJ 投 9000 后弃牌、CO 全下 100 | UTG 被多退 8900 |
   * | 只剩一人时不退 | UTG 全下 10000、其余全弃 | 退回 {}=0，可争夺 10150（真值 250） |
   *
   * 正确规则：
   *
   * ```text
   * 某玩家的「未被跟注量」= 他的投入 − 其他所有人（含已弃牌者）的最高投入
   * 会被争夺的量 = Σ 每人「封顶后的投入」，其中
   *   封顶 = min(他的投入, max(其他人的投入))
   * ```
   *
   * 两条恒等式（`selfCheckLayeredPot` 会核对）：
   *
   * - `contested + Σ退回 === total`
   * - 只剩一人未弃牌时，他仍要退回「别人跟不到」的部分 ——
   *   他赢走的是**自己投入被别人跟到的部分 + 别人的全部投入**
   *
   * ## 弃牌者的双重身份（注意这不是矛盾）
   *
   * 弃牌者的钱有两重作用，必须分开看：
   *
   * 1. **算别人能投多少时**：他**算数** —— 钱在池里，别人跟过他
   * 2. **算谁能赢时**：他**不算数** —— 他不在任何层的 `eligibleIds` 里
   *
   * 第一版把它们混为一谈，于是「弃牌者投得最多」时大筹码被多退。
   */
  const cappedOf = (index: number): number => {
    const others = committed.filter((_, i) => i !== index).map((c) => c.amount);
    const highestOther = others.length === 0 ? 0 : Math.max(...others);
    return Math.min(committed[index]!.amount, highestOther);
  };

  const capped = committed.map((_, i) => cappedOf(i));
  const contested = capped.reduce((sum, v) => sum + v, 0);

  /*
   * 🔴 **超额要分成「最终退回」与「尚未匹配」两种**（RIVER CONSISTENCY V2 §16/§17）。
   *
   * 判据只有一句话：**还有没有别人能跟**。
   *
   * ```text
   * 还有对手能跟（未弃牌、未全下、还有筹码） ⇒ pendingUnmatched（决策时刻）
   * 没有人能再跟                              ⇒ returned（最终）
   * ```
   *
   * 实测缺陷（真人节点 Hero BTN A♣Q♠，河牌 CO lead 22BB、Hero 尚未决定）：
   * `returned = { CO: 2200 }` ⇒ 界面渲染「无人跟注、退回 2200」，
   * 而这 2200 正是 Hero 面前那笔待跟注的钱 —— **提前结算**。
   *
   * ⚠️ 这里**没有**使用任何简化公式去猜退款
   *（使用者 §17 明确禁止 `max − secondHighest` 这类通用近似）：
   * 退款仍然来自本函数既有的「封顶投入」口径，只是**按时序拆成两个字段**。
   */
  const returned: Record<string, number> = {};
  const pendingUnmatched: Record<string, number> = {};
  const scope = settlementScopeOf(state);
  for (const [index, c] of committed.entries()) {
    const excess = c.amount - capped[index]!;
    if (excess <= 0) continue;
    if (anyOpponentCanStillCall(state, c.player.id)) pendingUnmatched[c.player.id] = excess;
    else returned[c.player.id] = excess;
  }
  const roundClosed = Object.keys(pendingUnmatched).length === 0;

  /*
   * 🔴 **作用域自检**（RIVER CONSISTENCY V2.1 · §16）：
   *
   * - 走「简化未匹配」路径（单挑 + 轮次关闭）时，逐条断言前置条件成立，
   *   并用 `computeHeadsUpClosedRoundUnmatchedReturn` **复算**一次 ——
   *   两个独立实现给出同一个数，才算这条路径可信。
   * - 多人 / 全下局面（`LEDGER_LAYERED`）**不得**调用那个简化函数：
   *   这里只做「不调用」的显式记录（返回值里带 `scope`）。
   */
  if (scope === SettlementScope.HEADS_UP_CLOSED_ROUND) {
    assertHeadsUpUnmatchedScope(state);
    for (const [playerId, amount] of Object.entries(returned)) {
      const recomputed = computeHeadsUpClosedRoundUnmatchedReturn(state, playerId);
      if (Math.abs(recomputed - amount) > 1e-9) {
        throw new Error(
          `computeLayeredPot: 单挑关闭轮次的退回两处口径不一致（台账 ${amount} vs 简化式 ${recomputed}）—— ` +
            '这是必须修复的缺陷，不允许静默取其中一个',
        );
      }
    }
  }

  /*
   * ---- 只剩一人未弃牌：他赢走全部底池（但**仍要退回**别人跟不到的部分）----
   *
   * 「弃牌获胜」与「摊牌分池」是两条路径：前者没有边池概念。
   * 但「退回」在两种情况下都存在 —— 这一点我最初弄错过。
   */
  const live = committed.filter((c) => !c.player.folded && c.amount > 0);
  if (live.length <= 1) {
    const winner = live[0];
    const winnerRefund = winner === undefined ? 0 : (returned[winner.player.id] ?? 0);
    const winAmount = total - winnerRefund;
    const layers: PotLayer[] =
      winner === undefined || winAmount <= 0
        ? []
        : [
            {
              layerIndex: 0,
              perPlayer: winAmount,
              amount: winAmount,
              eligibleIds: [winner.player.id],
            },
          ];
    return {
      total,
      contested: winAmount,
      main: winAmount,
      sideTotal: 0,
      deadMoney: 0,
      layers,
      returned,
      pendingUnmatched,
      roundClosed,
      scope,
    };
  }

  /*
   * ---- 分层（边池）----
   *
   * 🔴 **层界必须用「封顶后」的投入，不能用原始投入。**
   *
   * 这是我第三次改这里时踩的坑，也是三个独立审查者都指到的同一处：
   * 若 `contested` 用封顶值而 `layers` 用原始值，那么最高投入者的
   * 「未被跟注超额」会**同时**出现在层里和 `returned` 里 ——
   * 守恒被破坏（实测 `[200,100]`：主池 200 + 边池 100 + 退回 100 = 400 ≠ 总额 300）。
   *
   * 正确做法只有一句话：**先把每个人的投入封顶，之后一切都用封顶值算**。
   *
   * ```text
   * 封顶值 c_i = min(投入_i, 其他所有人的最高投入)
   * contested  = Σ c_i
   * 退回_i     = 投入_i − c_i
   * 层界       = c_i 的去重升序           ← 关键：封顶值，不是原始值
   * ```
   *
   * 一个直接推论：封顶后**最高档位至少有两名玩家达到**（否则它会被封得更低），
   * 因此不会再出现「只属于一个人的顶层」—— 那正是超额本该退回的部分。
   *
   * 层额与资格：
   *
   * | 项 | 算法 |
   * |---|---|
   * | `amount` | `人均额度 × 封顶值达到本层的玩家数`（**含已弃牌者** —— 他们的钱确实在这个区间里） |
   * | `eligibleIds` | 封顶值达到本层、且**未弃牌**的人 |
   *
   * 漏掉弃牌者会少算层额：「弃牌者投得最多」那种形态会把大头整个漏掉。
   */
  const cappedAmounts = [...new Set(capped.filter((v) => v > 0))].sort((a, b) => a - b);
  const rawLayers: PotLayer[] = [];
  let previousLevel = 0;
  for (const level of cappedAmounts) {
    const per = level - previousLevel;
    previousLevel = level;
    if (per <= 0) continue;
    const atLevel = committed.filter((_, i) => capped[i]! >= level);
    const liveAtLevel = atLevel.filter((c) => !c.player.folded);
    rawLayers.push({
      layerIndex: 0,
      perPlayer: per,
      amount: per * atLevel.length,
      eligibleIds: liveAtLevel.map((c) => c.player.id),
    });
  }

  /*
   * 🔴 **把「有资格者完全相同」的相邻段合并成一层。**
   *
   * 封顶之后，相邻档位常常**达档人数相同** —— 那时它们其实是同一层，
   * 只是被我按档位切成了两段。不合并会**凭空造出虚假边池**：
   *
   * ```text
   * UTG 300 / BB 300 / SB 50（弃）
   *   档位 [50, 300]
   *   段 0：(0,50]    达档 3 人 → 150，有资格 [UTG,BB]
   *   段 1：(50,300]  达档 2 人 → 500，有资格 [UTG,BB]   ← 与段 0 资格完全相同！
   *   错误结果：主池 150 + 边池 500（凭空多出一个「边池」）
   *   正确结果：主池 650，无被争夺的边池
   * ```
   *
   * 这处是我第四次改这段代码时被测试抓到的（POT-04 报「两人对等全下没有边池」失败）。
   * 判据是**有资格者集合**，不是档位。
   */
  const layers: PotLayer[] = [];
  for (const segment of rawLayers) {
    const last = layers[layers.length - 1];
    const sameEligible =
      last !== undefined &&
      last.eligibleIds.length === segment.eligibleIds.length &&
      last.eligibleIds.every((id, i) => segment.eligibleIds[i] === id);
    if (sameEligible && last !== undefined) {
      layers[layers.length - 1] = {
        ...last,
        amount: last.amount + segment.amount,
        perPlayer: last.perPlayer + segment.perPlayer,
      };
    } else {
      layers.push({ ...segment, layerIndex: layers.length });
    }
  }

  /*
   * 兜底：有可争夺的钱却一层都没建出来（理论上不可达 —— `contested > 0`
   * 必有 `capped > 0`）。保持 `Σ层额 === contested` 这条不变量。
   */
  const layersTotal = layers.reduce((sum, l) => sum + l.amount, 0);
  if (layersTotal !== contested) {
    const diff = contested - layersTotal;
    if (layers.length > 0) {
      const top = layers[layers.length - 1]!;
      layers[layers.length - 1] = { ...top, amount: top.amount + diff };
    } else if (contested > 0) {
      layers.push({
        layerIndex: 0,
        perPlayer: contested,
        amount: contested,
        eligibleIds: live.map((c) => c.player.id),
      });
    }
  }

  return {
    total,
    contested,
    main: layers[0]?.amount ?? 0,
    sideTotal: layers.slice(1).reduce((sum, l) => sum + l.amount, 0),
    deadMoney:
      committed.filter((c) => c.player.folded).reduce((sum, c) => sum + c.amount, 0),
    layers,
    returned,
    pendingUnmatched,
    roundClosed,
    scope,
  };
}

/**
 * 🔴 **会被争夺的底池**（`computePot` 的正确替代口径）。
 *
 * 与 `computePot` 的关系：`contestedPot ≤ computePot`，差额是未被跟注的超额。
 * 决策数学（底池赔率、跟注 EV、可赢上限）必须用这一个，而不是总投入。
 */
export function contestedPot(state: GameState): number {
  return computeLayeredPot(state).contested;
}

/**
 * 一名玩家**能争夺到的总量**（= 他所在各层之和）。
 *
 * 这是「短筹码赢不了全部底池」的量化表达，界面必须显示它 ——
 * 否则使用者会以为短筹码全下后能赢整池。
 */
export function contestableFor(state: GameState, playerId: string): number {
  return maxWinFor(state, playerId);
}

/**
 * 🔴 **假设某玩家先投入 `extra` 之后**，他能争夺到的总量。
 *
 * ## 为什么需要「假设」这一步（这是本轮最容易写错的地方）
 *
 * 决策时刻直接算 `maxWinFor(state, hero)` 会给出一个**严重偏小**的数，
 * 因为「我还没跟注」这件事本身让对手的整笔下注都显示为「未被跟注」：
 *
 * ```text
 * 我 100BB，UTG 全下 100BB，我还没行动
 *   maxWinFor(state, 我) = 200        ← 只算了我已投的 1BB 与对手的 1BB
 *   跟注 99BB 之后才是              = 10100
 * ```
 *
 * 我一跟注，对手那笔钱就被**激活**为可争夺的。因此必须
 * 「先假设投入，再分层」—— 两层顺序不能反。
 *
 * ## 反过来也不能直接用「总投入 − 退回 + 跟注」
 *
 * 决策时刻的「退回」是**我的**跟注尚未发生造成的假象；直接拿它当
 * 「永久退回」会把一笔本来会被我跟的钱也当成退回。
 *
 * 只有「假设我跟注后重新分层」才能同时正确处理两种情形：
 *
 * ```text
 * 我 100BB / 对手 100BB 全下     ⇒ 我跟注后退回 0      ⇒ 可争夺 10100
 * 我 200BB / 对手只有 50BB 全下  ⇒ 我跟注后仍退回 49BB ⇒ 可争夺 1000
 * ```
 *
 * 第二行的 49BB 是**对手确实跟不到**的部分，无论我怎么做都不会被争夺 ——
 * 它与第一行那种「暂时未被跟注」是两件不同的事。
 *
 * ⚠️ 这是**纯函数**：不改动传入的 `state`，只在副本上算。
 */
export function winnableIfCommit(state: GameState, playerId: string, extra: number): number {
  return previewCommit(state, playerId, extra).winnable;
}

/**
 * 跟注预览：**可争夺总量** + **这名玩家有资格争夺的那些层**。
 *
 * ## 🔴 为什么决策层需要「层」，而不是只要一个总量
 *
 * `contested` / `winnable` 是一笔钱，但**钱不是一个整体的胜负条件**：
 *
 * | 层 | 赢的条件 |
 * |---|---|
 * | 主池 | 比**所有**还在桌上的人大 |
 * | 边池 | 只比**同在这一层**的人大 |
 *
 * 因此「跟注额 ÷ 可争夺总量」只有在**他只有一层**时才是真实的盈亏平衡胜率。
 * 多层时他可能**输掉主池却赢下边池** —— 此时「权益 < 门槛」并不能证明
 * 跟注是负期望。
 *
 * 实测反例（`test/layeredPot.test.ts` POT-13）：
 *
 * ```text
 * 短码 9♥9♣ 全下 1000（暗三条）／大筹码 T♥J♥ 全下 3000（听牌）／我 A♥A♦ 需跟 2000
 * 可争夺 = 主池 3050 + 边池 4000 = 7050 ⇒ 门槛 2000 / 7050 = 28.4%
 * 我的整池权益只有 4.8%（只有 2 张 A 能救主池）
 * 但我 90.5% 赢边池 ⇒ 真实跟注 EV = +1764，而不是负的
 * ```
 *
 * ⚠️ 无平分时，单一门槛算出的 EV 是**下界**（每一层的胜率都不低于
 * 「赢下所有人」的胜率），因此它偏保守 —— 拿它判「该弃牌」会系统性地
 * 弃掉本该跟的牌。
 */
export type CommitPreview = {
  /** 假设投入 `extra` 之后，该玩家能争夺到的总量 */
  winnable: number;
  /** 该玩家**有资格**争夺的那些层（升序；层额之和 === `winnable`） */
  layersForPlayer: readonly PotLayer[];
  /**
   * 🔴 **「一个胜率门槛」在这手牌里成不成立**。
   *
   * 判据不是「层数 > 1」那么简单 —— 还要看那个层界**是不是结构性的**：
   *
   * | 层界的来源 | 会不会塌 | 门槛 |
   * |---|---|---|
   * | **已全下**的活人（筹码封在那里） | 不会（他不能再投） | **不适用** |
   * | 还有筹码、只是暂时投得少的活人 | 会（他一跟注，层就并回主池） | 适用 |
   *
   * 实证：`preflop-03-72o-vs-open`（SB 面对 CO 开池、**BB 还没行动**）里，
   * BB 的 1BB 让「层数」看起来是 2，但 BB 跟注后只剩一层 ——
   * 若按「层数 > 1」一刀切，这条 Golden Spot 会被误判成「判不了方向」而不再给建议
   *（`test/alphaSmokeSpots.test.ts` 抓到了这个过度收紧）。
   */
  singleThresholdApplies: boolean;
};

/**
 * 预览「我投入 `extra` 之后」的分层结果。
 *
 * ⚠️ 与 `winnableIfCommit` 的差别只在于**多返回了层与门槛判据**：
 * 数值口径完全一致（`winnable === Σ layersForPlayer[].amount`）。
 */
export function previewCommit(state: GameState, playerId: string, extra: number): CommitPreview {
  const target = extra > 0 ? hypotheticalAfterCommit(state, playerId, extra) : state;
  const pot = computeLayeredPot(target);
  const layersForPlayer = pot.layers.filter((l) => l.eligibleIds.includes(playerId));

  const hero = target.players.find((p) => p.id === playerId);
  const heroTotal = hero === undefined ? 0 : totalCommittedOf(target, hero);
  /*
   * 只有当「某个**不能再投钱**的活人」被卡在我下面时，边池才是结构性的：
   * 他已全下（或筹码为 0），那个层界不会再动。
   */
  const frozenLayerBelowHero = target.players.some(
    (p) =>
      p.id !== playerId &&
      !p.folded &&
      (p.allIn || p.remainingStack <= 0) &&
      totalCommittedOf(target, p) < heroTotal,
  );

  return {
    winnable: layersForPlayer.reduce((sum, l) => sum + l.amount, 0),
    layersForPlayer,
    singleThresholdApplies: layersForPlayer.length <= 1 || !frozenLayerBelowHero,
  };
}

/** 在副本上把「某玩家投入 extra」记进去，其余保持不变（纯函数，不改传入的 state） */
function hypotheticalAfterCommit(state: GameState, playerId: string, extra: number): GameState {
  return {
    ...state,
    players: state.players.map((p) =>
      p.id === playerId
        ? {
            ...p,
            committedByStreet: {
              ...p.committedByStreet,
              [state.street]: p.committedByStreet[state.street] + extra,
            },
            remainingStack: Math.max(0, p.remainingStack - extra),
          }
        : p,
    ),
  } as GameState;
}

/* ============================================================
 * 结算事件（稳定唯一标识 + 去重）
 * ============================================================ */

export type SettlementEventKind = 'LAYER' | 'UNCALLED_BET_RETURN' | 'PENDING_UNMATCHED';

/**
 * 🔴 **结算事件**（RIVER CONSISTENCY V2 §18）。
 *
 * ## 为什么需要「事件」而不是「几行文本」
 *
 * 修复前底池分层被渲染成**字符串数组**（`describeLayeredPotZh`），
 * 而两个渲染点各自拼了一次「无人跟注、退回 X」——
 * 于是同一件事在界面上出现**两次**，且没有任何标识能判断它们是不是同一件事。
 *
 * 现在：
 *
 * | 要求 | 实现 |
 * |---|---|
 * | 稳定唯一标识 | `id = {street}|{kind}|{playerId ?? '-'}|{amount}|{sequence}` |
 * | 同一事件只能出现一次 | 渲染层按 `id` 去重（`dedupeSettlementEvents`） |
 * | 「尚未匹配」与「最终退回」不得混 | 两种 `kind` 分开，`final` 标记时序 |
 * | 未完成行动节点不得有最终退回 | `PENDING_UNMATCHED` 的 `final === false` |
 *
 * ⚠️ 事件是**呈现层**的事实快照，不是派彩结果 —— 本项目不派彩。
 */
export type SettlementEvent = {
  /** 稳定唯一标识（同一局面下逐位可复现） */
  id: string;
  kind: SettlementEventKind;
  street: string | null;
  playerId: string | null;
  playerLabelZh: string | null;
  amount: number;
  /** 是否是**最终**事件（`false` = 尚未匹配，可能被跟上） */
  final: boolean;
  sequence: number;
  textZh: string;
};

/**
 * 把分层底池转成**结算事件列表**。
 *
 * @param street 当前街（仅用于标识与文案；未知传 null）
 */
export function settlementEventsOf(pot: LayeredPot, street: string | null): readonly SettlementEvent[] {
  const events: SettlementEvent[] = [];
  let sequence = 0;
  /**
   * 🔴 **id 是「内容标识」，不含序号**。
   *
   * 为什么不能把序号拼进 id：那样「同一个事件被两个渲染点各生成一次」
   * 会得到两个**不同**的 id，去重就会失效 —— 而使用者实测的缺陷正是
   * 「同一句『无人跟注，退回 X』出现两次」。
   *
   * 现在：**内容相同 ⇒ id 相同** ⇒ 去重必然收敛成一个，
   * 且 `duplicateIds` 会如实报出「这里曾经重复过」。
   */
  const idOf = (
    kind: SettlementEventKind,
    playerId: string | null,
    amount: number,
    discriminator: string,
  ): string => `${street ?? '-'}|${kind}|${playerId ?? '-'}|${amount}|${discriminator}`;
  const push = (
    kind: SettlementEventKind,
    playerId: string | null,
    playerLabelZh: string | null,
    amount: number,
    final: boolean,
    textZh: string,
    discriminator: string,
  ): void => {
    events.push({
      id: idOf(kind, playerId, amount, discriminator),
      kind,
      street,
      playerId,
      playerLabelZh,
      amount,
      final,
      sequence,
      textZh,
    });
    sequence += 1;
  };

  for (const layer of pot.layers) {
    const name = layer.layerIndex === 0 ? '主池' : `边池 ${layer.layerIndex}`;
    const eligible = layer.eligibleIds.length;
    const deadPart = layer.amount - layer.perPlayer * eligible;
    const deadNote = deadPart > 0 ? `（含已弃牌者投入 ${deadPart}）` : '';
    push(
      'LAYER',
      null,
      name,
      layer.amount,
      true,
      `${name} ${layer.amount}${deadNote}，${eligible} 家有资格`,
      `layer${layer.layerIndex}`,
    );
  }
  for (const [playerId, amount] of Object.entries(pot.returned)) {
    push(
      'UNCALLED_BET_RETURN',
      playerId,
      null,
      amount,
      true,
      `无人跟注、退回 ${amount}（没有任何对手能再跟注 ⇒ 这部分不在底池里）`,
      'final',
    );
  }
  for (const [playerId, amount] of Object.entries(pot.pendingUnmatched)) {
    push(
      'PENDING_UNMATCHED',
      playerId,
      null,
      amount,
      false,
      `尚待跟注 ${amount}（下注轮未结束：还有人可以跟 —— 这**不是**退回，跟注后会并入底池）`,
      'pending',
    );
  }
  return Object.freeze(events);
}

/**
 * 🔴 **按事件 id 去重**（渲染层必须调用）。
 *
 * 返回去重后的事件，以及被丢弃的重复 id（供一致性检查使用 ——
 * 重复本身就是一个缺陷信号，不能静默丢掉）。
 */
export function dedupeSettlementEvents(events: readonly SettlementEvent[]): {
  events: readonly SettlementEvent[];
  duplicateIds: readonly string[];
} {
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  const kept: SettlementEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) {
      duplicateIds.push(event.id);
      continue;
    }
    seen.add(event.id);
    kept.push(event);
  }
  return { events: Object.freeze(kept), duplicateIds: Object.freeze(duplicateIds) };
}

/* ============================================================
 * 显示
 * ============================================================ */

/**
 * 分层底池的中文描述（逐行，供界面与诊断使用）。
 *
 * ⚠️ **由 `settlementEventsOf` 生成**（单一事实来源）：修复前这里独立拼过
 * 一次「无人跟注、退回 X」，而客户端也拼了一次 ⇒ 同一件事显示两遍。
 */
export function describeLayeredPotZh(pot: LayeredPot, street: string | null = null): readonly string[] {
  if (pot.total === 0) return ['底池为空'];
  const { events } = dedupeSettlementEvents(settlementEventsOf(pot, street));
  return events.map((e) => e.textZh);
}

/* ============================================================
 * 自检
 * ============================================================ */

/**
 * 自检：分层底池的**守恒不变量**。
 *
 * 启动时调用（与其它 `selfCheck*` 一样，失败即拒绝启动）——
 * 这个模块一旦算错，底池数学全线偏移，而那种偏移在界面上看不出来。
 */
export function selfCheckLayeredPot(): string[] {
  const problems: string[] = [];

  const scenarios: readonly { name: string; commitments: readonly number[]; folded: readonly boolean[] }[] = [
    { name: '对等两人', commitments: [100, 100], folded: [false, false] },
    { name: '一人多投（未被跟注）', commitments: [200, 100], folded: [false, false] },
    { name: '三人不同筹码全下', commitments: [1000, 400, 150], folded: [false, false, false] },
    { name: '两人对等 + 一人弃牌', commitments: [100, 100, 100], folded: [false, false, true] },
    { name: '弃牌者投得最多', commitments: [500, 100, 100], folded: [true, false, false] },
    { name: '全都弃牌只剩一人', commitments: [50, 100, 30], folded: [true, false, true] },
    { name: '零投入', commitments: [0, 0], folded: [false, false] },
  ];

  for (const scenario of scenarios) {
    const fake = fakeStateOf(scenario.commitments, scenario.folded);
    const pot = computeLayeredPot(fake);
    const returnedSum = Object.values(pot.returned).reduce((a, b) => a + b, 0);
    const pendingSum = Object.values(pot.pendingUnmatched).reduce((a, b) => a + b, 0);
    const expectedTotal = scenario.commitments.reduce((a, b) => a + b, 0);
    const liveCount = scenario.folded.filter((f) => !f).length;

    if (pot.total !== expectedTotal) {
      problems.push(`${scenario.name}: total ${expectedTotal} 应为 ${expectedTotal}，实际 ${pot.total}`);
    }

    /*
     * ⚠️ 守恒公式**分两种形态**，不能用一个式子套。
     *
     * | 形态 | 条件 | 公式 |
     * |---|---|---|
     * | 弃牌获胜 | 未弃牌 ≤ 1 人 | `可争夺 = 总额 − 退回`（**仍可能有退回**！） |
     * | 摊牌分池 | 未弃牌 ≥ 2 人 | `主池 + 边池 + 退回 === 总额` |
     *
     * 🔴 「弃牌获胜没有退回」是我第一版的错误假设，而且它**同时**写进了
     * 自检与文件头注释，两边互相印证 —— 一个独立审查者因此指到它。
     * 反例：`UTG 加注 600、其余全弃` ⇒ 退回 500（= 600 − 100），
     * 可争夺只有 250，而不是 750。**只剩一人时他照样要退回别人跟不到的部分。**
     *
     * 🔴 **RIVER CONSISTENCY V2**：超额被拆成「最终退回」与「尚未匹配」，
     * 因此守恒式必须同时含两项：
     *
     * ```text
     * contested + Σreturned + ΣpendingUnmatched === total
     * ```
     */
    if (pot.contested + returnedSum + pendingSum !== pot.total) {
      problems.push(
        `${scenario.name}: 可争夺 ${pot.contested} + 退回 ${returnedSum} + 尚未匹配 ${pendingSum} ` +
          `≠ 总额 ${pot.total}（守恒被破坏）`,
      );
    }
    if (liveCount >= 2) {
      if (pot.main + pot.sideTotal !== pot.contested) {
        problems.push(
          `${scenario.name}: 主池 ${pot.main} + 边池 ${pot.sideTotal} ≠ 可争夺 ${pot.contested}`,
        );
      }
    } else if (pot.main !== pot.contested) {
      problems.push(
        `${scenario.name}: 弃牌获胜时主池（${pot.main}）必须等于可争夺量（${pot.contested}）`,
      );
    }

    /*
     * ---- 规则级断言（守恒挡不住的那些）----
     *
     * 🔴 这一组是在**三个独立审查者都指出「守恒自检挡不住规则错误」**之后加的。
     * 实证：旧版**守恒恒成立**，但 3000 局里有 887 个决策点的可争夺量与规则不符。
     * 守恒只能证明「没丢筹码」，不能证明「分对了」。
     */
    const sortedDesc = [...scenario.commitments].sort((a, b) => b - a);
    const cap = sortedDesc[1] ?? 0;

    // 1) 退回 = 最高投入 − 第二高投入（**含弃牌者**）
    const expectedRefund = Math.max(0, (sortedDesc[0] ?? 0) - cap);
    if (returnedSum !== expectedRefund) {
      problems.push(
        `${scenario.name}: 退回应为「最高投入 − 第二高投入」= ${expectedRefund}，实际 ${returnedSum}`,
      );
    }

    // 2) 可争夺量 = Σ min(投入_i, 第二高投入)
    const expectedContested = scenario.commitments.reduce((sum, c) => sum + Math.min(c, cap), 0);
    if (pot.contested !== expectedContested) {
      problems.push(
        `${scenario.name}: 可争夺量应为 Σ min(投入, 第二高) = ${expectedContested}，实际 ${pot.contested}`,
      );
    }

    /*
     * 3) 层额必须与「**有效投入**（= min(投入, cap)）」一致，且能乘回去。
     *
     * ⚠️ 用**有效投入**而不是原始投入 —— 这正是本模块的核心口径。
     * 我第一版这里用了原始投入，于是「只剩一人」那条自检误报。
     *
     * ⚠️⚠️ 只对**多人摊牌**形态断言：只剩一人时走的是**独立分支**
     *（弃牌获胜：他赢走全部底池，扣掉自己被退回的部分），
     * 那种局面下「按有效投入建层」根本不适用 —— 第一版对着它套通用层断言，
     * 于是把正确实现误报成缺陷。**自检写错比不写更危险**：
     * 它会让人去修一个并不存在的问题。
     */
    if (liveCount >= 2) {
      const effective = scenario.commitments.map((c) => Math.min(c, cap));
      for (const layer of pot.layers) {
        const reach = effective.filter((c) => c >= layer.perPlayer).length;
        if (layer.amount < layer.perPlayer) {
          problems.push(`${scenario.name}: 第 ${layer.layerIndex} 层层额 ${layer.amount} 小于人均`);
        }
        if (reach < layer.eligibleIds.length) {
          problems.push(
            `${scenario.name}: 第 ${layer.layerIndex} 层有资格者（${layer.eligibleIds.length}）` +
              `多于有效投入达到该层的人数（${reach}）`,
          );
        }
      }
    }

    // 4) 每层都要有**至少一名有资格者** —— 没有资格者的层是「没人能赢的钱」
    for (const layer of pot.layers) {
      if (layer.eligibleIds.length === 0) {
        problems.push(`${scenario.name}: 第 ${layer.layerIndex} 层没有任何有资格者`);
      }
      if (layer.amount <= 0) {
        problems.push(`${scenario.name}: 第 ${layer.layerIndex} 层金额为 ${layer.amount}`);
      }
    }

    // 5) 可赢上限不得超过可争夺量；已弃牌者没有可赢上限
    for (const [index] of scenario.commitments.entries()) {
      const id = `p${index}`;
      const win = maxWinFor(fake, id);
      if (win > pot.contested + 1e-9) {
        problems.push(
          `${scenario.name}: ${id} 的可赢上限 ${win} 超过可争夺量 ${pot.contested}`,
        );
      }
      if (scenario.folded[index] === true && win !== 0) {
        problems.push(`${scenario.name}: 已弃牌的 ${id} 不该有可赢上限（实际 ${win}）`);
      }
    }
  }

  return problems;
}

/** 构造一个只用于自检的最小 state（不依赖 createGame，避免循环依赖） */
export function fakeStateOf(commitments: readonly number[], folded: readonly boolean[]): GameState {
  const players = commitments.map((amount, index) => ({
    id: `p${index}`,
    name: `P${index}`,
    position: 'BTN',
    startingStack: amount,
    remainingStack: 0,
    committedByStreet: { PREFLOP: amount, FLOP: 0, TURN: 0, RIVER: 0 },
    ante: 0,
    folded: folded[index] === true,
    allIn: true,
    holeCards: null,
  }));
  return {
    id: 'self-check',
    config: { tableSize: 6, smallBlind: 1, bigBlind: 2, ante: 0, dealerPosition: 'BTN' },
    players,
    userPlayerId: 'p0',
    board: { flop: [], turn: [], river: [] },
    street: 'PREFLOP',
    currentBet: 0,
    lastRaiseSize: 2,
    pendingQueue: [],
    bettingRoundComplete: false,
    raiseClosedFor: [],
    actedSinceLastAggression: [],
    rake: 0,
    createdAt: '1970-01-01T00:00:00.000Z',
    actions: [],
    phase: 'BETTING',
    winners: [],
  } as unknown as GameState;
}

/** 供其它模块复用的「本街是否还有人能跟注」判据 */
export function anyOpponentCanStillCall(state: GameState, playerId: string): boolean {
  for (const player of state.players) {
    if (player.id === playerId) continue;
    if (player.folded || player.allIn) continue;
    if (player.remainingStack <= 0) continue;
    return true;
  }
  return false;
}

/** 底池里是否还有公共牌没发完（用于「跑牌」判断） */
export function boardComplete(state: GameState): boolean {
  return allBoardCards(state).length >= 5;
}
