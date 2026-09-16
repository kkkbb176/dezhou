/**
 * 牌桌拓扑 —— 属性测试（规范 §83 / §84 / §85 / §86 / §87 / §112）
 *
 * ## 本文件钉住的命题
 *
 * 1. **§83 容量 ≠ 本手人数**：任意「非连续空位 + 任意 Button 座位」组合下，
 *    盲注位 / 位置角色 / 第一个行动者都必须由**物理座位环**推出，
 *    而不是由「满桌位置表」推出。
 * 2. **§84 Button 轮转**：座位空档、离桌、入座穿插时，Button 永远落在合格座位上，
 *    不卡住、不跳空位，且与**独立参照实现**逐位一致。
 * 3. **§81 满桌兼容**：满桌时新拓扑必须逐位复现旧的
 *    `preflopOrder` / `postflopOrder` / `blindsOf`。
 * 4. **§85 真实牌局**：`createGame` 产出的状态里，盲注、行动顺序、行动队列都要正确。
 * 5. **§86 单挑**：Button 即小盲、对手下大盲、翻牌前 Button 先行动。
 * 6. **§87 失败即关闭**：非法输入一律抛错，绝不静默产出坏状态。
 * 7. **§112 性能**：9 座桌 5000 次拓扑计算必须远低于 1 秒。
 *
 * 全部随机用例走 `mulberry32` 固定种子 → 可复现，不依赖时钟顺序
 * （唯一的时钟读取在 §112 的性能测试里，那是这条需求本身要求的）。
 *
 * ---------------------------------------------------------------------------
 * ## ⚠️ 本文件包含 3 个**预期失败**的测试
 *
 * 它们钉住的是写本文件时发现的**真实缺陷**（不是写错的期望）：断言按正确契约写，
 * 没有放宽；并且被刻意隔离在单独的 `test()` 里，
 * 以免它们的失败掩盖其它属性的失败 —— 修复源码后它们会自动转绿。
 *
 * | 测试 | 缺陷 | 最小复现 |
 * |---|---|---|
 * | §83【真实缺陷】 | 单挑时 `roleBySeatIndex` 用 `SB` **覆盖**了 Button 的 `BTN` | `handTopologySeats(6, ['BTN','BB'], 'BTN').roleBySeatIndex` → `{3:'SB',5:'BB'}`；而 `canonicalRolesOf(2)` = `['BTN','BB']` |
 * | §86【真实缺陷】 | 单挑**翻牌后**从 Button（小盲）开始行动，而不是大盲 | 6 座桌 2 人（BTN/BB）打完翻牌前 → 翻牌 `pendingQueue` = `['seat3','seat5']`，应为 `['seat5','seat3']` |
 * | §87【真实缺陷】 | `createGame` **不拒绝**重复 `playerId`（下游 `validateGameState` 会拦，但构造期是静默放行） | 两位玩家都用 id `'dup'` → 不抛错，且 `pendingQueue` = `['dup','dup']` |
 * ---------------------------------------------------------------------------
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ActionType, Position, Street } from '../src/domain/types.ts';
import {
  CANONICAL_ROLES,
  POSITION_ORDER,
  blindsOf,
  canonicalRolesOf,
  handTopologySeats,
  nextButtonSeat,
  occupiedSeatIndices,
  postflopOrder,
  preflopOrder,
  seatIndexOfPosition,
  type HandTopologySeats,
} from '../src/domain/poker/positions.ts';
import {
  computePot,
  createGame,
  playerById,
  stateTopology,
  streetOrder,
  type GameConfig,
  type GameState,
  type PlayerSeed,
} from '../src/domain/poker/gameState.ts';
import { applyAction } from '../src/domain/poker/engine.ts';
import { advanceStreet } from '../src/domain/poker/streetAdvance.ts';
import { parseCardStrict } from '../src/domain/poker/cards.ts';
import { mulberry32 } from '../src/infra/rng.ts';

/* ============================================================
 * 常量与基础工具
 * ============================================================ */

/** 本项目的两种桌型容量 */
type Capacity = 6 | 9;

const CAPACITIES: readonly Capacity[] = [6, 9];

const SMALL_BLIND = 1000;
const BIG_BLIND = 2000;
const DEFAULT_STACK = BIG_BLIND * 100;

/** 翻牌（用于推进街道） */
const FLOP_CARDS = ['Kh', 'Qs', '9s'].map((spec) => parseCardStrict(spec));

/** [start, start + count) 的座位下标 */
function seatRange(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, offset) => start + offset);
}

/** 位图 → 升序座位下标（bit i = 第 i 个物理座位有人） */
function seatIndicesFromBitmap(capacity: Capacity, bitmap: number): number[] {
  const out: number[] = [];
  for (let index = 0; index < capacity; index += 1) {
    if ((bitmap & (1 << index)) !== 0) out.push(index);
  }
  return out;
}

/** 位图中 1 的个数 */
function bitmapPopcount(capacity: Capacity, bitmap: number): number {
  let count = 0;
  for (let index = 0; index < capacity; index += 1) {
    if ((bitmap & (1 << index)) !== 0) count += 1;
  }
  return count;
}

/** 座位下标 → 该容量座位环上的位置名 */
function positionsAt(capacity: Capacity, seatIndices: readonly number[]): Position[] {
  return seatIndices.map((index) => POSITION_ORDER[capacity][index]!);
}

/**
 * **独立参照实现**：从 `fromSeat` 出发顺时针数第 `k` 个参与者（不含 `fromSeat` 本身）。
 *
 * 刻意不复用 `nextButtonSeat` / `handTopologySeats` 的任何内部逻辑 ——
 * 参照实现若与被测实现共享代码，「一致」就成了空断言。
 * 找不到时返回 -1，让调用方的断言以可读的方式失败。
 */
function nthParticipantClockwise(
  capacity: Capacity,
  participants: readonly number[],
  fromSeat: number,
  k: number,
): number {
  const occupied = new Set(participants);
  let seen = 0;
  for (let step = 1; step <= capacity; step += 1) {
    const index = (fromSeat + step + capacity) % capacity;
    if (!occupied.has(index)) continue;
    seen += 1;
    if (seen === k) return index;
  }
  return -1;
}

/**
 * **独立参照实现**：Button 轮转 —— 严格顺时针的下一个合格座位。
 *
 * 与 `nextButtonSeat` 的实现路线不同：这里直接在座位环上按「物理座位 +1」步进，
 * 而不是在合格座位数组里找「第一个大于 fromSeat 的元素」。
 */
function referenceNextButtonSeat(
  capacity: Capacity,
  fromSeat: number,
  eligibleAscending: readonly number[],
): number {
  for (let step = 1; step <= capacity; step += 1) {
    const index = (fromSeat + step + capacity) % capacity;
    if (eligibleAscending.includes(index)) return index;
  }
  throw new Error('参照实现：没有合格座位');
}

/** 从 `startSeat` 出发顺时针走一圈，收集参与者座位对应的位置名 */
function positionsByWalkingFrom(
  capacity: Capacity,
  startSeat: number,
  participantSeats: readonly number[],
): Position[] {
  const occupied = new Set(participantSeats);
  const out: Position[] = [];
  for (let step = 0; step < capacity; step += 1) {
    const index = (startSeat + step) % capacity;
    if (occupied.has(index)) out.push(POSITION_ORDER[capacity][index]!);
  }
  return out;
}

/* ============================================================
 * §83 拓扑契约：一个组合的全部不变量
 * ============================================================ */

/**
 * 对「容量 + 参与者座位 + Button 座位」这一个组合断言**全部**拓扑不变量。
 *
 * ⚠️ 单挑分支**刻意不**断言「角色多重集 == canonicalRolesOf(2) = [BTN, BB]」：
 * 当前实现把 `SB` 写进 Button 的座位、覆盖掉了 `BTN`（真实缺陷）。
 * 该断言单独放在 §83 的【真实缺陷·预期失败】测试里，
 * 这样它不会掩盖本扫描中其它组合的失败。
 */
function assertTopologyContract(
  capacity: Capacity,
  seatIndices: readonly number[],
  buttonSeatIndex: number,
  where: string,
): HandTopologySeats {
  const participants = [...seatIndices].sort((a, b) => a - b);
  const ring = POSITION_ORDER[capacity];
  const topology = handTopologySeats(
    capacity,
    positionsAt(capacity, participants),
    ring[buttonSeatIndex]!,
  );
  const handedness = participants.length;
  const headsUp = handedness === 2;
  const participantSet = new Set(participants);

  /* ---------- 1. Button / 小盲 / 大盲：各恰好一个，且都是参与者 ---------- */

  assert.equal(topology.tableCapacity, capacity, `${where}: tableCapacity 必须如实回报物理容量`);
  assert.equal(topology.handedness, handedness, `${where}: handedness 必须等于参与者数量`);
  assert.deepEqual(
    [...topology.participantSeatIndices],
    participants,
    `${where}: 参与者座位必须升序且完整`,
  );
  assert.equal(topology.buttonSeatIndex, buttonSeatIndex, `${where}: Button 座位必须是给定的那一个`);

  const blindSeats: ReadonlyArray<readonly [string, number]> = [
    ['Button', topology.buttonSeatIndex],
    ['小盲', topology.smallBlindSeatIndex],
    ['大盲', topology.bigBlindSeatIndex],
  ];
  for (const [label, seatIndex] of blindSeats) {
    assert.ok(participantSet.has(seatIndex), `${where}: ${label}座位 ${seatIndex} 必须是本手参与者`);
    assert.ok(
      Number.isInteger(seatIndex) && seatIndex >= 0 && seatIndex < capacity,
      `${where}: ${label}座位 ${seatIndex} 必须落在座位环 [0, ${capacity}) 内`,
    );
  }

  /* ---------- 2. 角色表：条目数 = 本手人数、键 = 参与者集合、角色互不重复 ---------- */

  const roleKeys = Object.keys(topology.roleBySeatIndex)
    .map((key) => Number(key))
    .sort((a, b) => a - b);
  const roleValues = Object.values(topology.roleBySeatIndex);

  assert.deepEqual(roleKeys, participants, `${where}: roleBySeatIndex 的键必须恰好是本手参与者`);
  assert.equal(
    roleKeys.length,
    handedness,
    `${where}: roleBySeatIndex 必须恰好有 handedness = ${handedness} 个条目`,
  );
  assert.equal(
    new Set(roleValues).size,
    handedness,
    `${where}: 同一手牌里不允许两个座位拿到同一个位置角色（实际：${roleValues.join('/')}）`,
  );
  // 「空座位绝不会出现在任何角色里」—— 上面「键 = 参与者」已保证，
  // 这里再按需求正面写一次，避免将来改成「只断言子集」时静默放松。
  for (const seatIndex of roleKeys) {
    assert.ok(participantSet.has(seatIndex), `${where}: 空座位 ${seatIndex} 不得出现在角色表里`);
  }

  /* ---------- 3. 盲注位：由「Button 顺时针数第几个参与者」独立推出 ---------- */

  const clockwise1 = nthParticipantClockwise(capacity, participants, buttonSeatIndex, 1);
  const clockwise2 = nthParticipantClockwise(capacity, participants, buttonSeatIndex, 2);
  const expectedSmallBlind = headsUp ? buttonSeatIndex : clockwise1;
  const expectedBigBlind = headsUp ? clockwise1 : clockwise2;

  assert.equal(
    topology.smallBlindSeatIndex,
    expectedSmallBlind,
    `${where}: 小盲必须是 Button 顺时针第 1 个参与者（单挑时是 Button 本人）`,
  );
  assert.equal(
    topology.bigBlindSeatIndex,
    expectedBigBlind,
    `${where}: 大盲必须是 Button 顺时针第 2 个参与者`,
  );
  assert.equal(
    topology.buttonAlsoPostsSmallBlind,
    headsUp,
    `${where}: buttonAlsoPostsSmallBlind 必须恰好等价于「本手 2 人」`,
  );

  /* ---------- 4. 第一个行动者：大盲之后的那一位（单挑时是 Button） ---------- */

  const expectedFirstToAct = headsUp
    ? buttonSeatIndex
    : nthParticipantClockwise(capacity, participants, topology.bigBlindSeatIndex, 1);
  assert.equal(
    topology.firstToActSeatIndex,
    expectedFirstToAct,
    `${where}: 翻牌前第一个行动者必须是大盲之后的参与者（单挑时是 Button）`,
  );
  assert.ok(
    participantSet.has(topology.firstToActSeatIndex),
    `${where}: 第一个行动者必须是本手参与者`,
  );

  if (!headsUp) {
    /* ---------- 5a. 非单挑：三个座位两两不同，Button 的位置名是 BTN ---------- */

    assert.notEqual(
      topology.smallBlindSeatIndex,
      topology.buttonSeatIndex,
      `${where}: 非单挑时小盲不得与 Button 同座`,
    );
    assert.notEqual(
      topology.bigBlindSeatIndex,
      topology.smallBlindSeatIndex,
      `${where}: 小盲与大盲不得同座`,
    );
    assert.notEqual(
      topology.bigBlindSeatIndex,
      topology.buttonSeatIndex,
      `${where}: 大盲不得与 Button 同座`,
    );
    assert.equal(
      topology.roleBySeatIndex[topology.buttonSeatIndex],
      Position.BTN,
      `${where}: Button 的位置角色必须是 BTN`,
    );

    /* ---------- 5b. 角色多重集必须等于该人数的规范角色表 ---------- */

    assert.deepEqual(
      [...roleValues].sort(),
      [...canonicalRolesOf(handedness)].sort(),
      `${where}: 角色多重集必须等于 canonicalRolesOf(${handedness})`,
    );

    /* ---------- 5c. 「枪口位 …… 关煞位」按「大盲之后顺时针」依次命名 ---------- */

    const earlyAndMiddle = canonicalRolesOf(handedness).filter(
      (role) => role !== Position.BTN && role !== Position.SB && role !== Position.BB,
    );
    earlyAndMiddle.forEach((role, index) => {
      const seatIndex = nthParticipantClockwise(
        capacity,
        participants,
        topology.bigBlindSeatIndex,
        index + 1,
      );
      assert.equal(
        topology.roleBySeatIndex[seatIndex],
        role,
        `${where}: 大盲之后第 ${index + 1} 个参与者应当是 ${role}`,
      );
    });
  } else {
    /* ---------- 5d. 单挑：小盲座位 = Button 座位，另一个座位是大盲 ---------- */

    assert.equal(
      topology.smallBlindSeatIndex,
      topology.buttonSeatIndex,
      `${where}: 单挑时小盲座位必须等于 Button 座位`,
    );
    const otherSeat = participants.find((index) => index !== buttonSeatIndex)!;
    assert.equal(
      topology.bigBlindSeatIndex,
      otherSeat,
      `${where}: 单挑时另一个座位必须是大盲`,
    );
    // 见本函数头部注释：单挑的位置名多重集断言在【真实缺陷】测试里单独钉住。
  }

  return topology;
}

/* ============================================================
 * §83 非连续占位扫描
 * ============================================================ */

test('§83 穷举扫描：6 座 / 9 座桌上每一个 (参与者集合 × Button 座位) 组合', () => {
  let total = 0;
  const byHandedness = new Map<number, number>();
  const headsUpByCapacity = new Map<Capacity, number>();

  for (const capacity of CAPACITIES) {
    for (let bitmap = 0; bitmap < 1 << capacity; bitmap += 1) {
      const participantCount = bitmapPopcount(capacity, bitmap);
      if (participantCount < 2) continue; // §83：本手至少 2 人
      const seatIndices = seatIndicesFromBitmap(capacity, bitmap);
      for (const buttonSeatIndex of seatIndices) {
        const topology = assertTopologyContract(
          capacity,
          seatIndices,
          buttonSeatIndex,
          `容量 ${capacity} / 占位 ${bitmap.toString(2).padStart(capacity, '0')} / Button ${buttonSeatIndex}`,
        );
        total += 1;
        byHandedness.set(topology.handedness, (byHandedness.get(topology.handedness) ?? 0) + 1);
        if (topology.handedness === 2) {
          headsUpByCapacity.set(capacity, (headsUpByCapacity.get(capacity) ?? 0) + 1);
        }
      }
    }
  }

  /**
   * 组合数恒等式：Σ_{k=2..C} C(C,k)·k = C·2^(C−1) − C
   * 9 座：9·256 − 9 = 2295；6 座：6·32 − 6 = 186。
   */
  const expected = 9 * 2 ** 8 - 9 + (6 * 2 ** 5 - 6);
  assert.equal(total, expected, `穷举组合总数必须恰好是 ${expected}（实际 ${total}）`);
  assert.ok(total >= 2000, '§83 要求至少覆盖数千个组合');
  assert.equal(
    byHandedness.get(2),
    (9 * 8) / 2 * 2 + (6 * 5) / 2 * 2,
    '单挑组合数必须等于 Σ C(C,2)·2（每个二人组合可以有两个 Button 座位）',
  );
  assert.equal(headsUpByCapacity.get(9), 72, '9 座桌单挑组合 = C(9,2)·2 = 72');
  assert.equal(headsUpByCapacity.get(6), 30, '6 座桌单挑组合 = C(6,2)·2 = 30');
  for (let handedness = 2; handedness <= 9; handedness += 1) {
    assert.ok(
      (byHandedness.get(handedness) ?? 0) > 0,
      `穷举必须覆盖每一种本手人数，缺少 ${handedness} 人`,
    );
  }

  console.log(
    `[§83 穷举] 组合数 = ${total}（9 座 ${expected - 186} + 6 座 186），` +
      `按人数分布 = ${[...byHandedness.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}人:${c}`).join(' ')}`,
  );
});

test('§83 随机扫描：7000 组随机 (参与者集合 × Button 座位) 组合，偏向非连续空位', () => {
  const rng = mulberry32(0x5eed_1983);
  let total = 0;

  for (const capacity of CAPACITIES) {
    const target = capacity === 9 ? 4000 : 3000;
    const coveredHandedness = new Set<number>();
    let nonContiguous = 0;
    let combos = 0;
    let guard = 0;

    while (combos < target && guard < target * 50) {
      guard += 1;
      // 随机占位密度：0.2 ~ 0.8，制造大量「非连续空位」
      const density = 0.2 + 0.6 * rng();
      let bitmap = 0;
      for (let index = 0; index < capacity; index += 1) {
        if (rng() < density) bitmap |= 1 << index;
      }
      if (bitmapPopcount(capacity, bitmap) < 2) continue;
      const seatIndices = seatIndicesFromBitmap(capacity, bitmap);
      const buttonSeatIndex = seatIndices[Math.floor(rng() * seatIndices.length)]!;

      const topology = assertTopologyContract(
        capacity,
        seatIndices,
        buttonSeatIndex,
        `随机构造 #${combos} / 容量 ${capacity} / 占位 ${bitmap.toString(2).padStart(capacity, '0')} / Button ${buttonSeatIndex}`,
      );

      combos += 1;
      coveredHandedness.add(topology.handedness);
      const isContiguous = seatIndices.every(
        (seatIndex, offset) => offset === 0 || seatIndex === seatIndices[offset - 1]! + 1,
      );
      if (!isContiguous) nonContiguous += 1;
    }

    assert.equal(combos, target, `容量 ${capacity} 的随机组合必须跑满 ${target} 组（实际 ${combos}）`);
    assert.ok(nonContiguous > target / 2, `随机扫描必须大量命中非连续空位（实际 ${nonContiguous}/${target}）`);
    for (let handedness = 2; handedness <= capacity; handedness += 1) {
      assert.ok(
        coveredHandedness.has(handedness),
        `随机扫描必须覆盖容量 ${capacity} 的每一种本手人数，缺少 ${handedness} 人`,
      );
    }
    total += combos;

    console.log(
      `[§83 随机] 容量 ${capacity}：${combos} 组（非连续占位 ${nonContiguous} 组，` +
        `覆盖人数 ${[...coveredHandedness].sort((a, b) => a - b).join('/')}）`,
    );
  }

  assert.equal(total, 7000, `随机组合总数必须是 7000（实际 ${total}）`);
});

test('§83 occupiedSeatIndices：输出与输入顺序无关，恒为升序', () => {
  for (const capacity of CAPACITIES) {
    const ring = POSITION_ORDER[capacity];
    const reversed = [...ring].reverse();
    assert.deepEqual(
      [...occupiedSeatIndices(capacity, reversed)],
      seatRange(0, capacity),
      `容量 ${capacity}：逆序输入也必须输出升序的全部座位`,
    );

    const evenSeats = ring.filter((_, index) => index % 2 === 0);
    const shuffled = [...evenSeats].reverse();
    assert.deepEqual(
      [...occupiedSeatIndices(capacity, shuffled)],
      seatRange(0, capacity).filter((index) => index % 2 === 0),
      `容量 ${capacity}：非连续占位必须按升序回报`,
    );
  }
});

test('§83 canonicalRolesOf：2~9 每个本手人数的角色表都恰好 n 个且互不重复', () => {
  for (let handedness = 2; handedness <= 9; handedness += 1) {
    const roles = canonicalRolesOf(handedness);
    assert.equal(roles.length, handedness, `${handedness} 人：角色数量必须等于人数`);
    assert.equal(new Set(roles).size, handedness, `${handedness} 人：角色不得重复`);
    assert.deepEqual([...roles], [...CANONICAL_ROLES[handedness]], `${handedness} 人：必须等于常量表`);
    if (handedness === 6 || handedness === 9) {
      assert.deepEqual(
        [...roles],
        [...POSITION_ORDER[handedness]],
        `${handedness} 人：规范角色表必须与 POSITION_ORDER 逐字一致（§81 的可执行证据）`,
      );
    }
  }
  assert.throws(() => canonicalRolesOf(1), /不支持的本手人数/);
  assert.throws(() => canonicalRolesOf(10), /不支持的本手人数/);
});

/**
 * ---------------------------------------------------------------------------
 * 🔴【真实缺陷·预期失败】§83 单挑时 `roleBySeatIndex` 丢失了 `BTN`
 *
 * 现象：`handTopologySeats` 先写 `roleBySeatIndex[buttonIndex] = BTN`，
 * 随后又无条件执行 `roleBySeatIndex[smallBlindSeatIndex] = SB`；
 * 而单挑时 `smallBlindSeatIndex === buttonIndex` → **BTN 被 SB 覆盖**。
 *
 * 为什么这是缺陷而不是「设计如此」：源码自己写明了契约 ——
 *   - `HandTopologySeats.roleBySeatIndex`：`座位下标 → 本手位置角色`；
 *   - `buttonAlsoPostsSmallBlind` 的注释：「单挑时 Button 的**位置名**仍是 `BTN`，
 *     但他的**盲注角色**是小盲」；
 *   - `canonicalRolesOf(2)` = `['BTN','BB']`，单挑的位置名只有两个。
 * 盲注角色已经由 `smallBlindSeatIndex` / `buttonAlsoPostsSmallBlind` 表达，
 * 再把它写进位置名表只会**丢信息**（BTN 消失），不会多信息。
 *
 * 影响面：当前 `src/` 内没有消费者（`roleBySeatIndex` 只在 positions.ts 被构造），
 * 所以是**潜伏缺陷**；但任何按文档消费它的调用方都会拿到「没有 BTN 的一手牌」。
 *
 * 最小复现：
 * ```ts
 * handTopologySeats(6, ['BTN', 'BB'], 'BTN').roleBySeatIndex
 * // 实际 { 3: 'SB', 5: 'BB' }   ← 缺 BTN
 * // 期望 { 3: 'BTN', 5: 'BB' }
 * ```
 *
 * 一行修复：`roleBySeatIndex[smallBlindSeatIndex] = Position.SB;`
 *         → `if (!headsUp) roleBySeatIndex[smallBlindSeatIndex] = Position.SB;`
 * ---------------------------------------------------------------------------
 */
test('§83【真实缺陷·预期失败】单挑的位置名必须是 BTN/BB —— SB 不得覆盖 Button 的位置名', () => {
  for (const capacity of CAPACITIES) {
    const ring = POSITION_ORDER[capacity];
    const buttonSeatIndex = seatIndexOfPosition(capacity, Position.BTN);
    const bbSeatIndex = seatIndexOfPosition(capacity, Position.BB);
    const topology = handTopologySeats(
      capacity,
      [Position.BTN, Position.BB],
      Position.BTN,
    );

    console.log(
      `[§83 缺陷] 容量 ${capacity} 单挑：roleBySeatIndex = ${JSON.stringify(topology.roleBySeatIndex)}，` +
        `角色多重集 = ${JSON.stringify(Object.values(topology.roleBySeatIndex).sort())}，` +
        `canonicalRolesOf(2) = ${JSON.stringify([...canonicalRolesOf(2)])}，` +
        `Button 座位 ${buttonSeatIndex}（环上为 ${ring[buttonSeatIndex]}），大盲座位 ${bbSeatIndex}`,
    );

    // 位置名多重集必须等于 canonicalRolesOf(2) = [BTN, BB]
    assert.deepEqual(
      Object.values(topology.roleBySeatIndex).sort(),
      [...canonicalRolesOf(2)].sort(),
      `容量 ${capacity}：单挑的位置名多重集必须是 BTN/BB —— 当前实现把 Button 的 BTN 覆盖成了 SB`,
    );
    // 盲注角色由 smallBlindSeatIndex 表达，位置名仍必须是 BTN
    assert.equal(
      topology.roleBySeatIndex[topology.buttonSeatIndex],
      Position.BTN,
      `容量 ${capacity}：Button 的位置名必须仍是 BTN（盲注角色见 smallBlindSeatIndex）`,
    );
  }
});

/* ============================================================
 * §84 Button 轮转
 * ============================================================ */

test('§84 固定座位集合：Button 严格按顺时针轮转（相邻两手不重复、绝不跳格）', () => {
  const cases: ReadonlyArray<{ capacity: Capacity; eligible: readonly number[] }> = [
    { capacity: 6, eligible: [0, 2, 5] },
    { capacity: 6, eligible: [1] },
    { capacity: 9, eligible: [0, 3, 4, 8] },
    { capacity: 9, eligible: [8] },
  ];

  for (const { capacity, eligible } of cases) {
    const cycle = [...eligible].sort((a, b) => a - b);
    // 从「上一手的 Button = 最大合格座位」出发，之后必须严格轮转
    let button = cycle[cycle.length - 1]!;
    const visited: number[] = [];
    const hands = 120; // §84 要求 100 手以上

    for (let hand = 0; hand < hands; hand += 1) {
      const next = nextButtonSeat(button, eligible);
      const where = `容量 ${capacity} / 合格座位 [${eligible.join(',')}] / 第 ${hand + 1} 手`;

      assert.equal(next, referenceNextButtonSeat(capacity, button, eligible), `${where}: 必须等于独立参照实现`);
      assert.ok(eligible.includes(next), `${where}: Button 必须落在合格座位上（实际 ${next}）`);
      if (eligible.length >= 2) {
        assert.notEqual(next, button, `${where}: 还有多个合格座位时 Button 不得卡住`);
      }
      // 从上一手 Button 到新 Button 之间不得存在任何合格座位（不跳格）
      for (let step = 1; step <= capacity; step += 1) {
        const index = (button + step) % capacity;
        if (index === next) break;
        assert.equal(eligible.includes(index), false, `${where}: 跳过了合格座位 ${index}`);
      }

      visited.push(next);
      button = next;
    }

    // 合格座位集合不变时，Button 序列必须恰好是「升序合格座位的循环」
    visited.forEach((seat, hand) => {
      assert.equal(
        seat,
        cycle[hand % cycle.length],
        `容量 ${capacity} / 合格座位 [${eligible.join(',')}]：第 ${hand + 1} 手 Button 应为 ${cycle[hand % cycle.length]}`,
      );
    });
  }
});

test('§84 座位动态变化：离桌 / 入座穿插的 300 手，Button 永远落在合格座位上', () => {
  for (const capacity of CAPACITIES) {
    const rng = mulberry32(capacity === 9 ? 0x9e37_79b1 : 0x85eb_ca6b);
    const allSeats = seatRange(0, capacity);

    let eligible = allSeats.filter(() => rng() < 0.6).sort((a, b) => a - b);
    if (eligible.length < 2) eligible = [0, capacity - 1];
    let button = eligible[eligible.length - 1]!;

    const visited = new Set<number>();
    let leaveEvents = 0;
    let joinEvents = 0;
    const hands = 300; // §84 要求 100 手以上

    for (let hand = 0; hand < hands; hand += 1) {
      const where = `容量 ${capacity} / 第 ${hand + 1} 手`;

      // 中途有人离桌：座位变得不合格（保留至少 2 个合格座位）
      if (eligible.length > 2 && rng() < 0.25) {
        const victim = eligible[Math.floor(rng() * eligible.length)]!;
        eligible = eligible.filter((seat) => seat !== victim);
        leaveEvents += 1;
      }
      // 中途有人入座：空座位变得合格
      const vacant = allSeats.filter((seat) => !eligible.includes(seat));
      if (vacant.length > 0 && rng() < 0.25) {
        const joiner = vacant[Math.floor(rng() * vacant.length)]!;
        eligible = [...eligible, joiner].sort((a, b) => a - b);
        joinEvents += 1;
      }

      assert.ok(eligible.length >= 2, `${where}: 本用例必须始终保有至少 2 个合格座位`);

      const next = nextButtonSeat(button, eligible);
      assert.equal(next, referenceNextButtonSeat(capacity, button, eligible), `${where}: 必须等于独立参照实现`);
      assert.ok(eligible.includes(next), `${where}: Button 必须落在合格座位上（实际 ${next}，合格 [${eligible.join(',')}]）`);
      assert.notEqual(next, button, `${where}: 还有多个合格座位时 Button 不得卡住`);
      for (let step = 1; step <= capacity; step += 1) {
        const index = (button + step) % capacity;
        if (index === next) break;
        assert.equal(eligible.includes(index), false, `${where}: 跳过了合格座位 ${index}`);
      }

      visited.add(next);
      button = next;
    }

    assert.ok(leaveEvents > 20, `容量 ${capacity}：离桌事件必须真的发生（实际 ${leaveEvents} 次）`);
    assert.ok(joinEvents > 20, `容量 ${capacity}：入座事件必须真的发生（实际 ${joinEvents} 次）`);
    assert.ok(visited.size >= 3, `容量 ${capacity}：Button 必须真的在多个座位间轮转（实际访问 ${visited.size} 个座位）`);

    console.log(
      `[§84 动态] 容量 ${capacity}：${hands} 手，离桌 ${leaveEvents} 次 / 入座 ${joinEvents} 次，` +
        `Button 访问过 ${visited.size} 个座位 [${[...visited].sort((a, b) => a - b).join(',')}]`,
    );
  }
});

test('§84 环绕与边界：末位座位、唯一合格座位、起点之前、空集合', () => {
  // 显式的环绕用例
  assert.equal(nextButtonSeat(8, [0, 3, 8]), 0, 'Button 在座位环末位时必须环绕到最小合格座位');
  assert.equal(nextButtonSeat(8, [0, 3]), 0, '末位之后没有合格座位时必须环绕');
  assert.equal(nextButtonSeat(5, [0, 5]), 0, '6 座桌末位环绕');
  assert.equal(nextButtonSeat(0, [0, 3]), 3, '座位 0 的下一个是 3');
  assert.equal(nextButtonSeat(-1, [0, 3, 8]), 0, '环起点之前 → 最小合格座位');
  assert.equal(nextButtonSeat(8, [8]), 8, '只剩一个合格座位且就是自己时必须留在原位（不抛错）');
  assert.throws(() => nextButtonSeat(3, []), /没有合格座位/);

  // 穷举交叉验证：任意 (fromSeat, 合格座位集合) 都必须与独立参照实现逐位一致
  let checked = 0;
  for (const capacity of CAPACITIES) {
    for (let fromSeat = -1; fromSeat < capacity; fromSeat += 1) {
      for (let bitmap = 1; bitmap < 1 << capacity; bitmap += 1) {
        const eligible = seatIndicesFromBitmap(capacity, bitmap);
        const where = `容量 ${capacity} / fromSeat ${fromSeat} / 合格 [${eligible.join(',')}]`;
        assert.equal(
          nextButtonSeat(fromSeat, eligible),
          referenceNextButtonSeat(capacity, fromSeat, eligible),
          `${where}: 必须等于独立参照实现`,
        );
        assert.ok(eligible.includes(nextButtonSeat(fromSeat, eligible)), `${where}: 必须落在合格座位上`);
        checked += 1;
      }
    }
  }
  assert.equal(
    checked,
    (9 + 1) * ((1 << 9) - 1) + (6 + 1) * ((1 << 6) - 1),
    '穷举交叉验证的用例数',
  );

  console.log(`[§84 穷举] (fromSeat × 合格座位集合) 交叉验证 ${checked} 组`);
});

/* ============================================================
 * §81 满桌兼容
 * ============================================================ */

test('§81 满桌兼容：6 座 / 9 座、每一个 Button 位置，新拓扑逐位复现旧实现', () => {
  for (const capacity of CAPACITIES) {
    const ring = POSITION_ORDER[capacity];
    const allSeats = seatRange(0, capacity);

    for (const button of ring) {
      const where = `容量 ${capacity} / Button ${button}`;
      const topology = handTopologySeats(capacity, ring, button);

      assert.equal(topology.handedness, capacity, `${where}: 满桌时本手人数 = 容量`);
      assert.equal(topology.buttonAlsoPostsSmallBlind, false, `${where}: 满桌绝不可能是单挑`);

      // 翻牌前：从第一个行动者出发绕一圈 == 旧 preflopOrder
      assert.deepEqual(
        positionsByWalkingFrom(capacity, topology.firstToActSeatIndex, allSeats),
        preflopOrder(capacity, button),
        `${where}: 翻牌前顺序必须与旧实现逐位一致`,
      );
      // 翻牌后：从小盲出发绕一圈 == 旧 postflopOrder
      assert.deepEqual(
        positionsByWalkingFrom(capacity, topology.smallBlindSeatIndex, allSeats),
        postflopOrder(capacity, button),
        `${where}: 翻牌后顺序必须与旧实现逐位一致`,
      );
      // 盲注位 == 旧 blindsOf
      const legacyBlinds = blindsOf(capacity, button);
      assert.equal(ring[topology.smallBlindSeatIndex], legacyBlinds.sb, `${where}: 小盲位`);
      assert.equal(ring[topology.bigBlindSeatIndex], legacyBlinds.bb, `${where}: 大盲位`);
    }

    // 需求点名的 Button = BTN：位置名还必须与物理座位环逐位一致
    const btnTopology = handTopologySeats(capacity, ring, Position.BTN);
    assert.deepEqual(
      positionsByWalkingFrom(capacity, btnTopology.firstToActSeatIndex, allSeats),
      preflopOrder(capacity, Position.BTN),
      `容量 ${capacity} / Button BTN：翻牌前顺序`,
    );
    assert.deepEqual(
      positionsByWalkingFrom(capacity, btnTopology.smallBlindSeatIndex, allSeats),
      postflopOrder(capacity, Position.BTN),
      `容量 ${capacity} / Button BTN：翻牌后顺序`,
    );
    const legacyBtn = blindsOf(capacity, Position.BTN);
    assert.equal(ring[btnTopology.smallBlindSeatIndex], legacyBtn.sb, `容量 ${capacity} / Button BTN：小盲位`);
    assert.equal(ring[btnTopology.bigBlindSeatIndex], legacyBtn.bb, `容量 ${capacity} / Button BTN：大盲位`);
    ring.forEach((position, seatIndex) => {
      assert.equal(
        btnTopology.roleBySeatIndex[seatIndex],
        position,
        `容量 ${capacity} / Button BTN：${seatIndex} 号座位的角色必须是 ${position}`,
      );
    });

    console.log(
      `[§81] 容量 ${capacity}：满桌 ${capacity} 个 Button 位置全部复现 preflopOrder / postflopOrder / blindsOf`,
    );
  }
});

/* ============================================================
 * §85 真实牌局不变量（createGame）
 * ============================================================ */

type BuildOptions = {
  /** 每人起始筹码 */
  stack?: number;
  /** 小盲座位的起始筹码（用于短筹码用例） */
  smallBlindStack?: number;
  /** 大盲座位的起始筹码（用于短筹码用例） */
  bigBlindStack?: number;
  /** 前注 */
  ante?: number;
};

/**
 * 用「**给定的一组位置** + 指定 Button 位置」造一手真实牌局。
 *
 * ⚠️ 这里必须说清一件容易被误解的事：
 * 本项目的「座位下标」**由位置名推出**（`seatIndexOfPosition`）——
 * 6 座桌上 `BTN` 永远是 3 号座位，9 座桌上永远是 6 号座位。
 * 因此**不存在**「把 BTN 挪到 0 号座位」这种构造；
 * 能自由选择的只有「哪些位置有人」与「谁当 Button」这两件事。
 */
function buildGameFromPositions(
  capacity: Capacity,
  positions: readonly Position[],
  dealerPosition: Position,
  options: BuildOptions = {},
): GameState {
  assert.ok(positions.length >= 2, '本手至少需要 2 个位置');
  assert.equal(new Set(positions).size, positions.length, '位置不得重复');
  assert.ok(positions.includes(dealerPosition), `Button 位置 ${dealerPosition} 必须在参与者里`);

  // 盲注座位由「容量 + 参与者 + Button」推出（单挑时 Button 本人是小盲）
  const topology = handTopologySeats(capacity, positions, dealerPosition);
  const stack = options.stack ?? DEFAULT_STACK;

  const players: PlayerSeed[] = positions.map((position) => {
    const seatIndex = seatIndexOfPosition(capacity, position);
    const startingStack =
      seatIndex === topology.smallBlindSeatIndex
        ? (options.smallBlindStack ?? stack)
        : seatIndex === topology.bigBlindSeatIndex
          ? (options.bigBlindStack ?? stack)
          : stack;
    return {
      id: `seat${seatIndex}`,
      name: `${seatIndex} 号座位`,
      position,
      startingStack,
    };
  });

  return createGame({
    id: `topology-${capacity}-${positions.length}-${dealerPosition}`,
    config: {
      tableSize: capacity,
      smallBlind: SMALL_BLIND,
      bigBlind: BIG_BLIND,
      ante: options.ante ?? 0,
      dealerPosition,
    },
    players,
    userPlayerId: players[0]!.id,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

/**
 * §85 主用例：`canonicalRolesOf(n)` 的 n 个角色落到该容量的座位环上。
 *
 * 这是「真实的一手牌」：位置名就是角色名。
 * 注意 9 座桌上 2 / 6 / 7 / 8 人本手的占位**天然是非连续的**
 * （规范角色表不是 9 座环的一段连续弧）—— 这正是 §83 要证明的能力。
 */
function buildCanonicalGame(
  capacity: Capacity,
  handedness: number,
  dealerPosition: Position = Position.BTN,
  options: BuildOptions = {},
): GameState {
  const roles = canonicalRolesOf(handedness);
  assert.equal(roles.length, handedness, `canonicalRolesOf(${handedness}) 必须恰好 ${handedness} 个角色`);
  return buildGameFromPositions(capacity, roles, dealerPosition, options);
}

/**
 * §85 补充用例：**连续**座位弧（座位环上最后 n 个座位）。
 *
 * 3 人及以上时 Button 恰好是环上的 `BTN`（容量 − 3）；
 * 2 人时连续弧 [SB, BB] 里没有 `BTN`，因此 Button 落在 `SB` 座位上 ——
 * 盲注角色仍由拓扑决定（Button 本人下小盲），这正是「位置名 ≠ 盲注角色」的例子。
 */
function buildArcGame(capacity: Capacity, handedness: number, options: BuildOptions = {}): GameState {
  const ring = POSITION_ORDER[capacity];
  const seats = seatRange(capacity - handedness, handedness);
  const positions = seats.map((seatIndex) => ring[seatIndex]!);
  const dealerSeatIndex = handedness === 2 ? capacity - 2 : capacity - 3;
  return buildGameFromPositions(capacity, positions, ring[dealerSeatIndex]!, options);
}

/** 占位是否是座位环上的一段连续弧 */
function isContiguousArc(capacity: Capacity, seatIndices: readonly number[]): boolean {
  const sorted = [...seatIndices].sort((a, b) => a - b);
  if (sorted.length === capacity) return true;
  return sorted.every((seatIndex, offset) => offset === 0 || seatIndex === sorted[offset - 1]! + 1);
}

/** 取本手的小盲 / 大盲玩家（由拓扑座位推得，不依赖位置名） */
function blindPlayersOf(state: GameState): { sb: GameState['players'][number]; bb: GameState['players'][number] } {
  const capacity: Capacity = state.config.tableSize;
  const topology = stateTopology(state);
  const sb = state.players.find(
    (player) => seatIndexOfPosition(capacity, player.position) === topology.smallBlindSeatIndex,
  );
  const bb = state.players.find(
    (player) => seatIndexOfPosition(capacity, player.position) === topology.bigBlindSeatIndex,
  );
  assert.ok(sb !== undefined, `小盲座位 ${topology.smallBlindSeatIndex} 上必须有玩家`);
  assert.ok(bb !== undefined, `大盲座位 ${topology.bigBlindSeatIndex} 上必须有玩家`);
  return { sb: sb!, bb: bb! };
}

/** 对一手 `createGame` 出来的牌局断言 §85 的全部不变量 */
function assertCreatedGameInvariants(state: GameState, where: string): void {
  const capacity: Capacity = state.config.tableSize;
  const topology = stateTopology(state);
  const { sb: sbPlayer, bb: bbPlayer } = blindPlayersOf(state);

  // 前注先扣、盲注后扣：可投入的筹码是「起始筹码 − 前注」
  const sbAvailable = sbPlayer.startingStack - sbPlayer.ante;
  const bbAvailable = bbPlayer.startingStack - bbPlayer.ante;
  const sbPosted = Math.min(SMALL_BLIND, sbAvailable);
  const bbPosted = Math.min(BIG_BLIND, bbAvailable);

  /* ---------- 盲注：投入、剩余、全下、当前注额、底池 ---------- */

  assert.equal(sbPlayer.committedByStreet.PREFLOP, sbPosted, `${where}: 小盲必须投入 ${sbPosted}`);
  assert.equal(bbPlayer.committedByStreet.PREFLOP, bbPosted, `${where}: 大盲必须投入 ${bbPosted}`);
  assert.equal(
    sbPlayer.remainingStack,
    sbPlayer.startingStack - sbPlayer.ante - sbPosted,
    `${where}: 小盲剩余筹码（起始 − 前注 − 小盲）`,
  );
  assert.equal(
    bbPlayer.remainingStack,
    bbPlayer.startingStack - bbPlayer.ante - bbPosted,
    `${where}: 大盲剩余筹码（起始 − 前注 − 大盲）`,
  );
  assert.equal(
    sbPlayer.allIn,
    sbPosted === sbAvailable,
    `${where}: 筹码不足一个小盲时必须全下`,
  );
  assert.equal(
    bbPlayer.allIn,
    bbPosted === bbAvailable,
    `${where}: 筹码不足一个大盲时必须全下`,
  );
  /*
   * 🔴 翻牌前的入池代价 = **一个大盲**，不是「两个盲注实际投入的较大者」。
   *
   * 这条断言在 2026-09 被改正。旧写法是 `Math.max(sbPosted, bbPosted)`，
   * 理由是「大盲投多少就是多少」—— 但那只在**大盲投满**时成立。
   * 大盲不足额全下（短码）时，`bbPosted < bigBlind`，
   * 于是旧写法把入池代价拉到**大盲以下**：其他人可以半价入池，
   * 最小加注也跟着变小。
   *
   * 规则：大盲不足额全下**不改变**入池代价 —— 其他人仍须跟满一个大盲，
   * 最小加注仍到大盲的两倍。因此下界是 `bigBlind`。
   *
   * （`max` 仍然保留：小盲理论上可能因前注/特殊结构投超，那时不该调小。）
   */
  assert.equal(
    state.currentBet,
    Math.max(state.config.bigBlind, sbPosted, bbPosted),
    `${where}: currentBet 至少是一个大盲 —— 短大盲不得降低入池代价`,
  );
  assert.equal(
    state.actions.filter((action) => action.type === ActionType.POST_SB).length,
    1,
    `${where}: 小盲动作记录必须恰好一条`,
  );
  assert.equal(
    state.actions.filter((action) => action.type === ActionType.POST_BB).length,
    1,
    `${where}: 大盲动作记录必须恰好一条`,
  );
  if (sbPosted === SMALL_BLIND && bbPosted === BIG_BLIND) {
    assert.equal(state.currentBet, BIG_BLIND, `${where}: 筹码充足时 currentBet 必须恰好是一个大盲`);
  }
  assert.equal(state.lastRaiseSize, BIG_BLIND, `${where}: 初始最小加注增量 = 一个大盲`);
  const anteTotal = state.players.reduce((sum, player) => sum + player.ante, 0);
  assert.equal(
    computePot(state),
    anteTotal + sbPosted + bbPosted,
    `${where}: 底池 = 前注合计 + 两个盲注`,
  );

  /* ---------- 行动顺序：每位玩家恰好一次，起点正确 ---------- */

  const order = streetOrder(state);
  assert.equal(order.length, state.players.length, `${where}: 行动顺序必须包含每位玩家恰好一次`);
  assert.deepEqual(
    order.map((player) => player.id).sort(),
    state.players.map((player) => player.id).sort(),
    `${where}: 行动顺序的成员集合必须等于玩家集合`,
  );
  assert.equal(
    seatIndexOfPosition(capacity, order[0]!.position),
    topology.firstToActSeatIndex,
    `${where}: 翻牌前第一个行动者的座位`,
  );
  if (topology.handedness >= 3) {
    // 3 人及以上：翻牌后从小盲开始（单挑的翻牌后起点见 §86）
    const flopStart = streetOrder({ ...state, street: Street.FLOP })[0]!;
    assert.equal(
      seatIndexOfPosition(capacity, flopStart.position),
      topology.smallBlindSeatIndex,
      `${where}: 翻牌后的第一个行动者（3 人及以上为小盲）`,
    );
  }

  /* ---------- 行动队列：无重复、无弃牌、无全下 ---------- */

  const queue = [...state.pendingQueue];
  assert.equal(new Set(queue).size, queue.length, `${where}: 行动队列不得出现重复玩家（${queue.join(',')}）`);
  const expectedQueue = order
    .filter((player) => !player.folded && !player.allIn && player.remainingStack > 0)
    .map((player) => player.id);
  assert.deepEqual(queue, expectedQueue, `${where}: 行动队列 = 未弃牌 / 未全下 / 仍有筹码的玩家按行动顺序`);
  assert.equal(
    queue.some((id) => {
      const player = playerById(state, id);
      return player === undefined || player.folded || player.allIn;
    }),
    false,
    `${where}: 行动队列不得包含弃牌、全下或不存在的玩家`,
  );
  if (!bbPlayer.allIn && bbPlayer.remainingStack > 0) {
    assert.equal(
      queue[queue.length - 1],
      bbPlayer.id,
      `${where}: 翻牌前大盲最后行动`,
    );
  }
}

test('§85 真实牌局：容量 × 本手人数 × 每一个 Button 座位，全部不变量', () => {
  let games = 0;
  let seatsCovered = 0;
  let nonContiguousGames = 0;

  for (const capacity of CAPACITIES) {
    for (let handedness = 2; handedness <= capacity; handedness += 1) {
      const roles = canonicalRolesOf(handedness);
      const expectedSeats = roles
        .map((role) => seatIndexOfPosition(capacity, role))
        .sort((a, b) => a - b);
      if (!isContiguousArc(capacity, expectedSeats)) nonContiguousGames += 1;

      for (const dealer of roles) {
        const where = `容量 ${capacity} / ${handedness} 人 / Button=${dealer}（canonicalRolesOf 落到座位环上）`;
        const state = buildCanonicalGame(capacity, handedness, dealer);

        // 位置 → 座位环 的映射本身必须与拓扑一致
        const topology = stateTopology(state);
        assert.equal(topology.handedness, handedness, `${where}: 本手人数`);
        assert.deepEqual(
          [...topology.participantSeatIndices],
          expectedSeats,
          `${where}: 参与者座位必须是 canonicalRolesOf(${handedness}) 在座位环上的下标`,
        );
        assert.equal(
          topology.buttonSeatIndex,
          seatIndexOfPosition(capacity, dealer),
          `${where}: Button 座位必须等于该位置的座位下标`,
        );
        // 用拓扑契约再验一遍同一组输入（§83 的不变量在真实牌局里同样成立）
        assertTopologyContract(
          capacity,
          topology.participantSeatIndices,
          topology.buttonSeatIndex,
          `${where}（契约复核）`,
        );

        if (dealer === Position.BTN && handedness >= 3) {
          // 位置名只在「Button 恰好是 BTN」时与拓扑角色同名；
          // 单挑时的位置名问题见 §83【真实缺陷】
          roles.forEach((role) => {
            assert.equal(
              topology.roleBySeatIndex[seatIndexOfPosition(capacity, role)],
              role,
              `${where}: ${role} 座位的角色必须仍是 ${role}`,
            );
          });
        }

        assertCreatedGameInvariants(state, where);
        games += 1;
        seatsCovered += state.players.length;
      }
    }
  }

  // Σ_{n=2..6} n = 20；Σ_{n=2..9} n = 44
  assert.equal(games, 20 + 44, '容量 6 与 9 的「本手人数 × Button 座位」组合总数必须是 64');
  assert.ok(
    nonContiguousGames >= 4,
    `必须包含非连续占位的真实牌局（9 座桌 2/6/7/8 人 + 6 座桌 2 人），实际 ${nonContiguousGames} 种`,
  );
  console.log(
    `[§85] ${games} 手真实牌局、${seatsCovered} 个座位拓扑全部通过；` +
      `其中 ${nonContiguousGames} 种「本手人数」在座位环上是非连续占位`,
  );
});

test('§85 连续座位弧：座位环上最后 n 个座位（每一种本手人数都有一段连续弧）', () => {
  let games = 0;

  for (const capacity of CAPACITIES) {
    for (let handedness = 2; handedness <= capacity; handedness += 1) {
      const state = buildArcGame(capacity, handedness);
      const where = `容量 ${capacity} / ${handedness} 人 / 连续座位弧`;
      const topology = stateTopology(state);
      const expectedSeats = seatRange(capacity - handedness, handedness);

      assert.deepEqual(
        [...topology.participantSeatIndices],
        expectedSeats,
        `${where}: 参与者必须恰好是座位环上最后 ${handedness} 个连续座位`,
      );
      assert.equal(isContiguousArc(capacity, expectedSeats), true, `${where}: 本用例必须是连续占位`);
      // 连续弧里 Button 必然是小盲座位之后第 3 个座位（2 人时 Button 就在弧首的小盲座位上）
      assert.equal(
        topology.smallBlindSeatIndex,
        capacity - 2,
        `${where}: 小盲必须是环上倒数第二个座位`,
      );
      assert.equal(topology.bigBlindSeatIndex, capacity - 1, `${where}: 大盲必须是环上最后一个座位`);

      assertTopologyContract(
        capacity,
        topology.participantSeatIndices,
        topology.buttonSeatIndex,
        `${where}（契约复核）`,
      );
      assertCreatedGameInvariants(state, where);
      games += 1;
    }
  }

  assert.equal(games, 5 + 8, '容量 6 的 5 种人数 + 容量 9 的 8 种人数');
  console.log(`[§85 连续弧] ${games} 手连续占位牌局全部通过`);
});

test('§85 短筹码盲注：不足一个盲注时即为全下，但入池代价仍是一个完整大盲', () => {
  for (const capacity of CAPACITIES) {
    for (const handedness of [3, capacity]) {
      const shortSmallBlind = buildCanonicalGame(capacity, handedness, Position.BTN, {
        smallBlindStack: 500,
      });
      const shortSbWhere = `容量 ${capacity} / ${handedness} 人 / 小盲只有 500`;
      assertCreatedGameInvariants(shortSmallBlind, shortSbWhere);
      const shortSbBlinds = blindPlayersOf(shortSmallBlind);
      assert.equal(shortSbBlinds.sb.allIn, true, `${shortSbWhere}: 小盲必须全下`);
      assert.equal(shortSbBlinds.sb.committedByStreet.PREFLOP, 500, `${shortSbWhere}: 小盲只能投入 500`);
      assert.equal(shortSmallBlind.currentBet, BIG_BLIND, `${shortSbWhere}: 大盲下满时 currentBet 仍是一个大盲`);
      assert.equal(
        shortSmallBlind.pendingQueue.includes(shortSbBlinds.sb.id),
        false,
        `${shortSbWhere}: 全下的小盲不得留在行动队列里`,
      );

      const shortBigBlind = buildCanonicalGame(capacity, handedness, Position.BTN, {
        bigBlindStack: 1200,
      });
      const shortBbWhere = `容量 ${capacity} / ${handedness} 人 / 大盲只有 1200`;
      assertCreatedGameInvariants(shortBigBlind, shortBbWhere);
      const shortBbBlinds = blindPlayersOf(shortBigBlind);
      assert.equal(shortBbBlinds.bb.allIn, true, `${shortBbWhere}: 大盲必须全下`);
      assert.equal(shortBbBlinds.bb.committedByStreet.PREFLOP, 1200, `${shortBbWhere}: 大盲只能投入 1200`);
      /*
       * 🔴 2026-09 改正：`currentBet` **不是**「大盲实际投入的 1200」。
       *
       * 大盲不足额全下**不改变入池代价** —— 其他人仍须跟满一个大盲（2000），
       * 最小加注仍到大盲的两倍（4000）。旧断言写 1200，等于把
       * 「其他人可以半价入池」这条错误规则固化下来。
       */
      assert.equal(
        shortBigBlind.currentBet,
        BIG_BLIND,
        `${shortBbWhere}: 入池代价仍是一个完整大盲（${BIG_BLIND}），不因大盲投不满而降低`,
      );
      assert.equal(
        shortBigBlind.pendingQueue.includes(shortBbBlinds.bb.id),
        false,
        `${shortBbWhere}: 全下的大盲不得留在行动队列里`,
      );
    }
  }
});

test('§85 前注：独立记账，不影响盲注金额与 currentBet', () => {
  const ante = 250;
  for (const capacity of CAPACITIES) {
    const state = buildCanonicalGame(capacity, capacity, Position.BTN, { ante });
    const where = `容量 ${capacity} / 满桌 / 前注 ${ante}`;
    assertCreatedGameInvariants(state, where);
    for (const player of state.players) {
      assert.equal(player.ante, ante, `${where}: 每位玩家的前注必须是 ${ante}（${player.name}）`);
    }
    const blinds = blindPlayersOf(state);
    assert.equal(blinds.sb.committedByStreet.PREFLOP, SMALL_BLIND, `${where}: 前注不得混进街内投入（小盲）`);
    assert.equal(blinds.bb.committedByStreet.PREFLOP, BIG_BLIND, `${where}: 前注不得混进街内投入（大盲）`);
    assert.equal(state.currentBet, BIG_BLIND, `${where}: currentBet 仍是一个大盲`);
    assert.equal(
      computePot(state),
      capacity * ante + SMALL_BLIND + BIG_BLIND,
      `${where}: 底池 = 前注合计 + 两个盲注`,
    );
  }
});

test('§85 弃牌者：streetOrder 保留全部玩家（引擎靠它定位行动者），行动队列才排除', () => {
  for (const capacity of CAPACITIES) {
    const state = buildCanonicalGame(capacity, capacity);
    const folderId = state.pendingQueue[0]!;
    const folded = applyAction(state, { playerId: folderId, type: ActionType.FOLD });
    if (!folded.ok) assert.fail(`弃牌必须被接受：${folded.issues.map((issue) => issue.code).join('/')}`);
    const after = folded.state;

    assert.equal(
      streetOrder(after).length,
      capacity,
      `容量 ${capacity}: streetOrder 必须保留全部玩家（engine.rebuildPendingQueue 依赖含弃牌者的完整顺序）`,
    );
    assert.equal(
      streetOrder(after).some((player) => player.id === folderId),
      true,
      `容量 ${capacity}: 弃牌者仍必须在 streetOrder 里（否则定位行动者会错位）`,
    );
    assert.equal(after.pendingQueue.includes(folderId), false, `容量 ${capacity}: 行动队列必须排除弃牌者`);
    assert.equal(
      new Set(after.pendingQueue).size,
      after.pendingQueue.length,
      `容量 ${capacity}: 行动队列不得出现重复玩家`,
    );
    assert.equal(
      after.pendingQueue.some((id) => playerById(after, id)!.folded),
      false,
      `容量 ${capacity}: 行动队列里不能有弃牌者`,
    );
  }
});

/* ============================================================
 * §86 单挑
 * ============================================================ */

test('§86 单挑：Button 位下小盲、另一位下大盲、翻牌前 Button 先行动', () => {
  let cases = 0;
  for (const capacity of CAPACITIES) {
    /**
     * 两种单挑构造：
     * 1. 规范映射：位置为 [BTN, BB]，Button = BTN（座位环上 SB 的座位是空的）
     * 2. 连续弧：位置为 [SB, BB]，Button = SB（座位环上最后两个座位，连续占位）
     * 两者都必须满足「Button 下小盲、另一位下大盲」。
     */
    const configurations: ReadonlyArray<{ positions: readonly Position[]; dealer: Position }> = [
      { positions: [Position.BTN, Position.BB], dealer: Position.BTN },
      { positions: [Position.SB, Position.BB], dealer: Position.SB },
    ];

    for (const { positions, dealer } of configurations) {
      const where = `容量 ${capacity} / 位置 [${positions.join(',')}] / Button=${dealer}`;
      const state = buildGameFromPositions(capacity, positions, dealer);
      const topology = stateTopology(state);
      const buttonPlayer = state.players.find((player) => player.position === dealer);
      const opponent = state.players.find((player) => player.position !== dealer);
      assert.ok(
        buttonPlayer !== undefined && opponent !== undefined,
        `${where}: 单挑必须恰好两位玩家`,
      );
      if (!buttonPlayer || !opponent) continue;

      assert.equal(topology.handedness, 2, `${where}: 本手人数必须是 2`);
      assert.equal(topology.buttonAlsoPostsSmallBlind, true, `${where}: 必须标记「Button 同时下小盲」`);
      assert.equal(
        topology.smallBlindSeatIndex,
        topology.buttonSeatIndex,
        `${where}: 单挑的小盲座位必须就是 Button 座位`,
      );
      assert.notEqual(topology.bigBlindSeatIndex, topology.buttonSeatIndex, `${where}: 大盲必须是另一个座位`);
      assert.equal(topology.firstToActSeatIndex, topology.buttonSeatIndex, `${where}: 翻牌前第一个行动者是 Button`);

      // 盲注：Button 下小盲，另一位下大盲
      const posts = state.actions.filter(
        (action) => action.type === ActionType.POST_SB || action.type === ActionType.POST_BB,
      );
      assert.equal(posts.length, 2, `${where}: 必须恰好两条盲注记录`);
      const smallBlindPost = posts.find((action) => action.type === ActionType.POST_SB)!;
      const bigBlindPost = posts.find((action) => action.type === ActionType.POST_BB)!;
      assert.equal(smallBlindPost.playerId, buttonPlayer.id, `${where}: 下小盲的必须是 Button`);
      assert.equal(bigBlindPost.playerId, opponent.id, `${where}: 下大盲的必须是另一位`);
      assert.equal(smallBlindPost.amount, SMALL_BLIND, `${where}: 小盲金额`);
      assert.equal(bigBlindPost.amount, BIG_BLIND, `${where}: 大盲金额`);
      assert.equal(buttonPlayer.committedByStreet.PREFLOP, SMALL_BLIND, `${where}: Button 的翻牌前投入 = 小盲`);
      assert.equal(opponent.committedByStreet.PREFLOP, BIG_BLIND, `${where}: 对手的翻牌前投入 = 大盲`);
      assert.equal(state.currentBet, BIG_BLIND, `${where}: currentBet = 大盲`);

      // 翻牌前：Button 先行动，大盲最后
      assert.deepEqual(
        state.pendingQueue,
        [buttonPlayer.id, opponent.id],
        `${where}: 翻牌前队列必须是 [Button, 大盲]`,
      );
      assert.equal(streetOrder(state)[0]!.id, buttonPlayer.id, `${where}: streetOrder 的首位是 Button`);

      cases += 1;
    }
  }
  assert.equal(cases, 2 * 2, '两种单挑构造 × 两种容量');
  console.log(`[§86] 单挑盲注与翻牌前顺序：${cases} 种构造（6 座 / 9 座 × 规范映射 / 连续弧）全部通过`);
});

/**
 * ---------------------------------------------------------------------------
 * 🔴【真实缺陷·预期失败】§86 单挑**翻牌后**必须由大盲先行动
 *
 * 扑克规则：单挑时 Button 是小盲，**翻牌后永远最后行动**（大盲先行动）。
 * 本项目自己的文档也写着「翻牌后由小盲位开始，庄家最后行动」——
 * 单挑时这两句话冲突，唯一正确的解法是「庄家最后」，也就是「大盲先」。
 *
 * 现状：`streetOrder` 翻牌后从 `topology.smallBlindSeatIndex` 开始，
 * 而单挑时该座位就是 Button 本人 → 翻牌后变成 **Button 先行动**，
 * 并且 `resetStreetState` 会把同样的顺序写进 `pendingQueue`（真正的行动队列）。
 *
 * 最小复现（6 座桌，BTN 在 3 号座位、BB 在 5 号座位）：
 * ```
 * 翻牌前：Button 跟注 1000 → 大盲过牌 → advanceStreet(翻牌)
 * 翻牌后 pendingQueue = ['seat3', 'seat5']   ← 实际：Button 先行动
 *                       ['seat5', 'seat3']   ← 期望：大盲先行动
 * ```
 * ---------------------------------------------------------------------------
 */
test('§86【真实缺陷·预期失败】单挑翻牌后必须先问大盲，Button 最后行动', () => {
  const state = buildCanonicalGame(6, 2); // BTN 在 3 号座位、BB 在 5 号座位
  const topology = stateTopology(state);
  const buttonPlayer = state.players.find((player) => player.position === Position.BTN)!;
  const opponent = state.players.find((player) => player.position === Position.BB)!;

  const called = applyAction(state, {
    playerId: buttonPlayer.id,
    type: ActionType.CALL,
    amount: BIG_BLIND - SMALL_BLIND,
  });
  if (!called.ok) assert.fail(`Button 跟注必须被接受：${called.issues.map((issue) => issue.code).join('/')}`);
  const checked = applyAction(called.state, { playerId: opponent.id, type: ActionType.CHECK });
  if (!checked.ok) assert.fail(`大盲过牌必须被接受：${checked.issues.map((issue) => issue.code).join('/')}`);
  const advanced = advanceStreet(checked.state, { cards: FLOP_CARDS });
  if (!advanced.ok) assert.fail(`推进到翻牌必须成功：${advanced.issues.map((issue) => issue.code).join('/')}`);

  const flop = advanced.state;
  assert.equal(flop.street, Street.FLOP, '必须已经推进到翻牌');
  assert.equal(
    flop.phase,
    'BETTING',
    '翻牌后仍应处于下注阶段（两人都还有筹码）',
  );

  console.log(
    `[§86 缺陷] 单挑翻牌后：streetOrder = ${JSON.stringify(streetOrder(flop).map((player) => player.position))}，` +
      `pendingQueue = ${JSON.stringify(flop.pendingQueue)}，` +
      `小盲座位 ${topology.smallBlindSeatIndex}（= Button 座位），大盲座位 ${topology.bigBlindSeatIndex}`,
  );

  assert.equal(
    flop.pendingQueue[0],
    opponent.id,
    '单挑翻牌后必须由大盲先行动（Button 最后）—— 当前实现从 Button（小盲）开始，顺序反了',
  );
  assert.equal(
    streetOrder(flop)[0]!.id,
    opponent.id,
    '单挑翻牌后的行动顺序必须以大盲开头',
  );
});

/* ============================================================
 * §87 失败即关闭
 * ============================================================ */

test('§87 失败即关闭：createGame / handTopologySeats / occupiedSeatIndices 的非法输入全部抛错', () => {
  const seed = (id: string, position: Position, startingStack = DEFAULT_STACK): PlayerSeed => ({
    id,
    name: id,
    position,
    startingStack,
  });
  const configOf = (tableSize: Capacity): GameConfig => ({
    tableSize,
    smallBlind: SMALL_BLIND,
    bigBlind: BIG_BLIND,
    ante: 0,
    dealerPosition: Position.BTN,
  });
  const fullPlayers = (capacity: Capacity): PlayerSeed[] =>
    POSITION_ORDER[capacity].map((position, index) => seed(`s${index}`, position));

  /* ---------- 人数：0 / 1 / 超过容量 ---------- */

  assert.throws(
    () => createGame({ config: configOf(6), players: [], userPlayerId: 's0' }),
    /本手人数必须在 2~6 之间/,
    '0 位玩家必须被拒绝',
  );
  assert.throws(
    () => createGame({ config: configOf(6), players: [seed('s0', Position.BTN)], userPlayerId: 's0' }),
    /本手人数必须在 2~6 之间/,
    '1 位玩家必须被拒绝（本手至少 2 人）',
  );
  assert.throws(
    () => createGame({ config: configOf(9), players: [seed('s0', Position.BTN)], userPlayerId: 's0' }),
    /本手人数必须在 2~9 之间/,
    '9 座桌 1 位玩家必须被拒绝',
  );
  // 7 个人塞进 6 座桌：多出来的座位只能与既有座位重名，因此「计数检查」必须先于「重名检查」
  assert.throws(
    () =>
      createGame({
        config: configOf(6),
        players: [...fullPlayers(6), seed('extra', Position.BB)],
        userPlayerId: 's0',
      }),
    /本手人数必须在 2~6 之间/,
    '超过容量的本手人数必须被拒绝',
  );
  assert.throws(
    () =>
      createGame({
        config: configOf(9),
        players: [...fullPlayers(9), seed('extra', Position.BB)],
        userPlayerId: 's0',
      }),
    /本手人数必须在 2~9 之间/,
    '9 座桌 10 位玩家必须被拒绝',
  );

  /* ---------- 位置：重复 / 不在该容量的座位环上 ---------- */

  assert.throws(
    () =>
      createGame({
        config: configOf(6),
        players: [
          seed('s0', Position.UTG),
          seed('s1', Position.UTG),
          seed('s2', Position.CO),
          seed('s3', Position.BTN),
          seed('s4', Position.SB),
        ],
        userPlayerId: 's0',
      }),
    /位置重复 UTG/,
    '重复位置必须被拒绝',
  );
  assert.throws(
    () =>
      createGame({
        config: configOf(6),
        players: [seed('s0', Position.LJ), seed('s1', Position.BB)],
        userPlayerId: 's0',
      }),
    /不存在位置 LJ/,
    '6 座桌不得接受只在 9 座桌上存在的 LJ',
  );

  /* ---------- 其它配置级错误 ---------- */

  assert.throws(
    () => createGame({ config: configOf(6), players: fullPlayers(6), userPlayerId: 'ghost' }),
    /不在玩家列表中/,
    '用户玩家不在列表里必须被拒绝',
  );
  assert.throws(
    () =>
      createGame({
        config: configOf(6),
        players: [seed('s0', Position.BTN, -1), seed('s1', Position.BB)],
        userPlayerId: 's0',
      }),
    /起始筹码为负/,
    '负起始筹码必须被拒绝',
  );
  assert.throws(
    () =>
      createGame({
        config: { ...configOf(6), smallBlind: BIG_BLIND, bigBlind: SMALL_BLIND },
        players: fullPlayers(6),
        userPlayerId: 's0',
      }),
    /盲注不合法/,
    '大盲不大于小盲必须被拒绝',
  );
  assert.throws(
    () =>
      createGame({
        config: { ...configOf(6), ante: -1 },
        players: fullPlayers(6),
        userPlayerId: 's0',
      }),
    /前注不能为负/,
    '负前注必须被拒绝',
  );

  /* ---------- 拓扑层：参与者不足 / Button 不在参与者里 / 座位不在环上 ---------- */

  assert.throws(
    () => handTopologySeats(6, [Position.BTN], Position.BTN),
    /至少需要 2 名参与者/,
    '本手只有 1 人时拓扑必须抛错',
  );
  assert.throws(
    () => handTopologySeats(6, [], Position.BTN),
    /不在本手参与者里/,
    '本手 0 人时拓扑必须抛错',
  );
  assert.throws(
    () => handTopologySeats(9, [Position.SB, Position.BB], Position.CO),
    /Button 座位 CO 不在本手参与者里/,
    'Button 座位不在参与者里必须抛错',
  );
  assert.throws(
    () => handTopologySeats(6, [Position.LJ, Position.BB], Position.LJ),
    /没有这些座位|不存在位置/,
    '座位不在该容量的环上必须抛错',
  );
  assert.throws(
    () => occupiedSeatIndices(6, [Position.LJ]),
    /没有这些座位/,
    'occupiedSeatIndices 必须拒绝不在环上的座位',
  );
  assert.throws(() => nextButtonSeat(3, []), /没有合格座位/, '没有合格座位时必须抛错');
  assert.throws(() => canonicalRolesOf(1), /不支持的本手人数/, '1 人没有规范角色表');
  assert.throws(() => canonicalRolesOf(10), /不支持的本手人数/, '10 人没有规范角色表');
});

/**
 * ---------------------------------------------------------------------------
 * 🔴【真实缺陷·预期失败】§87 `createGame` 必须拒绝重复 `playerId`
 *
 * 现状：`createGame` 只检查「位置重复」，**不检查玩家 id 重复**
 * （`validator.validateTableSetup` 里有 `seenIds` 检查，`validateGameState` 也确实会
 * 判定 `ISSUE.POSITION_DUPLICATED`、`canAnalyze = false`，但那一层在 `createGame` **之后**）。
 * 于是重复 id 会一路通过构造，并立刻产出坏状态：
 * `pendingQueue` 里出现同一个 id 两次、`playerById` 永远只返回第一位、
 * 「当前行动者」失去唯一性 —— 与 §87「失败即关闭」相反：构造期**静默**放行。
 *
 * 最小复现：
 * ```ts
 * createGame({
 *   config: { tableSize: 6, smallBlind: 1000, bigBlind: 2000, ante: 0, dealerPosition: 'BTN' },
 *   players: [
 *     { id: 'dup', name: 'A', position: 'BTN', startingStack: 200000 },
 *     { id: 'dup', name: 'B', position: 'BB',  startingStack: 200000 },
 *   ],
 *   userPlayerId: 'dup',
 * })
 * // 实际：不抛错，且 pendingQueue === ['dup', 'dup']
 * // 期望：抛错（重复 playerId）
 * ```
 * ---------------------------------------------------------------------------
 */
test('§87【真实缺陷·预期失败】createGame 必须拒绝重复 playerId', () => {
  const build = (): GameState =>
    createGame({
      config: {
        tableSize: 6,
        smallBlind: SMALL_BLIND,
        bigBlind: BIG_BLIND,
        ante: 0,
        dealerPosition: Position.BTN,
      },
      players: [
        { id: 'dup', name: 'A', position: Position.BTN, startingStack: DEFAULT_STACK },
        { id: 'dup', name: 'B', position: Position.BB, startingStack: DEFAULT_STACK },
      ],
      userPlayerId: 'dup',
    });

  try {
    const broken = build();
    console.log(
      `[§87 缺陷] createGame 接受了重复 playerId：玩家 id = ${JSON.stringify(broken.players.map((player) => player.id))}，` +
        `行动队列 = ${JSON.stringify(broken.pendingQueue)}，` +
        `playerById('dup') 返回 = ${JSON.stringify(playerById(broken, 'dup')?.name)}`,
    );
  } catch {
    // 修复之后这里会抛错 —— 那正是期望行为
  }

  assert.throws(
    build,
    /重复|duplicate/i,
    '重复 playerId 必须被拒绝 —— 否则行动队列里会出现重复 id，当前行动者失去唯一性',
  );
});

/* ============================================================
 * §112 性能
 * ============================================================ */

test('§112 性能：9 座桌 5000 次拓扑计算必须远低于 1 秒', () => {
  const ring = POSITION_ORDER[9];
  // 7 人非连续占位（空出 3 号与 7 号座位），Button 轮流落在每个参与者身上
  const participants = ring.filter((_, seatIndex) => seatIndex !== 3 && seatIndex !== 7);
  const iterations = 5000;

  // 先热身一次，避免把 JIT 首次编译的成本算进去
  handTopologySeats(9, participants, participants[0]!);

  const startedAt = process.hrtime.bigint();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    handTopologySeats(9, participants, participants[iteration % participants.length]!);
  }
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const perCallMicroseconds = (elapsedMs * 1000) / iterations;

  console.log(
    `[§112 性能] 9 座桌 ${iterations} 次拓扑计算：合计 ${elapsedMs.toFixed(2)} ms，` +
      `平均每次 ${perCallMicroseconds.toFixed(2)} µs`,
  );

  // 阈值放宽到 500ms（慢机器也能过），但若真出现数量级回归（>100µs/次）会立刻失败
  assert.ok(
    elapsedMs < 500,
    `9 座桌 ${iterations} 次拓扑计算耗时 ${elapsedMs.toFixed(2)}ms，超过 500ms 上限（平均 ${perCallMicroseconds.toFixed(2)} µs/次）`,
  );
});
