/**
 * 对手的翻前动作 → GTOpen 场景（Phase 1.2）
 *
 * ## 为什么需要这一层
 *
 * `GtoScenario` 描述的是「**Hero 是当前行动者**」的节点，而我们要建模的对象是
 * 「**对手在翻前做了什么**」：
 *
 * ```text
 * GtoScenario(RFI, hero=UTG)                = UTG 开池时，UTG 用什么牌开
 * GtoScenario(VS_OPEN, hero=BB, villain=UTG) = UTG 开池后，BB 面对开池怎么打
 * ```
 *
 * 两者是同一棵树上的**不同视角**。这一层负责把「对手做了 X」翻译成
 * 「去问树上的哪一个节点」。
 *
 * ## 🔴 只支持两种，而且**明确说明为什么**
 *
 * | 对手的动作 | 能建模吗 | 用哪个节点 |
 * |---|---|---|
 * | 第一个加注（开池） | ✅ | `RFI`，hero = 开池者 |
 * | 面对**一个**加注选择跟注 / 再加注 | ✅ | `VS_OPEN`，hero = 跟注者，villain = 开池者 |
 * | 多轮加注之后的动作 | ⛔ | 本项目的场景模型表达不了（需要 4Bet+，`max_raises = 2` 下树里也没有） |
 * | 跛入 | ⛔ | `LIMPED` 未支持（求解配置 `limp: false`） |
 * | 盲注位「补盲」 | ⛔ | 那不是主动动作，范围是「还没决定」 |
 *
 * ⛔ 的三种**一律返回 `null`**，由调用方回落启发式先验并**如实标注**。
 * 不做「用相近节点顶替」—— 那正是本项目反复修掉的那类缺陷。
 */

import {
  GtoActionKind,
  GtoScenarioKind,
  gtoPositionsFor,
  type GtoPosition,
  type GtoScenario,
  type GtoScenarioAction,
  type GtoTableSize,
} from '../../domain/gto/gto.types.ts';
import { DEFAULT_OPEN_SIZE_BB, buildGtoScenario } from '../../domain/gto/gtoScenario.ts';
import type { OpponentPreflopAction } from './solverRangePrior.ts';

/** 从本手的前序动作里读出「谁第一个加注、加到多少」 */
export type PreflopShape = {
  /** 第一个主动加注（开池）的座位。没有加注时为 `null` */
  opener: GtoPosition | null;
  /** 开池到的总额（BB） */
  openSizeBB: number | null;
  /** 第二个加注（3Bet）的座位。只有一个加注时为 `null` */
  threeBettor: GtoPosition | null;
  /** 3Bet 到的总额（BB） */
  threeBetSizeBB: number | null;
  /** 加注总次数 */
  raiseCount: number;
};

/**
 * 读出一手牌的**加注骨架**。
 *
 * ⚠️ 只关心加注，不关心弃牌与跟注 —— 因为我们要回答的问题是
 * 「这份范围是在哪个节点上的」，而那由**加注次数**决定。
 */
export function preflopShapeOf(
  tableSize: GtoTableSize,
  history: readonly GtoScenarioAction[],
): PreflopShape {
  const order = gtoPositionsFor(tableSize);
  const raises = history.filter(
    (a) => a.kind === GtoActionKind.RAISE || a.kind === GtoActionKind.ALL_IN,
  );
  const first = raises[0];
  const second = raises[1];
  return {
    opener: first?.position ?? null,
    openSizeBB: first?.sizeBB ?? null,
    threeBettor: second?.position ?? null,
    threeBetSizeBB: second?.sizeBB ?? null,
    raiseCount: raises.length,
  };
}

/**
 * 给一个对手构造他的翻前范围场景。
 *
 * @returns `null` 表示**本项目的场景模型表达不了**（见文件头那张表），
 *          调用方必须回落启发式并如实标注，**不得**用相近节点顶替。
 */
export function scenarioForOpponent(
  tableSize: GtoTableSize,
  effectiveStackBB: number,
  shape: PreflopShape,
  opponent: GtoPosition,
): { action: OpponentPreflopAction; scenario: GtoScenario } | null {
  const order = gtoPositionsFor(tableSize);
  const idx = (p: GtoPosition): number => order.indexOf(p);

  /* ---- 情形 1：他是**第一个**加注的人（开池） ---- */
  if (shape.raiseCount === 1 && shape.opener === opponent && shape.openSizeBB !== null) {
    /*
     * ⚠️ `RFI` 在本项目里**只允许第一个行动位，且前序动作必须为空** ——
     * 那不是这里的限制，而是 `gtoScenario.ts` 里一条刻意的**语义不变量**：
     *
     * ```ts
     * if (spec.kind === GtoScenarioKind.RFI) {
     *   if (actingIndexOf(spec.tableSize, spec.heroPosition) !== 0) return null;
     *   if (history.length !== 0) return null;
     *   if (heroAlreadyActed) return null;
     * }
     * ```
     *
     * 那条不变量存在的理由（原文）：只检查 `defaultActionHistoryFor` 的返回值
     * 不够 —— 显式传 `actionHistory: []` 就能绕过它，于是一个**不存在于树里**
     * 的节点（「6 人桌 HJ 无人入池」）会被伪装成存在，并**拿到别人节点的策略**。
     *
     * 本轮试过用「前面全弃 + 他加注」来表达后位开池（基础目录里有个
     * `FOLD_TO_HERO` 模板看着像能干这个），实测**行不通**：
     * `buildGtoScenario` 会直接返回 `null`。于是后位（CO / BTN…）开池
     * 在本项目的场景模型里确实表达不出来 —— 这是**已知上限**，如实回落。
     */
    const scenario = buildGtoScenario({
      kind: GtoScenarioKind.RFI,
      tableSize,
      effectiveStackBB,
      heroPosition: opponent,
      actionHistory: [],
      openSizeBB: shape.openSizeBB,
    });
    if (scenario === null) return null;
    return {
      action: {
        tableSize,
        position: opponent,
        effectiveStackBB,
        observedOpenSizeBB: shape.openSizeBB,
        observedThreeBetSizeBB: null,
        action: 'OPEN',
        openerPosition: opponent,
      },
      scenario,
    };
  }

  /* ---- 情形 2：面对**一个**加注，他选择跟注 / 再加注 ---- */
  if (
    shape.raiseCount === 1 &&
    shape.opener !== null &&
    shape.openSizeBB !== null &&
    shape.opener !== opponent
  ) {
    /*
     * 他必须在开池者**之后**行动，否则「面对这个开池」不成立。
     * 盲注位在行动顺序里排在最后，因此 BB 面对开池是合法的。
     */
    if (idx(opponent) <= idx(shape.opener)) return null;

    const history: GtoScenarioAction[] = [
      { position: shape.opener, kind: GtoActionKind.RAISE, sizeBB: shape.openSizeBB },
    ];
    const scenario = buildGtoScenario({
      kind: GtoScenarioKind.VS_OPEN,
      tableSize,
      effectiveStackBB,
      heroPosition: opponent,
      villainPosition: shape.opener,
      actionHistory: history,
      openSizeBB: shape.openSizeBB,
    });
    if (scenario === null) return null;
    return {
      action: {
        tableSize,
        position: opponent,
        effectiveStackBB,
        observedOpenSizeBB: shape.openSizeBB,
        observedThreeBetSizeBB: null,
        action: 'CALL_VS_OPEN',
        openerPosition: shape.opener,
      },
      scenario,
    };
  }

  /*
   * ---- 情形 3：**他面对一个加注并且再加注了**（3Bet）----
   *
   * 这里用的是**他自己所在的那个节点**：`VS_OPEN` 节点的 `RAISE` 频率
   * 就是「面对开池时 3Bet 的频率」。这与「他是第一个加注的人」不同 ——
   * 后者用 `RFI` 节点。
   */
  if (
    shape.raiseCount === 1 &&
    shape.opener !== null &&
    shape.openSizeBB !== null &&
    shape.opener !== opponent &&
    idx(opponent) > idx(shape.opener)
  ) {
    /*
     * ⚠️ 这一段与情形 2 的**场景完全相同**，差别只在「取哪个动作的频率」。
     * 因此这里不重复构造，而是由调用方在拿到节点后按 `action` 选频率
     *（见 `solverRangePrior.lookupPreflopRangePrior`）。
     * 保留这个分支只是为了让「意图」在代码里可读。
     */
    const history: GtoScenarioAction[] = [
      { position: shape.opener, kind: GtoActionKind.RAISE, sizeBB: shape.openSizeBB },
    ];
    const scenario = buildGtoScenario({
      kind: GtoScenarioKind.VS_OPEN,
      tableSize,
      effectiveStackBB,
      heroPosition: opponent,
      villainPosition: shape.opener,
      actionHistory: history,
      openSizeBB: shape.openSizeBB,
    });
    if (scenario === null) return null;
    return {
      action: {
        tableSize,
        position: opponent,
        effectiveStackBB,
        observedOpenSizeBB: shape.openSizeBB,
        observedThreeBetSizeBB: null,
        action: 'THREE_BET_VS_OPEN',
        openerPosition: shape.opener,
      },
      scenario,
    };
  }

  return null;
}

/** 项目默认的开池尺寸，导出给探针/测试用 */
export const SOLVER_PRIOR_DEFAULT_OPEN_BB = DEFAULT_OPEN_SIZE_BB;
