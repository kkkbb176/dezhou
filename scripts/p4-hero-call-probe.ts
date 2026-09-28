/*
 * 最小探针：Hero 在 BTN 面对 100 筹码时 **为什么 CALL 被拒**？
 * 逐字打印 `applyTableOp` 返回的 issues，并对照 `deriveLegalActions`。
 */
import { applyTableOp } from '../src/app/table/tableOps.ts';
import { createTable } from '../src/app/table/tableState.ts';
import { deriveLegalActions } from '../src/app/manualInput/legalActions.ts';
import { actorOnTurn } from '../src/domain/poker/engine.ts';
import { engineViewOf } from '../src/app/table/tableOps.ts';
import type { PokerTableState, TableOp } from '../src/app/table/table.types.ts';

let state: PokerTableState = createTable({ tableSize: 6 });
const apply = (op: TableOp): PokerTableState => {
  const r = applyTableOp(state, op);
  if (!r.ok) {
    console.log(`❌ ${op.kind} 失败：`);
    for (const i of r.issues) console.log(`   - ${i.code}: ${i.message}`);
    throw new Error('stop');
  }
  state = r.state;
  return state;
};

apply({ kind: 'FILL_EMPTY_SEATS' });
apply({ kind: 'SET_HERO_CARD', card: 'As' });
apply({ kind: 'SET_HERO_CARD', card: 'Ks' });
console.log(`heroPosition=${state.heroPosition} heroPlayerId=${state.heroPlayerId}`);

const showTurn = (tag: string): void => {
  const v = engineViewOf(state);
  if (!v.ok) {
    console.log(`${tag} engineView 失败：${v.issues.map((i) => i.code).join(',')}`);
    return;
  }
  const id = actorOnTurn(v.engine);
  console.log(`${tag} 行动者=${id}`);
  if (id === null) return;
  const me = v.engine.players.find((p) => p.id === id)!;
  const legal = deriveLegalActions(v.engine, me);
  console.log(
    `   legal: canCheck=${legal.canCheck} callCost=${legal.callCost} ` +
      `minRaiseTo=${legal.minRaiseTo ?? '—'} maxRaiseTo=${legal.maxRaiseTo ?? '—'} ` +
      `allInAmount=${legal.allInAmount ?? '—'}`,
  );
};

showTurn('[初始]');
for (const pos of ['UTG', 'HJ', 'CO']) {
  const v = engineViewOf(state);
  const id = v.ok ? actorOnTurn(v.engine) : null;
  console.log(`\n→ 让 ${id} 弃牌`);
  apply({ kind: 'ACT', action: { type: 'FOLD' } });
  void pos;
  showTurn('[弃牌后]');
}

console.log('\n→ Hero CALL（应成功）');
const v0 = engineViewOf(state);
const id0 = v0.ok ? actorOnTurn(v0.engine) : null;
const me0 = v0.ok && id0 !== null ? v0.engine.players.find((p) => p.id === id0) : undefined;
const legal0 = v0.ok && me0 !== undefined ? deriveLegalActions(v0.engine, me0) : null;
console.log(`   行动者=${id0} legal.callCost=${legal0?.callCost} canCheck=${legal0?.canCheck}`);
const r = applyTableOp(state, { kind: 'ACT', action: { type: 'CALL' } });
console.log(`   applyTableOp(CALL).ok = ${r.ok}`);
if (!r.ok) for (const i of r.issues) console.log(`   - ${i.code}: ${i.message}`);
