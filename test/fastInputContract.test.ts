import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Position } from '../src/domain/types.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';
import { computePot, playerById } from '../src/domain/poker/gameState.ts';
import { buildSizeGrid, deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { createTable } from '../src/app/table/tableState.ts';
import { applyTableOp, engineViewOf } from '../src/app/table/tableOps.ts';
import { buildTablePreview } from '../src/app/table/tablePreview.ts';
import type { PokerTableState, TableActionRequest, TableOp } from '../src/app/table/table.types.ts';

function op(state: PokerTableState, operation: TableOp): PokerTableState {
  const result = applyTableOp(state, operation);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('Operation rejected');
  return result.state;
}

function fullTable(bigBlindBB = 100, btnStackBB = 100): PokerTableState {
  let state = createTable({ tableSize: 6, heroPosition: Position.BTN, bigBlindBB });
  state = op(state, { kind: 'FILL_EMPTY_SEATS' });
  state = op(state, { kind: 'SET_STACK', seatId: 'seat_BTN', stackBB: btnStackBB });
  state = op(state, { kind: 'SET_HERO_CARD', card: 'Qs' });
  return op(state, { kind: 'SET_HERO_CARD', card: 'Qh' });
}

function act(state: PokerTableState, type: TableActionRequest['type'], amountChips?: number): PokerTableState {
  return op(state, { kind: 'ACT', action: { type, amountChips } });
}

function reraiseFixture(btnStackBB = 100): PokerTableState {
  let state = fullTable(100, btnStackBB);
  state = act(state, 'FOLD'); // UTG
  state = act(state, 'FOLD'); // HJ
  state = act(state, 'RAISE', 250); // CO 2.5 BB
  state = act(state, 'RAISE', 1000); // BTN 10 BB
  state = act(state, 'FOLD'); // SB
  state = act(state, 'FOLD'); // BB
  return act(state, 'RAISE', 2200); // CO 22 BB; next full raise is 34 BB
}

function assertEngineContract(state: PokerTableState): void {
  const preview = buildTablePreview(state);
  const input = preview.amountInput;
  assert.ok(input);
  const view = engineViewOf(state);
  assert.ok(view.ok);
  const actorId = actorOnTurn(view.engine);
  assert.ok(actorId);
  const actor = playerById(view.engine, actorId);
  assert.ok(actor);
  const legal = deriveLegalActions(view.engine, actor);
  assert.equal(input.bigBlindChips, state.bigBlindBB);
  assert.equal(input.chipUnit, 1);
  assert.equal(input.potChips, computePot(view.engine));
  assert.equal(input.currentBetChips, view.engine.currentBet);
  assert.equal(input.committedChips, actor.committedByStreet[view.engine.street]);
  assert.equal(input.remainingChips, actor.remainingStack);
  assert.equal(input.callChips, legal.callCost);
  assert.equal(input.callIsAllIn, legal.callIsAllIn);
  assert.equal(input.minBetChips, legal.minBet);
  assert.equal(input.minRaiseToChips, legal.minRaiseToAmount);
  assert.equal(input.allInToChips, legal.allInToAmount);
  assert.equal(input.canBet, legal.canBet);
  assert.equal(input.canRaise, legal.canRaise);
  for (const value of Object.values(input)) {
    if (typeof value === 'number') assert.ok(Number.isSafeInteger(value));
  }
  const mode = legal.canBet ? 'BET' : legal.canRaise ? 'RAISE' : null;
  const grid = mode === null ? [] : buildSizeGrid(legal, computePot(view.engine), mode);
  assert.deepEqual(input.quickAmounts.map((q) => [q.toChips, q.labelZh, q.isAllIn]),
    grid.map((q) => [q.toAmount, q.labelZh, q.isAllIn]));
  for (const quick of input.quickAmounts) {
    assert.equal(quick.type, mode);
    assert.ok(quick.explanationZh.length > 0);
    assert.ok(Number.isSafeInteger(quick.toChips));
    // Every offered amount must be accepted by the unchanged server ACT path.
    assert.equal(applyTableOp(state, {
      kind: 'ACT', action: { type: quick.type, amountChips: quick.toChips },
    }).ok, true);
  }
}

test('FAST INPUT: CO 2.5 / BTN 10 / CO 22 exposes exact 34 BB minimum raise-to', () => {
  const state = reraiseFixture();
  assertEngineContract(state);
  const input = buildTablePreview(state).amountInput!;
  assert.equal(input.minRaiseToChips, 3400);
  assert.equal(input.committedChips, 1000);
  assert.equal(input.callChips, 1200);
  assert.equal(input.remainingChips, 9000);
  assert.equal(input.allInToChips, 10000);
  assert.ok(input.quickAmounts.some((q) => q.toChips === 3400));
  assert.equal(applyTableOp(state, { kind: 'ACT', action: { type: 'RAISE', amountChips: 3399 } }).ok, false);
});

test('FAST INPUT: exact chips survive a BB display rounded to two decimals', () => {
  const state = act(fullTable(200), 'RAISE', 501);
  assertEngineContract(state);
  const preview = buildTablePreview(state);
  assert.equal(preview.amountInput!.callChips, 501);
  assert.notEqual(preview.callAmountBB * 200, 501);
  assert.equal(act(state, 'CALL', 501).actionHistory.at(-1)!.amountBB, 2.505);
});

test('FAST INPUT: short raise all-in preserves the engine floor and separate ALL_IN action', () => {
  const state = reraiseFixture(30);
  assertEngineContract(state);
  const preview = buildTablePreview(state);
  assert.equal(preview.amountInput!.minRaiseToChips, 3400);
  assert.equal(preview.amountInput!.allInToChips, 3000);
  assert.equal(preview.amountInput!.canRaise, true);
  assert.deepEqual(preview.amountInput!.quickAmounts, []);
  assert.ok(preview.legalActionTypes.includes('ALL_IN'));
  const after = act(state, 'ALL_IN');
  assert.equal(buildTablePreview(after).amountInput!.canRaise, false,
    'short all-in must not reopen CO raise rights');
});

test('FAST INPUT: short all-in call exposes capped call chips and no raise choices', () => {
  const state = reraiseFixture(15);
  assertEngineContract(state);
  const input = buildTablePreview(state).amountInput!;
  assert.equal(input.callChips, 500);
  assert.equal(input.callIsAllIn, true);
  assert.equal(input.canRaise, false);
  assert.deepEqual(input.quickAmounts, []);
  act(state, 'CALL', input.callChips);
});

test('FAST INPUT: postflop bet grid uses current street commitment and the existing pot sizes', () => {
  let state = fullTable();
  for (let i = 0; i < 3; i++) state = act(state, 'FOLD');
  state = act(state, 'RAISE', 250);
  state = act(state, 'FOLD');
  state = act(state, 'CALL', 150);
  for (const [slot, card] of ['As', 'Kh', '2c'].entries()) {
    state = op(state, { kind: 'SET_BOARD_CARD', slot, card });
  }
  assertEngineContract(state);
  const input = buildTablePreview(state).amountInput!;
  assert.equal(input.canBet, true);
  assert.equal(input.committedChips, 0);
  assert.equal(input.minBetChips, 100);
  assert.ok(input.quickAmounts.some((q) => q.toChips === 100));
});

test('FAST INPUT: unavailable state or no actor exposes null amountInput', () => {
  assert.equal(buildTablePreview(createTable()).amountInput, null);
  let state = fullTable();
  for (let i = 0; i < 5; i++) state = act(state, 'FOLD');
  assert.equal(buildTablePreview(state).amountInput, null);
});
