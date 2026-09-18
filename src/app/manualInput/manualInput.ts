/**
 * 最小手动输入（Minimal Manual Input）—— 第一版
 *
 * ## 这个模块在端到端链中解决什么
 *
 * 把**人手动填写的表单**变成 `ManualHandInput`（强类型结构），
 * 再由 `reconstruct.ts` 重建成可校验的 `GameState`。
 *
 * 它是整条链的入口。没有它，后面所有模块都无从运行。
 *
 * ## 为什么第一版是结构化输入，不做自然语言解析
 *
 * 明确裁定：**先做结构化输入**。
 * 理由是自然语言解析的错误率无法用测试锁定（同一句话有多种合理理解），
 * 而一个「输入经常被解析错」的决策系统比没有输入更危险。
 *
 * ## 关键纪律
 *
 * 1. **不猜**。用户输入 `7d` 且公共牌也有 `7d` 时**阻断**，
 *    绝不替他改成 `7h`。
 * 2. **全部错误用中文**，且说明**具体冲突内容**。
 * 3. 本文件**只做解析与结构校验**（格式层面的问题）。
 *    牌局规则层面的校验（重复牌、底池对不上、行动序列非法）
 *    由既有的 `validator.ts` 负责 —— 不在这里重复实现。
 */

import {
  TableSize,
  Position,
  Street,
  type Card,
  type Rank,
  type Suit,
  CHAR_RANKS,
  positionsForTableOf,
} from '../../domain/types.ts';
import type { GameEnvironmentId } from '../../domain/knowledge/knowledge.types.ts';
/*
 * ⚠️ **type-only** 导入：`behaviorProfile.ts` 反向 `import type { QuickProfile }`
 * 自本文件，两者都是纯类型引用，经类型擦除后**不存在运行时环**。
 */
import type { PlayerBehaviorProfile } from '../../domain/player/behaviorProfile.ts';
import type { PlayerObservedStats } from '../../domain/player/observedStats.ts';

/* ============================================================
 * 牌面文本解析
 * ============================================================ */

/** 牌面文本 → Card；无法识别返回 null（**不猜测**） */
export function parseCardCode(code: string): Card | null {
  if (typeof code !== 'string') return null;
  const text = code.trim();
  if (text.length !== 2) return null;
  const rankChar = text[0]!.toUpperCase();
  const suitChar = text[1]!.toLowerCase();
  const rank = CHAR_RANKS[rankChar] as Rank | undefined;
  if (rank === undefined) return null;
  if (suitChar !== 's' && suitChar !== 'h' && suitChar !== 'd' && suitChar !== 'c') return null;
  return { rank, suit: suitChar as Suit };
}

/** Card → 规范文本（点数大写 + 花色小写） */
export function cardCodeOf(card: Card): string {
  const rankChar = Object.entries(CHAR_RANKS).find(([, r]) => r === card.rank)?.[0];
  return `${rankChar ?? '?'}${card.suit}`;
}

/** 解析一组牌面文本，返回成功的牌与失败的原文 */
export function parseCardCodes(codes: readonly string[]): {
  cards: readonly Card[];
  invalid: readonly string[];
} {
  const cards: Card[] = [];
  const invalid: string[] = [];
  for (const code of codes) {
    const card = parseCardCode(code);
    if (card === null) invalid.push(code);
    else cards.push(card);
  }
  return { cards, invalid };
}

/* ============================================================
 * 输入结构
 * ============================================================ */

/**
 * 手动录入的一个动作。
 *
 * ## `amountBB` 的语义（**关键**）
 *
 * 与 `ActionCommand.amount` 完全一致（避免规范里提过的历史 Bug B12）：
 *
 * | 动作 | `amountBB` 的含义 |
 * |---|---|
 * | `BET` / `RAISE` | **加注到**的本街总额（不是「加了多少」） |
 * | `CALL` | 本次需要投入的金额 |
 * | `ALL_IN` | **加注到**的本街总额（通常等于有效筹码） |
 * | `CHECK` / `FOLD` | 忽略 |
 *
 * 界面必须把这个语义写清楚 —— 这是最容易输错的一项。
 */
export type ManualActionType = 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE' | 'ALL_IN';

export type ManualAction = {
  /** 行动者的位置（用位置而不是名字，因为手动输入时通常只知道位置） */
  position: Position;
  type: ManualActionType;
  /** 见上表；单位 BB */
  amountBB?: number;
  /**
   * 该动作属于哪条街。
   *
   * - 省略时**继承上一条**动作的街道；第一条省略则视为翻牌前。
   * - 这是让「街道切换」可判定的关键：界面上的行动历史本就按街分组，
   *   因此携带它是自然的。
   *
   * 若没有它，系统只能靠金额猜「这条动作属于哪条街」——
   * 而 `CHECK`（金额 0）在翻牌前与翻牌后都合法，**无法区分**，
   * 会导致合法的多街记录被拒。
   */
  street?: Street;
};

/**
 * 对手的快速画像（界面上的下拉选项）。
 *
 * ⚠️ 这是**用户的主观判断**，不是实测数据。
 * 因此它的可信度由 `QUICK_PROFILE_CONFIDENCE` 给一个**上限**，
 * 并且永远不能覆盖真实画像（`PlayerProfile`）。
 */
export const QuickProfile = {
  UNKNOWN: 'UNKNOWN',
  VERY_TIGHT: 'VERY_TIGHT',
  TIGHT: 'TIGHT',
  NORMAL: 'NORMAL',
  LOOSE: 'LOOSE',
  VERY_LOOSE: 'VERY_LOOSE',
  CALLING_STATION: 'CALLING_STATION',
  AGGRESSIVE: 'AGGRESSIVE',
  BLUFF_HEAVY: 'BLUFF_HEAVY',
  UNDERBLUFFER: 'UNDERBLUFFER',
  MANIAC: 'MANIAC',
} as const;
export type QuickProfile = (typeof QuickProfile)[keyof typeof QuickProfile];

export const ALL_QUICK_PROFILES: readonly QuickProfile[] = Object.values(QuickProfile);

/**
 * 动态观察提示（界面上手点）。
 *
 * ## 🔴 红队 F-11：这里**不许**出现领域层无法表达的状态
 *
 * 修复前这里有一个 `SIZE_ANOMALY`，而领域层的 `UserHintKind`（规范第 80 节）
 * **没有**对应成员。`mapDynamicHint` 的 `default` 分支把它静默映射成
 * `UNKNOWN` —— 用户在界面上认真选了一个「下注尺度异常」，
 * 系统收到的是「用户什么都没说」。
 *
 * 这比「不提供这个选项」更糟：它让使用者以为自己的观察被纳入了。
 * 现在这个成员被删除，并且 `mapDynamicHint` 改成 **穷举映射**
 *（`Record<DynamicHint, UserHintKind>`），
 * 将来任何人往这里加成员而忘了映射，**编译就会失败**，
 * 而不是等到下一次红队才发现信息被静默吞掉。
 *
 * ⚠️ `SIZE_ANOMALY` 仍然存在于**领域层**（`DynamicState`）——
 * 它可以由真实行为数据（下注尺度偏离基线）自动得出，
 * 只是**不能由用户一键声称**。
 */
export const DynamicHint = {
  NORMAL: 'NORMAL',
  LOOSER_RECENTLY: 'LOOSER_RECENTLY',
  TIGHTER_RECENTLY: 'TIGHTER_RECENTLY',
  AGGRESSION_UP: 'AGGRESSION_UP',
  TILT_SIGNAL: 'TILT_SIGNAL',
  CHASE_LOSS_SIGNAL: 'CHASE_LOSS_SIGNAL',
  UNKNOWN: 'UNKNOWN',
} as const;
export type DynamicHint = (typeof DynamicHint)[keyof typeof DynamicHint];

export const ALL_DYNAMIC_HINTS: readonly DynamicHint[] = Object.values(DynamicHint);

/**
 * 🔴 用户主观快速画像的**可信度上限**。
 *
 * 为什么必须有上限：`QuickProfile` 是「我觉得他是跟注站」这种主观判断，
 * 它**没有**任何手数支撑。若让它以高可信度进入决策，就等于
 * 「因为用户觉得对手松，所以系统推荐跟注」—— 那是把决策责任
 * 从数学转移到了用户的一句主观感觉上。
 *
 * 取值 0.35 的定位：与知识层 `env.*` 规则的 confidence（0.3）
 * 和 `gameEnvironment` 的启发式 confidence（0.3~0.4）**同一量级**。
 * 它足够影响边缘决策，但不足以翻转明确决策。
 */
export const QUICK_PROFILE_CONFIDENCE = 0.35;

/**
 * 手动观察的动态提示的可信度上限。
 *
 * 与 `USER_HINT_CONFIDENCE_CAP`（Step 7 的 0.45）保持一致口径，
 * 但对 Alpha 第一版进一步压低，因为它只经过一个下拉框。
 */
export const DYNAMIC_HINT_CONFIDENCE = 0.3;

export type ManualVillain = {
  playerId?: string;
  quickProfile?: QuickProfile;
  dynamicHint?: DynamicHint;
  /** 该对手的起始筹码（BB）；不填则与 `effectiveStackBB` 相同 */
  stackBB?: number;
  /**
   * 🔴 **该对手的行为画像**（PLAYER PROFILE QUANTIFICATION V1 · §十二）。
   *
   * ## 与 `quickProfile` 的分工（这是两个不同的东西）
   *
   * | 字段 | 是什么 | 可信度 |
   * |---|---|---|
   * | `quickProfile` | **标签**（「我觉得他是跟注站」） | 主观，上限 `QUICK_PROFILE_CONFIDENCE` |
   * | `behaviorProfile` | **逐条行为证据**（带机会数与收缩后比率） | 由 `behaviorProfileOf` 按实测/人工/标签/池先验四级决定 |
   *
   * ## 严格可选
   *
   * 不填 ⇒ 整条链与历史**逐位一致**（既有测试全部依赖这一点）。
   * 填了 ⇒ 范围链在**河牌进攻性动作**上改用
   * `P(下注 | 手牌类别, 节点, 画像)`，替代原先的档位似然，
   * 并抑制同一条动作上的倾斜通道（避免画像被计两次）。
   */
  behaviorProfile?: PlayerBehaviorProfile;
  /**
   * 🔴 **PLAYER PROFILE V3**：该对手的**连续统计**（VPIP / PFR / 3Bet /
   * WTSD / FoldTo*CBet / *CheckRaise）。
   *
   * ## 三层概念（V3 §四，必须保持分离）
   *
   * ```text
   * quickProfile    = 标签 Prior      （「我觉得他是跟注站」）
   * observedStats   = 实测证据        （「310 手里他河牌只弃 19%」）
   * → resolved      = 两者按样本量加权的结果（**标签不被覆盖**）
   * ```
   *
   * ## 严格可选（V3 §十一）
   *
   * 不填 / 全 `null` ⇒ 所有分街系数 = 1 ⇒ 与 V2 archetype-only **逐位一致**。
   * 每个字段允许 `null`（缺失），**但不得用 0 冒充缺失** —— 0 表示
   * 「观测到了 0 次」，`null` 表示「没观测过」，语义完全不同（§十四）。
   */
  observedStats?: PlayerObservedStats | null;
};

export type ManualHandInput = {
  tableSize: 6 | 9;
  heroPosition: Position;
  heroCards: readonly [string, string];
  board: readonly string[];
  street: Street;
  effectiveStackBB: number;
  /**
   * 用户填写的当前底池（BB）—— **可选**。
   *
   * ## 为什么可选
   *
   * 底池可以从行动记录**完全重算**，让用户手填一个本可算出的数字
   * 只会制造「填错 → 被阻断」的摩擦。因此：
   *
   * | 情况 | 行为 |
   * |---|---|
   * | **不填**（`undefined`） | 用重算值，不报「不一致」（本来就没有声明可对照） |
   * | **填了** | 与重算值**严格对照**；不一致 → **阻断** |
   *   （规范第 16 节：绝不「先按填的算」） |
   *
   * 两种情况下，进入决策的底池**永远**是重算值 ——
   * 用户填的数字只用于对照，从不参与计算。
   */
  potBB?: number;
  actionHistory: readonly ManualAction[];
  environment: GameEnvironmentId;
  /**
   * 大盲的**筹码面额**：`1BB = bigBlindBB` 个筹码。默认 `100`。
   *
   * ## 它影响什么、不影响什么
   *
   * | | |
   * |---|---|
   * | **影响** | 界面与日志里**绝对筹码数字**的换算（`bigBlindChips = round(bigBlindBB)`） |
   * | **不影响** | 任何 BB 口径的判断 —— 底池赔率、所需权益、SPR、权益都是**无量纲比值** |
   *
   * 也就是说：改这个字段**不会**改变建议的动作，只会让「200 筹码」这样的
   * 绝对数字与真实盲注级别对应。
   *
   * 🔴 **红队 F-07 的历史**：这个字段以前被解析、被校验、非法值被阻断，
   * 但 `reconstruct.ts` 硬编码了 `100` 从不读它 —— 一个**死字段**。
   * 文档却声称它「用于把 BB 单位换算成筹码单位」。现在两者一致了。
   *
   * ⚠️ 单位是「筹码」，不是「元」。本项目不做任何真实货币换算。
   */
  bigBlindBB?: number;
  /**
   * **逐座位的起始筹码（BB）**，键为位置。缺省的位置回退到
   * `villain.stackBB`（若给了）或 `effectiveStackBB`。
   *
   * ## 为什么必须加这个字段（不是可有可无的便利）
   *
   * `effectiveStack`（有效筹码）是数学九项之一，它取「我与对手中较小的那个筹码」。
   * 牌桌上每个座位筹码不同（100 / 92 / 83 / 140 …）是常态。
   * 在它出现之前，契约只能表达「Hero 的筹码」+「所有对手共用同一个筹码」，
   * 于是**牌桌 UI 无法如实表达真实牌局** —— 这是接口表达能力的缺口，
   * 不是 UI 的偷懒。
   *
   * ## 兼容性
   *
   * 可选字段：不填时行为与历史**逐位一致**（所有对手用 `villain.stackBB`，
   * 缺省等于 `effectiveStackBB`）。因此既有 1119 项测试不受影响。
   */
  seatStacksBB?: Readonly<Partial<Record<Position, number>>>;
  /**
   * 🔴 **逐座位的快速画像**（MULTIWAY RESPONSE TREE）。
   *
   * ## 为什么必须能逐座位给
   *
   * `villain.quickProfile` 只表达**一个**对手的画像。多人池里两个对手的
   * 类型往往不同（本例：UTG 松弱、CO 跟注站），而多人下注 EV 要求
   * **每个对手各自**的 fold/call/raise ——「谁的画像」直接决定谁爱不爱弃牌。
   * 只支持一个画像时，引擎只能把这个画像套给其中一个座位，
   * 另一个座位被迫当中立先验，**这不是精度问题，是表达能力缺口**。
   *
   * 值与 `villain.quickProfile` 同域（`QuickProfile`）；键是**位置**。
   * 优先级：本表 > `villain.quickProfile`（当该座位就是 `villain.playerId`）> 中立先验。
   *
   * ⚠️ 仍然只是**用户主观判断**，可信度上限同样是 `QUICK_PROFILE_CONFIDENCE`。
   */
  seatProfiles?: Readonly<Partial<Record<Position, string>>>;
  /**
   * **本手真正参与的物理座位**（Table Topology Correction）。
   *
   * ## 为什么必须与 `tableSize` 分开
   *
   * `tableSize` 是**座位容量**（牌桌有几个物理座位），而
   * `occupiedPositions` 是**本手发牌给哪几个座位**。
   * 9 座桌 8 个人是现金局最常见的形态；修复前契约里没有这个字段，
   * 于是「9 座桌」被迫等于「本手 9 人」，少一个人就整张桌子无法分析。
   *
   * 省略时 = 该容量的**全部座位**（与历史行为逐位一致）。
   *
   * ⚠️ 位置是**物理座位**，不是本手的角色名。
   * 「Seat 4 永远是 CO」这类写法在本模型里不成立：角色由
   * Button + 参与者每手重算（见 `positions.ts` 的 `handTopologySeats`）。
   */
  occupiedPositions?: readonly Position[];
  /**
   * **Button 所在的物理座位**。省略时为 `BTN`（与历史行为一致）。
   *
   * 有空座位时 Button 不能靠「Hero 位置」反推 —— 它必须是真实状态。
   */
  buttonPosition?: Position;
  villain?: ManualVillain;
  /** 多人池时的**全部**对手（第一版 Decision 只支持单挑，多人会明确返回信息不足） */
  villains?: readonly ManualVillain[];
};

/* ============================================================
 * 解析结果
 * ============================================================ */

export type ManualInputIssue = {
  /** 机器可读代码 */
  code:
    | 'MISSING_FIELD'
    | 'INVALID_CARD_CODE'
    | 'DUPLICATE_HERO_CARD'
    | 'CARD_COUNT_MISMATCH'
    | 'INVALID_NUMBER'
    | 'INVALID_POSITION'
    | 'INVALID_TABLE_SIZE'
    | 'INVALID_STREET'
    | 'INVALID_ENVIRONMENT'
    | 'INVALID_ACTION'
    | 'POSITION_NOT_AT_TABLE';
  /** **中文**说明（直接可显示给用户） */
  message: string;
  /** 出问题的字段路径，便于界面高亮 */
  field?: string;
};

/** 解析成功后的结构化输入（牌已是 Card 对象） */
export type ParsedManualInput = {
  tableSize: 6 | 9;
  heroPosition: Position;
  heroCards: readonly [Card, Card];
  board: readonly Card[];
  street: Street;
  effectiveStackBB: number;
  /**
   * 用户声明的底池（BB）；**未声明时为 `null`**。
   *
   * 为 `null` 表示「让系统按行动记录重算」——
   * 此时**不做**一致性对照（没有声明可对照）。
   */
  claimedPotBB: number | null;
  bigBlindBB: number;
  actionHistory: readonly ManualAction[];
  environment: GameEnvironmentId;
  villain: ManualVillain;
  /** 实际在场的对手数量（1 = 单挑） */
  opponentCount: number;
  /**
   * 逐座位起始筹码（BB）；**已校验**。缺省的位置回退到
   * `villain.stackBB` 或 `effectiveStackBB`（历史行为）。
   */
  seatStacksBB: Readonly<Partial<Record<Position, number>>>;
  /** 逐座位画像（**已校验**；缺省的位置没有画像证据） */
  seatProfiles: Readonly<Partial<Record<Position, string>>>;
  /** 本手参与的物理座位（**已校验**：容量内的唯一位置，且必须包含 Hero 与 Button） */
  occupiedPositions: readonly Position[];
  /** Button 的物理座位（**已校验**：必须是本手参与者） */
  buttonPosition: Position;
  /** 本手人数 = `occupiedPositions.length`（**不是** `tableSize`） */
  handedness: number;
};

export type ParseResult =
  | { ok: true; value: ParsedManualInput; warnings: readonly ManualInputIssue[] }
  | { ok: false; issues: readonly ManualInputIssue[] };

/* ============================================================
 * 各街道要求的公共牌张数
 * ============================================================ */

/** 各街道应有的公共牌张数（规范第 14 节） */
export const BOARD_COUNT_BY_STREET: Readonly<Record<Street, number>> = Object.freeze({
  [Street.PREFLOP]: 0,
  [Street.FLOP]: 3,
  [Street.TURN]: 4,
  [Street.RIVER]: 5,
});

const STREETS: readonly Street[] = [Street.PREFLOP, Street.FLOP, Street.TURN, Street.RIVER];

const ENVIRONMENTS: readonly string[] = [
  'LOW_STAKES_ONLINE',
  'MID_LOW_STAKES',
  'THEORY_REFERENCE',
];

const ACTION_TYPES: readonly ManualActionType[] = ['FOLD', 'CHECK', 'CALL', 'BET', 'RAISE', 'ALL_IN'];

/**
 * 内部筹码比例尺的默认值：`1BB = 100 筹码`。
 *
 * 内部筹码单位是**任意的**（所有判断都在 BB 口径上做），
 * 这个默认值唯一的作用是让界面上的绝对筹码数字有一个稳定参照。
 *
 * 放在 `manualInput.ts`（而不是 `reconstruct.ts`）是为了避免循环依赖：
 * `reconstruct.ts` 依赖本模块，反向 import 会成环。
 */
export const DEFAULT_BIG_BLIND_CHIPS = 100;

/* ============================================================
 * 解析主函数
 * ============================================================ */

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 解析手动输入。
 *
 * ## Fail-Closed
 *
 * 任何字段无法确定 → `ok: false` 并列出**全部**问题（不是只报第一个）。
 * 用户一次就能改完，而不是「改一个跑一次」。
 *
 * ## 刻意**不**在这里检查的东西
 *
 * - 公共牌与手牌是否重复 → 交给 `validator.ts` 的
 *   `validateCardUniqueness`（它已有成熟实现与红队测试）。
 *   本层只检查**同一组内部**的重复（例如手牌填了两张 `As`），
 *   因为那是「填错了」而不是「牌局非法」。
 * - 底池是否与行动一致 → 交给 `comparePot`。
 */
export function parseManualInput(input: ManualHandInput): ParseResult {
  const issues: ManualInputIssue[] = [];
  const warnings: ManualInputIssue[] = [];

  /* ---- 桌型 ---- */
  const tableSize = input.tableSize;
  if (tableSize !== TableSize.SIX_MAX && tableSize !== TableSize.NINE_MAX) {
    issues.push({
      code: 'INVALID_TABLE_SIZE',
      message: `桌型只能是 6 人桌或 9 人桌（收到 ${String(tableSize)}）`,
      field: 'tableSize',
    });
  }

  /* ---- 位置 ---- */
  const heroPosition = input.heroPosition;
  const positions = tableSize === TableSize.SIX_MAX || tableSize === TableSize.NINE_MAX
    ? positionsForTableOf(tableSize)
    : [];
  if (!positions.includes(heroPosition)) {
    issues.push({
      code: 'INVALID_POSITION',
      message:
        `${tableSize} 人桌上没有「${String(heroPosition)}」这个位置。` +
        `可选：${positions.join(' / ') || '（桌型无效）'}`,
      field: 'heroPosition',
    });
  }

  /* ---- 街道 ---- */
  const street = input.street;
  if (!STREETS.includes(street)) {
    issues.push({
      code: 'INVALID_STREET',
      message: `街道只能是 PREFLOP / FLOP / TURN / RIVER（收到 ${String(street)}）`,
      field: 'street',
    });
  }

  /* ---- 环境 ---- */
  const environment = input.environment;
  if (!ENVIRONMENTS.includes(environment)) {
    issues.push({
      code: 'INVALID_ENVIRONMENT',
      message: `环境只能是 ${ENVIRONMENTS.join(' / ')}（收到 ${String(environment)}）`,
      field: 'environment',
    });
  }

  /* ---- 手牌 ---- */
  const heroRaw = Array.isArray(input.heroCards) ? input.heroCards : [];
  if (heroRaw.length !== 2) {
    issues.push({
      code: 'MISSING_FIELD',
      message: `Hero 手牌必须是 2 张（收到 ${heroRaw.length} 张）`,
      field: 'heroCards',
    });
  }
  const heroParsed = parseCardCodes(heroRaw);
  if (heroParsed.invalid.length > 0) {
    issues.push({
      code: 'INVALID_CARD_CODE',
      message:
        `无法识别的手牌：${heroParsed.invalid.join('、')}。` +
        '格式应为「点数+花色」，例如 As / Kh / Td / 7c（点数用 2-9、T、J、Q、K、A）',
      field: 'heroCards',
    });
  }
  if (heroParsed.cards.length === 2) {
    const [a, b] = heroParsed.cards as [Card, Card];
    if (a.rank === b.rank && a.suit === b.suit) {
      issues.push({
        code: 'DUPLICATE_HERO_CARD',
        message: `Hero 手牌出现重复牌 ${cardCodeOf(a)} —— 一手牌不可能有两张相同的牌`,
        field: 'heroCards',
      });
    }
  }

  /* ---- 公共牌 ---- */
  const boardRaw = Array.isArray(input.board) ? input.board : [];
  const boardParsed = parseCardCodes(boardRaw);
  if (boardParsed.invalid.length > 0) {
    issues.push({
      code: 'INVALID_CARD_CODE',
      message:
        `无法识别的公共牌：${boardParsed.invalid.join('、')}。` +
        '格式同手牌，例如 Ks / 2h / 7d',
      field: 'board',
    });
  }

  // 街道 vs 公共牌张数（规范第 14 节）
  if (STREETS.includes(street)) {
    const expected = BOARD_COUNT_BY_STREET[street];
    if (boardRaw.length !== expected) {
      const streetZh =
        street === Street.PREFLOP
          ? '翻牌前'
          : street === Street.FLOP
            ? '翻牌'
            : street === Street.TURN
              ? '转牌'
              : '河牌';
      issues.push({
        code: 'CARD_COUNT_MISMATCH',
        message:
          `${streetZh}应有 ${expected} 张公共牌，当前填了 ${boardRaw.length} 张。` +
          '请检查「当前街道」与「公共牌」是否对得上',
        field: 'board',
      });
    }
  }

  /* ---- 数值 ---- */
  const effectiveStackBB = input.effectiveStackBB;
  if (!isFiniteNumber(effectiveStackBB) || effectiveStackBB <= 0) {
    issues.push({
      code: 'INVALID_NUMBER',
      message: `有效筹码必须是正数（收到 ${String(effectiveStackBB)}）`,
      field: 'effectiveStackBB',
    });
  }
  // 底池是**可选声明**：不填 → 由系统重算；填了 → 只做对照（下方校验其合法性）
  const claimedPotBB = input.potBB;
  if (claimedPotBB !== undefined && (!isFiniteNumber(claimedPotBB) || claimedPotBB < 0)) {
    issues.push({
      code: 'INVALID_NUMBER',
      message: `当前底池不能是负数（收到 ${String(claimedPotBB)}）`,
      field: 'potBB',
    });
  }
  // ---- 大盲筹码面额（F-07：必须真正生效，而不是只被校验）----
  //
  // ⚠️ 必须是 **≥ 2 的整数**。
  //
  // 两条理由，缺一不可：
  //
  // 1. **内部筹码是整数**：所有金额按 `round(amountBB × 面额)` 换算。
  //    面额小于 1 会让「1BB」本身都表示不出来，常见的 2.5BB 下注会被
  //    **静默取整**成完全不同的量级；面额是小数则等于悄悄改掉用户填的数字。
  //    两种都属于「静默修正用户输入」，本项目明确禁止 —— 宁可阻断并说清楚。
  // 2. **小盲必须是整数筹码**：小盲 = `round(面额 / 2)`。
  //    面额为 1 时小盲也是 1，等于小盲 = 大盲，牌局根本无法成立。
  const bigBlindBB = input.bigBlindBB ?? DEFAULT_BIG_BLIND_CHIPS;
  if (!isFiniteNumber(bigBlindBB) || bigBlindBB <= 0) {
    issues.push({
      code: 'INVALID_NUMBER',
      message: `大盲的筹码面额必须是正数（收到 ${String(bigBlindBB)}）；它表示「1BB 等于多少筹码」`,
      field: 'bigBlindBB',
    });
  } else if (!Number.isInteger(bigBlindBB) || bigBlindBB < 2) {
    issues.push({
      code: 'INVALID_NUMBER',
      message:
        `大盲的筹码面额必须是**不小于 2 的整数**（收到 ${String(bigBlindBB)}）。` +
        '它表示「1BB 等于多少筹码」（常用 100）。' +
        '小于 2 或带小数时，常见下注额会被静默取整成另一个数，或小盲无法用整数筹码表示 —— ' +
        '系统不会替你改数字，因此直接阻断',
      field: 'bigBlindBB',
    });
  }

  /* ---- 行动历史 ---- */
  const actionHistory = Array.isArray(input.actionHistory) ? input.actionHistory : [];
  for (const [index, action] of actionHistory.entries()) {
    /*
     * 🔴 **先确认这一条本身是个对象。**
     *
     * `actionHistory` 直接来自 JSON，因此**任何一条**都可能是 `null`
     *（`[null]`）、字符串（`["RAISE"]`）或数字（`[42]`）。
     * 修复前这里直接取 `action.position`，于是 `[null]` 会抛
     * `TypeError: Cannot read properties of null (reading 'position')`，
     * 一路冒到 `/api/analyze` 的顶层 catch，变成 **HTTP 500**
     * —— 而本层的职责恰恰是「把所有坏输入变成结构化 issue」。
     *
     * ⚠️ 注意上层已经处理了「整个 `actionHistory` 不是数组」的情况
     *（上面那行 `Array.isArray`），但**逐个元素**的判空不能省：
     * 实测 `actionHistory: [null]` 与 `[..., null]` 两种位置都会命中。
     */
    if (action === null || typeof action !== 'object' || Array.isArray(action)) {
      issues.push({
        code: 'INVALID_ACTION',
        message:
          `第 ${index + 1} 条行动记录不是一个对象（收到 ${action === null ? 'null' : typeof action}）。` +
          '每条记录必须形如 `{ position, type, amountBB }`',
        field: `actionHistory[${index}]`,
      });
      continue;
    }

    if (!positions.includes(action.position)) {
      issues.push({
        code: 'POSITION_NOT_AT_TABLE',
        message:
          `第 ${index + 1} 条行动记录的位置「${String(action.position)}」不在 ${tableSize} 人桌上`,
        field: `actionHistory[${index}].position`,
      });
    }
    if (!ACTION_TYPES.includes(action.type)) {
      issues.push({
        code: 'INVALID_ACTION',
        message:
          `第 ${index + 1} 条行动记录的动作「${String(action.type)}」不合法。` +
          `可选：${ACTION_TYPES.join(' / ')}`,
        field: `actionHistory[${index}].type`,
      });
      continue;
    }
    const needsAmount =
      action.type === 'BET' || action.type === 'RAISE' || action.type === 'CALL';
    if (needsAmount) {
      if (!isFiniteNumber(action.amountBB) || action.amountBB < 0) {
        const meaning =
          action.type === 'CALL'
            ? '本次投入金额'
            : action.type === 'BET'
              ? '下注到的本街总额'
              : '加注到的本街总额';
        issues.push({
          code: 'INVALID_ACTION',
          message:
            `第 ${index + 1} 条行动记录（${action.type}）缺少合法的金额。` +
            `该动作需要填「${meaning}」（单位 BB）`,
          field: `actionHistory[${index}].amountBB`,
        });
      }
    } else if (action.type === 'ALL_IN' && action.amountBB !== undefined) {
      // 🔴 红队 F-08：全下的金额是**可选**的。
      //
      // 修复前 `ALL_IN` 被归进 `needsAmount`，于是「对手全下 8BB」这种最常见的
      // 短筹码局面，用户必须**同时**填 `amountBB` 和界面之外的 `villain.stackBB`，
      // 只填其一必被拒绝，而且错误信息不告诉他该怎么填。
      //
      // 现在：不填金额 = 「投入全部剩余筹码」，由引擎按该座位的起始筹码处理 ——
      // 这正是 `ALL_IN` 的语义（见 `engine.ts` 的 `doAllIn`）。
      // 填了金额则必须等于剩余筹码，否则由引擎给出明确的不一致提示。
      if (!isFiniteNumber(action.amountBB) || action.amountBB < 0) {
        issues.push({
          code: 'INVALID_ACTION',
          message:
            `第 ${index + 1} 条行动记录（ALL_IN）的金额非法（收到 ${String(action.amountBB)}）。` +
            '可以**不填**金额表示「投入全部剩余筹码」，或填一个不小于 0 的数字',
          field: `actionHistory[${index}].amountBB`,
        });
      }
    }
  }

  /* ---- 对手 ---- */
  const villainList = input.villains ?? (input.villain ? [input.villain] : []);
  const opponentCount = Math.max(1, villainList.length);

  /* ---- 对手画像 / 动态提示：必须是**已知枚举值** ---- */
  //
  // 🔴 本轮发现的真实缺陷（红队重点「后端收到错误 Profile」）：
  // 修复前这两个字段**完全不校验**，直接原样传下去。后果实测：
  //
  //   quickProfile: "CALLING_STATION "  → 未知键，被当成「用户没选」
  //   dynamicHint:  "SIZE_ANALOGY"（拼错）→ `HINT_MAP[hint]` 得到 `undefined`
  //                  → `resolveUserHints` 里 `state === null` 判据失效
  //                  → `dominantState` 被写成 `undefined`
  //                  → `DynamicSnapshot.state` 变成一个**不在枚举里**的值
  //
  // 也就是说：一个拼错的字符串能让动态层的状态字段静默变成垃圾值，
  // 而界面照常显示、决策照常给出。这属于「看起来对、实际用了别的输入」，
  // 是本项目最危险的一类缺陷。
  //
  // 现在：**未知取值一律阻断**（Fail-Closed），并列出合法取值。
  const quickProfileSet: readonly string[] = Object.values(QuickProfile);
  const dynamicHintSet: readonly string[] = Object.values(DynamicHint);
  for (const [index, villain] of villainList.entries()) {
    const where = villainList.length > 1 ? `第 ${index + 1} 个对手的` : '对手的';
    if (villain.quickProfile !== undefined && !quickProfileSet.includes(villain.quickProfile)) {
      issues.push({
        code: 'INVALID_NUMBER',
        message:
          `${where}快速画像「${String(villain.quickProfile)}」不是已知取值。` +
          `可选：${quickProfileSet.join(' / ')}`,
        field: villainList.length > 1 ? `villains[${index}].quickProfile` : 'villain.quickProfile',
      });
    }
    if (villain.dynamicHint !== undefined && !dynamicHintSet.includes(villain.dynamicHint)) {
      issues.push({
        code: 'INVALID_NUMBER',
        message:
          `${where}动态观察提示「${String(villain.dynamicHint)}」不是已知取值。` +
          `可选：${dynamicHintSet.join(' / ')}`,
        field: villainList.length > 1 ? `villains[${index}].dynamicHint` : 'villain.dynamicHint',
      });
    }
  }

  /* ---- 逐座位筹码 ---- */
  //
  // 🔴 必须逐条校验，**不允许**静默忽略：一个写错的键（例如把位置拼错）
  // 会让那个座位悄悄退回默认筹码，而使用者以为已经生效 ——
  // 这类「看起来对、实际用了别的数」正是本项目最危险的缺陷形态。
  const rawSeatStacks = input.seatStacksBB;
  const seatStacksBB: Partial<Record<Position, number>> = {};
  if (rawSeatStacks !== undefined) {
    if (typeof rawSeatStacks !== 'object' || rawSeatStacks === null || Array.isArray(rawSeatStacks)) {
      issues.push({
        code: 'INVALID_NUMBER',
        message: '逐座位筹码必须是一个「位置 → 筹码」的对象',
        field: 'seatStacksBB',
      });
    } else {
      for (const [key, raw] of Object.entries(rawSeatStacks)) {
        if (!positions.includes(key as Position)) {
          issues.push({
            code: 'INVALID_POSITION',
            message:
              `${tableSize} 人桌上没有「${key}」这个位置，因此无法为它设置筹码。` +
              `可选：${positions.join(' / ')}`,
            field: `seatStacksBB.${key}`,
          });
          continue;
        }
        if (!isFiniteNumber(raw) || raw <= 0) {
          issues.push({
            code: 'INVALID_NUMBER',
            message: `「${key}」的筹码必须是正数（收到 ${String(raw)}）`,
            field: `seatStacksBB.${key}`,
          });
          continue;
        }
        seatStacksBB[key as Position] = raw;
      }
    }
  }

  /* ---- 逐座位画像（MULTIWAY RESPONSE TREE） ---- */
  //
  // 与 `seatStacksBB` 同一条纪律：写错的键**必须阻断**，不允许静默忽略 ——
  // 「看起来设了画像、实际用的是中立先验」比没有画像更危险。
  const rawSeatProfiles = input.seatProfiles;
  const seatProfiles: Partial<Record<Position, string>> = {};
  if (rawSeatProfiles !== undefined) {
    if (typeof rawSeatProfiles !== 'object' || rawSeatProfiles === null || Array.isArray(rawSeatProfiles)) {
      issues.push({
        code: 'INVALID_NUMBER',
        message: '逐座位画像必须是一个「位置 → 画像」的对象',
        field: 'seatProfiles',
      });
    } else {
      for (const [key, raw] of Object.entries(rawSeatProfiles)) {
        if (!positions.includes(key as Position)) {
          issues.push({
            code: 'INVALID_POSITION',
            message:
              `${tableSize} 人桌上没有「${key}」这个位置，因此无法为它设置画像。` +
              `可选：${positions.join(' / ')}`,
            field: `seatProfiles.${key}`,
          });
          continue;
        }
        if (typeof raw !== 'string' || !quickProfileSet.includes(raw)) {
          issues.push({
            code: 'INVALID_NUMBER',
            message:
              `「${key}」的画像「${String(raw)}」不是已知取值。可选：${quickProfileSet.join(' / ')}`,
            field: `seatProfiles.${key}`,
          });
          continue;
        }
        seatProfiles[key as Position] = raw;
      }
    }
  }

  /*
   * 🔴 **注入式行为画像的形状必须校验**（V2.1 失败模式审计 #3 / #4）。
   *
   * ## 修复前实测（两处，都是「静默或半静默」的失败）
   *
   * 1. **残缺画像把整手牌打挂**（`traits` 缺一条就崩）：
   *    `behaviorProfile.ts` 的读取点直接取 `traits.<条目>.effectiveRate`，
   *    而 `traits` 是 `Record<BehaviorTraitKey, StatEvidence>` —— 类型上非可选，
   *    运行时却可以缺。实测 `traits: {}` 或只给一条：
   *    `ok=false / stage=CONTEXT / CONTEXT_BUILD_FAILED: Cannot read properties of
   *    undefined (reading 'effectiveRate')`。**整手牌无法分析**，而错误信息
   *    对使用者完全不可操作。
   * 2. **非法数值穿透到似然**：`successes/opportunities` 为 `NaN` 或 `Infinity`
   *    时，`statEvidenceOf` 只对 `priorRate` 做了有限性守卫，于是
   *    `effectiveRate = NaN` ⇒ `likelihood = NaN` ⇒ 范围引擎
   *    `validateActionModel` 拒绝**整条动作模型** ⇒ 该街的贝叶斯更新被
   *    **静默丢弃**（失败只写在 `updateTrace.action` 里，不进 `warnings`）。
   *    实测后果：权益从 57.70% 变成 **67.51%**（+9.8pp）—— 一个坏数字让结论
   *    变得**更激进**，而界面上看不出任何异常。
   *
   * ## 为什么在**这里**校验（而不是在 `statEvidenceOf` 里夹取）
   *
   * 项目纪律（第 16 节）：**未知/非法取值一律阻断，绝不静默修正**。
   * 静默夹取会把「数据坏了」变成「数据看起来正常」—— 那正是上面第 2 条
   * 已经造成的后果。这里处在**信任边界**（外部传入的对象），
   * 因此按既有风格（同函数里 `quickProfile` / `dynamicHint` / `seatProfiles`
   * 都是 Fail-Closed）逐条列出问题并阻断。
   *
   * ⚠️ `traits` **允许缺条目**（那是「这一条没有证据」，语义合法）：
   * 读取端回落到池先验，不在这里报错 —— 见 `behaviorProfile.ts` 的 `traitRateOf`。
   */
  for (const [index, villain] of villainList.entries()) {
    const bp = villain.behaviorProfile as unknown;
    if (bp === undefined || bp === null) continue;
    const where = villainList.length > 1 ? `第 ${index + 1} 个对手的` : '对手的';
    const field = villainList.length > 1 ? `villains[${index}].behaviorProfile` : 'villain.behaviorProfile';
    if (typeof bp !== 'object') {
      issues.push({ code: 'INVALID_NUMBER', message: `${where}行为画像必须是一个对象`, field });
      continue;
    }
    const traits = (bp as { traits?: unknown }).traits;
    if (traits !== undefined && (typeof traits !== 'object' || traits === null || Array.isArray(traits))) {
      issues.push({ code: 'INVALID_NUMBER', message: `${where}行为画像的 traits 必须是「条目 → 证据」的对象`, field: `${field}.traits` });
      continue;
    }
    for (const [key, rawTrait] of Object.entries((traits ?? {}) as Record<string, unknown>)) {
      /*
       * ⚠️ **刻意不校验「条目名是否合法」**：那需要 `BehaviorTraitKey` 的**值**导入，
       * 而 `behaviorProfile.ts` 反向 `import type { QuickProfile }` 自本文件 ——
       * 值导入会**引入真实运行时环**（模块初始化顺序未定义）。
       * 在这里复制一份条目名清单更糟（两份清单必然漂移）。
       * 因此本层只校验**形状与数值**；未知条目名在似然计算里不匹配任何条件化分支，
       * 因而是惰性的（不会改变任何数值）。
       */
      if (rawTrait === null || typeof rawTrait !== 'object') {
        issues.push({ code: 'INVALID_NUMBER', message: `${where}行为条目「${key}」的证据必须是一个对象`, field: `${field}.traits.${key}` });
        continue;
      }
      const t = rawTrait as Record<string, unknown>;
      /*
       * **计数类字段必须是有限非负整数**：`successes` / `opportunities` /
       * `unknownOutcomeOpportunities`。小数、负数、NaN、Infinity 一律阻断。
       */
      for (const countKey of ['successes', 'opportunities', 'unknownOutcomeOpportunities'] as const) {
        const v = t[countKey];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
          issues.push({
            code: 'INVALID_NUMBER',
            message:
              `${where}行为条目「${key}」的 ${countKey} 必须是**有限非负整数**，收到 ${String(v)}。` +
              '（项目纪律：非法数值阻断，不做静默修正 —— 夹取会把「数据坏了」变成「数据看起来正常」）',
            field: `${field}.traits.${key}.${countKey}`,
          });
        }
      }
      if (
        typeof t['successes'] === 'number' && typeof t['opportunities'] === 'number'
        && Number.isInteger(t['successes']) && Number.isInteger(t['opportunities'])
        && t['successes'] > t['opportunities']
      ) {
        issues.push({
          code: 'INVALID_NUMBER',
          message: `${where}行为条目「${key}」的 successes（${String(t['successes'])}）大于 opportunities（${String(t['opportunities'])}）`,
          field: `${field}.traits.${key}.successes`,
        });
      }
      const eff = t['effectiveRate'];
      if (eff !== undefined && (typeof eff !== 'number' || !Number.isFinite(eff) || eff < 0 || eff > 1)) {
        issues.push({
          code: 'INVALID_NUMBER',
          message: `${where}行为条目「${key}」的 effectiveRate 必须是 0..1 的有限数，收到 ${String(eff)}`,
          field: `${field}.traits.${key}.effectiveRate`,
        });
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  /* ---- 本手拓扑：容量 / 参与者 / Button（Table Topology Correction） ---- */
  //
  // 省略 `occupiedPositions` 时 = 该容量的全部座位 → 与历史行为逐位一致。
  const capacityPositions = positionsForTableOf(tableSize as TableSize);
  const occupiedRaw = input.occupiedPositions ?? capacityPositions;
  const occupiedPositions: Position[] = [];
  {
    const seen = new Set<string>();
    for (const position of occupiedRaw) {
      if (!positions.includes(position)) {
        issues.push({
          code: 'INVALID_POSITION',
          message:
            `${tableSize} 座桌上没有「${String(position)}」这个座位，` +
            `因此不能作为本手参与者。可选：${positions.join(' / ')}`,
          field: 'occupiedPositions',
        });
        continue;
      }
      if (seen.has(position)) {
        issues.push({
          code: 'INVALID_POSITION',
          message: `本手参与者里「${position}」出现了两次`,
          field: 'occupiedPositions',
        });
        continue;
      }
      seen.add(position);
      occupiedPositions.push(position);
    }
    if (occupiedPositions.length < 2) {
      issues.push({
        code: 'INVALID_NUMBER',
        message: `本手至少需要 2 名参与者（收到 ${occupiedPositions.length} 位）`,
        field: 'occupiedPositions',
      });
    }
    if (!occupiedPositions.includes(heroPosition)) {
      issues.push({
        code: 'INVALID_POSITION',
        message: `Hero 的座位「${String(heroPosition)}」不在本手参与者里 —— 那样没有可分析的决策点`,
        field: 'occupiedPositions',
      });
    }
  }

  const buttonPosition = input.buttonPosition ?? Position.BTN;
  if (!positions.includes(buttonPosition)) {
    issues.push({
      code: 'INVALID_POSITION',
      message: `${tableSize} 座桌上没有「${String(buttonPosition)}」这个座位，Button 无法设置`,
      field: 'buttonPosition',
    });
  } else if (!occupiedPositions.includes(buttonPosition)) {
    issues.push({
      code: 'INVALID_POSITION',
      message:
        `Button 座位「${buttonPosition}」不在本手参与者里 —— ` +
        'Button 必须是本手的一位玩家，否则盲注与行动顺序无法定义',
      field: 'buttonPosition',
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      tableSize: tableSize as 6 | 9,
      heroPosition,
      heroCards: heroParsed.cards as unknown as readonly [Card, Card],
      board: boardParsed.cards,
      street,
      effectiveStackBB,
      claimedPotBB: claimedPotBB ?? null,
      bigBlindBB,
      actionHistory,
      environment,
      villain: villainList[0] ?? {},
      opponentCount,
      seatStacksBB: Object.freeze(seatStacksBB),
      seatProfiles: Object.freeze(seatProfiles),
      occupiedPositions: Object.freeze(occupiedPositions),
      buttonPosition,
      handedness: occupiedPositions.length,
    },
    warnings,
  };
}

/* ============================================================
 * 中文标签（界面显示用；词条本身仍应由 i18n 层维护，
 * 这里提供的是「位置/动作」的稳定映射，供 CLI 与测试使用）
 * ============================================================ */

export const POSITION_ZH: Readonly<Record<Position, string>> = Object.freeze({
  [Position.UTG]: '枪口位',
  [Position.UTG1]: '枪口+1',
  [Position.UTG2]: '枪口+2',
  [Position.LJ]: '低劫持位',
  [Position.HJ]: '劫持位',
  [Position.CO]: '关煞位',
  [Position.BTN]: '庄家位',
  [Position.SB]: '小盲位',
  [Position.BB]: '大盲位',
});

export const ACTION_ZH: Readonly<Record<ManualActionType, string>> = Object.freeze({
  FOLD: '弃牌',
  CHECK: '过牌',
  CALL: '跟注',
  BET: '下注',
  RAISE: '加注',
  ALL_IN: '全下',
});

export const STREET_ZH: Readonly<Record<Street, string>> = Object.freeze({
  [Street.PREFLOP]: '翻牌前',
  [Street.FLOP]: '翻牌',
  [Street.TURN]: '转牌',
  [Street.RIVER]: '河牌',
});
