/**
 * 合法动作推导 + 尺寸网格
 *
 * ## 这个模块在端到端链中解决什么
 *
 * Decision Engine **不允许凭空生成候选动作**（规范第 22 节）：
 * 候选必须来自 Poker Core 的合法动作集合。
 *
 * 引擎本身没有导出一个「合法动作列表」函数（它只在 `applyAction` 里
 * 逐条校验），因此本模块承担这次推导。
 *
 * ## ⚠️ 与引擎保持一致是**可测试的**，不是靠人工比对
 *
 * `deriveLegalActions` 的正确性判据是：
 *
 * > 对推导出的每一个动作，构造一个合法命令，
 * > `applyAction` **必须**接受它；对未推导出的动作，**必须**拒绝。
 *
 * `test/alphaDecision.test.ts` 用真牌局逐条验证这一点
 *（包括 all-in、短筹码、短全下关闭加注权等边界）。
 * 若引擎的校验收紧而本模块没跟上，那个测试会失败 ——
 * 这正是我们要的「不允许出现无法执行的建议」。
 */

import { Street } from '../../domain/types.ts';
import {
  requiredCallAmount,
  minRaiseTo,
  computePot,
  type GameState,
  type PlayerState,
} from '../../domain/poker/gameState.ts';
import { isUnopenedPot, minBetAmount, canRaise } from '../../domain/poker/engine.ts';
import { DecisionAction } from '../../domain/decision/decision.types.ts';

export type LegalActions = {
  /** 合法动作集合（顺序稳定） */
  actions: readonly DecisionAction[];
  /** 跟注需要投入的金额（0 表示不需要跟注） */
  callCost: number;
  /**
   * 这次跟注**本身就是全下**（筹码不足以完整跟注，只能全下跟）。
   *
   * 🔴 规范第 10–15 条：这种跟注**不是**「少跟一点」，而是
   * 「把全部筹码押进去」。界面必须如实标注为全下，并且**不得**再同时
   * 摆一个语义完全相同的「全下」按钮 —— 实测（Hero 剩 0.5BB、需跟 1BB）
   * 旧实现同时给出「跟注 0.5BB」与「全下（0.5BB）」，点下去是同一条动作。
   */
  callIsAllIn: boolean;
  /** 是否可以过牌 */
  canCheck: boolean;
  /** 是否可以下注（本街无人下注） */
  canBet: boolean;
  /** 是否可以加注 */
  canRaise: boolean;
  /** 下注的最小额 */
  minBet: number;
  /** 加注到的最小总额（本街口径） */
  minRaiseToAmount: number;
  /**
   * 本街**当前注额**（所有人里最高的本街投入）。
   *
   * 🔴 加注尺寸的基准是「**跟注额**」，而跟注额 = `currentBet − 我已投入本街`。
   * `currentBet` 与「我已投入」都不在上面的字段里能反推出来
   *（`allInToAmount − myRemainingStack` 只给得出「我已投入」），
   * 因此这里显式带出来 —— 尺寸网格要用它算「加注到 3 倍跟注额」这类尺寸。
   *
   * 恒等式：`minRaiseToAmount === currentBet + lastRaiseSize`
   *（由 `gameState.ts` 的 `minRaiseTo` 保证），有测试锁住。
   */
  currentBet: number;
  /** 我的剩余筹码 */
  myRemainingStack: number;
  /** 全下时的本街总额 */
  allInToAmount: number;
};

/**
 * 推导当前玩家的合法动作。
 *
 * ## 与 `applyAction` 的对应关系（逐条）
 *
 * | 动作 | 引擎的校验 | 本函数的判据 |
 * |---|---|---|
 * | CHECK | `call > 0 \|\| currentBet > 已投入` → 拒绝 | `callCost === 0` |
 * | CALL | `rawNeed <= 0` → 拒绝 | `callCost > 0` |
 * | BET | `!isUnopenedPot` → 拒绝 | `isUnopenedPot` |
 * | BET（全下） | 允许 `amount === remainingStack` 即使小于最小下注 | 只要 `remainingStack > 0` |
 * | RAISE | `amount <= currentBet \|\| amount <= already` → 拒绝；短全下关闭加注权 | `canRaise` 且存在合法加注额 |
 * | ALL_IN | 由 BET / RAISE / CALL 三条路径分别处理 | 仅当它是**下注 / 加注**时才单独列出；**全下跟注**由 CALL 自己表达（见 `callIsAllIn`） |
 * | FOLD | 总是合法（即使不需要跟注 —— 引擎允许弃牌） | 总是包含 |
 */
export function deriveLegalActions(state: GameState, player: PlayerState): LegalActions {
  const callCost = requiredCallAmount(state, player.id);
  const myRemainingStack = player.remainingStack;
  const already = player.committedByStreet[state.street];

  const canCheck = callCost === 0 && state.currentBet <= already;
  const canBet = isUnopenedPot(state) && myRemainingStack > 0;

  const minBet = minBetAmount(state, player);
  const minRaiseToAmount = minRaiseTo(state);

  /*
   * 加注需要：有加注权、筹码足以超过当前注额、且能组成合法加注。
   *
   * 🔴 **不能写成 `!canCheck && …`**（2026-09 修复）。
   *
   * 旧实现把「能过牌」当成「不能加注」，而这两个动作**互不排斥** ——
   * 最典型的就是**大盲的选择权**：全员平跟后大盲已投满一个大盲，
   * 他**既可以过牌、也可以加注**。
   *
   * 旧写法的后果（实测）：`deriveLegalActions(BB)` 只返回
   * `["FOLD","CHECK"]`，而同一局面上 `applyAction(BB RAISE 400)` 是
   * **被引擎接受**的 —— 也就是说这个模块自己文档里写的契约
   *（「未推导出的动作 `applyAction` 必须拒绝」）被打破了，
   * 而界面只按 `legal.actions` 生成按钮，于是**大盲永远看不到加注入口**。
   *
   * 判据只需两件事：有加注权（未被短全下关闭）+ 能把本街总额推到当前注额之上。
   * 「有未开池的下注机会」由上面的 `canBet` 单独表达，两者不重叠：
   * 未开池时 `currentBet <= already`，`raiseToCap > currentBet` 恒成立，
   * `canRaise` 在无人下注时也恒为真 —— 但那种情况下语义是 BET 而不是 RAISE，
   * 因此这里用 `isUnopenedPot` 把加注排除掉，避免两个按钮做同一件事。
   */
  const raiseAllowed = canRaise(state, player.id);
  const raiseToCap = already + myRemainingStack; // 全下时的本街总额
  const canRaiseByAmount = !canBet && raiseAllowed && raiseToCap > state.currentBet;

  const actions: DecisionAction[] = [];
  // 顺序固定：弃牌 → 过牌 → 跟注 → 下注 → 加注 → 全下
  actions.push(DecisionAction.FOLD);
  if (canCheck) actions.push(DecisionAction.CHECK);
  if (callCost > 0) actions.push(DecisionAction.CALL);
  if (canBet) actions.push(DecisionAction.BET);
  if (canRaiseByAmount) actions.push(DecisionAction.RAISE);

  /*
   * ---- 全下跟注（short all-in call）----
   *
   * `callCost = min(需要投入, 剩余筹码)`，所以 `callCost === myRemainingStack`
   * 就等价于「跟不完整」。这时**只有一种可能的动作**：把筹码全部押进去。
   *
   * 🔴 旧实现同时推入 CALL 与 ALL_IN —— 两个按钮点下去是同一条动作
   * （实测 Hero 剩 0.5BB / 需跟 1BB：`CALL(50)` 与 `ALL_IN` 都被接受，
   * 且结果状态相同）。规范第 10–15 条禁止「同时显示无法完成的跟注」。
   * 这里保留 **CALL**（那才是使用者的意图），由界面把它如实标成全下，
   * 并**不再**另推一个重复的 ALL_IN。
   */
  const callIsAllIn = callCost > 0 && myRemainingStack <= callCost;

  // 全下：只有在它是**下注 / 加注**时才与已列出的动作不同，才值得单独一个按钮
  const allInToAmount = already + myRemainingStack;
  const allInIsBet = canBet && myRemainingStack > 0;
  const allInIsRaise = canRaiseByAmount;
  if (myRemainingStack > 0 && (allInIsBet || allInIsRaise)) {
    actions.push(DecisionAction.ALL_IN);
  }

  return {
    actions: Object.freeze(actions),
    callCost,
    callIsAllIn,
    canCheck,
    canBet,
    canRaise: canRaiseByAmount,
    minBet,
    minRaiseToAmount,
    currentBet: state.currentBet,
    myRemainingStack,
    allInToAmount,
  };
}

/* ============================================================
 * 尺寸网格
 * ============================================================ */

export type SizeOption = {
  /** 本街总额（BET / RAISE 统一用「到多少」的口径） */
  toAmount: number;
  /** 本次需要额外投入的筹码 */
  costChips: number;
  /** 相对底池的比例（下注场景）；加注场景为 null */
  potRatio: number | null;
  /** 是否全下 */
  isAllIn: boolean;
  /** 中文标签 */
  labelZh: string;
};

/**
 * 网格里最接近 `toAmount` 的尺寸（**升序扫描、并列取更小的那个**）。
 *
 * 🔴 共享实现：决策层选「用哪个合法加注尺寸」、以及隔离加注模型算 EV 之前
 * 先把目标尺寸落到合法网格上，**必须是同一条规则** —— 两处规则一旦不同，
 * 模型算的 EV 就属于另一个尺寸，那等于拿别的动作的数字冒充本动作。
 */
export function closestSizeTo<T>(
  grid: readonly T[],
  toAmount: number,
  amountOf: (item: T) => number,
): T | null {
  let best: T | null = null;
  for (const item of grid) {
    if (best === null || Math.abs(amountOf(item) - toAmount) < Math.abs(amountOf(best) - toAmount)) {
      best = item;
    }
  }
  return best;
}

/**
 * 生成合法尺寸网格。
 *
 * ## 🔴 BET 与 RAISE 的基准**不一样**（本轮修复的核心）
 *
 * | 模式 | 尺寸基准 | 理由 |
 * |---|---|---|
 * | `BET` | **底池百分比**（25% / 33% / 50% / 67% / 75% / 100%） | 本街还没有注额，底池就是唯一基准 |
 * | `RAISE` | **跟注额的倍数**（2× / 2.5× / 3× / 4× / 5×）+ 跟注后底池的倍数 | 加注面对一个既存注额，「3 倍跟注额」才是通用说法 |
 *
 * ## 修复前的缺陷：加注只剩两个选项（最小加注 与 全下）
 *
 * 修复前两种模式**共用**同一份底池百分比网格。对加注来说，那些百分比算出来的
 * 数额通常**小于最小加注额**，于是被 `clamp` 到最小加注额后**全部去重成一项**。
 *
 * 实测（6 人桌，BB 持 AKo 面对 UTG 开池 3BB，底池 450 筹码）：
 *
 * ```text
 * 修复前：(RAISE)  [500]  +  [10000 全下]
 *                    ↑ 最小加注 5BB，然后直接跳到 100BB 全下，中间什么都没有
 * 修复后：(RAISE)  [600] [750] [900] [1125] [1500] [2000] [3000] + [10000 全下]
 *                    ↑ 2× / 2.5× / 3× 跟注额，再往上按底池与全下递进
 * ```
 *
 * 使用者原话：**「加注的尺寸怎么那么少，Raise 都没得选」**。
 *
 * ## 三条纪律（未变）
 *
 * 1. **优先复用既有预设**（`BET_SIZE_PRESETS` 的 25%…100%），不新造一套。
 * 2. 每个尺寸都必须**合法**：夹到 `[minTo, allInTo]`，并去重。
 * 3. 尺寸**只能来自网格**，不生成任意数值 ——
 *    「精确到 1 筹码」的建议会伪造精度。
 *
 * ⚠️ 第 2 条的「夹到」对加注要加一条：**低于最小加注的候选直接丢弃，
 * 不是夹上来**。夹上来会把一堆互不相同的候选压成同一个值（这正是修复前
 * 「只剩一项」的成因），丢弃才保留「这些尺寸在这个局面下不可用」这个信息。
 *
 * @param mode `BET` 表示本街首次下注（`toAmount` 从 0 起算），
 *             `RAISE` 表示加注（`toAmount` 是**本街总额**，含我已投入的部分）
 */
export function buildSizeGrid(
  legal: LegalActions,
  pot: number,
  mode: 'BET' | 'RAISE',
): readonly SizeOption[] {
  const minTo = mode === 'BET' ? legal.minBet : legal.minRaiseToAmount;
  const maxTo = legal.allInToAmount;

  if (maxTo <= 0) return Object.freeze([]);

  /** 我本街已经投入的筹码（`allInToAmount = 本街已投入 + 剩余筹码`） */
  const streetAlready = Math.max(0, legal.allInToAmount - legal.myRemainingStack);

  /*
   * 加注的倍数档 —— **加注唯一的基准轴**（见下面 `mode === 'RAISE'` 的说明）。
   *
   * 这几个值是「牌桌上的通用语言」：2 倍是迷你加注、2.5~3 倍是标准加注、
   * 4~5 倍是重注，6 / 8 倍是深筹码时的「打大一点」。
   *
   * 🔴 为什么一直排到 8 倍：翻牌前 100BB 深时，3 倍加注只有 9BB，
   * 而全下是 100BB —— 若档位停在 5 倍（10BB），使用者想加注到 15~20BB
   * 就**没有按钮可按**，只能跳到全下。那正是「Raise 没得选」的另一种形态。
   * 档位必须一直铺到接近全下的量级。
   */
  const RAISE_MULTIPLES = [2, 2.5, 3, 4, 5, 6, 8] as const;
  const toCall = Math.max(0, legal.currentBet - streetAlready);

  /*
   * 每种模式只有**最小合法额与全下**这两个候选是「无条件保留」的。
   * 其余候选低于 `minTo` 时**丢弃**（见上面第 2 条的说明）。
   */
  const candidates: number[] = [];

  if (mode === 'BET') {
    // 复用既有预设（不含超池；超池由 all-in 或用户显式要求覆盖）
    for (const ratio of [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1]) {
      candidates.push(Math.round(pot * ratio));
    }
  } else {
    /*
     * ---- 加注：**单一基准轴 = 跟注额的倍数** ----
     *
     * `toCall` = 跟注需要补的筹码 = 当前注额 − 我已投入本街。
     *
     * 🔴 为什么**不**混入「底池比例」档（修复过程中试过，撤销了）：
     *
     * 两套基准会产生**互相打架**的档位。实测那一版的加注菜单是
     *
     * ```text
     * 2.5 倍 / 3 倍 / 4 倍 / 181% 底池 / 5 倍 / 6.5 倍 / 433% 底池
     * ```
     *
     * ——`181% 底池`（800→813 筹码）夹在 `4 倍`（800）与 `5 倍`（1000）之间，
     * 与前一档只差 **13 筹码**；而 `6.5 倍` 这种标签使用者根本无从判断。
     * 菜单看起来更长，**可读性反而更差**。
     *
     * 加注只需要一个轴：**我加注到跟注额的几倍**。这是牌桌上的通用语言
     *（「3 倍他」「2.5 倍」），也是唯一能被使用者一眼比较的尺度。
     */
    if (toCall > 0) {
      for (const mult of RAISE_MULTIPLES) {
        candidates.push(Math.round(toCall * mult));
      }
    }
  }

  // 最小合法额与全下**无条件**进入候选
  candidates.push(minTo, maxTo);

  const seen = new Set<number>();
  const options: SizeOption[] = [];

  for (const raw of candidates) {
    // 低于最小额：只有「最小额本身」与「全下」允许保留
    const isFloor = raw === minTo || raw === maxTo;
    if (raw < minTo && !isFloor) continue;

    const toAmount = Math.max(minTo, Math.min(maxTo, raw));
    if (seen.has(toAmount)) continue;
    seen.add(toAmount);

    // BET：我本街尚未投入，成本 = toAmount
    // RAISE：toAmount 是本街总额，成本 = toAmount − 我已投入本街
    const costChips = mode === 'BET' ? toAmount : Math.max(0, toAmount - streetAlready);

    if (costChips <= 0) continue;
    if (costChips > legal.myRemainingStack) continue;

    const isAllIn = toAmount >= maxTo;
    options.push({
      toAmount,
      costChips,
      potRatio: pot > 0 ? toAmount / pot : null,
      isAllIn,
      labelZh: sizeLabelZh({ mode, toAmount, pot, toCall: Math.max(0, legal.currentBet - streetAlready), isAllIn }),
    });
  }

  // 稳定排序：按投入从小到大（便于界面展示与测试）
  options.sort((a, b) => a.costChips - b.costChips || a.toAmount - b.toAmount);
  return Object.freeze(options);
}

/**
 * 尺寸的中文标签。
 *
 * | 模式 | 标签 | 理由 |
 * |---|---|---|
 * | `BET` | `50% 底池` | 下注的基准就是底池 |
 * | `RAISE` | `3 倍` | 加注的基准是**跟注额**，「3 倍」是通用说法 |
 *
 * 🔴 `RAISE` 的标签写「N 倍」而**不是**「N 倍跟注」也不是「N 倍底池」：
 *
 * - 「N 倍跟注」不是扑克里的通用说法，读起来要先想「跟注额是多少」；
 * - 「N 倍底池」会被误读成「投入 N 个底池」——那是完全不同的数额。
 *
 * 按钮本身已经写了「加注到 X BB」（见 `tablePreview`），因此标签只需要
 * 补充**尺度**（「这是 3 倍」），不需要重复动作名。
 *
 * ⚠️ 倍数**只在 0.5 的整数倍上**用「N 倍」的说法。
 * 被最小加注额顶上去时倍数会变成 2.5 / 7.3 / 12 这种值 ——
 * 那时写死一个「7.3 倍」对使用者没有意义，不如直接报**底池百分比**，
 * 至少那个数字是可比较的。
 */
function sizeLabelZh(input: {
  mode: 'BET' | 'RAISE';
  toAmount: number;
  pot: number;
  toCall: number;
  isAllIn: boolean;
}): string {
  if (input.isAllIn) return '全下';
  if (input.pot <= 0) return `${input.toAmount} 筹码`;

  if (input.mode === 'BET') {
    return `${Math.round((input.toAmount / input.pot) * 100)}% 底池`;
  }

  if (input.toCall > 0) {
    const mult = input.toAmount / input.toCall;
    // 0.5 的整数倍（2 / 2.5 / 3 / …）才是「干净」的倍数说法
    if (Number.isFinite(mult) && Math.abs(mult * 2 - Math.round(mult * 2)) < 1e-9) {
      return `${Math.round(mult * 10) / 10} 倍`;
    }
  }
  return `${Math.round((input.toAmount / input.pot) * 100)}% 底池`;
}

/** 当前底池（筹码单位） */
export function potOf(state: GameState): number {
  return computePot(state);
}

/** 本街是否处于「面对下注」状态 */
export function facingBet(legal: LegalActions): boolean {
  return legal.callCost > 0;
}

/** 是否已到河牌（用于环境规则筛选） */
export function streetIsRiver(street: Street): boolean {
  return street === Street.RIVER;
}
