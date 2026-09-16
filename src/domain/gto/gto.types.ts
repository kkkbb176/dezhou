/**
 * GTO 领域基础类型
 *
 * ## 这个模块存在的唯一理由
 *
 * 让「理论 GTO 基线」在本项目里成为**一个有类型、有来源、有可信度**的东西，
 * 而不是一段从某个求解器抄过来的数字。
 *
 * ## 三条不可绕过的纪律
 *
 * 1. **业务层不得知道任何求解器的内部 JSON 结构**。
 *    所有外部格式必须在各自的 Provider（适配器）里就地转换成这里定义的类型。
 *    `decisionEngine` / `contextBuilder` / `preflopPriors` / `likelihoodModel` /
 *    `webServer` 只允许依赖 `GtoProvider` 这个**接口**。
 *
 * 2. **宁可返回 `null`，也不编数字**。
 *    求解器没给 EV 就是 `null`；没收敛就如实写 `converged: false`；
 *    求解器用的是近似模型就永远不许标 `VERIFIED`。
 *
 * 3. **真人信息绝不进入理论查询**。
 *    Tilt / 情绪 / 赌性 / 玩家等级 / 近期输赢 / 历史诈唬
 *    属于对手模型与剥削引擎，不属于 GTO Baseline。
 *    `GtoScenario` 里**没有**、也**不允许**有这些字段 ——
 *    这是用类型系统锁死的，而不是靠注释提醒（见 `scenarioIsolation.test.ts`）。
 */

/* ============================================================
 * 牌桌人数（一级场景参数）
 * ============================================================ */

/**
 * 本项目支持求解的牌桌人数。
 *
 * 🔴 **为什么必须单独定义一份，而不是复用 `domain/types.ts` 的 `TableSize`**
 *
 * Alpha 的 `TableSize` 只有 6 / 9 两档，而且它是**录入牌桌**的容量，
 * 已经有 1000+ 项测试与「6 或 9」的硬校验绑在上面。
 * GTO 范围查询需要的档位是 4 / 5 / 6 / 8 / 9 —— 与录入容量是**两个不同的概念**：
 *
 * | 概念 | 含义 | 取值 |
 * |---|---|---|
 * | `TableSize`（Alpha 录入） | 这张桌子**有几个座位** | 6 / 9 |
 * | `GtoTableSize`（求解场景） | 这个理论场景**按几人桌求解** | 4 / 5 / 6 / 8 / 9 |
 *
 * 二者刻意不合并：合并就等于「为了加一个 GTO 页面去改录入层的契约」，
 * 那会波及 reconstruct / validator / 全部桌型测试，属于本轮明确禁止的重写。
 * 桥接只在一个地方发生（`gtoScenario.ts` 的 `gtoTableSizeOfTableSize`），
 * 并且是**单向**的（GTO → Alpha 不做隐式回推）。
 */
export const GtoTableSize = {
  FOUR_MAX: 4,
  FIVE_MAX: 5,
  SIX_MAX: 6,
  EIGHT_MAX: 8,
  NINE_MAX: 9,
} as const;
export type GtoTableSize = (typeof GtoTableSize)[keyof typeof GtoTableSize];

/**
 * 允许的牌桌人数（**顺序即座位顺序的容量顺序**）。
 *
 * 🔴 只有这 5 个值。任何「用 6 人桌代替 5 人桌」的做法都必须在这里被挡住：
 * `gtoTableSizeOf()` 对 7 之类的值返回 `null`，而不是就近取整到 6 或 8。
 * 「就近取整」正是「不同桌人数之间复用未经验证的 Range」的实现方式。
 */
export const GTO_TABLE_SIZES: readonly GtoTableSize[] = Object.freeze([4, 5, 6, 8, 9]);

export function isGtoTableSize(value: unknown): value is GtoTableSize {
  return typeof value === 'number' && (GTO_TABLE_SIZES as readonly number[]).includes(value);
}

/**
 * 把任意数字解释成受支持的牌桌人数；**不支持就返回 `null`**。
 *
 * 刻意不抛异常：调用方（HTTP 处理器 / UI）需要的是一个「不支持」的**可展示状态**，
 * 而不是一个 500。只允许 4 / 5 / 6 / 8 / 9，7 人桌在本轮**不支持**。
 */
export function gtoTableSizeOf(value: unknown): GtoTableSize | null {
  return isGtoTableSize(value) ? value : null;
}

/**
 * 各桌人数的**座位顺序**（从第一个行动的位置到最后一个）。
 *
 * 这张表是本项目位置体系的**唯一权威定义**：
 * - 4 人桌：`CO BTN SB BB`（4 人桌的第一个行动位就是 CO，不额外造 UTG）
 * - 5 人桌：`HJ CO BTN SB BB`
 * - 6 人桌：`UTG HJ CO BTN SB BB`
 * - 8 人桌：`UTG UTG1 LJ HJ CO BTN SB BB`
 * - 9 人桌：`UTG UTG1 UTG2 LJ HJ CO BTN SB BB`
 *
 * ⚠️ 顺序即**翻牌前行动顺序**：数组第一个位置翻牌前第一个行动（UTG / CO / HJ），
 * 最后两个位置**必须**是 SB 与 BB。这一条由
 * `gtoPositionOrderIsBlindsLast()` 与对应测试强制。
 *
 * ⚠️ 位置名用的是本项目的内部写法（`UTG1` / `UTG2`，**不是** `UTG+1`）。
 * 求解器若用别的写法（GTOpen 用 `UTG1` / `MP`），只允许在适配器里映射 ——
 * 见 `gtopenProvider.ts` 的 `POSITION_LABELS`。
 */
export const GTO_POSITION_ORDER: Readonly<Record<GtoTableSize, readonly GtoPosition[]>> =
  Object.freeze({
    4: Object.freeze(['CO', 'BTN', 'SB', 'BB'] as const),
    5: Object.freeze(['HJ', 'CO', 'BTN', 'SB', 'BB'] as const),
    6: Object.freeze(['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'] as const),
    8: Object.freeze(['UTG', 'UTG1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'] as const),
    9: Object.freeze(['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'] as const),
  });

/**
 * 本项目内部位置键（GTO 场景口径）。
 *
 * 与 `domain/types.ts` 的 `Position` 字面量**取值一致**（便于桥接时零转换），
 * 但刻意在这里重新声明：GTO 子域的契约不应该随着 Alpha 位置的增删而漂移，
 * 也不应该让「GTO 位置」这个概念悄悄依赖录入层。
 */
export const GtoPosition = {
  UTG: 'UTG',
  UTG1: 'UTG1',
  UTG2: 'UTG2',
  LJ: 'LJ',
  HJ: 'HJ',
  CO: 'CO',
  BTN: 'BTN',
  SB: 'SB',
  BB: 'BB',
} as const;
export type GtoPosition = (typeof GtoPosition)[keyof typeof GtoPosition];

/** 某桌人数下的全部位置（返回**冻结副本**，调用方改不到权威表） */
export function gtoPositionsFor(tableSize: GtoTableSize): readonly GtoPosition[] {
  return GTO_POSITION_ORDER[tableSize];
}

/** 某桌人数下的位置数量 */
export function gtoSeatCountOf(tableSize: GtoTableSize): number {
  return GTO_POSITION_ORDER[tableSize].length;
}

/**
 * 🔴 不变量：座位顺序的最后两位**必须**是 SB 与 BB。
 *
 * 为什么值得一个专门的函数：盲注位置决定了「谁是庄家、谁翻牌后没位置」，
 * 一旦某个桌型的位置表被写成 `... BB SB`，整套范围会**整体错位一格**，
 * 而名字全都还是合法的位置名 —— 这类错误靠肉眼看名字是看不出来的。
 * 启动自检与测试都调用它。
 */
export function gtoPositionOrderIsBlindsLast(): boolean {
  return GTO_TABLE_SIZES.every((size) => {
    const order = GTO_POSITION_ORDER[size];
    return order.length === size && order[order.length - 2] === 'SB' && order[order.length - 1] === 'BB';
  });
}

/** 位置在本桌型下的座位序号（0 = 翻牌前第一个行动）；不存在返回 `-1` */
export function gtoSeatIndexOf(tableSize: GtoTableSize, position: GtoPosition): number {
  return GTO_POSITION_ORDER[tableSize].indexOf(position);
}

/**
 * 位置在本桌型下是否存在。
 *
 * ⚠️ 这个名字有实际后果：`CO` 在 4/5/6/8/9 人桌都存在，但它**不是同一个决策节点**
 * —— 4 人桌 CO 后面还有 3 家，9 人桌 CO 后面有 5 家。
 * 所以「位置存在」**绝不**意味着「范围可以复用」。
 */
export function gtoPositionExistsAt(tableSize: GtoTableSize, position: GtoPosition): boolean {
  return gtoSeatIndexOf(tableSize, position) >= 0;
}

/* ============================================================
 * 动作
 * ============================================================ */

/**
 * GTO 侧的动作类型。
 *
 * 🔴 刻意与 Alpha 的 `DecisionAction` **分开**，而且**更细**：
 * Alpha 的动作集合是「弃牌 / 过牌 / 跟注 / 下注 / 加注 / 全下」，
 * 而求解器的一个节点上可能有**同一类动作的多个尺寸**
 *（例如「加注到 2.5BB」与「加注到 3.0BB」是两个独立动作）。
 *
 * 如果这里把两者压成一个 `RAISE`，混合策略就丢了 ——
 * 那正是本轮禁止的「把混合策略压缩成单一动作」。
 * 所以尺寸进 `sizeBB`，动作类型本身只表达语义类别。
 */
export const GtoActionKind = {
  FOLD: 'FOLD',
  CHECK: 'CHECK',
  CALL: 'CALL',
  BET: 'BET',
  RAISE: 'RAISE',
  ALL_IN: 'ALL_IN',
} as const;
export type GtoActionKind = (typeof GtoActionKind)[keyof typeof GtoActionKind];

/** 一个动作 + 它的频率（内部统一格式） */
export type GtoActionFrequency = {
  /** 语义类别 */
  kind: GtoActionKind;
  /**
   * 「到多少」的本街总额（BB）。语义与 Alpha 的 `ActionCommand.amount` 一致：
   * **加注到**而不是「加了多少」——避免规范里提过的历史 Bug B12。
   *
   * `null` 表示「这个动作没有金额概念」（弃牌 / 过牌），
   * 或者「求解器没给金额」（此时**不猜**）。
   */
  sizeBB: number | null;
  /** 频率，**0..1**（不是百分数）。见 `assertFrequency01` */
  frequency: number;
  /** EV（BB/手）；求解器没给就是 `null` —— 禁止编造 */
  evBB: number | null;
  /** 求解器侧的原始动作标签（仅用于诊断；业务层不得解析它） */
  rawLabel: string;
};

/**
 * 一手牌（某个 169 类）在一个节点上的完整混合策略。
 *
 * 🔴 `actions` 保留**全部**非零频率动作，**绝不**只留最高频的那个。
 * 混合策略本身就是 GTO 的输出，压缩掉它就等于伪造了一个「纯策略」。
 */
export type GtoHandStrategy = {
  /** 169 类手牌标签，例如 `AA` / `AKs` / `AKo` / `A5s` */
  hand: string;
  /** 该类手牌的**具体组合数**（对子 6 / 同花 4 / 不同花 12） */
  combos: number;
  /**
   * 到达该节点时该类手牌**还剩多少比例**（0..1）。
   * `null` = 求解器没提供 reach（不是 1）。
   */
  reach: number | null;
  /** 全部动作及其频率（含 0 频率动作时由 Provider 决定是否保留；顺序由 Provider 给出） */
  actions: readonly GtoActionFrequency[];
};

/** 一整个节点的范围（= 169 类手牌的策略） */
export type GtoRange = {
  /** 该节点**行动者**的位置 */
  actorPosition: GtoPosition;
  /** 该节点上的动作菜单（不含频率）——用于界面渲染表头 */
  actionMenu: readonly { kind: GtoActionKind; sizeBB: number | null; rawLabel: string }[];
  /** 169 类手牌策略；按标准 169 顺序（见 `gtopenHandMatrix.ts`） */
  hands: readonly GtoHandStrategy[];
  /** 节点底池（BB） */
  potBB: number | null;
  /**
   * 求解器报告的**可达性**：路径是否真的被走到。
   *
   * `false` 表示这条路径在当前模型/策略下永远不会发生（例如 UTG 从不用 4bet），
   * 此时频率表没有策略含义 —— 界面必须显示原因，**不得**把它当成一个策略。
   */
  reachable: boolean;
  /** 不可达 / 无策略时的**原始原因**（求解器原文），可达时为 `null` */
  unavailableReason: string | null;
};

/* ============================================================
 * 场景
 * ============================================================ */

/**
 * 盲注结构（BB 口径）。
 *
 * 内部统一用 **BB**：`sb = 0.5` / `bb = 1`。所有与求解器交换的数字都在这套口径上，
 * 「筹码」只是界面换算（与 Alpha 的 `bigBlindBB` 同一精神）。
 */
export type GtoBlindStructure = {
  /** 小盲（BB）：常规为 0.5 */
  sbBB: number;
  /** 大盲（BB）：恒为 1（它是单位本身） */
  bbBB: number;
  /** 每人死注（BB）；0 表示无 ante */
  anteBB: number;
};

/** 标准盲注结构（无 ante） */
export const GTO_STANDARD_BLINDS: GtoBlindStructure = Object.freeze({
  sbBB: 0.5,
  bbBB: 1,
  anteBB: 0,
});

/** 场景里的一个前序动作（与 Alpha 的 `ManualAction` 语义一致：金额是「到多少」） */
export type GtoScenarioAction = {
  position: GtoPosition;
  kind: GtoActionKind;
  /** 「到多少」的本街总额（BB）；`null` 表示该动作无金额 */
  sizeBB: number | null;
};

/** 场景类型（本项目的场景目录） */
export const GtoScenarioKind = {
  /** 无人入池时的首个加注（Raise First In） */
  RFI: 'RFI',
  /** 面对一个开池加注 */
  VS_OPEN: 'VS_OPEN',
  /**
   * 🔴 **Phase 1.1 新增**：你**自己**做 3Bet（前面有人开池）。
   *
   * ## ⚠️ 这个取值在本项目里**永远是未支持**的，而且理由不是「做不到」
   *
   * 它描述的是「Hero 3Bet 之后，行动又回到 Hero」——
   * 但那样的节点在求解器的树里**根本不存在**。
   *
   * 源码 `crates/solver/src/preflop/mod.rs` 的 `next_state_of()`：
   *
   * ```rust
   * ns.needs = ((1u32 << n) - 1) & !ns.folded & !ns.allin & !(1 << actor);
   * ```
   *
   * 一次加注为**除加注者之外**的每个活人重新打开行动。3Bettor 是最后一个
   * 加注者，所以他不会被再次叫到 —— 一圈人弃牌之后，行动回到**开池者**
   *（他去面对那个 3Bet）。
   *
   * 实测确认（6 人桌，`scripts/gto-node-walk.raw.mjs`）：
   *
   * ```text
   * UTG 加注 2.5 → HJ 3Bet 7.5 → CO 弃 → BTN 弃 → SB 弃 → BB 弃 → 行动者是 UTG
   * ```
   *
   * 因此保留这个取值**只是为了让上面这条结论有一个可命名的位置**，
   * 而不是留一个「以后可能会用」的钩子：`GTOPEN_CAPABILITY_TABLE` 里
   * 它恒为 `UNSUPPORTED`，目录里不生成任何条目。
   *
   * 真正可读的那个节点是 `VS_3BET` —— 但那里 Hero 是**开池者**。
   */
  THREE_BET: 'THREE_BET',
  /**
   * 面对一个 3Bet。
   *
   * 🔴 在本项目里它读的是「**Hero 开池 → 有人 3Bet → 行动回到 Hero**」，
   * 也就是 Hero 是**开池者**（`heroAlreadyActed = true`）。
   * 几何与实测证据见 `gtoScenario.ts` 的 `defaultActionHistoryFor`。
   */
  VS_3BET: 'VS_3BET',
  /**
   * 🔴 **Phase 1.1 新增**：面对一个 4Bet。
   *
   * ⚠️ 4Bet 要求动作树支持**三次加注**（开池 + 3Bet + 4Bet），
   * 也就是 `max_raises >= 3`。本阶段的生产配置是 `max_raises = 2`，
   * 因此**默认配置下 4Bet 在树里不存在** —— 探针会如实报 `UNSUPPORTED`，
   * 而不是伪造一条路径。
   */
  VS_4BET: 'VS_4BET',
  /** 无人下注时的过牌 / 跟注（跛入池） */
  LIMPED: 'LIMPED',
} as const;
export type GtoScenarioKind = (typeof GtoScenarioKind)[keyof typeof GtoScenarioKind];

/**
 * 🔴 理论 GTO 场景 —— **真人信息禁止进入这里**。
 *
 * 这个类型里**没有**、也**不允许**出现以下字段：
 * `tilt` / `emotion` / `gamble` / `playerLevel` / `recentResult` /
 * `habit` / `bluffHistory` / `quickProfile` / `dynamicHint` / `playerId`。
 *
 * 为什么用类型而不是注释来保证：
 * 一旦有人往这里加 `tilt: number`，`scenarioHashOf()` 就会把它算进哈希，
 * 于是「同一个理论场景」会因为对手昨天输了钱而返回不同的 GTO 基线 ——
 * 那不是 GTO，那是把剥削伪装成理论。
 * 测试 `gtoContextIsolation.test.ts` 会用一个**带完全部真人字段**的
 * Alpha 输入去查询基线，要求结果与「把真人字段全部清空」时**逐位一致**。
 */
export type GtoScenario = {
  /** 场景类型（RFI / VS_OPEN / …） */
  kind: GtoScenarioKind;
  /** 游戏类型：Cash Game（本轮只支持现金局，锦标赛/短牌不支持） */
  gameType: 'CASH';
  /** 牌桌人数 —— **一级参数**，参与哈希与缓存键 */
  tableSize: GtoTableSize;
  /** 有效筹码（BB） */
  effectiveStackBB: number;
  /** Hero 的位置 */
  heroPosition: GtoPosition;
  /** 主要对手的位置；无特定对手时为 `null` */
  villainPosition: GtoPosition | null;
  /** 前序动作序列（按发生顺序） */
  actionHistory: readonly GtoScenarioAction[];
  /** 本场景涉及的加注尺寸（BB，「到多少」）；无加注时为 `[]` */
  raiseSizesBB: readonly number[];
  /** 盲注结构 */
  blinds: GtoBlindStructure;
  /**
   * 🔴 **Phase 1.1**：Hero 在本节点之前**已经行动过**（且没有弃牌）。
   *
   * ## 为什么需要这个字段
   *
   * Phase 1 的场景模型只能表达「Hero 是当前行动者」。它挡住了**一整类真实节点**，
   * 最典型的是：
   *
   * ```text
   * BTN 加注 2.5 → SB 弃牌 → BB 3Bet 7.5 → BTN 面对 3Bet   ← Hero = BTN
   * ```
   *
   * 这里 Hero（BTN）已经行动过（他开的池），3Bet 的人排在他之后。
   * 树上没有「Hero」这个概念 —— 节点只是「谁在行动」，
   * 因此这个节点就是「BTN 再次行动」，需要额外一个字段说明
   * 「Hero 在本节点之前已经出过手」。
   *
   * ## 与校验的关系
   *
   * `false`（默认）⇒ Phase 1 的全部校验**逐字生效**；
   * `true` ⇒ 走**独立的、更严的**那套规则（见 `validatePriorActions`）。
   * 这不是「放宽校验」，而是**新增一条分支**：
   * 删除原来的判断会让所有非法历史（含真正的 Hero/Villain 反转）一起进来。
   */
  heroAlreadyActed: boolean;
};

/* ============================================================
 * 求解状态与可信度
 * ============================================================ */

/**
 * 求解状态（**求解器侧的客观事实**，不是我们的判断）。
 *
 * `UNAVAILABLE` 是本项目特有的第一公民：它表示「拿不到可信基线」，
 * 与「求解失败」和「场景不支持」在**处置上是同一个结果**（回退到 Alpha 原引擎），
 * 但在**诊断上必须分开**，否则「为什么今天没有 GTO 数据」无法追溯。
 */
export const GtoSolveStatus = {
  /** 求解器报告已收敛 / 达到其自身判据 */
  SOLVED: 'SOLVED',
  /** 求解器给出了策略，但**未达到**收敛判据（例如迭代上限用尽） */
  RUNNING: 'RUNNING',
  /** 求解器明确拒绝该场景（不支持的人数 / 动作树 / 配置） */
  UNSUPPORTED: 'UNSUPPORTED',
  /** 求解器在，但求解过程报错 */
  FAILED: 'FAILED',
  /** 求解器不在（进程没启动 / 连接被拒） */
  OFFLINE: 'OFFLINE',
  /** 求解器在，但响应超时 */
  TIMEOUT: 'TIMEOUT',
  /** 拿到了响应，但内容不合法 / 不完整 / 与请求的场景不符 */
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  /**
   * **统一回退码**：任何「不能作为可信 GTO 基线使用」的情形都归到这里。
   *
   * 这个取值存在的意义：调用方只需要判断 `status === 'GTO_BASELINE_UNAVAILABLE'`
   * 就能决定回退，而不必枚举上面 7 种失败原因 ——
   * 「新增一种失败原因就漏掉一处回退分支」是本项目明确要避免的缺陷形态。
   */
  GTO_BASELINE_UNAVAILABLE: 'GTO_BASELINE_UNAVAILABLE',
} as const;
export type GtoSolveStatus = (typeof GtoSolveStatus)[keyof typeof GtoSolveStatus];

/**
 * 可信度等级（**由我们根据来源与求解器自述判定**）。
 *
 * 规则（`verificationOf()` 是唯一实现）：
 *
 * | 情形 | 等级 |
 * |---|---|
 * | 求解器用了近似模型（GTOpen 的翻前就是） | 最高只能到 `APPROXIMATE` |
 * | 拿到了数据但没有任何来源信息 / 未收敛 | `UNVERIFIED` |
 * | 已收敛且模型为精确模型 | `SOLVED` |
 * | 被**第二个独立求解器**交叉验证过 | `CROSS_CHECKED` |
 * | 人工复核 + 双求解器一致 + 精确模型 | `VERIFIED` |
 *
 * 🔴 本阶段 GTOpen 的翻前结果**永远不可能**达到 `SOLVED` 以上：
 * 它的翻前用的是「equity-realization 近似延续模型」
 *（源码 `crates/solver/src/preflop/mod.rs` 顶部注释与
 * `coupled_deck_v1` 声明了这一点）—— 近似模型不得标 VERIFIED，这是硬规则。
 */
export const GtoVerification = {
  UNVERIFIED: 'UNVERIFIED',
  APPROXIMATE: 'APPROXIMATE',
  SOLVED: 'SOLVED',
  CROSS_CHECKED: 'CROSS_CHECKED',
  VERIFIED: 'VERIFIED',
} as const;
export type GtoVerification = (typeof GtoVerification)[keyof typeof GtoVerification];

/** 可信度的强弱顺序（数值越大越可信）；`VERIFIED` 是最高档 */
export const GTO_VERIFICATION_RANK: Readonly<Record<GtoVerification, number>> = Object.freeze({
  UNVERIFIED: 0,
  APPROXIMATE: 1,
  SOLVED: 2,
  CROSS_CHECKED: 3,
  VERIFIED: 4,
});

/** 取两个可信度里**更保守**的那个（用于「上游封顶」） */
export function minVerification(a: GtoVerification, b: GtoVerification): GtoVerification {
  return GTO_VERIFICATION_RANK[a] <= GTO_VERIFICATION_RANK[b] ? a : b;
}

/** 中文显示名（界面用；i18n 可覆盖） */
export const GTO_VERIFICATION_ZH: Readonly<Record<GtoVerification, string>> = Object.freeze({
  UNVERIFIED: '未验证',
  APPROXIMATE: '近似求解',
  SOLVED: '已求解',
  CROSS_CHECKED: '已交叉验证',
  VERIFIED: '已验证',
});

/**
 * 近似标记（结构化，不是一句文案）。
 *
 * 这些标记会**逐条**出现在界面上。任何一条为 `true` 都不允许显示「绝对 GTO」。
 */
export type GtoApproximationFlags = {
  /** 求解器自身声明使用了近似模型（GTOpen 翻前恒为 true） */
  approximateModel: boolean;
  /** 未达到求解器自身的收敛判据 */
  notConverged: boolean;
  /** 桌面人数 ≥3（多人池的延续模型是近似，不是精确多人求解） */
  multiwayContinuation: boolean;
  /** 数值精度被压缩（例如求解器用了压缩/量化模型） */
  compressedPrecision: boolean;
  /** 结果来自缓存（缓存的是同一次求解的输出，不是重新求解） */
  fromCache: boolean;
  /** 人类可读的逐条说明（中文） */
  notes: readonly string[];
};

/** 空标记（全部为 false） */
export const GTO_NO_APPROXIMATION: GtoApproximationFlags = Object.freeze({
  approximateModel: false,
  notConverged: false,
  multiwayContinuation: false,
  compressedPrecision: false,
  fromCache: false,
  notes: Object.freeze([] as string[]),
});

/* ============================================================
 * 来源与元数据
 * ============================================================ */

/**
 * 数据来源。
 *
 * `engine` 是**机器可读的短名**（`gtopen` / `other-solver` / `our-solver`），
 * 刻意不做成联合字面量：第二求解器（`chirenonhive/poker-solver`）接入时
 * 只需要新增一个 Provider，**不需要**改这里，也不需要改 Decision Engine。
 * 这正是「禁止散布 `if engine == GTOPEN`」的实现方式。
 */
export type GtoSource = {
  /** 来源类别：理论求解器输出（对应知识层 `KnowledgeSourceType.SOLVER_OUTPUT`） */
  kind: 'SOLVER';
  /** 引擎短名（小写、稳定、机器可读；界面文案另由 metadata 提供） */
  engine: string;
  /** 引擎自述版本（求解器没给就是 `null`） */
  sourceVersion: string | null;
  /** 引擎 commit SHA（拿不到就是 `null` —— **不编**） */
  engineCommit: string | null;
  /** 引擎的 HTTP 端点（诊断用；业务层不得据此分支） */
  endpoint: string | null;
};

/** 求解设置（求解器侧的全部输入，用于复现与审计） */
export type GtoSolveSettings = {
  /** 请求的迭代上限；求解器不接受迭代概念时为 `null` */
  iterationsRequested: number | null;
  /** 求解器报告的实际迭代数 */
  iterationsCompleted: number | null;
  /** 收敛目标（求解器口径） */
  targetGap: number | null;
  /** 求解器报告的收敛指标（原样保留，不解释） */
  reportedGap: number | null;
  /** 求解器自述的模型名（例如 `coupled_deck_v1`） */
  modelName: string | null;
  /** 盲注 / 底池 / 尺寸等输入的原样记录 */
  raw: Readonly<Record<string, unknown>>;
};

/** 元数据（每次结果必须带全） */
export type GtoMetadata = {
  source: GtoSource;
  /** 场景哈希（含桌人数）——缓存键与去重的唯一依据 */
  scenarioHash: string;
  solveSettings: GtoSolveSettings;
  /** 求解状态 */
  solveStatus: GtoSolveStatus;
  /** 可信度等级 */
  verification: GtoVerification;
  /** 近似标记 */
  approximation: GtoApproximationFlags;
  /** 结果产生时间（ISO 8601，由**注入的时钟**给出，保证可测） */
  timestamp: string;
  /** 端到端耗时（毫秒） */
  latencyMs: number;
};

/* ============================================================
 * 统一基线
 * ============================================================ */

/** 一次成功查询的返回体 */
export type GtoBaseline = {
  /** 我们请求的场景（**已归一化**，可直接参与哈希） */
  scenario: GtoScenario;
  /** 场景哈希 = `scenarioHashOf(scenario)` */
  scenarioHash: string;
  /** 该场景下求解器实际求解的节点范围 */
  range: GtoRange;
  /** 全部元数据 */
  metadata: GtoMetadata;
};

/** 查询失败的返回体（**不是异常**：Alpha 必须能带着它继续工作） */
export type GtoUnavailable = {
  status: typeof GtoSolveStatus.GTO_BASELINE_UNAVAILABLE;
  /** 具体原因（上面 7 种之一）——诊断用 */
  cause: GtoSolveStatus;
  /** 中文说明（可直接显示给使用者） */
  message: string;
  /** 请求的场景（原样回显，便于界面显示「哪个场景没拿到」） */
  scenario: GtoScenario;
  /** 场景哈希 */
  scenarioHash: string;
  /** 尽力提供的元数据（例如「离线」时 source.engine 仍有值） */
  metadata: GtoMetadata;
};

export type GtoLookupResult = GtoBaseline | GtoUnavailable;

/**
 * 类型守卫：是否是「拿不到基线」。
 *
 * ⚠️ 实现刻意用 `'status' in result` 先做存在性判断，而不是直接读
 * `result.status` —— 成功结果 `GtoBaseline` **没有** `status` 字段，
 * 直接读会编译失败（这正是我们想要的：类型系统不允许把两者混为一谈）。
 * 存在性收窄之后，再比较那个唯一可能的值。
 */
export function isGtoUnavailable(result: GtoLookupResult): result is GtoUnavailable {
  return 'status' in result && result.status === GtoSolveStatus.GTO_BASELINE_UNAVAILABLE;
}

/* ============================================================
 * Provider 接口（唯一调用入口）
 * ============================================================ */

/**
 * 「求解侧参数」的**结构契约**（实现在 `gtoScenario.ts`）。
 *
 * 放在这里是为了让 `GtoProvider` 接口不必 import `gtoScenario.ts`
 * （那会造成领域层内部的循环依赖风险）。结构完全相同，可直接互换。
 */
export type GtoSolveKeyParts = {
  engine: string;
  engineCommit: string | null;
  solverVersion: string | null;
  openSizesBB: readonly number[];
  raiseMults: readonly number[];
  maxRaises: number;
  limp: boolean;
  addAllin: boolean;
  rakePct: number;
  rakeCap: number;
  realization: string;
  multiwayEquityModel: string | null;
  iterations: number;
  targetGap: number;
  checkEvery: number;
  enginePositions: readonly string[];
  posts: readonly number[];
  ante: number;
};

/** 健康检查结果 */
export type GtoProviderHealth = {
  /** 引擎是否可达 */
  reachable: boolean;
  /** 引擎短名 */
  engine: string;
  /** 引擎自述版本（拿不到为 `null`） */
  version: string | null;
  /** commit SHA（拿不到为 `null`） */
  commit: string | null;
  /** 端点 */
  endpoint: string | null;
  /** 中文说明（不可达时说明原因） */
  message: string;
};

/** 求解能力自述（来自求解器自己的能力端点，字段由各 Provider 自行转换） */
export type GtoEngineCapabilities = {
  engine: string;
  /** 支持的人数（**必须来自引擎自述或源码核对，不得假定**） */
  supportedTableSizes: readonly number[];
  /** 支持的场景类型 */
  supportedScenarioKinds: readonly GtoScenarioKind[];
  /** 引擎自述「翻前使用近似延续模型」 */
  preflopApproximateModel: boolean;
  /** 引擎自述的模型名 */
  modelName: string | null;
  /** 原始响应（诊断用） */
  raw: Readonly<Record<string, unknown>>;
};

/**
 * 🔴 **唯一允许 Alpha 接触 GTO 数据的接口**。
 *
 * `decideAlpha` / `buildDecisionContext` / `preflopPriors` / `likelihoodModel` /
 * `webServer` / 前端 **一律只能**依赖这个接口，
 * 不得 import 任何具体 Provider，更不得直接发 HTTP。
 *
 * 这条纪律由 `test/gtoScenarioIsolation.test.ts` 静态扫描源码目录强制：
 * 除 `src/domain/gto/providers/**` 之外，
 * 任何文件出现求解器端点路径片段都会被判失败。
 */
export type GtoProvider = {
  /** 引擎短名（用于显示与诊断；**不得**用于业务分支） */
  readonly engine: string;
  /** 人类可读的引擎说明（中文） */
  readonly displayName: string;
  /** 健康检查 */
  health: () => Promise<GtoProviderHealth>;
  /** 能力自述 */
  capabilities: () => Promise<GtoEngineCapabilities | null>;
  /** 查询一个理论场景的 GTO 基线 */
  lookupScenario: (scenario: GtoScenario) => Promise<GtoLookupResult>;
  /**
   * 🔴 **Phase 1.1 新增**：本次查询会用到的**求解侧参数**。
   *
   * ## 为什么必须由 Provider 提供，而不是由缓存层自己拼
   *
   * 缓存键必须包含「所有会改变策略结果的输入」。其中一部分只有 Provider 知道：
   * 引擎 commit、**按桌人数标定**的迭代数、是否为这张桌子打开全下、
   * 求解器侧的 positions/posts 定义、延续模型、多人权益模型……
   *
   * 如果让上层自己拼，就会出现「上层以为迭代数是 60、Provider 实际发了 12」
   * 这种情况 —— 于是缓存键描述的不是**真正发生的那次求解**，命中判定就是错的。
   *
   * 因此：**谁决定参数，谁提供描述**。
   *
   * @param scenario 目标场景（因为「按桌人数标定」的项依赖它）
   */
  solveKeyParts: (scenario: GtoScenario) => GtoSolveKeyParts;
};

/* ============================================================
 * 未来融合接口（本轮只预留，不接入 Decision Engine）
 * ============================================================ */

/**
 * 剥削调整（来自对手模型 / 动态层）。
 *
 * ⚠️ 本轮**不实现**任何实际的剥削幅度计算 —— 结构先立起来，
 * 是为了让「GTO 基线」与「剥削调整」在类型层面**永远分得开**。
 */
export type ExploitAdjustment = {
  /** 调整方向 */
  direction: 'TOWARD_MORE_AGGRESSION' | 'TOWARD_LESS_AGGRESSION' | 'NONE';
  /**
   * 幅度。**没有可靠量化依据时必须为 `null`** ——
   * 与知识层的 `magnitude` 是同一条纪律（见 `knowledge.types.ts`）。
   */
  magnitude: number | null;
  /** 依据说明 */
  rationale: string;
};

/** 对手范围估计（来自现有 Alpha 的 preflopPriors / 范围更新链） */
export type OpponentEstimate = {
  position: GtoPosition;
  /** 估计来源（Alpha 现有口径） */
  sourceKind: string;
  /** 来源可信度 0..1 */
  confidence: number;
  /** 有效组合数 */
  combos: number;
};

/** 最终策略 = GTO 基线 + 对手估计 + 剥削调整 */
export type FinalStrategy = {
  /** 最终动作 */
  action: GtoActionKind | null;
  /** 尺寸（BB） */
  sizeBB: number | null;
  /** 混合频率（保留） */
  frequencies: readonly GtoActionFrequency[];
  /** 是否真的做了剥削调整 */
  exploited: boolean;
};

/**
 * GTO 距离（当前打法离理论基线多远）。
 *
 * 🔴 **无法严谨计算时返回 `null`**。
 * 「距离」需要频率空间上的一个距离度量，而本轮既没有对手的真实频率，
 * 也没有第二求解器做交叉验证 —— 因此本阶段**恒为 `null`**。
 * 编一个「距离 0.37」出来是本项目明确禁止的。
 */
export type GtoDistance = {
  /** 距离度量名（例如 `l1_frequency`） */
  metric: string;
  value: number;
} | null;
