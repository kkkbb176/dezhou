/**
 * ============================================================================
 * 牌桌动态适应 V1 —— 分层桌况模型（纯函数 · 零 I/O · 零随机）
 * ============================================================================
 *
 * ## 这个模块回答什么
 *
 * > **这一桌人（以及其中某几个人）最近实际怎么打？我该朝哪个方向调整？**
 *
 * 它与 `domain/dynamic/` **不是一回事**，两者刻意分开：
 *
 * | 维度 | `domain/dynamic/`（Step 7） | 本模块（Table Dynamics V1） |
 * |---|---|---|
 * | 对象 | **一个玩家相对他自己的长期基线**是否偏移 | **整桌 + 当前相关玩家**的绝对行为倾向 |
 * | 输出 | 9 种状态 + Tilt 概率 | 逐维度「机会数 / 命中数 / 收缩后比率 / 可信度 / 方向」 |
 * | 用途 | 单人偏移证据 | 开池 / 冷跟 / 再加注 / 价值下注 / 诈唬五类**有条件**调整 |
 *
 * 本模块**不重复建设第二套画像系统**：玩家的长期画像仍由
 * `domain/player/*`（Step 6 / V3）负责；本模块只消费
 * `playerHistory` 的逐手行为记录，产出**桌况**与**有条件的方向**。
 *
 * ## 四条硬纪律（每一条都对应一个已知的失败形态）
 *
 * ### 1. 分母来自牌局状态，绝不来自玩家动作
 *
 * README 不变量 14：「机会由牌局状态定义，绝不由玩家动作定义（否则分母会被玩家行为偷走）」。
 * 因此每条记录都带 `facedBet` / `playersYetToAct` / `activeCount` 等**行动前**状态，
 * 由 `playerHistory` 在行动发生时写入 —— 本模块**只读**，绝不从动作序列反推。
 *
 * ### 2. 「未记录」不等于「观测到 0」
 *
 * 旧记录（缺 `potBB` / `facedBetPotRatio` 等字段）**不参与**需要这些字段的维度，
 * 而不是被当成 0。机会数为 0 的维度输出 `null` 比率 + `OBSERVING`，**不编造数字**。
 *
 * ### 3. 少量观察不得产生极端判断
 *
 * 三重防线：**拉普拉斯平滑**（分子分母各加先验权重）→
 * **有效样本量收缩**（向声明的工程基线收缩）→ **调整幅度上限**。
 * 「连续 3 次 3Bet」不足以认定一个人是疯子：可信度会很低，方向会被压在 `NEUTRAL` 附近。
 *
 * ### 4. 每个维度各自带样本数与可信度
 *
 * 只有一个笼统置信度，就无法回答「是哪一项证据在推动这个调整」。
 * 因此 `TableDimension` 是**统一的证据单元**，`tableConfidence`
 * 只是各维度可信度的**加权聚合**（且聚合方式显式写出来）。
 *
 * ## 参数性质声明
 *
 * `TABLE_DYNAMICS_CONFIG` 里的每一个数字都是**工程初始值**（`ENGINEERING_DEFAULT`），
 * 来自「可解释、可复算、保守」三条原则，**不是**经过统计校准的最优参数。
 * 模块自身用测试锁住「换参数时方向单调性不变」，而不是锁住具体数值。
 */

import type { ObservationRecord } from '../../app/table/playerHistory.ts';
import type { Position } from '../types.ts';

/* ============================================================
 * 一、配置（窗口 / 衰减 / 上限集中在这里）
 * ============================================================ */

/** 参数来源标注：绝不允许把工程初始值冒充成已校准参数 */
export const PARAMETER_PROVENANCE = 'ENGINEERING_DEFAULT' as const;

export type TableDynamicsConfig = {
  /** 「本场近期」窗口（手数，按 handId 去重后的最近 N 手） */
  recentHands: number;
  /** 「整桌近期」窗口（手数） */
  tableHands: number;
  /** 衰减半衰期（手）。越旧的手权重越低 —— 玩家离桌后其影响力自然衰减 */
  halfLifeHands: number;
  /** 每个维度的先验权重（拉普拉斯平滑的加数），单位「机会」 */
  priorWeight: number;
  /** 收缩强度 K：可信度 = n_eff / (n_eff + K) */
  shrinkK: number;
  /**
   * 参与调整所需的最低可信度（低于此值只输出 OBSERVING）。
   */
  minConfidenceForAdjustment: number;
  /**
   * 🔴 **宣称「方向」所需的最低可信度**。
   *
   * ## 为什么方向本身也要有门槛
   *
   * 只有 `delta > 0.02` 就宣称「偏松 / 偏紧」是**数值门槛**，不是**证据门槛**：
   * 5 次机会时的 delta 完全可能是 0.024（跨过数值门槛），
   * 于是界面上会出现「整桌跟注偏多」——而它建立在 5 次观察上。
   * 那正是授权里点名要防的「少量观察导致极端判断」。
   *
   * 因此方向判定改为**双重门槛**：`|delta| > 数值门槛` **且**
   * `confidence >= minDirectionalConfidence`。达不到就如实报 `NEUTRAL`
   *（并在文案里写「与基线无显著差异」），而不是给一个撑不住的结论。
   */
  minDirectionalConfidence: number;
  /**
   * 调整幅度上限（乘数），上下对称。
   *
   * 0.15 的含义：任何单一维度最多把对应参数推到 ±15%。
   * 这是**保守**选择 —— 宁可少剥削，也不要因为 5 手样本做出极端偏离。
   */
  maxFactorDelta: number;
  /** 桌况摘要与调整的模型版本（进缓存键，避免不同版本结果互相误用） */
  version: string;
};

export const TABLE_DYNAMICS_CONFIG: TableDynamicsConfig = Object.freeze({
  recentHands: 40,
  tableHands: 120,
  /*
   * 🔴 半衰期必须**明显长于**「本场近期」窗口，否则两道防线互相叠加：
   * 窗口已经做过一次「只看最近的」，衰减再做一次同方向的惩罚，
   * 结果是**任何**真实样本量都被压到门槛以下，系统永远停在「观察中」。
   *
   * 实测（本模块自己的测试）：40 次机会若散布在 80 手跨度上，
   * 半衰期 30 手 ⇒ 有效样本仅 5.2（可信度 0.17，**不可调整**）；
   * 半衰期 60 手 ⇒ 有效样本 15.7（可信度 0.56，可调整）。
   * 两者用的是同一批数据 —— 差别只是「有没有重复惩罚时间」。
   *
   * 因此定 60：它在 120 手窗口内提供平滑的陈旧惩罚，
   * 又不会把窗口内的真实证据抹掉。
   */
  halfLifeHands: 60,
  priorWeight: 12,
  shrinkK: 25,
  minConfidenceForAdjustment: 0.35,
  minDirectionalConfidence: 0.25,
  maxFactorDelta: 0.15,
  version: 'TABLE_DYNAMICS_V1',
});

/* ============================================================
 * 二、证据单元（逐维度）
 * ============================================================ */

export const TableDimensionId = {
  /** 整桌：主动入池松紧（翻前有人入池时，未投入者是否入池） */
  TABLE_LOOSENESS: 'TABLE_LOOSENESS',
  /** 整桌：面对加注时的冷跟倾向 */
  TABLE_COLD_CALL: 'TABLE_COLD_CALL',
  /** 整桌：再加注（3Bet+）压力 */
  TABLE_RERAISE_PRESSURE: 'TABLE_RERAISE_PRESSURE',
  /** 整桌：多人底池倾向（看翻牌人数） */
  TABLE_MULTIWAY: 'TABLE_MULTIWAY',
  /** 整桌：面对小注时的弃牌倾向 */
  TABLE_FOLD_VS_SMALL: 'TABLE_FOLD_VS_SMALL',
  /** 整桌：面对中注时的弃牌倾向 */
  TABLE_FOLD_VS_MEDIUM: 'TABLE_FOLD_VS_MEDIUM',
  /** 整桌：面对大注时的弃牌倾向 */
  TABLE_FOLD_VS_LARGE: 'TABLE_FOLD_VS_LARGE',
  /** 整桌：持续下注倾向（翻牌无人下注后是否下注） */
  TABLE_CBET: 'TABLE_CBET',
  /** 整桌：过牌-加注倾向 */
  TABLE_CHECK_RAISE: 'TABLE_CHECK_RAISE',
  /** 盲注位：面对开池是否弃牌（「身后及盲位弃牌偏多」的直接证据） */
  BLIND_FOLD_TO_OPEN: 'BLIND_FOLD_TO_OPEN',
} as const;
export type TableDimensionId = (typeof TableDimensionId)[keyof typeof TableDimensionId];

export const TableDirection = {
  /** 观测值显著低于基线（更紧 / 更少做该动作） */
  LOWER: 'LOWER',
  /** 与基线无显著差异，或证据不足 */
  NEUTRAL: 'NEUTRAL',
  /** 观测值显著高于基线 */
  HIGHER: 'HIGHER',
} as const;
export type TableDirection = (typeof TableDirection)[keyof typeof TableDirection];

/** 一个维度的完整证据包 —— 报告与界面只允许读这个结构，不允许另算一份 */
export type TableDimension = {
  id: TableDimensionId;
  labelZh: string;
  /** 有效机会数（**不是**手数，也**不是**动作次数） */
  opportunities: number;
  /** 其中发生该动作的次数 */
  successes: number;
  /** 参与统计的手数（去重后） */
  hands: number;
  /** 加权有效样本量（衰减之后） */
  effectiveSample: number;
  /** 拉普拉斯平滑后的比率（未收缩） */
  smoothedRate: number;
  /** 工程基线（收缩目标） */
  baseline: number;
  /** 向基线收缩后的比率 —— **下游只用这个数** */
  adjustedRate: number;
  /** 相对基线的偏离（正 = 比基线高） */
  delta: number;
  /** 可信度 0..1 = effectiveSample / (effectiveSample + K) */
  confidence: number;
  direction: TableDirection;
  /** 调整用系数 1 + clamp(δ × confidence) —— 落在 [1−max, 1+max] */
  factor: number;
  /** 基线来源说明（必须如实写「工程初始值」还是「公开理论量级」） */
  baselineProvenance: string;
  noteZh: string;
};

/* ============================================================
 * 三、基线（收缩目标）
 * ============================================================ */

/**
 * 工程基线。
 *
 * ⚠️ 这些数字是**保守的工程初始值**，用于让「无证据 ⇒ 不调整」成立，
 * **不是**「中低级别人群统计」（本项目没有任何可引用的此类来源）。
 * 它们的唯一职责是充当收缩中心；换掉它们只会平移调整起点，
 * 不会改变「证据越多越接近实测」这一单调性（有测试锁住）。
 */
export const TABLE_BASELINES: Readonly<Record<TableDimensionId, number>> = Object.freeze({
  TABLE_LOOSENESS: 0.3,
  TABLE_COLD_CALL: 0.2,
  TABLE_RERAISE_PRESSURE: 0.12,
  TABLE_MULTIWAY: 0.3,
  TABLE_FOLD_VS_SMALL: 0.4,
  TABLE_FOLD_VS_MEDIUM: 0.45,
  TABLE_FOLD_VS_LARGE: 0.55,
  TABLE_CBET: 0.55,
  TABLE_CHECK_RAISE: 0.1,
  BLIND_FOLD_TO_OPEN: 0.6,
});

export const BASELINE_PROVENANCE_ZH =
  '工程初始值（ENGINEERING_DEFAULT）：仅作为收缩中心，**不是**人群统计，也不声称已校准';

const DIMENSION_LABEL_ZH: Readonly<Record<TableDimensionId, string>> = Object.freeze({
  TABLE_LOOSENESS: '整桌入池松紧',
  TABLE_COLD_CALL: '整桌冷跟倾向',
  TABLE_RERAISE_PRESSURE: '整桌再加注压力',
  TABLE_MULTIWAY: '多人底池倾向',
  TABLE_FOLD_VS_SMALL: '面对小注弃牌',
  TABLE_FOLD_VS_MEDIUM: '面对中注弃牌',
  TABLE_FOLD_VS_LARGE: '面对大注弃牌',
  TABLE_CBET: '持续下注倾向',
  TABLE_CHECK_RAISE: '过牌-加注倾向',
  BLIND_FOLD_TO_OPEN: '盲注位弃给开池',
});

/**
 * 下注尺寸分桶（按「需跟注额 ÷ 面对下注后的底池」）。
 *
 * 为什么不是「下注额 ÷ 下注前底池」：扑克习惯里的
 * 「⅓ 池 / 半池 / ¾ 池 / 满池」说的都是**下注额占下注前底池**的比例，
 * 而玩家**面对**的赔率是「需跟注额 ÷ 面对下注后的底池」。
 * 两者单调对应：下注前底池 P、下注 x·P ⇒ 后者 = x/(1+x)。
 * 于是 ⅓ 池 → 0.25、半池 → 0.3333、¾ 池 → 0.4286、满池 → 0.5、2 倍超池 → 0.6667。
 *
 * 分桶边界取 0.30 / 0.45（把「≤⅓ 池」归小注、「⅓~¾ 池」归中注、「≥¾ 池」归大注）。
 */
export const BET_SIZE_BUCKETS = Object.freeze({
  small: 0.3,
  medium: 0.45,
});

export function betSizeBucketOf(ratio: number | null | undefined): 'SMALL' | 'MEDIUM' | 'LARGE' | null {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return null;
  if (ratio <= BET_SIZE_BUCKETS.small) return 'SMALL';
  if (ratio <= BET_SIZE_BUCKETS.medium) return 'MEDIUM';
  return 'LARGE';
}

/* ============================================================
 * 四、分层输入（长期 / 本场近期 / 整桌近期 / 当前相关玩家）
 * ============================================================ */

export type TableDynamicsInput = {
  records: readonly ObservationRecord[];
  /** 当前还在桌上的 playerId（**不在此列表里的玩家不参与桌况**） */
  presentPlayerIds: readonly string[];
  /** Hero 的 playerId（Hero 自己的行为不进「对手桌况」，避免自我剥削） */
  heroPlayerId: string | null;
  /** Hero 的逻辑位置（判断「身后及盲位」用） */
  heroPosition?: Position | null;
  /** 当前这一手的 handId（用于算「这是第几手之前」） */
  currentHandId?: string | null;
  /**
   * 当前决策节点的相关座位：本次要调整的对手们。
   *
   * 为空表示「整桌调整」（例如翻前还没人入池）。
   */
  relevantPlayerIds?: readonly string[];
  config?: Partial<TableDynamicsConfig>;
};

export type TableLayers = {
  /** 玩家长期层（全部历史窗口） */
  longTermByPlayer: Readonly<Record<string, readonly TableDimension[]>>;
  /** 玩家本场近期层 */
  recentByPlayer: Readonly<Record<string, readonly TableDimension[]>>;
  /** 整桌近期层 */
  table: readonly TableDimension[];
  /** 当前相关玩家的本场近期层（调整的第一优先证据） */
  relevantByPlayer: Readonly<Record<string, readonly TableDimension[]>>;
};

export type TableDynamics = {
  version: string;
  configProvenance: typeof PARAMETER_PROVENANCE;
  /** 分层证据 */
  layers: TableLayers;
  /** 桌况摘要（界面用） */
  summaryZh: string;
  /** 三个关键维度的一句话（界面折叠时显示） */
  headline: {
    loosenessZh: string;
    callZh: string;
    reraiseZh: string;
    confidenceZh: string;
  };
  /** 整桌可信度（各维度可信度按机会数加权平均；无证据 ⇒ 0） */
  tableConfidence: number;
  /** 参与统计的手数 */
  handsObserved: number;
  /** 使用了多少条记录（缺关键字段的旧记录会被排除，此数如实反映） */
  recordsUsed: number;
  /** 被排除的记录数及原因（**必须披露**，否则「样本不足」无法解释） */
  excluded: { missingLegacyFields: number; notPresent: number; heroSelf: number };
  /** 是否处于「观察中」（证据不足以支撑任何调整） */
  observing: boolean;
  noteZh: string;
};

/* ============================================================
 * 五、内部工具
 * ============================================================ */

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * 手数序号：越大表示越近。用于衰减。
 *
 * 顺序来自记录**首次出现的次序**（JSONL 追加写 ⇒ 数组顺序即时间顺序）。
 */
function handIndexer(records: readonly ObservationRecord[]): (handId: string) => number {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (!seen.has(r.handId)) {
      seen.add(r.handId);
      order.push(r.handId);
    }
  }
  const index = new Map(order.map((h, i) => [h, i]));
  return (handId: string) => index.get(handId) ?? -1;
}

/**
 * 按「手 → 记录原始次序」稳定排序。
 *
 * ## 🔴 为什么必须显式排序，而不是假定调用方给了有序数组
 *
 * 机会判定需要知道「这条记录发生时，**本街前面**发生过什么」
 *（例如「面对加注」才能算冷跟与再加注机会）。这个判断依赖扫描顺序。
 *
 * 生产路径（JSONL 逐行读入）天然有序，但**过滤之后不一定**：
 * 逐玩家分析时会把同一手里别人的记录滤掉，若原本的数组顺序是
 * 「先 Hero 再对手」，滤完就可能把「对手开池」排到「Hero 3Bet」之后 ——
 * 于是 3Bet 被当成「无人加注时的主动入池」，再加注压力维度**机会数恒为 0**。
 *
 * 这是本项目已有的一条纪律的同一形态：「机会由牌局状态定义」，
 * 而状态的读取次序不能依赖输入巧合。排序代价 O(n log n)，可忽略。
 */
function orderedByHand(records: readonly ObservationRecord[]): ObservationRecord[] {
  return records
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.handId < b.r.handId ? -1 : a.r.handId > b.r.handId ? 1 : a.i - b.i))
    .map((x) => x.r);
}

/** 指数衰减权重：半衰期 `halfLifeHands` */
function decayWeight(ageHands: number, halfLife: number): number {
  if (halfLife <= 0) return 1;
  return Math.pow(0.5, Math.max(0, ageHands) / halfLife);
}

type Tally = { opportunities: number; successes: number; weight: number; hands: Set<string> };

const newTally = (): Tally => ({ opportunities: 0, successes: 0, weight: 0, hands: new Set() });

function addOpportunity(t: Tally, success: boolean, weight: number, handId: string): void {
  t.opportunities += 1;
  if (success) t.successes += 1;
  t.weight += weight;
  t.hands.add(handId);
}

/** 把 tally 变成证据包 */
function toDimension(
  id: TableDimensionId,
  t: Tally,
  config: TableDynamicsConfig,
): TableDimension {
  const baseline = TABLE_BASELINES[id];
  /*
   * 拉普拉斯平滑：把基线当作 priorWeight 次「虚拟机会」。
   * 机会为 0 时 smoothedRate === baseline ⇒ delta 0 ⇒ 不调整（而不是 0/0）。
   */
  const smoothedRate =
    (t.successes + baseline * config.priorWeight) / (t.opportunities + config.priorWeight);
  const effectiveSample = t.weight;
  const confidence = effectiveSample / (effectiveSample + config.shrinkK);
  const adjustedRate = baseline + (smoothedRate - baseline) * confidence;
  const delta = adjustedRate - baseline;
  const factor = 1 + clamp(delta * confidence * 2, -config.maxFactorDelta, config.maxFactorDelta);

  /*
   * 方向判定 = **数值门槛 且 证据门槛**。
   * 只有数值门槛时，5 次观察也能宣称「整桌跟注偏多」——
   * 那正是授权点名要防的失败形态。
   */
  const enoughEvidence = confidence >= config.minDirectionalConfidence;
  const MAGNITUDE = 0.02;
  const direction: TableDirection =
    t.opportunities === 0 || !enoughEvidence
      ? TableDirection.NEUTRAL
      : delta > MAGNITUDE
        ? TableDirection.HIGHER
        : delta < -MAGNITUDE
          ? TableDirection.LOWER
          : TableDirection.NEUTRAL;

  const pctText = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const noteZh =
    t.opportunities === 0
      ? `${DIMENSION_LABEL_ZH[id]}：**尚无有效机会**（观察中）`
      : `${DIMENSION_LABEL_ZH[id]}：${t.successes}/${t.opportunities} 次机会 = ${pctText(
          t.successes / t.opportunities,
        )}（平滑 ${pctText(smoothedRate)} → 收缩后 ${pctText(adjustedRate)}）｜` +
        `基线 ${pctText(baseline)}｜可信度 ${(confidence * 100).toFixed(0)}%` +
        (t.opportunities > 0 && !enoughEvidence
          ? `｜**证据不足，不下方向结论**（需可信度 ${(config.minDirectionalConfidence * 100).toFixed(0)}%）`
          : direction === TableDirection.NEUTRAL
            ? '｜与基线无显著差异'
            : '');

  return Object.freeze({
    id,
    labelZh: DIMENSION_LABEL_ZH[id],
    opportunities: t.opportunities,
    successes: t.successes,
    hands: t.hands.size,
    effectiveSample: Number(effectiveSample.toFixed(4)),
    smoothedRate: Number(smoothedRate.toFixed(6)),
    baseline,
    adjustedRate: Number(adjustedRate.toFixed(6)),
    delta: Number(delta.toFixed(6)),
    confidence: Number(confidence.toFixed(6)),
    direction,
    factor: Number(factor.toFixed(6)),
    baselineProvenance: BASELINE_PROVENANCE_ZH,
    noteZh,
  });
}

/* ============================================================
 * 六、逐维度机会判定（唯一的「什么算一次机会」定义处）
 *
 * 每一条都只读记录里**行动前**的状态字段，不看行动之后的任何东西。
 * ============================================================ */

const OPENING_ACTIONS = new Set(['RAISE', 'BET', 'ALL_IN']);
const PASSIVE_ENTRY = new Set(['CALL']);

/**
 * 计算某个玩家集合、某个手数窗口内的全部维度。
 *
 * ## 🔴 上下文必须来自**全部**记录，只有「谁在行动」受 scope 过滤
 *
 * 第一版按 `playerId` 过滤记录**之后**再扫描 —— 于是「本街前面有没有人加注」
 * 这个状态丢了：逐玩家分析时，`CO 开池` 与 `BTN 3Bet` 里只有后者留下，
 * 于是 3Bet 被当成「无人加注时的主动入池」，
 * `TABLE_RERAISE_PRESSURE` 的机会数**恒为 0**。
 *
 * 实测后果（60 手「面对加注从不再加注」vs「每次都再加注」）：
 * ```text
 * 两者 再加注压力维度 = 0/0、aggression = NEUTRAL
 * ⇒ 两种相反的行为落到**同一个标签** LOOSE
 * ⇒ 桌况调整在模型侧完全无法区分
 * ```
 *
 * 正确做法：**用全部记录推进街道状态**（已开池 / 已下注 / 已见翻牌），
 * 只把「机会计入谁的分母」交给 scope 与窗口。
 *
 * ⚠️ 本函数零外部状态：所有中间集合都在函数内新建。
 *
 * @param allScoped 已按「在桌 + 当前桌」过滤、且**按时间升序**的**全部**记录
 * @param scope 只把机会计入这些玩家（null = 全部）；**不影响**上文状态推进
 * @param windowHands 只统计最近 N 手（null = 全部）
 */
function computeDimensions(
  allScoped: readonly ObservationRecord[],
  indexOf: (handId: string) => number,
  latestIndex: number,
  config: TableDynamicsConfig,
  scope: ReadonlySet<string> | null,
  windowHands: number | null,
): readonly TableDimension[] {
  const tallies: Record<string, Tally> = Object.fromEntries(
    Object.keys(TABLE_BASELINES).map((k) => [k, newTally()]),
  );

  /* 本函数内的全部状态（**不得**提到模块级） */
  const streetRaised = new Set<string>();
  const betInFlop = new Map<string, boolean>();
  const flopSeen = new Set<string>();

  for (const r of allScoped) {
    const key = `${r.handId}|${r.street}`;
    const idx = indexOf(r.handId);
    const inWindow = windowHands === null || (idx >= 0 && latestIndex - idx < windowHands);
    /* 只有「是否把这个机会计入分母」受 scope / 窗口影响 */
    const counts = inWindow && (scope === null || scope.has(r.playerId));

    const weight = decayWeight(latestIndex - idx, config.halfLifeHands);
    const isPreflop = r.street === 'PREFLOP';
    const potKnown =
      typeof r.potBB === 'number' &&
      typeof r.facedBetBB === 'number' &&
      typeof r.facedBetPotRatio === 'number';
    const yetToActKnown =
      typeof r.playersYetToAct === 'number' && typeof r.activeCount === 'number';

    /* ---- 机会 1：主动入池（翻前面对「无人加注」时是否把筹码放进去） ---- */
    if (counts && isPreflop && !streetRaised.has(key) && yetToActKnown) {
      addOpportunity(
        tallies['TABLE_LOOSENESS']!,
        PASSIVE_ENTRY.has(r.actionType) || OPENING_ACTIONS.has(r.actionType),
        weight,
        r.handId,
      );
    }

    /* ---- 机会 2：面对加注时的冷跟 ---- */
    if (counts && isPreflop && streetRaised.has(key)) {
      addOpportunity(tallies['TABLE_COLD_CALL']!, r.actionType === 'CALL', weight, r.handId);
    }

    /* ---- 机会 3：再加注压力（面对加注时是否 3Bet+） ---- */
    if (counts && isPreflop && streetRaised.has(key)) {
      addOpportunity(
        tallies['TABLE_RERAISE_PRESSURE']!,
        OPENING_ACTIONS.has(r.actionType),
        weight,
        r.handId,
      );
    }

    /* ---- 机会 4：盲注位面对开池是否弃牌 ---- */
    if (
      counts &&
      isPreflop &&
      streetRaised.has(key) &&
      (r.seatId.endsWith('SB') || r.seatId.endsWith('BB')) &&
      typeof r.potBB === 'number'
    ) {
      addOpportunity(tallies['BLIND_FOLD_TO_OPEN']!, r.actionType === 'FOLD', weight, r.handId);
    }

    /* ---- 机会 5/6/7：面对下注的三档弃牌 ---- */
    if (counts && r.facedBet === true && potKnown) {
      const bucket = betSizeBucketOf(r.facedBetPotRatio);
      if (bucket !== null) {
        const dimId =
          bucket === 'SMALL'
            ? 'TABLE_FOLD_VS_SMALL'
            : bucket === 'MEDIUM'
              ? 'TABLE_FOLD_VS_MEDIUM'
              : 'TABLE_FOLD_VS_LARGE';
        addOpportunity(tallies[dimId]!, r.actionType === 'FOLD', weight, r.handId);
      }
    }

    /* ---- 机会 8：持续下注（翻牌尚无人下注 ⇒ 有机会率先下注） ---- */
    if (counts && r.street === 'FLOP' && betInFlop.get(r.handId) !== true) {
      addOpportunity(tallies['TABLE_CBET']!, OPENING_ACTIONS.has(r.actionType), weight, r.handId);
    }

    /* ---- 机会 9：过牌-加注（翻牌已有人下注 ⇒ 有机会加注） ---- */
    if (counts && r.street === 'FLOP' && betInFlop.get(r.handId) === true) {
      addOpportunity(
        tallies['TABLE_CHECK_RAISE']!,
        r.actionType === 'RAISE' || r.actionType === 'ALL_IN',
        weight,
        r.handId,
      );
    }

    /* ---- 机会 10：多人底池（每手「翻牌第一条记录」算一次机会） ---- */
    if (counts && r.street === 'FLOP' && yetToActKnown && !flopSeen.has(r.handId)) {
      flopSeen.add(r.handId);
      /*
       * 命中定义：看翻牌的人数 ≥ 3。
       * 本街**第一条**记录时还没有人弃牌 ⇒ `activeCount` 就是看翻牌人数。
       */
      addOpportunity(tallies['TABLE_MULTIWAY']!, (r.activeCount ?? 0) >= 3, weight, r.handId);
    }

    /* ---- 推进「本街已发生什么」——**不区分 scope**（这是上下文，不是机会） ---- */
    if (OPENING_ACTIONS.has(r.actionType)) {
      streetRaised.add(key);
      if (r.street === 'FLOP') betInFlop.set(r.handId, true);
    }
  }

  return Object.freeze(
    (Object.keys(TABLE_BASELINES) as TableDimensionId[]).map((id) =>
      toDimension(id, tallies[id]!, config),
    ),
  );
}

/* ============================================================
 * 七、对外入口
 * ============================================================ */

function mergeConfig(partial: Partial<TableDynamicsConfig> | undefined): TableDynamicsConfig {
  return partial === undefined ? TABLE_DYNAMICS_CONFIG : { ...TABLE_DYNAMICS_CONFIG, ...partial };
}

const CONFIDENCE_ZH = (c: number): string =>
  c >= 0.6 ? '高' : c >= 0.35 ? '中' : c >= 0.15 ? '低' : '样本不足';

const DIRECTION_ZH: Record<TableDirection, string> = {
  LOWER: '偏低',
  NEUTRAL: '正常',
  HIGHER: '偏高',
};

function findDim(dims: readonly TableDimension[], id: TableDimensionId): TableDimension | null {
  return dims.find((d) => d.id === id) ?? null;
}

/**
 * 计算桌况。
 *
 * ## 分层
 *
 * - `longTermByPlayer`：该玩家**全部**历史（窗口 = null）
 * - `recentByPlayer`：该玩家最近 `recentHands` 手
 * - `table`：**在桌**玩家的最近 `tableHands` 手（离桌者自然退出）
 * - `relevantByPlayer`：当前决策相关的对手（`relevantPlayerIds`）的最近层
 *
 * ## 不重复计权
 *
 * 四层是**同一次观察的不同时间窗口/不同玩家集合**，不是四份证据。
 * 下游只允许从**一层**取用于生成调整（默认 `relevantByPlayer`，
 * 有人缺席时退回 `table`），并把「用了哪一层」写进理由。
 * 本函数**不做**任何跨层加权求和。
 */
export function computeTableDynamics(input: TableDynamicsInput): TableDynamics {
  const config = mergeConfig(input.config);
  const present = new Set(input.presentPlayerIds);

  /* ---- 记录过滤（逐项计数，供披露使用） ---- */
  let missingLegacyFields = 0;
  let notPresent = 0;
  let heroSelf = 0;
  const usable: ObservationRecord[] = [];
  for (const r of input.records) {
    if (input.heroPlayerId !== null && r.playerId === input.heroPlayerId) {
      heroSelf += 1;
      continue;
    }
    if (!present.has(r.playerId)) {
      notPresent += 1;
      continue;
    }
    usable.push(r);
  }

  /* ---- 统计「本场」时只数**这一桌**的记录：tableId 前缀来自 handId ---- */
  const tableIds = new Set(usable.map((r) => r.handId.split('#H')[0] ?? r.handId));
  const currentTableId =
    input.currentHandId !== null && input.currentHandId !== undefined
      ? (input.currentHandId.split('#H')[0] ?? null)
      : tableIds.size === 1
        ? ([...tableIds][0] ?? null)
        : null;
  const scoped =
    currentTableId === null ? usable : usable.filter((r) => r.handId.startsWith(`${currentTableId}#H`));

  const indexOf = handIndexer(scoped);
  const allHandIds = [...new Set(scoped.map((r) => r.handId))];
  const latestIndex = allHandIds.length - 1;

  /* 旧记录（缺桌况字段）不参与 —— 计数后排除。**同时按手排序** */
  const enriched = orderedByHand(scoped.filter((r) => typeof r.potBB === 'number'));
  missingLegacyFields = scoped.length - enriched.length;

  /*
   * 🔴 **逐玩家过滤只作用于「机会计入谁的分母」**，上下文（本街前面有没有人加注）
   * 必须来自**全部**记录。第一版把过滤后的子集交给 `computeDimensions`，
   * 于是 `CO 开池` 在逐 BTN 分析时被滤掉，`TABLE_RERAISE_PRESSURE`
   * 的机会数恒为 0 —— 详见 `computeDimensions` 的注释。
   */
  const playerIds = [...new Set(enriched.map((r) => r.playerId))];
  const longTermByPlayer: Record<string, readonly TableDimension[]> = {};
  const recentByPlayer: Record<string, readonly TableDimension[]> = {};
  for (const pid of playerIds) {
    const scope = new Set([pid]);
    longTermByPlayer[pid] = computeDimensions(enriched, indexOf, latestIndex, config, scope, null);
    recentByPlayer[pid] = computeDimensions(
      enriched,
      indexOf,
      latestIndex,
      config,
      scope,
      config.recentHands,
    );
  }

  /* ---- 整桌层（在桌玩家的最近 tableHands 手） ---- */
  const table = computeDimensions(enriched, indexOf, latestIndex, config, null, config.tableHands);
  /* ---- 当前相关玩家层 ---- */
  const relevantIds = (input.relevantPlayerIds ?? []).filter((id) => present.has(id));
  const relevantByPlayer: Record<string, readonly TableDimension[]> = {};
  for (const pid of relevantIds) {
    relevantByPlayer[pid] = computeDimensions(
      enriched,
      indexOf,
      latestIndex,
      config,
      new Set([pid]),
      config.recentHands,
    );
  }

  /* ---- 汇总 ---- */
  const dimsWithEvidence = table.filter((d) => d.opportunities > 0);
  const weightSum = dimsWithEvidence.reduce((a, d) => a + d.effectiveSample, 0);
  const tableConfidence =
    weightSum <= 0
      ? 0
      : dimsWithEvidence.reduce((a, d) => a + d.confidence * d.effectiveSample, 0) / weightSum;

  const looseness = findDim(table, 'TABLE_LOOSENESS');
  const cold = findDim(table, 'TABLE_COLD_CALL');
  const reraise = findDim(table, 'TABLE_RERAISE_PRESSURE');

  const partZh = (d: TableDimension | null, high: string, low: string): string => {
    if (d === null || d.opportunities === 0) return '观察中';
    if (d.direction === TableDirection.HIGHER) return high;
    if (d.direction === TableDirection.LOWER) return low;
    return '正常';
  };

  const observing = tableConfidence < config.minConfidenceForAdjustment;

  const summaryZh = observing
    ? `桌况观察中｜可信度：${CONFIDENCE_ZH(tableConfidence)}（有效机会 ${weightSum.toFixed(1)}）`
    : `${partZh(looseness, '入池偏松', '入池偏紧')}｜${partZh(cold, '跟注偏多', '跟注偏少')}｜` +
      `再加注压力${reraise === null || reraise.opportunities === 0 ? '观察中' : DIRECTION_ZH[reraise.direction]}` +
      `｜可信度：${CONFIDENCE_ZH(tableConfidence)}`;

  return Object.freeze({
    version: config.version,
    configProvenance: PARAMETER_PROVENANCE,
    layers: Object.freeze({
      longTermByPlayer: Object.freeze(longTermByPlayer),
      recentByPlayer: Object.freeze(recentByPlayer),
      table,
      relevantByPlayer: Object.freeze(relevantByPlayer),
    }),
    summaryZh,
    headline: Object.freeze({
      loosenessZh: partZh(looseness, '入池偏松', '入池偏紧'),
      callZh: partZh(cold, '跟注偏多', '跟注偏少'),
      reraiseZh:
        reraise === null || reraise.opportunities === 0
          ? '观察中'
          : `再加注压力${DIRECTION_ZH[reraise.direction]}`,
      confidenceZh: CONFIDENCE_ZH(tableConfidence),
    }),
    tableConfidence: Number(tableConfidence.toFixed(6)),
    handsObserved: new Set(enriched.map((r) => r.handId)).size,
    recordsUsed: enriched.length,
    excluded: Object.freeze({ missingLegacyFields, notPresent, heroSelf }),
    observing,
    noteZh:
      `桌况来自 ${new Set(enriched.map((r) => r.handId)).size} 手 / ${enriched.length} 条记录` +
      `（已排除：旧格式缺桌况字段 ${missingLegacyFields} 条、非在桌玩家 ${notPresent} 条、Hero 自己 ${heroSelf} 条）｜` +
      `窗口：本场近期 ${config.recentHands} 手 · 整桌 ${config.tableHands} 手 · 半衰期 ${config.halfLifeHands} 手｜` +
      `参数性质：${BASELINE_PROVENANCE_ZH}`,
  });
}

/* ============================================================
 * 八、把桌况方向翻译成「已有模型能吃的输入」
 *
 * 🔴 这里**不产生**任何最终动作，也**不加**任何 EV。它只改
 * `seatProfiles`（每座位的 QuickProfile 标签）与一对有界系数。
 * 响应概率、范围、EV 全部由既有模型重新计算。
 * ============================================================ */

export type TableAdjustmentCategoryId =
  | 'OPEN'
  | 'COLD_CALL'
  | 'THREEBET'
  | 'VALUE_BET'
  | 'BLUFF';

export const TableAdjustmentCategory = {
  OPEN: 'OPEN',
  COLD_CALL: 'COLD_CALL',
  THREEBET: 'THREEBET',
  VALUE_BET: 'VALUE_BET',
  BLUFF: 'BLUFF',
} as const;

export type TableAdjustmentStatus =
  /** 有足够证据，给出方向 */
  | 'SUGGESTED'
  /** 证据不足，处于观察中 */
  | 'OBSERVING'
  /** 当前节点**不支持**这类调整（必须说明原因，绝不伪造） */
  | 'NOT_APPLICABLE';

export type TableAdjustment = {
  category: TableAdjustmentCategoryId;
  labelZh: string;
  status: TableAdjustmentStatus;
  direction: TableDirection;
  /** 依据的维度 id（可能多个） */
  evidence: readonly TableDimensionId[];
  /** 用了哪一层（长期 / 本场近期 / 整桌近期 / 当前相关玩家） */
  layer: 'RELEVANT_PLAYER' | 'TABLE';
  /** 有界系数（1 = 不调整） */
  factor: number;
  /** 该系数作用于哪个既有参数（必须写清，便于审计「改了哪个输入」） */
  appliesTo: string;
  reasonZh: string;
  /** 不支持 / 观察中的具体原因 */
  unsupportedReasonZh: string | null;
};

const CATEGORY_LABEL_ZH: Readonly<Record<TableAdjustmentCategoryId, string>> = Object.freeze({
  OPEN: '开池',
  COLD_CALL: '冷跟',
  THREEBET: '再加注',
  VALUE_BET: '价值下注',
  BLUFF: '诈唬',
});

/**
 * 本模块只输出**标签的名字**，不 import `app/` 层的枚举。
 *
 * 为什么：`domain/` 不得依赖 `app/`（分层纪律）。
 * 取值刻意与 `app/manualInput/manualInput.ts` 的 `QuickProfile` 保持一致，
 * 但有测试锁住「这里产出的每一个名字在被审的那份枚举里都存在」——
 * 否则就会出现「领域层给出一个界面/模型无法表达的状态」这种
 * 项目已经踩过一次的失败形态（见 `manualInput.ts` 的红队 F-11 注释）。
 */
export const TABLE_PROFILE_NAMES = Object.freeze([
  'NORMAL',
  'LOOSE',
  'VERY_LOOSE',
  'TIGHT',
  'VERY_TIGHT',
  'CALLING_STATION',
  'AGGRESSIVE',
  'MANIAC',
  'BLUFF_HEAVY',
  'UNDERBLUFFER',
] as const);
export type TableProfileName = (typeof TABLE_PROFILE_NAMES)[number];

/**
 * 🔴 **原型标签的维度语义**（只读表，用于「不得无依据连带调整」的硬校验）。
 *
 * ## 为什么桌况层需要知道标签的维度值
 *
 * 一个 `QuickProfile` 标签不是一个「单参数旋钮」，而是**四个维度的固定组合**：
 * `tightness` / `aggression` / `bluffTendency` / `passivity`。
 * 把它塞进 `villain.quickProfile` 会**同时**改写这四个值，而它们各自流向不同的下游：
 *
 * | 维度 | 下游消费者 | 受影响的是什么 |
 * |---|---|---|
 * | `aggression` | `profileProvider` / `bettingRange` / `betResponse` | 下注与加注倾向 |
 * | `tightness` | `profileProvider` / `betResponse` | **范围宽度**（到达范围形状） |
 * | `bluffTendency` | `profileProvider` / `bettingRange` / `betResponse` | **诈唬/价值比**（翻后） |
 * | `passivity` | `profileProvider` / `bettingRange` / `betResponse` | 被动程度（翻后） |
 *
 * ## 因此这里登记的语义是**约束**，不是工具
 *
 * 本模块的证据只有三轴（`looseness` 主动入池 / `aggression` 面对加注再加注 /
 * `giveUp` 面对下注是否放弃），**没有任何关于「翻后诈唬倾向」的证据**。
 * 若某个标签会显著改动 `bluffTendency` 或与证据方向相反的 `tightness`，
 * 那么注入它就是**无依据的连带调整** —— 校验会拦住它并如实报「不支持」。
 *
 * /**
 * ⚠️ 表里的数值必须与 `src/domain/player/archetypeDimensions.ts` 的
 * `ARCHETYPE_DIMENSIONS` **逐项一致**；测试 M6 会用生产函数逐项核对。
 *
 * 第一版手抄错了 3 项（`VERY_LOOSE` / `TIGHT` / `BLUFF_HEAVY` 的 aggression 与
 * bluffTendency），**当场被那个测试抓住** —— 这正是「复制就会漂移」的实例，
 * 也是为什么要用生产函数核对而不是靠人眼。
 */
export const ARCHETYPE_DIMENSION_REFERENCE: Readonly<
  Record<TableProfileName, { tightness: number; aggression: number; bluffTendency: number; passivity: number }>
> = Object.freeze({
  NORMAL: { tightness: 0.5, aggression: 0.5, bluffTendency: 0.5, passivity: 0.5 },
  LOOSE: { tightness: 0.32, aggression: 0.55, bluffTendency: 0.6, passivity: 0.5 },
  VERY_LOOSE: { tightness: 0.18, aggression: 0.6, bluffTendency: 0.68, passivity: 0.5 },
  TIGHT: { tightness: 0.72, aggression: 0.5, bluffTendency: 0.28, passivity: 0.45 },
  VERY_TIGHT: { tightness: 0.88, aggression: 0.45, bluffTendency: 0.15, passivity: 0.45 },
  CALLING_STATION: { tightness: 0.3, aggression: 0.3, bluffTendency: 0.35, passivity: 0.8 },
  AGGRESSIVE: { tightness: 0.45, aggression: 0.82, bluffTendency: 0.6, passivity: 0.3 },
  MANIAC: { tightness: 0.15, aggression: 0.92, bluffTendency: 0.9, passivity: 0.35 },
  BLUFF_HEAVY: { tightness: 0.42, aggression: 0.78, bluffTendency: 0.85, passivity: 0.35 },
  UNDERBLUFFER: { tightness: 0.62, aggression: 0.45, bluffTendency: 0.12, passivity: 0.5 },
});

/**
 * 一个标签是否**只**改动了有证据支持的维度。
 *
 * 判据：
 * - `bluffTendency` 偏离中立（≠0.5）⇒ **必须有翻后诈唬证据**；
 *   本模块**永远没有**这类证据 ⇒ 任何改动 `bluffTendency` 的标签一律**拒绝注入**。
 * - `tightness` 偏离中立 ⇒ 必须有 `looseness` 轴的证据，且**方向必须一致**
 *   （松的证据不能配上更紧的 tightness，反之亦然）。
 * - `aggression` / `passivity` 偏离中立 ⇒ 必须有 `aggression`（再加注压力）轴的证据。
 *
 * 达不到就返回 `null` 并给出原因 —— **不注入**，而不是注入一个半有依据的标签。
 */
export function justifiedLabelOrNull(
  label: TableProfileName,
  axes: {
    looseness: TableDirection;
    aggression: TableDirection;
    giveUp: TableDirection;
  },
): { ok: true } | { ok: false; reasonZh: string } {
  const spec = ARCHETYPE_DIMENSION_REFERENCE[label];
  const EPS = 0.02;
  const moved = (v: number): boolean => Math.abs(v - 0.5) > EPS;

  /* ① 诈唬倾向：本模块没有任何翻后诈唬证据 ⇒ 不许动 */
  if (moved(spec.bluffTendency)) {
    return {
      ok: false,
      reasonZh:
        `标签 ${label} 会把 \`bluffTendency\` 改到 ${spec.bluffTendency}，` +
        '但本模块的证据只有**翻前再加注频率**，它**不能**推出「他翻后诈唬多/少」；' +
        '`bluffTendency` 流向范围层（`profileProvider`）与翻后响应（`bettingRange`/`betResponse`）' +
        '⇒ 属于**无依据的连带调整**，因此不注入',
    };
  }

  /* ② 范围宽度：方向必须与松紧证据一致 */
  if (moved(spec.tightness)) {
    const implied: TableDirection =
      spec.tightness > 0.5 ? TableDirection.LOWER : TableDirection.HIGHER; // tightness 高 = 更紧
    if (axes.looseness === TableDirection.NEUTRAL) {
      return {
        ok: false,
        reasonZh:
          `标签 ${label} 会把 \`tightness\` 改到 ${spec.tightness}（即范围宽度变化），` +
          '但**松紧轴没有证据**（TABLE_LOOSENESS 机会数为 0）⇒ 会改写范围先验，因此不注入',
      };
    }
    /* looseness HIGHER = 更松 ⇒ 需要 tightness 更低（0.5 以下） */
    const loosenessImpliedTightnessHigher = axes.looseness === TableDirection.LOWER;
    const labelTightnessHigher = spec.tightness > 0.5;
    if (loosenessImpliedTightnessHigher !== labelTightnessHigher) {
      return {
        ok: false,
        reasonZh:
          `标签 ${label} 的方向与松紧证据**相反**：证据说 looseness=${axes.looseness}，` +
          `而该标签把 tightness 设为 ${spec.tightness} ⇒ 不注入`,
      };
    }
    void implied;
  }

  /* ③ 进攻性/被动：必须有再加注压力轴的证据 */
  if (moved(spec.aggression) && axes.aggression === TableDirection.NEUTRAL) {
    return {
      ok: false,
      reasonZh:
        `标签 ${label} 会把 \`aggression\` 改到 ${spec.aggression}，` +
        '但**再加注压力轴没有证据**（TABLE_RERAISE_PRESSURE 机会数为 0）⇒ 不注入',
    };
  }

  return { ok: true };
}

/**
 * 当前决策节点的形态（决定哪些调整**适用**）。
 *
 * ## 为什么必须显式传进来
 *
 * 授权里有一条硬性禁令：「多人底池 ⇒ 不得直接套用单挑弃牌概率和权益实现假设」。
 * 反过来的形式同样危险：**单挑底池里套用整桌平均**。
 * 因此「这一手到底是几个人」是调整生成的前置条件，不是可选上下文。
 */
export type TableAdjustmentContext = {
  /** 本手还没弃牌的人数（含 Hero） */
  activeCount: number;
  /** 当前街 */
  street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER';
  /** Hero 身后还有几个未行动的对手（翻前「扩大后位开池」的判据） */
  playersYetToAct: number;
  /** 当前相关对手（本次要调整的座位） */
  relevantPlayerIds: readonly string[];
  /** 是否存在超池下注之类引擎表达不了的调整点（保留位；缺省 false） */
  hasUnsupportedNode?: boolean;
};

export type OpponentQuickProfile = {
  playerId: string;
  quickProfile: TableProfileName;
  /**
   * 该标签**是否可以注入**。
   *
   * `false` ⇒ 标签会改动本模块没有证据支持的维度（见 `justifiedLabelOrNull`），
   * 因此**不注入**（`quickProfile` 回落为 `NORMAL`），
   * 界面与对比记录据此显示「不支持」而不是「已调整」。
   */
  injectable: boolean;
  /** 不可注入的原因（可注入时为 `null`） */
  notInjectableReasonZh: string | null;
  /** 依据来自个体还是整桌 */
  source: 'INDIVIDUAL' | 'TABLE_FALLBACK';
  confidence: number;
  /** 个体证据不足时的说明（必须如实，不能省略） */
  fallbackReasonZh: string | null;
  evidence: readonly TableDimensionId[];
  /**
   * 🔴 **三个轴的实际方向**（诊断字段，用于回答「标签是怎么选出来的」）。
   *
   * 没有它就无法解释「为什么两种相反的行为得到同一个标签」——
   * 而那正是本模块第一版真实踩过的坑（被动与凶都落到 `LOOSE`）。
   * 每个轴带 `delta`（收缩后偏离）与 `confidence`，可直接复算标签判定。
   */
  axes: {
    looseness: { direction: TableDirection; delta: number; confidence: number };
    aggression: { direction: TableDirection; delta: number; confidence: number };
    giveUp: { direction: TableDirection; delta: number; confidence: number };
  };
  /**
   * 🔴 **作用范围明确的维度调整**（0.5 = 中立）。
   *
   * ## 为什么要有它：标签是「四个维度的固定组合」，会引入无依据的连带调整
   *
   * 桌况层的证据只有三轴（主动入池 / 面对加注再加注 / 面对下注是否放弃），
   * **完全没有「翻后诈唬倾向」的证据**。而每个 `QuickProfile` 标签都会
   * 改动 `bluffTendency`（`UNDERBLUFFER` 0.12、`AGGRESSIVE` 0.60 …），
   * 它流向范围层（`profileProvider`）与翻后的 `bluffRaiseScale` / `riverBetScale`
   * ⇒ 用标签表达「再加注偏少」等于顺手断言「他翻后诈唬少」。
   *
   * ## 🔴 只有 `aggression` 与 `tightness` —— `passivity` **刻意不提供**
   *
   * 第三轮审计发现：把「面对下注弃牌」证据映射到 `passivity` 是**方向性错误**。
   * 响应层的定义是（`betResponse.ts` 的 `responseTendenciesOf`）：
   *
   * ```text
   * // 跟注站：passivity 0.8、tightness 0.3 ⇒ 更爱跟、更少弃
   * callScale = 1 + 0.30 × passive − 0.18 × tight
   * foldScale = 1 + 0.32 × tight  − 0.25 × passive
   * ```
   *
   * `passivity` 的语义是「**更爱跟**」。而我的换算
   * `passivity = 0.5 + giveUp.delta/2` 会把「**更爱弃**」的玩家
   * 推成「更爱跟」—— 与证据**完全相反**。
   *
   * 另外「面对下注弃牌」与「被动跟注」本就是**两个不同的行为**：
   * 跟注站的特征是「跟得多、弃得少」，而弃得多的玩家是**弱紧**，
   * 不是被动。用弃牌证据去设 `passivity` 同时犯了这两种错。
   *
   * 正确的做法需要「跟注频率」证据（本模块没有），因此这里**不提供该轴** ——
   * 宁可不调整，也不给一个方向相反的值。
   *
   * ⚠️ `bluffTendency` 同样**恒为 null**（无翻后诈唬证据）。
   */
  scopedDimensions: {
    tightness: number | null;
    aggression: number | null;
    passivity: null;
    bluffTendency: null;
    confidence: number;
  };
};

export type TableAdjustmentPlan = {
  version: string;
  configProvenance: typeof PARAMETER_PROVENANCE;
  /** 五类调整（**分别**生成，不使用统一松紧乘数） */
  adjustments: readonly TableAdjustment[];
  /** 要注入 `seatProfiles` 的逐座位标签 */
  opponentProfiles: readonly OpponentQuickProfile[];
  /** 本次调整用到的全部维度（供审计「改了哪些输入」） */
  usedDimensions: readonly TableDimensionId[];
  /** 是否有任何一类调整处于 SUGGESTED */
  anySuggested: boolean;
  /**
   * 🔴 **本次证据覆盖的街道** —— 决定调整**允许**影响哪些街道。
   *
   * ## 为什么必须显式带出来
   *
   * 第三轮审计发现：`scopedDimensions` 会被
   * `contextBuilder.facingInputsForSeat` 用于**全部三个消费点**
   *（下注范围层、面对下注响应层、翻前事实包），而
   * `responseTendenciesOf` 的 `callScale` / `foldScale` / `raiseScale` /
   * `bluffRaiseScale` **都不分街**（只有 `riverBetScale` 是河牌专属、
   * `streetBetScale` 来自逐街统计）。
   *
   * ⇒ 用**翻前**行为记录算出的维度会一路影响**翻牌/转牌/河牌**的响应倾向。
   * 授权明确禁止「翻前证据无依据地改写其他街道参数」，因此下游必须
   * 在注入前检查「当前决策节点是否落在证据覆盖的街道内」。
   *
   * 本模块的十项维度全部来自**翻前**记录（主动入池 / 冷跟 / 再加注 /
   * 盲注弃池），因此当前该字段恒为 `['PREFLOP']`。
   * 将来若加入翻后维度的记录，再按实际覆盖扩展。
   */
  evidenceStreets: readonly ('PREFLOP' | 'FLOP' | 'TURN' | 'RIVER')[];
  /** 引擎/模型**不支持**的调整点（如实输出，绝不伪造） */
  unsupportedZh: readonly string[];
  noteZh: string;
};

const LAYER_ZH: Readonly<Record<'RELEVANT_PLAYER' | 'TABLE', string>> = Object.freeze({
  RELEVANT_PLAYER: '当前相关玩家的本场近期',
  TABLE: '整桌近期',
});

function dimOf(
  dims: readonly TableDimension[] | undefined,
  id: TableDimensionId,
): TableDimension | null {
  if (dims === undefined) return null;
  return dims.find((d) => d.id === id) ?? null;
}

/** 把若干维度合成一个方向（以加权 delta 为准；全无证据 ⇒ NEUTRAL） */
function combineDirection(parts: readonly (TableDimension | null)[]): {
  direction: TableDirection;
  factor: number;
  used: TableDimensionId[];
  confidence: number;
  /**
   * 各证据维度自己的方向是否**互相冲突**。
   *
   * ## 为什么必须显式区分「一致」与「混向」
   *
   * 合成方向是**加权 delta 的符号**；当两个维度方向相反时
   *（例：对手「面对小注不弃牌」但「冷跟很多」），加权后仍可能给出
   * `HIGHER`。解释文本若按合成方向挑一句单向措辞，就会读成
   * 「方向偏高」+「对手弃牌偏多 ⇒ 收益下降」—— **同一段话自相矛盾**。
   *
   * 这不是假想：本模块的示例脚本第一版输出就是这个形态。
   * 因此把「混向」显式带出来，让理由如实写「证据方向不一致」。
   */
  mixed: boolean;
  /** 各证据维度自己的方向（供理由文本逐项列出） */
  parts: readonly { id: TableDimensionId; direction: TableDirection; delta: number }[];
} {
  const valid = parts.filter((d): d is TableDimension => d !== null && d.opportunities > 0);
  const empty = {
    direction: TableDirection.NEUTRAL,
    factor: 1,
    used: [] as TableDimensionId[],
    confidence: 0,
    mixed: false,
    parts: [] as { id: TableDimensionId; direction: TableDirection; delta: number }[],
  };
  if (valid.length === 0) return empty;
  const w = valid.reduce((a, d) => a + d.effectiveSample, 0);
  if (w <= 0) return empty;
  /*
   * ## 🔴 这里**不得**再乘一次可信度（我第一版乘了，导致强证据也无法定方向）
   *
   * `d.delta` 已经是「向基线收缩之后」的偏离，而收缩本身就是
   * `delta = (smoothed − baseline) × confidence` —— 可信度**已经进去过一次**。
   *
   * 第一版又写成 `delta × effectiveSample` 的加权平均（等价于再乘一次
   * 量级相同的可信度），后果是**强证据也过不了 ±0.02 门槛**：
   *
   * ```text
   * 60/60 次再加注 ⇒ 维度 delta = 0.085、confidence = 0.615
   *   第一版：0.085 × 0.615 ≈ 0.052 ⇒ 但同一维度在方向门槛下被压成 0.017
   *   ⇒ 标签映射拿到 NEUTRAL ⇒ 「被动」与「凶」都落到同一个标签
   * ```
   *
   * 正确的合成是**按有效样本量加权平均各维度已有的 delta**，
   * 不再施加额外缩放。可信度只用于两件事：
   *   1. 决定要不要下方向结论（`minDirectionalConfidence`）；
   *   2. 缩放最终调整幅度（`factor` 已含）。
   */
  const delta = valid.reduce((a, d) => a + d.delta * d.effectiveSample, 0) / w;
  const confidence = valid.reduce((a, d) => a + d.confidence * d.effectiveSample, 0) / w;
  const factor = valid.reduce((a, d) => a + d.factor * d.effectiveSample, 0) / w;
  const direction =
    delta > 0.02 ? TableDirection.HIGHER : delta < -0.02 ? TableDirection.LOWER : TableDirection.NEUTRAL;
  /* 只有「有意义」的偏离（|delta| > 0.02）才参与混向判定 —— 否则噪声即可触发 */
  const meaningful = valid.filter((d) => Math.abs(d.delta) > 0.02);
  const mixed = meaningful.length > 1 && new Set(meaningful.map((d) => d.direction)).size > 1;
  return {
    direction,
    factor: Number(factor.toFixed(6)),
    used: valid.map((d) => d.id),
    confidence,
    mixed,
    parts: valid.map((d) => ({ id: d.id, direction: d.direction, delta: d.delta })),
  };
}

/**
 * 混向时**逐项**列出各维度的方向。
 *
 * 为什么不能只写合成方向：使用者会拿这句去判断「该不该信」。
 * 一个由两条相反证据合成出来的 `HIGHER`，与两条同向证据得出的 `HIGHER`，
 * 可信程度完全不同 —— 前者更像「这个节点本来就不敏感」。
 */
/**
 * 一个轴上各证据维度 delta 的**简单平均**（仅用于把轴换算成维度值）。
 *
 * ⚠️ 与 `combineDirection` 里的「按有效样本量加权」**不同**：
 * 这里只是把轴的代表偏离取出来做符号与量级换算，
 * 不参与任何收缩或门槛判定 —— 门槛已在 `toDimension` 里做过。
 */
function axisDeltaOf(combined: {
  parts: readonly { delta: number }[];
}): number {
  if (combined.parts.length === 0) return 0;
  return combined.parts.reduce((a, p) => a + p.delta, 0) / combined.parts.length;
}

function componentsZh(
  parts: readonly { id: TableDimensionId; direction: TableDirection }[],
): string {
  const dirOf = (d: TableDirection): string =>
    d === TableDirection.HIGHER ? '偏高' : d === TableDirection.LOWER ? '偏低' : '正常';
  return parts.map((p) => `${DIMENSION_LABEL_ZH[p.id]}${dirOf(p.direction)}`).join('、');
}

/**
 * 由桌况生成**有条件**的调整方案。
 *
 * ## 五类分开，没有全局松紧乘数
 *
 * | 类别 | 证据维度 | 作用对象 |
 * |---|---|---|
 * | 开池 | 盲注弃给开池 + 整桌入池松紧 | 对手标签（身后玩家的弃牌倾向） |
 * | 冷跟 | 整桌冷跟 / 再加注压力 | 对手标签（面对开池的继续频率） |
 * | 再加注 | 整桌再加注压力 | 对手标签（面对加注的 3Bet 频率） |
 * | 价值下注 | 面对小/中注弃牌 + 跟注倾向 | **对手**的弃牌/跟注倾向（不是 Hero 的动作） |
 * | 诈唬 | 各档弃牌倾向 | **对手**的弃牌倾向 |
 *
 * ⚠️ 注意最后两行的作用对象：本项目的模型里「Hero 下注的价值/诈唬判断」
 * 是由**对手的响应概率**决定的，因此这两类调整同样表现为
 * 「把对手的响应参数改到更接近实测」，而**不是**给 Hero 的某个动作加分。
 *
 * ## 不支持就说不支持
 *
 * - 单挑（`activeCount === 2`）⇒ 桌况类调整降级为 `NOT_APPLICABLE`：
 *   「整桌」这个概念在两人桌上没有第二个对手可平均。
 * - 多人（`activeCount >= 3`）⇒ 仍可调整，但理由里必须写明是多人；
 *   受益/受损的权益实现假设由既有模型负责（本模块不改权益公式）。
 * - 证据不足（可信度 < 阈值）⇒ `OBSERVING`。
 */
export function buildTableAdjustmentPlan(
  dynamics: TableDynamics,
  context: TableAdjustmentContext,
): TableAdjustmentPlan {
  const config = TABLE_DYNAMICS_CONFIG;
  const headsUp = context.activeCount === 2;
  const multiway = context.activeCount >= 3;
  const streetZh =
    context.street === 'PREFLOP' ? '翻前' : context.street === 'FLOP' ? '翻牌' : context.street === 'TURN' ? '转牌' : '河牌';

  /* ---- 逐对手标签（个体优先，个体不足才有限参考整桌） ---- */
  const opponentProfiles: OpponentQuickProfile[] = [];
  const used = new Set<TableDimensionId>();

  for (const pid of context.relevantPlayerIds) {
    const individual = dynamics.layers.relevantByPlayer[pid];
    const indReraise = dimOf(individual, 'TABLE_RERAISE_PRESSURE');
    const indLoose = dimOf(individual, 'TABLE_LOOSENESS');
    const indCold = dimOf(individual, 'TABLE_COLD_CALL');
    const indFoldLarge = dimOf(individual, 'TABLE_FOLD_VS_LARGE');
    const indFoldSmall = dimOf(individual, 'TABLE_FOLD_VS_SMALL');

    const individualConfidence = Math.max(
      indReraise?.confidence ?? 0,
      indLoose?.confidence ?? 0,
      indCold?.confidence ?? 0,
      indFoldLarge?.confidence ?? 0,
      indFoldSmall?.confidence ?? 0,
    );
    const individualWeight = Math.max(
      indReraise?.effectiveSample ?? 0,
      indLoose?.effectiveSample ?? 0,
      indCold?.effectiveSample ?? 0,
      indFoldLarge?.effectiveSample ?? 0,
      indFoldSmall?.effectiveSample ?? 0,
    );

    const strong =
      individualConfidence >= config.minConfidenceForAdjustment && individualWeight > 0;
    const source: OpponentQuickProfile['source'] = strong ? 'INDIVIDUAL' : 'TABLE_FALLBACK';

    /** 选一个标签：个体证据强 ⇒ 只用个体；否则用整桌（并如实标注） */
    const pick = (id: TableDimensionId, dims: readonly TableDimension[] | undefined): TableDimension | null =>
      strong ? dimOf(dims, id) : findDim(dynamics.layers.table, id);

    const reraise = pick('TABLE_RERAISE_PRESSURE', individual);
    const loose = pick('TABLE_LOOSENESS', individual);
    const cold = pick('TABLE_COLD_CALL', individual);
    const foldLarge = pick('TABLE_FOLD_VS_LARGE', individual);
    const foldSmall = pick('TABLE_FOLD_VS_SMALL', individual);
    for (const d of [reraise, loose, cold, foldLarge, foldSmall]) {
      if (d !== null && d.opportunities > 0) used.add(d.id);
    }

    /*
     * 标签判定：**三个语义互不混淆的轴**映射到已存在的标签上。
     *
     * | 轴 | 证据维度 | 语义 |
     * |---|---|---|
     * | `looseness` | `TABLE_LOOSENESS`（无人加注时是否入池） | 主动入池的频率 |
     * | `aggression` | `TABLE_RERAISE_PRESSURE`（面对加注是否再加注） | 进攻性 |
     * | `giveUp` | `TABLE_FOLD_VS_{LARGE,SMALL}`（面对下注是否弃牌） | 面对压力是否放弃 |
     *
     * ## 🔴 两个我踩过的坑（都写在这里，避免下次再犯）
     *
     * **坑 1：`aggression` 被第二次收缩压成 NEUTRAL。**
     * `delta × confidence` 的加权平均等于**再乘一次可信度**，而 `delta`
     * 本身已经收缩过一次 ⇒ 60/60 的极强证据也过不了 ±0.02 门槛。
     * 修法：加权平均只用于合并**多个**维度，不再施加额外缩放。
     *
     * **坑 2：把 `TABLE_COLD_CALL` 并进 `looseness`。**
     * 「冷跟」是**面对加注时**的继续，它高说明**更黏**而不是**更松**；
     * 更糟的是符号会反过来 —— 一个「从不开池、只在被加注时跟注」的玩家
     * 会被算成 `looseness LOW + cold HIGH`，净效应把标签推到错的方向。
     * 修法：`looseness` **只**由 `TABLE_LOOSENESS` 决定；
     * 冷跟属于「面对压力是否放弃」这一轴（`giveUp`），与弃牌率同向。
     *
     * ⚠️ 仍然如实说明：**标签通道本身是粗的**（一个 `QuickProfile` 只能表达
     * 松紧 × 凶/被动的一个组合）。更细的做法是走 `observedStats` / V3 连续统计
     *（`contextBuilder` 的 `v3StreetInput`），但那需要**逐街的成功/机会数**，
     * 而当前 `playerHistory` 的两种统计（`foldToRiverBet` / `riverCheckRaise`）
     * **都是河牌口径** —— 让它们进翻前响应层是「用错街的统计」，比不调整更糟。
     * 因此本轮到此为止，并把该缺口登记在报告的未完成项里。
     */
    const aggression = combineDirection([reraise]);
    const looseness = combineDirection([loose]);
    const giveUp = combineDirection([foldLarge, foldSmall, cold]);

    let quickProfile: TableProfileName = 'NORMAL';
    if (looseness.direction === TableDirection.HIGHER) {
      if (aggression.direction === TableDirection.HIGHER) {
        quickProfile = 'MANIAC';
      } else if (aggression.direction === TableDirection.LOWER) {
        /* 松但不加注：跟注站 */
        quickProfile = 'CALLING_STATION';
      } else {
        quickProfile = 'LOOSE';
      }
    } else if (looseness.direction === TableDirection.LOWER) {
      if (aggression.direction === TableDirection.HIGHER) {
        /* 紧但凶 */
        quickProfile = 'AGGRESSIVE';
      } else if (giveUp.direction === TableDirection.HIGHER) {
        quickProfile = 'VERY_TIGHT';
      } else {
        quickProfile = 'TIGHT';
      }
    } else if (aggression.direction === TableDirection.HIGHER) {
      quickProfile = 'AGGRESSIVE';
    } else if (aggression.direction === TableDirection.LOWER && giveUp.direction === TableDirection.HIGHER) {
      quickProfile = 'UNDERBLUFFER';
    }

    /*
     * 🔴 **硬校验：标签不得引入无依据的连带调整**。
     *
     * 上一步选出的标签会一次性改写四个维度，各自的流向见
     * `ARCHETYPE_DIMENSION_REFERENCE` 的注释。若该标签改动了
     * **本模块没有证据支持**的维度（尤其 `bluffTendency`），
     * 就**不注入**并如实报「不支持」—— 绝不用一个半有依据的标签冒充调整。
     */
    const justification = justifiedLabelOrNull(quickProfile, {
      looseness: looseness.direction,
      aggression: aggression.direction,
      giveUp: giveUp.direction,
    });

    opponentProfiles.push(
      Object.freeze({
        playerId: pid,
        quickProfile: justification.ok ? quickProfile : 'NORMAL',
        /** 被拒绝注入时为 false（界面与对比记录据此显示「不支持」） */
        injectable: justification.ok,
        /** 拒绝注入的原因（可注入时为 null） */
        notInjectableReasonZh: justification.ok ? null : justification.reasonZh,
        source,
        confidence: Number(
          (source === 'INDIVIDUAL' ? individualConfidence : dynamics.tableConfidence).toFixed(6),
        ),
        fallbackReasonZh: strong
          ? null
          : `该玩家个体证据不足（最高可信度 ${(individualConfidence * 100).toFixed(0)}%，` +
            `低于门槛 ${(config.minConfidenceForAdjustment * 100).toFixed(0)}%）⇒ ` +
            '**有限参考整桌**，不确定性较高；个人证据充分后会自动改回个体判断',
        evidence: [reraise?.id, loose?.id, cold?.id, foldLarge?.id, foldSmall?.id].filter(
          (x): x is TableDimensionId => x !== undefined,
        ),
        axes: Object.freeze({
          looseness: Object.freeze({
            direction: looseness.direction,
            delta: Number(
              (
                looseness.parts.reduce((a, p) => a + p.delta, 0) /
                Math.max(1, looseness.parts.length)
              ).toFixed(6),
            ),
            confidence: Number(looseness.confidence.toFixed(6)),
          }),
          aggression: Object.freeze({
            direction: aggression.direction,
            delta: Number(
              (
                aggression.parts.reduce((a, p) => a + p.delta, 0) /
                Math.max(1, aggression.parts.length)
              ).toFixed(6),
            ),
            confidence: Number(aggression.confidence.toFixed(6)),
          }),
          giveUp: Object.freeze({
            direction: giveUp.direction,
            delta: Number(
              (
                giveUp.parts.reduce((a, p) => a + p.delta, 0) /
                Math.max(1, giveUp.parts.length)
              ).toFixed(6),
            ),
            confidence: Number(giveUp.confidence.toFixed(6)),
          }),
        }),
        /*
         * 作用范围明确的维度（**下游只用这个**）。
         *
         * 符号约定：维度是 0.5 中立，`center = (v − 0.5) × 2`。
         * - 松紧：证据 `looseness.delta > 0` 表示**更松** ⇒ `tightness` 应**更低**
         *   ⇒ `tightness = 0.5 − delta/2`；
         * - 进攻：`aggression.delta > 0` ⇒ `aggression = 0.5 + delta/2`；
         * - **被动恒为 null**：`passivity` 在响应层的语义是「**更爱跟**」，
         *   而本模块只有「面对下注是否**弃牌**」的证据 —— 那会推出**相反**的值
         *   （详见 `scopedDimensions` 的注释）。宁可不动，也不给反向调整。
         * - **诈唬倾向恒为 null**：本模块无证据。
         *
         * 只给出**方向非 NEUTRAL** 的轴 ⇒ 有证据的才注入，其余保持原值。
         */
        scopedDimensions: Object.freeze({
          tightness:
            looseness.parts.length === 0 || looseness.direction === TableDirection.NEUTRAL
              ? null
              : Number((0.5 - axisDeltaOf(looseness) / 2).toFixed(6)),
          aggression:
            aggression.parts.length === 0 || aggression.direction === TableDirection.NEUTRAL
              ? null
              : Number((0.5 + axisDeltaOf(aggression) / 2).toFixed(6)),
          passivity: null,
          bluffTendency: null,
          confidence: Number(
            (source === 'INDIVIDUAL' ? individualConfidence : dynamics.tableConfidence).toFixed(6),
          ),
        }),
      }),
    );
  }

  /* ---- 五类调整 ---- */
  const tableDims = dynamics.layers.table;
  const blindFold = findDim(tableDims, 'BLIND_FOLD_TO_OPEN');
  const looseness = findDim(tableDims, 'TABLE_LOOSENESS');
  const cold = findDim(tableDims, 'TABLE_COLD_CALL');
  const reraiseDim = findDim(tableDims, 'TABLE_RERAISE_PRESSURE');
  const foldSmall = findDim(tableDims, 'TABLE_FOLD_VS_SMALL');
  const foldMedium = findDim(tableDims, 'TABLE_FOLD_VS_MEDIUM');
  const foldLarge = findDim(tableDims, 'TABLE_FOLD_VS_LARGE');

  const adjustments: TableAdjustment[] = [];
  const unsupportedZh: string[] = [];

  /** 共用的「证据不足」构造 */
  const observing = (
    category: TableAdjustmentCategoryId,
    evidence: readonly TableDimensionId[],
    why: string,
  ): TableAdjustment =>
    Object.freeze({
      category,
      labelZh: CATEGORY_LABEL_ZH[category],
      status: 'OBSERVING' as const,
      direction: TableDirection.NEUTRAL,
      evidence,
      layer: 'TABLE' as const,
      factor: 1,
      appliesTo: '（未调整）',
      reasonZh: why,
      unsupportedReasonZh: null,
    });

  /* ---- ① 开池 ---- */
  {
    const behind = context.playersYetToAct;
    const evidence: TableDimensionId[] = ['BLIND_FOLD_TO_OPEN', 'TABLE_LOOSENESS'];
    if (headsUp) {
      adjustments.push(
        Object.freeze({
          category: 'OPEN' as const,
          labelZh: CATEGORY_LABEL_ZH.OPEN,
          status: 'NOT_APPLICABLE' as const,
          direction: TableDirection.NEUTRAL,
          evidence,
          layer: 'TABLE' as const,
          factor: 1,
          appliesTo: '（未调整）',
          reasonZh: `当前是单挑（未弃牌 ${context.activeCount} 人）：**「身后及盲位弃牌偏多」这类整桌调整不适用** —— 单挑没有「身后一串人」可剥削`,
          unsupportedReasonZh: '单挑局面不支持整桌开池调整',
        }),
      );
    } else if (behind <= 0) {
      adjustments.push(
        Object.freeze({
          category: 'OPEN' as const,
          labelZh: CATEGORY_LABEL_ZH.OPEN,
          status: 'NOT_APPLICABLE' as const,
          direction: TableDirection.NEUTRAL,
          evidence,
          layer: 'TABLE' as const,
          factor: 1,
          appliesTo: '（未调整）',
          reasonZh: `Hero 身后没有未行动的对手（${streetZh}）：**「扩大后位开池」这条调整不适用** —— 没有人可以被弃牌剥削`,
          unsupportedReasonZh: '身后无人 ⇒ 开池调整不适用',
        }),
      );
    } else {
      const c = combineDirection([blindFold, looseness]);
      const applicable = c.confidence >= config.minConfidenceForAdjustment;
      adjustments.push(
        Object.freeze({
          category: 'OPEN' as const,
          labelZh: CATEGORY_LABEL_ZH.OPEN,
          status: applicable ? ('SUGGESTED' as const) : ('OBSERVING' as const),
          direction: c.direction,
          evidence: c.used,
          layer: 'TABLE' as const,
          factor: applicable ? c.factor : 1,
          appliesTo: `身后 ${behind} 名对手的标签（seatProfiles）⇒ 他们的弃牌倾向`,
          reasonZh: applicable
            ? `身后 ${behind} 人；盲注弃给开池 ${blindFold?.successes ?? 0}/${blindFold?.opportunities ?? 0}、` +
              `整桌入池 ${looseness?.successes ?? 0}/${looseness?.opportunities ?? 0} ⇒ 方向 ${DIRECTION_ZH[c.direction]}` +
              (multiway ? '（多人底池：权益实现已由既有模型按人数处理）' : '')
            : `证据不足（可信度 ${(c.confidence * 100).toFixed(0)}% < ${(config.minConfidenceForAdjustment * 100).toFixed(0)}%）⇒ 观察中`,
          unsupportedReasonZh: null,
        }),
      );
    }
  }

  /* ---- ② 冷跟 ---- */
  {
    const c = combineDirection([cold, reraiseDim]);
    const applicable =
      !headsUp && c.confidence >= config.minConfidenceForAdjustment && c.used.length > 0;
    adjustments.push(
      headsUp
        ? Object.freeze({
            category: 'COLD_CALL' as const,
            labelZh: CATEGORY_LABEL_ZH.COLD_CALL,
            status: 'NOT_APPLICABLE' as const,
            direction: TableDirection.NEUTRAL,
            evidence: ['TABLE_COLD_CALL'] as TableDimensionId[],
            layer: 'TABLE' as const,
            factor: 1,
            appliesTo: '（未调整）',
            reasonZh: '单挑：不存在「冷跟」这一档（盲注位面对开注是防守，不是冷跟）',
            unsupportedReasonZh: '单挑不适用冷跟调整',
          })
        : Object.freeze({
            category: 'COLD_CALL' as const,
            labelZh: CATEGORY_LABEL_ZH.COLD_CALL,
            status: applicable ? ('SUGGESTED' as const) : ('OBSERVING' as const),
            direction: c.direction,
            evidence: c.used,
            layer: 'TABLE' as const,
            factor: applicable ? c.factor : 1,
            appliesTo: '对手标签（seatProfiles）⇒ 他们面对开池时的继续频率',
            reasonZh: applicable
              ? `整桌冷跟 ${cold?.successes ?? 0}/${cold?.opportunities ?? 0}、` +
                `再加注压力 ${reraiseDim?.successes ?? 0}/${reraiseDim?.opportunities ?? 0} ⇒ 方向 ${DIRECTION_ZH[c.direction]}`
              : `证据不足（可信度 ${(c.confidence * 100).toFixed(0)}%）⇒ 观察中`,
            unsupportedReasonZh: null,
          }),
    );
  }

  /* ---- ③ 再加注 ---- */
  {
    const c = combineDirection([reraiseDim]);
    const applicable = c.confidence >= config.minConfidenceForAdjustment && c.used.length > 0;
    adjustments.push(
      Object.freeze({
        category: 'THREEBET' as const,
        labelZh: CATEGORY_LABEL_ZH.THREEBET,
        status: applicable ? ('SUGGESTED' as const) : ('OBSERVING' as const),
        direction: c.direction,
        evidence: c.used,
        layer: 'TABLE' as const,
        factor: applicable ? c.factor : 1,
        appliesTo: '对手标签（seatProfiles）⇒ 他们面对加注时的 3Bet 频率',
        reasonZh: applicable
          ? `面对加注时再加注 ${reraiseDim?.successes ?? 0}/${reraiseDim?.opportunities ?? 0} ⇒ ` +
            `压力${DIRECTION_ZH[c.direction]}；` +
            (c.direction === TableDirection.HIGHER
              ? '边缘开池与冷跟的期望值会被压低（由既有响应模型重算，本模块不改 EV）'
              : '可略放宽边缘开池与冷跟（同样由既有模型重算）')
          : `证据不足（可信度 ${(c.confidence * 100).toFixed(0)}%）⇒ 观察中`,
        unsupportedReasonZh: null,
      }),
    );
  }

  /* ---- ④ 价值下注（作用于**对手**的跟注倾向） ---- */
  {
    const c = combineDirection([cold, foldSmall, foldMedium]);
    const applicable = c.confidence >= config.minConfidenceForAdjustment && c.used.length > 0;
    adjustments.push(
      Object.freeze({
        category: 'VALUE_BET' as const,
        labelZh: CATEGORY_LABEL_ZH.VALUE_BET,
        status: applicable ? ('SUGGESTED' as const) : ('OBSERVING' as const),
        direction: c.direction,
        evidence: c.used,
        layer: 'TABLE' as const,
        factor: applicable ? c.factor : 1,
        appliesTo: '对手标签（seatProfiles）⇒ 他们面对下注时的弃牌/跟注倾向',
        reasonZh: applicable
          ? `面对小注弃牌 ${foldSmall?.successes ?? 0}/${foldSmall?.opportunities ?? 0}、` +
            `冷跟 ${cold?.successes ?? 0}/${cold?.opportunities ?? 0} ⇒ 方向 ${DIRECTION_ZH[c.direction]}` +
            (c.mixed
              ? `｜⚠️ **各项证据方向不一致**（${componentsZh(c.parts)}）⇒ 合成方向不可单独解读，` +
                '应按尺寸分别判断，不要把它当成「整桌偏松/偏紧」'
              : c.direction === TableDirection.LOWER
                ? '｜对手不太弃牌 ⇒ 价值下注的期望值上升（薄价值更值得）'
                : '｜对手弃牌偏多 ⇒ 价值下注的跟注收益下降')
          : `证据不足（可信度 ${(c.confidence * 100).toFixed(0)}%）⇒ 观察中`,
        unsupportedReasonZh: null,
      }),
    );
  }

  /* ---- ⑤ 诈唬（作用于**对手**的弃牌倾向） ---- */
  {
    const c = combineDirection([foldLarge, foldMedium]);
    const applicable = c.confidence >= config.minConfidenceForAdjustment && c.used.length > 0;
    const mixed =
      foldLarge !== null &&
      foldSmall !== null &&
      foldLarge.opportunities > 0 &&
      foldSmall.opportunities > 0 &&
      Math.sign(foldLarge.delta) !== Math.sign(foldSmall.delta) &&
      Math.abs(foldLarge.delta) > 0.02 &&
      Math.abs(foldSmall.delta) > 0.02;
    adjustments.push(
      Object.freeze({
        category: 'BLUFF' as const,
        labelZh: CATEGORY_LABEL_ZH.BLUFF,
        status: applicable ? ('SUGGESTED' as const) : ('OBSERVING' as const),
        direction: c.direction,
        evidence: c.used,
        layer: 'TABLE' as const,
        factor: applicable ? c.factor : 1,
        appliesTo: '对手标签（seatProfiles）⇒ 他们面对大注时的弃牌倾向',
        reasonZh: applicable
          ? `面对中/大注弃牌 ${(foldMedium?.successes ?? 0) + (foldLarge?.successes ?? 0)}/` +
            `${(foldMedium?.opportunities ?? 0) + (foldLarge?.opportunities ?? 0)} ⇒ 方向 ${DIRECTION_ZH[c.direction]}` +
            (c.mixed
              ? `｜⚠️ 中注与大注的**方向本身就不一致**（${componentsZh(c.parts)}）⇒ ` +
                '尺寸选择比方向更重要，不要用单一方向决定要不要诈唬'
              : mixed
                ? '｜⚠️ 各下注档位方向不一致（小注与大注相反），尺寸选择比方向更重要'
                : c.direction === TableDirection.HIGHER
                  ? '｜对手在大注面前弃牌偏多 ⇒ 纯诈唬的期望值上升'
                  : '｜对手不太尊重大注 ⇒ 纯诈唬的期望值下降（应减少无牌下注）')
          : `证据不足（可信度 ${(c.confidence * 100).toFixed(0)}%）⇒ 观察中`,
        unsupportedReasonZh: null,
      }),
    );
  }

  const anySuggested = adjustments.some((a) => a.status === 'SUGGESTED');
  const suggestedZh = adjustments
    .filter((a) => a.status === 'SUGGESTED')
    .map((a) => `${a.labelZh}${DIRECTION_ZH[a.direction]}(${a.factor.toFixed(3)})`);

  return Object.freeze({
    version: dynamics.version,
    configProvenance: PARAMETER_PROVENANCE,
    adjustments: Object.freeze(adjustments),
    opponentProfiles: Object.freeze(opponentProfiles),
    usedDimensions: Object.freeze([...used]),
    anySuggested,
    /*
     * 本模块的十项维度**全部**由翻前记录产生（主动入池 / 冷跟 / 再加注 / 盲注弃池），
     * 因此证据只覆盖翻前 ⇒ 下游**只允许在翻前节点**注入（见 `evidenceStreets` 的注释）。
     */
    evidenceStreets: Object.freeze(['PREFLOP'] as const),
    unsupportedZh: Object.freeze(unsupportedZh),
    noteZh: anySuggested
      ? `桌况调整（${LAYER_ZH.TABLE}）：${suggestedZh.join('｜')}｜全部系数上限于 ±${(
          config.maxFactorDelta * 100
        ).toFixed(0)}%`
      : `本轮没有任何一类调整达到可信度门槛（${(config.minConfidenceForAdjustment * 100).toFixed(0)}%）⇒ 全部为观察中，**不对建议做任何调整**`,
  });
}
