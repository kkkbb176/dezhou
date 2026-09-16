/**
 * 座位菜单 · 筹码编辑（2026-09 修复）
 *
 * ## 这一组防的是什么
 *
 * 使用者反馈：「牌桌页的 Hero 还是无法修改筹码数量」。
 *
 * 根因在 `table.js` 的座位菜单里：Hero 那一支有一段提前 `return`
 *
 * ```js
 * if (seat.isHero) {
 *   modal.appendChild(el('div', 'note', 'Hero 的座位不能清空或更换玩家…'));
 *   return;                    // ← 本意只是隐藏「清空座位 / 更换玩家」
 * }
 * // ---- 筹码 ----              ← 筹码编辑写在 return **之后** ⇒ Hero 永远拿不到
 * ```
 *
 * 于是 Hero 的座位菜单里只有画像与动态观察，**没有筹码输入框、没有保存按钮**。
 *
 * ## 为什么必须用真实执行而不是静态 grep
 *
 * 这个 bug 的形态是「代码存在、但走不到」—— 静态检查会看到「编辑筹码」四个字
 * 确实在文件里。只有**真的点一下 Hero 的座位**、再看弹层里有什么，才能发现它。
 * `test/helpers/tableJsHarness.ts` 提供的就是这种真实执行（含 DOM 桩）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTableJsHarness, type StubNode, type TableJsHarness } from './helpers/tableJsHarness.ts';

/** 节点自身 + 全部后代的文本（真实 DOM `textContent` 语义） */
function deepText(node: StubNode): string {
  return [node.textContent, ...node.children.map(deepText)].filter((t) => t.length > 0).join(' ');
}

/** 在某个容器里按**可见文本**找按钮（真实 UI 只有文案可点） */
function buttonByDeepText(container: StubNode, text: string): StubNode | undefined {
  return allButtons(container).find((b) => deepText(b).trim() === text);
}

/** 容器内的全部按钮（**递归** —— `openModal` 把按钮放在 `div.row` 里） */
function allButtons(container: StubNode): StubNode[] {
  const out: StubNode[] = [];
  const walk = (n: StubNode, isRoot: boolean): void => {
    if (!isRoot && n.tagName === 'button') out.push(n);
    for (const child of n.children) walk(child, false);
  };
  walk(container, true);
  return out;
}

/** 容器内的全部输入框（同样是递归） */
function allInputs(container: StubNode): StubNode[] {
  const out: StubNode[] = [];
  const walk = (n: StubNode, isRoot: boolean): void => {
    if (!isRoot && n.tagName === 'input') out.push(n);
    for (const child of n.children) walk(child, false);
  };
  walk(container, true);
  return out;
}

function modalButtons(harness: TableJsHarness): StubNode[] {
  return allButtons(harness.node('modal'));
}

/** 点开某个座位的菜单（按座位节点的可见文本定位，与真人点牌桌一致） */
function openSeat(harness: TableJsHarness, matchText: string): void {
  const seat = harness
    .node('seats')
    .children.find((n) => deepText(n).includes(matchText));
  assert.ok(seat !== undefined, `牌桌上必须有一个包含「${matchText}」的座位`);
  assert.ok(seat!.onclick !== undefined, '座位节点必须绑定点击处理');
  seat!.onclick!();
}

function heroSeatId(harness: TableJsHarness): string {
  const state = harness.state();
  const hero = state.seats.find((s) => s.playerId === state.heroPlayerId);
  assert.ok(hero !== undefined, '必须能找到 Hero 的座位');
  return hero!.seatId;
}

function stackOf(harness: TableJsHarness, seatId: string): number {
  const seat = harness.state().seats.find((s) => s.seatId === seatId);
  assert.ok(seat !== undefined);
  return seat!.stackBB;
}

/* ============================================================
 * 一、Hero 也必须能改筹码（修复的核心）
 * ============================================================ */

test('STACK-01：🔴 Hero 的座位菜单必须有筹码编辑（修复前完全没有）', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'BTN' });
  await h.settle();

  const heroId = heroSeatId(h);
  openSeat(h, '我（Hero）');

  const texts = modalButtons(h).map((b) => deepText(b).trim());
  assert.ok(
    texts.includes('保存筹码'),
    `Hero 的座位菜单必须有「保存筹码」（实际按钮：${texts.join(' / ')}）`,
  );
  assert.ok(
    /编辑筹码/.test(h.visibleText('modal')),
    `Hero 的座位菜单必须有筹码编辑行（实际：${h.visibleText('modal')}）`,
  );
  // Hero 仍然不能清空 / 更换玩家（那条 return 的本意）
  assert.ok(!texts.includes('清空座位'), 'Hero 不得出现「清空座位」');
  assert.ok(!texts.includes('更换玩家'), 'Hero 不得出现「更换玩家」');

  // 且编辑的是 Hero 自己的座位
  assert.equal(stackOf(h, heroId), 100, '前置条件：Hero 默认 100BB');
});

test('STACK-02：预设 100 / 150 / 200BB 一键可用，且真的写进服务端状态', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'BTN' });
  await h.settle();
  const heroId = heroSeatId(h);
  openSeat(h, '我（Hero）');

  const modal = h.node('modal');
  for (const bb of [100, 150, 200]) {
    assert.ok(
      buttonByDeepText(modal, bb + 'BB') !== undefined,
      `必须有 ${bb}BB 预设按钮（实际：${modalButtons(h).map((b) => deepText(b).trim()).join(' / ')}）`,
    );
  }

  buttonByDeepText(modal, '150BB')!.onclick!();
  await h.settle();
  assert.equal(stackOf(h, heroId), 150, '点 150BB 后 Hero 的筹码必须变成 150');

  // 菜单会关闭；重开再点 200
  openSeat(h, '我（Hero）');
  buttonByDeepText(h.node('modal'), '200BB')!.onclick!();
  await h.settle();
  assert.equal(stackOf(h, heroId), 200, '点 200BB 后 Hero 的筹码必须变成 200');

  // 100BB 也要能回去（预设是等价的，不是单向的）
  openSeat(h, '我（Hero）');
  buttonByDeepText(h.node('modal'), '100BB')!.onclick!();
  await h.settle();
  assert.equal(stackOf(h, heroId), 100, '点 100BB 后必须回到 100');
});

test('STACK-03：手动输入任意筹码仍然可用', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'BTN' });
  await h.settle();
  const heroId = heroSeatId(h);
  openSeat(h, '我（Hero）');

  const modal = h.node('modal');
  const input = allInputs(modal)[0];
  assert.ok(input !== undefined, '必须有数字输入框');
  assert.equal(input!.disabled, false, '本手未开始 ⇒ 输入框必须可用');

  input!.value = '175';
  buttonByDeepText(modal, '保存筹码')!.onclick!();
  await h.settle();
  assert.equal(stackOf(h, heroId), 175, '手动输入 175 必须生效');
});

/* ============================================================
 * 二、其他座位同样有（不能靠「顺便」）
 * ============================================================ */

test('STACK-04：非 Hero 座位同样有筹码编辑与预设', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'BTN' });
  await h.settle();

  const state = h.state();
  const villain = state.seats.find((s) => s.playerId !== null && s.playerId !== state.heroPlayerId);
  assert.ok(villain !== undefined, '必须有对手座位');

  /*
   * ⚠️ 用**预览里的显示名**定位，而不是 `state.seats[].displayName` ——
   * 后者在原始状态里是 `undefined`（显示名是服务端渲染座位视图时补的，
   * 真人看到的就是那个名字：`玩家2`）。
   */
  const villainView = h.preview().seats.find((s) => s.seatId === villain!.seatId);
  assert.ok(villainView !== undefined, '预览里必须有该座位');
  const villainName = villainView!.displayName;
  assert.ok(
    typeof villainName === 'string' && villainName.length > 0,
    '座位必须有显示名（界面上就是靠它认出这是哪一位）',
  );
  openSeat(h, villainName);

  const texts = modalButtons(h).map((b) => deepText(b).trim());
  assert.ok(texts.includes('保存筹码'), `对手座位也必须有「保存筹码」（实际：${texts.join(' / ')}）`);
  assert.ok(texts.includes('150BB'), '对手座位也必须有预设按钮');

  buttonByDeepText(h.node('modal'), '150BB')!.onclick!();
  await h.settle();
  assert.equal(stackOf(h, villain!.seatId), 150, '对手座位的 150BB 预设必须生效');
});

/* ============================================================
 * 三、本手进行中必须**禁用**并说明原因（而不是点了才被拒）
 * ============================================================ */

test('STACK-05：本手进行中 → 筹码控件禁用且写明原因', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'UTG' });
  await h.settle();

  // 起手：给 Hero 两张牌 → 本手真正开始（handActive = true）
  h.clickHeroCard('As');
  await h.settle();
  h.clickHeroCard('Kd');
  await h.settle();
  assert.equal(h.state().handActive, true, '前置条件：本手必须已经开始');

  openSeat(h, '我（Hero）');
  const modal = h.node('modal');
  assert.ok(
    /本手进行中/.test(h.visibleText('modal')),
    `必须写明「本手进行中」的原因（实际：${h.visibleText('modal')}）`,
  );
  assert.equal(
    buttonByDeepText(modal, '保存筹码')!.disabled,
    true,
    '本手进行中 ⇒ 保存筹码必须禁用',
  );
  assert.equal(buttonByDeepText(modal, '150BB')!.disabled, true, '本手进行中 ⇒ 预设必须禁用');
  assert.equal(allInputs(modal)[0]!.disabled, true, '本手进行中 ⇒ 输入框必须禁用');
});
