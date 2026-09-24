/**
 * 范围缓存（规范第三十七 / 三十八节）
 *
 * 两个高危墨菲风险，本文件专门针对它们设计：
 *
 * 1. **缓存 key 必须完整**（第三十七节）
 *    不同的死牌会得到不同的范围，绝不能命中同一个缓存条目。
 *    因此 key 里必须包含排序后的死牌集合，而不只是「有没有死牌」。
 *
 * 2. **缓存不得污染**（第三十八节）
 *    调用者拿到缓存对象后若修改它，会污染下一手牌 —— 这是高优先级风险。
 *    Range 本身已被 `Object.freeze` 冻结（range.ts），此处再提供
 *    `cloneRange()` 作为「需要可变副本」时的显式出口，
 *    并通过测试断言「试图修改缓存结果会失败或被隔离」。
 */

import type { Range } from './range.types.ts';

/* ============================================================
 * 缓存 Key
 * ============================================================ */

/**
 * 死牌在缓存 key 里的规范表示：**只接受牌面字符串**（如 "As"）。
 *
 * 为什么不在类型里同时允许 0..51 索引：那会造成同一张牌有两种拼写
 * （`'As'` 与 `35`），进而既可能「同一请求命中不同条目」（缓存失效），
 * 更危险的是可能「不同请求命中同一条目」（**错误命中**）。
 * 与其在运行时猜，不如在类型上只留一种表达，让调用方必须规范化。
 */
export type DeadCardToken = string;

export type RangeCacheKeyInput = {
  /** 范围数据版本 —— 数据内容变化必须升版本，否则会命中过期缓存 */
  rangeDataVersion: string;
  /** 桌型（6 / 9） */
  tableSize: number;
  /** 位置（UTG / HJ / ...） */
  position: string;
  /** 有效筹码分桶 */
  stackBucket: string;
  /** 行动历史签名（由调用方规范化，例如 "UTG:RFI>HJ:FOLD"） */
  actionHistorySignature: string;
  /** 下注尺寸分桶 */
  betSizeBucket: string;
  /** 死牌，必须用牌面字符串（如 "As"、"Td"） */
  deadCards: readonly DeadCardToken[];
};

/** 牌面字符串的合法格式：点数 + 花色 */
const DEAD_CARD_PATTERN = /^[2-9TJQKA][shdc]$/;

/**
 * 构造完整缓存 key。
 *
 * 刻意把每个维度都显式列入并**排序**，使 key 与插入顺序无关、可复现、可审计。
 * 任何一维缺失都会导致「错误命中」，因此本函数不接受可选的维度。
 *
 * 同时**校验死牌表示是规范的**：
 * - 拒绝数字索引（避免与牌面字符串形成两种拼写）
 * - 拒绝重复牌（重复不改变语义但会掩盖上游 bug）
 * - 拒绝非法牌面字符串
 */
export function buildRangeCacheKey(input: RangeCacheKeyInput): string {
  const seen = new Set<string>();
  for (const raw of input.deadCards) {
    if (typeof raw !== 'string') {
      throw new Error(
        `buildRangeCacheKey: 死牌必须用牌面字符串（如 "As"），收到 ${typeof raw}：${String(raw)}。` +
          '混用数字索引会导致缓存错误命中或永久未命中。',
      );
    }
    if (!DEAD_CARD_PATTERN.test(raw)) {
      throw new Error(`buildRangeCacheKey: 非法死牌表示「${raw}」，应形如 "As" / "Td" / "7c"`);
    }
    if (seen.has(raw)) {
      throw new Error(`buildRangeCacheKey: 死牌重复「${raw}」（重复不改变语义，通常说明上游有 bug）`);
    }
    seen.add(raw);
  }

  const dead = [...input.deadCards].sort();
  return [
    `v=${input.rangeDataVersion}`,
    `t=${input.tableSize}`,
    `p=${input.position}`,
    `s=${input.stackBucket}`,
    `a=${input.actionHistorySignature}`,
    `b=${input.betSizeBucket}`,
    `d=${dead.join(',')}`,
  ].join('|');
}

/* ============================================================
 * 缓存实现
 * ============================================================ */

export type RangeCacheStats = {
  hits: number;
  misses: number;
  size: number;
  /** 因版本不匹配而被丢弃的条目数 */
  invalidated: number;
};

export type RangeCache = {
  get(key: string): Range | undefined;
  set(key: string, range: Range): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  stats(): RangeCacheStats;
  /** 数据版本变化后调用：清空全部条目并记录失效次数 */
  invalidateAll(): void;
};

export type RangeCacheOptions = {
  /** 最大条目数（默认 256）；超出后按 FIFO 淘汰 */
  maxEntries?: number;
};

export function createRangeCache(options: RangeCacheOptions = {}): RangeCache {
  const maxEntries = options.maxEntries ?? 256;
  const store = new Map<string, Range>();
  let hits = 0;
  let misses = 0;
  let invalidated = 0;

  return {
    get(key) {
      const found = store.get(key);
      if (found === undefined) {
        misses++;
        return undefined;
      }
      hits++;
      // 命中即刷新 LRU 顺序
      store.delete(key);
      store.set(key, found);
      return found;
    },
    set(key, range) {
      if (store.has(key)) store.delete(key);
      store.set(key, range);
      while (store.size > maxEntries) {
        const oldest = store.keys().next();
        if (oldest.done) break;
        store.delete(oldest.value);
      }
    },
    has(key) {
      return store.has(key);
    },
    delete(key) {
      return store.delete(key);
    },
    clear() {
      store.clear();
    },
    stats() {
      return { hits, misses, size: store.size, invalidated };
    },
    invalidateAll() {
      invalidated += store.size;
      store.clear();
    },
  };
}

/* ============================================================
 * 防污染
 * ============================================================ */

/**
 * 克隆一个范围，得到可安全修改的浅拷贝（entries 数组为新数组）。
 *
 * 用途：调用方确实需要在范围上做临时加工（例如调试展示）时，
 * 用本函数复制一份再改，避免污染缓存。
 */
export function cloneRange(range: Range): Range {
  const entries = range.entries.map((e) => ({ ...e }));
  const lookup = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) lookup.set(entries[i]!.combo.canonicalId, i);
  return {
    ...range,
    entries,
    // 只读视图不可枚举，因此重建一份等价视图（而不是拷贝 Map）
    indexById: {
      get: (key: string) => lookup.get(key),
      has: (key: string) => lookup.has(key),
    },
  };
}

/**
 * 判断一个范围对象是否**真正**不可变。
 *
 * 注意不能只检查 `Object.isFrozen(range.entries)` ——
 * 那只说明数组本身不可增删改下标，**不说明元素对象不可变**。
 * 必须同时检查每个 entry（本项目实际踩过这个坑）。
 */
export function isFrozen(range: Range): boolean {
  if (!Object.isFrozen(range)) return false;
  if (!Object.isFrozen(range.entries)) return false;
  if (!Object.isFrozen(range.provenance)) return false;
  if (!Object.isFrozen(range.metrics)) return false;
  if (!Object.isFrozen(range.indexById)) return false;
  for (const entry of range.entries) {
    if (!Object.isFrozen(entry)) return false;
    // ⚠️ 必须检查到 combo 与它引用的牌：
    // combo 是模块级共享对象，改它等于污染全局组合宇宙（红队 CRITICAL-1）。
    if (!Object.isFrozen(entry.combo)) return false;
    if (entry.tags !== undefined && !Object.isFrozen(entry.tags)) return false;
  }
  return true;
}

/* ============================================================
 * 带缓存的范围解析
 * ============================================================ */

export type CachedRangeResolver = {
  (key: RangeCacheKeyInput): Range | undefined;
};

/**
 * 包装一个「按 key 计算范围」的函数，加上缓存。
 *
 * 刻意把计算函数作为参数传入，使本模块不依赖 range.ts 的构建逻辑，
 * 也让缓存层可以被单独测试（注入返回固定范围的假工厂）。
 */
export function createCachedResolver(
  cache: RangeCache,
  factory: (key: RangeCacheKeyInput) => Range | undefined,
): {
  resolve(input: RangeCacheKeyInput): { range: Range | undefined; hit: boolean };
} {
  return {
    resolve(input) {
      const key = buildRangeCacheKey(input);
      const cached = cache.get(key);
      if (cached !== undefined) return { range: cached, hit: true };
      const computed = factory(input);
      if (computed !== undefined) cache.set(key, computed);
      return { range: computed, hit: false };
    },
  };
}
