/**
 * 牌桌页「一键加入玩家」—— 前端行为（真实执行 `table.js`）
 *
 * ## 这一组防的是什么
 *
 * 后端 `FILL_EMPTY_SEATS` 由 `test/fillEmptySeats.test.ts` 锁住；这里锁**前端**那一半 ——
 * 而前端恰是本项目出过两次事故的地方（Hero 改不了筹码、GTO 页有效筹码是死控件）：
 * **功能存在 ≠ 点得到**。
 *
 * | 断言 | 防的形态 |
 * |---|---|
 * | 按钮存在、可点、标签写出会加几人 | 「界面上没有入口」/「不知道这一下会加几个」 |
 * | 点一次**只发一个**请求就把空位加满 | 「按钮接了但发错操作」/「循环发 N 个请求」 |
 * | 没有空位 / 本手进行中 ⇒ 禁用 + 写明原因 | 「点了才被后端拒」 |
 * | 与「清空其他玩家」可组合 | 两键语义互相打架 |
 *
 * ⚠️ harness 的桩服务端默认**把桌子坐满**（既有用例都依赖这一点），
 * 因此这里用真实用户流程造出空位：**清空其他玩家 → 一键加入**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { createTableJsHarness, type StubNode, type TableJsHarness } from './helpers/tableJsHarness.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function deepText(node: StubNode): string {
  return [node.textContent, ...node.children.map(deepText)].filter((t) => t.length > 0).join(' ');
}

const FILL_BUTTON_ID = 'fillSeatsBtn';

function fillButton(harness: TableJsHarness): StubNode {
  return harness.node(FILL_BUTTON_ID);
}

function occupiedCount(harness: TableJsHarness): number {
  return harness.state().seats.filter((s) => s.playerId !== null).length;
}

function emptyCount(harness: TableJsHarness): number {
  return harness.state().seats.filter((s) => s.playerId === null).length;
}

/** 清空其他玩家（真实按钮），只留 Hero —— 这是**真实**制造空位的方式 */
async function clearVillains(harness: TableJsHarness): Promise<void> {
  const btn = harness.node('clearVillainsBtn');
  assert.ok(btn.onclick !== undefined, '「清空其他玩家」必须可点');
  btn.onclick!();
  await harness.settle();
}

/** 通过座位菜单加入一名玩家（真实按钮，不是直接发 op） */
function addOneViaSeatMenu(harness: TableJsHarness): void {
  const seatNode = harness.node('seats').children.find(
    (n) => deepText(n).includes('+ 加入玩家'),
  );
  assert.ok(seatNode !== undefined, '必须有一个空座位可点');
  seatNode!.onclick!();
  const modal = harness.node('modal');
  const join = modal.children
    .flatMap((row) => row.children)
    .find((n) => n.tagName === 'button' && deepText(n).trim() === '加入玩家');
  assert.ok(join !== undefined, '空座位菜单里必须有「加入玩家」');
  join!.onclick!();
}

/* ============================================================
 * 一、点得到、点一次就够
 * ============================================================ */

test('FILLUI-01：一键加入玩家必须一次把全部空位填满', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'BTN' });
  await h.settle();
  await clearVillains(h);

  assert.equal(occupiedCount(h), 1, '前置条件：只剩 Hero');
  assert.equal(emptyCount(h), 5, '前置条件：5 个空位');

  const btn = fillButton(h);
  assert.equal(btn.disabled, false, '有 5 个空位 ⇒ 必须可点');
  assert.ok(
    deepText(btn).includes('5'),
    `标签必须写出会加几个人（实际「${deepText(btn)}」）—— 不让使用者猜这一下会发生什么`,
  );
  assert.ok(btn.onclick !== undefined, '按钮必须绑定点击处理（否则就是死控件）');

  btn.onclick!();
  await h.settle();

  assert.equal(occupiedCount(h), 6, '点一次必须把 6 个座位全部坐满');
  assert.equal(emptyCount(h), 0, '不得还有空位');
});

test('FILLUI-02：点一次只发**一个**请求（不是循环发 5 个）', async () => {
  const h = await createTableJsHarness({ tableSize: 9, heroPosition: 'BTN' });
  await h.settle();
  await clearVillains(h);
  assert.equal(emptyCount(h), 8, '前置条件：9 人桌剩 8 个空位');

  const before = h.tableRequestCount();
  fillButton(h).onclick!();
  await h.settle();

  assert.equal(
    h.tableRequestCount() - before,
    1,
    '一键补齐必须是**一次**往返（发 8 个请求就不是「一键」了）',
  );
  assert.equal(occupiedCount(h), 9, '9 人桌点一次也必须满桌');
});

test('FILLUI-03：加满后按钮禁用并说明「已满」', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'BTN' });
  await h.settle();
  await clearVillains(h);
  fillButton(h).onclick!();
  await h.settle();

  const btn = fillButton(h);
  assert.equal(btn.disabled, true, '没有空位时按钮必须禁用');
  assert.match(String(btn.title ?? ''), /都已经有人|满/, `禁用原因必须可读（实际「${btn.title}」）`);
});

/* ============================================================
 * 二、门禁：本手进行中必须禁用 + 说明原因（且原因不能是「已满」）
 * ============================================================ */

test('FILLUI-04：本手进行中 ⇒ 禁用，且原因是「先结束本手」而不是「已满」', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'UTG' });
  await h.settle();
  await clearVillains(h);

  // 只留一名对手（本手拓扑要求 ≥2 名参与者），因此**仍然有空位**
  addOneViaSeatMenu(h);
  await h.settle();
  assert.equal(occupiedCount(h), 2, '前置条件：Hero + 1 名对手');
  assert.equal(emptyCount(h), 4, '前置条件：仍有 4 个空位');

  h.clickHeroCard('As');
  await h.settle();
  h.clickHeroCard('Kd');
  await h.settle();
  assert.equal(h.state().handActive, true, '前置条件：本手已经开始');

  const btn = fillButton(h);
  assert.equal(btn.disabled, true, '本手进行中 ⇒ 即使有空位也必须禁用');
  assert.match(
    String(btn.title ?? ''),
    /下一手|重置本手/,
    `禁用原因必须是「先结束本手」（实际「${btn.title}」）—— 有 4 个空位，不能说成「已满」`,
  );

  const occupiedBefore = occupiedCount(h);
  btn.onclick!();
  await h.settle();
  assert.equal(occupiedCount(h), occupiedBefore, '禁用的按钮不得改变牌桌');
});

/* ============================================================
 * 三、与其他功能共存
 * ============================================================ */

test('FILLUI-05：一键补齐后「清空其他玩家」仍然可用（两键可来回组合）', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'BTN' });
  await h.settle();
  await clearVillains(h);
  fillButton(h).onclick!();
  await h.settle();
  assert.equal(occupiedCount(h), 6);

  const clearBtn = h.node('clearVillainsBtn');
  assert.equal(clearBtn.disabled, false, '「清空其他玩家」必须仍可点');
  clearBtn.onclick!();
  await h.settle();
  assert.equal(occupiedCount(h), 1, '清空后必须只剩 Hero');
  assert.equal(fillButton(h).disabled, false, '清空后「一键加入玩家」必须重新可用');
  assert.ok(
    deepText(fillButton(h)).includes('5'),
    '重新可用后标签必须重新报出会加几个人',
  );
});

test('FILLUI-06：补齐后自动分析仍然工作（不会因为这一键把分析链路弄坏）', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'UTG' });
  await h.settle();
  await clearVillains(h);
  fillButton(h).onclick!();
  await h.settle();
  assert.equal(occupiedCount(h), 6, '前置条件：已满桌');

  const before = h.analyzeRequests().length;
  h.clickHeroCard('As');
  await h.settle();
  h.clickHeroCard('Kd');
  await h.settle();
  // 推进 debounce（自动分析排程在 fake timer 上，按 id 精确触发）
  for (const timer of [...h.timers.pending]) h.timers.fire(timer.id);
  await h.settle();

  assert.ok(
    h.analyzeRequests().length > before,
    '补齐之后仍然必须能按新状态自动分析（这一键不得把排程弄坏）',
  );
  const last = h.analyzeRequests()[h.analyzeRequests().length - 1]!;
  assert.equal(
    last.table.seats.filter((s) => s.playerId !== null).length,
    6,
    '最后一次分析请求里必须是**满桌**的新状态（不能拿着补齐前的旧状态去算）',
  );
});

/* ============================================================
 * 四、静态锁：旧结论必须作废
 * ============================================================ */

test('FILLUI-07：🔴 点「一键加入玩家」必须作废旧结论（静态锁）', () => {
  /*
   * 为什么这条用静态断言：
   * 「屏幕上那份建议是按 1 个对手算的，而牌桌上已经有 5 个对手」这种**界面在说谎**
   * 的形态，在 DOM 桩里很难稳定观察（自动分析会在 debounce 后覆盖结果区）。
   * 与 `clearVillainsBtn` 同源的处理是「先 `app.analysis = null` 再发操作」，
   * 这里直接锁住这个顺序。
   */
  const js = readFileSync(join(REPO_ROOT, 'src', 'app', 'web', 'table.js'), 'utf8');
  const handler = js.slice(js.indexOf("$('fillSeatsBtn').onclick"));
  const body = handler.slice(0, handler.indexOf('};') + 2);

  assert.match(body, /app\.analysis = null/, '必须先作废旧结论');
  assert.match(body, /FILL_EMPTY_SEATS/, '必须发送 FILL_EMPTY_SEATS（而不是自己循环发 ADD_PLAYER）');
  assert.ok(
    body.indexOf('app.analysis = null') < body.indexOf('sendOp('),
    '作废必须发生在发请求**之前**（否则旧结论会在往返期间继续显示）',
  );
});