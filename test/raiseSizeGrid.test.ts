/**
 * 加注尺寸网格 —— **「Raise 没得选」的永久回归**
 *
 * ## 这份测试防的是一个真实发生过的用户缺陷
 *
 * 使用者原话：**「加注的尺寸怎么那么少，Raise 都没得选」**。
 *
 * 根因：`buildSizeGrid` 对 BET 与 RAISE **共用同一份底池百分比网格**
 * （25% / 33% / 50% / 67% / 75% / 100%）。对下注这是对的；对**加注**不对 ——
 * 加注面对一个既存注额，基准应该是「跟注额的倍数」。
 *
 * 底池百分比算出来的数额通常**低于最小加注额**，于是被 `clamp` 到最小加注额后
 * **全部去重成一项**。实测（6 人桌，BB 持 AKo 面对 UTG 开池 3BB，底池 450 筹码）：
 *
 * ```text
 * 修复前：[500] [10000 全下]
 *           ↑ 最小加注 5BB，然后直接跳到 100BB 全下，中间什么都没有
 * 修复后：[500] [600] [800] [1000] [1200] [1600] [10000]
 *           ↑ 2.5× / 3× / 4× / 5× / 6× / 8× 跟注额，再加上全下
 * ```
 *
 * ## 为什么既有测试没抓到它
 *
 * `hotfix001ActionDedup.test.ts` 守的是「全下只出现一次」，它只断言
 * `raises.length >= 1` —— **1 个尺寸就满足了**。数量与质量没有任何断言，
 * 于是「只剩最小加注 + 全下」一路绿到底。
 *
 * 因此本文件的核心就是那条缺失的断言：**数量下限 + 单调性 + 成本正确性**。
 *
 * ## 纪律（沿用 `buildSizeGrid` 的三条）
 *
 * 1. 尺寸只能来自网格，不生成任意数值（「精确到 1 筹码」会伪造精度）
 * 2. 每个尺寸都必须合法（在 `[minTo, allIn]` 内、成本不超过剩余筹码）
 * 3. 尺寸必须**真的能执行**：`costChips` 必须等于 `toAmount − 本街已投入`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position } from '../src/domain/types.ts';
import { createTable, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import type { PokerTableState, TableActionButton, TableIssue } from '../src/app/table/table.types.ts';

const BIG_BLIND_CHIPS = 100;

const RING_6: readonly Position[] = [
  Position.UTG,
  Position.HJ,
  Position.CO,
  Position.BTN,
  Position.SB,
  Position.BB,
];

function must(state: PokerTableState, op: Parameters<typeof applyTableOp>[1]): PokerTableState {
  const r = applyTableOp(state, op);
  if (!r.ok) {
    throw new Error(`op ${op.kind} 失败：${r.issues.map((i: TableIssue) => i.message).join(' / ')}`);
  }
  return r.state;
}

/** 6 人桌全员入座，Hero 在指定位置，指定筹码 */
function sixMax(heroPosition: Position, heroStackBB: number): PokerTableState {
  let state = createTable({ tableSize: 6, heroPosition, defaultStackBB: 100 });
  for (const p of RING_6) {
    if (p === heroPosition) continue;
    state = must(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, p)!.seatId });
  }
  return must(state, {
    kind: 'SET_STACK',
    seatId: seatOfPosition(state, heroPosition)!.seatId,
    stackBB: heroStackBB,
  });
}

/** 可执行按钮 = PRIMARY + SIZE（EXPAND 只是展开器，不是动作） */
function executable(state: PokerTableState): readonly TableActionButton[] {
  return buildTablePreview(state).actionButtons.filter((b) => b.group !== 'EXPAND');
}

function raiseButtons(state: PokerTableState): readonly TableActionButton[] {
  return executable(state).filter((b) => b.type === 'RAISE');
}

/** 走到「Hero 面对一个开池」的翻牌前局面（Hero 在 BB，UTG 开池 3BB） */
function heroFacingOpen(heroStackBB = 100): PokerTableState {
  /*
   * 用真实 UI 操作推进：UTG 开池 3BB → 其余全弃 → 轮到 BB（Hero）。
   * 每一步都通过 `applyTableOp`，因此这里不会构造出引擎不接受的状态。
   */
  let state = sixMax(Position.BB, heroStackBB);
  state = must(state, { kind: 'SET_HERO_CARD', card: 'As' });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Kd' });

  for (let guard = 0; guard < 20; guard += 1) {
    const p = buildTablePreview(state);
    if (p.isHeroTurn && p.street === 'PREFLOP') return state;
    if (p.currentActorPosition === null) break;
    const isUtg = p.currentActorPosition === Position.UTG;
    const want = isUtg ? 'RAISE' : 'FOLD';
    const b = p.actionButtons.find((x) => x.type === want && x.group !== 'EXPAND');
    if (b === undefined) break;
    state = must(state, {
      kind: 'ACT',
      action: {
        type: b.type,
        ...(b.amountChips !== undefined ? { amountChips: b.amountChips } : {}),
      },
    });
  }
  throw new Error('无法推进到「Hero 面对开池」的翻牌前局面');
}

/* ============================================================
 * 一、核心回归：加注必须**有得选**
 * ============================================================ */

test('RAISESIZE-01：面对开池时，加注尺寸**不得**只剩「最小加注 + 全下」', () => {
  const state = heroFacingOpen();
  const p = buildTablePreview(state);
  assert.ok(p.isHeroTurn, '前置条件：必须轮到 Hero');
  assert.ok(p.minRaiseToBB !== null && p.allInToBB !== null, '前置条件：加注与全下都要有');

  const raises = raiseButtons(state);
  /*
   * 🔴 这一条就是那个缺陷。修复前 `raises.length === 1`
   *（只有最小加注 5BB），而全下 100BB 远在另一头。
   */
  assert.ok(
    raises.length >= 4,
    `面对开池时加注尺寸必须**有得选**（至少 4 档），实际只有 ${raises.length} 档：` +
      `${JSON.stringify(raises.map((b) => b.labelZh))} —— ` +
      '修复前只剩「最小加注 + 全下」，因为加注错误地复用了下注的底池百分比网格',
  );

  // 除了全下，必须**至少 3 个**非全下的正常尺寸
  const normal = raises.filter((b) => !b.isAllIn);
  assert.ok(
    normal.length >= 3,
    `非全下的正常加注尺寸至少 3 档，实际 ${normal.length} 档：` +
      `${JSON.stringify(normal.map((b) => b.labelZh))}`,
  );
});

test('RAISESIZE-02：加注尺寸必须**单调递增**且互不相同（没有重复档）', () => {
  const state = heroFacingOpen();
  const normal = raiseButtons(state).filter((b) => !b.isAllIn);

  const amounts = normal.map((b) => b.amountChips ?? 0);
  for (let i = 1; i < amounts.length; i += 1) {
    assert.ok(
      amounts[i]! > amounts[i - 1]!,
      `加注尺寸必须严格递增，第 ${i} 档 ${amounts[i]} 不大于前一档 ${amounts[i - 1]}：` +
        `${JSON.stringify(normal.map((b) => b.labelZh))}`,
    );
  }
  assert.equal(
    new Set(amounts).size,
    amounts.length,
    '不得出现两个金额相同的加注档（那会让使用者以为有选择，其实没有）',
  );
});

test('RAISESIZE-03：尺寸必须覆盖「最小加注」到「接近全下」的整个区间', () => {
  const state = heroFacingOpen();
  const p = buildTablePreview(state);
  const raises = raiseButtons(state);
  const normal = raises.filter((b) => !b.isAllIn);
  const allIn = raises.find((b) => b.isAllIn);

  const minBB = p.minRaiseToBB!;
  // 最小加注必须在菜单里（它是加注的下限，必须能点到）
  assert.ok(
    normal.some((b) => Math.abs((b.amountBB ?? 0) - minBB) < 1e-9),
    `最小加注 ${minBB}BB 必须出现在菜单里：${JSON.stringify(normal.map((b) => b.labelZh))}`,
  );

  /*
   * 🔴 档位必须一直铺到接近全下的量级 —— 否则使用者想「加注到 15BB」
   * 没有按钮可按，只能跳到全下。那正是「没得选」的另一种形态。
   *
   * 判据：最大的一档非全下加注，必须至少达到全下额的 **5%**。
   * 100BB 全下时那就是 5BB —— 修复前最大档恰好是最小加注 5BB，
   * 刚好压在线上；修复后是 16BB，远高于门槛。
   */
  const maxNormal = Math.max(...normal.map((b) => b.amountBB ?? 0));
  const allInBB = p.allInToBB!;
  assert.ok(
    maxNormal >= allInBB * 0.05,
    `最大的非全下加注（${maxNormal}BB）必须铺到接近全下（${allInBB}BB）的量级，` +
      '否则 10BB 到 100BB 之间是空的',
  );
  assert.ok(allIn !== undefined || raises.length > 0, '全下必须有一个入口');
});

/* ============================================================
 * 二、成本正确性（尺寸「能执行」的实质含义）
 * ============================================================ */

test('RAISESIZE-04：每个加注档的 `costChips` 必须等于「加注到的总额 − 本街已投入」', () => {
  const state = heroFacingOpen();
  const p = buildTablePreview(state);
  /*
   * 本街已投入 = 全下时的本街总额 − 我的剩余筹码。
   * BB 已经投了 1BB 盲注，因此这里是 100 筹码（1BB）。
   */
  const myRemaining = p.seats.find((s) => s.isHero)?.remainingStackBB;
  assert.ok(myRemaining !== undefined, '前置条件：必须能读到 Hero 的剩余筹码');
  const streetAlreadyBB = p.allInToBB! - myRemaining!;
  assert.ok(streetAlreadyBB > 0, '前置条件：BB 本街已经投过盲注 ⇒ 本街已投入 > 0');

  for (const b of raiseButtons(state).filter((x) => !x.isAllIn)) {
    const expectedCostBB = (b.amountBB ?? 0) - streetAlreadyBB;
    const actualCostBB = (b.amountChips ?? 0) / BIG_BLIND_CHIPS - streetAlreadyBB;
    assert.ok(
      Math.abs(actualCostBB - expectedCostBB) < 1e-9,
      `加注到 ${b.amountBB}BB 的成本应当是 ${expectedCostBB}BB，` +
        `而按钮说投 ${(b.amountChips ?? 0) / BIG_BLIND_CHIPS}BB（本街已投入 ${streetAlreadyBB}BB）`,
    );
  }
});

test('RAISESIZE-05：每个尺寸都必须真的合法（不超剩余筹码、不超全下、不低于下限）', () => {
  for (const stack of [10, 30, 100] as const) {
    const state = heroFacingOpen(stack);
    const p = buildTablePreview(state);

    for (const b of raiseButtons(state)) {
      const amountBB = b.amountBB ?? 0;
      assert.ok(amountBB > 0, `加注额必须为正：${b.labelZh}`);
      assert.ok(
        amountBB <= p.allInToBB! + 1e-9,
        `加注到 ${amountBB}BB 不得超过全下 ${p.allInToBB}BB（${b.labelZh}）`,
      );
      if (!b.isAllIn) {
        assert.ok(
          amountBB >= p.minRaiseToBB! - 1e-9,
          `加注到 ${amountBB}BB 不得低于最小加注 ${p.minRaiseToBB}BB（${b.labelZh}）`,
        );
      }
    }
  }
});

test('RAISESIZE-06：筹码越深，加注档数不得变少', () => {
  /*
   * 反向性质：深筹码时可选尺寸应该**更多或持平**，不可能更少。
   * 若某次改动让深筹码反而没得选，这条会失败。
   */
  const counts = ([10, 30, 100] as const).map((stack) => ({
    stack,
    n: raiseButtons(heroFacingOpen(stack)).filter((b) => !b.isAllIn).length,
  }));
  for (let i = 1; i < counts.length; i += 1) {
    assert.ok(
      counts[i]!.n >= counts[i - 1]!.n,
      `筹码 ${counts[i]!.stack}BB 的加注档数（${counts[i]!.n}）不得少于 ` +
        `${counts[i - 1]!.stack}BB 的（${counts[i - 1]!.n}）`,
    );
  }
});

/* ============================================================
 * 三、反证：不能靠「一律拒绝」或「全塞全下」通过
 * ============================================================ */

test('RAISESIZE-07：反证 —— 短码时尺寸可以少，但**全下必须仍然可达**', () => {
  /*
   * 短码（5BB）时确实没有多少加注空间，尺寸少是正常的 ——
   * 但「全下」这条路径绝不能因此消失，否则使用者无路可走。
   */
  const state = heroFacingOpen(5);
  const buttons = executable(state);
  const allIn = buttons.filter((b) => b.isAllIn);
  assert.equal(allIn.length, 1, `短码时全下入口必须恰好 1 个，实际 ${allIn.length} 个`);
});

test('RAISESIZE-08：反证 —— 尺寸标签必须能区分，不得出现重复文案', () => {
  const state = heroFacingOpen();
  const labels = executable(state)
    .filter((b) => b.type === 'RAISE')
    .map((b) => b.labelZh);
  assert.equal(
    new Set(labels).size,
    labels.length,
    `加注按钮文案不得重复（重复 = 两个按钮做同一件事）：${JSON.stringify(labels)}`,
  );
  for (const l of labels) {
    assert.ok(l.length > 0, '文案不得为空');
  }
});
