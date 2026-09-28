/**
 * 牌桌行动顺序的**共享**推导（TABLE DYNAMICS V1）
 *
 * ## 为什么单独成文件
 *
 * 这个函数有两个消费者，而且它们**必须用同一份实现**：
 *
 * | 消费者 | 用途 |
 * |---|---|
 * | `playerHistory.deriveObservations` | 写入记录时算「本街第几个行动 / 身后还有几个人」 |
 * | `tableDynamicsServer` | 运行时算「当前街的行动顺序」（用于披露与判据） |
 *
 * 两份实现迟早分歧，而分歧的表现形式是「记录时的顺序」与「分析时的顺序」
 * 不一致 —— 那正是本项目反复踩过的「同一条事实两处各算一次」缺陷。
 *
 * ## 顺序由**配置**推导，不硬编码
 *
 * 与 `gameState.ts` 自己的注释一致：「行动顺序 / 盲注位 / 谁是庄家
 * 全部由配置推导，而不是在代码各处硬编码 BTN」。
 * 取不到配置就返回空顺序 ⇒ 调用方把相关字段置 `null`（**不猜**）。
 */

import { postflopOrder, preflopOrder } from '../../domain/poker/positions.ts';

export type StreetOrderResult = {
  /** 本街的行动顺序（只含还没弃牌的玩家） */
  order: string[];
  /** 庄家的逻辑位置（取不到为 null） */
  buttonPosition: string | null;
};

export function streetOrderOf(engine: {
  players: readonly { position: string; folded: boolean }[];
  street: string;
  config?: { tableSize?: number; dealerPosition?: string };
}): StreetOrderResult {
  const tableSize = engine.config?.tableSize ?? null;
  const button = engine.config?.dealerPosition ?? null;
  if (tableSize === null || button === null) return { order: [], buttonPosition: button };
  if (tableSize !== 6 && tableSize !== 9) return { order: [], buttonPosition: button };
  const positions =
    engine.street === 'PREFLOP'
      ? preflopOrder(tableSize, button as never)
      : postflopOrder(tableSize, button as never);
  const live = new Set(engine.players.filter((p) => !p.folded).map((p) => p.position));
  return { order: positions.filter((p) => live.has(p)), buttonPosition: button };
}
