/**
 * 领域层统一出口（深路径导入也可，但推荐从这里取）
 *
 * ## 关于 `range` 与 `player` 两个子域
 *
 * 这两个子域**刻意不做通配再导出**，原因有两条：
 *
 * 1. **符号冲突**：`range.types.ts` 的 `RangeSource` / `RangeUpdateContext`
 *    与 `range.ts` 的再导出、`rangeValidator.ts` 的 `RangeViolationCode`
 *    在多个文件里出现，`export *` 会直接抛 `duplicate export` 而无法启动。
 * 2. **分层意图**：这两个子域内部耦合紧密（范围引擎 12 个文件、玩家画像 5 个文件），
 *    通配再导出会让「谁依赖谁」变得不可见。深路径导入反而更清楚。
 *
 * 因此它们**只允许深路径导入**，例如：
 *   `import { updateRange } from '../domain/range/rangeUpdate.ts'`
 *   `import { readPlayer } from '../domain/player/playerClassifier.ts'`
 *
 * 这两个子域各自的**稳定对外接口**由下列文件承担（也就是调用方应该用的入口）：
 * - 范围：`range/range.ts`（构建）、`range/rangeUpdate.ts`（贝叶斯更新）、
 *   `range/rangeValidator.ts`（校验）、`range/rangeCache.ts`（缓存）
 * - 玩家：`player/playerProfile.ts`（画像引擎）、`player/playerClassifier.ts`（分类与调整）
 * - 桥接：`range/profileProvider.ts`（画像 → 范围，唯一允许的连接点）
 */

export * from './types.ts';
export * from './domainCodes.ts';

export * from './poker/cards.ts';
export * from './poker/positions.ts';
export * from './poker/handEval.ts';
export * from './poker/handDescription.ts';
export * from './poker/gameState.ts';
export * from './poker/engine.ts';
export * from './poker/odds.ts';
export * from './poker/equity.ts';
export * from './poker/validator.ts';
