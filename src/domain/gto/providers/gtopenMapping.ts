/**
 * GTOpen 适配层的**位置与动作映射**（唯一允许出现 GTOpen 命名的地方之一）
 *
 * ## 为什么必须有这个文件
 *
 * 求解器内部的位置名与本项目**不一样**：
 *
 * | 桌人数 | 本项目 | GTOpen 参考解法里的写法 |
 * |---|---|---|
 * | 9 | `UTG UTG1 UTG2 LJ HJ CO BTN SB BB` | `UTG UTG1 MP HJ CO BTN SB BB`（8 座示例） |
 * | 8 | `UTG UTG1 LJ HJ CO BTN SB BB` | 未见到官方示例 |
 *
 * ⚠️ 但**更重要的一个事实**（已核对源码，不是推测）：
 * `PreflopConfig.positions` 是一个 `Vec<String>`，求解器**只使用它的长度与下标**：
 *
 * - `crates/solver/src/preflop/mod.rs` 的 `validate()` 只检查
 *   `2..=9` 与 `posts.len() == positions.len()`；
 * - 树构建按**座位下标**推进（`next_seat`），位置字符串仅出现在
 *   `actor_pos` / `history[].actor_pos` / 错误信息里；
 * - 盲注由 `posts` 数组给出，**不是**由名字推断的。
 *
 * 因此「位置名映射」在 GTOpen 这里的真实含义是：
 * **第 i 个座位 = 哪一种角色的玩家**。而座位的角色完全由
 * 「行动顺序 + 盲注位」决定 —— 这正是本项目 `GTO_POSITION_ORDER` 的定义。
 *
 * 结论（本文件的作用）：
 * 1. 我们**按自己的位置顺序**构造 `positions` 数组（权威、可测试）；
 * 2. 同时把映射关系**显式写下来**，并在响应回来后用
 *    `verifyPositionsEcho()` **核对求解器回显的 positions 数组**逐位一致 ——
 *    这是「不靠数组顺序猜」的可执行版本：我们猜了，然后**验证**。
 * 3. 如果将来要接一个位置名有语义的求解器，只需要在这里加一张表，
 *    上层（`GtoScenario` / UI / Decision Engine）完全不用改。
 */

import {
  GtoActionKind,
  type GtoPosition,
  type GtoTableSize,
  gtoPositionsFor,
} from '../gto.types.ts';

/* ============================================================
 * 位置
 * ============================================================ */

/**
 * 本项目位置 → GTOpen 侧位置标签。
 *
 * 目前是**恒等映射**（我们直接用自己的名字），但函数存在的意义是：
 * 这个名字一旦需要变化（例如某个求解器只认 `MP`），改动点只有这里一处。
 *
 * ⚠️ `UTG1` / `UTG2` 在 GTOpen 的参考解法数据里从不出现，
 * 它的 8 座示例用的是 `MP` 而不是 `LJ`。我们**不**跟随它改名，
 * 因为「本项目内部位置名」是一份对外契约（Alpha 的 `Position` 也是这套名字）。
 * 反过来如果某个求解器**要求**特定名字，就在这里映射，而不是污染上层。
 */
export const POSITION_LABELS: Readonly<Record<GtoPosition, string>> = Object.freeze({
  UTG: 'UTG',
  UTG1: 'UTG1',
  UTG2: 'UTG2',
  LJ: 'LJ',
  HJ: 'HJ',
  CO: 'CO',
  BTN: 'BTN',
  SB: 'SB',
  BB: 'BB',
});

/** 位置 → 求解器标签 */
export function toEnginePosition(position: GtoPosition): string {
  return POSITION_LABELS[position];
}

/**
 * 构造请求里的 `positions` 数组 + `posts` 数组。
 *
 * 🔴 这是**唯一**构造这两个数组的地方。两件事必须同时正确：
 * 1. 顺序 = 翻牌前行动顺序（`GTO_POSITION_ORDER`）；
 * 2. 最后两位恰好是 SB / BB，且 `posts` 与之一一对应。
 *
 * 任何「手里另写一份 positions」的代码都会让二者漂移，
 * 而漂移的后果是**整套范围错位一格**（位置名全都还合法，肉眼看不出来）。
 */
export function buildEngineSeats(
  tableSize: GtoTableSize,
  blinds: { sbBB: number; bbBB: number },
): { positions: string[]; posts: number[] } {
  const order = gtoPositionsFor(tableSize);
  const positions = order.map(toEnginePosition);
  const posts = order.map((position) => {
    if (position === 'SB') return blinds.sbBB;
    if (position === 'BB') return blinds.bbBB;
    return 0;
  });
  return { positions, posts };
}

/**
 * 核对求解器回显的 `positions` 与我们的请求**逐位一致**。
 *
 * ## 为什么值得一个专门的校验
 *
 * 求解器把 `positions` 原样存进 session 并在 `node` 响应里回显。
 * 这个回显是**我们能拿到的最强证据**，证明「屏幕上的 CO 就是求解器算的 CO」。
 * 只要回显与请求有一处不同（长度不同、某个位置不同、顺序不同），
 * 我们就无法确定拿到的策略属于哪个座位 —— 此时**必须**判为
 * `INVALID_RESPONSE` 并回退，绝不能「看起来差不多就用了」。
 *
 * @returns 问题列表（空 = 一致）
 */
export function verifyPositionsEcho(
  requested: readonly string[],
  echoed: readonly string[],
  expectedTableSize?: GtoTableSize,
): string[] {
  const problems: string[] = [];
  if (echoed.length !== requested.length) {
    problems.push(`求解器回显的座位数 ${echoed.length} 与请求的 ${requested.length} 不一致`);
  }
  const n = Math.min(echoed.length, requested.length);
  for (let i = 0; i < n; i++) {
    if (echoed[i] !== requested[i]) {
      problems.push(`第 ${i} 个座位不一致：请求 ${requested[i]}，回显 ${echoed[i]}`);
    }
  }
  if (expectedTableSize !== undefined) {
    if (echoed.length !== expectedTableSize) {
      problems.push(`桌人数 ${expectedTableSize} 与求解器座位数 ${echoed.length} 不一致`);
    }
    const order = gtoPositionsFor(expectedTableSize);
    const sbSeat = echoed[echoed.length - 2];
    const bbSeat = echoed[echoed.length - 1];
    if (sbSeat !== order[order.length - 2] || bbSeat !== order[order.length - 1]) {
      problems.push(
        `盲注位错位：最后两座应为 ${order[order.length - 2]}/${order[order.length - 1]}，` +
          `实际 ${String(sbSeat)}/${String(bbSeat)}`,
      );
    }
  }
  return problems;
}

/* ============================================================
 * 动作
 * ============================================================ */

/**
 * GTOpen 的动作 `kind` 字符串（源码核对：
 * `crates/solver/src/preflop/mod.rs` 的 `legal_actions_of()`）。
 *
 * | GTOpen `kind` | 本项目 `GtoActionKind` | 备注 |
 * |---|---|---|
 * | `fold` | `FOLD` | |
 * | `check` | `CHECK` | `to` 等于当前注额 |
 * | `call` | `CALL` | 无人加注时，标签写作 `Limp <to>` |
 * | `raise` | `RAISE` | 首次加注标签 `Raise <to>`，之后 `N-bet <to>` |
 * | `jam` | `ALL_IN` | `to` 恒等于栈深 |
 *
 * ⚠️ **不得**用标签文本判断动作类型。标签里 `N-bet` 的 N 会随加注层数变化
 *（源码是 `st.raises + 2`），拿它做分支会在 5-bet/6-bet 场景下静默错位。
 * 一律用 `kind`。
 */
export function mapActionKind(engineKind: unknown): GtoActionKind | null {
  switch (engineKind) {
    case 'fold':
      return GtoActionKind.FOLD;
    case 'check':
      return GtoActionKind.CHECK;
    case 'call':
      return GtoActionKind.CALL;
    case 'raise':
      return GtoActionKind.RAISE;
    case 'jam':
      return GtoActionKind.ALL_IN;
    default:
      return null;
  }
}

/** 反向映射（构造「走到某个节点」的请求时用不到，但自检与测试需要） */
export function toEngineActionKind(kind: GtoActionKind): string | null {
  switch (kind) {
    case GtoActionKind.FOLD:
      return 'fold';
    case GtoActionKind.CHECK:
      return 'check';
    case GtoActionKind.CALL:
      return 'call';
    case GtoActionKind.RAISE:
      return 'raise';
    case GtoActionKind.ALL_IN:
      return 'jam';
    case GtoActionKind.BET:
      // GTOpen 的翻前没有独立的「下注」：首次主动性投入一定是 `raise`。
      // 返回 null 表示「无法在翻前表达下注」—— 让调用方显式处理，而不是静默当成 raise。
      return null;
    default:
      return null;
  }
}

/* ============================================================
 * 自检
 * ============================================================ */

/** 位置与动作映射自检 */
export function selfCheckMappingLayer(): string[] {
  const problems: string[] = [];

  for (const size of [4, 5, 6, 8, 9] as const) {
    const order = gtoPositionsFor(size);
    const { positions, posts } = buildEngineSeats(size, { sbBB: 0.5, bbBB: 1 });
    if (positions.length !== size) {
      problems.push(`${size} 人桌的 positions 长度应为 ${size}，实际 ${positions.length}`);
    }
    if (posts.length !== size) {
      problems.push(`${size} 人桌的 posts 长度应为 ${size}，实际 ${posts.length}`);
    }
    if (positions[positions.length - 2] !== 'SB' || positions[positions.length - 1] !== 'BB') {
      problems.push(`${size} 人桌的最后两座应为 SB/BB，实际 ${positions.slice(-2).join('/')}`);
    }
    if (posts[posts.length - 2] !== 0.5 || posts[posts.length - 1] !== 1) {
      problems.push(`${size} 人桌的盲注应为 0.5/1，实际 ${posts.slice(-2).join('/')}`);
    }
    if (posts.slice(0, size - 2).some((p) => p !== 0)) {
      problems.push(`${size} 人桌的非盲注座位不应有强制投入`);
    }
    // 逐位核对：positions 必须与权威顺序逐字一致
    for (let i = 0; i < size; i++) {
      if (positions[i] !== order[i]) {
        problems.push(`${size} 人桌第 ${i} 座应为 ${order[i]}，实际 ${positions[i]}`);
      }
    }
    // 回显校验函数本身必须能发现错位
    const good = verifyPositionsEcho(positions, positions, size);
    if (good.length > 0) problems.push(`${size} 人桌的回显自校验误报：${good.join('；')}`);
    const swapped = [...positions];
    const last = swapped[swapped.length - 1]!;
    swapped[swapped.length - 1] = swapped[swapped.length - 2]!;
    swapped[swapped.length - 2] = last;
    if (size > 2 && verifyPositionsEcho(positions, swapped, size).length === 0) {
      problems.push(`${size} 人桌：SB/BB 互换竟然通过了回显校验`);
    }
  }

  // 动作映射必须覆盖源码里出现的全部 kind
  for (const kind of ['fold', 'check', 'call', 'raise', 'jam'] as const) {
    if (mapActionKind(kind) === null) problems.push(`动作类别 ${kind} 未映射`);
  }
  if (mapActionKind('bet') !== null) problems.push('翻前不应存在独立的 bet 动作类别');
  if (mapActionKind('unknown-kind') !== null) problems.push('未知动作类别应返回 null');

  return problems;
}
