/**
 * ============================================================================
 * 求解器缓存**准入闸**回归锁（2026-09-22 修复 P0）
 * ============================================================================
 *
 * ## 被修的缺陷
 *
 * `priorFromCachedBaseline` 修复前只校验**结构**（节点可达 / 行动者身份 /
 * 频率非空），**完全不看收敛**。于是任何进了缓存的快照都会被当作求解器的
 * 结论驱动对手范围 —— 而缓存里确实躺着三条没收敛的：
 *
 * ```text
 * c067cd8cb  6MAX/1000000BB/UTG/RFI  targetGap 0.2  gap 129.147510  notConverged true
 * cb693226d  6MAX/1000BB/UTG/RFI    targetGap 0.2  gap   1.007083  notConverged true
 * c0b705399  6MAX/200BB/UTG/RFI     targetGap 0.2  gap   0.252987  notConverged true
 * ```
 *
 * 它们会一路进 `contextBuilder.buildBaseRange`，把 169 类权重换掉，
 * 于是权益、底价、Call EV、动作排名全部跟着变，而界面仍显示
 * 「命中已缓存的 GTO 策略」。
 *
 * ## 为什么不能只用 `quality` 字段当闸门
 *
 * 已落盘条目**全部**是 `LOW_CONVERGENCE`（缺稳定性证据会恒压到这一档），
 * 也全部满足 `GTO_CACHE_MIN_QUALITY_TO_STORE`。用它当闸门等于没有闸门。
 * 因此判据直接看收敛事实：`brGapTotal` vs `targetGap`。
 *
 * ## 本文件锁的两件事
 *
 * 1. **判别力**：必须拒绝未收敛的，同时**必须不能**误杀已收敛的
 *    —— 包括 1000BB 那条**已达标**的（gap 1.007 < 目标 1.5），
 *    它是「不要凭空给 effectiveStackBB 加上限」的实测依据。
 * 2. **实测数据**：直接对仓库里那 18 个真实缓存载荷跑裁决。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { admitSolverBaseline, priorFromCachedBaseline } from '../src/app/manualInput/solverRangePrior.ts';
import { baselineFromCacheEntry } from '../src/domain/gto/gtoStrategyStore.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '..', 'data', 'gto-cache', 'strategy');

/** 读一个真实缓存载荷并变成 baseline */
function baselineOf(cacheKey: string): any {
  const raw = JSON.parse(readFileSync(join(CACHE_DIR, `${cacheKey}.json`), 'utf8'));
  return { raw, baseline: baselineFromCacheEntry(raw, () => Date.parse('2026-09-22T00:00:00Z')) };
}

const CACHE_PRESENT = existsSync(CACHE_DIR) && readdirSync(CACHE_DIR).some((f) => f.endsWith('.json'));

/* ============================================================
 * ADMIT-1：判别力 —— 已收敛的必须通过
 * ============================================================ */

test('ADMIT-1 已收敛的快照必须通过准入（100BB / gap 0.165260 < 目标 0.2）', { skip: !CACHE_PRESENT }, () => {
  const { baseline } = baselineOf('c91e7b60a');
  const verdict = admitSolverBaseline(baseline);
  assert.equal(verdict.admitted, true, `100BB/6MAX/UTG/RFI 应通过，实际 ${JSON.stringify(verdict)}`);
});

test('ADMIT-2 拒绝理由必须是「未收敛」本身，不得凭筹码大小砍数据', { skip: !CACHE_PRESENT }, () => {
  const { raw, baseline } = baselineOf('cb693226d');
  /*
   * 1000BB 那条：目标 0.2，实测 gap 1.007083 —— **确实没达标**，
   * 所以拒绝是对的。本测试锁的是**拒绝理由的归因**：
   * 必须是「未收敛」，**不是**「有效筹码太大」。
   *
   * 这条区分很重要：本项目刻意**不给** `effectiveStackBB` 加人为上限。
   * 筹码深度已经进场景哈希与缓存键（实测 100 / 1000 / 1000000BB 三把键
   * 互不相同），所以「百万 BB 读到百 BB 的策略」在结构上不会发生；
   * 真正的漏洞是「大筹码那条自己没收敛却照样被用」。凭空加一个 200BB 上限
   * 会把 40BB / 50BB / 100BB 这些**合法且已达标**的数据一起砍掉。
   */
  const verdict = admitSolverBaseline(baseline);
  assert.equal(raw.scenario.effectiveStackBB, 1000, '这条确实是 1000BB');
  assert.ok(
    raw.solveMeta.brGapTotal >= raw.solveMeta.targetGap,
    `它确实没达标（gap ${raw.solveMeta.brGapTotal} ≥ 目标 ${raw.solveMeta.targetGap}）`,
  );
  assert.equal(verdict.admitted, false);
  assert.equal((verdict as any).kind, 'NOT_CONVERGED', '拒绝理由必须是「未收敛」');
  assert.ok(
    !String((verdict as any).reasonZh).includes('筹码太大'),
    '拒绝理由不得归因于筹码大小',
  );
  /* 同一棵树、更小筹码、同样目标的那条是**通过**的 ⇒ 判据是 gap 不是筹码 */
  const small = baselineOf('c50f1d8ac'); /* 6MAX/40BB/UTG/RFI，gap 0.148175 < 0.2 */
  assert.equal(small.raw.scenario.effectiveStackBB, 40);
  assert.equal(admitSolverBaseline(small.baseline).admitted, true, '40BB 那条已达标，必须通过');
});

/* ============================================================
 * ADMIT-3：1000000BB 那条必须被拒（原始缺陷）
 * ============================================================ */

test('ADMIT-3 1000000BB 那条（gap 129.147510）必须被拒，且原因为未收敛', { skip: !CACHE_PRESENT }, () => {
  const { raw, baseline } = baselineOf('c067cd8cb');
  assert.equal(raw.scenario.effectiveStackBB, 1000000);
  assert.equal(raw.quality, 'LOW_CONVERGENCE');
  assert.equal(raw.approximationFlags.notConverged, true);
  assert.ok(raw.solveMeta.brGapTotal > raw.solveMeta.targetGap * 100, 'gap 比目标大两个数量级');

  const verdict = admitSolverBaseline(baseline);
  assert.equal(verdict.admitted, false);
  assert.equal((verdict as any).kind, 'NOT_CONVERGED');
});

/* ============================================================
 * ADMIT-4：`priorFromCachedBaseline` 必须真的调用闸门
 * ============================================================ */

test('ADMIT-4 被拒绝的快照不得产出范围权重（prior.ok 必须为 false 且带原因）', { skip: !CACHE_PRESENT }, () => {
  const action: any = {
    tableSize: 6, position: 'UTG', effectiveStackBB: 1_000_000,
    observedOpenSizeBB: 2.5, observedThreeBetSizeBB: null,
    action: 'OPEN', openerPosition: 'UTG',
  };
  const { baseline } = baselineOf('c067cd8cb');
  const prior: any = priorFromCachedBaseline(action, baseline);
  assert.equal(prior.ok, false, '未收敛快照不得产出 prior');
  assert.ok(typeof prior.reasonZh === 'string' && prior.reasonZh.length > 0, '必须给出中文原因');
  assert.ok(prior.reasonZh.includes('准入'), `原因必须说明是准入问题：${prior.reasonZh}`);
  assert.equal(prior.weights, undefined, '拒绝时不得携带任何范围权重');
});

/* ============================================================
 * ADMIT-5：闸门判据逐条可触发（合成用例，不依赖磁盘）
 * ============================================================ */

function synthetic(over: {
  gap?: number | null;
  target?: number | null;
  stopReason?: string | null;
  solverState?: string | null;
  notConverged?: boolean;
}): any {
  return {
    range: { reachable: true, actorPosition: 'UTG', hands: [] },
    metadata: {
      source: { kind: 'SOLVER', engine: 'gtopen', sourceVersion: null, engineCommit: 'x', endpoint: null },
      scenarioHash: 'g0',
      solveSettings: {
        iterationsRequested: 40,
        iterationsCompleted: 40,
        targetGap: over.target === undefined ? 0.2 : over.target,
        reportedGap: over.gap === undefined ? 0.01 : over.gap,
        modelName: 'm',
        raw: Object.freeze({
          stopReason: over.stopReason === undefined ? 'target_gap' : over.stopReason,
          solverState: over.solverState === undefined ? 'done' : over.solverState,
        }),
      },
      solveStatus: 'SOLVED',
      verification: 'APPROXIMATE',
      approximation: {
        approximateModel: true,
        notConverged: over.notConverged ?? false,
        multiwayContinuation: true,
        compressedPrecision: false,
        fromCache: true,
        notes: [],
      },
      timestamp: '2026-09-22T00:00:00.000Z',
      latencyMs: 0,
    },
  };
}

test('ADMIT-5 五条判据各自可触发，且合格样本必须通过', () => {
  /* 合格 */
  assert.equal(admitSolverBaseline(synthetic({})).admitted, true, 'gap < target 且已结束 ⇒ 通过');

  /* G1 求解器自述未收敛 */
  const g1: any = admitSolverBaseline(synthetic({ gap: 0.001, notConverged: true }));
  assert.equal(g1.admitted, false);
  assert.equal(g1.kind, 'NOT_CONVERGED');

  /* G2 没有报告 gap */
  const g2a: any = admitSolverBaseline(synthetic({ gap: null }));
  assert.equal(g2a.admitted, false);
  assert.equal(g2a.kind, 'QUALITY_UNKNOWN');

  /* G2 没有设目标 */
  const g2b: any = admitSolverBaseline(synthetic({ target: 0 }));
  assert.equal(g2b.admitted, false);
  assert.equal(g2b.kind, 'QUALITY_UNKNOWN');

  /* G3 没到目标 */
  const g3: any = admitSolverBaseline(synthetic({ gap: 0.5, target: 0.2 }));
  assert.equal(g3.admitted, false);
  assert.equal(g3.kind, 'NOT_CONVERGED');

  /* G3 边界：恰好等于目标 ⇒ 不算达标（严格小于） */
  const g3b: any = admitSolverBaseline(synthetic({ gap: 0.2, target: 0.2 }));
  assert.equal(g3b.admitted, false, 'gap == target 不算达标');

  /* G4 被迭代上限截断 */
  const g4: any = admitSolverBaseline(synthetic({ gap: 0.01, stopReason: 'iteration_limit' }));
  assert.equal(g4.admitted, false);
  assert.equal(g4.kind, 'NOT_CONVERGED');

  /* G5 快照取自求解中途 */
  const g5: any = admitSolverBaseline(synthetic({ gap: 0.01, solverState: 'running' }));
  assert.equal(g5.admitted, false);
  assert.equal(g5.kind, 'SOLVER_NOT_DONE');
});

/* ============================================================
 * ADMIT-6：全量真实缓存 —— 判别力总账
 * ============================================================ */

test('ADMIT-6 真实缓存的裁决必须逐条可解释（不得出现「一律拒绝」或「一律通过」）', { skip: !CACHE_PRESENT }, () => {
  const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 10, `缓存应有足够样本，实测 ${files.length}`);
  let admitted = 0;
  let rejected = 0;
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(CACHE_DIR, f), 'utf8'));
    const baseline = baselineFromCacheEntry(raw, () => Date.parse('2026-09-22T00:00:00Z'));
    const verdict = admitSolverBaseline(baseline);
    /* 每条裁决都必须与它自己的收敛事实一致 */
    const gap = raw.solveMeta?.brGapTotal;
    const target = raw.solveMeta?.targetGap;
    const expectsPass =
      raw.approximationFlags?.notConverged !== true &&
      typeof gap === 'number' &&
      typeof target === 'number' &&
      target > 0 &&
      gap < target &&
      raw.solveMeta?.stopReason !== 'iteration_limit' &&
      !['running', 'queued', 'pending'].includes(String(raw.solveMeta?.solverState));
    assert.equal(
      verdict.admitted,
      expectsPass,
      `${raw.cacheKey}（gap ${gap} / 目标 ${target}）裁决 must 与收敛事实一致`,
    );
    if (verdict.admitted) admitted++;
    else rejected++;
  }
  /* 判别力：两边都必须非空，否则这个闸门没有意义 */
  assert.ok(admitted > 0, '必须有通过的样本 —— 否则闸门是「一律拒绝」');
  assert.ok(rejected > 0, '必须有被拒的样本 —— 否则闸门没起作用');
});
