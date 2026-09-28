/**
 * 阻断牌过滤（规范第十 / 十一节）
 *
 * 顺序**必须**严格如下，不得颠倒：
 *   建立 Prior → 移除 Impossible Combos → 重新归一化 → 应用动作 Likelihood → 再次归一化
 *
 * 禁止「先归一化、再移除死牌、但不重新归一化」——
 * 那会让 Σp < 1，而下游权益计算会把这个缺口当成一个不存在的概率质量。
 */

import { cardIndex, isCardIndexInRange, normalizeCard, parseCard } from '../poker/cards.ts';
import type { Card } from '../types.ts';
import { EPSILON } from './range.types.ts';
import type { ExactCombo } from './combo.ts';

/** 死牌集合：用 0..51 整数索引表示，判断为 O(1) */
export type DeadCardSet = ReadonlySet<number>;

/**
 * 从「可能是任意形状的外部输入」构造死牌集合。
 *
 * ⚠️ 这是红队审计发现的一处 **MAJOR 缺陷** 的修复：
 * 旧版 `deadCardsFrom` 只接受 `Card[]`，调用方若传了别的形状会被 `tsc` 拦下；
 * 但**绕过类型**（例如 `new Set(['As','Kd'])`、`{rank:14, suit:'S'}`）
 * 会得到空集合或 `-1` 索引，于是**死牌过滤静默失效**（1326 而不是 1225），
 * 没有任何报错 —— 这正是「运行完全正常但精确地算错」的典型形态。
 *
 * 本函数因此：
 * - 接受 `Card[]` / `Set<string>` / `Iterable<unknown>`
 * - 大小写不敏感（`'S'` 视为 `'s'`，规范化为合法牌）
 * - **非法表示一律抛错**，绝不静默丢弃
 */
export function deadCardsFrom(input: unknown): Set<number> {
  const set = new Set<number>();

  if (input === undefined || input === null) return set;

  // 已经是索引集合（Set<number>）
  if (input instanceof Set) {
    for (const item of input) {
      if (typeof item === 'number') {
        if (!isCardIndexInRange(item)) {
          throw new Error(`deadCardsFrom: 死牌索引越界 ${item}（必须是 0..51）`);
        }
        set.add(item);
        continue;
      }
      if (typeof item === 'string') {
        set.add(parseDeadCardToken(item));
        continue;
      }
      if (typeof item === 'object') {
        set.add(indexOfExternalCard(item));
        continue;
      }
      throw new Error(`deadCardsFrom: 无法识别的死牌 ${String(item)}（类型 ${typeof item}）`);
    }
    return set;
  }

  const list = Array.isArray(input) ? input : [input];
  for (const item of list) {
    if (item === undefined || item === null) continue;
    if (typeof item === 'number') {
      if (!isCardIndexInRange(item)) {
        throw new Error(`deadCardsFrom: 死牌索引越界 ${item}（必须是 0..51）`);
      }
      set.add(item);
      continue;
    }
    if (typeof item === 'string') {
      set.add(parseDeadCardToken(item));
      continue;
    }
    if (typeof item === 'object') {
      set.add(indexOfExternalCard(item));
      continue;
    }
    throw new Error(`deadCardsFrom: 无法识别的死牌 ${String(item)}（类型 ${typeof item}）`);
  }
  return set;
}

/**
 * 解析牌面字符串（大小写不敏感）。
 * 非法格式**抛错**，不静默忽略。
 */
function parseDeadCardToken(token: string): number {
  const trimmed = token.trim();
  const normalized = `${trimmed.slice(0, -1).toUpperCase()}${trimmed.slice(-1).toLowerCase()}`;
  const parsed = parseCard(normalized);
  if (!parsed.ok) {
    throw new Error(
      `deadCardsFrom: 无法解析死牌「${token}」（${parsed.code}）。` +
        '应形如 "As" / "Td" / "7c"；若使用数字索引请确保在 0..51 范围内。',
    );
  }
  const index = cardIndex(parsed.card);
  if (!isCardIndexInRange(index)) {
    throw new Error(`deadCardsFrom: 牌「${token}」无法映射到合法索引（${index}）`);
  }
  return index;
}

/** 规范化任意「像牌的对象」，非法则抛错 */
function indexOfExternalCard(value: object): number {
  const candidate = value as { rank?: unknown; suit?: unknown };
  if (candidate.rank === undefined || candidate.suit === undefined) {
    throw new Error(
      `deadCardsFrom: 对象死牌必须含 rank 与 suit 字段，收到 ${JSON.stringify(value)}`,
    );
  }
  const normalized = normalizeCard({
    rank: candidate.rank as number,
    suit: String(candidate.suit),
  });
  if ('issue' in normalized) {
    throw new Error(
      `deadCardsFrom: 死牌不合法（${normalized.issue.problem}）：${JSON.stringify(value)}`,
    );
  }
  const index = cardIndex(normalized.card);
  if (!isCardIndexInRange(index)) {
    throw new Error(`deadCardsFrom: 死牌无法映射到合法索引（${index}）：${JSON.stringify(value)}`);
  }
  return index;
}

/** 生成一个空死牌集合 */
export function emptyDeadCards(): Set<number> {
  return new Set<number>();
}

export function mergeDeadCards(...sets: readonly DeadCardSet[]): Set<number> {
  const merged = new Set<number>();
  for (const set of sets) for (const index of set) merged.add(index);
  return merged;
}

/** 组合是否与死牌冲突 */
export function isBlocked(combo: ExactCombo, dead: DeadCardSet): boolean {
  const [i1, i2] = combo.cardIndices;
  return dead.has(i1) || dead.has(i2);
}

/**
 * 从组合池中移除与死牌冲突的组合。
 *
 * @returns 保留下来的组合（顺序不变）与被移除的数量
 */
export function removeBlockedCombos(
  combos: readonly ExactCombo[],
  dead: DeadCardSet,
): { kept: ExactCombo[]; removedCount: number } {
  if (dead.size === 0) return { kept: combos.slice(), removedCount: 0 };
  const kept: ExactCombo[] = [];
  let removedCount = 0;
  for (const combo of combos) {
    if (isBlocked(combo, dead)) removedCount++;
    else kept.push(combo);
  }
  return { kept, removedCount };
}

/* ============================================================
 * 分块处理（规范第三十五节：禁止长时间不可中断循环）
 * ============================================================ */

/**
 * 分块常量。
 *
 * 1326 个组合本身很快（微秒级），但**未来**每个组合上会挂更复杂的逻辑
 * （牌力分类、听牌统计、多人池密度……），届时必须是可中断的。
 * 因此从第一天起就把遍历拆成 chunk，并在块间检查时间预算。
 */
export const RANGE_CHUNK_SIZE = 128;

export type ChunkGuard = {
  /** 剩余的检查点数量统计，便于诊断 */
  chunksProcessed: number;
};

/**
 * 带时间预算检查的分块遍历。
 *
 * 这是「Range Engine 必须可中止」的具体实现形式：
 * 调用方在 `body` 里做重活，本函数负责在块间检查 `canAfford`。
 *
 * @returns 正常跑完返回 null；预算不足返回中止原因说明
 */
export function forEachChunkAbortable<T>(
  items: readonly T[],
  clock: { canAfford: (costMs: number) => boolean; remainingMs: () => number },
  estimatedChunkCostMs: number,
  body: (item: T, index: number) => void,
  state?: ChunkGuard,
): { aborted: boolean; processed: number; remainingMs: number } | null {
  for (let i = 0; i < items.length; i++) {
    if (i % RANGE_CHUNK_SIZE === 0) {
      if (state) state.chunksProcessed++;
      if (!clock.canAfford(estimatedChunkCostMs)) {
        return {
          aborted: true,
          processed: i,
          remainingMs: clock.remainingMs(),
        };
      }
    }
    body(items[i]!, i);
  }
  return null;
}


/** 组合与一组牌是否冲突（对外便捷导出） */
export function comboConflictsWithCards(combo: ExactCombo, cards: readonly Card[]): boolean {
  return isBlocked(combo, deadCardsFrom(cards));
}
