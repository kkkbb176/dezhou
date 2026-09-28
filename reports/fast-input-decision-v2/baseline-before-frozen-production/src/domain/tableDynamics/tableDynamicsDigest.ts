/**
 * ============================================================================
 * 牌桌动态适应 V1 —— 桌况稳定摘要（缓存键 / 重放判据）
 * ============================================================================
 *
 * ## 为什么需要它
 *
 * 影子结果（以及未来的任何缓存）必须能回答一个问题：
 *
 * > **这份结果是在「哪一份桌况」下算出来的？**
 *
 * 若缓存键里只有「玩家 id + 手牌」，那么「同一手牌，但桌上已经多打了 30 手」
 * 就会命中上一份结果 —— 那正是「旧缓存对应错误的牌局状态」这一失效形态。
 *
 * 因此：键里必须包含**影响结果的那部分桌况**的稳定摘要，
 * 以及**配置版本**与**模式**（由调用方拼进去，见 `tableDynamicsShadow.ts`）。
 *
 * ## 摘要里放什么、不放什么
 *
 * 放：版本、可信度、每个维度的 (id, 机会数, 命中数, 收缩后比率四舍五入)。
 * 不放：中文文案、浮点全精度、时间戳、耗时 —— 它们不影响决策，
 *       放进去只会让「同一输入」产生不同键（虚假未命中）。
 *
 * ## 零依赖
 *
 * 只用确定性字符串哈希（FNV-1a 32 位）。**不使用** `crypto`、不使用随机、
 * 不使用时间 —— 本模块必须是纯函数，才能被「重放逐位一致」的测试锁住。
 */

import type { TableAdjustmentPlan, TableDynamics } from './tableDynamics.ts';

/** FNV-1a 32 位（确定性、无依赖；冲突率对本用途足够） */
export function stableHash32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    /* 乘以 16777619（FNV 质数），用移位避免 32 位溢出 */
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 桌况 + 调整方案的稳定摘要。
 *
 * 相同输入 ⇒ 相同摘要；任何**影响结果**的变化（多一条机会、
 * 收缩后比率变化到可见精度、配置版本变化）⇒ 摘要改变。
 */
export function computeTableDynamicsDigest(
  dynamics: TableDynamics,
  plan: TableAdjustmentPlan | null,
): string {
  const dims = dynamics.layers.table
    .map(
      (d) =>
        `${d.id}:${d.opportunities}:${d.successes}:${d.adjustedRate.toFixed(4)}:${d.confidence.toFixed(3)}`,
    )
    .join('|');
  const adj =
    plan === null
      ? 'noplan'
      : plan.adjustments
          .map((a) => `${a.category}:${a.status}:${a.direction}:${a.factor.toFixed(3)}`)
          .join('|');
  const profiles =
    plan === null
      ? 'noprofiles'
      : plan.opponentProfiles.map((p) => `${p.playerId}:${p.quickProfile}:${p.source}`).join('|');
  return stableHash32(
    [
      dynamics.version,
      dynamics.tableConfidence.toFixed(3),
      dynamics.recordsUsed,
      dynamics.handsObserved,
      dims,
      adj,
      profiles,
    ].join('||'),
  );
}
