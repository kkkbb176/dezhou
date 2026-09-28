/**
 * ============================================================================
 * 牌桌动态适应 V1 —— 服务端接入（取数 → 影子对比 → 落盘 → 响应片段）
 * ============================================================================
 *
 * ## 分工
 *
 * ```
 * domain/tableDynamics/tableDynamics.ts        桌况模型 + 调整方案（纯函数）
 * domain/tableDynamics/tableDynamicsShadow.ts  影子执行契约（纯函数）
 * app/table/tableDynamicsWiring.ts             意图 → ManualHandInput 翻译
 * app/table/tableDynamicsServer.ts             ← 本文件：取数 / 落盘 / 响应片段
 * ```
 *
 * ## 三条纪律
 *
 * 1. **默认影子**：正式建议永远由未调整的输入算出；调整结果只用于对比与复盘。
 * 2. **失败不影响正式建议**：桌况或影子出问题 ⇒ 只在响应的 `tableDynamics`
 *    字段里如实说明，**不改变** `decision`。
 * 3. **落盘失败显式报错**：与 `playerHistory` 同一纪律 ——
 *    写不进去就说写不进去，绝不宣称已保存。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { ManualHandInput } from '../manualInput/manualInput.ts';
import type { PokerTableState } from './table.types.ts';
import { engineViewOf } from './tableOps.ts';
import { defaultHistoryDir, handIdOf, loadObservations } from './playerHistory.ts';
import type { ObservationRecord } from './playerHistory.ts';
import { realizedOpponentIds, yetToActIds } from '../../domain/poker/gameState.ts';
import { actorOnTurn } from '../../domain/poker/engine.ts';
import { streetOrderOf } from './tableDynamicsSeatOrder.ts';
import {
  runTableDynamicsShadowForProduction,
  toComparisonRecord,
  type ShadowComparisonRecord,
} from './tableDynamicsWiring.ts';
import { TableDynamicsMode } from '../../domain/tableDynamics/tableDynamicsShadow.ts';
import type { TableDynamicsShadowResult } from '../../domain/tableDynamics/tableDynamicsShadow.ts';
import type { ShadowAnalysisDecision } from './tableDynamicsWiring.ts';

const COMPARISON_LOG = 'table-dynamics-log.jsonl';

/**
 * 影子的默认墙钟预算（毫秒）。
 *
 * 为什么是 1500：核心指标是「1～3 秒给建议」，而影子是**额外的**第二次分析。
 * 1500ms 是「短局面能算完、长局面会在检查点被真实中止」的分界；
 * 它有生产管线自己的 `DecisionDeadline`（软 1500 / 硬 2400）兜底，
 * 因此不会出现「等它跑完再宣布超时」。
 */
export const SHADOW_BUDGET_MS = 1500;

export function comparisonLogPath(dataDir = defaultHistoryDir()): string {
  return join(dataDir, COMPARISON_LOG);
}

/* ============================================================
 * 模式：环境变量控制，**默认影子**
 * ============================================================ */

export function tableDynamicsModeFromEnv(env: NodeJS.ProcessEnv = process.env): TableDynamicsMode {
  const raw = (env['DSH_TABLE_DYNAMICS'] ?? '').trim().toUpperCase();
  if (raw === 'OFF') return TableDynamicsMode.OFF;
  if (raw === 'ACTIVE') {
    /*
     * ⚠️ `ACTIVE` 本阶段**刻意不启用**：授权要求「验证后再启用正式策略调整」。
     * 这里显式降级回 SHADOW，并把降级原因带回响应 ——
     * 绝不静默把实验性调整当成正式建议。
     */
    return TableDynamicsMode.SHADOW;
  }
  return TableDynamicsMode.SHADOW;
}

export function modeNoteZh(mode: TableDynamicsMode, raw: string | undefined): string | null {
  if ((raw ?? '').trim().toUpperCase() !== 'ACTIVE') return null;
  void mode;
  return (
    '`DSH_TABLE_DYNAMICS=ACTIVE` 已请求，但**本阶段只允许影子模式** ⇒ 已降级为 `SHADOW`。' +
    '正式策略调整需在影子对比通过验证后另行授权。'
  );
}

/* ============================================================
 * 响应片段（界面第二/三层直接消费这个结构）
 * ============================================================ */

export type TableDynamicsStatus = {
  mode: TableDynamicsMode;
  status: string;
  /** 一句话摘要（折叠时显示） */
  summaryZh: string;
  /** 观察中（证据不足）时为 true */
  observing: boolean;
  tableConfidence: number;
  confidenceZh: string;
  handsObserved: number;
  recordsUsed: number;
  /** 逐维度证据（展开后显示） */
  dimensions: readonly {
    id: string;
    labelZh: string;
    opportunities: number;
    successes: number;
    rateZh: string;
    confidence: number;
    direction: string;
    noteZh: string;
  }[];
  /** 当前相关玩家 */
  relevantPlayers: readonly { playerId: string; positionZh: string; source: string; confidence: number; quickProfile: string }[];
  /** 五类调整方向 */
  adjustments: readonly {
    category: string;
    labelZh: string;
    status: string;
    direction: string;
    factor: number;
    reasonZh: string;
    unsupportedReasonZh: string | null;
    appliesTo: string;
  }[];
  /** 影子对比（正式 vs 调整后） */
  comparison: {
    baseZh: string;
    adjustedZh: string;
    changed: boolean;
    sameCashflowContract: boolean;
  } | null;
  /** 调整了哪些输入参数 */
  appliedChanges: readonly string[];
  dynamicsDigest: string;
  /** 不支持 / 数据不足 / 失败的原因 */
  reasonZh: string | null;
  /** 记录口径（排除了多少条、为什么） */
  coverageZh: string;
  logIssueZh: string | null;
};

const POSITION_ZH: Readonly<Record<string, string>> = Object.freeze({
  UTG: '枪口位',
  UTG1: '枪口+1',
  UTG2: '枪口+2',
  LJ: '低劫持位',
  HJ: '劫持位',
  CO: '关煞位',
  BTN: '庄家位',
  SB: '小盲位',
  BB: '大盲位',
});

function fmtAction(r: ShadowDynamicsResultView): string {
  if (r === null) return '（未计算）';
  if (!r.ok) return '（未给出建议）';
  return r.decision.sizeChips === null
    ? r.decision.action
    : `${r.decision.action} ${r.decision.sizeChips} 筹码`;
}
type ShadowDynamicsResultView = TableDynamicsShadowResult<ShadowAnalysisDecision>['base'] | null;

/* ============================================================
 * 主入口
 * ============================================================ */

export type TableDynamicsRunResult = {
  status: TableDynamicsStatus;
  record: ShadowComparisonRecord | null;
};

/**
 * 运行桌况 + 影子对比，返回**可直接放进 HTTP 响应**的状态片段。
 *
 * ⚠️ `analyze` 由调用方注入（生产入口 `analyzeManualHand`），
 * 以保证「调整前后走的是同一条管线、同一套收益口径」。
 */
export function runTableDynamicsForTable(args: {
  table: PokerTableState;
  input: ManualHandInput;
  analyze: (input: ManualHandInput) => unknown;
  /**
   * 把影子预算注入分析调用（**应当提供**，否则长任务会同步跑完）。
   *
   * 生产接线传
   * `(inp, ms) => analyzeManualHand(inp, { rules, asOf, budget: { softMs: ms, hardMs: ms * 1.6 } })`，
   * 让生产管线**自己的** `DecisionDeadline` 在检查点真实中止影子计算 ——
   * 这才是隔离；只计时不算（授权 §五）。
   */
  withBudget?: (
    analyze: (input: ManualHandInput) => unknown,
    budgetMs: number,
  ) => (input: ManualHandInput) => unknown;
  historyDir?: string;
  env?: NodeJS.ProcessEnv;
  /** 影子预算（毫秒）；缺省 2500 */
  shadowBudgetMs?: number;
}): TableDynamicsRunResult {
  const { table, input } = args;
  const env = args.env ?? process.env;
  const rawMode = env['DSH_TABLE_DYNAMICS'];
  const mode = tableDynamicsModeFromEnv(env);
  const dir = args.historyDir ?? defaultHistoryDir();

  /* ---- 取数：玩家历史（唯一来源） ---- */
  let records: readonly ObservationRecord[] = [];
  let loadIssueZh: string | null = null;
  const loaded = loadObservations(dir);
  if (loaded.ok) {
    records = loaded.records;
  } else {
    loadIssueZh =
      '玩家历史不可读 ⇒ **本次不做桌况调整**（绝不使用损坏数据）：' +
      loaded.issues.map((i) => i.message).join('；');
  }

  /* ---- 座位与相关对手 ---- */
  /*
   * ============================================================
   * 🔴 **两种 id 空间必须在这一处换算干净**（2026-09-22 修复 P0）
   * ============================================================
   *
   * 本链路里同时存在**两套 id**，长得像但绝不通用：
   *
   * | 来源 | 形状 | 谁用 |
   * |---|---|---|
   * | `table.seats[].seatId` | `seat_BTN` | 界面 / 引擎座位 |
   * | `table.seats[].playerId` | `p2` | **玩家记录 / 统计 / 桌况** |
   * | `engine.players[].id` | `seat_BTN` | 引擎动作与合法性 |
   *
   * `computeTableDynamics` 的三个入参（`presentPlayerIds` /
   * `heroPlayerId` / `relevantPlayerIds`）都在**持久 id** 空间：
   * 它们要和 `record.playerId`（`p2`）比较。而
   * `realizedOpponentIds(engine)` / `engine.players[].id` 给的是**座位 id**。
   *
   * 修复前这里把三者混着传，于是：
   *
   * ```text
   * presentPlayerIds = Object.values(seatIdByPlayerId)   → ["seat_BTN", …]  座位 id
   * heroPlayerId     = table.heroPlayerId                → "p1"            持久 id
   * relevantPlayerIds= realizedOpponentIds(engine)       → ["seat_CO", …]  座位 id
   * ```
   *
   * 后果是**静默失效**（没有任何报错）：
   *
   * - `present` 集合里全是座位 id ⇒ `record.playerId`（`p2`）一个都不匹配
   *   ⇒ `recordsUsed` 恒为 0、所有记录被记成「非在桌玩家」⇒ 桌况永远
   *   「观察中」、调整永不生效；
   * - `relevantIds.filter((id) => present.has(id))` 同理恒为空
   *   ⇒ 逐对手层永远建不出来；
   * - `r.playerId === heroPlayerId` 恒不成立 ⇒ **Hero 自己的行为会混进
   *   「对手桌况」**（正是这段注释要防的自我剥削）。
   *
   * 因此这里建立**双向**映射，并统一以持久 id 出口。
   */
  const seatIdByPlayerId: Record<string, string> = {};
  for (const seat of table.seats) {
    if (seat.playerId !== null) seatIdByPlayerId[seat.playerId] = seat.seatId;
  }
  /** 持久 id 集合（`presentPlayerIds` 用） */
  const presentPlayerIds = Object.keys(seatIdByPlayerId);
  /** 座位 id → 持久 id（把引擎口径换算回玩家口径） */
  const playerIdBySeatId: Record<string, string> = {};
  for (const [playerId, seatId] of Object.entries(seatIdByPlayerId)) {
    playerIdBySeatId[seatId] = playerId;
  }
  const toPlayerId = (id: string): string | null => playerIdBySeatId[id] ?? null;

  const view = engineViewOf(table);
  const live = view.ok ? view.engine.players.filter((p) => !p.folded) : [];
  const activeCount = live.length === 0 ? 1 : live.length;
  const street = (view.ok ? view.engine.street : 'PREFLOP') as
    | 'PREFLOP'
    | 'FLOP'
    | 'TURN'
    | 'RIVER';

  /*
   * `table.heroPlayerId` 本身**就是**持久 id（`p1`），但要确认它真的在桌上
   * —— 不在就当作「无法判断 Hero」，而不是塞一个永远匹配不上的值进去。
   */
  const heroPlayerId = presentPlayerIds.includes(table.heroPlayerId) ? table.heroPlayerId : null;
  const heroEngineId = table.heroPlayerId;
  const heroPosition = live.find((p) => p.id === heroEngineId)?.position ?? null;

  let relevant: string[] = [];
  let playersYetToAct = 0;
  if (view.ok) {
    const realized = realizedOpponentIds(view.engine);
    const yetToAct = yetToActIds(view.engine);
    /*
     * 逐条换算成持久 id；换算不出来的（座位空着 / 引擎里有但桌上没有）
     * **直接丢掉**，而不是把座位 id 混进持久 id 集合 —— 混进去就是上面那
     * 三种静默失效。
     */
    relevant = view.engine.players
      .filter((p) => p.id !== heroEngineId && !p.folded && realized.has(p.id))
      .map((p) => toPlayerId(p.id))
      .filter((id): id is string => id !== null);
    playersYetToAct = view.engine.players.filter((p) => yetToAct.has(p.id)).length;
  }

  /*
   * 座位顺序（用于判断「身后及盲位」）。取不到就退化为「按座位数」，
   * 但**不猜位置角色** —— 那属于模块 A-4 已登记的缺陷，本模块不掩盖它。
   */
  const order = view.ok
    ? streetOrderOf({
        players: view.engine.players,
        street: view.engine.street,
        config: view.engine.config,
      })
    : { order: [] as string[], buttonPosition: null };
  void order;

  if (loadIssueZh !== null) {
    return {
      status: emptyStatus(mode, loadIssueZh, rawMode),
      record: null,
    };
  }

  /* ---- 影子对比 ---- */
  let shadow: TableDynamicsShadowResult<ShadowAnalysisDecision>;
  try {
    shadow = runTableDynamicsShadowForProduction({
      input,
      analyze: args.analyze,
      ...(args.withBudget === undefined ? {} : { withBudget: args.withBudget }),
      records,
      presentPlayerIds,
      heroPlayerId: heroEngineId,
      currentHandId: handIdOf(table),
      relevantPlayerIds: relevant,
      seatIdByPlayerId,
      activeCount,
      street,
      playersYetToAct,
      mode,
      ...(args.shadowBudgetMs === undefined ? {} : { budgetMs: args.shadowBudgetMs }),
    });
  } catch (error) {
    /* 兜底：影子层自身出问题绝不冒泡到 HTTP 响应 */
    return {
      status: emptyStatus(
        mode,
        '桌况影子计算失败（**正式建议不受影响**）：' +
          (error instanceof Error ? error.message : String(error)),
        rawMode,
      ),
      record: null,
    };
  }

  /* ---- 落盘对比记录（失败显式报告） ---- */
  let logIssueZh: string | null = null;
  let record: ShadowComparisonRecord | null = null;
  try {
    record = toComparisonRecord({
      at: new Date().toISOString(),
      handId: handIdOf(table),
      result: shadow,
    });
    mkdirSync(dir, { recursive: true });
    appendFileSync(comparisonLogPath(dir), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    logIssueZh =
      '**影子对比记录写入失败**（本次对比未保存，不要当作已保存）：' +
      (error instanceof Error ? error.message : String(error));
  }

  const d = shadow.dynamics;
  const status: TableDynamicsStatus = {
    mode: shadow.mode,
    status: shadow.status,
    summaryZh: d?.summaryZh ?? '桌况尚未计算',
    observing: d?.observing ?? true,
    tableConfidence: d?.tableConfidence ?? 0,
    confidenceZh: d?.headline.confidenceZh ?? '样本不足',
    handsObserved: d?.handsObserved ?? 0,
    recordsUsed: d?.recordsUsed ?? 0,
    dimensions: (d?.layers.table ?? []).map((dim) => ({
      id: dim.id,
      labelZh: dim.labelZh,
      opportunities: dim.opportunities,
      successes: dim.successes,
      rateZh:
        dim.opportunities === 0
          ? '观察中'
          : `${((dim.successes / dim.opportunities) * 100).toFixed(0)}%（${dim.successes}/${dim.opportunities}）`,
      confidence: dim.confidence,
      direction: dim.direction,
      noteZh: dim.noteZh,
    })),
    relevantPlayers: (shadow.plan?.opponentProfiles ?? []).map((p) => ({
      playerId: p.playerId,
      positionZh: POSITION_ZH[p.playerId.replace(/^seat_/, '')] ?? p.playerId,
      source: p.source,
      confidence: p.confidence,
      quickProfile: p.quickProfile,
    })),
    adjustments: (shadow.plan?.adjustments ?? []).map((a) => ({
      category: a.category,
      labelZh: a.labelZh,
      status: a.status,
      direction: a.direction,
      factor: a.factor,
      reasonZh: a.reasonZh,
      unsupportedReasonZh: a.unsupportedReasonZh,
      appliesTo: a.appliesTo,
    })),
    comparison:
      shadow.base === null && shadow.adjusted === null
        ? null
        : {
            baseZh: fmtAction(shadow.base),
            adjustedZh: fmtAction(shadow.adjusted),
            changed:
              shadow.adjusted !== null &&
              shadow.base.ok &&
              shadow.adjusted.ok &&
              (shadow.base.decision.action !== shadow.adjusted.decision.action ||
                shadow.base.decision.sizeChips !== shadow.adjusted.decision.sizeChips),
            sameCashflowContract: shadow.sameCashflowContract,
          },
    appliedChanges: shadow.appliedChanges,
    dynamicsDigest: shadow.dynamicsDigest,
    reasonZh: [shadow.reasonZh, modeNoteZh(mode, rawMode)].filter((x): x is string => x !== null).join('｜') || null,
    coverageZh: d?.noteZh ?? '（无桌况数据）',
    logIssueZh,
  };

  return { status, record };
}

function emptyStatus(
  mode: TableDynamicsMode,
  reasonZh: string,
  rawMode: string | undefined,
): TableDynamicsStatus {
  return {
    mode,
    status: 'FAILED',
    summaryZh: '桌况不可用',
    observing: true,
    tableConfidence: 0,
    confidenceZh: '样本不足',
    handsObserved: 0,
    recordsUsed: 0,
    dimensions: [],
    relevantPlayers: [],
    adjustments: [],
    comparison: null,
    appliedChanges: [],
    dynamicsDigest: 'error',
    reasonZh: [reasonZh, modeNoteZh(mode, rawMode)].filter((x): x is string => x !== null).join('｜'),
    coverageZh: '（无桌况数据）',
    logIssueZh: null,
  };
}

/** 供 `/api/table/dynamics` 之类只读端点复用（不跑影子） */
export function tableDynamicsModeZh(mode: TableDynamicsMode): string {
  if (mode === TableDynamicsMode.OFF) return '已关闭';
  if (mode === TableDynamicsMode.SHADOW) return '影子模式（只对比，不影响正式建议）';
  return '正式模式（本阶段未启用）';
}

export { actorOnTurn };
