/**
 * REAL-HAND HOTFIX 001 —— **CALL / 全下跟注金额契约（G）永久回归**
 *
 * 对应报告 `reports/REAL_HAND_HOTFIX_001.md` 第 6 节 G 与第 10 节
 * 「CALL 金额契约未审计」（规范第 10–15 条）。
 *
 * ## 契约（本文件钉住的就是这四条）
 *
 * 1. **`CALL` 的金额 = 本次实际投入的筹码**，且必须被**夹到剩余筹码**：
 *    `callCost = min(currentBet − 已投入, remainingStack)`。
 *    传「本街总额」或「未夹的差额」都会被引擎以 `CALL_AMOUNT_ILLEGAL` 拒绝。
 * 2. **全下跟注（short all-in call）不是「少跟一点」**，而是把**全部筹码**
 *    押进去 —— 界面必须 `isAllIn: true` 且标签写明「全下」。
 * 3. **不得同时显示两个等价的按钮**：Hero 剩 0.5BB、需跟 1BB 时，
 *    修复前同时给出「跟注 0.5BB」与「全下（0.5BB）」，点下去是同一条动作。
 * 4. **不得把全下跟注当成加注**：跟不完整时没有加注权，界面上不得出现加注按钮。
 *
 * ## 现场意义
 *
 * 报告第 10 节记录：现场「只能点全下才走得下去」的感受，很可能就是这一组
 * 金额/按钮契约造成的，而不是分叉本身。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Position } from '../src/domain/types.ts';
import { createTable, seatOfPosition } from '../src/app/table/tableState.ts';
import { applyTableOp, engineViewOf } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import type {
  PokerTableState,
  TableActionButton,
  TableIssue,
  TableOpOutcome,
} from '../src/app/table/table.types.ts';

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

/**
 * 6 座桌，Hero 在 UTG，只有 Hero 的筹码被指定。
 *
 * Hero 在 UTG 翻牌前第一个行动，且**没有**投入盲注 ⇒
 * `rawNeed = currentBet − 0 = 1BB`，于是「筹码够不够完整跟注」只由 Hero 筹码决定。
 * 桌面：SB 0.5BB / BB 1BB。
 */
function heroStackState(heroStackBB: number): PokerTableState {
  let state = createTable({ tableSize: 6, heroPosition: Position.UTG, defaultStackBB: 100 });
  for (const p of RING_6) {
    if (p === Position.UTG) continue;
    state = must(state, { kind: 'ADD_PLAYER', seatId: seatOfPosition(state, p)!.seatId });
  }
  // ⚠️ 必须在**本手开始之前**设筹码（本手进行中会因筹码守恒被拒）
  state = must(state, {
    kind: 'SET_STACK',
    seatId: seatOfPosition(state, Position.UTG)!.seatId,
    stackBB: heroStackBB,
  });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'As' });
  state = must(state, { kind: 'SET_HERO_CARD', card: 'Kd' });
  return state;
}

/** 可执行按钮 = PRIMARY + SIZE（EXPAND 只是展开器，不是动作） */
function executableButtons(state: PokerTableState): readonly TableActionButton[] {
  return buildTablePreview(state).actionButtons.filter((b) => b.group !== 'EXPAND');
}

function applyButton(state: PokerTableState, b: TableActionButton): TableOpOutcome {
  return applyTableOp(state, {
    kind: 'ACT',
    action: {
      type: b.type,
      ...(b.amountChips !== undefined ? { amountChips: b.amountChips } : {}),
    },
  });
}

const HERO_UTG = Position.UTG;

function heroEngineState(state: PokerTableState) {
  const view = engineViewOf(state);
  assert.equal(view.ok, true, '必须能重放出引擎状态');
  if (!view.ok) throw new Error('unreachable');
  const hero = view.engine.players.find((p) => p.position === HERO_UTG)!;
  return { engine: view.engine, hero };
}

/* ============================================================
 * §G-1 —— 同一状态下，不得有两个按钮产生同一个结果
 * ============================================================ */

test('§G-1：任意筹码深度下，每一个可执行按钮都必须被接受；且**跟注按钮不得与任何其它按钮等价**', () => {
  // 0.5BB / 1BB / 1.5BB 覆盖「跟不完整」；2BB 起覆盖正常跟注 + 全下加注
  for (const stackBB of [0.5, 1, 1.5, 2, 5, 100]) {
    const state = heroStackState(stackBB);
    const buttons = executableButtons(state);
    assert.ok(buttons.length > 0, `${stackBB}BB：必须至少有一个可执行按钮`);

    const outcomes: { labelZh: string; type: string; committed: number }[] = [];
    for (const b of buttons) {
      const r = applyButton(state, b);
      assert.equal(
        r.ok,
        true,
        `${stackBB}BB：「${b.labelZh}」必须被后端接受 —— ` +
          (r.ok ? '' : r.issues.map((i) => i.message).join(' / ')),
      );
      if (!r.ok) continue;

      const after = engineViewOf(r.state);
      assert.equal(after.ok, true, `${stackBB}BB：「${b.labelZh}」之后必须能重放`);
      if (!after.ok) continue;
      const hero = after.engine.players.find((p) => p.position === HERO_UTG)!;
      outcomes.push({
        labelZh: b.labelZh,
        type: b.type,
        /*
         * 比较口径刻意用「Hero 在本街的**实际投入筹码**」，而不是状态指纹。
         *
         * 原因：「跟注全下」与「全下」在引擎里记录的动作类型不同
         * （`CALL` vs `ALL_IN`），所以两者的状态指纹**并不相同** ——
         * 用指纹判重会漏掉这一对。而使用者真正在意的是「点哪个按钮
         * 会让我投进多少钱」，那才是「等价按钮」的判据。
         */
        committed: hero.committedByStreet[after.engine.street],
      });
    }

    /*
     * G 的契约：**跟注按钮不得与任何其它按钮投进同样多的筹码**。
     *
     * 修复前 Hero 剩 0.5BB 时会同时给出「跟注 0.5BB」与「全下（0.5BB）」，
     * 两者都让 Hero 投入 50 —— 这正是规范第 10–15 条禁止的
     * 「同时显示无法完成的跟注」。
     *
     * ⚠️ 这里刻意**只**约束跟注相关的一对。BET / RAISE 的尺寸网格与
     * `ALL_IN` 在「全下恰好等于最小加注」时会重合（例如 2BB 时
     * 「加注到 2BB」本身已被标成 `isAllIn`），那是**另一族**问题，
     * 不在本轮 G（CALL 金额契约）范围内，另行报告。
     */
    for (const call of outcomes.filter((o) => o.type === 'CALL')) {
      for (const other of outcomes) {
        if (other === call) continue;
        assert.notEqual(
          call.committed,
          other.committed,
          `${stackBB}BB：「${call.labelZh}」与「${other.labelZh}」让 Hero 投入**同样多的筹码**` +
            `（${call.committed}）—— 全下跟注不得再摆一个等价按钮（规范第 10–15 条）`,
        );
      }
    }
  }
});

/* ============================================================
 * §G-2 —— 全下跟注必须如实标注，且只有一个入口
 * ============================================================ */

test('§G-2：Hero 剩 0.5BB 需跟 1BB ⇒ 只有一个「跟注全下」按钮，且 isAllIn 为 true', () => {
  const state = heroStackState(0.5);
  const preview = buildTablePreview(state);
  const buttons = executableButtons(state);

  const calls = buttons.filter((b) => b.type === 'CALL');
  assert.equal(calls.length, 1, '必须恰好有一个跟注按钮');
  const call = calls[0]!;
  assert.equal(call.isAllIn, true, '全下跟注必须标成 isAllIn（修复前是 false）');
  assert.match(call.labelZh, /全下/, `全下跟注的标签必须写明「全下」，实际「${call.labelZh}」（修复前是「跟注 0.5BB」）`);
  assert.equal(call.amountChips, 50, '跟注金额必须等于剩余筹码 50 筹码（0.5BB）');

  assert.equal(
    buttons.filter((b) => b.type === 'ALL_IN').length,
    0,
    '不得再同时给出一个语义完全相同的「全下」按钮（修复前会给出）',
  );

  // 反证：夹错金额（用未夹的差额 1BB = 100 筹码）必须被引擎拒绝
  const wrong = applyTableOp(state, { kind: 'ACT', action: { type: 'CALL', amountChips: 100 } });
  assert.equal(wrong.ok, false, '`CALL` 传「未夹的差额」必须被拒绝 —— 金额口径是本次投入且夹到剩余筹码');
});

test('§G-3：全下跟注必须真的把筹码清零并标记 allIn', () => {
  const state = heroStackState(0.5);
  const call = executableButtons(state).find((b) => b.type === 'CALL')!;

  const applied = applyButton(state, call);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;

  const { hero } = heroEngineState(applied.state);
  assert.equal(hero.remainingStack, 0, '全下跟注之后剩余筹码必须为 0');
  assert.equal(hero.allIn, true, '必须被标记为 allIn');
  assert.equal(hero.committedByStreet.PREFLOP, 50, '本街投入必须恰好是 0.5BB');
});

/* ============================================================
 * §G-4 —— 不变式：筹码充足时不得误标全下，且全下仍须作为独立动作存在
 * ============================================================ */

test('§G-4：筹码充足时 CALL 不得被标成全下；且全下入口恒为**恰好一个**', () => {
  for (const stackBB of [1.5, 2, 100]) {
    const state = heroStackState(stackBB);
    const buttons = executableButtons(state);
    const call = buttons.find((b) => b.type === 'CALL');
    assert.notEqual(call, undefined, `${stackBB}BB：应当有跟注按钮`);
    if (call === undefined) continue;

    assert.equal(call.isAllIn, false, `${stackBB}BB：能完整跟注时不得标成全下`);
    assert.doesNotMatch(call.labelZh, /全下/, `${stackBB}BB：能完整跟注时标签不得写「全下」`);
    assert.equal(call.amountChips, 100, `${stackBB}BB：只需投入 1BB（100 筹码）`);

    /*
     * ⚠️ 这里**不再**断言「必须有独立的 ALL_IN 按钮」。
     *
     * UI ACTION DEDUP 之后，当全下恰好等于最小加注时（例如 2BB 的
     * 「加注全下至 2BB」），全下由**尺寸项**承担，独立 `ALL_IN` 被有意去掉
     * —— 见 `test/hotfix001ActionDedup.test.ts` §DEDUP-1 / §DEDUP-6。
     * 本文件在这里只负责 CALL 的语义；「全下入口恰好一个」由 §DEDUP-6 钉住。
     */
    assert.equal(
      buttons.filter((b) => b.isAllIn).length,
      1,
      `${stackBB}BB：全下入口必须恰好一个（由尺寸项或独立 ALL_IN 承担）`,
    );
  }
});

/* ============================================================
 * §G-5 —— 全下跟注不得被当成加注
 * ============================================================ */

test('§G-5：跟不完整时没有加注权 —— 不得出现加注按钮', () => {
  for (const stackBB of [0.5, 1]) {
    const buttons = executableButtons(heroStackState(stackBB));
    assert.equal(
      buttons.some((b) => b.type === 'RAISE'),
      false,
      `${stackBB}BB：全下跟注不可能同时是一次合法加注，不得出现加注按钮`,
    );
    assert.equal(
      buttons.some((b) => b.type === 'BET'),
      false,
      `${stackBB}BB：面对下注时不得出现下注按钮`,
    );
  }
});
