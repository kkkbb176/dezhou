/**
 * GTO 应用层 —— Alpha 与 GTO Provider 之间的**唯一**装配点
 *
 * ## 分层
 *
 * ```
 * webServer / UI
 *   ↓  只依赖本文件导出的函数
 * gtoApi（本文件）  ← 唯一允许 import Provider 的地方
 *   ↓
 * GtoProvider（接口） → GtopenProvider → GTOpen HTTP
 * ```
 *
 * ## 🔴 本文件对 Alpha 的**唯一**承诺
 *
 * 1. **永不抛异常**。任何失败都变成结构化的 `GTO_BASELINE_UNAVAILABLE`。
 * 2. **永不无限等待**。外层硬超时兜底（见 `GtoSafeLookup`）。
 * 3. **绝不伪造**。拿不到数据就说拿不到，不返回默认频率、不用旧 Prior 冒充。
 * 4. **可关闭**。`ALPHA_GTO=off` 或 `setGtoEnabled(false)` 时，
 *    所有查询立刻返回「已关闭」，一个字节的网络请求都不会发。
 *
 * 第 4 条不是可选项：本轮要求「GTOpen 故障时 Alpha 仍然正常工作」，
 * 而「故障」包含「用户根本不想启动它」。这种情况下界面必须仍然能打开、
 * 仍然能显示一句**明确的**中文说明，而不是转圈或白屏。
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GtoSolveStatus,
  gtoPositionsFor,
  gtoTableSizeOf,
  type GtoBaseline,
  type GtoEngineCapabilities,
  type GtoLookupResult,
  type GtoProviderHealth,
  type GtoScenario,
  type GtoTableSize,
} from '../../domain/gto/gto.types.ts';

import { scenarioHashOf } from '../../domain/gto/gtoScenario.ts';

import { GtoSafeLookup, type GtoLookupStats } from '../../domain/gto/gtoSafeLookup.ts';

import { DEFAULT_GTO_CACHE_DIR } from '../../domain/gto/gtoStrategyStore.ts';
import {
  GTO_QUALITY_ZH,
  GtoQuality,
  qualityDisclaimerZh,
  type GtoStabilityEvidence,
} from '../../domain/gto/gtoQuality.ts';

import { createGtopenProvider } from '../../domain/gto/providers/providerRegistry.ts';
import type { GtopenProvider } from '../../domain/gto/providers/gtopenProvider.ts';

import {
  catalogForTableSize,
  fullCatalog,
  selfCheckCatalog,
  type GtoCatalogEntry,
} from './gtoScenarioCatalog.ts';
import {
  GTO_EXTENDED_TEMPLATE_ZH,
  extendedCatalogForTableSize,
  extendedFullCatalog,
  selfCheckExtendedCatalog,
} from './gtoExtendedScenarios.ts';

/* ============================================================
 * 单例装配
 * ============================================================ */

let instance: GtoSafeLookup | null = null;
let provider: GtopenProvider | null = null;

function gtoEnabledByEnv(): boolean {
  const raw = typeof process !== 'undefined' ? process.env['ALPHA_GTO'] : undefined;
  if (raw === undefined) return true;
  return !/^(0|off|false|no)$/i.test(raw.trim());
}

let enabled = gtoEnabledByEnv();

/**
 * 交互式查询的外层硬超时。
 *
 * ## 为什么是 10 分钟而不是 Phase 1 的 2 分钟
 *
 * 实测（Phase 1.1）：9 人桌一次冷求解 **164 秒**，8 人桌 88 秒。
 * 2 分钟的硬超时会让 9 人桌**永远拿不到数据** —— 那不是「安全回退」，
 * 那是「一个本可用的场景被自己的超时掐死」。
 *
 * 10 分钟的依据：9 人桌实测 164 秒 × 约 3.6 倍余量，
 * 足以覆盖机器负载波动，同时仍然是一个**有限的**上限
 *（冻结风险由「有限等待 + 明确超时回退」控制，而不是靠把上限压得很小）。
 */
const INTERACTIVE_HARD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 稳定性证据文件（由 `scripts/gto-stability-probe.ts` 产出）。
 *
 * 🔴 **没有证据就不给高等级**。因此这里读不到文件时传空对象 ——
 * 于是所有结果都会带上「没有实测过稳定性」这条 blocker，
 * 质量等级停在 `LOW_CONVERGENCE`。这是刻意设计的安全默认值。
 */
function loadStabilityEvidence(): Readonly<Record<string, GtoStabilityEvidence>> {
  try {
    const path = fileURLToPath(new URL('../../../data/gto-stability.json', import.meta.url));
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return {};
    return parsed as Record<string, GtoStabilityEvidence>;
  } catch {
    return {};
  }
}

/** 取（或惰性创建）查询器 */
export function gtoLookup(): GtoSafeLookup {
  if (instance === null) {
    provider = createGtopenProvider();
    instance = new GtoSafeLookup(provider, {
      hardTimeoutMs: INTERACTIVE_HARD_TIMEOUT_MS,
      // 🔴 Phase 1.1：启用持久化缓存（跨进程重启有效）
      storeOptions: {
        dir: process.env['ALPHA_GTO_CACHE_DIR'] ?? DEFAULT_GTO_CACHE_DIR,
      },
      stabilityEvidence: loadStabilityEvidence(),
    });
  }
  return instance;
}

/** 取底层 Provider（**仅测试与诊断**；业务代码不得使用） */
export function gtoProvider(): GtopenProvider {
  gtoLookup();
  return provider!;
}

/**
 * 取**带缓存**的查询器（Phase 1.3）。
 *
 * 这是前台取数与后台补算**唯一**应该拿的东西 ——
 * 它同时提供「只读缓存、绝不求解」（`lookupCachedOnly`）与
 * 「求解并落盘」（`lookupWithStats`），于是调用方不需要知道
 * 「该用哪个方法才不会卡住」，因为慢的那个**不在前台接口里**
 *（见 `GtoCachedLookup` 的说明）。
 */
export function gtoCachedLookup(): GtoSafeLookup {
  return gtoLookup();
}

/** 是否启用 GTO 查询 */
export function isGtoEnabled(): boolean {
  return enabled;
}

/** 打开 / 关闭 GTO（关闭后所有查询立即返回「已关闭」，不发任何请求） */
export function setGtoEnabled(value: boolean): void {
  enabled = value;
}

/** 重置单例（测试用） */
export function resetGtoForTests(overrides?: {
  lookup?: GtoSafeLookup;
  provider?: GtopenProvider;
  enabled?: boolean;
}): void {
  instance = overrides?.lookup ?? null;
  provider = overrides?.provider ?? null;
  if (overrides?.enabled !== undefined) enabled = overrides.enabled;
}

/* ============================================================
 * 统一响应形状（界面直接消费）
 * ============================================================ */

/**
 * 统一响应形状（界面直接消费）。
 *
 * 🔴 `status` 的取值是**封闭的三个**：
 *
 * | status | 含义 | 界面必须做什么 |
 * |---|---|---|
 * | `SOLVED` | 精确模型的已收敛结果（**本阶段永远不会出现**） | 可以显示为已求解 |
 * | `APPROXIMATE` | 拿到了数据，但模型/收敛度是近似的 | 必须显示「近似求解」 |
 * | `UNAVAILABLE` | **拿不到可用基线**（离线 / 超时 / 拒绝 / 坏数据…） | **不显示任何范围数据** |
 *
 * 失败的具体原因放在 `cause`（`OFFLINE` / `TIMEOUT` / `UNSUPPORTED` / …），
 * 它**只用于诊断**，不参与界面分支 —— 界面只认 `ok` 与 `status`。
 *
 * 为什么这样分：如果 `status` 直接透出 7 种失败原因，界面上就会出现
 * 「新增一种失败原因 → 漏掉一处判断 → 显示了半个矩阵」这种缺陷。
 * 把「能不能用」与「为什么不能用」分成两个字段，边界就只有一处。
 */
export type GtoJsonResponse = {
  ok: boolean;
  /** `SOLVED` / `APPROXIMATE` / `UNAVAILABLE` 三选一 */
  status: string;
  /** 具体失败原因（诊断用）；成功时为 `null` */
  cause: string | null;
  /** 中文说明（拿不到数据时**一定**有） */
  messageZh: string;
  /** 可信度（中文） */
  verificationZh: string | null;
  /** 是否近似求解（界面据此决定是否显示「近似求解」横幅） */
  approximate: boolean;
  /** 逐条近似说明 */
  approximationNotes: readonly string[];
  /** 数据本身（成功时才有） */
  baseline: GtoLookupResult | null;
  /** 统计（缓存命中 / 超时 / 耗时） */
  stats: GtoLookupStats | null;
  /**
   * 🔴 **Phase 1.1**：求解质量（**质量 ≠ API 成功**）。
   *
   * 拿不到数据时为 `null`。界面必须显示它，且低质量必须用
   * 「质量有限 / 近似策略」这类措辞（见 `qualityDisclaimerZh`）。
   */
  quality: {
    level: GtoQuality;
    levelZh: string;
    summaryZh: string;
    disclaimerZh: string;
  } | null;
  /**
   * 🔴 **Phase 1.1**：这份数据是**算出来的**还是**读出来的**。
   *
   * 存在的理由：9 人桌一次求解要 ~160 秒，而命中持久化缓存只要几毫秒。
   * 不显示的话，使用者会以为**每次都在重新求解**（或反过来，
   * 以为几毫秒就解完了）—— 两种误解都会导致错误的信任。
   */
  cache: {
    source: string;
    sourceZh: string;
    cacheKey: string;
    cachedAt: string | null;
    solveDurationMs: number | null;
  } | null;
  /**
   * 可读的场景指纹（多行）—— 报告与调试用。
   *
   * 它与哈希**同时存在**：哈希用于精确比对，指纹用于**人**核对。
   */
  fingerprintLines: readonly string[];
};

function unavailableJson(
  message: string,
  cause: GtoSolveStatus,
  stats: GtoLookupStats | null = null,
): GtoJsonResponse {
  return {
    ok: false,
    status: 'UNAVAILABLE',
    cause,
    messageZh: message,
    verificationZh: '未验证',
    approximate: false,
    approximationNotes: [message],
    baseline: null,
    stats,
    quality: null,
    cache:
      stats === null
        ? null
        : {
            source: stats.source,
            sourceZh: cacheSourceZh(stats.source),
            cacheKey: stats.cacheKey,
            cachedAt: stats.cachedAt,
            solveDurationMs: stats.solveDurationMs,
          },
    fingerprintLines: [],
  };
}

/** 数据来源的中文说明（界面直接显示） */
function cacheSourceZh(source: GtoLookupStats['source']): string {
  switch (source) {
    case 'persistent':
      return '本地已缓存策略';
    case 'memory':
      return '本进程内存缓存';
    case 'solver':
      return '本次实时求解';
    default:
      return '未取得数据';
  }
}

/* ============================================================
 * 健康与能力
 * ============================================================ */

export async function gtoHealth(): Promise<GtoProviderHealth> {
  if (!enabled) {
    return {
      reachable: false,
      engine: 'gtopen',
      version: null,
      commit: null,
      endpoint: null,
      message: 'GTO 查询已被关闭（ALPHA_GTO=off 或调用方主动关闭）。Alpha 全部功能不受影响。',
    };
  }
  try {
    return await gtoProvider().health();
  } catch (error) {
    return {
      reachable: false,
      engine: 'gtopen',
      version: null,
      commit: null,
      endpoint: null,
      message: `健康检查失败（已捕获）：${(error as Error).message}`,
    };
  }
}

export async function gtoCapabilities(): Promise<GtoEngineCapabilities | null> {
  if (!enabled) return null;
  try {
    return await gtoProvider().capabilities();
  } catch {
    return null;
  }
}

/* ============================================================
 * 目录
 * ============================================================ */

export type GtoCatalogJson = {
  ok: true;
  tableSizes: readonly GtoTableSize[];
  /** 各桌型的位置顺序（界面用它动态显示位置下拉框） */
  positionsByTableSize: Readonly<Record<string, readonly string[]>>;
  /** 位置 → 中文（界面显示用；与 Alpha 的 POSITION_ZH 同一套词） */
  positionZh: Readonly<Record<string, string>>;
  entries: readonly {
    id: string;
    tableSize: number;
    heroPosition: string;
    template: string;
    labelZh: string;
    scenarioHash: string;
    supported: boolean;
    unsupportedReason: string | null;
    actionHistory: readonly { position: string; kind: string; sizeBB: number | null }[];
  }[];
};

/** 位置中文名（与 Alpha `manualInput.ts` 的 `POSITION_ZH` 保持一致口径） */
export const GTO_POSITION_ZH: Readonly<Record<string, string>> = Object.freeze({
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

/** 构造目录响应（纯本地计算，不访问求解器） */
export function gtoCatalog(tableSizes?: readonly GtoTableSize[]): GtoCatalogJson {
  const entries: GtoCatalogEntry[] =
    tableSizes === undefined ? fullCatalog() : tableSizes.flatMap((s) => catalogForTableSize(s));
  const usedSizes = [...new Set(entries.map((e) => e.tableSize))].sort((a, b) => a - b);
  const positionsByTableSize: Record<string, readonly string[]> = {};
  for (const size of usedSizes) {
    // 位置顺序取自领域层的**权威**定义（`GTO_POSITION_ORDER`），
    // 而不是「从条目里去重」—— 去重会丢失顺序，而顺序就是行动顺序。
    positionsByTableSize[String(size)] = [...gtoPositionsFor(size)];
  }
  return {
    ok: true,
    tableSizes: usedSizes,
    positionsByTableSize,
    positionZh: GTO_POSITION_ZH,
    entries: entitiesForJson(entries),
  };
}

function entitiesForJson(entries: readonly GtoCatalogEntry[]): GtoCatalogJson['entries'] {
  return entries.map((e) => ({
    id: e.id,
    tableSize: e.tableSize,
    heroPosition: e.heroPosition,
    template: e.template,
    labelZh: e.labelZh,
    scenarioHash: e.scenarioHash,
    supported: e.scenario !== null,
    unsupportedReason: e.unsupportedReason,
    actionHistory:
      e.scenario === null
        ? []
        : e.scenario.actionHistory.map((a) => ({
            position: a.position,
            kind: a.kind,
            sizeBB: a.sizeBB,
          })),
  }));
}

/** 启动自检 */
export function selfCheckGtoLayer(): string[] {
  return [...selfCheckCatalog(), ...selfCheckExtendedCatalog()];
}

/* ============================================================
 * 扩展场景目录（Phase 1.1：VS_OPEN / VS_3BET / VS_4BET）
 * ============================================================ */

export type GtoExtendedCatalogJson = {
  ok: true;
  /**
   * 🔴 **这份目录是按哪个有效筹码算出来的**（2026-09 修正轮）。
   *
   * 筹码是**一级场景参数**（与桌人数同级）：同一个 `6-BB-VS_NAMED_OPEN-BTN`
   * 条目在 100BB 与 50BB 下是**两个不同的决策节点**（`scenarioHash` 不同、
   * 频率不同）。因此它必须随目录一起下发，界面也必须显示出来 ——
   * 否则「界面上写着 50BB、数据其实是 100BB」这种分歧在结构上无法被发现。
   */
  effectiveStackBB: number;
  /** 模板 → 中文 */
  templateZh: Readonly<Record<string, string>>;
  entries: readonly {
    id: string;
    tableSize: number;
    heroPosition: string;
    /** 开池者（仅「面对指定开池」有值） */
    openerPosition: string | null;
    template: string;
    labelZh: string;
    scenarioHash: string;
    supported: boolean;
    unsupportedReason: string | null;
    requiredMaxRaises: number;
    actionHistory: readonly { position: string; kind: string; sizeBB: number | null }[];
  }[];
};

/**
 * 扩展场景目录（界面用它渲染「场景」下拉框）。
 *
 * 🔴 关键设计：**不支持项也下发**，并带 `unsupportedReason`。
 * 界面把它们显示成「尚未验证」，而不是**静默隐藏** ——
 * 「看不到」与「明确知道不支持」是两种完全不同的状态，
 * 前者会让人以为「这里本来就没有东西可查」。
 */
export function gtoExtendedCatalog(
  tableSizes?: readonly GtoTableSize[],
  maxRaises = 2,
  effectiveStackBB = 100,
): GtoExtendedCatalogJson {
  const entries =
    tableSizes === undefined
      ? extendedFullCatalog(undefined, effectiveStackBB, maxRaises)
      : tableSizes.flatMap((s) =>
          extendedCatalogForTableSize(s, effectiveStackBB, 2.5, maxRaises),
        );
  return {
    ok: true,
    effectiveStackBB,
    templateZh: GTO_EXTENDED_TEMPLATE_ZH,
    entries: entries.map((e) => ({
      id: e.id,
      tableSize: e.tableSize,
      heroPosition: e.heroPosition,
      openerPosition: e.openerPosition,
      template: e.template,
      labelZh: e.labelZh,
      scenarioHash: e.scenarioHash,
      supported: e.scenario !== null,
      unsupportedReason: e.unsupportedReason,
      requiredMaxRaises: e.requiredMaxRaises,
      actionHistory:
        e.scenario === null
          ? []
          : e.scenario.actionHistory.map((a) => ({
              position: a.position,
              kind: a.kind,
              sizeBB: a.sizeBB,
            })),
    })),
  };
}

/**
 * 按**扩展目录条目 id** 查询（Phase 1.1 的界面入口）。
 *
 * 与 `queryGtoCatalogEntry`（Phase 1 的按字段查询）并存：
 * 那个被 22 项测试锁住，不动它；这个服务扩展场景。
 *
 * 🔴 `effectiveStackBB`（2026-09 修正轮）：条目 id 里**不含**筹码，
 * 因此筹码必须作为独立参数传进来，由本函数用同一个目录构建器
 * 在该筹码下重新构造场景 —— 这样「50BB 的查询」拿到的就是 50BB 的场景
 *（`scenarioHash` 与缓存键都随之改变），不会出现「标签写 50BB、数据是 100BB」。
 * 构建器对无法表达的筹码会返回 `unsupportedReason`，本函数如实转达。
 */
export async function queryGtoExtendedEntry(
  entryId: string,
  effectiveStackBB = 100,
): Promise<GtoJsonResponse> {
  const found = extendedFullCatalog(undefined, effectiveStackBB).find((e) => e.id === entryId);
  if (found === undefined) {
    return unavailableJson(
      `扩展目录里没有条目「${entryId}」—— 界面不得编造场景。`,
      GtoSolveStatus.UNSUPPORTED,
    );
  }
  if (found.scenario === null) {
    return unavailableJson(
      found.unsupportedReason ?? '该场景在当前规则下无法表达。',
      GtoSolveStatus.UNSUPPORTED,
    );
  }
  return queryGtoScenario(found.scenario);
}

/* ============================================================
 * 主查询
 * ============================================================ */

/**
 * 查询一个场景的 GTO 基线（**界面唯一入口**）。
 *
 * 无论发生什么，返回的都是一个可以直接渲染的对象 ——
 * 不会抛异常、不会返回 `undefined`。
 */
export async function queryGtoScenario(scenario: GtoScenario): Promise<GtoJsonResponse> {
  if (!enabled) {
    return unavailableJson(
      'GTO 查询已被关闭。下方不显示任何 GTO 数据 —— 本工具**不会**用近似先验冒充 GTO 基线。',
      GtoSolveStatus.GTO_BASELINE_UNAVAILABLE,
    );
  }

  let outcome: { result: GtoLookupResult; stats: GtoLookupStats };
  try {
    outcome = await gtoLookup().lookupWithStats(scenario);
  } catch (error) {
    return unavailableJson(
      `GTO 查询失败（已捕获，不影响 Alpha）：${(error as Error).message}`,
      GtoSolveStatus.FAILED,
    );
  }

  const { result, stats } = outcome;
  if ('status' in result) {
    return unavailableJson(result.message, result.cause, stats);
  }

  const metadata = result.metadata;
  /*
   * 🔴 Phase 1.1：状态由**质量等级**决定，不再是一个写死的字符串。
   *
   * 但有一条不会变：GTOpen 的翻前是近似延续模型，因此质量等级的
   * **天花板**是 `APPROXIMATE`（见 `gtoQuality.ts`）。即使收敛达标、
   * 重复求解逐位一致，状态也不会是 `SOLVED`。
   */
  const quality = stats.quality;
  const statusText = quality === GtoQuality.LOW_CONVERGENCE ? 'LOW_CONVERGENCE' : 'APPROXIMATE';
  return {
    ok: true,
    status: statusText,
    cause: null,
    messageZh:
      `数据来源：${metadata.source.engine}` +
      `（commit ${metadata.source.engineCommit ?? '未知'}）。` +
      (metadata.approximation.notConverged
        ? `本次求解**未收敛**（迭代 ${metadata.solveSettings.iterationsCompleted ?? '未知'} 次就停了），频率是当前快照。`
        : `求解器报告 ${describeStopReason(metadata.solveSettings.raw['stopReason'])}，` +
          '但**翻前用的是近似延续模型**。'),
    verificationZh: '近似求解',
    approximate: true,
    approximationNotes: metadata.approximation.notes,
    baseline: result,
    stats,
    quality: {
      level: quality,
      levelZh: GTO_QUALITY_ZH[quality],
      summaryZh: qualitySummaryZhOf(stats, metadata),
      disclaimerZh: qualityDisclaimerZh(quality),
    },
    cache: {
      source: stats.source,
      sourceZh:
        stats.source === 'persistent'
          ? '本地已缓存策略'
          : stats.source === 'memory'
            ? '本进程内存缓存'
            : stats.source === 'solver'
              ? '本次实时求解'
              : '未取得数据',
      cacheKey: stats.cacheKey,
      cachedAt: stats.cachedAt,
      solveDurationMs: stats.solveDurationMs,
    },
    fingerprintLines: fingerprintLinesOf(metadata),
  };
}

/** 把求解器的停止原因翻成中文（**不解释、不美化**） */
function describeStopReason(raw: unknown): string {
  switch (raw) {
    case 'target_reached':
      return '已达到本次设定的收敛目标';
    case 'iteration_limit':
      return '已跑满迭代上限（**未达到**收敛目标）';
    case 'stopped':
      return '被手动停止';
    case 'error':
      return '求解出错';
    default:
      return '结束（原因未提供）';
  }
}

function qualitySummaryZhOf(
  stats: GtoLookupStats,
  metadata: GtoBaseline['metadata'],
): string {
  const gap = metadata.solveSettings.reportedGap;
  const iterations = metadata.solveSettings.iterationsCompleted;
  const target = metadata.solveSettings.targetGap;
  return (
    `${GTO_QUALITY_ZH[stats.quality]}：迭代 ${iterations ?? '未知'} 次` +
    (target === null ? '' : `（目标 gap ${target}）`) +
    `，BR gap 之和 ${gap === null ? '未测' : gap.toFixed(6)}。`
  );
}

function fingerprintLinesOf(metadata: GtoBaseline['metadata']): readonly string[] {
  const raw = metadata.solveSettings.raw;
  const lines = raw['fingerprintLines'];
  if (Array.isArray(lines) && lines.every((l) => typeof l === 'string')) {
    return lines as string[];
  }
  return [];
}

/** 供界面显示：场景哈希（当前查询的唯一标识） */
export function gtoScenarioHashOf(scenario: GtoScenario): string {
  return scenarioHashOf(scenario);
}

/* ============================================================
 * 界面入口：按「目录条目」查询
 * ============================================================ */

export type GtoEntryQueryInput = {
  tableSize: number;
  heroPosition: string;
  template: string;
  effectiveStackBB?: number;
  openSizeBB?: number;
};

/**
 * 按目录条目 id 查询 —— **界面唯一应该使用的入口**。
 *
 * ## 为什么界面必须走目录，而不是自己传场景
 *
 * 界面上「桌人数 + 位置 + 场景」三个下拉框的组合，必须与**后端目录**逐字一致。
 * 如果界面自己拼场景，就会出现「界面显示 5 人桌的 HJ，后端按 6 人桌算」
 * 这类只有名字对得上的错误。走目录意味着：
 *
 * - 界面只能选目录里存在的组合（不存在的那个选项根本不显示）
 * - 前序动作由目录决定（`FOLD_TO_HERO` 之类的模板），界面无法编造
 * - 桌人数是目录的一级维度，**不可能**被位置名顶替
 */
export async function queryGtoCatalogEntry(input: GtoEntryQueryInput): Promise<GtoJsonResponse> {
  const tableSize = gtoTableSizeOf(input.tableSize);
  if (tableSize === null) {
    return unavailableJson(
      `不支持 ${input.tableSize} 人桌。本项目当前验证过的是 4 / 5 / 6 / 8 / 9 人桌 —— ` +
        '不会用相近的人数顶替。',
      GtoSolveStatus.UNSUPPORTED,
    );
  }

  const entries = catalogForTableSize(
    tableSize,
    input.effectiveStackBB ?? 100,
    input.openSizeBB,
  );
  const id = `${tableSize}-${input.heroPosition}-${input.template}`;
  const entry = entries.find((e) => e.id === id);
  if (entry === undefined) {
    return unavailableJson(
      `${tableSize} 人桌的目录里没有「${input.heroPosition} + ${input.template}」这个场景。`,
      GtoSolveStatus.UNSUPPORTED,
    );
  }
  if (entry.scenario === null) {
    return unavailableJson(
      entry.unsupportedReason ?? '该场景在当前规则下无法表达。',
      GtoSolveStatus.UNSUPPORTED,
    );
  }
  return queryGtoScenario(entry.scenario);
}

/** 取一个目录条目的场景（供测试与界面显示哈希用）；不存在返回 `null` */
export function catalogScenarioOf(input: GtoEntryQueryInput): GtoScenario | null {
  const tableSize = gtoTableSizeOf(input.tableSize);
  if (tableSize === null) return null;
  const entries = catalogForTableSize(tableSize, input.effectiveStackBB ?? 100, input.openSizeBB);
  const entry = entries.find(
    (e) => e.id === `${tableSize}-${input.heroPosition}-${input.template}`,
  );
  return entry?.scenario ?? null;
}
