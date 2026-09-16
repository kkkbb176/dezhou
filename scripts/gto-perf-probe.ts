/**
 * 冷求解 vs 热缓存读取性能实测（Phase 1.1 §十七）
 *
 * ## 为什么必须实测而不是推理
 *
 * 用户的目标是「第二次读同一场景 < 500ms，最好 < 100ms」。
 * 这个目标能不能达到，取决于**缓存读取路径**的实际开销
 *（读索引 → 找键 → 读载荷 → JSON 解析 → 结构校验 → 重建 baseline），
 * 而 JSON 解析 7 MB 级别的载荷在 Node 里可能需要几十毫秒。
 * 猜不出来，必须量。
 *
 * ## 方法
 *
 * 对每个场景：
 * 1. **冷**：先清空该条目的缓存（保证真的要建树 + 求解），计时；
 * 2. **热（持久化）**：新建一个 `GtoSafeLookup`（内存缓存为空，
 *    模拟进程重启），计时；
 * 3. **热（内存）**：同一个 `GtoSafeLookup` 再查一次，计时。
 *
 * 用法：
 *   node --experimental-strip-types scripts/gto-perf-probe.ts [size...]
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildGtoScenario, cacheKeyOf, scenarioHashOf } from '../src/domain/gto/gtoScenario.ts';
import { GtoScenarioKind, gtoPositionsFor, type GtoTableSize } from '../src/domain/gto/gto.types.ts';
import { GTOPEN_DEFAULT_BUDGET, GtopenProvider } from '../src/domain/gto/providers/gtopenProvider.ts';
import { GtoHttpClient } from '../src/domain/gto/providers/gtopenHttpClient.ts';
import { GtoSafeLookup } from '../src/domain/gto/gtoSafeLookup.ts';
import { GtoStrategyStore, DEFAULT_GTO_CACHE_DIR } from '../src/domain/gto/gtoStrategyStore.ts';

const EVIDENCE_DIR = fileURLToPath(new URL('../reports/evidence/', import.meta.url));
mkdirSync(EVIDENCE_DIR, { recursive: true });
const EVIDENCE_FILE = `${EVIDENCE_DIR}gto-perf-evidence.txt`;

const lines: string[] = [];
function emit(line: string): void {
  console.log(line);
  lines.push(line);
  writeFileSync(EVIDENCE_FILE, `${lines.join('\n')}\n`, 'utf8');
}

const baseUrl = process.env['GTOPEN_URL'] ?? 'http://127.0.0.1:3737';
const cacheDir = process.env['ALPHA_GTO_CACHE_DIR'] ?? DEFAULT_GTO_CACHE_DIR;

function makeLookup(): GtoSafeLookup {
  const provider = new GtopenProvider({
    baseUrl,
    client: new GtoHttpClient({ baseUrl }),
    budget: {
      ...GTOPEN_DEFAULT_BUDGET,
      solveWaitMs: Number(process.env['GTO_WAIT_MS'] ?? 1_500_000),
    },
  });
  return new GtoSafeLookup(provider, {
    hardTimeoutMs: 10 * 60 * 1000,
    storeOptions: { dir: cacheDir },
  });
}

function firstIn(size: GtoTableSize) {
  const hero = gtoPositionsFor(size)[0]!;
  const s = buildGtoScenario({
    kind: GtoScenarioKind.RFI,
    tableSize: size,
    effectiveStackBB: 100,
    heroPosition: hero,
    actionHistory: [],
  });
  if (s === null) throw new Error(`无法构造 ${size}MAX 场景`);
  return s;
}

const requested = process.argv.slice(2).map(Number) as GtoTableSize[];
const sizes: GtoTableSize[] = requested.length > 0 ? requested : [4, 6, 9];

emit('================================================================');
emit('GTO 冷求解 vs 热缓存性能实测（Phase 1.1）');
emit(`生成时间 : ${new Date().toISOString()}`);
emit(`端点     : ${baseUrl}`);
emit(`缓存目录 : ${cacheDir}`);
emit(`目标     : 热读 < 500ms（尽力 < 100ms）—— **但不为此牺牲正确性**`);
emit('================================================================');
emit('');

type Row = {
  size: number;
  coldMs: number | null;
  warmPersistentMs: number;
  warmMemoryMs: number;
  payloadBytes: number;
};

const rows: Row[] = [];

for (const size of sizes) {
  const scenario = firstIn(size);
  const lookup0 = makeLookup();
  const key = cacheKeyOf(scenario, lookup0.providerSolveKeyParts(scenario));

  emit(`=== ${size}MAX / 100BB / ${scenario.heroPosition} / RFI`);
  emit(`    场景哈希 ${scenarioHashOf(scenario)} · 缓存键 ${key}`);

  // ---- 清掉该条目，制造「冷」 ----
  const store = new GtoStrategyStore({ dir: cacheDir });
  const existed = store.has(key);
  // ⚠️ 载荷大小必须在删除**之前**读（否则永远是 0）
  const payloadBytesBefore = store.listEntries().find((e) => e.cacheKey === key)?.payloadBytes ?? 0;
  store.removeEntry(key);
  emit(`    冷启动前该条目${existed ? '存在（已删除）' : '不存在'}`);

  // ---- 冷：真的建树 + 求解 ----
  const coldLookup = makeLookup();
  const t0 = Date.now();
  const cold = await coldLookup.lookupWithStats(scenario);
  const coldMs = Date.now() - t0;
  if ('status' in cold.result) {
    emit(`    冷求解 ❌ 失败（${cold.result.cause}）：${cold.result.message}`);
    emit('');
    continue;
  }
  emit(
    `    冷求解 : ${(coldMs / 1000).toFixed(2)} 秒（来源 ${cold.stats.source}，质量 ${cold.stats.quality}）`,
  );

  // ---- 热（持久化）：全新的 lookup，内存缓存为空，模拟进程重启 ----
  const warmPersistentLookup = makeLookup();
  const t1 = Date.now();
  const warmP = await warmPersistentLookup.lookupWithStats(scenario);
  const warmPersistentMs = Date.now() - t1;
  if ('status' in warmP.result) {
    emit(`    持久化热读 ❌ 失败（${warmP.result.cause}）`);
    emit('');
    continue;
  }
  emit(
    `    热读（持久化，模拟重启）: ${warmPersistentMs} ms（来源 ${warmP.stats.source}）` +
      `${warmPersistentMs < 500 ? ' ✅ < 500ms' : ' ⚠️ ≥ 500ms'}${warmPersistentMs < 100 ? ' / ✅ < 100ms' : ''}`,
  );

  // ---- 热（内存）----
  const t2 = Date.now();
  const warmM = await warmPersistentLookup.lookupWithStats(scenario);
  const warmMemoryMs = Date.now() - t2;
  emit(
    `    热读（内存）: ${warmMemoryMs} ms（来源 ${'status' in warmM.result ? '—' : warmM.stats.source}）`,
  );

  const payloadBytes =
    store.listEntries().find((e) => e.cacheKey === key)?.payloadBytes ?? payloadBytesBefore;
  emit(`    载荷大小 : ${(payloadBytes / 1024).toFixed(1)} KB`);
  emit(
    `    加速比   : ${(coldMs / Math.max(1, warmPersistentMs)).toFixed(0)}×（冷 ${(coldMs / 1000).toFixed(1)}s → 热 ${warmPersistentMs}ms）`,
  );
  emit('');

  rows.push({ size, coldMs, warmPersistentMs, warmMemoryMs, payloadBytes });
}

/* ============================================================
 * 汇总
 * ============================================================ */

emit('================================================================');
emit('汇总');
emit('----------------------------------------------------------------');
emit('桌人数 | 冷求解      | 热读（持久化） | 热读（内存） | 载荷    | 加速比');
for (const r of rows) {
  emit(
    `  ${String(r.size).padStart(2)}   | ${((r.coldMs ?? 0) / 1000).toFixed(1).padStart(6)} 秒  | ` +
      `${String(r.warmPersistentMs).padStart(9)} ms | ${String(r.warmMemoryMs).padStart(7)} ms | ` +
      `${(r.payloadBytes / 1024).toFixed(0).padStart(4)} KB | ${(((r.coldMs ?? 1) / Math.max(1, r.warmPersistentMs))).toFixed(0)}×`,
  );
}
emit('----------------------------------------------------------------');
if (rows.length > 0) {
  const worstWarm = Math.max(...rows.map((r) => r.warmPersistentMs));
  const worstCold = Math.max(...rows.map((r) => r.coldMs ?? 0));
  emit(`最坏冷求解 : ${(worstCold / 1000).toFixed(1)} 秒`);
  emit(`最坏热读   : ${worstWarm} ms`);
  emit(
    worstWarm < 500
      ? `结论：热读全部 < 500ms ✅${worstWarm < 100 ? '，且全部 < 100ms ✅' : '（未全部达到 <100ms）'}`
      : '结论：**有场景的热读 ≥ 500ms** —— 需要优化载荷解析，且必须如实报告',
  );
  emit(
    '⚠️ 正确性优先：本条结论只描述耗时。**没有**为了让热读更快而跳过任何一致性校验 —— ' +
      '缓存载荷每次读取都会跑完整的结构校验（169 类 / 频率 0..1 / 求和为 1 / 无 NaN）。',
  );
}
emit('================================================================');
emit(`证据文件: ${EVIDENCE_FILE}`);
void rmSync;
void existsSync;
