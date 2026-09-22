/**
 * ============================================================================
 * LIVE UI V3 —— 布局与交互回归测试
 * ============================================================================
 *
 * ## 这个文件为什么必须存在
 *
 * V3 动的是**布局与视觉**，而原有测试测的是**行为**：
 * 「点加注会发出 ACT」这类断言在「按钮高 42px」被改成 12px 之后**依然通过**。
 * 也就是说：只靠原有测试，用户「按钮太小点不准」「页面要滚两屏」
 * 这类真实故障可以无声上线。
 *
 * 所以这里补三类断言：
 *
 * | 类型 | 手段 | 覆盖的失效 |
 * |---|---|---|
 * | **DOM 结构** | 假 DOM 上真实跑 `table.js` | 空座位文案退化、最近动作不渲染 |
 * | **样式契约** | 直接读 `live-ui.css` 文本 | 按钮被改小、毡面/渐变被加回来、出现纵向滚动 |
 * | **纪律** | 真实交互 + 读 `window.__dshTest` | 建议被当成 Hero 实际动作落库 |
 *
 * ## 为什么样式断言读 CSS 文本而不是量像素
 *
 * 假 DOM **不解析 CSS**，量不到像素。而浏览器验收（截图 + CDP）在本轮任务是
 * **交付物**、不是每次 `npm run verify` 都跑的东西。两者分工：
 *
 * - 本文件锁住「规则必须写出来且值在范围内」—— 快速、每次 CI 都跑；
 * - 浏览器验收锁住「渲染出来真的是这样」—— 见 `reports/LIVE_UI_V3_REPORT.md`。
 *
 * 只读 CSS 不量像素，比不测强得多：把 `height: 42px` 改成 `12px` 会被抓住。
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createTableJsHarness } from './helpers/tableJsHarness.ts';

const WEB_DIR = join(fileURLToPath(new URL('..', import.meta.url)), 'src', 'app', 'web');

const readWeb = (name: string): string => readFileSync(join(WEB_DIR, name), 'utf8');

const CSS = readWeb('live-ui.css');
const TABLE_CSS = readWeb('table.css');
const HTML = readWeb('index.html');

/**
 * 去掉 `/* … *\/` 注释 —— 否则 `indexOf('#topbar')` 会命中注释里的选择器名。
 *
 * ⚠️ **必须用「保留换行」的方式替换，不能直接删成空串。**
 *
 * 逐行解析器按 `\n` 切规则块。把注释删成 `''` 会把注释**前后的两行粘成一行**，
 * 于是 `#rail { min-width: 0; /* …多行注释… *\/ min-height: 0; }` 会被解析成
 * 「`min-height: 0;` 的值是注释里那句 `overflow: hidden;`」——
 * 断言随之给出**假失败**（我实测踩到：`#rail 必须可收缩` 报 `null !== '0'`）。
 *
 * 用「按行数补回 `\n`」的替换，规则块的行结构就与原文一致。
 */
const stripComments = (css: string): string =>
  css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));

const CSS_FLAT = stripComments(CSS);
const TABLE_CSS_FLAT = stripComments(TABLE_CSS);

type CssRule = { selectors: readonly string[]; body: string };

/**
 * 极简 CSS 规则解析（逐行）。
 *
 * ## 为什么不用正则跨块匹配
 *
 * 我先写了 `/(?:^|\})\s*([^{}]*?)\s*\{([^{}]*)\}/g`，它在**某些块上会静默跳过**：
 * `body { ... }` 之后紧跟 `#topbar { ... }`，由于规则之间没有 `}` 紧邻下一个
 * 选择器，正则的 `lastIndex` 会跨过整个 `#topbar` 块继续找 —— 于是
 * `#topbar` 的 `height: 44px` 明明在文件里，解析结果却是 `null`。
 * 我为此在 `probes/css-probe.ts` 里逐块打印下标才定位到。
 *
 * 逐行扫描没有这个问题，而且本仓库的 CSS 是展开写法（一条声明一行），
 * 不需要处理嵌套规则与多行声明。**这个解析器本身出错会让断言给出假绿灯**，
 * 所以它必须简单到可以一眼看懂。
 */
function parseRules(text: string): readonly CssRule[] {
  const rules: CssRule[] = [];
  let selectors: string[] | null = null;
  let body: string[] = [];
  for (const line of text.split('\n')) {
    if (selectors === null) {
      const open = line.indexOf('{');
      if (open < 0) continue;
      selectors = line
        .slice(0, open)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      body = [];
      continue;
    }
    const close = line.indexOf('}');
    if (close >= 0) {
      body.push(line.slice(0, close));
      rules.push({ selectors, body: body.join('\n') });
      selectors = null;
      body = [];
      continue;
    }
    body.push(line);
  }
  return rules;
}

const CSS_RULES = parseRules(CSS_FLAT);
const TABLE_CSS_RULES = parseRules(TABLE_CSS_FLAT);

/** 取某个选择器的规则体；`selectors` 是解析后的列表（逗号分隔会被拆开） */
function ruleBody(rules: readonly CssRule[], ...selector: readonly string[]): string | null {
  const hit = rules.find((r) => selector.some((s) => r.selectors.includes(s)));
  return hit === undefined ? null : hit.body;
}

/** 从一个规则体里取某个属性的值；找不到返回 null */
function cssProp(css: string, selector: string, prop: string): string | null {
  const rules = css === CSS_FLAT ? CSS_RULES : TABLE_CSS_RULES;
  /*
   * `html,\nbody { ... }` 这种**跨行选择器列表**会被逐行解析器拆成两个条目：
   * 第一个是 `html,`（尾部那个逗号还在），第二个是 `body`。
   * 所以查 `html` 要允许匹配 `html,`。
   */
  const matcher = (r: CssRule): boolean =>
    r.selectors.includes(selector) || r.selectors.includes(`${selector},`);
  const pattern = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+);`, 'm');
  /*
   * 🔴 **必须遍历所有命中的规则，返回第一个真正含有该属性的那条。**
   *
   * 为什么不能用 `find` 取第一条：同一个选择器会在**媒体查询里**再出现一次
   *（`@media (max-width: 1120px) { #rail { border-left: none } }`），
   * 而媒体查询的规则块先被解析到。用 `find` 会取到窄视口那份，
   * 于是 `#rail` 的 `min-height` 查到 `null` —— 断言给出**假失败**。
   * 这是工具的问题，不是 CSS 的问题；工具必须先做对。
   */
  for (const rule of rules) {
    if (!matcher(rule)) continue;
    const m = pattern.exec(rule.body);
    if (m !== null) return m[1]!.trim();
  }
  return null;
}

/** 取选择器块里的 height / min-height 里较小的那个（两者都必须达标） */
function minHeightOf(css: string, selector: string): number {
  const values: number[] = [];
  for (const prop of ['height', 'min-height']) {
    const raw = cssProp(css, selector, prop);
    if (raw === null) continue;
    const m = /^(\d+(?:\.\d+)?)px$/.exec(raw);
    if (m !== null) values.push(Number(m[1]));
  }
  assert.ok(values.length > 0, `${selector} 必须显式写出 height 或 min-height（px）`);
  return Math.min(...values);
}

/* ============================================================
 * 一、DOM 结构：空座位与最近动作
 * ============================================================ */

/**
 * 建一张**已经发好牌**的桌子。
 *
 * 🔴 两个顺序上的坑，我都在 `probes/actor-probe.ts` 里踩过：
 *
 * 1. 桩服务端建桌时**只填座位**，`handActive` 仍是 `false`，因此
 *    `preview.actionButtons` 是空的 —— 此时点任何动作都点不动。
 * 2. 本手是靠 **`SET_HERO_CARD`（选满两张手牌）** 开始的，**不是**「下一手」。
 *    在 `handActive === true` 时点「下一手」会让状态变成
 *    「`handActive=false` 但手牌还在」——`parseTableState` 直接判定
 *    「状态自相矛盾」并拒绝，于是 revision 卡住、界面永远没有行动者。
 *    也就是说：**先点「下一手」不是「多此一举」，而是把牌局弄坏了**。
 */
async function freshDealtHand(
  options: Parameters<typeof createTableJsHarness>[0] = {},
): Promise<Awaited<ReturnType<typeof createTableJsHarness>>> {
  const h = await createTableJsHarness(options);
  /*
   * ⚠️ 每选一张都要等一次 `settle()`：`clickHeroCard()` 是
   * 「点空位 → 再点牌面」两步，第一步会重新渲染手牌区。
   * 不 settle 的话第二张牌点到的是**已经不存在的旧节点**，
   * 表现为「手牌只选上 1 张」，而本手因此永远不开始。
   */
  h.clickHeroCard('As');
  await h.settle();
  h.clickHeroCard('Kd');
  await h.settle();
  assert.equal(
    h.preview().actionButtons.length > 0,
    true,
    '前提：选满 Hero 手牌之后本手才开始，此时当前行动者必须有合法动作',
  );
  return h;
}

/**
 * 一直点「过牌 / 跟注」直到**轮到 Hero**（或点不动为止）。
 *
 * 🔴 为什么需要它：桩服务端建的桌子是**满座**的，Hero 在 BTN 时
 * 前面还有 UTG / HJ / CO 三个人要行动。`clickCheckOrCall()` 点的是
 * **当前行动者**的合法动作，所以第一下点的是 UTG 的跟注，而不是 Hero 的。
 */
async function playUntilHero(h: Awaited<ReturnType<typeof createTableJsHarness>>): Promise<number> {
  let clicks = 0;
  for (let i = 0; i < 12; i += 1) {
    if (h.preview().isHeroTurn) break;
    if (!h.clickCheckOrCall()) break;
    clicks += 1;
    await h.settle();
  }
  return clicks;
}

/**
 * 建一张桌子，并**清空 Hero 以外的所有人**，制造真正的空座位。
 *
 * 🔴 为什么不能直接建桌就算：桩服务端建桌时会把**所有座位填满**
 *（`seatAll()`），因此「刚建好的桌子」上一个空座位都没有 ——
 * 想验证空座位的画法，必须先用真实按钮把人清掉。
 */
async function tableWithEmptySeats(
  options: Parameters<typeof createTableJsHarness>[0] = {},
): Promise<Awaited<ReturnType<typeof createTableJsHarness>>> {
  const h = await createTableJsHarness(options);
  const btn = h.node('clearVillainsBtn');
  assert.ok(btn.onclick !== undefined, '「清空其他玩家」必须可点');
  btn.onclick!();
  await h.settle();
  return h;
}

test('V3-UI-01：空座位只显示加号，不得再出现多行提示文字', async () => {
  const h = await tableWithEmptySeats({ tableSize: 6, heroPosition: 'BTN' });

  const empties = h.node('seats').children.filter((n) =>
    String(n.className).split(/\s+/).includes('empty'),
  );
  assert.ok(empties.length > 0, '清空其他玩家之后必须有空座位');

  for (const seat of empties) {
    const textOf = (n: { textContent: string; children: readonly unknown[] }): string =>
      [n.textContent, ...n.children.map((c) => textOf(c as never))].join('');
    const text = textOf(seat as never);
    assert.equal(text.trim(), '＋', `空座位只允许一个加号，实际：「${text.trim()}」`);
    assert.equal(seat.children.length, 1, '空座位只允许一个子节点（加号）');
    assert.ok(
      !text.includes('加入玩家'),
      '「加入玩家」是座位菜单里的动作，不得画在座位上（V2 要求座位只留加号）',
    );
  }
  assert.deepEqual(h.pageErrors, [], '渲染空座位不得产生页面错误');
});

test('V3-UI-02：空座位仍然可点，且点开的是真实的座位菜单', async () => {
  const h = await tableWithEmptySeats({ tableSize: 6, heroPosition: 'BTN' });
  const empty = h.node('seats').children.find((n) =>
    String(n.className).split(/\s+/).includes('empty'),
  );
  assert.ok(empty !== undefined, '必须有空座位');
  assert.ok(empty!.onclick !== undefined, '空座位必须可点（否则没法坐下一个人）');
  empty!.onclick!();

  const modalText = h.visibleText('modal');
  assert.ok(modalText.includes('加入玩家'), '空座位菜单必须提供「加入玩家」入口');
  assert.deepEqual(h.pageErrors, []);
});

test('V3-UI-03：最近动作区必须逐条渲染真实动作，且最多 3 条', async () => {
  const h = await freshDealtHand({ tableSize: 6, heroPosition: 'BTN' });

  /* 开局：没有动作 → 明确的空态，而不是一片空白 */
  assert.match(h.visibleText('recentActions'), /还没有行动记录/);

  /* 录一条真实动作（走真实点击路径：Hero 前面的三个人先跟注，再轮到 Hero） */
  const before = await playUntilHero(h);
  assert.ok(before >= 1, 'Hero 在 BTN，前面必须有人先行动（否则测试前提不成立）');
  assert.ok(h.preview().isHeroTurn, '把前面几位点完之后必须轮到 Hero');

  const acted = h.clickCheckOrCall();
  assert.ok(acted, '轮到 Hero 时应当可以 CHECK 或 CALL');
  await h.settle();

  const total = h.state().actionHistory.length;
  const expectRows = Math.min(3, total);
  const rows = h.node('recentActions').children.filter((n) =>
    String(n.className).split(/\s+/).includes('ra-row'),
  );
  assert.equal(rows.length, expectRows, `总动作 ${total} 条时应当渲染 ${expectRows} 行`);
  assert.ok(total >= 2, `这段操作至少应当录下 2 条动作，实际 ${total}`);

  const latest = rows[rows.length - 1]!;
  assert.equal(latest.children.length, 3, '每行必须是「位置 / 动作 / 金额」三格（网格固定）');
  assert.ok(String(latest.children[0]!.textContent).length > 0, '位置列不得为空');
  assert.ok(String(latest.children[1]!.textContent).length > 0, '动作列不得为空');
  assert.ok(
    String(latest.className).includes('ra-latest'),
    '最后一条必须带 `ra-latest`，界面靠它把「刚发生的」与历史区分开',
  );
  assert.deepEqual(h.pageErrors, []);
});

test('V3-UI-04：最近动作超过 3 条时必须截断，且条数说明写在「完整时间线」入口里', async () => {
  /*
   * ## 为什么条数说明不在列表里
   *
   * 「前面还有 N 条」原本画在最近行动列表**顶部**，占一整行（约 21px）。
   * 右栏总高度是硬约束，那 21px 直接是从「Hero 决策」那一段扣的 ——
   * 实测溢出时 `#result` 只剩 6px，建议文字与下面的按钮叠在一起。
   *
   * 挪进 `<summary>` 之后：不占列表高度，语义也更顺
   *（「完整时间线」本来就是「看更多」的入口）。**信息没有丢**。
   */
  const h = await freshDealtHand({ tableSize: 6, heroPosition: 'BTN' });

  for (let i = 0; i < 12; i += 1) {
    if (!h.clickCheckOrCall()) break;
    await h.settle();
  }

  const box = h.node('recentActions');
  const rows = box.children.filter((n) => String(n.className).split(/\s+/).includes('ra-row'));
  const total = h.state().actionHistory.length;

  assert.ok(total >= 6, `这段操作应当至少录下 6 个动作，实际 ${total}`);
  assert.equal(rows.length, 3, `最多渲染最近 3 行，实际 ${rows.length}`);
  /*
   * 条数说明必须在折叠入口的标题里，且**数字要对**。
   * `#timelineSummary` 是那个 `<summary>` 自己的 id ——
   * 这里刻意不靠 `tagName` 去找它：假 DOM 里 `<summary>` 的 `tagName` 是空的
   *（我踩过这个坑，测试报「完整时间线必须有 <summary>」而元素其实在）。
   */
  const summaryText = String(h.node('timelineSummary').textContent);
  assert.match(summaryText, new RegExp(`共 ${total} 条`), `标题必须如实写出总条数，实际「${summaryText}」`);
  assert.match(summaryText, /只显示最近 3 条/, `标题必须写明只显示了几条，实际「${summaryText}」`);
  assert.deepEqual(h.pageErrors, []);
});

/* ============================================================
 * 二、纪律：Hero 建议与实际录入动作必须分开
 * ============================================================ */

test('V3-UI-05：🔴 服务端的建议绝不能被当成 Hero 的实际动作写进牌局', async () => {
  const h = await freshDealtHand({ tableSize: 6, heroPosition: 'BTN' });
  const hook = h.exposedTest();
  assert.ok(hook !== null, 'table.js 必须挂出 window.__dshTest（验收钩子）');

  /* 先走到 Hero，再让服务端返回一条**明确的**建议：加注到 9BB */
  await playUntilHero(h);
  assert.ok(h.preview().isHeroTurn, '前提：必须轮到 Hero');
  h.setAnalyzePayload({
    ok: true,
    viewModel: {
      actionZh: '加注到 9BB',
      headlineZh: '测试建议',
      confidenceZh: '高',
    },
  });
  h.clickAnalyzeButton();
  await h.settle();

  const before = h.state().actionHistory.length;
  const suggested = String(
    (hook!.app['analysis'] as { viewModel?: { actionZh?: string } } | null)?.viewModel?.actionZh ??
      '',
  );
  assert.equal(suggested, '加注到 9BB', '前提：建议必须真的被界面应用了');
  assert.match(
    h.visibleText('result'),
    /加注到 9BB/,
    '前提：建议必须真的渲染在建议区里（否则这条测试没有鉴别力）',
  );

  /* 现在记录一个**与建议不同**的真实动作（跟注，而不是加注） */
  const acted = h.clickCheckOrCall();
  assert.ok(acted, '应当可以 CHECK / CALL');
  await h.settle();

  const history = h.state().actionHistory;
  assert.equal(history.length, before + 1, '只应新增**一**条动作');
  const last = history[history.length - 1]!;
  assert.notEqual(
    last.type,
    'RAISE',
    '🔴 建议写的是「加注到 9BB」，但用户点的是 CHECK/CALL —— ' +
      '牌局里绝不允许出现一条用户没点过的加注',
  );

  /*
   * 建议本身也必须**留在原地**（不是被清掉，也不是被改成实际动作）：
   * 用户要能对照「我本来该做什么」和「我实际做了什么」。
   */
  const after = String(
    (hook!.app['analysis'] as { viewModel?: { actionZh?: string } } | null)?.viewModel?.actionZh ??
      '',
  );
  assert.equal(after, '加注到 9BB', '录入动作不得改写建议区的内容');
  assert.deepEqual(h.pageErrors, []);
});

test('V3-UI-06：建议区必须与「录入历史」模式互斥（补录时不得留旧建议）', async () => {
  const h = await freshDealtHand({ tableSize: 6, heroPosition: 'BTN' });
  await playUntilHero(h);
  h.setAnalyzePayload({
    ok: true,
    viewModel: { actionZh: '跟注 1.5BB', headlineZh: '测试建议', confidenceZh: '中' },
  });
  h.clickAnalyzeButton();
  await h.settle();
  assert.match(
    h.visibleText('result'),
    /跟注 1\.5BB/,
    '建议区必须显示服务端给的建议动作',
  );

  /*
   * 切到「录入历史」：一条过期的建议留在屏幕上会被当成当前局面的建议 ——
   * 那比没有建议更危险。这条是 V1 就有的纪律，V2 重排了 DOM 之后必须仍然成立。
   */
  h.clickModeByLabel('录入历史');
  await h.settle();
  assert.match(
    h.visibleText('result'),
    /录入历史中/,
    '切到录入历史后建议区必须收起旧结论',
  );
  assert.ok(
    !h.visibleText('result').includes('跟注 1.5BB'),
    '🔴 录入历史模式下不得再显示上一条建议',
  );
  assert.deepEqual(h.pageErrors, []);
});

test('V3-UI-07：🔴 重叠请求结束后控件必须复原（静态锁死「禁用-还原」的可重入性）', async () => {
  /*
   * ## 这个缺陷的真实表现（浏览器验收抓出）
   *
   * 真实页面量到：`{"btnDisabled":true, "spyFired":false}` ——
   * 「设置」按钮看着正常，点下去**毫无反应**，而且再也不会恢复。
   *
   * ## 成因
   *
   * `setControlsDisabled` 原本是「记下原 disabled → 置 true → 按记录还原」。
   * 两个请求重叠时，第二次进入看到的已经是 `disabled = true`，
   * 于是把「原本可用」记成「原本不可用」，最后一个请求结束时把它**永久**禁用。
   * 触发条件很常见：`scheduleAutoAnalyze()` 的 debounce 到点发 `/api/analyze`，
   * 使用者同时按下动作按钮发 `/api/table`。
   *
   * ## 为什么这里只做静态锁
   *
   * 这条逻辑的实现依赖 `document.querySelectorAll('button, select, input')`，
   * 而假 DOM（`test/helpers/tableJsHarness.ts`）里 `querySelectorAll` **恒返回 `[]`** ——
   * 也就是说**行为层在假 DOM 上测不到它**。硬造一个假 DOM 实现只会测到假环境。
   *
   * 因此分工明确：
   *   - **本测试**把「必须可重入」这件事锁在源码上（哨兵值 + 只还原带哨兵的），
   *     任何人改回 `node.disabled ? '1' : '0'` 都会红；
   *   - **真实浏览器验收**（`verify-live-ui-v2.ts`）量最终的 `btnDisabled`，
   *     以真实重叠请求证明按钮真的恢复。
   */
  const js = readWeb('table.js');
  assert.ok(
    /DISABLED_BY_BUSY/.test(js),
    'setControlsDisabled 必须用哨兵区分「我禁用的」与「本来就禁用的」',
  );
  assert.ok(
    /marker === DISABLED_BY_BUSY/.test(js),
    '已经是我禁用的按钮不得再次覆盖最初的记录（幂等）',
  );
  assert.ok(
    !/node\.dataset\.prevDisabled = node\.disabled \? '1' : '0'/.test(js),
    '🔴 不得回到「无条件记录当前 disabled」的写法 —— 那会让重叠请求永久禁用按钮',
  );

  /*
   * 行为侧仍可验证一半：**退出路径不能把可用按钮留成禁用**。
   * 假 DOM 下 `querySelectorAll` 返回空数组，因此这里验证的是
   * 「调用不抛错」，真正的还原由浏览器验收负责。
   */
  const h = await freshDealtHand({ tableSize: 6, heroPosition: 'BTN' });
  const gate = h.deferNextAnalyze();
  h.clickAnalyzeButton();
  await h.settle();
  gate.release();
  await h.settle();
  await h.settle();
  assert.equal(h.node('nextHandBtn').disabled, false, '请求结束后「下一手」不得被留成禁用');
  assert.deepEqual(h.pageErrors, []);
});

/* ============================================================
 * 三、样式契约：尺寸下限、无拟物牌桌、视觉规范
 * ============================================================
 * 读 CSS 文本而不是量像素 —— 理由见文件头。
 * 这些断言的价值：把「按钮 ≥ 42px」「不许有渐变」「不许回到拟物椭圆牌桌」
 * 这类**一句话需求**变成每次 `npm run verify` 都会跑的红线。
 */

test('V3-CSS-01：主要动作按钮必须 ≥ 42px（不得为塞进一屏而缩小）', () => {
  const h = minHeightOf(CSS_FLAT, '#actionButtons button');
  assert.ok(h >= 42 && h <= 46, `主要动作按钮高度必须在 42–46px，实际 ${h}px`);
});

test('V3-CSS-02：座位 Pill 88–105 × 42–48，圆角 6–8（任务第四节的建议区间）', () => {
  const w = Number(/^(\d+(?:\.\d+)?)px$/.exec(cssProp(CSS_FLAT, '.seat', 'width') ?? '')?.[1]);
  assert.ok(w >= 88 && w <= 105, `座位宽度必须在 88–105px，实际 ${w}px`);
  const h = minHeightOf(CSS_FLAT, '.seat');
  assert.ok(h >= 42 && h <= 48, `座位高度必须在 42–48px，实际 ${h}px`);
  const r = Number(
    /^(\d+(?:\.\d+)?)px$/.exec(cssProp(CSS_FLAT, '.seat', 'border-radius') ?? '')?.[1],
  );
  assert.ok(r >= 6 && r <= 8, `座位圆角必须在 6–8px，实际 ${r}px`);
});

test('V3-CSS-03：顶栏 40–44px、右栏 360–380px（任务第四节的两个区间）', () => {
  const topH = Number(
    /^(\d+(?:\.\d+)?)px$/.exec(cssProp(CSS_FLAT, '#topbar', 'height') ?? '')?.[1],
  );
  assert.ok(topH >= 40 && topH <= 44, `顶栏高度必须在 40–44px，实际 ${topH}px`);
  const cols = cssProp(CSS_FLAT, '#main', 'grid-template-columns');
  const railW = Number(/(\d+)px/.exec(cols ?? '')?.[1]);
  assert.ok(railW >= 360 && railW <= 380, `右栏宽度必须在 360–380px，实际 ${String(cols)}`);
});

test('V3-CSS-04：🔴 正常录入不得出现纵向滚动（body 锁死 + 主区可收缩）', () => {
  const bodyOverflow = ((): string | null => {
    for (const rule of CSS_RULES) {
      if (!rule.selectors.includes('body')) continue;
      const m = /(?:^|[;{\s])overflow\s*:\s*([^;]+);/m.exec(rule.body);
      if (m !== null) return m[1]!.trim();
    }
    return null;
  })();
  assert.equal(bodyOverflow, 'hidden', 'body 必须锁住纵向滚动');
  assert.equal(
    cssProp(CSS_FLAT, '#main', 'min-height'),
    '0',
    '#main 必须允许收缩（否则会顶出滚动条）',
  );
  assert.equal(
    cssProp(CSS_FLAT, 'html', 'height'),
    '100%',
    'html 必须撑满视口，否则内部 flex 算不出可用高度',
  );
  /*
   * ⚠️ `overflow: hidden` 只能**兜底**，不能拿来裁掉真实内容（任务第十节
   * 「不得简单使用 overflow:hidden 把超出的内容裁掉」）。
   * 因此左区与右栏都必须是**可收缩**的 flex 容器，让内容自己适配。
   */
  assert.equal(cssProp(CSS_FLAT, '#left', 'min-height'), '0', '#left 必须可收缩');
  assert.equal(cssProp(CSS_FLAT, '#rail', 'min-height'), '0', '#rail 必须可收缩');
});

test('V3-CSS-05：🔴 没有拟物椭圆牌桌、没有毡面、没有渐变与发光', () => {
  /*
   * V3 的核心视觉决定：**不画牌桌**。
   * `#tableWrap` 从「拟物毡桌」变成「座位网格」，因此必须显式归零：
   * 背景、背景图、边线、圆角、阴影。
   * 只断言「渐变消失了」不够 —— 还得断言「那张桌子也没了」。
   */
  assert.equal(cssProp(CSS_FLAT, '#tableWrap', 'background-image'), 'none');
  assert.equal(cssProp(CSS_FLAT, '#tableWrap', 'border'), 'none');
  assert.equal(cssProp(CSS_FLAT, '#tableWrap', 'border-radius'), '0');
  assert.equal(cssProp(CSS_FLAT, '#tableWrap', 'box-shadow'), 'none');
  assert.equal(cssProp(CSS_FLAT, '#tableWrap', 'display'), 'grid', '主战况区必须是座位网格');
  /*
   * ⚠️ 上面那行已经查了 `#tableWrap` 的圆角是 `0`。
   * 这里再查一次「文件里有没有双轴圆角」——
   * 注意**不能**写成「文件里有没有 `border-radius: 50%`」：庄家标记是一个
   * 16px 的**圆形**徽章，`border-radius: 50%` 在那里是正当用法。
   * V2 椭圆牌桌的标志是 `50% / 46%` 这种**双轴**圆角。
   */
  assert.ok(
    !/border-radius:\s*50%\s*\/\s*\d+%/.test(CSS_FLAT),
    '🔴 不得出现椭圆（`50% / 46%` 这种双轴圆角是拟物牌桌的标志）',
  );
  assert.ok(
    !/linear-gradient|radial-gradient/.test(CSS_FLAT),
    'live-ui.css 里不得出现任何渐变',
  );
});

test('V3-CSS-06：色板收敛为 9 个语义令牌，且不得出现同义令牌', () => {
  for (const token of [
    '--bg',
    '--surface',
    '--surface-2',
    '--line',
    '--text',
    '--text-2',
    '--actor',
    '--hero',
    '--idle',
  ]) {
    assert.ok(new RegExp(`${token}:`).test(CSS), `必须定义设计令牌 ${token}`);
  }
  assert.equal(cssProp(CSS_FLAT, '.seat.actor', 'border-color'), 'var(--actor)');
  assert.equal(cssProp(CSS_FLAT, '.seat.hero', 'border-color'), 'var(--hero)');

  const root = CSS_RULES.find((r) => r.selectors.includes(':root'));
  assert.ok(root !== undefined, '必须定义 :root');
  const declared = [...root!.body.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!);
  assert.ok(
    declared.length <= 24,
    `设计令牌不得超过 24 个（含间距与牌面色），实际 ${declared.length} 个：${declared.join(', ')}`,
  );
  /*
   * 🔴 **不得出现值完全相同的两个颜色令牌**。
   * V2 有 `--v2-blue` 与 `--v2-act`（值完全相同，都是 `#3d86e0`）——
   * 那意味着改一处必漏另一处，而且改完看起来「没生效」。
   */
  const colorValues = [
    ...root!.body.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;/gm),
  ];
  const byValue = new Map<string, string[]>();
  for (const [, name, value] of colorValues) {
    const key = value!.toLowerCase();
    byValue.set(key, [...(byValue.get(key) ?? []), name!]);
  }
  const dupes = [...byValue.entries()].filter(([, names]) => names.length > 1);
  assert.deepEqual(
    dupes.map(([, names]) => names.join(' = ')),
    [],
    '不得出现值完全相同的两个颜色令牌（那会让「改一处」永远漏掉另一处）',
  );
});

test('V3-CSS-07：右侧操作台的顺序必须是 行动者 → 快速录入 → Hero 决策 → 最近行动', () => {
  const rail = /<div id="rail">([\s\S]*?)\n      <\/div>/.exec(HTML);
  assert.ok(rail !== null, 'index.html 必须有 #rail');
  const body = rail![1]!;
  const at = (needle: string): number => {
    const i = body.indexOf(needle);
    assert.ok(i >= 0, `#rail 里必须有 ${needle}`);
    return i;
  };
  const order = [
    at('id="actorLine"'),
    at('id="actionButtons"'),
    at('id="result"'),
    at('id="recentActions"'),
  ];
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    '🔴 建议必须在动作按钮**下面** —— 上下分区是「建议 ≠ 实际动作」的第一道防线',
  );
});

test('V3-CSS-08：table.css 里不得再有 LIVE UI V1 的追加覆盖块', () => {
  const flat = TABLE_CSS_FLAT;
  assert.ok(
    !/LIVE UI V1/.test(TABLE_CSS),
    'V1 的 11 段「LIVE UI V1 ①…⑪」覆盖块必须删除（否则同一个尺寸有两处定义）',
  );
  assert.ok(flat.length < 32_000, `table.css 应当只剩基础组件样式，实际 ${flat.length} 字符`);
  assert.ok(TABLE_CSS.includes('.seatTip'), 'table.css 必须保留 .seatTip 规则');
  assert.ok(/--felt:/.test(TABLE_CSS), 'table.css 必须保留 --felt 令牌');
});

test('V3-CSS-09：index.html 必须加载 live-ui.css，且在其后（覆盖顺序）', () => {
  const tableAt = HTML.indexOf('/table.css');
  const liveAt = HTML.indexOf('/live-ui.css');
  assert.ok(tableAt >= 0, 'index.html 必须引用 /table.css');
  assert.ok(liveAt >= 0, 'index.html 必须引用 /live-ui.css');
  assert.ok(tableAt < liveAt, 'live-ui.css 必须在 table.css **之后**加载，否则接管不了布局');
});

test('V3-CSS-10：牌面选择器必须是静态折叠结构，不得靠 JS 现场包裹 DOM', () => {
  /*
   * V1 用 `insertBefore` 在运行时把 `#cardPicker` 包进 `<details>`，
   * 结果在假 DOM（没有 insertBefore）里抛错，把整条 `boot()` 带崩 ——
   * 8 个 newTableModal 测试全红。V3 保持静态 HTML，这类事故在结构上不可能发生。
   */
  assert.ok(
    /<details[^>]*id="handPanel"/.test(HTML),
    '#handPanel 必须是 index.html 里静态的 <details>',
  );
  const js = readWeb('table.js');
  /*
   * 只在**代码**里找（先剥掉注释）：`insertBefore` 这个词在
   * 解释「为什么不能用它」的注释里必须能出现，否则下一个人会不知道原因。
   */
  const jsCode = js
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(
    !/insertBefore/.test(jsCode),
    'table.js 的**代码**里不得再使用 insertBefore 包裹 DOM（假 DOM 不支持，会中断 boot/render）',
  );
  assert.ok(
    !/setupCollapsiblePanels/.test(jsCode),
    'V1 的 setupCollapsiblePanels 必须删除（其职责已由静态 HTML 承担）',
  );
});

/* ============================================================
 * 四、V3 新增：座位网格与中心牌面
 * ============================================================ */

test('V3-GRID-01：九个座位必须落进网格的九个不同单元格，且 Hero 在正下方', async () => {
  /*
   * V3 用网格定位（`grid-column` / `grid-row`）替代 V2 的三角函数摆椭圆。
   *
   * 这条测试的价值：**错一个映射就会有两个座位叠在同一个格子里**。
   * 叠在一起在小截图里不一定看得出来 —— 它的真实表现是
   * 「点了 A 却打开了 B 的菜单」，而那属于「录错牌」级别的事故。
   */
  const h = await createTableJsHarness({ tableSize: 9, heroPosition: 'BTN' });
  const seats = h.node('seats').children;
  assert.equal(seats.length, 9, '9 人桌必须有 9 个座位节点');

  const cells = seats.map((s) => {
    const st = s.style as Record<string, string>;
    const col = st['gridColumn'];
    const row = st['gridRow'];
    assert.ok(col !== undefined && row !== undefined, '每个座位都必须有网格定位');
    assert.ok(/^[1-5]$/.test(col!), `列必须是 1–5，实际 ${String(col)}`);
    assert.ok(/^[1-3]$/.test(row!), `行必须是 1–3，实际 ${String(row)}`);
    return `${col}/${row}`;
  });
  assert.equal(
    new Set(cells).size,
    9,
    `九个座位必须落在九个不同单元格，实际：${cells.join(' ')}`,
  );

  /* Hero 恒在正下方（第 3 列、第 3 行）—— 与 V2 的椭圆约定一致 */
  const heroIndex = seats.findIndex((s) => String(s.className).includes('hero'));
  assert.ok(heroIndex >= 0, '必须有一个 Hero 座位');
  assert.equal(cells[heroIndex], '3/3', 'Hero 必须固定在正下方（3/3）');
  /* 中心牌面区占中间三列 × 中间行，因此**没有任何座位**能落进第 3 列第 2 行 */
  assert.ok(
    !cells.includes('3/2'),
    '中心牌面区（2/2–2/4）不许被座位占用，否则会互相遮挡',
  );
  assert.deepEqual(h.pageErrors, []);
});

test('V3-GRID-02：6 人桌只用六个格，且同样不与中心牌面区重叠', async () => {
  const h = await createTableJsHarness({ tableSize: 6, heroPosition: 'BTN' });
  const seats = h.node('seats').children;
  assert.equal(seats.length, 6, '6 人桌必须有 6 个座位节点');
  const cells = seats.map((s) => {
    const st = s.style as Record<string, string>;
    return `${st['gridColumn']}/${st['gridRow']}`;
  });
  assert.equal(new Set(cells).size, 6, `六个座位必须落在六个不同单元格：${cells.join(' ')}`);
  assert.ok(!cells.includes('3/2'), '不得占用中心牌面区');
  assert.deepEqual(h.pageErrors, []);
});

test('V3-GRID-03：座位必须显示「名字 / 位置 / 筹码」，且不得显示画像标签', async () => {
  const h = await createTableJsHarness({ tableSize: 9, heroPosition: 'BTN' });
  const seats = h.node('seats').children;
  const occupied = seats.filter((s) => String(s.className).split(/\s+/).includes('seat'));
  assert.ok(occupied.length > 0);

  for (const seat of occupied) {
    const parts = seat.children.filter((c) => !String(c.className).includes('dealer'));
    const kinds = parts.map((c) => String(c.className));
    assert.ok(kinds.includes('name'), '座位必须有名字');
    assert.ok(kinds.includes('pos'), '座位必须有位置');
    /*
     * 第三行是 `.foot`（筹码 + 当前动作）—— **两者必须在同一个 flex 行里**。
     *
     * 🔴 V3 第一版把状态做成 `position: absolute` 的角标，实测它与筹码
     * **直接叠在一起**（截图里「99BB 投1BB」和「Hero」糊成一团）。
     * 这条断言锁住「同一行、不重叠」这个结构，而不只是「有筹码」。
     */
    assert.ok(kinds.includes('foot'), '座位第三行必须是 .foot（筹码 + 当前动作同行）');
    const foot = parts.find((c) => String(c.className).includes('foot'))!;
    const footKids = foot.children.map((c) => String(c.className));
    assert.ok(footKids.includes('stack'), '座位必须显示筹码');
    assert.equal(
      cssProp(CSS_FLAT, '.seat .foot', 'display'),
      'flex',
      '🔴 .foot 必须是 flex 行：筹码与当前动作左右分布，不得用绝对定位叠在一起',
    );
    assert.equal(
      cssProp(CSS_FLAT, '.seat .foot .action', 'position'),
      null,
      '🔴 当前动作不得使用绝对定位（那会与筹码重叠）',
    );
    /*
     * 画像标签节点可以存在（DOM 契约），但**必须被 CSS 默认隐藏**。
     * 这条断言把「画像不默认展开」这件视觉纪律钉在样式表上。
     */
    assert.equal(
      cssProp(CSS_FLAT, '.seat .tags', 'display'),
      'none',
      '🔴 座位上的画像标签必须默认隐藏（画像走 hover 的 #seatTip）',
    );
  }
  assert.deepEqual(h.pageErrors, []);
});

test('V3-TIP-01：🔴 悬停画像必须真的定位，不得掉回文档流底部', async () => {
  /*
   * ## 这个缺陷从 V2 起就存在，V3 的九状态验收把它抓了出来
   *
   * `showSeatTip()` 原本写 `tip.className = 'show'` —— **整个换掉**类名。
   * 而 `position: fixed` 写在 `table.css` 的 `.seatTip` 规则里，于是
   * 元素类名变成 `show` 后那条规则不再匹配 ⇒ `computed position = static`
   * ⇒ `positionTip()` 设的 `left/top` **完全无效**
   * ⇒ 提示框掉回文档流末尾，铺成一条通栏文字条（实测宽 1366px、高 39px）。
   *
   * 真实用户看到的是页面最底部多出一条乱码般的文字。
   *
   * 假 DOM 不解析 CSS、也没有布局，因此这里只能做**静态锁**：
   * 断言类名保留 + 定位样式被内联设置。真实定位由浏览器验收负责
   * （`v3-08-seat-menu.png` 与 `v3-verify.json` 的 `tipBox`）。
   */
  const js = readWeb('table.js');
  const jsCode = js
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(
    !/tip\.className = 'show'/.test(jsCode),
    "🔴 不得再写 `tip.className = 'show'` —— 那会丢掉 `seatTip` 类，让 position:fixed 失效",
  );
  assert.ok(
    /tip\.className = 'seatTip show'/.test(jsCode),
    "类名必须写成 `seatTip show`（保留定位所依赖的类）",
  );
  assert.ok(
    /tip\.style\.position = 'fixed'/.test(jsCode),
    '🔴 定位必须内联设置，不能只依赖某个外部类名恰好匹配',
  );
  assert.ok(
    /tip\.style\.left/.test(jsCode) && /tip\.style\.top/.test(jsCode),
    '必须真的设置 left / top',
  );
});
