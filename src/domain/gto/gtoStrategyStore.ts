/**
 * 持久化 GTO 策略缓存（**程序重启后仍然可用**）
 *
 * ## 为什么必须持久化
 *
 * 实测（Phase 1）：9 人桌一次求解要 **164 秒**，6 人桌 47 秒。
 * 每次打开页面都重新求解是不可接受的，而内存 Map 缓存一重启就没了。
 *
 * ## 存储形式的选择（为什么不 SQLite）
 *
 * | 方案 | 结论 |
 * |---|---|
 * | SQLite | 本项目**零运行时依赖**（只有 `typescript` + `@types/node`），引入 `better-sqlite3` 会新增一条需要审计的原生依赖链；Node 24 的 `node:sqlite` 仍是实验特性，把它放进验收链会引入不稳定性 |
 * | **JSON 文件（选它）** | 零依赖、可读、可直接进产物清单做 hash 绑定、可人工检查 |
 *
 * 代价是「没有事务」，因此**原子性由写入流程保证**（见下）。
 *
 * ## 🔴 三个必须一起做的机制
 *
 * ### 1. 两级文件：索引 + 载荷
 *
 * 一次命中如果要把 12 个场景的 169×N 频率全部读进来（约 7 MB JSON），
 * 冷启动会很慢。因此拆成：
 *
 * ```
 * data/gto-cache/index.json          每个条目只有 ~1KB 元数据（含 cacheKey）
 * data/gto-cache/strategy/<key>.json 完整载荷（169 类策略，只在命中时读）
 * ```
 *
 * 索引用于**判定命中**，载荷只在真正命中时才读。
 *
 * ### 2. 原子写入：临时文件 → fsync → rename
 *
 * ```
 * 写 <name>.json.tmp  →  fsync  →  fs.renameSync(tmp, final)  →  fsync 目录（尽力）
 * ```
 *
 * `rename` 在同一文件系统内是原子的，因此**不可能**出现
 * 「读到半个文件」的情况 —— 这正是墨菲定律清单第 19 条
 *（「缓存文件部分写入后程序崩溃」）的对策。
 *
 * ### 3. 损坏容忍：坏文件不能带崩 Alpha
 *
 * - 索引损坏 → 视为空索引（记一条警告，**不抛**）
 * - 载荷损坏 → 视为未命中（删掉坏条目，记警告）
 * - 条目结构非法 → 拒绝使用（**不修复、不猜**）
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { GtoBaseline, GtoRange, GtoScenario } from './gto.types.ts';
import { GtoQuality } from './gtoQuality.ts';
import { cacheKeyOf, scenarioHashOf, scenariosEquivalent, solveFingerprintOf, treeIdOf, type GtoSolveKeyParts } from './gtoScenario.ts';

/* ============================================================
 * 条目结构
 * ============================================================ */

/**
 * 缓存条目的**全部**内容。
 *
 * 用户要求的字段逐项对照（§五）：
 * `scenarioHash` ✅ · `engine` ✅ · `engineCommit` ✅ · `solverVersion` ✅ ·
 * `tableSize` ✅ · `effectiveStackBb` ✅ · `positions` ✅ · `actionHistory` ✅ ·
 * `raiseSizes` ✅ · `actionMenu` ✅ · `iterations` ✅ · `BR gap` ✅ ·
 * `solveDuration` ✅ · `approximationFlags` ✅ · `qualityLevel` ✅ ·
 * `createdAt` ✅ · `169 hand strategies` ✅ · `source` ✅
 *
 * 求解器不提供的项一律写 `null` 并带 `unavailableFields` 说明 —— **不编造**。
 */
export type GtoCacheEntry = {
  /** 存储格式版本（改变结构时递增；旧条目会被判为不可用而不是误读） */
  storeVersion: string;
  /** 🔴 缓存键（= 场景哈希 + 求解设置指纹） */
  cacheKey: string;
  /** 场景哈希（只有「问题」，不含求解设置） */
  scenarioHash: string;
  /** 树指纹（只有相同指纹的 gap 才可比较） */
  treeId: string;
  /** 求解设置指纹 */
  solveFingerprint: string;
  /** 我们请求的**规范化**场景 */
  scenario: GtoScenario;
  /** 求解设置（原样保存，用于重建缓存键与审计） */
  solve: GtoSolveKeyParts;
  /** 策略载荷（169 类） */
  range: GtoRange;
  /** 求解侧元数据 */
  solveMeta: {
    /** 求解器报告的 BR gap 之和 */
    brGapTotal: number | null;
    /** 逐座位 gap（求解器原文） */
    seatGaps: readonly number[];
    /** 逐座位 EV（求解器原文，bb/hand） */
    seatEvs: readonly number[];
    /** 停止原因 */
    stopReason: string | null;
    /** 求解器 state */
    solverState: string | null;
    /** 实际迭代数 */
    iterationsCompleted: number | null;
    /** 请求的迭代数 */
    iterationsRequested: number | null;
    /** 收敛目标 */
    targetGap: number | null;
    /** 求解耗时（毫秒） */
    solveDurationMs: number;
    /** 求解器自述的多人权益模型 */
    multiwayEquityModel: string | null;
    /** 求解器自述的 realization 说明（可能为空串） */
    realizationNote: string | null;
    /** 是否走 GPU（本项目恒 false） */
    gpu: boolean;
  };
  /** 质量等级 */
  quality: GtoQuality;
  /** 质量判定的一句话中文结论 */
  qualitySummaryZh: string;
  /** 质量判定的逐条理由 */
  qualityReasonsZh: readonly string[];
  /** 阻止等级上升的原因 */
  qualityBlockersZh: readonly string[];
  /** 近似标记（结构化） */
  approximationFlags: {
    approximateModel: boolean;
    notConverged: boolean;
    multiwayContinuation: boolean;
    compressedPrecision: boolean;
    fromCache: boolean;
    notes: readonly string[];
  };
  /** 来源 */
  source: {
    kind: 'SOLVER';
    engine: string;
    engineCommit: string | null;
    solverVersion: string | null;
    endpoint: string | null;
  };
  /** 写入时间（ISO 8601） */
  createdAt: string;
  /** 可读的场景指纹（报告与界面用） */
  fingerprintLines: readonly string[];
  /**
   * 求解器**没有提供**的字段清单。
   *
   * 用途：让「这里是 null」与「这里求解器没给」区分开。
   * 例：`['evBB（逐动作 EV，求解器翻前节点接口不返回）', 'sourceVersion（GTOpen 无版本端点）']`
   */
  unavailableFields: readonly string[];
};

/** 索引条目（轻量，用于命中判定） */
export type GtoCacheIndexEntry = {
  cacheKey: string;
  scenarioHash: string;
  treeId: string;
  quality: GtoQuality;
  engine: string;
  engineCommit: string | null;
  tableSize: number;
  effectiveStackBB: number;
  heroPosition: string;
  kind: string;
  createdAt: string;
  /** 载荷字节数（便于报告） */
  payloadBytes: number;
  /** 一句话中文场景描述 */
  scenarioZh: string;
  /** 质量一句话 */
  qualityZh: string;
};

export type GtoCacheIndexFile = {
  storeVersion: string;
  updatedAt: string;
  /** 写入次数（用于「写坏了没有」的粗粒度观察） */
  writes: number;
  entries: GtoCacheIndexEntry[];
};

/* ============================================================
 * 常量与校验
 * ============================================================ */

export const GTO_STORE_VERSION = 'gto-strategy-store-v1';

/** 默认目录（相对项目根的 `data/`，与项目既有约定一致） */
export const DEFAULT_GTO_CACHE_DIR = 'data/gto-cache';

/** 低频次缓存质量下限：低于这个等级**仍然保存**（用户要求低质量允许保存），但必须带等级 */
export const GTO_CACHE_MIN_QUALITY_TO_STORE = GtoQuality.LOW_CONVERGENCE;

/** 索引文件名 */
const INDEX_FILE = 'index.json';

/** 载荷子目录 */
const PAYLOAD_DIR = 'strategy';

/* ============================================================
 * 校验（§二十三 数据一致性校验）
 * ============================================================ */

export type GtoCacheValidationIssue = { code: string; message: string };

/**
 * 校验一份载荷是否自洽。
 *
 * 检查项（用户 §二十三 逐条）：
 * 频率 ∈ [0,1] · 每手频率和 ≈ 1 · 169 类存在 · 无重复 hand ·
 * 无 NaN/Infinity · 无 undefined action · 位置合法 · 桌人数合法 · 筹码合法
 *
 * @returns 问题列表（空 = 通过）
 */
export function validateCachedRange(
  range: unknown,
  expectedTableSize?: number,
  expectedStackBB?: number,
): GtoCacheValidationIssue[] {
  const issues: GtoCacheValidationIssue[] = [];
  if (range === null || typeof range !== 'object') {
    return [{ code: 'NOT_OBJECT', message: '载荷不是一个对象' }];
  }
  const r = range as Partial<GtoRange>;

  if (expectedTableSize !== undefined && typeof expectedTableSize === 'number') {
    if (![4, 5, 6, 8, 9].includes(expectedTableSize)) {
      issues.push({ code: 'BAD_TABLE_SIZE', message: `桌人数非法：${expectedTableSize}` });
    }
  }
  if (expectedStackBB !== undefined && typeof expectedStackBB === 'number') {
    if (!Number.isFinite(expectedStackBB) || expectedStackBB <= 0) {
      issues.push({ code: 'BAD_STACK', message: `有效筹码非法：${expectedStackBB}` });
    }
  }

  if (!Array.isArray(r.hands)) {
    issues.push({ code: 'NO_HANDS', message: '缺少 hands 数组' });
    return issues;
  }
  if (r.hands.length !== 169) {
    issues.push({ code: 'HAND_COUNT', message: `手牌类数应为 169，实际 ${r.hands.length}` });
  }

  const seen = new Set<string>();
  for (const hand of r.hands) {
    if (hand === null || typeof hand !== 'object') {
      issues.push({ code: 'BAD_HAND', message: '存在非对象的手牌条目' });
      continue;
    }
    const h = hand as Partial<GtoRange['hands'][number]>;
    if (typeof h.hand !== 'string' || h.hand.length === 0) {
      issues.push({ code: 'BAD_HAND_CODE', message: '手牌缺少 code' });
      continue;
    }
    if (seen.has(h.hand)) {
      issues.push({ code: 'DUPLICATE_HAND', message: `手牌重复：${h.hand}` });
    }
    seen.add(h.hand);
    if (typeof h.combos !== 'number' || !Number.isFinite(h.combos) || h.combos <= 0) {
      issues.push({ code: 'BAD_COMBOS', message: `${h.hand} 的组合数非法：${String(h.combos)}` });
    }
    if (h.reach !== null && h.reach !== undefined) {
      if (typeof h.reach !== 'number' || !Number.isFinite(h.reach) || h.reach < 0 || h.reach > 1) {
        issues.push({ code: 'BAD_REACH', message: `${h.hand} 的 reach 非法：${String(h.reach)}` });
      }
    }
    if (!Array.isArray(h.actions)) {
      issues.push({ code: 'NO_ACTIONS', message: `${h.hand} 缺少 actions` });
      continue;
    }
    let sum = 0;
    for (const action of h.actions) {
      if (action === null || typeof action !== 'object') {
        issues.push({ code: 'UNDEFINED_ACTION', message: `${h.hand} 存在非对象的动作` });
        continue;
      }
      const a = action as Partial<GtoRange['hands'][number]['actions'][number]>;
      if (typeof a.kind !== 'string' || !/^(FOLD|CHECK|CALL|BET|RAISE|ALL_IN)$/.test(a.kind)) {
        issues.push({
          code: 'BAD_ACTION_KIND',
          message: `${h.hand} 的动作类别非法：${String(a.kind)}`,
        });
      }
      if (a.sizeBB !== null && a.sizeBB !== undefined) {
        if (typeof a.sizeBB !== 'number' || !Number.isFinite(a.sizeBB) || a.sizeBB <= 0) {
          issues.push({ code: 'BAD_ACTION_SIZE', message: `${h.hand} 的动作尺寸非法：${String(a.sizeBB)}` });
        }
      }
      if (typeof a.frequency !== 'number' || !Number.isFinite(a.frequency)) {
        issues.push({
          code: 'NAN_FREQUENCY',
          message: `${h.hand} 的频率不是有限数：${String(a.frequency)}（NaN / Infinity 一律拒收）`,
        });
        continue;
      }
      if (a.frequency < 0 || a.frequency > 1) {
        issues.push({
          code: 'FREQUENCY_RANGE',
          message: `${h.hand} 的频率越界：${a.frequency}（必须在 0..1）`,
        });
        continue;
      }
      sum += a.frequency;
    }
    if (h.actions.length > 0 && Math.abs(sum - 1) > 1e-6) {
      issues.push({
        code: 'FREQUENCY_SUM',
        message: `${h.hand} 的动作频率之和为 ${sum}（应为 1）`,
      });
    }
  }

  if (typeof r.actorPosition !== 'string' || !/^(UTG|UTG1|UTG2|LJ|HJ|CO|BTN|SB|BB)$/.test(r.actorPosition)) {
    issues.push({ code: 'BAD_POSITION', message: `行动者位置非法：${String(r.actorPosition)}` });
  }
  if (r.potBB !== null && r.potBB !== undefined) {
    if (typeof r.potBB !== 'number' || !Number.isFinite(r.potBB) || r.potBB < 0) {
      issues.push({ code: 'BAD_POT', message: `底池非法：${String(r.potBB)}` });
    }
  }

  return issues;
}

/* ============================================================
 * Store
 * ============================================================ */

export type GtoStrategyStoreOptions = {
  /** 缓存根目录（相对项目根或绝对路径） */
  dir?: string;
  /** 项目根（用于把相对 dir 变成绝对路径） */
  projectRoot?: string;
  /** 注入的时钟 */
  now?: () => number;
  /** 是否允许写盘；`false` = 只读模式（测试 / 诊断） */
  readOnly?: boolean;
};

export type GtoStoreLoadResult =
  | { found: true; entry: GtoCacheEntry; source: 'persistent' }
  | { found: false; reason: 'miss' | 'corrupt' | 'invalid' | 'stale'; detail?: string };

export type GtoStoreWriteResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: string };

/**
 * 持久化策略缓存。
 *
 * **所有方法都不抛异常**：缓存是加速手段，不是真相来源；
 * 缓存坏了应该退化成「重新求解」，而不是让 Alpha 崩掉
 *（墨菲定律第 20 条：corrupt cache 读取后导致 Alpha 崩溃）。
 */
export class GtoStrategyStore {
  readonly dir: string;
  private readonly now: () => number;
  private readonly readOnly: boolean;
  private indexCache: GtoCacheIndexFile | null = null;
  /** 读写过程中攒下的警告（供报告与诊断；不抛异常） */
  readonly warnings: string[] = [];

  constructor(options: GtoStrategyStoreOptions = {}) {
    const root = options.projectRoot ?? process.cwd();
    const dir = options.dir ?? DEFAULT_GTO_CACHE_DIR;
    this.dir = dir.startsWith('/') || /^[A-Za-z]:/.test(dir) ? dir : join(root, dir);
    this.now = options.now ?? (() => Date.now());
    this.readOnly = options.readOnly ?? false;
  }

  get indexPath(): string {
    return join(this.dir, INDEX_FILE);
  }

  payloadPath(cacheKey: string): string {
    // cacheKey 只含 [a-z0-9]，因此不需要再做路径转义；仍然校验一次，
    // 防止将来有人把别的字符串传进来造成路径穿越。
    const safe = /^[a-z0-9]+$/.test(cacheKey) ? cacheKey : `unsafe-${Buffer.from(cacheKey).toString('hex')}`;
    return join(this.dir, PAYLOAD_DIR, `${safe}.json`);
  }

  /** 读取索引（带内存缓存；损坏时退化为空索引） */
  loadIndex(): GtoCacheIndexFile {
    if (this.indexCache !== null) return this.indexCache;
    if (!existsSync(this.indexPath)) {
      this.indexCache = emptyIndex(this.now());
      return this.indexCache;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.indexPath, 'utf8'));
      const checked = parseIndexFile(parsed);
      if (checked === null) {
        this.warnings.push(`缓存索引结构非法，已视为空索引：${this.indexPath}`);
        this.indexCache = emptyIndex(this.now());
      } else {
        this.indexCache = checked;
      }
    } catch (error) {
      this.warnings.push(
        `缓存索引读取失败（已视为空索引，不影响 Alpha）：${(error as Error).message}`,
      );
      this.indexCache = emptyIndex(this.now());
    }
    return this.indexCache;
  }

  /** 列出索引条目（供报告与预计算脚本使用） */
  listEntries(): readonly GtoCacheIndexEntry[] {
    return this.loadIndex().entries;
  }

  /** 按缓存键查找（**只查索引，不读载荷**） */
  has(cacheKey: string): boolean {
    return this.loadIndex().entries.some((e) => e.cacheKey === cacheKey);
  }

  /**
   * 读取一个条目。
   *
   * ## 三道检查（缺一不可）
   *
   * 1. **索引里有这个键吗**（未命中 → `miss`）
   * 2. **载荷能解析且结构合法吗**（坏了 → `corrupt`，并删掉坏条目）
   * 3. **条目里的键/哈希与请求一致吗**（不一致 → `invalid`）
   *
   * 第 3 道是防「索引与载荷不同步」：如果只有第 1 道，
   * 一个被错误改写的索引会让我们把**别的场景**的策略当成这次的答案。
   */
  load(
    cacheKey: string,
    expected?: { scenarioHash?: string; treeId?: string; scenario?: GtoScenario },
  ): GtoStoreLoadResult {
    const index = this.loadIndex();
    const entry = index.entries.find((e) => e.cacheKey === cacheKey);
    if (entry === undefined) return { found: false, reason: 'miss' };

    const path = this.payloadPath(cacheKey);
    if (!existsSync(path)) {
      this.warnings.push(`索引里有 ${cacheKey} 但载荷文件不存在（${path}）—— 视为未命中`);
      this.removeEntry(cacheKey);
      return { found: false, reason: 'corrupt', detail: '载荷文件缺失' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      this.warnings.push(`载荷文件损坏（${cacheKey}）：${(error as Error).message} —— 已删除该条目`);
      this.removeEntry(cacheKey);
      return { found: false, reason: 'corrupt', detail: (error as Error).message };
    }

    const checked = parseCacheEntry(parsed);
    if (checked === null) {
      this.warnings.push(`载荷结构非法（${cacheKey}）—— 已删除该条目`);
      this.removeEntry(cacheKey);
      return { found: false, reason: 'invalid', detail: '结构非法' };
    }

    if (checked.cacheKey !== cacheKey) {
      this.warnings.push(
        `载荷里的缓存键（${checked.cacheKey}）与请求的（${cacheKey}）不一致 —— 拒绝使用`,
      );
      return { found: false, reason: 'invalid', detail: '缓存键不一致' };
    }
    if (expected?.scenarioHash !== undefined && checked.scenarioHash !== expected.scenarioHash) {
      return { found: false, reason: 'invalid', detail: '场景哈希不一致' };
    }
    if (expected?.treeId !== undefined && checked.treeId !== expected.treeId) {
      return { found: false, reason: 'invalid', detail: '树指纹不一致' };
    }
    /*
     * 🔴 **第三道：逐字段比对规范化场景**（CACHE KEY GOLDEN VECTOR 轮 · 使用者 §10）。
     *
     * 前两道比的是**哈希字符串**。哈希是 32 位非密码学折叠 —— 不能声称不会碰撞，
     * 因此只要调用方给了原场景，就必须做一次**逐字段**比对：
     *
     * | 情形 | 行为 |
     * |---|---|
     * | 场景逐字段相同 | 命中（这才是「同一个问题」的定义） |
     * | 哈希相同但字段不同 | **拒绝命中** + 记警告 —— 这就是碰撞，绝不能静默复用 |
     *
     * 条目里存着完整的 `scenario` 正是为了这件事（写入时保存的是规范化场景）。
     */
    if (expected?.scenario !== undefined && !scenariosEquivalent(checked.scenario, expected.scenario)) {
      this.warnings.push(
        `缓存键 ${cacheKey} 命中了一个**场景不同**的条目（哈希碰撞或索引被改写）—— 已拒绝使用`,
      );
      return { found: false, reason: 'invalid', detail: '规范化场景逐字段比对不一致' };
    }

    const issues = validateCachedRange(checked.range);
    if (issues.length > 0) {
      return {
        found: false,
        reason: 'invalid',
        detail: `载荷未通过一致性校验：${issues.slice(0, 3).map((i) => i.code).join('、')}`,
      };
    }

    return { found: true, entry: checked, source: 'persistent' };
  }

  /**
   * 写入一个条目（**原子**）。
   *
   * 顺序：`temp write → fsync → rename → 更新索引`。
   * 任何一步失败都不影响已有缓存，也不会留下半个文件。
   */
  save(entry: GtoCacheEntry): GtoStoreWriteResult {
    if (this.readOnly) return { ok: false, reason: '缓存处于只读模式' };

    const issues = validateCachedRange(entry.range);
    if (issues.length > 0 && entry.quality !== GtoQuality.LOW_CONVERGENCE) {
      // 结构坏了就不写 —— 宁可重新求解，也不往缓存里放一份自相矛盾的数据。
      // 注意：**不**因为「质量低」而拒绝写入（用户明确要求低质量也允许保存，
      // 只要保留 qualityLevel）。这里拒绝的是「结构非法」。
      return {
        ok: false,
        reason: `载荷未通过一致性校验，拒绝写入：${issues.slice(0, 3).map((i) => i.message).join('；')}`,
      };
    }

    const payload = JSON.stringify(entry, null, 2);
    const bytes = Buffer.byteLength(payload, 'utf8');
    const path = this.payloadPath(entry.cacheKey);

    try {
      mkdirSync(dirname(path), { recursive: true });
      atomicWrite(path, payload);
    } catch (error) {
      return { ok: false, reason: `载荷写入失败：${(error as Error).message}` };
    }

    const index = this.loadIndex();
    const next: GtoCacheIndexFile = {
      storeVersion: GTO_STORE_VERSION,
      updatedAt: new Date(this.now()).toISOString(),
      writes: index.writes + 1,
      entries: [
        ...index.entries.filter((e) => e.cacheKey !== entry.cacheKey),
        {
          cacheKey: entry.cacheKey,
          scenarioHash: entry.scenarioHash,
          treeId: entry.treeId,
          quality: entry.quality,
          engine: entry.source.engine,
          engineCommit: entry.source.engineCommit,
          tableSize: entry.scenario.tableSize,
          effectiveStackBB: entry.scenario.effectiveStackBB,
          heroPosition: entry.scenario.heroPosition,
          kind: entry.scenario.kind,
          createdAt: entry.createdAt,
          payloadBytes: bytes,
          scenarioZh: describeEntryZh(entry),
          qualityZh: entry.qualitySummaryZh,
        },
      ],
    };

    try {
      atomicWrite(this.indexPath, JSON.stringify(next, null, 2));
      this.indexCache = next;
    } catch (error) {
      // 载荷已写好但索引没更新 → 该条目「不可见」，等价于未命中。
      // 这是**安全**的失败方向（宁可重算，不要错读）。
      return { ok: false, reason: `索引写入失败（载荷已落盘但不会命中）：${(error as Error).message}` };
    }

    return { ok: true, bytes };
  }

  /** 删除一个条目（索引 + 载荷） */
  removeEntry(cacheKey: string): void {
    const index = this.loadIndex();
    if (!index.entries.some((e) => e.cacheKey === cacheKey)) return;
    const next: GtoCacheIndexFile = {
      ...index,
      updatedAt: new Date(this.now()).toISOString(),
      writes: index.writes + 1,
      entries: index.entries.filter((e) => e.cacheKey !== cacheKey),
    };
    try {
      if (!this.readOnly) {
        atomicWrite(this.indexPath, JSON.stringify(next, null, 2));
        rmSync(this.payloadPath(cacheKey), { force: true });
      }
    } catch (error) {
      this.warnings.push(`删除缓存条目失败：${(error as Error).message}`);
    }
    this.indexCache = next;
  }

  /** 清空（测试与维护用） */
  clear(): void {
    for (const entry of [...this.loadIndex().entries]) this.removeEntry(entry.cacheKey);
    this.indexCache = emptyIndex(this.now());
    if (!this.readOnly) {
      try {
        atomicWrite(this.indexPath, JSON.stringify(this.indexCache, null, 2));
      } catch (error) {
        this.warnings.push(`清空索引失败：${(error as Error).message}`);
      }
    }
  }

  /** 命中统计（供报告） */
  stats(): {
    entries: number;
    byQuality: Record<string, number>;
    byTableSize: Record<string, number>;
    totalPayloadBytes: number;
  } {
    const entries = this.loadIndex().entries;
    const byQuality: Record<string, number> = {};
    const byTableSize: Record<string, number> = {};
    let bytes = 0;
    for (const e of entries) {
      byQuality[e.quality] = (byQuality[e.quality] ?? 0) + 1;
      byTableSize[String(e.tableSize)] = (byTableSize[String(e.tableSize)] ?? 0) + 1;
      bytes += e.payloadBytes;
    }
    return { entries: entries.length, byQuality, byTableSize, totalPayloadBytes: bytes };
  }
}

/* ============================================================
 * 由 baseline 构造条目
 * ============================================================ */

export type BuildCacheEntryInput = {
  cacheKey: string;
  treeId: string;
  scenario: GtoScenario;
  solve: GtoSolveKeyParts;
  baseline: GtoBaseline;
  solveMeta: GtoCacheEntry['solveMeta'];
  quality: GtoQuality;
  qualitySummaryZh: string;
  qualityReasonsZh: readonly string[];
  qualityBlockersZh: readonly string[];
  fingerprintLines: readonly string[];
  endpoint: string | null;
  unavailableFields: readonly string[];
  now: () => number;
};

/**
 * 把一次成功的查询结果变成缓存条目。
 *
 * ⚠️ 这个函数**只做组装**，不做判定：质量等级、缓存键、树指纹都由调用方
 * 算好传进来。这样「缓存里存了什么」与「上层判定了什么」永远一致 ——
 * 不会出现「界面显示 USABLE、缓存里写的是 APPROXIMATE」这种分裂。
 */
export function buildCacheEntry(input: BuildCacheEntryInput): GtoCacheEntry {
  const meta = input.baseline.metadata;
  return {
    storeVersion: GTO_STORE_VERSION,
    cacheKey: input.cacheKey,
    scenarioHash: input.baseline.scenarioHash,
    treeId: input.treeId,
    solveFingerprint: solveFingerprintOf(input.solve),
    scenario: input.baseline.scenario,
    solve: input.solve,
    range: input.baseline.range,
    solveMeta: input.solveMeta,
    quality: input.quality,
    qualitySummaryZh: input.qualitySummaryZh,
    qualityReasonsZh: [...input.qualityReasonsZh],
    qualityBlockersZh: [...input.qualityBlockersZh],
    approximationFlags: {
      approximateModel: meta.approximation.approximateModel,
      notConverged: meta.approximation.notConverged,
      multiwayContinuation: meta.approximation.multiwayContinuation,
      compressedPrecision: meta.approximation.compressedPrecision,
      fromCache: false,
      notes: [...meta.approximation.notes],
    },
    source: {
      kind: 'SOLVER',
      engine: meta.source.engine,
      engineCommit: meta.source.engineCommit,
      solverVersion: meta.source.sourceVersion,
      endpoint: input.endpoint,
    },
    createdAt: new Date(input.now()).toISOString(),
    fingerprintLines: [...input.fingerprintLines],
    unavailableFields: [...input.unavailableFields],
  };
}

/** 由条目重建一个 `GtoBaseline`（**打上 fromCache 标记**） */
export function baselineFromCacheEntry(
  entry: GtoCacheEntry,
  now: () => number,
): GtoBaseline {
  return {
    scenario: entry.scenario,
    scenarioHash: entry.scenarioHash,
    range: entry.range,
    metadata: {
      source: {
        kind: 'SOLVER',
        engine: entry.source.engine,
        sourceVersion: entry.source.solverVersion,
        engineCommit: entry.source.engineCommit,
        endpoint: entry.source.endpoint,
      },
      scenarioHash: entry.scenarioHash,
      solveSettings: {
        iterationsRequested: entry.solveMeta.iterationsRequested,
        iterationsCompleted: entry.solveMeta.iterationsCompleted,
        targetGap: entry.solveMeta.targetGap,
        reportedGap: entry.solveMeta.brGapTotal,
        modelName: entry.solveMeta.multiwayEquityModel,
        raw: Object.freeze({
          fromCache: true,
          cacheKey: entry.cacheKey,
          treeId: entry.treeId,
          quality: entry.quality,
          seatGaps: entry.solveMeta.seatGaps,
          seatEvs: entry.solveMeta.seatEvs,
          stopReason: entry.solveMeta.stopReason,
          solverState: entry.solveMeta.solverState,
          solveDurationMs: entry.solveMeta.solveDurationMs,
          createdAt: entry.createdAt,
        }),
      },
      solveStatus: 'SOLVED',
      verification: 'APPROXIMATE',
      approximation: {
        approximateModel: entry.approximationFlags.approximateModel,
        notConverged: entry.approximationFlags.notConverged,
        multiwayContinuation: entry.approximationFlags.multiwayContinuation,
        compressedPrecision: entry.approximationFlags.compressedPrecision,
        fromCache: true,
        notes: [
          ...entry.approximationFlags.notes,
          `本结果来自**本地已缓存策略**（写入于 ${entry.createdAt}），不是本次重新求解。` +
            `质量等级：${entry.quality}；缓存键 ${entry.cacheKey}。`,
        ],
      },
      timestamp: new Date(now()).toISOString(),
      latencyMs: 0,
    },
  };
}

/* ============================================================
 * 内部工具
 * ============================================================ */

function emptyIndex(nowMs: number): GtoCacheIndexFile {
  return {
    storeVersion: GTO_STORE_VERSION,
    updatedAt: new Date(nowMs).toISOString(),
    writes: 0,
    entries: [],
  };
}

/**
 * 原子写入：临时文件 → fsync → rename。
 *
 * 为什么必须 fsync：`rename` 只保证「目录项切换是原子的」，
 * 不保证数据已经落盘。断电时可能出现「目录项指向一个内容为空的文件」。
 * 先 fsync 文件内容再 rename，才能让「要么是旧的完整文件、要么是新的完整文件」成立。
 */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function parseIndexFile(value: unknown): GtoCacheIndexFile | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Partial<GtoCacheIndexFile>;
  if (typeof v.storeVersion !== 'string') return null;
  if (!Array.isArray(v.entries)) return null;
  const entries: GtoCacheIndexEntry[] = [];
  for (const raw of v.entries) {
    if (raw === null || typeof raw !== 'object') continue;
    const e = raw as Partial<GtoCacheIndexEntry>;
    if (typeof e.cacheKey !== 'string' || typeof e.scenarioHash !== 'string') continue;
    entries.push({
      cacheKey: e.cacheKey,
      scenarioHash: e.scenarioHash,
      treeId: typeof e.treeId === 'string' ? e.treeId : '',
      quality: (typeof e.quality === 'string' ? e.quality : GtoQuality.UNAVAILABLE) as GtoQuality,
      engine: typeof e.engine === 'string' ? e.engine : '',
      engineCommit: typeof e.engineCommit === 'string' ? e.engineCommit : null,
      tableSize: typeof e.tableSize === 'number' ? e.tableSize : 0,
      effectiveStackBB: typeof e.effectiveStackBB === 'number' ? e.effectiveStackBB : 0,
      heroPosition: typeof e.heroPosition === 'string' ? e.heroPosition : '',
      kind: typeof e.kind === 'string' ? e.kind : '',
      createdAt: typeof e.createdAt === 'string' ? e.createdAt : '',
      payloadBytes: typeof e.payloadBytes === 'number' ? e.payloadBytes : 0,
      scenarioZh: typeof e.scenarioZh === 'string' ? e.scenarioZh : '',
      qualityZh: typeof e.qualityZh === 'string' ? e.qualityZh : '',
    });
  }
  return {
    storeVersion: v.storeVersion,
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
    writes: typeof v.writes === 'number' ? v.writes : 0,
    entries,
  };
}

function parseCacheEntry(value: unknown): GtoCacheEntry | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Partial<GtoCacheEntry>;
  if (typeof v.storeVersion !== 'string') return null;
  if (typeof v.cacheKey !== 'string' || typeof v.scenarioHash !== 'string') return null;
  if (typeof v.treeId !== 'string') return null;
  if (v.scenario === null || typeof v.scenario !== 'object') return null;
  if (v.range === null || typeof v.range !== 'object') return null;
  if (v.solve === null || typeof v.solve !== 'object') return null;
  if (v.solveMeta === null || typeof v.solveMeta !== 'object') return null;
  if (typeof v.quality !== 'string') return null;
  if (v.source === null || typeof v.source !== 'object') return null;
  if (typeof v.createdAt !== 'string') return null;
  /*
   * 🔴 **内部一致性**：`solve`（键的输入）与 `solveMeta`（结果）里的
   * 同一项必须一致。
   *
   * 这一条来自一个**真实踩到的问题**：一条由旧代码写入的条目里
   * `solveMeta.targetGap = 0`（旧版没记目标），而当前代码的键算出来是 0.1。
   * 于是它被当成「当前配置的结果」命中，但元数据自相矛盾 ——
   * 质量评级读到 `targetGap = 0` 就判成「未设收敛目标」⇒ 永远 LOW。
   *
   * 让这种条目在**解析阶段**就被拒绝，比让它在评级阶段表现异常要好：
   * 前者是明确的「这条缓存不可用，重算」，后者是难以诊断的错误等级。
   */
  if (v.solveMeta.targetGap !== v.solve.targetGap) return null;
  if (v.solveMeta.iterationsRequested !== v.solve.iterations) return null;
  // 逐字段补齐可选数组，避免下游读到 undefined 而不是空数组
  return {
    ...(v as GtoCacheEntry),
    qualityReasonsZh: Array.isArray(v.qualityReasonsZh) ? v.qualityReasonsZh : [],
    qualityBlockersZh: Array.isArray(v.qualityBlockersZh) ? v.qualityBlockersZh : [],
    fingerprintLines: Array.isArray(v.fingerprintLines) ? v.fingerprintLines : [],
    unavailableFields: Array.isArray(v.unavailableFields) ? v.unavailableFields : [],
    approximationFlags: {
      approximateModel: v.approximationFlags?.approximateModel === true,
      notConverged: v.approximationFlags?.notConverged === true,
      multiwayContinuation: v.approximationFlags?.multiwayContinuation === true,
      compressedPrecision: v.approximationFlags?.compressedPrecision === true,
      fromCache: false,
      notes: Array.isArray(v.approximationFlags?.notes) ? v.approximationFlags!.notes : [],
    },
    solveMeta: {
      ...(v.solveMeta as GtoCacheEntry['solveMeta']),
      seatGaps: Array.isArray(v.solveMeta.seatGaps) ? v.solveMeta.seatGaps : [],
      seatEvs: Array.isArray(v.solveMeta.seatEvs) ? v.solveMeta.seatEvs : [],
    },
  };
}

function describeEntryZh(entry: GtoCacheEntry): string {
  const s = entry.scenario;
  return (
    `${s.tableSize}MAX / ${s.effectiveStackBB}BB / ${s.heroPosition} / ${s.kind}` +
    (s.actionHistory.length === 0 ? ' / 无人入池' : ` / ${s.actionHistory.length} 条前序动作`)
  );
}

/** 便捷：由场景 + 求解设置算出三把键（避免各处重复拼装） */
export function keysOf(
  scenario: GtoScenario,
  solve: GtoSolveKeyParts,
): { scenarioHash: string; treeId: string; cacheKey: string; solveFingerprint: string } {
  return {
    scenarioHash: scenarioHashOf(scenario),
    treeId: treeIdOf(scenario, {
      openSizesBB: solve.openSizesBB,
      raiseMults: solve.raiseMults,
      maxRaises: solve.maxRaises,
      limp: solve.limp,
      addAllin: solve.addAllin,
      engine: solve.engine,
    }),
    cacheKey: cacheKeyOf(scenario, solve),
    solveFingerprint: solveFingerprintOf(solve),
  };
}

/** 自检 */
export function selfCheckStoreLayer(): string[] {
  const problems: string[] = [];
  // 校验器必须能抓到坏数据
  const badRange = {
    actorPosition: 'UTG',
    actionMenu: [],
    hands: [
      { hand: 'AA', combos: 6, reach: 1, actions: [{ kind: 'RAISE', sizeBB: 2.5, frequency: 1.5, evBB: null, rawLabel: 'x' }] },
      { hand: 'AA', combos: 6, reach: 1, actions: [{ kind: 'FOLD', sizeBB: null, frequency: 1, evBB: null, rawLabel: 'y' }] },
    ],
    potBB: 1.5,
    reachable: true,
    unavailableReason: null,
  };
  const issues = validateCachedRange(badRange);
  const codes = new Set(issues.map((i) => i.code));
  for (const expected of ['HAND_COUNT', 'DUPLICATE_HAND', 'FREQUENCY_RANGE'] as const) {
    if (!codes.has(expected)) problems.push(`校验器未抓到 ${expected}`);
  }
  if (parseIndexFile({ nope: true }) !== null) problems.push('索引解析器接受了非法结构');
  if (parseCacheEntry({ nope: true }) !== null) problems.push('条目解析器接受了非法结构');
  return problems;
}
