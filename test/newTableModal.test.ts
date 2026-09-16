/**
 * 新建牌桌弹层 —— 桌型 / Hero 座位**必须真的能选**
 *
 * ## 这份测试防的是一个**真实发生过的用户缺陷**
 *
 * 使用者原话：**「新建牌桌无法选择，跟个空壳一样」**。
 *
 * 根因是 JS 闭包作用域：
 *
 * ```js
 * function openNewTableModal() {
 *   var chosenSize = app.state ? app.state.tableSize : 6;   // ← 局部变量
 *   ...
 *   b.onclick = function () {
 *     chosenSize = size.value;        // 改的是**这一次调用**的局部变量
 *     closeModal();
 *     openNewTableModal();            // ← 重进函数，下面那行又把它重置了
 *   };
 * ```
 *
 * 于是点「9 人桌」之后：`onclick` **确实跑了**，但它赋值给一个马上就被
 * 丢弃的局部变量 —— 弹层重绘后 `active` 仍是「6 人桌」，
 * 确认按钮仍是「建立 6 座桌，Hero 在 BTN」。**桌型根本选不动。**
 *
 * ## 这些断言是在真实浏览器里先看到、再回来固化的
 *
 * 单元测试的 DOM 桩**看不见**这个问题（桩里点击处理一样会跑，
 * 只是没人断言「点了之后状态变没变」）。所以本轮先写了一个诊断页，
 * 用 headless Chrome 真的点了一遍，确认现象与根因之后才改代码，
 * 然后把**同一个观察口径**固化成下面这些断言。
 *
 * ## 观察口径
 *
 * 只看**用户看得见的东西**：
 * - 弹层里哪个桌型 / 座位带 `active`
 * - 确认按钮的文案（它是 `chosenSize` / `chosenHero` 的直接投影）
 * - 建完之后顶栏的桌型与座位数
 *
 * 🚫 不读 `app` 内部字段、不重新实现选择模型。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTableJsHarness, type StubNode, type TableJsHarness } from './helpers/tableJsHarness.ts';

/* ============================================================
 * 观察工具
 * ============================================================ */

/**
 * 递归收集某个节点下的**全部按钮**。
 *
 * ⚠️ 桩的 `querySelectorAll` 永远返回空数组，也不能用 harness 的
 * `buttonByText` —— 它只找**直接子节点**，而弹层里的按钮都包在
 * `div.row` 里面。所以这里自己走一遍树。
 *
 * 真实浏览器里等价于 `modal.querySelectorAll('button')`。
 */
function allButtons(node: StubNode): StubNode[] {
  const out: StubNode[] = [];
  const walk = (n: StubNode): void => {
    if (n.tagName === 'button') out.push(n);
    for (const child of n.children) walk(child);
  };
  walk(node);
  return out;
}

/** 弹层里带 `active` 的按钮文案（= 当前选中的桌型 / 座位） */
function activeLabels(h: TableJsHarness): string[] {
  return allButtons(h.node('modal'))
    .filter((b) => b.className.includes('active'))
    .map((b) => b.textContent);
}

/** 弹层里确认按钮的文案 —— 它是 `chosenSize`/`chosenHero` 的直接投影 */
function confirmLabel(h: TableJsHarness): string {
  const found = allButtons(h.node('modal')).find((b) => b.textContent.startsWith('建立'));
  assert.ok(found !== undefined, '弹层里必须有「建立 …」确认按钮');
  return found.textContent;
}

function clickLabel(h: TableJsHarness, label: string): void {
  const found = allButtons(h.node('modal')).find((b) => b.textContent === label);
  assert.ok(found !== undefined, `弹层里找不到按钮「${label}」`);
  assert.equal(found!.disabled, false, `按钮「${label}」不得是禁用状态`);
  found!.onclick?.();
}

/** 打开「新建牌桌」弹层 */
async function openModal(h: TableJsHarness): Promise<void> {
  h.node('newTableBtn').onclick?.();
  await h.settle();
}

/* ============================================================
 * 一、桌型必须真的能选（本缺陷的正面回归）
 * ============================================================ */

test('NEWTABLE-01：点「9 人桌」之后，选中的必须真的是 9 人桌', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'BTN', tableSizes: [6, 9] });
  await h.settle();

  await openModal(h);
  // 初始：沿用当前牌桌（6 人桌 / BTN）
  assert.deepEqual(activeLabels(h), ['6 人桌', '庄家位']);
  assert.match(confirmLabel(h), /建立 6 座桌/);

  clickLabel(h, '9 人桌');
  await h.settle();

  /*
   * 🔴 这一条就是那个缺陷。修复前它会是 ['6 人桌','庄家位'] ——
   * 点击处理跑了，但结果被闭包重置丢了。
   */
  assert.deepEqual(
    activeLabels(h),
    ['9 人桌', '庄家位'],
    '点「9 人桌」之后弹层必须显示 9 人桌被选中（这正是「无法选择」的那个缺陷）',
  );
  assert.match(confirmLabel(h), /建立 9 座桌/, '确认按钮必须反映已选的桌型');
});

test('NEWTABLE-02：Hero 座位也必须真的能选', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'BTN', tableSizes: [6, 9] });
  await h.settle();
  await openModal(h);

  clickLabel(h, '枪口位');
  await h.settle();

  assert.deepEqual(activeLabels(h), ['6 人桌', '枪口位'], 'Hero 座位必须能选（与桌型同一类缺陷）');
  assert.match(confirmLabel(h), /Hero 在 UTG/);
});

test('NEWTABLE-03：连点两次也能累积（不是「只能记住最后一步」）', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'BTN', tableSizes: [6, 9] });
  await h.settle();
  await openModal(h);

  clickLabel(h, '9 人桌');
  await h.settle();
  clickLabel(h, '枪口+1位');
  await h.settle();
  clickLabel(h, '关煞位');
  await h.settle();

  assert.deepEqual(activeLabels(h), ['9 人桌', '关煞位']);
  assert.match(confirmLabel(h), /建立 9 座桌，Hero 在 CO/);
});

/* ============================================================
 * 二、换桌型时 Hero 座位必须**回落**（否则会发出非法请求）
 * ============================================================ */

test('NEWTABLE-04：UTG1 在 6 人桌上不存在，切回去必须回落到合法座位', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'BTN', tableSizes: [6, 9] });
  await h.settle();
  await openModal(h);

  // 6 人桌 → 9 人桌 → 选一个**只在 9 人桌上存在**的座位
  clickLabel(h, '9 人桌');
  await h.settle();
  clickLabel(h, '枪口+1位');
  await h.settle();
  assert.match(confirmLabel(h), /Hero 在 UTG1/);

  // 切回 6 人桌：UTG1 不存在，必须回落到 BTN
  clickLabel(h, '6 人桌');
  await h.settle();

  assert.match(
    confirmLabel(h),
    /建立 6 座桌，Hero 在 BTN/,
    '桌型换小之后，原来选的座位若不存在，必须回落到 BTN（而不是保留一个非法座位）',
  );
  const labels = allButtons(h.node('modal')).map((b) => b.textContent);
  assert.ok(!labels.includes('枪口+1位'), '6 人桌上不该出现 UTG1 这个座位按钮');
});

/* ============================================================
 * 三、确认之后必须真的建成那张桌子
 * ============================================================ */

test('NEWTABLE-05：选 9 人桌 + 确认 → 真的建成 9 人桌（不是只改了弹层文案）', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'BTN', tableSizes: [6, 9] });
  await h.settle();
  assert.equal(h.state().tableSize, 6);

  await openModal(h);
  clickLabel(h, '9 人桌');
  await h.settle();
  clickLabel(h, '枪口位');
  await h.settle();
  clickLabel(h, confirmLabel(h));
  await h.settle();

  // 服务端权威状态（不是界面文案）
  assert.equal(h.state().tableSize, 9, '确认之后服务端必须真的建成 9 人桌');
  assert.equal(h.state().heroPosition, 'UTG', 'Hero 座位也必须真的生效');
  // 座位也要真的渲染出 9 个
  assert.equal(h.node('seats').children.length, 9);
});

test('NEWTABLE-06：「取消」不建桌，但下次打开要回到当前牌桌（不留残留选择）', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'BTN', tableSizes: [6, 9] });
  await h.settle();
  const before = h.tableRequestCount();

  await openModal(h);
  clickLabel(h, '9 人桌');
  await h.settle();
  clickLabel(h, '取消');
  await h.settle();

  assert.equal(h.tableRequestCount(), before, '取消不得发出任何建桌请求');
  assert.equal(h.state().tableSize, 6, '取消之后当前牌桌不变');

  // 再打开一次：必须回到「当前牌桌」，不能还停在上次取消掉的 9 人桌
  await openModal(h);
  assert.deepEqual(
    activeLabels(h),
    ['6 人桌', '庄家位'],
    '取消之后重开弹层，应当以当前牌桌为初值 —— 上次被放弃的选择不得残留',
  );
});

test('NEWTABLE-07：建完之后再打开弹层，初值是**新**牌桌（不是旧的）', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'BTN', tableSizes: [6, 9] });
  await h.settle();

  await openModal(h);
  clickLabel(h, '9 人桌');
  await h.settle();
  clickLabel(h, '关煞位');
  await h.settle();
  clickLabel(h, confirmLabel(h));
  await h.settle();
  assert.equal(h.state().tableSize, 9);

  await openModal(h);
  assert.deepEqual(
    activeLabels(h),
    ['9 人桌', '关煞位'],
    '建完之后重开，初值应当是刚建好的那张桌子（说明 pendingNewTable 已被正确清空并重新取初值）',
  );
});

/* ============================================================
 * 四、反证：不能靠「一律拒绝」或「一律接受」通过
 * ============================================================ */

test('NEWTABLE-08：反证 —— 桌型选择必须**双向**可改，不是只能往大改', async () => {
  const h = await createTableJsHarness({ tableSize: 9, heroPosition: 'BTN', tableSizes: [6, 9] });
  await h.settle();
  assert.equal(h.state().tableSize, 9);

  await openModal(h);
  assert.deepEqual(activeLabels(h), ['9 人桌', '庄家位'], '初值应当是当前牌桌');

  clickLabel(h, '6 人桌');
  await h.settle();
  assert.deepEqual(activeLabels(h), ['6 人桌', '庄家位'], '必须能从 9 人桌改回 6 人桌');

  clickLabel(h, '9 人桌');
  await h.settle();
  assert.deepEqual(activeLabels(h), ['9 人桌', '庄家位'], '也必须能再改回 9 人桌');
});
