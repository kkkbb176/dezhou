/**
 * 重复求解稳定性实测（Phase 1.1 §六）
 *
 * ## 为什么必须实测，不能推理
 *
 * 「同一个场景重新求解是否得到同样的策略」决定了三件事：
 * 1. 缓存能不能用（漂移大的话，缓存里的旧结果与新结果不一致）
 * 2. 质量等级能不能给高分（`gtoQuality.ts` 的稳定性证据就是它）
 * 3. 报告里的数字能不能被引用
 *
 * 源码用 DCFR + 固定种子，**理论上**确定；但理论上确定不等于实测稳定 ——
 * 并行归约顺序、迭代次数、内存布局都可能引入差异。所以必须量出来。
 *
 * ## 方法
 *
 * 对每个场景：
 * 1. **重新建树**（`spot` 会替换会话，因此不是复用同一棵树）；
 * 2. 从迭代 0 求解 N 次；
 * 3. 比对两次的：动作菜单、169 类频率、场景哈希、收敛指标、BR gap。
 *
 * ## 为什么用「最大/平均绝对差」而不是逐 bit 相等
 *
 * 浮点求和顺序在并行程序里本来就不保证逐 bit 一致。因此比较的是
 * **频率空间上的距离**，然后看它是否小到不影响任何决策
 *（1% 的频率差不会改变策略结论，30% 会）。
 *
 * 阈值不在这里拍：脚本只**测量**并打印，阈值由
 * `GTO_STABILITY_MAX_ABS_DELTA` 定义、由实测数据支撑。
 *
 * 用法：
 *   node --experimental-strip-types scripts/gto-stability-probe.ts [size...]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildGtoScenario, scenarioHashOf } from '../src/domain/gto/gtoScenario.ts';
import { GtoScenarioKind, gtoPositionsFor, type GtoTableSize } from '../src/domain/gto/gto.types.ts';
import { GTOPEN_DEFAULT_BUDGET, GtopenProvider } from '../src/domain/gto/providers/gtopenProvider.ts';
import { GtoHttpClient } from '../src/domain/gto/providers/gtopenHttpClient.ts';
import { cacheKeyOf } from '../src/domain/gto/gtoScenario.ts';
import { GTO_STABILITY_MAX_ABS_DELTA } from '../src/domain/gto/gtoQuality.ts';
import type { GtoBaseline } from '../src/domain/gto/gto.types.ts';

const EVIDENCE_DIR = fileURLToPath(new URL('../reports/evidence/', import.meta.url));
mkdirSync(EVIDENCE_DIR, { recursive: true });
const EVIDENCE_FILE = `${EVIDENCE_DIR}gto-stability-evidence.txt`;

const lines: string[] = [];
function emit(line: string): void {
  console.log(line);
  lines.push(line);
  writeFileSync(EVIDENCE_FILE, `${lines.join('\n')}\n`, 'utf8');
}

const baseUrl = process.env['GTOPEN_URL'] ?? 'http://127.0.0.1:3737';

/** 每次运行都用**全新的 Provider**：不共享会话指纹、不共享内存缓存 */
function freshProvider(): GtopenProvider {
  return new GtopenProvider({
    baseUrl,
    client: new GtoHttpClient({ baseUrl }),
    budget: {
      ...GTOPEN_DEFAULT_BUDGET,
      solveWaitMs: Number(process.env['GTO_WAIT_MS'] ?? 1_200_000),
    },
  });
}

type FrequencySnapshot = {
  menu: string[];
  hands: Map<string, { kind: string; sizeBB: number | null; frequency: number }[]>;
  hash: string;
  gapTotal: number | null;
  iterations: number | null;
  stopReason: string | null;
  cacheKey: string;
};

function snapshotOf(baseline: GtoBaseline): FrequencySnapshot {
  const hands = new Map<string, { kind: string; sizeBB: number | null; frequency: number }[]>();
  for (const hand of baseline.range.hands) {
    hands.set(
      hand.hand,
      hand.actions.map((a) => ({ kind: a.kind, sizeBB: a.sizeBB, frequency: a.frequency })),
    );
  }
  const raw = baseline.metadata.solveSettings.raw;
  return {
    menu: baseline.range.actionMenu.map((a) => `${a.kind}${a.sizeBB === null ? '' : `@${a.sizeBB}`}`),
    hands,
    hash: baseline.scenarioHash,
    gapTotal: baseline.metadata.solveSettings.reportedGap,
    iterations: baseline.metadata.solveSettings.iterationsCompleted,
    stopReason: typeof raw['stopReason'] === 'string' ? (raw['stopReason'] as string) : null,
    cacheKey: '',
  };
}

type Diff = {
  menuStable: boolean;
  maxAbs: number;
  meanAbs: number;
  worstHand: string;
  changedAbove1pct: number;
};

/**
 * 比较两个快照。
 *
 * ⚠️ 比较**逐 (手牌, 动作, 尺寸)** 的对齐频率，而不是数组下标 ——
 * 两张表的动作顺序可能不同（那本身就是不稳定），因此先按
 * `kind@size` 归一成映射再比。
 */
function diffOf(a: FrequencySnapshot, b: FrequencySnapshot): Diff {
  const menuStable = JSON.stringify(a.menu) === JSON.stringify(b.menu);
  let maxAbs = 0;
  let sumAbs = 0;
  let count = 0;
  let worstHand = '';
  let changedAbove1pct = 0;

  for (const [hand, actionsA] of a.hands) {
    const actionsB = b.hands.get(hand) ?? [];
    const keyOf = (x: { kind: string; sizeBB: number | null }) =>
      `${x.kind}@${x.sizeBB === null ? '-' : x.sizeBB}`;
    const mapB = new Map(actionsB.map((x) => [keyOf(x), x.frequency]));
    // 并集：A 有而 B 没有的动作，频率记为 0（这是最严格的比较方式）
    const keys = new Set<string>([...actionsA.map(keyOf), ...actionsB.map(keyOf)]);
    for (const key of keys) {
      const fa = actionsA.find((x) => keyOf(x) === key)?.frequency ?? 0;
      const fb = mapB.get(key) ?? 0;
      const d = Math.abs(fa - fb);
      sumAbs += d;
      count += 1;
      if (d > maxAbs) {
        maxAbs = d;
        worstHand = `${hand} ${key}`;
      }
      if (d > 0.01) changedAbove1pct += 1;
    }
  }

  return {
    menuStable,
    maxAbs,
    meanAbs: count === 0 ? 0 : sumAbs / count,
    worstHand,
    changedAbove1pct,
  };
}

/* ============================================================
 * 场景清单
 * ============================================================ */

function firstIn(tableSize: GtoTableSize, stack = 100) {
  const hero = gtoPositionsFor(tableSize)[0]!;
  const scenario = buildGtoScenario({
    kind: GtoScenarioKind.RFI,
    tableSize,
    effectiveStackBB: stack,
    heroPosition: hero,
    actionHistory: [],
  });
  if (scenario === null) throw new Error(`无法构造 ${tableSize}MAX 第一入池场景`);
  return scenario;
}

const requested = process.argv.slice(2).map(Number) as GtoTableSize[];
const sizes: GtoTableSize[] =
  requested.length > 0 ? requested : [4, 6, 9];
const RUNS = Number(process.env['GTO_STABILITY_RUNS'] ?? 2);

emit('================================================================');
emit('GTO 重复求解稳定性实测（Phase 1.1）');
emit(`生成时间      : ${new Date().toISOString()}`);
emit(`求解器端点    : ${baseUrl}`);
emit(`每个场景次数  : ${RUNS}（每次都**重新建树 + 从迭代 0 求解**）`);
emit(`稳定性阈值    : 最大绝对差 ≤ ${GTO_STABILITY_MAX_ABS_DELTA}（来自 gtoQuality.ts）`);
emit('================================================================');
emit('');

const summaries: { size: number; diff: Diff; gapA: number | null; gapB: number | null }[] = [];

for (const size of sizes) {
  const scenario = firstIn(size);
  const provider = freshProvider();
  const solve = provider.solveKeyParts(scenario);
  const key = cacheKeyOf(scenario, solve);

  emit(`=== ${size}MAX / 100BB / ${scenario.heroPosition} / RFI`);
  emit(`    场景哈希 ${scenarioHashOf(scenario)} · 缓存键 ${key}`);
  emit(
    `    求解设置：迭代 ${solve.iterations} · 目标 gap ${solve.targetGap} · ` +
      `全下 ${solve.addAllin ? '提供' : '不提供'} · 跛入 ${solve.limp ? '允许' : '关闭'}`,
  );

  const snaps: FrequencySnapshot[] = [];
  for (let run = 1; run <= RUNS; run++) {
    const p = freshProvider();
    const t0 = Date.now();
    const result = await p.lookupScenario(scenario);
    const elapsed = Date.now() - t0;
    if ('status' in result) {
      emit(`    第 ${run} 次：❌ 不可用（${result.cause}）：${result.message}`);
      break;
    }
    const snap = snapshotOf(result);
    snap.cacheKey = cacheKeyOf(scenario, p.solveKeyParts(scenario));
    snaps.push(snap);
    emit(
      `    第 ${run} 次：${(elapsed / 1000).toFixed(1)} 秒 · 迭代 ${snap.iterations} · ` +
        `gap ${snap.gapTotal === null ? '未测' : snap.gapTotal.toFixed(8)} · ` +
        `停止 ${snap.stopReason ?? '未知'} · 菜单 [${snap.menu.join(', ')}]`,
    );
  }

  if (snaps.length < 2) {
    emit('    ⚠️ 少于 2 次成功，无法比对');
    emit('');
    continue;
  }

  // 两两比对（RUNS > 2 时给出全部配对）
  for (let i = 1; i < snaps.length; i++) {
    const diff = diffOf(snaps[0]!, snaps[i]!);
    emit(
      `    第 1 次 vs 第 ${i + 1} 次：菜单${diff.menuStable ? '一致' : '**不一致**'} · ` +
        `最大绝对差 ${diff.maxAbs.toFixed(4)}（${diff.worstHand || '—'}）· ` +
        `平均绝对差 ${diff.meanAbs.toFixed(5)} · 差 >1% 的 (手牌,动作) 共 ${diff.changedAbove1pct} 个`,
    );
    if (i === 1) {
      summaries.push({ size, diff, gapA: snaps[0]!.gapTotal, gapB: snaps[i]!.gapTotal });
    }
  }
  emit('');
}

/* ============================================================
 * 汇总与结论
 * ============================================================ */

emit('================================================================');
emit('汇总（阈值依据）');
emit('----------------------------------------------------------------');
emit('桌人数 | 菜单一致 | 最大绝对差 | 平均绝对差 | >1% 的条目 | gap A → gap B');
for (const s of summaries) {
  emit(
    `  ${String(s.size).padStart(2)}   | ${s.diff.menuStable ? '是      ' : '**否**  '} | ` +
      `${s.diff.maxAbs.toFixed(4).padStart(10)} | ${s.diff.meanAbs.toFixed(5).padStart(10)} | ` +
      `${String(s.diff.changedAbove1pct).padStart(11)} | ` +
      `${s.gapA === null ? '—' : s.gapA.toFixed(6)} → ${s.gapB === null ? '—' : s.gapB.toFixed(6)}`,
  );
}
emit('----------------------------------------------------------------');
if (summaries.length === 0) {
  emit('没有可用的比对结果。');
} else {
  const worstMax = Math.max(...summaries.map((s) => s.diff.maxAbs));
  const worstMean = Math.max(...summaries.map((s) => s.diff.meanAbs));
  const allStable = summaries.every((s) => s.diff.menuStable);
  emit(`实测最坏最大绝对差：${worstMax.toFixed(4)}`);
  emit(`实测最坏平均绝对差：${worstMean.toFixed(5)}`);
  emit(`动作菜单是否全部一致：${allStable ? '是' : '**否**'}`);
  emit(
    worstMax <= GTO_STABILITY_MAX_ABS_DELTA
      ? `结论：实测漂移在阈值 ${GTO_STABILITY_MAX_ABS_DELTA} 以内 —— 求解是稳定的。`
      : `结论：**实测漂移超过阈值 ${GTO_STABILITY_MAX_ABS_DELTA}** —— 阈值需要按实测上修，或求解存在真实不确定性。`,
  );
}
emit('================================================================');
emit(`证据文件: ${EVIDENCE_FILE}`);

/* ============================================================
 * 产出机器可读的稳定性证据（供质量评级使用）
 * ============================================================ */

/**
 * 🔴 这一步是「实测 → 质量等级」的唯一连接点。
 *
 * `GtoSafeLookup` 从 `data/gto-stability.json` 读取证据：
 * 有证据 → 质量等级才可能升到 `USABLE`；
 * 没证据 → 落在 `LOW_CONVERGENCE`（安全默认值）。
 *
 * 因此这个文件是**实测的产物**，不是手写的。
 * 每次重跑本探针都会覆盖它，保证「证据与实测一致」。
 */
const evidenceOut: Record<string, unknown> = {};
for (const s of summaries) {
  // 键必须是**缓存键**（含求解设置），因为稳定性与求解设置绑定
  const provider = freshProvider();
  const scenario = firstIn(s.size);
  const key = cacheKeyOf(scenario, provider.solveKeyParts(scenario));
  evidenceOut[key] = {
    runs: RUNS,
    maxAbsFrequencyDelta: s.diff.maxAbs,
    meanAbsFrequencyDelta: s.diff.meanAbs,
    actionMenuStable: s.diff.menuStable,
    note:
      `scripts/gto-stability-probe.ts 实测：${RUNS} 次「重新建树 + 从迭代 0 求解」，` +
      `桌人数 ${s.size}，迭代 ${provider.solveKeyParts(scenario).iterations} 次，` +
      `gap ${s.gapA?.toFixed(8) ?? '—'} → ${s.gapB?.toFixed(8) ?? '—'}。` +
      `实测于 ${EVIDENCE_DIR}`,
  };
}
const jsonPath = fileURLToPath(new URL('../data/gto-stability.json', import.meta.url));
writeFileSync(jsonPath, JSON.stringify(evidenceOut, null, 2), 'utf8');
emit(`稳定性证据已写入: ${jsonPath}`);
emit(`  共 ${Object.keys(evidenceOut).length} 个缓存键（每个键绑定一套求解设置）`);
emit('  ⚠️ 没有出现在这个文件里的缓存键 ⇒ 质量等级不会升到 USABLE（安全默认值）');
emit('================================================================');
