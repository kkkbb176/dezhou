/**
 * 引擎能力声明（**我们这一侧的**声明，不是从 README 抄的）
 *
 * ## 为什么需要这个文件，而不是直接读求解器的响应
 *
 * GTOpen 的 `/api/preflop/capabilities` 只返回四个布尔/数组字段
 * （`raise_multiples` / `model_evidence_sizing` / `early_preview_v1` /
 * `fresh_build_multiway_models`），它**不会**告诉你：
 *
 * - 支持哪几种牌桌人数（源码是 `2..=9`，但那是校验，不是「验证过的能力」）
 * - 翻前用的是**近似延续模型**而不是完整多人求解
 * - 哪些场景在本项目里被我们**验证过**
 *
 * 这些结论只能来自阅读源码 + 实际运行。因此它们必须写在一个**显式的地方**，
 * 带上「依据是什么」，而不是散落在代码注释里 ——
 * 那样下一轮的人（或未来的我）无法判断某条结论是否还有效。
 *
 * ## 🔴 最重要的一条：翻前是近似模型
 *
 * `GTOopen/GTOpen/crates/solver/src/preflop/mod.rs` 文件头（逐字）：
 *
 * > Solves the configured 2..9-player action tree with **modeled continuation
 * > payoffs, not a full postflop game**. New 3+ player leaves use a fixed
 * > **coupled deck rank approximation** that divides one pot, net of rake. …
 * > The 169-class chance model **ignores joint card removal**. Coupled ranks
 * > improve broad-range equity but can still err substantially for overlapping
 * > narrow ranges. Multiway continuation is **showdown value, not learned
 * > postflop EV**. DCFR reports each seat's best-response gap against these
 * > model payoffs; a small gap **is not evidence of an accurate poker model or
 * > a Nash equilibrium**.
 *
 * 也就是说：**即使求解器的自述 gap 收敛到 0，它收敛的也是那个近似模型内部
 * 的均衡**，不是真实扑克的均衡。因此：
 *
 * - `preflopApproximateModel` 恒为 `true`
 * - 翻前结果的可信度**上限是 `APPROXIMATE`**，永远到不了 `SOLVED` / `VERIFIED`
 *
 * 这一条由 `verificationForPreflop()` 实现，并且有测试锁住。
 */

import { GtoScenarioKind, type GtoTableSize } from '../gto.types.ts';

/** 某个桌人数下的验证状态 */
export const GtoSupportLevel = {
  /** 已用真实求解器验证：能建树、能求解、能读到 169 类策略 */
  SUPPORTED: 'SUPPORTED',
  /** 能跑，但存在已知的近似或未验证的部分 */
  APPROXIMATE: 'APPROXIMATE',
  /** 求解器或本项目明确不支持 */
  UNSUPPORTED: 'UNSUPPORTED',
  /** 尚未验证（**不得**当作支持） */
  UNVERIFIED: 'UNVERIFIED',
} as const;
export type GtoSupportLevel = (typeof GtoSupportLevel)[keyof typeof GtoSupportLevel];

export const GTO_SUPPORT_LEVEL_ZH: Readonly<Record<GtoSupportLevel, string>> = Object.freeze({
  SUPPORTED: '支持',
  APPROXIMATE: '近似支持',
  UNSUPPORTED: '不支持',
  UNVERIFIED: '未验证',
});

/** 引擎自述 + 本项目实测的能力总表 */
export type GtoEngineCapabilityTable = {
  /** 引擎短名 */
  engine: string;
  /** 引擎自述的支持人数（来自源码校核：`validate()` 是 `2..=9`） */
  engineTableSizeRange: { min: number; max: number };
  /**
   * **本项目验证过**的桌人数。
   *
   * ⚠️ 与 `engineTableSizeRange` 是两件事：源码允许 2..9，
   * 但本项目只声明自己**实际跑过并核对过结果**的那几档。
   * 7 人桌在源码里是合法配置，在本项目里是 `UNSUPPORTED`（本轮范围外）。
   */
  verifiedTableSizes: readonly GtoTableSize[];
  /** 各场景类型的支持级别 */
  scenarioSupport: Readonly<Record<GtoScenarioKind, GtoSupportLevel>>;
  /** 翻前是否使用近似延续模型 —— **恒为 true**，见文件头 */
  preflopApproximateModel: boolean;
  /** 求解器自述的多人权益模型名（源码默认 `coupled_deck_v1`） */
  multiwayEquityModel: string;
  /** 逐条依据（中文，指向源码位置或实测证据） */
  evidence: readonly string[];
};

/**
 * 本项目对 GTOpen 的能力声明。
 *
 * `verifiedTableSizes` 在**验证完成后**才会填全；
 * 在此之前它只包含已经真正跑通的那几档 —— 这份表本身也是证据的一部分。
 */
export const GTOPEN_CAPABILITY_TABLE: GtoEngineCapabilityTable = Object.freeze({
  engine: 'gtopen',
  engineTableSizeRange: Object.freeze({ min: 2, max: 9 }),
  verifiedTableSizes: Object.freeze([4, 5, 6, 8, 9] as const),
  scenarioSupport: Object.freeze({
    [GtoScenarioKind.RFI]: GtoSupportLevel.SUPPORTED,
    [GtoScenarioKind.VS_OPEN]: GtoSupportLevel.SUPPORTED,
    /**
     * 🔴 Phase 1.1 第二轮：「Hero 自己做 3Bet」—— **不是可达节点**。
     *
     * 这个取值**不是**「以后可能会用」的钩子，而是给一条实测结论
     * 一个可命名的位置：
     *
     * 求解器源码 `crates/solver/src/preflop/mod.rs` 的 `next_state_of()`：
     *
     * ```rust
     * ns.needs = ((1u32 << n) - 1) & !ns.folded & !ns.allin & !(1 << actor);
     * ```
     *
     * 一次加注只为**除加注者之外**的每个活人重新打开行动。3Bettor 是
     * 最后一个加注者，所以他**永远不会**再被叫到 —— 一圈人弃牌之后，
     * 行动回到的是**开池者**（他去面对那个 3Bet）。
     *
     * 实测确认（6 人桌，`scripts/gto-node-walk.raw.mjs`）：
     *
     * ```text
     * UTG 加注 2.5 → HJ 3Bet 7.5 → CO/BTN/SB/BB 弃 → 行动者是 UTG，不是 HJ
     * ```
     *
     * 因此目录里**没有**这个模板，界面也拿不到它的入口。
     * 要读「Hero 用哪些牌 3Bet」，读 `VS_OPEN` 节点上的 `RAISE` 项 ——
     * 那个节点的菜单本来就是 `Fold / Call / 3-bet / All-in`。
     */
    [GtoScenarioKind.THREE_BET]: GtoSupportLevel.UNSUPPORTED,
    /**
     * 🔴 Phase 1.1 第二轮：**UNSUPPORTED**，但理由**不是**「我们的模型表达不了」。
     *
     * 几何已经构造正确、也被真实求解器走到过 17/17
     *（`reports/evidence/gto-vs3bet-live-evidence.txt`）。真正的理由是**配置**：
     *
     * - 走到这个节点只需要 2 次加注，所以 `max_raises = 2` 下**能走到**；
     * - 但走到之后，开池者的菜单退化成**只有 `Fold · Call`**
     *   （4Bet 需要第 3 次加注；开池者自己也已经加注过，无法再全下）；
     * - 把「只能弃牌或跟注」当作「面对 3Bet 的 GTO 策略」，
     *   正是本项目禁止的「用残缺数据冒充完整答案」。
     *
     * 另一个硬约束：只有**第一个行动位**能面对 3Bet。实测
     * `HJ 开池 → CO 3Bet → BTN/SB/BB 弃 → UTG 弃` 之后**牌局结束**，
     * HJ 再也没有轮到 —— 因为 UTG 还没行动过，他才是那一圈的收口人。
     *
     * 因此 `requiredMaxRaises` 对 `VS_3BET` 取 **3** ——
     * 它的语义是「读出**完整**策略所需的加注层数」，不是「能走到所需的层数」。
     */
    [GtoScenarioKind.VS_3BET]: GtoSupportLevel.UNSUPPORTED,
    /**
     * 🔴 Phase 1.1：**UNSUPPORTED**（当前配置下）。
     *
     * 4Bet 需要 `max_raises >= 3`，而本阶段生产配置是 2。
     * 这是**配置导致的**不支持，不是原理性限制 ——
     * 报告里明确写出「把 max_raises 提到 3 并接受更长求解时间即可用」。
     */
    [GtoScenarioKind.VS_4BET]: GtoSupportLevel.UNSUPPORTED,
    [GtoScenarioKind.LIMPED]: GtoSupportLevel.UNSUPPORTED,
  }),
  preflopApproximateModel: true,
  multiwayEquityModel: 'coupled_deck_v1',
  evidence: Object.freeze([
    '源码 crates/solver/src/preflop/mod.rs 文件头：翻前是「modeled continuation payoffs, not a full postflop game」',
    '源码 crates/solver/src/preflop/mod.rs：3 人以上底池用 coupled_deck_v1 的 1024 个确定性潜在强度样本，不是真实共同发牌',
    '源码 crates/solver/src/preflop/mod.rs：169 类机会模型忽略联合去牌效应（joint card removal）',
    '源码 crates/solver/src/preflop/mod.rs 的 validate()：positions 只校验 2..=9 与 posts 对齐，位置名不参与求解',
    '源码 crates/solver/src/preflop/equity.rs 的 class_index()/class_parts()：169 类索引方向',
  ]),
});

/**
 * 🔴 翻前结果的可信度**上限**。
 *
 * 依据见文件头：翻前求解的是一个近似延续模型，收敛也只是该模型内部的均衡。
 * 因此这里返回的不是「这次求解的质量」，而是**整个翻前路径的天花板**。
 *
 * 任何把翻前结果标成 `SOLVED` / `VERIFIED` 的实现都是错的 ——
 * 包括「求解器说它 done 了」这种情况。
 */
export const GTOPEN_PREFLOP_MAX_VERIFICATION = 'APPROXIMATE' as const;

/** 该桌人数是否被本项目验证过 */
export function isTableSizeVerified(tableSize: number): boolean {
  return (GTOPEN_CAPABILITY_TABLE.verifiedTableSizes as readonly number[]).includes(tableSize);
}

/** 该场景类型在指定桌人数下的支持级别 */
export function supportLevelFor(
  kind: GtoScenarioKind,
  tableSize: number,
): GtoSupportLevel {
  if (!isTableSizeVerified(tableSize)) return GtoSupportLevel.UNSUPPORTED;
  return GTOPEN_CAPABILITY_TABLE.scenarioSupport[kind] ?? GtoSupportLevel.UNVERIFIED;
}
