/**
 * 可复现伪随机数发生器（基础设施层）
 *
 * 规范要求：
 * - 蒙特卡洛模拟必须允许设置模拟次数，并且结果必须可复现（Bug 预判 B19）。
 * - 领域层禁止直接调用 Math.random()。
 *
 * 使用 mulberry32：32 位状态、周期 2^32、分布质量足够扑克模拟使用。
 */

export type Rng = () => number;

export type Seed = number;

/** 创建可复现随机源。同一 seed 必然产生同一序列。 */
export function mulberry32(seed: Seed): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 派生一个子种子，避免同一次分析中多个模拟模块共享同一序列 */
export function deriveSeed(seed: Seed, salt: number): Seed {
  return (Math.imul(seed >>> 0, 0x9e3779b1) + Math.imul(salt >>> 0, 0x85ebca6b)) >>> 0;
}

/** [0, n) 区间内的均匀整数 */
export function randomInt(rng: Rng, n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error('randomInt: n 必须是正整数');
  return Math.floor(rng() * n);
}

/** 原地 Fisher-Yates 洗牌，返回同一数组 */
export function shuffleInPlace<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}

/** 从数组中无放回抽取 count 个元素（不修改原数组） */
export function sampleWithoutReplacement<T>(items: readonly T[], count: number, rng: Rng): T[] {
  const pool = items.slice();
  shuffleInPlace(pool, rng);
  return pool.slice(0, count);
}
