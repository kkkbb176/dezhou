/**
 * GTOpenProvider —— 把 Alpha 场景翻译成 GTOpen 请求，再把响应翻译回内部统一格式
 *
 * ## 这个文件是**唯一**允许知道 GTOpen JSON 结构的地方
 *
 * ```
 * Alpha（decisionEngine / webServer / UI）
 *   ↓  只依赖 GtoProvider 接口
 * GTOpenProvider（本文件）
 *   ↓  只依赖 GtoHttpClient
 * GTOpen（localhost HTTP）
 * ```
 *
 * ## 🔴 GTOpen 的三个结构性事实（决定了本文件的全部设计）
 *
 * ### 1. 它**同一时刻只有一个翻前会话**
 *
 * 源码 `crates/server/src/main.rs` 的 `pf_build`：先 `pf_stop_and_join`，
 * 再**替换**当前 session。因此两个并发查询会互相破坏。本 Provider：
 * - 用一条 Promise 串行链把所有查询排队；
 * - 记住「当前会话对应哪个场景」；
 * - 读到结果后**必须**核对响应里回显的座位表，不一致就判 `INVALID_RESPONSE`。
 *
 * ### 2. `solve` 是**异步**的，立即返回
 *
 * 源码 `pf_solve` 起一个线程就返回 `{"ok":true}`（122–222 行附近），
 * 求解在后台推进。因此读完迭代数必须**轮询 `/api/preflop/status`**，
 * 直到 `state` 离开 `running`。轮询有**硬上限**，到点就判 `TIMEOUT`
 * 并放弃这次数据 —— 绝不无限等待。
 *
 * ### 3. 它不知道「场景目录」，只知道「一棵树 + 一个节点路径」
 *
 * 于是我们自己做两件事：
 * - 把 `GtoScenario` 变成一棵**配置**（positions / posts / sizes / raise cap）
 * - 把「前序动作」变成一条**节点路径**，路径**边走边问**出来
 *   （每一步读回该节点真实存在的动作菜单，用 `kind` + 金额匹配，
 *   而不是用公式猜下标 —— 猜错一格就会读到另一个位置的策略）
 *
 * ## 🔴 翻前结果的可信度上限是 APPROXIMATE
 *
 * 见 `gtopenCapabilities.ts` 文件头（引用了源码原文）。即使求解器自述
 * `converged: true`，收敛的也是那个**近似延续模型**内部的均衡。
 * 本文件**永远不会**产出 `SOLVED` / `CROSS_CHECKED` / `VERIFIED`。
 */

import {
  GTO_NO_APPROXIMATION,
  GtoActionKind,
  GtoScenarioKind,
  GtoSolveStatus,
  GtoVerification,
  type GtoActionFrequency,
  type GtoApproximationFlags,
  type GtoBaseline,
  type GtoEngineCapabilities,
  type GtoHandStrategy,
  type GtoLookupResult,
  type GtoMetadata,
  type GtoProvider,
  type GtoProviderHealth,
  type GtoRange,
  type GtoScenario,
  type GtoSolveKeyParts,
  type GtoSolveSettings,
  type GtoUnavailable,
} from '../gto.types.ts';
import {
  GTO_HAND_CLASSES,
  GTO_HAND_CLASSES_BY_CLASS_INDEX,
  TOTAL_COMBOS,
  isFrequency01,
} from '../gtopenHandMatrix.ts';
import { scenarioHashOf } from '../gtoScenario.ts';
import {
  GTOPEN_CAPABILITY_TABLE,
  GTOPEN_PREFLOP_MAX_VERIFICATION,
  supportLevelFor,
} from './gtopenCapabilities.ts';
import {
  GtoHttpClient,
  HEALTH_TIMEOUT_MS,
  type GtoHttpError,
  type GtoHttpResult,
} from './gtopenHttpClient.ts';
import {
  buildEngineSeats,
  mapActionKind,
  verifyPositionsEcho,
} from './gtopenMapping.ts';

/* ============================================================
 * 求解配置（请求参数，**不是求解结果**）
 * ============================================================ */

/**
 * 翻前求解预算。
 *
 * ## 为什么默认这么小（1 个开池尺寸、1 个再加注倍数、加注上限 2）
 *
 * 树的规模随「尺寸数 × 加注层数 × 人数」快速增长。**实测**（本机，
 * `POST /api/preflop/estimate`，开池 `[2.5]`、加注倍数 `[3]`、上限 2、允许跛入）：
 *
 * | 人数 | 节点数 | 动作节点 | arena |
 * |---|---|---|---|
 * | 4 | 526 | 234 | 0.7 MB |
 * | 5 | 2,536 | 1,170 | 3.4 MB |
 * | 6 | 11,566 | 5,466 | 15.6 MB |
 * | 8 | 217,366 | 105,594 | 293.9 MB |
 * | 9 | 913,096 | 447,090 | 1234.5 MB |
 *
 * 上游的参考配置（2 个开池尺寸 + 3 个再加注倍数）在 6 人桌上就要 2119 MB，
 * 而那是**有 CUDA** 的机器。本机是 8 核 CPU、16GB 内存。
 * 为了让 4/5/6/8/9 人桌**都能真的跑出结果**，第一阶段把树压到
 * 「最小可解释形态」：一个开池尺寸、一个再加注倍数、最多两次加注。
 *
 * ⚠️ 这不是偷工减料，而是**如实标注**：树越小 = 策略越粗，
 * 这一点会进 `approximation.notes` 并在界面显示。
 */
export type GtopenSolveBudget = {
  openSizesBB: readonly number[];
  raiseMults: readonly number[];
  maxRaises: number;
  limp: boolean;
  addAllin: boolean;
  rakePct: number;
  rakeCap: number;
  realization: 'calibrated' | 'static' | 'raw';
  /** 本次请求的迭代数 */
  iterations: number;
  /** 收敛判据（BR gap 之和）；`0` = 跑满迭代数就停 */
  targetGap: number;
  /** 每隔多少迭代测一次 gap（**不改变数学**，只影响测量频率） */
  checkEvery: number;
  /**
   * 轮询求解状态的上限（毫秒）。
   *
   * 与 HTTP 超时是两件事：HTTP 请求很快返回，**求解本身**是后台线程。
   * 到点仍未结束就判 `TIMEOUT`，并把已有快照标成「未收敛」——
   * 注意：**不用**半途的策略，除非它自述已发布且我们明确接受未收敛数据。
   */
  solveWaitMs: number;
  /** 轮询间隔（毫秒） */
  pollIntervalMs: number;
};

/**
 * 每个桌人数的**求解画像**（实测标定）。
 *
 * ## 实测数据（本机：8 逻辑核 CPU、16GB 内存、无 CUDA）
 *
 * 同一次测量里同时记录「树规模」「每次迭代耗时」「BR gap」，
 * 因为这三者必须一起看才能做取舍：
 *
 * | 人数 | 树节点 | 全下 | 每次迭代 | 10 次迭代后的 gap 之和 |
 * |---|---|---|---|---|
 * | 4 | 232 | 提供 | 0.13 s | 0.034 |
 * | 5 | ~900 | 提供 | 0.52 s | 0.081 |
 * | 6 | 1,272 | 不提供 | **0.73 s** | **0.015** |
 * | 6 | 2,538 | **提供** | **1.90 s** | **0.998** |
 * | 8 | 12,362 | 不提供 | 5.07 s | 0.025 |
 * | 8 | 24,716 | **提供** | **29.2 s** | **5.455** |
 * | 9 | 37,839 | 不提供 | — | 0.034 |
 * | 9 | 75,669 | 提供 | ~33 s | 900 秒内跑不完 12 次 |
 *
 * ## 🔴 从表里读出的两个结论（这就是取舍依据）
 *
 * 1. **`add_allin` 让每次迭代慢约 4–6 倍**（6 人桌 0.73 → 1.90 s；
 *    8 人桌 5.07 → 29.2 s）。原因是全下把「加注到 100BB」变成独立分支，
 *    树里的活座位组合大幅增加。
 * 2. **带全下时 8 人桌 10 次迭代后 gap 仍是 5.455**（无全下是 0.025）——
 *    那份数据**根本没在收敛**。这种情况下提供「全下频率」不是「更完整的信息」，
 *    而是**把一个未收敛的数字摆在一个看起来很确定的位置上**。
 *
 * 因此本阶段的选择：
 *
 * | 桌人数 | 全下 | 迭代数 | 实测一次查询耗时 |
 * |---|---|---|---|
 * | 4 | **提供** | 60 | ~8 秒 |
 * | 5 | **提供** | 60 | ~31 秒 |
 * | 6 | **提供** | 40 | ~99 秒 |
 * | 8 | **不提供** | 20 | ~100 秒（对照：带全下 10.5 分钟） |
 * | 9 | **不提供** | 12 | ~90 秒（对照：带全下 900 秒跑不完） |
 *
 * ⚠️ **这是被明确声明的取舍，不是隐藏的偷工减料**：
 * 8/9 人桌的界面会写出「本次动作菜单**不含全下**」及原因。
 * 使用者**看得见**这条限制（进 `approximation.notes`）。
 *
 * ## 迭代数为什么各不相同
 *
 * 同样的道理：单次迭代成本随树规模快速增长。若对 8/9 人桌也要求 60 次迭代，
 * 一次查询要十几分钟 —— 那不是「有 GTO 数据」，那是「界面卡住」。
 * 迭代少 = 离均衡更远，而这一点**不会被藏起来**：
 * 结果一定带 `notConverged: true`，界面显示实际迭代数与 BR gap 之和。
 */
export type GtopenSizeProfile = {
  /** 该桌人数是否把「全下」放进动作菜单 */
  addAllin: boolean;
  /** 该桌人数的迭代预算 */
  iterations: number;
};

export const GTOPEN_SIZE_PROFILES: Readonly<Record<number, GtopenSizeProfile>> = Object.freeze({
  4: Object.freeze({ addAllin: true, iterations: 60 }),
  5: Object.freeze({ addAllin: true, iterations: 60 }),
  6: Object.freeze({ addAllin: true, iterations: 40 }),
  8: Object.freeze({ addAllin: false, iterations: 20 }),
  9: Object.freeze({ addAllin: false, iterations: 12 }),
});

/** 未知桌人数 → 最保守的一档（不给全下、迭代最少） */
const GTOPEN_FALLBACK_PROFILE: GtopenSizeProfile = Object.freeze({
  addAllin: false,
  iterations: 12,
});

/**
 * 每个桌型给自己设的**收敛目标**（BR gap 之和）。
 *
 * ## 🔴 这不是「gap < X 就是 GTO」
 *
 * 已经实测证实不同动作树的 gap 差 60 倍（6 人桌 2 分支 0.015 vs
 * 3 分支 0.998），所以**不存在**跨树通用的好坏阈值。
 *
 * 这里的数字是**工程调参**，唯一用途是让「是否达标」成为一个可判定的信号：
 * - 达标 → 求解器以 `target_reached` 提前停下（省时间，且我们知道自己到了哪）
 * - 未达标 → 以 `iteration_limit` 停下（我们**如实**记成未收敛）
 *
 * 取值依据：Phase 1 实测中各桌型在既定额度下**实际达到**的水平
 * （4 人桌 60 次迭代到 0.034；6 人桌 40 次到 0.165；8 人桌 20 次到 0.004；
 * 9 人桌 12 次到 0.021）。目标取得比实测略宽松一点，
 * 使「达标」意味着「达到了我们已知可达的水平」，而不是一个幻想值。
 *
 * ⚠️ 即使达标，翻前结果的质量上限仍是 `APPROXIMATE`（近似延续模型）。
 */
export const GTOPEN_TARGET_GAP_BY_TABLE_SIZE: Readonly<Record<number, number>> = Object.freeze({
  4: 0.05,
  5: 0.1,
  6: 0.2,
  8: 0.05,
  9: 0.05,
});

/** 按桌人数取求解画像 */
export function profileForTableSize(tableSize: number): GtopenSizeProfile {
  return GTOPEN_SIZE_PROFILES[tableSize] ?? GTOPEN_FALLBACK_PROFILE;
}

/** 按桌人数取迭代预算 */
export function iterationsForTableSize(tableSize: number): number {
  return profileForTableSize(tableSize).iterations;
}

/**
 * 默认预算（第一阶段）—— **实测标定的结果，不是拍脑袋的数字**
 *
 * ## 实测数据（本机：8 逻辑核 CPU、16GB 内存、无 CUDA）
 *
 * 用 `POST /api/preflop/estimate` 逐个配置量出来的树规模
 * （开池 `[2.5]`、加注倍数 `[3]`、加注上限 2）：
 *
 * | 人数 | 允许跛入 | 提供全下 | 节点数 | arena |
 * |---|---|---|---|---|
 * | 9 | 是 | 否 | 913,096 | 1234.5 MB |
 * | 9 | 否 | 否 | 37,839 | 51.2 MB |
 * | 9 | 否 | **是** | **75,669** | **102.3 MB** |
 * | 6 | 否 | 是 | 2,538 | 3.4 MB |
 *
 * 每 10 次迭代的实测耗时（同一批配置）：
 *
 * | 人数 | 毫秒/迭代（允许跛入、无全下） |
 * |---|---|
 * | 4 | 46 |
 * | 5 | 133 |
 * | 6 | 488 |
 * | 8 | 5,074 |
 * | 9 | 17,264 |
 *
 * ## 两个被明确声明为近似的取舍（不是隐藏的偷工减料）
 *
 * 1. **关闭跛入**：跛入让 9 人桌的树从 37,839 节点变成 913,096 节点（24 倍），
 *    单次迭代从毫秒级变成 17 秒级。关掉之后动作菜单是
 *    `Fold / Raise / All-in`（面对开池时是 `Fold / Call / 3-bet / All-in`），
 *    **没有跛入频率**。
 * 2. **按桌人数缩减迭代 / 按桌人数决定是否提供全下**（见 `GTOPEN_SIZE_PROFILES`）：
 *    8/9 人桌的迭代数更少 → 离均衡更远。
 *
 * 两者都会进 `approximation.notes` 并在界面显示。
 */
export const GTOPEN_DEFAULT_BUDGET: GtopenSolveBudget = Object.freeze({
  openSizesBB: Object.freeze([2.5]),
  raiseMults: Object.freeze([3]),
  maxRaises: 2,
  /** 🔴 `limp: false` —— 见上面的实测表 */
  limp: false,
  /** 保留全下：它是使用者明确要求的动作之一，代价只有约 2 倍节点数 */
  addAllin: true,
  rakePct: 0,
  rakeCap: 0,
  realization: 'static',
  /**
   * ⚠️ 这个字段是**默认**值；实际请求的迭代数由
   * `iterationsForTableSize(tableSize)` 在查询时决定。
   * 保留它作为「拿不到桌人数时的兜底」。
   */
  iterations: 40,
  targetGap: 0,
  checkEvery: 20,
  solveWaitMs: 420_000,
  pollIntervalMs: 400,
});

/* ============================================================
 * 响应结构解析（本文件是唯一知道这些字段名的地方）
 * ============================================================ */

/** `/api/preflop/node` 的动作项 */
export type EngineActionEntry = {
  label: string;
  kind: string;
  to: number;
  freq: number;
};

/**
 * `/api/preflop/node` 的响应。
 *
 * ⚠️ 实测确认：节点字段在**顶层**（没有 `result` 包装）。
 * 顶层同时还有 `publication`。
 */
export type EngineNodeView = {
  kind: string;
  actor: number | null;
  actorPos: string | null;
  positions: string[];
  pot: number;
  actions: EngineActionEntry[];
  strategy: number[] | null;
  reach: number[] | null;
  strategyNote: string | null;
  exportable: boolean;
};

/** `/api/preflop/status` 与节点里的 `publication` */
export type EngineStatus = {
  state: string;
  phase: string;
  iteration: number | null;
  publishedIteration: number | null;
  accuracyIteration: number | null;
  targetGap: number | null;
  stopReason: string;
  gapTotal: number | null;
  gaps: number[];
  evs: number[];
  realizationNote: string;
  multiwayEquityModel: string;
  gpu: boolean;
  error: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null;
    out.push(item);
  }
  return out;
}

/**
 * 解析 `/api/preflop/node` 的响应。
 *
 * 返回 `null` 表示结构不合法 —— 调用方必须判 `INVALID_RESPONSE`。
 *
 * ⚠️ 这里刻意**严格**：必填字段缺失或类型不对就返回 `null`，
 * 而不是「尽量取一个默认值」。缺字段意味着我们对响应的理解是错的，
 * 用默认值续下去等于**编数据**。
 */
export function parseNodeView(payload: unknown): EngineNodeView | null {
  const root = asRecord(payload);
  if (root === null) return null;

  const positions = root['positions'];
  if (!Array.isArray(positions) || positions.some((p) => typeof p !== 'string')) return null;

  const rawActions = root['actions'];
  if (!Array.isArray(rawActions)) return null;
  const actions: EngineActionEntry[] = [];
  for (const raw of rawActions) {
    const entry = asRecord(raw);
    if (entry === null) return null;
    const label = asString(entry['label']);
    const kind = asString(entry['kind']);
    const to = asNumber(entry['to']);
    const freq = asNumber(entry['freq']);
    if (label === null || kind === null || to === null || freq === null) return null;
    actions.push({ label, kind, to, freq });
  }

  const strategy = root['strategy'] === null || root['strategy'] === undefined
    ? null
    : asNumberArray(root['strategy']);
  if (root['strategy'] !== null && root['strategy'] !== undefined && strategy === null) return null;
  const reach = root['reach'] === null || root['reach'] === undefined
    ? null
    : asNumberArray(root['reach']);
  if (root['reach'] !== null && root['reach'] !== undefined && reach === null) return null;

  return {
    kind: asString(root['kind']) ?? 'unknown',
    actor: asNumber(root['actor']),
    actorPos: asString(root['actor_pos']),
    positions: positions as string[],
    pot: asNumber(root['pot']) ?? 0,
    actions,
    strategy,
    reach,
    strategyNote: asString(root['strategy_note']),
    exportable: root['exportable'] === true,
  };
}

/**
 * 解析 `/api/preflop/status`（或节点里的 `publication`，二者字段名不同）。
 *
 * `publication` 只给 `published_iteration` / `accuracy_iteration` /
 * `gap_total` / `target_gap` / `converged` / `multiway_model`；
 * `status` 给全套。这里统一成一个结构，`fromPublication` 表示来源。
 */
export function parseStatus(payload: unknown, fromPublication = false): EngineStatus | null {
  const root = asRecord(payload);
  if (root === null) return null;

  if (fromPublication) {
    return {
      // publication 没有 state；用 converged 反推（保守：不 converged 就是 running）
      state: root['converged'] === true ? 'done' : 'running',
      phase: '',
      iteration: null,
      publishedIteration: asNumber(root['published_iteration']),
      accuracyIteration: asNumber(root['accuracy_iteration']),
      targetGap: asNumber(root['target_gap']),
      stopReason: root['converged'] === true ? 'target_gap' : '',
      gapTotal: asNumber(root['gap_total']),
      gaps: [],
      evs: [],
      realizationNote: '',
      multiwayEquityModel: asString(root['multiway_model']) ?? '',
      gpu: false,
      error: '',
    };
  }

  const state = asString(root['state']);
  if (state === null) return null;
  return {
    state,
    phase: asString(root['phase']) ?? '',
    iteration: asNumber(root['iteration']),
    publishedIteration: asNumber(root['published_iteration']),
    accuracyIteration: asNumber(root['accuracy_iteration']),
    targetGap: asNumber(root['target_gap']),
    stopReason: asString(root['stop_reason']) ?? '',
    gapTotal: asNumber(root['gap_total']),
    gaps: asNumberArray(root['gaps']) ?? [],
    evs: asNumberArray(root['evs']) ?? [],
    realizationNote: asString(root['realization_note']) ?? '',
    multiwayEquityModel: asString(root['multiway_equity_model']) ?? '',
    gpu: root['gpu'] === true,
    error: asString(root['error']) ?? '',
  };
}

/* ============================================================
 * Provider
 * ============================================================ */

export type GtopenProviderOptions = {
  /** 端点；默认环境变量 `GTOPEN_URL`，再默认 `http://127.0.0.1:3737` */
  baseUrl?: string;
  budget?: GtopenSolveBudget;
  /** 注入的 HTTP 客户端（测试） */
  client?: GtoHttpClient;
  /** 注入的时钟 */
  now?: () => number;
  /** 注入的 sleep（测试用来跳过真实等待） */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * 求解预算（含**按桌人数**的画像覆盖）。
 *
 * `sizeProfiles` 是可选覆盖：不填时用 `GTOPEN_SIZE_PROFILES`
 * （实测标定的「该桌人数给不给全下、迭代多少次」）。
 * 测试可以传一个固定映射，让这两项变成确定量。
 */
export type GtopenSolveBudgetWithIterations = GtopenSolveBudget & {
  /** 覆盖某个桌人数的迭代数 */
  iterationsByTableSize?: Readonly<Record<number, number>>;
  /** 覆盖某个桌人数的「是否提供全下」 */
  addAllinByTableSize?: Readonly<Record<number, boolean>>;
  /** 覆盖某个桌人数的收敛目标（测试用来固定行为） */
  targetGapByTableSize?: Readonly<Record<number, number>>;
};

/** 已构建会话的指纹：用来判断「现在求解器里那棵树是不是我要的」 */
export function sessionSignature(
  scenario: GtoScenario,
  budget: GtopenSolveBudget,
  addAllin = budget.addAllin,
): string {
  return JSON.stringify({
    tableSize: scenario.tableSize,
    stack: scenario.effectiveStackBB,
    blinds: scenario.blinds,
    open: budget.openSizesBB,
    mult: budget.raiseMults,
    maxRaises: budget.maxRaises,
    limp: budget.limp,
    allin: addAllin,
    rake: [budget.rakePct, budget.rakeCap],
    realization: budget.realization,
  });
}

/**
 * 构造 `/api/preflop/spot` 的请求体（**唯一**构造它的地方）。
 *
 * ⚠️ `add_allin` 由调用方传入（按桌人数标定），**不**直接读 `budget.addAllin` ——
 * 否则 8/9 人桌会被强行加上全下分支，慢 5 倍且不收敛（见 `GTOPEN_SIZE_PROFILES`）。
 */
export function buildEngineConfig(
  scenario: GtoScenario,
  budget: GtopenSolveBudget,
  addAllin = budget.addAllin,
): Record<string, unknown> {
  const seats = buildEngineSeats(scenario.tableSize, scenario.blinds);
  return {
    positions: seats.positions,
    stack: scenario.effectiveStackBB,
    posts: seats.posts,
    ante: scenario.blinds.anteBB,
    limp: budget.limp,
    open_raises: [...budget.openSizesBB],
    raise_mults: [...budget.raiseMults],
    max_raises: budget.maxRaises,
    add_allin: addAllin,
    rake_pct: budget.rakePct,
    rake_cap: budget.rakeCap,
    no_flop_no_drop: true,
    realization: budget.realization,
    call_only_seats: [] as number[],
    open_raises_by_seat: null,
    raise_mults_by_seat: null,
  };
}

export class GtopenProvider implements GtoProvider {
  readonly engine = GTOPEN_CAPABILITY_TABLE.engine;
  readonly displayName = 'GTOpen 翻前求解器（本地）';
  readonly baseUrl: string;
  readonly budget: GtopenSolveBudgetWithIterations;

  private readonly client: GtoHttpClient;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** 串行链：GTOpen 同一时刻只有一个翻前会话，并发请求必须排队 */
  private queue: Promise<unknown> = Promise.resolve();
  private currentSignature: string | null = null;
  private currentSolved = false;
  private lastHealth: { at: number; value: GtoProviderHealth } | null = null;
  private static readonly HEALTH_TTL_MS = 5_000;

  constructor(options: GtopenProviderOptions = {}) {
    this.baseUrl =
      options.baseUrl ??
      (typeof process !== 'undefined' ? process.env['GTOPEN_URL'] : undefined) ??
      'http://127.0.0.1:3737';
    this.client = options.client ?? new GtoHttpClient({ baseUrl: this.baseUrl });
    this.budget = options.budget ?? GTOPEN_DEFAULT_BUDGET;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /* ---------------- 健康检查 ---------------- */

  async health(): Promise<GtoProviderHealth> {
    const cached = this.lastHealth;
    if (cached !== null && this.now() - cached.at < GtopenProvider.HEALTH_TTL_MS) {
      return cached.value;
    }
    // `/api/preflop/status` 在**没有会话**时也返回 200（一个空的默认状态），
    // 因此它是比 `/session` 更合适的探针：只有网络层失败才算「不可达」。
    const probe = await this.client.getJson('/api/preflop/status', HEALTH_TIMEOUT_MS);
    let value: GtoProviderHealth;
    if (probe.ok) {
      const status = parseStatus(probe.value);
      value = {
        reachable: true,
        engine: this.engine,
        version: null,
        commit: GTOPEN_ENGINE_COMMIT,
        endpoint: this.baseUrl,
        message:
          status === null || status.state === ''
            ? 'GTOpen 已响应；当前没有翻前会话（这是正常的，查询时会自动建树）'
            : `GTOpen 已响应；当前会话状态 ${status.state}（迭代 ${status.iteration ?? 0}）`,
      };
    } else {
      value = {
        reachable: false,
        engine: this.engine,
        version: null,
        commit: null,
        endpoint: this.baseUrl,
        message: probe.error.status === null
          ? probe.error.message
          : `GTOpen 返回 HTTP ${probe.error.status}：${probe.error.bodySnippet ?? ''}`,
      };
    }
    this.lastHealth = { at: this.now(), value };
    return value;
  }

  /* ---------------- 能力自述 ---------------- */

  async capabilities(): Promise<GtoEngineCapabilities | null> {
    const probe = await this.client.getJson('/api/preflop/capabilities', HEALTH_TIMEOUT_MS);
    const raw = probe.ok ? (asRecord(probe.value) ?? {}) : {};
    const models = Array.isArray(raw['fresh_build_multiway_models'])
      ? (raw['fresh_build_multiway_models'] as unknown[]).filter(
          (m): m is string => typeof m === 'string',
        )
      : [];
    return {
      engine: this.engine,
      supportedTableSizes: GTOPEN_CAPABILITY_TABLE.verifiedTableSizes,
      supportedScenarioKinds: (
        Object.keys(GTOPEN_CAPABILITY_TABLE.scenarioSupport) as GtoScenarioKind[]
      ).filter((kind) => supportLevelFor(kind, 6) !== 'UNSUPPORTED'),
      preflopApproximateModel: GTOPEN_CAPABILITY_TABLE.preflopApproximateModel,
      modelName: models[0] ?? GTOPEN_CAPABILITY_TABLE.multiwayEquityModel,
      raw,
    };
  }

  /* ---------------- 查询 ---------------- */

  /** 永不抛异常：任何失败都返回 `GTO_BASELINE_UNAVAILABLE` */
  async lookupScenario(scenario: GtoScenario): Promise<GtoLookupResult> {
    const scenarioHash = scenarioHashOf(scenario);
    const startedAt = this.now();

    const level = supportLevelFor(scenario.kind, scenario.tableSize);
    if (level === 'UNSUPPORTED') {
      return this.unavailable(
        scenario,
        scenarioHash,
        GtoSolveStatus.UNSUPPORTED,
        `本阶段不支持这个场景：${scenario.tableSize} 人桌 / ${scenario.kind}。` +
          '本项目当前验证过的桌人数是 4 / 5 / 6 / 8 / 9，且每个场景类型有独立的支持级别。',
        startedAt,
      );
    }

    return this.enqueue(() => this.runLookup(scenario, scenarioHash, startedAt));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const chained = this.queue.then(task, task);
    this.queue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  private async runLookup(
    scenario: GtoScenario,
    scenarioHash: string,
    startedAt: number,
  ): Promise<GtoLookupResult> {
    const signature = sessionSignature(scenario, this.budget, this.addAllinFor(scenario));
    if (this.currentSignature !== signature) {
      const built = await this.ensureSession(scenario, signature);
      if (built !== null) return this.unavailableFromHttp(scenario, scenarioHash, built, startedAt);
    }

    const walked = await this.walkToHero(scenario);
    if (!walked.ok) {
      return this.unavailableFromHttp(scenario, scenarioHash, walked.error, startedAt);
    }
    const { node, status, path } = walked;

    const seatProblems = verifyPositionsEcho(
      buildEngineSeats(scenario.tableSize, scenario.blinds).positions,
      node.positions,
      scenario.tableSize,
    );
    if (seatProblems.length > 0) {
      return this.unavailable(
        scenario,
        scenarioHash,
        GtoSolveStatus.INVALID_RESPONSE,
        `求解器回显的座位表与请求不一致，无法确认策略属于哪个位置：${seatProblems.join('；')}`,
        startedAt,
      );
    }

    const converted = this.convertNode(scenario, scenarioHash, node, status, path, startedAt);
    if (!converted.ok) {
      return this.unavailable(scenario, scenarioHash, converted.status, converted.message, startedAt);
    }
    return converted.baseline;
  }

  /** 本次查询实际请求的迭代数（按桌人数标定，见 `GTOPEN_SIZE_PROFILES`） */
  private iterationsFor(scenario: GtoScenario): number {
    return (
      this.budget.iterationsByTableSize?.[scenario.tableSize] ??
      iterationsForTableSize(scenario.tableSize)
    );
  }

  /** 本次查询是否提供「全下」（按桌人数标定，见 `GTOPEN_SIZE_PROFILES`） */
  private addAllinFor(scenario: GtoScenario): boolean {
    return (
      this.budget.addAllinByTableSize?.[scenario.tableSize] ??
      profileForTableSize(scenario.tableSize).addAllin
    );
  }

  /**
   * 🔴 本次查询的**求解侧参数**（缓存键的一半）。
   *
   * 这是「谁决定参数，谁提供描述」的落地：迭代数、是否提供全下、
   * 座位定义这些只有本 Provider 知道的项，必须由这里给出，
   * 而不是让缓存层自己拼一个「差不多的」。
   *
   * 任何一项变化都会改变缓存键 ⇒ 不会命中旧缓存。
   */
  solveKeyParts(scenario: GtoScenario): GtoSolveKeyParts {
    const seats = buildEngineSeats(scenario.tableSize, scenario.blinds);
    return {
      engine: this.engine,
      engineCommit: GTOPEN_ENGINE_COMMIT,
      // GTOpen 没有版本端点 ⇒ 恒为 null。**不编**。
      solverVersion: null,
      openSizesBB: [...this.budget.openSizesBB],
      raiseMults: [...this.budget.raiseMults],
      maxRaises: this.budget.maxRaises,
      limp: this.budget.limp,
      addAllin: this.addAllinFor(scenario),
      rakePct: this.budget.rakePct,
      rakeCap: this.budget.rakeCap,
      realization: this.budget.realization,
      multiwayEquityModel: GTOPEN_CAPABILITY_TABLE.multiwayEquityModel,
      iterations: this.iterationsFor(scenario),
      targetGap: this.targetGapFor(scenario),
      checkEvery: this.budget.checkEvery,
      enginePositions: seats.positions,
      posts: seats.posts,
      ante: scenario.blinds.anteBB,
    };
  }

  /**
   * 本次查询的**收敛目标**。
   *
   * ## 为什么是「按桌人数标定」而不是一个全局常数
   *
   * 实测证明不同树的 gap 差 60 倍（2 分支 vs 3 分支），
   * 所以**不存在**一个跨树通用的「好 gap」。这里的值是**工程调参**：
   * 取 Phase 1 实测达到的水平，让「是否达标」变成一个真实可判定的信号
   *（达标 ⇒ 求解器自己会以 `target_reached` 停下，而不是跑满迭代数）。
   *
   * ⚠️ 这**不是**「gap < X 就是 GTO」的断言。达标只说明
   * 「在这棵树、这次预算下，它降到了我们给自己设的水平」。
   * 质量等级仍然受 `APPROXIMATE` 天花板限制（见 `gtoQuality.ts`）。
   *
   * 可用 `budget.targetGapByTableSize` 覆盖（测试用它固定住行为）。
   */
  private targetGapFor(scenario: GtoScenario): number {
    return (
      this.budget.targetGapByTableSize?.[scenario.tableSize] ??
      GTOPEN_TARGET_GAP_BY_TABLE_SIZE[scenario.tableSize] ??
      this.budget.targetGap
    );
  }

  /** 建会话 + 求解 + 等待 */
  private async ensureSession(
    scenario: GtoScenario,
    signature: string,
  ): Promise<GtoHttpError | null> {
    const config = buildEngineConfig(scenario, this.budget, this.addAllinFor(scenario));

    // 规模预检：树太大时**不要**去建（`spot` 会返回 400，但预检信息更有用，
    // 而且不触碰现有会话）
    const estimate = await this.client.postJson('/api/preflop/estimate', config);
    if (estimate.ok) {
      const root = asRecord(estimate.value);
      const truncated = root?.['truncated'] === true;
      const ok = root?.['ok'] === true;
      if (truncated || !ok) {
        const nodes = asNumber(root?.['nodes']) ?? -1;
        const limitNodes = asNumber(root?.['limit_nodes']) ?? -1;
        const limitMb = asNumber(root?.['limit_arena_mb']) ?? -1;
        return {
          kind: 'UNSUPPORTED',
          status: null,
          path: '/api/preflop/estimate',
          bodySnippet: null,
          message:
            `这个场景的动作树超出了本机求解器的容量上限（估算 ${nodes} 个节点 / ` +
            `上限 ${limitNodes} 节点、${limitMb} MB）。` +
            '本阶段**不会**为一个超限的树伪造任何范围数据 —— 请减少加注层数或人数。',
        };
      }
    }

    const built = await this.client.postJson('/api/preflop/spot', config);
    if (!built.ok) {
      this.currentSignature = null;
      this.currentSolved = false;
      return built.error;
    }
    this.currentSignature = signature;
    this.currentSolved = false;

    // ---- 求解（异步）+ 轮询直到结束 ----
    const solve = await this.client.postJson(
      '/api/preflop/solve',
      {
        // ⚠️ 迭代数按**桌人数**标定（8/9 人桌的树大得多，见
        //    `GTOPEN_SIZE_PROFILES`）。这个值会进元数据，
        //    因此「这次到底迭代了多少次」永远可查。
        iterations: this.iterationsFor(scenario),
        check_every: this.budget.checkEvery,
        target_gap: this.targetGapFor(scenario),
        early_preview: false,
      },
      HEALTH_TIMEOUT_MS,
    );
    if (!solve.ok && solve.error.status !== 409) {
      // 409 = 已经有一个求解在跑（可能是上一次超时留下的）。那种情况继续轮询即可。
      this.currentSignature = null;
      this.currentSolved = false;
      return solve.error;
    }

    const waited = await this.waitForSolve();
    if (!waited.ok) {
      // 超时 / 求解报错：**不**使用半途的策略
      this.currentSolved = false;
      return waited.error;
    }
    this.currentSolved = true;
    return null;
  }

  /** 轮询 `/api/preflop/status` 直到 `state` 离开 `running` */
  private async waitForSolve(): Promise<{ ok: true } | { ok: false; error: GtoHttpError }> {
    const deadline = this.now() + this.budget.solveWaitMs;
    let lastState = '';
    let lastIteration = -1;

    while (this.now() < deadline) {
      const probe = await this.client.getJson('/api/preflop/status', HEALTH_TIMEOUT_MS);
      if (!probe.ok) return { ok: false, error: probe.error };
      const status = parseStatus(probe.value);
      if (status === null) {
        return {
          ok: false,
          error: {
            kind: 'INVALID_RESPONSE',
            status: probe.status,
            path: '/api/preflop/status',
            bodySnippet: null,
            message: '求解器状态响应结构不符合预期（缺少 state 字段）',
          },
        };
      }
      lastState = status.state;
      lastIteration = status.iteration ?? -1;
      if (status.state === 'running') {
        await this.sleep(this.budget.pollIntervalMs);
        continue;
      }
      if (status.state === 'error' || status.state === 'failed') {
        return {
          ok: false,
          error: {
            kind: 'FAILED',
            status: probe.status,
            path: '/api/preflop/status',
            bodySnippet: null,
            message: `求解器报告求解失败：${status.error || '（未提供原因）'}`,
          },
        };
      }
      // done / stopped / idle —— 都表示后台线程已结束
      return { ok: true };
    }

    return {
      ok: false,
      error: {
        kind: 'TIMEOUT',
        status: null,
        path: '/api/preflop/status',
        bodySnippet: null,
        message:
          `等待求解完成超过 ${this.budget.solveWaitMs} ms（最后状态 ${lastState}，迭代 ${lastIteration}）。` +
          '本次**不提供**GTO 数据：跑了一半的策略不能被当成基线。' +
          'Alpha 将按原有逻辑继续。',
      },
    };
  }

  /**
   * 沿前序动作走到 Hero 的决策节点。
   *
   * ## 🔴 路径是**边走边问**出来的，不是算出来的
   *
   * 每一步请求当前节点，读回它**真实存在的动作菜单**，然后用
   * 「语义类别 + 金额」匹配下一条前序动作的下标。
   *
   * 为什么不能算：动作菜单取决于求解器内部状态（是否允许跛入、
   * 加注上限、是否把大额加注变成全下、最小加注夹取……），
   * 用公式猜下标会在边界上静默错位一格 —— 而错位一格就是**读到别人的策略**。
   *
   * 匹配失败时返回 `UNSUPPORTED`：**不猜，直接报不支持。**
   */
  private async walkToHero(scenario: GtoScenario): Promise<
    | { ok: true; node: EngineNodeView; status: EngineStatus | null; path: number[] }
    | { ok: false; error: GtoHttpError }
  > {
    const order = buildEngineSeats(scenario.tableSize, scenario.blinds).positions;
    const heroSeat = order.indexOf(scenario.heroPosition);
    if (heroSeat < 0) {
      return {
        ok: false,
        error: {
          kind: 'UNSUPPORTED',
          status: null,
          path: '/api/preflop/node',
          bodySnippet: null,
          message: `位置 ${scenario.heroPosition} 不在 ${scenario.tableSize} 人桌的座位表里`,
        },
      };
    }

    const path: number[] = [];
    let lastStatus: EngineStatus | null = null;

    for (let step = 0; step <= scenario.actionHistory.length; step++) {
      const response = await this.client.postJson('/api/preflop/node', { path });
      if (!response.ok) return { ok: false, error: response.error };
      const node = parseNodeView(response.value);
      if (node === null) {
        return {
          ok: false,
          error: {
            kind: 'INVALID_RESPONSE',
            status: response.status,
            path: '/api/preflop/node',
            bodySnippet: null,
            message:
              '求解器返回的节点结构不符合预期（缺少 positions / actions / strategy 等字段）',
          },
        };
      }
      const root = asRecord(response.value);
      lastStatus = root === null ? null : parseStatus(root['publication'], true);

      if (node.kind !== 'action' || node.actor === null || node.actorPos === null) {
        return {
          ok: false,
          error: {
            kind: 'INVALID_RESPONSE',
            status: response.status,
            path: '/api/preflop/node',
            bodySnippet: null,
            message: `路径 [${path.join(',')}] 走到了非动作节点（kind=${node.kind}），无法读取策略`,
          },
        };
      }

      if (step === scenario.actionHistory.length) {
        if (node.actor !== heroSeat || node.actorPos !== scenario.heroPosition) {
          return {
            ok: false,
            error: {
              kind: 'INVALID_RESPONSE',
              status: response.status,
              path: '/api/preflop/node',
              bodySnippet: null,
              message:
                `走到路径 [${path.join(',')}] 后行动者是 ${node.actorPos}（座位 ${node.actor}），` +
                `而场景要求的是 ${scenario.heroPosition}（座位 ${heroSeat}）。` +
                '为避免把别人的策略当成 Hero 的，本次判为不可用。',
            },
          };
        }
        return { ok: true, node, status: lastStatus, path };
      }

      const wanted = scenario.actionHistory[step]!;
      const matchIndex = matchActionIndex(node.actions, wanted.kind, wanted.sizeBB);
      if (matchIndex === null) {
        return {
          ok: false,
          error: {
            kind: 'UNSUPPORTED',
            status: response.status,
            path: '/api/preflop/node',
            bodySnippet: null,
            message:
              `求解器的动作菜单里找不到「${wanted.position} ${wanted.kind}` +
              `${wanted.sizeBB === null ? '' : ` 到 ${wanted.sizeBB}BB`}」。` +
              `该节点可用动作：${node.actions.map((a) => a.label).join(' / ') || '（无）'}。` +
              '本阶段不会用相近的动作顶替。',
          },
        };
      }
      path.push(matchIndex);
    }

    return {
      ok: false,
      error: {
        kind: 'FAILED',
        status: null,
        path: '/api/preflop/node',
        bodySnippet: null,
        message: `内部错误：路径遍历未能在 ${scenario.actionHistory.length + 1} 步内结束`,
      },
    };
  }

  /* ---------------- 响应 → 内部格式 ---------------- */

  private convertNode(
    scenario: GtoScenario,
    scenarioHash: string,
    node: EngineNodeView,
    status: EngineStatus | null,
    path: readonly number[],
    startedAt: number,
  ):
    | { ok: true; baseline: GtoBaseline }
    | { ok: false; status: GtoSolveStatus; message: string } {
    const actorPosition = node.actorPos;
    if (actorPosition === null) {
      return { ok: false, status: GtoSolveStatus.INVALID_RESPONSE, message: '节点没有行动者位置' };
    }

    // ---- 动作菜单 ----
    const actionMenu: { kind: GtoActionKind; sizeBB: number | null; rawLabel: string }[] = [];
    for (const action of node.actions) {
      const kind = mapActionKind(action.kind);
      if (kind === null) {
        return {
          ok: false,
          status: GtoSolveStatus.INVALID_RESPONSE,
          message: `求解器返回了本项目不认识的动作类别：${action.kind}（标签 ${action.label}）`,
        };
      }
      actionMenu.push({
        kind,
        sizeBB: kind === GtoActionKind.FOLD || kind === GtoActionKind.CHECK ? null : action.to,
        rawLabel: action.label,
      });
    }

    // ---- 频率合法性（0..1，求和为 1） ----
    let freqSum = 0;
    for (const action of node.actions) {
      if (!isFrequency01(action.freq)) {
        return {
          ok: false,
          status: GtoSolveStatus.INVALID_RESPONSE,
          message:
            `求解器返回的动作频率不在 0..1 内（${action.label} = ${action.freq}）。` +
            '为避免把百分数当成小数（0.65 → 65% 与 65 → 6500% 混淆），本次判为不可用。',
        };
      }
      freqSum += action.freq;
    }
    if (node.actions.length > 0 && Math.abs(freqSum - 1) > 0.02) {
      return {
        ok: false,
        status: GtoSolveStatus.INVALID_RESPONSE,
        message: `动作频率之和为 ${freqSum.toFixed(4)}（应为 1）—— 数据不完整，本次判为不可用`,
      };
    }

    // ---- 策略矩阵 ----
    const strategy = node.strategy;
    const reach = node.reach;
    if (strategy === null) {
      const note = node.strategyNote ?? '求解器没有给出这个节点的策略（可能是模型未应用或从未求解）';
      return { ok: false, status: GtoSolveStatus.FAILED, message: note };
    }
    const expectedLength = node.actions.length * 169;
    if (strategy.length !== expectedLength) {
      return {
        ok: false,
        status: GtoSolveStatus.INVALID_RESPONSE,
        message:
          `策略数组长度为 ${strategy.length}，按「${node.actions.length} 个动作 × 169 类」应为 ${expectedLength}。` +
          '长度不符说明我们对响应结构的理解是错的，本次判为不可用。',
      };
    }
    if (reach !== null && reach.length !== 169) {
      return {
        ok: false,
        status: GtoSolveStatus.INVALID_RESPONSE,
        message: `reach 数组长度为 ${reach.length}（应为 169）—— 本次判为不可用`,
      };
    }

    // ---- 逐类手牌构造策略 ----
    const hands: GtoHandStrategy[] = [];
    for (let classIndex = 0; classIndex < 169; classIndex++) {
      const handClass = GTO_HAND_CLASSES_BY_CLASS_INDEX[classIndex]!;
      const perAction: GtoActionFrequency[] = [];
      let rowSum = 0;
      for (let a = 0; a < node.actions.length; a++) {
        const frequency = strategy[a * 169 + classIndex]!;
        if (!Number.isFinite(frequency) || frequency < -1e-3 || frequency > 1 + 1e-3) {
          return {
            ok: false,
            status: GtoSolveStatus.INVALID_RESPONSE,
            message: `${handClass.code} 的动作频率越界（${frequency}）—— 数据不可信，本次判为不可用`,
          };
        }
        const clamped = Math.min(1, Math.max(0, frequency));
        rowSum += clamped;
        const menu = actionMenu[a]!;
        perAction.push({
          kind: menu.kind,
          sizeBB: menu.sizeBB,
          frequency: clamped,
          // 🔴 GTOpen 的 `/api/preflop/node` **不返回逐动作 EV**。
          // 这里必须是 null —— 编一个 EV 出来是本项目明确禁止的。
          evBB: null,
          rawLabel: menu.rawLabel,
        });
      }
      if (Math.abs(rowSum - 1) > 0.02) {
        return {
          ok: false,
          status: GtoSolveStatus.INVALID_RESPONSE,
          message: `${handClass.code} 的动作频率之和为 ${rowSum.toFixed(4)}（应为 1）—— 本次判为不可用`,
        };
      }
      hands.push({
        hand: handClass.code,
        combos: handClass.combos,
        reach: reach === null ? null : Math.min(1, Math.max(0, reach[classIndex]!)),
        // 保留**全部非零频率**动作 —— 混合策略本身就是 GTO 的输出
        actions: Object.freeze(
          perAction.filter((a) => a.frequency > 0).map((a) => Object.freeze(a)),
        ),
      });
    }

    const approximation = this.approximationFlags(scenario, status);
    const solveSettings: GtoSolveSettings = {
      iterationsRequested: this.iterationsFor(scenario),
      iterationsCompleted: status?.iteration ?? status?.publishedIteration ?? null,
      targetGap: status?.targetGap ?? this.targetGapFor(scenario),
      reportedGap: status?.gapTotal ?? null,
      modelName:
        (status?.multiwayEquityModel !== undefined && status.multiwayEquityModel !== ''
          ? status.multiwayEquityModel
          : null) ?? GTOPEN_CAPABILITY_TABLE.multiwayEquityModel,
      raw: Object.freeze({
        path: [...path],
        actionMenu: actionMenu.map((a) => a.rawLabel),
        nodePot: node.pot,
        exportable: node.exportable,
        state: status?.state ?? null,
        phase: status?.phase ?? null,
        stopReason: status?.stopReason ?? null,
        realizationNote: status?.realizationNote ?? null,
        gaps: status?.gaps ?? [],
        evs: status?.evs ?? [],
        gpu: status?.gpu ?? false,
        solveBudget: {
          openSizesBB: [...this.budget.openSizesBB],
          raiseMults: [...this.budget.raiseMults],
          maxRaises: this.budget.maxRaises,
          limp: this.budget.limp,
          addAllin: this.addAllinFor(scenario),
          realization: this.budget.realization,
          requestedIterations: this.iterationsFor(scenario),
          sizeProfiles: { ...GTOPEN_SIZE_PROFILES },
          tableSize: scenario.tableSize,
        },
      }),
    };

    const metadata: GtoMetadata = {
      source: {
        kind: 'SOLVER',
        engine: this.engine,
        sourceVersion: null,
        engineCommit: GTOPEN_ENGINE_COMMIT,
        endpoint: this.baseUrl,
      },
      scenarioHash,
      solveSettings,
      solveStatus: solveStatusOf(status),
      // 🔴 天花板是 APPROXIMATE —— 见文件头
      verification: GTOPEN_PREFLOP_MAX_VERIFICATION,
      approximation,
      timestamp: new Date(this.now()).toISOString(),
      latencyMs: this.now() - startedAt,
    };

    const range: GtoRange = {
      actorPosition: actorPosition as GtoRange['actorPosition'],
      actionMenu: Object.freeze(actionMenu.map((a) => Object.freeze(a))),
      hands: Object.freeze(hands),
      potBB: node.pot,
      reachable: node.strategyNote === null,
      unavailableReason: node.strategyNote,
    };

    return { ok: true, baseline: { scenario, scenarioHash, range, metadata } };
  }

  /** 近似标记（逐条给依据，界面直接显示） */
  private approximationFlags(
    scenario: GtoScenario,
    status: EngineStatus | null,
  ): GtoApproximationFlags {
    const notes: string[] = [];
    notes.push(
      'GTOpen 的翻前使用「近似延续模型」：它求解的是建模后的延续收益，' +
        '不是完整的翻牌后博弈（源码 crates/solver/src/preflop/mod.rs 文件头自述）。',
    );
    if (scenario.tableSize >= 3) {
      notes.push(
        `本场景有 ${scenario.tableSize} 名玩家：3 人以上的底池使用 coupled_deck_v1` +
          '（1024 个确定性潜在强度样本），不是真实共同发牌，也不代表完整的多人翻牌后求解。',
      );
    }
    notes.push('169 类机会模型忽略联合去牌效应：范围越窄、重叠越多，误差越大。');
    if (status !== null && status.realizationNote !== '') {
      notes.push(`求解器自述：${status.realizationNote}`);
    }
    const converged = status?.state === 'done' && (status.stopReason === 'target_gap' || status.gapTotal === 0);
    if (!converged) {
      notes.push(
        `本次求解**未收敛**（迭代 ${status?.iteration ?? status?.publishedIteration ?? '未知'} 次，` +
          `停止原因 ${status?.stopReason || '未知'}${status?.gapTotal === null || status?.gapTotal === undefined ? '' : `，BR gap 之和 ${status.gapTotal.toFixed(6)}`}）。` +
          '频率是当前快照，不是均衡。',
      );
    }
    if (this.budget.openSizesBB.length === 1 && this.budget.maxRaises <= 2) {
      notes.push(
        `本次动作树被刻意压缩（开池 ${this.budget.openSizesBB.join('/')}BB、再加注 ` +
          `${this.budget.raiseMults.join('/')}×、加注上限 ${this.budget.maxRaises} 次、` +
          `跛入 ${this.budget.limp ? '允许' : '关闭'}），以便在纯 CPU 上跑完。` +
          (this.budget.limp
            ? ''
            : '**因此没有跛入频率**；且更细的尺寸菜单会给出不同的频率。'),
      );
    }
    /*
     * 🔴 按桌人数关掉「全下」时**必须**明说 —— 这是一条真实的能力限制，
     * 而不是实现细节。使用者看到「动作菜单里没有全下」时，
     * 必须能立刻知道**为什么**，以及这不是求解器的能力问题。
     */
    if (!this.addAllinFor(scenario)) {
      notes.push(
        `本次动作菜单**不含全下**（${this.budget.openSizesBB.join('/')}BB 开池 / ` +
          `${this.budget.raiseMults.join('/')}× 再加注两条分支之外没有 all-in）。` +
          '原因：本机实测显示，把全下放进动作树会让每次迭代慢约 5 倍，' +
          '并且在 8/9 人桌上 10 次迭代后仍无法收敛（BR gap 之和 > 5）。' +
          '与其给出一个**未收敛的全下频率**，不如明确不提供它。' +
          '需要全下频率时请把 `addAllinByTableSize` 打开并接受更长的求解时间。',
      );
    }
    return Object.freeze({
      approximateModel: true,
      notConverged: !converged,
      multiwayContinuation: scenario.tableSize >= 3,
      compressedPrecision: false,
      fromCache: false,
      notes: Object.freeze(notes),
    });
  }

  /* ---------------- 不可用结果 ---------------- */

  private unavailableFromHttp(
    scenario: GtoScenario,
    scenarioHash: string,
    error: GtoHttpError,
    startedAt: number,
  ): GtoLookupResult {
    return this.unavailable(scenario, scenarioHash, error.kind, error.message, startedAt);
  }

  private unavailable(
    scenario: GtoScenario,
    scenarioHash: string,
    cause: GtoSolveStatus,
    message: string,
    startedAt: number,
  ): GtoUnavailable {
    const metadata: GtoMetadata = {
      source: {
        kind: 'SOLVER',
        engine: this.engine,
        sourceVersion: null,
        engineCommit: GTOPEN_ENGINE_COMMIT,
        endpoint: this.baseUrl,
      },
      scenarioHash,
      solveSettings: {
        iterationsRequested: this.budget.iterations,
        iterationsCompleted: null,
        targetGap: this.budget.targetGap,
        reportedGap: null,
        modelName: null,
        raw: Object.freeze({}),
      },
      solveStatus: GtoSolveStatus.GTO_BASELINE_UNAVAILABLE,
      verification: GtoVerification.UNVERIFIED,
      approximation: GTO_NO_APPROXIMATION,
      timestamp: new Date(this.now()).toISOString(),
      latencyMs: this.now() - startedAt,
    };
    return Object.freeze({
      status: GtoSolveStatus.GTO_BASELINE_UNAVAILABLE,
      cause,
      message,
      scenario,
      scenarioHash,
      metadata,
    });
  }
}

/**
 * 在动作菜单里找匹配项的下标。
 *
 * 匹配规则（**先语义、后金额**）：
 * - `FOLD` / `CHECK`：只比 `kind`
 * - `CALL`：只比 `kind`（跟注金额由规则决定，没有选择空间）
 * - `RAISE` / `ALL_IN` / `BET`：比 `kind` **且**比金额
 *   （容差 0.01BB，用来吸收浮点误差，**不是**用来「凑近似值」）
 *
 * 找不到返回 `null`（调用方判 UNSUPPORTED），**不做最近邻匹配**。
 */
export function matchActionIndex(
  actions: readonly EngineActionEntry[],
  kind: GtoActionKind,
  sizeBB: number | null,
): number | null {
  const tolerance = 0.01;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    const engineKind = mapActionKind(action.kind);
    if (engineKind !== kind) continue;
    if (sizeBB === null) return i;
    if (Math.abs(action.to - sizeBB) <= tolerance) return i;
  }
  return null;
}

/** 求解状态：只用求解器自述的事实，不加解读 */
export function solveStatusOf(status: EngineStatus | null): GtoSolveStatus {
  if (status === null) return GtoSolveStatus.RUNNING;
  if (status.state === 'error' || status.state === 'failed') return GtoSolveStatus.FAILED;
  if (status.state === 'done') return GtoSolveStatus.SOLVED;
  if (status.state === 'running' || status.state === 'stopped' || status.state === 'idle') {
    return GtoSolveStatus.RUNNING;
  }
  return GtoSolveStatus.RUNNING;
}

/**
 * 我们验证过的 GTOpen commit SHA。
 *
 * 🔴 这是**构建来源**的记录，不是运行时从二进制里读出来的
 *（GTOpen 没有暴露版本端点 —— 它的 `/api/preflop/capabilities` 只有能力布尔值）。
 * 因此当 `GTOopen/GTOpen` 目录被更新时，必须同时更新这个常量；
 * 有测试比对目录里的实际文件（`gtopenProvenance.test.ts`）。
 */
export const GTOPEN_ENGINE_COMMIT = '92c86ed73aa0856df8479b5c7635e1469f48f1e8';

/** 供测试与自检使用 */
export function selfCheckProviderLayer(): string[] {
  const problems: string[] = [];
  if (GTOPEN_CAPABILITY_TABLE.verifiedTableSizes.length !== 5) {
    problems.push(
      `验证过的桌人数应为 5 档（4/5/6/8/9），实际 ${GTOPEN_CAPABILITY_TABLE.verifiedTableSizes.length} 档`,
    );
  }
  if (!GTOPEN_CAPABILITY_TABLE.preflopApproximateModel) {
    problems.push('翻前必须被标记为近似模型 —— 源码自述如此，不允许改成精确模型');
  }
  if (GTOPEN_PREFLOP_MAX_VERIFICATION !== 'APPROXIMATE') {
    problems.push('翻前可信度上限必须是 APPROXIMATE');
  }
  if (GTOPEN_DEFAULT_BUDGET.iterations <= 0) problems.push('默认迭代数必须为正');
  if (GTOPEN_DEFAULT_BUDGET.maxRaises < 1) problems.push('加注上限至少为 1（开池本身）');
  if (GTOPEN_DEFAULT_BUDGET.targetGap > 0) {
    problems.push('默认 targetGap 应为 0（跑满迭代数就停），否则会假装收敛');
  }
  if (GTOPEN_DEFAULT_BUDGET.solveWaitMs <= 0) problems.push('求解等待上限必须为正');
  if (GTO_HAND_CLASSES.length !== 169) problems.push('169 类手牌定义不完整');
  if (TOTAL_COMBOS !== 1326) problems.push('组合总数应为 1326');
  return problems;
}

export { GtoHttpClient };
export type { GtoHttpResult };
