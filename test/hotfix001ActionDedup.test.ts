/**
 * REAL-HAND HOTFIX 001 —— **UI ACTION DEDUP（BET/RAISE 尺寸 ↔ 独立 ALL_IN）**
 *
 * ## 要解决的问题
 *
 * `buildSizeGrid` **总是**把全下额放进尺寸候选（`maxTo` 是必选候选），
 * 而预览又会额外生成一个独立的 `ALL_IN` 按钮 —— 于是同一个「全下」
 * 会在界面上出现**两次**：「加注全下至 100BB」与「全下（100BB）」。
 * 使用者看到两个投进同样多筹码的按钮，无法判断差别。
 *
 * ## 纪律：全下**必须**有一个入口，且**只能有一个**
 *
 * | 情形 | 呈现 |
 * |---|---|
 * | 全下就是唯一的尺寸选择（最小下注/加注 == 全下） | 由**尺寸项**承担：`isAllIn` + 「加注全下至 X BB」，**不再**生成独立 `ALL_IN` |
 * | 还有更小的正常尺寸 | 尺寸项里**剔除**全下那一项，全下由**独立 `ALL_IN`** 承担 |
 * | 短码全下低于最小加注 | 尺寸网格被过滤成空 ⇒ **独立 `ALL_IN` 必须保留**（不得误删） |
 *
 * ⚠️ 本轮**只**改 legal action / preview 的**呈现**，不改变引擎的下注合法性契约。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position } from '../src/domain/types.ts';
import { createTable, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import type {
  PokerTableState,
  TableActionButton,
  TableIssue,
} from '../src/app/table/table.types.ts';

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

function sixMax(heroStackBB: number): PokerTableState {
  let state = createTable({ tableSize: 6, heroPosition: Position.UTG, defaultStackBB: 100 });
  for (const p of RING_6) {
    if (p === Position.UTG) continue;
    state = must(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, p)!.seatId });
  }
  // ⚠️ 必须在**本手开始之前**设筹码
  return must(state, {
    kind: 'SET_STACK',
    seatId: seatOfPosition(state, Position.UTG)!.seatId,
    stackBB: heroStackBB,
  });
}

/** 面对大盲的翻牌前状态（Hero 在 UTG，未投入盲注）⇒ 合法动作含 RAISE */
function facingBigBlind(heroStackBB: number): PokerTableState {
  let state = sixMax(heroStackBB);
  state = must(state, { kind: 'SET_HERO_CARD', card: 'As' });
  return must(state, { kind: 'SET_HERO_CARD', card: 'Kd' });
}

/**
 * 推进到**无人下注的翻牌**且轮到 Hero ⇒ 合法动作含 BET（不是 RAISE）。
 *
 * 翻牌前全体跟注/过牌；翻牌后 SB / BB 先过牌，Hero（UTG）最后行动。
 */
function unopenedFlop(heroStackBB: number, board: readonly string[]): PokerTableState {
  let state = sixMax(heroStackBB);
  state = must(state, { kind: 'SET_HERO_CARD', card: 'As' });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Kd' });
  for (const [i, card] of board.entries()) {
    state = must(state, { kind: 'SET_BOARD_CARD', card, slot: i });
  }
  for (let step = 0; step < 20; step += 1) {
    const p = buildTablePreview(state);
    if (p.street !== 'PREFLOP' && p.isHeroTurn && p.currentBetBB === 0) return state;
    if (p.currentActorPosition === null) break;
    const b = p.actionButtons.find((x) => x.type === 'CHECK' || x.type === 'CALL');
    if (b === undefined) break;
    state = must(state, {
      kind: 'ACT',
      action: {
        type: b.type,
        ...(b.amountChips !== undefined ? { amountChips: b.amountChips } : {}),
      },
    });
  }
  throw new Error('无法推进到无人下注的翻牌');
}

/** 可执行按钮 = PRIMARY + SIZE（EXPAND 只是展开器，不是动作） */
function executable(state: PokerTableState): readonly TableActionButton[] {
  return buildTablePreview(state).actionButtons.filter((b) => b.group !== 'EXPAND');
}

const allInChips = (state: PokerTableState): number =>
  Math.round(buildTablePreview(state).allInToBB! * BIG_BLIND_CHIPS);

/* ============================================================
 * §DEDUP-1 / §DEDUP-2 / §DEDUP-3 —— RAISE 场景
 * ============================================================ */

test('§DEDUP-1：最小加注 == 全下 ⇒ 恰好 1 个全下入口，且由**尺寸项**承担', () => {
  const state = facingBigBlind(2); // 全下额 = 2BB = 最小加注
  const preview = buildTablePreview(state);
  assert.equal(preview.allInToBB, 2, '前置条件：全下额必须是 2BB');
  assert.equal(preview.minRaiseToBB, 2, '前置条件：最小加注必须也是 2BB');

  const buttons = executable(state);
  const raises = buttons.filter((b) => b.type === 'RAISE');
  assert.equal(raises.length, 1, '应当恰好剩一个加注尺寸项');
  assert.equal(raises[0]!.isAllIn, true, '该尺寸项必须标成全下');
  assert.match(raises[0]!.labelZh, /全下/, `全下文案必须写明「全下」，实际「${raises[0]!.labelZh}」`);
  assert.equal(raises[0]!.amountChips, allInChips(state), '尺寸项金额必须等于全下额');

  assert.equal(
    buttons.filter((b) => b.type === 'ALL_IN').length,
    0,
    '不得再额外生成一个同金额的独立 ALL_IN',
  );
});

test('§DEDUP-2：正常加注 < 全下 ⇒ RAISE 与 ALL_IN 是**两个不同动作**，全下仍只出现一次', () => {
  const state = facingBigBlind(100); // 最小加注 2BB，全下 100BB
  const preview = buildTablePreview(state);
  assert.equal(preview.minRaiseToBB, 2, '前置条件：最小加注 2BB');
  assert.equal(preview.allInToBB, 100, '前置条件：全下 100BB');

  const buttons = executable(state);
  const raises = buttons.filter((b) => b.type === 'RAISE');
  const allIns = buttons.filter((b) => b.type === 'ALL_IN');

  assert.equal(allIns.length, 1, '必须保留独立 ALL_IN（它与所有正常尺寸都不同）');
  assert.ok(raises.length >= 1, '必须有正常的非全下加注尺寸');
  assert.equal(
    raises.some((b) => b.isAllIn),
    false,
    '既然独立 ALL_IN 已经承担全下，尺寸项里就不得再出现全下（否则全下出现两次）',
  );
  for (const r of raises) {
    assert.notEqual(r.amountChips, allInChips(state), '尺寸项金额不得等于全下额');
  }
  assert.notEqual(
    raises[0]!.labelZh,
    allIns[0]!.labelZh,
    '两个动作的文案必须能区分',
  );
});

test('§DEDUP-3：短码全下**低于**最小加注 ⇒ 独立 ALL_IN 不得被误删', () => {
  const state = facingBigBlind(1.5); // 全下 1.5BB < 最小加注 2BB
  const preview = buildTablePreview(state);
  assert.equal(preview.allInToBB, 1.5, '前置条件：全下额 1.5BB');
  assert.equal(preview.minRaiseToBB, 2, '前置条件：最小加注 2BB ⇒ 全下够不上最小加注');

  const buttons = executable(state);
  const allIns = buttons.filter((b) => b.type === 'ALL_IN');
  assert.equal(allIns.length, 1, '短码全下是**唯一**能加注的路径，绝不能删掉');
  assert.equal(allIns[0]!.isAllIn, true);
  assert.equal(
    buttons.filter((b) => b.type === 'RAISE').length,
    0,
    '尺寸网格在这种情况下是空的，不应产生任何加注尺寸项',
  );
});

/* ============================================================
 * §DEDUP-4 / §DEDUP-5 —— BET 场景（对应覆盖）
 * ============================================================ */

test('§DEDUP-4：最小下注 == 全下 ⇒ 恰好 1 个全下入口，且由**尺寸项**承担', () => {
  const state = unopenedFlop(2, ['Ah', '7c', '2d']); // 翻牌时剩 2BB，全下 2BB？见下方断言
  const preview = buildTablePreview(state);
  const allIn = preview.allInToBB!;
  const minBet = preview.minBetBB!;
  assert.equal(allIn, minBet, '前置条件：本场景必须落在「最小下注 == 全下」上');

  const buttons = executable(state);
  const bets = buttons.filter((b) => b.type === 'BET');
  assert.equal(bets.length, 1, '应当恰好剩一个下注尺寸项');
  assert.equal(bets[0]!.isAllIn, true);
  assert.match(bets[0]!.labelZh, /全下/, `全下文案必须写明「全下」，实际「${bets[0]!.labelZh}」`);
  assert.equal(bets[0]!.amountChips, allInChips(state));
  assert.equal(
    buttons.filter((b) => b.type === 'ALL_IN').length,
    0,
    '不得再额外生成一个同金额的独立 ALL_IN',
  );
});

test('§DEDUP-5：深码下注 ⇒ 正常 BET 尺寸 + 独立 ALL_IN，尺寸项里不得再出现全下', () => {
  const state = unopenedFlop(100, ['Ah', '7c', '2d']);
  const preview = buildTablePreview(state);
  assert.ok(preview.allInToBB! > preview.minBetBB!, '前置条件：全下必须大于最小下注');

  const buttons = executable(state);
  const bets = buttons.filter((b) => b.type === 'BET');
  const allIns = buttons.filter((b) => b.type === 'ALL_IN');

  assert.equal(allIns.length, 1, '必须保留独立 ALL_IN');
  assert.ok(bets.length >= 1, '必须有正常的非全下下注尺寸');
  assert.equal(
    bets.some((b) => b.isAllIn),
    false,
    '既然独立 ALL_IN 已经承担全下，尺寸项里就不得再出现全下',
  );
  for (const b of bets) {
    assert.notEqual(b.amountChips, allInChips(state), '尺寸项金额不得等于全下额');
  }
});

/* ============================================================
 * §DEDUP-6 —— 跨场景不变量：全下入口恒为 1 个
 * ============================================================ */

test('§DEDUP-6：任何可下注/加注/跟注的状态下，「全下」入口恰好 1 个（不多也不少）', () => {
  const scenarios: { label: string; state: PokerTableState }[] = [
    ...([0.5, 1, 1.5, 2, 5, 100] as const).map((bb) => ({
      label: `RAISE · Hero ${bb}BB 面对大盲`,
      state: facingBigBlind(bb),
    })),
    ...([2, 3, 5, 20, 100] as const).map((bb) => ({
      label: `BET · Hero ${bb}BB 无人下注的翻牌`,
      state: unopenedFlop(bb, ['Ah', '7c', '2d']),
    })),
  ];

  for (const { label, state } of scenarios) {
    const buttons = executable(state);
    const flagged = buttons.filter((b) => b.isAllIn);
    assert.equal(
      flagged.length,
      1,
      `${label}：标成全下的可执行按钮必须恰好 1 个，实际 ${flagged.length} 个 —— ` +
        `${JSON.stringify(buttons.map((b) => b.labelZh))}`,
    );

    // 而且它必须是**可执行**的（EXPAND 已被过滤），并且金额等于全下额
    const only = flagged[0]!;
    assert.ok(
      only.type === 'ALL_IN' || only.amountChips === allInChips(state),
      `${label}：「${only.labelZh}」标了全下，金额就必须等于全下额`,
    );
  }
});
