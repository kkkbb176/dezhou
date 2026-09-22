/**
 * ============================================================================
 * 牌桌动态适应 V1 —— 把调整方案落到**生产入口输入**上
 * ============================================================================
 *
 * ## 这个文件存在的唯一理由：让「领域层不依赖 app 层」与「真的能接线」同时成立
 *
 * `domain/tableDynamics/*` 只产出「意图」：
 * `OpponentQuickProfile[]`（每个座位该用什么标签）+ 五类调整方向。
 * 本文件把意图翻译成 `ManualHandInput` 上**已经存在**的字段：
 *
 * | 意图 | 落到哪个已有字段 | 谁会消费它 |
 * |---|---|---|
 * | 对手标签 | `villain.seatProfiles[seat]`（或 `villains[i]`） | `contextBuilder` → 逐座位响应概率 |
 *
 * ## 🔴 三条禁令（授权明确要求）
 *
 * 1. **不产生动作**：本文件里没有 `action`、没有 `size`、没有任何「选哪个」。
 * 2. **不加 EV**：没有 EV 公式、没有 `+delta`、没有容差带操作。
 * 3. **不伪造**：`seatProfiles` 的键必须是**引擎口径的座位 id**（`seat_<位置>`）
 *    或已存在的 `villains[]` 项；对不上就**不注入**并把原因写进 `changes`，
 *    而不是硬塞一个键让模型静默忽略。
 *
 * ## 口径提醒（来自审计模块 A-4）
 *
 * 策略层按**座位名的位置**选档（`preflopPriors` 按位置名查表），
 * 而座位名不一定等于本手角色（Button 移位或盲注座位空置时）。
 * 因此本文件**只注入 `seatProfiles`**，并对「相关对手的座位 id 无法确定」
 * 的情况如实跳过 —— 不靠猜位置来扩大注入面。
 */

import type { ManualHandInput } from '../manualInput/manualInput.ts';
import type { TableAdjustmentPlan } from '../../domain/tableDynamics/tableDynamics.ts';
import { runTableDynamicsShadow } from '../../domain/tableDynamics/tableDynamicsShadow.ts';
import type {
  ShadowAnalyzeResult,
  TableDynamicsMode,
  TableDynamicsShadowResult,
} from '../../domain/tableDynamics/tableDynamicsShadow.ts';
import type { TableAdjustmentPlan as Plan } from '../../domain/tableDynamics/tableDynamics.ts';
import type { ObservationRecord } from './playerHistory.ts';
import type { Position } from '../../domain/types.ts';

/** 位置名 → 引擎口径座位 id（与 `reconstruct.playerIdOfPosition` 同一约定） */
export function seatIdOfPosition(position: Position): string {
  return `seat_${position}`;
}

/**
 * 把调整方案翻译成 `ManualHandInput`。
 *
 * ## 🔴 为什么必须同时写**两个**字段（本轮最重要的修正）
 *
 * 上一版只写 `seatProfiles`，而**实测证明它在翻前路径上不被消费**：
 *
 * | 写入字段 | 画像层 tightness/aggression | 翻前逐尺寸 raiseEV | 建议 |
 * |---|---|---|---|
 * | （不写） | 0.5 / 0.5 | 1196.48 / 1208.00 / 1298.24 | RAISE@5200 |
 * | `seatProfiles[BTN]` | **0.5 / 0.5（没进去）** | **逐位相同** | 相同 |
 * | `villain.quickProfile` | **0.15 / 0.92** | 1193.71 / **1216.90** / 1297.25 | 相同 |
 * | `villain.observedStats` | 0.5 / 0.5 | **1203.38 / 1227.11 / 1331.87** | **RAISE@10000** |
 *
 * 根因（读代码确认，不是 grep）：响应层的 `tendenciesForSeat`
 * （`contextBuilder.ts:3747`）先过 `profileAppliesTo(seatId)`（`:3684`），
 * 它要求 `seatId === profileSeatId`，而 `profileSeatId` 来自
 * **唯一画像描述的那一家** ⇒ 画像走的是 `villain.quickProfile` 主通道，
 * `seatProfiles` 只在「该座位就是画像描述的那一家」时才生效。
 * 翻前事实包消费 `tendencies` ⇒ **只有 `villain.quickProfile` 能改变翻前的响应概率与 EV**。
 *
 * ## 两个字段的分工（都写，各有用处）
 *
 * | 字段 | 谁消费 | 何时是唯一生效的那个 |
 * |---|---|---|
 * | `villain.quickProfile` | 翻前响应层 / 下注范围层 / 面对下注层（经 `profileAppliesTo`） | **翻前节点**（本轮实测唯一生效通道） |
 * | `seatProfiles[位置]` | 翻后多人响应树（`contextBuilder.ts:4760-4784` 的逐座位 `dimensions`） | 翻后多人节点 |
 *
 * ⇒ 只写一个必然在某条路径上静默失效。因此两者都写，并在 `changes` 里
 * 分别标注**哪一个是真的生效通道**，避免再次出现「以为注入了、其实没进模型」。
 */
export function injectPlanIntoManualInput(args: {
  input: ManualHandInput;
  plan: TableAdjustmentPlan;
  /** playerId → 引擎口径座位 id（来自牌桌状态；缺项 ⇒ 不注入该玩家） */
  seatIdByPlayerId: Readonly<Record<string, string>>;
  /**
   * 本次决策的**首要对手**（`villain.quickProfile` 是单对手字段）。
   *
   * 缺省时退化为「相关对手只有一个就用它」；多个相关对手时**不猜**，
   * 只写逐座位字段，并如实说明翻前主通道未注入的原因。
   */
  primaryOpponentPlayerId?: string | null;
  /**
   * 当前**决策节点**所在的街道。
   *
   * 用于「证据覆盖的街道」检查：翻前证据不得改写翻后参数
   *（响应层的多数刻度不分街，见注入函数里的注释）。
   */
  street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER';
}): { input: ManualHandInput; changes: readonly string[] } {
  const { input, plan, seatIdByPlayerId } = args;
  const changes: string[] = [];
  if (plan.opponentProfiles.length === 0) return { input, changes };

  const wanted = new Map<string, string>();
  const labelRejectedZh: string[] = [];
  for (const p of plan.opponentProfiles) {
    /*
     * ⚠️ **标签被拒绝 ≠ 没有可注入的东西**。
     *
     * 领域层会因为「标签会改动 `bluffTendency`（无证据支持的维度）」而把
     * `injectable` 置 false。那只是**标签通道**不可用；
     * 不依赖标签的 `scopedDimensions` 仍然可用（它只含证据支持的轴）。
     * 因此这里**只记录**拒绝原因，不用它决定是否注入。
     */
    if (!p.injectable) {
      labelRejectedZh.push(
        `ℹ️ 标签通道被拒绝（不影响精确通道）：${p.notInjectableReasonZh ?? '该标签会改动无证据支持的维度'}`,
      );
    }
    const seatId = seatIdByPlayerId[p.playerId];
    if (typeof seatId !== 'string' || seatId.length === 0) {
      changes.push(
        `跳过 ${p.playerId}：**座位 id 未知**（牌桌状态里没有该玩家的座位）⇒ 不写逐座位字段，避免把画像挂到错的座位上`,
      );
      continue;
    }
    wanted.set(p.playerId, seatId);
  }
  /* 标签通道的拒绝原因在这里记录（不阻断精确通道）——去重后只报一次 */
  for (const zh of new Set(labelRejectedZh)) changes.push(zh);

  /* ---- ① 主通道：**作用范围明确的维度**（第二轮修正） ---- */
  const primaryId =
    args.primaryOpponentPlayerId ??
    (plan.opponentProfiles.length === 1 ? plan.opponentProfiles[0]!.playerId : null);
  const primary =
    primaryId === null ? null : (plan.opponentProfiles.find((p) => p.playerId === primaryId) ?? null);

  let withPrimary: ManualHandInput = input;
  /*
   * 🔴 **街道范围检查**：证据只覆盖翻前时，**不得**在翻后节点注入。
   *
   * 第三轮审计发现：`scopedDimensions` 会被三个消费点共用
   *（下注范围层 / 面对下注响应层 / 翻前事实包），而
   * `responseTendenciesOf` 的 `callScale`/`foldScale`/`raiseScale`/`bluffRaiseScale`
   * **都不分街**（只有 `riverBetScale` 是河牌专属）。
   * ⇒ 用翻前行为记录算出的维度会改写**翻牌/转牌/河牌**的响应倾向，
   * 而授权明确禁止「翻前证据无依据地改写其他街道参数」。
   *
   * 因此这里按 `plan.evidenceStreets` 拦一道：当前决策节点的街道不在
   * 证据覆盖范围内 ⇒ **不注入**并如实说明。
   */
  const streetAllowed = plan.evidenceStreets.includes(args.street);
  if (primary !== null && !streetAllowed) {
    changes.push(
      `⛔ **不注入 ${primary.playerId}**：本次证据只覆盖 ` +
        `${plan.evidenceStreets.join('/')}，而当前决策节点在 **${args.street}** —— ` +
        '响应层的 `callScale`/`foldScale`/`raiseScale`/`bluffRaiseScale` **不分街**，' +
        '注入会让翻前证据改写其他街道的参数（授权明令禁止）',
    );
  } else if (primary !== null) {
    /*
     * ⚠️ **标签被拒绝 ≠ 没有可注入的东西**。
     *
     * 领域层会因为「标签会改动 `bluffTendency`」而把 `injectable` 置 false，
     * 但**不依赖标签**的 `scopedDimensions` 仍然可用 —— 它只含有证据支持的轴。
     * 第一版在这里直接 `continue`，等于把「精确通道」也一起关掉了。
     * 正确做法：标签拒绝只作**记录**，注入与否由 `scopedDimensions` 决定。
     */
    if (!primary.injectable) {
      changes.push(
        `ℹ️ **标签通道被拒绝**（不影响下面的精确通道）：${primary.notInjectableReasonZh ?? '该标签会改动无证据支持的维度'}`,
      );
    }
    const sd = primary.scopedDimensions;
    /*
     * 🔴 **只注入有证据的轴**：
     * - `bluffTendency` 恒为 `null` ⇒ **不写**，保持调用方原值
     *   （本模块没有翻后诈唬证据）；
     * - `null` 的轴一律不写 ⇒ 不会被 0.5 覆盖掉已有的标签/实测证据。
     */
    const dims: {
      tightness?: number;
      aggression?: number;
      passivity?: number;
      confidence: number;
    } = { confidence: sd.confidence };
    if (sd.tightness !== null) dims.tightness = sd.tightness;
    if (sd.aggression !== null) dims.aggression = sd.aggression;
    if (sd.passivity !== null) dims.passivity = sd.passivity;

    const axesZh: string[] = [];
    if (dims.tightness !== undefined) axesZh.push(`tightness=${dims.tightness}（← 主动入池轴）`);
    if (dims.aggression !== undefined) axesZh.push(`aggression=${dims.aggression}（← 再加注压力轴）`);
    if (dims.passivity !== undefined) axesZh.push(`passivity=${dims.passivity}（← 面对下注放弃轴）`);

    if (axesZh.length === 0) {
      changes.push(`⛔ **不注入 ${primary.playerId}**：三轴都没有可用方向 ⇒ 没有任何维度可以调整`);
    } else {
      withPrimary = { ...input, villainDimensions: dims };
      changes.push(
        `▶ **生效通道（作用范围明确的维度）**：villainDimensions = {${axesZh.join('、')}}` +
          `｜可信度 ${sd.confidence.toFixed(3)}` +
          `｜**bluffTendency 不注入**（本模块无翻后诈唬证据，保持原值）`,
      );
    }
  } else if (plan.opponentProfiles.length > 1) {
    changes.push(
      '⚠️ **主通道未注入**：本次有多个相关对手，而「标签侧维度」是**单对手**字段 ⇒ ' +
        '不猜「哪一个是首要对手」；只写逐座位字段（供翻后多人响应树消费）',
    );
  }

  /* ---- ② 逐座位通道：`seatProfiles`（翻后多人响应树消费） ---- */
  const existing = withPrimary.seatProfiles ?? {};
  const seatProfiles: Record<string, string> = {};
  for (const [position, value] of Object.entries(existing)) {
    if (typeof value === 'string') seatProfiles[position] = value;
  }
  let seatWritten = 0;
  for (const [, seatId] of wanted) {
    const position = seatId.replace(/^seat_/, '');
    const profile = plan.opponentProfiles.find((p) => seatIdByPlayerId[p.playerId] === seatId);
    if (profile === undefined) continue;
    seatProfiles[position] = profile.quickProfile;
    seatWritten += 1;
  }
  if (seatWritten > 0) {
    changes.push(
      `逐座位通道（翻后多人响应树）：seatProfiles = ${JSON.stringify(seatProfiles)}（${seatWritten} 个座位）`,
    );
  }

  return {
    input: {
      ...withPrimary,
      seatProfiles: seatProfiles as Readonly<Partial<Record<Position, string>>>,
    },
    changes,
  };
}

/* ============================================================
 * 影子执行（app 层）：接生产入口 + 落盘对比记录
 * ============================================================ */

export type TableDynamicsModeInput = TableDynamicsMode;

export type ShadowAnalysisDecision = {
  action: string;
  sizeChips: number | null;
  confidence: number;
  band: string;
  classification: string;
  actionable: boolean;
  reasonsZh: readonly string[];
};

/** 从生产入口的返回值里取影子层需要的字段（只读，不做任何解释） */
export function decisionViewOf(result: unknown): ShadowAnalyzeResult<ShadowAnalysisDecision> {
  const r = result as {
    ok?: boolean;
    stage?: string;
    issues?: unknown;
    decision?: {
      action?: string;
      sizeChips?: number | null;
      confidence?: number;
      band?: string;
      classification?: string;
      actionable?: boolean;
      reasons?: readonly { textZh?: string }[];
    };
  };
  if (r?.ok !== true || r.decision === undefined) {
    return { ok: false, ...(r?.stage === undefined ? {} : { stage: r.stage }), ...(r?.issues === undefined ? {} : { issues: r.issues }) };
  }
  const d = r.decision;
  return {
    ok: true,
    decision: {
      action: String(d.action ?? 'UNKNOWN'),
      sizeChips: typeof d.sizeChips === 'number' ? d.sizeChips : null,
      confidence: typeof d.confidence === 'number' ? d.confidence : 0,
      band: String(d.band ?? 'UNKNOWN'),
      classification: String(d.classification ?? 'UNKNOWN'),
      actionable: d.actionable === true,
      reasonsZh: (d.reasons ?? []).map((x) => String(x.textZh ?? '')),
    },
  };
}

export type ShadowRunArgs = {
  input: ManualHandInput;
  analyze: (input: ManualHandInput) => unknown;
  /**
   * 把影子预算注入分析调用的方式。
   *
   * 🔴 **必须提供**，否则长任务会同步跑完 —— 那只是事后计时，
   * 不是隔离（授权 §五）。生产接线传的是
   * `(inp) => analyzeManualHand(inp, { rules, asOf, budget: { softMs, hardMs } })`，
   * 让生产管线**自己的** `DecisionDeadline` 在检查点中止它。
   */
  withBudget?: (
    analyze: (input: ManualHandInput) => unknown,
    budgetMs: number,
  ) => (input: ManualHandInput) => unknown;
  records: readonly ObservationRecord[];
  presentPlayerIds: readonly string[];
  heroPlayerId: string | null;
  currentHandId?: string | null;
  /** 相关对手（playerId） */
  relevantPlayerIds: readonly string[];
  /** playerId → 引擎口径座位 id（来自牌桌状态） */
  seatIdByPlayerId: Readonly<Record<string, string>>;
  activeCount: number;
  street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER';
  playersYetToAct: number;
  mode: TableDynamicsMode;
  budgetMs?: number;
};

/**
 * 运行影子对比（生产接线用）。
 *
 * **顺序**：先算正式建议（未调整），再算桌况，最后重算调整后的建议。
 * 任何一步失败都不影响正式建议 —— 见 `runTableDynamicsShadow` 的契约。
 *
 * **预算隔离**：`withBudget` 把影子预算翻译成这次分析自己的
 * `DecisionDeadline`，从而在生产的检查点上**真实中止**（而不是等它跑完）。
 */
export function runTableDynamicsShadowForProduction(
  args: ShadowRunArgs,
): TableDynamicsShadowResult<ShadowAnalysisDecision> {
  const budgetMs = args.budgetMs ?? 2500;
  return runTableDynamicsShadow<ManualHandInput, ShadowAnalysisDecision>({
    input: args.input,
    analyze: (inp) => decisionViewOf(args.analyze(inp)),
    ...(args.withBudget === undefined
      ? {}
      : {
          withBudget: (
            analyze: (i: ManualHandInput) => ShadowAnalyzeResult<ShadowAnalysisDecision>,
            ms: number,
          ) =>
            args.withBudget!(
              (i: ManualHandInput) => analyze(i) as unknown,
              ms,
            ) as unknown as (i: ManualHandInput) => ShadowAnalyzeResult<ShadowAnalysisDecision>,
        }),
    inject: (inp, plan: Plan) =>
      injectPlanIntoManualInput({
        input: inp,
        plan,
        seatIdByPlayerId: args.seatIdByPlayerId,
        /*
         * 首要对手：只传「相关对手只有一个」的情形。
         *
         * `villain.quickProfile` 是**单对手**字段，多个相关对手时硬挑一个
         * 会把画像挂到错的人身上（而那正是模块 A-4 登记的「名实不一致」形态）。
         * 因此多个相关对手时传 `null`，由注入层如实说明「翻前主通道未注入」。
         */
        primaryOpponentPlayerId:
          args.relevantPlayerIds.length === 1 ? args.relevantPlayerIds[0]! : null,
        street: args.street,
      }),
    records: args.records,
    presentPlayerIds: args.presentPlayerIds,
    heroPlayerId: args.heroPlayerId,
    currentHandId: args.currentHandId ?? null,
    relevantPlayerIds: args.relevantPlayerIds,
    activeCount: args.activeCount,
    street: args.street,
    playersYetToAct: args.playersYetToAct,
    mode: args.mode,
    budgetMs,
  });
}

/** 影子对比记录（落盘用；字段刻意与授权 §六 的清单一一对应） */
export type ShadowComparisonRecord = {
  at: string;
  handId: string | null;
  mode: TableDynamicsMode;
  /** ① 原建议及其依据 */
  base: { action: string; sizeChips: number | null; confidence: number | null; actionable: boolean | null } | null;
  /** ② 调整后的建议及其依据 */
  adjusted: { action: string; sizeChips: number | null; confidence: number | null; actionable: boolean | null } | null;
  /** ③ 使用的统计、样本量与模型版本 */
  statistics: {
    modelVersion: string;
    tableConfidence: number;
    handsObserved: number;
    recordsUsed: number;
    summaryZh: string;
    dimensions: readonly { id: string; opportunities: number; successes: number; adjustedRate: number; confidence: number }[];
  } | null;
  /** ④ 调整了哪些输入参数 */
  appliedChanges: readonly string[];
  /** ⑤ 两次结果是否使用相同收益口径 */
  sameCashflowContract: boolean;
  /** ⑥ 不支持 / 数据不足 / 失败的原因 */
  reasonZh: string | null;
  status: string;
  /** 缓存/重放判据 */
  dynamicsDigest: string;
  elapsedMs: number;
};

export function toComparisonRecord(args: {
  at: string;
  handId: string | null;
  result: TableDynamicsShadowResult<ShadowAnalysisDecision>;
}): ShadowComparisonRecord {
  const { result } = args;
  const view = (r: ShadowAnalyzeResult<ShadowAnalysisDecision> | null): ShadowComparisonRecord['base'] =>
    r === null || !r.ok
      ? null
      : {
          action: r.decision.action,
          sizeChips: r.decision.sizeChips,
          confidence: r.decision.confidence,
          actionable: r.decision.actionable,
        };
  return {
    at: args.at,
    handId: args.handId,
    mode: result.mode,
    base: view(result.base),
    adjusted: view(result.adjusted),
    statistics:
      result.dynamics === null
        ? null
        : {
            modelVersion: result.dynamics.version,
            tableConfidence: result.dynamics.tableConfidence,
            handsObserved: result.dynamics.handsObserved,
            recordsUsed: result.dynamics.recordsUsed,
            summaryZh: result.dynamics.summaryZh,
            dimensions: result.dynamics.layers.table.map((d) => ({
              id: d.id,
              opportunities: d.opportunities,
              successes: d.successes,
              adjustedRate: d.adjustedRate,
              confidence: d.confidence,
            })),
          },
    appliedChanges: result.appliedChanges,
    sameCashflowContract: result.sameCashflowContract,
    reasonZh: result.reasonZh,
    status: result.status,
    dynamicsDigest: result.dynamicsDigest,
    elapsedMs: result.elapsedMs,
  };
}
